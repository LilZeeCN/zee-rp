const builtins = new Set(['now', 'this', 'target', 'focused', 'item', 'targetitem', 'true', 'false', 'null',
  'window', 'cursor', 'page', 'gen', 'math', 'and', 'or', 'not']);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const tokensOf = body => body.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d*\.\d+(?:e[+-]?\d+)?|\d+(?:e[+-]?\d+)?|[A-Za-z_$][\w$]*|[^\s]/gi) ?? [];
const keyOf = v => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export function lintExpression(expression, { bindings = {}, variables = [], required = false, checkIdentifiers = false, version = 9 } = {}) {
  if (typeof expression !== 'string') return [];
  const diagnostics = [];
  const add = (code, severity, message, nextAction, offset = 0) => {
    const lines = expression.slice(0, offset).split('\n');
    diagnostics.push({ code, severity, message, nextAction, expression, expressionSpan: { offset, line: lines.length, column: lines.at(-1).length + 1 } });
  };
  const pattern = /\[\[((?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|[^"'\]]|\](?!\]))*)\]\]/g;
  const chunks = [...expression.matchAll(pattern)];
  const remainder = expression.replace(pattern, '');
  if (/\[\[|\]\]/.test(remainder) || (required && (chunks.length !== 1 || remainder !== ''))) {
    add('E_AXURE_EXPRESSION_WRAPPER', 'error', '表达式的 [[...]] 包裹不完整或不符合该字段的要求。', 'expression 字段填写一条完整的 [[...]] 公式。');
    return diagnostics;
  }
  const names = new Map();
  for (const name of variables) names.set(name.toLowerCase(), name);
  const aliases = new Set();
  for (const name of Object.keys(bindings ?? {})) {
    const lower = name.toLowerCase();
    if (!identifier.test(name) || aliases.has(lower)) {
      add('E_AXURE_BINDING_ALIAS', 'error', `绑定名 "${name}" 非法或与另一别名大小写冲突。`, '使用唯一的字母、数字或下划线别名，并以字母或下划线开头。');
    }
    aliases.add(lower);
    names.set(lower, name);
  }
  for (const { 1: body, index: offset } of chunks) {
    const tokens = tokensOf(body);
    let depth = 0, maxDepth = 0, unbalanced = false;
    for (const token of tokens) {
      if (token === '(') maxDepth = Math.max(maxDepth, ++depth);
      if (token === ')' && --depth < 0) unbalanced = true;
    }
    if (!tokens.length || depth || unbalanced || /^(?:\+|-|\*|\/|%|\.|,|=|&&|\|\|)$/.test(tokens.at(-1) ?? '')) {
      add('E_AXURE_EXPRESSION_SYNTAX', 'error', '表达式为空、括号未配对或缺少操作数。', '补齐括号和操作数。', offset);
    }
    if (Number(version) === 9 && tokens.some((t, i) => t === 'Math' && tokens[i + 1] === '.')) {
      if (tokens.some((t, i) => t === 'Math' && tokens[i + 1] === '.' && tokens[i + 2] === 'round')) {
        add('E_AXURE_STO_MATH_NAMESPACE', 'error', 'RP9 官方 STO 编译器拒绝 Math.round(...)。', '按小数位舍入可用 (数值).toFixed(位数)。若后续参与运算，先乘 1 转回数值。', offset);
      }
      if (tokens.some((t, i) => t === 'Math' && tokens[i + 1] === '.' && tokens[i + 2] === 'PI')) {
        add('E_AXURE_STO_MATH_NAMESPACE', 'error', 'RP9 官方 STO 编译器拒绝 Math.PI。', '可用数字常量 3.141592653589793，或将常量定义为全局变量。', offset);
      }
    }
    if (maxDepth >= 4 || tokens.some(t => /^\d{8,}$/.test(t)) || body.length > 140) {
      add('W_AXURE_EXPRESSION_COMPLEX', 'warning', '公式包含深层嵌套、较大的整数缩放或较长的运算链。', '把中间值拆为独立的 set-variable 动作，借助官方预检确认每段。', offset);
    }
    if (tokens.some((t, i) => t === '+' && (/^["']/.test(tokens[i - 1] ?? '') || /^["']/.test(tokens[i + 1] ?? '') ||
      (identifier.test(tokens[i - 1] ?? '') && !['*', '/', '%'].includes(tokens[i - 2])) ||
      (identifier.test(tokens[i + 1] ?? '') && !['*', '/', '%'].includes(tokens[i + 2]))))) {
      add('W_AXURE_PLUS_COERCION', 'warning', 'Axure 的 + 会按操作数隐式转换类型，数字字符串可能变成加法。', '字符串拼接用 a.concat(b)。数值相加用 a * 1 + b * 1。', offset);
    }
    const used = new Set();
    tokens.forEach((token, index) => {
      const lower = token.toLowerCase();
      if (!identifier.test(token) || tokens[index - 1] === '.' || used.has(token)) return;
      used.add(token);
      if (aliases.has(lower) && token !== names.get(lower)) {
        add('W_AXURE_BINDING_CASE', 'warning', `公式中的 "${token}" 与绑定 "${names.get(lower)}" 大小写不一致。`, `统一使用 ${names.get(lower)}。`, offset);
      } else if (checkIdentifiers && !names.has(lower) && !builtins.has(lower) && tokens[index + 1] !== '(') {
        add('W_AXURE_UNKNOWN_IDENTIFIER', 'warning', `找不到公式标识符 "${token}" 的绑定或全局变量。`, '检查拼写，或在 bindings 中声明来源。', offset);
      }
    });
  }
  return diagnostics;
}

function impossibleEquality(when) {
  const values = new Map();
  const visit = node => {
    if (node?.op === '&&' || node?.op === 1) return visit(node.left) || visit(node.right);
    if (node?.op !== '==' && node?.op !== 3) return false;
    const source = node.left;
    if (!source || typeof source !== 'object' || !(source.variable || source.widget)) return false;
    const value = typeof node.right === 'object' ? node.right?.value : node.right;
    // Non-numeric, non-expression string literals have no numeric aliases.
    if (typeof value !== 'string' || !value || !Number.isNaN(Number(value)) || value.includes('[[')) return false;
    const key = keyOf(source);
    if (values.has(key) && values.get(key) !== value) return true;
    values.set(key, value);
    return false;
  };
  return visit(when);
}

export function summarizeCaseGroups(cases) {
  const groups = [];
  const diagnostics = [];
  let seen = new Set(), terminal = null;
  for (const [index, kase] of cases.entries()) {
    const caseIndex = index + 1;
    const hasCondition = kase.hasCondition ?? kase.when !== undefined;
    if (!groups.length || kase.isNewIfGroup || kase.condition === 'if') {
      groups.push({ group: groups.length + 1, cases: [] });
      seen = new Set();
      terminal = null;
    }
    const entries = groups.at(-1).cases;
    const role = !entries.length ? (hasCondition ? 'if' : 'always') : (hasCondition ? 'else-if' : 'else');
    const condition = kase.conditionHash ?? (kase.when === undefined ? null : keyOf(kase.when));
    entries.push({ caseIndex, name: kase.description ?? '', role, ...(kase.disabled ? { disabled: true } : {}) });
    if (kase.disabled) continue;
    const say = (code, message, nextAction) => diagnostics.push({ code, severity: 'warning', caseIndex, case: kase.description ?? '', message, nextAction });
    if (terminal !== null) say('W_AXURE_UNREACHABLE_CASE', `同一条件组的第 ${terminal} 个 Case 已兜底，此分支永远无法命中。`, '将分支移到兜底前，或开启独立的 if 组。');
    else if (condition && seen.has(condition)) say('W_AXURE_DUPLICATE_CONDITION', '同组内已有相同条件，后一个分支无法命中。', '合并重复条件，或将其改为独立 if 组。');
    if (impossibleEquality(kase.when)) say('W_AXURE_CONTRADICTORY_CASE', '同一条件要求一个值同时等于两个不同的文字。', '复核 &&，或把互斥条件拆成不同 Case。');
    if (condition) seen.add(condition);
    if (!hasCondition && terminal === null) terminal = caseIndex;
  }
  return { groups, diagnostics };
}

export function normalizedCases(ix) {
  return (ix.cases ?? [{ ...(ix.when !== undefined ? { when: ix.when } : {}), description: ix.description,
    actions: ix.actions ?? [] }]).map((kase, index) => {
    if (kase.condition === undefined) return kase;
    const { condition, when, isNewIfGroup } = kase;
    if (!['if', 'else-if', 'else', 'always'].includes(condition) ||
      (when !== undefined) !== ['if', 'else-if'].includes(condition) ||
      (isNewIfGroup !== undefined && isNewIfGroup !== ['if', 'always'].includes(condition)) ||
      (['else-if', 'else'].includes(condition) && index === 0)) {
      throw new Error(`Case ${index + 1}: condition 使用 if / else-if（带 when）、else / always（无 when），并与 isNewIfGroup 一致。`);
    }
    return { ...kase, isNewIfGroup: ['if', 'always'].includes(condition) };
  });
}

export function lintInteractionSpecs(interactions, { variables = [], context = {}, version = 9 } = {}) {
  const diagnostics = [];
  const events = [];
  let expressionCount = 0;
  for (const [ei, ix] of interactions.entries()) {
    const cases = normalizedCases(ix);
    const { groups, diagnostics: grouping } = summarizeCaseGroups(cases);
    const event = ix.event;
    const base = `/interactions/${ei}${ix.cases ? '/cases' : ''}`;
    events.push({ ...context, event, groups });
    diagnostics.push(...grouping.map(d => ({ ...context, event, ...d, pointer: `${base}/${d.caseIndex - 1}` })));
    for (const [ci, kase] of cases.entries()) {
      const location = { ...context, event, caseIndex: ci + 1, case: kase.description ?? '' };
      const visit = (node, path, actionIndex) => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          const pointer = `${path}/${key}`;
          if (typeof value === 'string' && (key === 'expression' || /\[\[|\]\]/.test(value))) {
            expressionCount++;
            const required = key === 'expression';
            const found = lintExpression(value, { bindings: node.bindings, variables, required, checkIdentifiers: true, version });
            diagnostics.push(...found.map(d => ({ ...location, actionIndex, pointer, ...d })));
          } else if (key !== 'bindings') visit(value, pointer, actionIndex);
        }
      };
      if (kase.when) visit(kase.when, `${base}/${ci}/when`, null);
      for (const [ai, action] of (kase.actions ?? []).entries()) {
        visit(action, `${base}${ix.cases ? '/' + ci : ''}/actions/${ai}`, ai + 1);
      }
    }
  }
  return { diagnostics, events, expressionCount };
}

export function lintNativeInteractions(owners, variables, version) {
  const diagnostics = [], events = [];
  const reads = new Map(), writes = new Map();
  const mark = (map, name, location) => {
    if (!name) return;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(location);
  };
  const names = variables.map(v => v.name);
  for (const owner of owners) {
    const { interactions, ...target } = owner;
    for (const ix of interactions) {
      const context = { ...target, event: ix.event };
      const summary = summarizeCaseGroups(ix.cases);
      events.push({ ...context, disabled: ix.disabled, groups: summary.groups });
      if (ix.disabled) continue;
      diagnostics.push(...summary.diagnostics.map(d => ({ ...context, ...d })));
      ix.cases.forEach((kase, index) => {
        if (kase.disabled) return;
        const location = { ...context, caseIndex: index + 1, case: kase.description };
        const scan = (usage, actionIndex) => {
          if (!usage) return;
          const place = { ...location, actionIndex };
          for (const name of usage.reads) mark(reads, name, place);
          for (const name of usage.writes) mark(writes, name, place);
          for (const item of usage.expressions) {
            const found = lintExpression(item.expression, { variables: names, bindings: item.bindings, checkIdentifiers: true, version });
            diagnostics.push(...found.map(d => ({ ...place, ...d })));
          }
        };
        scan(kase.usage, null);
        kase.actions.forEach((action, ai) => { if (!action.disabled) scan(action.usage, ai + 1); });
      });
    }
  }
  return { diagnostics, events, variables: variables.map(({ name, value }) => {
    const key = name.toLowerCase(), read = reads.get(key) ?? [], write = writes.get(key) ?? [];
    return { name, initialValue: value, reads: read.length, writes: write.length,
      status: !read.length && !write.length ? 'unused' : !read.length ? 'write-only' : !write.length ? 'initial-only' : 'read-write',
      firstRead: read[0] ?? null, firstWrite: write[0] ?? null };
  }) };
}
