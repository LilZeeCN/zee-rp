#!/usr/bin/env node
/**
 * 定向回归：组 G7 度量与素材卫生（T-E-4/5/6/7、T-ER-1/2、T-F-1/2/5、T-FR-1）
 *  - T-E-4 栅格一致性豁免设备画板/root 容器（402×874 不再进 offenders）
 *  - T-E-5/T-ER-2 anchors extract/approve 门槛统一，显式 pageId 只处理该页，同页覆盖保留认可标记
 *  - T-E-6 approvedBy 如实记录调用方（MCP 默认 mcp-ai）
 *  - T-ER-1 anti-slop 计数与 slop 数组一致
 *  - T-E-7 pixel/geometry contrast 翻转复现 + geometry 侧口径说明
 *  - T-F-1 透明 PNG/动图转 JPG 必须带 warnings；T-F-2 令牌过期走 W_MEDIA_TOKEN_STALE
 *  - T-F-5/T-FR-1 多裁切逐项隔离，失败单不留未登记孤儿
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioHandlers } from '../studio/mcp-adapter.mjs';
import { computeDesignMetrics } from '../studio/design-metrics.mjs';
import { prepareMedia } from '../studio/media.mjs';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// ---------------------------------------------------------------------------
console.log('[1] T-E-4：设备画板/root 容器不进栅格 offenders');
const dir = mkdtempSync(join(tmpdir(), 'zee-g7-'));
const open = await studioHandlers.studio_open_project({ projectDir: dir, name: 'G7 度量', domain: 'mobile', port: 4641 });
let rev = open.appliedRevision;
const addBoard = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: rev,
  idempotencyKey: 'g7-board-1',
  commands: [
    { type: 'addPage', pageId: 'g7m', name: 'G7 画板页', domain: 'mobile', w: 402, h: 874 },
    { type: 'addNode', pageId: 'g7m', node: { id: 'odd_box', type: 'box', x: 12, y: 12, w: 103, h: 44, fill: '#334455' } },
    { type: 'addNode', pageId: 'g7m', node: { id: 'grid_box', type: 'box', x: 12, y: 64, w: 100, h: 44, fill: '#556677' } },
    { type: 'addNode', pageId: 'g7m', node: { id: 't1', type: 'label', text: '标题一', x: 12, y: 116, w: 200, h: 28, fontSize: 18, color: '#111111' } },
  ],
});
rev = addBoard.appliedRevision;
const geo = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'g7m', pixelTruth: false });
const offenders = geo.metrics.gridAlignment.offenders;
check('402/874 不再出现在 offenders', () => {
  assert.ok(offenders.every(o => o.value !== 402 && o.value !== 874), JSON.stringify(offenders));
});
check('offender 全部来自内容节点（103 仍在）', () => {
  assert.ok(offenders.some(o => o.id === 'odd_box' && o.value === 103), JSON.stringify(offenders));
});
check('栅格一本账仍成立：total-aligned == offenderCount', () => {
  const grid = geo.metrics.gridAlignment;
  assert.equal(grid.total - grid.aligned, grid.offenderCount);
});

// ---------------------------------------------------------------------------
console.log('[2] T-ER-1：anti-slop 计数与 slop 数组一致');
const addSlop = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: rev,
  idempotencyKey: 'g7-slop-1',
  commands: [
    { type: 'addPage', pageId: 'g7s', name: 'G7 slop 页', domain: 'web', w: 1280, h: 800 },
    { type: 'addNode', pageId: 'g7s', node: { id: 'hero_t', type: 'label', text: '让我们一起开启智慧新纪元。', x: 240, y: 40, w: 800, h: 56, fontSize: 40, fontWeight: 700, color: '#111111', textAlign: 'center' } },
    { type: 'addNode', pageId: 'g7s', node: { id: 'c1', type: 'box', x: 40, y: 200, w: 380, h: 180, fill: '#FFFFFF' } },
    { type: 'addNode', pageId: 'g7s', node: { id: 'c2', type: 'box', x: 450, y: 200, w: 380, h: 180, fill: '#FFFFFF' } },
    { type: 'addNode', pageId: 'g7s', node: { id: 'c3', type: 'box', x: 860, y: 200, w: 380, h: 180, fill: '#FFFFFF' } },
  ],
});
rev = addSlop.appliedRevision;
const slopPage = await studioHandlers.studio_design_metrics({ projectDir: dir, pageId: 'g7s', pixelTruth: false });
const slopArr = slopPage.slop || [];
const antiCheck = slopPage.checks.find(c => c.key === 'anti-slop');
check('slop 数组非空（构造页命中规则）', () => assert.ok(slopArr.length >= 1, JSON.stringify(slopArr.map(s => s.rule))));
check('anti-slop 明细里的 headline 数 == slop 数组长度', () => {
  const m = /命中 (\d+) 条反 slop 规则/.exec(antiCheck.detail);
  assert.ok(m, `明细没有可对账的计数：${antiCheck.detail}`);
  assert.equal(Number(m[1]), slopArr.length, `明细 ${m[1]} vs 数组 ${slopArr.length}`);
  const parts = /error (\d+) \/ warn (\d+)/.exec(antiCheck.detail);
  if (parts) assert.equal(Number(parts[1]) + Number(parts[2]), slopArr.length);
});

// ---------------------------------------------------------------------------
console.log('[3] T-E-5/T-ER-2：extract/approve 门槛统一，显式 pageId 只处理该页');
const addSparse = await studioHandlers.studio_apply_commands({
  projectDir: dir,
  baseRevision: rev,
  idempotencyKey: 'g7-anchor-1',
  commands: [
    { type: 'addPage', pageId: 'g7sparse', name: 'G7 稀疏页', domain: 'mobile', w: 402, h: 874 },
    { type: 'addNode', pageId: 'g7sparse', node: { id: 'lone', type: 'label', text: '只有一行字', x: 12, y: 40, w: 300, h: 28, fontSize: 16, color: '#111111' } },
  ],
});
const extractOne = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'extract', pageId: 'g7sparse' });
check('显式 pageId 只处理该页（skipped 不含其他页）', () => {
  assert.equal(extractOne.ok, true);
  const skipped = extractOne.skipped || [];
  assert.ok(skipped.every(s => s.pageId === 'g7sparse'), `skipped 泄漏其他页：${JSON.stringify(skipped)}`);
  assert.ok((extractOne.anchors || []).every(a => a.pageId === 'g7sparse'));
});
const approveOne = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'approve', pageId: 'g7sparse' });
check('approve 对同一页同口径成功', () => {
  assert.equal(approveOne.ok, true);
  assert.ok((approveOne.anchors || []).some(a => a.pageId === 'g7sparse'));
});
check('T-E-6：approvedBy 记录 MCP 调用方 mcp-ai，而非 human', () => {
  const file = JSON.parse(readFileSync(join(dir, 'design-anchors.json'), 'utf8'));
  const anchor = file.anchors.find(a => a.pageId === 'g7sparse');
  assert.equal(anchor.approvedBy, 'mcp-ai');
});
check('T-E-6：显式 approvedBy 透传（人工认可可写 human）', async () => {
  const manual = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'approve', pageId: 'g7sparse', approvedBy: 'human' });
  assert.equal(manual.ok, true);
  const file = JSON.parse(readFileSync(join(dir, 'design-anchors.json'), 'utf8'));
  assert.equal(file.anchors.find(a => a.pageId === 'g7sparse').approvedBy, 'human');
});
check('T-ER-2：extract 同页覆盖保留既有认可标记（不再状态依赖绕过）', async () => {
  const again = await studioHandlers.studio_design_anchors({ projectDir: dir, action: 'extract', pageId: 'g7sparse' });
  assert.equal(again.ok, true);
  const file = JSON.parse(readFileSync(join(dir, 'design-anchors.json'), 'utf8'));
  assert.equal(file.anchors.find(a => a.pageId === 'g7sparse').approvedBy, 'human');
});

// ---------------------------------------------------------------------------
console.log('[4] T-E-7：pixel 与 geometry 对重叠文本结论翻转复现 + 口径标注');
const flipPage = {
  id: 'flip', domain: 'mobile', board: { screenW: 402, screenH: 874 },
  nodes: [
    { id: 'bg', type: 'box', x: 0, y: 0, w: 402, h: 874, fill: '#FFFFFF', parentId: null, renderOrder: 0 },
    { id: 'ta', type: 'label', text: '底层文字', x: 100, y: 100, w: 200, h: 40, fontSize: 16, color: '#111111', parentId: null, renderOrder: 1 },
    { id: 'tb', type: 'label', text: '覆盖文字', x: 130, y: 112, w: 200, h: 40, fontSize: 16, color: '#111111', parentId: null, renderOrder: 2 },
  ],
};
const geomMetrics = computeDesignMetrics(flipPage, { pixelContrast: null });
const pixelMetrics = computeDesignMetrics(flipPage, { pixelContrast: [
  { id: 'ta', status: 'unknown', reason: 'overlapping-text-layers', ratio: null, passes: false, required: 4.5 },
  { id: 'tb', status: 'unknown', reason: 'overlapping-text-layers', ratio: null, passes: false, required: 4.5 },
] });
const geomContrast = geomMetrics.checks.find(c => c.key === 'contrast');
const pixelContrast = pixelMetrics.checks.find(c => c.key === 'contrast');
check('翻转复现：geometry 通过 / pixel 因 unknown 不通过', () => {
  assert.equal(geomContrast.ok, true, geomContrast.detail);
  assert.equal(pixelContrast.ok, false, pixelContrast.detail);
});
check('geometry 侧带跨模式口径说明（modeNote）', () => {
  assert.ok(typeof geomMetrics.metrics.contrast.modeNote === 'string' && geomMetrics.metrics.contrast.modeNote.includes('pixel'));
});

// ---------------------------------------------------------------------------
console.log('[5] T-F-1/T-F-2/T-F-5/T-FR-1：媒体 warnings、令牌警告级、逐项隔离与孤儿清理');
const mediaDir = mkdtempSync(join(tmpdir(), 'zee-g7-media-'));
// 累计登记表：每次 prepareMedia 响应里登记过的文件（产物 + 原图）。
// 孤儿判定 = assets/ 目录对登记表的补集必须为空（跨单累计，比单单对比更严）。
const registry = new Set();
const assertNoOrphans = () => {
  const onDisk = readdirSync(join(mediaDir, 'assets'));
  const orphans = onDisk.filter(f => !registry.has(f));
  assert.deepEqual(orphans, [], `未登记孤儿：${orphans.join(', ')}`);
};
const remember = r => {
  for (const item of r.results || []) registry.add(basename(item.src));
  if (r.originalPath) registry.add(basename(r.originalPath));
};
await checkAsync('T-F-1：透明 PNG 转 JPG 带 W_MEDIA_ALPHA_DROPPED，产物元数据记来源格式', async () => {
  const r = await prepareMedia({ projectDir: mediaDir, sourcePath: join(fixtures, 'g7-transparent.png'),
    crops: [{ name: 'trans', w: 200, h: 200, fh: 0.5, scale: 1 }] });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === 'W_MEDIA_ALPHA_DROPPED'), JSON.stringify(r.warnings));
  assert.equal(r.results[0].asset.media.sourceFormat, 'PNG');
  remember(r); assertNoOrphans();
});
await checkAsync('T-F-1：动图 GIF 转 JPG 带 W_MEDIA_ANIMATION_DROPPED', async () => {
  const r = await prepareMedia({ projectDir: mediaDir, sourcePath: join(fixtures, 'g7-anim.gif'),
    crops: [{ name: 'anim', w: 200, h: 200, fh: 0.5, scale: 1 }] });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === 'W_MEDIA_ANIMATION_DROPPED'), JSON.stringify(r.warnings));
  assert.equal(r.results[0].asset.media.sourceFormat, 'GIF');
  remember(r); assertNoOrphans();
});
await checkAsync('T-F-2：不存在的令牌走 W_MEDIA_TOKEN_STALE 警告级，裁切仍产出', async () => {
  const r = await prepareMedia({ projectDir: mediaDir, sourcePath: join(fixtures, 'g7-anim.gif'),
    crops: [{ name: 'stale', w: 100, h: 100, fadeFrom: 10, fadeToToken: 'nope-g7', scale: 1 }], tokens: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  const w = r.warnings.find(x => x.code === 'W_MEDIA_TOKEN_STALE');
  assert.ok(w, JSON.stringify(r.warnings));
  assert.ok(w.message.includes('nope-g7'));
  assert.ok(existsSync(join(mediaDir, r.results[0].src)), '警告级裁切应照常产出');
  remember(r); assertNoOrphans();
});
await checkAsync('T-F-5/T-FR-1：好坏混单逐项隔离，assets 无未登记孤儿', async () => {
  const r = await prepareMedia({ projectDir: mediaDir, sourcePath: join(fixtures, 'g7-anim.gif'),
    crops: [{ name: 'good', w: 64, h: 64, scale: 1 }, { name: 'bad', w: 0, h: 64 }] });
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].code, 'E_MEDIA_RECIPE');
  assert.equal(r.results.length, 1);
  remember(r); assertNoOrphans();
});
await checkAsync('T-F-5：全失败单 ok:false，且不留孤儿（原图按 originalPath 登记）', async () => {
  const r = await prepareMedia({ projectDir: mediaDir, sourcePath: join(fixtures, 'g7-anim.gif'),
    crops: [{ name: 'bad1', w: 0, h: 64 }, { name: 'bad2', w: 64 }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_MEDIA_RECIPE');
  assert.equal(r.failures.length, 2);
  remember(r); assertNoOrphans();
});
await checkAsync('重放确定性：同配方两次调用响应逐字节一致（含 warnings）', async () => {
  const input = { projectDir: mediaDir, sourcePath: join(fixtures, 'g7-transparent.png'),
    crops: [{ name: 'replay', w: 80, h: 80, scale: 1 }] };
  assert.deepEqual(await prepareMedia(input), await prepareMedia(input));
  remember(await prepareMedia(input)); assertNoOrphans();
});

try { rmSync(dir, { recursive: true, force: true }); rmSync(mediaDir, { recursive: true, force: true }); } catch {}
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
