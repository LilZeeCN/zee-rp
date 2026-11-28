import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { createPanel } from '../scripts/create-panel-clone.mjs';
import { fillPanelState } from '../scripts/fill-panel-state.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import { materializeNativeControl } from '../scripts/native-forms.mjs';
import { createNativeRepeater } from '../scripts/native-repeater.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { synthesizeNativeFormWidget } from '../scripts/native-widget-synthesizer.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { lintVersionKeys } from '../scripts/version-lint.mjs';

function withoutAxureTemplates(fn) {
  const saved = {
    AXURE_APP_RP9: process.env.AXURE_APP_RP9,
    AXURE_APP_RP11: process.env.AXURE_APP_RP11,
    AXURE_DEFAULT_SETTINGS_RP9: process.env.AXURE_DEFAULT_SETTINGS_RP9,
    AXURE_DEFAULT_SETTINGS_RP11: process.env.AXURE_DEFAULT_SETTINGS_RP11,
    AXURE_PANEL_TEMPLATE: process.env.AXURE_PANEL_TEMPLATE,
    AXURE_PANEL_TEMPLATE_NAME: process.env.AXURE_PANEL_TEMPLATE_NAME,
    AXURE_BLANK_TEMPLATE_RP9: process.env.AXURE_BLANK_TEMPLATE_RP9,
    AXURE_BLANK_TEMPLATE_RP11: process.env.AXURE_BLANK_TEMPLATE_RP11,
  };
  process.env.AXURE_APP_RP9 = '/nonexistent-rp9-app';
  process.env.AXURE_APP_RP11 = '/nonexistent-rp11-app';
  process.env.AXURE_DEFAULT_SETTINGS_RP9 = '/nonexistent-rp9-settings';
  process.env.AXURE_DEFAULT_SETTINGS_RP11 = '/nonexistent-rp11-settings';
  delete process.env.AXURE_PANEL_TEMPLATE;
  delete process.env.AXURE_PANEL_TEMPLATE_NAME;
  delete process.env.AXURE_BLANK_TEMPLATE_RP9;
  delete process.env.AXURE_BLANK_TEMPLATE_RP11;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function assertNative(filePath, version, label) {
  const nc = await nativeCheck(filePath, { version, compile: true });
  if (nc.status !== 'unavailable') {
    assert.equal(nc.status, 'accepted', `${label} failed nativeCheck: ${JSON.stringify(nc.error)}`);
    assert.equal(nc.officialCompile?.status, 'accepted', `${label} failed --compile: ${JSON.stringify(nc.officialCompile)}`);
  }
}

test('template-free: RP9 & RP11 DynamicPanel + Repeater + 5 native forms + full RP/1 compile pass without installed Axure', async () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-template-free-'));
  try {
    const outFiles = {};

    withoutAxureTemplates(() => {
      // 1. RP9 multi-state DynamicPanel + filled state content + click interaction
      const rp9Blank = synthesizeBlankProject({ version: 9, pageName: 'Page 1' });
      const rp9Panel = createPanel(rp9Blank, {
        pageName: 'Page 1',
        name: 'SynthPanel9',
        states: ['TabA', 'TabB'],
        x: 24,
        y: 24,
        width: 320,
        height: 180,
      }).file;
      const stateSrc = writeNativeScene(synthesizeBlankProject({ version: 9, pageName: 'Page 1' }), {
        scene: {
          items: [{
            itemType: 1,
            type: 0,
            name: 'InnerBtn',
            rect: { location: { x: 10, y: 10 }, size: { width: 100, height: 40 } },
            text: { paragraphs: [{ horizontalAlignment: 1, inlines: [{ text: 'Inside Tab', family: 'Arial', size: 13, weight: 600, textColor: { r: 17, g: 24, b: 39 } }] }] },
          }],
        },
      });
      const stateWithBtn = addInteractions(
        stateSrc,
        'InnerBtn',
        [{ event: 'OnClick', actions: [{ type: 'wait', ms: 20 }] }],
      ).file;
      const rp9Filled = fillPanelState(stateWithBtn, rp9Panel, {
        sourcePage: 'Page 1',
        targetPage: 'Page 1',
        panel: 'SynthPanel9',
        state: 'TabA',
        version: 9,
      }).file;
      const rp9PanelPath = join(work, 'synth-panel-9.rp');
      writeFileSync(rp9PanelPath, rp9Filled);
      const rp9Summary = readRp(rp9Filled);
      assert.equal(rp9Summary.counts.danglingRefs, 0);
      assert.equal(rp9Summary.counts.problems, 0);
      assert.equal(rp9Summary.counts.panelStates, 2);
      assert.equal(lintVersionKeys(rp9Filled, { version: 9 }).errors.length, 0);
      outFiles.rp9PanelPath = rp9PanelPath;

      // 2. RP11 multi-state DynamicPanel + PanelState
      const rp11Blank = synthesizeBlankProject({ version: 11, pageName: 'Page 1' });
      const rp11Panel = createPanel(rp11Blank, {
        pageName: 'Page 1',
        name: 'SynthPanel11',
        states: ['First', 'Second'],
        x: 32,
        y: 32,
        width: 340,
        height: 200,
      }).file;
      const rp11Filled = fillPanelState(stateSrc, rp11Panel, {
        sourcePage: 'Page 1',
        targetPage: 'Page 1',
        panel: 'SynthPanel11',
        state: 'First',
        version: 11,
      }).file;
      const rp11PanelPath = join(work, 'synth-panel-11.rp');
      writeFileSync(rp11PanelPath, rp11Filled);
      const rp11Summary = readRp(rp11Filled);
      assert.equal(rp11Summary.version, 11);
      assert.equal(rp11Summary.counts.danglingRefs, 0);
      assert.equal(rp11Summary.counts.problems, 0);
      assert.equal(rp11Summary.counts.panelStates, 2);
      assert.equal(lintVersionKeys(rp11Filled, { version: 11 }).errors.length, 0);
      outFiles.rp11PanelPath = rp11PanelPath;

      // 3. RP9 Repeater (columns + rows + item layout)
      const repHost = synthesizeBlankProject({ version: 9, pageName: 'Page 1' });
      const repRow = synthesizeBlankProject({ version: 9, pageName: 'Page 1' });
      const repBuf = createNativeRepeater(repHost, repRow, {
        name: 'SynthRepeater',
        x: 20,
        y: 20,
        w: 320,
        h: 220,
        rowGap: 8,
        model: { Title: 'string', Status: 'string' },
        rows: [
          { Title: 'Alpha', Status: 'Open' },
          { Title: 'Beta', Status: 'Done' },
        ],
      });
      const repPath = join(work, 'synth-repeater-9.rp');
      writeFileSync(repPath, repBuf);
      const repSummary = readRp(repBuf);
      assert.equal(repSummary.counts.danglingRefs, 0);
      assert.equal(repSummary.counts.problems, 0);
      assert.equal(repSummary.counts.widgets, 1);
      outFiles.repPath = repPath;

      // 4. All 5 native form controls (TextBox + RadioButton + Checkbox + ComboBox + ListBox)
      let formCursor = join(work, 'form-step-0.rp');
      writeFileSync(formCursor, synthesizeBlankProject({ version: 9, pageName: 'Page 1' }));

      const nextStep = n => join(work, `form-step-${n}.rp`);
      synthesizeNativeFormWidget(formCursor, nextStep(1), {
        kind: 'input',
        targetPageName: 'Page 1',
        name: 'plainInput',
        x: 20,
        y: 20,
        width: 240,
        height: 36,
        maxLength: 32,
        placeholder: '输入关键字',
        inputStyle: { fontSize: 14, fontWeight: 400, color: '#111827', align: 'left', textPaddingX: 8 },
      });
      materializeNativeControl(nextStep(1), nextStep(2), {
        kind: 'radio',
        pageName: 'Page 1',
        name: 'optA',
        x: 20,
        y: 72,
        width: 120,
        height: 20,
        text: '选项 A',
        group: 'g1',
        checked: true,
      });
      materializeNativeControl(nextStep(2), nextStep(3), {
        kind: 'checkbox',
        pageName: 'Page 1',
        name: 'agreeBox',
        x: 20,
        y: 104,
        width: 140,
        height: 20,
        text: '同意条款',
        checked: false,
      });
      materializeNativeControl(nextStep(3), nextStep(4), {
        kind: 'combobox',
        pageName: 'Page 1',
        name: 'cityDrop',
        x: 20,
        y: 136,
        width: 200,
        height: 32,
        options: ['北京', '上海', '深圳'],
        selectedIndex: 1,
      });
      materializeNativeControl(nextStep(4), nextStep(5), {
        kind: 'listbox',
        pageName: 'Page 1',
        name: 'roleList',
        x: 20,
        y: 184,
        width: 200,
        height: 96,
        options: ['Admin', 'Editor', 'Viewer'],
        multiple: true,
        selectedIndices: [0, 2],
      });
      const formsPath = nextStep(5);
      const formsBuf = readFileSync(formsPath);
      const formsSummary = readRp(formsBuf);
      assert.equal(formsSummary.counts.widgets, 5);
      assert.equal(formsSummary.counts.danglingRefs, 0);
      assert.equal(formsSummary.counts.problems, 0);
      assert.equal(lintVersionKeys(formsBuf, { version: 9 }).errors.length, 0);
      outFiles.formsPath = formsPath;

      // 5. Full mobile-cards recipe + full kitchen-sink RP/1 with panel + forms
      const cardsRes = generatePrototype({
        recipe: 'mobile-cards',
        output: join(work, 'cards-noax.rp'),
        cwd: work,
      });
      assert.equal(cardsRes.status, 'completed', JSON.stringify(cardsRes.diagnostics));
      outFiles.cardsPath = cardsRes.output;

      const kitchenRp1 = [
        'rp/1 target=9 name="KitchenSinkNoAxure"',
        'var v_query: text = ""',
        'page #home name="首页"',
        '  box #root [375x812] layout=column gap=12 padding=16',
        '    label #ttl [340x28] "无模板全量控件"',
        '    input #kw [340x40] placeholder="搜索"',
        '    checkbox #chk [160x24] "启用筛选" checked=true',
        '    radio #r1 [120x24] "全部" group="f" checked=true',
        '    combobox #cb [200x36] options=["高","中","低"] selectedIndex=0',
        '    listbox #lb [200x90] options=["A","B","C"] selectedIndex=0',
        '    panel #dp [340x160]',
        '      state #st1',
        '        label #s1_txt [200x28] "面板状态一"',
        '      state #st2',
        '        label #s2_txt [200x28] "面板状态二"',
        '    button #go [160x40] "切态"',
        '      +onClick [{"type":"set-panel-state","target":"dp","state":"st2"}]',
      ].join('\n');
      const ksRes = generatePrototype({
        rp1: kitchenRp1,
        output: join(work, 'kitchen-noax.rp'),
        cwd: work,
      });
      assert.equal(ksRes.status, 'completed', JSON.stringify(ksRes.diagnostics));
      const ksBuf = readFileSync(ksRes.output);
      const ksInfo = readRp(ksBuf);
      assert.equal(ksInfo.counts.danglingRefs, 0);
      assert.equal(ksInfo.counts.problems, 0);
      assert.ok(ksInfo.counts.panelStates >= 2);
      outFiles.kitchenPath = ksRes.output;
    });

    await assertNative(outFiles.rp9PanelPath, 9, 'RP9 synthesized panel');
    await assertNative(outFiles.rp11PanelPath, 11, 'RP11 synthesized panel');
    await assertNative(outFiles.repPath, 9, 'RP9 synthesized repeater');
    await assertNative(outFiles.formsPath, 9, 'RP9 synthesized 5 forms');
    await assertNative(outFiles.cardsPath, 9, 'RP9 template-free mobile-cards');
    await assertNative(outFiles.kitchenPath, 9, 'RP9 template-free kitchen-sink');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
