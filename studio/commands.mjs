import { buildNodeIndex, canonicalJson, computeContentHash, sha256 } from './document.mjs';
import { measureTextBox, resolveDocumentScene } from './scene-resolver.mjs';
import { normalizeVisualCss } from './visual-style.mjs';
import {
  CORE_COMPONENT_CONTRACTS,
  ensureCoreComponentsRegistered,
  validateComponentInstanceAgainstContract,
  evolveComponentContractOnDocument,
} from './component-contracts.mjs';
import { computeCommandImpactAndDiff } from './impact-diff.mjs';
import {
  generateGeneralExplorations,
  validateExplorationsUsability,
  applySelectedExplorationToPage,
} from './explorations.mjs';

const VALID_NODE_TYPES = new Set([
  'box', 'card', 'label', 'paragraph', 'button', 'badge', 'input', 'image', 'icon',
  'dynamic-panel', 'repeater', 'phone-shell', 'tab-bar', 'nav-bar',
  'stat-row', 'list-item', 'progress-bar', 'instance', 'use',
  // 场景解析器已支持这些类型，命令层不接受会让调用方凭空多绕一步（试用者实测踩到）。
  'divider', 'spacer', 'detail-card', 'data-table', 'searchable-list', 'master-detail',
]);

const VALID_LAYOUTS = new Set(['stack', 'row', 'column', 'grid', 'free']);

function cmdError(code, message, { commandIndex = 0, nodeId = null, field = null, suggestion = null, extra = {} } = {}) {
  return Object.assign(new Error(message), {
    code,
    commandIndex,
    nodeId,
    field,
    suggestion,
    ...extra,
  });
}

function validatePropertiesObject(props, nodeId, cmdIdx) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    throw cmdError('E_INVALID_PROPERTIES', `命令 #${cmdIdx} properties 必须是非空对象`, { commandIndex: cmdIdx, nodeId, field: 'properties' });
  }
  const unknownKeys = Object.keys(props).filter(k => k.startsWith('__'));
  if ('css' in props) normalizeVisualCss(props.css);
  if (unknownKeys.length > 0) {
    throw cmdError('E_UNKNOWN_PROPERTY', `命令 #${cmdIdx} 包含非法属性名: ${unknownKeys.join(', ')}`, { commandIndex: cmdIdx, nodeId, field: unknownKeys[0] });
  }
  if ('radius' in props) {
    const r = props.radius;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的圆角 radius=${JSON.stringify(r)} 必须是非负数值`, {
        commandIndex: cmdIdx, nodeId, field: 'radius', suggestion: '请提供 >= 0 的数值，如 0, 8, 16, 24',
      });
    }
  }
  if ('opacity' in props) {
    const op = props.opacity;
    if (typeof op !== 'number' || !Number.isFinite(op) || op < 0 || op > 1) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的透明度 opacity=${JSON.stringify(op)} 必须在 [0, 1] 范围内`, {
        commandIndex: cmdIdx, nodeId, field: 'opacity', suggestion: '请提供 0 到 1 之间的数值',
      });
    }
  }
  if ('fontSize' in props) {
    const fs = props.fontSize;
    if (!(typeof fs === 'string' && fs.startsWith('$')) && (typeof fs !== 'number' || !Number.isFinite(fs) || fs <= 0 || fs > 120)) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的字号 fontSize=${JSON.stringify(fs)} 必须在 (0, 120] 范围内`, {
        commandIndex: cmdIdx, nodeId, field: 'fontSize', suggestion: '请提供 10~72 之间的正数',
      });
    }
  }
  if ('gap' in props) {
    const g = props.gap;
    if (!(typeof g === 'string' && g.startsWith('$')) && (typeof g !== 'number' || !Number.isFinite(g) || g < 0)) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的间距 gap=${JSON.stringify(g)} 必须是非负数值`, {
        commandIndex: cmdIdx, nodeId, field: 'gap',
      });
    }
  }
  for (const dim of ['w', 'h']) {
    if (dim in props) {
      const v = props[dim];
      if (v !== 'fill' && v !== 'hug' && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
        throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的尺寸 ${dim}=${JSON.stringify(v)} 必须是正数、"fill" 或 "hug"`, {
          commandIndex: cmdIdx, nodeId, field: dim,
        });
      }
    }
  }
  for (const [minK, maxK] of [['minW', 'maxW'], ['minH', 'maxH']]) {
    if (minK in props && props[minK] !== null && (typeof props[minK] !== 'number' || props[minK] < 0)) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的 ${minK} 必须是非负数值`, { commandIndex: cmdIdx, nodeId, field: minK });
    }
    if (maxK in props && props[maxK] !== null && (typeof props[maxK] !== 'number' || props[maxK] <= 0)) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的 ${maxK} 必须是正数`, { commandIndex: cmdIdx, nodeId, field: maxK });
    }
    if (typeof props[minK] === 'number' && typeof props[maxK] === 'number' && props[minK] > props[maxK]) {
      throw cmdError('E_SIZE_DEPENDENCY', `节点 "${nodeId}" 的 ${minK} (${props[minK]}) 不能大于 ${maxK} (${props[maxK]})`, {
        commandIndex: cmdIdx, nodeId, field: minK,
      });
    }
  }
  for (const colorKey of ['fill', 'stroke', 'color']) {
    if (colorKey in props && props[colorKey] !== null && props[colorKey] !== undefined) {
      const c = String(props[colorKey]);
      if (!c.startsWith('$') && !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c) && !/^rgba?\(/.test(c)) {
        throw cmdError('E_INVALID_COLOR', `节点 "${nodeId}" 的颜色属性 ${colorKey}="${c}" 格式非法`, {
          commandIndex: cmdIdx, nodeId, field: colorKey, suggestion: '请使用 #RRGGBB、#RRGGBBAA 或 $token 引用',
        });
      }
    }
  }
}

function findDanglingReferences(doc, deletedNodeId) {
  const refs = [];
  function scanActions(actions, ownerId) {
    for (const act of actions || []) {
      const tgt = act.target || act.widget;
      if (tgt === deletedNodeId || (typeof tgt === 'string' && tgt.endsWith('/' + deletedNodeId))) {
        refs.push({ ownerId, actionType: act.type, target: tgt });
      }
      if (typeof act.value === 'string' && act.value.includes(`@${deletedNodeId}`)) {
        refs.push({ ownerId, actionType: act.type, expression: act.value });
      }
    }
  }
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.on && typeof node.on === 'object') {
      for (const [, evSpec] of Object.entries(node.on)) {
        if (Array.isArray(evSpec)) scanActions(evSpec, node.id);
        else if (evSpec?.cases) {
          for (const c of evSpec.cases) scanActions(c.actions, node.id);
        }
      }
    }
    for (const ch of node.children || []) walk(ch);
    for (const st of node.states || []) if (st.root) walk(st.root);
  }
  for (const p of doc.pages || []) {
    walk(p.root);
    for (const ix of p.interactions || []) {
      for (const ev of ix.events || []) {
        for (const c of ev.cases || []) scanActions(c.actions, ix.trigger);
      }
    }
  }
  return refs;
}

function resolveTargetOrSubnode(doc, index, rawNodeId, preferredPageId, cmdIdx) {
  if (!rawNodeId || typeof rawNodeId !== 'string') {
    throw cmdError('E_MISSING_NODE_ID', `命令 #${cmdIdx} 缺少有效的 nodeId`, { commandIndex: cmdIdx, field: 'nodeId' });
  }
  // Check if targeting an expanded component instance subnode: e.g. "home/card_inst_1__title" or "card_inst_1__title"
  if (rawNodeId.includes('__')) {
    const [prefixPart, ...subParts] = rawNodeId.split('__');
    const instEntry = index.resolve(prefixPart, preferredPageId);
    if (instEntry && (instEntry.node.type === 'instance' || instEntry.node.component)) {
      return {
        isInstanceSubnode: true,
        instanceEntry: instEntry,
        subNodeId: subParts.join('/'),
      };
    }
  }
  const entry = index.resolve(rawNodeId, preferredPageId);
  if (!entry) {
    throw cmdError('E_NODE_NOT_FOUND', `未找到节点 "${rawNodeId}"`, {
      commandIndex: cmdIdx,
      nodeId: rawNodeId,
      field: 'nodeId',
      suggestion: '请检查节点 ID 是否存在，或使用 "<pageId>/<nodeId>"',
    });
  }
  return { isInstanceSubnode: false, entry };
}

function applyChildConstraintsOnResize(containerNode, oldW, oldH, newW, newH) {
  if (!Array.isArray(containerNode.children) || (containerNode.layout && containerNode.layout !== 'stack' && containerNode.layout !== 'free')) {
    return;
  }
  const dw = newW - oldW;
  const dh = newH - oldH;
  if (dw === 0 && dh === 0) return;
  for (const ch of containerNode.children) {
    const c = ch.constraints || {};
    if (typeof ch.x === 'number' && typeof ch.w === 'number') {
      if (c.horizontal === 'right') ch.x = Math.round(ch.x + dw);
      else if (c.horizontal === 'center') ch.x = Math.round(ch.x + dw / 2);
      else if (c.horizontal === 'left-right') ch.w = Math.max(8, Math.round(ch.w + dw));
      else if (c.horizontal === 'scale' && oldW > 0) {
        ch.x = Math.round((ch.x / oldW) * newW);
        ch.w = Math.max(8, Math.round((ch.w / oldW) * newW));
      }
    }
    if (typeof ch.y === 'number' && typeof ch.h === 'number') {
      if (c.vertical === 'bottom') ch.y = Math.round(ch.y + dh);
      else if (c.vertical === 'center') ch.y = Math.round(ch.y + dh / 2);
      else if (c.vertical === 'top-bottom') ch.h = Math.max(8, Math.round(ch.h + dh));
      else if (c.vertical === 'scale' && oldH > 0) {
        ch.y = Math.round((ch.y / oldH) * newH);
        ch.h = Math.max(8, Math.round((ch.h / oldH) * newH));
      }
    }
    if (c.keepAspectRatio && ch._aspectRatio && typeof ch.w === 'number') {
      ch.h = Math.max(8, Math.round(ch.w / ch._aspectRatio));
    }
  }
}

const NON_STRUCTURAL_COMMANDS = new Set([
  'setProperties', 'set-props', 'setText', 'renameNode', 'resizeNode',
  'setLayout', 'setConstraints', 'setToken', 'set-tokens', 'bindToken',
  'setTypography', 'setInteraction', 'removeInteraction',
  'renamePage', 'resizeArtboard', 'setInstanceVariant',
  'setInstanceOverride', 'resetInstanceOverride', 'setPanelActiveState',
  'repeaterAddRow', 'repeaterUpdateRow', 'repeaterDeleteRows',
  'repeaterSetFilter', 'repeaterSetSort', 'set-variable', 'dataset-op',
]);

const COMMAND_TYPES_BY_GROUP = {
  节点: ['addNode', 'deleteNode', 'duplicateNode', 'moveNode', 'resizeNode', 'reorderNode', 'renameNode', 'setProperties', 'set-props', 'setText', 'setLayout', 'switchLayoutMode', 'resizeArtboard'],
  页面: ['addPage', 'duplicatePage', 'renamePage', 'deletePage', 'reorderPages'],
  组件: ['createComponent', 'registerCoreComponents', 'register-core-components', 'upsert-component', 'evolveComponentContract', 'evolve-component-contract', 'upgrade-component-contract', 'updateComponent', 'createInstance', 'setInstanceOverride', 'clearInstanceOverride', 'resetInstanceOverride', 'setInstanceVariant', 'detachInstance', 'detachMacro'],
  数据与状态: ['setToken', 'set-tokens', 'setTokens', 'setVariable', 'set-variable', 'datasetOp', 'dataset-op', 'setPanelActiveState', 'setFont'],
  资源与交互: ['registerAsset', 'setInteraction', 'removeInteraction'],
  探索: ['generateExplorations', 'selectExploration'],
};
const VALID_COMMAND_TYPES = Object.values(COMMAND_TYPES_BY_GROUP).flat();

export function applySingleCommand(doc, cmd, cmdIdx, preferredPageId = null, cachedIndex = null, contractEvolutionResults = null) {
  if (cmd && typeof cmd === 'object' && !cmd.type && typeof cmd.cmd === 'string') {
    // 常见笔误：把命令种类写成 cmd。做别名而不是让人猜。
    cmd = { ...cmd, type: cmd.cmd };
    delete cmd.cmd;
  }
  if (!cmd || typeof cmd !== 'object' || !cmd.type) {
    throw cmdError(
      'E_INVALID_COMMAND',
      `命令 #${cmdIdx} 缺少 type 字段。可用类型：${VALID_COMMAND_TYPES.join(', ')}。示例：{type:'addNode', pageId:'home', node:{type:'box', id:'hero'}}`,
      {
        commandIndex: cmdIdx,
        field: 'type',
        validTypes: COMMAND_TYPES_BY_GROUP,
        example: { type: 'addNode', pageId: 'home', node: { type: 'box', id: 'hero', w: 'fill', h: 120 } },
      }
    );
  }
  const index = cachedIndex || buildNodeIndex(doc);
  const pageScope = cmd.pageId || preferredPageId;
  const affectedIds = [];

  switch (cmd.type) {
    case 'registerAsset': {
      const asset = cmd.asset;
      if (!asset || !/^assets\/[a-zA-Z0-9_.-]+$/.test(asset.relativePath || '') || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')
        || !Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width <= 0 || asset.height <= 0) {
        throw cmdError('E_INVALID_ASSET', 'registerAsset 需要准备工具返回的资源路径、SHA-256和尺寸', { commandIndex: cmdIdx });
      }
      doc.assetsManifest ||= {};
      doc.assetsManifest[asset.relativePath] = structuredClone(asset);
      affectedIds.push(`asset:${asset.relativePath}`);
      break;
    }
    case 'setProperties':
    case 'set-props': {
      const propsPayload = cmd.properties || cmd.props;
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      validatePropertiesObject(propsPayload, cmd.nodeId, cmdIdx);
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
        if (node.locked && !('locked' in propsPayload) && !('visible' in propsPayload)) {
          throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法修改属性`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        if (node.type === 'instance' && !cmd.directInstanceProps) {
          // Top-level overrides or instance contract props ($root, state, props, overrides, variant, slots)
          const directInstKeys = new Set(['x', 'y', 'w', 'h', 'minW', 'maxW', 'minH', 'maxH', 'flex', 'visible', 'locked', 'name', 'state', 'variant', 'props', 'overrides', 'slots', 'on']);
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
        }
        affectedIds.push(scopedId);
      }
      break;
    }

    case 'setText': {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      if (typeof cmd.text !== 'string') {
        throw cmdError('E_INVALID_VALUE', `命令 #${cmdIdx} setText 的 text 必须是字符串`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'text' });
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
          text: cmd.text,
          ...extraProps,
        };
        validateComponentInstanceAgainstContract(inst, doc, { strict: true });
        affectedIds.push(targetInfo.instanceEntry.scopedId);
      } else {
        const { node, scopedId } = targetInfo.entry;
        if (node.locked) {
          throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法修改文本`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
        }
        if (node.type === 'instance') {
          const targetSub = cmd.subNodeId || '$root';
          node.overrides = node.overrides || {};
          node.overrides[targetSub] = { ...(node.overrides[targetSub] || {}), text: cmd.text, ...extraProps };
        } else if (node.type === 'input') {
          node.value = cmd.text;
          Object.assign(node, extraProps);
        } else {
          node.text = cmd.text;
          Object.assign(node, extraProps);
          if ((node.type === 'label' || node.type === 'button') && !node.wrap && typeof node.w === 'number') {
            const tm = measureTextBox({ ...node, w: 'hug' }, null);
            const neededW = tm.w + (node.type === 'button' ? 8 : 16);
            if (neededW > node.w) {
              if (node.align === 'right' && typeof node.x === 'number') {
                const rightEdge = node.x + node.w;
                node.w = neededW;
                node.x = Math.max(0, rightEdge - neededW);
              } else {
                node.w = neededW;
              }
            }
          }
        }
        affectedIds.push(scopedId);
      }
      break;
    }

    case 'renameNode': {
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
      break;
    }

    case 'moveNode': {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
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
        break;
      }
      const { node, parent, scopedId } = targetInfo.entry;
      if (node.locked) {
        throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法移动`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const parentLayout = parent?.layout || 'stack';
      if (parentLayout === 'row' || parentLayout === 'column') {
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
        if (typeof cmd.x === 'number') node.x = Math.round(cmd.x);
        else if (typeof cmd.deltaX === 'number') node.x = Math.round(Number(node.x || 0) + cmd.deltaX);
        if (typeof cmd.y === 'number') node.y = Math.round(cmd.y);
        else if (typeof cmd.deltaY === 'number') node.y = Math.round(Number(node.y || 0) + cmd.deltaY);
      }
      affectedIds.push(scopedId);
      break;
    }

    case 'resizeNode': {
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
        break;
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
      }
      if (cmd.h !== undefined) {
        if (cmd.h !== 'fill' && cmd.h !== 'hug' && (typeof cmd.h !== 'number' || cmd.h <= 0)) {
          throw cmdError('E_INVALID_VALUE', `高度 h=${cmd.h} 必须是正数、"fill" 或 "hug"`, { commandIndex: cmdIdx, nodeId: cmd.nodeId, field: 'h' });
        }
        node.h = typeof cmd.h === 'number' ? Math.round(cmd.h) : cmd.h;
      }
      if (typeof cmd.x === 'number') node.x = Math.round(cmd.x);
      if (typeof cmd.y === 'number') node.y = Math.round(cmd.y);

      const newW = typeof node.w === 'number' ? node.w : oldW;
      const newH = typeof node.h === 'number' ? node.h : oldH;
      applyChildConstraintsOnResize(node, oldW, oldH, newW, newH);
      affectedIds.push(scopedId);
      break;
    }

    case 'resizeArtboard': {
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
      break;
    }

    case 'reorderNode': {
      const { entry } = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const { node, parent, scopedId } = entry;
      const targetParent = cmd.parentId ? resolveTargetOrSubnode(doc, index, cmd.parentId, pageScope, cmdIdx).entry.node : parent;
      if (!targetParent || !Array.isArray(targetParent.children)) {
        throw cmdError('E_INVALID_PARENT', `目标父容器不支持重排子节点`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
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
      break;
    }

    case 'setLayout': {
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
      for (const k of ['gap', 'padding', 'align', 'justify', 'minW', 'maxW', 'minH', 'maxH', 'w', 'h', 'wrap']) {
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
      break;
    }

    case 'switchLayoutMode': {
      // Explicit mode switch between auto-layout (row/column) and free positioning (stack)
      const sceneBefore = resolveDocumentScene(doc);
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
        break;
      }
      const { entry } = targetInfo;
      const { node, scopedId } = entry;
      if (node.locked) {
        throw cmdError('E_NODE_LOCKED', `节点 "${node.id}" 已锁定，无法切换布局模式`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      if (targetMode === 'stack' && (node.layout === 'row' || node.layout === 'column')) {
        // Preserve exact current resolved positions and sizes of children!
        const resContainer = sceneBefore.nodesByScopedId[scopedId];
        if (resContainer && Array.isArray(node.children)) {
          node.w = resContainer.w;
          node.h = resContainer.h;
          for (const ch of node.children) {
            const chScoped = `${entry.scope}/${ch.id}`;
            const resCh = sceneBefore.nodesByScopedId[chScoped];
            if (resCh) {
              ch.x = resCh.relX;
              ch.y = resCh.relY;
              ch.w = resCh.w;
              ch.h = resCh.h;
            }
          }
        }
      }
      node.layout = targetMode;
      affectedIds.push(scopedId);
      break;
    }

    case 'addNode': {
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
      if (!cmd.node || typeof cmd.node !== 'object') {
        throw cmdError('E_INVALID_NODE', `addNode 需要提供 node 对象`, { commandIndex: cmdIdx, field: 'node' });
      }
      const newNode = structuredClone(cmd.node);
      newNode.type = newNode.type || 'box';
      if (!VALID_NODE_TYPES.has(newNode.type)) {
        throw cmdError('E_NODE_TYPE', `未知的节点类型 "${newNode.type}"`, { commandIndex: cmdIdx, field: 'node.type' });
      }
      newNode.id = newNode.id || `${newNode.type}_${Date.now().toString(36)}`;
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
      break;
    }

    case 'deleteNode': {
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
        break;
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
      break;
    }

    case 'duplicateNode': {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, parent, index: pos } = entry;
      if (!parent || !Array.isArray(parent.children)) {
        throw cmdError('E_INVALID_PARENT', `无法复制根节点`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const clone = structuredClone(node);
      const baseId = cmd.newId || `${node.id}_copy`;
      let finalId = baseId;
      let n = 2;
      while (index.byId.has(finalId)) finalId = `${baseId}_${n++}`;
      clone.id = finalId;
      clone.name = cmd.newName || `${node.name || node.id} 副本`;
      if ((parent.layout || 'stack') === 'stack') {
        clone.x = Number(clone.x || 0) + Number(cmd.offset?.x ?? 16);
        clone.y = Number(clone.y || 0) + Number(cmd.offset?.y ?? 16);
      }
      parent.children.splice(pos + 1, 0, clone);
      if (!index.byId.has(finalId)) index.byId.set(finalId, [{ node: clone, id: finalId }]);
      affectedIds.push(`${entry.scope}/${clone.id}`);
      break;
    }

    case 'createComponent': {
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
      doc.components[compId] = {
        id: compId,
        name: cmd.name || compId,
        params: structuredClone(cmd.params || {}),
        variants: structuredClone(cmd.variants || {}),
        defaultVariant: cmd.defaultVariant || 'default',
        root: rootNode,
      };
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
      break;
    }

    case 'registerCoreComponents':
    case 'register-core-components': {
      const regIds = ensureCoreComponentsRegistered(doc, cmd.componentIds || null);
      for (const cid of regIds) affectedIds.push(`component:${cid}`);
      break;
    }

    case 'upsert-component': {
      const compId = cmd.componentId || cmd.id || cmd.component?.id;
      if (!compId || !cmd.component) {
        throw cmdError('E_INVALID_COMPONENT', `upsert-component 需要提供 componentId 与 component 定义`, { commandIndex: cmdIdx, field: 'componentId' });
      }
      doc.components = doc.components || {};
      doc.components[compId] = structuredClone(cmd.component);
      doc.components[compId].id = compId;
      affectedIds.push(`component:${compId}`);
      break;
    }

    case 'evolveComponentContract':
    case 'upgrade-component-contract':
    case 'evolve-component-contract': {
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
      break;
    }

    case 'updateComponent': {
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
          Object.assign(subNode, structuredClone(cmd.properties));
        }
      }
      affectedIds.push(`component:${compId}`);
      break;
    }

    case 'createInstance': {
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
      break;
    }

    case 'setInstanceOverride': {
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
      break;
    }

    case 'clearInstanceOverride':
    case 'resetInstanceOverride': {
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
      break;
    }

    case 'setInstanceVariant': {
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
      break;
    }

    case 'setPanelActiveState': {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const entry = targetInfo.isInstanceSubnode ? targetInfo.instanceEntry : targetInfo.entry;
      const { node, scopedId } = entry;
      if (node.type !== 'dynamic-panel' || !Array.isArray(node.states)) {
        throw cmdError('E_NOT_DYNAMIC_PANEL', `节点 "${node.id}" 不是动态面板`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
      }
      const nextStateId = cmd.stateId || cmd.state || cmd.activeState;
      if (!nextStateId || !node.states.some(s => s.id === nextStateId)) {
        throw cmdError('E_UNKNOWN_PANEL_STATE', `动态面板 "${node.id}" 不存在状态 "${nextStateId}"`, {
          commandIndex: cmdIdx,
          nodeId: cmd.nodeId,
          field: 'stateId',
        });
      }
      node.activeState = nextStateId;
      affectedIds.push(scopedId);
      break;
    }

    case 'detachInstance':
    case 'detachMacro': {
      const sceneBefore = resolveDocumentScene(doc);
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
      break;
    }

    case 'setToken': {
      const cat = cmd.category || 'color';
      const name = String(cmd.name || '').replace(/^\$/, '');
      if (!name) {
        throw cmdError('E_INVALID_TOKEN', `setToken 需要提供有效的令牌名称 name`, { commandIndex: cmdIdx, field: 'name' });
      }
      if (cat === 'color' || cat === 'colors') {
        if (typeof cmd.value !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(cmd.value)) {
          throw cmdError('E_INVALID_COLOR', `颜色令牌 "${name}" 的值 "${cmd.value}" 必须是 #RRGGBB 或 #RRGGBBAA`, { commandIndex: cmdIdx, field: 'value' });
        }
        doc.palette = doc.palette || {};
        doc.palette[name] = cmd.value;
        doc.tokens = doc.tokens || {};
        doc.tokens.colors = doc.tokens.colors || {};
        doc.tokens.colors[name] = cmd.value;
      } else {
        doc.tokens = doc.tokens || {};
        doc.tokens[name] = cmd.value;
      }
      affectedIds.push(`token:${cat}:${name}`);
      break;
    }

    case 'set-tokens':
    case 'setTokens': {
      const tokensObj = cmd.tokens || cmd.values || (cmd.colors ? { colors: cmd.colors } : {});
      doc.palette = doc.palette || {};
      doc.tokens = doc.tokens || { colors: {} };
      doc.tokens.colors = doc.tokens.colors || {};
      const applyColor = (rawName, val) => {
        const name = String(rawName || '').replace(/^\$/, '');
        if (!name || typeof val !== 'string') return;
        if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(val)) {
          throw cmdError('E_INVALID_COLOR', `颜色令牌 "${name}" 的值 "${val}" 必须是 #RRGGBB 或 #RRGGBBAA`, { commandIndex: cmdIdx, field: name });
        }
        doc.palette[name] = val;
        doc.tokens.colors[name] = val;
        affectedIds.push(`token:color:${name}`);
      };
      if (tokensObj.colors && typeof tokensObj.colors === 'object') {
        for (const [k, v] of Object.entries(tokensObj.colors)) applyColor(k, v);
      }
      for (const [k, v] of Object.entries(tokensObj)) {
        if (k === 'colors') continue;
        if (typeof v === 'string' && v.startsWith('#')) {
          applyColor(k, v);
        } else {
          doc.tokens[k] = v;
          affectedIds.push(`token:general:${k}`);
        }
      }
      break;
    }

    case 'set-variable':
    case 'setVariable': {
      doc.variables = doc.variables || {};
      const name = String(cmd.name || cmd.variable || '').trim();
      if (!name) {
        throw cmdError('E_INVALID_VARIABLE', `setVariable 需要提供变量名称 name`, { commandIndex: cmdIdx, field: 'name' });
      }
      doc.variables[name] = cmd.value;
      affectedIds.push(`variable:${name}`);
      break;
    }

    case 'dataset-op':
    case 'datasetOp': {
      const op = cmd.op || cmd.operation || 'add';
      if (cmd.dataset) {
        doc.datasets = doc.datasets || {};
        doc.datasets[cmd.dataset] = doc.datasets[cmd.dataset] || { columns: [], rows: [] };
        const ds = doc.datasets[cmd.dataset];
        ds.rows = Array.isArray(ds.rows) ? ds.rows : [];
        if (op === 'add') {
          ds.rows.push(structuredClone(cmd.row || cmd.item || {}));
        } else if (op === 'replace-all') {
          ds.rows = structuredClone(cmd.rows || []);
        } else if (op === 'update') {
          const matchKey = cmd.matchKey || 'id';
          for (const r of ds.rows) {
            if (cmd.matchValue === undefined || String(r[matchKey]) === String(cmd.matchValue)) {
              Object.assign(r, structuredClone(cmd.patch || cmd.row || {}));
            }
          }
        } else if (op === 'delete') {
          const matchKey = cmd.matchKey || 'id';
          ds.rows = ds.rows.filter(r => String(r[matchKey]) !== String(cmd.matchValue));
        } else if (op === 'filter') {
          ds.activeFilter = cmd.filter || cmd.query || null;
        } else if (op === 'sort') {
          ds.activeSort = cmd.sort || null;
          const sortField = cmd.sort?.field || cmd.field;
          const sortDir = (cmd.sort?.direction || cmd.direction) === 'desc' ? -1 : 1;
          if (sortField) {
            ds.rows.sort((a, b) => (a[sortField] > b[sortField] ? sortDir : a[sortField] < b[sortField] ? -sortDir : 0));
          }
        }
        affectedIds.push(`dataset:${cmd.dataset}`);
        break;
      }
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId || cmd.targetId, pageScope, cmdIdx);
      const { node, scopedId } = targetInfo.entry || targetInfo.instanceEntry;
      node.data = Array.isArray(node.data) ? node.data : [];
      if (op === 'add') {
        node.data.push(structuredClone(cmd.row || cmd.item || {}));
      } else if (op === 'replace-all') {
        node.data = structuredClone(cmd.rows || []);
      } else if (op === 'update') {
        const matchKey = cmd.matchKey || 'id';
        for (const r of node.data) {
          if (cmd.matchValue === undefined || String(r[matchKey]) === String(cmd.matchValue)) {
            Object.assign(r, structuredClone(cmd.patch || cmd.row || {}));
          }
        }
      } else if (op === 'delete') {
        const matchKey = cmd.matchKey || 'id';
        node.data = node.data.filter(r => String(r[matchKey]) !== String(cmd.matchValue));
      } else if (op === 'filter') {
        node.activeFilter = cmd.filter || null;
      } else if (op === 'sort') {
        node.activeSort = cmd.sort || null;
        if (cmd.sort?.field) {
          const dir = cmd.sort.direction === 'desc' ? -1 : 1;
          const fld = cmd.sort.field;
          node.data.sort((a, b) => (a[fld] > b[fld] ? dir : a[fld] < b[fld] ? -dir : 0));
        }
      }
      affectedIds.push(scopedId);
      break;
    }

    case 'repeaterSetFilter':
    case 'repeaterSetSort': {
      const target = resolveTargetOrSubnode(doc, index, cmd.nodeId || cmd.repeaterId || cmd.id, pageScope, cmdIdx);
      const node = target.entry.node;
      if (!node || node.type !== 'repeater') {
        throw cmdError('E_REPEATER_REQUIRED', `repeaterSetFilter 需要指向一个 repeater 节点，收到 ${node?.type || 'null'}`, {
          commandIndex: cmdIdx, field: 'nodeId',
        });
      }
      if (cmd.type === 'repeaterSetFilter') {
        if (cmd.clear === true || cmd.filter === null) {
          delete node.filter;
        } else {
          const filter = typeof cmd.filter === 'object' && cmd.filter ? cmd.filter : { field: cmd.field, equals: cmd.value, in: cmd.values };
          if (!filter.field || typeof filter.field !== 'string') {
            throw cmdError('E_FILTER_SHAPE', '过滤器需要 field（字段名）；可选 equals / in 之一', {
              commandIndex: cmdIdx, field: 'filter',
              expected: { field: 'status', equals: '已支付' },
            });
          }
          const hasEquals = filter.equals !== undefined;
          const hasIn = Array.isArray(filter.in);
          if (!hasEquals && !hasIn) {
            throw cmdError('E_FILTER_SHAPE', '过滤器需要 equals 或 in 中的至少一个', { commandIndex: cmdIdx, field: 'filter' });
          }
          node.filter = hasIn
            ? { field: filter.field, in: filter.in.map(String) }
            : { field: filter.field, equals: String(filter.equals) };
        }
      } else {
        if (cmd.clear === true || cmd.sort === null) {
          delete node.sort;
        } else {
          const sort = typeof cmd.sort === 'object' && cmd.sort ? cmd.sort : { field: cmd.field, direction: cmd.direction };
          if (!sort.field) throw cmdError('E_FILTER_SHAPE', '排序需要 field（字段名）', { commandIndex: cmdIdx, field: 'sort' });
          node.sort = { field: String(sort.field), direction: sort.direction === 'desc' ? 'desc' : 'asc' };
        }
      }
      affectedIds.push(`${pageScope}/${node.id}`);
      break;
    }

    case 'setFont': {
      doc.fonts = doc.fonts || { defaultFamily: 'PingFang SC', headingFamily: 'PingFang SC', catalog: [] };
      if (cmd.defaultFamily) doc.fonts.defaultFamily = cmd.defaultFamily;
      if (cmd.headingFamily) doc.fonts.headingFamily = cmd.headingFamily;
      if (cmd.addFont && typeof cmd.addFont === 'object') {
        doc.fonts.catalog = doc.fonts.catalog || [];
        const existingIdx = doc.fonts.catalog.findIndex(f => f.family === cmd.addFont.family);
        if (existingIdx >= 0) doc.fonts.catalog[existingIdx] = structuredClone(cmd.addFont);
        else doc.fonts.catalog.push(structuredClone(cmd.addFont));
      }
      if (cmd.nodeId) {
        const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
        const fontProps = {};
        for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'italic', 'underline', 'align', 'color']) {
          if (cmd[k] !== undefined) fontProps[k] = cmd[k];
        }
        if (Object.keys(fontProps).length > 0) {
          validatePropertiesObject(fontProps, cmd.nodeId, cmdIdx);
        }
        if (targetInfo.isInstanceSubnode) {
          const inst = targetInfo.instanceEntry.node;
          if (inst.locked) {
            throw cmdError('E_NODE_LOCKED', `实例 "${inst.id}" 已锁定，无法修改字体`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
          }
          inst.overrides = inst.overrides || {};
          inst.overrides[targetInfo.subNodeId] = {
            ...(inst.overrides[targetInfo.subNodeId] || {}),
            ...fontProps,
          };
          validateComponentInstanceAgainstContract(inst, doc, { strict: true });
          affectedIds.push(targetInfo.instanceEntry.scopedId);
        } else {
          if (targetInfo.entry.node.locked) {
            throw cmdError('E_NODE_LOCKED', `节点 "${targetInfo.entry.node.id}" 已锁定，无法修改字体`, { commandIndex: cmdIdx, nodeId: cmd.nodeId });
          }
          Object.assign(targetInfo.entry.node, fontProps);
          affectedIds.push(targetInfo.entry.scopedId);
        }
      } else {
        affectedIds.push('fonts');
      }
      break;
    }

    case 'setInteraction': {
      const targetInfo = resolveTargetOrSubnode(doc, index, cmd.nodeId, pageScope, cmdIdx);
      const ev = cmd.event || 'click';
      const rawActs = cmd.actions !== undefined ? cmd.actions : cmd.action;
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
      break;
    }

    case 'addPage': {
      let pageId = cmd.pageId || cmd.id;
      if (!pageId) {
        let n = (doc.pages?.length || 0) + 1;
        while ((doc.pages || []).some(p => p.id === `page_${n}`)) n++;
        pageId = `page_${n}`;
      } else if (cmd.autoUniqueId && (doc.pages || []).some(p => p.id === pageId)) {
        const base = pageId;
        let n = 2;
        while ((doc.pages || []).some(p => p.id === `${base}_${n}`)) n++;
        pageId = `${base}_${n}`;
      } else if ((doc.pages || []).some(p => p.id === pageId)) {
        throw cmdError('E_DUPLICATE_PAGE', `页面 ID "${pageId}" 已存在`, { commandIndex: cmdIdx, field: 'pageId' });
      }
      const lastBoard = doc.pages?.at(-1)?.canvas;
      const domain = cmd.domain || cmd.pageDomain || doc.domain || 'mobile';
      const isWeb = domain !== 'mobile';
      const w = Number(cmd.w || (isWeb ? 1280 : 402));
      const h = Number(cmd.h || (isWeb ? 800 : 874));
      const x = Number.isFinite(cmd.x) ? cmd.x : (lastBoard ? lastBoard.x + lastBoard.w + 120 : 80);
      const y = Number.isFinite(cmd.y) ? cmd.y : (lastBoard ? lastBoard.y : 80);
      doc.pages.push({
        id: pageId,
        name: cmd.name || pageId,
        device: cmd.device !== undefined ? cmd.device : (isWeb ? null : doc.device),
        domain,
        canvas: { x, y, w, h },
        root: cmd.root ? structuredClone(cmd.root) : {
          type: 'box',
          id: `${pageId}_root`,
          name: cmd.name || pageId,
          layout: 'column',
          w,
          h,
          padding: 24,
          gap: 12,
          fill: '$bg',
          children: [],
        },
        interactions: [],
        explorations: [],
      });
      affectedIds.push(pageId);
      break;
    }

    case 'duplicatePage': {
      const srcPage = (doc.pages || []).find(p => p.id === cmd.pageId);
      if (!srcPage) {
        throw cmdError('E_PAGE_NOT_FOUND', `未找到源页面 "${cmd.pageId}"`, { commandIndex: cmdIdx, field: 'pageId' });
      }
      const baseId = cmd.newPageId || `${srcPage.id}_copy`;
      let newPageId = baseId;
      let n = 2;
      while ((doc.pages || []).some(p => p.id === newPageId)) {
        newPageId = `${baseId}_${n++}`;
      }
      const clonePage = structuredClone(srcPage);
      clonePage.id = newPageId;
      clonePage.name = cmd.newName || `${srcPage.name} (${n > 2 ? `副本 ${n - 1}` : '副本'})`;
      const lastBoard = doc.pages.at(-1)?.canvas || srcPage.canvas;
      clonePage.canvas.x = lastBoard.x + lastBoard.w + 120;
      doc.pages.push(clonePage);
      affectedIds.push(newPageId);
      break;
    }

    case 'renamePage': {
      const pg = (doc.pages || []).find(p => p.id === cmd.pageId);
      if (!pg) throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${cmd.pageId}"`, { commandIndex: cmdIdx, field: 'pageId' });
      pg.name = cmd.name;
      affectedIds.push(pg.id);
      break;
    }

    case 'reorderPages': {
      if (!Array.isArray(cmd.pageIds)) {
        throw cmdError('E_INVALID_VALUE', `reorderPages 需要 pageIds 数组`, { commandIndex: cmdIdx, field: 'pageIds' });
      }
      const map = new Map((doc.pages || []).map(p => [p.id, p]));
      const nextPages = [];
      for (const id of cmd.pageIds) {
        if (map.has(id)) {
          nextPages.push(map.get(id));
          map.delete(id);
        }
      }
      for (const rem of map.values()) nextPages.push(rem);
      doc.pages = nextPages;
      affectedIds.push(...cmd.pageIds);
      break;
    }

    case 'deletePage': {
      if ((doc.pages || []).length <= 1) {
        throw cmdError('E_CANNOT_DELETE_LAST_PAGE', `文档至少需保留一个页面`, { commandIndex: cmdIdx, field: 'pageId' });
      }
      const idx = (doc.pages || []).findIndex(p => p.id === cmd.pageId);
      if (idx < 0) throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${cmd.pageId}"`, { commandIndex: cmdIdx, field: 'pageId' });
      if (!cmd.force && !cmd.cascade) {
        const pageLinks = [];
        function scanNodeForPageLink(n, pgId) {
          if (!n || typeof n !== 'object') return;
          if (n.on && typeof n.on === 'object') {
            for (const [, evSpec] of Object.entries(n.on)) {
              const acts = Array.isArray(evSpec) ? evSpec : evSpec?.cases ? evSpec.cases.flatMap(c => c.actions || []) : [evSpec];
              for (const act of acts) {
                if (act && (act.page === cmd.pageId || act.navigate === cmd.pageId || act.target === cmd.pageId)) {
                  pageLinks.push(`${pgId}/${n.id}`);
                }
              }
            }
          }
          for (const ch of n.children || []) scanNodeForPageLink(ch, pgId);
          for (const st of n.states || []) if (st.root) scanNodeForPageLink(st.root, pgId);
        }
        for (const p of doc.pages || []) {
          if (p.id !== cmd.pageId) scanNodeForPageLink(p.root, p.id);
        }
        if (pageLinks.length > 0) {
          throw cmdError(
            'E_DANGLING_REF',
            `无法删除页面 "${cmd.pageId}"：被 ${pageLinks.length} 处跨页交互引用 (${pageLinks.slice(0, 4).join(', ')})；请先解除引用或传入 force: true`,
            { commandIndex: cmdIdx, field: 'pageId', danglingReferences: pageLinks }
          );
        }
      }
      doc.pages.splice(idx, 1);
      affectedIds.push(cmd.pageId);
      break;
    }

    case 'generateExplorations': {
      const targetPageId = cmd.pageId || cmd.targetPageId || 'home';
      const basePage = (doc.pages || []).find(p => p.id === targetPageId) || doc.pages[0];
      if (!basePage) throw cmdError('E_PAGE_NOT_FOUND', `未找到页面 "${targetPageId}"`, { commandIndex: cmdIdx });

      const designBrief = cmd.designBrief || cmd.brief || {
        domain: cmd.domain || doc.domainPreset || doc.meta?.domain || 'birding',
        targetTask: cmd.targetTask,
        targetAudience: cmd.targetAudience,
        styleTone: cmd.styleTone,
        mustKeepModuleIds: cmd.mustKeepModuleIds,
        candidateDirections: cmd.candidateDirections || cmd.directions,
      };
      const generated = generateGeneralExplorations(basePage, doc, designBrief);
      const explorations = Array.isArray(generated) ? generated : generated.explorations;

      // Remove any old exploration pages for this basePage and add the new ones
      doc.pages = doc.pages.filter(p => !p.explorationOf || p.explorationOf !== basePage.id);
      let cursorX = Math.max(...doc.pages.map(p => (p.canvas?.x || 0) + (p.canvas?.w || 402))) + 120;
      for (const exp of explorations) {
        exp.canvas.x = cursorX;
        exp.canvas.y = basePage.canvas?.y || 80;
        cursorX += exp.canvas.w + 100;
        doc.pages.push(exp);
        affectedIds.push(exp.id);
      }

      const usability = validateExplorationsUsability(doc, explorations);
      if (!usability.allUsable || !usability.allPairsStructurallyDistinct) {
        throw cmdError('E_EXPLORATION_USABILITY_FAILED', `视觉探索方案基础可用性或结构差异校验未通过`, {
          commandIndex: cmdIdx,
          usabilityResults: usability,
        });
      }

      basePage.explorations = explorations.map(e => {
        const sf = e.explorationMeta.structuralFeatures || {};
        return {
          id: e.id,
          explorationId: e.id,
          name: e.name,
          title: e.name,
          direction: e.explorationMeta.direction,
          rationale: e.explorationMeta.rationale,
          designBriefSummary: e.explorationMeta.designBriefSummary,
          axes: e.explorationMeta.axes,
          structuralFeatures: sf,
        };
      });
      basePage.explorationStructuralDiffs = usability.pairChecks;
      doc.explorations = structuredClone(basePage.explorations);
      break;
    }

    case 'selectExploration': {
      const targetPageId = cmd.pageId || cmd.targetPageId || 'home';
      const expPageId = cmd.explorationPageId || cmd.explorationId || cmd.id;
      const basePage = (doc.pages || []).find(p => p.id === targetPageId);
      let expPage = (doc.pages || []).find(p => p.id === expPageId);
      if (!expPage && basePage && expPageId) {
        const expList = (doc.pages || []).filter(p => p.explorationOf === basePage.id);
        const lower = String(expPageId).toLowerCase();
        if (lower.endsWith('_exp_a') || lower === 'a' || lower === '0') expPage = expList[0];
        else if (lower.endsWith('_exp_b') || lower === 'b' || lower === '1') expPage = expList[1];
        else if (lower.endsWith('_exp_c') || lower === 'c' || lower === '2') expPage = expList[2];
      }
      if (!basePage || !expPage) {
        throw cmdError('E_PAGE_NOT_FOUND', `未找到主页面 "${targetPageId}" 或方案页面 "${expPageId}"`, { commandIndex: cmdIdx });
      }
      const adoptResult = applySelectedExplorationToPage(basePage, expPage, doc, {
        mode: cmd.mode || (cmd.regionRole || cmd.regionNodeId ? 'region' : 'full-page'),
        regionRole: cmd.regionRole || null,
        regionNodeId: cmd.regionNodeId || null,
      });
      affectedIds.push(basePage.id);
      if (adoptResult.replacedNodeId) {
        affectedIds.push(`${basePage.id}/${adoptResult.replacedNodeId}`);
      }
      break;
    }

    default: {
      const near = VALID_COMMAND_TYPES.filter(t => t.toLowerCase().includes(String(cmd.type).toLowerCase())
        || String(cmd.type).toLowerCase().includes(t.toLowerCase()));
      throw cmdError(
        'E_UNKNOWN_COMMAND_TYPE',
        `未知的命令类型 "${cmd.type}"。${near.length ? `相近类型：${near.join(', ')}。` : ''}可用类型：${VALID_COMMAND_TYPES.join(', ')}`,
        { commandIndex: cmdIdx, field: 'type', validTypes: COMMAND_TYPES_BY_GROUP, suggestions: near }
      );
    }
  }

  return affectedIds;
}

export class StudioDocumentStore {
  constructor(initialDoc, { onCommit = null, maxSnapshots = 120 } = {}) {
    this.doc = structuredClone(initialDoc);
    this.doc.revision = Number(this.doc.revision || 1);
    this.doc.contentHash = computeContentHash(this.doc);
    this.durableRevision = this.doc.revision;
    this.renderedRevisions = new Map(); // sessionId -> { revision, contentHash, updatedAt, fontsReady, assetsReady }
    this.history = []; // committed transactions
    this.transactions = this.history;
    this.redoStack = [];
    this.idempotencyMap = new Map(); // idempotencyKey -> { requestHash, result, timestamp, revision }
    this.idempotencyRecords = this.idempotencyMap;
    this.snapshots = new Map(); // revision -> docClone
    this.maxSnapshots = maxSnapshots;
    this.onCommit = onCommit;
    this._saveSnapshot(this.doc);
  }

  get appliedRevision() {
    return this.doc.revision;
  }

  markDurable(rev = this.doc.revision) {
    this.durableRevision = Number(rev);
    return this.durableRevision;
  }

  _saveSnapshot(docSnap) {
    this.snapshots.set(docSnap.revision, structuredClone(docSnap));
    if (this.snapshots.size > this.maxSnapshots) {
      const oldest = Math.min(...this.snapshots.keys());
      this.snapshots.delete(oldest);
    }
  }

  getSnapshot(revision) {
    if (revision === undefined || revision === null || Number(revision) === this.doc.revision) {
      return structuredClone(this.doc);
    }
    const snap = this.snapshots.get(Number(revision));
    if (!snap) {
      throw Object.assign(
        new Error(`请求的文档历史版本 r${revision} 已不在快照保留窗口内（当前 r${this.doc.revision}）`),
        { code: 'E_REVISION_UNAVAILABLE', requestedRevision: Number(revision), currentRevision: this.doc.revision }
      );
    }
    return structuredClone(snap);
  }

  applyTransaction(request) {
    // 1. Validate request identity and basic structure
    if (!request || typeof request !== 'object') {
      return { ok: false, status: 'failed', code: 'E_INVALID_REQUEST', message: '事务请求必须是非空 JSON 对象' };
    }
    if (request.documentId && request.documentId !== this.doc.documentId) {
      return {
        ok: false,
        status: 'failed',
        code: 'E_DOCUMENT_ID_MISMATCH',
        expectedDocumentId: this.doc.documentId,
        actualDocumentId: request.documentId,
        message: `documentId 不匹配：当前工作台文档为 "${this.doc.documentId}"，请求为 "${request.documentId}"`,
      };
    }
    if (!Array.isArray(request.commands) || request.commands.length === 0) {
      return { ok: false, status: 'failed', code: 'E_EMPTY_COMMANDS', message: '事务 commands 必须是非空数组' };
    }

    const idempotencyKey = request.idempotencyKey ? String(request.idempotencyKey) : null;
    const reqHash = sha256(canonicalJson({
      documentId: this.doc.documentId,
      commands: request.commands,
    }));

    // 2. Check idempotency store BEFORE baseRevision check (Section 7.2 rule!)
    if (idempotencyKey && this.idempotencyMap.has(idempotencyKey)) {
      const prev = this.idempotencyMap.get(idempotencyKey);
      if (prev.requestHash !== reqHash) {
        return {
          ok: false,
          status: 'failed',
          code: 'E_IDEMPOTENCY_CONFLICT',
          idempotencyKey,
          originalRevision: prev.revision,
          message: `幂等键 "${idempotencyKey}" 已被用于不同命令内容的事务 (r${prev.revision})，拒绝重复混用`,
        };
      }
      return {
        ...structuredClone(prev.result),
        ok: true,
        idempotentReplay: true,
      };
    }

    // 3. Check baseRevision precondition
    if (request.baseRevision !== undefined && request.baseRevision !== null) {
      const baseRev = Number(request.baseRevision);
      if (baseRev !== this.doc.revision) {
        const conflictingTxs = this.history
          .filter(h => h.revision > baseRev)
          .map(h => ({
            revision: h.revision,
            txId: h.txId,
            actor: h.actor,
            label: h.label,
            affectedNodeIds: h.affectedNodeIds,
            timestamp: h.timestamp,
          }));
        return {
          ok: false,
          status: 'failed',
          code: 'E_STALE_REVISION',
          baseRevision: baseRev,
          currentRevision: this.doc.revision,
          currentContentHash: this.doc.contentHash,
          conflictingTransactions: conflictingTxs,
          message: `baseRevision 已过期（请求基于 r${baseRev}，当前文档已推进至 r${this.doc.revision}），拒绝覆盖新修改`,
        };
      }
    }

    // 4. Atomic execution on working clone
    const beforeDoc = structuredClone(this.doc);
    let beforeScene = null;
    try {
      beforeScene = resolveDocumentScene(beforeDoc);
    } catch {
      beforeScene = { pages: [] };
    }
    const workingDoc = structuredClone(this.doc);
    const allAffected = new Set();
    const contractEvolutionResults = [];
    let resolvedScene = null;

    try {
      let cachedIndex = buildNodeIndex(workingDoc);
      for (let i = 0; i < request.commands.length; i++) {
        const cmd = request.commands[i];
        if (!cachedIndex) cachedIndex = buildNodeIndex(workingDoc);
        const affected = applySingleCommand(workingDoc, cmd, i, request.pageId || null, cachedIndex, contractEvolutionResults);
        for (const id of affected) allAffected.add(id);
        if (!NON_STRUCTURAL_COMMANDS.has(cmd.type)) {
          cachedIndex = null;
        }
      }
      // Verify the entire document resolves cleanly (catches component cycles, size dependency loops, etc.)
      resolvedScene = resolveDocumentScene(workingDoc);
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        code: err.code || 'E_COMMAND_FAILED',
        failedCommandIndex: err.commandIndex ?? 0,
        nodeId: err.nodeId ?? null,
        field: err.field ?? null,
        suggestion: err.suggestion ?? '请修复失败的命令后重新提交整批事务',
        message: err.message,
        currentRevision: this.doc.revision,
        currentContentHash: this.doc.contentHash,
      };
    }

    // 5. Commit transaction & compute transitive impact + semantic diff
    workingDoc.revision = this.doc.revision + 1;
    workingDoc.updatedAt = new Date().toISOString();
    workingDoc.contentHash = computeContentHash(workingDoc);
    resolvedScene.revision = workingDoc.revision;
    resolvedScene.contentHash = workingDoc.contentHash;

    const impactReport = computeCommandImpactAndDiff({
      beforeDoc,
      afterDoc: workingDoc,
      beforeScene,
      afterScene: resolvedScene,
      commands: request.commands,
      directAffectedIds: [...allAffected],
      contractEvolutionResults,
    });
    const fullAffectedIds = impactReport.transitiveImpact.allAffectedNodeIds.length > 0
      ? impactReport.transitiveImpact.allAffectedNodeIds
      : [...allAffected];

    const txId = `tx_r${workingDoc.revision}_${sha256(`${workingDoc.revision}:${Date.now()}:${idempotencyKey || ''}`).slice(0, 10)}`;
    const txRecord = {
      txId,
      transactionId: txId,
      revision: workingDoc.revision,
      appliedRevision: workingDoc.revision,
      baseRevision: beforeDoc.revision,
      idempotencyKey,
      requestHash: reqHash,
      actor: request.actor || { kind: request.source || 'unknown', id: request.clientId || 'default' },
      label: request.label || impactReport.humanReadableSummary?.whatChanged || `${request.commands[0].type} (${request.commands.length} 项操作)`,
      timestamp: workingDoc.updatedAt,
      commands: structuredClone(request.commands),
      affectedNodeIds: fullAffectedIds,
      directAffectedNodeIds: [...allAffected],
      transitiveImpact: impactReport.transitiveImpact,
      semanticDiff: impactReport.semanticDiff,
      humanReadableSummary: impactReport.humanReadableSummary,
      diagnostics: structuredClone(workingDoc.diagnostics || []),
      beforeContentHash: beforeDoc.contentHash,
      afterContentHash: workingDoc.contentHash,
      contentHash: workingDoc.contentHash,
      beforeSnapshot: beforeDoc,
      afterSnapshot: structuredClone(workingDoc),
    };

    this.doc = workingDoc;
    this.history.push(txRecord);
    this.redoStack = []; // New forward edit invalidates redo branch
    this._saveSnapshot(this.doc);

    const result = {
      ok: true,
      status: 'completed',
      documentId: this.doc.documentId,
      txId,
      transactionId: txId,
      baseRevision: beforeDoc.revision,
      appliedRevision: this.doc.revision,
      durableRevision: this.durableRevision,
      contentHash: this.doc.contentHash,
      affectedNodeIds: fullAffectedIds,
      directAffectedNodeIds: [...allAffected],
      transitiveImpact: impactReport.transitiveImpact,
      semanticDiff: impactReport.semanticDiff,
      humanReadableSummary: impactReport.humanReadableSummary,
      diagnostics: structuredClone(workingDoc.diagnostics || []),
      label: txRecord.label,
      actor: txRecord.actor,
      idempotentReplay: false,
      scene: resolvedScene,
    };

    if (idempotencyKey) {
      const storedRes = { ...result };
      delete storedRes.scene;
      this.idempotencyMap.set(idempotencyKey, {
        requestHash: reqHash,
        revision: this.doc.revision,
        txId,
        timestamp: txRecord.timestamp,
        result: structuredClone(storedRes),
      });
    }

    if (this.onCommit) {
      this.onCommit(txRecord, result);
      result.durableRevision = this.durableRevision;
      if (idempotencyKey && this.idempotencyMap.has(idempotencyKey)) {
        this.idempotencyMap.get(idempotencyKey).result.durableRevision = this.durableRevision;
      }
    }

    return result;
  }

  undo({ expectedRevision = null, expectedHeadTxId = null, actor = { kind: 'human', id: 'default' } } = {}) {
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== this.doc.revision) {
      return {
        status: 'failed',
        code: 'E_UNDO_CONFLICT',
        expectedRevision: Number(expectedRevision),
        currentRevision: this.doc.revision,
        message: `撤销冲突：文档已推进至 r${this.doc.revision}（预期 r${expectedRevision}），拒绝回退他人或后续修改`,
      };
    }
    const headTx = this.history.at(-1);
    if (!headTx) {
      return { status: 'failed', code: 'E_NOTHING_TO_UNDO', currentRevision: this.doc.revision, message: '当前没有可撤销的历史事务' };
    }
    if (expectedHeadTxId && headTx.txId !== expectedHeadTxId) {
      return {
        status: 'failed',
        code: 'E_UNDO_CONFLICT',
        expectedHeadTxId,
        actualHeadTxId: headTx.txId,
        currentRevision: this.doc.revision,
        message: `撤销目标事务 (${expectedHeadTxId}) 不是当前历史头 (${headTx.txId})，为保护其后修改拒绝直接回退`,
      };
    }

    this.history.pop();
    this.redoStack.push(headTx);

    const restored = structuredClone(headTx.beforeSnapshot);
    restored.revision = this.doc.revision + 1;
    restored.updatedAt = new Date().toISOString();
    restored.contentHash = computeContentHash(restored);
    this.doc = restored;
    this._saveSnapshot(this.doc);

    const undoRecord = {
      txId: `undo_r${this.doc.revision}_${headTx.txId}`,
      kind: 'undo',
      undoneTxId: headTx.txId,
      revision: this.doc.revision,
      actor,
      label: `撤销: ${headTx.label}`,
      timestamp: this.doc.updatedAt,
      affectedNodeIds: headTx.affectedNodeIds,
      beforeContentHash: headTx.afterContentHash,
      afterContentHash: this.doc.contentHash,
    };

    const result = {
      ok: true,
      status: 'completed',
      action: 'undo',
      undoneTxId: headTx.txId,
      appliedRevision: this.doc.revision,
      durableRevision: this.durableRevision,
      contentHash: this.doc.contentHash,
      affectedNodeIds: headTx.affectedNodeIds,
      scene: resolveDocumentScene(this.doc),
    };

    if (this.onCommit) {
      this.onCommit(undoRecord, result);
      result.durableRevision = this.durableRevision;
    }
    return result;
  }

  redo({ expectedRevision = null, actor = { kind: 'human', id: 'default' } } = {}) {
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== this.doc.revision) {
      return {
        status: 'failed',
        code: 'E_REDO_CONFLICT',
        expectedRevision: Number(expectedRevision),
        currentRevision: this.doc.revision,
        message: `重做冲突：文档当前版本为 r${this.doc.revision}（预期 r${expectedRevision}）`,
      };
    }
    const nextTx = this.redoStack.pop();
    if (!nextTx) {
      return { status: 'failed', code: 'E_NOTHING_TO_REDO', currentRevision: this.doc.revision, message: '当前没有可重做的事务（或已被新分支覆盖）' };
    }

    const reapplied = structuredClone(nextTx.afterSnapshot);
    reapplied.revision = this.doc.revision + 1;
    reapplied.updatedAt = new Date().toISOString();
    reapplied.contentHash = computeContentHash(reapplied);

    const pushedTx = {
      ...nextTx,
      revision: reapplied.revision,
      beforeSnapshot: structuredClone(this.doc),
      afterSnapshot: structuredClone(reapplied),
    };
    this.history.push(pushedTx);
    this.doc = reapplied;
    this._saveSnapshot(this.doc);

    const redoRecord = {
      txId: `redo_r${this.doc.revision}_${nextTx.txId}`,
      kind: 'redo',
      redoneTxId: nextTx.txId,
      revision: this.doc.revision,
      actor,
      label: `重做: ${nextTx.label}`,
      timestamp: this.doc.updatedAt,
      affectedNodeIds: nextTx.affectedNodeIds,
      beforeContentHash: nextTx.beforeContentHash,
      afterContentHash: this.doc.contentHash,
    };

    const result = {
      ok: true,
      status: 'completed',
      action: 'redo',
      redoneTxId: nextTx.txId,
      appliedRevision: this.doc.revision,
      durableRevision: this.durableRevision,
      contentHash: this.doc.contentHash,
      affectedNodeIds: nextTx.affectedNodeIds,
      scene: resolveDocumentScene(this.doc),
    };

    if (this.onCommit) {
      this.onCommit(redoRecord, result);
      result.durableRevision = this.durableRevision;
    }
    return result;
  }
}

/**
 * 便捷纯函数：在给定文档或 Store 上应用命令事务
 */
export function applyCommandsToDocument(docOrStore, commands, options = {}) {
  const store = docOrStore instanceof StudioDocumentStore
    ? docOrStore
    : new StudioDocumentStore(docOrStore);
  const res = store.applyTransaction({
    baseRevision: options.baseRevision,
    idempotencyKey: options.idempotencyKey,
    actor: options.actor,
    label: options.label,
    pageId: options.pageId,
    commands: Array.isArray(commands) ? commands : [commands],
  });
  return {
    ...res,
    doc: store.doc,
    store,
  };
}

/**
 * 创建原型交互运行时状态（用于验收场景执行器与预览模拟）
 */
export function createRuntimeState(doc) {
  const pages = doc?.pages || [];
  const currentPageId = pages[0]?.id || 'home';
  const variables = structuredClone(doc?.variables || {});
  const panelStates = {};
  const visibility = {};
  const selected = {};
  const datasets = {};

  for (const [dsName, dsDef] of Object.entries(doc?.datasets || {})) {
    const rows = structuredClone(dsDef?.rows || []);
    datasets[dsName] = {
      rows,
      visibleRows: structuredClone(rows),
      filterQuery: '',
      sort: null,
    };
  }

  function scanTree(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'dynamic-panel' && Array.isArray(n.states) && n.states.length > 0) {
      panelStates[n.id] = n.activeState || n.states[0].name || n.states[0].id;
    }
    if (n.hidden === true || n.visible === false) {
      visibility[n.id] = false;
    }
    if (n.selected === true) {
      selected[n.id] = true;
    }
    for (const ch of n.children || []) scanTree(ch);
    for (const st of n.states || []) {
      if (st.root) scanTree(st.root);
      for (const ch of st.children || []) scanTree(ch);
    }
  }
  for (const p of pages) scanTree(p.root);

  return {
    currentPageId,
    variables,
    panelStates,
    visibility,
    selected,
    datasets,
    history: [currentPageId],
  };
}

/**
 * 在原型运行时状态上模拟执行单步交互（click / set-variable / navigate / dataset-filter / dataset-sort 等）
 */
export function applyRuntimeStep(doc, runtime, step = {}) {
  const next = runtime || createRuntimeState(doc);
  const pages = doc?.pages || [];
  const currentPage = pages.find(p => p.id === next.currentPageId) || pages[0];
  const actionType = step.type || step.action;

  if (actionType === 'dataset-filter') {
    const dsName = step.dataset || 'records';
    const ds = next.datasets?.[dsName];
    if (ds) {
      const q = String(step.query ?? '').trim().toLowerCase();
      ds.filterQuery = q;
      ds.visibleRows = q
        ? ds.rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)))
        : structuredClone(ds.rows);
    }
    return next;
  }

  if (actionType === 'dataset-sort') {
    const dsName = step.dataset || 'records';
    const ds = next.datasets?.[dsName];
    if (ds && step.field) {
      const dir = step.direction === 'desc' ? -1 : 1;
      const fld = step.field;
      ds.sort = { field: fld, direction: step.direction || 'asc' };
      ds.visibleRows.sort((a, b) => (a[fld] > b[fld] ? dir : a[fld] < b[fld] ? -dir : 0));
    }
    return next;
  }

  function findNodeById(n, id) {
    if (!n || typeof n !== 'object') return null;
    if (n.id === id) return n;
    for (const ch of n.children || []) {
      const f = findNodeById(ch, id);
      if (f) return f;
    }
    for (const st of n.states || []) {
      if (st.root) {
        const f = findNodeById(st.root, id);
        if (f) return f;
      }
    }
    return null;
  }

  function evalCond(cond) {
    if (!cond || typeof cond !== 'object') return true;
    if (cond.variable) {
      const actual = next.variables[cond.variable];
      if (cond.equals !== undefined) return String(actual ?? '') === String(cond.equals);
      if (cond.notEquals !== undefined) return String(actual ?? '') !== String(cond.notEquals);
      if (cond.notEmpty) return actual !== undefined && actual !== null && String(actual).trim() !== '';
    }
    return true;
  }

  function execActions(actions) {
    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    for (const act of list) {
      if (!act) continue;
      if (typeof act === 'string') {
        next.currentPageId = act;
        next.history.push(act);
        continue;
      }
      const type = act.type || (act.page || act.navigate ? 'link' : act.state ? 'set-panel-state' : '');
      if (type === 'link' || type === 'navigate') {
        const targetPage = act.page || act.navigate || act.target;
        if (targetPage) {
          next.currentPageId = targetPage;
          next.history.push(targetPage);
        }
      } else if (type === 'set-panel-state' || type === 'setPanelState') {
        const target = act.target || act.panel || act.nodeId;
        if (target && act.state) next.panelStates[target] = act.state;
      } else if (type === 'show') {
        if (act.target) next.visibility[act.target] = true;
      } else if (type === 'hide') {
        if (act.target) next.visibility[act.target] = false;
      } else if (type === 'set-variable' || type === 'setVariable') {
        if (act.variable || act.name) next.variables[act.variable || act.name] = act.value;
      } else if (type === 'set-selected' || type === 'setSelected') {
        if (act.target) next.selected[act.target] = Boolean(act.value ?? true);
      }
    }
  }

  if (step.action === 'set-variable') {
    next.variables[step.variable || step.name] = step.value;
  } else if (step.action === 'navigate') {
    next.currentPageId = step.pageId;
    next.history.push(step.pageId);
  } else if (step.action === 'click' || step.nodeId) {
    const targetNode = findNodeById(currentPage?.root, step.nodeId);
    const clickSpec = targetNode?.on?.click;
    if (clickSpec) {
      if (Array.isArray(clickSpec)) {
        execActions(clickSpec);
      } else if (Array.isArray(clickSpec.cases)) {
        for (const c of clickSpec.cases) {
          if (evalCond(c.condition || c.when)) {
            execActions(c.actions);
            break;
          }
        }
      } else {
        execActions([clickSpec]);
      }
    }
  }

  return next;
}
