import {randomUUID} from 'node:crypto';
import {buildNodeIndex,canonicalJson} from './document.mjs';
import {queryAuthoringNodes} from './authoring-query.mjs';
const fail=(code,message,extra={})=>{throw Object.assign(new Error(message),{code,...extra})};
export class StudioSelections {
 constructor(){this.clients=new Map();}
 publish(doc,scene,value){
  const fields=['clientId','documentId','pageId','revision','contentHash','nodeIds'];for(const key of Object.keys(value))if(!fields.includes(key))fail('E_SELECTION_INPUT',`选区不接受字段 ${key}`);
  if(typeof value.clientId!=='string'||!value.clientId||value.clientId.length>120||value.documentId!==doc.documentId||!doc.pages.some(page=>page.id===value.pageId))fail('E_SELECTION_INPUT','选区需要当前工程、页面与客户端身份');
  if(!Number.isInteger(value.revision)||typeof value.contentHash!=='string'||!Array.isArray(value.nodeIds)||value.nodeIds.length>200||value.nodeIds.some(id=>typeof id!=='string'||!id))fail('E_SELECTION_INPUT','选区需要版本、内容哈希与最多200个明确ID');
  const previous=this.clients.get(value.clientId);if(previous&&canonicalJson(previous.target)===canonicalJson(value))return previous;
  const record={selectionId:'sel_'+randomUUID(),target:structuredClone(value),receivedAt:new Date().toISOString()};this.clients.set(value.clientId,record);return record;
 }
 summary(doc){return [...this.clients.values()].map(({selectionId,target,receivedAt})=>({selectionId,...target,receivedAt,stale:target.revision!==doc.revision||target.contentHash!==doc.contentHash}));}
 resolve(doc,scene,{clientId,selectionId}={}){
  const records=clientId?[this.clients.get(clientId)].filter(Boolean):[...this.clients.values()].filter(record=>record.target.nodeIds.length);
  if(records.length!==1)fail(records.length?'E_SELECTION_AMBIGUOUS':'E_SELECTION_EMPTY',records.length?'有多个画布客户端的选区，请明确clientId':'当前没有明确选区；未扩大成整页',{candidates:records.map(r=>({clientId:r.target.clientId,selectionId:r.selectionId,pageId:r.target.pageId}))});
  const record=records[0],{target}=record;
  if(selectionId&&selectionId!==record.selectionId)fail('E_SELECTION_CHANGED','画布选择已经改变，请重新取回选区');
  if(target.revision!==doc.revision||target.contentHash!==doc.contentHash)fail('E_SELECTION_STALE','选区所依据的文档已变化；未沿用旧范围');
  if(!target.nodeIds.length)fail('E_SELECTION_EMPTY','选区为空；未扩大成整页');
  const query=queryAuthoringNodes({doc,scene,args:{pageId:target.pageId,nodeIds:target.nodeIds,limit:200}});
  if(query.empty||query.nodes.some(node=>!node.target?.editable))fail('E_SELECTION_CONTROLLED','选区含有无法直接回写的节点，请选择其控制源');
  return {selectionId:record.selectionId,target:{pageId:target.pageId,documentId:target.documentId,revision:target.revision,contentHash:target.contentHash,nodeIds:target.nodeIds},query};
 }
 guard(doc,scene,selectionId){
  const current=[...this.clients.values()].find(record=>record.selectionId===selectionId);if(!current)fail('E_SELECTION_CHANGED','该选区已改变或关闭，请重新查询');
  const resolved=this.resolve(doc,scene,{clientId:current.target.clientId,selectionId}),index=buildNodeIndex(doc),wanted=new Set(resolved.query.nodes.map(node=>index.byScopedId.get(node.target.nodeId)?.node).filter(Boolean)),paths=[];
  function walk(node,path){if(wanted.has(node))paths.push(path);for(const child of node.children||[])walk(child,[...path,'children',child.id]);for(const state of node.states||[])if(state.root)walk(state.root,[...path,'states',state.id,'root']);if(node.template)walk(node.template,[...path,'template']);}
  for(const page of doc.pages)walk(page.root,['pages',page.id,'root']);
  if(!paths.length)fail('E_SELECTION_EMPTY','选区没有可修改源；未扩大范围');return {selectionId,paths};
 }
}
