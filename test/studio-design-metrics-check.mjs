#!/usr/bin/env node
/**
 * 回归：设计度量层（L1 指标 + 反 slop）
 *  - 坏页面必须命中：等距三卡、紫渐变、空洞居中标题、首屏无素材
 *  - 好页面必须不误伤
 *  - 不返回"审美总分"
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioHandlers } from '../studio/mcp-adapter.mjs';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'zee-metrics-'));

const bad = await studioHandlers.studio_open_project({ projectDir: dir, name: '反例', port: 4531 });
const rev0 = bad.appliedRevision;

// 一屏典型的"AI 默认版式"
const addBad = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: rev0,
  idempotencyKey: 'metrics-bad-1',
  commands: [
    { type: 'addPage', pageId: 'bad', name: '反例页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'bad', node: {
      id: 'hero', type: 'box', layout: 'column', w: 'fill', h: 280, radius: 32, padding: 40, gap: 16,
      css: { background: 'linear-gradient(135deg, #7C3AED, #A855F7)' },
      children: [
        { id: 'hero_t', type: 'label', text: '让我们一起开启智慧新纪元。', w: 'fill', h: 56, fontSize: 40, fontWeight: 700, color: '#FFFFFF', textAlign: 'center' },
      ],
    } },
    { type: 'addNode', pageId: 'bad', node: {
      id: 'cards', type: 'box', layout: 'row', w: 'fill', h: 180, gap: 24,
      children: [
        { id: 'c1', type: 'box', layout: 'column', w: 380, h: 180, radius: 12, fill: '#FFFFFF', gap: 8, padding: 20,
          children: [{ id: 'c1_t', type: 'label', text: '高效协同', w: 'fill', h: 24, fontSize: 16, fontWeight: 600, color: '#111827' }] },
        { id: 'c2', type: 'box', layout: 'column', w: 380, h: 180, radius: 12, fill: '#FFFFFF', gap: 8, padding: 20,
          children: [{ id: 'c2_t', type: 'label', text: '安全可靠', w: 'fill', h: 24, fontSize: 16, fontWeight: 600, color: '#111827' }] },
        { id: 'c3', type: 'box', layout: 'column', w: 380, h: 180, radius: 12, fill: '#FFFFFF', gap: 8, padding: 20,
          children: [{ id: 'c3_t', type: 'label', text: '开箱即用', w: 'fill', h: 24, fontSize: 16, fontWeight: 600, color: '#111827' }] },
      ],
    } },
  ],
});
check('反例页创建成功', () => assert.equal(addBad.ok, true));

const badMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'bad' });
const rules = new Set(badMetrics.slop.map(v => v.rule));
check('命中 purple-gradient', () => assert.ok(rules.has('purple-gradient'), [...rules].join(',')));
check('命中 equal-card-grid', () => assert.ok(rules.has('equal-card-grid'), [...rules].join(',')));
check('命中 vague-centered-hero', () => assert.ok(rules.has('vague-centered-hero'), [...rules].join(',')));
check('命中 hero-without-media', () => assert.ok(rules.has('hero-without-media'), [...rules].join(',')));
check('违反项带可执行改法', () => assert.ok(badMetrics.slop.every(v => v.fix && v.fix.length > 6)));
check('返回 nodeIds 便于定位', () => assert.ok(badMetrics.slop.every(v => Array.isArray(v.nodeIds))));
check('不返回审美总分', () => {
  const flat = JSON.stringify(badMetrics);
  assert.ok(!/"aestheticScore"|"taste"|"beauty"/.test(flat));
});
check('L1 判定为不达标', () => assert.equal(badMetrics.l1.ok, false));

// 对照：无渐变、2:1 主次、非居中
const addGood = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: addBad.appliedRevision,
  idempotencyKey: 'metrics-good-1',
  commands: [
    { type: 'addPage', pageId: 'good', name: '正例页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'good', node: {
      id: 'wrap', type: 'box', layout: 'row', w: 'fill', h: 320, gap: 64, padding: 48,
      children: [
        { id: 'left', type: 'box', layout: 'column', w: 720, h: 224, gap: 16,
          children: [
            { id: 'lt', type: 'label', text: '把季度续费跟进从 3 天压到 4 小时', w: 'fill', h: 48, fontSize: 40, fontWeight: 700, color: '#0F172A' },
            { id: 'ls', type: 'label', text: '订单、回访与收入口径在一屏内闭合。', w: 'fill', h: 24, fontSize: 16, color: '#475569' },
          ] },
        { id: 'right', type: 'image', src: 'assets/hero.jpg', w: 400, h: 224, radius: 12 },
      ],
    } },
  ],
});
check('正例页创建成功', () => assert.equal(addGood.ok, true));
const goodMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'good' });
check('正例页无 slop 命中', () => assert.equal(goodMetrics.slop.length, 0, JSON.stringify(goodMetrics.slop)));
check('正例页指标齐全', () => {
  assert.ok(goodMetrics.metrics.typeScale.sizes.length >= 2);
  assert.ok(Number.isFinite(goodMetrics.metrics.whitespace.whitespaceRatio));
  assert.ok(goodMetrics.metrics.contrast.checked >= 1);
});

console.log('[6] 空页面不得判合格');
const emptyMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
check('空页返回 not-assessable', () => assert.equal(emptyMetrics.l1.verdict, 'not-assessable'));
check('空页不算 L1 通过', () => assert.equal(emptyMetrics.l1.ok, false));
check('空页给出内容门槛原因', () => assert.match(JSON.stringify(emptyMetrics.l1.blocking), /content-presence/));

console.log('[7] token 颜色要计入色相（真实工程全是 token）');
const tokenPage = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: addGood.appliedRevision,
  idempotencyKey: 'metrics-token-1',
  commands: [
    { type: 'addPage', pageId: 'tok', name: 'Token 页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'tok', node: { id: 'blk', type: 'box', w: 600, h: 300, fill: '$brand' } },
    { type: 'addNode', pageId: 'tok', node: { id: 'cap', type: 'label', text: '品牌块', w: 300, h: 40, fontSize: 24, color: '$ink' } },
    { type: 'addNode', pageId: 'tok', node: { id: 'divider', type: 'divider', w: 600, h: 1, fill: '$line' } },
  ],
});
check('divider 现在是合法节点类型', () => assert.equal(tokenPage.ok, true));
const tokenMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'tok' });
check('token 色相不再恒为 0', () => assert.ok(tokenMetrics.metrics.palette.distinctHues >= 1, `hues=${tokenMetrics.metrics.palette.distinctHues}`));
check('栅格一本账：失败数 == offenderCount', () => {
  for (const pageId of ['bad', 'good', 'tok']) {
    const grid = (pageId === 'bad' ? badMetrics : pageId === 'good' ? goodMetrics : tokenMetrics).metrics.gridAlignment;
    assert.equal(grid.total - grid.aligned, grid.offenderCount,
      `${pageId}: total ${grid.total} aligned ${grid.aligned} offenderCount ${grid.offenderCount}`);
  }
});

check('栅格越界项与失败数一致', () => {
  const grid = tokenMetrics.metrics.gridAlignment;
  const failed = tokenMetrics.checks.find(c => c.key === 'grid-alignment');
  if (failed && !failed.ok) assert.ok(grid.offenders.length > 0, '报了失败却没给 offenders');
  else assert.ok(grid.offenders.length === 0 || failed === undefined || failed.ok);
});

console.log('[8] 越界与文字溢出必须被拦下');
const overflowPage = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: tokenPage.appliedRevision,
  idempotencyKey: 'metrics-overflow-1',
  commands: [
    { type: 'addPage', pageId: 'ovf', name: '越界页', domain: 'web', w: 800, h: 600 },
    { type: 'addNode', pageId: 'ovf', node: { id: 'tall', type: 'box', w: 300, h: 500, fill: '#E5E7EB' } },
    { type: 'addNode', pageId: 'ovf', node: { id: 'far', type: 'box', w: 300, h: 200, fill: '#E5E7EB' } },
  ],
});
const ovfMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'ovf' });
check('越界页 containment 不通过', () => {
  const check = ovfMetrics.checks.find(c => c.key === 'containment');
  assert.ok(check && check.ok === false, JSON.stringify(ovfMetrics.checks.map(c => c.key)));
});
check('越界明细点名节点', () => assert.match(String(ovfMetrics.checks.find(c => c.key === 'containment').detail), /越出画板 \d+ 个/));
check('越界不是"通过"', () => assert.equal(ovfMetrics.l1.ok, false));

console.log('[9] 1px 越界必须与 review 同判（0.5px 容差）');
const edgePage = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: overflowPage.appliedRevision,
  idempotencyKey: 'metrics-edge-1',
  commands: [{ type: 'addPage', pageId: 'edge', name: '贴边页', domain: 'web', w: 800, h: 600 }],
});
const edge = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: edgePage.appliedRevision,
  idempotencyKey: 'metrics-edge-2',
  commands: [
    { type: 'addNode', pageId: 'edge', node: { id: 'shell', type: 'box', layout: 'stack', x: -32, y: -32, w: 800, h: 600, children: [
      { id: 'one_px', type: 'box', x: 40, y: 0, w: 200, h: 120, fill: '#E5E7EB' },
      { id: 'tx', type: 'label', text: '贴边测试', x: 40, y: 200, w: 300, h: 32, fontSize: 20, color: '#111827' },
    ] } },
  ],
});
check('贴边页创建成功', () => assert.equal(edge.ok, true));
const edgeMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'edge' });
check('1px 级越界也被判出来', () => assert.ok(edgeMetrics.metrics.containment.total >= 1, JSON.stringify(edgeMetrics.metrics.containment)));
check('越界存在时 verdict 不得为达标', () => assert.equal(edgeMetrics.l1.ok, false));

console.log('[10] 主次比有上限：撑高文字不是"更好"');
const dominancePage = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: edge.appliedRevision,
  idempotencyKey: 'metrics-dom-1',
  commands: [{ type: 'addPage', pageId: 'dom', name: '失衡页', domain: 'web', w: 1280, h: 800 }],
});
const domApplied = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: dominancePage.appliedRevision,
  idempotencyKey: 'metrics-dom-2',
  commands: [
    { type: 'addNode', pageId: 'dom', node: { id: 'big_t', type: 'label', text: '季度复盘', x: 40, y: 40, w: 900, h: 232, fontSize: 24, fontWeight: 700, color: '#111827' } },
    { type: 'addNode', pageId: 'dom', node: { id: 'c1', type: 'box', x: 40, y: 300, w: 300, h: 120, fill: '#E5E7EB' } },
    { type: 'addNode', pageId: 'dom', node: { id: 'c2', type: 'box', x: 380, y: 300, w: 300, h: 120, fill: '#E5E7EB' } },
  ],
});
check('失衡页创建成功', () => assert.equal(domApplied.ok, true));
const domMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'dom' });
check('被撑高的文字框被单独识别', () => {
  const hierarchy = domMetrics.metrics.visualHierarchy;
  assert.ok(hierarchy, '缺少主次比');
  const stretched = hierarchy.stretchedText || [];
  assert.ok(stretched.length >= 1, `stretchedText=${JSON.stringify(stretched)}`);
  assert.equal(stretched[0].id, 'big_t');
});
check('失衡时 visual-hierarchy 不通过', () => {
  const check = domMetrics.checks.find(c => c.key === 'visual-hierarchy');
  assert.ok(check && check.ok === false, JSON.stringify(check));
});

console.log('[11] 导出预算前置');
const exportPage = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: domApplied.appliedRevision,
  idempotencyKey: 'metrics-export-1',
  commands: [
    { type: 'addPage', pageId: 'exp', name: '效果页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'exp', node: { id: 'k1', type: 'box', x: 40, y: 340, w: 400, h: 200, css: { background: 'linear-gradient(#7C3AED,#1F7E86)' } } },
    { type: 'addNode', pageId: 'exp', node: { id: 'k2', type: 'box', x: 480, y: 340, w: 400, h: 200, css: { filter: 'saturate(1.2)' } } },
    { type: 'addNode', pageId: 'exp', node: { id: 'k5', type: 'box', x: 40, y: 120, w: 200, h: 120, css: { transform: 'rotate(3deg)' } } },
    { type: 'addNode', pageId: 'exp', node: { id: 'k3', type: 'label', text: '效果说明', x: 40, y: 40, w: 400, h: 32, fontSize: 20, color: '#111827' } },
    { type: 'addNode', pageId: 'exp', node: { id: 'k4', type: 'paragraph', text: '栅格化与丢弃的差别说明。', x: 40, y: 620, w: 600, h: 28, fontSize: 16, color: '#374151' } },
  ],
});
check('效果页创建成功', () => assert.equal(exportPage.ok, true));
const exportMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'exp' });
const budget = exportMetrics.metrics.exportBudget;
check('导出预算有分类', () => {
  assert.ok(budget && budget.nodes > 0, JSON.stringify(budget));
  assert.ok(budget.rasterized >= 1, `rasterized=${budget.rasterized}`);
  assert.ok(budget.decorations >= 1, `decorations=${budget.decorations}`);
});
check('有丢弃效果时给出提示', () => {
  const advisory = (exportMetrics.warnings || []).find(w => w.check === 'export-budget');
  assert.ok(advisory, '缺少 export-budget 提示');
});
check('预算写明是静态投影且承认不确定', () => assert.match(String(budget.note), /静态投影|export_rp|uncertain/));
check('预算口径是加性的（节点数 == 可编辑基底）', () => assert.equal(budget.nativeBase, budget.nodes));
check('词表与导出报告一致', () => {
  assert.ok(['rasterized-effect', 'uncertain', 'unsupported'].every(v => typeof v === 'string'));
  const verdicts = new Set(budget.items.map(i => i.verdict));
  for (const v of verdicts) assert.ok(['rasterized-effect', 'uncertain', 'unsupported'].includes(v), v);
});

console.log('[12] 关系约束（role / 主操作 / 点击区 / 空态）');
const relPage = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: exportPage.appliedRevision,
  idempotencyKey: 'metrics-rel-1',
  commands: [
    { type: 'addPage', pageId: 'rel', name: '关系页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'rel', node: { id: 'b1', type: 'button', text: '提交', x: 40, y: 40, w: 120, h: 40, fill: '#2563EB', color: '#FFFFFF', role: 'primary-action' } },
    { type: 'addNode', pageId: 'rel', node: { id: 'b2', type: 'button', text: '取消', x: 200, y: 40, w: 60, h: 28, fill: '#E5E7EB', role: 'primary-action' } },
    { type: 'addNode', pageId: 'rel', node: { id: 'rep', type: 'repeater', dataset: 'orders', x: 40, y: 120, w: 600, h: 200, rowHeight: 40, rows: [{ id: '1' }] } },
    { type: 'addNode', pageId: 'rel', node: { id: 'cap', type: 'label', text: '订单列表', x: 40, y: 80, w: 300, h: 24, fontSize: 18, color: '#111827' } },
  ],
});
check('关系页创建成功', () => assert.equal(relPage.ok, true));
const relMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'rel' });
check('多个主操作被判不合格', () => {
  const c = relMetrics.checks.find(x => x.key === 'primary-action-unique');
  assert.ok(c && c.ok === false, JSON.stringify(c));
});
check('点击区过小被点名', () => {
  const c = relMetrics.checks.find(x => x.key === 'tap-target');
  assert.ok(c && c.ok === false && /28px/.test(c.detail), JSON.stringify(c));
});
check('有列表无空态被拦下', () => {
  const c = relMetrics.checks.find(x => x.key === 'empty-state-coverage');
  assert.ok(c && c.ok === false && /空态/.test(c.detail), JSON.stringify(c));
});

const fixed = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: relPage.appliedRevision,
  idempotencyKey: 'metrics-rel-2',
  commands: [
    { type: 'setProperties', nodeId: 'b2', properties: { width: 80 } },
    { type: 'addNode', pageId: 'rel', node: { id: 'empty', type: 'box', layout: 'column', role: 'empty-state', for: 'rep', x: 40, y: 400, w: 400, h: 120, fill: '#F8FAFC', children: [{ id: 'empty_t', type: 'label', text: '暂无数据', w: 240, h: 24, fontSize: 16, color: '#111827' }] } },
    { type: 'setProperties', nodeId: 'b2', properties: { role: 'secondary-action' } },
  ],
});
if (fixed.ok) {
  const relFixed = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'rel' });
  check('补上空态并降级次操作后关系检查转好', () => {
    assert.ok(relFixed.checks.find(x => x.key === 'empty-state-coverage').ok === true);
    assert.ok(relFixed.checks.find(x => x.key === 'primary-action-unique').ok === true);
  });
}

console.log('[13] 空态绑定与热区');
const revBeforeBind = (await studioHandlers.studio_get_context({ projectDir: dir })).appliedRevision;
const bindPage = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: revBeforeBind,
  idempotencyKey: 'metrics-bind-1',
  commands: [
    { type: 'addPage', pageId: 'bind', name: '绑定页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'bind', node: { id: 'r1', type: 'repeater', x: 40, y: 40, w: 400, h: 200, rowHeight: 40, rows: [{ id: '1' }] } },
    { type: 'addNode', pageId: 'bind', node: { id: 'r2', type: 'repeater', x: 480, y: 40, w: 400, h: 200, rowHeight: 40, rows: [{ id: '2' }] } },
    { type: 'addNode', pageId: 'bind', node: { id: 'empty_unbound', type: 'box', layout: 'column', role: 'empty-state', x: 40, y: 600, w: 300, h: 100, fill: '#F8FAFC', children: [{ id: 'eu_t', type: 'label', text: '暂无数据', w: 240, h: 24, fontSize: 16, color: '#111827' }] } },
    { type: 'addNode', pageId: 'bind', node: { id: 'tiny', type: 'button', text: '×', x: 900, y: 600, w: 20, h: 20 } },
  ],
});
check('绑定页创建成功', () => assert.equal(bindPage.ok, true, JSON.stringify(bindPage).slice(0, 200)));
const bindMetrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'bind' });
check('未绑定空态时判不通过', () => {
  const c = bindMetrics.checks.find(x => x.key === 'empty-state-coverage');
  assert.ok(c && c.ok === false && /未绑定/.test(c.detail), JSON.stringify(c));
});
check('热区不足被判出', () => {
  const c = bindMetrics.checks.find(x => x.key === 'tap-target');
  assert.ok(c && c.ok === false && /20px/.test(c.detail), JSON.stringify(c));
});

const fixedBind = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: bindPage.appliedRevision,
  idempotencyKey: 'metrics-bind-2',
  commands: [
    { type: 'setProperties', nodeId: 'empty_unbound', properties: { for: 'r1' } },
    { type: 'addNode', pageId: 'bind', node: { id: 'empty_r2', type: 'box', layout: 'column', role: 'empty-state', for: 'r2', x: 480, y: 600, w: 300, h: 100, fill: '#F8FAFC', children: [{ id: 'er2_t', type: 'label', text: '暂无数据', w: 240, h: 24, fontSize: 16, color: '#111827' }] } },
    { type: 'setProperties', nodeId: 'tiny', properties: { hitW: 44, hitH: 44 } },
  ],
});
if (fixedBind.ok) {
  const bindFixed = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'bind' });
  check('绑定后空态检查转正', () => {
    const c = bindFixed.checks.find(x => x.key === 'empty-state-coverage');
    assert.ok(c && c.ok === true, JSON.stringify(c));
  });
  check('hitW 不能刷绿点击区（渲染层未消费）', () => {
    const c = bindFixed.checks.find(x => x.key === 'tap-target');
    assert.ok(c && c.ok === false, JSON.stringify(c));
  });
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
