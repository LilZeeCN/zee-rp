import { canonicalJson } from './document.mjs';
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
export function diffDocuments(before,after,{limit=200}={}) {
 const changes=[];let total=0;
 const push=change=>{total++;if(changes.length<limit)changes.push(change);};
 function visit(a,b,path){
  if(equal(a,b))return;
  if(Array.isArray(a)&&Array.isArray(b)&&[...a,...b].every(v=>v&&typeof v==='object'&&typeof v.id==='string')){
   const aa=new Map(a.map(v=>[v.id,v])),bb=new Map(b.map(v=>[v.id,v]));
   if(!equal(a.map(v=>v.id),b.map(v=>v.id)))push({path:[...path,'$order'],kind:'order',before:a.map(v=>v.id),after:b.map(v=>v.id)});
   for(const id of new Set([...aa.keys(),...bb.keys()]))visit(aa.get(id),bb.get(id),[...path,id]);return;
  }
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
   for(const key of new Set([...Object.keys(a),...Object.keys(b)]))visit(a[key],b[key],[...path,key]);return;
  }
  push({path,kind:a===undefined?'added':b===undefined?'removed':'changed',...(a===undefined?{}:{before:a}),...(b===undefined?{}:{after:b})});
 }
 const omit=doc=>Object.fromEntries(Object.entries(doc).filter(([key])=>!['revision','updatedAt','createdAt','contentHash','diagnostics'].includes(key)));
 visit(omit(before),omit(after),[]);return {total,returned:changes.length,truncated:total>changes.length,changes};
}
