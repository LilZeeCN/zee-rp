#!/usr/bin/env node
/**
 * 回归：内容脚手架（studio_design_content_plan）
 *  - 找出空态无文案、口号式大标题
 *  - 给出槽位、模板、示例与可提交命令
 *  - 不假装会写文案（caveat 必须有），也不自动改文档
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeInProcessStudioServer, studioHandlers } from '../studio/mcp-adapter.mjs';

test('内容脚手架（studio_design_content_plan）', async (t) => {
const dir = mkdtempSync(join(tmpdir(), 'zee-content-'));
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };
try {
const open = await studioHandlers.studio_open_project({ projectDir: dir, name: '内容', domain: 'web', port: 0 });
const built = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: open.appliedRevision,
  idempotencyKey: 'content-build-1',
  commands: [
    { type: 'addNode', pageId: 'home', node: { id: 'title', type: 'label', text: '让设计更有温度', x: 40, y: 40, w: 600, h: 56, fontSize: 40, fontWeight: 700, textAlign: 'center', color: '#111827' } },
    { type: 'addNode', pageId: 'home', node: { id: 'list', type: 'repeater', dataset: 'orders', x: 40, y: 140, w: 400, h: 200, rowHeight: 40, rows: [{ id: '1' }] } },
    { type: 'addNode', pageId: 'home', node: { id: 'empty', type: 'box', role: 'empty-state', for: 'list', x: 40, y: 360, w: 400, h: 96, fill: '#F8FAFC', children: [{ id: 'empty_label', type: 'label', text: '', w: 240, h: 24, fontSize: 16, color: '#111827' }] } },
  ],
});
check('页面创建成功', () => assert.equal(built.ok, true));

const plan = await studioHandlers.studio_design_content_plan({ projectDir: dir, pageId: 'home' });
check('找出两个待填内容的位置', () => assert.equal(plan.count, 2, JSON.stringify(plan.items)));
check('空态给出槽位与模板', () => {
  const item = plan.items.find(i => i.kind === 'empty-state');
  assert.ok(item && item.template.includes('{动作}'), JSON.stringify(item));
  assert.ok(item.needs.length >= 2);
});
check('口号标题给出具体示例', () => {
  const item = plan.items.find(i => i.kind === 'headline');
  assert.ok(item && /\d/.test(item.example), JSON.stringify(item));
});
check('每条都带可提交命令', () => {
  for (const item of plan.items) {
    assert.ok(item.applyWith && item.applyWith.type === 'setProperties', JSON.stringify(item));
  }
});

check('空态文案写到子节点而不是父容器', () => {
  const item = plan.items.find(i => i.kind === 'empty-state');
  assert.notEqual(item.applyWith.nodeId, item.nodeId, '不应直接写父容器');
});

check('已有文案的空态不误报', () => {
  const written = plan.items.filter(i => i.kind === 'empty-state' && i.nodeId === 'empty');
  assert.ok(written.length === 1, '初始空态应被识别（它确实没有文案）');
});
check('不假装会写文案', () => assert.match(String(plan.caveat), /不假装|判断权/));

const before = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
const applied = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: built.appliedRevision,
  idempotencyKey: 'content-apply-1',
  commands: plan.items.map(i => i.applyWith),
});
check('命令可直接提交', () => assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 200)));
const after = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
check('提交后口号类问题消失', () => {
  const beforeRules = new Set((before.slop || []).map(s => s.rule));
  const afterRules = new Set((after.slop || []).map(s => s.rule));
  assert.ok(beforeRules.has('vague-centered-hero'));
  assert.ok(!afterRules.has('vague-centered-hero'));
});

for (const [name, fn] of checks) {
  await t.test(name, fn);
}
} finally {
  await closeInProcessStudioServer();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
});
