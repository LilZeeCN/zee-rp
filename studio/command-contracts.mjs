import { validateInput } from './schema-validation.mjs';
import { NODE_READONLY_PROPERTIES,NODE_UNCONSUMED_PROPERTIES,NODE_SYNTAX_ONLY_PROPERTIES } from './node-properties.mjs';
const string = { type: 'string', minLength: 1 }, number = { type: 'number' }, object = { type: 'object' };
const schema = (type, properties, required = []) => ({ type: 'object', properties: { type: { const: type }, pageId: string, ...properties }, required: ['type', ...required], additionalProperties: false });
export const COMMAND_CONTRACTS = {
  recordDesignDecision: schema('recordDesignDecision', {
    decisionId: string,
    scope: {type:'object',properties:{kind:{enum:['project','page','node']},pageId:string,nodeIds:{type:'array',minItems:1,maxItems:32,items:string}},required:['kind'],additionalProperties:false},
    subject: {enum:['brand','direction','typography','palette','material','layout']}, outcome: {enum:['proposed','accepted','rejected']}, choice:string, reason:string,
    feedback: {type:'object',properties:{source:{enum:['user','agent','unknown']},quote:string,evidenceRef:string},required:['source'],additionalProperties:false},
    basedOnRevision:{type:'integer',minimum:1},
    dependsOn:{type:'object',properties:{tokenNames:{type:'array',maxItems:32,items:string},decisionIds:{type:'array',maxItems:32,items:string},sourceTargets:{type:'array',maxItems:32,items:{type:'object',properties:{pageId:string,nodeId:string,properties:{type:'array',minItems:1,items:string}},required:['nodeId'],additionalProperties:false}}},additionalProperties:false},
    supersedes:{type:'array',maxItems:32,items:string},reference:{type:'object',properties:{id:string,version:string},required:['id','version'],additionalProperties:false}
  }, ['decisionId','scope','subject','outcome','choice','reason']),
  addPage: schema('addPage', { id: string, name: string, title: string, domain: string, pageDomain: string, device: { anyOf: [string, { type: 'null' }] }, shell: { enum: ['phone-shell', 'web-page', 'blank'] }, layout: { enum: ['stack', 'free', 'row', 'column', 'grid'] }, padding: {}, gap: number, w: number, h: number, x: number, y: number, root: object, autoUniqueId: { type: 'boolean' } }),
  renamePage: schema('renamePage', { name: string }, ['pageId', 'name']),
  renameNode: schema('renameNode', { nodeId: string, name: string }, ['nodeId', 'name']),
  deleteNode: schema('deleteNode', { nodeId: string, cascade: { type: 'boolean' } }, ['nodeId']),
  setToken: schema('setToken', { name: string, value: {}, category: string }, ['name', 'value']),
  setVariable: schema('setVariable', { name: string, variable: string, value: {} }, ['value']),
  setInteraction: schema('setInteraction', { nodeId: string, event: string,
    actions: { description: '动作、动作数组或 cases 对象。受支持动作词表：show / hide / toggle / set-text / set-var（别名 set-variable）/ set-check / set-selected / set-option / set-panel-state / link（别名 goto，跳页）/ navigate / dataset-add|update|delete|select|toggle-select|filter|sort|page / repeater-*。open-link（打开外部 URL）不受 Studio 运行态支持：提交会被拒绝（E_INTERACTION_ACTION）且不写入，外链交互请走完整原生 RP/1（generate_prototype）。动作字段见 studio_describe 或运行态错误提示。' },
    action: { description: 'actions 的单数别名，二选一；词表与限制同 actions。' } }, ['nodeId']),
  createInstance: schema('createInstance', { parentId: string, componentId: string, component: string, instanceId: string, id: string, name: string, variant: string, state: string, props: object, overrides: object, slots: object, x: number, y: number, w: {}, h: {} }),
  addNode: schema('addNode', { parentId: string, index: { type: 'integer', minimum: 0 }, node: object }, ['node']),
  setProperties: schema('setProperties', { nodeId: string, properties: object, props: object, directInstanceProps: { type: 'boolean' } }, ['nodeId']),
  setText: schema('setText', { nodeId: string, text: { type: 'string' }, spans: { type: 'array', minItems: 1, items: { type: 'object', properties: { text: string, fontFamily: string, fontSize: number, fontWeight: number, letterSpacing: number, color: string, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean' } }, required: ['text'] }, description: '每段富文本 span;提供时 text 自动取拼接结果' }, autoSize: { type: 'boolean', description: '默认 false，只改文字并保留现有几何；显式 true 才按文字测量自动调整 label/button 宽度。' }, fontFamily: string, fontSize: number, fontWeight: number, letterSpacing: number, lineHeight: number, align: string, color: string }, ['nodeId', 'text']),
  moveNode: schema('moveNode', { nodeId: string, x: number, y: number, deltaX: number, deltaY: number, targetIndex: { type: 'integer' } }, ['nodeId']),
  resizeNode: schema('resizeNode', { nodeId: string, w: {}, h: {}, x: number, y: number }, ['nodeId']),
  setLayout: schema('setLayout', { nodeId: string, mode: string, layout: { anyOf: [string, object] }, gap: {}, padding: {}, align: string, justify: string, minW: number, maxW: number, minH: number, maxH: number, w: {}, h: {}, wrap: { type: 'boolean' } }, ['nodeId']),
  editNodes: schema('editNodes', { select: object, operation: { enum: ['set', 'move', 'align', 'place', 'distribute'] }, properties: object, dx: number, dy: number, edge: string, referenceId: string, side: string, gap: number, axis: string }, ['select', 'operation']),
  duplicateNode: schema('duplicateNode', { nodeId: string, newId: string, newName: string, offset: object }, ['nodeId']),
  pasteNodes: schema('pasteNodes', { nodes: { type: 'array', minItems: 1, items: object }, parentId: string, anchorId: string, index: { type: 'integer', minimum: 0 }, offset: object, sourcePageId: string, sourceDocumentId: string }, ['nodes']),
  setInstanceOverride: schema('setInstanceOverride', { nodeId: string, subNodeId: string, targetPath: string, properties: object }, ['nodeId', 'properties']),
  swapInstance: schema('swapInstance', { nodeId: string, componentId: string, preserveOverrides: { type: 'boolean', description: '默认 true;保留新组件树中也存在的子节点 ID 覆盖' } }, ['nodeId', 'componentId']),
};

// M-SURFACE: setText 放宽为 text 与 spans 二选一(required 降为 nodeId)
COMMAND_CONTRACTS.setText = {
  ...COMMAND_CONTRACTS.setText,
  required: COMMAND_CONTRACTS.setText.required.filter(k => k !== 'text'),
  oneOf: [{ required: ['text'] }, { required: ['spans'] }],
};
COMMAND_CONTRACTS['set-props'] = { ...COMMAND_CONTRACTS.setProperties, properties: { ...COMMAND_CONTRACTS.setProperties.properties, type: { const: 'set-props' } } };

export function validateCommandFields(command, commandIndex) {
  const contract = COMMAND_CONTRACTS[command.type];
  if (!contract) throw Object.assign(new Error(`未知命令类型 ${command.type}；可用：${Object.keys(COMMAND_CONTRACTS).join(', ')}`), {code:'E_UNKNOWN_COMMAND_TYPE',commandIndex,candidates:Object.keys(COMMAND_CONTRACTS)});
  const unknown = Object.keys(command).filter(key => !Object.hasOwn(contract.properties, key));
  if (unknown.length) throw Object.assign(new Error(`命令 ${command.type} 不接受字段 ${unknown.join(', ')}；请调用 studio_describe 查看精确参数`), {
    code: 'E_COMMAND_FIELD', field: unknown[0], commandIndex, candidates: Object.keys(contract.properties),
  });
  rejectConflictingAliases(command, commandIndex);
  if(['setProperties','set-props','editNodes','setInstanceOverride','updateComponent'].includes(command.type)){
    const fields=Object.keys(command.properties||command.props||{}),field=fields.find(key=>NODE_READONLY_PROPERTIES.has(key)||NODE_UNCONSUMED_PROPERTIES.has(key));
    if(field)throw Object.assign(new Error(NODE_READONLY_PROPERTIES.has(field)?`${field}是稳定标识或内部源控制信息，不能通过改属性覆盖`:NODE_SYNTAX_ONLY_PROPERTIES.has(field)?`${field}是节点声明语法，不是属性；使用node.type或RP/1片段`:`${field}没有画布/运行态消费；筛选排序请使用repeaterSetFilter/repeaterSetSort`),{code:NODE_READONLY_PROPERTIES.has(field)?'E_READONLY_PROPERTY':'E_UNCONSUMED_PROPERTY',commandIndex,nodeId:command.nodeId,field});
  }
  try { validateInput(contract, command, 'command'); } catch (error) { throw Object.assign(error, {code:'E_COMMAND_VALUE',commandIndex}); }
}

const boolean = { type:'boolean' }, strings = {type:'array',items:string}, nullable = value => ({anyOf:[value,{type:'null'}]}), dimension={anyOf:[{type:'number',exclusiveMinimum:0},{enum:['fill','hug']}]};
const closed = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false});
const sort = closed({field:string,direction:{enum:['asc','desc']}},['field']);
const filter = closed({field:string,equals:{},in:{type:'array',items:{}}},['field']);
const layout = {mode:{enum:['stack','free','row','column','grid']},gap:{},padding:{},align:string,justify:string,minW:number,maxW:number,minH:number,maxH:number,w:dimension,h:dimension,wrap:boolean,columns:{type:'integer',minimum:1},columnGap:{},rowGap:{},equalHeight:boolean};
const brief = closed({brandConstraints:{},device:{},domainId:{},existingComponents:{},filterChips:{},goal:{},heroImageSrc:{},heroMeta:{},heroSummary:{},heroTag:{},heroTitle:{},informationPriority:{},isCustomBrief:{},navSubtitle:{},navTitle:{},pageGoal:{},primaryAction:{},primaryEntity:{},projectName:{},requiredContent:{},searchPlaceholder:{},domain:string,targetTask:string,targetAudience:string,styleTone:{anyOf:[string,strings]},mustKeepModuleIds:strings,candidateDirections:{type:'array',items:{anyOf:[string,object]}}});
Object.assign(COMMAND_CONTRACTS, {
  restoreDocument:schema('restoreDocument',{document:object,expectedContentHash:{type:'string',pattern:'^[a-f0-9]{64}$'},versionId:string,previewHash:{type:'string',pattern:'^[a-f0-9]{64}$'}},['document','expectedContentHash','versionId','previewHash']),
  resizeArtboard:schema('resizeArtboard',{nodeId:string,w:{type:'number',exclusiveMinimum:0},h:{type:'number',exclusiveMinimum:0},x:number,y:number}),
  reorderNode:schema('reorderNode',{nodeId:string,parentId:string,toIndex:{type:'integer',minimum:0},beforeId:string,afterId:string},['nodeId']),
  switchLayoutMode:schema('switchLayoutMode',{nodeId:string,mode:layout.mode,targetLayout:layout.mode,layout:layout.mode},['nodeId']),
  createComponent:schema('createComponent',{componentId:string,id:string,root:object,nodeId:string,name:string,params:object,variants:object,defaultVariant:string,replaceWithInstance:boolean}),
  registerCoreComponents:schema('registerCoreComponents',{componentIds:strings}),
  'upsert-component':schema('upsert-component',{componentId:string,id:string,component:object},['component']),
  evolveComponentContract:schema('evolveComponentContract',{componentId:string,id:string,newVersion:string,version:string,addedParameters:object,addedParams:object,renamedParameters:object,renamedParams:object,removedParameters:strings,removedParams:strings,rootPatch:nullable(object)}),
  updateComponent:schema('updateComponent',{componentId:string,id:string,subNodeId:string,variants:object,properties:object}),
  clearInstanceOverride:schema('clearInstanceOverride',{nodeId:string,subNodeId:string,property:string},['nodeId']),
  setInstanceVariant:schema('setInstanceVariant',{nodeId:string,variant:string},['nodeId','variant']),
  setPanelActiveState:schema('setPanelActiveState',{nodeId:string,stateId:string,state:string,activeState:string},['nodeId']),
  detachInstance:schema('detachInstance',{nodeId:string},['nodeId']),
  detachMacro:schema('detachMacro',{nodeId:string},['nodeId']),
  setTokens:schema('setTokens',{tokens:object,values:object,colors:object}),
  datasetOp:schema('datasetOp',{op:{enum:['add','replace-all','update','delete','filter','sort']},operation:{enum:['add','replace-all','update','delete','filter','sort']},dataset:string,nodeId:string,targetId:string,row:object,item:object,rows:{type:'array',items:object},matchKey:string,matchValue:{},patch:object,filter:nullable(filter),query:nullable(filter),sort:nullable(sort),field:string,direction:{enum:['asc','desc']}}),
  repeaterSetFilter:schema('repeaterSetFilter',{nodeId:string,repeaterId:string,id:string,filter:nullable(filter),field:string,value:{},values:{type:'array',items:{}},clear:boolean}),
  repeaterSetSort:schema('repeaterSetSort',{nodeId:string,repeaterId:string,id:string,sort:nullable(sort),field:string,direction:{enum:['asc','desc']},clear:boolean}),
  setFont:schema('setFont',{nodeId:string,defaultFamily:string,headingFamily:string,addFont:closed({family:string,source:string,path:string,license:string,fallbacks:strings},['family']),fontFamily:string,fontSize:{anyOf:[{type:'number',exclusiveMinimum:0,maximum:120},string]},fontWeight:number,letterSpacing:number,lineHeight:number,italic:boolean,underline:boolean,align:string,color:string}),
  registerAsset:schema('registerAsset',{asset:closed({relativePath:{type:'string',pattern:'^assets/[a-zA-Z0-9_.-]+$'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},width:{type:'number',exclusiveMinimum:0},height:{type:'number',exclusiveMinimum:0},media:closed({recipeHash:string,sourceSha256:string,originalPath:string,recipe:object,credit:{},sourceFormat:nullable(string)},['recipeHash','sourceSha256','originalPath','recipe']),original:object,recipe:object,output:object,source:object,mimeType:string,bytes:number,sourcePath:string,originalPath:string,originalSha256:string,license:string,credits:string,fit:string,focalPoint:object},['relativePath','sha256','width','height'])},['asset']),
  removeInteraction:schema('removeInteraction',{nodeId:string,event:string},['nodeId']),
  duplicatePage:schema('duplicatePage',{newPageId:string,newName:string},['pageId']),
  reorderPages:schema('reorderPages',{pageIds:{type:'array',minItems:1,uniqueItems:true,items:string}},['pageIds']),
  deletePage:schema('deletePage',{force:boolean,cascade:boolean},['pageId']),
  generateExplorations:schema('generateExplorations',{targetPageId:string,designBrief:brief,brief,domain:string,targetTask:string,targetAudience:string,styleTone:{anyOf:[string,strings]},mustKeepModuleIds:strings,candidateDirections:{type:'array',items:{}},directions:{type:'array',items:{}}}),
  selectExploration:schema('selectExploration',{targetPageId:string,explorationPageId:string,explorationId:string,id:string,mode:{enum:['region','full-page']},regionRole:string,regionNodeId:string}),
  editPath:schema('editPath',{nodeId:string,operation:{enum:['set-point','move-point','insert-point','delete-point','set-subpaths','bake-transform','import-svg']},subpathIndex:{type:'integer',minimum:0},pointIndex:{type:'integer',minimum:0},handle:{enum:['anchor','in','out','q']},x:number,y:number,dx:number,dy:number,point:object,points:{},subpaths:{type:'array',items:object},d:string,svg:string,fillRule:{enum:['nonzero','evenodd']},closed:boolean,smooth:boolean,transform:{},bakeTransform:boolean,strokeLinecap:{enum:['butt','round','square']},strokeLinejoin:{enum:['miter','round','bevel']},strokeDasharray:{}},['nodeId']),
  booleanPathOp:schema('booleanPathOp',{op:{enum:['union','subtract','intersect','exclude','xor']},operation:{enum:['union','subtract','intersect','exclude','xor']},nodeIds:{type:'array',minItems:2,maxItems:2,items:string},targetId:string,clipId:string,resultId:string,name:string,keepSources:boolean,allowSelfIntersection:boolean,editable:boolean}),
});
const editProperties={type:'object',minProperties:1,not:{anyOf:[...NODE_READONLY_PROPERTIES,...NODE_UNCONSUMED_PROPERTIES].map(key=>({required:[key]}))}};
COMMAND_CONTRACTS.datasetOp.anyOf=[{required:['dataset']},{required:['nodeId']},{required:['targetId']}];
COMMAND_CONTRACTS.datasetOp.not={anyOf:[{required:['dataset','nodeId']},{required:['dataset','targetId']}]};
for(const name of ['setProperties','set-props','editNodes','setInstanceOverride','updateComponent'])for(const key of ['properties','props'])if(COMMAND_CONTRACTS[name].properties[key])COMMAND_CONTRACTS[name].properties[key]=editProperties;
const aliases={'register-core-components':'registerCoreComponents','upgrade-component-contract':'evolveComponentContract','evolve-component-contract':'evolveComponentContract',resetInstanceOverride:'clearInstanceOverride','set-tokens':'setTokens','set-variable':'setVariable','dataset-op':'datasetOp'};
for(const [alias,name] of Object.entries(aliases)) COMMAND_CONTRACTS[alias]={...COMMAND_CONTRACTS[name],properties:{...COMMAND_CONTRACTS[name].properties,type:{const:alias}}};
COMMAND_CONTRACTS.setLayout.properties.layout={anyOf:[layout.mode,closed({...layout,layout:layout.mode})]};
for(const key of ['columns','columnGap','rowGap','equalHeight'])COMMAND_CONTRACTS.setLayout.properties[key]=layout[key];
COMMAND_CONTRACTS.editNodes.properties.select=closed({pageId:string,nodeIds:{type:'array',minItems:1,uniqueItems:true,items:string},role:string,type:string,textContains:string,within:string});
COMMAND_CONTRACTS.duplicateNode.properties.offset=closed({x:number,y:number});
COMMAND_CONTRACTS.pasteNodes.properties.offset=closed({x:number,y:number});

const commonAliases = [['properties','props'],['name','variable'],['op','operation'],['row','item'],['actions','action'],['tokens','values']];
const commandAliases = {
  createComponent:[['componentId','id']], 'upsert-component':[['componentId','id']], updateComponent:[['componentId','id']],
  evolveComponentContract:[['componentId','id'],['newVersion','version'],['addedParameters','addedParams'],['renamedParameters','renamedParams'],['removedParameters','removedParams']],
  createInstance:[['componentId','component'],['instanceId','id']],
  switchLayoutMode:[['mode','targetLayout','layout']], setPanelActiveState:[['stateId','state','activeState']],
  datasetOp:[['nodeId','targetId'],['filter','query']], repeaterSetFilter:[['nodeId','repeaterId','id']], repeaterSetSort:[['nodeId','repeaterId','id']],
  generateExplorations:[['pageId','targetPageId'],['designBrief','brief'],['candidateDirections','directions']],
  selectExploration:[['pageId','targetPageId'],['explorationPageId','explorationId','id']],
};
function rejectConflictingAliases(command,commandIndex) {
 const name=aliases[command.type]||command.type;
 for(const fields of [...commonAliases,...(commandAliases[name]||[])]){const present=fields.filter(key=>Object.hasOwn(COMMAND_CONTRACTS[command.type].properties,key)&&command[key]!==undefined);if(present.length>1&&present.some(key=>JSON.stringify(command[key])!==JSON.stringify(command[present[0]]))) throw Object.assign(new Error(`命令 ${command.type} 的别名 ${present.join('/')} 互相冲突；请仅提供一种形式`),{code:'E_COMMAND_ALIAS_CONFLICT',commandIndex,field:present[1]});}
}
