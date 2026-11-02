#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyPerformanceEvidence(data, { root = defaultRoot } = {}) {
  assert(data.metadata?.runtimeFiles?.length, 'Performance evidence must bind actual runtime files');
  const runtimeFiles = data.metadata.runtimeFiles.filter(file => /^(studio\/|scripts\/|bin\/|references\/rp-language\.schema\.json$|package(?:-lock)?\.json$)/.test(file.path));
  for (const required of ['studio/commands.mjs', 'studio/document.mjs', 'studio/scene-resolver.mjs', 'studio/server.mjs', 'studio/web/app.js']) {
    assert(runtimeFiles.some(file => file.path === required), `Missing runtime binding: ${required}`);
  }
  for (const file of runtimeFiles) {
    if (digest(readFileSync(resolve(root, file.path))) !== file.sha256) throw Object.assign(new Error(`Performance evidence is stale: ${file.path}`), { code: 'E_EVIDENCE_STALE' });
  }
  assert.equal(data.runtimeSourceUnchanged, true);
  const cells = new Set();
  for (const cell of data.cells || []) {
    const label = `${cell.category}/${cell.size}`;
    assert(!cells.has(label), `Duplicate cell: ${label}`);
    cells.add(label);
    assert.equal(cell.status, 'measured', label);
    assert.equal(cell.persistenceCheck?.matches, true, `${label}: persistence`);
    const raw = cell.browser?.rawEdits || [];
    assert(raw.length >= 30, `${label}: need 30 original edit samples`);
    assert.equal(new Set(raw.map(row => row.revision)).size, raw.length, `${label}: repeated revisions`);
    for (const row of raw) {
      assert(/^[a-f0-9]{64}$/.test(row.contentHash) && /^[a-f0-9]{64}$/.test(row.screenshotSha256), `${label}: render binding`);
      assert(Number.isFinite(row.screenshotBarrierMs) && row.screenshotBarrierMs > 0);
    }
    const measured = p95(raw.map(row => row.screenshotBarrierMs));
    assert(Math.abs(measured - cell.browser.summary.editToScreenshotBarrier.p95) < .001, `${label}: summary differs from raw samples`);
    assert(measured <= (cell.size === 1000 ? 100 : cell.size === 5000 ? 250 : 500), `${label}: edit p95 ${measured} exceeds target`);
    if (cell.size === 5000) for (const kind of ['pan', 'zoom']) {
      const frames = cell.browser.rawFrames[kind]?.intervals;
      assert(frames?.length >= 30, `${label}: ${kind} original frames`);
      assert(p95(frames) <= 33, `${label}: ${kind} frames exceed target`);
    }
    assert(Math.max(0, ...(cell.browser.longTasks || []).map(task => task.duration)) <= 1000, `${label}: main thread freeze`);
    assert(cell.processMemory?.peakWorkerRssBytes > 0 && cell.processMemory?.peakDescendantsRssBytes > 0, `${label}: process tree memory`);
  }
  for (const category of ['text', 'images', 'components', 'multipage']) for (const size of [1000, 5000, 10000]) assert(cells.has(`${category}/${size}`), `Missing cell: ${category}/${size}`);
  assert.equal(cells.size, 12);
  return { ok: true, evidenceKind: 'bound-performance-measurement', runtimeFilesVerified: runtimeFiles.length, cellsVerified: cells.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--performance');
    assert(at >= 0 && args[at + 1], 'Usage: node benchmarks/studio/verify-evidence.mjs --performance /path/to/results.json [--root /path/to/runtime]');
    const rootAt = args.indexOf('--root');
    console.log(JSON.stringify(verifyPerformanceEvidence(JSON.parse(readFileSync(args[at + 1], 'utf8')), { root: rootAt >= 0 ? args[rootAt + 1] : defaultRoot })));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || 'E_EVIDENCE_INVALID', message: error.message }));
    process.exitCode = 1;
  }
}
