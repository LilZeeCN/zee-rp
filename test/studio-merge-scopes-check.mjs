import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeStudioDocument, computeContentHash } from '../studio/document.mjs';
import { mergeStudioDocuments } from '../studio/document-merge.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { studioHandlers } from '../studio/mcp-adapter.mjs';
import { spawnSync } from 'node:child_process';

function source() {
  const state = (id, text) => ({ id, name: id, root: { id: 'local_root', type: 'box', w: 300, h: 120, children: [{ id: 'caption', type: 'label', text, w: 200, h: 30 }] } });
  return { pages: [{ id: 'home', root: { id: 'root', type: 'box', w: 600, h: 500, children: [
    { id: 'heading', type: 'label', text: 'Heading', w: 200, h: 30 },
    { id: 'footer', type: 'label', text: 'Footer', w: 200, h: 30, y: 400 },
    { id: 'panel', type: 'dynamic-panel', w: 300, h: 120, y: 40, activeState: 'a', states: [state('a', 'First'), state('b', 'Second')] },
    { id: 'list', type: 'repeater', w: 300, h: 100, y: 200, rows: [{ title: 'one' }], template: { id: 'local_root', type: 'box', w: 300, h: 40, children: [{ id: 'caption', type: 'label', text: '=item.title', w: 200, h: 30 }] } },
  ] } }] };
}
const node = (doc, id) => doc.pages[0].root.children.find(n => n.id === id);
const values = doc => ({ states: node(doc, 'panel')?.states.map(s => s.root.children[0].text), template: node(doc, 'list')?.template.children[0].text });

test('merge preserves identical and independent edits across legal panel/template local ID scopes', () => {
  const base = normalizeStudioDocument(source());
  const identical = mergeStudioDocuments({ baseDoc: base, oursDoc: structuredClone(base), theirsDoc: structuredClone(base) });
  assert.equal(identical.ok, true);
  assert.deepEqual(values(identical.mergedDoc), values(base));
  assert.equal(computeContentHash(identical.mergedDoc), computeContentHash(base));
  const ours = structuredClone(base), theirs = structuredClone(base);
  node(ours, 'panel').states[0].root.children[0].text = 'Human first state';
  node(theirs, 'panel').states[1].root.children[0].text = 'AI second state';
  node(theirs, 'list').template.children[0].color = '#123456';
  const merged = mergeStudioDocuments({ baseDoc: base, oursDoc: ours, theirsDoc: theirs });
  assert.equal(merged.ok, true, JSON.stringify(merged.conflicts));
  assert.deepEqual(values(merged.mergedDoc), { states: ['Human first state', 'AI second state'], template: '=item.title' });
  assert.equal(node(merged.mergedDoc, 'list').template.children[0].color, '#123456');
});

test('deleting panels/repeaters conflicts with edits inside inactive states/templates in either direction', () => {
  for (const id of ['panel', 'list']) for (const reverse of [false, true]) {
    const base = normalizeStudioDocument(source());
    const deleted = structuredClone(base), edited = structuredClone(base);
    deleted.pages[0].root.children = deleted.pages[0].root.children.filter(n => n.id !== id);
    const target = id === 'panel' ? node(edited, id).states[1].root : node(edited, id).template;
    target.children[0].text = 'Human work';
    const oursDoc = reverse ? edited : deleted, theirsDoc = reverse ? deleted : edited;
    const conflict = mergeStudioDocuments({ baseDoc: base, oursDoc, theirsDoc });
    assert.equal(conflict.ok, false, `${id} reverse=${reverse} must conflict`);
    assert(conflict.conflicts.some(c => c.kind === 'delete-modify' && c.targetId === `home/${id}`));
    const preserved = mergeStudioDocuments({ baseDoc: base, oursDoc, theirsDoc, prefer: reverse ? 'ours' : 'theirs' });
    assert.equal(preserved.ok, true);
    assert(node(preserved.mergedDoc, id), 'explicitly retained container must survive');
    assert(JSON.stringify(preserved.mergedDoc).includes('Human work'));
  }
});

test('merge retains state metadata and detects state deletion, names and ordering conflicts', () => {
  const base = normalizeStudioDocument(source());
  node(base, 'panel').states.push({ id: 'c', name: 'Third', root: { id: 'local_root', type: 'label', text: 'Third', w: 200, h: 30 } });
  for (const reverse of [false, true]) {
    const edited = structuredClone(base), deleted = structuredClone(base);
    node(edited, 'panel').states[1].name = 'Human state name';
    node(deleted, 'panel').states.splice(1, 1);
    const args = { baseDoc: base, oursDoc: reverse ? edited : deleted, theirsDoc: reverse ? deleted : edited };
    assert.equal(mergeStudioDocuments(args).ok, false);
    const kept = mergeStudioDocuments({ ...args, prefer: reverse ? 'ours' : 'theirs' });
    assert(kept.ok); assert.equal(node(kept.mergedDoc, 'panel').states.find(s => s.id === 'b').name, 'Human state name');
  }
  const ours = structuredClone(base), theirs = structuredClone(base);
  node(ours, 'panel').states[0].name = 'Human'; node(theirs, 'panel').states[0].name = 'AI';
  assert.equal(mergeStudioDocuments({ baseDoc: base, oursDoc: ours, theirsDoc: theirs }).ok, false);
  node(ours, 'panel').states = [2, 1, 0].map(i => node(base, 'panel').states[i]);
  node(theirs, 'panel').states = [1, 2, 0].map(i => node(base, 'panel').states[i]);
  assert(mergeStudioDocuments({ baseDoc: base, oursDoc: ours, theirsDoc: theirs }).conflicts.some(c => c.kind === 'structure-order'));
});

test('one-sided page, state and template root replacements survive instead of silently disappearing', () => {
  for (const scope of ['page', 'state', 'template']) for (const reverse of [false, true]) {
    const base = normalizeStudioDocument(source()), changed = structuredClone(base);
    const replacement = { id: 'replacement', type: 'label', text: 'New root', w: 200, h: 30 };
    if (scope === 'page') changed.pages[0].root = replacement;
    if (scope === 'state') node(changed, 'panel').states[0].root = replacement;
    if (scope === 'template') node(changed, 'list').template = replacement;
    const result = mergeStudioDocuments({ baseDoc: base, oursDoc: reverse ? changed : base, theirsDoc: reverse ? base : changed });
    assert(result.ok, JSON.stringify(result));
    const actual = scope === 'page' ? result.mergedDoc.pages[0].root : scope === 'state' ? node(result.mergedDoc, 'panel').states[0].root : node(result.mergedDoc, 'list').template;
    assert.deepEqual(actual, replacement);
  }
});

test('valid independent moves that combine into a cycle reject even with global preference', () => {
  const base = normalizeStudioDocument({ pages: [{ id: 'home', root: { id: 'root', type: 'box', children: [{ id: 'a', type: 'box', children: [] }, { id: 'b', type: 'box', children: [] }] } }] });
  const ours = structuredClone(base), theirs = structuredClone(base);
  const a = ours.pages[0].root.children.shift(); ours.pages[0].root.children[0].children.push(a);
  const b = theirs.pages[0].root.children.pop(); theirs.pages[0].root.children[0].children.push(b);
  for (const prefer of [undefined, 'ours', 'theirs']) {
    const result = mergeStudioDocuments({ baseDoc: base, oursDoc: ours, theirsDoc: theirs, prefer });
    assert.equal(result.ok, false); assert(result.conflicts.some(c => c.kind === 'structure-cycle'));
  }
});

test('public scoped merge, single undo/redo and persisted reopen preserve every untouched state and row template', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-merge-scopes-'));
  const path = join(dir, 'source.json'), projectDir = join(dir, 'project');
  writeFileSync(path, JSON.stringify(source()));
  let studio;
  try {
    ({ studio } = await startStudioServer({ projectDir, sourcePath: path, port: 0 }));
    const before = values(studio.store.doc), baseRevision = studio.store.appliedRevision;
    const human = await studioHandlers.studio_apply_commands({ url: studio.url, baseRevision, idempotencyKey: 'human', commands: [{ type: 'setText', nodeId: 'heading', text: 'Human heading' }] });
    assert.equal(human.ok, true);
    const args = { url: studio.url, baseRevision, theirsCommands: [{ type: 'setText', nodeId: 'footer', text: 'AI footer' }] };
    const preview = await studioHandlers.studio_merge_document({ ...args, mode: 'preview' });
    assert.equal(preview.ok, true);
    const applied = await studioHandlers.studio_merge_document({ ...args, mode: 'apply', previewHash: preview.previewHash, idempotencyKey: 'merge-scopes' });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.deepEqual(values(studio.store.doc), before);
    const revision = studio.store.appliedRevision, hash = studio.store.doc.contentHash;
    const exactRequest = { ...args, mode: 'apply', previewHash: preview.previewHash, idempotencyKey: 'merge-scopes' };
    assert.equal((await studioHandlers.studio_merge_document(exactRequest)).idempotentReplay, true);
    assert.equal((await studioHandlers.studio_merge_document({ ...exactRequest, theirsCommands: [{ type: 'setText', nodeId: 'footer', text: 'Different payload' }] })).code, 'E_IDEMPOTENCY_CONFLICT');
    assert.equal(studio.store.appliedRevision, revision);
    assert.equal(node(studio.store.doc, 'heading').text, 'Human heading');
    assert.equal(node(studio.store.doc, 'footer').text, 'AI footer');
    const undo = await studioHandlers.studio_undo({ url: studio.url });
    assert.equal(undo.ok, true);
    assert.deepEqual(values(studio.store.doc), before);
    assert.equal(node(studio.store.doc, 'footer').text, 'Footer');
    assert.equal(node(studio.store.doc, 'heading').text, 'Human heading');
    assert.equal((await studioHandlers.studio_redo({ url: studio.url })).ok, true);
    assert.equal(studio.store.doc.contentHash, hash);
    assert.equal(studio.store.appliedRevision, revision + 2);
    await studio.close(); studio = null;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { startStudioServer } from ${JSON.stringify(new URL('../studio/server.mjs', import.meta.url).href)};
      import { studioHandlers } from ${JSON.stringify(new URL('../studio/mcp-adapter.mjs', import.meta.url).href)};
      const {studio}=await startStudioServer({projectDir:process.argv[1],port:0});
      try { const before=studio.store.appliedRevision; const result=await studioHandlers.studio_merge_document({...JSON.parse(process.argv[2]),url:studio.url});
        console.log(JSON.stringify({result,before,after:studio.store.appliedRevision,hash:studio.store.doc.contentHash}));
      } finally {await studio.close();}
    `, projectDir, JSON.stringify(exactRequest)], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    const reopened = JSON.parse(child.stdout.trim());
    assert.equal(reopened.result.idempotentReplay, true); assert.equal(reopened.before, reopened.after); assert.equal(reopened.hash, hash);
    ({ studio } = await startStudioServer({ projectDir, port: 0 }));
    assert.equal(studio.store.doc.contentHash, hash);
    assert.deepEqual(values(studio.store.doc), before);
    assert.equal(node(studio.store.doc, 'footer').text, 'AI footer');
  } finally {
    if (studio) await studio.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
