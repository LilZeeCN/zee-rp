// 容器层：局部写回时未改动记录的字节保全，以及 manifest 不可压缩时的行为边界。
//
// 覆盖：
//   1  多包容器只改其中一个包：其余包的压缩字节、解压字节与 SHA-256 全部不变
//   2  工具解不出来的包（含未知 Tag）同样原样保留，不因别的包被改而受影响
//   3  单条替换与多条替换对未改动包的保证一致
//   4  连续改写后 manifest 偏移与实际位置始终一致
//   5  manifest 不可压缩时保持报错，不写 Axure 打不开的文件（原生反例，见测试内注释）
// 不依赖本机 Axure 或空白模板：容器与记录都按真实格式现场合成。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeManifest, readManifest, readRecords, replaceRecord, replaceRecords, parseRecord } from '../scripts/rp-records.mjs';
import { parsePayload } from '../scripts/parse-payload.mjs';

const header = Buffer.alloc(8);
header[0] = 0xac; header[1] = 0xef; header.writeUInt16LE(9, 2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
// 确定性伪随机字节
const entropy = length => {
  let state = 0x9e3779b9;
  return Buffer.from(Array.from({ length }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state & 255;
  }));
};

// 合成多包容器：8B 外层头 + manifest + 若干 [00000000][u32 压缩长度][gzip 记录]
function package_(raw) {
  const compressed = gzipSync(raw);
  return { raw, compressed, bytes: Buffer.concat([Buffer.alloc(4), u32(compressed.length), compressed]) };
}
function container(packages) {
  const children = {};
  let relative = 0;
  for (const [key, pkg] of Object.entries(packages)) {
    children[key] = { parts: { package: relative } };
    relative += pkg.bytes.length;
  }
  return Buffer.concat([encodeManifest(header, { root: { children } }), ...Object.values(packages).map(pkg => pkg.bytes)]);
}
function pageRecord(name, extra = 0) {
  const strings = ['Axure:Page', name, 'x'];
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xc351, 20);
  head.writeUInt32LE(strings.length, 28);
  const frame = Buffer.concat([u32(0x1e), u32(0), u32(0x1a), u32(0xf), u32(1), u32(0x12), u32(2),
    u32(9), u32(1), u32(1), u32(1), u32(1), u32(8), u32(2), u32(3), u32(extra), u32(0x1c)]);
  return Buffer.concat([head, ...strings.map(text => { const b = Buffer.from(text); return Buffer.concat([u32(b.length), b]); }), frame]);
}
function undecodableRecord() {
  // 顶层框架位置的未知 Tag：现有工具解不出来，但字节仍然应当被保全
  const base = pageRecord('locked');
  const tail = Buffer.from(base.subarray(base.length - 40)); // 框架里从顶层对象的 Tag 起
  tail.writeUInt32LE(0x7b, 0);
  return Buffer.concat([base.subarray(0, base.length - 40), tail]);
}
const packageRange = (file, record) => file.subarray(record.offset - 8, record.offset + record.compressedSize);

test('只改一个包：其余包的压缩字节、解压字节与 SHA-256 全部不变', () => {
  const packages = { a: package_(pageRecord('home', 1)), b: package_(pageRecord('orders', 2)), c: package_(pageRecord('locked', 3)), d: package_(pageRecord('report', 4)) };
  const file = container(packages);
  const before = readRecords(file);
  assert.equal(before.length, 4);
  const edited = replaceRecords(file, [{ record: before[2], raw: pageRecord('orders-edited', 99) }]);
  const after = readRecords(edited);
  assert.equal(after.length, 4);
  for (const index of [0, 1, 3]) {
    assert.ok(packageRange(edited, after[index]).equals(packageRange(file, before[index])), `包 ${index} 的压缩字节变了`);
    assert.equal(sha(after[index].raw), sha(before[index].raw));
  }
  assert.equal(after[2].strings[1], 'orders-edited');
  assert.notEqual(sha(after[2].raw), sha(before[2].raw));
  // manifest 里未改动条目的相对偏移保持原值，被改的条目相应平移
  const manifest = readManifest(edited).value.root.children;
  assert.equal(manifest.a.parts.package, 0);
  assert.equal(manifest.b.parts.package, readManifest(file).value.root.children.b.parts.package);
  assert.equal(manifest.c.parts.package, readManifest(file).value.root.children.c.parts.package);
  assert.equal(manifest.d.parts.package, manifest.c.parts.package + packageRange(edited, after[2]).length);
});

test('工具解不出来的包同样原样保留', () => {
  const locked = undecodableRecord();
  assert.throws(() => parsePayload({ raw: locked, ...parseRecord(locked) }), /Unknown tag 0x7b/);
  const packages = { a: package_(pageRecord('home')), locked: package_(locked), c: package_(pageRecord('report')) };
  const file = container(packages);
  const before = readRecords(file);
  const edited = replaceRecords(file, [{ record: before[0], raw: pageRecord('home-edited', 7) }]);
  const after = readRecords(edited);
  assert.ok(packageRange(edited, after[1]).equals(packageRange(file, before[1])), '解不出来的包被改动了');
  assert.equal(after[0].strings[1], 'home-edited');
});

test('单条替换与多条替换对未改动包的保证一致', () => {
  const packages = { a: package_(pageRecord('a')), b: package_(pageRecord('b')), c: package_(pageRecord('c')) };
  const file = container(packages);
  const before = readRecords(file);
  const single = replaceRecord(file, before[0], pageRecord('a2', 5));
  const both = replaceRecords(file, [{ record: before[0], raw: pageRecord('a2', 5) }, { record: before[2], raw: pageRecord('c2', 6) }]);
  assert.ok(packageRange(single, readRecords(single)[1]).equals(packageRange(file, before[1])));
  assert.ok(packageRange(single, readRecords(single)[2]).equals(packageRange(file, before[2])));
  assert.ok(packageRange(both, readRecords(both)[1]).equals(packageRange(file, before[1])));
  assert.deepEqual(readRecords(both).map(r => r.strings[1]), ['a2', 'b', 'c2']);
});

test('连续改写后 manifest 偏移与实际位置始终一致', () => {
  const packages = { p: package_(pageRecord('x')), q: package_(pageRecord('y')) };
  let file = container(packages);
  for (let round = 1; round <= 6; round++) {
    const records = readRecords(file);
    assert.equal(records.length, 2);
    file = replaceRecords(file, [{ record: records[round % 2], raw: pageRecord(`r${round}`, round) }]);
    const manifest = readManifest(file);
    for (const [key, index] of [['p', 0], ['q', 1]]) {
      assert.equal(manifest.dataStart + manifest.value.root.children[key].parts.package + 8, readRecords(file)[index].offset, `第 ${round} 轮 ${key} 的 manifest 偏移与实际位置不符`);
    }
  }
  // 第 6 轮改的是第 0 个包，第 5 轮改的是第 1 个包
  assert.deepEqual(readRecords(file).map(r => r.strings[1]), ['r6', 'r5']);
});

test('manifest 不可压缩时保持报错，不写 Axure 打不开的文件', () => {
  // 曾把这里改成回退为纯字面量 LZ4 block，自己的解码器往返完美。但 Axure 用 K4os.Compression.LZ4 的分块流读 manifest，
  // RP9 与 RP11 的加载器对这种块都抛 EndOfStreamException（AcquireNextChunk），文件打不开。
  // 真实形态的 manifest 里 JSON 结构（重复的 ":{" 等）总能压短几个字节，正常走不到这个分支；走到了就必须报错。
  const value = { root: { children: {}, blob: entropy(400).toString('base64') } };
  assert.throws(() => encodeManifest(header, value), /Manifest requires an uncompressed-chunk encoding; not yet supported/);
  // 对照：带高熵备注但仍有可压缩结构的 manifest 照常可读回
  const normal = { root: { children: { '0259b40efa2d402e8a7355adc66d9530': { parts: { package: 610 } }, 'fbeec9e09ca74b7d97349aa3a50c4edc': { parts: { package: 30713 } } }, note: entropy(160).toString('base64') } };
  for (let round = 1; round <= 100; round++) {
    const encoded = encodeManifest(header, normal);
    assert.deepEqual(readManifest(Buffer.concat([encoded, Buffer.alloc(64)])).value, normal);
  }
});
