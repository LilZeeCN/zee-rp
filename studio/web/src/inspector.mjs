import { normalizeVisualCss } from '/visual-style.mjs';
import { escapeHtml, showToast, uiIcon } from './ui.mjs';
import { apiPost, dispatchCommands } from './api.mjs';
import { getActivePageScene, updateWorkspaceChrome } from './view.mjs';
import { renderAll, renderCanvasStage } from './render.mjs';
import { bindCommitOnEnter } from './forms.mjs';
import { state } from './state.mjs';

export function renderInspector() {
  renderInspectorContent();
  refineInspector();
}

export function refineInspector() {
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

export function renderInspectorContent() {
  const panel = document.getElementById('inspector-panel');
  if (!panel || !state.doc) return;

  const errBanner = state.lastError
    ? `<div class="diagnostic-banner"><strong>${escapeHtml(state.lastError.code || 'ERROR')}</strong>: ${escapeHtml(state.lastError.message)}</div>`
    : '';

  const diagnostics = [...(state.scene?.fontDiagnostics || []), ...(state.doc?.diagnostics || [])];
  const diagnosticsHtml = diagnostics.length
    ? `<details class="inspector-diagnostics"><summary>⚠ ${diagnostics.length} 条布局与字体提示</summary>${diagnostics.map(d => `<div class="diagnostic-banner"><strong>${escapeHtml(d.code || '提示')}</strong> · ${escapeHtml(d.message)}</div>`).join('')}</details>`
    : '';

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
    const screenNode = pgScene?._nodeMap?.get(`${pgDoc?.id}/${pgDoc?.id}_screen`) || pgScene?.nodes.find(n => n.id === `${pgDoc?.id}_screen`) || pgScene?.nodes[0];
    panel.innerHTML = `
      ${errBanner}
      ${diagnosticsHtml}
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
    bindCommitOnEnter(panel.querySelector('#insp-page-name'), name =>
      dispatchCommands({ type: 'renamePage', pageId: state.activePageId, name }));
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
    // W/H 共用一份提交闭包（双 committed 值去重）：任一框 Enter 提交后读两框，另一框失焦 change 不重复提交同一组值。
    const boardWInput = panel.querySelector('#insp-board-w');
    const boardHInput = panel.querySelector('#insp-board-h');
    const boardCommitted = { w: String(boardWInput?.value ?? ''), h: String(boardHInput?.value ?? '') };
    const commitBoardResize = async () => {
      const w = String(boardWInput?.value ?? '');
      const h = String(boardHInput?.value ?? '');
      if (w === boardCommitted.w && h === boardCommitted.h) return;
      const previous = { w: boardCommitted.w, h: boardCommitted.h };
      boardCommitted.w = w;
      boardCommitted.h = h;
      let ok = true;
      try {
        ok = (await dispatchCommands({ type: 'resizeArtboard', pageId: state.activePageId, w: Number(w), h: Number(h) })) !== false;
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        if (!ok) { boardCommitted.w = previous.w; boardCommitted.h = previous.h; }
      }
    };
    bindCommitOnEnter(boardWInput, commitBoardResize);
    bindCommitOnEnter(boardHInput, commitBoardResize);
    return;
  }

  // Multi-select Batch Inspector (when >= 2 nodes are selected)
  if (state.selectedIds.length >= 2) {
    const selNodes = state.selectedIds.map(id => pgScene.nodes.find(n => n.id === id)).filter(Boolean);
    const first = selNodes[0] || {};
    const canBoolean = selNodes.length === 2 && selNodes.every(n => n.type === 'path' && !n.locked);
    const booleanGroupHtml = canBoolean
      ? `<div class="prop-group">
          <div class="prop-group-title">矢量布尔运算 (${escapeHtml(selNodes[0].id)} ⊕ ${escapeHtml(selNodes[1].id)})</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button id="insp-bool-union" data-bool-op="union">∪ 并集 (Union)</button>
            <button id="insp-bool-subtract" data-bool-op="subtract">− 减去 (Subtract)</button>
            <button id="insp-bool-intersect" data-bool-op="intersect">∩ 交集 (Intersect)</button>
            <button id="insp-bool-exclude" data-bool-op="exclude">⊕ 差集 (Exclude)</button>
          </div>
        </div>`
      : '';
    panel.innerHTML = `
      ${errBanner}
      ${diagnosticsHtml}
      <div class="provenance-banner">
        <span>✨ 已选中 ${selNodes.length} 个节点 (${escapeHtml(selNodes.slice(0, 3).map(n => n.id).join(', '))}${selNodes.length > 3 ? '…' : ''})</span>
      </div>
      ${booleanGroupHtml}
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
      ${impactSummaryHtml}
    `;
    panel.querySelectorAll('[data-bool-op]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const op = btn.getAttribute('data-bool-op');
        const res = await dispatchCommands({
          type: 'booleanPathOp',
          pageId: state.activePageId,
          operation: op,
          nodeIds: [selNodes[0].id, selNodes[1].id],
        });
        if (res) {
          state.selectedIds = [selNodes[0].id];
          renderAll();
        }
      });
    });
    panel.querySelector('#insp-batch-align-left')?.addEventListener('click', () => document.getElementById('btn-align-left')?.click());
    panel.querySelector('#insp-batch-align-center')?.addEventListener('click', () => document.getElementById('btn-align-center')?.click());
    panel.querySelector('#insp-batch-align-top')?.addEventListener('click', () => document.getElementById('btn-align-top')?.click());
    panel.querySelector('#insp-batch-dist-h')?.addEventListener('click', () => document.getElementById('btn-distribute-h')?.click());

    const bindBatchProp = (sel, buildNodeCmd) => {
      bindCommitOnEnter(panel.querySelector(sel), value => {
        const cmds = selNodes.filter(n => !n.locked).map(n => buildNodeCmd(n, value));
        if (cmds.length > 0) return dispatchCommands(cmds);
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
    ${diagnosticsHtml}

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
        <div class="prop-field"><label>X</label><input id="insp-x" type="number" value="${node.x}" ${disAttr} /></div>
        <div class="prop-field"><label>Y</label><input id="insp-y" type="number" value="${node.y}" ${disAttr} /></div>
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
            <option value="row" ${node.layout === 'row' ? 'selected' : ''}>row (水平自动布局)</option>
            <option value="column" ${node.layout === 'column' ? 'selected' : ''}>column (垂直自动布局)</option>
            <option value="grid" ${node.layout === 'grid' ? 'selected' : ''}>grid (网格布局)</option>
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
        ${node.layout === 'grid' ? `<div class="prop-field"><label>列数</label><input id="insp-columns" type="number" min="1" step="1" value="${node.columns}" ${disAttr} /></div><div class="prop-field"><label>列间距</label><input id="insp-column-gap" type="number" min="0" value="${node.columnGap}" ${disAttr} /></div><div class="prop-field"><label>行间距</label><input id="insp-row-gap" type="number" min="0" value="${node.rowGap}" ${disAttr} /></div>` : ''}
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
      ${node.type === 'label' ? `
      <div class="prop-field" style="flex-direction:row;align-items:center;justify-content:space-between;">
        <label for="insp-wrap">自动换行 Wrap</label>
        <input id="insp-wrap" type="checkbox" ${node.wrap ? 'checked' : ''} ${disAttr} />
      </div>` : ''}
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
        <div class="prop-field">
          <label>旋转 Rotation (°)</label>
          <input id="insp-rotation" type="number" step="1" value="${node.rotation ?? 0}" ${disAttr} />
        </div>
      </div>
    </div>
    ${
      node.type === 'path'
        ? `<div class="prop-group" id="insp-vector-path-group">
            <div class="prop-group-title">矢量路径与曲线 (Vector Path)</div>
            <div style="font-size:11px;margin-bottom:8px;color:${node.nativeVectorCompatible ? '#8df0ca' : '#fbbf24'};">
              ${
                node.nativeVectorCompatible
                  ? '✓ RP9 Shape:300 原生可编辑矢量控制点'
                  : `⚠ RP9 宿主降级边界: ${escapeHtml((node.vectorFallbackReasons || []).join(', ') || '复合内孔/布尔路径')}`
              }
            </div>
            <div class="prop-field">
              <label>SVG Path d</label>
              <textarea id="insp-path-d" rows="3" spellcheck="false" ${disAttr}>${escapeHtml(node.svgD || '')}</textarea>
            </div>
            <div class="prop-grid">
              <div class="prop-field">
                <label>填充规则 FillRule</label>
                <select id="insp-fill-rule" ${disAttr}>
                  <option value="nonzero" ${(node.fillRule || 'nonzero') === 'nonzero' ? 'selected' : ''}>nonzero (非零环绕)</option>
                  <option value="evenodd" ${node.fillRule === 'evenodd' ? 'selected' : ''}>evenodd (奇偶环绕)</option>
                </select>
              </div>
              <div class="prop-field">
                <label>描边粗细 StrokeW</label>
                <input id="insp-stroke-width" type="number" min="0" step="0.5" value="${node.strokeWidth ?? 2}" ${disAttr} />
              </div>
            </div>
            <button id="btn-path-smooth" style="width:100%;margin-top:6px;" ${disAttr}>〰 自动平滑曲线控制点</button>
          </div>`
        : ''
    }
    ${impactSummaryHtml}
  `;

  panel.querySelector('#insp-path-d')?.addEventListener('change', e => {
    dispatchCommands({
      type: 'editPath',
      pageId: state.activePageId,
      nodeId: node.id,
      operation: 'set-subpaths',
      d: e.target.value.trim(),
    });
  });
  panel.querySelector('#insp-fill-rule')?.addEventListener('change', e => {
    dispatchCommands({
      type: 'editPath',
      pageId: state.activePageId,
      nodeId: node.id,
      operation: 'set-subpaths',
      fillRule: e.target.value,
    });
  });
  bindCommitOnEnter(panel.querySelector('#insp-stroke-width'), val => {
    dispatchCommands({
      type: 'setProperties',
      pageId: state.activePageId,
      nodeId: node.id,
      properties: { strokeWidth: Number(val) },
    });
  });

  const commitRotation = val => {
    const num = Number(val);
    if (!Number.isFinite(num)) return;
    dispatchCommands({
      type: 'setProperties',
      pageId: state.activePageId,
      nodeId: node.id,
      properties: { rotation: Math.round(num * 10) / 10 },
    });
  };
  // W8 复检修正：bindCommitOnEnter 已内含 change 绑定，裸 change 会与 Enter 双发（复检实测 2 笔）——只保留统一提交器。
  bindCommitOnEnter(panel.querySelector('#insp-rotation'), commitRotation);
  panel.querySelector('#btn-path-smooth')?.addEventListener('click', () => {
    dispatchCommands({
      type: 'editPath',
      pageId: state.activePageId,
      nodeId: node.id,
      operation: 'set-subpaths',
      smooth: true,
    });
  });

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
  bindCommitOnEnter(panel.querySelector('#insp-node-name'), name =>
    dispatchCommands({ type: 'renameNode', pageId: state.activePageId, nodeId: node.id, name }));

  const bindProp = (sel, buildCmd) => {
    bindCommitOnEnter(panel.querySelector(sel), value => dispatchCommands(buildCmd(value)));
  };

  // 数值输入提交校验：清空/非法/超大值回弹原值并提示，防止节点被移出画板（T-A-4/T-AR-1）。
  const GEO_NUM_LIMIT = 10000;
  const bindGuardedNumProp = (sel, buildCmd, opts = {}) => {
    const el = panel.querySelector(sel);
    if (!el) return;
    bindCommitOnEnter(el, async value => {
      const raw = String(value).trim();
      const num = Number(raw);
      const original = String(opts.original());
      const revert = () => { el.value = original; };
      if (raw === '' || !Number.isFinite(num)) {
        showToast(`请输入有效数值，已保留原值 ${original}`, 'warn', 2800);
        revert();
        return false;
      }
      if (Math.abs(num) > GEO_NUM_LIMIT) {
        showToast(`数值超出安全范围（|${num}| > ${GEO_NUM_LIMIT}），已保留原值 ${original}`, 'warn', 3200);
        revert();
        return false;
      }
      if (num < 0 && opts.warnNegative) {
        showToast(`${opts.warnNegative}：负值会把节点移出画板可视区`, 'warn', 2800);
      }
      try {
        await dispatchCommands(buildCmd(value));
      } catch (err) {
        // 服务端拒绝时 apiPost 已重绘检查器并弹出错误提示，这里只兜底回填输入框。
        revert();
        return false;
      }
    });
  };

  // 检查器显示页面绝对坐标（与 studio_inspect bounds / DOM 一致，S1-N1）；
  // 提交时改用 deltaX/deltaY，由命令层换算回父内容盒内坐标，语义不受坐标系影响。
  bindGuardedNumProp('#insp-x', val => ({ type: 'moveNode', pageId: state.activePageId, nodeId: node.id, deltaX: Number(val) - node.x }), {
    original: () => node.x,
    warnNegative: 'X 为负',
  });
  bindGuardedNumProp('#insp-y', val => ({ type: 'moveNode', pageId: state.activePageId, nodeId: node.id, deltaY: Number(val) - node.y }), {
    original: () => node.y,
    warnNegative: 'Y 为负',
  });
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
  for (const [selector,field] of [['#insp-columns','columns'],['#insp-column-gap','columnGap'],['#insp-row-gap','rowGap']]) bindProp(selector,val=>({type:'setLayout',pageId:state.activePageId,nodeId:node.id,[field]:Number(val)}));
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
    autoSize: true,
  }));
  const wrapToggle = panel.querySelector('#insp-wrap');
  if (wrapToggle) {
    wrapToggle.addEventListener('change', () => {
      dispatchCommands({
        type: 'setProperties',
        pageId: state.activePageId,
        nodeId: node.id,
        properties: { wrap: wrapToggle.checked },
      });
    });
  }
  bindProp('#insp-font-family', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    fontFamily: val.trim(),
  }));
  bindGuardedNumProp('#insp-font-size', val => ({
    type: 'setFont',
    pageId: state.activePageId,
    nodeId: node.id,
    fontSize: Number(val),
  }), {
    original: () => node.fontSize || 14,
  });
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
