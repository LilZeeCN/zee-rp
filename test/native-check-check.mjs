// native-check：用 Axure 自己的程序集判定文件是否被接受，三种结论不混淆。
//
// 覆盖：
//   1  受保护路径与不存在的文件：拒绝检查
//   2  --version 与文件头不一致：参数错误，不当成对文件的判定
//   3  编辑器版本自述预检（editorReadiness）：缺 .version 或 DocumentSettings 时标记 upgradeModalRisk
//   4  本机有判据时（macOS + Axure + .NET SDK，且存在空白模板）：已知良好文件被接受并列出页面；
//      破坏容器（纯字面量 manifest）的文件被拒绝，且带着 Axure 的原始异常；--compile 验证零 STO 错误并拦截坏表达式
// 公开 CI 没有判据，第 4 项跳过。
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { inspectEditorReadiness, nativeCheck } from '../scripts/native-check.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { encodeManifest, readManifest, readRecords } from '../scripts/rp-records.mjs';

const template = join(homedir(), 'Library', 'Application Support', 'zee-axure', 'templates', 'axure-rp9-blank.rp');

test('受保护路径与不存在的文件拒绝检查', async () => {
  const previous = process.env.AXURE_PROTECTED_PATHS;
  process.env.AXURE_PROTECTED_PATHS = join(tmpdir(), 'zee-native-check-protected.rp');
  try {
    await assert.rejects(() => nativeCheck(join(tmpdir(), 'zee-native-check-protected.rp')), /受保护|protect/i);
  } finally {
    if (previous === undefined) delete process.env.AXURE_PROTECTED_PATHS;
    else process.env.AXURE_PROTECTED_PATHS = previous;
  }
  await assert.rejects(() => nativeCheck(join(tmpdir(), 'zee-native-check-missing.rp')), /文件不存在/);
});

test('--version 与文件头不一致是参数错误', async t => {
  const work = mkdtempSync(join(tmpdir(), 'zee-native-ver-'));
  try {
    const sample = join(work, 'sample-rp9.rp');
    writeFileSync(sample, synthesizeBlankProject({ version: 9 }));
    await assert.rejects(() => nativeCheck(sample, { version: 11 }), /与文件头版本 RP9 不一致/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('editorReadiness 检出完整版本自述与缺失 .version 部件的升级风险', () => {
  for (const version of [9, 11]) {
    const full = synthesizeBlankProject({ version });
    const ok = inspectEditorReadiness(full, version);
    assert.deepEqual(ok, { versionPart: true, documentSettings: true, hasVersionHistory: true, upgradeModalRisk: false });

    const manifest = readManifest(full);
    for (const key of Object.keys(manifest.value.root.parts)) {
      if (key.endsWith('.version')) delete manifest.value.root.parts[key];
    }
    const stripped = Buffer.concat([encodeManifest(full, manifest.value), full.subarray(manifest.dataStart)]);
    const risky = inspectEditorReadiness(stripped, version);
    assert.equal(risky.versionPart, false);
    assert.equal(risky.upgradeModalRisk, true);
  }
});

test('有判据时：良好文件被接受，破坏容器与 STO 错误在 --compile 下被拒绝', { timeout: 180_000 }, async t => {
  if (process.platform !== 'darwin' || !existsSync(template)) return t.skip('需要 macOS、本机 Axure 与 RP9 空白模板');
  const work = mkdtempSync(join(tmpdir(), 'zee-native-check-'));
  try {
    const good = join(work, 'good.rp');
    writeFileSync(good, readFileSync(template));
    const accepted = await nativeCheck(good, { compile: true });
    if (accepted.status === 'unavailable') return t.skip(`判据不可用：${accepted.reason}`);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.version, 9);
    assert.equal(accepted.pages.length, 1);
    assert.equal(accepted.editorReadiness.upgradeModalRisk, false);
    assert.equal(accepted.officialCompile.status, 'accepted');
    assert.equal(accepted.officialCompile.errorCount, 0);
    assert.match(accepted.layer, /官方 HTML/);

    // 注入公式语法错误表达式：加载器会接受，但 --compile 必须抓出 STO 错误并拒绝
    const stoBad = join(work, 'sto-bad.rp');
    const scene = writeNativeScene(synthesizeBlankProject({ version: 9 }), {
      scene: { items: [{ itemType: 1, type: 0, name: 'BadBtn', rect: { location: { x: 20, y: 20 }, size: { width: 120, height: 40 } } }] },
    });
    const { file: withBadExpr } = addInteractions(scene, 'BadBtn', [{
      event: 'OnClick',
      actions: [{ type: 'set-text', target: 'BadBtn', text: '[[1 + * 2]]' }],
    }]);
    writeFileSync(stoBad, withBadExpr);
    const loadOnly = await nativeCheck(stoBad);
    assert.equal(loadOnly.status, 'accepted');
    const compiledBad = await nativeCheck(stoBad, { compile: true });
    assert.equal(compiledBad.status, 'rejected');
    assert.equal(compiledBad.error.code, 'E_OFFICIAL_COMPILE');
    assert.ok(compiledBad.officialCompile.errorCount >= 1);

    // 把 manifest 换成纯字面量块：我们自己的解码器能读回，但 Axure（K4os LZ4 分块流）会拒绝
    const broken = join(work, 'broken.rp');
    const file = readFileSync(template), manifest = readManifest(file);
    const raw = Buffer.from(JSON.stringify(manifest.value));
    const literals = [0xf0];
    for (let rest = raw.length - 15; rest >= 255; rest -= 255) literals.push(255);
    literals.push((raw.length - 15) % 255);
    const block = Buffer.concat([Buffer.from(literals), raw]);
    const varuint = n => { const out = []; do { const byte = n & 127; n = Math.floor(n / 128); out.push(byte | (n ? 128 : 0)); } while (n); return Buffer.from(out); };
    const encoded = Buffer.concat([Buffer.from([1]), varuint(raw.length), varuint(block.length), block]);
    const outer = Buffer.from(file.subarray(0, 8));
    outer.writeUInt32LE(encoded.length, 4);
    writeFileSync(broken, Buffer.concat([outer, encoded, file.subarray(manifest.dataStart)]));
    assert.equal(readRecords(readFileSync(broken)).length, readRecords(readFileSync(template)).length, '自研解码器应当照样读得出——这正是需要原生判据的原因');
    const rejected = await nativeCheck(broken);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.error.code, 'E_ASSEMBLY_PROCESS');
    assert.match(rejected.error.message, /EndOfStreamException/);
    assert.match(rejected.nextAction, /不要在它之上继续叠加修改/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
