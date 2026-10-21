import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { duplicatePage, clonePageByIndex } from '../scripts/duplicate-page.mjs';
import { readRecords, replaceRecord, encodeRecord, readManifest, encodeManifest } from '../scripts/rp-records.mjs';
import { parsePayload, encodePayload, field } from '../scripts/parse-payload.mjs';
import { resolvePanelState } from '../scripts/remove-panel-state-content.mjs';
import { closureOf } from '../scripts/clone-closure.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { validateSemantics } from './check-semantics.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = name => readFileSync(fixtures + name);
const state = (bytes, page) => resolvePanelState(bytes, { page, panel: 'MASTER_PANEL', state: 'Card' }).stateRecord;
const overrideTargets = record => {
  const graph = parsePayload(record), guids = graph.roots.find(n => n.tag === 0x1e).values;
  return [...graph.objects.values()].filter(o => o.className === 'Axure:DiagramObject:ReferenceDiagramObject')
    .flatMap(instance => (field(instance.body, 'ObjectOverrides')?.items ?? []).filter((_, i) => i % 2 === 0)
      .map(ref => guids[field(graph.objects.get(ref.value).body, 'object-id').value - 1]));
};
const changeRecord = (bytes, recordIndex, mutate) => {
  const record = readRecords(bytes).find(r => r.index === recordIndex), graph = parsePayload(record);
  mutate(graph);
  return replaceRecord(bytes, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
};
export function runCopyPathSemanticsChecks({ log = () => {} } = {}) {
const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, passed: true }); log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); log(`FAIL ${name}: ${error.message}`); }
};

check('shared Master child override identities survive both page clone entry points', () => {
  const bytes = read('panel-direct-image-base.rp');
  const original = overrideTargets(state(bytes, 'Page 1'));
  assert.equal(original.length, 6);
  for (const clone of [
    () => duplicatePage(bytes, 'Page 1', 'Copy').file,
    () => clonePageByIndex(bytes, readRecords(bytes).find(r => r.className === 'Axure:Page').index, 'Copy').file
  ]) {
    const output = clone();
    assert.deepEqual(overrideTargets(state(output, 'Copy')), original);
    assert.equal(validateSemantics(output).valid, true);
    assert.deepEqual(overrideTargets(state(output, 'Page 1')), original);
  }
});

check('a random in-range override GUID is diagnosed rather than accepted', () => {
  const bytes = read('panel-direct-image-base.rp'), record = state(bytes, 'Page 1');
  const bad = changeRecord(bytes, record.index, graph => {
    const path = graph.objects.get(21), slot = field(path.body, 'object-id').value;
    graph.roots.find(n => n.tag === 0x1e).values[slot - 1] = '12345678123456781234567812345678';
  });
  const result = validateSemantics(bad);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(v => v.category === 'interaction-path-integrity'));
  assert.throws(() => duplicatePage(bad, 'Page 1', 'Copy'), /path|target/i);
});

check('a cross-record widget target is remapped with its owned state definition', () => {
  const bytes = read('panel-nested-two-level-roundtrip.rp'), records = readRecords(bytes);
  const sourceRecord = records.filter(r => r.className === 'Axure:PanelState').find(record => {
    const graph = parsePayload(record), active = closureOf(graph, graph.roots.find(n => n.tag === 0xf).value);
    return [...graph.objects.values()].some(o => o.className === 'Axure:DiagramObjectPath' && active.has(o.id));
  });
  const sourceGraph = parsePayload(sourceRecord);
  const pageRecord = records.find(r => r.className === 'Axure:Page');
  const pageGraph = parsePayload(pageRecord);
  const target = [...pageGraph.objects.values()].find(o => o.className === 'Axure:DiagramObject:DynamicPanel');
  const targetGuid = pageGraph.roots[0].values[target.id - 1];
  const active = closureOf(sourceGraph, sourceGraph.roots.find(n => n.tag === 0xf).value);
  const path = [...sourceGraph.objects.values()].find(o => o.className === 'Axure:DiagramObjectPath' && active.has(o.id));
  assert.ok(target && path);
  // Reuse a real active action's native path, selecting an outer Page widget
  // rather than its current local state widget.
  const withTarget = changeRecord(bytes, sourceRecord.index, graph => {
    const guids = graph.roots[0].values;
    guids.push(targetGuid);
    field(graph.objects.get(path.id).body, 'object-id').value = guids.length;
  });
  assert.equal(validateSemantics(withTarget).valid, true);
  const output = duplicatePage(withTarget, 'Page 1', 'Copy').file;
  const outRecords = readRecords(output), outPage = outRecords.filter(r => r.className === 'Axure:Page').at(-1);
  const outPageGraph = parsePayload(outPage), mapped = outPageGraph.roots[0].values[target.id - 1];
  const oldPackages = new Set(records.filter(r => r.className === 'Axure:PanelState').map(r => {
    const graph = parsePayload(r); return graph.roots[0].values[graph.roots.find(n => n.tag === 0x12).value - 1];
  }));
  const copiedState = outRecords.filter(r => r.className === 'Axure:PanelState').find(r => {
    const graph = parsePayload(r), guids = graph.roots[0].values;
    return !oldPackages.has(guids[graph.roots.find(n => n.tag === 0x12).value - 1]) && guids.includes(mapped);
  });
  const outStateGraph = parsePayload(copiedState);
  assert.notEqual(mapped, targetGuid);
  assert.equal(outStateGraph.roots[0].values[field(outStateGraph.objects.get(path.id).body, 'object-id').value - 1], mapped);
  assert.ok(!outStateGraph.roots[0].values.includes(targetGuid));
  assert.equal(validateSemantics(output).valid, true);
});

check('PanelState reparenting to a different page is diagnosed', () => {
  const bytes = duplicatePage(read('panel-nested-two-level-roundtrip.rp'), 'Page 1', 'Copy').file;
  const manifest = readManifest(bytes), pages = Object.values(manifest.value.root.children)
    .filter(node => Object.keys(node.children ?? {}).length === 3);
  assert.equal(pages.length, 2);
  const [key, child] = Object.entries(pages[0].children)[0];
  delete pages[0].children[key];
  pages[1].children[key] = child;
  const bad = Buffer.concat([encodeManifest(bytes, manifest.value), bytes.subarray(manifest.dataStart)]);
  const result = validateSemantics(bad);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(v => v.category === 'panel-state-owner'));
});

check('rdo-path resolves a shared Master child and rejects a non-instance hop', () => {
  const original = read('panel-direct-image-base.rp');
  const bytes = addInteractions(original, 'Show Card', [{ event: 'OnClick', actions: [
    { type: 'set-text', target: 'Show Card', text: 'Scoped value' }
  ] }]).file;
  const cardGraph = parsePayload(state(bytes, 'Page 1'));
  const instance = [...cardGraph.objects.values()].find(o => o.className === 'Axure:DiagramObject:ReferenceDiagramObject');
  const instanceGuid = cardGraph.roots[0].values[instance.id - 1];
  const targetGuid = cardGraph.roots[0].values[field(cardGraph.objects.get(20).body, 'object-id').value - 1];
  const record = readRecords(bytes).find(r => r.className === 'Axure:Page');
  const pathId = [...parsePayload(record).objects.values()].filter(o => o.className === 'Axure:DiagramObjectPath').at(-1).id;
  const scoped = changeRecord(bytes, record.index, graph => {
    const guids = graph.roots[0].values, path = graph.objects.get(pathId);
    guids.push(instanceGuid, targetGuid);
    field(path.body, 'object-id').value = guids.length;
    field(path.body, 'rdo-path').items = [{ tag: 0x16, value: guids.length - 1 }];
  });
  assert.equal(validateSemantics(scoped).valid, true);
  assert.equal(validateSemantics(duplicatePage(scoped, 'Page 1', 'Copy').file).valid, true);
  const bad = changeRecord(scoped, record.index, graph => {
    const widget = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:VectorShape');
    field(graph.objects.get(pathId).body, 'rdo-path').items[0].value = widget.id;
  });
  assert.ok(validateSemantics(bad).violations.some(v => v.category === 'interaction-path-integrity'));
});

check('repeater-path rejects non-Repeater hops and targets outside the row diagram', () => {
  const bytes = read('adaptive-repeater-views-final.rp');
  const record = readRecords(bytes).find(r => r.className === 'Axure:Page'), graph = parsePayload(record);
  const path = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObjectPath'
    && field(o.body, 'repeater-path')?.items.length);
  assert.ok(path);
  const nonRepeater = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:VectorShape');
  const badHop = changeRecord(bytes, record.index, graph => {
    field(graph.objects.get(path.id).body, 'repeater-path').items[0].value = nonRepeater.id;
  });
  assert.ok(validateSemantics(badHop).violations.some(v => v.category === 'interaction-path-integrity'));
  const repeaterId = field(path.body, 'repeater-path').items[0].value;
  const badTarget = changeRecord(bytes, record.index, graph => {
    field(graph.objects.get(path.id).body, 'object-id').value = repeaterId;
  });
  assert.ok(validateSemantics(badTarget).violations.some(v => v.category === 'interaction-path-integrity'));
});

check('current Page raise sentinel survives copying and remains a valid path', () => {
  const bytes = addInteractions(read('var-set-counter-roundtrip.rp'), 'SET_BUTTON', [{ event: 'OnClick', actions: [
    { type: 'raise-event', targetPage: true, eventType: 16 }
  ] }]).file;
  const output = duplicatePage(bytes, 'Page 1', 'Copy').file;
  assert.equal(validateSemantics(output).valid, true);
  const copiedPage = readRecords(output).filter(r => r.className === 'Axure:Page').at(-1), graph = parsePayload(copiedPage);
  assert.ok([...graph.objects.values()].filter(o => o.className === 'Axure:DiagramObjectPath')
    .some(path => graph.roots[0].values[field(path.body, 'object-id').value - 1] === '78563412cdabefcdefababcdeffedcba'));
});

check('native RP fixtures retain valid sentinels and cross-package paths', () => {
  for (const name of readdirSync(fixtures).filter(n => n.endsWith('.rp'))) {
    const bytes = read(name), result = validateSemantics(bytes);
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.violations)}`);
    const page = readRecords(bytes).find(r => r.className === 'Axure:Page');
    if (page) {
      const copy = clonePageByIndex(bytes, page.index, 'COPY SEMANTIC AUDIT').file, copied = validateSemantics(copy);
      assert.equal(copied.valid, true, `${name} copy: ${JSON.stringify(copied.violations)}`);
    }
  }
});

return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = runCopyPathSemanticsChecks({ log: console.log });
  console.log(`${results.filter(result => result.passed).length}/${results.length} copy/path semantic checks passed`);
  process.exitCode = results.some(result => !result.passed) ? 1 : 0;
}
