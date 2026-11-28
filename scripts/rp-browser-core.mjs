// D2+: 零依赖浏览器同构读写、抢救、降级与组件库引擎（纯 ES2022 + Uint8Array + DataView + CompressionStream/DecompressionStream）
// 严禁引用任何 node:* 模块或 Buffer 全局对象；在 Node 18+、Chrome/Safari/Firefox 与 Web Worker 中完全同构运行。

const UTF8_DECODER = new TextDecoder('utf-8');
const UTF8_ENCODER = new TextEncoder();
const NULL_GUID = '0'.repeat(32);

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32Bytes(input) {
  const u8 = toUint8Array(input);
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sha256Hex(input) {
  const bytes = typeof input === 'string' ? UTF8_ENCODER.encode(input) : toUint8Array(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => v.toString(16).padStart(8, '0')).join('');
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}

function concatU8(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const u16le = (u8, off) => u8[off] | (u8[off + 1] << 8);
const u32le = (u8, off) => (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0;
const f64le = (u8, off) => new DataView(u8.buffer, u8.byteOffset + off, 8).getFloat64(0, true);
const utf8 = (u8, start = 0, end = u8.length) => UTF8_DECODER.decode(u8.subarray(start, end));

function wordU32(val) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, val >>> 0, true);
  return b;
}

function writeU16LE(u8, off, val) {
  u8[off] = val & 0xff;
  u8[off + 1] = (val >>> 8) & 0xff;
}

function writeU32LE(u8, off, val) {
  u8[off] = val & 0xff;
  u8[off + 1] = (val >>> 8) & 0xff;
  u8[off + 2] = (val >>> 16) & 0xff;
  u8[off + 3] = (val >>> 24) & 0xff;
}

function bytesToHex(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const clean = String(hex);
  const out = new Uint8Array(clean.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBase64(u8) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function guidKey(hex) {
  return unguidKey(hex);
}

function unguidKey(hex) {
  if (typeof hex !== 'string' || hex.length !== 32) return hex;
  return (
    hex.slice(6, 8) + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2) +
    hex.slice(10, 12) + hex.slice(8, 10) +
    hex.slice(14, 16) + hex.slice(12, 14) +
    hex.slice(16)
  );
}

function randomGuidHex() {
  const gCrypto = globalThis.crypto;
  if (gCrypto && typeof gCrypto.randomUUID === 'function') {
    return gCrypto.randomUUID().replaceAll('-', '');
  }
  const b = new Uint8Array(16);
  if (gCrypto && typeof gCrypto.getRandomValues === 'function') {
    gCrypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToHex(b);
}

// ---- RFC 1951 Pure-JS Inflator (prefix-less gzip salvage in browsers & workers) ----
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuff(lengths) {
  let maxBits = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
  if (maxBits === 0) return { maxBits: 0, sym: new Uint16Array(0), len: new Uint8Array(0) };
  const counts = new Uint16Array(maxBits + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) counts[lengths[i]]++;
  const nextCode = new Uint16Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + counts[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const tableSize = 1 << maxBits;
  const sym = new Uint16Array(tableSize);
  const len = new Uint8Array(tableSize);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l === 0) continue;
    const c = nextCode[l]++;
    // Reverse bits of l-bit code for LSB-first lookup
    let rev = 0;
    for (let b = 0; b < l; b++) rev = (rev << 1) | ((c >>> b) & 1);
    const step = 1 << l;
    for (let idx = rev; idx < tableSize; idx += step) {
      sym[idx] = s;
      len[idx] = l;
    }
  }
  return { maxBits, sym, len };
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  return buildHuff(l);
})();

const FIXED_DIST = (() => {
  const d = new Uint8Array(32);
  d.fill(5);
  return buildHuff(d);
})();

export function inflateRawWithEnd(u8, startOffset = 0, maxOut = 32 * 1024 * 1024) {
  let bytePos = startOffset;
  let bitBuf = 0;
  let bitCount = 0;

  const ensure = n => {
    while (bitCount < n) {
      if (bytePos >= u8.length) throw new Error('Unexpected EOF in deflate stream');
      bitBuf |= u8[bytePos++] << bitCount;
      bitCount += 8;
    }
  };
  const readBits = n => {
    ensure(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return v;
  };
  const alignByte = () => {
    const unreadWholeBytes = bitCount >> 3;
    bytePos -= unreadWholeBytes;
    bitBuf = 0;
    bitCount = 0;
  };
  const readHuff = h => {
    ensure(h.maxBits);
    const mask = (1 << h.maxBits) - 1;
    const idx = bitBuf & mask;
    const l = h.len[idx];
    if (!l) throw new Error('Invalid Huffman symbol');
    bitBuf >>>= l;
    bitCount -= l;
    return h.sym[idx];
  };

  let out = new Uint8Array(Math.min(Math.max(256, (u8.length - startOffset) * 3), maxOut));
  let outLen = 0;
  const grow = need => {
    if (outLen + need > maxOut) throw new Error('Deflate output exceeded limit');
    let cap = out.length;
    while (cap < outLen + need) cap = Math.min(maxOut, cap * 2);
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, outLen));
    out = next;
  };

  let bfinal = 0;
  do {
    bfinal = readBits(1);
    const btype = readBits(2);
    if (btype === 0) {
      alignByte();
      if (bytePos + 4 > u8.length) throw new Error('Truncated stored block');
      const len = u16le(u8, bytePos);
      const nlen = u16le(u8, bytePos + 2);
      bytePos += 4;
      if ((len ^ 0xffff) !== nlen || bytePos + len > u8.length) throw new Error('Corrupt stored block');
      if (outLen + len > out.length) grow(len);
      out.set(u8.subarray(bytePos, bytePos + len), outLen);
      bytePos += len;
      outLen += len;
      continue;
    }
    if (btype === 3) throw new Error('Reserved block type');

    let litH, distH;
    if (btype === 1) {
      litH = FIXED_LIT;
      distH = FIXED_DIST;
    } else {
      const hlit = readBits(5) + 257;
      const hdist = readBits(5) + 1;
      const hclen = readBits(4) + 4;
      const clLens = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = readBits(3);
      const clH = buildHuff(clLens);
      const total = hlit + hdist;
      const all = new Uint8Array(total);
      let idx = 0;
      while (idx < total) {
        const sym = readHuff(clH);
        if (sym < 16) {
          all[idx++] = sym;
        } else if (sym === 16) {
          if (idx === 0) throw new Error('Invalid repeat code');
          const rep = readBits(2) + 3;
          const prev = all[idx - 1];
          for (let k = 0; k < rep && idx < total; k++) all[idx++] = prev;
        } else if (sym === 17) {
          const rep = readBits(3) + 3;
          idx = Math.min(total, idx + rep);
        } else {
          const rep = readBits(7) + 11;
          idx = Math.min(total, idx + rep);
        }
      }
      litH = buildHuff(all.subarray(0, hlit));
      distH = buildHuff(all.subarray(hlit));
    }

    while (true) {
      const sym = readHuff(litH);
      if (sym < 256) {
        if (outLen >= out.length) grow(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const lIdx = sym - 257;
        if (lIdx >= LEN_BASE.length) throw new Error('Invalid length symbol');
        const copyLen = LEN_BASE[lIdx] + (LEN_EXTRA[lIdx] ? readBits(LEN_EXTRA[lIdx]) : 0);
        const dSym = readHuff(distH);
        if (dSym >= DIST_BASE.length) throw new Error('Invalid distance symbol');
        const dist = DIST_BASE[dSym] + (DIST_EXTRA[dSym] ? readBits(DIST_EXTRA[dSym]) : 0);
        if (dist <= 0 || dist > outLen) throw new Error('Invalid back-reference distance');
        if (outLen + copyLen > out.length) grow(copyLen);
        for (let k = 0; k < copyLen; k++) {
          out[outLen] = out[outLen - dist];
          outLen++;
        }
      }
    }
  } while (!bfinal);

  alignByte();
  return { raw: out.subarray(0, outLen), nextOffset: bytePos };
}

export function detectFileVersionBytes(input) {
  const u8 = toUint8Array(input);
  if (u8.length < 8 || u8[0] !== 0xac || u8[1] !== 0xef) throw new Error('Not an Axure .rp / .rplib container');
  const version = u16le(u8, 2);
  if (version !== 9 && version !== 11) throw new Error(`Unsupported Axure container version: ${version}`);
  return version;
}

export function readManifestBytes(input) {
  const file = toUint8Array(input);
  const dataStart = 8 + u32le(file, 4);
  if (file[8] !== 1) throw new Error('Unsupported manifest encoding');
  let p = 9;
  const varuint = () => {
    let value = 0, shift = 0, byte;
    do {
      if (p >= dataStart || shift > 28) throw new Error('Invalid manifest length');
      byte = file[p++];
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const rawLength = varuint();
  const compressedLength = varuint();
  const end = p + compressedLength;
  if (end !== dataStart) throw new Error('Manifest extent mismatch');
  const out = new Uint8Array(rawLength);
  let q = 0;
  const length = initial => {
    let result = initial, byte;
    if (initial === 15) do {
      if (p >= end) throw new Error('Truncated LZ4 length');
      byte = file[p++];
      result += byte;
    } while (byte === 255);
    return result;
  };
  while (p < end) {
    const token = file[p++];
    const literals = length(token >> 4);
    if (p + literals > end || q + literals > out.length) throw new Error('Invalid LZ4 literal');
    out.set(file.subarray(p, p + literals), q);
    p += literals;
    q += literals;
    if (p === end) break;
    if (p + 2 > end) throw new Error('Truncated LZ4 offset');
    const offset = u16le(file, p);
    p += 2;
    const count = length(token & 15) + 4;
    if (!offset || offset > q || q + count > out.length) throw new Error('Invalid LZ4 match');
    for (let i = 0; i < count; i++) {
      out[q] = out[q - offset];
      q++;
    }
  }
  if (q !== rawLength) throw new Error('Manifest decoded size mismatch');
  return { dataStart, value: JSON.parse(utf8(out)) };
}

export function encodeManifestBytes(header, value) {
  const h = toUint8Array(header);
  const raw = UTF8_ENCODER.encode(JSON.stringify(value));
  const bytes = [], seen = new Map();
  const extra = n => { while (n >= 255) { bytes.push(255); n -= 255; } bytes.push(n); };
  const sequence = (start, end, offset, matchLength) => {
    const literals = end - start, match = matchLength ? matchLength - 4 : 0;
    bytes.push((Math.min(literals, 15) << 4) | Math.min(match, 15));
    if (literals >= 15) extra(literals - 15);
    for (let i = start; i < end; i++) bytes.push(raw[i]);
    if (matchLength) {
      bytes.push(offset & 255, offset >> 8);
      if (match >= 15) extra(match - 15);
    }
  };
  let anchor = 0, p = 0;
  while (p <= raw.length - 12) {
    const key = u32le(raw, p), previous = seen.get(key);
    seen.set(key, p);
    if (previous === undefined || p - previous > 65535) { p++; continue; }
    let count = 4;
    while (p + count < raw.length - 5 && raw[previous + count] === raw[p + count]) count++;
    sequence(anchor, p, p - previous, count);
    p += count;
    anchor = p;
  }
  sequence(anchor, raw.length, 0, 0);
  const block = new Uint8Array(bytes);
  if (block.length >= raw.length) throw new Error('Manifest requires an uncompressed-chunk encoding; not yet supported');
  const varuint = n => {
    const out = [];
    do { const byte = n & 127; n = Math.floor(n / 128); out.push(byte | (n ? 128 : 0)); } while (n);
    return new Uint8Array(out);
  };
  const encoded = concatU8([new Uint8Array([1]), varuint(raw.length), varuint(block.length), block]);
  const outer = new Uint8Array(h.subarray(0, 8));
  writeU32LE(outer, 4, encoded.length);
  return concatU8([outer, encoded]);
}

export async function gunzipBytes(slice) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([toUint8Array(slice)]).stream().pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  const dec = tryDecompressGzipAtBytes(toUint8Array(slice), 0, true);
  if (!dec) throw new Error('gzip decode failed');
  return dec.raw;
}

export async function gzipBytes(input) {
  const data = toUint8Array(input);
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const parts = [new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])];
  if (data.length === 0) {
    parts.push(new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]));
  } else {
    for (let off = 0; off < data.length; off += 65535) {
      const len = Math.min(65535, data.length - off);
      const isFinal = off + len >= data.length ? 1 : 0;
      const nlen = (~len) & 0xffff;
      parts.push(new Uint8Array([isFinal, len & 0xff, (len >>> 8) & 0xff, nlen & 0xff, (nlen >>> 8) & 0xff]));
      parts.push(data.subarray(off, off + len));
    }
  }
  const trailer = new Uint8Array(8);
  writeU32LE(trailer, 0, crc32Bytes(data));
  writeU32LE(trailer, 4, data.length >>> 0);
  parts.push(trailer);
  return concatU8(parts);
}

function tryDecompressGzipAtBytes(file, offset, skipLenPrefix = false) {
  if (!skipLenPrefix && offset >= 4) {
    const len = u32le(file, offset - 4);
    if (len >= 18 && offset + len <= file.length) {
      const slice = file.subarray(offset, offset + len);
      const parsed = tryParseSingleGzip(slice, 0);
      if (parsed && parsed.compressedSize === len) return parsed;
    }
  }
  return tryParseSingleGzip(file, offset);
}

function tryParseSingleGzip(file, offset) {
  if (offset + 18 > file.length) return null;
  if (file[offset] !== 0x1f || file[offset + 1] !== 0x8b || file[offset + 2] !== 8) return null;
  const flags = file[offset + 3];
  let p = offset + 10;
  if (flags & 4) {
    if (p + 2 > file.length) return null;
    p += 2 + u16le(file, p);
  }
  if (flags & 8) {
    while (p < file.length && file[p] !== 0) p++;
    p++;
  }
  if (flags & 16) {
    while (p < file.length && file[p] !== 0) p++;
    p++;
  }
  if (flags & 2) p += 2;
  if (p >= file.length) return null;
  try {
    const { raw, nextOffset } = inflateRawWithEnd(file, p);
    if (nextOffset + 8 > file.length) return null;
    const expectedCrc = u32le(file, nextOffset);
    const expectedSize = u32le(file, nextOffset + 4);
    if (crc32Bytes(raw) !== expectedCrc || (raw.length >>> 0) !== expectedSize) return null;
    return { raw, compressedSize: nextOffset + 8 - offset };
  } catch {
    return null;
  }
}

export function parseRecordBytes(raw) {
  if (raw.length < 32 || u32le(raw, 20) !== 0xc351) {
    const root = utf8(raw, 0, Math.min(100, raw.length)).match(/^<([A-Za-z][\w]*)/);
    if (!root) throw new Error('Not an Axure record or XML record');
    return { className: `xml:${root[1]}` };
  }
  const count = u32le(raw, 28);
  const strings = [];
  let p = 32;
  for (let i = 0; i < count; i++) {
    if (p + 4 > raw.length) throw new Error(`Truncated string length at ${i}`);
    const n = u32le(raw, p);
    p += 4;
    if (p + n > raw.length) throw new Error(`Truncated string at ${i}`);
    strings.push(utf8(raw, p, p + n));
    p += n;
  }
  return { className: strings[0], strings, payloadStart: p };
}

export async function readRecordsAsync(input) {
  const file = toUint8Array(input);
  const isRp = file[0] === 0xac && file[1] === 0xef;
  const isBareStream = !isRp && file.length > 4 && u32le(file, 4) > 0;
  if (!isRp && !isBareStream) throw new Error('Not an Axure .rp / .rplib file');
  const candidates = [];
  for (let offset = isRp ? 15 : 4; offset + 18 <= file.length; offset++) {
    if (file[offset] !== 0x1f || file[offset + 1] !== 0x8b || file[offset + 2] !== 8) continue;
    const compressedSize = u32le(file, offset - 4);
    if (compressedSize < 18 || offset + compressedSize > file.length) continue;
    candidates.push({ offset, compressedSize, slice: file.subarray(offset, offset + compressedSize) });
  }
  const decoded = await Promise.all(candidates.map(async c => {
    try {
      const raw = await gunzipBytes(c.slice);
      const parsed = parseRecordBytes(raw);
      return { ...c, raw, parsed };
    } catch {
      return null;
    }
  }));
  const records = [];
  let minNextOffset = 0;
  for (const item of decoded) {
    if (!item || item.offset < minNextOffset) continue;
    records.push({
      index: records.length,
      offset: item.offset,
      compressedSize: item.compressedSize,
      raw: item.raw,
      ...item.parsed,
    });
    minNextOffset = item.offset + item.compressedSize;
  }
  return records;
}

const LAYOUTS = ['none', 'u8', 'u16', 'u32', 'u64', 'dict', 'list'];
const OPAQUE_BYTES = { none: 0, u8: 1, u16: 2, u32: 4, u64: 8 };

function parsePayloadRaw(buf, record, layouts, out) {
  const nodes = [], objects = new Map();
  out.nodes = nodes;
  let p = 0;
  const u32 = () => { const n = u32le(buf, p); p += 4; return n; };
  const count = per => {
    const n = u32();
    if (n * per > buf.length - p) throw new RangeError(`Count ${n} exceeds remaining payload at ${p}`);
    return n;
  };
  const val = () => {
    const start = p, tag = u32(), n = { start, tag };
    nodes.push(n);
    switch (tag) {
      case 1: n.entries = Array.from({ length: count(8) }, () => [val(), val()]); break;
      case 2: n.items = Array.from({ length: count(4) }, () => val()); break;
      case 3: case 0xf: case 0x12: case 5: case 8: case 0x11: case 0x14: case 0x16: n.value = u32(); break;
      case 4: { const size = count(1); n.value = bytesToBase64(buf.subarray(p, p + size)); p += size; break; }
      case 6: n.rawNumber = bytesToHex(buf.subarray(p, p + 8)); n.value = f64le(buf, p); p += 8; break;
      case 9: n.id = u32(); n.classIndex = u32(); n.className = record.strings[n.classIndex - 1]; n.body = val(); objects.set(n.id, n); break;
      case 0x10: case 0x13: n.values = [u32(), u32()]; break;
      case 0x19: n.value = !!buf[p++]; break;
      case 26: case 28: case 0x1a: case 0x1c: break;
      case 0x1d: n.value = bytesToHex(buf.subarray(p, p + 8)); p += 8; break;
      case 0x1e: {
        const total = count(16);
        n.values = Array.from({ length: total }, () => {
          const b = buf.subarray(p, p + 16);
          p += 16;
          return bytesToHex(b);
        });
        break;
      }
      default: {
        const layout = layouts?.get(tag);
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
          n.raw = bytesToBase64(buf.subarray(start + 4, p));
        }
      }
    }
    n.end = p;
    if (tag === 8) n.text = record.strings[n.value - 1];
    return n;
  };
  const roots = [];
  while (p < buf.length) roots.push(val());
  return { roots, nodes, objects, bytes: buf.length };
}

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

export function parsePayloadBytes(record) {
  const buf = record.raw.subarray(record.payloadStart), first = {};
  try {
    return parsePayloadRaw(buf, record, undefined, first);
  } catch (error) {
    if (error.unknownTag === undefined) throw error;
    const found = [];
    for (const layout of LAYOUTS) {
      let graph;
      try { graph = parsePayloadRaw(buf, record, new Map([[error.unknownTag, layout]]), {}); } catch { continue; }
      if (plausible(graph, record)) found.push({ layout, graph });
    }
    if (!found.length) throw error;
    const node = f => f.graph.nodes.find(n => n.start === error.at);
    if (new Set(found.map(f => node(f).end)).size > 1) throw error;
    const opaque = found.find(f => node(f).kind === 'opaque');
    if (!opaque && found.length > 1) throw error;
    return (opaque ?? found[0]).graph;
  }
}

export function encodePayloadBytes(roots) {
  const chunks = [];
  const u32 = n => chunks.push(wordU32(n));
  const write = n => {
    u32(n.tag);
    if (n.kind === 'opaque') { chunks.push(base64ToBytes(n.raw)); return; }
    if (n.kind === 'container') {
      if (n.layout === 'dict') { u32(n.entries.length); for (const [k, v] of n.entries) { write(k); write(v); } }
      else { u32(n.items.length); n.items.forEach(write); }
      return;
    }
    switch (n.tag) {
      case 1: u32(n.entries.length); for (const [k, v] of n.entries) { write(k); write(v); } break;
      case 2: u32(n.items.length); n.items.forEach(write); break;
      case 3: case 5: case 8: case 0xf: case 0x11: case 0x12: case 0x14: case 0x16: u32(n.value); break;
      case 4: { const b = base64ToBytes(n.value); u32(b.length); chunks.push(b); break; }
      case 6: {
        const b = new Uint8Array(8);
        if (Number.isNaN(n.value) && n.rawNumber) b.set(hexToBytes(n.rawNumber));
        else new DataView(b.buffer).setFloat64(0, n.value, true);
        chunks.push(b);
        break;
      }
      case 9: u32(n.id); u32(n.classIndex); write(n.body); break;
      case 0x10: case 0x13: n.values.forEach(u32); break;
      case 0x19: chunks.push(new Uint8Array([n.value ? 1 : 0])); break;
      case 26: case 28: case 0x1a: case 0x1c: break;
      case 0x1d: chunks.push(hexToBytes(n.value)); break;
      case 0x1e: { const gs = n.values ?? n.value; u32(gs.length); for (const v of gs) chunks.push(hexToBytes(v)); break; }
      default: throw new Error(`Cannot encode tag ${n.tag}`);
    }
  };
  for (const r of roots) write(r);
  return concatU8(chunks);
}

export function encodeRecordBytes(record, strings, payload = record.raw.subarray(record.payloadStart)) {
  const header = new Uint8Array(record.raw.subarray(0, 32));
  writeU32LE(header, 28, strings.length);
  const parts = [header];
  for (const s of strings) {
    const b = UTF8_ENCODER.encode(s);
    parts.push(wordU32(b.length), b);
  }
  parts.push(payload);
  return concatU8(parts);
}

async function replaceRecordAsync(file, record, raw) {
  const compressed = await gzipBytes(raw);
  const length = wordU32(compressed.length);
  const manifest = readManifestBytes(file);
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
  return concatU8([
    encodeManifestBytes(file, manifest.value),
    file.subarray(manifest.dataStart, record.offset - 4),
    length,
    compressed,
    file.subarray(record.offset + record.compressedSize),
  ]);
}

async function replaceRecordsAsync(file, replacements) {
  if (!replacements.length) return file;
  const manifest = readManifestBytes(file);
  const edits = await Promise.all(replacements.map(async ({ record, raw }) => {
    const compressed = await gzipBytes(raw);
    return {
      record,
      compressed,
      length: wordU32(compressed.length),
      relative: record.offset - 8 - manifest.dataStart,
      delta: compressed.length - record.compressedSize,
      found: 0,
    };
  }));
  edits.sort((a, b) => a.record.offset - b.record.offset);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].record.offset <= edits[i - 1].record.offset + edits[i - 1].record.compressedSize) {
      throw new Error('Overlapping record replacements');
    }
  }
  const prefix = [0];
  for (const edit of edits) prefix.push(prefix.at(-1) + edit.delta);
  const update = node => {
    for (const [key, offset] of Object.entries(node.parts ?? {})) {
      let lo = 0, hi = edits.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (edits[mid].relative < offset) lo = mid + 1; else hi = mid; }
      if (edits[lo]?.relative === offset) edits[lo].found++;
      node.parts[key] = offset + prefix[lo];
    }
    for (const child of Object.values(node.children ?? {})) update(child);
  };
  update(manifest.value.root);
  if (edits.some(edit => edit.found !== 1)) throw new Error('Each replacement must have exactly one manifest reference');
  const chunks = [encodeManifestBytes(file, manifest.value)];
  let cursor = manifest.dataStart;
  for (const { record, length, compressed } of edits) {
    chunks.push(file.subarray(cursor, record.offset - 4), length, compressed);
    cursor = record.offset + record.compressedSize;
  }
  chunks.push(file.subarray(cursor));
  return concatU8(chunks);
}

async function insertRecordAsync(file, key, raw, beforeRecord) {
  const manifest = readManifestBytes(file);
  if (manifest.value.root.children?.[key]) throw new Error(`Package already exists: ${key}`);
  const compressed = await gzipBytes(raw);
  const prefix = new Uint8Array(8);
  writeU32LE(prefix, 4, compressed.length);
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
  let encoded = encodeManifestBytes(file, manifest.value);
  for (let i = 0; i < 8; i++) {
    const again = encodeManifestBytes(file, manifest.value);
    if (again.length === encoded.length) break;
    encoded = again;
  }
  return concatU8([
    encoded,
    file.subarray(manifest.dataStart, beforeRecord.offset - 8),
    prefix,
    compressed,
    file.subarray(beforeRecord.offset - 8),
  ]);
}

async function appendPackageAsync(file, key, raw) {
  const manifest = readManifestBytes(file);
  if (manifest.value.root.children?.[key]) throw new Error(`Package already exists: ${key}`);
  const B0 = file.length - manifest.dataStart;
  const compressed = await gzipBytes(raw);
  const prefix = new Uint8Array(8);
  writeU32LE(prefix, 4, compressed.length);
  const body = file.subarray(manifest.dataStart);
  manifest.value.root.children ??= {};
  manifest.value.root.children[key] = { parts: { package: B0 } };
  let encoded = encodeManifestBytes(file, manifest.value);
  for (let i = 0; i < 8; i++) {
    const again = encodeManifestBytes(file, manifest.value);
    if (again.length === encoded.length) break;
    encoded = again;
  }
  return concatU8([encoded, body, prefix, compressed]);
}

const field = (map, name) => map?.entries?.find(([k]) => k.text === name)?.[1];
const walkNodes = (roots, visit) => {
  for (const n of roots) {
    visit(n);
    if (n.entries) for (const pair of n.entries) walkNodes(pair, visit);
    if (n.items) walkNodes(n.items, visit);
    if (n.body) walkNodes([n.body], visit);
  }
};

function stringNode(strings, text) {
  let index = strings.indexOf(text);
  if (index < 0) { index = strings.length; strings.push(text); }
  return { tag: 8, value: index + 1, text };
}

// ---- Synced blank synthesizer (RP9 & RP11) ----
const BLANK_THUMBNAIL = base64ToBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC');
const CONFIGS = [
  ['HtmlPrototypeGeneratorConfiguration', 'HTML 1'],
  ['Word2007SpecificationGeneratorConfiguration', 'Word Doc 1'],
  ['CsvAnnotationReportGeneratorConfiguration', 'CSV Report 1'],
  ['PrintConfig', 'Print 1'],
];
const HEADING_PRESETS = [
  ['111111119451fb4da49f67fd55eb1f88', 24],
  ['9d5ca1b3e0dd2045be40f94c8168891e', 18],
  ['5a4c7a8c9ad66943a5f7788171ac0b32', 13.5],
  ['91c895e97907c8459c0b5fe110d15a0b', 10.5],
  ['ef196b38e14bbd439b6c392ded969f89', null],
  ['139a3bfc57b5a04f98ef0a1db9aac861', 7.5],
];
const EDITOR_VERSIONS = { 9: { fileBuild: 1, assemblyRevision: 3754 }, 11: { fileBuild: 0, assemblyRevision: 4137 } };

export async function synthesizeBlankProjectBytes({ version = 11, pageName = 'Page 1' } = {}) {
  const target = Number(version);
  if (target !== 9 && target !== 11) throw new Error(`Unsupported target version: ${version}`);
  if (typeof pageName !== 'string' || !pageName.trim()) throw new Error('Page name must not be empty');
  const newGuid = () => guidKey(randomGuidHex());
  const scalar = (tag, value) => ({ tag, value });
  const integer = value => scalar(5, value);
  const number = value => scalar(6, value);
  const bool = value => scalar(0x19, value);
  const ref = value => scalar(3, value);
  const guid = value => scalar(0x11, value);
  const list = (items = []) => ({ tag: 2, items });
  const dict = (entries = []) => ({ tag: 1, entries });

  const blankRec = async (className, packageGuid, build) => {
    const strings = [];
    const textIndex = new Map();
    const string = value => {
      if (!textIndex.has(value)) textIndex.set(value, strings.push(value));
      return scalar(8, textIndex.get(value));
    };
    const fields = values => dict(Object.entries(values).map(([k, v]) => [string(k), v]));
    const object = (id, type, values) => ({ tag: 9, id, classIndex: string('Axure:' + type).value, body: fields(values) });
    const packageRef = (type, id) => ({ tag: 0x13, values: [string(type).value, id] });
    string('Axure:' + className);
    const guids = [newGuid(), packageGuid];
    const objects = build({ fields, object, packageRef, string, guids });
    const header = new Uint8Array(32);
    writeU32LE(header, 0, 0x1b);
    writeU32LE(header, 4, target);
    writeU32LE(header, 12, target === 9 ? 1 : 0);
    writeU32LE(header, 20, 0xc351);
    writeU32LE(header, 24, 31);
    return gzipBytes(encodeRecordBytes({ raw: header }, strings, encodePayloadBytes([
      { tag: 0x1e, values: guids }, scalar(0x1a), scalar(0xf, 1), scalar(0x12, 2), ...objects, scalar(0x1c),
    ])));
  };

  const solidFill = (ctx, color) => ctx.fields({ 'fill-type': ctx.string('solid'), 'fill-color': integer(color) });
  const defaultStyleVals = (ctx, styleId, typefaceId) => {
    const { fields, string } = ctx;
    const fill = c => solidFill(ctx, c);
    const shadow = (x, y, c) => fields({ On: bool(false), OffsetX: number(x), OffsetY: number(y), BlurRadius: number(5), Color: integer(c), Spread: number(0) });
    const point = (x, y) => fields({ X: number(x), Y: number(y) });
    const props = {
      0: guid(styleId), 1: string('Arial'), 2: number(9.75), 3: integer(0), 4: integer(0), 5: bool(false),
      6: fill(0xff333333), 7: fill(0xffffffff), 8: fill(0xff797979), 9: integer(1), 10: integer(1),
      11: number(2), 12: number(2), 13: number(2), 14: number(2), 15: number(1), 16: integer(1),
      17: fields({ Start: integer(1), End: integer(1) }), 20: number(0), 21: dict(),
      27: fields({ Hash: string('') }), 30: integer(0),
      34: fields({ HorizontalAlignment: integer(0), VerticalAlignment: integer(0) }), 35: fields({ Hash: string('') }),
      50: number(0), 51: number(0), 70: number(1), 71: number(0),
      72: shadow(5, 5, 0x59000000), 73: shadow(0, 5, 0x59000000), 74: shadow(1, 1, 0xa5000000),
      80: integer(15), 81: integer(15),
      90: fields({ On: bool(false), ColorSaturation: number(1), ColorBrightness: number(0), ColorContrast: number(1), HueRotation: number(0) }),
      91: number(0), 92: integer(0), 93: integer(0), 94: number(12), 95: bool(false), 96: guid(typefaceId),
      97: fields({ IndentLevel: integer(0), ListType: integer(0) }), 101: point(0, 0),
      105: fields({ Width: number(0), Height: number(0) }), 106: integer(0), 107: integer(0),
      110: bool(true), 111: integer(1), 1001: integer(400), 1002: integer(0), 1003: integer(5),
    };
    if (target === 11) Object.assign(props, {
      108: bool(false), 109: bool(false),
      1400: fields({ Duration: number(0), Easing: integer(0) }),
      1401: fields({ ScaleX: number(1), ScaleY: number(1), TranslateX: number(0), TranslateY: number(0), Rotate: number(0) }),
      1402: point(50, 50), 1403: fields({ On: bool(false), Radius: integer(4) }), 1404: fields({ On: bool(false), Radius: integer(4) }),
    });
    return props;
  };
  const styleProps = (fields, values, enabled) => list(Object.entries(values).map(([id, Value]) => fields({
    DOAName: integer((!enabled || enabled.has(Number(id)) ? 0xc0000000 : 0x80000000) + Number(id)),
    Value,
  })));

  const page = { id: newGuid(), name: pageName, type: 'Axure:Page' };
  const styleGuid = newGuid(), typefaceGuid = newGuid();
  const generators = CONFIGS.map(([type, name]) => ({ type: 'Axure:' + type, name, id: newGuid() }));

  const manifest = { root: { children: {}, parts: {} } };
  const chunks = [];
  let length = 0;
  const appendChunk = data => {
    const offset = length;
    chunks.push(wordU32(0), wordU32(data.length), data);
    length += 8 + data.length;
    return offset;
  };

  for (const generator of generators) {
    const type = generator.type.slice('Axure:'.length);
    const data = await blankRec(type, generator.id, ({ object }) => [object(1, type, {})]);
    manifest.root.children[guidKey(generator.id)] = { parts: { package: appendChunk(data) } };
  }

  const thumbnail = appendChunk(BLANK_THUMBNAIL);
  const pageCompressed = await blankRec('Page', page.id, ({ fields, object, string, guids }) => {
    guids.push(NULL_GUID);
    while (guids.length < 12) guids.push(newGuid());
    guids.push(styleGuid, typefaceGuid);
    const styleInfo = fields({ LibraryId: guid(3), LibraryName: string(''), Id: guid(13), Name: string('Default') });
    return [
      object(1, 'Page', {
        AdaptiveViewSetId: guid(3), AdaptiveViewSet: ref(3), diagram: ref(4), 'page-style': ref(5),
        AdaptiveStyles: list(), AdaptiveViewMatchInfos: list(), annotation: ref(6), interactionmap: ref(7),
        StyleCache: fields({
          Styles: list([fields({ Info: styleInfo, Props: styleProps(fields, defaultStyleVals({ fields, string }, 13, 14)) })]),
          TypefaceToFullName: list(), TypefaceToCssName: list(),
        }),
        HackLegacyContainedObjects2: bool(true),
      }),
      object(4, 'Diagram', { 'diagram-objects': list(), AnnLinkList: ref(9), 'ruler-guide-set': ref(10), GroupsClean3: bool(true) }),
      object(9, 'AnnotationTreeMap', { 'node-table': dict(), tree: ref(11) }),
      object(10, 'RulerGuideSet', { 'ruler-guides': list() }),
      object(11, 'Tree', { children: list(), tree: ref(11) }),
      object(5, 'PageStyle', {
        'BaseStyle.Name': string(''), 'style-name': string('Page style'), Id: guid(5), PropList: list(),
        Capabilities: scalar(0x1d, target === 11 ? 'ffffbfffffffffff' : 'ffffefffffffffff'), All: bool(false),
      }),
      object(6, 'Annotation', {
        'property-name-id-to-value': dict(), 'property-name-id-to-name-text': dict(),
        'annotation-field-set-type': string('PageFragment'), OwnerId: scalar(0x16, 3), StaticFields: integer(0),
      }),
      object(7, 'InteractionTreeMap', { 'node-table': dict(), tree: ref(12), PackageMode: bool(false) }),
      object(12, 'Tree', { children: list(), tree: ref(12) }),
    ];
  });
  manifest.root.children[guidKey(page.id)] = { parts: { thumbnail, package: appendChunk(pageCompressed) } };

  const docCompressed = await blankRec('DesignDocument', newGuid(), ctx => {
    const { fields, object, packageRef, string, guids } = ctx;
    while (guids.length < 37) guids.push(newGuid());
    guids[15 - 1] = page.id;
    generators.forEach(({ id }, index) => { guids[16 + index - 1] = id; });
    guids[20 - 1] = styleGuid;
    guids[21 - 1] = NULL_GUID;
    guids[28 - 1] = typefaceGuid;
    const libId = guids.push('89a1f4538b16484793d409a1b736ad03');
    const defaults = defaultStyleVals(ctx, 20, 28);
    const pKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 27, 70, 71, 72, 73, 74, 80, 81, 90, 91, 92, 93, 95, 1001, 1002, 1003];
    if (target === 11) pKeys.push(1400, 1401, 1402, 1403, 1404);
    const presetDefaults = Object.fromEntries(pKeys.map(k => [k, defaults[k]]));
    const transparentTB = { 7: solidFill(ctx, 0x00ffffff), 9: integer(0), 10: integer(0), 11: number(0), 12: number(0), 13: number(0), 14: number(0), 15: number(0) };
    const mkPreset = (name, identity, props, enabled = Object.keys(props).map(Number)) => {
      const id = guids.push(identity);
      return object(id, 'Style', {
        LibraryId: guid(libId), LibraryName: string('Default'), LegacyName: string(''),
        'style-name': string(name), Id: guid(id),
        PropList: styleProps(fields, { ...presetDefaults, ...props }, new Set(enabled)),
        Capabilities: scalar(0x1d, 'ffffffffffffffff'), All: bool(true),
      });
    };
    const presets = [
      ...HEADING_PRESETS.map(([id, size], i) => mkPreset(`Heading ${i + 1}`, id, { ...transparentTB, 3: integer(1), ...(size !== null && { 2: number(size) }) })),
      mkPreset('Paragraph', '3dd48849b4800840a4a415096f1632af', transparentTB),
      mkPreset('Form Hint', '66d68948ade85e4c81e59863039a5cc0', { 6: solidFill(ctx, 0xff999999) }),
      mkPreset('Form Disabled', '6223d09ba917894db0314c8c7fc75f16', { 6: solidFill(ctx, 0xff000000), 7: solidFill(ctx, 0xfff0f0f0) }, [7]),
    ];
    const packages = [page, ...generators];
    const config = (index, type = generators[index].type) => packageRef(type, 16 + index);
    const propSet = (id, name) => [
      object(id, 'AnnotationFieldSet', { 'property-key': ref(id + 1), 'annotation-field-views': list() }),
      object(id + 1, 'PropertyKey', { 'propertykey-items': list([ref(id + 2)]), 'name-index': fields({ [name]: integer(0) }) }),
      object(id + 2, 'PropertyKeyItem', { 'property-name': ref(id + 3), 'data-type': string('Text'), 'select-list': string('') }),
      object(id + 3, 'PropertyName', { name: string(name), 'property-name-id': string(randomGuidHex()) }),
    ];
    return [
      object(1, 'DesignDocument', {
        'document-type': integer(1), SavedEdition: integer(1), StyleSheet: ref(3), PageStyleSheet: ref(4), GlobalVariableSet: ref(5),
        DiagramObjectAnnotationFieldSet: ref(29), PageFragmentAnnotationFieldSet: ref(33),
        PackageInfos: list(packages.map((_, i) => ref(8 + i))),
        AdaptiveViewSets: list(), sitemap: ref(13), mastermap: ref(14),
        'default-prototype-configuration-id': config(0),
        'generator-configuration-ids': list(generators.map(({ name }, i) => config(i, name))),
        'default-specification-configuration-id': config(1), DefaultPrintConfigId: config(3, generators[0].type),
        'ruler-guide-set': ref(22), UpgradedSVNFrom7Hack: bool(false),
      }),
      object(3, 'StyleSheet', { GuidToDuplicate: dict(), ArchivedStyles: list(), CustomStyles: list(presets.map(s => ref(s.id))), DefaultStyle: ref(20), LegacyTableHorz: integer(1), LegacyTableVert: integer(1) }),
      object(20, 'Style', { LibraryId: guid(21), LibraryName: string(''), LegacyName: string(''), 'style-name': string('Default'), Id: guid(20), PropList: styleProps(fields, defaults), Capabilities: scalar(0x1d, 'ffffffffffffffff'), All: bool(true) }),
      ...presets,
      object(4, 'PageStyleSheet', { GuidToDuplicate: dict(), ArchivedStyles: list(), PageStyles: list(), DefaultPageStyle: ref(23) }),
      object(23, 'PageStyle', { 'BaseStyle.Name': string(''), 'style-name': string('Default'), Id: guid(20), PropList: list(), Capabilities: scalar(0x1d, target === 11 ? 'ffffbfffffffffff' : 'ffffefffffffffff'), All: bool(true) }),
      object(5, 'GlobalVariableSet', { 'global-variables': list([ref(24)]) }),
      object(24, 'GlobalVariable', { name: string('OnLoadVariable'), 'variable-id': guid(24), 'default-value': string('') }),
      ...propSet(29, 'Note'), ...propSet(33, 'Page Overview'),
      ...packages.map(({ type, name }, i) => object(8 + i, 'PackageInfo', {
        'package-id': packageRef(type, 15 + i), 'package-name': string(name), dependencies: list(),
        'root-panel-infos': list(), 'diagram-type': integer(0), LoadedRdoPackages: list(), LoadedScreenshotPackages: list(),
        PackageSavedVersion: fields({ Major: integer(i === 0 && target === 9 ? 9 : 0), Minor: integer(0), Build: integer(i === 0 && target === 9 ? 1 : 0), Revision: integer(0) }),
      })),
      object(13, 'SiteTreeMap', { 'node-table': dict([[ref(25), packageRef('Axure:PackageInfo', 15)]]), tree: ref(26) }),
      object(25, 'Node', { children: list(), 'parent-node': ref(26), tree: ref(26) }),
      object(26, 'Tree', { children: list([ref(25)]), tree: ref(26) }),
      object(14, 'MasterTreeMap', { 'node-table': dict(), tree: ref(27) }),
      object(27, 'Tree', { children: list(), tree: ref(27) }),
      object(22, 'RulerGuideSet', { 'ruler-guides': list() }),
    ];
  });
  manifest.root.parts.DesignDocument = appendChunk(docCompressed);

  const { fileBuild, assemblyRevision } = EDITOR_VERSIONS[target];
  const versionXml = `<BreakingChanges>\n<Change Fail="True" UseMessage="False" Beta="${target === 11}">\n<Version>${target}.0.0.0</Version><Message>Open this project in Axure RP ${target} or later.</Message><TeamMessage>Open this project in Axure RP ${target} or later.</TeamMessage>\n</Change></BreakingChanges>`;
  manifest.root.parts[`${target}.0.0.${assemblyRevision}.version`] = appendChunk(await gzipBytes(UTF8_ENCODER.encode(versionXml)));

  const settingsCompressed = await blankRec('DocumentSettings', NULL_GUID, ctx => {
    const { fields, object, string, guids } = ctx;
    guids.push(page.id, typefaceGuid, newGuid(), newGuid(), newGuid(), styleGuid);
    const modern = target === 11;
    const vh = (Build, Revision) => list([fields({ Major: integer(target), Minor: integer(0), Build: integer(Build), Revision: integer(Revision) })]);
    const margin = number(modern ? 10 : 0.5);
    return [
      object(1, 'DocumentSettings', {
        'collasped-page-ids': list(), 'collasped-master-folder-ids': list(),
        'data-column-ids': list(), 'data-column-widths': list(),
        ...(modern && { FloatingEditorLayoutInfos: dict() }),
        'selected-tab-package-id': guid(3), 'selected-tab-object-id': guid(2),
        'open-tab-package-ids': list(modern ? [guid(2), guid(3)] : [guid(3)]),
        'open-tab-object-ids': list(modern ? [guid(2), guid(2)] : [guid(2)]),
        'dpmanager-editor-package-ids': list(), 'dpmanager-editor-object-ids': list(),
        'dpmanager-collapse-object-ids': list(), 'collasped-interaction-treeview-ids': list(),
        IsMetric: bool(modern), IsPrintPortrait: bool(true),
        PrintSize: fields({ Width: number(modern ? 210 : 8.5), Height: number(modern ? 297 : 11) }),
        PrintMargins: fields({ Left: margin, Top: margin, Right: margin, Bottom: margin }),
        PrintResolution: number(modern ? 100 / 25.4 : 100),
        CurrentAdaptiveView: guid(4), FormatPainterStyle: ref(5), 'print-settings': ref(6),
        ...(modern && { UploadedSitmapIds: list(), PrototypeDeleted: bool(false), ShowLastPublishedCurrentLinks: bool(false) }),
        PrototypeId: string(''), PrototypeName: string(''), WorkspaceName: string(''),
        LastUsedPublishAddress: string(''), LastUsedPublishHost: string(''),
        LastUsedLoginId: string('00000000-0000-0000-0000-000000000000'),
        LibraryCollapsedCategories: list(), HtmlPreviewConfigId: guid(2), AxsharePrototypeConfigId: guid(2),
        FileVersionHistory: vh(fileBuild, 0), AssemblyVersionHistory: vh(0, assemblyRevision),
      }),
      object(5, 'Style', { LibraryId: guid(2), LibraryName: string(''), LegacyName: string(''), 'style-name': string('FormatPainterSettings'), Id: guid(7), PropList: styleProps(fields, defaultStyleVals(ctx, 8, 4)), Capabilities: scalar(0x1d, 'ffffffffffffffff'), All: bool(true) }),
      object(6, 'PrintSettings', { 'margin-left': integer(0), 'margin-right': integer(0), 'margin-top': integer(0), 'margin-bottom': integer(0), 'paper-kind': integer(0), 'paper-height': integer(0), 'paper-width': integer(0), 'paper-name': string(''), 'paper-source': integer(0), 'paper-source-name': string(''), landscape: bool(false), 'scale-percentage': integer(100), 'scale-type': integer(1) }),
    ];
  });
  manifest.root.parts.DocumentSettings = appendChunk(settingsCompressed);

  const header = new Uint8Array(8);
  header[0] = 0xac; header[1] = 0xef;
  writeU16LE(header, 2, target);
  return concatU8([encodeManifestBytes(header, manifest), ...chunks]);
}

// ---- Synced RP9 / RP11 Version Field Tables & Adapter ----
const RP9_TAG_OVERRIDES = { EnableDisableWidgetsInfo: { enable: 'bool' } };
const RP11_ONLY_KEYS = {
  AdaptiveView: ['Cursor'],
  AddFilterToRepeaterInfo: ['ColumnId', 'ColumnName', 'Condition', 'FilterComboType', 'UseCondition'],
  AddSortToRepeaterInfo: ['remove-all-sorts'],
  DeleteItemsFromDataSetInfo: ['RowIndicesRule', 'RowIndicesText'],
  'DiagramObject:Checkbox': ['Error'],
  'DiagramObject:ComboBox': ['Error'],
  'DiagramObject:Connector': ['Error'],
  'DiagramObject:DynamicPanel': ['Error', 'ExpandedOnOutlineTreeView'],
  'DiagramObject:Hyperlink': ['Error'],
  'DiagramObject:ImageBox': ['Error'],
  'DiagramObject:ImageMapRegion': ['Error', 'InteractionMap'],
  'DiagramObject:InlineFrame': ['Error'],
  'DiagramObject:Layer': ['Error', 'ExpandedOnOutlineTreeView'],
  'DiagramObject:ListBox': ['Error'],
  'DiagramObject:MenuObject': ['Error'],
  'DiagramObject:RadioButton': ['Error'],
  'DiagramObject:Repeater': ['Error', 'ExpandedOnOutlineTreeView', 'Propagate'],
  'DiagramObject:Screenshot': ['Error'],
  'DiagramObject:Table': ['Error'],
  'DiagramObject:TableCell': ['Error'],
  'DiagramObject:TextArea': ['Error'],
  'DiagramObject:TextBox': ['Error'],
  'DiagramObject:TreeNodeObject': ['Error'],
  'DocumentModel:DataSetProp': ['linked-widget-path'],
  DocumentSettings: ['FloatingEditorLayoutInfos', 'PrototypeDeleted', 'ShowLastPublishedCurrentLinks', 'UploadedSitmapIds'],
  FadeWidgetInfo: ['compress-distance-type', 'custom-compress-value', 'page-background-blur', 'scale', 'scale-anchor', 'scale-hide', 'scale-hide-anchor'],
  InteractionAddItemsToDataSetAction: ['Disabled'],
  InteractionAddSortToRepeaterAction: ['Disabled'],
  InteractionCase: ['Disabled'],
  InteractionDeleteItemsFromDataSetAction: ['Disabled'],
  InteractionEnableDisableWidgetsAction: ['Disabled'],
  InteractionEvent: ['Disabled', 'variable-id'],
  InteractionFadeWidgetAction: ['Disabled'],
  InteractionLinkWindowAction: ['Disabled'],
  InteractionMoveWidgetAction: ['Disabled'],
  InteractionRaiseEventAction: ['Disabled'],
  InteractionRotateWidgetAction: ['Disabled'],
  InteractionSetPanelStateAction: ['Disabled'],
  InteractionSetWidgetSizeAction: ['Disabled'],
  InteractionWaitAction: ['Disabled'],
  InterationActionSetFunction: ['Disabled'],
  PanelDiagram: ['ExpandedOnOutlineTreeView'],
  SetPanelStateInfo: ['compress-distance-type', 'custom-compress-value', 'enter-anchor', 'enter-scale', 'exit-anchor', 'exit-scale'],
};
const RP9_REQUIRED_KEYS = { FadeWidgetInfo: ['vertical'], SetPanelStateInfo: ['vertical'] };
const RP11_ONLY_CLASSES = ['Axure:InteractionApplyStyle', 'Axure:InteractionApplyStyleInfo'];
const RP11_ONLY_EVENTS = { OnErrorSet: 55, OnErrorRemoved: 56, OnBeforeItemLoad: 291 };
const RP11_EVENT_CODE_NAME = new Map(Object.entries(RP11_ONLY_EVENTS).map(([k, v]) => [v, k]));
const RP11_ONLY_FCALLS = new Set(['ToLowerCase', 'GetErrorState', 'SetErrorState']);
const RP11_ONLY_DOA_CODES = {
  0x6c: 'FIXED_HEIGHT', 0x6d: 'FIXED_WIDTH', 0x578: 'TRANSITION', 0x579: 'TRANSFORM',
  0x57a: 'TRANSFORM_ORIGIN', 0x57b: 'WIDGET_BLUR', 0x57c: 'BACKDROP_BLUR', 0x57d: 'PAGE_CURSOR',
};
const DOA_BASE_MASK = 0x0fffffff;
const RP11_REQUIRED_ERROR = new Set(['Axure:DiagramObject:Layer', 'Axure:DiagramObject:ImageBox', 'Axure:DiagramObject:VectorShape']);

function adaptNodesForVersionBytes(nodes, { version, str }) {
  if (version === 11 && str) {
    for (const node of nodes) {
      if (!RP11_REQUIRED_ERROR.has(node.className)) continue;
      const entries = node.body?.entries;
      if (!entries || entries.some(([k]) => k.text === 'Error')) continue;
      entries.push([str('Error'), { tag: 0x19, value: false }]);
    }
    return;
  }
  if (version !== 9) return;
  for (const node of nodes) {
    const cls = node.className;
    if (RP11_ONLY_CLASSES.includes(cls)) throw new Error(`${cls} exists only in Axure RP 11; refusing to write into RP 9`);
    const entries = node.body?.entries;
    if (!entries) continue;
    const short = String(cls).replace(/^Axure:/, '');
    const drop = new Set(RP11_ONLY_KEYS[short] ?? []);
    const overrides = RP9_TAG_OVERRIDES[short] ?? {};
    const kept = [];
    for (const pair of entries) {
      const [keyNode, valueNode] = pair;
      if (drop.has(keyNode.text)) continue;
      if (overrides[keyNode.text] === 'bool' && valueNode.tag !== 0x19) {
        kept.push([keyNode, { tag: 0x19, value: valueNode.value === 0 }]);
        continue;
      }
      kept.push(pair);
    }
    node.body.entries = kept;
  }
}

async function lintVersionKeysBytes(file, target) {
  const errors = [];
  let objects = 0;
  for (const record of await readRecordsAsync(file)) {
    let graph;
    try { graph = parsePayloadBytes(record); } catch { continue; }
    for (const object of graph.objects.values()) {
      objects++;
      const cls = String(object.className || '').replace(/^Axure:/, '');
      const keys = (object.body?.entries ?? []).map(([k]) => k.text);
      const props = object.body?.entries?.find(([k]) => k.text === 'PropList')?.[1];
      for (const item of props?.items ?? []) {
        const doa = (item.entries ?? []).find(([k]) => k.text === 'DOAName')?.[1]?.value;
        if (doa === undefined) continue;
        const code = doa & DOA_BASE_MASK;
        const name = RP11_ONLY_DOA_CODES[code];
        if (name && target === 9) errors.push({ record: record.index, class: cls, objectId: object.id, key: `DOA:0x${code.toString(16)}`, message: `${name} is RP11-only` });
      }
      if (target === 9) {
        const banned = RP11_ONLY_KEYS[cls];
        if (banned) {
          for (const key of keys) if (banned.includes(key)) errors.push({ record: record.index, class: cls, objectId: object.id, key, message: `${cls}.${key} is RP11-only` });
        }
        for (const key of RP9_REQUIRED_KEYS[cls] ?? []) {
          if (!keys.includes(key)) errors.push({ record: record.index, class: cls, objectId: object.id, key, message: `${cls}.${key} missing for RP9` });
        }
      }
    }
  }
  return { version: target, objects, errors };
}

async function inspectEditorReadinessBytes(file, expectedVersion) {
  const mf = readManifestBytes(file);
  const parts = Object.keys(mf.value?.root?.parts ?? {});
  const versionPart = parts.find(k => k.endsWith('.version')) ?? null;
  const recs = await readRecordsAsync(file);
  const docSettings = recs.find(r => r.className === 'Axure:DocumentSettings');
  let fileVersion = null;
  let assemblyVersion = null;
  if (docSettings?.strings) {
    const g = parsePayloadBytes(docSettings);
    const ds = [...g.objects.values()].find(o => o.className === 'Axure:DocumentSettings');
    const parseHist = name => {
      const item = field(ds?.body ?? {}, name)?.items?.[0];
      const hBody = item?.tag === 3 ? g.objects.get(item.value)?.body : (item?.tag === 1 ? item : null);
      if (!hBody) return null;
      return ['Major', 'Minor', 'Build', 'Revision'].map(k => field(hBody, k)?.value ?? 0).join('.');
    };
    fileVersion = parseHist('FileVersionHistory');
    assemblyVersion = parseHist('AssemblyVersionHistory');
  }
  const expectedPrefix = `${expectedVersion}.`;
  const upgradeModalRisk = !versionPart || !versionPart.startsWith(expectedPrefix) || !fileVersion?.startsWith(expectedPrefix);
  return { expectedVersion, versionPart, fileVersion, assemblyVersion, upgradeModalRisk };
}

async function createGlobalVariableBytes(file, name, { defaultValue = '', updateDefault = false } = {}) {
  const records = await readRecordsAsync(file);
  const docRecord = records.find(r => r.className === 'Axure:DesignDocument');
  if (!docRecord) throw new Error('Axure:DesignDocument record not found');
  const doc = parsePayloadBytes(docRecord);
  const strings = [...docRecord.strings];
  const varSet = [...doc.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
  const globalVarsList = field(varSet?.body ?? {}, 'global-variables');
  if (!globalVarsList || globalVarsList.tag !== 2) throw new Error('global-variables list not found');

  for (const it of globalVarsList.items ?? []) {
    const ev = doc.objects.get(it.value);
    const existingName = field(ev?.body ?? {}, 'name')?.text;
    if (existingName && existingName.toLowerCase() === name.trim().toLowerCase()) {
      if (!updateDefault) throw new Error(`Global variable "${name}" already exists`);
      const prior = field(ev.body, 'default-value');
      if (prior?.text === String(defaultValue)) return file;
      const valNode = stringNode(strings, String(defaultValue));
      if (prior) Object.assign(prior, valNode);
      else ev.body.entries.push([stringNode(strings, 'default-value'), valNode]);
      return replaceRecordAsync(file, docRecord, encodeRecordBytes(docRecord, strings, encodePayloadBytes(doc.roots)));
    }
  }

  const roots1e = doc.roots.find(r => r.tag === 0x1e);
  roots1e.values.push(randomGuidHex());
  const varId = roots1e.values.length;
  let maxId = 0;
  for (const id of doc.objects.keys()) if (id > maxId) maxId = id;
  const newObjId = maxId + 1;
  const newVarObj = {
    tag: 9,
    className: 'Axure:GlobalVariable',
    id: newObjId,
    classIndex: stringNode(strings, 'Axure:GlobalVariable').value,
    body: {
      tag: 1,
      entries: [
        [stringNode(strings, 'name'), stringNode(strings, name.trim())],
        [stringNode(strings, 'variable-id'), { tag: 0x11, value: varId }],
        [stringNode(strings, 'default-value'), stringNode(strings, String(defaultValue))],
      ],
    },
  };
  doc.objects.set(newObjId, newVarObj);
  globalVarsList.items.push({ tag: 3, value: newObjId });
  let lastIdx = -1;
  for (let i = 0; i < doc.roots.length; i++) if (doc.roots[i].className === 'Axure:GlobalVariable') lastIdx = i;
  const insertAt = lastIdx >= 0 ? lastIdx + 1 : doc.roots.findIndex(r => r.className === 'Axure:GlobalVariableSet') + 1;
  doc.roots.splice(insertAt, 0, newVarObj);
  return replaceRecordAsync(file, docRecord, encodeRecordBytes(docRecord, strings, encodePayloadBytes(doc.roots)));
}

export async function fixPanelRegistryBytes(file, { version } = {}) {
  const target = version ?? detectFileVersionBytes(file);
  if (target !== 9) return { file, report: { version: target, skipped: true } };
  const records = await readRecordsAsync(file);
  const graphs = new Map();
  for (const r of records) { try { if (r.strings) graphs.set(r.index, parsePayloadBytes(r)); } catch {} }
  const stateByGuid = new Map();
  for (const r of records) {
    if (r.className !== 'Axure:PanelState') continue;
    const g = graphs.get(r.index);
    const guid = guidsOf(g)[1];
    if (!guid) continue;
    const pd = [...g.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
    stateByGuid.set(guid, { record: r, index: r.index, name: field(pd?.body ?? {}, 'Name')?.text ?? '' });
  }
  const parentOf = new Map();
  const walk = (node, pGuid) => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      const g = unguidKey(key);
      if (pGuid) parentOf.set(g, pGuid);
      walk(child, g);
    }
  };
  walk(readManifestBytes(file).value.root, null);
  const docRec = records.find(r => r.className === 'Axure:DesignDocument');
  if (!docRec) throw new Error('No Axure:DesignDocument record');
  const docGraph = graphs.get(docRec.index);
  const strings = [...docRec.strings];
  const dg = guidsOf(docGraph);
  const nullId = dg.indexOf(NULL_GUID) + 1;
  const str = t => stringNode(strings, t);
  const dictOf = entries => ({ tag: 1, entries });
  const list = items => ({ tag: 2, items });
  const ref = v => ({ tag: 3, value: v });
  const u32 = v => ({ tag: 0x11, value: v });
  const typed2 = (t, g) => ({ tag: 0x13, values: [t, g] });
  const bool = v => ({ tag: 0x19, value: !!v });

  const pkgInfoByGuid = new Map();
  for (const pi of docGraph.objects.values()) {
    if (pi.className !== 'Axure:PackageInfo') continue;
    const idx = field(pi.body, 'package-id')?.values?.[1];
    const g = idx ? dg[idx - 1] : null;
    if (g) pkgInfoByGuid.set(g, pi);
  }

  let added = 0;
  const newObjId = () => { dg.push(randomGuidHex()); return dg.length; };
  const guidIndexOf = g => { let i = dg.indexOf(g); if (i < 0) { dg.push(g); i = dg.length - 1; } return i + 1; };

  for (const r of records) {
    const g = graphs.get(r.index);
    if (!g) continue;
    const panels = [...g.objects.values()].filter(o => o.className === 'Axure:DiagramObject:DynamicPanel');
    if (!panels.length) continue;
    const ownerGuid = guidsOf(g)[1];
    const pkgInfo = pkgInfoByGuid.get(ownerGuid) ?? pkgInfoByGuid.get(parentOf.get(ownerGuid) ?? ownerGuid);
    if (!pkgInfo) continue;
    let rootList = field(pkgInfo.body, 'root-panel-infos');
    if (!rootList) { rootList = list([]); pkgInfo.body.entries.push([str('root-panel-infos'), rootList]); }
    const panelGuids = guidsOf(g);
    for (const panel of panels) {
      const stateGuids = (field(panel.body, 'panel-diagrams')?.items ?? []).map(it => panelGuids[(it.values?.[1] ?? 0) - 1]).filter(Boolean);
      const states = stateGuids.map(sg => stateByGuid.get(sg)).filter(Boolean);
      if (!states.length) continue;
      const panelName = field(field(panel.body, 'name-block') ?? {}, 'text')?.text ?? '';
      const existing = rootList.items.map(it => docGraph.objects.get(it.value))
        .find(o => o && field(o.body, 'name')?.text === panelName && (field(o.body, 'panel-diagram-infos')?.items?.length ?? 0) === states.length);
      if (existing) continue;
      const stateInfoIds = states.map((st, idx) => {
        const id = newObjId();
        docGraph.objects.set(id, {
          tag: 9, id, classIndex: str('Axure:PanelDiagramInfo').value, className: 'Axure:PanelDiagramInfo',
          body: dictOf([
            [str('name'), str(st.name)],
            [str('PackageId'), typed2(str('Axure:PanelState').value, guidIndexOf(stateGuids[idx]))],
            [str('IsSubPackage'), bool(false)],
            [str('contained-panel-infos'), list([])],
            [str('LoadedRdoPackages'), list([])],
            [str('LoadedScreenshotPackages'), list([])],
          ]),
        });
        docGraph.roots.splice(docGraph.roots.length - 1, 0, docGraph.objects.get(id));
        return id;
      });
      const dpiId = newObjId();
      docGraph.objects.set(dpiId, {
        tag: 9, id: dpiId, classIndex: str('Axure:DynamicPanelInfo').value, className: 'Axure:DynamicPanelInfo',
        body: dictOf([
          [str('name'), str(panelName)],
          [str('object-id'), u32(nullId)],
          [str('panel-diagram-infos'), list(stateInfoIds.map(id => ref(id)))],
          [str('subdiagram-parent-type'), str('Axure:DiagramObject:DynamicPanel')],
        ]),
      });
      docGraph.roots.splice(docGraph.roots.length - 1, 0, docGraph.objects.get(dpiId));
      rootList.items.push(ref(dpiId));
      added++;
    }
  }
  if (!added) return { file, report: { version: target, addedPanels: 0 } };
  const raw = encodeRecordBytes(docRec, strings, encodePayloadBytes(docGraph.roots));
  return { file: await replaceRecordAsync(file, docRec, raw), report: { version: target, addedPanels: added } };
}

// ---- High-level Browser Repair (D3) ----
export async function repairRpBytes(corruptInput, { allowEmpty = false } = {}) {
  const file = toUint8Array(corruptInput);
  const discarded = [];
  let manifestOk = false;
  let origManifest = null;
  try {
    origManifest = readManifestBytes(file);
    manifestOk = true;
  } catch (err) {
    discarded.push({ kind: 'corrupt-manifest', reason: err.message });
  }

  const salvaged = [];
  for (let offset = 0; offset + 18 <= file.length; offset++) {
    if (file[offset] !== 0x1f || file[offset + 1] !== 0x8b || file[offset + 2] !== 8) continue;
    const dec = tryDecompressGzipAtBytes(file, offset);
    if (!dec) continue;
    let parsed;
    try { parsed = parseRecordBytes(dec.raw); } catch (err) {
      discarded.push({ kind: 'corrupt-record', offset, reason: err.message });
      continue;
    }
    const record = { index: salvaged.length, offset, compressedSize: dec.compressedSize, raw: dec.raw, ...parsed };
    if (record.strings) {
      try { record.graph = parsePayloadBytes(record); } catch (err) {
        discarded.push({ kind: 'unparseable-record', className: record.className, offset, reason: err.message });
        offset += dec.compressedSize - 1;
        continue;
      }
    }
    salvaged.push(record);
    offset += dec.compressedSize - 1;
  }

  let version = 11;
  if (file.length >= 8 && file[0] === 0xac && file[1] === 0xef) {
    const hv = u16le(file, 2);
    if (hv === 9 || hv === 11) version = hv;
  } else {
    const firstRec = salvaged.find(r => r.strings);
    const rv = firstRec?.raw?.length >= 8 ? u32le(firstRec.raw, 4) : 0;
    if (rv === 9 || rv === 11) version = rv;
  }

  const packageGuidOf = g => guidsOf(g)[g?.roots?.find(n => n.tag === 0x12)?.value - 1] ?? guidsOf(g)[1];
  const docRecord = salvaged.find(r => r.className === 'Axure:DesignDocument' && r.graph);
  const pageMetaByGuid = new Map();
  const pageOrder = [];
  const salvagedVars = [];
  if (docRecord) {
    const dg = docRecord.graph;
    const dGuids = guidsOf(dg);
    const dRoot = dg.objects.get(dg.roots.find(n => n.tag === 0xf)?.value);
    const infos = new Map();
    for (const item of field(dRoot?.body ?? {}, 'PackageInfos')?.items ?? []) {
      const info = dg.objects.get(item.value);
      const pid = field(info?.body ?? {}, 'package-id')?.values;
      if (!pid) continue;
      if (docRecord.strings[pid[0] - 1] === 'Axure:Page' && dGuids[pid[1] - 1]) {
        infos.set(pid[1], { pkgGuid: dGuids[pid[1] - 1], name: strOf(field(info.body, 'package-name')) ?? '(未命名)' });
      }
    }
    const site = dg.objects.get(field(dRoot?.body ?? {}, 'sitemap')?.value);
    const nodeTable = field(site?.body ?? {}, 'node-table');
    const tree = dg.objects.get(field(site?.body ?? {}, 'tree')?.value);
    const visitTree = node => {
      for (const ch of field(node?.body ?? {}, 'children')?.items ?? []) {
        const child = dg.objects.get(ch.value);
        if (!child) continue;
        const entry = nodeTable?.entries?.find(([k]) => k.value === child.id)?.[1];
        const meta = entry?.values ? infos.get(entry.values[1]) : null;
        if (meta) { pageMetaByGuid.set(meta.pkgGuid, meta.name); pageOrder.push(meta.pkgGuid); }
        visitTree(child);
      }
    };
    if (tree) visitTree(tree);
    for (const meta of infos.values()) {
      if (!pageMetaByGuid.has(meta.pkgGuid)) { pageMetaByGuid.set(meta.pkgGuid, meta.name); pageOrder.push(meta.pkgGuid); }
    }
    const varSet = [...dg.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
    for (const item of field(varSet?.body ?? {}, 'global-variables')?.items ?? []) {
      const v = dg.objects.get(item.value);
      const name = strOf(field(v?.body ?? {}, 'name'));
      if (name) salvagedVars.push({ name, value: strOf(field(v.body, 'default-value')) ?? '' });
    }
  } else {
    discarded.push({ kind: 'missing-design-document', reason: 'Axure:DesignDocument 记录损坏或丢失，页面名称将按顺序回退为「恢复页面 N」' });
  }

  for (const mr of salvaged.filter(r => r.className === 'Axure:Master')) {
    discarded.push({ kind: 'dropped-master', record: mr.index, reason: '独立母版包不参与第一阶段重构，已记录于丢弃台账' });
  }

  const statesByGuid = new Map();
  for (const sr of salvaged.filter(r => r.className === 'Axure:PanelState' && r.graph)) {
    const g = packageGuidOf(sr.graph);
    if (g && g !== NULL_GUID) statesByGuid.set(g, sr);
  }
  const pagesByGuid = new Map();
  for (const pr of salvaged.filter(r => r.className === 'Axure:Page' && r.graph)) {
    const g = packageGuidOf(pr.graph);
    if (g && g !== NULL_GUID) pagesByGuid.set(g, pr);
  }
  for (const [pgGuid, pgName] of pageMetaByGuid) {
    if (!pagesByGuid.has(pgGuid)) discarded.push({ kind: 'lost-page', page: pgName, guid: pgGuid, reason: '页面记录本身已损坏或被截断' });
  }
  if (manifestOk && origManifest) {
    for (const [k] of Object.entries(origManifest.value.root.children ?? {})) {
      if (!salvaged.some(r => r.graph && guidKey(packageGuidOf(r.graph)) === k)) {
        discarded.push({ kind: 'lost-manifest-package', key: k, reason: 'manifest 中登记的包记录未能从损坏流中打捞' });
      }
    }
  }

  const orderedPages = [];
  const seenPageGuids = new Set();
  for (const g of pageOrder) {
    const pr = pagesByGuid.get(g);
    if (pr && !seenPageGuids.has(g)) { seenPageGuids.add(g); orderedPages.push({ guid: g, record: pr, preferredName: pageMetaByGuid.get(g) }); }
  }
  let fallbackIdx = 1;
  for (const [g, pr] of pagesByGuid) {
    if (seenPageGuids.has(g)) continue;
    seenPageGuids.add(g);
    orderedPages.push({ guid: g, record: pr, preferredName: pageMetaByGuid.get(g) || `恢复页面 ${fallbackIdx++}` });
  }

  if (orderedPages.length === 0 && !allowEmpty) {
    throw Object.assign(new Error('无法从损坏文件中抢救出任何完整页面记录（0 个可用 Axure:Page）'), { code: 'E_REPAIR_NO_PAGES_SALVAGED', discarded });
  }

  const ensureNullGuid = g => {
    const gs = guidsOf(g);
    let idx = gs.indexOf(NULL_GUID);
    if (idx < 0) { gs.push(NULL_GUID); idx = gs.length - 1; }
    return idx + 1;
  };
  const survivingStateGuids = new Set(statesByGuid.keys());
  const sanitizeGraph = (graph, strings, pageLabel) => {
    const gs = guidsOf(graph);
    const nullSlot = ensureNullGuid(graph);
    const rootObj = graph.objects.get(graph.roots.find(n => n.tag === 0xf)?.value);
    const diagram = graph.objects.get(field(rootObj?.body ?? {}, 'diagram')?.value);
    const diagItems = field(diagram?.body ?? {}, 'diagram-objects');
    const droppedIds = new Set();
    for (const obj of [...graph.objects.values()]) {
      if (obj.className === 'Axure:DiagramObject:ReferenceDiagramObject') {
        droppedIds.add(obj.id);
        discarded.push({ kind: 'dropped-master-instance', page: pageLabel, widget: widgetName(obj) || `#${obj.id}`, reason: '母版跨包闭包未整体验证，为防反序列化空引用已安全移除母版实例' });
      } else if (obj.className === 'Axure:DiagramObject:DynamicPanel') {
        const pd = field(obj.body, 'panel-diagrams');
        const kept = [];
        for (const item of pd?.items ?? []) {
          const gIdx = item.tag === 0x13 ? item.values[1] : item.value;
          const sg = gs[gIdx - 1];
          if (sg && survivingStateGuids.has(sg)) kept.push(item);
          else discarded.push({ kind: 'dropped-panel-state', page: pageLabel, panel: widgetName(obj) || `#${obj.id}`, stateGuid: sg ?? null, reason: '对应的 PanelState 记录已损坏或截断' });
        }
        if (pd) pd.items = kept;
        if (kept.length === 0) {
          droppedIds.add(obj.id);
          discarded.push({ kind: 'dropped-empty-panel', page: pageLabel, panel: widgetName(obj) || `#${obj.id}`, reason: '动态面板的所有状态记录均已损坏，已移除空面板' });
        }
      }
    }
    if (droppedIds.size && diagItems?.items) {
      diagItems.items = diagItems.items.filter(ref => !droppedIds.has(ref.value));
      graph.roots = graph.roots.filter(n => n.tag !== 9 || !droppedIds.has(n.id));
      for (const id of droppedIds) graph.objects.delete(id);
    }
    let repairedRefs = 0;
    walkNodes(graph.roots, node => {
      if (node.tag !== 3 || graph.objects.has(node.value) || (node.value >= 1 && node.value <= gs.length)) return;
      node.value = nullSlot;
      repairedRefs++;
    });
    if (repairedRefs) discarded.push({ kind: 'repaired-dangling-refs', page: pageLabel, count: repairedRefs, reason: '损坏记录裁剪留下的悬空对象引用已重定向到空哨兵' });
    adaptNodesForVersionBytes([...graph.objects.values()], { version, str: text => stringNode(strings, text) });
  };

  const attachStates = async (bufNow, ownerPkgGuid, ownerRecordMeta, pageLabel) => {
    const needed = [];
    const collect = g => {
      const gs = guidsOf(g);
      for (const obj of g.objects.values()) {
        if (obj.className !== 'Axure:DiagramObject:DynamicPanel') continue;
        for (const pair of field(obj.body, 'panel-diagrams')?.items ?? []) {
          const sg = gs[(pair.tag === 0x13 ? pair.values[1] : pair.value) - 1];
          const rec = sg && statesByGuid.get(sg);
          if (rec && !needed.some(x => x.guid === sg)) { needed.push({ guid: sg, record: rec }); collect(rec.graph); }
        }
      }
    };
    collect(ownerRecordMeta.graph);
    if (!needed.length) return bufNow;
    const ownerKey = guidKey(ownerPkgGuid);
    const findNode = (node, pred) => {
      for (const [k, child] of Object.entries(node.children ?? {})) {
        if (pred(k, child)) return child;
        const hit = findNode(child, pred);
        if (hit) return hit;
      }
      return null;
    };
    const insertedKeys = [];
    for (const { guid, record } of needed) {
      const stStrings = [...record.strings];
      sanitizeGraph(record.graph, stStrings, pageLabel);
      const key = guidKey(guid);
      const mfNow = readManifestBytes(bufNow);
      const ownerNode = findNode(mfNow.value.root, k => k === ownerKey);
      const ownerRec = (await readRecordsAsync(bufNow)).find(r => r.offset - 8 - mfNow.dataStart === ownerNode.parts.package);
      bufNow = await insertRecordAsync(bufNow, key, encodeRecordBytes(record, stStrings, encodePayloadBytes(record.graph.roots)), ownerRec);
      insertedKeys.push(key);
    }
    const mf = readManifestBytes(bufNow);
    const ownerNode = findNode(mf.value.root, k => k === ownerKey);
    ownerNode.children ??= {};
    for (const key of insertedKeys) { ownerNode.children[key] = mf.value.root.children[key]; delete mf.value.root.children[key]; }
    return concatU8([encodeManifestBytes(bufNow, mf.value), bufNow.subarray(mf.dataStart)]);
  };

  const usedNames = new Set();
  const uniqueName = raw => {
    const base = (raw && raw.trim()) || `恢复页面 ${usedNames.size + 1}`;
    if (!usedNames.has(base.toLowerCase())) { usedNames.add(base.toLowerCase()); return base; }
    let k = 2;
    while (usedNames.has(`${base} (${k})`.toLowerCase())) k++;
    const finalName = `${base} (${k})`;
    usedNames.add(finalName.toLowerCase());
    return finalName;
  };

  let outBuf = await synthesizeBlankProjectBytes({ version, pageName: orderedPages.length ? uniqueName(orderedPages[0].preferredName) : 'Page 1' });
  if (orderedPages.length > 0) {
    const first = orderedPages[0];
    const firstName = orderedPages[0].preferredName || 'Page 1';
    const firstStrings = [...first.record.strings];
    sanitizeGraph(first.record.graph, firstStrings, firstName);
    const seedRecs = await readRecordsAsync(outBuf);
    const seedPageRec = seedRecs.find(r => r.className === 'Axure:Page');
    const oldSeedGuid = packageGuidOf(parsePayloadBytes(seedPageRec));
    const oldSeedKey = guidKey(oldSeedGuid);
    const newFirstKey = guidKey(first.guid);
    const docRec = seedRecs.find(r => r.className === 'Axure:DesignDocument');
    const docGraph = parsePayloadBytes(docRec);
    const docGuids = guidsOf(docGraph);
    const seedIdx = docGuids.indexOf(oldSeedGuid);
    if (seedIdx >= 0) docGuids[seedIdx] = first.guid;
    outBuf = await replaceRecordAsync(outBuf, docRec, encodeRecordBytes(docRec, docRec.strings, encodePayloadBytes(docGraph.roots)));
    const curPageRec = (await readRecordsAsync(outBuf)).find(r => r.className === 'Axure:Page');
    outBuf = await replaceRecordAsync(outBuf, curPageRec, encodeRecordBytes(first.record, firstStrings, encodePayloadBytes(first.record.graph.roots)));
    const mf = readManifestBytes(outBuf);
    if (mf.value.root.children?.[oldSeedKey] && oldSeedKey !== newFirstKey) {
      mf.value.root.children[newFirstKey] = mf.value.root.children[oldSeedKey];
      delete mf.value.root.children[oldSeedKey];
      outBuf = concatU8([encodeManifestBytes(outBuf, mf.value), outBuf.subarray(mf.dataStart)]);
    }
    outBuf = await attachStates(outBuf, first.guid, first.record, firstName);

    for (let i = 1; i < orderedPages.length; i++) {
      const item = orderedPages[i];
      const pageName = uniqueName(item.preferredName);
      const pStrings = [...item.record.strings];
      sanitizeGraph(item.record.graph, pStrings, pageName);
      const curRecs = await readRecordsAsync(outBuf);
      const curDocRec = curRecs.find(r => r.className === 'Axure:DesignDocument');
      const curDoc = parsePayloadBytes(curDocRec);
      const curDocGuids = guidsOf(curDoc);
      const curStrings = [...curDocRec.strings];
      const infos = [...curDoc.objects.values()].filter(o => o.className === 'Axure:PackageInfo');
      const baseInfo = infos.find(inf => curStrings[field(inf.body, 'package-id')?.values?.[0] - 1] === 'Axure:Page');
      const alloc = hex => { curDocGuids.push(hex ?? randomGuidHex()); return curDocGuids.length; };
      const newNodeId = alloc();
      const newInfoId = alloc();
      const newPkgId = alloc(item.guid);
      const newInfo = structuredClone(baseInfo);
      newInfo.id = newInfoId;
      field(newInfo.body, 'package-id').values[1] = newPkgId;
      Object.assign(field(newInfo.body, 'package-name'), stringNode(curStrings, pageName));
      const dRoot = curDoc.objects.get(curDoc.roots.find(n => n.tag === 0xf)?.value);
      const site = curDoc.objects.get(field(dRoot.body, 'sitemap')?.value);
      const tree = curDoc.objects.get(field(site.body, 'tree')?.value);
      const ref = v => ({ tag: 3, value: v });
      field(dRoot.body, 'PackageInfos').items.push(ref(newInfoId));
      field(site.body, 'node-table').entries.push([ref(newNodeId), { tag: 0x13, values: [stringNode(curStrings, 'Axure:PackageInfo').value, newPkgId] }]);
      field(tree.body, 'children').items.push(ref(newNodeId));
      const node = { tag: 9, id: newNodeId, classIndex: stringNode(curStrings, 'Axure:Node').value, className: 'Axure:Node', body: { tag: 1, entries: [[stringNode(curStrings, 'children'), { tag: 2, items: [] }], [stringNode(curStrings, 'parent-node'), ref(tree.id)], [stringNode(curStrings, 'tree'), ref(tree.id)]] } };
      curDoc.roots.splice(curDoc.roots.length - 1, 0, newInfo, node);
      outBuf = await replaceRecordAsync(outBuf, curDocRec, encodeRecordBytes(curDocRec, curStrings, encodePayloadBytes(curDoc.roots)));
      outBuf = await appendPackageAsync(outBuf, guidKey(item.guid), encodeRecordBytes(item.record, pStrings, encodePayloadBytes(item.record.graph.roots)));
      outBuf = await attachStates(outBuf, item.guid, item.record, pageName);
    }
  }

  for (const v of salvagedVars) outBuf = await createGlobalVariableBytes(outBuf, v.name, { defaultValue: v.value, updateDefault: true });
  if (version === 9) outBuf = (await fixPanelRegistryBytes(outBuf, { version: 9 })).file;

  const verification = await inspectRpBytes(outBuf, { path: '(repaired.rp)' });
  return {
    bytes: outBuf,
    report: {
      ok: verification.records.unparseable === 0 && verification.counts.danglingRefs === 0 && verification.counts.problems === 0,
      evidence: 'structure',
      sourceBytes: file.length,
      outputBytes: outBuf.length,
      version,
      salvaged: {
        records: salvaged.length,
        pages: verification.counts.pages,
        widgets: verification.counts.widgets,
        panelStates: verification.counts.panelStates,
        interactions: verification.counts.interactions,
        globalVariables: verification.counts.globalVariables,
      },
      structure: {
        unparseable: verification.records.unparseable,
        danglingRefs: verification.counts.danglingRefs,
        problems: verification.counts.problems,
      },
      discardedCount: discarded.length,
      discarded,
    },
  };
}

// ---- High-level Browser Downgrade RP11 -> RP9 (D4) ----
export async function downgradeRpBytes(input, { stripUnsupported = false } = {}) {
  const buf = toUint8Array(input);
  const ver = detectFileVersionBytes(buf);
  if (ver !== 11) {
    throw Object.assign(new Error(`仅支持将 RP11 原型降级为 RP9；当前文件版本为 RP${ver}`), { code: 'E_DOWNGRADE_NOT_RP11', version: ver });
  }

  const recs = await readRecordsAsync(buf);
  const blank9 = await synthesizeBlankProjectBytes({ version: 9, pageName: 'Page 1' });
  const blank9Recs = await readRecordsAsync(blank9);
  const blank9Breaking = blank9Recs.find(r => r.className === 'xml:BreakingChanges');
  const blank9Settings = blank9Recs.find(r => r.className === 'Axure:DocumentSettings');

  const unsupported = [];
  const dropped = [];
  const collectReachable = (graph, rootId, out = new Set()) => {
    if (!rootId || out.has(rootId)) return out;
    const obj = graph.objects.get(rootId);
    if (!obj) return out;
    out.add(rootId);
    walkNodes([obj], node => {
      if (node.tag === 3 && node.value !== rootId && graph.objects.has(node.value) && !out.has(node.value)) collectReachable(graph, node.value, out);
    });
    return out;
  };
  const pruneSubtree = (graph, tm, targetNodeId, removed = new Set()) => {
    if (removed.has(targetNodeId)) return;
    removed.add(targetNodeId);
    const nodeObj = graph.objects.get(targetNodeId);
    for (const ch of field(nodeObj?.body ?? {}, 'children')?.items ?? []) pruneSubtree(graph, tm, ch.value, removed);
    const parentId = field(nodeObj?.body ?? {}, 'parent-node')?.value;
    const parentChildren = field(graph.objects.get(parentId)?.body ?? {}, 'children');
    if (parentChildren?.items) parentChildren.items = parentChildren.items.filter(ref => ref.value !== targetNodeId);
    for (const o of graph.objects.values()) {
      const ch = field(o.body, 'children');
      if (ch?.items) ch.items = ch.items.filter(ref => ref.value !== targetNodeId);
    }
    const nodeTable = field(tm.body, 'node-table');
    const payloadIds = new Set();
    if (nodeTable?.entries) {
      nodeTable.entries = nodeTable.entries.filter(([kRef, vRef]) => {
        if (kRef?.value === targetNodeId) { if (vRef?.tag === 3) payloadIds.add(vRef.value); return false; }
        return true;
      });
    }
    graph.objects.delete(targetNodeId);
    for (const pid of payloadIds) graph.objects.delete(pid);
    graph.roots = graph.roots.filter(n => n.tag !== 9 || (!removed.has(n.id) && !payloadIds.has(n.id)));
  };

  const parsed = recs.map(rec => {
    if (!rec.strings) return { rec, graph: null, strings: null };
    const graph = parsePayloadBytes(rec);
    const strings = [...rec.strings];
    const gs = guidsOf(graph);
    const pkgIdx = graph.roots.find(n => n.tag === 0x12)?.value;
    const pkgGuid = pkgIdx ? gs[pkgIdx - 1] : null;
    const locBase = pkgGuid ? `${rec.className}:${pkgGuid.slice(0, 8)}` : rec.className;

    const detectFcall = rootId => {
      for (const id of collectReachable(graph, rootId)) {
        const o = graph.objects.get(id);
        if (!o || typeof o.className !== 'string' || !o.className.startsWith('Axure:STO:')) continue;
        let hit = null;
        walkNodes([o], node => {
          if (hit || node.tag !== 8) return;
          const t = node.text ?? strings[node.value - 1];
          if (RP11_ONLY_FCALLS.has(t)) hit = t;
        });
        if (hit) return hit;
      }
      return null;
    };

    for (const tm of [...graph.objects.values()]) {
      if (tm.className !== 'Axure:InteractionTreeMap') continue;
      const nodeTable = field(tm.body, 'node-table');
      if (!nodeTable?.entries) continue;
      for (const [nRef, pRef] of [...nodeTable.entries]) {
        if (!graph.objects.has(nRef?.value) || pRef?.tag !== 3) continue;
        const payload = graph.objects.get(pRef.value);
        if (!payload) continue;
        let issue = null;
        if (payload.className === 'Axure:InteractionEvent') {
          const evName = RP11_EVENT_CODE_NAME.get(field(payload.body, 'event-type')?.value);
          if (evName) issue = { kind: 'rp11-event', name: evName };
        } else if (RP11_ONLY_CLASSES.includes(payload.className)) {
          issue = { kind: 'rp11-class', name: payload.className };
        } else {
          for (const id of collectReachable(graph, payload.id)) {
            const subObj = graph.objects.get(id);
            if (subObj && RP11_ONLY_CLASSES.includes(subObj.className)) { issue = { kind: 'rp11-class', name: subObj.className }; break; }
          }
          if (!issue) { const hit = detectFcall(payload.id); if (hit) issue = { kind: 'rp11-fcall', name: hit }; }
        }
        if (issue) {
          if (stripUnsupported) { pruneSubtree(graph, tm, nRef.value); dropped.push({ ...issue, location: locBase, action: 'pruned-interaction-node' }); }
          else unsupported.push({ ...issue, location: locBase });
        }
      }
    }

    for (const obj of [...graph.objects.values()]) {
      if (obj.className === 'Axure:InteractionEvent') {
        const evName = RP11_EVENT_CODE_NAME.get(field(obj.body, 'event-type')?.value);
        if (evName) {
          if (stripUnsupported) { dropped.push({ kind: 'rp11-event', name: evName, location: locBase, action: 'neutralized-standalone-event' }); field(obj.body, 'event-type').value = 0; }
          else if (!unsupported.some(u => u.kind === 'rp11-event' && u.name === evName && u.location === locBase)) unsupported.push({ kind: 'rp11-event', name: evName, location: locBase });
        }
      } else if (!stripUnsupported && RP11_ONLY_CLASSES.includes(obj.className)) {
        if (!unsupported.some(u => u.kind === 'rp11-class' && u.name === obj.className && u.location === locBase)) unsupported.push({ kind: 'rp11-class', name: obj.className, location: locBase });
      }
    }

    for (const obj of graph.objects.values()) {
      const propList = field(obj.body, 'PropList');
      if (!propList?.items) continue;
      const kept = [];
      for (const item of propList.items) {
        const doa = field(item, 'DOAName')?.value;
        const code = typeof doa === 'number' ? (doa & DOA_BASE_MASK) : null;
        if (code !== null && RP11_ONLY_DOA_CODES[code]) {
          const itemMeta = { kind: 'rp11-doa-style', code, name: RP11_ONLY_DOA_CODES[code], location: locBase };
          if (stripUnsupported) dropped.push({ ...itemMeta, action: 'stripped-style-prop' });
          else unsupported.push(itemMeta);
        } else kept.push(item);
      }
      if (stripUnsupported) propList.items = kept;
    }

    for (const obj of graph.objects.values()) {
      const shortClass = typeof obj.className === 'string' ? obj.className.replace(/^Axure:/, '') : '';
      const rawKeys = RP11_ONLY_KEYS[obj.className] ?? RP11_ONLY_KEYS[shortClass];
      if (!rawKeys || !obj.body?.entries) continue;
      const dropKeys = new Set(rawKeys);
      const next = [];
      for (const entry of obj.body.entries) {
        const k = entry[0]?.text;
        if (dropKeys.has(k)) dropped.push({ kind: 'rp11-key', className: obj.className, key: k, location: locBase, action: 'stripped-rp11-key' });
        else next.push(entry);
      }
      obj.body.entries = next;
    }

    adaptNodesForVersionBytes([...graph.objects.values()], { version: 9, str: text => stringNode(strings, text) });
    for (const obj of graph.objects.values()) {
      const shortClass = typeof obj.className === 'string' ? obj.className.replace(/^Axure:/, '') : '';
      const reqKeys = RP9_REQUIRED_KEYS[shortClass];
      if (reqKeys && obj.body?.entries) {
        for (const key of reqKeys) if (!obj.body.entries.some(([k]) => k?.text === key)) obj.body.entries.push([stringNode(strings, key), { tag: 0x19, value: false }]);
      }
      if (obj.className === 'Axure:PackageInfo' && obj.body?.entries && !field(obj.body, 'root-panel-infos')) {
        obj.body.entries.push([stringNode(strings, 'root-panel-infos'), { tag: 2, items: [] }]);
      }
    }
    return { rec, graph, strings };
  });

  if (unsupported.length > 0) {
    throw Object.assign(new Error(`发现 ${unsupported.length} 项 RP11 独占特性无法无损降级到 RP9；可勾选裁剪选项显式裁剪并记录台账。`), { code: 'E_DOWNGRADE_UNSUPPORTED_RP11', unsupported });
  }

  const replacements = parsed.map(({ rec, graph, strings }) => {
    if (rec.className === 'xml:BreakingChanges' && blank9Breaking) return { record: rec, raw: blank9Breaking.raw };
    if (rec.className === 'Axure:DocumentSettings' && blank9Settings) return { record: rec, raw: blank9Settings.raw };
    const rawCopy = new Uint8Array(rec.raw);
    if (rawCopy.length >= 8) writeU32LE(rawCopy, 4, 9);
    if (!graph) return { record: rec, raw: rawCopy };
    const encoded = encodeRecordBytes({ ...rec, raw: rawCopy }, strings, encodePayloadBytes(graph.roots));
    if (encoded.length >= 8) writeU32LE(encoded, 4, 9);
    return { record: rec, raw: encoded };
  });

  let outBuf = await replaceRecordsAsync(buf, replacements);
  const mfOut = readManifestBytes(outBuf);
  for (const k of Object.keys(mfOut.value.root.parts ?? {})) {
    if (k.endsWith('.version') && !k.startsWith('9.')) {
      mfOut.value.root.parts['9.0.0.3754.version'] = mfOut.value.root.parts[k];
      delete mfOut.value.root.parts[k];
    }
  }
  const headerCopy = new Uint8Array(outBuf);
  writeU16LE(headerCopy, 2, 9);
  outBuf = concatU8([encodeManifestBytes(headerCopy, mfOut.value), headerCopy.subarray(mfOut.dataStart)]);
  outBuf = (await fixPanelRegistryBytes(outBuf, { version: 9 })).file;

  const [lint, check, editorReadiness] = await Promise.all([
    lintVersionKeysBytes(outBuf, 9),
    inspectRpBytes(outBuf, { path: '(downgraded-rp9.rp)' }),
    inspectEditorReadinessBytes(outBuf, 9),
  ]);
  return {
    bytes: outBuf,
    report: {
      ok: lint.errors.length === 0 && check.version === 9 && check.records.unparseable === 0 && check.counts.danglingRefs === 0 && check.counts.problems === 0 && !editorReadiness.upgradeModalRisk,
      evidence: 'structure',
      sourceVersion: 11,
      targetVersion: check.version,
      stripUnsupported,
      editorReadiness,
      droppedCount: dropped.length,
      dropped,
      lintErrors: lint.errors,
      counts: {
        pages: check.counts.pages,
        widgets: check.counts.widgets,
        panelStates: check.counts.panelStates,
        interactions: check.counts.interactions,
        globalVariables: check.counts.globalVariables,
        records: recs.length,
      },
      structure: {
        unparseable: check.records.unparseable,
        danglingRefs: check.counts.danglingRefs,
        problems: check.counts.problems,
      },
    },
  };
}

// ---- High-level Browser Native .rplib Compiler ----
async function convertRp9ToRp11Bytes(buf) {
  const blank11 = await synthesizeBlankProjectBytes({ version: 11, pageName: 'Page 1' });
  const blank11Recs = await readRecordsAsync(blank11);
  const blank11Breaking = blank11Recs.find(r => r.className === 'xml:BreakingChanges');
  const blank11Settings = blank11Recs.find(r => r.className === 'Axure:DocumentSettings');
  const recs = await readRecordsAsync(buf);
  const replacements = recs.map(rec => {
    if (rec.className === 'xml:BreakingChanges' && blank11Breaking) return { record: rec, raw: blank11Breaking.raw };
    if (rec.className === 'Axure:DocumentSettings' && blank11Settings) return { record: rec, raw: blank11Settings.raw };
    const rawCopy = new Uint8Array(rec.raw);
    if (rawCopy.length >= 8) writeU32LE(rawCopy, 4, 11);
    if (!rec.strings) return { record: rec, raw: rawCopy };
    const graph = parsePayloadBytes(rec);
    const strings = [...rec.strings];
    adaptNodesForVersionBytes([...graph.objects.values()], { version: 11, str: text => stringNode(strings, text) });
    const encoded = encodeRecordBytes({ ...rec, raw: rawCopy }, strings, encodePayloadBytes(graph.roots));
    if (encoded.length >= 8) writeU32LE(encoded, 4, 11);
    return { record: rec, raw: encoded };
  });
  let outBuf = await replaceRecordsAsync(buf, replacements);
  const mf = readManifestBytes(outBuf);
  for (const k of Object.keys(mf.value.root.parts ?? {})) {
    if (k.endsWith('.version') && !k.startsWith('11.')) {
      mf.value.root.parts['11.0.0.4137.version'] = mf.value.root.parts[k];
      delete mf.value.root.parts[k];
    }
  }
  const headerCopy = new Uint8Array(outBuf);
  writeU16LE(headerCopy, 2, 11);
  return concatU8([encodeManifestBytes(headerCopy, mf.value), headerCopy.subarray(mf.dataStart)]);
}

export async function buildLibraryBytes(input, { version = 9, stripUnsupported = true } = {}) {
  const targetVersion = Number(version);
  if (targetVersion !== 9 && targetVersion !== 11) {
    throw Object.assign(new Error(`仅支持导出 RP9 或 RP11 组件库，收到 version=${version}`), { code: 'E_BUILD_LIB_VERSION' });
  }
  let buf = toUint8Array(input);
  const srcVer = detectFileVersionBytes(buf);
  let downgradeReport = null;
  if (srcVer === 11 && targetVersion === 9) {
    const dg = await downgradeRpBytes(buf, { stripUnsupported });
    buf = dg.bytes;
    downgradeReport = dg.report;
  } else if (srcVer === 9 && targetVersion === 11) {
    buf = await convertRp9ToRp11Bytes(buf);
  }

  const recs = await readRecordsAsync(buf);
  const docRec = recs.find(r => r.className === 'Axure:DesignDocument');
  if (!docRec) throw new Error('Axure:DesignDocument record missing');
  const docGraph = parsePayloadBytes(docRec);
  const docStrings = [...docRec.strings];
  const docRoot = docGraph.objects.get(docGraph.roots.find(n => n.tag === 0xf)?.value);
  if (docRoot?.body?.entries) {
    const setInt = (key, value) => {
      const existing = docRoot.body.entries.find(([k]) => k?.text === key);
      if (existing) existing[1] = { tag: 5, value };
      else docRoot.body.entries.unshift([stringNode(docStrings, key), { tag: 5, value }]);
    };
    setInt('document-type', 2);
    setInt('SavedEdition', 2);
  }
  const rplibBytes = await replaceRecordAsync(buf, docRec, encodeRecordBytes(docRec, docStrings, encodePayloadBytes(docGraph.roots)));
  const info = await inspectRpBytes(rplibBytes, { path: '(library.rplib)' });
  const editorReadiness = await inspectEditorReadinessBytes(rplibBytes, targetVersion);
  return {
    bytes: rplibBytes,
    report: {
      ok: info.records.unparseable === 0 && info.counts.danglingRefs === 0 && info.counts.problems === 0 && !editorReadiness.upgradeModalRisk,
      evidence: 'structure',
      format: `RP${targetVersion} .rplib`,
      targetVersion,
      bytes: rplibBytes.length,
      editorReadiness,
      downgradeDroppedCount: downgradeReport?.droppedCount ?? 0,
      items: info.pages.map(p => ({ name: p.name, widgets: p.widgets.length })),
      structure: {
        unparseable: info.records.unparseable,
        danglingRefs: info.counts.danglingRefs,
        problems: info.counts.problems,
      },
    },
  };
}

// ---- Read-only Inspection & Semantic Diff (D1/D2) ----
const DOA = { POSITION: 3221225573, SIZE: 3221225577 };
const EVENT_NAMES = new Map([
  [16, 'OnClick'], [17, 'OnMouseEnter'], [18, 'OnMouseOut'], [19, 'OnMouseDown'], [20, 'OnMouseUp'],
  [21, 'OnMouseMove'], [22, 'OnMouseHover'], [23, 'OnKeyDown'], [24, 'OnKeyUp'], [25, 'OnFocus'],
  [26, 'OnLostFocus'], [27, 'OnPageLoad'], [28, 'OnLoad'], [29, 'OnTextChange'], [30, 'OnSelectionChange'],
  [31, 'OnSelectedChange'], [33, 'OnShow'], [34, 'OnHide'], [35, 'OnPanelStateChange'], [36, 'OnDrag'],
  [37, 'OnDragStart'], [38, 'OnDragDrop'], [39, 'OnMove'], [40, 'OnResize'], [41, 'OnSwipeLeft'],
  [42, 'OnSwipeRight'], [43, 'OnSwipeUp'], [44, 'OnSwipeDown'], [45, 'OnLongClick'], [48, 'OnContextMenu'],
  [55, 'OnErrorSet'], [56, 'OnErrorRemoved'], [288, 'OnDoubleClick'], [291, 'OnBeforeItemLoad'],
]);
const eventName = type => EVENT_NAMES.get(type) ?? `Event(${type})`;
const guidsOf = graph => graph?.roots?.find(n => n.tag === 0x1e)?.values ?? [];
const strOf = node => (node && node.tag === 8 ? node.text : undefined);
const intOf = node => (node === undefined || node === null ? undefined : node.value);
const pairValues = node => (node && Array.isArray(node.values) ? node.values : null);
const isWidget = o => o.className.startsWith('Axure:DiagramObject:') || o.className === 'Axure:Repeater';
const shortType = className => className.replace(/^Axure:(DiagramObject:)?/, '') || className;
const widgetName = widget => strOf(field(field(widget.body, 'name-block') ?? {}, 'text')) ?? '';

function textOf(node) {
  if (!node) return undefined;
  const direct = node.entries?.find(([k, v]) => k.text === 'text' && v.tag === 8)?.[1];
  if (direct) return direct.text;
  const parts = [];
  walkNodes([node], n => {
    if (n.tag !== 1 || !n.entries) return;
    for (const [k, v] of n.entries) if (k.text === 'Text' && v.tag === 8 && v.text) parts.push(v.text);
  });
  return parts.join('') || undefined;
}

function geometryOf(graph, widget) {
  const style = graph.objects.get(field(widget.body, 'MyStyle')?.value);
  const out = { x: null, y: null, w: null, h: null };
  for (const item of field(style?.body ?? {}, 'PropList')?.items ?? []) {
    const name = intOf(field(item, 'DOAName'));
    const value = field(item, 'Value');
    if (!value || value.tag !== 1) continue;
    if (name === DOA.POSITION) { out.x = intOf(field(value, 'X')); out.y = intOf(field(value, 'Y')); }
    if (name === DOA.SIZE) { out.w = intOf(field(value, 'Width')); out.h = intOf(field(value, 'Height')); }
  }
  return out;
}

function describeAction(graph, action, widgetsByGuid, panelStates) {
  const disabled = field(action.body, 'Disabled')?.value === true;
  const resolveWidget = id => {
    if (id === undefined || id === null) return undefined;
    const local = graph.objects.get(id);
    if (local) return local;
    const g = guidsOf(graph)[id - 1];
    return g ? widgetsByGuid.get(g) : undefined;
  };
  const targets = keys => {
    const names = [], seen = new Set();
    for (const key of keys) {
      for (const item of field(action.body, key)?.items ?? []) {
        const path = graph.objects.get(item.value);
        if (!path) continue;
        const id = field(path.body, 'object-id')?.value;
        if (seen.has(id)) continue;
        seen.add(id);
        const w = resolveWidget(id);
        names.push(w ? (widgetName(w) || `${shortType(w.className)}#${w.id}`) : `#${id}`);
      }
    }
    return names;
  };
  const cls = action.className.replace(/^Axure:/, '');
  const names = targets(['WidgetPaths', 'panelobjectpaths', 'PanelPaths', 'Paths']);
  let type = cls, human = names.length ? `${cls} -> ${names.join('、')}` : cls;
  if (cls === 'InteractionLinkWindowAction') {
    const target = graph.objects.get(field(action.body, 'target')?.value);
    const valNode = field(target?.body ?? {}, 'target-literal');
    const valObj = valNode?.tag === 8 ? valNode.text : strOf(field(graph.objects.get(valNode?.value)?.body ?? {}, 'value'));
    type = 'link';
    human = `打开 ${valObj ?? '(未指定)'}`;
  } else if (cls === 'InteractionFadeWidgetAction') {
    const fade = graph.objects.get(field(action.body, 'FadeInfos')?.items?.[0]?.value)?.body ?? {};
    const kind = intOf(field(fade, 'fade-action-type'));
    type = kind === 1 ? 'show' : kind === 0 ? 'hide' : 'toggle';
    human = `${kind === 1 ? '显示' : kind === 0 ? '隐藏' : '切换'} ${names.join('、') || '(未指定)'}`;
  } else if (cls === 'InteractionSetPanelStateAction') {
    const st = graph.objects.get(field(action.body, 'SetStateInfos')?.items?.[0]?.value)?.body ?? {};
    const g = guidsOf(graph)[intOf(field(st, 'diagram-id')) - 1];
    const sn = panelStates.get(g)?.name;
    type = 'set-panel-state';
    human = `设置面板 ${names.join('、')}${sn ? ` -> ${sn}` : ''}`;
  } else if (cls === 'InteractionWaitAction') {
    type = 'wait';
    human = `等待 ${intOf(field(action.body, 'wait_time'))}ms`;
  }
  return { type, className: cls, disabled, human };
}

function readInteractions(graph, mapNode, widgetsByGuid, panelStates) {
  const results = [];
  if (!mapNode) return results;
  const nodeTable = field(mapNode.body, 'node-table');
  const target = id => {
    const entry = nodeTable?.entries?.find(([k]) => k.value === id);
    return entry ? graph.objects.get(entry[1].value) : undefined;
  };
  const tree = graph.objects.get(field(mapNode.body, 'tree')?.value);
  const childrenOf = obj => (field(obj?.body ?? {}, 'children')?.items ?? []).map(item => graph.objects.get(item.value)).filter(Boolean);
  for (const eventNode of childrenOf(tree)) {
    const event = target(eventNode.id);
    if (!event || event.className !== 'Axure:InteractionEvent') continue;
    const cases = [];
    for (const caseNode of childrenOf(eventNode)) {
      const kase = target(caseNode.id);
      if (!kase) continue;
      const actions = childrenOf(caseNode).map(an => target(an.id)).filter(Boolean).map(a => describeAction(graph, a, widgetsByGuid, panelStates));
      cases.push({
        description: strOf(field(kase.body, 'Description')) ?? '',
        disabled: field(kase.body, 'Disabled')?.value === true,
        isNewIfGroup: field(kase.body, 'IsNewIfGroup')?.value === true,
        actions,
      });
    }
    results.push({ event: eventName(intOf(field(event.body, 'event-type'))), eventType: intOf(field(event.body, 'event-type')), disabled: field(event.body, 'Disabled')?.value === true, cases });
  }
  return results;
}

export async function inspectRpBytes(inputBytes, { path = '(browser)' } = {}) {
  const file = toUint8Array(inputBytes);
  const version = detectFileVersionBytes(file);
  const records = await readRecordsAsync(file);
  const manifest = readManifestBytes(file);
  const problems = [];
  const problem = (kind, message, extra = {}) => problems.push({ kind, message, ...extra });

  const graphs = new Map();
  let parseFailures = 0;
  for (const record of records) {
    if (!record.strings) continue;
    try { graphs.set(record.index, parsePayloadBytes(record)); }
    catch (e) { parseFailures++; problem('unparseable-record', `${record.className} #${record.index} 解析失败：${e.message}`, { record: record.index }); }
  }
  const recordByPackageGuid = new Map();
  for (const record of records) {
    const g = guidsOf(graphs.get(record.index))[1];
    if (g) recordByPackageGuid.set(g, record);
  }
  const recordByRel = new Map(records.map(r => [r.offset - 8 - manifest.dataStart, r]));
  const packages = [];
  const walkManifest = (node, p) => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      const rel = child.parts?.package;
      const record = rel === undefined ? undefined : recordByRel.get(rel);
      const entry = {
        key, guid: unguidKey(key), path: p ? `${p}/${key}` : key,
        parts: child.parts ?? {}, record: record?.index ?? null, className: record?.className ?? null,
        container: Object.keys(child.children ?? {}).length > 0,
      };
      packages.push(entry);
      if (rel !== undefined && !record) problem('unreadable-record', `manifest 登记了包 ${key} 但读不出记录`, { key, offset: rel });
      walkManifest(child, entry.path);
    }
  };
  walkManifest(manifest.value.root, '');

  const docRecord = records.find(r => r.className === 'Axure:DesignDocument');
  if (!docRecord) throw new Error('No Axure:DesignDocument record');
  const docGraph = graphs.get(docRecord.index);
  const docRoot = docGraph.objects.get(docGraph.roots.find(n => n.tag === 0xf)?.value);
  const docType = intOf(field(docRoot?.body ?? {}, 'document-type')) ?? 1;
  const packageInfos = new Map();
  for (const item of field(docRoot.body, 'PackageInfos')?.items ?? []) {
    const info = docGraph.objects.get(item.value);
    const values = pairValues(field(info?.body ?? {}, 'package-id'));
    if (!values) continue;
    packageInfos.set(values[1], { name: strOf(field(info.body, 'package-name')) ?? '(未命名)', kind: docRecord.strings[values[0] - 1], guidIndex: values[1] });
  }

  const readTreeMap = (mapField, kind) => {
    const folders = [], items = [];
    const mapNode = docGraph.objects.get(field(docRoot.body, mapField)?.value);
    const nodeTable = field(mapNode?.body ?? {}, 'node-table');
    const tree = docGraph.objects.get(field(mapNode?.body ?? {}, 'tree')?.value);
    const metaOf = nodeId => {
      const value = nodeTable?.entries?.find(([k]) => k.value === nodeId)?.[1];
      const pair = pairValues(value);
      if (pair) { const info = packageInfos.get(pair[1]); return { label: info?.name ?? `(节点#${nodeId})`, kind: info?.kind, guidIndex: info?.guidIndex, folder: false }; }
      if (value?.tag === 3) { const folder = docGraph.objects.get(value.value); return { label: strOf(field(folder?.body ?? {}, 'name')) ?? `(节点#${nodeId})`, folder: true }; }
      return { label: `(节点#${nodeId})`, folder: false };
    };
    const visit = (node, trail) => {
      for (const item of field(node?.body ?? {}, 'children')?.items ?? []) {
        const child = docGraph.objects.get(item.value);
        if (!child) continue;
        const meta = metaOf(child.id);
        if (meta.folder || (field(child.body, 'children')?.items ?? []).length) { folders.push({ name: meta.label, folder: [...trail] }); visit(child, [...trail, meta.label]); continue; }
        items.push({ name: meta.label, kind: meta.kind ?? kind, folder: [...trail], guidIndex: meta.guidIndex });
      }
    };
    if (tree) visit(tree, []);
    if (!items.length && !folders.length) for (const info of packageInfos.values()) if (info.kind === kind) items.push({ name: info.name, kind, folder: [], guidIndex: info.guidIndex });
    return { items, folders };
  };
  const site = readTreeMap('sitemap', 'Axure:Page');
  const masterMap = readTreeMap('mastermap', 'Axure:Master');
  const globalVariables = [];
  const variableSet = [...docGraph.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
  for (const item of field(variableSet?.body ?? {}, 'global-variables')?.items ?? []) {
    const v = docGraph.objects.get(item.value);
    if (v) globalVariables.push({ name: strOf(field(v.body, 'name')) ?? '', value: strOf(field(v.body, 'default-value')) ?? '', variableId: intOf(field(v.body, 'variable-id')) });
  }

  const panelStates = new Map();
  let panelStateRecords = 0;
  for (const record of records) {
    if (record.className !== 'Axure:PanelState') continue;
    panelStateRecords++;
    const graph = graphs.get(record.index);
    if (!graph) continue;
    const gs = guidsOf(graph);
    const diagram = [...graph.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
    const state = { name: strOf(field(diagram?.body ?? {}, 'Name')) ?? '(未命名状态)', record: record.index };
    for (const g of [gs[1], gs[0]]) if (g && !panelStates.has(g)) panelStates.set(g, state);
  }
  const widgetsByGuid = new Map();
  for (const g of graphs.values()) {
    const gs = guidsOf(g);
    for (const o of g.objects.values()) if (isWidget(o) && gs[o.id - 1]) widgetsByGuid.set(gs[o.id - 1], o);
  }
  const describePanel = (graph, object) => {
    const panel = field(object.body, 'panel-diagrams');
    if (!panel) return null;
    return (panel.items ?? []).map(item => {
      const guidIndex = pairValues(item)?.[1] ?? item.value;
      const state = panelStates.get(guidsOf(graph)[guidIndex - 1]);
      return { name: state?.name ?? `(状态 ${guidIndex})`, guidIndex, record: state?.record ?? null };
    });
  };
  let danglingRefs = 0;
  for (const record of records) {
    const graph = graphs.get(record.index);
    if (!graph) continue;
    const guidCount = guidsOf(graph).length;
    walkNodes(graph.roots, node => { if (node.tag === 3 && !graph.objects.has(node.value) && !(node.value >= 1 && node.value <= guidCount)) danglingRefs++; });
  }
  if (danglingRefs) problem('dangling-ref', `发现 ${danglingRefs} 个悬空引用`);

  const pageSummaries = [];
  let widgetCount = 0, panelCount = 0, interactionCount = 0, actionCount = 0;
  for (const page of site.items) {
    const pkgGuid = page.guidIndex !== undefined ? guidsOf(docGraph)[page.guidIndex - 1] : null;
    const record = pkgGuid ? recordByPackageGuid.get(pkgGuid) : undefined;
    const graph = record ? graphs.get(record.index) : undefined;
    if (!record || !graph) continue;
    const gs = guidsOf(graph);
    const pageObj = [...graph.objects.values()].find(o => o.className === 'Axure:Page');
    const widgets = [];
    for (const object of graph.objects.values()) {
      if (!isWidget(object)) continue;
      widgetCount++;
      const geo = geometryOf(graph, object);
      const panel = describePanel(graph, object);
      if (panel) panelCount++;
      const interactions = readInteractions(graph, graph.objects.get(field(object.body, 'InteractionMap')?.value), widgetsByGuid, panelStates);
      interactionCount += interactions.length;
      for (const ix of interactions) actionCount += ix.cases.reduce((n, c) => n + c.actions.length, 0);
      widgets.push({
        id: object.id, guid: gs[object.id - 1] || null, name: widgetName(object),
        type: shortType(object.className), className: object.className,
        x: geo.x, y: geo.y, w: geo.w, h: geo.h,
        text: textOf(field(object.body, 'RichTextBlock') ?? field(object.body, 'TextBlock')),
        ...(panel ? { panel } : {}), ...(interactions.length ? { interactions } : {}),
      });
    }
    const pageInteractions = readInteractions(graph, graph.objects.get(field(pageObj?.body ?? {}, 'interactionmap')?.value), widgetsByGuid, panelStates);
    interactionCount += pageInteractions.length;
    for (const ix of pageInteractions) actionCount += ix.cases.reduce((n, c) => n + c.actions.length, 0);
    pageSummaries.push({
      name: page.name, folder: page.folder, packageGuid: pkgGuid, record: record.index,
      interactions: pageInteractions, widgets,
      counts: { widgets: widgets.length, dynamicPanels: widgets.filter(w => w.panel).length, interactions: widgets.reduce((n, w) => n + (w.interactions?.length ?? 0), 0) + pageInteractions.length },
    });
  }

  return {
    path,
    sha256: sha256Hex(file),
    version,
    documentType: docType,
    format: docType === 2 ? `RP${version} .rplib` : `RP${version} .rp`,
    bytes: file.length,
    dataStart: manifest.dataStart,
    records: { total: records.length, parsed: graphs.size, unparseable: parseFailures },
    packages,
    sitemap: { pages: site.items, masters: masterMap.items, folders: site.folders },
    globalVariables,
    pages: pageSummaries,
    counts: {
      packages: packages.length, pages: site.items.length, masters: masterMap.items.length,
      widgets: widgetCount, dynamicPanels: panelCount, panelStates: panelStateRecords,
      interactions: interactionCount, actions: actionCount, globalVariables: globalVariables.length,
      danglingRefs, problems: problems.length,
    },
    problems,
  };
}

export async function diffRpBytes(beforeBytes, afterBytes) {
  const [before, after] = await Promise.all([inspectRpBytes(beforeBytes, { path: 'before.rp' }), inspectRpBytes(afterBytes, { path: 'after.rp' })]);
  const changes = { pages: [], variables: [], widgets: [], interactions: [] };
  const pageMapA = new Map(before.pages.map(p => [p.packageGuid || p.name, p]));
  const pageMapB = new Map(after.pages.map(p => [p.packageGuid || p.name, p]));
  for (const [k, pA] of pageMapA) {
    const pB = pageMapB.get(k);
    if (!pB) { changes.pages.push({ kind: 'removed', page: pA.name }); continue; }
    if (pA.name !== pB.name) changes.pages.push({ kind: 'modified', page: pB.name, before: pA.name, after: pB.name });
    const wA = new Map(pA.widgets.map(w => [w.guid || w.name || `${w.type}:${w.x},${w.y}`, w]));
    const wB = new Map(pB.widgets.map(w => [w.guid || w.name || `${w.type}:${w.x},${w.y}`, w]));
    for (const [wk, a] of wA) {
      const b = wB.get(wk);
      if (!b) { changes.widgets.push({ kind: 'removed', page: pB.name, widget: a.name || `#${a.id}`, type: a.type }); continue; }
      const diff = {};
      if (a.name !== b.name) diff.name = { before: a.name, after: b.name };
      if ((a.text ?? '') !== (b.text ?? '')) diff.text = { before: a.text ?? '', after: b.text ?? '' };
      if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) diff.geometry = { before: [a.x, a.y, a.w, a.h], after: [b.x, b.y, b.w, b.h] };
      if (Object.keys(diff).length) changes.widgets.push({ kind: 'modified', page: pB.name, widget: b.name || `#${b.id}`, type: b.type, changes: diff });
      if (JSON.stringify(a.interactions ?? []) !== JSON.stringify(b.interactions ?? [])) {
        changes.interactions.push({ page: pB.name, widget: b.name || `#${b.id}`, before: a.interactions ?? [], after: b.interactions ?? [] });
      }
    }
    for (const [wk, b] of wB) if (!wA.has(wk)) changes.widgets.push({ kind: 'added', page: pB.name, widget: b.name || `#${b.id}`, type: b.type });
  }
  for (const [k, pB] of pageMapB) if (!pageMapA.has(k)) changes.pages.push({ kind: 'added', page: pB.name });
  const vA = new Map(before.globalVariables.map(v => [v.name, v.value]));
  const vB = new Map(after.globalVariables.map(v => [v.name, v.value]));
  for (const [name, val] of vA) {
    if (!vB.has(name)) changes.variables.push({ kind: 'removed', name, beforeValue: val });
    else if (vB.get(name) !== val) changes.variables.push({ kind: 'modified', name, beforeValue: val, afterValue: vB.get(name) });
  }
  for (const [name, val] of vB) if (!vA.has(name)) changes.variables.push({ kind: 'added', name, afterValue: val });
  const totalChanges = changes.pages.length + changes.variables.length + changes.widgets.length + changes.interactions.length;
  return { ok: true, hasChanges: totalChanges > 0, totalChanges, before: before.counts, after: after.counts, changes };
}
