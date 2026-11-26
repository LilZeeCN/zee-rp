import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInteractiveRp } from '../scripts/proto.mjs';
import { createBlankProject } from '../scripts/create-blank-project.mjs';
import { createPanel } from '../scripts/create-panel-clone.mjs';
import { fillPanelState } from '../scripts/fill-panel-state.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { encodeRecord, readRecords, replaceRecord } from '../scripts/rp-records.mjs';
import { encodePayload, parsePayload, field } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { addInteractions, addInteractionsBatch, createInteractionWriter, loadBaselineMap } from '../scripts/ix-actions.mjs';
import { mergePages } from '../scripts/merge-pages.mjs';
import { pythonInvocation } from '../scripts/python.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spawn = childProcess.spawnSync;
const spawnPy = (args, options) => {
  const invocation = pythonInvocation(args);
  return childProcess.spawnSync(invocation.command, invocation.args, options);
};
function withEnvironment(changes, run) {
  const previous = Object.entries(changes).map(([name, value]) => {
    const old = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return [name, old];
  });
  try { return run(); }
  finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('native backend contracts: zero subprocesses, interactions, forms, and batch baseline', () => {
  const work = mkdtempSync(join(tmpdir(), 'rp-native-test-'));
  let checks = 0;
  const check = (_label, fn) => { fn(); checks++; };
  try {
  const reports = [];
  for (const name of ['booking', 'approval', 'inventory', 'survey', 'course', 'visual']) {
    const bundle = join(work, name);
    const result = spawnPy([join(root, 'scripts/proto.py'), 'compile', '--spec', join(root, 'examples/rp-language', `${name}.json`), '--out-dir', bundle], { encoding: 'utf8' });
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
      assert(report.interactionAssembly.payloadsParsed <= report.interactionAssembly.recordsInflated);
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
        assert.equal(prop(g, o, 10).value, item.textAlignment ?? 0);
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
    const result = spawnPy([join(root, 'scripts/proto.py'), 'compile', '--spec', join(root, 'test/fixtures/rp-aggregate-panel.json'), '--out-dir', bundle], { encoding: 'utf8' });
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
      const compiled = spawnPy([join(root, 'scripts/proto.py'), 'compile', '--spec', source, '--out-dir', bundle], { encoding: 'utf8' });
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
    const result = spawnPy([join(root, 'scripts/proto.py'), 'compile', '--spec', join(root, 'test/fixtures/rp-aggregate-startup.json'), '--out-dir', bundle], { encoding: 'utf8' });
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
    const guiError = process.platform === 'darwin'
      ? /Forbidden native subprocess:/
      : /GUI 后端依赖 macOS.*--backend native/;
    check('explicit GUI backend follows the host contract', () => assert.throws(() => buildInteractiveRp(bookingPlan, join(work, 'gui.rp'), { backend: 'gui', cacheDir: join(work, 'gui-cache') }), guiError));
    const legacy = JSON.parse(readFileSync(bookingPlan)); delete legacy.language;
    const legacyPlan = join(work, 'legacy-plan.json'); writeFileSync(legacyPlan, JSON.stringify(legacy));
    check('legacy specs retain GUI default', () => assert.throws(() => buildInteractiveRp(legacyPlan, join(work, 'legacy.rp'), { cacheDir: join(work, 'legacy-cache') }), guiError));
    check('invalid backend fails before output', () => {
      const out = join(work, 'invalid.rp');
      assert.throws(() => buildInteractiveRp(bookingPlan, out, { backend: 'invalid' }), /backend/); assert(!existsSync(out));
    });
  } finally { childProcess.spawnSync = spawn; syncBuiltinESMExports(); }
  const blank = join(work, 'blank.rp'); createBlankProject(blank, { version: 9 });
  const seed = readFileSync(blank);
  const scene = { masters: {}, imageMap: {}, scene: { items: [{ itemType: 1, name: 'probe', type: 0, rect: { location: { x: 0, y: 0 }, size: { width: 10, height: 10 } }, corners: [0,0,0,0], backgroundFills: [], strokes: [] }] } };
  check('native move modes retain distinct values, animation defaults and readable labels', () => {
    const expected = [
      ['location', 0, 300, 1, '移动到'],
      ['delta', 1, 300, 1, '相对移动'],
      ['drag', 2, 0, 0, '跟随拖动'],
      ['drag-x', 3, 0, 0, '跟随水平拖动'],
      ['drag-y', 4, 0, 0, '跟随垂直拖动'],
      ['locationBeforeDrag', 5, 300, 1, '回到拖动前的位置'],
      ['withThis', 6, 300, 1, '随触发元件移动'],
    ];
    const event = { event: 'OnDrag', actions: expected.map(([mode]) => ({ type: 'move', mode })) };
    const page = writeNativeScene(seed, scene);
    const { file } = addInteractions(page, 'probe', [event]);
    const graph = parsePayload(readRecords(file).find(record => record.className === 'Axure:Page'));
    const moves = [...graph.objects.values()].filter(object => object.className === 'Axure:MoveWidgetInfo');
    assert.deepEqual(moves.map(move => ['MoveType', 'Duration', 'Easing'].map(key => field(move.body, key).value)),
      expected.map(([, type, duration, easing]) => [type, duration, easing]));
    const interactions = readRp(file).pages[0].widgets.find(widget => widget.name === 'probe').interactions;
    assert.deepEqual(interactions[0].cases[0].actions.map(action => action.human.split(' ')[0]),
      expected.map(([, , , , label]) => label));
  });
  check('an explicitly named panel template cannot silently select a different panel', () => {
    withEnvironment({ AXURE_PANEL_TEMPLATE_NAME: 'No such panel in the fixture' }, () => {
      const pageIndex = readRp(seed).pages[0].record;
      assert.throws(() => createPanel(seed, { pageIndex, name: 'Template probe' }), /Missing template panel: No such panel/);
    });
  });
  const pageName = readRp(seed).pages[0].name;
  const panelOptions = name => ({ pageName, name, states: ['Content'] });
  const localAction = [{ event: 'OnClick', actions: [{ type: 'hide', target: 'probe' }] }];
  const stateLayout = addInteractions(writeNativeScene(seed, scene), 'probe', localAction).file;
  const innerShell = createPanel(seed, panelOptions('Fixture Panel')).file;
  const fillOptions = panel => ({ sourcePage: pageName, targetPage: pageName, panel, state: 'Content' });
  const nestedSource = fillPanelState(stateLayout, innerShell, fillOptions('Fixture Panel')).file;

  check('Windows RP9 can seed a blank panel from a built-in Tour with two unnamed panels', () => {
    let tour = createPanel(innerShell, panelOptions('Other template panel')).file;
    tour = addInteractions(tour, 'Fixture Panel', [{ event: 'OnClick', actions: [{ type: 'wait', ms: 10 }] }]).file;
    const record = readRecords(tour).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(record), strings = [...record.strings];
    const panels = [...graph.objects.values()].filter(o => o.className === 'Axure:DiagramObject:DynamicPanel');
    assert.equal(panels.length, 2);
    let empty = strings.indexOf('');
    if (empty === -1) { empty = strings.length; strings.push(''); }
    for (const panel of panels) field(field(panel.body, 'name-block'), 'text').value = empty + 1;
    tour = replaceRecord(tour, record, encodeRecord(record, strings, encodePayload(graph.roots)));
    const settings = join(work, 'simulated-win-settings');
    mkdirSync(join(settings, 'Training'), { recursive: true });
    writeFileSync(join(settings, 'Training', 'RP9 Tour.rp'), tour);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      withEnvironment({ AXURE_DEFAULT_SETTINGS_RP9: settings, AXURE_PANEL_TEMPLATE: undefined, AXURE_PANEL_TEMPLATE_NAME: undefined }, () => {
        const result = createPanel(seed, panelOptions('new panel'));
        const summary = readRp(result.file);
        assert.equal(summary.pages[0].widgets[0].name, 'new panel');
        assert.equal(summary.pages[0].widgets[0].interactions?.length ?? 0, 0);
        assert.equal(summary.counts.panelStates, 1);
        assert.equal(summary.counts.danglingRefs, 0);
        assert.throws(() => createPanel(seed, { ...panelOptions('copy'), copyTemplateStates: true }), /multiple unnamed panels/);
      });
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
  check('nested-panels builds with a template whose original state contained widget actions', () => {
    const template = join(work, 'panel-with-old-actions.rp');
    writeFileSync(template, nestedSource);
    withEnvironment({ AXURE_PANEL_TEMPLATE: template, AXURE_PANEL_TEMPLATE_NAME: 'Fixture Panel' }, () => {
      const result = buildInteractiveRp(join(work, 'nested-panels-named', 'compile-plan.json'), join(work, 'nested-from-active-template.rp'));
      assert.deepEqual(result.threeZeros, { danglingRefs: 0, sentinelSlotsNonZero: 0, problems: 0 });
      assert.equal(result.eventCoverage.materialized, result.eventCoverage.declared);
      assert(result.eventCoverage.declared > 0);
    });
  });
  check('nested state import preserves live interactions and rejects live out-of-layout targets', () => {
    const record = readRecords(nestedSource).find(r => r.className === 'Axure:PanelState');
    const graph = parsePayload(record);
    const path = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObjectPath');
    const ids = graph.roots.find(n => n.tag === 0x1e).values;
    const nullId = ids.indexOf('0'.repeat(32)) + 1;
    assert(nullId > 0);
    ids.push(randomBytes(16).toString('hex'));
    const orphan = { ...structuredClone(path), id: ids.length };
    field(orphan.body, 'object-id').value = nullId;
    graph.roots.splice(graph.roots.length - 1, 0, orphan);
    const encodeSource = () => replaceRecord(nestedSource, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
    const outerShell = createPanel(seed, panelOptions('Outer')).file;
    const { file } = fillPanelState(encodeSource(), outerShell, fillOptions('Outer'));
    const paths = readRecords(file).filter(r => r.className === 'Axure:PanelState')
      .flatMap(r => [...parsePayload(r).objects.values()]).filter(o => o.className === 'Axure:DiagramObjectPath');
    assert.equal(paths.length, 1);
    assert.equal(readRp(file).counts.danglingRefs, 0);
    field(path.body, 'object-id').value = nullId;
    assert.throws(() => fillPanelState(encodeSource(), outerShell, fillOptions('Outer')), /State import interaction targets must belong/);
  });
  check('batched events preserve sequential cross-page resolution and replacement without changing the input', () => {
    const page = writeNativeScene(seed, scene);
    const input = mergePages([{ buf: page, name: 'A' }, { buf: page, name: 'B' }]);
    const before = Buffer.from(input);
    const event = (name, actions) => [{ event: name, cases: [{ description: 'case', actions }] }];
    const edits = [
      [{ page: 'A', widget: 'probe' }, event('OnClick', [{ type: 'link', page: 'B' }])],
      [{ page: 'A' }, event('OnLoad', [{ type: 'wait', ms: 5 }])],
      [{ page: 'B', widget: 'probe' }, event('OnClick', [{ type: 'link', page: 'A' }])],
      [{ page: 'A' }, event('OnLoad', [{ type: 'show', target: 'probe' }])],
    ];
    let sequential = input;
    const writer = createInteractionWriter(input);
    for (const [target, events] of edits) {
      sequential = addInteractions(sequential, target, events, { replaceEvent: true, version: 9 }).file;
      writer.add(target, events, { replaceEvent: true, version: 9 });
    }
    const describe = file => readRp(file).pages.map(p => ({ name: p.name,
      events: p.interactions, widgets: p.widgets.map(w => ({ name: w.name, events: w.interactions })) }));
    assert.deepEqual(describe(writer.finish()), describe(sequential));
    assert(input.equals(before));
    assert.equal(writer.stats().recordsEncoded, 2);
    const rejected = createInteractionWriter(input);
    rejected.add(...edits[0], { version: 9 });
    assert.throws(() => rejected.add({ page: 'A', widget: 'missing' }, edits[0][1]));
    assert.throws(() => rejected.finish(), /failed interaction batch/);
    assert(input.equals(before));
  });
  check('rotation persists in the native style', () => {
    const copy = structuredClone(scene); copy.scene.items[0].rotation = 45;
    const record = readRecords(writeNativeScene(seed, copy)).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(record);
    const widget = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:VectorShape');
    const style = graph.objects.get(field(widget.body, 'MyStyle').value);
    const rotation = field(style.body, 'PropList').items.find(p => (field(p, 'DOAName').value & 0x3fffffff) === 50);
    assert.equal(field(rotation, 'Value').value, 45);
  });
  for (const [label, edit] of [
    ['custom shape', n => n.type = 1],
    ['effect', n => n.effects = [{}]], ['gradient', n => n.backgroundFills = [{ type: 2 }]],
    ['missing image', n => n.backgroundFills = [{ type: 3, image: 'absent' }]],
    ['asymmetric corners', n => n.corners[1] = 3],
  ]) check(`reject ${label}`, () => { const copy = structuredClone(scene); edit(copy.scene.items[0]); assert.throws(() => writeNativeScene(seed, copy), /Native/); });
  check('carousel-slider-captcha native RP9 serialization includes BoundaryDirectionLiteral, GetWidget, GetPanelState, IsOver', () => {
    const bundle = join(work, 'captcha-bundle');
    const result = spawnPy([join(root, 'scripts/proto.py'), 'compile', '--spec', join(root, 'examples/rp-language/carousel-slider-captcha.rp1'), '--out-dir', bundle], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outRp = join(work, 'captcha.rp');
    const report = buildInteractiveRp(join(bundle, 'compile-plan.json'), outRp);
    assert.deepEqual(report.threeZeros, { danglingRefs: 0, sentinelSlotsNonZero: 0, problems: 0 });
    assert.equal(report.eventCoverage.declared, report.eventCoverage.materialized);
    const graphs = readRecords(readFileSync(outRp)).filter(r => ['Axure:Page', 'Axure:PanelState'].includes(r.className)).map(parsePayload);
    const allObjs = graphs.flatMap(g => [...g.objects.values()]);
    const fcallNames = new Set(allObjs.filter(o => o.className === 'Axure:Expr:FCall').map(o => field(o.body, 'function-name')?.text));
    for (const fn of ['GetWidget', 'GetPanelState', 'IsOver', 'GetWidgetRectangles']) {
      assert(fcallNames.has(fn), `Missing native FCall ${fn}`);
    }
    const boundaryDirs = allObjs.filter(o => o.className === 'Axure:Expr:BoundaryDirectionLiteral');
    assert(boundaryDirs.length >= 2, `Expected BoundaryDirectionLiteral nodes, got ${boundaryDirs.length}`);
    assert.deepEqual(boundaryDirs.map(b => field(b.body, 'boundaryDirection')?.text).sort(), ['left', 'right']);
    const boundedMoves = allObjs.filter(o => o.className === 'Axure:MoveWidgetInfo' && field(o.body, 'MoveType')?.value === 3);
    assert.equal(boundedMoves.length, 1);
    assert(field(boundedMoves[0].body, 'BoundaryCondition')?.value !== graphs[0].roots.find(n => n.tag === 0x1e).values.indexOf('0'.repeat(32)) + 1);

    // Verify rp-read decodes BoundaryCondition + location/delta moves into structured rp1
    const captchaSummary = readRp(readFileSync(outRp));
    const widgets = captchaSummary.pages[0].widgets;
    const byPrefix = p => widgets.find(w => w.name.startsWith(p));
    const thumbDragAction = byPrefix('panel-thumb-').interactions.find(i => i.event === 'OnDrag').cases[0].actions[0];
    assert.equal(thumbDragAction.rp1?.type, 'move');
    assert.equal(thumbDragAction.rp1?.mode, 'drag-x');
    assert.ok(thumbDragAction.rp1?.bounds?.left, 'rp-read must decode BoundaryCondition left bound');
    assert.ok(thumbDragAction.rp1?.bounds?.right, 'rp-read must decode BoundaryCondition right bound');
    const resetMove = byPrefix('panel-thumb-').interactions.find(i => i.event === 'OnDragDrop').cases.find(c => !c.conditionHash || c.actions.some(a => a.rp1?.mode === 'location'));
    assert.ok(resetMove, 'rp-read should decode location move rp1');
  });
  check('addInteractionsBatch + .baseline.json resolves logical widget IDs and keeps three zeros', () => {
    const macroSpec = join(work, 'macro-batch.rp1');
    writeFileSync(macroSpec, [
      'rp/1 target=9 name="宏与批交互测试" domain=web theme=enterprise-light',
      'page #home name="首页" canvas=[440,520]',
      '  box #root [440x520] layout=stack fill=#FFFFFF',
      '    carousel #hero [400x140] x=20 y=20 slides=["s1","s2"] interval=3000',
      '    slider-captcha #cap [360x240] x=20 y=200 targetX=200 tolerance=2',
      '    label #msg x=20 y=460 w=200 h=24 text="待验证"',
      '    button #extra_btn x=20 y=490 w=120 h=30 text="额外"',
    ].join('\n'));
    const bundle = join(work, 'macro-bundle');
    const res = spawnPy([join(root, 'scripts/proto.py'), 'compile', '--spec', macroSpec, '--out-dir', bundle], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const outRp = join(work, 'macro.rp');
    const rep = buildInteractiveRp(join(bundle, 'compile-plan.json'), outRp);
    assert.deepEqual(rep.threeZeros, { danglingRefs: 0, sentinelSlotsNonZero: 0, problems: 0 });
    writeFileSync(`${outRp}.baseline.json`, JSON.stringify({
      targets: { 'home/extra_btn': 'extra_btn-deadbeef', 'home/msg': 'msg-deadbeef' },
    }));
    const actualNames = readRp(readFileSync(outRp)).pages[0].widgets.map(w => w.name);
    const realBtn = actualNames.find(n => n.startsWith('btn-extra_btn-'));
    const realMsg = actualNames.find(n => n.startsWith('txt-msg-'));
    writeFileSync(`${outRp}.baseline.json`, JSON.stringify({
      targets: { 'home/extra_btn': realBtn, 'home/msg': realMsg },
    }));
    const bmap = loadBaselineMap(outRp);
    const { file: nextBuf } = addInteractionsBatch(readFileSync(outRp), [
      { target: 'extra_btn', event: 'OnClick', actions: [{ type: 'set-text', target: 'msg', text: '批交互成功' }] },
      { target: 'extra_btn', event: 'OnMouseOver', actions: [{ type: 'disable', target: 'extra_btn' }] },
    ], { baseline: bmap });
    const after = readRp(nextBuf);
    assert.equal(after.counts.problems, 0);
    assert.equal(after.counts.danglingRefs, 0);
    const btnWidget = after.pages[0].widgets.find(w => w.name === realBtn);
    assert.ok(btnWidget.interactions.some(ix => ix.event === 'OnClick'));
    assert.ok(btnWidget.interactions.some(ix => ix.event === 'OnMouseOver'));
  });
  assert.ok(checks > 0);
  } finally { childProcess.spawnSync = spawn; syncBuiltinESMExports(); rmSync(work, { recursive: true, force: true }); }
});
