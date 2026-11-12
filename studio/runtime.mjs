import { resolveDocumentScene } from './scene-resolver.mjs';
import { evaluatePrototypeExpression, executePrototypeInteraction } from './prototype-runtime.mjs';
import { repeaterDatasetName, repeaterInlineRows } from './repeater-view.mjs';
import { lintDocumentInteractions } from './interaction-lint.mjs';

export const SCENARIO_STEP_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['navigate', 'input', 'click', 'dataset', 'expect', 'assert'] },
    target: { type: 'string' }, id: { type: 'string' }, page: { type: 'string' },
    goto: { type: 'string' }, fill: { type: 'string' }, click: { type: 'string' },
    value: {}, text: { type: 'string' },
    dataset: { type: 'string' }, repeater: { type: 'string' },
    op: { type: 'string', enum: ['select', 'toggle-select', 'add', 'update', 'delete', 'filter', 'sort', 'page'] },
    row: { type: 'object' }, patch: { type: 'object' }, rowId: {}, clearOthers: { type: 'boolean' },
    field: { type: 'string' }, query: {}, operator: { type: 'string' }, order: { type: 'string' },
    requireNonEmpty: {}, onEmptyShow: { type: 'string' }, onEmptySelectionShow: { type: 'string' },
    expect: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
      page: { type: 'string' },
      visible: { type: 'object', minProperties: 1, additionalProperties: { type: 'boolean' } },
      text: { type: 'object', minProperties: 1 }, variables: { type: 'object', minProperties: 1 },
      panelState: { type: 'object', minProperties: 1, additionalProperties: { type: 'string' } },
      checked: { type: 'object', minProperties: 1, additionalProperties: { type: 'boolean' } },
      selected: { type: 'object', minProperties: 1 },
      datasetCount: { type: 'object', minProperties: 1, additionalProperties: { type: 'integer', minimum: 0 } },
      datasetFirstRow: { type: 'object', minProperties: 1 },
    } },
  },
};

export class StudioRuntimeSession {
  constructor(doc, { sessionId = `rt_${Date.now()}`, projectDir = null } = {}) {
    this.sessionId = sessionId;
    this.projectDir = projectDir;
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
    this.checked = {};
    this.selectedOptions = {};
    this.selectedNodes = {};
    this.visibility = {};
    this.textOverrides = {};
    this.textFormulas = {};
    this.panelStates = {};
    this.datasets = {};
    this.datasetFilters = {};
    this.datasetSorts = {};
    this.datasetPages = {};
    this.datasetPageSizes = {};
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
      this.datasetPages[dsName] = 1;
      this.datasetPageSizes[dsName] = null;
      this.selectedRows[dsName] = new Set();
    }

    // Initialize inputs, visibility, and panelStates from document tree
    for (const pg of pages) {
      this._initTreeState(pg.root, pg.id);
    }

    return this.getState();
  }

  _initTreeState(node, pageId, scopePrefix = pageId) {
    if (!node || typeof node !== 'object') return;
    const scopedId = `${scopePrefix}/${node.id}`;
    if (node.visible === false || node.hidden === true) {
      this.visibility[scopedId] = false;
    }
    if (node.type === 'input') {
      const val = node.value !== undefined ? String(node.value) : '';
      this.inputs[scopedId] = val;
    }
    if (node.type === 'checkbox' || node.type === 'radio') {
      this.checked[scopedId] = Boolean(node.checked ?? node.selected);
    } else if (node.type === 'combobox' || node.type === 'listbox') {
      const opts = Array.isArray(node.options) ? node.options : [];
      if (Array.isArray(node.selectedIndices) && node.selectedIndices.length) {
        this.selectedOptions[scopedId] = node.selectedIndices.map(i => opts[i]).filter(v => v !== undefined);
      } else {
        const idx = typeof node.selectedIndex === 'number'
          ? node.selectedIndex
          : typeof node.selected === 'string'
            ? opts.indexOf(node.selected)
            : node.type === 'combobox'
              ? 0
              : -1;
        if (idx >= 0 && opts[idx] !== undefined) this.selectedOptions[scopedId] = opts[idx];
      }
    } else if (typeof node.selected === 'boolean') {
      this.selectedNodes[scopedId] = node.selected;
    }
    if (node.type === 'dynamic-panel' && Array.isArray(node.states) && node.states.length > 0) {
      const active = node.activeState || node.states[0].id;
      this.panelStates[scopedId] = active;
      for (const st of node.states) {
        if (st.root) this._initTreeState(st.root, pageId, `${scopedId}/${st.id}`);
      }
    }
    if (node.type === 'repeater') {
      const key = repeaterDatasetName(node);
      const inlineRows = repeaterInlineRows(node);
      if (!this.datasets[key] && (inlineRows.length || Array.isArray(node.rows))) {
        const seedRows = inlineRows.length ? inlineRows : node.rows;
        this.datasets[key] = structuredClone(seedRows).map((r, idx) => ({
          _rowId: r._rowId ?? r.id ?? `row_${idx + 1}`,
          ...r,
        }));
        this.datasetFilters[key] = null;
        this.datasetSorts[key] = null;
        this.selectedRows[key] = new Set();
      }
      if (Number.isInteger(node.pageSize) && node.pageSize > 0) {
        this.datasetPageSizes[key] = node.pageSize;
      }
      if (this.datasetPages[key] === undefined || (Number.isInteger(node.page) && node.page >= 1)) {
        this.datasetPages[key] = Number.isInteger(node.page) && node.page >= 1 ? node.page : 1;
      }
    }
    const collectFormulas = spec => {
      if (!spec || typeof spec !== 'object') return;
      if (Array.isArray(spec)) { spec.forEach(collectFormulas); return; }
      if (spec.type === 'set-text' && spec.target) {
        const expr = spec.text ?? spec.value;
        if (typeof expr === 'string' && expr.includes('dataset.')) {
          const target = this.findNodeEntry(pageId, spec.target, { scopePrefix });
          if (target && !this.textFormulas[target.scopedId]) this.textFormulas[target.scopedId] = { pageId, scopePrefix, expr };
        }
      }
      for (const k of ['actions', 'then', 'else', 'cases']) if (spec[k]) collectFormulas(spec[k]);
    };
    if (node.on?.click) collectFormulas(node.on.click);
    if (Array.isArray(node.children)) {
      for (const ch of node.children) this._initTreeState(ch, pageId, scopePrefix);
    }
  }

  findNodeEntry(pageId, targetId, { scopePrefix = this.interactionScope } = {}) {
    const raw = String(targetId?.ref ?? targetId), entries = [];
    const explicitPage = this.docSnapshot.pages.find(pg => raw.startsWith(`${pg.id}/`));
    const pg = explicitPage || this.docSnapshot.pages.find(p => p.id === pageId);
    if (!pg) return null;
    const walk = (node, prefix, active = true) => {
      if (!node) return;
      const scopedId = `${prefix}/${node.id}`;
      entries.push({ node, scopedId, scopePrefix: prefix, pageId: pg.id, active });
      for (const child of node.children || []) walk(child, prefix, active);
      for (const state of node.states || []) {
        const selected = this.panelStates[scopedId] || node.activeState || node.states[0]?.id;
        walk(state.root, `${scopedId}/${state.id}`, active && state.id === selected);
      }
      if (node.template) walk(node.template, `${scopedId}/template`, false);
    };
    walk(pg.root, pg.id);
    const full = explicitPage ? raw : `${pg.id}/${raw}`;
    let matches = entries.filter(e => e.scopedId === full);
    if (!raw.includes('/') && scopePrefix && scopePrefix !== pg.id) {
      const local = entries.filter(e => e.scopePrefix === scopePrefix && (e.node.id === raw || e.node.name === raw));
      if (local.length) matches = local;
    }
    if (!matches.length && !raw.includes('/')) {
      matches = entries.filter(e => e.node.id === raw || e.node.name === raw);
      const local = matches.filter(e => e.scopePrefix === scopePrefix);
      if (local.length) matches = local;
      else if (matches.some(e => e.active)) matches = matches.filter(e => e.active);
    }
    // Macro/component children have stable public scene IDs but no raw source
    // node of their own. Keep those targets usable without discarding the scope.
    if (!matches.length) {
      const scene = resolveDocumentScene(this.docSnapshot, { projectDir: this.projectDir, activePanelStates: this.panelStates });
      const nodes = scene.pages.find(p => p.id === pg.id)?.nodes || [];
      const candidates = nodes.filter(n => raw.includes('/') ? n.scopedId === full : n.id === raw || n.name === raw);
      matches = candidates.map(n => ({ node: { ...n, text: n.rawText ?? n.text }, scopedId: n.scopedId, scopePrefix: n.scopedId.slice(0, -n.id.length - 1), pageId: pg.id, active: true }));
    }
    if (matches.length > 1) throw Object.assign(new Error(`运行态目标 ${raw} 不唯一，请使用完整作用域路径`), { code: 'E_RUNTIME_TARGET_AMBIGUOUS', targetId: raw, candidates: matches.map(e => e.scopedId) });
    return matches[0] || null;
  }

  findNodeInPage(pageId, targetId) {
    return this.findNodeEntry(pageId, targetId)?.node || null;
  }

  targetKey(targetId, pageId = this.currentPageId) {
    const entry = this.findNodeEntry(pageId, targetId);
    if (!entry) throw Object.assign(new Error(`页面 ${pageId} 中未找到目标 ${targetId}`), { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId, targetId });
    return entry.scopedId;
  }

  getWidgetText(widgetId, { pageId = this.currentPageId, scopePrefix = this.interactionScope } = {}) {
    const entry = this.findNodeEntry(pageId, widgetId, { scopePrefix });
    if (!entry) return '';
    const scoped = entry.scopedId;
    if (scoped in this.inputs) return String(this.inputs[scoped] ?? '');
    if (scoped in this.selectedOptions) {
      const sel = this.selectedOptions[scoped];
      return Array.isArray(sel) ? sel.join(', ') : String(sel ?? '');
    }
    if (scoped in this.textOverrides) return String(this.textOverrides[scoped] ?? '');
    const node = entry.node;
    if (node.type === 'combobox' || node.type === 'listbox') {
      const opts = Array.isArray(node.options) ? node.options : [];
      return String(opts[node.selectedIndex ?? 0] ?? '');
    }
    const raw = String(node.text ?? node.value ?? '');
    if (raw.startsWith('=')) {
      return String(this.evaluateExpression(raw, { pageId: entry.pageId, scopePrefix: entry.scopePrefix }) ?? '');
    }
    return raw;
  }

  getWidgetState(widgetId, prop, { pageId = this.currentPageId, scopePrefix = this.interactionScope } = {}) {
    const entry = this.findNodeEntry(pageId, widgetId, { scopePrefix });
    if (!entry) return false;
    const scoped = entry.scopedId;
    if (prop === 'checked') {
      return scoped in this.checked ? Boolean(this.checked[scoped]) : Boolean(entry.node.checked ?? entry.node.selected);
    }
    if (prop === 'selected') {
      if (entry.node.type === 'checkbox' || entry.node.type === 'radio') {
        return scoped in this.checked ? Boolean(this.checked[scoped]) : Boolean(entry.node.checked ?? entry.node.selected);
      }
      if (entry.node.type === 'combobox' || entry.node.type === 'listbox') {
        if (scoped in this.selectedOptions) return this.selectedOptions[scoped];
        const opts = Array.isArray(entry.node.options) ? entry.node.options : [];
        return opts[entry.node.selectedIndex ?? 0] ?? '';
      }
      return scoped in this.selectedNodes ? Boolean(this.selectedNodes[scoped]) : Boolean(entry.node.selected);
    }
    return false;
  }

  isNodeVisible(nodeId, pageId = this.currentPageId) {
    const nodes = resolveDocumentScene(this.docSnapshot, {
      projectDir: this.projectDir,
      activePanelStates: this.panelStates,
      runtimeState: {
        variables: this.variables,
        panelStates: this.panelStates,
        visibility: this.visibility,
        checked: this.checked,
        selectedOptions: this.selectedOptions,
        selectedNodes: this.selectedNodes,
      },
    }).pages.find(p => p.id === pageId)?.nodes || [];
    const entry = this.findNodeEntry(pageId, nodeId);
    return Boolean(entry && nodes.some(n => n.scopedId === entry.scopedId && n.visible));
  }

  _findHiddenAncestor(targetScopedId, pageId = this.currentPageId) {
    const pg = (this.docSnapshot.pages || []).find(p => p.id === pageId);
    if (!pg?.root) return null;
    let foundAncestors = null;
    const walk = (node, prefix, ancestors) => {
      if (!node || typeof node !== 'object' || foundAncestors) return;
      const scopedId = `${prefix}/${node.id}`;
      if (scopedId === targetScopedId) {
        foundAncestors = ancestors;
        return;
      }
      const nextAnc = [...ancestors, { id: node.id, scopedId, node }];
      for (const ch of node.children || []) walk(ch, prefix, nextAnc);
      for (const st of node.states || []) {
        if (st?.root) walk(st.root, `${scopedId}/${st.id}`, nextAnc);
      }
    };
    walk(pg.root, pg.id, []);
    if (!foundAncestors) return null;
    for (const anc of foundAncestors) {
      const ownVis = anc.node.visible !== false && anc.node.hidden !== true;
      const curVis = anc.scopedId in this.visibility ? this.visibility[anc.scopedId] : ownVis;
      if (!curVis) return { id: anc.id, scopedId: anc.scopedId };
    }
    return null;
  }

  evaluateExpression(expr, context = {}) {
    return evaluatePrototypeExpression(expr, {
      variables: this.variables,
      getWidgetText: target => this.getWidgetText(target, context),
      getWidgetState: (target, prop) => this.getWidgetState(target, prop, context),
      resolveDatasetPath: (name, prop) => this.resolveDatasetPath(name, prop),
    });
  }

  getDatasetPageSize(dsName) {
    return this.datasetPageSizes?.[dsName] || null;
  }

  getDatasetTotalPages(dsName) {
    const rows = this.getVisibleDatasetRows(dsName);
    const pageSize = this.getDatasetPageSize(dsName);
    if (!pageSize || pageSize <= 0) return 1;
    return Math.max(1, Math.ceil(rows.length / pageSize));
  }

  getDatasetPage(dsName) {
    const totalPages = this.getDatasetTotalPages(dsName);
    const raw = Number(this.datasetPages?.[dsName] || 1);
    return Math.min(Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 1), totalPages);
  }

  getPagedDatasetRows(dsName) {
    const rows = this.getVisibleDatasetRows(dsName);
    const pageSize = this.getDatasetPageSize(dsName);
    if (!pageSize || pageSize <= 0) return rows;
    const page = this.getDatasetPage(dsName);
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }

  resolveDatasetPath(dsName, propPath) {
    const visible = this.getVisibleDatasetRows(dsName);
    const paged = this.getPagedDatasetRows(dsName);
    const page = this.getDatasetPage(dsName);
    const totalPages = this.getDatasetTotalPages(dsName);
    if (propPath === 'count') return visible.length;
    if (propPath === 'total') return (this.datasets[dsName] || []).length;
    if (propPath === 'page') return page;
    if (propPath === 'totalPages') return totalPages;
    if (propPath === 'pageStatus') return visible.length === 0 ? '第 0 / 0 页' : `第 ${page} / ${totalPages} 页`;
    if (propPath === 'countStatus') return `共 ${visible.length} 条记录`;
    if (propPath.startsWith('pageFirst.')) {
      const field = propPath.slice('pageFirst.'.length);
      return paged[0]?.[field] ?? '-';
    }
    if (propPath.startsWith('first.')) {
      const field = propPath.slice('first.'.length);
      return visible[0]?.[field] ?? '-';
    }
    if (propPath.startsWith('selected.')) {
      const field = propPath.slice('selected.'.length);
      const sel = visible.find(r => r._selected) || (this.datasets[dsName] || []).find(r => (this.selectedRows[dsName] || new Set()).has(r._rowId) || (r.id !== undefined && (this.selectedRows[dsName] || new Set()).has(r.id))) || paged[0] || visible[0];
      return sel?.[field] ?? '';
    }
    return '';
  }

  _refreshDatasetBoundText() {
    for (const [scopedId, info] of Object.entries(this.textFormulas || {})) {
      this.textOverrides[scopedId] = String(this.evaluateExpression(info.expr, info));
    }
  }

  getVisibleDatasetRows(dsName) {
    const baseRows = this.datasets[dsName] || [];
    const filterSpec = this.datasetFilters[dsName];
    const sortSpec = this.datasetSorts[dsName];
    const selectedSet = this.selectedRows[dsName] || new Set();

    let rows = baseRows.map(r => ({
      ...r,
      _selected: selectedSet.has(r._rowId) || (r.id !== undefined && selectedSet.has(r.id)),
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

  _walkPageEntries(pageId, fn) {
    const pg = (this.docSnapshot.pages || []).find(p => p.id === pageId);
    if (!pg?.root) return;
    const walk = (node, prefix) => {
      if (!node || typeof node !== 'object') return;
      const scopedId = `${prefix}/${node.id}`;
      fn(node, scopedId);
      for (const ch of node.children || []) walk(ch, prefix);
      for (const st of node.states || []) if (st?.root) walk(st.root, `${scopedId}/${st.id}`);
    };
    walk(pg.root, pg.id);
  }

  setChecked(targetId, val, executed = null) {
    const entry = this.findNodeEntry(this.currentPageId, targetId);
    if (!entry) throw Object.assign(new Error(`页面 ${this.currentPageId} 中未找到目标 ${targetId}`), { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId: this.currentPageId, targetId });
    const scoped = entry.scopedId;
    const cur = scoped in this.checked ? Boolean(this.checked[scoped]) : Boolean(entry.node.checked ?? entry.node.selected);
    const next = val === 'toggle' ? !cur : Boolean(val);
    if (entry.node.type === 'radio' && next) {
      const grp = entry.node.group || entry.node.selectionGroup;
      if (grp) {
        this._walkPageEntries(entry.pageId, (cand, candScoped) => {
          if (cand.type === 'radio' && (cand.group || cand.selectionGroup) === grp && candScoped !== scoped) {
            this.checked[candScoped] = false;
          }
        });
      }
    }
    this.checked[scoped] = next;
    this._refreshDatasetBoundText();
    if (executed) executed.push({ action: 'set-check', target: scoped, checked: next });
    return next;
  }

  setSelected(targetId, val, executed = null) {
    const entry = this.findNodeEntry(this.currentPageId, targetId);
    if (!entry) throw Object.assign(new Error(`页面 ${this.currentPageId} 中未找到目标 ${targetId}`), { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId: this.currentPageId, targetId });
    const scoped = entry.scopedId;
    const cur = scoped in this.selectedNodes ? Boolean(this.selectedNodes[scoped]) : Boolean(entry.node.selected);
    const next = val === 'toggle' ? !cur : Boolean(val);
    if (next && entry.node.selectionGroup) {
      const grp = entry.node.selectionGroup;
      this._walkPageEntries(entry.pageId, (cand, candScoped) => {
        if (cand.selectionGroup === grp && candScoped !== scoped) {
          this.selectedNodes[candScoped] = false;
        }
      });
    }
    this.selectedNodes[scoped] = next;
    if (executed) executed.push({ action: 'set-selected', target: scoped, selected: next });
    return next;
  }

  setOption(targetId, val, executed = null) {
    const entry = this.findNodeEntry(this.currentPageId, targetId);
    if (!entry) throw Object.assign(new Error(`页面 ${this.currentPageId} 中未找到目标 ${targetId}`), { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId: this.currentPageId, targetId });
    const scoped = entry.scopedId;
    const opts = Array.isArray(entry.node.options) ? entry.node.options : [];
    if (entry.node.type === 'listbox' && entry.node.multiple) {
      if (Array.isArray(val)) {
        this.selectedOptions[scoped] = val.map(v => typeof v === 'number' && opts[v] !== undefined ? opts[v] : String(v));
      } else {
        const curList = Array.isArray(this.selectedOptions[scoped]) ? [...this.selectedOptions[scoped]] : [];
        const strVal = typeof val === 'number' && opts[val] !== undefined ? opts[val] : String(val ?? '');
        const pos = curList.indexOf(strVal);
        if (pos >= 0) curList.splice(pos, 1);
        else curList.push(strVal);
        this.selectedOptions[scoped] = curList;
      }
    } else {
      const nextOpt = typeof val === 'number' && opts[val] !== undefined ? opts[val] : String(val ?? '');
      this.selectedOptions[scoped] = nextOpt;
    }
    this._refreshDatasetBoundText();
    if (executed) executed.push({ action: 'set-option', target: scoped, value: this.selectedOptions[scoped] });
    return this.selectedOptions[scoped];
  }

  setInput(targetId, value) {
    const entry = this.findNodeEntry(this.currentPageId, targetId);
    if (!entry) throw Object.assign(new Error(`页面 ${this.currentPageId} 中未找到目标 ${targetId}`), { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId: this.currentPageId, targetId });
    const scoped = entry.scopedId;
    if (entry.node.type === 'combobox' || entry.node.type === 'listbox') {
      const selected = this.setOption(scoped, value);
      this.trace.push({
        step: this.trace.length + 1,
        type: 'select-option',
        pageId: this.currentPageId,
        targetId: scoped,
        value: selected,
      });
      return this.getState();
    }
    this.inputs[scoped] = String(value);
    this.trace.push({
      step: this.trace.length + 1,
      type: 'input',
      pageId: this.currentPageId,
      targetId: scoped,
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
    const entry = this.findNodeEntry(this.currentPageId, targetId);
    const node = entry?.node;
    if (!node) {
      // 跨页目标：明确指出目标所在页与会话起始页（startPageId），避免被误读为节点不存在。
      const otherPageIds = (this.docSnapshot.pages || [])
        .filter(page => page.id !== this.currentPageId)
        .filter(page => { try { return this.findNodeEntry(page.id, targetId)?.node; } catch { return false; } })
        .map(page => page.id);
      if (otherPageIds.length) {
        throw Object.assign(
          new Error(`交互目标 "${targetId}" 不在当前页 "${this.currentPageId}"，它位于页面 ${otherPageIds.map(id => `"${id}"`).join(', ')}；会话从起始页 "${this.currentPageId}" 开始，请先 navigate 到该页，或在 startPageId 中指定它`),
          { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId: this.currentPageId, targetId, availableOnPages: otherPageIds, suggestion: `navigate("${otherPageIds[0]}") 或将 startPageId 设为 "${otherPageIds[0]}" 后重跑` }
        );
      }
      throw Object.assign(
        new Error(`当前页面 "${this.currentPageId}" 中未找到交互目标 "${targetId}"`),
        { code: 'E_RUNTIME_NODE_NOT_FOUND', pageId: this.currentPageId, targetId }
      );
    }

    if (!this.isNodeVisible(targetId)) throw Object.assign(new Error(`交互目标 ${targetId} 当前不可见`), { code: 'E_RUNTIME_NODE_HIDDEN', targetId, suggestion: '目标在当前运行态不可见；若运行态已被弄脏，请重置会话恢复初始状态（重新进入预览或 POST /api/runtime/reset）' });

    const clickSpec = node.on?.click || node.onClick || node.interactions?.click;
    const executed = [];
    const isDisabled = Boolean(node.disabled) || ['disabled', 'loading'].includes(node.state);
    if (!isDisabled) {
      if (node.type === 'checkbox') {
        this.setChecked(entry.scopedId, 'toggle', executed);
      } else if (node.type === 'radio') {
        this.setChecked(entry.scopedId, true, executed);
      }
    }
    if (clickSpec && !isDisabled) {
      const previousScope = this.interactionScope;
      this.interactionScope = entry.scopePrefix;
      try {
        executePrototypeInteraction(this, clickSpec, executed, { declaredVariables: this.docSnapshot.variables });
      }
      finally { this.interactionScope = previousScope; }
    }

    this.trace.push({
      step: this.trace.length + 1,
      type: 'click',
      pageId: this.currentPageId,
      targetId: entry.scopedId,
      executed,
      variables: structuredClone(this.variables),
    });

    return this.getState();
  }

  _executeDatasetAction(act, executed) {
    const dsName = act.dataset || act.repeater || Object.keys(this.datasets)[0];
    if (!dsName || !this.datasets[dsName]) return;
    const op = (act.op || act.type || '').replace(/^(dataset-|repeater-)/, '');
    const selected = this.selectedRows[dsName] || new Set();

    if (op === 'select' || op === 'toggle-select') {
      let rowId = act.rowId;
      if (rowId === 'first' || rowId === 'pageFirst') {
        const firstRow = (rowId === 'pageFirst' ? this.getPagedDatasetRows(dsName) : this.getPagedDatasetRows(dsName))[0] || this.getVisibleDatasetRows(dsName)[0];
        rowId = firstRow?._rowId ?? firstRow?.id ?? null;
      } else if (typeof rowId === 'string' && rowId.startsWith('=')) {
        rowId = this.evaluateExpression(rowId);
      }
      if (act.clearOthers !== false) selected.clear();
      if (op === 'toggle-select' && selected.has(rowId)) selected.delete(rowId);
      else if (rowId !== undefined && rowId !== null && rowId !== '') selected.add(rowId);
      this._refreshDatasetBoundText();
      executed.push({ action: 'dataset-select', dataset: dsName, selectedRowIds: [...selected] });
      return;
    }

    if (op === 'page') {
      const rawTarget = act.page ?? act.value ?? act.query;
      const totalPages = this.getDatasetTotalPages(dsName);
      const curPage = this.getDatasetPage(dsName);
      let nextPage = curPage;
      if (rawTarget === 'next') nextPage = Math.min(totalPages, curPage + 1);
      else if (rawTarget === 'prev' || rawTarget === 'previous') nextPage = Math.max(1, curPage - 1);
      else if (rawTarget === 'first') nextPage = 1;
      else if (rawTarget === 'last') nextPage = totalPages;
      else {
        const evaluated = Number(this.evaluateExpression(rawTarget));
        if (Number.isFinite(evaluated)) nextPage = Math.min(totalPages, Math.max(1, Math.floor(evaluated)));
      }
      this.datasetPages[dsName] = nextPage;
      this._refreshDatasetBoundText();
      executed.push({ action: 'dataset-page', dataset: dsName, page: nextPage, totalPages });
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
            this.visibility[this.targetKey(act.onEmptyShow)] = true;
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
          this.visibility[this.targetKey(act.onEmptySelectionShow)] = true;
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
          this.visibility[this.targetKey(act.onEmptySelectionShow)] = true;
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
      this.datasetPages[dsName] = 1;
      if (act.onEmptyShow) {
        const isEmpty = this.getVisibleDatasetRows(dsName).length === 0;
        this.visibility[this.targetKey(act.onEmptyShow)] = isEmpty;
      }
      this._refreshDatasetBoundText();
      executed.push({ action: 'dataset-filter', dataset: dsName, filter: this.datasetFilters[dsName] });
      return;
    }

    if (op === 'sort') {
      this.datasetSorts[dsName] = act.field ? { field: act.field, order: act.order || 'asc' } : null;
      this.datasetPages[dsName] = 1;
      this._refreshDatasetBoundText();
      executed.push({ action: 'dataset-sort', dataset: dsName, sort: this.datasetSorts[dsName] });
    }
  }

  runScenario(steps = []) {
    const expectKeys = new Set(Object.keys(SCENARIO_STEP_SCHEMA.properties.expect.properties));
    let assertionCount = 0;
    const invalid = (index, message) => ({ ok: false, code: 'E_SCENARIO_STEP', failedStepIndex: index + 1, message,
      example: { action: 'click', target: 'reveal', expect: { visible: { answer: true } } }, totalSteps: Array.isArray(steps) ? steps.length : 0, passedSteps: 0, stepResults: [], finalState: this.getState() });
    if (!Array.isArray(steps) || !steps.length) return invalid(-1, 'steps 必须是非空数组，且至少有一条明确断言');
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== 'object' || Array.isArray(step)) return invalid(i, '步骤必须是对象');
      const allowed = new Set(Object.keys(SCENARIO_STEP_SCHEMA.properties));
      const unknown = Object.keys(step).find(k => !allowed.has(k));
      if (unknown) return invalid(i, `未知步骤字段 ${unknown}；动作使用 action，断言使用 expect`);
      if (step.action !== undefined && !['navigate', 'input', 'click', 'dataset', 'expect', 'assert'].includes(step.action)) return invalid(i, `未知 action: ${step.action}`);
      if ((step.action === 'expect' || step.action === 'assert') && !step.expect) return invalid(i, 'expect/assert 动作需要 expect 断言');
      if (step.action === 'dataset' && !['select', 'toggle-select', 'add', 'update', 'delete', 'filter', 'sort', 'page'].includes(step.op)) return invalid(i, 'dataset 动作需要受支持的 op');
      if (step.action && ['click', 'input'].includes(step.action) && !(step.target || step.id || step.fill || step.click)) return invalid(i, '动作缺少 target');
      if (step.expect !== undefined) {
        if (!step.expect || typeof step.expect !== 'object' || Array.isArray(step.expect) || !Object.keys(step.expect).length) return invalid(i, 'expect 必须含至少一条断言');
        for (const [key, value] of Object.entries(step.expect)) {
          if (!expectKeys.has(key)) return invalid(i, `未知 expect 字段 ${key}`);
          if (key === 'page') { if (typeof value !== 'string' || !value) return invalid(i, 'expect.page 需要页面 ID'); assertionCount++; continue; }
          if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return invalid(i, `expect.${key} 必须是非空对象`);
          if (key === 'visible' && Object.values(value).some(v => typeof v !== 'boolean')) return invalid(i, 'visible 的期望值必须为 true/false');
          if (key === 'checked' && Object.values(value).some(v => typeof v !== 'boolean')) return invalid(i, 'checked 的期望值必须为 true/false');
          assertionCount += Object.keys(value).length;
        }
      }
      if (!step.action && !step.goto && !step.fill && !step.click && !step.expect) return invalid(i, '步骤缺少动作或断言');
    }
    if (!assertionCount) return invalid(-1, '场景没有任何断言，不能认证为通过');
    const visitedPages = new Set([this.currentPageId]);
    const triggeredInteractiveNodes = new Set();
    const visitedPanelStates = new Set(Object.entries(this.panelStates).map(([panel, st]) => `${panel}:${st}`));
    const exercisedVariables = new Set();
    const matchedBranchKeys = new Set();
    const runtimeWarnings = [];

    const stepResults = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const traceStart = this.trace.length;
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

      visitedPages.add(this.currentPageId);
      for (const [panel, st] of Object.entries(this.panelStates)) {
        visitedPanelStates.add(`${panel}:${st}`);
      }

      const stepTraceEvents = this.trace.slice(traceStart);
      for (const ev of stepTraceEvents) {
        if (ev.targetId && (ev.type === 'click' || ev.type === 'input' || ev.type === 'select-option')) {
          triggeredInteractiveNodes.add(ev.targetId);
        }
        for (const act of ev.executed || []) {
          if (act.action === 'set-var' && act.name) exercisedVariables.add(act.name);
          if (act.action === 'condition' && act.matched && ev.targetId && Number.isInteger(act.caseIndex)) {
            matchedBranchKeys.add(`${ev.targetId}#case:${act.caseIndex}`);
          }
        }
      }
      const stepExecuted = stepTraceEvents.flatMap(event => event.executed || []);
      const stepWarnings = [];
      for (const act of stepExecuted) {
        if ((act.action === 'show' || act.action === 'toggle') && act.target && this.visibility[act.target] === true) {
          if (!this.isNodeVisible(act.target, this.currentPageId)) {
            const hiddenAnc = this._findHiddenAncestor(act.target, this.currentPageId);
            const warn = {
              code: 'W_SHOW_MASKED_BY_HIDDEN_ANCESTOR',
              severity: 'warning',
              stepIndex: i + 1,
              pageId: this.currentPageId,
              targetScopedId: act.target,
              targetNodeId: String(act.target).split('/').at(-1),
              maskedByAncestorId: hiddenAnc?.id || null,
              maskedByAncestorScopedId: hiddenAnc?.scopedId || null,
              message: hiddenAnc
                ? `第 ${i + 1} 步将 "${act.target}" 设为可见，但其祖先容器 "${hiddenAnc.id}" 当前为 visible:false，目标在画面中仍被遮蔽不可见`
                : `第 ${i + 1} 步将 "${act.target}" 设为可见，但受祖先容器或非激活面板状态限制，目标在画面中仍不可见`,
              suggestion: hiddenAnc
                ? `请改为 show 祖先容器 "${hiddenAnc.id}"（或同时 show "${hiddenAnc.id}"）`
                : '请检查祖先容器 visible 状态或所属 dynamic-panel 当前激活的 state',
            };
            stepWarnings.push(warn);
            runtimeWarnings.push(warn);
          }
        }
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
            const actual = this.panelStates[this.targetKey(panelId)];
            assertions.push({ type: 'panelState', target: panelId, expected: expectedState, actual, passed: actual === expectedState });
          }
        }
        if (exp.variables) {
          for (const [varName, expectedVal] of Object.entries(exp.variables)) {
            exercisedVariables.add(varName);
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
        if (exp.checked) {
          for (const [nodeId, expectedChk] of Object.entries(exp.checked)) {
            const actual = Boolean(this.getWidgetState(nodeId, 'checked'));
            assertions.push({ type: 'checked', target: nodeId, expected: Boolean(expectedChk), actual, passed: actual === Boolean(expectedChk) });
          }
        }
        if (exp.selected) {
          for (const [nodeId, expectedSel] of Object.entries(exp.selected)) {
            const actual = this.getWidgetState(nodeId, 'selected');
            const passed = typeof expectedSel === 'boolean'
              ? Boolean(actual) === expectedSel
              : Array.isArray(expectedSel)
                ? JSON.stringify(actual) === JSON.stringify(expectedSel)
                : String(actual) === String(expectedSel);
            assertions.push({ type: 'selected', target: nodeId, expected: expectedSel, actual, passed });
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
        executed: stepExecuted,
        ...(stepWarnings.length ? { warnings: stepWarnings } : {}),
        passed: assertions.every(a => a.passed),
      });
    }

    const allPageIds = (this.docSnapshot.pages || []).map(p => p.id);
    const allInteractiveNodes = [];
    const allPanelStates = [];
    const allCaseBranches = [];
    for (const pg of this.docSnapshot.pages || []) {
      const walkCov = (node, prefix) => {
        if (!node || typeof node !== 'object') return;
        const scopedId = `${prefix}/${node.id}`;
        const clickSpec = node.on?.click || node.onClick || node.interactions?.click;
        const isInteractiveWidget =
          ['button', 'input', 'checkbox', 'radio', 'combobox', 'listbox'].includes(node.type)
          && !node.disabled
          && node.state !== 'disabled';
        if ((Boolean(clickSpec) || isInteractiveWidget) && !prefix.includes('/template')) {
          allInteractiveNodes.push(scopedId);
        }
        if (clickSpec && typeof clickSpec === 'object' && Array.isArray(clickSpec.cases)) {
          clickSpec.cases.forEach((branch, idx) => {
            if (!branch || typeof branch !== 'object') return;
            allCaseBranches.push({
              branchKey: `${scopedId}#case:${idx}`,
              pageId: pg.id,
              nodeId: node.id,
              scopedId,
              caseIndex: idx,
              condition: String(branch.when ?? branch.if ?? branch.condition ?? 'else'),
            });
          });
        }
        if (node.type === 'dynamic-panel' && Array.isArray(node.states)) {
          for (const st of node.states) {
            if (!st?.id) continue;
            allPanelStates.push(`${scopedId}:${st.id}`);
            if (st.root) walkCov(st.root, `${scopedId}/${st.id}`);
          }
        }
        for (const ch of node.children || []) walkCov(ch, prefix);
      };
      if (pg.root) walkCov(pg.root, pg.id);
    }

    const staticLintWarnings = lintDocumentInteractions(this.docSnapshot, { includeCompleteness: true });
    const seenWarnKeys = new Set();
    const warnings = [];
    for (const w of [...runtimeWarnings, ...staticLintWarnings]) {
      const key = `${w.code}:${w.scopedId || ''}:${w.targetScopedId || ''}:${w.branchIndex ?? ''}`;
      if (!seenWarnKeys.has(key)) {
        seenWarnKeys.add(key);
        warnings.push(w);
      }
    }

    const totalItems = allPageIds.length + allInteractiveNodes.length + allPanelStates.length + allCaseBranches.length;
    const hitItems =
      visitedPages.size
      + allInteractiveNodes.filter(id => triggeredInteractiveNodes.has(id)).length
      + allPanelStates.filter(id => visitedPanelStates.has(id)).length
      + allCaseBranches.filter(b => matchedBranchKeys.has(b.branchKey)).length;
    const coverage = {
      visitedPages: [...visitedPages],
      unvisitedPages: allPageIds.filter(id => !visitedPages.has(id)),
      triggeredInteractiveNodes: [...triggeredInteractiveNodes],
      untriggeredInteractiveNodes: allInteractiveNodes.filter(id => !triggeredInteractiveNodes.has(id)),
      visitedPanelStates: [...visitedPanelStates],
      unvisitedPanelStates: allPanelStates.filter(id => !visitedPanelStates.has(id)),
      exercisedVariables: [...exercisedVariables],
      matchedCaseBranches: allCaseBranches.filter(b => matchedBranchKeys.has(b.branchKey)),
      unmatchedCaseBranches: allCaseBranches.filter(b => !matchedBranchKeys.has(b.branchKey)),
      totalCaseBranches: allCaseBranches.length,
      coverageScore: totalItems > 0 ? Number((hitItems / totalItems).toFixed(3)) : 1,
    };

    return {
      ok: stepResults.every(s => s.passed),
      assertionCount: stepResults.reduce((sum, step) => sum + step.assertions.length, 0),
      totalSteps: stepResults.length,
      passedSteps: stepResults.filter(s => s.passed).length,
      stepResults,
      coverage,
      warnings,
      finalState: this.getState(),
    };
  }

  getState() {
    const visibleDatasets = {};
    const datasetPages = {};
    for (const dsName of Object.keys(this.datasets)) {
      const page = this.getDatasetPage(dsName);
      datasetPages[dsName] = page;
      visibleDatasets[dsName] = {
        totalRows: this.datasets[dsName].length,
        visibleRows: this.getVisibleDatasetRows(dsName),
        pagedRows: this.getPagedDatasetRows(dsName),
        page,
        pageSize: this.getDatasetPageSize(dsName),
        totalPages: this.getDatasetTotalPages(dsName),
        selectedRowIds: [...(this.selectedRows[dsName] || [])],
        filter: this.datasetFilters[dsName],
        sort: this.datasetSorts[dsName],
      };
    }

    const scene = resolveDocumentScene(this.docSnapshot, {
      projectDir: this.projectDir,
      activePanelStates: this.panelStates,
      runtimeState: {
        variables: this.variables,
        panelStates: this.panelStates,
        visibility: this.visibility,
        inputs: this.inputs,
        checked: this.checked,
        selectedOptions: this.selectedOptions,
        selectedNodes: this.selectedNodes,
        textOverrides: this.textOverrides,
        evaluateText: (expression, context) => this.evaluateExpression(expression, context),
        datasets: Object.fromEntries(Object.entries(visibleDatasets).map(([name, value]) => [name, { rows: value.visibleRows }])),
        datasetPages,
      },
    });
    const activePageScene = scene.pages.find(p => p.id === this.currentPageId) || scene.pages[0];

    // Values are resolved before measurement; retain the row-view rendering flag.
    const runtimeNodes = (activePageScene?.nodes || []).map(n => {
      return {
        ...n,
        ...(n.type==='repeater'?{rowViewResolved:true}:{}),
      };
    });

    return {
      sessionId: this.sessionId,
      currentPageId: this.currentPageId,
      variables: structuredClone(this.variables),
      inputs: structuredClone(this.inputs),
      checked: structuredClone(this.checked),
      selectedOptions: structuredClone(this.selectedOptions),
      selectedNodes: structuredClone(this.selectedNodes),
      panelStates: structuredClone(this.panelStates),
      visibility: structuredClone(this.visibility),
      datasets: visibleDatasets,
      activePageScene: activePageScene ? { ...activePageScene, nodes: runtimeNodes } : null,
      traceCount: this.trace.length,
      trace: this.trace,
    };
  }
}
