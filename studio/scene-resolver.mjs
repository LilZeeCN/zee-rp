import { BoundedCache } from './bounded-cache.mjs';
import {applyRepeaterView,bindRepeaterTemplate,repeaterDatasetName,repeaterRows} from './repeater-view.mjs';
import { DEVICE_PRESETS, RENDERER_VERSION, currentDocumentDiagnostics, getCachedNodeCanonical, nodeEvents } from './document.mjs';
import { normalizeVisualCss } from './visual-style.mjs';
import {
  measureLineWidthExact,
  wrapTextLinesExact,
  measureTextBoxExact,
  resolveFontDescriptor,
  getFontResourceVersion,
  getTypographyCacheStats,
} from './typography.mjs';
import {
  CORE_COMPONENT_CONTRACTS,
  validateComponentInstanceAgainstContract,
  resolveContractPropsAndStateOverrides,
} from './component-contracts.mjs';
import { normalizeVectorNodeSpec } from './vector-paths.mjs';
export { RENDERER_VERSION };

export function parsePadding(pad) {
  if (pad === undefined || pad === null) return [0, 0, 0, 0];
  if (typeof pad === 'number') return [pad, pad, pad, pad];
  if (Array.isArray(pad)) {
    if (pad.length === 1) return [pad[0], pad[0], pad[0], pad[0]];
    if (pad.length === 2) return [pad[0], pad[1], pad[0], pad[1]];
    if (pad.length === 4) return [pad[0], pad[1], pad[2], pad[3]];
  }
  return [0, 0, 0, 0];
}

export function resolveColorValue(val, palette = {}) {
  if (!val || typeof val !== 'string') return val || null;
  if (val.startsWith('$')) {
    const key = val.slice(1);
    if (palette[key]) return palette[key];
    if (key === 'muted' && palette['ink-2']) return palette['ink-2'];
    if (key === 'error' && palette.danger) return palette.danger;
  }
  if (palette[val]) return palette[val];
  return val;
}

export function measureLineWidth(line, fontSize = 14, fontWeight = 400, letterSpacing = 0, fontFamily = 'PingFang SC') {
  return Math.ceil(
    measureLineWidthExact(line, {
      fontFamily,
      fontSize,
      fontWeight,
      letterSpacing,
    })
  );
}

export function wrapTextLines(text, maxWidth, fontSize = 14, fontWeight = 400, letterSpacing = 0, fontFamily = 'PingFang SC') {
  return wrapTextLinesExact(text, maxWidth, {
    fontFamily,
    fontSize,
    fontWeight,
    letterSpacing,
  });
}

export function measureTextBox(node, availableW = null, options = {}) {
  return measureTextBoxExact(node, availableW, options);
}

function expandMacroNode(node, palette) {
  const n = {
    ...node,
    ...(node.css && typeof node.css === 'object' ? { css: { ...node.css } } : {}),
    ...(node.constraints && typeof node.constraints === 'object' ? { constraints: { ...node.constraints } } : {}),
    ...(node.on && typeof node.on === 'object' ? { on: structuredClone(node.on) } : {}),
    ...(Array.isArray(node.padding) ? { padding: [...node.padding] } : {}),
  };
  if (n.type === 'phone-shell') {
    n.layout ??= 'column';
    n.gap ??= 12;
    if (n.fill === undefined) n.fill = n.screenFill ?? '$bg';
    if ((!Array.isArray(n.children) || n.children.length === 0) && Array.isArray(n.body)) {
      n.children = structuredClone(n.body);
    }
  } else if (n.type === 'card' && (!Array.isArray(n.children) || n.children.length === 0) && (n.title || n.body || n.subtitle || n.tag)) {
    const children = [];
    const tagTone = n.tagTone || n.tone;
    if (n.tag) {
      children.push({
        type: 'button',
        id: `${n.id}_tag`,
        name: `${n.id}_tag`,
        text: String(n.tag),
        h: 24,
        w: 'hug',
        fontSize: 11,
        fontWeight: 600,
        radius: 12,
        fill: tagTone === 'error' || tagTone === 'danger' ? '#FEE2E2' : '$brand-soft',
        color: tagTone === 'error' || tagTone === 'danger' ? '$danger' : '$brand',
        controlledByMacro: n.id,
      });
    }
    if (n.title) {
      children.push({
        type: 'label',
        id: `${n.id}_title`,
        name: `${n.id}_title`,
        text: String(n.title),
        w: 'fill',
        h: 'hug',
        fontSize: n.titleFontSize ?? 16,
        fontWeight: 600,
        color: '$ink',
        controlledByMacro: n.id,
      });
    }
    if (n.subtitle) {
      children.push({
        type: 'label',
        id: `${n.id}_subtitle`,
        name: `${n.id}_subtitle`,
        text: String(n.subtitle),
        w: 'fill',
        h: 'hug',
        fontSize: 12,
        fontWeight: 400,
        color: '$ink-2',
        controlledByMacro: n.id,
      });
    }
    if (n.body) {
      children.push({
        type: 'paragraph',
        id: `${n.id}_body`,
        name: `${n.id}_body`,
        text: String(n.body),
        w: 'fill',
        h: 'hug',
        fontSize: 13,
        fontWeight: 400,
        color: '$ink',
        wrap: true,
        controlledByMacro: n.id,
      });
    }
    if (n.actionText) {
      children.push({
        type: 'button',
        id: `${n.id}_action`,
        name: `${n.id}_action`,
        text: String(n.actionText),
        w: 'fill',
        h: 36,
        fontSize: 13,
        fontWeight: 600,
        radius: 10,
        fill: '$brand',
        color: '#FFFFFF',
        ...(n.goto ? { on: { click: [{ type: 'link', page: n.goto }] } } : {}),
        controlledByMacro: n.id,
      });
    }
    n.layout = n.layout || 'column';
    n.padding = n.padding ?? 16;
    n.gap = n.gap ?? 8;
    if (n.variant === 'outlined' || n.variant === 'outline') n.stroke = n.stroke || '$line';
    n.fill = n.fill || (n.variant === 'soft' || n.variant === 'subtle' ? '$surface-2' : '$surface');
    n.radius = n.radius ?? 16;
    n.children = children;
  } else if (n.type === 'stat-row' && Array.isArray(n.items)) {
    n.layout = 'row';
    n.gap = n.gap ?? 10;
    const cardPad = n.cardPadding ?? 12;
    n.children = n.items.map((it, idx) => ({
      type: 'box',
      id: `${n.id}_stat_${idx}`,
      name: `${n.id}_stat_${idx}`,
      layout: 'column',
      flex: 1,
      h: n.equalHeight ? 'fill' : 'hug',
      padding: cardPad,
      gap: 4,
      fill: '$surface',
      radius: 12,
      controlledByMacro: n.id,
      children: [
        { type: 'label', id: `${n.id}_val_${idx}`, name: `${n.id}_val_${idx}`, text: String(it.value ?? ''), fontSize: it.valueFontSize ?? n.valueFontSize ?? 20, fontWeight: 700, color: it.color || '$brand', w: 'fill', h: 'hug', controlledByMacro: n.id },
        { type: 'label', id: `${n.id}_lbl_${idx}`, name: `${n.id}_lbl_${idx}`, text: String(it.label ?? ''), fontSize: 12, fontWeight: 500, color: '$ink', w: 'fill', h: 'hug', controlledByMacro: n.id },
      ],
    }));
  } else if (n.type === 'list-item' && (!Array.isArray(n.children) || n.children.length === 0)) {
    n.layout = 'row';
    n.align = 'center';
    n.padding = n.padding ?? 12;
    n.gap = n.gap ?? 10;
    n.fill = n.fill || '$surface';
    n.radius = n.radius ?? 12;
    const subText = n.subtitle ?? n.meta;
    const rightBadge = n.rightBadge ?? n.badge ?? n.tag ?? n.value ?? n.rightText ?? n.status;
    const rightTone = n.rightTone || n.badgeVariant || n.tagTone || n.tone || n.rightVariant;
    n.children = [
      ...(n.index !== undefined && n.index !== null ? [{
        type: 'badge',
        id: `${n.id}_idx`,
        name: `${n.id}_idx`,
        text: String(n.index),
        w: 24,
        h: 24,
        fontSize: 11,
        fontWeight: 600,
        radius: 12,
        fill: '$surface-2',
        color: '$ink-2',
        controlledByMacro: n.id,
      }] : n.icon ? [{
        type: 'icon',
        id: `${n.id}_icon`,
        name: `${n.id}_icon`,
        icon: String(n.icon),
        w: 20,
        h: 20,
        color: '$brand',
        controlledByMacro: n.id,
      }] : []),
      {
        type: 'box',
        id: `${n.id}_main`,
        name: `${n.id}_main`,
        layout: 'column',
        flex: 1,
        h: 'hug',
        gap: 4,
        controlledByMacro: n.id,
        children: [
          { type: 'label', id: `${n.id}_title`, name: `${n.id}_title`, text: String(n.title || n.text || ''), fontSize: 15, fontWeight: 600, color: '$ink', w: 'fill', h: 'hug', controlledByMacro: n.id },
          ...(subText ? [{ type: 'label', id: `${n.id}_sub`, name: `${n.id}_sub`, text: String(subText), fontSize: 12, fontWeight: 400, color: '$ink-2', w: 'fill', h: 'hug', controlledByMacro: n.id }] : []),
        ],
      },
      ...(rightBadge ? [{
        type: 'button',
        id: `${n.id}_badge`,
        name: `${n.id}_badge`,
        text: String(rightBadge),
        w: 'hug',
        h: 26,
        fontSize: 11,
        fontWeight: 600,
        radius: 13,
        fill: rightTone === 'error' || rightTone === 'danger' ? '#FEE2E2' : '$brand-soft',
        color: rightTone === 'error' || rightTone === 'danger' ? '$danger' : '$brand',
        controlledByMacro: n.id,
      }] : []),
    ];
    const targetPage = n.goto || n.page || n.link;
    if (targetPage && !n.on) {
      n.on = { click: [{ type: 'link', page: targetPage }] };
    }
  }
  return n;
}

function expandComponentInstance(instanceNode, doc, instanceChain = [], instancePathPrefix = '') {
  const compId = instanceNode.component || instanceNode.use;
  const compDef = doc.components?.[compId] || CORE_COMPONENT_CONTRACTS[compId]?.definition;
  if (!compDef) {
    throw Object.assign(
      new Error(`未找到组件定义 "${compId}" (节点 ${instanceNode.id})`),
      { code: 'E_UNKNOWN_COMPONENT', nodeId: instanceNode.id, component: compId }
    );
  }
  if (instanceChain.includes(compId)) {
    const cycle = [...instanceChain, compId].join(' -> ');
    throw Object.assign(
      new Error(`检测到组件循环引用: ${cycle}`),
      { code: 'E_COMPONENT_CYCLE', nodeId: instanceNode.id, cycle }
    );
  }

  const nextChain = [...instanceChain, compId];
  const contractRes = resolveContractPropsAndStateOverrides(instanceNode, compDef, doc);
  const contractMappedOverrides = contractRes.mappedOverrides || {};
  const variantName =
    instanceNode.variant ||
    instanceNode.props?.tone ||
    contractMappedOverrides.$root?.variant ||
    compDef.defaultVariant ||
    'default';
  const variantOverrides = compDef.variants?.[variantName] || {};
  const rawInstanceOverrides = instanceNode.overrides || {};
  const instanceOverrides = {};
  for (const [k, v] of Object.entries(contractMappedOverrides)) {
    instanceOverrides[k] = typeof v === 'object' && v !== null ? { ...v } : v;
  }
  for (const [k, v] of Object.entries(rawInstanceOverrides)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      instanceOverrides[k] = { ...(instanceOverrides[k] || {}), ...v };
    } else {
      instanceOverrides[k] = typeof v === 'object' && v !== null ? structuredClone(v) : v;
    }
  }
  const instPath = instancePathPrefix ? `${instancePathPrefix}/${instanceNode.id}` : instanceNode.id;

  function applyTree(defNode, isRoot = false) {
    const clone = {
      ...defNode,
      ...(defNode.css && typeof defNode.css === 'object' ? { css: { ...defNode.css } } : {}),
      ...(defNode.constraints && typeof defNode.constraints === 'object' ? { constraints: { ...defNode.constraints } } : {}),
      ...(defNode.on && typeof defNode.on === 'object' ? { on: structuredClone(defNode.on) } : {}),
      ...(Array.isArray(defNode.padding) ? { padding: [...defNode.padding] } : {}),
      ...(Array.isArray(defNode.spans) ? { spans: structuredClone(defNode.spans) } : {}),
    };
    const origSubId = clone.id;
    clone._fromComponentId = compId;
    const rootVariantDirect = {};
    if (isRoot && variantOverrides && typeof variantOverrides === 'object') {
      for (const [vk, vv] of Object.entries(variantOverrides)) {
        if (vk !== '$root' && (typeof vv !== 'object' || vv === null || Array.isArray(vv))) {
          rootVariantDirect[vk] = vv;
        }
      }
    }
    const vOvr = {
      ...rootVariantDirect,
      ...(isRoot ? variantOverrides.$root || {} : {}),
      ...(variantOverrides[origSubId] || {}),
    };
    const iOvr = {
      ...(isRoot ? instanceOverrides.$root || instanceOverrides._self || {} : {}),
      ...(instanceOverrides[origSubId] || {}),
    };

    // A plain text override replaces any inherited rich text.
    if (Object.hasOwn(vOvr, 'text') && !Object.hasOwn(vOvr, 'spans')) delete clone.spans;
    for (const [k, v] of Object.entries(vOvr)) {
      if (k !== 'id' && k !== 'children') clone[k] = typeof v === 'object' && v !== null ? structuredClone(v) : v;
    }
    if (Object.hasOwn(iOvr, 'text') && !Object.hasOwn(iOvr, 'spans')) delete clone.spans;
    for (const [k, v] of Object.entries(iOvr)) {
      if (k !== 'id' && k !== 'children') clone[k] = typeof v === 'object' && v !== null ? structuredClone(v) : v;
    }

    if (isRoot) {
      clone.id = instanceNode.id;
      clone.name = instanceNode.name || instanceNode.id;
      clone.state = instanceNode.state || 'default';
      for (const geomKey of ['x', 'y', 'w', 'h', 'minW', 'maxW', 'minH', 'maxH', 'flex', 'align', 'justify', 'visible', 'locked']) {
        if (instanceNode[geomKey] !== undefined && iOvr[geomKey] === undefined) {
          clone[geomKey] = instanceNode[geomKey];
        }
      }
      if (instanceNode.text !== undefined && iOvr.text === undefined) {
        clone.text = instanceNode.text;
      }
      if (instanceNode.fill !== undefined && iOvr.fill === undefined) {
        clone.fill = instanceNode.fill;
      }
      if (instanceNode.on && !clone.on) {
        clone.on = structuredClone(instanceNode.on);
      }
      if (contractRes.stateInteractive === false) {
        clone.interactive = false;
        clone.on = null;
      }
    } else {
      clone.id = `${instanceNode.id}__${origSubId}`;
      clone.name = clone.name ? `${instanceNode.id}_${clone.name}` : clone.id;
      if (contractRes.stateInteractive === false) {
        clone.on = null;
      }
    }

    clone.componentSource = {
      instanceId: instanceNode.id,
      instancePath: instPath,
      componentId: compId,
      contractVersion: contractRes.contractVersion || compDef.contractVersion || '1.0.0',
      subNodeId: origSubId,
      isInstanceRoot: isRoot,
      variant: variantName,
      state: instanceNode.state || 'default',
      overriddenProps: Object.keys(iOvr),
    };

    if (clone.type === 'instance' || clone.type === 'use' || clone.component) {
      // Nested component instance! Merge parent instance overrides scoped to nested child
      const nestedOverrides = { ...(clone.overrides || {}) };
      const prefix = `${origSubId}/`;
      for (const [ok, ov] of Object.entries(instanceOverrides)) {
        if (ok.startsWith(prefix)) {
          nestedOverrides[ok.slice(prefix.length)] = ov;
        }
      }
      clone.overrides = nestedOverrides;
      return expandComponentInstance(clone, doc, nextChain, instPath);
    }

    if (Array.isArray(clone.children)) {
      clone.children = clone.children.map(ch => applyTree(ch, false));
    }
    if (isRoot && instanceNode.slots && typeof instanceNode.slots === 'object') {
      clone.children = Array.isArray(clone.children) ? clone.children : [];
      for (const [slotId, slotItems] of Object.entries(instanceNode.slots)) {
        const list = Array.isArray(slotItems) ? slotItems : [slotItems];
        for (const [sIdx, item] of list.entries()) {
          if (!item || typeof item !== 'object') continue;
          const slotClone = structuredClone(item);
          slotClone.id = slotClone.id || `${instPath}__slot_${slotId}_${sIdx + 1}`;
          slotClone._fromComponentId = compId;
          clone.children.push(slotClone);
        }
      }
    }
    return clone;
  }

  return applyTree(compDef.root, true);
}

function validateNodeSizing(node, parentLayout = null) {
  for (const [minK, maxK, label] of [['minW', 'maxW', 'width'], ['minH', 'maxH', 'height']]) {
    if (typeof node[minK] === 'number' && typeof node[maxK] === 'number' && node[minK] > node[maxK]) {
      throw Object.assign(
        new Error(`节点 "${node.id}" 的最小尺寸 (${minK}=${node[minK]}) 大于最大尺寸 (${maxK}=${node[maxK]})`),
        { code: 'E_SIZE_DEPENDENCY', nodeId: node.id, field: minK }
      );
    }
  }
  for (const dimKey of ['w', 'h']) {
    if (typeof node[dimKey] === 'number' && node[dimKey] < 0) {
      throw Object.assign(
        new Error(`节点 "${node.id}" 的尺寸 ${dimKey}=${node[dimKey]} 不能为负数`),
        { code: 'E_SIZE_DEPENDENCY', nodeId: node.id, field: dimKey }
      );
    }
  }
  // Check circular size dependency: parent has w="hug" (and no minW) while all children have w="fill" (and no fixed/minW)
  const layout = node.layout || (node.type === 'phone-shell' ? 'column' : 'stack');
  if ((layout === 'row' || layout === 'column') && Array.isArray(node.children) && node.children.length > 0) {
    if (node.w === 'hug' && typeof node.minW !== 'number') {
      const allFillWithoutBase = node.children.every(ch => ch.w === 'fill' && typeof ch.minW !== 'number' && ch.type === 'box' && (!ch.children || ch.children.length === 0));
      if (allFillWithoutBase) {
        throw Object.assign(
          new Error(`节点 "${node.id}" 存在循环宽度依赖：父容器 w="hug" 且子容器全部依赖父容器 w="fill"`),
          { code: 'E_SIZE_DEPENDENCY', nodeId: node.id, field: 'w' }
        );
      }
    }
    if (node.h === 'hug' && typeof node.minH !== 'number') {
      const allFillWithoutBase = node.children.every(ch => ch.h === 'fill' && typeof ch.minH !== 'number' && ch.type === 'box' && (!ch.children || ch.children.length === 0));
      if (allFillWithoutBase) {
        throw Object.assign(
          new Error(`节点 "${node.id}" 存在循环高度依赖：父容器 h="hug" 且子容器全部依赖父容器 h="fill"`),
          { code: 'E_SIZE_DEPENDENCY', nodeId: node.id, field: 'h' }
        );
      }
    }
  }
}

function clampDim(val, minV, maxV) {
  let out = val;
  if (typeof minV === 'number' && Number.isFinite(minV)) out = Math.max(out, minV);
  if (typeof maxV === 'number' && Number.isFinite(maxV)) out = Math.min(out, maxV);
  return out;
}

// Same dense placement rule as RP/1's _plan_bento_grid. Source order remains
// authoritative; spans occupy cells rather than overlapping later children.
function planGrid(node) {
  const columns = node.columns ?? 2;
  if (!Number.isInteger(columns) || columns < 1) throw Object.assign(new Error('grid.columns必须是正整数'), {code:'E_GRID_SIZE',nodeId:node.id,field:'columns'});
  const occupied = new Set(), placements = [];
  let rows = 0;
  for (const child of node.children || []) {
    const colSpan = Math.min(columns, child.colSpan ?? 1), rowSpan = child.rowSpan ?? 1;
    if (![colSpan,rowSpan].every(value => Number.isInteger(value) && value > 0)) throw Object.assign(new Error('网格跨行/跨列必须是正整数'), {code:'E_GRID_SIZE',nodeId:child.id,field:'colSpan/rowSpan'});
    let placed = false;
    for (let row = 0; !placed; row++) for (let col = 0; col <= columns - colSpan; col++) {
      let free = true;
      for (let r = 0; r < rowSpan && free; r++) for (let c = 0; c < colSpan; c++) if (occupied.has(`${row+r}:${col+c}`)) { free = false; break; }
      if (!free) continue;
      for (let r = 0; r < rowSpan; r++) for (let c = 0; c < colSpan; c++) occupied.add(`${row+r}:${col+c}`);
      placements.push({child,row,col,rowSpan,colSpan});rows = Math.max(rows,row+rowSpan);placed = true;break;
    }
  }
  return {columns,rows,placements,columnGap:Number(node.columnGap ?? node.gap ?? 0),rowGap:Number(node.rowGap ?? node.gap ?? 0),equalHeight:Boolean(node.equalHeight)};
}

function gridRowHeights(plan, innerHeight = null) {
  const {rows,placements,rowGap} = plan;
  const fallback = innerHeight === null ? 0 : Math.max(0,(innerHeight-rowGap*Math.max(0,rows-1))/Math.max(1,rows));
  const heights = Array(rows).fill(0);
  for (const {child,row,rowSpan} of placements) if (rowSpan === 1) heights[row] = Math.max(heights[row], child.h === 'fill' || child.h === undefined ? fallback || child._mh : child._mh || fallback);
  for (const {child,row,rowSpan} of placements) if (rowSpan > 1) {
    const current = heights.slice(row,row+rowSpan).reduce((sum,value)=>sum+value,0)+rowGap*(rowSpan-1);
    const missing = Math.max(0,(child._mh || fallback*rowSpan)-current);
    for (let i=0;i<rowSpan;i++) heights[row+i] += missing/rowSpan;
  }
  if (plan.equalHeight) {
    // 等高网格：所有行取同一高度（子节点测得高度与固定容器均分行高的最大值），子节点随行高拉齐。
    const uniform = Math.max(0,...heights,fallback,...placements.map(({child})=>child._mh||0));
    return Array(rows).fill(uniform);
  }
  return heights.map(value=>value||fallback);
}

function resolveRepeaterPage(node, doc) {
  const dsName = repeaterDatasetName(node);
  const runtimePage = dsName && doc?._runtimeDatasetPages?.[dsName];
  if (Number.isFinite(Number(runtimePage)) && Number(runtimePage) >= 1) return Math.floor(Number(runtimePage));
  if (typeof node.page === 'number' && Number.isFinite(node.page) && node.page >= 1) return Math.floor(node.page);
  if (typeof node.page === 'string' && node.page.startsWith('=')) {
    const evaluated = Number(evaluateSimpleDisplayFormula(node.page, doc?.variables || {}));
    if (Number.isFinite(evaluated) && evaluated >= 1) return Math.floor(evaluated);
  }
  return 1;
}

export function measureAndLayoutTree(rootNode, canvasW, canvasH, doc, pageId, { projectDir = null, runtimeState = null, scopePrefix = pageId, reusableChildSlices = null, enableChildSliceMeta = false } = {}) {
  const palette = { ...(doc.palette || {}), ...(doc.tokens?.colors || {}) };
  const defaultFontFamily = doc.fonts?.defaultFamily || 'PingFang SC';
  const fontReport = {
    requestedFamilies: new Set(),
    loadedFamilies: [],
    missingFamilies: [],
    delayedFamilies: [],
    diagnostics: [],
    clipDiagnostics: [],
  };
  const seenFontDiag = new Set();
  let activeSliceMeta = null;

  function prepareTree(rawNode, parentLayout = null, isRoot = false, prefix = scopePrefix) {
    let node = expandMacroNode(rawNode, palette);
    if (node.type === 'instance' || node.type === 'use' || node.component) {
      node = expandComponentInstance(node, doc, [], '');
    }
    // Runtime text must enter the same measurement/layout path as authored text.
    // Patching only the flattened scene leaves hug sizes and line breaks stale.
    const values = node.type === 'input' ? runtimeState?.inputs : runtimeState?.textOverrides;
    const textKey = values && (Object.hasOwn(values, `${prefix}/${node.id}`) ? `${prefix}/${node.id}` : null);
    if (textKey !== null && textKey !== undefined) {
      node.text = String(values[textKey] ?? '');
      delete node.spans;
    } else if (runtimeState?.evaluateText && typeof node.text === 'string' && node.text.startsWith('=')) {
      node.text = String(runtimeState.evaluateText(node.text, { pageId, scopePrefix: prefix }));
    }
    normalizeVisualCss(node.css);
    validateNodeSizing(node, parentLayout);

    // Record token references before resolving
    const tokenRefs = {};
    for (const prop of ['fill', 'stroke', 'color', 'fontSize', 'gap', 'padding', 'radius']) {
      if (typeof node[prop] === 'string' && node[prop].startsWith('$')) {
        tokenRefs[prop] = node[prop];
      }
    }
    node._tokenRefs = tokenRefs;
    // Resolve the numeric references already accepted by the authoring API
    // before measuring. Keep the original source and references for editing
    // and transitive impact; never pass "$display" into Number()/CSS.
    for (const prop of ['fontSize', 'gap', 'padding', 'columnGap', 'rowGap']) {
      const resolveNumeric = (value, field = prop) => {
        if (typeof value !== 'string' || !value.startsWith('$')) return value;
        const name = value.slice(1);
        const resolved = Object.hasOwn(doc.tokens || {}, name) ? doc.tokens[name] : undefined;
        if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0 || prop === 'fontSize' && (resolved === 0 || resolved > 120)) {
          throw Object.assign(new Error(`节点 ${node.id} 的 ${field} 引用 ${value}，需要已声明的${prop === 'fontSize' ? '(0, 120]' : '非负'}数值令牌`), {
            code: 'E_NUMERIC_TOKEN', nodeId: `${pageId}/${node.id}`, field,
            suggestion: `先用setToken声明${name}的数值（category:"size"或"spacing"），或将${field}改为有效数值；整笔未写入`,
          });
        }
        tokenRefs[field] = value;
        return resolved;
      };
      node[prop] = Array.isArray(node[prop]) && prop === 'padding'
        ? node[prop].map((value, index) => resolveNumeric(value, `padding[${index}]`))
        : resolveNumeric(node[prop]);
    }
    // RP/1 button variants must paint a usable default, with explicit styles winning.
    const buttonPaint = node.type === 'button' ? ({
      primary: { fill: palette.brand, color: palette['ink-inv'] || '#FFFFFF' },
      accent: { fill: palette.accent || palette.brand, color: palette['ink-inv'] || '#FFFFFF' },
      secondary: { fill: palette['surface-2'] || palette.surface, color: palette.ink, stroke: palette['line-strong'] || palette.line },
      outline: { fill: palette.surface || '#FFFFFF', color: palette.ink, stroke: palette['line-strong'] || palette.line || '#CBD5CE' },
      ghost: { fill: null, color: palette.ink, stroke: null },
      soft: { fill: palette['brand-soft'] || palette['surface-2'], color: palette.brand },
      danger: { fill: palette.danger || palette.error, color: palette['ink-inv'] || '#FFFFFF' },
    }[node.variant || node.tone || 'primary'] || { fill: palette.brand, color: '#FFFFFF' }) : {};
    const defaultFill = node.type === 'divider' ? (node.color || node.stroke || '$line') : buttonPaint.fill;
    node._resolvedFill = resolveColorValue(node.fill === undefined ? defaultFill : node.fill, palette);
    node._resolvedStroke = resolveColorValue(node.stroke === undefined ? buttonPaint.stroke : node.stroke, palette);
    node._resolvedColor = resolveColorValue(node.color === undefined ? buttonPaint.color : node.color, palette) || palette.ink || '#203B32';

    // Font resolution via real typography service
    const requestedFamily = node.fontFamily || node.font || defaultFontFamily;
    const fontDesc = resolveFontDescriptor(requestedFamily, { defaultFontFamily, projectDir, fontCatalog: doc.fonts?.catalog });
    node._requestedFontFamily = requestedFamily;
    node._fontDescriptor = fontDesc;
    node._resolvedFontFamily = fontDesc.resolvedFont;
    if (
      node.text !== undefined ||
      node.spans !== undefined ||
      ['label', 'paragraph', 'button', 'input', 'badge'].includes(node.type)
    ) {
      fontReport.requestedFamilies.add(requestedFamily);
      if (activeSliceMeta) activeSliceMeta.requestedFamilies.add(requestedFamily);
      if (fontDesc.status === 'delayed-loading') {
        const delayedDiag = {
          code: 'E_FONT_LOADING_DELAYED',
          severity: 'info',
          pageId,
          fontFamily: requestedFamily,
          fallback: fontDesc.resolvedFont,
          message: fontDesc.reason,
        };
        if (activeSliceMeta) activeSliceMeta.delayedFamilies.push(delayedDiag);
        if (!seenFontDiag.has(`delayed:${requestedFamily}`)) {
          seenFontDiag.add(`delayed:${requestedFamily}`);
          fontReport.delayedFamilies.push(requestedFamily);
          fontReport.diagnostics.push(delayedDiag);
        }
      }
    }

    const myLayout = node.layout || 'stack';
    if (Array.isArray(node.children)) {
      if (isRoot && enableChildSliceMeta) {
        node.children = node.children.map(ch => {
          const chKey = getCachedNodeCanonical(ch) || JSON.stringify(ch);
          const prev = reusableChildSlices ? reusableChildSlices.get(ch.id) : null;
          if (prev && prev.chKey === chKey) {
            for (const fam of prev.requestedFamilies) fontReport.requestedFamilies.add(fam);
            for (const delayedDiag of prev.delayedFamilies) {
              if (!seenFontDiag.has(`delayed:${delayedDiag.fontFamily}`)) {
                seenFontDiag.add(`delayed:${delayedDiag.fontFamily}`);
                fontReport.delayedFamilies.push(delayedDiag.fontFamily);
                fontReport.diagnostics.push(delayedDiag);
              }
            }
            prev.treeNode._reusedSlice = prev;
            prev.treeNode._rawChKey = chKey;
            return prev.treeNode;
          }
          const sliceMeta = {
            requestedFamilies: new Set(),
            delayedFamilies: [],
            clipDiagnostics: [],
          };
          const prevMeta = activeSliceMeta;
          activeSliceMeta = sliceMeta;
          try {
            const prepared = prepareTree(ch, myLayout, false, prefix);
            delete prepared._reusedSlice;
            prepared._rawChKey = chKey;
            prepared._sliceMeta = sliceMeta;
            return prepared;
          } finally {
            activeSliceMeta = prevMeta;
          }
        });
      } else {
        node.children = node.children.map(ch => prepareTree(ch, myLayout, false, prefix));
      }
    }
    if (Array.isArray(node.states)) {
      node.states = node.states.map(st => ({
        ...st,
        root: st.root ? prepareTree(st.root, 'stack', false, `${prefix}/${node.id}/${st.id}`) : null,
      }));
    }
    if (node.template) {
      node.template = prepareTree(node.template, 'stack', false, `${prefix}/${node.id}/template`);
    }
    return node;
  }

  function isBaselineAlign(alignVal) {
    return alignVal === 'baseline' || alignVal === 'first-baseline' || alignVal === 'last-baseline';
  }

  function measure(node, availW = canvasW) {
    if (node._reusedSlice) return node;
    const pad = parsePadding(node.padding);
    const padH = pad[1] + pad[3];
    const padV = pad[0] + pad[2];
    const layout = node.layout || 'stack';
    const gap = Number(node.gap || 0);

    let w = typeof node.w === 'number' ? node.w : node.w === 'fill' ? (availW || canvasW) : null;
    let h = typeof node.h === 'number' ? node.h : null;

    if (node.type === 'phone-shell') {
      const preset = DEVICE_PRESETS[node.device || doc.device || 'iphone-17-pro'] || DEVICE_PRESETS['iphone-17-pro'];
      w = w ?? preset.w;
      h = h ?? preset.h;
    } else if (node.type === 'divider') {
      if (node.direction === 'vertical') {
        w = w ?? 1;
        h = h ?? 24;
      } else {
        w = w ?? (availW || canvasW);
        h = h ?? 1;
      }
    } else if (node.type === 'path') {
      node._vectorSpec = normalizeVectorNodeSpec(node);
      if (w === null || node.w === 'hug') {
        w = clampDim(Math.max(24, Math.ceil(node._vectorSpec.bounds.maxX || node._vectorSpec.bounds.width || 100)), node.minW, node.maxW);
      }
      if (h === null || node.h === 'hug') {
        h = clampDim(Math.max(24, Math.ceil(node._vectorSpec.bounds.maxY || node._vectorSpec.bounds.height || 100)), node.minH, node.maxH);
      }
    }

    if (w !== null) {
      w = clampDim(w, node.minW, node.maxW);
    }

    const innerAvailW = w !== null ? Math.max(0, w - padH) : Math.max(0, (availW || canvasW) - padH);

    if (['label', 'paragraph', 'button', 'input', 'badge'].includes(node.type)) {
      const measuredText = (typeof node.text === 'string' && node.text.startsWith('='))
        ? evaluateSimpleDisplayFormula(node.text, doc.variables || {}, doc, rootNode)
        : node.text;
      const tm = measureTextBox(
        { ...node, text: measuredText, fontFamily: node._resolvedFontFamily },
        w ?? innerAvailW,
        { defaultFontFamily, projectDir, fontCatalog: doc.fonts?.catalog }
      );
      node._textMetrics = tm;
      if (w === null) {
        w = clampDim(tm.measuredW, node.minW, node.maxW);
        // If maxW clamped a hug text node, re-measure with wrapped width
        if (typeof node.maxW === 'number' && w < tm.measuredW) {
          const wrappedTm = measureTextBox(
            { ...node, text: measuredText, w, fontFamily: node._resolvedFontFamily },
            w,
            { defaultFontFamily, projectDir, fontCatalog: doc.fonts?.catalog }
          );
          node._textMetrics = wrappedTm;
        }
      }
      const finalTm = node._textMetrics;
      if (h === null || node.h === 'hug') {
        const glyphH = Math.ceil(finalTm.lastBaselineOffset + finalTm.descentPx + finalTm.padY / 2);
        h = Math.max(node.type === 'input' ? 40 : 0, finalTm.measuredH, glyphH);
      }
      node._firstBaselineOffset = finalTm.firstBaselineOffset;
      node._lastBaselineOffset = finalTm.lastBaselineOffset;
    }

    if (node.type === 'dynamic-panel' && Array.isArray(node.states)) {
      const panelW = w ?? innerAvailW;
      let maxStateH = 0;
      for (const st of node.states) {
        if (st.root) {
          measure(st.root, panelW);
          maxStateH = Math.max(maxStateH, st.root._mh || 0);
        }
      }
      w = panelW;
      if (h === null || node.h === 'hug') h = maxStateH || 120;
    }

    if (node.type === 'repeater') {
      const repW = w ?? innerAvailW;
      const activePage = resolveRepeaterPage(node, doc);
      const dsRows = applyRepeaterView(repeaterRows(node, doc), { ...node, page: activePage });
      const rowH = Number(node.rowHeight || 56);
      const rowGap = Number(node.rowGap ?? node.gap ?? 8);
      if (node.template) measure(node.template, repW);
      const visCount = Math.max(1, dsRows.length);
      w = repW;
      if (h === null || node.h === 'hug') {
        h = visCount * rowH + Math.max(0, visCount - 1) * rowGap;
      }
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      if (layout === 'row' && node.wrap === true) {
        const lineLimit = typeof node.maxW === 'number'
          ? Math.min(innerAvailW, Math.max(0, node.maxW - padH))
          : innerAvailW;
        const lines = [[]];
        let lineW = 0;
        for (const ch of node.children) {
          measure(ch, lineLimit);
          const chW = ch._mw || 0;
          let line = lines.at(-1);
          if (line.length && lineW + gap + chW > lineLimit) {
            line = [];
            lines.push(line);
            lineW = 0;
          }
          lineW += (line.length ? gap : 0) + chW;
          line.push(ch);
        }
        const baseline = ch => (node.align === 'last-baseline' ? ch._lastBaselineOffset : ch._firstBaselineOffset)
          ?? Math.round((ch._mh || 0) * 0.82);
        node._wrapLines = lines.map(children => {
          const metrics = rowWidths(children, lineLimit, gap);
          for (const child of children) {
            const weight = rowFlex(child);
            if (weight > 0) measure(child, Math.max(12, Math.round(metrics.remaining * weight / metrics.flex)));
          }
          const sharedBase = isBaselineAlign(node.align) ? Math.max(...children.map(baseline), 0) : 0;
          const height = Math.max(...children.map(ch => (ch._mh || 0) + (sharedBase ? sharedBase - baseline(ch) : 0)), 0);
          return { children, height };
        });
        const maxLineW = Math.max(...lines.map(line => line.reduce((s, c) => s + (c._mw || 0), 0) + (line.length - 1) * gap), 0);
        const totalH = node._wrapLines.reduce((sum, line) => sum + line.height, 0) + (lines.length - 1) * gap;
        if (w === null || node.w === 'hug') w = Math.min(maxLineW, lineLimit) + padH;
        if (h === null || node.h === 'hug') h = totalH + padV;
      } else if (layout === 'row') {
        // First measure non-flex / non-fill children so flex/fill children get exact remaining width
        const totalGap = Math.max(0, node.children.length - 1) * gap;
        let fixedW = 0;
        let totalFlex = 0;
        for (const ch of node.children) {
          const fw = Number(ch.flex) || (ch.w === 'fill' ? 1 : 0);
          if (fw > 0) {
            totalFlex += fw;
          } else {
            measure(ch, null);
            fixedW += ch._mw || 0;
          }
        }
        const remRowW = Math.max(0, innerAvailW - fixedW - totalGap);
        for (const ch of node.children) {
          const fw = Number(ch.flex) || (ch.w === 'fill' ? 1 : 0);
          if (fw > 0) {
            const shareW = totalFlex > 0 ? Math.max(12, Math.round((remRowW * fw) / totalFlex)) : innerAvailW;
            measure(ch, shareW);
          }
        }
        const totalChildW = node.children.reduce((acc, c) => acc + (c._mw || 0), 0) + totalGap;
        if (w === null || node.w === 'hug') w = totalChildW + padH;

        if (isBaselineAlign(node.align)) {
          const useLast = node.align === 'last-baseline';
          const maxBase = Math.max(
            ...node.children.map(c => (useLast ? c._lastBaselineOffset : c._firstBaselineOffset) ?? Math.round((c._mh || 0) * 0.82)),
            0
          );
          node._rowSharedBaseline = maxBase;
          const maxBaselineH = Math.max(
            ...node.children.map(c => {
              const cb = (useLast ? c._lastBaselineOffset : c._firstBaselineOffset) ?? Math.round((c._mh || 0) * 0.82);
              return (maxBase - cb) + (c._mh || 0);
            }),
            0
          );
          if (h === null || node.h === 'hug') h = maxBaselineH + padV;
          node._firstBaselineOffset = pad[0] + maxBase;
          node._lastBaselineOffset = pad[0] + maxBase;
        } else {
          const maxChildH = Math.max(...node.children.map(c => c._mh || 0), 0);
          if (h === null || node.h === 'hug') h = maxChildH + padV;
          const firstChild = node.children[0];
          node._firstBaselineOffset = pad[0] + (firstChild?._firstBaselineOffset ?? Math.round((maxChildH || 0) * 0.82));
          node._lastBaselineOffset = pad[0] + (firstChild?._lastBaselineOffset ?? Math.round((maxChildH || 0) * 0.82));
        }
      } else if (layout === 'column') {
        for (const ch of node.children) {
          measure(ch, innerAvailW);
        }
        const childWidths = node.children.map(c => c._mw || 0);
        const totalChildH = node.children.reduce((acc, c) => acc + (c._mh || 0), 0) + Math.max(0, node.children.length - 1) * gap;
        if (w === null || node.w === 'hug') w = Math.max(...childWidths, 0) + padH;
        if (h === null || node.h === 'hug') h = totalChildH + padV;
        const firstChild = node.children[0];
        const lastChild = node.children[node.children.length - 1];
        node._firstBaselineOffset = pad[0] + (firstChild?._firstBaselineOffset ?? Math.round((firstChild?._mh || 0) * 0.82));
        const preLastH = node.children.slice(0, -1).reduce((acc, c) => acc + (c._mh || 0) + gap, 0);
        node._lastBaselineOffset = pad[0] + preLastH + (lastChild?._lastBaselineOffset ?? Math.round((lastChild?._mh || 0) * 0.82));
      } else if (layout === 'grid') {
        const plan = planGrid(node), cellW = Math.max(0,(innerAvailW-plan.columnGap*(plan.columns-1))/plan.columns);
        for (const {child,colSpan} of plan.placements) measure(child,cellW*colSpan+plan.columnGap*(colSpan-1));
        if (w === null || node.w === 'hug') {
          const unitW = Math.max(0,...plan.placements.map(({child,colSpan})=>Math.max(0,(child._mw-plan.columnGap*(colSpan-1))/colSpan)));
          w = unitW*plan.columns+plan.columnGap*(plan.columns-1)+padH;
        }
        const heights = gridRowHeights(plan,h === null ? null : Math.max(0,h-padV));
        if (h === null || node.h === 'hug') h = heights.reduce((sum,value)=>sum+value,0)+plan.rowGap*Math.max(0,plan.rows-1)+padV;
      } else {
        // stack / free layout
        for (const ch of node.children) {
          measure(ch, innerAvailW);
        }
        let maxR = 0;
        let maxB = 0;
        for (const c of node.children) {
          const cx = Number(c.x || 0);
          const cy = Number(c.y || 0);
          maxR = Math.max(maxR, cx + (c._mw || 0));
          maxB = Math.max(maxB, cy + (c._mh || 0));
        }
        if (w === null || node.w === 'hug') w = maxR + padH;
        if (h === null || node.h === 'hug') h = maxB + padV;
      }
    }

    if (w === null) w = 100;
    if (h === null) h = 40;

    w = clampDim(w, node.minW, node.maxW);
    h = clampDim(h, node.minH, node.maxH);
    node._mw = Math.round(w);
    node._mh = Math.round(h);
    if (node._firstBaselineOffset === undefined) {
      node._firstBaselineOffset = Math.round(node._mh * 0.82);
      node._lastBaselineOffset = Math.round(node._mh * 0.82);
    }
    return node;
  }

  function rowFlex(node) {
    return Number(node.flex) || (node.w === 'fill' ? 1 : 0);
  }

  function rowWidths(children, width, gap) {
    const fixed = children.reduce((sum, child) => sum + (rowFlex(child) ? 0 : child._mw), 0);
    const flex = children.reduce((sum, child) => sum + rowFlex(child), 0);
    return { flex, remaining: Math.max(0, width - fixed - (children.length - 1) * gap) };
  }

  function layout(node, absX, absY, assignedW, assignedH, parentX = 0, parentY = 0) {
    if (node._reusedSlice) {
      if (node._reusedSlice.clipDiagnostics?.length) {
        fontReport.clipDiagnostics.push(...node._reusedSlice.clipDiagnostics);
      }
      return;
    }
    const prevMeta = activeSliceMeta;
    if (node._sliceMeta) activeSliceMeta = node._sliceMeta;
    try {
      const w = clampDim(assignedW ?? node._mw, node.minW, node.maxW);
      let h = clampDim(assignedH ?? node._mh, node.minH, node.maxH);
      node._x = Math.round(absX);
      node._y = Math.round(absY);
      node._relX = Math.round(absX - parentX);
      node._relY = Math.round(absY - parentY);
      node._w = Math.round(w);

      if (['label', 'paragraph', 'button', 'input', 'badge'].includes(node.type)) {
        if (node._w !== node._mw || !node._textMetrics) {
          const measuredText = (typeof node.text === 'string' && node.text.startsWith('='))
            ? evaluateSimpleDisplayFormula(node.text, doc.variables || {}, doc, rootNode)
            : node.text;
          const tm = measureTextBox(
            { ...node, text: measuredText, w: node._w, h: typeof node.h === 'number' ? node._h : node.h, fontFamily: node._resolvedFontFamily },
            node._w,
            { defaultFontFamily, projectDir, fontCatalog: doc.fonts?.catalog }
          );
          node._textMetrics = tm;
          if (node.h === 'hug' || node.h === undefined || node.h === null) {
            h = clampDim(Math.max(node.type === 'input' ? 40 : 0, tm.measuredH, Math.ceil(tm.lastBaselineOffset + tm.descentPx + tm.padY / 2)), node.minH, node.maxH);
          }
        }
        const tm = node._textMetrics;
        if (tm?.clipped) {
          const clipDiag = {
            code: 'E_TEXT_CLIP',
            severity: 'warning',
            pageId,
            nodeId: node.id,
            scopedId: `${pageId}/${node.id}`,
            direction: tm.verticalOverflowPx > 0 ? 'vertical' : 'horizontal',
            overflowPx: Math.max(tm.verticalOverflowPx || 0, tm.horizontalOverflowPx || 0),
            actualBounds: { w: node._w, h: Math.round(h) },
            requiredBounds: { w: tm.measuredW, h: tm.measuredH },
            message: `节点 "${node.id}" 文本超出边界 (${tm.verticalOverflowPx > 0 ? `垂直裁切 ${tm.verticalOverflowPx}px` : `水平裁切 ${tm.horizontalOverflowPx}px`})`,
          };
          fontReport.clipDiagnostics.push(clipDiag);
          if (activeSliceMeta) activeSliceMeta.clipDiagnostics.push(clipDiag);
        }
      }
      node._h = Math.round(h);

      const pad = parsePadding(node.padding);
      const innerX = node._x + pad[3];
      const innerY = node._y + pad[0];
      const innerW = Math.max(0, node._w - pad[1] - pad[3]);
      const innerH = Math.max(0, node._h - pad[0] - pad[2]);
      const mode = node.layout || 'stack';
      const gap = Number(node.gap || 0);

      // Single centered label inheritance (PR #3 rule)
      if ((mode === 'row' || mode === 'column') && node.align === 'center' && node.justify === 'center' && Array.isArray(node.children) && node.children.length === 1) {
        const only = node.children[0];
        if (only.type === 'label' && !only.align) {
          only._inheritedAlign = 'center';
        }
      }

      if (Array.isArray(node.children) && node.children.length > 0) {
        if (mode === 'column') {
          const fixedTotalH = node.children.reduce((acc, c) => acc + (c.flex ? 0 : c._mh), 0);
          const totalGap = Math.max(0, node.children.length - 1) * gap;
          const totalFlex = node.children.reduce((acc, c) => acc + (Number(c.flex) || 0), 0);
          const remH = Math.max(0, innerH - fixedTotalH - totalGap);

          let curY = innerY;
          let stepGap = gap;
          if (totalFlex === 0) {
            if (node.justify === 'center') curY += Math.round(remH / 2);
            else if (node.justify === 'end') curY += remH;
            else if (node.justify === 'space-between' && node.children.length > 1) {
              stepGap = gap + remH / (node.children.length - 1);
            }
          }

          for (const ch of node.children) {
            const chW = ch.w === 'fill' || node.align === 'stretch' ? innerW : ch._mw;
            const chH = ch.flex ? Math.round((remH * Number(ch.flex)) / totalFlex) : ch.h === 'fill' ? innerH : ch._mh;
            let chX = innerX;
            if (node.align === 'center' && chW < innerW) chX = innerX + Math.round((innerW - chW) / 2);
            else if (node.align === 'end' && chW < innerW) chX = innerX + (innerW - chW);
            layout(ch, chX, curY, chW, chH, node._x, node._y);
            curY += ch._h + stepGap;
          }
        } else if (mode === 'row') {
          const lines = node.wrap === true ? node._wrapLines : [{ children: node.children, height: innerH }];
          const useBaseline = isBaselineAlign(node.align);
          const useLast = node.align === 'last-baseline';
          let lineY = innerY;
          for (const { children, height } of lines) {
            const { flex, remaining } = rowWidths(children, innerW, gap);
            let curX = innerX;
            let stepGap = gap;
            if (flex === 0) {
              if (node.justify === 'center') curX += Math.round(remaining / 2);
              else if (node.justify === 'end') curX += remaining;
              else if (node.justify === 'space-between' && children.length > 1) {
                stepGap += remaining / (children.length - 1);
              }
            }

            const sharedBase = useBaseline
              ? Math.max(...children.map(c => (useLast ? c._lastBaselineOffset : c._firstBaselineOffset) ?? Math.round((c._mh || 0) * 0.82)), 0)
              : 0;
            for (const ch of children) {
              const weight = rowFlex(ch);
              const chW = weight > 0 ? Math.round(remaining * weight / flex) : ch._mw;
              const chH = ch.h === 'fill' || node.align === 'stretch' || node.equalHeight ? height : ch._mh;
              let chY = lineY;
              if (useBaseline) {
                const cb = (useLast ? ch._lastBaselineOffset : ch._firstBaselineOffset) ?? Math.round((chH || 0) * 0.82);
                chY += Math.max(0, sharedBase - cb);
              } else if (node.align === 'center' && chH < height) {
                chY += Math.round((height - chH) / 2);
              } else if (node.align === 'end' && chH < height) {
                chY += height - chH;
              }
              layout(ch, curX, chY, chW, chH, node._x, node._y);
              curX += ch._w + stepGap;
            }
            lineY += height + gap;
          }
        } else if (mode === 'grid') {
          const plan = planGrid(node), cellW = Math.max(0,(innerW-plan.columnGap*(plan.columns-1))/plan.columns);
          for (const {child,colSpan} of plan.placements) measure(child,cellW*colSpan+plan.columnGap*(colSpan-1));
          const heights = gridRowHeights(plan,node.h === 'hug' || node.h === undefined ? null : innerH);
          for (const {child,row,col,rowSpan,colSpan} of plan.placements) {
            const left = col*(cellW+plan.columnGap), right = col+colSpan===plan.columns ? innerW : left+cellW*colSpan+plan.columnGap*(colSpan-1);
            const top = heights.slice(0,row).reduce((sum,value)=>sum+value,0)+row*plan.rowGap;
            const spanH = heights.slice(row,row+rowSpan).reduce((sum,value)=>sum+value,0)+plan.rowGap*(rowSpan-1);
            layout(child,innerX+left,innerY+top,child.w==='fill'||child.w===undefined?right-left:child._mw,node.equalHeight||child.h==='fill'||child.h===undefined||rowSpan>1?spanH:child._mh,node._x,node._y);
          }
        } else {
          // stack / free layout
          const placedById = new Map();
          for (const ch of node.children) {
            if (ch._reusedSlice) {
              layout(ch, 0, 0, ch._w, ch._h, node._x, node._y);
              placedById.set(ch.id, ch);
              continue;
            }
            const chW = ch.w === 'fill' ? innerW : ch._mw;
            const chH = ch.h === 'fill' ? innerH : ch._mh;
            let relX = Number(ch.x || 0);
            let relY = Number(ch.y || 0);
            if (ch.after && placedById.has(ch.after)) {
              const prev = placedById.get(ch.after);
              relY = prev._relY + prev._h + Number(ch.afterGap ?? gap ?? 8);
            }
            if (ch.alignX === 'center') relX = Math.round((innerW - chW) / 2);
            else if (ch.alignX === 'right') relX = innerW - chW;
            const pinGap = Number(ch.pinGap || 0);
            if (ch.pin === 'bottom') relY = innerH - chH - pinGap;
            else if (ch.pin === 'top') relY = pinGap;
            else if (ch.pin === 'right') relX = innerW - chW - pinGap;
            else if (ch.pin === 'left') relX = pinGap;
            if (typeof ch.right === 'number') relX = innerW - chW - ch.right;
            if (typeof ch.bottom === 'number') relY = innerH - chH - ch.bottom;
            if (ch.anchor === 'center') {
              relX -= Math.round(chW / 2);
              relY -= Math.round(chH / 2);
            } else if (ch.anchor === 'top-right') {
              relX -= chW;
            } else if (ch.anchor === 'bottom-left') {
              relY -= chH;
            } else if (ch.anchor === 'bottom-right') {
              relX -= chW;
              relY -= chH;
            }
            layout(ch, innerX + relX, innerY + relY, chW, chH, node._x, node._y);
            placedById.set(ch.id, ch);
          }
        }
      }

      if (node.type === 'dynamic-panel' && Array.isArray(node.states)) {
        for (const st of node.states) {
          if (st.root) {
            layout(st.root, 0, 0, node._w, node._h, 0, 0);
          }
        }
      }
      if (node.type === 'repeater' && node.template) {
        layout(node.template, 0, 0, node._w, Number(node.rowHeight || 56), 0, 0);
      }
    } finally {
      activeSliceMeta = prevMeta;
    }
  }

  const tree = prepareTree(rootNode, null, true);
  measure(tree, canvasW);
  layout(tree, 0, 0, canvasW, canvasH, 0, 0);

  // Font diagnostics
  for (const fam of fontReport.requestedFamilies) {
    const desc = resolveFontDescriptor(fam, { defaultFontFamily, projectDir, fontCatalog: doc.fonts?.catalog });
    if (!desc.isFallback) {
      fontReport.loadedFamilies.push(desc.resolvedFont || fam);
    } else if (desc.status !== 'delayed-loading') {
      fontReport.missingFamilies.push(fam);
      fontReport.diagnostics.push({
        code: 'E_FONT_FALLBACK',
        severity: 'warning',
        pageId,
        fontFamily: fam,
        fallback: desc.resolvedFont,
        message: `字体 "${fam}" 未在本机或工程字体目录中找到，已回退至 "${desc.resolvedFont}"`,
      });
    }
  }

  return { tree, fontReport };
}

const resolvedNodeWeight = node => 512 + (node.rowViews || []).reduce((sum, row) => sum + row.nodes.reduce((total, child) => total + resolvedNodeWeight(child), 0), 0);
const pageSceneCache = new BoundedCache({ maxEntries: 64, maxWeight: 64 * 1024 * 1024, weight: (key, page) => key.length * 2 + page.nodes.reduce((sum, node) => sum + resolvedNodeWeight(node), 0) });
const lastPageSceneByKey = new BoundedCache({ maxEntries: 64, maxWeight: 64 * 1024 * 1024, weight: () => 1024 });

function canUseRootChildSlices(pg) {
  const root = pg?.root;
  if (!root || root.type !== 'box') return false;
  const layout = root.layout || 'stack';
  if (layout !== 'stack' && layout !== 'free') return false;
  if (typeof root.w !== 'number' || typeof root.h !== 'number') return false;
  if (Array.isArray(root.states) || root.template) return false;
  if (!Array.isArray(root.children) || root.children.length < 32) return false;
  for (let i = 0; i < root.children.length; i++) {
    if (root.children[i]?.after) return false;
  }
  return true;
}

function computeRootShellKey(pg) {
  const r = pg.root || {};
  return JSON.stringify({
    id: pg.id,
    name: pg.name,
    device: pg.device,
    domain: pg.domain,
    canvas: pg.canvas,
    root: {
      id: r.id,
      name: r.name,
      type: r.type,
      layout: r.layout,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      minW: r.minW,
      maxW: r.maxW,
      minH: r.minH,
      maxH: r.maxH,
      padding: r.padding,
      gap: r.gap,
      fill: r.fill,
      stroke: r.stroke,
      strokeWidth: r.strokeWidth,
      color: r.color,
      radius: r.radius,
      opacity: r.opacity,
      visible: r.visible,
      hidden: r.hidden,
      locked: r.locked,
      clip: r.clip,
      overflow: r.overflow,
      css: r.css,
      on: r.on,
      childCount: Array.isArray(r.children) ? r.children.length : 0,
    },
  });
}

export function resolveDocumentScene(doc, { activePanelStates = {}, runtimeState = null, projectDir = null } = {}) {
  const layoutDocument = (runtimeState?.datasets || runtimeState?.variables || runtimeState?.datasetPages)
    ? {
        ...doc,
        ...(runtimeState.datasets ? { datasets: runtimeState.datasets } : {}),
        ...(runtimeState.variables ? { variables: runtimeState.variables } : {}),
        ...(runtimeState.datasetPages ? { _runtimeDatasetPages: runtimeState.datasetPages } : {}),
      }
    : doc;
  const palette = { ...(doc.palette || {}), ...(doc.tokens?.colors || {}) };
  const pages = [];
  const nodesByScopedId = {};
  const allFontDiagnostics = [];
  const allClipDiagnostics = [];

  const globalContextKey = JSON.stringify({
    c: doc.components,
    t: doc.tokens,
    p: doc.palette,
    f: doc.fonts,
    fv: getFontResourceVersion(),
    projectDir,
    v: runtimeState?.variables || doc.variables,
    aps: activePanelStates,
    rps: runtimeState?.panelStates || null,
    visibility: runtimeState?.visibility || null,
    inputs: runtimeState?.inputs || null,
    textOverrides: runtimeState?.textOverrides || null,
    am: doc.assetsManifest || null,
    d: layoutDocument.datasets || null,
    dp: runtimeState?.datasetPages || null,
  });

  for (const pg of doc.pages || []) {
    const pgCanon = getCachedNodeCanonical(pg);
    const pageCacheKey = pgCanon ? `${globalContextKey}::canon::${pgCanon}` : `${globalContextKey}::${JSON.stringify(pg)}`;
    const cachedPage = pageSceneCache.get(pageCacheKey);
    if (cachedPage) {
      allFontDiagnostics.push(...cachedPage.fontReport.diagnostics);
      allClipDiagnostics.push(...(cachedPage.fontReport.clipDiagnostics || []));
      for (let i = 0; i < cachedPage.nodes.length; i++) {
        const rn = cachedPage.nodes[i];
        nodesByScopedId[rn.scopedId] = rn;
      }
      pages.push(cachedPage);
      continue;
    }

    const preset = pg.device ? (DEVICE_PRESETS[pg.device] || DEVICE_PRESETS['iphone-17-pro']) : null;
    const screenW = Number(pg.canvas?.w || preset?.w || 402);
    const screenH = Number(pg.canvas?.h || preset?.h || 874);
    const shellPad = preset ? preset.shellPad : 0;
    const totalW = screenW + shellPad * 2;
    const totalH = screenH + shellPad * 2;

    const sliceCacheId = `${doc.documentId || 'doc'}::${pg.id}`;
    const canSlice = canUseRootChildSlices(pg);
    const rootShellKey = canSlice ? computeRootShellKey(pg) : null;
    const prevSliceEntry = canSlice ? lastPageSceneByKey.get(sliceCacheId) : null;
    const reusableChildSlices = (
      canSlice &&
      prevSliceEntry &&
      prevSliceEntry.globalContextKey === globalContextKey &&
      prevSliceEntry.rootShellKey === rootShellKey
    ) ? prevSliceEntry.childSlices : null;

    const { tree, fontReport } = measureAndLayoutTree(pg.root, screenW, screenH, layoutDocument, pg.id, {
      projectDir,
      runtimeState,
      reusableChildSlices,
      enableChildSliceMeta: canSlice,
    });
    allFontDiagnostics.push(...fontReport.diagnostics);
    allClipDiagnostics.push(...(fontReport.clipDiagnostics || []));

    const flatNodes = [];
    const nextChildSlices = canSlice ? new Map() : null;
    function collectResolved(n, scopePrefix, offsetX, offsetY, depth = 0, clipBounds = null, visibleAncestor = true, parentNode = null, panelOwnerId = null, parentScopedId = null, destination = flatNodes, register = true) {
      const scopedId = `${scopePrefix}/${n.id}`;
      const visibilityKey = scopedId;
      const ownVisible = runtimeState?.visibility && visibilityKey in runtimeState.visibility ? Boolean(runtimeState.visibility[visibilityKey]) : n.visible !== false && n.hidden !== true;
      const isVisible = visibleAncestor && ownVisible;
      const screenX = offsetX + n._x;
      const screenY = offsetY + n._y;
      const pageGlobalX = shellPad + screenX;
      const pageGlobalY = shellPad + screenY;

      // Resolve runtime variable formulas if runtimeState or initial variable preview
      let displayText =
        n.type === 'path'
          ? ''
          : (
              n.text ??
              n.value ??
              n.content ??
              (Array.isArray(n.spans) && n.spans.length > 0
                ? n._textMetrics?.text || n.spans.map(s => s?.text ?? '').join('')
                : '')
            );
      if (typeof displayText === 'string' && displayText.startsWith('=')) {
        displayText = evaluateSimpleDisplayFormula(displayText, runtimeState?.variables || doc.variables || {}, layoutDocument, pg.root);
      }

      const assetEntry = n.type === 'image' && n.src ? (doc.assetsManifest?.[n.src] || null) : null;
      const vectorSpec = n.type === 'path' ? (n._vectorSpec || normalizeVectorNodeSpec({ ...n, w: n._w, h: n._h })) : null;

      const resolvedNode = {
        id: n.id,
        scopedId,
        pageId: pg.id,
        parentId: parentNode?.id || null,
        parentScopedId,
        parentLayout: parentNode?.layout || 'stack',
        panelOwnerId: panelOwnerId || null,
        renderOrder: destination.length + 1,
        name: n.name || n.id,
        type: n.type,
        role: n.role || null,
        variant: n.variant || n.tone || n._instanceVariant || n.variants?.[n.variantKey] || null,
        component: n.componentSource?.componentId || n.component || null,
        componentVariant: n.componentSource?.variant || n.variantKey || null,
        hitW: Number.isFinite(n.hitW) ? n.hitW : (Number.isFinite(n.hitArea?.w) ? n.hitArea.w : null),
        hitH: Number.isFinite(n.hitH) ? n.hitH : (Number.isFinite(n.hitArea?.h) ? n.hitArea.h : null),
        for: n.for || n.emptyFor || n.boundTo || null,
        layout: n.layout || 'stack',
        x: screenX,
        y: screenY,
        sourceX: typeof n.right === 'number' ? n._relX - parsePadding(parentNode?.padding)[3] : Number(n.x || 0),
        sourceY: typeof n.bottom === 'number' ? n._relY - parsePadding(parentNode?.padding)[0] : Number(n.y || 0),
        relX: n._relX,
        relY: n._relY,
        pageGlobalX,
        pageGlobalY,
        w: n._w,
        h: n._h,
        minW: n.minW ?? null,
        maxW: n.maxW ?? null,
        minH: n.minH ?? null,
        maxH: n.maxH ?? null,
        padding: n.padding ?? 0,
        gap: n.gap ?? 0,
        columns: n.layout === 'grid' ? (n.columns ?? 2) : (n.columns ?? 1),
        columnGap: n.columnGap ?? n.gap ?? 0,
        rowGap: n.rowGap ?? n.gap ?? 0,
        equalHeight: Boolean(n.equalHeight),
        align: n.align || 'start',
        justify: n.justify || 'start',
        textAlign: n.textAlign || n.align || n._inheritedAlign || (n.type === 'button' ? 'center' : 'left'),
        fill: n._resolvedFill,
        rawFill: n.fill ?? null,
        stroke: n._resolvedStroke,
        rawStroke: n.stroke ?? null,
        strokeWidth: Number(n.strokeWidth ?? (n._resolvedStroke && n._resolvedStroke !== '#FFFFFF00' ? 1 : 0)),
        color: n._resolvedColor,
        rawColor: n.color ?? null,
        radius: Number(n.radius || 0),
        opacity: Number(n.opacity ?? 1),
        fontFamily: n._resolvedFontFamily,
        requestedFontFamily: n._requestedFontFamily || n._resolvedFontFamily,
        fontStackCss: n._fontDescriptor?.fontStackCss || `"${n._resolvedFontFamily || 'PingFang SC'}", sans-serif`,
        fontStatus: n._fontDescriptor?.status || 'loaded',
        measurementMode: n._textMetrics?.measurementMode || n._fontDescriptor?.measurementMode || 'calibrated-glyph',
        fontSize: Number(n.fontSize || n.size || 14),
        fontWeight: Number(n.fontWeight || n.weight || 400),
        lineHeight: n._textMetrics?.lineHeight || Number(n.lineHeight || 20),
        letterSpacing: Number(n.letterSpacing || 0),
        italic: Boolean(n.italic),
        underline: Boolean(n.underline),
        strikethrough: Boolean(n.strikethrough),
        lineGap: typeof n.lineGap === 'number' ? n.lineGap : null,
        maxLines: typeof n.maxLines === 'number' ? n.maxLines : null,
        ellipsis: n.ellipsis !== undefined ? Boolean(n.ellipsis) : null,
        wrap: Boolean(n.wrap || n.type === 'paragraph'),
        textPaddingX: typeof n.textPaddingX === 'number' ? n.textPaddingX : null,
        textPaddingY: typeof n.textPaddingY === 'number' ? n.textPaddingY : null,
        text: n._textMetrics?.truncated ? n._textMetrics.displayText : String(displayText),
        truncated: Boolean(n._textMetrics?.truncated),
        rawText: n.text ?? n.content ?? null,
        placeholder: n.placeholder ?? null,
        spans: Array.isArray(n.spans) ? structuredClone(n.spans) : null,
        lines: n._textMetrics?.lines || (displayText ? [String(displayText)] : []),
        lineCount: n._textMetrics?.lineCount ?? (displayText ? 1 : 0),
        contentW: n._textMetrics?.contentW ?? n._w,
        contentH: n._textMetrics?.contentH ?? n._h,
        padX: n._textMetrics?.padX ?? 0,
        padY: n._textMetrics?.padY ?? 0,
        firstBaselineOffset: n._firstBaselineOffset ?? Math.round(n._h * 0.82),
        lastBaselineOffset: n._lastBaselineOffset ?? Math.round(n._h * 0.82),
        ascentPx: n._textMetrics?.ascentPx ?? null,
        descentPx: n._textMetrics?.descentPx ?? null,
        clipped: Boolean(n._textMetrics?.clipped),
        horizontalOverflowPx: n._textMetrics?.horizontalOverflowPx ?? 0,
        verticalOverflowPx: n._textMetrics?.verticalOverflowPx ?? 0,
        src: n.src || null,
        ...(n.type === 'repeater' ? (() => {
          const datasetName = repeaterDatasetName(n);
          const allRows = repeaterRows(n, layoutDocument);
          const activePage = resolveRepeaterPage(n, layoutDocument);
          const rows = applyRepeaterView(allRows, { ...n, page: activePage });
          return {
            dataset: datasetName,
            key: n.key || 'id',
            pageSize: typeof n.pageSize === 'number' ? n.pageSize : null,
            page: activePage,
            rows,
            totalRows: allRows.length,
            filtered: Boolean(n.filter),
            filter: n.filter || null,
            sort: n.sort || null,
            rowHeight: Number(n.rowHeight || 56),
            rowGap: Number(n.rowGap ?? n.gap ?? 8),
          };
        })() : {}),
        assetMissing: Boolean(assetEntry?.missing),
        icon: n.icon || null,
        ...(vectorSpec ? {
          svgD: vectorSpec.svgD,
          subpaths: vectorSpec.subpaths,
          fillRule: vectorSpec.fillRule,
          viewBox: vectorSpec.viewBox,
          vectorBounds: vectorSpec.bounds,
          vectorTransform: vectorSpec.transform,
          strokeLinecap: vectorSpec.strokeLinecap,
          strokeLinejoin: vectorSpec.strokeLinejoin,
          strokeDasharray: vectorSpec.strokeDasharray,
          smooth: Boolean(n.smooth),
          nativeVectorCompatible: Boolean(vectorSpec.nativeCompatibility?.nativeEditable),
          vectorFallbackReasons: vectorSpec.nativeCompatibility?.fallbackReasons || [],
        } : {}),
        gradient: n.gradient || null,
        ...(Array.isArray(n.fills) ? { fills: n.fills } : {}),
        ...(Array.isArray(n.shadows) ? { shadows: n.shadows } : {}),
        ...(n.mixBlendMode ? { mixBlendMode: n.mixBlendMode } : {}),
        shadow: n.shadow || null,
        innerGlow: n.innerGlow || null,
        backdropBlur: n.backdropBlur || null,
        aurora: n.aurora || null,
        noise: n.noise || null,
        z: typeof n.z === 'number' ? n.z : null,
        borderSides: n.borderSides || null,
        borderTop: n.borderTop ?? null,
        borderRight: n.borderRight ?? null,
        borderBottom: n.borderBottom ?? null,
        borderLeft: n.borderLeft ?? null,
        clip: n.clip !== undefined ? Boolean(n.clip) : null,
        overflow: n.overflow || null,
        direction: n.direction || null,
        fitToContent: Boolean(n.fitToContent),
        scroll: n.scroll || null,
        constraints: n.constraints ? structuredClone(n.constraints) : null,
        pin: n.pin || null,
        pinGap: typeof n.pinGap === 'number' ? n.pinGap : null,
        anchor: n.anchor || null,
        frameFill: n.frameFill ? resolveColorValue(n.frameFill, palette) : null,
        css: n.css ? structuredClone(n.css) : null,
        customFilter: n.customFilter || null,
        threeDTransform: n.threeDTransform || null,
        rotation: typeof n.rotation === 'number' && Number.isFinite(n.rotation) ? n.rotation : 0,
        visible: isVisible,
        locked: Boolean(n.locked),
        depth,
        clipBounds,
        tokenRefs: n._tokenRefs || {},
        macroSource: n.macroSource || null,
        controlledByMacro: n.controlledByMacro || null,
        componentSource: n.componentSource || null,
        state: n.state || 'default',
        interactive: n.interactive !== false,
        on: nodeEvents(n),
        childrenIds: (n.children || []).map(c => `${scopePrefix}/${c.id}`),
      };

      if (n.type === 'dynamic-panel' && Array.isArray(n.states)) {
        const stateKey = scopedId;
        const activeStateId = activePanelStates[stateKey]
          || runtimeState?.panelStates?.[stateKey]
          || n.activeState
          || n.states[0]?.id;
        resolvedNode.activeStateId = activeStateId;
        resolvedNode.states = n.states.map(st => ({
          id: st.id,
          name: st.name || st.id,
        }));
      }

      destination.push(resolvedNode);
      if (register) nodesByScopedId[scopedId] = resolvedNode;

      if (n.type === 'repeater' && n.template) {
        resolvedNode.rowViews = resolvedNode.rows.map((row, rowIndex) => {
          const rowId = String(row._rowId || row.id || `row_${rowIndex + 1}`), bound = bindRepeaterTemplate(n.template, row);
          const measured = measureAndLayoutTree(bound, n._w, resolvedNode.rowHeight, layoutDocument, pg.id, { projectDir, runtimeState, scopePrefix: `${scopePrefix}/${n.id}/template` });
          const nodes = [];
          collectResolved(measured.tree, `${scopePrefix}/${n.id}/template`, 0, 0, depth + 1, null, isVisible, null, null, null, nodes, false);
          const rowClips = measured.fontReport.clipDiagnostics.map(item => ({ ...item, rowId, repeaterId: n.id }));
          fontReport.clipDiagnostics.push(...rowClips); allClipDiagnostics.push(...rowClips);
          return { rowId, nodes };
        });
        if (register) {
          const start = destination.length;
          collectResolved(n.template, `${scopePrefix}/${n.id}/template`, screenX, screenY, depth + 1, clipBounds, isVisible, n, panelOwnerId, scopedId, destination, register);
          for (const source of destination.slice(start)) if (!source.repeaterTemplateOwner) source.repeaterTemplateOwner = scopedId;
        }
      }

      const nextClip = n.radius > 0 || n.type === 'phone-shell' || n.type === 'dynamic-panel'
        ? { x: screenX, y: screenY, w: n._w, h: n._h, radius: n.radius || (preset?.screenRadius ?? 0) }
        : clipBounds;

      if (Array.isArray(n.children)) {
        const isSliceRoot = depth === 0 && nextChildSlices && destination === flatNodes && register;
        for (const ch of n.children) {
          if (isSliceRoot && ch._reusedSlice) {
            const slice = ch._reusedSlice;
            const startOrder = destination.length + 1;
            if (startOrder === slice.startRenderOrder) {
              for (let i = 0; i < slice.resolvedNodes.length; i++) {
                const rn = slice.resolvedNodes[i];
                destination.push(rn);
                nodesByScopedId[rn.scopedId] = rn;
              }
              nextChildSlices.set(ch.id, slice);
            } else {
              const orderDelta = startOrder - slice.startRenderOrder;
              const shiftedNodes = slice.resolvedNodes.map(rn => ({ ...rn, renderOrder: rn.renderOrder + orderDelta }));
              for (let i = 0; i < shiftedNodes.length; i++) {
                const rn = shiftedNodes[i];
                destination.push(rn);
                nodesByScopedId[rn.scopedId] = rn;
              }
              const updatedSlice = { ...slice, startRenderOrder: startOrder, resolvedNodes: shiftedNodes };
              ch._reusedSlice = updatedSlice;
              nextChildSlices.set(ch.id, updatedSlice);
            }
            continue;
          }
          if (isSliceRoot) {
            const startIdx = destination.length;
            const startOrder = startIdx + 1;
            collectResolved(ch, scopePrefix, offsetX, offsetY, depth + 1, nextClip, isVisible, n, panelOwnerId, scopedId, destination, register);
            const resolvedNodes = destination.slice(startIdx);
            const newSlice = {
              chKey: ch._rawChKey,
              treeNode: ch,
              startRenderOrder: startOrder,
              resolvedNodes,
              requestedFamilies: ch._sliceMeta ? [...ch._sliceMeta.requestedFamilies] : [],
              delayedFamilies: ch._sliceMeta ? ch._sliceMeta.delayedFamilies : [],
              clipDiagnostics: ch._sliceMeta ? ch._sliceMeta.clipDiagnostics : [],
            };
            ch._reusedSlice = newSlice;
            nextChildSlices.set(ch.id, newSlice);
          } else {
            collectResolved(ch, scopePrefix, offsetX, offsetY, depth + 1, nextClip, isVisible, n, panelOwnerId, scopedId, destination, register);
          }
        }
      }

      if (n.type === 'dynamic-panel' && Array.isArray(n.states)) {
        const activeSt = n.states.find(s => s.id === resolvedNode.activeStateId) || n.states[0];
        if (activeSt?.root) {
          collectResolved(
            activeSt.root,
            `${scopePrefix}/${n.id}/${activeSt.id}`,
            screenX,
            screenY,
            depth + 1,
            { x: screenX, y: screenY, w: n._w, h: n._h, radius: n.radius || 0 },
            isVisible,
            n,
            n.id,
            scopedId, destination, register
          );
        }
      }
    }

    collectResolved(tree, pg.id, 0, 0, 0, null, true, null, null);

    const pageObj = {
      id: pg.id,
      name: pg.name,
      device: pg.device,
      domain: pg.domain || doc.domain || 'mobile',
      board: {
        x: pg.canvas?.x ?? 80,
        y: pg.canvas?.y ?? 80,
        screenW,
        screenH,
        shellPad,
        totalW,
        totalH,
        outerRadius: preset?.outerRadius ?? 0,
        innerRadius: preset?.innerRadius ?? 0,
        screenRadius: preset?.screenRadius ?? 0,
        island: preset?.island ?? null,
        darkIsland: pg.root?.darkIsland !== false,
        showHomeIndicator: pg.root?.showHomeIndicator !== false,
      },
      nodes: flatNodes,
      fontReport: {
        requestedFamilies: [...fontReport.requestedFamilies],
        loadedFamilies: fontReport.loadedFamilies,
        missingFamilies: fontReport.missingFamilies,
        delayedFamilies: fontReport.delayedFamilies,
        diagnostics: fontReport.diagnostics,
        clipDiagnostics: fontReport.clipDiagnostics,
      },
    };
    Object.defineProperty(pageObj, 'rootTree', { value: tree, enumerable: false, configurable: true });
    pageSceneCache.set(pageCacheKey, pageObj);
    if (canSlice && nextChildSlices) {
      lastPageSceneByKey.set(sliceCacheId, {
        globalContextKey,
        rootShellKey,
        childSlices: nextChildSlices,
      });
    }
    pages.push(pageObj);
  }

  const sceneObj = {
    documentId: doc.documentId,
    revision: doc.revision,
    contentHash: doc.contentHash,
    rendererVersion: RENDERER_VERSION,
    pages,
    fontDiagnostics: allFontDiagnostics,
    clipDiagnostics: allClipDiagnostics,
    assetDiagnostics: doc._diagnosticsCurrent ? (doc.diagnostics || []) : currentDocumentDiagnostics(doc),
    typographyStats: getTypographyCacheStats(),
  };
  Object.defineProperty(sceneObj, 'nodesByScopedId', { value: nodesByScopedId, enumerable: false, configurable: true });
  if (doc && typeof doc === 'object') {
    docLastSceneWeakMap.set(doc, sceneObj);
  }
  return sceneObj;
}

const docLastSceneWeakMap = new WeakMap();

export function getLastResolvedScene(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const cached = docLastSceneWeakMap.get(doc);
  if (cached && cached.revision === doc.revision && cached.contentHash === doc.contentHash) {
    return cached;
  }
  return null;
}

export function evaluateSimpleDisplayFormula(expr, variablesMap, doc = null, rootNode = null) {
  const raw = String(expr || '').trim();
  if (!raw.startsWith('=')) return raw;
  const body = raw.slice(1).trim();
  const getVar = name => {
    const entry = variablesMap[name];
    if (entry && typeof entry === 'object' && 'value' in entry) return entry.value;
    return entry ?? '';
  };
  // =var.lastLocation or =$lastLocation
  const directMatch = body.match(/^(?:var\.|\$)([a-zA-Z0-9_]+)$/);
  if (directMatch) return String(getVar(directMatch[1]));
  // =text(24 + var.observed) or =text(var.favorites) or =text(recordCount)
  const textAddMatch = body.match(/^text\(\s*(\d+)\s*\+\s*(?:var\.|\$)?([a-zA-Z0-9_]+)\s*\)$/);
  if (textAddMatch) {
    return String(Number(textAddMatch[1]) + Number(getVar(textAddMatch[2]) || 0));
  }
  const textVarMatch = body.match(/^text\(\s*(?:var\.|\$)?([a-zA-Z0-9_]+)\s*\)$/);
  if (textVarMatch) {
    return String(getVar(textVarMatch[1]));
  }
  const dsMatch = body.match(/^dataset\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_.-]+)$/);
  if (dsMatch && doc) {
    const [, dsName, rest] = dsMatch;
    const dataset = doc.datasets?.[dsName];
    const allRows = Array.isArray(dataset) ? dataset : (dataset?.rows || []);
    let repNode = null;
    const findRep = n => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'repeater' && repeaterDatasetName(n) === dsName) {
        repNode = n;
        return;
      }
      for (const ch of n.children || []) {
        if (!repNode) findRep(ch);
      }
    };
    if (rootNode) findRep(rootNode);
    const activePage = repNode ? resolveRepeaterPage(repNode, doc) : (Number(doc._runtimeDatasetPages?.[dsName]) || 1);
    const filteredRows = applyRepeaterView(allRows, { filter: repNode?.filter, sort: repNode?.sort });
    const pagedRows = applyRepeaterView(allRows, { ...(repNode || {}), page: activePage });
    const total = filteredRows.length;
    const pageSize = repNode?.pageSize && repNode.pageSize > 0 ? repNode.pageSize : (total || 1);
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const curPage = total === 0 ? 0 : Math.min(Math.max(1, activePage), totalPages);
    if (rest === 'count' || rest === 'length' || rest === 'total') return String(total);
    if (rest === 'page') return String(curPage);
    if (rest === 'totalPages') return String(totalPages);
    if (rest === 'pageStatus') return `第 ${curPage} / ${totalPages} 页`;
    if (rest === 'countStatus') return `共 ${total} 条`;
    if (rest.startsWith('first.')) return String(filteredRows[0]?.[rest.slice(6)] ?? '-');
    if (rest.startsWith('pageFirst.')) return String((pagedRows[0] || filteredRows[0])?.[rest.slice(10)] ?? '-');
    if (rest.startsWith('selected.')) return String((filteredRows[0] || allRows[0])?.[rest.slice(9)] ?? '');
  }
  return raw;
}
