import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected } from '../scripts/engine.mjs';
import { ensureCoreComponentsRegistered } from './component-contracts.mjs';
export { assertNotProtected };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const STUDIO_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = STUDIO_SCHEMA_VERSION;
export const RENDERER_VERSION = 'zee-studio-renderer-1.1.0';
export const EXPORTER_VERSION = 'zee-studio-exporter-1.1.0';

export const DEFAULT_THEMES = {
  'mobile-hifi': {
    bg: '#F7F8F2',
    surface: '#FFFFFF',
    'surface-2': '#E7EDDF',
    ink: '#203B32',
    'ink-2': '#7A887E',
    muted: '#7A887E',
    brand: '#365E49',
    'brand-soft': '#E7EDDF',
    accent: '#2563EB',
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    error: '#DC2626',
    line: '#E3E7DC',
  },
  'mobile-lowfi': {
    bg: '#F8FAFC',
    surface: '#FFFFFF',
    'surface-2': '#F1F5F9',
    ink: '#0F172A',
    'ink-2': '#64748B',
    muted: '#64748B',
    brand: '#2563EB',
    'brand-soft': '#DBEAFE',
    accent: '#0EA5E9',
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    error: '#DC2626',
    line: '#E2E8F0',
  },
  'enterprise-light': {
    bg: '#F1F5F9',
    surface: '#FFFFFF',
    'surface-2': '#F8FAFC',
    ink: '#0F172A',
    'ink-2': '#475569',
    muted: '#64748B',
    brand: '#2563EB',
    'brand-soft': '#EFF6FF',
    accent: '#0284C7',
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    error: '#DC2626',
    line: '#E2E8F0',
  },
  'editorial-warm': {
    bg: '#FAF7F2',
    surface: '#FFFFFF',
    'surface-2': '#F2ECE1',
    ink: '#1C1917',
    'ink-2': '#78716C',
    muted: '#78716C',
    brand: '#9A3412',
    'brand-soft': '#FFEDD5',
    accent: '#B45309',
    success: '#15803D',
    warning: '#B45309',
    danger: '#B91C1C',
    error: '#B91C1C',
    line: '#E7E0D6',
  },
};

export const DEVICE_PRESETS = {
  'iphone-17-pro': { w: 402, h: 874, shellPad: 20, outerRadius: 58, innerRadius: 53, screenRadius: 44, safeAreaTop: 60, island: { w: 122, h: 34, y: 10 } },
  'iphone-17': { w: 402, h: 874, shellPad: 20, outerRadius: 58, innerRadius: 53, screenRadius: 44, safeAreaTop: 60, island: { w: 122, h: 34, y: 10 } },
  'iphone-16-pro': { w: 393, h: 852, shellPad: 20, outerRadius: 56, innerRadius: 51, screenRadius: 42, safeAreaTop: 60, island: { w: 96, h: 24, y: 15 } },
  'iphone-x': { w: 375, h: 812, shellPad: 18, outerRadius: 48, innerRadius: 44, screenRadius: 38, safeAreaTop: 60, island: { w: 92, h: 22, y: 14 } },
};

export const SYSTEM_FONTS = new Set([
  'PingFang SC',
  'Hiragino Sans GB',
  'Songti SC',
  'STSong',
  'Kaiti SC',
  'Heiti SC',
  'Inter',
  'SF Pro Display',
  'SF Pro Text',
  'Helvetica Neue',
  'Arial',
  'Georgia',
  'Menlo',
  'Monaco',
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
]);

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

const pageCanonicalCache = new Map();

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v === undefined ? null : v)).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function computeContentHash(doc) {
  const excluded = new Set(['revision', 'createdAt', 'updatedAt', 'contentHash', 'sessionState', 'historyMeta']);
  const keys = Object.keys(doc).filter(k => doc[k] !== undefined && !excluded.has(k)).sort();
  const parts = keys.map(k => {
    if (k === 'pages' && Array.isArray(doc.pages)) {
      const pageStrs = doc.pages.map(pg => {
        const fastKey = JSON.stringify(pg);
        let cached = pageCanonicalCache.get(fastKey);
        if (!cached) {
          cached = canonicalJson(pg);
          if (pageCanonicalCache.size > 250) pageCanonicalCache.clear();
          pageCanonicalCache.set(fastKey, cached);
        }
        return cached;
      });
      return `"pages":[${pageStrs.join(',')}]`;
    }
    return JSON.stringify(k) + ':' + canonicalJson(doc[k]);
  });
  return sha256(`{${parts.join(',')}}`);
}

function readImageDimensions(buf) {
  if (!buf || buf.length < 24) return { width: null, height: null };
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  }
  return { width: null, height: null };
}

export function parseSourceSpec(sourcePathOrObject) {
  if (typeof sourcePathOrObject === 'object' && sourcePathOrObject !== null) {
    return { spec: structuredClone(sourcePathOrObject), baseDir: process.cwd(), sourcePath: null };
  }
  const absPath = resolve(String(sourcePathOrObject));
  assertNotProtected(absPath);
  const baseDir = dirname(absPath);
  const ext = extname(absPath).toLowerCase();
  if (ext === '.rp1') {
    const proc = spawnSync('python3', ['-B', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from rp_dsl import dsl_to_spec
with open(sys.argv[2], encoding="utf-8") as f:
    print(json.dumps(dsl_to_spec(f.read()), ensure_ascii=False))
`, join(ROOT, 'scripts'), absPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (proc.status !== 0) {
      throw Object.assign(new Error(`Failed to parse .rp1 DSL: ${proc.stderr || proc.stdout}`), { code: 'E_DSL_PARSE' });
    }
    return { spec: normalizeSpecShorthand(JSON.parse(proc.stdout)), baseDir, sourcePath: absPath };
  }
  const text = readFileSync(absPath, 'utf8');
  return { spec: normalizeSpecShorthand(JSON.parse(text)), baseDir, sourcePath: absPath };
}

const MACRO_TYPES = new Set([
  'phone-shell',
  'card',
  'list-item',
  'stat-row',
  'tab-bar',
  'nav-bar',
  'progress-bar',
  'form-card',
  'kv-list',
  'detail-card',
  'wizard-card',
  'master-detail',
]);

// RP/1 的 .rp1 DSL 解析结果是"简写 JSON"：容器写作 {"column":"shell"}、控件写作
// {"label":"title"}。Studio 的文档模型需要显式的 type/layout，否则导入后所有子节点
// 会退化成 box 并堆在容器原点（S8）。这里做一次简写 → 标准节点的规范化。
const SHORTHAND_KINDS = {
  column: { type: 'box', layout: 'column' },
  row: { type: 'box', layout: 'row' },
  stack: { type: 'box', layout: 'stack' },
  grid: { type: 'box', layout: 'grid' },
  box: { type: 'box' },
  label: { type: 'label' },
  paragraph: { type: 'paragraph' },
  button: { type: 'button' },
  badge: { type: 'badge' },
  icon: { type: 'icon' },
  image: { type: 'image' },
  input: { type: 'input' },
  divider: { type: 'divider' },
  spacer: { type: 'spacer' },
  repeater: { type: 'repeater' },
  'dynamic-panel': { type: 'dynamic-panel' },
  'phone-shell': { type: 'phone-shell' },
  card: { type: 'card' },
  'list-item': { type: 'list-item' },
  'stat-row': { type: 'stat-row' },
  'detail-card': { type: 'detail-card' },
  'data-table': { type: 'data-table' },
  'master-detail': { type: 'master-detail' },
  'searchable-list': { type: 'searchable-list' },
  'progress-bar': { type: 'progress-bar' },
  'tab-bar': { type: 'tab-bar' },
  tabs: { type: 'tabs' },
};

function normalizeDslShorthand(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const copy = { ...node };
  if (!copy.type) {
    for (const [kind, mapped] of Object.entries(SHORTHAND_KINDS)) {
      const raw = copy[kind];
      if (raw === undefined) continue;
      copy.type = mapped.type;
      if (mapped.layout) copy.layout = copy.layout || mapped.layout;
      if (typeof raw === 'string' && raw) copy.id = copy.id || raw;
      delete copy[kind];
      break;
    }
  }
  if (Array.isArray(copy.canvas) && copy.canvas.length === 2) {
    copy.canvas = { w: copy.canvas[0], h: copy.canvas[1] };
  }
  if (Array.isArray(copy.children)) copy.children = copy.children.map(normalizeDslShorthand);
  if (Array.isArray(copy.states)) {
    copy.states = copy.states.map(state => (state && typeof state === 'object'
      ? { ...state, root: normalizeDslShorthand(state.root) }
      : state));
  }
  if (copy.template) copy.template = normalizeDslShorthand(copy.template);
  return copy;
}

function normalizeSpecShorthand(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = { ...spec };
  if (Array.isArray(out.pages)) {
    out.pages = out.pages.map(page => {
      if (!page || typeof page !== 'object') return page;
      const next = { ...page, root: normalizeDslShorthand(page.root) };
      if (Array.isArray(next.canvas) && next.canvas.length === 2) {
        next.canvas = { w: Number(next.canvas[0]), h: Number(next.canvas[1]) };
      }
      return next;
    });
  }
  if (out.components && typeof out.components === 'object') {
    const comps = {};
    for (const [key, value] of Object.entries(out.components)) {
      comps[key] = value && typeof value === 'object' && value.root
        ? { ...value, root: normalizeDslShorthand(value.root) }
        : value;
    }
    out.components = comps;
  }
  return out;
}

function normalizeNode(node, pageId, seenIds, pathPtr, assetCollector) {
  if (!node || typeof node !== 'object') return node;
  const copy = structuredClone(node);
  const rawId = String(copy.id || copy.name || `node_${seenIds.size + 1}`);
  let nodeId = rawId;
  if (seenIds.has(nodeId)) {
    let suffix = 2;
    while (seenIds.has(`${rawId}_${suffix}`)) suffix++;
    nodeId = `${rawId}_${suffix}`;
  }
  seenIds.add(nodeId);
  copy.id = nodeId;
  if (!copy.name) copy.name = rawId;
  copy.type = copy.type || 'box';
  copy.sourcePointer = copy.sourcePointer || pathPtr;

  if (MACRO_TYPES.has(copy.type) && !copy.macroSource) {
    copy.macroSource = {
      macroType: copy.type,
      originalProps: Object.fromEntries(
        Object.entries(copy).filter(([k]) => !['children', 'states', 'template', 'sourcePointer', 'macroSource'].includes(k))
      ),
    };
  }

  if (copy.type === 'use' || copy.type === 'instance' || copy.component) {
    copy.type = 'instance';
    copy.component = copy.component || copy.use;
    copy.overrides = copy.overrides || {};
    copy.props = copy.props || copy.args || {};
  }

  if (copy.type === 'image' && copy.src) {
    assetCollector(copy);
  }

  if (Array.isArray(copy.children)) {
    copy.children = copy.children.map((ch, i) =>
      normalizeNode(ch, pageId, seenIds, `${pathPtr}/children/${i}`, assetCollector)
    );
  }

  if (Array.isArray(copy.states)) {
    copy.states = copy.states.map((st, sIdx) => {
      const stCopy = structuredClone(st);
      const stId = stCopy.id || stCopy.name || `state_${sIdx + 1}`;
      stCopy.id = stId;
      stCopy.name = stCopy.name || stId;
      const stateSeen = new Set(seenIds);
      if (stCopy.root) {
        stCopy.root = normalizeNode(stCopy.root, pageId, stateSeen, `${pathPtr}/states/${sIdx}/root`, assetCollector);
      } else if (Array.isArray(stCopy.children)) {
        stCopy.root = normalizeNode({
          type: 'box',
          id: `${nodeId}_${stId}_root`,
          name: `${nodeId}_${stId}_root`,
          layout: stCopy.layout || 'stack',
          w: 'fill',
          h: 'fill',
          children: stCopy.children,
        }, pageId, stateSeen, `${pathPtr}/states/${sIdx}/root`, assetCollector);
        delete stCopy.children;
      }
      return stCopy;
    });
  }

  if (copy.template && typeof copy.template === 'object') {
    const tplSeen = new Set(seenIds);
    copy.template = normalizeNode(copy.template, pageId, tplSeen, `${pathPtr}/template`, assetCollector);
  }

  return copy;
}

export function importToStudioDocument(sourcePathOrObject, { projectDir = null, documentId = null, baseDir = null } = {}) {
  const parsed = parseSourceSpec(sourcePathOrObject);
  const raw = parsed.spec;
  const resolvedBaseDir = baseDir || parsed.baseDir || process.cwd();

  if (raw.schemaVersion !== undefined && raw.schemaVersion > STUDIO_SCHEMA_VERSION) {
    throw Object.assign(
      new Error(`Document schemaVersion ${raw.schemaVersion} is newer than supported version ${STUDIO_SCHEMA_VERSION}`),
      { code: 'E_SCHEMA_VERSION_UNSUPPORTED', schemaVersion: raw.schemaVersion, supported: STUDIO_SCHEMA_VERSION }
    );
  }

  if (raw.schemaVersion === STUDIO_SCHEMA_VERSION && raw.documentId && Array.isArray(raw.pages)) {
    const doc = structuredClone(raw);
    if (projectDir) localizeAssets(doc, resolvedBaseDir, projectDir);
    doc.contentHash = computeContentHash(doc);
    return doc;
  }

  const themeName = raw.theme || 'mobile-hifi';
  const basePalette = DEFAULT_THEMES[themeName] || DEFAULT_THEMES['mobile-hifi'];
  const palette = { ...basePalette, ...(raw.palette || {}) };
  const tokens = {
    colors: { ...palette },
    fontSize: raw.tokens?.fontSize || [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48],
    fontWeight: raw.tokens?.fontWeight || [400, 500, 600, 700],
    spacing: raw.tokens?.spacing || [0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64],
    radius: raw.tokens?.radius || [0, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 44, 53, 58, 999],
    ...(raw.tokens || {}),
  };

  const assetsManifest = {};
  const assetDiagnostics = [];

  function handleAssetNode(node) {
    const src = String(node.src || '');
    if (!src) return;
    let absCandidate = isAbsolute(src) ? src : resolve(resolvedBaseDir, src);
    if (!existsSync(absCandidate) && !isAbsolute(src)) {
      const altCandidate = resolve(resolvedBaseDir, '..', src);
      if (existsSync(altCandidate)) absCandidate = altCandidate;
    }
    const relName = `assets/${basename(src)}`;
    if (existsSync(absCandidate)) {
      assertNotProtected(absCandidate);
      const buf = readFileSync(absCandidate);
      const dims = readImageDimensions(buf);
      const fileSha = sha256(buf);
      if (projectDir) {
        const assetsDir = join(projectDir, 'assets');
        mkdirSync(assetsDir, { recursive: true });
        const targetFile = join(projectDir, relName);
        if (!existsSync(targetFile)) {
          copyFileSync(absCandidate, targetFile);
        }
      }
      node.src = relName;
      assetsManifest[relName] = {
        relativePath: relName,
        originalSrc: src,
        sha256: fileSha,
        bytes: buf.length,
        width: dims.width,
        height: dims.height,
        missing: false,
      };
    } else {
      assetsManifest[src] = {
        relativePath: src,
        originalSrc: src,
        sha256: null,
        bytes: 0,
        width: null,
        height: null,
        missing: true,
      };
      assetDiagnostics.push({
        code: 'E_MISSING_ASSET',
        severity: 'warning',
        nodeId: node.id,
        src,
        message: `图片资源不存在: ${src}`,
      });
    }
  }

  const rawPages = Array.isArray(raw.pages) ? raw.pages : [];
  let boardCursorX = 80;
  const pages = rawPages.map((pg, idx) => {
    const pageId = String(pg.id || pg.slug || `page_${idx + 1}`);
    const pageName = String(pg.name || pageId);
    const device = pg.device || raw.device || null;
    const preset = device ? (DEVICE_PRESETS[device] || DEVICE_PRESETS['iphone-17-pro']) : null;
    const canvasW = Number(pg.canvas?.w || preset?.w || 402);
    const canvasH = Number(pg.canvas?.h || preset?.h || 874);
    const boardX = Number.isFinite(pg.canvas?.x) ? Number(pg.canvas.x) : boardCursorX;
    const boardY = Number.isFinite(pg.canvas?.y) ? Number(pg.canvas.y) : 80;
    boardCursorX = boardX + canvasW + (preset ? preset.shellPad * 2 : 0) + 80;

    const seenIds = new Set();
    const rootNode = normalizeNode(
      pg.root || { type: 'box', id: `${pageId}_root`, name: pageName, layout: 'stack', w: canvasW, h: canvasH, children: [] },
      pageId,
      seenIds,
      `/pages/${idx}/root`,
      handleAssetNode
    );

    return {
      id: pageId,
      name: pageName,
      device,
      domain: pg.domain || raw.domain || 'mobile',
      canvas: {
        x: boardX,
        y: boardY,
        w: canvasW,
        h: canvasH,
      },
      root: rootNode,
      interactions: structuredClone(pg.interactions || []),
      explorations: structuredClone(pg.explorations || []),
    };
  });

  // Normalize components
  const rawComponents = raw.components || {};
  const components = {};
  for (const [compKey, compDef] of Object.entries(rawComponents)) {
    const compId = compDef.id || compKey;
    const seenIds = new Set();
    components[compId] = {
      id: compId,
      name: compDef.name || compId,
      params: structuredClone(compDef.params || {}),
      variants: structuredClone(compDef.variants || {}),
      defaultVariant: compDef.defaultVariant || Object.keys(compDef.variants || {})[0] || 'default',
      root: normalizeNode(
        compDef.root || { type: 'box', id: `${compId}_root`, layout: 'column', w: 200, h: 100, children: [] },
        `component:${compId}`,
        seenIds,
        `/components/${compId}/root`,
        handleAssetNode
      ),
    };
  }

  const doc = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    documentId: documentId || raw.documentId || slugify(raw.name || 'studio-doc'),
    revision: Number(raw.revision || 1),
    name: raw.name || '未命名设计文档',
    language: raw.language || 'rp/1',
    target: Number(raw.target || 9),
    domain: raw.domain || 'mobile',
    theme: themeName,
    device: raw.device || null,
    palette,
    tokens,
    fonts: {
      defaultFamily: raw.fonts?.defaultFamily || 'PingFang SC',
      headingFamily: raw.fonts?.headingFamily || 'PingFang SC',
      monoFamily: raw.fonts?.monoFamily || 'Menlo',
      catalog: raw.fonts?.catalog || [
        { id: 'pingfang', family: 'PingFang SC', fallbacks: ['Hiragino Sans GB', 'Heiti SC', 'sans-serif'], weights: [400, 500, 600, 700], source: 'system' },
        { id: 'songti', family: 'Songti SC', fallbacks: ['STSong', 'Georgia', 'serif'], weights: [400, 600, 700], source: 'system' },
        { id: 'kaiti', family: 'Kaiti SC', fallbacks: ['Songti SC', 'serif'], weights: [400, 700], source: 'system' },
        { id: 'inter', family: 'Inter', fallbacks: ['PingFang SC', 'Helvetica Neue', 'sans-serif'], weights: [400, 500, 600, 700], source: 'system' },
        { id: 'georgia', family: 'Georgia', fallbacks: ['Songti SC', 'serif'], weights: [400, 700], source: 'system' },
        { id: 'menlo', family: 'Menlo', fallbacks: ['Monaco', 'monospace'], weights: [400, 700], source: 'system' },
      ],
    },
    variables: structuredClone(raw.variables || {}),
    datasets: structuredClone(raw.datasets || {}),
    views: structuredClone(raw.views || {}),
    computed: structuredClone(raw.computed || {}),
    rules: structuredClone(raw.rules || []),
    statecharts: structuredClone(raw.statecharts || {}),
    masters: structuredClone(raw.masters || {}),
    adaptiveViews: structuredClone(raw.adaptiveViews || []),
    components,
    pages,
    assetsManifest,
    diagnostics: assetDiagnostics,
    sourceMeta: {
      originalSourcePath: parsed.sourcePath,
      importedAt: new Date().toISOString(),
    },
  };

  doc.contentHash = computeContentHash(doc);
  return doc;
}

export function localizeAssets(doc, baseDir, projectDir) {
  if (!projectDir) return;
  const assetsDir = join(projectDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  doc.assetsManifest = doc.assetsManifest || {};
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image' && node.src) {
      const src = String(node.src);
      const relName = `assets/${basename(src)}`;
      const cand1 = join(projectDir, src);
      const cand2 = isAbsolute(src) ? src : resolve(baseDir, src);
      const found = existsSync(cand1) ? cand1 : existsSync(cand2) ? cand2 : null;
      if (found) {
        const target = join(projectDir, relName);
        if (resolve(found) !== resolve(target) && !existsSync(target)) {
          copyFileSync(found, target);
        }
        const buf = readFileSync(target);
        const dims = readImageDimensions(buf);
        node.src = relName;
        doc.assetsManifest[relName] = {
          ...doc.assetsManifest[src],
          relativePath: relName,
          originalSrc: src,
          sha256: sha256(buf),
          bytes: buf.length,
          width: dims.width,
          height: dims.height,
          missing: false,
        };
        const original = doc.assetsManifest[relName].media?.originalPath;
        if (/^assets\/[a-zA-Z0-9_.-]+$/.test(original || '')) {
          const originalTarget = join(projectDir, original), originalSource = resolve(baseDir, original);
          if (!existsSync(originalTarget) && existsSync(originalSource)) {
            assertNotProtected(originalSource);
            copyFileSync(originalSource, originalTarget);
          }
        }
      } else {
        doc.assetsManifest[src] = {
          relativePath: src,
          originalSrc: src,
          sha256: null,
          bytes: 0,
          width: null,
          height: null,
          missing: true,
        };
      }
    }
    for (const ch of node.children || []) walk(ch);
    for (const st of node.states || []) if (st.root) walk(st.root);
    if (node.template) walk(node.template);
  };
  for (const p of doc.pages || []) walk(p.root);
  for (const c of Object.values(doc.components || {})) walk(c.root);
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'doc';
}

export function buildNodeIndex(doc) {
  const byId = new Map();
  const byScopedId = new Map();
  const byName = new Map();

  function visit(node, scope, parentNode, indexInParent, pathStr, activeInPanel = true) {
    if (!node || typeof node !== 'object') return;
    const rawScopedId = `${scope}/${node.id}`;
    const scopedId = `${scope.replace(/:/g, '/')}/${node.id}`;
    const pageId = scope.startsWith('component:') ? scope : scope.split('/')[0].split(':')[0];
    const entry = {
      node,
      id: node.id,
      scopedId,
      rawScopedId,
      name: node.name || node.id,
      scope: scope.replace(/:/g, '/'),
      pageId,
      parent: parentNode,
      parentId: parentNode?.id || null,
      index: indexInParent,
      path: pathStr,
      activeInPanel,
    };
    byScopedId.set(scopedId, entry);
    byScopedId.set(rawScopedId, entry);
    if (!byId.has(node.id)) byId.set(node.id, []);
    byId.get(node.id).push(entry);
    const dispName = node.name || node.id;
    if (!byName.has(dispName)) byName.set(dispName, []);
    byName.get(dispName).push(entry);

    if (Array.isArray(node.children)) {
      node.children.forEach((ch, idx) => visit(ch, scope, node, idx, `${pathStr}/children/${idx}`, activeInPanel));
    }
    if (Array.isArray(node.states)) {
      const activeStId = node.activeState || node.states[0]?.id;
      node.states.forEach((st, sIdx) => {
        if (st.root) {
          visit(
            st.root,
            `${scope}/${node.id}:${st.id}`,
            node,
            sIdx,
            `${pathStr}/states/${sIdx}/root`,
            activeInPanel && st.id === activeStId
          );
        }
      });
    }
    if (node.template) {
      visit(node.template, `${scope}/${node.id}:template`, node, 0, `${pathStr}/template`, activeInPanel);
    }
  }

  (doc.pages || []).forEach((pg, pIdx) => {
    visit(pg.root, pg.id, null, 0, `/pages/${pIdx}/root`, true);
  });
  for (const [compId, comp] of Object.entries(doc.components || {})) {
    visit(comp.root, `component:${compId}`, null, 0, `/components/${compId}/root`, true);
  }

  return {
    byId,
    byScopedId,
    byName,
    resolve(target, preferredPageId = null) {
      if (!target) return null;
      if (byScopedId.has(target)) return byScopedId.get(target);
      // Check pageId/nodeId shorthand
      if (target.includes('/')) {
        const parts = target.split('/');
        const pagePart = parts[0];
        const nodePart = parts.slice(1).join('/');
        const matches = [];
        for (const [k, v] of byScopedId.entries()) {
          if (k === target || (v.pageId === pagePart && (v.id === nodePart || k.endsWith('/' + nodePart)))) {
            matches.push(v);
          }
        }
        if (matches.length > 0) {
          const activeHit = matches.find(m => m.activeInPanel);
          return activeHit || matches[0];
        }
      }
      const idCandidates = byId.get(target) || [];
      if (idCandidates.length === 1) return idCandidates[0];
      if (idCandidates.length > 1 && preferredPageId) {
        const onPage = idCandidates.filter(c => c.pageId === preferredPageId);
        if (onPage.length === 1) return onPage[0];
        if (onPage.length > 1) {
          const onActive = onPage.filter(c => c.activeInPanel);
          return onActive[0] || onPage[0];
        }
      }
      if (idCandidates.length > 1) {
        throw Object.assign(
          new Error(`节点 ID "${target}" 在多个页面或容器中重名，请使用 "<pageId>/<nodeId>" 精确定位`),
          { code: 'E_AMBIGUOUS_NODE', target, candidates: idCandidates.map(c => c.scopedId) }
        );
      }
      const nameCandidates = byName.get(target) || [];
      if (nameCandidates.length === 1) return nameCandidates[0];
      if (nameCandidates.length > 1 && preferredPageId) {
        const onPage = nameCandidates.filter(c => c.pageId === preferredPageId);
        if (onPage.length === 1) return onPage[0];
        if (onPage.length > 1) {
          const onActive = onPage.filter(c => c.activeInPanel);
          return onActive[0] || onPage[0];
        }
      }
      if (nameCandidates.length > 1) {
        throw Object.assign(
          new Error(`显示名称 "${target}" 存在多个候选节点，请使用稳定 ID 或 "<pageId>/<nodeId>"`),
          { code: 'E_AMBIGUOUS_NODE', target, candidates: nameCandidates.map(c => c.scopedId) }
        );
      }
      return null;
    },
  };
}

export function exportToRp1Spec(doc) {
  const spec = {
    language: 'rp/1',
    target: doc.target || 9,
    name: doc.name,
    domain: doc.domain || 'mobile',
    theme: doc.theme || 'mobile-hifi',
    ...(doc.device ? { device: doc.device } : {}),
    palette: structuredClone(doc.palette || {}),
    ...(Object.keys(doc.variables || {}).length ? { variables: structuredClone(doc.variables) } : {}),
    ...(Object.keys(doc.datasets || {}).length ? { datasets: structuredClone(doc.datasets) } : {}),
    ...(Object.keys(doc.views || {}).length ? { views: structuredClone(doc.views) } : {}),
    ...(Object.keys(doc.computed || {}).length ? { computed: structuredClone(doc.computed) } : {}),
    ...(Array.isArray(doc.rules) && doc.rules.length ? { rules: structuredClone(doc.rules) } : {}),
    ...(Object.keys(doc.components || {}).length ? { components: structuredClone(doc.components) } : {}),
    pages: (doc.pages || []).map(p => ({
      id: p.id,
      name: p.name,
      ...(p.device ? { device: p.device } : {}),
      canvas: { w: p.canvas.w, h: p.canvas.h },
      root: cleanNodeForRp1(p.root),
      ...(Array.isArray(p.interactions) && p.interactions.length ? { interactions: structuredClone(p.interactions) } : {}),
    })),
  };
  return spec;
}

function cleanNodeForRp1(node) {
  if (!node || typeof node !== 'object') return node;
  const c = structuredClone(node);
  delete c.sourcePointer;
  delete c.macroSource;
  if (Array.isArray(c.children)) c.children = c.children.map(cleanNodeForRp1);
  if (Array.isArray(c.states)) {
    c.states = c.states.map(st => ({
      ...st,
      root: cleanNodeForRp1(st.root),
    }));
  }
  if (c.template) c.template = cleanNodeForRp1(c.template);
  return c;
}

export function createEmptyStudioDocument({ name = 'Untitled Project', documentId = 'studio-doc', device = 'iphone-17-pro', domain = 'mobile' } = {}) {
  // 桌面/网页域不该白送一个 iPhone 机架页：那会污染导出、也让 agent 误判上下文。
  if (domain && domain !== 'mobile') {
    const width = 1280;
    const height = 800;
    return importToStudioDocument(
      {
        language: 'rp/1',
        name,
        domain,
        theme: 'enterprise-light',
        pages: [
          {
            id: 'home',
            name: '首页',
            domain,
            canvas: { w: width, h: height },
            root: {
              type: 'box',
              id: 'home_root',
              layout: 'column',
              w: width,
              h: height,
              padding: 32,
              gap: 16,
              fill: '$bg',
              children: [],
            },
          },
        ],
      },
      { documentId }
    );
  }
  const doc = importToStudioDocument(
    {
      language: 'rp/1',
      name,
      domain: 'mobile',
      theme: 'mobile-hifi',
      device,
      pages: [
        {
          id: 'home',
          name: '首页',
          device,
          canvas: { w: 402, h: 874 },
          root: {
            type: 'phone-shell',
            id: 'home_shell',
            device,
            children: [
              {
                type: 'box',
                id: 'home_screen',
                layout: 'stack',
                padding: [DEVICE_PRESETS[device]?.safeAreaTop ?? 60, 0, 0, 0],
                w: 402,
                h: 874,
                fill: '$bg',
                children: [],
              },
            ],
          },
        },
      ],
    },
    { documentId }
  );
  ensureCoreComponentsRegistered(doc);
  doc.contentHash = computeContentHash(doc);
  return doc;
}

export function normalizeStudioDocument(doc, projectDir = null) {
  if (!doc || typeof doc !== 'object') return doc;
  doc.schemaVersion = doc.schemaVersion || STUDIO_SCHEMA_VERSION;
  doc.palette = doc.palette || { ...DEFAULT_THEMES['mobile-hifi'] };
  doc.tokens = doc.tokens || { colors: { ...doc.palette }, spacing: {}, radius: {}, typography: {} };
  doc.components = doc.components || {};
  ensureCoreComponentsRegistered(doc);
  doc.variables = doc.variables || {};
  doc.datasets = doc.datasets || {};
  doc.explorations = doc.explorations || [];
  doc.assetsManifest = doc.assetsManifest || {};
  doc.diagnostics = doc.diagnostics || [];
  if (projectDir) {
    localizeAssets(doc, projectDir, projectDir);
  }
  doc.contentHash = computeContentHash(doc);
  return doc;
}

