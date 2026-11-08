import { visualCss } from '/visual-style.mjs';
import { escapeHtml, renderIconSvg } from './ui.mjs';
import { apiPost } from './api.mjs';
import { getActivePageScene, nodeViewportBounds, updateCanvasTransform, updateTopbarStatus, workspaceBounds } from './view.mjs';
import { renderSidebar } from './sidebar.mjs';
import { renderInspector } from './inspector.mjs';
import { state } from './state.mjs';

export let boardMountFrame = null;

export function shouldMountPage(pg) {
  if (pg.id === state.activePageId) return true;
  if (state.zoom < 0.15) return false; // Distant board overviews need outlines, not thousands of unreadable DOM labels.
  const view=workspaceBounds(), margin=160;
  const x=state.panX+(pg._stageX ?? 60)*state.zoom, y=state.panY+(pg._stageY ?? 40)*state.zoom;
  return x+pg.board.totalW*state.zoom>=view.left-margin && x<=view.left+view.width+margin
    && y+pg.board.totalH*state.zoom>=view.top-margin && y<=view.top+view.height+margin;
}

export function scheduleBoardMounts() {
  if (boardMountFrame !== null || state.mode !== 'design' || state.scene?.pages.length < 2) return;
  boardMountFrame=requestAnimationFrame(()=>{
    boardMountFrame=null;
    if (state.mode !== 'design' || state.editingNodeId || (state.dragSession && state.dragSession.kind !== 'pan')) return;
    const mounted=new Map([...document.querySelectorAll('.artboard-wrapper')].map(el=>[el.dataset.artboardId,el.dataset.nodesMounted==='true']));
    if (state.scene.pages.some(pg=>mounted.get(pg.id)!==shouldMountPage(pg))) renderCanvasStage();
  });
}

export function renderTextContentHtml(n) {
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
        const spDeco = [sp.underline ? 'underline' : '', sp.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ');
        if (spDeco) spStyles.push(`text-decoration:${spDeco}`);
        const stAttr = spStyles.length > 0 ? ` style="${spStyles.join(';')}"` : '';
        return `<span class="studio-text-span"${stAttr}>${escapeHtml(sp.text ?? '')}</span>`;
      })
      .join('');
  }
  return escapeHtml(n.text);
}

export function buildNodeElementHtml(n, pageId, childrenHtml = '', parent = null) {
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
    `color:${n.color || 'var(--ink, #203B32)'}`,
    `text-align:${n.textAlign || 'left'}`,
    `z-index:${typeof n.z === 'number' ? n.z : (n.renderOrder || n.depth || 1)}`,
  ];
  if (state.mode === 'interact' && (n.on?.click || n.type === 'button')) {
    styles.push('cursor:pointer');
  }
  if (n.type !== 'path' && n.fill && n.fill !== '#FFFFFF00') styles.push(`background:${n.fill}`);
  const hasSideBorders = n.borderSides || n.borderTop || n.borderRight || n.borderBottom || n.borderLeft;
  const transparent = value => !value || value === 'transparent' || /^#[\da-f]{6}00$/i.test(value);
  // Prototype-only leaf hit areas remain selectable in Layers and active in Preview.
  if (state.mode === 'design' && n.type === 'box' && n.on?.click && !n.childrenIds?.length && !n.text
    && transparent(n.fill) && transparent(n.stroke) && !hasSideBorders
    && !n.css?.background && !n.css?.backgroundImage && !n.css?.boxShadow) styles.push('pointer-events:none');
  if (hasSideBorders) {
    const borderColor = n.stroke && n.stroke !== '#FFFFFF00' ? n.stroke : 'var(--line, #E3E7DC)';
    const borderW = n.strokeWidth > 0 ? n.strokeWidth : 1;
    const sides = typeof n.borderSides === 'string'
      ? new Set(n.borderSides.split(/[\s,]+/).filter(Boolean))
      : Array.isArray(n.borderSides) ? new Set(n.borderSides) : new Set();
    for (const [side, prop] of [['top', 'borderTop'], ['right', 'borderRight'], ['bottom', 'borderBottom'], ['left', 'borderLeft']]) {
      const val = n[prop];
      if (val || sides.has(side)) {
        styles.push(`border-${side}:${typeof val === 'string' ? val : `${typeof val === 'number' ? val : borderW}px solid ${borderColor}`}`);
      }
    }
  } else if (n.type !== 'path' && n.stroke && n.stroke !== '#FFFFFF00' && n.strokeWidth > 0) {
    styles.push(`border:${n.strokeWidth}px solid ${n.stroke}`);
  }
  if (n.italic) styles.push('font-style:italic');
  const textDeco = [n.underline ? 'underline' : '', n.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ');
  if (textDeco) styles.push(`text-decoration:${textDeco}`);
  if (n.overflow) styles.push(`overflow:${n.overflow}`);
  else if (n.scroll === 'vertical' || n.scroll === 'y') styles.push('overflow-y:auto;overflow-x:hidden');
  else if (n.scroll === 'horizontal' || n.scroll === 'x') styles.push('overflow-x:auto;overflow-y:hidden');
  else if (n.clip === true || n.type === 'dynamic-panel' || (n.radius > 0 && childrenHtml)) styles.push('overflow:hidden');
  const css = visualCss(n);
  const style = extra => escapeHtml([...styles, extra || '', ...Object.entries(css).map(([key, value]) => `${key}:${value}`)].join(';'));
  const textClass = ['button', 'label', 'paragraph', 'badge'].includes(n.type) ? ' studio-text' : '';
  const commonAttrs = `class="studio-node studio-${n.type}${textClass}" data-node-id="${escapeHtml(n.id)}" data-scoped-id="${escapeHtml(n.scopedId)}" data-page-id="${escapeHtml(pageId)}" data-node-type="${escapeHtml(n.type)}" data-locked="${n.locked ? 'true' : 'false'}"`;

  if (n.type === 'path') {
    const vb = n.viewBox && typeof n.viewBox === 'object'
      ? n.viewBox
      : { x: 0, y: 0, w: Math.max(1, n.w || 100), h: Math.max(1, n.h || 100) };
    const svgFill = n.fill && n.fill !== '#FFFFFF00' ? n.fill : 'none';
    const svgStroke = n.stroke && n.stroke !== '#FFFFFF00'
      ? n.stroke
      : (n.fill && n.fill !== '#FFFFFF00' ? 'none' : (n.color || '#203B32'));
    const svgStrokeW = svgStroke !== 'none' ? (n.strokeWidth > 0 ? n.strokeWidth : 2) : 0;
    const dashAttr = n.strokeDasharray
      ? ` stroke-dasharray="${escapeHtml(Array.isArray(n.strokeDasharray) ? n.strokeDasharray.join(' ') : String(n.strokeDasharray))}"`
      : '';
    return `<div ${commonAttrs} data-fill-rule="${escapeHtml(n.fillRule || 'nonzero')}" data-native-vector="${n.nativeVectorCompatible ? 'true' : 'false'}" style="${style('overflow:visible')}"><svg class="studio-vector-svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="100%" height="100%" preserveAspectRatio="none" style="display:block;overflow:visible;pointer-events:none;"><path class="studio-vector-path" d="${escapeHtml(n.svgD || '')}" fill="${escapeHtml(svgFill)}" fill-rule="${escapeHtml(n.fillRule || 'nonzero')}" stroke="${escapeHtml(svgStroke)}" stroke-width="${svgStrokeW}" stroke-linecap="${escapeHtml(n.strokeLinecap || 'round')}" stroke-linejoin="${escapeHtml(n.strokeLinejoin || 'round')}"${dashAttr} /></svg>${childrenHtml}</div>`;
  }

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
      const val = state.runtimeState?.inputs?.[n.scopedId] ?? n.text ?? '';
      return `<input ${commonAttrs} value="${escapeHtml(val)}" placeholder="${escapeHtml(n.placeholder || '')}" style="${style('padding:0 12px')}" data-runtime-input="${escapeHtml(n.scopedId)}" />`;
    }
    const disp = n.text || n.placeholder || '';
    const isPlaceholder = !n.text && n.placeholder;
    return `<div ${commonAttrs} style="${style(`display:flex;align-items:center;padding:0 12px;${isPlaceholder ? 'color:#6E8279' : ''}`)}">${escapeHtml(disp)}${childrenHtml}</div>`;
  }

  if (n.type === 'repeater') {
    const dsName = n.dataset || n.id;
    const rows = state.mode === 'interact' && state.runtimeState?.datasets?.[dsName] && !n.rowViewResolved
      ? state.runtimeState.datasets[dsName].visibleRows
      : (n.rows || []);
    const rowH = Number(n.rowHeight || 48);
    const gap = Number(n.rowGap ?? 6);
    const rowsHtml = rows.map((r, idx) => {
      const rowId = r._rowId || r.id || `row_${idx + 1}`;
      const isSel = Boolean(r._selected);
      const view=n.rowViews?.[idx];
      if(view){
        const content=renderNodeTree(view.nodes,pageId);
        return `<div class="repeater-row-item repeater-row-template" data-repeater="${escapeHtml(dsName)}" data-row-id="${escapeHtml(rowId)}" style="position:relative;height:${rowH}px;margin-bottom:${gap}px;${isSel?'outline:2px solid #2E6F57;outline-offset:-2px;':''}"><div style="position:relative;width:100%;height:100%;pointer-events:none">${content}</div></div>`;
      }
      const cells = Object.entries(r)
        .filter(([k]) => !k.startsWith('_'))
        .map(([, v]) => `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(v)}</span>`)
        .join('');
      return `<div class="repeater-row-item" data-repeater="${escapeHtml(dsName)}" data-row-id="${escapeHtml(rowId)}" style="height:${rowH}px;margin-bottom:${gap}px;padding:0 12px;display:flex;align-items:center;gap:8px;background:${isSel ? '#DCEFE6' : '#FFFFFF'};border:1px solid ${isSel ? '#2E6F57' : '#DDE3DC'};border-radius:8px;cursor:pointer;font-size:12px;color:#203B32;">${cells}</div>`;
    }).join('');
    return `<div ${commonAttrs} style="${style(`overflow-y:auto;padding:${n.rowViews?'0':'4px'}`)}">${rowsHtml}</div>`;
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

export function renderNodeTree(source,pageId) {
  const nodes = source.filter(n => n.visible && n.type !== 'phone-shell'&&!n.repeaterTemplateOwner);
  const byId = new Map(nodes.map(n => [n.scopedId, n]));
  const children = new Map();
  for (const n of nodes) {
    const parentKey = byId.has(n.parentScopedId) ? n.parentScopedId : null;
    if (!children.has(parentKey)) children.set(parentKey, []);
    children.get(parentKey).push(n);
  }
  const render = (n, parent) => buildNodeElementHtml(n, pageId, (children.get(n.scopedId) || []).map(ch => render(ch, n)).join(''), parent);
  return (children.get(null) || []).map(n => render(n, null)).join('');
}

export function renderPageNodes(pg) {return renderNodeTree(pg.nodes,pg.id);}

export function tokenCss() {
  return escapeHtml(Object.entries({ ...state.doc?.palette, ...state.doc?.tokens?.colors }).map(([key, value]) => `--${key}:${value}`).join(';'));
}

export function positionNodeElement(el, node, pg) {
  const parent = pg.nodes.find(n => n.scopedId === node.parentScopedId && n.type !== 'phone-shell');
  el.style.left = `${node.x - (parent?.x || 0) - (parent?.strokeWidth || 0)}px`;
  el.style.top = `${node.y - (parent?.y || 0) - (parent?.strokeWidth || 0)}px`;
}

export function pointerMapper(nodeEl) {
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

export function renderCanvasStage() {
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
          <div class="artboard-screen" id="screen-root" data-page-id="${escapeHtml(pgScene.id)}" style="left:${b.shellPad}px;top:${b.shellPad}px;width:${b.screenW}px;height:${b.screenH}px;border-radius:${b.screenRadius}px;background:var(--bg,#F7F8F2);${tokenCss()}">
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

    // Keep the active page available to editing/capture; lazily mount visible neighbors.
    const shouldMountNodes = shouldMountPage(pg);
    const nodesHtml = shouldMountNodes
      ? renderPageNodes(pg)
      : `<div style="padding:24px;color:#6E8279;font-size:13px;">点击画板查看内容</div>`;

    const islandHtml = b.island && b.darkIsland
      ? `<div class="artboard-island" style="left:${(b.screenW - b.island.w) / 2}px;top:${b.island.y}px;width:${b.island.w}px;height:${b.island.h}px;border-radius:${b.island.r ?? b.island.h / 2}px;"><span style="position:absolute;right:12px;top:11px;width:10px;height:10px;border-radius:50%;background:#1B2431;border:1px solid #2B3546;box-sizing:border-box;"></span></div>`
      : '';

    boardHtmlList.push(`
      <div class="artboard-wrapper" data-artboard-id="${escapeHtml(pg.id)}" data-nodes-mounted="${shouldMountNodes}" style="left:${boardX}px;top:${boardY}px;width:${b.totalW}px;height:${b.totalH}px;">
        <div class="artboard-title-bar ${pg.id === state.activePageId ? 'active' : ''}" data-select-page="${escapeHtml(pg.id)}" title="${escapeHtml(pg.id)} · ${b.screenW} × ${b.screenH}">
          <span>${escapeHtml(pg.name)}</span>
        </div>
        <div class="artboard-outer" style="width:${b.totalW}px;height:${b.totalH}px;border-radius:${b.outerRadius}px;background:${b.shellPad > 0 ? '#09090B' : 'transparent'};${b.shellPad > 0 ? 'box-shadow:inset 0 0 0 2px #8B8D8E,inset 0 0 0 4px #33343B;' : ''}">
          <div class="artboard-screen" id="${pg.id === state.activePageId ? 'screen-root' : `screen-${pg.id}`}" data-page-id="${escapeHtml(pg.id)}" style="left:${b.shellPad}px;top:${b.shellPad}px;width:${b.screenW}px;height:${b.screenH}px;border-radius:${b.screenRadius}px;background:var(--bg,#F7F8F2);${tokenCss()}">
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

export function bindRuntimeStageEvents(stage) {
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

export function parseRotationDeg(transformStr) {
  const m = String(transformStr || '').match(/rotate\(\s*(-?\d+(?:\.\d+)?)deg\s*\)/i);
  return m ? Number(m[1]) : 0;
}

export function withRotationDeg(transformStr, deg) {
  const clean = String(transformStr || '').replace(/\s*rotate\(\s*-?\d+(?:\.\d+)?deg\s*\)/gi, '').trim();
  const rounded = Math.round(deg);
  if (rounded === 0 || Math.abs(rounded) === 360) return clean || null;
  return clean ? `${clean} rotate(${rounded}deg)` : `rotate(${rounded}deg)`;
}

export function renderSelectionOverlay() {
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
    const rotDeg = typeof n.rotation === 'number' && Number.isFinite(n.rotation) && n.rotation % 360 !== 0
      ? n.rotation
      : parseRotationDeg(n.threeDTransform);

    let vectorHandlesHtml = '';
    if (state.selectedIds.length === 1 && n.type === 'path' && Array.isArray(n.subpaths)) {
      const vb = n.viewBox && typeof n.viewBox === 'object'
        ? n.viewBox
        : { x: 0, y: 0, w: Math.max(1, n.w || 100), h: Math.max(1, n.h || 100) };
      const sx = vw / Math.max(1, vb.w);
      const sy = vh / Math.max(1, vb.h);
      const pts = [];
      n.subpaths.forEach((sub, sIdx) => {
        (sub.points || []).forEach((pt, pIdx) => {
          const px = Math.round((pt.x - (vb.x || 0)) * sx - 4.5);
          const py = Math.round((pt.y - (vb.y || 0)) * sy - 4.5);
          pts.push(
            `<div class="vector-point-handle" data-vector-point="${sIdx}:${pIdx}:anchor" data-node-id="${escapeHtml(n.id)}" title="路径顶点 (${pt.x}, ${pt.y})" style="left:${px}px;top:${py}px;"></div>`
          );
          for (const hKind of ['in', 'out', 'q']) {
            if (pt[hKind] && typeof pt[hKind].x === 'number') {
              const hx = Math.round((pt[hKind].x - (vb.x || 0)) * sx - 3.5);
              const hy = Math.round((pt[hKind].y - (vb.y || 0)) * sy - 3.5);
              pts.push(
                `<div class="vector-point-handle curve-handle" data-vector-point="${sIdx}:${pIdx}:${hKind}" data-node-id="${escapeHtml(n.id)}" title="曲线控制柄 ${hKind} (${pt[hKind].x}, ${pt[hKind].y})" style="left:${hx}px;top:${hy}px;"></div>`
              );
            }
          }
        });
      });
      vectorHandlesHtml = pts.join('');
    }

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
          // 缩小视图下边中点手柄会盖住文字中心：按缩放隐藏（<40% 只留角手柄），不按节点渲染尺寸区分
          .filter(([dir]) => state.zoom >= 0.4 || !['n', 's', 'e', 'w'].includes(dir))
          .map(
            ([dir, hx, hy, cur]) =>
              `<div class="resize-handle" data-resize-handle="${dir}" data-node-id="${escapeHtml(n.id)}" style="left:${Math.round(hx)}px;top:${Math.round(hy)}px;cursor:${cur};"></div>`
          )
          .join('') +
        `<div class="rotate-handle" data-rotate-handle="rotate" data-node-id="${escapeHtml(n.id)}" title="拖拽旋转" style="left:${Math.round(vw / 2 - 5)}px;top:-22px;"></div>` +
        vectorHandlesHtml
      : '';

    boxesHtml.push(`
      <div class="selection-box" data-selection-for="${escapeHtml(n.id)}" style="left:${vx}px;top:${vy}px;width:${vw}px;height:${vh}px;">
        <div class="selection-label">
          ${n.w} × ${n.h}${rotDeg ? ` · ${rotDeg}°` : ''}
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

  boxesHtml.push(distanceGuidesHtml());
  overlay.innerHTML = boxesHtml.join('\n');
}

export function distanceGuidesHtml() {
  if (!state.altPressed || state.dragSession || state.selectedIds.length !== 1 || !state.measureTarget) return '';
  const active=getActivePageScene(), selected=active?.nodes.find(n=>n.id===state.selectedIds[0]);
  const targetPage=state.scene.pages.find(pg=>pg.id===state.measureTarget.pageId);
  const target=targetPage?.nodes.find(n=>n.scopedId===state.measureTarget.scopedId);
  if (!selected || !target || selected.scopedId===target.scopedId) return '';
  const a=nodeViewportBounds(selected),b=nodeViewportBounds(target);
  if (!a || !b) return '';
  const lines=[];
  const add=(axis,x,y,length)=>{
    const value=Number((Math.abs(length)/state.zoom).toFixed(1));
    lines.push(`<div class="distance-guide ${axis}" data-distance="${value}" style="left:${x}px;top:${y}px;${axis==='horizontal'?'width':'height'}:${Math.abs(length)}px"><span>${value}px</span></div>`);
  };
  if (a.x+a.w<=b.x) add('horizontal',a.x+a.w,(a.y+a.h/2+b.y+b.h/2)/2,b.x-a.x-a.w);
  else if (b.x+b.w<=a.x) add('horizontal',b.x+b.w,(a.y+a.h/2+b.y+b.h/2)/2,a.x-b.x-b.w);
  if (a.y+a.h<=b.y) add('vertical',(a.x+a.w/2+b.x+b.w/2)/2,a.y+a.h,b.y-a.y-a.h);
  else if (b.y+b.h<=a.y) add('vertical',(a.x+a.w/2+b.x+b.w/2)/2,b.y+b.h,a.y-b.y-b.h);
  if (!lines.length) {
    const outer=a.x<=b.x&&a.y<=b.y&&a.x+a.w>=b.x+b.w&&a.y+a.h>=b.y+b.h?a:b;
    const inner=outer===a?b:a;
    add('horizontal',Math.min(a.x,b.x),inner.y+inner.h/2,Math.abs(a.x-b.x));
    add('vertical',inner.x+inner.w/2,Math.min(a.y,b.y),Math.abs(a.y-b.y));
    if (outer.x<=inner.x&&outer.y<=inner.y&&outer.x+outer.w>=inner.x+inner.w&&outer.y+outer.h>=inner.y+inner.h) {
      add('horizontal',inner.x+inner.w,inner.y+inner.h/2,outer.x+outer.w-inner.x-inner.w);
      add('vertical',inner.x+inner.w/2,inner.y+inner.h,outer.y+outer.h-inner.y-inner.h);
    }
  }
  return lines.join('');
}

export let lastSelectionKey='';
// ESM 活绑定只能在本模块内赋值;跨模块(sync 的 SSE 重连)经此 setter 复位。
export function resetLastSelectionKey() { lastSelectionKey=''; }

export let selectionPublishTimer=null;

export let selectionPublishQueue=Promise.resolve();

export function publishSelection() {
  if(!state.doc||!state.activePageId)return;
  const body={clientId:state.clientId,documentId:state.doc.documentId,pageId:state.activePageId,revision:state.appliedRevision,contentHash:state.doc.contentHash,nodeIds:[...state.selectedIds]};
  const key=JSON.stringify(body);if(key===lastSelectionKey)return;lastSelectionKey=key;
  clearTimeout(selectionPublishTimer);selectionPublishTimer=setTimeout(()=>{selectionPublishQueue=selectionPublishQueue.catch(()=>{}).then(()=>apiPost('/api/selection',body)).then(result=>{state.selectionId=result.selectionId||null;}).catch(()=>{state.selectionId=null;});},40);
}

export function renderAll() {
  updateTopbarStatus();
  renderCanvasStage();
  renderSidebar();
  renderInspector();
  renderSelectionOverlay();
  publishSelection();
}
