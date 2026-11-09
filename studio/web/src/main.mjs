// 画布入口:装配各子系统并暴露 window.__STUDIO_APP__(CDP 截图/命中测试外部契约)。
import { dispatchCommands } from './api.mjs';
import { applyServerSnapshot, connectSseStream } from './sync.mjs';
import { fitWorkspace, renderAll, updateCanvasTransform } from './render.mjs';
import { cancelCanvasGesture, commitInlineTextEditor, openInlineTextEditor, setupCanvasInteractions } from './gestures.mjs';
import { setupToolbarAndTabs } from './toolbar.mjs';
import { state } from './state.mjs';

async function bootstrap() {
  setupCanvasInteractions();
  setupToolbarAndTabs();
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
export { dispatchCommands } from './api.mjs';
