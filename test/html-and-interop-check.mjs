import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runDoctor } from '../scripts/doctor.mjs';
import { authoringTools, verifyOfficialPreview } from '../scripts/authoring-workflow.mjs';
import { sessionTools } from '../scripts/mcp-tools.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { launchChrome, findChromeExecutable } from '../studio/cdp.mjs';
import { closeInProcessStudioServer, studioHandlers } from '../studio/mcp-adapter.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { pythonInvocation } from '../scripts/python.mjs';
import { closeAssemblyDaemons } from '../tools/native-assembly/bridge.mjs';
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

test('parallel official replays capture the initialized first frame and guard leading assertions', { skip: chromeSkipReason() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-official-first-frame-'));
  try {
    writeFileSync(join(dir, 'start.html'), `<!doctype html>
      <style>
        body { margin: 0 } #base { width: 320px; height: 240px; background: white }
        [data-label] { position: absolute; inset: 0 auto auto 0; width: 320px; height: 240px }
        #answer { background: rgb(255, 0, 0) }
      </style>
      <div id="base"><div data-label="word" id="word">abandon</div><div data-label="answer" id="answer">answer</div></div>
      <script>
        const runtime = {
          pageData: { page: { name: 'Recall' } },
          globalVariableProvider: { getDefinedVariables: () => [] },
          adaptive: { loadFinished() { document.getElementById('answer').style.display = 'none'; } },
        };
        window.$axure = { internal: cb => cb(runtime) };
        window.addEventListener('load', () => setTimeout(() => runtime.adaptive.loadFinished(), 600));
        if (location.hash) window.addEventListener('load', () => {
          runtime.adaptive.loadFinished();
          // Drift after a quiet first capture, while the leading assertion is polling.
          setTimeout(() => { document.getElementById('word').textContent = 'meticulous'; }, 750);
        });
      </script>`);
    const base = { html: dir, engine: 'official', frame: 'artboard', viewport: { width: 320, height: 240, dpr: 1 } };
    const steps = [{ action: 'expect', expect: { text: { word: 'abandon' }, visible: { answer: false } } }];
    const results = await Promise.all([1, 2].map(i => mcpToolMap.verify_prototype({
      ...base, compact: false, steps, storyboard: join(dir, `first-${i}.png`), includeStoryboard: true,
    })));
    for (const result of results) {
      assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
      assert.equal(result.initial.widgets.find(w => w.name === 'answer').visible, false, 'initial DOM and expect must agree');
      assert.equal(result.officialHtmlSource, 'provided');
      assert.equal(result.officialHtmlReady, true);
      assert.deepEqual(result.verification, {
        officialHtmlExported: false,
        browserLoaded: true, behaviorVerified: true,
      });
      assert.equal(result.storyboardImage, 'attached');
      const pixel = pythonInvocation(['-c', 'from PIL import Image; import sys; print(Image.open(sys.argv[1]).getpixel((180,100)))', result.storyboard]);
      const firstPixel = execFileSync(pixel.command, pixel.args, { encoding: 'utf8' });
      assert.equal(firstPixel.trim(), '(255, 255, 255)', 'the initial frame must exclude the red answer overlay');
    }

    const drift = await mcpToolMap.verify_prototype({
      ...base, page: 'drift', steps: [{ action: 'expect', expect: { text: { word: 'meticulous' } } }],
      storyboard: join(dir, 'drift.png'), timeoutMs: 2500,
    });
    assert.equal(drift.status, 'failed');
    assert.equal(drift.diagnostics[0].code, 'E_VERIFY_INITIAL_DRIFT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Studio and RP9 preserve plain and rich text alignment', { skip: chromeSkipReason() || nativeTemplateSkipReason() }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-text-alignment-'));
  let browser;
  try {
    const variants = [
      ['label', 'center', false], ['label', 'right', true],
      ['paragraph', 'center', false], ['paragraph', 'right', true],
      ['badge', 'right', false], ['badge', 'left', true],
    ].map(([type, textAlign, rich], index) => ({
      id: `alignment_${index}`, type, textAlign, ...(rich ? { spans: [{ text: 'Two', fontWeight: 700 }, { text: ' runs' }] } : { text: 'Plain text' }),
      x: 20 + (index % 2) * 252, y: 24 + Math.floor(index / 2) * 76, w: 220, h: 60, fontFamily: 'Arial', fontSize: 16,
    }));
    const projectDir = join(dir, 'project');
    const opened = await studioHandlers.studio_open_project({ projectDir, domain: 'web', port: 0 });
    const written = await studioHandlers.studio_command({
      projectDir, baseRevision: opened.appliedRevision, idempotencyKey: 'alignment',
      commands: [
        { type: 'renamePage', pageId: 'home', name: 'alignment' },
        { type: 'resizeArtboard', pageId: 'home', w: 544, h: 320 },
        ...variants.map(node => ({ type: 'addNode', pageId: 'home', node })),
        { type: 'addNode', pageId: 'home', node: { id: 'answer', type: 'label', text: 'hidden answer', visible: false, x: 20, y: 270, w: 220, h: 36 } },
      ],
    });
    assert.equal(written.ok, true, JSON.stringify(written.diagnostics));
    for (const type of ['label', 'paragraph', 'badge']) {
      const info = await studioHandlers.studio_describe({ topic: 'node', name: type, fields: ['textAlign'] });
      const surfaces = info.capabilities[0].surfaces;
      assert.equal(surfaces.native.status, 'implemented');
      assert.match(surfaces.native.reason, /left \/ center \/ right.*spans/);
      assert.equal(surfaces['full-rp1'].status, 'unsupported');
      assert.match(surfaces['full-rp1'].reason, /align:"left"/);
    }
    const rp = join(dir, 'alignment.rp');
    const saved = await studioHandlers.studio_export({ projectDir, format: 'rp', outRpPath: rp });
    assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
    assert.equal(saved.threeZerosPassed, true);
    const records = new Map(readRecords(readFileSync(rp)).filter(record => record.className === 'Axure:Page')
      .map(record => [record.index, parsePayload(record)]));
    const nativeNames = {};
    for (const node of variants) {
      const symbol = saved.buildResult.sourceMap.find(s => s.id === `home/${node.id}`);
      const [{ record, id }] = symbol.native;
      nativeNames[node.id] = symbol.display;
      const graph = records.get(record);
      const widget = graph.objects.get(id);
      const style = graph.objects.get(field(widget.body, 'MyStyle').value);
      const props = field(style.body, 'PropList').items;
      const prop = key => field(props.find(p => (field(p, 'DOAName').value & 0x0fffffff) === key), 'Value').value;
      assert.equal(prop(9), { left: 0, center: 1, right: 2 }[node.textAlign], `${node.id} horizontal`);
      assert.equal(prop(10), node.type === 'paragraph' ? 0 : 1, `${node.id} vertical`);
    }

    const offline = join(dir, 'offline');
    const code = await studioHandlers.studio_export({ projectDir, format: 'code', outDir: offline });
    assert.equal(code.ok, true);
    browser = await launchChrome({ headless: true, width: 1140, height: 800 });
    const studio = await browser.openPage(opened.url);
    await studio.waitForFunction('!!document.querySelector(\'[data-node-id="alignment_5"]\')');
    const standalone = await browser.openPage(pathToFileURL(join(offline, 'index.html')).href);
    await standalone.waitForFunction('!!document.querySelector(\'[data-node-id="alignment_5"]\')');
    const checkBrowserAlignment = async (page, nodes, attribute) => {
      const actual = await page.evaluate(`(${function measureAlignment(ids, key) {
        return ids.map(id => {
          const el = document.querySelector(`[${key}="${CSS.escape(id)}"]`);
          const range = document.createRange();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const rects = [];
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (!text.data.trim()) continue;
            range.selectNodeContents(text);
            rects.push(...[...range.getClientRects()].filter(rect => rect.width && rect.height));
          }
          const ink = {
            left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)),
            top: Math.min(...rects.map(rect => rect.top)), bottom: Math.max(...rects.map(rect => rect.bottom)),
          };
          const box = el.getBoundingClientRect();
          return [ink.left - box.left, box.right - ink.right, ink.top - box.top, box.bottom - ink.bottom];
        });
      }.toString()})(${JSON.stringify(nodes)}, ${JSON.stringify(attribute)})`);
      for (const [i, node] of variants.entries()) {
        const [left, right, top, bottom] = actual[i];
        if (node.textAlign === 'center') assert.ok(Math.abs(left - right) < 5, `${attribute} ${node.id}: ${actual[i]}`);
        else assert.ok((node.textAlign === 'right' ? left - right : right - left) > 70, `${attribute} ${node.id}: ${actual[i]}`);
        if (node.type === 'paragraph') assert.ok(bottom - top > 18, `${attribute} ${node.id}: ${actual[i]}`);
        else assert.ok(Math.abs(top - bottom) < 9, `${attribute} ${node.id}: ${actual[i]}`);
      }
    };
    await checkBrowserAlignment(studio, variants.map(node => node.id), 'data-node-id');
    await checkBrowserAlignment(standalone, variants.map(node => node.id), 'data-node-id');

    const info = await authoringToolMap.runtime_info({ projectDir });
    if (!info.host?.axureInstalled || !info.host?.officialHtml.platformSupported) {
      await t.test('official RP9 browser replay', { skip: '需要可用的 macOS Axure RP9 官方导出宿主' }, () => {});
      return;
    }
    const exported = await authoringToolMap.export_prototype({ rp, output: join(dir, 'official') });
    assert.equal(exported.status, 'completed', JSON.stringify(exported.diagnostics));
    assert.equal(exported.officialHtmlSource, 'exported');
    assert.equal(exported.officialHtmlReady, true);
    const official = await browser.openPage(pathToFileURL(join(exported.output, 'alignment.html')).href);
    await official.waitForFunction(`!!document.querySelector('[data-label="${nativeNames.alignment_5}"]')`);
    await checkBrowserAlignment(official, variants.map(node => nativeNames[node.id]), 'data-label');
    const sharedSteps = [{ action: 'expect', expect: { visible: { answer: false }, text: { alignment_0: 'Plain text', alignment_1: 'Two runs' } } }];
    const [provided, generated] = await Promise.all([
      mcpToolMap.verify_prototype({ rp, html: exported.output, engine: 'official', frame: 'artboard', compact: false, steps: sharedSteps, includeStoryboard: true }),
      mcpToolMap.verify_prototype({ rp, cwd: dir, engine: 'official', frame: 'artboard', compact: false, steps: sharedSteps, includeStoryboard: true }),
    ]);
    for (const [result, source] of [[provided, 'provided'], [generated, 'exported']]) {
      assert.equal(result.status, 'completed', JSON.stringify(result.diagnostics));
      assert.equal(result.officialHtmlSource, source);
      assert.equal(result.officialHtmlReady, true);
      assert.equal(result.verification.officialHtmlExported, source === 'exported');
      const answer = saved.buildResult.sourceMap.find(s => s.id === 'home/answer');
      assert.equal(result.initial.widgets.find(widget => widget.name === answer.display).visible, false);
      assert.equal(result.storyboardImage, 'attached');
    }
  } finally {
    await browser?.close();
    await closeAssemblyDaemons();
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('L1 review flags exactly its blocking checks and explains the visual hierarchy weights', { skip: chromeSkipReason() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-l1-attribution-'));
  try {
    const opened = await studioHandlers.studio_open_project({ projectDir: dir, domain: 'web', port: 0 });
    const tx = await studioHandlers.studio_command({
      projectDir: dir, baseRevision: opened.appliedRevision, idempotencyKey: 'hierarchy-blocking',
      commands: [
        ...[0, 1, 2].map(i => ({ type: 'addNode', pageId: 'home', node: {
          type: 'label', id: `text_${i}`, text: 'Equal emphasis', fontSize: 20, x: 40 + i * 184, y: 48,
          w: 160, h: i === 0 ? 112 : 32, color: '#152839',
        } })),
        ...Array.from({ length: 26 }, (_, i) => ({ type: 'addNode', pageId: 'home', node: {
          type: 'box', id: `outside_${i}`, x: 2000 + i * 8, y: 48, w: 4, h: 4, fill: '#000000',
        } })),
      ],
    });
    assert.equal(tx.ok, true, JSON.stringify(tx.diagnostics));
    const review = await studioHandlers.studio_design({ action: 'review', projectDir: dir, pageId: 'home', baseRevision: tx.appliedRevision, verbose: true });
    assert.equal(review.ok, true, JSON.stringify(review.diagnostics));
    assert.deepEqual([...new Set(review.findings.filter(f => f.blocksL1).map(f => f.check))].sort(),
      [...review.assessment.l1BlockingKeys].sort());
    const finding = review.findings.find(f => f.check === 'visual-hierarchy');
    assert.equal(finding.blocksL1, true);
    assert.match(finding.detail, /有效面积.*字号.*框高异常/);
    const hierarchy = review.designMetrics.metrics.visualHierarchy;
    assert.deepEqual(finding.attribution, hierarchy);
    const stretched = hierarchy.topThree.find(item => item.id === 'text_0').factors;
    assert.equal(stretched.stretchedText, true);
    assert.equal(stretched.heightCapped, true);
    assert.equal(stretched.fontSize, 20);
    assert.equal(stretched.area, 160 * stretched.effectiveH);
    assert(stretched.effectiveH < stretched.boxH);
    assert(hierarchy.reasons.some(reason => reason.code === 'stretched-text' && reason.fix.includes('父容器间距')));
    assert(hierarchy.reasons.some(reason => reason.code === 'low-dominance' && reason.nodeIds.length === 2));
    const summary = await studioHandlers.studio_design({ action: 'review', projectDir: dir, pageId: 'home', baseRevision: tx.appliedRevision });
    assert(summary.detail.findingCount > summary.detail.returnedFindings);
    assert.equal(summary.findings.length, 24);
    assert.deepEqual([...new Set(summary.findings.filter(f => f.blocksL1).map(f => f.check))].sort(),
      [...review.assessment.l1BlockingKeys].sort());
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

test('Wave 2 blind-test friction closure: column h:fill flex, overflow/lineHeight diags, review l1BlockingCount, rp1 no-fake-next, scenario missing hints, native hug width buffer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-blind-w2-'));
  try {
    const projectDir = join(dir, 'proj');
    const opened = await studioHandlers.studio_open_project({ projectDir, domain: 'mobile', port: 0 });
    assert.equal(opened.ok, true, JSON.stringify(opened));

    // 1. column h:"fill" takes remaining height (not full innerH), W_LINE_HEIGHT_FLOOR fires on tight explicit lineHeight, W_BOARD_OVERFLOW fires on flow overflow
    const tx1 = await studioHandlers.studio_command({
      projectDir,
      pageId: 'home',
      baseRevision: 1,
      idempotencyKey: 'w2-layout-1',
      commands: [
        {
          type: 'addNode',
          parentId: 'home_screen',
          node: {
            id: 'col_wrap',
            type: 'column',
            w: 'fill',
            h: 300,
            gap: 10,
            padding: 10,
            children: [
              { id: 'top_hdr', type: 'box', w: 'fill', h: 40, fill: '#F1F5F9' },
              { id: 'mid_fill', type: 'box', w: 'fill', h: 'fill', fill: '#E2E8F0', children: [{ id: 'phonetic_hug', type: 'label', w: 'hug', h: 'hug', text: '/ˌkaʊntərˌrevəˈluːʃəneri/', fontSize: 16, lineHeight: 14, color: '#0F172A' }] },
              { id: 'bot_ftr', type: 'box', w: 'fill', h: 50, fill: '#CBD5E1' },
            ],
          },
        },
        {
          type: 'addNode',
          parentId: 'home_screen',
          node: { id: 'tall_push', type: 'box', w: 200, h: 900, fill: '#DBEAFE' },
        },
      ],
    });
    assert.equal(tx1.ok, true, JSON.stringify(tx1));
    const insp1 = await studioHandlers.studio_inspect({
      projectDir,
      pageId: 'home',
      view: 'nodes',
      nodeIds: ['mid_fill', 'phonetic_hug'],
      fields: ['id', 'bounds'],
    });
    assert.equal(insp1.ok, true, JSON.stringify(insp1));
    const midFill = insp1.nodes.find(n => n.id === 'mid_fill');
    assert.equal(midFill.bounds.h, 170, `column h:fill must take remaining height 300 - 20(pad) - 40 - 50 - 20(gaps) = 170, got ${midFill.bounds.h}`);
    assert(tx1.diagnostics.some(d => d.code === 'W_LINE_HEIGHT_FLOOR' && d.nodeId === 'phonetic_hug'), 'tight explicit lineHeight must emit W_LINE_HEIGHT_FLOOR');
    assert(tx1.diagnostics.some(d => d.code === 'W_BOARD_OVERFLOW' && d.nodeId === 'tall_push'), 'visible flow overflow must emit W_BOARD_OVERFLOW');
    assert.match(tx1.humanReadableSummary?.diagnosticsSummary || '', /W_BOARD_OVERFLOW/);

    // Shrink tall_push back inside board so review can run cleanly
    const tx2 = await studioHandlers.studio_command({
      projectDir,
      pageId: 'home',
      baseRevision: tx1.appliedRevision,
      idempotencyKey: 'w2-shrink-tall',
      commands: [{ type: 'setProperties', nodeId: 'tall_push', properties: { h: 40 } }],
    });
    assert.equal(tx2.ok, true, JSON.stringify(tx2));

    // 2. E_RP1_EXPLICIT_ID multi-root failure does NOT tell AI to studio_inspect nonexistent synthetic root
    const rp1ErrRes = await studioHandlers.studio_command({
      projectDir,
      pageId: 'home',
      baseRevision: tx2.appliedRevision,
      idempotencyKey: 'w2-rp1-multiroot',
      sourceMode: 'insert',
      rp1: 'label #orphan_a "A"\nlabel #orphan_b "B"',
    }).catch(err => err.diagnostic || err);
    assert.equal(rp1ErrRes.code, 'E_RP1_EXPLICIT_ID', JSON.stringify(rp1ErrRes));
    assert.equal(rp1ErrRes.next, undefined, `must not emit fake studio_inspect next: ${JSON.stringify(rp1ErrRes)}`);

    // 3. Scenario missing target ID gives similarity hint on fail and W_ASSERT_UNKNOWN_TARGET on false-visible pass
    const scMissFail = await studioHandlers.studio_scenario({
      projectDir,
      startPageId: 'home',
      steps: [{ action: 'expect', expect: { text: { phonetic_hug_typo: 'nope' } } }],
    });
    assert.equal(scMissFail.ok, false);
    assert.match(scMissFail.stepResults[0].assertions[0].hint || '', /不存在节点.*phonetic_hug/);

    const scMissVis = await studioHandlers.studio_scenario({
      projectDir,
      startPageId: 'home',
      steps: [{ action: 'expect', expect: { visible: { ghost_typo: false } } }],
    });
    assert.equal(scMissVis.ok, true);
    assert((scMissVis.warnings || []).some(w => w.code === 'W_ASSERT_UNKNOWN_TARGET' && w.targetNodeId === 'ghost_typo'));

    // 4. review exposes l1BlockingCount & totalBlockingCount alongside visual blockingCount
    if (!chromeSkipReason()) {
      const rev = await studioHandlers.studio_design({ projectDir, pageId: 'home', action: 'review' });
      assert.equal(rev.ok, true, JSON.stringify(rev));
      assert.equal(typeof rev.assessment.l1BlockingCount, 'number');
      assert.equal(typeof rev.assessment.totalBlockingCount, 'number');
      assert(Array.isArray(rev.assessment.l1BlockingKeys));
      assert(rev.assessment.totalBlockingCount >= rev.assessment.blockingCount);
    }

    // 5. Native RP1 export adds safety width buffer (>=4px) to single-line hug label
    const rp1Exp = await studioHandlers.studio_export({ projectDir, format: 'rp1' });
    assert.equal(rp1Exp.ok, true, JSON.stringify(rp1Exp));
    const hugInScene = insp1.nodes.find(n => n.id === 'phonetic_hug');
    const rp1Match = (rp1Exp.rp1Text || '').match(/label #phonetic_hug[^\n]*\[(\d+)x\d+\]/);
    assert(rp1Match, `phonetic_hug should exist in exported rp1: ${rp1Exp.rp1Text}`);
    assert(Number(rp1Match[1]) >= hugInScene.bounds.w + 4, `exported hug label w=${rp1Match[1]} should include >=4px buffer over scene w=${hugInScene.bounds.w}`);
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GPT-6 retest polish: verify_prototype limits 120000ms/120steps documented, removePage alias, and browser whitespace collapse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-retest-w3-'));
  try {
    // 1. verify_prototype schema limits & descriptions
    const verifyTool = authoringTools({ generate: () => {}, sync: () => {}, listTools: () => [] }).find(t => t.name === 'verify_prototype');
    assert.equal(verifyTool.inputSchema.properties.timeoutMs.maximum, 120000);
    assert.match(verifyTool.inputSchema.properties.timeoutMs.description || '', /120000/);
    assert.equal(verifyTool.inputSchema.properties.steps.maxItems, 120);
    assert.match(verifyTool.inputSchema.properties.steps.description || '', /120/);

    // 2. studio_describe(topic:"command", names:[..., "removePage"]) resolves alias cleanly
    const projectDir = join(dir, 'proj');
    const opened = await studioHandlers.studio_open_project({ projectDir, domain: 'mobile', port: 0 });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const desc = await studioHandlers.studio_describe({ projectDir, topic: 'command', names: ['setText', 'removePage', 'set-variable'] });
    assert.equal(desc.ok, true, JSON.stringify(desc));
    assert.equal(desc.contracts[1].name, 'deletePage');
    assert.equal(desc.contracts[1].requestedName, 'removePage');
    assert.equal(desc.contracts[1].aliasOf, 'deletePage');

    // 3. hitTest:true normalizes DOM consecutive ASCII whitespace
    if (!chromeSkipReason()) {
      const tx = await studioHandlers.studio_command({
        projectDir,
        pageId: 'home',
        baseRevision: 1,
        idempotencyKey: 'w3-ws',
        commands: [{
          type: 'addNode',
          parentId: 'home_screen',
          node: { id: 'ws_lbl', type: 'label', x: 24, y: 100, w: 300, h: 32, fontSize: 16, text: '已完成 3 词  ·  再练 0 次', color: '#0F172A' },
        }],
      });
      assert.equal(tx.ok, true, JSON.stringify(tx));
      const scen = await studioHandlers.studio_scenario({
        projectDir,
        startPageId: 'home',
        hitTest: true,
        steps: [{ action: 'expect', expect: { text: { ws_lbl: '已完成 3 词  ·  再练 0 次' } } }],
      });
      assert.equal(scen.ok, true, JSON.stringify(scen));
    }
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v10 parity upgrades: runtime DOM text clip audit, shared Studio scenario steps in verify_prototype + artboard frame, and partial command help', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-v10-upgrades-'));
  try {
    const projectDir = join(dir, 'proj');
    const opened = await studioHandlers.studio_open_project({ projectDir, domain: 'mobile', port: 0 });
    assert.equal(opened.ok, true, JSON.stringify(opened));

    // 1. Partial command help + targeted suggestions (default strict preserved, partial:true returns ok:true)
    const strictHelp = await studioHandlers.studio_describe({ topic: 'command', names: ['setText', 'updatePage'] });
    assert.equal(strictHelp.ok, false);
    assert.equal(strictHelp.code, 'E_COMMAND_HELP');
    assert.equal(strictHelp.partialSuccess, true);
    assert.equal(strictHelp.contracts.length, 1);
    assert(strictHelp.missing?.[0]?.suggestions?.includes('renamePage'), `missing suggestions should include renamePage: ${JSON.stringify(strictHelp.missing)}`);

    const partialHelp = await studioHandlers.studio_describe({ topic: 'command', names: ['setText', 'updatePage'], partial: true });
    assert.equal(partialHelp.ok, true, JSON.stringify(partialHelp));
    assert.equal(partialHelp.partial, true);
    assert.equal(partialHelp.contracts.length, 1);
    assert.equal(partialHelp.missing[0].requested, 'updatePage');
    const mixed = await studioHandlers.studio_describe({
      topic: 'command', names: ['interaction.set', 'variable.add', 'addNode'], partial: true,
    });
    assert.equal(mixed.ok, true);
    assert.deepEqual(mixed.contracts.map(c => c.name), ['addNode']);
    assert.deepEqual(mixed.missing.map(m => [m.requested, m.suggestions[0]]), [
      ['interaction.set', 'setInteraction'], ['variable.add', 'setVariable'],
    ]);
    const aliases = await studioHandlers.studio_describe({
      topic: 'command', names: ['token.set', 'page.add', 'node/add', 'interaction/set'], partial: true,
    });
    assert.deepEqual(aliases.missing.map(m => m.suggestions[0]), ['setTokens', 'addPage', 'addNode', 'setInteraction']);

    // 2. Runtime DOM text clipping audit catches multi-state text clip on narrow label and passes after widening
    const tx1 = await studioHandlers.studio_command({
      projectDir,
      pageId: 'home',
      baseRevision: opened.appliedRevision,
      idempotencyKey: 'v10-clip-1',
      commands: [
        {
          type: 'addNode',
          parentId: 'home_screen',
          node: { id: 'word', type: 'label', x: 24, y: 120, w: 180, h: 48, fontSize: 32, text: 'abandon', color: '#0F172A' },
        },
        {
          type: 'addNode',
          parentId: 'home_screen',
          node: { id: 'example', type: 'paragraph', x: 24, y: 284, w: 300, h: 32, fontSize: 16, lineHeight: 24, visible: false,
            spans: [{ text: 'First row fits\n' }, { text: 'The second row exceeds the box.', fontWeight: 700 }] },
        },
        {
          type: 'addNode',
          parentId: 'home_screen',
          node: {
            id: 'next_btn',
            type: 'button',
            x: 24,
            y: 220,
            w: 160,
            h: 48,
            text: '下一词',
            on: { click: [{ type: 'set-text', target: 'word', text: 'counterrevolutionary' }, { type: 'show', target: 'example' }] },
          },
        },
      ],
    });
    assert.equal(tx1.ok, true, JSON.stringify(tx1));

    const sharedSteps = [
      { action: 'expect', expect: { text: { word: 'abandon' }, visible: { word: true } } },
      { action: 'click', target: 'next_btn', expect: { text: { word: { includes: 'counter' } }, visible: { next_btn: true } } },
    ];

    if (!chromeSkipReason()) {
      const scenWarn = await studioHandlers.studio_scenario({
        projectDir,
        startPageId: 'home',
        hitTest: true,
        steps: sharedSteps,
      });
      assert.equal(scenWarn.ok, true, JSON.stringify(scenWarn));
      assert((scenWarn.runtimeLayoutAudit?.issueCount ?? 0) > 0, 'narrow word box must trigger runtimeLayoutAudit warning');
      const wordClip = scenWarn.runtimeLayoutAudit.issues.find(i => i.code === 'W_RUNTIME_TEXT_CLIP' && i.nodeId === 'word');
      assert.equal(wordClip.direction, 'horizontal');
      assert.equal(wordClip.overflowLines[0].line, 1);
      assert.equal(wordClip.overflowLines[0].text, 'counterrevolutionary');
      assert(wordClip.textBox.right > wordClip.contentBox.right);
      const exampleClip = scenWarn.runtimeLayoutAudit.issues.find(i => i.code === 'W_RUNTIME_TEXT_CLIP' && i.nodeId === 'example');
      assert.equal(exampleClip.direction, 'vertical');
      assert.deepEqual(exampleClip.overflowLines.map(({ line, text }) => [line, text]), [[2, 'The second row exceeds the box.']]);
      assert(exampleClip.overflowLines[0].bounds.bottom > exampleClip.contentBox.bottom);

      const scenBlocked = await studioHandlers.studio_scenario({
        projectDir,
        startPageId: 'home',
        hitTest: true,
        failOnLayoutIssue: true,
        steps: sharedSteps,
      });
      assert.equal(scenBlocked.ok, false);
      assert.equal(scenBlocked.code, 'E_SCENARIO_LAYOUT_CLIP');

      // Widen #word so counterrevolutionary renders cleanly without clipping
      const tx2 = await studioHandlers.studio_command({
        projectDir,
        pageId: 'home',
        baseRevision: tx1.appliedRevision,
        idempotencyKey: 'v10-widen-word',
        commands: [
          { type: 'setProperties', nodeId: 'word', properties: { w: 354, fontSize: 28 } },
          { type: 'setProperties', nodeId: 'example', properties: { h: 72 } },
        ],
      });
      assert.equal(tx2.ok, true, JSON.stringify(tx2));

      const scenClean = await studioHandlers.studio_scenario({
        projectDir,
        startPageId: 'home',
        hitTest: true,
        failOnLayoutIssue: true,
        steps: sharedSteps,
      });
      assert.equal(scenClean.ok, true, JSON.stringify(scenClean));
      assert.equal(scenClean.runtimeLayoutAudit.issueCount, 0);

      // 3. Shared Studio steps + frame:"artboard" work directly in verify_prototype(engine:"studio-html")
      if (!nativeTemplateSkipReason()) {
        const rpPath = join(dir, 'shared.rp');
        const expRp = await studioHandlers.studio_export({ projectDir, format: 'rp', outRpPath: rpPath });
        assert.equal(expRp.ok, true, JSON.stringify(expRp));

        const shotPath = join(dir, 'artboard-verify.png');
        const verified = await mcpToolMap.verify_prototype({
          rp: rpPath,
          engine: 'studio-html',
          frame: 'artboard',
          screenshot: shotPath,
          steps: sharedSteps,
        });
        assert.equal(verified.status, 'completed', JSON.stringify(verified));
        assert.equal(verified.frame, 'artboard');
        assert.equal(verified.verification.behaviorVerified, true);
        assert.ok(existsSync(shotPath));
      }
    }
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});
