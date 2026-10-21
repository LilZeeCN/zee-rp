// Add a new click → open-link interaction to a named widget, entirely offline.
import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readRecords,encodeRecord,replaceRecord} from './rp-records.mjs';
import {parsePayload,encodePayload,field} from './parse-payload.mjs';
import {detectFileVersion} from './version.mjs';
import {adaptNodesForVersion} from './version-adapt.mjs';

export function addClickLink(file, widgetName, url, mode='current', { version } = {}) {
  if(!['current','new'].includes(mode))throw new Error('Mode must be current or new');
  // 这个 writer 不走 ix-actions，版本适配必须自己做，否则会写出 RP 11 形状的 Event/Case。
  const targetVersion = version ?? detectFileVersion(file);
  const matches=[];
  for(const r of readRecords(file).filter(r=>r.className==='Axure:Page')){
    const graph=parsePayload(r);
    for(const widget of graph.objects.values())if(widget.className.startsWith('Axure:DiagramObject:')&&field(field(widget.body,'name-block')??{},'text')?.text===widgetName)matches.push({r,graph,widget});
  }
  if(matches.length!==1)throw new Error(`Expected one widget named ${widgetName}, found ${matches.length}`);
  const {r,graph,widget}=matches[0];
  if(field(widget.body,'InteractionMap'))throw new Error('Widget already has interactions; refusing to replace them');
  const strings=[...r.strings],guids=graph.roots.find(n=>n.tag===0x1e).values;
  const nullId=guids.indexOf('00000000000000000000000000000000')+1;
  if(!nullId)throw new Error('Missing null GUID');
  const str=text=>{let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text);}return{tag:8,value:i+1,text};};
  const ref=value=>({tag:3,value}),int=value=>({tag:5,value}),bool=value=>({tag:0x19,value}),list=items=>({tag:2,items}),dict=entries=>({tag:1,entries});
  const map=props=>dict(Object.entries(props).map(([k,v])=>[str(k),v]));
  const ids={};for(const key of ['map','eventNode','event','caseNode','case','actionNode','action','tree','target','literal']){guids.push(randomBytes(16).toString('hex'));ids[key]=guids.length;}
  const defs=[];
  const obj=(key,className,props)=>defs.push({tag:9,id:ids[key],classIndex:str(className).value,className,body:map(props)});
  obj('map','Axure:InteractionTreeMap',{'node-table':dict([[ref(ids.eventNode),ref(ids.event)],[ref(ids.caseNode),ref(ids.case)],[ref(ids.actionNode),ref(ids.action)]]),tree:ref(ids.tree),PackageMode:bool(false)});
  obj('eventNode','Axure:Node',{children:list([ref(ids.caseNode)]),'parent-node':ref(ids.tree),tree:ref(ids.tree)});
  obj('caseNode','Axure:Node',{children:list([ref(ids.actionNode)]),'parent-node':ref(ids.eventNode),tree:ref(ids.tree)});
  obj('actionNode','Axure:Node',{children:list([]),'parent-node':ref(ids.caseNode),tree:ref(ids.tree)});
  obj('tree','Axure:Tree',{children:list([ref(ids.eventNode)]),tree:ref(ids.tree)});
  obj('event','Axure:InteractionEvent',{Disabled:bool(false),'event-type':int(16),'master-containing-raised-event':{tag:0x10,values:[0,nullId]},'raised-event-id':{tag:0x11,value:nullId},'variable-id':{tag:0x11,value:nullId}});
  obj('case','Axure:InteractionCase',{Disabled:bool(false),Description:str(''),Condition:ref(nullId),IsNewIfGroup:bool(false)});
  obj('action','Axure:InteractionLinkWindowAction',{Disabled:bool(false),target:ref(ids.target),'link-type':int(mode==='current'?1:2)});
  obj('target','Axure:InteractionTarget',{'target-type':int(0),'target-page-id':{tag:0x13,values:[1,nullId]},'target-literal':ref(ids.literal)});
  obj('literal','Axure:Expr:StringLiteral',{value:str(url),'variable-identifiers':list([]),'repeater-scope':ref(nullId),TargetRepeaterScope:ref(nullId)});
  adaptNodesForVersion(defs, { version: targetVersion, str });
  const pos=widget.body.entries.findIndex(([k])=>k.text==='MyStyle');
  widget.body.entries.splice(pos<0?widget.body.entries.length:pos,0,[str('InteractionMap'),ref(ids.map)]);
  graph.roots.splice(graph.roots.length-1,0,...defs);
  const raw=encodeRecord(r,strings,encodePayload(graph.roots));
  return {file:replaceRecord(file,r,raw),report:{widgetName,url,mode,record:r.index,addedObjects:defs.length,addedStrings:strings.length-r.strings.length}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [src,dst,name,url,mode]=process.argv.slice(2);if(!src||!dst||!name||!url)throw new Error('Usage: node add-click-link.mjs source.rp output.rp widgetName url [current|new]');
 const out=addClickLink(readFileSync(src),name,url,mode);writeFileSync(dst,out.file,{flag:'wx'});console.log(JSON.stringify(out.report,null,2));
}
