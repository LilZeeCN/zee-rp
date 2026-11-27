// 未知 Tag 无损透传与载荷解析的内存安全。
//
// 覆盖：
//   1  只含已知 Tag 的 payload 行为不变：不产生 unknownLayouts，重编码逐字节相等
//   2  未知定宽标量：唯一布局被采信为不透明节点，载荷原样写回，周围的已知节点照常可改
//   3  未知 dict / list 字段：采信为透明容器，子节点是真实节点，改子节点能写回去
//   4  同一个未知码多次出现时共用同一种布局
//   5  多解、无解、候选集外的宽度：一律报错，不猜边界
//   6  顶层框架位置的未知 Tag：破坏 [GUID 列表][0x1a][0xf][0x12][对象…][0x1c]，直接报错
//   7  坏计数：先校验再分配，报错而不是按计数分配数组
//   8  本机有真实样本时做注入性质测试：任何一次采信都必须与原结构逐节点一致
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePayload, parsePayloadWith, encodePayload, walkNodes } from '../scripts/parse-payload.mjs';
import { parseRecord, readRecords } from '../scripts/rp-records.mjs';

const X = 0x2a; // 现有语法里未出现的 Tag 码
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = i => Buffer.concat([u32(8), u32(i)]);
const int = v => Buffer.concat([u32(3), u32(v)]);
const ref = v => Buffer.concat([u32(5), u32(v)]);
const dict = (...pairs) => Buffer.concat([u32(1), u32(pairs.length), ...pairs.flat()]);
const list = (...items) => Buffer.concat([u32(2), u32(items.length), ...items]);
const obj = (id, cls, body) => Buffer.concat([u32(9), u32(id), u32(cls), body]);
// 真实记录的顶层框架：[GUID 列表][0x1a][0xf=1][0x12=2][对象…][0x1c]
const frame = (...objects) => Buffer.concat([u32(0x1e), u32(0), u32(0x1a), u32(0xf), u32(1), u32(0x12), u32(2), ...objects, u32(0x1c)]);
const STRINGS = ['Axure:Page', 'a', 'b', 'c'];
function record(payload) {
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xc351, 20);
  head.writeUInt32LE(STRINGS.length, 28);
  const raw = Buffer.concat([head, ...STRINGS.map(text => {
    const bytes = Buffer.from(text), length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  }), payload]);
  return { raw, ...parseRecord(raw) };
}
// 对象 body = dict{ a: <X 后跟 words>, b: 7, c: 9 }
const withUnknown = words => record(frame(obj(1, 1, dict([str(1), Buffer.concat([u32(X), ...words.map(u32)])], [str(2), int(7)], [str(3), int(9)]))));
const payloadOf = r => r.raw.subarray(r.payloadStart);
const nodeAt = (graph, start) => graph.nodes.find(n => n.start === start);
const signature = n => JSON.stringify([n.tag, n.start, n.end, n.value, n.text, n.id, n.classIndex, n.className, n.values,
  n.entries?.map(([k, v]) => [k.start, v.start]), n.items?.map(i => i.start), n.body?.start]);

test('只含已知 Tag 的 payload 不触发透传，重编码逐字节相等', () => {
  const r = record(frame(obj(1, 1, dict([str(1), int(42)], [str(2), list(int(1), int(2))]))));
  const graph = parsePayload(r);
  assert.equal(graph.unknownLayouts, undefined);
  assert.ok(encodePayload(graph.roots).equals(payloadOf(r)));
});

test('未知定宽标量按唯一布局采信，载荷原样写回，周围节点照常可改', () => {
  const r = withUnknown([0xdeadbeef]);
  const graph = parsePayload(r);
  assert.equal(graph.unknownLayouts.get(X), 'u32');
  const unknown = graph.nodes.find(n => n.tag === X);
  assert.equal(unknown.kind, 'opaque');
  assert.equal(unknown.raw, Buffer.from([0xef, 0xbe, 0xad, 0xde]).toString('base64'));
  assert.ok(encodePayload(graph.roots).equals(payloadOf(r)), '未修改时逐字节还原');
  // 改一个已知节点的值：只有那 4 个字节变化，未知载荷一个比特都不动
  const target = graph.nodes.find(n => n.tag === 3 && n.value === 7);
  target.value = 0x11223344;
  const encoded = encodePayload(graph.roots);
  assert.equal(encoded.length, payloadOf(r).length);
  const diff = [...encoded.keys()].filter(i => encoded[i] !== payloadOf(r)[i]);
  assert.deepEqual(diff.sort((a, b) => a - b), [target.start + 4, target.start + 5, target.start + 6, target.start + 7]);
  assert.equal(nodeAt(graph, unknown.start).raw, unknown.raw);
});

test('8 字节的未知标量按 u64 采信', () => {
  const graph = parsePayload(withUnknown([8, 15]));
  assert.equal(graph.unknownLayouts.get(X), 'u64');
  assert.equal(graph.nodes.find(n => n.tag === X).end - graph.nodes.find(n => n.tag === X).start, 12);
});

test('未知 dict 字段采信为透明容器，子节点是真实节点且改得回去', () => {
  // X 后是 count=1 的一对 (key "b", value 5)，其后是原有结构
  const r = withUnknown([1, 8, 2, 3, 5]);
  const graph = parsePayload(r);
  assert.equal(graph.unknownLayouts.get(X), 'dict');
  const unknown = graph.nodes.find(n => n.tag === X);
  assert.equal(unknown.kind, 'container');
  assert.equal(unknown.entries.length, 1);
  assert.equal(unknown.entries[0][0].text, 'a');
  assert.equal(unknown.entries[0][1].value, 5);
  const visited = [];
  walkNodes(graph.roots, n => visited.push(n));
  assert.ok(visited.includes(unknown.entries[0][1]), '子节点可被遍历');
  unknown.entries[0][1].value = 0x11223344;
  const encoded = encodePayload(graph.roots);
  const original = payloadOf(r);
  assert.equal(encoded.length, original.length);
  assert.deepEqual([...encoded.keys()].filter(i => encoded[i] !== original[i]), [unknown.start + 20, unknown.start + 21, unknown.start + 22, unknown.start + 23]);
});

test('未知 list 字段采信为透明容器', () => {
  // X 后是 count=1 的一项 ref(8)
  const graph = parsePayload(withUnknown([1, 15, 8]));
  assert.equal(graph.unknownLayouts.get(X), 'list');
  const unknown = graph.nodes.find(n => n.tag === X);
  assert.equal(unknown.items.length, 1);
  assert.equal(unknown.items[0].tag, 0xf);
  assert.ok(encodePayload(graph.roots).equals(payloadOf(withUnknown([1, 15, 8]))));
});

test('同一个未知码多次出现时共用同一种布局', () => {
  const r = record(frame(obj(1, 1, dict([str(1), Buffer.concat([u32(X), u32(11)])], [str(2), Buffer.concat([u32(X), u32(22)])], [str(3), int(9)]))));
  const graph = parsePayload(r);
  assert.equal(graph.unknownLayouts.size, 1);
  const hits = graph.nodes.filter(n => n.tag === X);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(n => n.kind), ['opaque', 'opaque']);
  assert.deepEqual(hits.map(n => Buffer.from(n.raw, 'base64').readUInt32LE(0)), [11, 22]);
  assert.ok(encodePayload(graph.roots).equals(payloadOf(r)));
});

test('多解时拒绝：u32 与 u64 都能铺满', () => {
  assert.throws(() => parsePayload(withUnknown([25, 29])), /Unknown tag 0x2a at \d+ is ambiguous: layouts u32, u64 each parse to the exact end; last nodes/);
});

test('多解时拒绝：无载荷与 u32 都能铺满', () => {
  assert.throws(() => parsePayload(withUnknown([29])), /is ambiguous: layouts none, u32 each parse to the exact end/);
});

test('无解时照旧报错，错误保留节点上下文', () => {
  assert.throws(() => parsePayload(withUnknown([5, 26, 20])), /Unknown tag 0x2a at \d+ has no layout that parses to the exact end; last nodes .*; context /);
});

test('候选集外的宽度（12 字节标量）保持报错，与改动前一致', () => {
  // 真值是 12 字节的标量：u32 少吞 8 字节、u64 少吞 4 字节，都接不上后面的结构
  assert.throws(() => parsePayload(withUnknown([1, 2, 3])), /Unknown tag 0x2a/);
});

test('顶层对象位置的未知 Tag 破坏框架，直接报错', () => {
  const r = record(frame(obj(1, 1, dict([str(1), int(1)]))));
  const payload = Buffer.from(payloadOf(r));
  payload.writeUInt32LE(X, 28); // 框架头 28 字节后的第一个顶层对象
  const tampered = { ...r, raw: Buffer.concat([r.raw.subarray(0, r.payloadStart), payload]) };
  assert.throws(() => parsePayload(tampered), /Unknown tag 0x2a at 28 has no layout that parses to the exact end/);
});

test('字符串引用越界的推测解不采信', () => {
  // X 取 u32 时后面的 8 号引用指向字符串表之外（99），这种铺法即使到末尾也不合法
  const r = withUnknown([0, 8, 99, 3, 1]);
  assert.throws(() => parsePayload(r), /Unknown tag 0x2a/);
});

test('坏计数先校验再分配，报错而不是按计数分配数组', () => {
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xc351, 20);
  const raw = Buffer.concat([head, u32(1), u32(0xffffffff)]);
  const r = { raw, ...parseRecord(raw) };
  assert.equal(r.strings.length, 0);
  assert.throws(() => parsePayload(r), /Count 4294967295 exceeds the remaining payload/);
  // 4 号字节串的长度越界同样报错，不再静默截断
  const blob = Buffer.concat([head, u32(4), u32(1000), Buffer.alloc(8)]);
  assert.throws(() => parsePayload({ raw: blob, ...parseRecord(blob) }), /Count 1000 exceeds the remaining payload/);
});

test('parsePayloadWith 按给定布局表解析，没登记的未知 Tag 照常抛错', () => {
  const r = withUnknown([7]);
  const graph = parsePayloadWith(r, new Map([[X, 'u32']]));
  assert.equal(graph.nodes.find(n => n.tag === X).kind, 'opaque');
  assert.throws(() => parsePayloadWith(r, undefined), /Unknown tag 0x2a/);
  assert.throws(() => parsePayloadWith(r, new Map([[0x3b, 'u32']])), /Unknown tag 0x2a/);
});

// 本机存在真实样本时（空白模板与技能夹具），把已知节点改写成未知码，验证“采信即正确”。
// 公开 CI 没有这些文件，整段跳过。
test('真实记录注入：每一次采信都与原结构逐节点一致', { timeout: 120_000 }, t => {
  const roots = [join(homedir(), 'Library', 'Application Support', 'zee-axure', 'templates'), join(dirname(fileURLToPath(import.meta.url)), 'fixtures')];
  const files = roots.flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(f => /\.rp$/i.test(f)).map(f => join(dir, f)) : []).slice(0, 24);
  if (!files.length) return t.skip('本机没有真实 .rp 样本');
  const codes = [0x7, 0xa, 0xb, 0xc, 0xd, 0x15, 0x17, 0x18, 0x1b, 0x1f, X, 0x3c];
  let seed = 20261127;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  let accepted = 0, refused = 0, records = 0;
  for (const file of files) {
    for (const r of readRecords(readFileSync(file))) {
      if (!r.strings) continue;
      const original = parsePayloadWith(r, undefined);
      if (original.nodes.length < 8) continue;
      records++;
      const candidates = original.nodes.filter(n => n.tag !== 9 && n.tag !== 0x1e && !original.roots.includes(n));
      for (let k = 0; k < 40; k++) {
        const n = candidates[Math.floor(rnd() * candidates.length)];
        const payload = Buffer.from(r.raw.subarray(r.payloadStart));
        payload.writeUInt32LE(codes[Math.floor(rnd() * codes.length)], n.start);
        const tampered = { ...r, raw: Buffer.concat([r.raw.subarray(0, r.payloadStart), payload]) };
        let graph;
        try { graph = parsePayload(tampered); }
        catch (error) {
          assert.match(error.message, /^Unknown tag 0x[0-9a-f]+ at \d+ (has no layout that parses to the exact end|is ambiguous: layouts [\w, ]+ each parse to the exact end); last nodes/);
          refused++;
          continue;
        }
        accepted++;
        // 采信的未知节点边界必须等于原节点；其余每个节点逐字段一致
        const unknown = nodeAt(graph, n.start);
        assert.equal(unknown.end, n.end, `${r.className}: 未知节点边界 ${n.start}..${unknown.end} ≠ 原 ${n.end}`);
        assert.equal(graph.nodes.length, original.nodes.length, `${r.className}: 节点数变了`);
        for (const node of graph.nodes) {
          if (node.start === n.start) continue;
          assert.equal(signature(node), signature(nodeAt(original, node.start)), `${r.className}: 偏移 ${node.start} 的节点与原结构不一致`);
        }
        assert.ok(encodePayload(graph.roots).equals(payload), `${r.className}: 重编码不逐字节相等`);
      }
    }
  }
  assert.ok(records > 0 && accepted > 0 && refused > 0, `样本不足：records=${records} accepted=${accepted} refused=${refused}`);
  t.diagnostic(`${records} 条记录：采信 ${accepted} 次（全部与原结构一致），拒绝 ${refused} 次`);
});
