import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeContentHash, sha256 } from './document.mjs';
import { resolveDocumentScene, RENDERER_VERSION } from './scene-resolver.mjs';
import { StudioPersistence } from './persistence.mjs';
import { StudioRuntimeSession } from './runtime.mjs';
import { exportStudioDocumentToRp } from './export-rp.mjs';
import { launchChrome } from './cdp.mjs';
import { getComponentContracts } from './component-contracts.mjs';
import { getDesignContext } from './design-context.mjs';
import { prepareMedia } from './media.mjs';
import { reviewDesign } from './design-review.mjs';
import {
  SCENARIO_TEMPLATES_12,
  DOMAIN_PRESETS,
  createDomainProjectDocument,
  selectAffectedScenarios,
  runAcceptanceScenarios,
  runFaultInjectionControl,
} from './scenarios.mjs';

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

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(Object.assign(new Error(`Invalid JSON body: ${err.message}`), { code: 'E_INVALID_JSON' }));
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res, status, payload) {
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

export class StudioServer {
  constructor({
    projectDir,
    sourcePath = null,
    name = 'Studio Project',
    domain = 'mobile',
    host = '127.0.0.1',
    port = 4310,
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
    this.managedChrome = null;
    this.managedPage = null;
    this.server = null;

    this.openProject({ projectDir, sourcePath, name, domain });
  }

  openProject({ projectDir, sourcePath = null, name = 'Studio Project', domain = 'mobile' }) {
    this.projectDir = resolve(projectDir);
    this.persistence = new StudioPersistence(this.projectDir);
    const { store, recoveryReport } = this.persistence.initOrLoad({ sourcePath, name, domain });
    this.store = store;
    this.recoveryReport = recoveryReport;
    this.scene = resolveDocumentScene(this.store.doc);
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
      recoveryReport: this.recoveryReport,
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
      doc: this.store.doc,
      scene: this.scene,
    };
  }

  broadcastSse(eventObj) {
    const data = `data: ${JSON.stringify(eventObj)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(data);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  recordRenderConfirm({ renderedRevision, contentHash, clientId, sessionId }) {
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

  async ensureManagedBrowserPage() {
    if (this.managedChrome && this.managedPage) {
      return this.managedPage;
    }
    this.managedChrome = await launchChrome({ headless: true, width: 1440, height: 1050, dpr: 2 });
    this.managedPage = await this.managedChrome.openPage(`${this.url}/?clientId=managed_renderer`);
    await this.managedPage.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__ >= 1)', 10000);
    return this.managedPage;
  }

  async waitForRenderedRevision(targetRevision = this.store.appliedRevision, { timeoutMs = 4000, simulateHang = false } = {}) {
    if (simulateHang) {
      await new Promise(r => setTimeout(r, timeoutMs + 20));
      throw Object.assign(
        new Error(`等待版本 rev ${targetRevision} 浏览器渲染超时 (${timeoutMs}ms)`),
        { code: 'E_RENDER_TIMEOUT', targetRevision, renderedRevision: this.renderedRevision }
      );
    }

    if (this.renderedRevision >= targetRevision && this.lastRenderConfirm?.contentHash === this.store.doc.contentHash) {
      return this.lastRenderConfirm;
    }

    // If no external SSE browser client is connected, or to guarantee immediate render confirmation, sync managed page
    const waitPromise = new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.renderWaiters = this.renderWaiters.filter(w => w.timer !== timer);
        rejectWait(
          Object.assign(
            new Error(`等待版本 rev ${targetRevision} 浏览器渲染超时 (${timeoutMs}ms)`),
            { code: 'E_RENDER_TIMEOUT', targetRevision, renderedRevision: this.renderedRevision }
          )
        );
      }, timeoutMs);
      this.renderWaiters.push({ targetRevision, timer, resolve: resolveWait, reject: rejectWait });
    });

    const syncManagedRenderer = () => {
      const expectedHash = this.store.doc.contentHash;
      this.ensureManagedBrowserPage()
        .then(async page => {
          await page.evaluate(`(async () => {
            if (window.__STUDIO_RENDERED_REVISION__ !== ${targetRevision} || window.__STUDIO_RENDERED_HASH__ !== ${JSON.stringify(expectedHash)}) {
              const res = await fetch('/api/context');
              const data = await res.json();
              if (window.__STUDIO_STATE__ && window.__STUDIO_APP__) {
                window.__STUDIO_STATE__.doc = data.doc;
                window.__STUDIO_STATE__.scene = data.scene;
                window.__STUDIO_STATE__.appliedRevision = data.appliedRevision;
                window.__STUDIO_STATE__.durableRevision = data.durableRevision;
                window.__STUDIO_APP__.selectNodes(window.__STUDIO_STATE__.selectedIds || [], window.__STUDIO_STATE__.activePageId);
                if (document.fonts && document.fonts.ready) await document.fonts.ready;
                void document.body.offsetHeight;
                await Promise.race([new Promise(r => requestAnimationFrame(r)), new Promise(r => setTimeout(r, 16))]);
                window.__STUDIO_RENDERED_REVISION__ = data.appliedRevision;
                window.__STUDIO_RENDERED_HASH__ = data.contentHash;
                await fetch('/api/render-confirm', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    clientId: 'managed_renderer',
                    sessionId: data.sessionId,
                    renderedRevision: data.appliedRevision,
                    contentHash: data.contentHash,
                  })
                });
              }
            }
          })()`);
        })
        .catch(() => {});
    };

    if (this.sseClients.size === 0) {
      syncManagedRenderer();
    } else {
      const fallbackTimer = setTimeout(() => {
        if (this.renderedRevision < targetRevision) syncManagedRenderer();
      }, 250);
      waitPromise.finally(() => clearTimeout(fallbackTimer)).catch(() => {});
    }

    return waitPromise;
  }


  // 截图取样：把"对比度"从公式猜测变成真实测量。
  async capturePixelContrast(pageId) {
    const { measurePixelContrast } = await import('./pixel-truth.mjs');
    const target = this.scene.pages.find(p => p.id === pageId);
    if (!target) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
    const page = await this.ensureManagedBrowserPage();
    await this.waitForRenderedRevision(this.store.appliedRevision, { timeoutMs: 5000 });
    await page.evaluate(`(async () => {
      const pg = window.__STUDIO_STATE__?.scene?.pages?.find(p => p.id === ${JSON.stringify(pageId)});
      if (window.__STUDIO_APP__ && pg) {
        if (window.__STUDIO_APP__.state.mode !== 'design') document.querySelector('[data-mode="design"]')?.click();
        window.__STUDIO_APP__.selectNodes([], ${JSON.stringify(pageId)});
        window.__STUDIO_APP__.setPanZoom(40 - (pg._stageX ?? 60), 40 - (pg._stageY ?? 40), 1);
      }
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const rect = await page.evaluate(`(() => {
      const el = document.querySelector('.artboard-wrapper[data-artboard-id=${JSON.stringify(pageId)}] .artboard-outer')
        || document.getElementById('screen-root');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!rect) throw Object.assign(new Error('找不到画板元素'), { code: 'E_NO_ARTBOARD' });
    const png = await page.screenshot({
      format: 'png',
      clip: { x: rect.x, y: rect.y, w: rect.w, h: rect.h, scale: 1 },
      captureBeyondViewport: true,
    });
    const boxes = (target.nodes || [])
      .filter(n => typeof n.text === 'string' && n.text.trim() && n.visible !== false && Number(n.opacity ?? 1) >= 0.02)
      .map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, color: n.color, fontSize: n.fontSize, fontWeight: n.fontWeight }));
    const results = measurePixelContrast(png, boxes, { scale: 2 });
    return { pageId, dpr: 2, board: { w: target.board?.screenW, h: target.board?.screenH }, results };
  }

  async captureScreenshot({
    revision = this.store.appliedRevision,
    pageId = null,
    nodeId = null,
    outPath = null,
    timeoutMs = 5000,
    simulateHang = false,
    includeImage = false,
  } = {}) {
    if (revision > this.store.appliedRevision) {
      throw Object.assign(
        new Error(`请求的截图版本 rev ${revision} 大于当前最新文档版本 rev ${this.store.appliedRevision}`),
        { code: 'E_FUTURE_REVISION', requestedRevision: revision, currentRevision: this.store.appliedRevision }
      );
    }

    if (!simulateHang) {
      await this.ensureManagedBrowserPage();
    }
    await this.waitForRenderedRevision(revision, { timeoutMs, simulateHang });
    const page = await this.ensureManagedBrowserPage();

    // Ensure the managed page has rendered the exact requested revision and active page
    const targetPageId = pageId || this.store.doc.pages[0]?.id || 'home';
    const board = this.scene.pages.find(pg => pg.id === targetPageId)?.board;
    if (board) {
      // The capture renderer must fit the artboard inside the canvas viewport;
      // clipping a larger board otherwise includes the Inspector over its right edge.
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(1440, Math.ceil(board.totalW + 850)),
        height: Math.max(900, Math.ceil(board.totalH + 240)),
        deviceScaleFactor: 2,
        mobile: false,
      });
    }
    await page.evaluate(`(async () => {
      if (window.__STUDIO_APP__) {
        if (window.__STUDIO_APP__.state.mode !== 'design') document.querySelector('[data-mode="design"]')?.click();
        window.__STUDIO_APP__.selectNodes([], ${JSON.stringify(targetPageId)});
        const pg = window.__STUDIO_STATE__?.scene?.pages?.find(p => p.id === ${JSON.stringify(targetPageId)});
        if (pg) window.__STUDIO_APP__.setPanZoom(40 - (pg._stageX ?? 60), 40 - (pg._stageY ?? 40), 1);
      }
      if (window.__STUDIO_RENDERED_REVISION__ !== ${revision} || window.__STUDIO_STATE__?.activePageId !== ${JSON.stringify(targetPageId)}) {
        const res = await fetch('/api/context');
        const data = await res.json();
        if (window.__STUDIO_STATE__ && window.__STUDIO_APP__) {
          window.__STUDIO_STATE__.doc = data.doc;
          window.__STUDIO_STATE__.scene = data.scene;
          window.__STUDIO_STATE__.appliedRevision = data.appliedRevision;
          window.__STUDIO_STATE__.durableRevision = data.durableRevision;
          window.__STUDIO_APP__.selectNodes([], ${JSON.stringify(targetPageId)});
        }
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        const imgs = [...document.querySelectorAll('#canvas-stage img')];
        await Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; setTimeout(r, 1000); })));
        await new Promise(r => requestAnimationFrame(r));
        window.__STUDIO_RENDERED_REVISION__ = data.appliedRevision;
        window.__STUDIO_RENDERED_HASH__ = data.contentHash;
      }
    })()`);

    const renderCheck = await page.evaluate(`(() => {
      const targetEl = ${
        nodeId
          ? `document.querySelector('.studio-node[data-node-id=${JSON.stringify(nodeId)}]')`
          : `document.querySelector('.artboard-wrapper[data-artboard-id=${JSON.stringify(targetPageId)}] .artboard-outer') || document.getElementById('screen-root')`
      };
      if (!targetEl) return null;
      const r = targetEl.getBoundingClientRect();
      return {
        pageId: targetEl.closest('.artboard-wrapper')?.getAttribute('data-artboard-id'),
        renderedRevision: window.__STUDIO_RENDERED_REVISION__,
        contentHash: window.__STUDIO_RENDERED_HASH__,
        rect: { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), w: Math.round(r.width), h: Math.round(r.height) },
      };
    })()`);

    if (renderCheck?.pageId !== targetPageId) throw Object.assign(new Error('实际截取画板与请求页面不一致'), { code: 'E_SCREENSHOT_PAGE_MISMATCH' });

    if (!renderCheck || renderCheck.renderedRevision < revision) {
      throw Object.assign(
        new Error(`截图失败：浏览器渲染版本 (${renderCheck?.renderedRevision}) 未达到请求版本 (${revision})`),
        { code: 'E_SCREENSHOT_REVISION_MISMATCH', requestedRevision: revision, renderedRevision: renderCheck?.renderedRevision }
      );
    }

    // The workspace has floating panels above the canvas. Only the dedicated
    // capture page hides them; document geometry and the human UI stay intact.
    await page.evaluate("document.body.classList.add('studio-capture')");
    let buf;
    try {
      buf = await page.screenshot({
        clip: {
          x: renderCheck.rect.x,
          y: renderCheck.rect.y,
          w: Math.max(10, renderCheck.rect.w),
          h: Math.max(10, renderCheck.rect.h),
          // DPR already supplies the 2x pixels. Multiplying clip scale as well
          // produced 4x images (with incorrect metadata) and huge effect surfaces.
          scale: 1,
        },
      });
    } finally {
      await page.evaluate("document.body.classList.remove('studio-capture')");
    }

    const imageSha = sha256(buf);
    let savedPath = null;
    if (outPath) {
      savedPath = resolve(outPath);
      mkdirSync(dirname(savedPath), { recursive: true });
      writeFileSync(savedPath, buf);
    }

    return {
      ok: true,
      revision: this.store.appliedRevision,
      durableRevision: this.store.durableRevision,
      renderedRevision: renderCheck.renderedRevision,
      contentHash: this.store.doc.contentHash,
      rendererVersion: RENDERER_VERSION,
      pageId: targetPageId,
      nodeId: nodeId || null,
      width: renderCheck.rect.w * 2,
      height: renderCheck.rect.h * 2,
      sha256: imageSha,
      outPath: savedPath,
      base64: outPath ? undefined : buf.toString('base64'),
      ...(includeImage ? { mcpImages: [{ mimeType: 'image/png', data: buf.toString('base64') }], base64: undefined } : {}),
    };
  }

  async handleRequest(req, res) {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${this.host}:${this.port}`);
      const pathname = parsedUrl.pathname;

      // Static Web UI files
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/styles.css' || pathname === '/app.js' || pathname === '/visual-style.mjs')) {
        const relFile = pathname === '/' ? 'index.html' : pathname.slice(1);
        const fullPath = join(pathname === '/visual-style.mjs' ? HERE : WEB_DIR, relFile);
        const content = readFileSync(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(fullPath)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      }

      // Project localized assets
      if (req.method === 'GET' && pathname.startsWith('/assets/')) {
        const assetRel = decodeURIComponent(pathname.slice('/assets/'.length));
        const assetPath = join(this.projectDir, 'assets', assetRel);
        if (!existsSync(assetPath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const buf = readFileSync(assetPath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(assetPath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
        return;
      }

      // SSE Stream
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        this.sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: 'snapshot', ...this.buildContextPayload() })}\n\n`);
        req.on('close', () => {
          this.sseClients.delete(res);
        });
        return;
      }

      // Context & state summary
      if (req.method === 'GET' && pathname === '/api/context') {
        sendJson(res, 200, this.buildContextPayload());
        return;
      }

      // Query nodes, components, tokens, fonts
      if (req.method === 'POST' && pathname === '/api/query') {
        const body = await readJsonBody(req);
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

      // Apply Command Transaction
      if (req.method === 'POST' && pathname === '/api/commands') {
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
        // Asset bytes are prepared outside the document transaction; reject a
        // stale or invented registration before changing nodes or history.
        for (const command of body.commands || []) {
          if (command.type !== 'registerAsset') continue;
          const asset = command.asset;
          if (!/^assets\/[a-zA-Z0-9_.-]+$/.test(asset?.relativePath || '')
            || !existsSync(join(this.projectDir, asset.relativePath))
            || sha256(readFileSync(join(this.projectDir, asset.relativePath))) !== asset.sha256) {
            throw Object.assign(new Error('资源不存在或 SHA 已变化，请重新准备素材'), { code: 'E_ASSET_BYTES_MISMATCH' });
          }
        }
        const txResult = this.store.applyTransaction({
          baseRevision: body.baseRevision,
          idempotencyKey: body.idempotencyKey,
          source: body.source || 'client',
          clientId: body.clientId || 'anonymous',
          pageId: body.pageId || null,
          documentId: body.documentId || null,
          label: body.label || null,
          actor: body.actor || null,
          commands: body.commands || [],
        });

        if (!txResult.ok) {
          const status = txResult.code === 'E_STALE_REVISION' || txResult.code === 'E_IDEMPOTENCY_CONFLICT' ? 409 : 400;
          sendJson(res, status, {
            ...txResult,
            appliedRevision: this.store.appliedRevision,
            durableRevision: this.store.durableRevision,
            renderedRevision: this.renderedRevision,
          });
          return;
        }

        if (!txResult.idempotentReplay) {
          const latestTx = this.store.transactions[this.store.transactions.length - 1];
          this.persistence.persistTransaction(this.store, latestTx, {
            simulateCrashStage: body.simulateCrashStage || null,
          });
          this.scene = txResult.scene || resolveDocumentScene(this.store.doc);
          this.runtimeSession = null;
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

        sendJson(res, 200, {
          ...txResult,
          sessionId: this.sessionId,
          durableRevision: this.store.durableRevision,
          renderedRevision: this.renderedRevision,
          doc: this.store.doc,
          scene: this.scene,
        });
        return;
      }

      // Undo / Redo
      if (req.method === 'POST' && (pathname === '/api/undo' || pathname === '/api/redo')) {
        const body = await readJsonBody(req);
        const opRes = pathname === '/api/undo' ? this.store.undo(body) : this.store.redo(body);
        if (!opRes.ok) {
          sendJson(res, 400, opRes);
          return;
        }
        this.persistence.saveFullSnapshot(this.store.doc);
        this.store.markDurable(this.store.doc.revision);
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

      // Browser Render Confirmation
      if (req.method === 'POST' && pathname === '/api/render-confirm') {
        const body = await readJsonBody(req);
        this.recordRenderConfirm(body);
        sendJson(res, 200, {
          ok: true,
          renderedRevision: this.renderedRevision,
          lastRenderConfirm: this.lastRenderConfirm,
        });
        return;
      }

      // Wait for Render
      if (req.method === 'POST' && pathname === '/api/wait-render') {
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

      // Versioned Screenshot
      if (req.method === 'POST' && pathname === '/api/screenshot') {
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

      // Runtime Session Endpoints
      if (req.method === 'POST' && pathname === '/api/design/context') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ...getDesignContext(body), project: { revision: this.store.appliedRevision,
          contentHash: this.store.doc.contentHash, tokens: this.store.doc.tokens,
          pages: this.scene.pages.map(p => ({ id: p.id, name: p.name, board: p.board })) } });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/media/prepare') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await prepareMedia({ ...body, projectDir: this.projectDir, tokens: this.store.doc.tokens }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/design/metrics') {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.scene.pages[0]?.id;
        const page = this.scene.pages.find(p => p.id === pageId);
        if (!page) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { computeDesignMetrics, summarizeMetrics } = await import('./design-metrics.mjs');
        // 像素真值优先：截图取样比几何模拟可靠（遮罩/滤镜/图片底一次覆盖）。
        let pixelContrast = null;
        if (body.pixelTruth) {
          try {
            const shot = await this.capturePixelContrast(pageId);
            pixelContrast = shot.results;
          } catch (err) {
            pixelContrast = null;
          }
        }
        const result = computeDesignMetrics(page, {
          thresholds: body.thresholds || undefined,
          doc: this.store.doc,
          pixelContrast,
        });
        return sendJson(res, 200, { ok: true, ...result, summary: summarizeMetrics(result) });
      }
      if (req.method === 'POST' && pathname === '/api/design/anchors') {
        const body = await readJsonBody(req);
        const { extractAnchors, summarizeAnchors, compareToAnchors, mergeAnchorSets, ANCHOR_FILE } = await import('./anchors.mjs');
        const anchorPath = join(this.projectDir, ANCHOR_FILE);
        const readSet = () => {
          try { return JSON.parse(readFileSync(anchorPath, 'utf8')); } catch { return null; }
        };
        try {
          if (body.action === 'extract' || body.action === 'approve') {
            const manual = body.action === 'approve';
            const pages = manual ? (body.pages || (body.pageId ? [body.pageId] : [])) : (body.pages || null);
            if (manual && !pages.length) {
              return sendJson(res, 400, { ok: false, code: 'E_APPROVE_TARGET', message: 'approve 需要 pageId 或 pages' });
            }
            const incoming = extractAnchors(this.store.doc, {
              pages,
              // 只有显式 includeBelowBar 或人工 approve 才允许低于达标线的页面进入锚点
              includeBelowBar: manual || Boolean(body.includeBelowBar),
            });
            if (manual) for (const anchor of incoming.anchors) anchor.approvedBy = 'human';
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
      if (req.method === 'POST' && pathname === '/api/design/pixel-contrast') {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.store.doc.pages[0]?.id || 'home';
        const target = this.scene.pages.find(p => p.id === pageId);
        if (!target) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { measurePixelContrast } = await import('./pixel-truth.mjs');
        const page = await this.ensureManagedBrowserPage();
        await this.waitForRenderedRevision(this.store.appliedRevision, { timeoutMs: 5000 });
        // 让画板以 1:1 落在视口内，再按画板矩形裁剪截图——坐标才能和 scene 对上。
        await page.evaluate(`(async () => {
          const pg = window.__STUDIO_STATE__?.scene?.pages?.find(p => p.id === ${JSON.stringify(pageId)});
          if (window.__STUDIO_APP__ && pg) {
            if (window.__STUDIO_APP__.state.mode !== 'design') document.querySelector('[data-mode="design"]')?.click();
            window.__STUDIO_APP__.selectNodes([], ${JSON.stringify(pageId)});
            window.__STUDIO_APP__.setPanZoom(40 - (pg._stageX ?? 60), 40 - (pg._stageY ?? 40), 1);
          }
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        })()`);
        const rect = await page.evaluate(`(() => {
          const el = document.querySelector('.artboard-wrapper[data-artboard-id=${JSON.stringify(pageId)}] .artboard-outer')
            || document.getElementById('screen-root');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        })()`);
        if (!rect) return sendJson(res, 503, { ok: false, code: 'E_NO_ARTBOARD', message: '找不到画板元素' });
        const dpr = 2;
        const png = await page.screenshot({
          format: 'png',
          clip: { x: rect.x, y: rect.y, w: rect.w, h: rect.h, scale: 1 },
          captureBeyondViewport: true,
        });
        const boxes = (target.nodes || [])
          .filter(n => typeof n.text === 'string' && n.text.trim() && n.visible !== false && Number(n.opacity ?? 1) >= 0.02)
          .map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, color: n.color, fontSize: n.fontSize, fontWeight: n.fontWeight }));
        const results = measurePixelContrast(png, boxes, { scale: dpr });
        return sendJson(res, 200, {
          ok: true,
          pageId,
          source: 'pixel',
          dpr,
          board: { w: target.board?.screenW || rect.w, h: target.board?.screenH || rect.h },
          measured: results.length,
          failing: results.filter(r => !r.passes).length,
          worst: results.filter(r => !r.passes).slice(0, 5),
          results,
          baseRevision: this.store.appliedRevision,
        });
      }
      if (req.method === 'POST' && pathname === '/api/design/content-plan') {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.scene.pages[0]?.id;
        const page = this.scene.pages.find(p => p.id === pageId);
        if (!page) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { buildContentPlan } = await import('./content-plan.mjs');
        return sendJson(res, 200, { ...buildContentPlan(page), baseRevision: this.store.appliedRevision });
      }
      if (req.method === 'POST' && pathname === '/api/design/fix-plan') {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.scene.pages[0]?.id;
        const page = this.scene.pages.find(p => p.id === pageId);
        if (!page) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { computeDesignMetrics } = await import('./design-metrics.mjs');
        let pixelContrast = null;
        if (body.pixelTruth) {
          try {
            const shot = await this.capturePixelContrast(pageId);
            pixelContrast = shot.results;
          } catch (err) {
            pixelContrast = null;
          }
        }
        const { buildFixPlan } = await import('./fix-plan.mjs');
        const { resolveDocumentScene } = await import('./scene-resolver.mjs');
        const { applySingleCommand } = await import('./commands.mjs');
        const metrics = computeDesignMetrics(page, { doc: this.store.doc, pixelContrast });
        const plan = buildFixPlan(page, metrics, this.store.doc);

        // 自证：在文档副本上真跑一遍自己的命令，逐条判断"是否真的让某个检查转正"。
        // 不做这一步，计划就可能用元数据刷绿（坐标漂移、幽灵字段、空盒子）。
        const baselineBlocking = new Set(metrics.l1.blocking.map(b => b.check));
        const simulate = commands => {
          const doc = structuredClone(this.store.doc);
          commands.forEach((command, index) => applySingleCommand(doc, structuredClone(command), index, pageId));
          const scene = resolveDocumentScene(doc);
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
        });
      }
      if (req.method === 'POST' && pathname === '/api/design/explore') {
        const body = await readJsonBody(req);
        const { exploreVariants } = await import('./explore.mjs');
        try {
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
      if (req.method === 'POST' && pathname === '/api/design/review') {
        sendJson(res, 200, await reviewDesign(this, await readJsonBody(req)));
        return;
      }
      if (req.method === 'POST' && pathname.startsWith('/api/runtime/')) {
        const body = await readJsonBody(req);
        const sub = pathname.slice('/api/runtime/'.length);
        if (!this.runtimeSession) {
          this.runtimeSession = new StudioRuntimeSession(this.store.doc);
        }
        if (sub === 'reset') {
          this.runtimeSession = new StudioRuntimeSession(this.store.doc);
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
            this.runtimeSession = new StudioRuntimeSession(this.store.doc);
            this.runtimeSession.reset(body.startPageId || null);
          }
          const result = this.runtimeSession.runScenario(body.steps || []);
          sendJson(res, 200, {
            ...result,
            designContentHash: this.store.doc.contentHash,
          });
          return;
        }
      }

      // Export Native .rp
      if (req.method === 'POST' && pathname === '/api/export-rp') {
        const body = await readJsonBody(req);
        const expRes = await this.exportRp({
          outRpPath: body.outRpPath,
          outReportPath: body.outReportPath,
        });
        sendJson(res, 200, expRes);
        return;
      }

      // Open / Switch Project
      if (req.method === 'POST' && pathname === '/api/project/open') {
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

      // Component Contracts Query (Direction 3)
      if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/component-contracts') {
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

      // Reusable Acceptance Scenarios Catalog (Direction 5)
      if (req.method === 'GET' && pathname === '/api/scenarios') {
        sendJson(res, 200, {
          ok: true,
          scenarioCount: SCENARIO_TEMPLATES_12.length,
          scenarios: SCENARIO_TEMPLATES_12,
          domains: Object.keys(DOMAIN_PRESETS),
          domainPresets: DOMAIN_PRESETS,
        });
        return;
      }

      // Run Acceptance Scenarios (Direction 5)
      if (req.method === 'POST' && pathname === '/api/scenarios/run') {
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

      // Run Fault Injection Control Experiment (Direction 5)
      if (req.method === 'POST' && pathname === '/api/scenarios/fault-injection') {
        const body = await readJsonBody(req);
        const baseDoc = body.domain ? createDomainProjectDocument(body.domain) : null;
        const faultRes = runFaultInjectionControl(baseDoc);
        sendJson(res, 200, {
          ok: true,
          ...faultRes,
        });
        return;
      }

      sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `Unknown endpoint: ${pathname}` });
    } catch (err) {
      const code = err.code || 'E_INTERNAL_ERROR';
      const status = code === 'E_RENDER_TIMEOUT' ? 504 : 400;
      sendJson(res, status, {
        ok: false,
        code,
        message: err.message,
        appliedRevision: this.store?.appliedRevision,
        durableRevision: this.store?.durableRevision,
        renderedRevision: this.renderedRevision,
      });
    }
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

  async stop() {
    return this.close();
  }

  async close() {
    unregisterInstanceRecord(this.instanceId);
    for (const res of this.sseClients) {
      try { res.end(); } catch {}
    }
    this.sseClients.clear();
    if (this.managedChrome) {
      try { await this.managedChrome.close(); } catch {}
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
