// Positive workflow regressions from the third external report, through real stdio MCP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';

const root = process.env.AXURE_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.env.AXURE_ROUND3_OUTPUT;
const work = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'zee-round3-'));
mkdirSync(work, { recursive: true });
const client = new Client({ name: 'round3-workflows', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
  env: { ...process.env, AXURE_WRITE_ROOT: work }, stderr: 'pipe' });
const checks = [];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const fixture = name => JSON.parse(readFileSync(join(root, 'test/fixtures', name), 'utf8'));
const record = name => { checks.push(name); console.log('PASS', name); };
async function call(name, args, error = false) {
  const raw = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  if (name === 'read_interactions') assert(Buffer.byteLength(JSON.stringify(raw)) < 50000, 'including both MCP content representations');
  const result = raw.structuredContent ?? JSON.parse(raw.content[0].text);
  assert.equal(Boolean(raw.isError), error, JSON.stringify(result));
  return result;
}
async function waitJob(id) {
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    const job = await call('jobs_get', { id });
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('job timeout');
}
function allFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]);
}
try {
  await client.connect(transport);
  const info = await call('runtime_info', {});
  assert.equal(info.restartRequired, false);
  assert.equal(info.root, root);
  const runtime = fixture('round3-runtime-rows.json');
  const source = join(work, 'runtime.json'); writeFileSync(source, JSON.stringify(runtime));
  const generated = await call('generate_prototype', { spec: JSON.stringify(runtime), output: 'runtime.rp', compact: false });
  assert.equal(generated.status, 'completed');
  assert.deepEqual(readRp(readFileSync(generated.output)).globalVariables.map(v => v.name).sort(), Object.keys(runtime.variables).sort());
  record('JSON-text spec generates; RP/1 contains only declared globals');
  // generate(spec) stores a snapshot; revise the author-owned source with the same semantics.
  const originals = [source, generated.output, generated.baseline].map(p => [p, hash(p)]);
  const args = { source, rp: generated.output, operations: [{ target: 'p/btn', property: 'text', value: '新按钮' }] };
  for (const async of [false, true]) {
    const reply = await call('revise_prototype', { ...args, dryRun: true, async });
    const result = async ? (await waitJob(reply.id)).result : reply;
    assert.equal(result.status, 'planned');
    record(`runtime data-add dryRun async=${async}`);
  }
  const started = Date.now();
  const job = await call('revise_prototype', { ...args, async: true });
  assert.equal(job.type, 'revise-prototype'); assert.equal(job.status, 'queued');
  assert(Date.now() - started < 5000, 'async revise must return a handle promptly');
  const finished = await waitJob(job.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  const revised = finished.result;
  assert.equal(revised.status, 'completed');
  assert.equal((await call('verify', { path: revised.output })).syncStatus.state, 'in_sync');
  assert(!readdirSync(work).some(n => n.startsWith('.revision-')));
  for (const path of [revised.source, revised.baseline, revised.contactSheet, revised.report, revised.artifacts.ir]) assert(existsSync(path), path);
  assert(!JSON.stringify(revised).includes('.revision-'));
  assert(!readFileSync(revised.baseline, 'utf8').includes('.revision-'));
  for (const path of allFiles(revised.artifacts.directory).filter(p => p.endsWith('.json')))
    assert(!readFileSync(path, 'utf8').includes('.revision-'), path);
  const restored = JSON.parse(readFileSync(revised.source, 'utf8'));
  assert.deepEqual(restored.pages[0].root.children[1].onClick[1].rows, runtime.pages[0].root.children[1].onClick[1].rows);
  for (const [path, digest] of originals) assert.equal(hash(path), digest);
  const cancelled = await call('jobs_cancel', { id: job.id });
  assert.equal(cancelled.cancelled, false); assert.equal(cancelled.reason, 'already_completed');
  record('async revise publishes durable assets, preserves expressions/inputs, removes staging, syncs cleanly');
  const first = await call('revise_prototype', { ...args, dryRun: true, async: true });
  const queued = await call('revise_prototype', { ...args, dryRun: true, async: true });
  const cancelledQueued = await call('jobs_cancel', { id: queued.id });
  assert.equal(cancelledQueued.cancelled, true);
  assert.equal(cancelledQueued.reason, 'cancelled_queued');
  assert.equal((await waitJob(first.id)).status, 'completed');
  record('revision queue cancellation leaves the active revision responsive');

  await call('axure_open', { path: revised.output });
  const located = await call('locate', { query: '新按钮' });
  const candidate = located.candidates[0];
  assert(candidate);
  for (const encode of [v => v, JSON.stringify]) {
    const target = encode({ record: candidate.record, id: candidate.id, container: candidate.container });
    const inspected = await call('inspect', { target });
    assert.equal(inspected.id, candidate.id);
    await call('edit_text', { target, text: '定位验证' });
    await call('rename_widget', { target, name: '精确定位按钮' });
    await call('set_widget_geometry', { target, x: 24 });
    await call('set_widget_style', { target, color: '#123456' });
    record(`target ${typeof target}: inspect/edit/rename/geometry/style`);
  }
  const nested = (await call('locate', { query: 'txt-rt-' })).candidates.find(c => c.container.length && c.type !== 'Layer');
  assert(nested);
  for (const encode of [v => v, JSON.stringify]) {
    const target = encode({ record: nested.record, id: nested.id, container: nested.container });
    assert.equal((await call('inspect', { target })).id, nested.id);
    await call('edit_text', { target, text: '行内容' });
    await call('rename_widget', { target, name: '行文字' });
    await call('set_widget_geometry', { target, x: 2 });
    await call('set_widget_style', { target, color: '#234567' });
  }
  record('container exact target object/JSON-text across all five tools');
  for (const spec of [runtime, JSON.stringify(runtime)]) {
    assert.equal((await call('diagnose_prototype', { source: spec })).ok, true);
    const bound = structuredClone(runtime); bound.pages[0].root.children[1].text = '=text(var.seq)';
    assert.equal((await call('explain_binding', { source: typeof spec === 'string' ? JSON.stringify(bound) : bound, target: 'p/btn' })).ok, true);
    const sync = await call('sync_prototype', { spec, rp: generated.output, mode: 'lift', outSource: join(work, `lift-${typeof spec}.json`) });
    assert.equal(sync.ok, true);
    const review = await call('review_image_structure', { spec: typeof spec === 'string' ? JSON.stringify({ frames: [] }) : { frames: [] } });
    assert.notEqual(review.status, 'failed');
  }
  record('source/spec object and JSON-text family');

  const masters = fixture('round3-master-slot.json');
  assert.equal((await call('diagnose_prototype', { source: masters })).ok, true);
  const invalid = [
    ['E_PROPERTY', s => { s.pages[1].slot.body[0].adaptive.mob.fontSize = 14; }],
    ['E_ADAPTIVE', s => { s.pages[1].slot.body[0].adaptive.ghost = { w: 200 }; }],
    ['E_SIZE', s => { s.pages[1].slot.body[0].adaptive.mob.w = -1; }],
    ['E_TYPE', s => { s.pages[1].slot.body[0].adaptive.mob.w = 'bad'; }],
    ['E_ADAPTIVE', s => { s.masters.shell_m.layout[0].children[0].adaptive = { mob: { w: 200 } }; }],
    ['E_ADAPTIVE', s => { s.pages[0].slot.body[0].template.children[0].adaptive = { mob: { w: 200 } }; }],
    ['E_ADAPTIVE', s => { delete s.views; s.pages[1].slot.body[0] = { type: 'dynamic-panel', id: 'ap', w: 300, h: 100,
      states: [{ id: 'one', root: { type: 'label', id: 'inside', text: 'x', adaptive: { mob: { w: 200 } } } }] }; }],
  ];
  for (const [code, mutate] of invalid) {
    const bad = structuredClone(masters); mutate(bad);
    const diagnosis = await call('diagnose_prototype', { source: bad }, true);
    assert.equal(diagnosis.diagnostics[0].code, code, JSON.stringify(diagnosis));
    assert(!JSON.stringify(diagnosis).includes('Traceback'));
  }
  record('adaptive legal slot + invalid property/view/size/type/master/repeater rejected during check');
  const withNavigation = structuredClone(masters);
  withNavigation.masters.shell_m.layout[0].children.unshift({ type: 'button', id: 'home', text: '首页', w: 120, h: 36, onClick: [{ goto: 'list' }] });
  const master = await call('generate_prototype', { spec: withNavigation, output: 'master.rp', compact: false });
  assert.equal(master.status, 'completed');
  assert(!JSON.stringify(master.audit).includes('WARN_UNKNOWN_PROP'));
  const records = readRecords(readFileSync(master.output));
  assert.equal(records.filter(r => r.className === 'Axure:Master').length, 1);
  let adaptive = false;
  for (const rec of records.filter(r => r.className === 'Axure:Page')) {
    const g = parsePayload(rec), objects = [...g.objects.values()];
    const page = objects.find(o => o.className === 'Axure:Page');
    const diagram = g.objects.get(field(page.body, 'diagram').value);
    const order = field(diagram.body, 'diagram-objects').items.map(i => g.objects.get(i.value));
    const reference = objects.find(o => o.className === 'Axure:DiagramObject:ReferenceDiagramObject');
    assert(reference);
    const name = o => field(field(o.body ?? {}, 'name-block') ?? {}, 'text')?.text ?? '';
    assert(order.findIndex(o => name(o).endsWith('-img-device-screen-base')) < order.indexOf(reference));
    assert(order.indexOf(reference) < order.findIndex(o => /txt-(sum|det_t)-/.test(name(o))));
    assert(objects.some(o => o.className === 'Axure:DiagramObject:Layer'
      && field(o.body, 'DiagramObjects')?.items.some(i => i.value === reference.id)), 'master must share the page scene group');
    const props = field(g.objects.get(field(reference.body, 'MyStyle').value).body, 'PropList').items;
    const loc = props.find(p => field(p, 'DOAName').value === 3221225573);
    assert.equal(field(field(loc, 'Value'), 'X').value, 20);
    assert.equal(field(field(loc, 'Value'), 'Y').value, 20);
    for (const o of objects.filter(o => name(o).startsWith('txt-det_t-'))) {
      adaptive = field(o.body, 'AdaptiveStyles').items.length > 0;
    }
  }
  assert(adaptive);
  const masterEvents = await call('read_interactions', { path: master.output, widget: 'home' });
  assert(masterEvents.contained.some(w => w.master && w.interactions.some(e => e.event === 'OnClick')), 'master definition interactions must survive pagination');
  assert(masterEvents.items.some(w => w.master && w.interactions.some(e => e.event === 'OnClick')));
  const summary = readRp(readFileSync(master.output));
  assert.deepEqual([summary.records.unparseable, summary.counts.danglingRefs, summary.counts.problems], [0, 0, 0]);
  record('master native slots, reference geometry/layer order and adaptive overrides');

  const large = structuredClone(runtime);
  const button = large.pages[0].root.children[1];
  button.onClick = Array.from({ length: 12 }, () => ({ goto: 'p' }));
  large.pages[0].root.children = Array.from({ length: 28 }, (_, i) => ({ ...button, id: `b${i}` }));
  large.pages[0].canvas = [420, 1800];
  large.pages[0].root = { type: 'box', id: 'root', layout: 'column', w: 'fill', h: 'fill', gap: 12,
    children: large.pages[0].root.children };
  const big = await call('generate_prototype', { spec: large, output: 'large.rp' });
  const seen = new Set(); let offset = 0, total;
  do {
    const page = await call('read_interactions', { path: big.output, limit: 5, offset });
    assert(Buffer.byteLength(JSON.stringify(page)) < 50000);
    total = page.total;
    for (const w of page.pages.flatMap(p => p.widgets)) { assert(!seen.has(w.id)); seen.add(w.id); assert.equal(w.interactions[0].cases[0].actions.length, 12); }
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(seen.size, total);
  const filtered = await call('read_interactions', { path: big.output, widget: 'p/b5' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items.length, 1);
  assert.deepEqual(filtered.items[0].interactions, filtered.pages[0].widgets[0].interactions);
  record('read_interactions pagination complete, bounded responses and logical widget filter');

  const makeButton = id => ({ type: 'button', id, text: id, w: 160, h: 28, onClick: [{ goto: 'mix' }] });
  const mixed = { language: 'rp/1', domain: 'test', variables: { counter: { type: 'number', value: 0 } }, pages: [
    { id: 'mix', canvas: [600, 600], on: { load: [{ set: { $counter: 1 } }] }, root: {
      type: 'box', id: 'root', layout: 'column', w: 'fill', h: 'fill', gap: 12, children: [
        ...Array.from({ length: 4 }, (_, i) => makeButton(`top${i}`)),
        { type: 'dynamic-panel', id: 'panel', w: 'fill', h: 260, states: [{ id: 'one', root: {
          type: 'box', id: 'body', layout: 'column', w: 'fill', h: 'fill', gap: 8,
          children: Array.from({ length: 6 }, (_, i) => makeButton(`nested${i}`)),
        } }] },
      ],
    } },
  ] };
  const mixedRp = await call('generate_prototype', { spec: mixed, output: 'mixed.rp' });
  const mixedArgs = { path: mixedRp.output, page: 'mix', limit: 5 };
  const full = await call('read_interactions', { ...mixedArgs, limit: 100 });
  assert.equal(full.total, 11); assert.equal(full.items.length, 11);
  const initial = await call('read_interactions', mixedArgs);
  const defaults = await call('read_interactions', { path: mixedRp.output, page: 'mix' });
  assert.deepEqual(defaults.items, full.items, 'omitting both offset and limit starts at the first owner');
  assert.equal(initial.contained.length, 0, 'first page has top-level owners, not nested owners');
  assert.equal(initial.pages[0].pageInteractions.length, 1);
  assert.equal(initial.pages[0].widgets.length, 4);
  assert.equal(initial.items.length, 5, 'unified first page is nonempty');
  for (const skip of [0, 1, 2, 5, 10, 11, 12]) {
    const response = await call('read_interactions', { ...mixedArgs, offset: skip });
    const expected = full.items.slice(skip, skip + 5);
    assert.deepEqual(response.items, expected, `offset=${skip} must skip owners`);
    assert.equal(response.offset, skip);
    assert.equal(response.returned, expected.length);
    assert.equal(response.hasMore, skip + expected.length < 11);
    assert.equal(response.nextOffset, response.hasMore ? skip + expected.length : null);
  }
  const gathered = [];
  let next = 0;
  do {
    const response = await call('read_interactions', { ...mixedArgs, offset: next });
    gathered.push(...response.items); next = response.nextOffset;
  } while (next !== null);
  assert.deepEqual(gathered, full.items, 'mixed owners traverse once without omissions');
  assert.equal(new Set(gathered.map(w => `${w.kind}/${w.record}/${w.id ?? ''}`)).size, 11);
  record('mixed page/top-level/nested owners: default and offset 0/1/2/5/10/11/12 have exact slice semantics');
  writeFileSync(join(work, 'round3-results.json'), JSON.stringify({ ok: true, root, checks, outputs: { generated, revised, master, large: big.output } }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, work }));
} finally {
  await client.close();
  if (!keep) rmSync(work, { recursive: true, force: true });
}
