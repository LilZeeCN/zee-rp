import { gunzipSync, gzipSync } from 'node:zlib';

// RP11 样本：8B 外层头 + [01][varuint 原始长度][varuint 压缩长度][LZ4 block]。
// 注意 encodeManifest 返回的是「8B 外层头 + 编码块」整体，长度就等于新的 dataStart。
export function readManifest(file) {
  const dataStart = 8 + file.readUInt32LE(4);
  if (file[8] !== 1) throw new Error('Unsupported manifest encoding');
  let p = 9;
  const varuint = () => {
    let value = 0, shift = 0, byte;
    do {
      if (p >= dataStart || shift > 28) throw new Error('Invalid manifest length');
      byte = file[p++]; value += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    return value;
  };
  const rawLength = varuint(), compressedLength = varuint(), end = p + compressedLength;
  if (end !== dataStart) throw new Error('Manifest extent mismatch');
  const out = Buffer.alloc(rawLength);
  let q = 0;
  const length = initial => {
    let result = initial, byte;
    if (initial === 15) do {
      if (p >= end) throw new Error('Truncated LZ4 length');
      byte = file[p++]; result += byte;
    } while (byte === 255);
    return result;
  };
  while (p < end) {
    const token = file[p++], literals = length(token >> 4);
    if (p + literals > end || q + literals > out.length) throw new Error('Invalid LZ4 literal');
    file.copy(out, q, p, p + literals); p += literals; q += literals;
    if (p === end) break;
    if (p + 2 > end) throw new Error('Truncated LZ4 offset');
    const offset = file.readUInt16LE(p); p += 2;
    const count = length(token & 15) + 4;
    if (!offset || offset > q || q + count > out.length) throw new Error('Invalid LZ4 match');
    for (let i = 0; i < count; i++) { out[q] = out[q - offset]; q++; }
  }
  if (q !== rawLength) throw new Error('Manifest decoded size mismatch');
  return { dataStart, value: JSON.parse(out.toString('utf8')) };
}

export function encodeManifest(header, value) {
  const raw = Buffer.from(JSON.stringify(value));
  const bytes = [], seen = new Map();
  const extra = n => { while (n >= 255) { bytes.push(255); n -= 255; } bytes.push(n); };
  const sequence = (start, end, offset, matchLength) => {
    const literals = end - start, match = matchLength ? matchLength - 4 : 0;
    bytes.push((Math.min(literals, 15) << 4) | Math.min(match, 15));
    if (literals >= 15) extra(literals - 15);
    bytes.push(...raw.subarray(start, end));
    if (matchLength) {
      bytes.push(offset & 255, offset >> 8);
      if (match >= 15) extra(match - 15);
    }
  };
  let anchor = 0, p = 0;
  while (p <= raw.length - 12) {
    const key = raw.readUInt32LE(p), previous = seen.get(key);
    seen.set(key, p);
    if (previous === undefined || p - previous > 65535) { p++; continue; }
    let count = 4;
    while (p + count < raw.length - 5 && raw[previous + count] === raw[p + count]) count++;
    sequence(anchor, p, p - previous, count);
    p += count; anchor = p;
  }
  sequence(anchor, raw.length, 0, 0);
  const block = Buffer.from(bytes);
  if (block.length >= raw.length) throw new Error('Manifest requires an uncompressed-chunk encoding; not yet supported');
  const varuint = n => {
    const bytes = [];
    do { const byte = n & 127; n = Math.floor(n / 128); bytes.push(byte | (n ? 128 : 0)); } while (n);
    return Buffer.from(bytes);
  };
  const encoded = Buffer.concat([Buffer.from([1]), varuint(raw.length), varuint(block.length), block]);
  const outer = Buffer.from(header.subarray(0, 8));
  outer.writeUInt32LE(encoded.length, 4);
  return Buffer.concat([outer, encoded]);
}

export function parseRecord(raw) {
  if (raw.length < 32 || raw.readUInt32LE(20) !== 0xc351) {
    const root = raw.toString('utf8', 0, 100).match(/^<([A-Za-z][\w]*)/);
    if (!root) throw new Error('Not an Axure record or XML record');
    return { className: `xml:${root[1]}` };
  }
  const count = raw.readUInt32LE(28);
  const strings = [];
  let p = 32;
  for (let i = 0; i < count; i++) {
    if (p + 4 > raw.length) throw new Error(`Truncated string length at ${i}`);
    const n = raw.readUInt32LE(p); p += 4;
    if (p + n > raw.length) throw new Error(`Truncated string at ${i}`);
    strings.push(raw.toString('utf8', p, p + n)); p += n;
  }
  return { className: strings[0], strings, payloadStart: p };
}

// 扫描 gzip 成员定位记录。记录之间的 4 字节前缀本身也带 gzip 魔数，偶尔会自成合法 gzip 流，
// 解压后却不是记录（例如 xml:BreakingChanges）——这种假阳性要跳过，不能中断整份文件的读取。
//
// 两种容器都支持：
//   · .rp / .rppkg：以 AC EF 开头，前面有 LZ4 manifest（dataStart = 8 + u32LE(file[4])）
//   · .rplib 控件库：**没有 manifest**，是纯粹的 [4B 长度][gzip 记录] 流，从偏移 0 开始
// 只认 .rp 会让所有控件库读取失败，而条件/中继器等关键样本恰恰只在控件库里。
export function readRecords(file) {
  const isRp = file[0] === 0xac && file[1] === 0xef;
  const isBareStream = !isRp && file.length > 4 && file.readUInt32LE(4) > 0;
  if (!isRp && !isBareStream) throw new Error('Not an Axure .rp / .rplib file');
  const records = [];
  for (let offset = isRp ? 15 : 0; offset + 18 <= file.length; offset++) {
    if (file[offset] !== 0x1f || file[offset + 1] !== 0x8b || file[offset + 2] !== 8) continue;
    const compressedSize = file.readUInt32LE(offset - 4);
    if (compressedSize < 18 || offset + compressedSize > file.length) continue;
    let raw;
    try { raw = gunzipSync(file.subarray(offset, offset + compressedSize)); }
    catch { continue; }
    let parsed;
    try { parsed = parseRecord(raw); }
    catch { continue; }
    records.push({ index: records.length, offset, compressedSize, raw, ...parsed });
    offset += compressedSize - 1;
  }
  return records;
}

export function encodeRecord(record, strings, payload = record.raw.subarray(record.payloadStart)) {
  const header = Buffer.from(record.raw.subarray(0, 32));
  header.writeUInt32LE(strings.length, 28);
  const table = strings.flatMap(s => {
    const bytes = Buffer.from(s, 'utf8'), length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return [length, bytes];
  });
  return Buffer.concat([header, ...table, payload]);
}

// 替换已存在的记录，调整 manifest 中后续 parts 的相对位置；其他记录原样保留。
export function replaceRecord(file, record, raw) {
  const compressed = gzipSync(raw), length = Buffer.alloc(4);
  length.writeUInt32LE(compressed.length);
  const manifest = readManifest(file);
  const delta = compressed.length - record.compressedSize;
  const relative = record.offset - 8 - manifest.dataStart;
  let found = 0;
  const update = node => {
    for (const [key, offset] of Object.entries(node.parts ?? {})) {
      if (offset === relative) found++;
      if (offset > relative) node.parts[key] = offset + delta;
    }
    for (const child of Object.values(node.children ?? {})) update(child);
  };
  update(manifest.value.root);
  if (found !== 1) throw new Error(`Expected one manifest reference, found ${found}`);
  return Buffer.concat([encodeManifest(file, manifest.value),
    file.subarray(manifest.dataStart, record.offset - 4), length, compressed,
    file.subarray(record.offset + record.compressedSize)]);
}

// 在一条已有记录之前插入一个新包（记录流中间插入），manifest 中插入点及之后的 parts
// 偏移整体 +D，新条目指向插入点。用于「必须写在某条记录之前」的场景：
// Axure 无论重存还是 UI 新建，PanelState 记录都写在拥有它的 Page 记录之前
// （也在 DesignDocument/DocumentSettings 之前）；追加到流尾 GUI 双击编辑会报类型转换。
//
// parts 偏移相对 dataStart（= encodeManifest 结果长度）。插入让后续记录绝对位置 +D，
// dataStart 的变化量正好抵消，所以旧条目只需 +D（与 replaceRecord 同一套数学）。
// beforeRecord 只要带 .offset（gzip 魔数的绝对偏移）；前缀 8B 从其 offset-8 起算。
export function insertRecord(file, key, raw, beforeRecord) {
  const manifest = readManifest(file);
  if (manifest.value.root.children?.[key]) throw new Error(`Package already exists: ${key}`);
  const compressed = gzipSync(raw), prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(compressed.length, 4);
  const Q = beforeRecord.offset - 8 - manifest.dataStart;
  const D = 8 + compressed.length;
  const update = node => {
    for (const [k, offset] of Object.entries(node.parts ?? {})) {
      if (offset >= Q) node.parts[k] = offset + D;
    }
    for (const child of Object.values(node.children ?? {})) update(child);
  };
  update(manifest.value.root);
  manifest.value.root.children ??= {};
  manifest.value.root.children[key] = { parts: { package: Q } };
  // 迭代到 manifest 压缩长度稳定（正常情况下第一轮就稳定）。
  let encoded = encodeManifest(file, manifest.value);
  for (let i = 0; i < 8; i++) {
    const again = encodeManifest(file, manifest.value);
    if (again.length === encoded.length) break;
    encoded = again;
  }
  return Buffer.concat([encoded,
    file.subarray(manifest.dataStart, beforeRecord.offset - 8), prefix, compressed,
    file.subarray(beforeRecord.offset - 8)]);
}
// 追加一个 page/master 包，原有数据段与既有条目**原样有效**。
//
// parts 里的偏移是相对 dataStart（= encodeManifest 结果的长度）的。
// 新文件 = [新manifest][旧body][8B前缀+gzip]，
// 旧 body 整体跟着 manifest 平移，所以旧条目的相对偏移不需要动；新条目只要指向旧 body 的末尾即可：
//     rel_new = B0            （B0 = 旧 body 长度；该位置正是新记录 8 字节前缀的起点）
// 唯一要小心的是 manifest 本身是 LZ4 压缩的，长度会随内容变化，所以登记完再编码一次确认长度收敛。
export function appendPackage(file, key, raw) {
  const manifest = readManifest(file);
  if (manifest.value.root.children?.[key]) throw new Error(`Package already exists: ${key}`);
  const B0 = file.length - manifest.dataStart;
  const compressed = gzipSync(raw), prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(compressed.length, 4);
  const body = file.subarray(manifest.dataStart);
  manifest.value.root.children ??= {};
  manifest.value.root.children[key] = { parts: { package: B0 } };
  // 迭代到 manifest 压缩长度稳定（正常情况下第一轮就稳定）。
  let encoded = encodeManifest(file, manifest.value);
  for (let i = 0; i < 8; i++) {
    const again = encodeManifest(file, manifest.value);
    if (again.length === encoded.length) break;
    encoded = again;
  }
  return Buffer.concat([encoded, body, prefix, compressed]);
}
