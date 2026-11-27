import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords } from './rp-records.mjs';

// 已知 Tag 的载荷长度由 Tag 自己决定（位置式语法），未知 Tag 没有自描述边界。
// 透传不猜边界：把候选布局逐一代进去重解析整条记录，只有恰好解析到末尾、结构合法且结论唯一时才采信，
// 其余照旧报错。同一个 Tag 码在一条记录里只能对应一种布局（与已知语法一致）。
// 候选分两类：
//   · 不透明定宽布局（0/1/2/4/8 字节）：载荷原样保留，内部不作解读；
//   · 透明容器布局（dict / list）：子节点照常解析成真实节点，写回时按原布局编码。
//   两类都要有。只收定宽时，未知的容器字段会被“吞掉元素个数”，其内容被父容器吸收而恰好铺满；
//   把容器纳入候选后，这类错位解读有了竞争者，会按多解被拒绝。
// 不收长度或计数前缀的布局（字节串、元素数组）：真值不在候选集内时，误读的长度可能恰好落在看似合理的位置，
// 注入实验中全部残余误采信都来自它们。这类未知 Tag 保持报错，与改动前一致。
// 对象不设候选：真实记录里对象全部顶层平铺（29,020 个，0 嵌套），顶层位置的未知 Tag 必然破坏框架，直接报错。
const LAYOUTS = ['none', 'u8', 'u16', 'u32', 'u64', 'dict', 'list'];
const OPAQUE_BYTES = { none: 0, u8: 1, u16: 2, u32: 4, u64: 8 };

// 按给定布局表解析整条 payload。遇到布局表没登记的未知 Tag 时抛出带 unknownTag 的错误。
function parse(buf, record, layouts, out) {
  const nodes = [], objects = new Map();
  out.nodes = nodes;
  let p = 0;
  const u32 = () => { const n = buf.readUInt32LE(p); p += 4; return n; };
  // 计数先于分配：每个元素至少占 per 字节，装不进剩余 payload 的计数是坏数据，直接报错而不是先按它分配数组。
  const count = per => { const n = u32(); if (n * per > buf.length - p) throw new RangeError(`Count ${n} exceeds the remaining payload at ${p}`); return n; };
  const val = () => {
    const start = p, tag = u32(), n = { start, tag }; nodes.push(n);
    switch (tag) {
      case 1: n.entries = Array.from({ length: count(8) }, () => [val(), val()]); break;
      case 2: n.items = Array.from({ length: count(4) }, () => val()); break;
      // 0x14 与 0x11/0x12/0x16 同类：单 u32 的值/引用（Axure:Page 里 start/end-diagram-object 用它，
      // 见 research-rp/round4/rp-read-tag14-repro.mjs 的字节证据）。
      case 3: case 0xf: case 0x12: case 5: case 8: case 0x11: case 0x14: case 0x16: n.value = u32(); break;
      case 4: { const size = count(1); n.value = buf.subarray(p, p + size).toString('base64'); p += size; break; }
      case 6: n.rawNumber = buf.subarray(p, p + 8).toString('hex'); n.value = buf.readDoubleLE(p); p += 8; break;
      case 9: n.id = u32(); n.classIndex = u32(); n.className = record.strings[n.classIndex - 1]; n.body = val(); objects.set(n.id, n); break;
      case 0x10: case 0x13: n.values = [u32(), u32()]; break;
      case 0x19: n.value = !!buf[p++]; break;
      // 26/28 是无载荷尾部标记。注意 0x1e(30) 是 GUID 列表、有载荷，不能和它们合并。
      case 26: case 28: break;
      case 0x1a: case 0x1c: break;
      case 0x1d: n.value = buf.subarray(p, p + 8).toString('hex'); p += 8; break;
      case 0x1e: { const total = count(16); n.values = Array.from({ length: total }, () => { const b = buf.subarray(p, p + 16); p += 16; return b.toString('hex'); }); break; }
      default: {
        const layout = layouts?.get(tag);
        // 节点上下文只在真正报错时才拼（见 parsePayload），推测循环里每次尝试都会走到这里。
        if (layout === undefined) throw Object.assign(new Error(`Unknown tag 0x${tag.toString(16)} at ${start}`), { unknownTag: tag, at: start });
        n.layout = layout;
        if (layout === 'dict' || layout === 'list') {
          n.kind = 'container';
          if (layout === 'dict') n.entries = Array.from({ length: count(8) }, () => [val(), val()]);
          else n.items = Array.from({ length: count(4) }, () => val());
        } else {
          n.kind = 'opaque';
          p += OPAQUE_BYTES[layout];
          if (p > buf.length) throw new RangeError(`Opaque payload out of bounds at ${p}`);
          n.raw = buf.subarray(start + 4, p).toString('base64');
        }
      }
    }
    n.end = p; if (tag === 8) n.text = record.strings[n.value - 1]; return n;
  };
  const roots = [];
  while (p < buf.length) roots.push(val());
  return { roots, nodes, objects, bytes: buf.length };
}

// 按给定的未知 Tag 布局表解析整条 payload；布局表没登记到的未知 Tag 照常抛错。
export function parsePayloadWith(record, layouts) {
  return parse(record.raw.subarray(record.payloadStart), record, layouts, {});
}

// 推测出来的解要过结构合法性，四条判据在 1,141 条真实记录上零违反，错位解读几乎必然违反其中一条：
//   · 顶层框架恒为 [GUID 列表 0x1e][0x1a][0xf][0x12][一个或多个对象 0x9][0x1c]，且首个对象的类名等于记录类名；
//   · 对象的 body 恒为 dict；
//   · 字符串引用与对象类索引必须落在字符串表内；
//   · dict 的键不能是容器。
// 重排型错位解读会把剩余字节溢出到顶层，必然破坏框架。
function plausible(graph, record) {
  const strings = record.strings.length, roots = graph.roots, tags = roots.map(n => n.tag);
  if (tags.length < 6 || tags[0] !== 0x1e || tags[1] !== 0x1a || tags[2] !== 0xf || tags[3] !== 0x12 || tags.at(-1) !== 0x1c
    || tags.slice(4, -1).some(tag => tag !== 9) || roots[4].className !== record.className) return false;
  for (const n of graph.nodes) {
    if (n.tag === 8 && (n.value < 1 || n.value > strings)) return false;
    if (n.tag === 9 && (n.classIndex < 1 || n.classIndex > strings)) return false;
    if (n.tag === 9 && n.body.tag !== 1) return false;
    if (n.entries && n.entries.some(([k]) => k.tag === 1 || k.tag === 2 || k.tag === 9 || k.kind === 'container')) return false;
  }
  return true;
}

// 给首个未知 Tag 码逐个试候选布局，收集恰好铺满且结构合法的方案。
function solveUnknown(buf, record, code) {
  const found = [];
  for (const layout of LAYOUTS) {
    let graph;
    try { graph = parse(buf, record, new Map([[code, layout]]), {}); } catch { continue; }
    if (plausible(graph, record)) found.push({ layout, graph });
  }
  return found;
}

// 只接受结论唯一的方案：
//   · 所有铺满的布局必须给出同一个结束位置，否则边界不确定；
//   · 同一结束位置上只要有不透明布局就取它（不透明布局不对子节点作任何断言）；
//     否则透明容器必须是唯一候选，因为容器还断言了子节点的括号结构。
function pickLayout(found, at) {
  const node = f => f.graph.nodes.find(n => n.start === at);
  const layouts = found.map(f => f.layout);
  if (new Set(found.map(f => node(f).end)).size > 1) return { ambiguous: layouts };
  const opaque = found.find(f => node(f).kind === 'opaque');
  if (opaque || found.length === 1) return { layout: (opaque ?? found[0]).layout, graph: (opaque ?? found[0]).graph };
  return { ambiguous: layouts };
}

export function parsePayload(record) {
  const buf = record.raw.subarray(record.payloadStart), first = {};
  try {
    try { return parse(buf, record, undefined, first); }
    catch (error) {
      if (error.unknownTag === undefined) throw error;
      const head = `Unknown tag 0x${error.unknownTag.toString(16)} at ${error.at}`;
      const tail = () => `last nodes ${JSON.stringify(first.nodes.slice(-6))}`;
      const found = solveUnknown(buf, record, error.unknownTag);
      const picked = found.length ? pickLayout(found, error.at) : {};
      if (!picked.graph) {
        const why = found.length
          ? `is ambiguous: layouts ${picked.ambiguous.join(', ')} each parse to the exact end`
          : 'has no layout that parses to the exact end';
        throw new Error(`${head} ${why}; ${tail()}`);
      }
      // 采信前复核：重编码必须逐字节还原原 payload。
      if (!encodePayload(picked.graph.roots).equals(buf)) throw new Error(`${head} does not re-encode byte-identically; ${tail()}`);
      return { ...picked.graph, unknownLayouts: new Map([[error.unknownTag, picked.layout]]) };
    }
  } catch (e) { throw new Error(e.message + '; context ' + JSON.stringify(first.nodes?.slice(-5) ?? [])); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rs = readRecords(readFileSync(process.argv[2]));
  for (const r of rs.filter(r => r.strings)) try {
    const p = parsePayload(r);
    const unknown = p.unknownLayouts?.size ? ` unknown=${[...p.unknownLayouts].map(([t, l]) => `0x${t.toString(16)}:${l}`).join(',')}` : '';
    console.log(r.className, p.bytes, 'OK', p.nodes.length, 'nodes', p.objects.size, 'objects' + unknown);
  } catch (e) { console.error(r.className, e.message); }
}

// Encode the parsed grammar without scanning byte patterns. Preserve NaN payload bits.
export function encodePayload(roots) {
  const chunks = [];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); chunks.push(b); };
  const write = n => {
    u32(n.tag);
    // 未识别的 Tag：不透明载荷原样写回，透明容器按 dict / list 编码。
    if (n.kind === 'opaque') { chunks.push(Buffer.from(n.raw, 'base64')); return; }
    if (n.kind === 'container') {
      if (n.layout === 'dict') { u32(n.entries.length); for (const [k, v] of n.entries) { write(k); write(v); } }
      else { u32(n.items.length); n.items.forEach(write); }
      return;
    }
    switch (n.tag) {
      case 1: u32(n.entries.length); for (const [k, v] of n.entries) { write(k); write(v); } break;
      case 2: u32(n.items.length); n.items.forEach(write); break;
      case 3: case 5: case 8: case 0xf: case 0x11: case 0x12: case 0x14: case 0x16: u32(n.value); break;
      case 4: { const b = Buffer.from(n.value, 'base64'); u32(b.length); chunks.push(b); break; }
      case 6: { const b = Buffer.alloc(8); if (Number.isNaN(n.value) && n.rawNumber) Buffer.from(n.rawNumber, 'hex').copy(b); else b.writeDoubleLE(n.value); chunks.push(b); break; }
      case 9: u32(n.id); u32(n.classIndex); write(n.body); break;
      case 0x10: case 0x13: n.values.forEach(u32); break;
      case 0x19: chunks.push(Buffer.from([n.value ? 1 : 0])); break;
      // 26/28 是无载荷标记；0x1e(30) 是 GUID 列表、必须读数据。
      case 26: case 28: break;
      case 0x1a: case 0x1c: break;
      case 0x1d: chunks.push(Buffer.from(n.value, 'hex')); break;
      case 0x1e: { const gs = n.values ?? n.value; u32(gs.length); gs.forEach(v => chunks.push(Buffer.from(v, 'hex'))); break; }
      default: throw new Error(`Cannot encode tag ${n.tag}`);
    }
  };
  roots.forEach(write); return Buffer.concat(chunks);
}
export function field(map, name) { return map.entries?.find(([k]) => k.text === name)?.[1]; }
export function walkNodes(roots, visit) {
  for (const n of roots) { visit(n); if (n.entries) for (const pair of n.entries) walkNodes(pair, visit); if (n.items) walkNodes(n.items, visit); if (n.body) walkNodes([n.body], visit); }
}
