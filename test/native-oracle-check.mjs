import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { createPanel, panelTemplate } from '../scripts/create-panel-clone.mjs';
import { fillPanelState } from '../scripts/fill-panel-state.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { mergePages } from '../scripts/merge-pages.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { placeMaster } from '../scripts/place-master.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { setWidgetText } from '../scripts/set-widget-text.mjs';
import { setWidgetRichText } from '../scripts/set-widget-richtext.mjs';
import { runAssemblyBridgeAsync, closeAssemblyDaemons } from '../tools/native-assembly/bridge.mjs';

test('Axure RP9 loads the output of the native authoring writers', { timeout: 180_000 }, async t => {
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
  };

  await t.test('set-widget-text', async () => {
    setWidgetText(pathFor('source'), pathFor('set-widget-text'), 'Page 1', 'Probe', 'Revised');
    await assertNative('set-widget-text', readFileSync(pathFor('set-widget-text')));
  });
  await t.test('set-widget-richtext', async () => {
    const { file } = setWidgetRichText(input, { page: 'Page 1', widget: 'Probe', paragraphs: [{ runs: [{ text: 'Rich', style: { bold: true } }] }] });
    await assertNative('set-widget-richtext', file);
  });
  await t.test('add-interaction', async () => {
    const { file } = addInteractions(input, 'Probe', [{ event: 'OnClick', actions: [{ type: 'wait', ms: 20 }] }]);
    await assertNative('add-interaction', file);
  });
  await t.test('merge-pages', async () => {
    const merged = mergePages([{ buf: input }, { buf: input, name: 'Second' }]);
    await assertNative('merge-pages', merged);
  });
  await t.test('place-master', async () => {
    const source = fileURLToPath(new URL('./fixtures/rp1-master-adaptive.json', import.meta.url));
    const report = generatePrototype({ source, output: pathFor('master-source'), cwd: work });
    assert.equal(report.status, 'completed', JSON.stringify(report.diagnostics));
    const masterProject = readFileSync(report.output);
    const summary = readRp(masterProject);
    const check = placeMaster(masterProject, { masterName: summary.sitemap.masters[0].name, pageIndex: summary.pages[0].record });
    await assertNative('place-master', check.file);
  });
  await t.test('create-panel-clone and fill-panel-state', async sub => {
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
    await assertNative('create-panel-clone', panel);
    const filled = fillPanelState(input, panel, { sourcePage: 'Page 1', targetPage: 'Page 1', panel: 'Probe panel', state: 'Initial' }).file;
    await assertNative('fill-panel-state', filled);
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
