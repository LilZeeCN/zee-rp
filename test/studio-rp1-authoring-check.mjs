import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createEmptyStudioDocument, buildNodeIndex, importToStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { prepareRp1Commands } from '../studio/rp1-authoring.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { validateInput } from '../scripts/mcp-tools.mjs';
import { studioTools } from '../studio/mcp-adapter.mjs';
import { copyNodeSnapshots } from '../studio/clipboard.mjs';

const source = 'column #lesson [350xhug] gap=20\n  label #word "serendipity" fontFamily=Georgia fontSize=44\n  paragraph #answer [fillxhug] "意外发现美好事物的能力。" visible=false fontSize=16 lineHeight=25\n  button #reveal [fillx48] "揭示答案"\n    +onClick [{"type":"show","target":"answer"}]';
const node = (store, id) => [...buildNodeIndex(store.doc).byScopedId.values()].find(entry => entry.id === id)?.node;

test('full RP/1 import lays out phone-shell cards in a safe-area column and preserves overrides', t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-phone-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'repro.rp1');
  writeFileSync(path, `rp/1 target=9 name="ReproBug" domain=mobile theme=modern-dark
palette:
  $bg = "#0B0F17"
  $surface = "#151D2A"
  $ink = "#F8FAFC"
  $brand = "#F59E0B"
page #home name="首页" device=iphone-17
  phone-shell #shell title="REPRO" gap=12
    card #card1 [fillxhug] padding=16 title="Card 1" body="Should be at the top"
    card #card2 [fillxhug] padding=16 title="Card 2" body="Should be below Card 1"
`);
  const doc = importToStudioDocument(path);
  const scene = resolveDocumentScene(doc);
  const find = id => scene.pages[0].nodes.find(n => n.id === id);
  const first = find('card1'), second = find('card2');
  assert.equal(second.y - first.y - first.h, 12, 'cards must not overlap');
  assert.equal(first.x, 16);
  assert.equal(first.y, 60);
  assert.equal(first.w, 370);
  assert.equal(find('shell').fill, '#0B0F17');
  assert.equal(find('card1_title').color, '#F8FAFC');
  assert.equal(doc.palette.brand, '#F59E0B');
  assert.deepEqual(importToStudioDocument(doc).pages, doc.pages, 'reimport must be idempotent');

  const explicit = importToStudioDocument({ pages: [{ id: 'home', device: 'iphone-17', root: {
    type: 'phone-shell', id: 'shell', layout: 'stack', padding: 0, gap: 0, fill: '#123456',
    children: [{ type: 'box', id: 'fixed', x: 30, y: 90, w: 80, h: 40 }],
  } }] });
  const fixed = resolveDocumentScene(explicit).pages[0].nodes.find(n => n.id === 'fixed');
  assert.deepEqual([fixed.x, fixed.y], [30, 90]);
  assert.equal(explicit.pages[0].root.fill, '#123456');
  assert.equal(explicit.pages[0].root.gap, 0);
});

test('modern-dark imports its native palette without falling back to mobile-hifi', () => {
  const doc = importToStudioDocument({ theme: 'modern-dark', pages: [{ id: 'home', root: { type: 'label', id: 'text', text: 'Dark' } }] });
  assert.equal(doc.palette.bg, '#0B0F19');
  assert.equal(doc.palette.ink, '#F8FAFC');
  assert.equal(doc.palette.line, '#1E293B');
  assert.equal(doc.palette['ink-2'], '#CBD5E1');
});

test('theme colors update screen, text and border in design and preview without reloading', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-theme-browser-'));
  const sourcePath = join(dir, 'source.json');
  writeFileSync(sourcePath, JSON.stringify({ theme: 'modern-dark', pages: [{ id: 'home', device: 'iphone-17', root: {
    type: 'phone-shell', id: 'shell', children: [{ type: 'card', id: 'card', title: 'Theme', borderTop: true }],
  } }] }));
  const { studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath, port: 0 });
  t.after(async () => { await studio.close(); rmSync(dir, { recursive: true, force: true }); });
  const page = await studio.ensureManagedBrowserPage();
  const readColors = () => page.evaluate(`[
    getComputedStyle(document.querySelector('.artboard-screen')).backgroundColor,
    getComputedStyle(document.querySelector('[data-node-id="card_title"]')).color,
    getComputedStyle(document.querySelector('[data-node-id="card"]')).borderTopColor
  ]`);
  assert.deepEqual(await readColors(), ['rgb(11, 15, 25)', 'rgb(248, 250, 252)', 'rgb(30, 41, 59)']);
  for (const [name, colors, expected] of [
    ['light', { bg: '#F7F8F2', ink: '#203B32', line: '#E3E7DC' }, ['rgb(247, 248, 242)', 'rgb(32, 59, 50)', 'rgb(227, 231, 220)']],
    ['custom', { bg: '#26102F', ink: '#FFF1B8', line: '#A878CB' }, ['rgb(38, 16, 47)', 'rgb(255, 241, 184)', 'rgb(168, 120, 203)']],
  ]) {
    await page.evaluate(`document.getElementById('mode-design-btn').click()`);
    const result = await (await fetch(studio.url + '/api/commands', { method: 'POST', body: JSON.stringify({
      baseRevision: studio.store.appliedRevision, idempotencyKey: 'theme-' + name,
      commands: [{ type: 'setTokens', tokens: { colors } }],
    }) })).json();
    assert.equal(result.ok, true, JSON.stringify(result));
    await page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${result.appliedRevision}`);
    assert.deepEqual(await readColors(), expected, name + ' design');
    await page.evaluate(`document.getElementById('mode-interact-btn').click()`);
    await page.waitForFunction(`document.getElementById('mode-interact-btn').getAttribute('aria-pressed')==='true'`);
    assert.deepEqual(await readColors(), expected, name + ' preview');
  }
  assert.equal(page.scriptErrors.length, 0);
});
function seeded() {
  const store = new StudioDocumentStore(createEmptyStudioDocument());
  const prepared = prepareRp1Commands({ doc: store.doc, source, mode: 'insert', pageId: 'home' });
  assert.equal(store.applyTransaction({ commands: prepared.commands }).ok, true);
  return store;
}

test('RP/1 inserts flow/hug/visual styles and interactions through the existing undoable Store', () => {
  const store = seeded();
  assert.equal(node(store, 'lesson').layout, 'column');
  assert.equal(node(store, 'answer').visible, false);
  const scene = resolveDocumentScene(store.doc);
  assert.equal(scene.pages[0].nodes.find(n => n.id === 'word').fontFamily, 'Georgia');
  assert.equal(node(store, 'reveal').on.click[0].target, 'answer');
  assert.equal(store.undo().ok, true); assert.equal(node(store, 'lesson'), undefined);
  assert.equal(store.redo().ok, true); assert.ok(node(store, 'reveal'));
});

test('a sparse RP/1 update preserves omitted styles, siblings and click behavior', () => {
  const store = seeded(), beforeAnswer = structuredClone(node(store, 'answer'));
  const beforeEvent = structuredClone(node(store, 'reveal').on);
  const update = prepareRp1Commands({ doc: store.doc, source: 'button #reveal "展开释义"', mode: 'update', pageId: 'home', parentId: 'lesson' });
  assert.equal(store.applyTransaction({ commands: update.commands }).ok, true);
  assert.equal(node(store, 'reveal').text, '展开释义'); assert.equal(node(store, 'reveal').h, 48);
  assert.deepEqual(node(store, 'reveal').on, beforeEvent); assert.deepEqual(node(store, 'answer'), beforeAnswer);
});

test('malformed properties and missing IDs give source locations without changing the document', () => {
  const store = seeded(), before = JSON.stringify(store.doc);
  assert.throws(() => prepareRp1Commands({ doc: store.doc, source: 'column #new\n  label #typo "Oops" fontSzie=40', mode: 'insert', pageId: 'home' }), error => error.code === 'E_UNKNOWN_PROPERTY' && error.line === 2 && error.snippet.includes('fontSzie'));
  assert.throws(() => prepareRp1Commands({ doc: store.doc, source: 'label "Missing ID"', mode: 'insert', pageId: 'home' }), error => error.code === 'E_RP1_EXPLICIT_ID');
  assert.equal(JSON.stringify(store.doc), before);
});

test('compact RP/1 uses the same shared typography and spacing consumer as ordinary commands',()=>{
 const store=seeded();assert(store.applyTransaction({commands:[{type:'setTokens',tokens:{display:32,space:16}}]}).ok);
 const inserted=prepareRp1Commands({doc:store.doc,pageId:'home',mode:'insert',source:'column #shared_layout w=340 h=hug gap=$space padding=["$space",12]\n  label #shared_word "Shared type" fontSize=$display w=300 h=hug\n  label #fixed_caption "Keep override" fontSize=14 w=300 h=30'});let result=store.applyTransaction({commands:inserted.commands});assert(result.ok,JSON.stringify(result));const find=(scene,id)=>scene.pages[0].nodes.find(node=>node.id===id);assert.equal(find(result.scene,'shared_word').fontSize,32);assert.equal(find(result.scene,'shared_layout').gap,16);assert.equal(node(store,'shared_word').fontSize,'$display');
 result=store.applyTransaction({commands:[{type:'setToken',category:'size',name:'display',value:44}]});assert(result.ok);assert.equal(find(result.scene,'shared_word').fontSize,44);assert.equal(find(result.scene,'fixed_caption').fontSize,14);
 const hash=store.doc.contentHash;assert.throws(()=>prepareRp1Commands({doc:store.doc,pageId:'home',mode:'update',source:'label #shared_word fontSize=$missing'}),error=>error.code==='E_NUMERIC_TOKEN'&&error.field==='fontSize'&&error.line===1);assert.equal(store.doc.contentHash,hash);
});

test('duplicate IDs, unknown references, unsupported declarations and scope escapes reject honestly', () => {
  const store = seeded();
  const prepare = (source, extra = {}) => prepareRp1Commands({ doc: store.doc, source, mode: 'insert', pageId: 'home', ...extra });
  assert.throws(() => prepare('label #word "Duplicate"'), error => error.code === 'E_RP1_DUPLICATE_ID');
  assert.throws(() => prepare('button #bad "Bad"\n  +onClick [{"type":"show","target":"missing"}]'), error => error.code === 'E_RP1_REFERENCE');
  assert.throws(() => prepare('rp/1 target=9\nvar $count type=number value=0\npage #home\n  label #fresh "Fresh"'), error => error.code === 'E_RP1_SOURCE_UNSUPPORTED');
  assert.throws(() => prepare('paragraph #bad "=$missing + 1"'), error => error.code === 'E_RP1_VARIABLE');
  assert.throws(() => prepare('label #word "Out of scope"', { mode: 'update', parentId: 'reveal' }), error => error.code === 'E_RP1_SOURCE_SCOPE');
});

test('copy owns the original snapshot, remaps all descendant IDs and preserves internal actions across pages', () => {
  const store = seeded();
  const copied = copyNodeSnapshots({ doc: store.doc, pageId: 'home', nodeIds: ['lesson', 'word'] });
  assert.equal(copied.length, 1);
  assert.equal(store.applyTransaction({ commands: [{ type: 'setText', nodeId: 'word', text: 'Changed after copy' }, { type: 'addPage', pageId: 'other', domain: 'web' }] }).ok, true);
  assert.equal(store.applyTransaction({ commands: [{ type: 'pasteNodes', pageId: 'other', sourcePageId: 'home', sourceDocumentId: store.doc.documentId, nodes: copied }] }).ok, true);
  assert.equal(node(store, 'word_copy').text, 'serendipity');
  assert.equal(node(store, 'reveal_copy').on.click[0].target, 'answer_copy');
  const ids = [...new Set(buildNodeIndex(store.doc).byScopedId.values())].filter(entry => entry.pageId === 'other').map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(store.applyTransaction({ commands: [{ type: 'duplicateNode', pageId: 'home', nodeId: 'lesson' }] }).ok, true);
  assert.ok(node(store, 'word_copy_2'));
  const detachedButton = copyNodeSnapshots({ doc: store.doc, pageId: 'home', nodeIds: ['reveal'] });
  const before = JSON.stringify(store.doc);
  const invalid = store.applyTransaction({ commands: [{ type: 'pasteNodes', pageId: 'other', sourcePageId: 'home', nodes: detachedButton }] });
  assert.equal(invalid.code, 'E_CLIPBOARD_REFERENCE'); assert.equal(JSON.stringify(store.doc), before);
});

test('public schema validates the exclusive RP/1 and command forms, including nested commands', () => {
  const schema = studioTools.find(tool => tool.name === 'studio_command').inputSchema;
  validateInput(schema, { baseRevision: 1, idempotencyKey: 'a', pageId: 'home', sourceMode: 'insert', rp1: source });
  validateInput(schema, { baseRevision: 1, idempotencyKey: 'b', commands: [{ type: 'setText', nodeId: 'x', text: 'y' }] });
  assert.throws(() => validateInput(schema, { baseRevision: 1, idempotencyKey: 'a' }));
  assert.throws(() => validateInput(schema, { baseRevision: 1, idempotencyKey: 'a', commands: [{ type: 'setText' }], rp1: source, pageId: 'home', sourceMode: 'insert' }));
  assert.throws(() => validateInput(schema, { baseRevision: 1, idempotencyKey: 'a', commands: [{ type: 'unknown-command' }] }));
});

test('fresh MCP discovers, inserts, replays safely, sparsely updates and queries exact authoring targets', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-rp1-mcp-'));
  const { studio } = await startStudioServer({ projectDir: dir, port: 0 });
  const client = new Client({ name: 'rp1-authoring-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))], stderr: 'pipe' });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: { ...(name === 'studio_describe' ? {} : { url: studio.url }), ...args } });
    return response.structuredContent || JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    assert.equal((await call('studio_describe', { topic: 'rp1' })).format, 'studio-rp1-subset');
    const args = { baseRevision: 1, idempotencyKey: 'rp1-once', pageId: 'home', sourceMode: 'insert', rp1: source };
    assert.equal((await call('studio_command', args)).ok, true);
    const replay = await call('studio_command', args); assert.equal(replay.idempotentReplay, true); assert.equal(studio.store.appliedRevision, 2);
    assert.equal((await call('studio_command', { ...args, documentId: 'another-document' })).code, 'E_DOCUMENT_ID_MISMATCH');
    assert.equal((await call('studio_command', { ...args, rp1: source + '\n  label #extra "Extra"' })).code, 'E_IDEMPOTENCY_CONFLICT');
    const changed = await call('studio_command', { baseRevision: 2, idempotencyKey: 'update', pageId: 'home', sourceMode: 'update', parentId: 'lesson', rp1: 'button #reveal "查看释义"' });
    assert.equal(changed.ok, true);
    assert.deepEqual(node(studio.store, 'reveal').on.click, [{ type: 'show', target: 'answer' }]);
    const queried = await call('studio_inspect', { pageId: 'home', nodeId: 'word' });
    assert.equal(queried.nodes[0].editableTargetId, 'home/word');
    assert.ok(queried.nodes[0].controls.some(control => control.kind === 'flow-layout'));
    const invalid = await call('studio_command', { baseRevision: 3, idempotencyKey: 'typo', pageId: 'home', sourceMode: 'insert', rp1: 'label #oops "Oops" fontSzie=30' });
    assert.equal(invalid.code, 'E_UNKNOWN_PROPERTY'); assert.equal(invalid.line, 1);
    const seedDs = await call('studio_command', {
      baseRevision: 3,
      idempotencyKey: 'seed-items-dataset',
      commands: [{ type: 'datasetOp', dataset: 'items', op: 'add', row: { id: 'A' } }],
    });
    assert.equal(seedDs.ok, true, JSON.stringify(seedDs));
    const viaPanelAndRepeater = await call('studio_command', {
      baseRevision: 4,
      idempotencyKey: 'panel-and-repeater-rp1',
      pageId: 'home',
      sourceMode: 'insert',
      rp1: [
        'column #panel-rep-wrap [320xhug] gap=12',
        '  dynamic-panel #quiz-panel [300x120] activeState="front"',
        '    :state "front" layout=stack [300x120]',
        '      label #front-a "Front A" [120x24] x=10 y=10',
        '      label #front-b "Front B" [120x24] x=10 y=44',
        '    :state "back" layout=stack [300x120]',
        '      label #back-a "Back A" [120x24] x=10 y=10',
        '  repeater #rep-list [300x120] dataset="items" key="id" rowHeight=40 rowGap=6 pageSize=5',
        '    :template',
        '      box #rep-tpl [300x40] layout=stack',
        '        label #rep-item-id "=item.id" [80x24] x=8 y=8',
      ].join('\n'),
    });
    assert.equal(viaPanelAndRepeater.ok, true, JSON.stringify(viaPanelAndRepeater));
    assert.equal(node(studio.store, 'quiz-panel').states[0].root.children.length, 2);
    assert.equal(node(studio.store, 'rep-list').template.id, 'rep-tpl');
  } finally { await client.close(); await studio.close(); rmSync(dir, { recursive: true, force: true }); }
});
