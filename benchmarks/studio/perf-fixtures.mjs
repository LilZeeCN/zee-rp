import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export const PERF_CATEGORIES = ['text', 'images', 'components', 'multipage'];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const tag = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, bytes])));
  return Buffer.concat([size, tag, bytes, crc]);
}

function png(index) {
  const header = Buffer.alloc(13), pixels = Buffer.alloc((64 * 4 + 1) * 48);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const at = y * 257 + 1 + x * 4;
    pixels[at] = (x * 3 + index * 13) % 256;
    pixels[at + 1] = (y * 4 + index * 7) % 256;
    pixels[at + 2] = 120; pixels[at + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Size means expanded scene nodes, including page roots, not component instances. */
export function makePerfFixture({ size, category, projectDir }) {
  if (!PERF_CATEGORIES.includes(category) || !Number.isInteger(size) || size < 20) throw new Error('Invalid performance fixture');
  const pageCount = category === 'multipage' ? 10 : 1;
  const doc = {
    schemaVersion: 1, documentId: `perf-${category}-${size}`, revision: 1,
    name: `Performance ${category} ${size}`, language: 'rp/1', target: 9,
    domain: 'web', theme: 'enterprise-light', device: null,
    palette: { bg: '#F4F5F7', ink: '#183044', brand: '#2457BD' },
    tokens: { colors: { bg: '#F4F5F7', ink: '#183044', brand: '#2457BD' } },
    fonts: { defaultFamily: 'PingFang SC', headingFamily: 'PingFang SC', monoFamily: 'Menlo' },
    variables: {}, datasets: {}, components: {}, assetsManifest: {}, explorations: [], pages: [],
  };
  if (category === 'images') {
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    for (let i = 0; i < 16; i++) {
      const relativePath = `assets/perf-${i}.png`;
      const bytes = png(i);
      writeFileSync(join(projectDir, relativePath), bytes);
      doc.assetsManifest[relativePath] = { relativePath, width: 64, height: 48, bytes: bytes.length };
    }
  }
  if (category === 'components') doc.components['perf-tile'] = {
    id: 'perf-tile', name: 'Perf Tile', params: {}, variants: {},
    root: { id: 'tile', type: 'box', layout: 'stack', w: 144, h: 48, fill: '#FFFFFF', children: [
      { id: 'title', type: 'label', x: 4, y: 2, w: 136, h: 20, text: 'Component title', fontSize: 13 },
      { id: 'detail', type: 'label', x: 4, y: 24, w: 136, h: 18, text: 'Reusable detail', fontSize: 12 },
    ] },
  };
  let left = size - pageCount, serial = 0;
  for (let p = 0; p < pageCount; p++) {
    const count = Math.floor(left / (pageCount - p)); left -= count;
    const children = [];
    let remaining = count;
    if (p === 0) {
      children.push({ id: 'probe', name: 'Visible edit target', role: 'perf-probe', type: 'label', x: 340, y: 120, w: 300, h: 32, text: 'Performance probe 000', fontSize: 20, color: '#183044' });
      remaining--;
    }
    let slot = 0;
    while (remaining > 0) {
      const x = 24 + (slot % 8) * 152, y = 200 + Math.floor(slot / 8) * 54;
      const id = `n${serial++}`;
      if (category === 'components' && remaining >= 3) {
        children.push({ id, type: 'instance', component: 'perf-tile', x, y, w: 144, h: 48 });
        remaining -= 3;
      } else if (category === 'images' && slot % 5 !== 0) {
        children.push({ id, type: 'image', x, y, w: 64, h: 48, src: `assets/perf-${slot % 16}.png` });
        remaining--;
      } else {
        children.push({ id, type: 'label', x, y, w: 144, h: 22, text: `学习内容 ${slot % 16} · baseline`, fontSize: 13, color: '#183044' });
        remaining--;
      }
      slot++;
    }
    const height = Math.max(800, 240 + Math.ceil(slot / 8) * 54);
    doc.pages.push({ id: `p${p}`, name: `Page ${p + 1}`, domain: 'web', device: null,
      canvas: { x: p * 1400, y: 0, w: 1280, h: height }, interactions: [], explorations: [],
      root: { id: `p${p}_root`, type: 'box', layout: 'stack', w: 1280, h: height, padding: 0, fill: '#F4F5F7', children } });
  }
  return doc;
}

export function countSourceNodes(doc) {
  let count = 0;
  function visit(node) { count++; for (const child of node.children || []) visit(child); }
  for (const page of doc.pages) visit(page.root);
  return count;
}
