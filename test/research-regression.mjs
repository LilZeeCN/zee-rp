import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { TEST_DIR, fixtures, summarizeFixture } from './research-fixture-summary.mjs';
import { runPanelMasterChecks } from './panel-master-check.mjs';
import { runDirectImageChecks, runMasterDirectImageChecks } from './direct-image-check.mjs';
import { runMasterRepeaterChecks } from './master-repeater-check.mjs';
import { runConditionExpressionChecks } from './condition-expression-check.mjs';
import { runRichTextParameterChecks } from './richtext-parameter-check.mjs';
import { runStyleParameterChecks } from './style-parameter-check.mjs';
import { runCreateGlobalVariableChecks } from './create-global-variable-check.mjs';
import { runCloneConnectorChecks } from './clone-connector-check.mjs';
import { runWriterSemanticsChecks } from './writer-semantics-check.mjs';
import { runSemanticsChecks } from './semantics-check.mjs';
import { runCopyPathSemanticsChecks } from './copy-path-semantics-check.mjs';
import { runPageLinkChecks } from './page-link-check.mjs';
import { runVersionChecks } from './version-check.mjs';

export async function runRegression({ update = false, log = () => {} } = {}) {
  const results = [];
  const check = (name, passed, detail = '') => {
    results.push({ name, passed, ...(passed || !detail ? {} : { detail }) });
    log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed || !detail ? '' : ` — ${detail}`}`);
  };
  const entries = fixtures();
  const snapshotPath = process.env.AXURE_SNAPSHOTS || join(TEST_DIR, 'snapshots.json');
  const actual = {};
  for (const entry of entries) {
    try {
      const summary = summarizeFixture(entry);
      actual[entry.name] = summary;
      check(`fixture ${entry.name} SHA/结构`, summary.sha256 === entry.sha256 && summary.bytes === entry.bytes
        && summary.records.unparseable === 0 && summary.counts.danglingRefs === 0 && summary.counts.problems === 0,
      JSON.stringify({ sha: summary.sha256, unparseable: summary.records.unparseable, danglingRefs: summary.counts.danglingRefs, problems: summary.problems }));
    } catch (error) { check(`fixture ${entry.name} SHA/结构`, false, error.message); }
  }
  if (update) {
    if (results.some(r => !r.passed)) throw new Error('fixture 健康检查失败，拒绝更新快照');
    // --update 是唯一明确允许替换基线的操作；普通回归只读快照。
    writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + '\n');
  }
  let expected = {};
  try { expected = JSON.parse(readFileSync(snapshotPath, 'utf8')); }
  catch (error) { check('读取 snapshots.json', false, error.message); }
  check('fixture 清单与快照键完整相等', isDeepStrictEqual(Object.keys(expected), entries.map(e => e.name)));
  for (const entry of entries) check(`fixture ${entry.name} 完整快照`, !!actual[entry.name]
    && isDeepStrictEqual(actual[entry.name], expected[entry.name]), '摘要与基线不一致');

  const parity = spawnSync(process.execPath, [join(TEST_DIR, 'parity-check.mjs')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = (parity.stdout ?? '').split('\n');
  for (const line of lines) {
    const match = /^(PASS|FAIL)\s+(.*)$/.exec(line);
    if (match) check(`parity ${match[2]}`, match[1] === 'PASS');
  }
  check('parity 进程成功且恰有 23 项断言', parity.status === 0 && lines.filter(l => /^(PASS|FAIL)\s/.test(l)).length === 23,
    parity.error?.message ?? parity.stderr ?? `exit=${parity.status}`);
  const work = lines.find(l => /^工作目录: \/tmp\/axure-parity-[a-z0-9-]+$/.test(l))?.slice('工作目录: '.length);
  if (work && lstatSync(work).isDirectory()) rmSync(work, { recursive: true });
  for (const result of runPanelMasterChecks()) check(`panel-master ${result.name}`, result.passed, result.detail);
  for (const result of runDirectImageChecks()) check(`direct-image ${result.name}`, result.passed, result.detail);
  for (const result of runMasterDirectImageChecks()) check(`master-direct-image ${result.name}`, result.passed, result.detail);
  for (const result of runMasterRepeaterChecks()) check(`master-repeater ${result.name}`, result.passed, result.detail);
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const result of await runConditionExpressionChecks()) check(`condition-expression ${result.name}`, result.passed, result.detail);
  } finally {
    await new Promise(resolve => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
  }
  check('regression 零未捕获 Promise rejection (anti-fake-green 守卫)', unhandled.length === 0, unhandled.join('; '));
  for (const result of runRichTextParameterChecks()) check(`richtext ${result.name}`, result.passed, result.detail);
  for (const result of runStyleParameterChecks()) check(`style ${result.name}`, result.passed, result.detail);
  for (const result of runCreateGlobalVariableChecks()) check(`create-global-variable ${result.name}`, result.passed, result.detail);
  for (const result of runCloneConnectorChecks()) check(`clone-connector ${result.name}`, result.passed, result.detail);
  for (const result of runWriterSemanticsChecks()) check(`writer-semantics ${result.name}`, result.passed, result.detail);
  for (const result of runSemanticsChecks()) check(`semantics ${result.name}`, result.passed, result.detail);
  for (const result of runCopyPathSemanticsChecks()) check(`copy-path ${result.name}`, result.passed, result.detail);
  for (const result of runPageLinkChecks()) check(`page-link ${result.name}`, result.passed, result.detail);
  for (const result of runVersionChecks()) check(`version ${result.name}`, result.passed, result.detail);
  const failed = results.filter(r => !r.passed).length;
  const categories = {};
  for (const e of entries) categories[e.category] = (categories[e.category] ?? 0) + 1;
  const report = { fixtures: entries.length, categories, total: results.length, passed: results.length - failed, failed, results };
  log(`共 ${report.total} 项断言：${report.passed} 通过，${failed} 失败`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  if (args.some(a => !['--update', '--json'].includes(a))) throw new Error('Usage: node test/regression.mjs [--update] [--json]');
  const report = await runRegression({ update: args.includes('--update'), log: args.includes('--json') ? () => {} : console.log });
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failed ? 1 : 0;
}
