#!/usr/bin/env node
// Replays only the semantic evidence layer. It does not certify browser/native behavior.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const root = args.includes('--root') ? resolve(value('--root')) : resolve(here, '../..');
const suite = JSON.parse(readFileSync(resolve(here, 'tasks.json'), 'utf8'));
const { SCENARIO_STEP_SCHEMA } = await import(pathToFileURL(resolve(root, 'studio/runtime.mjs')));
const { validateInput } = await import(pathToFileURL(resolve(root, 'scripts/mcp-tools.mjs')));
let assertionCount = 0;
for (const task of suite.tasks) for (const scenario of task.scenarios) for (const step of scenario.steps) {
  validateInput(SCENARIO_STEP_SCHEMA, step);
  assertionCount += Object.entries(step.expect || {}).reduce((n, [key, val]) => n + (key === 'page' ? 1 : Object.keys(val).length), 0);
}
if (args.includes('--check-schema')) {
  console.log(JSON.stringify({ ok: true, tasks: suite.tasks.length, scenarios: suite.tasks.reduce((n, t) => n + t.scenarios.length, 0), declaredAssertions: assertionCount, productExecutions: 0, note: 'Validated against actual runtime step schema; no task was executed.' }));
} else {
  if (!args.includes('--task') || !args.includes('--url') || !args.includes('--out')) throw new Error('Usage: node benchmarks/studio/replay.mjs --task T01 --url http://127.0.0.1:PORT --out /abs/scenario-result.json [--root /source/root]');
  const task = suite.tasks.find(item => item.id === value('--task'));
  if (!task) throw new Error('Unknown task');
  const { studioHandlers } = await import(pathToFileURL(resolve(root, 'studio/mcp-adapter.mjs')));
  const results = [];
  for (const scenario of task.scenarios) {
    const startedAt = new Date().toISOString(), start = performance.now();
    try {
      const result = await studioHandlers.studio_run_scenario({ url: value('--url'), startPageId: scenario.startPageId, reset: scenario.reset, steps: scenario.steps, verbose: true });
      results.push({ scenarioId: scenario.id, startedAt, elapsedMs: performance.now() - start, result });
    } catch (error) {
      results.push({ scenarioId: scenario.id, startedAt, elapsedMs: performance.now() - start, result: { ok: false, code: error.code || 'E_REPLAY', message: error.message } });
    }
  }
  const report = { schemaVersion: 1, taskId: task.id, executionLayer: 'studio-semantic', taskCallsMustBeAddedToRunLedger: results.length, results, note: 'Only semantic execution; browser screenshots/pointer, source preservation, native and visual judgments require separate evidence.' };
  const target = resolve(value('--out')); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ taskId: task.id, executionLayer: report.executionLayer, scenarios: results.length, output: target }));
  if (results.some(item => item.result.ok !== true || item.result.passed === false)) process.exitCode = 1;
}
