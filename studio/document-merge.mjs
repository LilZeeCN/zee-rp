import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildNodeIndex,
  canonicalJson,
  computeContentHash,
  importToStudioDocument,
  normalizeStudioDocument,
  sha256,
} from './document.mjs';
import { StudioDocumentStore } from './commands.mjs';
import { diffDocuments } from './document-diff.mjs';
import { computeDependencyClosure } from './project-bundle.mjs';
import { prepareRp1Commands } from './rp1-authoring.mjs';

function mergeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const HORIZONTAL_LAYOUT_FIELDS = new Set([
  'x', 'right', 'alignX', 'anchor', 'pin', 'pinGap', 'w', 'minW', 'maxW', 'flex', 'colSpan', 'constraints',
]);

const VERTICAL_LAYOUT_FIELDS = new Set([
  'y', 'bottom', 'after', 'afterGap', 'anchor', 'pin', 'pinGap', 'h', 'minH', 'maxH', 'rowSpan', 'constraints',
]);

const CONTAINER_LAYOUT_FIELDS = new Set([
  'layout', 'columns', 'columnGap', 'rowGap', 'gap', 'padding', 'align', 'justify', 'equalHeight',
]);

const STRUCTURAL_NODE_KEYS = new Set(['children', 'states', 'template', 'sourcePointer']);

function eq(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function nodePropsOnly(node) {
  if (!node || typeof node !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!STRUCTURAL_NODE_KEYS.has(k) && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function indexPageTree(rootNode, pageId) {
  const byId = new Map();
  function walk(node, parentId, containerKey, indexInParent, scopePrefix) {
    if (!node || typeof node !== 'object') return;
    const scopedId = `${scopePrefix}/${node.id}`;
    if (byId.has(scopedId)) throw mergeError('E_MERGE_IDENTITY_AMBIGUOUS', `节点标识 "${scopedId}" 在不同作用域中产生歧义，未合并`, { pageId, targetId: scopedId });
    const childIds = (node.children || []).map(c => `${scopePrefix}/${c.id}`);
    const stateIds = (node.states || []).map(s => s.id);
    const stateRoots = new Map((node.states || []).filter(s => s.root).map(s => [s.id, `${scopedId}/${s.id}/${s.root.id}`]));
    const templateId = node.template ? `${scopedId}/template/${node.template.id}` : null;
    byId.set(scopedId, {
      id: node.id,
      scopedId,
      pageId,
      parentId,
      containerKey,
      indexInParent,
      props: nodePropsOnly(node),
      rawNode: node,
      childIds,
      stateIds,
      stateRoots,
      templateId,
      descendantIds: [...childIds, ...stateRoots.values(), ...(templateId ? [templateId] : [])],
      hasTemplate: Boolean(node.template),
    });
    (node.children || []).forEach((ch, idx) => walk(ch, scopedId, 'children', idx, scopePrefix));
    (node.states || []).forEach((st, idx) => {
      if (st?.root) walk(st.root, scopedId, `state:${st.id}`, idx, `${scopedId}/${st.id}`);
    });
    if (node.template) {
      walk(node.template, scopedId, 'template', 0, `${scopedId}/template`);
    }
  }
  if (rootNode) walk(rootNode, null, 'root', 0, pageId);
  return byId;
}

function isDescendantModifiedOrAdded(nodeId, baseMap, targetMap) {
  const visited = new Set();
  function check(id) {
    if (visited.has(id)) return false;
    visited.add(id);
    const b = baseMap.get(id);
    const t = targetMap.get(id);
    if (!b && t) return true;
    if (!b || !t) return false;
    if (!eq(b.props, t.props)) return true;
    if (!eq(b.descendantIds, t.descendantIds)) return true;
    const stateMetadata = entry => (entry.rawNode.states || []).map(({ root, ...metadata }) => metadata);
    if (!eq(stateMetadata(b), stateMetadata(t))) return true;
    if (b.parentId !== t.parentId || b.containerKey !== t.containerKey) return true;
    for (const cid of t.descendantIds) {
      if (check(cid)) return true;
    }
    return false;
  }
  return check(nodeId);
}

function chooseResolution(conflictId, prefer, resolutions) {
  const explicit = resolutions?.[conflictId];
  if (explicit === 'ours' || explicit === 'theirs') return explicit;
  if (prefer === 'ours' || prefer === 'theirs') return prefer;
  return null;
}

function mergeChildIdOrder(baseIds = [], oursIds = [], theirsIds = [], deletedSet = new Set()) {
  const cleanBase = baseIds.filter(id => !deletedSet.has(id));
  const restoreRescued = (sideList) => {
    const out = sideList.filter(id => !deletedSet.has(id));
    for (let i = 0; i < cleanBase.length; i++) {
      const id = cleanBase[i];
      if (out.includes(id)) continue;
      const prevId = i > 0 ? cleanBase[i - 1] : null;
      const prevIdx = prevId ? out.indexOf(prevId) : -1;
      if (prevIdx >= 0) out.splice(prevIdx + 1, 0, id);
      else out.unshift(id);
    }
    return out;
  };
  const cleanOurs = restoreRescued(oursIds);
  const cleanTheirs = restoreRescued(theirsIds);

  if (eq(cleanOurs, cleanTheirs)) return { order: cleanOurs, conflict: false };
  if (eq(cleanOurs, cleanBase)) return { order: cleanTheirs, conflict: false };
  if (eq(cleanTheirs, cleanBase)) return { order: cleanOurs, conflict: false };

  // Check if common existing items keep the same relative order
  const commonSet = new Set(cleanOurs.filter(id => cleanTheirs.includes(id)));
  const oursCommon = cleanOurs.filter(id => commonSet.has(id));
  const theirsCommon = cleanTheirs.filter(id => commonSet.has(id));
  const baseCommon = cleanBase.filter(id => commonSet.has(id));

  const oursReordered = !eq(oursCommon, baseCommon);
  const theirsReordered = !eq(theirsCommon, baseCommon);
  if (oursReordered && theirsReordered && !eq(oursCommon, theirsCommon)) {
    return { order: cleanOurs, conflict: true, oursOrder: cleanOurs, theirsOrder: cleanTheirs, baseOrder: cleanBase };
  }

  // Merge non-conflicting additions preserving base/reordered sequence
  const baseOrder = oursReordered ? cleanOurs : cleanTheirs;
  const otherList = oursReordered ? cleanTheirs : cleanOurs;
  const merged = [...baseOrder];
  for (let i = 0; i < otherList.length; i++) {
    const id = otherList[i];
    if (merged.includes(id)) continue;
    const prevId = i > 0 ? otherList[i - 1] : null;
    const prevIdx = prevId ? merged.indexOf(prevId) : -1;
    if (prevIdx >= 0) merged.splice(prevIdx + 1, 0, id);
    else merged.push(id);
  }
  return { order: merged, conflict: false };
}

function mergePageTree(pageId, baseRoot, oursRoot, theirsRoot, { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }) {
  const baseMap = indexPageTree(baseRoot, pageId);
  const oursMap = indexPageTree(oursRoot, pageId);
  const theirsMap = indexPageTree(theirsRoot, pageId);

  const allIds = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  const deletedNodes = new Set();
  const mergedPropsById = new Map();
  const chosenParentById = new Map();

  for (const id of allIds) {
    const b = baseMap.get(id);
    const o = oursMap.get(id);
    const t = theirsMap.get(id);
    const scopedId = o?.scopedId || t?.scopedId || b?.scopedId || `${pageId}/${id}`;

    // Case 1: Node existed in base, deleted in one or both
    if (b && (!o || !t)) {
      if (!o && !t) {
        deletedNodes.add(id);
        continue;
      }
      const deletedInOurs = !o;
      const parentDeletedSameSide = b.parentId && baseMap.has(b.parentId) && (deletedInOurs ? !oursMap.has(b.parentId) : !theirsMap.has(b.parentId));
      if (parentDeletedSameSide) {
        if (deletedNodes.has(b.parentId)) {
          deletedNodes.add(id);
        } else {
          const surviving = o || t;
          mergedPropsById.set(id, structuredClone(surviving.props));
          chosenParentById.set(id, { parentId: surviving.parentId, containerKey: surviving.containerKey });
        }
        continue;
      }
      const modifiedOnOther = deletedInOurs
        ? isDescendantModifiedOrAdded(id, baseMap, theirsMap)
        : isDescendantModifiedOrAdded(id, baseMap, oursMap);

      if (modifiedOnOther) {
        const conflictId = `node:${scopedId}:delete-modify`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'delete-modify',
          scope: 'node',
          pageId,
          targetId: scopedId,
          field: '$node',
          baseValue: b.props,
          oursValue: o ? o.props : null,
          theirsValue: t ? t.props : null,
          reason: deletedInOurs
            ? `节点 "${scopedId}" 在当前文档中被删除，但在外部/对方修改中被编辑`
            : `节点 "${scopedId}" 在当前文档中被编辑，但在外部/对方修改中被删除`,
          resolvedWith: choice,
        });
        if (choice) {
          resolutionLog.push({ conflictId, kind: 'delete-modify', targetId: scopedId, chosen: choice });
        }
        const keepNode = (choice === 'ours' && o) || (choice === 'theirs' && t);
        if (!keepNode) {
          deletedNodes.add(id);
          continue;
        }
        const surviving = o || t;
        mergedPropsById.set(id, structuredClone(surviving.props));
        chosenParentById.set(id, { parentId: surviving.parentId, containerKey: surviving.containerKey });
        continue;
      } else {
        deletedNodes.add(id);
        autoMergedChanges.push({
          kind: 'node-deleted',
          pageId,
          targetId: scopedId,
          source: deletedInOurs ? 'ours' : 'theirs',
        });
        continue;
      }
    }

    // Case 2: Added in one or both (not in base)
    if (!b) {
      if (o && t) {
        if (eq(o.props, t.props) && o.parentId === t.parentId) {
          mergedPropsById.set(id, structuredClone(o.props));
          chosenParentById.set(id, { parentId: o.parentId, containerKey: o.containerKey });
        } else {
          const conflictId = `node:${scopedId}:duplicate-add`;
          const choice = chooseResolution(conflictId, prefer, resolutions);
          conflicts.push({
            id: conflictId,
            kind: 'duplicate-add',
            scope: 'node',
            pageId,
            targetId: scopedId,
            field: '$node',
            baseValue: null,
            oursValue: o.props,
            theirsValue: t.props,
            reason: `双方同时新增了同名 ID 节点 "${scopedId}" 且内容或位置不同`,
            resolvedWith: choice,
          });
          const picked = choice === 'theirs' ? t : o;
          if (choice) resolutionLog.push({ conflictId, kind: 'duplicate-add', targetId: scopedId, chosen: choice });
          mergedPropsById.set(id, structuredClone(picked.props));
          chosenParentById.set(id, { parentId: picked.parentId, containerKey: picked.containerKey });
        }
      } else {
        const added = o || t;
        const addedSource = o ? 'ours' : 'theirs';
        // Check if parent was deleted on the other side
        if (added.parentId && baseMap.has(added.parentId) && ((o && !theirsMap.has(added.parentId)) || (t && !oursMap.has(added.parentId)))) {
          const conflictId = `node:${scopedId}:parent-deleted`;
          const choice = chooseResolution(conflictId, prefer, resolutions);
          conflicts.push({
            id: conflictId,
            kind: 'delete-modify',
            scope: 'node',
            pageId,
            targetId: scopedId,
            field: 'parentId',
            baseValue: added.parentId,
            oursValue: o ? added.parentId : null,
            theirsValue: t ? added.parentId : null,
            reason: `新增节点 "${scopedId}" 所在的父容器 "${added.parentId}" 在另一方已被删除`,
            resolvedWith: choice,
          });
          if (choice) resolutionLog.push({ conflictId, kind: 'delete-modify', targetId: scopedId, chosen: choice });
        }
        mergedPropsById.set(id, structuredClone(added.props));
        chosenParentById.set(id, { parentId: added.parentId, containerKey: added.containerKey });
        autoMergedChanges.push({
          kind: 'node-added',
          pageId,
          targetId: scopedId,
          source: addedSource,
        });
      }
      continue;
    }

    // Case 3: Present in base, ours, and theirs
    // 3a. Check parent reparenting
    const oursMovedParent = o.parentId !== b.parentId || o.containerKey !== b.containerKey;
    const theirsMovedParent = t.parentId !== b.parentId || t.containerKey !== b.containerKey;
    if (oursMovedParent && theirsMovedParent && (o.parentId !== t.parentId || o.containerKey !== t.containerKey)) {
      const conflictId = `node:${scopedId}:reparent`;
      const choice = chooseResolution(conflictId, prefer, resolutions);
      conflicts.push({
        id: conflictId,
        kind: 'reparent-conflict',
        scope: 'node',
        pageId,
        targetId: scopedId,
        field: 'parentId',
        baseValue: b.parentId,
        oursValue: o.parentId,
        theirsValue: t.parentId,
        reason: `节点 "${scopedId}" 被双方移动到不同父容器 (${o.parentId} vs ${t.parentId})`,
        resolvedWith: choice,
      });
      if (choice) resolutionLog.push({ conflictId, kind: 'reparent-conflict', targetId: scopedId, chosen: choice });
      const picked = choice === 'theirs' ? t : o;
      chosenParentById.set(id, { parentId: picked.parentId, containerKey: picked.containerKey });
    } else if (theirsMovedParent) {
      chosenParentById.set(id, { parentId: t.parentId, containerKey: t.containerKey });
    } else {
      chosenParentById.set(id, { parentId: o.parentId, containerKey: o.containerKey });
    }

    // 3b. Property diff & layout-coupled detection
    const propKeys = new Set([
      ...Object.keys(b.props),
      ...Object.keys(o.props),
      ...Object.keys(t.props),
    ]);
    const oursChanged = new Set();
    const theirsChanged = new Set();
    for (const k of propKeys) {
      if (!eq(o.props[k], b.props[k])) oursChanged.add(k);
      if (!eq(t.props[k], b.props[k])) theirsChanged.add(k);
    }

    // Check layout coupling across different fields on the SAME node
    const checkCoupledGroup = (groupSet, groupName, groupLabel) => {
      const oGroup = [...oursChanged].filter(k => groupSet.has(k));
      const tGroup = [...theirsChanged].filter(k => groupSet.has(k));
      if (oGroup.length === 0 || tGroup.length === 0) return null;
      // If they only changed the exact same field(s), same-field conflict handles it if values differ
      const differentFieldPairs = [];
      for (const ok of oGroup) {
        for (const tk of tGroup) {
          if (ok !== tk) differentFieldPairs.push([ok, tk]);
        }
      }
      if (differentFieldPairs.length === 0) return null;
      const conflictId = `node:${scopedId}:layout-coupled:${groupName}`;
      const choice = chooseResolution(conflictId, prefer, resolutions);
      const oursSubset = Object.fromEntries(oGroup.map(k => [k, o.props[k]]));
      const theirsSubset = Object.fromEntries(tGroup.map(k => [k, t.props[k]]));
      conflicts.push({
        id: conflictId,
        kind: 'layout-coupled',
        scope: 'node',
        pageId,
        targetId: scopedId,
        field: groupName,
        coupledFields: { ours: oGroup, theirs: tGroup },
        baseValue: Object.fromEntries([...new Set([...oGroup, ...tGroup])].map(k => [k, b.props[k]])),
        oursValue: oursSubset,
        theirsValue: theirsSubset,
        reason: `节点 "${scopedId}" 的${groupLabel}相关字段被并发修改 (${oGroup.join(',')} vs ${tGroup.join(',')})，存在布局耦合冲突`,
        resolvedWith: choice,
      });
      if (choice) resolutionLog.push({ conflictId, kind: 'layout-coupled', targetId: scopedId, chosen: choice });
      return { choice, oGroup, tGroup };
    };

    const horizCoupled = checkCoupledGroup(HORIZONTAL_LAYOUT_FIELDS, 'horizontal-layout', '水平定位/尺寸');
    const vertCoupled = checkCoupledGroup(VERTICAL_LAYOUT_FIELDS, 'vertical-layout', '垂直定位/尺寸');
    const contCoupled = checkCoupledGroup(CONTAINER_LAYOUT_FIELDS, 'container-layout', '容器流式/网格布局');

    // Also check parent-child layout coupling: if parent changed layout mode while child changed position/span
    const parentId = chosenParentById.get(id)?.parentId;
    if (parentId && baseMap.has(parentId) && oursMap.has(parentId) && theirsMap.has(parentId)) {
      const bParentLayout = baseMap.get(parentId).props.layout || 'stack';
      const oParentLayout = oursMap.get(parentId).props.layout || 'stack';
      const tParentLayout = theirsMap.get(parentId).props.layout || 'stack';
      const oursChangedParentLayout = oParentLayout !== bParentLayout;
      const theirsChangedParentLayout = tParentLayout !== bParentLayout;
      const childPosFields = ['x', 'y', 'right', 'bottom', 'colSpan', 'rowSpan', 'flex'];
      const oursChangedChildPos = childPosFields.filter(k => oursChanged.has(k));
      const theirsChangedChildPos = childPosFields.filter(k => theirsChanged.has(k));

      if ((oursChangedParentLayout && theirsChangedChildPos.length > 0) || (theirsChangedParentLayout && oursChangedChildPos.length > 0)) {
        const conflictId = `node:${scopedId}:parent-child-layout-coupled`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'parent-child-layout-coupled',
          scope: 'node',
          pageId,
          targetId: scopedId,
          parentId,
          field: 'layout-position',
          baseValue: { parentLayout: bParentLayout, child: Object.fromEntries(childPosFields.map(k => [k, b.props[k]]).filter(([, v]) => v !== undefined)) },
          oursValue: { parentLayout: oParentLayout, child: Object.fromEntries(oursChangedChildPos.map(k => [k, o.props[k]])) },
          theirsValue: { parentLayout: tParentLayout, child: Object.fromEntries(theirsChangedChildPos.map(k => [k, t.props[k]])) },
          reason: `父容器 "${parentId}" 切换了布局模式 (${oParentLayout} / ${tParentLayout})，同时子节点 "${scopedId}" 修改了坐标/跨度属性`,
          resolvedWith: choice,
        });
        if (choice) resolutionLog.push({ conflictId, kind: 'parent-child-layout-coupled', targetId: scopedId, chosen: choice });
      }
    }

    const mergedProps = structuredClone(o.props);
    for (const k of propKeys) {
      const oCh = oursChanged.has(k);
      const tCh = theirsChanged.has(k);
      if (!oCh && !tCh) continue;

      // If this field belongs to a coupled group that had a resolution choice, honor that group choice
      const coupledMatch = [horizCoupled, vertCoupled, contCoupled].find(
        c => c && (c.oGroup.includes(k) || c.tGroup.includes(k))
      );
      if (coupledMatch && coupledMatch.choice) {
        const srcProps = coupledMatch.choice === 'theirs' ? t.props : o.props;
        if (srcProps[k] === undefined) delete mergedProps[k];
        else mergedProps[k] = structuredClone(srcProps[k]);
        continue;
      }

      if (!oCh && tCh) {
        if (t.props[k] === undefined) delete mergedProps[k];
        else mergedProps[k] = structuredClone(t.props[k]);
        autoMergedChanges.push({
          kind: 'property-updated',
          pageId,
          targetId: scopedId,
          field: k,
          before: b.props[k],
          after: t.props[k],
          source: 'theirs',
        });
      } else if (oCh && !tCh) {
        autoMergedChanges.push({
          kind: 'property-updated',
          pageId,
          targetId: scopedId,
          field: k,
          before: b.props[k],
          after: o.props[k],
          source: 'ours',
        });
      } else if (oCh && tCh) {
        if (eq(o.props[k], t.props[k])) {
          // Both sides made the exact same edit
          continue;
        }
        const conflictId = `node:${scopedId}:${k}`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'same-field',
          scope: 'node',
          pageId,
          targetId: scopedId,
          field: k,
          baseValue: b.props[k],
          oursValue: o.props[k],
          theirsValue: t.props[k],
          reason: `节点 "${scopedId}" 的字段 "${k}" 被双方修改为不同值`,
          resolvedWith: choice,
        });
        if (choice) {
          resolutionLog.push({ conflictId, kind: 'same-field', targetId: scopedId, field: k, chosen: choice });
        }
        const pickedProps = choice === 'theirs' ? t.props : o.props;
        if (pickedProps[k] === undefined) delete mergedProps[k];
        else mergedProps[k] = structuredClone(pickedProps[k]);
      }
    }
    mergedPropsById.set(id, mergedProps);
  }

  // Each input can be a tree while concurrent reparenting creates a cycle.
  const checkedParents = new Set();
  for (const startId of mergedPropsById.keys()) {
    const path = [], positions = new Map();
    let id = startId;
    while (id && mergedPropsById.has(id) && !deletedNodes.has(id) && !checkedParents.has(id)) {
      if (positions.has(id)) {
        const cycle = path.slice(positions.get(id));
        conflicts.push({ id: `structure:${pageId}:cycle:${[...cycle].sort().join(',')}`, kind: 'structure-cycle',
          scope: 'page', pageId, targetId: id, field: 'parentId',
          baseValue: cycle.map(key => ({ id: key, parentId: baseMap.get(key)?.parentId })),
          oursValue: cycle.map(key => ({ id: key, parentId: oursMap.get(key)?.parentId })),
          theirsValue: cycle.map(key => ({ id: key, parentId: theirsMap.get(key)?.parentId })),
          reason: '并发移动组合后形成父子归属环；请调整其中一方的移动并重新预览，不能把不可达子树当作删除', resolvedWith: null });
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = chosenParentById.get(id)?.parentId;
    }
    for (const key of path) checkedParents.add(key);
  }

  // Reconstruct the merged node tree recursively
  function buildMergedNode(nodeId) {
    if (deletedNodes.has(nodeId)) return null;
    const props = mergedPropsById.get(nodeId);
    if (!props) return null;
    const b = baseMap.get(nodeId);
    const o = oursMap.get(nodeId);
    const t = theirsMap.get(nodeId);
    const scopedId = o?.scopedId || t?.scopedId || b?.scopedId || `${pageId}/${nodeId}`;

    // Retaining a container deleted on the other side retains its complete subtree.
    if (b && (!o || !t)) return structuredClone((o || t).rawNode);
    const out = structuredClone(props);

    // Collect children assigned to this parent under 'children'
    const baseChildren = (b?.childIds || []).filter(cid => {
      if (deletedNodes.has(cid)) return false;
      const cp = chosenParentById.get(cid);
      return !cp || (cp.parentId === nodeId && cp.containerKey === 'children');
    });
    const oursChildren = (o?.childIds || []).filter(cid => {
      const cp = chosenParentById.get(cid);
      return cp && cp.parentId === nodeId && cp.containerKey === 'children';
    });
    const theirsChildren = (t?.childIds || []).filter(cid => {
      const cp = chosenParentById.get(cid);
      return cp && cp.parentId === nodeId && cp.containerKey === 'children';
    });

    const ordRes = mergeChildIdOrder(baseChildren, oursChildren, theirsChildren, deletedNodes);
    if (ordRes.conflict) {
      const conflictId = `node:${scopedId}:children-order`;
      const choice = chooseResolution(conflictId, prefer, resolutions);
      conflicts.push({
        id: conflictId,
        kind: 'structure-order',
        scope: 'node',
        pageId,
        targetId: scopedId,
        field: 'children',
        baseValue: ordRes.baseOrder,
        oursValue: ordRes.oursOrder,
        theirsValue: ordRes.theirsOrder,
        reason: `容器 "${scopedId}" 的子节点顺序被双方重排为不同顺序`,
        resolvedWith: choice,
      });
      if (choice) resolutionLog.push({ conflictId, kind: 'structure-order', targetId: scopedId, chosen: choice });
      const chosenOrder = choice === 'theirs' ? ordRes.theirsOrder : ordRes.oursOrder;
      out.children = chosenOrder.map(buildMergedNode).filter(Boolean);
    } else if (ordRes.order.length > 0 || Array.isArray(o?.rawNode?.children) || Array.isArray(t?.rawNode?.children)) {
      out.children = ordRes.order.map(buildMergedNode).filter(Boolean);
    }

    // State wrappers have metadata and order of their own, in addition to root nodes.
    const oStates = o?.rawNode?.states || [];
    const tStates = t?.rawNode?.states || [];
    const bStates = b?.rawNode?.states || [];
    const options = { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog };
    if (o?.rawNode?.states || t?.rawNode?.states) {
      const states = new Map();
      for (const stId of new Set([...bStates, ...oStates, ...tStates].map(st => st.id))) {
        const bs = bStates.find(st => st.id === stId);
        const os = oStates.find(st => st.id === stId);
        const ts = tStates.find(st => st.id === stId);
        if (!os || !ts) {
          const survivor = os || ts;
          if (!survivor) continue;
          if (!bs) { states.set(stId, structuredClone(survivor)); continue; }
          if (eq(bs, survivor)) continue;
          const conflictId = `state:${scopedId}/${stId}:delete-modify`;
          const choice = chooseResolution(conflictId, prefer, resolutions);
          conflicts.push({ id: conflictId, kind: 'delete-modify', scope: 'state', pageId,
            targetId: `${scopedId}/${stId}`, field: '$state', baseValue: bs, oursValue: os || null, theirsValue: ts || null,
            reason: `状态 "${scopedId}/${stId}" 在一方被删除，另一方修改了状态元数据或内容`, resolvedWith: choice });
          if (choice) resolutionLog.push({ conflictId, kind: 'delete-modify', targetId: `${scopedId}/${stId}`, chosen: choice });
          const selected = choice === 'ours' ? os : choice === 'theirs' ? ts : null;
          if (selected) states.set(stId, structuredClone(selected));
          continue;
        }
        const metadata = st => { const { root, ...rest } = st || {}; return rest; };
        const mergedMetadata = mergeKeyedMap(`state:${scopedId}/${stId}`, metadata(bs), metadata(os), metadata(ts), options);
        const rootRef = entry => entry?.stateRoots.has(stId) ? { root: entry.stateRoots.get(stId) } : {};
        const refs = mergeKeyedMap(`state-root:${scopedId}/${stId}`, rootRef(b), rootRef(o), rootRef(t), options);
        const root = refs.root ? buildMergedNode(refs.root) : null;
        if (root) states.set(stId, { ...mergedMetadata, root });
      }
      const deletedStates = new Set(bStates.filter(st => !states.has(st.id)).map(st => st.id));
      const order = mergeChildIdOrder(bStates.map(st => st.id), oStates.map(st => st.id), tStates.map(st => st.id), deletedStates);
      let stateOrder = order.order;
      if (order.conflict) {
        const conflictId = `node:${scopedId}:states-order`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({ id: conflictId, kind: 'structure-order', scope: 'node', pageId, targetId: scopedId, field: 'states',
          baseValue: order.baseOrder, oursValue: order.oursOrder, theirsValue: order.theirsOrder,
          reason: `面板 "${scopedId}" 的状态顺序被双方重排为不同顺序`, resolvedWith: choice });
        if (choice) resolutionLog.push({ conflictId, kind: 'structure-order', targetId: scopedId, chosen: choice });
        stateOrder = choice === 'theirs' ? order.theirsOrder : order.oursOrder;
      }
      out.states = stateOrder.map(id => states.get(id)).filter(Boolean);
    }

    const templateRef = entry => entry?.templateId ? { template: entry.templateId } : {};
    const refs = mergeKeyedMap(`template-root:${scopedId}`, templateRef(b), templateRef(o), templateRef(t), options);
    const survivingTemplate = o?.templateId || t?.templateId;
    if (!refs.template && survivingTemplate === b?.templateId && !deletedNodes.has(survivingTemplate)) {
      refs.template = survivingTemplate;
    }
    if (refs.template && !deletedNodes.has(refs.template)) out.template = buildMergedNode(refs.template);

    return out;
  }

  const rootRef = node => node ? { root: `${pageId}/${node.id}` } : {};
  const refs = mergeKeyedMap(`page-root:${pageId}`, rootRef(baseRoot), rootRef(oursRoot), rootRef(theirsRoot),
    { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog });
  return refs.root ? buildMergedNode(refs.root) : null;
}

function mergeKeyedMap(scopeName, baseObj = {}, oursObj = {}, theirsObj = {}, { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }) {
  const keys = new Set([...Object.keys(baseObj), ...Object.keys(oursObj), ...Object.keys(theirsObj)]);
  const merged = {};
  for (const k of keys) {
    const inB = Object.hasOwn(baseObj, k);
    const inO = Object.hasOwn(oursObj, k);
    const inT = Object.hasOwn(theirsObj, k);
    const bv = baseObj[k];
    const ov = oursObj[k];
    const tv = theirsObj[k];

    if (inB && (!inO || !inT)) {
      if (!inO && !inT) continue;
      const deletedInOurs = !inO;
      const modifiedOnOther = deletedInOurs ? !eq(bv, tv) : !eq(bv, ov);
      if (modifiedOnOther) {
        const conflictId = `${scopeName}:${k}:delete-modify`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'delete-modify',
          scope: scopeName,
          targetId: k,
          field: k,
          baseValue: bv,
          oursValue: inO ? ov : undefined,
          theirsValue: inT ? tv : undefined,
          reason: `${scopeName} "${k}" 在一方被删除，在另一方被修改`,
          resolvedWith: choice,
        });
        if (choice) resolutionLog.push({ conflictId, kind: 'delete-modify', targetId: k, chosen: choice });
        if (choice === 'ours' && inO) merged[k] = structuredClone(ov);
        else if (choice === 'theirs' && inT) merged[k] = structuredClone(tv);
      }
      continue;
    }

    const oChanged = !eq(ov, bv);
    const tChanged = !eq(tv, bv);
    if (!oChanged && tChanged) {
      merged[k] = structuredClone(tv);
      autoMergedChanges.push({ kind: `${scopeName}-updated`, targetId: k, before: bv, after: tv, source: 'theirs' });
    } else if (oChanged && !tChanged) {
      merged[k] = structuredClone(ov);
      autoMergedChanges.push({ kind: `${scopeName}-updated`, targetId: k, before: bv, after: ov, source: 'ours' });
    } else if (oChanged && tChanged && !eq(ov, tv)) {
      const conflictId = `${scopeName}:${k}`;
      const choice = chooseResolution(conflictId, prefer, resolutions);
      conflicts.push({
        id: conflictId,
        kind: 'same-field',
        scope: scopeName,
        targetId: k,
        field: k,
        baseValue: bv,
        oursValue: ov,
        theirsValue: tv,
        reason: `${scopeName} "${k}" 被双方同时修改为不同值`,
        resolvedWith: choice,
      });
      if (choice) resolutionLog.push({ conflictId, kind: 'same-field', targetId: k, chosen: choice });
      merged[k] = structuredClone(choice === 'theirs' ? tv : ov);
    } else {
      merged[k] = structuredClone(ov);
    }
  }
  return merged;
}

export function mergeStudioDocuments({
  baseDoc,
  oursDoc,
  theirsDoc,
  prefer = 'fail',
  resolutions = {},
} = {}) {
  if (!baseDoc || !oursDoc || !theirsDoc) {
    throw mergeError('E_MERGE_ARGS', 'mergeStudioDocuments 需要 baseDoc、oursDoc 和 theirsDoc');
  }
  if (!['fail', 'ours', 'theirs'].includes(prefer)) {
    throw mergeError('E_MERGE_PREFER', 'prefer 必须是 fail、ours 或 theirs');
  }

  const conflicts = [];
  const autoMergedChanges = [];
  const resolutionLog = [];

  const mergedDoc = structuredClone(oursDoc);

  // 1. Top-level scalar metadata
  for (const field of ['name', 'domain', 'theme', 'device', 'target']) {
    const bv = baseDoc[field];
    const ov = oursDoc[field];
    const tv = theirsDoc[field];
    const oCh = !eq(ov, bv);
    const tCh = !eq(tv, bv);
    if (!oCh && tCh) {
      mergedDoc[field] = structuredClone(tv);
      autoMergedChanges.push({ kind: 'document-field', targetId: 'document', field, before: bv, after: tv, source: 'theirs' });
    } else if (oCh && tCh && !eq(ov, tv)) {
      const conflictId = `document:${field}`;
      const choice = chooseResolution(conflictId, prefer, resolutions);
      conflicts.push({
        id: conflictId,
        kind: 'same-field',
        scope: 'document',
        targetId: 'document',
        field,
        baseValue: bv,
        oursValue: ov,
        theirsValue: tv,
        reason: `文档级属性 "${field}" 被双方修改为不同值`,
        resolvedWith: choice,
      });
      if (choice) resolutionLog.push({ conflictId, kind: 'same-field', targetId: 'document', field, chosen: choice });
      mergedDoc[field] = structuredClone(choice === 'theirs' ? tv : ov);
    }
  }

  // 2. Palette & Tokens
  mergedDoc.palette = mergeKeyedMap(
    'palette',
    baseDoc.palette || {},
    oursDoc.palette || {},
    theirsDoc.palette || {},
    { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
  );
  mergedDoc.tokens = structuredClone(oursDoc.tokens || {});
  mergedDoc.tokens.colors = mergeKeyedMap(
    'token.colors',
    baseDoc.tokens?.colors || {},
    oursDoc.tokens?.colors || {},
    theirsDoc.tokens?.colors || {},
    { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
  );
  const scalarBaseTokens = Object.fromEntries(Object.entries(baseDoc.tokens || {}).filter(([k]) => k !== 'colors'));
  const scalarOursTokens = Object.fromEntries(Object.entries(oursDoc.tokens || {}).filter(([k]) => k !== 'colors'));
  const scalarTheirsTokens = Object.fromEntries(Object.entries(theirsDoc.tokens || {}).filter(([k]) => k !== 'colors'));
  const mergedScalarTokens = mergeKeyedMap(
    'token',
    scalarBaseTokens,
    scalarOursTokens,
    scalarTheirsTokens,
    { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
  );
  for (const k of Object.keys(mergedDoc.tokens)) {
    if (k !== 'colors') delete mergedDoc.tokens[k];
  }
  Object.assign(mergedDoc.tokens, mergedScalarTokens);

  // 3. Variables & Datasets
  mergedDoc.variables = mergeKeyedMap(
    'variable',
    baseDoc.variables || {},
    oursDoc.variables || {},
    theirsDoc.variables || {},
    { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
  );
  mergedDoc.datasets = mergeKeyedMap(
    'dataset',
    baseDoc.datasets || {},
    oursDoc.datasets || {},
    theirsDoc.datasets || {},
    { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
  );

  // 4. Components
  const allCompIds = new Set([
    ...Object.keys(baseDoc.components || {}),
    ...Object.keys(oursDoc.components || {}),
    ...Object.keys(theirsDoc.components || {}),
  ]);
  const mergedComponents = {};
  for (const compId of allCompIds) {
    const bc = baseDoc.components?.[compId];
    const oc = oursDoc.components?.[compId];
    const tc = theirsDoc.components?.[compId];
    if (bc && (!oc || !tc)) {
      if (!oc && !tc) continue;
      const deletedInOurs = !oc;
      const modifiedOnOther = deletedInOurs ? !eq(bc, tc) : !eq(bc, oc);
      if (modifiedOnOther) {
        const conflictId = `component:${compId}:delete-modify`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'delete-modify',
          scope: 'component',
          targetId: compId,
          field: '$component',
          baseValue: bc,
          oursValue: oc || null,
          theirsValue: tc || null,
          reason: `组件 "${compId}" 在一方被删除，在另一方被修改`,
          resolvedWith: choice,
        });
        if (choice) resolutionLog.push({ conflictId, kind: 'delete-modify', targetId: compId, chosen: choice });
        if (choice === 'ours' && oc) mergedComponents[compId] = structuredClone(oc);
        else if (choice === 'theirs' && tc) mergedComponents[compId] = structuredClone(tc);
      }
      continue;
    }
    if (!bc) {
      mergedComponents[compId] = structuredClone(tc && !oc ? tc : oc);
      continue;
    }
    if (eq(oc, tc) || eq(tc, bc)) {
      mergedComponents[compId] = structuredClone(oc);
    } else if (eq(oc, bc)) {
      mergedComponents[compId] = structuredClone(tc);
      autoMergedChanges.push({ kind: 'component-updated', targetId: compId, source: 'theirs' });
    } else {
      const mergedRoot = mergePageTree(
        `component:${compId}`,
        bc.root,
        oc.root,
        tc.root,
        { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
      );
      mergedComponents[compId] = {
        ...structuredClone(oc),
        contractVersion: tc.contractVersion !== bc.contractVersion ? tc.contractVersion : oc.contractVersion,
        params: mergeKeyedMap(
          `component.${compId}.params`,
          bc.params || {},
          oc.params || {},
          tc.params || {},
          { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
        ),
        variants: mergeKeyedMap(
          `component.${compId}.variants`,
          bc.variants || {},
          oc.variants || {},
          tc.variants || {},
          { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
        ),
        root: mergedRoot,
      };
    }
  }
  mergedDoc.components = mergedComponents;

  // 5. Pages & Node Trees
  const basePagesById = new Map((baseDoc.pages || []).map(p => [p.id, p]));
  const oursPagesById = new Map((oursDoc.pages || []).map(p => [p.id, p]));
  const theirsPagesById = new Map((theirsDoc.pages || []).map(p => [p.id, p]));
  const allPageIds = new Set([...basePagesById.keys(), ...oursPagesById.keys(), ...theirsPagesById.keys()]);
  const deletedPageIds = new Set();
  const mergedPagesById = new Map();

  for (const pageId of allPageIds) {
    const bp = basePagesById.get(pageId);
    const op = oursPagesById.get(pageId);
    const tp = theirsPagesById.get(pageId);

    if (bp && (!op || !tp)) {
      if (!op && !tp) {
        deletedPageIds.add(pageId);
        continue;
      }
      const deletedInOurs = !op;
      const modifiedOnOther = deletedInOurs ? !eq(bp, tp) : !eq(bp, op);
      if (modifiedOnOther) {
        const conflictId = `page:${pageId}:delete-modify`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'delete-modify',
          scope: 'page',
          pageId,
          targetId: pageId,
          field: '$page',
          baseValue: { id: bp.id, name: bp.name },
          oursValue: op ? { id: op.id, name: op.name } : null,
          theirsValue: tp ? { id: tp.id, name: tp.name } : null,
          reason: `页面 "${pageId}" 在一方被删除，在另一方被修改`,
          resolvedWith: choice,
        });
        if (choice) resolutionLog.push({ conflictId, kind: 'delete-modify', targetId: pageId, chosen: choice });
        const keep = (choice === 'ours' && op) || (choice === 'theirs' && tp);
        if (!keep) {
          deletedPageIds.add(pageId);
          continue;
        }
        mergedPagesById.set(pageId, structuredClone(op || tp));
      } else {
        deletedPageIds.add(pageId);
        autoMergedChanges.push({ kind: 'page-deleted', pageId, targetId: pageId, source: deletedInOurs ? 'ours' : 'theirs' });
      }
      continue;
    }

    if (!bp) {
      const added = op || tp;
      mergedPagesById.set(pageId, structuredClone(added));
      autoMergedChanges.push({ kind: 'page-added', pageId, targetId: pageId, source: op ? 'ours' : 'theirs' });
      continue;
    }

    // Merge page metadata (name, canvas, domain, device)
    const mergedPage = structuredClone(op);
    for (const pf of ['name', 'domain', 'device', 'canvas']) {
      const oCh = !eq(op[pf], bp[pf]);
      const tCh = !eq(tp[pf], bp[pf]);
      if (!oCh && tCh) {
        mergedPage[pf] = structuredClone(tp[pf]);
      } else if (oCh && tCh && !eq(op[pf], tp[pf])) {
        const conflictId = `page:${pageId}:${pf}`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'same-field',
          scope: 'page',
          pageId,
          targetId: pageId,
          field: pf,
          baseValue: bp[pf],
          oursValue: op[pf],
          theirsValue: tp[pf],
          reason: `页面 "${pageId}" 的属性 "${pf}" 被双方修改为不同值`,
          resolvedWith: choice,
        });
        if (choice) resolutionLog.push({ conflictId, kind: 'same-field', targetId: pageId, field: pf, chosen: choice });
        mergedPage[pf] = structuredClone(choice === 'theirs' ? tp[pf] : op[pf]);
      }
    }

    mergedPage.root = mergePageTree(
      pageId,
      bp.root,
      op.root,
      tp.root,
      { prefer, resolutions, conflicts, autoMergedChanges, resolutionLog }
    );
    mergedPagesById.set(pageId, mergedPage);
  }

  const pageOrderRes = mergeChildIdOrder(
    (baseDoc.pages || []).map(p => p.id),
    (oursDoc.pages || []).map(p => p.id),
    (theirsDoc.pages || []).map(p => p.id),
    deletedPageIds
  );
  if (pageOrderRes.conflict) {
    const conflictId = 'pages:order';
    const choice = chooseResolution(conflictId, prefer, resolutions);
    conflicts.push({
      id: conflictId,
      kind: 'structure-order',
      scope: 'pages',
      targetId: 'pages',
      field: 'order',
      baseValue: pageOrderRes.baseOrder,
      oursValue: pageOrderRes.oursOrder,
      theirsValue: pageOrderRes.theirsOrder,
      reason: '页面顺序被双方同时重排为不同顺序',
      resolvedWith: choice,
    });
    if (choice) resolutionLog.push({ conflictId, kind: 'structure-order', targetId: 'pages', chosen: choice });
    const chosenOrder = choice === 'theirs' ? pageOrderRes.theirsOrder : pageOrderRes.oursOrder;
    mergedDoc.pages = chosenOrder.map(id => mergedPagesById.get(id)).filter(Boolean);
  } else {
    mergedDoc.pages = pageOrderRes.order.map(id => mergedPagesById.get(id)).filter(Boolean);
  }

  // 6. Design Decisions
  const baseDecs = new Map((baseDoc.designDecisions || []).map(d => [d.id, d]));
  const oursDecs = new Map((oursDoc.designDecisions || []).map(d => [d.id, d]));
  const theirsDecs = new Map((theirsDoc.designDecisions || []).map(d => [d.id, d]));
  const allDecIds = [...new Set([...baseDecs.keys(), ...oursDecs.keys(), ...theirsDecs.keys()])];
  const mergedDecisions = [];
  for (const id of allDecIds) {
    const od = oursDecs.get(id);
    const td = theirsDecs.get(id);
    if (od && !td && !baseDecs.has(id)) mergedDecisions.push(structuredClone(od));
    else if (td && !od && !baseDecs.has(id)) {
      mergedDecisions.push(structuredClone(td));
      autoMergedChanges.push({ kind: 'design-decision-added', targetId: id, source: 'theirs' });
    } else if (od && td) {
      mergedDecisions.push(structuredClone(od));
    }
  }
  if (baseDoc.designDecisions || oursDoc.designDecisions || theirsDoc.designDecisions) {
    mergedDoc.designDecisions = mergedDecisions;
  }

  // 7. Cross-Entity Reference & Component-Instance Coupling Check on the merged result
  const closure = computeDependencyClosure(mergedDoc);
  const baseClosure = computeDependencyClosure(baseDoc);
  for (const unresolvedTok of closure.tokens.unresolved) {
    const wasDeclaredInBase = Object.hasOwn(baseDoc.palette || {}, unresolvedTok.name)
      || Object.hasOwn(baseDoc.tokens?.colors || {}, unresolvedTok.name)
      || Object.hasOwn(baseDoc.tokens || {}, unresolvedTok.name);
    const conflictId = `ref:token:${unresolvedTok.name}`;
    const choice = chooseResolution(conflictId, prefer, resolutions);
    conflicts.push({
      id: conflictId,
      kind: 'reference-coupled',
      scope: 'token',
      targetId: `$${unresolvedTok.name}`,
      field: unresolvedTok.name,
      consumers: unresolvedTok.consumers,
      baseValue: wasDeclaredInBase ? (baseDoc.tokens?.[unresolvedTok.name] ?? baseDoc.tokens?.colors?.[unresolvedTok.name] ?? baseDoc.palette?.[unresolvedTok.name]) : undefined,
      oursValue: oursDoc.tokens?.[unresolvedTok.name] ?? oursDoc.tokens?.colors?.[unresolvedTok.name] ?? oursDoc.palette?.[unresolvedTok.name],
      theirsValue: theirsDoc.tokens?.[unresolvedTok.name] ?? theirsDoc.tokens?.colors?.[unresolvedTok.name] ?? theirsDoc.palette?.[unresolvedTok.name],
      reason: `令牌 "$${unresolvedTok.name}" 被节点 (${unresolvedTok.consumers.join(', ')}) 引用，但在合并结果中未定义或已被另一方删除`,
      resolvedWith: choice,
    });
    if (choice) {
      resolutionLog.push({ conflictId, kind: 'reference-coupled', targetId: `$${unresolvedTok.name}`, chosen: choice });
      const donor = choice === 'theirs' ? theirsDoc : oursDoc;
      const val = donor.tokens?.[unresolvedTok.name] ?? donor.tokens?.colors?.[unresolvedTok.name] ?? donor.palette?.[unresolvedTok.name]
        ?? baseDoc.tokens?.[unresolvedTok.name] ?? baseDoc.tokens?.colors?.[unresolvedTok.name] ?? baseDoc.palette?.[unresolvedTok.name];
      if (val !== undefined) {
        if (typeof val === 'string' && val.startsWith('#')) {
          mergedDoc.palette[unresolvedTok.name] = val;
          mergedDoc.tokens.colors[unresolvedTok.name] = val;
        } else {
          mergedDoc.tokens[unresolvedTok.name] = val;
        }
      }
    }
  }

  for (const missingComp of closure.components.missing) {
    const conflictId = `ref:component:${missingComp.componentId}`;
    const choice = chooseResolution(conflictId, prefer, resolutions);
    conflicts.push({
      id: conflictId,
      kind: 'component-instance-coupled',
      scope: 'component',
      targetId: missingComp.componentId,
      consumers: missingComp.instances,
      baseValue: baseDoc.components?.[missingComp.componentId] || null,
      oursValue: oursDoc.components?.[missingComp.componentId] || null,
      theirsValue: theirsDoc.components?.[missingComp.componentId] || null,
      reason: `组件 "${missingComp.componentId}" 在一方被删除，但另一方仍有实例 (${missingComp.instances.join(', ')}) 引用它`,
      resolvedWith: choice,
    });
    if (choice) {
      resolutionLog.push({ conflictId, kind: 'component-instance-coupled', targetId: missingComp.componentId, chosen: choice });
      const donorComp = oursDoc.components?.[missingComp.componentId] || theirsDoc.components?.[missingComp.componentId] || baseDoc.components?.[missingComp.componentId];
      if (donorComp) mergedDoc.components[missingComp.componentId] = structuredClone(donorComp);
    }
  }

  // Also check if any component subnode referenced by an instance override was deleted on the other side
  const mergedIndex = buildNodeIndex(mergedDoc);
  for (const entry of new Set(mergedIndex.byScopedId.values())) {
    const node = entry.node;
    if ((node.type === 'instance' || node.component) && node.overrides && typeof node.overrides === 'object') {
      const compDef = mergedDoc.components?.[node.component];
      if (!compDef?.root) continue;
      const compSubIds = new Set();
      const collectIds = n => {
        if (!n || typeof n !== 'object') return;
        if (n.id) compSubIds.add(n.id);
        for (const ch of n.children || []) collectIds(ch);
      };
      collectIds(compDef.root);
      for (const subKey of Object.keys(node.overrides)) {
        if (subKey === '$root' || subKey === '_self') continue;
        const targetSubId = subKey.split('/')[0];
        if (!compSubIds.has(targetSubId)) {
          const conflictId = `ref:component-override:${entry.scopedId}:${targetSubId}`;
          const choice = chooseResolution(conflictId, prefer, resolutions);
          conflicts.push({
            id: conflictId,
            kind: 'component-instance-coupled',
            scope: 'instance-override',
            targetId: entry.scopedId,
            field: subKey,
            baseValue: baseDoc.components?.[node.component] || null,
            oursValue: oursDoc.components?.[node.component] || null,
            theirsValue: theirsDoc.components?.[node.component] || null,
            reason: `组件实例 "${entry.scopedId}" 覆盖了子图层 "${targetSubId}"，但组件 "${node.component}" 定义中该子图层已被另一方移除`,
            resolvedWith: choice,
          });
          if (choice) {
            resolutionLog.push({ conflictId, kind: 'component-instance-coupled', targetId: entry.scopedId, field: subKey, chosen: choice });
            if (choice === 'theirs' && !theirsDoc.components?.[node.component]) {
              delete node.overrides[subKey];
            } else {
              delete node.overrides[subKey];
            }
          }
        }
      }
      // Also check if one side modified the component definition while the other side modified instance overrides
      const baseComp = baseDoc.components?.[node.component];
      const oursComp = oursDoc.components?.[node.component];
      const theirsComp = theirsDoc.components?.[node.component];
      const baseInst = buildNodeIndex(baseDoc).byScopedId.get(entry.scopedId)?.node;
      const oursInst = buildNodeIndex(oursDoc).byScopedId.get(entry.scopedId)?.node;
      const theirsInst = buildNodeIndex(theirsDoc).byScopedId.get(entry.scopedId)?.node;
      const oursCompChanged = baseComp && oursComp && !eq(oursComp, baseComp);
      const theirsCompChanged = baseComp && theirsComp && !eq(theirsComp, baseComp);
      const oursOvrChanged = oursInst && !eq(oursInst.overrides || {}, baseInst?.overrides || {});
      const theirsOvrChanged = theirsInst && !eq(theirsInst.overrides || {}, baseInst?.overrides || {});
      if ((oursCompChanged && theirsOvrChanged) || (theirsCompChanged && oursOvrChanged)) {
        const conflictId = `ref:component-override-coupled:${entry.scopedId}`;
        const choice = chooseResolution(conflictId, prefer, resolutions);
        conflicts.push({
          id: conflictId,
          kind: 'component-instance-coupled',
          scope: 'instance-override',
          targetId: entry.scopedId,
          field: 'overrides',
          baseValue: { component: baseComp, overrides: baseInst?.overrides || {} },
          oursValue: { component: oursComp, overrides: oursInst?.overrides || {} },
          theirsValue: { component: theirsComp, overrides: theirsInst?.overrides || {} },
          reason: `组件 "${node.component}" 定义与实例 "${entry.scopedId}" 的 overrides 被双方并发修改`,
          resolvedWith: choice,
        });
        if (choice) {
          resolutionLog.push({ conflictId, kind: 'component-instance-coupled', targetId: entry.scopedId, field: 'overrides', chosen: choice });
        }
      }
    }
  }

  // Merge assetsManifest
  mergedDoc.assetsManifest = {
    ...(baseDoc.assetsManifest || {}),
    ...(theirsDoc.assetsManifest || {}),
    ...(oursDoc.assetsManifest || {}),
  };

  normalizeStudioDocument(mergedDoc);

  const unresolvedConflicts = conflicts.filter(c => !c.resolvedWith);
  const oursDiff = diffDocuments(baseDoc, oursDoc);
  const theirsDiff = diffDocuments(baseDoc, theirsDoc);
  for (const c of conflicts) {
    if (!c.type && c.kind) c.type = c.kind;
    if (!c.kind && c.type) c.kind = c.type;
  }

  const previewPayload = {
    baseContentHash: baseDoc.contentHash,
    oursContentHash: oursDoc.contentHash,
    theirsContentHash: theirsDoc.contentHash,
    mergedContentHash: mergedDoc.contentHash,
    conflicts: conflicts.map(c => ({ id: c.id, kind: c.kind, targetId: c.targetId, field: c.field, resolvedWith: c.resolvedWith || null })),
  };
  const previewHash = sha256(canonicalJson(previewPayload));

  return {
    ok: unresolvedConflicts.length === 0,
    canAutoMerge: conflicts.length === 0,
    canAutoApply: unresolvedConflicts.length === 0,
    unresolvedConflictCount: unresolvedConflicts.length,
    unresolvedCount: unresolvedConflicts.length,
    totalConflictCount: conflicts.length,
    conflictCount: conflicts.length,
    previewHash,
    baseRevision: baseDoc.revision,
    oursRevision: oursDoc.revision,
    theirsRevision: theirsDoc.revision,
    baseContentHash: baseDoc.contentHash,
    oursContentHash: oursDoc.contentHash,
    theirsContentHash: theirsDoc.contentHash,
    mergedContentHash: mergedDoc.contentHash,
    oursDiffSummary: { total: oursDiff.total, changes: oursDiff.changes.slice(0, 24) },
    theirsDiffSummary: { total: theirsDiff.total, changes: theirsDiff.changes.slice(0, 24) },
    autoMergedChanges,
    conflicts,
    resolutionLog,
    mergedDocument: mergedDoc,
    mergedDoc,
  };
}

export function executeStudioMerge({
  store,
  persistence = null,
  projectDir = null,
  mode = 'preview',
  baseRevision = null,
  expectedOursRevision = null,
  baseDoc: explicitBaseDoc = null,
  theirsDoc: explicitTheirsDoc = null,
  theirsCommands = null,
  theirsRp1 = null,
  theirsPageId = null,
  theirsSourceMode = null,
  theirsParentId = null,
  externalSourcePath = null,
  prefer = 'fail',
  resolutions = {},
  previewHash = null,
  idempotencyKey = null,
  simulateCrashStage = null,
} = {}) {
  if (!store) throw mergeError('E_MERGE_STORE_REQUIRED', 'executeStudioMerge 需要有效的 StudioDocumentStore');
  if (!['preview', 'apply'].includes(mode)) {
    throw mergeError('E_MERGE_MODE', 'mode 必须是 preview 或 apply');
  }

  const sourceIdentity = { kind: 'studio-merge', baseRevision,
    baseDoc: explicitBaseDoc, theirsDoc: explicitTheirsDoc, theirsCommands, theirsRp1,
    theirsPageId, theirsSourceMode, theirsParentId, externalSourcePath, prefer, resolutions };

  if (mode === 'apply') {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw mergeError('E_IDEMPOTENCY_KEY_REQUIRED', 'apply 模式必须提供 idempotencyKey');
    }
    const replay = store.getIdempotentResult({ idempotencyKey, sourceIdentity });
    if (replay) return replay.ok ? { ...replay, applied: true, mode: 'apply' } : replay;
    if (expectedOursRevision !== null && expectedOursRevision !== undefined && Number(expectedOursRevision) !== store.appliedRevision) {
      throw mergeError(
        'E_REVISION_CONFLICT',
        `合并应用失败：当前文档版本 (${store.appliedRevision}) 与预期版本 (${expectedOursRevision}) 不一致，请先重新预览`,
        { currentRevision: store.appliedRevision, expectedOursRevision }
      );
    }
  }

  const oursDoc = structuredClone(store.doc);

  // Resolve baseDoc from explicitBaseDoc, persistence snapshot at baseRevision, or store history
  let baseDoc = explicitBaseDoc ? structuredClone(explicitBaseDoc) : null;
  if (!baseDoc && baseRevision !== null && baseRevision !== undefined) {
    const revNum = Number(baseRevision);
    if (revNum === oursDoc.revision) {
      baseDoc = structuredClone(oursDoc);
    } else if (store.snapshots?.has(revNum)) {
      baseDoc = store.getSnapshot(revNum);
    } else if (persistence) {
      const snapPath = resolve(persistence.snapshotsDir, `rev-${revNum}.json`);
      if (existsSync(snapPath)) {
        baseDoc = JSON.parse(readFileSync(snapPath, 'utf8'));
      }
    }
    if (!baseDoc) {
      const histEntry = (store.history || []).find(h => h.beforeSnapshot?.revision === revNum || h.baseRevision === revNum);
      if (histEntry?.beforeSnapshot) baseDoc = structuredClone(histEntry.beforeSnapshot);
    }
    if (!baseDoc) {
      throw mergeError('E_MERGE_BASE_NOT_FOUND', `无法找到基准版本 rev ${revNum} 的快照`, { baseRevision: revNum });
    }
  }
  if (!baseDoc) {
    baseDoc = structuredClone(oursDoc);
  }

  // Resolve theirsDoc from explicitTheirsDoc, theirsCommands applied to baseDoc, or externalSourcePath
  let theirsDoc = explicitTheirsDoc ? structuredClone(explicitTheirsDoc) : null;
  let externalSourceInfo = null;
  if (!theirsDoc && Array.isArray(theirsCommands)) {
    const tempStore = new StudioDocumentStore(structuredClone(baseDoc));
    const txRes = tempStore.applyTransaction({
      baseRevision: tempStore.appliedRevision,
      idempotencyKey: `merge-theirs-sim-${Date.now()}`,
      commands: theirsCommands,
    });
    if (!txRes.ok) {
      throw mergeError(
        txRes.code || 'E_MERGE_THEIRS_COMMANDS_INVALID',
        `拟合并的命令在基准版本 rev ${baseDoc.revision} 上验证失败: ${txRes.message}`,
        { commandFailure: txRes }
      );
    }
    theirsDoc = structuredClone(tempStore.doc);
  } else if (!theirsDoc && typeof theirsRp1 === 'string') {
    const prepared = prepareRp1Commands({
      doc: baseDoc,
      source: theirsRp1,
      mode: theirsSourceMode || 'update',
      pageId: theirsPageId || baseDoc.pages?.[0]?.id || 'home',
      parentId: theirsParentId || undefined,
    });
    const tempStore = new StudioDocumentStore(structuredClone(baseDoc));
    const txRes = tempStore.applyTransaction({
      baseRevision: tempStore.appliedRevision,
      idempotencyKey: `merge-theirs-rp1-${Date.now()}`,
      commands: prepared.commands,
    });
    if (!txRes.ok) {
      throw mergeError(
        txRes.code || 'E_MERGE_THEIRS_COMMANDS_INVALID',
        `拟合并的 RP/1 在基准版本 rev ${baseDoc.revision} 上验证失败: ${txRes.message}`,
        { commandFailure: txRes }
      );
    }
    theirsDoc = structuredClone(tempStore.doc);
  } else if (!theirsDoc && externalSourcePath) {
    const absExt = resolve(externalSourcePath);
    if (!existsSync(absExt)) {
      throw mergeError('E_EXTERNAL_SOURCE_MISSING', `外部源文件不存在: ${absExt}`, { externalSourcePath: absExt });
    }
    const extBuf = readFileSync(absExt);
    const extSha = sha256(extBuf);
    if (absExt.endsWith('.rp1')) {
      const rp1Text = extBuf.toString('utf8');
      const prepared = prepareRp1Commands({
        doc: baseDoc,
        source: rp1Text,
        mode: theirsSourceMode || 'update',
        pageId: theirsPageId || baseDoc.pages?.[0]?.id || 'home',
        parentId: theirsParentId || undefined,
      });
      const tempStore = new StudioDocumentStore(structuredClone(baseDoc));
      const txRes = tempStore.applyTransaction({
        baseRevision: tempStore.appliedRevision,
        idempotencyKey: `merge-ext-rp1-${Date.now()}`,
        commands: prepared.commands,
      });
      if (!txRes.ok) {
        throw mergeError(
          txRes.code || 'E_MERGE_THEIRS_COMMANDS_INVALID',
          `外部 RP/1 在基准版本 rev ${baseDoc.revision} 上验证失败: ${txRes.message}`,
          { commandFailure: txRes }
        );
      }
      theirsDoc = structuredClone(tempStore.doc);
    } else {
      theirsDoc = importToStudioDocument(absExt, {
        projectDir: projectDir || persistence?.projectDir || null,
        documentId: oursDoc.documentId,
      });
    }
    externalSourceInfo = {
      path: absExt,
      sha256: extSha,
      bytes: extBuf.length,
    };
  }

  if (!theirsDoc) {
    throw mergeError('E_MERGE_THEIRS_REQUIRED', '必须提供 theirsDoc、theirsCommands 或 externalSourcePath');
  }

  const mergeResult = mergeStudioDocuments({
    baseDoc,
    oursDoc,
    theirsDoc,
    prefer,
    resolutions,
  });

  if (mode === 'preview') {
    const { mergedDocument, mergedDoc: _m, ...previewOut } = mergeResult;
    return {
      ...previewOut,
      mode: 'preview',
      externalSource: externalSourceInfo,
    };
  }

  if (previewHash && previewHash !== mergeResult.previewHash) {
    throw mergeError(
      'E_MERGE_PREVIEW_MISMATCH',
      '当前三方合并预览指纹与请求 previewHash 不一致，文档或外部源已发生变化，请重新 preview',
      { expectedPreviewHash: previewHash, actualPreviewHash: mergeResult.previewHash }
    );
  }

  if (!mergeResult.ok) {
    return {
      ok: false,
      applied: false,
      mode: 'apply',
      code: 'E_MERGE_CONFLICT',
      message: `存在 ${mergeResult.unresolvedConflictCount} 处未解决的合并冲突，未覆盖当前权威源`,
      previewHash: mergeResult.previewHash,
      conflicts: mergeResult.conflicts,
      autoMergedChanges: mergeResult.autoMergedChanges,
      externalSource: externalSourceInfo,
    };
  }

  const mergedSnapshot = structuredClone(mergeResult.mergedDocument);
  const expectedContentHash = computeContentHash(mergedSnapshot);
  mergedSnapshot.contentHash = expectedContentHash;
  const mergeVersionId = `merge_${mergeResult.previewHash.slice(0, 12)}`;
  const restorePreviewHash = sha256(
    canonicalJson({
      current: computeContentHash(store.doc),
      version: mergeVersionId,
      target: sha256(canonicalJson(mergedSnapshot)),
    })
  );

  const buildFinalOut = txRes => ({
    ok: true,
    applied: true,
    mode: 'apply',
    appliedRevision: store.appliedRevision,
    durableRevision: store.durableRevision,
    contentHash: store.doc.contentHash,
    previewHash: mergeResult.previewHash,
    autoMergedChanges: mergeResult.autoMergedChanges,
    conflicts: mergeResult.conflicts,
    resolutionLog: mergeResult.resolutionLog,
    externalSource: externalSourceInfo,
    doc: store.doc,
    scene: txRes.scene,
    ...(txRes.persistenceWarning ? { persistenceWarning: txRes.persistenceWarning } : {}),
  });

  const applyMerge = beforeCommit => {
    const res = store.applyTransaction({
      baseRevision: store.appliedRevision,
      idempotencyKey,
      sourceIdentity,
      clientId: 'studio-merge',
      source: 'studio-merge',
      label: externalSourceInfo ? '合并外部源文件更新' : '并发三方安全合并',
      commands: [
        {
          type: 'restoreDocument',
          versionId: mergeVersionId,
          expectedContentHash,
          previewHash: restorePreviewHash,
          document: mergedSnapshot,
        },
      ],
    }, { beforeCommit });
    if (res.ok) {
      const record = store.idempotencyMap.get(idempotencyKey);
      if (record) {
        const { doc, scene, ...receipt } = buildFinalOut(res);
        record.result = { ...record.result, ...receipt, durableRevision: store.durableRevision };
      }
    }
    return res;
  };

  let txResult;
  if (persistence && typeof persistence.commit === 'function') {
    txResult = persistence.commit(store, applyMerge, { simulateCrashStage });
  } else {
    txResult = applyMerge();
    if (txResult.ok && persistence) {
      if (typeof persistence.persistTransaction === 'function' && store.lastHistoryRecord) {
        persistence.persistTransaction(store, store.lastHistoryRecord);
      } else if (typeof persistence.saveFullSnapshot === 'function') {
        persistence.saveFullSnapshot(store.doc);
      }
    }
  }

  if (!txResult.ok) return txResult;
  const finalOut = buildFinalOut(txResult);
  const record = store.idempotencyMap.get(idempotencyKey);
  if (record) record.result.durableRevision = store.durableRevision;
  return finalOut;
}

export function checkExternalSourceChange({
  store,
  persistence = null,
  projectDir = null,
  externalSourcePath,
  baseRevision = 1,
  theirsPageId = null,
  theirsSourceMode = null,
  theirsParentId = null,
} = {}) {
  const preview = executeStudioMerge({
    store,
    persistence,
    projectDir,
    mode: 'preview',
    baseRevision,
    externalSourcePath,
    theirsPageId,
    theirsSourceMode,
    theirsParentId,
    prefer: 'fail',
  });
  return {
    ok: true,
    advisoryOnly: true,
    authorityModified: false,
    authorityPreserved: true,
    changed: preview.theirsContentHash !== preview.oursContentHash,
    externalSource: preview.externalSource,
    canAutoMerge: preview.canAutoMerge,
    canAutoApply: preview.canAutoApply,
    conflictCount: preview.totalConflictCount,
    previewHash: preview.previewHash,
    preview,
  };
}
