import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNotProtected, resolveWorkDir } from './engine.mjs';
import { spawnPythonSync } from './python.mjs';
import { findChromeExecutable, launchChrome } from '../studio/cdp.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export function isHtmlInput(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('\n')) return false;
  if (/^(?:https?|file):\/\//i.test(trimmed)) return true;
  return /\.html?(?:[?#].*)?$/i.test(trimmed);
}

function startLocalHtmlServer(rootDir) {
  const realRoot = realpathSync(rootDir);
  return createServer((req, res) => {
    try {
      const reqPath = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
      const relPath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
      const full = realpathSync(resolve(realRoot, relPath));
      if (!full.startsWith(realRoot + sep) && full !== realRoot) {
        res.writeHead(404).end();
        return;
      }
      if (!statSync(full).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', MIME_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream');
      createReadStream(full).on('error', () => res.destroy()).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
}

function rgbToHex(cssColor) {
  if (typeof cssColor !== 'string') return null;
  const trimmed = cssColor.trim();
  if (trimmed.startsWith('#')) {
    return trimmed.length === 4
      ? `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toUpperCase()
      : trimmed.slice(0, 7).toUpperCase();
  }
  const m = trimmed.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  if (alpha < 0.04) return null;
  const hex = [m[1], m[2], m[3]].map(v => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, '0')).join('').toUpperCase();
  if (alpha < 0.99) {
    const aHex = Math.max(1, Math.min(255, Math.round(alpha * 255))).toString(16).padStart(2, '0').toUpperCase();
    return `#${hex}${aHex}`;
  }
  return `#${hex}`;
}

async function extractInBrowserDom() {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'SOURCE', 'TRACK']);
    const INLINE_TEXT_ONLY = new Set(['SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'SMALL', 'CODE', 'MARK', 'ABBR', 'TIME', 'SUP', 'SUB']);
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;

    const toHex = c => {
      if (!c) return null;
      const m = c.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
      if (!m) return c.startsWith('#') ? c : null;
      const a = m[4] === undefined ? 1 : Number(m[4]);
      if (a < 0.04) return null;
      const h = [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')).join('').toUpperCase();
      if (a < 0.99) return '#' + h + Math.max(1, Math.min(255, Math.round(a * 255))).toString(16).padStart(2, '0').toUpperCase();
      return '#' + h;
    };

    const imgToDataUrl = async el => {
      try {
        const w = Math.max(1, Math.round(el.getBoundingClientRect().width || el.naturalWidth || 100));
        const h = Math.max(1, Math.round(el.getBoundingClientRect().height || el.naturalHeight || 100));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(el, 0, 0, w, h);
        return c.toDataURL('image/png');
      } catch {
        return null;
      }
    };

    const svgToDataUrl = async svgEl => {
      try {
        const r = svgEl.getBoundingClientRect();
        const w = Math.max(2, Math.round(r.width));
        const h = Math.max(2, Math.round(r.height));
        const clone = svgEl.cloneNode(true);
        if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width', String(w));
        clone.setAttribute('height', String(h));
        const xml = new XMLSerializer().serializeToString(clone);
        const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
        const img = new Image();
        await new Promise((resolveImg, rejectImg) => {
          img.onload = resolveImg;
          img.onerror = rejectImg;
          img.src = svgUrl;
        });
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        return c.toDataURL('image/png');
      } catch {
        return null;
      }
    };

    let count = 0;
    const MAX_NODES = 420;
    const labelTextForControl = el => {
      if (el.labels && el.labels.length > 0) return (el.labels[0].textContent || '').trim();
      const parentLabel = el.closest('label');
      if (parentLabel) return (parentLabel.textContent || '').trim();
      const sib = el.nextElementSibling;
      if (sib && (sib.tagName === 'LABEL' || sib.tagName === 'SPAN')) return (sib.textContent || '').trim();
      return '';
    };

    const onlyInlineChildren = el => {
      if (el.children.length === 0) return true;
      return Array.from(el.children).every(ch => INLINE_TEXT_ONLY.has((ch.tagName || '').toUpperCase()) && ch.children.length === 0);
    };

    const parseRadius = cs => {
      const vals = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
        .map(v => parseFloat(v) || 0);
      const maxR = Math.max(...vals);
      return maxR > 0 ? Math.round(maxR) : undefined;
    };

    const extractBorders = cs => {
      const sides = [
        ['top', parseFloat(cs.borderTopWidth) || 0, toHex(cs.borderTopColor)],
        ['right', parseFloat(cs.borderRightWidth) || 0, toHex(cs.borderRightColor)],
        ['bottom', parseFloat(cs.borderBottomWidth) || 0, toHex(cs.borderBottomColor)],
        ['left', parseFloat(cs.borderLeftWidth) || 0, toHex(cs.borderLeftColor)],
      ].filter(([, w, col]) => w > 0 && col);
      if (!sides.length) return {};
      if (sides.length === 4 && sides.every(s => Math.abs(s[1] - sides[0][1]) < 0.6 && s[2] === sides[0][2])) {
        return { stroke: sides[0][2], strokeWidth: Math.max(1, Math.round(sides[0][1])) };
      }
      return {
        stroke: sides[0][2],
        strokeWidth: Math.max(1, Math.round(sides[0][1])),
        borderSides: sides.map(s => s[0]).join(' '),
      };
    };

    const walk = async (el, depth) => {
      if (!el || depth > 16 || count >= MAX_NODES) return null;
      const tag = (el.tagName || '').toUpperCase();
      if (SKIP.has(tag)) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;

      count++;
      const absX = Math.round(rect.left + sx);
      const absY = Math.round(rect.top + sy);
      const w = Math.max(2, Math.round(rect.width));
      const h = Math.max(2, Math.round(rect.height));

      const bgImg = cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.includes('gradient')
        ? cs.backgroundImage
        : null;
      const fill = bgImg || toHex(cs.backgroundColor);
      const radius = parseRadius(cs);
      const borders = extractBorders(cs);
      const shadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : undefined;
      const opacity = parseFloat(cs.opacity) < 0.99 ? Number(parseFloat(cs.opacity).toFixed(2)) : undefined;
      const color = toHex(cs.color);
      const fontSize = Math.max(10, Math.round(parseFloat(cs.fontSize) || 14));
      const rawWeight = parseInt(cs.fontWeight, 10);
      const fontWeight = Number.isFinite(rawWeight) ? rawWeight : 400;
      const rawLh = parseFloat(cs.lineHeight);
      const lineHeight = Number.isFinite(rawLh) && rawLh > 0 ? Math.round(rawLh) : undefined;
      const textAlign = ['center', 'right', 'left'].includes(cs.textAlign) ? cs.textAlign : undefined;
      const fontFamily = (cs.fontFamily || '').split(',')[0]?.replace(/["']/g, '').trim() || undefined;

      const base = {
        domId: el.id || null,
        tag,
        absX,
        absY,
        w,
        h,
        ...(fill ? { fill } : {}),
        ...(radius !== undefined ? { radius } : {}),
        ...borders,
        ...(shadow ? { shadow } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
      };

      if (tag === 'HR') {
        return { ...base, kind: 'divider', color: borders.stroke || fill || '#CBD5E1' };
      }
      if (tag === 'IMG') {
        const dataUrl = await imgToDataUrl(el);
        return { ...base, kind: 'image', dataUrl, alt: el.alt || '' };
      }
      if (tag === 'SVG') {
        const dataUrl = await svgToDataUrl(el);
        return { ...base, kind: 'image', dataUrl, isSvg: true };
      }
      if (tag === 'INPUT') {
        const itype = (el.type || 'text').toLowerCase();
        if (itype === 'hidden') return null;
        if (itype === 'checkbox' || itype === 'radio') {
          const text = labelTextForControl(el) || (itype === 'checkbox' ? '复选框' : '单选项');
          const labelEl = (el.labels && el.labels[0]) || el.closest('label')
            || (el.nextElementSibling && (el.nextElementSibling.tagName === 'LABEL' || el.nextElementSibling.tagName === 'SPAN') ? el.nextElementSibling : null);
          const labelBox = labelEl ? labelEl.getBoundingClientRect() : null;
          const estTextW = Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? fontSize * 1.15 : fontSize * 0.65), 0);
          const ctrlW = Math.max(base.w, labelBox ? Math.ceil(labelBox.width) + 16 : 0, Math.ceil(estTextW + 32), 48);
          const ctrlH = Math.max(base.h, labelBox ? Math.ceil(labelBox.height) : 0, 24);
          return {
            ...base,
            w: ctrlW,
            h: ctrlH,
            kind: itype,
            checked: Boolean(el.checked),
            text,
            ...(itype === 'radio' && el.name ? { group: el.name } : {}),
            ...(el.disabled ? { disabled: true } : {}),
            ...(color ? { color } : {}),
            fontSize,
          };
        }
        if (itype === 'button' || itype === 'submit' || itype === 'reset') {
          return {
            ...base,
            kind: 'button',
            text: el.value || '按钮',
            ...(color ? { color } : {}),
            fontSize,
            fontWeight,
            ...(el.disabled ? { disabled: true } : {}),
          };
        }
        return {
          ...base,
          kind: 'input',
          value: el.value || '',
          placeholder: el.placeholder || '',
          ...(el.maxLength > 0 ? { maxLength: el.maxLength } : {}),
          ...(el.disabled ? { disabled: true } : {}),
          ...(color ? { color } : {}),
          fontSize,
        };
      }
      if (tag === 'TEXTAREA') {
        return {
          ...base,
          kind: 'input',
          multiline: true,
          value: el.value || '',
          placeholder: el.placeholder || '',
          ...(el.maxLength > 0 ? { maxLength: el.maxLength } : {}),
          ...(el.disabled ? { disabled: true } : {}),
          ...(color ? { color } : {}),
          fontSize,
        };
      }
      if (tag === 'SELECT') {
        const options = Array.from(el.options).map(o => (o.textContent || '').trim()).filter(Boolean);
        return {
          ...base,
          kind: 'combobox',
          options: options.length ? options : ['选项1'],
          selectedIndex: el.selectedIndex >= 0 ? el.selectedIndex : 0,
          ...(el.disabled ? { disabled: true } : {}),
          ...(color ? { color } : {}),
          fontSize,
        };
      }
      if (tag === 'BUTTON' || el.getAttribute('role') === 'button' || (tag === 'A' && onlyInlineChildren(el))) {
        const txt = (el.innerText || el.textContent || '').trim().slice(0, 120);
        if (txt || el.children.length === 0) {
          return {
            ...base,
            kind: 'button',
            text: txt || '按钮',
            ...(color ? { color } : {}),
            fontSize,
            fontWeight,
            ...(fontFamily ? { fontFamily } : {}),
            ...(el.disabled ? { disabled: true } : {}),
          };
        }
      }

      if (onlyInlineChildren(el)) {
        const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 400);
        if (txt && !el.closest('label[for]')) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const ink = range.getBoundingClientRect();
          const padL = parseFloat(cs.paddingLeft) || 0;
          const padR = parseFloat(cs.paddingRight) || 0;
          const rawSpans = [...el.childNodes].map(child => {
            const style = child.nodeType === Node.ELEMENT_NODE ? getComputedStyle(child) : cs;
            return { text: child.textContent.replace(/\s+/g, ' '), fontSize: Math.round(parseFloat(style.fontSize) || fontSize),
              fontWeight: Number(style.fontWeight) || fontWeight, color: toHex(style.color) || color || '#000000' };
          }).filter(span => span.text);
          const spans = [];
          let pendingSpace = '';
          for (const span of rawSpans) {
            if (!span.text.trim()) {
              if (spans.length) pendingSpace = ' ';
              continue;
            }
            const nextText = pendingSpace ? pendingSpace + span.text.trimStart() : span.text;
            pendingSpace = '';
            spans.push({ ...span, text: nextText });
          }
          const largestFont = Math.max(fontSize, ...spans.map(span => span.fontSize));
          const isPara = ink.height > largestFont * 1.65;
          const distinct = new Set(spans.map(({ fontSize, fontWeight, color }) => [fontSize, fontWeight, color].join('/')));
          const extraW = !isPara ? Math.max(w, Math.ceil(ink.width + padL + padR + 2)) : w;
          const parentRect = el.parentElement?.getBoundingClientRect?.();
          const flushRight = Boolean(parentRect && parentRect.width > 0 && Math.abs(parentRect.right - rect.right) <= 2 && rect.left - parentRect.left > 24);
          const adjAbsX = extraW > w && flushRight ? Math.max(Math.round(parentRect.left + sx), absX - (extraW - w)) : absX;
          return {
            ...base,
            absX: adjAbsX,
            w: extraW,
            textPaddingX: fill || borders.stroke ? Math.round((padL + padR) / 2) : 0,
            ...(distinct.size > 1 ? { spans } : {}),
            kind: isPara ? 'paragraph' : 'label',
            text: txt,
            ...(color ? { color } : {}),
            fontSize,
            fontWeight,
            ...(lineHeight ? { lineHeight } : {}),
            ...(textAlign ? { textAlign } : (flushRight && !isPara ? { textAlign: 'right' } : {})),
            ...(fontFamily ? { fontFamily } : {}),
          };
        }
      }

      const children = [];
      for (const ch of el.children) {
        const parsed = await walk(ch, depth + 1);
        if (parsed) children.push(parsed);
      }
      if (!children.length && !fill && !borders.stroke && !shadow) return null;
      return { ...base, kind: 'box', children };
    };

    const bodyCs = getComputedStyle(document.body);
    const content = [...document.body.children].filter(el => !SKIP.has(el.tagName)).map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0);
    const contentBounds = content.length ? {
      x: Math.min(...content.map(r => r.left)) + sx,
      y: Math.min(...content.map(r => r.top)) + sy,
      right: Math.max(...content.map(r => r.right)) + sx,
      bottom: Math.max(...content.map(r => r.bottom)) + sy,
    } : null;
    const behaviors = [];
    for (const el of document.querySelectorAll('[onclick], [onchange], [oninput], [onsubmit], a[href]')) {
      for (const trigger of ['onclick', 'onchange', 'oninput', 'onsubmit']) {
        if (el.hasAttribute(trigger)) behaviors.push({ nodeId: el.id || null, trigger, code: el.getAttribute(trigger).slice(0, 2048) });
      }
      if (el.matches('a[href]')) behaviors.push({ nodeId: el.id || null, trigger: 'href', code: el.getAttribute('href') });
    }
    const listener = /getElementById\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*addEventListener\(\s*['"]([a-z]+)['"]/gi;
    for (const script of document.scripts) {
      for (const binding of script.textContent.matchAll(listener)) {
        behaviors.push({ nodeId: binding[1], trigger: binding[2], code: binding[0], scriptListener: true });
      }
    }
    const rootTree = await walk(document.body, 0);
    return {
      title: document.title || 'HTML 导入页',
      url: location.href,
      bodyFill: toHex(bodyCs.backgroundColor) || toHex(getComputedStyle(document.documentElement).backgroundColor) || '#FFFFFF',
      pageW: Math.max(320, Math.round(document.documentElement.scrollWidth || window.innerWidth)),
      pageH: Math.max(320, Math.round(document.documentElement.scrollHeight || window.innerHeight)),
      root: rootTree,
      contentBounds,
      behaviors,
    };
}

function normalizeImportedTree(node, parentAbsX, parentAbsY, state) {
  if (!node) return null;
  // Collapsing pure wrapper containers with 1 child prevents deep empty nesting in RP/1 & Studio.
  let cur = node;
  while (
    cur.kind === 'box'
    && !cur.fill
    && !cur.stroke
    && !cur.borderSides
    && !cur.shadow
    && cur.radius === undefined
    && cur.opacity === undefined
    && Array.isArray(cur.children)
    && cur.children.length === 1
    && cur !== state.rootRef
  ) {
    cur = cur.children[0];
  }

  let baseId = String(cur.domId || `html_${cur.kind.replace(/[^a-z0-9_]/gi, '_')}_${++state.seq}`)
    .replace(/[^A-Za-z0-9_-]/g, '_');
  if (!/^[A-Za-z_]/.test(baseId)) baseId = `n_${baseId}`;
  let id = baseId;
  let dup = 2;
  while (state.usedIds.has(id)) id = `${baseId}_${dup++}`;
  state.usedIds.add(id);

  const relX = Math.round(cur.absX - parentAbsX);
  const relY = Math.round(cur.absY - parentAbsY);
  const out = {
    id,
    type: cur.kind === 'box' ? 'box' : cur.kind,
    x: cur === state.rootRef ? 0 : Math.max(0, relX),
    y: cur === state.rootRef ? 0 : Math.max(0, relY),
    w: Math.max(4, Math.round(cur.w)),
    h: Math.max(4, Math.round(cur.h)),
  };

  if (cur.domId && !state.nodesByDomId.has(cur.domId)) state.nodesByDomId.set(cur.domId, out);
  if (out.type === 'box') out.layout = 'stack';
  if (cur.fill) {
    out.fill = cur.fill;
    state.bgHistogram.set(cur.fill, (state.bgHistogram.get(cur.fill) || 0) + 1);
  }
  if (cur.radius !== undefined) out.radius = cur.radius;
  if (cur.stroke) out.stroke = cur.stroke;
  if (cur.strokeWidth) out.strokeWidth = cur.strokeWidth;
  if (cur.borderSides) out.borderSides = cur.borderSides;
  if (cur.shadow) out.shadow = cur.shadow;
  if (cur.opacity !== undefined) out.opacity = cur.opacity;

  if (cur.kind === 'image') {
    if (cur.dataUrl && state.assetsDir) {
      const m = cur.dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12);
        const prefix = cur.isSvg ? 'html-svg' : 'html-img';
        const fileName = `${prefix}-${hash}.${m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()}`;
        const assetAbs = join(state.assetsDir, fileName);
        mkdirSync(state.assetsDir, { recursive: true });
        if (!existsSync(assetAbs)) writeFileSync(assetAbs, buf);
        out.src = `assets/${fileName}`;
        state.savedAssets.push(out.src);
        if (cur.isSvg) state.svgCount++;
        else state.imageCount++;
      }
    }
    if (!out.src) {
      out.type = 'box';
      out.fill = out.fill || '#E2E8F0';
    }
  } else if (cur.kind === 'divider') {
    out.color = cur.color || '#CBD5E1';
  } else if (cur.kind === 'checkbox' || cur.kind === 'radio') {
    state.formControlCount++;
    out.text = cur.text || '';
    out.checked = Boolean(cur.checked);
    if (cur.group) out.group = cur.group;
    if (cur.disabled) out.disabled = true;
    if (cur.color) out.color = cur.color;
    if (cur.fontSize) out.fontSize = cur.fontSize;
  } else if (cur.kind === 'combobox') {
    state.formControlCount++;
    out.options = cur.options;
    out.selectedIndex = cur.selectedIndex ?? 0;
    if (cur.disabled) out.disabled = true;
    if (cur.color) out.color = cur.color;
    if (cur.fontSize) out.fontSize = cur.fontSize;
  } else if (cur.kind === 'input') {
    state.formControlCount++;
    if (cur.multiline) out.multiline = true;
    if (cur.value) out.value = cur.value;
    if (cur.placeholder) out.placeholder = cur.placeholder;
    if (cur.maxLength) out.maxLength = cur.maxLength;
    if (cur.disabled) out.disabled = true;
    if (cur.color) out.color = cur.color;
    if (cur.fontSize) out.fontSize = cur.fontSize;
  } else if (cur.kind === 'button') {
    state.formControlCount++;
    out.text = cur.text || '按钮';
    if (cur.color) out.color = cur.color;
    if (cur.fontSize) out.fontSize = cur.fontSize;
    if (cur.fontWeight) out.fontWeight = cur.fontWeight;
    if (cur.fontFamily) out.fontFamily = cur.fontFamily;
    if (cur.disabled) out.disabled = true;
  } else if (cur.kind === 'label' || cur.kind === 'paragraph') {
    out.text = cur.text || '';
    if (cur.color) {
      out.color = cur.color;
      state.textHistogram.set(cur.color, (state.textHistogram.get(cur.color) || 0) + 1);
    }
    if (cur.fontSize) out.fontSize = cur.fontSize;
    if (cur.fontWeight) out.fontWeight = cur.fontWeight;
    if (cur.spans) out.spans = cur.spans;
    if (cur.textPaddingX !== undefined) out.textPaddingX = cur.textPaddingX;
    if (cur.lineHeight) out.lineHeight = cur.lineHeight;
    if (cur.textAlign) out.align = cur.textAlign;
    if (cur.fontFamily) out.fontFamily = cur.fontFamily;
  }

  if (Array.isArray(cur.children) && cur.children.length > 0 && out.type === 'box') {
    out.children = cur.children
      .map(ch => normalizeImportedTree(ch, cur.absX, cur.absY, state))
      .filter(Boolean);
  }
  state.nodeCount++;
  return out;
}

function importHtmlBehaviors(behaviors, state, originalUrl) {
  const id = String.raw`document\.getElementById\(\s*(['"])([\w:-]+)\1\s*\)`;
  const getTarget = raw => state.nodesByDomId.get(raw);
  const textAssignment = new RegExp(`^${id}\\s*\\.\\s*(?:textContent|innerText)\\s*=\\s*(.+)$`);
  const visibleAssignment = new RegExp(`^${id}\\s*\\.\\s*(style\\.display|hidden)\\s*=\\s*(.+)$`);
  const atom = /(?:document\.getElementById\(\s*(['"])([\w:-]+)\1\s*\)\.value)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/y;
  const marks = { onclick: 'click', onchange: 'change', oninput: 'change', href: 'click' };
  const literal = value => {
    const token = value.replace(/;\s*$/, '').trim();
    if (token.startsWith('"')) {
      try { return JSON.parse(token); } catch { return null; }
    }
    if (/^'[^'\\]*'$/.test(token)) return token.slice(1, -1);
    return null;
  };
  const linkAction = href => {
    if (typeof href !== 'string') return null;
    if (href.startsWith('#')) {
      const target = getTarget(href.slice(1));
      return target ? { type: 'scroll-to', target: target.id } : null;
    }
    try {
      const url = new URL(href, originalUrl);
      return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)
        ? { type: 'open-link', url: url.href, window: 'current' } : null;
    } catch { return null; }
  };
  const items = [];
  for (const signal of behaviors) {
    const node = getTarget(signal.nodeId);
    const code = signal.code.trim().replace(/;\s*$/, '');
    let action;
    if (node && marks[signal.trigger] && !signal.scriptListener) {
      const text = code.match(textAssignment);
      const display = code.match(visibleAssignment);
      const nav = code.match(/^(?:window\.)?location\.href\s*=\s*(.+)$/);
      if (signal.trigger === 'href') action = linkAction(code);
      else if (nav) action = linkAction(literal(nav[1]));
      else if (text && getTarget(text[2])) {
        const expression = text[3];
        const args = [];
        let offset = 0;
        while (offset < expression.length) {
          while (/\s/.test(expression[offset] || '')) offset++;
          atom.lastIndex = offset;
          const found = atom.exec(expression);
          if (!found) break;
          const referenced = found[2] ? getTarget(found[2]) : null;
          const value = found[3] ? literal(found[3]) : referenced && ['input', 'combobox'].includes(referenced.type) ? { widget: referenced.id } : null;
          if (value === null) break;
          args.push(value);
          offset = atom.lastIndex;
          while (/\s/.test(expression[offset] || '')) offset++;
          if (offset < expression.length && expression[offset++] !== '+') { offset = -1; break; }
          if (expression[offset - 1] === '+' && offset >= expression.length) { offset = -1; break; }
        }
        if (args.length && offset === expression.length) action = { type: 'set-text', target: getTarget(text[2]).id,
          text: args.length === 1 ? args[0] : { fn: 'concat', args } };
      } else if (display && getTarget(display[2])) {
        const selector = display[3] === 'hidden' ? display[4] : literal(display[4]);
        const hidden = display[3] === 'hidden' ? selector === 'true' : selector === 'none';
        if ((display[3] === 'hidden' ? ['true', 'false'] : ['none', 'block', '']).includes(selector)) {
          action = { type: hidden ? 'hide' : 'show', target: getTarget(display[2]).id };
        }
      }
    }
    if (action) {
      const event = marks[signal.trigger];
      node.on ??= {};
      (node.on[event] ??= []).push(action);
      items.push({ nodeId: node.id, trigger: signal.trigger, status: 'converted', rp1Action: action });
    } else {
      items.push({ nodeId: signal.nodeId, trigger: signal.trigger, status: 'dropped', source: code.slice(0, 160),
        reason: !node ? '没有对应的可编辑源节点。' : '超出受支持的静态 DOM 动作范围。' });
    }
  }
  const converted = items.filter(item => item.status === 'converted').length;
  return { detected: items.length, converted, dropped: items.length - converted, items };
}

export async function importHtmlToRp1Spec(input, {
  viewport = null,
  cwd = null,
  assetsDir = null,
  name = null,
  domain = null,
  timeoutMs = 15000,
  fitCanvas = 'auto',
} = {}) {
  findChromeExecutable();
  const rawInput = String(input).trim();
  let server = null;
  let targetUrl = rawInput;
  let localHtmlPath = null;

  if (/^file:\/\//i.test(rawInput)) {
    localHtmlPath = fileURLToPath(rawInput);
  } else if (!/^https?:\/\//i.test(rawInput)) {
    const workDir = resolveWorkDir(cwd);
    localHtmlPath = isAbsolute(rawInput) ? resolve(rawInput) : resolve(workDir, rawInput);
  }

  if (localHtmlPath) {
    assertNotProtected(localHtmlPath);
    if (!existsSync(localHtmlPath)) {
      throw Object.assign(new Error(`HTML 文件不存在：${localHtmlPath}`), { code: 'E_HTML_INPUT_NOT_FOUND' });
    }
    server = startLocalHtmlServer(dirname(localHtmlPath));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    targetUrl = `http://127.0.0.1:${server.address().port}/${encodeURIComponent(basename(localHtmlPath))}`;
  }

  let effectiveDomain = domain === 'mobile' || domain === 'web'
    ? domain
    : ((viewport?.width && viewport.width <= 520) ? 'mobile' : 'web');
  const vp = {
    width: Math.min(3840, Math.max(320, Math.round(viewport?.width ?? (effectiveDomain === 'mobile' ? 402 : 1280)))),
    height: Math.min(2160, Math.max(320, Math.round(viewport?.height ?? (effectiveDomain === 'mobile' ? 874 : 900)))),
    dpr: viewport?.dpr ?? 1,
  };

  let browser = null;
  try {
    browser = await launchChrome({ headless: true, width: vp.width, height: vp.height, dpr: vp.dpr });
    const page = await browser.openPage('about:blank');
    await page.send('Emulation.setScriptExecutionDisabled', { value: true });
    await page.navigate(targetUrl, timeoutMs);
    await page.send('Emulation.setScriptExecutionDisabled', { value: false });
    await page.evaluate('document.fonts ? document.fonts.ready.catch(() => {}) : Promise.resolve()');
    await new Promise(r => setTimeout(r, 120));
    const extracted = await page.evaluate(`(${extractInBrowserDom.toString()})()`, { timeoutMs });
    if (!extracted || !extracted.root) {
      throw Object.assign(new Error(`无法从页面提取可见结构：${targetUrl}`), { code: 'E_HTML_EXTRACT_EMPTY' });
    }

    const state = {
      rootRef: extracted.root,
      seq: 0,
      usedIds: new Set(['root']),
      assetsDir,
      savedAssets: [],
      nodeCount: 0,
      formControlCount: 0,
      imageCount: 0,
      svgCount: 0,
      nodesByDomId: new Map(),
      bgHistogram: new Map(),
      textHistogram: new Map(),
    };
    const bounds = extracted.contentBounds;
    const narrow = bounds && bounds.right - bounds.x <= vp.width * 0.75;
    const cropContent = bounds && (fitCanvas === 'content' || (fitCanvas === 'auto' && narrow));
    if (cropContent) {
      Object.assign(extracted.root, { absX: Math.round(bounds.x), absY: Math.round(bounds.y),
        w: Math.max(32, Math.round(bounds.right - bounds.x)), h: Math.max(32, Math.round(bounds.bottom - bounds.y)) });
      if (!domain && extracted.root.w <= 520) effectiveDomain = 'mobile';
    }
    const rootNode = normalizeImportedTree(extracted.root, 0, 0, state);
    rootNode.id = 'root';
    if (!cropContent) {
      rootNode.w = Math.max(rootNode.w, Math.min(3840, extracted.pageW || vp.width));
      rootNode.h = fitCanvas === 'auto' && bounds
        ? Math.max(320, Math.min(4800, Math.ceil(bounds.bottom)))
        : Math.max(rootNode.h, Math.min(4800, extracted.pageH || vp.height));
    }
    const behaviorReport = importHtmlBehaviors(extracted.behaviors, state, localHtmlPath ? pathToFileURL(localHtmlPath).href : extracted.url);
    rootNode.fill = rootNode.fill || extracted.bodyFill || '#FFFFFF';

    const topSolidColor = map => [...map.entries()].find(([c]) => /^#[0-9A-Fa-f]{6}$/.test(c))?.[0];
    const palette = {
      bg: rgbToHex(extracted.bodyFill) || '#F8FAFC',
      surface: '#FFFFFF',
      'surface-2': '#F1F5F9',
      border: '#CBD5E1',
      text: topSolidColor(state.textHistogram) || '#0F172A',
      muted: '#64748B',
      brand: topSolidColor(state.bgHistogram) || '#2563EB',
    };

    const pageW = rootNode.w;
    const pageH = rootNode.h;
    const spec = {
      language: 'rp/1',
      target: 9,
      name: name || extracted.title || 'HTML 导入原型',
      domain: effectiveDomain,
      theme: effectiveDomain === 'mobile' ? 'mobile-hifi' : 'enterprise-light',
      palette,
      pages: [
        {
          id: 'page_1',
          name: (extracted.title || 'Page 1').slice(0, 60),
          canvas: { w: pageW, h: pageH },
          root: rootNode,
        },
      ],
    };

    const dslProc = spawnPythonSync(['-B', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from rp_dsl import spec_to_dsl
sys.stdout.write(spec_to_dsl(json.loads(sys.stdin.read())))
`, SCRIPTS_DIR], {
      input: JSON.stringify(spec),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (dslProc.status !== 0) {
      throw Object.assign(new Error(`HTML 转 RP/1 源码失败：${dslProc.stderr || dslProc.stdout || dslProc.error?.message}`), { code: 'E_HTML_TO_RP1' });
    }

    return {
      spec,
      rp1Text: `# HTML 行为接管：发现 ${behaviorReport.detected}，转换 ${behaviorReport.converted}，未转换 ${behaviorReport.dropped}。\n${dslProc.stdout}`,
      assets: state.savedAssets,
      summary: {
        behaviorReport, fitCanvas,
        url: localHtmlPath ? basename(localHtmlPath) : targetUrl,
        title: extracted.title || null,
        pageW,
        pageH,
        nodeCount: state.nodeCount,
        formControlCount: state.formControlCount,
        imageCount: state.imageCount,
        svgCount: state.svgCount,
      },
    };
  } finally {
    try { await browser?.close(); } catch {}
    try { server?.close(); server?.closeAllConnections?.(); } catch {}
  }
}
