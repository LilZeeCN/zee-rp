// Browser paint is independent of the Axure export vocabulary. Geometry remains
// in the semantic layout model so dragging, history and export share one box.
const LAYOUT_CSS = /^(?:all|position|inset(?:-.+)?|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height|margin(?:-.+)?|padding(?:-.+)?|display|box-sizing|flex(?:-.+)?|grid(?:-.+)?|gap|row-gap|column-gap|order|align-.+|justify-.+|font(?:-.+)?|line-height|letter-spacing)$/;

export function cssPropertyName(key) {
  if (key.startsWith('--')) return key;
  return key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).replace(/^webkit-/, '-webkit-');
}

export function normalizeVisualCss(css) {
  if (css == null) return {};
  if (typeof css !== 'object' || Array.isArray(css)) {
    throw Object.assign(new Error('css 必须是 CSS 属性和值组成的对象'), { code: 'E_CSS_VALUE', field: 'css' });
  }
  const out = {};
  for (const [key, value] of Object.entries(css)) {
    const property = cssPropertyName(key);
    if (!/^(?:--[\w-]+|-?[a-z][a-z0-9-]*)$/.test(property)) {
      throw Object.assign(new Error(`无效 CSS 属性: ${key}`), { code: 'E_CSS_PROPERTY', field: `css.${key}` });
    }
    if (LAYOUT_CSS.test(property)) {
      throw Object.assign(new Error(`${key} 由画布的尺寸、布局或排版属性管理，请在对应属性中修改；css 用于浏览器视觉效果`), { code: 'E_CSS_LAYOUT_PROPERTY', field: `css.${key}` });
    }
    if (value == null) continue;
    if (!['string', 'number'].includes(typeof value)) {
      throw Object.assign(new Error(`CSS ${key} 的值必须是文字或数值`), { code: 'E_CSS_VALUE', field: `css.${key}` });
    }
    out[property] = String(value);
  }
  return out;
}

function gradientCss(value) {
  if (typeof value === 'string') {
    return /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(value.trim()) ? value : `linear-gradient(${value})`;
  }
  if (!value || typeof value !== 'object') return null;
  const stops = (value.stops || value.colors || []).map(stop => {
    if (typeof stop === 'string') return stop;
    const pos = stop.position ?? (typeof stop.offset === 'number' ? `${stop.offset * 100}%` : '');
    return `${stop.color} ${pos}`.trim();
  });
  if (stops.length < 2) return null;
  if (value.type === 'radial') return `radial-gradient(${value.at || 'ellipse at center'}, ${stops.join(',')})`;
  if (value.type === 'conic') return `conic-gradient(from ${Number(value.angle || 0)}deg, ${stops.join(',')})`;
  return `linear-gradient(${Number(value.angle ?? 135)}deg, ${stops.join(',')})`;
}

export const SHADOW_PRESETS = Object.freeze({
  none: '',
  xs: '0 1px 2px rgba(15, 23, 42, 0.06)',
  sm: '0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)',
  md: '0 8px 24px rgba(15, 23, 42, 0.12)',
  lg: '0 16px 36px rgba(15, 23, 42, 0.16)',
  xl: '0 24px 48px rgba(15, 23, 42, 0.20)',
  '2xl': '0 32px 64px rgba(15, 23, 42, 0.24)',
  inner: 'inset 0 2px 4px rgba(15, 23, 42, 0.08)',
});

const CSS_BOX_SHADOW_LENGTH_RE = /(?:^|[\s,])(?:inset\s+)?-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|vh|vw|vmin|vmax|pt|pc|cm|mm|in|%)?\s+-?(?:\d+\.?\d*|\.\d+)/i;

export function resolveShadowCss(val, shadowTokens = null) {
  if (val === null || val === undefined || val === false) return '';
  if (val === true) return '0 8px 24px #14231D1A';
  if (typeof val === 'object' && !Array.isArray(val)) {
    const x = Number(val.x ?? 0);
    const y = Number(val.y ?? 4);
    const blur = Number(val.blur ?? 12);
    const spread = val.spread !== undefined ? `${Number(val.spread)}px ` : '';
    const color = val.color || 'rgba(15, 23, 42, 0.12)';
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(blur)) return null;
    return `${val.inset ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}${color}`;
  }
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (Object.hasOwn(SHADOW_PRESETS, lower)) return SHADOW_PRESETS[lower];
  if (trimmed.startsWith('$') && shadowTokens && typeof shadowTokens === 'object') {
    const key = trimmed.slice(1);
    if (Object.hasOwn(shadowTokens, key)) return resolveShadowCss(shadowTokens[key], null);
  }
  if (shadowTokens && typeof shadowTokens === 'object' && Object.hasOwn(shadowTokens, trimmed)) {
    return resolveShadowCss(shadowTokens[trimmed], null);
  }
  if (CSS_BOX_SHADOW_LENGTH_RE.test(trimmed)) return trimmed;
  return null;
}

const BORDER_STYLE_KEYWORDS = new Set(['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset']);
const BORDER_WIDTH_KEYWORDS = { thin: 1, medium: 2, thick: 3 };

export function parseCssBorderShorthand(val) {
  if (typeof val === 'boolean') return { valid: true, enabled: val };
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val < 0) return { valid: false };
    return { valid: true, enabled: val > 0, width: val };
  }
  if (typeof val !== 'string') return { valid: false };
  const s = val.trim();
  if (!s || /^(?:none|hidden|0(?:px)?)$/i.test(s)) {
    return { valid: true, enabled: false, width: 0, style: 'none' };
  }
  let rest = s;
  let color = null;
  const fnColorMatch = rest.match(/(?:rgba?|hsla?|var)\([^)]+\)/i);
  if (fnColorMatch) {
    color = fnColorMatch[0].trim();
    rest = `${rest.slice(0, fnColorMatch.index)} ${rest.slice(fnColorMatch.index + fnColorMatch[0].length)}`;
  }
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  let width = null;
  let style = null;
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (width === null && /^(?:\d+\.?\d*|\.\d+)(?:px)?$/i.test(tok)) {
      width = parseFloat(tok);
      continue;
    }
    if (width === null && Object.hasOwn(BORDER_WIDTH_KEYWORDS, low)) {
      width = BORDER_WIDTH_KEYWORDS[low];
      continue;
    }
    if (style === null && BORDER_STYLE_KEYWORDS.has(low)) {
      style = low;
      continue;
    }
    if (color === null && (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(tok) || tok.startsWith('$') || low === 'transparent' || low === 'currentcolor')) {
      color = tok;
      continue;
    }
    return { valid: false };
  }
  if (width === null && style === null && color === null) return { valid: false };
  const effWidth = width ?? 1;
  const effStyle = style || 'solid';
  const enabled = effWidth > 0 && effStyle !== 'none' && effStyle !== 'hidden' && String(color || '').toLowerCase() !== 'transparent';
  return {
    valid: true,
    enabled,
    width: effWidth,
    style: effStyle,
    ...(color ? { color } : {}),
  };
}

export function textLayout(node) {
  const control = node.type === 'button' || node.type === 'badge';
  const align = node.textAlign || node.align || node._inheritedAlign || (control ? 'center' : 'left');
  const textAlign = align === 'start' ? 'left' : align === 'end' ? 'right' : align;
  const multiLine = (node.lineCount ?? node._textMetrics?.lineCount ?? 1) > 1;
  const wrap = node.type === 'paragraph' || (!control && (node.wrap === true || multiLine));
  return { textAlign, verticalAlign: wrap ? 'top' : 'middle', wrap };
}

export function textSpanCss(span, fontStack = 'sans-serif') {
  const css = {};
  if (span.fontFamily) css['font-family'] = `${JSON.stringify(span.fontFamily)}, ${fontStack}`;
  if (span.fontSize) css['font-size'] = `${Number(span.fontSize)}px`;
  if (span.fontWeight) css['font-weight'] = String(span.fontWeight);
  if (span.letterSpacing !== undefined) css['letter-spacing'] = `${Number(span.letterSpacing)}px`;
  if (span.color) css.color = span.color;
  if (span.italic) css['font-style'] = 'italic';
  const decoration = [span.underline && 'underline', span.strikethrough && 'line-through'].filter(Boolean).join(' ');
  if (decoration) css['text-decoration'] = decoration;
  return css;
}

export function visualCss(node) {
  const css = {};
  const backgrounds = [];
  if (node.noise) {
    const alpha = Math.min(1, Math.max(0, Number(node.noise)));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="3" stitchTiles="stitch" seed="7"/></filter><rect width="100%" height="100%" opacity="${alpha}" filter="url(#n)"/></svg>`;
    backgrounds.push(`url("data:image/svg+xml,${encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')}")`);
  }
  if (node.aurora) {
    backgrounds.push('radial-gradient(ellipse at 15% 20%, #A274E880, transparent 65%)', 'radial-gradient(ellipse at 85% 75%, #43E4C580, transparent 65%)');
  }
  if (Array.isArray(node.fills)) for (const f of node.fills) {
    if (typeof f === 'string' && f.trim()) {
      const layer = f.trim();
      const isImage = /^(?:none$|(?:[a-z-]*gradient|url|image(?:-set)?|cross-fade|element|paint)\()/i.test(layer);
      backgrounds.push(isImage ? layer : `linear-gradient(${layer},${layer})`);
    } else if (f && typeof f === 'object') {
      const gc = gradientCss(f);
      if (gc) backgrounds.push(gc);
    }
  }
  if (node.gradient) {
    const gradient = gradientCss(node.gradient);
    if (gradient) backgrounds.push(gradient);
  }
  if (backgrounds.length) css['background-image'] = backgrounds.join(',');
  if (node.backdropBlur) css['backdrop-filter'] = `blur(${Number(node.backdropBlur) || 12}px)`;
  const shadows = [];
  const primaryShadow = resolveShadowCss(node._resolvedShadow ?? node.shadow);
  if (primaryShadow) shadows.push(primaryShadow);
  if (node.innerGlow) {
    const glow = typeof node.innerGlow === 'string' ? node.innerGlow : '#FFFFFF66';
    shadows.push(glow.includes('inset') ? glow : `inset 0 0 12px ${glow}`);
  }
  if (Array.isArray(node.shadows)) for (const s of node.shadows) {
    const resolvedItem = resolveShadowCss(s);
    if (resolvedItem) shadows.push(resolvedItem);
    else if (typeof s === 'string' && s.trim() && s.trim().toLowerCase() !== 'none') shadows.push(s.trim());
  }
  if (shadows.length) css['box-shadow'] = shadows.join(',');
  if (node.mixBlendMode) css['mix-blend-mode'] = String(node.mixBlendMode);
  if (typeof node.customFilter === 'string' && node.customFilter.trim()) css.filter = node.customFilter;
  const parts = [];
  if (typeof node.threeDTransform === 'string' && node.threeDTransform.trim()) parts.push(node.threeDTransform.trim());
  // 2D 旋转是原生可编辑属性（.rp MyStyle DOA 3221225522），画布/运行态与原生导出共用 node.rotation。
  if (typeof node.rotation === 'number' && Number.isFinite(node.rotation) && node.rotation % 360 !== 0) parts.push(`rotate(${node.rotation}deg)`);
  if (parts.length) css.transform = parts.join(' ');
  return { ...css, ...normalizeVisualCss(node.css) };
}

// Export can bake paint-only properties into a separate decoration bitmap.
// Text/group transformations cannot be baked without losing native editability.
const PAINT_CSS = /^(?:--.+|background(?:-.+)?|border(?:-.+)?|outline(?:-.+)?|box-shadow|clip-path|(?:-webkit-)?mask(?:-.+)?|backdrop-filter)$/;

export function exportCssPlan(node) {
  const declarations = visualCss(node);
  // 纯 2D 旋转走原生 .rp MyStyle DOA 3221225522（可编辑），不算 unsupported/rasterized；
  // threeDTransform 或复合 transform 维持旧的光栅化路径。
  const hasThreeD = typeof node.threeDTransform === 'string' && node.threeDTransform.trim();
  if (!hasThreeD && typeof node.rotation === 'number' && Number.isFinite(node.rotation)) delete declarations.transform;
  const paint = {};
  const unsupported = [];
  const textClip = [declarations['background-clip'], declarations['-webkit-background-clip']].includes('text');
  const hasContent = ['label', 'paragraph', 'button', 'input', 'image', 'icon'].includes(node.type)
    || Boolean(node.text || node.children?.length || node.states?.length || node.template);
  for (const [key, value] of Object.entries(declarations)) {
    const clipsContent = hasContent && /^(?:clip-path|(?:-webkit-)?mask(?:-.+)?)$/.test(key);
    if ((PAINT_CSS.test(key) || (key === 'filter' && !hasContent)) && !textClip && !clipsContent) paint[key] = value;
    else if (!key.startsWith('--')) unsupported.push(key);
  }
  // Backdrop filtering needs the live scene behind the node, not an isolated tile.
  if (paint['backdrop-filter']) {
    delete paint['backdrop-filter'];
    unsupported.push('backdrop-filter');
  }
  return { paint, unsupported, textClip, hasPaint: Object.keys(paint).some(k => !k.startsWith('--')) };
}
