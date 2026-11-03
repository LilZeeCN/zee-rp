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

async function auditFixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'studio-audit-ui-'));
 const doc=createEmptyStudioDocument({domain:'web'});
 doc.pages[0].root.children=[
  {type:'label',id:'under',text:'Editable under hotspot',x:40,y:80,w:220,h:40},
  {type:'box',id:'hotspot',x:30,y:70,w:260,h:60,fill:'#FFFFFF00',on:{click:[{type:'set-var',name:'clicked',value:1}]}},
  {type:'box',id:'container',layout:'stack',x:40,y:200,w:300,h:180,fill:'#EEEEEE',children:[{type:'label',id:'inside',text:'Inside',x:40,y:40,w:100,h:30}]},
  {type:'label',id:'target',text:'Measure',x:284,y:80,w:100,h:40},
 ];
 doc.variables={clicked:{type:'number',value:0}};
 doc.diagnostics=Array.from({length:8},(_,i)=>({code:'W_AUDIT_'+i,severity:'warning',message:'Layout hint '.repeat(25)}));
 const path=join(dir,'source.json');writeFileSync(path,JSON.stringify(doc));
 const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:path,port:0});
 t.after(async()=>{await studio.close();rmSync(dir,{recursive:true,force:true});});
 const page=await studio.ensureManagedBrowserPage();
 await page.evaluate('window.__STUDIO_APP__.setPanZoom(300,40,0.75)');
 const point=id=>page.evaluate(`(()=>{const r=document.querySelector('[data-node-id="${id}"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 const mouse=(type,p,extra={})=>page.send('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...extra});
 return{studio,page,point,mouse};
}

test('transparent leaf hotspots pass design picking through and retain runtime clicks',async t=>{
 const f=await auditFixture(t),p=await f.point('under');
 await f.mouse('mousePressed',p);await f.mouse('mouseReleased',p);
 assert.deepEqual(await f.page.evaluate('window.__STUDIO_STATE__.selectedIds'),['under']);
 await f.page.evaluate("window.__STUDIO_APP__.selectNodes(['hotspot'],'home')");
 assert.equal(await f.page.evaluate("!!document.querySelector('[data-selection-for=hotspot]')"),true);
 await f.page.evaluate("document.getElementById('mode-interact-btn').click()");
 await f.page.waitForFunction("window.__STUDIO_STATE__.mode==='interact'&&!!window.__STUDIO_STATE__.runtimeState");
 const hit=await f.point('hotspot');await f.mouse('mousePressed',hit);await f.mouse('mouseReleased',hit);
 await f.page.waitForFunction('window.__STUDIO_STATE__.runtimeState.variables.clicked===1');
});

test('three CSS pixels of mouse jitter neither move text nor interrupt double-click editing',async t=>{
 const f=await fixture(t),p=await f.page.evaluate(`(()=>{const r=document.querySelector('[data-node-id=title]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await f.page.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1});
 const q={x:p.x+2,y:p.y+2};await f.page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...q,buttons:1});
 await f.page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...q,button:'left',buttons:0,clickCount:1});
 assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==="title").x'),40);
 assert.equal(f.studio.store.appliedRevision,1);
 await f.page.send('Input.dispatchMouseEvent',{type:'mousePressed',...q,button:'left',buttons:1,clickCount:2});
 assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.editingNodeId'),'title');
});

test('fit respects both side panels even for a large artboard and hints stay collapsed',async t=>{
 const f=await auditFixture(t);
 await f.page.evaluate("window.__STUDIO_APP__.selectNodes(['under'],'home')");
 const hints=await f.page.evaluate(`(()=>{const d=document.querySelector('.inspector-diagnostics');return{exists:!!d,open:d?.open,geometry:!!document.getElementById('insp-w')}})()`);
 assert.deepEqual(hints,{exists:true,open:false,geometry:true});
 const result=await(await fetch(f.studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:1,idempotencyKey:'huge-board',commands:[{type:'resizeArtboard',pageId:'home',w:6000,h:4000}]})})).json();assert(result.ok);
 await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${result.appliedRevision}`);
 await f.page.evaluate("document.getElementById('btn-zoom-fit').click()");
 const bounds=await f.page.evaluate(`(()=>{const b=document.querySelector('.artboard-outer').getBoundingClientRect(),l=document.getElementById('left-sidebar').getBoundingClientRect(),r=document.getElementById('inspector-shell').getBoundingClientRect();return{left:b.left,right:b.right,min:l.right,max:r.left}})()`);
 assert(bounds.left>=bounds.min&&bounds.right<=bounds.max,JSON.stringify(bounds));
});

test('Shift-drag starts a marquee inside a nested container without moving the background',async t=>{
 const f=await auditFixture(t),hash=f.studio.store.doc.contentHash;
 const r=await f.page.evaluate("(()=>{const r=document.querySelector('[data-node-id=container]').getBoundingClientRect();return{x:r.x,y:r.y}})()");
 const start={x:r.x+3,y:r.y+3},end={x:r.x+170*0.75,y:r.y+100*0.75};
 await f.mouse('mousePressed',start,{modifiers:8});
 assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.dragSession?.kind'),'marquee');
 await f.mouse('mouseMoved',end,{modifiers:8});await f.mouse('mouseReleased',end,{modifiers:8});
 const selected=await f.page.evaluate('window.__STUDIO_STATE__.selectedIds');assert(selected.includes('inside'),JSON.stringify(selected));assert(!selected.includes('container'));
 assert.equal(f.studio.store.doc.contentHash,hash);
});

test('Alt hover measures world-space gaps and releases cleanly without editing',async t=>{
 const f=await auditFixture(t),hash=f.studio.store.doc.contentHash;
 await f.page.evaluate("window.__STUDIO_APP__.selectNodes(['under'],'home')");
 const p=await f.point('target');
 await f.page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Alt',code:'AltLeft',modifiers:1});
 await f.mouse('mouseMoved',p,{buttons:0,modifiers:1});
 const distances=await f.page.evaluate("[...document.querySelectorAll('.distance-guide')].map(el=>Number(el.dataset.distance))");
 assert(distances.includes(24),JSON.stringify(distances));
 await f.page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Alt',code:'AltLeft',modifiers:0});
 assert.equal(await f.page.evaluate("document.querySelectorAll('.distance-guide').length"),0);
 assert.equal(f.studio.store.doc.contentHash,hash);
 await f.page.evaluate("document.getElementById('zoom-label').click()");
 assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.zoom'),1);
});

test('pan mounts visible neighbor boards and leaves offscreen pages out of the DOM',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-board-culling-')),doc=createEmptyStudioDocument({domain:'web'});
 doc.pages=Array.from({length:20},(_,i)=>({id:i?'p'+i:'home',name:'Page '+i,domain:'web',canvas:{w:800,h:600},root:{type:'box',id:'root'+i,layout:'stack',w:800,h:600,children:Array.from({length:50},(_,j)=>({type:'label',id:'n'+i+'_'+j,text:'Node '+j,x:20+(j%5)*140,y:20+Math.floor(j/5)*50,w:120,h:30}))}}));
 const path=join(dir,'source.json');writeFileSync(path,JSON.stringify(doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:path,port:0});t.after(async()=>{await studio.close();rmSync(dir,{recursive:true,force:true});});
 const page=await studio.ensureManagedBrowserPage();
 await page.evaluate('window.__STUDIO_APP__.setPanZoom(300,100,0.75)');
 await page.waitForFunction("!document.querySelector('[data-node-id=n19_0]')");
 assert(await page.evaluate("document.querySelectorAll('.studio-node').length")<200);
 await page.evaluate('(()=>{const s=window.__STUDIO_STATE__,pg=s.scene.pages[19];window.__STUDIO_APP__.setPanZoom(300-pg._stageX*0.75,100,0.75)})()');
 await page.waitForFunction("!!document.querySelector('[data-node-id=n19_0]')");
 assert(await page.evaluate("document.querySelectorAll('.studio-node').length")<200);
 const p=await page.evaluate("(()=>{const r=document.querySelector('[data-node-id=n19_0]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
 await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1});
 assert.equal(await page.evaluate('window.__STUDIO_STATE__.dragSession?.pageId'),'p19');
 const drop={x:p.x+30,y:p.y+20};
 await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...drop,button:'left',buttons:1});
 await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...drop,button:'left',buttons:0,clickCount:1});
 await page.waitForFunction('window.__STUDIO_RENDERED_REVISION__===2');
 assert.equal(await page.evaluate("document.getElementById('screen-root').dataset.pageId"),'p19');
 assert.deepEqual(await page.evaluate('window.__STUDIO_STATE__.selectedIds'),['n19_0']);
 assert(studio.store.doc.pages[19].root.children[0].x>20);
 assert.equal(page.scriptErrors.length,0);
});

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
