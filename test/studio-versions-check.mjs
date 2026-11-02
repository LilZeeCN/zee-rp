import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{StudioPersistence}from'../studio/persistence.mjs';import{buildNodeIndex}from'../studio/document.mjs';import{StudioVersions}from'../studio/versions.mjs';import{getDesignDecisions}from'../studio/design-decisions.mjs';
import{startStudioServer}from'../studio/server.mjs';import{studioHandlers}from'../studio/mcp-adapter.mjs';
const setup=t=>{const dir=mkdtempSync(join(tmpdir(),'studio-versions-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const persistence=new StudioPersistence(dir),{store}=persistence.initOrLoad({domain:'web'}),versions=new StudioVersions(persistence);const apply=commands=>{const r=store.applyTransaction({baseRevision:store.appliedRevision,commands});assert(r.ok,JSON.stringify(r));persistence.persistTransaction(store,store.history.at(-1));return r;};return{dir,persistence,store,versions,apply};};

test('named versions survive 500 edits, bounded undo history, branching and new-process recovery',t=>{
 const {dir,persistence,store,versions,apply}=setup(t);
 apply([{type:'addNode',node:{id:'title',type:'label',text:'Saved draft',w:280,h:40}},{type:'recordDesignDecision',decisionId:'font-choice',scope:{kind:'project'},subject:'typography',outcome:'accepted',choice:'Georgia',reason:'Make the word lead',feedback:{source:'agent'}}]);
 const saved=versions.create(store,{name:'First complete draft',baseRevision:store.appliedRevision,idempotencyKey:'name-first'}),originalHash=store.doc.contentHash;
 for(let i=0;i<500;i++)apply([{type:'setText',nodeId:'title',text:`Revision ${i}`}]);
 assert(store.history.length<=120);assert(store.snapshots.size<=120);assert(readdirSync(persistence.snapshotsDir).length<=122);assert(store.historyBytes<=store.maxHistoryBytes);
 assert.equal(versions.list().length,1);const preview=versions.preview(store,{versionId:saved.version.id,baseRevision:store.appliedRevision});assert(preview.diff.total>0);
 const restored=versions.restore(store,{versionId:saved.version.id,baseRevision:store.appliedRevision,previewHash:preview.previewHash,idempotencyKey:'restore-first'});assert(restored.ok,JSON.stringify(restored));persistence.persistTransaction(store,store.history.at(-1));assert.equal(store.doc.contentHash,originalHash);assert.equal(getDesignDecisions(store.doc).effective[0].id,'font-choice');
 assert(store.undo().ok);persistence.persistTransaction(store,store.lastHistoryRecord);assert.equal(store.doc.pages[0].root.children[0].text,'Revision 499');assert(store.redo().ok);persistence.persistTransaction(store,store.lastHistoryRecord);assert.equal(store.doc.contentHash,originalHash);
 const loaded=new StudioPersistence(dir).initOrLoad().store;assert.equal(loaded.doc.contentHash,originalHash);assert(loaded.history.length<=120);assert(loaded.undo().ok);assert.equal(loaded.doc.pages[0].root.children[0].text,'Revision 499');
});

test('stale previews, corrupt snapshots and changed save identities never change the current source',t=>{
 const{dir,store,versions,apply}=setup(t);const saved=versions.create(store,{name:'A',baseRevision:1,idempotencyKey:'save-a'});assert(versions.create(store,{name:'A',baseRevision:1,idempotencyKey:'save-a'}).idempotentReplay);
 assert.throws(()=>versions.create(store,{name:'B',baseRevision:1,idempotencyKey:'save-a'}),{code:'E_IDEMPOTENCY_CONFLICT'});
 const preview=versions.preview(store,{versionId:saved.version.id,baseRevision:1});apply([{type:'addNode',node:{id:'new',type:'label',text:'New'}}]);const hash=store.doc.contentHash;
 assert.throws(()=>versions.restore(store,{versionId:saved.version.id,baseRevision:store.appliedRevision,previewHash:preview.previewHash,idempotencyKey:'restore-a'}),{code:'E_VERSION_PREVIEW_STALE'});assert.equal(store.doc.contentHash,hash);
 const path=join(dir,'versions',saved.version.id+'.json'),raw=JSON.parse(readFileSync(path));raw.document.name='Damaged';writeFileSync(path,JSON.stringify(raw));assert.throws(()=>versions.read(saved.version.id),{code:'E_VERSION_CORRUPT'});assert.equal(store.doc.contentHash,hash);
});

test('public versions API restores once, records its transaction, and reopens with original design decisions',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-version-api-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const{studio}=await startStudioServer({projectDir:dir,port:0});t.after(()=>studio.close());
 const a={url:studio.url},saved=await studioHandlers.studio_project_versions({...a,action:'create',name:'API first',baseRevision:1,idempotencyKey:'api-first'});assert(saved.ok);
 const edit=await studioHandlers.studio_apply_commands({...a,baseRevision:1,idempotencyKey:'api-edit',commands:[{type:'addNode',node:{id:'changed',type:'label',text:'After snapshot'}}]});assert(edit.ok);
 const preview=await studioHandlers.studio_project_versions({...a,action:'preview',versionId:saved.version.id,baseRevision:2});assert(preview.diff.total>0);
 const request={...a,action:'restore',versionId:saved.version.id,baseRevision:2,previewHash:preview.previewHash,idempotencyKey:'api-restore'},restored=await studioHandlers.studio_project_versions(request);assert(restored.ok);assert.equal(restored.appliedRevision,3);const replay=await studioHandlers.studio_project_versions(request);assert(replay.idempotentReplay);assert.equal(studio.store.appliedRevision,3);assert.equal(studio.store.history.at(-1).commands[0].type,'restoreDocument');
 const loaded=new StudioPersistence(dir).initOrLoad().store;assert.equal(loaded.doc.contentHash,studio.store.doc.contentHash);assert(loaded.undo().ok);assert(buildNodeIndex(loaded.doc).byScopedId.has('home/changed'));
});

test('checkpoint rotation preserves undo targets across a discarded redo branch and WAL replay',t=>{
 const{dir,persistence,store,apply}=setup(t);apply([{type:'addNode',node:{id:'title',type:'label',text:'Start',w:240,h:40}}]);for(let i=0;i<160;i++)apply([{type:'setText',nodeId:'title',text:`Forward ${i}`}]);const lastForward=store.appliedRevision;
 for(let i=0;i<60;i++){assert(store.undo().ok);persistence.persistTransaction(store,store.lastHistoryRecord);}
 apply([{type:'setText',nodeId:'title',text:'New branch after sixty undos'}]);const expected=store.doc.contentHash;assert.equal(store.redoStack.length,0);
 // A process recovery may have to replay after an older durable snapshot. Keep
 // original restore targets; remove only the later undo/branch snapshots.
 for(const file of readdirSync(persistence.snapshotsDir)){const revision=Number(file.match(/rev-(\d+)/)?.[1]);if(revision>lastForward)rmSync(join(persistence.snapshotsDir,file));}
 rmSync(persistence.documentJsonPath);const reopened=new StudioPersistence(dir).initOrLoad();assert(reopened.recoveryReport.replayedTransactions>=61);assert.equal(reopened.store.doc.contentHash,expected);assert.equal(reopened.store.redoStack.length,0);assert(reopened.store.undo().ok);
});

test('a checkpoint committed before WAL rotation is not replayed twice and corrupt checkpoint data is explicit',t=>{
 const{persistence,store,apply}=setup(t);apply([{type:'addNode',node:{id:'title',type:'label',text:'Checkpoint'}}]);const oldWal=readFileSync(persistence.transactionsPath),hash=store.doc.contentHash;
 persistence.checkpointHistory(store);writeFileSync(persistence.transactionsPath,oldWal);const restored=new StudioPersistence(persistence.projectDir).initOrLoad();assert.equal(restored.store.doc.contentHash,hash);assert.equal(restored.store.history.length,1);assert(restored.store.undo().ok);
 writeFileSync(persistence.checkpointPath,'{"damaged":true}');const bytes=readFileSync(persistence.documentJsonPath);assert.throws(()=>new StudioPersistence(persistence.projectDir).initOrLoad(),{code:'E_HISTORY_CHECKPOINT_CORRUPT'});assert.deepEqual(readFileSync(persistence.documentJsonPath),bytes);
});
