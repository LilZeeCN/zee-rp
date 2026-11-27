import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addClickLink } from '../scripts/add-click-link.mjs';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { cloneLibraryPageContent } from '../scripts/clone-library-page-content.mjs';
import { cloneLibraryWidget } from '../scripts/clone-library-widget.mjs';
import { createBlankPage } from '../scripts/create-blank-page.mjs';
import { createGlobalVariable } from '../scripts/create-global-variable.mjs';
import { duplicateMaster } from '../scripts/create-master.mjs';
import { createPanel, panelTemplate } from '../scripts/create-panel-clone.mjs';
import { listCustomStyles, rebindWidgets, renameCustomStyle } from '../scripts/custom-styles.mjs';
import { duplicatePage } from '../scripts/duplicate-page.mjs';
import { fillPanelState } from '../scripts/fill-panel-state.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { mergePages } from '../scripts/merge-pages.mjs';
import { setWidgetNames } from '../scripts/name-widget.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { encodePayload, field, parsePayload } from '../scripts/parse-payload.mjs';
import { placeMaster } from '../scripts/place-master.mjs';
import { removeInteraction } from '../scripts/remove-interaction.mjs';
import { removePanelStateContent } from '../scripts/remove-panel-state-content.mjs';
import { encodeRecord, readRecords, replaceRecord } from '../scripts/rp-records.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { setComboBoxOptions } from '../scripts/set-combobox-options.mjs';
import { setListBoxOptions } from '../scripts/set-listbox-options.mjs';
import { setMasterOverrides } from '../scripts/set-master-overrides.mjs';
import { setPanelFitToContent } from '../scripts/set-panel-fit-to-content.mjs';
import { setWidgetRichText } from '../scripts/set-widget-richtext.mjs';
import { setWidgetText } from '../scripts/set-widget-text.mjs';
import { closeAssemblyDaemons, runAssemblyBridgeAsync } from '../tools/native-assembly/bridge.mjs';
import { JobManager } from '../scripts/jobs.mjs';

const stockRp9Lib = '/Applications/Axure RP 9.app/Contents/Resources/DefaultSettings/Libraries/Default.rplib';

test('Axure RP9 loads the output of the full native authoring writer matrix', { timeout: 240_000 }, async t => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return t.skip('Requires the verified macOS Axure host');
  const work = mkdtempSync(join(tmpdir(), 'zee-native-oracle-'));
  t.after(async () => {
    await closeAssemblyDaemons();
    rmSync(work, { force: true, recursive: true });
  });
  const blank = synthesizeBlankProject({ version: 9 });
  const pathFor = name => join(work, `${name}.rp`);
  const blankPath = pathFor('blank');
  writeFileSync(blankPath, blank);
  const check = await nativeCheck(blankPath);
  if (check.status === 'unavailable') return t.skip(check.reason);
  assert.equal(check.status, 'accepted', JSON.stringify(check.error));
  const input = writeNativeScene(blank, { scene: { items: [{
    itemType: 1, type: 0, name: 'Probe', rect: { location: { x: 24, y: 16 }, size: { width: 100, height: 40 } },
    text: { paragraphs: [{ horizontalAlignment: 0, inlines: [{
      text: 'Original', family: 'Arial', size: 16, weight: 400, textColor: { r: 0, g: 0, b: 0 },
    }] }] },
  }] } });
  writeFileSync(pathFor('source'), input);
  const assertNative = async (name, bytes) => {
    const path = pathFor(name);
    const shape = readRp(bytes);
    assert.equal(shape.records.unparseable + shape.counts.problems + shape.counts.danglingRefs, 0);
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
    const result = await runAssemblyBridgeAsync({ command: 'inspect', version: 9, args: [path] });
    assert.deepEqual(result.rows.filter(row => row.kind === 'page').map(row => row.values[1]),
      shape.pages.map(page => page.name));
    return { path, shape };
  };

  await t.test('set-widget-text', async () => {
    setWidgetText(pathFor('source'), pathFor('set-widget-text'), 'Page 1', 'Probe', 'Revised');
    await assertNative('set-widget-text', readFileSync(pathFor('set-widget-text')));
  });
  await t.test('set-widget-richtext', async () => {
    const { file } = setWidgetRichText(input, { page: 'Page 1', widget: 'Probe', paragraphs: [{ runs: [{ text: 'Rich', style: { bold: true } }] }] });
    await assertNative('set-widget-richtext', file);
  });
  await t.test('name-widget', async () => {
    const pageRec = readRp(input).pages[0];
    const { file } = setWidgetNames(input, [{ record: pageRec.record, id: pageRec.widgets[0].id, name: 'RenamedProbe' }]);
    await assertNative('name-widget', file);
  });
  await t.test('create-global-variable', async () => {
    const { file } = createGlobalVariable(input, 'OracleCounter', { defaultValue: '42' });
    await assertNative('create-global-variable', file);
  });
  await t.test('create-blank-page', async () => {
    const { file } = createBlankPage(input, 'Blank Page 2');
    await assertNative('create-blank-page', file);
  });
  await t.test('duplicate-page', async () => {
    const { file } = duplicatePage(input, 'Page 1', 'Copied Page');
    await assertNative('duplicate-page', file);
  });
  await t.test('add-interaction and remove-interaction', async () => {
    const { file: withIx } = addInteractions(input, 'Probe', [{ event: 'OnClick', actions: [{ type: 'wait', ms: 20 }] }]);
    await assertNative('add-interaction', withIx);
    const { file: removedIx } = removeInteraction(withIx, 'Probe', { event: 'OnClick' });
    await assertNative('remove-interaction', removedIx);
  });
  await t.test('add-click-link', async () => {
    const { file } = addClickLink(input, 'Probe', 'https://example.com', 'new');
    await assertNative('add-click-link', file);
  });
  await t.test('merge-pages', async () => {
    const merged = mergePages([{ buf: input }, { buf: input, name: 'Second' }]);
    await assertNative('merge-pages', merged);
  });
  await t.test('rename-custom-style and rebind-widgets', async () => {
    const styles = listCustomStyles(input);
    const { file: renamed } = renameCustomStyle(input, styles[0].name, 'Oracle Heading');
    await assertNative('rename-custom-style', renamed);
    const { file: rebound } = rebindWidgets(renamed, styles[0].guid, () => true);
    await assertNative('rebind-widgets', rebound);
  });
  await t.test('add-adaptive-view', async () => {
    const script = fileURLToPath(new URL('../scripts/add-adaptive-view.mjs', import.meta.url));
    const out = pathFor('add-adaptive-view');
    const res = spawnSync(process.execPath, [script, pathFor('source'), out, '768', '--override', 'V768:Probe:w=320'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    await assertNative('add-adaptive-view', readFileSync(out));
  });

  // Master writers (create-master, place-master, set-master-overrides)
  const masterFixture = fileURLToPath(new URL('./fixtures/rp1-master-adaptive.json', import.meta.url));
  const masterGen = generatePrototype({ source: masterFixture, output: pathFor('master-source'), cwd: work });
  assert.equal(masterGen.status, 'completed', JSON.stringify(masterGen.diagnostics));
  const masterProject = readFileSync(masterGen.output);
  const masterSummary = readRp(masterProject);
  const masterName = masterSummary.sitemap.masters[0].name;

  await t.test('create-master', async () => {
    const { file } = duplicateMaster(masterProject, masterName, 'Copied Master');
    await assertNative('create-master', file);
  });
  await t.test('place-master and set-master-overrides', async () => {
    const placed = placeMaster(masterProject, { masterName, pageIndex: masterSummary.pages[0].record });
    await assertNative('place-master', placed.file);
    const placedSummary = readRp(placed.file, { includeMasterWidgets: true });
    const pageMeta = placedSummary.pages[0];
    const rdo = pageMeta.widgets.find(w => w.type === 'ReferenceDiagramObject');
    const masterWidget = placedSummary.containedWidgets.find(w => w.container[0]?.startsWith('母版:') && w.type === 'VectorShape' && w.name);
    if (rdo && masterWidget) {
      const overridden = setMasterOverrides(placed.file, {
        record: pageMeta.record,
        instanceId: rdo.id,
        overrides: [{ targetGuid: masterWidget.guid, text: 'Overridden' }],
      });
      await assertNative('set-master-overrides', overridden.file);
    }
  });

  await t.test('create-panel-clone, fill-panel-state, set-panel-fit-to-content, remove-panel-state-content', async sub => {
    const template = panelTemplate(blank);
    if (!existsSync(template)) return sub.skip('Axure installation has no panel fixture');
    const local = pathFor('panel-template');
    copyFileSync(template, local);
    const prior = process.env.AXURE_PANEL_TEMPLATE;
    process.env.AXURE_PANEL_TEMPLATE = local;
    let panel;
    try { panel = createPanel(blank, { pageName: 'Page 1', name: 'Probe panel', states: ['Initial'] }).file; }
    finally {
      if (prior === undefined) delete process.env.AXURE_PANEL_TEMPLATE;
      else process.env.AXURE_PANEL_TEMPLATE = prior;
    }
    const { shape: panelShape } = await assertNative('create-panel-clone', panel);
    const panelWidget = panelShape.pages[0].widgets.find(w => w.type === 'DynamicPanel');
    const fitPanel = setPanelFitToContent(panel, { record: panelShape.pages[0].record, widgetId: panelWidget.id, enabled: true }).file;
    await assertNative('set-panel-fit-to-content', fitPanel);
    const filled = fillPanelState(input, fitPanel, { sourcePage: 'Page 1', targetPage: 'Page 1', panel: 'Probe panel', state: 'Initial' }).file;
    await assertNative('fill-panel-state', filled);
    const cleared = removePanelStateContent(filled, { page: 'Page 1', panel: 'Probe panel', state: 'Initial', all: true }).file;
    await assertNative('remove-panel-state-content', cleared);
  });

  await t.test('native form and library writers (clone-library-widget, set-combobox-options, set-listbox-options, set-native-table)', async sub => {
    const formsGen = generatePrototype({
      rp1: [
        'rp/1 target=9 name="OracleForms"',
        'page #home name="Home"',
        '  box #root [360x300] layout=column gap=12 padding=16',
        '    listbox #lb [200x100] options=["X","Y","Z"]',
      ].join('\n'),
      output: pathFor('forms-source'),
      cwd: work,
    });
    assert.equal(formsGen.status, 'completed', JSON.stringify(formsGen.diagnostics));
    const formsInfo = readRp(readFileSync(formsGen.output), { includeWidgets: true });
    const lbName = formsInfo.pages[0].widgets.find(w => w.type === 'ListBox')?.name;
    assert.ok(lbName, 'Expected ListBox widget in forms-source');
    const lbOut = pathFor('set-listbox-options');
    setListBoxOptions(formsGen.output, lbOut, 'Home', lbName, ['Alpha', 'Beta', 'Gamma'], { multiple: true, selectedIndices: [0, 2] });
    await assertNative('set-listbox-options', readFileSync(lbOut));

    if (!existsSync(stockRp9Lib)) return sub.skip('No stock RP9 Default.rplib on host');
    const localLib = join(work, 'Default.rplib');
    copyFileSync(stockRp9Lib, localLib);
    const clonedOut = pathFor('clone-library-widget');
    cloneLibraryWidget(localLib, blankPath, clonedOut, {
      sourcePageName: 'Box 1', targetPageName: 'Page 1', name: 'ClonedBox', x: 30, y: 30, width: 120, height: 50,
    });
    await assertNative('clone-library-widget', readFileSync(clonedOut));

    const cbSrc = pathFor('combobox-src');
    cloneLibraryWidget(localLib, blankPath, cbSrc, {
      sourcePageName: 'Droplist', targetPageName: 'Page 1', name: 'OracleCombo', x: 20, y: 20,
    });
    const cbOut = pathFor('set-combobox-options');
    setComboBoxOptions(cbSrc, cbOut, 'Page 1', 'OracleCombo', ['One', 'Two', 'Three'], { selectedIndex: 1 });
    await assertNative('set-combobox-options', readFileSync(cbOut));

    const tableSrc = pathFor('table-src');
    cloneLibraryPageContent(localLib, blankPath, tableSrc, {
      sourcePageName: 'Table', targetPageName: 'Page 1', x: 20, y: 20,
    });
    const tableSpec = join(work, 'table.json');
    writeFileSync(tableSpec, JSON.stringify({
      cells: [['Col1', 'Col2'], ['Val1', 'Val2']],
      rowHeights: [32, 32],
      columnWidths: [110, 110],
    }));
    const tableOut = pathFor('set-native-table');
    const tableScript = fileURLToPath(new URL('../scripts/set-native-table.mjs', import.meta.url));
    const tableRes = spawnSync(process.execPath, [tableScript, tableSrc, tableOut, tableSpec], { encoding: 'utf8' });
    assert.equal(tableRes.status, 0, tableRes.stderr);
    await assertNative('set-native-table', readFileSync(tableOut));
  });
});

test('a rejected file does not poison the RP11 native worker queue', { timeout: 180_000 }, async t => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return t.skip('Requires the verified macOS Axure host');
  const work = mkdtempSync(join(tmpdir(), 'zee-native-queue-'));
  t.after(async () => {
    await closeAssemblyDaemons();
    rmSync(work, { force: true, recursive: true });
  });
  const valid = join(work, 'valid.rp'), invalid = join(work, 'truncated.rp');
  const bytes = synthesizeBlankProject({ version: 11 });
  writeFileSync(valid, bytes);
  writeFileSync(invalid, bytes.subarray(0, 8));
  const initial = await nativeCheck(valid);
  if (initial.status === 'unavailable') return t.skip(initial.reason);
  assert.equal(initial.status, 'accepted', JSON.stringify(initial.error));
  const inspect = path => runAssemblyBridgeAsync({ command: 'inspect', version: 11, args: [path] });
  await inspect(valid);
  await assert.rejects(inspect(invalid), { code: 'E_ASSEMBLY_PROCESS' });
  const result = await inspect(valid);
  assert.deepEqual(result.rows.filter(row => row.kind === 'page').map(row => row.values[1]), ['Page 1']);
});

test('RP11 loads a cloned RP9 group, image and shape when their Error field is present', { timeout: 180_000 }, async t => {
  const work = mkdtempSync(join(tmpdir(), 'zee-rp11-cloned-group-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = join(work, 'source.rp'), target = join(work, 'target.rp');
  const output = join(work, 'result.rp'), control = join(work, 'missing-layer-error.rp');
  const rect = { location: { x: 0, y: 0 }, size: { width: 100, height: 100 } };
  const scene = {
    scene: { items: [{ itemType: 0, name: 'Group', rect, scene: { items: [
      { itemType: 1, type: 0, name: 'Shape', rect },
      { itemType: 1, type: 0, name: 'Image', rect, backgroundFills: [{ type: 3, image: 'pixel' }] },
    ] } }] },
    imageMap: { pixel: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' },
  };
  writeFileSync(source, writeNativeScene(synthesizeBlankProject({ version: 9 }), scene));
  writeFileSync(target, synthesizeBlankProject({ version: 11 }));
  cloneLibraryPageContent(source, target, output, { sourcePageName: 'Page 1', targetPageName: 'Page 1' });
  const bytes = readFileSync(output);
  const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
  const graph = parsePayload(page);
  const widgets = [...graph.objects.values()].filter(object => object.className.startsWith('Axure:DiagramObject:'));
  assert.deepEqual(widgets.map(object => object.className.split(':').at(-1)).sort(), ['ImageBox', 'Layer', 'VectorShape']);
  for (const widget of widgets) {
    const error = field(widget.body, 'Error');
    assert.equal(error?.tag, 0x19);
    assert.equal(error.value, false);
  }
  const layer = widgets.find(object => object.className.endsWith(':Layer'));
  layer.body.entries = layer.body.entries.filter(([key]) => key.text !== 'Error');
  const bad = replaceRecord(bytes, page, encodeRecord(page, page.strings, encodePayload(graph.roots)));
  const shape = readRp(bad);
  assert.equal(shape.records.unparseable + shape.counts.problems + shape.counts.danglingRefs, 0);
  writeFileSync(control, bad);

  const check = await nativeCheck(output);
  if (check.status === 'unavailable') return t.diagnostic(check.reason);
  assert.equal(check.status, 'accepted', check.error?.message);
  const rejected = await nativeCheck(control);
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.error.message, /could not deserialize page [\da-f-]{36}/i);
  assert.match(rejected.error.message, /NullReferenceException[\s\S]*Axure\.DocumentModel\.Objects\.Layer/);
});

test('synthesized RP9/RP11 projects save in place on their first editor save', {
  skip: process.platform !== 'darwin' || process.env.ZEE_AXURE_EDITOR_ACCEPTANCE !== '1',
  timeout: 180_000,
}, async t => {
  const work = mkdtempSync(join(tmpdir(), 'zee-first-editor-save-'));
  const driver = fileURLToPath(new URL('../scripts/gui-roundtrip.swift', import.meta.url));
  const blank9 = join(work, `${basename(work)}-rp9.rp`);
  const blank11 = join(work, `${basename(work)}-rp11.rp`);
  writeFileSync(blank9, synthesizeBlankProject({ version: 9 }));
  writeFileSync(blank11, synthesizeBlankProject({ version: 11 }));
  let passed = false;
  t.after(() => {
    if (passed) rmSync(work, { recursive: true, force: true });
    else t.diagnostic(`GUI failure evidence: ${work}`);
  });
  const prototype = generatePrototype({
    recipe: 'mobile-cards', template: blank9, output: join(work, `${basename(work)}-mobile-cards.rp`), cwd: work,
  });
  assert.equal(prototype.status, 'completed', JSON.stringify(prototype.diagnostics));
  assert.equal(prototype.pages.length, 3);

  for (const [name, input, version] of [
    ['blank RP9', blank9, 9], ['blank RP11', blank11, 11], ['three-page RP/1', prototype.output, 9],
  ]) {
    const output = input.replace(/\.rp$/, '-saved.rp');
    try {
      const job = await new JobManager().startRoundtrip({ source: input, output, wait: true, version });
      writeFileSync(`${output}.json`, JSON.stringify(job, null, 2));
      assert.equal(job.status, 'completed', job.stderr);
      const { blockingDialog, save } = job.validation;
      t.diagnostic(`${name}: ${JSON.stringify(save)}`);
      assert.equal(blockingDialog, null);
      assert.equal(save.retries, 0);
      assert.ok(Number.isInteger(save.diskMs) && save.diskMs <= 300, `First save exceeded 300 ms: ${save.diskMs}`);
      assert.ok(Math.abs(save.outputBytes - save.sourceBytes) <= Math.max(128, save.sourceBytes * 0.01),
        `Unexpected rewrite: ${save.sourceBytes} -> ${save.outputBytes}`);
      assert.equal(existsSync(output.replace(/\.rp$/, `_RP${version}.rp`)), false);
    } finally {
      if (existsSync(output)) spawnSync('swift', [driver, '--close', output, String(version)], { timeout: 20_000 });
    }
  }
  passed = true;
});
