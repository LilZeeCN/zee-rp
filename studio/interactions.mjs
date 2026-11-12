const fail = (message, field, extra = {}) => { throw Object.assign(new Error(message), { code: 'E_INTERACTION_ACTION', field, ...extra }); };
const target = value => {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.ref === 'string' && value.ref) return value.ref;
  fail('交互目标需要节点ID字符串或 {ref:"节点ID"}，不能把未解析对象当成目标', 'target');
};
const typed = new Set(['set-var', 'set-variable', 'show', 'hide', 'toggle', 'set-text', 'set-panel-state', 'set-check', 'set-selected', 'set-option', 'link', 'navigate',
  ...['dataset', 'repeater'].flatMap(prefix => ['add', 'update', 'delete', 'select', 'toggle-select', 'filter', 'sort', 'page'].map(op => `${prefix}-${op}`))]);

function parseInlineActionString(raw) {
  const trimmed = raw.trim();
  if (!trimmed) fail('交互字符串不能为空', 'on');
  if (!/[\s=]/.test(trimmed)) return { type: 'link', page: trimmed };
  if (/^goto\s*=\s*(\S+)$/.test(trimmed)) return { type: 'link', page: trimmed.replace(/^goto\s*=\s*/, '').replace(/^["']|["']$/g, '') };
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (!tokens.length) return { type: 'link', page: trimmed };
  const stripQ = s => (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) ? s.slice(1, -1) : s;
  const parseScalar = s => {
    const u = stripQ(s);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (!/^["']/.test(s) && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return Number(s);
    return u;
  };
  const obj = {};
  let startIdx = 0;
  if (!tokens[0].includes('=')) {
    obj.type = stripQ(tokens[0]);
    startIdx = 1;
  }
  for (let i = startIdx; i < tokens.length; i++) {
    const eq = tokens[i].indexOf('=');
    if (eq > 0) {
      obj[tokens[i].slice(0, eq)] = parseScalar(tokens[i].slice(eq + 1));
    } else if (i === 1 && !obj.target && ['show', 'hide', 'toggle'].includes(obj.type)) {
      obj.target = stripQ(tokens[i]);
    } else if (i === 1 && !obj.page && ['goto', 'link', 'navigate'].includes(obj.type)) {
      obj.page = stripQ(tokens[i]);
    }
  }
  return obj;
}

function expandSetShorthand(setMap) {
  if (!setMap || typeof setMap !== 'object' || Array.isArray(setMap)) fail('set 简写需要键值对象，例如 {"$count":"=$count+1","@lbl":"完成"}', 'set');
  const actions = [];
  for (const [rawKey, val] of Object.entries(setMap)) {
    if (rawKey.startsWith('$') || rawKey.startsWith('var.')) {
      const name = rawKey.startsWith('$') ? rawKey.slice(1) : rawKey.slice(4);
      actions.push({ type: 'set-var', name, value: val });
    } else if (rawKey.startsWith('@')) {
      actions.push({ type: 'set-text', target: rawKey.slice(1), value: val });
    } else if (rawKey.endsWith('.state')) {
      actions.push({ type: 'set-panel-state', target: rawKey.slice(0, -6), state: String(val) });
    } else if (rawKey.endsWith('.checked')) {
      actions.push({ type: 'set-check', target: rawKey.slice(0, -8), checked: val });
    } else if (rawKey.endsWith('.selected')) {
      actions.push({ type: 'set-selected', target: rawKey.slice(0, -9), selected: val });
    } else if (rawKey.endsWith('.option')) {
      actions.push({ type: 'set-option', target: rawKey.slice(0, -7), value: val });
    } else {
      actions.push({ type: 'set-var', name: rawKey, value: val });
    }
  }
  return actions;
}

export function normalizeInteractionSpec(spec) {
  if (spec === null) return null;
  if (typeof spec === 'string') return normalizeInteractionSpec([parseInlineActionString(spec)]);
  if (Array.isArray(spec)) return spec.map(normalizeInteractionSpec).flat();
  if (!spec || typeof spec !== 'object') fail('交互需要动作对象、数组或cases对象', 'on');
  const out = structuredClone(spec);
  if (out.type === 'goto') out.type = 'link';
  if (out.goto !== undefined && !out.type) { out.type = 'link'; out.page = out.goto; delete out.goto; }
  if (out['set-state'] !== undefined && !out.type) {
    const raw = out['set-state'];
    delete out['set-state'];
    if (typeof raw === 'string' && raw.includes('.')) {
      const dot = raw.lastIndexOf('.');
      out.type = 'set-panel-state';
      out.target = raw.slice(0, dot);
      out.state = raw.slice(dot + 1);
    } else if (Array.isArray(raw) && raw.length === 2) {
      out.type = 'set-panel-state';
      out.target = raw[0];
      out.state = raw[1];
    } else {
      fail('set-state 简写格式应为 "panelId.stateId" 或 ["panelId", "stateId"]', 'set-state');
    }
  }
  if (Array.isArray(out.state) && out.state.length === 2 && !out.type) {
    const [panelId, stateId] = out.state;
    out.type = 'set-panel-state';
    out.target = panelId;
    out.state = stateId;
  }
  if (out.set !== undefined && !out.type && !out.cases && out.when === undefined && out.if === undefined && out.condition === undefined) {
    const setActions = expandSetShorthand(out.set);
    const rest = { ...out };
    delete rest.set;
    if (!Object.keys(rest).length) return normalizeInteractionSpec(setActions);
    return normalizeInteractionSpec([...setActions, rest]);
  }
  const conditional = ['type','when','if','condition','then','else','actions','cases','break'];
  const dataFields = ['dataset','repeater','op','rowId','clearOthers','row','patch','requireNonEmpty','onEmptyShow','onEmptySelectionShow','query','field','operator','order','page'];
  const knownFields = ({show:['target'],hide:['target'],toggle:['target'],'set-text':['target','value','text'],
    'set-var':['name','variable','value','expr'],'set-variable':['name','variable','value','expr'],
    'set-panel-state':['target','panel','state'],
    'set-check':['target','checked','value'],
    'set-selected':['target','selected','value'],
    'set-option':['target','value','option','selected'],
    link:['page','to','target'],navigate:['page','to','target']})[out.type]
    || (out.type?.startsWith('dataset-') || out.type?.startsWith('repeater-') ? dataFields : null);
  // 未知动作类型先报类型清单，而不是被字段校验抢先把错误面模糊掉。
  if (out.type && !typed.has(out.type)) fail(`Studio运行态暂不支持动作 ${out.type}，未写入；请用受支持动作或完整原生RP/1流程。受支持动作：${[...typed].join(', ')}`, 'type', { candidates: [...typed] });
  const fields = knownFields || ['setVar','show','hide','setText','setPanelState','datasetAction','link'];
  for (const key of Object.keys(out)) if (![...conditional,...fields].includes(key)) fail(`动作 ${out.type || '组合'} 不接受字段 ${key}${knownFields ? `；该动作可用字段：${knownFields.join(', ')}` : ''}`,key);
  for (const keys of [['name','variable'],['value','expr'],['text','value'],['page','to']]) {
    if (keys.every(key=>out[key]!==undefined) && JSON.stringify(out[keys[0]])!==JSON.stringify(out[keys[1]])) fail(`动作字段 ${keys.join('/')} 冲突`,keys[1]);
  }
  if (out.target !== undefined) out.target = target(out.target);
  if (out.panel !== undefined) out.panel = target(out.panel);
  if (out.type === 'set-panel-state' && !out.target && out.panel) { out.target = out.panel; delete out.panel; }
  for (const key of ['show', 'hide']) if (out[key] !== undefined) out[key] = Array.isArray(out[key]) ? out[key].map(target) : target(out[key]);
  if (['show', 'hide', 'toggle', 'set-text', 'set-panel-state', 'set-check', 'set-selected', 'set-option'].includes(out.type) && !out.target) fail(`${out.type} 缺少target`, 'target');
  if (out.type === 'set-check') {
    if (out.checked === undefined && out.value !== undefined) { out.checked = out.value; delete out.value; }
    if (typeof out.checked !== 'boolean' && out.checked !== 'toggle' && !(typeof out.checked === 'string' && out.checked.trim().startsWith('='))) fail('set-check 需要布尔值、toggle 或布尔表达式 checked', 'checked');
  }
  if (out.type === 'set-selected') {
    if (out.selected === undefined && out.value !== undefined) { out.selected = out.value; delete out.value; }
    if (typeof out.selected !== 'boolean' && out.selected !== 'toggle' && !(typeof out.selected === 'string' && out.selected.trim().startsWith('='))) fail('set-selected 需要布尔值、toggle 或布尔表达式 selected', 'selected');
  }
  if (out.type === 'set-option') {
    if (out.value === undefined && (out.option !== undefined || out.selected !== undefined)) {
      out.value = out.option ?? out.selected;
      delete out.option;
      delete out.selected;
    }
    if (typeof out.value !== 'string' || !out.value.length) fail('set-option 需要非空选项字符串或表达式 value', 'value');
  }
  if (['link', 'navigate'].includes(out.type) && ![out.page, out.to, out.target].some(value => typeof value === 'string' && value)) fail('跳页动作缺少目标page', 'page');
  for (const key of ['actions', 'then', 'else']) {
    if (out[key] !== undefined && !(key === 'else' && out.else === true && Array.isArray(out.actions))) {
      out[key] = normalizeInteractionSpec(out[key]);
    }
  }
  if (out.setPanelState) {
    const payloads = Array.isArray(out.setPanelState) ? out.setPanelState : [out.setPanelState];
    out.setPanelState = payloads.map(item => normalizeInteractionSpec({ type: 'set-panel-state', ...item }));
  }
  if (out.cases) {
    if (!Array.isArray(out.cases) || !out.cases.length) fail('cases需要非空数组','cases');
    out.cases = out.cases.map(branch => normalizeInteractionSpec({ ...branch, actions: branch.actions || [] }));
  }
  if (out.datasetAction) out.datasetAction = normalizeInteractionSpec({ ...out.datasetAction, type: `dataset-${out.datasetAction.op}` });
  const conditions = ['when', 'if', 'condition'].filter(key => out[key] !== undefined);
  if (conditions.length > 1 && conditions.some(key => JSON.stringify(out[key]) !== JSON.stringify(out[conditions[0]]))) fail('when/if/condition 条件冲突，请只保留一个条件', conditions[1]);
  if (conditions.length) {
    let condition = out[conditions[0]];
    delete out.if;
    delete out.condition;
    if (condition === 'else') {
      delete out.when;
      out.else = true;
    } else {
      if (typeof condition === 'string' && condition.trim() && !condition.trim().startsWith('=')) condition = `=${condition.trim()}`;
      out.when = condition;
    }
  }
  if (!out.type && !['cases', 'when', 'if', 'actions', 'then', 'else', 'setVar', 'show', 'hide', 'setText', 'setPanelState', 'datasetAction', 'link'].some(key => out[key] !== undefined)) fail('未识别的动作对象，未写入；请提供受支持的type或公开简写', 'type');
  return out;
}
