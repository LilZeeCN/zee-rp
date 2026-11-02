import { buildNodeIndex, canonicalJson, sha256 } from './document.mjs';
import { NODE_PROPERTY_NAMES } from './node-properties.mjs';

export const DECISION_SUBJECTS = ['brand', 'direction', 'typography', 'palette', 'material', 'layout'];
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const string = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('E_DESIGN_DECISION', `${name}需要1–${max}字符`, { field: name });
  return value.trim();
};
const fields = (value, allowed, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('E_DESIGN_DECISION', `${name}需要对象`);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) fail('E_DESIGN_DECISION', `${name}不支持字段${unknown}`, { field: unknown });
};

function sourceNode(doc, pageId, id) {
  const index = buildNodeIndex(doc);
  const exact = index.byScopedId.get(id);
  const matches = exact ? [exact] : [...new Set(index.byScopedId.values())].filter(item => item.pageId === pageId && item.id === id);
  if (matches.length !== 1 || pageId !== undefined && matches[0].pageId !== pageId) fail('E_DESIGN_SCOPE', `源节点不存在、重名或属于其他页：${id}；请使用query返回的可编辑源ID`);
  return matches[0];
}

export function normalizeDesignScope(doc, scope = { kind: 'project' }) {
  fields(scope, ['kind', 'pageId', 'nodeIds'], 'scope');
  if (!['project', 'page', 'node'].includes(scope.kind)) fail('E_DESIGN_SCOPE', 'scope.kind应为project/page/node');
  if (scope.kind === 'project') {
    if (scope.pageId !== undefined || scope.nodeIds !== undefined) fail('E_DESIGN_SCOPE', 'project范围不能同时声明页面或节点');
    return { kind: 'project' };
  }
  if (!doc.pages.some(page => page.id === scope.pageId)) fail('E_DESIGN_SCOPE', `页面不存在：${scope.pageId}`);
  if (scope.kind === 'page') {
    if (scope.nodeIds !== undefined) fail('E_DESIGN_SCOPE', '页面范围不声明nodeIds；局部范围使用kind:node');
    return { kind: 'page', pageId: scope.pageId };
  }
  if (!Array.isArray(scope.nodeIds) || !scope.nodeIds.length || scope.nodeIds.length > 32) fail('E_DESIGN_SCOPE', 'node范围需要1–32个明确源节点，空范围不能扩大到整页');
  const nodeIds = [...new Set(scope.nodeIds.map(id => sourceNode(doc, scope.pageId, string(id, 'nodeId')).scopedId))].sort();
  return { kind: 'node', pageId: scope.pageId, nodeIds };
}

function tokenValue(doc, path) {
  const keys = path.replace(/^\$/, '').split('.');
  const direct = keys.reduce((value, key) => value?.[key], doc.tokens);
  return direct ?? (keys.length === 1 ? doc.tokens?.colors?.[keys[0]] ?? doc.palette?.[keys[0]] : null);
}

function dependencyValue(doc, record) {
  const scope = normalizeDesignScope(doc, record.scope);
  const explicit = record.dependsOn && (record.dependsOn.tokenNames?.length || record.dependsOn.sourceTargets?.length);
  if (explicit) return {
    tokens: Object.fromEntries((record.dependsOn.tokenNames || []).map(name => [name, tokenValue(doc, name)])),
    nodes: (record.dependsOn.sourceTargets || []).map(target => {
      const node = sourceNode(doc, target.pageId || scope.pageId, target.nodeId).node;
      return target.properties ? Object.fromEntries(target.properties.map(key => [key, node[key] ?? null])) : node;
    }),
  };
  const brand = { theme: doc.theme ?? null, palette: doc.palette ?? {}, tokens: doc.tokens ?? {}, fonts: doc.fonts ?? {} };
  if (scope.kind === 'project' && ['brand', 'palette', 'typography'].includes(record.subject)) return brand;
  const source = scope.kind === 'project' ? doc.pages : scope.kind === 'page'
    ? doc.pages.find(page => page.id === scope.pageId).root
    : scope.nodeIds.map(id => sourceNode(doc, scope.pageId, id).node);
  return { brand, source, components: doc.components || {}, assets: doc.assetsManifest || {} };
}

const dependencyHash = (doc, record) => sha256(canonicalJson(dependencyValue(doc, record)));

export function recordDesignDecision(doc, command) {
  const id = string(command.decisionId, 'decisionId', 120);
  if ((doc.designDecisions || []).some(record => record.id === id)) fail('E_DESIGN_DECISION_ID', `决定ID已存在：${id}；更正请用新ID并声明supersedes`);
  if (!DECISION_SUBJECTS.includes(command.subject)) fail('E_DESIGN_DECISION', `subject应为${DECISION_SUBJECTS.join('/')}`);
  if (!['proposed', 'accepted', 'rejected'].includes(command.outcome)) fail('E_DESIGN_DECISION', 'outcome应为proposed/accepted/rejected');
  if (command.basedOnRevision !== undefined && command.basedOnRevision !== doc.revision) fail('E_DESIGN_DECISION_STALE', '决定所依据的版本已变化，请读取当前上下文；未写入');
  if (!command.scope) fail('E_DESIGN_SCOPE', '记录决定必须明确scope，不会把缺少的范围扩大到工程');
  const scope = normalizeDesignScope(doc, command.scope);
  const source = command.feedback || { source: 'unknown' };
  fields(source, ['source', 'quote', 'evidenceRef'], 'feedback');
  if (!['user', 'agent', 'unknown'].includes(source.source)) fail('E_DESIGN_DECISION', 'feedback.source应为user/agent/unknown');
  if (source.source === 'user' && (typeof source.quote !== 'string' || !source.quote.trim() || typeof source.evidenceRef !== 'string' || !source.evidenceRef.trim())) fail('E_DESIGN_FEEDBACK_EVIDENCE', '代录用户反馈需要原话quote和出处evidenceRef；没有出处请用unknown');
  if (source.quote !== undefined) string(source.quote, 'feedback.quote', 4000);
  if (source.evidenceRef !== undefined) string(source.evidenceRef, 'feedback.evidenceRef', 2000);
  const supersedes = command.supersedes || [];
  if (!Array.isArray(supersedes) || supersedes.length > 32 || new Set(supersedes).size !== supersedes.length) fail('E_DESIGN_DECISION', 'supersedes需要不重复的决定ID数组，最多32项');
  for (const priorId of supersedes) {
    const prior = (doc.designDecisions || []).find(record => record.id === priorId);
    if (!prior || prior.subject !== command.subject || canonicalJson(prior.scope) !== canonicalJson(scope)) fail('E_DESIGN_SUPERSEDES', '只能显式替代同一范围、同一subject的已有决定');
    if (prior.feedback.source === 'user' && source.source !== 'user') fail('E_DESIGN_DECISION_AUTHORITY', '代理或未知反馈不能替代已有用户约束；请保留冲突并定位原始反馈');
  }
  const dependsOn = structuredClone(command.dependsOn || {});
  fields(dependsOn, ['tokenNames', 'sourceTargets', 'decisionIds'], 'dependsOn');
  for (const key of ['tokenNames', 'sourceTargets', 'decisionIds']) if (dependsOn[key] !== undefined && (!Array.isArray(dependsOn[key]) || dependsOn[key].length > 32)) fail('E_DESIGN_DECISION', `dependsOn.${key}需要最多32项的数组`);
  for (const name of dependsOn.tokenNames || []) string(name, 'tokenName', 200);
  for (const priorId of dependsOn.decisionIds || []) if (!(doc.designDecisions || []).some(record => record.id === priorId)) fail('E_DESIGN_DEPENDENCY', `依赖决定不存在：${priorId}`);
  for (const target of dependsOn.sourceTargets || []) {
    fields(target, ['pageId', 'nodeId', 'properties'], 'sourceTarget');
    const pageId = target.pageId || scope.pageId;
    sourceNode(doc, pageId, string(target.nodeId, 'sourceTarget.nodeId'));
    if (target.properties !== undefined && (!Array.isArray(target.properties) || !target.properties.length || target.properties.some(key => !NODE_PROPERTY_NAMES.has(key)))) fail('E_DESIGN_DEPENDENCY', '依赖属性必须是非空的已知作者属性名数组');
  }
  if (command.reference) {
    fields(command.reference, ['id', 'version'], 'reference');
    string(command.reference.id, 'reference.id'); string(command.reference.version, 'reference.version');
  }
  const record = { id, scope, subject: command.subject, outcome: command.outcome,
    choice: string(command.choice, 'choice'), reason: string(command.reason, 'reason', 4000),
    feedback: structuredClone(source), userAccepted: false,
    provenanceNote: 'feedback是调用者声明的反馈来源；不等于用户认可当前画面，事务执行者另见历史。',
    observedRevision: command.basedOnRevision ?? doc.revision, recordedRevision: doc.revision + 1,
    dependsOn, supersedes: [...supersedes], ...(command.reference ? { reference: structuredClone(command.reference) } : {}) };
  record.basisHash = dependencyHash(doc, record);
  (doc.designDecisions ||= []).push(record);
  return scope.kind === 'node' ? scope.nodeIds : scope.kind === 'page' ? [scope.pageId] : [];
}

export function finalizeDesignDecisions(doc) {
  for (const record of doc.designDecisions || []) if (record.recordedRevision === doc.revision + 1) record.basisHash = dependencyHash(doc, record);
}

function relevant(record, scope) {
  if (record.scope.kind === 'project') return true;
  if (scope.kind === 'project' || record.scope.pageId !== scope.pageId) return false;
  return scope.kind === 'page' || record.scope.kind === 'page' || record.scope.nodeIds.some(id => scope.nodeIds.includes(id));
}

export function getDesignDecisions(doc, { scope = { kind: 'project' }, referenceVersions = {} } = {}) {
  scope = normalizeDesignScope(doc, scope);
  const records = doc.designDecisions || [], statuses = new Map();
  const superseded = new Set(records.flatMap(record => record.supersedes || []));
  const inspect = record => {
    if (statuses.has(record.id)) return statuses.get(record.id);
    let state = 'effective', reason = '范围及相关依赖仍匹配';
    if (superseded.has(record.id)) { state = 'superseded'; reason = '已被显式新决定取代，原始反馈保留'; }
    else {
      try {
        if (dependencyHash(doc, record) !== record.basisHash) { state = 'stale'; reason = '相关品牌、源属性、字体或资源已变化'; }
      } catch { state = 'orphaned'; reason = '依赖的页面或源节点已不存在'; }
      if (state === 'effective' && record.reference && referenceVersions[record.reference.id] !== record.reference.version) { state = 'stale'; reason = '引用的参考包版本已变化或不可用'; }
      if (state === 'effective') for (const id of record.dependsOn?.decisionIds || []) {
        const prior = records.find(item => item.id === id);
        if (!prior || inspect(prior).state !== 'effective' || prior.outcome !== 'accepted') { state = 'stale'; reason = `依赖决定${id}已失效或未接受`; break; }
      }
    }
    const value = { ...structuredClone(record), applicability: { state, reason } };
    statuses.set(record.id, value); return value;
  };
  const selected = records.filter(record => relevant(record, scope)).map(inspect);
  const active = selected.filter(record => record.applicability.state === 'effective');
  const conflicts = [];
  const accepted = active.filter(record => record.outcome === 'accepted');
  for (let i = 0; i < accepted.length; i++) for (let j = i + 1; j < accepted.length; j++) {
    const a = accepted[i], b = accepted[j];
    if (a.subject === b.subject && a.choice !== b.choice && (relevant(a, b.scope) || relevant(b, a.scope))) conflicts.push({ subject: a.subject, decisionIds: [a.id, b.id], reason: '相关范围存在不同的已接受选择；未自动覆盖或推断等价' });
  }
  const conflicted = new Set(conflicts.flatMap(item => item.decisionIds));
  return { scope, total: selected.length,
    effective: active.filter(record => record.outcome === 'accepted' && !conflicted.has(record.id)),
    rejected: active.filter(record => record.outcome === 'rejected'), proposed: active.filter(record => record.outcome === 'proposed'),
    excluded: selected.filter(record => record.applicability.state !== 'effective'), conflicts,
    provenance: '工程内声明的设计决定；没有将代理接受、机器通过或恢复操作记为用户视觉认可。' };
}
