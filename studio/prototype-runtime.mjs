// These functions have no module dependencies. The code exporter embeds them
// in its standalone script so it also works when index.html is opened directly.
export function readComputedWidgetStyle(el, { shape = el, textNode = el, svg = null } = {}) {
  if (!el) return {};
  const win = el.ownerDocument.defaultView;
  const surface = win.getComputedStyle(shape);
  const ink = win.getComputedStyle(textNode);
  const background = surface.backgroundColor;
  const fill = (background === 'transparent' || background === 'rgba(0, 0, 0, 0)') && svg
    ? win.getComputedStyle(svg).fill : background;
  return {
    fill, color: ink.color, opacity: Number(win.getComputedStyle(el).opacity),
    fontFamily: ink.fontFamily, fontSize: parseFloat(ink.fontSize), fontWeight: Number(ink.fontWeight),
    radius: parseFloat(surface.borderTopLeftRadius),
  };
}

export function evaluatePrototypeExpression(expression, { variables, getWidgetText, getWidgetState, resolveDatasetPath, itemRow = null, getWidgetRect = null }) {
  if (expression == null) return '';
  if (typeof expression === 'number' || typeof expression === 'boolean') return expression;
  const args = { variables, getWidgetText, getWidgetState, resolveDatasetPath, itemRow, getWidgetRect };
  if (typeof expression === 'object') {
    const literal = value => {
      if (typeof value === 'string') return '"' + value.replace(/["\\]/g, ch => '\\' + ch) + '"';
      return JSON.stringify(value ?? '');
    };
    const encode = value => {
      if (typeof value !== 'object' || value === null) {
        return typeof value === 'string' && value.startsWith('=') ? '(' + value.slice(1) + ')' : literal(value);
      }
      if (Object.hasOwn(value, 'literal')) return literal(value.literal);
      if (typeof (value.variable ?? value.var) === 'string') return literal(variables?.[value.variable ?? value.var]);
      if (typeof value.expr === 'string') return '(' + value.expr.replace(/^=/, '') + ')';
      if (Object.hasOwn(value, 'item')) return literal(itemRow?.[value.item]);
      if (value.op && value.left !== undefined && value.right !== undefined) {
        const op = value.op === '==' ? '===' : value.op === '!=' ? '!==' : value.op;
        return '(' + encode(value.left) + ' ' + op + ' ' + encode(value.right) + ')';
      }
      if (value.fn && Array.isArray(value.args)) return value.fn + '(' + value.args.map(encode).join(',') + ')';
      if (value.widget) {
        const reference = value.widget?.ref ?? value.widget;
        const accessor = value.prop || value.accessor;
        if (typeof reference !== 'string') return '""';
        if (['checked', 'selected', 'disabled', 'state'].includes(accessor)) return literal(getWidgetState?.(reference, accessor));
        if (['x', 'y', 'left', 'right', 'top', 'bottom', 'width', 'height'].includes(accessor)) return literal(getWidgetRect?.(reference)?.[accessor]);
        return literal(getWidgetText?.(reference));
      }
      return '""';
    };
    return evaluatePrototypeExpression('=' + encode(expression), args);
  }
  const rawStr = String(expression);
  if (rawStr.startsWith('\\=')) return '=' + rawStr.slice(2);
  const source = rawStr.trim();
  const isInlineFormula = source.startsWith('=') && !source.startsWith('==')
    && /^[A-Za-z0-9_$@!('"+-]/.test(source.slice(1).trim());
  if (!isInlineFormula) {
    let out = itemRow ? source.replace(/\$\{\s*item\.([a-zA-Z0-9_]+)\s*\}|\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, itemField, templateField) => String(itemRow[itemField || templateField] ?? '')) : source;
    if (out.includes('${')) {
      out = out.replace(/\$\{([^}]+)\}/g, (_, inner) => String(evaluatePrototypeExpression('=' + inner, {
        variables, getWidgetText, getWidgetState, resolveDatasetPath, itemRow, getWidgetRect,
      }) ?? ''));
    }
    return out;
  }

  const body = source.slice(1).trim();
  const vars = variables || {};
  const textVariable = ([, add, name]) => add === undefined
    ? String(vars[name] ?? '')
    : String(Number(add) + Number(vars[name] || 0));
  const explicitTextVariable = body.match(/^text\(\s*(?:(\d+)\s*\+\s*)?(?:var\.|\$)([a-zA-Z0-9_]+)\s*\)$/);
  if (explicitTextVariable) return textVariable(explicitTextVariable);

  const functions = {
    text: value => String(value ?? ''),
    number: value => Number(value) || 0,
    fixed: (value, digits = 0) => (Number(value) || 0).toFixed(Math.max(0, Math.min(12, Math.trunc(Number(digits) || 0)))),
    nowMs: () => (typeof window !== 'undefined' && window.__zeeClock?.timestamp ? window.__zeeClock.timestamp : Date.now()),
    concat: (...values) => values.map(value => String(value ?? '')).join(''),
    contains: (value, part) => String(value ?? '').includes(String(part ?? '')),
    length: value => String(value ?? '').length,
    lower: value => String(value ?? '').toLowerCase(),
    upper: value => String(value ?? '').toUpperCase(),
    trim: value => String(value ?? '').trim(),
    not: value => !value,
    remove: (value, part) => String(value ?? '').replace(String(part ?? ''), ''),
    replace: (value, from, to) => String(value ?? '').split(String(from ?? '')).join(String(to ?? '')),
    slice: (value, start, end) => end === undefined ? String(value ?? '').slice(Number(start) || 0) : String(value ?? '').slice(Number(start) || 0, Number(end) || 0),
    substr: (value, start, len) => len === undefined ? String(value ?? '').substr(Number(start) || 0) : String(value ?? '').substr(Number(start) || 0, Number(len) || 0),
    left: (value, count) => String(value ?? '').slice(0, Math.max(0, Math.trunc(Number(count) || 0))),
    right: (value, count) => { const n = Math.trunc(Number(count) || 0); return n <= 0 ? '' : String(value ?? '').slice(-n); },
    min: (...values) => Math.min(...values.map(v => Number(v) || 0)),
    max: (...values) => Math.max(...values.map(v => Number(v) || 0)),
    abs: value => Math.abs(Number(value) || 0),
    round: value => Math.round(Number(value) || 0),
    floor: value => Math.floor(Number(value) || 0),
    ceil: value => Math.ceil(Number(value) || 0),
    isOver: (a, b) => {
      const ra = typeof a === 'string' && getWidgetRect ? getWidgetRect(a) : a;
      const rb = typeof b === 'string' && getWidgetRect ? getWidgetRect(b) : b;
      return Boolean(ra && rb && ra.right > rb.left && ra.left < rb.right && ra.bottom > rb.top && ra.top < rb.bottom);
    },
    isNotOver: (a, b) => !functions.isOver(a, b),
  };

  function matchVarName(rest) {
    const m = rest.match(/^([a-zA-Z0-9_]+(?:-[a-zA-Z0-9_]+)*)/);
    if (!m) return null;
    const raw = m[1];
    if (!raw.includes('-')) return raw;
    const parts = raw.split('-');
    for (let k = parts.length; k >= 2; k--) {
      const candidate = parts.slice(0, k).join('-');
      if (Object.hasOwn(vars, candidate)) return candidate;
    }
    return parts[0];
  }

  function tokenize(input) {
    const list = [];
    let i = 0;
    let parenDepth = 0;
    const spatialParenDepths = [];
    const readWidgetProp = (target, wProp) => {
      if (wProp === 'checked' || wProp === 'selected' || wProp === 'disabled' || wProp === 'state') {
        return getWidgetState ? getWidgetState(target, wProp) : (wProp === 'state' ? '' : false);
      }
      if (['x', 'y', 'left', 'right', 'top', 'bottom', 'width', 'height'].includes(wProp)) {
        return getWidgetRect ? (getWidgetRect(target)?.[wProp] ?? 0) : 0;
      }
      return getWidgetText ? getWidgetText(target) : '';
    };
    while (i < input.length) {
      const ch = input[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        let out = '';
        while (j < input.length && input[j] !== quote) {
          if (input[j] === '\\' && j + 1 < input.length) {
            const esc = input[j + 1];
            if (esc === 'n') out += '\n';
            else if (esc === 'r') out += '\r';
            else if (esc === 't') out += '\t';
            else out += esc;
            j += 2;
          } else {
            out += input[j++];
          }
        }
        if (j >= input.length) throw new Error('Unterminated string');
        list.push({ type: 'val', value: out });
        i = j + 1;
        continue;
      }
      const rest = input.slice(i);
      const numMatch = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (numMatch && !/^[a-zA-Z_]/.test(rest.slice(numMatch[0].length))) {
        list.push({ type: 'val', value: Number(numMatch[0]) });
        i += numMatch[0].length;
        continue;
      }
      const dsMatch = rest.match(/^dataset\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_.]+)/);
      if (dsMatch) {
        list.push({ type: 'val', value: resolveDatasetPath ? resolveDatasetPath(dsMatch[1], dsMatch[2]) : '' });
        i += dsMatch[0].length;
        continue;
      }
      const wMatch = rest.match(/^widget\.([a-zA-Z0-9_/-]+)\.(text|checked|selected|value|disabled|state|x|y|left|right|top|bottom|width|height)(?![a-zA-Z0-9_])/);
      if (wMatch) {
        list.push({ type: 'val', value: readWidgetProp(wMatch[1], wMatch[2]) });
        i += wMatch[0].length;
        continue;
      }
      const itemMatch = rest.match(/^item\.([a-zA-Z0-9_]+)(?![a-zA-Z0-9_])/);
      if (itemMatch) {
        list.push({ type: 'val', value: itemRow?.[itemMatch[1]] ?? '' });
        i += itemMatch[0].length;
        continue;
      }
      if (rest.startsWith('var.')) {
        const vName = matchVarName(rest.slice(4));
        if (vName) {
          list.push({ type: 'val', value: vars[vName] ?? '' });
          i += 4 + vName.length;
          continue;
        }
      }
      if (ch === '$') {
        const vName = matchVarName(rest.slice(1));
        if (vName) {
          list.push({ type: 'val', value: vars[vName] ?? '' });
          i += 1 + vName.length;
          continue;
        }
      }
      if (ch === '@') {
        const atPropMatch = rest.match(/^@([a-zA-Z0-9_/-]+)\.(text|checked|selected|value|disabled|state|x|y|left|right|top|bottom|width|height)(?![a-zA-Z0-9_])/);
        if (atPropMatch) {
          list.push({ type: 'val', value: readWidgetProp(atPropMatch[1], atPropMatch[2]) });
          i += atPropMatch[0].length;
          continue;
        }
        const atMatch = rest.match(/^@([a-zA-Z0-9_/-]+)/);
        if (atMatch) {
          const val = spatialParenDepths.length > 0 && getWidgetRect
            ? getWidgetRect(atMatch[1])
            : (getWidgetText ? getWidgetText(atMatch[1]) : '');
          list.push({ type: 'val', value: val });
          i += atMatch[0].length;
          continue;
        }
      }
      const opMatch = rest.match(/^(?:===|!==|==|!=|<=|>=|&&|\|\||\?\?|[+\-*/%<>!?:(),])/);
      if (opMatch) {
        const opVal = opMatch[0];
        if (opVal === '(') {
          parenDepth++;
          const prev = list.at(-1);
          if (prev?.type === 'id' && (prev.value === 'isOver' || prev.value === 'isNotOver')) {
            spatialParenDepths.push(parenDepth);
          }
        } else if (opVal === ')') {
          if (spatialParenDepths.at(-1) === parenDepth) spatialParenDepths.pop();
          parenDepth = Math.max(0, parenDepth - 1);
        }
        list.push({ type: 'op', value: opVal });
        i += opVal.length;
        continue;
      }
      const idName = matchVarName(rest);
      if (idName && /^[a-zA-Z_]/.test(idName)) {
        list.push({ type: 'id', value: idName });
        i += idName.length;
        continue;
      }
      throw new Error('Unexpected character: ' + ch);
    }
    return list;
  }

  try {
    const toks = tokenize(body);
    if (!toks.length) return '';
    let pos = 0;
    const peek = () => toks[pos] || null;
    const consume = expectedOp => {
      const t = toks[pos];
      if (!t || t.type !== 'op' || t.value !== expectedOp) {
        throw new Error('Expected ' + expectedOp);
      }
      pos++;
      return t;
    };

    function parseExpr() {
      return parseTernary();
    }

    function parseTernary() {
      const cond = parseNullish();
      if (peek()?.type === 'op' && peek().value === '?') {
        pos++;
        const truthy = parseTernary();
        consume(':');
        const falsy = parseTernary();
        return cond ? truthy : falsy;
      }
      return cond;
    }

    function parseNullish() {
      let left = parseOr();
      while (peek()?.type === 'op' && peek().value === '??') {
        pos++;
        const right = parseOr();
        left = left ?? right;
      }
      return left;
    }

    function parseOr() {
      let left = parseAnd();
      while (peek()?.type === 'op' && peek().value === '||') {
        pos++;
        const right = parseAnd();
        left = left || right;
      }
      return left;
    }

    function parseAnd() {
      let left = parseEquality();
      while (peek()?.type === 'op' && peek().value === '&&') {
        pos++;
        const right = parseEquality();
        left = left && right;
      }
      return left;
    }

    function parseEquality() {
      let left = parseRelational();
      while (peek()?.type === 'op' && ['===', '!==', '==', '!='].includes(peek().value)) {
        const op = toks[pos++].value;
        const right = parseRelational();
        if (op === '===') left = left === right;
        else if (op === '!==') left = left !== right;
        // eslint-disable-next-line eqeqeq
        else if (op === '==') left = left == right;
        // eslint-disable-next-line eqeqeq
        else left = left != right;
      }
      return left;
    }

    function parseRelational() {
      let left = parseAdditive();
      while (peek()?.type === 'op' && ['<', '<=', '>', '>='].includes(peek().value)) {
        const op = toks[pos++].value;
        const right = parseAdditive();
        if (op === '<') left = left < right;
        else if (op === '<=') left = left <= right;
        else if (op === '>') left = left > right;
        else left = left >= right;
      }
      return left;
    }

    function parseAdditive() {
      let left = parseMultiplicative();
      while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
        const op = toks[pos++].value;
        const right = parseMultiplicative();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    }

    function parseMultiplicative() {
      let left = parseUnary();
      while (peek()?.type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
        const op = toks[pos++].value;
        const right = parseUnary();
        if (op === '*') left = left * right;
        else if (op === '/') left = left / right;
        else left = left % right;
      }
      return left;
    }

    function parseUnary() {
      const t = peek();
      if (t?.type === 'op' && (t.value === '!' || t.value === '-' || t.value === '+')) {
        pos++;
        const arg = parseUnary();
        if (t.value === '!') return !arg;
        if (t.value === '-') return -arg;
        return +arg;
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const t = peek();
      if (!t) throw new Error('Unexpected end of expression');
      if (t.type === 'val') {
        pos++;
        return t.value;
      }
      if (t.type === 'op' && t.value === '(') {
        pos++;
        const inner = parseExpr();
        consume(')');
        return inner;
      }
      if (t.type === 'id') {
        pos++;
        const name = t.value;
        if (peek()?.type === 'op' && peek().value === '(') {
          pos++;
          const args = [];
          if (!(peek()?.type === 'op' && peek().value === ')')) {
            args.push(parseExpr());
            while (peek()?.type === 'op' && peek().value === ',') {
              pos++;
              args.push(parseExpr());
            }
          }
          consume(')');
          if (!Object.hasOwn(functions, name)) throw new Error('Unknown function: ' + name);
          return functions[name](...args);
        }
        if (name === 'true') return true;
        if (name === 'false') return false;
        if (name === 'null') return null;
        if (name === 'undefined') return undefined;
        if (Object.hasOwn(vars, name)) return vars[name];
        throw new Error('Unknown identifier: ' + name);
      }
      throw new Error('Unexpected token: ' + t.value);
    }

    const result = parseExpr();
    if (pos < toks.length) throw new Error('Trailing tokens');
    return result;
  } catch {
    const bareTextVariable = body.match(/^text\(\s*(?:(\d+)\s*\+\s*)?([a-zA-Z0-9_]+)\s*\)$/);
    return bareTextVariable ? textVariable(bareTextVariable) : source;
  }
}


// Recalculate declarations in both Studio runtime implementations.
export function refreshRp1Bindings(runtime, document) {
  const computed = document.computed || {};
  for (const [name, config] of Object.entries(computed)) {
    const definition = config?.compute ?? config;
    if (!['count', 'sum'].includes(definition?.op)) {
      runtime.variables[name] = runtime.evaluateExpression(definition);
      continue;
    }
    const target = definition.dataset ?? definition.target ?? definition.repeater;
    const node = runtime.findNodeInPage(runtime.currentPageId, target);
    const dataset = Object.hasOwn(runtime.datasets, target) ? target : node?.dataset || node?.source || node?.id;
    const rows = definition.scope === 'dataset' ? runtime.datasets[dataset] || [] : runtime.getPagedDatasetRows(dataset);
    const field = definition.field ?? definition.expr;
    const value = typeof field === 'string' && !field.startsWith('=') ? { item: field } : field;
    runtime.variables[name] = rows.reduce((sum, row) => {
      if (definition.where != null && !runtime.evaluateExpression(definition.where, row)) return sum;
      return sum + (definition.op === 'count' ? 1 : Number(runtime.evaluateExpression(value, row)));
    }, 0);
  }

  const pageId = runtime.currentPageId;
  const current = document.pages?.find(page => page.id === pageId);
  const bindings = [...Object.values(document.views || {}), ...Object.values(current?.views || {}), ...(current?.bindings || [])];
  for (const view of bindings) {
    if (view.page && view.page !== pageId) continue;
    const dataset = view.source || view.dataset;
    const selector = (view.selector || view.variable || ('selected_' + dataset)).replace(/^\$/, '');
    const chosen = (runtime.datasets[dataset] || []).find(row => row[view.key || 'id'] === runtime.variables[selector]);
    if (!chosen) continue;
    for (const [target, field] of Object.entries(view.fields || view.targets || {})) {
      if (runtime.findNodeInPage(pageId, target)) {
        runtime.textOverrides[runtime.targetKey(target)] = String(chosen[field] ?? '');
      }
    }
  }
}

export function executeRp1DataAction(runtime, action, executed, rowContext) {
  const repeater = runtime.findNodeInPage(runtime.currentPageId, action.target);
  const dataset = typeof repeater?.dataset === 'string' ? repeater.dataset : repeater?.source || repeater?.id;
  if (repeater?.type !== 'repeater' || !Object.hasOwn(runtime.datasets, dataset)) {
    throw Object.assign(new Error('未找到中继器数据源: ' + action.target), { code: 'E_RUNTIME_NODE_NOT_FOUND', target: action.target });
  }
  const rows = runtime.datasets[dataset];
  const matches = row => Boolean(runtime.evaluateExpression(action.where, row));
  switch (action.type) {
    case 'data-add':
      for (const record of action.rows) {
        const row = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, runtime.evaluateExpression(value, rowContext)]));
        rows.push({ ...row, _rowId: row[repeater.key || 'id'] ?? ('row_' + (rows.length + 1)) });
      }
      break;
    case 'data-update':
      for (const row of rows.filter(matches)) {
        for (const [key, value] of Object.entries(action.set)) row[key] = runtime.evaluateExpression(value, row);
      }
      break;
    case 'data-delete': {
      const remaining = rows.filter(row => {
        if (!matches(row)) return true;
        runtime.selectedRows[dataset]?.delete(row._rowId);
        runtime.selectedRows[dataset]?.delete(row.id);
        return false;
      });
      runtime.datasets[dataset] = remaining;
      break;
    }
    case 'data-filter':
      runtime.datasetFilters[dataset] = { where: action.where, name: action.name };
      runtime.datasetPages[dataset] = 1;
      break;
    case 'data-clear-filter':
      if (!action.name || runtime.datasetFilters[dataset]?.name === action.name) {
        runtime.datasetFilters[dataset] = null;
        runtime.datasetPages[dataset] = 1;
      }
      break;
    case 'data-sort':
      runtime.datasetSorts[dataset] = { field: action.column, order: action.direction === 'descending' ? 'desc' : 'asc' };
      break;
    case 'data-clear-sort':
      runtime.datasetSorts[dataset] = null;
      break;
    case 'data-page':
      runtime._executeDatasetAction({ op: 'page', dataset, page: action.page }, [], rowContext);
      break;
  }
  runtime._refreshDatasetBoundText();
  executed.push({ action: action.type, target: action.target, dataset });
}

export function executePrototypeInteraction(runtime, spec, executed, { declaredVariables, rowContext } = {}) {
  const evaluate = expr => runtime.evaluateExpression(expr, rowContext);
  const navigate = page => {
    runtime.navigate(page);
    executed.push({ action: 'link', to: page });
  };
  const setVariable = (name, expr) => {
    const value = evaluate(expr);
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw Object.assign(new Error('变量 ' + name + ' 不能赋值为 NaN 或 Infinity'), {
        code: 'E_TYPE', field: name, expected: 'finite number', actual: String(value),
      });
    }
    const declared = declaredVariables?.[name];
    const initial = declared && typeof declared === 'object' && 'value' in declared ? declared.value : declared;
    if (declared !== undefined && initial !== null && initial !== undefined && typeof value !== typeof initial) {
      throw Object.assign(new Error('变量 ' + name + ' 需要 ' + typeof initial + '，表达式返回 ' + typeof value), {
        code: 'E_TYPE', field: name, expected: typeof initial, actual: typeof value,
      });
    }
    runtime.variables[name] = value;
    runtime._refreshRp1Bindings?.();
    executed.push({ action: 'set-var', name, value });
  };
  const setVisibility = (kind, targetId) => {
    const target = runtime.targetKey(targetId);
    let visible = kind === 'show';
    if (kind === 'toggle') {
      const node = runtime.findNodeInPage(runtime.currentPageId, target);
      const ownVisible = node?.ownVisible ?? (node?.visible !== false && node?.hidden !== true);
      visible = !(runtime.visibility[target] ?? ownVisible);
    }
    runtime.visibility[target] = visible;
    executed.push({ action: kind, target });
  };
  const setText = (targetId, expr) => {
    const target = runtime.targetKey(targetId);
    if (typeof expr === 'string' && expr.includes('dataset.')) {
      runtime.textFormulas[target] = { pageId: runtime.currentPageId, scopePrefix: runtime.interactionScope, expr };
    }
    const text = String(evaluate(expr));
    runtime.textOverrides[target] = text;
    executed.push({ action: 'set-text', target, text });
  };

  function applyAction(action) {
    if (!action || typeof action !== 'object') return;
    if (Array.isArray(action)) {
      for (const item of action) visit(item);
      return;
    }
    if (action.setVar && typeof action.setVar === 'object') {
      for (const [name, expr] of Object.entries(action.setVar)) setVariable(name, expr);
    }
    const type = action.type;
    if (['set-var', 'set-variable'].includes(type) || ['set-var', 'set-variable'].includes(action.action)) {
      setVariable(action.name || action.variable, action.value ?? action.expr);
    }
    for (const kind of ['show', 'hide']) {
      const value = action[kind];
      if (!value) continue;
      for (const target of Array.isArray(value) ? value : [value]) setVisibility(kind, target);
    }
    if (['show', 'hide', 'toggle'].includes(type)) setVisibility(type, action.target);
    if (action.setText && typeof action.setText === 'object') {
      for (const [target, expr] of Object.entries(action.setText)) setText(target, expr);
    }
    if (type === 'set-text') setText(action.target, action.text ?? action.value);
    if (type === 'set-check' && typeof runtime.setChecked === 'function') {
      const rawChk = action.checked !== undefined ? action.checked : action.value;
      const val = rawChk === 'toggle' ? 'toggle' : Boolean(evaluate(rawChk));
      runtime.setChecked(action.target, val, executed);
    }
    if (type === 'set-selected' && typeof runtime.setSelected === 'function') {
      const rawSel = action.selected !== undefined ? action.selected : action.value;
      const val = rawSel === 'toggle' ? 'toggle' : Boolean(evaluate(rawSel));
      runtime.setSelected(action.target, val, executed);
    }
    if (type === 'set-option' && typeof runtime.setOption === 'function') {
      const val = evaluate(action.value ?? action.option ?? action.selected);
      runtime.setOption(action.target, val, executed);
    }

    const panels = action.setPanelState || (type === 'set-panel-state' ? action : null);
    if (panels) for (const item of Array.isArray(panels) ? panels : [panels]) {
      const panel = runtime.targetKey(item.target || item.panel);
      const node = runtime.findNodeInPage(runtime.currentPageId, panel);
      const states = node?.states || [];
      const current = runtime.panelStates[panel] || node?.activeState || node?.activeStateId || states[0]?.id;
      const rawState = item.state ?? item.mode;
      const repeatInterval = Number(item.repeatInterval);
      const hasRepeat = (item.repeat ?? (repeatInterval > 0)) && repeatInterval > 0 && rawState !== 'current';
      const skipFirst = hasRepeat && (item.repeatSkipFirst ?? true);
      let state = current;
      if (rawState === 'current') {
        state = current;
        if (runtime.panelTimers) delete runtime.panelTimers[panel];
      } else if (!skipFirst) {
        if (states.length && ['next', 'toggle', 'flip', 'prev', 'previous'].includes(rawState)) {
          const index = states.findIndex(candidate => candidate.id === current);
          const delta = (rawState === 'prev' || rawState === 'previous') ? -1 : 1;
          const nextIdx = item.loop === false
            ? Math.max(0, Math.min(states.length - 1, index + delta))
            : (index + delta + states.length) % states.length;
          state = states[nextIdx].id;
        } else {
          state = rawState;
        }
      }
      runtime.panelStates[panel] = state;
      if (hasRepeat && runtime.panelTimers) {
        runtime.panelTimers[panel] = {
          panelId: panel,
          intervalMs: repeatInterval,
          direction: (rawState === 'prev' || rawState === 'previous') ? 'previous' : 'next',
          loop: Boolean(item.loop ?? true),
          skipFirst,
          elapsedMs: 0,
          active: true,
        };
      } else if (item.repeat === false && runtime.panelTimers) {
        delete runtime.panelTimers[panel];
      }
      executed.push({ action: 'set-panel-state', panel, state });
      const stateChangeSpec = node?.on?.panelStateChange || node?.on?.stateChange || node?.interactions?.panelStateChange;
      if (stateChangeSpec && state !== current && !runtime._inPanelStateChange) {
        runtime._inPanelStateChange = true;
        try {
          executePrototypeInteraction(runtime, stateChangeSpec, executed, { declaredVariables, rowContext });
        } finally {
          runtime._inPanelStateChange = false;
        }
      }
    }

    if (type === 'move' && typeof runtime.moveWidget === 'function') {
      runtime.moveWidget(action.target, action, executed, { evaluate, rowContext });
    }
    if (type?.startsWith('data-')) executeRp1DataAction(runtime, action, executed, rowContext);
    if (action.datasetAction || type?.startsWith('dataset-') || type?.startsWith('repeater-')) {
      runtime._executeDatasetAction(action.datasetAction || action, executed, rowContext);
    }
    const page = action.link || (type === 'link' || type === 'navigate' ? action.page || action.to || action.target : null);
    if (page) navigate(page);
    if (Array.isArray(action.actions)) for (const item of action.actions) visit(item);
  }

  function visit(current) {
    if (!current) return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
    } else if (typeof current === 'string') {
      navigate(current);
    } else if (typeof current === 'object') {
      if (Array.isArray(current.cases)) {
        for (const [caseIndex, branch] of current.cases.entries()) {
          const expression = branch.when ?? branch.if ?? branch.condition;
          const value = expression === undefined || expression === 'else' ? true : evaluate(expression);
          const matched = Boolean(value);
          executed.push({ action: 'condition', caseIndex, expression: expression ?? 'else', value, matched });
          if (matched) {
            applyAction(branch);
            if (branch.break !== false) break;
          }
        }
      } else if (current.when !== undefined || current.if !== undefined) {
        const expression = current.when ?? current.if;
        const value = evaluate(expression);
        const matched = Boolean(value);
        executed.push({ action: 'condition', expression, value, matched });
        if (matched) applyAction(current.then || current);
        else if (current.else) visit(current.else);
      } else {
        applyAction(current);
      }
    }
  }

  visit(spec);
}
