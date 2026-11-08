import { indexScenePages, loadProjectFonts, projectFontsReady } from './fonts.mjs';
import { getActivePageScene, updateTopbarStatus } from './view.mjs';
import { buildNodeElementHtml, publishSelection, renderAll, renderSelectionOverlay, resetLastSelectionKey, tokenCss } from './render.mjs';
import { renderInspector } from './inspector.mjs';
import { cancelCanvasGesture } from './gestures.mjs';
import { state } from './state.mjs';

export async function applyServerSnapshot(payload) {
  const nextRevision = payload.appliedRevision ?? payload.scenePatch?.appliedRevision ?? payload.doc?.revision;
  const nextContentHash = payload.contentHash ?? payload.scenePatch?.contentHash ?? payload.doc?.contentHash;
  if (state.doc && payload.sessionId === state.sessionId && !payload.forceSync) {
    if (nextRevision < state.appliedRevision) return;
    if (nextRevision === state.appliedRevision && nextContentHash === state.doc.contentHash) {
      state.durableRevision = Math.max(state.durableRevision, payload.durableRevision ?? nextRevision);
      if (Array.isArray(payload.recentHistory)) state.recentHistory = payload.recentHistory;
      updateTopbarStatus();
      return;
    }
  }
  if (!payload.doc && payload.scenePatch) {
    if (!state.doc || !state.scene || state.appliedRevision !== payload.scenePatch.baseRevision) {
      const fullRes = await fetch('/api/context');
      if (fullRes.ok) {
        await applyServerSnapshot(await fullRes.json());
      }
      return;
    }
  }
  const previousTokenStyles = tokenCss();
  const interruptedGesture = cancelCanvasGesture({ render: false });
  state.sessionId = payload.sessionId || state.sessionId;
  if (payload.doc && payload.scene && !payload.scenePatch) {
    state.doc = payload.doc;
    state.scene = payload.scene;
    indexScenePages(state.scene);
  } else if (payload.scenePatch) {
    if (payload.doc) state.doc = payload.doc;
    const patch = payload.scenePatch;
    state.doc.revision = patch.appliedRevision;
    state.doc.contentHash = patch.contentHash;
    state.scene.revision = patch.appliedRevision;
    state.scene.contentHash = patch.contentHash;
    if (patch.fontDiagnostics) state.scene.fontDiagnostics = patch.fontDiagnostics;
    if (patch.clipDiagnostics) state.scene.clipDiagnostics = patch.clipDiagnostics;
    if (patch.assetDiagnostics) state.scene.assetDiagnostics = patch.assetDiagnostics;
    for (const [pgId, patchedNodes] of Object.entries(patch.patchedNodesByPage || {})) {
      const pg = state.scene.pages.find(p => p.id === pgId);
      if (!pg) continue;
      if (!pg._nodeMap || !pg._indexByScopedId) {
        pg._nodeMap = new Map(pg.nodes.map(n => [n.scopedId, n]));
        pg._indexByScopedId = new Map(pg.nodes.map((n, i) => [n.scopedId, i]));
      }
      for (const pn of patchedNodes) {
        const idx = pg._indexByScopedId.get(pn.scopedId);
        if (idx !== undefined) {
          pg.nodes[idx] = pn;
        } else {
          pg._indexByScopedId.set(pn.scopedId, pg.nodes.length);
          pg.nodes.push(pn);
        }
        pg._nodeMap.set(pn.scopedId, pn);
      }
    }
  }
  state.appliedRevision = nextRevision;
  state.projectDir = payload.projectDir || state.projectDir;
  loadProjectFonts(state.doc.fonts, state.projectDir);
  state.durableRevision = payload.durableRevision ?? nextRevision;
  if (payload.transitiveImpact) state.lastImpact = payload.transitiveImpact;
  if (payload.semanticDiff) state.lastSemanticDiff = payload.semanticDiff;
  if (payload.humanReadableSummary) state.lastSummary = payload.humanReadableSummary;
  if (Array.isArray(payload.recentHistory)) {
    state.recentHistory = payload.recentHistory;
  } else if (payload.txId && payload.transitiveImpact) {
    state.recentHistory = [
      {
        txId: payload.txId,
        revision: payload.appliedRevision,
        label: payload.label || payload.humanReadableSummary?.whatChanged || '改稿事务',
        affectedPageIds: payload.transitiveImpact?.affectedPageIds || [],
        affectedNodeCount: payload.affectedNodeIds?.length || 0,
        directTargetCount: payload.transitiveImpact?.directTargetNodeIds?.length || 0,
        ancestorCount: payload.transitiveImpact?.affectedAncestorIds?.length || 0,
        shiftedCount: payload.transitiveImpact?.shiftedSiblingAndDescendantIds?.length || 0,
        componentInstanceCount: payload.transitiveImpact?.affectedComponentInstanceIds?.length || 0,
        tokenConsumerCount: payload.transitiveImpact?.affectedTokenConsumerIds?.length || 0,
        humanReadableSummary: payload.humanReadableSummary || null,
      },
      ...(state.recentHistory || []).filter(h => h.txId !== payload.txId).slice(0, 9),
    ];
  }

  if (!state.activePageId || !state.doc.pages.some(p => p.id === state.activePageId)) {
    state.activePageId = state.doc.pages[0]?.id || null;
  }

  // Filter selectedIds that still exist in active page
  const activePageScene = getActivePageScene();
  if (activePageScene && state.selectedIds.length > 0) {
    const existingIds = new Set(activePageScene.nodes.map(n => n.id));
    state.selectedIds = state.selectedIds.filter(id => existingIds.has(id));
  }

  let patchedFast = false;
  let hasPatchedImage = false;
  if (
    state.mode === 'design' &&
    previousTokenStyles === tokenCss() &&
    !interruptedGesture &&
    state.renderedRevision > 0 &&
    !payload.forceSync &&
    Array.isArray(payload.affectedNodeIds) &&
    payload.affectedNodeIds.length > 0 &&
    payload.affectedNodeIds.length <= 120 &&
    activePageScene
  ) {
    const screenRoot = document.getElementById('screen-root');
    if (screenRoot && screenRoot.getAttribute('data-page-id') === activePageScene.id) {
      const nodeMap = activePageScene._nodeMap || (activePageScene._nodeMap = new Map(activePageScene.nodes.map(n => [n.scopedId, n])));
      let allFound = true;
      const toPatch = [];
      for (const scopedId of payload.affectedNodeIds) {
        if (String(scopedId).startsWith('component:') || String(scopedId).startsWith('token:')) {
          allFound = false;
          break;
        }
        const [pgPrefix] = String(scopedId).split('/');
        if (pgPrefix && pgPrefix !== activePageScene.id) {
          continue;
        }
        const n = nodeMap.get(scopedId);
        if (n && n.type === 'phone-shell') {
          continue;
        }
        const el = screenRoot.querySelector(`.studio-node[data-scoped-id="${CSS.escape(scopedId)}"]`);
        if (n && !n.visible && !el) {
          continue;
        }
        if (!n || !el || n.type === 'dynamic-panel' || n.type === 'repeater' || n.repeaterTemplateOwner) {
          allFound = false;
          break;
        }
        const directDomChildren = el.querySelectorAll(':scope > .studio-node').length;
        const expectedChildren = Array.isArray(n.childrenIds)
          ? n.childrenIds.filter(cid => nodeMap.get(cid)?.visible).length
          : 0;
        if (directDomChildren !== expectedChildren) {
          allFound = false;
          break;
        }
        if (n.type === 'image') hasPatchedImage = true;
        toPatch.push({ n, el });
      }
      if (allFound && toPatch.length > 0) {
        for (const { n, el } of toPatch) {
          const rawParent = n.parentScopedId ? nodeMap.get(n.parentScopedId) : null;
          const parent = rawParent && rawParent.type !== 'phone-shell' ? rawParent : null;
          const visibleChildrenCount = Array.isArray(n.childrenIds)
            ? n.childrenIds.filter(cid => nodeMap.get(cid)?.visible).length
            : 0;
          if (visibleChildrenCount > 0) {
            const tmp = document.createElement('div');
            tmp.innerHTML = buildNodeElementHtml(n, activePageScene.id, '', parent);
            const nextEl = tmp.firstElementChild;
            if (nextEl) {
              el.setAttribute('style', nextEl.getAttribute('style') || '');
            }
          } else {
            const curEl = screenRoot.querySelector(`.studio-node[data-scoped-id="${CSS.escape(n.scopedId)}"]`) || el;
            const html = buildNodeElementHtml(n, activePageScene.id, '', parent);
            if (html) {
              curEl.outerHTML = html;
            } else {
              curEl.remove();
            }
          }
        }
        renderSelectionOverlay();
        renderInspector();
        updateTopbarStatus();
        patchedFast = true;
      }
    }
  }

  window.__STUDIO_LAST_PATCH_MODE__ = patchedFast ? 'incremental-dom-patch' : 'full-render';
  if (!patchedFast) {
    renderAll();
  }
  publishSelection();
  await confirmRevisionRendered(state.appliedRevision, state.doc.contentHash, {
    incrementalNoImages: patchedFast && !hasPatchedImage,
  });
}

export async function confirmRevisionRendered(revision, contentHash, { incrementalNoImages = false } = {}) {
  try {
    const fontsForRender = projectFontsReady;
    await fontsForRender;
    if (fontsForRender !== projectFontsReady) return;
    if (document.fonts && document.fonts.ready && (!incrementalNoImages || document.fonts.status !== 'loaded')) {
      await document.fonts.ready;
    }
    if (!incrementalNoImages) {
      const imgs = [...document.querySelectorAll('#canvas-stage img')];
      await Promise.all(
        imgs.map(img => {
          if (img.complete) return Promise.resolve();
          return new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 1500);
          });
        })
      );
      void document.body.offsetHeight;
      await Promise.race([
        new Promise(r => requestAnimationFrame(r)),
        new Promise(r => setTimeout(r, 16)),
      ]);
    } else {
      void document.body.offsetHeight;
    }

    if (revision !== state.appliedRevision || state.doc?.contentHash !== contentHash) return;
    state.renderedRevision = revision;
    window.__STUDIO_RENDERED_REVISION__ = state.renderedRevision;
    window.__STUDIO_RENDERED_HASH__ = contentHash;
    updateTopbarStatus();

    await fetch('/api/render-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: state.clientId,
        sessionId: state.sessionId,
        renderedRevision: state.renderedRevision,
        contentHash,
        fontErrors: state.projectFontErrors || [],
      }),
    });
  } catch {
    // Ignore transient network errors during render confirmation
  }
}

export function connectSseStream() {
  if (state.sse) {
    try { state.sse.close(); } catch {}
    state.sse = null;
  }
  // 浏览器对同一 host:port 只允许约 6 条并发 HTTP/1.1 连接；若每个标签页各持一条
  // EventSource 长连接，多开画布后连接池被占满，后续请求（含图片加载）会永久排队。
  // 因此仅前台标签页持有 SSE，后台标签页走下方 1.5s 轮询兜底，切回前台时恢复。
  if (document.hidden) {
    return;
  }
  openSseStream();
}

export function openSseStream() {
  const es = new EventSource(`/api/events?clientId=${encodeURIComponent(state.clientId)}`);
  state.sse = es;

  es.onopen = () => {
    state.connected = true;
    resetLastSelectionKey();
    publishSelection();
    updateTopbarStatus();
  };

  es.onmessage = async ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot' || msg.type === 'revision') {
        state.connected = true;
        if (msg.appliedRevision > state.appliedRevision || !state.doc || msg.forceSync) {
          await applyServerSnapshot(msg);
        } else {
          state.durableRevision = Math.max(state.durableRevision, msg.durableRevision || 0);
          updateTopbarStatus();
        }
      }
    } catch {
      // Ignore malformed event
    }
  };

  es.onerror = () => {
    state.connected = false;
    updateTopbarStatus();
  };
}

// Reconnect & sync polling guard if SSE drops
setInterval(async () => {
  try {
    const res = await fetch('/api/context');
    if (res.ok) {
      const data = await res.json();
      const wasDisconnected = !state.connected;
      state.connected = true;
      if (!state.sse && !wasDisconnected) connectSseStream(); // 原 SSE 持有页关闭后，由本兜底轮询尝试接管（拿不到锁则继续静默轮询）
      if (wasDisconnected || data.appliedRevision !== state.appliedRevision || data.sessionId !== state.sessionId) {
        await applyServerSnapshot(data);
        if (wasDisconnected) connectSseStream();
      }
    } else {
      state.connected = false;
      updateTopbarStatus();
    }
  } catch {
    state.connected = false;
    updateTopbarStatus();
  }
}, 1500);
