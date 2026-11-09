// 画布入口:装配各子系统并暴露 window.__STUDIO_APP__(CDP 截图/命中测试外部契约)。
import { createEditorRequests } from './api.mjs';
import { applyServerSnapshot as syncSnapshot, createSnapshotStream } from './sync.mjs';
import { createCanvasRenderer, renderSelectionOverlay } from './render.mjs';
import { clearCanvasGesture, commitInlineTextEditor as commitText, openInlineTextEditor, setupCanvasInteractions } from './gestures.mjs';
import { renderInspector as paintInspector } from './inspector.mjs';
import { renderSidebar as paintSidebar } from './sidebar.mjs';
import { focusDiagnosticTarget as locateDiagnosticTarget, showProjectOperations, showProjectVersions } from './dialogs.mjs';
import { setupToolbarAndTabs } from './toolbar.mjs';
import { updateTopbarStatus } from './view.mjs';
import { state } from './state.mjs';

const { apiPost, dispatchCommands, dispatchHistoryAction, waitForCommands, publishSelection, resetLastSelectionKey } =
  createEditorRequests({ applyServerSnapshot, onRequestError: renderInspector });
const { renderCanvasStage, updateCanvasTransform, fitWorkspace, revealActiveArtboard } = createCanvasRenderer({
  async onRuntimeInput(targetId, value) {
    const result = await apiPost('/api/runtime/input', { targetId, value });
    state.runtimeState = result.state;
    renderInspector();
  },
  async onRuntimeRowSelect(dataset, rowId) {
    const result = await apiPost('/api/runtime/dataset', { op: 'select', dataset, rowId });
    state.runtimeState = result.state;
    renderRuntimePreview();
  },
});

const inspectorActions = {
  dispatchCommands,
  renderAll,
  async resetRuntimePreview() {
    const result = await apiPost('/api/runtime/reset', { startPageId: state.activePageId });
    state.runtimeState = result.state;
    renderRuntimePreview();
  },
};
const sidebarActions = { dispatchCommands, fitWorkspace, renderAll, renderSelection, selectPage };
const snapshotEffects = { cancelCanvasGesture, renderAll, renderInspector, publishSelection };
const connectSseStream = createSnapshotStream({
  applyServerSnapshot,
  onReconnect() {
    resetLastSelectionKey();
    publishSelection();
  },
});

function applyServerSnapshot(payload) {
  return syncSnapshot(payload, snapshotEffects);
}

async function refreshSnapshot() {
  const response = await fetch('/api/context');
  if (response.ok) await applyServerSnapshot(await response.json());
}

function cancelCanvasGesture({ render = true } = {}) {
  const cleared = clearCanvasGesture();
  if (cleared && render) renderAll();
  return cleared;
}

function commitInlineTextEditor(cancel = false) {
  return commitText(dispatchCommands, cancel);
}

function renderInspector() {
  paintInspector(inspectorActions);
}

function renderSidebar() {
  paintSidebar(sidebarActions);
}

function renderSelection() {
  renderSidebar();
  renderSelectionOverlay();
  renderInspector();
}

function renderAll() {
  updateTopbarStatus();
  renderCanvasStage();
  renderSidebar();
  renderInspector();
  renderSelectionOverlay();
  publishSelection();
}

function renderRuntimePreview() {
  renderCanvasStage();
  renderInspector();
}

async function onRuntimeClick(targetId) {
  const result = await apiPost('/api/runtime/click', { targetId });
  state.runtimeState = result.state;
  state.activePageId = result.state.currentPageId;
  renderRuntimePreview();
}

async function selectPage(pageId) {
  cancelCanvasGesture({ render: false });
  state.activePageId = pageId;
  state.selectedIds = [];
  if (state.mode === 'interact') {
    try {
      const result = await apiPost('/api/runtime/navigate', { pageId });
      state.runtimeState = result.state;
    } catch {}
  }
  renderAll();
  revealActiveArtboard();
}

function focusDiagnosticTarget(location, binding) {
  return locateDiagnosticTarget(location, binding, { renderAll, updateCanvasTransform });
}

async function bootstrap() {
  setupCanvasInteractions({
    cancelCanvasGesture, commitInlineTextEditor, dispatchCommands, dispatchHistoryAction, onRuntimeClick,
    refreshSnapshot, renderAll, renderCanvasStage, renderSelection, revealActiveArtboard, updateCanvasTransform,
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.spacePressed = false;
      cancelCanvasGesture();
      connectSseStream(); // 隐藏时释放 SSE 长连接
    } else if (!state.sse) {
      connectSseStream();
    }
  });
  setupToolbarAndTabs({
    apiPost, dispatchCommands, dispatchHistoryAction, waitForCommands,
    fitWorkspace, renderAll, renderInspector, renderSidebar, updateCanvasTransform, focusDiagnosticTarget,
    showProjectOperations: () => showProjectOperations({ apiPost, focusDiagnosticTarget }),
    showProjectVersions: () => showProjectVersions({ apiPost, applyServerSnapshot }),
  });
  const res = await fetch('/api/context');
  const data = await res.json();
  state.connected = true;
  await applyServerSnapshot(data);
  connectSseStream();
  fitWorkspace(true);
}

window.__STUDIO_APP__ = {
  state,
  applyServerSnapshot,
  renderAll,
  dispatchCommands,
  openInlineTextEditor,
  commitInlineTextEditor,
  setPanZoom(panX, panY, zoom) {
    state.panX = panX;
    state.panY = panY;
    state.zoom = zoom;
    updateCanvasTransform();
  },
  selectNodes(ids, pageId = null) {
    cancelCanvasGesture({ render: false });
    if (pageId) state.activePageId = pageId;
    state.selectedIds = Array.isArray(ids) ? ids : [ids];
    renderAll();
  },
};

bootstrap();

// 保持原 app.js 的模块导出面(showToast/dispatchCommands 曾为入口导出)。
export { showToast } from './ui.mjs';
export { dispatchCommands };
