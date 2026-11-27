import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.AXURE_MCP_EXPORT_OUTPUT;
const browserModule = process.env.PLAYWRIGHT_MODULE;
const verifyHost = process.env.AXURE_MCP_EXPORT_HOST === '1';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function session(run, env = {}) {
  const dir = evidence ? resolve(evidence) : mkdtempSync(join(tmpdir(), 'zee-rp-export-'));
  if (evidence) mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(dir, 'stdio-'));
  const client = new Client({ name: 'zee-rp-export-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
    cwd: work, stderr: 'pipe', env: { ...process.env, AXURE_WRITE_ROOT: work,
      AXURE_PROTECTED_PATHS: join(work, 'protected.rp'), ...env } });
  try {
    await client.connect(transport);
    const call = async (name, args = {}, isError = false) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
      assert.equal(Boolean(result.isError), isError, result.content[0].text);
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    return await run({ client, call, work: realpathSync(work) });
  } finally {
    await client.close();
    if (!evidence) rmSync(dir, { recursive: true, force: true });
  }
}

test('agent can discover official export and a runnable native-interaction recipe from MCP alone', async () => {
  await session(async ({ client, call }) => {
    assert.match(client.getInstructions(), /generate_prototype.*export_prototype.*gui_roundtrip/);
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'export_prototype');
    assert.deepEqual(tool.inputSchema.required, ['rp']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, false);
    const generation = tools.find(t => t.name === 'generate_prototype');
    assert(generation.inputSchema.properties.recipe.enum.includes('native-gestures'));
    const catalog = await call('prototype_recipe', { recipe: 'native-gestures', includeSource: true });
    assert.match(catalog.recipes[0].sourceText, /onSwipeLeft/);
    assert.deepEqual(catalog.recipes[0].pages, ['demo']);
    assert.deepEqual(catalog.recipes[0].generate, { tool: 'generate_prototype',
      arguments: { recipe: 'native-gestures', output: 'native-gestures.rp' } });
    const runtime = await call('runtime_info');
    assert.equal(runtime.host.officialHtml.tool, 'export_prototype');
    assert.equal(runtime.host.officialHtml.generatorSettings, 'fresh-defaults');
    assert.equal(runtime.restartRequired, false);
  });
});

test('MCP export protects files and returns recovery guidance for invalid input and missing host', async () => {
  const missingInstallation = join(tmpdir(), 'zee-rp-export-no-such-axure.app');
  await session(async ({ call, work }) => {
    writeFileSync(join(work, 'plain.rp'), 'a non-Axure file');
    const header = Buffer.from([0xac, 0xef, 9, 0, 0, 0, 0, 0]);
    writeFileSync(join(work, 'probe.rp'), header);
    writeFileSync(join(work, 'protected.rp'), header);
    const incompatibleOptions = await call('generate_prototype', {
      recipe: 'native-gestures', output: 'conflict.rp', includeImage: true, async: true,
    }, true);
    assert.equal(incompatibleOptions.diagnostics[0].code, 'E_PREVIEW_IMAGE_ASYNC');
    const invalid = await call('export_prototype', { rp: 'plain.rp' }, true);
    assert.equal(invalid.diagnostics[0].code, 'E_HTML_RP');
    assert.match(invalid.diagnostics[0].nextAction, /generate_prototype/);
    const protectedInput = await call('export_prototype', { rp: 'protected.rp' }, true);
    assert.match(protectedInput.diagnostics[0].message, /受保护/);
    assert(!existsSync(join(work, 'protected-html')));
    mkdirSync(join(work, 'probe-html'));
    writeFileSync(join(work, 'probe-html', 'sentinel.txt'), 'preserve');
    const occupied = await call('export_prototype', { rp: 'probe.rp' }, true);
    assert.equal(occupied.diagnostics[0].code, 'E_HTML_OUTPUT_EXISTS');
    assert.equal(readFileSync(join(work, 'probe-html', 'sentinel.txt'), 'utf8'), 'preserve');
    const unavailable = await call('export_prototype', { rp: 'probe.rp', output: 'new-html' }, true);
    assert.equal(unavailable.stage, 'assembly');
    assert.equal(unavailable.rpVersion, 9);
    assert.match(unavailable.diagnostics[0].code, /^E_ASSEMBLY_(INSTALL|PLATFORM)$/);
    assert.match(unavailable.diagnostics[0].nextAction, /runtime_info/);
    assert(!existsSync(join(work, 'new-html')));
  }, { AXURE_APP_RP9: missingInstallation });
});

function runBrowser(work, scenario, html, expected) {
  const args = [join(root, 'tools/native-assembly/browser-check.mjs'), scenario, html];
  if (expected !== undefined) args.push(expected);
  const raw = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 45_000 });
  writeFileSync(join(work, `browser-${scenario}.json`), raw);
  return JSON.parse(raw);
}

test('RP/1 recipe → native RP9 → official HTML → real browser', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ client, call, work }) => {
    const { recipes } = await call('prototype_recipe', { recipe: 'native-gestures' });
    const action = recipes[0].generate;
    const response = await client.callTool({ name: action.tool, arguments: { ...action.arguments, includeImage: true } },
      undefined, { timeout: 180_000 });
    assert.ok(!response.isError, response.content[0].text);
    const generated = response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.equal(generated.previewImage, 'attached');
    const image = response.content.find(part => part.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(image.data, 'base64'), readFileSync(generated.contactSheet));
    assert.equal(generated.verification.structure, true);
    const before = hash(generated.output);
    const exportAction = generated.nextActions.find(next => next.tool === 'export_prototype');
    const exported = await call(exportAction.tool, exportAction.arguments);
    assert.equal(exported.rpVersion, 9);
    assert.equal(exported.axureBuild, '9.0.0.3754');
    assert.equal(exported.entry, join(exported.output, 'start.html'));
    assert(existsSync(join(exported.output, 'data/document.js')));
    assert.deepEqual(exported.verification, { officialHtmlExported: true, browserLoaded: false, behaviorVerified: false });
    assert.equal(hash(generated.output), before);
    writeFileSync(join(work, 'export.json'), JSON.stringify(exported, null, 2) + '\n');
    assert(browserModule, 'Set PLAYWRIGHT_MODULE to run the native browser acceptance.');
    assert.equal(runBrowser(work, 'rp1-native', exported.output).assertions.length, 10);
  });
});

test('existing RP11 → official HTML → native textbox behavior', {
  skip: (!verifyHost || !process.env.AXURE_MCP_EXPORT_RP11) && 'Provide a verified RP11 textbox fixture with maxlength=7.',
}, async () => {
  await session(async ({ call, work }) => {
    const source = resolve(process.env.AXURE_MCP_EXPORT_RP11);
    const localCopy = join(work, 'input-rp11.rp');
    writeFileSync(localCopy, readFileSync(source), { flag: 'wx' });
    const before = hash(localCopy);
    const exported = await call('export_prototype', { rp: localCopy, output: 'rp11-html' });
    assert.equal(exported.rpVersion, 11);
    assert.equal(exported.axureBuild, '11.0.0.4137');
    assert.equal(hash(localCopy), before);
    assert(existsSync(exported.entry));
    writeFileSync(join(work, 'export.json'), JSON.stringify(exported, null, 2) + '\n');
    assert(browserModule, 'Set PLAYWRIGHT_MODULE to run the native browser acceptance.');
    assert.equal(runBrowser(work, 'maxlength', exported.output, '7').assertions.length, 2);
  });
});

test('STO scanner decodes official data without executing JavaScript and preserves Case coordinates', async () => {
  const { decodeAxureData, scanOfficialInteractions } = await import('../scripts/official-interactions.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'zee-sto-data-'));
  const page = join(dir, 'files', 'calculator');
  mkdirSync(page, { recursive: true });
  const literal = { exprType: 'stringLiteral', value: '[[2+]]', stos: [{ sto: 'error' }] };
  const encoded = `$axure.loadCurrentPage(
(function() {
    var _ = function() { throw new Error("must never execute"); }
    var _creator = function() { return _(a,_(b,c,d,_(e,_(f,[_(g,h,i,[_(j,_(k,l,m,n,o,[_(p,q)]))])]))),r,s); };
    var a="page",b="name",c="Calculator",d="interactionMap",e="onClick",f="cases",g="description",h="Compute",i="actions",j="expr",k="exprType",l="stringLiteral",m="value",n="[[2+]]",o="stos",p="sto",q="error",r="generationDate",s=new Date(2);
return _creator();
})());`;
  const file = join(page, 'data.js');
  try {
    writeFileSync(file, encoded);
    assert.deepEqual(decodeAxureData(encoded).page.interactionMap.onClick.cases[0].actions[0].expr, literal);
    const report = scanOfficialInteractions(dir);
    assert.equal(report.status, 'failed');
    assert.equal(report.errorCount, 1);
    assert.deepEqual(report.diagnostics.map(d => [d.page, d.event, d.case, d.actionIndex, d.expression]),
      [['Calculator', 'onClick', 'Compute', 1, '[[2+]]']]);
    writeFileSync(file, encoded.replace('s=new Date(2)', 's=process.exit(1)'));
    assert.equal(scanOfficialInteractions(dir).status, 'incomplete');
    assert.equal(scanOfficialInteractions(dir).errorCount, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('static STO lint pinpoints wrappers, binding aliases, coercion and dead cases', async () => {
  const { lintExpression, summarizeCaseGroups } = await import('../scripts/interaction-lint.mjs');
  const codes = (expression, opts) => lintExpression(expression, opts).map(d => d.code);
  assert.deepEqual(codes('[[1 + 2'), ['E_AXURE_EXPRESSION_WRAPPER']);
  assert.deepEqual(codes('[["1" + "8"]]'), ['W_AXURE_PLUS_COERCION']);
  assert.deepEqual(codes('[[a * 1 + b * 1]]', { bindings: { a: true, b: true }, checkIdentifiers: true }), []);
  assert.deepEqual(codes('[[Value * Missing]]', { bindings: { value: true }, checkIdentifiers: true }),
    ['W_AXURE_BINDING_CASE', 'W_AXURE_UNKNOWN_IDENTIFIER']);
  assert(codes('[[Math.round((a * 1 + b * 1) * 100000000) / 100000000]]').includes('E_AXURE_STO_MATH_NAMESPACE'));
  assert.deepEqual(codes('[[Math.abs(-2)]]'), []);
  assert.deepEqual(codes('[[Math.round(2.25)]]', { version: 11 }), []);
  const when = { left: { variable: 'x' }, op: '==', right: 'ready' };
  const summary = summarizeCaseGroups([
    { when }, { when: { ...when } }, {}, { when }, { when, isNewIfGroup: true },
    { when: { op: '&&', left: when, right: { ...when, right: 'done' } } },
  ]);
  assert.deepEqual(summary.groups.map(g => g.cases.map(c => c.role)), [['if', 'else-if', 'else', 'else-if'], ['if', 'else-if']]);
  assert.deepEqual(summary.diagnostics.map(d => d.code),
    ['W_AXURE_DUPLICATE_CONDITION', 'W_AXURE_UNREACHABLE_CASE', 'W_AXURE_CONTRADICTORY_CASE']);
});

test('native authoring rejects STO before commit and reuses unchanged tests on a nameless RP9 copy', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  const { addInteractions, loadBaselineMap, resolveBaselineTarget } = await import('../scripts/ix-actions.mjs');
  await session(async ({ call, work }) => {
    const source = await call('generate_prototype', { recipe: 'native-loop', output: 'loop.rp' });
    const original = hash(source.output);
    const formula = '[[Math.round((a * 1 + b * 1) * 100000000) / 100000000]]';
    const makeInteraction = expression => [{
      event: 'OnClick',
      cases: [{ description: '舍入分支', condition: 'always', actions: [{ type: 'set-text', target: 'loop/out', text: expression }] }],
    }];
    const proposed = { source: 'loop.rp', output: 'candidate.rp', target: { logicalId: 'loop/evaluate' },
      replaceEvent: true, interactions: makeInteraction(formula) };
    const checked = await call('rp_command', { command: 'add-interaction', params: proposed }, true);
    assert.equal(checked.code, 'E_INTERACTION_PREFLIGHT');
    assert.equal(checked.diagnostics[0].code, 'E_AXURE_STO_MATH_NAMESPACE');
    const oracle = await call('rp_command', { command: 'add-interaction', action: 'preflight',
      params: { ...proposed, preflight: 'official' } }, true);
    assert.equal(oracle.official.errorCount, 1);
    assert.deepEqual(oracle.official.diagnostics.map(d => [d.logicalId, d.event, d.case, d.actionIndex, d.expression]),
      [['loop/evaluate', 'OnClick', '舍入分支', 1, formula]]);
    assert(!existsSync(join(work, 'candidate.rp')));
    assert.equal(hash(source.output), original);
    const missing = await call('rp_command', { command: 'add-interaction', action: 'preflight', params: {
      ...proposed, preflight: 'static', target: { logicalId: 'loop/missing', page: '循环求值' },
      interactions: makeInteraction('正常文字'),
    } }, true);
    assert.equal(missing.code, 'E_AXURE_INTERACTION_TARGET');

    const oldBaseline = loadBaselineMap(source.output);
    const legacy = addInteractions(readFileSync(source.output), resolveBaselineTarget('loop/evaluate', oldBaseline),
      [{ event: 'OnClick', cases: [{ description: '旧文件中的失败', actions: [{
        type: 'set-text', target: resolveBaselineTarget('loop/out', oldBaseline), text: formula,
      }] }] }], { replaceEvent: true });
    writeFileSync(join(work, 'legacy.rp'), legacy.file);
    const exported = await call('export_prototype', { rp: 'legacy.rp', baseline: source.baseline });
    assert.equal(exported.interactionCompilation.errorCount, 1);
    const failed = await call('verify_prototype', { html: exported.output, engine: 'official' }, true);
    assert.equal(failed.stage, 'interaction-compilation');
    assert.equal(failed.diagnostics[0].case, '旧文件中的失败');
    assert.equal(failed.verification.browserLoaded, false);

    await call('axure_open', { path: 'loop.rp' });
    const saved = await call('axure_save', { as: 'nameless.rp', stripWidgetNames: true });
    assert(saved.strippedWidgetNames > 0);
    const native = await call('rp_inspect', { view: 'overview', path: 'nameless.rp' });
    assert(native.pages.every(p => p.namedWidgets === 0));
    const lint = await call('rp_inspect', { view: 'interaction-lint', path: 'nameless.rp' });
    assert.equal(lint.variables.find(v => v.name === 'product')?.status, 'read-write');
    assert(lint.events.some(e => e.groups[0].cases.some(c => c.role === 'else-if' || c.role === 'else')));
    const id = await call('rp_inspect', { view: 'widget', path: 'nameless.rp', target: { logicalId: 'loop/out' } });
    const targetGuid = id.widget?.guid ?? id.guid ?? id.target?.guid;
    assert.match(targetGuid, /^[0-9a-f]{32}$/);

    const patched = await call('rp_patch', { source: 'nameless.rp', output: 'patched.rp',
      target: { logicalId: 'loop/out' }, text: '等待输入' });
    assert(existsSync(patched.baseline));
    const html = await call('export_prototype', { rp: 'patched.rp' });
    const steps = [{ action: 'expect', target: { guid: targetGuid }, expect: { text: '等待输入' } }, ...source.verifySteps];
    assert.equal((await call('verify_prototype', { html: html.output, engine: 'official', steps })).passed, steps.length);

    const fix = await call('rp_command', { command: 'add-interaction', params: { ...proposed, source: 'nameless.rp',
      interactions: makeInteraction('[[(0.1 + 0.2).toFixed(8) * 1]]') } });
    assert.equal(fix.official.status, 'passed');
    const repaired = await call('verify_prototype', { rp: fix.output, engine: 'official', steps: [
      { action: 'click', target: { logicalId: 'loop/evaluate' } },
      { action: 'expect', target: { guid: targetGuid }, expect: { text: '0.3' } },
    ] });
    assert.equal(repaired.passed, 2);
    const badOption = await call('export_prototype', { rp: fix.output, overwrite: true }, true);
    assert.equal(badOption.diagnostics[0].pointer, '/arguments/overwrite');
    assert.match(badOption.diagnostics[0].nextAction, /verify_prototype/);
  });
});

test('declarative programs run calculator, timer, bounded loop and blur form flows in official RP9', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call }) => {
    for (const recipe of ['native-calculator', 'native-countdown', 'native-loop', 'native-blur-form']) {
      const generated = await call('generate_prototype', { recipe, output: `${recipe}.rp`, verify: true });
      assert(existsSync(generated.interactionSource));
      assert(generated.nativeProgram.callbackCount > 0);
      assert.equal(generated.behaviorVerification.interactionCompilation.status, 'passed');
      assert.equal(generated.behaviorVerification.passed, generated.verifySteps.length);
    }
  });
});

test('inline program publishes editable layout and retained verification steps', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call }) => {
    const result = await call('generate_prototype', {
      output: 'inline-program.rp',
      rp1: 'rp/1 target=9 name="测试" domain=web theme=enterprise-light\n' +
        'page #demo canvas=[360,240]\n  box #root [360x240] layout=stack\n' +
        '    button #run "运行" [104x42] x=12 y=20\n    label #out "初始" [160x34] x=12 y=80\n',
      program: { page: 'demo', on: { run: { click: [{ call: 'finish' }] } },
        routines: { finish: [{ set: { '@out': '已完成' } }] } },
      verifySteps: [{ action: 'click', target: 'demo/run' }, { action: 'expect', target: 'demo/out', expect: { text: '已完成' } }],
    });
    assert.equal(result.nativeProgram.callbackCount, 0);
    assert.equal(result.interactionSource, result.source + '.interactions.json');
    assert.deepEqual(JSON.parse(readFileSync(result.interactionSource)).steps, result.verifySteps);
    const verified = await call('verify_prototype', { engine: 'official', rp: result.output });
    assert.equal(verified.passed, 2);
  });
});

test('three advanced pages compile in one RP9 and each uses at most one dispatcher', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call, work }) => {
    const names = ['native-calculator', 'native-countdown', 'native-blur-form'];
    const layouts = names.map(name => readFileSync(join(root, 'examples/authoring', name + '.rp1'), 'utf8').split('\n').slice(1).join('\n'));
    const plans = names.map(name => JSON.parse(readFileSync(join(root, 'examples/authoring', name + '.rp1.interactions.json'), 'utf8')));
    const programs = plans.map(p => p.program);
    const steps = plans.flatMap((p, index) => [...(index ? [{ action: 'navigate', page: p.program.page }] : []), ...p.steps]);
    const layoutFile = join(work, 'lab.rp1');
    writeFileSync(layoutFile, 'rp/1 target=9 name="多页交互" domain=web theme=enterprise-light\n' + layouts.join('\n'));
    writeFileSync(layoutFile + '.interactions.json', JSON.stringify({ programs, steps }));
    const generated = await call('generate_prototype', { source: layoutFile, output: 'lab.rp', verify: true });
    assert.deepEqual(generated.nativeProgram.pages.map(p => p.callbackCount), [1, 1, 1]);
    assert.deepEqual(generated.nativeProgram.pages.map(p => p.unoptimizedCallbackCount), [26, 2, 4]);
    assert.equal(generated.behaviorVerification.passed, steps.length);
    assert.equal(generated.behaviorVerification.total, 63);
  });
});

test('patching a standalone RP9 template keeps native events and isolates reentrant async routines', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call, work }) => {
    const rp1 = `rp/1 target=9 name="课程模板" domain=web theme=enterprise-light
page #alpha name="Alpha" canvas=[380,280]
  box #root [380x280] layout=stack
    button #start_a "运行 A" [104x40] x=20 y=32
    button #start_b "运行 B" [104x40] x=146 y=32
    label #out "就绪" [235x46] x=20 y=98
    label #original "原界面" [163x40] x=20 y=164
page #beta name="Beta" canvas=[380,280]
  box #root [380x280] layout=stack
    button #apply "运行" [102x40] x=20 y=32
    label #result "就绪" [235x46] x=20 y=98
page #gamma name="Gamma" canvas=[380,280]
  box #root [380x280] layout=stack
    button #apply "运行" [102x40] x=20 y=32
    label #result "就绪" [235x46] x=20 y=98
    label #original "原界面" [163x40] x=20 y=164
`;
    const originalLoad = { $page: { load: [{ set: { '@original': '原载入已运行' } }] } };
    const generated = await call('generate_prototype', { rp1, output: 'teacher-source.rp',
      programs: ['alpha', 'gamma'].map(page => ({ page, on: originalLoad })),
    });
    const source = join(work, 'teacher.rp');
    writeFileSync(source, readFileSync(generated.output));
    const original = hash(source);
    const guidFor = async (page, query) => {
      const result = await call('rp_inspect', { view: 'locate', path: source, page, query });
      assert.equal(result.total, 1);
      return { guid: result.candidates[0].guid };
    };
    const local = { tag: { type: 'text', value: '' }, count: { type: 'number', value: 0 } };
    const programs = [
      { page: 'Alpha', targets: { a: await guidFor('Alpha', '运行 A'), b: await guidFor('Alpha', '运行 B'),
        out: await guidFor('Alpha', '就绪'), original: await guidFor('Alpha', '原界面') }, locals: local,
      bind: [{ targets: { a: 'A', b: 'B' }, variable: '$tag', call: 'process' }],
      routines: { process: [{ set: { '$count': 0 } }, {
        while: '$count < 48', limit: 64, intervalMs: 250,
        do: [{ set: { '$count': '=$count + 1' } }, { call: 'publish' }],
      }] } },
      { page: 'Beta', targets: { apply: await guidFor('Beta', '运行'), out: await guidFor('Beta', '就绪') }, locals: local,
        on: { apply: { click: [{ set: { '$tag': 'Beta', '$count': 0 } },
          { repeat: 48, limit: 64, do: [{ set: { '$count': '=$count + 1' } }], then: [{ call: 'publish' }] },
        ] } } },
      { page: 'Gamma', targets: { apply: await guidFor('Gamma', '运行'), out: await guidFor('Gamma', '就绪'),
        original: await guidFor('Gamma', '原界面') }, locals: local,
        on: { apply: { click: [{ set: { '$tag': 'Gamma', '$count': 0 } },
          { repeat: 2, do: [{ set: { '$count': '=$count + 1' } }], then: [{ call: 'publish' }] },
        ] } } },
    ];
    const params = { source, output: 'teacher-filled.rp', programs,
      sharedRoutines: { publish: [{ set: { '@out': "=concat($tag, ':', text($count))" } }] }, preflight: 'official' };
    const dry = await call('rp_command', { action: 'preflight', command: 'add-interaction', params });
    assert.equal(dry.dryRun, true);
    assert.equal(existsSync(join(work, 'teacher-filled.rp')), false);
    const patch = await call('rp_command', { command: 'add-interaction', params });
    assert.equal(patch.official.status, 'passed');
    assert.deepEqual(patch.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    assert.deepEqual(patch.nativeProgram.pages.map(p => [p.asyncLoopCount, p.callbackCount]), [[1, 1], [1, 1], [0, 1]]);
    assert.equal(hash(source), original);
    const steps = [
      { action: 'expect', target: 'Alpha/original', expect: { text: '原载入已运行' } },
      { action: 'click', target: 'Alpha/a' }, { action: 'advanceTime', ms: 250 },
      { action: 'expect', target: 'Alpha/out', expect: { text: 'A:1' } },
      { action: 'click', target: 'Alpha/b' }, { action: 'advanceTime', ms: 12000 },
      { action: 'expect', target: 'Alpha/out', expect: { text: 'A:48' } },
      { action: 'click', target: 'Alpha/b' }, { action: 'advanceTime', ms: 12250 },
      { action: 'expect', target: 'Alpha/out', expect: { text: 'B:48' } },
      { action: 'navigate', page: 'Beta' }, { action: 'click', target: 'Beta/apply' },
      { action: 'expect', target: 'Beta/out', expect: { text: 'Beta:48' } },
      { action: 'navigate', page: 'Gamma' },
      { action: 'expect', target: 'Gamma/original', expect: { text: '原载入已运行' } },
      { action: 'click', target: 'Gamma/apply' },
      { action: 'expect', target: 'Gamma/out', expect: { text: 'Gamma:2' } },
    ];
    const verified = await call('verify_prototype', { rp: patch.output, engine: 'official', steps });
    assert.equal(verified.passed, steps.length);
    const replay = await call('rp_command', { command: 'add-interaction',
      params: { ...params, source: patch.output, output: 'teacher-filled-again.rp', replaceEvent: true, preflight: 'static' } });
    assert.equal(replay.before.widgets, replay.after.widgets);
    assert.equal(replay.before.interactions, replay.after.interactions);
    const repeated = await call('verify_prototype', { rp: replay.output, engine: 'official', steps });
    assert.equal(repeated.passed, steps.length);
  });
});

test('same-page native tasks restart and cancel without resuming an old continuation', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call, work }) => {
    const recipe = 'native-async-tasks';
    const generated = await call('generate_prototype', { recipe, output: 'async-tasks.rp', verify: true });
    assert.equal(generated.nativeProgram.callbackCount, 1);
    assert.equal(generated.nativeProgram.asyncLoopCount, 2);
    assert.deepEqual(generated.nativeProgram.tasks, [
      { name: 'timerA', policy: 'restart' }, { name: 'timerB', policy: 'ignore' },
    ]);
    assert.equal(generated.behaviorVerification.passed, generated.verifySteps.length);
    assert.equal(generated.behaviorVerification.interactionCompilation.errorCount, 0);
    const { program, steps } = JSON.parse(readFileSync(generated.interactionSource, 'utf8'));
    const layout = await call('generate_prototype', {
      rp1: readFileSync(join(root, 'examples/authoring', recipe + '.rp1'), 'utf8'),
      output: 'existing-timer-layout.rp',
      program: { page: 'tasks', on: { $page: { load: [{ set: { '@title': '已有载入事件' } }] } } },
    });
    const patch = await call('rp_command', { command: 'add-interaction', params: {
      source: layout.output, output: 'patched-async-tasks.rp', preflight: 'official', program,
    } });
    assert.equal(patch.official.status, 'passed');
    assert.deepEqual(patch.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    assert.equal(patch.nativeProgram.pages[0].callbackCount, 1);
    const patchSteps = [{ action: 'expect', target: 'tasks/title', expect: { text: '已有载入事件' } }, ...steps];
    const replay = await call('verify_prototype', { rp: patch.output, engine: 'official', steps: patchSteps });
    assert.equal(replay.passed, patchSteps.length);
    const updated = await call('rp_command', { command: 'add-interaction', params: {
      source: patch.output, output: 'updated-async-tasks.rp', replaceEvent: true, preflight: 'static', program,
    } });
    assert.equal(updated.after.widgets, updated.before.widgets);
    assert.equal(updated.after.interactions, updated.before.interactions);
    const reopened = await call('rp_inspect', { path: updated.output, view: 'interactions', page: '并行倒计时' });
    const pageEvents = reopened.items.find(item => item.kind === 'page').interactions;
    const load = pageEvents.find(ix => ix.event === 'OnLoad');
    assert.equal(load.cases.length, 2);
    if (evidence) {
      writeFileSync(join(work, 'generated-verification.json'), JSON.stringify(generated.behaviorVerification, null, 2) + '\n');
      writeFileSync(join(work, 'patched-verification.json'), JSON.stringify(replay, null, 2) + '\n');
    }
  });
});
