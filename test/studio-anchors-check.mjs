#!/usr/bin/env node
/**
 * 回归：锚点驱动参考（studio_design_anchors）
 *  - extract 能从已认可页面提炼配方（字阶/留白/色相/主次比）
 *  - compare 对其他页给出可复现的偏离量，而不是"不够高级"
 *  - 没有锚点时明确报错，不编造参照
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeInProcessStudioServer, studioHandlers } from '../studio/mcp-adapter.mjs';

test('锚点驱动参考（studio_design_anchors）', async (t) => {
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };
const dir = mkdtempSync(join(tmpdir(), 'zee-anchors-'));
try {
const open = await studioHandlers.studio_open_project({ projectDir: dir, name: '锚点测试', domain: 'web', port: 0 });

const empty = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'compare', pageId: 'home' });
check('没有锚点时明确拒绝', () => assert.equal(empty.ok, false));
check('拒绝原因可读', () => assert.match(String(empty.message || ''), /还没有锚点/));

await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: open.appliedRevision,
  idempotencyKey: 'anchor-build-1',
  commands: [
    { type: 'addNode', pageId: 'home', node: { id: 'hero', type: 'box', w: 1180, h: 420, fill: '#0F172A' } },
    { type: 'addNode', pageId: 'home', node: { id: 't', type: 'label', text: '把续费跟进压到 4 小时', w: 600, h: 60, fontSize: 44, fontWeight: 700, color: '#FFFFFF' } },
    { type: 'addNode', pageId: 'home', node: { id: 's', type: 'label', text: '订单与收入口径在一屏内闭合。', w: 600, h: 28, fontSize: 16, color: '#475569' } },
  ],
});

// 这页在严格判定下可能未达标；用显式认可（approve）把它立为锚点——
// approve 正是为"认可但未过 bar"的页面准备的；approvedBy 记录真实调用方（T-E-6）。
const extracted = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'approve', pages: ['home'] });
check('提炼成功', () => assert.equal(extracted.ok, true));
check('配方含字阶', () => assert.ok(extracted.anchors[0].recipe.typeScale.sizes.length >= 2));
check('配方含主次比', () => assert.ok(Number.isFinite(extracted.anchors[0].recipe.hierarchy.dominanceRatio)));
check('汇总给出均值', () => assert.ok(Number.isFinite(extracted.summary.dominanceRatioMean)));

const listed = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'list' });
check('list 可读回', () => assert.equal(listed.anchors.length, 1));

const compared = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'compare', pageId: 'home' });
check('compare 返回偏离项', () => assert.ok(Array.isArray(compared.deviations) && compared.deviations.length >= 3));
check('偏离项带 current/anchor 数值', () => assert.ok(compared.deviations.every(d => 'current' in d && 'anchor' in d)));
check('结论是数字句而非形容词', () => assert.match(compared.note, /\d|容差/));
check('给出方向性建议而不是只报偏离', () => {
  assert.ok(Array.isArray(compared.suggestions), '缺少 suggestions');
  for (const item of compared.suggestions) {
    assert.ok(item.action && item.action.length > 8, `建议太短：${JSON.stringify(item)}`);
    assert.ok(!/不够高级|更有设计感/.test(item.action), '建议里出现空话');
  }
});

check('百分比按 % 报，不是 0.xx', () => {
  const pct = compared.deviations.find(d => d.unit === '%');
  assert.ok(pct, '缺少百分比项');
  assert.ok(pct.current > 1, `百分比疑似未换算：${pct.current}%`);
});

check('主次比进入对比', () => {
  const hierarchy = compared.deviations.find(d => d.key === '主次比');
  assert.ok(hierarchy, '缺少主次比对比');
});

console.log('[2] 显式点名的页面由调用方负责（extract/approve 同口径），全量扫描仍按达标线过滤');
const sneaky = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'extract', pages: ['home'] });
check('显式 pages 按点名处理并保持原语料', () => {
  const ids = (sneaky.anchors || []).map(a => a.pageId);
  assert.ok(ids.includes('home'), '原锚点应保留');
});

const approved = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'approve', pages: ['home'] });
// T-E-6：approvedBy 必须如实记录调用方——MCP 通道的默认调用方是 mcp-ai，
// 只有真人经界面/显式传参认可才写 "human"。旧断言 approvedBy==='human' 与该口径矛盾，随发现一并更正。
check('approve 标注真实调用方', () => {
  const anchor = (approved.anchors || []).find(a => a.pageId === 'home');
  assert.ok(anchor, 'approve 后应存在');
  assert.equal(anchor.approvedBy, 'mcp-ai');
});
check('approve 默认是追加而非替换', () => assert.equal(approved.mode, 'append'));

for (const [name, fn] of checks) {
  await t.test(name, fn);
}
} finally {
  await closeInProcessStudioServer();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
});
