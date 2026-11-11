import { StudioSelections } from './selection.mjs';
import { studioSourceFingerprint } from './source-fingerprint.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson, computeContentHash, sha256 } from './document.mjs';
import { resolveDocumentScene, RENDERER_VERSION } from './scene-resolver.mjs';
import { StudioPersistence } from './persistence.mjs';
import {
  ensureManagedBrowserPage,
  waitForRenderedRevision,
  withCapture,
  capturePixelContrast,
  _capturePixelContrast,
  measureDesignMetrics,
  captureScreenshot,
  _captureScreenshot,
} from './server-capture.mjs';
import { StudioRuntimeSession } from './runtime.mjs';
import { exportStudioDocumentToRp } from './export-rp.mjs';
import { getComponentContracts } from './component-contracts.mjs';
import { getDesignContext } from './design-context.mjs';
import { queryAuthoringNodes } from './authoring-query.mjs';
import { prepareRp1Commands } from './rp1-authoring.mjs';
import { prepareMedia } from './media.mjs';
import { reviewDesign } from './design-review.mjs';
import { StudioVersions } from './versions.mjs';
import { StudioOperations } from './operations.mjs';
import {errorDiagnostic} from './diagnostics.mjs';
import {
  SCENARIO_TEMPLATES_12,
  DOMAIN_PRESETS,
  createDomainProjectDocument,
  selectAffectedScenarios,
  runAcceptanceScenarios,
  runFaultInjectionControl,
} from './scenarios.mjs';

const loadedSourceFingerprint = studioSourceFingerprint();

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, 'web');
const INSTANCE_REGISTRY_PATH = '/tmp/zee-rp-studio-instances.json';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        rejectBody(Object.assign(new Error(`Request JSON body exceeds ${maxBytes} bytes`), { code: 'E_PAYLOAD_TOO_LARGE' }));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(Object.assign(new Error(`Invalid JSON body: ${err.message}`), { code: 'E_INVALID_JSON' }));
      }
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    });
  });
}

function resolveSafeSubpath(rootDir, rawSubpath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawSubpath);
  } catch {
    throw Object.assign(new Error('非法编码路径'), { code: 'E_PATH_TRAVERSAL' });
  }
  if (!decoded || decoded.includes('\0')) {
    return { status: 'missing', fullPath: null };
  }
  const absRoot = resolve(rootDir);
  const candidate = resolve(absRoot, decoded.replace(/^[/\\]+/, ''));
  if (candidate === absRoot || !candidate.startsWith(absRoot + sep)) {
    throw Object.assign(new Error('禁止访问工程资源根目录之外的路径'), { code: 'E_PATH_TRAVERSAL' });
  }
  if (!existsSync(candidate)) {
    return { status: 'missing', fullPath: null };
  }
  const realRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;
  const realCandidate = realpathSync(candidate);
  if (realCandidate === realRoot || !realCandidate.startsWith(realRoot + sep)) {
    throw Object.assign(new Error('禁止通过符号链接越界读取文件'), { code: 'E_PATH_TRAVERSAL' });
  }
  if (!statSync(realCandidate).isFile()) {
    return { status: 'missing', fullPath: null };
  }
  return { status: 'ok', fullPath: realCandidate };
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function registerInstanceRecord(record) {
  let list = [];
  if (existsSync(INSTANCE_REGISTRY_PATH)) {
    try {
      list = JSON.parse(readFileSync(INSTANCE_REGISTRY_PATH, 'utf8'));
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
  }
  list = list.filter(item => item.instanceId !== record.instanceId && item.port !== record.port);
  list.push(record);
  writeFileSync(INSTANCE_REGISTRY_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function unregisterInstanceRecord(instanceId) {
  if (!existsSync(INSTANCE_REGISTRY_PATH)) return;
  try {
    const list = JSON.parse(readFileSync(INSTANCE_REGISTRY_PATH, 'utf8'));
    if (Array.isArray(list)) {
      writeFileSync(
        INSTANCE_REGISTRY_PATH,
        JSON.stringify(list.filter(i => i.instanceId !== instanceId), null, 2),
        'utf8'
      );
    }
  } catch {
    // Ignore
  }
}

// 精确路径 HTTP 路由表:method+path → StudioServer 方法名。
// 新增路由:实现为类方法并在此登记;前缀/正则路由(static、/assets、/fonts、/api/events、
// /api/design/reviews/<uuid>/image、/api/runtime/*)保留在 handleRequest 内联处理。
const ROUTE_HANDLERS = {
  'GET /api/context': 'routeGetContext',
  'POST /api/selection': 'routePostSelection',
  'POST /api/query': 'routePostQuery',
  'POST /api/commands': 'routePostCommands',
  'POST /api/undo': 'routePostHistory',
  'POST /api/redo': 'routePostHistory',
  'POST /api/render-confirm': 'routePostRenderConfirm',
  'POST /api/wait-render': 'routePostWaitRender',
  'POST /api/screenshot': 'routePostScreenshot',
  'POST /api/versions': 'routePostVersions',
  'POST /api/design/context': 'routePostDesignContext',
  'POST /api/media/prepare': 'routePostMediaPrepare',
  'POST /api/design/metrics': 'routePostDesignMetrics',
  'POST /api/design/anchors': 'routePostDesignAnchors',
  'POST /api/design/pixel-contrast': 'routePostPixelContrast',
  'POST /api/design/content-plan': 'routePostContentPlan',
  'POST /api/design/fix-plan': 'routePostFixPlan',
  'POST /api/design/explore': 'routePostDesignExplore',
  'GET /api/design/reviews': 'routeGetDesignReviews',
  'POST /api/design/review': 'routePostDesignReview',
  'POST /api/operations': 'routePostOperations',
  'POST /api/export-rp': 'routePostExportRp',
  'POST /api/export-code': 'routePostExportCode',
  'POST /api/sync-native': 'routePostSyncNative',
  'POST /api/project/bundle': 'routePostProjectBundle',
  'POST /api/project/merge': 'routePostProjectMerge',
  'POST /api/project/open': 'routePostProjectOpen',
  'GET /api/component-contracts': 'routeComponentContracts',
  'POST /api/component-contracts': 'routeComponentContracts',
  'GET /api/scenarios': 'routeGetScenarios',
  'POST /api/scenarios/run': 'routePostScenariosRun',
  'POST /api/scenarios/fault-injection': 'routePostFaultInjection',
};

export class StudioServer {
  constructor({
    projectDir,
    sourcePath = null,
    name = 'Studio Project',
    domain = 'mobile',
    host = '127.0.0.1',
    port = 4310,
    sharedChrome = null,
    sharedPage = null,
  } = {}) {
    this.host = host;
    this.requestedPort = port;
    this.port = port;
    this.instanceId = `inst_${process.pid}_${Date.now().toString(36)}`;
    this.sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.sseClients = new Set();
    this.renderWaiters = [];
    this.renderedRevision = 0;
    this.lastRenderConfirm = null;
    this.managedChrome = sharedChrome;
    this.managedPage = sharedPage;
    this.ownsManagedChrome = !sharedChrome && !sharedPage;
    this.server = null;

    this.openProject({ projectDir, sourcePath, name, domain });
  }

  openProject({ projectDir, sourcePath = null, name = 'Studio Project', domain = 'mobile' }) {
    const switchingProject = Boolean(this.store);
    if (switchingProject) {
      this.sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      for (const w of this.renderWaiters) {
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error('工程已切换，取消旧工程渲染等待'), { code: 'E_PROJECT_SWITCHED' }));
      }
      this.renderWaiters = [];
    }
    this.projectDir = resolve(projectDir);
    this.operations = new StudioOperations(this.projectDir);
    this.persistence = new StudioPersistence(this.projectDir);
    this.versions = new StudioVersions(this.persistence);
    const { store, recoveryReport } = this.persistence.initOrLoad({ sourcePath, name, domain });
    this.store = store;
    this.selections = new StudioSelections();
    this.recoveryReport = recoveryReport;
    this.scene = resolveDocumentScene(this.store.doc, { projectDir: this.projectDir });
    this.store.lastScene = this.scene;
    this.runtimeSession = null;
    this.renderedRevision = 0;
    this.lastRenderConfirm = null;
    this.broadcastSse({
      type: 'snapshot',
      forceSync: true,
      ...this.buildContextPayload(),
    });
    return this.buildContextPayload();
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  buildContextPayload() {
    return {
      ok: true,
      instanceId: this.instanceId,
      sessionId: this.sessionId,
      url: this.url,
      projectDir: this.projectDir,
      appliedRevision: this.store.appliedRevision,
      durableRevision: this.store.durableRevision,
      renderedRevision: this.renderedRevision,
      contentHash: this.store.doc.contentHash,
      rendererVersion: RENDERER_VERSION,
      sourceFingerprint: loadedSourceFingerprint,
      // T-J-2：recoveryReport.durableRevision 是恢复/启动时的持久化基线，不随编辑推进；
      // 未发生恢复时直接对齐顶层 durableRevision，避免被当成过期残留误读。
      recoveryReport: this.recoveryReport
        ? { ...this.recoveryReport, ...(this.recoveryReport.recovered ? {} : { durableRevision: this.store.durableRevision }), durableRevisionNote: this.recoveryReport.recovered ? '恢复完成时的持久化基线版本；当前持久化进度看顶层 durableRevision' : '未发生恢复，与顶层 durableRevision 一致' }
        : null,
      recentHistory: (this.store.history || []).slice(-10).reverse().map(tx => ({
        txId: tx.txId,
        revision: tx.revision,
        label: tx.label,
        timestamp: tx.timestamp,
        actor: tx.actor,
        affectedPageIds: tx.transitiveImpact?.affectedPageIds || [],
        affectedNodeCount: tx.affectedNodeIds?.length || 0,
        directTargetCount: tx.transitiveImpact?.directTargetNodeIds?.length || 0,
        ancestorCount: tx.transitiveImpact?.affectedAncestorIds?.length || 0,
        shiftedCount: tx.transitiveImpact?.shiftedSiblingAndDescendantIds?.length || 0,
        componentInstanceCount: tx.transitiveImpact?.affectedComponentInstanceIds?.length || 0,
        tokenConsumerCount: tx.transitiveImpact?.affectedTokenConsumerIds?.length || 0,
        humanReadableSummary: tx.humanReadableSummary || null,
      })),
      selections: this.selections.summary(this.store.doc),
      doc: this.store.doc,
      scene: this.scene,
    };
  }

  broadcastSse(eventObj) {
    if (this.sseClients.size === 0) return;
    const data = `data: ${JSON.stringify(eventObj)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(data);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  recordRenderConfirm({ renderedRevision, contentHash, clientId, sessionId, fontErrors = [] }) {
    if (sessionId && sessionId !== this.sessionId) {
      return;
    }
    const rev = Number(renderedRevision || 0);
    if (rev <= 0 || rev > this.store.appliedRevision) {
      return;
    }
    if (rev >= this.renderedRevision || rev === this.store.appliedRevision) {
      this.renderedRevision = rev;
      this.lastRenderConfirm = {
        renderedRevision: rev,
        contentHash,
        clientId: clientId || 'browser',
        fontErrors,
        confirmedAt: new Date().toISOString(),
      };
    }
    const remaining = [];
    for (const w of this.renderWaiters) {
      if (this.renderedRevision >= w.targetRevision) {
        clearTimeout(w.timer);
        w.resolve(this.lastRenderConfirm);
      } else {
        remaining.push(w);
      }
    }
    this.renderWaiters = remaining;
  }

  // CDP 截图与像素测量:实现整体在 ./server-capture.mjs,此处保持调用面不变。
  async ensureManagedBrowserPage() {
    return ensureManagedBrowserPage(this);
  }

  async waitForRenderedRevision(targetRevision = this.store.appliedRevision, options = {}) {
    return waitForRenderedRevision(this, targetRevision, options);
  }

  withCapture(action) {
    return withCapture(this, action);
  }

  capturePixelContrast(pageId, options = {}) {
    return capturePixelContrast(this, pageId, options);
  }

  _capturePixelContrast(pageId, options = {}) {
    return _capturePixelContrast(this, pageId, options);
  }

  async measureDesignMetrics(pageId, options = {}) {
    return measureDesignMetrics(this, pageId, options);
  }

  captureScreenshot(options = {}) {
    return captureScreenshot(this, options);
  }

  _captureScreenshot(options = {}) {
    return _captureScreenshot(this, options);
  }

  async handleRequest(req, res) {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${this.host}:${this.port}`);
      const pathname = parsedUrl.pathname;

      // Static Web UI files(/src/** 为画布前端拆分模块;经安全子路径解析防穿越与目录读取)
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/styles.css' || pathname === '/visual-style.mjs' || pathname === '/clipboard.mjs' || pathname === '/vector-paths.mjs' || pathname.startsWith('/src/'))) {
        let fullPath;
        if (pathname.startsWith('/src/')) {
          const resolved = resolveSafeSubpath(join(WEB_DIR, 'src'), pathname.slice('/src/'.length));
          if (resolved.status !== 'ok') {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          fullPath = resolved.fullPath;
        } else {
          const relFile = pathname === '/' ? 'index.html' : pathname.slice(1);
          fullPath = join(['/visual-style.mjs', '/clipboard.mjs', '/vector-paths.mjs'].includes(pathname) ? HERE : WEB_DIR, relFile);
        }
        const content = readFileSync(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(fullPath)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/assets/')) {
        const resolved = resolveSafeSubpath(join(this.projectDir, 'assets'), pathname.slice('/assets/'.length));
        if (resolved.status !== 'ok') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const assetPath = resolved.fullPath;
        const buf = readFileSync(assetPath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(assetPath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/fonts/')) {
        const resolved = resolveSafeSubpath(join(this.projectDir, 'fonts'), pathname.slice('/fonts/'.length));
        if (resolved.status !== 'ok') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const fontPath = resolved.fullPath;
        const buf = readFileSync(fontPath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(fontPath).toLowerCase()] || 'font/ttf',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.studioClientId=parsedUrl.searchParams.get('clientId');
        this.sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: 'snapshot', ...this.buildContextPayload() })}\n\n`);
        req.on('close', () => {
          this.sseClients.delete(res);
          if(res.studioClientId&&![...this.sseClients].some(client=>client.studioClientId===res.studioClientId))this.selections.clients.delete(res.studioClientId);
        });
        return;
      }

      // 精确路径路由表:method+path → 类方法(分支体见下方 route* 方法,原样迁移)。
      const routeHandler = ROUTE_HANDLERS[`${req.method} ${pathname}`];
      if (routeHandler) {
        await this[routeHandler](req, res, { parsedUrl, pathname });
        return;
      }

      const reviewImage = pathname.match(/^\/api\/design\/reviews\/([a-f0-9-]{36})\/image$/);
      if (req.method === 'GET' && reviewImage) {
        const path = join(this.projectDir, 'design-reviews', `${reviewImage[1]}.png`);
        if (!existsSync(path)) return sendJson(res, 404, { ok: false, code: 'E_REVIEW_NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(readFileSync(path)); return;
      }

      if (req.method === 'POST' && pathname.startsWith('/api/runtime/')) {
        await this.routePostRuntime(req, res, { parsedUrl, pathname });
        return;
      }

      sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `Unknown endpoint: ${pathname}` });
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      const code = err.code || 'E_INTERNAL_ERROR';
      const status = code === 'E_RENDER_TIMEOUT' ? 504
        : code === 'E_PAYLOAD_TOO_LARGE' ? 413
        : code === 'E_PATH_TRAVERSAL' ? 403
        : ['E_WAL_WRITE', 'E_WRITE_OUTCOME_UNKNOWN'].includes(code) ? 500 : 400;
      sendJson(res, status, {
        ok: false,
        code,
        message: err.message,
        diagnostic:this.store&&this.scene?errorDiagnostic(err,this):null,
        ...Object.fromEntries(['sourceSpan', 'line', 'column', 'snippet', 'nodeId', 'field', 'candidates', 'suggestion', 'currentRevision'].filter(key => err[key] !== undefined).map(key => [key, err[key]])),
        appliedRevision: this.store?.appliedRevision,
        durableRevision: this.store?.durableRevision,
        renderedRevision: this.renderedRevision,
      });
    }
  }

  async routeGetContext(req, res, { parsedUrl, pathname }) {
        sendJson(res, 200, this.buildContextPayload());
        return;
  }

  async routePostSelection(req, res, { parsedUrl, pathname }) {
        const body=await readJsonBody(req);const selection=this.selections.publish(this.store.doc,this.scene,body);return sendJson(res,200,{ok:true,selectionId:selection.selectionId});
  }

  async routePostQuery(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        if (body.view || body.cursor || body.role || body.within || body.fields || body.nodeIds || body.limit || body.offset !== undefined) {
          sendJson(res, 200, { ...queryAuthoringNodes({ doc: this.store.doc, scene: this.scene, args: body }),
            appliedRevision: this.store.appliedRevision, durableRevision: this.store.durableRevision, renderedRevision: this.renderedRevision });
          return;
        }
        const targetPageId = body.pageId || this.store.doc.pages[0]?.id;
        const pgScene = this.scene.pages.find(p => p.id === targetPageId) || this.scene.pages[0];
        let nodes = pgScene ? pgScene.nodes : [];
        if (body.nodeId) {
          const stripped = String(body.nodeId).split('/').pop();
          nodes = nodes.filter(n => n.id === stripped || n.scopedId === body.nodeId);
        }
        if (body.type) {
          nodes = nodes.filter(n => n.type === body.type);
        }
        if (body.textContains) {
          const q = String(body.textContains).toLowerCase();
          nodes = nodes.filter(n => String(n.text || '').toLowerCase().includes(q));
        }
        sendJson(res, 200, {
          ok: true,
          appliedRevision: this.store.appliedRevision,
          durableRevision: this.store.durableRevision,
          renderedRevision: this.renderedRevision,
          contentHash: this.store.doc.contentHash,
          pageId: pgScene?.id || null,
          nodes,
          components: this.store.doc.components,
          tokens: this.store.doc.tokens,
          fonts: this.store.doc.fonts,
          fontDiagnostics: this.scene.fontDiagnostics,
          assetDiagnostics: this.scene.assetDiagnostics,
        });
        return;
  }

  async routePostCommands(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        // 版本握手指令：没有 baseRevision 的写入是"盲写"，两个客户端并行时会静默互相覆盖。
        if (body.baseRevision === undefined || body.baseRevision === null) {
          return sendJson(res, 400, {
            ok: false,
            code: 'E_BASE_REVISION_REQUIRED',
            message: `写入必须携带 baseRevision（当前文档版本 ${this.store.appliedRevision}）。先读 /api/context 再提交，避免覆盖别人的修改。`,
            appliedRevision: this.store.appliedRevision,
            durableRevision: this.store.durableRevision,
          });
        }
        let sourcePreparation = null, sourceIdentity = null, replay = null;
        const rp1Payload = body.rp1 !== undefined
          ? body.rp1
          : (body.sourceMode && body.commands === undefined && typeof body.source === 'string' ? body.source : undefined);
        if (rp1Payload !== undefined) {
          if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string') throw Object.assign(new Error('RP/1 写入需要唯一 idempotencyKey'), { code: 'E_IDEMPOTENCY_REQUIRED' });
          if (body.documentId && body.documentId !== this.store.doc.documentId) throw Object.assign(new Error('documentId 与当前工程不匹配，未修改文档'), { code: 'E_DOCUMENT_ID_MISMATCH' });
          if (body.commands !== undefined) throw Object.assign(new Error('rp1 与 commands 必须二选一'), { code: 'E_RP1_INPUT' });
          sourceIdentity = { rp1: rp1Payload, mode: body.sourceMode, pageId: body.pageId, parentId: body.parentId || null, index: body.index ?? null };
          replay = this.store.getIdempotentResult({ idempotencyKey: body.idempotencyKey, sourceIdentity, selectionId:body.selectionId });
          if (!replay) {
            if (body.baseRevision !== this.store.appliedRevision) throw Object.assign(new Error(`文档已推进至 r${this.store.appliedRevision}，请刷新再提交片段`), { code: 'E_STALE_REVISION' });
            sourcePreparation = prepareRp1Commands({ doc: this.store.doc, source: rp1Payload, pageId: body.pageId,
              parentId: body.parentId, mode: body.sourceMode, index: body.index });
          }
        }
        const commands = sourcePreparation?.commands || body.commands || [];
        // Asset bytes are prepared outside the document transaction; reject a
        // stale or invented registration before changing nodes or history.
        if(!replay&&rp1Payload===undefined)replay=this.store.getIdempotentResult({idempotencyKey:body.idempotencyKey,commands,selectionId:body.selectionId});
        for (const command of replay?[]:commands) {
          if(command.type==='restoreDocument' && this.versions.read(command.versionId).sha256!==sha256(canonicalJson(command.document)))throw Object.assign(new Error('恢复源与命名版本不一致'),{code:'E_VERSION_CORRUPT'});
          if (command.type !== 'registerAsset') continue;
          const asset = command.asset;
          if (!/^assets\/[a-zA-Z0-9_.-]+$/.test(asset?.relativePath || '')
            || !existsSync(join(this.projectDir, asset.relativePath))
            || sha256(readFileSync(join(this.projectDir, asset.relativePath))) !== asset.sha256) {
            throw Object.assign(new Error('资源不存在或 SHA 已变化，请重新准备素材'), { code: 'E_ASSET_BYTES_MISMATCH' });
          }
        }
        if(!replay&&body.selectionId)replay=this.store.getIdempotentResult({idempotencyKey:body.idempotencyKey,commands,sourceIdentity,selectionId:body.selectionId});
        const selectionGuard=!replay&&body.selectionId?this.selections.guard(this.store.doc,this.scene,body.selectionId):null;
        const txResult = replay || this.persistence.commit(this.store, beforeCommit => this.store.applyTransaction({
          selectionId: body.selectionId || null, selectionGuard,
          baseRevision: body.baseRevision,
          idempotencyKey: body.idempotencyKey,
          source: body.source || 'client',
          clientId: body.clientId || 'anonymous',
          pageId: body.pageId || null,
          documentId: body.documentId || null,
          label: body.label || null,
          actor: body.actor || null,
          commands,
          sourceIdentity,
        }, { beforeCommit }), { simulateCrashStage: body.simulateCrashStage || null });

        if (!txResult.ok) {
          const status = txResult.code === 'E_STALE_REVISION' || txResult.code === 'E_IDEMPOTENCY_CONFLICT' ? 409 : 400;
          sendJson(res, status, {
            ...txResult,
            diagnostic:errorDiagnostic(txResult,this),
            appliedRevision: this.store.appliedRevision,
            durableRevision: this.store.durableRevision,
            renderedRevision: this.renderedRevision,
          });
          return;
        }

        let scenePatch = null;
        if (!txResult.idempotentReplay) {
          const previousScene = this.scene;
          this.scene = txResult.scene || resolveDocumentScene(this.store.doc, { projectDir: this.projectDir });
          this.store.lastScene = this.scene;
          this.runtimeSession = null;

          const source = txResult.sourceNodePatch;
          const totalSceneNodes = this.scene.pages.reduce((sum, page) => sum + page.nodes.length, 0);
          if (source && totalSceneNodes > 500 && previousScene.revision === txResult.baseRevision) {
            const page = this.scene.pages.find(candidate => candidate.id === source.pageId);
            const oldPage = previousScene.pages.find(candidate => candidate.id === source.pageId);
            const sameOtherPages = this.scene.pages.every((candidate, index) => candidate === page || candidate === previousScene.pages[index]);
            if (oldPage && sameOtherPages && page.nodes.length === oldPage.nodes.length && isDeepStrictEqual(page.board, oldPage.board)) {
              const changed = [];
              let sameOrder = true;
              for (let i = 0; i < page.nodes.length; i++) {
                const node = page.nodes[i], oldNode = oldPage.nodes[i];
                if (node.scopedId !== oldNode.scopedId) { sameOrder = false; break; }
                if (!isDeepStrictEqual(node, oldNode)) changed.push(node);
                if (changed.length > 120) break;
              }
              if (sameOrder && changed.length <= 120) {
                scenePatch = {
                  baseRevision: txResult.baseRevision,
                  appliedRevision: this.store.appliedRevision,
                  contentHash: this.store.doc.contentHash,
                  updatedAt: this.store.doc.updatedAt,
                  source,
                  patchedNodesByPage: { [page.id]: changed },
                  pageFontReport: page.fontReport,
                  fontDiagnostics: this.scene.fontDiagnostics,
                  clipDiagnostics: this.scene.clipDiagnostics,
                  assetDiagnostics: this.scene.assetDiagnostics,
                  typographyStats: this.scene.typographyStats,
                };
              }
            }
          }

          if (scenePatch) {
            this.broadcastSse({
              type: 'revision',
              instanceId: this.instanceId,
              sessionId: this.sessionId,
              appliedRevision: this.store.appliedRevision,
              durableRevision: this.store.durableRevision,
              renderedRevision: this.renderedRevision,
              contentHash: this.store.doc.contentHash,
              rendererVersion: RENDERER_VERSION,
              affectedNodeIds: txResult.affectedNodeIds || [],
              directAffectedNodeIds: txResult.directAffectedNodeIds || [],
              transitiveImpact: txResult.transitiveImpact || null,
              semanticDiff: txResult.semanticDiff || null,
              humanReadableSummary: txResult.humanReadableSummary || null,
              diagnostics: txResult.diagnostics || [],
              txId: txResult.txId,
              label: txResult.label,
              scenePatch,
            });
          } else {
            this.broadcastSse({
              type: 'revision',
              affectedNodeIds: txResult.affectedNodeIds || [],
              directAffectedNodeIds: txResult.directAffectedNodeIds || [],
              transitiveImpact: txResult.transitiveImpact || null,
              semanticDiff: txResult.semanticDiff || null,
              humanReadableSummary: txResult.humanReadableSummary || null,
              diagnostics: txResult.diagnostics || [],
              ...this.buildContextPayload(),
            });
          }
        }

        if (scenePatch && !body.includeDoc && !body.includeScene) {
          sendJson(res, 200, {
            ...txResult,
            sessionId: this.sessionId,
            durableRevision: this.store.durableRevision,
            renderedRevision: this.renderedRevision,
            scenePatch,
            scene: {
              ...this.scene,
              pages: this.scene.pages.map(pg => ({
                id: pg.id,
                name: pg.name,
                board: pg.board,
                nodeCount: pg.nodes.length,
                nodes: scenePatch.patchedNodesByPage[pg.id] || [],
              })),
            },
            ...(sourcePreparation ? { authoring: { format: sourcePreparation.format, ...sourcePreparation.summary, sourceSpans: sourcePreparation.sourceSpans } } : {}),
          });
          return;
        }

        sendJson(res, 200, {
          ...txResult,
          sessionId: this.sessionId,
          durableRevision: this.store.durableRevision,
          renderedRevision: this.renderedRevision,
          doc: this.store.doc,
          scene: this.scene,
          ...(sourcePreparation ? { authoring: { format: sourcePreparation.format, ...sourcePreparation.summary, sourceSpans: sourcePreparation.sourceSpans } } : {}),
        });
        return;
  }

  async routePostHistory(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        // 预览运行态存在即视为只读：撤销/重做会回滚设计文档，直接拒绝以守住隔离承诺（T-D-1）。
        // scenario 等设计态语义会话不带 preview 标记，不影响正常撤销。
        if (this.runtimeSession?.preview) {
          sendJson(res, 400, {
            ok: false,
            code: 'E_PREVIEW_MODE_UNDO',
            message: `预览运行态为只读，${pathname === '/api/undo' ? '撤销' : '重做'}被拒绝；请退出预览或重置会话后再试`,
            suggestion: '退出预览，或 POST /api/runtime/reset 重置运行态后重试',
          });
          return;
        }
        const operation = pathname === '/api/undo' ? 'undo' : 'redo';
        const opRes = this.persistence.commit(this.store, beforeCommit => this.store[operation](body, { beforeCommit }));
        if (!opRes.ok) {
          sendJson(res, 400, opRes);
          return;
        }
        this.scene = opRes.scene;
        this.runtimeSession = null;
        const payload = {
          ...opRes,
          sessionId: this.sessionId,
          durableRevision: this.store.durableRevision,
          renderedRevision: this.renderedRevision,
          doc: this.store.doc,
          scene: this.scene,
        };
        this.broadcastSse({ type: 'revision', ...payload });
        sendJson(res, 200, payload);
        return;
  }

  async routePostRenderConfirm(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        this.recordRenderConfirm(body);
        sendJson(res, 200, {
          ok: true,
          renderedRevision: this.renderedRevision,
          lastRenderConfirm: this.lastRenderConfirm,
        });
        return;
  }

  async routePostWaitRender(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const targetRev = body.revision ?? this.store.appliedRevision;
        const confirm = await this.waitForRenderedRevision(targetRev, {
          timeoutMs: body.timeoutMs ?? 4000,
          simulateHang: Boolean(body.simulateHang),
        });
        sendJson(res, 200, {
          ok: true,
          appliedRevision: this.store.appliedRevision,
          durableRevision: this.store.durableRevision,
          renderedRevision: this.renderedRevision,
          confirm,
        });
        return;
  }

  async routePostScreenshot(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const shot = await this.captureScreenshot({
          revision: body.revision ?? this.store.appliedRevision,
          pageId: body.pageId || null,
          nodeId: body.nodeId || null,
          outPath: body.outPath || null,
          timeoutMs: body.timeoutMs ?? 5000,
          simulateHang: Boolean(body.simulateHang),
          includeImage: Boolean(body.includeImage),
        });
        sendJson(res, 200, shot);
        return;
  }

  async routePostVersions(req, res, { parsedUrl, pathname }) {
        const body=await readJsonBody(req);
        const unknown=Object.keys(body).filter(key=>!['action','name','versionId','baseRevision','previewHash','idempotencyKey','projectDir','url','port','simulateCrashStage'].includes(key));
        if(unknown.length) throw Object.assign(new Error(`版本操作不接受字段 ${unknown.join(', ')}`),{code:'E_VERSION_INPUT'});
        if(body.action==='list' || body.action===undefined)return sendJson(res,200,{ok:true,versions:this.versions.list(),revision:this.store.appliedRevision});
        if(body.action==='create')return sendJson(res,200,this.versions.create(this.store,body));
        if(body.action==='preview')return sendJson(res,200,this.versions.preview(this.store,body));
        if(body.action==='restore') {
          const result=this.persistence.commit(
            this.store,
            beforeCommit => this.versions.restore(this.store, body, { beforeCommit }),
            { simulateCrashStage: body.simulateCrashStage || null }
          );
          if(result.ok&&!result.idempotentReplay){this.scene=result.scene;this.runtimeSession=null;this.broadcastSse({type:'revision',...this.buildContextPayload()});}
          const status = result.ok ? 200 : (['E_STALE_REVISION','E_IDEMPOTENCY_CONFLICT','E_VERSION_PREVIEW_STALE'].includes(result.code) ? 409 : 400);
          return sendJson(res,status,{...result,durableRevision:this.store.durableRevision,doc:this.store.doc,scene:this.scene});
        }
        throw Object.assign(new Error('action应为list/create/preview/restore'),{code:'E_VERSION_INPUT'});
  }

  async routePostDesignContext(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const context = getDesignContext(body, { doc: this.store.doc, scene: this.scene, selections: this.selections });
        // Stage responses already contain a bounded, version-bound project selection.
        if (context.binding) return sendJson(res, 200, context);
        sendJson(res, 200, { ...context, project: { revision: this.store.appliedRevision,
          contentHash: this.store.doc.contentHash, tokens: this.store.doc.tokens,
          pages: this.scene.pages.map(p => ({ id: p.id, name: p.name, board: p.board })) } });
        return;
  }

  async routePostMediaPrepare(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        if(body.async===true)return sendJson(res,200,await this.operations.start('media',body,this.store.doc));
        sendJson(res, 200, await prepareMedia({ ...body, projectDir: this.projectDir, tokens: this.store.doc.tokens }));
        return;
  }

  async routePostDesignMetrics(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.scene.pages[0]?.id;
        const page = this.scene.pages.find(p => p.id === pageId);
        if (!page) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { summarizeMetrics } = await import('./design-metrics.mjs');
        const result = await this.measureDesignMetrics(pageId, { thresholds: body.thresholds || undefined, pixelTruth: body.pixelTruth !== false });
        return sendJson(res, 200, { ok: true, ...result, summary: summarizeMetrics(result) });
  }

  async routePostDesignAnchors(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const { extractAnchors, summarizeAnchors, compareToAnchors, mergeAnchorSets, ANCHOR_FILE } = await import('./anchors.mjs');
        const anchorPath = join(this.projectDir, ANCHOR_FILE);
        const readSet = () => {
          try { return JSON.parse(readFileSync(anchorPath, 'utf8')); } catch { return null; }
        };
        try {
          if (body.action === 'extract' || body.action === 'approve') {
            const manual = body.action === 'approve';
            // 显式 pageId/pages 只处理点名的那几页；省略才做全量扫描（T-E-5）。
            const pages = body.pages || (body.pageId ? [body.pageId] : null);
            if (manual && (!pages || !pages.length)) {
              return sendJson(res, 400, { ok: false, code: 'E_APPROVE_TARGET', message: 'approve 需要 pageId 或 pages' });
            }
            // 门槛统一（T-E-5）：显式点名是调用方的明确选择，extract 与 approve 同口径放行；
            // 只有全量扫描才按 L1 达标线过滤，避免"度量自己判不合格的页面"批量混进锚点语料。
            // approvedBy 如实记录调用方（T-E-6）：不再硬编码 "human"，MCP 调用默认记 mcp-ai。
            const incoming = extractAnchors(this.store.doc, {
              pages,
              includeBelowBar: manual || Boolean(pages) || Boolean(body.includeBelowBar),
            });
            const approvedBy = body.approvedBy || 'mcp-ai';
            if (manual) for (const anchor of incoming.anchors) anchor.approvedBy = approvedBy;
            const mode = body.mode === 'replace' ? 'replace' : 'append';
            const merged = mergeAnchorSets(readSet(), incoming, { mode });
            writeFileSync(anchorPath, JSON.stringify({ ...merged, summary: summarizeAnchors(merged) }, null, 2), 'utf8');
            return sendJson(res, 200, {
              ok: true,
              path: anchorPath,
              mode,
              ...merged,
              summary: summarizeAnchors(merged),
              note: mode === 'replace'
                ? '已按 mode:"replace" 整份替换锚点语料'
                : '已合并：同页覆盖，其余保留',
            });
          }
          if (body.action === 'list') {
            const set = readSet();
            if (!set) return sendJson(res, 404, { ok: false, code: 'E_NO_ANCHORS', message: '还没有锚点：先执行 action:"extract"' });
            return sendJson(res, 200, { ok: true, path: anchorPath, ...set, summary: summarizeAnchors(set) });
          }
          if (body.action === 'compare') {
            const set = readSet();
            if (!set) return sendJson(res, 404, { ok: false, code: 'E_NO_ANCHORS', message: '还没有锚点：先执行 action:"extract"' });
            const pageId = body.pageId || this.scene.pages[0]?.id;
            const result = compareToAnchors(this.store.doc, pageId, set);
            return sendJson(res, 200, { ok: true, path: anchorPath, ...result });
          }
          return sendJson(res, 400, { ok: false, code: 'E_ANCHOR_ACTION', message: 'action 必须是 extract / approve / list / compare' });
        } catch (err) {
          return sendJson(res, 400, { ok: false, code: err.code || 'E_ANCHORS', message: err.message });
        }
  }

  async routePostPixelContrast(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.store.doc.pages[0]?.id || 'home';
        const target = this.scene.pages.find(p => p.id === pageId);
        if (!target) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const shot = await this.capturePixelContrast(pageId, { dpr: body.dpr ?? 2 });
        return sendJson(res, 200, {
          ok: true, ...shot, measured: shot.results.filter(r => r.status === 'measured').length,
          unknown: shot.results.filter(r => r.status === 'unknown').length,
          failing: shot.results.filter(r => r.status === 'measured' && !r.passes).length,
          worst: shot.results.filter(r => !r.passes).slice(0, 5), baseRevision: shot.revision,
        });
  }

  async routePostContentPlan(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.scene.pages[0]?.id;
        const page = this.scene.pages.find(p => p.id === pageId);
        if (!page) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { buildContentPlan } = await import('./content-plan.mjs');
        return sendJson(res, 200, { ...buildContentPlan(page), baseRevision: this.store.appliedRevision });
  }

  async routePostFixPlan(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.scene.pages[0]?.id;
        const page = this.scene.pages.find(p => p.id === pageId);
        if (!page) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { computeDesignMetrics } = await import('./design-metrics.mjs');
        const { buildFixPlan } = await import('./fix-plan.mjs');
        const { resolveDocumentScene } = await import('./scene-resolver.mjs');
        const { applySingleCommand } = await import('./commands.mjs');
        const metrics = computeDesignMetrics(page, { doc: this.store.doc });
        const plan = buildFixPlan(page, metrics, this.store.doc);

        // 自证：在文档副本上真跑一遍自己的命令，逐条判断"是否真的让某个检查转正"。
        // 不做这一步，计划就可能用元数据刷绿（坐标漂移、幽灵字段、空盒子）。
        const baselineBlocking = new Set(metrics.l1.blocking.map(b => b.check));
        const simulate = commands => {
          const doc = structuredClone(this.store.doc);
          commands.forEach((command, index) => applySingleCommand(doc, structuredClone(command), index, pageId));
          const scene = resolveDocumentScene(doc, { projectDir: this.projectDir });
          const target = scene.pages.find(p => p.id === pageId);
          if (!target) return null;
          return computeDesignMetrics(target, { doc });
        };

        const kept = [];
        const rejected = [];
        let simulated = metrics;
        for (const command of plan.commands) {
          const trial = simulate([...kept, command]);
          if (!trial) { rejected.push({ command, reason: '模拟失败' }); continue; }
          const trialBlocking = new Set(trial.l1.blocking.map(b => b.check));
          // 严格标准：整页阻塞项必须减少。只让某一项转正、却新增另一项红的命令一律拒绝
          // （试用者实测过：补空态的命令顺手把字号问题带了出来）。
          const fixedSomething = [...baselineBlocking].some(check => !trialBlocking.has(check));
          const worse = trial.l1.blocking.length >= simulated.l1.blocking.length;
          if (fixedSomething && !worse) {
            kept.push(command);
            simulated = trial;
          } else {
            const before = simulated.l1.blocking.map(b => b.check);
            const after = trial.l1.blocking.map(b => b.check);
            const fixedList = before.filter(k => !after.includes(k));
            const brokeList = after.filter(k => !before.includes(k));
            rejected.push({
              command,
              reason: brokeList.length
                ? `换了一条：修掉 ${fixedList.join('/') || '无'}，却新增 ${brokeList.join('/')}`
                : (fixedList.length ? `修掉 ${fixedList.join('/')} 但整页阻塞项没有减少` : '试跑后没有任何阻塞项转正'),
              before,
              after,
            });
          }
        }

        // 继续收敛：反复尝试被拒的命令（前面的命令可能已经改变了前提）
        let progress = true;
        while (progress && rejected.length) {
          progress = false;
          for (let i = 0; i < rejected.length; i++) {
            const candidate = rejected[i].command;
            const trial = simulate([...kept, candidate]);
            if (!trial) continue;
            if (trial.l1.blocking.length < simulated.l1.blocking.length) {
              kept.push(candidate);
              simulated = trial;
              rejected.splice(i, 1);
              progress = true;
              break;
            }
          }
        }

        // 组合重试：有些修复必须一起提交才生效（例如两个列表各补一条空态）。
        if (rejected.length > 1) {
          const batch = rejected.map(item => item.command);
          const trial = simulate([...kept, ...batch]);
          if (trial && trial.l1.blocking.length < simulated.l1.blocking.length) {
            kept.push(...batch);
            simulated = trial;
            rejected.length = 0;
            plan.notes = [...(plan.notes || []), { nodeId: null, reason: '这些命令需要一起提交才生效（单条试跑无法转正）' }];
          }
        }

        const unfixable = simulated.l1.blocking.map(item => ({
          check: item.check,
          reason: plan.manual?.some(m => item.check === 'tap-target' && /热区/.test(m.reason))
            ? '需要渲染层实现命中区，或接受撑大图形'
            : item.check === 'visual-hierarchy'
              ? '需要真正的主次内容（主图/更大的承载块），加减尺寸只会在两个子句之间来回撞'
              : item.check === 'contrast'
              ? `对比度不足/不可判断的节点：${(metrics.metrics.contrast?.unknownNodes || []).concat((metrics.metrics.contrast?.worst || []).map(w => w.id)).slice(0, 4).join('，') || '见 metrics.contrast'}——需要换底色、加遮罩或改字色，属设计决策`
              : item.check === 'type-scale'
                ? '需要改字号阶梯（内容层决策），不是几何修复'
                : '没有可确定性修复的路径，需要人工判断',
        }));

        return sendJson(res, 200, {
          ...plan,
          commands: kept,
          rejected,
          unfixable,
          baseRevision: this.store.appliedRevision,
          projected: {
            before: { verdict: metrics.l1.verdict, blocking: [...baselineBlocking] },
            after: { verdict: simulated.l1.verdict, blocking: simulated.l1.blocking.map(b => b.check) },
          },
          verified: true,
          verificationBasis: 'geometry',
        });
  }

  async routePostDesignExplore(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        if(body.async===true)return sendJson(res,200,await this.operations.start('explore',{...body,pageId:body.pageId||this.scene.pages[0]?.id},this.store.doc));
        const { exploreVariants } = await import('./explore.mjs');
        try {
          if (body.candidates) {
            const { previewCandidates } = await import('./candidate-explorations.mjs');
            return sendJson(res, 200, await previewCandidates(this, { ...body, pageId: body.pageId || this.scene.pages[0]?.id }));
          }
          const result = exploreVariants(this.store.doc, {
            pageId: body.pageId || this.scene.pages[0]?.id,
            axes: body.axes || {},
            limit: Math.max(2, Math.min(40, Number(body.limit) || 12)),
          });
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { ok: false, code: err.code || 'E_EXPLORE', message: err.message });
        }
  }

  async routeGetDesignReviews(req, res, { parsedUrl, pathname }) {
        const dir = join(this.projectDir, 'design-reviews');
        const pageId = parsedUrl.searchParams.get('pageId');
        const records = existsSync(dir) ? readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
          .map(name => JSON.parse(readFileSync(join(dir, name))))
          .filter(r => r.nodeSnapshots && (!pageId || r.pageId === pageId))
          .sort((a, b) => b.revision - a.revision).slice(0, 20)
          .map(r => ({ reviewId: r.reviewId, pageId: r.pageId, revision: r.revision, contentHash: r.contentHash })) : [];
        return sendJson(res, 200, { ok: true, reviews: records });
  }

  async routePostDesignReview(req, res, { parsedUrl, pathname }) {
        sendJson(res, 200, await reviewDesign(this, await readJsonBody(req)));
        return;
  }

  async routePostOperations(req, res, { parsedUrl, pathname }) {
        const {action,...body}=await readJsonBody(req);
        if(!['get','list','cancel'].includes(action))throw Object.assign(new Error('action需要get/list/cancel'),{code:'E_OPERATION_ACTION'});
        return sendJson(res,200,await this.operations[action](body));
  }

  async routePostExportRp(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        if(body.async===true)return sendJson(res,200,await this.operations.start('export-rp',body,this.store.doc));
        if(body.baseRevision!==undefined&&body.baseRevision!==this.store.appliedRevision)throw Object.assign(new Error('导出版本已变化，请重新确认'),{code:'E_OPERATION_STALE'});
        const expRes = await this.exportRp({
          outRpPath: body.outRpPath,
          outReportPath: body.outReportPath,
        });
        sendJson(res, 200, expRes);
        return;
  }

  async routePostExportCode(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        if (body.async === true) {
          return sendJson(res, 200, await this.operations.start('export-code', body, this.store.doc));
        }
        const codeRes = await this.exportCode({
          outDir: body.outDir,
          baseRevision: body.baseRevision,
          resetRegistration: body.resetRegistration,
        });
        sendJson(res, 200, codeRes);
        return;
  }

  async routePostSyncNative(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        if (body.async === true) {
          return sendJson(res, 200, await this.operations.start('sync-native', body, this.store.doc));
        }
        const syncRes = await this.syncNative(body);
        sendJson(res, syncRes.ok === false ? 409 : 200, syncRes);
        return;
  }

  async routePostProjectBundle(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const bundleRes = await this.projectBundle(body);
        sendJson(res, bundleRes.ok === false ? 400 : 200, bundleRes);
        return;
  }

  async routePostProjectMerge(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const mergeRes = await this.mergeDocument(body);
        sendJson(res, mergeRes.ok === false ? 409 : 200, mergeRes);
        return;
  }

  async routePostProjectOpen(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const ctx = this.openProject({
          projectDir: body.projectDir,
          sourcePath: body.sourcePath || null,
          name: body.name || 'Studio Project',
          domain: body.domain || 'mobile',
        });
        sendJson(res, 200, ctx);
        return;
  }

  async routeComponentContracts(req, res, { parsedUrl, pathname }) {
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        const componentId = parsedUrl.searchParams.get('componentId') || body.componentId || null;
        const contractsRes = getComponentContracts(this.store.doc, { componentId });
        sendJson(res, 200, {
          ok: true,
          appliedRevision: this.store.appliedRevision,
          ...contractsRes,
        });
        return;
  }

  async routeGetScenarios(req, res, { parsedUrl, pathname }) {
        sendJson(res, 200, {
          ok: true,
          scenarioCount: SCENARIO_TEMPLATES_12.length,
          scenarios: SCENARIO_TEMPLATES_12,
          domains: Object.keys(DOMAIN_PRESETS),
          domainPresets: DOMAIN_PRESETS,
        });
        return;
  }

  async routePostScenariosRun(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const isBlankDefaultDoc =
          !body.domain &&
          !body.doc &&
          (this.store.doc?.pages?.length ?? 0) === 1 &&
          !this.store.doc?.pages?.some(p => p.id === 'list' || p.id === 'detail') &&
          (this.store.doc?.pages?.[0]?.root?.children?.[0]?.children?.length ?? 0) === 0;
        const targetDoc = body.domain
          ? createDomainProjectDocument(body.domain)
          : body.doc || (isBlankDefaultDoc ? createDomainProjectDocument('birding') : this.store.doc);
        let scenariosToRun = SCENARIO_TEMPLATES_12;
        if (body.impactReport) {
          scenariosToRun = selectAffectedScenarios(body.impactReport, { runAll: Boolean(body.runAll) });
        }
        if (Array.isArray(body.scenarioIds) && body.scenarioIds.length > 0) {
          scenariosToRun = scenariosToRun.filter(s => body.scenarioIds.includes(s.scenarioId));
        }
        if (body.category) {
          scenariosToRun = scenariosToRun.filter(s => s.category === body.category);
        }
        const layers = Array.isArray(body.layers) && body.layers.length > 0 ? body.layers : ['semantic'];
        const runRes = await runAcceptanceScenarios(targetDoc, {
          scenarios: scenariosToRun,
          layers,
          studioServer: layers.includes('browser') ? this : null,
          screenshotDir: body.screenshotDir || join(this.projectDir, 'exports', 'scenario-screenshots'),
          exportDir: body.exportDir || join(this.projectDir, 'exports', 'scenario-rp'),
          axurePreviewUrl: body.axurePreviewUrl || null,
        });
        sendJson(res, 200, {
          ok: true,
          ...runRes,
        });
        return;
  }

  async routePostFaultInjection(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const baseDoc = body.domain ? createDomainProjectDocument(body.domain) : null;
        const faultRes = runFaultInjectionControl(baseDoc);
        sendJson(res, 200, {
          ok: true,
          ...faultRes,
        });
        return;
  }

  async routePostRuntime(req, res, { parsedUrl, pathname }) {
        const body = await readJsonBody(req);
        const sub = pathname.slice('/api/runtime/'.length);
        // 退出预览：清除预览运行态会话，恢复设计态撤销/重做（T-D-1 配套出口）。
        if (sub === 'exit') {
          this.runtimeSession = null;
          sendJson(res, 200, { ok: true, designContentHash: this.store.doc.contentHash });
          return;
        }
        if (!this.runtimeSession) {
          this.runtimeSession = new StudioRuntimeSession(this.store.doc, { projectDir: this.projectDir });
        }
        // scenario 是设计态语义工具，不进入预览只读态；其余子端点来自预览交互。
        if (sub !== 'scenario') this.runtimeSession.preview = true;
        if (sub === 'reset') {
          this.runtimeSession = new StudioRuntimeSession(this.store.doc, { projectDir: this.projectDir });
          if (sub !== 'scenario') this.runtimeSession.preview = true;
          const st = this.runtimeSession.reset(body.startPageId || null);
          sendJson(res, 200, { ok: true, state: st, designContentHash: this.store.doc.contentHash });
          return;
        }
        if (sub === 'click') {
          const st = this.runtimeSession.click(body.targetId);
          sendJson(res, 200, { ok: true, state: st, designContentHash: this.store.doc.contentHash });
          return;
        }
        if (sub === 'input') {
          const st = this.runtimeSession.setInput(body.targetId, body.value);
          sendJson(res, 200, { ok: true, state: st, designContentHash: this.store.doc.contentHash });
          return;
        }
        if (sub === 'navigate') {
          const st = this.runtimeSession.navigate(body.pageId);
          sendJson(res, 200, { ok: true, state: st, designContentHash: this.store.doc.contentHash });
          return;
        }
        if (sub === 'dataset') {
          const executed = [];
          this.runtimeSession._executeDatasetAction(body, executed);
          const st = this.runtimeSession.getState();
          sendJson(res, 200, { ok: true, executed, state: st, designContentHash: this.store.doc.contentHash });
          return;
        }
        if (sub === 'scenario') {
          if (body.reset !== false) {
            this.runtimeSession = new StudioRuntimeSession(this.store.doc, { projectDir: this.projectDir });
            this.runtimeSession.reset(body.startPageId || null);
          }
          // hitTest:true 用真实浏览器指针层先重放校验（遮挡/命中结论与语义层分开，不静默降级）。
          // 指针重放会经 #mode-interact-btn 重置共享运行态并真实点击推进，所以：
          // - 必须 reset:true（全新运行态起跑，续跑会话无法镜像）；
          // - 指针层未通过时语义层不执行，避免“语义 ok / 真实浏览器 fail”的相反结论；
          // - 结束后重建语义会话，保持 scenario 不带 preview 标记（不锁撤销/重做）。
          if (body.hitTest === true) {
            if (body.reset === false) {
              sendJson(res, 200, { ok: false, code: 'E_SCENARIO_HITTEST_RESET_REQUIRED', message: 'hitTest:true 需要从全新运行态开始重放；reset:false 的续跑会话无法在真实浏览器中镜像，请去掉 reset:false 或去掉 hitTest', designContentHash: this.store.doc.contentHash });
              return;
            }
            let page;
            try {
              page = await this.ensureManagedBrowserPage();
            } catch (error) {
              sendJson(res, 200, { ok: false, code: 'E_SCENARIO_HITTEST_UNAVAILABLE', message: '真实浏览器不可用，hitTest 指针校验未执行（不静默降级到语义层）', cause: error?.code || error?.message || String(error), designContentHash: this.store.doc.contentHash });
              return;
            }
            const { runInteractionSteps } = await import('./scenario-executors.mjs');
            const freshSemanticSession = () => {
              this.runtimeSession = new StudioRuntimeSession(this.store.doc, { projectDir: this.projectDir });
              return this.runtimeSession.reset(body.startPageId || null);
            };
            let browser;
            try {
              browser = await runInteractionSteps(page, this.store.doc, body.steps || [], { layer: 'browser', startPageId: body.startPageId || null });
            } catch (error) {
              freshSemanticSession();
              sendJson(res, 200, { ok: false, code: 'E_SCENARIO_HITTEST_UNAVAILABLE', message: '真实浏览器指针重放异常，hitTest 未完成（不静默降级到语义层）', cause: error?.message || String(error), designContentHash: this.store.doc.contentHash });
              return;
            }
            try {
              // 把 managed 页恢复成干净的设计态渲染页，不把交互运行态留给后续渲染确认/截图
              await page.navigate(`${this.url}/?clientId=managed_renderer`);
              await page.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__ >= 1)', 10000);
            } catch { /* best effort：恢复失败不掩盖场景结论 */ }
            if (!browser.passed) {
              freshSemanticSession(); // 指针层失败：语义不执行，共享会话复位回初始运行态
              if (browser.status === 'unsupported') {
                sendJson(res, 200, { ok: false, code: 'E_SCENARIO_HITTEST_UNSUPPORTED', message: '场景包含无法在真实浏览器指针层重放的步骤或字段（如 navigate/dataset 动作），hitTest 不能只对初始态做部分校验', browserLayer: browser, designContentHash: this.store.doc.contentHash });
                return;
              }
              if (/不可见或被遮挡|未找到可见操作目标/.test(browser.message || '')) {
                const steps = body.steps || [];
                const stepIndex = Math.min(browser.history?.length ?? 0, Math.max(steps.length - 1, 0));
                const failedStep = steps[stepIndex] || {};
                const nodeId = failedStep.target || failedStep.id || failedStep.click || failedStep.fill || null;
                const hitDetail = browser.hitDetail || null;
                sendJson(res, 200, {
                  ok: false,
                  code: 'E_SCENARIO_OCCLUDED',
                  message: `真实指针校验未命中：步骤 ${stepIndex} 的目标 ${nodeId ?? '(未知)'} 不可见或被遮挡，语义层未执行该步 click`,
                  stepIndex,
                  nodeId,
                  occludedBy: hitDetail?.occludedBy ?? null,
                  sampledPoints: hitDetail?.sampledPoints ?? [],
                  hitReason: hitDetail?.reason ?? null,
                  browserLayer: browser,
                  designContentHash: this.store.doc.contentHash,
                });
                return;
              }
              sendJson(res, 200, { ok: false, code: 'E_SCENARIO_BROWSER_MISMATCH', message: '真实浏览器指针层未通过（非遮挡原因），语义层未执行，以真实浏览器结论为准', browserLayer: browser, designContentHash: this.store.doc.contentHash });
              return;
            }
            // 指针层通过后重建语义会话（指针重放已重置/推进过共享会话）并照常执行语义层
            freshSemanticSession();
            const result = this.runtimeSession.runScenario(body.steps || []);
            sendJson(res, 200, {
              ...result,
              hitTest: { layer: 'browser', passed: true, verification: 'real-browser-pointer', assertionCount: browser.assertionCount },
              designContentHash: this.store.doc.contentHash,
            });
            return;
          }
          const result = this.runtimeSession.runScenario(body.steps || []);
          sendJson(res, 200, {
            ...result,
            designContentHash: this.store.doc.contentHash,
          });
          return;
        }
    sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `Unknown endpoint: ${pathname}` });
  }

  async start() {
    let candidatePort = this.requestedPort;
    const maxAttempts = 30;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await new Promise((resolveListen, rejectListen) => {
          const srv = createServer((req, res) => this.handleRequest(req, res));
          srv.keepAliveTimeout = 65000;
          srv.headersTimeout = 66000;
          srv.once('error', rejectListen);
          srv.listen(candidatePort, this.host, () => {
            srv.removeListener('error', rejectListen);
            this.server = srv;
            const addr = srv.address();
            this.port = addr && typeof addr === 'object' ? addr.port : candidatePort;
            resolveListen();
          });
        });
        break;
      } catch (err) {
        if (err.code === 'EADDRINUSE') {
          candidatePort++;
          continue;
        }
        throw err;
      }
    }

    if (!this.server) {
      throw Object.assign(
        new Error(`端口 ${this.requestedPort}..${candidatePort - 1} 均被占用，Studio 服务无法绑定`),
        { code: 'E_PORT_EXHAUSTED', requestedPort: this.requestedPort }
      );
    }

    const record = {
      instanceId: this.instanceId,
      sessionId: this.sessionId,
      pid: process.pid,
      host: this.host,
      requestedPort: this.requestedPort,
      port: this.port,
      portAutoSelected: this.port !== this.requestedPort,
      url: this.url,
      projectDir: this.projectDir,
      startedAt: new Date().toISOString(),
    };
    registerInstanceRecord(record);
    writeFileSync(join(this.projectDir, '.studio-instance.json'), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  async exportRp({ outRpPath = null, outReportPath = null } = {}) {
    const resolvedOutRp =
      outRpPath ||
      join(this.projectDir, 'exports', `${this.store.doc.documentId}-rev-${this.store.appliedRevision}.rp`);
    const resolvedOutReport =
      outReportPath ||
      join(this.projectDir, 'exports', `${this.store.doc.documentId}-rev-${this.store.appliedRevision}.compatibility-report.json`);
    return exportStudioDocumentToRp(this.store.doc, {
      projectDir: this.projectDir,
      outRpPath: resolvedOutRp,
      outReportPath: resolvedOutReport,
    });
  }

  async exportCode({ outDir = null, baseRevision = undefined, resetRegistration = false } = {}) {
    const { exportStudioDocumentToCode } = await import('./export-code.mjs');
    const resolvedOutDir =
      outDir ||
      join(this.projectDir, 'exports', `${this.store.doc.documentId}-rev-${this.store.appliedRevision}-code`);
    return exportStudioDocumentToCode(this.store.doc, {
      outDir: resolvedOutDir,
      projectDir: this.projectDir,
      persistence: this.persistence,
      baseRevision,
      resetRegistration,
    });
  }

  async syncNative(options = {}) {
    const { syncNativeRpToStudio } = await import('./sync-native.mjs');
    const result = await syncNativeRpToStudio({
      ...options,
      doc: this.store.doc,
      store: this.store,
      persistence: this.persistence,
      projectDir: this.projectDir,
    });
    if (result.ok && result.mode === 'apply' && !result.noop) {
      this.scene = resolveDocumentScene(this.store.doc, { projectDir: this.projectDir });
      this.runtimeSession = null;
      this.broadcastSse({
        type: 'revision',
        source: 'native-sync',
        ...this.buildContextPayload(),
      });
    }
    return {
      ...result,
      durableRevision: this.store.durableRevision,
      renderedRevision: this.renderedRevision,
    };
  }

  async projectBundle(options = {}) {
    const {
      exportProjectBundle,
      importProjectBundle,
      verifyProjectBundle,
      compareProjectWithBundle,
      buildBundleCompatibilityReport,
    } = await import('./project-bundle.mjs');
    const action = options.action || 'export';
    if (action === 'report') {
      return {
        ok: true,
        action: 'report',
        ...buildBundleCompatibilityReport(this.store.doc, { projectDir: this.projectDir }),
      };
    }
    if (action === 'export') {
      return exportProjectBundle({
        projectDir: this.projectDir,
        bundleDir: options.bundleDir || options.outDir,
        doc: this.store.doc,
        includeVersions: options.includeVersions !== false,
        includeThumbnails: options.includeThumbnails !== false,
      });
    }
    if (action === 'verify') {
      return verifyProjectBundle({ bundleDir: options.bundleDir || options.outDir });
    }
    if (action === 'compare') {
      return compareProjectWithBundle({
        doc: this.store.doc,
        projectDir: this.projectDir,
        bundleDir: options.bundleDir,
      });
    }
    if (action === 'import') {
      return importProjectBundle({
        bundleDir: options.bundleDir,
        targetProjectDir: options.targetProjectDir || this.projectDir,
        allowNewerSchema: options.allowNewerSchema !== false,
      });
    }
    throw Object.assign(new Error(`未知 bundle action: ${action}`), { code: 'E_BUNDLE_ACTION' });
  }

  async mergeDocument(options = {}) {
    const { executeStudioMerge, checkExternalSourceChange } = await import('./document-merge.mjs');
    if (options.mode === 'check-external') {
      return checkExternalSourceChange({
        store: this.store,
        persistence: this.persistence,
        projectDir: this.projectDir,
        externalSourcePath: options.externalSourcePath,
        baseRevision: options.baseRevision ?? 1,
        theirsPageId: options.theirsPageId || null,
        theirsSourceMode: options.theirsSourceMode || null,
        theirsParentId: options.theirsParentId || null,
      });
    }
    const result = executeStudioMerge({
      ...options,
      store: this.store,
      persistence: this.persistence,
      projectDir: this.projectDir,
    });
    if (result.ok && result.mode === 'apply') {
      this.scene = resolveDocumentScene(this.store.doc, { projectDir: this.projectDir });
      this.runtimeSession = null;
      this.broadcastSse({
        type: 'revision',
        source: 'studio-merge',
        ...this.buildContextPayload(),
      });
    }
    return {
      ...result,
      durableRevision: this.store.durableRevision,
      renderedRevision: this.renderedRevision,
    };
  }

  async stop() {
    return this.close();
  }

  async close() {
    try { this.persistence?.flushPendingSnapshot?.(); } catch {}
    unregisterInstanceRecord(this.instanceId);
    for (const w of this.renderWaiters) {
      clearTimeout(w.timer);
      try { w.reject(Object.assign(new Error('Studio 服务已关闭'), { code: 'E_SERVER_CLOSED' })); } catch {}
    }
    this.renderWaiters = [];
    for (const res of this.sseClients) {
      try { res.end(); } catch {}
    }
    this.sseClients.clear();
    if (this.managedChrome) {
      if (this.ownsManagedChrome) {
        try { await this.managedChrome.close(); } catch {}
      } else if (this.managedPage) {
        try { await this.managedPage.navigate('about:blank'); } catch {}
      }
      this.managedChrome = null;
      this.managedPage = null;
    }
    if (this.server) {
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
      await new Promise(r => this.server.close(r));
      this.server = null;
    }
  }
}

export async function startStudioServer(options) {
  const studio = new StudioServer(options);
  const info = await studio.start();
  return { studio, info };
}
