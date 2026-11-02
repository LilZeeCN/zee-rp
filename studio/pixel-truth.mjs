/**
 * Pair the rendered page with the same page with glyph paint suppressed.
 * DOM grapheme rectangles locate actual text, including spans and transforms.
 * A browser-rendered ink mask locates core strokes, avoiding antialiased edges;
 * the weakest core stroke decides the node, including partially hidden glyphs. Missing glyph evidence stays unknown.
 */
import { decodePng, pixelAt } from './png-decode.mjs';

function toHex({ r, g, b }) {
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
function luminance({ r, g, b }) {
  const channel = value => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function contrastTextNodes(scenePage) {
  return (scenePage.nodes || []).filter(n => typeof n.text === 'string'
    && n.text.replace(/[\p{Cf}\s]/gu, '') && n.visible !== false && Number(n.opacity ?? 1) >= 0.02);
}

/** Rectangles are screenshot-relative CSS pixels; scale comes from decoded PNG. */
export function measurePixelContrast(png, boxes, { backgroundPng = null, inkPng = null, scale = 1, scaleY = scale } = {}) {
  const image = decodePng(png);
  const background = backgroundPng ? decodePng(backgroundPng) : null;
  const ink = inkPng ? decodePng(inkPng) : null;
  if ([background, ink].some(frame => frame && (frame.width !== image.width || frame.height !== image.height))) {
    throw new Error('Foreground/background screenshot dimensions differ');
  }
  return boxes.map(box => {
    const size = Number(box.fontSize) || 14, weight = Number(box.fontWeight) || 400;
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const base = { id: box.id, required, passes: false, status: 'unknown', ratio: null };
    if (!background || !ink || !box.glyphs?.length || box.reason) {
      return { ...base, reason: box.reason || 'missing-glyph-evidence' };
    }
    let worst = null, sampleCount = 0, missing = 0, clipped = 0;
    for (const glyph of box.glyphs) {
      const x0 = Math.max(0, Math.ceil(glyph.x * scale));
      const y0 = Math.max(0, Math.ceil(glyph.y * scaleY));
      const x1 = Math.min(image.width, Math.floor((glyph.x + glyph.w) * scale));
      const y1 = Math.min(image.height, Math.floor((glyph.y + glyph.h) * scaleY));
      let peak = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        peak = Math.max(peak, pixelAt(ink, x, y).r);
      }
      if (peak < 32) { missing++; continue; }
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (pixelAt(ink, x, y).r < Math.max(32, peak * .99)) continue;
        const clip = box.textClip;
        if (clip && ((clip.x !== null && (x / scale < clip.x || x / scale >= clip.x + clip.w))
          || (clip.y !== null && (y / scaleY < clip.y || y / scaleY >= clip.y + clip.h)))) { clipped++; continue; }
        const fg = pixelAt(image, x, y), bg = pixelAt(background, x, y);
        const ratio = contrastRatio(fg, bg);
        sampleCount++;
        if (!worst || ratio < worst.ratio) worst = { ratio, foreground: toHex(fg), background: toHex(bg) };
      }
    }
    if (clipped) return { ...base, reason: 'glyph-clipped-by-text-box', clippedPixels: clipped, sampleCount };
    if (!worst || missing) return { ...base, reason: 'glyph-not-distinguishable-or-occluded', missingGlyphs: missing, sampleCount };
    return { ...base, ...worst, ratio: Math.round(worst.ratio * 100) / 100,
      status: 'measured', passes: worst.ratio >= required, sampleCount, glyphCount: box.glyphs.length };
  });
}

// Executed only in the dedicated browser capture page, never the human editor.
export function collectRenderedText(pageId, candidates) {
  const board = [...document.querySelectorAll('.artboard-wrapper')].find(el => el.dataset.artboardId === pageId)?.querySelector('.artboard-outer');
  if (!board) throw new Error('找不到画板元素');
  const r = board.getBoundingClientRect();
  const clip = { x: Math.floor(r.left + scrollX), y: Math.floor(r.top + scrollY), w: Math.ceil(r.width), h: Math.ceil(r.height) };
  const elements = [...board.querySelectorAll('.studio-node')];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const boxes = candidates.map(node => {
    const el = elements.find(e => e.dataset.nodeId === node.id);
    const box = { id: node.id, fontSize: node.fontSize, fontWeight: node.fontWeight, glyphs: [] };
    if (!el) return { ...box, reason: 'text-dom-missing' };
    const ownStyle = getComputedStyle(el), ownRect = el.getBoundingClientRect();
    box.textClip = { x: ownStyle.overflowX === 'visible' ? null : ownRect.left + scrollX - clip.x,
      y: ownStyle.overflowY === 'visible' ? null : ownRect.top + scrollY - clip.y, w: ownRect.width, h: ownRect.height };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.parentElement.closest('.studio-node') !== el) continue;
      const style = getComputedStyle(text.parentElement);
      let textScale = 1;
      for (let ancestor = text.parentElement; ancestor && ancestor !== board.parentElement; ancestor = ancestor.parentElement) {
        const transform = getComputedStyle(ancestor).transform;
        if (transform === 'none') continue;
        const m = new DOMMatrix(transform);
        if (!m.is2D) { textScale = 0; break; }
        const trace = m.a ** 2 + m.b ** 2 + m.c ** 2 + m.d ** 2;
        const determinant = (m.a * m.d - m.b * m.c) ** 2;
        textScale *= Math.sqrt(Math.max(0, (trace - Math.sqrt(Math.max(0, trace ** 2 - 4 * determinant))) / 2));
      }
      if (parseFloat(style.webkitTextStrokeWidth) > 0) box.reason = 'text-outline-not-assessable';
      for (const { segment, index } of segmenter.segment(text.textContent)) {
        if (!segment.replace(/[\p{Cf}\s]/gu, '')) continue;
        const range = document.createRange();
        range.setStart(text, index); range.setEnd(text, index + segment.length);
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          box.glyphs.push({ x: rect.left + scrollX - clip.x, y: rect.top + scrollY - clip.y, w: rect.width, h: rect.height });
        }
        // The strictest span threshold applies; base node size must not hide small text.
        const size = parseFloat(style.fontSize) * textScale, weight = parseFloat(style.fontWeight) || 400;
        if (size < 24 && !(size >= 18.66 && weight >= 700)) { box.fontSize = 14; box.fontWeight = 400; }
      }
    }
    if (box.glyphs.some(g => g.x < 0 || g.y < 0 || g.x + g.w > clip.w || g.y + g.h > clip.h)) box.reason = 'text-outside-capture';
    el.setAttribute('data-studio-hide-glyphs', '');
    return box;
  });
  // Simultaneous glyph suppression cannot attribute intersecting text layers.
  // Keep those nodes unknown rather than borrow another node's visible ink.
  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (boxes[i].glyphs.some(a => boxes[j].glyphs.some(b => intersects(a, b)))) {
      boxes[i].reason = boxes[j].reason = 'overlapping-text-layers';
    }
  }
  return { clip, boxes, dpr: devicePixelRatio };
}
