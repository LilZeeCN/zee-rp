// 预览运行态(验收场景执行器与预览模拟用)。从 commands.mjs 原样迁移,纯函数无依赖。

/**
 * 创建原型交互运行时状态（用于验收场景执行器与预览模拟）
 */
export function createRuntimeState(doc) {
  const pages = doc?.pages || [];
  const currentPageId = pages[0]?.id || 'home';
  const variables = structuredClone(doc?.variables || {});
  const panelStates = {};
  const visibility = {};
  const selected = {};
  const datasets = {};

  for (const [dsName, dsDef] of Object.entries(doc?.datasets || {})) {
    const rows = structuredClone(dsDef?.rows || []);
    datasets[dsName] = {
      rows,
      visibleRows: structuredClone(rows),
      filterQuery: '',
      sort: null,
    };
  }

  function scanTree(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'dynamic-panel' && Array.isArray(n.states) && n.states.length > 0) {
      panelStates[n.id] = n.activeState || n.states[0].name || n.states[0].id;
    }
    if (n.hidden === true || n.visible === false) {
      visibility[n.id] = false;
    }
    if (n.selected === true) {
      selected[n.id] = true;
    }
    for (const ch of n.children || []) scanTree(ch);
    for (const st of n.states || []) {
      if (st.root) scanTree(st.root);
      for (const ch of st.children || []) scanTree(ch);
    }
  }
  for (const p of pages) scanTree(p.root);

  return {
    currentPageId,
    variables,
    panelStates,
    visibility,
    selected,
    datasets,
    history: [currentPageId],
  };
}

/**
 * 在原型运行时状态上模拟执行单步交互（click / set-variable / navigate / dataset-filter / dataset-sort 等）
 */
export function applyRuntimeStep(doc, runtime, step = {}) {
  const next = runtime || createRuntimeState(doc);
  const pages = doc?.pages || [];
  const currentPage = pages.find(p => p.id === next.currentPageId) || pages[0];
  const actionType = step.type || step.action;

  if (actionType === 'dataset-filter') {
    const dsName = step.dataset || 'records';
    const ds = next.datasets?.[dsName];
    if (ds) {
      const q = String(step.query ?? '').trim().toLowerCase();
      ds.filterQuery = q;
      ds.visibleRows = q
        ? ds.rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)))
        : structuredClone(ds.rows);
    }
    return next;
  }

  if (actionType === 'dataset-sort') {
    const dsName = step.dataset || 'records';
    const ds = next.datasets?.[dsName];
    if (ds && step.field) {
      const dir = step.direction === 'desc' ? -1 : 1;
      const fld = step.field;
      ds.sort = { field: fld, direction: step.direction || 'asc' };
      ds.visibleRows.sort((a, b) => (a[fld] > b[fld] ? dir : a[fld] < b[fld] ? -dir : 0));
    }
    return next;
  }

  function findNodeById(n, id) {
    if (!n || typeof n !== 'object') return null;
    if (n.id === id) return n;
    for (const ch of n.children || []) {
      const f = findNodeById(ch, id);
      if (f) return f;
    }
    for (const st of n.states || []) {
      if (st.root) {
        const f = findNodeById(st.root, id);
        if (f) return f;
      }
    }
    return null;
  }

  function evalCond(cond) {
    if (!cond || typeof cond !== 'object') return true;
    if (cond.variable) {
      const actual = next.variables[cond.variable];
      if (cond.equals !== undefined) return String(actual ?? '') === String(cond.equals);
      if (cond.notEquals !== undefined) return String(actual ?? '') !== String(cond.notEquals);
      if (cond.notEmpty) return actual !== undefined && actual !== null && String(actual).trim() !== '';
    }
    return true;
  }

  function execActions(actions) {
    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    for (const act of list) {
      if (!act) continue;
      if (typeof act === 'string') {
        next.currentPageId = act;
        next.history.push(act);
        continue;
      }
      const type = act.type || (act.page || act.navigate ? 'link' : act.state ? 'set-panel-state' : '');
      if (type === 'link' || type === 'navigate') {
        const targetPage = act.page || act.navigate || act.target;
        if (targetPage) {
          next.currentPageId = targetPage;
          next.history.push(targetPage);
        }
      } else if (type === 'set-panel-state' || type === 'setPanelState') {
        const target = act.target || act.panel || act.nodeId;
        if (target && act.state) next.panelStates[target] = act.state;
      } else if (type === 'show') {
        if (act.target) next.visibility[act.target] = true;
      } else if (type === 'hide') {
        if (act.target) next.visibility[act.target] = false;
      } else if (type === 'set-variable' || type === 'setVariable') {
        if (act.variable || act.name) next.variables[act.variable || act.name] = act.value;
      } else if (type === 'set-selected' || type === 'setSelected') {
        if (act.target) next.selected[act.target] = Boolean(act.value ?? true);
      }
    }
  }

  if (step.action === 'set-variable') {
    next.variables[step.variable || step.name] = step.value;
  } else if (step.action === 'navigate') {
    next.currentPageId = step.pageId;
    next.history.push(step.pageId);
  } else if (step.action === 'click' || step.nodeId) {
    const targetNode = findNodeById(currentPage?.root, step.nodeId);
    const clickSpec = targetNode?.on?.click;
    if (clickSpec) {
      if (Array.isArray(clickSpec)) {
        execActions(clickSpec);
      } else if (Array.isArray(clickSpec.cases)) {
        for (const c of clickSpec.cases) {
          if (evalCond(c.condition || c.when)) {
            execActions(c.actions);
            break;
          }
        }
      } else {
        execActions([clickSpec]);
      }
    }
  }

  return next;
}
