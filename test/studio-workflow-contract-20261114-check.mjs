import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRp } from '../scripts/rp-read.mjs';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withStudioMcp(cwd, fn) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === 'string')
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(skillRoot, 'bin/mcp.mjs')],
    cwd,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'studio-workflow-20261114-check', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parseRes(res) {
  const textBlock = (res.content || []).find(c => c.type === 'text');
  assert.ok(textBlock?.text, `Expected text block in MCP response: ${JSON.stringify(res)}`);
  return JSON.parse(textBlock.text);
}

test('Studio B1-B5 end-to-end contract suite: shadow/border parity, checkbox contrast & type-scale, immediate studio_design, panelStates screenshot, and cross-page hitTest', async () => {
  const base = mkdtempSync(join(tmpdir(), 'zee-studio-20261114-'));
  const projectA = join(base, 'project-a');
  const projectB = join(base, 'project-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });

  // Prepare initial dual-page 1440x900 desktop source JSON for project A
  const sourceA = join(base, 'desktop-suite.source.json');
  writeFileSync(sourceA, JSON.stringify({
    name: 'Desktop Print Suite',
    domain: 'web',
    variables: { confirmed: 'no' },
    pages: [
      {
        id: 'overview',
        name: 'Overview',
        domain: 'web',
        canvas: { width: 1440, height: 900, background: '#FFFFFF' },
        root: { id: 'root', type: 'box', layout: 'stack', w: 1440, h: 900, fill: '#FFFFFF', children: [] },
      },
      {
        id: 'detail',
        name: 'Detail',
        domain: 'web',
        canvas: { width: 1440, height: 900, background: '#FFFFFF' },
        root: { id: 'root', type: 'box', layout: 'stack', w: 1440, h: 900, fill: '#FFFFFF', children: [] },
      },
    ],
  }, null, 2));

  try {
    await withStudioMcp(base, async client => {
      // -----------------------------------------------------------------------
      // B1.a & B2.a: studio_describe documents exact value domains across surfaces & checkbox/radio typography
      // -----------------------------------------------------------------------
      const boxDesc = parseRes(await client.callTool({
        name: 'studio_describe',
        arguments: { topic: 'node', name: 'box', fields: ['shadow', 'borderBottom'] },
      }));
      assert.match(boxDesc.values?.shadow || '', /sm\/md\/lg/);
      assert.match(boxDesc.values?.borderBottom || '', /1px solid #CBD5E1/);
      const shadowCap = boxDesc.capabilities.find(c => c.field === 'shadow');
      const borderCap = boxDesc.capabilities.find(c => c.field === 'borderBottom');
      assert.ok(shadowCap?.surfaces?.canvas && shadowCap?.surfaces?.native && shadowCap?.surfaces?.['full-rp1']);
      assert.ok(borderCap?.surfaces?.canvas && borderCap?.surfaces?.native && borderCap?.surfaces?.['full-rp1']);

      const chkDesc = parseRes(await client.callTool({
        name: 'studio_describe',
        arguments: { topic: 'node', name: 'checkbox' },
      }));
      for (const f of ['color', 'fontSize', 'fontFamily', 'fontWeight']) {
        assert.ok(chkDesc.writableFields.includes(f), `checkbox writableFields missing ${f}`);
      }
      const radioDesc = parseRes(await client.callTool({
        name: 'studio_describe',
        arguments: { topic: 'node', name: 'radio' },
      }));
      for (const f of ['color', 'fontSize', 'fontFamily', 'fontWeight']) {
        assert.ok(radioDesc.writableFields.includes(f), `radio writableFields missing ${f}`);
      }

      // -----------------------------------------------------------------------
      // Open dual-page 1440x900 desktop project A
      // -----------------------------------------------------------------------
      const openA = parseRes(await client.callTool({
        name: 'studio_open_project',
        arguments: { projectDir: projectA, sourcePath: sourceA, port: 0 },
      }));
      assert.equal(openA.ok, true);
      let rev = openA.appliedRevision ?? openA.revision ?? 1;

      // -----------------------------------------------------------------------
      // B1.b: Upfront write-time validation rejects invalid shadow/border tokens
      // -----------------------------------------------------------------------
      const badShadowRes = await client.callTool({
        name: 'studio_command',
        arguments: {
          projectDir: projectA,
          baseRevision: rev,
          idempotencyKey: 'bad-shadow',
          commands: [{
            type: 'addNode',
            pageId: 'overview',
            parentId: 'overview/root',
            node: { id: 'bad_box', type: 'box', x: 40, y: 40, w: 120, h: 60, shadow: 'bogus_preset_xyz' },
          }],
        },
      });
      assert.ok(badShadowRes.isError, 'Invalid shadow token must be rejected upfront');
      assert.match(badShadowRes.content[0].text, /E_INVALID_VALUE|shadow/);

      const badBorderRes = await client.callTool({
        name: 'studio_command',
        arguments: {
          projectDir: projectA,
          baseRevision: rev,
          idempotencyKey: 'bad-border',
          commands: [{
            type: 'addNode',
            pageId: 'overview',
            parentId: 'overview/root',
            node: { id: 'bad_border_box', type: 'box', x: 40, y: 40, w: 120, h: 60, borderBottom: 'invalid-border-value' },
          }],
        },
      });
      assert.ok(badBorderRes.isError, 'Invalid CSS border shorthand must be rejected upfront');
      assert.match(badBorderRes.content[0].text, /E_INVALID_VALUE|borderBottom/);

      // -----------------------------------------------------------------------
      // Populate Overview (1440x900) & Detail (1440x900) with:
      // - strict 12 / 16 / 20 type scale
      // - header_bar with borderBottom="1px solid #CBD5E1" ONLY
      // - card_shadow with shadow="sm" AND borderBottom="1px solid #CBD5E1"
      // - checkbox #chk_pdf WITH text on #F8FAFC card (implicit default fontSize first)
      // - 4-state dynamic-panel #main_panel (st_1..st_4)
      // - edge buttons at x=24 and x=1284 for wide-artboard hitTest + cross-page link
      // -----------------------------------------------------------------------
      const populateOverview = parseRes(await client.callTool({
        name: 'studio_command',
        arguments: {
          projectDir: projectA,
          baseRevision: rev,
          idempotencyKey: 'populate-overview',
          commands: [
            {
              type: 'addNode',
              pageId: 'overview',
              parentId: 'overview/root',
              node: {
                id: 'header_bar',
                type: 'box',
                layout: 'stack',
                x: 0, y: 0, w: 1440, h: 64,
                fill: '#FFFFFF',
                borderBottom: '1px solid #CBD5E1',
                children: [
                  { id: 'page_title', type: 'label', text: '出版印前质检工作台', x: 180, y: 18, w: 360, h: 28, fontSize: 20, fontWeight: 700, color: '#0F172A' },
                  {
                    id: 'btn_left_edge', type: 'button', text: '切至复核态',
                    x: 24, y: 14, w: 132, h: 36, fill: '#0F172A', color: '#FFFFFF', fontSize: 12, radius: 8,
                    onClick: [{ type: 'set-panel-state', target: 'main_panel', state: 'st_2' }],
                  },
                  {
                    id: 'btn_right_edge', type: 'button', text: '前往签署页',
                    x: 1284, y: 14, w: 132, h: 36, fill: '#2563EB', color: '#FFFFFF', fontSize: 12, radius: 8,
                    onClick: [{ type: 'link', to: 'detail' }],
                  },
                ],
              },
            },
            {
              type: 'addNode',
              pageId: 'overview',
              parentId: 'overview/root',
              node: {
                id: 'card_shadow',
                type: 'box',
                layout: 'stack',
                x: 48, y: 96, w: 620, h: 220,
                fill: '#F8FAFC',
                radius: 12,
                shadow: 'sm',
                borderBottom: '1px solid #CBD5E1',
                children: [
                  { id: 'card_lead', type: 'label', text: '导出规格与出血线核验', x: 24, y: 24, w: 420, h: 24, fontSize: 16, fontWeight: 600, color: '#0F172A' },
                  { id: 'card_caption', type: 'label', text: '符合 ISO 12647-2 商业印刷色彩规范', x: 24, y: 56, w: 420, h: 20, fontSize: 12, color: '#475569' },
                  { id: 'chk_pdf', type: 'checkbox', text: '高清印刷级 PDF 导出', x: 24, y: 96, w: 320, h: 32, checked: true },
                ],
              },
            },
            {
              type: 'addNode',
              pageId: 'overview',
              parentId: 'overview/root',
              node: {
                id: 'main_panel',
                type: 'dynamic-panel',
                x: 712, y: 96, w: 680, h: 220,
                activeState: 'st_1',
                states: [
                  {
                    id: 'st_1', name: '概览',
                    root: {
                      id: 'st1_bg', type: 'box', layout: 'stack', x: 0, y: 0, w: 680, h: 220, fill: '#EFF6FF', radius: 12,
                      children: [{ id: 'st1_txt', type: 'label', text: '状态一：色彩空间 CMYK 预检通过', x: 24, y: 24, w: 480, h: 28, fontSize: 16, color: '#1E3A8A' }],
                    },
                  },
                  {
                    id: 'st_2', name: '复核',
                    root: {
                      id: 'st2_bg', type: 'box', layout: 'stack', x: 0, y: 0, w: 680, h: 220, fill: '#ECFDF5', radius: 12,
                      children: [{ id: 'nested_badge', type: 'label', text: '状态二：出血与裁切标记已锁定', x: 24, y: 24, w: 480, h: 28, fontSize: 16, color: '#065F46' }],
                    },
                  },
                  {
                    id: 'st_3', name: '叠印',
                    root: {
                      id: 'st3_bg', type: 'box', layout: 'stack', x: 0, y: 0, w: 680, h: 220, fill: '#FEF3C7', radius: 12,
                      children: [{ id: 'st3_txt', type: 'label', text: '状态三：专色通道叠印预览', x: 24, y: 24, w: 480, h: 28, fontSize: 16, color: '#92400E' }],
                    },
                  },
                  {
                    id: 'st_4', name: '签样',
                    root: {
                      id: 'st4_bg', type: 'box', layout: 'stack', x: 0, y: 0, w: 680, h: 220, fill: '#F3E8FF', radius: 12,
                      children: [{ id: 'st4_txt', type: 'label', text: '状态四：电子蓝纸最终归档', x: 24, y: 24, w: 480, h: 28, fontSize: 16, color: '#5B21B6' }],
                    },
                  },
                ],
              },
            },
            {
              type: 'addNode',
              pageId: 'detail',
              parentId: 'detail/root',
              node: {
                id: 'detail_card',
                type: 'box',
                layout: 'stack',
                x: 48, y: 64, w: 640, h: 240,
                fill: '#F8FAFC',
                radius: 12,
                shadow: 'md',
                borderBottom: '1px solid #CBD5E1',
                children: [
                  { id: 'detail_title', type: 'label', text: '印前签样确认单', x: 24, y: 24, w: 400, h: 28, fontSize: 20, fontWeight: 700, color: '#0F172A' },
                  { id: 'detail_desc', type: 'label', text: '确认无误后提交印厂制版队列', x: 24, y: 68, w: 420, h: 24, fontSize: 16, color: '#334155' },
                  {
                    id: 'btn_confirm', type: 'button', text: '确认签样',
                    x: 24, y: 132, w: 148, h: 40, fill: '#16A34A', color: '#FFFFFF', fontSize: 16, radius: 8,
                    onClick: [{ type: 'set-var', name: 'confirmed', value: 'yes' }],
                  },
                ],
              },
            },
          ],
        },
      }));
      assert.equal(populateOverview.ok, true, JSON.stringify(populateOverview));
      rev = populateOverview.appliedRevision;

      // -----------------------------------------------------------------------
      // B3 + B2: IMMEDIATELY call studio_design(action:"review") right after studio_command
      // without any intermediate studio_screenshot!
      // Verify:
      // 1) Zero E_STALE_REVIEW
      // 2) Zero W_CONTRAST_UNKNOWN on checkbox #chk_pdf
      // 3) Implicit 14px on #chk_pdf does NOT pollute 12/16/20 3-step type-scale!
      // -----------------------------------------------------------------------
      const immediateReview1 = parseRes(await client.callTool({
        name: 'studio_design',
        arguments: {
          projectDir: projectA,
          action: 'review',
          pageId: 'overview',
          baseRevision: rev,
          verbose: true,
        },
      }));
      assert.equal(immediateReview1.ok, true, `Immediate review failed: ${JSON.stringify(immediateReview1)}`);
      assert.equal(immediateReview1.revision, rev);

      const unknownFindings1 = (immediateReview1.findings || []).filter(f => f.code === 'W_CONTRAST_UNKNOWN');
      assert.deepEqual(unknownFindings1, [], `Unexpected W_CONTRAST_UNKNOWN on checkbox: ${JSON.stringify(unknownFindings1)}`);

      const metricsRes1 = parseRes(await client.callTool({
        name: 'studio_design',
        arguments: { projectDir: projectA, action: 'metrics', pageId: 'overview' },
      }));
      assert.deepEqual(metricsRes1.metrics.typeScale.sizes, [20, 16, 12]);
      assert.equal(metricsRes1.metrics.typeScale.levels, 3);
      assert.equal(metricsRes1.checks.find(c => c.key === 'type-scale')?.ok, true);

      const pxContrast1 = parseRes(await client.callTool({
        name: 'studio_design',
        arguments: { projectDir: projectA, action: 'pixel_contrast', pageId: 'overview' },
      }));
      assert.equal(pxContrast1.unknown, 0, `Expected 0 unknown pixel contrast items: ${JSON.stringify(pxContrast1)}`);
      assert.equal(pxContrast1.failing, 0, `Expected 0 failing pixel contrast items: ${JSON.stringify(pxContrast1)}`);

      // Now explicitly configure color & fontSize on checkbox #chk_pdf via scoped ID (B2 + B5)
      // AND immediately call studio_design(action:"review") OMITTING baseRevision and pageId (B3)!
      const updateChk = parseRes(await client.callTool({
        name: 'studio_command',
        arguments: {
          projectDir: projectA,
          baseRevision: rev,
          idempotencyKey: 'style-checkbox',
          commands: [{
            type: 'setProperties',
            nodeId: 'overview/chk_pdf',
            properties: { color: '#1E293B', fontSize: 16 },
          }],
        },
      }));
      assert.equal(updateChk.ok, true, JSON.stringify(updateChk));
      rev = updateChk.appliedRevision;

      const immediateReviewDefaultArgs = parseRes(await client.callTool({
        name: 'studio_design',
        arguments: { action: 'review' },
      }));
      assert.equal(immediateReviewDefaultArgs.ok, true, JSON.stringify(immediateReviewDefaultArgs));
      assert.equal(immediateReviewDefaultArgs.revision, rev);
      assert.equal(immediateReviewDefaultArgs.pageId, 'overview');

      // Submit observations using scoped nodeId "overview/card_shadow" (B5)
      const obsRes = parseRes(await client.callTool({
        name: 'studio_design',
        arguments: {
          action: 'review',
          reviewId: immediateReviewDefaultArgs.reviewId,
          observations: [{
            nodeIds: ['overview/card_shadow'],
            issue: '核验卡片阴影与底边线层级清晰',
            decision: '保持 sm 阴影与 1px 底边框',
          }],
        },
      }));
      assert.equal(obsRes.ok, true, JSON.stringify(obsRes));

      // Verify true stale baseRevision returns structured revision diagnostics (B3)
      const staleRes = await client.callTool({
        name: 'studio_design',
        arguments: {
          projectDir: projectA,
          action: 'review',
          pageId: 'overview',
          baseRevision: 1,
        },
      });
      assert.ok(staleRes.isError);
      const stalePayload = parseRes(staleRes);
      const staleDiag = stalePayload.diagnostics?.[0] || stalePayload;
      assert.equal(staleDiag.code || stalePayload.code, 'E_STALE_REVIEW');
      assert.equal(stalePayload.currentRevision ?? staleDiag.currentRevision, rev);
      assert.equal(stalePayload.requestedBaseRevision ?? staleDiag.requestedBaseRevision, 1);

      // -----------------------------------------------------------------------
      // B4: Side-effect-free studio_screenshot(panelStates) across all 4 states
      // -----------------------------------------------------------------------
      const ctxBefore = parseRes(await client.callTool({
        name: 'studio_inspect',
        arguments: { projectDir: projectA, view: 'context' },
      }));
      const shas = [];
      for (const stateId of ['st_1', 'st_2', 'st_3', 'st_4']) {
        const shot = parseRes(await client.callTool({
          name: 'studio_screenshot',
          arguments: {
            projectDir: projectA,
            pageId: 'overview',
            panelStates: { main_panel: stateId },
            includeImage: false,
          },
        }));
        assert.equal(shot.ok, true, JSON.stringify(shot));
        assert.equal(shot.revision, rev);
        assert.equal(shot.panelStates?.main_panel, stateId);
        assert.equal(shot.previewOnly, true);
        shas.push(shot.sha256);
      }
      assert.equal(new Set(shas).size, 4, `Expected 4 distinct state screenshots, got ${JSON.stringify(shas)}`);

      // Scoped panel key + panelId/stateId notation also works and matches st_2
      const shotScopedSt2 = parseRes(await client.callTool({
        name: 'studio_screenshot',
        arguments: {
          projectDir: projectA,
          pageId: 'overview',
          panelStates: { 'overview/main_panel': 'main_panel/st_2' },
          includeImage: false,
        },
      }));
      assert.equal(shotScopedSt2.sha256, shas[1]);

      // Subsequent normal screenshot matches st_1 (proving temporary override restored authoritative state)
      const shotRestored = parseRes(await client.callTool({
        name: 'studio_screenshot',
        arguments: { projectDir: projectA, pageId: 'overview', includeImage: false },
      }));
      assert.equal(shotRestored.sha256, shas[0]);

      const ctxAfter = parseRes(await client.callTool({
        name: 'studio_inspect',
        arguments: { projectDir: projectA, view: 'context' },
      }));
      assert.equal(ctxAfter.appliedRevision, ctxBefore.appliedRevision);
      assert.equal(ctxAfter.contentHash, ctxBefore.contentHash);

      // -----------------------------------------------------------------------
      // B5: Cross-tool nodeId / pageId/nodeId normalization (including nested panel state nodes)
      // + cross-page real-pointer studio_scenario(hitTest:true) on 1440x900 desktop pages
      // -----------------------------------------------------------------------
      const inspectNested = parseRes(await client.callTool({
        name: 'studio_inspect',
        arguments: { projectDir: projectA, view: 'nodes', nodeId: 'overview/nested_badge' },
      }));
      assert.equal(inspectNested.nodes.length, 1);
      assert.equal(inspectNested.nodes[0].id, 'nested_badge');

      const shotScopedNode = parseRes(await client.callTool({
        name: 'studio_screenshot',
        arguments: { projectDir: projectA, nodeId: 'overview/card_shadow', includeImage: false },
      }));
      assert.equal(shotScopedNode.ok, true);

      // Update nested node inside st_2 via RP/1 sourceMode:"update" using scoped target
      const rp1ScopedUpdate = parseRes(await client.callTool({
        name: 'studio_command',
        arguments: {
          projectDir: projectA,
          pageId: 'overview',
          sourceMode: 'update',
          baseRevision: rev,
          idempotencyKey: 'rp1-update-nested',
          rp1: 'label #overview/nested_badge x=24 y=24 [480x28] "状态二：出血与裁切标记已复核锁定" fontSize=16 color=#065F46',
        },
      }));
      assert.equal(rp1ScopedUpdate.ok, true, JSON.stringify(rp1ScopedUpdate));
      rev = rp1ScopedUpdate.appliedRevision;

      // Cross-page hitTest:true scenario clicking left-edge (x=24), right-edge (x=1284 -> navigate to detail),
      // detail button, and explicit navigate step back to overview!
      const scenarioHit = parseRes(await client.callTool({
        name: 'studio_scenario',
        arguments: {
          projectDir: projectA,
          startPageId: 'overview',
          hitTest: true,
          steps: [
            {
              action: 'click',
              target: 'overview/btn_left_edge',
              expect: { panelState: { 'overview/main_panel': 'main_panel/st_2' } },
            },
            {
              action: 'click',
              target: 'btn_right_edge',
              expect: { page: 'detail' },
            },
            {
              action: 'click',
              target: 'detail/btn_confirm',
              expect: { variables: { confirmed: 'yes' } },
            },
            {
              action: 'navigate',
              page: 'overview',
              expect: { page: 'overview' },
            },
          ],
        },
      }));
      assert.equal(scenarioHit.ok, true, `Cross-page hitTest scenario failed: ${JSON.stringify(scenarioHit)}`);
      assert.equal(scenarioHit.hitTest?.passed, true);
      assert.equal(scenarioHit.hitTest?.verification, 'real-browser-pointer');

      // Dataset step still explicitly returns E_SCENARIO_HITTEST_UNSUPPORTED under hitTest:true
      const datasetUnsupported = await client.callTool({
        name: 'studio_scenario',
        arguments: {
          projectDir: projectA,
          startPageId: 'overview',
          hitTest: true,
          steps: [{
            action: 'dataset',
            dataset: 'items',
            op: 'sort',
            field: 'id',
            order: 'asc',
            expect: { page: 'overview' },
          }],
        },
      });
      assert.ok(datasetUnsupported.isError);
      const dsPayload = parseRes(datasetUnsupported);
      assert.equal(dsPayload.code || dsPayload.diagnostics?.[0]?.code, 'E_SCENARIO_HITTEST_UNSUPPORTED');

      // -----------------------------------------------------------------------
      // B1.c: Both studio_export(format:"code") AND studio_export(format:"rp") succeed!
      // -----------------------------------------------------------------------
      const codeDir = join(base, 'exported-code');
      const codeExport = parseRes(await client.callTool({
        name: 'studio_export',
        arguments: { projectDir: projectA, format: 'code', outDir: codeDir },
      }));
      assert.equal(codeExport.ok, true, JSON.stringify(codeExport));
      const exportedHtml = readFileSync(join(codeDir, 'index.html'), 'utf8');
      const exportedAppJs = readFileSync(join(codeDir, 'app.js'), 'utf8');
      assert.match(exportedHtml, /border-bottom:\s*1px solid #cbd5e1/i);
      assert.match(exportedHtml, /box-shadow:\s*0 1px 3px/i);
      assert.match(exportedAppJs, /"borderBottom":\s*"1px solid #CBD5E1"/i);

      if (!nativeTemplateSkipReason()) {
        const outRpPath = join(base, 'desktop-print-suite.rp');
        const rpExportRes = await client.callTool({
          name: 'studio_export',
          arguments: { projectDir: projectA, format: 'rp', outRpPath },
        });
        assert.ok(!rpExportRes.isError, `studio_export(format:"rp") failed: ${rpExportRes.content[0].text}`);
        const rpExport = parseRes(rpExportRes);
        assert.equal(rpExport.ok, true);
        assert.ok(existsSync(outRpPath));
        const rpParsed = readRp(readFileSync(outRpPath));
        assert.equal(rpParsed.records.unparseable, 0);
        assert.equal(rpParsed.counts.danglingRefs, 0);
        assert.equal(rpParsed.counts.problems, 0);
        assert.equal(rpParsed.pages.length, 2);
      }

      // -----------------------------------------------------------------------
      // B3.b: Multi-project lastActiveProjectDir pinning when omitting projectDir
      // -----------------------------------------------------------------------
      const openB = parseRes(await client.callTool({
        name: 'studio_open_project',
        arguments: { projectDir: projectB, name: 'Second Project B', domain: 'mobile', port: 0 },
      }));
      assert.equal(openB.ok, true);
      const revB0 = openB.appliedRevision ?? openB.revision ?? 1;
      const pageBId = openB.doc?.pages?.[0]?.id || 'home';

      const cmdB = parseRes(await client.callTool({
        name: 'studio_command',
        arguments: {
          projectDir: projectB,
          pageId: pageBId,
          sourceMode: 'insert',
          baseRevision: revB0,
          idempotencyKey: 'b-insert',
          rp1: 'label #b_title x=24 y=32 [300x32] "第二工程活跃绑定验证" fontSize=20 color=#0F172A',
        },
      }));
      assert.equal(cmdB.ok, true);

      const reviewOmittedDir = parseRes(await client.callTool({
        name: 'studio_design',
        arguments: { action: 'review' },
      }));
      assert.equal(reviewOmittedDir.ok, true);
      assert.equal(reviewOmittedDir.revision, cmdB.appliedRevision);
      assert.equal(reviewOmittedDir.pageId, pageBId);
      assert.equal(reviewOmittedDir.documentId, openB.doc.documentId);
      assert.ok(reviewOmittedDir.reportPath.includes('project-b'));
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
