import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { StudioPersistence } from '../studio/persistence.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { createEmptyStudioDocument, buildNodeIndex } from '../studio/document.mjs';
import { studioHandlers } from '../studio/mcp-adapter.mjs';
import { callCommandTool, listMcpTools } from '../scripts/mcp-tools.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zee-reliable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const persistence = new StudioPersistence(dir);
  const { store } = persistence.initOrLoad();
  const apply = commands => {
    const result = store.applyTransaction({ baseRevision: store.appliedRevision, idempotencyKey: `edit-${store.appliedRevision}`, commands });
    assert.equal(result.ok, true, JSON.stringify(result));
    persistence.persistTransaction(store, store.history.at(-1));
  };
  apply([{ type: 'addNode', node: { id: 'title', type: 'label', text: 'A', w: 160, h: 36 } }]);
  apply([{ type: 'setText', nodeId: 'title', text: 'B' }]);
  apply([{ type: 'setText', nodeId: 'title', text: 'C' }]);
  return { dir, persistence, store };
}
const title = store => [...buildNodeIndex(store.doc).byScopedId.values()].find(entry => entry.node.id === 'title')?.node.text;

test('legacy CLI flags and consolidated MCP parameters reach the Studio HTTP routes', async t => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, nodeSnapshots: [{ id: 'label-a' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const cli = fileURLToPath(new URL('../bin/axure.mjs', import.meta.url));
  const runCli = args => promisify(execFile)(process.execPath, [cli, 'studio', ...args, '--url', url]);

  await runCli(['export', '--out', 'test.rp', '--report', 'test.json']);
  assert.deepEqual(requests.at(-1), { url: '/api/export-rp', body: { outRpPath: 'test.rp', outReportPath: 'test.json' } });
  await runCli(['screenshot', '--revision', '99', '--page', 'other', '--node', 'label-a', '--out', 'test.png']);
  const { revision, pageId, nodeId, outPath } = requests.at(-1).body;
  assert.equal(requests.at(-1).url, '/api/screenshot');
  assert.deepEqual({ revision, pageId, nodeId, outPath }, { revision: 99, pageId: 'other', nodeId: 'label-a', outPath: 'test.png' });

  const inspect = await callCommandTool('studio_inspect', { url, view: 'full', nodeId: 'label-a' });
  assert.equal(inspect.isError, false);
  assert.equal(requests.at(-1).body.view, 'full');
  const review = await callCommandTool('studio_design', { url, action: 'review', verbose: true });
  assert.deepEqual(review.structuredContent.nodeSnapshots, [{ id: 'label-a' }]);
  for (const [name, args, path] of [
    ['studio_design', { action: 'explore' }, '/api/design/explore'],
    ['studio_merge', { kind: 'sync_native', rpPath: 'test.rp' }, '/api/sync-native'],
  ]) {
    const result = await callCommandTool(name, { url, ...args, async: true, requestKey: 'test-key' });
    assert.equal(result.isError, false);
    assert.equal(requests.at(-1).url, path);
    assert.equal(requests.at(-1).body.async, true);
    assert.equal(requests.at(-1).body.requestKey, 'test-key');
  }
  assert.equal(listMcpTools().find(tool => tool.name === 'studio_design').annotations.readOnlyHint, false);
});

test('restart restores undo/redo identity, then a new branch invalidates redo', t => {
  const { dir } = fixture(t);
  const records = readFileSync(join(dir, 'history', 'transactions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  let persistence = new StudioPersistence(dir), { store } = persistence.initOrLoad();
  assert.equal(title(store), 'C');
  assert.equal(store.undo().ok, true);
  assert.equal(title(store), 'B');
  persistence.persistTransaction(store, store.lastHistoryRecord);
  persistence = new StudioPersistence(dir); ({ store } = persistence.initOrLoad());
  assert.equal(store.redo().ok, true);
  assert.equal(title(store), 'C');
  persistence.persistTransaction(store, store.lastHistoryRecord);
  ({ store } = new StudioPersistence(dir).initOrLoad());
  assert.equal(store.undo().ok, true);
  assert.equal(title(store), 'B');
  persistence.persistTransaction(store, store.lastHistoryRecord);
  const edit = store.applyTransaction({ baseRevision: store.appliedRevision, idempotencyKey: 'branch', commands: [{ type: 'setText', nodeId: 'title', text: 'D' }] });
  assert.equal(edit.ok, true); persistence.persistTransaction(store, store.history.at(-1));
  ({ store } = new StudioPersistence(dir).initOrLoad());
  assert.equal(title(store), 'D');
  assert.equal(store.redo().code, 'E_NOTHING_TO_REDO');
  assert.equal(store.undo().ok, true); assert.equal(title(store), 'B');
});

test('WAL recovery after an undo commit restores content and the redo stack', t => {
  const { dir, persistence, store } = fixture(t);
  assert.equal(store.undo().ok, true);
  assert.throws(() => persistence.persistTransaction(store, store.lastHistoryRecord, { simulateCrashStage: 'after_wal_before_doc' }), /SIMULATED_CRASH/);
  const recovered = new StudioPersistence(dir).initOrLoad();
  assert.equal(recovered.recoveryReport.replayedTransactions, 1);
  assert.equal(title(recovered.store), 'B');
  assert.equal(recovered.store.redo().ok, true);
  assert.equal(title(recovered.store), 'C');
});

test('an old unlogged undo or missing snapshot cannot silently restore the wrong document', t => {
  const { dir, persistence, store } = fixture(t);
  assert.equal(store.undo().ok, true);
  persistence.saveFullSnapshot(store.doc); // Legacy release did not log this undo.
  const recovered = new StudioPersistence(dir).initOrLoad().store;
  assert.equal(title(recovered), 'B');
  assert.equal(recovered.undo().code, 'E_NOTHING_TO_UNDO');
  const isolated = new StudioDocumentStore(createEmptyStudioDocument());
  isolated.history.push({ txId: 'legacy-no-snapshot' });
  const before = JSON.stringify(isolated.doc);
  assert.equal(isolated.undo().code, 'E_HISTORY_SNAPSHOT_UNAVAILABLE');
  assert.equal(isolated.history.length, 1); assert.equal(JSON.stringify(isolated.doc), before);
});

test('a lost undo response is sent once and returns an explicit uncertain outcome', async t => {
  const { store } = fixture(t); let requests = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests++; store.undo(JSON.parse(raw)); res.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(studioHandlers.studio_undo({ url: `http://127.0.0.1:${server.address().port}` }), error => error.code === 'E_WRITE_OUTCOME_UNKNOWN');
    assert.equal(requests, 1); assert.equal(title(store), 'B');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('unknown properties reject the whole edit with an actionable correction', () => {
  const store = new StudioDocumentStore(createEmptyStudioDocument());
  assert.equal(store.applyTransaction({ commands: [{ type: 'addNode', node: { id: 'title', type: 'label', text: 'A', w: 160, h: 36 } }] }).ok, true);
  const before = JSON.stringify(store.doc);
  const invalid = store.applyTransaction({ commands: [{ type: 'setText', nodeId: 'title', text: 'PARTIAL' }, { type: 'setProperties', nodeId: 'title', properties: { fontSzie: 44 } }] });
  assert.equal(invalid.code, 'E_UNKNOWN_PROPERTY'); assert.ok(invalid.candidates.includes('fontSize'));
  assert.equal(JSON.stringify(store.doc), before);
  const created = store.applyTransaction({ commands: [{ type: 'addNode', node: { id: 'typo', type: 'label', fontSzie: 44 } }] });
  assert.equal(created.code, 'E_UNKNOWN_PROPERTY'); assert.equal(JSON.stringify(store.doc), before);
  const supported = store.applyTransaction({ commands: [{ type: 'setProperties', nodeId: 'title', properties: { fontFamily: 'Georgia', role: 'headline', css: { background: 'linear-gradient(red,blue)' } } }] });
  assert.equal(supported.ok, true, JSON.stringify(supported));
});

test('crash replay retains the transaction page rather than editing the first page', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-reliable-page-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const persistence = new StudioPersistence(dir), { store } = persistence.initOrLoad();
  const added = store.applyTransaction({ commands: [{ type: 'addPage', pageId: 'second', name: 'Second', domain: 'web' }] });
  assert.equal(added.ok, true, JSON.stringify(added)); persistence.persistTransaction(store, store.history.at(-1));
  const result = store.applyTransaction({ pageId: 'second', commands: [{ type: 'addNode', node: { id: 'second-only', type: 'label', text: 'Second' } }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.throws(() => persistence.persistTransaction(store, store.history.at(-1), { simulateCrashStage: 'after_wal_before_doc' }), /SIMULATED_CRASH/);
  const recovered = new StudioPersistence(dir).initOrLoad().store;
  const node = [...buildNodeIndex(recovered.doc).byScopedId.values()].find(entry => entry.node.id === 'second-only');
  assert.equal(node.pageId, 'second');
});

test('Studio reports a legacy server fingerprint and checks a reused instance belongs to the requested project', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-studio-fingerprint-'));
  let projectDir = dir;
  let commandRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/commands') commandRequests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, projectDir }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(join(dir, '.studio-instance.json'), JSON.stringify({ projectDir, port, url }));
  const opened = await callCommandTool('studio_open_project', { projectDir });
  assert.equal(opened.isError, false);
  const { studioRuntime } = opened.structuredContent;
  assert.equal(studioRuntime.sourceFingerprint, null);
  assert.match(studioRuntime.diskFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(studioRuntime.restartRequired, true);
  await assert.rejects(studioHandlers.studio_open_project({ projectDir, port: port === 4310 ? 4311 : 4310 }),
    { code: 'E_INSTANCE_PORT_MISMATCH' });
  projectDir = join(dir, 'different-project');
  await assert.rejects(studioHandlers.studio_command({ projectDir: dir, commands: [] }), { code: 'E_NO_STUDIO_INSTANCE' });
  assert.equal(commandRequests, 0);
});

async function postStudio(studio, route, body) {
  const response = await fetch(studio.url + route, { method: 'POST', body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function withBlockedPath(path, run) {
  const saved = path + '.test-backup';
  if (existsSync(path)) renameSync(path, saved);
  mkdirSync(path);
  try {
    return await run();
  } finally {
    rmdirSync(path);
    if (existsSync(saved)) renameSync(saved, path);
  }
}

async function startDurabilityFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zee-http-durable-'));
  const { studio } = await startStudioServer({ projectDir: dir, domain: 'web', port: 0 });
  t.after(async () => {
    await studio.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = {
    baseRevision: 1, idempotencyKey: 'create-title',
    commands: [{ type: 'addNode', node: { id: 'title', type: 'label', text: 'A', w: 120, h: 28 } }],
  };
  return { dir, studio, request };
}

test('failed WAL append leaves the command unpublished and permits the same idempotency key to retry', async t => {
  const { dir, studio, request } = await startDurabilityFixture(t);
  const beforeHash = studio.store.doc.contentHash;
  await withBlockedPath(studio.persistence.transactionsPath, async () => {
    const failed = await postStudio(studio, '/api/commands', request);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.appliedRevision, 1);
    assert.equal(failed.body.durableRevision, 1);
    assert.equal(studio.store.doc.contentHash, beforeHash);
    assert.equal(studio.scene.revision, 1);
    assert.equal(studio.store.lastScene.revision, 1);
    assert.equal(studio.store.history.length, 0);
    assert.equal(studio.store.idempotencyMap.has(request.idempotencyKey), false);
  });
  const retried = await postStudio(studio, '/api/commands', request);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.idempotentReplay, false);
  assert.equal(retried.body.appliedRevision, 2);
  assert.equal(retried.body.durableRevision, 2);
  assert.equal(studio.scene.revision, 2);
  const duplicate = await postStudio(studio, '/api/commands', request);
  assert.equal(duplicate.body.idempotentReplay, true);
  assert.equal(duplicate.body.txId, retried.body.txId);
  assert.equal(duplicate.body.durableRevision, 2);
  assert.equal(readFileSync(studio.persistence.transactionsPath, 'utf8').trim().split('\n').length, 1);
  const reopened = new StudioPersistence(dir).initOrLoad().store;
  assert.equal(reopened.appliedRevision, 2);
  assert.equal(title(reopened), 'A');
});

test('WAL failure does not consume the undo or redo head', async t => {
  const { studio, request } = await startDurabilityFixture(t);
  const created = await postStudio(studio, '/api/commands', request);
  assert.equal(created.body.ok, true);
  for (const [route, revision, undoCount, redoCount, expectedText] of [
    ['/api/undo', 2, 1, 0, 'A'],
    ['/api/redo', 3, 0, 1, undefined],
  ]) {
    const head = studio.store.history.at(-1)?.txId;
    const command = { expectedRevision: revision, ...(head ? { expectedHeadTxId: head } : {}) };
    const hash = studio.store.doc.contentHash;
    await withBlockedPath(studio.persistence.transactionsPath, async () => {
      const failed = await postStudio(studio, route, command);
      assert.equal(failed.body.ok, false);
      assert.equal(studio.store.appliedRevision, revision);
      assert.equal(studio.store.durableRevision, revision);
      assert.equal(studio.scene.revision, revision);
      assert.equal(studio.store.doc.contentHash, hash);
      assert.equal(studio.store.history.length, undoCount);
      assert.equal(studio.store.redoStack.length, redoCount);
      assert.equal(title(studio.store), expectedText);
    });
    const retried = await postStudio(studio, route, command);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.appliedRevision, revision + 1);
    assert.equal(retried.body.durableRevision, revision + 1);
  }
  assert.equal(title(studio.store), 'A');
});

test('an fsynced edit remains committed if the idempotency sidecar fails and is recovered from WAL', async t => {
  const { dir, studio, request } = await startDurabilityFixture(t);
  request.commands.push(
    { type: 'createInstance', componentId: 'button' },
    { type: 'setInteraction', nodeId: 'title', actions: [{ type: 'set-var', name: 'later', value: 1 }] },
    { type: 'setVariable', name: 'later', value: 0 },
  );
  await withBlockedPath(studio.persistence.idempotencyPath, async () => {
    const result = await postStudio(studio, '/api/commands', request);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.appliedRevision, 2);
    assert.equal(result.body.durableRevision, 2);
    assert.equal(result.body.persistenceWarning?.code, 'W_CHECKPOINT_PENDING');
    assert.equal(studio.scene.revision, 2);
    const retry = await postStudio(studio, '/api/commands', request);
    assert.equal(retry.body.idempotentReplay, true);
    assert.equal(retry.body.txId, result.body.txId);
    assert.equal(retry.body.durableRevision, 2);
    const reopened = new StudioPersistence(dir).initOrLoad();
    assert.equal(reopened.recoveryReport.replayedTransactions, 1);
    assert.equal(title(reopened.store), 'A');
    assert.equal(reopened.store.doc.contentHash, result.body.contentHash);
    assert.equal(reopened.store.getIdempotentResult(request).txId, result.body.txId);
  });
});

test('a committed undo reopens correctly when the earlier checkpoint omitted its restore target', async t => {
  const { dir, studio, request } = await startDurabilityFixture(t);
  const created = await postStudio(studio, '/api/commands', request);
  assert.equal(created.status, 200);
  const edited = await postStudio(studio, '/api/commands', {
    baseRevision: 2, idempotencyKey: 'edit-title',
    commands: [{ type: 'setText', nodeId: 'title', text: 'B' }],
  });
  assert.equal(edited.status, 200);
  rmSync(join(studio.persistence.snapshotsDir, 'rev-2.json'));
  await withBlockedPath(studio.persistence.idempotencyPath, async () => {
    const undone = await postStudio(studio, '/api/undo', { expectedRevision: 3 });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(undone.body.durableRevision, 4);
    const { store, recoveryReport } = new StudioPersistence(dir).initOrLoad();
    assert.equal(recoveryReport.replayedTransactions, 1);
    assert.equal(store.doc.contentHash, created.body.contentHash);
    assert.equal(title(store), 'A');
    assert.equal(store.redo().ok, true);
    assert.equal(title(store), 'B');
  });
});
