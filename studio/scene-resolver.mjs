import { DEVICE_PRESETS, RENDERER_VERSION, SYSTEM_FONTS } from './document.mjs';
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
  const n = structuredClone(node);
  if (n.type === 'card' && (!Array.isArray(n.children) || n.children.length === 0) && (n.title || n.body || n.subtitle || n.tag)) {
    const children = [];
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
        fill: n.tagTone === 'error' || n.tagTone === 'danger' ? '#FEE2E2' : '$brand-soft',
        color: n.tagTone === 'error' || n.tagTone === 'danger' ? '$danger' : '$brand',
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
        fontSize: 16,
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
    n.fill = n.fill || '$surface';
    n.radius = n.radius ?? 16;
    n.children = children;
  } else if (n.type === 'stat-row' && Array.isArray(n.items)) {
    n.layout = 'row';
    n.gap = n.gap ?? 10;
    n.children = n.items.map((it, idx) => ({
      type: 'box',
      id: `${n.id}_stat_${idx}`,
      name: `${n.id}_stat_${idx}`,
      layout: 'column',
      flex: 1,
      h: 'hug',
      padding: 12,
      gap: 4,
      fill: '$surface',
      radius: 12,
      controlledByMacro: n.id,
      children: [
        { type: 'label', id: `${n.id}_val_${idx}`, name: `${n.id}_val_${idx}`, text: String(it.value ?? ''), fontSize: 20, fontWeight: 700, color: it.color || '$brand', w: 'fill', h: 'hug', controlledByMacro: n.id },
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
    n.children = [
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
          ...(n.subtitle ? [{ type: 'label', id: `${n.id}_sub`, name: `${n.id}_sub`, text: String(n.subtitle), fontSize: 12, fontWeight: 400, color: '$ink-2', w: 'fill', h: 'hug', controlledByMacro: n.id }] : []),
        ],
      },
      ...(n.rightBadge ? [{
        type: 'button',
        id: `${n.id}_badge`,
        name: `${n.id}_badge`,
        text: String(n.rightBadge),
        w: 'hug',
        h: 26,
        fontSize: 11,
        fontWeight: 600,
        radius: 13,
        fill: n.rightTone === 'error' || n.rightTone === 'danger' ? '#FEE2E2' : '$brand-soft',
        color: n.rightTone === 'error' || n.rightTone === 'danger' ? '$danger' : '$brand',
        controlledByMacro: n.id,
      }] : []),
    ];
    if (n.goto && !n.on) {
      n.on = { click: [{ type: 'link', page: n.goto }] };
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
    instanceOverrides[k] = structuredClone(v);
  }
  for (const [k, v] of Object.entries(rawInstanceOverrides)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      instanceOverrides[k] = { ...(instanceOverrides[k] || {}), ...structuredClone(v) };
    } else {
      instanceOverrides[k] = structuredClone(v);
    }
  }
  const instPath = instancePathPrefix ? `${instancePathPrefix}/${instanceNode.id}` : instanceNode.id;

  function applyTree(defNode, isRoot = false) {
    const clone = structuredClone(defNode);
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

    // Apply variant overrides first, then instance overrides
    for (const [k, v] of Object.entries(vOvr)) {
      if (k !== 'id' && k !== 'children') clone[k] = structuredClone(v);
    }
    for (const [k, v] of Object.entries(iOvr)) {
      if (k !== 'id' && k !== 'children') clone[k] = structuredClone(v);
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

export function measureAndLayoutTree(rootNode, canvasW, canvasH, doc, pageId, { projectDir = null } = {}) {
  const palette = { ...(doc.palette || {}), ...(doc.tokens?.colors || {}) };
  const defaultFontFamily = doc.fonts?.defaultFamily || 'PingFang SC';
  const catalogNames = new Set((doc.fonts?.catalog || []).map(f => f.family));
  const fontReport = {
    requestedFamilies: new Set(),
    loadedFamilies: [],
    missingFamilies: [],
    delayedFamilies: [],
    diagnostics: [],
    clipDiagnostics: [],
  };
  const seenFontDiag = new Set();

  function prepareTree(rawNode, parentLayout = null) {
    let node = expandMacroNode(rawNode, palette);
    if (node.type === 'instance' || node.type === 'use' || node.component) {
      node = expandComponentInstance(node, doc, [], '');
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
    node._resolvedFill = resolveColorValue(node.fill, palette);
    node._resolvedStroke = resolveColorValue(node.stroke, palette);
    node._resolvedColor = resolveColorValue(node.color, palette) || (node.type === 'button' ? '#FFFFFF' : palette.ink || '#203B32');

    // Font resolution via real typography service
    const requestedFamily = node.fontFamily || defaultFontFamily;
    const fontDesc = resolveFontDescriptor(requestedFamily, { defaultFontFamily, projectDir });
    node._requestedFontFamily = requestedFamily;
    node._fontDescriptor = fontDesc;
    node._resolvedFontFamily = catalogNames.has(requestedFamily) ? requestedFamily : fontDesc.resolvedFont;
    if (
      node.text !== undefined ||
      node.spans !== undefined ||
      ['label', 'paragraph', 'button', 'input', 'badge'].includes(node.type)
    ) {
      fontReport.requestedFamilies.add(requestedFamily);
      if (fontDesc.status === 'delayed-loading' && !seenFontDiag.has(`delayed:${requestedFamily}`)) {
        seenFontDiag.add(`delayed:${requestedFamily}`);
        fontReport.delayedFamilies.push(requestedFamily);
        fontReport.diagnostics.push({
          code: 'E_FONT_LOADING_DELAYED',
          severity: 'info',
          pageId,
          fontFamily: requestedFamily,
          fallback: fontDesc.resolvedFont,
          message: fontDesc.reason,
        });
      }
    }

    const myLayout = node.layout || (node.type === 'phone-shell' ? 'stack' : 'stack');
    if (Array.isArray(node.children)) {
      node.children = node.children.map(ch => prepareTree(ch, myLayout));
    }
    if (Array.isArray(node.states)) {
      node.states = node.states.map(st => ({
        ...st,
        root: st.root ? prepareTree(st.root, 'stack') : null,
      }));
    }
    if (node.template) {
      node.template = prepareTree(node.template, 'stack');
    }
    return node;
  }

  function isBaselineAlign(alignVal) {
    return alignVal === 'baseline' || alignVal === 'first-baseline' || alignVal === 'last-baseline';
  }

  function measure(node, availW = canvasW) {
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
    }

    if (w !== null) {
      w = clampDim(w, node.minW, node.maxW);
    }

    const innerAvailW = w !== null ? Math.max(0, w - padH) : Math.max(0, (availW || canvasW) - padH);

    if (['label', 'paragraph', 'button', 'input', 'badge'].includes(node.type)) {
      const tm = measureTextBox(
        { ...node, fontFamily: node._resolvedFontFamily },
        w ?? innerAvailW,
        { defaultFontFamily, projectDir }
      );
      node._textMetrics = tm;
      if (w === null) {
        w = clampDim(tm.measuredW, node.minW, node.maxW);
        // If maxW clamped a hug text node, re-measure with wrapped width
        if (typeof node.maxW === 'number' && w < tm.measuredW) {
          const wrappedTm = measureTextBox(
            { ...node, w, fontFamily: node._resolvedFontFamily },
            w,
            { defaultFontFamily, projectDir }
          );
          node._textMetrics = wrappedTm;
        }
      }
      const finalTm = node._textMetrics;
      if (h === null || node.h === 'hug') {
        h = node.type === 'input' ? Math.max(40, finalTm.measuredH) : finalTm.measuredH;
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
          maxStateH = Math.max(maxStateH, st.root._mw || 0, st.root._mh || 0);
        }
      }
      w = panelW;
      if (h === null || node.h === 'hug') h = maxStateH || 120;
    }

    if (node.type === 'repeater') {
      const repW = w ?? innerAvailW;
      const dsName = node.dataset || node.source;
      const dsRows = (dsName && doc.datasets?.[dsName]?.rows) || node.rows || [];
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
      if (layout === 'row') {
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

  function layout(node, absX, absY, assignedW, assignedH, parentX = 0, parentY = 0) {
    const w = clampDim(assignedW ?? node._mw, node.minW, node.maxW);
    let h = clampDim(assignedH ?? node._mh, node.minH, node.maxH);
    node._x = Math.round(absX);
    node._y = Math.round(absY);
    node._relX = Math.round(absX - parentX);
    node._relY = Math.round(absY - parentY);
    node._w = Math.round(w);

    if (['label', 'paragraph', 'button', 'input', 'badge'].includes(node.type)) {
      if (node._w !== node._mw || !node._textMetrics) {
        const tm = measureTextBox(
          { ...node, w: node._w, h: typeof node.h === 'number' ? node._h : node.h, fontFamily: node._resolvedFontFamily },
          node._w,
          { defaultFontFamily, projectDir }
        );
        node._textMetrics = tm;
        if (node.h === 'hug' || node.h === undefined || node.h === null) {
          h = clampDim(node.type === 'input' ? Math.max(40, tm.measuredH) : tm.measuredH, node.minH, node.maxH);
        }
      }
      const tm = node._textMetrics;
      if (tm?.clipped) {
        fontReport.clipDiagnostics.push({
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
        });
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
        const fixedTotalW = node.children.reduce((acc, c) => acc + (c.flex || c.w === 'fill' ? 0 : c._mw), 0);
        const totalGap = Math.max(0, node.children.length - 1) * gap;
        const totalFlex = node.children.reduce((acc, c) => acc + (Number(c.flex) || (c.w === 'fill' ? 1 : 0)), 0);
        const remW = Math.max(0, innerW - fixedTotalW - totalGap);

        let curX = innerX;
        let stepGap = gap;
        if (totalFlex === 0) {
          if (node.justify === 'center') curX += Math.round(remW / 2);
          else if (node.justify === 'end') curX += remW;
          else if (node.justify === 'space-between' && node.children.length > 1) {
            stepGap = gap + remW / (node.children.length - 1);
          }
        }

        const useBaseline = isBaselineAlign(node.align);
        const useLast = node.align === 'last-baseline';
        const sharedBase = useBaseline
          ? Math.max(
              ...node.children.map(c => (useLast ? c._lastBaselineOffset : c._firstBaselineOffset) ?? Math.round((c._mh || 0) * 0.82)),
              0
            )
          : 0;

        for (const ch of node.children) {
          const flexWeight = Number(ch.flex) || (ch.w === 'fill' ? 1 : 0);
          const chW = flexWeight > 0 ? Math.round((remW * flexWeight) / totalFlex) : ch._mw;
          const chH = ch.h === 'fill' || node.align === 'stretch' ? innerH : ch._mh;
          let chY = innerY;
          if (useBaseline) {
            const cb = (useLast ? ch._lastBaselineOffset : ch._firstBaselineOffset) ?? Math.round((chH || 0) * 0.82);
            chY = innerY + Math.max(0, sharedBase - cb);
          } else if (node.align === 'center' && chH < innerH) {
            chY = innerY + Math.round((innerH - chH) / 2);
          } else if (node.align === 'end' && chH < innerH) {
            chY = innerY + (innerH - chH);
          }
          layout(ch, curX, chY, chW, chH, node._x, node._y);
          curX += ch._w + stepGap;
        }
      } else {
        // stack / free layout
        const placedById = new Map();
        for (const ch of node.children) {
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
          if (ch.pin === 'bottom') relY = innerH - chH;
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
  }

  const tree = prepareTree(rootNode, null);
  measure(tree, canvasW);
  layout(tree, 0, 0, canvasW, canvasH, 0, 0);

  // Font diagnostics
  for (const fam of fontReport.requestedFamilies) {
    const desc = resolveFontDescriptor(fam, { defaultFontFamily, projectDir });
    if (!desc.isFallback || catalogNames.has(fam) || SYSTEM_FONTS.has(fam)) {
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

const pageSceneCache = new Map();

export function resolveDocumentScene(doc, { activePanelStates = {}, runtimeState = null, projectDir = null } = {}) {
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
    v: runtimeState?.variables || doc.variables,
    aps: activePanelStates,
    rps: runtimeState?.panelStates || null,
    am: doc.assetsManifest || null,
  });

  for (const pg of doc.pages || []) {
    const pageCacheKey = `${globalContextKey}::${JSON.stringify(pg)}`;
    const cachedPage = pageSceneCache.get(pageCacheKey);
    if (cachedPage) {
      allFontDiagnostics.push(...cachedPage.fontReport.diagnostics);
      allClipDiagnostics.push(...(cachedPage.fontReport.clipDiagnostics || []));
      for (const rn of cachedPage.nodes) {
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

    const { tree, fontReport } = measureAndLayoutTree(pg.root, screenW, screenH, doc, pg.id, { projectDir });
    allFontDiagnostics.push(...fontReport.diagnostics);
    allClipDiagnostics.push(...(fontReport.clipDiagnostics || []));

    const flatNodes = [];
    function collectResolved(n, scopePrefix, offsetX, offsetY, depth = 0, clipBounds = null, visibleAncestor = true, parentNode = null, panelOwnerId = null, parentScopedId = null) {
      const scopedId = `${scopePrefix}/${n.id}`;
      const isVisible = visibleAncestor && n.visible !== false && n.hidden !== true;
      const screenX = offsetX + n._x;
      const screenY = offsetY + n._y;
      const pageGlobalX = shellPad + screenX;
      const pageGlobalY = shellPad + screenY;

      // Resolve runtime variable formulas if runtimeState or initial variable preview
      let displayText =
        n.text ??
        n.value ??
        (Array.isArray(n.spans) && n.spans.length > 0
          ? n._textMetrics?.text || n.spans.map(s => s?.text ?? '').join('')
          : '');
      if (typeof displayText === 'string' && displayText.startsWith('=')) {
        displayText = evaluateSimpleDisplayFormula(displayText, runtimeState?.variables || doc.variables || {});
      }

      const assetEntry = n.type === 'image' && n.src ? (doc.assetsManifest?.[n.src] || null) : null;

      const resolvedNode = {
        id: n.id,
        scopedId,
        pageId: pg.id,
        parentId: parentNode?.id || null,
        parentScopedId,
        parentLayout: parentNode?.layout || 'stack',
        panelOwnerId: panelOwnerId || null,
        renderOrder: flatNodes.length + 1,
        name: n.name || n.id,
        type: n.type,
        // 语义角色：让工具能判断"关系"（主操作是否唯一、空态是否覆盖），
        // 而不只是量单个元素的尺寸。
        role: n.role || null,
        // variant 是按钮/实例的语义分支（primary/secondary），少了它关系检查读不到"主操作"。
        variant: n.variant || n.tone || n._instanceVariant || n.variants?.[n.variantKey] || null,
        component: n.componentSource?.componentId || n.component || null,
        componentVariant: n.componentSource?.variant || n.variantKey || null,
        // 可点热区可以与图形尺寸不同（小图标 + 44px 热区是常见做法）
        hitW: Number.isFinite(n.hitW) ? n.hitW : (Number.isFinite(n.hitArea?.w) ? n.hitArea.w : null),
        hitH: Number.isFinite(n.hitH) ? n.hitH : (Number.isFinite(n.hitArea?.h) ? n.hitArea.h : null),
        for: n.for || n.emptyFor || n.boundTo || null,
        layout: n.layout || 'stack',
        x: screenX,
        y: screenY,
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
        text: n._textMetrics?.truncated ? n._textMetrics.displayText : String(displayText),
        truncated: Boolean(n._textMetrics?.truncated),
        rawText: n.text ?? null,
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
          const datasetName = n.dataset || n.source || n.id;
          const allRows = (datasetName && doc.datasets?.[datasetName]?.rows) || n.rows || [];
          let rows = allRows;
          if (n.filter && n.filter.field) {
            rows = allRows.filter(row => {
              const value = String(row?.[n.filter.field] ?? '');
              return Array.isArray(n.filter.in) ? n.filter.in.includes(value) : value === String(n.filter.equals);
            });
          }
          if (n.sort && n.sort.field) {
            const dir = n.sort.direction === 'desc' ? -1 : 1;
            rows = [...rows].sort((a, b) => String(a?.[n.sort.field] ?? '').localeCompare(String(b?.[n.sort.field] ?? '')) * dir);
          }
          return {
            dataset: datasetName,
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
        gradient: n.gradient || null,
        shadow: n.shadow || null,
        backdropBlur: n.backdropBlur || null,
        aurora: n.aurora || null,
        noise: n.noise || null,
        css: n.css ? structuredClone(n.css) : null,
        customFilter: n.customFilter || null,
        threeDTransform: n.threeDTransform || null,
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
        on: n.on || null,
        childrenIds: (n.children || []).map(c => `${scopePrefix}/${c.id}`),
      };

      if (n.type === 'dynamic-panel' && Array.isArray(n.states)) {
        const stateKey = `${pg.id}/${n.id}`;
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

      flatNodes.push(resolvedNode);
      nodesByScopedId[scopedId] = resolvedNode;

      const nextClip = n.radius > 0 || n.type === 'phone-shell' || n.type === 'dynamic-panel'
        ? { x: screenX, y: screenY, w: n._w, h: n._h, radius: n.radius || (preset?.screenRadius ?? 0) }
        : clipBounds;

      if (Array.isArray(n.children)) {
        for (const ch of n.children) {
          collectResolved(ch, scopePrefix, offsetX, offsetY, depth + 1, nextClip, isVisible, n, panelOwnerId, scopedId);
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
            scopedId
          );
        }
      }
    }

    collectResolved(tree, pg.id, 0, 0, 0, null, true, null, null);

    const pageObj = {
      id: pg.id,
      name: pg.name,
      device: pg.device,
      // 页面自己的域必须下发：否则下游只能回落到 doc.domain，
      // 一个 mobile 工程里的 web 页会被按手机阈值误判。
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
    if (pageSceneCache.size > 250) pageSceneCache.clear();
    pageSceneCache.set(pageCacheKey, pageObj);
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
    assetDiagnostics: doc.diagnostics || [],
    typographyStats: getTypographyCacheStats(),
  };
  Object.defineProperty(sceneObj, 'nodesByScopedId', { value: nodesByScopedId, enumerable: false, configurable: true });
  return sceneObj;
}

export function evaluateSimpleDisplayFormula(expr, variablesMap) {
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
  return raw;
}
