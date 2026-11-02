import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StudioOperations } from '../studio/operations.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';
import { studioTools } from '../studio/mcp-adapter.mjs';
import { validateInput } from '../studio/schema-validation.mjs';
import { getReferencePack } from '../studio/reference-packs.mjs';
import { sha256 } from '../studio/document.mjs';
import {nativeTemplateSkipReason} from './host-capabilities.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await delay(30);}throw new Error('operation condition timeout');}
function project(t){const dir=mkdtempSync(join(tmpdir(),'studio-operation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const persistence=new StudioPersistence(dir);const {store}=persistence.initOrLoad();const applied=store.applyTransaction({baseRevision:store.appliedRevision,idempotencyKey:'seed',commands:[{type:'addNode',node:{type:'label',id:'word',text:'serendipity',w:260,h:60,fontSize:30}},{type:'addNode',node:{type:'label',id:'answer',text:'意外的发现',w:260,h:40,visible:false}},{type:'addNode',node:{type:'button',id:'reveal',text:'揭示',w:260,h:48,on:{click:[{type:'show',target:'answer'}]}}}]});assert(applied.ok,JSON.stringify(applied));persistence.persistTransaction(store,store.history.at(-1));return {dir,persistence,store,operations:new StudioOperations(dir)};}

test('async export is durable across service close, identity replay, stale source and process reopen',{timeout:60000,skip:nativeTemplateSkipReason()},async t=>{
 const {dir,store,operations}=project(t);let {studio}=await startStudioServer({projectDir:dir,port:0});const hash=store.doc.contentHash;
 const input={async:true,requestKey:'export-once',baseRevision:store.appliedRevision};
 const first=await(await fetch(studio.url+'/api/export-rp',{method:'POST',body:JSON.stringify(input)})).json();assert(first.ok,JSON.stringify(first));assert(first.id);assert.equal(first.documentChanged,false);await studio.stop();
 const duplicate=await operations.start('export-rp',input,store.doc);assert.equal(duplicate.id,first.id);assert(duplicate.replayed);
 await assert.rejects(()=>operations.start('export-rp',{...input,baseRevision:input.baseRevision+1},store.doc),{code:'E_OPERATION_KEY_REUSED'});
 const completed=await until(async()=>{const x=await new StudioOperations(dir).get({requestKey:'export-once',includeResult:true});if(['failed','interrupted'].includes(x.status))throw new Error(JSON.stringify(x));return x.status==='succeeded'&&x;});
 assert.equal(completed.result.report.summary.threeZerosPassed,true);assert(existsSync(completed.result.outRpPath));assert.equal(new StudioPersistence(dir).initOrLoad().store.doc.contentHash,hash);
 const changed=store.applyTransaction({baseRevision:store.appliedRevision,idempotencyKey:'human-next',commands:[{type:'setText',nodeId:'word',text:'Human copy'}]});assert(changed.ok);new StudioPersistence(dir).persistTransaction(store,store.history.at(-1));
 const old=await new StudioOperations(dir).get({id:first.id,includeResult:true});assert.equal(old.sourceApplicability,'stale-or-unavailable');assert.equal(old.binding.contentHash,hash);
 const listed=await operations.list();assert.equal(listed.operations.length,1);assert.equal(listed.operations[0].resultSummary.output,completed.result.outRpPath);assert.equal((await operations.cancel({id:first.id})).cancellation.accepted,false);
});

test('actual browser operation cancels quickly, confirms process exit and never changes the design',{timeout:60000},async t=>{
 const {dir,store,operations}=project(t),hash=store.doc.contentHash;
 const input={async:true,requestKey:'cancel-browser',baseRevision:store.appliedRevision,pageId:'home',candidates:[{id:'one',commands:[{type:'setProperties',nodeId:'word',properties:{fontSize:32}}]}],states:[{id:'many-clicks',steps:Array.from({length:30},()=>({action:'click',target:'reveal',expect:{visible:{answer:true}}}))}]};
 const job=await operations.start('explore',input,store.doc);
 await until(async()=>{const s=await operations.get({id:job.id,includeResult:true});if(['failed','interrupted','succeeded'].includes(s.status))throw new Error(JSON.stringify(s));return s.phase==='checking-state';});
 const before=Date.now(),cancelled=await operations.cancel({id:job.id});assert(Date.now()-before<1000);assert(cancelled.cancellation.accepted);assert(cancelled.cancelRequested);
 const stopped=await until(async()=>{const s=await new StudioOperations(dir).get({id:job.id});return s.status==='cancelled'&&s;});assert(stopped.stopConfirmed);assert(!existsSync(join(stopped.directory,'result.json')));assert.equal(new StudioPersistence(dir).initOrLoad().store.doc.contentHash,hash);
 const state=JSON.parse(readFileSync(join(stopped.directory,'state.json')));const remaining=spawnSync('ps',['-axo','pid=,pgid=,stat=,command='],{encoding:'utf8'}).stdout.split('\n').filter(line=>new RegExp('^\\s*\\d+\\s+'+state.pid+'\\s+(?!Z)').test(line));assert.deepEqual(remaining,[]);
 assert.equal((await operations.cancel({requestKey:input.requestKey})).cancellation.accepted,false);
});

test('request contracts reject stale versions and changed resources before starting or overwriting',{timeout:10000},async t=>{
 const {dir,store,operations}=project(t);await assert.rejects(()=>operations.start('export-rp',{async:true,requestKey:'old',baseRevision:1},store.doc),{code:'E_OPERATION_STALE'});
 await assert.rejects(()=>operations.start('export-rp',{async:true,requestKey:'custom',baseRevision:store.doc.revision,outRpPath:join(dir,'existing.rp')},store.doc),{code:'E_OPERATION_OUTPUT'});
 assert.equal((await operations.list()).total,0);
 const tool=studioTools.find(x=>x.name==='studio_export_rp');validateInput(tool.inputSchema,{async:true,requestKey:'a',baseRevision:2});assert.throws(()=>validateInput(tool.inputSchema,{async:true,requestKey:7}));
 await assert.rejects(()=>operations.get({requestKey:'not-started'}),{code:'E_OPERATION_NOT_FOUND'});
 const png=readFileSync(getReferencePack('daily-margin-mobile').previewPath);mkdirSync(join(dir,'assets'),{recursive:true});const image=join(dir,'assets','source.png');copyFileSync(getReferencePack('daily-margin-mobile').previewPath,image);
 const registered=store.applyTransaction({baseRevision:store.appliedRevision,idempotencyKey:'asset',commands:[{type:'registerAsset',asset:{relativePath:'assets/source.png',sha256:sha256(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20)}}]});assert(registered.ok);new StudioPersistence(dir).persistTransaction(store,store.history.at(-1));
 const altered=Buffer.from(png);altered[altered.length-1]^=1;writeFileSync(image,altered);
 await assert.rejects(()=>operations.start('export-rp',{async:true,requestKey:'bad-bytes',baseRevision:store.appliedRevision},store.doc),{code:'E_OPERATION_RESOURCE_DRIFT'});assert.equal((await operations.list()).total,0);
});

test('completed media stays uncommitted until registered in one source transaction',{timeout:30000},async t=>{
 const {dir,store,operations}=project(t),hash=store.doc.contentHash;
 const {studio}=await startStudioServer({projectDir:dir,port:0});t.after(()=>studio.stop());
 const source=getReferencePack('daily-margin-mobile').previewPath;
 const job=await(await fetch(studio.url+'/api/media/prepare',{method:'POST',body:JSON.stringify({async:true,requestKey:'media-once',baseRevision:store.appliedRevision,sourcePath:source,crops:[{w:160,h:120,scale:1}]})})).json();assert(job.ok,JSON.stringify(job));
 const completed=await until(async()=>{const s=await operations.get({id:job.id,includeResult:true});if(['failed','interrupted'].includes(s.status))throw new Error(JSON.stringify(s));return s.status==='succeeded'&&s;});
 assert.equal(studio.store.doc.contentHash,hash);const media=completed.result.results[0];assert(existsSync(join(dir,media.src)));assert(existsSync(join(dir,completed.result.originalPath)));
 const applied=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:store.appliedRevision,idempotencyKey:'mount-media',commands:[media.registerCommand,{type:'addNode',node:{type:'image',id:'photo',src:media.src,w:160,h:120}}]})})).json();assert(applied.ok,JSON.stringify(applied));
 const stale=await operations.get({id:job.id,includeResult:true});assert.equal(stale.sourceApplicability,'stale-or-unavailable');assert.equal(stale.result.results[0].registerCommand,undefined);
});

test('abrupt worker interruption is durable and replay never launches a second worker',{timeout:30000},async t=>{
 const {dir,store,operations}=project(t),hash=store.doc.contentHash;
 const args={async:true,requestKey:'interrupted',baseRevision:store.appliedRevision,pageId:'home',candidates:[{id:'one',commands:[{type:'setProperties',nodeId:'word',properties:{fontSize:31}}]}]};
 const job=await operations.start('explore',args,store.doc);
 await until(async()=>{const s=await operations.get({id:job.id});return s.status==='running'&&s;});
 const internal=JSON.parse(readFileSync(join(job.directory,'state.json')));const command=spawnSync('ps',['-p',String(internal.pid),'-o','command='],{encoding:'utf8'}).stdout;assert(command.includes(job.directory)&&command.includes(job.id));process.kill(-internal.pid,'SIGKILL');
 const interrupted=await until(async()=>{const s=await new StudioOperations(dir).get({requestKey:args.requestKey});return s.status==='interrupted'&&s;});assert.equal(interrupted.diagnostic.code,'E_OPERATION_INTERRUPTED');
 const retry=await operations.start('explore',args,store.doc);assert.equal(retry.id,job.id);assert.equal(retry.status,'interrupted');assert(retry.replayed);assert.equal((await operations.list()).total,1);assert.equal(new StudioPersistence(dir).initOrLoad().store.doc.contentHash,hash);
});
