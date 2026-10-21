// Decode the written native GUID paths independently of writer reports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixturePath } from './native-inputs.mjs';
import { fileURLToPath } from 'node:url';
import { addInteractions, pageWidgetContexts } from '../scripts/ix-actions.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';

let passed = 0;
function check(name, body) { body(); passed++; console.log(`PASS ${name}`); }
const fixture = name => readFileSync(fixturePath(name));
const source = fixture('panel-replace-roundtrip.rp');
const contexts = pageWidgetContexts(source, 'Page 1');
const widgetGuid = name => {
  const context = contexts.find(c => c.widgets.some(w => field(field(w.body, 'name-block'), 'text')?.text === name));
  const widget = context.widgets.find(w => field(field(w.body, 'name-block'), 'text')?.text === name);
  return context.graph.roots.find(n => n.tag === 0x1e).values[widget.id - 1];
};
function write(buf, widget, actions, extra = {}) {
  return addInteractions(buf, { page: 'Page 1', widget, ...extra },
    [{ event: 'OnClick', cases: [{ actions }] }], { replaceEvent: true });
}
function checkPath(result, expected) {
  const record = readRecords(result.file).find(r => r.index === result.report.record);
  const graph = parsePayload(record);
  const guids = graph.roots.find(n => n.tag === 0x1e).values;
  const paths = [...graph.objects.values()].filter(o => o.className === 'Axure:DiagramObjectPath');
  assert(paths.some(p => guids[field(p.body, 'object-id').value - 1] === expected));
  const summary = readRp(result.file);
  assert.equal(summary.counts.danglingRefs, 0);
  assert.equal(summary.problems.length, 0);
}

check('panel-state owner is actually modified', () => {
  const result = write(source, 'NATIVE_TEXT_FIELD', [{ type: 'set-text', target: 'NATIVE_TEXT_FIELD', text: 'inside' }]);
  assert.equal(readRecords(result.file).find(r => r.index === result.report.record).className, 'Axure:PanelState');
  checkPath(result, widgetGuid('NATIVE_TEXT_FIELD'));
});
check('state-to-root text path preserves target GUID', () => {
  const result = write(source, 'NATIVE_TEXT_FIELD', [{ type: 'set-text', target: 'SHOW_FORM', text: 'outside' }]);
  checkPath(result, widgetGuid('SHOW_FORM'));
});
check('root-to-state text path preserves target GUID', () => {
  const result = write(source, 'SHOW_FORM', [{ type: 'set-text', target: 'NATIVE_TEXT_FIELD', text: 'inside' }]);
  checkPath(result, widgetGuid('NATIVE_TEXT_FIELD'));
});
check('state-to-parent panel-state action imports diagram GUID', () => {
  const result = write(source, 'NATIVE_TEXT_FIELD', [{ type: 'set-panel-state', target: 'CONTENT_PANEL', state: 'Visual' }]);
  checkPath(result, widgetGuid('CONTENT_PANEL'));
  const record = readRecords(result.file).find(r => r.index === result.report.record);
  const graph = parsePayload(record);
  const table = graph.roots.find(n => n.tag === 0x1e).values;
  const state = [...graph.objects.values()].find(o => o.className === 'Axure:SetPanelStateInfo');
  const original = contexts.find(c => c.container.includes('CONTENT_PANEL(Visual)'));
  const diagram = [...original.graph.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
  const expected = original.graph.roots.find(n => n.tag === 0x1e).values[diagram.id - 1];
  assert.equal(table[field(state.body, 'diagram-id').value - 1], expected);
});
check('explicit container selects state owner', () => {
  const result = write(source, 'NATIVE_TEXT_FIELD', [{ type: 'wait', ms: 1 }], { container: ['CONTENT_PANEL(Form)'] });
  assert.equal(result.report.record, contexts.find(c => c.container.includes('CONTENT_PANEL(Form)')).r.index);
});
check('wrong container is rejected', () => {
  assert.throws(() => write(source, 'NATIVE_TEXT_FIELD', [{ type: 'wait', ms: 1 }], { container: ['CONTENT_PANEL(Visual)'] }), /found 0/);
});
check('missing trigger cannot be silently skipped', () => {
  assert.throws(() => write(source, 'ABSENT', [{ type: 'wait', ms: 1 }]), /found 0/);
});
check('nested native state owner can address grandparent panel', () => {
  const nested = fixture('panel-nested-two-level-roundtrip.rp');
  const result = write(nested, 'NATIVE_TEXT_FIELD', [{ type: 'set-panel-state', target: 'OUTER_PANEL', state: 'Imported' }]);
  const summary = readRp(result.file);
  assert.equal(summary.counts.danglingRefs, 0);
  assert.equal(summary.problems.length, 0);
  assert.equal(readRecords(result.file).find(r => r.index === result.report.record).className, 'Axure:PanelState');
});
console.log(`${passed} scoped native checks passed`);
