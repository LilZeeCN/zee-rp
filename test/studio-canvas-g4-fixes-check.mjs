import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {startStudioServer} from '../studio/server.mjs';

// G4 文字与数值输入修复（2026-10-31 P03/T-A-3/T-A-4/T-AR-1/T-AR-2）定向检查。
// P03 新建文本默认可换行 + 检查器换行开关；T-A-3 setText 自动宽度封顶 + 截断诊断带 nodeId；
// T-AR-2 setText 宽度允许回缩；T-A-4/T-AR-1 X/Y/字号输入提交校验与越界回弹。
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'studio-g4-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const doc=createEmptyStudioDocument();
 doc.pages[0].root.children[0].children=[
  {type:'label',id:'ta_label',name:'TA标签',x:147,y:100,w:220,h:36,fontSize:16,text:'原始标签'},
  {type:'label',id:'shrink_label',name:'回缩',x:60,y:200,w:300,h:24,fontSize:14,text:'一段用于测试回缩的较长文本内容'},
  {type:'label',id:'right_label',name:'右对齐',x:100,y:260,w:300,h:24,fontSize:14,align:'right',text:'右对齐回缩测试文本内容较长一些'},
  {type:'label',id:'wrap_label',name:'可换行',x:40,y:330,w:120,h:'hug',wrap:true,fontSize:14,text:'这是一段会换行的较长文本内容用于验证高度增长'},
 ];
 const source=join(dir,'source.json');writeFileSync(source,JSON.stringify(doc));
 const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:source,port:0});
 t.after(()=>studio.close());
 const page=await studio.ensureManagedBrowserPage();
 const child=(id)=>studio.store.doc.pages[0].root.children[0].children.find(n=>n.id===id);
 return {studio,page,child};
}
const apply=(studio,body)=>fetch(`${studio.url}/api/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
const clipCodes=(res)=>(res.diagnostics||[]).filter(d=>d.code==='E_TEXT_CLIP');

test('T-AR-2 setText(autoSize:true) 后 label 宽度允许回缩到新文本宽度',async t=>{
 const f=await fixture(t);
 const res=await apply(f.studio,{baseRevision:1,idempotencyKey:'g4-shrink',commands:[{type:'setText',nodeId:'shrink_label',text:'短',autoSize:true}]});
 assert(res.ok,JSON.stringify(res));
 const node=f.child('shrink_label');
 assert(node.w<60,`宽度应回缩: w=${node.w}`);
 assert(clipCodes(res).length===0,`正常回缩不应产生截断诊断: ${JSON.stringify(clipCodes(res))}`);
});
test('T-AR-2 右对齐 label 显式 autoSize 回缩时保持右缘不动',async t=>{
 const f=await fixture(t);
 const res=await apply(f.studio,{baseRevision:1,idempotencyKey:'g4-shrink-right',commands:[{type:'setText',nodeId:'right_label',text:'短',autoSize:true}]});
 assert(res.ok,JSON.stringify(res));
 const node=f.child('right_label');
 assert(node.w<60,`宽度应回缩: w=${node.w}`);
 assert.equal(node.x+node.w,400,`右缘应保持 x+w=400: ${node.x}+${node.w}`);
});
test('T-A-3 setText 自动加宽封顶在画板内且截断诊断非空含 nodeId',async t=>{
 const f=await fixture(t);
 const res=await apply(f.studio,{baseRevision:1,idempotencyKey:'g4-cap',commands:[{type:'setText',nodeId:'ta_label',text:'ABC混排123 你好🎨🚀 English & 中文',autoSize:true}]});
 assert(res.ok,JSON.stringify(res));
 const node=f.child('ta_label');
 assert(node.w<=255,`加宽应封顶在画板内(402-147=255): w=${node.w}`);
 assert(node.x+node.w<=402,`节点不应溢出画板: x+w=${node.x+node.w}`);
 const clips=clipCodes(res);
 assert(clips.length>0,`响应 diagnostics 应包含截断诊断: ${JSON.stringify(res.diagnostics)}`);
 assert(clips.every(d=>typeof d.nodeId==='string'&&d.nodeId.length>0),`每条截断诊断应带 nodeId: ${JSON.stringify(clips)}`);
 assert(clips.some(d=>d.nodeId==='ta_label'&&d.pageId==='home'),'截断诊断应能定位 ta_label');
 assert(String(res.humanReadableSummary?.diagnosticsSummary||'').includes('截断/溢出'),'摘要应报告截断风险');
});
test('setText 默认为纯文字编辑并完整保留 label 几何',async t=>{
 const f=await fixture(t);
 const before=f.child('shrink_label');
 const geometry={x:before.x,y:before.y,w:before.w,h:before.h};
 const res=await apply(f.studio,{baseRevision:1,idempotencyKey:'g4-preserve-geometry',commands:[{type:'setText',nodeId:'shrink_label',text:'短'}]});
 assert(res.ok,JSON.stringify(res));
 const after=f.child('shrink_label');
 assert.deepEqual({x:after.x,y:after.y,w:after.w,h:after.h},geometry);
});
test('P03 新建文本默认可换行',async t=>{
 const f=await fixture(t);
 const rev=f.studio.store.doc.revision;
 await f.page.evaluate(`document.getElementById('btn-add-text').click()`);
 await f.page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__>${rev}`);
 const added=studioNewText(f);
 assert(added,`应找到新建文本节点`);
 assert.equal(added.wrap,true,`新建文本模型应默认 wrap:true: ${JSON.stringify({wrap:added.wrap})}`);
});
function studioNewText(f){
 return f.studio.store.doc.pages[0].root.children[0].children.find(n=>n.name==='新建文本');
}
test('P03 检查器提供换行开关，开启后 label 换行且 h 随行数增长',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['ta_label'],'home')`);
 await f.page.waitForFunction(`!!document.getElementById('insp-wrap')`);
 const checked=await f.page.evaluate(`document.getElementById('insp-wrap').checked`);
 assert.equal(checked,false,'ta_label 初始未换行时开关应为未选中');
 const res=await apply(f.studio,{baseRevision:f.studio.store.doc.revision,idempotencyKey:'g4-wrap-off-hug',commands:[{type:'setText',nodeId:'ta_label',text:'原始标签'}]});
 assert(res.ok,JSON.stringify(res));
 await f.page.waitForFunction(`!!document.getElementById('insp-wrap')&&!document.getElementById('insp-wrap').checked`);
 // 打开开关
 await f.page.evaluate(`(()=>{const el=document.getElementById('insp-wrap');el.checked=true;el.dispatchEvent(new Event('change'));})()`);
 await f.page.waitForFunction(`(()=>{const n=window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label');return n&&n.wrap===true})()`);
 const wrapStyle=await f.page.evaluate(`(()=>{const el=document.querySelector('[data-node-id="ta_label"]');return el?el.getAttribute('style'):''})()`);
 assert(wrapStyle.includes('white-space:pre-wrap'),`wrap 后不应再 nowrap: ${wrapStyle}`);
 // 带宽度 + hug 高度的换行 label，文本超宽时 h 应增长（与新建文本默认 h:'hug' 一致）
 const hugRes=await apply(f.studio,{baseRevision:f.studio.store.doc.revision,idempotencyKey:'g4-wrap-hug-h',commands:[{type:'resizeNode',nodeId:'ta_label',h:'hug'}]});
 assert(hugRes.ok,JSON.stringify(hugRes));
 await f.page.waitForFunction(`(()=>{const n=window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label');return n&&n.h==='hug'})()`);
 const sceneH0=(await f.page.evaluate(`window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='ta_label')`)).h;
 const grow=await apply(f.studio,{baseRevision:f.studio.store.doc.revision,idempotencyKey:'g4-wrap-grow',commands:[{type:'setText',nodeId:'ta_label',text:'这是一段相当长的文本内容用来验证开启换行后高度会随行数增长而不是横向溢出'}]});
 assert(grow.ok,JSON.stringify(grow));
 const sceneNode=await f.page.evaluate(`window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='ta_label')`);
 assert(sceneNode.h>sceneH0,`换行 label 高度应随行数增长: h0=${sceneH0} h=${sceneNode.h}`);
});
test('T-A-4/T-AR-1 X 输入清空/越界回弹原值并提示，负值给出提示',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['ta_label'],'home')`);
 await f.page.waitForFunction(`!!document.getElementById('insp-x')`);
 // -50：提示 + 提交（节点移动但界内）
 await f.page.evaluate(`(()=>{const el=document.getElementById('insp-x');el.value='-50';el.dispatchEvent(new Event('change'));})()`);
 await f.page.waitForFunction(`(()=>{const n=window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label');return n&&n.x===-50})()`);
 const negToast=await f.page.evaluate('window.__STUDIO_LAST_TOAST__');
 assert(negToast&&negToast.tone==='warn'&&String(negToast.message).includes('X 为负'),`负值应有校验提示: ${JSON.stringify(negToast)}`);
 // 99999：回弹 + 提示，节点不移动
 await f.page.evaluate(`(()=>{const el=document.getElementById('insp-x');el.value='99999';el.dispatchEvent(new Event('change'));})()`);
 const xAfterBig=await f.page.evaluate(`(()=>{const el=document.getElementById('insp-x');const n=window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label');return{value:el.value,x:n.x}})()`);
 assert.equal(xAfterBig.x,-50,`越界提交后节点不应移动: ${JSON.stringify(xAfterBig)}`);
 assert.equal(xAfterBig.value,'-50',`越界提交后输入框应回弹原值: ${JSON.stringify(xAfterBig)}`);
 const bigToast=await f.page.evaluate('window.__STUDIO_LAST_TOAST__');
 assert(bigToast&&bigToast.tone==='warn'&&String(bigToast.message).includes('超出安全范围'),`越界应有校验提示: ${JSON.stringify(bigToast)}`);
 // 清空：回弹 + 提示，原值保留
 await f.page.evaluate(`(()=>{const el=document.getElementById('insp-x');el.value='';el.dispatchEvent(new Event('change'));})()`);
 const xAfterClear=await f.page.evaluate(`(()=>{const el=document.getElementById('insp-x');const n=window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label');return{value:el.value,x:n.x}})()`);
 assert.equal(xAfterClear.x,-50,`清空提交后原值应保留: ${JSON.stringify(xAfterClear)}`);
 assert.equal(xAfterClear.value,'-50',`清空提交后输入框应回弹: ${JSON.stringify(xAfterClear)}`);
 const clearToast=await f.page.evaluate('window.__STUDIO_LAST_TOAST__');
 assert(clearToast&&clearToast.tone==='warn'&&String(clearToast.message).includes('请输入有效数值'),`清空应有校验提示: ${JSON.stringify(clearToast)}`);
});
test('T-A-4 字号输入清空回弹，非法负值被服务端拒绝并提示',async t=>{
 const f=await fixture(t);
 await f.page.evaluate(`window.__STUDIO_APP__.selectNodes(['ta_label'],'home')`);
 await f.page.waitForFunction(`!!document.getElementById('insp-font-size')`);
 const fsBefore=await f.page.evaluate(`window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label').fontSize`);
 assert.equal(fsBefore,16);
 // 清空：回弹 + 提示
 await f.page.evaluate(`(()=>{const el=document.getElementById('insp-font-size');el.value='';el.dispatchEvent(new Event('change'));})()`);
 const afterClear=await f.page.evaluate(`(()=>{const el=document.getElementById('insp-font-size');const n=window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label');return{value:el.value,fontSize:n.fontSize}})()`);
 assert.equal(afterClear.fontSize,16,`清空提交后原值应保留: ${JSON.stringify(afterClear)}`);
 assert.equal(afterClear.value,'16',`清空提交后输入框应回弹: ${JSON.stringify(afterClear)}`);
 const clearToast=await f.page.evaluate('window.__STUDIO_LAST_TOAST__');
 assert(clearToast&&clearToast.tone==='warn',`清空应有校验提示: ${JSON.stringify(clearToast)}`);
 // 越界 99999：客户端回弹
 await f.page.evaluate(`(()=>{const el=document.getElementById('insp-font-size');el.value='99999';el.dispatchEvent(new Event('change'));})()`);
 const afterBig=await f.page.evaluate(`(()=>{const el=document.getElementById('insp-font-size');const n=window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label');return{value:el.value,fontSize:n.fontSize}})()`);
 assert.equal(afterBig.fontSize,16,`越界字号不应写入: ${JSON.stringify(afterBig)}`);
 assert.equal(afterBig.value,'16',`越界字号输入框应回弹: ${JSON.stringify(afterBig)}`);
 // 负值 -50：交由服务端校验拒绝（400），提示 + 回弹
 const t0=await f.page.evaluate('Date.now()');
 await f.page.evaluate(`(()=>{const el=document.getElementById('insp-font-size');el.value='-50';el.dispatchEvent(new Event('change'));})()`);
 await f.page.waitForFunction(`window.__STUDIO_LAST_TOAST__&&window.__STUDIO_LAST_TOAST__.tone==='error'&&window.__STUDIO_LAST_TOAST__.timestamp>${t0}`,5000);
 const afterNeg=await f.page.evaluate(`window.__STUDIO_STATE__.doc.pages[0].root.children[0].children.find(n=>n.id==='ta_label').fontSize`);
 assert.equal(afterNeg,16,`非法负字号应被拒绝: ${afterNeg}`);
});
