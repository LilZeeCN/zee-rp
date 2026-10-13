import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { fillPanelState } from '../scripts/fill-panel-state.mjs';
import { removePanelStateContent, resolvePanelState } from '../scripts/remove-panel-state-content.mjs';

const owner={master:'NESTED_MASTER',panel:'CONTENT_PANEL',state:'Form'};
const table=g=>g.roots.find(n=>n.tag===30).values;
const guid=g=>table(g)[g.roots.find(n=>n.tag===18).value-1];
const name=o=>field(field(o.body,'name-block')??{},'text')?.text;
function state(input){const record=resolvePanelState(input,owner).stateRecord,graph=parsePayload(record),diagram=[...graph.objects.values()].find(o=>o.className==='Axure:PanelDiagram');return{record,graph,roots:field(diagram.body,'diagram-objects').items.map(n=>graph.objects.get(n.value))};}
function data(input){return readRecords(input).filter(r=>r.strings).flatMap(r=>[...parsePayload(r).objects.values()].filter(o=>o.className==='Axure:DocumentModel:DataSet'));}
const semantic=value=>JSON.parse(JSON.stringify(value,(key,value)=>['start','end'].includes(key)?undefined:value));
function repeaterData(input){return readRecords(input).filter(r=>r.strings).flatMap(r=>{const g=parsePayload(r);return [...g.objects.values()].filter(o=>o.className==='Axure:DiagramObject:Repeater').map(o=>g.objects.get(field(o.body,'Data').value));});}
function healthy(input){const r=readRp(input);assert.equal(r.records.unparseable,0);assert.equal(r.counts.danglingRefs,0);assert.equal(r.counts.problems,0,JSON.stringify(r.problems));}
function othersUnchanged(before,after,removed=[]){
 const selected=state(before).record.index,now=readRecords(after);
 for(const r of readRecords(before).filter(r=>['Axure:DesignDocument','Axure:Page','Axure:Master','Axure:PanelState'].includes(r.className)&&r.index!==selected)){
  if(removed.includes(guid(parsePayload(r))))continue;
  const saved=now.find(n=>n.className===r.className&&guid(parsePayload(n))===guid(parsePayload(r)));
  assert.ok(saved&&r.raw.equals(saved.raw),'Unselected package changed');
 }
 assert.equal(guid(state(before).graph),guid(state(after).graph));
}
export function runMasterRepeaterChecks(){
 const direct=readFileSync(fixturePath('master-repeater-import.rp')),nested=readFileSync(fixturePath('master-repeater-nested-import.rp'));
 const form=readFileSync(fixturePath('master-state-form-source.rp')),results=[];
 const check=(name,fn)=>{try{fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,detail:error.message});}};
 check('Master 直接/嵌套中继器往返 fixture 含三列七行数据',()=>{for(const b of[direct,nested]){healthy(b);assert.equal(repeaterData(b).length,1);assert.equal(field(repeaterData(b)[0].body,'columns').items.length,3);assert.equal(field(repeaterData(b)[0].body,'rows').items.length,7);}assert.equal(readRp(direct).counts.panelStates,4);assert.equal(readRp(nested).counts.panelStates,6);});
 check('仅删除 Master R7 时剩余增删改按钮引用使操作拒绝',()=>assert.throws(()=>removePanelStateContent(direct,{...owner,widgets:['R7']}),/Remaining state content references|Remaining content references/));
 check('Master 直接中继器清空/替换物理移除 DataSet，保留其它包与状态身份',()=>{
  const outputs=[removePanelStateContent(direct,{...owner,all:true}).file,fillPanelState(form,direct,{sourcePage:'Page 1',targetMaster:owner.master,panel:owner.panel,state:owner.state,replace:true}).file];
  outputs.forEach((b,i)=>{healthy(b);assert.equal(data(b).length,0);assert.equal(state(b).roots.length,i?4:0);othersUnchanged(direct,b);});
 });
 check('Master 嵌套中继器清空/替换回收两个子状态包且保留其它状态',()=>{
  const cleared=removePanelStateContent(nested,{...owner,all:true}),replaced=fillPanelState(form,nested,{sourcePage:'Page 1',targetMaster:owner.master,panel:owner.panel,state:owner.state,replace:true});
  assert.equal(cleared.report.removedStates.length,2);
  for(const b of[cleared.file,replaced.file]){healthy(b);assert.equal(data(b).length,0);assert.equal(readRp(b).counts.panelStates,4);assert.equal(guid(state(nested).graph),guid(state(b).graph));}
  for(const b of[cleared.file,replaced.file])othersUnchanged(nested,b,cleared.report.removedStates);
 });
 check('Master append 保留中继器元件身份/数据/动作并追加四控件',()=>{
  const out=fillPanelState(form,direct,{sourcePage:'Page 1',targetMaster:owner.master,panel:owner.panel,state:owner.state,append:true}).file;
  healthy(out);assert.equal(state(out).roots.length,8);assert.deepEqual(semantic(data(out)),semantic(data(direct)));othersUnchanged(direct,out);
  const before=state(direct),after=state(out);for(const o of before.roots){const retained=after.graph.objects.get(o.id);assert.deepEqual(semantic(retained),semantic(o));assert.equal(table(before.graph)[o.id-1],table(after.graph)[o.id-1]);}
  assert.ok(state(out).roots.some(o=>name(o)==='REPLACEMENT_CHECKBOX'));
 });
 return results;
}
