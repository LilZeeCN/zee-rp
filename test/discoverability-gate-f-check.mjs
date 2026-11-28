import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authoringTools,
  exportPrototype,
  runWorkflow,
  verifyOfficialPreview,
} from '../scripts/authoring-workflow.mjs';
import {
  generatePrototype,
  listMcpTools,
  validateInput,
} from '../scripts/mcp-tools.mjs';
import { parseInlineRowTarget } from '../scripts/preview-runtime.mjs';
import { findChromeExecutable } from '../studio/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HAS_RP9_APP = process.platform === 'darwin' && existsSync('/Applications/Axure RP 9.app');

function assertValidMcpCall(call, toolByName, label) {
  assert.ok(call && typeof call === 'object', `${label}: call must be an object`);
  const tool = toolByName.get(call.tool);
  assert.ok(tool, `${label}: unknown MCP tool '${call.tool}'`);
  assert.doesNotThrow(
    () => validateInput(tool.inputSchema, call.arguments ?? {}),
    `${label}: invalid MCP arguments for ${call.tool}`,
  );
}

test('Gate F1.1: zero dangling docs, live quickstart calls, and self-describing capabilities topics', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const allTools = listMcpTools({ profile: 'full' });
  const toolByName = new Map(allTools.map(t => [t.name, t]));
  const aTools = authoringTools({ generate: () => {}, sync: () => {}, listTools: () => allTools });
  const byName = new Map(aTools.map(t => [t.name, t]));

  // 1. runtime_info zero dead links + dynamic languageFeatureVersion + valid quickstart calls
  const info = byName.get('runtime_info').handler();
  assert.equal(info.status, 'completed');
  assert.equal(info.languageFeatureVersion, pkg.version, 'languageFeatureVersion must track package.json version');
  assert.ok(existsSync(info.capabilitiesMatrixPath), `capabilitiesMatrixPath must exist: ${info.capabilitiesMatrixPath}`);
  assert.ok(info.quickstart && typeof info.quickstart === 'object', 'runtime_info must expose compact quickstart');
  assertValidMcpCall(info.quickstart.capabilitiesCall, toolByName, 'quickstart.capabilitiesCall');
  assertValidMcpCall(info.quickstart.expressionProbeCall, toolByName, 'quickstart.expressionProbeCall');
  for (const [k, call] of Object.entries(info.quickstart.recipeRouter || {})) {
    assertValidMcpCall(call, toolByName, `quickstart.recipeRouter.${k}`);
  }

  // 2. diagnose_prototype(mode="capabilities") across all topics
  const diagHandler = byName.get('diagnose_prototype').handler;
  for (const topic of ['summary', 'functions', 'syntax', 'addressing', 'properties', 'recipes', 'all']) {
    const res = diagHandler({ mode: 'capabilities', topic });
    assert.equal(res.ok, true, `capabilities topic=${topic} failed: ${JSON.stringify(res)}`);
    assert.equal(res.topic, topic);
    assert.ok(Array.isArray(res.properties), `topic=${topic} must preserve backwards-compatible properties array`);
    if (topic === 'functions' || topic === 'all') {
      assert.ok(Array.isArray(res.functions) && res.functions.length >= 25);
    }
    if (topic === 'recipes' || topic === 'all' || topic === 'summary') {
      for (const item of res.toolRouter || []) assertValidMcpCall(item.call, toolByName, `toolRouter(${item.intent})`);
      for (const item of res.recipeRouter || []) assertValidMcpCall(item.call, toolByName, `recipeRouter(${item.need})`);
    }
  }
});

test('Gate F1.2: single-source function registry parity across compiler, native emitter, Studio runtime, and generated docs', () => {
  const fnRegistry = JSON.parse(readFileSync(join(ROOT, 'scripts/rplang/functions.json'), 'utf8'));
  const names = fnRegistry.functions.map(f => f.name);
  assert.ok(names.length >= 25, `expected >=25 unified functions, got ${names.length}`);

  const caps = runWorkflow('capabilities', null, { topic: 'functions' });
  assert.deepEqual(caps.functions.map(f => f.name), names);

  const md = readFileSync(join(ROOT, 'references/versioned-capabilities.md'), 'utf8');
  const runtimeExprSrc = readFileSync(join(ROOT, 'scripts/runtime-expr.mjs'), 'utf8');
  const studioRuntimeSrc = readFileSync(join(ROOT, 'studio/prototype-runtime.mjs'), 'utf8');

  for (const entry of fnRegistry.functions) {
    assert.ok(md.includes(`\`${entry.signature}\``), `versioned-capabilities.md missing signature: ${entry.signature}`);
    assert.ok(runtimeExprSrc.includes(`case '${entry.name}':`), `scripts/runtime-expr.mjs missing case '${entry.name}'`);
    assert.ok(new RegExp(`\\b${entry.name}\\s*:`).test(studioRuntimeSrc), `studio/prototype-runtime.mjs missing ${entry.name}`);
  }
});

test('Gate F1.3: zero fake errors, multi-diagnostic error recovery, and batch expression-probe', () => {
  const allTools = listMcpTools({ profile: 'full' });
  const toolByName = new Map(allTools.map(t => [t.name, t]));
  const aTools = authoringTools({ generate: () => {}, sync: () => {}, listTools: () => allTools });
  const diagHandler = aTools.find(t => t.name === 'diagnose_prototype').handler;

  // Multi-error document: 5 independent errors in a single pass (must NOT fail-fast at #1)
  const multiErrRp1 = [
    'rp/1',
    'var title = "hello"',
    'page home:',
    '  column #root [375x420] gap=8 padding=12',
    '    button #b1 [120x36] "测试"',
    '      +onClick:',
    '        set @out1 = =unknownMagic(var.title, 2)',
    '        set @out1 = =substring(var.title, 0, 2)',
    '        set @out1 = =left(var.title)',
    '        set @out1 = =var.missing_var',
    '        set @ghost_target = "x"',
    '    label #out1 [300x28] "init"',
  ].join('\n');

  const diag = diagHandler({ rp1: multiErrRp1 });
  assert.equal(diag.ok, false);
  const errors = diag.diagnostics.filter(d => d.severity !== 'warning');
  assert.ok(errors.length >= 5, `expected >=5 errors in one pass (non fail-fast), got ${errors.length}: ${JSON.stringify(errors)}`);
  assert.ok(diag.microCard && Array.isArray(diag.microCard.tips) && diag.microCard.tips.length >= 1, 'errors must attach JIT microCard');
  assertValidMcpCall(diag.microCard.queryMore, toolByName, 'microCard.queryMore');

  // Unknown function must report E_FUNCTION, never fake "concat needs..."
  const fnErrs = errors.filter(d => d.code === 'E_FUNCTION');
  assert.ok(fnErrs.length >= 2, `expected >=2 E_FUNCTION errors, got ${JSON.stringify(errors)}`);
  for (const e of errors) {
    assert.ok(!String(e.message).includes('concat needs'), `misleading concat message must never appear: ${e.message}`);
    assert.ok(typeof e.rule === 'string' && e.rule.length > 0, `diagnostic ${e.code} missing rule`);
    assert.ok(typeof e.remedy === 'string' && e.remedy.length > 0, `diagnostic ${e.code} missing remedy`);
    assertValidMcpCall(e.queryMore, toolByName, `diagnostic(${e.code}).queryMore`);
  }
  const substrErr = fnErrs.find(e => String(e.originalMessage || e.message).includes('substring'));
  assert.ok(substrErr?.suggestions?.includes('slice'), `substring should suggest slice: ${JSON.stringify(substrErr)}`);

  // Batch expression-probe: evaluates all 6 independently without fail-fast
  const probe = diagHandler({
    expressions: [
      "left('hello', 2)",
      'round(-2.5)',
      "replace('a-b-c', '-', '_')",
      'fooBar(1, 2)',
      "slice('abc')",
      'max(3, 9, 5)',
    ],
  });
  assert.equal(probe.mode, 'expression-probe');
  assert.equal(probe.ok, false);
  assert.deepEqual(probe.summary, { total: 6, passed: 4, failed: 2 });
  assert.equal(probe.results[0].previewValue, 'he');
  assert.equal(probe.results[1].previewValue, -2);
  assert.equal(probe.results[2].previewValue, 'a_b_c');
  assert.equal(probe.results[3].ok, false);
  assert.equal(probe.results[3].diagnostic.code, 'E_FUNCTION');
  assert.equal(probe.results[4].ok, false);
  assert.equal(probe.results[4].diagnostic.code, 'E_ARGUMENT');
  assert.equal(probe.results[5].previewValue, 9);
});

test('Gate F1.4: inline rowIndex target parser normalizes all intuitive addressing forms', () => {
  assert.deepEqual(parseInlineRowTarget('pick[0]'), { target: 'pick', rowIndex: 0, leaf: undefined });
  assert.deepEqual(parseInlineRowTarget('pick[rowIndex=2]'), { target: 'pick', rowIndex: 2, leaf: undefined });
  assert.deepEqual(parseInlineRowTarget('board/items/item[rowIndex=1]/pick'), { target: 'board/items/item/pick', rowIndex: 1, leaf: 'pick' });
  assert.deepEqual(parseInlineRowTarget('items[3]/pick'), { target: 'items/pick', rowIndex: 3, leaf: 'pick' });
  assert.deepEqual(parseInlineRowTarget('items[0].pick'), { target: 'items/pick', rowIndex: 0, leaf: 'pick' });
  assert.deepEqual(parseInlineRowTarget('items/1/pick'), { target: 'items/item/pick', rowIndex: 1, leaf: 'pick' });
});

test('Gate F1.5: eq-test (= literal & escape), unified 12 new functions, and polymorphic rowIndex + fixStep in real Chrome', { timeout: 90_000 }, async t => {
  try { findChromeExecutable(); } catch { return t.skip('未检测到 Chrome/Chromium'); }
  const work = mkdtempSync(join(tmpdir(), 'zee-gate-f-browser-'));
  try {
    // Part A: "=" button literal, "= 合计" label, "\=var.x" escaped literal, and unified string+math functions
    const rp1 = [
      'rp/1',
      'var raw = "  Abc-Def-123  "',
      'var score = -2.5',
      'page home:',
      '  column #root [375x420] gap=8 padding=12',
      '    button #eq [80x36] "="',
      '      +onClick:',
      '        set @out_str = =concat(left(trim(var.raw), 3), "|", right(trim(var.raw), 3), "|", slice(trim(var.raw), 4, 7), "|", substr(trim(var.raw), 4, 3), "|", replace(trim(var.raw), "-", "_"))',
      '        set @out_math = =concat(abs(var.score), "|", round(var.score), "|", floor(var.score), "|", ceil(var.score), "|", min(9, 3, 7), "|", max(9, 3, 7))',
      '    label #eq_text [200x28] "= 合计"',
      '    label #esc_text [200x28] "\\=var.raw"',
      '    label #out_str [340x28] "init"',
      '    label #out_math [340x28] "init"',
    ].join('\n');
    const outRp = join(work, 'eq-and-fns.rp');
    const gen = generatePrototype({ rp1, output: outRp, cwd: work });
    assert.equal(gen.status, 'completed', JSON.stringify(gen.diagnostics));

    const stepsA = [
      { action: 'expect', target: 'eq', expect: { text: '=' } },
      { action: 'expect', target: 'eq_text', expect: { text: '= 合计' } },
      { action: 'expect', target: 'esc_text', expect: { text: '=var.raw' } },
      { action: 'click', target: 'eq' },
      { action: 'expect', target: 'out_str', expect: { text: 'Abc|123|Def|Def|Abc_Def_123' } },
      { action: 'expect', target: 'out_math', expect: { text: '2.5|-2|-3|-2|3|9' } },
    ];
    for (const engine of HAS_RP9_APP ? ['official', 'studio-html'] : ['studio-html']) {
      const v = await verifyOfficialPreview(
        { rp: outRp, source: gen.source, engine, cwd: work, steps: stepsA },
        { runWorkflow, exportHtml: exportPrototype },
      );
      assert.equal(v.status, 'completed', `${engine}: ${JSON.stringify(v.failedStep ?? v.diagnostics)}`);
      assert.equal(v.passed, stepsA.length);
    }

    // Part B: polymorphic rowIndex addressing & actionable E_PREVIEW_AMBIGUOUS fixStep
    const repSpec = {
      language: 'rp/1', target: 9, name: 'Row addressing',
      models: { Row: { id: 'id', title: 'text' } },
      datasets: { items: { model: 'Row', rows: [{ id: 'r1', title: 'Alpha' }, { id: 'r2', title: 'Beta' }] } },
      pages: [{
        id: 'home', canvas: { w: 375, h: 320 }, root: {
          type: 'box', id: 'root', layout: 'column', gap: 8, padding: 12, children: [{
            type: 'repeater', id: 'list', dataset: 'items', key: 'id', rowHeight: 40, w: 320, h: 120,
            template: { type: 'label', id: 'row_title', text: '=item.title', w: 200, h: 30 },
          }],
        },
      }],
    };
    const repRp = join(work, 'rows.rp');
    const repGen = generatePrototype({ spec: repSpec, output: repRp, cwd: work });
    assert.equal(repGen.status, 'completed', JSON.stringify(repGen.diagnostics));

    const polySteps = [
      { action: 'expect', target: 'row_title', rowIndex: 0, expect: { text: 'Alpha' } },
      { action: 'expect', target: 'row_title[1]', expect: { text: 'Beta' } },
      { action: 'expect', target: 'row_title[rowIndex=0]', expect: { text: 'Alpha' } },
      { action: 'expect', target: 'home/list/item[rowIndex=1]/row_title', expect: { text: 'Beta' } },
      { action: 'expect', target: 'list[0]/row_title', expect: { text: 'Alpha' } },
      { action: 'expect', target: 'list/1/row_title', expect: { text: 'Beta' } },
    ];
    const polyRes = await verifyOfficialPreview(
      { rp: repRp, source: repGen.source, engine: 'studio-html', cwd: work, steps: polySteps },
      { runWorkflow, exportHtml: exportPrototype },
    );
    assert.equal(polyRes.status, 'completed', JSON.stringify(polyRes.failedStep ?? polyRes.diagnostics));
    assert.equal(polyRes.passed, polySteps.length);

    // Missing rowIndex produces actionable fixStep + matchedRows
    const ambigRes = await verifyOfficialPreview(
      { rp: repRp, source: repGen.source, engine: 'studio-html', cwd: work, steps: [{ action: 'expect', target: 'row_title', expect: { text: 'Alpha' } }] },
      { runWorkflow, exportHtml: exportPrototype },
    );
    assert.equal(ambigRes.status, 'failed');
    const d0 = ambigRes.diagnostics?.[0];
    assert.equal(d0?.code, 'E_PREVIEW_AMBIGUOUS');
    assert.ok(Array.isArray(d0?.matchedRows) && d0.matchedRows.length === 2, JSON.stringify(d0));
    assert.equal(d0?.fixStep?.rowIndex, 0, JSON.stringify(d0));
    assert.ok(typeof d0?.rule === 'string' && typeof d0?.remedy === 'string', JSON.stringify(d0));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
