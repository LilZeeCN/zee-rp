import { createHash } from 'node:crypto';

const STYLE_FIELDS = ['fill', 'stroke', 'color', 'radius', 'opacity', 'rotation', 'visible', 'css', 'fills', 'shadows', 'mixBlendMode'];
const differs = (before, after) => before !== after && (
  typeof before !== 'object' || typeof after !== 'object' || JSON.stringify(before) !== JSON.stringify(after)
);

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function computePageContentHash(rawPage, resolvedPage = null) {
  if (resolvedPage && Object.hasOwn(resolvedPage, '_cachedContentHash') && resolvedPage._cachedRawId === rawPage?.id) {
    return resolvedPage._cachedContentHash;
  }
  const payload = {
    id: rawPage?.id,
    name: rawPage?.name,
    device: rawPage?.device,
    canvas: rawPage?.canvas,
    root: rawPage?.root,
    resolvedNodes: (resolvedPage?.nodes || []).map(n => ({
      scopedId: n.scopedId,
      type: n.type,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      pageGlobalX: n.pageGlobalX,
      pageGlobalY: n.pageGlobalY,
      text: n.text,
      spans: n.spans ?? undefined,
      fills: n.fills,
      shadows: n.shadows,
      mixBlendMode: n.mixBlendMode,
      lineCount: n.lineCount,
      fontFamily: n.fontFamily,
      fontSize: n.fontSize,
      fontWeight: n.fontWeight,
      fill: n.fill,
      stroke: n.stroke,
      color: n.color,
      radius: n.radius,
      opacity: n.opacity,
      visible: n.visible,
      state: n.state,
      activeStateId: n.activeStateId,
    })),
  };
  const hash = sha256Json(payload);
  if (resolvedPage && typeof resolvedPage === 'object') {
    Object.defineProperty(resolvedPage, '_cachedContentHash', { value: hash, enumerable: false, configurable: true });
    Object.defineProperty(resolvedPage, '_cachedRawId', { value: rawPage?.id, enumerable: false, configurable: true });
  }
  return hash;
}

export function computePageInteractionHash(rawPage, resolvedPage = null) {
  const rawIxKey = rawPage?.interactions?.length ? JSON.stringify(rawPage.interactions) : '[]';
  if (
    resolvedPage &&
    Object.hasOwn(resolvedPage, '_cachedInteractionHash') &&
    resolvedPage._cachedInteractionIxKey === rawIxKey
  ) {
    return resolvedPage._cachedInteractionHash;
  }
  const payload = {
    pageId: rawPage?.id,
    pageInteractions: rawPage?.interactions || [],
    nodeInteractions: (resolvedPage?.nodes || [])
      .filter(n => n.on || n.type === 'button' || n.type === 'input' || n.type === 'dynamic-panel' || n.type === 'repeater')
      .map(n => ({
        scopedId: n.scopedId,
        type: n.type,
        state: n.state,
        interactive: n.interactive,
        activeStateId: n.activeStateId,
        on: n.on || null,
      })),
  };
  const hash = sha256Json(payload);
  if (resolvedPage && typeof resolvedPage === 'object') {
    Object.defineProperty(resolvedPage, '_cachedInteractionHash', { value: hash, enumerable: false, configurable: true });
    Object.defineProperty(resolvedPage, '_cachedInteractionIxKey', { value: rawIxKey, enumerable: false, configurable: true });
  }
  return hash;
}

function collectComponentsReferencedInTree(node, outSet = new Set()) {
  if (!node || typeof node !== 'object') return outSet;
  const compId = node.component || node.componentId || node.use;
  if ((node.type === 'instance' || node.type === 'use' || compId) && compId) {
    outSet.add(compId);
  }
  for (const ch of node.children || []) collectComponentsReferencedInTree(ch, outSet);
  for (const st of node.states || []) if (st.root) collectComponentsReferencedInTree(st.root, outSet);
  if (node.template) collectComponentsReferencedInTree(node.template, outSet);
  return outSet;
}

export function getTransitiveComponentClosure(doc, seedComponentIds) {
  const closure = new Set(seedComponentIds);
  const comps = doc?.components || {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const [compId, compDef] of Object.entries(comps)) {
      if (closure.has(compId)) continue;
      const refs = collectComponentsReferencedInTree(compDef?.root);
      for (const r of refs) {
        if (closure.has(r)) {
          closure.add(compId);
          changed = true;
          break;
        }
      }
    }
  }
  return closure;
}

function findNodeReferencesToVariablesOrTargets(node, targetNames, pageId, out = []) {
  if (!node) return out;
  const rawText = String(node.rawText ?? node.text ?? '');
  const onStr = node.on ? JSON.stringify(node.on) : '';
  for (const name of targetNames) {
    if (!name) continue;
    if (
      rawText.includes(name) ||
      onStr.includes(`"${name}"`) ||
      node.dataset === name ||
      node.id === name ||
      node.scopedId === name
    ) {
      out.push(node.scopedId || `${pageId}/${node.id}`);
      break;
    }
  }
  return out;
}

export function computeCommandImpactAndDiff({
  beforeDoc,
  afterDoc,
  beforeScene,
  afterScene,
  commands = [],
  directAffectedIds = [],
  contractEvolutionResults = [],
  scenarioVerificationResult = null,
  extraDiagnostics = [],
}) {
  const directTargetNodeIds = new Set();
  const changedComponentIds = new Set();
  const changedTokenKeys = new Set();
  const changedVariableOrDatasetNames = new Set();
  let hasInteractionOrStateCommand = false;

  for (const id of directAffectedIds || []) {
    const str = String(id);
    if (str.startsWith('component:')) {
      changedComponentIds.add(str.slice('component:'.length));
    } else if (str.startsWith('token:')) {
      changedTokenKeys.add(str.slice('token:'.length));
    } else if (str.startsWith('variable:')) {
      changedVariableOrDatasetNames.add(str.slice('variable:'.length));
      hasInteractionOrStateCommand = true;
    } else if (str.startsWith('dataset:')) {
      changedVariableOrDatasetNames.add(str.slice('dataset:'.length));
      hasInteractionOrStateCommand = true;
    } else if (str === 'fonts') {
      // Document-level font update
    } else {
      directTargetNodeIds.add(str);
    }
  }

  for (const cmd of commands || []) {
    const type = cmd?.type;
    if (type === 'upsert-component' || type === 'upgrade-component-contract' || type === 'evolve-component-contract') {
      const cid = cmd.componentId || cmd.id || cmd.component?.id;
      if (cid) changedComponentIds.add(cid);
    }
    if (type === 'set-tokens') {
      for (const group of ['colors', 'spacing', 'radius', 'typography']) {
        for (const k of Object.keys(cmd[group] || cmd.tokens?.[group] || {})) {
          changedTokenKeys.add(k.replace(/^\$/, ''));
        }
      }
      for (const k of Object.keys(cmd.colors || cmd.palette || {})) {
        changedTokenKeys.add(k.replace(/^\$/, ''));
      }
    }
    if (type === 'bind-interaction' || type === 'set-panel-state' || type === 'runtime-step') {
      hasInteractionOrStateCommand = true;
      if (cmd.nodeId) changedVariableOrDatasetNames.add(cmd.nodeId);
      if (cmd.panelId) changedVariableOrDatasetNames.add(cmd.panelId);
    }
    if (type === 'set-props' && cmd.props && (cmd.props.on || cmd.props.state || cmd.props.activeState)) {
      hasInteractionOrStateCommand = true;
    }
    if (type === 'set-variable' && cmd.name) {
      hasInteractionOrStateCommand = true;
      changedVariableOrDatasetNames.add(cmd.name);
    }
    if (type === 'dataset-op' && cmd.dataset) {
      hasInteractionOrStateCommand = true;
      changedVariableOrDatasetNames.add(cmd.dataset);
    }
  }

  // Transitive component closure (handles >= 2 levels of nested components)
  const componentClosure = getTransitiveComponentClosure(afterDoc, changedComponentIds);

  const affectedAncestorIds = new Set();
  const shiftedSiblingAndDescendantIds = new Set();
  const affectedComponentInstanceIds = new Set();
  const affectedTokenConsumerIds = new Set();
  const affectedInteractionBindingIds = new Set();

  const textChanges = [];
  const styleChanges = [];
  const structureChanges = [];
  const componentDefinitionChanges = [];
  const tokenChanges = [];
  const variableAndEventChanges = [];
  const vectorChanges = [];

  // 1. Token diff
  const beforeColors = { ...(beforeDoc?.palette || {}), ...(beforeDoc?.tokens?.colors || {}) };
  const afterColors = { ...(afterDoc?.palette || {}), ...(afterDoc?.tokens?.colors || {}) };
  for (const k of new Set([...Object.keys(beforeColors), ...Object.keys(afterColors)])) {
    if (beforeColors[k] !== afterColors[k]) {
      changedTokenKeys.add(k.replace(/^\$/, ''));
      tokenChanges.push({
        tokenType: 'color',
        token: `$${k.replace(/^\$/, '')}`,
        before: beforeColors[k] ?? null,
        after: afterColors[k] ?? null,
      });
    }
  }

  // 2. Component definition diff
  for (const compId of componentClosure) {
    const bComp = beforeDoc?.components?.[compId] || null;
    const aComp = afterDoc?.components?.[compId] || null;
    if (JSON.stringify(bComp) !== JSON.stringify(aComp) || changedComponentIds.has(compId)) {
      const evo = (contractEvolutionResults || []).find(e => e.componentId === compId) || null;
      componentDefinitionChanges.push({
        componentId: compId,
        isDirectEdit: changedComponentIds.has(compId),
        beforeVersion: bComp?.contractVersion || bComp?.contract?.version || '1.0.0',
        afterVersion: aComp?.contractVersion || aComp?.contract?.version || '1.0.0',
        migratedInstancesCount: evo?.migratedInstances?.length ?? 0,
        staleOverridesCount: evo?.staleOverrideDiagnostics?.length ?? 0,
        staleOverrides: evo?.staleOverrideDiagnostics || [],
      });
    }
  }

  // 2.5 Document-level variable & dataset diff
  const beforeVars = beforeDoc?.variables || {};
  const afterVars = afterDoc?.variables || {};
  for (const vKey of new Set([...Object.keys(beforeVars), ...Object.keys(afterVars)])) {
    if (JSON.stringify(beforeVars[vKey]) !== JSON.stringify(afterVars[vKey])) {
      hasInteractionOrStateCommand = true;
      changedVariableOrDatasetNames.add(vKey);
      variableAndEventChanges.push({
        kind: 'variable-changed',
        variable: vKey,
        beforeValue: beforeVars[vKey] ?? null,
        afterValue: afterVars[vKey] ?? null,
      });
    }
  }
  const beforeDs = beforeDoc?.datasets || {};
  const afterDs = afterDoc?.datasets || {};
  for (const dsKey of new Set([...Object.keys(beforeDs), ...Object.keys(afterDs)])) {
    const bRows = beforeDs[dsKey]?.rows || [];
    const aRows = afterDs[dsKey]?.rows || [];
    if (JSON.stringify(bRows) !== JSON.stringify(aRows)) {
      hasInteractionOrStateCommand = true;
      changedVariableOrDatasetNames.add(dsKey);
      variableAndEventChanges.push({
        kind: 'dataset-changed',
        dataset: dsKey,
        beforeRowCount: bRows.length,
        afterRowCount: aRows.length,
      });
    }
  }

  // 3. Per-page scene diff & transitive propagation
  const beforePagesById = new Map((beforeScene?.pages || []).map(p => [p.id, p]));
  const afterPagesById = new Map((afterScene?.pages || []).map(p => [p.id, p]));
  const rawBeforePagesById = new Map((beforeDoc?.pages || []).map(p => [p.id, p]));
  const rawAfterPagesById = new Map((afterDoc?.pages || []).map(p => [p.id, p]));

  const allPageIds = [...new Set([...beforePagesById.keys(), ...afterPagesById.keys()])];

  for (const pageId of allPageIds) {
    const bPage = beforePagesById.get(pageId);
    const aPage = afterPagesById.get(pageId);
    if (!bPage && aPage) {
      structureChanges.push({ kind: 'page-added', pageId, name: aPage.name });
      for (const n of aPage.nodes || []) directTargetNodeIds.add(n.scopedId);
      continue;
    }
    if (bPage && !aPage) {
      structureChanges.push({ kind: 'page-removed', pageId, name: bPage.name });
      continue;
    }
    const hasDirectTargetOnPage = [...directTargetNodeIds].some(id => String(id).startsWith(`${pageId}/`) || id === pageId);
    if (
      bPage === aPage &&
      !hasDirectTargetOnPage &&
      componentClosure.size === 0 &&
      changedTokenKeys.size === 0 &&
      changedVariableOrDatasetNames.size === 0
    ) {
      continue;
    }

    const bNodes = new Map((bPage?.nodes || []).map(n => [n.scopedId, n]));
    const aNodes = new Map((aPage?.nodes || []).map(n => [n.scopedId, n]));

    // Check added or removed nodes
    for (const [scopedId, aNode] of aNodes.entries()) {
      if (!bNodes.has(scopedId)) {
        directTargetNodeIds.add(scopedId);
        structureChanges.push({
          kind: 'node-added',
          pageId,
          scopedId,
          nodeId: aNode.id,
          nodeType: aNode.type,
          afterRect: { x: aNode.pageGlobalX, y: aNode.pageGlobalY, w: aNode.w, h: aNode.h },
        });
      }
    }
    for (const [scopedId, bNode] of bNodes.entries()) {
      if (!aNodes.has(scopedId)) {
        structureChanges.push({
          kind: 'node-removed',
          pageId,
          scopedId,
          nodeId: bNode.id,
          nodeType: bNode.type,
          beforeRect: { x: bNode.pageGlobalX, y: bNode.pageGlobalY, w: bNode.w, h: bNode.h },
        });
      }
    }

    // Track which nodes on this page had direct or component/token changes
    const pageSeedChangedIds = new Set();
    const hasGlobalWatch = componentClosure.size > 0 || changedTokenKeys.size > 0 || changedVariableOrDatasetNames.size > 0;
    for (const [scopedId, aNode] of aNodes.entries()) {
      const bSeedNode = bNodes.get(scopedId);
      if (bSeedNode === aNode && !directTargetNodeIds.has(scopedId) && !hasGlobalWatch) {
        continue;
      }
      if (directTargetNodeIds.has(scopedId)) {
        pageSeedChangedIds.add(scopedId);
      }
      if (bSeedNode && (bSeedNode.text !== aNode.text || bSeedNode.lineCount !== aNode.lineCount)) {
        pageSeedChangedIds.add(scopedId);
      }
      // Component instance match (including nested component instances via instancePath or componentClosure)
      if (aNode.componentSource?.componentId && componentClosure.has(aNode.componentSource.componentId)) {
        affectedComponentInstanceIds.add(scopedId);
        if (aNode.componentSource.instanceId) {
          affectedComponentInstanceIds.add(`${pageId}/${aNode.componentSource.instanceId}`);
        }
        if (aNode.componentSource.instancePath) {
          const topInstanceId = aNode.componentSource.instancePath.split('/')[0];
          if (topInstanceId) affectedComponentInstanceIds.add(`${pageId}/${topInstanceId}`);
        }
        pageSeedChangedIds.add(scopedId);
      }

      // Token consumer match
      if (changedTokenKeys.size > 0 && aNode.tokenRefs) {
        for (const refVal of Object.values(aNode.tokenRefs)) {
          const cleanRef = String(refVal).replace(/^\$/, '');
          if (changedTokenKeys.has(cleanRef)) {
            affectedTokenConsumerIds.add(scopedId);
            pageSeedChangedIds.add(scopedId);
          }
        }
      }

      // Variable / interaction consumer match
      if (changedVariableOrDatasetNames.size > 0) {
        const hits = findNodeReferencesToVariablesOrTargets(aNode, changedVariableOrDatasetNames, pageId);
        for (const h of hits) {
          affectedInteractionBindingIds.add(h);
          pageSeedChangedIds.add(h);
        }
      }
    }

    // Walk ancestors of any seed changed node on this page
    for (const seedId of [...pageSeedChangedIds]) {
      let cur = aNodes.get(seedId);
      while (cur && cur.parentScopedId) {
        const parent = aNodes.get(cur.parentScopedId);
        if (!parent) break;
        const bParent = bNodes.get(parent.scopedId);
        if (
          !bParent ||
          bParent.w !== parent.w ||
          bParent.h !== parent.h ||
          bParent.x !== parent.x ||
          bParent.y !== parent.y
        ) {
          affectedAncestorIds.add(parent.scopedId);
        }
        cur = parent;
      }
    }

    // Compare every existing node before vs after
    for (const [scopedId, aNode] of aNodes.entries()) {
      const bNode = bNodes.get(scopedId);
      if (!bNode || bNode === aNode) continue;

      // Text diff
      const spansChanged = differs(bNode.spans, aNode.spans);
      if (
        bNode.text !== aNode.text ||
        spansChanged ||
        bNode.lineCount !== aNode.lineCount ||
        bNode.fontFamily !== aNode.fontFamily ||
        bNode.fontSize !== aNode.fontSize ||
        bNode.fontWeight !== aNode.fontWeight
      ) {
        textChanges.push({
          pageId,
          scopedId,
          nodeId: aNode.id,
          beforeText: bNode.text,
          afterText: aNode.text,
          ...(spansChanged
            ? { beforeSpans: bNode.spans, afterSpans: aNode.spans } : {}),
          beforeLines: bNode.lineCount,
          afterLines: aNode.lineCount,
          beforeFont: `${bNode.fontFamily} ${bNode.fontSize}px/${bNode.fontWeight}`,
          afterFont: `${aNode.fontFamily} ${aNode.fontSize}px/${aNode.fontWeight}`,
        });
      }

      // Style diff
      const changedFields = STYLE_FIELDS.filter(field => differs(bNode[field], aNode[field]));
      if (changedFields.length) {
        styleChanges.push({
          pageId,
          scopedId,
          nodeId: aNode.id,
          changedFields,
          before: Object.fromEntries(STYLE_FIELDS.map(field => [field, bNode[field] ?? null])),
          after: Object.fromEntries(STYLE_FIELDS.map(field => [field, aNode[field] ?? null])),
        });
      }

      // 矢量路径内容 diff：editPath/import-svg 只替换 points/svgD、外接盒不变时，
      // 不计入任何现有类别会落进「无实质视觉或结构变更」（T-HR-1 摘要不敏感）。
      if (bNode.svgD !== aNode.svgD || differs(bNode.booleanRect, aNode.booleanRect)) {
        vectorChanges.push({ pageId, scopedId, nodeId: aNode.id, beforeD: bNode.svgD ?? null, afterD: aNode.svgD ?? null });
      }

      // State / interaction diff
      if (
        bNode.state !== aNode.state ||
        bNode.activeStateId !== aNode.activeStateId ||
        JSON.stringify(bNode.on) !== JSON.stringify(aNode.on)
      ) {
        hasInteractionOrStateCommand = true;
        affectedInteractionBindingIds.add(scopedId);
        variableAndEventChanges.push({
          pageId,
          scopedId,
          nodeId: aNode.id,
          beforeState: bNode.state,
          afterState: aNode.state,
          beforeActivePanelState: bNode.activeStateId ?? null,
          afterActivePanelState: aNode.activeStateId ?? null,
          interactionChanged: JSON.stringify(bNode.on) !== JSON.stringify(aNode.on),
        });
      }

      // Geometry / structure diff
      const geomChanged =
        bNode.x !== aNode.x ||
        bNode.y !== aNode.y ||
        bNode.w !== aNode.w ||
        bNode.h !== aNode.h ||
        bNode.pageGlobalX !== aNode.pageGlobalX ||
        bNode.pageGlobalY !== aNode.pageGlobalY ||
        bNode.parentScopedId !== aNode.parentScopedId;

      if (geomChanged) {
        const isAncestor = affectedAncestorIds.has(scopedId);
        const isDirect = directTargetNodeIds.has(scopedId);
        const isComp = affectedComponentInstanceIds.has(scopedId);
        if (!isDirect && !isAncestor && !isComp) {
          if (bNode.w !== aNode.w || bNode.h !== aNode.h) {
            // Container that resized due to descendant change
            if (Array.isArray(aNode.childrenIds) && aNode.childrenIds.length > 0) {
              affectedAncestorIds.add(scopedId);
            } else {
              shiftedSiblingAndDescendantIds.add(scopedId);
            }
          } else {
            shiftedSiblingAndDescendantIds.add(scopedId);
          }
        }
        structureChanges.push({
          kind: bNode.parentScopedId !== aNode.parentScopedId ? 'node-reparented' : 'geometry-changed',
          pageId,
          scopedId,
          nodeId: aNode.id,
          role: isDirect
            ? 'direct-target'
            : isAncestor
              ? 'resized-ancestor'
              : isComp
                ? 'component-instance'
                : 'shifted-sibling-or-descendant',
          beforeRect: { x: bNode.pageGlobalX, y: bNode.pageGlobalY, w: bNode.w, h: bNode.h },
          afterRect: { x: aNode.pageGlobalX, y: aNode.pageGlobalY, w: aNode.w, h: aNode.h },
          delta: {
            dx: aNode.pageGlobalX - bNode.pageGlobalX,
            dy: aNode.pageGlobalY - bNode.pageGlobalY,
            dw: aNode.w - bNode.w,
            dh: aNode.h - bNode.h,
          },
        });
      }
    }
  }

  // Merge all affected node IDs in deterministic order (leaf/direct nodes + shifted + ancestors)
  const allAffectedNodeIds = [
    ...new Set([
      ...directTargetNodeIds,
      ...affectedComponentInstanceIds,
      ...affectedTokenConsumerIds,
      ...affectedInteractionBindingIds,
      ...vectorChanges.map(change => change.scopedId),
      ...shiftedSiblingAndDescendantIds,
      ...affectedAncestorIds,
    ]),
  ];

  const affectedPageIdsSet = new Set();
  for (const id of allAffectedNodeIds) {
    const pgId = String(id).split('/')[0];
    if (pgId && afterPagesById.has(pgId)) {
      affectedPageIdsSet.add(pgId);
    }
  }
  const affectedPageIds = [...affectedPageIdsSet];

  // Verify unaffected pages have 100% identical contentHash and interactionHash
  const unaffectedPagesVerification = [];
  for (const pageId of allPageIds) {
    if (affectedPageIdsSet.has(pageId)) continue;
    const rawB = rawBeforePagesById.get(pageId);
    const rawA = rawAfterPagesById.get(pageId);
    const resB = beforePagesById.get(pageId);
    const resA = afterPagesById.get(pageId);
    if (!rawB || !rawA) continue;
    const beforeContentHash = computePageContentHash(rawB, resB);
    const afterContentHash = computePageContentHash(rawA, resA);
    const beforeInteractionHash = computePageInteractionHash(rawB, resB);
    const afterInteractionHash = computePageInteractionHash(rawA, resA);
    unaffectedPagesVerification.push({
      pageId,
      beforeContentHash,
      afterContentHash,
      beforeInteractionHash,
      afterInteractionHash,
      contentUnchanged: beforeContentHash === afterContentHash,
      interactionUnchanged: beforeInteractionHash === afterInteractionHash,
      unchangedVerified: beforeContentHash === afterContentHash && beforeInteractionHash === afterInteractionHash,
    });
  }

  const interactionHashChanges = [];
  for (const pageId of new Set([...beforePagesById.keys(), ...afterPagesById.keys()])) {
    const beforePage = (beforeDoc.pages || []).find(p => p.id === pageId);
    const afterPage = (afterDoc.pages || []).find(p => p.id === pageId);
    const beforeHash = computePageInteractionHash(beforePage, beforePagesById.get(pageId));
    const afterHash = computePageInteractionHash(afterPage, afterPagesById.get(pageId));
    if (beforeHash !== afterHash) {
      interactionHashChanges.push({ kind: 'page-interactions-changed', pageId, beforeHash, afterHash });
      hasInteractionOrStateCommand = true;
    }
  }
  variableAndEventChanges.push(...interactionHashChanges);


  // Diagnostics check on afterScene (clipping, overflow, missing assets, stale overrides)
  const clipIssues = afterScene?.clipDiagnostics || [];
  const staleOverrideIssues = (afterDoc?.diagnostics || []).filter(d => d.code === 'E_STALE_OVERRIDE');
  const assetIssues = (afterDoc?.diagnostics || []).filter(d => d.missing);

  // Build human-readable & AI-readable summary
  const summaryParts = [];
  if (textChanges.length > 0) {
    summaryParts.push(`文案/排版变更 ${textChanges.length} 处`);
  }
  if (styleChanges.length > 0) {
    const visibilityCount = styleChanges.filter(change => change.changedFields.includes('visible')).length;
    summaryParts.push(`视觉样式变更 ${styleChanges.length} 处${visibilityCount ? `（其中 ${visibilityCount} 处显隐变化）` : ''}`);
  }
  if (vectorChanges.length > 0) {
    // T-HR-1：给矢量内容替换（import-svg / set-subpaths / 布尔产物）一个正确的摘要标签。
    const hasImportSvg = (commands || []).some(cmd => cmd?.type === 'editPath' && (cmd.operation === 'import-svg' || (cmd.svg !== undefined && cmd.operation === undefined)));
    summaryParts.push(`矢量路径变更 ${vectorChanges.length} 处${hasImportSvg ? '（含 import-svg 导入，路径数据被替换）' : ''}`);
  }
  if (structureChanges.length > 0) {
    summaryParts.push(`结构与几何位置变更 ${structureChanges.length} 处（含祖先增高 ${affectedAncestorIds.size} 个、兄弟/子节点位移 ${shiftedSiblingAndDescendantIds.size} 个）`);
  }
  if (componentDefinitionChanges.length > 0) {
    summaryParts.push(`组件契约/定义更新 ${componentDefinitionChanges.length} 个（联动实例节点 ${affectedComponentInstanceIds.size} 个）`);
  }
  if (tokenChanges.length > 0) {
    summaryParts.push(`设计令牌更新 ${tokenChanges.length} 项（联动消费节点 ${affectedTokenConsumerIds.size} 个）`);
  }
  if (variableAndEventChanges.length > 0) {
    summaryParts.push(`状态与交互变更 ${variableAndEventChanges.length} 处`);
  }

  // T-E-3：属性写入但零视觉/结构变化时显式说明，避免「无实质变更」被误读为成功对齐；
  // 同值写入（ensure 模式）与"存了但当前上下文不消费"分开措辞，不做硬拒绝。
  if (summaryParts.length === 0) {
    const writtenKeys = new Set();
    for (const cmd of commands || []) {
      if (!cmd || typeof cmd !== 'object') continue;
      if (cmd.type === 'setProperties' || cmd.type === 'set-props') for (const key of Object.keys(cmd.properties || cmd.props || {})) writtenKeys.add(key);
      if (cmd.type === 'editNodes' && cmd.operation === 'set') for (const key of Object.keys(cmd.properties || {})) writtenKeys.add(key);
    }
    if (writtenKeys.size > 0) {
      const pureNoop = beforeDoc?.contentHash && beforeDoc.contentHash === afterDoc?.contentHash;
      summaryParts.push(pureNoop
        ? `属性 ${[...writtenKeys].join(', ')} 与当前值相同，本次写入未产生任何变更（no-op）`
        : `属性 ${[...writtenKeys].join(', ')} 已写入，当前摘要未检测到视觉或结构变化`);
    }
  }

  const whatChanged = summaryParts.length > 0 ? summaryParts.join('；') : '无实质视觉或结构变更';
  const affectedScope = affectedPageIds.length > 0
    ? `影响页面 [${affectedPageIds.join(', ')}]，共波及 ${allAffectedNodeIds.length} 个节点；其余 ${unaffectedPagesVerification.length} 个未受影响页面经哈希核验 100% 保持不变`
    : `未影响任何页面节点（全部 ${unaffectedPagesVerification.length} 个页面哈希核验不变）`;

  // 摘要与 diagnostics 数组保持一致：按 code 聚合全部事务诊断（文档级 + 场景截断 + 事务生成），
  // 已知三族沿用原文案，其余诊断不再被静默折叠成「无」。
  const txDiagnosticList = [
    ...(extraDiagnostics || []),
    ...(afterDoc?.diagnostics || []),
    ...(afterScene?.clipDiagnostics || []).map(d => ({ ...d, code: d.code || 'E_TEXT_CLIP' })),
  ];
  const diagByCode = new Map();
  for (const d of txDiagnosticList) {
    const code = d.code || (d.missing ? 'E_MISSING_ASSET' : 'DIAG');
    diagByCode.set(code, (diagByCode.get(code) || 0) + 1);
  }
  const diagLabels = {
    W_STACK_CHILDREN_UNPLACED: count => `发现 ${count} 个 stack 容器有子节点因省略坐标而共用起点，请检查坐标或改用自动布局`,
    W_SHOW_MASKED_BY_HIDDEN_ANCESTOR: count => `发现 ${count} 处 show/toggle 目标被隐藏祖先容器遮蔽 (W_SHOW_MASKED_BY_HIDDEN_ANCESTOR)`,
    W_CASE_CONSTANT_CONDITION: count => `发现 ${count} 处恒真/恒假交互条件 (W_CASE_CONSTANT_CONDITION)`,
    W_CASE_SHADOWED: count => `发现 ${count} 处被遮蔽的死分支 (W_CASE_SHADOWED)`,
    W_SEQUENTIAL_WHEN_MUTATION: count => `发现 ${count} 处顺序 when 读取前序刚修改的变量风险 (W_SEQUENTIAL_WHEN_MUTATION)`,
    W_STATE_VAR_NEVER_UPDATED: count => `发现 ${count} 个条件依赖的状态变量从未被 set-var 更新 (W_STATE_VAR_NEVER_UPDATED)`,
    W_BUTTON_NO_INTERACTION: count => `发现 ${count} 个可见按钮未绑定任何交互 (W_BUTTON_NO_INTERACTION)`,
    W_UNREACHABLE_HIDDEN_LAYER: count => `发现 ${count} 个隐藏节点无任何 show/toggle 指向 (W_UNREACHABLE_HIDDEN_LAYER)`,
    E_TEXT_CLIP: count => `发现文字截断/溢出风险 ${count} 处`,
    E_STALE_OVERRIDE: count => `发现失效组件覆盖 (E_STALE_OVERRIDE) ${count} 处`,
    E_MISSING_ASSET: count => `发现缺失资源 ${count} 处`,
  };
  const diagParts = [...diagByCode.entries()].map(([code, count]) => diagLabels[code]?.(count) ?? `发现 ${code} 诊断 ${count} 处`);
  const diagnosticsSummary = diagParts.length > 0
    ? diagParts.join('；')
    : '无文字截断、布局溢出或引用失效';

  let interactionVerification;
  if (scenarioVerificationResult) {
    interactionVerification = {
      verifiedByExecution: true,
      executedScenariosCount: scenarioVerificationResult.executedCount ?? scenarioVerificationResult.results?.length ?? 0,
      passedCount: scenarioVerificationResult.passedCount ?? 0,
      failedCount: scenarioVerificationResult.failedCount ?? 0,
      allPassed: Boolean(scenarioVerificationResult.allPassed),
      scenarioIds: (scenarioVerificationResult.results || []).map(r => r.scenarioId),
      summary: scenarioVerificationResult.allPassed
        ? `已真实执行 ${scenarioVerificationResult.executedCount} 个关联验收场景（${(scenarioVerificationResult.results || []).map(r => r.scenarioId).join(', ')}），关键交互路径全部通过`
        : `已真实执行 ${scenarioVerificationResult.executedCount} 个关联验收场景，发现 ${scenarioVerificationResult.failedCount} 个场景未通过`,
    };
  } else if (hasInteractionOrStateCommand) {
    interactionVerification = {
      verifiedByExecution: false,
      requiresScenarioRun: true,
      summary: '本次改动涉及交互或状态，需执行关联验收场景以确认关键交互路径可用',
    };
  } else {
    interactionVerification = {
      verifiedByExecution: false,
      verifiedByInteractionHash: true,
      summary: '交互定义哈希未变化；尚未执行业务场景，运行行为需另行验证',
    };
  }

  return {
    transitiveImpact: {
      directTargetNodeIds: [...directTargetNodeIds],
      affectedAncestorIds: [...affectedAncestorIds],
      shiftedSiblingAndDescendantIds: [...shiftedSiblingAndDescendantIds],
      affectedComponentInstanceIds: [...affectedComponentInstanceIds],
      affectedTokenConsumerIds: [...affectedTokenConsumerIds],
      affectedInteractionBindingIds: [...affectedInteractionBindingIds],
      allAffectedNodeIds,
      affectedPageIds,
      unaffectedPagesVerification,
    },
    semanticDiff: {
      textChanges,
      styleChanges,
      structureChanges,
      componentDefinitionChanges,
      tokenChanges,
      variableAndEventChanges,
    },
    humanReadableSummary: {
      whatChanged,
      affectedScope,
      diagnosticsSummary,
      interactionVerification,
      fullText: `【改稿摘要】${whatChanged}。${affectedScope}。诊断：${diagnosticsSummary}。交互核验：${interactionVerification.summary}。`,
    },
  };
}
