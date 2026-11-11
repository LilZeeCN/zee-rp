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
  const textVariable = ([, add, name]) => add === undefined
    ? String(variables[name] ?? '')
    : String(Number(add) + Number(variables[name] || 0));
  const explicitTextVariable = body.match(/^text\(\s*(?:(\d+)\s*\+\s*)?(?:var\.|\$)([a-zA-Z0-9_]+)\s*\)$/);
  if (explicitTextVariable) return textVariable(explicitTextVariable);

  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|dataset\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.]+|widget\.[a-zA-Z0-9_-]+\.text|item\.[a-zA-Z0-9_]+|var\.[a-zA-Z0-9_-]+|@[a-zA-Z0-9_/-]+|\$[a-zA-Z0-9_-]+|[a-zA-Z_][a-zA-Z0-9_-]*/g;
  const resolved = body.replace(tokens, (token, offset) => {
    if (token.startsWith('"') || token.startsWith("'")) return token;
    if (token.startsWith('dataset.')) {
      const [, name, ...path] = token.split('.');
      return JSON.stringify(resolveDatasetPath(name, path.join('.')));
    }
    if (token.startsWith('@')) return JSON.stringify(getWidgetText(token.slice(1)));
    if (token.startsWith('widget.')) return JSON.stringify(getWidgetText(token.slice(7, -5)));
    if (token.startsWith('item.')) return JSON.stringify(itemRow?.[token.slice(5)] ?? '');
    if (token.startsWith('var.')) return JSON.stringify(variables[token.slice(4)] ?? '');
    if (token.startsWith('$')) return JSON.stringify(variables[token.slice(1)] ?? '');
    if (Object.hasOwn(variables, token) && !body.slice(offset + token.length).trimStart().startsWith('(')) {
      return JSON.stringify(variables[token]);
    }
    return token;
  });
  const functions = {
    text: value => String(value ?? ''),
    number: value => Number(value) || 0,
    concat: (...values) => values.map(value => String(value ?? '')).join(''),
    contains: (value, part) => String(value).includes(String(part)),
    length: value => String(value).length,
    lower: value => String(value).toLowerCase(),
    upper: value => String(value).toUpperCase(),
    not: value => !value,
    remove: (value, part) => String(value).split(String(part)).join(''),
  };
  try {
    const evaluate = new Function(...Object.keys(functions), 'return (' + resolved + ');');
    return evaluate(...Object.values(functions));
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
    const declared = declaredVariables?.[name];
    const initial = declared && typeof declared === 'object' && 'value' in declared ? declared.value : declared;
    if (declared !== undefined && typeof value !== typeof initial) {
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
