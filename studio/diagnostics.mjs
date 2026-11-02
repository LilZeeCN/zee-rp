import {queryAuthoringNodes} from './authoring-query.mjs';
import {NODE_READONLY_PROPERTIES,NODE_UNCONSUMED_PROPERTIES} from './node-properties.mjs';
import {nodePropertyCapability} from './node-capabilities.mjs';

// The editor and AI receive the same source resolution. A diagnostic never
// substitutes a nearby node or widens an unresolved target into the whole page.
export function locateDiagnostic({doc,scene,pageId=null,nodeIds=[],field=null,code=null,limit=4}){
  const binding={documentId:doc.documentId,revision:doc.revision,contentHash:doc.contentHash};
  const ids=[...new Set(nodeIds.filter(id=>typeof id==='string'&&id))];
  if(scene.revision!==doc.revision||/^E_(STALE|DESIGN_TARGET_STALE|SELECTION_STALE)/.test(code||''))return {binding,targets:[],complete:false,reason:'版本或请求已经过期；重新取得当前上下文后再定位'};
  const targets=[],unresolved=[];
  for(const id of ids.slice(0,limit)){
    const matches=scene.pages.filter(page=>!pageId||page.id===pageId).flatMap(page=>page.nodes).filter(node=>node.id===id||node.scopedId===id);
    if(matches.length!==1){unresolved.push({id,reason:matches.length?'ambiguous':'not-found'});continue;}
    const node=matches[0];
    try{
      const query=queryAuthoringNodes({doc,scene,args:{pageId:node.pageId,nodeIds:[node.scopedId],limit:1,fields:['id','scopedId','pageId','bounds','target']}});
      const target=query.nodes[0];
      const fieldSupport=field?(NODE_READONLY_PROPERTIES.has(field)?'read-only':NODE_UNCONSUMED_PROPERTIES.has(field)?'unsupported':target.target?.kind==='macro-parameter'?(target.target.propertyMap?.[field]?'exposed-via-macro-parameter':target.target.property!==field?'controlled-property-not-exposed':'exposed-via-macro-parameter'):(nodePropertyCapability(node.type,field)?.surfaces?.canvas?.status||'unsupported')):null;
      targets.push({...target,...(field?{field,fieldSupport}:{})});
    }catch(error){unresolved.push({id,reason:error.code||'source-unavailable'});}
  }
  return {binding,targets,total:ids.length,returned:targets.length,complete:targets.length===ids.length,unresolved,
    ...(ids.length>limit?{omittedNodeIds:ids.slice(limit)}:{}),
    ...(ids.length?{next:{tool:'studio_query_nodes',arguments:{...(pageId?{pageId}:{}),nodeIds:ids.slice(0,32),fields:['target','bounds','controls']},note:'按binding确认版本；使用target中的源宏参数/实例覆盖，不把截图坐标写回。'}}:{reason:'此问题针对整个页面，没有虚构可编辑节点'})};
}

export function errorDiagnostic(error,studio){
  return {code:error.code||'E_INTERNAL_ERROR',message:error.message,
    ...locateDiagnostic({doc:studio.store.doc,scene:studio.scene,nodeIds:error.nodeId?[error.nodeId]:[],field:error.field,code:error.code}),
    ...(error.sourceSpan?{sourceSpan:error.sourceSpan}:{}),...(error.line?{line:error.line,column:error.column}:{}),
    stage:error.stage||'command-or-render',
  };
}
