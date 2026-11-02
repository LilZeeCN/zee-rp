import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{startStudioServer}from'../studio/server.mjs';import{studioHandlers}from'../studio/mcp-adapter.mjs';

test('shared selection carries exact revision, source mappings and an enforced mutation boundary',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-selection-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const{studio}=await startStudioServer({projectDir:dir,port:0,domain:'web'});t.after(()=>studio.close());const url=studio.url;
 const post=async(path,body)=>(await fetch(url+path,{method:'POST',body:JSON.stringify(body)})).json();
 assert((await post('/api/commands',{baseRevision:1,commands:[{type:'addNode',node:{id:'inside',type:'label',text:'Selected',w:220,h:40}},{type:'addNode',node:{id:'outside',type:'label',text:'Keep outside',w:220,h:40}}]})).ok);
 const publish=async(nodeIds,clientId='human')=>post('/api/selection',{clientId,documentId:studio.store.doc.documentId,pageId:'home',revision:studio.store.appliedRevision,contentHash:studio.store.doc.contentHash,nodeIds});
 const selected=await publish(['inside']);assert(selected.ok);
 const context=await studioHandlers.studio_get_design_context({url,stage:'edit',intent:'task',platform:'web',target:{selection:'active'}});assert(context.ready);assert.equal(context.binding.selectionId,selected.selectionId);assert.equal(context.target.nodes[0].target.nodeId,'home/inside');assert.equal(context.authoring.nextCall.arguments.selectionId,selected.selectionId);
 const request={url,selectionId:selected.selectionId,baseRevision:2,idempotencyKey:'scope-edit',commands:[{type:'setText',nodeId:'inside',text:'Precise edit'}]},changed=await studioHandlers.studio_apply_commands(request);assert(changed.ok,JSON.stringify(changed));assert((await studioHandlers.studio_apply_commands(request)).idempotentReplay);
 const stale=await studioHandlers.studio_get_design_context({url,stage:'edit',target:{selection:'active'}});assert.equal(stale.code,'E_SELECTION_STALE');
 const fresh=await publish(['inside']);const hash=studio.store.doc.contentHash;const outside=await studioHandlers.studio_apply_commands({...request,selectionId:fresh.selectionId,baseRevision:3,idempotencyKey:'scope-must-fail',commands:[{type:'setText',nodeId:'inside',text:'Must rollback'},{type:'setText',nodeId:'outside',text:'Wrong scope'}]});assert.equal(outside.code,'E_SELECTION_SCOPE');assert.equal(studio.store.doc.contentHash,hash);assert(outside.outsidePaths.length);
 await publish(['outside']);const moved=await studioHandlers.studio_apply_commands({...request,selectionId:fresh.selectionId,baseRevision:3,idempotencyKey:'changed-selection'});assert.equal(moved.code,'E_SELECTION_CHANGED');assert.equal(studio.store.doc.contentHash,hash);
 await publish(['inside'],'second-human');assert.equal((await studioHandlers.studio_get_design_context({url,stage:'edit',target:{selection:'active'}})).code,'E_SELECTION_AMBIGUOUS');
 const explicit=await studioHandlers.studio_get_design_context({url,stage:'edit',target:{selection:'active',clientId:'human'}});assert.equal(explicit.target.nodes[0].id,'outside');
 await publish([]);const empty=await studioHandlers.studio_get_design_context({url,stage:'edit',target:{selection:'active',clientId:'human'}});assert.equal(empty.code,'E_SELECTION_EMPTY');
});
