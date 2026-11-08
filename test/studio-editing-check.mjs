import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyStudioDocument, normalizeStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { reviewDesign } from '../studio/design-review.mjs';

function fixture() {
  const doc = createEmptyStudioDocument();
  doc.pages[0].root = { id: 'root', type: 'box', layout: 'stack', w: 402, h: 874, padding: [60, 16, 0, 16], children: [
    { id: 'title', type: 'label', x: 16, y: 80, w: 180, h: 40, fontSize: 24, text: '今日学习' },
    { id: 'group', type: 'box', layout: 'stack', x: 30, y: 150, w: 300, h: 400, padding: [20, 12, 0, 12], children: [
      { id: 'a', role: 'note', type: 'label', x: 20, y: 30, w: 80, h: 40, text: '例句 A' },
      { id: 'b', role: 'note', type: 'label', x: 100, y: 90, w: 100, h: 40, text: '例句 B' },
      { id: 'c', type: 'button', x: 60, y: 180, w: 100, h: 44, text: '继续' },
    ] },
  ] };
  return new StudioDocumentStore(doc);
}
function apply(store, commands, extra = {}) {
  return store.applyTransaction({ baseRevision: store.appliedRevision, idempotencyKey: `test-${store.appliedRevision}-${Math.random()}`, commands, ...extra });
}
const edit = (operation, nodeIds, rest = {}) => ({ type: 'editNodes', select: { pageId: 'home', nodeIds }, operation, ...rest });
const sceneNode = (store, id) => resolveDocumentScene(store.doc).pages[0].nodes.find(n => n.id === id);

test('new page is freely positioned with explicit layout roots preserved', () => {
  const store = fixture();
  assert.ok(apply(store, [{ type: 'addPage', pageId: 'new' }]).ok);
  assert.equal(store.doc.pages[1].root.layout, 'stack'); assert.equal(store.doc.pages[1].root.padding, 0);
  assert.ok(apply(store, [{ type: 'addPage', pageId: 'flow', root: { type: 'box', id: 'flowroot', layout: 'column', children: [] } }]).ok);
  assert.equal(store.doc.pages[2].root.layout, 'column');
});

test('layout diagnostics reflect changes and removals, including normalized recovery', () => {
  const store = fixture();
  apply(store, [{ type: 'setLayout', nodeId: 'group', layout: 'column' }]);
  assert.equal(store.doc.diagnostics.filter(d => d.code === 'W_LAYOUT_IGNORES_POSITION').length, 3);
  apply(store, [{ type: 'setLayout', nodeId: 'group', layout: 'stack' }]);
  assert.equal(store.doc.diagnostics.filter(d => d.code === 'W_LAYOUT_IGNORES_POSITION').length, 0);
  store.doc.diagnostics.push({ code: 'W_LAYOUT_IGNORES_POSITION', nodeId: 'deleted', parentLayout: 'column' });
  assert.equal(normalizeStudioDocument(store.doc).diagnostics.length, 0);
});

test('alignment across parents and relative placement use source coordinates without reapplying padding', () => {
  const store = fixture();
  const title = sceneNode(store, 'title');
  let result = apply(store, [edit('align', ['a', 'b'], { edge: 'left', referenceId: 'title' })]);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(sceneNode(store, 'a').x, title.x); assert.equal(sceneNode(store, 'b').x, title.x);
  result = apply(store, [edit('place', ['a'], { side: 'below', referenceId: 'title', gap: 20 }), edit('move', ['a'], { dy: 8 })]);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(sceneNode(store, 'a').y, title.y + title.h + 28);
  assert.ok(result.transitiveImpact.affectedPageIds.includes('home'));
});

test('scoped semantic batch changes are atomic and support token binding, undo and redo', () => {
  const store = fixture();
  const before = sceneNode(store, 'a').color;
  const result = apply(store, [{ type: 'setToken', name: 'study-note', value: '#324534' },
    { type: 'editNodes', select: { pageId: 'home', within: 'group', role: 'note', type: 'label', textContains: '例句' }, operation: 'set', properties: { color: '$study-note', fontSize: 18 } }]);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(sceneNode(store, 'a').color, '#324534'); assert.equal(sceneNode(store, 'b').fontSize, 18);
  assert.notEqual(sceneNode(store, 'title').fontSize, 18);
  assert.ok(store.undo().ok); assert.equal(sceneNode(store, 'a').color, before);
  assert.ok(store.redo().ok); assert.equal(sceneNode(store, 'a').color, '#324534');
});

test('distribute preserves variable widths and uses visual order and exact gap', () => {
  const store = fixture();
  const result = apply(store, [edit('distribute', ['b', 'a', 'c'], { axis: 'y', gap: 12 })]);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(sceneNode(store, 'b').y - (sceneNode(store, 'a').y + sceneNode(store, 'a').h), 12);
  assert.equal(sceneNode(store, 'c').y - (sceneNode(store, 'b').y + sceneNode(store, 'b').h), 12);
});

test('invalid selections and a locked member reject the entire transaction; no partial styling', () => {
  const store = fixture();
  apply(store, [{ type: 'setProperties', nodeId: 'b', properties: { locked: true } }]);
  const original = JSON.stringify(store.doc);
  const result = apply(store, [edit('set', ['a', 'b'], { properties: { fontSize: 32 } })]);
  assert.equal(result.code, 'E_NODE_LOCKED'); assert.equal(JSON.stringify(store.doc), original);
  assert.equal(apply(store, [{ type: 'editNodes', select: { pageId: 'home' }, operation: 'set', properties: { color: '#111111' } }]).code, 'E_SELECTION_REQUIRED');
  assert.equal(apply(store, [{ type: 'editNodes', select: { role: 'missing' }, operation: 'move', dx: 10 }]).code, 'E_SELECTION_EMPTY');
});

test('ambiguous references return candidates and do not move unrelated pages', () => {
  const store = fixture();
  apply(store, [{ type: 'addPage', pageId: 'other', root: { id: 'otherroot', type: 'box', layout: 'stack', children: [{ id: 'title', type: 'label', text: '另一页' }] } }]);
  const result = apply(store, [{ type: 'editNodes', select: { nodeIds: ['title'] }, operation: 'set', properties: { color: '#111111' } }]);
  assert.equal(result.code, 'E_AMBIGUOUS_NODE'); assert.equal(result.candidates.length, 2);
});

test('free positioning refuses flow, transformed planes, anchored nodes, and nested selection', () => {
  for (const [properties, code] of [[{ layout: 'column' }, 'E_RELATION_LAYOUT'], [{ css: { transform: 'rotate(10deg)' } }, 'E_RELATION_TRANSFORM']]) {
    const store = fixture(); apply(store, [{ type: 'setProperties', nodeId: 'group', properties }]);
    assert.equal(apply(store, [edit('move', ['a'], { dx: 12 })]).code, code);
  }
  const store = fixture();
  assert.equal(apply(store, [edit('move', ['group', 'a'], { dy: 8 })]).code, 'E_RELATION_NESTED');
  apply(store, [{ type: 'setProperties', nodeId: 'a', properties: { after: 'b' } }]);
  assert.equal(apply(store, [edit('move', ['a'], { dy: 8 })]).code, 'E_RELATION_CONSTRAINT');
});

test('real screenshot comparisons retain immutable prior pixels and track deleted, changed and added nodes', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-edit-review-'));
  const path = join(dir, 'source.json'); writeFileSync(path, JSON.stringify(fixture().doc));
  const { studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath: path, port: 0 });
  try {
    const before = await reviewDesign(studio, { pageId: 'home', baseRevision: studio.store.appliedRevision });
    const initialBytes = readFileSync(before.screenshot.outPath);
    const response = await fetch(`${studio.url}/api/commands`, { method: 'POST', body: JSON.stringify({ baseRevision: studio.store.appliedRevision, idempotencyKey: 'real-compare', commands: [
      edit('move', ['a'], { dy: 8 }), { type: 'setText', nodeId: 'title', text: '本周词汇' },
      { type: 'deleteNode', nodeId: 'b' }, { type: 'addNode', parentId: 'group', node: { id: 'new', type: 'label', x: 20, y: 100, text: '新词' } },
    ] }) });
    assert.ok((await response.json()).ok);
    const client = new Client({ name: 'editing-check', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))], stderr: 'pipe' });
    let after;
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.find(t => t.name === 'studio_design').inputSchema.properties.compareWithReviewId);
      const raw = await client.callTool({ name: 'studio_design', arguments: { action: 'review', url: studio.url, pageId: 'home', baseRevision: studio.store.appliedRevision, compareWithReviewId: before.reviewId } });
      after = JSON.parse(raw.content[0].text);
      assert.equal(raw.content.filter(c => c.type === 'image').length, 2);
      assert.equal(raw.content.filter(c => c.type === 'image')[0].data, initialBytes.toString('base64'));
      const batch = await client.callTool({ name: 'studio_command', arguments: { url: studio.url, baseRevision: studio.store.appliedRevision, idempotencyKey: 'mcp-edit-selection', commands: [edit('move', ['a'], { dx: 1 })] } });
      assert.ok(JSON.parse(batch.content[0].text).ok);
      assert.ok(!after.findings.some(f => f.check === 'grid-alignment' && f.severity === 'error'));
    } finally { await client.close(); }

    assert.equal(after.comparison.changedNodes.find(n => n.nodeId === 'b').status, 'removed');
    assert.equal(after.comparison.changedNodes.find(n => n.nodeId === 'new').status, 'added');
    assert.ok(after.comparison.changedNodes.find(n => n.nodeId === 'title').changedFields.includes('text'));
    const image = await fetch(`${studio.url}/api/design/reviews/${before.reviewId}/image`);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), initialBytes);
    const list = await (await fetch(`${studio.url}/api/design/reviews?pageId=home`)).json();
    assert.equal(list.reviews.length, 2);
    await assert.rejects(() => reviewDesign(studio, { pageId: 'home', baseRevision: before.revision }), { code: 'E_STALE_REVIEW' });
    writeFileSync(before.screenshot.outPath, 'tampered');
    await assert.rejects(() => reviewDesign(studio, { pageId: 'home', baseRevision: studio.store.appliedRevision, compareWithReviewId: before.reviewId }), { code: 'E_REVIEW_IMAGE_CHANGED' });
  } finally { await studio.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('browser pointer dragging at two zoom levels and queued edits preserve source coordinates and revision order', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-edit-pointer-'));
  const doc = fixture().doc; doc.pages[0].root.children[1].y = 500;
  const path = join(dir, 'source.json'); writeFileSync(path, JSON.stringify(doc));
  const { studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath: path, port: 0 });
  try {
    const page = await studio.ensureManagedBrowserPage();
    for (const zoom of [0.395, 0.69]) {
      await page.evaluate(`window.__STUDIO_APP__.selectNodes(['title'], 'home'); window.__STUDIO_APP__.setPanZoom(420, 140, ${zoom});`);
      const before = await page.evaluate(`(() => { const n=window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='title'); const r=document.querySelector('[data-node-id="title"]').getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return { x,y, sourceY:n.sourceY, hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,200) };  })()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', buttons: 1, clickCount: 1 });
      const drag = await page.evaluate(`({kind:window.__STUDIO_STATE__.dragSession?.kind,nodeId:window.__STUDIO_STATE__.dragSession?.nodeId})`);
      assert.equal(drag.kind, 'move', JSON.stringify({before,drag}));
      assert.equal(drag.nodeId, 'title', JSON.stringify({before,drag}));
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + 20, y: before.y + 20, buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + 20, y: before.y + 20, button: 'left', clickCount: 1 });
      const after = await page.evaluate(`(async () => { for (let i=0;i<100;i++){const s=window.__STUDIO_STATE__;const n=s.scene.pages[0].nodes.find(n=>n.id==='title'); if(n.sourceY!==${before.sourceY}) return n.sourceY; await new Promise(r=>setTimeout(r,20));} throw Error('drag did not persist: '+JSON.stringify({state:window.__STUDIO_STATE__.lastError,source:window.__STUDIO_STATE__.scene.pages[0].nodes.find(n=>n.id==='title').sourceY})); })()`);
      assert.ok(Math.abs(after - before.sourceY - 20 / zoom) < 1.5, JSON.stringify({ zoom, before, after }));
    }
    const queued = await page.evaluate(`(async () => { const a=window.__STUDIO_APP__; const result=await Promise.all([
      a.dispatchCommands({type:'setText',nodeId:'title',text:'连续提交一'}),
      a.dispatchCommands({type:'setText',nodeId:'a',text:'连续提交二'})
    ]); return result.map(r=>({ok:r.ok,base:r.baseRevision,revision:r.appliedRevision})); })()`);
    assert.ok(queued.every(r => r.ok)); assert.equal(queued[1].base, queued[0].revision);
    assert.equal(studio.store.doc.pages[0].root.x, undefined);
    const newPage = await page.evaluate(`(async () => {
      const a=window.__STUDIO_APP__;
      const pending=a.dispatchCommands({type:'setText',nodeId:'title',text:'建页前的修改'});
      document.getElementById('btn-sidebar-add-page').click();
      await pending;
      for(let i=0;i<100;i++) { if(a.state.activePageId==='page_2') return {active:a.state.activePageId,layout:a.state.doc.pages[1].root.layout}; await new Promise(r=>setTimeout(r,20)); }
      throw Error('new page was not activated after pending edit');
    })()`);
    assert.deepEqual(newPage,{active:'page_2',layout:'stack'});
  } finally { await studio.stop(); rmSync(dir, { recursive: true, force: true }); }
});
