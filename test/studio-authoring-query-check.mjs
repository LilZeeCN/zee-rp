import test from 'node:test';
import assert from 'node:assert/strict';
import { importToStudioDocument } from '../studio/document.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { queryAuthoringNodes } from '../studio/authoring-query.mjs';

function fixture() {
  return importToStudioDocument({ domain: 'web', components: {
    Small: { root: { id: 'small_root', type: 'box', layout: 'row', w: 180, h: 44, children: [{ id: 'caption', type: 'label', text: '组件文字', w: 140, h: 30 }] } },
  }, pages: [
    { id: 'home', domain: 'web', root: { id: 'root', type: 'box', layout: 'stack', w: 500, h: 800, padding: [20, 16, 0, 16], children: [
      { id: 'title', type: 'label', role: 'heading', text: '首页标题', x: 8, y: 8, w: 250, h: 40 },
      { id: 'group', type: 'box', layout: 'stack', x: 30, y: 80, w: 300, h: 120, padding: [12, 8, 0, 8], children: [{ id: 'note', role: 'note', type: 'label', text: '例句 A', x: 10, y: 15, w: 180, h: 32 }] },
      { id: 'flow', type: 'box', layout: 'column', x: 20, y: 250, w: 300, h: 130, gap: 12, children: [{ id: 'first', type: 'label', text: '第一行', h: 30 }, { id: 'second', type: 'label', text: '第二行', h: 30 }] },
      { id: 'card', type: 'card', x: 20, y: 420, w: 300, h: 120, title: '宏标题', body: '宏正文' },
      { id: 'small', type: 'instance', component: 'Small', x: 20, y: 600 },
    ] } },
    { id: 'other', domain: 'web', root: { id: 'other_root', type: 'box', layout: 'stack', w: 500, h: 800, children: [{ id: 'title', role: 'heading', type: 'label', text: '另一页标题', w: 250, h: 40 }] } },
  ] });
}
const query = (doc, args = {}) => queryAuthoringNodes({ doc, scene: resolveDocumentScene(doc), args });
function run(store, command) {
  const result = store.applyTransaction({ baseRevision: store.appliedRevision, idempotencyKey: `query-${store.appliedRevision}`, commands: [command] });
  assert.equal(result.ok, true, JSON.stringify(result));
}

test('semantic query combines explicit page, scope, role, type and complete text search', () => {
  const doc = fixture();
  const result = query(doc, { pageId: 'home', within: 'group', role: 'note', type: 'label', textContains: '例句' });
  assert.equal(result.total, 1); assert.equal(result.returned, 1);
  assert.equal(result.nodes[0].editableTargetId, 'home/note');
  assert.equal(result.nodes[0].source.pointer, '/pages/0/root/children/1/children/0');
  const empty = query(doc, { pageId: 'other', role: 'note' });
  assert.equal(empty.empty, true); assert.deepEqual(empty.nodes, []); assert.equal(empty.total, 0);
  assert.throws(() => query(doc, { pageId: 'missing' }), { code: 'E_PAGE_NOT_FOUND' });
  assert.throws(() => query(doc, { pageId: 'other', nodeIds: ['home/title'] }), { code: 'E_NODE_NOT_FOUND' });
  assert.throws(() => query(doc, { pageId: 'home', within: 'missing' }), { code: 'E_NODE_NOT_FOUND' });
});

test('cross-page repeated IDs require a scoped target and never select another page', () => {
  const doc = fixture();
  assert.throws(() => query(doc, { nodeIds: ['title'] }), error => error.code === 'E_AMBIGUOUS_NODE' && error.candidates.length === 2);
  assert.equal(query(doc, { nodeId: 'other/title' }).nodes[0].text, '另一页标题');
  assert.equal(query(doc, { pageId: 'home', nodeId: 'title' }).nodes[0].text, '首页标题');
});

test('source coordinates and parent padding stay separate from resolved screen coordinates', () => {
  const result = query(fixture(), { pageId: 'home', nodeIds: ['note'] }).nodes[0];
  assert.deepEqual(result.bounds, { x: 64, y: 127, w: 180, h: 32 });
  assert.equal(result.layoutContext.sourceX, 10); assert.equal(result.layoutContext.sourceY, 15);
  assert.deepEqual(result.layoutContext.parentPadding, [12, 8, 0, 8]);
  assert.deepEqual(result.source.properties, { x: 10, y: 15, w: 180, h: 32 });
});

test('flow guidance returns a valid command on the actual parent, not an ignored position write', () => {
  const store = new StudioDocumentStore(fixture());
  const node = query(store.doc, { pageId: 'home', nodeIds: ['second'] }).nodes[0];
  const guidance = node.controls.find(control => control.kind === 'flow-layout').suggestion;
  assert.equal(guidance.command.nodeId, 'home/flow');
  guidance.command.layout.gap = 24; run(store, guidance.command);
  assert.equal(query(store.doc, { pageId: 'home', nodeIds: ['second'] }).nodes[0].bounds.y - node.bounds.y, 12);
});

test('macro-derived nodes expose a real macro parameter and do not pretend to be source nodes', () => {
  const store = new StudioDocumentStore(fixture());
  const node = query(store.doc, { pageId: 'home', nodeIds: ['card_title'] }).nodes[0];
  assert.equal(node.source, null); assert.equal(node.target.kind, 'macro-parameter');
  assert.equal(node.target.nodeId, 'home/card'); assert.equal(node.target.property, 'title');
  const before = store.doc.contentHash;
  const escaped = store.applyTransaction({ baseRevision: store.appliedRevision, commands: [{ type: 'setText', pageId: 'home', nodeId: 'card_title', text: '不得误改组件' }] });
  assert.equal(escaped.code, 'E_NODE_NOT_FOUND');
  assert.equal(store.doc.contentHash, before);
  const command = node.suggestedEdit.command; command.properties.title = '修改后的宏标题'; run(store, command);
  assert.equal(query(store.doc, { pageId: 'home', nodeId: 'card_title' }).nodes[0].text, '修改后的宏标题');
});

test('component descendants map to a real instance override and preserve its definition', () => {
  const store = new StudioDocumentStore(fixture());
  const original = JSON.stringify(store.doc.components.Small);
  const node = query(store.doc, { pageId: 'home', nodeIds: ['small__caption'] }).nodes[0];
  assert.equal(node.source, null); assert.equal(node.target.kind, 'instance-override');
  assert.equal(node.target.nodeId, 'home/small'); assert.equal(node.target.subNodeId, 'caption');
  const command = node.suggestedEdit.command; command.properties.text = '只改实例'; run(store, command);
  assert.equal(query(store.doc, { pageId: 'home', nodeId: 'small__caption' }).nodes[0].text, '只改实例');
  assert.equal(JSON.stringify(store.doc.components.Small), original);
});

test('pagination resumes its original query and rejects stale documents, changed scopes and invalid cursors', () => {
  const store = new StudioDocumentStore(fixture());
  const first = query(store.doc, { pageId: 'home', type: 'label', limit: 2 });
  const next = query(store.doc, { cursor: first.nextCursor });
  assert.equal(next.pageId, 'home'); assert.equal(next.limit, 2); assert.equal(next.offset, 2);
  const all = query(store.doc, { pageId: 'home', type: 'label' });
  assert.deepEqual([...first.nodes, ...next.nodes].map(node => node.id), all.nodes.slice(0, 4).map(node => node.id));
  assert.throws(() => query(store.doc, { cursor: first.nextCursor, pageId: 'other' }), { code: 'E_QUERY_CURSOR_MISMATCH' });
  assert.throws(() => query(store.doc, { cursor: first.nextCursor, offset: 0 }), { code: 'E_QUERY_CURSOR' });
  assert.throws(() => query(store.doc, { cursor: 'broken' }), { code: 'E_QUERY_CURSOR' });
  run(store, { type: 'setText', pageId: 'home', nodeId: 'title', text: '新版本' });
  assert.throws(() => query(store.doc, { cursor: first.nextCursor }), { code: 'E_STALE_QUERY_CURSOR' });
});

test('projection preserves identity, full view retains original fields and returned data cannot mutate the document', () => {
  const doc = fixture();
  const compact = query(doc, { pageId: 'home', nodeId: 'note', fields: ['text', 'bounds'] }).nodes[0];
  assert.deepEqual(Object.keys(compact).sort(), ['id', 'scopedId', 'pageId', 'text', 'bounds'].sort());
  const full = query(doc, { pageId: 'home', nodeId: 'note', view: 'full' }).nodes[0];
  assert.equal(typeof full.layout, 'string'); assert.equal(full.fontSize, 14); assert.ok(full.authoring.target);
  full.authoring.source.properties.x = 999; full.css = { color: 'red' };
  assert.equal(query(doc, { pageId: 'home', nodeId: 'note' }).nodes[0].layoutContext.sourceX, 10);
  assert.throws(() => query(doc, { fields: ['fontSzie'] }), { code: 'E_QUERY_FIELDS' });
  assert.throws(() => query(doc, { limit: 0 }), { code: 'E_QUERY_LIMIT' });
  assert.throws(() => query(doc, { offset: -1 }), { code: 'E_QUERY_OFFSET' });
  assert.throws(() => query(doc, { view: 'unknown' }), { code: 'E_QUERY_VIEW' });
});
