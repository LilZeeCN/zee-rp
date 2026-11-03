import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  STUDIO_SCHEMA_VERSION,
  buildNodeIndex,
  canonicalJson,
  computeContentHash,
  currentDocumentDiagnostics,
  normalizeStudioDocument,
  sha256,
} from './document.mjs';
import { NODE_PROPERTY_NAMES } from './node-properties.mjs';
import { classifyNodeCompatibility } from './export-rp.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import { repeaterDatasetName, repeaterInlineRows } from './repeater-view.mjs';
import { resolveFontDescriptor, SYSTEM_FONT_FILES } from './typography.mjs';
import { ensureProjectDirs, writeJsonAtomic } from './persistence.mjs';
import { diffDocuments } from './document-diff.mjs';

export const BUNDLE_FORMAT_VERSION = 1;

function bundleError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function normalizeRelPath(relPath) {
  const norm = String(relPath || '').split(sep).join('/').replace(/^\/+/, '');
  if (!norm || norm.includes('..') || isAbsolute(norm)) {
    throw bundleError('E_BUNDLE_PATH_UNSAFE', `工程包路径不安全或包含越界引用: ${relPath}`, { path: relPath });
  }
  return norm;
}

function listFilesRecursive(rootDir, currentDir = rootDir) {
  if (!existsSync(currentDir)) return [];
  const results = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(rootDir, full));
    } else if (entry.isFile()) {
      const rel = relative(rootDir, full).split(sep).join('/');
      const buf = readFileSync(full);
      results.push({
        path: rel,
        bytes: buf.length,
        sha256: sha256(buf),
      });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function extractTokenRefsFromNode(node, consumerScopedId, tokenUsageMap) {
  const addRef = (tokenName, prop) => {
    const clean = String(tokenName).replace(/^\$/, '').replace(/^--/, '');
    if (!clean) return;
    if (!tokenUsageMap.has(clean)) {
      tokenUsageMap.set(clean, { name: clean, consumers: new Set(), properties: new Set() });
    }
    const item = tokenUsageMap.get(clean);
    item.consumers.add(consumerScopedId);
    item.properties.add(prop);
  };

  for (const prop of ['fill', 'stroke', 'color', 'textColor', 'fontSize', 'gap', 'padding', 'columnGap', 'rowGap', 'radius', 'frameFill', 'bg']) {
    const val = node[prop];
    if (typeof val === 'string' && val.startsWith('$')) {
      addRef(val.slice(1), prop);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.startsWith('$')) addRef(item.slice(1), prop);
      }
    }
  }
  if (node.css && typeof node.css === 'object') {
    for (const [cssKey, cssVal] of Object.entries(node.css)) {
      const matches = String(cssVal || '').matchAll(/var\(\s*--([a-zA-Z0-9_-]+)\s*\)/g);
      for (const m of matches) addRef(m[1], `css.${cssKey}`);
    }
  }
}

function extractVariableRefsFromNode(node, consumerScopedId, varUsageMap) {
  const addVar = (varName, source) => {
    if (!varName) return;
    if (!varUsageMap.has(varName)) {
      varUsageMap.set(varName, { name: varName, consumers: new Set(), sources: new Set() });
    }
    const entry = varUsageMap.get(varName);
    entry.consumers.add(consumerScopedId);
    entry.sources.add(source);
  };

  for (const textField of ['text', 'content', 'value', 'title', 'subtitle', 'body']) {
    const raw = node[textField];
    if (typeof raw === 'string' && raw.startsWith('=')) {
      for (const m of raw.matchAll(/(?:var\.|\$)([a-zA-Z0-9_]+)/g)) {
        addVar(m[1], `formula:${textField}`);
      }
    }
  }

  const scanActions = actions => {
    for (const act of actions || []) {
      if (!act || typeof act !== 'object') continue;
      if ((act.type === 'setVariable' || act.type === 'set-variable') && act.variable) {
        addVar(act.variable, 'interaction:setVariable');
      }
      if (act.setVar && typeof act.setVar === 'object') {
        for (const k of Object.keys(act.setVar)) addVar(k, 'interaction:setVar');
      }
    }
  };
  if (node.on && typeof node.on === 'object') {
    for (const spec of Object.values(node.on)) {
      if (Array.isArray(spec)) scanActions(spec);
      else if (spec?.cases) {
        for (const c of spec.cases) scanActions(c.actions);
      }
    }
  }
}

export function computeDependencyClosure(doc, { projectDir = null } = {}) {
  const tokenUsageMap = new Map();
  const componentUsageMap = new Map();
  const variableUsageMap = new Map();
  const datasetUsageMap = new Map();
  const fontUsageMap = new Map();
  const assetUsageMap = new Map();

  const defaultFont = doc.fonts?.defaultFamily || 'PingFang SC';
  const registerFontUse = (family, consumerId) => {
    const clean = String(family || defaultFont).split(',')[0].replace(/['"]/g, '').trim();
    if (!clean) return;
    if (!fontUsageMap.has(clean)) {
      fontUsageMap.set(clean, { family: clean, consumers: new Set() });
    }
    fontUsageMap.get(clean).consumers.add(consumerId);
  };

  registerFontUse(defaultFont, 'document:defaultFamily');
  if (doc.fonts?.headingFamily) registerFontUse(doc.fonts.headingFamily, 'document:headingFamily');
  if (doc.fonts?.monoFamily) registerFontUse(doc.fonts.monoFamily, 'document:monoFamily');

  const visitedComponents = new Set();
  const visitComponentDef = compId => {
    if (!compId || visitedComponents.has(compId)) return;
    visitedComponents.add(compId);
    const comp = doc.components?.[compId];
    if (!comp?.root) return;
    walkTree(comp.root, `component/${compId}`);
  };

  function walkTree(node, scopePrefix) {
    if (!node || typeof node !== 'object') return;
    const scopedId = `${scopePrefix}/${node.id}`;

    extractTokenRefsFromNode(node, scopedId, tokenUsageMap);
    extractVariableRefsFromNode(node, scopedId, variableUsageMap);

    if (node.fontFamily || node.font || ['label', 'paragraph', 'button', 'badge', 'input'].includes(node.type)) {
      registerFontUse(node.fontFamily || node.font || defaultFont, scopedId);
    }
    if (Array.isArray(node.spans)) {
      for (const sp of node.spans) {
        if (sp?.fontFamily) registerFontUse(sp.fontFamily, scopedId);
      }
    }

    if (node.type === 'instance' || node.type === 'use' || node.component) {
      const compId = node.component || node.use;
      if (compId) {
        if (!componentUsageMap.has(compId)) {
          componentUsageMap.set(compId, { componentId: compId, instances: new Set(), variants: new Set() });
        }
        const entry = componentUsageMap.get(compId);
        entry.instances.add(scopedId);
        entry.variants.add(node.variant || node.variantKey || 'default');
        visitComponentDef(compId);
      }
    }

    if (node.type === 'repeater') {
      const dsName = repeaterDatasetName(node);
      if (dsName) {
        if (!datasetUsageMap.has(dsName)) {
          datasetUsageMap.set(dsName, { dataset: dsName, consumers: new Set() });
        }
        const entry = datasetUsageMap.get(dsName);
        entry.consumers.add(scopedId);
        if (entry.rowCount === undefined) {
          const declared = doc.datasets?.[dsName];
          const inlineRows = repeaterInlineRows(node);
          entry.rowCount = Array.isArray(declared) ? declared.length
            : Array.isArray(declared?.rows) ? declared.rows.length
            : inlineRows.length;
        }
      }
    }

    if (node.type === 'image' && node.src) {
      const src = String(node.src);
      const relPath = `assets/${basename(src)}`;
      if (!assetUsageMap.has(relPath)) {
        assetUsageMap.set(relPath, { relativePath: relPath, rawSources: new Set(), consumers: new Set() });
      }
      const entry = assetUsageMap.get(relPath);
      entry.rawSources.add(src);
      entry.consumers.add(scopedId);
    }

    for (const ch of node.children || []) walkTree(ch, scopePrefix);
    for (const st of node.states || []) {
      if (st?.root) walkTree(st.root, `${scopedId}/${st.id}`);
    }
    if (node.template) walkTree(node.template, `${scopedId}/template`);
  }

  for (const page of doc.pages || []) {
    if (page?.root) walkTree(page.root, page.id);
  }

  // Build resolved token closure
  const allColorTokens = { ...(doc.palette || {}), ...(doc.tokens?.colors || {}) };
  const usedTokens = {};
  const unresolvedTokens = [];
  for (const [name, info] of tokenUsageMap.entries()) {
    const value = Object.hasOwn(doc.tokens || {}, name) && typeof doc.tokens[name] !== 'object'
      ? doc.tokens[name]
      : allColorTokens[name] ?? null;
    if (value === null || value === undefined) {
      unresolvedTokens.push({ name, consumers: [...info.consumers] });
    }
    usedTokens[name] = {
      value,
      properties: [...info.properties],
      consumers: [...info.consumers],
    };
  }
  const allDeclaredTokenNames = new Set([
    ...Object.keys(allColorTokens),
    ...Object.keys(doc.tokens || {}).filter(k => typeof doc.tokens[k] === 'number' || typeof doc.tokens[k] === 'string'),
  ]);
  const unusedTokens = [...allDeclaredTokenNames].filter(k => !tokenUsageMap.has(k));

  // Build resolved component closure
  const usedComponents = {};
  const missingComponents = [];
  for (const [compId, info] of componentUsageMap.entries()) {
    const def = doc.components?.[compId];
    if (!def) {
      missingComponents.push({ componentId: compId, instances: [...info.instances] });
      continue;
    }
    usedComponents[compId] = {
      id: compId,
      name: def.name || compId,
      contractVersion: def.contractVersion || '1.0.0',
      definitionHash: sha256(canonicalJson(def)),
      instances: [...info.instances],
      variantsUsed: [...info.variants],
    };
  }
  const unusedComponents = Object.keys(doc.components || {}).filter(id => !componentUsageMap.has(id));

  // Build resolved font closure
  const catalogByFamily = new Map(
    (doc.fonts?.catalog || []).map(f => [String(f.family || '').toLowerCase(), f])
  );
  const usedFonts = {};
  const missingFonts = [];
  for (const [family, info] of fontUsageMap.entries()) {
    const desc = resolveFontDescriptor(family, { defaultFontFamily: defaultFont, projectDir, fontCatalog: doc.fonts?.catalog });
    const cat = catalogByFamily.get(family.toLowerCase()) || null;
    const isProjectFont = cat?.source === 'project' || Boolean(cat?.path);
    const relFontPath = cat?.path ? normalizeRelPath(cat.path) : null;
    const localFileExists = relFontPath && projectDir ? existsSync(join(projectDir, relFontPath)) : false;
    const entry = {
      family,
      source: isProjectFont ? 'project' : (SYSTEM_FONT_FILES[desc.resolvedFont] ? 'system' : 'external'),
      status: desc.status,
      resolvedFont: desc.resolvedFont,
      fallbackTo: desc.fallbackTo || null,
      fallbacks: cat?.fallbacks || ['PingFang SC', 'sans-serif'],
      relativePath: relFontPath,
      filePresentInProject: isProjectFont ? localFileExists : null,
      consumers: [...info.consumers],
      reason: desc.reason || null,
    };
    usedFonts[family] = entry;
    if (desc.status === 'fallback' || (isProjectFont && !localFileExists)) {
      missingFonts.push(entry);
    }
  }

  // Build resolved asset closure
  const usedAssets = {};
  const missingAssets = [];
  for (const [relPath, info] of assetUsageMap.entries()) {
    const manifestEntry = doc.assetsManifest?.[relPath]
      || [...info.rawSources].map(s => doc.assetsManifest?.[s]).find(Boolean)
      || null;
    const fileCandidate = projectDir ? join(projectDir, relPath) : null;
    const existsOnDisk = fileCandidate ? existsSync(fileCandidate) : false;
    let fileSha = manifestEntry?.sha256 || null;
    let bytes = manifestEntry?.bytes || 0;
    if (existsOnDisk) {
      const buf = readFileSync(fileCandidate);
      fileSha = sha256(buf);
      bytes = buf.length;
    }
    const missing = projectDir ? !existsOnDisk : Boolean(manifestEntry?.missing);
    const assetRecord = {
      relativePath: relPath,
      originalFileName: basename([...info.rawSources][0] || relPath),
      sha256: fileSha,
      bytes,
      width: manifestEntry?.width ?? null,
      height: manifestEntry?.height ?? null,
      missing,
      consumers: [...info.consumers],
    };
    usedAssets[relPath] = assetRecord;
    if (missing) missingAssets.push(assetRecord);
  }

  // Variables & Datasets
  const usedVariables = {};
  for (const [varName, info] of variableUsageMap.entries()) {
    usedVariables[varName] = {
      declared: Object.hasOwn(doc.variables || {}, varName),
      value: doc.variables?.[varName] ?? null,
      consumers: [...info.consumers],
      sources: [...info.sources],
    };
  }
  const usedDatasets = {};
  for (const [dsName, info] of datasetUsageMap.entries()) {
    const ds = doc.datasets?.[dsName];
    const rows = Array.isArray(ds) ? ds : ds?.rows || [];
    usedDatasets[dsName] = {
      declared: Object.hasOwn(doc.datasets || {}, dsName),
      rowCount: info.rowCount ?? rows.length,
      consumers: [...info.consumers],
    };
  }

  return {
    tokens: { used: usedTokens, unused: unusedTokens, unresolved: unresolvedTokens },
    components: { used: usedComponents, unused: unusedComponents, missing: missingComponents },
    fonts: { used: usedFonts, missing: missingFonts },
    assets: { used: usedAssets, missing: missingAssets },
    variables: { used: usedVariables },
    datasets: { used: usedDatasets },
  };
}

export function buildBundleCompatibilityReport(doc, { projectDir = null, scene = null, dependencyClosure = null } = {}) {
  const closure = dependencyClosure || computeDependencyClosure(doc, { projectDir });
  let resolvedScene = scene;
  let sceneError = null;
  if (!resolvedScene) {
    try {
      resolvedScene = resolveDocumentScene(doc, { projectDir });
    } catch (err) {
      sceneError = err;
      resolvedScene = { pages: [], fontDiagnostics: [] };
    }
  }
  const nodeReports = [];
  let nativeEditable = 0;
  let rasterizedEffects = 0;
  let unsupportedFeatures = 0;

  for (const page of resolvedScene.pages || []) {
    for (const node of page.nodes || []) {
      const entries = [];
      classifyNodeCompatibility(node, page.id, entries);
      // A repeater with pageSize/filter/sort keeps the list native-editable but carries
      // explicit boundary features; surface them instead of hiding them behind the
      // default native-editable entry so readers see the export is not equivalent.
      const repeaterBoundary = entries.find(e => typeof e.feature === 'string' && e.feature.startsWith('repeater.'));
      const compat = repeaterBoundary || entries[entries.length - 1] || { classification: 'native-editable', reasons: [] };
      if (compat.classification === 'native-editable') nativeEditable++;
      else if (compat.classification === 'rasterized-effect') rasterizedEffects++;
      else unsupportedFeatures++;
      nodeReports.push({
        scopedId: node.scopedId,
        pageId: page.id,
        id: node.id,
        type: node.type,
        classification: compat.classification,
        reasons: compat.reasons || (compat.reason ? [compat.reason] : []),
        surfaceSupport: {
          canvas: 'implemented',
          runtime: 'implemented',
          native: compat.classification,
        },
      });
    }
  }

  const diagnostics = [
    ...(currentDocumentDiagnostics(doc) || []),
    ...(resolvedScene.fontDiagnostics || []),
  ];

  for (const missingAsset of closure.assets.missing) {
    diagnostics.push({
      code: 'W_ASSET_FILE_MISSING',
      legacyCode: 'E_MISSING_ASSET',
      severity: 'warning',
      relativePath: missingAsset.relativePath,
      consumers: missingAsset.consumers,
      message: `工程图片资源缺失: ${missingAsset.relativePath}（引用节点: ${missingAsset.consumers.join(', ')}）`,
    });
  }

  for (const missingFont of closure.fonts.missing) {
    diagnostics.push({
      code: 'W_FONT_FILE_MISSING',
      legacyCode: 'E_FONT_FALLBACK',
      severity: 'warning',
      fontFamily: missingFont.family,
      fallbackTo: missingFont.fallbackTo,
      relativePath: missingFont.relativePath,
      consumers: missingFont.consumers,
      message: missingFont.reason || `字体 "${missingFont.family}" 未找到，已按回退规则切换至 "${missingFont.fallbackTo || 'PingFang SC'}"`,
    });
  }

  for (const unresToken of closure.tokens.unresolved) {
    diagnostics.push({
      code: 'W_UNRESOLVED_TOKEN',
      severity: 'warning',
      token: unresToken.name,
      consumers: unresToken.consumers,
      message: `令牌 "$${unresToken.name}" 未声明定义（引用节点: ${(unresToken.consumers || []).join(', ')}）`,
    });
  }

  for (const missingComp of closure.components.missing) {
    diagnostics.push({
      code: 'E_MISSING_COMPONENT_DEFINITION',
      severity: 'error',
      componentId: missingComp.componentId,
      instances: missingComp.instances,
      message: `组件定义 "${missingComp.componentId}" 缺失（实例: ${(missingComp.instances || []).join(', ')}）`,
    });
  }

  if (doc.readonlyUnknownFields && Object.keys(doc.readonlyUnknownFields).length > 0) {
    diagnostics.push({
      code: 'W_UNKNOWN_FIELDS_READONLY',
      severity: 'info',
      fields: Object.keys(doc.readonlyUnknownFields),
      message: `保留了较新或扩展格式字段 (${Object.keys(doc.readonlyUnknownFields).join(', ')}) 为只读元数据，未静默丢弃`,
    });
  }

  const portable =
    closure.assets.missing.length === 0 &&
    closure.components.missing.length === 0 &&
    closure.tokens.unresolved.length === 0;

  return {
    portable,
    schemaVersion: doc.schemaVersion || STUDIO_SCHEMA_VERSION,
    supportedSchemaVersion: STUDIO_SCHEMA_VERSION,
    documentId: doc.documentId,
    revision: doc.revision,
    contentHash: doc.contentHash,
    summary: {
      totalNodes: nodeReports.length,
      nativeEditable,
      rasterizedEffects,
      unsupportedFeatures,
      missingAssets: closure.assets.missing.length,
      missingFonts: closure.fonts.missing.length,
      missingComponents: closure.components.missing.length,
      unresolvedTokens: closure.tokens.unresolved.length,
      preservedUnknownFields: Object.keys(doc.readonlyUnknownFields || {}).length,
    },
    dependencyClosure: closure,
    nodes: nodeReports,
    diagnostics,
  };
}

function sanitizeDocumentForPortableBundle(doc) {
  const clean = structuredClone(doc);
  if (clean.sourceMeta) {
    clean.sourceMeta = {
      ...clean.sourceMeta,
      originalSourceName: clean.sourceMeta.originalSourcePath ? basename(String(clean.sourceMeta.originalSourcePath)) : null,
      originalSourcePath: null,
    };
  }
  const cleanManifest = {};
  for (const [key, entry] of Object.entries(clean.assetsManifest || {})) {
    const relKey = key.startsWith('assets/') ? key : `assets/${basename(key)}`;
    cleanManifest[relKey] = {
      ...entry,
      relativePath: relKey,
      originalSrc: entry?.originalSrc ? basename(String(entry.originalSrc)) : basename(relKey),
    };
    if (cleanManifest[relKey].media?.originalPath) {
      cleanManifest[relKey].media = {
        ...cleanManifest[relKey].media,
        originalPath: `assets/${basename(String(cleanManifest[relKey].media.originalPath))}`,
      };
    }
  }
  clean.assetsManifest = cleanManifest;

  const sanitizeNodePaths = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image' && node.src) {
      node.src = `assets/${basename(String(node.src))}`;
    }
    for (const ch of node.children || []) sanitizeNodePaths(ch);
    for (const st of node.states || []) if (st?.root) sanitizeNodePaths(st.root);
    if (node.template) sanitizeNodePaths(node.template);
  };
  for (const pg of clean.pages || []) sanitizeNodePaths(pg.root);
  for (const comp of Object.values(clean.components || {})) sanitizeNodePaths(comp.root);

  if (Array.isArray(clean.fonts?.catalog)) {
    clean.fonts.catalog = clean.fonts.catalog.map(f => ({
      ...f,
      ...(f.path ? { path: isAbsolute(String(f.path)) ? `fonts/${basename(String(f.path))}` : normalizeRelPath(f.path) } : {}),
    }));
  }

  clean.contentHash = computeContentHash(clean);
  return clean;
}

function buildThumbnailSvg(doc, scene) {
  const firstPage = scene.pages?.[0];
  const w = firstPage?.board?.screenW || 402;
  const h = firstPage?.board?.screenH || 874;
  const bg = doc.palette?.bg || '#F7F8F2';
  const rects = (firstPage?.nodes || []).slice(0, 40).map(n => {
    if (n.visible === false) return '';
    const fill = n.fill && n.fill !== '#FFFFFF00' ? n.fill : 'none';
    const stroke = n.stroke && n.stroke !== '#FFFFFF00' ? n.stroke : 'none';
    const r = Number(n.radius || 0);
    return `<rect x="${Math.round(n.x || 0)}" y="${Math.round(n.y || 0)}" width="${Math.max(1, Math.round(n.w || 0))}" height="${Math.max(1, Math.round(n.h || 0))}" rx="${r}" fill="${fill}" stroke="${stroke}" />`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n  <rect width="${w}" height="${h}" fill="${bg}" />\n  ${rects}\n</svg>\n`;
}

export function exportProjectBundle({
  projectDir,
  bundleDir,
  outDir,
  doc: explicitDoc = null,
  includeVersions = true,
  includeThumbnails = true,
} = {}) {
  if (!projectDir && !explicitDoc) {
    throw bundleError('E_BUNDLE_ARGS', 'exportProjectBundle 需要 projectDir 或 doc');
  }
  const targetBundleDir = bundleDir || outDir;
  if (!targetBundleDir) {
    throw bundleError('E_BUNDLE_ARGS', 'exportProjectBundle 需要目标 bundleDir');
  }
  const absProjectDir = projectDir ? resolve(projectDir) : null;
  const absBundleDir = resolve(targetBundleDir);
  mkdirSync(absBundleDir, { recursive: true });
  mkdirSync(join(absBundleDir, 'assets'), { recursive: true });
  mkdirSync(join(absBundleDir, 'fonts'), { recursive: true });

  const rawDoc = explicitDoc
    ? structuredClone(explicitDoc)
    : JSON.parse(readFileSync(join(absProjectDir, 'document.json'), 'utf8'));

  const portableDoc = sanitizeDocumentForPortableBundle(rawDoc);
  // 身份口径统一（S3-2）：contentHash 与 get_context / export_code 报告同一实时文档哈希；
  // 可移植净化产物自身的哈希单列 portableContentHash，verify 按其校验完整性。
  const sourceContentHash = rawDoc.contentHash ?? computeContentHash(rawDoc);
  const dependencyClosure = computeDependencyClosure(portableDoc, { projectDir: absProjectDir });

  // Copy referenced assets into bundleDir/assets/
  for (const [relPath] of Object.entries(dependencyClosure.assets.used)) {
    const safeRel = normalizeRelPath(relPath);
    const srcFile = absProjectDir ? join(absProjectDir, safeRel) : null;
    if (srcFile && existsSync(srcFile)) {
      const destFile = join(absBundleDir, safeRel);
      mkdirSync(dirname(destFile), { recursive: true });
      copyFileSync(srcFile, destFile);
      const buf = readFileSync(destFile);
      if (portableDoc.assetsManifest?.[safeRel]) {
        portableDoc.assetsManifest[safeRel].sha256 = sha256(buf);
        portableDoc.assetsManifest[safeRel].bytes = buf.length;
        portableDoc.assetsManifest[safeRel].missing = false;
      }
    }
  }
  // Also copy any original media source referenced in assetsManifest[k].media.originalPath
  for (const entry of Object.values(portableDoc.assetsManifest || {})) {
    const origRel = entry?.media?.originalPath;
    if (origRel && origRel.startsWith('assets/') && absProjectDir) {
      const srcOrig = join(absProjectDir, origRel);
      if (existsSync(srcOrig)) {
        const destOrig = join(absBundleDir, origRel);
        if (!existsSync(destOrig)) copyFileSync(srcOrig, destOrig);
      }
    }
  }

  // Copy the actual referenced font paths, including nested directories.
  if (portableDoc.fonts?.catalog) {
    portableDoc.fonts.catalog = portableDoc.fonts.catalog.filter(font => dependencyClosure.fonts.used[font.family]);
  }
  for (const fontEntry of portableDoc.fonts?.catalog || []) {
    if (fontEntry.path && absProjectDir) {
      const safeRel = normalizeRelPath(fontEntry.path);
      const srcFont = join(absProjectDir, safeRel);
      if (existsSync(srcFont)) {
        const destFont = join(absBundleDir, safeRel);
        mkdirSync(dirname(destFont), { recursive: true });
        if (!existsSync(destFont)) copyFileSync(srcFont, destFont);
      }
    }
  }

  portableDoc.contentHash = computeContentHash(portableDoc);
  const portableContentHash = portableDoc.contentHash;
  portableDoc.portableContentHash = portableContentHash;
  portableDoc.contentHash = sourceContentHash;
  const scene = resolveDocumentScene(portableDoc, { projectDir: absBundleDir });
  const finalClosure = computeDependencyClosure(portableDoc, { projectDir: absBundleDir });
  const compatibilityReport = buildBundleCompatibilityReport(portableDoc, {
    projectDir: absBundleDir,
    scene,
    dependencyClosure: finalClosure,
  });

  // Copy named versions if requested
  if (includeVersions && absProjectDir && existsSync(join(absProjectDir, 'versions'))) {
    const versionsDir = join(absBundleDir, 'versions');
    mkdirSync(versionsDir, { recursive: true });
    for (const entry of readdirSync(join(absProjectDir, 'versions'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        if (entry.name === 'index.json') {
          copyFileSync(join(absProjectDir, 'versions', entry.name), join(versionsDir, entry.name));
        } else {
          const verRec = JSON.parse(readFileSync(join(absProjectDir, 'versions', entry.name), 'utf8'));
          if (verRec?.document) {
            verRec.document = sanitizeDocumentForPortableBundle(verRec.document);
            verRec.contentHash = verRec.document.contentHash;
            if (verRec.metadata) verRec.metadata.contentHash = verRec.document.contentHash;
            verRec.sha256 = sha256(canonicalJson(verRec.document));
          }
          writeJsonAtomic(join(versionsDir, entry.name), verRec);
        }
      }
    }
  }

  // Write thumbnail preview
  if (includeThumbnails) {
    const thumbDir = join(absBundleDir, 'thumbnails');
    mkdirSync(thumbDir, { recursive: true });
    writeFileSync(join(thumbDir, `${portableDoc.pages?.[0]?.id || 'home'}.svg`), buildThumbnailSvg(portableDoc, scene), 'utf8');
  }

  const projectMeta = {
    schemaVersion: portableDoc.schemaVersion || STUDIO_SCHEMA_VERSION,
    documentId: portableDoc.documentId,
    name: portableDoc.name,
    domain: portableDoc.domain || 'mobile',
    appliedRevision: portableDoc.revision,
    durableRevision: portableDoc.revision,
    contentHash: sourceContentHash,
    portableContentHash,
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(join(absBundleDir, 'document.json'), portableDoc);
  writeJsonAtomic(join(absBundleDir, 'project.json'), projectMeta);
  writeJsonAtomic(join(absBundleDir, 'compatibility-report.json'), compatibilityReport);

  const files = listFilesRecursive(absBundleDir).filter(f => f.path !== 'bundle-manifest.json');
  const manifest = {
    format: `zee-studio-bundle/v${BUNDLE_FORMAT_VERSION}`,
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    schemaVersion: portableDoc.schemaVersion || STUDIO_SCHEMA_VERSION,
    documentId: portableDoc.documentId,
    name: portableDoc.name,
    revision: portableDoc.revision,
    contentHash: sourceContentHash,
    portableContentHash,
    createdAt: new Date().toISOString(),
    migrationHistory: portableDoc.migrationHistory || [],
    dependencyClosure: finalClosure,
    compatibilitySummary: compatibilityReport.summary,
    files,
  };
  writeJsonAtomic(join(absBundleDir, 'bundle-manifest.json'), manifest);

  return {
    ok: true,
    bundleDir: absBundleDir,
    documentId: portableDoc.documentId,
    revision: portableDoc.revision,
    contentHash: sourceContentHash,
    portableContentHash,
    manifest,
    compatibilityReport,
  };
}

export function verifyProjectBundle({ bundleDir } = {}) {
  if (!bundleDir) throw bundleError('E_BUNDLE_ARGS', 'verifyProjectBundle 需要 bundleDir');
  const absBundleDir = resolve(bundleDir);
  const manifestPath = join(absBundleDir, 'bundle-manifest.json');
  const docPath = join(absBundleDir, 'document.json');
  if (!existsSync(manifestPath) || !existsSync(docPath)) {
    throw bundleError('E_BUNDLE_MISSING', `工程包缺少 bundle-manifest.json 或 document.json: ${absBundleDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const doc = JSON.parse(readFileSync(docPath, 'utf8'));

  const fileMismatches = [];
  for (const fileEntry of manifest.files || []) {
    const safeRel = normalizeRelPath(fileEntry.path);
    const full = join(absBundleDir, safeRel);
    if (!existsSync(full)) {
      fileMismatches.push({ path: safeRel, reason: 'missing', code: 'E_BUNDLE_FILE_MISSING' });
      continue;
    }
    const buf = readFileSync(full);
    const actualSha = sha256(buf);
    if (actualSha !== fileEntry.sha256 || buf.length !== fileEntry.bytes) {
      fileMismatches.push({
        path: safeRel,
        reason: 'hash-mismatch',
        code: 'E_BUNDLE_FILE_HASH_MISMATCH',
        expectedSha256: fileEntry.sha256,
        actualSha256: actualSha,
      });
    }
  }

  // Verify zero machine-local absolute paths in active asset/font references
  const absolutePathLeaks = [];
  if (doc.sourceMeta?.originalSourcePath && isAbsolute(String(doc.sourceMeta.originalSourcePath))) {
    absolutePathLeaks.push({ location: 'sourceMeta.originalSourcePath', value: doc.sourceMeta.originalSourcePath });
  }
  for (const [k, v] of Object.entries(doc.assetsManifest || {})) {
    if (isAbsolute(k) || (v?.relativePath && isAbsolute(String(v.relativePath)))) {
      absolutePathLeaks.push({ location: `assetsManifest.${k}`, value: v?.relativePath || k });
    }
  }
  const scanNodeLeaks = (node, ptr) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image' && node.src && isAbsolute(String(node.src))) {
      absolutePathLeaks.push({ location: `${ptr}.src`, value: node.src });
    }
    for (const [idx, ch] of (node.children || []).entries()) scanNodeLeaks(ch, `${ptr}/children/${idx}`);
    for (const [idx, st] of (node.states || []).entries()) if (st?.root) scanNodeLeaks(st.root, `${ptr}/states/${idx}/root`);
    if (node.template) scanNodeLeaks(node.template, `${ptr}/template`);
  };
  for (const [idx, pg] of (doc.pages || []).entries()) scanNodeLeaks(pg.root, `/pages/${idx}/root`);

  const computedHash = computeContentHash(doc);
  // 完整性按可移植产物哈希校验（S3-2）；旧格式包无 portableContentHash 字段时回退 contentHash
  const expectedPortableHash = doc.portableContentHash ?? doc.contentHash;
  const expectedManifestPortableHash = manifest.portableContentHash ?? manifest.contentHash;
  const hashMatches = computedHash === expectedPortableHash && computedHash === expectedManifestPortableHash;
  const dependencyClosure = computeDependencyClosure(doc, { projectDir: absBundleDir });
  const compatibilityReport = buildBundleCompatibilityReport(doc, {
    projectDir: absBundleDir,
    dependencyClosure,
  });

  const issues = [
    ...fileMismatches.map(m => ({
      code: m.code || 'E_BUNDLE_FILE_HASH_MISMATCH',
      path: m.path,
      reason: m.reason,
    })),
    ...absolutePathLeaks.map(l => ({
      code: 'E_BUNDLE_ABSOLUTE_PATH_LEAK',
      location: l.location,
      value: l.value,
    })),
    ...(!hashMatches ? [{ code: 'E_BUNDLE_DOC_HASH_MISMATCH', computedHash, expectedHash: expectedPortableHash }] : []),
  ];

  const valid = fileMismatches.length === 0 && absolutePathLeaks.length === 0 && hashMatches;
  return {
    ok: valid,
    bundleDir: absBundleDir,
    documentId: doc.documentId,
    revision: doc.revision,
    contentHash: doc.contentHash,
    computedHash,
    hashMatches,
    issues,
    fileMismatches,
    absolutePathLeaks,
    dependencyClosure,
    compatibilityReport,
  };
}

export function migrateAndPreserveSchema(rawDoc, { allowNewerSchema = true } = {}) {
  const doc = structuredClone(rawDoc);
  const incomingVersion = Number(doc.schemaVersion ?? 0);
  doc.migrationHistory = Array.isArray(doc.migrationHistory) ? [...doc.migrationHistory] : [];
  const diagnostics = [];
  let migrated = false;

  // Preserve unknown node-level fields into node._readonlyPreservedFields so they are never silently dropped
  let preservedNodeFieldCount = 0;
  const preserveUnknownNodeFields = (node, ptr = '') => {
    if (!node || typeof node !== 'object') return;
    const unknown = {};
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('_') || ['id', 'type', 'sourcePointer', 'macroSource', 'componentSource'].includes(k)) continue;
      if (!NODE_PROPERTY_NAMES.has(k)) {
        unknown[k] = structuredClone(v);
        delete node[k];
      }
    }
    if (Object.keys(unknown).length > 0) {
      preservedNodeFieldCount += Object.keys(unknown).length;
      node._readonlyPreservedFields = { ...(node._readonlyPreservedFields || {}), ...unknown };
      diagnostics.push({
        code: 'W_UNKNOWN_FIELDS_READONLY',
        severity: 'warning',
        pointer: ptr,
        fields: Object.keys(unknown),
        message: `节点 ${node.id || ptr} 未知扩展字段 (${Object.keys(unknown).join(', ')}) 已作为只读元数据保留`,
      });
    }
    for (const [idx, ch] of (node.children || []).entries()) preserveUnknownNodeFields(ch, `${ptr}/children/${idx}`);
    for (const [idx, st] of (node.states || []).entries()) if (st?.root) preserveUnknownNodeFields(st.root, `${ptr}/states/${idx}/root`);
    if (node.template) preserveUnknownNodeFields(node.template, `${ptr}/template`);
  };

  if (incomingVersion > STUDIO_SCHEMA_VERSION) {
    if (!allowNewerSchema) {
      throw bundleError(
        'E_SCHEMA_VERSION_UNSUPPORTED',
        `工程包 schemaVersion (${incomingVersion}) 高于当前支持的 ${STUDIO_SCHEMA_VERSION}`,
        { schemaVersion: incomingVersion, supported: STUDIO_SCHEMA_VERSION }
      );
    }
    migrated = true;
    const KNOWN_TOP_KEYS = new Set([
      'schemaVersion', 'documentId', 'revision', 'name', 'language', 'target', 'domain',
      'theme', 'device', 'palette', 'tokens', 'fonts', 'variables', 'datasets', 'views',
      'computed', 'rules', 'statecharts', 'masters', 'adaptiveViews', 'components', 'pages',
      'assetsManifest', 'diagnostics', 'sourceMeta', 'designDecisions', 'explorations',
      'contentHash', 'migrationHistory', 'readonlyUnknownFields',
    ]);
    const preservedTop = {};
    for (const [k, v] of Object.entries(doc)) {
      if (!KNOWN_TOP_KEYS.has(k)) {
        preservedTop[k] = structuredClone(v);
        delete doc[k];
      }
    }
    for (const [idx, pg] of (doc.pages || []).entries()) preserveUnknownNodeFields(pg.root, `/pages/${idx}/root`);
    for (const [cid, comp] of Object.entries(doc.components || {})) preserveUnknownNodeFields(comp.root, `/components/${cid}/root`);
    doc.readonlyUnknownFields = {
      ...(doc.readonlyUnknownFields || {}),
      fromSchemaVersion: incomingVersion,
      topLevel: preservedTop,
    };
    diagnostics.push({
      code: 'W_SCHEMA_FORWARD_COMPAT',
      severity: 'warning',
      fromSchemaVersion: incomingVersion,
      toSchemaVersion: STUDIO_SCHEMA_VERSION,
      message: `工程 schemaVersion (${incomingVersion}) 高于当前版本 (${STUDIO_SCHEMA_VERSION})，已启用前向兼容只读保护`,
    });
    if (Object.keys(preservedTop).length > 0) {
      diagnostics.push({
        code: 'W_UNKNOWN_FIELDS_READONLY',
        severity: 'warning',
        pointer: '/',
        fields: Object.keys(preservedTop),
        message: `顶层未知字段 (${Object.keys(preservedTop).join(', ')}) 已作为只读元数据保留`,
      });
    }
    doc.migrationHistory.push({
      fromVersion: incomingVersion,
      toVersion: STUDIO_SCHEMA_VERSION,
      mode: 'forward-compatible-readonly',
      migratedAt: new Date().toISOString(),
      preservedTopKeys: Object.keys(preservedTop),
    });
    doc.schemaVersion = STUDIO_SCHEMA_VERSION;
  } else if (incomingVersion < STUDIO_SCHEMA_VERSION) {
    migrated = true;
    for (const [idx, pg] of (doc.pages || []).entries()) preserveUnknownNodeFields(pg.root, `/pages/${idx}/root`);
    doc.migrationHistory.push({
      fromVersion: incomingVersion,
      toVersion: STUDIO_SCHEMA_VERSION,
      mode: 'upgrade',
      migratedAt: new Date().toISOString(),
    });
    doc.schemaVersion = STUDIO_SCHEMA_VERSION;
  } else {
    for (const [idx, pg] of (doc.pages || []).entries()) preserveUnknownNodeFields(pg.root, `/pages/${idx}/root`);
    if (preservedNodeFieldCount > 0) migrated = true;
  }
  doc.migrated = migrated;
  doc.doc = doc;
  doc.migrationDiagnostics = diagnostics;
  return {
    migrated,
    doc,
    diagnostics,
  };
}

export function importProjectBundle({
  bundleDir,
  targetProjectDir,
  allowNewerSchema = true,
} = {}) {
  if (!bundleDir || !targetProjectDir) {
    throw bundleError('E_BUNDLE_ARGS', 'importProjectBundle 需要 bundleDir 和 targetProjectDir');
  }
  const verification = verifyProjectBundle({ bundleDir });
  if (!verification.ok) {
    throw bundleError(
      'E_BUNDLE_INTEGRITY',
      `工程包完整性校验未通过: mismatches=${verification.fileMismatches.length}, leaks=${verification.absolutePathLeaks.length}, hashMatches=${verification.hashMatches}`,
      { verification }
    );
  }

  const absBundleDir = resolve(bundleDir);
  const absTargetDir = ensureProjectDirs(targetProjectDir);
  mkdirSync(join(absTargetDir, 'fonts'), { recursive: true });

  // Copy assets and fonts
  for (const subdir of ['assets', 'fonts', 'versions', 'thumbnails']) {
    const srcSub = join(absBundleDir, subdir);
    if (!existsSync(srcSub)) continue;
    const dstSub = join(absTargetDir, subdir);
    mkdirSync(dstSub, { recursive: true });
    for (const entry of listFilesRecursive(srcSub)) {
      const dest = join(dstSub, entry.path);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(srcSub, entry.path), dest);
    }
  }

  const rawDoc = JSON.parse(readFileSync(join(absBundleDir, 'document.json'), 'utf8'));
  const { doc: migratedDoc } = migrateAndPreserveSchema(rawDoc, { allowNewerSchema });
  delete migratedDoc.doc;
  delete migratedDoc.migrated;
  delete migratedDoc.migrationDiagnostics;
  const normalizedDoc = normalizeStudioDocument(migratedDoc, absTargetDir);
  // If no migration changed the schema, keep exact contentHash from bundle
  const projectMeta = {
    schemaVersion: normalizedDoc.schemaVersion,
    documentId: normalizedDoc.documentId,
    name: normalizedDoc.name,
    domain: normalizedDoc.domain || 'mobile',
    appliedRevision: normalizedDoc.revision,
    durableRevision: normalizedDoc.revision,
    contentHash: normalizedDoc.contentHash,
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(join(absTargetDir, 'document.json'), normalizedDoc);
  writeJsonAtomic(join(absTargetDir, 'project.json'), projectMeta);
  writeJsonAtomic(
    join(absTargetDir, 'history', 'snapshots', `rev-${normalizedDoc.revision}.json`),
    normalizedDoc
  );
  copyFileSync(join(absBundleDir, 'bundle-manifest.json'), join(absTargetDir, 'bundle-manifest.json'));

  const compatibilityReport = buildBundleCompatibilityReport(normalizedDoc, { projectDir: absTargetDir });
  writeJsonAtomic(join(absTargetDir, 'compatibility-report.json'), compatibilityReport);

  return {
    ok: true,
    projectDir: absTargetDir,
    documentId: normalizedDoc.documentId,
    revision: normalizedDoc.revision,
    contentHash: normalizedDoc.contentHash,
    migrationHistory: normalizedDoc.migrationHistory || [],
    compatibilityReport,
  };
}

export function compareProjectWithBundle({ doc: explicitDoc = null, projectDir, bundleDir } = {}) {
  if ((!projectDir && !explicitDoc) || !bundleDir) {
    throw bundleError('E_BUNDLE_ARGS', 'compareProjectWithBundle 需要 projectDir/doc 和 bundleDir');
  }
  const localDoc = explicitDoc || JSON.parse(readFileSync(join(resolve(projectDir), 'document.json'), 'utf8'));
  const bundleDoc = JSON.parse(readFileSync(join(resolve(bundleDir), 'document.json'), 'utf8'));

  const localClosure = computeDependencyClosure(localDoc, { projectDir: projectDir ? resolve(projectDir) : null });
  const bundleClosure = computeDependencyClosure(bundleDoc, { projectDir: resolve(bundleDir) });
  const diff = diffDocuments(bundleDoc, localDoc);

  const tokenDiffs = [];
  const allTokens = new Set([
    ...Object.keys(localClosure.tokens.used),
    ...Object.keys(bundleClosure.tokens.used),
  ]);
  for (const name of allTokens) {
    const lv = localClosure.tokens.used[name]?.value ?? null;
    const bv = bundleClosure.tokens.used[name]?.value ?? null;
    if (canonicalJson(lv) !== canonicalJson(bv)) {
      tokenDiffs.push({ name, localValue: lv, bundleValue: bv });
    }
  }

  const componentDiffs = [];
  const allComps = new Set([
    ...Object.keys(localDoc.components || {}),
    ...Object.keys(bundleDoc.components || {}),
  ]);
  for (const id of allComps) {
    const lc = localDoc.components?.[id];
    const bc = bundleDoc.components?.[id];
    if (!lc) componentDiffs.push({ componentId: id, kind: 'added-in-bundle', bundleContractVersion: bc.contractVersion || '1.0.0' });
    else if (!bc) componentDiffs.push({ componentId: id, kind: 'removed-in-bundle', localContractVersion: lc.contractVersion || '1.0.0' });
    else if (canonicalJson(lc) !== canonicalJson(bc)) {
      componentDiffs.push({
        componentId: id,
        kind: 'modified',
        localContractVersion: lc.contractVersion || '1.0.0',
        bundleContractVersion: bc.contractVersion || '1.0.0',
      });
    }
  }

  const assetDiffs = [];
  const allAssets = new Set([
    ...Object.keys(localClosure.assets.used),
    ...Object.keys(bundleClosure.assets.used),
  ]);
  for (const rel of allAssets) {
    const la = localClosure.assets.used[rel];
    const ba = bundleClosure.assets.used[rel];
    if (!la) assetDiffs.push({ relativePath: rel, kind: 'added-in-bundle', bundleSha256: ba.sha256 });
    else if (!ba) assetDiffs.push({ relativePath: rel, kind: 'removed-in-bundle', localSha256: la.sha256 });
    else if (la.sha256 !== ba.sha256) {
      assetDiffs.push({ relativePath: rel, kind: 'changed', localSha256: la.sha256, bundleSha256: ba.sha256 });
    }
  }

  return {
    ok: true,
    localRevision: localDoc.revision,
    bundleRevision: bundleDoc.revision,
    localContentHash: localDoc.contentHash,
    bundleContentHash: bundleDoc.contentHash,
    diff,
    tokenDiffs,
    componentDiffs,
    assetDiffs,
    identical: tokenDiffs.length === 0 && componentDiffs.length === 0 && assetDiffs.length === 0 && localDoc.contentHash === bundleDoc.contentHash,
  };
}
