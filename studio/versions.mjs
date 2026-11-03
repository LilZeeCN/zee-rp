import {existsSync,mkdirSync,readFileSync,readdirSync,lstatSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,computeContentHash,sha256,SCHEMA_VERSION} from './document.mjs';
import {writeJsonAtomic} from './persistence.mjs';
import {diffDocuments} from './document-diff.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code})};
export class StudioVersions {
 constructor(persistence){this.persistence=persistence;this.root=join(persistence.projectDir,'versions');mkdirSync(this.root,{recursive:true});}
 list(){return readdirSync(this.root).filter(name=>/^v_[a-f0-9-]+\.json$/.test(name)).map(name=>{const snapshot=this.read(name.slice(0,-5));return snapshot.metadata;}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 read(versionId){if(!/^v_[a-f0-9-]+$/.test(versionId||''))fail('E_VERSION_ID','版本ID无效');const path=join(this.root,versionId+'.json');if(!existsSync(path))fail('E_VERSION_NOT_FOUND','命名版本不存在');if(lstatSync(path).isSymbolicLink())fail('E_VERSION_CORRUPT','版本快照不能是符号链接');let value;try{value=JSON.parse(readFileSync(path,'utf8'))}catch{fail('E_VERSION_CORRUPT','版本快照损坏，未修改当前工程')}
  if(value.formatVersion!==1||value.metadata?.id!==versionId||!value.document||value.sha256!==sha256(canonicalJson(value.document))||value.metadata.contentHash!==computeContentHash(value.document))fail('E_VERSION_CORRUPT','版本内容与校验清单不一致，未修改当前工程');
  if(value.document.schemaVersion>SCHEMA_VERSION)fail('E_VERSION_NEWER','版本来自较新的文档格式，当前程序不能恢复');return value;
 }
 create(store,{name,baseRevision,idempotencyKey}={}){
  if(typeof name!=='string'||!name.trim()||name.length>80)fail('E_VERSION_NAME','版本名称需要1–80个字符');
  if(typeof idempotencyKey!=='string'||!idempotencyKey)fail('E_IDEMPOTENCY_REQUIRED','保存版本需要唯一idempotencyKey');
  const previous=this.list().find(v=>v.idempotencyKey===idempotencyKey);
  if(previous){if(previous.name!==name.trim()||previous.documentId!==store.doc.documentId||baseRevision!==previous.revision)fail('E_IDEMPOTENCY_CONFLICT','该版本保存身份已用于其他名称或版本');return {ok:true,version:previous,idempotentReplay:true};}
  if(baseRevision!==store.appliedRevision)fail('E_STALE_REVISION','保存版本所依据的工程已变化');
  const document=structuredClone(store.doc),metadata={id:'v_'+randomUUID(),name:name.trim(),documentId:document.documentId,revision:document.revision,contentHash:document.contentHash,createdAt:new Date().toISOString(),idempotencyKey};
  writeJsonAtomic(join(this.root,metadata.id+'.json'),{formatVersion:1,metadata,document,sha256:sha256(canonicalJson(document))});return {ok:true,version:metadata,idempotentReplay:false};
 }
 preview(store,{versionId,baseRevision}={}){
  if(baseRevision!==store.appliedRevision)fail('E_STALE_REVISION','恢复预览所依据的工程已变化');
  const value=this.read(versionId);if(value.metadata.documentId!==store.doc.documentId)fail('E_DOCUMENT_ID_MISMATCH','该版本不属于当前工程');
  const diff=diffDocuments(store.doc,value.document),previewHash=sha256(canonicalJson({current:store.doc.contentHash,version:versionId,target:value.sha256}));
  const previewDir=join(this.root,'previews');mkdirSync(previewDir,{recursive:true});const detailsPath=join(previewDir,previewHash+'.json');writeJsonAtomic(detailsPath,{baseRevision:store.appliedRevision,versionId,previewHash,diff});
  const previews=readdirSync(previewDir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).sort((a,b)=>statSync(join(previewDir,b)).mtimeMs-statSync(join(previewDir,a)).mtimeMs);
  for(const name of previews.slice(20))rmSync(join(previewDir,name));
  return {ok:true,version:value.metadata,baseRevision:store.appliedRevision,currentContentHash:store.doc.contentHash,targetContentHash:value.metadata.contentHash,previewHash,diff,detailsPath,restores:['pages','components','tokens','variables','datasets','assetsManifest','fonts','designDecisions'],note:'恢复生成新事务，保留当前分支和原始命名版本；资源字节必须仍与清单一致。'};
 }
 restore(store,{versionId,baseRevision,previewHash,idempotencyKey}={}){
  const value=this.read(versionId),command={type:'restoreDocument',document:value.document,expectedContentHash:value.metadata.contentHash,versionId,previewHash};
  const replay=store.getIdempotentResult({idempotencyKey,commands:[command]});if(replay)return replay;
  const preview=this.preview(store,{versionId,baseRevision});if(preview.previewHash!==previewHash)fail('E_VERSION_PREVIEW_STALE','恢复预览已变化或缺失，请查看当前差异后重试');
  if(!idempotencyKey)fail('E_IDEMPOTENCY_REQUIRED','恢复版本需要唯一idempotencyKey');
  for(const [path,asset] of Object.entries(value.document.assetsManifest||{})){if(!/^assets\/[a-zA-Z0-9_.-]+$/.test(path)||!existsSync(join(this.persistence.projectDir,path))||sha256(readFileSync(join(this.persistence.projectDir,path)))!==asset.sha256)fail('E_VERSION_ASSET_DRIFT',`版本资源缺失或变化：${path}`);}
  const result=store.applyTransaction({baseRevision,idempotencyKey,label:`恢复版本：${value.metadata.name}`,source:'version-restore',commands:[command]});return {...result,version:value.metadata};
 }
}
