import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudioServer } from '../studio/server.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';
import { executeStudioMerge } from '../studio/document-merge.mjs';
import { syncNativeRpToStudio } from '../studio/sync-native.mjs';
import { exportStudioDocumentToRp } from '../studio/export-rp.mjs';
import { setRecordWidgetText } from '../scripts/set-widget-text.mjs';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

test('static, asset and font endpoints block encoded path traversal, symlink escape and directory reads', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-sec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = join(root, 'proj');
  const outsideSecret = join(root, 'outside-secret.txt');
  writeFileSync(outsideSecret, 'TOP_SECRET_DATA', 'utf8');

  const { studio } = await startStudioServer({ projectDir, port: 0 });
  t.after(() => studio.close());

  mkdirSync(join(projectDir, 'assets', 'sub'), { recursive: true });
  writeFileSync(join(projectDir, 'assets', 'sub', 'ok.svg'), '<svg></svg>', 'utf8');
  symlinkSync(outsideSecret, join(projectDir, 'assets', 'escaped-link.txt'));

  // Valid nested asset works
  const okRes = await fetch(`${studio.url}/assets/sub/ok.svg`);
  assert.equal(okRes.status, 200);
  assert.equal(await okRes.text(), '<svg></svg>');

  // Encoded ..%2f traversal is blocked with 403 E_PATH_TRAVERSAL
  for (const probe of [
    '/assets/..%2fdocument.json',
    '/assets/..%2f..%2foutside-secret.txt',
    '/fonts/..%2fproject.json',
    '/src/..%2f..%2fserver.mjs',
  ]) {
    const res = await fetch(`${studio.url}${probe}`);
    assert.equal(res.status, 403, `expected 403 for ${probe}, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.code, 'E_PATH_TRAVERSAL');
  }

  // Symlink escaping assets root is blocked
  const symRes = await fetch(`${studio.url}/assets/escaped-link.txt`);
  assert.equal(symRes.status, 403);

  // Directory requests return clean 404 instead of EISDIR 400
  for (const dirProbe of ['/assets/', '/assets/sub', '/fonts/', '/src/']) {
    const res = await fetch(`${studio.url}${dirProbe}`);
    assert.equal(res.status, 404, `expected 404 for ${dirProbe}, got ${res.status}`);
  }
});

test('openProject rotates sessionId and cancels pending render waiters across project switch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-switch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirA = join(root, 'projA');
  const dirB = join(root, 'projB');
  const { studio } = await startStudioServer({ projectDir: dirA, port: 0 });
  t.after(() => studio.close());

  const oldSessionId = studio.sessionId;
  const editA = studio.persistence.commit(studio.store, beforeCommit => studio.store.applyTransaction({
    baseRevision: 1,
    idempotencyKey: 'a-1',
    commands: [{ type: 'addNode', node: { id: 'lbl', type: 'label', text: 'Project A', w: 120, h: 32 } }],
  }, { beforeCommit }));
  assert.equal(editA.ok, true);

  // Start waiting for revision 2 without renderer, then switch project immediately
  const waiterPromise = studio.waitForRenderedRevision(2, { timeoutMs: 5000 });
  const ctxB = studio.openProject({ projectDir: dirB, name: 'Project B' });
  assert.notEqual(ctxB.sessionId, oldSessionId);
  await assert.rejects(waiterPromise, { code: 'E_PROJECT_SWITCHED' });

  // Stale render confirmation carrying oldSessionId is ignored
  studio.recordRenderConfirm({
    renderedRevision: 1,
    contentHash: studio.store.doc.contentHash,
    sessionId: oldSessionId,
  });
  assert.equal(studio.renderedRevision, 0);
});

test('versions.restore, executeStudioMerge and syncNativeRpToStudio honor WAL-before-publish and W_CHECKPOINT_PENDING recovery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-wal-unified-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 1. versions.restore via HTTP server
  {
    const dir = join(root, 'ver-proj');
    const { studio } = await startStudioServer({ projectDir: dir, port: 0 });
    t.after(() => studio.close());

    const post = (path, body) => fetch(`${studio.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, json: await r.json() }));

    await post('/api/commands', {
      baseRevision: 1,
      idempotencyKey: 'seed-1',
      commands: [{ type: 'addNode', node: { id: 'hero', type: 'label', text: 'V1 Hero', w: 200, h: 40 } }],
    });
    const v1Hash = studio.store.doc.contentHash;
    const created = await post('/api/versions', {
      action: 'create',
      name: 'V1',
      baseRevision: 2,
      idempotencyKey: 'ver-v1',
    });
    assert.equal(created.json.ok, true);

    await post('/api/commands', {
      baseRevision: 2,
      idempotencyKey: 'edit-2',
      commands: [{ type: 'setText', nodeId: 'hero', text: 'V2 Changed' }],
    });
    const v2Hash = studio.store.doc.contentHash;
    const prev = await post('/api/versions', {
      action: 'preview',
      versionId: created.json.version.id,
      baseRevision: 3,
    });
    assert.equal(prev.json.ok, true);

    // Inject WAL write error: memory must remain untouched at rev 3 (V2 Changed)
    studio.persistence.walWriteError = Object.assign(new Error('disk full'), { code: 'E_WAL_WRITE' });
    const failedWal = await post('/api/versions', {
      action: 'restore',
      versionId: created.json.version.id,
      baseRevision: 3,
      previewHash: prev.json.previewHash,
      idempotencyKey: 'restore-wal-fail',
    });
    assert.equal(failedWal.status, 500);
    assert.equal(studio.store.appliedRevision, 3);
    assert.equal(studio.store.doc.contentHash, v2Hash);
    assert.equal(studio.store.idempotencyMap.has('restore-wal-fail'), false);
    studio.persistence.walWriteError = null;

    // Inject post-WAL checkpoint crash: returns W_CHECKPOINT_PENDING and recovers cleanly from WAL
    const crashedCkpt = await post('/api/versions', {
      action: 'restore',
      versionId: created.json.version.id,
      baseRevision: 3,
      previewHash: prev.json.previewHash,
      idempotencyKey: 'restore-ckpt-pending',
      simulateCrashStage: 'after_wal_before_doc',
    });
    assert.equal(crashedCkpt.status, 200);
    assert.equal(crashedCkpt.json.persistenceWarning?.code, 'W_CHECKPOINT_PENDING');
    assert.equal(studio.store.durableRevision, 4);
    assert.equal(studio.store.doc.contentHash, v1Hash);
    studio.persistence._pendingStore = null; // Simulate hard kill before flush

    const recovered = new StudioPersistence(dir).initOrLoad();
    assert.equal(recovered.store.appliedRevision, 4);
    assert.equal(recovered.store.doc.contentHash, v1Hash);
  }

  // 2. executeStudioMerge
  {
    const dir = join(root, 'merge-proj');
    const persistence = new StudioPersistence(dir);
    const { store } = persistence.initOrLoad({ domain: 'web' });
    persistence.commit(store, beforeCommit => store.applyTransaction({
      baseRevision: 1,
      idempotencyKey: 'm-seed',
      commands: [
        { type: 'addNode', node: { id: 'a', type: 'label', text: 'Base A', x: 20, y: 20, w: 160, h: 32 } },
        { type: 'addNode', node: { id: 'b', type: 'label', text: 'Base B', x: 20, y: 70, w: 160, h: 32 } },
      ],
    }, { beforeCommit }));
    // Ours edits 'a' at rev 3
    persistence.commit(store, beforeCommit => store.applyTransaction({
      baseRevision: 2,
      idempotencyKey: 'm-ours',
      commands: [{ type: 'setText', nodeId: 'a', text: 'Ours A' }],
    }, { beforeCommit }));
    const oursHash = store.doc.contentHash;

    const preview = executeStudioMerge({
      store,
      persistence,
      projectDir: dir,
      mode: 'preview',
      baseRevision: 2,
      theirsCommands: [{ type: 'setText', nodeId: 'b', text: 'Theirs B' }],
    });
    assert.equal(preview.ok, true);

    // WAL write failure leaves store untouched
    persistence.walWriteError = Object.assign(new Error('wal fail'), { code: 'E_WAL_WRITE' });
    assert.throws(() => executeStudioMerge({
      store,
      persistence,
      projectDir: dir,
      mode: 'apply',
      baseRevision: 2,
      expectedOursRevision: 3,
      previewHash: preview.previewHash,
      idempotencyKey: 'merge-wal-fail',
      theirsCommands: [{ type: 'setText', nodeId: 'b', text: 'Theirs B' }],
    }), { code: 'E_WAL_WRITE' });
    assert.equal(store.appliedRevision, 3);
    assert.equal(store.doc.contentHash, oursHash);
    assert.equal(store.idempotencyMap.has('merge-wal-fail'), false);
    persistence.walWriteError = null;

    // Post-WAL checkpoint crash returns W_CHECKPOINT_PENDING and replays cleanly
    const applied = executeStudioMerge({
      store,
      persistence,
      projectDir: dir,
      mode: 'apply',
      baseRevision: 2,
      expectedOursRevision: 3,
      previewHash: preview.previewHash,
      idempotencyKey: 'merge-ckpt-pending',
      theirsCommands: [{ type: 'setText', nodeId: 'b', text: 'Theirs B' }],
      simulateCrashStage: 'after_wal_before_doc',
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.persistenceWarning?.code, 'W_CHECKPOINT_PENDING');
    assert.equal(applied.durableRevision, 4);
    const mergedHash = store.doc.contentHash;
    persistence._pendingStore = null;

    const recovered = new StudioPersistence(dir).initOrLoad();
    assert.equal(recovered.store.appliedRevision, 4);
    assert.equal(recovered.store.doc.contentHash, mergedHash);
  }

  // 3. syncNativeRpToStudio (when native template is available on host)
  if (!nativeTemplateSkipReason()) {
    const dir = join(root, 'sync-proj');
    const persistence = new StudioPersistence(dir);
    const { store } = persistence.initOrLoad({ domain: 'web' });
    persistence.commit(store, beforeCommit => store.applyTransaction({
      baseRevision: 1,
      idempotencyKey: 's-seed',
      commands: [{ type: 'addNode', node: { id: 'headline', type: 'label', text: 'Before Native', x: 40, y: 40, w: 220, h: 40 } }],
    }, { beforeCommit }));
    const beforeHash = store.doc.contentHash;

    const rpPath = join(dir, 'exports', 'native.rp');
    const exp = await exportStudioDocumentToRp(store.doc, { projectDir: dir, outRpPath: rpPath });
    assert.equal(exp.ok, true);

    const baseline = JSON.parse(readFileSync(`${rpPath}.baseline.json`, 'utf8'));
    const sym = baseline.sourceMap.find(s => s.id === 'home/headline' || s.logicalId === 'home/headline');
    assert.ok(sym?.native?.[0]);
    const loc = sym.native[0];
    const tmpEdited = `${rpPath}.edited.rp`;
    setRecordWidgetText(rpPath, tmpEdited, loc.record, loc.id, 'Edited In Axure');
    copyFileSync(tmpEdited, rpPath);

    const preview = await syncNativeRpToStudio({
      doc: store.doc,
      projectDir: dir,
      rpPath,
      mode: 'preview',
    });
    assert.equal(preview.ok, true);
    assert(preview.commands.length > 0);

    // WAL write failure leaves store untouched
    persistence.walWriteError = Object.assign(new Error('wal fail'), { code: 'E_WAL_WRITE' });
    await assert.rejects(() => syncNativeRpToStudio({
      doc: store.doc,
      store,
      persistence,
      projectDir: dir,
      rpPath,
      mode: 'apply',
      previewHash: preview.previewHash,
      idempotencyKey: 'sync-wal-fail',
    }), { code: 'E_WAL_WRITE' });
    assert.equal(store.appliedRevision, 2);
    assert.equal(store.doc.contentHash, beforeHash);
    assert.equal(store.idempotencyMap.has('sync-wal-fail'), false);
    persistence.walWriteError = null;

    // Post-WAL checkpoint crash returns W_CHECKPOINT_PENDING and replays cleanly
    const synced = await syncNativeRpToStudio({
      doc: store.doc,
      store,
      persistence,
      projectDir: dir,
      rpPath,
      mode: 'apply',
      previewHash: preview.previewHash,
      idempotencyKey: 'sync-ckpt-pending',
      simulateCrashStage: 'after_wal_before_doc',
    });
    assert.equal(synced.ok, true);
    assert.equal(synced.persistenceWarning?.code, 'W_CHECKPOINT_PENDING');
    assert.equal(synced.durableRevision, 3);
    const syncedHash = store.doc.contentHash;
    persistence._pendingStore = null;

    const recovered = new StudioPersistence(dir).initOrLoad();
    assert.equal(recovered.store.appliedRevision, 3);
    assert.equal(recovered.store.doc.contentHash, syncedHash);
  }
});
