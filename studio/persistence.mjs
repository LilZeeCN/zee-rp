import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
  copyFileSync,
  statSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import {
  SCHEMA_VERSION,
  createEmptyStudioDocument,
  importToStudioDocument,
  normalizeStudioDocument,
  computeContentHash,
  canonicalJson,
  sha256,
} from './document.mjs';
import { StudioDocumentStore, applySingleCommand } from './commands.mjs';
import { finalizeDesignDecisions } from './design-decisions.mjs';

export function ensureProjectDirs(projectDir) {
  const dir = resolve(projectDir);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'history'), { recursive: true });
  mkdirSync(join(dir, 'history', 'snapshots'), { recursive: true });
  mkdirSync(join(dir, 'exports'), { recursive: true });
  return dir;
}

export function writeJsonAtomic(targetPath, data) {
  const text = JSON.stringify(data);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmpPath, text, 'utf8');
  renameSync(tmpPath, targetPath);
}

export function appendJsonlSynced(targetPath, record) {
  const line = `${JSON.stringify(record)}\n`;
  const fd = openSync(targetPath, 'a');
  try {
    writeFileSync(fd, line, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class StudioPersistence {
  constructor(projectDir) {
    this.projectDir = ensureProjectDirs(projectDir);
    this.projectJsonPath = join(this.projectDir, 'project.json');
    this.documentJsonPath = join(this.projectDir, 'document.json');
    this.transactionsPath = join(this.projectDir, 'history', 'transactions.jsonl');
    this.idempotencyPath = join(this.projectDir, 'history', 'idempotency.json');
    this.snapshotsDir = join(this.projectDir, 'history', 'snapshots');
    this.checkpointPath = join(this.projectDir,'history','checkpoint.json');
    this.checkpoint = null;
    this.walCount = 0;
    this.walRestoreRevisions = new Set();
    this.recoveryReport = null;
  }

  initOrLoad({ sourcePath = null, name = 'Untitled Project', documentId = null, domain = 'mobile' } = {}) {
    if(existsSync(this.checkpointPath)) {
      try {const value=JSON.parse(readFileSync(this.checkpointPath,'utf8'));if(value.formatVersion!==1||value.sha256!==sha256(canonicalJson(value.state)))throw new Error('hash');this.checkpoint=value.state;}
      catch {throw Object.assign(new Error('历史检查点损坏；当前文档未被覆盖，请保留工程并检查 history/checkpoint.json'),{code:'E_HISTORY_CHECKPOINT_CORRUPT'});}
    }
    if (existsSync(this.documentJsonPath) || existsSync(this.transactionsPath)) {
      return this.recoverAndLoad();
    }

    let doc;
    if (sourcePath) {
      doc = importToStudioDocument(sourcePath, {
        projectDir: this.projectDir,
        documentId: documentId || basename(this.projectDir),
      });
    } else {
      doc = createEmptyStudioDocument({
        name,
        documentId: documentId || basename(this.projectDir),
        domain,
      });
    }

    this.saveFullSnapshot(doc);
    const store = new StudioDocumentStore(doc, { projectDir: this.projectDir });
    this.recoveryReport = {
      recovered: false,
      cleanedTempFiles: [],
      replayedTransactions: 0,
      truncatedLinesRemoved: 0,
      normalizedRevisionAdvanced: false,
      durableRevision: doc.revision,
    };
    return { store, recoveryReport: this.recoveryReport };
  }

  cleanupTempFiles() {
    const cleaned = [];
    for (const dir of [this.projectDir, join(this.projectDir, 'history'), this.snapshotsDir]) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (entry.includes('.tmp.')) {
          const full = join(dir, entry);
          rmSync(full, { force: true });
          cleaned.push(full);
        }
      }
    }
    return cleaned;
  }

  readTransactionsLog() {
    if (!existsSync(this.transactionsPath)) {
      return { records: [], truncatedLinesRemoved: 0 };
    }
    const raw = readFileSync(this.transactionsPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const records = [];
    let truncatedLinesRemoved = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed.appliedRevision === 'number' && Array.isArray(parsed.commands)) {
          records.push(parsed);
        } else {
          truncatedLinesRemoved++;
        }
      } catch {
        truncatedLinesRemoved++;
      }
    }

    if (truncatedLinesRemoved > 0) {
      // Rewrite clean transactions.jsonl
      const cleanText = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
      writeFileSync(this.transactionsPath, cleanText, 'utf8');
    }

    return { records, truncatedLinesRemoved };
  }

  findLatestValidSnapshot() {
    if (!existsSync(this.snapshotsDir)) return null;
    const files = readdirSync(this.snapshotsDir)
      .filter(f => /^rev-\d+\.json$/.test(f))
      .map(f => ({
        file: f,
        rev: Number(f.match(/^rev-(\d+)\.json$/)[1]),
        path: join(this.snapshotsDir, f),
      }))
      .sort((a, b) => b.rev - a.rev);

    for (const item of files) {
      try {
        const doc = JSON.parse(readFileSync(item.path, 'utf8'));
        if (doc && typeof doc.revision === 'number' && Array.isArray(doc.pages)) {
          return doc;
        }
      } catch {
        // Ignore corrupted snapshot and try older one
      }
    }
    return null;
  }

  readSnapshot(revision) {
    if (!Number.isInteger(revision) || revision < 1) return null;
    try {
      const snapshot = JSON.parse(readFileSync(join(this.snapshotsDir, `rev-${revision}.json`), 'utf8'));
      return snapshot.revision === revision && Array.isArray(snapshot.pages) ? snapshot : null;
    } catch { return null; }
  }

  restoreHistory(store, records) {
    const history = structuredClone(this.checkpoint?.history || []), redo = structuredClone(this.checkpoint?.redo || []);
    for (const record of records) {
      const revision = record.appliedRevision || record.revision;
      if(revision <= (this.checkpoint?.revision || 0))continue;
      if (revision > store.appliedRevision) continue;
      if (record.kind === 'undo') {
        if (history.at(-1)?.txId === record.undoneTxId) redo.push(history.pop());
      } else if (record.kind === 'redo') {
        if (redo.at(-1)?.txId === record.redoneTxId) {
          const original = redo.pop();
          history.push({ ...original, revision, baseRevision: record.baseRevision });
        }
      } else {
        history.push({ ...record, revision });
        redo.length = 0;
      }
    }
    // Older releases saved undo/redo without logging their identity. Do not
    // infer a history stack from a document that advanced past the last record.
    const lastRevision = records.at(-1)?.appliedRevision || records.at(-1)?.revision || this.checkpoint?.revision;
    if (lastRevision !== store.appliedRevision) { history.length = 0; redo.length = 0; }
    const loadWindow=items=>{
      const kept=[];let bytes=0;
      for(const record of [...items].reverse()){
        const size=[record.baseRevision,record.revision].reduce((sum,rev)=>{try{return sum+statSync(join(this.snapshotsDir,`rev-${rev}.json`)).size}catch{return sum}},0);
        if(kept.length && (kept.length>=store.maxSnapshots || bytes+size>store.maxHistoryBytes))break;
        kept.push({...record,beforeSnapshot:this.readSnapshot(record.baseRevision),afterSnapshot:this.readSnapshot(record.revision),snapshotBytes:size});bytes+=size;
      }return kept.reverse();
    };
    store.history = loadWindow(history);
    store.transactions = store.history;
    store.redoStack = loadWindow(redo);
    store.trimHistory();
  }

  recoverAndLoad() {
    const cleanedTempFiles = this.cleanupTempFiles();
    let baseDoc = null;
    let docCorrupted = false;

    if (existsSync(this.documentJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.documentJsonPath, 'utf8'));
        if (parsed && typeof parsed.revision === 'number' && Array.isArray(parsed.pages)) {
          baseDoc = parsed;
        } else {
          docCorrupted = true;
        }
      } catch {
        docCorrupted = true;
      }
    }

    const latestSnapshot = this.findLatestValidSnapshot();
    if (!baseDoc || (latestSnapshot && latestSnapshot.revision > baseDoc.revision)) {
      baseDoc = latestSnapshot;
    }

    if (!baseDoc) {
      baseDoc = createEmptyStudioDocument({ documentId: basename(this.projectDir) });
    }

    // normalize 是原地改写：先记下未规范化原文档的 hash，用于事后判定启动规范化
    // 是否真的改变了文档内容。computeContentHash 排除 revision，因此「revision 推进
    // 且 hash 改变」可以区分规范化写回与普通重算。
    const rawHash = computeContentHash(baseDoc);
    normalizeStudioDocument(baseDoc, this.projectDir);

    const { records, truncatedLinesRemoved } = this.readTransactionsLog();
    const pending=records.filter(record=>(record.appliedRevision||record.revision)>(this.checkpoint?.revision||0));
    this.walCount=pending.length;
    this.walRestoreRevisions=new Set(pending.map(record=>record.restoreSnapshotRevision).filter(Boolean));
    let replayedTransactions = 0;

    // Replay any committed transactions newer than baseDoc.revision
    const sortedRecords = [...records].sort((a, b) => (a.appliedRevision || a.revision) - (b.appliedRevision || b.revision));
    for (const tx of sortedRecords) {
      const targetRev = tx.appliedRevision || tx.revision;
      if (targetRev > baseDoc.revision && tx.baseRevision === baseDoc.revision) {
        let working = structuredClone(baseDoc);
        let ok = true;
        try {
          if (tx.kind === 'undo' || tx.kind === 'redo') {
            working = this.readSnapshot(tx.restoreSnapshotRevision);
            if (!working) throw new Error('Missing history restore snapshot');
          } else {
            for (let i = 0; i < (tx.commands || []).length; i++) {
              applySingleCommand(working, tx.commands[i], i, tx.pageId || null);
            }
            finalizeDesignDecisions(working);
          }
        } catch {
          ok = false;
        }
        if (ok) {
          working.revision = targetRev;
          working.contentHash = computeContentHash(working);
          baseDoc = working;
          writeJsonAtomic(join(this.snapshotsDir, `rev-${targetRev}.json`), working);
          replayedTransactions++;
        }
      }
    }

    // 启动规范化写回：无事务重放、非损坏恢复，且规范化确实改变了内容 hash 时，
    // 推进一次 revision 并把该次写回记入 transactions.jsonl，使 (revision, contentHash)
    // 版本身份对不静默漂移。已规范化的工程 rawHash === 后置 hash，不推进不写历史（幂等）。
    let normalizedRevisionAdvanced = false;
    if (replayedTransactions === 0 && !docCorrupted && rawHash !== computeContentHash(baseDoc)) {
      const baseRevision = baseDoc.revision;
      baseDoc.revision += 1;
      const normalizedHash = computeContentHash(baseDoc);
      const normalizeRecord = {
        kind: 'normalize',
        txId: `tx_norm_r${baseDoc.revision}_${normalizedHash.slice(0, 8)}`,
        revision: baseDoc.revision,
        appliedRevision: baseDoc.revision,
        baseRevision,
        commands: [],
        contentHash: normalizedHash,
        label: '启动规范化写回',
        actor: { kind: 'system', id: 'startup-normalize' },
        timestamp: new Date().toISOString(),
      };
      appendJsonlSynced(this.transactionsPath, normalizeRecord);
      this.walCount++;
      sortedRecords.push(normalizeRecord);
      normalizedRevisionAdvanced = true;
    }

    baseDoc.contentHash = computeContentHash(baseDoc);
    this.saveFullSnapshot(baseDoc);

    const store = new StudioDocumentStore(baseDoc, { projectDir: this.projectDir });
    store.durableRevision = baseDoc.revision;
    this.restoreHistory(store, sortedRecords);

    // Restore idempotency table
    if (existsSync(this.idempotencyPath)) {
      try {
        const idemRaw = JSON.parse(readFileSync(this.idempotencyPath, 'utf8'));
        for (const [k, v] of Object.entries(idemRaw || {})) {
          store.idempotencyMap.set(k, v);
        }
      } catch {
        // Rebuild from transaction records
      }
    }
    for (const tx of sortedRecords) {
      if (tx.idempotencyKey && !store.idempotencyMap.has(tx.idempotencyKey)) {
        const rev = tx.appliedRevision || tx.revision;
        store.idempotencyMap.set(tx.idempotencyKey, {
          requestHash: tx.requestHash || '',
          revision: rev,
          txId: tx.txId || tx.transactionId,
          timestamp: tx.timestamp,
          result: {
            ok: true,
            status: 'completed',
            txId: tx.txId || tx.transactionId,
            transactionId: tx.txId || tx.transactionId,
            baseRevision: tx.baseRevision,
            appliedRevision: rev,
            durableRevision: rev,
            affectedNodeIds: tx.affectedNodeIds || [],
            contentHash: tx.contentHash || tx.afterContentHash,
          },
        });
      }
    }

    this.recoveryReport = {
      recovered: docCorrupted || cleanedTempFiles.length > 0 || replayedTransactions > 0 || truncatedLinesRemoved > 0,
      docCorrupted,
      cleanedTempFiles,
      replayedTransactions,
      truncatedLinesRemoved,
      normalizedRevisionAdvanced,
      durableRevision: baseDoc.revision,
    };

    return { store, recoveryReport: this.recoveryReport };
  }

  flushPendingSnapshot() {
    if (this._pendingSnapshotTimer) {
      clearTimeout(this._pendingSnapshotTimer);
      this._pendingSnapshotTimer = null;
    }
    if (this._pendingStore) {
      const store = this._pendingStore;
      this._pendingStore = null;
      this.saveFullSnapshot(store.doc, { recomputeHash: false });
      if (this.walCount >= 120 || (existsSync(this.transactionsPath) && statSync(this.transactionsPath).size > 8 * 1024 * 1024)) {
        this.checkpointHistory(store);
      }
      this.pruneSnapshots(store);
    }
  }

  saveFullSnapshot(doc, { recomputeHash = true } = {}) {
    const now = new Date().toISOString();
    doc.updatedAt = now;
    if (recomputeHash || !doc.contentHash) {
      doc.contentHash = computeContentHash(doc);
    }
    writeJsonAtomic(this.documentJsonPath, doc);
    const snapPath = join(this.snapshotsDir, `rev-${doc.revision}.json`);
    copyFileSync(this.documentJsonPath, snapPath);
    writeJsonAtomic(this.projectJsonPath, {
      schemaVersion: SCHEMA_VERSION,
      projectId: doc.documentId,
      name: doc.name,
      updatedAt: now,
      appliedRevision: doc.revision,
      durableRevision: doc.revision,
      contentHash: doc.contentHash,
    });
  }

  pruneSnapshots(store) {
    const keep=new Set([store.appliedRevision,...store.snapshots.keys()]);
    if(this.checkpoint?.revision)keep.add(this.checkpoint.revision);
    for(const revision of this.walRestoreRevisions)keep.add(revision);
    for(const tx of [...store.history,...store.redoStack]) for(const doc of [tx.beforeSnapshot,tx.afterSnapshot])if(doc?.revision)keep.add(doc.revision);
    const removed=[];
    for(const file of readdirSync(this.snapshotsDir)){
      const match=/^rev-(\d+)\.json$/.exec(file);
      if(match&&!keep.has(Number(match[1]))){rmSync(join(this.snapshotsDir,file));removed.push(Number(match[1]));}
    }
    return {removed,retained:keep.size,namedVersionsPreserved:true,assetsRemoved:0};
  }

  checkpointHistory(store) {
    const compact=records=>records.map(({beforeSnapshot,afterSnapshot,transitiveImpact,semanticDiff,snapshotBytes,...record})=>({...record,baseRevision:beforeSnapshot?.revision??record.baseRevision,revision:afterSnapshot?.revision??record.revision}));
    const state={revision:store.appliedRevision,contentHash:store.doc.contentHash,history:compact(store.history),redo:compact(store.redoStack)};
    // The durable document/snapshot is written before this checkpoint. If the
    // process stops before WAL rotation, records through its revision are ignored.
    writeJsonAtomic(this.checkpointPath,{formatVersion:1,state,sha256:sha256(canonicalJson(state))});
    const tmp=`${this.transactionsPath}.tmp.${process.pid}.checkpoint`;writeFileSync(tmp,'','utf8');renameSync(tmp,this.transactionsPath);
    this.checkpoint=state;this.walCount=0;this.walRestoreRevisions.clear();
  }

  persistTransaction(store, txRecord, { simulateCrashStage = null } = {}) {
    // 1. Append lightweight WAL record to transactions.jsonl first
    const walRecord = {
      txId: txRecord.txId,
      kind: txRecord.kind || 'edit',
      undoneTxId: txRecord.undoneTxId || null,
      redoneTxId: txRecord.redoneTxId || null,
      restoreSnapshotRevision: txRecord.restoreSnapshotRevision ?? null,
      transactionId: txRecord.transactionId || txRecord.txId,
      revision: txRecord.revision,
      appliedRevision: txRecord.appliedRevision ?? txRecord.revision,
      baseRevision: txRecord.baseRevision,
      pageId: txRecord.pageId || null,
      idempotencyKey: txRecord.idempotencyKey || null,
      requestHash: txRecord.requestHash || null,
      actor: txRecord.actor,
      label: txRecord.label,
      timestamp: txRecord.timestamp,
      commands: txRecord.commands || [],
      affectedNodeIds: txRecord.affectedNodeIds || [],
      contentHash: txRecord.contentHash || txRecord.afterContentHash,
    };
    appendJsonlSynced(this.transactionsPath, walRecord);
    this.walCount++;
    if(walRecord.restoreSnapshotRevision)this.walRestoreRevisions.add(walRecord.restoreSnapshotRevision);

    if (simulateCrashStage === 'after_wal_before_doc') {
      // Write a partial corrupted temp file to simulate mid-write crash
      const partialTmp = `${this.documentJsonPath}.tmp.${process.pid}.crashed`;
      writeFileSync(partialTmp, '{"schemaVersion":1,"corrupted":', 'utf8');
      throw new Error('SIMULATED_CRASH_AFTER_WAL');
    }

    // 2. Persist idempotency map (without full scene objects)
    const idemObj = {};
    for (const [k, v] of store.idempotencyMap.entries()) {
      const cleanRes = { ...(v.result || {}) };
      delete cleanRes.scene;
      delete cleanRes.doc;
      idemObj[k] = { ...v, result: cleanRes };
    }
    writeJsonAtomic(this.idempotencyPath, idemObj);

    // 3. Persist document.json and snapshot atomically (or defer full snapshot on huge docs while WAL is already durable)
    const approxBytes = store.doc._approxBytes || 0;
    if (
      !simulateCrashStage &&
      approxBytes > 80_000 &&
      txRecord.kind !== 'undo' &&
      txRecord.kind !== 'redo'
    ) {
      const now = new Date().toISOString();
      store.doc.updatedAt = now;
      store.markDurable(store.doc.revision);
      writeJsonAtomic(this.projectJsonPath, {
        schemaVersion: SCHEMA_VERSION,
        projectId: store.doc.documentId,
        name: store.doc.name,
        updatedAt: now,
        appliedRevision: store.doc.revision,
        durableRevision: store.doc.revision,
        contentHash: store.doc.contentHash,
      });
      this._pendingStore = store;
      if (this._pendingSnapshotTimer) clearTimeout(this._pendingSnapshotTimer);
      this._pendingSnapshotTimer = setTimeout(() => {
        this.flushPendingSnapshot();
      }, 120);
      if (typeof this._pendingSnapshotTimer.unref === 'function') {
        this._pendingSnapshotTimer.unref();
      }
      return store.durableRevision;
    }

    this.flushPendingSnapshot();
    this.saveFullSnapshot(store.doc, { recomputeHash: false });
    store.markDurable(store.doc.revision);
    if(this.walCount>=120 || statSync(this.transactionsPath).size>8*1024*1024)this.checkpointHistory(store);
    this.pruneSnapshots(store);
    return store.durableRevision;
  }
}
