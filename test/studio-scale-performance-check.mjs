import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyPerformanceEvidence } from '../benchmarks/studio/verify-evidence.mjs';
import { join } from 'node:path';
import os from 'node:os';
import { makePerfFixture } from '../benchmarks/studio/perf-fixtures.mjs';
import { computeContentHash, normalizeStudioDocument } from '../studio/document.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';
import { startStudioServer } from '../studio/server.mjs';

test('performance evidence rejects stale source bindings instead of accepting historical green results', () => {
  const paths = [
    'studio/commands.mjs', 'studio/document.mjs', 'studio/scene-resolver.mjs', 'studio/server.mjs',
    'studio/web/src/api.mjs', 'studio/web/src/main.mjs', 'studio/web/src/render.mjs', 'studio/web/src/sync.mjs', 'studio/web/src/view.mjs',
  ];
  const runtimeFiles = paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex') }));
  runtimeFiles[0].sha256 = '0'.repeat(64);
  assert.throws(() => verifyPerformanceEvidence({ metadata: { runtimeFiles }, runtimeSourceUnchanged: true, cells: [] }), { code: 'E_EVIDENCE_STALE' });
});

test('seeded local edits and history agree with full scene resolution', () => {
  const fixture = makePerfFixture({ size: 400, category: 'multipage' });
  fixture.pages[0].root.children.push({
    type: 'box', id: 'flow', layout: 'row', x: 30, y: 20, w: 'hug', h: 40,
    children: [
      { type: 'label', id: 'flow-text', text: 'a', w: 'hug', h: 36 },
      { type: 'label', id: 'flow-sibling', text: 'next', w: 'hug', h: 36 },
    ],
  });
  const store = new StudioDocumentStore(normalizeStudioDocument(fixture));
  let seed = 17;
  let previousScene = resolveDocumentScene(store.doc);
  const cleanPage = previousScene.pages[1];
  for (let i = 0; i < 28; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const command = seed % 2 === 0
      ? { type: 'setText', nodeId: i % 3 ? 'flow-text' : 'probe', text: 'abc'.repeat(1 + seed % 13) }
      : { type: 'moveNode', nodeId: i % 3 ? 'flow' : 'probe', x: seed % 140, y: 60 + seed % 130 };
    const before = structuredClone(store.doc);
    const tx = i % 7 === 5 ? store.undo() : i % 7 === 6 ? store.redo() : store.applyTransaction({ pageId: 'p0', commands: [command] });
    assert.equal(tx.ok, true, tx.message);
    assert.equal(store.doc.contentHash, computeContentHash(store.doc));
    const full = resolveDocumentScene(store.doc, { useCache: false });
    assert.deepEqual(tx.scene.pages, full.pages, `step ${i}`);
    assert.deepEqual(tx.scene.clipDiagnostics, full.clipDiagnostics, `diagnostics at step ${i}`);
    if (tx.sourceNodePatch) {
      assert.ok(tx.scene.pages[1] === previousScene.pages[1], `untouched page reused at step ${i}`);
      assert.deepEqual(store.history.at(-1).beforeSnapshot, before);
    }
    previousScene = tx.scene;
  }
  assert.deepEqual(previousScene.pages[1], cleanPage);
});

test('large-canvas local patches preserve browser source, scene and paint across pan and zoom', async t => {
  const dir = mkdtempSync(join(os.tmpdir(), 'studio-local-patch-'));
  let studio;
  t.after(async () => {
    await studio?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const source = join(dir, 'source.json');
  writeFileSync(source, JSON.stringify(makePerfFixture({ size: 520, category: 'text' })));
  ({ studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath: source, port: 0 }));
  const page = await studio.ensureManagedBrowserPage();
  await page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__ === ${studio.store.appliedRevision}`);
  for (const [i, command] of [
    { type: 'setText', nodeId: 'probe', text: 'Only this source node changed' },
    { type: 'moveNode', nodeId: 'probe', x: 370, y: 138 },
  ].entries()) {
    const revision = studio.store.appliedRevision;
    const request = { baseRevision: revision, pageId: 'p0', commands: [command] };
    const result = await page.evaluate(`(async () => (await fetch('/api/commands', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(request))}
    })).json())()`);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.scenePatch.patchedNodesByPage.p0.map(node => node.id), ['probe']);
    await page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__ === ${result.appliedRevision}`);
    assert.equal(await page.evaluate('window.__STUDIO_LAST_PATCH_MODE__'), 'incremental-dom-patch');
    await page.evaluate(`window.__STUDIO_APP__.setPanZoom(${260 + i * 20}, 100, ${0.8 - i * 0.2})`);
    const actual = await page.evaluate(`(async () => {
      const expected = await (await fetch('/api/context')).json();
      const state = window.__STUDIO_STATE__;
      const element = document.querySelector('[data-node-id="probe"]');
      return {
        doc: JSON.stringify(state.doc) === JSON.stringify(expected.doc),
        nodes: JSON.stringify(state.scene.pages[0].nodes) === JSON.stringify(expected.scene.pages[0].nodes),
        text: element.textContent,
        left: element.style.left,
      };
    })()`);
    assert.deepEqual(actual, { doc: true, nodes: true, text: 'Only this source node changed', left: i ? '370px' : '340px' });
  }
  assert.equal(page.scriptErrors.length, 0);
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
