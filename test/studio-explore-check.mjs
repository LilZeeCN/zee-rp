#!/usr/bin/env node
/**
 * 回归：批量探索与自动收敛（studio_design_explore）
 *
 * 验的不是"生成得好看"，而是：
 *  1) 变体按可复现判据排序（未达标项 → 硬伤 → 提示 → 改动量）
 *  2) 入选变体的 commands 能直接提交并真的改动文档
 *  3) 不返回审美总分
 *  4) 参数救了不了的项要明说（不许假装能修）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioHandlers } from '../studio/mcp-adapter.mjs';

const dir = mkdtempSync(join(tmpdir(), 'zee-explore-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};

const open = await studioHandlers.studio_open_project({ projectDir: dir, name: '探索测试', domain: 'web', port: 4601 });

// 一屏内容：结构尚可，但间距/字阶都不在刻度上
const built = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: open.appliedRevision,
  idempotencyKey: 'explore-build-1',
  commands: [
    { type: 'addNode', pageId: 'home', node: {
      id: 'hero', type: 'box', layout: 'column', w: 'fill', h: 260, gap: 7, padding: 13, fill: '#0F172A',
      children: [
        { id: 'h1', type: 'label', text: '把季度续费跟进压到 4 小时', w: 'fill', h: 52, fontSize: 33, fontWeight: 700, color: '#FFFFFF' },
        { id: 'sub', type: 'label', text: '订单、回访与收入口径在一屏内闭合。', w: 'fill', h: 25, fontSize: 15, color: '#CBD5E1' },
      ],
    } },
    { type: 'addNode', pageId: 'home', node: {
      id: 'grid3', type: 'box', layout: 'row', w: 'fill', h: 150, gap: 11,
      children: [
        { id: 'c1', type: 'box', layout: 'column', w: 300, h: 150, padding: 13, gap: 7, radius: 12, fill: '#F8FAFC', children: [{ id: 'c1t', type: 'label', text: '订单', w: 200, h: 24, fontSize: 15, color: '#0F172A' }] },
        { id: 'c2', type: 'box', layout: 'column', w: 300, h: 150, padding: 13, gap: 7, radius: 12, fill: '#F8FAFC', children: [{ id: 'c2t', type: 'label', text: '回访', w: 200, h: 24, fontSize: 15, color: '#0F172A' }] },
      ],
    } },
  ],
});
check('测试页创建成功', () => assert.equal(built.ok, true));

const result = await studioHandlers.studio_design_explore({ projectDir: dir, pageId: 'home', limit: 8 });
check('探索返回成功', () => assert.equal(result.ok, true));
check('至少生成一个变体', () => assert.ok(result.variants.length >= 2, `got ${result.variants.length}`));

check('排序单调：未达标项不增、硬伤不增', () => {
  for (let i = 1; i < result.variants.length; i++) {
    const prev = result.variants[i - 1].score;
    const cur = result.variants[i].score;
    assert.ok(prev.blocking <= cur.blocking, `blocking 逆序 ${prev.blocking} → ${cur.blocking}`);
    if (prev.blocking === cur.blocking) {
      assert.ok(prev.slopErrors <= cur.slopErrors, 'slop 逆序');
    }
  }
});

check('每个变体都带可提交命令或为空（基线）', () => {
  for (const v of result.variants) {
    if (v.id === 'baseline') continue;
    assert.ok(Array.isArray(v.commands) && v.commands.length > 0, `${v.id} 没有命令`);
  }
});

check('候选池铺开各轴（含被淘汰的尝试），不是循环前缀', () => {
  const tried = [...result.variants, ...(result.discarded || [])].filter(v => v.id !== 'baseline');
  const palettes = new Set(tried.filter(v => v.params?.palette).map(v => v.params.palette));
  const densities = new Set(tried.filter(v => v.params?.density).map(v => v.params.density));
  assert.ok(palettes.size >= 3, `配色只尝试了 ${palettes.size} 种：${[...palettes]}`);
  assert.ok(densities.size >= 2, `密度只尝试了 ${densities.size} 种：${[...densities]}`);
  assert.ok(tried.length >= 6, `尝试的组合只有 ${tried.length} 个`);
});

check('标签与实际命令一致（不出现空转的"密度"）', () => {
  for (const variant of result.variants) {
    if (variant.id === 'baseline') continue;
    if (variant.label.includes('密度')) {
      assert.ok(variant.commands.some(c => c.type === 'setProperties' && (c.properties?.padding || c.properties?.gap)),
        `${variant.id} 标了密度但没有 padding/gap 命令`);
    }
  }
});

check('候选去重：不同变体不能是同一组命令', () => {
  const signatures = result.variants.filter(v => v.id !== 'baseline').map(v => JSON.stringify(v.commands));
  assert.equal(new Set(signatures).size, signatures.length, '存在命令完全相同的候选');
});

check('标签可区分', () => {
  const labels = result.variants.filter(v => v.id !== 'baseline').map(v => v.label);
  assert.equal(new Set(labels).size, labels.length, `标签重复：${labels.join(' / ')}`);
});

check('入选候选不得比基线更多越界元素', () => {
  const baseline = result.variants.find(v => v.id === 'baseline');
  const baseContainment = baseline?.score?.containment ?? 0;
  for (const variant of result.variants) {
    if (variant.id === 'baseline') continue;
    assert.ok((variant.score.containment ?? 0) <= baseContainment,
      `${variant.id} 越界 ${variant.score.containment} > 基线 ${baseContainment}`);
  }
});

check('rule 文本与实际排序键一致', () => {
  assert.match(result.rule, /未达标项数 → 反 slop 硬伤数 → 连续目标/);
});

check('变体暴露 objective 以便审计', () => {
  for (const variant of result.variants) {
    assert.ok(Number.isFinite(variant.score.objective), `${variant.id} 缺 objective`);
    assert.equal(variant.objective, variant.score.objective);
  }
});

check('不返回审美总分', () => {
  const flat = JSON.stringify(result);
  assert.ok(!/aesthetic|beauty|tasteScore/i.test(flat));
});

check('明确说明哪些未达标项不是参数能修的', () => {
  assert.ok(typeof result.advice === 'string' && result.advice.length > 10, result.advice);
  if (result.best?.score?.blocking > 0) {
    assert.ok(/必须改版式|参数级|靠参数修/.test(result.advice), result.advice);
  }
});

// 选中一个带命令的变体并提交
const candidate = result.variants.find(v => v.id !== 'baseline' && v.commands.length > 0);
check('存在可落地候选', () => assert.ok(candidate));
const applied = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: built.appliedRevision,
  idempotencyKey: 'explore-apply-1',
  commands: candidate.commands,
});
check('入选变体的命令可直接提交', () => assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 300)));
check('提交后版本推进', () => assert.ok(applied.appliedRevision > built.appliedRevision));
check('文档确实变了（不是空转）', () => assert.notEqual(applied.contentHash, built.contentHash));

const after = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
check('应用后能重新度量', () => assert.ok(Array.isArray(after.checks)));

console.log('[8] 堆叠页结构轴：三等分块要能变成有主次');
const stacked = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: applied.appliedRevision,
  idempotencyKey: 'explore-stack-1',
  commands: [
    { type: 'addPage', pageId: 'stack', name: '堆叠页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'stack', node: { id: 's_t', type: 'label', text: '让设计更有温度', w: 700, h: 56, fontSize: 40, fontWeight: 700, textAlign: 'center', color: '#111827' } },
    { type: 'addNode', pageId: 'stack', node: { id: 's1', type: 'box', w: 320, h: 200, fill: '#E5E7EB', radius: 16 } },
    { type: 'addNode', pageId: 'stack', node: { id: 's2', type: 'box', w: 320, h: 200, fill: '#E5E7EB', radius: 16 } },
    { type: 'addNode', pageId: 'stack', node: { id: 's3', type: 'box', w: 320, h: 200, fill: '#E5E7EB', radius: 16 } },
  ],
});
check('堆叠页创建成功', () => assert.equal(stacked.ok, true));
const stackExplore = await studioHandlers.studio_design_explore({ projectDir: dir, pageId: 'stack', limit: 10 });
const hierarchyVariant = stackExplore.variants.find(v => v.id !== 'baseline'
  && v.commands.some(c => c.type === 'setProperties' && c.properties?.h));
check('结构轴会改高度（不是只调色）', () => assert.ok(hierarchyVariant, '没有产生改高度的候选'));
check('结构轴候选能把未达标项降下来', () => {
  const baseline = stackExplore.variants.find(v => v.id === 'baseline');
  const best = stackExplore.best;
  assert.ok(best, '缺少 best');
  assert.ok(best.score.blocking <= (baseline?.score.blocking ?? Infinity),
    `best=${best.id} blocking=${best.score.blocking} baseline=${baseline?.score.blocking}`);
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
// 关掉探针起的实例，避免事件循环挂着让测试"看起来卡住"
for (const { url } of result?.openInstances || []) {
  try { await fetch(`${url}/api/shutdown`, { method: 'POST' }).catch(() => {}); } catch {}
}
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
