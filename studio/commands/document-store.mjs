// StudioDocumentStore:事务、快照/历史、幂等、undo/redo。从 commands.mjs 原样迁移。
import {
  normalizeNodeInteractions,
  currentDocumentDiagnostics,
  computeContentHash,
  inheritCleanCanonicalCache,
  canonicalJson,
  sha256,
  buildNodeIndex,
} from '../document.mjs';
import { getLastResolvedScene, resolveDocumentScene } from '../scene-resolver.mjs';
import { diffDocuments } from '../document-diff.mjs';
import { computeCommandImpactAndDiff } from '../impact-diff.mjs';
import { finalizeDesignDecisions } from '../design-decisions.mjs';
import { SAFE_NODE_CACHE_COMMANDS, INTERACTION_MUTATING_COMMANDS, NON_STRUCTURAL_COMMANDS } from './taxonomy.mjs';
import { cmdError, stackUnplacedChildDiagnostics, validateInteractionAssignments } from './helpers.mjs';
import { applySingleCommand } from './apply.mjs';

export class StudioDocumentStore {
  constructor(initialDoc, { onCommit = null, maxSnapshots = 120, maxHistoryBytes = 8 * 1024 * 1024, projectDir = null } = {}) {
    this.projectDir = projectDir;
    this.doc = structuredClone(initialDoc);
    for (const page of this.doc.pages || []) normalizeNodeInteractions(page.root);
    for (const component of Object.values(this.doc.components || {})) normalizeNodeInteractions(component.root);
    this.doc.diagnostics = currentDocumentDiagnostics(this.doc);
    Object.defineProperty(this.doc, '_diagnosticsCurrent', { value: true, enumerable: false, configurable: true });
    this.doc.revision = Number(this.doc.revision || 1);
    this.doc.contentHash = computeContentHash(this.doc, { cacheNodes: true });
    this.durableRevision = this.doc.revision;
    this.lastScene = null;
    this.renderedRevisions = new Map(); // sessionId -> { revision, contentHash, updatedAt, fontsReady, assetsReady }
    this.history = []; // committed transactions
    this.transactions = this.history;
    this.redoStack = [];
    this.lastHistoryRecord = null;
    this.idempotencyMap = new Map(); // idempotencyKey -> { requestHash, result, timestamp, revision }
    this.idempotencyRecords = this.idempotencyMap;
    this.snapshots = new Map(); // revision -> docClone
    this.maxSnapshots = maxSnapshots;
    this.maxHistoryBytes = maxHistoryBytes;
    this.snapshotBytes = new Map();
    this.onCommit = onCommit;
    this._saveSnapshot(this.doc);
  }

  get appliedRevision() {
    return this.doc.revision;
  }

  markDurable(rev = this.doc.revision) {
    this.durableRevision = Number(rev);
    return this.durableRevision;
  }

  _saveSnapshot(docSnap, { alreadyCloned = false } = {}) {
    const snap = alreadyCloned ? docSnap : structuredClone(docSnap);
    const bytes = docSnap._approxBytes || Buffer.byteLength(JSON.stringify(docSnap));
    Object.defineProperty(snap, '_approxBytes', { value: bytes, enumerable: false, configurable: true });
    this.snapshots.set(docSnap.revision, snap);
    this.snapshotBytes.set(docSnap.revision, bytes);
    while (this.snapshots.size > 1 && (this.snapshots.size > this.maxSnapshots || [...this.snapshotBytes.values()].reduce((sum, n) => sum + n, 0) > this.maxHistoryBytes)) {
      const oldest = Math.min(...this.snapshots.keys());
      this.snapshots.delete(oldest);
      this.snapshotBytes.delete(oldest);
    }
  }

  trimHistory() {
    const approx = doc => doc?._approxBytes || Buffer.byteLength(JSON.stringify(doc || {}));
    const size = tx => tx.snapshotBytes ??= approx(tx.beforeSnapshot) + approx(tx.afterSnapshot);
    let bytes = [...this.history, ...this.redoStack].reduce((sum, tx) => sum + size(tx), 0);
    while (this.history.length + this.redoStack.length > 1 && (this.history.length + this.redoStack.length > this.maxSnapshots || bytes > this.maxHistoryBytes)) {
      const removed = this.history.length ? this.history.shift() : this.redoStack.shift();
      bytes -= size(removed);
    }
    this.historyBytes = bytes;
  }

  getSnapshot(revision) {
    if (revision === undefined || revision === null || Number(revision) === this.doc.revision) {
      return structuredClone(this.doc);
    }
    const snap = this.snapshots.get(Number(revision));
    if (!snap) {
      throw Object.assign(
        new Error(`请求的文档历史版本 r${revision} 已不在快照保留窗口内（当前 r${this.doc.revision}）`),
        { code: 'E_REVISION_UNAVAILABLE', requestedRevision: Number(revision), currentRevision: this.doc.revision }
      );
    }
    return structuredClone(snap);
  }

  requestHash(request) {
    return sha256(canonicalJson({ documentId: this.doc.documentId,
      ...(request.selectionId ? {selectionId:request.selectionId} : {}),
      ...(request.sourceIdentity ? { sourceIdentity: request.sourceIdentity } : { commands: request.commands }) }));
  }

  getIdempotentResult(request) {
    const key = request.idempotencyKey ? String(request.idempotencyKey) : null;
    const previous = key && this.idempotencyMap.get(key);
    if (!previous) return null;
    if (previous.requestHash !== this.requestHash(request)) return {
      ok: false, status: 'failed', code: 'E_IDEMPOTENCY_CONFLICT', idempotencyKey: key,
      originalRevision: previous.revision, message: `幂等键 "${key}" 已被用于不同内容，请使用新的幂等键`,
    };
    return { ...structuredClone(previous.result), ok: true, idempotentReplay: true };
  }

  applyTransaction(request) {
    // 1. Validate request identity and basic structure
    if (!request || typeof request !== 'object') {
      return { ok: false, status: 'failed', code: 'E_INVALID_REQUEST', message: '事务请求必须是非空 JSON 对象' };
    }
    if (request.documentId && request.documentId !== this.doc.documentId) {
      return {
        ok: false,
        status: 'failed',
        code: 'E_DOCUMENT_ID_MISMATCH',
        expectedDocumentId: this.doc.documentId,
        actualDocumentId: request.documentId,
        message: `documentId 不匹配：当前工作台文档为 "${this.doc.documentId}"，请求为 "${request.documentId}"`,
      };
    }
    if (!Array.isArray(request.commands) || request.commands.length === 0) {
      return { ok: false, status: 'failed', code: 'E_EMPTY_COMMANDS', message: '事务 commands 必须是非空数组' };
    }

    const idempotencyKey = request.idempotencyKey ? String(request.idempotencyKey) : null;
    const reqHash = this.requestHash(request);

    // 2. Check idempotency store BEFORE baseRevision check (Section 7.2 rule!)
    const replay = this.getIdempotentResult(request);
    if (replay) return replay;

    // 3. Check baseRevision precondition
    if (request.baseRevision !== undefined && request.baseRevision !== null) {
      const baseRev = Number(request.baseRevision);
      if (baseRev !== this.doc.revision) {
        const conflictingTxs = this.history
          .filter(h => h.revision > baseRev)
          .map(h => ({
            revision: h.revision,
            txId: h.txId,
            actor: h.actor,
            label: h.label,
            affectedNodeIds: h.affectedNodeIds,
            timestamp: h.timestamp,
          }));
        return {
          ok: false,
          status: 'failed',
          code: 'E_STALE_REVISION',
          baseRevision: baseRev,
          currentRevision: this.doc.revision,
          currentContentHash: this.doc.contentHash,
          conflictingTransactions: conflictingTxs,
          message: `baseRevision 已过期（请求基于 r${baseRev}，当前文档已推进至 r${this.doc.revision}），拒绝覆盖新修改`,
        };
      }
    }

    // 4. Atomic execution on working clone
    const beforeDoc = this.doc;
    let beforeScene = (this.lastScene && this.lastScene.revision === beforeDoc.revision && this.lastScene.contentHash === beforeDoc.contentHash)
      ? this.lastScene
      : getLastResolvedScene(beforeDoc);
    if (!beforeScene) {
      try {
        beforeScene = resolveDocumentScene(beforeDoc, { projectDir: this.projectDir });
      } catch {
        beforeScene = { pages: [] };
      }
    }
    const workingDoc = structuredClone(this.doc);
    const allAffected = new Set();
    const contractEvolutionResults = [];
    const interactionValidationQueue = [];
    let resolvedScene = null;

    try {
      let cachedIndex = buildNodeIndex(workingDoc);
      let needsInteractionNormalize = false;
      let canInheritNodeCache = true;
      for (let i = 0; i < request.commands.length; i++) {
        const cmd = request.commands[i];
        if (!cachedIndex) cachedIndex = buildNodeIndex(workingDoc);
        const affected = applySingleCommand(workingDoc, cmd, i, request.pageId || null, cachedIndex, contractEvolutionResults, { projectDir: this.projectDir, interactionValidationQueue });
        for (const id of affected) allAffected.add(id);
        const props = cmd.properties || cmd.props;
        if (
          INTERACTION_MUTATING_COMMANDS.has(cmd.type) ||
          (props && ('on' in props || 'onClick' in props || 'interactions' in props || 'goto' in props || 'children' in props || 'states' in props || 'template' in props))
        ) {
          needsInteractionNormalize = true;
        }
        if (
          !SAFE_NODE_CACHE_COMMANDS.has(cmd.type) ||
          (props && ('children' in props || 'states' in props || 'template' in props))
        ) {
          canInheritNodeCache = false;
        }
        if (!NON_STRUCTURAL_COMMANDS.has(cmd.type) || props && ['children', 'states', 'template'].some(key => key in props)) {
          cachedIndex = null;
        }
      }
      for (const {spec, cmdIdx, nodeId} of interactionValidationQueue) validateInteractionAssignments(spec, workingDoc, cmdIdx, nodeId);
      if (needsInteractionNormalize) {
        for (const page of workingDoc.pages || []) normalizeNodeInteractions(page.root);
        for (const component of Object.values(workingDoc.components || {})) normalizeNodeInteractions(component.root);
      }
      finalizeDesignDecisions(workingDoc);
      if (request.selectionGuard) {
        const outside = diffDocuments(this.doc, workingDoc, { limit: Infinity }).changes.filter(change => !request.selectionGuard.paths.some(path => path.every((part, index) => change.path[index] === part)));
        if (outside.length) throw cmdError('E_SELECTION_SCOPE', '修改超出绑定选区，整笔未写入', { extra: { outsidePaths: outside.slice(0, 8).map(change => change.path) } });
      }
      workingDoc.diagnostics = currentDocumentDiagnostics(workingDoc);
      Object.defineProperty(workingDoc, '_diagnosticsCurrent', { value: true, enumerable: false, configurable: true });
      if (canInheritNodeCache && allAffected.size > 0) {
        inheritCleanCanonicalCache(beforeDoc, workingDoc, allAffected);
      }
      workingDoc.contentHash = computeContentHash(workingDoc, { cacheNodes: true });
      // Verify the entire document resolves cleanly (catches component cycles, size dependency loops, etc.)
      resolvedScene = resolveDocumentScene(workingDoc, { projectDir: this.projectDir });
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        code: err.code || 'E_COMMAND_FAILED',
        failedCommandIndex: err.commandIndex ?? 0,
        nodeId: err.nodeId ?? null,
        field: err.field ?? null,
        candidates: err.candidates ?? undefined,
        parentType: err.parentType ?? undefined,
        parentLocked: err.parentLocked ?? undefined,
        expected: err.expected ?? undefined,
        actual: err.actual ?? undefined,
        outsidePaths: err.outsidePaths ?? undefined,
        capability: err.capability ?? undefined,
        suggestion: err.suggestion ?? '请修复失败的命令后重新提交整批事务',
        message: err.message,
        currentRevision: this.doc.revision,
        currentContentHash: this.doc.contentHash,
      };
    }

    // 5. Commit transaction & compute transitive impact + semantic diff
    workingDoc.revision = this.doc.revision + 1;
    workingDoc.updatedAt = new Date().toISOString();
    resolvedScene.revision = workingDoc.revision;
    resolvedScene.contentHash = workingDoc.contentHash;
    this.lastScene = resolvedScene;

    const stackUnplaced = stackUnplacedChildDiagnostics(request.commands, request.pageId);
    const impactReport = computeCommandImpactAndDiff({
      beforeDoc,
      afterDoc: workingDoc,
      beforeScene,
      afterScene: resolvedScene,
      commands: request.commands,
      directAffectedIds: [...allAffected],
      contractEvolutionResults,
      extraDiagnostics: stackUnplaced,
    });
    const fullAffectedIds = impactReport.transitiveImpact.allAffectedNodeIds.length > 0
      ? impactReport.transitiveImpact.allAffectedNodeIds
      : [...allAffected];

    // 文字截断/溢出风险来自场景级 clipDiagnostics；并入事务 diagnostics，让摘要与明细可定位（T-A-3）。
    const txDiagnostics = [
      ...structuredClone(workingDoc.diagnostics || []),
      ...structuredClone(stackUnplaced),
      ...(resolvedScene?.clipDiagnostics || []).map(d => ({
        severity: d.severity || 'warning',
        code: d.code || 'E_TEXT_CLIP',
        pageId: d.pageId,
        nodeId: d.nodeId,
        scopedId: d.scopedId,
        message: d.message,
      })),
    ];

    const afterSnapshot = structuredClone(workingDoc);
    if (workingDoc._approxBytes) {
      Object.defineProperty(afterSnapshot, '_approxBytes', { value: workingDoc._approxBytes, enumerable: false, configurable: true });
    }
    const txId = `tx_r${workingDoc.revision}_${sha256(`${workingDoc.revision}:${Date.now()}:${idempotencyKey || ''}`).slice(0, 10)}`;
    const txRecord = {
      txId,
      transactionId: txId,
      revision: workingDoc.revision,
      appliedRevision: workingDoc.revision,
      baseRevision: beforeDoc.revision,
      pageId: request.pageId || null,
      idempotencyKey,
      requestHash: reqHash,
      actor: request.actor || { kind: request.source || 'unknown', id: request.clientId || 'default' },
      label: request.label || impactReport.humanReadableSummary?.whatChanged || `${request.commands[0].type} (${request.commands.length} 项操作)`,
      timestamp: workingDoc.updatedAt,
      commands: structuredClone(request.commands),
      affectedNodeIds: fullAffectedIds,
      directAffectedNodeIds: [...allAffected],
      transitiveImpact: impactReport.transitiveImpact,
      semanticDiff: impactReport.semanticDiff,
      humanReadableSummary: impactReport.humanReadableSummary,
      diagnostics: structuredClone(txDiagnostics),
      beforeContentHash: beforeDoc.contentHash,
      afterContentHash: workingDoc.contentHash,
      contentHash: workingDoc.contentHash,
      beforeSnapshot: beforeDoc,
      afterSnapshot,
    };

    this.doc = workingDoc;
    this.history.push(txRecord);
    this.redoStack = []; // New forward edit invalidates redo branch
    this.trimHistory();
    this._saveSnapshot(afterSnapshot, { alreadyCloned: true });

    const result = {
      ok: true,
      status: 'completed',
      documentId: this.doc.documentId,
      txId,
      transactionId: txId,
      baseRevision: beforeDoc.revision,
      appliedRevision: this.doc.revision,
      durableRevision: this.durableRevision,
      contentHash: this.doc.contentHash,
      affectedNodeIds: fullAffectedIds,
      directAffectedNodeIds: [...allAffected],
      transitiveImpact: impactReport.transitiveImpact,
      semanticDiff: impactReport.semanticDiff,
      humanReadableSummary: impactReport.humanReadableSummary,
      diagnostics: structuredClone(txDiagnostics),
      label: txRecord.label,
      actor: txRecord.actor,
      idempotentReplay: false,
      scene: resolvedScene,
    };

    if (idempotencyKey) {
      const storedRes = { ...result };
      delete storedRes.scene;
      this.idempotencyMap.set(idempotencyKey, {
        requestHash: reqHash,
        revision: this.doc.revision,
        txId,
        timestamp: txRecord.timestamp,
        result: structuredClone(storedRes),
      });
    }

    if (this.onCommit) {
      this.onCommit(txRecord, result);
      result.durableRevision = this.durableRevision;
      if (idempotencyKey && this.idempotencyMap.has(idempotencyKey)) {
        this.idempotencyMap.get(idempotencyKey).result.durableRevision = this.durableRevision;
      }
    }

    return result;
  }

  undo({ expectedRevision = null, expectedHeadTxId = null, actor = { kind: 'human', id: 'default' } } = {}) {
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== this.doc.revision) {
      return {
        status: 'failed',
        code: 'E_UNDO_CONFLICT',
        expectedRevision: Number(expectedRevision),
        currentRevision: this.doc.revision,
        message: `撤销冲突：文档已推进至 r${this.doc.revision}（预期 r${expectedRevision}），拒绝回退他人或后续修改`,
      };
    }
    const headTx = this.history.at(-1);
    if (!headTx) {
      return { status: 'failed', code: 'E_NOTHING_TO_UNDO', currentRevision: this.doc.revision, message: '当前没有可撤销的历史事务' };
    }
    if (expectedHeadTxId && headTx.txId !== expectedHeadTxId) {
      return {
        status: 'failed',
        code: 'E_UNDO_CONFLICT',
        expectedHeadTxId,
        actualHeadTxId: headTx.txId,
        currentRevision: this.doc.revision,
        message: `撤销目标事务 (${expectedHeadTxId}) 不是当前历史头 (${headTx.txId})，为保护其后修改拒绝直接回退`,
      };
    }

    if (!headTx.beforeSnapshot) {
      return { ok: false, status: 'failed', code: 'E_HISTORY_SNAPSHOT_UNAVAILABLE', currentRevision: this.doc.revision, message: '此历史缺少可恢复的原稿快照，未修改文档；请使用有快照的版本。' };
    }
    const beforeSnapshot = structuredClone(this.doc);
    const restored = structuredClone(headTx.beforeSnapshot);
    restored.revision = this.doc.revision + 1;
    restored.updatedAt = new Date().toISOString();
    restored.contentHash = computeContentHash(restored);
    this.history.pop();
    this.redoStack.push(headTx);
    this.doc = restored;
    this._saveSnapshot(this.doc);

    const undoRecord = {
      txId: `undo_r${this.doc.revision}_${headTx.txId}`,
      kind: 'undo',
      baseRevision: beforeSnapshot.revision,
      restoreSnapshotRevision: headTx.beforeSnapshot.revision,
      beforeSnapshot,
      afterSnapshot: structuredClone(this.doc),
      undoneTxId: headTx.txId,
      revision: this.doc.revision,
      actor,
      label: `撤销: ${headTx.label}`,
      timestamp: this.doc.updatedAt,
      affectedNodeIds: headTx.affectedNodeIds,
      beforeContentHash: headTx.afterContentHash,
      afterContentHash: this.doc.contentHash,
    };
    this.lastHistoryRecord = undoRecord;

    const resolvedUndoScene = resolveDocumentScene(this.doc, { projectDir: this.projectDir });
    this.lastScene = resolvedUndoScene;
    const result = {
      ok: true,
      status: 'completed',
      action: 'undo',
      undoneTxId: headTx.txId,
      appliedRevision: this.doc.revision,
      durableRevision: this.durableRevision,
      contentHash: this.doc.contentHash,
      affectedNodeIds: headTx.affectedNodeIds,
      scene: resolvedUndoScene,
    };

    if (this.onCommit) {
      this.onCommit(undoRecord, result);
      result.durableRevision = this.durableRevision;
    }
    return result;
  }

  redo({ expectedRevision = null, actor = { kind: 'human', id: 'default' } } = {}) {
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== this.doc.revision) {
      return {
        status: 'failed',
        code: 'E_REDO_CONFLICT',
        expectedRevision: Number(expectedRevision),
        currentRevision: this.doc.revision,
        message: `重做冲突：文档当前版本为 r${this.doc.revision}（预期 r${expectedRevision}）`,
      };
    }
    const nextTx = this.redoStack.at(-1);
    if (!nextTx) {
      return { status: 'failed', code: 'E_NOTHING_TO_REDO', currentRevision: this.doc.revision, message: '当前没有可重做的事务（或已被新分支覆盖）' };
    }

    if (!nextTx.afterSnapshot) {
      return { ok: false, status: 'failed', code: 'E_HISTORY_SNAPSHOT_UNAVAILABLE', currentRevision: this.doc.revision, message: '此历史缺少可重做的快照，未修改文档。' };
    }
    const beforeSnapshot = structuredClone(this.doc);
    const reapplied = structuredClone(nextTx.afterSnapshot);
    reapplied.revision = this.doc.revision + 1;
    reapplied.updatedAt = new Date().toISOString();
    reapplied.contentHash = computeContentHash(reapplied);
    this.redoStack.pop();

    const pushedTx = {
      ...nextTx,
      revision: reapplied.revision,
      baseRevision: beforeSnapshot.revision,
      beforeSnapshot: structuredClone(this.doc),
      afterSnapshot: structuredClone(reapplied),
    };
    this.history.push(pushedTx);
    this.doc = reapplied;
    this._saveSnapshot(this.doc);

    const redoRecord = {
      txId: `redo_r${this.doc.revision}_${nextTx.txId}`,
      kind: 'redo',
      baseRevision: beforeSnapshot.revision,
      restoreSnapshotRevision: nextTx.afterSnapshot.revision,
      beforeSnapshot,
      afterSnapshot: structuredClone(this.doc),
      redoneTxId: nextTx.txId,
      revision: this.doc.revision,
      actor,
      label: `重做: ${nextTx.label}`,
      timestamp: this.doc.updatedAt,
      affectedNodeIds: nextTx.affectedNodeIds,
      beforeContentHash: nextTx.beforeContentHash,
      afterContentHash: this.doc.contentHash,
    };
    this.lastHistoryRecord = redoRecord;

    const resolvedRedoScene = resolveDocumentScene(this.doc, { projectDir: this.projectDir });
    this.lastScene = resolvedRedoScene;
    const result = {
      ok: true,
      status: 'completed',
      action: 'redo',
      redoneTxId: nextTx.txId,
      appliedRevision: this.doc.revision,
      durableRevision: this.durableRevision,
      contentHash: this.doc.contentHash,
      affectedNodeIds: nextTx.affectedNodeIds,
      scene: resolvedRedoScene,
    };

    if (this.onCommit) {
      this.onCommit(redoRecord, result);
      result.durableRevision = this.durableRevision;
    }
    return result;
  }
}

/**
 * 便捷纯函数：在给定文档或 Store 上应用命令事务
 */
export function applyCommandsToDocument(docOrStore, commands, options = {}) {
  const store = docOrStore instanceof StudioDocumentStore
    ? docOrStore
    : new StudioDocumentStore(docOrStore);
  const res = store.applyTransaction({
    baseRevision: options.baseRevision,
    idempotencyKey: options.idempotencyKey,
    actor: options.actor,
    label: options.label,
    pageId: options.pageId,
    commands: Array.isArray(commands) ? commands : [commands],
  });
  return {
    ...res,
    doc: store.doc,
    store,
  };
}
