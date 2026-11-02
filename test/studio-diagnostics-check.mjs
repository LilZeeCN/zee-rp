import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {StudioDocumentStore} from '../studio/commands.mjs';
import {resolveDocumentScene} from '../studio/scene-resolver.mjs';
import {locateDiagnostic} from '../studio/diagnostics.mjs';
import {startStudioServer} from '../studio/server.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('diagnostics resolve macro parameters and instance overrides without widening absent or stale targets',()=>{
 const store=new StudioDocumentStore(createEmptyStudioDocument());const result=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'card',id:'note',title:'Macro title',w:300,h:180}},{type:'createComponent',componentId:'caption',root:{type:'label',id:'caption_root',text:'Caption',w:160,h:40}},{type:'createInstance',componentId:'caption',instanceId:'caption_one'}]});assert(result.ok);
 const scene=resolveDocumentScene(store.doc),macro=locateDiagnostic({doc:store.doc,scene,pageId:'home',nodeIds:['note_title'],field:'fontSize'});assert(macro.complete);assert.equal(macro.targets[0].target.kind,'macro-parameter');assert.equal(macro.targets[0].target.property,'title');assert.equal(macro.targets[0].target.nodeId,'home/note');assert.equal(macro.targets[0].fieldSupport,'exposed-via-macro-parameter');assert.equal(macro.targets[0].target.propertyMap.fontSize,'titleFontSize');
 const instance=scene.pages[0].nodes.find(node=>node.componentSource&&node.rawText==='Caption');assert(instance);
 const located=locateDiagnostic({doc:store.doc,scene,pageId:'home',nodeIds:[instance.id]});assert.equal(located.targets[0].target.kind,'instance-override');
 const missing=locateDiagnostic({doc:store.doc,scene,nodeIds:['absent']});assert(!missing.complete);assert.equal(missing.targets.length,0);assert.equal(missing.unresolved[0].reason,'not-found');
 const stale=locateDiagnostic({doc:store.doc,scene,nodeIds:['note_title'],code:'E_STALE_REVISION'});assert(!stale.complete);assert.equal(stale.targets.length,0);
 const budget=locateDiagnostic({doc:store.doc,scene,pageId:'home',nodeIds:['note','note_title'],limit:1});assert(!budget.complete);assert.equal(budget.returned,1);assert.equal(budget.omittedNodeIds.length,1);
});

test('HTTP errors carry the current exact target and stale requests never carry a writable substitute',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-diagnostic-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const {studio}=await startStudioServer({projectDir:dir,port:0});t.after(()=>studio.stop());
 const post=async body=>(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify(body)})).json();
 let r=await post({baseRevision:1,idempotencyKey:'seed',commands:[{type:'addNode',node:{type:'label',id:'title',text:'Keep',w:200,h:40}}]});assert(r.ok);const hash=r.contentHash;
 r=await post({baseRevision:2,idempotencyKey:'bad',commands:[{type:'setProperties',nodeId:'title',properties:{id:'changed'}}]});assert(!r.ok);assert.equal(r.diagnostic.code,'E_READONLY_PROPERTY');assert.equal(r.diagnostic.binding.contentHash,hash);assert.equal(r.diagnostic.targets[0].target.nodeId,'home/title');assert.equal(r.diagnostic.targets[0].field,'id');
 r=await post({baseRevision:1,idempotencyKey:'stale',commands:[{type:'setText',nodeId:'title',text:'Old'}]});assert(!r.ok);assert.equal(r.diagnostic.targets.length,0);assert.equal(studio.store.doc.contentHash,hash);
});
