// 文档级命令 case(restoreDocument)。从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import { canonicalJson, computeContentHash, sha256 } from '../../document.mjs';
import { cmdError, validateAuthoredTree } from '../helpers.mjs';

function restoreDocument({ doc, cmd, cmdIdx, affectedIds }) {
      const snapshot = cmd.document;
      if (!snapshot || snapshot.documentId !== doc.documentId) throw cmdError('E_DOCUMENT_ID_MISMATCH','恢复源必须属于当前工程',{commandIndex:cmdIdx});
      if (snapshot.schemaVersion !== doc.schemaVersion || !snapshot.pages?.length || computeContentHash(snapshot)!==cmd.expectedContentHash) throw cmdError('E_VERSION_CORRUPT','恢复快照格式或内容哈希不一致',{commandIndex:cmdIdx});
      const previewHash=sha256(canonicalJson({current:computeContentHash(doc),version:cmd.versionId,target:sha256(canonicalJson(snapshot))}));
      if(previewHash!==cmd.previewHash)throw cmdError('E_VERSION_PREVIEW_STALE','恢复预览不再匹配当前内容',{commandIndex:cmdIdx});
      for(const page of snapshot.pages) validateAuthoredTree(page.root,cmdIdx,{historical:true});
      const revision=doc.revision;
      for(const key of Object.keys(doc))delete doc[key];
      Object.assign(doc,structuredClone(snapshot),{revision});
      affectedIds.push(...doc.pages.map(page=>page.id));
}

export const handlers = { restoreDocument };
