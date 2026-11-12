// These functions have no module dependencies. The code exporter embeds them
// in its standalone script so it also works when index.html is opened directly.
export function evaluatePrototypeExpression(expression, { variables, getWidgetText, resolveDatasetPath, itemRow = null }) {
  if (expression == null) return '';
  if (typeof expression === 'number' || typeof expression === 'boolean') return expression;
  const source = String(expression).trim();
  if (!source.startsWith('=')) {
    return itemRow ? source.replace(/\$\{\s*item\.([a-zA-Z0-9_]+)\s*\}|\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, itemField, templateField) => String(itemRow[itemField || templateField] ?? '')) : source;
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
    concat: (...values) => values.map(value => String(value ?? '')).join(''),
    contains: (value, part) => String(value ?? '').includes(String(part ?? '')),
    length: value => String(value ?? '').length,
    lower: value => String(value ?? '').toLowerCase(),
    upper: value => String(value ?? '').toUpperCase(),
    trim: value => String(value ?? '').trim(),
    not: value => !value,
    remove: (value, part) => String(value ?? '').split(String(part ?? '')).join(''),
    replace: (value, from, to) => String(value ?? '').split(String(from ?? '')).join(String(to ?? '')),
    min: (...values) => Math.min(...values.map(v => Number(v) || 0)),
    max: (...values) => Math.max(...values.map(v => Number(v) || 0)),
    abs: value => Math.abs(Number(value) || 0),
    round: value => Math.round(Number(value) || 0),
    floor: value => Math.floor(Number(value) || 0),
    ceil: value => Math.ceil(Number(value) || 0),
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
      const wMatch = rest.match(/^widget\.([a-zA-Z0-9_-]+)\.text(?![a-zA-Z0-9_])/);
      if (wMatch) {
        list.push({ type: 'val', value: getWidgetText ? getWidgetText(wMatch[1]) : '' });
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
        const atMatch = rest.match(/^@([a-zA-Z0-9_/-]+)/);
        if (atMatch) {
          list.push({ type: 'val', value: getWidgetText ? getWidgetText(atMatch[1]) : '' });
          i += atMatch[0].length;
          continue;
        }
      }
      const opMatch = rest.match(/^(?:===|!==|==|!=|<=|>=|&&|\|\||\?\?|[+\-*/%<>!?:(),])/);
      if (opMatch) {
        list.push({ type: 'op', value: opMatch[0] });
        i += opMatch[0].length;
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

    const panels = action.setPanelState || (type === 'set-panel-state' ? action : null);
    if (panels) for (const item of Array.isArray(panels) ? panels : [panels]) {
      const panel = runtime.targetKey(item.target || item.panel);
      const node = runtime.findNodeInPage(runtime.currentPageId, panel);
      const states = node?.states || [];
      const current = runtime.panelStates[panel] || node?.activeState || node?.activeStateId || states[0]?.id;
      let state = item.state;
      if (states.length && ['next', 'toggle', 'flip', 'prev'].includes(state)) {
        const index = states.findIndex(candidate => candidate.id === current);
        const delta = state === 'prev' ? -1 : 1;
        state = states[(index + delta + states.length) % states.length].id;
      }
      runtime.panelStates[panel] = state;
      executed.push({ action: 'set-panel-state', panel, state });
    }

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
