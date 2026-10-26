/**
 * 设计度量层（L1 视觉完成度的可计算代理指标 + 反 AI-slop 负样本规则）
 *
 * 设计原则：
 *  1. 不给"审美总分"——分数不可信，会训练出讨好分数的模型。
 *  2. 只给可复现的结构性判断：字阶比、间距栅格、留白占比、对比度、色相数。
 *  3. 反 slop 规则命中即报，附 nodeId 与具体改法。
 *
 * 全部输入来自 ResolvedScene（浏览器解析后的真实几何），不依赖渲染图。
 */

const TRANSPARENT = /^(transparent|none|#FFFFFF00|#00000000|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i;

function parseColor(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || TRANSPARENT.test(raw)) return null;
  let m = /^#([0-9a-f]{3,8})$/i.exec(raw);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 4) hex = hex.slice(0, 3).split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    if (a === 0) return null;
    return { r, g, b, a };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.every(n => Number.isFinite(n))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
  }
  return null;
}

function relativeLuminance({ r, g, b }) {
  const lin = [r, g, b].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(fg, bg) {
  if (!fg || !bg) return null;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function hueOf({ r, g, b }) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s };
}

function isTransparent(value) {
  return !parseColor(value);
}

/** 沿 parentId 向上找第一个不透明填充，作为文本的实际背景。 */
// Cf 覆盖零宽空格、软连字符(U+00AD)、BOM 等所有"不可见格式字符"。
const INVISIBLE = /\p{Cf}/gu;
const BLANK = /^[\s\u00a0\u3000]*$/;
const realText = value => (typeof value === 'string' ? value.replace(INVISIBLE, '') : '')
  .replace(/^[\s\u00a0\u3000]+|[\s\u00a0\u3000]+$/g, '');
const realSrc = value => typeof value === 'string' && !BLANK.test(value.replace(INVISIBLE, ''));

// parseColor 对 alpha=0 返回 null（"没画"）；文字透明是"有字看不见"，要单独解析。
const colorAlpha = value => {
  const raw = String(value ?? '').trim();
  const hex8 = /^#([0-9a-f]{8})$/i.exec(raw);
  if (hex8) return parseInt(hex8[1].slice(6, 8), 16) / 255;
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (rgba) {
    const parts = rgba[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length > 3 && Number.isFinite(parts[3])) return parts[3];
  }
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return 1;
  const parsed = parseColor(value);
  return parsed ? parsed.a : 1;
};

const scaleOf = node => {
  const raw = String(node.css?.transform || node.customTransform || '');
  const match = raw.match(/scale\(([\d.]+)\)/);
  return match ? Number(match[1]) : 1;
};

const effectiveAlpha = node => {
  const color = parseColor(node.fill);
  if (!color) return 0;
  const opacity = Number.isFinite(Number(node.opacity)) ? Number(node.opacity) : 1;
  return color.a * opacity;
};

const visibleText = node => {
  if (!realText(node.text)) return false;
  const opacity = Number.isFinite(Number(node.opacity)) ? Number(node.opacity) : 1;
  return colorAlpha(node.color) * opacity * scaleOf(node) >= 0.02;
};

const visibleNode = node => visibleText(node)
  || (realSrc(node.src) && (Number(node.opacity ?? 1) >= 0.02))
  || (effectiveAlpha(node) * scaleOf(node) >= 0.02)
  || (Number(node.strokeWidth) > 0 && effectiveAlpha({ fill: node.stroke, opacity: node.opacity }) >= 0.02);

function overlappingBackdrop(node, nodes) {
  // 绝对定位里"文字压在色块上"是常态，色块往往是文字的兄弟节点而非祖先。
  // 取 z 序在文字之前、且覆盖文字中心的最大不透明块作为真实底色。
  const cx = node.x + (node.w || 0) / 2;
  const cy = node.y + (node.h || 0) / 2;
  let best = null;
  for (const other of nodes) {
    if (other.id === node.id) continue;
    if (other.type === 'image') return null; // 图片底色不可知，直接放弃而不是瞎猜
    if (!Number.isFinite(other.x) || !Number.isFinite(other.y)) continue;
    if (cx < other.x || cx > other.x + (other.w || 0)) continue;
    if (cy < other.y || cy > other.y + (other.h || 0)) continue;
    const color = parseColor(other.fill);
    if (!color || color.a < 0.6) continue;
    if (Number(other.renderOrder) >= Number(node.renderOrder)) continue;
    if (!best || Number(other.renderOrder) > Number(best.order)) {
      best = { color, order: Number(other.renderOrder) };
    }
  }
  return best ? best.color : null;
}

function resolveBackground(node, byId, fallback, allNodes = []) {
  const orderOf = n => Number(n.renderOrder ?? n.depth ?? 0);
  const visibleLayer = n => n.visible !== false && (Number(n.opacity ?? 1) >= 0.02);
  const isMedia = o => Boolean(o.src) || o.type === 'image' || o.gradient
    || /gradient/i.test(String(o.css?.background || ''));
  const coverage = other => {
    const nw = node.w || 0, nh = node.h || 0;
    const area = nw * nh;
    if (!area) return 0;
    const ix = Math.max(0, Math.min(node.x + nw, other.x + (other.w || 0)) - Math.max(node.x, other.x));
    const iy = Math.max(0, Math.min(node.y + nh, other.y + (other.h || 0)) - Math.max(node.y, other.y));
    return (ix * iy) / area;
  };

  // 文字节点自身有填充（按钮/标签块）时，自己的底就是底色。
  const ownFill = parseColor(node.fill);
  if (ownFill && ownFill.a >= 0.6) return { color: ownFill, resolved: true };

  // 按绘制顺序找"压在文字下面、且真的盖住它"的层，自下而上合成。
  // 关键：fill.a × opacity 才是这层的有效不透明度；a<1 必须与下面的层合成，
  // 合不出来就老实说 unknown——不能把半透明遮罩当成纯色返回。
  const layers = (allNodes || [])
    .filter(other => other !== node
      && visibleLayer(other)
      && orderOf(other) < orderOf(node)
      && coverage(other) >= 0.3)
    .sort((a, b) => orderOf(b) - orderOf(a));

  const blend = (top, alpha, under) => ({
    r: Math.round(top.r * alpha + under.r * (1 - alpha)),
    g: Math.round(top.g * alpha + under.g * (1 - alpha)),
    b: Math.round(top.b * alpha + under.b * (1 - alpha)),
    a: 1,
  });

  // 自最上层往下递归：每层若不满不透明，就与下一层合成。
  const compose = index => {
    if (index >= layers.length) return { color: fallback }; // 画布默认白底
    const layer = layers[index];
    if (isMedia(layer)) return { unknown: true };
    const fill = parseColor(layer.fill);
    if (!fill) return compose(index + 1);
    const alpha = Math.min(1, fill.a * (Number(layer.opacity ?? 1) || 1));
    if (alpha >= 0.999) return { color: fill };
    const beneath = compose(index + 1);
    if (beneath.unknown) return { unknown: true };
    return { color: blend(fill, alpha, beneath.color) };
  };

  const composed = compose(0);
  if (composed.unknown) return { color: null, resolved: false, unknown: true };
  if (composed.color) return { color: composed.color, resolved: true };

  // 没有覆盖层时沿父链找实体底色。
  let current = node;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const color = parseColor(current.fill);
    if (color && color.a >= 0.6) return { color, resolved: true };
    if (current.css && typeof current.css.background === 'string' && !/gradient/i.test(current.css.background)) {
      const cssColor = parseColor(current.css.background);
      if (cssColor) return { color: cssColor, resolved: true };
    }
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  // 画布本身默认是白底；这里不再猜"未知"，否则纯文字页会全变 unknown。
  return { color: fallback, resolved: true };
}

function collectNodes(scenePage) {
  const nodes = scenePage.nodes || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const byScoped = new Map(nodes.map(n => [n.scopedId, n]));
  // childrenIds 可能是 scoped（page/child）也可能是裸 id，统一解析。
  const childOf = id => byId.get(id) || byScoped.get(id)
    || byScoped.get(String(id).split('/').slice(-1)[0]) || null;
  return { nodes, byId, childOf };
}

function whitespaceRatio(nodes, board, grid = 8) {
  const width = board?.screenW || 0;
  const height = board?.screenH || 0;
  if (!width || !height) return null;
  const cols = Math.ceil(width / grid);
  const rows = Math.ceil(height / grid);
  const cover = new Uint8Array(cols * rows);
  const pageArea = width * height;
  for (const node of nodes) {
    if (node.visible === false) continue;
    const area = (node.w || 0) * (node.h || 0);
    const hasText = typeof node.text === 'string' && node.text.trim();
    const hasMedia = Boolean(node.src);
    // 背景层/根容器不算"内容"，否则任何有底色的页面留白都是 0。
    if (!hasText && !hasMedia && area >= pageArea * 0.9) continue;
    // 宏容器（card/detail-card/stat-row）的表面由内部节点绘制，但视觉上确实是实体块。
    const macroSurface = ['card', 'detail-card', 'stat-row', 'phone-shell', 'data-table'].includes(node.type);
    const painted = hasText || hasMedia || macroSurface
      || (!isTransparent(node.fill))
      || (node.css && typeof node.css.background === 'string' && !/none/i.test(node.css.background));
    if (!painted) continue;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    const x0 = Math.max(0, Math.floor(node.x / grid));
    const y0 = Math.max(0, Math.floor(node.y / grid));
    const x1 = Math.min(cols - 1, Math.floor((node.x + (node.w || 0)) / grid));
    const y1 = Math.min(rows - 1, Math.floor((node.y + (node.h || 0)) / grid));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cover[y * cols + x] = 1;
  }
  let filled = 0;
  for (let i = 0; i < cover.length; i++) filled += cover[i];
  const ratio = filled / cover.length;
  return { whitespaceRatio: 1 - ratio, coverage: ratio };
}

function typeScale(nodes) {
  const raw = [...new Set(nodes
    .filter(n => visibleText(n) && Number.isFinite(n.fontSize) && n.fontSize > 0)
    .map(n => Math.round(n.fontSize * 100) / 100))]
    .sort((a, b) => b - a);
  // 相差不到 8% 的字号在视觉上是同一级，先合并，再算字阶比。
  const sizes = [];
  for (const size of raw) {
    if (!sizes.length || sizes[sizes.length - 1] / size >= 1.08) sizes.push(size);
  }
  if (sizes.length < 2) return { sizes, ratios: [], maxRatio: null, minRatio: null, levels: sizes.length, displaySizes: [], bodySizes: sizes, bodyRatios: [] };

  // 有 display 字的页面（编辑排版/landing）天然存在一次大跨越；
  // 字阶判据只对"正文层级"生效，display 单独计数，避免把 88→24 的意图判成错。
  const bodyFloor = sizes[sizes.length - 1];
  const displaySizes = sizes.filter(size => size >= bodyFloor * 2);
  const bodySizes = sizes.filter(size => size < bodyFloor * 2);
  const bodyRatios = [];
  for (let i = 0; i < bodySizes.length - 1; i++) bodyRatios.push(Math.round((bodySizes[i] / bodySizes[i + 1]) * 1000) / 1000);
  const ratios = [];
  for (let i = 0; i < sizes.length - 1; i++) ratios.push(Math.round((sizes[i] / sizes[i + 1]) * 1000) / 1000);
  return {
    sizes,
    ratios,
    maxRatio: ratios.length ? Math.max(...bodyRatios.length ? bodyRatios : ratios) : null,
    minRatio: bodyRatios.length ? Math.min(...bodyRatios) : null,
    levels: bodySizes.length,
    displaySizes,
    bodySizes,
    bodyRatios,
    absoluteMaxRatio: ratios.length ? Math.max(...ratios) : null,
  };
}

const GEOMETRY_TYPES = new Set(['box', 'image', 'input', 'button', 'badge', 'repeater', 'dynamic-panel', 'phone-shell', 'card', 'divider', 'icon']);

function gridAlignment(nodes, grid = 4) {
  const values = [];
  const offenders = [];
  for (const node of nodes) {
    // 文本节点的坐标与尺寸都是排版结果，不属于"间距决策"；混进来会让失败数
    // 和可修复清单对不上（试用者实测：失败 3 条、清单 6 条）。
    if (node.type === 'label' || node.type === 'paragraph') continue;
    const geometric = GEOMETRY_TYPES.has(node.type) || (node.childrenIds || []).length > 0;
    const pushValue = value => { if (Number.isFinite(value) && value >= grid) values.push(value); };
    for (const key of ['x', 'y']) pushValue(node[key]);
    if (geometric) for (const key of ['w', 'h']) pushValue(node[key]);
    if (Array.isArray(node.padding)) values.push(...node.padding.filter(v => Number.isFinite(v) && v >= grid));
    if (Number.isFinite(node.gap) && node.gap >= grid) values.push(node.gap);
    for (const key of ['x', 'y', 'w', 'h']) {
      const value = node[key];
      if (!Number.isFinite(value) || value <= 0) continue;
      // 1–3px 的发丝线/分隔线是刻意的，不能被"建议改成 0px"。
      if (value < grid) continue;
      if (Math.abs(value / grid - Math.round(value / grid)) < 0.01) continue;
      const nearest = Math.max(grid, Math.round(value / grid) * grid);
      offenders.push({ id: node.id, prop: key, value: Math.round(value * 100) / 100, nearest });
    }
  }
  if (!values.length) return { total: 0, aligned: 0, ratio: null, offenders: [], offenderCount: 0 };
  const aligned = values.filter(v => Math.abs(v / grid - Math.round(v / grid)) < 0.01).length;
  // 一本账：failureCount == offenderCount，清单只是截断展示。
  return {
    total: values.length,
    aligned,
    ratio: aligned / values.length,
    grid,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, 12),
    offendersTruncated: offenders.length > 12,
  };
}

function contrastReport(nodes, byId) {
  const results = [];
  let unknown = 0;
  const unknownNodes = [];
  for (const node of nodes) {
    if (typeof node.text !== 'string' || !node.text.trim()) continue;
    if (!visibleText(node)) continue; // 看不见的文字不参与采样（否则 opacity:0 会把绿页判红）
    const fg = parseColor(node.color);
    if (!fg) continue;
    const bgInfo = resolveBackground(node, byId, { r: 255, g: 255, b: 255, a: 1 }, nodes);
    if (!bgInfo.resolved) {
      // 底色取决于图片/渐变：不能当白底算 6.92 去放行，也不能丢掉。
      // 记录节点 id，否则"有 1 处不可判断"没人知道是哪一处。
      unknownNodes.push(node.id);
      unknown += 1;
      continue;
    }
    const ratio = contrastRatio(fg, bgInfo.color);
    if (ratio === null) continue;
    const size = Number(node.fontSize) || 14;
    const weight = Number(node.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    results.push({
      id: node.id,
      text: node.text.length > 20 ? `${node.text.slice(0, 20)}…` : node.text,
      ratio: Math.round(ratio * 100) / 100,
      required: large ? 3 : 4.5,
      passes: ratio >= (large ? 3 : 4.5),
    });
  }
  const failing = results.filter(r => !r.passes);
  return {
    checked: results.length,
    // 分母 = 能判断的 + 不能判断的；只读 checked 会复现"静默丢弃"。
    total: results.length + unknown,
    unknownNodes,
    failing: failing.length,
    minRatio: results.length ? Math.min(...results.map(r => r.ratio)) : null,
    worst: failing.slice(0, 5),
    // 只在真的跳过时写 true，不再恒真。
    skippedUnknownBackground: unknown > 0,
    unknown,
  };
}

function visualHierarchy(scenePage, nodes, byId) {
  const rootId = nodes.find(n => !n.parentId)?.id;
  let blocks = nodes.filter(n => n.parentId === rootId && n.visible !== false);
  if (blocks.length < 3 && rootId) {
    const root = byId.get(rootId);
    const grand = (root?.childrenIds || [])
      .flatMap(id => {
        const child = byId.get(id);
        if (!child) return [];
        const own = (child.childrenIds || []).map(cid => byId.get(cid)).filter(Boolean);
        return own.length ? own : [child];
      })
      .filter(Boolean);
    if (grand.length >= 3) blocks = grand;
  }
  if (blocks.length < 3) {
    // 两栏/单主图的页面也要能算主次：退到"面积够大的内容节点"。
    const boardArea = (scenePage.board?.screenW || 0) * (scenePage.board?.screenH || 0);
    const bigEnough = node => node
      && (!boardArea || (node.w || 0) * (node.h || 0) >= boardArea * 0.03);
    // 只用"末级视觉单元"：文字块、图片、无子节点的实心块。
    // 父容器与子块同时计入会重复算面积，把 3.7× 稀释成 1.4×（实测）。
    const candidates = nodes.filter(n => {
      if (!n.parentId || n.visible === false) return false;
      const hasText = typeof n.text === 'string' && n.text.trim();
      if (hasText || n.src) return bigEnough(n) || hasText;
      const isLeafBox = !(n.childrenIds || []).length;
      return isLeafBox && bigEnough(n) && !isTransparent(n.fill);
    });
    if (candidates.length < 3) return null;
    blocks = candidates;
  }
  const pageBg = parseBackgroundLuma(nodes.find(n => !n.parentId));
  // 幽灵块：没有文字、没有图、填充全透明——它不构成视觉重量。
  blocks = blocks.filter(visibleNode);
  if (blocks.length < 3) return null;

  const masses = blocks.map(node => {
    const hasText = Boolean(realText(node.text));
    const contentH = Number(node.contentH) || 0;
    // 文字块的视觉重量应由"实际文字高度"决定，不是外框高度：
    // 否则把 24px 标题的框撑到 232px 就能刷出更高的主次比。
    let effectiveH = Number.isFinite(node.h) ? node.h : 0;
    if (hasText && contentH > 0) effectiveH = Math.min(effectiveH, contentH);
    const area = Math.max(1, (node.w || 0) * effectiveH);
    const luma = parseBackgroundLuma(node);
    const contrast = luma !== null && pageBg !== null ? Math.abs(luma - pageBg) : 0.25;
    // 文字块按字号加权：纯文字 hero 不该因为"没图"就永远拿不到主次比。
    const textWeight = hasText ? 1 + Math.min(2.2, (Number(node.fontSize) || 14) / 24) : 1;
    const mediaWeight = node.src ? 1.15 : 1;
    return { id: node.id, mass: area * (0.6 + contrast * 2.4) * textWeight * mediaWeight };
  }).sort((a, b) => b.mass - a.mass);
  const top = masses[0];
  const second = masses[1];
  const third = masses[2];
  // 撑高文字要单独扫全页文字节点：只扫顶层块会漏掉卡片里的标题，
  // 而"框高 - 文字高"要够大才算，否则 44px 按钮（文字 22）会被批量误判。
  const stretchedText = [];
  for (const node of nodes) {
    if (typeof node.text !== 'string' || !node.text.trim()) continue;
    const boxH = Number(node.h) || 0;
    const contentH = Number(node.contentH) || 0;
    if (boxH <= 0 || contentH <= 0) continue;
    if (boxH - contentH > 40 && boxH > contentH * 1.5) {
      stretchedText.push({ id: node.id, boxH: Math.round(boxH), contentH: Math.round(contentH) });
    }
  }
  const ratio = Math.round((top.mass / Math.max(1, second.mass)) * 100) / 100;
  // "失衡"只针对文字被硬撑大、或某块吃掉几乎整页的情况；
  // 一张大图主导的画面（hero）是正常设计，不该被上限误伤。
  const dominantNode = byId.get(top.id);
  const pageArea = (scenePage.board?.screenW || 0) * (scenePage.board?.screenH || 0);
  const dominantShare = pageArea && dominantNode ? ((dominantNode.w || 0) * (dominantNode.h || 0)) / pageArea : 0;
  const dominantIsText = typeof dominantNode?.text === 'string' && dominantNode.text.trim();
  return {
    dominantId: top.id,
    dominanceRatio: ratio,
    overDominant: ratio > 8 && (Boolean(dominantIsText) || dominantShare > 0.8),
    topThree: masses.slice(0, 3).map(m => ({ id: m.id, mass: Math.round(m.mass) })),
    flat: third.mass >= top.mass * 0.85,
    stretchedText,
  };
}

function parseBackgroundLuma(node) {
  const color = parseColor(node?.fill);
  if (!color) return null;
  return relativeLuminance(color);
}

function compositionBalance(nodes, board) {
  const width = board?.screenW || 0;
  if (!width) return null;
  const thirds = [0, 0, 0];
  let content = 0;
  const pageArea = width * (board?.screenH || 0);
  for (const node of nodes) {
    if (node.visible === false || !Number.isFinite(node.x) || !Number.isFinite(node.w)) continue;
    const area = node.w * (node.h || 0);
    if (area <= 0) continue;
    // 整页底色不是"内容"：它会把三等分占比抹平，让死区检测直接失效。
    if (!(typeof node.text === 'string' && node.text.trim()) && !node.src && pageArea && area >= pageArea * 0.9) continue;
    if (!(typeof node.text === 'string' && node.text.trim()) && !node.src && isTransparent(node.fill)) continue;
    const center = node.x + node.w / 2;
    const index = Math.min(2, Math.max(0, Math.floor((center / width) * 3)));
    thirds[index] += area;
    content += area;
  }
  if (!content) return null;
  const shares = thirds.map(v => Math.round((v / content) * 1000) / 1000);
  // 内容重心偏左 + 右三分之一几乎空白 = 右侧死区
  const deadRight = shares[2] < 0.08 && shares[0] > 0.3;
  return { sharesByThird: shares, contentArea: content, deadRight };
}



// 导出预算是**加性**的：每个节点本身都是可编辑基底，效果只是额外装饰层。
// 之前做成互斥桶，导致"6 个节点 = 6 native + 2 raster"这种分母不自洽的报表。
// 按实测校准（对比 studio_export_rp 的真实分类）：
//   filter / mask / backdrop → 被栅格化成装饰层
//   transform / clipPath     → 导出不支持
//   background 渐变            → 栅格装饰层（节点本身仍 native-editable）
const RASTER_CSS = new Set(['filter', 'backdropFilter', 'backdrop-filter', 'mask', 'maskImage', 'mixBlendMode']);
const UNSUPPORTED_CSS = new Set(['transform', 'clipPath']);

function exportProjection(scenePage) {
  const items = [];
  let nodes = 0;
  let rasterized = 0;
  let uncertain = 0;
  let unsupported = 0;
  for (const node of scenePage.nodes || []) {
    if (node.visible === false) continue;
    nodes += 1;
    const css = node.css || {};
    const raster = [];
    const maybe = [];
    const lost = [];
    for (const [key, raw] of Object.entries(css)) {
      const value = String(raw ?? '');
      if (!value || value === 'none') continue;
      if (UNSUPPORTED_CSS.has(key)) lost.push(key);
      else if (RASTER_CSS.has(key)) raster.push(key);
      else if (/gradient/i.test(value)) raster.push('background-gradient');
      else if (key === 'boxShadow' || key === 'textShadow') raster.push('shadow');
    }
    if (node.gradient) raster.push('gradient');
    if (node.shadow) raster.push('shadow');
    // customFilter 走的是同一条 CSS 绘制路径，真实导出会被栅格化。
    if (node.customFilter) raster.push('custom-filter');
    if (node.backdropBlur) lost.push('backdropBlur');
    const dedupe = list => [...new Set(list)];
    if (lost.length) { unsupported += 1; items.push({ id: node.id, verdict: 'unsupported', features: dedupe(lost) }); }
    if (maybe.length) { uncertain += 1; items.push({ id: node.id, verdict: 'uncertain', features: dedupe(maybe) }); }
    if (raster.length) { rasterized += 1; items.push({ id: node.id, verdict: 'rasterized-effect', features: dedupe(raster) }); }
  }
  return {
    nodes,
    // 每个节点本身即原生可编辑基底；下面的计数是**装饰层**，可与节点数并存。
    nativeBase: nodes,
    rasterized,
    uncertain,
    unsupported,
    // 旧字段名保留，避免下游断言突然失效；语义等同 unsupported
    dropped: unsupported,
    decorations: rasterized + uncertain + unsupported,
    items: items.slice(0, 12),
    truncated: items.length > 12,
    note: '加性口径：每个节点都是可编辑基底，rasterized/uncertain/dropped 是额外装饰层。'
      + 'filter/mask/transform 去向在静态阶段无法确知（标 uncertain）；backdrop 类通常 unsupported。'
      + '词表与导出报告一致：native-editable / rasterized-effect / uncertain / unsupported。'
      + '真实结论以 studio_export_rp 报告为准。',
  };
}

function containmentReport(scenePage, nodes, byId) {
  const board = scenePage.board || {};
  const width = board.screenW || 0;
  const height = board.screenH || 0;
  const outside = [];
  const textOverflow = [];
  for (const node of nodes) {
    if (node.visible === false) continue;
    // 透明的**叶子**残留图层不该让构建变红；但透明容器仍然占布局，越界要报。
    if (!visibleNode(node) && (node.childrenIds || []).length === 0) continue;
    if (![node.x, node.y, node.w, node.h].every(Number.isFinite)) continue;
    if (width && height) {
      const over = {
        right: Math.max(0, Math.round(node.x + node.w - width)),
        bottom: Math.max(0, Math.round(node.y + node.h - height)),
        left: Math.max(0, Math.round(-node.x)),
        top: Math.max(0, Math.round(-node.y)),
      };
      // 与 review 的判定共用同一容差（0.5px）。以前 metrics 用 >1px、review 用 <0，
      // 导致 1px 越界时两个工具结论相反。
      const worst = Math.max(over.right, over.bottom, over.left, over.top);
      if (worst > 0.5) outside.push({ id: node.id, type: node.type, over });
    }
    if (typeof node.text === 'string' && node.text.trim() && node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent && [parent.x, parent.y, parent.w, parent.h].every(Number.isFinite)) {
        const dx = Math.max(0, Math.round(node.x + node.w - (parent.x + parent.w)));
        const dy = Math.max(0, Math.round(node.y + node.h - (parent.y + parent.h)));
        const dl = Math.max(0, Math.round(parent.x - node.x));
        const dt = Math.max(0, Math.round(parent.y - node.y));
        if (Math.max(dx, dy, dl, dt) > 0.5) {
          textOverflow.push({ id: node.id, parentId: parent.id, over: { right: dx, bottom: dy, left: dl, top: dt } });
        }
      }
    }
  }
  return { outside, textOverflow, total: outside.length + textOverflow.length };
}


// 关系约束：单看一个元素的尺寸/字号无法判断"这页对不对"，
// 但"主操作唯一""每个列表都有空态""可点区域够大"是可以机器验的。
function relationChecks(scenePage, nodes, domain, childOf = () => null) {
  const checks = [];
  const interactive = nodes.filter(n => n.type === 'button' || n.type === 'input'
    || (n.type === 'icon' && (n.on || n.role === 'action'))
    // 任何挂了 click 的节点都是可点区域，不管它 type 是什么。
    || n.on?.click);
  const primary = nodes.filter(n => n.role === 'primary-action'
    || (n.type === 'button' && (n.variant === 'primary' || n.primary === true))
    // 组件实例路径：type 退化成 box，但 component/componentVariant 还在
    || (n.component === 'button' && n.componentVariant === 'primary'));

  // 页头与页脚各一个主操作是正常的；"并列"只指同一容器里抢焦点。
  const ancestorChain = node => {
    const chain = [];
    let current = node;
    const seen = new Set();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      current = nodes.find(n => n.id === current.parentId);
      if (current) chain.push(current.id);
    }
    return chain;
  };
  const rootId = nodes.find(n => !n.parentId)?.id;
  const sharedContainer = (a, b) => {
    const chainB = new Set(ancestorChain(b));
    for (const id of ancestorChain(a)) if (chainB.has(id)) return id;
    return null;
  };
  // 两个主操作只有在"最近的共同容器不是页面根"时才算抢焦点：
  // 页头/页脚各一个，共同祖先是根，属正常；包一层 wrapper 仍在同一行里，属并列。
  const clashing = [];
  for (let i = 0; i < primary.length; i++) {
    for (let j = i + 1; j < primary.length; j++) {
      const shared = sharedContainer(primary[i], primary[j]);
      const bothDirectChildren = primary[i].parentId === rootId && primary[j].parentId === rootId;
      // 共同祖先是根时：只有两个主操作都直接挂在根上才算同屏抢焦点；
      // 各自在自己的页头/页脚容器里，属正常结构。
      if (shared && (shared !== rootId || bothDirectChildren)) clashing.push(primary[i], primary[j]);
    }
  }
  checks.push({
    key: 'primary-action-unique',
    ok: clashing.length === 0,
    detail: primary.length === 0
      ? '页面没有主操作（role:"primary-action" 或 variant:"primary" 按钮）；纯展示页可忽略'
      : clashing.length
        ? `${clashing.length} 个主操作挤在同一容器（${clashing.map(n => n.id).slice(0, 3).join(', ')}）——同屏只该有一个`
        : `${primary.length} 个主操作分散在不同区域（${primary.map(n => n.id).slice(0, 3).join(', ')}），不算并列`,
    advisory: primary.length === 0,
    skipped: false,
  });

  const minTarget = domain === 'web' ? 32 : 44;
  // 只量真实绘制尺寸。hitW/hitH 目前渲染层没有消费点，
  // 用它判绿就是"元数据刷绿"——宁可红着，也不假绿。
  const hitSize = node => {
    const w = Number(node.w);
    const h = Number(node.h);
    return Number.isFinite(w) && Number.isFinite(h) ? Math.min(w, h) : null;
  };
  const small = interactive.filter(n => {
    const size = hitSize(n);
    return size !== null && size < minTarget;
  });
  checks.push({
    key: 'tap-target',
    ok: small.length === 0,
    skipped: interactive.length === 0,
    detail: interactive.length === 0
      ? '没有可交互元素，跳过点击区检查'
      : small.length
        ? `${small.length} 个可点的热区小于 ${minTarget}px（${small.slice(0, 3).map(n => `${n.id} ${hitSize(n)}px`).join('，')}）`
        : `${interactive.length} 个可点元素的热区均不小于 ${minTarget}px`,
  });

  const lists = nodes.filter(n => n.type === 'repeater' || n.type === 'list-item' || n.type === 'data-table');
  const empties = nodes.filter(n => n.role === 'empty-state');
  // 空态要绑到具体列表（role:"empty-state" + for:<listId>）。
  // 不绑的空态只能算"全页兜底"，多个列表时不足以覆盖。
  const boundFor = node => node.for || node.emptyFor || node.boundTo || null;
  const bound = empties.filter(e => boundFor(e));
  const unbound = empties.filter(e => !boundFor(e));
  const uncovered = lists.filter(list => !bound.some(e => boundFor(e) === list.id));
  // 空态必须有内容（文字），否则只是一块白板；也必须有绑定，否则不知道覆盖哪个列表。
  const emptyHasContent = node => {
    if (realText(node.text)) return true;
    // 递归看后代：只有"有文字或图片"才算有内容；一堆空盒子仍然是白板。
    const seen = new Set();
    const visit = id => {
      if (seen.has(id)) return false;
      seen.add(id);
      const child = childOf(id);
      if (!child) return false;
      if (realText(child.text) || realSrc(child.src)) return true;
      return (child.childrenIds || []).some(visit);
    };
    return (node.childrenIds || []).some(visit);
  };
  const blankEmptyStates = empties.filter(e => !emptyHasContent(e));
  const emptyOk = lists.length === 0
    || ((bound.length > 0 && uncovered.length === 0) && blankEmptyStates.length === 0);
  checks.push({
    key: 'empty-state-coverage',
    ok: emptyOk,
    skipped: lists.length === 0,
    detail: lists.length === 0
      ? '没有列表，无需空态'
      : emptyOk
        ? `列表 ${lists.length} 个，空态分别绑定（${bound.map(e => `${e.id}→${boundFor(e)}`).slice(0, 3).join('，')}）`
        : blankEmptyStates.length
          ? `空态没有内容（只有 role 没有文字）：${blankEmptyStates.map(e => e.id).slice(0, 3).join('，')}——渲染出来是白板`
          : unbound.length
            ? `有 ${lists.length} 个列表，空态未绑定到具体列表（补 for:"<列表id>"）——unbound: ${unbound.map(e => e.id).slice(0, 3).join('，')}`
          : `列表未被空态覆盖：${uncovered.map(l => l.id).slice(0, 3).join('，')}——数据为 0 时会空白`,
  });
  return checks;
}

function huePalette(nodes) {
  const buckets = new Map();
  for (const node of nodes) {
    // 只统计作者显式写下的颜色（rawFill/rawStroke/rawColor）。
    // 否则主题默认 ink 会挂在每个空节点上，纯黑白页也会被报成"2 个主色相"。
    const painted = [];
    const isToken = value => typeof value === 'string' && value.startsWith('$');
    // token 引用（$brand 等）是正常工程的常态；此时要取解析后的颜色，
    // 否则整页 token 化后会得到"主色相 0 类"的假阴性。
    // scene 的 fill/stroke/color 已经是解析后的颜色（token 也已展开）。
    // 之前只在"有 raw 值且是 token"时才取解析色，导致 token 工程整条检查静默失效。
    if (!isTransparent(node.fill)) painted.push(node.fill);
    if (Number(node.strokeWidth) > 0 && !isTransparent(node.stroke)) painted.push(node.stroke);
    if (typeof node.text === 'string' && node.text.trim() && !isTransparent(node.color)) painted.push(node.color);
    for (const raw of painted) {
      const color = parseColor(raw);
      if (!color) continue;
      const { h, s } = hueOf(color);
      if (s < 0.18) continue; // 低饱和不计入主色相（灰阶）
      const bucket = Math.floor(h / 30) * 30;
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  return { hueBuckets: sorted.map(([hue, count]) => ({ hue, count })), distinctHues: sorted.length };
}

// ---------------------------------------------------------------------------
// 反 slop 规则：默认审美就是这些，命中即报。
// ---------------------------------------------------------------------------

function collectAlignments(doc) {
  const map = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.id && (node.textAlign || node.align)) {
      map.set(node.id, { textAlign: node.textAlign, align: node.align });
    }
    for (const child of node.children || []) walk(child);
    for (const child of node.slots || []) walk(child);
    if (node.template) walk(node.template);
    for (const state of node.states || []) {
      if (state?.root) walk(state.root);
      for (const child of state?.children || []) walk(child);
    }
  };
  for (const page of doc?.pages || []) walk(page.root);
  return map;
}

function detectSlop(scenePage, nodes, byId, alignmentMap = new Map(), { hasDominantBlock = true, childOf = () => null } = {}) {
  const violations = [];
  const push = (rule, message, nodeIds, fix) => violations.push({ rule, message, nodeIds, fix, severity: 'error' });

  const boxes = nodes.filter(n => n.type === 'box' && n.visible !== false && Number.isFinite(n.w) && Number.isFinite(n.h));

  // 1) 等距三卡：三个同尺寸、同间距的兄弟卡片
  const siblingGroups = new Map();
  for (const node of boxes) {
    if (!node.parentId) continue;
    if (!siblingGroups.has(node.parentId)) siblingGroups.set(node.parentId, []);
    siblingGroups.get(node.parentId).push(node);
  }
  for (const [parentId, group] of siblingGroups) {
    if (group.length < 3) continue;
    const bySize = new Map();
    for (const node of group) {
      const key = `${Math.round(node.w)}x${Math.round(node.h)}`;
      if (node.w < 120 || node.h < 90) continue;
      bySize.set(key, [...(bySize.get(key) || []), node]);
    }
    for (const [, same] of bySize) {
      if (same.length < 3) continue;
      const xs = same.map(n => n.x).sort((a, b) => a - b);
      const gaps = xs.slice(1).map((x, i) => Math.round(x - (xs[i] + same[i].w)));
      const uniform = gaps.length >= 2 && gaps.every(g => Math.abs(g - gaps[0]) <= 2);
      if (uniform) {
        // 等距三卡是"信号"不是"罪证"：有主视觉时降级为提示，
        // 让使用者自己判断这是三栏索引还是偷懒的功能卡。
        const severity = hasDominantBlock ? 'warn' : 'error';
        push('equal-card-grid',
          `三个以上等尺寸卡片等距排列（${same.length} 个，间距 ${gaps[0]}px）`
            + (severity === 'error' ? '，且整页没有主次焦点' : '；页面已有主视觉，请确认这组卡是必要索引而非填版'),
          same.slice(0, 3).map(n => n.id),
          '改为 2:1 主次分割，或让其中一张承担主视觉（放大/换图/换色）');
        if (severity === 'warn') violations[violations.length - 1].severity = 'warn';
        break;
      }
    }
  }

  // 2) 紫色渐变：280±30 色相且带渐变
  const gradientNodes = nodes.filter(n => n.css && typeof n.css.background === 'string' && /gradient/i.test(n.css.background));
  for (const node of gradientNodes) {
    const hues = [...String(node.css.background).matchAll(/#([0-9a-f]{6})/gi)]
      .map(m => parseColor(`#${m[1]}`))
      .filter(Boolean)
      .map(c => hueOf(c))
      .filter(x => x.s > 0.25);
    const purpleish = hues.filter(x => x.h >= 250 && x.h <= 300);
    if (purpleish.length >= Math.max(2, Math.ceil(hues.length * 0.6))) {
      push('purple-gradient', '紫色系渐变是 2023–2025 年 AI 生成页面的最强指纹',
        [node.id], '换成一个有实义的素材或低饱和纯色块；需要强调就用明度对比而不是色相');
    }
  }

  // 3) 居中空洞大标题
  const vague = /^(让|我们|开启|拥抱|赋能|打造|构建|重新定义|解锁)/;
  const stockSuffix = /(平台|中枢|系统|引擎|生态|解决方案|新时代|新纪元|一站式|全链路|数智化)$/;
  for (const node of nodes) {
    if (typeof node.text !== 'string') continue;
    const text = node.text.trim();
    if (!text || text.length > 18) continue;
    const declared = alignmentMap.get(node.id) || {};
    const centered = node.textAlign === 'center' || node.align === 'center'
      || declared.textAlign === 'center' || declared.align === 'center';
    const big = (Number(node.fontSize) || 0) >= 28;
    const hollowBySuffix = stockSuffix.test(text) && !/\d/.test(text) && text.length <= 14;
    if (centered && big && (vague.test(text) || hollowBySuffix || /[，。！]$/.test(text))) {
      push('vague-centered-hero', `大号居中标题「${text}」信息量为零，只是排版占位`,
        [node.id], '换成具体的人/物/数字：写清"谁在什么场景得到什么"，而不是口号');
    }
  }

  // 4) 图标 + 圆角方块
  const roundedSquares = boxes.filter(n => {
    const r = Number(n.radius) || 0;
    const size = Math.min(Number(n.w) || 0, Number(n.h) || 0);
    return r >= 8 && r <= 20 && size >= 32 && size <= 64;
  });
  const iconHosts = roundedSquares.filter(sq => (sq.childrenIds || []).some(id => {
    const child = childOf(id);
    return child?.type === 'icon' || child?.type === 'image';
  }));
  if (iconHosts.length >= 3) {
    push('icon-in-rounded-square', `${iconHosts.length} 处"图标 + 圆角方块"装饰件，视觉上是同一招重复了 ${iconHosts.length} 次`,
      iconHosts.slice(0, 3).map(n => n.id), '最多保留 1 处；其余改用排版层级或留白分隔');
  }

  // 5) 首屏无实义素材
  const board = scenePage.board || {};
  const heroZone = nodes.filter(n => n.visible !== false && Number.isFinite(n.y) && n.y < (board.screenH || 0) * 0.45
    && Number.isFinite(n.w) && n.w >= (board.screenW || 0) * 0.5);
  const hasMedia = nodes.some(n => n.src && Number.isFinite(n.y) && n.y < (board.screenH || 0) * 0.45);
  const hasInteractive = nodes.some(n => ['input', 'button', 'repeater', 'data-table'].includes(n.type)
    || (n.type === 'box' && (n.childrenIds || []).length > 0 && Number(n.y) >= 0 && Number(n.y) < (board.screenH || 0) * 0.75 && n.type === 'box' && false));
  const hasForm = nodes.some(n => n.type === 'input' || n.type === 'button');
  if (heroZone.length && !hasMedia && !hasForm && !hasInteractive) {
    push('hero-without-media', '首屏上半没有真实素材，只有色块与文字',
      heroZone.slice(0, 2).map(n => n.id), '放一张真实照片/截图，或用排版把信息层级做足；不要用装饰渐变填空白');
    violations[violations.length - 1].severity = 'warn';
  }

  // 6) 圆角过度
  const overRounded = boxes.filter(n => (Number(n.radius) || 0) > 24 && (Number(n.w) || 0) > 200);
  if (overRounded.length >= 3) {
    push('over-rounded', `${overRounded.length} 个大容器圆角 >24px，整体会显得"糖果化"`,
      overRounded.slice(0, 3).map(n => n.id), '大容器圆角收到 8–16px，只让按钮/标签保留大圆角');
  }

  return violations;
}

// 固定清单：缺一项就必须显式报 not-assessable，不能从 checks 里蒸发。
const CHECK_MANIFEST = [
  'content-presence',
  'containment',
  'grid-alignment',
  'type-scale',
  'hue-discipline',
  'anti-slop',
  'visual-hierarchy',
  'primary-action-unique',
  'tap-target',
  'empty-state-coverage',
  'contrast',
];

const THRESHOLDS = {
  // 上限放宽到 2.5：40/16=2.5 是 landing page 的合法层级跳跃；真正要禁止的是"近乎重复的字号"。
  typeScale: { min: 1.2, max: 2.5, maxLevels: 4 },
  gridRatio: 0.9,
  // 编辑类页面靠留白呼吸，密集型工作台靠信息密度；用同一区间判断会误伤。
  whitespace: { min: 0.3, max: 0.45 },
  // 之前的 8–34% 是仪表盘口径，把编辑型页面全判成过密（试用者实测 44.8% 被警告）。
  whitespaceByDomain: { mobile: { min: 0.25, max: 0.6 }, web: { min: 0.08, max: 0.58 } },
  contrast: 4.5,
  distinctHues: 4,
  slopViolations: 0,
};

export function computeDesignMetrics(scenePage, { thresholds = THRESHOLDS, doc = null } = {}) {
  // 页面自己的 domain 优先：一个 mobile 工程里可以有 web 页，反过来同样成立。
  const domain = scenePage.domain || doc?.domain || 'mobile';
  const budget = {
    ...thresholds,
    whitespace: thresholds.whitespaceByDomain?.[domain] || thresholds.whitespace,
  };
  const { nodes, byId, childOf } = collectNodes(scenePage);
  const alignmentMap = collectAlignments(doc);
  const scale = typeScale(nodes);
  const grid = gridAlignment(nodes);
  const space = whitespaceRatio(nodes, scenePage.board);
  const contrast = contrastReport(nodes, byId);
  const hues = huePalette(nodes);
  const containment = containmentReport(scenePage, nodes, byId);
  const exportBudget = exportProjection(scenePage);
  const relations = relationChecks(scenePage, nodes, scenePage.domain || 'mobile', childOf);
  const hierarchy = visualHierarchy(scenePage, nodes, byId);
  const slop = detectSlop(scenePage, nodes, byId, alignmentMap, {
    hasDominantBlock: hierarchy ? (hierarchy.dominanceRatio >= 2.2 && !hierarchy.flat) : true,
    childOf,
  });
  const balance = compositionBalance(nodes, scenePage.board);

  const checks = [];
  const add = (key, ok, detail, extra = {}) => checks.push({ key, ok, detail, ...extra });
  add('content-presence', true, '页面有足够内容可供评估');
  const boardArea = (scenePage.board?.screenW || 0) * (scenePage.board?.screenH || 0);
  const contentNodes = nodes.filter(n => {
    if (n.visible === false) return false;
    const hasText = typeof n.text === 'string' && n.text.trim();
    if (hasText || n.src) return true;
    // 纯色块/卡片也是内容（卡片页往往没有文字节点），但整页底色不算。
    const area = (n.w || 0) * (n.h || 0);
    if (!area || (boardArea && area >= boardArea * 0.6)) return false;
    return !isTransparent(n.fill) || Number(n.radius) > 0;
  });
  const assessable = contentNodes.length >= 2;

  const scaleAssessable = scale.bodySizes.length >= 2;
  if (!scaleAssessable) {
    add('type-scale', false,
      `正文层级不足 2 级（body ${scale.bodySizes.join('/')}）——无法判断字阶，按未评估处理`,
      { notAssessable: true });
  } else {
    add('type-scale', scale.maxRatio <= budget.typeScale.max
      && scale.minRatio >= budget.typeScale.min && scale.levels <= budget.typeScale.maxLevels,
    `正文层级 ${scale.levels} 级，字阶比 ${scale.minRatio}–${scale.maxRatio}${scale.displaySizes?.length ? `；display ${scale.displaySizes.join('/')} 不计入` : ''}`);
  }
  const gridFix = grid.offenders?.length
    ? `；越界值：${grid.offenders.map(o => `${o.id}.${o.prop}=${o.value}→${o.nearest}`).join('，')}`
      + (grid.offendersTruncated ? `（共 ${grid.offenderCount} 个，仅列 ${grid.offenders.length}）` : '')
    : '';
  add('grid-alignment', grid.ratio !== null && grid.ratio >= budget.gridRatio,
    grid.ratio === null ? '无几何值'
      : `${grid.aligned}/${grid.total} 个尺寸落在 ${grid.grid}px 网格（${Math.round(grid.ratio * 100)}%）${gridFix}`);
  // 留白区间过宽到"两边都装得下"就不再是判据；改为提示，真正的关系判断交给
  // composition-balance（死区）与 visual-hierarchy（主次比）。
  const whitespaceWarnings = [];
  if (space && (space.whitespaceRatio < budget.whitespace.min || space.whitespaceRatio > budget.whitespace.max)) {
    whitespaceWarnings.push({
      check: 'whitespace',
      detail: `留白占比 ${(space.whitespaceRatio * 100).toFixed(1)}%（${domain} 参考 ${Math.round(budget.whitespace.min * 100)}–${Math.round(budget.whitespace.max * 100)}%）`,
      fix: '先看构图是否偏一侧；只有"空白分布在四周"时才值得调密度',
    });
  }
  // 对比度是可访问性硬指标：1:1 的文字不能算"合格"。
  // 拿不到底色的样本已被排除，剩下的都是可判断的。
  if (contrast.checked > 0 || (contrast.unknown || 0) > 0) {
    const ok = contrast.failing === 0 && (contrast.unknown || 0) === 0;
    add('contrast', ok,
      ok
        ? `${contrast.checked} 处文本对比度均达标（最低 ${contrast.minRatio}）`
        : [
          contrast.failing ? `${contrast.failing}/${contrast.checked} 处对比度不足（最低 ${contrast.minRatio}）` : '',
          contrast.unknown ? `${contrast.unknown} 处文字压在图片/渐变上，无法确认对比度（${(contrast.unknownNodes || []).slice(0, 3).join('，')}）` : '',
        ].filter(Boolean).join('；'));
  } else {
    // 底色不可知不等于没问题：白字压在照片上就是这类。
    // 按"不可评估 = 不通过"处理，否则任何图片上的文字都会自动通过。
    add('contrast', false, '文本底色不可解析，无法确认对比度——按未评估处理（不可评估 = 不通过）', { notAssessable: true });
  }

  const contrastWarnings = [...whitespaceWarnings];
  const budgetLines = [];
  if (exportBudget.rasterized) {
    budgetLines.push(`${exportBudget.rasterized} 个元素的效果会以栅格装饰层进入 .rp（文字仍可编辑）`);
  }
  if (exportBudget.uncertain) {
    const ids = exportBudget.items.filter(i => i.verdict === 'uncertain').slice(0, 3).map(i => `${i.id}:${i.features.join('/')}`).join('，');
    budgetLines.push(`${exportBudget.uncertain} 个元素用了去向不确定的效果（${ids}）——可能栅格化，也可能被省略`);
  }
  if (exportBudget.unsupported) {
    const ids = exportBudget.items.filter(i => i.verdict === 'unsupported').slice(0, 3).map(i => `${i.id}:${i.features.join('/')}`).join('，');
    budgetLines.push(`${exportBudget.unsupported} 个元素的效果导出时不支持（${ids}）`);
  }
  if (budgetLines.length) {
    contrastWarnings.push({
      check: 'export-budget',
      detail: budgetLines.join('；'),
      fix: '交付前跑一次 studio_export_rp 核对报告；要稳就改成纯色/渐变背景',
    });
  }
  if (balance?.deadRight) {
    contrastWarnings.push({
      check: 'composition-balance',
      detail: `内容集中在左 ${Math.round(balance.sharesByThird[0] * 100)}%，右侧三分之一仅 ${Math.round(balance.sharesByThird[2] * 100)}%——右半屏是死区`,
      fix: '把表单/主图放到右列形成 2:1 或 1:1 双栏；或整体收窄画板宽度，不要让空白只落在一侧',
    });
  }

  add('hue-discipline', hues.distinctHues <= budget.distinctHues,
    `主色相 ${hues.distinctHues} 类${hues.distinctHues ? `（${hues.hueBuckets.slice(0, 4).map(b => `${b.hue}°`).join(', ')}）` : ''}`);
  const slopErrors = slop.filter(v => v.severity !== 'warn');
  add('containment', containment.total === 0,
    containment.total === 0
      ? '所有元素都在画板内且文字不溢出容器'
      : [
        containment.outside.length ? `越出画板 ${containment.outside.length} 个：${containment.outside.slice(0, 4).map(o => `${o.id}(${Object.entries(o.over).filter(([, v]) => v > 0).map(([k, v]) => `${k}+${v}`).join('/')})`).join('，')}` : '',
        containment.textOverflow.length ? `文字溢出容器 ${containment.textOverflow.length} 个：${containment.textOverflow.slice(0, 4).map(o => `${o.id}@${o.parentId}`).join('，')}` : '',
        containment.total > 8 ? `（共 ${containment.total} 个，仅列 8）` : '',
      ].filter(Boolean).join('；'));

  for (const relation of relations) {
    add(relation.key, relation.advisory ? true : relation.ok, relation.detail);
  }

  add('anti-slop', slopErrors.length === 0,
    slopErrors.length ? `命中 ${slopErrors.length} 条反 slop 规则`
      : (slop.length
        ? (hierarchy ? `仅有 ${slop.length} 条提示级样式（已确认主次，不判不合格）` : `仅有 ${slop.length} 条提示级样式（页面块数不足，无法确认主次）`)
        : '未命中反 slop 规则'));
  if (!hierarchy) {
    add('visual-hierarchy', false, '可见内容块不足 3 个——无法判断主次，按未评估处理', { notAssessable: true });
  } else {
    add('visual-hierarchy',
      hierarchy.dominanceRatio >= 2.2 && !hierarchy.flat && !hierarchy.overDominant
        && (hierarchy.stretchedText || []).length === 0,
      `主次比 ${hierarchy.dominanceRatio}×（门槛 2.2×${hierarchy.overDominant ? '，上限 8×' : ''}）`
        + `${hierarchy.flat ? '；前三块质量接近，视线没有落点' : ''}`
        + `${hierarchy.overDominant ? '；主块过大，其余内容沦为注脚——这不是主次，是失衡' : ''}`
        + `${(hierarchy.stretchedText || []).length ? `；${hierarchy.stretchedText.length} 个文字框被撑高（${hierarchy.stretchedText.slice(0, 2).map(t => `${t.id} 框高 ${t.boxH} vs 文字 ${t.contentH}`).join('，')}）——撑高不等于更重要` : ''}`
        + `；前三块：${hierarchy.topThree.map(t => `${t.id}=${t.mass}`).join(', ')}`);
  }

  // 固定清单对账：清单里有、checks 里没有的，一律补成显式 not-assessable。
  const present = new Set(checks.map(c => c.key));
  const missing = CHECK_MANIFEST.filter(key => !present.has(key));
  for (const key of missing) {
    checks.push({ key, ok: false, notAssessable: true, detail: '检查未运行（条件不满足），按未评估处理' });
  }
  const counted = checks.filter(c => !c.skipped);
  const passed = counted.filter(c => c.ok).length;
  if (!assessable) {
    // 空画板不该拿"全过"。没有内容就没有设计可评。
    return {
      pageId: scenePage.id,
      assessable: false,
      metrics: { compositionBalance: balance, visualHierarchy: hierarchy, containment, exportBudget, typeScale: scale, gridAlignment: grid, whitespace: space, contrast, palette: hues },
      thresholds,
      checks: CHECK_MANIFEST.map(key => (key === 'content-presence'
        ? { key, ok: false, detail: `页面只有 ${contentNodes.length} 个内容节点（文字/图片），不足以评估设计` }
        : { key, ok: false, notAssessable: true, detail: '内容不足，本项未评估' })),
      warnings: exportBudget.decorations
        ? [{
          check: 'export-budget',
          detail: `装饰层：栅格化 ${exportBudget.rasterized}、不确定 ${exportBudget.uncertain}、不支持 ${exportBudget.unsupported}`,
          fix: '真实结论以 studio_export_rp 报告为准',
        }]
        : [],
      violations: [{ check: 'content-presence', detail: '空页面没有可评估的设计；先放内容再谈指标' }],
      slop: [],
      l1: {
        ok: false,
        verdict: 'not-assessable',
        expected: CHECK_MANIFEST.length,
        counted: CHECK_MANIFEST.length,
        notAssessed: CHECK_MANIFEST.filter(key => key !== 'content-presence'),
        missingChecks: [],
        skipped: [],
        blocking: [
          { check: 'content-presence', fix: '先放标题/正文/图片，再跑度量' },
          ...CHECK_MANIFEST.filter(key => key !== 'content-presence').map(key => ({ check: key, fix: '内容不足，本项未评估' })),
        ],
      },
    };
  }
  return {
    assessable: true,
    pageId: scenePage.id,
    metrics: {
      compositionBalance: balance,
      visualHierarchy: hierarchy,
      containment,
      exportBudget,
      relations,
      typeScale: scale,
      gridAlignment: grid,
      whitespace: space,
      contrast,
      palette: hues,
    },
    thresholds,
    checks,
    warnings: contrastWarnings,
    violations: checks.filter(c => !c.ok).map(c => ({ check: c.key, detail: c.detail })),
    slop,
    l1: {
      // 不输出 passed/total：把它拆成可逐个优化的格子，正是 reward hacking 的理想形状。
      // 只给状态与"必须处理的具体证据"。
      ok: passed === counted.length,
      verdict: passed === counted.length ? 'meets-l1-bar' : 'below-l1-bar',
      counted: counted.length,
      expected: CHECK_MANIFEST.length,
      notAssessed: counted.filter(c => c.notAssessable).map(c => c.key),
      missingChecks: missing,
      skipped: checks.filter(c => c.skipped).map(c => c.key),
      blocking: counted.filter(c => !c.ok).map(c => ({ check: c.key, fix: c.detail })),
    },
  };
}

export function summarizeMetrics(result) {
  const advisoryCount = (result.warnings || []).length;
  const head = advisoryCount
    ? `页面 ${result.pageId}：${result.l1.verdict}（另有 ${advisoryCount} 条提示，不参与判定）`
    : `页面 ${result.pageId}：${result.l1.verdict}`;
  const lines = [head];
  for (const check of result.checks) {
    lines.push(`  ${check.ok ? '✓' : '✗'} ${check.key}: ${check.detail}`);
  }
  const budget = result.metrics?.exportBudget;
  if (budget && budget.total) {
    lines.push(`  导出预算：${budget.nativeBase} 个节点均可编辑；装饰层 栅格化 ${budget.rasterized}、不确定 ${budget.uncertain}、不支持 ${budget.unsupported}`);
  }
  for (const w of result.warnings || []) {
    lines.push(`  ⚠ ${w.check}: ${w.detail}${w.fix ? `\n     → ${w.fix}` : ''}`);
  }
  for (const v of result.slop || []) {
    lines.push(`  ${v.severity === 'warn' ? 'ℹ' : '⚠'} ${v.rule}: ${v.message}\n     → ${v.fix}（${v.nodeIds.join(', ')}）`);
  }
  return lines.join('\n');
}

export { THRESHOLDS, contrastRatio, parseColor };
