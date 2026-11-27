import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { createBlankPage } from '../scripts/create-blank-page.mjs';
import { createGlobalVariable } from '../scripts/create-global-variable.mjs';
import { diffRp, formatDiffRp } from '../scripts/diff-rp.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { setWidgetText } from '../scripts/set-widget-text.mjs';

test('diff-rp: 真阴性对比报告零噪音，真阳性精确命中两处已知修改', () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-diff-rp-'));
  try {
    const blank = synthesizeBlankProject({ version: 9 });
    const base = writeNativeScene(blank, {
      scene: {
        items: [
          {
            itemType: 1, type: 0, name: 'TitleLabel', rect: { location: { x: 20, y: 20 }, size: { width: 200, height: 32 } },
            text: { paragraphs: [{ horizontalAlignment: 0, inlines: [{ text: 'Old Title', family: 'Arial', size: 16, weight: 400, textColor: { r: 0, g: 0, b: 0 } }] }] },
          },
          {
            itemType: 1, type: 0, name: 'ActionBtn', rect: { location: { x: 20, y: 80 }, size: { width: 120, height: 40 } },
            text: { paragraphs: [{ horizontalAlignment: 1, inlines: [{ text: 'Go', family: 'Arial', size: 14, weight: 600, textColor: { r: 255, g: 255, b: 255 } }] }] },
          },
          {
            itemType: 1, type: 0, name: 'UntouchedBox', rect: { location: { x: 20, y: 140 }, size: { width: 120, height: 40 } },
            text: { paragraphs: [{ horizontalAlignment: 0, inlines: [{ text: 'Static', family: 'Arial', size: 12, weight: 400, textColor: { r: 0, g: 0, b: 0 } }] }] },
          },
        ],
      },
    });
    const basePath = join(work, 'base.rp');
    const step1Path = join(work, 'step1.rp');
    const step2Path = join(work, 'step2.rp');
    writeFileSync(basePath, base);

    // 真阴性：自身对比零变更
    const same = diffRp(basePath, basePath);
    assert.equal(same.hasChanges, false);
    assert.equal(same.summary.totalChanges, 0);
    assert.match(formatDiffRp(same), /无结构变化/);

    // 真阳性：仅修改 TitleLabel 文本 + 给 ActionBtn 添加 OnClick
    setWidgetText(basePath, step1Path, 'Page 1', 'TitleLabel', 'New Title');
    const { file: afterIx } = addInteractions(readFileSync(step1Path), 'ActionBtn', [
      { event: 'OnClick', actions: [{ type: 'wait', ms: 50 }] },
    ]);
    writeFileSync(step2Path, afterIx);

    const diff = diffRp(basePath, step2Path);
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.summary.totalChanges, 2);
    assert.equal(diff.summary.widgetsModified, 1);
    assert.equal(diff.summary.interactionsChanged, 1);
    assert.equal(diff.changes.widgets[0].widget, 'TitleLabel');
    assert.deepEqual(diff.changes.widgets[0].changes.text, { before: 'Old Title', after: 'New Title' });
    assert.equal(diff.changes.interactions[0].widget, 'ActionBtn');
    assert.equal(diff.changes.interactions[0].after[0].event, 'OnClick');
    assert.ok(!diff.changes.widgets.some(w => w.widget === 'UntouchedBox'));

    // 页面增删 + 全局变量增改
    const withPage = createBlankPage(afterIx, 'Second Page').file;
    const withVar = createGlobalVariable(withPage, 'StepCount', { defaultValue: '7' }).file;
    const structuralDiff = diffRp(step2Path, withVar);
    assert.equal(structuralDiff.summary.pagesAdded, 1);
    assert.equal(structuralDiff.summary.variablesChanged, 1);
    assert.equal(structuralDiff.changes.pages[0].page, 'Second Page');
    assert.equal(structuralDiff.changes.variables[0].name, 'StepCount');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('diff-rp: 多页 RP/1 性能与 GUI 重存真阴性（存在本地样本时）', () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-diff-perf-'));
  try {
    const gen = generatePrototype({
      recipe: 'mobile-cards',
      output: join(work, 'cards.rp'),
      cwd: work,
    });
    assert.equal(gen.status, 'completed');
    const t0 = performance.now();
    const selfDiff = diffRp(gen.output, gen.output);
    const ms = performance.now() - t0;
    assert.equal(selfDiff.summary.totalChanges, 0);
    assert.ok(ms < 2000, `diffRp took ${ms.toFixed(1)} ms`);

    const calcA = '/Users/lilzee/axure-exp/outputs/native-program-20261127/calculator-nameless.rp';
    const calcB = '/Users/lilzee/axure-exp/outputs/native-program-20261127/calculator-nameless-gui.rp';
    if (existsSync(calcA) && existsSync(calcB)) {
      const guiDiff = diffRp(calcA, calcB);
      assert.equal(guiDiff.summary.totalChanges, 0, JSON.stringify(guiDiff.changes, null, 2));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
