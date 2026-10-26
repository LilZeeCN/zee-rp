import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import {
  SCHEMA_VERSION,
  createEmptyStudioDocument,
  importToStudioDocument,
  normalizeStudioDocument,
  computeContentHash,
} from './document.mjs';
import { StudioDocumentStore, applySingleCommand } from './commands.mjs';

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
    writeSync(fd, line, 0, 'utf8');
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
    this.recoveryReport = null;
  }

  initOrLoad({ sourcePath = null, name = 'Untitled Project', documentId = null, domain = 'mobile' } = {}) {
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
    const store = new StudioDocumentStore(doc);
    this.recoveryReport = {
      recovered: false,
      cleanedTempFiles: [],
      replayedTransactions: 0,
      truncatedLinesRemoved: 0,
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

    normalizeStudioDocument(baseDoc, this.projectDir);

    const { records, truncatedLinesRemoved } = this.readTransactionsLog();
    let replayedTransactions = 0;

    // Replay any committed transactions newer than baseDoc.revision
    const sortedRecords = [...records].sort((a, b) => (a.appliedRevision || a.revision) - (b.appliedRevision || b.revision));
    for (const tx of sortedRecords) {
      const targetRev = tx.appliedRevision || tx.revision;
      if (targetRev > baseDoc.revision && tx.baseRevision === baseDoc.revision) {
        const working = structuredClone(baseDoc);
        let ok = true;
        try {
          for (let i = 0; i < (tx.commands || []).length; i++) {
            applySingleCommand(working, tx.commands[i], i);
          }
        } catch {
          ok = false;
        }
        if (ok) {
          working.revision = targetRev;
          working.contentHash = computeContentHash(working);
          baseDoc = working;
          replayedTransactions++;
        }
      }
    }

    baseDoc.contentHash = computeContentHash(baseDoc);
    this.saveFullSnapshot(baseDoc);

    const store = new StudioDocumentStore(baseDoc);
    store.durableRevision = baseDoc.revision;
    store.history = sortedRecords.filter(r => (r.appliedRevision || r.revision) <= baseDoc.revision);
    store.transactions = store.history;

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
    for (const tx of store.history) {
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
      durableRevision: baseDoc.revision,
    };

    return { store, recoveryReport: this.recoveryReport };
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

  persistTransaction(store, txRecord, { simulateCrashStage = null } = {}) {
    // 1. Append lightweight WAL record to transactions.jsonl first
    const walRecord = {
      txId: txRecord.txId,
      transactionId: txRecord.transactionId || txRecord.txId,
      revision: txRecord.revision,
      appliedRevision: txRecord.appliedRevision ?? txRecord.revision,
      baseRevision: txRecord.baseRevision,
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

    // 3. Persist document.json and snapshot atomically
    this.saveFullSnapshot(store.doc, { recomputeHash: false });
    store.markDurable(store.doc.revision);
    return store.durableRevision;
  }
}
