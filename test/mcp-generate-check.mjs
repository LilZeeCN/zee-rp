// End-to-end client: generation and editing use only the public MCP transport.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.env.AXURE_MCP_TEST_OUTPUT;
const work = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'zee-rp-generate-'));
if (keep) mkdirSync(work, { recursive: false });
const spec = JSON.parse(readFileSync(join(root, 'examples/rp-language/mcp-three-pages.json')));
const protectedPath = join(work, 'protected.rp');
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
  env: { ...process.env, AXURE_WRITE_ROOT: work, AXURE_PROTECTED_PATHS: protectedPath }, stderr: 'pipe' });
const client = new Client({ name: 'mcp-prototype-acceptance', version: '1.0.0' });
const results = [];
let generated;
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert(!result.isError, result.content[0].text);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};
const failure = async args => {
  const result = await client.callTool({ name: 'generate_prototype', arguments: args });
  assert(result.isError, 'expected a failed MCP result');
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};
async function check(name, action) {
  try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}
try {
  await client.connect(transport);
  await check('discover structured generation entry', async () => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(t => t.name === 'generate_prototype');
    assert(tool); assert(tool.inputSchema.properties.spec.oneOf.find(s => s.type === 'object').properties.pages);
    assert(tool.inputSchema.properties.spec.oneOf.some(s => s.type === 'string'));
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  });
  await check('one MCP call builds three pages, shared components and cross-page data actions', async () => {
    const supplied = structuredClone(spec); delete supplied.language; delete supplied.target;
    generated = await call('generate_prototype', { spec: supplied, output: join(work, 'three-pages.rp'), compact: false });
    assert.equal(supplied.language, undefined);
    assert.deepEqual(generated.pages.map(p => p.id), ['list', 'detail', 'result']);
    assert.deepEqual(generated.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    assert.equal(generated.audit.aestheticOk, true);
    assert.deepEqual(generated.audit.warnings, []);
    assert(generated.previews?.list && existsSync(generated.previews.list));
    assert.equal(generated.eventCoverage.declared, generated.eventCoverage.materialized);
    assert(generated.eventCoverage.declared >= 6);
    assert.equal(generated.sha256, createHash('sha256').update(readFileSync(generated.output)).digest('hex'));
    assert.deepEqual(generated.verification, { structure: true, axureOpened: false, guiEdited: false, saveReopened: false, preview: false });
    assert.equal(JSON.parse(readFileSync(generated.artifacts.source)).language, 'rp/1');
    const rp = JSON.parse((await call('rp_read', { args: [generated.output, '--json'] })).stdout);
    assert.equal(rp.pages.length, 3);
    const actions = rp.pages.flatMap(p => p.widgets.flatMap(w => (w.interactions ?? []).flatMap(e => e.cases.flatMap(c => c.actions))));
    assert(actions.some(a => JSON.stringify(a).includes('topic')));
    assert(actions.some(a => JSON.stringify(a).includes('plan')));
  });
  await check('generated file can enter the existing editing session and target widgets by name or logical id', async () => {
    await call('axure_open', { path: generated.output });
    await call('edit_text', { target: { name: '列表标题' }, text: 'MCP 编辑后的复习列表' });
    await call('edit_text', { target: { name: 'hint', page: '复习列表' }, text: '按逻辑 ID 命中编辑后的说明' });
    await call('axure_save', { as: join(work, 'mcp-edited.rp') });
    const rp = JSON.parse((await call('rp_read', { args: [join(work, 'mcp-edited.rp'), '--json'] })).stdout);
    assert(rp.pages[0].widgets.some(w => w.text === 'MCP 编辑后的复习列表'));
    assert(rp.pages[0].widgets.some(w => w.text === '按逻辑 ID 命中编辑后的说明'));
  });
  await check('missing widget reports exact page, widget and source pointer without publishing output', async () => {
    const broken = structuredClone(spec);
    broken.pages[1].root.children[3].onClick[0].value.widget.ref = 'missing';
    const output = join(work, 'bad-widget.rp');
    const result = await failure({ spec: broken, output });
    const d = result.diagnostics.find(d => d.code === 'E_REFERENCE');
    assert.equal(d.pageId, 'detail'); assert.equal(d.widgetId, 'submit');
    assert(d.pointer.startsWith('/pages/1/root/children/3/'));
    assert(!existsSync(output)); assert(existsSync(join(result.artifacts.directory, 'failure.json')));
  });
  await check('unknown cross-page destination is rejected with source context', async () => {
    const broken = structuredClone(spec);
    broken.pages[1].root.children[3].onClick[1].page = 'missing';
    const output = join(work, 'bad-page.rp');
    const result = await failure({ spec: broken, output });
    assert(result.diagnostics.some(d => d.code === 'E_PAGE' && d.pageId === 'detail' && d.widgetId === 'submit'));
    assert(!existsSync(output));
  });
  await check('strict audit blocks delivery and keeps page-level layout diagnostics', async () => {
    const sparse = structuredClone(spec);
    sparse.pages[0].canvas = { w: 420, h: 650 };
    sparse.pages[0].root.h = 650;
    const output = join(work, 'strict.rp');
    const result = await failure({ spec: sparse, output, strictAudit: true });
    assert(result.diagnostics.some(d => d.code === 'E_LAYOUT' && d.pageName));
    assert(!existsSync(output));
  });
  await check('twelve-page input is assembled by the same MCP entry without changing the editing chain', async () => {
    const before = await call('axure_state', {});
    const twelve = structuredClone(spec);
    for (let i = 4; i <= 12; i++) twelve.pages.push({ id: `p${i}`, name: `复习页${i}`, canvas: { w: 420, h: 650 }, root: {
      type: 'box', id: 'root', layout: 'column', padding: 24, children: [
        { type: 'label', id: 'title', text: `第 ${i} 页`, w: 350, h: 44 },
        { type: 'button', id: 'back', text: '返回列表', w: 200, h: 44, onClick: [{ type: 'link', page: 'list' }] },
      ],
    } });
    const result = await call('generate_prototype', { spec: twelve, output: join(work, 'twelve-pages.rp'), compact: false });
    assert.equal(result.pages.length, 12); assert.equal(new Set(result.pages.map(p => p.record)).size, 12);
    assert.equal(result.eventCoverage.declared, result.eventCoverage.materialized);
    assert.deepEqual((await call('axure_state', {})).chain, before.chain);
  });
  await check('relative output, overwrite: true and compact: true work cleanly', async () => {
    const rel = await call('generate_prototype', { spec, output: 'relative-out.rp', compact: true });
    assert.equal(rel.output, join(realpathSync.native(work), 'relative-out.rp'));
    assert.equal(rel.artifacts, undefined);
    assert(rel.previews?.list);
    const over = await call('generate_prototype', { spec, output: 'relative-out.rp', overwrite: true, compact: true });
    assert.equal(over.status, 'completed');
  });
  await check('existing, protected and outside-root outputs fail before modifying a file', async () => {
    const digest = createHash('sha256').update(readFileSync(generated.output)).digest('hex');
    await failure({ spec, output: generated.output });
    assert.equal(createHash('sha256').update(readFileSync(generated.output)).digest('hex'), digest);
    await failure({ spec, output: protectedPath }); assert(!existsSync(protectedPath));
    await failure({ spec, output: join(dirname(work), 'outside-root', 'blocked.rp') });
    await failure({ spec: { pages: [] }, output: join(work, 'empty.rp') });
    assert(!existsSync(join(work, 'empty.rp')));
  });
  await check('locate matches logical id with display name, progress-bar binds variable, and multiline paragraph supports set-text and edit_text', async () => {
    const round2Spec = {
      language: 'rp/1',
      target: 9,
      variables: { done: '20' },
      pages: [{
        id: 'home',
        name: '今日',
        device: 'iphone-17',
        root: {
          type: 'phone-shell',
          id: 'shell',
          title: '知序 · 考研复习',
          children: [
            { label: 'headline', name: '今日主标题', text: '把今天，稳稳学扎实。', w: 354, h: 48, fontSize: 22, fontWeight: 700 },
            { type: 'progress-bar', id: 'prog', label: '今日进度', value: { variable: 'done' } },
            { paragraph: 'meaning', text: '旧段落第一行。\n旧段落第二行。\n旧段落第三行。', w: 354, h: 96, fontSize: 16 },
            { button: 'btnShort', text: '换成短释义', w: 354, h: 44, onClick: { set: { '@meaning': '短释义：先回忆，再查漏。' } } },
          ],
        },
      }],
    };
    const r2 = await call('generate_prototype', { spec: round2Spec, output: 'round2.rp', compact: true });
    assert.equal(r2.status, 'completed');
    const loc = await call('locate', { path: r2.output, query: 'headline', page: '今日' });
    assert.equal(loc.total, 1);
    assert.equal(loc.candidates[0].name, '今日主标题');
    await call('axure_open', { path: r2.output });
    await call('edit_text', { target: { name: 'meaning', page: '今日' }, text: '整段应只剩下这一句。' });
    const saved = await call('axure_save', { as: join(work, 'round2-edited.rp') });
    const rp = JSON.parse((await call('rp_read', { args: [saved.physicalPath, '--json'] })).stdout);
    const leftover = rp.pages[0].widgets.filter(w => String(w.text ?? '').includes('旧段落'));
    assert.equal(leftover.length, 0);
    assert(rp.pages[0].widgets.some(w => w.text === '整段应只剩下这一句。'));
  });
} finally {
  await client.close();
  if (keep) writeFileSync(join(work, 'report.json'), JSON.stringify({ generated, results }, null, 2) + '\n');
  else rmSync(work, { recursive: true, force: true });
}
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ evidence: 'real-stdio-mcp', total: results.length, passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
