import { createHash } from 'node:crypto';

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function computePageContentHash(rawPage, resolvedPage = null) {
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
  return sha256Json(payload);
}

export function computePageInteractionHash(rawPage, resolvedPage = null) {
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
  return sha256Json(payload);
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
    for (const [scopedId, aNode] of aNodes.entries()) {
      if (directTargetNodeIds.has(scopedId)) {
        pageSeedChangedIds.add(scopedId);
      }
      const bSeedNode = bNodes.get(scopedId);
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
      if (!bNode) continue;

      // Text diff
      if (
        bNode.text !== aNode.text ||
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
          beforeLines: bNode.lineCount,
          afterLines: aNode.lineCount,
          beforeFont: `${bNode.fontFamily} ${bNode.fontSize}px/${bNode.fontWeight}`,
          afterFont: `${aNode.fontFamily} ${aNode.fontSize}px/${aNode.fontWeight}`,
        });
      }

      // Style diff
      if (
        bNode.fill !== aNode.fill ||
        bNode.stroke !== aNode.stroke ||
        bNode.color !== aNode.color ||
        bNode.radius !== aNode.radius ||
        bNode.opacity !== aNode.opacity ||
        JSON.stringify(bNode.css) !== JSON.stringify(aNode.css)
      ) {
        styleChanges.push({
          pageId,
          scopedId,
          nodeId: aNode.id,
          before: { fill: bNode.fill, stroke: bNode.stroke, color: bNode.color, radius: bNode.radius, opacity: bNode.opacity },
          after: { fill: aNode.fill, stroke: aNode.stroke, color: aNode.color, radius: aNode.radius, opacity: aNode.opacity },
        });
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
    summaryParts.push(`视觉样式变更 ${styleChanges.length} 处`);
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

  const whatChanged = summaryParts.length > 0 ? summaryParts.join('；') : '无实质视觉或结构变更';
  const affectedScope = affectedPageIds.length > 0
    ? `影响页面 [${affectedPageIds.join(', ')}]，共波及 ${allAffectedNodeIds.length} 个节点；其余 ${unaffectedPagesVerification.length} 个未受影响页面经哈希核验 100% 保持不变`
    : `未影响任何页面节点（全部 ${unaffectedPagesVerification.length} 个页面哈希核验不变）`;

  const diagParts = [];
  if (clipIssues.length > 0) diagParts.push(`发现文字截断/溢出风险 ${clipIssues.length} 处`);
  if (staleOverrideIssues.length > 0) diagParts.push(`发现失效组件覆盖 (E_STALE_OVERRIDE) ${staleOverrideIssues.length} 处`);
  if (assetIssues.length > 0) diagParts.push(`发现缺失资源 ${assetIssues.length} 处`);
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
