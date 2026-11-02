import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {startStudioServer} from '../studio/server.mjs';
import {StudioRuntimeSession} from '../studio/runtime.mjs';
import {describeAuthoring} from '../studio/authoring-help.mjs';
import {studioTools} from '../studio/mcp-adapter.mjs';

// G5 预览态隔离与运行态修复（2026-10-31 T-D-1/T-DR-1/T-D-2）定向检查。
// T-D-1 预览态撤销/重做被服务端 E_PREVIEW_MODE_UNDO 拦截，revision 不变（隔离承诺）；
// T-DR-1 E_RUNTIME_NODE_HIDDEN 返回 suggestion 恢复指引（前端不再静默）；
// T-D-2 语义层不做遮挡/hitTest 校验已文档声明（describe workflow + run_scenario 工具描述）。
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'studio-g5-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const doc=createEmptyStudioDocument();
 doc.pages[0].root.children[0].children=[
  {type:'button',id:'g5_dirty_nav',name:'弄脏运行态',x:20,y:20,w:300,h:44,text:'隐藏容器',
   onClick:[{type:'hide',target:'g5_wrap'}]},
  {type:'box',id:'g5_wrap',name:'容器',x:20,y:120,w:300,h:100,children:[
   {type:'button',id:'g5_hidden_btn',name:'隐藏目标',x:10,y:10,w:200,h:44,text:'点我',
    onClick:[{type:'set-text',target:'g5_label',text:'clicked'}]},
  ]},
  {type:'label',id:'g5_label',name:'结果',x:20,y:260,w:200,h:24,fontSize:14,text:'初始'},
 ];
 const source=join(dir,'source.json');writeFileSync(source,JSON.stringify(doc));
 const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:source,port:0});
 t.after(()=>studio.close());
 const page=await studio.ensureManagedBrowserPage();
 return {studio,page};
}
const post=async(studio,path,body)=>{
 const res=await fetch(`${studio.url}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {status:res.status,json:await res.json()};
};

test('T-D-1 预览态撤销/重做被 E_PREVIEW_MODE_UNDO 拦截，revision 不变',async t=>{
 const f=await fixture(t);
 const rev0=f.studio.store.doc.revision;
 const hash0=f.studio.store.doc.contentHash;
 // 建一笔可撤销事务（设计态写入）
 const tx=await post(f.studio,'/api/commands',{baseRevision:rev0,idempotencyKey:'g5-tx',commands:[{type:'setText',nodeId:'g5_label',text:'变更后'}]});
 assert(tx.json.ok,JSON.stringify(tx.json).slice(0,300));
 const rev1=f.studio.store.doc.revision;
 assert(rev1>rev0,'事务应推进 revision');
 // 进入预览（运行态）
 const rt=await post(f.studio,'/api/runtime/reset',{startPageId:'home'});
 assert(rt.json.ok,JSON.stringify(rt.json).slice(0,300));
 // 预览态撤销/重做均被拒绝
 const undo=await post(f.studio,'/api/undo',{clientId:'g5-test'});
 assert.equal(undo.status,400,`预览态撤销应 400: ${JSON.stringify(undo.json)}`);
 assert.equal(undo.json.code,'E_PREVIEW_MODE_UNDO',`错误码应为 E_PREVIEW_MODE_UNDO: ${undo.json.code}`);
 assert.match(undo.json.message,/退出预览|重置会话/,'报错应给出恢复路径');
 assert.equal(f.studio.store.doc.revision,rev1,'撤销被拒后 revision 必须不变');
 const redo=await post(f.studio,'/api/redo',{clientId:'g5-test'});
 assert.equal(redo.status,400,'预览态重做同样应 400');
 assert.equal(redo.json.code,'E_PREVIEW_MODE_UNDO');
 assert.equal(f.studio.store.doc.revision,rev1,'重做被拒后 revision 必须不变');
 // 退出预览后撤销恢复正常能力（对照）
 const exit=await post(f.studio,'/api/runtime/exit',{});
 assert(exit.json.ok,`exit 应成功: ${JSON.stringify(exit.json)}`);
 const undoDesign=await post(f.studio,'/api/undo',{clientId:'g5-test'});
 assert.ok(undoDesign.json.ok,`设计态撤销应成功: ${JSON.stringify(undoDesign.json).slice(0,300)}`);
 assert.equal(f.studio.store.doc.revision,rev1+1,'设计态撤销推进到新 revision');
 assert.equal(f.studio.store.doc.contentHash,hash0,'设计态撤销后内容哈希应回到事务前');
});

test('T-D-1 预览态前端撤销被禁用并提示，退出预览后恢复',async t=>{
 const f=await fixture(t);
 // 先建一笔可撤销事务，保证设计态有历史可撤
 const revBase=f.studio.store.doc.revision;
 const tx=await post(f.studio,'/api/commands',{baseRevision:revBase,idempotencyKey:'g5-fe-tx',commands:[{type:'setText',nodeId:'g5_label',text:'前端撤销目标'}]});
 assert(tx.json.ok,JSON.stringify(tx.json).slice(0,200));
 await f.page.evaluate(`document.querySelector('#mode-switcher button[data-mode="interact"]').click()`);
 await f.page.waitForFunction(`window.__STUDIO_STATE__&&window.__STUDIO_STATE__.mode==='interact'`);
 const rev0=f.studio.store.doc.revision;
 await f.page.evaluate(`document.getElementById('btn-undo').click()`);
 await new Promise(r=>setTimeout(r,150));
 const toast=await f.page.evaluate('window.__STUDIO_LAST_TOAST__');
 assert(toast&&toast.tone==='warn'&&/撤销已禁用/.test(toast.message),`应弹 warn 提示撤销已禁用: ${JSON.stringify(toast)}`);
 assert.equal(f.studio.store.doc.revision,rev0,'预览态点撤销后 revision 不变（守住了隔离）');
 // 退出预览：同按钮恢复真实撤销能力
 await f.page.evaluate(`document.querySelector('#mode-switcher button[data-mode="design"]').click()`);
 await f.page.waitForFunction(`window.__STUDIO_STATE__&&window.__STUDIO_STATE__.mode==='design'`);
 await new Promise(r=>setTimeout(r,150));
 await f.page.evaluate(`document.getElementById('btn-undo').click()`);
 await f.page.waitForFunction(`window.__STUDIO_STATE__&&window.__STUDIO_STATE__.appliedRevision===${rev0+1}`);
 const revNow=f.studio.store.doc.revision;
 assert.equal(revNow,rev0+1,'退出预览后撤销应真实执行（推进到撤销 revision）');
});

test('T-DR-1 E_RUNTIME_NODE_HIDDEN 携带 suggestion 恢复指引（运行态弄脏后真实点击）',async t=>{
 const f=await fixture(t);
 // 1) 弄脏运行态：隐藏容器（其内部按钮随之不可见）
 const rt=await post(f.studio,'/api/runtime/reset',{startPageId:'home'});
 assert(rt.json.ok);
 const dirty=await post(f.studio,'/api/runtime/click',{targetId:'g5_dirty_nav'});
 assert(dirty.json.ok,JSON.stringify(dirty.json).slice(0,300));
 // 2) 对不可见目标点击：400 + suggestion
 const hidden=await post(f.studio,'/api/runtime/click',{targetId:'g5_hidden_btn'});
 assert.equal(hidden.status,400,`弄脏后点击应 400: ${JSON.stringify(hidden.json)}`);
 assert.equal(hidden.json.code,'E_RUNTIME_NODE_HIDDEN',`错误码应保留 E_RUNTIME_NODE_HIDDEN: ${hidden.json.code}`);
 assert(hidden.json.suggestion,'必须携带 suggestion 恢复指引');
 assert.match(hidden.json.suggestion,/重置会话|runtime\/reset/,'suggestion 应指向恢复路径');
 // 3) 语义层直抛同样带 suggestion
 const rtSession=new StudioRuntimeSession(f.studio.store.doc,{projectDir:f.studio.projectDir});
 rtSession.click('g5_dirty_nav');
 let thrown=null;
 try { rtSession.click('g5_hidden_btn'); } catch(err) { thrown=err; }
 assert.equal(thrown?.code,'E_RUNTIME_NODE_HIDDEN',`session 层应抛 E_RUNTIME_NODE_HIDDEN: ${thrown?.code}`);
 assert(thrown.suggestion,'session 层同样携带 suggestion');
 // 4) 重置后恢复：同目标可点
 await post(f.studio,'/api/runtime/reset',{startPageId:'home'});
 const ok=await post(f.studio,'/api/runtime/click',{targetId:'g5_hidden_btn'});
 assert(ok.json.ok,`重置后应可点击: ${JSON.stringify(ok.json).slice(0,200)}`);
});

test('T-D-2 describe(workflow) 与 run_scenario 工具描述声明语义层不做遮挡/hitTest 校验',async t=>{
 const wf=describeAuthoring({topic:'workflow'});
 const seqText=JSON.stringify(wf.sequence);
 assert(/语义执行层不做遮挡\/hitTest校验/.test(seqText),`describe workflow 应声明遮挡口径: ${seqText.slice(0,300)}`);
 assert(/通过≠真实可点/.test(seqText),'声明应说明通过≠真实可点');
 assert(/explore\.states真实浏览器指针/.test(seqText),'声明应指向 explore.states 真实指针核验');
 const tool=studioTools.find(t2=>t2.name==='studio_run_scenario');
 assert(tool,'studioTools 应含 studio_run_scenario');
 assert(/不做遮挡\/hitTest校验/.test(tool.description),`run_scenario 工具描述应声明遮挡口径: ${tool.description.slice(0,200)}`);
 assert(/真实浏览器指针/.test(tool.description),'工具描述应指路真实指针核验');
});
