// 浏览器端共享可变单例与截图/断言契约( window.__STUDIO_* 名称为 server CDP 层与浏览器系测试的外部契约,不可改名)。
export const state = {
  clientId: `web_${Math.random().toString(36).slice(2, 10)}`,
  sessionId: null,
  connected: false,
  mode: 'design', // 'design' | 'interact' | 'explore'
  sidebarTab: 'pages',
  doc: null,
  scene: null,
  runtimeState: null,
  appliedRevision: 0,
  durableRevision: 0,
  renderedRevision: 0,
  activePageId: null,
  selectedIds: [], // node IDs in activePageId
  clipboardNodes: [],
  clipboardPending: null,
  zoom: 1,
  panX: 40,
  panY: 40,
  dragSession: null,
  snapGuides: [],
  altPressed: false,
  measureTarget: null,
  isComposing: false,
  editingNodeId: null,
  spacePressed: false,
  showAllLayers: false,
  pagesExpanded: false,
  layerFilter: '',
  showStatusArea: false,
  tool: 'select',
  inspectorAll: false,
  inspectorExpanded: new Set(),
  showHistory: false,
  sse: null,
  lastError: null,
};

window.__STUDIO_RENDERED_REVISION__ = 0;

window.__STUDIO_RENDERED_HASH__ = '';

window.__STUDIO_STATE__ = state;

window.__STUDIO_LAST_TOAST__ = null;
