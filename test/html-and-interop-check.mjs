import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../scripts/doctor.mjs';
import { authoringTools, verifyOfficialPreview } from '../scripts/authoring-workflow.mjs';
import { sessionTools } from '../scripts/mcp-tools.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { launchChrome, findChromeExecutable } from '../studio/cdp.mjs';
import { closeInProcessStudioServer, studioHandlers } from '../studio/mcp-adapter.mjs';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

function chromeSkipReason() {
  try {
    findChromeExecutable();
    return false;
  } catch (err) {
    return err.message;
  }
}

const mcpToolMap = Object.fromEntries(sessionTools.map(t => [t.name, t.handler]));
const authoringToolMap = Object.fromEntries(
  authoringTools({
    generate: opts => mcpToolMap.generate_prototype(opts),
    sync: opts => mcpToolMap.sync_prototype(opts),
    listTools: () => [],
  }).map(t => [t.name, t.handler])
);

test('Studio inline rp1 <-> export format:rp1 roundtrip works offline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-studio-rp1-rt-'));
  try {
    const inlineRp1 = [
      'rp/1 target=9 name="双向互通" domain=web theme=enterprise-light',
      'var clicks: number = 1',
      'page #home name="首页" canvas=[640,480]',
      '  box #root [640x480] layout=stack fill=#FFFFFF',
      '    label #heading [300x32] x=24 y=24 "互通标题" fontSize=20 fontWeight=600 color=#0F172A',
      '    button #cta [140x44] x=24 y=72 "点击加一"',
      '      +onClick:',
      '        set $clicks = var.clicks + 1',
    ].join('\n');

    const opened = await studioHandlers.studio_open_project({
      projectDir: join(dir, 'proj'),
      rp1: inlineRp1,
      port: 0,
      domain: 'web',
    });
    assert.ok(opened.ok);
    const ctx = await studioHandlers.studio_inspect({ projectDir: join(dir, 'proj'), view: 'context' });
    assert.equal(ctx.doc.pages.length, 1);

    const exported = await studioHandlers.studio_export({
      projectDir: join(dir, 'proj'),
      format: 'rp1',
      outRp1Path: join(dir, 'roundtrip.rp1'),
    });
    assert.equal(exported.ok, true);
    assert.equal(exported.format, 'rp1');
    assert.ok(existsSync(join(dir, 'roundtrip.rp1')));
    assert.match(exported.rp1Text, /^rp\/1\b/m);
    assert.match(exported.rp1Text, /互通标题/);

    const diag = authoringToolMap.diagnose_prototype({ rp1: exported.rp1Text });
    assert.equal(diag.ok, true, JSON.stringify(diag));
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Studio opens native .rp via decompile & generate_from_image emits editable .rp1', { skip: nativeTemplateSkipReason() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-rp-studio-emit-'));
  try {
    const sampleSpec = {
      language: 'rp/1',
      target: 9,
      name: '原生导入样本',
      domain: 'web',
      theme: 'enterprise-light',
      pages: [
        {
          id: 'home',
          name: '主画板',
          canvas: [480, 360],
          root: {
            type: 'box',
            id: 'root',
            layout: 'stack',
            w: 480,
            h: 360,
            fill: '#FFFFFF',
            children: [
              { type: 'label', id: 'lbl', x: 24, y: 24, w: 300, h: 28, text: '从原生 .rp 还原', fontSize: 16, color: '#0F172A' },
              { type: 'button', id: 'go', x: 24, y: 72, w: 120, h: 40, text: '确定' },
            ],
          },
        },
      ],
    };
    const specFile = join(dir, 'seed.json');
    writeFileSync(specFile, JSON.stringify(sampleSpec, null, 2));

    const { generatePrototype } = await import('../scripts/mcp-tools.mjs');
    const gen = generatePrototype({ source: specFile, output: join(dir, 'seed.rp') });
    assert.equal(gen.status, 'completed');

    const studioOpened = await studioHandlers.studio_open_project({
      projectDir: join(dir, 'studio-from-rp'),
      sourcePath: gen.output,
      port: 0,
    });
    assert.ok(studioOpened.ok);
    const inspected = await studioHandlers.studio_inspect({ projectDir: join(dir, 'studio-from-rp'), view: 'nodes', limit: 20 });
    assert.ok(inspected.nodes.some(n => (n.text || '').includes('从原生 .rp 还原')));

    const imgSpec = {
      schemaVersion: 1,
      scale: 1,
      frames: [
        {
          name: 'img-page',
          x: 0,
          y: 0,
          w: 360,
          h: 240,
          bg: '#FFFFFF',
          children: [
            { kind: 'rect', id: 'card1', x: 16, y: 16, w: 328, h: 96, fill: '#F8FAFC', stroke: '#CBD5E1', radius: 12 },
            { kind: 'text', id: 'title1', x: 32, y: 36, w: 200, h: 24, content: '截图还原标题', fontSize: 16, color: '#0F172A' },
          ],
        },
      ],
    };
    const imgRes = await mcpToolMap.generate_from_image({
      spec: imgSpec,
      output: join(dir, 'from-image.rp'),
      emitRp1: true,
    });
    assert.equal(imgRes.status, 'completed', JSON.stringify(imgRes));
    assert.ok(existsSync(imgRes.rp1Source));
    const imgRp1 = readFileSync(imgRes.rp1Source, 'utf8');
    assert.match(imgRp1, /^rp\/1\b/m);
    assert.match(imgRp1, /截图还原标题/);
    const imgDiag = authoringToolMap.diagnose_prototype({ rp1: imgRp1 });
    assert.equal(imgDiag.ok, true, JSON.stringify(imgDiag));
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTML file imports cleanly into Studio (+ optional native .rp + .rp1)', { skip: chromeSkipReason() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-html-import-'));
  try {
    const htmlPath = join(dir, 'sample.html');
    writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>HTML 导入样板</title>
<style>
  body { margin: 0; font-family: sans-serif; background: #F8FAFC; }
  .card { width: 420px; margin: 24px; padding: 20px; background: #FFFFFF; border-radius: 12px; border-bottom: 2px solid #CBD5E1; box-shadow: 0 4px 12px rgba(15,23,42,0.08); }
  .title { font-size: 20px; font-weight: 700; color: #0F172A; margin-bottom: 12px; }
  input[type="text"] { width: 320px; height: 40px; padding: 0 12px; border: 1px solid #CBD5E1; border-radius: 8px; display: block; margin-bottom: 12px; }
  select { width: 320px; height: 40px; display: block; margin-bottom: 12px; }
  button { width: 160px; height: 40px; background: #2563EB; color: #FFFFFF; border: none; border-radius: 8px; }
</style>
</head>
<body>
  <div id="main_card" class="card">
    <div id="hero_title" class="title">登录账户</div>
    <svg id="brand_icon" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#2563EB"/></svg>
    <input id="email_inp" type="text" placeholder="输入邮箱" maxlength="32" />
    <select id="role_sel"><option>产品经理</option><option selected>设计师</option></select>
    <label><input id="agree_chk" type="checkbox" checked />同意服务条款</label>
    <button id="submit_btn">立即登录</button>
  </div>
</body>
</html>`, 'utf8');

    const projDir = join(dir, 'studio-html-proj');
    const opened = await studioHandlers.studio_open_project({
      projectDir: projDir,
      sourcePath: 'sample.html',
      cwd: dir,
      domain: 'web',
      port: 0,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.ok(opened.htmlImport.nodeCount >= 5);
    assert.ok(opened.htmlImport.formControlCount >= 4);
    assert.ok(opened.htmlImport.svgCount >= 1);
    assert.ok(existsSync(join(projDir, '.imported-html.rp1')));

    const nodesRes = await studioHandlers.studio_inspect({ projectDir: projDir, view: 'nodes', limit: 40 });
    const types = new Set(nodesRes.nodes.map(n => n.type));
    assert.ok(types.has('input'), `Expected input node, got ${[...types]}`);
    assert.ok(types.has('combobox'), `Expected combobox node, got ${[...types]}`);
    assert.ok(types.has('checkbox'), `Expected checkbox node, got ${[...types]}`);
    assert.ok(types.has('button'), `Expected button node, got ${[...types]}`);
    assert.ok(types.has('image'), `Expected image node for SVG, got ${[...types]}`);

    const rp1Out = await studioHandlers.studio_export({ projectDir: projDir, format: 'rp1' });
    assert.equal(rp1Out.ok, true);
    assert.match(rp1Out.rp1Text, /登录账户/);

    if (!nativeTemplateSkipReason()) {
      const { generatePrototype } = await import('../scripts/mcp-tools.mjs');
      const rpGen = generatePrototype({ source: join(projDir, '.imported-html.rp1'), output: join(dir, 'from-html.rp') });
      assert.equal(rpGen.status, 'completed', JSON.stringify(rpGen));
      const parsed = readRp(readFileSync(rpGen.output));
      assert.equal(parsed.records.unparseable, 0);
      assert.equal(parsed.counts.danglingRefs, 0);
    }
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Studio preview drag/swipe/timer (#18) and cross-platform verify_prototype(engine="studio-html") work in real Chrome', { skip: chromeSkipReason() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-verify-studio-html-'));
  let browser = null;
  try {
    const interactiveRp1 = [
      'rp/1 target=9 name="交互全闭环" domain=web theme=enterprise-light',
      'var count: number = 0',
      'page #home name="首页" canvas=[440,420]',
      '  box #root [440x420] layout=stack fill=#FFFFFF',
      '    label #status [380x28] x=24 y=16 "状态:0" fontSize=16 color=#0F172A',
      '    button #btn [120x40] x=24 y=52 "点我+1"',
      '      +onClick:',
      '        set $count = var.count + 1',
      '        set @status = "状态:${text(var.count)}"',
      '    input #inp [220x40] x=160 y=52 placeholder="最多5字" maxLength=5',
      '    box #track [240x24] x=24 y=110 fill=#E2E8F0 radius=12',
      '    box #thumb [40x32] x=24 y=106 fill=#2563EB radius=8',
      '      +onDrag:',
      '        move thumb drag-x bounds={"left":24,"right":264}',
      '    panel #carousel [380x140] x=24 y=170',
      '      +onLoad:',
      '        panel carousel next loop=true repeat=true repeatInterval=400',
      '      +onSwipeLeft:',
      '        panel carousel next',
      '      :state s1',
      '        label #s1_txt [200x32] x=16 y=16 "第一屏"',
      '      :state s2',
      '        label #s2_txt [200x32] x=16 y=16 "第二屏"',
      '      :state s3',
      '        label #s3_txt [200x32] x=16 y=16 "第三屏"',
    ].join('\n');

    const projDir = join(dir, 'proj');
    const opened = await studioHandlers.studio_open_project({
      projectDir: projDir,
      rp1: interactiveRp1,
      domain: 'web',
      port: 0,
    });
    assert.ok(opened.ok, JSON.stringify(opened));

    // 1. Verify Studio server runtime endpoints: /api/runtime/drag, /api/runtime/swipe, /api/runtime/tick
    const baseUrl = opened.url.replace(/\/$/, '');
    const postRt = async (path, body) => (await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    const rt0 = await postRt('/api/runtime/reset', { startPageId: 'home' });
    assert.equal(rt0.state.panelStates['home/carousel'], 's1');
    assert.equal(rt0.state.panelTimers['home/carousel'].intervalMs, 400);

    const rtDrag = await postRt('/api/runtime/drag', { targetId: 'thumb', dx: 500, dy: 0 });
    assert.equal(rtDrag.state.widgetPositions['home/thumb'].x, 224, 'Bounded drag-x must clamp at right(264) - w(40) = 224');

    const rtSwipe = await postRt('/api/runtime/swipe', { targetId: 'carousel', direction: 'left' });
    assert.equal(rtSwipe.state.panelStates['home/carousel'], 's2');

    const rtTick = await postRt('/api/runtime/tick', { ms: 400 });
    assert.equal(rtTick.state.panelStates['home/carousel'], 's3');

    // 2. Verify Studio web preview canvas interact mode with real mouse gestures in Chrome
    browser = await launchChrome({ headless: true, width: 1280, height: 860, dpr: 1 });
    const studioPage = await browser.openPage(baseUrl);
    await studioPage.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__ >= 1)', 10000);
    await studioPage.evaluate('document.querySelector(\'#mode-switcher button[data-mode="interact"]\').click()');
    await studioPage.waitForFunction('Boolean(window.__STUDIO_APP__?.state?.mode === "interact" && window.__STUDIO_APP__?.state?.runtimeState)', 10000);
    const thumbCenter = await studioPage.evaluate(`(() => {
      const r = document.querySelector('#screen-root [data-node-id="thumb"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await studioPage.mouseDrag(thumbCenter.x, thumbCenter.y, thumbCenter.x + 80, thumbCenter.y, { steps: 6, stepDelayMs: 8 });
    await studioPage.waitForFunction('Number(window.__STUDIO_APP__?.state?.runtimeState?.widgetPositions?.["home/thumb"]?.x) > 24', 5000);
    await browser.close();
    browser = null;

    // 3. Export standalone Studio HTML & verify end-to-end via verify_prototype(engine="studio-html")
    const codeDir = join(dir, 'exported-html');
    const codeRes = await studioHandlers.studio_export({
      projectDir: projDir,
      format: 'code',
      outDir: codeDir,
    });
    assert.equal(codeRes.ok, true);

    const storyboardPng = join(dir, 'storyboard.png');
    const verifyRes = await verifyOfficialPreview({
      html: codeDir,
      engine: 'studio-html',
      cwd: dir,
      virtualClock: true,
      storyboard: storyboardPng,
      includeStoryboard: true,
      includeImage: true,
      viewport: { width: 440, height: 420, dpr: 1 },
      steps: [
        { action: 'click', target: 'btn', expect: { variable: 'count', equals: 1 } },
        { action: 'expect', target: 'status', expect: { text: '状态:1' } },
        { action: 'fill', target: 'inp', value: '1234567', expect: { value: '12345' } },
        { action: 'drag', target: 'thumb', dx: 400, dy: 0, expect: { x: 224 } },
        { action: 'swipe', target: 'carousel', direction: 'left', expect: { panelState: 's2' } },
        { action: 'advanceTime', target: 'carousel', ms: 400, expect: { panelState: 's3' } },
      ],
    }, { runWorkflow: () => { throw new Error('unused'); }, exportHtml: async () => ({ status: 'failed' }) });

    assert.equal(verifyRes.status, 'completed', JSON.stringify(verifyRes.diagnostics || verifyRes));
    assert.equal(verifyRes.engine, 'studio-html');
    assert.equal(verifyRes.evidence, 'studio-html-cdp');
    assert.equal(verifyRes.passed, 6);
    assert.ok(existsSync(storyboardPng));
    assert.ok(verifyRes.mcpImages?.length >= 1);
  } finally {
    try { await browser?.close(); } catch {}
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zee-rp doctor CLI & runDoctor() report capability matrix cleanly', () => {
  const report = runDoctor();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.checks.node.ok, true);
  assert.equal(report.checks.python.ok, true);
  assert.equal(report.checks.pythonDeps.ok, true);
  assert.equal(typeof report.capabilities.studioCanvas, 'boolean');
  assert.equal(typeof report.capabilities.htmlImportAndChromeVerify, 'boolean');

  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const cliOut = execFileSync(process.execPath, [join(rootDir, 'bin/axure.mjs'), 'doctor', '--json'], {
    cwd: rootDir, encoding: 'utf8',
  });
  const cliReport = JSON.parse(cliOut);
  assert.equal(cliReport.ok, true);
  assert.deepEqual(Object.keys(cliReport.capabilities), Object.keys(report.capabilities));
});

test('generate_from_image supports autoFix:true + emitRp1 + studio-html Chrome verify', {
  skip: chromeSkipReason() || nativeTemplateSkipReason(),
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-img-autofix-verify-'));
  try {
    const imgSpec = {
      schemaVersion: 1,
      scale: 1,
      frames: [
        {
          name: 'autofix-page',
          x: 0,
          y: 0,
          w: 420,
          h: 280,
          bg: '#FFFFFF',
          children: [
            { kind: 'rect', id: 'card1', x: 16, y: 16, w: 388, h: 120, fill: '#F8FAFC', stroke: '#CBD5E1', radius: 12 },
            { kind: 'text', id: 'heading1', x: 32, y: 36, w: 240, h: 28, content: '视觉闭环标题', fontSize: 18, color: '#0F172A' },
          ],
        },
      ],
    };
    const res = await mcpToolMap.generate_from_image({
      spec: imgSpec,
      output: join(dir, 'healed-from-img.rp'),
      emitRp1: true,
      autoFix: true,
      verifyEngine: 'studio-html',
      verify: [
        { action: 'expect', target: 'w_4', expect: { visible: true, text: '视觉闭环标题' } },
      ],
    });
    assert.equal(res.status, 'completed', JSON.stringify(res));
    assert.equal(res.autoFix?.attempted, true);
    assert.ok(existsSync(res.rp1Source));
    assert.equal(res.verificationReport?.status, 'completed', JSON.stringify(res.verificationReport));
    assert.equal(res.verification?.evidence, 'studio-html-cdp');
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Blind-test consensus fixes: column/row aliases, contains/hints, single-else flatten, 402 grid & flow fix_plan, rp_patch hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-blind-fixes-'));
  try {
    const opened = await studioHandlers.studio_open_project({
      projectDir: join(dir, 'proj'),
      domain: 'mobile',
      port: 0,
    });
    assert.ok(opened.ok);
    const rev1 = opened.appliedRevision;

    // 1. addNode accepts column / row aliases and normalizes to box + layout
    // 2. flow children in column + full 402 board width exempt from grid offenders + fix_plan skips flow y
    // 3. single-else branch works in studio_scenario AND flattens cleanly when exporting .rp
    const cmdRes = await studioHandlers.studio_command({
      projectDir: join(dir, 'proj'),
      baseRevision: rev1,
      idempotencyKey: 'blind-fix-1',
      commands: [
        {
          type: 'addNode',
          pageId: 'home',
          node: {
            id: 'col_wrap',
            type: 'column',
            w: 402,
            h: 320,
            padding: [16, 16, 16, 16],
            gap: 12,
            children: [
              { id: 'box_holder', type: 'row', w: 370, h: 48, children: [{ id: 'inner_lbl', type: 'label', text: '内部标签', w: 120, h: 24 }] },
              {
                id: 'single_else_btn',
                type: 'button',
                text: '点我再练',
                w: 160,
                h: 44,
                on: {
                  click: {
                    cases: [
                      { else: true, actions: [{ type: 'set-text', target: 'feedback_lbl', text: '再练一次' }] },
                    ],
                  },
                },
              },
              { id: 'feedback_lbl', type: 'label', text: '初始反馈', w: 200, h: 24 },
            ],
          },
        },
      ],
    });
    assert.equal(cmdRes.ok, true, JSON.stringify(cmdRes));

    // Confirm 402 width did not produce an offender on col_wrap, and flow child doesn't emit bogus y patch
    const metrics = await studioHandlers.studio_design({ projectDir: join(dir, 'proj'), pageId: 'home', action: 'metrics', pixelTruth: false });
    assert.ok(!metrics.metrics.gridAlignment.offenders.some(o => o.id === 'col_wrap' && o.prop === 'w'));
    const fixPlan = await studioHandlers.studio_design({ projectDir: join(dir, 'proj'), pageId: 'home', action: 'fix_plan' });
    assert.ok(!fixPlan.commands.some(c => c.nodeId === 'box_holder' && c.properties?.y !== undefined));

    // Scenario: { contains } works cleanly
    const scenOk = await studioHandlers.studio_scenario({
      projectDir: join(dir, 'proj'),
      startPageId: 'home',
      steps: [
        { action: 'click', target: 'single_else_btn', expect: { text: { feedback_lbl: { contains: '再练' } } } },
      ],
    });
    assert.equal(scenOk.ok, true, JSON.stringify(scenOk));

    // Unknown object operator in expect.text rejects loudly instead of silent false
    const scenBadOp = await studioHandlers.studio_scenario({
      projectDir: join(dir, 'proj'),
      startPageId: 'home',
      steps: [{ action: 'expect', expect: { text: { feedback_lbl: { matchRegex: '再练' } } } }],
    });
    assert.equal(scenBadOp.ok, false);
    assert.equal(scenBadOp.code, 'E_SCENARIO_STEP');

    // Container text assertion failure emits helpful container hint
    const scenBox = await studioHandlers.studio_scenario({
      projectDir: join(dir, 'proj'),
      startPageId: 'home',
      steps: [{ action: 'expect', expect: { text: { box_holder: '内部标签' } } }],
    });
    assert.equal(scenBox.ok, false);
    assert.match(scenBox.stepResults[0].assertions[0].hint || '', /容器节点不聚合子节点文本/);

    // rp_patch without active session includes Studio redirect hint
    assert.throws(
      () => mcpToolMap.rp_patch({ edits: [{ selector: { id: 'x' } }] }),
      err => /studio_command/.test(err.message)
    );

    // single-else export to native .rp compiles without "else must end a conditional chain"
    if (!nativeTemplateSkipReason()) {
      const rpOut = await studioHandlers.studio_export({
        projectDir: join(dir, 'proj'),
        format: 'rp',
        outRpPath: join(dir, 'single-else.rp'),
      });
      assert.equal(rpOut.ok, true, JSON.stringify(rpOut));
    }

    // explore states-only (4 states + label, without candidates) renders real Chrome states cleanly
    if (!chromeSkipReason()) {
      const expStates = await studioHandlers.studio_design({
        projectDir: join(dir, 'proj'),
        pageId: 'home',
        action: 'explore',
        states: [
          { id: 's1', label: '初始状态', steps: [{ action: 'expect', expect: { text: { feedback_lbl: { contains: '初始' } } } }] },
          { id: 's2', label: '点击后1', steps: [{ action: 'click', target: 'single_else_btn', expect: { text: { feedback_lbl: { contains: '再练' } } } }] },
          { id: 's3', label: '点击后2', steps: [{ action: 'click', target: 'single_else_btn', expect: { text: { feedback_lbl: '再练一次' } } }] },
          { id: 's4', label: '包含别名', steps: [{ action: 'expect', expect: { text: { inner_lbl: { includes: '内部' } } } }] },
        ],
      });
      assert.equal(expStates.ok, true, JSON.stringify(expStates));
      assert.equal(expStates.candidates.length, 1);
      assert.equal(expStates.candidates[0].frames.length, 4);
      assert.equal(expStates.candidates[0].frames[0].label, '初始状态');
    }
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});
