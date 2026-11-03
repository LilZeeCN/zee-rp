import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { cloneLibraryWidget } from '../scripts/clone-library-widget.mjs';
import { setComboBoxOptions } from '../scripts/set-combobox-options.mjs';
import { setListBoxOptions } from '../scripts/set-listbox-options.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';

// Exercise real RP9 library widgets and the serialized expression graph. This is
// structure plus installed JavaScript runtime evidence, not Axure GUI evidence.
const rp9Root = '/Applications/Axure RP 9.app/Contents/Resources/DefaultSettings';
const library = join(rp9Root, 'Libraries/Default.rplib');
const blank = '/Users/lilzee/Library/Application Support/zee-axure/templates/axure-rp9-blank.rp';
const work = mkdtempSync(join(tmpdir(), 'native-form-actions-'));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
const widget = (name, valueType = 'text', accessor) => ({ kind: 'widget', name, valueType, ...(accessor ? { accessor } : {}) });

try {
  let file = join(work, 'blank.rp');
  copyFileSync(blank, file);
  const pageName = readRp(readFileSync(file), { path: file }).pages[0].name;
  let step = 0;
  for (const [sourcePageName, name] of [
    ['Button', 'trigger'], ['Text Field', 'input'], ['Checkbox', 'checkbox'],
    ['Radio Button', 'radio'], ['Droplist', 'combo'], ['List Box', 'list'],
  ]) {
    const out = join(work, `clone-${++step}.rp`);
    cloneLibraryWidget(library, file, out, { sourcePageName, targetPageName: pageName, name, x: 40, y: 40 + step * 48, width: 240, height: 32 });
    file = out;
  }
  const combo = join(work, 'combo.rp');
  setComboBoxOptions(file, combo, pageName, 'combo', ['全部价格', '0-50', '50-200'], { selectedIndex: 1 });
  const list = join(work, 'list.rp');
  setListBoxOptions(combo, list, pageName, 'list', ['A', 'B', 'C'], { selectedIndices: [0, 2] });
  const base = readFileSync(list);
  const build = actions => {
    const result = addInteractions(base, { widget: 'trigger', page: pageName }, [{ event: 'OnClick', actions }]);
    const summary = readRp(result.file, { path: file });
    for (const key of ['danglingRefs', 'sentinelSlotsNonZero', 'problems']) assert.equal(summary.counts[key], 0, key);
    const page = readRecords(result.file).find(r => r.className === 'Axure:Page');
    return parsePayload(page);
  };
  const functions = graph => [...graph.objects.values()].filter(o => o.className === 'Axure:Expr:FCall');
  const getters = graph => functions(graph).filter(o => /^Get/.test(field(o.body, 'function-name').text));
  const setter = (graph, name) => functions(graph).find(o => field(o.body, 'function-name').text === name);
  const read = ast => build([{ type: 'set-text', target: 'trigger', runtime: ast }]);

  for (const [name, ast, expected] of [
    ['checkbox default state', widget('checkbox', 'boolean'), 'GetCheckState'],
    ['radio default state', widget('radio', 'boolean'), 'GetCheckState'],
    ['droplist default option', widget('combo'), 'GetSelectedOption'],
    ['listbox default option', widget('list'), 'GetSelectedOption'],
    ['TextBox text compatibility', widget('input'), 'GetWidgetText'],
    ['shape Selected state', widget('trigger', 'boolean', 'selected'), 'GetCheckState'],
  ]) check(name, () => assert.deepEqual(getters(read(ast)).map(o => field(o.body, 'function-name').text), [expected]));

  check('state and label reads of one widget retain distinct native getters', () => {
    const graph = read({ kind: 'call', fn: 'concat', valueType: 'text', args: [
      { kind: 'call', fn: 'text', valueType: 'text', args: [widget('checkbox', 'boolean', 'checked')] },
      widget('checkbox', 'text', 'text'),
    ] });
    assert.deepEqual(getters(graph).map(o => field(o.body, 'function-name').text), ['GetCheckState', 'GetWidgetText']);
  });

  check('unknown native state accessor is rejected', () => {
    assert.throws(() => read(widget('checkbox', 'boolean', 'cheked')), /accessor/);
  });

  check('selected list option keeps its existing setter semantics', () => {
    const graph = build([{ type: 'set-selected', target: 'combo', value: '50-200' }]);
    const set = setter(graph, 'SetSelectedOption');
    assert(set);
    const value = graph.objects.get(field(set.body, 'args').items[1].value);
    assert.equal(field(value.body, 'value').text, '50-200');
    assert(!setter(graph, 'SetCheckState'));
  });

  check('unchecked and runtime checked actions preserve false and state reads', () => {
    const graph = build([
      { type: 'set-check', target: 'radio', checked: false },
      { type: 'set-check', target: 'checkbox', runtime: { kind: 'call', fn: 'not', valueType: 'boolean', args: [widget('checkbox', 'boolean')] } },
    ]);
    const set = setter(graph, 'SetCheckState');
    const value = graph.objects.get(field(set.body, 'args').items[1].value);
    assert.equal(field(value.body, 'value').text, 'false');
    assert.deepEqual(getters(graph).map(o => field(o.body, 'function-name').text), ['GetCheckState']);
  });

  check('RP9 enabled flags remain boolean and focus targets a form widget', () => {
    const graph = build([{ type: 'disable', target: 'combo' }, { type: 'enable', target: 'checkbox' }, { type: 'focus', target: 'input' }]);
    const flags = [...graph.objects.values()].filter(o => o.className === 'Axure:EnableDisableWidgetsInfo').map(o => field(o.body, 'enable'));
    assert.deepEqual(flags.map(n => [n.tag, n.value]), [[25, false], [25, true]]);
    assert([...graph.objects.values()].some(o => o.className === 'Axure:InteractionSetFocusOnWidgetAction'));
  });

  check('RP9 shipped getter and setter runtime reads and clears native states', () => {
    const states = { checkbox: { selected: true }, radio: { selected: false }, combo: { value: '0-50' }, list: { value: 'A' } };
    const ax = selector => ({ selected(value) { const state = states[selector.slice(1)]; if (value !== undefined) state.selected = value; return state.selected; } });
    ax.INPUT = id => id;
    ax.getElementIdsFromPath = path => path;
    ax.getObjectFromElementId = id => states[id];
    ax.event = { HasSelectionChanged: () => false };
    const context = { $axure: { internal: fn => fn(ax) }, $jobj: id => ({ 0: states[id], length: states[id] ? 1 : 0, val(value) { if (value !== undefined) states[id].value = value; return states[id].value; } }) };
    vm.runInNewContext(readFileSync(join(rp9Root, 'Prototype_Files/resources/scripts/axure/expr.js'), 'utf8'), context);
    const path = id => ({ exprType: 'pathLiteral', value: [id] });
    const call = (fn, id, value) => ax.expr.evaluateExpr({ exprType: 'fcall', functionName: fn, arguments: [path(id), ...(value === undefined ? [] : [{ exprType: 'booleanLiteral', value }])] }, {});
    assert.equal(call('GetCheckState', 'checkbox'), true);
    assert.equal(call('GetCheckState', 'radio'), false);
    assert.equal(call('GetSelectedOption', 'combo'), '0-50');
    assert.equal(call('GetSelectedOption', 'list'), 'A');
    call('SetCheckState', 'checkbox', false);
    assert.equal(call('GetCheckState', 'checkbox'), false);
    call('SetSelectedOption', 'combo', '全部价格');
    assert.equal(call('GetSelectedOption', 'combo'), '全部价格');
  });

  console.log(JSON.stringify({ ok: true, checks, evidence: 'RP9 native structure and installed expression runtime; no GUI assertion' }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
