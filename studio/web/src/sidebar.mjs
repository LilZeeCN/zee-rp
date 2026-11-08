import { escapeHtml, uiIcon } from './ui.mjs';
import { apiPost, dispatchCommands } from './api.mjs';
import { fitWorkspace, getActivePageScene, layerDisplayName, padList, revealActiveArtboard, updateWorkspaceChrome } from './view.mjs';
import { renderAll, renderSelectionOverlay } from './render.mjs';
import { renderInspector } from './inspector.mjs';
import { cancelCanvasGesture } from './gestures.mjs';
import { state } from './state.mjs';

export function renderSidebar() {
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
          <div class="list-item-row ${isSel ? 'selected' : ''}" data-layer-select="${escapeHtml(n.id)}" draggable="true" style="padding-left:${9 + indent}px;" title="${escapeHtml(n.name || n.id)} (${escapeHtml(n.id)})" tabindex="0">
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
      const result = await dispatchCommands({ type: 'addPage', pageId: newPageId, name: `页面 ${nextIdx}`, autoUniqueId: true });
      state.activePageId = result.semanticDiff?.structureChanges?.find(change => change.kind === 'page-added')?.pageId || newPageId;
      state.selectedIds = [];
      renderAll();
      fitWorkspace();
    });

    container.querySelectorAll('[data-page-select]').forEach(el => {
      el.addEventListener('click', async e => {
        if (e.target.closest('button, summary')) return;
        const nextPageId = el.getAttribute('data-page-select');
        cancelCanvasGesture({ render: false });
        state.activePageId = nextPageId;
        state.selectedIds = [];
        if (state.mode === 'interact') {
          try {
            const res = await apiPost('/api/runtime/navigate', { pageId: nextPageId });
            state.runtimeState = res.state;
          } catch {}
        }
        renderAll();
        revealActiveArtboard();
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
      // 图层行拖拽换父：拖到目标容器行释放 → reorderNode 重挂并保持视觉位置
      el.addEventListener('dragstart', e => {
        state.dragLayerId = el.getAttribute('data-layer-select');
        e.dataTransfer.setData('text/plain', state.dragLayerId);
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        state.dragLayerId = null;
        container.querySelectorAll('.drop-target').forEach(row => row.classList.remove('drop-target'));
      });
      el.addEventListener('dragover', e => {
        const dragId = state.dragLayerId;
        if (!dragId || dragId === el.getAttribute('data-layer-select')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drop-target');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', async e => {
        e.preventDefault();
        el.classList.remove('drop-target');
        const dragId = state.dragLayerId || e.dataTransfer.getData('text/plain');
        state.dragLayerId = null;
        const targetId = el.getAttribute('data-layer-select');
        if (!dragId || dragId === targetId || !pgScene) return;
        const dragged = pgScene.nodes.find(n => n.id === dragId);
        const target = pgScene.nodes.find(n => n.id === targetId);
        if (!dragged || !target || dragged.parentId === target.id) return;
        if (!['box', 'card', 'phone-shell'].includes(target.type) || target.locked) return;
        const cmds = [{ type: 'reorderNode', pageId: state.activePageId, nodeId: dragId, parentId: target.id }];
        if (!['row', 'column', 'grid'].includes(target.layout)) {
          const pad = padList(target.padding);
          cmds.push({
            type: 'moveNode',
            pageId: state.activePageId,
            nodeId: dragId,
            x: Math.round(dragged.x - target.x - pad[3]),
            y: Math.round(dragged.y - target.y - pad[0]),
          });
        }
        await dispatchCommands(cmds);
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
            f => `<div class="list-item-row"><span>🔤 ${escapeHtml(f.family)}</span><span style="opacity:0.6;">${state.projectFontErrors?.some(error => error.family === f.family) ? '加载失败，已回退' : (f.weights || []).join('/')}</span></div>`
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
