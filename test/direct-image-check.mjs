import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field, walkNodes } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { placeMaster } from '../scripts/place-master.mjs';
import { setMasterOverrides } from '../scripts/set-master-overrides.mjs';
import { fillPanelState } from '../scripts/fill-panel-state.mjs';
import { removePanelStateContent, resolvePanelState } from '../scripts/remove-panel-state-content.mjs';

const nameOf=o=>field(field(o.body,'name-block')??{},'text')?.text;
const packageGuid=g=>g.roots.find(n=>n.tag===30).values[g.roots.find(n=>n.tag===18).value-1];
const owner={page:'Page 1',panel:'MASTER_PANEL',state:'Card'};
function state(input,scope=owner){
 const record=resolvePanelState(input,scope).stateRecord,graph=parsePayload(record);
 const diagram=[...graph.objects.values()].find(o=>o.className==='Axure:PanelDiagram');
 return {record,graph,roots:field(diagram.body,'diagram-objects').items.map(n=>graph.objects.get(n.value))};
}
function image(graph,instance){
 const list=field(instance.body,'ObjectOverrides').items;
 for(let i=1;i<list.length;i+=2){const stream=field(field(list[i],'Image')??{},'Stream');if(stream?.tag===4)return Buffer.from(stream.value,'base64');}
 throw Error('Expected native embedded image override');
}
function streamCount(input,bytes){
 let count=0;
 for(const record of readRecords(input).filter(r=>r.strings))walkNodes(parsePayload(record).roots,n=>{
  if(n.tag===4&&Buffer.from(n.value,'base64').equals(bytes))count++;
 });
 return count;
}
function noBytes(input,bytes){for(const r of readRecords(input))assert.ok(!r.raw.includes(bytes),'Removed PNG remains in a physical record');}
function healthy(input){
 const rp=readRp(input);assert.equal(rp.records.unparseable,0);assert.equal(rp.counts.danglingRefs,0);assert.equal(rp.counts.problems,0,JSON.stringify(rp.problems));
}
function sharedUnchanged(before,after,scope=owner){
 const old=readRecords(before),now=readRecords(after);
 for(const r of old.filter(r=>['Axure:Master','Axure:PanelState'].includes(r.className)&&r.index!==state(before,scope).record.index)){
  const key=packageGuid(parsePayload(r)),saved=now.find(a=>a.className===r.className&&packageGuid(parsePayload(a))===key);
  assert.ok(saved&&r.raw.equals(saved.raw),'Shared definition/state changed');
 }
 assert.ok(old.find(r=>r.className==='Axure:DesignDocument').raw.equals(now.find(r=>r.className==='Axure:DesignDocument').raw));
}
export function runDirectImageChecks(){
 const input=readFileSync(fixturePath('panel-direct-image-base.rp'));
 const original=state(input),a=original.roots.find(o=>nameOf(o)==='DIRECT_IMAGE_A'),b=original.roots.find(o=>nameOf(o)==='DIRECT_IMAGE_B');
 const red=image(original.graph,a),blue=image(original.graph,b),work=mkdtempSync(join(tmpdir(),'axure-direct-image-')),results=[];
 const check=(name,fn)=>{try{fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,detail:error.message});}};
 const remove=selection=>removePanelStateContent(input,{...owner,...selection}).file;
 const override=operation=>setMasterOverrides(input,{record:original.record.index,instanceId:a.id,overrides:[operation]}).file;
 const bluePath=join(work,'blue.png');writeFileSync(bluePath,blue);
 try {
  check('原生往返 fixture 确认两个独立 PNG 覆盖',()=>{healthy(input);assert.equal(streamCount(input,red),1);assert.equal(streamCount(input,blue),1);assert.ok(!red.equals(blue));});
  check('新放母版使用原生 typed reference 与 GUID 样式字段',()=>{
   const page=readRecords(input).find(r=>r.className==='Axure:Page');
   const result=placeMaster(input,{masterName:'NESTED_MASTER',pageIndex:page.index,x:25,y:30}),g=parsePayload(readRecords(result.file).find(r=>r.className==='Axure:Page'));
   const instance=g.objects.get(result.report.widgetId),style=g.objects.get(field(instance.body,'MyStyle').value),nativeStyle=original.graph.objects.get(field(a.body,'MyStyle').value);
   assert.equal(field(instance.body,'ReferredMaster').tag,field(a.body,'ReferredMaster').tag);
   assert.equal(field(instance.body,'ReferredMaster').tag,0x10);
   for(const key of ['LibraryId','Id'])assert.equal(field(style.body,key).tag,field(nativeStyle.body,key).tag);
   assert.equal(field(style.body,'Capabilities').value,field(nativeStyle.body,'Capabilities').value);healthy(result.file);
  });
  check('新放母版保持已有定义且定位值准确',()=>{
   const page=readRecords(input).find(r=>r.className==='Axure:Page');
   const result=placeMaster(input,{masterName:'NESTED_MASTER',pageIndex:page.index,x:25,y:30}),rp=readRp(result.file);
   const w=rp.pages[0].widgets.find(w=>w.id===result.report.widgetId);assert.equal(w.x,25);assert.equal(w.y,30);
   for(const r of readRecords(input).filter(r=>r.className==='Axure:Master'))assert.ok(r.raw.equals(readRecords(result.file).find(a=>a.index===r.index).raw));
  });
  check('删 A 物理移除红 PNG 并保留 B 蓝 PNG',()=>{const out=remove({widgets:['DIRECT_IMAGE_A']});noBytes(out,red);assert.equal(streamCount(out,blue),1);assert.deepEqual(state(out).roots.map(nameOf),['DIRECT_IMAGE_B']);healthy(out);});
  check('删 A 保留共享母版及全部自有状态原字节',()=>sharedUnchanged(input,remove({widgets:['DIRECT_IMAGE_A']})));
  check('清空移除全部私有 PNG 且保留共享定义',()=>{const out=remove({all:true});noBytes(out,red);noBytes(out,blue);assert.equal(state(out).roots.length,0);sharedUnchanged(input,out);healthy(out);});
  check('替换移除旧 PNG 且新四控件布局可解析',()=>{const source=readFileSync(fixturePath('master-state-form-source.rp'));const out=fillPanelState(source,input,{sourcePage:'Page 1',targetPage:owner.page,panel:owner.panel,state:owner.state,replace:true}).file;noBytes(out,red);noBytes(out,blue);assert.equal(state(out).roots.length,4);sharedUnchanged(input,out);healthy(out);});
  check('图片更新移除旧红 bytes 并保留两份蓝覆盖',()=>{const out=override({target:'PANEL_IMAGE',imagePath:bluePath});noBytes(out,red);assert.equal(streamCount(out,blue),2);assert.equal(state(out).roots.length,2);sharedUnchanged(input,out);healthy(out);});
  check('清除 A 图片仅去掉图片覆盖并保留标签和 B',()=>{const out=override({target:'PANEL_IMAGE',clear:true}),s=state(out),instance=s.roots.find(o=>nameOf(o)==='DIRECT_IMAGE_A');noBytes(out,red);assert.equal(streamCount(out,blue),1);assert.equal(field(instance.body,'ObjectOverrides').items.length,4);sharedUnchanged(input,out);healthy(out);});
  check('同一 PNG 被两个实例使用时删除一个仍保留另一份',()=>{
   const redPath=join(work,'red.png');writeFileSync(redPath,red);
   const both=setMasterOverrides(input,{record:original.record.index,instanceId:b.id,overrides:[{target:'PANEL_IMAGE',imagePath:redPath}]}).file;
   assert.equal(streamCount(both,red),2);
   const out=removePanelStateContent(both,{...owner,widgets:['DIRECT_IMAGE_A']}).file;
   assert.equal(streamCount(out,red),1);noBytes(out,blue);sharedUnchanged(both,out);healthy(out);
  });
  check('删除和清空保留外层状态身份',()=>{for(const out of [remove({widgets:['DIRECT_IMAGE_A']}),remove({all:true})])assert.equal(packageGuid(state(out).graph),packageGuid(original.graph));});
 } finally {rmSync(work,{recursive:true});}
 return results;
}

export function runMasterDirectImageChecks(){
 const input=readFileSync(fixturePath('master-direct-image-base.rp'));
 const scope={master:'NESTED_MASTER',panel:'CONTENT_PANEL',state:'Form'},s=state(input,scope);
 const a=s.roots.find(o=>nameOf(o)==='DIRECT_IMAGE_A'),b=s.roots.find(o=>nameOf(o)==='DIRECT_IMAGE_B');
 const red=image(s.graph,a),blue=image(s.graph,b),work=mkdtempSync(join(tmpdir(),'axure-master-image-')),results=[];
 const check=(name,fn)=>{try{fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,detail:error.message});}};
 const redPath=join(work,'red.png'),bluePath=join(work,'blue.png');writeFileSync(redPath,red);writeFileSync(bluePath,blue);
 const remove=options=>removePanelStateContent(input,{...scope,...options}).file;
 const override=operation=>setMasterOverrides(input,{record:s.record.index,instanceId:a.id,overrides:[operation]}).file;
 try {
  check('Master 所属双实例原生往返 fixture 与两份私有图片',()=>{healthy(input);assert.equal(streamCount(input,red),1);assert.equal(streamCount(input,blue),1);assert.deepEqual(s.roots.map(nameOf),['DIRECT_IMAGE_A','DIRECT_IMAGE_B']);});
  check('Master 单删/全清/替换物理回收私有 PNG 且共享定义不变',()=>{
   const source=readFileSync(fixturePath('master-state-form-source.rp'));
   const deleted=remove({widgets:['DIRECT_IMAGE_A']}),cleared=remove({all:true});
   const replaced=fillPanelState(source,input,{sourcePage:'Page 1',targetMaster:scope.master,panel:scope.panel,state:scope.state,replace:true}).file;
   assert.equal(streamCount(deleted,blue),1);assert.deepEqual(state(deleted,scope).roots.map(nameOf),['DIRECT_IMAGE_B']);assert.equal(state(cleared,scope).roots.length,0);assert.equal(state(replaced,scope).roots.length,4);
   for(const out of[deleted,cleared,replaced]){noBytes(out,red);sharedUnchanged(input,out,scope);healthy(out);assert.equal(packageGuid(state(out,scope).graph),packageGuid(s.graph));}
   for(const out of[cleared,replaced])noBytes(out,blue);
  });
  check('Master 图片更新/清除回收旧 bytes 并保留其它覆盖',()=>{
   const updated=override({target:'PANEL_IMAGE',imagePath:bluePath}),cleared=override({target:'PANEL_IMAGE',clear:true});
   assert.equal(streamCount(updated,blue),2);assert.equal(streamCount(cleared,blue),1);assert.equal(field(state(cleared,scope).roots.find(o=>nameOf(o)==='DIRECT_IMAGE_A').body,'ObjectOverrides').items.length,4);
   for(const out of[updated,cleared]){noBytes(out,red);sharedUnchanged(input,out,scope);healthy(out);}
  });
  check('Master 同图双实例删一份保留另一份及所属关系',()=>{
   const both=setMasterOverrides(input,{record:s.record.index,instanceId:b.id,overrides:[{target:'PANEL_IMAGE',imagePath:redPath}]}).file;
   assert.equal(streamCount(both,red),2);const out=removePanelStateContent(both,{...scope,widgets:['DIRECT_IMAGE_A']}).file;
   assert.equal(streamCount(out,red),1);noBytes(out,blue);assert.deepEqual(state(out,scope).roots.map(nameOf),['DIRECT_IMAGE_B']);sharedUnchanged(both,out,scope);healthy(out);
  });
 } finally {rmSync(work,{recursive:true});}
 return results;
}
