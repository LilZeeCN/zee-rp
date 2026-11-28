import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportPrototype, runWorkflow, verifyOfficialPreview } from '../scripts/authoring-workflow.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { findChromeExecutable } from '../studio/cdp.mjs';

const HAS_RP9_APP = existsSync('/Applications/Axure RP 9.app');

test('verify-observability: compact 瘦身、无静默丢步、失败置顶与跨页 tab 点击不崩溃', { timeout: 90_000 }, async t => {
  try { findChromeExecutable(); } catch { return t.skip('未检测到 Chrome/Chromium'); }
  const work = mkdtempSync(join(tmpdir(), 'zee-verify-obs-'));
  try {
    const rpOut = join(work, 'multi-tab.rp');
    const rp1 = [
      'rp/1 target=9 name="VerifyObservability"',
      'page #home name="首页"',
      '  box #root1 [375x667] layout=column gap=12 padding=16',
      '    label #home_title [320x32] "首页标题"',
      '    button #home_btn [160x40] "点我"',
      '      +onClick [{"type":"set-text","target":"home_title","text":"已点击"}]',
      '    box #tab_bar [340x52] layout=row gap=8',
      '      button #tab_home [160x44] "首页Tab" goto="home"',
      '      button #tab_detail [160x44] "详情Tab" goto="detail"',
      'page #detail name="详情页"',
      '  box #root2 [375x667] layout=column gap=12 padding=16',
      '    label #detail_title [320x32] "详情页内容"',
      '    button #back_btn [160x40] "回首页" goto="home"',
    ].join('\n');

    const gen = generatePrototype({ rp1, output: rpOut, cwd: work });
    assert.equal(gen.status, 'completed', JSON.stringify(gen.diagnostics));

    // 1. compact: true strips initial.widgets and keeps payload compact
    const compactOk = await verifyOfficialPreview({
      rp: gen.output,
      source: gen.source,
      engine: 'studio-html',
      compact: true,
      cwd: work,
      steps: [
        { action: 'click', target: 'home_btn' },
        { action: 'expect', target: 'home_title', expect: { text: '已点击' } },
      ],
    }, { runWorkflow, exportHtml: exportPrototype });
    assert.equal(compactOk.status, 'completed', JSON.stringify(compactOk));
    assert.equal(compactOk.passed, 2);
    assert.equal(compactOk.initial.widgets, undefined);
    assert.ok(compactOk.initial.widgetCount >= 5);
    assert.ok(JSON.stringify(compactOk).length < 10_000);

    // 2. Unresolved target is NEVER dropped silently; failedStep & diagnostics appear FIRST
    const unresolvedFail = await verifyOfficialPreview({
      rp: gen.output,
      source: gen.source,
      engine: 'studio-html',
      compact: true,
      cwd: work,
      steps: [
        { action: 'expect', target: 'home_title', expect: { text: '首页标题' } },
        { action: 'click', target: 'missing_widget_id' },
        { action: 'expect', target: 'home_title', expect: { text: '不会执行到' } },
      ],
    }, { runWorkflow, exportHtml: exportPrototype });
    assert.equal(unresolvedFail.status, 'failed');
    assert.equal(unresolvedFail.passed, 1);
    assert.equal(unresolvedFail.total, 3);
    assert.equal(unresolvedFail.steps.length, 2);
    assert.equal(unresolvedFail.steps[0].status, 'passed');
    assert.equal(unresolvedFail.steps[1].status, 'failed');
    assert.ok(unresolvedFail.steps[1].code);
    assert.ok(unresolvedFail.steps[1].error);
    assert.equal(unresolvedFail.failedStep.index, 1);
    assert.equal(unresolvedFail.diagnostics[0].stepIndex, 1);
    assert.ok(Array.isArray(unresolvedFail.diagnostics[0].availableTargets) && unresolvedFail.diagnostics[0].availableTargets.length > 0);
    const keys = Object.keys(unresolvedFail);
    assert.ok(keys.indexOf('diagnostics') < keys.indexOf('steps'), `Expected diagnostics before steps: ${keys.join(',')}`);
    assert.ok(keys.indexOf('failedStep') < keys.indexOf('initial'), `Expected failedStep before initial: ${keys.join(',')}`);

    // 3. Cross-page bottom tab click must survive navigation cleanly and land on detail page
    const crossPage = await verifyOfficialPreview({
      rp: gen.output,
      source: gen.source,
      engine: 'studio-html',
      compact: true,
      cwd: work,
      steps: [
        { action: 'click', target: 'tab_detail' },
        { action: 'expect', target: 'detail_title', expect: { text: '详情页内容', visible: true } },
      ],
    }, { runWorkflow, exportHtml: exportPrototype });
    assert.equal(crossPage.status, 'completed', JSON.stringify(crossPage.diagnostics));
    assert.equal(crossPage.passed, 2);
    assert.equal(crossPage.total, 2);

    if (HAS_RP9_APP) {
      const crossOfficial = await verifyOfficialPreview({
        rp: gen.output,
        source: gen.source,
        engine: 'official',
        compact: true,
        cwd: work,
        steps: [
          { action: 'click', target: 'tab_detail' },
          { action: 'expect', target: 'detail_title', expect: { text: '详情页内容', visible: true } },
        ],
      }, { runWorkflow, exportHtml: exportPrototype });
      assert.equal(crossOfficial.status, 'completed', JSON.stringify(crossOfficial.diagnostics));
      assert.equal(crossOfficial.passed, 2);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
