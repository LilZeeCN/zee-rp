// 节点属性/文字/几何编辑命令 case(setProperties/setText/renameNode/moveNode/resizeNode/setLayout/switchLayoutMode/resizeArtboard)。
// 从 commands.mjs 的 switch 原样迁移;ctx 协议见 ../apply.mjs。
import { normalizeNodeInteractions, DEVICE_PRESETS } from '../../document.mjs';
import { measureTextBox, resolveDocumentScene, parsePadding } from '../../scene-resolver.mjs';
import { assertKnownNodeEffects } from '../../node-capabilities.mjs';
import { validateComponentInstanceAgainstContract } from '../../component-contracts.mjs';
import { VALID_LAYOUTS } from '../taxonomy.mjs';
import {
  cmdError, validatePropertiesObject, resolveTargetOrSubnode,
  applyChildConstraintsOnResize, assertCoordinateBounds, applyNodePosition, markExplicitWidth,
} from '../helpers.mjs';

function setProperties({ doc, cmd, cmdIdx, index, pageScope, checkInteraction, affectedIds }) {
      const propsPayload = structuredClone(cmd.properties || cmd.props);
      validatePropertiesObject(propsPayload, cmd.nodeId, cmdIdx);
      normalizeNodeInteractions(propsPayload);
      if (propsPayload.on) for (const spec of Object.values(propsPayload.on)) checkInteraction(spec, cmd.nodeId);
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        inst.overrides = inst.overrides || {};
        inst.overrides[targetInfo.subNodeId] = {
          ...(inst.overrides[targetInfo.subNodeId] || {}),
          ...structuredClone(propsPayload),
        };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
      } else {
        const { node, scopedId } = targetInfo.entry;
        if(node.type!=='instance'&&!node.component)assertKnownNodeEffects(node,propsPayload,{commandIndex:cmdIdx,nodeId:scopedId});
        if (node.locked && !('locked' in propsPayload) && !('visible' in propsPayload)) {
          throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法修改属性`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        if (node.type === 'instance' && !cmd.directInstanceProps) {
          // Top-level overrides or instance contract props ($root, state, props, overrides, variant, slots)
          const directInstKeys = new Set(['component', 'use', 'x', 'y', 'w', 'h', 'minW', 'maxW', 'minH', 'maxH', 'flex', 'visible', 'locked', 'name', 'state', 'variant', 'props', 'overrides', 'slots', 'on']);
          for (const [k, v] of Object.entries(propsPayload)) {
            if (directInstKeys.has(k)) {
              if (k === 'props' || k === 'overrides') {
                node[k] = { ...(node[k] || {}), ...structuredClone(v) };
              } else {
                node[k] = structuredClone(v);
              }
            } else {
              node.overrides = node.overrides || {};
              node.overrides.$root = { ...(node.overrides.$root || {}), [k]: structuredClone(v) };
            }
          }
          validateComponentInstanceAgainstContract(node, doc, { strict: true });
        } else {
          const merged = { ...node, ...propsPayload };
          if (typeof merged.minW === 'number' && typeof merged.maxW === 'number' && merged.minW > merged.maxW) {
            throw cmdError('E_SIZE_DEPENDENCY', `节点 "${node.id}" 的 minW (${merged.minW}) 不能大于 maxW (${merged.maxW})`, {
              commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'minW',
            });
          }
          if (typeof merged.minH === 'number' && typeof merged.maxH === 'number' && merged.minH > merged.maxH) {
            throw cmdError('E_SIZE_DEPENDENCY', `节点 "${node.id}" 的 minH (${merged.minH}) 不能大于 maxH (${merged.maxH})`, {
              commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'minH',
            });
          }
          Object.assign(node, structuredClone(propsPayload));
          if (typeof node.w === 'number' && propsPayload.w !== undefined) markExplicitWidth(node);
        }
        affectedIds.push(scopedId);
      }
}

function setText({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const spansArr = Array.isArray(cmd.spans) && cmd.spans.length > 0 ? structuredClone(cmd.spans) : null;
      const textValue = spansArr ? spansArr.map(sp => sp.text ?? '').join('') : cmd.text;
      if (typeof textValue !== 'string') {
        throw cmdError('E_INVALID_VALUE', `命令 #${cmdIdx} setText 的 text 必须是字符串或提供 spans 数组`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'text' });
      }
      const extraProps = {};
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'align', 'color']) {
        if (cmd[k] !== undefined) extraProps[k] = cmd[k];
      }
      if (Object.keys(extraProps).length > 0) {
        validatePropertiesObject(extraProps, cmd.nodeId, cmdIdx);
      }
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        inst.overrides = inst.overrides || {};
        inst.overrides[targetInfo.subNodeId] = {
          ...(inst.overrides[targetInfo.subNodeId] || {}),
          text: textValue,
          ...extraProps,
        };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
      } else {
        const { node, scopedId } = targetInfo.entry;
        if(node.type!=='instance'&&!node.component)assertKnownNodeEffects(node,{text:cmd.text,...extraProps},{commandIndex:cmdIdx,nodeId:scopedId});
        if (node.locked) {
          throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法修改文本`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        if (node.type === 'instance') {
          const targetSub = cmd.subNodeId || '$root';
          node.overrides = node.overrides || {};
          node.overrides[targetSub] = { ...(node.overrides[targetSub] || {}), text: cmd.text, ...extraProps };
        } else if (node.type === 'input') {
          node.value = textValue;
          Object.assign(node, extraProps);
        } else {
          node.text = textValue;
          if (spansArr) node.spans = spansArr; else delete node.spans;
          Object.assign(node, extraProps);
          if (cmd.autoSize === true && (node.type === 'label' || node.type === 'button') && !node.wrap && typeof node.w === 'number') {
            const tm = measureTextBox({ ...node, w: 'hug' }, null);
            const neededW = tm.w + (node.type === 'button' ? 8 : 16);
            // 默认 setText 是纯文字编辑并保留几何。只有调用方显式选择 autoSize
            // 才允许随文本回缩/加宽；加宽上限仍压在所属画板内（T-A-3）。
            const nodePage = doc.pages.find(p => p.id === targetInfo.entry.pageId);
            const nodePreset = nodePage?.device ? (DEVICE_PRESETS[nodePage.device] || DEVICE_PRESETS['iphone-17-pro']) : null;
            const boardW = nodePage ? Number(nodePage.canvas?.w || nodePreset?.w || 402) : null;
            const capW = boardW !== null && typeof node.x === 'number' && boardW - node.x >= 16
              ? boardW - node.x
              : (boardW !== null ? boardW : null);
            let newW = neededW;
            if (capW !== null) newW = Math.min(newW, capW);
            if (typeof node.minW === 'number') newW = Math.max(newW, node.minW);
            if (newW < node.w && node._explicitWSet) {
              // 同一事务内刚被显式设定过宽度的节点，回缩尊重显式宽度（原生导出回填路径）。
            } else if (newW !== node.w) {
              if (node.align === 'right' && typeof node.x === 'number') {
                const rightEdge = node.x + node.w;
                node.w = newW;
                node.x = Math.max(0, rightEdge - newW);
              } else {
                node.w = newW;
              }
            }
          }
        }
        affectedIds.push(scopedId);
      }
}

function renameNode({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      if (!cmd.name || typeof cmd.name !== 'string') {
        throw cmdError('E_INVALID_VALUE', `renameNode 需要非空字符串 name`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'name' });
      }
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        inst.overrides = inst.overrides || {};
        inst.overrides[targetInfo.subNodeId] = {
          ...(inst.overrides[targetInfo.subNodeId] || {}),
          name: cmd.name,
        };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
      } else {
        const { node, scopedId } = targetInfo.entry;
        if (node.locked) {
          throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法重命名`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        node.name = cmd.name;
        affectedIds.push(scopedId);
      }
}

function moveNode({ doc, cmd, cmdIdx, index, pageScope, sceneOptions, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      assertCoordinateBounds(cmd.x, 'x', cmdIdx, cmd.nodeId);
      assertCoordinateBounds(cmd.y, 'y', cmdIdx, cmd.nodeId);
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        if (inst.locked) {
          throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法移动子节点`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        inst.overrides = inst.overrides || {};
        const prevOvr = inst.overrides[targetInfo.subNodeId] || {};
        const nextOvr = { ...prevOvr };
        if (typeof cmd.x === 'number') nextOvr.x = Math.round(cmd.x);
        if (typeof cmd.y === 'number') nextOvr.y = Math.round(cmd.y);
        inst.overrides[targetInfo.subNodeId] = nextOvr;
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
        return;
      }
      const { node, parent, scopedId } = targetInfo.entry;
      if (node.locked) {
        throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法移动`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const parentLayout = parent?.layout || 'stack';
      if (['row','column','grid'].includes(parentLayout)) {
        // In auto-layout, dragging changes child order (never silently converts auto-layout to absolute coordinates!)
        if (typeof cmd.targetIndex === 'number' && Array.isArray(parent.children)) {
          const curIdx = parent.children.indexOf(node);
          if (curIdx >= 0) {
            parent.children.splice(curIdx, 1);
            const boundedIdx = Math.max(0, Math.min(parent.children.length, cmd.targetIndex));
            parent.children.splice(boundedIdx, 0, node);
          }
        } else if (typeof cmd.x === 'number' || typeof cmd.y === 'number') {
          throw cmdError(
            'E_AUTOLAYOUT_POSITION',
            `节点 "${node.id}" 位于自动布局 (${parentLayout}) 容器 "${parent.id}" 中，不能直接写入绝对坐标 x/y；请使用 reorderNode / moveNode(targetIndex) 调整顺序，或使用 switchLayoutMode 切换为自由布局`,
            { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'x', suggestion: '使用 reorderNode 调整子项顺序，或显式调用 switchLayoutMode' }
          );
        }
      } else {
        applyNodePosition(doc,targetInfo.entry,cmd,sceneOptions);
      }
      affectedIds.push(scopedId);
}

function resizeNode({ doc, cmd, cmdIdx, index, pageScope, sceneOptions, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        if (inst.locked) {
          throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法缩放子节点`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        inst.overrides = inst.overrides || {};
        const nextOvr = { ...(inst.overrides[targetInfo.subNodeId] || {}) };
        if (cmd.w !== undefined) {
          if (cmd.w !== 'fill' && cmd.w !== 'hug' && (typeof cmd.w !== 'number' || cmd.w <= 0)) {
            throw cmdError('E_INVALID_VALUE', `宽度 w=${cmd.w} 必须是正数、"fill" 或 "hug"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'w' });
          }
          nextOvr.w = typeof cmd.w === 'number' ? Math.round(cmd.w) : cmd.w;
        }
        if (cmd.h !== undefined) {
          if (cmd.h !== 'fill' && cmd.h !== 'hug' && (typeof cmd.h !== 'number' || cmd.h <= 0)) {
            throw cmdError('E_INVALID_VALUE', `高度 h=${cmd.h} 必须是正数、"fill" 或 "hug"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'h' });
          }
          nextOvr.h = typeof cmd.h === 'number' ? Math.round(cmd.h) : cmd.h;
        }
        if (typeof cmd.x === 'number') nextOvr.x = Math.round(cmd.x);
        if (typeof cmd.y === 'number') nextOvr.y = Math.round(cmd.y);
        inst.overrides[targetInfo.subNodeId] = nextOvr;
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
        return;
      }
      const { node, scopedId } = targetInfo.entry;
      if (node.locked) {
        throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法缩放`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const oldW = typeof node.w === 'number' ? node.w : 100;
      const oldH = typeof node.h === 'number' ? node.h : 40;
      if (cmd.w !== undefined) {
        if (cmd.w !== 'fill' && cmd.w !== 'hug' && (typeof cmd.w !== 'number' || cmd.w <= 0)) {
          throw cmdError('E_INVALID_VALUE', `宽度 w=${cmd.w} 必须是正数、"fill" 或 "hug"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'w' });
        }
        if (typeof cmd.w === 'number' && node.constraints?.keepAspectRatio && typeof node.w === 'number' && typeof node.h === 'number' && cmd.h === undefined) {
          const ratio = node.w / node.h;
          node.h = Math.max(8, Math.round(cmd.w / ratio));
        }
        node.w = typeof cmd.w === 'number' ? Math.round(cmd.w) : cmd.w;
        if (typeof node.w === 'number') markExplicitWidth(node);
      }
      if (cmd.h !== undefined) {
        if (cmd.h !== 'fill' && cmd.h !== 'hug' && (typeof cmd.h !== 'number' || cmd.h <= 0)) {
          throw cmdError('E_INVALID_VALUE', `高度 h=${cmd.h} 必须是正数、"fill" 或 "hug"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'h' });
        }
        node.h = typeof cmd.h === 'number' ? Math.round(cmd.h) : cmd.h;
      }
      applyNodePosition(doc,targetInfo.entry,cmd,sceneOptions);

      const newW = typeof node.w === 'number' ? node.w : oldW;
      const newH = typeof node.h === 'number' ? node.h : oldH;
      applyChildConstraintsOnResize(node, oldW, oldH, newW, newH);
      affectedIds.push(scopedId);
}

function resizeArtboard({ doc, cmd, cmdIdx, affectedIds }) {
      const pg = (doc.pages || []).find(p => p.id === (cmd.pageId || cmd.nodeId));
      if (!pg) {
        throw cmdError('E_PAGE_NOT_FOUND', `未找到画板/页面 "${cmd.pageId || cmd.nodeId}"`, { commandIndex: cmdIdx, field: 'pageId' });
      }
      const oldW = pg.canvas.w;
      const oldH = pg.canvas.h;
      if (typeof cmd.w === 'number') {
        if (cmd.w <= 0) throw cmdError('E_INVALID_VALUE', '画板宽度必须为正数', { commandIndex: cmdIdx, field: 'w' });
        pg.canvas.w = Math.round(cmd.w);
      }
      if (typeof cmd.h === 'number') {
        if (cmd.h <= 0) throw cmdError('E_INVALID_VALUE', '画板高度必须为正数', { commandIndex: cmdIdx, field: 'h' });
        pg.canvas.h = Math.round(cmd.h);
      }
      if (typeof cmd.x === 'number') pg.canvas.x = Math.round(cmd.x);
      if (typeof cmd.y === 'number') pg.canvas.y = Math.round(cmd.y);
      if (pg.root) {
        if (typeof pg.root.w === 'number' && pg.root.w === oldW) pg.root.w = pg.canvas.w;
        if (typeof pg.root.h === 'number' && pg.root.h === oldH) pg.root.h = pg.canvas.h;
        applyChildConstraintsOnResize(pg.root, oldW, oldH, pg.canvas.w, pg.canvas.h);
      }
      affectedIds.push(pg.id);
}

function setLayout({ doc, cmd, cmdIdx, index, pageScope, affectedIds }) {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const layoutSpec = cmd.layout && typeof cmd.layout === 'object' ? cmd.layout : cmd;
      const nextLayoutProps = {};
      if (layoutSpec.mode || (typeof layoutSpec.layout === 'string')) {
        const mode = layoutSpec.mode || layoutSpec.layout;
        if (!VALID_LAYOUTS.has(mode)) {
          throw cmdError('E_INVALID_LAYOUT', `不支持的布局模式 "${mode}"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'layout' });
        }
        nextLayoutProps.layout = mode === 'free' ? 'stack' : mode;
      }
      const allowedLayoutProps = {};
      for (const k of ['gap', 'padding', 'align', 'justify', 'minW', 'maxW', 'minH', 'maxH', 'w', 'h', 'wrap', 'columns', 'columnGap', 'rowGap', 'equalHeight']) {
        if (layoutSpec[k] !== undefined) allowedLayoutProps[k] = layoutSpec[k];
      }
      if (Object.keys(allowedLayoutProps).length > 0) {
        validatePropertiesObject(allowedLayoutProps, cmd.nodeId, cmdIdx);
        Object.assign(nextLayoutProps, structuredClone(allowedLayoutProps));
      }
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        if (inst.locked) {
          throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法修改布局`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        inst.overrides = inst.overrides || {};
        inst.overrides[targetInfo.subNodeId] = {
          ...(inst.overrides[targetInfo.subNodeId] || {}),
          ...nextLayoutProps,
        };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
      } else {
        const { node, scopedId } = targetInfo.entry;
        if (node.locked) {
          throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法修改布局`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        Object.assign(node, nextLayoutProps);
        affectedIds.push(scopedId);
      }
}

function switchLayoutMode({ doc, cmd, cmdIdx, index, pageScope, sceneOptions, affectedIds }) {
      // Explicit mode switch between auto-layout (row/column) and free positioning (stack)
      const sceneBefore = resolveDocumentScene(doc, sceneOptions);
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const rawMode = cmd.mode || cmd.targetLayout || cmd.layout;
      const targetMode = rawMode === 'free' ? 'stack' : rawMode;
      if (!VALID_LAYOUTS.has(targetMode)) {
        throw cmdError('E_INVALID_LAYOUT', `不支持的布局模式 "${rawMode}"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'mode' });
      }
      if (targetInfo.isInstanceSubnode) {
        const inst = targetInfo.instanceEntry.node;
        if (inst.locked) {
          throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法切换布局模式`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        inst.overrides = inst.overrides || {};
        inst.overrides[targetInfo.subNodeId] = {
          ...(inst.overrides[targetInfo.subNodeId] || {}),
          layout: targetMode,
        };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
        return;
      }
      const { entry } = targetInfo;
      const { node, scopedId } = entry;
      if (node.locked) {
        throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法切换布局模式`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      if (targetMode === 'stack' && ['row','column','grid'].includes(node.layout)) {
        // Preserve exact current resolved positions and sizes of children!
        const resContainer = sceneBefore.nodesByScopedId[scopedId];
        if (resContainer && Array.isArray(node.children)) {
          node.w = resContainer.w;
          node.h = resContainer.h;
          for (const ch of node.children) {
            const chScoped = `${entry.scope}/${ch.id}`;
            const resCh = sceneBefore.nodesByScopedId[chScoped];
            if (resCh) {
              const padding = parsePadding(resContainer.padding);
              ch.x = resCh.relX-padding[3];
              ch.y = resCh.relY-padding[0];
              ch.w = resCh.w;
              ch.h = resCh.h;
            }
          }
        }
      }
      node.layout = targetMode;
      affectedIds.push(scopedId);
}

export const handlers = {
  setProperties,
  'set-props': setProperties,
  setText,
  renameNode,
  moveNode,
  resizeNode,
  setLayout,
  switchLayoutMode,
  resizeArtboard,
};
