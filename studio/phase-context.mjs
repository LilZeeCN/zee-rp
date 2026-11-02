import { buildNodeIndex } from './document.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import { queryAuthoringNodes } from './authoring-query.mjs';
import { getDesignGuidance } from './design-guidance.mjs';
import { getDesignDecisions } from './design-decisions.mjs';
import { listReferencePacks, getReferencePack } from './reference-packs.mjs';
import { COMMAND_CONTRACTS } from './command-contracts.mjs';
import { getDesignCraft } from './design-craft.mjs';

export const DESIGN_STAGES = ['planning', 'skeleton', 'content', 'refine', 'review', 'edit'];
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const phaseRules = {
  planning: ['明确用户任务、必备内容、主要操作与必要状态；参考作品不能自动变成用户要求。', '未定方向时先比较主角和阅读顺序，再选择材料、字形与布局；已有有效方向则继续深化。'],
  skeleton: ['先安排区域职责、主次、内容宽度和动作位置，再填完整文案。', 'row/column/grid使用顺序、gap和hug/fill；源坐标不是截图坐标。'],
  content: ['填入真实完整内容，长正文使用内容驱动高度；不要用摘要替换原文。', '补齐空、错、长内容及两分支反馈；不靠隐藏必要信息完成构图。'],
  refine: ['保留既有内容、交互和有效设计决定，精修字形、留白、材质与对齐。', '先看图明确问题，再修改可写的源目标；宏和实例使用对应入口。'],
  review: ['检查当前版本的真实截图及必要交互态，明确设计问题和下一次修改。', '语义剧本、浏览器指针、原生结构、Axure宿主与用户审美判断分别记录。'],
  edit: ['直接按局部目标修改，不重新规划整页，不更换整套字体或色板。', '完整原文和控制关系必须保留；截图坐标和240字摘要不能当作可回写源。'],
};

function briefValue(value) {
  if (value === undefined) return { task: '', content: [], states: [], constraints: [], source: 'not-provided' };
  if (typeof value === 'string') value = { task: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('E_DESIGN_BRIEF', 'brief需要任务文本或task/content/states/constraints对象');
  for (const key of Object.keys(value)) if (!['task', 'content', 'states', 'constraints'].includes(key)) fail('E_DESIGN_BRIEF', `brief不支持字段${key}`);
  if (value.task !== undefined && (typeof value.task !== 'string' || value.task.length > 4000)) fail('E_DESIGN_BRIEF', 'brief.task需要最多4000字符的任务文本');
  for (const key of ['content', 'states', 'constraints']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 32 || value[key].some(item => typeof item !== 'string' || !item || item.length > 2000))) fail('E_DESIGN_BRIEF', `brief.${key}需要最多32条非空文本`);
  return { task: value.task || '', content: value.content || [], states: value.states || [], constraints: value.constraints || [], source: 'caller-provided' };
}

function selectedTarget(doc, scene, target, stage) {
  if (!target) {
    if (stage === 'edit') fail('E_DESIGN_TARGET', 'edit需要明确target；没有选择不会扩大成整页');
    return { scope: { kind: 'project' }, selection: null };
  }
  for (const key of Object.keys(target)) if (!['pageId','documentId','revision','contentHash','nodeIds','role','within','textContains'].includes(key)) fail('E_DESIGN_TARGET', `target不支持字段${key}`);
  if (!target.pageId || !doc.pages.some(page => page.id === target.pageId)) fail('E_DESIGN_TARGET', `工程页面不存在：${target.pageId}`);
  if (target.documentId !== undefined && target.documentId !== doc.documentId) fail('E_DESIGN_TARGET_DOCUMENT', '选区属于其他工程');
  const specific = ['nodeIds', 'role', 'within', 'textContains'].some(key => target[key] !== undefined);
  if (specific && target.revision === undefined) fail('E_DESIGN_TARGET_VERSION', '局部选区需要target.revision，不能把未绑定版本的旧选择解释为当前目标');
  if (target.revision !== undefined && target.revision !== doc.revision || target.contentHash !== undefined && target.contentHash !== doc.contentHash) fail('E_DESIGN_TARGET_STALE', '选区版本已变化，请重新查询目标；范围未扩大');
  const page = doc.pages.find(page => page.id === target.pageId);
  const args = { pageId: target.pageId, limit: 8 };
  for (const key of ['nodeIds', 'role', 'within', 'textContains']) if (target[key] !== undefined) args[key] = target[key];
  if (!specific) args.nodeId = page.root.id;
  const query = queryAuthoringNodes({ doc, scene, args });
  const insertion = !specific && page.root.type === 'phone-shell' && page.root.children?.length === 1 ? page.root.children[0] : page.root;
  // Suggested edits contain complete authored values even when the display text is a summary.
  if (stage === 'edit') for (const node of query.nodes) if (node.textTruncated) {
    const field = node.suggestedEdit?.editableFields?.[0];
    const full = node.suggestedEdit?.command?.properties?.[field];
    if (typeof full === 'string') {node.text=full;node.textTruncated=false;node.displayTextWasSummary=true;}
    else node.requiresFullSource=true;
  }
  const index = buildNodeIndex(doc);
  const authoredIds = [...new Set(query.nodes.map(node => node.target?.nodeId).filter(id => index.byScopedId.has(id)))];
  const scope = specific && authoredIds.length ? { kind: 'node', pageId: page.id, nodeIds: authoredIds } : { kind: 'page', pageId: page.id };
  return { scope, selection: { ...query, page: { id: page.id, name: page.name, rootId: page.root.id, insertionParentId: `${page.id}/${insertion.id}`, insertionPadding: insertion.padding ?? 0, canvas: page.canvas },
    scopeIsExplicit: specific, sourceScopeAvailable: !specific || authoredIds.length > 0,
    complete: !specific || query.total === query.returned,
    note: '目标来自当前权威源；textTruncated仍为true时，不能拿显示摘要重写全文。' } };
}

export function getPhaseContext(args, { doc, scene = null, selections = null } = {}) {
  for (const key of Object.keys(args)) if (!['stage','intent','platform','maxBytes','brief','target','referencePackId','referencePageId','includeSource','includeImages','guideId','pageId','projectDir','url','port'].includes(key)) fail('E_DESIGN_CONTEXT_FIELD', `阶段入口不支持字段${key}`);
  if (!doc) fail('E_DESIGN_DOCUMENT', '阶段上下文需要已打开的权威工程');
  const { stage = 'planning', intent = 'learning', platform = 'mobile', maxBytes = 12000 } = args;
  if (!DESIGN_STAGES.includes(stage)) fail('E_DESIGN_STAGE', `stage应为${DESIGN_STAGES.join('/')}`);
  if (!Number.isInteger(maxBytes) || maxBytes < 4000 || maxBytes > 48000) fail('E_DESIGN_BUDGET', 'maxBytes需要4000–48000的文字JSON预算，图片体积单独报告');
  if (args.pageId !== undefined) fail('E_DESIGN_REFERENCE_PAGE', '旧pageId表示栖羽参考页；阶段入口用referencePageId选参考页、target.pageId选工程页');
  if (!['learning','task','editorial'].includes(intent)) fail('E_DESIGN_INTENT', 'intent应为learning/task/editorial');
  const brief = briefValue(args.brief);
  const guidance = getDesignGuidance({ intent, platform, guideId: args.guideId });
  const catalog = listReferencePacks();
  const currentScene=scene || resolveDocumentScene(doc);
  let sharedSelection=null;
  if(args.target?.selection!==undefined){
    if(args.target.selection!=='active'||Object.keys(args.target).some(key=>!['selection','clientId','selectionId'].includes(key)))fail('E_DESIGN_TARGET','active选择不能与页面或筛选条件混用');
    if(!selections)fail('E_SELECTION_UNAVAILABLE','当前入口没有连接画布选区');
    sharedSelection=selections.resolve(doc,currentScene,args.target);
  }
  const target = selectedTarget(doc,currentScene,sharedSelection?.target || args.target,stage);
  const decisions = getDesignDecisions(doc, { scope: target.scope, referenceVersions: Object.fromEntries(catalog.map(pack => [pack.id, pack.version])) });
  const rejected = new Set(decisions.rejected.map(record => record.reference?.id).filter(Boolean));
  const preferred = decisions.effective.map(record => record.reference?.id).find(id => catalog.some(pack => pack.id === id && pack.intent === intent && pack.platform === platform));
  const eligible = catalog.filter(pack => pack.intent === intent && pack.platform === platform && !rejected.has(pack.id));
  const defaultId = {'learning:mobile':'deep-recall-mobile','task:web':'materials-desk-web','editorial:web':'shore-notes-web'}[`${intent}:${platform}`];
  const selectedId = args.referencePackId || (stage !== 'edit' ? preferred || eligible.find(pack => pack.id === defaultId)?.id || eligible[0]?.id : null);
  const reference = selectedId ? getReferencePack(selectedId, { pageId: args.referencePageId, includeSource: args.includeSource === true, includeImages: args.includeImages === true }) : null;
  if (reference && reference.platform !== platform) fail('E_REFERENCE_PLATFORM', `参考包${selectedId}适用于${reference.platform}，请求为${platform}`);
  const { mcpImages, ...referenceData } = reference || {};
  const contract = stage === 'edit' ? COMMAND_CONTRACTS.setProperties : { syntax: 'rp1/sourceMode 与commands二选一',
    required: ['baseRevision', 'idempotencyKey', 'pageId'], modes: ['insert', 'update'], rule: '片段每个节点写稳定#ID；update只改显式字段，不推断删除。' };
  const selection = target.selection;
  const payload = { ok: true, ready: !decisions.conflicts.length && (!selection || !selection.empty && selection.complete && selection.sourceScopeAvailable && !selection.nodes.some(node=>node.requiresFullSource || stage === 'edit' && !node.target?.editable)),
    binding: { documentId: doc.documentId, revision: doc.revision, contentHash: doc.contentHash, scope: target.scope, ...(sharedSelection?{selectionId:sharedSelection.selectionId}:{}) },
    stage: { current: stage, reason: '调用者明确选择的知识视角；不会自动写稿或强制重走全流程', rules: phaseRules[stage] },
    intent, platform, brief, target: selection, decisions,
    ...(stage !== 'edit' ? {craft:getDesignCraft({stage,platform,decisions})} : {}),
    guidance: stage === 'edit' ? null : { id: guidance.guide.id, name: guidance.guide.name,
      composition: guidance.guide.composition, states: guidance.guide.states,
      ...(stage === 'refine' ? { typography: guidance.guide.typography, palette: guidance.guide.palette, spacing: guidance.guide.spacing } : {}),
      provenance: guidance.provenance },
    referencePack: reference ? { ...referenceData, selectionReason: args.referencePackId ? '调用者显式指定' : preferred ? '匹配工程内有效决定及任务平台' : '匹配任务与平台的候选参考',
      ...(rejected.has(selectedId) ? { warning: '该参考已被本工程拒绝；显式读取仅供比较，不作为默认采用依据。' } : {}) } : null,
    availableReferencePacks: (stage === 'edit' ? [] : catalog).map(pack => ({ id: pack.id, name: pack.name, intent: pack.intent, platform: pack.platform, version: pack.version,
      eligible: pack.intent === intent && pack.platform === platform && !rejected.has(pack.id) })),
    authoring: { tool: 'studio_apply_commands', contract, ...(stage !== 'edit' ? {decisionContract: COMMAND_CONTRACTS.recordDesignDecision} : {}),
      nextCall: stage === 'edit' ? {tool:'studio_apply_commands',arguments:{baseRevision:doc.revision,idempotencyKey:'填写本次唯一修改ID',...(sharedSelection?{selectionId:sharedSelection.selectionId}:{})},note:'commands取自target.nodes的suggestedEdit.command；仅替换意图修改的字段。此处只给公共参数，不重复返回完整正文。'} : {tool:'studio_apply_commands',arguments:{baseRevision:doc.revision,idempotencyKey:'填写本次唯一修改ID',pageId:selection?.page.id,parentId:selection?.page.insertionParentId,sourceMode:'insert'},note:'用rp1添加有明确稳定ID的区域；复用已有工程/页面，不根据参考图坐标回写。'},
      next: '用binding.revision提交同一事务；局部目标沿用target.nodes.suggestedEdit，只替换意图修改的值。设计决定命令与视觉修改可在同批提交。' },
    checks: stage === 'review' ? ['studio_review_design看当前图片', 'studio_run_scenario隔离语义断言', 'studio_design_explore.states浏览器指针', 'studio_export_rp兼容报告与原生核对'] : [],
    budget: { maxBytes, textBytes: 0, imageBytes: (mcpImages || []).reduce((total, item) => total + Buffer.byteLength(item.data, 'base64'), 0), omitted: [] } };
  if(!payload.ready){delete payload.authoring.nextCall;payload.blockers={decisionConflicts:decisions.conflicts.length,empty:selection?.empty||false,incomplete:selection? !selection.complete:false,unwritable:selection?.nodes.filter(node=>!node.target?.editable||node.requiresFullSource).map(node=>node.scopedId)||[]};}
  const omit = (section, reason) => payload.budget.omitted.push({ section, reason, retrieveWith: { stage, maxBytes: 48000, ...(args.referencePackId ? { referencePackId: args.referencePackId } : {}) } });
  if (bytes(payload) > maxBytes && payload.referencePack?.pageSource) { delete payload.referencePack.pageSource; omit('referencePack.pageSource', '完整示例源超过文字预算；源文件路径仍保留，不返回假完整片段'); }
  if (bytes(payload) > maxBytes && payload.referencePack?.design) { delete payload.referencePack.design; omit('referencePack.design', '优先保留当前目标、用户约束与写入契约'); }
  if (bytes(payload) > maxBytes && payload.decisions.excluded.length) { payload.decisions.excluded = payload.decisions.excluded.map(record => ({ id: record.id, scope: record.scope, applicability: record.applicability })); omit('decisions.excluded.details', '过期记录保留ID与排除原因，详细原话按需读取'); }
  if (bytes(payload) > maxBytes) {
    payload.ready = false;
    payload.code = 'E_DESIGN_CONTEXT_BUDGET';
    payload.message = '关键目标、有效约束与契约无法完整放入当前预算；未截断后伪称可安全提交，请缩小目标或增加预算。';
    const requiredTextBytes = bytes(payload);
    return { ok:true, ready:false, code:payload.code, message:payload.message, binding:payload.binding,
      targetSummary: selection ? {pageId:selection.pageId,total:selection.total,returned:selection.returned,nodeIds:selection.nodes.map(node=>node.scopedId)} : null,
      decisionSummary:{total:decisions.total,conflicts:decisions.conflicts.map(item=>({subject:item.subject,decisionIds:item.decisionIds}))},
      budget:{maxBytes,requiredTextBytes,imageBytes:0,omitted:[{section:'authoring payload',reason:'关键数据不能完整放入预算；没有生成可直接提交的截断建议'}]},
      next:{tool:'studio_get_design_context',arguments:{stage,intent,platform,maxBytes:48000,includeImages:false,...(args.target?{target:args.target}:{})},note:'重发原brief且保留全部硬约束；可缩小明确的目标，或用studio_query_nodes(full)读取完整源值。不要把摘要写回。'} };
  }
  // Include the final byte counter itself in the reported JSON size.
  for (let i = 0; i < 4; i++) payload.budget.textBytes = bytes(payload);
  return { ...payload, ...(mcpImages?.length ? { mcpImages } : {}) };
}
