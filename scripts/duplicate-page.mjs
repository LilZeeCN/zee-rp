import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readRecords,encodeRecord,replaceRecord,appendPackage,insertRecord,readManifest,encodeManifest} from './rp-records.mjs';
import {parsePayload,encodePayload,field} from './parse-payload.mjs';

// .NET GUID bytes store the first three groups in little endian.
export function guidKey(hex){const b=Buffer.from(hex,'hex');return Buffer.concat([Buffer.from(b.subarray(0,4)).reverse(),Buffer.from(b.subarray(4,6)).reverse(),Buffer.from(b.subarray(6,8)).reverse(),b.subarray(8)]).toString('hex');}

const guidTable = graph => graph.roots.find(n => n.tag === 0x1e).values;
const packageGuid = graph => guidTable(graph)[graph.roots.find(n => n.tag === 0x12).value - 1];
const RESERVED_GUIDS = new Set([
  '0'.repeat(32), '78563412cdabefcdefababcdeffedcba',
  // RP 11 built-in ConnectorPoints keys are shared constants, not private IDs.
  '4ffb380b33f19a4791117af9ea33bbd0', '0c0da41305fd2748bca3d523cb855c91',
  'a70aa02f1f4bdc499321e356041b831c', 'a70aa03f1f4bdc499321e356041b831c'
]);

function planPageCopy(file, records, pageGraph) {
  const manifest = readManifest(file), graphs = records.filter(r => ['Axure:Page', 'Axure:Master', 'Axure:PanelState'].includes(r.className))
    .map(record => ({ record, graph: parsePayload(record) }));
  const states = new Map(graphs.filter(pkg => pkg.record.className === 'Axure:PanelState').map(pkg => [packageGuid(pkg.graph), pkg]));
  const sourceGuid = packageGuid(pageGraph), owners = new Map();
  const visit = (node, owner) => {
    const pkg = graphs.find(pkg => pkg.record.offset === manifest.dataStart + (node.parts?.package ?? -9) + 8);
    if (pkg && ['Axure:Page', 'Axure:Master'].includes(pkg.record.className)) owner = packageGuid(pkg.graph);
    if (pkg?.record.className === 'Axure:PanelState') owners.set(packageGuid(pkg.graph), owner);
    for (const child of Object.values(node.children ?? {})) visit(child, owner);
  };
  visit(manifest.value.root, null);
  const packages = new Map(), identities = new Map();
  const collect = graph => {
    const table = guidTable(graph);
    for (const object of graph.objects.values()) {
      if (object.className !== 'Axure:DiagramObject:DynamicPanel') continue;
      for (const pair of field(object.body, 'panel-diagrams')?.items ?? []) {
        const guid = table[pair.values?.[1] - 1], pkg = states.get(guid);
        if (!pkg || owners.get(guid) !== sourceGuid)
          throw new Error(`PanelState ${guid} must exist and belong to the copied Page`);
        if (packages.has(guid)) continue;
        packages.set(guid, pkg);
        collect(pkg.graph);
      }
    }
  };
  collect(pageGraph);

  // Allocate by raw identity once for the whole owned package graph. Other
  // GUID slots are shared references or opaque metadata and remain unchanged.
  const allocate = guid => {
    if (!guid || RESERVED_GUIDS.has(guid)) return;
    if (!identities.has(guid)) identities.set(guid, randomBytes(16).toString('hex'));
  };
  for (const graph of [pageGraph, ...[...packages.values()].map(pkg => pkg.graph)]) {
    const table = guidTable(graph);
    allocate(packageGuid(graph));
    for (const object of graph.objects.values()) {
      allocate(table[object.id - 1]);
      for (const [key] of field(object.body, 'ConnectorPoints')?.entries ?? []) allocate(table[key.value - 1]);
    }
  }
  const widgetGuids = new Set(graphs.flatMap(pkg => [...pkg.graph.objects.values()]
    .filter(object => object.className.startsWith('Axure:DiagramObject:'))
    .map(object => guidTable(pkg.graph)[object.id - 1])));
  for (const graph of [pageGraph, ...[...packages.values()].map(pkg => pkg.graph)]) {
    const table = guidTable(graph);
    for (const object of graph.objects.values()) {
      if (object.className !== 'Axure:DiagramObjectPath' || field(object.body, 'is-dummy')?.value) continue;
      const target = table[field(object.body, 'object-id')?.value - 1];
      if (!widgetGuids.has(target) && !RESERVED_GUIDS.has(target))
        throw new Error(`DiagramObjectPath #${object.id} has unresolved target ${target}`);
    }
  }
  return { packages, identities };
}

function remapOwnedGuids(graph, identities) {
  const table = guidTable(graph);
  for (let i = 0; i < table.length; i++) if (identities.has(table[i])) table[i] = identities.get(table[i]);
}

function cloneOwnedStates(out, newPageGuid, packages, identities) {
  if (packages.size === 0) return out;
  const ownerKey = guidKey(newPageGuid);
  const findNode = (node, predicate) => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      if (predicate(key, child)) return { key, node: child };
      const found = findNode(child, predicate);
      if (found) return found;
    }
  };
  const copiedKeys = [];
  for (const [oldGuid, pkg] of packages) {
    const newGuid = identities.get(oldGuid);
    const copiedRoots = structuredClone(pkg.graph.roots);
    remapOwnedGuids({ roots: copiedRoots }, identities);
    const key = guidKey(newGuid);
    const manifestNow = readManifest(out);
    const ownerNode = findNode(manifestNow.value.root, k => k === ownerKey)?.node;
    if (!ownerNode) throw new Error(`Target page node not found in manifest: ${ownerKey}`);
    const ownerRecord = readRecords(out).find(r => r.offset - 8 - manifestNow.dataStart === ownerNode.parts.package);
    out = insertRecord(out, key, encodeRecord(pkg.record, pkg.record.strings, encodePayload(copiedRoots)), ownerRecord);
    copiedKeys.push({ key, ownerKey });
  }
  const manifest = readManifest(out);
  for (const { key, ownerKey } of copiedKeys) {
    const ownerNode = findNode(manifest.value.root, k => k === ownerKey).node;
    ownerNode.children ??= {};
    ownerNode.children[key] = manifest.value.root.children[key];
    delete manifest.value.root.children[key];
    const ordered = { children: ownerNode.children, ...ownerNode };
    for (const k of Object.keys(ownerNode)) delete ownerNode[k];
    Object.assign(ownerNode, ordered);
  }
  out = Buffer.concat([encodeManifest(out, manifest.value), out.subarray(manifest.dataStart)]);
  return out;
}

// ── duplicatePage：支持平面页与带动态面板 owned PanelState 的深层复制 ──
export function duplicatePage(file, sourceName, newName){
 const records=readRecords(file),doc=records.find(r=>r.className==='Axure:DesignDocument'),d=parsePayload(doc),dg=d.roots[0].values,strings=[...doc.strings];
 const s=text=>{let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text)}return{tag:8,value:i+1,text}};
 const infos=[...d.objects.values()].filter(n=>n.className==='Axure:PackageInfo'),info=infos.find(n=>field(n.body,'package-name')?.text===sourceName&&strings[field(n.body,'package-id').values[0]-1]==='Axure:Page');
 if(!info)throw new Error(`Page not found: ${sourceName}`);if(infos.some(n=>field(n.body,'package-name')?.text===newName))throw new Error('Duplicate page name');
 const oldPackage=dg[field(info.body,'package-id').values[1]-1],page=records.find(r=>r.className==='Axure:Page'&&parsePayload(r).roots[0].values[1]===oldPackage);
 if(!page)throw new Error('Page record not found');
 const p=parsePayload(page),pg=p.roots[0].values;

 const { packages, identities } = planPageCopy(file, records, p);
 remapOwnedGuids(p, identities);
 const packageIndex=p.roots.find(n=>n.tag===0x12).value;
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
 out=cloneOwnedStates(out, newPackage, packages, identities);
 return{file:out,report:{sourceName,newName,packageId:guidKey(newPackage),pages:records.filter(r=>r.className==='Axure:Page').length+1,ownedStates:packages.size}};
}

// ── clonePageByIndex：按记录索引克隆页面，支持复杂页 owned PanelState 闭包 ──
export function clonePageByIndex(file, recordIndex, newName, mutate){
 const records=readRecords(file);
 const page=records.find(r=>r.index===recordIndex&&r.className==='Axure:Page');
 if(!page)throw new Error(`No Axure:Page record at index ${recordIndex}`);
 const doc=records.find(r=>r.className==='Axure:DesignDocument');
 const d=parsePayload(doc),dg=d.roots[0].values,strings=[...doc.strings];
 const s=text=>{let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text)}return{tag:8,value:i+1,text}};
 const p=parsePayload(page),pg=p.roots[0].values;

 const { packages, identities } = planPageCopy(file, records, p);
 const sourcePackage=packageGuid(p);
 remapOwnedGuids(p, identities);
 const newPackage=packageGuid(p);

 if(mutate)mutate({graph:p,strings,guids:pg,record:page});

 const infos=[...d.objects.values()].filter(n=>n.className==='Axure:PackageInfo');
 if(infos.some(n=>field(n.body,'package-name')?.text===newName))throw new Error('Duplicate page name');
 const info=infos.find(n=>strings[field(n.body,'package-id').values[0]-1]==='Axure:Page'
   &&dg[field(n.body,'package-id').values[1]-1]===sourcePackage);
 if(!info)throw new Error('Source Page PackageInfo not found');
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
 out=cloneOwnedStates(out, newPackage, packages, identities);
 return{file:out,report:{recordIndex,newName,packageId:guidKey(newPackage),ownedStates:packages.size}};
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
