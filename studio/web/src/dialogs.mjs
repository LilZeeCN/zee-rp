import { escapeHtml, showToast } from './ui.mjs';
import { apiPost } from './api.mjs';
import { applyServerSnapshot } from './sync.mjs';
import { getActivePageScene, layerDisplayName } from './view.mjs';
import { renderAll, updateCanvasTransform } from './render.mjs';
import { state } from './state.mjs';

export function focusDiagnosticTarget(location,binding){
  if(state.doc.documentId!==binding.documentId||state.doc.contentHash!==binding.contentHash||state.appliedRevision!==binding.revision){showToast('画布已变化，请重新取得当前问题后定位。','warn',5000);return false;}
  const page=state.scene.pages.find(item=>item.id===location.pageId),owner=location.target?.nodeId;
  const node=page?.nodes.find(item=>item.scopedId===owner)||page?.nodes.find(item=>item.scopedId===location.scopedId);
  if(!node){showToast('当前图层无法定位，范围未扩大。','warn',5000);return false;}
  state.activePageId=page.id;state.mode='design';state.selectedIds=[node.id];renderAll();
  const element=document.querySelector(`[data-scoped-id="${CSS.escape(node.scopedId)}"]`),viewport=document.getElementById('canvas-viewport');
  if(element&&viewport){const rect=element.getBoundingClientRect(),bounds=viewport.getBoundingClientRect(),left=document.getElementById('left-sidebar').offsetWidth+40,right=document.getElementById('inspector-shell').offsetWidth+40;state.panX+=bounds.left+left+(viewport.clientWidth-left-right)/2-(rect.x+rect.width/2);state.panY+=bounds.top+viewport.clientHeight/2-(rect.y+rect.height/2);updateCanvasTransform();}
  return true;
}

export async function showProjectOperations(){
  let dialog=document.querySelector('#project-operations-dialog');if(dialog){dialog.showModal();return;}
  dialog=document.createElement('dialog');dialog.id='project-operations-dialog';dialog.className='version-dialog';
  dialog.innerHTML='<button class="version-close" aria-label="关闭操作">关闭</button><h2>操作记录</h2><p>关闭面板后仍会继续。取消请求与实际停止会分别显示。</p><div class="operation-message" role="status"></div><div class="operation-list"></div>';
  document.body.append(dialog);dialog.showModal();let timer,busy=false,lastCancelledId=null;
  dialog.querySelector('.version-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{clearTimeout(timer);dialog.remove();},{once:true});
  const request=body=>apiPost('/api/operations',body),list=dialog.querySelector('.operation-list'),message=dialog.querySelector('.operation-message');
  const phaseNames={queued:'已排队',snapshotting:'正在固定输入', 'compiling-rp':'正在生成原生原型','preparing-media':'正在处理素材','preparing-crop':'正在生成裁切','opening-preview':'正在打开预演','rendering-candidate':'正在渲染候选','checking-state':'正在检查交互状态','building-contact-sheet':'正在整理对照图',publishing:'正在保存结果',completed:'已完成',stopping:'取消已请求，等待停止',stopped:'已停止',failed:'失败'};
  const refresh=async()=>{
    if(!dialog.isConnected||busy)return;busy=true;
    try{
      const data=await request({action:'list',limit:20});list.replaceChildren();
      const lastCancelled=data.operations.find(item=>item.id===lastCancelledId);
      if(lastCancelled?.status==='cancelled')message.textContent='已确认停止。';
      if(!data.operations.length)list.textContent='还没有操作记录。';
      for(const operation of data.operations){
        const row=document.createElement('article');row.className='version-row';
        const title=document.createElement('strong');title.textContent=({'export-rp':'导出原型',explore:'设计预演',media:'处理素材'}[operation.kind]||'操作')+' · '+(operation.status==='interrupted'?'已中断，请核对现场':phaseNames[operation.phase]||operation.phase);row.append(title);
        if(operation.resultSummary?.validationPassed===false||operation.resultSummary?.candidates?.some(item=>item.status!=='rendered'))title.textContent+='，存在未通过项';
        const note=document.createElement('p');note.textContent=`基于第${operation.binding.revision}版`+(operation.sourceApplicability==='current'?'':' · 画布已变化，使用结果前需重新核对');row.append(note);
        if(operation.detail){const detail=document.createElement('p');detail.textContent=[operation.detail.candidateId,operation.detail.stateId,operation.detail.total?`第${operation.detail.index+1}/${operation.detail.total}项`:null].filter(Boolean).join(' · ');row.append(detail);}
        if(['queued','running','cancelling'].includes(operation.status)){
          const cancel=document.createElement('button');cancel.textContent=operation.cancelRequested?'等待停止':'取消';cancel.disabled=operation.cancelRequested||operation.phase==='publishing';cancel.onclick=async()=>{cancel.disabled=true;lastCancelledId=operation.id;try{const result=await request({action:'cancel',id:operation.id});message.textContent=result.status==='cancelled'?'已确认停止。':result.cancellation.accepted?'取消请求已收到，正在等待停止。':'操作已进入完成阶段，请核对结果。';}catch(error){message.textContent=error.message;}await refresh();};row.append(cancel);
        }
        if(operation.resultSummary?.output){const path=document.createElement('p');path.textContent=operation.resultSummary.output;row.append(path);}
        if(operation.diagnostic){const text=document.createElement('p');text.textContent=operation.diagnostic.message;row.append(text);}
        if(operation.diagnostic?.targets?.length){const button=document.createElement('button');button.textContent='定位问题图层';button.disabled=operation.sourceApplicability!=='current';button.onclick=()=>{if(focusDiagnosticTarget(operation.diagnostic.targets[0],operation.diagnostic.binding))dialog.close();};row.append(button);}
        const details=document.createElement('details'),label=document.createElement('summary'),path=document.createElement('p');label.textContent='查看记录位置';path.textContent=operation.resultPath||operation.directory;details.append(label,path);row.append(details);list.append(row);
      }
    }catch(error){message.textContent=error.message;}
    finally{busy=false;if(dialog.isConnected)timer=setTimeout(refresh,700);}
  };
  await refresh();
}

export async function showProjectVersions() {
  let dialog=document.querySelector('#project-versions-dialog');
  if(dialog){dialog.showModal();return;}
  dialog=document.createElement('dialog');dialog.id='project-versions-dialog';dialog.className='version-dialog';
  dialog.innerHTML=`<button class="version-close" aria-label="关闭版本">关闭</button><h2>工程版本</h2><p>为重要节点留一个名字。恢复前可以查看差异，恢复后仍可撤销。</p><form class="version-form"><input name="versionName" aria-label="版本名称" placeholder="例如：第一版交互确认" maxlength="80" required><button type="submit">保存当前版本</button></form><div class="version-message" role="status"></div><div class="version-list"></div><div class="version-preview" hidden></div>`;
  document.body.append(dialog);dialog.showModal();dialog.querySelector('.version-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  const message=dialog.querySelector('.version-message'),list=dialog.querySelector('.version-list'),preview=dialog.querySelector('.version-preview');
  const request=async body=>{const result=await apiPost('/api/versions',body);if(!result.ok)throw Error(result.message||'版本操作未完成');return result;};
  const refresh=async()=>{
    const data=await request({action:'list'});list.innerHTML=data.versions.length?data.versions.map(v=>`<div class="version-row"><span>${escapeHtml(v.name)}<small>修订 ${v.revision} · ${escapeHtml(new Date(v.createdAt).toLocaleString())}</small></span><button data-version="${escapeHtml(v.id)}">查看差异</button></div>`).join(''):'<p>还没有命名版本。</p>';
    for(const button of list.querySelectorAll('[data-version]'))button.onclick=async()=>{
      button.disabled=true;try{const data=await request({action:'preview',versionId:button.dataset.version,baseRevision:state.appliedRevision});
        const labels={pages:'页面',components:'组件',tokens:'样式',palette:'色板',variables:'变量',datasets:'数据',fonts:'字体',assetsManifest:'素材',designDecisions:'设计决定'};
        const groups=[...new Set(data.diff.changes.map(change=>labels[change.path[0]]||change.path[0]))];
        const fieldLabels={text:'文字',fontSize:'字号',color:'文字颜色',fill:'底色',x:'横向位置',y:'纵向位置',w:'宽度',h:'高度',visible:'可见状态',layout:'布局',gap:'间距',name:'名称',src:'图片'};
        const changeLabel=change=>{const index=change.path.lastIndexOf('children'),id=index>=0?change.path[index+1]:null;const node=getActivePageScene()?.nodes.find(n=>n.id===id),field=fieldLabels[change.path.at(-1)]||'内容';return node?`图层「${layerDisplayName(node)}」的${field}`:`${labels[change.path[0]]||'工程'}的${field}`;};
        const display=value=>{if(value===undefined)return'空';if(typeof value==='string')return value.length>120?value.slice(0,120)+'…':value;if(typeof value==='object')return Array.isArray(value)?`${value.length} 项内容`:'一组内容';return String(value);};preview.hidden=false;preview.innerHTML=`<strong>恢复为「${escapeHtml(data.version.name)}」</strong><p>${data.diff.total?`共有 ${data.diff.total} 处差异，涉及${escapeHtml(groups.join('、'))}。`:'内容与当前版本相同。'}</p><ul>${data.diff.changes.slice(0,12).map(change=>`<li>${escapeHtml(changeLabel(change))}：${escapeHtml(change.kind==='added'?'添加':change.kind==='removed'?'移除':change.kind==='order'?'调整顺序':`${display(change.before)} → ${display(change.after)}`)}</li>`).join('')}</ul><button class="version-restore">恢复这个版本</button>`;
        const restore=preview.querySelector('.version-restore'),identity=`version-restore-${crypto.randomUUID()}`;restore.onclick=async()=>{restore.disabled=true;try{const result=await request({action:'restore',versionId:data.version.id,baseRevision:data.baseRevision,previewHash:data.previewHash,idempotencyKey:identity});await applyServerSnapshot(result);message.textContent='已恢复。需要时可在画布撤销。';preview.hidden=true;await refresh();}catch(error){message.textContent=error.message;}finally{restore.disabled=false;}};
      }catch(error){message.textContent=error.message;}finally{button.disabled=false;}
    };
  };
  dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;try{await request({action:'create',name:new FormData(event.currentTarget).get('versionName'),baseRevision:state.appliedRevision,idempotencyKey:`version-save-${crypto.randomUUID()}`});message.textContent='当前版本已保存。';await refresh();}catch(error){message.textContent=error.message;}finally{button.disabled=false;}};
  try{await refresh();}catch(error){message.textContent=error.message;}
}
