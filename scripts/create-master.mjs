// Offline: duplicate an existing Axure:Master record into a new named master.
// Modeled on duplicate-page.mjs (proven). Usage:
//   node create-master.mjs <source.rp> <output.rp> <SourceMasterName> <NewMasterName>
import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readRecords,encodeRecord,replaceRecord,appendPackage} from './rp-records.mjs';
import {parsePayload,encodePayload,field} from './parse-payload.mjs';
import {guidKey} from './duplicate-page.mjs';

export function duplicateMaster(file, sourceName, newName){
 const records=readRecords(file),doc=records.find(r=>r.className==='Axure:DesignDocument');
 const d=parsePayload(doc),dg=d.roots[0].values,strings=[...doc.strings];
 const s=text=>{let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text)}return{tag:8,value:i+1,text}};
 // locate the existing MasterPackageInfo by package-name
 const infos=[...d.objects.values()].filter(n=>n.className==='Axure:MasterPackageInfo');
 const info=infos.find(n=>field(n.body,'package-name')?.text===sourceName);
 if(!info)throw new Error(`Master not found: ${sourceName}`);
 if(infos.some(n=>field(n.body,'package-name')?.text===newName))throw new Error('Duplicate master name');
 // locate the source Axure:Master record by the package GUID (package-id[1] → dg index, 1-based)
 const pkgGuidIdx=field(info.body,'package-id').values[1];
 const masterGuid=dg[pkgGuidIdx-1];
 const master=records.find(r=>r.className==='Axure:Master'&&parsePayload(r).roots[0].values.includes(masterGuid));
 if(!master)throw new Error('Master record not found by package GUID');
 // duplicate the Master record with fresh GUIDs
 const m=parsePayload(master),mg=m.roots[0].values;
 for(const id of m.objects.keys())mg[id-1]=randomBytes(16).toString('hex');
 const packageIndex=m.roots.find(n=>n.tag===0x12).value;mg[packageIndex-1]=randomBytes(16).toString('hex');
 const newPackage=mg[packageIndex-1];
 const alloc=hex=>{dg.push(hex??randomBytes(16).toString('hex'));return dg.length};
 const newNodeId=alloc(),newInfoId=alloc(),newPackageId=alloc(newPackage);
 const newInfo=structuredClone(info);newInfo.id=newInfoId;
 field(newInfo.body,'package-id').values[1]=newPackageId;
 Object.assign(field(newInfo.body,'package-name'),s(newName));
 // find the masters tree + node-table inside MasterTreeMap
 const masterMap=[...d.objects.values()].find(n=>n.className==='Axure:MasterTreeMap');
 if(!masterMap)throw new Error('MasterTreeMap not found');
 const treeId=field(masterMap.body,'tree').value,tree=d.objects.get(treeId);
 const ref=value=>({tag:3,value});
 // register info id in whatever list already holds the existing master info id
 const root=d.objects.get(d.roots.find(n=>n.tag===0xf).value);
 const registered=[];
 for(const [k,v] of root.body.entries){
   if(v.items?.some(i=>i.value===info.id)){v.items.push(ref(newInfoId));registered.push(k.text);}
 }
 if(!registered.length)throw new Error('No list references the existing MasterPackageInfo');
 field(masterMap.body,'node-table').entries.push([ref(newNodeId),{tag:0x13,values:[s('Axure:MasterPackageInfo').value,newPackageId]}]);
 field(tree.body,'children').items.push(ref(newNodeId));
 const node={tag:9,id:newNodeId,classIndex:s('Axure:Node').value,className:'Axure:Node',
   body:{tag:1,entries:[[s('children'),{tag:2,items:[]}],[s('parent-node'),ref(tree.id)],[s('tree'),ref(tree.id)]]}};
 // DesignDocument 的插入点是「最后一个 root 之前」，不是「GUID 列表之前」（见 duplicate-page.mjs 说明）
 d.roots.splice(d.roots.length-1,0,newInfo,node);
 let out=replaceRecord(file,doc,encodeRecord(doc,strings,encodePayload(d.roots)));
 out=appendPackage(out,guidKey(newPackage),encodeRecord(master,master.strings,encodePayload(m.roots)));
 return{file:out,report:{sourceName,newName,packageId:guidKey(newPackage),
   masters:records.filter(r=>r.className==='Axure:Master').length+1,registered}};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const[src,dst,sourceName,newName]=process.argv.slice(2);
 if(!newName)throw new Error('Usage: node create-master.mjs source.rp output.rp SourceMasterName NewMasterName');
 const out=duplicateMaster(readFileSync(src),sourceName,newName);
 writeFileSync(dst,out.file,{flag:'wx'});
 console.log(JSON.stringify(out.report,null,2));
}
