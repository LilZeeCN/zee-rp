import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readRecords,encodeRecord,replaceRecord,appendPackage} from './rp-records.mjs';
import {parsePayload,encodePayload,field} from './parse-payload.mjs';

// .NET GUID bytes store the first three groups in little endian.
export function guidKey(hex){const b=Buffer.from(hex,'hex');return Buffer.concat([Buffer.from(b.subarray(0,4)).reverse(),Buffer.from(b.subarray(4,6)).reverse(),Buffer.from(b.subarray(6,8)).reverse(),b.subarray(8)]).toString('hex');}

// ── duplicatePage：已通过 Axure 验收 ──
// 新对象插在最后一个 root 之前（roots.length-1）。
// 历史“Page / PanelState 插在 GUID 列表前”的结论已被单变量对照撤回，
// 见 references/rp-format-research.md；不要据旧注释改动插入位置。
export function duplicatePage(file, sourceName, newName){
 const records=readRecords(file),doc=records.find(r=>r.className==='Axure:DesignDocument'),d=parsePayload(doc),dg=d.roots[0].values,strings=[...doc.strings];
 const s=text=>{let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text)}return{tag:8,value:i+1,text}};
 const infos=[...d.objects.values()].filter(n=>n.className==='Axure:PackageInfo'),info=infos.find(n=>field(n.body,'package-name')?.text===sourceName&&strings[field(n.body,'package-id').values[0]-1]==='Axure:Page');
 if(!info)throw new Error(`Page not found: ${sourceName}`);if(infos.some(n=>field(n.body,'package-name')?.text===newName))throw new Error('Duplicate page name');
 const oldPackage=dg[field(info.body,'package-id').values[1]-1],page=records.find(r=>r.className==='Axure:Page'&&parsePayload(r).roots[0].values[1]===oldPackage);
 if(!page)throw new Error('Page record not found');
 const p=parsePayload(page),pg=p.roots[0].values;
 for(const id of p.objects.keys())pg[id-1]=randomBytes(16).toString('hex');
 const packageIndex=p.roots.find(n=>n.tag===0x12).value;pg[packageIndex-1]=randomBytes(16).toString('hex');
 const newPackage=pg[packageIndex-1],alloc=hex=>{dg.push(hex??randomBytes(16).toString('hex'));return dg.length};
 const newInfo=structuredClone(info),newNodeId=alloc(),newInfoId=alloc(),newPackageId=alloc(newPackage);newInfo.id=newInfoId;
 field(newInfo.body,'package-id').values[1]=newPackageId;Object.assign(field(newInfo.body,'package-name'),s(newName));
 const root=d.objects.get(d.roots.find(n=>n.tag===0xf).value),site=d.objects.get(field(root.body,'sitemap').value),tree=d.objects.get(field(site.body,'tree').value),ref=value=>({tag:3,value});
 field(root.body,'PackageInfos').items.push(ref(newInfoId));
 field(site.body,'node-table').entries.push([ref(newNodeId),{tag:0x13,values:[s('Axure:PackageInfo').value,newPackageId]}]);
 field(tree.body,'children').items.push(ref(newNodeId));
 const node={tag:9,id:newNodeId,classIndex:s('Axure:Node').value,className:'Axure:Node',body:{tag:1,entries:[[s('children'),{tag:2,items:[]}],[s('parent-node'),ref(tree.id)],[s('tree'),ref(tree.id)]]}};
 d.roots.splice(d.roots.length-1,0,newInfo,node);
 let out=replaceRecord(file,doc,encodeRecord(doc,strings,encodePayload(d.roots)));
 out=appendPackage(out,guidKey(newPackage),encodeRecord(page,page.strings,encodePayload(p.roots)));
 return{file:out,report:{sourceName,newName,packageId:guidKey(newPackage),pages:records.filter(r=>r.className==='Axure:Page').length+1}};
}

// ── 新增（尚未通过 Axure 验收）：按记录索引把页面克隆成「模板」，供改造页内元件用 ──
// 相比 duplicatePage：不限页面名查找，且重新随机化 GUID 后**把 guidref 一并重映射**
// （原实现漏了这一步，会留下指向旧 GUID 的悬空引用）。
// 现状：产物被 Axure 判 invalid document。已排除项见 research-rp/round4/FINDINGS.md。
export function clonePageByIndex(file, recordIndex, newName, mutate){
 const records=readRecords(file);
 const page=records.find(r=>r.index===recordIndex&&r.className==='Axure:Page');
 if(!page)throw new Error(`No Axure:Page record at index ${recordIndex}`);
 const doc=records.find(r=>r.className==='Axure:DesignDocument');
 const d=parsePayload(doc),dg=d.roots[0].values,strings=[...doc.strings];
 const s=text=>{let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text)}return{tag:8,value:i+1,text}};
 const p=parsePayload(page),pg=p.roots[0].values;

 const guidMap=new Map();
 for(const id of p.objects.keys()){const hex=randomBytes(16).toString('hex');guidMap.set(id,hex);pg[id-1]=hex;}
 const packageIndex=p.roots.find(n=>n.tag===0x12).value;
 const newPackage=randomBytes(16).toString('hex');
 pg[packageIndex-1]=newPackage;
 guidMap.set(packageIndex,newPackage);
 const remap=n=>{
   if(n.tag===0x16&&guidMap.has(n.value))n.value=guidMap.get(n.value);
   if(n.items)n.items.forEach(remap);
   if(n.body)remap(n.body);
   if(n.entries)n.entries.forEach(([k,v])=>{remap(k);remap(v);});
 };
 p.roots.forEach(remap);

 if(mutate)mutate({graph:p,strings,guids:pg,record:page});

 const infos=[...d.objects.values()].filter(n=>n.className==='Axure:PackageInfo');
 if(infos.some(n=>field(n.body,'package-name')?.text===newName))throw new Error('Duplicate page name');
 const info=infos.find(n=>strings[field(n.body,'package-id').values[0]-1]==='Axure:Page');
 const alloc=hex=>{dg.push(hex??randomBytes(16).toString('hex'));return dg.length};
 const newInfo=structuredClone(info),newNodeId=alloc(),newInfoId=alloc(),newPackageId=alloc(newPackage);newInfo.id=newInfoId;
 field(newInfo.body,'package-id').values[1]=newPackageId;Object.assign(field(newInfo.body,'package-name'),s(newName));
 const root=d.objects.get(d.roots.find(n=>n.tag===0xf).value),site=d.objects.get(field(root.body,'sitemap').value),tree=d.objects.get(field(site.body,'tree').value),ref=value=>({tag:3,value});
 field(root.body,'PackageInfos').items.push(ref(newInfoId));
 field(site.body,'node-table').entries.push([ref(newNodeId),{tag:0x13,values:[s('Axure:PackageInfo').value,newPackageId]}]);
 field(tree.body,'children').items.push(ref(newNodeId));
 const node={tag:9,id:newNodeId,classIndex:s('Axure:Node').value,className:'Axure:Node',body:{tag:1,entries:[[s('children'),{tag:2,items:[]}],[s('parent-node'),ref(tree.id)],[s('tree'),ref(tree.id)]]}};
 d.roots.splice(d.roots.length-1,0,newInfo,node);

 let out=replaceRecord(file,doc,encodeRecord(doc,strings,encodePayload(d.roots)));
 out=appendPackage(out,guidKey(newPackage),encodeRecord(page,page.strings,encodePayload(p.roots)));
 return{file:out,report:{recordIndex,newName,packageId:guidKey(newPackage)}};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const a=process.argv.slice(2);
 if(a[0]==='--index'){
   const[,src,dst,idx,newName]=a;
   if(!newName)throw new Error('Usage: node duplicate-page.mjs --index source.rp output.rp <recordIndex> <newName>');
   const out=clonePageByIndex(readFileSync(src),Number(idx),newName);
   writeFileSync(dst,out.file,{flag:'wx'});console.log(JSON.stringify(out.report,null,2));
 }else{
   const[src,dst,sourceName,newName]=a;
   if(!newName)throw new Error('Usage: node duplicate-page.mjs source.rp output.rp sourceName newName\n       node duplicate-page.mjs --index source.rp output.rp <recordIndex> newName');
   const out=duplicatePage(readFileSync(src),sourceName,newName);
   writeFileSync(dst,out.file,{flag:'wx'});console.log(JSON.stringify(out.report,null,2));
 }
}
