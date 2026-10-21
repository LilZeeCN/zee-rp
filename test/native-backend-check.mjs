import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInteractiveRp } from '../scripts/proto.mjs';
import { createBlankProject } from '../scripts/create-blank-project.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'rp-native-test-'));
const spawn = childProcess.spawnSync;
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log(`PASS ${label}`); };
try {
  const reports = [];
  for (const name of ['booking', 'approval', 'inventory', 'survey', 'course', 'visual']) {
    const bundle = join(work, name);
    const result = spawn('python3', [join(root, 'scripts/proto.py'), 'compile', '--spec', join(root, 'examples/rp-language', `${name}.json`), '--out-dir', bundle], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    // Any subprocess here (including GUI wrappers) is a regression. Cache is absent.
    childProcess.spawnSync = (...args) => { throw new Error(`Forbidden native subprocess: ${args[0]}`); };
    syncBuiltinESMExports();
    let report;
    try { report = buildInteractiveRp(join(bundle, 'compile-plan.json'), join(work, `${name}.rp`), { cacheDir: join(work, 'absent-cache') }); }
    finally { childProcess.spawnSync = spawn; syncBuiltinESMExports(); }
    const summary = readRp(readFileSync(report.outputRp));
    check(`${name}: native / zero subprocesses / zero cache`, () => {
      assert.equal(report.backend, 'native'); assert(!existsSync(join(work, 'absent-cache')));
      assert(report.stages.every(s => !s.cached));
    });
    check(`${name}: complete mapping and events`, () => {
      assert(report.sourceMap.length); assert(report.sourceMap.every(s => s.native.length === 1));
      assert.equal(report.eventCoverage.declared, report.eventCoverage.materialized);
      assert.deepEqual(report.threeZeros, { danglingRefs: 0, sentinelSlotsNonZero: 0, problems: 0 });
      assert.equal(summary.duplicates.length, 0);
    });
    const plan = JSON.parse(readFileSync(join(bundle, 'compile-plan.json')));
    const graphs = readRecords(readFileSync(report.outputRp)).filter(r => ['Axure:Page', 'Axure:PanelState'].includes(r.className)).map(parsePayload);
    const widgets = new Map(graphs.flatMap(g => [...g.objects.values()].filter(o => o.className.startsWith('Axure:DiagramObject:')).map(o => [field(field(o.body, 'name-block'), 'text')?.text, { o, g }])));
    const prop = (g, o, key) => field(field(g.objects.get(field(o.body, 'MyStyle').value).body, 'PropList').items.find(p => (field(p, 'DOAName').value & 0x3fffffff) === key), 'Value');
    let leaves = 0;
    function verify(item, images) {
      if (item.itemType !== 1) { if (item.backgroundShape) verify(item.backgroundShape, images); for (const c of item.scene.items) verify(c, images); return; }
      const info = widgets.get(item.name) ?? [...widgets].find(([n]) => n.endsWith(`-${item.name}`))?.[1];
      assert(info, `Missing native leaf ${item.name}`);
      const { g, o } = info;
      assert.equal(field(prop(g, o, 101), 'X').value, item.rect.location.x);
      assert.equal(field(prop(g, o, 101), 'Y').value, item.rect.location.y);
      assert.equal(field(prop(g, o, 105), 'Width').value, item.rect.size.width);
      assert.equal(field(prop(g, o, 105), 'Height').value, item.rect.size.height);
      const style = g.objects.get(field(o.body, 'MyStyle').value);
      assert(field(style.body, 'All').value);
      assert(field(style.body, 'PropList').items.length >= 49);
      const run = item.text?.paragraphs?.[0]?.inlines?.[0];
      if (run) {
        assert.equal(prop(g, o, 1).text, run.family);
        assert.equal(prop(g, o, 2).value, run.size * .75);
        const text = field(field(o.body, 'RichTextBlock'), 'attributed-string');
        assert.equal(field(field(text, 'Paragraphs').items[0], 'HorizontalAlignment').value, item.text.paragraphs[0].horizontalAlignment);
      }
      if (item.backgroundFills?.[0]?.type === 3) {
        assert.equal(o.className, 'Axure:DiagramObject:ImageBox');
        assert.equal(field(prop(g, o, 27), 'Stream').value, images[item.backgroundFills[0].image]);
      }
      leaves++;
    }
    for (const p of plan.pages) {
      for (const path of [p.mainAxvgPath, ...(p.dynamicPanels ?? []).flatMap(dp => dp.states.map(st => st.axvgPath))]) {
        const scene = JSON.parse(readFileSync(path)); for (const item of scene.scene.items) verify(item, scene.imageMap);
      }
    }
    check(`${name}: ${leaves} leaf geometries / full styles / text units / images`, () => assert(leaves > 0));
    reports.push({ name, elapsedMs: report.elapsedMs, events: report.eventCoverage, pages: summary.counts.pages });
  }
  check('panel aggregate initialization stays in valid native scopes', () => {
    const bundle = join(work, 'panel-aggregates');
    const result = spawn('python3', [join(root, 'scripts/proto.py'), 'compile', '--spec', join(root, 'test/fixtures/rp-aggregate-panel.json'), '--out-dir', bundle], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = buildInteractiveRp(join(bundle, 'compile-plan.json'), join(work, 'panel-aggregates.rp'));
    assert.deepEqual(report.threeZeros, { danglingRefs: 0, sentinelSlotsNonZero: 0, problems: 0 });
    assert.equal(report.eventCoverage.declared, report.eventCoverage.materialized);
  });
  for (const fixture of ['nested-panels', 'runtime-inventory']) {
    check(`${fixture}: display names cover containers, inputs and row templates without losing events`, () => {
      const spec = JSON.parse(readFileSync(join(root, 'examples/rp-language', `${fixture}.json`)));
      const label = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type && node.id && !['use', 'repeat'].includes(node.type)) node.name = node.type === 'label' ? '重复 名 ★' : `中文 ${node.id}`;
        for (const value of Object.values(node)) if (value && typeof value === 'object') {
          if (Array.isArray(value)) value.forEach(label); else label(value);
        }
      };
      spec.pages.forEach(p => label(p.root));
      Object.values(spec.components ?? {}).forEach(c => label(c.root));
      const source = join(work, `${fixture}-named.json`), bundle = join(work, `${fixture}-named`);
      writeFileSync(source, JSON.stringify(spec));
      const compiled = spawn('python3', [join(root, 'scripts/proto.py'), 'compile', '--spec', source, '--out-dir', bundle], { encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stderr);
      const report = buildInteractiveRp(join(bundle, 'compile-plan.json'), join(work, `${fixture}-named.rp`));
      const bytes = readFileSync(report.outputRp), records = readRecords(bytes);
      assert.equal(report.eventCoverage.declared, report.eventCoverage.materialized);
      assert(report.eventCoverage.declared > 0);
      for (const symbol of report.sourceMap) {
        assert.equal(symbol.native.length, 1, symbol.id);
        const loc = symbol.native[0], graph = parsePayload(records.find(r => r.index === loc.record));
        assert.equal(field(field(graph.objects.get(loc.id).body, 'name-block'), 'text').text,
          symbol.display !== symbol.name ? symbol.display : symbol.nativeName ?? symbol.name);
      }
      const readback = readRp(bytes);
      assert.equal(readback.records.unparseable, 0);
      assert.equal(readback.counts.danglingRefs, 0);
      assert.deepEqual(readback.problems, []);
      assert(readback.duplicates.length > 0);
    });
  }
  check('startup aggregate fixture materializes all events with valid scopes', () => {
    const bundle = join(work, 'startup-aggregates');
    const result = spawn('python3', [join(root, 'scripts/proto.py'), 'compile', '--spec', join(root, 'test/fixtures/rp-aggregate-startup.json'), '--out-dir', bundle], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = buildInteractiveRp(join(bundle, 'compile-plan.json'), join(work, 'startup-aggregates.rp'));
    assert.equal(report.eventCoverage.declared, report.eventCoverage.materialized);
    assert.deepEqual(report.threeZeros, { danglingRefs: 0, sentinelSlotsNonZero: 0, problems: 0 });
  });
  const bookingPlan = join(work, 'booking/compile-plan.json');
  childProcess.spawnSync = (...args) => { throw new Error(`Forbidden native subprocess: ${args[0]}`); };
  syncBuiltinESMExports();
  try {
    check('static mode has zero native events including panel states', () => {
      const report = buildInteractiveRp(bookingPlan, join(work, 'static.rp'), { noInteractions: true });
      const graphs = readRecords(readFileSync(report.outputRp)).filter(r => r.strings).map(parsePayload);
      assert(!graphs.some(g => [...g.objects.values()].some(o => o.className === 'Axure:InteractionEvent')));
    });
    check('explicit GUI backend is preserved', () => assert.throws(() => buildInteractiveRp(bookingPlan, join(work, 'gui.rp'), { backend: 'gui', cacheDir: join(work, 'gui-cache') }), /Forbidden native subprocess: python3/));
    const legacy = JSON.parse(readFileSync(bookingPlan)); delete legacy.language;
    const legacyPlan = join(work, 'legacy-plan.json'); writeFileSync(legacyPlan, JSON.stringify(legacy));
    check('legacy specs retain GUI default', () => assert.throws(() => buildInteractiveRp(legacyPlan, join(work, 'legacy.rp'), { cacheDir: join(work, 'legacy-cache') }), /Forbidden native subprocess: python3/));
    check('invalid backend fails before output', () => {
      const out = join(work, 'invalid.rp');
      assert.throws(() => buildInteractiveRp(bookingPlan, out, { backend: 'invalid' }), /backend/); assert(!existsSync(out));
    });
  } finally { childProcess.spawnSync = spawn; syncBuiltinESMExports(); }
  const blank = join(work, 'blank.rp'); createBlankProject(blank, { version: 9 });
  const seed = readFileSync(blank);
  const scene = { masters: {}, imageMap: {}, scene: { items: [{ itemType: 1, name: 'probe', type: 0, rect: { location: { x: 0, y: 0 }, size: { width: 10, height: 10 } }, corners: [0,0,0,0], backgroundFills: [], strokes: [] }] } };
  for (const [label, edit] of [
    ['rotation', n => n.rotation = 45], ['custom shape', n => n.type = 1],
    ['effect', n => n.effects = [{}]], ['gradient', n => n.backgroundFills = [{ type: 2 }]],
    ['missing image', n => n.backgroundFills = [{ type: 3, image: 'absent' }]],
    ['asymmetric corners', n => n.corners[1] = 3],
  ]) check(`reject ${label}`, () => { const copy = structuredClone(scene); edit(copy.scene.items[0]); assert.throws(() => writeNativeScene(seed, copy), /Native/); });
  console.log(JSON.stringify({ ok: true, checks, reports }, null, 2));
} finally { childProcess.spawnSync = spawn; syncBuiltinESMExports(); rmSync(work, { recursive: true, force: true }); }
