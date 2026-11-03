import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { StudioRuntimeSession } from '../studio/runtime.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { exportStudioDocumentToRp } from '../studio/export-rp.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { readRp } from '../scripts/rp-read.mjs';
function sample(){
 const store=new StudioDocumentStore(createEmptyStudioDocument());
 const result=store.applyTransaction({baseRevision:1,idempotencyKey:'sample',commands:[
  {type:'addNode',node:{id:'decoration',type:'box',visible:false,x:0,y:0,w:4,h:4,fill:'#193932'}},
  {type:'addNode',node:{id:'title',type:'label',x:24,y:40,w:330,h:40,fontSize:24,text:'serendipity',color:'#193932'}},
  {type:'addNode',node:{id:'hint',type:'label',x:24,y:100,w:330,h:32,text:'先回忆，再显示释义',color:'#193932'}},
  {type:'addNode',node:{id:'reveal',type:'button',x:24,y:180,w:330,h:48,fill:'#193932',color:'#FFFFFF',text:'显示释义',onClick:[{type:'show',target:'answer'}]}},
  {type:'addNode',node:{id:'answer',type:'box',visible:false,x:24,y:180,w:330,h:200,children:[
   {id:'meaning',type:'label',x:0,y:0,w:330,h:40,text:'意外发现美好的能力'},
   {id:'again',type:'button',x:0,y:100,w:330,h:48,text:'再看',on:{click:[{type:'hide',target:'answer'}]}}
  ]}}
 ]});assert.ok(result.ok,JSON.stringify(result));return store;
}
test('hidden container descendants stay hidden and follow runtime ancestor changes across cached scenes',()=>{
 const rt=new StudioRuntimeSession(sample().doc);
 for(let i=0;i<2;i++){
  assert.equal(rt.isNodeVisible('meaning'),false);assert.equal(rt.getState().activePageScene.nodes.find(n=>n.id==='meaning').visible,false);
  assert.throws(()=>rt.click('again'),{code:'E_RUNTIME_NODE_HIDDEN'});
  rt.click('reveal');assert.equal(rt.isNodeVisible('meaning'),true);assert.equal(rt.getState().activePageScene.nodes.find(n=>n.id==='meaning').visible,true);
  rt.click('again');assert.equal(rt.isNodeVisible('meaning'),false);
 }
});
test('unknown steps, misspelled expectations and zero-assertion scenarios fail before executing actions',()=>{
 for(const steps of [null,[],[{type:'click',target:'reveal'}],[{action:'click',target:'reveal'}],[{action:'click',target:'reveal',expect:{visble:{answer:true}}}],[{action:'click',target:'reveal',expect:{visible:{answer:'false'}}}],[{action:'click',target:'reveal',expect:{visible:{}}}]]){
  const rt=new StudioRuntimeSession(sample().doc);const result=rt.runScenario(steps);assert.equal(result.ok,false,JSON.stringify(steps));assert.equal(result.code,'E_SCENARIO_STEP');assert.equal(result.finalState.traceCount,0);assert.equal(rt.isNodeVisible('meaning'),false);
 }
});
test('documented action/expect scripts execute real assertions and fail a negative control',()=>{
 const rt=new StudioRuntimeSession(sample().doc);
 const result=rt.runScenario([{expect:{visible:{answer:false,meaning:false}}},{action:'click',target:'reveal',expect:{visible:{answer:true,meaning:true}}},{action:'click',target:'again',expect:{visible:{answer:false,meaning:false}}}]);
 assert.equal(result.ok,true);assert.equal(result.assertionCount,6);assert.equal(result.finalState.traceCount,2);
 assert.equal(rt.runScenario([{expect:{visible:{meaning:true}}}]).ok,false);
});
test('onClick is visible to browser scene and native exporter, aliases cannot silently disagree',async()=>{
 const store=sample();assert.equal(resolveDocumentScene(store.doc).pages[0].nodes.find(n=>n.id==='reveal').on.click[0].type,'show');
 const bad=store.applyTransaction({baseRevision:2,idempotencyKey:'conflict',commands:[{type:'setProperties',nodeId:'reveal',properties:{on:{click:[{type:'hide',target:'answer'}]},onClick:[{type:'show',target:'answer'}]}}]});
 assert.equal(bad.code,'E_INTERACTION_ALIAS_CONFLICT');assert.equal(store.appliedRevision,2);
 const updated=store.applyTransaction({baseRevision:2,idempotencyKey:'alias-edit',commands:[{type:'setProperties',nodeId:'reveal',properties:{onClick:[{type:'show',target:'answer'}]}}]});assert.equal(updated.ok,true);assert.equal(resolveDocumentScene(store.doc).pages[0].nodes.find(n=>n.id==='reveal').on.click[0].type,'show');
 const dir=mkdtempSync(join(tmpdir(),'ceiling-native-'));try{
  const result=await exportStudioDocumentToRp(store.doc,{outRpPath:join(dir,'sample.rp')});assert.equal(result.report.summary.threeZerosPassed,true);
  const rp=readRp(readFileSync(join(dir,'sample.rp')));assert.ok(rp.pages[0].widgets.find(w=>w.name?.includes('reveal')));
  assert.equal(rp.counts.interactions,3); // reveal, again and initial hide
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('real browser preview keeps hidden children absent, click reveals them and again hides them',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ceiling-browser-'));const path=join(dir,'source.json');writeFileSync(path,JSON.stringify(sample().doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:path,port:0});
 try{
  const page=await studio.ensureManagedBrowserPage();await page.evaluate(`document.querySelector('#mode-interact-btn').click()`);await page.waitForFunction(`window.__STUDIO_STATE__.mode==='interact'&&window.__STUDIO_STATE__.runtimeState`);
  assert.equal(await page.evaluate(`!!document.querySelector('.studio-node[data-node-id="meaning"]')`),false);
  const physicalClick=async id=>{const point=await page.evaluate(`(()=>{const r=document.querySelector('.studio-node[data-node-id="${id}"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});};
  await physicalClick('reveal');await page.waitForFunction(`!!document.querySelector('.studio-node[data-node-id="meaning"]')`);
  await physicalClick('again');await page.waitForFunction(`!document.querySelector('.studio-node[data-node-id="meaning"]')`);
 }finally{await studio.stop();rmSync(dir,{recursive:true,force:true});}
});

test('arbitrary layout candidates render actual states without changing the source; content and behavior losses are rejected', {timeout:120000}, async()=>{
 const {previewCandidates}=await import('../studio/candidate-explorations.mjs');
 const dir=mkdtempSync(join(tmpdir(),'ceiling-candidates-'));const path=join(dir,'source.json');writeFileSync(path,JSON.stringify(sample().doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:path,port:0});
 try{
  const revision=studio.store.appliedRevision,hash=studio.store.doc.contentHash;
  const result=await previewCandidates(studio,{pageId:'home',baseRevision:revision,candidates:[
   {id:'moved',label:'自由重排',designIntent:{reason:'操作与答案形成连续阅读路径',tradeoff:'底部留白减少',axes:['reading-order','density']},commands:[{type:'editNodes',select:{pageId:'home',nodeIds:['reveal']},operation:'move',dy:32}]},
   {id:'lost-content',commands:[{type:'setText',nodeId:'reveal',text:'丢失必备文案'}]},
   {id:'lost-behavior',commands:[{type:'setProperties',nodeId:'reveal',properties:{on:{click:[]}}}]},
   {id:'show-decoration',commands:[{type:'setProperties',nodeId:'decoration',properties:{visible:true}}]},
  ],states:[{id:'recall',steps:[{expect:{visible:{meaning:false}}}]},{id:'answer',steps:[{action:'click',target:'reveal',expect:{visible:{meaning:true}}}]},{id:'again',steps:[{action:'click',id:'reveal'},{action:'click',target:'again',expect:{visible:{meaning:false}}}]}]});
  assert.equal(studio.store.appliedRevision,revision);assert.equal(studio.store.doc.contentHash,hash);
  assert.equal(result.candidates[0].status,'rendered',JSON.stringify(result.candidates[0]));
  assert.equal(result.candidates[0].label,'自由重排');assert.equal(result.candidates[0].designIntent.tradeoff,'底部留白减少');assert.equal(result.candidates[0].designIntent.source,'caller-provided');assert.equal(result.candidates[0].designIntent.userAccepted,false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'project','design-explorations',result.explorationId,'result.json'))).candidates[0].designIntent,result.candidates[0].designIntent);
  assert.equal(result.candidates[0].frames.length,3);assert.ok(result.candidates[0].frames.every(f=>f.verification==='real-browser-pointer'));
  assert.notEqual(result.candidates[0].frames[0].sha256,result.candidates[0].frames[1].sha256);
  assert.ok(result.contactSheet.path);assert.equal(result.mcpImages.length,1);
  assert.equal(result.candidates[1].error.code,'E_CANDIDATE_PRESERVATION');assert.equal(result.candidates[2].error.code,'E_CANDIDATE_PRESERVATION');
  assert.equal(result.candidates[3].status,'rendered',JSON.stringify(result.candidates[3]));
  const leaking=await previewCandidates(studio,{pageId:'home',baseRevision:revision,candidates:[{id:'leaking-answer',commands:[{type:'setProperties',nodeId:'answer',properties:{visible:true}}]}]});assert.equal(leaking.candidates[0].error.code,'E_CANDIDATE_PRESERVATION');
  const chosen=result.candidates[0].applyWith;assert.ok(chosen,JSON.stringify(result.candidates[0].findings));
  const response=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify(chosen)})).json();assert.ok(response.ok);assert.equal(studio.store.appliedRevision,revision+1);
  await assert.rejects(()=>previewCandidates(studio,{pageId:'home',baseRevision:revision,candidates:[{id:'stale',commands:[{type:'setText',nodeId:'reveal',text:'旧版本'}]}]}),{code:'E_STALE_EXPLORATION'});
 }finally{await studio.stop();rmSync(dir,{recursive:true,force:true});}
});

test('candidate state scripts never turn an unsupported or failed assertion into an apply shortcut', {timeout:120000},async()=>{
 const {previewCandidates}=await import('../studio/candidate-explorations.mjs');
 const dir=mkdtempSync(join(tmpdir(),'ceiling-negative-'));const path=join(dir,'source.json');writeFileSync(path,JSON.stringify(sample().doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:path,port:0});
 try{
  // 断言更正（红线 3）：T-I-2 修复后零断言 states 由「跑完像素审计、帧级 E_SCENARIO_STEP」改为与
  // studio_run_scenario 一致的入口级拒绝 E_SCENARIO_ASSERTIONS_REQUIRED；因此不再存在 candidates/frames。
  const revisionBefore=studio.store.appliedRevision;
  await assert.rejects(
    () => previewCandidates(studio,{pageId:'home',baseRevision:revisionBefore,candidates:[{id:'negative',commands:[{type:'editNodes',select:{pageId:'home',nodeIds:['reveal']},operation:'move',dy:4}]}],states:[{id:'wrong',steps:[{type:'click',target:'reveal'}]}]}),
    {code:'E_SCENARIO_ASSERTIONS_REQUIRED'},
  );
  assert.equal(studio.store.appliedRevision,revisionBefore);
  assert.equal(studio.store.doc.pages.find(p=>p.id==='home').root.children.some(n=>n.id==='negative'),false);
 }finally{await studio.stop();rmSync(dir,{recursive:true,force:true});}
});
