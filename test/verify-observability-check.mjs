import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportPrototype, runWorkflow, verifyOfficialPreview } from '../scripts/authoring-workflow.mjs';
import { generatePrototype, sessionTools } from '../scripts/mcp-tools.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import { readRp } from '../scripts/rp-read.mjs';
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

test('rp/1 textarea, input multiline=true, and nested if/elif/else work end-to-end across native RP, Chrome, and decompile', { timeout: 120_000 }, async t => {
  try { findChromeExecutable(); } catch { return t.skip('未检测到 Chrome/Chromium'); }
  const work = mkdtempSync(join(tmpdir(), 'zee-rp1-textarea-nested-'));
  try {
    const rpOut = join(work, 'textarea-nested.rp');
    const rp1 = [
      'rp/1 target=9 name="TextareaAndNestedIf"',
      'var mode: number = 1',
      'var sub: number = 0',
      'page #home name="首页"',
      '  box #root [390x720] layout=column gap=12 padding=16',
      '    textarea #bio [350x96] value="" placeholder="请输入简介"',
      '      +onChange:',
      '        set bio_out = @bio',
      '    input #notes [350x96] multiline=true value="初始多行"',
      '    label #bio_out [350x28] "等待输入"',
      '    label #branch_out [350x28] "待判定"',
      '    button #btn_toggle_mode [160x40] "切换mode=0"',
      '      +onClick:',
      '        set $mode = 0',
      '    button #btn_eval [160x40] "执行嵌套判断"',
      '      +onClick:',
      '        if var.mode == 1',
      '          if var.sub == 1',
      '            set branch_out = "hit_m1_s1"',
      '        else',
      '          if var.sub == 1',
      '            set branch_out = "hit_m0_s1"',
      '          else',
      '            set branch_out = "hit_m0_s0"',
    ].join('\n');

    const gen = generatePrototype({ rp1, output: rpOut, cwd: work });
    assert.equal(gen.status, 'completed', JSON.stringify(gen.diagnostics));

    const summary = readRp(readFileSync(rpOut));
    const bioWidget = summary.pages[0].widgets.find(w => w.name?.includes('bio-'));
    const notesWidget = summary.pages[0].widgets.find(w => w.name?.includes('notes-'));
    assert.equal(bioWidget?.type, 'TextArea');
    assert.equal(notesWidget?.type, 'TextArea');

    if (HAS_RP9_APP) {
      const nc = await nativeCheck(rpOut, { version: 9, compile: true });
      assert.equal(nc.status, 'accepted', JSON.stringify(nc));
      assert.equal(nc.officialCompile?.status, 'accepted', JSON.stringify(nc));
    }

    const syncTool = sessionTools.find(tool => tool.name === 'sync_prototype');
    const decompiled = await syncTool.handler({ mode: 'decompile', rp: rpOut, outSource: join(work, 'lifted.rp1'), output: join(work, 'lifted-editable.rp'), cwd: work });
    assert.equal(decompiled.ok, true, JSON.stringify(decompiled));
    const liftedText = readFileSync(join(work, 'lifted.rp1'), 'utf8');
    assert.match(liftedText, /textarea #/);

    for (const engine of (HAS_RP9_APP ? ['studio-html', 'official'] : ['studio-html'])) {
      const verifyRes = await verifyOfficialPreview({
        rp: gen.output,
        source: gen.source,
        engine,
        compact: true,
        cwd: work,
        steps: [
          { action: 'fill', target: 'bio', value: '多行反馈文本' },
          { action: 'expect', target: 'bio_out', expect: { text: '多行反馈文本' } },
          // mode=1, sub=0: incomplete inner if must NOT fall into outer else ("hit_m0_s0")
          { action: 'click', target: 'btn_eval' },
          { action: 'expect', target: 'branch_out', expect: { text: '待判定' } },
          // switch mode=0 -> hits outer else -> inner else ("hit_m0_s0")
          { action: 'click', target: 'btn_toggle_mode' },
          { action: 'click', target: 'btn_eval' },
          { action: 'expect', target: 'branch_out', expect: { text: 'hit_m0_s0' } },
        ],
      }, { runWorkflow, exportHtml: exportPrototype });
      assert.equal(verifyRes.status, 'completed', `${engine}: ${JSON.stringify(verifyRes.diagnostics)}`);
      assert.equal(verifyRes.passed, 7);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
