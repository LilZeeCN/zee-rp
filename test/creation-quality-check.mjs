import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { reviewImageStructure } from '../scripts/image-structure.mjs';
import { previewMismatch, resolvePreviewSymbol } from '../scripts/preview-runtime.mjs';

const root = process.env.AXURE_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.env.AXURE_QUALITY_OUTPUT;
const work = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'zee-quality-'));
if (keep) mkdirSync(work);
const client = new Client({ name: 'creation-quality-acceptance', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')], env: { ...process.env, AXURE_WRITE_ROOT: work }, stderr: 'pipe' });
const results = [], calls = [];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function call(name, args, expectedError = false) {
  const raw = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const data = raw.structuredContent ?? JSON.parse(raw.content[0].text);
  calls.push({ name, args, isError: !!raw.isError });
  if (expectedError !== null) assert.equal(!!raw.isError, expectedError, JSON.stringify(data));
  return data;
}
async function check(name, action) {
  try { await action(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message); }
}
const nodes = data => [...data.pages.flatMap(p => p.widgets), ...(data.containedWidgets ?? [])];
const native = async path => JSON.parse((await call('rp_read', { file: path })).stdout);
async function finished(id) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const job = await call('jobs_get', { id }, null);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Generation job did not finish');
}
let current;
try {
  await client.connect(transport);
  await check('fresh MCP advertises real preview and read-only image structure review', async () => {
    const list = (await client.listTools()).tools;
    assert.equal(new Set(list.map(t => t.name)).size, list.length);
    assert.equal(list.find(t => t.name === 'review_image_structure').annotations.readOnlyHint, true);
    assert.equal(list.find(t => t.name === 'preview_prototype').annotations.readOnlyHint, false);
    assert.equal((await call('runtime_info', {})).toolCount, list.length);
  });
  await check('spec path matches advertised schema and async generation returns a queryable result', async () => {
    const source = join(root, 'examples/rp-language/mobile-layout.rp1');
    const started = performance.now();
    const job = await call('generate_prototype', { spec: source, output: join(work, 'async.rp'), async: true, strictAudit: true });
    assert.equal(job.type, 'generate-prototype'); assert.equal(job.status, 'queued');
    assert(performance.now() - started < 3000); assert.equal(job.input, undefined);
    const result = await finished(job.id);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result.verification.structure, true); assert(existsSync(result.result.baseline));
  });
  await check('async semantic failure remains structured and does not publish an output', async () => {
    const job = await call('generate_prototype', { spec: { language: 'rp/1', pages: [{ id: 'bad', root: { type: 'unknown-shape', id: 'bad' } }] },
      output: join(work, 'async-invalid.rp'), async: true });
    const result = await finished(job.id);
    assert.equal(result.status, 'failed'); assert.equal(result.result.diagnostics[0].code, 'E_NODE_TYPE');
    assert(!existsSync(join(work, 'async-invalid.rp')));
  });
  await check('queued input changes are refused and queued cancellation leaves no output', async () => {
    const blocker = await call('generate_prototype', { recipe: 'mobile-cards', output: join(work, 'blocker.rp'), async: true });
    const source = join(work, 'changing.rp1');
    writeFileSync(source, readFileSync(join(root, 'examples/rp-language/mobile-layout.rp1')));
    const stale = await call('generate_prototype', { source, output: join(work, 'stale-job.rp'), async: true });
    const cancelled = await call('generate_prototype', { source, output: join(work, 'cancel-job.rp'), async: true });
    writeFileSync(source, readFileSync(source, 'utf8') + '\n# Changed after submission\n');
    assert.equal((await call('jobs_cancel', { id: cancelled.id })).status, 'cancelled');
    assert.equal((await finished(blocker.id)).status, 'completed');
    const result = await finished(stale.id);
    assert.equal(result.status, 'failed'); assert.equal(result.result.diagnostics[0].code, 'E_STALE_JOB_INPUT');
    assert(!existsSync(join(work, 'stale-job.rp')) && !existsSync(join(work, 'cancel-job.rp')));
  });
  await check('image review finds repeated cards without moving or rewriting source', async () => {
    const children = [0, 1].flatMap(i => [
      { kind: 'rect', name: 'card' + i, x: 20, y: 20 + i * 160, w: 320, h: 144, fill: '#FFFFFF' },
      { kind: 'text', name: 'title' + i, x: 36, y: 36 + i * 160, w: 260, h: 28, size: 20, content: '标题' },
      { kind: 'text', name: 'body' + i, x: 36, y: 80 + i * 160, w: 260, h: 40, size: 14, content: '内容' },
    ]);
    children.push({ kind: 'image', name: 'photo', x: 20, y: 360, w: 80, h: 80, imageKey: 'test' });
    const spec = { frames: [{ w: 402, h: 874, children }] }, before = JSON.stringify(spec);
    const r = await call('review_image_structure', { spec });
    assert.equal(r.summary.groupCandidates, 2); assert.equal(r.summary.repeatedPatterns, 1);
    assert.equal(r.summary.rasterOnly, 1); assert.equal(r.nativeHierarchyChanged, false);
    assert.equal(JSON.stringify(spec), before); assert(r.groups.every(g => g.requiresReview));
    assert.equal(reviewImageStructure({ spec, limit: 1 }).truncated, true);
  });
  await check('preview resolution and assertions refuse ambiguous identity and observe actual zero', async () => {
    const map = { pages: [{ id: 'home', name: '首页' }], symbols: [{ id: 'home/title' }, { id: 'other/title' }] };
    assert.throws(() => resolvePreviewSymbol(map, 'title'), /重名/);
    assert.equal(resolvePreviewSymbol(map, 'home/title').id, 'home/title');
    assert.equal(previewMismatch({ expect: { variable: 'count', equals: 0 } }, { variables: { count: '0' } }, null, map).length, 0);
    assert.equal(previewMismatch({ expect: { variable: 'missing', equals: '' } }, { variables: {} }, null, map).length, 1);
  });
  await check('create baseline for consecutive source/native revision cycles', async () => {
    const source = join(work, 'initial.json');
    writeFileSync(source, JSON.stringify({ language: 'rp/1', domain: 'mobile', pages: [{ id: 'home', name: '首页', canvas: [402, 500],
      root: { type: 'box', id: 'root', layout: 'stack', w: 402, h: 500, children: [
        { label: 'headline', text: '原始标题', x: 24, y: 24, w: 320, h: 44, fontSize: 24 },
        { label: 'note', text: '说明', x: 24, y: 90, w: 320, h: 44, fontSize: 16 },
      ] } }] }));
    current = await call('generate_prototype', { source, output: join(work, 'round0.rp') });
  });
  await check('cycle 1 preserves native rename while changing a separate source property', async () => {
    await call('axure_open', { path: current.output });
    await call('rename_widget', { target: { name: 'headline', page: '首页' }, name: '原生主标题' });
    const saved = await call('axure_save', { as: join(work, 'native1.rp') });
    current = await call('revise_prototype', { source: current.source, rp: saved.physicalPath, output: join(work, 'round1.rp'),
      operations: [{ target: 'home/note', property: 'text', value: '第一轮源码说明' }] });
    assert(nodes(await native(current.output)).some(w => w.name === '原生主标题'));
  });
  await check('cycle 2 preserves native text and geometry through source child reordering', async () => {
    await call('axure_open', { path: current.output });
    await call('edit_text', { target: { name: 'headline', page: '首页' }, text: '第二轮原生标题' });
    await call('set_widget_geometry', { target: { name: 'headline', page: '首页' }, x: 48, y: 28 });
    const saved = await call('axure_save', { as: join(work, 'native2.rp') });
    const source = JSON.parse(readFileSync(current.source));
    current = await call('revise_prototype', { source: current.source, rp: saved.physicalPath, output: join(work, 'round2.rp'),
      operations: [{ path: '/pages/0/root/children', value: [...source.pages[0].root.children].reverse() }] });
    const title = nodes(await native(current.output)).find(w => w.name === '原生主标题');
    assert.equal(title.text, '第二轮原生标题'); assert.equal(title.x, 48); assert.equal(title.y, 28);
    const status = await call('sync_prototype', { mode: 'status', source: current.source, rp: current.output });
    assert.equal(status.sourceChanged, false); assert.equal(status.nativeChanged, false);
  });
  await check('cycle 3 preserves identity after rename/reordering and stops delete-vs-edit without writing', async () => {
    await call('axure_open', { path: current.output });
    await call('edit_text', { target: { name: 'headline', page: '首页' }, text: '第三轮原生修改' });
    const saved = await call('axure_save', { as: join(work, 'native3.rp') });
    const source = JSON.parse(readFileSync(current.source));
    const index = source.pages[0].root.children.findIndex(n => n.id === 'headline' || n.label === 'headline');
    assert(index >= 0);
    const before = [hash(current.source), hash(saved.physicalPath), hash(saved.physicalPath + '.baseline.json')];
    const r = await call('revise_prototype', { source: current.source, rp: saved.physicalPath, output: join(work, 'conflict.rp'),
      operations: [{ op: 'remove', path: '/pages/0/root/children/' + index }] }, true);
    assert.equal(r.status, 'conflict');
    assert(!existsSync(join(work, 'conflict.rp')) && !existsSync(join(work, 'conflict.rp.baseline.json')));
    assert.deepEqual([hash(current.source), hash(saved.physicalPath), hash(saved.physicalPath + '.baseline.json')], before);
  });
  await check('recipe cheatsheet, contactSheet preview, and structural node-level revise_prototype with auto output', async () => {
    const rec = await call('prototype_recipe', { recipe: 'mobile-cards' });
    assert(rec.cheatsheet && JSON.stringify(rec.cheatsheet).includes('stat-row') && Array.isArray(rec.gotchas) && rec.tokens);
    const dslPath = join(work, 'app-flow.rp1');
    writeFileSync(dslPath, [
      'rp/1 title="测试应用" domain="mobile" device="iphone-17"',
      'tab-bar:',
      '  item home "今日" icon="home"',
      'page home "今日":',
      '  phone-shell #sh title="今日任务":',
      '    column #body [fillxfill] padding=16 gap=12:',
      '      stat-row #stats:',
      '        item label="待办" value="3"',
      '      list-item #item1 title="完成原型体验优化" rightBadge="进行中"',
    ].join('\n'));
    const gen = await call('generate_prototype', { source: dslPath, output: join(work, 'app-flow.rp') });
    assert(gen.contactSheet && existsSync(gen.contactSheet));
    const rev = await call('revise_prototype', {
      source: gen.source,
      rp: gen.output,
      operations: [
        { op: 'add-node', after: 'home/item1', node: 'list-item #item2 title="新增验证任务" rightBadge="待办"' },
      ],
    });
    assert(rev.output.endsWith('app-flow-v2.rp') && existsSync(rev.output));
    assert(rev.contactSheet && existsSync(rev.contactSheet));
  });
} finally {
  await client.close();
  if (keep) writeFileSync(join(work, 'report.json'), JSON.stringify({ results, calls }, null, 2));
  else rmSync(work, { recursive: true, force: true });
}
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ total: results.length, passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
