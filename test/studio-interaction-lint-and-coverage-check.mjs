#!/usr/bin/env node
/**
 * Batch 6 深度回归测试：
 *  1. 静态 + 运行时交互自愈诊断（全部 7 个 INTERACTION_LINT_CODES，含 T01 类祖先隐藏遮蔽 W_SHOW_MASKED_BY_HIDDEN_ANCESTOR）
 *  2. studio_scenario 分支/面板状态/页面覆盖率 (coverage) 与运行时告警
 *  3. studio_design(action: "review") 原生就绪度 (nativeReadiness) 与 interactionDiagnostics
 *  4. studio_design(action: "fix_plan") 自动修复 E_TEXT_CLIP 与 W_STACK_CHILDREN_UNPLACED
 *  5. addPage 布局壳层引导参数 (shell: "phone-shell" | "web-page") 与无参数向后兼容
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintDocumentInteractions } from '../studio/interaction-lint.mjs';
import { closeInProcessStudioServer, studioHandlers } from '../studio/mcp-adapter.mjs';

test('静态与运行时交互自愈诊断（全部 7 类诊断码）及场景覆盖率', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-b6-lint-'));
  try {
    const open = await studioHandlers.studio_open_project({
      projectDir: dir,
      name: '交互自愈与覆盖率验证',
      domain: 'mobile',
      port: 0,
    });

    const applied = await studioHandlers.studio_command({
      projectDir: dir,
      baseRevision: open.appliedRevision,
      idempotencyKey: 'b6-lint-setup',
      commands: [
        { type: 'set-variable', name: 'step', value: 1 },
        { type: 'set-variable', name: 'frozenVar', value: 'init' },
        { type: 'addPage', id: 'detail', name: '详情页', shell: 'phone-shell', layout: 'column', gap: 16 },
        { type: 'addPage', id: 'web_preview', name: '桌面预览页', shell: 'web-page' },
        { type: 'addPage', id: 'legacy_bare', name: '裸页兼容' },
        // 隐藏祖先遮蔽陷阱（T01 类）
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: {
            id: 'hidden_modal_wrap',
            type: 'box',
            layout: 'column',
            x: 20,
            y: 80,
            w: 340,
            h: 120,
            visible: false,
            children: [
              { id: 'inner_tip', type: 'label', text: '被隐藏父容器遮蔽的提示', w: 'fill', h: 32 },
            ],
          },
        },
        // 永远无引用的孤立隐藏层
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: { id: 'dead_hidden_layer', type: 'label', text: '死隐藏节点', x: 20, y: 220, w: 200, h: 28, visible: false },
        },
        // 无交互可见按钮
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: { id: 'idle_btn', type: 'button', text: '忘了绑交互', x: 20, y: 260, w: 160, h: 44 },
        },
        // 动态面板（2 个状态）
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: {
            id: 'info_panel',
            type: 'dynamic-panel',
            x: 20,
            y: 320,
            w: 340,
            h: 100,
            activeState: 'summary',
            states: [
              { id: 'summary', name: '摘要', root: { id: 'sum_root', type: 'box', layout: 'column', w: 340, h: 100, children: [{ id: 'sum_lbl', type: 'label', text: '摘要态', w: 'fill', h: 28 }] } },
              { id: 'more', name: '展开', root: { id: 'more_root', type: 'box', layout: 'column', w: 340, h: 100, children: [{ id: 'more_lbl', type: 'label', text: '展开态', w: 'fill', h: 28 }] } },
            ],
          },
        },
        // 触发遮蔽 show + 死分支 + 恒真/恒假条件 + 未更新状态变量
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: {
            id: 'trigger_masked_btn',
            type: 'button',
            text: '揭示内部提示',
            x: 20,
            y: 440,
            w: 340,
            h: 48,
            on: {
              click: {
                cases: [
                  { when: '=$frozenVar === "init"', actions: [{ type: 'show', target: 'inner_tip' }] },
                  { when: '=1 === 2', actions: [{ type: 'set-text', target: 'sum_lbl', text: '不可达恒假' }] },
                  { else: true, actions: [{ type: 'set-panel-state', target: 'info_panel', state: 'more' }] },
                  { when: '=$step === 2', actions: [{ type: 'navigate', page: 'detail' }] },
                ],
              },
            },
          },
        },
        // 顺序数组中前序修改 $step、后序 when 立即读取 $step 的连环误触发陷阱
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'home_screen',
          node: {
            id: 'seq_bug_btn',
            type: 'button',
            text: '顺序连环误触发',
            x: 20,
            y: 500,
            w: 340,
            h: 48,
            on: {
              click: [
                { when: '=$step === 1', actions: [{ type: 'set-var', name: 'step', value: 2 }] },
                { when: '=$step === 2', actions: [{ type: 'set-var', name: 'step', value: 3 }] },
              ],
            },
          },
        },
      ],
      includeDoc: true,
    });
    assert.equal(applied.ok, true);

    // 验证 addPage 壳层参数与向后兼容
    const detailPage = applied.doc.pages.find(p => p.id === 'detail');
    assert.equal(detailPage.root.type, 'phone-shell');
    assert.equal(detailPage.root.children[0].id, 'detail_screen');
    assert.equal(detailPage.root.children[0].layout, 'column');
    assert.deepEqual(detailPage.root.children[0].padding, [60, 0, 0, 0]);

    const webPage = applied.doc.pages.find(p => p.id === 'web_preview');
    assert.equal(webPage.domain, 'web');
    assert.equal(webPage.root.layout, 'column');
    assert.equal(webPage.root.padding, 24);

    const barePage = applied.doc.pages.find(p => p.id === 'legacy_bare');
    assert.equal(barePage.root.layout, 'stack');
    assert.equal(barePage.root.padding, 0);

    // 文档默认诊断仅包含明确交互逻辑缺陷（5 类），不含完整性提示
    const docDiagCodes = new Set((applied.doc.diagnostics || []).map(d => d.code));
    assert.ok(docDiagCodes.has('W_SHOW_MASKED_BY_HIDDEN_ANCESTOR'));
    assert.ok(docDiagCodes.has('W_CASE_CONSTANT_CONDITION'));
    assert.ok(docDiagCodes.has('W_CASE_SHADOWED'));
    assert.ok(docDiagCodes.has('W_SEQUENTIAL_WHEN_MUTATION'));
    assert.ok(docDiagCodes.has('W_STATE_VAR_NEVER_UPDATED'));
    assert.ok(!docDiagCodes.has('W_BUTTON_NO_INTERACTION'));
    assert.ok(!docDiagCodes.has('W_UNREACHABLE_HIDDEN_LAYER'));

    // 完整性扫描返回全部 7 类诊断码
    const fullLint = lintDocumentInteractions(applied.doc, { includeCompleteness: true });
    const fullCodes = new Set(fullLint.map(d => d.code));
    for (const expectedCode of [
      'W_SHOW_MASKED_BY_HIDDEN_ANCESTOR',
      'W_CASE_CONSTANT_CONDITION',
      'W_CASE_SHADOWED',
      'W_SEQUENTIAL_WHEN_MUTATION',
      'W_STATE_VAR_NEVER_UPDATED',
      'W_BUTTON_NO_INTERACTION',
      'W_UNREACHABLE_HIDDEN_LAYER',
    ]) {
      assert.ok(fullCodes.has(expectedCode), `缺少预期诊断码: ${expectedCode}`);
    }

    // 运行时场景验证：触发被隐藏祖先遮蔽的 show，验证运行时 step warning + coverage 覆盖率统计
    const scen = await studioHandlers.studio_scenario({
      projectDir: dir,
      steps: [
        {
          action: 'click',
          target: 'trigger_masked_btn',
          expect: { visible: { inner_tip: false } },
        },
      ],
    });
    assert.equal(scen.ok, true);
    assert.ok(Array.isArray(scen.stepResults[0].warnings));
    assert.ok(scen.stepResults[0].warnings.some(w => w.code === 'W_SHOW_MASKED_BY_HIDDEN_ANCESTOR' && w.maskedByAncestorId === 'hidden_modal_wrap'));
    assert.ok(scen.coverage, '应返回 coverage 覆盖率摘要');
    assert.deepEqual(scen.coverage.visitedPages, ['home']);
    assert.ok(scen.coverage.unvisitedPages.includes('detail'));
    assert.ok(scen.coverage.triggeredInteractiveNodes.includes('home/trigger_masked_btn'));
    assert.ok(scen.coverage.untriggeredInteractiveNodes.includes('home/seq_bug_btn'));
    assert.ok(scen.coverage.visitedPanelStates.includes('home/info_panel:summary'));
    assert.ok(scen.coverage.unvisitedPanelStates.includes('home/info_panel:more'));
    assert.equal(scen.coverage.matchedCaseBranches.length, 1);
    assert.ok(scen.coverage.unmatchedCaseBranches.length >= 2);
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('studio_design(review) 原生就绪度摘要与 fix_plan 自动修复 E_TEXT_CLIP / W_STACK_CHILDREN_UNPLACED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-b6-review-fix-'));
  try {
    const open = await studioHandlers.studio_open_project({
      projectDir: dir,
      name: '评审就绪度与自动修复验证',
      domain: 'web',
      port: 0,
    });

    const built = await studioHandlers.studio_command({
      projectDir: dir,
      baseRevision: open.appliedRevision,
      idempotencyKey: 'b6-fix-setup',
      commands: [
        // 1) 未定位子节点的 stack 卡片容器 -> W_STACK_CHILDREN_UNPLACED
        {
          type: 'addNode',
          pageId: 'home',
          node: {
            id: 'unplaced_card',
            type: 'box',
            layout: 'stack',
            x: 40,
            y: 40,
            w: 560,
            h: 240,
            padding: 16,
            fill: '$brand-soft',
            children: [
              { id: 'u_title', type: 'label', text: '第一行标题', w: 200, h: 28, fontSize: 18, fontWeight: 600 },
              { id: 'u_desc', type: 'label', text: '第二行说明与标题重叠在 0,0', w: 260, h: 24, fontSize: 14 },
            ],
          },
        },
        // 2) 高度过小导致垂直裁切的多行段落 -> E_TEXT_CLIP
        {
          type: 'addNode',
          pageId: 'home',
          node: {
            id: 'clipped_para',
            type: 'paragraph',
            text: '这是一段很长的中文多行说明文案，用于验证自动修复计划能够按真实排版测量高度扩容到 4px 栅格，彻底消除垂直文本裁切告警。',
            x: 40,
            y: 320,
            w: 220,
            h: 20,
            fontSize: 14,
            lineHeight: 22,
          },
        },
        // 3) 带旋转的 input -> native-init-action
        {
          type: 'addNode',
          pageId: 'home',
          node: {
            id: 'rotated_inp',
            type: 'input',
            placeholder: '旋转输入框',
            x: 40,
            y: 440,
            w: 200,
            h: 40,
            rotation: 12,
          },
        },
      ],
    });
    assert.equal(built.ok, true);
    assert.ok(built.diagnostics.some(d => d.code === 'W_STACK_CHILDREN_UNPLACED'));

    // 验证 fix_plan 同时给出 setLayout(column) 与 setProperties(h 扩容) 且通过自证
    const plan = await studioHandlers.studio_design({
      projectDir: dir,
      action: 'fix_plan',
      pageId: 'home',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.verified, true);
    assert.ok(
      plan.commands.some(c => c.type === 'setLayout' && c.nodeId === 'unplaced_card' && c.mode === 'column'),
      `期望为 unplaced_card 生成 setLayout(column)，实际: ${JSON.stringify(plan.commands)}`
    );
    assert.ok(
      plan.commands.some(c => c.type === 'setProperties' && c.nodeId === 'clipped_para' && c.properties?.h > 20),
      `期望为 clipped_para 生成扩容 setProperties，实际: ${JSON.stringify(plan.commands)}`
    );

    const fixed = await studioHandlers.studio_command({
      projectDir: dir,
      baseRevision: built.appliedRevision,
      idempotencyKey: 'b6-apply-fixes',
      commands: plan.commands,
    });
    assert.equal(fixed.ok, true);

    // 应用后再次求 fix_plan，之前两项已全部消除
    const planAfter = await studioHandlers.studio_design({
      projectDir: dir,
      action: 'fix_plan',
      pageId: 'home',
    });
    assert.ok(!planAfter.commands.some(c => c.nodeId === 'unplaced_card' || c.nodeId === 'clipped_para'));

    // 验证 review 返回 nativeReadiness 与 interactionDiagnostics（紧凑模式同样保留）
    const review = await studioHandlers.studio_design({
      projectDir: dir,
      action: 'review',
      pageId: 'home',
      baseRevision: fixed.appliedRevision,
    });
    assert.equal(review.ok, true);
    assert.ok(review.nativeReadiness, 'review 必须包含 nativeReadiness');
    assert.equal(review.nativeReadiness.fullyNativeEditable, true);
    assert.ok(review.nativeReadiness.counts.nativeInitAction >= 1);
    assert.ok(review.nativeReadiness.nonNativeItems.some(item => item.nodeId === 'rotated_inp' && item.classification === 'native-init-action'));
    assert.ok(Array.isArray(review.interactionDiagnostics));
  } finally {
    await closeInProcessStudioServer();
    rmSync(dir, { recursive: true, force: true });
  }
});
