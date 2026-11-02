import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {startStudioServer} from '../studio/server.mjs';

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'studio-gesture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const doc=createEmptyStudioDocument({domain:'web'});doc.pages[0].root.children=[{type:'label',id:'title',text:'Keep human geometry',x:40,y:80,w:300,h:60,fontSize:26},{type:'label',id:'outside',text:'Outside the gesture',x:40,y:200,w:300,h:40}];const source=join(dir,'source.json');writeFileSync(source,JSON.stringify(doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:source,port:0});t.after(()=>studio.close());const page=await studio.ensureManagedBrowserPage();await page.evaluate(`window.__STUDIO_APP__.setPanZoom(340,100,0.75)`);
 const node=()=>studio.store.doc.pages[0].root.children.find(node=>node.id==='title');
 const key=async(key,code=key)=>{await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code});};
 const begin=async(handle=null)=>{await page.evaluate(`window.__STUDIO_APP__.selectNodes(['title'],'home')`);const selector=handle?`[data-resize-handle="${handle}"][data-node-id="title"]`:'[data-node-id="title"]';const point=await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+40,y:point.y+30,button:'left',buttons:1});assert.equal(await page.evaluate('window.__STUDIO_STATE__.dragSession?.kind'),handle?'resize':'move');return{x:point.x+40,y:point.y+30};};
 const release=async point=>{await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});await page.evaluate('new Promise(resolve=>setTimeout(resolve,80))');};
 const geometry=()=>page.evaluate(`(()=>{const n=window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='title');const r=document.querySelector('[data-node-id="title"]').getBoundingClientRect();return{x:n.x,y:n.y,w:n.w,h:n.h,rect:{x:r.x,y:r.y,w:r.width,h:r.height}}})()`);
 return{studio,page,node,key,begin,release,geometry};
}

test('Escape cancels move and resize previews without committing on the later mouse release',async t=>{
 const f=await fixture(t),hash=f.studio.store.doc.contentHash,original=await f.geometry();
 for(const handle of[null,'se']){const point=await f.begin(handle);await f.key('Escape');assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.dragSession'),null);await f.release(point);assert.equal(f.studio.store.doc.contentHash,hash);assert.deepEqual(await f.geometry(),original);}
 const point=await f.begin();await f.release(point);assert.equal(f.studio.store.appliedRevision,2);assert(f.node().x>40);assert.equal(f.page.scriptErrors.length,0);
});

test('losing focus clears pending geometry and Space before the next gesture',async t=>{
 const f=await fixture(t),hash=f.studio.store.doc.contentHash,original=await f.geometry();const point=await f.begin();await f.page.evaluate(`window.__STUDIO_STATE__.spacePressed=true;window.dispatchEvent(new Event('blur'))`);assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.dragSession'),null);assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.spacePressed'),false);await f.release(point);assert.equal(f.studio.store.doc.contentHash,hash);assert.deepEqual(await f.geometry(),original);
 const next=await f.begin();await f.release(next);assert.equal(f.studio.store.appliedRevision,2);assert.equal(f.page.scriptErrors.length,0);
});

test('an AI revision during a pointer gesture cannot be overwritten by releasing the old gesture',async t=>{
 const f=await fixture(t),point=await f.begin();const changed=await(await fetch(f.studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:1,idempotencyKey:'ai-during-human-drag',commands:[{type:'setProperties',nodeId:'title',properties:{x:180,color:'#9A3412'}},{type:'setText',nodeId:'outside',text:'AI revision must survive'}]})})).json();assert(changed.ok,JSON.stringify(changed));await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${changed.appliedRevision}`);assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.dragSession'),null);await f.release(point);assert.equal(f.studio.store.appliedRevision,changed.appliedRevision);assert.equal(f.node().x,180);const geometry=await f.geometry();assert.equal(geometry.x,180);assert.equal(f.page.scriptErrors.length,0);
});

test('a delayed competing snapshot still rejects the original gesture revision and recovers the authority',async t=>{
 const f=await fixture(t);await f.page.evaluate(`(async()=>{const previous=await(await fetch('/api/context')).json();window.__gestureFetch=window.fetch;window.__gestureRequests=[];window.__STUDIO_STATE__.sse.close();window.fetch=(path,...args)=>{if(path==='/api/commands')window.__gestureRequests.push(JSON.parse(args[0].body));return path==='/api/context'?Promise.resolve(new Response(JSON.stringify(previous),{status:200,headers:{'Content-Type':'application/json'}})):window.__gestureFetch(path,...args)}})()`);const point=await f.begin();
 const changed=await(await fetch(f.studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:1,idempotencyKey:'delayed-ai-snapshot',commands:[{type:'setProperties',nodeId:'title',properties:{x:180}}]})})).json();assert(changed.ok);assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.appliedRevision'),1);await f.release(point);await f.page.waitForFunction(`window.__STUDIO_LAST_TOAST__?.tone==='error'`);const requests=await f.page.evaluate('window.__gestureRequests');assert.equal(requests.length,1);assert.equal(requests[0].baseRevision,1);assert.equal(f.node().x,180);assert.equal(f.studio.store.appliedRevision,2);await f.page.evaluate('window.fetch=window.__gestureFetch;delete window.__gestureFetch');await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===2`);assert.equal((await f.geometry()).x,180);assert.equal(f.page.scriptErrors.length,0);
});

test('rotation handle supports rotate preview, Escape cancel, commit, single undo, and locked node protection',async t=>{
 const f=await fixture(t),hash=f.studio.store.doc.contentHash;
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['title'],'home')`);
 const rotHandle=await f.page.evaluate(`(()=>{const r=document.querySelector('[data-rotate-handle="rotate"][data-node-id="title"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 // Start rotate and cancel with Escape
 await f.page.send('Input.dispatchMouseEvent',{type:'mousePressed',...rotHandle,button:'left',buttons:1,clickCount:1});
 await f.page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rotHandle.x+80,y:rotHandle.y+40,button:'left',buttons:1});
 assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.dragSession?.kind'),'rotate');
 await f.key('Escape');
 assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.dragSession'),null);
 await f.release({x:rotHandle.x+80,y:rotHandle.y+40});
 assert.equal(f.studio.store.doc.contentHash,hash);
 assert.equal(f.node().rotation,undefined);

 // Commit rotation
 await f.page.send('Input.dispatchMouseEvent',{type:'mousePressed',...rotHandle,button:'left',buttons:1,clickCount:1});
 await f.page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rotHandle.x+90,y:rotHandle.y+50,button:'left',buttons:1});
 await f.release({x:rotHandle.x+90,y:rotHandle.y+50});
 await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===2`);
 assert.ok(Number.isFinite(f.node().rotation)&&f.node().rotation!==0,`rotation 应回读非零角度: ${f.node().rotation}`);

 // Single undo restores original unrotated state
 await f.page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:4});
 await f.page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:0});
 await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===3`);
 assert.equal(f.node().rotation,undefined);
 assert.equal(f.studio.store.doc.contentHash,hash);
 assert.equal(f.page.scriptErrors.length,0);
});
