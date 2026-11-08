// 资源与交互命令 case(registerAsset/setInteraction/removeInteraction)。
// 从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import { validateComponentInstanceAgainstContract } from '../../component-contracts.mjs';
import { cmdError, resolveTargetOrSubnode } from '../helpers.mjs';

function registerAsset({ doc, cmd, cmdIdx, affectedIds }) {
      const asset = cmd.asset;
      if (!asset || !/^assets\/[a-zA-Z0-9_.-]+$/.test(asset.relativePath || '') || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')
        || !Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width <= 0 || asset.height <= 0) {
        throw cmdError('E_INVALID_ASSET', 'registerAsset 需要准备工具返回的资源路径、SHA-256和尺寸', { commandIndex: cmdIdx });
      }
      doc.assetsManifest ||= {};
      doc.assetsManifest[asset.relativePath] = structuredClone(asset);
      affectedIds.push(`asset:${asset.relativePath}`);
}

function setInteractionOrRemove({ doc, cmd, cmdIdx, index, pageScope, checkInteraction, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const ev = cmd.event || 'click';
      if (cmd.type !== 'removeInteraction') checkInteraction(cmd.actions !== undefined ? cmd.actions : cmd.action, cmd.nodeId);
      const rawActs = cmd.type === 'removeInteraction' ? null : cmd.actions !== undefined ? cmd.actions : cmd.action;
      let normalizedActs = null;
      if (rawActs !== null && rawActs !== undefined && rawActs !== '') {
        const list = Array.isArray(rawActs) ? rawActs : [rawActs];
        const mapped = list
          .map(a => {
            if (!a) return null;
            if (typeof a === 'string') return { type: 'link', page: a };
            if (typeof a === 'object' && a.link && !a.type && !a.page) {
              const { link, ...rest } = a;
              return { ...rest, type: 'link', page: link };
            }
            return structuredClone(a);
          })
          .filter(Boolean);
        if (mapped.length > 0) normalizedActs = mapped;
      }

      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        if (inst.locked) {
          throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法修改交互`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        inst.overrides = inst.overrides || {};
        const prevSub = inst.overrides[targetInfo.subNodeId] || {};
        const nextOn = { ...(prevSub.on || {}) };
        if (!normalizedActs) delete nextOn[ev];
        else nextOn[ev] = normalizedActs;
        inst.overrides[targetInfo.subNodeId] = { ...prevSub, on: nextOn };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
      } else {
        const { node, scopedId } = targetInfo.entry;
        if (node.locked) {
          throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法修改交互`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        node.on = node.on || {};
        if (!normalizedActs) {
          delete node.on[ev];
        } else {
          node.on[ev] = normalizedActs;
        }
        affectedIds.push(scopedId);
      }
}

export const handlers = {
  registerAsset,
  setInteraction: setInteractionOrRemove,
  removeInteraction: setInteractionOrRemove,
};
