import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync, copyFileSync, openSync, closeSync, constants } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256, assertNotProtected } from './document.mjs';

const worker = fileURLToPath(new URL('./operation-worker.mjs', import.meta.url));
const terminal = new Set(['succeeded','failed','cancelled','interrupted']);
const fail = (code,message) => {throw Object.assign(new Error(message),{code});};
const read = path => {try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){throw Object.assign(new Error(`操作记录无法读取：${path}（${error.message}）`),{code:'E_OPERATION_RECORD',detailsPath:path});}};
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const stamp = () => new Date().toISOString();
const safeId = id => typeof id==='string' && /^op_[0-9a-f-]{36}$/.test(id);

export const OPERATION_PROPERTIES = {async:{type:'boolean',description:'true在工程内持久记录并返回句柄；结果未知时按requestKey核对，不重做'},requestKey:{type:'string',minLength:1,maxLength:200},baseRevision:{type:'integer',minimum:1}};

export function writeOperationFile(path,value){
  mkdirSync(dirname(path),{recursive:true});const tmp=`${path}.tmp-${randomUUID()}`;
  try{writeFileSync(tmp,JSON.stringify(value,null,2));renameSync(tmp,path);}finally{rmSync(tmp,{force:true});}
}

export async function withOperationLock(directory,run){
  const lock=join(directory,'.lock'),deadline=Date.now()+600;
  while(true){
    try{mkdirSync(lock);writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid}));break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let owner;try{owner=read(join(lock,'owner.json'));}catch{}
      let alive=false;if(owner?.pid){try{process.kill(owner.pid,0);alive=true;}catch{}}
      let age;try{age=Date.now()-lstatSync(lock).mtimeMs;}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!alive&&(owner||age>2000)){rmSync(lock,{recursive:true,force:true});continue;}
      if(Date.now()>=deadline)fail('E_OPERATION_BUSY','操作状态正在提交，请按原身份重新核对；未重做任务');
      await sleep(15);
    }
  }
  try{return await run();}finally{rmSync(lock,{recursive:true,force:true});}
}

function processGroup(state){
  if(!state.pid)return {members:[],verified:false};
  const result=spawnSync('ps',['-ww','-axo','pid=,pgid=,stat=,command='],{encoding:'utf8',timeout:1000,maxBuffer:4*1024*1024});
  if(result.status!==0)fail('E_OPERATION_PROCESS_QUERY','不能核实进程是否已停止；保留当前状态');
  const members=result.stdout.split('\n').map(line=>/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean).map(m=>({pid:Number(m[1]),group:Number(m[2]),stat:m[3],command:m[4]})).filter(p=>p.group===state.pid&&!p.stat.startsWith('Z'));
  const leader=members.find(p=>p.pid===state.pid);
  // A live group leader must still be the exact worker we started. An orphaned
  // group is retained only while its members carry this operation's paths.
  const verified=leader ? leader.command.includes(worker)&&leader.command.includes(state.directory)&&leader.command.includes(state.id) : members.length>0&&members.every(p=>p.command.includes(state.directory));
  return {members,verified};
}

function signalOwned(state,signal){
  const group=processGroup(state);
  if(group.members.length&&!group.verified)fail('E_OPERATION_OWNER','进程身份与本操作不符，未发送终止信号');
  if(group.members.length){try{process.kill(-state.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
  return group;
}

function collectResources(doc,projectDir,input,kind){
  const resources=new Map();
  const add=(relativePath,expected=null)=>{
    if(typeof relativePath!=='string'||!relativePath||relativePath.includes('\\')||relativePath.split('/').some(x=>!x||x==='.'||x==='..')||relativePath.startsWith('/'))fail('E_OPERATION_RESOURCE','异步操作需要工程内相对资源路径；先登记并本地化素材');
    const source=resolve(projectDir,relativePath);assertNotProtected(source);
    if(!existsSync(source)||!lstatSync(source).isFile()||lstatSync(source).isSymbolicLink())fail('E_OPERATION_RESOURCE',`资源缺失或不可冻结：${relativePath}`);
    const hash=sha256(readFileSync(source));if(expected&&hash!==expected)fail('E_OPERATION_RESOURCE_DRIFT',`资源字节与登记版本不同：${relativePath}`);
    resources.set(relativePath,{source,path:relativePath,sha256:hash});
  };
  for(const asset of Object.values(doc.assetsManifest||{})){add(asset.relativePath,asset.sha256);if(asset.media?.originalPath)add(asset.media.originalPath);}
  const inspect=value=>{if(!value||typeof value!=='object')return;if(value.type==='image'&&value.src)add(value.src);if(value.type==='registerAsset'&&value.asset?.relativePath)add(value.asset.relativePath,value.asset.sha256);for(const item of Object.values(value))if(item&&typeof item==='object'){if(Array.isArray(item))item.forEach(inspect);else inspect(item);}};
  inspect(doc);if(kind==='explore')inspect(input.candidates);
  const fonts=join(projectDir,'fonts');
  const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile())add(relative(projectDir,file).split(sep).join('/'));else fail('E_OPERATION_RESOURCE','字体目录中的链接不能作为固定版本资源');}};
  if(existsSync(fonts))walk(fonts);
  if(kind==='media'){
    const source=resolve(input.sourcePath);assertNotProtected(source);const suffix=source.match(/\.[a-z0-9]{1,8}$/i)?.[0]||'.img';
    resources.set('$media-source',{source,path:`input/source${suffix}`,sha256:sha256(readFileSync(source))});
  }
  return [...resources.values()];
}

function stripApply(value){
  if(Array.isArray(value))return value.map(stripApply);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['applyWith','registerCommand'].includes(key)).map(([key,item])=>[key,stripApply(item)]));
}

export class StudioOperations{
  constructor(projectDir){this.projectDir=resolve(projectDir);this.root=join(this.projectDir,'.studio-operations');}
  directory(id){if(!safeId(id))fail('E_OPERATION_ID','需要有效的操作ID');return join(this.root,id);}
  locate({id,requestKey}={}){
    if(id&&requestKey)fail('E_OPERATION_ID','id和requestKey二选一');
    if(requestKey){if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>200)fail('E_OPERATION_KEY','requestKey需要1–200字符');const key=join(this.root,'keys',sha256(requestKey)+'.json');if(!existsSync(key))fail('E_OPERATION_NOT_FOUND','没有该requestKey的持久记录；未自动执行');id=read(key).id;}
    const directory=this.directory(id);if(!existsSync(join(directory,'state.json')))fail('E_OPERATION_NOT_FOUND','操作记录不存在；未自动执行');return {id,directory};
  }
  async start(kind,args,doc){
    if(process.platform==='win32')fail('E_OPERATION_PLATFORM','当前异步操作的进程组终止仅支持macOS/Linux；同步入口仍可用');
    if(!['export-rp','explore','media','sync-native','export-code'].includes(kind))fail('E_OPERATION_KIND','不支持的操作类型');
    const requestKey=args.requestKey,input=structuredClone(args);
    for(const key of ['async','requestKey','url','port','projectDir'])delete input[key];
    const allowed=kind==='export-rp'?['baseRevision','outRpPath','outReportPath']:kind==='media'?['baseRevision','sourcePath','crops','credit']:kind==='sync-native'?['baseRevision','rpPath','baseRpPath','baselinePath','mode','prefer','resolutions','previewHash','allowFormulaOverwrite']:kind==='export-code'?['baseRevision','outDir','resetRegistration']:['baseRevision','pageId','candidates','states','preserve','axes','limit'];
    if(Object.keys(input).some(key=>!allowed.includes(key)))fail('E_OPERATION_FIELD','长操作包含未支持字段；未创建任务');
    if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>200)fail('E_OPERATION_KEY','async:true需要唯一requestKey，断连后用同一身份核对');
    if(!Number.isInteger(input.baseRevision))fail('E_OPERATION_REVISION','async:true需要当前baseRevision');
    if(kind==='export-rp'&&(input.outRpPath||input.outReportPath))fail('E_OPERATION_OUTPUT','异步导出保存在独立操作目录；自定义覆盖路径请使用同步导出');
    if(kind==='export-code'&&input.outDir)fail('E_OPERATION_OUTPUT','异步代码导出保存在独立操作目录；自定义覆盖路径请使用同步导出');
    if(kind==='sync-native'&&input.mode==='apply')fail('E_OPERATION_MODE','异步原生同步仅执行 preview 计算，确认结果后同步提交 apply');
    const requestHash=sha256(canonicalJson({kind,input}));
    mkdirSync(this.root,{recursive:true});mkdirSync(join(this.root,'keys'),{recursive:true});
    const key=join(this.root,'keys',sha256(requestKey)+'.json');
    return withOperationLock(this.root,async()=>{
      if(existsSync(key)){const prior=read(key);if(prior.requestHash!==requestHash)fail('E_OPERATION_KEY_REUSED','同一requestKey已经对应不同参数；未重做');return {...await this.get({id:prior.id}),replayed:true};}
      if(input.baseRevision!==doc.revision)fail('E_OPERATION_STALE','画布版本已变化，请确认后启动；未创建任务');
      const resources=collectResources(doc,this.projectDir,input,kind);
      const id='op_'+randomUUID(),directory=this.directory(id);mkdirSync(directory);mkdirSync(join(directory,'tmp'));
      const binding={documentId:doc.documentId,revision:doc.revision,contentHash:doc.contentHash};
      const state={id,directory,kind,requestKey,requestHash,binding,status:'queued',phase:'queued',createdAt:stamp(),updatedAt:stamp(),pid:null,cancelRequested:false};
      writeOperationFile(join(directory,'request.json'),{id,kind,input,doc,resources,binding,projectDir:this.projectDir});
      writeOperationFile(join(directory,'state.json'),state);writeOperationFile(key,{id,requestHash});
      const log=openSync(join(directory,'worker.log'),'a');let child;
      try{
        child=spawn(process.execPath,[worker,directory,id],{detached:true,stdio:['ignore',log,log],env:{...process.env,TMPDIR:join(directory,'tmp'),ZEE_STUDIO_OPERATION_DIR:directory}});
        await withOperationLock(directory,()=>{const current=read(join(directory,'state.json'));writeOperationFile(join(directory,'state.json'),{...current,pid:child.pid||current.pid});});
        child.on('error',error=>{void this.update(id,current=>terminal.has(current.status)?current:{...current,status:'failed',phase:'spawn',diagnostic:{code:error.code||'E_OPERATION_SPAWN',message:error.message}}).catch(()=>{});});
        child.unref();
      }finally{closeSync(log);}
      return {...await this.get({id}),replayed:false};
    });
  }
  async update(id,mutate){const directory=this.directory(id);return withOperationLock(directory,()=>{const state=read(join(directory,'state.json')),next=mutate(state);writeOperationFile(join(directory,'state.json'),{...next,updatedAt:stamp()});return next;});}
  async reconcile(id){
    let state=read(join(this.directory(id),'state.json'));
    if(terminal.has(state.status))return state;
    const group=processGroup(state);
    if(group.members.length&&!group.verified){
      // After SIGTERM the group leader can exit before its browser helpers.
      // Keep waiting for exit; neither signal unverified PIDs nor declare a stop.
      if(state.cancelRequested)return state;
      return this.update(id,current=>terminal.has(current.status)?current:{...current,status:'interrupted',phase:'owner-unverified',stopConfirmed:false,diagnostic:{code:'E_OPERATION_OWNER',message:'进程身份无法核对，未发送终止信号；请保留现场核查'}});
    }
    if(state.cancelRequested&&group.members.length&&group.verified&&Date.now()-Date.parse(state.cancelRequestedAt)>=1000)signalOwned(state,'SIGKILL');
    if(!group.members.length&&(state.pid||Date.now()-Date.parse(state.createdAt)>2000))state=await this.update(id,current=>terminal.has(current.status)?current:{...current,status:current.cancelRequested?'cancelled':'interrupted',phase:current.pid?'stopped':'interrupted-before-start',stoppedAt:stamp(),stopConfirmed:Boolean(current.pid),diagnostic:current.cancelRequested?null:{code:'E_OPERATION_INTERRUPTED',message:'工作进程已停止但没有确认完成；保留现场，未自动重做'}});
    return state;
  }
  async get(args={}){
    if(Object.keys(args).some(key=>!['id','requestKey','includeResult'].includes(key)))fail('E_OPERATION_FIELD','get只接受id/requestKey与includeResult');
    const {id,directory}=this.locate(args);const state=await this.reconcile(id);
    const {pid,requestHash,...publicState}=state;
    let current;try{current=read(join(this.projectDir,'document.json'));}catch{}
    let applicable=!!current&&current.documentId===state.binding.documentId&&current.revision===state.binding.revision&&current.contentHash===state.binding.contentHash;
    if(applicable&&state.status==='succeeded')for(const resource of read(join(directory,'request.json')).resources){try{if(sha256(readFileSync(resource.source))!==resource.sha256)applicable=false;}catch{applicable=false;}}
    const resultPath=join(directory,'result.json');let result;
    if(args.includeResult&&state.status==='succeeded'&&existsSync(resultPath)){result=read(resultPath);if(!applicable)result=stripApply(result);}
    return {ok:true,...publicState,sourceApplicability:applicable?'current':'stale-or-unavailable',documentChanged:false,
      ...(existsSync(resultPath)?{resultPath}:{}),...(result?{result}:{}),
      next:terminal.has(state.status)?'结果与原始binding关联；过期结果可查看，但不能作为当前稿的提交建议。':'按id或原requestKey查询；断连不会重做任务。取消确认与实际停止分别报告。'};
  }
  async list(args={}){
    if(Object.keys(args).some(key=>key!=='limit'))fail('E_OPERATION_FIELD','list只接受limit');
    const {limit=20}=args;
    if(!Number.isInteger(limit)||limit<1||limit>100)fail('E_OPERATION_LIMIT','limit需要1–100');
    if(!existsSync(this.root))return {ok:true,operations:[],total:0};
    const entries=readdirSync(this.root).filter(safeId).map(id=>({id,time:lstatSync(join(this.root,id)).mtimeMs})).sort((a,b)=>b.time-a.time);
    const operations=[];for(const {id} of entries.slice(0,limit))operations.push(await this.get({id}));return {ok:true,operations,total:entries.length,returned:operations.length};
  }
  async cancel(args){
    if(Object.keys(args).some(key=>!['id','requestKey'].includes(key)))fail('E_OPERATION_FIELD','cancel只接受id或requestKey');
    const {id,directory}=this.locate(args);let accepted=false;
    const state=await this.update(id,current=>{
      if(terminal.has(current.status)||current.phase==='publishing'||current.cancelRequested)return current;
      accepted=true;return {...current,status:'cancelling',phase:'stopping',cancelRequested:true,cancelRequestedAt:current.cancelRequestedAt||stamp()};
    });
    if(accepted){
      signalOwned(state,'SIGTERM');
      const child=spawn(process.execPath,[worker,directory,id,'cancel-watch'],{detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
    }
    return {...await this.get({id}),cancellation:{accepted,reason:accepted?'requested':state.phase==='publishing'?'completion_in_progress':`already_${state.status}`}};
  }
}

export async function runStudioOperation(directory,id){
  const request=read(join(directory,'request.json')),operations=new StudioOperations(request.projectDir);
  if(request.id!==id||operations.directory(id)!==resolve(directory))fail('E_OPERATION_ID','操作记录与执行目录不一致');
  let studio;
  const progress=async(phase,detail=null)=>{
    const state=await operations.update(id,current=>current.cancelRequested||terminal.has(current.status)?current:{...current,pid:process.pid,status:'running',phase,detail});
    if(state.cancelRequested||terminal.has(state.status))fail('E_OPERATION_CANCELLED','操作已收到取消或停止');
  };
  try{
    await progress('snapshotting');
    const workspace=join(directory,'workspace');mkdirSync(workspace,{recursive:true});
    for(const resource of request.resources){
      const bytes=readFileSync(resource.source);if(sha256(bytes)!==resource.sha256)fail('E_OPERATION_RESOURCE_DRIFT',`启动后输入资源已变化：${resource.path}`);
      const target=join(workspace,resource.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);
    }
    writeOperationFile(join(workspace,'document.json'),request.doc);
    let result;
    if(request.kind==='export-rp'){
      await progress('compiling-rp');const {exportStudioDocumentToRp}=await import('./export-rp.mjs');
      result=await exportStudioDocumentToRp(request.doc,{projectDir:workspace,outRpPath:join(directory,'artifacts','prototype.rp')});
    }else if(request.kind==='media'){
      await progress('preparing-media');const {prepareMedia}=await import('./media.mjs');
      const source=request.resources.find(item=>item.path.startsWith('input/')).path;
      result=await prepareMedia({...request.input,sourcePath:join(workspace,source),projectDir:workspace,tokens:request.doc.tokens,onProgress:progress});
    }else if(request.kind==='sync-native'){
      await progress('analyzing-native');const {syncNativeRpToStudio}=await import('./sync-native.mjs');
      result=await syncNativeRpToStudio({...request.input,mode:'preview',doc:request.doc,projectDir:request.projectDir});
    }else if(request.kind==='export-code'){
      await progress('compiling-code');const {exportStudioDocumentToCode}=await import('./export-code.mjs');
      result=await exportStudioDocumentToCode(request.doc,{projectDir:workspace,outDir:join(directory,'artifacts','code-bundle'),resetRegistration:Boolean(request.input.resetRegistration)});
    }else{
      await progress('opening-preview');const {startStudioServer}=await import('./server.mjs');({studio}=await startStudioServer({projectDir:workspace,port:0}));
      studio.operationProgress=progress;
      const {previewCandidates}=await import('./candidate-explorations.mjs');const {exploreVariants}=await import('./explore.mjs');
      result=request.input.candidates?await previewCandidates(studio,request.input):exploreVariants(request.doc,request.input);
    }
    await studio?.stop();studio=null;
    delete result.mcpImages;
    // Publication wins or cancellation wins at this small gate. A publication
    // already started is reported as completion_in_progress, never as stopped.
    const gate=await operations.update(id,current=>current.cancelRequested?current:{...current,phase:'publishing'});
    if(gate.cancelRequested)fail('E_OPERATION_CANCELLED','发布前收到取消');
    if(request.kind==='media'){
      const from=join(workspace,'assets'),to=join(request.projectDir,'assets');mkdirSync(to,{recursive:true});
      for(const name of readdirSync(from)){
        const source=join(from,name),target=join(to,name);if(!lstatSync(source).isFile())continue;
        if(existsSync(target)){if(sha256(readFileSync(target))!==sha256(readFileSync(source)))fail('E_OPERATION_RESOURCE_DRIFT',`同名资源字节不同，未覆盖：${name}`);}
        else copyFileSync(source,target,constants.COPYFILE_EXCL);
      }
    }
    writeOperationFile(join(directory,'result.json'),result);
    await operations.update(id,current=>({...current,status:'succeeded',phase:'completed',completedAt:stamp(),resultSummary:{kind:request.kind,validationPassed:result.report?result.report.summary.threeZerosPassed&&result.report.compatibilityCounts.unsupported===0&&result.report.geometryAlignment.passed99PercentWithin1Px&&result.report.typographyAlignment.allFontsPreserved:result.manifest?result.manifest.interactionCompatibility?.fakeButtonsEmitted===0:undefined,output:result.rpPath||result.output||result.outRpPath||result.outDir||null,reportPath:result.reportPath||result.manifestPath||null,contactSheet:result.contactSheet||null,candidates:result.candidates?.map(c=>({id:c.id,label:c.label,status:c.status,...(c.error?{error:{code:c.error.code,message:c.error.message?.slice(0,2000)}}:{}),designIntent:c.designIntent,frames:c.frames?.map(f=>({id:f.id,status:f.status,path:f.path}))})),mediaCount:result.results?.length}}));
  }catch(error){
    let detail={code:error.code||'E_OPERATION_FAILED',message:error.message,binding:request.binding};
    try{const {errorDiagnostic}=await import('./diagnostics.mjs');const {resolveDocumentScene}=await import('./scene-resolver.mjs');detail=errorDiagnostic(error,{store:{doc:request.doc},scene:resolveDocumentScene(request.doc)});}catch{}
    try{await operations.update(id,current=>terminal.has(current.status)?current:{...current,status:current.cancelRequested?'cancelling':'failed',phase:current.cancelRequested?'stopping':'failed',failedAt:stamp(),diagnostic:{...detail,stage:current.phase}});}catch{}
  }finally{try{await studio?.stop();}catch{}}
}

export async function watchOperationCancellation(directory,id){
  const request=read(join(directory,'request.json')),operations=new StudioOperations(request.projectDir);
  if(request.id!==id||operations.directory(id)!==resolve(directory))return;
  for(let i=0;i<50;i++){const state=await operations.reconcile(id);if(terminal.has(state.status))return;await sleep(100);}
}
