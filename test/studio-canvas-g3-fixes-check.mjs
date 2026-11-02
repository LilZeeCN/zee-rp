import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {startStudioServer} from '../studio/server.mjs';

// G3 画布交互回归修复（2026-10-31 P01/P02/P05/P06/P09/P10）定向检查。
// P01 坞内新建落入选中容器 + 图层行拖拽换父；P02 切页后画板滚入视口；P05 布局下拉合并同标签；
// P06 拖入容器中心重挂置顶；P09 手柄按缩放显隐；P10 光标锚定缩放 + shift 横向平移。
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'studio-g3-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const doc=createEmptyStudioDocument({domain:'web'});
 doc.pages[0].root.children=[
  {type:'box',id:'card',name:'卡片',x:620,y:320,w:220,h:180,radius:12,fill:'#DCEFE6',children:[]},
  {type:'button',id:'btn',name:'按钮',text:'Move me',x:60,y:60,w:120,h:40,fill:'#2E6F57'},
  {type:'label',id:'tiny',name:'小节点',text:'tiny',x:60,y:220,w:36,h:18,fontSize:12},
  {type:'label',id:'tall',name:'高节点',text:'tall',x:60,y:300,w:36,h:320,fontSize:12},
 ];
 const source=join(dir,'source.json');writeFileSync(source,JSON.stringify(doc));
 const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:source,port:0});
 t.after(()=>studio.close());
 const page=await studio.ensureManagedBrowserPage();
 await page.evaluate('window.__STUDIO_APP__.setPanZoom(260,140,0.6)');
 const child=(id)=>studio.store.doc.pages[0].root.children.find(n=>n.id===id);
 return {studio,page,child};
}
const center=async(page,selector)=>page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
const drag=async(page,from,to)=>{await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});await page.evaluate('new Promise(r=>setTimeout(r,120))');};

test('P01a 选中容器后坞内新建文本落入该容器',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['card'],'home')`);
 const rev=f.studio.store.doc.revision;
 await f.page.evaluate(`document.getElementById('btn-add-text').click()`);
 await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__>${rev}`);
 const card=f.studio.store.doc.pages[0].root.children.find(n=>n.id==='card');
 const added=card.children.find(c=>c.name==='新建文本');
 assert(added,`新文本应在 card 容器内: ${JSON.stringify(card.children.map(c=>c.id))}`);
 assert.equal(added.type,'label');
 assert.equal(f.studio.store.doc.pages[0].root.children.some(n=>n.name==='新建文本'),false,'不应落在页面根');
});

test('P01b 图层行拖拽到容器行完成换父并保持视觉位置',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['btn'],'home')`);
 const before=await f.page.evaluate(`(()=>{const n=window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='btn');return{x:n.x,y:n.y}})()`);
 await f.page.evaluate(`(()=>{
  const dt=new DataTransfer();
  document.querySelector('[data-layer-select="btn"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
  const target=document.querySelector('[data-layer-select="card"]');
  target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
  target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
 })()`);
 await f.page.waitForFunction(`(()=>{const card=window.__STUDIO_STATE__.doc.pages[0].root.children.find(n=>n.id==='card');return card&&card.children.some(c=>c.id==='btn')})()`);
 const card=f.studio.store.doc.pages[0].root.children.find(n=>n.id==='card');
 assert.equal(card.children[card.children.length-1].id,'btn','置顶=children 末位');
 assert.equal(f.studio.store.doc.pages[0].root.children.some(n=>n.id==='btn'),false,'已离开页面根');
 const after=await f.page.evaluate(`(()=>{const n=window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='btn');return{x:n.x,y:n.y}})()`);
 assert(Math.abs(after.x-before.x)<=1&&Math.abs(after.y-before.y)<=1,`视觉位置不变: ${JSON.stringify({before,after})}`);
});

test('P02 切到画板在视口外的页面时 pan 自动跟随',async t=>{
 const f=await fixture(t);
 const added=await(await fetch(f.studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:1,idempotencyKey:'g3-add-page',commands:[{type:'addPage',pageId:'page_2',name:'页面 2',autoUniqueId:true}]})})).json();
 assert(added.ok,JSON.stringify(added));
 await f.page.waitForFunction(`window.__STUDIO_STATE__.doc.pages.some(p=>p.id==='page_2')`);
 await f.page.evaluate(`window.__STUDIO_APP__.setPanZoom(900,300,0.6)`);
 const page2Left=await f.page.evaluate(`(()=>{const pg=window.__STUDIO_STATE__.scene.pages.find(p=>p.id==='page_2');return{left:(pg._stageX??60)*0.6+window.__STUDIO_STATE__.panX,vw:window.innerWidth}})()`);
 assert(page2Left.left>page2Left.vw,`前置：page_2 画板在视口外 left=${page2Left.left} vw=${page2Left.vw}`);
 const panBefore=await f.page.evaluate('({x:window.__STUDIO_STATE__.panX,y:window.__STUDIO_STATE__.panY})');
 await f.page.evaluate(`document.querySelector('[data-page-select="page_2"]').click()`);
 await f.page.waitForFunction(`window.__STUDIO_STATE__.activePageId==='page_2'&&window.__STUDIO_RENDERED_REVISION__>=1`);
 await f.page.evaluate('new Promise(r=>setTimeout(r,80))');
 const panAfter=await f.page.evaluate('({x:window.__STUDIO_STATE__.panX,y:window.__STUDIO_STATE__.panY})');
 assert.notDeepEqual(panAfter,panBefore,`pan 应变化: ${JSON.stringify({panBefore,panAfter})}`);
 const rect=await f.page.evaluate(`(()=>{const el=document.getElementById('screen-root');if(!el)return null;const r=el.getBoundingClientRect();return{l:r.left,r:r.right,t:r.top,b:r.bottom,vw:window.innerWidth,vh:window.innerHeight}})()`);
 assert(rect,'当前页画板 screen-root 应存在');
 assert(rect.l<rect.vw&&rect.r>0&&rect.t<rect.vh&&rect.b>0,`画板进入视口: ${JSON.stringify(rect)}`);
});

test('P05 布局模式下拉不再出现两个「自由定位」同标签选项',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['card'],'home')`);
 const info=await f.page.evaluate(`(()=>{const sel=document.getElementById('insp-layout');return{opts:[...sel.options].map(o=>({v:o.value,t:o.textContent}))}})()`);
 assert.equal(info.opts.filter(o=>o.t.includes('自由定位')).length,1,`自由定位选项应唯一: ${JSON.stringify(info.opts)}`);
 assert.equal(info.opts.some(o=>o.v==='free'),false,'free 别名选项应移除');
 assert(info.opts.some(o=>o.v==='row')&&info.opts.some(o=>o.v==='column')&&info.opts.some(o=>o.v==='grid'));
});

test('P06 拖拽子节点到容器中心释放后重挂为子节点并置顶',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['btn'],'home')`);
 const from=await center(f.page,'[data-node-id="btn"]');
 const to=await center(f.page,'[data-node-id="card"]');
 const rev=f.studio.store.doc.revision;
 await f.page.send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
 await f.page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
 assert.equal(await f.page.evaluate('window.__STUDIO_STATE__.dragSession?.kind'),'move');
 await f.page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
 await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__>${rev}`);
 const root=f.studio.store.doc.pages[0].root;
 const card=root.children.find(n=>n.id==='card');
 assert.equal(card.children[card.children.length-1].id,'btn',`btn 应为 card 末位子节点（置顶）: ${JSON.stringify(card.children.map(c=>c.id))}`);
 assert.equal(root.children.some(n=>n.id==='btn'),false,'btn 不再是页面根子节点');
 const scene=await f.page.evaluate(`(()=>{const n=window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='btn');const c=window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='card');return{btn:{x:n.x,y:n.y,w:n.w,h:n.h},card:{x:c.x,y:c.y,w:c.w,h:c.h}}})()`);
 assert(scene.btn.x>=scene.card.x&&scene.btn.x+scene.btn.w<=scene.card.x+scene.card.w+1&&scene.btn.y>=scene.card.y&&scene.btn.y+scene.btn.h<=scene.card.y+scene.card.h+1,`btn 应留在释放位置（容器内）: ${JSON.stringify(scene)}`);
});

test('P09 同缩放等级下大/小节点手柄数量一致（按缩放隐藏边中点）',async t=>{
 const f=await fixture(t);
 const count=async(id,zoom)=>{await f.page.evaluate(`window.__STUDIO_APP__.setPanZoom(0,0,${zoom});window.__STUDIO_APP__.selectNodes(['${id}'],'home')`);return f.page.evaluate(`document.querySelectorAll('[data-resize-handle][data-node-id="${id}"]').length`)};
 const tinySmall=await count('tiny',0.35),tallSmall=await count('tall',0.35);
 assert.equal(tinySmall,4,`zoom 0.35 小节点只留 4 角手柄，得 ${tinySmall}`);
 assert.equal(tallSmall,4,`zoom 0.35 高节点也只留 4 角手柄（不再按渲染高度区分），得 ${tallSmall}`);
 const tinyBig=await count('tiny',0.8);
 assert.equal(tinyBig,8,`zoom 0.8 小节点恢复 8 手柄，得 ${tinyBig}`);
});

test('P10 ctrl+滚轮光标锚定缩放、shift+滚轮横向平移',async t=>{
 const f=await fixture(t);
 await f.page.evaluate('window.__STUDIO_APP__.setPanZoom(200,100,0.6)');
 const cx=500,cy=400;
 const worldAt=()=>f.page.evaluate(`(()=>{const s=window.__STUDIO_STATE__;return{x:(${cx}-s.panX)/s.zoom,y:(${cy}-s.panY)/s.zoom,z:s.zoom,p:{x:s.panX,y:s.panY}}})()`);
 const before=await worldAt();
 await f.page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:cx,y:cy,deltaX:0,deltaY:-240,modifiers:2});
 await f.page.evaluate('new Promise(r=>setTimeout(r,60))');
 const afterZoom=await worldAt();
 assert.notEqual(afterZoom.z,before.z,'缩放应变化');
 assert(Math.abs(afterZoom.x-before.x)<=1&&Math.abs(afterZoom.y-before.y)<=1,`光标下世界坐标位移 ≤1px: ${JSON.stringify({before,afterZoom})}`);
 const panBefore=afterZoom.p;
 await f.page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:cx,y:cy,deltaX:0,deltaY:240,modifiers:8});
 await f.page.evaluate('new Promise(r=>setTimeout(r,60))');
 const afterShift=await worldAt();
 assert.equal(afterShift.p.x,panBefore.x-240,`shift+滚轮 panX 横移 -240: ${JSON.stringify({panBefore,after:afterShift.p})}`);
 assert.equal(afterShift.p.y,panBefore.y,'shift+滚轮 panY 不变');
 assert.equal(f.page.scriptErrors.length,0);
});
