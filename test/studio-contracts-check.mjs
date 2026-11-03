import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {StudioDocumentStore,VALID_COMMAND_TYPES} from '../studio/commands.mjs';
import {COMMAND_CONTRACTS} from '../studio/command-contracts.mjs';
import {validateInput} from '../studio/schema-validation.mjs';
import {describeAuthoring} from '../studio/authoring-help.mjs';
import {StudioRuntimeSession} from '../studio/runtime.mjs';
import {NODE_READONLY_PROPERTIES,NODE_UNCONSUMED_PROPERTIES} from '../studio/node-properties.mjs';
import {resolveDocumentScene} from '../studio/scene-resolver.mjs';
const apply=(store,commands)=>store.applyTransaction({baseRevision:store.appliedRevision,commands});
const seed=()=>{const s=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));assert(apply(s,[{type:'addNode',node:{id:'title',type:'label',text:'Keep me',w:280,h:48}},{type:'addNode',node:{id:'rows',type:'repeater',w:300,h:200,rows:[{status:'ready',value:2},{status:'borrowed',value:1}],template:{id:'row',type:'label',text:'Row',w:300,h:30}}}]).ok);return s;};

test('stable identity and internal control fields cannot be changed through property aliases or batch edits',()=>{
 for(const key of [...NODE_READONLY_PROPERTIES,...NODE_UNCONSUMED_PROPERTIES])for(const type of ['setProperties','set-props','editNodes']){
  const s=seed(),hash=s.doc.contentHash,revision=s.appliedRevision,properties={[key]:'unexpected'};
  const command=type==='editNodes'?{type,operation:'set',select:{nodeIds:['title']},properties}:{type,nodeId:'title',properties};
  const result=apply(s,[{type:'setText',nodeId:'title',text:'Must roll back'},command]);assert(!result.ok,JSON.stringify(command));assert.equal(s.doc.contentHash,hash);assert.equal(s.appliedRevision,revision);
  assert.throws(()=>validateInput(COMMAND_CONTRACTS[type],command));
 }
 const help=describeAuthoring({topic:'node'});assert(!help.writableFields.includes('id'));assert(help.readOnlyFields.includes('id'));assert(!help.writableFields.includes('activeFilter'));
});

test('empty edits reject while new empty containers and ordinary visual edits remain valid',()=>{
 const s=seed();const hash=s.doc.contentHash;assert(!apply(s,[{type:'setProperties',nodeId:'title',properties:{}}]).ok);assert.equal(s.doc.contentHash,hash);
 assert(apply(s,[{type:'addNode',node:{type:'box',id:'new_container'}},{type:'setProperties',nodeId:'title',properties:{fontSize:32}}]).ok);
});

test('component overrides cannot smuggle a changed identity through a nested property map',()=>{
 const s=seed();assert(apply(s,[{type:'createComponent',componentId:'caption',root:{type:'label',id:'caption_root',text:'Caption',w:160,h:40}},{type:'createInstance',componentId:'caption',instanceId:'caption_instance'}]).ok);
 const hash=s.doc.contentHash;
 for(const command of [{type:'setInstanceOverride',nodeId:'caption_instance',subNodeId:'$root',properties:{id:'hijacked'}},{type:'setProperties',nodeId:'caption_instance',properties:{overrides:{$root:{id:'hijacked'}}}},{type:'updateComponent',componentId:'caption',properties:{type:'input'}}]){assert(!apply(s,[command]).ok);assert.equal(s.doc.contentHash,hash);}
 assert(apply(s,[{type:'setInstanceOverride',nodeId:'caption_instance',properties:{color:'#334455'}}]).ok);
});

test('node dataset operations change the rows actually consumed by layout and runtime, including shared data',()=>{
 const s=seed(),count=()=>resolveDocumentScene(s.doc).pages[0].nodes.find(n=>n.id==='rows').rows.length;
 assert.equal(count(),2);assert(apply(s,[{type:'datasetOp',nodeId:'rows',op:'add',row:{id:'new',status:'ready',value:3}}]).ok);assert.equal(count(),3);
 let runtime=new StudioRuntimeSession(s.doc);assert.equal(runtime.getVisibleDatasetRows('rows').length,3);
 assert(apply(s,[{type:'datasetOp',nodeId:'rows',op:'update',matchKey:'id',matchValue:'new',patch:{value:9}},{type:'datasetOp',nodeId:'rows',op:'sort',field:'value',direction:'desc'}]).ok);
 assert.equal(resolveDocumentScene(s.doc).pages[0].nodes.find(n=>n.id==='rows').rows[0].value,9);
 assert(apply(s,[{type:'datasetOp',nodeId:'rows',op:'delete',matchKey:'id',matchValue:'new'}]).ok);assert.equal(count(),2);s.undo();assert.equal(count(),3);s.redo();assert.equal(count(),2);
 assert(apply(s,[{type:'datasetOp',dataset:'shared',op:'replace-all',rows:[{id:'shared-a',status:'ready',value:7}]},{type:'setProperties',nodeId:'rows',properties:{dataset:'shared'}}]).ok);
 assert(apply(s,[{type:'dataset-op',targetId:'rows',op:'add',row:{id:'shared-b',status:'ready',value:8}}]).ok);assert.equal(s.doc.datasets.shared.rows.length,2);runtime=new StudioRuntimeSession(s.doc);assert.equal(runtime.getVisibleDatasetRows('shared').length,2);assert.equal(count(),2);
 const hash=s.doc.contentHash;assert(!apply(s,[{type:'datasetOp',nodeId:'title',op:'add',row:{x:1}}]).ok);assert.equal(s.doc.contentHash,hash);assert(!apply(s,[{type:'datasetOp',dataset:'shared',nodeId:'rows',op:'add',row:{x:1}}]).ok);assert.equal(s.doc.contentHash,hash);
 assert(apply(s,[{type:'addNode',node:{type:'repeater',id:'by_source',source:'local_source',rows:[{id:'source-a'}],w:300,h:200,template:{id:'source_row',type:'label',text:'Source',w:280,h:40}}},{type:'datasetOp',nodeId:'by_source',op:'add',row:{id:'source-b'}}]).ok);assert.equal(new StudioRuntimeSession(s.doc).getVisibleDatasetRows('local_source').length,2);
});

test('repeater views use numeric order, source filters and runtime rows consistently with hug geometry',()=>{
 const s=seed();assert(apply(s,[{type:'datasetOp',nodeId:'rows',op:'replace-all',rows:[{id:'a',status:'ready',value:2},{id:'b',status:'ready',value:10},{id:'c',status:'borrowed',value:1}]},{type:'setProperties',nodeId:'rows',properties:{h:'hug',rowHeight:40,rowGap:0}},{type:'repeaterSetSort',nodeId:'rows',sort:{field:'value',direction:'asc'}},{type:'repeaterSetFilter',nodeId:'rows',filter:{field:'status',equals:'ready'}}]).ok);
 let scene=resolveDocumentScene(s.doc),node=scene.pages[0].nodes.find(n=>n.id==='rows');assert.deepEqual(node.rows.map(row=>row.value),[2,10]);assert.equal(node.h,80);
 const runtime=new StudioRuntimeSession(s.doc);let state=runtime.getState();node=state.activePageScene.nodes.find(n=>n.id==='rows');assert.deepEqual(node.rows.map(row=>row.value),[2,10]);assert(node.rowViewResolved);assert.equal(node.h,80);
 const hash=s.doc.contentHash;const scenario=runtime.runScenario([{action:'dataset',dataset:'rows',op:'add',row:{id:'d',status:'ready',value:3},expect:{datasetCount:{rows:4}}}]);assert(scenario.ok,JSON.stringify(scenario));state=runtime.getState();node=state.activePageScene.nodes.find(n=>n.id==='rows');assert.deepEqual(node.rows.map(row=>row.value),[2,3,10]);assert.equal(node.h,120);assert.equal(s.doc.contentHash,hash);
});

test('every registered command and alias exposes exactly its enforced field contract',()=>{
 assert.deepEqual(new Set(VALID_COMMAND_TYPES),new Set(Object.keys(COMMAND_CONTRACTS)));
 for(const name of VALID_COMMAND_TYPES){assert.deepEqual(describeAuthoring({topic:'command',name}).schema,COMMAND_CONTRACTS[name]);const s=seed(),hash=s.doc.contentHash;const r=apply(s,[{type:'setText',nodeId:'title',text:'Never commit'},{type:name,unrecognizedField:true}]);assert.equal(r.code,'E_COMMAND_FIELD',name);assert.equal(s.doc.contentHash,hash,name);}
});

test('shared schema handles unions, nested dictionaries, empty assertions and finite numbers',()=>{
 assert.throws(()=>validateInput({anyOf:[{type:'string'},{type:'object'}]},[]));
 assert.throws(()=>validateInput({type:'object',additionalProperties:{type:'boolean'}},{field:'yes'}));
 assert.throws(()=>validateInput({type:'object',minProperties:1},{}));
 assert.throws(()=>validateInput({type:'number'},NaN));
 validateInput({anyOf:[{type:'null'},{type:'object'}]},null);
});

test('nested unknowns, conflicting aliases and wrong scopes reject the complete transaction',()=>{
 const s=seed();for(const command of [
 {type:'setProperties',nodeId:'title',properties:{text:'A'},props:{text:'B'}},
 {type:'addNode',node:{type:'box',id:'outer',children:[{type:'label',id:'nested',fontSze:20}]}},
 {type:'addNode',pageId:'absent',node:{id:'outside',type:'box'}},
 {type:'setLayout',nodeId:'title',layout:{mode:'column',gapp:20}},
 {type:'repeaterSetFilter',nodeId:'rows',filter:{field:'status',equlas:'ready'}},
 {type:'setInteraction',nodeId:'title',actions:[{type:'show',target:'rows',misspelled:1}]},
 {type:'reorderPages',pageIds:['absent']},
 {type:'datasetOp',dataset:'items',op:'filter',filter:{field:'status',equals:'ready'}},
 {type:'datasetOp',dataset:'items',op:'unknown'}]){const hash=s.doc.contentHash;const r=apply(s,[{type:'setText',nodeId:'title',text:'Never commit'},command]);assert(!r.ok,JSON.stringify(command));assert.equal(s.doc.contentHash,hash);}
});

test('formerly missing interaction removal and hidden repeater commands execute and undo',()=>{
 const s=seed();assert(apply(s,[{type:'setInteraction',nodeId:'title',actions:{type:'show',target:'rows'}}]).ok);
 assert(apply(s,[{type:'removeInteraction',nodeId:'title'},{type:'repeaterSetFilter',nodeId:'rows',filter:{field:'status',equals:'ready'}},{type:'repeaterSetSort',nodeId:'rows',sort:{field:'value',direction:'desc'}}]).ok);
 assert(!s.doc.pages[0].root.children.find(n=>n.id==='title').on?.click);assert.equal(s.doc.pages[0].root.children.find(n=>n.id==='rows').filter.equals,'ready');
 assert(s.undo().ok);assert(s.doc.pages[0].root.children.find(n=>n.id==='title').on.click);
});

test('invalid reorder cycles reject before mutating source and automatic IDs replay deterministically',()=>{
 const first=seed(),second=seed();const add={type:'addNode',node:{type:'box',w:100,h:100}};assert(apply(first,[add]).ok);assert(apply(second,[add]).ok);assert.equal(first.doc.pages[0].root.children.at(-1).id,second.doc.pages[0].root.children.at(-1).id);
 assert(apply(first,[{type:'addNode',node:{id:'parent',type:'box',children:[{id:'child',type:'box',children:[]}]}}]).ok);
 const hash=first.doc.contentHash;assert.equal(apply(first,[{type:'reorderNode',nodeId:'parent',parentId:'child'}]).code,'E_NODE_CYCLE');assert.equal(first.doc.contentHash,hash);
});

test('interaction aliases preserve supported conditional behavior and reject unsupported action fields',()=>{
 const s=seed();assert(apply(s,[{type:'setInteraction',nodeId:'title',actions:{cases:[{when:'1 == 1',actions:[{type:'set-text',target:'title',value:'Changed'}]}]}}]).ok);
 const rt=new StudioRuntimeSession(s.doc);assert(rt.runScenario([{action:'click',target:'title',expect:{text:{title:'Changed'}}}]).ok);
});
