import { copyNodeSnapshots } from '/clipboard.mjs';
import { isInputFocused, showToast } from './ui.mjs';
import { findDropContainer, getActivePageScene, nodeViewportBounds, padList, selectedRootNodes, updateWorkspaceChrome } from './view.mjs';
import { parseRotationDeg, pointerMapper, positionNodeElement, renderSelectionOverlay, withRotationDeg } from './render.mjs';
import { state } from './state.mjs';

function restoreGesturePreview(ds) {
  if (ds.baseRevision !== state.appliedRevision) return;
  const pg = state.scene?.pages.find(page => page.id === ds.pageId);
  const restore = item => {
    const node = pg?.nodes.find(node => node.id === (item.id || item.nodeId));
    if (!node) return;
    node.x = item.origScreenX;
    node.y = item.origScreenY;
    if (ds.kind === 'resize') { node.w = ds.origW; node.h = ds.origH; }
  };
  if (ds.kind === 'move' || ds.kind === 'resize') {
    if (ds.multiItems?.length > 1) ds.multiItems.forEach(restore);
    else restore(ds);
  } else if (ds.kind === 'rotate') {
    const node = pg?.nodes.find(node => node.id === ds.nodeId);
    if (node) {
      if (ds.pure2d) node.rotation = ds.origDeg;
      else node.threeDTransform = ds.origTransform;
    }
    const el = document.querySelector(`#screen-root .studio-node[data-node-id="${CSS.escape(ds.nodeId)}"]`);
    if (el) el.style.transform = ds.pure2d ? (ds.origDeg ? `rotate(${ds.origDeg}deg)` : '') : (ds.origTransform || '');
  } else if (ds.kind === 'pan') {
    state.panX = ds.origPanX;
    state.panY = ds.origPanY;
  } else if (ds.kind === 'marquee') state.selectedIds = ds.prevSelectedIds || [];
}

export function clearCanvasGesture() {
  const ds = state.dragSession;
  if (!ds) return false;
  state.dragSession = null;
  state.snapGuides = [];
  // 手势被取消（Escape/失焦/快照）即打断双击链，避免快速连续操作被误判为双击（S1-N3）
  state.lastNodePress = null;
  restoreGesturePreview(ds);
  const marquee = document.getElementById('marquee-box');
  if (marquee) marquee.style.display = 'none';
  return true;
}

export function openInlineTextEditor(node) {
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

export async function commitInlineTextEditor(dispatchCommands, cancel = false) {
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
      autoSize: true,
    });
  }
}

export function setupCanvasInteractions({
  cancelCanvasGesture, commitInlineTextEditor, dispatchCommands, dispatchHistoryAction, onRuntimeClick,
  refreshSnapshot, renderAll, renderCanvasStage, renderSelection, revealActiveArtboard, updateCanvasTransform,
}) {
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
        // 光标锚定缩放：缩放前后光标下的世界坐标点屏幕位置不变
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const worldX = (e.clientX - state.panX) / state.zoom;
        const worldY = (e.clientY - state.panY) / state.zoom;
        state.zoom = Math.min(4, Math.max(0.01, Number((state.zoom * factor).toFixed(3))));
        state.panX = e.clientX - worldX * state.zoom;
        state.panY = e.clientY - worldY * state.zoom;
      } else if (e.shiftKey) {
        state.panX -= e.deltaX || e.deltaY; // shift+滚轮：横向平移
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
    cancelCanvasGesture();
    if (state.editingNodeId && !state.isComposing) {
      await commitInlineTextEditor(false);
      return; // The click ended text editing; it must not also start dragging a container.
    }

    const pageHeader = e.target.closest('[data-select-page]');
    if (pageHeader) {
      state.activePageId = pageHeader.getAttribute('data-select-page');
      state.selectedIds = [];
      renderAll();
      revealActiveArtboard();
      return;
    }

    if (state.mode === 'interact') {
      let nodeEl = e.target.closest('.studio-node');
      const nodes = state.runtimeState?.activePageScene?.nodes || [];
      while (nodeEl) {
        const node = nodes.find(n => n.scopedId === nodeEl.dataset.scopedId);
        if (node?.interactive === false || node?.on?.click) break;
        nodeEl = nodeEl.parentElement?.closest('.studio-node');
      }
      if (nodeEl && nodeEl.tagName !== 'INPUT') {
        const nodeId = nodeEl.getAttribute('data-scoped-id');
        try {
          await onRuntimeClick(nodeId);
        } catch (err) {
          const rtCode = err?.data?.code;
          if (typeof rtCode === 'string' && rtCode.startsWith('E_RUNTIME_')) {
            // 运行态错误（如 E_RUNTIME_NODE_HIDDEN）不再静默吞掉，给出恢复指引（T-DR-1）。
            showToast(`${err.message}${err.data.suggestion ? `；${err.data.suggestion}` : ''}`, 'warn', 4600);
          }
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
    const gestureBinding = { pageId: state.activePageId, baseRevision: state.appliedRevision };

    // Space + drag or middle-click -> Pan canvas
    if (state.spacePressed || state.tool === 'pan' || e.button === 1) {
      state.dragSession = {
        ...gestureBinding,
        kind: 'pan',
        startClientX,
        startClientY,
        origPanX: state.panX,
        origPanY: state.panY,
      };
      return;
    }

    // 1. Check vector control point, resize, or rotate handle
    const vecPointEl = e.target.closest('[data-vector-point]');
    if (vecPointEl) {
      const nodeId = vecPointEl.getAttribute('data-node-id');
      const spec = String(vecPointEl.getAttribute('data-vector-point') || '').split(':');
      const subpathIndex = Number(spec[0] || 0);
      const pointIndex = Number(spec[1] || 0);
      const handleKind = spec[2] || 'anchor';
      const node = pg.nodes.find(n => n.id === nodeId);
      if (!node || node.locked || !Array.isArray(node.subpaths)) return;
      const pt = node.subpaths[subpathIndex]?.points?.[pointIndex];
      if (!pt) return;
      const targetPt = handleKind === 'anchor' ? pt : (pt[handleKind] || pt);
      const vb = node.viewBox && typeof node.viewBox === 'object'
        ? node.viewBox
        : { x: 0, y: 0, w: Math.max(1, node.w || 100), h: Math.max(1, node.h || 100) };
      state.dragSession = {
        ...gestureBinding,
        kind: 'vector-point',
        nodeId,
        subpathIndex,
        pointIndex,
        handleKind,
        startClientX,
        startClientY,
        origX: Number(targetPt.x || 0),
        origY: Number(targetPt.y || 0),
        curX: Number(targetPt.x || 0),
        curY: Number(targetPt.y || 0),
        vbScaleX: Math.max(1, vb.w) / Math.max(1, node.w || 100),
        vbScaleY: Math.max(1, vb.h) / Math.max(1, node.h || 100),
      };
      return;
    }

    const rotateEl = e.target.closest('[data-rotate-handle]');
    if (rotateEl) {
      const nodeId = rotateEl.getAttribute('data-node-id');
      const node = pg.nodes.find(n => n.id === nodeId);
      if (!node || node.locked) return;
      const el = document.querySelector(`#screen-root .studio-node[data-node-id="${CSS.escape(node.id)}"]`);
      const rect = el ? el.getBoundingClientRect() : null;
      const centerX = rect ? rect.left + rect.width / 2 : startClientX;
      const centerY = rect ? rect.top + rect.height / 2 : startClientY + 40;
      const startAngle = Math.atan2(startClientY - centerY, startClientX - centerX) * (180 / Math.PI);
      const origTransform = node.threeDTransform || null;
      const origDeg = typeof node.rotation === 'number' && Number.isFinite(node.rotation)
        ? node.rotation
        : parseRotationDeg(origTransform);
      const pure2d = !origTransform;
      state.dragSession = {
        ...gestureBinding,
        kind: 'rotate',
        nodeId,
        centerX,
        centerY,
        startAngle,
        origTransform,
        origDeg,
        pure2d,
        curDeg: origDeg,
        curTransform: origTransform,
      };
      return;
    }

    const handleEl = e.target.closest('[data-resize-handle]');
    if (handleEl) {
      const dir = handleEl.getAttribute('data-resize-handle');
      const nodeId = handleEl.getAttribute('data-node-id');
      const node = pg.nodes.find(n => n.id === nodeId);
      if (!node || node.locked) return;
      state.dragSession = {
        ...gestureBinding,
        kind: 'resize',
        mapPointer: pointerMapper(document.querySelector(`.studio-node[data-scoped-id="${CSS.escape(node.scopedId)}"]`)),
        dir,
        nodeId,
        startClientX,
        startClientY,
        origRelX: node.sourceX ?? node.relX,
        origRelY: node.sourceY ?? node.relY,
        origScreenX: node.x,
        origScreenY: node.y,
        curRelX: node.sourceX ?? node.relX,
        curRelY: node.sourceY ?? node.relY,
        origW: node.w,
        origH: node.h,
        curW: node.w,
        curH: node.h,
      };
      return;
    }

    // 2. Check studio node hit
    let nodeEl = e.target.closest('.studio-node');
    if (nodeEl) {
      const pageId = nodeEl.getAttribute('data-page-id');
      const nodeId = nodeEl.getAttribute('data-node-id');
      if (pageId && pageId !== state.activePageId) {
        state.activePageId = pageId;
        gestureBinding.pageId = pageId;
        state.selectedIds = [];
        renderCanvasStage();
        nodeEl = document.querySelector(`.studio-node[data-page-id="${CSS.escape(pageId)}"][data-node-id="${CSS.escape(nodeId)}"]`);
      }
      const activePg = getActivePageScene();
      let node = activePg?.nodes.find(n => n.id === nodeId);
      if (!node) return;

      // 整屏背景容器不是拖拽目标：画板内空白处按下应框选，而非移动画板（S1-N2）
      if ((node.depth <= 1 && node.w >= (activePg.board.screenW || 402) - 4 && node.h >= (activePg.board.screenH || 874) - 4)
        || (e.shiftKey && (node.locked || (node.childrenIds?.length && !node.on?.click)))) {
        state.lastNodePress = null;
        const prevSelectedIds = e.shiftKey ? [...state.selectedIds] : [];
        if (!e.shiftKey) {
          state.selectedIds = [];
          renderSelection();
        }
        state.dragSession = {
          ...gestureBinding,
          kind: 'marquee',
          startClientX,
          startClientY,
          vpLeft: vpRect.left,
          vpTop: vpRect.top,
          prevSelectedIds,
          clickNodeId: e.shiftKey && !node.locked ? node.id : null,
          marqueeOriginId: node.id,
        };
        return;
      }
      if (node.locked) return;

      // 双击文字节点进入内联编辑：两次点击之间 DOM 可能被重渲染，原生 dblclick 会丢，
      // 因此按「同一节点 400ms 内二次按下」自行判定（S1-N3）。
      const pressNow = performance.now();
      if (state.lastNodePress && state.lastNodePress.nodeId === node.id && pressNow - state.lastNodePress.t < 400
        && ['label', 'paragraph', 'button', 'input'].includes(node.type)) {
        state.lastNodePress = null;
        // 阻止 mousedown 默认焦点转移：否则 textarea 刚聚焦就被 blur 提交关闭（S1-N3）
        e.preventDefault();
        openInlineTextEditor(node);
        return;
      }
      state.lastNodePress = { nodeId: node.id, t: pressNow };

      if (e.shiftKey) {
        if (state.selectedIds.includes(nodeId)) {
          state.selectedIds = state.selectedIds.filter(x => x !== nodeId);
        } else {
          state.selectedIds.push(nodeId);
        }
      } else if (!state.selectedIds.includes(nodeId)) {
        state.selectedIds = [nodeId];
      }

      const roots = selectedRootNodes(activePg);
      let selectedAncestor = null, ancestorScope = node.parentScopedId;
      while (ancestorScope) {
        const ancestor = activePg.nodes.find(item => item.scopedId === ancestorScope);
        if (roots.some(root => root.scopedId === ancestorScope)) { selectedAncestor = ancestor; break; }
        ancestorScope = ancestor?.parentScopedId;
      }
      if (selectedAncestor) {
        node = selectedAncestor;
        nodeEl = document.querySelector(`.studio-node[data-scoped-id="${CSS.escape(node.scopedId)}"]`);
      }

      renderSelection();

      const isAutoLayoutChild = ['row','column','grid'].includes(node.parentLayout);
      const multiItems = !isAutoLayoutChild && roots.length > 1
        ? roots
            .map(sn => {
              if (!sn || sn.locked || ['row','column','grid'].includes(sn.parentLayout)) return null;
              return {
                id: sn.id,
                node: sn,
                origRelX: sn.sourceX ?? sn.relX,
                origRelY: sn.sourceY ?? sn.relY,
                origScreenX: sn.x,
                origScreenY: sn.y,
                curRelX: sn.sourceX ?? sn.relX,
                curRelY: sn.sourceY ?? sn.relY,
                el: document.querySelector(`#screen-root .studio-node[data-node-id="${CSS.escape(sn.id)}"]`),
              };
            })
            .filter(Boolean)
        : null;

      state.dragSession = {
        ...gestureBinding,
        kind: 'move',
        mapPointer: pointerMapper(nodeEl),
        nodeId: node.id,
        startClientX,
        startClientY,
        moved: false,
        isAutoLayoutChild,
        parentId: node.parentId,
        parentLayout: node.parentLayout,
        targetIndex: null,
        origRelX: node.sourceX ?? node.relX,
        origRelY: node.sourceY ?? node.relY,
        origScreenX: node.x,
        origScreenY: node.y,
        curRelX: node.sourceX ?? node.relX,
        curRelY: node.sourceY ?? node.relY,
        multiItems,
        el: nodeEl,
      };
      return;
    }

    // 3. Empty canvas -> Marquee rubber-band selection
    const prevSelectedIds = e.shiftKey ? [...state.selectedIds] : [];
    if (!e.shiftKey) {
      state.selectedIds = [];
      renderSelection();
    }
    state.dragSession = {
      ...gestureBinding,
      kind: 'marquee',
      startClientX,
      startClientY,
      vpLeft: vpRect.left,
      vpTop: vpRect.top,
      prevSelectedIds,
    };
  });

  window.addEventListener('mousemove', e => {
    if (!state.dragSession) {
      const el=e.target.closest?.('.studio-node');
      state.measureTarget=el ? {pageId:el.dataset.pageId,scopedId:el.dataset.scopedId} : null;
      if (state.altPressed || e.altKey) { state.altPressed=e.altKey; renderSelectionOverlay(); }
      return;
    }
    const ds = state.dragSession;
    if (ds.pageId !== state.activePageId || ds.baseRevision !== state.appliedRevision) { cancelCanvasGesture(); return; }

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
      if (!ds.moved) {
        if (Math.hypot(e.clientX-ds.startClientX,e.clientY-ds.startClientY) < 4) return;
        ds.moved = true;
        state.lastNodePress = null;
      }
      const pg = getActivePageScene();
      const node = pg?.nodes.find(n => n.id === ds.nodeId);
      state.snapGuides = [];

      if (ds.isAutoLayoutChild && pg && node) {
        // Auto-layout child drag: compute target sibling order instead of mutating absolute coordinates
        const siblings = pg.nodes.filter(n => n.parentId === ds.parentId && n.visible);
        const curCenterX = ds.origScreenX + dx + node.w / 2;
        const curCenterY = ds.origScreenY + dy + node.h / 2;
        let targetIdx = 0;
        let closest = Infinity;
        for (let i = 0; i < siblings.length; i++) {
          const sib = siblings[i];
          if (ds.parentLayout === 'grid') {
            const distance = (curCenterX-sib.x-sib.w/2)**2+(curCenterY-sib.y-sib.h/2)**2;
            if (distance < closest) { closest = distance; targetIdx = i; }
            continue;
          }
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
    } else if (ds.kind === 'rotate') {
      const pg = getActivePageScene();
      const node = pg?.nodes.find(n => n.id === ds.nodeId);
      const angle = Math.atan2(e.clientY - ds.centerY, e.clientX - ds.centerX) * (180 / Math.PI);
      let nextDeg = Math.round(ds.origDeg + (angle - ds.startAngle));
      if (e.shiftKey) nextDeg = Math.round(nextDeg / 15) * 15;
      while (nextDeg > 180) nextDeg -= 360;
      while (nextDeg <= -180) nextDeg += 360;
      const nextTransform = ds.pure2d ? null : withRotationDeg(ds.origTransform, nextDeg);
      ds.curDeg = nextDeg;
      ds.curTransform = nextTransform;
      if (node) {
        if (ds.pure2d) node.rotation = nextDeg;
        else node.threeDTransform = nextTransform;
      }
      const el = document.querySelector(`#screen-root .studio-node[data-node-id="${CSS.escape(ds.nodeId)}"]`);
      if (el) el.style.transform = ds.pure2d ? `rotate(${nextDeg}deg)` : (nextTransform || '');
      renderSelectionOverlay();
    } else if (ds.kind === 'vector-point') {
      const pg = getActivePageScene();
      const node = pg?.nodes.find(n => n.id === ds.nodeId);
      const nextX = Number((ds.origX + dx * (ds.vbScaleX || 1)).toFixed(2));
      const nextY = Number((ds.origY + dy * (ds.vbScaleY || 1)).toFixed(2));
      ds.curX = nextX;
      ds.curY = nextY;
      const pt = node?.subpaths?.[ds.subpathIndex]?.points?.[ds.pointIndex];
      if (pt) {
        if (ds.handleKind === 'anchor') {
          pt.x = nextX;
          pt.y = nextY;
        } else if (pt[ds.handleKind]) {
          pt[ds.handleKind].x = nextX;
          pt[ds.handleKind].y = nextY;
        }
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
    if (ds.pageId !== state.activePageId || ds.baseRevision !== state.appliedRevision) { cancelCanvasGesture(); return; }
    // 只把「未移动的按下-释放」计入双击链：真实拖拽过就打断（S1-N3）
    if (ds.kind === 'move' && ds.moved) state.lastNodePress = null;
    state.dragSession = null;
    state.snapGuides = [];

    try {
      if (ds.kind === 'move' && ds.moved) {
        if (ds.isAutoLayoutChild && typeof ds.targetIndex === 'number') {
          await dispatchCommands({
            type: 'reorderNode',
            pageId: ds.pageId,
            nodeId: ds.nodeId,
            toIndex: ds.targetIndex,
          }, { baseRevision: ds.baseRevision });
        } else if (ds.multiItems && ds.multiItems.length > 1) {
          await dispatchCommands(
            ds.multiItems.map(item => ({
              type: 'moveNode',
              pageId: ds.pageId,
              nodeId: item.id,
              x: item.curRelX,
              y: item.curRelY,
            })), { baseRevision: ds.baseRevision }
          );
        } else {
          // 释放点落在其他容器内 → 重挂为该容器子节点并置顶（保持视觉位置）
          const pg = getActivePageScene();
          const moved = pg?.nodes.find(n => n.id === ds.nodeId);
          const mappedNow = ds.mapPointer?.(e.clientX, e.clientY);
          const mappedStart = ds.mapPointer?.(ds.startClientX, ds.startClientY);
          const dx = mappedNow && mappedStart ? mappedNow.x - mappedStart.x : 0;
          const dy = mappedNow && mappedStart ? mappedNow.y - mappedStart.y : 0;
          const dropContainer = moved
            ? findDropContainer(pg, ds.nodeId, ds.origScreenX + dx + moved.w / 2, ds.origScreenY + dy + moved.h / 2)
            : null;
          if (dropContainer) {
            const pad = padList(dropContainer.padding);
            const cmds = [{
              type: 'reorderNode',
              pageId: ds.pageId,
              nodeId: ds.nodeId,
              parentId: dropContainer.id,
            }];
            if (!['row', 'column', 'grid'].includes(dropContainer.layout)) {
              cmds.push({
                type: 'moveNode',
                pageId: ds.pageId,
                nodeId: ds.nodeId,
                x: Math.round(ds.origScreenX + dx - dropContainer.x - pad[3]),
                y: Math.round(ds.origScreenY + dy - dropContainer.y - pad[0]),
              });
            }
            await dispatchCommands(cmds, { baseRevision: ds.baseRevision });
          } else {
            await dispatchCommands({
              type: 'moveNode',
              pageId: ds.pageId,
              nodeId: ds.nodeId,
              x: ds.curRelX,
              y: ds.curRelY,
            }, { baseRevision: ds.baseRevision });
          }
        }
      } else if (
        ds.kind === 'resize' &&
        (ds.curW !== ds.origW || ds.curH !== ds.origH || ds.curRelX !== ds.origRelX || ds.curRelY !== ds.origRelY)
      ) {
        await dispatchCommands({
          type: 'resizeNode',
          pageId: ds.pageId,
          nodeId: ds.nodeId,
          x: ds.curRelX,
          y: ds.curRelY,
          w: ds.curW,
          h: ds.curH,
        }, { baseRevision: ds.baseRevision });
      } else if (ds.kind === 'rotate' && ds.curDeg !== ds.origDeg) {
        await dispatchCommands({
          type: 'setProperties',
          pageId: ds.pageId,
          nodeId: ds.nodeId,
          properties: ds.pure2d ? { rotation: ds.curDeg } : { threeDTransform: ds.curTransform },
        }, { baseRevision: ds.baseRevision });
      } else if (ds.kind === 'vector-point' && (ds.curX !== ds.origX || ds.curY !== ds.origY)) {
        await dispatchCommands({
          type: 'editPath',
          pageId: ds.pageId,
          nodeId: ds.nodeId,
          operation: 'set-point',
          subpathIndex: ds.subpathIndex,
          pointIndex: ds.pointIndex,
          handle: ds.handleKind,
          x: ds.curX,
          y: ds.curY,
        }, { baseRevision: ds.baseRevision });
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
            if (nId === ds.marqueeOriginId) return;
            const nObj = pg?.nodes.find(x => x.id === nId);
            // Skip full-screen background containers unless explicitly clicked
            if (nObj && nObj.depth <= 1 && nObj.w >= (pg?.board.screenW || 402) - 4 && nObj.h >= (pg?.board.screenH || 874) - 4) {
              return;
            }
            const r = el.getBoundingClientRect();
            if (nObj?.childrenIds?.length && !(r.left>=x1&&r.top>=y1&&r.right<=x2&&r.bottom<=y2)) return;
            const intersects = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
            if (intersects && nId) {
              hits.add(nId);
            }
          });
          state.selectedIds = [...hits];
          renderSelection();
        } else if (ds.clickNodeId) {
          const ids = new Set(ds.prevSelectedIds || []);
          if (ids.has(ds.clickNodeId)) ids.delete(ds.clickNodeId); else ids.add(ds.clickNodeId);
          state.selectedIds = [...ids];
          renderSelection();
        }
      }
    } catch {
      restoreGesturePreview(ds);
      renderAll();
      // A rejection can arrive before SSE has delivered the competing edit.
      // Refresh the authority rather than leaving a rejected local preview.
      try { await refreshSnapshot(); } catch {}
    }
  });

  window.addEventListener('blur', () => {
    state.spacePressed = false;
    state.altPressed = false;
    cancelCanvasGesture();
    updateWorkspaceChrome();
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
    if (e.key === 'Alt') { state.altPressed=false; renderSelectionOverlay(); }
    if (e.code === 'Space') {
      state.spacePressed = false;
      updateWorkspaceChrome();
    }
  });

  // Global keyboard shortcuts with strict input-focus suppression
  window.addEventListener('keydown', async e => {
    if (e.key === 'Escape' && state.dragSession) { e.preventDefault(); cancelCanvasGesture(); return; }
    if (isInputFocused() || state.isComposing || e.isComposing) return;
    if (e.key === 'Alt' && state.mode === 'design') { state.altPressed=true; renderSelectionOverlay(); return; }

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
        renderSelection();
      }
      return;
    }

    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      const endpoint = e.shiftKey ? '/api/redo' : '/api/undo';
      await dispatchHistoryAction(endpoint);
      return;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedIds.length > 0) {
      e.preventDefault();
      const roots = selectedRootNodes();
      if (roots.some(node => node.locked)) {
        showToast('选区包含锁定节点，未删除任何内容', 'warn', 2400);
        return;
      }
      const cmds = roots.map(node => ({
        type: 'deleteNode',
        pageId: state.activePageId,
        nodeId: node.id,
      }));
      const res = await dispatchCommands(cmds);
      if (res) {
        state.selectedIds = [];
        renderAll();
      }
      return;
    }

    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && state.selectedIds.length > 0) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const roots = selectedRootNodes();
      if (roots.some(node => node.locked || ['row', 'column', 'grid'].includes(node.parentLayout))) {
        showToast('选区包含锁定或流式布局节点，请解除锁定或通过布局调整', 'warn', 2800);
        return;
      }
      const cmds = roots
        .map(n => ({
          type: 'moveNode',
          pageId: state.activePageId,
          nodeId: n.id,
          x: (n.sourceX ?? n.relX) + dx,
          y: (n.sourceY ?? n.relY) + dy,
        }));
      if (cmds.length > 0) await dispatchCommands(cmds);
      return;
    }

    if (isMod && e.key.toLowerCase() === 'd' && state.selectedIds.length > 0) {
      e.preventDefault();
      const cmds = selectedRootNodes().map(node => ({
        type: 'duplicateNode',
        pageId: state.activePageId,
        nodeId: node.id,
      }));
      const res = await dispatchCommands(cmds);
      if (Array.isArray(res?.affectedNodeIds) && res.affectedNodeIds.length > 0) {
        state.selectedIds = res.affectedNodeIds.map(s => String(s).split('/').pop());
        renderSelection();
      }
      return;
    }

    if (isMod && ['c', 'x'].includes(e.key.toLowerCase()) && state.selectedIds.length > 0) {
      e.preventDefault();
      const cut = e.key.toLowerCase() === 'x';
      const pageId = state.activePageId, documentId = state.doc.documentId, baseRevision = state.appliedRevision;
      let snapshots;
      try {
        snapshots = copyNodeSnapshots({ doc: state.doc, pageId, nodeIds: state.selectedIds });
      }
      catch (error) { showToast(error.message, 'error'); return; }
      if (cut && selectedRootNodes().some(node => node.locked)) { showToast('选区包含锁定节点，未剪切任何内容', 'warn'); return; }
      const pending = (async () => {
        if (cut) {
          await dispatchCommands(snapshots.map(node => ({ type: 'deleteNode', pageId, nodeId: node.id })), { baseRevision });
          state.selectedIds = [];
          renderAll();
        }
        state.clipboardNodes = snapshots;
        state.clipboardPageId = pageId;
        state.clipboardDocumentId = documentId;
        showToast(`已${cut ? '剪切' : '复制'} ${snapshots.length} 个节点`, 'info', 1800);
      })();
      state.clipboardPending = pending;
      try { await pending; } catch (error) { showToast(error.message, 'error'); }
      finally { if (state.clipboardPending === pending) state.clipboardPending = null; }
      return;
    }

    if (isMod && e.key.toLowerCase() === 'v' && (state.clipboardNodes.length > 0 || state.clipboardPending)) {
      e.preventDefault();
      try { await state.clipboardPending; } catch { return; }
      if (!state.clipboardNodes.length) return;
      const cmds = [{
        type: 'pasteNodes',
        pageId: state.activePageId,
        nodes: state.clipboardNodes,
        sourcePageId: state.clipboardPageId,
        sourceDocumentId: state.clipboardDocumentId,
        ...(state.selectedIds.length === 1 ? { anchorId: state.selectedIds[0] } : {}),
        offset: { x: 20, y: 20 },
      }];
      const res = await dispatchCommands(cmds);
      if (Array.isArray(res?.affectedNodeIds) && res.affectedNodeIds.length > 0) {
        state.selectedIds = res.affectedNodeIds.map(s => String(s).split('/').pop());
        renderSelection();
      }
    }
  });
}
