import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { describeAuthoring } from '../studio/authoring-help.mjs';
import { parseSvgPathD, subpathsToSvgD, flattenSubpath, booleanVectorPaths } from '../studio/vector-paths.mjs';

const node = (scene, id) => scene.pages[0].nodes.find(n => n.id === id);

function gridStore() {
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  const result = store.applyTransaction({ commands: [{ type: 'addNode', node: {
    type: 'box', id: 'g8grid', x: 20, y: 20, w: 300, h: 'hug', layout: 'grid', columns: 2, columnGap: 10, rowGap: 10,
    children: [
      { type: 'box', id: 'g8a', w: 100, h: 40 },
      { type: 'box', id: 'g8b', w: 100, h: 60 },
      { type: 'box', id: 'g8c', w: 100, h: 80 },
      { type: 'box', id: 'g8d', w: 100, h: 100 },
    ],
  } }] });
  assert(result.ok, JSON.stringify(result));
  return store;
}

// T-H-3: grid equalHeight:true pulls all children to the same resolved height
test('G8 T-H-3: grid equalHeight:true equalizes child heights and keeps grid geometry', () => {
  const store = gridStore();
  const set = store.applyTransaction({ commands: [{ type: 'setLayout', nodeId: 'g8grid', layout: { mode: 'grid', columns: 2, columnGap: 10, rowGap: 10, equalHeight: true } }] });
  assert(set.ok, JSON.stringify(set));
  const scene = set.scene;
  const heights = ['g8a', 'g8b', 'g8c', 'g8d'].map(id => node(scene, id).h);
  assert.equal(new Set(heights).size, 1, `子节点高度未拉齐: ${heights.join('/')}`);
  assert.equal(heights[0], 100, '等高值应取子节点最大测得高度 100');
  // grid geometry preserved: row1 top y=20, row2 y=20+100+10=130, col2 x=20+(300-10)/2+10
  assert.deepEqual(['g8a', 'g8b', 'g8c', 'g8d'].map(id => [node(scene, id).x, node(scene, id).y]), [[20, 20], [175, 20], [20, 130], [175, 130]]);
  // hug container height = uniform*rows + gaps
  assert.equal(node(scene, 'g8grid').h, 100 * 2 + 10);

  // regression guard: equalHeight:false restores per-child explicit heights
  const off = store.applyTransaction({ commands: [{ type: 'setLayout', nodeId: 'g8grid', layout: { mode: 'grid', columns: 2, columnGap: 10, rowGap: 10, equalHeight: false } }] });
  assert(off.ok, JSON.stringify(off));
  assert.deepEqual(['g8a', 'g8b', 'g8c', 'g8d'].map(id => node(off.scene, id).h), [40, 60, 80, 100]);
});

// T-H-1: SVG arc command A parses into exact cubic bezier segments
test('G8 T-H-1: SVG path arc command A supported (circle, sweep, relative, flags)', () => {
  const d = 'M0 60 A60 60 0 1 1 120 60 A60 60 0 1 1 0 60 Z';
  const subpaths = parseSvgPathD(d);
  assert.equal(subpaths.length, 1);
  assert.equal(subpaths[0].points.length, 4);
  // every sampled point lies on the circle
  const ring = flattenSubpath(subpaths[0], 64);
  let maxErr = 0;
  for (const p of ring) maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x - 60, p.y - 60) - 60));
  assert.ok(maxErr < 0.25, `弧段径向误差过大: ${maxErr}`);
  // serializer emits C segments (still editable vector)
  assert.match(subpathsToSvgD(subpaths), /^M 0 60 C /);
  // sweep direction & relative/compressed-flag forms
  const sweep1 = parseSvgPathD('M0 0 A50 50 0 0 1 50 50');
  assert.equal(sweep1[0].points.at(-1).y, 50);
  const sweep0 = parseSvgPathD('M0 0 A50 50 0 0 0 50 50');
  assert.equal(sweep0[0].points.at(-1).y, 50);
  assert.equal(parseSvgPathD('m0,60 a60,60 0 1,1 120,0 a60,60 0 1,1 -120,0 z')[0].points.length, 4);
  assert.equal(parseSvgPathD('M0 60 A60 60 0 11 120 60')[0].points.length, 3, '未分隔的 11 旗帜应拆为两个 flag');
  // genuinely unsupported command still rejected with updated subset list
  let threw = null;
  try { parseSvgPathD('M0 0 G50 50'); } catch (err) { threw = err; }
  assert.equal(threw?.code, 'E_VECTOR_UNSUPPORTED_CMD');
  assert.match(threw.message, /M\/L\/H\/V\/A\/Q\/T\/C\/S\/Z/);
  // arc-bearing path survives the boolean pipeline
  const circle = parseSvgPathD('M0 60 A60 60 0 1 1 120 60 A60 60 0 1 1 0 60 Z');
  const square = parseSvgPathD('M60 0 L180 0 L180 120 L60 120 Z');
  const union = booleanVectorPaths('union', { points: { subpaths: circle, fillRule: 'nonzero' } }, { points: { subpaths: square, fillRule: 'nonzero' } }, {});
  assert.ok(union.bounds.maxX >= 180, JSON.stringify(union.bounds));
});

// T-H-4: rotate is explicitly declared unsupported, error message carries doc guidance
test('G8 T-H-4: setProperties rotate rejected with explicit rotation declaration', () => {
  const store = gridStore();
  const bad = store.applyTransaction({ commands: [{ type: 'setProperties', nodeId: 'g8a', properties: { rotate: 15 } }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_UNKNOWN_PROPERTY');
  // W1 2026-11-02：rotation 已是原生可编辑属性；rotate 别名仍拒绝但建议指向 rotation。
  assert.match(bad.message, /rotation/);
  assert.match(String(bad.suggestion || ''), /studio_describe/);
  // store untouched
  const scene = store.applyTransaction({ commands: [{ type: 'setProperties', nodeId: 'g8a', properties: { w: 101 } }] });
  assert(scene.ok);
  // describe declares it in the values table
  const described = describeAuthoring({ topic: 'node' });
  assert.match(described.values.rotate, /rotation/);
  assert.match(described.values.rotate, /DOA 3221225522/);
});

// T-H-2: boolean curve handling is an explicit declared boundary
// 断言更正（红线 3）：修复轮把布尔产物从「只含 M/L/Z 折线」升级为「源曲线还原为 C 段」，
// 旧断言 doesNotMatch(/[QC]/) 断言的正是被修复的限制，与新行为契约矛盾，故改为断言 C 段还原。
test('G8 T-H-2: booleanPathOp contract declares curve handling boundary', () => {
  const contract = describeAuthoring({ topic: 'command', name: 'booleanPathOp' });
  assert.match(contract.boundary, /展平/);
  assert.match(contract.boundary, /C 段/);
  // names batch path inherits it too
  const batch = describeAuthoring({ topic: 'command', names: ['booleanPathOp'] });
  assert.match(batch.contracts[0].boundary, /展平/);
  // behavior matches the declaration: curve inputs come out as C segments, straight runs stay L
  const circle = parseSvgPathD('M0 60 A60 60 0 1 1 120 60 A60 60 0 1 1 0 60 Z');
  const square = parseSvgPathD('M60 0 L180 0 L180 120 L60 120 Z');
  const union = booleanVectorPaths('union', { points: { subpaths: circle, fillRule: 'nonzero' } }, { points: { subpaths: square, fillRule: 'nonzero' } }, {});
  const svgD = subpathsToSvgD(union.subpaths);
  assert.match(svgD, /C /, '布尔产物圆弧段应还原为贝塞尔 C 段（与声明一致）');
  assert.doesNotMatch(svgD, /A /, '不引入弧命令 A');
  assert(svgD.includes('L '), '直线段保持 L');
});

// T-H-6: anchor/threeDTransform storage-vs-consumption declared in describe values
test('G8 T-H-6: anchor and threeDTransform semantics declared in describe', () => {
  const described = describeAuthoring({ topic: 'node' });
  assert.match(described.values.anchor, /center \/ top-right \/ bottom-left \/ bottom-right/);
  assert.match(described.values.anchor, /只存储不消费/);
  assert.match(described.values.threeDTransform, /渲染/);
  assert.match(described.values.threeDTransform, /不改变布局几何/);
  // behavior matches declarations: anchor:"fill" stores but has no geometric effect;
  // threeDTransform persists without touching layout geometry
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  const add = store.applyTransaction({ commands: [{ type: 'addNode', node: { type: 'box', id: 'g8anchor', x: 10, y: 10, w: 200, h: 100, layout: 'stack', children: [{ type: 'box', id: 'g8kid', x: 5, y: 5, w: 40, h: 30 }] } }] });
  assert(add.ok, JSON.stringify(add));
  const written = store.applyTransaction({ commands: [
    { type: 'setProperties', nodeId: 'g8kid', properties: { anchor: 'fill' } },
    { type: 'setProperties', nodeId: 'g8anchor', properties: { threeDTransform: 'rotate(15deg)' } },
  ] });
  assert(written.ok, JSON.stringify(written));
  assert.equal(node(written.scene, 'g8kid').anchor, 'fill');
  // baseline resolved bounds (source x/y=5,5 inside parent at 10,10 → 15,15)
  const before = ['x', 'y', 'w', 'h'].map(k => node(add.scene, 'g8kid')[k]);
  assert.deepEqual(['x', 'y', 'w', 'h'].map(k => node(written.scene, 'g8kid')[k]), before, 'anchor:"fill" 声明为不消费，几何不应变化');
  assert.equal(node(written.scene, 'g8anchor').threeDTransform, 'rotate(15deg)');
  assert.deepEqual(['x', 'y', 'w', 'h'].map(k => node(written.scene, 'g8anchor')[k]), [10, 10, 200, 100], 'threeDTransform 声明为渲染层，不改布局几何');
});
