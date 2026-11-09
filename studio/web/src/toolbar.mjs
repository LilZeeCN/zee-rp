import { escapeHtml, showToast } from './ui.mjs';
import { getActivePageScene, padList, updateWorkspaceChrome, workspaceBounds } from './view.mjs';
import { state } from './state.mjs';

export function setupToolbarAndTabs({
  apiPost, dispatchCommands, dispatchHistoryAction, waitForCommands,
  fitWorkspace, renderAll, renderInspector, renderSidebar, updateCanvasTransform,
  focusDiagnosticTarget, showProjectOperations, showProjectVersions,
}) {
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
  document.getElementById('btn-versions')?.addEventListener('click', showProjectVersions);
  document.getElementById('btn-operations')?.addEventListener('click', showProjectOperations);
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
      const prevMode = state.mode;
      state.mode = btn.getAttribute('data-mode');
      if (state.mode === 'interact') {
        const res = await apiPost('/api/runtime/reset', { startPageId: state.activePageId });
        state.runtimeState = res.state;
      } else if (prevMode === 'interact') {
        // 退出预览时清除服务端预览运行态，恢复设计态撤销/重做（T-D-1 配套出口）。
        try { await apiPost('/api/runtime/exit', {}); } catch {}
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
    await dispatchHistoryAction('/api/undo');
  });

  document.getElementById('btn-redo')?.addEventListener('click', async () => {
    await dispatchHistoryAction('/api/redo');
  });

  // 坞内新建：选中单个容器时直接落入该容器（流式父容器不写 x/y，栈式排在已有子节点下方）
  const dockAddTarget = (defaultX, defaultY) => {
    const pg = getActivePageScene();
    const sel = pg && state.selectedIds.length === 1 ? pg.nodes.find(n => n.id === state.selectedIds[0]) : null;
    if (!sel || sel.locked || !['box', 'card', 'phone-shell'].includes(sel.type)) {
      return { parentId: null, x: defaultX, y: defaultY };
    }
    if (['row', 'column', 'grid'].includes(sel.layout)) return { parentId: sel.id, x: null, y: null };
    const pad = padList(sel.padding);
    const kids = pg.nodes.filter(n => n.parentId === sel.id && n.visible);
    const nextY = kids.length ? Math.max(...kids.map(k => k.relY - pad[0] + k.h)) + 12 : 0;
    return { parentId: sel.id, x: 0, y: Math.max(0, Math.round(nextY)) };
  };

  document.getElementById('btn-add-box')?.addEventListener('click', async () => {
    const newId = `box_${Date.now().toString(36).slice(-4)}`;
    const target = dockAddTarget(32, 120);
    state.selectedIds = [newId];
    await dispatchCommands({
      type: 'addNode',
      pageId: state.activePageId,
      ...(target.parentId ? { parentId: target.parentId } : {}),
      node: {
        type: 'box',
        id: newId,
        name: '新建容器',
        ...(target.x === null ? {} : { x: target.x, y: target.y }),
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
    const target = dockAddTarget(32, 80);
    state.selectedIds = [newId];
    await dispatchCommands({
      type: 'addNode',
      pageId: state.activePageId,
      ...(target.parentId ? { parentId: target.parentId } : {}),
      node: {
        type: 'label',
        id: newId,
        name: '新建文本',
        text: '双击编辑文本内容',
        ...(target.x === null ? {} : { x: target.x, y: target.y }),
        w: 'hug',
        h: 'hug',
        wrap: true,
        fontSize: 16,
        fontWeight: 600,
        color: '$ink',
      },
    });
  });

  document.getElementById('btn-add-btn')?.addEventListener('click', async () => {
    const newId = `btn_${Date.now().toString(36).slice(-4)}`;
    const target = dockAddTarget(32, 240);
    state.selectedIds = [newId];
    await dispatchCommands({
      type: 'addNode',
      pageId: state.activePageId,
      ...(target.parentId ? { parentId: target.parentId } : {}),
      node: {
        type: 'button',
        id: newId,
        name: '新建按钮',
        text: '主要操作',
        ...(target.x === null ? {} : { x: target.x, y: target.y }),
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

  function editSelection(operation, extra) {
    if (!state.selectedIds.length) return;
    return dispatchCommands({ type: 'editNodes', select: { pageId: state.activePageId, nodeIds: [...state.selectedIds] }, operation, ...extra });
  }
  document.getElementById('btn-align-left')?.addEventListener('click', () => editSelection('align', { edge: 'left' }));
  document.getElementById('btn-align-top')?.addEventListener('click', () => editSelection('align', { edge: 'top' }));
  document.getElementById('btn-align-center')?.addEventListener('click', () => {
    const pg = getActivePageScene();
    editSelection('align', { edge: 'center-x', ...(state.selectedIds.length === 1 ? { referenceId: pg.nodes.find(n => !n.parentId)?.scopedId } : {}) });
  });
  document.getElementById('btn-distribute-h')?.addEventListener('click', () => editSelection('distribute', { axis: 'x' }));

  const zoomSteps=[0.1,0.125,0.25,0.33,0.5,0.67,0.75,1,1.25,1.5,2,3,4];
  const setZoom = zoom => {
    const view=workspaceBounds(), cx=view.left+view.width/2, cy=view.top+view.height/2;
    const x=(cx-state.panX)/state.zoom,y=(cy-state.panY)/state.zoom;
    state.zoom=zoom;state.panX=cx-x*zoom;state.panY=cy-y*zoom;
    updateCanvasTransform();
  };
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => setZoom(zoomSteps.find(v=>v>state.zoom+0.001) ?? 4));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => setZoom([...zoomSteps].reverse().find(v=>v<state.zoom-0.001) ?? 0.01));
  document.getElementById('zoom-label')?.addEventListener('click', () => setZoom(1));
  document.getElementById('btn-zoom-all')?.addEventListener('click', () => fitWorkspace(true));

  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
    fitWorkspace();
  });

  document.getElementById('btn-review-compare')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await waitForCommands();
      const pageId = state.activePageId;
      const history = await (await fetch(`/api/design/reviews?pageId=${encodeURIComponent(pageId)}`)).json();
      const previous = history.reviews.find(r => r.revision < state.appliedRevision);
      showToast(previous ? '正在生成修改前后对照…' : '正在记录当前画面，改稿后可再次对照…', 'info', 12000);
      const review = await apiPost('/api/design/review', { pageId, baseRevision: state.appliedRevision, ...(previous ? { compareWithReviewId: previous.reviewId } : {}) });
      document.getElementById('review-dialog')?.remove();
      const dialog = document.createElement('dialog');
      dialog.id = 'review-dialog'; dialog.className = 'review-dialog';
      const figures = [];
      if (review.comparison) figures.push({ id: previous.reviewId, revision: previous.revision, side: 'before', label: '修改前' });
      figures.push({ id: review.reviewId, revision: review.revision, side: 'after', label: review.comparison ? '修改后' : '已记录的基准画面' });
      const changes = review.comparison?.changedNodes || [];
      const width = review.board.totalW, height = review.board.totalH;
      dialog.innerHTML = `<header><strong>画面对照</strong><button id="close-review" aria-label="关闭画面对照">关闭</button></header>
        <p>${review.comparison ? `${changes.length} 个图层发生变化，黄色边框标出图层范围。` : '已保存当前画面。修改设计后，再点击「对照」查看前后变化。'}</p>
        <div class="review-figures">${figures.map(item => `<figure><figcaption>${item.label} · r${item.revision}</figcaption><div class="review-image"><img alt="${item.label}" src="/api/design/reviews/${item.id}/image" /><svg viewBox="0 0 ${item.side === 'before' ? review.comparison.beforeBoard.totalW : width} ${item.side === 'before' ? review.comparison.beforeBoard.totalH : height}" preserveAspectRatio="none">${changes.map(n => n[item.side] ? `<rect x="${n[item.side].x}" y="${n[item.side].y}" width="${n[item.side].w}" height="${n[item.side].h}" />` : '').join('')}</svg></div></figure>`).join('')}</div>
        ${changes.length ? `<ul>${changes.map(n => `<li>${escapeHtml(n.nodeId)} · ${escapeHtml(n.changedFields.join(', '))}</li>`).join('')}</ul>` : ''}
        <section class="review-findings" aria-label="画面问题与定位"></section>
        <p>画面与检查均对应记录时的版本，仍需结合内容判断设计。</p>`;
      const findings=dialog.querySelector('.review-findings');
      for(const finding of review.findings){
        const row=document.createElement('div'),text=document.createElement('p');row.className='review-finding';
        text.textContent=finding.message||finding.detail||finding.reason||finding.code;row.append(text);
        const location=finding.location?.targets?.[0];
        if(location){
          const button=document.createElement('button');button.textContent='定位图层';button.className='review-locate';button.dataset.nodeId=location.id;button.title=location.target?.reason||'';
          button.onclick=()=>{if(focusDiagnosticTarget(location,finding.location.binding))dialog.close();};row.append(button);
          if(location.target?.kind!=='node'){const source=document.createElement('small');source.textContent=location.target?.reason||'由源对象控制';row.append(source);}
        }
        findings.append(row);
      }
      document.body.append(dialog);
      dialog.querySelector('#close-review').onclick = () => dialog.close();
      dialog.showModal();
      showToast('画面已记录', 'info');
    } catch (err) { showToast(`画面对照失败：${err.message}`, 'error', 6000); }
    finally { button.disabled = false; }
  });

  document.getElementById('btn-export-rp')?.addEventListener('click', async () => {
    const button=document.getElementById('btn-export-rp');button.disabled=true;
    const identityKey=`studio-export-${state.doc.documentId}`;
    let identity;try{identity=JSON.parse(sessionStorage.getItem(identityKey));}catch{}
    identity ||= {requestKey:`export-${crypto.randomUUID()}`,baseRevision:state.appliedRevision};
    sessionStorage.setItem(identityKey,JSON.stringify(identity));
    try {
      await apiPost('/api/export-rp', {async:true,...identity});
      sessionStorage.removeItem(identityKey);await showProjectOperations();
    } catch (err) {
      showToast(`导出请求未确认：${err.message}。可在“操作”查看结果。`, 'error', 6000);
    }finally{button.disabled=false;}
  });

  document.getElementById('btn-export-code')?.addEventListener('click', async () => {
    const button = document.getElementById('btn-export-code');
    button.disabled = true;
    const identityKey = `studio-export-code-${state.doc.documentId}`;
    let identity;
    try { identity = JSON.parse(sessionStorage.getItem(identityKey)); } catch {}
    identity ||= { requestKey: `export-code-${crypto.randomUUID()}`, baseRevision: state.appliedRevision };
    sessionStorage.setItem(identityKey, JSON.stringify(identity));
    try {
      await apiPost('/api/export-code', { async: true, ...identity });
      sessionStorage.removeItem(identityKey);
      await showProjectOperations();
    } catch (err) {
      showToast(`代码导出请求未确认：${err.message}。可在“操作”查看结果。`, 'error', 6000);
    } finally {
      button.disabled = false;
    }
  });
}
