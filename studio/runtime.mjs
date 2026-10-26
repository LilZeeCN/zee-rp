import { resolveDocumentScene, evaluateSimpleDisplayFormula } from './scene-resolver.mjs';

export class StudioRuntimeSession {
  constructor(doc, { sessionId = `rt_${Date.now()}` } = {}) {
    this.sessionId = sessionId;
    this.docSnapshot = structuredClone(doc);
    this.reset();
  }

  reset(startPageId = null) {
    const pages = this.docSnapshot.pages || [];
    this.currentPageId = startPageId || pages[0]?.id || 'home';
    this.variables = {};
    for (const [k, v] of Object.entries(this.docSnapshot.variables || {})) {
      this.variables[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
    }

    this.inputs = {};
    this.visibility = {};
    this.textOverrides = {};
    this.panelStates = {};
    this.datasets = {};
    this.datasetFilters = {};
    this.datasetSorts = {};
    this.selectedRows = {};
    this.cardFlipped = {};
    this.trace = [];

    for (const [dsName, ds] of Object.entries(this.docSnapshot.datasets || {})) {
      const rows = Array.isArray(ds?.rows) ? structuredClone(ds.rows) : Array.isArray(ds) ? structuredClone(ds) : [];
      this.datasets[dsName] = rows.map((r, idx) => ({
        _rowId: r._rowId ?? r.id ?? `row_${idx + 1}`,
        ...r,
      }));
      this.datasetFilters[dsName] = null;
      this.datasetSorts[dsName] = null;
      this.selectedRows[dsName] = new Set();
    }

    // Initialize inputs, visibility, and panelStates from document tree
    for (const pg of pages) {
      this._initTreeState(pg.root, pg.id);
    }

    return this.getState();
  }

  _initTreeState(node, pageId) {
    if (!node || typeof node !== 'object') return;
    if (node.visible === false || node.hidden === true) {
      this.visibility[`${pageId}/${node.id}`] = false;
      this.visibility[node.id] = false;
    }
    if (node.type === 'input') {
      const val = node.value !== undefined ? String(node.value) : '';
      this.inputs[`${pageId}/${node.id}`] = val;
      this.inputs[node.id] = val;
    }
    if (node.type === 'dynamic-panel' && Array.isArray(node.states) && node.states.length > 0) {
      const active = node.activeState || node.states[0].id;
      this.panelStates[`${pageId}/${node.id}`] = active;
      this.panelStates[node.id] = active;
      for (const st of node.states) {
        if (st.root) this._initTreeState(st.root, pageId);
      }
    }
    if (node.type === 'repeater' && !this.datasets[node.dataset || node.id] && Array.isArray(node.rows)) {
      const key = node.dataset || node.id;
      this.datasets[key] = structuredClone(node.rows).map((r, idx) => ({
        _rowId: r._rowId ?? r.id ?? `row_${idx + 1}`,
        ...r,
      }));
      this.datasetFilters[key] = null;
      this.datasetSorts[key] = null;
      this.selectedRows[key] = new Set();
    }
    if (Array.isArray(node.children)) {
      for (const ch of node.children) this._initTreeState(ch, pageId);
    }
  }

  findNodeInPage(pageId, targetId) {
    const pg = (this.docSnapshot.pages || []).find(p => p.id === pageId);
    if (!pg) return null;
    const rawTarget = String(targetId);
    const parts = rawTarget.split('/').filter(Boolean);
    const stripped = parts.at(-1);
    const explicitState = parts.length >= 3 ? parts[parts.length - 2] : null;
    const panelStates = this.panelStates;

    function walk(n) {
      if (!n || typeof n !== 'object') return null;
      if (n.id === stripped || n.name === stripped) return n;
      for (const ch of n.children || []) {
        const hit = walk(ch);
        if (hit) return hit;
      }
      if (Array.isArray(n.states) && n.states.length > 0) {
        const activeStateId = explicitState || panelStates[`${pageId}/${n.id}`] || panelStates[n.id] || n.activeState || n.states[0].id;
        const orderedStates = [
          ...n.states.filter(s => s.id === activeStateId),
          ...n.states.filter(s => s.id !== activeStateId),
        ];
        for (const st of orderedStates) {
          if (st.root) {
            const hit = walk(st.root);
            if (hit) return hit;
          }
        }
      }
      return null;
    }
    return walk(pg.root);
  }

  getWidgetText(widgetId) {
    const stripped = String(widgetId).includes('/') ? String(widgetId).split('/').pop() : String(widgetId);
    const scoped = `${this.currentPageId}/${stripped}`;
    if (scoped in this.inputs) return String(this.inputs[scoped] ?? '');
    if (stripped in this.inputs) return String(this.inputs[stripped] ?? '');
    if (scoped in this.textOverrides) return String(this.textOverrides[scoped] ?? '');
    if (stripped in this.textOverrides) return String(this.textOverrides[stripped] ?? '');

    const node = this.findNodeInPage(this.currentPageId, stripped)
      || resolveDocumentScene(this.docSnapshot).pages.find(p => p.id === this.currentPageId)?.nodes.find(n => n.id === stripped);
    if (!node) return '';
    const raw = String(node.text ?? node.value ?? '');
    if (raw.startsWith('=')) {
      return this.evaluateExpression(raw);
    }
    return raw;
  }

  isNodeVisible(nodeId, pageId = this.currentPageId, resolvedNode = null) {
    const stripped = String(nodeId).includes('/') ? String(nodeId).split('/').pop() : String(nodeId);
    const scoped = `${pageId}/${stripped}`;
    if (scoped in this.visibility) return Boolean(this.visibility[scoped]);
    if (stripped in this.visibility) return Boolean(this.visibility[stripped]);
    const node = this.findNodeInPage(pageId, stripped) || resolvedNode;
    if (!node) return false;
    return node.visible !== false && node.hidden !== true;
  }

  evaluateExpression(expr) {
    if (expr === null || expr === undefined) return '';
    if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
    const str = String(expr).trim();
    if (!str.startsWith('=')) return str;

    const body = str.slice(1).trim();

    // Check simple display formulas first
    const textAddMatch = body.match(/^text\(\s*(\d+)\s*\+\s*(?:var\.|\$)([a-zA-Z0-9_]+)\s*\)$/);
    if (textAddMatch) {
      return String(Number(textAddMatch[1]) + Number(this.variables[textAddMatch[2]] || 0));
    }
    const textVarMatch = body.match(/^text\(\s*(?:var\.|\$)([a-zA-Z0-9_]+)\s*\)$/);
    if (textVarMatch) {
      return String(this.variables[textVarMatch[1]] ?? '');
    }

    // Check @widget shorthand (e.g. =@note or =@location)
    const atWidgetMatch = body.match(/^@([a-zA-Z0-9_/-]+)$/);
    if (atWidgetMatch) {
      return this.getWidgetText(atWidgetMatch[1]);
    }

    // Replace @<id>, widget.<id>.text, var.<name>, $<name>
    const jsExpr = body
      .replace(/@([a-zA-Z0-9_-]+)/g, (_, id) => JSON.stringify(this.getWidgetText(id)))
      .replace(/widget\.([a-zA-Z0-9_-]+)\.text/g, (_, id) => JSON.stringify(this.getWidgetText(id)))
      .replace(/var\.([a-zA-Z0-9_]+)/g, (_, name) => JSON.stringify(this.variables[name] ?? ''))
      .replace(/\$([a-zA-Z0-9_]+)/g, (_, name) => JSON.stringify(this.variables[name] ?? ''));

    try {
      // Safe expression evaluation for arithmetic/boolean/string expressions
      const fn = new Function(`return (${jsExpr});`);
      return fn();
    } catch {
      return evaluateSimpleDisplayFormula(str, this.variables);
    }
  }

  getVisibleDatasetRows(dsName) {
    const baseRows = this.datasets[dsName] || [];
    const filterSpec = this.datasetFilters[dsName];
    const sortSpec = this.datasetSorts[dsName];
    const selectedSet = this.selectedRows[dsName] || new Set();

    let rows = baseRows.map(r => ({
      ...r,
      _selected: selectedSet.has(r._rowId),
    }));

    if (filterSpec) {
      if (typeof filterSpec === 'function') {
        rows = rows.filter(filterSpec);
      } else if (typeof filterSpec === 'string' && filterSpec.trim() !== '') {
        const q = filterSpec.trim().toLowerCase();
        rows = rows.filter(r =>
          Object.entries(r).some(([k, v]) => !k.startsWith('_') && String(v).toLowerCase().includes(q))
        );
      } else if (typeof filterSpec === 'object') {
        const { field, value, operator = 'includes' } = filterSpec;
        if (field && value !== undefined && String(value) !== '' && String(value) !== 'all') {
          const target = String(value).toLowerCase();
          rows = rows.filter(r => {
            const cell = String(r[field] ?? '').toLowerCase();
            if (operator === 'eq' || operator === '==') return cell === target;
            return cell.includes(target);
          });
        }
      }
    }

    if (sortSpec && sortSpec.field) {
      const { field, order = 'asc' } = sortSpec;
      const dir = String(order).toLowerCase() === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const va = a[field];
        const vb = b[field];
        const na = Number(va);
        const nb = Number(vb);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '') {
          return (na - nb) * dir;
        }
        return String(va ?? '').localeCompare(String(vb ?? ''), 'zh-CN') * dir;
      });
    }

    return rows;
  }

  setInput(targetId, value) {
    const stripped = String(targetId).includes('/') ? String(targetId).split('/').pop() : String(targetId);
    const scoped = `${this.currentPageId}/${stripped}`;
    this.inputs[scoped] = String(value);
    this.inputs[stripped] = String(value);
    this.trace.push({
      step: this.trace.length + 1,
      type: 'input',
      pageId: this.currentPageId,
      targetId: stripped,
      value: String(value),
    });
    return this.getState();
  }

  navigate(pageId) {
    const targetPage = (this.docSnapshot.pages || []).find(p => p.id === pageId || p.name === pageId);
    if (!targetPage) {
      throw Object.assign(new Error(`未知页面: "${pageId}"`), { code: 'E_RUNTIME_PAGE_NOT_FOUND' });
    }
    this.currentPageId = targetPage.id;
    this.trace.push({
      step: this.trace.length + 1,
      type: 'navigate',
      pageId: this.currentPageId,
    });
    return this.getState();
  }

  click(targetId) {
    const stripped = String(targetId).includes('/') ? String(targetId).split('/').pop() : String(targetId);
    const node = this.findNodeInPage(this.currentPageId, stripped);
    if (!node) {
      throw Object.assign(
        new Error(`当前页面 "${this.currentPageId}" 中未找到交互目标 "${targetId}"`),
        { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId: this.currentPageId, targetId }
      );
    }

    const clickSpec = node.on?.click || node.onClick || node.interactions?.click;
    const executed = [];
    if (clickSpec && !['disabled', 'loading'].includes(node.state)) {
      this._executeInteractionSpec(clickSpec, node, executed);
    }

    this.trace.push({
      step: this.trace.length + 1,
      type: 'click',
      pageId: this.currentPageId,
      targetId: stripped,
      executed,
      variables: structuredClone(this.variables),
    });

    return this.getState();
  }

  _executeInteractionSpec(spec, sourceNode, executed) {
    if (!spec) return;
    if (Array.isArray(spec)) {
      for (const item of spec) this._executeInteractionSpec(item, sourceNode, executed);
      return;
    }
    if (typeof spec === 'string') {
      this.navigate(spec);
      executed.push({ action: 'link', to: spec });
      return;
    }
    if (typeof spec !== 'object') return;

    // Conditional cases (`cases` array or `if`/`when`)
    if (Array.isArray(spec.cases)) {
      for (const c of spec.cases) {
        const cond = c.when ?? c.if ?? c.condition;
        const matched = cond === undefined || cond === 'else' || Boolean(this.evaluateExpression(cond));
        if (matched) {
          this._executeActionObject(c, sourceNode, executed);
          if (c.break !== false) break;
        }
      }
      return;
    }

    if (spec.when !== undefined || spec.if !== undefined) {
      const cond = spec.when ?? spec.if;
      const matched = Boolean(this.evaluateExpression(cond));
      if (matched) {
        this._executeActionObject(spec.then || spec, sourceNode, executed);
      } else if (spec.else) {
        this._executeInteractionSpec(spec.else, sourceNode, executed);
      }
      return;
    }

    this._executeActionObject(spec, sourceNode, executed);
  }

  _executeActionObject(act, sourceNode, executed) {
    if (!act || typeof act !== 'object') return;
    if (Array.isArray(act)) {
      for (const item of act) this._executeInteractionSpec(item, sourceNode, executed);
      return;
    }

    // 1. Set variables (`setVar` map or `type: 'set-var'` / `'set-variable'`)
    if (act.setVar && typeof act.setVar === 'object') {
      for (const [varName, expr] of Object.entries(act.setVar)) {
        const val = this.evaluateExpression(expr);
        this.variables[varName] = val;
        executed.push({ action: 'set-var', name: varName, value: val });
      }
    }
    if (act.type === 'set-var' || act.type === 'set-variable' || act.action === 'set-var' || act.action === 'set-variable') {
      const val = this.evaluateExpression(act.value ?? act.expr);
      this.variables[act.name || act.variable] = val;
      executed.push({ action: 'set-var', name: act.name || act.variable, value: val });
    }

    // 2. Show / Hide widgets
    if (act.show) {
      const targets = Array.isArray(act.show) ? act.show : [act.show];
      for (const t of targets) {
        const stripped = String(t).split('/').pop();
        this.visibility[`${this.currentPageId}/${stripped}`] = true;
        this.visibility[stripped] = true;
        executed.push({ action: 'show', target: stripped });
      }
    }
    if (act.hide) {
      const targets = Array.isArray(act.hide) ? act.hide : [act.hide];
      for (const t of targets) {
        const stripped = String(t).split('/').pop();
        this.visibility[`${this.currentPageId}/${stripped}`] = false;
        this.visibility[stripped] = false;
        executed.push({ action: 'hide', target: stripped });
      }
    }
    if (act.type === 'show' || act.type === 'hide') {
      const vis = act.type === 'show';
      const stripped = String(act.target).split('/').pop();
      this.visibility[`${this.currentPageId}/${stripped}`] = vis;
      this.visibility[stripped] = vis;
      executed.push({ action: act.type, target: stripped });
    }

    // 3. Set widget text
    if (act.setText && typeof act.setText === 'object') {
      for (const [targetId, expr] of Object.entries(act.setText)) {
        const stripped = String(targetId).split('/').pop();
        const val = String(this.evaluateExpression(expr));
        this.textOverrides[`${this.currentPageId}/${stripped}`] = val;
        this.textOverrides[stripped] = val;
        executed.push({ action: 'set-text', target: stripped, text: val });
      }
    }
    if (act.type === 'set-text') {
      const stripped = String(act.target).split('/').pop();
      const val = String(this.evaluateExpression(act.text ?? act.value));
      this.textOverrides[`${this.currentPageId}/${stripped}`] = val;
      this.textOverrides[stripped] = val;
      executed.push({ action: 'set-text', target: stripped, text: val });
    }

    // 4. Set dynamic panel state (including study-card flip / next / prev / toggle)
    const panelAct = act.setPanelState || (act.type === 'set-panel-state' ? act : null);
    if (panelAct) {
      const list = Array.isArray(panelAct) ? panelAct : [panelAct];
      for (const item of list) {
        const panelId = String(item.target || item.panel).split('/').pop();
        const panelNode = this.findNodeInPage(this.currentPageId, panelId);
        let nextState = item.state;
        const curState = this.panelStates[`${this.currentPageId}/${panelId}`] || this.panelStates[panelId] || panelNode?.activeState || panelNode?.states?.[0]?.id;
        if ((nextState === 'next' || nextState === 'toggle' || nextState === 'flip') && panelNode?.states?.length) {
          const idx = panelNode.states.findIndex(s => s.id === curState);
          nextState = panelNode.states[(idx + 1) % panelNode.states.length].id;
        } else if (nextState === 'prev' && panelNode?.states?.length) {
          const idx = panelNode.states.findIndex(s => s.id === curState);
          nextState = panelNode.states[(idx - 1 + panelNode.states.length) % panelNode.states.length].id;
        }
        this.panelStates[`${this.currentPageId}/${panelId}`] = nextState;
        this.panelStates[panelId] = nextState;
        executed.push({ action: 'set-panel-state', panel: panelId, state: nextState });
      }
    }

    // 5. Dataset / Repeater operations (add, update, delete, select, filter, sort)
    if (act.datasetAction || act.type?.startsWith('dataset-') || act.type?.startsWith('repeater-')) {
      this._executeDatasetAction(act.datasetAction || act, executed);
    }

    // 6. Page navigation (`link` or `to` or `page` or `navigate`)
    const linkTarget = act.link || (act.type === 'link' || act.type === 'navigate' ? act.page || act.to || act.target : null);
    if (linkTarget) {
      this.navigate(linkTarget);
      executed.push({ action: 'link', to: linkTarget });
    }

    // 7. Nested `actions` array
    if (Array.isArray(act.actions)) {
      for (const sub of act.actions) {
        this._executeInteractionSpec(sub, sourceNode, executed);
      }
    }
  }

  _executeDatasetAction(act, executed) {
    const dsName = act.dataset || act.repeater || Object.keys(this.datasets)[0];
    if (!dsName || !this.datasets[dsName]) return;
    const op = (act.op || act.type || '').replace(/^(dataset-|repeater-)/, '');
    const selected = this.selectedRows[dsName] || new Set();

    if (op === 'select' || op === 'toggle-select') {
      const rowId = act.rowId;
      if (act.clearOthers !== false) selected.clear();
      if (op === 'toggle-select' && selected.has(rowId)) selected.delete(rowId);
      else if (rowId !== undefined && rowId !== null) selected.add(rowId);
      executed.push({ action: 'dataset-select', dataset: dsName, selectedRowIds: [...selected] });
      return;
    }

    if (op === 'add') {
      const rawRow = act.row || {};
      const resolvedRow = { _rowId: rawRow._rowId || rawRow.id || `row_${Date.now()}_${this.datasets[dsName].length + 1}` };
      for (const [k, v] of Object.entries(rawRow)) {
        resolvedRow[k] = this.evaluateExpression(v);
      }
      // Guard against empty required fields if guardEmpty is enabled
      if (act.requireNonEmpty) {
        const fields = Array.isArray(act.requireNonEmpty) ? act.requireNonEmpty : [act.requireNonEmpty];
        const hasEmpty = fields.some(f => !String(resolvedRow[f] ?? '').trim());
        if (hasEmpty) {
          if (act.onEmptyShow) {
            this.visibility[`${this.currentPageId}/${act.onEmptyShow}`] = true;
            this.visibility[act.onEmptyShow] = true;
          }
          executed.push({ action: 'dataset-add-blocked', dataset: dsName, reason: 'empty_required_field' });
          return;
        }
      }
      this.datasets[dsName].push(resolvedRow);
      executed.push({ action: 'dataset-add', dataset: dsName, row: resolvedRow });
      return;
    }

    if (op === 'update') {
      const targetIds = act.rowId ? new Set([act.rowId]) : selected;
      if (targetIds.size === 0) {
        if (act.onEmptySelectionShow) {
          this.visibility[`${this.currentPageId}/${act.onEmptySelectionShow}`] = true;
          this.visibility[act.onEmptySelectionShow] = true;
        }
        executed.push({ action: 'dataset-update-guarded', dataset: dsName, reason: 'empty_selection' });
        return;
      }
      const patch = act.patch || act.row || {};
      let updatedCount = 0;
      for (const r of this.datasets[dsName]) {
        if (targetIds.has(r._rowId) || targetIds.has(r.id)) {
          for (const [k, v] of Object.entries(patch)) {
            r[k] = this.evaluateExpression(v);
          }
          updatedCount++;
        }
      }
      executed.push({ action: 'dataset-update', dataset: dsName, updatedCount });
      return;
    }

    if (op === 'delete') {
      const targetIds = act.rowId ? new Set([act.rowId]) : selected;
      if (targetIds.size === 0) {
        if (act.onEmptySelectionShow) {
          this.visibility[`${this.currentPageId}/${act.onEmptySelectionShow}`] = true;
          this.visibility[act.onEmptySelectionShow] = true;
        }
        executed.push({ action: 'dataset-delete-guarded', dataset: dsName, reason: 'empty_selection' });
        return;
      }
      const before = this.datasets[dsName].length;
      this.datasets[dsName] = this.datasets[dsName].filter(r => !targetIds.has(r._rowId) && !targetIds.has(r.id));
      for (const id of targetIds) selected.delete(id);
      executed.push({ action: 'dataset-delete', dataset: dsName, deletedCount: before - this.datasets[dsName].length });
      return;
    }

    if (op === 'filter') {
      const query = act.query !== undefined ? this.evaluateExpression(act.query) : null;
      this.datasetFilters[dsName] = act.field
        ? { field: act.field, value: query, operator: act.operator || 'includes' }
        : query;
      executed.push({ action: 'dataset-filter', dataset: dsName, filter: this.datasetFilters[dsName] });
      return;
    }

    if (op === 'sort') {
      this.datasetSorts[dsName] = act.field ? { field: act.field, order: act.order || 'asc' } : null;
      executed.push({ action: 'dataset-sort', dataset: dsName, sort: this.datasetSorts[dsName] });
    }
  }

  runScenario(steps = []) {
    const stepResults = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.action === 'navigate' || step.goto) {
        this.navigate(step.page || step.goto || step.target);
      } else if (step.action === 'input' || step.fill) {
        this.setInput(step.target || step.id || step.fill, step.value ?? step.text ?? '');
      } else if (step.action === 'click' || step.click) {
        this.click(step.target || step.click || step.id);
      } else if (step.action === 'dataset') {
        const executed = [];
        this._executeDatasetAction(step, executed);
        this.trace.push({ step: this.trace.length + 1, type: 'dataset', pageId: this.currentPageId, executed });
      }

      const assertions = [];
      if (step.expect) {
        const exp = step.expect;
        if (exp.page !== undefined) {
          const passed = this.currentPageId === exp.page;
          assertions.push({ type: 'page', expected: exp.page, actual: this.currentPageId, passed });
        }
        if (exp.panelState) {
          for (const [panelId, expectedState] of Object.entries(exp.panelState)) {
            const actual = this.panelStates[`${this.currentPageId}/${panelId}`] || this.panelStates[panelId];
            assertions.push({ type: 'panelState', target: panelId, expected: expectedState, actual, passed: actual === expectedState });
          }
        }
        if (exp.variables) {
          for (const [varName, expectedVal] of Object.entries(exp.variables)) {
            const actual = this.variables[varName];
            assertions.push({ type: 'variable', target: varName, expected: expectedVal, actual, passed: String(actual) === String(expectedVal) });
          }
        }
        if (exp.text) {
          for (const [nodeId, expectedText] of Object.entries(exp.text)) {
            const actual = this.getWidgetText(nodeId);
            const passed = typeof expectedText === 'object' && expectedText.includes
              ? actual.includes(expectedText.includes)
              : actual === String(expectedText);
            assertions.push({ type: 'text', target: nodeId, expected: expectedText, actual, passed });
          }
        }
        if (exp.visible) {
          for (const [nodeId, expectedVis] of Object.entries(exp.visible)) {
            const actual = this.isNodeVisible(nodeId);
            assertions.push({ type: 'visible', target: nodeId, expected: Boolean(expectedVis), actual, passed: actual === Boolean(expectedVis) });
          }
        }
        if (exp.datasetCount) {
          for (const [dsName, expectedCount] of Object.entries(exp.datasetCount)) {
            const actual = this.getVisibleDatasetRows(dsName).length;
            assertions.push({ type: 'datasetCount', target: dsName, expected: expectedCount, actual, passed: actual === expectedCount });
          }
        }
        if (exp.datasetFirstRow) {
          for (const [dsName, expectedFields] of Object.entries(exp.datasetFirstRow)) {
            const first = this.getVisibleDatasetRows(dsName)[0] || {};
            const passed = Object.entries(expectedFields).every(([k, v]) => String(first[k]) === String(v));
            assertions.push({ type: 'datasetFirstRow', target: dsName, expected: expectedFields, actual: first, passed });
          }
        }
      }

      stepResults.push({
        stepIndex: i + 1,
        step,
        currentPageId: this.currentPageId,
        assertions,
        passed: assertions.every(a => a.passed),
      });
    }

    return {
      ok: stepResults.every(s => s.passed),
      totalSteps: stepResults.length,
      passedSteps: stepResults.filter(s => s.passed).length,
      stepResults,
      finalState: this.getState(),
    };
  }

  getState() {
    const visibleDatasets = {};
    for (const dsName of Object.keys(this.datasets)) {
      visibleDatasets[dsName] = {
        totalRows: this.datasets[dsName].length,
        visibleRows: this.getVisibleDatasetRows(dsName),
        selectedRowIds: [...(this.selectedRows[dsName] || [])],
        filter: this.datasetFilters[dsName],
        sort: this.datasetSorts[dsName],
      };
    }

    const scene = resolveDocumentScene(this.docSnapshot, {
      activePanelStates: this.panelStates,
      runtimeState: {
        variables: this.variables,
        panelStates: this.panelStates,
      },
    });
    const activePageScene = scene.pages.find(p => p.id === this.currentPageId) || scene.pages[0];

    // Overlay runtime visibility, input values, and text overrides onto activePageScene.nodes
    const runtimeNodes = (activePageScene?.nodes || []).map(n => {
      const vis = this.isNodeVisible(n.id, this.currentPageId, n);
      let txt = n.text;
      if (n.type === 'input') {
        txt = this.inputs[`${this.currentPageId}/${n.id}`] ?? this.inputs[n.id] ?? n.text;
      } else if (`${this.currentPageId}/${n.id}` in this.textOverrides || n.id in this.textOverrides) {
        txt = this.textOverrides[`${this.currentPageId}/${n.id}`] ?? this.textOverrides[n.id];
      } else if (typeof n.rawText === 'string' && n.rawText.startsWith('=')) {
        txt = String(this.evaluateExpression(n.rawText));
      }
      return {
        ...n,
        visible: vis,
        text: txt,
      };
    });

    return {
      sessionId: this.sessionId,
      currentPageId: this.currentPageId,
      variables: structuredClone(this.variables),
      inputs: structuredClone(this.inputs),
      panelStates: structuredClone(this.panelStates),
      visibility: structuredClone(this.visibility),
      datasets: visibleDatasets,
      activePageScene: activePageScene ? { ...activePageScene, nodes: runtimeNodes } : null,
      traceCount: this.trace.length,
      trace: this.trace,
    };
  }
}
