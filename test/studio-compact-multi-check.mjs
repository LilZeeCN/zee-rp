#!/usr/bin/env node
/**
 * 回归：Studio MCP 适配层
 *  S2 多工程并行（互不顶掉）
 *  S3 响应预算（默认 compact，< 12KB，且不静默截断）
 *  S1 addPage 支持 domain / device
 *  S4 命令类型错误可自修复（列可用类型 + cmd 别名）
 *
 * 运行：node test/studio-compact-multi-check.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeInProcessStudioServer, studioHandlers } from '../studio/mcp-adapter.mjs';

test('Studio MCP 多工程并行、响应预算与契约自修复', async (t) => {
const opens = [];
const dirs = [];
const checks = [];

function newDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `zee-studio-${tag}-`));
  dirs.push(dir);
  return dir;
}

const check = (name, fn) => { checks.push([name, fn]); };
try {

console.log('[1] 打开两个工程，应各自独立');
const dirA = newDir('a');
const dirB = newDir('b');
const openA = await studioHandlers.studio_open_project({ projectDir: dirA, name: '工程 A', port: 4451 });
opens.push(openA);
const openB = await studioHandlers.studio_open_project({ projectDir: dirB, name: '工程 B', port: 4451 });
opens.push(openB);

check('A 返回自身 projectDir', () => assert.equal(openA.projectDir, dirA));
check('B 返回自身 projectDir', () => assert.equal(openB.projectDir, dirB));
check('两个实例端口不同', () => assert.notEqual(openA.url, openB.url));
check('openInstances 同时看到两个工程', () => assert.ok(openB.openInstances.length >= 2, `got ${openB.openInstances?.length}`));
let portMismatch = null;
try {
  await studioHandlers.studio_open_project({ projectDir: dirA, port: 4452 });
} catch (error) {
  portMismatch = error;
}
check('复用工程时显式端口不一致会明确拒绝', () => {
  assert.equal(portMismatch?.code, 'E_INSTANCE_PORT_MISMATCH');
  assert.equal(portMismatch?.currentPort, 4451);
  assert.equal(portMismatch?.requestedPort, 4452);
});

console.log('[2] 切回 A 不应被 B 顶掉');
const ctxA = await studioHandlers.studio_get_context({ projectDir: dirA });
check('get_context(A) 指向 A', () => assert.equal(ctxA.projectDir, dirA));
check('get_context 默认 compact', () => assert.equal(ctxA.compact, true));

console.log('[3] 响应预算');
for (const [label, payload] of [['open', openB], ['context', ctxA]]) {
  check(`${label} payloadBytes < 12000`, () => assert.ok(payload.payloadBytes < 12000, `bytes=${payload.payloadBytes}`));
  check(`${label} 保留 revision 与 contentHash`, () => {
    assert.ok(Number.isInteger(payload.appliedRevision));
    assert.ok(typeof payload.contentHash === 'string' && payload.contentHash.length === 64);
  });
  check(`${label} 保留页面索引`, () => assert.ok(Array.isArray(payload.doc?.pages) && payload.doc.pages.length >= 1));
  check(`${label} 节点投影只保留几何要素`, () => {
    const node = payload.scene?.pages?.[0]?.nodes?.find(n => n.type !== 'phone-shell');
    if (!node) return;
    assert.ok(!('firstBaselineOffset' in node), '不应包含测量字段');
    assert.ok(!('ascentPx' in node), '不应包含 ascentPx');
  });
}
check('verbose 可拿回全量', async () => {});
const verboseCtx = await studioHandlers.studio_get_context({ projectDir: dirA, verbose: true });
check('verbose 返回 doc+scene 原样', () => {
  assert.ok(verboseCtx.doc?.components !== undefined, 'verbose 应含完整 components');
  assert.ok(verboseCtx.payloadBytes > ctxA.payloadBytes);
});

console.log('[4] addPage 支持 domain');
const webPage = await studioHandlers.studio_apply_commands({
  projectDir: dirA,
  baseRevision: openA.appliedRevision,
  idempotencyKey: 'test-addpage-web-1',
  commands: [{ type: 'addPage', pageId: 'desk', name: '桌面页', domain: 'web' }],
});
// T-C-2 修复：事务回包不再重复携带 palette/tokens/全部页面，doc 只留身份桩；
// 页面事实改用 studio_get_context 回读（同一 projectPayload 的 compactDoc 路径）。
check('apply 默认 doc 为身份桩，不重复传全量文档', () => {
  assert.equal(webPage.doc?.fullDocument, false);
  assert.equal(webPage.doc?.palette, undefined);
  assert.match(String(webPage.doc?.note), /includeDoc/);
});
const deskCtx = await studioHandlers.studio_get_context({ projectDir: dirA });
check('addPage 写入 domain=web', () => {
  const page = deskCtx.doc.pages.find(p => p.id === 'desk');
  assert.ok(page, 'page missing');
  assert.equal(page.domain, 'web');
});
check('桌面页默认画布 1280x800', () => {
  const page = deskCtx.doc.pages.find(p => p.id === 'desk');
  assert.equal(page.canvas.w, 1280);
  assert.equal(page.canvas.h, 800);
});

console.log('[5] 命令别名与错误可自修复');
const aliasRes = await studioHandlers.studio_apply_commands({
  projectDir: dirA,
  baseRevision: webPage.appliedRevision,
  idempotencyKey: 'test-alias-cmd-1',
  commands: [{ cmd: 'addNode', pageId: 'desk', node: { type: 'box', id: 'aliased', w: 100, h: 40 } }],
});
check('cmd 作为 type 别名可用', () => assert.equal(aliasRes.ok, true));

let invalidText = '';
try {
  const res = await studioHandlers.studio_apply_commands({
    projectDir: dirA,
    baseRevision: aliasRes.appliedRevision,
    idempotencyKey: 'test-invalid-type-1',
    commands: [{ type: 'addPagez' }],
  });
  invalidText = JSON.stringify(res);
} catch (err) {
  invalidText = JSON.stringify(err) + String(err?.message || '');
}
check('未知 type 报错并给出可用类型', () => {
  assert.ok(invalidText.length > 0, '应当有错误响应');
  assert.ok(/addPage/.test(invalidText), '错误应列出 addPage');
  assert.ok(/addNode/.test(invalidText), '错误应列出 addNode');
  assert.ok(/addPagez|未知命令类型|E_INVALID_COMMAND/.test(invalidText));
});

const withDoc = await studioHandlers.studio_apply_commands({
  projectDir: dirA,
  baseRevision: aliasRes.appliedRevision,
  idempotencyKey: 'test-includedoc-1',
  includeDoc: true,
  commands: [{ type: 'addNode', pageId: 'desk', node: { type: 'box', id: 'docopt', w: 10, h: 10 } }],
});
check('includeDoc:true 仍可显式拿回完整 doc', () => {
  assert.ok(withDoc.doc?.palette, '应含 palette');
  assert.ok(Array.isArray(withDoc.doc.pages) && withDoc.doc.pages.length >= 1);
});

console.log('[6] repeater 行过滤');
const repBase = await studioHandlers.studio_apply_commands({
  projectDir: dirB,
  baseRevision: openB.appliedRevision,
  idempotencyKey: 'test-repeater-1',
  commands: [{
    type: 'addNode',
    pageId: openB.doc.pages[0].id,
    node: {
      id: 'rep', type: 'repeater', dataset: 'orders', w: 600, h: 200, rowHeight: 40,
      rows: [{ id: '1', status: '已支付' }, { id: '2', status: '待跟进' }, { id: '3', status: '已支付' }],
    },
  }],
});
check('repeater 节点创建成功', () => assert.equal(repBase.ok, true));
const repFiltered = await studioHandlers.studio_apply_commands({
  projectDir: dirB,
  baseRevision: repBase.appliedRevision,
  idempotencyKey: 'test-repeater-filter-1',
  commands: [{ type: 'repeaterSetFilter', nodeId: 'rep', filter: { field: 'status', equals: '已支付' } }],
});
check('repeaterSetFilter 可用（曾声明但未实现）', () => assert.equal(repFiltered.ok, true));
const repCtx = await studioHandlers.studio_get_context({ projectDir: dirB });
check('过滤后行数正确且可观测', () => {
  const page = repCtx.scene.pages.find(p => p.id === openB.doc.pages[0].id);
  const node = page.nodes.find(n => n.id === 'rep');
  assert.equal(node.rowCount, 2);
  assert.equal(node.totalRows, 3);
  assert.equal(node.filtered, true);
});
let shapeText = '';
try {
  const res = await studioHandlers.studio_apply_commands({
    projectDir: dirB,
    baseRevision: repFiltered.appliedRevision,
    idempotencyKey: 'test-repeater-bad-1',
    commands: [{ type: 'repeaterSetFilter', nodeId: 'rep', filter: { field: 'status' } }],
  });
  shapeText = JSON.stringify(res);
} catch (err) { shapeText = String(err.message || err); }
check('非法过滤器形状被拒', () => assert.ok(/E_FILTER_SHAPE|equals|in/.test(shapeText), shapeText.slice(0, 200)));

for (const [name, fn] of checks) {
  await t.test(name, fn);
}
} finally {
  for (const open of opens) {
    if (open?.url) {
      try { await fetch(`${open.url}/api/shutdown`, { method: 'POST' }).catch(() => {}); } catch {}
    }
  }
  await closeInProcessStudioServer();
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
});
