// 组件命令 case(createComponent/registerCoreComponents/upsert-component/evolveComponentContract/
// updateComponent/createInstance/setInstanceOverride/clearInstanceOverride/setInstanceVariant/detachInstance)。
// 从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import {
  CORE_COMPONENT_CONTRACTS,
  ensureCoreComponentsRegistered,
  getComponentContracts,
  validateComponentInstanceAgainstContract,
  evolveComponentContractOnDocument,
} from '../../component-contracts.mjs';
import { buildNodeIndex } from '../../document.mjs';
import { assertKnownNodeEffects } from '../../node-capabilities.mjs';
import { resolveDocumentScene } from '../../scene-resolver.mjs';
import { cmdError, validatePropertiesObject, resolveTargetOrSubnode, defineRecordEntry } from '../helpers.mjs';

function createComponent({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const compId = cmd.componentId || cmd.id;
      let rootNode = cmd.root ? structuredClone(cmd.root) : null;
      let srcEntry = null;
      if (!rootNode && cmd.nodeId) {
        const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
        srcEntry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
        rootNode = structuredClone(srcEntry.node);
      }
      if (!compId || !rootNode) {
        throw cmdError('E_INVALID_COMPONENT', `createComponent 需要 componentId 与 root (或 nodeId)`, { commandIndex: cmdIdx, field: 'componentId' });
      }
      doc.components = doc.components || {};
      defineRecordEntry(doc.components ||= {}, compId, {
        id: compId,
        name: cmd.name || compId,
        params: structuredClone(cmd.params || {}),
        variants: structuredClone(cmd.variants || {}),
        defaultVariant: cmd.defaultVariant || 'default',
        root: rootNode,
      });
      if (srcEntry && cmd.replaceWithInstance && srcEntry.parent && Array.isArray(srcEntry.parent.children)) {
        const srcNode = srcEntry.node;
        const pos = srcEntry.parent.children.indexOf(srcNode);
        if (pos >= 0) {
          srcEntry.parent.children[pos] = {
            type: 'instance',
            id: srcNode.id,
            name: srcNode.name || srcNode.id,
            component: compId,
            variant: cmd.defaultVariant || 'default',
            overrides: {},
            ...(srcNode.x !== undefined ? { x: srcNode.x } : {}),
            ...(srcNode.y !== undefined ? { y: srcNode.y } : {}),
            ...(srcNode.w !== undefined ? { w: srcNode.w } : {}),
            ...(srcNode.h !== undefined ? { h: srcNode.h } : {}),
          };
          affectedIds.push(srcEntry.scopedId);
        }
      }
      affectedIds.push(`component:${compId}`);
}

function registerCoreComponents({ doc, cmd, affectedIds }) {
      const regIds = ensureCoreComponentsRegistered(doc, cmd.componentIds || null);
      for (const cid of regIds) affectedIds.push(`component:${cid}`);
}

function upsertComponent({ doc, cmd, cmdIdx, affectedIds }) {
      const compId = cmd.componentId || cmd.id || cmd.component?.id;
      if (!compId || !cmd.component) {
        throw cmdError('E_INVALID_COMPONENT', `upsert-component 需要提供 componentId 与 component 定义`, { commandIndex: cmdIdx, field: 'componentId' });
      }
      doc.components = doc.components || {};
      defineRecordEntry(doc.components, compId, structuredClone(cmd.component));
      doc.components[compId].id = compId;
      affectedIds.push(`component:${compId}`);
}

function evolveComponentContract({ doc, cmd, cmdIdx, contractEvolutionResults, affectedIds }) {
      const compId = cmd.componentId || cmd.id;
      if (!compId) {
        throw cmdError('E_INVALID_COMPONENT', `evolveComponentContract 需要提供 componentId`, { commandIndex: cmdIdx, field: 'componentId' });
      }
      const evoRes = evolveComponentContractOnDocument(doc, {
        componentId: compId,
        newVersion: cmd.newVersion || cmd.version || '2.0.0',
        addedParameters: cmd.addedParameters || cmd.addedParams || {},
        renamedParameters: cmd.renamedParameters || cmd.renamedParams || {},
        removedParameters: cmd.removedParameters || cmd.removedParams || [],
        rootPatch: cmd.rootPatch || null,
      });
      if (Array.isArray(contractEvolutionResults)) {
        contractEvolutionResults.push(evoRes);
      }
      affectedIds.push(`component:${compId}`);
}

function updateComponent({ doc, cmd, cmdIdx, affectedIds }) {
      const compId = cmd.componentId || cmd.id;
      if (!doc.components?.[compId] && CORE_COMPONENT_CONTRACTS[compId]) {
        ensureCoreComponentsRegistered(doc, [compId]);
      }
      const comp = doc.components?.[compId];
      if (!comp) {
        throw cmdError('E_UNKNOWN_COMPONENT', `未找到组件定义 "${compId}"`, { commandIndex: cmdIdx, field: 'componentId' });
      }
      if (cmd.variants) {
        comp.variants = { ...(comp.variants || {}), ...structuredClone(cmd.variants) };
      }
      if (cmd.properties) {
        validatePropertiesObject(cmd.properties, compId, cmdIdx);
        const subId = cmd.subNodeId;
        if (!subId || subId === '$root' || subId === comp.root.id) {
          assertKnownNodeEffects(comp.root,cmd.properties,{commandIndex:cmdIdx,nodeId:`component:${compId}/${comp.root.id}`});
          Object.assign(comp.root, structuredClone(cmd.properties));
        } else {
          const findSub = n => {
            if (!n) return null;
            if (n.id === subId) return n;
            for (const c of n.children || []) {
              const hit = findSub(c);
              if (hit) return hit;
            }
            return null;
          };
          const subNode = findSub(comp.root);
          if (!subNode) {
            throw cmdError('E_NODE_NOT_FOUND', `组件 "${compId}" 中未找到子节点 "${subId}"`, { commandIndex: cmdIdx, nodeId: subId });
          }
          assertKnownNodeEffects(subNode,cmd.properties,{commandIndex:cmdIdx,nodeId:`component:${compId}/${subId}`});
          Object.assign(subNode, structuredClone(cmd.properties));
        }
      }
      affectedIds.push(`component:${compId}`);
}

function createInstance({ doc, cmd, cmdIdx, index, pageScope, affectedIds, sceneOptions }) {
      let parentNode = null;
      let parentScope = pageScope || doc.pages?.[0]?.id || 'home';
      if (cmd.parentId) {
        const parentInfo = resolveTargetOrSubnode(doc, index, cmd.parentId, pageScope, cmdIdx);
        parentNode = parentInfo.entry.node;
        parentScope = parentInfo.entry.scope;
      } else {
        const pg = (doc.pages || []).find(p => p.id === parentScope) || doc.pages?.[0];
        if (!pg) {
          throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${parentScope}"`, { commandIndex: cmdIdx, field: 'pageId' });
        }
        parentNode = pg.root?.type === 'phone-shell' && pg.root?.children?.[0] ? pg.root.children[0] : pg.root;
        parentScope = pg.id;
      }
      const compId = cmd.componentId || cmd.component;
      if (!doc.components?.[compId] && CORE_COMPONENT_CONTRACTS[compId]) {
        ensureCoreComponentsRegistered(doc, [compId]);
      }
      if (!doc.components?.[compId]) {
        throw cmdError('E_UNKNOWN_COMPONENT', `未找到组件 "${compId}"`, { commandIndex: cmdIdx, field: 'componentId' });
      }
      const instId = cmd.instanceId || cmd.id || `${compId.toLowerCase()}_inst_${Date.now().toString(36)}`;
      const instNode = {
        type: 'instance',
        id: instId,
        name: cmd.name || instId,
        component: compId,
        variant: cmd.variant || doc.components[compId].defaultVariant || 'default',
        state: cmd.state || 'default',
        props: structuredClone(cmd.props || {}),
        overrides: structuredClone(cmd.overrides || {}),
        ...(cmd.slots ? { slots: structuredClone(cmd.slots) } : {}),
        ...(cmd.x !== undefined ? { x: cmd.x } : {}),
        ...(cmd.y !== undefined ? { y: cmd.y } : {}),
        ...(cmd.w !== undefined ? { w: cmd.w } : {}),
        ...(cmd.h !== undefined ? { h: cmd.h } : {}),
      };
      validateComponentInstanceAgainstContract(instNode, doc, { strict: true });
      parentNode.children = parentNode.children || [];
      parentNode.children.push(instNode);
      affectedIds.push(`${parentScope}/${instId}`);
      if (!cmd.instanceId && !cmd.id) sceneOptions.recordCommand?.({ ...cmd, instanceId: instId });
}

function setInstanceOverride({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, scopedId } = entry;
      if (node.type !== 'instance' && !node.component) {
        throw cmdError('E_NOT_INSTANCE', `节点 "${node.id}" 不是组件实例`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const rawKey = cmd.subNodeId || cmd.targetPath || (targetInfo.isInstanceSubnode ? targetInfo.subNodeId : '$root');
      const subKey = rawKey === '_self' ? '$root' : rawKey;
      validatePropertiesObject(cmd.properties, cmd.nodeId, cmdIdx);
      node.overrides = node.overrides || {};
      node.overrides[subKey] = {
        ...(node.overrides[subKey] || {}),
        ...structuredClone(cmd.properties),
      };
      validateComponentInstanceAgainstContract(node, doc, { strict: true });
      affectedIds.push(scopedId);
}

function clearInstanceOverride({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, scopedId } = entry;
      const subKey = cmd.subNodeId || (targetInfo.isInstanceSubnode ? targetInfo.subNodeId : null);
      if (node.overrides) {
        if (!subKey) {
          node.overrides = {};
        } else if (!cmd.property) {
          delete node.overrides[subKey];
        } else if (node.overrides[subKey]) {
          delete node.overrides[subKey][cmd.property];
        }
      }
      affectedIds.push(scopedId);
}

function setInstanceVariant({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, scopedId } = entry;
      if (!doc.components?.[node.component] && CORE_COMPONENT_CONTRACTS[node.component]) {
        ensureCoreComponentsRegistered(doc, [node.component]);
      }
      const comp = doc.components?.[node.component];
      if (!comp) {
        throw cmdError('E_UNKNOWN_COMPONENT', `节点 "${node.id}" 关联的组件 "${node.component}" 不存在`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      if (comp.variants && !(cmd.variant in comp.variants) && cmd.variant !== 'default') {
        throw cmdError('E_UNKNOWN_VARIANT', `组件 "${comp.id}" 不存在变体 "${cmd.variant}"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'variant' });
      }
      node.variant = cmd.variant;
      validateComponentInstanceAgainstContract(node, doc, { strict: true });
      affectedIds.push(scopedId);
}

function detachInstance({ doc, cmd, cmdIdx, index, pageScope, sceneOptions, affectedIds }) {
      const sceneBefore = resolveDocumentScene(doc, sceneOptions);
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, parent, index: pos, scopedId } = entry;
      const pageScene = sceneBefore.pages.find(p => p.id === entry.pageId);
      // Find the expanded subtree in pageScene.rootTree
      function findExpanded(treeNode) {
        if (!treeNode) return null;
        if (treeNode.id === node.id) return treeNode;
        for (const c of treeNode.children || []) {
          const hit = findExpanded(c);
          if (hit) return hit;
        }
        return null;
      }
      const expanded = findExpanded(pageScene?.rootTree);
      if (!expanded) {
        throw cmdError('E_DETACH_FAILED', `无法拆离节点 "${node.id}"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      function stripInternal(en) {
        const clean = {};
        for (const [k, v] of Object.entries(en)) {
          if (k.startsWith('_') || k === 'componentSource' || k === 'macroSource' || k === 'controlledByMacro') continue;
          clean[k] = v;
        }
        clean.type = ['instance', 'use', 'card', 'stat-row', 'list-item'].includes(clean.type) ? 'box' : clean.type;
        clean.x = en._relX;
        clean.y = en._relY;
        clean.w = en._w;
        clean.h = en._h;
        if (Array.isArray(en.children)) clean.children = en.children.map(stripInternal);
        return clean;
      }
      const detached = stripInternal(expanded);
      if (parent && Array.isArray(parent.children)) {
        parent.children[pos] = detached;
      }
      affectedIds.push(scopedId);
}

function swapInstance({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, scopedId } = entry;
      if (node.type !== 'instance' && !node.component) {
        throw cmdError('E_NOT_INSTANCE', `节点 "${node.id}" 不是组件实例,无法交换`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const newCompId = cmd.componentId;
      if (!doc.components?.[newCompId] && CORE_COMPONENT_CONTRACTS[newCompId]) {
        ensureCoreComponentsRegistered(doc, [newCompId]);
      }
      if (!doc.components?.[newCompId]) {
        throw cmdError('E_UNKNOWN_COMPONENT', `目标组件 "${newCompId}" 不存在`, { commandIndex: cmdIdx, field: 'componentId' });
      }
      if (node.component === newCompId) {
        affectedIds.push(scopedId);
        return;
      }
      const newComp = doc.components[newCompId];
      const contract = getComponentContracts(newCompId, doc);
      const parameters = contract?.parameters || newComp.params || {};
      const targets = contract?.allowedOverrides || buildNodeIndex({ pages: [], components: { [newCompId]: newComp } }).byId.keys();
      const allowed = new Set(['$root', '_self', ...targets, ...Object.keys(parameters)]);
      node.overrides = cmd.preserveOverrides === false ? {} : Object.fromEntries(
        Object.entries(node.overrides || {}).filter(([key]) => allowed.has(key))
      );
      if (node.props) node.props = Object.fromEntries(
        Object.entries(node.props).filter(([key]) => Object.hasOwn(parameters, key))
      );
      if (node.slots) node.slots = Object.fromEntries(
        Object.entries(node.slots).filter(([key]) => Object.hasOwn(contract?.slots || {}, key))
      );
      if (node.state && !Object.hasOwn(contract?.states || { default: {} }, node.state)) delete node.state;
      node.component = newCompId;
      const variants = Object.keys(newComp.variants || {});
      node.variant = variants.includes(newComp.defaultVariant) ? newComp.defaultVariant : variants[0] || 'default';
      delete node.macroSource;
      delete node.controlledByMacro;
      validateComponentInstanceAgainstContract(node, doc, { strict: true });
      affectedIds.push(scopedId);
}

export const handlers = {
  createComponent,
  registerCoreComponents,
  'register-core-components': registerCoreComponents,
  'upsert-component': upsertComponent,
  evolveComponentContract,
  'evolve-component-contract': evolveComponentContract,
  'upgrade-component-contract': evolveComponentContract,
  updateComponent,
  createInstance,
  setInstanceOverride,
  clearInstanceOverride,
  resetInstanceOverride: clearInstanceOverride,
  setInstanceVariant,
  swapInstance,
  detachInstance,
  detachMacro: detachInstance,
};
