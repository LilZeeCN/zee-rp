import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { duplicatePage } from '../scripts/duplicate-page.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.AXURE_MCP_VERIFY_OUTPUT;
const verifyHost = process.env.AXURE_MCP_EXPORT_HOST === '1';

async function session(run, env = {}, args = []) {
  const dir = evidence ? resolve(evidence) : mkdtempSync(join(tmpdir(), 'zee-rp-verify-'));
  if (evidence) mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(dir, 'stdio-'));
  const client = new Client({ name: 'zee-rp-verify-check', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'bin/mcp.mjs'), ...args],
    cwd: work,
    stderr: 'pipe',
    env: { ...process.env, AXURE_WRITE_ROOT: work, AXURE_PROTECTED_PATHS: join(work, 'protected.rp'), ...env },
  });
  try {
    await client.connect(transport);
    const callRaw = async (name, args = {}, isError = false) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
      assert.equal(Boolean(result.isError), isError, result.content[0].text);
      return result;
    };
    const call = async (name, args = {}, isError = false) => {
      const result = await callRaw(name, args, isError);
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    return await run({ client, call, callRaw, work: realpathSync(work) });
  } finally {
    await client.close();
    if (!evidence) rmSync(dir, { recursive: true, force: true });
  }
}

test('verify_prototype tool discovery and input safety guards work offline', async () => {
  await session(async ({ client, call, work }) => {
    assert.match(client.getInstructions(), /generate_prototype.*export_prototype.*verify_prototype.*gui_roundtrip/);
    const { tools } = await client.listTools();
    const verifyTool = tools.find(t => t.name === 'verify_prototype');
    assert.ok(verifyTool, 'verify_prototype must be exposed');
    assert.equal(verifyTool.inputSchema.additionalProperties, false);
    assert.equal(verifyTool.annotations.readOnlyHint, false);

    const runtime = await call('runtime_info');
    assert.equal(runtime.host.officialHtml.verifyTool, 'verify_prototype');
    assert.equal(typeof runtime.host.officialHtml.chromeAvailable, 'boolean');

    const missingInput = await call('verify_prototype', {}, true);
    assert.equal(missingInput.diagnostics[0].code, 'E_VERIFY_INPUT');

    const invalidHtml = await call('verify_prototype', { html: join(work, 'empty-html') }, true);
    assert.equal(invalidHtml.diagnostics[0].code, 'E_VERIFY_HTML');

    const protectedErr = await call('verify_prototype', { rp: join(work, 'protected.rp') }, true);
    assert.match(protectedErr.diagnostics[0].message, /受保护/);

    const existingPng = join(work, 'keep.png');
    writeFileSync(existingPng, 'keep');
    mkdirSync(join(work, 'mock-html'));
    writeFileSync(join(work, 'mock-html', 'start.html'), '<html></html>');
    const overwriteErr = await call('verify_prototype', { html: join(work, 'mock-html'), screenshot: existingPng }, true);
    assert.equal(overwriteErr.diagnostics[0].code, 'E_VERIFY_SCREENSHOT_EXISTS');
    assert.equal(readFileSync(existingPng, 'utf8'), 'keep');
  });
});

test('the official player opens a non-default Unicode page from its sitemap in RP9 and RP11', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call, work }) => {
    for (const version of [11, 9]) {
      const page = '02 引导页';
      const input = join(work, `unicode-rp${version}.rp`);
      const { file } = duplicatePage(synthesizeBlankProject({ version }), 'Page 1', page);
      writeFileSync(input, file, { flag: 'wx' });
      const exported = await call('export_prototype', { rp: input });
      const result = await call('verify_prototype', {
        html: exported.output, engine: 'official', page,
        steps: [
          { action: 'navigate', page: 'Page 1', expect: { page: 'Page 1' } },
          { action: 'navigate', page, expect: { page } },
        ],
      });
      assert.equal(result.verification.browserLoaded, true);
      assert.equal(result.initial.page, page);
      assert.equal(result.passed, 2);
    }
  });
});

test('carousel-slider-captcha → RP9 → export_prototype → verify_prototype in real headless Chrome', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call, callRaw, work }) => {
    const gen = await call('generate_prototype', { recipe: 'carousel-slider-captcha', output: 'captcha.rp' });
    assert.equal(gen.status, 'completed');
    const exp = await call('export_prototype', { rp: gen.output });
    assert.equal(exp.status, 'completed');
    assert.match(exp.nextAction, /verify_prototype/);

    const raw = await callRaw('verify_prototype', {
      html: exp.output,
      rp: gen.output,
      viewport: { width: 440, height: 700, dpr: 1 },
      includeImage: true,
      screenshot: join(work, 'verified.png'),
      steps: [
        { action: 'expect', target: 'banner', expect: { panelState: 's1' } },
        { action: 'expect', target: 'indicator', expect: { panelState: 's1' } },
        { action: 'swipe', target: 'banner', direction: 'left', distance: 160, expect: { panelState: 's2' } },
        { action: 'expect', target: 'indicator', expect: { panelState: 's2' } },
        { action: 'expect', target: 'banner_state', expect: { text: '当前幻灯片：s2' } },
        // Auto-rotation resumes after 3000ms on swipe
        { action: 'wait', ms: 3300 },
        { action: 'expect', target: 'banner', expect: { panelState: 's3' } },
        { action: 'expect', target: 'indicator', expect: { panelState: 's3' } },
        // Bounded drag: dragging 500px right must clamp thumb inside track (right == 400, x == 340)
        // Here we verify failure reset back to x == 40
        { action: 'drag', target: 'thumb', dx: 500, dy: 60 },
        { action: 'expect', target: 'captcha_status', expect: { text: '验证失败' } },
        { action: 'expect', target: 'thumb', expect: { x: 40, tolerance: 2 } },
        { action: 'expect', target: 'piece', expect: { x: 40, tolerance: 2 } },
        { action: 'click', target: 'check_overlap' },
        { action: 'expect', target: 'overlap_status', expect: { text: '未重叠' } },
        // Drag within ±2px of target.x (target=220, start=40 => dx=179 => piece.x=219 -> snaps to 220)
        { action: 'drag', target: 'thumb', dx: 179, dy: 0 },
        { action: 'expect', target: 'captcha_status', expect: { text: '验证成功' } },
        { action: 'expect', target: 'piece', expect: { x: 220, tolerance: 2 } },
        { action: 'click', target: 'check_overlap' },
        { action: 'expect', target: 'overlap_status', expect: { text: '已重叠' } },
      ],
    });
    const verified = raw.structuredContent ?? JSON.parse(raw.content[0].text);
    assert.equal(verified.status, 'completed');
    assert.deepEqual(verified.verification, {
      officialHtmlExported: false,
      browserLoaded: true,
      behaviorVerified: true,
    });
    assert.equal(verified.passed, verified.total);
    assert.deepEqual(verified.errors, []);
    assert(existsSync(join(work, 'verified.png')));
    assert.equal(verified.previewImage, 'attached');
    const img = raw.content.find(p => p.type === 'image');
    assert(img && img.mimeType === 'image/png' && img.data.length > 100);
  });
});

test('verify_prototype auto-exports from rp only and proves real Chrome BoundaryCondition clamping', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call, work }) => {
    const specPath = join(work, 'bounds-clamp.rp1');
    writeFileSync(specPath, [
      'rp/1 target=9 name="有界拖动钳位验证" domain=web theme=enterprise-light',
      'page #demo name="有界拖动" canvas=[440,320]',
      '  box #root [440x320] layout=stack fill=#F8FAFC',
      '    box #track [360x44] x=40 y=120 layout=stack fill=#CBD5E1 radius=22',
      '    dynamic-panel #knob [60x44] x=40 y=120',
      '      +onDrag [{"type":"move","target":"knob","mode":"drag-x","bounds":{"within":"track"}}]',
      '      :state s1',
      '        box #knob_box [60x44] fill=#4F46E5 radius=22',
    ].join('\n'));
    const gen = await call('generate_prototype', { source: specPath, output: 'bounds-clamp.rp' });
    assert.equal(gen.status, 'completed');

    const clamped = await call('verify_prototype', {
      rp: gen.output,
      viewport: { width: 440, height: 360, dpr: 1 },
      steps: [
        { action: 'expect', target: 'knob', expect: { x: 40, y: 120, right: 100, tolerance: 2 } },
        { action: 'drag', target: 'knob', dx: 500, dy: 50 },
        { action: 'expect', target: 'knob', expect: { x: 340, y: 120, right: 400, tolerance: 2 } },
        { action: 'drag', target: 'knob', dx: -600, dy: -40 },
        { action: 'expect', target: 'knob', expect: { x: 40, y: 120, left: 40, tolerance: 2 } },
      ],
    });
    assert.equal(clamped.status, 'completed');
    assert.deepEqual(clamped.verification, {
      officialHtmlExported: true,
      browserLoaded: true,
      behaviorVerified: true,
    });
    assert.equal(clamped.passed, clamped.total);
    assert.deepEqual(clamped.errors, []);
    assert.deepEqual(readdirSync(work).filter(n => n.startsWith('.zee-verify-')), []);
  });
});

test('MCP profiles, axure_save cleanup, and batch add-interaction via rp_command with baseline work offline', async () => {
  await session(async ({ client, call }) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 16);
    const rt = await call('runtime_info');
    assert.equal(rt.mcpProfile, 'core');
    assert.equal(rt.toolCount, 16);
    assert.ok(rt.schemaChars < 45000);
  }, {}, ['--profile=core']);

  await session(async ({ client }) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 26);
  }, {}, ['--profile=author']);

  await session(async ({ client }) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 17);
  }, {}, ['--profile=studio']);

  await session(async ({ call, work }) => {
    const batchSpec = join(work, 'batch.rp1');
    writeFileSync(batchSpec, [
      'rp/1 target=9 name="批交互测试" domain=web theme=enterprise-light',
      'page #home name="首页" canvas=[420,300]',
      '  box #root [420x300] layout=stack fill=#FFFFFF',
      '    button #btn_batch x=20 y=20 w=120 h=40 text="点我"',
      '    label #lbl_out x=20 y=80 w=200 h=24 text="初始"',
    ].join('\n'));
    const gen = await call('generate_prototype', {
      source: batchSpec,
      output: join(work, 'batch.rp'),
    });
    assert.equal(gen.status, 'completed');
    const opened = await call('axure_open', { path: gen.output });
    assert.equal(opened.opened, gen.output);
    const batchRes = await call('rp_command', {
      action: 'run',
      command: 'add-interaction',
      params: {
        items: [
          { target: 'btn_batch', event: 'OnClick', actions: [{ type: 'set-text', target: 'lbl_out', text: '已触发' }] },
          { target: 'btn_batch', event: 'OnMouseOver', actions: [{ type: 'disable', target: 'btn_batch' }] },
        ],
      },
    });
    assert.equal(batchRes.status, 'completed');
    const saved = await call('axure_save', { as: join(work, 'batch-final.rp'), cleanup: true });
    assert.equal(saved.physicalPath, join(work, 'batch-final.rp'));
    assert.ok(Array.isArray(saved.cleanedWorkFiles) && saved.cleanedWorkFiles.length >= 1);
    assert.ok(existsSync(join(work, 'batch-final.rp')));
    const leftoverWork = readdirSync(work).filter(n => /\.work-\d+\.rp/.test(n));
    assert.deepEqual(leftoverWork, []);
  });
});

test('one-shot generate_prototype verify+virtualClock+storyboard and daemon cache speedup in real Chrome', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ call, callRaw, work }) => {
    const raw = await callRaw('generate_prototype', {
      recipe: 'carousel-slider-captcha',
      output: join(work, 'oneshot.rp'),
      verify: true,
      virtualClock: true,
      includeStoryboard: true,
    });
    const res = raw.structuredContent ?? JSON.parse(raw.content[0].text);
    assert.equal(res.status, 'completed');
    assert.equal(res.behaviorVerification.passed, 19);
    assert.equal(res.behaviorVerification.total, 19);
    assert.equal(res.behaviorVerification.storyboardImage, 'attached');
    assert.ok(raw.content.some(p => p.type === 'image' && p.mimeType === 'image/png' && p.data.length > 200));

    // Daemon speedup check on consecutive export_prototype calls
    const exp1 = await call('export_prototype', { rp: res.output, output: join(work, 'html-1') });
    const t2Start = Date.now();
    const exp2 = await call('export_prototype', { rp: res.output, output: join(work, 'html-2') });
    const exp2Ms = Date.now() - t2Start;
    assert.equal(exp1.status, 'completed');
    assert.equal(exp2.status, 'completed');
    assert.ok(exp2Ms <= 2500, `Expected warm daemon export <=2500ms, got ${exp2Ms}ms`);

    // Carousel + slider-captcha macro generated and verified directly in Chrome
    const macroSpec = join(work, 'macro-chrome.rp1');
    writeFileSync(macroSpec, [
      'rp/1 target=9 name="宏全链路验证" domain=web theme=enterprise-light',
      'page #home name="首页" canvas=[440,560]',
      '  box #root [440x560] layout=stack fill=#FFFFFF',
      '    carousel #auto_ban [400x150] x=20 y=20 slides=["s1","s2","s3"] interval=3000',
      '    slider-captcha #cap [360x240] x=20 y=220 targetX=200 tolerance=2',
      'verify:',
      '  expect #auto_ban_panel panelState=s1',
      '  wait 3100',
      '  expect #auto_ban_panel panelState=s2',
      '  drag #cap_thumb dx=500 dy=0',
      '  expect #cap_status text="验证失败"',
      '  drag #cap_thumb dx=199 dy=0',
      '  expect #cap_status text="验证成功"',
    ].join('\n'));
    const macroRun = await call('generate_prototype', {
      source: macroSpec,
      output: join(work, 'macro-chrome.rp'),
      verify: true,
      virtualClock: true,
    });
    assert.equal(macroRun.status, 'completed');
    assert.equal(macroRun.behaviorVerification.passed, macroRun.behaviorVerification.total);
    assert.equal(macroRun.behaviorVerification.passed, 7);

    // Zero-JSON inline rp1 directly passed to generate_prototype with verify + includeImage + includeStoryboard (no prior write_file)
    const inlineRaw = await callRaw('generate_prototype', {
      rp1: [
        'rp/1 target=9 name="内联一步验证" domain=web theme=enterprise-light',
        'page #home name="首页" canvas=[440,360]',
        '  box #root [440x360] layout=stack fill=#FFFFFF',
        '    label #msg [360x28] x=24 y=24 "待触发" fontSize=16 color=#0F172A',
        '    button #trigger_btn [160x40] x=24 y=72 "一步验证"',
        '      +onClick:',
        '        set msg = "内联直传验证通过"',
        'verify:',
        '  expect msg text="待触发"',
        '  click trigger_btn',
        '  expect msg text="内联直传验证通过"',
      ].join('\n'),
      output: 'inline-oneshot.rp',
      verify: true,
      includeImage: true,
      includeStoryboard: true,
    });
    const inlineOneShot = inlineRaw.structuredContent ?? JSON.parse(inlineRaw.content[0].text);
    assert.equal(inlineOneShot.status, 'completed');
    assert.equal(existsSync(join(work, 'inline-oneshot.rp1')), true);
    assert.equal(inlineOneShot.behaviorVerification.passed, 3);
    assert.equal(inlineRaw.content.filter(p => p.type === 'image').length >= 2, true);

    // Studio free-canvas -> studio_export(format:"rp", verify:true) -> Official HTML + Chrome pointer & alias verification
    const openStudio = await call('studio_open_project', {
      projectDir: 'studio-chrome-proj',
      cwd: work,
      port: 0,
      domain: 'mobile',
      name: 'StudioChromeVerify',
    });
    assert.equal(openStudio.ok, true);
    const cmdStudio = await call('studio_command', {
      baseRevision: openStudio.appliedRevision ?? openStudio.revision ?? 1,
      idempotencyKey: 'studio-chrome-widgets',
      pageId: 'home',
      commands: [
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: { id: 'res_lbl', type: 'label', name: '结果文案', x: 24, y: 80, w: 260, h: 28, text: '初始等待', fontSize: 16 },
        },
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: {
            id: 'submit_btn',
            type: 'button',
            name: '点我提交',
            x: 24,
            y: 136,
            w: 160,
            h: 44,
            text: '提交',
            on: { click: [{ type: 'set-text', target: 'res_lbl', text: 'Studio官网直验通过' }] },
          },
        },
      ],
    });
    assert.equal(cmdStudio.ok, true);
    const studioExpRaw = await callRaw('studio_export', {
      format: 'rp',
      cwd: work,
      outRpPath: 'studio-verified.rp',
      verify: true,
      includeStoryboard: true,
      verifySteps: [
        { action: 'expect', target: 'home/res_lbl', expect: { text: '初始等待' } },
        { action: 'click', target: '点我提交' },
        { action: 'expect', target: '结果文案', expect: { text: 'Studio官网直验通过' } },
      ],
    });
    const studioExp = studioExpRaw.structuredContent ?? JSON.parse(studioExpRaw.content[0].text);
    assert.equal(studioExp.ok, true);
    assert.equal(studioExp.threeZerosPassed, true);
    assert.equal(studioExp.behaviorVerification.passed, 3);
    assert.equal(studioExp.behaviorVerification.verification.behaviorVerified, true);
    assert.equal(studioExpRaw.content.filter(p => p.type === 'image').length, 1);
  });
});
