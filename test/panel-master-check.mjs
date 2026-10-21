import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRecords,readManifest,replaceRecord,encodeRecord} from '../scripts/rp-records.mjs';
import {parsePayload,field,encodePayload} from '../scripts/parse-payload.mjs';
import {readRp} from '../scripts/rp-read.mjs';
import {removePanelStateContent,resolvePanelState} from '../scripts/remove-panel-state-content.mjs';
import {fillPanelState} from '../scripts/fill-panel-state.mjs';
import {addInteractions} from '../scripts/ix-actions.mjs';
import {guidKey} from '../scripts/duplicate-page.mjs';
const root=dirname(fileURLToPath(import.meta.url)),read=n=>readFileSync(join(root,'fixtures',n));
const guid=g=>g.roots.find(n=>n.tag===30).values[g.roots.find(n=>n.tag===18).value-1];
const name=o=>field(field(o.body,'name-block')??{},'text')?.text;
export function runPanelMasterChecks({log=()=>{}}={}){
 const results=[],check=(label,fn)=>{try{fn();results.push({name:label,passed:true});log('PASS  '+label);}catch(e){results.push({name:label,passed:false,detail:e.message});log('FAIL  '+label+' — '+e.message);}};
 const input=read('panel-master-dependency-panel-gui-edit.rp'),form=read('master-state-form-source.rp'),owner={master:'NESTED_MASTER',panel:'CONTENT_PANEL',state:'Form'};
 let deleted,cleared,replaced,nested,withMaster;
 const healthy=file=>{const r=readRp(file);assert.equal(r.records.unparseable,0);assert.equal(r.counts.danglingRefs,0);assert.equal(r.counts.problems,0,JSON.stringify(r.problems));};
 check('Master 定位与真实 manifest 归属',()=>{const o=resolvePanelState(input,owner),m=readManifest(input);assert.equal(o.ownerRecord.className,'Axure:Master');assert.ok(m.value.root.children[guidKey(o.ownerGuid)].children[guidKey(guid(parsePayload(o.stateRecord)))]);});
 check('Master 删除指定 PNG 保留表单四根',()=>{deleted=removePanelStateContent(input,{...owner,widgets:['PANEL_IMAGE']});assert.equal(deleted.report.retainedRoots,4);assert.deepEqual(deleted.report.removedWidgets.map(w=>w.name),['PANEL_IMAGE']);healthy(deleted.file);});
 check('Master 清空保留包 GUID 与其余记录字节',()=>{cleared=removePanelStateContent(input,{...owner,all:true});assert.equal(cleared.report.retainedRoots,0);assert.equal(cleared.report.stateGuid,deleted.report.stateGuid);for(const r of readRecords(input)){if(r.index===cleared.report.record)continue;const after=readRecords(cleared.file).find(a=>a.index===r.index);assert.ok(r.raw.equals(after.raw));}healthy(cleared.file);});
 check('Master 替换保留状态身份及新控件',()=>{replaced=fillPanelState(form,input,{sourcePage:'Page 1',targetMaster:owner.master,panel:owner.panel,state:owner.state,replace:true});assert.equal(replaced.report.removal.stateGuid,cleared.report.stateGuid);assert.equal(replaced.report.roots,4);healthy(replaced.file);});
 check('活跃 Checkbox 仍指向删除 TextBox 时拒绝',()=>assert.throws(()=>removePanelStateContent(input,{...owner,widgets:['NATIVE_TEXT_FIELD']}),/Remaining/));
 check('目标 Page 和 Master 同时填写时拒绝',()=>assert.throws(()=>removePanelStateContent(input,{...owner,page:'Page 1',all:true}),/exactly one/));
 check('缺少 owner 拒绝',()=>assert.throws(()=>resolvePanelState(input,{panel:owner.panel,state:owner.state}),/exactly one/));
 check('不存在母版名拒绝',()=>assert.throws(()=>resolvePanelState(input,{...owner,master:'MISSING'}),/unique/));
 check('错误母版的面板不跨定义搜索',()=>assert.throws(()=>resolvePanelState(input,{...owner,master:'OUTER_VISUAL_MASTER'}),/Panel .*unique/));
 check('母版根中不存在状态拒绝',()=>assert.throws(()=>resolvePanelState(input,{...owner,state:'MISSING'}),/State .*unique/));
 check('非空 Master 状态默认导入拒绝',()=>assert.throws(()=>fillPanelState(form,input,{sourcePage:'Page 1',targetMaster:owner.master,panel:owner.panel,state:owner.state}),/must be empty/));
 check('Page 删除与清空入口仍健康',()=>healthy(removePanelStateContent(read('panel-replace-roundtrip.rp'),{page:'Page 1',panel:owner.panel,state:owner.state,all:true}).file));
 check('Master 导入嵌套状态后清空只移除私有包',()=>{nested=fillPanelState(read('panel-replace-roundtrip.rp'),input,{sourcePage:'Page 1',targetMaster:owner.master,panel:owner.panel,state:owner.state,replace:true});const r=removePanelStateContent(nested.file,{...owner,all:true});assert.ok(r.report.removedStates.length>0);assert.equal(readRecords(r.file).filter(r=>r.className==='Axure:PanelState').length,readRecords(input).filter(r=>r.className==='Axure:PanelState').length);for(const record of readRecords(input).filter(r=>r.className==='Axure:Master')){const key=guid(parsePayload(record)),after=readRecords(r.file).find(r=>r.className==='Axure:Master'&&guid(parsePayload(r))===key);assert.ok(record.raw.equals(after.raw));}healthy(r.file);});
 check('Master state package 被放到错误 owner 下时拒绝',()=>{const o=resolvePanelState(input,owner),graph=parsePayload(o.ownerRecord);const panel=[...graph.objects.values()].find(o=>name(o)===owner.panel);const pair=field(panel.body,'panel-diagrams').items[1];const other=readRecords(input).find(r=>r.className==='Axure:PanelState'&&r.index!==o.stateRecord.index&&r.index<o.stateRecord.index);graph.roots.find(n=>n.tag===30).values[pair.values[1]-1]=guid(parsePayload(other));const bad=replaceRecord(input,o.ownerRecord,encodeRecord(o.ownerRecord,o.ownerRecord.strings,encodePayload(graph.roots)));assert.throws(()=>resolvePanelState(bad,{...owner,state:field([...parsePayload(other).objects.values()].find(o=>o.className==='Axure:PanelDiagram').body,'Name').text}),/must belong/);});
 check('向 Master 状态导入母版时依赖登记到 Master 而非 Page',()=>{let src=read('panel-master-twins-gui.rp');for(const old of readRecords(src)){if(!['Axure:Page','Axure:PanelState','Axure:Master'].includes(old.className))continue;const r=readRecords(src).find(r=>r.index===old.index),g=parsePayload(r);for(const o of g.objects.values()){if(!o.className.startsWith('Axure:DiagramObject:'))continue;const n=field(field(o.body,'name-block')??{},'text');if(!n?.text)continue;n.text='MASTER_IMPORT_'+n.text;r.strings.push(n.text);n.value=r.strings.length;}src=replaceRecord(src,r,encodeRecord(r,r.strings,encodePayload(g.roots)));}
  withMaster=fillPanelState(src,input,{sourcePage:'Page 1',targetMaster:owner.master,panel:owner.panel,state:owner.state,replace:true});healthy(withMaster.file);const beforeDoc=parsePayload(readRecords(input).find(r=>r.className==='Axure:DesignDocument')),doc=parsePayload(readRecords(withMaster.file).find(r=>r.className==='Axure:DesignDocument'));const info=[...doc.objects.values()].find(o=>o.className==='Axure:MasterPackageInfo'&&field(o.body,'package-name').text===owner.master);assert.ok(field(info.body,'dependencies').items.length>0);for(const o of beforeDoc.objects.values()){if(o.className!=='Axure:PackageInfo'||field(o.body,'package-name')?.text!=='Page 1')continue;assert.ok(encodePayload([field(doc.objects.get(o.id).body,'dependencies')]).equals(encodePayload([field(o.body,'dependencies')])));}const ownerRecord=resolvePanelState(withMaster.file,owner).ownerRecord;const originalMasters=new Set(readRecords(input).filter(r=>r.className==='Axure:Master').map(r=>guid(parsePayload(r))));for(const record of readRecords(withMaster.file).filter(r=>r.className==='Axure:Master'&&!originalMasters.has(guid(parsePayload(r)))))assert.ok(record.index<ownerRecord.index);
 });
 check('清掉 Master 状态中的母版实例仍保留共享定义和依赖',()=>{const result=removePanelStateContent(withMaster.file,{...owner,all:true});healthy(result.file);for(const r of readRecords(withMaster.file).filter(r=>r.className==='Axure:Master')){const after=readRecords(result.file).find(a=>a.className==='Axure:Master'&&guid(parsePayload(a))===guid(parsePayload(r)));assert.ok(r.raw.equals(after.raw));}const beforeDoc=readRecords(withMaster.file).find(r=>r.className==='Axure:DesignDocument'),afterDoc=readRecords(result.file).find(r=>r.className==='Axure:DesignDocument');assert.ok(beforeDoc.raw.equals(afterDoc.raw));});
 check('Page 导入带自定义锚点连接线至面板状态并保留点与三零',()=>{
  const connSrc = readFileSync(fixturePath('connector-custom-anchor-writer-roundtrip-20261012.rp'));
  const targetRp=read('panel-replace-roundtrip.rp');
  const imported=fillPanelState(connSrc,targetRp,{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true});
  healthy(imported.file);
  const formG=parsePayload(readRecords(imported.file).find(r=>r.className==='Axure:PanelState'&&r.index===5));
  const formGuids=formG.roots.find(n=>n.tag===30).values;
  const conns=[...formG.objects.values()].filter(o=>o.className==='Axure:DiagramObject:Connector');
  assert.equal(conns.length,1);
  assert.equal(formGuids[field(conns[0].body,'end-connector-id').value-1],'9b37625998f5cda98cd50fd24a38f1cd');
  assert.equal(field(conns[0].body,'end-point-direction').value,2);
 });
 check('连接线端点超出布局范围时导入拒绝',()=>{
  const connSrc = readFileSync(fixturePath('connector-custom-anchor-writer-roundtrip-20261012.rp'));
  const pageRec=readRecords(connSrc).find(r=>r.className==='Axure:Page');
  const g=parsePayload(pageRec);
  field(g.objects.get(14).body,'end-diagram-object').value=999;
  const badSrc=replaceRecord(connSrc,pageRec,encodeRecord(pageRec,pageRec.strings,encodePayload(g.roots)));
  assert.throws(()=>fillPanelState(badSrc,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true}),/Connector endpoints must belong/);
 });
 check('Page 导入带闭合交互 (显隐/等待/移动/启用/焦点/设文字) 至面板状态并正确重映射',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{
   event:'OnClick',
   cases:[{
    description:'Case 1',
    actions:[
     {type:'show',target:'REPLACEMENT_TEXT',duration:200,animation:'fade'},
     {type:'wait',ms:300},
     {type:'move',target:'REPLACEMENT_TEXT',x:10,y:20,mode:'delta'},
     {type:'enable',target:'REPLACEMENT_TEXT'},
     {type:'focus',target:'REPLACEMENT_TEXT',selectText:true},
     {type:'set-text',target:'REPLACEMENT_TEXT',text:'Checked!'}
    ]
   }]
  }]);
  const imported=fillPanelState(res.file,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true});
  healthy(imported.file);
  const stateG=parsePayload(readRecords(imported.file).find(r=>r.className==='Axure:PanelState'&&r.index===5));
  let newTextId=null;
  for(const [id,o] of stateG.objects){
   if(o.className.startsWith('Axure:DiagramObject:')&&field(field(o.body,'name-block')??{},'text')?.text==='REPLACEMENT_TEXT')
    newTextId=id;
  }
  assert.ok(newTextId);
  const paths=[...stateG.objects.values()].filter(o=>o.className==='Axure:DiagramObjectPath');
  assert.ok(paths.length>=4);
  for(const p of paths) assert.equal(field(p.body,'object-id')?.value,newTextId);
 });
 check('面板导入时交互目标超出闭包范围拒绝',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{event:'OnClick',cases:[{actions:[{type:'show',target:'REPLACEMENT_TEXT'}]}]}]);
  const badG=parsePayload(readRecords(res.file).find(r=>r.className==='Axure:Page'));
  const badP=[...badG.objects.values()].find(o=>o.className==='Axure:DiagramObjectPath');
  field(badP.body,'object-id').value=999;
  const badRec=readRecords(res.file).find(r=>r.className==='Axure:Page');
  const badFile=replaceRecord(res.file,badRec,encodeRecord(badRec,badRec.strings,encodePayload(badG.roots)));
  assert.throws(()=>fillPanelState(badFile,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true}),/State import interaction targets must belong/);
 });
 check('面板导入时显隐动作 show-type 非标准模式拒绝',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{event:'OnClick',cases:[{actions:[{type:'show',target:'REPLACEMENT_TEXT',showType:'lightbox'}]}]}]);
  assert.throws(()=>fillPanelState(res.file,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true}),/State import only preserves standard fade show\/hide actions/);
 });
 check('面板导入时闭包内扩展动作 (尺寸/旋转/透明度) 正确保留与重映射',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{
   event:'OnClick',
   cases:[{
    actions:[
     {type:'set-size',target:'REPLACEMENT_TEXT',width:120,height:40},
     {type:'rotate',target:'REPLACEMENT_TEXT',degree:45},
     {type:'set-opacity',target:'REPLACEMENT_TEXT',opacity:80}
    ]
   }]
  }]);
  const imported=fillPanelState(res.file,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true});
  healthy(imported.file);
  const stateG=parsePayload(readRecords(imported.file).find(r=>r.className==='Axure:PanelState'&&r.index===5));
  const sizeAction=[...stateG.objects.values()].find(o=>o.className==='Axure:InteractionSetWidgetSizeAction');
  const rotateAction=[...stateG.objects.values()].find(o=>o.className==='Axure:InteractionRotateWidgetAction');
  const opacityAction=[...stateG.objects.values()].find(o=>o.className==='Axure:InteractionSetOpacityAction');
  assert.ok(sizeAction,'SetWidgetSizeAction must be imported');
  assert.ok(rotateAction,'RotateWidgetAction must be imported');
  assert.ok(opacityAction,'SetOpacityAction must be imported');
 });
 check('面板导入时点号或前缀未知交互动作类名严密拦截',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{event:'OnClick',cases:[{actions:[{type:'wait',ms:1}]}]}]);
  const badRec=readRecords(res.file).find(r=>r.className==='Axure:Page');
  const badStrings=[...badRec.strings];
  const badG=parsePayload(badRec);
  const waitObj=[...badG.objects.values()].find(o=>o.className==='Axure:InteractionWaitAction');
  badStrings.push('Axure.InteractionUnknownFancyAction');
  waitObj.classIndex=badStrings.length;
  waitObj.className='Axure.InteractionUnknownFancyAction';
  const badFile=replaceRecord(res.file,badRec,encodeRecord(badRec,badStrings,encodePayload(badG.roots)));
  assert.throws(()=>fillPanelState(badFile,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true}),/State import has not verified Axure\.InteractionUnknownFancyAction/);
 });
 check('面板导入时非法相对切状态类型严格拦截',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{event:'OnClick',cases:[{actions:[{type:'set-size',target:'REPLACEMENT_TEXT',width:10,height:10}]}]}]);
  const badRec=readRecords(res.file).find(r=>r.className==='Axure:Page');
  const badG=parsePayload(badRec);
  const badStrings=[...badRec.strings];
  const infoObj=[...badG.objects.values()].find(o=>o.className==='Axure:SetWidgetSizeInfo');
  badStrings.push('Axure:SetPanelStateInfo');
  infoObj.classIndex=badStrings.length;
  infoObj.className='Axure:SetPanelStateInfo';
  infoObj.body={tag:1,entries:[
   [{tag:8,value:1,text:'set-state-type'},{tag:5,value:99}],
   [{tag:8,value:2,text:'diagram-id'},{tag:17,value:1}]
  ]};
  const badFile=replaceRecord(res.file,badRec,encodeRecord(badRec,badStrings,encodePayload(badG.roots)));
  assert.throws(()=>fillPanelState(badFile,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true}),/State import only preserves explicit state switches/);
 });
 check('面板导入时闭包内局部变量绑定 (GetWidgetText) 正确保留与重映射',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{event:'OnClick',cases:[{actions:[{type:'set-text',target:'REPLACEMENT_TEXT',value:'Static'}]}]}]);
  const rec=readRecords(res.file).find(r=>r.className==='Axure:Page');
  const g=parsePayload(rec);
  const strings=[...rec.strings];
  const targetTextBox=[...g.objects.values()].find(o=>o.className==='Axure:DiagramObject:TextBox');
  const guids=g.roots.find(n=>n.tag===0x1e).values;
  const str=t=>{let i=strings.indexOf(t);if(i<0){i=strings.length;strings.push(t);}return{tag:8,value:i+1,text:t};};
  const pathObj={tag:9,id:guids.length+1,classIndex:str('Axure:DiagramObjectPath').value,className:'Axure:DiagramObjectPath',body:{tag:1,entries:[
   [str('object-id'),{tag:0x16,value:targetTextBox.id}],
   [str('rdo-path'),{tag:2,items:[]}],
   [str('repeater-path'),{tag:2,items:[]}],
   [str('is-dummy'),{tag:0x19,value:false}]
  ]}};
  guids.push('11223344556677889900aabbccddeeff');
  const fcallObj={tag:9,id:guids.length+1,classIndex:str('Axure:Expr:FCall').value,className:'Axure:Expr:FCall',body:{tag:1,entries:[
   [str('function-name'),str('GetWidgetText')],
   [str('args'),{tag:2,items:[{tag:3,value:pathObj.id}]}]
  ]}};
  guids.push('22334455667788990011aabbccddeeff');
  const litObj=[...g.objects.values()].find(o=>o.className==='Axure:Expr:StringLiteral');
  litObj.body.entries.find(([k])=>k.text==='value')[1]=str('[[LVAR1]]');
  litObj.body.entries.push([str('scope'),{tag:1,entries:[[str('LVAR1'),{tag:3,value:fcallObj.id}]]}]);
  g.objects.set(pathObj.id,pathObj);
  g.objects.set(fcallObj.id,fcallObj);
  g.roots.splice(g.roots.length-1,0,pathObj,fcallObj);
  const modFile=replaceRecord(res.file,rec,encodeRecord(rec,strings,encodePayload(g.roots)));
  const out=fillPanelState(modFile,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true});
  healthy(out.file);
  const importedRec=readRecords(out.file).find(r=>r.className==='Axure:PanelState'&&r.index===5);
  const importedG=parsePayload(importedRec);
  const importedFCall=[...importedG.objects.values()].find(o=>o.className==='Axure:Expr:FCall'&&importedRec.strings[o.body.entries.find(([k])=>k.text==='function-name')[1].value-1]==='GetWidgetText');
  assert.ok(importedFCall,'GetWidgetText FCall must be copied into panel state');
 });
 check('面板导入时局部变量绑定跨闭包指向外部元件严格拦截',()=>{
  const formSrc=read('master-state-form-source.rp');
  const res=addInteractions(formSrc,'REPLACEMENT_CHECKBOX',[{event:'OnClick',cases:[{actions:[{type:'set-text',target:'REPLACEMENT_TEXT',value:'Static'}]}]}]);
  const rec=readRecords(res.file).find(r=>r.className==='Axure:Page');
  const g=parsePayload(rec);
  const strings=[...rec.strings];
  const guids=g.roots.find(n=>n.tag===0x1e).values;
  const str=t=>{let i=strings.indexOf(t);if(i<0){i=strings.length;strings.push(t);}return{tag:8,value:i+1,text:t};};
  const pathObj={tag:9,id:guids.length+1,classIndex:str('Axure:DiagramObjectPath').value,className:'Axure:DiagramObjectPath',body:{tag:1,entries:[
   [str('object-id'),{tag:0x16,value:9999}],
   [str('rdo-path'),{tag:2,items:[]}],
   [str('repeater-path'),{tag:2,items:[]}],
   [str('is-dummy'),{tag:0x19,value:false}]
  ]}};
  guids.push('33445566778899001122aabbccddeeff');
  const fcallObj={tag:9,id:guids.length+1,classIndex:str('Axure:Expr:FCall').value,className:'Axure:Expr:FCall',body:{tag:1,entries:[
   [str('function-name'),str('GetWidgetText')],
   [str('args'),{tag:2,items:[{tag:3,value:pathObj.id}]}]
  ]}};
  guids.push('44556677889900112233aabbccddeeff');
  const litObj=[...g.objects.values()].find(o=>o.className==='Axure:Expr:StringLiteral');
  litObj.body.entries.find(([k])=>k.text==='value')[1]=str('[[LVAR1]]');
  litObj.body.entries.push([str('scope'),{tag:1,entries:[[str('LVAR1'),{tag:3,value:fcallObj.id}]]}]);
  g.objects.set(pathObj.id,pathObj);
  g.objects.set(fcallObj.id,fcallObj);
  g.roots.splice(g.roots.length-1,0,pathObj,fcallObj);
  const badFile=replaceRecord(res.file,rec,encodeRecord(rec,strings,encodePayload(g.roots)));
  assert.throws(()=>fillPanelState(badFile,read('panel-replace-roundtrip.rp'),{sourcePage:'Page 1',targetPage:'Page 1',panel:owner.panel,state:owner.state,replace:true}),/State import expressions must be local repeater column values or local variable bindings/);
 });
 return results;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const results=runPanelMasterChecks({log:console.log});console.log(`${results.filter(r=>r.passed).length}/${results.length}`);process.exitCode=results.some(r=>!r.passed)?1:0;}
