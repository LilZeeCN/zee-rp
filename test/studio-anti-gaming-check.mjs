#!/usr/bin/env node
/**
 * 回归：反"刷绿"攻击面（外部试用者实测出的三条通路）
 *  1. 幽灵盒子（全透明、不可见）不得伪造主次比
 *  2. 零宽字符 / 空白 src 不得把白板变成"有内容"
 *  3. type:"label" + on.click 必须算可交互元素
 *  4. wrapper 拆分不得绕过"主操作并列"
 *  5. 导出预算必须认得 customFilter
 *  6. 修复计划只接受"整页阻塞项严格减少"的命令，并给出 unfixable 原因
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
let port = 4980;
const newProject = async (tag) => {
  const dir = mkdtempSync(join(tmpdir(), `zee-anti-${tag}-`));
  const open = await studioHandlers.studio_open_project({ projectDir: dir, name: tag, domain: 'web', port: port++ });
  return { dir, open };
};

console.log('[1] 幽灵盒子');
{
  const { dir, open } = await newProject('ghost');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'ghost-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '季度复盘', x: 40, y: 40, w: 600, h: 40, fontSize: 32, fontWeight: 700, color: '#111827' } },
      { type: 'addNode', pageId: 'home', node: { id: 'b', type: 'paragraph', text: '说明文字内容。', x: 40, y: 100, w: 600, h: 24, fontSize: 14, color: '#374151' } },
      { type: 'addNode', pageId: 'home', node: { id: 'c', type: 'label', text: '标签', x: 40, y: 140, w: 200, h: 20, fontSize: 13, color: '#6B7280' } },
      { type: 'addNode', pageId: 'home', node: { id: 'ghost', type: 'box', x: 40, y: 200, w: 1000, h: 520, fill: 'rgba(0,0,0,0)' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('不可见块不参与主次比', () => {
    const hierarchy = m.metrics.visualHierarchy;
    assert.ok(!hierarchy || hierarchy.dominantId !== 'ghost', JSON.stringify(hierarchy));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[2] 零宽字符与空白 src');
{
  const { dir, open } = await newProject('zerowidth');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'zw-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 'list', type: 'repeater', x: 40, y: 40, w: 400, h: 200, rowHeight: 40, rows: [{ id: '1' }] } },
      { type: 'addNode', pageId: 'home', node: { id: 'es', type: 'box', role: 'empty-state', for: 'list', x: 40, y: 280, w: 300, h: 96, fill: '#F8FAFC', children: [{ id: 'es_t', type: 'label', text: '\u200b', w: 200, h: 24 }] } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('零宽字符不算空态内容', () => {
    const c = m.checks.find(x => x.key === 'empty-state-coverage');
    assert.ok(c && c.ok === false, JSON.stringify(c));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[3] label + on.click 也算可点');
{
  const { dir, open } = await newProject('click');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'click-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 'lb', type: 'label', text: '点我', x: 40, y: 40, w: 16, h: 16, fontSize: 12, color: '#111827', on: { click: [{ goto: 'home' }] } } },
      { type: 'addNode', pageId: 'home', node: { id: 't2', type: 'paragraph', text: '说明。', x: 40, y: 100, w: 200, h: 24, fontSize: 14, color: '#374151' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('挂 click 的小标签不被跳过', () => {
    const c = m.checks.find(x => x.key === 'tap-target');
    assert.ok(c && c.ok === false, JSON.stringify(c));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[4] wrapper 拆分不能绕过主操作并列');
{
  const { dir, open } = await newProject('wrap');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'wrap-1',
    commands: [{
      type: 'addNode', pageId: 'home', node: {
        id: 'row', type: 'box', layout: 'row', x: 40, y: 40, w: 800, h: 80, gap: 16,
        children: [
          { id: 'w1', type: 'box', layout: 'column', w: 140, h: 60, children: [{ id: 'b1', type: 'button', text: '保存', variant: 'primary', w: 120, h: 44 }] },
          { id: 'w2', type: 'box', layout: 'column', w: 140, h: 60, children: [{ id: 'b2', type: 'button', text: '发布', variant: 'primary', w: 120, h: 44 }] },
        ],
      },
    }],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('同一行内包 wrapper 仍判并列', () => {
    const c = m.checks.find(x => x.key === 'primary-action-unique');
    assert.ok(c && c.ok === false, JSON.stringify(c));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[5] 导出预算认得 customFilter');
{
  const { dir, open } = await newProject('customfilter');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'cf-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 'blur', type: 'box', x: 40, y: 40, w: 300, h: 200, customFilter: 'blur(8px)' } },
      { type: 'addNode', pageId: 'home', node: { id: 'txt', type: 'paragraph', text: '说明。', x: 40, y: 300, w: 300, h: 24, fontSize: 14, color: '#374151' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('customFilter 计入栅格装饰层', () => {
    assert.ok((m.metrics.exportBudget?.rasterized || 0) >= 1, JSON.stringify(m.metrics.exportBudget));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[6] 修复计划严格性与原因');
{
  const { dir, open } = await newProject('fixstrict');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'fs-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 'list', type: 'repeater', x: 40, y: 40, w: 400, h: 200, rowHeight: 40, rows: [{ id: '1' }] } },
      { type: 'addNode', pageId: 'home', node: { id: 'tiny', type: 'button', text: '×', x: 500, y: 40, w: 20, h: 20 } },
      { type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '季度复盘', x: 40, y: 300, w: 500, h: 232, fontSize: 16, fontWeight: 700, color: '#111827' } },
      { type: 'addNode', pageId: 'home', node: { id: 'p', type: 'paragraph', text: '说明。', x: 40, y: 560, w: 400, h: 24, fontSize: 13, color: '#374151' } },
    ],
  });
  const plan = await studioHandlers.studio_design_fix_plan({ projectDir: dir, pageId: 'home' });
  check('计划必须让阻塞项严格减少', () => {
    assert.ok(plan.projected.after.blocking.length < plan.projected.before.blocking.length,
      JSON.stringify(plan.projected));
  });
  check('修不了的项必须给原因', () => {
    assert.ok(Array.isArray(plan.unfixable) && plan.unfixable.length > 0, JSON.stringify(plan.unfixable));
    for (const item of plan.unfixable) assert.ok(item.reason && item.reason.length > 6);
  });
  check('被拒命令必须说明原因', () => {
    for (const item of plan.rejected || []) assert.ok(item.reason && item.reason.length > 4);
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[7] 有效不透明度（alpha 1/255 与 opacity:0）');
{
  const { dir, open } = await newProject('alpha');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'alpha-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '季度复盘', x: 40, y: 40, w: 600, h: 40, fontSize: 32, fontWeight: 700, color: '#111827' } },
      { type: 'addNode', pageId: 'home', node: { id: 'p', type: 'paragraph', text: '说明文字。', x: 40, y: 100, w: 600, h: 24, fontSize: 14, color: '#374151' } },
      { type: 'addNode', pageId: 'home', node: { id: 'ghost1px', type: 'box', x: 40, y: 200, w: 1000, h: 520, fill: '#FFFFFF01' } },
      { type: 'addNode', pageId: 'home', node: { id: 'ghostOpacity', type: 'box', x: 40, y: 200, w: 1000, h: 520, fill: '#FFFFFF', opacity: 0 } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('1/255 填充与 opacity:0 都不算可见块', () => {
    const hierarchy = m.metrics.visualHierarchy;
    if (!hierarchy) return; // 块不足 → 已被判 not-assessable
    assert.ok(!['ghost1px', 'ghostOpacity'].includes(hierarchy.dominantId), JSON.stringify(hierarchy));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[8] 软连字符（Cf 类）');
{
  const { dir, open } = await newProject('softhyphen');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'sh-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 'list', type: 'repeater', x: 40, y: 40, w: 400, h: 200, rowHeight: 40, rows: [{ id: '1' }] } },
      { type: 'addNode', pageId: 'home', node: { id: 'es', type: 'box', role: 'empty-state', for: 'list', x: 40, y: 280, w: 300, h: 96, fill: '#F8FAFC', children: [{ id: 'es_t', type: 'label', text: '\u00ad', w: 200, h: 24 }] } },
      { type: 'addNode', pageId: 'home', node: { id: 'cap', type: 'paragraph', text: '说明。', x: 40, y: 400, w: 300, h: 24, fontSize: 14, color: '#374151' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('软连字符不算空态内容', () => {
    const c = m.checks.find(x => x.key === 'empty-state-coverage');
    assert.ok(c && c.ok === false, JSON.stringify(c));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[9] 缺失检查不得蒸发');
{
  const { dir, open } = await newProject('manifest');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'mf-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '季度复盘', x: 40, y: 40, w: 600, h: 40, fontSize: 32, fontWeight: 700, color: '#111827' } },
      { type: 'addNode', pageId: 'home', node: { id: 'ghost', type: 'box', x: 40, y: 200, w: 1000, h: 520, fill: '#FFFFFF01' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('检查条数与清单一致', () => {
    assert.equal(m.l1.counted + m.l1.skipped.length, m.l1.expected,
      `counted=${m.l1.counted} skipped=${m.l1.skipped.length} expected=${m.l1.expected}`);
  });
  check('无法判断主次必须判红而不是消失', () => {
    const c = m.checks.find(x => x.key === 'visual-hierarchy');
    assert.ok(c, 'visual-hierarchy 从 checks 里消失了');
    assert.equal(c.ok, false, JSON.stringify(c));
    assert.equal(c.notAssessable, true, JSON.stringify(c));
  });
  check('未评估项在 l1 里可查', () => assert.ok(m.l1.notAssessed.includes('visual-hierarchy'), JSON.stringify(m.l1.notAssessed)));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[10] 对比度 1:1 不得判合格');
{
  const { dir, open } = await newProject('contrast');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'ct-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '季度复盘', x: 40, y: 40, w: 600, h: 40, fontSize: 32, fontWeight: 700, color: '#F7F8F9' } },
      { type: 'addNode', pageId: 'home', node: { id: 'p', type: 'paragraph', text: '说明文字。', x: 40, y: 100, w: 600, h: 24, fontSize: 14, color: '#F7F8F9' } },
      { type: 'addNode', pageId: 'home', node: { id: 'b3', type: 'box', x: 40, y: 200, w: 400, h: 200, fill: '#E5E7EB' } },
      { type: 'addNode', pageId: 'home', node: { id: 'b4', type: 'box', x: 480, y: 200, w: 400, h: 200, fill: '#E5E7EB' } },
      { type: 'addNode', pageId: 'home', node: { id: 'cap', type: 'label', text: '副标题', x: 40, y: 440, w: 300, h: 24, fontSize: 15, color: '#374151' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('对比度不足必须进 L1 阻塞', () => {
    const c = m.checks.find(x => x.key === 'contrast');
    assert.ok(c && c.ok === false, JSON.stringify(c));
    assert.ok(m.l1.blocking.some(b => b.check === 'contrast'), JSON.stringify(m.l1.blocking));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[11] 不可评估分支也要完整清单');
{
  const { dir, open } = await newProject('early');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'early-1',
    commands: [{ type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '季度复盘', x: 40, y: 40, w: 600, h: 40, fontSize: 32, color: '#111827' } }],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('内容不足时清单不塌陷', () => {
    assert.equal(m.checks.length, 11, `checks=${m.checks.length}`);
    assert.equal(m.l1.expected, 11);
    assert.equal(m.l1.counted + m.l1.skipped.length, 11);
  });
  check('未评估项逐个点名', () => assert.ok(m.l1.notAssessed.length >= 5, JSON.stringify(m.l1.notAssessed)));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[12] 不可见文字不能当主视觉');
{
  const { dir, open } = await newProject('textghost');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'tg-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '季度复盘', x: 40, y: 40, w: 600, h: 48, fontSize: 32, fontWeight: 700, color: '#111827' } },
      { type: 'addNode', pageId: 'home', node: { id: 'p', type: 'paragraph', text: '说明。', x: 40, y: 100, w: 500, h: 24, fontSize: 14, color: '#374151' } },
      { type: 'addNode', pageId: 'home', node: { id: 'ghostInvisible', type: 'label', text: '隐形大字', x: 40, y: 140, w: 1000, h: 200, fontSize: 48, fontWeight: 700, color: '#00000000' } },
      { type: 'addNode', pageId: 'home', node: { id: 'ghostOpacity', type: 'label', text: '透明大字', x: 40, y: 360, w: 1000, h: 200, fontSize: 48, fontWeight: 700, color: '#111827', opacity: 0 } },
      { type: 'addNode', pageId: 'home', node: { id: 'cap', type: 'label', text: '备注', x: 40, y: 580, w: 300, h: 20, fontSize: 13, color: '#6B7280' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('透明文字不参与主次比', () => {
    const hierarchy = m.metrics.visualHierarchy;
    if (!hierarchy) return;
    assert.ok(!['ghostInvisible', 'ghostOpacity'].includes(hierarchy.dominantId), JSON.stringify(hierarchy));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[13] 文字压图不能靠"不可知"放行');
{
  const { dir, open } = await newProject('photo');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'ph-1',
    commands: [
      { type: 'addNode', pageId: 'home', node: { id: 'hero', type: 'image', src: 'assets/hero.jpg', x: 40, y: 40, w: 900, h: 320, children: [
        { id: 'white', type: 'label', text: '白字压图', x: 60, y: 120, w: 400, h: 48, fontSize: 24, color: '#FFFFFF' },
      ] } },
      { type: 'addNode', pageId: 'home', node: { id: 'p', type: 'paragraph', text: '说明文字。', x: 40, y: 380, w: 400, h: 24, fontSize: 14, color: '#374151' } },
      { type: 'addNode', pageId: 'home', node: { id: 'b3', type: 'box', x: 40, y: 440, w: 300, h: 120, fill: '#E5E7EB' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('白字压图必须判红（底色不可知 ≠ 通过）', () => {
    const contrast = m.checks.find(c => c.key === 'contrast');
    assert.ok(contrast && contrast.ok === false, JSON.stringify(contrast));
    assert.ok((m.metrics.contrast.unknown || 0) >= 1, `unknown=${m.metrics.contrast.unknown}`);
    assert.equal(m.l1.verdict, 'below-l1-bar', JSON.stringify(m.l1));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[14] 不该红的别红（假阳性）');
{
  const { dir, open } = await newProject('false-red');
  await studioHandlers.studio_apply_commands({
    projectDir: dir, baseRevision: open.appliedRevision, idempotencyKey: 'fr-1',
    commands: [
      // 深色条内的白字 + 角落里一张无关装饰图：以前任何图都会让同层底色解析整体放弃
      { type: 'addNode', pageId: 'home', node: { id: 'bar', type: 'box', layout: 'column', x: 40, y: 200, w: 800, h: 120, fill: '#1F2937', children: [
        { id: 'wt', type: 'label', text: '白字在深色条上', w: 500, h: 40, fontSize: 22, color: '#FFFFFF' },
      ] } },
      { type: 'addNode', pageId: 'home', node: { id: 'deco', type: 'image', src: 'assets/d.jpg', x: 900, y: 620, w: 200, h: 120 } },
      { type: 'addNode', pageId: 'home', node: { id: 'p', type: 'paragraph', text: '说明。', x: 40, y: 400, w: 400, h: 24, fontSize: 14, color: '#374151' } },
      // opacity:0 的图盖在白卡上，不该污染底色
      { type: 'addNode', pageId: 'home', node: { id: 'ghostImg', type: 'image', src: 'assets/x.jpg', x: 40, y: 40, w: 400, h: 120, opacity: 0 } },
      { type: 'addNode', pageId: 'home', node: { id: 'onWhite', type: 'label', text: '白底黑字', x: 60, y: 80, w: 300, h: 32, fontSize: 18, color: '#111827' } },
    ],
  });
  const m = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('远处装饰图不影响同层底色判定', () => {
    const worst = (m.metrics.contrast.worst || []).map(w => w.id);
    assert.ok(!worst.includes('wt'), `白字被误判：${JSON.stringify(m.metrics.contrast.worst)}`);
  });
  check('不可见图片不污染底色', () => {
    const unknown = m.metrics.contrast.unknownNodes || [];
    assert.ok(!unknown.includes('onWhite'), JSON.stringify(unknown));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
