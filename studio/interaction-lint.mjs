// 静态交互逻辑自愈诊断（L1/L2 纯函数模块，零上层依赖）：
// 在事务提交、场景运行与设计评审阶段提前捕获 AI 常见的交互死胡同与遮蔽陷阱，并给出可直接执行的修复建议。

export const INTERACTION_LINT_CODES = new Set([
  'W_SHOW_MASKED_BY_HIDDEN_ANCESTOR',
  'W_CASE_CONSTANT_CONDITION',
  'W_CASE_SHADOWED',
  'W_SEQUENTIAL_WHEN_MUTATION',
  'W_STATE_VAR_NEVER_UPDATED',
  'W_BUTTON_NO_INTERACTION',
  'W_UNREACHABLE_HIDDEN_LAYER',
]);

const RESERVED_WORDS = new Set([
  'true', 'false', 'null', 'undefined',
  'item', 'row', 'caller', 'dataset', 'widget', 'var', 'variable', 'param',
  'text', 'number', 'concat', 'contains', 'length', 'lower', 'upper', 'not', 'remove',
  'trim', 'replace', 'min', 'max', 'abs', 'round', 'floor', 'ceil',
]);

function stripQuotedStrings(expr) {
  return String(expr || '').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
}

export function extractExpressionVariables(expr, declaredVars = {}) {
  if (typeof expr !== 'string' || !expr.trim()) return [];
  const raw = expr.trim();
  const body = raw.startsWith('=') && !raw.startsWith('==') ? raw.slice(1) : raw;
  const cleaned = stripQuotedStrings(body);
  const found = new Set();

  for (const m of cleaned.matchAll(/\$([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    found.add(m[1]);
  }
  for (const m of cleaned.matchAll(/\b(?:var|variable)\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    found.add(m[1]);
  }
  const cleanedNoDots = cleaned.replace(/\b(?:item|row|caller|dataset|widget|var|variable|param)\.[A-Za-z0-9_.-]+/g, ' ');
  for (const m of cleanedNoDots.matchAll(/\b([A-Za-z_][A-Za-z0-9_-]*)\b(?!\s*\()/g)) {
    const ident = m[1];
    if (!RESERVED_WORDS.has(ident) && Object.hasOwn(declaredVars, ident)) {
      found.add(ident);
    }
  }
  return [...found];
}

function normalizeConditionText(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (s.startsWith('=') && !s.startsWith('==')) s = s.slice(1).trim();
  return s.replace(/\s+/g, ' ').replace(/===/g, '==').replace(/!==/g, '!=');
}

function evaluateConstantCondition(raw) {
  if (typeof raw === 'boolean') return { isConstant: true, value: raw };
  if (typeof raw !== 'string') return { isConstant: false, value: null };
  const s = normalizeConditionText(raw);
  if (!s) return { isConstant: false, value: null };
  if (s === 'true' || s === '!false' || s === 'not(false)') return { isConstant: true, value: true };
  if (s === 'false' || s === '!true' || s === 'not(true)') return { isConstant: true, value: false };

  const numMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (numMatch) {
    const a = Number(numMatch[1]);
    const op = numMatch[2];
    const b = Number(numMatch[3]);
    const val = op === '==' ? a === b : op === '!=' ? a !== b : op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
    return { isConstant: true, value: val };
  }

  const strMatch = s.match(/^(['"])((?:\\.|(?!\1).)*)\1\s*(==|!=)\s*(['"])((?:\\.|(?!\4).)*)\4$/);
  if (strMatch) {
    const a = strMatch[2];
    const op = strMatch[3];
    const b = strMatch[5];
    return { isConstant: true, value: op === '==' ? a === b : a !== b };
  }

  const selfEq = s.match(/^(\$[A-Za-z_][A-Za-z0-9_-]*)\s*(==|!=)\s*\1$/);
  if (selfEq) {
    return { isConstant: true, value: selfEq[2] === '==' };
  }

  return { isConstant: false, value: null };
}

function refString(val) {
  if (typeof val === 'string' && val.trim()) return val.trim().replace(/^@/, '');
  if (val && typeof val === 'object' && typeof val.ref === 'string' && val.ref.trim()) return val.ref.trim().replace(/^@/, '');
  return null;
}

function collectSpecSummary(spec, declaredVars) {
  const mutatedVars = new Set();
  const shownTargets = new Set();
  const conditionVars = new Set();

  const visit = item => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const sub of item) visit(sub);
      return;
    }
    if (typeof item !== 'object') return;

    const cond = item.when ?? item.if ?? item.condition;
    if (typeof cond === 'string') {
      for (const v of extractExpressionVariables(cond, declaredVars)) conditionVars.add(v);
    }

    if (Array.isArray(item.cases)) {
      for (const c of item.cases) visit(c);
    }
    if (item.actions !== undefined) visit(item.actions);
    if (item.then !== undefined) visit(item.then);
    if (item.else !== undefined && typeof item.else === 'object') visit(item.else);

    const t = item.type;
    if (t === 'set-var' || t === 'set-variable') {
      const name = String(item.name || item.variable || '').trim();
      if (name) mutatedVars.add(name);
    }
    if (item.setVar && typeof item.setVar === 'object' && !Array.isArray(item.setVar)) {
      for (const k of Object.keys(item.setVar)) mutatedVars.add(k.replace(/^\$/, ''));
    }
    if (t === 'show' || t === 'toggle') {
      const ref = refString(item.target);
      if (ref) shownTargets.add(ref);
    }
    if (item.show !== undefined) {
      const list = Array.isArray(item.show) ? item.show : [item.show];
      for (const s of list) {
        const ref = refString(s);
        if (ref) shownTargets.add(ref);
      }
    }
    for (const extraKey of ['onEmptyShow', 'onEmptySelectionShow']) {
      const ref = refString(item[extraKey]);
      if (ref) shownTargets.add(ref);
    }
  };

  visit(spec);
  return { mutatedVars, shownTargets, conditionVars };
}

function inspectEventSpecStructure(spec, ctx, diagnostics) {
  if (!spec) return;
  if (Array.isArray(spec)) {
    const mutatedEarlier = new Set();
    for (let i = 0; i < spec.length; i++) {
      const step = spec[i];
      if (!step || typeof step !== 'object') continue;
      const cond = step.when ?? step.if ?? step.condition;
      if (cond !== undefined && !Array.isArray(step.cases)) {
        const constCheck = evaluateConstantCondition(cond);
        if (constCheck.isConstant) {
          diagnostics.push({
            code: 'W_CASE_CONSTANT_CONDITION',
            severity: 'warning',
            pageId: ctx.pageId,
            nodeId: ctx.nodeId,
            scopedId: ctx.scopedId,
            event: ctx.eventName,
            condition: String(cond),
            constantValue: constCheck.value,
            message: `节点 "${ctx.nodeId}" 的 ${ctx.eventName} 条件 "${cond}" 恒为 ${constCheck.value}，${constCheck.value ? '条件形同虚设' : '动作永远不会执行'}`,
            suggestion: constCheck.value
              ? '如无需分支判断请去掉 when 直接执行动作；如需按状态分流请绑定真实状态变量（如 =$step == 1）'
              : '该分支恒为 false 属于死代码，请修正条件表达式或移除该动作',
          });
        }
        const readVars = extractExpressionVariables(String(cond), ctx.declaredVars);
        const clobbered = readVars.find(v => mutatedEarlier.has(v));
        if (clobbered) {
          diagnostics.push({
            code: 'W_SEQUENTIAL_WHEN_MUTATION',
            severity: 'warning',
            pageId: ctx.pageId,
            nodeId: ctx.nodeId,
            scopedId: ctx.scopedId,
            event: ctx.eventName,
            variable: clobbered,
            message: `节点 "${ctx.nodeId}" 的 ${ctx.eventName} 动作数组中，前序分支刚修改了变量 "$${clobbered}"，后续顺序 when 立即读取 "$${clobbered}" 会连环误触发`,
            suggestion: `互斥状态切换请将顺序数组改写为 { cases: [ { when: "=$${clobbered} == ...", actions: [...] }, { else: true, actions: [...] } ] }`,
          });
        }
      }
      inspectEventSpecStructure(step, ctx, diagnostics);
      const subSummary = collectSpecSummary(step, ctx.declaredVars);
      for (const v of subSummary.mutatedVars) mutatedEarlier.add(v);
    }
    return;
  }

  if (typeof spec !== 'object') return;

  if (Array.isArray(spec.cases)) {
    let unconditionalSeen = false;
    let unconditionalLabel = '';
    const seenConditions = new Set();

    for (let i = 0; i < spec.cases.length; i++) {
      const branch = spec.cases[i];
      if (!branch || typeof branch !== 'object') continue;
      const cond = branch.when ?? branch.if ?? branch.condition;
      const isElse = branch.else === true && cond === undefined;

      if (unconditionalSeen) {
        diagnostics.push({
          code: 'W_CASE_SHADOWED',
          severity: 'warning',
          pageId: ctx.pageId,
          nodeId: ctx.nodeId,
          scopedId: ctx.scopedId,
          event: ctx.eventName,
          branchIndex: i,
          message: `节点 "${ctx.nodeId}" 的 ${ctx.eventName}.cases 第 ${i + 1} 个分支位于${unconditionalLabel}之后，永远无法到达`,
          suggestion: '请将具体的 when 条件排在 else:true 兜底分支之前，或删除多余死分支',
        });
      } else if (isElse) {
        if (branch.break !== false) {
          unconditionalSeen = true;
          unconditionalLabel = '无条件兜底分支 (else:true) ';
        }
      } else if (cond !== undefined) {
        const constCheck = evaluateConstantCondition(cond);
        if (constCheck.isConstant) {
          diagnostics.push({
            code: 'W_CASE_CONSTANT_CONDITION',
            severity: 'warning',
            pageId: ctx.pageId,
            nodeId: ctx.nodeId,
            scopedId: ctx.scopedId,
            event: ctx.eventName,
            branchIndex: i,
            condition: String(cond),
            constantValue: constCheck.value,
            message: `节点 "${ctx.nodeId}" 的 ${ctx.eventName}.cases 第 ${i + 1} 个分支条件 "${cond}" 恒为 ${constCheck.value}`,
            suggestion: constCheck.value
              ? '恒真条件若是兜底分支请改写为 { else: true, actions: [...] } 并放在末尾；否则请检查变量引用'
              : '恒假分支永远不会命中，请修正条件表达式或移除该分支',
          });
          if (constCheck.value === true && branch.break !== false) {
            unconditionalSeen = true;
            unconditionalLabel = `恒真分支 (${cond}) `;
          }
        } else {
          const norm = normalizeConditionText(String(cond));
          if (norm && seenConditions.has(norm)) {
            diagnostics.push({
              code: 'W_CASE_SHADOWED',
              severity: 'warning',
              pageId: ctx.pageId,
              nodeId: ctx.nodeId,
              scopedId: ctx.scopedId,
              event: ctx.eventName,
              branchIndex: i,
              condition: String(cond),
              message: `节点 "${ctx.nodeId}" 的 ${ctx.eventName}.cases 第 ${i + 1} 个分支条件 "${cond}" 与前序互斥分支重复，永远不会命中`,
              suggestion: '请区分各分支的判断条件，或将多个动作合并到同一个分支的 actions 数组中',
            });
          } else if (norm && branch.break !== false) {
            seenConditions.add(norm);
          }
        }
      }

      if (branch.actions !== undefined) inspectEventSpecStructure(branch.actions, ctx, diagnostics);
      if (branch.then !== undefined) inspectEventSpecStructure(branch.then, ctx, diagnostics);
      if (branch.else !== undefined && typeof branch.else === 'object') inspectEventSpecStructure(branch.else, ctx, diagnostics);
    }
    return;
  }

  if (spec.actions !== undefined) inspectEventSpecStructure(spec.actions, ctx, diagnostics);
  if (spec.then !== undefined) inspectEventSpecStructure(spec.then, ctx, diagnostics);
  if (spec.else !== undefined && typeof spec.else === 'object') inspectEventSpecStructure(spec.else, ctx, diagnostics);
}

function nodeEventsOf(node) {
  const out = {};
  if (node?.on && typeof node.on === 'object' && !Array.isArray(node.on)) {
    for (const [ev, spec] of Object.entries(node.on)) {
      if (spec !== undefined && spec !== null) out[ev] = spec;
    }
  }
  if (node?.onClick && !out.click) out.click = node.onClick;
  return out;
}

export function lintDocumentInteractions(doc, { includeCompleteness = false, pageId: filterPageId = null } = {}) {
  if (!doc || typeof doc !== 'object') return [];
  const declaredVars = doc.variables && typeof doc.variables === 'object' ? doc.variables : {};
  const diagnostics = [];

  const pageMaps = new Map();
  const allMutatedVars = new Set();
  const allShownKeysGlobal = new Set();
  const branchConditionVarSites = new Map(); // varName -> first site

  for (const pg of doc.pages || []) {
    if (!pg?.root) continue;
    const entries = [];
    const byId = new Map();
    const byScoped = new Map();

    const walk = (node, scope, ancestors, interactiveAncestors) => {
      if (!node || typeof node !== 'object') return;
      const scopedId = `${scope}/${node.id}`;
      const events = nodeEventsOf(node);
      const hasOwnInteraction = Object.keys(events).length > 0 || Boolean(node.goto || node.page || node.link);
      const entry = {
        node,
        id: node.id,
        scopedId,
        scope,
        pageId: pg.id,
        ancestors, // [{ id, scopedId, visible }]
        hasInteractiveAncestor: interactiveAncestors,
        hasOwnInteraction,
        events,
      };
      entries.push(entry);
      byScoped.set(scopedId, entry);
      if (!byId.has(node.id)) byId.set(node.id, []);
      byId.get(node.id).push(entry);

      const nextAncestors = [...ancestors, { id: node.id, scopedId, visible: node.visible !== false }];
      const nextInteractive = interactiveAncestors || hasOwnInteraction;
      for (const ch of node.children || []) walk(ch, scope, nextAncestors, nextInteractive);
      for (const st of node.states || []) {
        if (st?.root) walk(st.root, `${scopedId}/${st.id}`, nextAncestors, nextInteractive);
      }
      if (node.template) {
        walk(node.template, `${scopedId}/template`, nextAncestors, nextInteractive);
      }
    };

    walk(pg.root, pg.id, [], false);

    const resolveTargetOnPage = rawRef => {
      if (!rawRef) return null;
      if (byScoped.has(rawRef)) return byScoped.get(rawRef);
      if (byScoped.has(`${pg.id}/${rawRef}`)) return byScoped.get(`${pg.id}/${rawRef}`);
      const cands = byId.get(rawRef);
      return cands && cands.length === 1 ? cands[0] : null;
    };

    const pageShownScoped = new Set();
    const handlerSummaries = [];

    for (const entry of entries) {
      for (const [eventName, spec] of Object.entries(entry.events)) {
        const summary = collectSpecSummary(spec, declaredVars);
        for (const v of summary.mutatedVars) allMutatedVars.add(v);
        for (const v of summary.conditionVars) {
          if (!branchConditionVarSites.has(v)) {
            branchConditionVarSites.set(v, {
              pageId: pg.id,
              nodeId: entry.id,
              scopedId: entry.scopedId,
              event: eventName,
            });
          }
        }
        const handlerShownScoped = new Set();
        for (const rawRef of summary.shownTargets) {
          allShownKeysGlobal.add(rawRef);
          const resolved = resolveTargetOnPage(rawRef);
          if (resolved) {
            pageShownScoped.add(resolved.scopedId);
            handlerShownScoped.add(resolved.scopedId);
            allShownKeysGlobal.add(resolved.scopedId);
            allShownKeysGlobal.add(resolved.id);
          }
        }
        handlerSummaries.push({ entry, eventName, spec, summary, handlerShownScoped });
      }
    }

    pageMaps.set(pg.id, { pg, entries, resolveTargetOnPage, pageShownScoped, handlerSummaries });
  }

  // Also scan component definitions for variable mutations so shared components count
  for (const comp of Object.values(doc.components || {})) {
    const walkComp = n => {
      if (!n || typeof n !== 'object') return;
      for (const spec of Object.values(nodeEventsOf(n))) {
        const summary = collectSpecSummary(spec, declaredVars);
        for (const v of summary.mutatedVars) allMutatedVars.add(v);
      }
      for (const ch of n.children || []) walkComp(ch);
      for (const st of n.states || []) if (st?.root) walkComp(st.root);
      if (n.template) walkComp(n.template);
    };
    if (comp?.root) walkComp(comp.root);
  }

  // Pass 2: Emit per-page interaction diagnostics
  for (const [pgId, info] of pageMaps.entries()) {
    if (filterPageId && pgId !== filterPageId) continue;

    for (const { entry, eventName, spec, summary, handlerShownScoped } of info.handlerSummaries) {
      inspectEventSpecStructure(
        spec,
        {
          pageId: pgId,
          nodeId: entry.id,
          scopedId: entry.scopedId,
          eventName,
          declaredVars,
        },
        diagnostics
      );

      // W_SHOW_MASKED_BY_HIDDEN_ANCESTOR
      for (const rawRef of summary.shownTargets) {
        const targetEntry = info.resolveTargetOnPage(rawRef);
        if (!targetEntry) continue;
        const hiddenAnc = targetEntry.ancestors.find(
          anc => anc.visible === false && !handlerShownScoped.has(anc.scopedId) && !info.pageShownScoped.has(anc.scopedId)
        );
        if (hiddenAnc) {
          diagnostics.push({
            code: 'W_SHOW_MASKED_BY_HIDDEN_ANCESTOR',
            severity: 'warning',
            pageId: pgId,
            nodeId: entry.id,
            scopedId: entry.scopedId,
            targetNodeId: targetEntry.id,
            targetScopedId: targetEntry.scopedId,
            maskedByAncestorId: hiddenAnc.id,
            maskedByAncestorScopedId: hiddenAnc.scopedId,
            message: `节点 "${entry.id}" 尝试显示 "${targetEntry.id}"，但其祖先容器 "${hiddenAnc.id}" 始终为 visible:false，导致目标在画面中仍被遮蔽不可见`,
            suggestion: `请改为显示祖先容器 "${hiddenAnc.id}"（或在同一交互中同时 show "${hiddenAnc.id}"），也可将祖先容器设为 visible:true 仅隐藏子节点`,
          });
        }
      }
    }

    if (includeCompleteness) {
      for (const entry of info.entries) {
        const n = entry.node;
        if (n.controlledByMacro) continue;
        if (
          n.type === 'button'
          && n.visible !== false
          && !n.disabled
          && n.state !== 'disabled'
          && !entry.hasOwnInteraction
          && !entry.hasInteractiveAncestor
          && !entry.scope.includes('/template')
        ) {
          diagnostics.push({
            code: 'W_BUTTON_NO_INTERACTION',
            severity: 'warning',
            pageId: pgId,
            nodeId: entry.id,
            scopedId: entry.scopedId,
            message: `按钮 "${entry.id}" 可见且未禁用，但尚未绑定任何点击交互（on.click / goto）`,
            suggestion: '如需响应用户操作请通过 setInteraction 或 RP/1 +onClick 补齐动作；如仅为静态标签请改用 badge 或 label',
          });
        }
        if (
          n.visible === false
          && !allShownKeysGlobal.has(entry.scopedId)
          && !allShownKeysGlobal.has(entry.id)
        ) {
          diagnostics.push({
            code: 'W_UNREACHABLE_HIDDEN_LAYER',
            severity: 'warning',
            pageId: pgId,
            nodeId: entry.id,
            scopedId: entry.scopedId,
            message: `隐藏节点 "${entry.id}"（visible:false）在全工程没有任何 show / toggle 动作指向它，运行时永远不可见`,
            suggestion: '请为触发按钮补齐 {"type":"show","target":"' + entry.id + '"}，或移除不再需要的隐藏死节点',
          });
        }
      }
    }
  }

  // W_STATE_VAR_NEVER_UPDATED
  for (const [varName, site] of branchConditionVarSites.entries()) {
    if (filterPageId && site.pageId !== filterPageId) continue;
    if (Object.hasOwn(declaredVars, varName) && !allMutatedVars.has(varName)) {
      diagnostics.push({
        code: 'W_STATE_VAR_NEVER_UPDATED',
        severity: 'warning',
        pageId: site.pageId,
        nodeId: site.nodeId,
        scopedId: site.scopedId,
        variable: varName,
        message: `交互条件读取了状态变量 "$${varName}"，但全工程没有任何 set-var 动作更新该变量，其他状态分支永远无法到达`,
        suggestion: `请在状态推进动作中补齐 {"type":"set-var","name":"${varName}","value":...}`,
      });
    }
  }

  return diagnostics;
}
