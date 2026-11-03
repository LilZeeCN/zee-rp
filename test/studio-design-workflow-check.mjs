import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStudioServer } from '../studio/server.mjs';
import { benchmarkRoot, getDesignContext } from '../studio/design-context.mjs';
import { prepareMedia } from '../studio/media.mjs';
import { sha256, importToStudioDocument } from '../studio/document.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
test('reference selection keeps the accepted visual evidence scoped to editorial work', () => {
  const editorial = getDesignContext();
  assert.equal(editorial.reference.id, 'qiyu-field-notes-v1');
  assert.ok(editorial.reference.pageSource);
  assert.equal(Buffer.from(editorial.mcpImages[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.equal(getDesignContext({ intent: 'task' }).reference, null);
  assert.equal(getDesignContext({ intent: 'learning' }).reference, null);
  assert.throws(() => getDesignContext({ intent: 'invented' }), { code: 'E_DESIGN_INTENT' });
});

test('nine media recipes replay the approved crops and preserve the original', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-media-'));
  try {
    const sourcePath = join(benchmarkRoot, 'assets/original/kingfisher.jpg');
    const sourceSha = sha256(readFileSync(sourcePath));
    const crops = JSON.parse(readFileSync(join(benchmarkRoot, 'media-recipes.json'))).crops;
    const input = { projectDir: dir, sourcePath, crops, tokens: { colors: { bg: '#F3EDE1' } }, credit: 'CC0 Frank-2.0; see benchmark CREDITS.md' };
    const result = await prepareMedia(input);
    const replay = await prepareMedia(input);
    assert.deepEqual(result, replay);
    assert.equal(result.results.length, 9);
    for (const item of result.results) {
      const crop = crops.find(c => c.out === item.name);
      assert.equal(item.asset.width, crop.w * 2); assert.equal(item.asset.height, crop.h * 2);
      assert.equal(item.asset.sha256, sha256(readFileSync(join(benchmarkRoot, 'assets', item.name))));
    }
    assert.equal(sha256(readFileSync(sourcePath)), sourceSha);
    const changed = await prepareMedia({ ...input, crops: [crops[0]], tokens: { colors: { bg: '#FFFFFF' } } });
    assert.notEqual(changed.results[0].src, result.results[0].src);
    // T-F-5：多裁切改为逐项隔离——坏配方进 failures 并清理未登记孤儿，不再整单 rejects。
    // 旧断言 assert.rejects(E_MEDIA_SUBJECT_CROP / E_MEDIA_RECIPE) 与该语义矛盾，随发现一并更正。
    const subjectFail = await prepareMedia({ ...input, crops: [{ w: 50, h: 200, protectedRegion: { x: 0, y: 0, w: 1, h: 1 } }] });
    assert.equal(subjectFail.ok, false);
    assert.equal(subjectFail.failures[0].code, 'E_MEDIA_SUBJECT_CROP');
    const recipeFail = await prepareMedia({ ...input, crops: [{ w: 0, h: 200 }] });
    assert.equal(recipeFail.ok, false);
    assert.equal(recipeFail.failures[0].code, 'E_MEDIA_RECIPE');
    // 失败单不得留下未登记孤儿：assets/ 目录对成功响应登记列表（9 配方 + 改令牌重制 1 张）的补集为空。
    const registered = new Set([...result.results, ...changed.results].map(item => basename(item.src)));
    const orphans = readdirSync(join(dir, 'assets')).filter(f => f.startsWith('media-') && !registered.has(f));
    assert.deepEqual(orphans, [], `失败单留下未登记孤儿：${orphans.join(', ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fresh MCP transport delivers images, atomic media history and revision-bound visual review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-design-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')], stderr: 'pipe' });
  const client = new Client({ name: 'studio-design-check', version: '1.0.0' });
  let studio;
  try {
    const path = join(dir, 'source.json');
    writeFileSync(path, JSON.stringify({ device: 'iphone-17-pro', palette: { bg: '#F3EDE1' }, pages: [{ id: 'home', name: '01 测试 页', root: {
      id: 'shell', type: 'phone-shell', padding: 0, statusBar: false, children: [{ id: 'home_screen', type: 'box', layout: 'stack', x: 0, y: 0, w: 402, h: 874, fill: '$bg', children: [
        { id: 'title', type: 'label', x: 24, y: 80, w: 320, h: 40, text: '试着设计一页', fontSize: 24 },
        { id: 'photo', type: 'image', x: 24, y: 140, w: 320, h: 240, src: 'assets/missing.jpg' },
      ] }],
    } }] }));
    const twoPages = JSON.parse(readFileSync(path));
    twoPages.datasets = { inventory: { rows: Array.from({ length: 20 }, (_, i) => ({ label: `设备${i + 1}` })) } };
    twoPages.pages.push({ id: 'second', name: '第二页', root: { id: 'second_root', type: 'box', layout: 'stack', w: 402, h: 874, fill: '#ABCCDD', children: [
      { id: 'inventory_list', type: 'repeater', dataset: 'inventory', x: 28, y: 100, w: 346, h: 300, rowHeight: 48, rowGap: 6 },
    ] } });
    writeFileSync(path, JSON.stringify(twoPages));
    ({ studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath: path, port: 0 }));
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['studio_get_design_context', 'studio_prepare_media', 'studio_review_design']) assert.ok(tools.some(t => t.name === name));
    async function call(name, args = {}) {
      const raw = await client.callTool({ name, arguments: { url: studio.url, ...args } });
      return { raw, value: JSON.parse(raw.content[0].text) };
    }
    await call('studio_open_project', { projectDir: studio.projectDir });
    const context = await call('studio_get_design_context');
    assert.equal(context.raw.content.filter(c => c.type === 'image').length, 1);
    assert.ok(!context.raw.content[0].text.includes('mcpImages'));
    const media = (await call('studio_prepare_media', { sourcePath: join(benchmarkRoot, 'assets/original/kingfisher.jpg'), crops: [{ w: 320, h: 240, fadeFrom: 190, fadeToToken: 'bg' }] })).value.results[0];
    let rev = studio.store.appliedRevision;
    const patch = (await call('studio_apply_commands', { baseRevision: rev, idempotencyKey: 'attach-media', pageId: 'home', commands: [media.registerCommand,
      { type: 'setProperties', nodeId: 'photo', properties: { src: media.src } }] })).value;
    assert.equal(patch.ok, true, JSON.stringify(patch)); rev = patch.appliedRevision;
    assert.ok(studio.store.doc.assetsManifest[media.src]);
    const forkDir = join(dir, 'fork');
    const fork = importToStudioDocument(studio.store.doc, { projectDir: forkDir, baseDir: studio.projectDir });
    assert.equal(fork.assetsManifest[media.src].media.recipeHash, media.asset.media.recipeHash);
    assert.equal(sha256(readFileSync(join(forkDir, media.asset.media.originalPath))), media.asset.media.sourceSha256);
    await call('studio_undo');
    assert.equal(studio.store.doc.assetsManifest[media.src], undefined);
    await call('studio_redo'); rev = studio.store.appliedRevision;
    assert.ok(studio.store.doc.assetsManifest[media.src]);
    const invalid = await call('studio_apply_commands', { baseRevision: rev, idempotencyKey: 'bad-asset-bytes', pageId: 'home', commands: [
      { type: 'registerAsset', asset: { ...media.asset, sha256: '0'.repeat(64) } },
      { type: 'setText', nodeId: 'title', text: '不可部分应用' },
    ] });
    assert.equal(invalid.value.code, 'E_ASSET_BYTES_MISMATCH');
    assert.equal(studio.store.appliedRevision, rev);
    const review = await call('studio_review_design', { baseRevision: rev, pageId: 'home' });
    assert.equal(review.raw.content.filter(c => c.type === 'image').length, 1, JSON.stringify(review.value));
    assert.equal(review.value.status, 'awaiting-visual-review');
    const recorded = (await call('studio_review_design', { baseRevision: rev, pageId: 'home', reviewId: review.value.reviewId,
      observations: [{ nodeIds: ['title'], issue: '标题语气过于通用', consequence:'读者看不出下一步观察什么',decision: '改成具体的观察邀请',preserve:'保留正文和照片焦点' }] })).value;
    assert.equal(recorded.status, 'agent-reviewed'); assert.equal(recorded.userAccepted, false);
    assert.equal(recorded.observations[0].consequence,'读者看不出下一步观察什么');assert.equal(JSON.parse(readFileSync(recorded.reportPath)).observations[0].preserve,'保留正文和照片焦点');
    const change = (await call('studio_apply_commands', { baseRevision: rev, idempotencyKey: 'repaint-screen', pageId: 'home', commands: [
      { type: 'setProperties', nodeId: 'home_screen', properties: { fill: '#112233' } },
      { type: 'setProperties', nodeId: 'photo', properties: { x: 30 } },
    ] })).value;
    assert.equal(change.ok, true); rev = change.appliedRevision;
    const stale = await call('studio_review_design', { baseRevision: recorded.revision, pageId: 'home', reviewId: recorded.reviewId, observations: [{ nodeIds: [], issue: '旧图' }] });
    assert.equal(stale.value.code, 'E_STALE_REVIEW');
    const shot = await call('studio_capture_screenshot', { revision: rev, pageId: 'home' });
    assert.equal(shot.raw.content.filter(c => c.type === 'image').length, 1);
    assert.equal(sha256(Buffer.from(shot.raw.content.find(c => c.type === 'image').data, 'base64')), shot.value.sha256);
    const page = await studio.ensureManagedBrowserPage();
    const style = await page.evaluate(`(() => { const root=document.querySelector('[data-node-id="home_screen"]'); const img=document.querySelector('[data-node-id="photo"]'); return { fill:getComputedStyle(root).backgroundColor, x:img.offsetLeft, island:document.querySelector('.artboard-island').offsetWidth }; })()`);
    assert.deepEqual(style, { fill: 'rgb(17, 34, 51)', x: 30, island: 122 });
    await call('studio_apply_commands', { baseRevision: rev, idempotencyKey: 'change-paper-token', commands: [
      { type: 'setToken', name: 'bg', value: '#FFFFFF' },
    ] }); rev = studio.store.appliedRevision;
    const tokenReview = await call('studio_review_design', { pageId: 'home', baseRevision: rev });
    assert.ok(tokenReview.value.findings.some(f => f.code === 'W_MEDIA_TOKEN_STALE'));
    const refreshed = (await call('studio_prepare_media', { sourcePath: join(benchmarkRoot, 'assets/original/kingfisher.jpg'), crops: [{ w: 320, h: 240, fadeFrom: 190, fadeToToken: 'bg' }] })).value.results[0];
    await call('studio_apply_commands', { baseRevision: rev, idempotencyKey: 'refresh-paper-photo', pageId: 'home', commands: [refreshed.registerCommand,
      { type: 'setProperties', nodeId: 'photo', properties: { src: refreshed.src } },
    ] }); rev = studio.store.appliedRevision;
    const refreshedReview = await call('studio_review_design', { pageId: 'home', baseRevision: rev });
    assert.ok(!refreshedReview.value.findings.some(f => f.code === 'W_MEDIA_TOKEN_STALE'));
    await page.evaluate(`document.getElementById('mode-interact-btn').click()`);
    const second = await call('studio_capture_screenshot', { revision: rev, pageId: 'second' });
    assert.equal(second.value.pageId, 'second', JSON.stringify(second.value));
    assert.equal(await page.evaluate('window.__STUDIO_APP__.state.mode'), 'design');
    assert.deepEqual(await page.evaluate(`(() => { const list=document.querySelector('[data-node-id="inventory_list"]'); list.scrollTop=list.scrollHeight; return { count:list.children.length, last:list.lastElementChild.innerText, scrollable:list.scrollHeight>list.clientHeight }; })()`),
      { count: 20, last: '设备20', scrollable: true });
    const disk = JSON.parse(readFileSync(join(studio.projectDir, 'document.json')));
    assert.equal(disk.revision, rev); assert.ok(disk.assetsManifest[media.src]);
  } finally { await client.close(); await studio?.close(); rmSync(dir, { recursive: true, force: true }); }
});
