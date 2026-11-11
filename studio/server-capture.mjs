// CDP 截图与像素测量簇:从 server.mjs 原样搬移(this→server 参数化)。
// 全部截图共享同一个受管浏览器实例;临时涂装互斥由 withCapture 的串行队列保证。
// 公开入口经 StudioServer 上的同名一行委托调用,外部调用面不变。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from './document.mjs';
import { RENDERER_VERSION } from './scene-resolver.mjs';
import { launchChrome } from './cdp.mjs';
import { collectRenderedText, contrastTextNodes, measurePixelContrast } from './pixel-truth.mjs';
import { decodePng } from './png-decode.mjs';

export async function ensureManagedBrowserPage(server) {
    if (server.managedChrome && server.managedPage) {
      const procDead = Boolean(
        server.managedChrome.proc &&
        (server.managedChrome.proc.exitCode !== null || server.managedChrome.proc.signalCode !== null)
      );
      if (!procDead && !server.managedPage.closed) {
        try {
          const currentHref = await server.managedPage.evaluate('location.href').catch(() => '');
          if (currentHref.startsWith(server.url)) {
            return server.managedPage;
          }
          await server.managedPage.navigate(`${server.url}/?clientId=managed_renderer`);
          await server.managedPage.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__ >= 1)', 10000);
          return server.managedPage;
        } catch (err) {
          if (!server.ownsManagedChrome) throw err;
        }
      } else if (!server.ownsManagedChrome) {
        throw Object.assign(new Error('共享浏览器连接已关闭，无法执行截图渲染'), { code: 'E_RENDERER_CLOSED' });
      }
      if (server.ownsManagedChrome) {
        try { await server.managedChrome.close(); } catch {}
        server.managedChrome = null;
        server.managedPage = null;
      }
    }
    const chrome = await launchChrome({ headless: true, width: 1440, height: 1050, dpr: 2 });
    let page = null;
    try {
      page = await chrome.openPage(`${server.url}/?clientId=managed_renderer`);
      await page.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__ >= 1)', 10000);
    } catch (error) {
      const state = page
        ? await page.evaluate('({url:location.href,ready:document.readyState,app:!!window.__STUDIO_APP__,revision:window.__STUDIO_RENDERED_REVISION__})').catch(() => null)
        : null;
      const scriptErrors = page?.scriptErrors || [];
      try { await chrome.close(); } catch {}
      server.managedChrome = null;
      server.managedPage = null;
      throw Object.assign(new Error(`画布初始化未完成：${JSON.stringify({ state, errors: scriptErrors })}`), { code: 'E_RENDERER_STARTUP', stage: 'browser-initialization', cause: error });
    }
    server.managedChrome = chrome;
    server.managedPage = page;
    return server.managedPage;
  }

export async function waitForRenderedRevision(server, targetRevision = server.store.appliedRevision, { timeoutMs = 4000, simulateHang = false } = {}) {
    if (simulateHang) {
      await new Promise(r => setTimeout(r, timeoutMs + 20));
      throw Object.assign(
        new Error(`等待版本 rev ${targetRevision} 浏览器渲染超时 (${timeoutMs}ms)`),
        { code: 'E_RENDER_TIMEOUT', targetRevision, renderedRevision: server.renderedRevision }
      );
    }

    if (server.renderedRevision >= targetRevision && server.lastRenderConfirm?.contentHash === server.store.doc.contentHash) {
      return server.lastRenderConfirm;
    }

    // If no external SSE browser client is connected, or to guarantee immediate render confirmation, sync managed page
    const waitPromise = new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        server.renderWaiters = server.renderWaiters.filter(w => w.timer !== timer);
        rejectWait(
          Object.assign(
            new Error(`等待版本 rev ${targetRevision} 浏览器渲染超时 (${timeoutMs}ms)`),
            { code: 'E_RENDER_TIMEOUT', targetRevision, renderedRevision: server.renderedRevision }
          )
        );
      }, timeoutMs);
      server.renderWaiters.push({ targetRevision, timer, resolve: resolveWait, reject: rejectWait });
    });

    const syncManagedRenderer = () => {
      const expectedHash = server.store.doc.contentHash;
      server.ensureManagedBrowserPage()
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

    if (server.sseClients.size === 0) {
      syncManagedRenderer();
    } else {
      const fallbackTimer = setTimeout(() => {
        if (server.renderedRevision < targetRevision) syncManagedRenderer();
      }, 250);
      waitPromise.finally(() => clearTimeout(fallbackTimer)).catch(() => {});
    }

    return waitPromise;
  }


  // All captures share one managed browser. Temporary paint changes must not overlap.
export function withCapture(server, action) {
    const pending = (server.captureQueue || Promise.resolve()).then(action);
    server.captureQueue = pending.catch(() => {});
    return pending;
  }

export function capturePixelContrast(server, pageId, options = {}) {
    return server.withCapture(() => server._capturePixelContrast(pageId, options));
  }

export async function _capturePixelContrast(server, pageId, { dpr = 2 } = {}) {
    if (!Number.isFinite(dpr) || dpr < 0.5 || dpr > 4) {
      throw Object.assign(new Error('dpr 必须在 0.5–4 之间'), { code: 'E_PIXEL_DPR' });
    }
    const revision = server.store.appliedRevision, contentHash = server.store.doc.contentHash;
    const target = server.scene.pages.find(p => p.id === pageId);
    if (!target) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
    const candidates = contrastTextNodes(target);
    const page = await server.ensureManagedBrowserPage();
    let styleInstalled = false;
    try {
      await page.evaluate(`(() => {
        const style = document.createElement('style');
        style.id = 'studio-pixel-paint';
        style.textContent = '.studio-node, .studio-node * { animation-play-state:paused!important; transition:none!important; caret-color:transparent!important; }';
        document.head.append(style);
      })()`);
      styleInstalled = true;
      await server._captureScreenshot({ revision, pageId, dpr });
      await page.evaluate("document.body.classList.add('studio-capture')");
      const geometry = await page.evaluate(`(${collectRenderedText.toString()})(${JSON.stringify(pageId)}, ${JSON.stringify(candidates.map(n => ({ id: n.id, fontSize: n.fontSize, fontWeight: n.fontWeight })))})`);
      const { clip, boxes } = geometry;
      const missingIds = target.nodes.filter(n => n.assetMissing || (n.type === 'image' && n.src?.startsWith('assets/') && !existsSync(join(server.projectDir, n.src)))).map(n => n.id);
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
      if (revision !== server.store.appliedRevision || contentHash !== server.store.doc.contentHash) {
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

export async function measureDesignMetrics(server, pageId, { thresholds, pixelTruth = true } = {}) {
    const { computeDesignMetrics } = await import('./design-metrics.mjs');
    let pixelContrast = null, fallbackReason = null;
    if (!server.scene.pages.some(p => p.id === pageId)) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
    if (pixelTruth) {
      try { pixelContrast = (await server.capturePixelContrast(pageId)).results; }
      catch (err) { fallbackReason = `${err.code || 'E_PIXEL_CAPTURE'}: ${err.message}`; }
    }
    const result = computeDesignMetrics(server.scene.pages.find(p => p.id === pageId), {
      thresholds, doc: server.store.doc, pixelContrast,
    });
    if (fallbackReason) result.metrics.contrast.fallbackReason = fallbackReason;
    return { ...result, baseRevision: server.store.appliedRevision, contentHash: server.store.doc.contentHash };
  }

export function captureScreenshot(server, options = {}) {
    return server.withCapture(() => server._captureScreenshot(options));
  }

export async function _captureScreenshot(server, {
    revision = server.store.appliedRevision,
    pageId = null,
    nodeId = null,
    outPath = null,
    timeoutMs = 5000,
    simulateHang = false,
    includeImage = false,
    dpr = 2,
  } = {}) {
    if (revision > server.store.appliedRevision) {
      throw Object.assign(
        new Error(`请求的截图版本 rev ${revision} 大于当前最新文档版本 rev ${server.store.appliedRevision}`),
        { code: 'E_FUTURE_REVISION', requestedRevision: revision, currentRevision: server.store.appliedRevision }
      );
    }

    if (!simulateHang) {
      await server.ensureManagedBrowserPage();
    }
    await server.waitForRenderedRevision(revision, { timeoutMs, simulateHang });
    const page = await server.ensureManagedBrowserPage();

    // Ensure the managed page has rendered the exact requested revision and active page
    const targetPageId = pageId || server.store.doc.pages[0]?.id || 'home';
    const board = server.scene.pages.find(pg => pg.id === targetPageId)?.board;
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
      revision: server.store.appliedRevision,
      durableRevision: server.store.durableRevision,
      renderedRevision: renderCheck.renderedRevision,
      contentHash: server.store.doc.contentHash,
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
