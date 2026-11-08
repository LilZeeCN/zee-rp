// 节点增删改查命令 case(editNodes/addNode/deleteNode/duplicateNode/pasteNodes/reorderNode)。
// 从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import { resolveNodeEdits } from '../../relation-edit.mjs';
import { normalizeNodeInteractions } from '../../document.mjs';
import { materializeNodeSnapshots } from '../../clipboard.mjs';
import { validateComponentInstanceAgainstContract } from '../../component-contracts.mjs';
import { VALID_NODE_TYPES, CONTAINER_TYPES } from '../taxonomy.mjs';
import { cmdError, validatePropertiesObject, findDanglingReferences, resolveTargetOrSubnode } from '../helpers.mjs';

export const handlers = {
  editNodes({ doc, cmd, cmdIdx, preferredPageId, index, contractEvolutionResults, sceneOptions, affectedIds, applySingleCommand }) {
      let primitives;
      try { primitives = resolveNodeEdits(doc, cmd, preferredPageId); }
      catch (err) { err.commandIndex = cmdIdx; throw err; }
      for (const primitive of primitives) affectedIds.push(...applySingleCommand(doc, primitive, cmdIdx, preferredPageId, index, contractEvolutionResults, sceneOptions));
  },

  addNode({ doc, cmd, cmdIdx, index, pageScope, checkInteraction, affectedIds }) {
      let parentNode = null;
      let parentScope = pageScope || doc.pages?.[0]?.id || 'home';
      if (cmd.parentId) {
        const parentInfo = resolveTargetOrSubnode(doc, index, cmd.parentId, pageScope, cmdIdx);
        parentNode = parentInfo.entry.node;
        parentScope = parentInfo.entry.scope;
      } else {
        const pg = (doc.pages || []).find(p => p.id === parentScope);
        if (!pg) {
          throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${parentScope}"`, { commandIndex: cmdIdx, field: 'pageId' });
        }
        parentNode = pg.root?.type === 'phone-shell' && pg.root?.children?.[0] ? pg.root.children[0] : pg.root;
        parentScope = pg.id;
      }
      if (!cmd.node || typeof cmd.node !== 'object') {
        throw cmdError('E_INVALID_NODE', `addNode 需要提供 node 对象`, { commandIndex: cmdIdx, field: 'node' });
      }
      const newNode = structuredClone(cmd.node);
      normalizeNodeInteractions(newNode);
      const validateNode = node => {
        if (!node) return;
        if (node.on) for (const spec of Object.values(node.on)) checkInteraction(spec, node.id);
        for (const child of node.children || []) validateNode(child);
        for (const state of node.states || []) validateNode(state.root);
        validateNode(node.template);
      };
      validateNode(newNode);
      newNode.type = (newNode.type === 'svg' || newNode.type === 'sparkline') ? 'path' : (newNode.type || 'box');
      // 容器类型必须带 children 数组，否则 reorderNode 换父会被 E_INVALID_PARENT 拒收
      if (['box', 'card', 'phone-shell'].includes(newNode.type)) newNode.children = Array.isArray(newNode.children) ? newNode.children : [];
      validatePropertiesObject(Object.fromEntries(Object.entries(newNode).filter(([key]) => !['type','id','sourcePointer'].includes(key))), newNode.id, cmdIdx,{creation:true});
      if (!VALID_NODE_TYPES.has(newNode.type)) {
        throw cmdError('E_NODE_TYPE', `未知的节点类型 "${newNode.type}"；可用类型：${[...VALID_NODE_TYPES].join(', ')}`, { commandIndex: cmdIdx, field: 'node.type', extra: { candidates: [...VALID_NODE_TYPES].sort() } });
      }
      if (!newNode.id) {const base=`${newNode.type}_r${doc.revision+1}_${cmdIdx}`;newNode.id=base;let n=2;while(index.byScopedId.has(`${parentScope}/${newNode.id}`))newNode.id=`${base}_${n++}`;}
      newNode.name = newNode.name || newNode.id;
      parentNode.children = parentNode.children || [];
      const idx = typeof cmd.index === 'number'
        ? Math.max(0, Math.min(parentNode.children.length, cmd.index))
        : parentNode.children.length;
      parentNode.children.splice(idx, 0, newNode);
      affectedIds.push(`${parentScope}/${newNode.id}`);
      // 流式布局下显式 x/y 会被布局引擎重写；静默重排会毒化后续所有几何判断，
      // 所以必须留下可读的诊断，而不是让调用方自己发现坐标"跳了"。
      {
        const parentLayout = parentNode.layout || (parentNode.type === 'phone-shell' ? 'column' : 'stack');
        if ((parentLayout === 'row' || parentLayout === 'column')
          && (Number.isFinite(newNode.x) || Number.isFinite(newNode.y))) {
          doc.diagnostics = Array.isArray(doc.diagnostics) ? doc.diagnostics : [];
          if (doc.diagnostics.length < 20) {
            doc.diagnostics.push({
              code: 'W_LAYOUT_IGNORES_POSITION',
              severity: 'warning',
              nodeId: newNode.id,
              parentId: parentNode.id,
              parentLayout,
              requested: { x: newNode.x ?? null, y: newNode.y ?? null },
              message: `节点 "${newNode.id}" 显式写了 x/y，但父容器 "${parentNode.id}" 是 ${parentLayout} 流式布局，坐标将被重排覆盖；`
                + '要自由定位请把父容器改成 layout:"stack"，或改用顺序+gap 表达位置。',
            });
          }
        }
      }
  },

  deleteNode({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        if (inst.locked) {
          throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法隐藏/删除子节点`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        inst.overrides = inst.overrides || {};
        inst.overrides[targetInfo.subNodeId] = {
          ...(inst.overrides[targetInfo.subNodeId] || {}),
          visible: false,
        };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
        return;
      }
      const { node, parent, scopedId } = targetInfo.entry;
      if (node.locked) {
        throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法删除`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      if (!parent || !Array.isArray(parent.children)) {
        throw cmdError('E_CANNOT_DELETE_ROOT', `不能删除页面根节点 "${node.id}"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const dangling = findDanglingReferences(doc, node.id);
      if (dangling.length > 0 && !cmd.cascade) {
        throw cmdError(
          'E_DANGLING_REF',
          `无法删除节点 "${node.id}"：它被 ${dangling.length} 处交互引用 (${dangling.map(d => d.ownerId).join(', ')})；请先解除引用或传入 cascade: true`,
          { commandIndex: cmdIdx, nodeId: cmd.nodeId, danglingReferences: dangling }
        );
      }
      const pos = parent.children.indexOf(node);
      if (pos >= 0) parent.children.splice(pos, 1);
      affectedIds.push(scopedId);
  },

  duplicateNode({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, parent, index: pos } = entry;
      if (!parent || !Array.isArray(parent.children)) {
        throw cmdError('E_INVALID_PARENT', `无法复制根节点`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const clone = materializeNodeSnapshots({ doc, nodes: [node], pageId: entry.pageId, sourcePageId: entry.pageId,
        firstId: cmd.newId, offset: { x: 0, y: 0 } })[0];
      const finalId = clone.id;
      clone.name = cmd.newName || `${node.name || node.id} 副本`;
      if ((parent.layout || 'stack') === 'stack') {
        clone.x = Number(clone.x || 0) + Number(cmd.offset?.x ?? 16);
        clone.y = Number(clone.y || 0) + Number(cmd.offset?.y ?? 16);
      }
      parent.children.splice(pos + 1, 0, clone);
      if (!index.byId.has(finalId)) index.byId.set(finalId, [{ node: clone, id: finalId }]);
      affectedIds.push(`${entry.scope}/${clone.id}`);
  },

  pasteNodes({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const pageId = cmd.pageId || pageScope || doc.pages[0]?.id;
      const page = doc.pages.find(item => item.id === pageId);
      if (!page) throw cmdError('E_PAGE_NOT_FOUND', `页面不存在：${pageId}`);
      if (cmd.sourceDocumentId && cmd.sourceDocumentId !== doc.documentId) throw cmdError('E_CLIPBOARD_DOCUMENT', '此剪贴板属于其他工程，请先导入对应资源与组件');
      let parent = page.root?.type === 'phone-shell' ? page.root.children[0] : page.root;
      let position = cmd.index;
      if (cmd.parentId || cmd.anchorId) {
        const target = resolveTargetOrSubnode(doc, index, cmd.parentId || cmd.anchorId, pageId, cmdIdx);
        if (target.isInstanceSubnode) throw cmdError('E_INVALID_PARENT', '请粘贴到明确的源容器');
        if (target.entry.pageId !== pageId) throw cmdError('E_INVALID_PARENT', '粘贴目标必须位于指定页面');
        if (cmd.parentId || CONTAINER_TYPES.includes(target.entry.node.type)) parent = target.entry.node;
        else { parent = target.entry.parent; position = target.entry.index + 1; }
      }
      if (!parent || !CONTAINER_TYPES.includes(parent.type) || parent.locked) throw cmdError('E_INVALID_PARENT', `粘贴目标需要未锁定的普通源容器；可容纳子节点的类型：${CONTAINER_TYPES.join(', ')}`, { commandIndex: cmdIdx, field: 'parentId', extra: { parentType: parent?.type ?? null, parentLocked: parent?.locked ?? null, candidates: CONTAINER_TYPES } });
      const cloned = materializeNodeSnapshots({ doc, nodes: cmd.nodes, sourcePageId: cmd.sourcePageId, pageId, offset: cmd.offset });
      parent.children = parent.children || [];
      if (Number.isInteger(position)) position = Math.max(0, Math.min(position, parent.children.length));
      for (const node of cloned) {
        if (!VALID_NODE_TYPES.has(node.type)) throw cmdError('E_NODE_TYPE', `未知的粘贴节点类型 ${node.type}；可用类型：${[...VALID_NODE_TYPES].join(', ')}`, { commandIndex: cmdIdx, field: 'node.type', extra: { candidates: [...VALID_NODE_TYPES].sort() } });
        parent.children.splice(Number.isInteger(position) ? position++ : parent.children.length, 0, node);
        affectedIds.push(`${pageId}/${node.id}`);
      }
  },

  reorderNode({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const { entry } = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const { node, parent, scopedId } = entry;
      const targetParent = cmd.parentId ? resolveTargetOrSubnode(doc, index, cmd.parentId, pageScope, cmdIdx).entry.node : parent;
      // 存量容器可能缺 children 数组（历史 addNode 未补），容器类型就地补齐后再换父
      if (targetParent && !Array.isArray(targetParent.children) && CONTAINER_TYPES.includes(targetParent.type)) targetParent.children = [];
      if (!targetParent || !Array.isArray(targetParent.children)) {
        throw cmdError('E_INVALID_PARENT', `目标父容器不支持重排子节点；可容纳子节点的类型：${CONTAINER_TYPES.join(', ')}`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'parentId', extra: { parentType: targetParent?.type ?? null, candidates: CONTAINER_TYPES } });
      }
      const contains = n => n===targetParent || (n.children||[]).some(contains) || (n.states||[]).some(state=>contains(state.root));
      if (contains(node)) throw cmdError('E_NODE_CYCLE','不能将节点移入自身或后代',{commandIndex:cmdIdx,nodeId:cmd.nodeId});
      for (const siblingId of [cmd.beforeId,cmd.afterId]) if(siblingId && !targetParent.children.some(child=>child.id===siblingId && child!==node)) throw cmdError('E_NODE_NOT_FOUND',`目标父容器没有参照兄弟 ${siblingId}`,{commandIndex:cmdIdx,nodeId:siblingId});
      if (parent && Array.isArray(parent.children)) {
        const oldIdx = parent.children.indexOf(node);
        if (oldIdx >= 0) parent.children.splice(oldIdx, 1);
      }
      let insertIdx = typeof cmd.toIndex === 'number' ? cmd.toIndex : targetParent.children.length;
      if (cmd.beforeId) {
        const bIdx = targetParent.children.findIndex(c => c.id === cmd.beforeId);
        if (bIdx >= 0) insertIdx = bIdx;
      } else if (cmd.afterId) {
        const aIdx = targetParent.children.findIndex(c => c.id === cmd.afterId);
        if (aIdx >= 0) insertIdx = aIdx + 1;
      }
      insertIdx = Math.max(0, Math.min(targetParent.children.length, insertIdx));
      targetParent.children.splice(insertIdx, 0, node);
      affectedIds.push(scopedId);
  },
};
