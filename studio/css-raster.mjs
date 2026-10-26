import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './cdp.mjs';
import { exportCssPlan } from './visual-style.mjs';

function localCssAssets(value, projectDir) {
  return value.replace(/url\(["']?(\/?assets\/[^"')]+)["']?\)/g, (match, asset) => {
    const path = projectDir && join(projectDir, decodeURIComponent(asset.replace(/^\//, '')));
    if (!path || !existsSync(path)) throw Object.assign(new Error(`CSS 素材不存在: ${asset}`), { code: 'E_CSS_ASSET' });
    const mime = /\.svg$/i.test(path) ? 'image/svg+xml' : /\.webp$/i.test(path) ? 'image/webp' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';
    return `url("data:${mime};base64,${readFileSync(path).toString('base64')}")`;
  });
}

// Render only an empty decoration surface: never a page, text or child controls.
export async function rasterizeStudioPaint(pages, { workDir, projectDir, colors = {} }) {
  const surfaces = [];
  function visit(node) {
    if (!node) return;
    const plan = exportCssPlan(node);
    if (plan.hasPaint) surfaces.push({ node, plan });
    for (const ch of node.children || []) visit(ch);
    for (const st of node.states || []) visit(st.root);
    if (node.template) visit(node.template);
  }
  for (const page of pages) visit(page.rootTree);
  if (!surfaces.length) return [];
  const chrome = await launchChrome({ width: 1200, height: 1000, dpr: 1 });
  const assets = [];
  const cache = new Map();
  try {
    const page = await chrome.openPage();
    for (const { node, plan } of surfaces) {
      const width = Math.max(1, Math.round(node._w));
      const height = Math.max(1, Math.round(node._h));
      const css = Object.fromEntries(Object.entries(plan.paint).map(([key, value]) => [key, localCssAssets(value, projectDir)]));
      const surface = { width, height, fill: node._resolvedFill || node.fill || 'transparent', radius: node.radius || 0, stroke: node._resolvedStroke || 'transparent', strokeWidth: node.strokeWidth ?? (node._resolvedStroke ? 1 : 0), css, colors };
      const key = createHash('sha256').update(JSON.stringify(surface)).digest('hex');
      if (!cache.has(key)) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: Math.max(100, width), height: Math.max(100, height), deviceScaleFactor: 1, mobile: false });
        await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        await page.evaluate(`(async () => {
          const s = ${JSON.stringify(surface)};
          document.documentElement.style.cssText = 'background:transparent';
          document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
          document.body.replaceChildren();
          const el = document.createElement('div');
          el.style.cssText = 'box-sizing:border-box;position:absolute;left:0;top:0';
          el.style.width = s.width + 'px'; el.style.height = s.height + 'px';
          el.style.background = s.fill; el.style.borderRadius = s.radius + 'px';
          el.style.border = s.strokeWidth + 'px solid ' + s.stroke;
          for (const [key, value] of Object.entries(s.colors)) el.style.setProperty('--' + key, value);
          for (const [key, value] of Object.entries(s.css)) {
            if (!key.startsWith('--') && !CSS.supports(key, value)) throw new Error('Unsupported CSS: ' + key + ': ' + value);
            el.style.setProperty(key, value);
          }
          document.body.append(el);
          const urls = [...Object.values(s.css).join(' ').matchAll(/url\\(["']?([^"')]+)["']?\\)/g)].map(m => m[1]);
          await Promise.all(urls.map(src => new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = () => reject(new Error('CSS image failed to load')); img.src = src; })));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        const png = await page.screenshot({ clip: { x: 0, y: 0, w: width, h: height }, captureBeyondViewport: true });
        const src = `assets/css-effect-${key.slice(0, 16)}.png`;
        mkdirSync(join(workDir, 'assets'), { recursive: true });
        writeFileSync(join(workDir, src), png);
        const asset = { src, sha256: createHash('sha256').update(png).digest('hex'), width, height, paintOnly: true, clippedToNodeBounds: true };
        cache.set(key, asset);
        assets.push(asset);
      }
      node._cssPaintAsset = cache.get(key);
    }
    return assets;
  } finally {
    await chrome.close();
  }
}
