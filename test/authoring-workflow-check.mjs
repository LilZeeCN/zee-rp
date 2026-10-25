// Real stdio, original-file preservation, native readback, and actionable diagnostics.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.env.AXURE_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.env.AXURE_AUTHORING_OUTPUT;
const work = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'zee-authoring-'));
if (keep) mkdirSync(work, { recursive: false });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
  env: { ...process.env, AXURE_WRITE_ROOT: work, AXURE_PROTECTED_PATHS: join(work, 'protected.rp') }, stderr: 'pipe' });
const client = new Client({ name: 'authoring-acceptance', version: '1.0.0' });
const results = [], calls = [];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const generated = {};
async function request(name, input, fail = false) {
  const start = performance.now();
  const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 120000 });
  const value = response.structuredContent ?? JSON.parse(response.content[0].text);
  calls.push({ name, durationMs: Math.round(performance.now() - start), error: Boolean(response.isError), bytes: Buffer.byteLength(JSON.stringify(value)) });
  if (fail) assert(response.isError, JSON.stringify(value));
  else assert(!response.isError, JSON.stringify(value));
  return value;
}
async function check(name, action) {
  try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}
const native = async path => JSON.parse((await request('rp_read', { args: [path, '--json'] })).stdout);
const nodes = rp => [...rp.pages.flatMap(p => p.widgets), ...(rp.containedWidgets ?? [])];

try {
  await client.connect(transport);
  await check('activity identity matches initialization and reports a stable implementation/schema fingerprint', async () => {
    const info = await request('runtime_info', {});
    assert.equal(info.version, JSON.parse(readFileSync(join(root, 'package.json'))).version);
    assert.equal(client.getServerVersion().version, info.version);
    assert.equal(info.fingerprint, info.diskFingerprint); assert.equal(info.restartRequired, false);
    assert.match(info.toolSchemaHash, /^[a-f0-9]{64}$/);
    const tools = (await client.listTools()).tools;
    assert.equal(info.toolCount, tools.length);
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    for (const name of ['list_custom_styles', 'rename_custom_style', 'rebind_widgets']) assert(tools.some(t => t.name === name));
    assert(tools.find(t => t.name === 'diagnose_prototype').annotations.readOnlyHint);
    assert.equal(tools.find(t => t.name === 'revise_prototype').annotations.readOnlyHint, false);
  });
  await check('recipe discovery provides three complete scenarios without expanding source by default', async () => {
    const found = await request('prototype_recipe', {});
    assert.equal(found.recipes.length, 3);
    assert(found.recipes.every(r => existsSync(r.source) && r.scenario && r.customize.length));
    assert(!JSON.stringify(found).includes('sourceText'));
  });
  for (const recipe of ['mobile-cards', 'list-detail', 'step-form']) {
    await check(`${recipe}: one call creates an editable project and its independent authoring source`, async () => {
      const r = generated[recipe] = await request('generate_prototype', { recipe, output: `${recipe}.rp`, strictAudit: true });
      assert.equal(r.status, 'completed'); assert.equal(r.audit.warningCount, 0);
      assert.equal(r.verification.structure, true); assert.equal(r.verification.preview, false);
      assert.equal(r.artifacts, undefined); assert.equal(r.statePreviews, undefined);
      assert(existsSync(r.source) && existsSync(r.baseline) && existsSync(r.report));
      assert(r.source.startsWith(work));
      assert(Object.values(r.previews).every(existsSync));
      const baseline = JSON.parse(readFileSync(r.baseline));
      assert.equal(baseline.sourcePath, r.source); assert.equal(baseline.sourceSha256, hash(r.source));
      assert.equal((await request('sync_prototype', { mode: 'status', rp: r.output, source: r.source })).nativeChanged, false);
      const rp = await native(r.output); assert.equal(rp.counts.problems, 0); assert.equal(rp.counts.danglingRefs, 0);
    });
  }
  await check('binding explanation uses complete expressions, emitted refresh events, and explicit evidence boundaries', async () => {
    const r = await request('explain_binding', { source: generated['mobile-cards'].source, target: 'stats/progress' });
    assert.equal(r.evidence, 'compiled-static'); assert.equal(r.nativePreviewObserved, false);
    const binding = r.bindings[0]; assert.deepEqual(binding.dependencies.variables, ['done']);
    assert.equal(binding.presentation.stepPercent, 10); assert.equal(binding.initialValue, 0);
    assert(binding.refreshEvents.some(e => e.event === 'OnLoad' && e.page === 'stats'));
    assert(binding.refreshEvents.some(e => e.event === 'OnClick'));
    await request('explain_binding', { source: generated['mobile-cards'].source, target: 'progress' }, true);
  });
  await check('binding explanation includes every expression dependency and the second variable refresh', async () => {
    const source = { language: 'rp/1', variables: { done: 2, bonus: 1 }, pages: [{ id: 'home', root: { type: 'box', id: 'root', children: [
      { type: 'progress-bar', id: 'progress', label: '进度', value: '=var.done + var.bonus', max: 10, w: 320 },
      { button: 'bonus', text: '奖励', onClick: { set: { '$bonus': 3 } } },
    ] } }] };
    const r = await request('explain_binding', { source, target: 'home/progress' });
    assert.deepEqual(r.bindings[0].dependencies.variables, ['bonus', 'done']);
    assert.equal(r.bindings[0].initialValue, 30);
    assert(r.bindings[0].refreshEvents.some(e => e.event === 'OnClick'));
  });
  await check('independent diagnostic roots are batched, limited, contextual, and do not alter source', async () => {
    const spec = { language: 'rp/1', pages: [{ id: 'home', name: '首页', root: { type: 'box', id: 'root', children: [
      { type: 'labell', id: 'a', bad: 1 }, { label: 'b', text: 'B', h: 0 }, { label: 'c', text: 'C', fontsize: 16 },
    ] } }] };
    const before = JSON.stringify(spec);
    const r = await request('diagnose_prototype', { source: spec }, true);
    assert.equal(JSON.stringify(spec), before);
    assert.deepEqual(r.diagnostics.map(d => d.code), ['E_NODE_TYPE', 'E_SIZE', 'E_PROPERTY']);
    assert.equal(r.dependentChecksComplete, false);
    assert.equal(r.diagnostics[1].actual, 0); assert.equal(r.diagnostics[1].pageName, '首页');
    const fix = r.diagnostics[2].candidatePatches[0]; assert(fix.requiresReview); assert.equal(fix.validation, 'not-applied');
    assert.equal(fix.operations[0].oldValue, 16);
    const limited = await request('diagnose_prototype', { source: spec, limit: 2 }, true);
    assert.equal(limited.total, 3); assert.equal(limited.diagnostics.length, 2); assert(limited.truncated);
  });
  await check('text source diagnostics retain line, snippet and author-facing macro call location', async () => {
    const path = join(work, 'invalid.rp1');
    const text = readFileSync(generated['mobile-cards'].source, 'utf8').replace('fontSize=24', 'fontsize=24');
    assert.notEqual(text, readFileSync(generated['mobile-cards'].source, 'utf8'));
    writeFileSync(path, text);
    const r = await request('diagnose_prototype', { source: path }, true);
    assert(r.diagnostics[0].line > 0 && r.diagnostics[0].snippet.includes('fontsize'));
    const failed = await request('generate_prototype', { source: path, output: 'invalid.rp' }, true);
    assert(failed.diagnostics[0].line > 0 && failed.diagnostics[0].nextAction);
    assert(!existsSync(join(work, 'invalid.rp')));
  });
  await check('dry-run previews source/native merge impact without publishing outputs or changing originals', async () => {
    const r = generated['mobile-cards'], before = [hash(r.source), hash(r.output), hash(r.baseline)];
    const result = await request('revise_prototype', { source: r.source, rp: r.output, output: join(work, 'dry.rp'), dryRun: true,
      operations: [{ target: 'today/headline', property: 'text', value: '先完成最重要的一件事。' }] });
    assert.equal(result.status, 'planned'); assert(result.impact.affectedPages.includes('today'));
    assert.deepEqual([hash(r.source), hash(r.output), hash(r.baseline)], before);
    assert(!existsSync(join(work, 'dry.rp')) && !existsSync(join(work, 'dry.rp1')));
  });
  await check('source edit closes the loop with comments, stable IDs, live baseline and truthful verification', async () => {
    const r = generated['mobile-cards'];
    const result = await request('revise_prototype', { source: r.source, rp: r.output, output: join(work, 'revised.rp'),
      operations: [{ target: 'today/headline', property: 'text', value: '先完成最重要的一件事。' },
        { path: '/palette/brand', value: '#7256C8' }] });
    assert.equal(result.status, 'completed'); assert(result.impact.affectedPages.length >= 2);
    assert(readFileSync(result.source, 'utf8').includes('# 修改共享组件'));
    assert(nodes(await native(result.output)).some(w => w.text === '先完成最重要的一件事。'));
    const status = await request('sync_prototype', { mode: 'status', rp: result.output, source: result.source });
    assert.equal(status.nativeChanged, false); assert.equal(status.sourceChanged, false);
    assert.equal(result.verification.preview, false); assert(Object.values(result.previews).every(existsSync));
    generated.revised = result;
  });
  await check('numeric token edits update dependent properties and retain their source references', async () => {
    const source = join(work, 'tokens.json');
    const spec = { language: 'rp/1', domain: 'test', tokens: { font: { title: 24 } }, pages: [{ id: 'home', canvas: [420, 160],
      root: { type: 'box', id: 'root', w: 420, h: 160, padding: 24, children: [
        { label: 'title', text: '共享字号', fontSize: '$font.title', w: 350, h: 44 },
      ] } }] };
    writeFileSync(source, JSON.stringify(spec));
    const initial = await request('generate_prototype', { source, output: join(work, 'tokens.rp') });
    const revised = await request('revise_prototype', { source, rp: initial.output, output: join(work, 'tokens-v2.rp'),
      operations: [{ path: '/tokens/font/title', value: 22 }] });
    const after = JSON.parse(readFileSync(revised.source));
    assert.equal(after.tokens.font.title, 22); assert.equal(after.pages[0].root.children[0].fontSize, '$font.title');
    assert.equal(revised.restoredTokenReferences, 1); assert(revised.impact.affectedPages.includes('home'));
    const r = await request('inspect', { path: revised.output, target: { name: 'title', page: 'home' } });
    assert.equal(r.richText.paragraphs[0].runs[0].size, 16.5); // RP stores 22 CSS px as 16.5 pt.
  });
  await check('native text drift and a separate source edit are both preserved in one revision', async () => {
    const r = generated['mobile-cards'];
    await request('axure_open', { path: r.output });
    await request('edit_text', { target: { name: 'headline', page: '今日复习' }, text: 'Axure 侧保留的改稿' });
    const saved = await request('axure_save', { as: join(work, 'native-edited.rp') });
    const edited = saved.physicalPath;
    assert(existsSync(`${edited}.baseline.json`));
    const merged = await request('revise_prototype', { source: r.source, rp: edited, output: join(work, 'both.rp'),
      operations: [{ target: 'today/intro', property: 'text', value: '源码侧新说明' }] });
    const texts = nodes(await native(merged.output)).map(w => w.text);
    assert(texts.includes('Axure 侧保留的改稿') && texts.includes('源码侧新说明'));
    const source = readFileSync(merged.source, 'utf8'); assert(source.includes('Axure 侧保留的改稿') && source.includes('源码侧新说明'));
    generated.native = { path: edited, original: r };
  });
  await check('same-property conflict, stale state and invalid patch preserve inputs and publish no half-result', async () => {
    const { path, original: r } = generated.native;
    const before = [hash(path), hash(r.source)];
    const conflict = await request('revise_prototype', { source: r.source, rp: path, output: join(work, 'conflict.rp'),
      operations: [{ target: 'today/headline', property: 'text', value: '另一份冲突修改' }] }, true);
    assert.equal(conflict.status, 'conflict'); assert(!existsSync(join(work, 'conflict.rp')));
    await request('revise_prototype', { source: r.source, rp: path, output: join(work, 'stale.rp'), expectedRpSha256: '0'.repeat(64),
      operations: [{ target: 'today/intro', property: 'text', value: 'stale' }] }, true);
    await request('revise_prototype', { source: r.source, rp: path, output: join(work, 'invalid-patch.rp'),
      operations: [{ target: 'today/headline', property: 'h', value: 0 }] }, true);
    assert(!existsSync(join(work, 'invalid-patch.rp1')) && !existsSync(join(work, 'invalid-patch.rp')));
    assert.deepEqual([hash(path), hash(r.source)], before);
  });
  await check('recovery does not turn dependent failures into success or noisy parent cascades', async () => {
    const spec = { language: 'rp/1', pages: [{ id: 'home', root: { type: 'box', id: 'root', children: [
      { label: 'bad', text: { fn: 'not-a-function', args: [] } }, { label: 'badSize', text: 'a', w: -1 },
    ] } }] };
    const result = await request('diagnose_prototype', { source: spec }, true);
    assert.equal(result.ok, false); assert(result.diagnostics.every(d => !d.pointer.includes('diagnostic-stub')));
  });
  await check('runtime detects changed disk in an isolated checkout, without editing the working implementation', async () => {
    const isolated = join(work, 'isolated'); mkdirSync(isolated);
    for (const dir of ['scripts', 'bin']) cpSync(join(root, dir), join(isolated, dir), { recursive: true });
    cpSync(join(root, 'package.json'), join(isolated, 'package.json'));
    const code = `import {runtimeInfo} from ${JSON.stringify('file://' + join(isolated, 'scripts/authoring-workflow.mjs'))};
      import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(isolated, 'scripts/fingerprint-probe.py'))},'# probe');
      console.log(JSON.stringify(runtimeInfo([])));`;
    const proc = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    const info = JSON.parse(proc.stdout); assert(info.restartRequired); assert(info.changedFiles.includes('scripts/fingerprint-probe.py'));
    rmSync(isolated, { recursive: true, force: true });
  });
  await check('missing image dependencies report the active interpreter and a concrete next action', async () => {
    const bin = join(work, 'fake-python-bin'); mkdirSync(bin);
    const stub = { executable: '/isolated/python3', version: '3.14', imageModules: { PIL: true, numpy: false, scipy: false }, missingImageDependencies: ['numpy', 'scipy'] };
    writeFileSync(join(bin, 'python3'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(stub))});\n`, { mode: 0o755 });
    const t = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AXURE_WRITE_ROOT: work }, stderr: 'pipe' });
    const c = new Client({ name: 'dependency-diagnostic-check', version: '1.0.0' });
    try {
      await c.connect(t);
      const raw = await c.callTool({ name: 'generate_from_image', arguments: { image: generated['mobile-cards'].previews.today, output: join(work, 'missing-deps.rp') } });
      assert(raw.isError); const r = raw.structuredContent;
      assert.equal(r.code, 'E_IMAGE_DEPENDENCY'); assert.equal(r.diagnostics[0].actual.executable, '/isolated/python3');
      assert(r.diagnostics[0].nextAction.includes('requirements.txt')); assert(!existsSync(join(work, 'missing-deps.rp')));
    } finally { await c.close(); rmSync(bin, { recursive: true, force: true }); }
  });
  await check('conflicting patch addressing and missing properties are rejected before publishing', async () => {
    const r = generated['mobile-cards'];
    for (const operation of [
      { target: 'today/headline', path: '/name', property: 'text', value: 'ambiguous' },
      { target: 'today/headline', value: 'missing property' },
    ]) {
      const result = await request('revise_prototype', { source: r.source, rp: r.output, output: join(work, 'bad-address.rp'), operations: [operation] }, true);
      assert.equal(result.diagnostics[0].code, 'E_PATCH');
      assert(!existsSync(join(work, 'bad-address.rp')));
    }
  });
} finally {
  await client.close();
  const report = { evidence: 'real-stdio-with-native-readback', results, calls,
    measurements: { scope: 'tool-execution-only', documentationReads: null, modelTokens: null, nativePreview: 'separate-gui-evidence' }, generated };
  if (keep) writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  else rmSync(work, { recursive: true, force: true });
}
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ total: results.length, passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
