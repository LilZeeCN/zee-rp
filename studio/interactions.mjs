const fail = (message, field, extra = {}) => { throw Object.assign(new Error(message), { code: 'E_INTERACTION_ACTION', field, ...extra }); };
const target = value => {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.ref === 'string' && value.ref) return value.ref;
  fail('交互目标需要节点ID字符串或 {ref:"节点ID"}，不能把未解析对象当成目标', 'target');
};
const typed = new Set(['set-var', 'set-variable', 'show', 'hide', 'toggle', 'set-text', 'set-panel-state', 'link', 'navigate',
  ...['dataset', 'repeater'].flatMap(prefix => ['add', 'update', 'delete', 'select', 'toggle-select', 'filter', 'sort', 'page'].map(op => `${prefix}-${op}`))]);

export function normalizeInteractionSpec(spec) {
  if (spec === null) return null;
  if (typeof spec === 'string') return [{ type: 'link', page: spec }];
  if (Array.isArray(spec)) return spec.map(normalizeInteractionSpec).flat();
  if (!spec || typeof spec !== 'object') fail('交互需要动作对象、数组或cases对象', 'on');
  const out = structuredClone(spec);
  if (out.type === 'goto') out.type = 'link';
  if (out.goto !== undefined && !out.type) { out.type = 'link'; out.page = out.goto; delete out.goto; }
  const conditional = ['type','when','if','condition','then','else','actions','cases','break'];
  const dataFields = ['dataset','repeater','op','rowId','clearOthers','row','patch','requireNonEmpty','onEmptyShow','onEmptySelectionShow','query','field','operator','order','page'];
  const knownFields = ({show:['target'],hide:['target'],toggle:['target'],'set-text':['target','value','text'],
    'set-var':['name','variable','value','expr'],'set-variable':['name','variable','value','expr'],
    'set-panel-state':['target','panel','state'],link:['page','to','target'],navigate:['page','to','target']})[out.type]
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
  if (['show', 'hide', 'toggle', 'set-text', 'set-panel-state'].includes(out.type) && !out.target) fail(`${out.type} 缺少target`, 'target');
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
