#!/usr/bin/env node
/**
 * 回归验证：冷启动盲测（Cold-Start Dogfooding 2026-11-12）暴露的 10 项全链路打磨闭环
 *  1. P0 #1: progress-bar 导出 .rp 不因内部 clip 属性崩溃，且绑定 {variable} 时节点快照不污染为 [object Object]
 *  2. P0 #2: 容器态 card（带显式 children）默认继承 column 流式布局、$surface 填充与圆角，不再退化为透明 (0,0) 重叠 stack
 *  3. P1 #3: studio_design(fix_plan) 遇到宏展开虚拟子节点（如 stat-row 的 _stat_0）时跳过直接写虚拟节点，试跑不报 E_NODE_NOT_FOUND
 *  4. P1 #4: studio_scenario(hitTest:true) 真实浏览器指针重放支持 combobox/select 与 listbox 选值，支持 checked/selected/panelState 断言，失败时附带步骤编号
 *  5. P1 #5: studio_design(review).nativeReadiness 扫描非激活 DynamicPanel 状态树（如隐藏态内的 textarea/input.multiline），提前与 .rp 兼容报告对齐
 *  6. P1 #6: mobile-hifi 默认主题与内置宏（nav-bar / card / stat-row / list-item / progress-bar / tab-bar / panel tabs）在默认参数下通过 L1 像素门禁（对比度 / 44px 热区 / 字阶 / 4px 栅格）
 *  7. P2 #7: Studio RP/1 容器行尾冒号（如 panel #work_panel:）兼容剥离，不再污染节点 ID
 *  8. P2 #8: studio_open_project JSON Schema 允许 port: 0 自动分配空闲临时端口，且拒绝 1..1023 特权端口
 *  9. P2 #9: studio_describe(topic:"node") 支持 textarea/select/panel 等语法别名、names 批量数组查询，并如实描述 progress-bar/nav-bar/tab-bar 宏参数展开
 * 10. P2 #10: studio_export(format:"rp") 顶层返回 threeZerosPassed，interactionSources 含 contained-widget 子画布交互且 matchesRpSummary 为 true
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInput } from '../studio/schema-validation.mjs';
import { closeInProcessStudioServer, studioHandlers, studioTools } from '../studio/mcp-adapter.mjs';

test('合约发现与端口 Schema：port:0 校验、节点语法别名与批量查询、动作词表同步', async () => {
  const openSchema = studioTools.find(t => t.name === 'studio_open_project').inputSchema;
  assert.doesNotThrow(() => validateInput(openSchema, { projectDir: '/tmp/demo', port: 0 }, 'studio_open_project'));
  assert.doesNotThrow(() => validateInput(openSchema, { projectDir: '/tmp/demo', port: 4310 }, 'studio_open_project'));
  await assert.rejects(
    () => studioHandlers.studio_open_project({ projectDir: '/tmp/demo', port: 80 }),
    err => err?.code === 'E_INVALID_PORT'
  );

  const textareaDesc = await studioHandlers.studio_describe({ topic: 'node', name: 'textarea' });
  assert.equal(textareaDesc.ok, true);
  assert.equal(textareaDesc.type, 'input');
  assert.equal(textareaDesc.aliasOf, 'input');
  assert.match(textareaDesc.note, /TextBox/);

  const batchDesc = await studioHandlers.studio_describe({
    topic: 'node',
    names: ['progress-bar', 'select', 'panel'],
  });
  assert.equal(batchDesc.ok, true);
  assert.equal(batchDesc.nodes.length, 3);
  assert.ok(batchDesc.nodes[0].summary.commonFields.includes('value'));
  assert.match(batchDesc.nodes[0].summary.boundary, /自动展开/);
  assert.equal(batchDesc.nodes[1].type, 'combobox');
  assert.equal(batchDesc.nodes[2].type, 'dynamic-panel');

  const setIxContract = await studioHandlers.studio_describe({ topic: 'command', name: 'setInteraction' });
  assert.equal(setIxContract.ok, true);
  assert.match(setIxContract.schema.properties.actions.description, /set-check/);
  assert.match(setIxContract.schema.properties.actions.description, /set-option/);

  const workflow = await studioHandlers.studio_describe({ topic: 'workflow' });
  assert.ok(workflow.rules.some(r => r.includes('addPage')));
});

test('端到端全链路回归：内置宏零 L1 阻塞、容器 card、panel 冒号、fix_plan、非激活态 nativeReadiness、hitTest combobox/listbox 与 .rp 导出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-coldstart-polish-'));
  try {
    const opened = await studioHandlers.studio_open_project({
      projectDir: dir,
      name: '冷启动打磨全链路验收',
      domain: 'mobile',
      port: 0,
    });
    assert.equal(opened.ok, true);

    // 先建第二页，再提交含跨页跳转、panel 行尾冒号、容器态 card、progress-bar 变量绑定、表单控件与全套内置宏的 RP/1
    const addSummary = await studioHandlers.studio_command({
      projectDir: dir,
      baseRevision: opened.appliedRevision,
      idempotencyKey: 'add-summary-page',
      commands: [
        { type: 'addPage', id: 'summary', name: '复盘页', shell: 'phone-shell' },
      ],
    });
    assert.equal(addSummary.ok, true);

    const rp1Home = `
vars:
  doneCount = 2
  selectedDur = "25分钟"
  autoBreak = true

column #home_body [fillxhug] gap=8
  nav-bar #top_nav title="知序专注" rightText="复盘" rightGoto="summary"
  stat-row #daily_stats items=[{"label":"已完成","value":"2","sub":"今日轮次"},{"label":"专注率","value":"92%","sub":"高于均值"}]
  progress-bar #goal_prog label="今日目标进度" value={"variable":"doneCount"} max=4
  card #hero_card title="深度工作节律" subtitle="沉浸单任务块" body="保持单核注意力，结束后记录复盘要点。" tag="进行中" tagTone="warning" rightBadge="达标" rightTone="success" actionText="查看复盘" goto="summary"
  panel #work_panel [fillxhug] tabs=["计时","偏好"]:
    :state timer
      column #timer_col [fillxhug] gap=8
        list-item #task_1 index=1 title="架构边界巡检" subtitle="已完成核心模块" rightBadge="完成" rightTone="success"
        button #btn_done [fillx44] "完成一轮"
          +onClick [{"type":"set-var","name":"doneCount","value":"=$doneCount + 1"}]
    :state prefs
      column #prefs_col [fillxhug] gap=8
        checkbox #chk_break [fillx44] "自动进入休息" checked=true
          +onClick [{"type":"set-var","name":"autoBreak","value":"=@chk_break.checked"}]
        select #sel_duration [fillx44] options=["25分钟","45分钟","60分钟"] selected="25分钟"
        listbox #lst_sound [fillx60] options=["白噪音","雨声"] selectedIndex=0
        textarea #txt_intent [fillx44] placeholder="写下本轮意图"
        button #btn_apply_dur [fillx44] "同步时长"
          +onClick [{"type":"set-var","name":"selectedDur","value":"=@sel_duration.selected"}]
  tab-bar #bottom_tabs items=[{"label":"工作台","active":true},{"label":"复盘","goto":"summary"}]
`;

    const builtHome = await studioHandlers.studio_command({
      projectDir: dir,
      baseRevision: addSummary.appliedRevision,
      idempotencyKey: 'build-home-rp1',
      pageId: 'home',
      parentId: 'home_screen',
      sourceMode: 'insert',
      rp1: rp1Home,
    });
    assert.equal(builtHome.ok, true, JSON.stringify(builtHome));

    const builtSummary = await studioHandlers.studio_command({
      projectDir: dir,
      baseRevision: builtHome.appliedRevision,
      idempotencyKey: 'build-summary-rp1',
      pageId: 'summary',
      parentId: 'summary_screen',
      sourceMode: 'insert',
      rp1: `
column #summary_body [fillxhug] gap=12
  nav-bar #sum_nav title="复盘" backText="← 返回" backGoto="home"
  card #container_card variant="outlined":
    label #cc_title "容器态卡片标题" fontSize=16 fontWeight=600
    paragraph #cc_desc "容器态 card 自动继承 column 布局、白底与圆角。" fontSize=14
`,
    });
    assert.equal(builtSummary.ok, true, JSON.stringify(builtSummary));

    // P2 #7: panel #work_panel: 冒号已被剥离，节点 ID 为干净的 work_panel
    const inspected = await studioHandlers.studio_inspect({
      projectDir: dir,
      view: 'context',
      includeScene: true,
      verbose: true,
    });
    const homeScene = inspected.scene.pages.find(p => p.id === 'home');
    const summaryScene = inspected.scene.pages.find(p => p.id === 'summary');
    const workPanel = homeScene.nodes.find(n => n.id === 'work_panel');
    assert.ok(workPanel, 'panel #work_panel: 应解析为 id=work_panel');

    // P0 #2: 容器态 card 自动具备 column 布局、非透明填充且子节点纵向排开不重叠
    const containerCard = summaryScene.nodes.find(n => n.id === 'container_card');
    const ccTitle = summaryScene.nodes.find(n => n.id === 'cc_title');
    const ccDesc = summaryScene.nodes.find(n => n.id === 'cc_desc');
    assert.equal(containerCard.layout, 'column');
    assert.equal(containerCard.fill, '#FFFFFF');
    assert.equal(containerCard.radius, 16);
    assert.ok(ccDesc.y > ccTitle.y + 16, `容器态 card 子节点应纵向流式排布: title.y=${ccTitle.y}, desc.y=${ccDesc.y}`);

    // P0 #1 附带问题 & P1 #6: progress-bar 外壳快照 text 为空而非 "[object Object]"，且默认 mobile-hifi + 全套内置宏 L1 阻塞数为 0
    const goalProg = homeScene.nodes.find(n => n.id === 'goal_prog');
    assert.equal(goalProg.text, '');
    const review = await studioHandlers.studio_design({
      projectDir: dir,
      action: 'review',
      pageId: 'home',
      baseRevision: builtSummary.appliedRevision,
    });
    assert.equal(review.ok, true);
    const nonEmptyStateBlocking = review.findings.filter(
      f => f.severity === 'error' && !(f.code === 'W_DESIGN_METRIC' && f.check === 'empty-state-coverage')
    );
    assert.deepEqual(nonEmptyStateBlocking, [], `内置宏默认参数不应产生对比度/热区/越界阻塞: ${JSON.stringify(nonEmptyStateBlocking)}`);

    // P1 #5: 非激活面板状态 (:state prefs) 内的 textarea (input.multiline) 在 review.nativeReadiness 中提前检出
    assert.equal(review.nativeReadiness.fullyNativeEditable, false);
    assert.ok(
      review.nativeReadiness.nonNativeItems.some(item => item.nodeId === 'txt_intent' && item.feature === 'input.multiline'),
      `nativeReadiness 应提前扫描非激活状态内的 txt_intent: ${JSON.stringify(review.nativeReadiness)}`
    );

    // P1 #3: studio_design(fix_plan) 在含 stat-row 虚拟子节点的页面上试跑成功，不报 E_NODE_NOT_FOUND
    const fixPlan = await studioHandlers.studio_design({
      projectDir: dir,
      action: 'fix_plan',
      pageId: 'home',
    });
    assert.equal(fixPlan.ok, true, JSON.stringify(fixPlan));
    assert.equal(fixPlan.verified, true);
    assert.ok(
      !fixPlan.commands.some(cmd => String(cmd.nodeId || '').startsWith('daily_stats_')),
      `fix_plan 不得向宏虚拟子节点发 setProperties: ${JSON.stringify(fixPlan.commands)}`
    );

    // P1 #4: studio_scenario(hitTest: true) 真实指针重放支持切态后操作 combobox、listbox、checkbox，支持 checked/selected/panelState 断言
    const hitScenario = await studioHandlers.studio_scenario({
      projectDir: dir,
      hitTest: true,
      steps: [
        {
          action: 'click',
          target: 'work_panel_timer_tab_1',
          expect: { panelState: { work_panel: 'prefs' }, checked: { chk_break: true } },
        },
        {
          action: 'click',
          target: 'chk_break',
          expect: { checked: { chk_break: false }, variables: { autoBreak: false } },
        },
        {
          action: 'input',
          target: 'sel_duration',
          value: '45分钟',
          expect: { selected: { sel_duration: '45分钟' }, text: { sel_duration: '45分钟' } },
        },
        {
          action: 'input',
          target: 'lst_sound',
          value: '雨声',
          expect: { selected: { lst_sound: '雨声' } },
        },
        {
          action: 'click',
          target: 'btn_apply_dur',
          expect: { variables: { selectedDur: '45分钟' } },
        },
      ],
    });
    assert.equal(hitScenario.ok, true, JSON.stringify(hitScenario));
    assert.equal(hitScenario.hitTest?.passed, true);

    // P1 #4 错误诊断：不存在的下拉选项在步骤 2 失败时，错误消息与 failedStep 精确指出步骤编号
    const badHitScenario = await studioHandlers.studio_scenario({
      projectDir: dir,
      hitTest: true,
      steps: [
        {
          action: 'click',
          target: 'work_panel_timer_tab_1',
          expect: { panelState: { work_panel: 'prefs' } },
        },
        {
          action: 'input',
          target: 'sel_duration',
          value: '999分钟',
          expect: { selected: { sel_duration: '999分钟' } },
        },
      ],
    });
    assert.equal(badHitScenario.ok, false);
    assert.match(badHitScenario.message || '', /步骤 2\/2/);
    assert.equal(badHitScenario.failedStep?.stepIndex, 2);
    assert.equal(badHitScenario.browserLayer?.failedStep?.stepIndex, 2);

    // P0 #1 & P2 #10: 含 progress-bar 与面板内交互的工程导出 .rp 成功，顶层返回 threeZerosPassed: true，interactionSources 含 contained-widget 且 matchesRpSummary: true
    const outRpPath = join(dir, 'cold-start-polished.rp');
    const exported = await studioHandlers.studio_export({
      projectDir: dir,
      format: 'rp',
      outRpPath,
    });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.threeZerosPassed, true);
    assert.equal(exported.report.threeZerosPassed, true);
    assert.equal(exported.report.interactionCounts.matchesRpSummary, true);
    assert.ok(
      exported.report.interactionSources.some(row => row.owner === 'contained-widget'),
      `interactionSources 应统计面板内部交互: ${JSON.stringify(exported.report.interactionCounts)}`
    );
  } finally {
    await closeInProcessStudioServer(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
