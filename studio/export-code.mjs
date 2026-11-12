import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { sha256 } from './document.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import { evaluatePrototypeExpression, executePrototypeInteraction } from './prototype-runtime.mjs';
import { textSpanCss, visualCss } from './visual-style.mjs';
import { repeaterDatasetName, repeaterInlineRows } from './repeater-view.mjs';
import { locateDiagnostic } from './diagnostics.mjs';
import { computeDependencyClosure } from './project-bundle.mjs';

export const CODE_EXPORTER_VERSION = '1.0.0';

const SUPPORTED_EVENTS = new Set(['click', 'input', 'change']);
const SUPPORTED_ACTION_TYPES = new Set([
  'link',
  'navigate',
  'show',
  'hide',
  'toggle',
  'set-text',
  'set-var',
  'set-variable',
  'set-panel-state',
  'dataset-select',
  'dataset-toggle-select',
  'dataset-add',
  'dataset-update',
  'dataset-delete',
  'dataset-filter',
  'dataset-sort',
  'dataset-page',
  'repeater-select',
  'repeater-toggle-select',
  'repeater-add',
  'repeater-update',
  'repeater-delete',
  'repeater-filter',
  'repeater-sort',
  'repeater-page',
]);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inspectActionSpec(spec, outSupported, outUnsupported, context) {
  if (!spec) return;
  if (Array.isArray(spec)) {
    for (const item of spec) inspectActionSpec(item, outSupported, outUnsupported, context);
    return;
  }
  if (typeof spec === 'string') {
    outSupported.push({ ...context, actionType: 'link', target: spec });
    return;
  }
  if (typeof spec !== 'object') {
    outUnsupported.push({
      ...context,
      actionType: typeof spec,
      reason: `不支持的交互动作格式：${typeof spec}`,
    });
    return;
  }

  if (Array.isArray(spec.cases)) {
    for (const c of spec.cases) {
      inspectActionSpec(c, outSupported, outUnsupported, context);
    }
    return;
  }
  if (spec.when !== undefined || spec.if !== undefined || spec.else !== undefined) {
    if (spec.then) inspectActionSpec(spec.then, outSupported, outUnsupported, context);
    if (spec.else && typeof spec.else === 'object') inspectActionSpec(spec.else, outSupported, outUnsupported, context);
    if (Array.isArray(spec.actions)) {
      for (const sub of spec.actions) inspectActionSpec(sub, outSupported, outUnsupported, context);
      return;
    }
    if (spec.then || (spec.else && typeof spec.else === 'object')) return;
  }

  let matchedAny = false;
  const actType = spec.type || spec.action || null;
  if (actType) {
    if (SUPPORTED_ACTION_TYPES.has(actType)) {
      outSupported.push({ ...context, actionType: actType, target: spec.target || spec.page || spec.to || spec.panel || spec.dataset || null });
      matchedAny = true;
    } else {
      outUnsupported.push({
        ...context,
        actionType: actType,
        reason: `代码出口首版不支持动作类型 "${actType}"`,
      });
      return;
    }
  }
  if (spec.setVar && typeof spec.setVar === 'object') {
    outSupported.push({ ...context, actionType: 'set-var', keys: Object.keys(spec.setVar) });
    matchedAny = true;
  }
  if (spec.show) {
    outSupported.push({ ...context, actionType: 'show', target: spec.show });
    matchedAny = true;
  }
  if (spec.hide) {
    outSupported.push({ ...context, actionType: 'hide', target: spec.hide });
    matchedAny = true;
  }
  if (spec.setText && typeof spec.setText === 'object') {
    outSupported.push({ ...context, actionType: 'set-text', keys: Object.keys(spec.setText) });
    matchedAny = true;
  }
  if (spec.setPanelState) {
    outSupported.push({ ...context, actionType: 'set-panel-state', target: spec.setPanelState });
    matchedAny = true;
  }
  if (spec.datasetAction) {
    outSupported.push({ ...context, actionType: `dataset-${spec.datasetAction.op || 'action'}`, target: spec.datasetAction.dataset || spec.datasetAction.repeater || null });
    matchedAny = true;
  }
  if (spec.link) {
    outSupported.push({ ...context, actionType: 'link', target: spec.link });
    matchedAny = true;
  }
  if (Array.isArray(spec.actions)) {
    for (const sub of spec.actions) inspectActionSpec(sub, outSupported, outUnsupported, context);
    matchedAny = true;
  }

  if (!matchedAny) {
    outUnsupported.push({
      ...context,
      actionType: actType || 'empty-or-unknown',
      reason: '交互对象未包含已支持的可执行动作（拒绝输出空壳按钮）',
    });
  }
}

export function analyzeDocumentInteractionsAndLayout(doc) {
  const supported = [];
  const unsupported = [];
  const nodeUnsupportedMap = new Map();
  const nodeSupportedMap = new Map();
  const declaredBreakpoints = Array.isArray(doc.adaptiveViews)
    ? doc.adaptiveViews.map(v => ({
        id: v.id || v.name,
        name: v.name || v.id,
        width: v.width ?? v.w ?? null,
        height: v.height ?? v.h ?? null,
      }))
    : [];
  const constraintNodes = [];

  function walk(node, pageId, scopePath) {
    if (!node || typeof node !== 'object') return;
    const scopedId = `${scopePath}/${node.id}`;
    if (node.constraints && typeof node.constraints === 'object') {
      constraintNodes.push({ pageId, nodeId: node.id, scopedId, constraints: structuredClone(node.constraints) });
    }
    const rawEvents = {
      ...(node.on && typeof node.on === 'object' ? node.on : {}),
      ...(node.interactions && typeof node.interactions === 'object' ? node.interactions : {}),
      ...(node.onClick ? { click: node.onClick } : {}),
    };
    for (const [event, spec] of Object.entries(rawEvents)) {
      if (spec === undefined || spec === null) continue;
      const context = { pageId, nodeId: node.id, scopedId, event };
      if (!SUPPORTED_EVENTS.has(event)) {
        const entry = {
          ...context,
          actionType: event,
          reason: `代码出口首版不支持事件触发器 "${event}"（仅支持 click / input / change）`,
        };
        unsupported.push(entry);
        if (!nodeUnsupportedMap.has(scopedId)) nodeUnsupportedMap.set(scopedId, []);
        nodeUnsupportedMap.get(scopedId).push(entry);
        continue;
      }
      const beforeSup = supported.length;
      const beforeUnsup = unsupported.length;
      inspectActionSpec(spec, supported, unsupported, context);
      if (supported.length > beforeSup) {
        nodeSupportedMap.set(scopedId, (nodeSupportedMap.get(scopedId) || 0) + (supported.length - beforeSup));
      }
      if (unsupported.length > beforeUnsup) {
        if (!nodeUnsupportedMap.has(scopedId)) nodeUnsupportedMap.set(scopedId, []);
        nodeUnsupportedMap.get(scopedId).push(...unsupported.slice(beforeUnsup));
      }
    }

    if (Array.isArray(node.children)) {
      for (const ch of node.children) walk(ch, pageId, scopePath);
    }
    if (node.template && typeof node.template === 'object') {
      walk(node.template, pageId, `${scopedId}/template`);
    }
    if (Array.isArray(node.states)) {
      for (const st of node.states) {
        if (st?.root) walk(st.root, pageId, `${scopedId}/${st.id}`);
      }
    }
  }

  for (const pg of doc.pages || []) {
    if (pg.root) walk(pg.root, pg.id, pg.id);
  }

  return {
    supported,
    unsupported,
    nodeUnsupportedMap,
    nodeSupportedMap,
    declaredBreakpoints,
    constraintNodes,
  };
}

function serializePageNode(n, assetRewriteMap, nodeUnsupportedMap, nodeSupportedMap) {
  const rewrittenSrc = n.src && assetRewriteMap.has(n.src) ? assetRewriteMap.get(n.src) : (n.src || null);
  const unsupEntries = nodeUnsupportedMap.get(n.scopedId) || [];
  const supCount = nodeSupportedMap.get(n.scopedId) || 0;
  const paint = {};
  if (n.fills || n.shadows || n.mixBlendMode) {
    const css = visualCss(n);
    for (const key of ['background-image', 'box-shadow', 'mix-blend-mode']) {
      if (!css[key]) continue;
      paint[key] = key === 'background-image' && assetRewriteMap.size
        ? css[key].replace(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"'\s]+))\s*\)/gi, (full, q1, q2, bare) => {
            const rawUrl = (q1 || q2 || bare || '').trim();
            return assetRewriteMap.has(rawUrl) ? `url("${assetRewriteMap.get(rawUrl)}")` : full;
          })
        : css[key];
    }
  }
  return {
    ...(Object.keys(paint).length ? { paint } : {}),
    id: n.id,
    scopedId: n.scopedId,
    pageId: n.pageId,
    parentId: n.parentId || null,
    parentScopedId: n.parentScopedId || null,
    sourceSizing: n.sourceSizing || null,
    panelOwnerId: n.panelOwnerId || null,
    repeaterTemplateOwner: n.repeaterTemplateOwner || null,
    renderOrder: n.renderOrder,
    name: n.name || n.id,
    type: n.type,
    role: n.role || null,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    relX: n.relX ?? 0,
    relY: n.relY ?? 0,
    text: n.text ?? '',
    ...(!n.truncated && n.spans?.length ? { spans: n.spans.map(span => ({ text: span.text, css: textSpanCss(span, n.fontStackCss) })) } : {}),
    rawText: n.rawText ?? n.text ?? '',
    placeholder: n.placeholder || '',
    value: n.value ?? '',
    src: rewrittenSrc,
    objectFit: n.objectFit || 'cover',
    fill: n.booleanRect && n.fill === '#FFFFFF00' ? null : n.fill || null,
    stroke: n.booleanRect && n.stroke === '#FFFFFF00' ? null : n.stroke || null,
    strokeWidth: n.strokeWidth ?? 0,
    strokeStyle: n.strokeStyle || 'solid',
    radius: n.radius ?? 0,
    opacity: n.opacity ?? 1,
    rotation: n.rotation ?? 0,
    threeDTransform: n.threeDTransform || null,
    shadow: n.shadow || null,
    clip: Boolean(n.clip),
    overflow: n.overflow || 'visible',
    color: n.color || '#1E293B',
    fontSize: n.fontSize || 14,
    fontFamily: n.fontFamily || 'PingFang SC',
    fontWeight: n.fontWeight || 400,
    italic: Boolean(n.italic),
    underline: Boolean(n.underline),
    strikethrough: Boolean(n.strikethrough),
    lineHeight: n.lineHeight || Math.round((n.fontSize || 14) * 1.4),
    letterSpacing: n.letterSpacing || 0,
    textAlign: n.textAlign || 'left',
    verticalAlign: n.verticalAlign || 'top',
    wrap: n.wrap !== false,
    padX: n.padX ?? 0,
    padY: n.padY ?? 0,
    textPaddingX: n.textPaddingX ?? null,
    textPaddingY: n.textPaddingY ?? null,
    visible: Boolean(n.visible && (!n.booleanRect || n.svgD)),
    ownVisible: Boolean(n.ownVisible && (!n.booleanRect || n.svgD)),
    state: n.state || 'default',
    interactive: Boolean(n.interactive),
    on: n.on ? structuredClone(n.on) : null,
    hasSupportedInteraction: supCount > 0,
    unsupportedInteractions: unsupEntries.map(u => ({ event: u.event, actionType: u.actionType, reason: u.reason })),
    // Dynamic panel metadata
    activeStateId: n.activeStateId || null,
    states: n.states ? structuredClone(n.states) : null,
    // Repeater metadata
    dataset: repeaterDatasetName(n) || null,
    rowHeight: n.rowHeight || 56,
    rowGap: n.rowGap ?? 8,
    pageSize: n.pageSize ?? null,
    page: n.page ?? 1,
    columns: n.columns || 1,
    gap: n.type === 'repeater' ? (n.rowGap ?? (n.gap || 8)) : (n.gap ?? 8),
    direction: n.direction || 'column',
    // Vector path metadata
    svgD: n.svgD || null,
    svgViewBox: n.viewBox || null,
    ...(n.booleanRect ? { booleanRect: n.booleanRect } : {}),
    fillRule: n.fillRule || 'nonzero',
    strokeLinecap: n.strokeLinecap || 'round',
    strokeLinejoin: n.strokeLinejoin || 'round',
    strokeDasharray: n.strokeDasharray || null,
  };
}

function collectRawVisibilityMap(doc) {
  const map = new Map();
  function walk(node, scopePath) {
    if (!node || typeof node !== 'object') return;
    const scopedId = `${scopePath}/${node.id}`;
    const ownVis = node.visible !== false && node.hidden !== true;
    map.set(scopedId, ownVis);
    map.set(`sizing:${scopedId}`, Object.fromEntries(['w', 'h', 'minW', 'maxW', 'minH', 'maxH', 'layout', 'justify', 'align'].filter(key => node[key] !== undefined).map(key => [key, node[key]])));
    if (typeof node.text === 'string' && node.text.startsWith('=')) {
      map.set(`rawText:${scopedId}`, node.text);
    }
    if (Array.isArray(node.children)) {
      for (const ch of node.children) walk(ch, scopePath);
    }
    if (node.template && typeof node.template === 'object') {
      walk(node.template, `${scopedId}/template`);
    }
    if (Array.isArray(node.states)) {
      for (const st of node.states) {
        if (st?.root) walk(st.root, `${scopedId}/${st.id}`);
      }
    }
  }
  for (const pg of doc.pages || []) {
    if (pg.root) walk(pg.root, pg.id);
  }
  return map;
}

function renderStaticInitialNodeHtml(n) {
  if (n.type === 'phone-shell' || n.repeaterTemplateOwner) return '';
  const styleParts = [
    `left:${n.x}px`,
    `top:${n.y}px`,
    `width:${n.w}px`,
    `height:${n.h}px`,
    `z-index:${n.renderOrder || 1}`,
  ];
  if (!n.visible) styleParts.push('display:none');
  if (n.fill && n.type !== 'path') styleParts.push(`background:${n.fill}`);
  for (const [key, value] of Object.entries(n.paint || {})) styleParts.push(`${key}:${value}`);
  if (n.stroke && n.strokeWidth > 0 && n.type !== 'path') {
    styleParts.push(`border:${n.strokeWidth}px ${n.strokeStyle || 'solid'} ${n.stroke}`);
  }
  if (n.radius > 0) styleParts.push(`border-radius:${n.radius}px`);
  if (n.opacity !== undefined && n.opacity !== 1) styleParts.push(`opacity:${n.opacity}`);
  // 白名单外的值不进 style 属性（防 HTML 注入），标注 data-unsupported-style 披露（S3-1）
  const rawTransform = typeof n.threeDTransform === 'string' ? n.threeDTransform.trim() : '';
  if (rawTransform && /^[a-zA-Z][a-zA-Z0-9\s(),.%+\-]*$/.test(rawTransform)) styleParts.push(`transform:${rawTransform}`);
  else if (rawTransform) styleParts.push(`transform:rotate(${n.rotation || 0}deg)`);
  else if (n.rotation) styleParts.push(`transform:rotate(${n.rotation}deg)`);
  if (n.clip || n.overflow === 'hidden') styleParts.push('overflow:hidden');
  if (n.booleanRect) styleParts.push('pointer-events:none');

  const unsupAttr = (n.unsupportedInteractions?.length
    ? ` data-unsupported-interaction="${escapeHtml(n.unsupportedInteractions.map(u => u.reason).join('; '))}" aria-disabled="true"`
    : '') + (rawTransform && !/^[a-zA-Z][a-zA-Z0-9\s(),.%+\-]*$/.test(rawTransform) ? ` data-unsupported-style="${escapeHtml(rawTransform)}"` : '');
  const roleAttr = n.role ? ` data-role="${escapeHtml(n.role)}"` : '';

  if (n.type === 'path' && n.svgD) {
    const vb = n.svgViewBox || { x: 0, y: 0, w: n.w || 100, h: n.h || 100 };
    const dashAttr = n.strokeDasharray ? ` stroke-dasharray="${escapeHtml(n.strokeDasharray)}"` : '';
    const rect = n.booleanRect;
    const position = rect ? ` style="position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;pointer-events:none"` : '';
    const hit = rect ? ' pointer-events="visiblePainted"' : '';
    return `<div class="export-node export-node-path" data-node-id="${escapeHtml(n.id)}" data-scoped-id="${escapeHtml(n.scopedId)}" data-node-type="path"${roleAttr}${unsupAttr} style="${escapeHtml(styleParts.join(';'))}"><svg class="export-vector-svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="100%" height="100%" preserveAspectRatio="none"${position}><path d="${escapeHtml(n.svgD)}" fill="${escapeHtml(n.fill || 'none')}" fill-rule="${escapeHtml(n.fillRule || 'nonzero')}" stroke="${escapeHtml(n.stroke || 'none')}" stroke-width="${n.stroke ? (n.strokeWidth ?? 1) : 0}" stroke-linecap="${escapeHtml(n.strokeLinecap || 'round')}" stroke-linejoin="${escapeHtml(n.strokeLinejoin || 'round')}"${dashAttr}${hit}/></svg></div>`;
  }

  if (n.type === 'image') {
    const imgHtml = n.src
      ? `<img src="${escapeHtml(n.src)}" alt="${escapeHtml(n.name || n.id)}" style="width:100%;height:100%;object-fit:${escapeHtml(n.objectFit || 'cover')};display:block;" />`
      : `<div class="export-image-placeholder">${escapeHtml(n.name || n.id)}</div>`;
    return `<div class="export-node export-node-image" data-node-id="${escapeHtml(n.id)}" data-scoped-id="${escapeHtml(n.scopedId)}" data-node-type="image"${roleAttr}${unsupAttr} style="${escapeHtml(styleParts.join(';'))}">${imgHtml}</div>`;
  }

  if (n.type === 'input') {
    styleParts.push(
      `color:${n.color || '#1E293B'}`,
      `font-size:${n.fontSize || 14}px`,
      `font-family:${escapeHtml(n.fontFamily || 'PingFang SC')}, sans-serif`,
      'padding:0 12px'
    );
    return `<input class="export-node export-node-input" data-node-id="${escapeHtml(n.id)}" data-scoped-id="${escapeHtml(n.scopedId)}" data-node-type="input"${roleAttr}${unsupAttr} type="text" value="${escapeHtml(n.value || n.text || '')}" placeholder="${escapeHtml(n.placeholder || '')}" style="${escapeHtml(styleParts.join(';'))}" />`;
  }

  const isTextBearing = ['label', 'paragraph', 'button', 'badge'].includes(n.type) || Boolean(n.text);
  if (isTextBearing) {
    styleParts.push(
      `color:${n.color || '#1E293B'}`,
      `font-size:${n.fontSize || 14}px`,
      `font-family:${escapeHtml(n.fontFamily || 'PingFang SC')}, sans-serif`,
      `font-weight:${n.fontWeight || 400}`,
      `line-height:${n.lineHeight || Math.round((n.fontSize || 14) * 1.4)}px`,
      `text-align:${n.textAlign || 'left'}`
    );
    if (n.letterSpacing) styleParts.push(`letter-spacing:${n.letterSpacing}px`);
    if (n.padX || n.padY) styleParts.push(`padding:${Math.round((n.padY || 0) / 2)}px ${Math.round((n.padX || 0) / 2)}px`);
    if (n.type === 'button' || n.textAlign === 'center') {
      styleParts.push('display:' + (n.visible ? 'flex' : 'none'), 'align-items:center', `justify-content:${n.textAlign === 'center' ? 'center' : n.textAlign === 'right' ? 'flex-end' : 'flex-start'}`);
    }
  }
  const tag = n.type === 'button' && (n.hasSupportedInteraction || !n.unsupportedInteractions?.length) ? 'button' : 'div';
  const btnTypeAttr = tag === 'button' ? ' type="button"' : '';
  const interactiveClass = n.hasSupportedInteraction ? ' is-interactive' : '';
  const unsupClass = n.unsupportedInteractions?.length && !n.hasSupportedInteraction ? ' is-unsupported-interaction' : '';
  const textHtml = n.spans?.length ? n.spans.map(span => {
    const css = Object.entries(span.css).map(([key, value]) => `${key}:${value}`).join(';');
    return `<span style="${escapeHtml(css)}">${escapeHtml(span.text)}</span>`;
  }).join('') : escapeHtml(n.text);
  return `<${tag}${btnTypeAttr} class="export-node export-node-${escapeHtml(n.type)}${interactiveClass}${unsupClass}" data-node-id="${escapeHtml(n.id)}" data-scoped-id="${escapeHtml(n.scopedId)}" data-node-type="${escapeHtml(n.type)}"${roleAttr}${unsupAttr} style="${escapeHtml(styleParts.join(';'))}">${textHtml}</${tag}>`;
}

function buildStylesCss(doc, layoutAnalysis) {
  const tokenLines = [];
  const colors = { ...(doc.palette || {}), ...(doc.tokens?.colors || {}) };
  for (const [k, v] of Object.entries(colors)) {
    const val = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (typeof val === 'string') {
      tokenLines.push(`  --token-color-${k.replace(/[^a-zA-Z0-9_-]/g, '-')}: ${val};`);
    }
  }
  for (const [k, v] of Object.entries(doc.tokens?.spacing || {})) {
    const val = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (typeof val === 'number' || typeof val === 'string') {
      tokenLines.push(`  --token-space-${k.replace(/[^a-zA-Z0-9_-]/g, '-')}: ${typeof val === 'number' ? `${val}px` : val};`);
    }
  }
  for (const [k, v] of Object.entries(doc.tokens?.radius || {})) {
    const val = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (typeof val === 'number' || typeof val === 'string') {
      tokenLines.push(`  --token-radius-${k.replace(/[^a-zA-Z0-9_-]/g, '-')}: ${typeof val === 'number' ? `${val}px` : val};`);
    }
  }

  const safeCssComment = val => String(val ?? '').replace(/\*\//g, '* /');
  const mediaRules = layoutAnalysis.declaredBreakpoints
    .filter(bp => typeof bp.width === 'number' && bp.width > 0)
    .map(
      bp => `
/* Declared Adaptive View: ${safeCssComment(bp.name)} (max-width: ${bp.width}px) */
@media (max-width: ${bp.width}px) {
  body[data-adaptive-views="declared"] {
    --active-breakpoint: ${JSON.stringify(String(bp.id ?? ''))};
  }
}`
    )
    .join('\n');

  return `/* Studio Runnable Code Export (v${CODE_EXPORTER_VERSION})
 * Document: ${safeCssComment(doc.documentId)} (r${doc.revision}, hash: ${safeCssComment(doc.contentHash)})
 * Layout mode: ${layoutAnalysis.declaredBreakpoints.length > 0 ? 'Declared Adaptive Views' : 'Fixed Board (non-responsive)'}
 */
:root {
${tokenLines.join('\n')}
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0F172A;
  color: #F8FAFC;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.export-topbar {
  height: 48px;
  background: #1E293B;
  border-bottom: 1px solid #334155;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  font-size: 13px;
  gap: 12px;
}

.export-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}

.export-badge {
  font-family: Menlo, monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #334155;
  color: #E2E8F0;
}

.export-page-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
}

.export-page-tab {
  border: 1px solid #475569;
  background: transparent;
  color: #CBD5E1;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.export-page-tab.active {
  background: #3B82F6;
  border-color: #3B82F6;
  color: #FFFFFF;
}

.export-stage {
  flex: 1;
  overflow: auto;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 24px;
}

.export-board {
  position: relative;
  background: #FFFFFF;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  flex-shrink: 0;
}

.export-node {
  position: absolute;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: none;
  border: none;
  background: transparent;
}

.export-node.is-interactive {
  cursor: pointer;
}

.export-node.is-unsupported-interaction {
  cursor: not-allowed;
}

.export-node-input {
  user-select: text;
  outline: none;
}

.export-vector-svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.export-repeater-row {
  position: absolute;
}
${mediaRules}
`;
}

function buildAppJs(bundlePayload) {
  return `// Studio Standalone Runnable Export Runtime (v${CODE_EXPORTER_VERSION})
// Bound to documentId=${bundlePayload.documentId} revision=${bundlePayload.revision} contentHash=${bundlePayload.contentHash}
(function () {
  'use strict';

  ${evaluatePrototypeExpression.toString()}
  ${executePrototypeInteraction.toString()}

  const BUNDLE = ${JSON.stringify(bundlePayload)};

  class ExportRuntimeApp {
    constructor(bundle) {
      this.bundle = bundle;
      this.reset();
    }

    reset(startPageId = null) {
      const pages = this.bundle.pages || [];
      this.currentPageId = startPageId || pages[0]?.id || 'home';
      this.variables = {};
      for (const [k, v] of Object.entries(this.bundle.variables || {})) {
        this.variables[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
      }
      this.inputs = {};
      this.visibility = {};
      this.textOverrides = {};
      this.textFormulas = {};
      this.panelStates = {};
      this.datasets = {};
      this.datasetFilters = {};
      this.datasetSorts = {};
      this.datasetPages = {};
      this.datasetPageSizes = {};
      this.selectedRows = {};
      this.trace = [];

      for (const [dsName, rows] of Object.entries(this.bundle.datasets || {})) {
        this.datasets[dsName] = (Array.isArray(rows) ? rows : []).map((r, idx) => ({
          ... structuredClone(r),
          _rowId: r._rowId ?? r.id ?? ('row_' + (idx + 1)),
        }));
        this.datasetFilters[dsName] = null;
        this.datasetSorts[dsName] = null;
        this.datasetPages[dsName] = 1;
        this.datasetPageSizes[dsName] = null;
        this.selectedRows[dsName] = new Set(
          this.datasets[dsName].filter(r => r._selected).map(r => r._rowId)
        );
      }

      const collectFormulas = (spec, context) => {
        if (!spec || typeof spec !== 'object') return;
        if (Array.isArray(spec)) { spec.forEach(s => collectFormulas(s, context)); return; }
        if (spec.type === 'set-text' && spec.target) {
          const expr = spec.text ?? spec.value;
          if (typeof expr === 'string' && expr.includes('dataset.')) {
            const target = this.findNodeInPage(context.pageId, spec.target, context);
            if (target && !this.textFormulas[target.scopedId]) this.textFormulas[target.scopedId] = { ...context, expr };
          }
        }
        for (const k of ['actions', 'then', 'else', 'cases']) if (spec[k]) collectFormulas(spec[k], context);
      };

      for (const pg of pages) {
        const allPageNodes = new Map();
        for (const n of pg.nodes || []) allPageNodes.set(n.scopedId, n);
        for (const states of Object.values(pg.panelStateNodes || {})) {
          for (const stNodes of Object.values(states || {})) {
            for (const sn of stNodes || []) allPageNodes.set(sn.scopedId, sn);
          }
        }
        for (const n of allPageNodes.values()) {
          if (!n.ownVisible) {
            this.visibility[n.scopedId] = false;
          }
          if (n.type === 'input') {
            const val = n.value !== undefined && n.value !== '' ? String(n.value) : '';
            this.inputs[n.scopedId] = val;
          }
          if (n.type === 'dynamic-panel' && n.activeStateId) {
            this.panelStates[n.scopedId] = n.activeStateId;
          }
          if (n.type === 'repeater') {
            const dsKey = (typeof n.dataset === 'string' && n.dataset) ? n.dataset : n.id;
            if (Number.isInteger(n.pageSize) && n.pageSize > 0) this.datasetPageSizes[dsKey] = n.pageSize;
            if (Number.isInteger(n.page) && n.page >= 1) this.datasetPages[dsKey] = n.page;
          }
          if (n.on?.click) collectFormulas(n.on.click, { pageId: pg.id, scopePrefix: this.nodeScope(n) });
        }
      }
      this.render();
      return this.getState();
    }

    getCurrentPage() {
      return (this.bundle.pages || []).find(p => p.id === this.currentPageId || p.name === this.currentPageId) || this.bundle.pages[0] || null;
    }

    getActiveNodesForPage(pageId = this.currentPageId) {
      const pg = (this.bundle.pages || []).find(p => p.id === pageId || p.name === pageId);
      if (!pg) return [];
      const baseNodes = [];
      const appendNodeAndPanel = n => {
        baseNodes.push(n);
        if (n.type === 'dynamic-panel') {
          const activeSt = this.panelStates[n.scopedId] || n.activeStateId || n.states?.[0]?.id;
          const stateMap = pg.panelStateNodes?.[n.scopedId] || pg.panelStateNodes?.[n.id];
          const stNodes = stateMap?.[activeSt] || [];
          for (const sn of stNodes) appendNodeAndPanel(sn);
        }
      };
      for (const n of pg.nodes || []) {
        if (n.panelOwnerId) continue; // Replaced dynamically by active panel state subtree
        appendNodeAndPanel(n);
      }
      return baseNodes;
    }

    nodeScope(node) {
      return node.scopedId.slice(0, -node.id.length - 1);
    }

    findNodeInPage(pageId, targetId, { scopePrefix = this.interactionScope } = {}) {
      const raw = String(targetId?.ref ?? targetId);
      const explicitPage = this.bundle.pages.find(p => raw.startsWith(p.id + '/'));
      const pg = explicitPage || this.bundle.pages.find(p => p.id === pageId);
      if (!pg) return null;
      const all = new Map((pg.nodes || []).map(n => [n.scopedId, n]));
      for (const states of Object.values(pg.panelStateNodes || {})) for (const nodes of Object.values(states)) for (const n of nodes) all.set(n.scopedId, n);
      const full = explicitPage ? raw : pg.id + '/' + raw;
      const nodes = [...all.values()];
      let matches = nodes.filter(n => n.scopedId === full);
      if (!raw.includes('/') && scopePrefix && scopePrefix !== pg.id) {
        const local = nodes.filter(n => this.nodeScope(n) === scopePrefix && (n.id === raw || n.name === raw));
        if (local.length) matches = local;
      }
      if (!matches.length && !raw.includes('/')) {
        matches = nodes.filter(n => n.id === raw || n.name === raw);
        const local = matches.filter(n => this.nodeScope(n) === scopePrefix);
        const active = new Set(this.getActiveNodesForPage(pg.id).map(n => n.scopedId));
        if (local.length) matches = local;
        else if (matches.some(n => active.has(n.scopedId))) matches = matches.filter(n => active.has(n.scopedId));
      }
      if (matches.length > 1) throw new Error('运行态目标不唯一，请使用完整作用域路径: ' + raw);
      return matches[0] || null;
    }

    targetKey(targetId, pageId = this.currentPageId) {
      const node = this.findNodeInPage(pageId, targetId);
      if (!node) throw new Error('未找到指定作用域目标: ' + targetId);
      return node.scopedId;
    }

    isNodeVisible(targetId, pageId = this.currentPageId) {
      const activeNodes = this.getActiveNodesForPage(pageId);
      const byScoped = new Map(activeNodes.map(n => [n.scopedId, n]));
      const node = this.findNodeInPage(pageId, targetId);
      if (!node || !byScoped.has(node.scopedId)) return false;
      let cur = node;
      const visited = new Set();
      while (cur && !visited.has(cur.scopedId)) {
        visited.add(cur.scopedId);
        const ownVis = cur.scopedId in this.visibility ? Boolean(this.visibility[cur.scopedId]) : cur.ownVisible;
        if (!ownVis) return false;
        cur = cur.parentScopedId ? byScoped.get(cur.parentScopedId) : null;
      }
      return true;
    }

    getWidgetText(widgetId, { pageId = this.currentPageId, scopePrefix = this.interactionScope } = {}) {
      const node = this.findNodeInPage(pageId, widgetId, { scopePrefix });
      if (!node) return '';
      const scoped = node.scopedId;
      if (scoped in this.inputs) return String(this.inputs[scoped] ?? '');
      if (scoped in this.textOverrides) return String(this.textOverrides[scoped] ?? '');
      const raw = String(node.rawText ?? node.text ?? node.value ?? '');
      if (raw.startsWith('=')) {
        return String(this.evaluateExpression(raw, null, { pageId: node.pageId, scopePrefix: this.nodeScope(node) }) ?? '');
      }
      return raw;
    }

    evaluateExpression(expr, itemRow = null, context = {}) {
      return evaluatePrototypeExpression(expr, {
        variables: this.variables,
        getWidgetText: target => this.getWidgetText(target, context),
        resolveDatasetPath: (name, prop) => this.resolveDatasetPath(name, prop),
        itemRow,
      });
    }

    getDatasetPageSize(dsName, fallback = null) {
      return this.datasetPageSizes?.[dsName] || fallback || null;
    }

    getDatasetTotalPages(dsName, fallbackPageSize = null) {
      const rows = this.getVisibleDatasetRows(dsName);
      const pageSize = this.getDatasetPageSize(dsName, fallbackPageSize);
      if (!pageSize || pageSize <= 0) return 1;
      return Math.max(1, Math.ceil(rows.length / pageSize));
    }

    getDatasetPage(dsName, fallbackPageSize = null) {
      const totalPages = this.getDatasetTotalPages(dsName, fallbackPageSize);
      const raw = Number(this.datasetPages?.[dsName] || 1);
      return Math.min(Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 1), totalPages);
    }

    getPagedDatasetRows(dsName, fallbackPageSize = null) {
      const rows = this.getVisibleDatasetRows(dsName);
      const pageSize = this.getDatasetPageSize(dsName, fallbackPageSize);
      if (!pageSize || pageSize <= 0) return rows;
      const page = this.getDatasetPage(dsName, pageSize);
      const start = (page - 1) * pageSize;
      return rows.slice(start, start + pageSize);
    }

    resolveDatasetPath(dsName, propPath) {
      const visible = this.getVisibleDatasetRows(dsName);
      const paged = this.getPagedDatasetRows(dsName);
      const page = this.getDatasetPage(dsName);
      const totalPages = this.getDatasetTotalPages(dsName);
      if (propPath === 'count') return visible.length;
      if (propPath === 'total') return (this.datasets[dsName] || []).length;
      if (propPath === 'page') return page;
      if (propPath === 'totalPages') return totalPages;
      if (propPath === 'pageStatus') return visible.length === 0 ? '第 0 / 0 页' : '第 ' + page + ' / ' + totalPages + ' 页';
      if (propPath === 'countStatus') return '共 ' + visible.length + ' 条记录';
      if (propPath.startsWith('pageFirst.')) {
        const field = propPath.slice('pageFirst.'.length);
        return paged[0]?.[field] ?? '-';
      }
      if (propPath.startsWith('first.')) {
        const field = propPath.slice('first.'.length);
        return visible[0]?.[field] ?? '-';
      }
      if (propPath.startsWith('selected.')) {
        const field = propPath.slice('selected.'.length);
        const selSet = this.selectedRows[dsName] || new Set();
        const sel = visible.find(r => r._selected) || (this.datasets[dsName] || []).find(r => selSet.has(r._rowId) || (r.id !== undefined && selSet.has(r.id))) || paged[0] || visible[0];
        return sel?.[field] ?? '';
      }
      return '';
    }

    _refreshDatasetBoundText() {
      for (const [key, info] of Object.entries(this.textFormulas)) {
        this.textOverrides[key] = String(this.evaluateExpression(info.expr, null, info));
      }
    }

    getVisibleDatasetRows(dsName) {
      const baseRows = this.datasets[dsName] || [];
      const filterSpec = this.datasetFilters[dsName];
      const sortSpec = this.datasetSorts[dsName];
      const selectedSet = this.selectedRows[dsName] || new Set();
      let rows = baseRows.map(r => ({
        ...r,
        _selected: selectedSet.has(r._rowId) || (r.id !== undefined && selectedSet.has(r.id)),
      }));

      if (filterSpec) {
        if (typeof filterSpec === 'string' && filterSpec.trim() !== '') {
          const q = filterSpec.trim().toLowerCase();
          rows = rows.filter(r =>
            Object.entries(r).some(([k, v]) => !k.startsWith('_') && String(v).toLowerCase().includes(q))
          );
        } else if (typeof filterSpec === 'object') {
          const { field, value, operator = 'includes' } = filterSpec;
          if (field && value !== undefined && String(value) !== '' && String(value) !== 'all') {
            const target = String(value).toLowerCase();
            rows = rows.filter(r => {
              const cell = String(r[field] ?? '').toLowerCase();
              if (operator === 'eq' || operator === '==') return cell === target;
              return cell.includes(target);
            });
          }
        }
      }

      if (sortSpec && sortSpec.field) {
        const { field, order = 'asc' } = sortSpec;
        const dir = String(order).toLowerCase() === 'desc' ? -1 : 1;
        rows.sort((a, b) => {
          const va = a[field];
          const vb = b[field];
          const na = Number(va);
          const nb = Number(vb);
          if (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '') {
            return (na - nb) * dir;
          }
          return String(va ?? '').localeCompare(String(vb ?? ''), 'zh-CN') * dir;
        });
      }
      return rows;
    }

    navigate(pageId) {
      const target = (this.bundle.pages || []).find(p => p.id === pageId || p.name === pageId);
      if (!target) throw new Error('未知页面: ' + pageId);
      this.currentPageId = target.id;
      this.trace.push({ step: this.trace.length + 1, type: 'navigate', pageId: this.currentPageId });
      this.render();
      return this.getState();
    }

    setInput(targetId, value) {
      const stripped = this.targetKey(targetId);
      this.inputs[stripped] = String(value);
      this.trace.push({ step: this.trace.length + 1, type: 'input', pageId: this.currentPageId, targetId: stripped, value: String(value) });
      this.render();
      return this.getState();
    }

    click(targetId, rowContext = null) {
      const node = this.findNodeInPage(this.currentPageId, targetId);
      const stripped = node?.scopedId;
      if (!node) throw new Error('未找到交互目标: ' + targetId);
      if (!this.isNodeVisible(targetId)) throw new Error('交互目标当前不可见: ' + targetId);
      if (node.unsupportedInteractions?.length && !node.hasSupportedInteraction) {
        throw new Error('交互目标包含未支持动作: ' + node.unsupportedInteractions.map(u => u.reason).join('; '));
      }
      const clickSpec = node.on?.click;
      const executed = [];
      if (clickSpec && !['disabled', 'loading'].includes(node.state)) {
        const before = this.interactionScope;
        this.interactionScope = this.nodeScope(node);
        try {
          executePrototypeInteraction(this, clickSpec, executed, { declaredVariables: this.bundle.variables, rowContext });
        }
        finally { this.interactionScope = before; }
      }
      this.trace.push({
        step: this.trace.length + 1,
        type: 'click',
        pageId: this.currentPageId,
        targetId: stripped,
        executed,
      });
      this.render();
      return this.getState();
    }

    _setNodeVisibility(targetId, vis) {
      this.visibility[this.targetKey(targetId)] = vis;
    }

    _executeDatasetAction(act, executed, rowContext = null) {
      const dsName = act.dataset || act.repeater || Object.keys(this.datasets)[0];
      if (!dsName || !this.datasets[dsName]) return;
      const op = (act.op || act.type || '').replace(/^(dataset-|repeater-)/, '');
      const selected = this.selectedRows[dsName] || new Set();

      if (op === 'select' || op === 'toggle-select') {
        let rowId = act.rowId ?? rowContext?._rowId;
        if (rowId === 'first' || rowId === 'pageFirst') {
          const firstRow = this.getPagedDatasetRows(dsName)[0] || this.getVisibleDatasetRows(dsName)[0];
          rowId = firstRow?._rowId ?? firstRow?.id ?? null;
        } else if (typeof rowId === 'string' && rowId.startsWith('=')) {
          rowId = this.evaluateExpression(rowId, rowContext);
        }
        if (act.clearOthers !== false) selected.clear();
        if (op === 'toggle-select' && selected.has(rowId)) selected.delete(rowId);
        else if (rowId !== undefined && rowId !== null && rowId !== '') selected.add(rowId);
        this._refreshDatasetBoundText();
        executed.push({ action: 'dataset-select', dataset: dsName, selectedRowIds: [...selected] });
        return;
      }
      if (op === 'page') {
        const rawTarget = act.page ?? act.value ?? act.query;
        const totalPages = this.getDatasetTotalPages(dsName);
        const curPage = this.getDatasetPage(dsName);
        let nextPage = curPage;
        if (rawTarget === 'next') nextPage = Math.min(totalPages, curPage + 1);
        else if (rawTarget === 'prev' || rawTarget === 'previous') nextPage = Math.max(1, curPage - 1);
        else if (rawTarget === 'first') nextPage = 1;
        else if (rawTarget === 'last') nextPage = totalPages;
        else {
          const evaluated = Number(this.evaluateExpression(rawTarget, rowContext));
          if (Number.isFinite(evaluated)) nextPage = Math.min(totalPages, Math.max(1, Math.floor(evaluated)));
        }
        this.datasetPages[dsName] = nextPage;
        this._refreshDatasetBoundText();
        executed.push({ action: 'dataset-page', dataset: dsName, page: nextPage, totalPages });
        return;
      }
      if (op === 'add') {
        const rawRow = act.row || {};
        const resolvedRow = { _rowId: rawRow._rowId || rawRow.id || ('row_' + Date.now() + '_' + (this.datasets[dsName].length + 1)) };
        for (const [k, v] of Object.entries(rawRow)) {
          resolvedRow[k] = this.evaluateExpression(v, rowContext);
        }
        if (act.requireNonEmpty) {
          const fields = Array.isArray(act.requireNonEmpty) ? act.requireNonEmpty : [act.requireNonEmpty];
          const hasEmpty = fields.some(f => !String(resolvedRow[f] ?? '').trim());
          if (hasEmpty) {
            if (act.onEmptyShow) this._setNodeVisibility(act.onEmptyShow, true);
            executed.push({ action: 'dataset-add-blocked', dataset: dsName });
            return;
          }
        }
        this.datasets[dsName].push(resolvedRow);
        executed.push({ action: 'dataset-add', dataset: dsName, row: resolvedRow });
        return;
      }
      if (op === 'update') {
        const targetIds = act.rowId ? new Set([act.rowId]) : selected;
        if (targetIds.size === 0) {
          if (act.onEmptySelectionShow) this._setNodeVisibility(act.onEmptySelectionShow, true);
          return;
        }
        const patch = act.patch || act.row || {};
        for (const r of this.datasets[dsName]) {
          if (targetIds.has(r._rowId) || targetIds.has(r.id)) {
            for (const [k, v] of Object.entries(patch)) {
              r[k] = this.evaluateExpression(v, rowContext);
            }
          }
        }
        executed.push({ action: 'dataset-update', dataset: dsName });
        return;
      }
      if (op === 'delete') {
        const targetIds = act.rowId ? new Set([act.rowId]) : selected;
        if (targetIds.size === 0) {
          if (act.onEmptySelectionShow) this._setNodeVisibility(act.onEmptySelectionShow, true);
          return;
        }
        this.datasets[dsName] = this.datasets[dsName].filter(r => !targetIds.has(r._rowId) && !targetIds.has(r.id));
        for (const id of targetIds) selected.delete(id);
        executed.push({ action: 'dataset-delete', dataset: dsName });
        return;
      }
      if (op === 'filter') {
        const query = act.query !== undefined ? this.evaluateExpression(act.query, rowContext) : null;
        this.datasetFilters[dsName] = act.field ? { field: act.field, value: query, operator: act.operator || 'includes' } : query;
        this.datasetPages[dsName] = 1;
        if (act.onEmptyShow) {
          const isEmpty = this.getVisibleDatasetRows(dsName).length === 0;
          this._setNodeVisibility(act.onEmptyShow, isEmpty);
        }
        this._refreshDatasetBoundText();
        executed.push({ action: 'dataset-filter', dataset: dsName });
        return;
      }
      if (op === 'sort') {
        this.datasetSorts[dsName] = act.field ? { field: act.field, order: act.order || 'asc' } : null;
        this.datasetPages[dsName] = 1;
        this._refreshDatasetBoundText();
        executed.push({ action: 'dataset-sort', dataset: dsName });
      }
    }

    getState() {
      const visibleDatasets = {};
      for (const dsName of Object.keys(this.datasets)) {
        visibleDatasets[dsName] = this.getVisibleDatasetRows(dsName);
      }
      return {
        documentId: this.bundle.documentId,
        revision: this.bundle.revision,
        contentHash: this.bundle.contentHash,
        currentPageId: this.currentPageId,
        variables: structuredClone(this.variables),
        inputs: structuredClone(this.inputs),
        panelStates: structuredClone(this.panelStates),
        datasets: visibleDatasets,
        traceLength: this.trace.length,
      };
    }

    runScenario(steps = []) {
      const stepResults = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.action === 'navigate' || step.goto) {
          this.navigate(step.page || step.goto || step.target);
        } else if (step.action === 'input' || step.fill) {
          this.setInput(step.target || step.id || step.fill, step.value ?? step.text ?? '');
        } else if (step.action === 'click' || step.click) {
          this.click(step.target || step.click || step.id);
        } else if (step.action === 'dataset') {
          this._executeDatasetAction(step, []);
          this.render();
        }
        const failures = [];
        if (step.expect) {
          if (step.expect.page && this.currentPageId !== step.expect.page) {
            failures.push('Expected page ' + step.expect.page + ', got ' + this.currentPageId);
          }
          if (step.expect.visible) {
            for (const [nodeId, expVis] of Object.entries(step.expect.visible)) {
              const actualVis = this.isNodeVisible(nodeId);
              if (actualVis !== expVis) {
                failures.push('Expected visible[' + nodeId + ']=' + expVis + ', got ' + actualVis);
              }
            }
          }
          if (step.expect.text) {
            for (const [nodeId, expText] of Object.entries(step.expect.text)) {
              const actualText = this.getWidgetText(nodeId);
              if (expText && typeof expText === 'object' && 'includes' in expText) {
                if (!actualText.includes(String(expText.includes))) {
                  failures.push('Expected text[' + nodeId + '] to include "' + expText.includes + '", got "' + actualText + '"');
                }
              } else if (String(actualText) !== String(expText)) {
                failures.push('Expected text[' + nodeId + ']="' + expText + '", got "' + actualText + '"');
              }
            }
          }
          if (step.expect.variables) {
            for (const [k, v] of Object.entries(step.expect.variables)) {
              if (String(this.variables[k] ?? '') !== String(v)) {
                failures.push('Expected variable[' + k + ']=' + v + ', got ' + this.variables[k]);
              }
            }
          }
          if (step.expect.panelState) {
            for (const [panelId, stId] of Object.entries(step.expect.panelState)) {
              const actualSt = this.panelStates[this.targetKey(panelId)];
              if (actualSt !== stId) {
                failures.push('Expected panelState[' + panelId + ']=' + stId + ', got ' + actualSt);
              }
            }
          }
          if (step.expect.datasetCount) {
            for (const [ds, expCount] of Object.entries(step.expect.datasetCount)) {
              const actualCount = this.getVisibleDatasetRows(ds).length;
              if (actualCount !== expCount) {
                failures.push('Expected datasetCount[' + ds + ']=' + expCount + ', got ' + actualCount);
              }
            }
          }
          if (step.expect.datasetFirstRow) {
            for (const [ds, expectedFields] of Object.entries(step.expect.datasetFirstRow)) {
              const first = this.getVisibleDatasetRows(ds)[0] || {};
              for (const [fk, fv] of Object.entries(expectedFields)) {
                if (String(first[fk] ?? '') !== String(fv)) {
                  failures.push('Expected datasetFirstRow[' + ds + '].' + fk + '=' + fv + ', got ' + first[fk]);
                }
              }
            }
          }
        }
        stepResults.push({ stepIndex: i + 1, passed: failures.length === 0, failures });
        if (failures.length > 0) {
          return { ok: false, failedStepIndex: i + 1, failures, stepResults, finalState: this.getState() };
        }
      }
      return { ok: true, totalSteps: steps.length, passedSteps: steps.length, stepResults, finalState: this.getState() };
    }

    render() {
      if (typeof document === 'undefined') return;
      const pg = this.getCurrentPage();
      if (!pg) return;

      const tabsEl = document.getElementById('studio-export-tabs');
      if (tabsEl) {
        tabsEl.innerHTML = '';
        for (const p of this.bundle.pages || []) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'export-page-tab' + (p.id === pg.id ? ' active' : '');
          btn.setAttribute('data-page-tab', p.id);
          btn.textContent = p.name || p.id;
          btn.addEventListener('click', () => this.navigate(p.id));
          tabsEl.appendChild(btn);
        }
      }

      const statusEl = document.getElementById('studio-export-status');
      if (statusEl) {
        statusEl.textContent = pg.name + ' (' + pg.board.screenW + '×' + pg.board.screenH + ') · r' + this.bundle.revision;
      }

      const boardEl = document.getElementById('studio-export-board');
      if (!boardEl) return;
      boardEl.style.width = pg.board.screenW + 'px';
      boardEl.style.height = pg.board.screenH + 'px';
      boardEl.setAttribute('data-page-id', pg.id);
      boardEl.innerHTML = '';

      const activeNodes = this.getActiveNodesForPage(pg.id);
      for (const n of activeNodes) {
        if (n.type === 'phone-shell' || n.repeaterTemplateOwner) continue;
        const vis = this.isNodeVisible(n.scopedId, pg.id);
        const el = this._createNodeElement(n, vis, null);
        boardEl.appendChild(el);

        if (n.type === 'repeater' && vis) {
          this._renderRepeaterRows(boardEl, pg, n);
        }
      }
      this._reflowText(boardEl, activeNodes);
    }

    _reflowText(boardEl, nodes) {
      const elements = new Map([...boardEl.querySelectorAll('[data-scoped-id]')].map(el => [el.dataset.scopedId, el]));
      const bounds = new Map(nodes.map(n => [n.scopedId, { x: n.x, y: n.y, w: n.w, h: n.h }]));
      const children = new Map();
      for (const n of nodes) {
        if (!children.has(n.parentScopedId)) children.set(n.parentScopedId, []);
        children.get(n.parentScopedId).push(n);
        const el = elements.get(n.scopedId), source = n.sourceSizing;
        if (!el || !source || !['label', 'paragraph', 'button', 'badge'].includes(n.type) || !this.isNodeVisible(n.scopedId)) continue;
        const auto = axis => source[axis] === undefined || ['hug', 'auto'].includes(source[axis]);
        const b = bounds.get(n.scopedId);
        if (auto('w')) {
          el.style.width = 'max-content';
          el.style.maxWidth = (source.maxW ?? boardEl.clientWidth) + 'px';
          b.w = Math.ceil(el.getBoundingClientRect().width);
          b.w = Math.max(source.minW || 0, Math.min(source.maxW ?? Infinity, b.w));
          el.style.width = b.w + 'px';
        }
        if (auto('h')) {
          el.style.height = 'auto';
          el.style.minHeight = (n.lineHeight + (n.padY || 0)) + 'px';
          b.h = Math.ceil(el.getBoundingClientRect().height);
          b.h = Math.max(source.minH || 0, Math.min(source.maxH ?? Infinity, b.h));
          el.style.height = b.h + 'px';
        }
      }
      // Propagate changed text sizes through the authored row/column/stack tree.
      // Geometry starts from the exported layout, preserving source offsets/gaps.
      const resize = n => {
        const list = children.get(n.scopedId) || [], b = bounds.get(n.scopedId), source = n.sourceSizing;
        list.forEach(resize);
        if (!source || !list.length) return;
        const layout = source.layout || 'stack';
        for (const axis of ['w', 'h']) {
          if (source[axis] !== undefined && !['hug', 'auto'].includes(source[axis])) continue;
          const flow = layout === (axis === 'w' ? 'row' : 'column');
          if (flow) b[axis] += list.reduce((sum, child) => sum + bounds.get(child.scopedId)[axis] - child[axis], 0);
          else if (layout !== 'grid') {
            const pos = axis === 'w' ? 'x' : 'y';
            b[axis] += Math.max(...list.map(child => child[pos] + bounds.get(child.scopedId)[axis])) - Math.max(...list.map(child => child[pos] + child[axis]));
          }
          b[axis] = Math.max(source[axis === 'w' ? 'minW' : 'minH'] || 0, Math.min(source[axis === 'w' ? 'maxW' : 'maxH'] ?? Infinity, b[axis]));
        }
      };
      const position = (n, dx = 0, dy = 0) => {
        const b = bounds.get(n.scopedId), el = elements.get(n.scopedId), list = children.get(n.scopedId) || [];
        if (el) { el.style.left = (n.x + dx) + 'px'; el.style.top = (n.y + dy) + 'px'; el.style.width = b.w + 'px'; el.style.height = b.h + 'px'; }
        const layout = n.sourceSizing?.layout, justify = n.sourceSizing?.justify || 'start', align = n.sourceSizing?.align || 'start';
        const row = layout === 'row', column = layout === 'column', axis = row ? 'w' : 'h';
        const delta = (row || column) ? list.reduce((sum, child) => sum + bounds.get(child.scopedId)[axis] - child[axis], 0) : 0;
        const extra = (row || column) ? b[axis] - n[axis] - delta : 0;
        let flow = justify === 'center' ? extra / 2 : justify === 'end' ? extra : 0;
        for (let i = 0; i < list.length; i++) {
          const child = list[i], cb = bounds.get(child.scopedId);
          const cross = row ? b.h - n.h - (cb.h - child.h) : b.w - n.w - (cb.w - child.w);
          const crossShift = align === 'center' ? cross / 2 : align === 'end' ? cross : 0;
          const spaced = justify === 'space-between' && list.length > 1 ? extra * i / (list.length - 1) : 0;
          position(child, dx + (row ? flow + spaced : column ? crossShift : 0), dy + (column ? flow + spaced : row ? crossShift : 0));
          if (row || column) flow += cb[axis] - child[axis];
        }
      };
      for (const n of children.get(null) || []) { resize(n); position(n); }
    }

    _renderRepeaterRows(boardEl, pg, repNode) {
      const dsName = repNode.dataset || repNode.id;
      const rows = this.getPagedDatasetRows(dsName, repNode.pageSize);
      const tplNodes = pg.repeaterTemplates?.[repNode.id] || [];
      const cols = Math.max(1, Number(repNode.columns || 1));
      const gap = Number(repNode.rowGap ?? repNode.gap ?? 8);
      const rowH = Number(repNode.rowHeight || 56);
      const cellW = cols > 1 ? Math.floor((repNode.w - gap * (cols - 1)) / cols) : repNode.w;

      rows.forEach((row, idx) => {
        const colIdx = cols > 1 ? idx % cols : 0;
        const rowIdx = cols > 1 ? Math.floor(idx / cols) : idx;
        const offsetX = repNode.x + (repNode.direction === 'row' ? idx * (cellW + gap) : colIdx * (cellW + gap));
        const offsetY = repNode.y + (repNode.direction === 'row' ? 0 : rowIdx * (rowH + gap));

        if (!tplNodes.length) {
          const rowEl = document.createElement('div');
          rowEl.className = 'export-node export-repeater-row is-interactive';
          rowEl.setAttribute('data-repeater-row-id', String(row._rowId));
          rowEl.setAttribute('data-repeater-id', repNode.id);
          rowEl.style.left = offsetX + 'px';
          rowEl.style.top = offsetY + 'px';
          rowEl.style.width = cellW + 'px';
          rowEl.style.height = rowH + 'px';
          rowEl.style.zIndex = String((repNode.renderOrder || 1) + 1 + idx);
          rowEl.style.background = row._selected ? '#EEF2FF' : '#FFFFFF';
          rowEl.style.border = '1px solid ' + (row._selected ? '#3B82F6' : '#E2E8F0');
          rowEl.style.borderRadius = '8px';
          rowEl.style.padding = '8px 12px';
          rowEl.style.display = 'flex';
          rowEl.style.alignItems = 'center';
          rowEl.style.justifyContent = 'space-between';
          rowEl.style.color = '#1E293B';
          rowEl.style.fontSize = '13px';
          const titleText = row.title ?? row.name ?? row.label ?? String(row._rowId);
          const subText = row.subtitle ?? row.desc ?? '';
          const badgeText = row.badge ?? row.status ?? '';
          rowEl.textContent = [titleText, subText, badgeText].filter(Boolean).join(' · ');
          rowEl.addEventListener('click', e => {
            e.stopPropagation();
            this._executeDatasetAction({ dataset: dsName, op: 'select', rowId: row._rowId }, [], row);
            this.render();
          });
          boardEl.appendChild(rowEl);
          return;
        }

        const baseZ = (repNode.renderOrder || 1) + 1 + idx * (tplNodes.length + 1);
        tplNodes.forEach((tn, tplIdx) => {
          const clone = {
            ...tn,
            id: tn.id + '__' + row._rowId,
            scopedId: repNode.scopedId + '/row_' + idx + '/' + tn.id,
            x: offsetX + (tn.relX ?? 0),
            y: offsetY + (tn.relY ?? 0),
            renderOrder: baseZ + tplIdx,
            text: String(this.evaluateExpression(tn.rawText || tn.text || '', row)),
          };
          const childEl = this._createNodeElement(clone, true, row);
          childEl.setAttribute('data-repeater-row-id', String(row._rowId));
          childEl.setAttribute('data-template-node-id', tn.id);
          if (tplIdx === 0) childEl.classList.add('export-repeater-row');
          if (tplIdx === 0 && row._selected) {
            childEl.style.outline = '2px solid #2E6F57';
            childEl.style.outlineOffset = '-2px';
          }
          if (!clone.hasSupportedInteraction) {
            childEl.classList.add('is-interactive');
            childEl.addEventListener('click', e => {
              e.stopPropagation();
              this._executeDatasetAction({ dataset: dsName, op: 'select', rowId: row._rowId ?? row.id }, [], row);
              this.render();
            });
          }
          boardEl.appendChild(childEl);
        });
      });
    }

    _createNodeElement(n, vis, rowContext) {
      const isBtn = n.type === 'button' && (n.hasSupportedInteraction || !n.unsupportedInteractions?.length);
      const el = document.createElement(n.type === 'input' ? 'input' : isBtn ? 'button' : 'div');
      if (isBtn) el.type = 'button';
      if (n.type === 'input') el.type = 'text';

      el.className = 'export-node export-node-' + n.type +
        (n.hasSupportedInteraction ? ' is-interactive' : '') +
        (n.unsupportedInteractions?.length && !n.hasSupportedInteraction ? ' is-unsupported-interaction' : '');
      el.setAttribute('data-node-id', n.id);
      el.setAttribute('data-scoped-id', n.scopedId);
      el.setAttribute('data-node-type', n.type);
      if (n.role) el.setAttribute('data-role', n.role);
      if (n.unsupportedInteractions?.length) {
        el.setAttribute('data-unsupported-interaction', n.unsupportedInteractions.map(u => u.reason).join('; '));
        el.setAttribute('aria-disabled', 'true');
      }

      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      el.style.width = n.w + 'px';
      el.style.height = n.h + 'px';
      el.style.zIndex = String(n.renderOrder || 1);
      el.style.display = vis ? (n.type === 'button' || n.textAlign === 'center' ? 'flex' : 'block') : 'none';

      if (n.fill && n.type !== 'path') el.style.background = n.fill;
      for (const [key, value] of Object.entries(n.paint || {})) el.style.setProperty(key, value);
      if (n.stroke && n.strokeWidth > 0 && n.type !== 'path') {
        el.style.border = n.strokeWidth + 'px ' + (n.strokeStyle || 'solid') + ' ' + n.stroke;
      }
      if (n.radius > 0) el.style.borderRadius = n.radius + 'px';
      if (n.opacity !== undefined && n.opacity !== 1) el.style.opacity = String(n.opacity);
      if (n.threeDTransform) el.style.transform = n.threeDTransform;
      else if (n.rotation) el.style.transform = 'rotate(' + n.rotation + 'deg)';
      if (n.clip || n.overflow === 'hidden') el.style.overflow = 'hidden';
      if (n.booleanRect) el.style.pointerEvents = 'none';

      if (n.type === 'path' && n.svgD) {
        const vb = n.svgViewBox || { x: 0, y: 0, w: n.w || 100, h: n.h || 100 };
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('class', 'export-vector-svg');
        svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('preserveAspectRatio', 'none');
        if (n.booleanRect) {
          const rect = n.booleanRect;
          Object.assign(svg.style, {
            position: 'absolute', left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px',
            pointerEvents: 'none',
          });
        }
        const path = document.createElementNS(svgNS, 'path');
        if (n.booleanRect) path.setAttribute('pointer-events', 'visiblePainted');
        path.setAttribute('d', n.svgD);
        path.setAttribute('fill', n.fill || 'none');
        path.setAttribute('fill-rule', n.fillRule || 'nonzero');
        path.setAttribute('stroke', n.stroke || 'none');
        path.setAttribute('stroke-width', String(n.stroke ? (n.strokeWidth ?? 1) : 0));
        path.setAttribute('stroke-linecap', n.strokeLinecap || 'round');
        path.setAttribute('stroke-linejoin', n.strokeLinejoin || 'round');
        if (n.strokeDasharray) path.setAttribute('stroke-dasharray', n.strokeDasharray);
        svg.appendChild(path);
        el.appendChild(svg);
      } else if (n.type === 'image') {
        if (n.src) {
          const img = document.createElement('img');
          img.src = n.src;
          img.alt = n.name || n.id;
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.objectFit = n.objectFit || 'cover';
          img.style.display = 'block';
          el.appendChild(img);
        } else {
          el.textContent = n.name || n.id;
        }
      } else if (n.type === 'input') {
        const val = this.inputs[n.scopedId] ?? n.value ?? '';
        el.value = val;
        el.placeholder = n.placeholder || '';
        el.style.color = n.color || '#1E293B';
        el.style.fontSize = (n.fontSize || 14) + 'px';
        el.style.fontFamily = (n.fontFamily || 'PingFang SC') + ', sans-serif';
        el.style.padding = '0 12px';
        el.addEventListener('input', e => {
          const v = e.target.value;
          this.inputs[n.scopedId] = v;
        });
      } else {
        const displayText = rowContext ? n.text : this.getWidgetText(n.scopedId);
        if (displayText || ['label', 'paragraph', 'button', 'badge'].includes(n.type)) {
          el.style.color = n.color || '#1E293B';
          el.style.fontSize = (n.fontSize || 14) + 'px';
          el.style.fontFamily = (n.fontFamily || 'PingFang SC') + ', sans-serif';
          el.style.fontWeight = String(n.fontWeight || 400);
          el.style.lineHeight = (n.lineHeight || Math.round((n.fontSize || 14) * 1.4)) + 'px';
          el.style.textAlign = n.textAlign || 'left';
          if (n.letterSpacing) el.style.letterSpacing = n.letterSpacing + 'px';
          if (n.padX || n.padY) el.style.padding = Math.round((n.padY || 0) / 2) + 'px ' + Math.round((n.padX || 0) / 2) + 'px';
          if (n.type === 'button' || n.textAlign === 'center') {
            el.style.alignItems = 'center';
            el.style.justifyContent = n.textAlign === 'center' ? 'center' : n.textAlign === 'right' ? 'flex-end' : 'flex-start';
          }
          if (displayText === n.text && n.spans?.length) {
            for (const span of n.spans) {
              const inline = document.createElement('span');
              inline.textContent = span.text;
              for (const [key, value] of Object.entries(span.css)) inline.style.setProperty(key, value);
              el.appendChild(inline);
            }
          } else {
            el.textContent = displayText;
          }
        }
      }

      if (n.hasSupportedInteraction && n.on?.click) {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const targetId = rowContext && n.id.includes('__') ? n.id.split('__')[0] : n.scopedId;
          this.click(targetId, rowContext);
        });
      }
      return el;
    }
  }

  window.__STUDIO_EXPORT_BUNDLE__ = BUNDLE;
  if (typeof document !== 'undefined') {
    const boot = () => {
      if (!window.__STUDIO_EXPORT_APP__) {
        window.__STUDIO_EXPORT_APP__ = new ExportRuntimeApp(BUNDLE);
        document.fonts?.ready.then(() => window.__STUDIO_EXPORT_APP__.render());
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})();
`;
}

export async function exportStudioDocumentToCode(
  doc,
  {
    outDir,
    projectDir = null,
    persistence = null,
    baseRevision = undefined,
    registerExport = true,
    resetRegistration = false,
  } = {}
) {
  if (!doc || typeof doc !== 'object') {
    throw Object.assign(new Error('缺少 Studio 权威文档'), { code: 'E_CODE_EXPORT_DOC_REQUIRED' });
  }
  if (!outDir || typeof outDir !== 'string') {
    throw Object.assign(new Error('必须提供代码导出目录 outDir'), { code: 'E_CODE_EXPORT_OUTDIR_REQUIRED' });
  }
  if (baseRevision !== undefined && baseRevision !== null && Number(baseRevision) !== Number(doc.revision)) {
    const scene = resolveDocumentScene(doc, { projectDir });
    throw Object.assign(
      new Error(`基准版本 r${baseRevision} 已过期（当前为 r${doc.revision}），拒绝将旧版本代码覆盖或登记为最新设计`),
      {
        code: 'E_STALE_REVISION',
        currentRevision: doc.revision,
        diagnostic: locateDiagnostic({ doc, scene, code: 'E_STALE_REVISION' }),
      }
    );
  }

  const absOutDir = isAbsolute(outDir) ? outDir : resolve(projectDir || process.cwd(), outDir);
  mkdirSync(absOutDir, { recursive: true });
  const assetsOutDir = join(absOutDir, 'assets');

  // Resolve default scene + inactive dynamic panel states
  const scene = resolveDocumentScene(doc, { projectDir });
  const rawVisMap = collectRawVisibilityMap(doc);
  const layoutAnalysis = analyzeDocumentInteractionsAndLayout(doc);
  const copiedFonts = [], fontCss = [];
  for (const font of Object.values(computeDependencyClosure(doc, { projectDir }).fonts.used)) {
    if (font.source !== 'project' || !font.relativePath || !font.filePresentInProject) continue;
    const dest = join(absOutDir, font.relativePath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(projectDir, font.relativePath), dest);
    const bytes = readFileSync(dest);
    copiedFonts.push({ family: font.family, exportedPath: font.relativePath, bytes: bytes.length, sha256: sha256(bytes) });
    fontCss.push(`@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(font.relativePath)});font-display:block;}`);
  }

  // Copy referenced local assets into <outDir>/assets/ and build relative rewrite map
  const assetRewriteMap = new Map();
  const copiedAssets = [];
  const missingAssets = [];
  const seenSrc = new Set();

  const extractCssUrls = str => {
    const out = [];
    if (typeof str !== 'string') return out;
    const re = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"'\s]+))\s*\)/gi;
    let m;
    while ((m = re.exec(str)) !== null) {
      const u = (m[1] || m[2] || m[3] || '').trim();
      if (u && !/^(?:https?:|data:|#)/i.test(u)) out.push(u);
    }
    return out;
  };
  const collectNodeAssetSources = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.src === 'string' && node.src.trim()) seenSrc.add(node.src.trim());
    if (Array.isArray(node.fills)) {
      for (const f of node.fills) {
        if (typeof f === 'string') for (const u of extractCssUrls(f)) seenSrc.add(u);
      }
    }
    if (node.css && typeof node.css === 'object') {
      for (const v of Object.values(node.css)) {
        if (typeof v === 'string') for (const u of extractCssUrls(v)) seenSrc.add(u);
      }
    }
    for (const ch of node.children || []) collectNodeAssetSources(ch);
    for (const st of node.states || []) if (st?.root) collectNodeAssetSources(st.root);
    if (node.template) collectNodeAssetSources(node.template);
  };
  for (const pg of doc.pages || []) collectNodeAssetSources(pg.root);
  for (const comp of Object.values(doc.components || {})) collectNodeAssetSources(comp?.root);
  for (const pg of scene.pages || []) {
    for (const n of pg.nodes || []) {
      if (n.type === 'image' && typeof n.src === 'string' && n.src.trim()) {
        seenSrc.add(n.src.trim());
      }
    }
  }
  for (const [srcKey] of Object.entries(doc.assetsManifest || {})) {
    if (srcKey) seenSrc.add(srcKey);
  }

  let assetIdx = 0;
  for (const rawSrc of seenSrc) {
    if (/^(https?:|data:)/i.test(rawSrc)) continue;
    const candidates = [
      projectDir ? resolve(projectDir, rawSrc) : null,
      isAbsolute(rawSrc) ? rawSrc : null,
    ].filter(Boolean);
    const foundPath = candidates.find(p => existsSync(p));
    if (!foundPath) {
      missingAssets.push({ src: rawSrc, reason: '源文件不存在' });
      continue;
    }
    mkdirSync(assetsOutDir, { recursive: true });
    assetIdx++;
    const ext = extname(foundPath) || '.png';
    const base = basename(foundPath, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const relTarget = `assets/${assetIdx}_${base}${ext}`;
    const destPath = join(absOutDir, relTarget);
    copyFileSync(foundPath, destPath);
    const bytes = readFileSync(destPath);
    assetRewriteMap.set(rawSrc, relTarget);
    copiedAssets.push({
      originalSrc: rawSrc,
      exportedPath: relTarget,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  // Build serialized pages, dynamic panel state subtrees, and repeater template blueprints
  const serializedPages = [];
  for (const pg of scene.pages || []) {
    const enrichNode = n => {
      const ownVisible = rawVisMap.has(n.scopedId) ? rawVisMap.get(n.scopedId) : Boolean(n.visible);
      const rawText = rawVisMap.get(`rawText:${n.scopedId}`) || n.text || '';
      return serializePageNode(
        { ...n, ownVisible, rawText, sourceSizing: rawVisMap.get(`sizing:${n.scopedId}`) },
        assetRewriteMap,
        layoutAnalysis.nodeUnsupportedMap,
        layoutAnalysis.nodeSupportedMap
      );
    };

    const allNodes = (pg.nodes || []).filter(n => !n.booleanOperand).map(enrichNode);
    const repeaterTemplates = {};
    for (const n of pg.nodes || []) {
      if (n.type === 'repeater') {
        const tplPrefix = `${n.scopedId}/template/`;
        const tplChildren = allNodes
          .filter(cand => cand.repeaterTemplateOwner === n.scopedId && cand.scopedId !== `${n.scopedId}/template/${cand.id}`)
          .map(cand => ({
            ...cand,
            relX: cand.x - n.x,
            relY: cand.y - n.y,
          }));
        // If template root itself has children or is a single widget
        const allTplNodes = allNodes
          .filter(cand => cand.repeaterTemplateOwner === n.scopedId && cand.scopedId.startsWith(tplPrefix))
          .map(cand => ({
            ...cand,
            relX: cand.x - n.x,
            relY: cand.y - n.y,
          }));
        repeaterTemplates[n.id] = tplChildren.length > 0 ? tplChildren : allTplNodes;
      }
    }

    const panelStateNodes = {};
    const visitedPanels = new Set();
    const panelQueue = (pg.nodes || [])
      .filter(n => !n.panelOwnerId && n.type === 'dynamic-panel' && Array.isArray(n.states) && n.states.length > 0)
      .map(pNode => ({ pNode, ancestorStates: {} }));
    while (panelQueue.length > 0) {
      const { pNode, ancestorStates } = panelQueue.shift();
      if (visitedPanels.has(pNode.scopedId)) continue;
      visitedPanels.add(pNode.scopedId);
      const stateMap = {};
      panelStateNodes[pNode.scopedId] = stateMap;
      if (!panelStateNodes[pNode.id]) panelStateNodes[pNode.id] = stateMap;
      for (const st of pNode.states) {
        const nextActiveStates = {
          ...ancestorStates,
          [pNode.scopedId]: st.id,
          [`${pg.id}/${pNode.id}`]: st.id,
          [pNode.id]: st.id,
        };
        const stScene = resolveDocumentScene(doc, {
          projectDir,
          activePanelStates: nextActiveStates,
        });
        const stPg = stScene.pages.find(x => x.id === pg.id);
        const statePrefix = `${pNode.scopedId}/${st.id}/`;
        const rawSubtree = (stPg?.nodes || []).filter(
          cand => cand.scopedId.startsWith(statePrefix) && cand.panelOwnerId === pNode.id && !cand.booleanOperand
        );
        stateMap[st.id] = rawSubtree.map(enrichNode);
        for (const childNode of rawSubtree) {
          if (childNode.type === 'dynamic-panel' && Array.isArray(childNode.states) && childNode.states.length > 0) {
            panelQueue.push({ pNode: childNode, ancestorStates: nextActiveStates });
          }
        }
      }
    }

    serializedPages.push({
      id: pg.id,
      name: pg.name || pg.id,
      domain: pg.domain || doc.domain || 'web',
      device: pg.device || null,
      board: pg.board,
      nodes: allNodes,
      repeaterTemplates,
      panelStateNodes,
    });
  }

  // Datasets closure (combine doc.datasets + any inline repeater rows)
  const datasets = {};
  for (const [dsName, ds] of Object.entries(doc.datasets || {})) {
    const rows = Array.isArray(ds?.rows) ? structuredClone(ds.rows) : Array.isArray(ds) ? structuredClone(ds) : [];
    datasets[dsName] = rows;
  }
  // Inline repeater rows live on the raw document tree (full rows, not the
  // paged view carried by resolved scene nodes); walk it for the closure.
  const collectInlineDatasets = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'repeater') {
      const key = repeaterDatasetName(node);
      const inline = repeaterInlineRows(node);
      if (key && inline.length && !datasets[key]) datasets[key] = structuredClone(inline);
      else if (key && !inline.length && Array.isArray(node.rows) && !datasets[key]) datasets[key] = structuredClone(node.rows);
    }
    for (const ch of node.children || []) collectInlineDatasets(ch);
    for (const st of node.states || []) if (st.root) collectInlineDatasets(st.root);
    if (node.template) collectInlineDatasets(node.template);
  };
  for (const pg of doc.pages || []) collectInlineDatasets(pg.root);

  const bundlePayload = {
    schemaVersion: 1,
    exporterVersion: CODE_EXPORTER_VERSION,
    documentId: doc.documentId,
    name: doc.name || 'Studio Prototype',
    revision: doc.revision,
    contentHash: doc.contentHash,
    domain: doc.domain || 'web',
    variables: structuredClone(doc.variables || {}),
    datasets,
    pages: serializedPages,
  };

  const firstPage = serializedPages[0] || {
    id: 'home',
    name: '首页',
    board: { screenW: 1440, screenH: 900 },
    nodes: [],
  };
  const initialNodesHtml = firstPage.nodes.map(renderStaticInitialNodeHtml).filter(Boolean).join('\n      ');
  const isFixedBoard = layoutAnalysis.declaredBreakpoints.length === 0;
  const boardModeLabel = isFixedBoard
    ? `固定画板 ${firstPage.board.screenW}×${firstPage.board.screenH} (非伪响应式)`
    : `已声明断点 (${layoutAnalysis.declaredBreakpoints.map(b => `${b.name}:${b.width}px`).join(', ')})`;

  const indexHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(doc.name || 'Studio Export')}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body data-document-id="${escapeHtml(doc.documentId)}" data-revision="${doc.revision}" data-content-hash="${escapeHtml(doc.contentHash)}" data-layout-mode="${isFixedBoard ? 'fixed-board' : 'declared-breakpoints'}" data-adaptive-views="${isFixedBoard ? 'none' : 'declared'}">
  <header class="export-topbar">
    <div class="export-brand">
      <span>${escapeHtml(doc.name || 'Studio Export')}</span>
      <span class="export-badge" id="studio-export-layout-badge">${escapeHtml(boardModeLabel)}</span>
      <span class="export-badge" id="studio-export-status">${escapeHtml(firstPage.name)} (${firstPage.board.screenW}×${firstPage.board.screenH}) · r${doc.revision}</span>
    </div>
    <nav class="export-page-tabs" id="studio-export-tabs">
      ${serializedPages
        .map(
          (p, idx) =>
            `<button type="button" class="export-page-tab${idx === 0 ? ' active' : ''}" data-page-tab="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`
        )
        .join('')}
    </nav>
  </header>
  <main class="export-stage" id="studio-export-stage">
    <div class="export-board" id="studio-export-board" data-page-id="${escapeHtml(firstPage.id)}" style="width:${firstPage.board.screenW}px;height:${firstPage.board.screenH}px;">
      ${initialNodesHtml}
    </div>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

  const stylesCss = fontCss.join('\n') + '\n' + buildStylesCss(doc, layoutAnalysis);
  const appJs = buildAppJs(bundlePayload);

  const indexHtmlPath = join(absOutDir, 'index.html');
  const stylesCssPath = join(absOutDir, 'styles.css');
  const appJsPath = join(absOutDir, 'app.js');
  const readmePath = join(absOutDir, 'README.md');
  const manifestPath = join(absOutDir, 'manifest.json');

  writeFileSync(indexHtmlPath, indexHtml, 'utf8');
  writeFileSync(stylesCssPath, stylesCss, 'utf8');
  writeFileSync(appJsPath, appJs, 'utf8');

  const readmeContent = `# ${doc.name || 'Studio 可运行代码工程包'}

- **工程 ID (\`documentId\`)**: \`${doc.documentId}\`
- **绑定版本 (\`revision\`)**: \`r${doc.revision}\`
- **内容哈希 (\`contentHash\`)**: \`${doc.contentHash}\`
- **画板与响应式说明**: ${boardModeLabel}（保留声明过的约束/断点，固定画板如实标记，不编造响应式行为）
- **交互兼容统计**: 已支持交互 ${layoutAnalysis.supported.length} 项，不支持并显式禁用交互 ${layoutAnalysis.unsupported.length} 项

## 本地运行方式

1. **静态服务运行（推荐）**:
   \`\`\`bash
   cd "${absOutDir}"
   python3 -m http.server 8080
   # 浏览器访问 http://127.0.0.1:8080/index.html
   \`\`\`
2. **直接打开**:
   直接在现代浏览器中打开 \`index.html\`，或通过 \`window.__STUDIO_EXPORT_APP__\` 调用 \`runScenario(steps)\` 验证业务场景。

## 文件结构

- \`index.html\`: 页面壳、画板尺寸元信息与首屏节点结构
- \`styles.css\`: 设计 Token 变量、画板与节点样式表
- \`app.js\`: 离线运行时（复用同一语义源布局、全局变量、动态面板状态、多页导航、中继器筛选/排序/增删改与矢量路径渲染）
- \`manifest.json\`: 版本绑定、文件 SHA-256 指纹、资源闭包与不支持交互逐项清单
- \`assets/\`: 离线打包的本地图片与媒体资源
`;
  writeFileSync(readmePath, readmeContent, 'utf8');

  const filesChecksums = {
    'index.html': sha256(Buffer.from(indexHtml, 'utf8')),
    'styles.css': sha256(Buffer.from(stylesCss, 'utf8')),
    'app.js': sha256(Buffer.from(appJs, 'utf8')),
    'README.md': sha256(Buffer.from(readmeContent, 'utf8')),
  };
  for (const asset of copiedAssets) {
    filesChecksums[asset.exportedPath] = asset.sha256;
  }
  for (const font of copiedFonts) filesChecksums[font.exportedPath] = font.sha256;

  const manifest = {
    schemaVersion: 1,
    kind: 'studio-code-export',
    exporterVersion: CODE_EXPORTER_VERSION,
    exportedAt: new Date().toISOString(),
    documentId: doc.documentId,
    name: doc.name || 'Studio Prototype',
    revision: doc.revision,
    contentHash: doc.contentHash,
    entryHtml: 'index.html',
    files: filesChecksums,
    pages: serializedPages.map(p => ({
      id: p.id,
      name: p.name,
      board: { w: p.board.screenW, h: p.board.screenH },
      nodeCount: p.nodes.length,
    })),
    layoutMode: {
      fixedBoard: isFixedBoard,
      responsiveFabricated: false,
      boards: serializedPages.map(p => ({ pageId: p.id, w: p.board.screenW, h: p.board.screenH })),
      declaredBreakpoints: layoutAnalysis.declaredBreakpoints,
      constraintNodeCount: layoutAnalysis.constraintNodes.length,
      constraints: layoutAnalysis.constraintNodes,
    },
    interactionCompatibility: {
      totalInteractions: layoutAnalysis.supported.length + layoutAnalysis.unsupported.length,
      supportedCount: layoutAnalysis.supported.length,
      unsupportedCount: layoutAnalysis.unsupported.length,
      fakeButtonsEmitted: 0,
      supported: layoutAnalysis.supported,
      unsupported: layoutAnalysis.unsupported,
    },
    // 视觉属性导出口径（S3-1）：此前 threeDTransform 被静默丢弃且无披露，现按原值导出为 CSS transform。
    visualCompatibility: {
      threeDTransform: '按节点原值导出为内联 CSS transform（不丢弃）',
      rotation: '导出为 transform: rotate(<deg>deg)',
      ambiguity: 'threeDTransform 与 rotation 同时存在时只输出 threeDTransform',
    },
    assets: copiedAssets,
    fonts: copiedFonts,
    missingAssets,
    fontDiagnostics: scene.fontDiagnostics || [],
    roundtripPolicy: {
      registersToProject: true,
      arbitraryHandEditedHtmlLosslessWritebackPromised: false,
    },
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  let registration = null;
  const warnings = [];
  let registrationReset = null;
  const targetStudioDir = persistence?.studioDir || (projectDir ? join(projectDir, '.studio') : null);
  if (registerExport && targetStudioDir) {
    mkdirSync(targetStudioDir, { recursive: true });
    const regPath = join(targetStudioDir, 'code-exports.json');
    let history = { exports: [] };
    let corrupted = false;
    if (existsSync(regPath)) {
      try {
        const parsed = JSON.parse(readFileSync(regPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.exports)) history = parsed;
        else corrupted = true;
      } catch { corrupted = true; }
      if (corrupted || resetRegistration) {
        // 登记文件损坏或调用方要求重置时，先保留原文件再清空，避免静默丢弃历史。
        const backupPath = `${regPath}.bak-${Date.now()}`;
        try {
          copyFileSync(regPath, backupPath);
          registrationReset = { backupPath };
        } catch {
          registrationReset = { backupPath: null };
        }
      }
    }
    if (corrupted || resetRegistration) history = { exports: [] };
    const exportsList = Array.isArray(history.exports) ? history.exports : [];
    // contentHash 作为登记主键：revision 会跨重启漂移（启动规范化会改写文档），不能用来判定新旧。
    const sameContent = doc.contentHash
      ? exportsList.find(e => e && e.contentHash === doc.contentHash && (!e.documentId || e.documentId === doc.documentId))
      : null;
    const registeredEntry = {
      documentId: doc.documentId,
      revision: doc.revision,
      contentHash: doc.contentHash,
      outDir: absOutDir,
      manifestPath,
      exportedAt: manifest.exportedAt,
      manifestSha256: sha256(readFileSync(manifestPath)),
    };
    if (sameContent) {
      registration = { ...sameContent, ...registeredEntry, reused: true };
      history.exports = exportsList.map(e => (e === sameContent ? registration : e));
    } else {
      const latestRegisteredRev = Math.max(0, ...exportsList.map(e => Number(e.revision || 0)));
      if (Number(doc.revision) < latestRegisteredRev) {
        warnings.push({
          code: 'W_CODE_EXPORT_REVISION_ROLLBACK',
          message: `本次导出的修订号 r${doc.revision} 低于已登记的最新修订号 r${latestRegisteredRev}；内容哈希已变化，按新内容登记`,
          latestRegisteredRevision: latestRegisteredRev,
        });
      }
      registration = { ...registeredEntry, reused: false };
      history.exports = [...exportsList, registration];
    }
    history.latest = registration;
    writeFileSync(regPath, JSON.stringify(history, null, 2) + '\n', 'utf8');
  }

  return {
    ok: true,
    outDir: absOutDir,
    entryHtmlPath: indexHtmlPath,
    manifestPath,
    readmePath,
    documentId: doc.documentId,
    revision: doc.revision,
    contentHash: doc.contentHash,
    manifest,
    registration,
    ...(registrationReset ? { registrationReset } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
