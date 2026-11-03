import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createEmptyStudioDocument, computeContentHash } from '../studio/document.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';
import { startStudioServer } from '../studio/server.mjs';

function readNormalizeRecords(projectDir) {
  const path = join(projectDir, 'history', 'transactions.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
    .filter(record => record.kind === 'normalize');
}

async function startOnce(projectDir) {
  const { studio } = await startStudioServer({ projectDir, port: 0 });
  const ctx = studio.buildContextPayload();
  await studio.close();
  return ctx;
}

test('startup normalization advances revision exactly once, records it, and stays idempotent on restarts', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'studio-startup-norm-'));
  const projectDir = join(dir, 'project');
  try {
    // 模拟旧版未规范化工程：缺 palette 与 diagnostics，启动时 normalize 会改写内容。
    const doc = createEmptyStudioDocument({ name: 'Startup Norm Legacy', documentId: 'startup-norm' });
    delete doc.palette;
    delete doc.diagnostics;
    const persistence = new StudioPersistence(projectDir);
    persistence.saveFullSnapshot(doc);
    const unnormalizedHash = computeContentHash(JSON.parse(readFileSync(join(projectDir, 'document.json'), 'utf8')));

    const ctx1 = await startOnce(projectDir);
    const ctx2 = await startOnce(projectDir);
    const ctx3 = await startOnce(projectDir);

    // 第二、三次启动不再推进 revision。
    assert.equal(ctx1.appliedRevision, ctx2.appliedRevision);
    assert.equal(ctx2.appliedRevision, ctx3.appliedRevision);

    // 三次启动内容身份一致，且都等于规范化后的 hash（≠ 未规范化 hash）。
    assert.equal(ctx1.contentHash, ctx2.contentHash);
    assert.equal(ctx2.contentHash, ctx3.contentHash);
    assert.notEqual(ctx1.contentHash, unnormalizedHash);

    // 历史里恰好一条 normalize 记录，baseRevision 指向推进前版本。
    const normalizeRecords = readNormalizeRecords(projectDir);
    assert.equal(normalizeRecords.length, 1);
    assert.equal(normalizeRecords[0].baseRevision, ctx1.appliedRevision - 1);
    assert.equal(normalizeRecords[0].appliedRevision, ctx1.appliedRevision);
    assert.equal(normalizeRecords[0].revision, ctx1.appliedRevision);
    assert.equal(normalizeRecords[0].label, '启动规范化写回');
    assert.deepEqual(normalizeRecords[0].commands, []);
    assert.equal(normalizeRecords[0].actor.id, 'startup-normalize');

    // 首次启动报告推进；后续启动报告不推进。
    assert.equal(ctx1.recoveryReport.normalizedRevisionAdvanced, true);
    assert.equal(ctx2.recoveryReport.normalizedRevisionAdvanced, false);
    assert.equal(ctx3.recoveryReport.normalizedRevisionAdvanced, false);

    // recentHistory 首条可见启动规范化写回（含首次启动当次会话）。
    for (const ctx of [ctx1, ctx2, ctx3]) {
      assert.equal(ctx.recentHistory[0]?.label, '启动规范化写回');
      assert.equal(ctx.recentHistory[0]?.revision, ctx.appliedRevision);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('already-normalized projects restart without revision or hash drift (idempotent counter-case)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'studio-startup-norm-clean-'));
  const projectDir = join(dir, 'project');
  try {
    const doc = createEmptyStudioDocument({ name: 'Startup Norm Clean', documentId: 'startup-clean' });
    const persistence = new StudioPersistence(projectDir);
    persistence.saveFullSnapshot(doc);
    const normalizedHash = doc.contentHash;

    const ctx1 = await startOnce(projectDir);
    const ctx2 = await startOnce(projectDir);

    assert.equal(ctx1.appliedRevision, 1);
    assert.equal(ctx2.appliedRevision, ctx1.appliedRevision);
    assert.equal(ctx1.contentHash, normalizedHash);
    assert.equal(ctx2.contentHash, normalizedHash);
    assert.equal(readNormalizeRecords(projectDir).length, 0);
    assert.equal(ctx1.recoveryReport.normalizedRevisionAdvanced, false);
    assert.equal(ctx2.recoveryReport.normalizedRevisionAdvanced, false);
    assert.equal(ctx1.recentHistory.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
