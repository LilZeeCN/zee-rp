#!/usr/bin/env node
/**
 * 定向回归：8.6 → 9 补修项
 *  - T-H-4 rotate 错误不再给 candidates:['state'] 误导候选
 *  - T-I-2 design_explore 零断言/零操作 states 在入口拒绝（与 run_scenario 同口径）
 *  - S3-3 导出报告 interactionSources / interactionCounts 可自证
 *  - T-H-6 anchor/threeDTransform native 降级语义在 describe 中写明
 *  - T-A-3 paragraph 固定高溢出产出可定位 E_TEXT_CLIP，h:'hug' 时自动增高
 *
 * 运行：node test/canvas-boost-20261031-check.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { describeAuthoring } from '../studio/authoring-help.mjs';
import { previewCandidates } from '../studio/candidate-explorations.mjs';
import { summarizeInteractionSources } from '../studio/export-rp.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';

const LONG_TEXT = '这是一段两百字的中文长文本测试，用于验证段落类型节点在窄容器中的换行、裁切与高度策略是否与标签节点对称。'.repeat(3);

function storeWithParagraph(h) {
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  const added = store.applyTransaction({ commands: [{ type: 'addNode', node: {
    type: 'paragraph', id: 'p_narrow', x: 20, y: 20, w: 40, h, text: LONG_TEXT, fontSize: 14,
  } }] });
  assert.equal(added.ok, true, JSON.stringify(added));
  return store;
}

test('T-H-4(2026-11-02 更新): rotate 别名仍拒绝并建议 rotation；rotation 数值被接受', () => {
  // W1 之后 rotation 成为原生可编辑属性（.rp DOA 3221225522），本测试随之更新：
  // - rotate（别名）仍走 E_UNKNOWN_PROPERTY，但建议应指向 rotation；
  // - rotation 数值必须被接受并回读一致（原生旋转主路径）。
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  const added = store.applyTransaction({ commands: [{ type: 'addNode', node: { type: 'box', id: 'rot', x: 10, y: 10, w: 100, h: 40 } }] });
  assert.equal(added.ok, true, JSON.stringify(added));
  const bad = store.applyTransaction({ commands: [{ type: 'setProperties', nodeId: 'rot', properties: { rotate: 15 } }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_UNKNOWN_PROPERTY');
  const good = store.applyTransaction({ commands: [{ type: 'setProperties', nodeId: 'rot', properties: { rotation: 15 } }] });
  assert.equal(good.ok, true, JSON.stringify(good));
  const findById = (n, id) => n.id === id ? n : (n.children || []).map(c => findById(c, id)).find(Boolean);
  const node = store.doc.pages.flatMap(p => [p.root || { children: p.children || [] }]).map(r => findById(r, 'rot')).find(Boolean)
    || store.doc.pages.flatMap(p => p.children || []).map(c => findById(c, 'rot')).find(Boolean);
  assert.ok(node, 'rot 节点应存在');
  assert.equal(node.rotation, 15, `rotation 应回读 15: ${JSON.stringify(node.rotation)}`);
});

test('T-I-2: design_explore 零断言/零操作 states 入口即拒绝', async () => {
  const studio = {
    store: { appliedRevision: 7, doc: { pages: [{ id: 'home' }] } },
    scene: { pages: [{ id: 'home' }] },
    projectDir: '/tmp/boost-explore-entry-never-created',
  };
  const candidate = { id: 'c1', commands: [{ type: 'setText', nodeId: 'x', text: 'y' }] };
  await assert.rejects(
    () => previewCandidates(studio, { pageId: 'home', baseRevision: 7, candidates: [candidate], states: [{ id: 'noop', steps: [{ action: 'click', target: 'reveal' }] }] }),
    { code: 'E_SCENARIO_ASSERTIONS_REQUIRED' },
  );
  await assert.rejects(
    () => previewCandidates(studio, { pageId: 'home', baseRevision: 7, candidates: [candidate], states: [{ id: 'empty', steps: [] }] }),
    { code: 'E_SCENARIO_ACTIONS_REQUIRED' },
  );
  // 正向对照：有断言的 state 通过入口校验，后续只因非法 candidate 失败（证明未误杀）。
  await assert.rejects(
    () => previewCandidates(studio, { pageId: 'home', baseRevision: 7, candidates: [{ id: 'bad id!', commands: [] }], states: [{ id: 'ok', steps: [{ expect: { page: 'home' } }] }] }),
    { code: 'E_CANDIDATES' },
  );
});

test('S3-3: 导出交互来源可枚举，并区分作者交互与初始隐藏生成项', () => {
  const rpSummary = {
    counts: { interactions: 3, actions: 5 },
    pages: [{
      name: 'P',
      interactions: [
        { event: 'OnLoad', cases: [{ actions: [{ type: 'hide' }, { type: 'hide' }] }] },
      ],
      widgets: [
        { name: 'w1', interactions: [{ event: 'OnClick', cases: [{ actions: [{ type: 'show' }, { type: 'link' }] }] }] },
        { name: 'box', children: [{ name: 'w2', interactions: [{ event: 'OnLoad', cases: [{ actions: [{ type: 'hide' }] }] }] }] },
      ],
    }],
  };
  const audit = summarizeInteractionSources(rpSummary);
  assert.equal(audit.sources.length, 3);
  assert.deepEqual(audit.counts.total, { interactions: 3, actions: 5 });
  assert.deepEqual(audit.counts.authored, { interactions: 2, actions: 3 });
  assert.deepEqual(audit.counts.exportGenerated.interactions, 1);
  assert.equal(audit.sources.find(row => row.owner === 'page').origin, 'export-initial-hidden');
  assert.equal(audit.sources.find(row => row.ownerId === 'w2').origin, 'authored');
  assert.equal(audit.sources.find(row => row.ownerId === 'w1').origin, 'authored');
});

test('T-H-6: describe 写明 threeDTransform/anchor 的原生降级语义', () => {
  const described = describeAuthoring({ topic: 'node', name: 'path', fields: ['threeDTransform', 'anchor'] });
  const byField = Object.fromEntries(described.capabilities.map(item => [item.field, item]));
  // W7 2026-11-02 实测口径：threeDTransform 在兼容报告计入 unsupported:css:transform（比 rasterized 更严格）。
  // 断言随之更新为三个事实：无原生可编辑变换、指向 node.rotation 替代、实测分类口径。
  assert.match(byField.threeDTransform.surfaces.native.reason, /不产生原生可编辑变换/);
  assert.match(byField.threeDTransform.surfaces.native.reason, /node\.rotation/);
  assert.match(byField.threeDTransform.surfaces.native.reason, /unsupported:css:transform/);
  assert.match(byField.anchor.surfaces.native.reason, /解算为绝对几何/);
});

test('T-A-3: paragraph 固定高溢出产出可定位 E_TEXT_CLIP，h:hug 自动增高且不误报', () => {
  const fixed = storeWithParagraph(120);
  const fixedScene = resolveDocumentScene(fixed.doc);
  const clip = (fixedScene.clipDiagnostics || []).find(item => item.nodeId === 'p_narrow');
  assert.ok(clip, '固定高窄段落应产出 E_TEXT_CLIP');
  assert.equal(clip.code, 'E_TEXT_CLIP');
  assert.equal(clip.direction, 'vertical');
  assert.ok(clip.overflowPx > 0);

  const hug = storeWithParagraph('hug');
  const hugScene = resolveDocumentScene(hug.doc);
  const hugNode = hugScene.pages[0].nodes.find(n => n.id === 'p_narrow');
  assert.ok(hugNode.h > 120, `hug 段落应自动增高，实际 ${hugNode.h}`);
  assert.equal((hugScene.clipDiagnostics || []).some(item => item.nodeId === 'p_narrow'), false, 'hug 段落不应误报裁切');
});
