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
  if (node.gradient) {
    const gradient = gradientCss(node.gradient);
    if (gradient) backgrounds.push(gradient);
  }
  if (backgrounds.length) css['background-image'] = backgrounds.join(',');
  if (node.backdropBlur) css['backdrop-filter'] = `blur(${Number(node.backdropBlur) || 12}px)`;
  if (node.shadow) css['box-shadow'] = typeof node.shadow === 'string' ? node.shadow : '0 8px 24px #14231D1A';
  if (typeof node.customFilter === 'string') css.filter = node.customFilter;
  if (typeof node.threeDTransform === 'string') css.transform = node.threeDTransform;
  return { ...css, ...normalizeVisualCss(node.css) };
}

// Export can bake paint-only properties into a separate decoration bitmap.
// Text/group transformations cannot be baked without losing native editability.
const PAINT_CSS = /^(?:--.+|background(?:-.+)?|border(?:-.+)?|outline(?:-.+)?|box-shadow|clip-path|(?:-webkit-)?mask(?:-.+)?|backdrop-filter)$/;

export function exportCssPlan(node) {
  const declarations = visualCss(node);
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
