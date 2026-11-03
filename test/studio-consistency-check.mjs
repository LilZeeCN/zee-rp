#!/usr/bin/env node
/**
 * 回归：三个工具对同一 revision 不能互相打脸（试用者连提两轮的问题）
 *
 *  1) 有越界时 metrics 不得判 meets-l1-bar
 *  2) explore 不得推荐越界更严重的候选
 *  3) 提交 best 后，实跑 containment 不得比仿真更差
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioHandlers } from '../studio/mcp-adapter.mjs';

const dir = mkdtempSync(join(tmpdir(), 'zee-consistency-'));
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};

const open = await studioHandlers.studio_open_project({ projectDir: dir, name: '一致性', domain: 'web', port: 4730 });
const built = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: open.appliedRevision,
  idempotencyKey: 'consistency-1',
  commands: [{
    type: 'addNode',
    pageId: 'home',
    node: {
      id: 'free', type: 'box', layout: 'stack', x: 0, y: 0, w: 1280, h: 800,
      children: [
        { id: 't', type: 'label', text: '季度复盘', x: 40, y: 40, w: 600, h: 36, fontSize: 24, fontWeight: 700, color: '#111827' },
        { id: 'far', type: 'box', x: 1200, y: 400, w: 200, h: 120, fill: '#E5E7EB' },
        { id: 'c0', type: 'box', x: 40, y: 140, w: 300, h: 220, fill: '#E5E7EB', radius: 16 },
        { id: 'c1x', type: 'box', x: 380, y: 140, w: 300, h: 220, fill: '#E5E7EB', radius: 16 },
      ],
    },
  }],
});
check('越界页创建成功', () => assert.equal(built.ok, true));

const metrics = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
const containment = metrics.metrics.containment;
check('metrics 能看见越界', () => assert.ok(containment.total >= 1, JSON.stringify(containment)));
check('有越界时不得判合格', () => assert.equal(metrics.l1.ok, false));
check('越界项被点名', () => assert.match(String(metrics.checks.find(c => c.key === 'containment').detail), /far|越出画板/));

const explore = await studioHandlers.studio_design_explore({ projectDir: dir, pageId: 'home', limit: 8 });
const baselineVariant = explore.variants.find(v => v.id === 'baseline');
const baselineContainment = baselineVariant?.score?.containment ?? containment.total;
check('explore 与 metrics 的越界数一致', () => assert.equal(baselineContainment, containment.total));
check('入选候选的越界不得高于基线', () => {
  for (const variant of explore.variants) {
    if (variant.id === 'baseline') continue;
    assert.ok((variant.score.containment ?? 0) <= baselineContainment,
      `${variant.id} containment ${variant.score.containment} > ${baselineContainment}`);
  }
});
check('被淘汰的候选给出具体理由', () => {
  for (const item of explore.discarded || []) {
    assert.ok(item.reason && item.reason !== '硬指标退化', `理由太笼统：${item.reason}`);
  }
});

const candidate = explore.variants.find(v => v.id !== 'baseline' && v.commands.length);
if (candidate) {
  const applied = await studioHandlers.studio_apply_commands({
    projectDir: dir,
    baseRevision: built.appliedRevision,
    idempotencyKey: 'consistency-apply-1',
    commands: candidate.commands,
  });
  check('候选命令可提交', () => assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 200)));
  const after = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'home' });
  check('实跑越界不高于仿真', () => {
    assert.ok(after.metrics.containment.total <= (candidate.score.containment ?? baselineContainment),
      `实跑 ${after.metrics.containment.total} > 仿真 ${candidate.score.containment}`);
  });
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
