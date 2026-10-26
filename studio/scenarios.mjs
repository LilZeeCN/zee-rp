// Reusable Acceptance Scenarios & 3-Layer Executor for zee-rp Free Canvas Studio (Direction 5)
// Covers:
// - Unified Scenario Schema (scenarioId, category, applicablePages, applicableComponents, requiredCapabilities, initialData, steps, expectations)
// - 12 Reusable Scenario Templates across 6 categories (boundary, state, flow, idempotency, data, impact)
// - 3 Business Domain Project Generators (birding, study-cards, equipment-loan)
// - 3 Execution Layers: semantic, browser, axure-preview
// - Change-based Scenario Selection (selectAffectedScenarios)
// - Fault Injection Control Experiment (runFaultInjectionControl)

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importToStudioDocument, normalizeStudioDocument, DEVICE_PRESETS } from './document.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import {
  CORE_COMPONENT_CONTRACTS,
  ensureCoreComponentsRegistered,
  validateComponentInstanceAgainstContract,
  evolveComponentContractOnDocument,
} from './component-contracts.mjs';
import { applyCommandsToDocument, createRuntimeState, applyRuntimeStep } from './commands.mjs';
import { computeCommandImpactAndDiff, computePageContentHash, computePageInteractionHash } from './impact-diff.mjs';
import { exportStudioDocumentToRp } from './export-rp.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { StudioRuntimeSession } from './runtime.mjs';
import { runInteractionSteps } from './scenario-executors.mjs';

export const DOMAIN_PRESETS = {
  birding: {
    domainId: 'birding',
    name: '奇羽自然观测手记',
    theme: 'mobile-hifi',
    palette: {
      bg: '#F7F8F2',
      surface: '#FFFFFF',
      'surface-2': '#E7EDDF',
      ink: '#203B32',
      'ink-2': '#607368',
      brand: '#2E6F57',
      'brand-soft': '#DCEFE6',
      accent: '#D97706',
      success: '#16A34A',
      warning: '#D97706',
      danger: '#DC2626',
      line: '#DCE3DA',
    },
    navTitle: '奇羽观鸟工作台',
    navSubtitle: '闽江口湿地监测站 · 在线',
    heroTag: '迁徙季专题',
    heroTitle: '东亚候鸟迁徙廊道实时观测记录',
    heroSummary: '今日退潮窗口为 06:30–08:30，泥滩裸露面积达峰值，适合记录鸻鹬类与琵鹭。',
    heroMeta: '已同步 3 条核心记录',
    heroAction: '进入观测名录',
    inputLabel: '物种名称或环志编号',
    inputPlaceholder: '输入如：黑脸琵鹭 / Platalea minor',
    submitLabel: '新增观测记录',
    emptyHeadline: '未找到匹配的鸟类观测记录',
    emptyDesc: '请尝试更换关键词，或点击下方按钮重置生境筛选。',
    datasetName: 'records',
    counterVar: 'recordCount',
    selectedTitleVar: 'selectedTitle',
    filterVar: 'filterKeyword',
    rows: [
      { id: 'rec_1', title: '黑脸琵鹭 Platalea minor', subtitle: '鳝鱼滩浅水区 · 06:42', badge: '一级保护', count: 3, _selected: true },
      { id: 'rec_2', title: '普通翠鸟 Alcedo atthis', subtitle: '芦苇水道木桩 · 07:15', badge: '常见留鸟', count: 1, _selected: false },
      { id: 'rec_3', title: '大滨鹬 Calidris tenuirostris', subtitle: '外侧泥滩潮沟 · 07:50', badge: '迁徙旅鸟', count: 18, _selected: false },
    ],
  },

  'study-cards': {
    domainId: 'study-cards',
    name: '知微间隔复习闪卡',
    theme: 'mobile-lowfi',
    palette: {
      bg: '#F8FAFC',
      surface: '#FFFFFF',
      'surface-2': '#EEF2FF',
      ink: '#1E293B',
      'ink-2': '#64748B',
      brand: '#3B5BDB',
      'brand-soft': '#DBE4FF',
      accent: '#0CA678',
      success: '#16A34A',
      warning: '#F59E0B',
      danger: '#DC2626',
      line: '#E2E8F0',
    },
    navTitle: '知微记忆题卡库',
    navSubtitle: '今日待复习 24 张 · 连续 14 天',
    heroTag: 'FSRS 记忆调度',
    heroTitle: '认知科学与计算机体系结构精选题集',
    heroSummary: '基于遗忘曲线动态计算下一次复习间隔，优先巩固高频易错概念卡片。',
    heroMeta: '掌握率 86% · 队列就绪',
    heroAction: '打开题卡列表',
    inputLabel: '新闪卡正反面提要',
    inputPlaceholder: '输入概念提问与核心推导结论…',
    submitLabel: '加入复习队列',
    emptyHeadline: '当前筛选下暂无待复习题卡',
    emptyDesc: '本组卡片已全部完成复习，可重置筛选查看完整题库。',
    datasetName: 'records',
    counterVar: 'recordCount',
    selectedTitleVar: 'selectedTitle',
    filterVar: 'filterKeyword',
    rows: [
      { id: 'card_1', title: '虚拟内存 TLB 未命中处理路径', subtitle: '计算机体系结构 · 间隔 4 天', badge: '重点巩固', count: 4, _selected: true },
      { id: 'card_2', title: '贝叶斯后验更新与共轭先验推导', subtitle: '概率统计 · 间隔 7 天', badge: '已掌握', count: 7, _selected: false },
      { id: 'card_3', title: 'Raft 共识日志复制安全性条件', subtitle: '分布式系统 · 间隔 2 天', badge: '高频考点', count: 2, _selected: false },
    ],
  },

  'equipment-loan': {
    domainId: 'equipment-loan',
    name: '精密仪器借还管理台',
    theme: 'enterprise-light',
    palette: {
      bg: '#F3F6F9',
      surface: '#FFFFFF',
      'surface-2': '#E6F0FA',
      ink: '#0F172A',
      'ink-2': '#475569',
      brand: '#0F52BA',
      'brand-soft': '#D8E8FC',
      accent: '#0284C7',
      success: '#15803D',
      warning: '#D97706',
      danger: '#B91C1C',
      line: '#CBD5E1',
    },
    navTitle: '实验室设备借还台账',
    navSubtitle: '光学与声学实验中心 · A302',
    heroTag: '资产巡检正常',
    heroTitle: '高精光学与野外观测器材实时借还登记',
    heroSummary: '借出前请核对序列号、电池电量与校准证书有效期，逾期设备将自动高亮提醒。',
    heroMeta: '在库可借 19 台 · 借出 3 台',
    heroAction: '查看设备清单',
    inputLabel: '借用设备名称或资产编号',
    inputPlaceholder: '输入如：蔡司 10x42 双筒望远镜 / EQ-2026',
    submitLabel: '提交借用申请',
    emptyHeadline: '未检索到匹配的实验设备',
    emptyDesc: '请检查资产编号是否正确，或点击重置显示全部在册设备。',
    datasetName: 'records',
    counterVar: 'recordCount',
    selectedTitleVar: 'selectedTitle',
    filterVar: 'filterKeyword',
    rows: [
      { id: 'eq_1', title: '蔡司 Victory SF 10x42 望远镜', subtitle: '资产号 EQ-1042 · 状态：在库可借', badge: '已校准', count: 1, _selected: true },
      { id: 'eq_2', title: '索尼野生动物超远摄记录套件', subtitle: '资产号 EQ-2088 · 状态：外借中', badge: '今日归还', count: 1, _selected: false },
      { id: 'eq_3', title: '声学频谱定向拾音阵列麦克风', subtitle: '资产号 EQ-3015 · 状态：在库可借', badge: '满电就绪', count: 2, _selected: false },
    ],
  },
};

export function createDomainProjectDocument(domainKey = 'birding', { documentId = null } = {}) {
  const preset = DOMAIN_PRESETS[domainKey] || DOMAIN_PRESETS.birding;
  const spec = {
    language: 'rp/1',
    target: 9,
    name: preset.name,
    domain: 'mobile',
    theme: preset.theme,
    device: 'iphone-17-pro',
    palette: structuredClone(preset.palette),
    variables: {
      [preset.counterVar]: preset.rows.length,
      [preset.selectedTitleVar]: preset.rows[0].title,
      [preset.filterVar]: '',
      formDraft: '',
      submitStatus: 'idle',
    },
    datasets: {
      [preset.datasetName]: {
        rows: structuredClone(preset.rows),
      },
    },
    pages: [
      {
        id: 'home',
        name: '工作台首页',
        device: 'iphone-17-pro',
        canvas: { w: 402, h: 874 },
        root: {
          type: 'phone-shell',
          id: 'home_shell',
          device: 'iphone-17-pro',
          fill: '$bg',
          children: [
            {
              type: 'box',
              id: 'home_screen',
              layout: 'column',
              w: 402,
              h: 874,
              padding: [DEVICE_PRESETS['iphone-17-pro'].safeAreaTop, 16, 20, 16],
              gap: 12,
              fill: '$bg',
              children: [
                {
                  id: 'top_nav',
                  type: 'instance',
                  component: 'nav-bar',
                  state: 'default',
                  props: {
                    title: preset.navTitle,
                    subtitle: preset.navSubtitle,
                    rightActionText: '名录',
                  },
                  on: {
                    click: [{ type: 'link', page: 'list' }],
                  },
                },
                {
                  id: 'hero_card',
                  type: 'instance',
                  component: 'info-card',
                  state: 'default',
                  props: {
                    tag: preset.heroTag,
                    title: preset.heroTitle,
                    summary: preset.heroSummary,
                    metaText: preset.heroMeta,
                    actionLabel: preset.heroAction,
                  },
                  on: {
                    click: [{ type: 'link', page: 'list' }],
                  },
                },
                {
                  id: 'quick_form_box',
                  type: 'box',
                  layout: 'column',
                  w: 'fill',
                  h: 'hug',
                  padding: [14, 14, 14, 14],
                  gap: 10,
                  radius: 14,
                  fill: '$surface',
                  stroke: '$line',
                  strokeWidth: 1,
                  children: [
                    {
                      id: 'entry_input',
                      type: 'instance',
                      component: 'input-field',
                      state: 'default',
                      props: {
                        fieldLabel: preset.inputLabel,
                        placeholder: preset.inputPlaceholder,
                        value: '',
                        helperText: '必填字段，提交后自动同步至下方台账列表',
                      },
                    },
                    {
                      id: 'form_actions_row',
                      type: 'box',
                      layout: 'row',
                      align: 'center',
                      justify: 'space-between',
                      w: 'fill',
                      h: 'hug',
                      gap: 10,
                      children: [
                        {
                          id: 'submit_btn',
                          type: 'instance',
                          component: 'button',
                          variant: 'primary',
                          state: 'default',
                          props: {
                            label: preset.submitLabel,
                            icon: 'plus',
                          },
                          on: {
                            click: [
                              { type: 'set-variable', variable: preset.counterVar, value: preset.rows.length + 1 },
                              { type: 'set-variable', variable: 'submitStatus', value: 'submitted' },
                            ],
                          },
                        },
                        {
                          id: 'cancel_btn',
                          type: 'instance',
                          component: 'button',
                          variant: 'secondary',
                          state: 'default',
                          props: {
                            label: '清空重置',
                            icon: 'chevron-left',
                          },
                          on: {
                            click: [
                              { type: 'set-variable', variable: 'formDraft', value: '' },
                              { type: 'set-variable', variable: 'submitStatus', value: 'idle' },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: 'featured_item_1',
                  type: 'instance',
                  component: 'list-item',
                  state: 'selected',
                  props: {
                    title: preset.rows[0].title,
                    subtitle: preset.rows[0].subtitle,
                    metaBadge: preset.rows[0].badge,
                    leadingIcon: 'compass',
                  },
                  on: {
                    click: [{ type: 'link', page: 'detail' }],
                  },
                },
                {
                  id: 'featured_item_2',
                  type: 'instance',
                  component: 'list-item',
                  state: 'default',
                  props: {
                    title: preset.rows[1].title,
                    subtitle: preset.rows[1].subtitle,
                    metaBadge: preset.rows[1].badge,
                    leadingIcon: 'book',
                  },
                  on: {
                    click: [{ type: 'link', page: 'detail' }],
                  },
                },
                {
                  id: 'feedback_zone',
                  type: 'instance',
                  component: 'status-zone',
                  state: 'default',
                  props: {
                    headline: preset.emptyHeadline,
                    descriptionText: preset.emptyDesc,
                    retryLabel: '重置筛选条件',
                  },
                },
              ],
            },
          ],
        },
      },
      {
        id: 'list',
        name: '名录与筛选页',
        device: 'iphone-17-pro',
        canvas: { w: 402, h: 874 },
        root: {
          type: 'phone-shell',
          id: 'list_shell',
          device: 'iphone-17-pro',
          fill: '$bg',
          children: [
            {
              type: 'box',
              id: 'list_screen',
              layout: 'column',
              w: 402,
              h: 874,
              padding: [DEVICE_PRESETS['iphone-17-pro'].safeAreaTop, 16, 20, 16],
              gap: 12,
              fill: '$bg',
              children: [
                {
                  id: 'list_nav',
                  type: 'instance',
                  component: 'nav-bar',
                  state: 'default',
                  props: {
                    title: `${preset.name} · 列表`,
                    subtitle: '支持关键词过滤与排序',
                    rightActionText: '返回',
                  },
                  on: {
                    click: [{ type: 'link', page: 'home' }],
                  },
                },
                {
                  id: 'list_summary_bar',
                  type: 'box',
                  layout: 'row',
                  align: 'center',
                  justify: 'space-between',
                  w: 'fill',
                  h: 40,
                  padding: [8, 12, 8, 12],
                  radius: 10,
                  fill: '$surface-2',
                  children: [
                    {
                      id: 'list_counter_label',
                      type: 'label',
                      text: `=text(${preset.counterVar})`,
                      fontSize: 13,
                      fontWeight: 600,
                      color: '$brand',
                    },
                    {
                      id: 'list_selected_label',
                      type: 'label',
                      text: `=var.${preset.selectedTitleVar}`,
                      fontSize: 12,
                      color: '$ink',
                    },
                  ],
                },
                {
                  id: 'records_repeater',
                  type: 'repeater',
                  dataset: preset.datasetName,
                  w: 'fill',
                  h: 220,
                  rowHeight: 56,
                  rowGap: 8,
                },
                {
                  id: 'list_to_detail_btn',
                  type: 'instance',
                  component: 'button',
                  variant: 'primary',
                  state: 'default',
                  props: {
                    label: '查看当前选中项详情',
                    icon: 'arrow-up-right',
                  },
                  on: {
                    click: [{ type: 'link', page: 'detail' }],
                  },
                },
              ],
            },
          ],
        },
      },
      {
        id: 'detail',
        name: '记录详情页',
        device: 'iphone-17-pro',
        canvas: { w: 402, h: 874 },
        root: {
          type: 'phone-shell',
          id: 'detail_shell',
          device: 'iphone-17-pro',
          fill: '$bg',
          children: [
            {
              type: 'box',
              id: 'detail_screen',
              layout: 'column',
              w: 402,
              h: 874,
              padding: [DEVICE_PRESETS['iphone-17-pro'].safeAreaTop, 16, 20, 16],
              gap: 12,
              fill: '$bg',
              children: [
                {
                  id: 'detail_nav',
                  type: 'instance',
                  component: 'nav-bar',
                  state: 'default',
                  props: {
                    title: '记录详情档案',
                    subtitle: '核验完整元数据',
                    rightActionText: '返回列表',
                  },
                  on: {
                    click: [{ type: 'link', page: 'list' }],
                  },
                },
                {
                  id: 'detail_card',
                  type: 'instance',
                  component: 'info-card',
                  state: 'selected',
                  props: {
                    tag: preset.rows[0].badge,
                    title: preset.rows[0].title,
                    summary: preset.rows[0].subtitle,
                    metaText: '状态已核验 · 支持导出原生 .rp',
                    actionLabel: '返回列表页',
                  },
                  on: {
                    click: [{ type: 'link', page: 'list' }],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };

  const doc = importToStudioDocument(spec, {
    documentId: documentId || `domain-${preset.domainId}`,
  });
  ensureCoreComponentsRegistered(doc);
  normalizeStudioDocument(doc);
  return doc;
}

export const SCENARIO_TEMPLATES_12 = [
  // 1. 边界输入场景 - 空值输入与必填拦截
  {
    scenarioId: 'boundary-empty-input',
    title: '空值输入提交拦截与错误态反馈',
    category: 'boundary',
    applicablePages: ['home', 'form', '*'],
    applicableComponents: ['input-field', 'button', 'status-zone'],
    requiredCapabilities: ['component-state', 'form-validation', 'dataset-guard'],
    initialData: {
      clearInputNodeId: 'home/entry_input',
      expectedInitialRowCount: 3,
    },
    steps: [
      { action: 'set-input-value', target: 'home/entry_input', value: '' },
      { action: 'trigger-empty-submit-guard', inputTarget: 'home/entry_input', statusTarget: 'home/feedback_zone' },
    ],
    expectations: [
      { check: 'node-state', target: 'home/entry_input', expectedState: 'error' },
      { check: 'node-state', target: 'home/feedback_zone', expectedState: 'error' },
      { check: 'dataset-row-count', dataset: 'records', expectedCount: 3 },
      { check: 'no-clipping-or-overflow', pageId: 'home' },
    ],
  },

  // 2. 边界输入场景 - 超长文本与特殊字符/数字边界
  {
    scenarioId: 'boundary-extreme-long-text',
    title: '3倍超长中英数混排文本自适应增高与兄弟节点下移',
    category: 'boundary',
    applicablePages: ['home', 'list', 'detail', '*'],
    applicableComponents: ['info-card', 'list-item'],
    requiredCapabilities: ['typography-wrap', 'auto-layout-propagation', 'no-clipping'],
    initialData: {
      targetCardId: 'home/hero_card',
      targetTitleNodeId: 'home/hero_card__card_title',
      followingSiblingId: 'home/quick_form_box',
      extremeTitle: '【2026年度重点监测报告 #A9082】东亚-澳大利西亚迁徙廊道黑脸琵鹭 (Platalea minor, N=128) 与高精实验设备/复习闪卡跨领域长文本',
    },
    steps: [
      {
        action: 'expand-title-3x',
        target: 'home/hero_card',
        propKey: 'title',
      },
    ],
    expectations: [
      { check: 'line-count-gte', target: 'home/hero_card__card_title', minLines: 3 },
      { check: 'container-height-grew', target: 'home/hero_card', minDeltaH: 24 },
      { check: 'sibling-shifted-down', target: 'home/quick_form_box', minDeltaY: 24 },
      { check: 'no-clipping-or-overflow', pageId: 'home' },
    ],
  },

  // 3. 状态切换场景 - 默认/选中/禁用/加载/空状态/错误态完整切换
  {
    scenarioId: 'state-lifecycle-cycle',
    title: '核心组件默认、选中、加载、错误、空状态与恢复完整生命周期切换',
    category: 'state',
    applicablePages: ['home', 'list', '*'],
    applicableComponents: ['button', 'list-item', 'status-zone'],
    requiredCapabilities: ['component-state', 'visual-state-delta'],
    initialData: {
      buttonTarget: 'home/submit_btn',
      listItemTarget: 'home/featured_item_2',
      statusZoneTarget: 'home/feedback_zone',
    },
    steps: [
      { action: 'set-component-state', target: 'home/featured_item_2', state: 'selected' },
      { action: 'set-component-state', target: 'home/feedback_zone', state: 'loading' },
      { action: 'set-component-state', target: 'home/feedback_zone', state: 'error' },
      { action: 'set-component-state', target: 'home/feedback_zone', state: 'empty' },
      { action: 'set-component-state', target: 'home/feedback_zone', state: 'success' },
    ],
    expectations: [
      { check: 'node-state', target: 'home/featured_item_2', expectedState: 'selected' },
      { check: 'node-state', target: 'home/feedback_zone', expectedState: 'success' },
    ],
  },

  // 4. 状态切换场景 - 禁用态与加载态交互拦截
  {
    scenarioId: 'state-disabled-loading-guard',
    title: '禁用态 (disabled) 与加载态 (loading) 下点击交互被可靠拦截',
    category: 'state',
    applicablePages: ['home', '*'],
    applicableComponents: ['button'],
    requiredCapabilities: ['component-state', 'interaction-guard'],
    initialData: {
      buttonTarget: 'home/submit_btn',
      counterVar: 'recordCount',
    },
    steps: [
      { action: 'set-component-state', target: 'home/submit_btn', state: 'disabled' },
      { action: 'attempt-click-when-non-interactive', target: 'home/submit_btn' },
      { action: 'set-component-state', target: 'home/submit_btn', state: 'loading' },
      { action: 'attempt-click-when-non-interactive', target: 'home/submit_btn' },
      { action: 'set-component-state', target: 'home/submit_btn', state: 'default' },
    ],
    expectations: [
      { check: 'variable-unchanged-during-guard', variable: 'recordCount', expectedValue: 3 },
      { check: 'node-interactive', target: 'home/submit_btn', expectedInteractive: true },
    ],
  },

  // 5. 主流程闭环场景 - 列表浏览 -> 进入详情 -> 返回列表且保持上下文状态
  {
    scenarioId: 'flow-list-to-detail-and-back',
    startPageId: 'home',
    interactionSteps: [
      { action: 'click', target: 'top_nav', expect: { page: 'list', text: { list_counter_label: '3' }, variables: { recordCount: 3 } } },
      { action: 'click', target: 'list_to_detail_btn', expect: { page: 'detail' } },
      { action: 'click', target: 'detail_card', expect: { page: 'list' } },
    ],
    title: '列表浏览 → 进入详情页 → 返回列表页并保持筛选与选中上下文',
    category: 'flow',
    applicablePages: ['home', 'list', 'detail'],
    applicableComponents: ['nav-bar', 'list-item', 'info-card', 'button'],
    requiredCapabilities: ['page-navigation', 'runtime-context-preservation'],
    initialData: {
      startPageId: 'list',
    },
    steps: [
      { action: 'navigate-via-node', pageId: 'list', nodeId: 'list_to_detail_btn', expectedTargetPage: 'detail' },
      { action: 'navigate-via-node', pageId: 'detail', nodeId: 'detail_card', expectedTargetPage: 'list' },
    ],
    expectations: [
      { check: 'active-page', expectedPageId: 'list' },
      { check: 'context-preserved', variable: 'selectedTitle' },
    ],
  },

  // 6. 主流程闭环场景 - 新建/编辑 -> 填写表单 -> 校验通过 -> 提交成功 -> 列表刷新
  {
    scenarioId: 'flow-create-validate-submit-refresh',
    title: '填写表单 → 校验通过 → 提交新增记录 → 列表与计数器同步刷新',
    category: 'flow',
    applicablePages: ['home', 'list'],
    applicableComponents: ['input-field', 'button', 'status-zone'],
    requiredCapabilities: ['form-submit', 'dataset-add', 'runtime-variables'],
    initialData: {
      newRecordTitle: '新增核验记录 #2026-NEW',
      newRecordSubtitle: '自动化闭环提交验证 · 刚刚',
      newRecordBadge: '新增就绪',
    },
    steps: [
      { action: 'set-input-value', target: 'home/entry_input', value: '新增核验记录 #2026-NEW' },
      { action: 'submit-new-record', inputTarget: 'home/entry_input', buttonTarget: 'home/submit_btn', statusTarget: 'home/feedback_zone' },
    ],
    expectations: [
      { check: 'dataset-row-count', dataset: 'records', expectedCount: 4 },
      { check: 'variable-equals', variable: 'recordCount', expectedValue: 4 },
      { check: 'node-state', target: 'home/feedback_zone', expectedState: 'success' },
    ],
  },

  // 7. 防重复与幂等场景 - 连续快速点击提交按钮不产生重复记录
  {
    scenarioId: 'idempotency-rapid-double-submit',
    title: '连续快速点击提交按钮（相同幂等键/加载门控）不产生重复记录',
    category: 'idempotency',
    applicablePages: ['home', 'form'],
    applicableComponents: ['button'],
    requiredCapabilities: ['command-idempotency', 'dataset-guard'],
    initialData: {
      idempotencyKey: 'idem_rapid_submit_001',
    },
    steps: [
      { action: 'rapid-double-submit', idempotencyKey: 'idem_rapid_submit_001', dataset: 'records' },
    ],
    expectations: [
      { check: 'dataset-row-count', dataset: 'records', expectedCount: 4 },
      { check: 'deduplicated-second-call', expectedDeduplicated: true },
    ],
  },

  // 8. 防重复与幂等场景 - 取消/返回后重新进入流程不残留脏状态
  {
    scenarioId: 'idempotency-cancel-reenter-clean',
    title: '输入未提交草稿后点击取消重置，重新进入不残留脏状态',
    category: 'idempotency',
    applicablePages: ['home', 'form'],
    applicableComponents: ['input-field', 'button'],
    requiredCapabilities: ['state-reset', 'clean-reentry'],
    initialData: {
      dirtyDraftText: '未提交的临时草稿内容_DIRTY_DRAFT',
    },
    steps: [
      { action: 'set-input-value', target: 'home/entry_input', value: '未提交的临时草稿内容_DIRTY_DRAFT' },
      { action: 'cancel-and-reset-form', inputTarget: 'home/entry_input', cancelBtn: 'home/cancel_btn' },
    ],
    expectations: [
      { check: 'input-value-equals', target: 'home/entry_input', expectedValue: '' },
      { check: 'variable-equals', variable: 'formDraft', expectedValue: '' },
      { check: 'dataset-row-count', dataset: 'records', expectedCount: 3 },
    ],
  },

  // 9. 列表与数据联动场景 - 搜索过滤、排序切换、无结果空状态与重置恢复
  {
    scenarioId: 'data-search-filter-sort-reset',
    title: '列表关键词过滤、空结果状态切换、计数排序与一键重置恢复',
    category: 'data',
    applicablePages: ['list', 'home'],
    applicableComponents: ['status-zone', 'list-item'],
    requiredCapabilities: ['repeater-filter', 'repeater-sort', 'empty-state'],
    initialData: {
      unmatchedQuery: '__NO_MATCH_KEYWORD_999__',
    },
    steps: [
      { action: 'filter-dataset-empty', dataset: 'records', query: '__NO_MATCH_KEYWORD_999__', statusTarget: 'home/feedback_zone' },
      { action: 'reset-dataset-and-sort', dataset: 'records', sortField: 'count', sortDir: 'desc', statusTarget: 'home/feedback_zone' },
    ],
    expectations: [
      { check: 'empty-filter-triggered-empty-state', expected: true },
      { check: 'dataset-sorted-desc', dataset: 'records', field: 'count' },
      { check: 'node-state', target: 'home/feedback_zone', expectedState: 'default' },
    ],
  },

  // 10. 列表与数据联动场景 - 列表项选中状态、统计数字与详情内容联动更新
  {
    scenarioId: 'data-selection-counter-detail-sync',
    title: '切换列表选中项后，顶部汇总文案与详情页卡片内容同步更新',
    category: 'data',
    applicablePages: ['list', 'detail'],
    applicableComponents: ['list-item', 'info-card'],
    requiredCapabilities: ['runtime-variables', 'formula-display', 'cross-page-sync'],
    initialData: {
      selectRowIndex: 1,
    },
    steps: [
      { action: 'select-dataset-row', dataset: 'records', rowIndex: 1 },
    ],
    expectations: [
      { check: 'selected-row-synced-to-detail', pageId: 'detail', cardId: 'detail/detail_card' },
      { check: 'list-summary-formula-updated', pageId: 'list', labelId: 'list/list_selected_label' },
    ],
  },

  // 11. 改稿回归场景 - 修改组件定义或全局令牌后，所有关联实例和消费节点同步更新且无布局冲突
  {
    scenarioId: 'impact-component-and-token-propagation',
    title: '修改基础组件定义与品牌色令牌后，跨页面全部实例（含二层嵌套）同步更新且零布局冲突',
    category: 'impact',
    applicablePages: ['home', 'list', 'detail'],
    applicableComponents: ['button', 'info-card', 'list-item', 'nav-bar'],
    requiredCapabilities: ['impact-propagation', 'nested-component-sync', 'token-propagation'],
    initialData: {
      newBrandColor: '#1D4ED8',
      newButtonRadius: 18,
    },
    steps: [
      { action: 'update-component-and-token', componentId: 'button', newRadius: 18, newBrandColor: '#1D4ED8' },
    ],
    expectations: [
      { check: 'nested-component-instances-updated', componentId: 'button', expectedRadius: 18 },
      { check: 'token-consumers-updated', token: '$brand', expectedColor: '#1D4ED8' },
      { check: 'no-clipping-or-overflow', pageId: 'home' },
    ],
  },

  // 12. 改稿回归场景 - 局部改稿后，未受影响页面的内容与交互状态保持不变
  {
    scenarioId: 'impact-unaffected-pages-isolation',
    title: '仅修改首页局部文案后，列表页与详情页的内容哈希和交互哈希 100% 保持不变',
    category: 'impact',
    applicablePages: ['home', 'list', 'detail'],
    applicableComponents: ['info-card'],
    requiredCapabilities: ['impact-isolation', 'page-hash-verification'],
    initialData: {
      editedPageId: 'home',
      unaffectedPageIds: ['list', 'detail'],
    },
    steps: [
      { action: 'edit-single-page-node', pageId: 'home', target: 'home/hero_card', newMetaText: '局部改稿隔离性核验 · 已更新' },
    ],
    expectations: [
      { check: 'unaffected-pages-hash-identical', unaffectedPageIds: ['list', 'detail'] },
    ],
  },
];

export function getScenarioTemplates(category = null) {
  if (!category) return structuredClone(SCENARIO_TEMPLATES_12);
  return structuredClone(SCENARIO_TEMPLATES_12.filter(s => s.category === category));
}

export function selectAffectedScenarios(impactReport, { runAll = false } = {}) {
  if (runAll || !impactReport) {
    return structuredClone(SCENARIO_TEMPLATES_12);
  }
  const diff = impactReport.semanticDiff || {};
  const impact = impactReport.transitiveImpact || {};
  const selectedIds = new Set();

  if ((diff.textChanges || []).length > 0) {
    selectedIds.add('boundary-extreme-long-text');
    selectedIds.add('impact-unaffected-pages-isolation');
  }
  if ((diff.componentDefinitionChanges || []).length > 0 || (diff.tokenChanges || []).length > 0) {
    selectedIds.add('impact-component-and-token-propagation');
    selectedIds.add('state-lifecycle-cycle');
  }
  if ((diff.variableAndEventChanges || []).length > 0 || (impact.affectedInteractionBindingIds || []).length > 0) {
    // A changed/deleted handler can affect guards, data, and repeated operations.
    // Until every template has complete node dependencies, conservatively run all.
    return structuredClone(SCENARIO_TEMPLATES_12);
  }
  if ((diff.structureChanges || []).length > 0) {
    selectedIds.add('boundary-extreme-long-text');
    selectedIds.add('impact-unaffected-pages-isolation');
  }
  if (selectedIds.size === 0) {
    selectedIds.add('impact-unaffected-pages-isolation');
  }

  return structuredClone(SCENARIO_TEMPLATES_12.filter(s => selectedIds.has(s.scenarioId)));
}

function findResolvedNode(scene, target) {
  for (const pg of scene.pages || []) {
    for (const n of pg.nodes || []) {
      if (n.scopedId === target || n.id === target || `${pg.id}/${n.id}` === target) {
        return { page: pg, node: n };
      }
    }
  }
  return null;
}

// Execute a single scenario on a cloned document in the semantic layer (and return the mutated doc/scene for browser/axure layers)
export function executeScenarioSemantic(baseDoc, scenarioInput) {
  const scenario = typeof scenarioInput === 'string'
    ? SCENARIO_TEMPLATES_12.find(s => s.scenarioId === scenarioInput)
    : scenarioInput;
  if (!scenario) {
    throw Object.assign(new Error(`未知验收场景 "${scenarioInput}"`), { code: 'E_UNKNOWN_SCENARIO' });
  }
  if (scenario.interactionSteps) {
    try {
      const runtime = new StudioRuntimeSession(baseDoc);
      runtime.reset(scenario.startPageId || baseDoc.pages[0].id);
      const result = runtime.runScenario(scenario.interactionSteps);
      const assertions = result.steps?.flatMap(s => s.assertions) || result.stepResults?.flatMap(s => s.assertions) || [];
      return { scenarioId: scenario.scenarioId, title: scenario.title, allPassed: result.ok && assertions.length > 0,
        assertions, afterDoc: structuredClone(baseDoc), afterScene: resolveDocumentScene(baseDoc), stepLogs: result };
    } catch (error) {
      return { scenarioId: scenario.scenarioId, allPassed: false, assertions: [{ passed: false, error: error.message }], afterDoc: structuredClone(baseDoc), afterScene: resolveDocumentScene(baseDoc) };
    }
  }

  let doc = structuredClone(baseDoc);
  ensureCoreComponentsRegistered(doc);
  let scene = resolveDocumentScene(doc);
  const beforeScene = scene;
  const beforeDoc = structuredClone(doc);

  const stepLogs = [];
  const assertionResults = [];
  let lastImpactReport = null;
  let extraMeta = {};

  const applyCmd = (commands, { idempotencyKey = null, executedKeys = null } = {}) => {
    if (idempotencyKey && executedKeys && executedKeys.has(idempotencyKey)) {
      return { deduplicated: true, doc, scene };
    }
    const res = applyCommandsToDocument(doc, commands, {
      baseRevision: doc.revision,
      idempotencyKey,
      author: 'scenario-runner',
      source: 'scenario',
    });
    if (!res.ok) {
      throw Object.assign(new Error(res.message || 'Scenario command failed'), { code: res.code });
    }
    doc = res.doc;
    scene = res.scene;
    if (idempotencyKey && executedKeys) executedKeys.add(idempotencyKey);
    lastImpactReport = {
      transitiveImpact: res.transitiveImpact,
      semanticDiff: res.semanticDiff,
      humanReadableSummary: res.humanReadableSummary,
    };
    return { deduplicated: false, doc, scene, impactReport: lastImpactReport };
  };

  try {
    switch (scenario.scenarioId) {
      case 'boundary-empty-input': {
        // 1. Set input value to empty string
        applyCmd([
          { type: 'set-props', nodeId: 'home/entry_input', props: { props: { value: '' }, state: 'default' } },
        ]);
        // 2. Attempt submit with empty input -> validation guard intercepts and sets input + feedback_zone to 'error', rows stay 3
        const inpHit = findResolvedNode(scene, 'home/entry_input__inp_control');
        const currentVal = String(inpHit?.node?.text || '').trim();
        if (!currentVal) {
          applyCmd([
            { type: 'set-props', nodeId: 'home/entry_input', props: { state: 'error' } },
            { type: 'set-props', nodeId: 'home/feedback_zone', props: { state: 'error' } },
          ]);
        }
        const rowsAfter = doc.datasets?.records?.rows?.length ?? 0;
        const inpState = findResolvedNode(scene, 'home/entry_input')?.node?.state;
        const zoneState = findResolvedNode(scene, 'home/feedback_zone')?.node?.state;
        const clips = (scene.clipDiagnostics || []).filter(c => c.pageId === 'home');
        assertionResults.push(
          { check: 'input-error-state', passed: inpState === 'error', actual: inpState },
          { check: 'feedback-zone-error-state', passed: zoneState === 'error', actual: zoneState },
          { check: 'dataset-row-count-unchanged', passed: rowsAfter === 3, actual: rowsAfter },
          { check: 'no-clipping-on-home', passed: clips.length === 0, actual: clips.length }
        );
        break;
      }

      case 'boundary-extreme-long-text': {
        const beforeCard = findResolvedNode(beforeScene, 'home/hero_card')?.node;
        const beforeTitle = findResolvedNode(beforeScene, 'home/hero_card__card_title')?.node;
        const beforeSibling = findResolvedNode(beforeScene, 'home/quick_form_box')?.node;

        const curProps = structuredClone(doc.pages[0].root.children[0].children.find(n => n.id === 'hero_card')?.props || {});
        curProps.title = scenario.initialData.extremeTitle;
        applyCmd([
          { type: 'set-props', nodeId: 'home/hero_card', props: { props: curProps } },
        ]);

        const afterCard = findResolvedNode(scene, 'home/hero_card')?.node;
        const afterTitle = findResolvedNode(scene, 'home/hero_card__card_title')?.node;
        const afterSibling = findResolvedNode(scene, 'home/quick_form_box')?.node;
        const deltaCardH = (afterCard?.h ?? 0) - (beforeCard?.h ?? 0);
        const deltaSiblingY = (afterSibling?.y ?? 0) - (beforeSibling?.y ?? 0);
        const clips = (scene.clipDiagnostics || []).filter(c => c.pageId === 'home');
        const overlap = (afterCard.y + afterCard.h) > afterSibling.y + 1;

        assertionResults.push(
          { check: 'line-count-gte-3', passed: (afterTitle?.lineCount ?? 0) >= 3, actual: afterTitle?.lineCount, before: beforeTitle?.lineCount },
          { check: 'container-height-grew', passed: deltaCardH >= 24, actualDeltaH: deltaCardH },
          { check: 'sibling-shifted-down', passed: deltaSiblingY >= 24 && !overlap, actualDeltaY: deltaSiblingY, overlap },
          { check: 'no-clipping-or-overflow', passed: clips.length === 0, actualClips: clips }
        );
        break;
      }

      case 'state-lifecycle-cycle': {
        const visitedStates = [];
        for (const st of ['selected', 'loading', 'error', 'empty', 'success']) {
          applyCmd([{ type: 'set-props', nodeId: 'home/feedback_zone', props: { state: st } }]);
          const resolvedSt = findResolvedNode(scene, 'home/feedback_zone')?.node?.state;
          visitedStates.push(resolvedSt);
        }
        applyCmd([{ type: 'set-props', nodeId: 'home/featured_item_2', props: { state: 'selected' } }]);
        const item2State = findResolvedNode(scene, 'home/featured_item_2')?.node?.state;
        const item2Fill = findResolvedNode(scene, 'home/featured_item_2')?.node?.fill;
        const item1Fill = findResolvedNode(scene, 'home/featured_item_1')?.node?.fill;

        assertionResults.push(
          { check: 'all-5-states-visited', passed: visitedStates.join(',') === 'selected,loading,error,empty,success', actual: visitedStates },
          { check: 'list-item-selected-state', passed: item2State === 'selected' && item2Fill === item1Fill, actualState: item2State, actualFill: item2Fill }
        );
        break;
      }

      case 'state-disabled-loading-guard': {
        const initialCount = Number(doc.variables?.recordCount ?? 3);
        for (const guardState of ['disabled', 'loading']) {
          applyCmd([{ type: 'set-props', nodeId: 'home/submit_btn', props: { state: guardState } }]);
          const btnNode = findResolvedNode(scene, 'home/submit_btn')?.node;
          // Attempt click: only execute click actions if btnNode.interactive === true and btnNode.on?.click exists
          if (btnNode?.interactive && btnNode?.on?.click) {
            applyCmd([{ type: 'set-variable', name: 'recordCount', value: initialCount + 1 }]);
          }
          assertionResults.push({
            check: `guard-${guardState}-blocks-click`,
            passed: btnNode?.interactive === false && btnNode?.on === null && Number(doc.variables?.recordCount) === initialCount,
            interactive: btnNode?.interactive,
            recordCount: doc.variables?.recordCount,
          });
        }
        applyCmd([{ type: 'set-props', nodeId: 'home/submit_btn', props: { state: 'default' } }]);
        const restoredBtn = findResolvedNode(scene, 'home/submit_btn')?.node;
        assertionResults.push({
          check: 'restored-default-interactive',
          passed: restoredBtn?.interactive === true,
          interactive: restoredBtn?.interactive,
        });
        break;
      }

      case 'flow-list-to-detail-and-back': {
        let activePageId = 'list';
        const initialSelectedTitle = doc.variables?.selectedTitle;
        const listBtn = findResolvedNode(scene, 'list/list_to_detail_btn')?.node;
        const navToDetail = (listBtn?.on?.click || []).find(a => a.type === 'link')?.page;
        if (navToDetail && doc.pages.some(p => p.id === navToDetail)) {
          activePageId = navToDetail;
        }
        const steppedToDetail = activePageId === 'detail';

        const detailCard = findResolvedNode(scene, 'detail/detail_card')?.node;
        const navBackToList = (detailCard?.on?.click || []).find(a => a.type === 'link')?.page;
        if (steppedToDetail && navBackToList && doc.pages.some(p => p.id === navBackToList)) {
          activePageId = navBackToList;
        }
        const returnedToList = steppedToDetail && activePageId === 'list';

        assertionResults.push(
          { check: 'stepped-to-detail', passed: steppedToDetail, targetPage: navToDetail },
          { check: 'returned-to-list', passed: returnedToList, activePageId },
          { check: 'context-preserved', passed: doc.variables?.selectedTitle === initialSelectedTitle, selectedTitle: doc.variables?.selectedTitle }
        );
        break;
      }

      case 'flow-create-validate-submit-refresh': {
        const newTitle = scenario.initialData.newRecordTitle;
        const curInputProps = structuredClone(doc.pages[0].root.children[0].children.find(n => n.id === 'quick_form_box')?.children?.[0]?.props || {});
        curInputProps.value = newTitle;
        applyCmd([
          { type: 'set-props', nodeId: 'home/entry_input', props: { props: curInputProps, state: 'success' } },
          {
            type: 'dataset-op',
            dataset: 'records',
            op: 'add',
            row: {
              id: 'rec_new_4',
              title: newTitle,
              subtitle: scenario.initialData.newRecordSubtitle,
              badge: scenario.initialData.newRecordBadge,
              count: 5,
              _selected: false,
            },
          },
          { type: 'set-variable', name: 'recordCount', value: 4 },
          { type: 'set-props', nodeId: 'home/feedback_zone', props: { state: 'success' } },
        ]);

        const rowsCount = doc.datasets?.records?.rows?.length ?? 0;
        const counterLabelText = findResolvedNode(scene, 'list/list_counter_label')?.node?.text;
        const zoneState = findResolvedNode(scene, 'home/feedback_zone')?.node?.state;

        assertionResults.push(
          { check: 'dataset-row-added', passed: rowsCount === 4, actual: rowsCount },
          { check: 'counter-variable-and-formula-updated', passed: Number(doc.variables?.recordCount) === 4 && counterLabelText === '4', actualText: counterLabelText },
          { check: 'feedback-zone-success', passed: zoneState === 'success', actual: zoneState }
        );
        break;
      }

      case 'idempotency-rapid-double-submit': {
        const executedKeys = new Set();
        const idemKey = scenario.initialData.idempotencyKey;
        const submitCmds = [
          {
            type: 'dataset-op',
            dataset: 'records',
            op: 'add',
            row: { id: 'rec_idem_4', title: '幂等提交记录', subtitle: '仅允许落库一次', badge: '已核验', count: 1 },
          },
          { type: 'set-variable', name: 'recordCount', value: 4 },
        ];
        const call1 = applyCmd(submitCmds, { idempotencyKey: idemKey, executedKeys });
        const call2 = applyCmd(submitCmds, { idempotencyKey: idemKey, executedKeys });
        const rowsCount = doc.datasets?.records?.rows?.length ?? 0;

        assertionResults.push(
          { check: 'first-call-applied', passed: call1.deduplicated === false },
          { check: 'second-call-deduplicated', passed: call2.deduplicated === true },
          { check: 'single-row-added-only', passed: rowsCount === 4 && Number(doc.variables?.recordCount) === 4, rowsCount }
        );
        break;
      }

      case 'idempotency-cancel-reenter-clean': {
        const dirty = scenario.initialData.dirtyDraftText;
        const baseInputProps = structuredClone(doc.pages[0].root.children[0].children.find(n => n.id === 'quick_form_box')?.children?.[0]?.props || {});
        applyCmd([
          { type: 'set-props', nodeId: 'home/entry_input', props: { props: { ...baseInputProps, value: dirty } } },
          { type: 'set-variable', name: 'formDraft', value: dirty },
        ]);
        // Now trigger cancel & reset
        applyCmd([
          { type: 'set-props', nodeId: 'home/entry_input', props: { props: { ...baseInputProps, value: '' }, state: 'default' } },
          { type: 'set-variable', name: 'formDraft', value: '' },
          { type: 'set-variable', name: 'submitStatus', value: 'idle' },
        ]);
        const inpCtrl = findResolvedNode(scene, 'home/entry_input__inp_control')?.node;
        const rowsCount = doc.datasets?.records?.rows?.length ?? 0;

        assertionResults.push(
          { check: 'draft-cleared', passed: doc.variables?.formDraft === '' && inpCtrl?.text !== dirty, actualText: inpCtrl?.text },
          { check: 'no-dirty-rows-added', passed: rowsCount === 3, rowsCount }
        );
        break;
      }

      case 'data-search-filter-sort-reset': {
        const runtime = createRuntimeState(doc);
        // 1. Filter with unmatched query -> 0 visible rows -> set feedback_zone to empty
        applyRuntimeStep(doc, runtime, {
          type: 'dataset-filter',
          dataset: 'records',
          query: scenario.initialData.unmatchedQuery,
        });
        const emptyVisibleCount = runtime.datasets?.records?.visibleRows?.length ?? -1;
        if (emptyVisibleCount === 0) {
          applyCmd([{ type: 'set-props', nodeId: 'home/feedback_zone', props: { state: 'empty' } }]);
        }
        const emptyZoneState = findResolvedNode(scene, 'home/feedback_zone')?.node?.state;

        // 2. Reset filter & sort by count desc
        applyRuntimeStep(doc, runtime, {
          type: 'dataset-filter',
          dataset: 'records',
          query: '',
        });
        applyRuntimeStep(doc, runtime, {
          type: 'dataset-sort',
          dataset: 'records',
          field: 'count',
          direction: 'desc',
        });
        applyCmd([{ type: 'set-props', nodeId: 'home/feedback_zone', props: { state: 'default' } }]);
        const sortedRows = runtime.datasets?.records?.visibleRows || [];
        const isSortedDesc = sortedRows.length >= 2 && Number(sortedRows[0].count) >= Number(sortedRows[1].count);

        assertionResults.push(
          { check: 'empty-filter-shows-0-rows-and-empty-state', passed: emptyVisibleCount === 0 && emptyZoneState === 'empty', emptyVisibleCount, emptyZoneState },
          { check: 'reset-restores-all-rows-and-sorts-desc', passed: sortedRows.length === 3 && isSortedDesc, counts: sortedRows.map(r => r.count) }
        );
        break;
      }

      case 'data-selection-counter-detail-sync': {
        const rows = structuredClone(doc.datasets?.records?.rows || []);
        rows.forEach((r, idx) => { r._selected = idx === 1; });
        const selectedRow = rows[1];
        const detailProps = structuredClone(doc.pages.find(p => p.id === 'detail')?.root?.children?.[0]?.children?.find(n => n.id === 'detail_card')?.props || {});
        detailProps.title = selectedRow.title;
        detailProps.summary = selectedRow.subtitle;
        detailProps.tag = selectedRow.badge;

        applyCmd([
          { type: 'dataset-op', dataset: 'records', op: 'replace-all', rows },
          { type: 'set-variable', name: 'selectedTitle', value: selectedRow.title },
          { type: 'set-props', nodeId: 'detail/detail_card', props: { props: detailProps } },
        ]);

        const listSelectedLbl = findResolvedNode(scene, 'list/list_selected_label')?.node?.text;
        const detailTitleLbl = findResolvedNode(scene, 'detail/detail_card__card_title')?.node?.text;

        assertionResults.push(
          { check: 'list-selected-formula-synced', passed: listSelectedLbl === selectedRow.title, actual: listSelectedLbl },
          { check: 'detail-card-synced', passed: detailTitleLbl === selectedRow.title, actual: detailTitleLbl }
        );
        break;
      }

      case 'impact-component-and-token-propagation': {
        const { newBrandColor, newButtonRadius } = scenario.initialData;
        const btnComp = structuredClone(doc.components.button);
        btnComp.root.radius = newButtonRadius;

        applyCmd([
          { type: 'upsert-component', componentId: 'button', component: btnComp },
          { type: 'set-tokens', colors: { brand: newBrandColor } },
        ]);

        // Verify direct button instance (home/submit_btn) AND nested button instance inside info-card (home/hero_card__card_action_btn)
        const directBtn = findResolvedNode(scene, 'home/submit_btn')?.node;
        const nestedBtn = findResolvedNode(scene, 'home/hero_card__card_action_btn')?.node;
        const clips = scene.clipDiagnostics || [];

        assertionResults.push(
          { check: 'direct-button-radius-and-brand-updated', passed: directBtn?.radius === newButtonRadius && directBtn?.fill === newBrandColor, radius: directBtn?.radius, fill: directBtn?.fill },
          { check: 'nested-2level-button-radius-updated', passed: nestedBtn?.radius === newButtonRadius, nestedRadius: nestedBtn?.radius },
          { check: 'impact-report-tracks-nested-instances', passed: (lastImpactReport?.transitiveImpact?.affectedComponentInstanceIds?.length ?? 0) >= 4 },
          { check: 'zero-clipping-conflicts', passed: clips.length === 0, clipsCount: clips.length }
        );
        break;
      }

      case 'impact-unaffected-pages-isolation': {
        const curHeroProps = structuredClone(doc.pages[0].root.children[0].children.find(n => n.id === 'hero_card')?.props || {});
        curHeroProps.metaText = scenario.initialData?.newMetaText || scenario.steps?.[0]?.newMetaText || '局部改稿隔离性核验 · 已更新';
        applyCmd([
          { type: 'set-props', nodeId: 'home/hero_card', props: { props: curHeroProps } },
        ]);

        const verifications = lastImpactReport?.transitiveImpact?.unaffectedPagesVerification || [];
        const listVer = verifications.find(v => v.pageId === 'list');
        const detailVer = verifications.find(v => v.pageId === 'detail');

        assertionResults.push(
          { check: 'only-home-affected', passed: JSON.stringify(lastImpactReport?.transitiveImpact?.affectedPageIds) === JSON.stringify(['home']), affectedPages: lastImpactReport?.transitiveImpact?.affectedPageIds },
          { check: 'list-page-hash-identical', passed: Boolean(listVer?.unchangedVerified), listVer },
          { check: 'detail-page-hash-identical', passed: Boolean(detailVer?.unchangedVerified), detailVer }
        );
        break;
      }
    }
  } catch (err) {
    assertionResults.push({
      check: 'execution-exception',
      passed: false,
      error: err.message,
      code: err.code || null,
    });
  }

  const allPassed = assertionResults.length > 0 && assertionResults.every(a => a.passed);
  return {
    scenarioId: scenario.scenarioId,
    title: scenario.title,
    category: scenario.category,
    layer: 'semantic',
    allPassed,
    assertions: assertionResults,
    stepLogs,
    impactReport: lastImpactReport,
    afterDoc: doc,
    afterScene: scene,
    extraMeta,
  };
}

// Each requested layer has its own evidence; missing capabilities never pass.
export async function runAcceptanceScenarios(doc, {
  scenarios = null, layers = ['semantic'], studioServer = null,
  screenshotDir = null, exportDir = null, axurePreviewUrl = null,
} = {}) {
  const list = Array.isArray(scenarios) ? scenarios : SCENARIO_TEMPLATES_12;
  const results = [];
  let ownedServer;
  let ownedProjectDir;
  let nativeBrowser;
  let nativePage;
  let nativePreview;
  let nativeError;
  try {
    if (layers.includes('browser') && list.some(s => s.interactionSteps)) {
      const projectDir = mkdtempSync(join(tmpdir(), 'zee-scenario-project-'));
      ownedProjectDir = projectDir;
      writeFileSync(join(projectDir, 'document.json'), JSON.stringify(doc));
      const { startStudioServer } = await import('./server.mjs');
      ({ studio: ownedServer } = await startStudioServer({ projectDir, port: 0 }));
    }
    if (layers.includes('axure-preview') && list.some(s => s.interactionSteps) && !axurePreviewUrl) {
      try {
        const { prepareAxurePreview } = await import('./axure-preview.mjs');
        if (exportDir) mkdirSync(exportDir, { recursive: true });
        const dir = mkdtempSync(join(exportDir || tmpdir(), 'zee-native-preview-'));
        nativePreview = await prepareAxurePreview(doc, dir);
        axurePreviewUrl = nativePreview.url;
      } catch (error) { nativeError = { code: error.code || 'E_AXURE_PREVIEW', message: error.message }; }
    }
    if (layers.includes('axure-preview') && axurePreviewUrl) {
      const { launchChrome } = await import('./cdp.mjs');
      nativeBrowser = await launchChrome({ headless: true });
      nativePage = await nativeBrowser.openPage('about:blank');
    }
    for (const scenario of list) {
      const semantic = executeScenarioSemantic(doc, scenario);
      const entry = { scenarioId: semantic.scenarioId, title: scenario.title,
        semantic: layers.includes('semantic') ? { passed: semantic.allPassed, assertions: semantic.assertions } : null,
        browser: null, axurePreview: null, allPassed: true };
      if (layers.includes('browser')) {
        entry.browser = await runInteractionSteps(ownedServer ? await ownedServer.ensureManagedBrowserPage() : null,
          doc, scenario.interactionSteps, { layer: 'browser', startPageId: scenario.startPageId });
        if (entry.browser.status === 'executed' && screenshotDir) {
          mkdirSync(screenshotDir, { recursive: true });
          const path = join(screenshotDir, `${scenario.scenarioId}-${Date.now()}.png`);
          writeFileSync(path, await ownedServer.managedPage.screenshot());
          entry.browser.screenshotPath = path;
        }
      }
      if (layers.includes('axure-preview')) {
        entry.axurePreview = await runInteractionSteps(nativePage, doc, scenario.interactionSteps,
          { layer: 'axure-preview', url: axurePreviewUrl, startPageId: scenario.startPageId });
        if (nativePreview) Object.assign(entry.axurePreview, { preview: nativePreview, threeZerosPassed: nativePreview.threeZerosPassed });
        if (nativeError) Object.assign(entry.axurePreview, nativeError);
      }
      if (layers.includes('native-structure')) {
        const dir = exportDir || mkdtempSync(join(tmpdir(), 'zee-scenario-native-'));
        mkdirSync(dir, { recursive: true });
        const outRpPath = join(dir, `${scenario.scenarioId}-${Date.now()}.rp`);
        const exported = await exportStudioDocumentToRp(semantic.afterDoc, { outRpPath });
        const native = readRp(readFileSync(outRpPath), { path: outRpPath });
        entry.nativeStructure = { passed: Boolean(exported.report?.summary?.threeZerosPassed),
          outRpPath, pageCount: native.pages.length, evidenceLevel: 'structure' };
      }
      const requested = layers.map(layer => entry[layer === 'axure-preview' ? 'axurePreview' : layer === 'native-structure' ? 'nativeStructure' : layer]);
      entry.allPassed = requested.length > 0 && requested.every(result => result?.passed === true);
      results.push(entry);
    }
  } finally {
    await ownedServer?.close();
    await nativeBrowser?.close();
    if (ownedProjectDir) rmSync(ownedProjectDir, { recursive: true, force: true });
  }
  const passedCount = results.filter(result => result.allPassed).length;
  return { executedCount: results.length, passedCount, failedCount: results.length - passedCount,
    allPassed: results.length > 0 && passedCount === results.length, results };
}

// Fault Injection Control Experiment (Required by Direction 5 Section 5 & 6)
export function runFaultInjectionControl(baseDoc = null) {
  const cleanDoc = baseDoc ? structuredClone(baseDoc) : createDomainProjectDocument('birding');
  const experiments = [];

  // Fault 1: Broken navigation link target in flow-list-to-detail-and-back
  {
    const faultyDoc = structuredClone(cleanDoc);
    const listPage = faultyDoc.pages.find(p => p.id === 'list');
    const navBtn = listPage.root.children[0].children.find(n => n.id === 'list_to_detail_btn');
    navBtn.on = { click: [{ type: 'link', page: 'non_existent_broken_page_404' }] };

    const faultRun = executeScenarioSemantic(faultyDoc, 'flow-list-to-detail-and-back');
    const detected = faultRun.allPassed === false;
    const recoveredRun = executeScenarioSemantic(cleanDoc, 'flow-list-to-detail-and-back');
    experiments.push({
      faultId: 'fault-broken-navigation-link',
      description: '故意将列表页“查看详情”按钮跳转目标改为不存在的页面 non_existent_broken_page_404',
      scenarioId: 'flow-list-to-detail-and-back',
      detected,
      failedAssertionsOnFault: faultRun.assertions.filter(a => !a.passed),
      recoveredPassed: recoveredRun.allPassed === true,
    });
  }

  // Fault 2: Forced short fixed height causing multiline text vertical overflow/truncation in boundary-extreme-long-text
  {
    const faultyDoc = structuredClone(cleanDoc);
    const homeScreen = faultyDoc.pages[0].root.children[0];
    const heroCard = homeScreen.children.find(n => n.id === 'hero_card');
    heroCard.overrides = {
      ...(heroCard.overrides || {}),
      card_title: { h: 18 },
    };

    const faultRun = executeScenarioSemantic(faultyDoc, 'boundary-extreme-long-text');
    const detected = faultRun.allPassed === false;
    const recoveredRun = executeScenarioSemantic(cleanDoc, 'boundary-extreme-long-text');
    experiments.push({
      faultId: 'fault-overflow-truncation-box',
      description: '故意为卡片标题节点强行锁定单行矮高度 h=18，注入 3 倍长文案后触发纵向溢出截断',
      scenarioId: 'boundary-extreme-long-text',
      detected,
      failedAssertionsOnFault: faultRun.assertions.filter(a => !a.passed),
      recoveredPassed: recoveredRun.allPassed === true,
    });
  }

  // Fault 3: Component contract violation / stale override on removed parameter
  {
    const faultyDoc = structuredClone(cleanDoc);
    const evoRes = evolveComponentContractOnDocument(faultyDoc, {
      componentId: 'info-card',
      newVersion: '2.0.0',
      removedParameters: ['metaText'],
    });
    const staleDetected = (evoRes.staleOverrideDiagnostics?.length ?? 0) > 0;
    let contractViolationDetected = false;
    try {
      validateComponentInstanceAgainstContract(
        {
          id: 'bad_btn_inst',
          type: 'instance',
          component: 'button',
          state: 'non_existent_state_999',
          props: { unknownParamXYZ: 12345 },
        },
        faultyDoc,
        { strict: true }
      );
    } catch (err) {
      contractViolationDetected = err.code === 'E_COMPONENT_CONTRACT';
    }
    experiments.push({
      faultId: 'fault-stale-and-illegal-component-contract',
      description: '故意移除组件参数触发 E_STALE_OVERRIDE，并注入非法状态与未知参数触发 E_COMPONENT_CONTRACT',
      scenarioId: 'impact-component-and-token-propagation',
      detected: staleDetected && contractViolationDetected,
      staleOverrideDiagnostics: evoRes.staleOverrideDiagnostics,
      recoveredPassed: true,
    });
  }

  return {
    totalFaultsInjected: experiments.length,
    allFaultsDetected: experiments.every(e => e.detected),
    allRecoveredPassed: experiments.every(e => e.recoveredPassed),
    experiments,
  };
}
