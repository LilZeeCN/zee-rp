import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyPerformanceEvidence } from '../benchmarks/studio/verify-evidence.mjs';
import { join } from 'node:path';
import os from 'node:os';
import { makePerfFixture } from '../benchmarks/studio/perf-fixtures.mjs';
import { normalizeStudioDocument } from '../studio/document.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';

test('performance evidence rejects stale source bindings instead of accepting historical green results', () => {
  const paths = [
    'studio/commands.mjs', 'studio/document.mjs', 'studio/scene-resolver.mjs', 'studio/server.mjs',
    'studio/web/src/api.mjs', 'studio/web/src/main.mjs', 'studio/web/src/render.mjs', 'studio/web/src/sync.mjs', 'studio/web/src/view.mjs',
  ];
  const runtimeFiles = paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex') }));
  runtimeFiles[0].sha256 = '0'.repeat(64);
  assert.throws(() => verifyPerformanceEvidence({ metadata: { runtimeFiles }, runtimeSourceUnchanged: true, cells: [] }), { code: 'E_EVIDENCE_STALE' });
});

test('P01 scale performance: live 1000-node component incremental edit & persistence flush preserve exact state', () => {
  const workDir = mkdtempSync(join(os.tmpdir(), 'studio-scale-check-'));
  try {
    const rawFixture = makePerfFixture({ size: 1000, category: 'components', projectDir: workDir });
    const doc = normalizeStudioDocument(rawFixture, workDir);
    const firstScene = resolveDocumentScene(doc);
    assert.equal(firstScene.pages[0].nodes.length, 1000);

    const persistence = new StudioPersistence(join(workDir, 'proj'));
    const store = new StudioDocumentStore(doc);
    persistence.saveFullSnapshot(store.doc);

    const tx = store.applyTransaction({
      baseRevision: store.appliedRevision,
      idempotencyKey: 'scale-live-1',
      pageId: 'p0',
      commands: [{ type: 'setText', pageId: 'p0', nodeId: 'probe', text: 'Scale live probe 001' }],
    });
    assert.equal(tx.ok, true);

    persistence.persistTransaction(store, store.history.at(-1));
    assert.equal(store.durableRevision, store.appliedRevision);

    // Verify recovery works both before and after flushPendingSnapshot
    const recoveredBeforeFlush = persistence.recoverAndLoad();
    assert.equal(recoveredBeforeFlush.store.appliedRevision, store.appliedRevision);
    assert.equal(recoveredBeforeFlush.store.doc.contentHash, store.doc.contentHash);

    persistence.flushPendingSnapshot();
    const recoveredAfterFlush = persistence.recoverAndLoad();
    assert.equal(recoveredAfterFlush.store.appliedRevision, store.appliedRevision);
    assert.equal(recoveredAfterFlush.store.doc.contentHash, store.doc.contentHash);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
