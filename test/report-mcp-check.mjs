// Real MCP transport regressions, including the original five-page autoHeal case.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.env.AXURE_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.env.AXURE_REPORT_FIXES_OUTPUT;
const work = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'zee-report-mcp-'));
mkdirSync(work, { recursive: true });
const client = new Client({ name: 'external-report-regressions', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
  env: { ...process.env, AXURE_WRITE_ROOT: work }, stderr: 'pipe' });
const checks = [];
const fixture = () => ({ language: 'rp/1', domain: 'test', pages: [{ id: 'home', canvas: [420, 160], root: {
  type: 'box', id: 'root', layout: 'stack', w: 'fill', h: 'fill', children: [
    { type: 'label', id: 't1', text: 'A', x: 20, y: 20, w: 100, h: 40 },
    { type: 'button', id: 'bn', text: 'OK', x: 160, y: 20, w: 100, h: 40 },
  ] } }] });
async function call(name, args, expectedError = false) {
  const raw = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  const result = raw.structuredContent ?? JSON.parse(raw.content[0].text);
  assert.equal(Boolean(raw.isError), expectedError, JSON.stringify(result));
  return result;
}
function record(name) { checks.push(name); console.log('PASS', name); }
try {
  await client.connect(transport);
  for (const source of [fixture(), JSON.stringify(fixture())]) {
    const data = await call('diagnose_prototype', { source });
    assert.equal(data.ok, true); record('diagnose inline ' + typeof source);
  }
  const catalog = await call('prototype_recipe', {});
  assert.deepEqual(catalog.tokens.devices['iphone-16-pro'], [393, 852]);
  assert.deepEqual(catalog.tokens.devices['iphone-17'], [402, 874]);
  assert(!catalog.tokens.colorTokens.includes('$subtle') && !catalog.tokens.colorTokens.includes('$brandSoft'));
  const paletteProbe = fixture();
  paletteProbe.pages[0].root.children = catalog.tokens.colorTokens.map((color, i) => ({ type: 'label', id: `c${i}`, text: color, color }));
  const validTokens = await call('diagnose_prototype', { source: paletteProbe });
  assert.equal(validTokens.ok, true);
  const header = join(work, 'header.rp1');
  writeFileSync(header, catalog.cheatsheet.header + '\npage #home\n  label #title "Hi"\n');
  assert.equal((await call('diagnose_prototype', { source: header })).ok, true);
  record('recipe header, every advertised color, and device sizes compile');

  const negatives = [
    ['font zero', s => s.pages[0].root.children[0].fontSize = 0, 'E_SIZE'],
    ['font too large', s => s.pages[0].root.children[0].fontSize = 100000, 'E_SIZE'],
    ['negative letterSpacing', s => s.pages[0].root.children[0].letterSpacing = -4, 'E_SIZE'],
    ['nonstack unknown after', s => { s.pages[0].root.layout = 'column'; s.pages[0].root.children[0].after = 'ghost'; }, 'E_REFERENCE'],
    ['phone-shell unknown after', s => { s.pages[0].root = { type: 'phone-shell', id: 'shell', children: [{ type: 'label', id: 't', text: 'A', after: 'ghost' }] }; }, 'E_REFERENCE'],
    ['bad after', s => s.pages[0].root.children[0].after = 'ghost', 'E_REFERENCE'],
    ['bad alignment', s => s.pages[0].root.children[0].alignX = 'middle', 'E_PROPERTY'],
    ['bad pin', s => s.pages[0].root.children[0].pin = 'center', 'E_PROPERTY'],
    ['unknown device', s => s.device = 'iPhone 16 Pro', 'E_PROPERTY'],
    ['palette number', s => s.palette = { brand: 123 }, 'E_COLOR'],
    ['palette hex', s => s.palette = { brand: '#F00' }, 'E_COLOR'],
    ['NUL', s => s.pages[0].root.children[0].text = 'a\u0000b', 'E_TEXT_CONTROL'],
    ['widget load', s => s.pages[0].root.children[1].onLoad = [{ type: 'wait', ms: 1 }], 'E_EVENT_TARGET'],
    ['invalid action string', s => s.pages[0].root.children[1].onClick = 'not an action', 'E_EVENT'],
    ['duplicate page', s => s.pages.push({ ...s.pages[0], name: 'Another' }), 'E_ID_DUPLICATE'],
    ['ghost tab', s => s.tabBar = [{ id: 'ghost', text: 'X' }], 'E_REFERENCE'],
    ['top tab string', s => s.tabBar = 'home', 'E_TYPE'],
    ['bad statechart', s => s.statecharts = { sc: { initial: 'a', states: ['a'], transitions: [{ from: 'a', to: 'ghost', on: 'click' }] } }, 'E_STATECHART'],
    ['depth', s => { let n = s.pages[0].root; for (let i = 0; i < 250; i++) n = { type: 'box', id: `b${i}`, children: [n] }; s.pages[0].root = n; }, 'E_DEPTH'],
  ];
  for (const [label, when, code] of [['empty', '', 'E_EXPRESSION'], ['malformed', '$n >>>', 'E_EXPRESSION'],
    ['number', 42, 'E_TYPE'], ['missing', undefined, 'E_EXPRESSION']]) {
    negatives.push(['form condition ' + label, s => {
      s.variables = { n: { type: 'number', value: 1 } };
      const c = { actions: [] }; if (when !== undefined) c.when = when;
      s.pages[0].root.children.push({ type: 'form-card', id: 'fc', fields: [{ id: 'f1', label: 'Name' }], onSubmit: { cases: [c] } });
    }, code]);
  }
  for (const [label, value] of [['missing', '$nosuch'], ['wrong type', '$n'], ['bad default', '$selected']]) {
    negatives.push(['selector ' + label, s => {
      s.variables = { n: { type: 'number', value: 1 }, selected: { type: 'text', value: 'ghost' } };
      s.models = { Row: { id: 'text', title: 'text' } };
      s.datasets = { rows: { model: 'Row', rows: [{ id: 'a', title: 'A' }] } };
      s.views = { DV: { source: 'rows', key: 'id', selector: value, fields: { t1: 'title' } } };
    }, 'E_VARIABLE']);
  }
  for (const [label, row, code] of [['missing', { id: 'x' }, 'E_FIELD_MISSING'],
    ['extra', { id: 'x', title: 'X', extra: 1 }, 'E_DATA_FIELD']]) {
    negatives.push(['form data-add ' + label, s => {
      s.models = { Row: { id: 'text', title: 'text' } };
      s.datasets = { rows: { model: 'Row', rows: [{ id: 'a', title: 'A' }] } };
      s.pages[0].root.children.push({ type: 'repeater', id: 'rep', dataset: 'rows', key: 'id', rowHeight: 40,
        w: 100, h: 80, template: { type: 'label', id: 'row', text: { item: 'title' } } },
      { type: 'form-card', id: 'fc', fields: [{ id: 'f1', label: 'Name' }], onSubmit: [{ type: 'data-add', target: 'rep', rows: [row] }] });
    }, code]);
  }
  for (const [name, mutate, code] of negatives) {
    const spec = fixture(); mutate(spec);
    const source = join(work, `${code}-${checks.length}.json`), output = join(work, `rejected-${checks.length}.rp`);
    writeFileSync(source, JSON.stringify(spec));
    const mcp = await call('generate_prototype', { spec, output }, true);
    assert.equal(mcp.diagnostics[0].code, code, name + JSON.stringify(mcp));
    assert(!existsSync(output));
    const cli = spawnSync(process.execPath, [join(root, 'scripts/proto.mjs'), 'generate', '--spec', source,
      '--out-dir', join(work, `cli-${checks.length}`), '--compile-only'], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, name);
    assert.equal(JSON.parse(cli.stdout || cli.stderr).diagnostics[0].code, code, name);
    record('CLI / MCP reject ' + name);
  }
  const incomplete = fixture(); incomplete.pages[0].root.children[0].text = '=1 +';
  const diagnosis = await call('diagnose_prototype', { source: incomplete }, true);
  assert.equal(diagnosis.diagnostics[0].code, 'E_EXPRESSION');
  assert.equal(diagnosis.diagnostics[0].message, 'Unexpected end of expression');
  assert.equal(diagnosis.diagnostics[0].widgetId, 't1');
  record('diagnose incomplete expression has clean message and widget context');
  const job = await call('generate_prototype', { spec: fixture(), output: join(work, 'job.rp'), async: true });
  let finished = job;
  const deadline = Date.now() + 120000;
  while (['queued', 'running'].includes(finished.status) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    finished = await call('jobs_get', { id: job.id });
  }
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  const cancelled = await call('jobs_cancel', { id: job.id });
  assert.equal(cancelled.cancelled, false); assert.equal(cancelled.reason, 'already_completed');
  record('completed job explicitly refuses cancellation');

  const starknow = process.env.AXURE_STARKNOW_SOURCE;
  if (starknow) {
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = hash(starknow);
    const defaultRun = await call('generate_prototype', { source: starknow, output: join(work, 'starknow-default.rp'), strictAudit: true });
    assert.equal(defaultRun.audit.structuralOk, true); assert.equal(defaultRun.audit.warningCount, 0);
    const healedRun = await call('generate_prototype', { source: starknow, output: join(work, 'starknow-healed.rp'), strictAudit: true, autoHeal: true });
    assert.equal(healedRun.audit.structuralOk, true); assert.equal(healedRun.audit.warningCount, 0);
    assert.equal(healedRun.audit.autoHeal.rolledBack, true);
    assert.equal(healedRun.audit.autoHeal.healedCount, 0);
    const a = JSON.parse(readFileSync(defaultRun.report)), b = JSON.parse(readFileSync(healedRun.report));
    const planA = JSON.parse(readFileSync(a.artifacts.plan)), planB = JSON.parse(readFileSync(b.artifacts.plan));
    assert.equal(planA.semanticHash, planB.semanticHash);
    assert.deepEqual(JSON.parse(readFileSync(a.artifacts.ir)), JSON.parse(readFileSync(b.artifacts.ir)));
    assert.deepEqual(planA.pages.map(p => JSON.parse(readFileSync(p.mainSpecPath))),
      planB.pages.map(p => JSON.parse(readFileSync(p.mainSpecPath))));
    assert(b.audit.autoHeal.rejectedDiagnostics.length >= 5);
    assert(b.audit.autoHeal.rejectedChanges.every(c => c.pointer && c.property && Object.hasOwn(c, 'from') && Object.hasOwn(c, 'to')));
    assert.equal(hash(starknow), before);
    writeFileSync(join(work, 'starknow-comparison.json'), JSON.stringify({ sourceSha256: before,
      default: defaultRun, healed: healedRun, semanticHash: planA.semanticHash,
      rejectedFailures: b.audit.autoHeal.rejectedDiagnostics.length,
      rejectedChanges: b.audit.autoHeal.rejectedChanges.length }, null, 2));
    record('original starknow strict generation, autoHeal rollback and unchanged IR/source');
  }
  const info = await call('runtime_info', {});
  assert.equal(info.restartRequired, false); record('fresh stdio fingerprint matches disk');

  // Round 4 MCP regressions: R4-06 (set_widget_style on Layer without fill/invalid color) & R4-07 (set_widget_richtext args structured error)
  const r4Rp = join(work, 'r4-mcp.rp');
  await call('generate_prototype', { spec: fixture(), output: r4Rp });
  await call('axure_open', { path: r4Rp });
  const badStyleLayer = await call('set_widget_style', { widget: 'root', fill: 'notacolor' }, true);
  assert.equal(badStyleLayer.code, 'E_TOOL_INPUT');
  const noFillLayer = await call('set_widget_style', { widget: 'root', fill: '#FF0000' }, true);
  assert.equal(noFillLayer.code, 'E_TOOL_INPUT');
  record('set_widget_style rejects invalid colors upfront and refuses no-op style writes on unsupported widgets');

  const rtSpec = join(work, 'bad-rt.json');
  writeFileSync(rtSpec, JSON.stringify({ page: 'home', widget: 'txt-t1', paragraphs: [{ runs: [{ text: 'x', style: { bogusKey: 1 } }] }] }));
  const badRt = await call('set_widget_richtext', { args: [r4Rp, join(work, 'rt-out.rp'), rtSpec] }, true);
  assert.equal(badRt.code, 'E_TOOL_INPUT');
  assert(Array.isArray(badRt.diagnostics) && badRt.diagnostics.length > 0);
  assert(!String(badRt.stderr || '').includes('file://'));
  record('set_widget_richtext args mode returns structured E_TOOL_INPUT without raw stack traces');

  writeFileSync(join(work, 'checks.json'), JSON.stringify({ root, passed: checks.length, checks }, null, 2));
} finally {
  await client.close();
  if (!keep) rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: checks.length, checks }));
