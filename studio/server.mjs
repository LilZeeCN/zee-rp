import { StudioSelections } from './selection.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, computeContentHash, sha256 } from './document.mjs';
import { resolveDocumentScene, RENDERER_VERSION } from './scene-resolver.mjs';
import { StudioPersistence } from './persistence.mjs';
import { StudioRuntimeSession } from './runtime.mjs';
import { exportStudioDocumentToRp } from './export-rp.mjs';
import { launchChrome } from './cdp.mjs';
import { collectRenderedText, contrastTextNodes, measurePixelContrast } from './pixel-truth.mjs';
import { decodePng } from './png-decode.mjs';
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

  async ensureManagedBrowserPage() {
    if (this.managedChrome && this.managedPage) {
      const currentHref = await this.managedPage.evaluate('location.href').catch(() => '');
      if (currentHref.startsWith(this.url)) {
        return this.managedPage;
      }
      await this.managedPage.navigate(`${this.url}/?clientId=managed_renderer`);
      await this.managedPage.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__ >= 1)', 10000);
      return this.managedPage;
    }
    this.managedChrome = await launchChrome({ headless: true, width: 1440, height: 1050, dpr: 2 });
    this.managedPage = await this.managedChrome.openPage(`${this.url}/?clientId=managed_renderer`);
    try {
      await this.managedPage.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__ >= 1)', 10000);
    } catch (error) {
      const state = await this.managedPage.evaluate('({url:location.href,ready:document.readyState,app:!!window.__STUDIO_APP__,revision:window.__STUDIO_RENDERED_REVISION__})').catch(()=>null);
      throw Object.assign(new Error(`画布初始化未完成：${JSON.stringify({state,errors:this.managedPage.scriptErrors})}`),{code:'E_RENDERER_STARTUP',stage:'browser-initialization',cause:error});
    }
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


  // All captures share one managed browser. Temporary paint changes must not overlap.
  withCapture(action) {
    const pending = (this.captureQueue || Promise.resolve()).then(action);
    this.captureQueue = pending.catch(() => {});
    return pending;
  }

  capturePixelContrast(pageId, options = {}) {
    return this.withCapture(() => this._capturePixelContrast(pageId, options));
  }

  async _capturePixelContrast(pageId, { dpr = 2 } = {}) {
    if (!Number.isFinite(dpr) || dpr < 0.5 || dpr > 4) {
      throw Object.assign(new Error('dpr 必须在 0.5–4 之间'), { code: 'E_PIXEL_DPR' });
    }
    const revision = this.store.appliedRevision, contentHash = this.store.doc.contentHash;
    const target = this.scene.pages.find(p => p.id === pageId);
    if (!target) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
    const candidates = contrastTextNodes(target);
    const page = await this.ensureManagedBrowserPage();
    let styleInstalled = false;
    try {
      await page.evaluate(`(() => {
        const style = document.createElement('style');
        style.id = 'studio-pixel-paint';
        style.textContent = '.studio-node, .studio-node * { animation-play-state:paused!important; transition:none!important; caret-color:transparent!important; }';
        document.head.append(style);
      })()`);
      styleInstalled = true;
      await this._captureScreenshot({ revision, pageId, dpr });
      await page.evaluate("document.body.classList.add('studio-capture')");
      const geometry = await page.evaluate(`(${collectRenderedText.toString()})(${JSON.stringify(pageId)}, ${JSON.stringify(candidates.map(n => ({ id: n.id, fontSize: n.fontSize, fontWeight: n.fontWeight })))})`);
      const { clip, boxes } = geometry;
      const missingIds = target.nodes.filter(n => n.assetMissing || (n.type === 'image' && n.src?.startsWith('assets/') && !existsSync(join(this.projectDir, n.src)))).map(n => n.id);
      // Measure visibility before the reference-mask pass forces opacity to 1.
      const missingPaint = await page.evaluate(`(() => {
        const ids = new Set(${JSON.stringify(missingIds)}), clip = ${JSON.stringify(geometry.clip)};
        const board = [...document.querySelectorAll('.artboard-wrapper')].find(el => el.dataset.artboardId === ${JSON.stringify(pageId)});
        return [...(board?.querySelectorAll('.studio-node') || [])].filter(el => ids.has(el.dataset.nodeId)).flatMap(el => {
          for (let p = el; p; p = p.parentElement) {
            const style = getComputedStyle(p);
            if (Number(style.opacity) === 0 || style.display === 'none' || style.visibility === 'hidden') return [];
          }
          const r = el.getBoundingClientRect();
          return [{ x: r.x + scrollX - clip.x, y: r.y + scrollY - clip.y, w: r.width, h: r.height }];
        });
      })()`);

      const screenshot = () => page.screenshot({ clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
      const png = await screenshot();
      await page.evaluate(`(() => {
        document.getElementById('studio-pixel-paint').textContent +=
          '[data-studio-hide-glyphs], [data-studio-hide-glyphs] > .studio-text-span { -webkit-text-fill-color:transparent!important; -webkit-text-stroke-color:transparent!important; text-shadow:none!important; text-decoration-color:transparent!important; }';
        for (const el of document.querySelectorAll('[data-studio-hide-glyphs], [data-studio-hide-glyphs] > .studio-text-span')) {
          if (getComputedStyle(el).backgroundClip === 'text') {
            el.setAttribute('data-studio-original-paint', el.getAttribute('style') || '');
            el.style.setProperty('background-image', 'none', 'important');
          }
        }
      })()`);
      const backgroundPng = await screenshot();
      // Render the same browser glyphs without scene paint or occluders. This
      // reference mask exposes lost strokes inside a character, not just lost words.
      await page.evaluate(`(() => {
        document.getElementById('studio-pixel-paint').textContent +=
          '.artboard-outer, .artboard-screen { background:#000!important; }' +
          '.studio-node, .studio-node * { background:none!important; border-color:transparent!important; box-shadow:none!important; text-shadow:none!important; text-decoration:none!important; color:transparent!important; -webkit-text-fill-color:transparent!important; -webkit-text-stroke:0!important; opacity:1!important; filter:none!important; backdrop-filter:none!important; mix-blend-mode:normal!important; mask:none!important; clip-path:none!important; overflow:visible!important; }' +
          '.studio-node img, .studio-node svg, .artboard-island, .artboard-home-indicator { visibility:hidden!important; }' +
          '[data-studio-hide-glyphs], [data-studio-hide-glyphs] > .studio-text-span { color:#fff!important; -webkit-text-fill-color:#fff!important; }';
      })()`);
      const inkPng = await screenshot();
      if (revision !== this.store.appliedRevision || contentHash !== this.store.doc.contentHash) {
        throw Object.assign(new Error('像素测量期间文档版本已变化，请重试'), { code: 'E_PIXEL_REVISION_CHANGED' });
      }
      // Missing source images must not be certified from their placeholder paint.
      for (const box of boxes) {
        if (missingPaint.some(n => box.glyphs.some(g => n.x < g.x + g.w && n.x + n.w > g.x && n.y < g.y + g.h && n.y + n.h > g.y))) box.reason = 'missing-image-resource';
      }
      const image = decodePng(png);
      const results = measurePixelContrast(png, boxes, { backgroundPng, inkPng, scale: image.width / clip.w, scaleY: image.height / clip.h });
      return { pageId, source: 'pixel', method: 'glyph-difference', dpr: geometry.dpr, revision, contentHash,
        board: { w: target.board.screenW, h: target.board.screenH }, results };
    } finally {
      if (styleInstalled) await page.evaluate(`(() => {
        document.getElementById('studio-pixel-paint')?.remove();
        document.querySelectorAll('[data-studio-hide-glyphs]').forEach(el => el.removeAttribute('data-studio-hide-glyphs'));
        document.body.classList.remove('studio-capture');
        document.querySelectorAll('[data-studio-original-paint]').forEach(el => {
          el.setAttribute('style', el.getAttribute('data-studio-original-paint'));
          el.removeAttribute('data-studio-original-paint');
        });
      })()`);
    }
  }

  async measureDesignMetrics(pageId, { thresholds, pixelTruth = true } = {}) {
    const { computeDesignMetrics } = await import('./design-metrics.mjs');
    let pixelContrast = null, fallbackReason = null;
    if (!this.scene.pages.some(p => p.id === pageId)) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
    if (pixelTruth) {
      try { pixelContrast = (await this.capturePixelContrast(pageId)).results; }
      catch (err) { fallbackReason = `${err.code || 'E_PIXEL_CAPTURE'}: ${err.message}`; }
    }
    const result = computeDesignMetrics(this.scene.pages.find(p => p.id === pageId), {
      thresholds, doc: this.store.doc, pixelContrast,
    });
    if (fallbackReason) result.metrics.contrast.fallbackReason = fallbackReason;
    return { ...result, baseRevision: this.store.appliedRevision, contentHash: this.store.doc.contentHash };
  }

  captureScreenshot(options = {}) {
    return this.withCapture(() => this._captureScreenshot(options));
  }

  async _captureScreenshot({
    revision = this.store.appliedRevision,
    pageId = null,
    nodeId = null,
    outPath = null,
    timeoutMs = 5000,
    simulateHang = false,
    includeImage = false,
    dpr = 2,
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
        deviceScaleFactor: dpr,
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

    // Device viewport changes and SSE renders commit asynchronously in Chromium.
    // Wait for compositor frames even when the document revision did not change.
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
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
        captureBeyondViewport: true,
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
      width: renderCheck.rect.w * dpr,
      height: renderCheck.rect.h * dpr,
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
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/styles.css' || pathname === '/app.js' || pathname === '/visual-style.mjs' || pathname === '/clipboard.mjs')) {
        const relFile = pathname === '/' ? 'index.html' : pathname.slice(1);
        const fullPath = join(['/visual-style.mjs', '/clipboard.mjs'].includes(pathname) ? HERE : WEB_DIR, relFile);
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

      // Project localized fonts
      if (req.method === 'GET' && pathname.startsWith('/fonts/')) {
        const fontRel = decodeURIComponent(pathname.slice('/fonts/'.length));
        const fontPath = join(this.projectDir, 'fonts', fontRel);
        if (!existsSync(fontPath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const buf = readFileSync(fontPath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(fontPath).toLowerCase()] || 'font/ttf',
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
        res.studioClientId=parsedUrl.searchParams.get('clientId');
        this.sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: 'snapshot', ...this.buildContextPayload() })}\n\n`);
        req.on('close', () => {
          this.sseClients.delete(res);
          if(res.studioClientId&&![...this.sseClients].some(client=>client.studioClientId===res.studioClientId))this.selections.clients.delete(res.studioClientId);
        });
        return;
      }

      // Context & state summary
      if (req.method === 'GET' && pathname === '/api/context') {
        sendJson(res, 200, this.buildContextPayload());
        return;
      }

      if(req.method==='POST'&&pathname==='/api/selection'){
        const body=await readJsonBody(req);const selection=this.selections.publish(this.store.doc,this.scene,body);return sendJson(res,200,{ok:true,selectionId:selection.selectionId});
      }
      // Query nodes, components, tokens, fonts
      if (req.method === 'POST' && pathname === '/api/query') {
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
        const txResult = replay || this.store.applyTransaction({
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
        });

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
          const latestTx = this.store.transactions[this.store.transactions.length - 1];
          this.persistence.persistTransaction(this.store, latestTx, {
            simulateCrashStage: body.simulateCrashStage || null,
          });
          this.scene = txResult.scene || resolveDocumentScene(this.store.doc, { projectDir: this.projectDir });
          this.store.lastScene = this.scene;
          this.runtimeSession = null;

          const totalSceneNodes = (this.scene?.pages || []).reduce((acc, p) => acc + (p.nodes?.length || 0), 0);
          const canSendScenePatch =
            totalSceneNodes > 500 &&
            Array.isArray(txResult.affectedNodeIds) &&
            txResult.affectedNodeIds.length > 0 &&
            txResult.affectedNodeIds.length <= 120 &&
            (txResult.semanticDiff?.structureChanges || []).every(c => c.kind === 'geometry-changed') &&
            (txResult.semanticDiff?.componentDefinitionChanges || []).length === 0 &&
            (txResult.semanticDiff?.tokenChanges || []).length === 0 &&
            !commands.some(c => ['addPage', 'removePage', 'deletePage', 'renamePage', 'setPageShell', 'restoreDocument'].includes(c?.type));

          if (canSendScenePatch) {
            const affectedSet = new Set(txResult.affectedNodeIds || []);
            const patchedNodesByPage = {};
            for (const pg of this.scene.pages) {
              const patched = pg.nodes.filter(n => affectedSet.has(n.scopedId) || affectedSet.has(n.id));
              if (patched.length > 0) patchedNodesByPage[pg.id] = patched;
            }
            scenePatch = {
              baseRevision: txResult.baseRevision,
              appliedRevision: this.store.appliedRevision,
              contentHash: this.store.doc.contentHash,
              patchedNodesByPage,
              fontDiagnostics: this.scene.fontDiagnostics,
              clipDiagnostics: this.scene.clipDiagnostics,
              assetDiagnostics: this.scene.assetDiagnostics,
            };
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

      // Undo / Redo
      if (req.method === 'POST' && (pathname === '/api/undo' || pathname === '/api/redo')) {
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
        const opRes = pathname === '/api/undo' ? this.store.undo(body) : this.store.redo(body);
        if (!opRes.ok) {
          sendJson(res, 400, opRes);
          return;
        }
        this.persistence.persistTransaction(this.store, this.store.lastHistoryRecord);
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
      if (req.method === 'POST' && pathname === '/api/versions') {
        const body=await readJsonBody(req);
        const unknown=Object.keys(body).filter(key=>!['action','name','versionId','baseRevision','previewHash','idempotencyKey','projectDir','url','port'].includes(key));
        if(unknown.length) throw Object.assign(new Error(`版本操作不接受字段 ${unknown.join(', ')}`),{code:'E_VERSION_INPUT'});
        if(body.action==='list' || body.action===undefined)return sendJson(res,200,{ok:true,versions:this.versions.list(),revision:this.store.appliedRevision});
        if(body.action==='create')return sendJson(res,200,this.versions.create(this.store,body));
        if(body.action==='preview')return sendJson(res,200,this.versions.preview(this.store,body));
        if(body.action==='restore') {
          const result=this.versions.restore(this.store,body);
          if(result.ok&&!result.idempotentReplay){this.persistence.persistTransaction(this.store,this.store.history.at(-1));this.scene=result.scene;this.runtimeSession=null;this.broadcastSse({type:'revision',...this.buildContextPayload()});}
          return sendJson(res,result.ok?200:409,{...result,durableRevision:this.store.durableRevision,doc:this.store.doc,scene:this.scene});
        }
        throw Object.assign(new Error('action应为list/create/preview/restore'),{code:'E_VERSION_INPUT'});
      }
      if (req.method === 'POST' && pathname === '/api/design/context') {
        const body = await readJsonBody(req);
        const context = getDesignContext(body, { doc: this.store.doc, scene: this.scene, selections: this.selections });
        // Stage responses already contain a bounded, version-bound project selection.
        if (context.binding) return sendJson(res, 200, context);
        sendJson(res, 200, { ...context, project: { revision: this.store.appliedRevision,
          contentHash: this.store.doc.contentHash, tokens: this.store.doc.tokens,
          pages: this.scene.pages.map(p => ({ id: p.id, name: p.name, board: p.board })) } });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/media/prepare') {
        const body = await readJsonBody(req);
        if(body.async===true)return sendJson(res,200,await this.operations.start('media',body,this.store.doc));
        sendJson(res, 200, await prepareMedia({ ...body, projectDir: this.projectDir, tokens: this.store.doc.tokens }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/design/metrics') {
        const body = await readJsonBody(req);
        const pageId = body.pageId || this.scene.pages[0]?.id;
        const page = this.scene.pages.find(p => p.id === pageId);
        if (!page) return sendJson(res, 404, { ok: false, code: 'E_PAGE_NOT_FOUND', message: `页面不存在：${pageId}` });
        const { summarizeMetrics } = await import('./design-metrics.mjs');
        const result = await this.measureDesignMetrics(pageId, { thresholds: body.thresholds || undefined, pixelTruth: body.pixelTruth !== false });
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
      if (req.method === 'POST' && pathname === '/api/design/pixel-contrast') {
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
      if (req.method === 'POST' && pathname === '/api/design/explore') {
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
      if (req.method === 'GET' && pathname === '/api/design/reviews') {
        const dir = join(this.projectDir, 'design-reviews');
        const pageId = parsedUrl.searchParams.get('pageId');
        const records = existsSync(dir) ? readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
          .map(name => JSON.parse(readFileSync(join(dir, name))))
          .filter(r => r.nodeSnapshots && (!pageId || r.pageId === pageId))
          .sort((a, b) => b.revision - a.revision).slice(0, 20)
          .map(r => ({ reviewId: r.reviewId, pageId: r.pageId, revision: r.revision, contentHash: r.contentHash })) : [];
        return sendJson(res, 200, { ok: true, reviews: records });
      }
      const reviewImage = pathname.match(/^\/api\/design\/reviews\/([a-f0-9-]{36})\/image$/);
      if (req.method === 'GET' && reviewImage) {
        const path = join(this.projectDir, 'design-reviews', `${reviewImage[1]}.png`);
        if (!existsSync(path)) return sendJson(res, 404, { ok: false, code: 'E_REVIEW_NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(readFileSync(path)); return;
      }

      if (req.method === 'POST' && pathname === '/api/design/review') {
        sendJson(res, 200, await reviewDesign(this, await readJsonBody(req)));
        return;
      }
      if (req.method === 'POST' && pathname.startsWith('/api/runtime/')) {
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
      }

      // Export Native .rp
      if(req.method==='POST'&&pathname==='/api/operations'){
        const {action,...body}=await readJsonBody(req);
        if(!['get','list','cancel'].includes(action))throw Object.assign(new Error('action需要get/list/cancel'),{code:'E_OPERATION_ACTION'});
        return sendJson(res,200,await this.operations[action](body));
      }
      if (req.method === 'POST' && pathname === '/api/export-rp') {
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

      if (req.method === 'POST' && pathname === '/api/export-code') {
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

      if (req.method === 'POST' && pathname === '/api/sync-native') {
        const body = await readJsonBody(req);
        if (body.async === true) {
          return sendJson(res, 200, await this.operations.start('sync-native', body, this.store.doc));
        }
        const syncRes = await this.syncNative(body);
        sendJson(res, syncRes.ok === false ? 409 : 200, syncRes);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/project/bundle') {
        const body = await readJsonBody(req);
        const bundleRes = await this.projectBundle(body);
        sendJson(res, bundleRes.ok === false ? 400 : 200, bundleRes);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/project/merge') {
        const body = await readJsonBody(req);
        const mergeRes = await this.mergeDocument(body);
        sendJson(res, mergeRes.ok === false ? 409 : 200, mergeRes);
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
        diagnostic:this.store&&this.scene?errorDiagnostic(err,this):null,
        ...Object.fromEntries(['sourceSpan', 'line', 'column', 'snippet', 'nodeId', 'field', 'candidates', 'suggestion', 'currentRevision'].filter(key => err[key] !== undefined).map(key => [key, err[key]])),
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
