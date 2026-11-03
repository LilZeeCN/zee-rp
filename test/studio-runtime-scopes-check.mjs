import test from 'node:test';
import assert from 'node:assert/strict';
import { importToStudioDocument } from '../studio/document.mjs';
import { StudioRuntimeSession } from '../studio/runtime.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudioServer } from '../studio/server.mjs';
import { runInteractionSteps } from '../studio/scenario-executors.mjs';

const box = children => ({ id: 'root', type: 'box', w: 500, h: 500, children });
const label = text => ({ id: 'same', type: 'label', text, w: 'hug', h: 'hug' });
const button = (id, actions) => ({ id, type: 'button', text: id, w: 100, h: 44, onClick: actions });
const panel = (id, front, back) => ({ id, type: 'dynamic-panel', w: 300, h: 150, activeState: 'front', states: [{ id: 'front', root: box(front) }, { id: 'back', root: box(back) }] });
const current = (rt, id) => rt.getState().activePageScene.nodes.find(n => n.id === id);

test('runtime text, visibility, input values and panel state stay within their page identity', () => {
  const page = id => ({ id, root: box([label(id), { id: 'input', type: 'input', value: id, w: 100, h: 44 }, panel('panel', [label('Front')], [label('Back')]),
    button('change', [{ type: 'set-text', target: 'same', text: 'Changed' }, { type: 'hide', target: 'same' }, { type: 'set-panel-state', target: 'panel', state: 'back' }])]) });
  const rt = new StudioRuntimeSession(importToStudioDocument({ pages: [page('one'), page('two')] }));
  rt.setInput('input', 'Only one'); rt.click('change'); rt.navigate('two');
  assert.equal(rt.getWidgetText('same'), 'two'); assert(rt.isNodeVisible('same'));
  assert.equal(rt.getWidgetText('input'), 'two'); assert.equal(current(rt, 'panel').activeStateId, 'front');
  assert.equal(rt.getWidgetText('one/same'), 'Changed');
});

test('explicit state targets and local actions preserve same IDs in other states and nested panels', () => {
  const rt = new StudioRuntimeSession(importToStudioDocument({ pages: [{ id: 'home', root: box([
    panel('panel', [label('Front'), { id: 'input', type: 'input', value: 'Front', w: 100, h: 44 }, button('local', [{ type: 'set-text', target: 'same', text: 'Local front' }])], [label('Back'), { id: 'input', type: 'input', value: 'Back', w: 100, h: 44 }]),
    button('change', [{ type: 'set-text', target: 'panel/front/same', text: 'Only front' }, { type: 'hide', target: 'panel/front/same' }]),
    button('flip', [{ type: 'set-panel-state', target: 'panel', state: 'back' }]),
  ]) }] }));
  rt.click('home/panel/front/local'); assert.equal(rt.getWidgetText('panel/front/same'), 'Local front');
  rt.setInput('panel/front/input', 'Only front input'); rt.click('change');
  assert.equal(rt.getWidgetText('panel/front/same'), 'Only front'); assert.equal(rt.isNodeVisible('panel/front/same'), false);
  rt.click('flip'); assert.equal(rt.getWidgetText('panel/back/same'), 'Back'); assert(rt.isNodeVisible('panel/back/same'));
  assert.equal(rt.getWidgetText('input'), 'Back'); assert.equal(rt.getWidgetText('panel/front/input'), 'Only front input');
  assert.throws(() => rt.click('not-a-panel/front/local'), { code: 'E_RUNTIME_NODE_NOT_FOUND' });
});

test('ambiguous active targets reject while qualified targets isolate two panels', () => {
  const rt = new StudioRuntimeSession(importToStudioDocument({ pages: [{ id: 'home', root: box([
    panel('left', [label('Left')], [label('Left back')]), panel('right', [label('Right')], [label('Right back')]),
    button('change', [{ type: 'set-text', target: 'left/front/same', text: 'Changed left' }]),
  ]) }] }));
  assert.throws(() => rt.getWidgetText('same'), { code: 'E_RUNTIME_TARGET_AMBIGUOUS' });
  rt.click('change'); assert.equal(rt.getWidgetText('left/front/same'), 'Changed left'); assert.equal(rt.getWidgetText('right/front/same'), 'Right');
});

test('public generated macro and component child IDs remain readable after scope isolation', () => {
  const rt = new StudioRuntimeSession(importToStudioDocument({ components: { Caption: { root: { id: 'caption_root', type: 'box', w: 200, h: 30, children: [{ id: 'caption', type: 'label', text: 'Instance text', w: 200, h: 30 }] } } }, pages: [{ id: 'home', root: box([
    { id: 'card', type: 'card', title: 'Macro title', w: 300, h: 'hug' },
    { id: 'instanceA', type: 'instance', component: 'Caption', w: 200, h: 30 },
  ]) }] }));
  assert.equal(rt.getWidgetText('home/card_title'), 'Macro title');
  assert.equal(rt.getWidgetText('home/instanceA__caption'), 'Instance text');
});

test('browser pointer replay verifies real panel and dataset state, with a failing negative control', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-browser-state-'));
  const sourcePath = join(dir, 'source.json');
  writeFileSync(sourcePath, JSON.stringify({ datasets: { records: { rows: [{ id: 'a', value: 3 }, { id: 'b', value: 9 }] } }, pages: [{ id: 'home', root: box([
    panel('panel', [label('Front')], [label('Back')]),
    { ...button('change', [{ type: 'set-panel-state', target: 'panel', state: 'back' }, { type: 'dataset-sort', dataset: 'records', field: 'value', order: 'desc' }]), y: 220 },
  ]) }] }));
  let studio;
  try {
    ({ studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath, port: 0 }));
    const page = await studio.ensureManagedBrowserPage();
    const result = await runInteractionSteps(page, studio.store.doc, [
      { action: 'expect', expect: { panelState: { panel: 'front' }, datasetCount: { records: 2 }, datasetFirstRow: { records: { value: 3 } } } },
      { action: 'click', target: 'home/change', expect: { panelState: { panel: 'back' }, datasetFirstRow: { records: { value: 9 } }, text: { 'panel/back/same': 'Back' } } },
    ], { layer: 'browser', startPageId: 'home' });
    assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.assertionCount, 6);
    const negative = await runInteractionSteps(page, studio.store.doc, [{ action: 'expect', expect: { datasetCount: { records: 999 } } }], { layer: 'browser', startPageId: 'home' });
    assert.equal(negative.passed, false); assert(negative.history[0].failures.includes('datasetCount:records'));
  } finally { if (studio) await studio.close(); rmSync(dir, { recursive: true, force: true }); }
});
