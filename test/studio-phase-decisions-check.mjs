import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';
import { getDesignDecisions } from '../studio/design-decisions.mjs';
import { getDesignContext } from '../studio/design-context.mjs';
import { listReferencePacks, getReferencePack } from '../studio/reference-packs.mjs';
import { studioTools } from '../studio/mcp-adapter.mjs';
import { validateInput } from '../scripts/mcp-tools.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const record = (id, extra = {}) => ({ type:'recordDesignDecision', decisionId:id, scope:{kind:'project'}, subject:'brand', outcome:'accepted', choice:'Deep blue', reason:'Let the current task lead', feedback:{source:'agent'}, ...extra });
const apply = (store, commands, key = `edit-${store.appliedRevision}`) => store.applyTransaction({baseRevision:store.appliedRevision,idempotencyKey:key,commands});
const seeded = () => { const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'})); assert(apply(store,[{type:'addNode',node:{type:'label',id:'title',text:'Original',w:280,h:48,fontSize:24}}]).ok);return store; };

test('design decisions and visual edits share atomic identity, undo and durable recovery', t => {
  const dir=mkdtempSync(join(tmpdir(),'studio-decisions-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const p=new StudioPersistence(dir);let {store}=p.initOrLoad({domain:'web'});
  const request={baseRevision:1,idempotencyKey:'brand-and-title',commands:[record('brand'),{type:'addNode',node:{type:'label',id:'title',text:'New',w:280,h:48}}]};
  const r=store.applyTransaction(request);assert(r.ok);p.persistTransaction(store,store.history.at(-1));
  assert.equal(store.applyTransaction(request).idempotentReplay,true);
  const changed=structuredClone(request);changed.commands[0].reason='different intent';assert.equal(store.applyTransaction(changed).code,'E_IDEMPOTENCY_CONFLICT');
  ({store}=new StudioPersistence(dir).initOrLoad());assert.equal(getDesignDecisions(store.doc).effective.length,1);assert.equal(store.doc.designDecisions[0].recordedRevision,2);
  assert(store.undo().ok);assert(!store.doc.designDecisions);assert.equal(store.doc.pages[0].root.children.length,0);
  assert(store.redo().ok);assert.equal(getDesignDecisions(store.doc).effective[0].id,'brand');
});

test('whole transaction rejects invalid scope, duplicate IDs and unsupported user attribution', () => {
  const store=seeded(),before=store.doc.contentHash;
  for(const command of [record('missing',{scope:{kind:'page',pageId:'not-there'}}),record('empty',{scope:{kind:'node',pageId:'home',nodeIds:[]}}),record('user',{feedback:{source:'user'}}),record('absent',{scope:undefined})]) {
    const r=apply(store,[{type:'setText',nodeId:'title',text:'Must roll back'},command]);assert(!r.ok);assert.equal(store.doc.contentHash,before);
  }
  assert(apply(store,[record('one')]).ok);const hash=store.doc.contentHash;assert.equal(apply(store,[record('one')]).code,'E_DESIGN_DECISION_ID');assert.equal(store.doc.contentHash,hash);
});

test('scope and precise dependencies survive unrelated edits and exclude changed or deleted sources', () => {
  const store=seeded();assert(apply(store,[record('brand'),record('font',{scope:{kind:'node',pageId:'home',nodeIds:['title']},subject:'typography',dependsOn:{sourceTargets:[{nodeId:'title',properties:['fontSize']}]}})]).ok);
  assert(apply(store,[{type:'setText',nodeId:'title',text:'Copy changed'}]).ok);let d=getDesignDecisions(store.doc,{scope:{kind:'page',pageId:'home'}});assert.equal(d.effective.length,2);
  assert(apply(store,[{type:'setProperties',nodeId:'title',properties:{fontSize:30}}]).ok);d=getDesignDecisions(store.doc,{scope:{kind:'page',pageId:'home'}});assert.equal(d.effective[0].id,'brand');assert.equal(d.excluded[0].applicability.state,'stale');
  assert(apply(store,[{type:'setToken',name:'brand',value:'#112233'}]).ok);assert.equal(getDesignDecisions(store.doc).effective.length,0);
  assert(apply(store,[{type:'deleteNode',nodeId:'title'}]).ok);assert.equal(getDesignDecisions(store.doc,{scope:{kind:'page',pageId:'home'}}).excluded.find(x=>x.id==='font').applicability.state,'orphaned');
});

test('conflicts stay explicit, superseding keeps original feedback, and agent cannot overwrite a user constraint', () => {
  const store=seeded();assert(apply(store,[record('user',{feedback:{source:'user',quote:'Use blue',evidenceRef:'brief:brand'}}),record('agent',{choice:'Orange'})]).ok);
  let d=getDesignDecisions(store.doc);assert.equal(d.conflicts.length,1);assert.equal(d.effective.length,0);assert.equal(store.doc.designDecisions[0].userAccepted,false);
  assert.equal(apply(store,[record('override',{supersedes:['user']})]).code,'E_DESIGN_DECISION_AUTHORITY');
  assert(apply(store,[record('new-user',{choice:'Orange',supersedes:['user'],feedback:{source:'user',quote:'Orange for the new brand',evidenceRef:'brief:brand-v2'}})]).ok);
  d=getDesignDecisions(store.doc);assert.equal(d.conflicts.length,0);assert.equal(d.excluded.find(x=>x.id==='user').feedback.quote,'Use blue');assert.equal(d.excluded[0].applicability.state,'superseded');
});

test('a selected page decision uses final transaction contents regardless of command ordering', () => {
  const store=seeded();assert(apply(store,[record('layout',{scope:{kind:'page',pageId:'home'},subject:'layout'}),{type:'setText',nodeId:'title',text:'New layout contents'}]).ok);
  assert.equal(getDesignDecisions(store.doc,{scope:{kind:'page',pageId:'home'}}).effective[0].id,'layout');
});

test('WAL-only replay finalizes decisions against the complete transaction and retains its hash',t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-decision-wal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const persistence=new StudioPersistence(dir),{store}=persistence.initOrLoad({domain:'web'});
 assert(apply(store,[record('page-layout',{scope:{kind:'page',pageId:'home'},subject:'layout'}),{type:'addNode',node:{id:'after_decision',type:'label',text:'New content',w:280,h:50}}]).ok);
 const hash=store.doc.contentHash;assert.throws(()=>persistence.persistTransaction(store,store.history.at(-1),{simulateCrashStage:'after_wal_before_doc'}));
 const restored=new StudioPersistence(dir).initOrLoad();assert.equal(restored.recoveryReport.replayedTransactions,1);assert.equal(restored.store.doc.contentHash,hash);assert.equal(getDesignDecisions(restored.store.doc,{scope:{kind:'page',pageId:'home'}}).effective[0].id,'page-layout');
});

test('five task references are real sources, versioned and never user-accepted by model choice', () => {
  const packs=listReferencePacks();assert.equal(packs.length,5);assert.deepEqual(new Set(packs.map(p=>p.intent)),new Set(['learning','task','editorial']));
  for(const pack of packs){const r=getReferencePack(pack.id,{includeSource:true});assert(r.pageSource.root);assert.equal(r.provenance.userAccepted,false);assert(r.design.directions.length>=3);assert(r.scenarios.length);assert(readFileSync(r.sourcePath).length>1000);}
});

test('stage context keeps version-bound source mappings, long text and honest budgets', () => {
  const store=seeded();const text='Read the complete sentence. '.repeat(80);assert(apply(store,[{type:'setText',nodeId:'title',text}]).ok);
  const args={stage:'edit',intent:'task',platform:'web',target:{pageId:'home',revision:store.doc.revision,nodeIds:['title']}};
  const r=getDesignContext(args,{doc:store.doc});assert(r.ready);assert.equal(r.target.nodes[0].text,text);assert.equal(r.target.nodes[0].textTruncated,false);assert(r.budget.textBytes<=r.budget.maxBytes);
  assert.throws(()=>getDesignContext({...args,target:{...args.target,revision:1}},{doc:store.doc}),{code:'E_DESIGN_TARGET_STALE'});
  assert.throws(()=>getDesignContext({...args,target:{...args.target,nodeIds:[]}},{doc:store.doc}));
  const empty=getDesignContext({...args,target:{pageId:'home',revision:store.doc.revision,role:'no-match'}},{doc:store.doc});assert(!empty.ready);assert.equal(empty.target.nodes.length,0);
  const tiny=getDesignContext({...args,maxBytes:4000,brief:{constraints:['Keep every requirement '.repeat(80),'Keep every requirement '.repeat(80)]}},{doc:store.doc});assert(!tiny.ready);assert.equal(tiny.code,'E_DESIGN_CONTEXT_BUDGET');assert(Buffer.byteLength(JSON.stringify(tiny))<=4000);assert(!tiny.authoring);
});

test('stage edit maps macro content and instance text to their writable source without widening',()=>{
 const store=seeded();assert(apply(store,[{type:'addNode',node:{id:'note',type:'card',title:'Macro title',body:'Keep the complete body',w:340,h:240}},
 {type:'createComponent',componentId:'caption',root:{type:'box',id:'caption_root',w:240,h:80,children:[{id:'caption_text',type:'label',text:'Instance copy',w:220,h:40}]}},
 {type:'createInstance',componentId:'caption',instanceId:'caption_one'}]).ok);
 const args={stage:'edit',intent:'task',platform:'web',target:{pageId:'home',revision:store.doc.revision,nodeIds:['note_title']}};
 const macro=getDesignContext(args,{doc:store.doc});assert(macro.ready);assert.equal(macro.target.nodes[0].target.kind,'macro-parameter');assert.equal(macro.target.nodes[0].suggestedEdit.command.properties.title,'Macro title');assert.deepEqual(macro.binding.scope.nodeIds,['home/note']);
 const instance=getDesignContext({...args,target:{...args.target,nodeIds:['caption_one__caption_text']}},{doc:store.doc});assert(instance.ready);assert.equal(instance.target.nodes[0].suggestedEdit.command.type,'setInstanceOverride');assert.equal(instance.target.nodes[0].suggestedEdit.command.subNodeId,'caption_text');
});

test('public stage contract rejects unknown nested fields before server execution', () => {
  const schema=studioTools.find(t=>t.name==='studio_stage').inputSchema;
  validateInput(schema,{stage:'planning',intent:'learning',platform:'mobile',target:{pageId:'home'},brief:{task:'Learn',states:['recall']}});
  assert.throws(()=>validateInput(schema,{stage:'planning',target:{pageId:'home',guessPage:true}}));
  assert.throws(()=>validateInput(schema,{stage:'new-stage'}));
});

test('craft follows effective direction decisions, excludes stale choices and keeps targeted edits small',()=>{
 const store=seeded(),args={stage:'planning',intent:'task',platform:'web',target:{pageId:'home'}};
 let context=getDesignContext(args,{doc:store.doc});assert(context.ready);assert.equal(context.craft.mode,'explore-direction');assert(context.craft.comparison);assert(context.budget.textBytes<=12000);
 assert(apply(store,[record('chosen-direction',{scope:{kind:'page',pageId:'home'},subject:'direction',choice:'A quiet reading column'})]).ok);
 context=getDesignContext(args,{doc:store.doc});assert(context.ready);assert.equal(context.craft.mode,'continue-direction');assert.deepEqual(context.craft.directionDecisionIds,['chosen-direction']);assert(!context.craft.comparison);assert.equal(context.decisions.effective[0].feedback.source,'agent');assert.equal(context.decisions.effective[0].userAccepted,false);
 const local=getDesignContext({...args,stage:'edit',target:{pageId:'home',revision:store.doc.revision,nodeIds:['title']}},{doc:store.doc});assert(local.ready);assert.equal(local.craft,undefined);
 assert(apply(store,[{type:'setText',nodeId:'title',text:'Changed content invalidates the layout choice'}]).ok);
 context=getDesignContext(args,{doc:store.doc});assert.equal(context.craft.mode,'explore-direction');assert.equal(context.decisions.excluded[0].applicability.state,'stale');
 const tiny=getDesignContext({...args,maxBytes:4000},{doc:store.doc});assert(Buffer.byteLength(JSON.stringify(tiny))<=4000);if(!tiny.ready)assert(!tiny.authoring?.nextCall);
});

test('candidate reasoning is typed and rejects invalid intent before allocating a preview',async()=>{
 const schema=studioTools.find(t=>t.name==='studio_design').inputSchema;
 const candidate={id:'option-a',designIntent:{reason:'Let the word lead',tradeoff:'Fewer items above the fold',axes:['structure','typography']},commands:[{type:'setText',nodeId:'title',text:'word'}]};
 validateInput(schema,{action:'explore',pageId:'home',baseRevision:1,candidates:[candidate]});
 assert.throws(()=>validateInput(schema,{action:'explore',candidates:[{...candidate,designIntent:{...candidate.designIntent,axes:['palette']}}]}));
 const {previewCandidates}=await import('../studio/candidate-explorations.mjs');const store=seeded(),hash=store.doc.contentHash;
 await assert.rejects(()=>previewCandidates({store,scene:{pages:[{id:'home'}]}},{pageId:'home',baseRevision:store.appliedRevision,candidates:[{...candidate,designIntent:{...candidate.designIntent,axes:['typography','typography']}}]}),{code:'E_CANDIDATE_INTENT'});
 assert.equal(store.doc.contentHash,hash);
});

test('fresh MCP needs only open/context/apply and restores recorded design choices after reopen', async t => {
  const dir=mkdtempSync(join(tmpdir(),'studio-phase-mcp-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const client=new Client({name:'stage-public-caller',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[join(root,'bin/mcp.mjs')],stderr:'pipe'});
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});return r.structuredContent||JSON.parse(r.content.find(c=>c.type==='text').text)};
  try{await client.connect(transport);const opened=await call('studio_open_project',{projectDir:dir,port:4518});assert(opened.ok,JSON.stringify(opened));
    const ctx=await call('studio_stage',{projectDir:dir,stage:'skeleton',intent:'learning',platform:'mobile',target:{pageId:'home'},brief:'Recall before revealing the meaning'});assert(ctx.ready);assert.equal(ctx.referencePack.id,'deep-recall-mobile');
    const write=await call('studio_command',{projectDir:dir,baseRevision:ctx.binding.revision,idempotencyKey:'first-draft',commands:[{type:'addNode',pageId:'home',parentId:'home_screen',node:{id:'word',type:'label',text:'linger',w:300,h:80,fontSize:48}},record('direction',{scope:{kind:'page',pageId:'home'},subject:'direction',choice:'One large word',basedOnRevision:ctx.binding.revision})]});assert(write.ok,JSON.stringify(write));
    const next=await call('studio_stage',{projectDir:dir,stage:'refine',intent:'learning',target:{pageId:'home'}});assert.equal(next.decisions.effective[0].id,'direction');
  }finally{await client.close();}
  const {store}=new StudioPersistence(dir).initOrLoad();assert.equal(getDesignDecisions(store.doc,{scope:{kind:'page',pageId:'home'}}).effective[0].id,'direction');
});
