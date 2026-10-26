import { visualCss, normalizeVisualCss } from '/visual-style.mjs';

const state = {
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
  zoom: 1,
  panX: 40,
  panY: 40,
  dragSession: null,
  snapGuides: [],
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

let toastTimer = null;
export function showToast(message, tone = 'info', durationMs = 3800) {
  window.__STUDIO_LAST_TOAST__ = { message, tone, timestamp: Date.now() };
  const el = document.getElementById('studio-toast');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  el.style.borderColor = tone === 'error' ? '#e05252' : tone === 'warn' ? '#e5a93c' : '#3b9b78';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.display = 'none';
  }, durationMs);
}

function renderIconSvg(iconName, color = '#203B32', size = 18) {
  const s = Math.max(12, Math.min(32, Number(size) || 18));
  const stroke = escapeHtml(color || '#203B32');
  const key = String(iconName || '').toLowerCase();
  let inner = '';
  if (key.includes('search')) {
    inner = `<circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />`;
  } else if (key === 'home' || key.includes('house')) {
    inner = `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />`;
  } else if (key.includes('layers') || key.includes('stack')) {
    inner = `<polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />`;
  } else if (key.includes('arrow-up-right') || key.includes('external')) {
    inner = `<line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" />`;
  } else if (key.includes('camera')) {
    inner = `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" />`;
  } else if (key.includes('spark') || key.includes('star')) {
    inner = `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />`;
  } else if (key.includes('compass') || key.includes('explore')) {
    inner = `<circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />`;
  } else if (key.includes('book') || key.includes('journal')) {
    inner = `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />`;
  } else if (key.includes('user') || key === 'me') {
    inner = `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />`;
  } else if (key.includes('map') || key.includes('pin') || key.includes('spot')) {
    inner = `<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />`;
  } else if (key.includes('heart') || key.includes('fav')) {
    inner = `<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />`;
  } else if (key.includes('plus') || key.includes('add')) {
    inner = `<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />`;
  } else if (key.includes('check')) {
    inner = `<polyline points="20 6 9 17 4 12" />`;
  } else if (key.includes('chevron-left') || key.includes('back')) {
    inner = `<polyline points="15 18 9 12 15 6" />`;
  } else if (key.includes('chevron-right') || key.includes('next')) {
    inner = `<polyline points="9 18 15 12 9 6" />`;
  } else {
    inner = `<circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="${stroke}" />`;
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;">${inner}</svg>`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    state.lastError = data;
    renderInspector();
    throw Object.assign(new Error(data.message || 'API Error'), { data });
  }
  state.lastError = null;
  return data;
}

export async function dispatchCommands(commands, { idempotencyKey = null, baseRevision = null } = {}) {
  const cmdList = Array.isArray(commands) ? commands : [commands];
  const rev = baseRevision !== null ? baseRevision : state.appliedRevision;
  const idem = idempotencyKey || `${state.clientId}_${rev}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const res = await apiPost('/api/commands', {
    clientId: state.clientId,
    source: 'human-web',
    baseRevision: rev,
    idempotencyKey: idem,
    commands: cmdList,
  });
  if (res.doc && res.scene) {
    await applyServerSnapshot(res);
  }
  return res;
}

async function applyServerSnapshot(payload) {
  state.sessionId = payload.sessionId || state.sessionId;
  state.doc = payload.doc;
  state.scene = payload.scene;
  state.appliedRevision = payload.appliedRevision ?? payload.doc.revision;
  state.durableRevision = payload.durableRevision ?? payload.doc.revision;
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
  if (activePageScene) {
    const existingIds = new Set(activePageScene.nodes.map(n => n.id));
    state.selectedIds = state.selectedIds.filter(id => existingIds.has(id));
  }

  let patchedFast = false;
  if (
    state.mode === 'design' &&
    state.renderedRevision > 0 &&
    !payload.forceSync &&
    Array.isArray(payload.affectedNodeIds) &&
    payload.affectedNodeIds.length > 0 &&
    payload.affectedNodeIds.length <= 120 &&
    activePageScene
  ) {
    const screenRoot = document.getElementById('screen-root');
    if (screenRoot && screenRoot.getAttribute('data-page-id') === activePageScene.id) {
      const nodeMap = new Map(activePageScene.nodes.map(n => [n.scopedId, n]));
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
        if (!n || !el || n.type === 'dynamic-panel' || n.type === 'repeater') {
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
        toPatch.push({ n, el });
      }
      if (allFound && toPatch.length > 0) {
        for (const { n, el } of toPatch) {
          const parent = activePageScene.nodes.find(p => p.scopedId === n.parentScopedId && p.type !== 'phone-shell');
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
  await confirmRevisionRendered(state.appliedRevision, state.doc.contentHash);
}

async function confirmRevisionRendered(revision, contentHash) {
  try {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
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
      }),
    });
  } catch {
    // Ignore transient network errors during render confirmation
  }
}

function getActivePageScene() {
  if (!state.scene || !Array.isArray(state.scene.pages)) return null;
  return state.scene.pages.find(p => p.id === state.activePageId) || state.scene.pages[0] || null;
}

function uiIcon(name) {
  return `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="#ui-${escapeHtml(name)}"></use></svg>`;
}

function layerDisplayName(node, page = getActivePageScene()) {
  if (node.name && node.name !== node.id) return node.name;
  if (node.id === `${page?.id}_screen`) return `${page.name}画板`;
  if (node.type === 'box' && !node.childrenIds?.length && node.x === 0 && node.y === 0 && node.w === page?.board.screenW && node.h === page?.board.screenH) return '页面背景';
  const text = String(node.rawText ?? node.text ?? '').trim();
  if (text && !text.startsWith('=') && ['label', 'paragraph', 'button'].includes(node.type)) return text;
  return ({ box: '容器', image: '图片', label: '文字', paragraph: '段落', button: '按钮', input: '输入框',
    'dynamic-panel': '动态面板', repeater: '数据列表', instance: '组件实例' })[node.type] || node.name || node.id;
}

function fitWorkspace(overview = false) {
  const viewport = document.getElementById('canvas-viewport');
  const page = getActivePageScene();
  if (!viewport || !page) return;
  const left = document.getElementById('left-sidebar').offsetWidth + 40;
  const right = document.getElementById('inspector-shell').offsetWidth + 40;
  const top = 110, bottom = 108;
  const count = overview ? Math.min(2, state.scene.pages.length) : 1;
  const spread = page.board.totalW * count + 80 * (count - 1);
  const width = Math.max(180, viewport.clientWidth - left - right);
  const height = Math.max(200, viewport.clientHeight - top - bottom);
  const zoom = Math.max(0.25, Math.min(1.5, width / spread, height / page.board.totalH));
  state.zoom = zoom;
  const stageX = state.mode === 'interact' ? 60 : page._stageX ?? 60;
  const stageY = state.mode === 'interact' ? 40 : page._stageY ?? 40;
  state.panX = Math.round(left + (width - spread * zoom) / 2 - stageX * zoom);
  state.panY = Math.round(top + (height - page.board.totalH * zoom) / 2 - stageY * zoom);
  updateCanvasTransform();
}

function updateWorkspaceChrome() {
  document.body.classList.toggle('mode-interact', state.mode === 'interact');
  const page = getActivePageScene();
  const node = page?.nodes.find(n => n.id === state.selectedIds[0]);
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

function updateTopbarStatus() {
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

function updateCanvasTransform() {
  const stage = document.getElementById('canvas-stage');
  if (stage) {
    stage.style.transform = `translate3d(${Math.round(state.panX)}px, ${Math.round(state.panY)}px, 0) scale(${state.zoom})`;
  }
  renderSelectionOverlay();
  updateTopbarStatus();
}

function renderTextContentHtml(n) {
  if (n.truncated) return escapeHtml(n.text);
  if (Array.isArray(n.spans) && n.spans.length > 0) {
    return n.spans
      .map(sp => {
        const spStyles = [];
        if (sp.fontFamily) spStyles.push(`font-family:'${escapeHtml(sp.fontFamily)}', ${n.fontStackCss || 'sans-serif'}`);
        if (sp.fontSize) spStyles.push(`font-size:${Number(sp.fontSize)}px`);
        if (sp.fontWeight) spStyles.push(`font-weight:${Number(sp.fontWeight)}`);
        if (sp.letterSpacing !== undefined) spStyles.push(`letter-spacing:${Number(sp.letterSpacing)}px`);
        if (sp.color) spStyles.push(`color:${escapeHtml(sp.color)}`);
        if (sp.italic) spStyles.push('font-style:italic');
        if (sp.underline) spStyles.push('text-decoration:underline');
        const stAttr = spStyles.length > 0 ? ` style="${spStyles.join(';')}"` : '';
        return `<span class="studio-text-span"${stAttr}>${escapeHtml(sp.text ?? '')}</span>`;
      })
      .join('');
  }
  return escapeHtml(n.text);
}

function buildNodeElementHtml(n, pageId, childrenHtml = '', parent = null) {
  if (!n.visible || n.type === 'phone-shell') return '';
  const fontStack = n.fontStackCss || `'${n.fontFamily || 'PingFang SC'}', 'PingFang SC', 'Inter', sans-serif`;
  const styles = [
    `left:${n.x - (parent?.x || 0) - (parent?.strokeWidth || 0)}px`,
    `top:${n.y - (parent?.y || 0) - (parent?.strokeWidth || 0)}px`,
    `width:${n.w}px`,
    `height:${n.h}px`,
    `border-radius:${n.radius || 0}px`,
    `opacity:${n.opacity ?? 1}`,
    `font-family:${fontStack}`,
    `font-size:${n.fontSize || 14}px`,
    `font-weight:${n.fontWeight || 400}`,
    `line-height:${n.lineHeight || 20}px`,
    `letter-spacing:${n.letterSpacing || 0}px`,
    `color:${n.color || '#203B32'}`,
    `text-align:${n.textAlign || 'left'}`,
    `z-index:${n.renderOrder || n.depth || 1}`,
  ];
  if (state.mode === 'interact' && (n.on?.click || n.type === 'button')) {
    styles.push('cursor:pointer');
  }
  if (n.fill && n.fill !== '#FFFFFF00') styles.push(`background:${n.fill}`);
  if (n.stroke && n.stroke !== '#FFFFFF00' && n.strokeWidth > 0) {
    styles.push(`border:${n.strokeWidth}px solid ${n.stroke}`);
  }
  if (n.italic) styles.push('font-style:italic');
  if (n.underline) styles.push('text-decoration:underline');
  if (n.type === 'dynamic-panel' || (n.radius > 0 && childrenHtml)) styles.push('overflow:hidden');
  const css = visualCss(n);
  const style = extra => escapeHtml([...styles, extra || '', ...Object.entries(css).map(([key, value]) => `${key}:${value}`)].join(';'));
  const textClass = ['button', 'label', 'paragraph', 'badge'].includes(n.type) ? ' studio-text' : '';
  const commonAttrs = `class="studio-node studio-${n.type}${textClass}" data-node-id="${escapeHtml(n.id)}" data-scoped-id="${escapeHtml(n.scopedId)}" data-page-id="${escapeHtml(pageId)}" data-node-type="${escapeHtml(n.type)}" data-locked="${n.locked ? 'true' : 'false'}"`;

  if (n.type === 'icon') {
    const svg = renderIconSvg(n.icon || n.name || n.id, n.color || '#203B32', Math.min(n.w || 18, n.h || 18));
    return `<div ${commonAttrs} style="${style('display:flex;align-items:center;justify-content:center')}">${svg}${childrenHtml}</div>`;
  }

  if (n.type === 'image') {
    if (n.assetMissing || !n.src) {
      return `<div ${commonAttrs} style="${style('background:#2c3531;color:#fbd38d;display:flex;align-items:center;justify-content:center;font-size:11px;border:1px dashed #e5a93c')}">⚠ 缺失资源: ${escapeHtml(n.src || '未指定')}</div>`;
    }
    const imgUrl = `/assets/${encodeURIComponent(n.src.replace(/^assets\//, ''))}`;
    return `<div ${commonAttrs} style="${style('overflow:hidden')}"><img src="${imgUrl}" alt="${escapeHtml(n.name)}" style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;" />${childrenHtml}</div>`;
  }

  if (n.type === 'input') {
    if (state.mode === 'interact') {
      const val = state.runtimeState?.inputs?.[`${pageId}/${n.id}`] ?? state.runtimeState?.inputs?.[n.id] ?? n.text ?? '';
      return `<input ${commonAttrs} value="${escapeHtml(val)}" placeholder="${escapeHtml(n.placeholder || '')}" style="${style('padding:0 12px')}" data-runtime-input="${escapeHtml(n.id)}" />`;
    }
    const disp = n.text || n.placeholder || '';
    const isPlaceholder = !n.text && n.placeholder;
    return `<div ${commonAttrs} style="${style(`display:flex;align-items:center;padding:0 12px;${isPlaceholder ? 'color:#6E8279' : ''}`)}">${escapeHtml(disp)}${childrenHtml}</div>`;
  }

  if (n.type === 'repeater') {
    const dsName = n.dataset || n.id;
    const rows = state.mode === 'interact' && state.runtimeState?.datasets?.[dsName]
      ? state.runtimeState.datasets[dsName].visibleRows
      : (state.doc?.datasets?.[dsName]?.rows || n.rows || []);
    const rowH = Number(n.rowHeight || 48);
    const gap = Number(n.rowGap ?? 6);
    const rowsHtml = rows.slice(0, 25).map((r, idx) => {
      const rowId = r._rowId || r.id || `row_${idx + 1}`;
      const isSel = Boolean(r._selected);
      const cells = Object.entries(r)
        .filter(([k]) => !k.startsWith('_'))
        .map(([, v]) => `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(v)}</span>`)
        .join('');
      return `<div class="repeater-row-item" data-repeater="${escapeHtml(dsName)}" data-row-id="${escapeHtml(rowId)}" style="height:${rowH}px;margin-bottom:${gap}px;padding:0 12px;display:flex;align-items:center;gap:8px;background:${isSel ? '#DCEFE6' : '#FFFFFF'};border:1px solid ${isSel ? '#2E6F57' : '#DDE3DC'};border-radius:8px;cursor:pointer;font-size:12px;color:#203B32;">${cells}</div>`;
    }).join('');
    return `<div ${commonAttrs} style="${style('overflow-y:auto;padding:4px')}">${rowsHtml}</div>`;
  }

  if (n.type === 'button' || n.type === 'label' || n.type === 'paragraph' || n.type === 'badge') {
    const isSingle = (n.lines?.length || 1) <= 1 && n.type !== 'paragraph' && n.wrap !== true;
    const padCss = (n.padX || n.padY) ? `padding:${Math.round((n.padY || 0) / 2)}px ${Math.round((n.padX || 0) / 2)}px;` : '';
    const flexAlign = (n.type === 'button' || n.type === 'badge')
      ? `display:flex;align-items:center;justify-content:center;white-space:nowrap;${padCss}`
      : isSingle
        ? `display:flex;align-items:center;justify-content:${n.textAlign === 'center' ? 'center' : n.textAlign === 'right' ? 'flex-end' : 'flex-start'};white-space:nowrap;${padCss}`
        : `display:block;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;${padCss}`;
    const typoAttrs = `data-line-count="${n.lineCount ?? n.lines?.length ?? 1}" data-first-baseline="${n.firstBaselineOffset ?? ''}" data-last-baseline="${n.lastBaselineOffset ?? ''}" data-resolved-font="${escapeHtml(n.fontFamily || 'PingFang SC')}"`;
    return `<div ${commonAttrs} ${typoAttrs} style="${style(flexAlign)}">${renderTextContentHtml(n)}${childrenHtml}</div>`;
  }

  return `<div ${commonAttrs} style="${style()}">${childrenHtml}</div>`;
}

function renderPageNodes(pg) {
  const nodes = pg.nodes.filter(n => n.visible && n.type !== 'phone-shell');
  const byId = new Map(nodes.map(n => [n.scopedId, n]));
  const children = new Map();
  for (const n of nodes) {
    const parentKey = byId.has(n.parentScopedId) ? n.parentScopedId : null;
    if (!children.has(parentKey)) children.set(parentKey, []);
    children.get(parentKey).push(n);
  }
  const render = (n, parent) => buildNodeElementHtml(n, pg.id, (children.get(n.scopedId) || []).map(ch => render(ch, n)).join(''), parent);
  return (children.get(null) || []).map(n => render(n, null)).join('');
}

function tokenCss() {
  return escapeHtml(Object.entries(state.doc?.tokens?.colors || {}).map(([key, value]) => `--${key}:${value}`).join(';'));
}

function nodeViewportBounds(node) {
  const el = document.querySelector(`.studio-node[data-scoped-id="${CSS.escape(node.scopedId)}"]`);
  const viewport = document.getElementById('canvas-viewport');
  if (!el || !viewport) return null;
  const rect = el.getBoundingClientRect();
  const vp = viewport.getBoundingClientRect();
  return { x: rect.left - vp.left, y: rect.top - vp.top, w: rect.width, h: rect.height };
}

function positionNodeElement(el, node, pg) {
  const parent = pg.nodes.find(n => n.scopedId === node.parentScopedId && n.type !== 'phone-shell');
  el.style.left = `${node.x - (parent?.x || 0) - (parent?.strokeWidth || 0)}px`;
  el.style.top = `${node.y - (parent?.y || 0) - (parent?.strokeWidth || 0)}px`;
}

function pointerMapper(nodeEl) {
  const parent = nodeEl?.parentElement;
  if (!parent) return null;
  // Four zero-size probes recover the actual parent plane, including perspective,
  // nested transforms, zoom and scroll. They never become document objects.
  const points = [[0, 0], [100, 0], [0, 100], [100, 100]].map(([x, y]) => {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;pointer-events:none`;
    parent.append(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return { x: rect.x, y: rect.y, u: x / 100, v: y / 100 };
  });
  const rows = points.flatMap(({ x, y, u, v }) => [
    [u, v, 1, 0, 0, 0, -x * u, -x * v, x],
    [0, 0, 0, u, v, 1, -y * u, -y * v, y],
  ]);
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    if (Math.abs(rows[pivot][col]) < 1e-9) return null;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const scale = rows[col][col];
    for (let k = col; k <= 8; k++) rows[col][k] /= scale;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let k = col; k <= 8; k++) rows[row][k] -= factor * rows[col][k];
    }
  }
  const [a, b, c, d, e, f, g, h] = rows.map(row => row[8]);
  return (x, y) => {
    const aa = a - x * g, bb = b - x * h, dd = d - y * g, ee = e - y * h;
    const det = aa * ee - bb * dd;
    return { x: 100 * ((x - c) * ee - bb * (y - f)) / det, y: 100 * (aa * (y - f) - (x - c) * dd) / det };
  };
}

function renderCanvasStage() {
  const stage = document.getElementById('canvas-stage');
  if (!stage || !state.scene) return;

  if (state.mode === 'interact' && state.runtimeState?.activePageScene) {
    const pgScene = state.runtimeState.activePageScene;
    const b = pgScene.board;
    const nodesHtml = renderPageNodes(pgScene);
    const islandHtml = b.island && b.darkIsland
      ? `<div class="artboard-island" style="left:${(b.screenW - b.island.w) / 2}px;top:${b.island.y}px;width:${b.island.w}px;height:${b.island.h}px;border-radius:${b.island.r ?? b.island.h / 2}px;"><span style="position:absolute;right:12px;top:11px;width:10px;height:10px;border-radius:50%;background:#1B2431;border:1px solid #2B3546;box-sizing:border-box;"></span></div>`
      : '';
    stage.innerHTML = `
      <div class="artboard-wrapper" data-artboard-id="${escapeHtml(pgScene.id)}" style="left:60px;top:40px;width:${b.totalW}px;height:${b.totalH}px;">
        <div class="artboard-title-bar active" title="${escapeHtml(pgScene.id)} · ${b.screenW} × ${b.screenH}">预览 · ${escapeHtml(pgScene.name)}</div>
        <div class="artboard-outer" style="width:${b.totalW}px;height:${b.totalH}px;border-radius:${b.outerRadius}px;background:#09090B;box-shadow:inset 0 0 0 2px #8B8D8E,inset 0 0 0 4px #33343B;">
          <div class="artboard-screen" id="screen-root" data-page-id="${escapeHtml(pgScene.id)}" style="left:${b.shellPad}px;top:${b.shellPad}px;width:${b.screenW}px;height:${b.screenH}px;border-radius:${b.screenRadius}px;${tokenCss()}">
            ${islandHtml}
            ${b.island && b.showHomeIndicator ? `<div class="artboard-island" style="left:${(b.screenW-134)/2}px;top:${b.screenH-12}px;width:134px;height:5px;border-radius:9px;background:#18181B;"></div>` : ''}
            ${nodesHtml}
          </div>
        </div>
      </div>
    `;
    bindRuntimeStageEvents(stage);
    updateCanvasTransform();
    return;
  }

  // Design or Explore mode: render active artboard + visible neighbor artboards
  const pages = state.scene.pages || [];
  let cursorX = 60;
  const cursorY = 40;
  const boardHtmlList = [];

  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const b = pg.board;
    const boardX = pages.length > 1 ? cursorX : (b.x ?? 60);
    const boardY = b.y ?? cursorY;
    pg._stageX = boardX;
    pg._stageY = boardY;
    cursorX = boardX + b.totalW + 80;

    // For large multi-page documents, mount activePageId (and all pages when <= 6 pages) so pan/zoom and edits stay ultra fast
    const shouldMountNodes = pg.id === state.activePageId || pages.length <= 6;
    const nodesHtml = shouldMountNodes
      ? renderPageNodes(pg)
      : `<div style="padding:24px;color:#6E8279;font-size:13px;">点击画板激活加载 (${pg.nodes.length} 节点)</div>`;

    const islandHtml = b.island && b.darkIsland
      ? `<div class="artboard-island" style="left:${(b.screenW - b.island.w) / 2}px;top:${b.island.y}px;width:${b.island.w}px;height:${b.island.h}px;border-radius:${b.island.r ?? b.island.h / 2}px;"><span style="position:absolute;right:12px;top:11px;width:10px;height:10px;border-radius:50%;background:#1B2431;border:1px solid #2B3546;box-sizing:border-box;"></span></div>`
      : '';

    boardHtmlList.push(`
      <div class="artboard-wrapper" data-artboard-id="${escapeHtml(pg.id)}" style="left:${boardX}px;top:${boardY}px;width:${b.totalW}px;height:${b.totalH}px;">
        <div class="artboard-title-bar ${pg.id === state.activePageId ? 'active' : ''}" data-select-page="${escapeHtml(pg.id)}" title="${escapeHtml(pg.id)} · ${b.screenW} × ${b.screenH}">
          <span>${escapeHtml(pg.name)}</span>
        </div>
        <div class="artboard-outer" style="width:${b.totalW}px;height:${b.totalH}px;border-radius:${b.outerRadius}px;background:${b.shellPad > 0 ? '#09090B' : 'transparent'};${b.shellPad > 0 ? 'box-shadow:inset 0 0 0 2px #8B8D8E,inset 0 0 0 4px #33343B;' : ''}">
          <div class="artboard-screen" id="${pg.id === state.activePageId ? 'screen-root' : `screen-${pg.id}`}" data-page-id="${escapeHtml(pg.id)}" style="left:${b.shellPad}px;top:${b.shellPad}px;width:${b.screenW}px;height:${b.screenH}px;border-radius:${b.screenRadius}px;${tokenCss()}">
            ${islandHtml}
            ${b.island && b.showHomeIndicator ? `<div class="artboard-island" style="left:${(b.screenW-134)/2}px;top:${b.screenH-12}px;width:134px;height:5px;border-radius:9px;background:#18181B;"></div>` : ''}
            ${nodesHtml}
          </div>
        </div>
      </div>
    `);
  }

  stage.innerHTML = boardHtmlList.join('\n');
  updateCanvasTransform();
}

function bindRuntimeStageEvents(stage) {
  stage.querySelectorAll('[data-runtime-input]').forEach(inp => {
    inp.addEventListener('input', async e => {
      const targetId = e.target.getAttribute('data-runtime-input');
      const res = await apiPost('/api/runtime/input', { targetId, value: e.target.value });
      state.runtimeState = res.state;
      renderInspector();
    });
  });

  stage.querySelectorAll('.repeater-row-item').forEach(rowEl => {
    rowEl.addEventListener('click', async e => {
      e.stopPropagation();
      const dataset = rowEl.getAttribute('data-repeater');
      const rowId = rowEl.getAttribute('data-row-id');
      const res = await apiPost('/api/runtime/dataset', { op: 'select', dataset, rowId });
      state.runtimeState = res.state;
      renderCanvasStage();
      renderInspector();
    });
  });
}

function renderSelectionOverlay() {
  const overlay = document.getElementById('overlay-layer');
  if (!overlay) return;
  if (state.mode !== 'design' || !state.selectedIds.length) {
    overlay.innerHTML = '';
    return;
  }

  const pg = getActivePageScene();
  if (!pg) {
    overlay.innerHTML = '';
    return;
  }

  const originX = (pg._stageX ?? 60) + pg.board.shellPad;
  const originY = (pg._stageY ?? 40) + pg.board.shellPad;
  const boxesHtml = [];

  for (const id of state.selectedIds) {
    const n = pg.nodes.find(x => x.id === id);
    if (!n || !n.visible) continue;
    const bounds = nodeViewportBounds(n);
    const vx = Math.round(bounds?.x ?? ((originX + n.x) * state.zoom + state.panX));
    const vy = Math.round(bounds?.y ?? ((originY + n.y) * state.zoom + state.panY));
    const vw = Math.round(bounds?.w ?? (n.w * state.zoom));
    const vh = Math.round(bounds?.h ?? (n.h * state.zoom));

    const handles = state.selectedIds.length === 1
      ? [
          ['nw', -4, -4, 'nwse-resize'],
          ['n', vw / 2 - 4, -4, 'ns-resize'],
          ['ne', vw - 4, -4, 'nesw-resize'],
          ['e', vw - 4, vh / 2 - 4, 'ew-resize'],
          ['se', vw - 4, vh - 4, 'nwse-resize'],
          ['s', vw / 2 - 4, vh - 4, 'ns-resize'],
          ['sw', -4, vh - 4, 'nesw-resize'],
          ['w', -4, vh / 2 - 4, 'ew-resize'],
        ]
          .map(
            ([dir, hx, hy, cur]) =>
              `<div class="resize-handle" data-resize-handle="${dir}" data-node-id="${escapeHtml(n.id)}" style="left:${Math.round(hx)}px;top:${Math.round(hy)}px;cursor:${cur};"></div>`
          )
          .join('')
      : '';

    boxesHtml.push(`
      <div class="selection-box" data-selection-for="${escapeHtml(n.id)}" style="left:${vx}px;top:${vy}px;width:${vw}px;height:${vh}px;">
        <div class="selection-label">
          ${n.w} × ${n.h}
        </div>
        ${handles}
      </div>
    `);
  }

  for (const g of state.snapGuides) {
    if (g.axis === 'x') {
      const gx = Math.round((originX + g.pos) * state.zoom + state.panX);
      boxesHtml.push(`<div class="snap-guide" style="left:${gx}px;top:0;width:1px;height:100%;"></div>`);
    } else {
      const gy = Math.round((originY + g.pos) * state.zoom + state.panY);
      boxesHtml.push(`<div class="snap-guide" style="left:0;top:${gy}px;width:100%;height:1px;"></div>`);
    }
  }

  overlay.innerHTML = boxesHtml.join('\n');
}

function renderSidebar() {
  const container = document.getElementById('sidebar-content');
  if (!container || !state.doc) return;
  updateWorkspaceChrome();

  if (state.sidebarTab === 'pages') {
    const pagesHtml = (state.doc.pages || [])
      .map(
        (pg, idx) => `
        <div class="list-item-row ${pg.id === state.activePageId ? 'selected' : ''}" data-page-select="${escapeHtml(pg.id)}" title="${escapeHtml(pg.name)}" tabindex="0">
          <div class="layer-meta">
            ${uiIcon('page')}<span class="layer-label">${escapeHtml(pg.name)}</span>
          </div>
          <details class="page-actions">
            <summary data-page-menu="${escapeHtml(pg.id)}" title="页面操作" aria-label="页面操作">···</summary>
            <div class="page-action-menu">
              <button data-page-up="${idx}" aria-label="上移页面">↑ 上移</button>
              <button data-page-down="${idx}" aria-label="下移页面">↓ 下移</button>
              <button data-page-dup="${escapeHtml(pg.id)}" aria-label="复制页面">⧉ 复制</button>
              <button class="danger" data-page-del="${escapeHtml(pg.id)}" aria-label="删除页面">× 删除</button>
            </div>
          </details>
        </div>
      `
      )
      .join('');

    const pgScene = getActivePageScene();
    const allLayerNodes = (pgScene?.nodes || []).filter(n => n.type !== 'phone-shell');
    const inStatusArea = n => pgScene?.board.island && n.y >= 0 && n.y + n.h <= 50 && !n.on?.click;
    const statusNodes = allLayerNodes.filter(inStatusArea);
    const query = state.layerFilter.trim().toLowerCase();
    const matchingNodes = allLayerNodes.filter(n => (!query || [n.name, n.id, n.rawText, n.text].some(v => String(v || '').toLowerCase().includes(query)))
      && (!inStatusArea(n) || state.showStatusArea || query || state.selectedIds.includes(n.id)));
    const visibleLayerNodes = matchingNodes.length > 120 && !state.showAllLayers
      ? matchingNodes.filter((n, idx) => idx < 100 || state.selectedIds.includes(n.id))
      : matchingNodes;
    const layersHtml = visibleLayerNodes
      .map(n => {
        const isSel = state.selectedIds.includes(n.id);
        const indent = Math.max(0, (n.depth - 1) * 12);
        const icon = n.componentSource ? 'component' : ({ image: 'image', label: 'text', paragraph: 'text', button: 'button' })[n.type] || 'layers';
        return `
          <div class="list-item-row ${isSel ? 'selected' : ''}" data-layer-select="${escapeHtml(n.id)}" style="padding-left:${9 + indent}px;" title="${escapeHtml(n.name || n.id)} (${escapeHtml(n.id)})" tabindex="0">
            <div class="layer-meta">
              ${uiIcon(icon)}<span class="layer-label">${escapeHtml(layerDisplayName(n, pgScene))}</span>
            </div>
            <div class="layer-actions">
              <button class="icon-btn" data-layer-vis="${escapeHtml(n.id)}" title="${n.visible ? '隐藏图层' : '显示图层'}" aria-label="${n.visible ? '隐藏图层' : '显示图层'}" aria-pressed="${n.visible}">${uiIcon('eye')}</button>
              <button class="icon-btn" data-layer-lock="${escapeHtml(n.id)}" title="${n.locked ? '解锁图层' : '锁定图层'}" aria-label="${n.locked ? '解锁图层' : '锁定图层'}" aria-pressed="${n.locked}">${uiIcon('lock')}</button>
            </div>
          </div>
        `;
      })
      .join('');

    const expandLayersBtnHtml = matchingNodes.length > 120
      ? `<button id="btn-toggle-all-layers">${state.showAllLayers ? '收起' : `全部 ${matchingNodes.length}`}</button>`
      : '';

    container.innerHTML = `
      <div class="section-header">
        <button id="btn-toggle-pages" class="page-picker" aria-expanded="${state.pagesExpanded}">页面 (${state.doc.pages.length}) ${uiIcon('chevron')}</button>
        <button id="btn-sidebar-add-page" class="icon-btn" title="新建页面" aria-label="新建页面">${uiIcon('plus')}</button>
      </div>
      <div class="page-list ${state.pagesExpanded ? 'expanded' : ''}">${pagesHtml}</div>
      <div class="section-header">
        <span>当前页面的图层</span>
        ${expandLayersBtnHtml}
      </div>
      <div>${layersHtml}</div>
      ${visibleLayerNodes.length ? '' : '<p class="empty-message">没有匹配的图层</p>'}
      ${statusNodes.length ? `<button id="btn-status-area" class="status-area-toggle" aria-expanded="${state.showStatusArea}">${state.showStatusArea ? '收起' : '展开'}顶部状态区 (${statusNodes.length})</button>` : ''}
    `;

    container.querySelector('#btn-toggle-pages')?.addEventListener('click', () => { state.pagesExpanded = !state.pagesExpanded; renderSidebar(); });
    container.querySelector('#btn-status-area')?.addEventListener('click', () => { state.showStatusArea = !state.showStatusArea; renderSidebar(); });
    container.querySelectorAll('.list-item-row').forEach(row => row.addEventListener('keydown', event => {
      if (event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); row.click(); }
    }));

    container.querySelector('#btn-toggle-all-layers')?.addEventListener('click', () => {
      state.showAllLayers = !state.showAllLayers;
      renderSidebar();
    });

    container.querySelector('#btn-sidebar-add-page')?.addEventListener('click', async () => {
      let nextIdx = state.doc.pages.length + 1;
      while (state.doc.pages.some(p => p.id === `page_${nextIdx}`)) nextIdx++;
      const newPageId = `page_${nextIdx}`;
      state.activePageId = newPageId;
      state.selectedIds = [];
      await dispatchCommands({ type: 'addPage', pageId: newPageId, name: `页面 ${nextIdx}`, autoUniqueId: true });
    });

    container.querySelectorAll('[data-page-select]').forEach(el => {
      el.addEventListener('click', async e => {
        if (e.target.closest('button, summary')) return;
        const nextPageId = el.getAttribute('data-page-select');
        state.activePageId = nextPageId;
        state.selectedIds = [];
        if (state.mode === 'interact') {
          try {
            const res = await apiPost('/api/runtime/navigate', { pageId: nextPageId });
            state.runtimeState = res.state;
          } catch {}
        }
        renderAll();
      });
    });

    container.querySelectorAll('[data-page-dup]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const pageId = btn.getAttribute('data-page-dup');
        await dispatchCommands({ type: 'duplicatePage', pageId, newPageId: `${pageId}_copy` });
      });
    });

    container.querySelectorAll('[data-page-del]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const pageId = btn.getAttribute('data-page-del');
        dispatchCommands({ type: 'deletePage', pageId });
      });
    });

    container.querySelectorAll('[data-page-up], [data-page-down]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const isUp = btn.hasAttribute('data-page-up');
        const idx = Number(btn.getAttribute(isUp ? 'data-page-up' : 'data-page-down'));
        const ids = state.doc.pages.map(p => p.id);
        const swapIdx = isUp ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= ids.length) return;
        [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
        dispatchCommands({ type: 'reorderPages', pageIds: ids });
      });
    });

    container.querySelectorAll('[data-layer-select]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        const id = el.getAttribute('data-layer-select');
        if (e.shiftKey) {
          if (state.selectedIds.includes(id)) state.selectedIds = state.selectedIds.filter(x => x !== id);
          else state.selectedIds.push(id);
        } else {
          state.selectedIds = [id];
        }
        renderSidebar();
        renderSelectionOverlay();
        renderInspector();
      });
    });

    container.querySelectorAll('[data-layer-vis]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.getAttribute('data-layer-vis');
        const node = pgScene.nodes.find(n => n.id === id);
        dispatchCommands({
          type: 'setProperties',
          pageId: state.activePageId,
          nodeId: id,
          properties: { visible: node ? !node.visible : true },
        });
      });
    });

    container.querySelectorAll('[data-layer-lock]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.getAttribute('data-layer-lock');
        const node = pgScene.nodes.find(n => n.id === id);
        dispatchCommands({
          type: 'setProperties',
          pageId: state.activePageId,
          nodeId: id,
          properties: { locked: node ? !node.locked : true },
        });
      });
    });
    return;
  }

  if (state.sidebarTab === 'components') {
    const comps = Object.entries(state.doc.components || {});
    container.innerHTML = `
      <div class="section-header">
        <span>组件库 (${comps.length})</span>
      </div>
      ${
        comps.length === 0
          ? '<p class="empty-message">选中图层后，使用底部「创建组件」将它保存为可复用组件。</p>'
          : comps
              .map(
                ([compId, comp]) => `
              <div class="list-item-row">
                <span>❖ ${escapeHtml(comp.name || compId)}</span>
                <button class="icon-btn" data-insert-instance="${escapeHtml(compId)}">+ 实例化</button>
              </div>
            `
              )
              .join('')
      }
    `;
    container.querySelectorAll('[data-insert-instance]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const compId = btn.getAttribute('data-insert-instance');
        const instId = `${compId.toLowerCase()}_inst_${Date.now().toString(36).slice(-4)}`;
        state.selectedIds = [instId];
        await dispatchCommands({
          type: 'createInstance',
          pageId: state.activePageId,
          componentId: compId,
          instanceId: instId,
          x: 32,
          y: 120,
        });
      });
    });
    return;
  }

  if (state.sidebarTab === 'tokens') {
    const colors = state.doc.tokens?.colors || state.doc.palette || {};
    const fonts = state.doc.fonts?.catalog || [];
    container.innerHTML = `
      <div class="section-header"><span>全局颜色令牌</span></div>
      <div>
        ${Object.entries(colors)
          .map(
            ([k, v]) => `
          <div class="prop-field" style="flex-direction:row;align-items:center;justify-content:space-between;">
            <label>$${escapeHtml(k)}</label>
            <input type="text" data-token-color="${escapeHtml(k)}" value="${escapeHtml(v)}" style="width:110px;" />
          </div>
        `
          )
          .join('')}
      </div>
      <div class="section-header" style="margin-top:12px;"><span>工程字体目录</span></div>
      <div>
        ${fonts
          .map(
            f => `<div class="list-item-row"><span>🔤 ${escapeHtml(f.family)}</span><span style="opacity:0.6;">${(f.weights || []).join('/')}</span></div>`
          )
          .join('')}
      </div>
    `;
    container.querySelectorAll('[data-token-color]').forEach(inp => {
      inp.addEventListener('change', () => {
        const name = inp.getAttribute('data-token-color');
        dispatchCommands({ type: 'setToken', category: 'colors', name, value: inp.value.trim() });
      });
    });
  }
}

function renderInspector() {
  renderInspectorContent();
  refineInspector();
}

function refineInspector() {
  const panel = document.getElementById('inspector-panel');
  if (!panel) return;
  updateWorkspaceChrome();
  panel.classList.toggle('all-properties', state.inspectorAll);
  panel.classList.toggle('show-history', state.showHistory);
  const allButton = document.getElementById('btn-all-properties');
  if (allButton) {
    allButton.hidden = state.mode !== 'design';
    allButton.textContent = state.inspectorAll ? '精简属性' : '所有属性';
    allButton.setAttribute('aria-pressed', String(state.inspectorAll));
  }
  const history = panel.querySelector('#insp-impact-history-group');
  if (history && state.showHistory) panel.prepend(history);
  const historyButton = document.getElementById('btn-history');
  if (historyButton) historyButton.setAttribute('aria-pressed', String(state.showHistory));
  if (state.mode !== 'design') return;

  const labels = { 'insp-node-name': '图层名称', 'insp-w': '宽度', 'insp-h': '高度', 'insp-radius': '圆角',
    'insp-opacity': '不透明度', 'insp-font-family': '字体', 'insp-font-size': '字号', 'insp-font-weight': '字重',
    'insp-line-height': '行高', 'insp-letter-spacing': '字距', 'insp-fill': '填充', 'insp-color': '文字颜色',
    'insp-stroke': '描边', 'insp-link': '跳转页面' };
  for (const [id, label] of Object.entries(labels)) {
    const element = panel.querySelector(`#${id}`)?.closest('.prop-field')?.querySelector('label');
    if (element) element.textContent = label;
  }
  const page = getActivePageScene();
  const node = page?.nodes.find(n => n.id === state.selectedIds[0]);
  for (const group of panel.querySelectorAll(':scope > .prop-group')) {
    const heading = group.querySelector('.prop-group-title');
    if (!heading) continue;
    const title = heading.textContent.trim();
    if (title === '工程与文档概览') heading.textContent = '文档设置';
    if (title.startsWith('画板属性')) heading.textContent = '画板';
    if (title === '几何与尺寸约束') heading.textContent = '位置与尺寸';
    if (group.id === 'insp-impact-history-group') { heading.textContent = '最近修改'; continue; }
    if (!node) continue;
    if (title.startsWith('节点标识')) {
      group.classList.add('node-identity');
      group.querySelector('.prop-field')?.classList.add('contextual-hidden');
      heading.textContent = ({ image: '图片图层', label: '文字图层', paragraph: '文字图层', box: '容器图层', button: '按钮图层' })[node.type] || '当前图层';
      if (node.type === 'image') {
        const asset = state.doc.assetsManifest?.[node.src];
        const resource = document.createElement('div');
        resource.className = 'media-resource';
        const image = node.src && !node.assetMissing
          ? `<img src="/assets/${encodeURIComponent(node.src.replace(/^assets\//, ''))}" alt="所选图像" />` : uiIcon('image');
        resource.innerHTML = `${image}<div><strong>图像资源</strong><span>${node.assetMissing ? '资源尚未找到' : asset?.width ? `${asset.width} × ${asset.height} px` : '已载入项目资源'}</span><span>${escapeHtml(node.src?.split('/').pop() || '未指定图片')}</span></div>`;
        group.after(resource);
      }
      continue;
    }
    if (node.type === 'image' && (title.startsWith('容器布局') || title === '文本与排版')) group.classList.add('contextual-hidden');
    if (title === '高级 CSS 效果' || title.startsWith('填充、描边')) {
      const key = title === '高级 CSS 效果' ? 'effects' : 'appearance';
      const button = document.createElement('button');
      button.className = 'prop-group-title prop-disclosure';
      button.type = 'button';
      button.textContent = key === 'effects' ? '效果' : '样式与交互';
      const body = document.createElement('div');
      body.className = 'prop-group-body';
      for (const child of [...group.children]) if (child !== heading) body.append(child);
      group.replaceChild(button, heading);
      group.append(body);
      const expanded = state.inspectorExpanded.has(key);
      group.classList.toggle('collapsed', !expanded);
      button.setAttribute('aria-expanded', String(expanded));
      button.addEventListener('click', () => {
        group.classList.toggle('collapsed');
        const open = !group.classList.contains('collapsed');
        button.setAttribute('aria-expanded', String(open));
        if (open) state.inspectorExpanded.add(key); else state.inspectorExpanded.delete(key);
      });
    }
  }
}

function renderInspectorContent() {
  const panel = document.getElementById('inspector-panel');
  if (!panel || !state.doc) return;

  const errBanner = state.lastError
    ? `<div class="diagnostic-banner"><strong>${escapeHtml(state.lastError.code || 'ERROR')}</strong>: ${escapeHtml(state.lastError.message)}</div>`
    : '';

  const fontDiagHtml = (state.scene?.fontDiagnostics || [])
    .map(d => `<div class="diagnostic-banner">🔤 ${escapeHtml(d.message)}</div>`)
    .join('');

  if (state.mode === 'interact') {
    const rt = state.runtimeState;
    panel.innerHTML = `
      ${errBanner}
      <div class="prop-group">
        <div class="prop-group-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>交互运行态调试器</span>
          <button id="btn-rt-reset">重置会话</button>
        </div>
        <div style="margin-bottom:6px;">当前页面: <strong>${escapeHtml(rt?.currentPageId || '')}</strong></div>
        <div class="prop-group-title">全局变量</div>
        <pre style="background:var(--ui-bg);padding:8px;border-radius:6px;overflow:auto;">${escapeHtml(JSON.stringify(rt?.variables || {}, null, 2))}</pre>
        <div class="prop-group-title">动态面板状态</div>
        <pre style="background:var(--ui-bg);padding:8px;border-radius:6px;overflow:auto;">${escapeHtml(JSON.stringify(rt?.panelStates || {}, null, 2))}</pre>
        <div class="prop-group-title">交互事件轨迹 (${rt?.traceCount || 0})</div>
        <pre style="background:var(--ui-bg);padding:8px;border-radius:6px;max-height:240px;overflow:auto;">${escapeHtml(JSON.stringify((rt?.trace || []).slice(-10), null, 2))}</pre>
      </div>
    `;
    panel.querySelector('#btn-rt-reset')?.addEventListener('click', async () => {
      const res = await apiPost('/api/runtime/reset', { startPageId: state.activePageId });
      state.runtimeState = res.state;
      renderCanvasStage();
      renderInspector();
    });
    return;
  }

  if (state.mode === 'explore') {
    const pgDocForExp = state.doc.pages.find(p => p.id === state.activePageId);
    const exps = (pgDocForExp?.explorations?.length ? pgDocForExp.explorations : state.doc.explorations) || [];
    panel.innerHTML = `
      ${errBanner}
      <div class="prop-group">
        <div class="prop-group-title">多方案视觉探索与对比 (Design Brief)</div>
        <div class="prop-grid" style="margin-bottom:8px;">
          <div class="prop-field">
            <label>业务领域 Domain</label>
            <select id="exp-brief-domain">
              <option value="birding">观鸟自然 (birding)</option>
              <option value="study-cards">学习卡片 (study-cards)</option>
              <option value="equipment-loan">器材借用 (equipment-loan)</option>
              <option value="custom">自定义领域 (custom)</option>
            </select>
          </div>
          <div class="prop-field">
            <label>风格基调 Tone</label>
            <input id="exp-brief-tone" type="text" placeholder="如：杂志画报 / 高效工具" value="" />
          </div>
        </div>
        <div class="prop-field" style="margin-bottom:8px;">
          <label>页面目标 Page Goal</label>
          <input id="exp-brief-goal" type="text" placeholder="输入核心业务目标或首屏重点任务…" value="" />
        </div>
        <button id="btn-gen-explorations" class="primary" style="width:100%;margin-bottom:10px;">生成 3 套差异化视觉方案</button>
        ${exps
          .map(exp => {
            const expId = exp.explorationId || exp.id || '';
            const expTitle = exp.title || exp.name || expId;
            const layoutDesc = exp.axes?.layoutStructure || exp.structuralFeatures?.cardOrganization || exp.direction || '自适应版式';
            const typoDesc = exp.axes?.typography || exp.axes?.typographyPairing || (exp.direction === 'editorial-magazine' ? 'Songti SC' : 'PingFang SC');
            const densityDesc = exp.axes?.density || exp.axes?.informationDensity || (exp.structuralFeatures?.imageToTextRatio >= 0.5 ? '舒展大图' : '紧凑信息流');
            return `
          <div class="exploration-card">
            <div style="font-weight:700;margin-bottom:4px;">${escapeHtml(expTitle)}</div>
            <div style="font-size:11px;color:var(--ui-text-muted);margin-bottom:4px;">
              版式: ${escapeHtml(layoutDesc)} · 字体: ${escapeHtml(typoDesc)} · 密度: ${escapeHtml(densityDesc)}
            </div>
            ${exp.rationale ? `<div style="font-size:11px;color:#b8c7c0;margin-bottom:8px;line-height:1.4;">${escapeHtml(exp.rationale)}</div>` : ''}
            <div style="display:flex;gap:6px;margin-bottom:6px;">
              <button class="btn-apply-exp" data-apply-exploration="${escapeHtml(expId)}" style="flex:1;">采纳整页方案</button>
              <select class="exp-region-select" data-exp-region="${escapeHtml(expId)}" style="max-width:110px;">
                <option value="hero">Hero 首屏区</option>
                <option value="header">Header 导航区</option>
                <option value="quick-action">快捷操作区</option>
                <option value="list">内容列表区</option>
              </select>
              <button class="btn-apply-exp-region" data-apply-exploration-region="${escapeHtml(expId)}" style="flex:1;opacity:0.9;">采纳所选区</button>
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              <button class="btn-apply-exp-region" data-apply-exploration-region="${escapeHtml(expId)}" data-region-role="header" style="font-size:10px;padding:2px 6px;">仅 Header</button>
              <button class="btn-apply-exp-region" data-apply-exploration-region="${escapeHtml(expId)}" data-region-role="hero" style="font-size:10px;padding:2px 6px;">仅 Hero</button>
              <button class="btn-apply-exp-region" data-apply-exploration-region="${escapeHtml(expId)}" data-region-role="quick-action" style="font-size:10px;padding:2px 6px;">仅操作区</button>
              <button class="btn-apply-exp-region" data-apply-exploration-region="${escapeHtml(expId)}" data-region-role="list" style="font-size:10px;padding:2px 6px;">仅列表区</button>
            </div>
          </div>
        `;
          })
          .join('')}
      </div>
    `;
    panel.querySelector('#btn-gen-explorations')?.addEventListener('click', () => {
      const domainVal = panel.querySelector('#exp-brief-domain')?.value || '';
      const goalVal = panel.querySelector('#exp-brief-goal')?.value?.trim() || '';
      const toneVal = panel.querySelector('#exp-brief-tone')?.value?.trim() || '';
      const cmd = { type: 'generateExplorations', pageId: state.activePageId };
      if (goalVal || toneVal || (domainVal && domainVal !== 'birding')) {
        cmd.designBrief = {
          domain: domainVal || 'birding',
          ...(goalVal ? { pageGoal: goalVal, heroTitle: goalVal } : {}),
          ...(toneVal ? { styleTone: toneVal } : {}),
        };
      }
      dispatchCommands(cmd);
    });
    panel.querySelectorAll('[data-apply-exploration]').forEach(btn => {
      btn.addEventListener('click', () => {
        dispatchCommands({
          type: 'selectExploration',
          explorationId: btn.getAttribute('data-apply-exploration'),
          pageId: state.activePageId,
          targetPageId: state.activePageId,
          mode: 'full-page',
        });
      });
    });
    panel.querySelectorAll('[data-apply-exploration-region]').forEach(btn => {
      btn.addEventListener('click', () => {
        const expId = btn.getAttribute('data-apply-exploration-region');
        const explicitRole = btn.getAttribute('data-region-role');
        const selRole = panel.querySelector(`select[data-exp-region="${CSS.escape(expId)}"]`)?.value || 'hero';
        dispatchCommands({
          type: 'selectExploration',
          explorationId: expId,
          pageId: state.activePageId,
          targetPageId: state.activePageId,
          mode: 'region',
          regionRole: explicitRole || selRole || 'hero',
        });
      });
    });
    return;
  }

  const docDiagHtml = (state.doc?.diagnostics || [])
    .map(d => `<div class="diagnostic-banner">⚠️ <strong>${escapeHtml(d.code || 'DIAG')}</strong>: ${escapeHtml(d.message)}</div>`)
    .join('');

  const lastImp = state.lastImpact || state.recentHistory?.[0] || null;
  const sumText = state.lastSummary
    ? typeof state.lastSummary === 'string'
      ? state.lastSummary
      : state.lastSummary.fullText || state.lastSummary.whatChanged || ''
    : state.recentHistory?.[0]?.humanReadableSummary?.fullText || '';
  const historyRowsHtml = (state.recentHistory || [])
    .slice(0, 5)
    .map(
      h =>
        `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
          <strong>r${escapeHtml(h.revision)}</strong> · ${escapeHtml(h.label || '编辑事务')}
          <div style="font-size:10px;color:#95ada3;">波及页面: [${escapeHtml((h.affectedPageIds || []).join(', ') || state.activePageId || '无')}] · 节点计数: ${escapeHtml(h.affectedNodeCount ?? 0)} (直接 ${escapeHtml(h.directTargetCount ?? 0)} / 父容器 ${escapeHtml(h.ancestorCount ?? 0)} / 顺移 ${escapeHtml(h.shiftedCount ?? 0)})</div>
        </div>`
    )
    .join('');
  const impactSummaryHtml = `
    <div class="prop-group" id="insp-impact-history-group">
      <div class="prop-group-title">历史与事务 · 最近改稿变更影响</div>
      ${
        sumText
          ? `<div style="font-size:11px;line-height:1.5;color:#cbd8ce;margin-bottom:6px;">${escapeHtml(sumText)}</div>`
          : `<div style="font-size:11px;color:#8fa399;margin-bottom:6px;">当前修订 r${escapeHtml(state.appliedRevision)} · 暂无未读改稿告警</div>`
      }
      ${
        lastImp && Array.isArray(lastImp.affectedPageIds)
          ? `<div style="font-size:10px;color:#8df0ca;margin-bottom:6px;">
              变更波及页面: [${escapeHtml(lastImp.affectedPageIds.join(', ') || '无')}] ·
              直接节点 ${escapeHtml(lastImp.directTargetNodeIds?.length ?? lastImp.directTargetCount ?? 0)} ·
              祖先容器 ${escapeHtml(lastImp.affectedAncestorIds?.length ?? lastImp.ancestorCount ?? 0)} ·
              顺移兄弟 ${escapeHtml(lastImp.shiftedSiblingAndDescendantIds?.length ?? lastImp.shiftedCount ?? 0)} ·
              组件实例 ${escapeHtml(lastImp.affectedComponentInstanceIds?.length ?? lastImp.componentInstanceCount ?? 0)} ·
              令牌消费 ${escapeHtml(lastImp.affectedTokenConsumerIds?.length ?? lastImp.tokenConsumerCount ?? 0)}
            </div>`
          : ''
      }
      ${historyRowsHtml ? `<div style="max-height:120px;overflow-y:auto;">${historyRowsHtml}</div>` : ''}
    </div>
  `;

  const pgScene = getActivePageScene();
  if (!state.selectedIds.length || !pgScene) {
    const pgDoc = state.doc.pages.find(p => p.id === state.activePageId);
    const screenNode = pgScene?.nodes.find(n => n.id === `${pgDoc?.id}_screen`) || pgScene?.nodes[0];
    panel.innerHTML = `
      ${errBanner}
      ${fontDiagHtml}
      ${docDiagHtml}
      ${impactSummaryHtml}
      <div class="prop-group">
        <div class="prop-group-title">工程与文档概览</div>
        <div class="prop-grid">
          <div class="prop-field">
            <label>工程名称</label>
            <input type="text" value="${escapeHtml(state.doc.name || state.doc.documentId)}" disabled />
          </div>
          <div class="prop-field">
            <label>默认字体</label>
            <input id="insp-doc-font" type="text" value="${escapeHtml(state.doc.fonts?.defaultFamily || 'PingFang SC')}" />
          </div>
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">画板属性 (${escapeHtml(pgDoc?.id || '')})</div>
        <div class="prop-field">
          <label>画板名称</label>
          <input id="insp-page-name" type="text" value="${escapeHtml(pgDoc?.name || '')}" />
        </div>
        <div class="prop-grid">
          <div class="prop-field">
            <label>宽度 W</label>
            <input id="insp-board-w" type="number" value="${pgScene?.board.screenW || 402}" />
          </div>
          <div class="prop-field">
            <label>高度 H</label>
            <input id="insp-board-h" type="number" value="${pgScene?.board.screenH || 874}" />
          </div>
          <div class="prop-field">
            <label>画板背景色 Fill</label>
            <input id="insp-board-fill" type="text" value="${escapeHtml(screenNode?.rawFill || screenNode?.fill || '$bg')}" />
          </div>
          <div class="prop-field">
            <label>画布节点数</label>
            <input type="text" value="${pgScene?.nodes.length || 0} 个对象" disabled />
          </div>
        </div>
      </div>
    `;
    panel.querySelector('#insp-doc-font')?.addEventListener('change', e => {
      dispatchCommands({ type: 'setFont', defaultFamily: e.target.value.trim() });
    });
    panel.querySelector('#insp-page-name')?.addEventListener('change', e => {
      dispatchCommands({ type: 'renamePage', pageId: state.activePageId, name: e.target.value });
    });
    panel.querySelector('#insp-board-fill')?.addEventListener('change', e => {
      if (screenNode) {
        dispatchCommands({
          type: 'setProperties',
          pageId: state.activePageId,
          nodeId: screenNode.id,
          properties: { fill: e.target.value.trim() },
        });
      }
    });
    const commitBoardResize = () => {
      const w = Number(panel.querySelector('#insp-board-w').value);
      const h = Number(panel.querySelector('#insp-board-h').value);
      dispatchCommands({ type: 'resizeArtboard', pageId: state.activePageId, w, h });
    };
    panel.querySelector('#insp-board-w')?.addEventListener('change', commitBoardResize);
    panel.querySelector('#insp-board-h')?.addEventListener('change', commitBoardResize);
    return;
  }

  // Multi-select Batch Inspector (when >= 2 nodes are selected)
  if (state.selectedIds.length >= 2) {
    const selNodes = state.selectedIds.map(id => pgScene.nodes.find(n => n.id === id)).filter(Boolean);
    const first = selNodes[0] || {};
    panel.innerHTML = `
      ${errBanner}
      ${fontDiagHtml}
      <div class="provenance-banner">
        <span>✨ 已选中 ${selNodes.length} 个节点 (${escapeHtml(selNodes.slice(0, 3).map(n => n.id).join(', '))}${selNodes.length > 3 ? '…' : ''})</span>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">批量对齐与分布</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button id="insp-batch-align-left">⫷ 左对齐</button>
          <button id="insp-batch-align-center">⫿ 水平居中</button>
          <button id="insp-batch-align-top">⊤ 顶对齐</button>
          <button id="insp-batch-dist-h">⇔ 水平等距</button>
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">批量外观与排版属性</div>
        <div class="prop-grid">
          <div class="prop-field">
            <label>批量填充 Fill</label>
            <input id="insp-fill" type="text" placeholder="如 $card 或 #FFFFFF" value="${escapeHtml(first.rawFill ?? first.fill ?? '')}" />
          </div>
          <div class="prop-field">
            <label>批量文字色 Color</label>
            <input id="insp-color" type="text" placeholder="如 $ink 或 #203B32" value="${escapeHtml(first.rawColor ?? first.color ?? '')}" />
          </div>
          <div class="prop-field">
            <label>批量描边 Stroke</label>
            <input id="insp-stroke" type="text" placeholder="如 $line" value="${escapeHtml(first.rawStroke ?? first.stroke ?? '')}" />
          </div>
          <div class="prop-field">
            <label>批量圆角 Radius</label>
            <input id="insp-radius" type="number" value="${first.radius || 0}" />
          </div>
          <div class="prop-field">
            <label>批量不透明度 Opacity</label>
            <input id="insp-opacity" type="number" step="0.1" min="0" max="1" value="${first.opacity ?? 1}" />
          </div>
          <div class="prop-field">
            <label>批量字号 FontSize</label>
            <input id="insp-font-size" type="number" value="${first.fontSize || 14}" />
          </div>
          <div class="prop-field">
            <label>批量字重 FontWeight</label>
            <input id="insp-font-weight" type="number" step="100" value="${first.fontWeight || 400}" />
          </div>
        </div>
      </div>
      ${docDiagHtml}
      ${impactSummaryHtml}
    `;
    panel.querySelector('#insp-batch-align-left')?.addEventListener('click', () => document.getElementById('btn-align-left')?.click());
    panel.querySelector('#insp-batch-align-center')?.addEventListener('click', () => document.getElementById('btn-align-center')?.click());
    panel.querySelector('#insp-batch-align-top')?.addEventListener('click', () => document.getElementById('btn-align-top')?.click());
    panel.querySelector('#insp-batch-dist-h')?.addEventListener('click', () => document.getElementById('btn-distribute-h')?.click());

    const bindBatchProp = (sel, buildNodeCmd) => {
      const el = panel.querySelector(sel);
      if (!el) return;
      el.addEventListener('change', () => {
        const cmds = selNodes.filter(n => !n.locked).map(n => buildNodeCmd(n, el.value));
        if (cmds.length > 0) dispatchCommands(cmds);
      });
    };
    bindBatchProp('#insp-fill', (n, val) => ({ type: 'setProperties', pageId: state.activePageId, nodeId: n.id, properties: { fill: val.trim() } }));
    bindBatchProp('#insp-color', (n, val) => ({ type: 'setProperties', pageId: state.activePageId, nodeId: n.id, properties: { color: val.trim() } }));
    bindBatchProp('#insp-stroke', (n, val) => ({ type: 'setProperties', pageId: state.activePageId, nodeId: n.id, properties: { stroke: val.trim() } }));
    bindBatchProp('#insp-radius', (n, val) => ({ type: 'setProperties', pageId: state.activePageId, nodeId: n.id, properties: { radius: Number(val) } }));
    bindBatchProp('#insp-opacity', (n, val) => ({ type: 'setProperties', pageId: state.activePageId, nodeId: n.id, properties: { opacity: Number(val) } }));
    bindBatchProp('#insp-font-size', (n, val) => ({ type: 'setFont', pageId: state.activePageId, nodeId: n.id, fontSize: Number(val) }));
    bindBatchProp('#insp-font-weight', (n, val) => ({ type: 'setFont', pageId: state.activePageId, nodeId: n.id, fontWeight: Number(val) }));
    return;
  }

  const node = pgScene.nodes.find(n => n.id === state.selectedIds[0]);
  if (!node) return;

  const isLocked = Boolean(node.locked);
  const disAttr = isLocked ? 'disabled' : '';
  const lockedBannerHtml = isLocked
    ? `<div class="diagnostic-banner" style="display:flex;align-items:center;justify-content:space-between;">
        <span>🔒 当前节点已锁定，属性处于只读状态</span>
        <button id="btn-unlock-node" style="padding:2px 8px;">解锁</button>
      </div>`
    : '';

  function findRawNodeInTree(rootNode, targetId) {
    if (!rootNode || typeof rootNode !== 'object') return null;
    if (rootNode.id === targetId) return rootNode;
    for (const ch of rootNode.children || []) {
      const f = findRawNodeInTree(ch, targetId);
      if (f) return f;
    }
    for (const st of rootNode.states || []) {
      const f = findRawNodeInTree(st.root, targetId);
      if (f) return f;
    }
    return null;
  }

  let provenanceHtml = '';
  let contractParamsSectionHtml = '';
  if (node.componentSource) {
    const cs = node.componentSource;
    const compDef = state.doc.components?.[cs.componentId];
    const contract = compDef?.contract || state.doc.componentContracts?.[cs.componentId] || null;
    const contractVersion = contract?.version || cs.contractVersion || '1.0.0';
    const pgRaw = state.doc.pages?.find(p => p.id === state.activePageId);
    const rawInst = findRawNodeInTree(pgRaw?.root, cs.instanceId || node.id);
    const currentCompState = rawInst?.state || cs.state || node.state || 'default';
    const currentProps = rawInst?.props || {};

    const variantKeys = Array.from(new Set(['default', ...Object.keys(compDef?.variants || {})]));
    const variantOptions = variantKeys
      .map(v => `<option value="${escapeHtml(v)}" ${(cs.variant || 'default') === v ? 'selected' : ''}>${escapeHtml(v)}</option>`)
      .join('');

    const stateKeys = Array.from(
      new Set(['default', 'selected', 'disabled', 'loading', 'error', ...Object.keys(contract?.states || {})])
    );
    const stateOptions = stateKeys
      .map(st => `<option value="${escapeHtml(st)}" ${currentCompState === st ? 'selected' : ''}>${escapeHtml(st)}</option>`)
      .join('');

    const ovrList = cs.overriddenProps || [];
    const staleDiags = (state.doc.diagnostics || []).filter(
      d => d.code === 'E_STALE_OVERRIDE' && (d.instanceId === (cs.instanceId || node.id) || d.scopedId === node.scopedId)
    );
    provenanceHtml = `
      <div class="provenance-banner" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span>❖ 组件实例: <strong>${escapeHtml(cs.componentId)}</strong> · <span style="font-size:10px;opacity:0.85;">契约 v${escapeHtml(contractVersion)}</span>${cs.isInstanceRoot ? '' : ` · 子节点 ${escapeHtml(cs.subNodeId)}`}</span>
          <div style="display:flex;gap:4px;">
            <button id="btn-reset-overrides" title="重置当前实例覆盖">重置覆盖</button>
            <button id="btn-detach-instance" title="拆离为独立普通节点">解绑实例</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;">
          <span>变体 Variant:</span>
          <select id="insp-instance-variant" style="flex:1;" ${disAttr}>${variantOptions}</select>
          <span>状态 State:</span>
          <select id="insp-comp-state" style="flex:1;" ${disAttr}>${stateOptions}</select>
        </div>
        ${ovrList.length ? `<div style="font-size:10px;color:#8df0ca;">已覆盖属性: ${escapeHtml(ovrList.join(', '))}</div>` : ''}
        ${staleDiags.map(sd => `<div style="font-size:10px;color:#fbbf24;">⚠️ 失效覆盖 (${escapeHtml(sd.parameter)}): ${escapeHtml(sd.message)}</div>`).join('')}
      </div>
    `;

    const paramEntries = Object.entries(contract?.parameters || {});
    if (paramEntries.length > 0) {
      contractParamsSectionHtml = `
        <div class="prop-group">
          <div class="prop-group-title">组件契约参数 (${escapeHtml(cs.componentId)} v${escapeHtml(contractVersion)})</div>
          <div class="prop-grid">
            ${paramEntries
              .map(([pKey, pSchema]) => {
                const curVal = currentProps[pKey] !== undefined ? currentProps[pKey] : (pSchema.default ?? '');
                if (pSchema.type === 'enum' && Array.isArray(pSchema.enum)) {
                  const opts = pSchema.enum
                    .map(v => `<option value="${escapeHtml(v)}" ${String(curVal) === String(v) ? 'selected' : ''}>${escapeHtml(v)}</option>`)
                    .join('');
                  return `<div class="prop-field"><label>${escapeHtml(pKey)}</label><select class="insp-contract-param" data-param-key="${escapeHtml(pKey)}" data-param-type="enum" ${disAttr}>${opts}</select></div>`;
                }
                if (pSchema.type === 'boolean') {
                  return `<div class="prop-field"><label>${escapeHtml(pKey)}</label><select class="insp-contract-param" data-param-key="${escapeHtml(pKey)}" data-param-type="boolean" ${disAttr}><option value="true" ${curVal === true ? 'selected' : ''}>true</option><option value="false" ${curVal !== true ? 'selected' : ''}>false</option></select></div>`;
                }
                return `<div class="prop-field"><label>${escapeHtml(pKey)}</label><input class="insp-contract-param" data-param-key="${escapeHtml(pKey)}" data-param-type="${escapeHtml(pSchema.type || 'string')}" type="text" value="${escapeHtml(curVal)}" ${disAttr} /></div>`;
              })
              .join('')}
          </div>
        </div>
      `;
    }
  } else if (node.macroSource) {
    provenanceHtml = `
      <div class="provenance-banner">
        <span>⚙ 语法糖展开 (${escapeHtml(node.macroSource.macroType)})</span>
        <button id="btn-detach-macro">解绑为自由节点</button>
      </div>
    `;
  }

  // Dynamic Panel State Switcher (shown when a dynamic-panel or a node inside a dynamic-panel is selected)
  const panelNode = node.type === 'dynamic-panel'
    ? node
    : node.panelOwnerId
      ? pgScene.nodes.find(n => n.id === node.panelOwnerId)
      : null;
  const panelSectionHtml = panelNode && Array.isArray(panelNode.states)
    ? `<div class="prop-group">
        <div class="prop-group-title">动态面板状态 (${escapeHtml(panelNode.id)})</div>
        <div class="prop-field">
          <label>当前激活状态 Active State</label>
          <select id="insp-panel-state" data-panel-id="${escapeHtml(panelNode.id)}">
            ${panelNode.states
              .map(
                st => `<option value="${escapeHtml(st.id)}" ${panelNode.activeStateId === st.id ? 'selected' : ''}>${escapeHtml(st.name || st.id)} (${escapeHtml(st.id)})</option>`
              )
              .join('')}
          </select>
        </div>
      </div>`
    : '';

  // Extract existing click link target regardless of whether node.on.click is array, object, or string
  let currentLinkVal = '';
  const clickSpec = node.on?.click;
  if (typeof clickSpec === 'string') {
    currentLinkVal = clickSpec;
  } else if (Array.isArray(clickSpec)) {
    const linkAct = clickSpec.find(a => a && (a.type === 'link' || a.page || a.link || a.navigate));
    currentLinkVal = linkAct?.page || linkAct?.link || linkAct?.navigate || '';
  } else if (clickSpec && typeof clickSpec === 'object') {
    currentLinkVal = clickSpec.page || clickSpec.link || clickSpec.navigate || '';
  }

  panel.innerHTML = `
    ${errBanner}
    ${fontDiagHtml}
    ${docDiagHtml}
    ${lockedBannerHtml}
    ${provenanceHtml}
    ${contractParamsSectionHtml}
    ${panelSectionHtml}
    <div class="prop-group">
      <div class="prop-group-title">节点标识 (${escapeHtml(node.type)})</div>
      <div class="prop-grid">
        <div class="prop-field">
          <label>Node ID</label>
          <input type="text" value="${escapeHtml(node.id)}" disabled />
        </div>
        <div class="prop-field">
          <label>名称 Name</label>
          <input id="insp-node-name" type="text" value="${escapeHtml(node.name)}" ${disAttr} />
        </div>
      </div>
    </div>

    <div class="prop-group">
      <div class="prop-group-title">几何与尺寸约束</div>
      <div class="prop-grid">
        <div class="prop-field"><label>X</label><input id="insp-x" type="number" value="${node.relX}" ${disAttr} /></div>
        <div class="prop-field"><label>Y</label><input id="insp-y" type="number" value="${node.relY}" ${disAttr} /></div>
        <div class="prop-field"><label>W (数值/hug/fill)</label><input id="insp-w" type="text" value="${node.w}" ${disAttr} /></div>
        <div class="prop-field"><label>H (数值/hug/fill)</label><input id="insp-h" type="text" value="${node.h}" ${disAttr} /></div>
        <div class="prop-field"><label>圆角 Radius</label><input id="insp-radius" type="number" value="${node.radius || 0}" ${disAttr} /></div>
        <div class="prop-field"><label>不透明度 Opacity</label><input id="insp-opacity" type="number" step="0.1" min="0" max="1" value="${node.opacity ?? 1}" ${disAttr} /></div>
      </div>
    </div>

    <div class="prop-group">
      <div class="prop-group-title">容器布局 (Auto Layout / Stack)</div>
      <div class="prop-grid">
        <div class="prop-field">
          <label>布局模式</label>
          <select id="insp-layout" ${disAttr}>
            <option value="stack" ${node.layout === 'stack' || node.layout === 'free' ? 'selected' : ''}>stack (自由定位)</option>
            <option value="free" ${node.layout === 'free' ? 'selected' : ''}>free (自由定位)</option>
            <option value="row" ${node.layout === 'row' ? 'selected' : ''}>row (水平自动布局)</option>
            <option value="column" ${node.layout === 'column' ? 'selected' : ''}>column (垂直自动布局)</option>
          </select>
        </div>
        <div class="prop-field">
          <label>间距 Gap</label>
          <input id="insp-gap" type="number" value="${node.gap || 0}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>内边距 Padding</label>
          <input id="insp-padding" type="text" value="${Array.isArray(node.padding) ? node.padding.join(',') : (node.padding ?? 0)}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>交叉轴对齐 Align</label>
          <select id="insp-layout-align" ${disAttr}>
            <option value="start" ${node.align === 'start' ? 'selected' : ''}>start</option>
            <option value="center" ${node.align === 'center' ? 'selected' : ''}>center</option>
            <option value="end" ${node.align === 'end' ? 'selected' : ''}>end</option>
            <option value="stretch" ${node.align === 'stretch' ? 'selected' : ''}>stretch</option>
            <option value="first-baseline" ${node.align === 'first-baseline' ? 'selected' : ''}>first-baseline (首行基线)</option>
            <option value="last-baseline" ${node.align === 'last-baseline' ? 'selected' : ''}>last-baseline (末行基线)</option>
          </select>
        </div>
        <div class="prop-field">
          <label>主轴分布 Justify</label>
          <select id="insp-justify" ${disAttr}>
            <option value="start" ${node.justify === 'start' ? 'selected' : ''}>start</option>
            <option value="center" ${node.justify === 'center' ? 'selected' : ''}>center</option>
            <option value="end" ${node.justify === 'end' ? 'selected' : ''}>end</option>
            <option value="space-between" ${node.justify === 'space-between' ? 'selected' : ''}>space-between</option>
          </select>
        </div>
      </div>
    </div>

    <div class="prop-group">
      <div class="prop-group-title">文本与排版</div>
      <div class="prop-field">
        <label>文本内容 Text</label>
        <textarea id="insp-text" rows="2" ${disAttr}>${escapeHtml(node.rawText ?? node.text ?? '')}</textarea>
      </div>
      <div class="prop-grid">
        <div class="prop-field">
          <label>字体家族 Font</label>
          <input id="insp-font-family" type="text" value="${escapeHtml(node.fontFamily || 'PingFang SC')}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>字号 Size</label>
          <input id="insp-font-size" type="number" value="${node.fontSize || 14}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>字重 Weight</label>
          <input id="insp-font-weight" type="number" step="100" value="${node.fontWeight || 400}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>行高 LineHeight</label>
          <input id="insp-line-height" type="number" value="${node.lineHeight || 20}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>字距 Spacing</label>
          <input id="insp-letter-spacing" type="number" step="0.5" value="${node.letterSpacing || 0}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>文字对齐 TextAlign</label>
          <select id="insp-text-align" ${disAttr}>
            <option value="left" ${node.textAlign === 'left' ? 'selected' : ''}>left (左对齐)</option>
            <option value="center" ${node.textAlign === 'center' ? 'selected' : ''}>center (居中)</option>
            <option value="right" ${node.textAlign === 'right' ? 'selected' : ''}>right (右对齐)</option>
          </select>
        </div>
      </div>
    </div>

    <div class="prop-group">
      <div class="prop-group-title">高级 CSS 效果</div>
      <div class="prop-field">
        <label>渐变、遮罩、滤镜、混合、2D / 3D 变换（JSON）</label>
        <textarea id="insp-css" rows="7" spellcheck="false" ${disAttr}>${escapeHtml(JSON.stringify(node.css || {}, null, 2))}</textarea>
        <div style="font-size:11px;opacity:.7;line-height:1.5;margin:6px 0;">支持 CSS 属性名或 camelCase，可用 var(--brand) 引用色彩令牌。RP9 的兼容降级在导出时报告。</div>
        <button id="btn-apply-css" ${disAttr}>应用效果</button>
      </div>
    </div>

    <div class="prop-group">
      <div class="prop-group-title">填充、描边与文字颜色 (支持 $令牌)</div>
      <div class="prop-grid">
        <div class="prop-field">
          <label>填充 Fill</label>
          <input id="insp-fill" type="text" value="${escapeHtml(node.rawFill ?? node.fill ?? '')}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>文字色 Color</label>
          <input id="insp-color" type="text" value="${escapeHtml(node.rawColor ?? node.color ?? '')}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>描边 Stroke</label>
          <input id="insp-stroke" type="text" value="${escapeHtml(node.rawStroke ?? node.stroke ?? '')}" ${disAttr} />
        </div>
        <div class="prop-field">
          <label>跳转链接 Link</label>
          <input id="insp-link" type="text" value="${escapeHtml(currentLinkVal)}" ${disAttr} />
        </div>
      </div>
    </div>
    ${impactSummaryHtml}
  `;

  panel.querySelector('#btn-apply-css')?.addEventListener('click', async () => {
    try {
      const css = JSON.parse(panel.querySelector('#insp-css').value || '{}');
      for (const [property, value] of Object.entries(normalizeVisualCss(css))) {
        if (!property.startsWith('--') && !CSS.supports(property, value)) throw new Error(`当前浏览器不支持 ${property}: ${value}`);
      }
      await dispatchCommands({ type: 'setProperties', pageId: state.activePageId, nodeId: node.id, properties: { css } });
    } catch (err) {
      showToast(err.message, 'error', 6000);
    }
  });
  panel.querySelector('#btn-unlock-node')?.addEventListener('click', () => {
    dispatchCommands({ type: 'setProperties', pageId: state.activePageId, nodeId: node.id, properties: { locked: false } });
  });
  panel.querySelector('#btn-detach-instance')?.addEventListener('click', () => {
    dispatchCommands({ type: 'detachInstance', pageId: state.activePageId, nodeId: node.id });
  });
  panel.querySelector('#btn-reset-overrides')?.addEventListener('click', () => {
    dispatchCommands({ type: 'clearInstanceOverride', pageId: state.activePageId, nodeId: node.id });
  });
  panel.querySelector('#insp-instance-variant')?.addEventListener('change', e => {
    dispatchCommands({
      type: 'setInstanceVariant',
      pageId: state.activePageId,
      nodeId: node.componentSource?.instanceId || node.id,
      variant: e.target.value,
    });
  });
  panel.querySelector('#insp-comp-state')?.addEventListener('change', e => {
    dispatchCommands({
      type: 'set-props',
      pageId: state.activePageId,
      nodeId: node.componentSource?.instanceId || node.id,
      props: { state: e.target.value },
    });
  });
  panel.querySelectorAll('.insp-contract-param').forEach(el => {
    el.addEventListener('change', () => {
      const pKey = el.getAttribute('data-param-key');
      const pType = el.getAttribute('data-param-type');
      let parsedVal = el.value;
      if (pType === 'boolean') parsedVal = el.value === 'true';
      else if (pType === 'number') parsedVal = Number(el.value);
      dispatchCommands({
        type: 'set-props',
        pageId: state.activePageId,
        nodeId: node.componentSource?.instanceId || node.id,
        props: { props: { [pKey]: parsedVal } },
      });
    });
  });
  panel.querySelector('#insp-panel-state')?.addEventListener('change', e => {
    const pId = e.target.getAttribute('data-panel-id') || node.id;
    dispatchCommands({
      type: 'setPanelActiveState',
      pageId: state.activePageId,
      nodeId: pId,
      stateId: e.target.value,
    });
  });
  panel.querySelector('#btn-detach-macro')?.addEventListener('click', () => {
    dispatchCommands({ type: 'detachMacro', pageId: state.activePageId, nodeId: node.id });
  });
  panel.querySelector('#insp-node-name')?.addEventListener('change', e => {
    dispatchCommands({ type: 'renameNode', pageId: state.activePageId, nodeId: node.id, name: e.target.value });
  });

  const bindProp = (sel, buildCmd) => {
    const el = panel.querySelector(sel);
    if (!el) return;
    el.addEventListener('change', () => dispatchCommands(buildCmd(el.value)));
  };

  bindProp('#insp-x', val => ({ type: 'moveNode', pageId: state.activePageId, nodeId: node.id, x: Number(val), y: node.relY }));
  bindProp('#insp-y', val => ({ type: 'moveNode', pageId: state.activePageId, nodeId: node.id, x: node.relX, y: Number(val) }));
  bindProp('#insp-w', val => ({
    type: 'resizeNode',
    pageId: state.activePageId,
    nodeId: node.id,
    w: val === 'hug' || val === 'fill' ? val : Number(val),
  }));
  bindProp('#insp-h', val => ({
    type: 'resizeNode',
    pageId: state.activePageId,
    nodeId: node.id,
    h: val === 'hug' || val === 'fill' ? val : Number(val),
  }));
  bindProp('#insp-radius', val => ({
    type: 'setProperties',
    pageId: state.activePageId,
    nodeId: node.id,
    properties: { radius: Number(val) },
  }));
  bindProp('#insp-opacity', val => ({
    type: 'setProperties',
    pageId: state.activePageId,
    nodeId: node.id,
    properties: { opacity: Number(val) },
  }));
  bindProp('#insp-layout', val => ({
    type: 'switchLayoutMode',
    pageId: state.activePageId,
    nodeId: node.id,
    targetLayout: val,
    preserveVisualPositions: true,
  }));
  bindProp('#insp-gap', val => ({
    type: 'setLayout',
    pageId: state.activePageId,
    nodeId: node.id,
    gap: Number(val),
  }));
  bindProp('#insp-padding', val => ({
    type: 'setLayout',
    pageId: state.activePageId,
    nodeId: node.id,
    padding: val.includes(',') ? val.split(',').map(Number) : Number(val),
  }));
  bindProp('#insp-layout-align', val => ({
    type: 'setLayout',
    pageId: state.activePageId,
    nodeId: node.id,
    align: val,
  }));
  bindProp('#insp-justify', val => ({
    type: 'setLayout',
    pageId: state.activePageId,
    nodeId: node.id,
    justify: val,
  }));
  bindProp('#insp-text', val => ({
    type: 'setText',
    pageId: state.activePageId,
    nodeId: node.id,
    text: val,
  }));
  bindProp('#insp-font-family', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    fontFamily: val.trim(),
  }));
  bindProp('#insp-font-size', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    fontSize: Number(val),
  }));
  bindProp('#insp-font-weight', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    fontWeight: Number(val),
  }));
  bindProp('#insp-line-height', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    lineHeight: Number(val),
  }));
  bindProp('#insp-letter-spacing', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    letterSpacing: Number(val),
  }));
  bindProp('#insp-text-align', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    align: val,
  }));
  bindProp('#insp-fill', val => ({
    type: 'setProperties',
    pageId: state.activePageId,
    nodeId: node.id,
    properties: { fill: val.trim() },
  }));
  bindProp('#insp-color', val => ({
    type: 'setProperties',
    pageId: state.activePageId,
    nodeId: node.id,
    properties: { color: val.trim() },
  }));
  bindProp('#insp-stroke', val => ({
    type: 'setProperties',
    pageId: state.activePageId,
    nodeId: node.id,
    properties: { stroke: val.trim() },
  }));
  bindProp('#insp-link', val => {
    const trimmed = val.trim();
    const existingList = Array.isArray(node.on?.click) ? node.on.click.filter(a => a && a.type !== 'link' && !a.link && !a.page) : [];
    const nextActions = trimmed ? [...existingList, { type: 'link', page: trimmed }] : existingList;
    return {
      type: 'setInteraction',
      pageId: state.activePageId,
      nodeId: node.id,
      event: 'click',
      actions: nextActions,
    };
  });
}

function renderAll() {
  updateTopbarStatus();
  renderCanvasStage();
  renderSidebar();
  renderInspector();
  renderSelectionOverlay();
}

function openInlineTextEditor(node) {
  const editor = document.getElementById('inline-text-editor');
  const pg = getActivePageScene();
  if (!editor || !pg || !node) return;

  state.editingNodeId = node.id;
  const originX = (pg._stageX ?? 60) + pg.board.shellPad;
  const originY = (pg._stageY ?? 40) + pg.board.shellPad;
  const bounds = nodeViewportBounds(node);
  const vx = Math.round(bounds?.x ?? ((originX + node.x) * state.zoom + state.panX));
  const vy = Math.round(bounds?.y ?? ((originY + node.y) * state.zoom + state.panY));
  const vw = Math.max(80, Math.round(bounds?.w ?? (node.w * state.zoom)));
  const vh = Math.max(28, Math.round(bounds?.h ?? (node.h * state.zoom)));

  editor.style.display = 'block';
  editor.style.left = `${vx}px`;
  editor.style.top = `${vy}px`;
  editor.style.width = `${vw}px`;
  editor.style.height = `${vh}px`;
  editor.style.fontSize = `${Math.round((node.fontSize || 14) * state.zoom)}px`;
  editor.value = node.rawText ?? node.text ?? '';
  editor.focus();
  editor.select();
}

async function commitInlineTextEditor(cancel = false) {
  const editor = document.getElementById('inline-text-editor');
  if (!editor || !state.editingNodeId) return;
  const targetId = state.editingNodeId;
  const newText = editor.value;
  state.editingNodeId = null;
  editor.style.display = 'none';
  if (!cancel) {
    await dispatchCommands({
      type: 'setText',
      pageId: state.activePageId,
      nodeId: targetId,
      text: newText,
    });
  }
}

function setupCanvasInteractions() {
  const viewport = document.getElementById('canvas-viewport');
  const editor = document.getElementById('inline-text-editor');

  // IME Composition protection
  editor.addEventListener('compositionstart', () => {
    state.isComposing = true;
  });
  editor.addEventListener('compositionend', () => {
    state.isComposing = false;
  });
  editor.addEventListener('keydown', e => {
    e.stopPropagation();
    if (state.isComposing || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      commitInlineTextEditor(true);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitInlineTextEditor(false);
    }
  });
  editor.addEventListener('blur', () => {
    if (!state.isComposing && state.editingNodeId) {
      commitInlineTextEditor(false);
    }
  });

  // Wheel Pan & Zoom
  viewport.addEventListener(
    'wheel',
    e => {
      if (e.target.closest('[data-workspace-chrome]')) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        state.zoom = Math.min(4, Math.max(0.25, Number((state.zoom * factor).toFixed(3))));
      } else {
        state.panX -= e.deltaX;
        state.panY -= e.deltaY;
      }
      updateCanvasTransform();
    },
    { passive: false }
  );

  // Mouse Down on Viewport (Resize, Select, Drag, or Marquee)
  viewport.addEventListener('mousedown', async e => {
    if (e.target.closest('[data-workspace-chrome]')) return;
    if (e.target === editor) return;
    if (state.editingNodeId && !state.isComposing) {
      await commitInlineTextEditor(false);
    }

    const pageHeader = e.target.closest('[data-select-page]');
    if (pageHeader) {
      state.activePageId = pageHeader.getAttribute('data-select-page');
      state.selectedIds = [];
      renderAll();
      return;
    }

    if (state.mode === 'interact') {
      let nodeEl = e.target.closest('.studio-node');
      const nodes = state.runtimeState?.activePageScene?.nodes || [];
      while (nodeEl) {
        const node = nodes.find(n => n.id === nodeEl.dataset.nodeId);
        if (node?.interactive === false || node?.on?.click) break;
        nodeEl = nodeEl.parentElement?.closest('.studio-node');
      }
      if (nodeEl && nodeEl.tagName !== 'INPUT') {
        const nodeId = nodeEl.getAttribute('data-node-id');
        try {
          const res = await apiPost('/api/runtime/click', { targetId: nodeId });
          state.runtimeState = res.state;
          state.activePageId = res.state.currentPageId;
          renderCanvasStage();
          renderInspector();
        } catch {
          // Ignore non-interactive node clicks
        }
      }
      return;
    }

    const vpRect = viewport.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const pg = getActivePageScene();
    if (!pg) return;

    // Space + drag or middle-click -> Pan canvas
    if (state.spacePressed || state.tool === 'pan' || e.button === 1) {
      state.dragSession = {
        kind: 'pan',
        startClientX,
        startClientY,
        origPanX: state.panX,
        origPanY: state.panY,
      };
      return;
    }

    // 1. Check resize handle
    const handleEl = e.target.closest('[data-resize-handle]');
    if (handleEl) {
      const dir = handleEl.getAttribute('data-resize-handle');
      const nodeId = handleEl.getAttribute('data-node-id');
      const node = pg.nodes.find(n => n.id === nodeId);
      if (!node || node.locked) return;
      state.dragSession = {
        kind: 'resize',
        mapPointer: pointerMapper(document.querySelector(`.studio-node[data-scoped-id="${CSS.escape(node.scopedId)}"]`)),
        dir,
        nodeId,
        startClientX,
        startClientY,
        origRelX: node.relX,
        origRelY: node.relY,
        origScreenX: node.x,
        origScreenY: node.y,
        curRelX: node.relX,
        curRelY: node.relY,
        origW: node.w,
        origH: node.h,
        curW: node.w,
        curH: node.h,
      };
      return;
    }

    // 2. Check studio node hit
    const nodeEl = e.target.closest('.studio-node');
    if (nodeEl) {
      const pageId = nodeEl.getAttribute('data-page-id');
      const nodeId = nodeEl.getAttribute('data-node-id');
      if (pageId && pageId !== state.activePageId) {
        state.activePageId = pageId;
      }
      const activePg = getActivePageScene();
      const node = activePg?.nodes.find(n => n.id === nodeId);
      if (!node || node.locked) return;

      if (e.shiftKey) {
        if (state.selectedIds.includes(nodeId)) {
          state.selectedIds = state.selectedIds.filter(x => x !== nodeId);
        } else {
          state.selectedIds.push(nodeId);
        }
      } else if (!state.selectedIds.includes(nodeId)) {
        state.selectedIds = [nodeId];
      }

      renderSidebar();
      renderSelectionOverlay();
      renderInspector();

      const isAutoLayoutChild = node.parentLayout === 'row' || node.parentLayout === 'column';
      const multiItems = !isAutoLayoutChild && state.selectedIds.length > 1
        ? state.selectedIds
            .map(id => {
              const sn = activePg?.nodes.find(x => x.id === id);
              if (!sn || sn.locked || sn.parentLayout === 'row' || sn.parentLayout === 'column') return null;
              return {
                id: sn.id,
                node: sn,
                origRelX: sn.relX,
                origRelY: sn.relY,
                origScreenX: sn.x,
                origScreenY: sn.y,
                curRelX: sn.relX,
                curRelY: sn.relY,
                el: document.querySelector(`#screen-root .studio-node[data-node-id="${CSS.escape(sn.id)}"]`),
              };
            })
            .filter(Boolean)
        : null;

      state.dragSession = {
        kind: 'move',
        mapPointer: pointerMapper(nodeEl),
        nodeId,
        startClientX,
        startClientY,
        moved: false,
        isAutoLayoutChild,
        parentId: node.parentId,
        parentLayout: node.parentLayout,
        targetIndex: null,
        origRelX: node.relX,
        origRelY: node.relY,
        origScreenX: node.x,
        origScreenY: node.y,
        curRelX: node.relX,
        curRelY: node.relY,
        multiItems,
        el: nodeEl,
      };
      return;
    }

    // 3. Empty canvas -> Marquee rubber-band selection
    const prevSelectedIds = e.shiftKey ? [...state.selectedIds] : [];
    if (!e.shiftKey) {
      state.selectedIds = [];
      renderSidebar();
      renderSelectionOverlay();
      renderInspector();
    }
    state.dragSession = {
      kind: 'marquee',
      startClientX,
      startClientY,
      vpLeft: vpRect.left,
      vpTop: vpRect.top,
      prevSelectedIds,
    };
  });

  window.addEventListener('mousemove', e => {
    if (!state.dragSession) return;
    const ds = state.dragSession;

    if (ds.kind === 'pan') {
      state.panX = ds.origPanX + (e.clientX - ds.startClientX);
      state.panY = ds.origPanY + (e.clientY - ds.startClientY);
      updateCanvasTransform();
      return;
    }

    const mappedStart = ds.mapPointer?.(ds.startClientX, ds.startClientY);
    const mappedNow = ds.mapPointer?.(e.clientX, e.clientY);
    const dx = mappedNow ? mappedNow.x - mappedStart.x : (e.clientX - ds.startClientX) / state.zoom;
    const dy = mappedNow ? mappedNow.y - mappedStart.y : (e.clientY - ds.startClientY) / state.zoom;

    if (ds.kind === 'move') {
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) ds.moved = true;
      const pg = getActivePageScene();
      const node = pg?.nodes.find(n => n.id === ds.nodeId);
      state.snapGuides = [];

      if (ds.isAutoLayoutChild && pg && node) {
        // Auto-layout child drag: compute target sibling order instead of mutating absolute coordinates
        const siblings = pg.nodes.filter(n => n.parentId === ds.parentId && n.visible);
        const curCenterX = ds.origScreenX + dx + node.w / 2;
        const curCenterY = ds.origScreenY + dy + node.h / 2;
        let targetIdx = 0;
        for (let i = 0; i < siblings.length; i++) {
          const sib = siblings[i];
          const sibMid = ds.parentLayout === 'row' ? sib.x + sib.w / 2 : sib.y + sib.h / 2;
          const curVal = ds.parentLayout === 'row' ? curCenterX : curCenterY;
          if (curVal > sibMid) targetIdx = i;
        }
        ds.targetIndex = targetIdx;
        const refSib = siblings[targetIdx];
        if (refSib) {
          state.snapGuides.push(
            ds.parentLayout === 'row'
              ? { axis: 'x', pos: Math.round(refSib.x) }
              : { axis: 'y', pos: Math.round(refSib.y) }
          );
        }
        renderSelectionOverlay();
        return;
      }

      if (ds.multiItems && ds.multiItems.length > 1) {
        const roundDx = Math.round(dx);
        const roundDy = Math.round(dy);
        for (const item of ds.multiItems) {
          item.curRelX = item.origRelX + roundDx;
          item.curRelY = item.origRelY + roundDy;
          const screenX = item.origScreenX + roundDx;
          const screenY = item.origScreenY + roundDy;
          item.node.x = screenX;
          item.node.y = screenY;
          if (item.el) {
            positionNodeElement(item.el, item.node, pg);
          }
        }
        renderSelectionOverlay();
        return;
      }

      let roundDx = Math.round(dx);
      const roundDy = Math.round(dy);
      let nextScreenX = ds.origScreenX + roundDx;
      const nextScreenY = ds.origScreenY + roundDy;

      if (pg && node) {
        const centerTargetX = Math.round((pg.board.screenW - node.w) / 2);
        if (Math.abs(nextScreenX - centerTargetX) <= 4) {
          roundDx = centerTargetX - ds.origScreenX;
          nextScreenX = centerTargetX;
          state.snapGuides.push({ axis: 'x', pos: Math.round(pg.board.screenW / 2) });
        }
        node.x = nextScreenX;
        node.y = nextScreenY;
      }
      ds.curRelX = ds.origRelX + roundDx;
      ds.curRelY = ds.origRelY + roundDy;
      if (ds.el) {
        positionNodeElement(ds.el, node, pg);
      }
      renderSelectionOverlay();
    } else if (ds.kind === 'resize') {
      const pg = getActivePageScene();
      const node = pg?.nodes.find(n => n.id === ds.nodeId);
      let nextW = ds.origW;
      let nextH = ds.origH;
      let nextRelX = ds.origRelX;
      let nextRelY = ds.origRelY;
      let nextScreenX = ds.origScreenX;
      let nextScreenY = ds.origScreenY;

      if (ds.dir.includes('e')) nextW = Math.max(12, Math.round(ds.origW + dx));
      if (ds.dir.includes('s')) nextH = Math.max(12, Math.round(ds.origH + dy));
      if (ds.dir.includes('w')) {
        nextW = Math.max(12, Math.round(ds.origW - dx));
        const deltaW = ds.origW - nextW;
        nextRelX = Math.round(ds.origRelX + deltaW);
        nextScreenX = Math.round(ds.origScreenX + deltaW);
      }
      if (ds.dir.includes('n')) {
        nextH = Math.max(12, Math.round(ds.origH - dy));
        const deltaH = ds.origH - nextH;
        nextRelY = Math.round(ds.origRelY + deltaH);
        nextScreenY = Math.round(ds.origScreenY + deltaH);
      }
      ds.curW = nextW;
      ds.curH = nextH;
      ds.curRelX = nextRelX;
      ds.curRelY = nextRelY;
      if (node) {
        node.x = nextScreenX;
        node.y = nextScreenY;
        node.w = nextW;
        node.h = nextH;
      }
      const el = document.querySelector(`#screen-root .studio-node[data-node-id="${CSS.escape(ds.nodeId)}"]`);
      if (el) {
        positionNodeElement(el, node, pg);
        el.style.width = `${nextW}px`;
        el.style.height = `${nextH}px`;
      }
      renderSelectionOverlay();
    } else if (ds.kind === 'marquee') {
      const mq = document.getElementById('marquee-box');
      const x1 = Math.min(ds.startClientX, e.clientX) - ds.vpLeft;
      const y1 = Math.min(ds.startClientY, e.clientY) - ds.vpTop;
      const w = Math.abs(e.clientX - ds.startClientX);
      const h = Math.abs(e.clientY - ds.startClientY);
      mq.style.display = 'block';
      mq.style.left = `${x1}px`;
      mq.style.top = `${y1}px`;
      mq.style.width = `${w}px`;
      mq.style.height = `${h}px`;
    }
  });

  window.addEventListener('mouseup', async e => {
    if (!state.dragSession) return;
    const ds = state.dragSession;
    state.dragSession = null;
    state.snapGuides = [];

    if (ds.kind === 'move' && ds.moved) {
      if (ds.isAutoLayoutChild && typeof ds.targetIndex === 'number') {
        await dispatchCommands({
          type: 'reorderNode',
          pageId: state.activePageId,
          nodeId: ds.nodeId,
          toIndex: ds.targetIndex,
        });
      } else if (ds.multiItems && ds.multiItems.length > 1) {
        await dispatchCommands(
          ds.multiItems.map(item => ({
            type: 'moveNode',
            pageId: state.activePageId,
            nodeId: item.id,
            x: item.curRelX,
            y: item.curRelY,
          }))
        );
      } else {
        await dispatchCommands({
          type: 'moveNode',
          pageId: state.activePageId,
          nodeId: ds.nodeId,
          x: ds.curRelX,
          y: ds.curRelY,
        });
      }
    } else if (
      ds.kind === 'resize' &&
      (ds.curW !== ds.origW || ds.curH !== ds.origH || ds.curRelX !== ds.origRelX || ds.curRelY !== ds.origRelY)
    ) {
      await dispatchCommands({
        type: 'resizeNode',
        pageId: state.activePageId,
        nodeId: ds.nodeId,
        x: ds.curRelX,
        y: ds.curRelY,
        w: ds.curW,
        h: ds.curH,
      });
    } else if (ds.kind === 'marquee') {
      const mq = document.getElementById('marquee-box');
      mq.style.display = 'none';
      const x1 = Math.min(ds.startClientX, e.clientX);
      const y1 = Math.min(ds.startClientY, e.clientY);
      const x2 = Math.max(ds.startClientX, e.clientX);
      const y2 = Math.max(ds.startClientY, e.clientY);
      if (x2 - x1 > 6 && y2 - y1 > 6) {
        const pg = getActivePageScene();
        const hits = new Set(ds.prevSelectedIds || []);
        document.querySelectorAll(`#screen-root .studio-node`).forEach(el => {
          if (el.getAttribute('data-locked') === 'true') return;
          const nId = el.getAttribute('data-node-id');
          const nObj = pg?.nodes.find(x => x.id === nId);
          // Skip full-screen background containers unless explicitly clicked
          if (nObj && nObj.depth <= 1 && nObj.w >= (pg?.board.screenW || 402) - 4 && nObj.h >= (pg?.board.screenH || 874) - 4) {
            return;
          }
          const r = el.getBoundingClientRect();
          const intersects = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
          if (intersects && nId) {
            hits.add(nId);
          }
        });
        state.selectedIds = [...hits];
        renderSidebar();
        renderSelectionOverlay();
        renderInspector();
      }
    }
  });

  // Double click on text node -> inline text editing
  viewport.addEventListener('dblclick', e => {
    if (state.mode !== 'design') return;
    const nodeEl = e.target.closest('.studio-node');
    if (!nodeEl) return;
    const nodeId = nodeEl.getAttribute('data-node-id');
    const pg = getActivePageScene();
    const node = pg?.nodes.find(n => n.id === nodeId);
    if (!node || node.locked) return;
    if (['label', 'paragraph', 'button', 'input'].includes(node.type)) {
      openInlineTextEditor(node);
    }
  });

  window.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      state.spacePressed = false;
      updateWorkspaceChrome();
    }
  });

  // Global keyboard shortcuts with strict input-focus suppression
  window.addEventListener('keydown', async e => {
    if (isInputFocused() || state.isComposing || e.isComposing) return;

    if (!e.metaKey && !e.ctrlKey && !e.altKey && state.mode === 'design' && ['v', 'h'].includes(e.key.toLowerCase())) {
      state.tool = e.key.toLowerCase() === 'h' ? 'pan' : 'select';
      updateWorkspaceChrome();
      return;
    }

    if (e.code === 'Space') {
      state.spacePressed = true;
      viewport.style.cursor = 'grab';
      return;
    }

    if (e.key === 'Escape') {
      if (state.selectedIds.length > 0) {
        state.selectedIds = [];
        renderSidebar();
        renderSelectionOverlay();
        renderInspector();
      }
      return;
    }

    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      const endpoint = e.shiftKey ? '/api/redo' : '/api/undo';
      const res = await apiPost(endpoint, { clientId: state.clientId });
      if (res.doc && res.scene) await applyServerSnapshot(res);
      return;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedIds.length > 0) {
      e.preventDefault();
      const pg = getActivePageScene();
      const unlockedIds = state.selectedIds.filter(id => {
        const n = pg?.nodes.find(item => item.id === id);
        return !n?.locked;
      });
      if (unlockedIds.length === 0) {
        showToast('节点已锁定，无法删除', 'warn', 2400);
        return;
      }
      const cmds = unlockedIds.map(id => ({
        type: 'deleteNode',
        pageId: state.activePageId,
        nodeId: id,
      }));
      const res = await dispatchCommands(cmds);
      if (res) {
        state.selectedIds = state.selectedIds.filter(id => !unlockedIds.includes(id));
        renderAll();
      }
      return;
    }

    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && state.selectedIds.length > 0) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const pg = getActivePageScene();
      const cmds = state.selectedIds
        .map(id => pg?.nodes.find(n => n.id === id))
        .filter(n => n && !n.locked && n.parentLayout !== 'row' && n.parentLayout !== 'column')
        .map(n => ({
          type: 'moveNode',
          pageId: state.activePageId,
          nodeId: n.id,
          x: n.relX + dx,
          y: n.relY + dy,
        }));
      if (cmds.length > 0) await dispatchCommands(cmds);
      return;
    }

    if (isMod && e.key.toLowerCase() === 'd' && state.selectedIds.length > 0) {
      e.preventDefault();
      const cmds = state.selectedIds.map(id => ({
        type: 'duplicateNode',
        pageId: state.activePageId,
        nodeId: id,
      }));
      const res = await dispatchCommands(cmds);
      if (Array.isArray(res?.affectedNodeIds) && res.affectedNodeIds.length > 0) {
        state.selectedIds = res.affectedNodeIds.map(s => String(s).split('/').pop());
        renderSidebar();
        renderSelectionOverlay();
        renderInspector();
      }
      return;
    }

    if (isMod && e.key.toLowerCase() === 'c' && state.selectedIds.length > 0) {
      e.preventDefault();
      state.clipboardNodes = [...state.selectedIds];
      showToast(`已复制 ${state.clipboardNodes.length} 个节点`, 'info', 1800);
      return;
    }

    if (isMod && e.key.toLowerCase() === 'v' && state.clipboardNodes.length > 0) {
      e.preventDefault();
      const cmds = state.clipboardNodes.map(id => ({
        type: 'duplicateNode',
        pageId: state.activePageId,
        nodeId: id,
        offset: { x: 20, y: 20 },
      }));
      const res = await dispatchCommands(cmds);
      if (Array.isArray(res?.affectedNodeIds) && res.affectedNodeIds.length > 0) {
        state.selectedIds = res.affectedNodeIds.map(s => String(s).split('/').pop());
        renderSidebar();
        renderSelectionOverlay();
        renderInspector();
      }
    }
  });
}

function setupToolbarAndTabs() {
  document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
    state.tool = button.dataset.tool;
    updateWorkspaceChrome();
  }));
  document.getElementById('layer-search')?.addEventListener('input', event => {
    state.layerFilter = event.target.value;
    renderSidebar();
  });
  document.getElementById('btn-all-properties')?.addEventListener('click', () => {
    state.inspectorAll = !state.inspectorAll;
    renderInspector();
  });
  document.getElementById('btn-history')?.addEventListener('click', () => {
    state.showHistory = !state.showHistory;
    renderInspector();
    document.getElementById('inspector-panel').scrollTop = 0;
  });
  document.getElementById('narrow-continue')?.addEventListener('click', () => {
    document.body.classList.add('compact-preview');
    document.body.style.setProperty('--compact-scale', String(window.innerWidth / 1280));
    fitWorkspace(true);
  });
  document.querySelectorAll('#mode-switcher button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('#mode-switcher button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.getAttribute('data-mode');
      if (state.mode === 'interact') {
        const res = await apiPost('/api/runtime/reset', { startPageId: state.activePageId });
        state.runtimeState = res.state;
      }
      renderAll();
      fitWorkspace();
    });
  });

  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.sidebarTab = tab.getAttribute('data-tab');
      renderSidebar();
    });
  });

  document.getElementById('btn-undo')?.addEventListener('click', async () => {
    const res = await apiPost('/api/undo', { clientId: state.clientId });
    if (res.doc && res.scene) await applyServerSnapshot(res);
  });

  document.getElementById('btn-redo')?.addEventListener('click', async () => {
    const res = await apiPost('/api/redo', { clientId: state.clientId });
    if (res.doc && res.scene) await applyServerSnapshot(res);
  });

  document.getElementById('btn-add-box')?.addEventListener('click', async () => {
    const newId = `box_${Date.now().toString(36).slice(-4)}`;
    state.selectedIds = [newId];
    await dispatchCommands({
      type: 'addNode',
      pageId: state.activePageId,
      node: {
        type: 'box',
        id: newId,
        name: '新建容器',
        x: 32,
        y: 120,
        w: 180,
        h: 96,
        radius: 16,
        fill: '$surface',
        stroke: '$line',
      },
    });
  });

  document.getElementById('btn-add-text')?.addEventListener('click', async () => {
    const newId = `text_${Date.now().toString(36).slice(-4)}`;
    state.selectedIds = [newId];
    await dispatchCommands({
      type: 'addNode',
      pageId: state.activePageId,
      node: {
        type: 'label',
        id: newId,
        name: '新建文本',
        text: '双击编辑文本内容',
        x: 32,
        y: 80,
        w: 'hug',
        h: 'hug',
        fontSize: 16,
        fontWeight: 600,
        color: '$ink',
      },
    });
  });

  document.getElementById('btn-add-btn')?.addEventListener('click', async () => {
    const newId = `btn_${Date.now().toString(36).slice(-4)}`;
    state.selectedIds = [newId];
    await dispatchCommands({
      type: 'addNode',
      pageId: state.activePageId,
      node: {
        type: 'button',
        id: newId,
        name: '新建按钮',
        text: '主要操作',
        x: 32,
        y: 240,
        w: 132,
        h: 40,
        radius: 20,
        fill: '$brand',
        color: '#FFFFFF',
      },
    });
  });

  document.getElementById('btn-make-comp')?.addEventListener('click', async () => {
    if (!state.selectedIds.length) return;
    const nodeId = state.selectedIds[0];
    const compId = `comp_${nodeId}`;
    await dispatchCommands({
      type: 'createComponent',
      pageId: state.activePageId,
      nodeId,
      componentId: compId,
      name: `组件 ${nodeId}`,
      replaceWithInstance: true,
    });
    showToast(`✓ 已提炼组件 "${compId}" 并转换为实例`, 'info', 2500);
  });

  document.getElementById('btn-align-left')?.addEventListener('click', () => {
    if (state.selectedIds.length < 2) return;
    const pg = getActivePageScene();
    const nodes = state.selectedIds.map(id => pg.nodes.find(n => n.id === id)).filter(Boolean);
    const minX = Math.min(...nodes.map(n => n.relX));
    dispatchCommands(nodes.map(n => ({ type: 'moveNode', pageId: state.activePageId, nodeId: n.id, x: minX, y: n.relY })));
  });

  document.getElementById('btn-align-top')?.addEventListener('click', () => {
    if (state.selectedIds.length < 2) return;
    const pg = getActivePageScene();
    const nodes = state.selectedIds.map(id => pg.nodes.find(n => n.id === id)).filter(Boolean);
    const minY = Math.min(...nodes.map(n => n.relY));
    dispatchCommands(nodes.map(n => ({ type: 'moveNode', pageId: state.activePageId, nodeId: n.id, x: n.relX, y: minY })));
  });

  document.getElementById('btn-align-center')?.addEventListener('click', () => {
    if (state.selectedIds.length < 1) return;
    const pg = getActivePageScene();
    const nodes = state.selectedIds.map(id => pg.nodes.find(n => n.id === id)).filter(Boolean);
    if (nodes.length === 1) {
      const n = nodes[0];
      dispatchCommands({
        type: 'moveNode',
        pageId: state.activePageId,
        nodeId: n.id,
        x: Math.round((pg.board.screenW - n.w) / 2),
        y: n.relY,
      });
      return;
    }
    const minLeft = Math.min(...nodes.map(n => n.relX));
    const maxRight = Math.max(...nodes.map(n => n.relX + n.w));
    const midX = (minLeft + maxRight) / 2;
    dispatchCommands(
      nodes.map(n => ({
        type: 'moveNode',
        pageId: state.activePageId,
        nodeId: n.id,
        x: Math.round(midX - n.w / 2),
        y: n.relY,
      }))
    );
  });

  document.getElementById('btn-distribute-h')?.addEventListener('click', () => {
    if (state.selectedIds.length < 3) return;
    const pg = getActivePageScene();
    const nodes = state.selectedIds
      .map(id => pg.nodes.find(n => n.id === id))
      .filter(Boolean)
      .sort((a, b) => a.relX - b.relX);
    const minLeft = nodes[0].relX;
    const maxRight = Math.max(...nodes.map(n => n.relX + n.w));
    const totalWidths = nodes.reduce((sum, n) => sum + n.w, 0);
    const gap = (maxRight - minLeft - totalWidths) / (nodes.length - 1);
    let curX = minLeft;
    const cmds = nodes.map(n => {
      const cmd = {
        type: 'moveNode',
        pageId: state.activePageId,
        nodeId: n.id,
        x: Math.round(curX),
        y: n.relY,
      };
      curX += n.w + gap;
      return cmd;
    });
    dispatchCommands(cmds);
  });

  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    state.zoom = Math.min(4, Number((state.zoom + 0.15).toFixed(2)));
    updateCanvasTransform();
  });

  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    state.zoom = Math.max(0.25, Number((state.zoom - 0.15).toFixed(2)));
    updateCanvasTransform();
  });

  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
    fitWorkspace();
  });

  document.getElementById('btn-export-rp')?.addEventListener('click', async () => {
    showToast('正在导出 Axure RP 9 原生 .rp...', 'info', 8000);
    try {
      const res = await apiPost('/api/export-rp', {});
      showToast(
        `✓ 已导出原生 .rp: ${res.outRpPath} (三零检查: ${res.report.summary.threeZerosPassed ? 'PASS' : 'FAIL'})`,
        res.report.summary.threeZerosPassed ? 'info' : 'warn',
        5000
      );
    } catch (err) {
      showToast(`✗ 导出失败: ${err.message}`, 'error', 5000);
    }
  });
}

function connectSseStream() {
  if (state.sse) {
    try { state.sse.close(); } catch {}
  }
  const es = new EventSource(`/api/events?clientId=${encodeURIComponent(state.clientId)}`);
  state.sse = es;

  es.onopen = () => {
    state.connected = true;
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
    if (pageId) state.activePageId = pageId;
    state.selectedIds = Array.isArray(ids) ? ids : [ids];
    renderAll();
  },
};

bootstrap();
