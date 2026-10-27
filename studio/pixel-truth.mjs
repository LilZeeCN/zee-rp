/**
 * 像素真值对比度：不再用几何去"猜"浏览器合成结果，而是截图画布后直接取样。
 *
 * 为什么需要它：
 *  - 规则模拟永远追不上 CSS 合成（遮罩、滤镜、混合模式、渐变、阴影）。
 *  - 每补一条规则，攻击面就换一条路径。取像素则一次覆盖全部。
 *
 * 取样策略：围绕文字盒子取一圈内缩边框（避开字形本身），取出现最多的颜色作为底色。
 * 文字颜色来自场景（已解析 token），半透明文字按场景 alpha 处理。
 */
import { decodePng, pixelAt } from './png-decode.mjs';

function toHex({ r, g, b }) {
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function luminance({ r, g, b }) {
  const channel = value => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
}

function parseColor(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(raw);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3) return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

const quantize = c => `${Math.round(c.r / 8) * 8},${Math.round(c.g / 8) * 8},${Math.round(c.b / 8) * 8}`;

/**
 * @param {Buffer} png 画板截图
 * @param {Array<{id:string,x:number,y:number,w:number,h:number,color:string,fontSize:number,fontWeight:number}>} boxes
 *        使用画布坐标（CSS px）
 * @param {{scale?:number}} options scale = 截图像素 / CSS 像素
 */
export function measurePixelContrast(png, boxes, { scale = 1 } = {}) {
  const image = decodePng(png);
  const results = [];
  for (const box of boxes) {
    const fg = parseColor(box.color);
    if (!fg) continue;
    const x0 = box.x * scale;
    const y0 = box.y * scale;
    const x1 = (box.x + box.w) * scale;
    const y1 = (box.y + box.h) * scale;
    if (x1 - x0 < 3 || y1 - y0 < 3) continue;

    // 取内缩 1~2px 的边框环：字形几乎不会贴到边缘，这里基本都是底色。
    const inset = Math.max(1, Math.round(2 * scale));
    const counts = new Map();
    const addPixel = (px, py) => {
      const c = pixelAt(image, px, py);
      if (c.a === 0) return;
      const key = quantize(c);
      const entry = counts.get(key) || { r: 0, g: 0, b: 0, n: 0 };
      entry.r += c.r; entry.g += c.g; entry.b += c.b; entry.n += 1;
      counts.set(key, entry);
    };
    for (let px = x0 + inset; px < x1 - inset; px += 1) {
      addPixel(px, y0 + inset);
      addPixel(px, y1 - inset - 1);
    }
    for (let py = y0 + inset; py < y1 - inset; py += 1) {
      addPixel(x0 + inset, py);
      addPixel(x1 - inset - 1, py);
    }
    if (!counts.size) continue;
    const [bestKey, best] = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    const bg = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
    const size = Number(box.fontSize) || 14;
    const weight = Number(box.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    const ratio = contrastRatio(fg, bg);
    results.push({
      id: box.id,
      ratio,
      required,
      passes: ratio >= required,
      background: toHex(bg),
      sampleCount: best.n,
      dominantBucket: bestKey,
    });
  }
  return results;
}
