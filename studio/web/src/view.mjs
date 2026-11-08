import { renderSelectionOverlay, scheduleBoardMounts } from './render.mjs';
import { state } from './state.mjs';

export function getActivePageScene() {
  if (!state.scene || !Array.isArray(state.scene.pages)) return null;
  return state.scene.pages.find(p => p.id === state.activePageId) || state.scene.pages[0] || null;
}

export function selectedRootNodes(page = getActivePageScene()) {
  if (!page) return [];
  const nodes = state.selectedIds.map(id => page.nodes.find(node => node.id === id)).filter(Boolean);
  const selected = new Set(nodes.map(node => node.scopedId));
  const byScope = new Map(page.nodes.map(node => [node.scopedId, node]));
  return nodes.filter(node => {
    let parent = node.parentScopedId;
    while (parent) {
      if (selected.has(parent)) return false;
      parent = byScope.get(parent)?.parentScopedId;
    }
    return true;
  });
}

export function layerDisplayName(node, page = getActivePageScene()) {
  if (node.name && node.name !== node.id) return node.name;
  if (node.id === `${page?.id}_screen`) return `${page.name}画板`;
  if (node.type === 'box' && !node.childrenIds?.length && node.x === 0 && node.y === 0 && node.w === page?.board.screenW && node.h === page?.board.screenH) return '页面背景';
  const text = String(node.rawText ?? node.text ?? '').trim();
  if (text && !text.startsWith('=') && ['label', 'paragraph', 'button'].includes(node.type)) return text;
  return ({ box: '容器', image: '图片', label: '文字', paragraph: '段落', button: '按钮', input: '输入框',
    'dynamic-panel': '动态面板', repeater: '数据列表', instance: '组件实例' })[node.type] || node.name || node.id;
}

export function fitWorkspace(overview = false) {
  const viewport = document.getElementById('canvas-viewport');
  const page = getActivePageScene();
  if (!viewport || !page) return;
  const {left,top,width,height} = workspaceBounds();
  const pages = overview && state.mode !== 'interact' ? state.scene.pages : [page];
  const bounds = pages.map(pg => ({x:state.mode === 'interact' ? 60 : pg._stageX ?? 60,y:state.mode === 'interact' ? 40 : pg._stageY ?? 40,w:pg.board.totalW,h:pg.board.totalH}));
  const stageX = Math.min(...bounds.map(b=>b.x)), stageY = Math.min(...bounds.map(b=>b.y));
  const spread = Math.max(...bounds.map(b=>b.x+b.w))-stageX;
  const tall = Math.max(...bounds.map(b=>b.y+b.h))-stageY;
  const zoom = Math.max(0.01, Math.min(1.5, width / spread, height / tall));
  state.zoom = zoom;
  state.panX = Math.round(left + (width - spread * zoom) / 2 - stageX * zoom);
  state.panY = Math.round(top + (height - tall * zoom) / 2 - stageY * zoom);
  updateCanvasTransform();
}

export function workspaceBounds() {
  const viewport = document.getElementById('canvas-viewport'), vp = viewport.getBoundingClientRect();
  const panel = id => { const el=document.getElementById(id); return el?.getClientRects().length ? el.getBoundingClientRect() : null; };
  const sidebar=panel('left-sidebar'), inspector=panel('inspector-shell'), topbar=panel('topbar');
  const left=sidebar ? Math.max(20,sidebar.right-vp.left+20) : 20;
  const right=inspector ? Math.min(vp.width-20,inspector.left-vp.left-20) : vp.width-20;
  const top=topbar ? Math.max(40,topbar.bottom-vp.top+40) : 40;
  return {left,top,width:Math.max(40,right-left),height:Math.max(40,vp.height-top-108)};
}

// 切页后把当前页画板滚入视口：按画板真实 DOM 矩形判定（不依赖 _stageX/board 缓存，P02），
// 仅当画板未完整落在可操作区域内时平移居中（保持缩放不变）。
export function revealActiveArtboard() {
  const viewport = document.getElementById('canvas-viewport');
  const page = getActivePageScene();
  if (!viewport || !page || state.mode === 'interact') return;
  const wrapper = document.querySelector(`.artboard-wrapper[data-artboard-id="${CSS.escape(page.id)}"]`);
  const target = wrapper?.querySelector('.artboard-screen') || document.getElementById('screen-root');
  if (!target) return;
  const vpRect = viewport.getBoundingClientRect();
  const {left,top,width:vpW,height:vpH} = workspaceBounds();
  if (vpW <= 40 || vpH <= 40) return;
  const r = target.getBoundingClientRect();
  if (![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) return;
  if (r.width > vpW || r.height > vpH) { fitWorkspace(); return; }
  const visL = vpRect.left + left, visT = vpRect.top + top;
  if (r.left >= visL && r.top >= visT && r.right <= visL + vpW && r.bottom <= visT + vpH) return;
  state.panX += Math.round(visL + vpW / 2 - (r.left + r.width / 2));
  state.panY += Math.round(visT + vpH / 2 - (r.top + r.height / 2));
  updateCanvasTransform();
}

// padding 归一化为 [top, right, bottom, left]（与 scene-resolver parsePadding 语义一致）
export function padList(pad) {
  if (pad === undefined || pad === null) return [0, 0, 0, 0];
  if (typeof pad === 'number') return [pad, pad, pad, pad];
  if (Array.isArray(pad)) {
    if (pad.length === 1) return [pad[0], pad[0], pad[0], pad[0]];
    if (pad.length === 2) return [pad[0], pad[1], pad[0], pad[1]];
    if (pad.length === 4) return pad;
  }
  return [0, 0, 0, 0];
}

// 拖拽释放点命中的重挂目标容器：容器类型、非自身/后代、非当前父级，整屏背景画板除外
export function findDropContainer(pg, draggedId, cx, cy) {
  if (!pg) return null;
  const current = pg.nodes.find(n => n.id === draggedId);
  if (!current) return null;
  const isAncestorOf = (node, rootId) => {
    let cur = node;
    while (cur) {
      if (cur.id === rootId) return true;
      cur = pg.nodes.find(n => n.id === cur.parentId);
    }
    return false;
  };
  for (let i = pg.nodes.length - 1; i >= 0; i--) {
    const n = pg.nodes[i];
    if (!['box', 'card', 'phone-shell'].includes(n.type) || n.locked) continue;
    if (n.id === draggedId || n.id === current.parentId) continue;
    if (isAncestorOf(n, draggedId)) continue;
    // 整屏背景容器（与框选跳过口径一致）不作为拖拽重挂目标
    if (n.depth <= 1 && n.w >= (pg.board.screenW || 402) - 4 && n.h >= (pg.board.screenH || 874) - 4) continue;
    if (cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h) return n;
  }
  return null;
}

export function updateWorkspaceChrome() {
  document.body.classList.toggle('mode-interact', state.mode === 'interact');
  const page = getActivePageScene();
  const selId = state.selectedIds[0];
  const node = selId
    ? (page?._nodeMap?.get(`${page.id}/${selId}`) || page?.nodes.find(n => n.id === selId))
    : null;
  const values = { 'inspector-selection': node ? layerDisplayName(node, page) : '画板设置', 'page-count': `${state.doc?.pages.length || 0} 个页面` };
  for (const [id, text] of Object.entries(values)) {
    const element = document.getElementById(id);
    if (element) { element.textContent = text; element.title = text; }
  }
  document.querySelectorAll('[data-tool]').forEach(button => {
    const active = button.dataset.tool === state.tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)));
  document.querySelectorAll('.sidebar-tab').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tab === state.sidebarTab)));
  const search = document.getElementById('tree-search');
  if (search) search.hidden = state.sidebarTab !== 'pages';
  const viewport = document.getElementById('canvas-viewport');
  if (viewport) viewport.style.cursor = state.spacePressed || state.tool === 'pan' ? 'grab' : 'default';
}

export function updateTopbarStatus() {
  const titleEl = document.getElementById('project-title');
  if (titleEl && state.doc) {
    titleEl.textContent = state.doc.name || state.doc.documentId;
    titleEl.title = titleEl.textContent;
  }
  const dot = document.getElementById('conn-dot');
  if (dot) {
    dot.className = state.connected ? 'status-dot' : 'status-dot disconnected';
  }
  const revEl = document.getElementById('rev-readout');
  if (revEl) {
    const connText = state.connected ? '' : ' · 离线重连中';
    revEl.textContent = `rev ${state.appliedRevision} / dur ${state.durableRevision} / ren ${state.renderedRevision}${connText}`;
    document.getElementById('status-pill').title = revEl.textContent;
  }
  const saved = document.getElementById('save-status');
  if (saved) saved.textContent = !state.connected ? '连接已断开' : state.appliedRevision === state.durableRevision ? '已保存' : '正在保存';
  const zoomEl = document.getElementById('zoom-label');
  if (zoomEl) {
    zoomEl.textContent = `${Math.round(state.zoom * 100)}%`;
  }
  updateWorkspaceChrome();
}

export function updateCanvasTransform() {
  const stage = document.getElementById('canvas-stage');
  const dpr = window.devicePixelRatio || 1;
  state.panX = Math.round(state.panX*dpr)/dpr;
  state.panY = Math.round(state.panY*dpr)/dpr;
  if (stage) {
    stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  }
  if (state.selectedIds.length > 0 || state.snapGuides.length > 0) {
    renderSelectionOverlay();
  } else {
    const overlay = document.getElementById('selection-overlay');
    if (overlay && overlay.firstChild) overlay.innerHTML = '';
  }
  const zoomEl = document.getElementById('zoom-label');
  if (zoomEl) {
    zoomEl.textContent = `${Math.round(state.zoom * 100)}%`;
  }
  scheduleBoardMounts();
}

export function nodeViewportBounds(node) {
  const el = document.querySelector(`.studio-node[data-scoped-id="${CSS.escape(node.scopedId)}"]`);
  const viewport = document.getElementById('canvas-viewport');
  if (!el || !viewport) return null;
  const rect = el.getBoundingClientRect();
  const vp = viewport.getBoundingClientRect();
  return { x: rect.left - vp.left, y: rect.top - vp.top, w: rect.width, h: rect.height };
}
