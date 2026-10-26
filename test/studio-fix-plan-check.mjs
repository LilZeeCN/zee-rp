#!/usr/bin/env node
/**
 * 回归：修复计划（studio_design_fix_plan）
 *  - 只开确定性处方：热区、空态、撑高文字
 *  - 生成的命令可直接提交，且能减少阻塞项
 *  - 不碰"取舍类"问题（字阶/配色/构图）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioHandlers } from '../studio/mcp-adapter.mjs';

const dir = mkdtempSync(join(tmpdir(), 'zee-fixplan-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};

const open = await studioHandlers.studio_open_project({ projectDir: dir, name: '修复计划', domain: 'web', port: 4850 });
const built = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: open.appliedRevision,
  idempotencyKey: 'fix-build-1',
  commands: [
    { type: 'addNode', pageId: 'home', node: { id: 'r1', type: 'repeater', x: 40, y: 47, w: 400, h: 200, rowHeight: 40, rows: [{ id: '1' }] } },
    { type: 'addNode', pageId: 'home', node: { id: 'tiny', type: 'button', text: '×', x: 500, y: 47, w: 20, h: 20 } },
    { type: 'addNode', pageId: 'home', node: { id: 't1', type: 'label', text: '季度复盘', x: 40, y: 300, w: 500, h: 232, fontSize: 24, fontWeight: 700, color: '#111827' } },
    { type: 'addNode', pageId: 'home', node: { id: 'cap', type: 'paragraph', text: '说明文字。', x: 40, y: 560, w: 400, h: 28, fontSize: 16, color: '#374151' } },
  ],
});
check('页面创建成功', () => assert.equal(built.ok, true));

const before = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
const plan = await studioHandlers.studio_design_fix_plan({ projectDir: dir, pageId: 'home' });
check('产出命令清单', () => assert.ok(Array.isArray(plan.commands) && plan.commands.length >= 1, JSON.stringify(plan).slice(0, 200)));
check('声明为确定性处方', () => assert.equal(plan.deterministic, true));
check('计划自证：给出 before/after', () => {
  assert.equal(plan.verified, true);
  assert.ok(plan.projected?.before && plan.projected?.after, JSON.stringify(plan.projected));
  assert.ok(plan.projected.after.blocking.length <= plan.projected.before.blocking.length);
});
check('修不了的项必须给原因', () => {
  assert.ok(Array.isArray(plan.unfixable) && plan.unfixable.length > 0, JSON.stringify(plan.unfixable));
  for (const item of plan.unfixable) assert.ok(item.reason && item.reason.length > 6, JSON.stringify(item));
});

check('命令必须让整页阻塞项严格减少', () => {
  const before = plan.projected.before.blocking.length;
  const after = plan.projected.after.blocking.length;
  assert.ok(after < before, `before=${before} after=${after}`);
});

check('被拒命令必须说明原因', () => {
  for (const item of plan.rejected || []) assert.ok(item.reason && item.reason.length > 4, JSON.stringify(item));
});
check('热区不做幽灵修复：只列人工项', () => {
  assert.ok(Array.isArray(plan.manual) && plan.manual.some(m => /热区/.test(m.reason)), JSON.stringify(plan.manual));
  assert.ok(!plan.commands.some(c => c.properties?.hitW), '不应写入渲染层未消费的 hitW');
});
check('为空态补节点', () => assert.ok(plan.commands.some(c => c.type === 'addNode' && c.node?.role === 'empty-state')));
check('撑高文字要么被修、要么给出不修的理由', () => {
  const fixed = plan.commands.some(c => c.nodeId === 't1' && c.properties?.h < 100);
  if (fixed) return;
  // 严格标准下，修它会引入别的问题，那就必须出现在 rejected 或 unfixable 里
  const mentioned = [...(plan.rejected || []), ...(plan.unfixable || [])]
    .some(item => JSON.stringify(item).includes('visual-hierarchy') || JSON.stringify(item).includes('t1'));
  assert.ok(mentioned, '既没修也没说明理由');
});
check('不碰取舍类（字阶/配色）', () => {
  const tasteProps = new Set(['fontSize', 'color', 'fill', 'stroke', 'fontWeight']);
  for (const command of plan.commands) {
    if (command.type !== 'setProperties') continue;
    for (const key of Object.keys(command.properties || {})) {
      assert.ok(!tasteProps.has(key), `改到了取舍类属性：${command.nodeId}.${key}`);
    }
  }
});

const applied = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: built.appliedRevision,
  idempotencyKey: 'fix-apply-1',
  commands: plan.commands,
});
check('计划可直接提交', () => assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 200)));

const after = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
check('阻塞项减少', () => {
  assert.ok(after.l1.blocking.length < before.l1.blocking.length,
    `before=${before.l1.blocking.map(b => b.check)} after=${after.l1.blocking.map(b => b.check)}`);
});
check('热区问题如实保留（不靠元数据刷绿）', () => {
  const c = after.checks.find(x => x.key === 'tap-target');
  assert.ok(c && c.ok === false, '热区仍应不通过，除非真的实现了命中区');
  assert.ok((plan.manual || []).some(m => /热区/.test(m.reason)), '应列入人工项');
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
