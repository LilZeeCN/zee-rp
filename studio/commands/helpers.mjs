// 命令层共享纯函数:错误构造、属性/交互/树校验、目标解析与几何辅助。
// 全部为模块级纯函数(收 doc/index/cmd),从 commands.mjs 原样迁移。
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_NODE_TYPES } from './taxonomy.mjs';
import { normalizeInteractionSpec } from '../interactions.mjs';
import { NODE_PROPERTY_NAMES, NODE_READONLY_PROPERTIES, NODE_UNCONSUMED_PROPERTIES, NODE_SYNTAX_ONLY_PROPERTIES, propertySuggestions } from '../node-properties.mjs';
import { normalizeVisualCss } from '../visual-style.mjs';
import { normalizeVectorNodeSpec } from '../vector-paths.mjs';
import { assertKnownNodeEffects, assertCanvasNodeType } from '../node-capabilities.mjs';
import { resolveDocumentScene, parsePadding } from '../scene-resolver.mjs';

export const EXPRESSION_CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/rp-expression-check.py');

export function cmdError(code, message, { commandIndex = 0, nodeId = null, field = null, suggestion = null, extra = {} } = {}) {
  return Object.assign(new Error(message), {
    code,
    commandIndex,
    nodeId,
    field,
    suggestion,
    ...extra,
  });
}

export function validateInteractionAssignments(spec, doc, cmdIdx, nodeId) {
        spec = normalizeInteractionSpec(spec);
        const formulaChecks = [];
        const rpType = value => typeof value === 'string' ? 'text' : typeof value;
        const variableTypes = Object.fromEntries(Object.entries(doc.variables || {}).map(([name, declared]) => {
          const value = declared && typeof declared === 'object' && 'value' in declared ? declared.value : declared;
          return [name, rpType(value)];
        }));
        const validateAssignment = (name, value) => {
          if (!name) throw cmdError('E_INTERACTION_ACTION', 'set-var 动作缺少 variable/name 字段', { commandIndex: cmdIdx, nodeId: nodeId, field: 'name' });
          if (!Object.hasOwn(doc.variables || {}, name)) throw cmdError('E_VARIABLE', `set-var 目标变量 "${name}" 未声明`, { commandIndex: cmdIdx, nodeId: nodeId, field: name, suggestion: `先用 set-variable 声明变量 ${name}` });
          const declared = doc.variables[name];
          const declaredValue = declared && typeof declared === 'object' && 'value' in declared ? declared.value : declared;
          const expected = rpType(declaredValue);
          const isFormula = typeof value === 'string' && value.trim().startsWith('=');
          let actual = rpType(value);
          if (isFormula) {
            const body = value.trim().slice(1).trim();
            if (/^(true|false)$/.test(body)) actual = 'boolean';
            else if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(body)) actual = 'number';
            else {
              actual = null;
              formulaChecks.push({ expr: value, expected, variables: variableTypes });
            }
          }
          if (actual !== null && actual !== expected) {
            throw cmdError('E_TYPE', `set-var 目标变量 "${name}" 声明为 ${expected}，收到 ${actual}`, {
              commandIndex: cmdIdx, nodeId: nodeId, field: `${name}.value`, extra: { expected, actual },
              suggestion: `请提供 ${expected} 类型的字面量或可计算的表达式`,
            });
          }
        };
        const visit = (spec, path = 'on') => {
          if (Array.isArray(spec)) { spec.forEach((item, i) => visit(item, `${path}/${i}`)); return; }
          if (!spec || typeof spec !== 'object') return;
          if (spec.when !== undefined) {
            if (typeof spec.when === 'string' && spec.when.trim().length > 1) formulaChecks.push({ expr: spec.when, expected: 'boolean', variables: variableTypes, field: `${path}/when` });
            else if (typeof spec.when !== 'boolean') throw cmdError('E_CONDITION', '交互条件需要布尔值或布尔表达式，例如 =$index === 1', { commandIndex: cmdIdx, nodeId, field: `${path}/when`, suggestion: '使用 when:"=$index === 1"；兜底分支使用 else:true' });
          }
          if (spec.type === 'set-var' || spec.type === 'set-variable') validateAssignment(spec.variable || spec.name, spec.value ?? spec.expr);
          if (spec.setVar && typeof spec.setVar === 'object') for (const [name, value] of Object.entries(spec.setVar)) validateAssignment(name, value);
          const text = spec.type === 'set-text' ? spec.text ?? spec.value : undefined;
          if (typeof text === 'string' && text.trim().startsWith('=')) formulaChecks.push({ expr: text, variables: variableTypes, field: `${path}/text` });
          for (const key of ['cases', 'actions', 'then', 'else']) visit(spec[key], `${path}/${key}`);
        };
        visit(spec);
        if (formulaChecks.length) {
          const checked = spawnSync('python3', [EXPRESSION_CHECKER], {
            input: JSON.stringify({ expressions: formulaChecks }),
            encoding: 'utf8',
          });
          if (checked.status !== 0) {
            let detail = null;
            try { detail = JSON.parse(checked.stdout.trim()); } catch {}
            const code = detail?.code || 'E_INVALID_VALUE';
            throw cmdError(code, detail?.message || checked.stderr.trim() || '变量表达式未通过 RP/1 语法检查', {
              commandIndex: cmdIdx,
              nodeId,
              field: formulaChecks[detail?.index]?.field ?? null,
              suggestion: '使用变量、@控件读数、文本/数字转换函数和允许的运算；同一表达式必须能被画布运行态与 RP/1 导出共同执行',
            });
          }
        }
}

export function validatePropertiesObject(props, nodeId, cmdIdx, {creation=false,historical=false}={}) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    throw cmdError('E_INVALID_PROPERTIES', `命令 #${cmdIdx} properties 必须是非空对象`, { commandIndex: cmdIdx, nodeId, field: 'properties' });
  }
  if(!creation&&!Object.keys(props).length)throw cmdError('E_EMPTY_PROPERTIES','改属性需要至少一个明确字段；未提交空修改',{commandIndex:cmdIdx,nodeId});
  const readOnly=Object.keys(props).find(key=>NODE_READONLY_PROPERTIES.has(key));
  if(!creation&&readOnly)throw cmdError('E_READONLY_PROPERTY',`属性 ${readOnly} 是稳定标识或源控制信息，不能作为普通属性覆盖`,{commandIndex:cmdIdx,nodeId,field:readOnly,suggestion:'显示名称用renameNode，样式和文案使用查询返回的源目标；不要改节点ID或内部控制标记。'});
  const unconsumed=Object.keys(props).find(key=>NODE_UNCONSUMED_PROPERTIES.has(key));
  if(unconsumed&&!historical)throw cmdError('E_UNCONSUMED_PROPERTY',NODE_SYNTAX_ONLY_PROPERTIES.has(unconsumed)?`${unconsumed}是节点声明的语法键，不是可写属性；请用type声明节点或使用RP/1片段`:`属性 ${unconsumed} 没有画布或运行态消费，未保存无效值`,{commandIndex:cmdIdx,nodeId,field:unconsumed,suggestion:NODE_SYNTAX_ONLY_PROPERTIES.has(unconsumed)?'例如node:{type:"box",id:"stable_id",children:[...]}；不要把box/row/card作为节点属性。':'repeater筛选/排序使用repeaterSetFilter/repeaterSetSort；运行中的数据变化使用受支持的dataset交互。'});
  if(props.overrides&&typeof props.overrides==='object')for(const value of Object.values(props.overrides))if(!value||typeof value!=='object'||Object.keys(value).length)validatePropertiesObject(value,nodeId,cmdIdx,{historical});
  const unknownKeys = Object.keys(props).filter(k => !NODE_PROPERTY_NAMES.has(k));
  if ('css' in props) normalizeVisualCss(props.css);
  if (unknownKeys.length > 0) {
    const candidates = propertySuggestions(unknownKeys[0]);
    throw cmdError('E_UNKNOWN_PROPERTY', `命令 #${cmdIdx} 包含未知属性: ${unknownKeys.join(', ')}${candidates.length ? `；是否想用 ${candidates.join(' / ')}？` : ''}`, {
      commandIndex: cmdIdx, nodeId, field: unknownKeys[0], extra: { candidates },
      suggestion: '调用 studio_describe(topic:"node") 查看可写属性；整批命令未应用。',
    });
  }
  if ('rotation' in props) {
    const rot = props.rotation;
    if (typeof rot !== 'number' || !Number.isFinite(rot)) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的旋转 rotation=${JSON.stringify(rot)} 必须是有限数值（度）`, {
        commandIndex: cmdIdx, nodeId, field: 'rotation', suggestion: '请提供数值角度，如 15、-30、180；画布旋转手柄与原生导出均消费该属性',
      });
    }
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
  for(const fontKey of ['fontSize','titleFontSize','valueFontSize'])if (fontKey in props) {
    const fs = props[fontKey];
    if (!(fontKey==='fontSize'&&typeof fs === 'string' && fs.startsWith('$')) && (typeof fs !== 'number' || !Number.isFinite(fs) || fs <= 0 || fs > 120)) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的字号 ${fontKey}=${JSON.stringify(fs)} 必须在 (0, 120] 范围内`, {
        commandIndex: cmdIdx, nodeId, field: fontKey, suggestion: '请提供 10~120 之间的正数',
      });
    }
  }
  if(Array.isArray(props.items))for(const [itemIndex,item]of props.items.entries())if(item&&typeof item==='object'&&'valueFontSize'in item){
    try{validatePropertiesObject({valueFontSize:item.valueFontSize},nodeId,cmdIdx,{creation:true,historical});}
    catch(error){error.field=`items[${itemIndex}].valueFontSize`;throw error;}
  }
  for (const gapKey of ['gap','rowGap','columnGap']) if (gapKey in props) {
    const g = props[gapKey];
    if (!(typeof g === 'string' && g.startsWith('$')) && (typeof g !== 'number' || !Number.isFinite(g) || g < 0)) {
      throw cmdError('E_INVALID_VALUE', `节点 "${nodeId}" 的间距 ${gapKey}=${JSON.stringify(g)} 必须是非负数值`, {
        commandIndex: cmdIdx, nodeId, field: gapKey,
      });
    }
  }
  for (const key of ['columns','colSpan','rowSpan']) if (key in props && (!Number.isInteger(props[key]) || props[key] < 1)) throw cmdError('E_INVALID_VALUE',`${key}必须是正整数`,{commandIndex:cmdIdx,nodeId,field:key});
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
          commandIndex: cmdIdx, nodeId, field: colorKey,
          suggestion: '请使用 #RRGGBB、#RRGGBBAA、rgba(...) 或 $token 引用；fill/stroke/color 不支持 linear-gradient 等渐变串——需要渐变请写节点 gradient 属性（浏览器涂装层）或 css.background',
        });
      }
    }
  }
  if ('points' in props && props.points !== null && props.points !== undefined) {
    try {
      normalizeVectorNodeSpec({ points: props.points, w: props.w, h: props.h, smooth: props.smooth });
    } catch (err) {
      throw cmdError(err.code || 'E_INVALID_VECTOR', `节点 "${nodeId}" 的路径数据非法: ${err.message}`, {
        commandIndex: cmdIdx, nodeId, field: err.field || 'points',
      });
    }
  }
}

export function findDanglingReferences(doc, deletedNodeId) {
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

export function resolveTargetOrSubnode(doc, index, rawNodeId, preferredPageId, cmdIdx) {
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

export function applyChildConstraintsOnResize(containerNode, oldW, oldH, newW, newH) {
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

// T-I-1：stack（自由定位）容器收到多个未带 x/y 的子节点时，插入后会全部静默堆叠在
// 内容盒原点（gap 不生效）。在事务诊断中显式报错，让调用方在读回/回放前就能发现。
export function stackUnplacedChildDiagnostics(commands, fallbackPageId = null) {
  const out = [];
  const walk = (node, pageId) => {
    if (!node || typeof node !== 'object') return;
    const children = Array.isArray(node.children) ? node.children : [];
    if (node.layout === 'stack' && children.length >= 2) {
      const unplaced = children.filter(child => typeof child?.x !== 'number' || typeof child?.y !== 'number');
      if (unplaced.length >= 2) out.push({
        severity: 'error',
        code: 'E_STACK_CHILDREN_UNPLACED',
        pageId,
        nodeId: node.id,
        message: `stack（自由定位）容器 ${node.id} 有 ${unplaced.length} 个子节点未提供 x/y，插入后将堆叠在内容盒原点、互相遮挡`,
        suggestion: '如需自动排布请改用 layout=column（配合 gap），或为每个子节点提供 x/y',
      });
    }
    for (const child of children) walk(child, pageId);
    for (const state of node.states || []) if (state?.root) walk(state.root, pageId);
  };
  for (const cmd of commands || []) if (cmd?.type === 'addNode' && cmd.node) walk(cmd.node, cmd.pageId || fallbackPageId);
  return out;
}

// 画布坐标合理上限：超出视为把节点推离可视区的脏坐标（与负尺寸 E_INVALID_VALUE 校验对齐）。
export const COORD_LIMIT = 1e6;
export function assertCoordinateBounds(value, field, cmdIdx, nodeId) {
  if (typeof value === 'number' && Math.abs(value) > COORD_LIMIT) {
    throw cmdError('E_INVALID_VALUE', `坐标 ${field}=${value} 超出合理范围（绝对值上限 ${COORD_LIMIT}）`, {
      commandIndex: cmdIdx, nodeId, field, suggestion: `请提供 -${COORD_LIMIT} ~ ${COORD_LIMIT} 范围内的坐标`,
    });
  }
}

export function applyNodePosition(doc, entry, command, sceneOptions = {}) {
  const node = entry.node;
  const anchored = typeof node.right === 'number' || typeof node.bottom === 'number';
  const scene = anchored ? resolveDocumentScene(doc, sceneOptions) : null;
  const resolved = scene?.nodesByScopedId[entry.scopedId];
  const parent = resolved && scene.nodesByScopedId[resolved.parentScopedId];
  const padding = parsePadding(parent?.padding);
  const x = typeof command.x === 'number' ? command.x : typeof command.deltaX === 'number' ? (resolved?.sourceX ?? Number(node.x || 0)) + command.deltaX : null;
  const y = typeof command.y === 'number' ? command.y : typeof command.deltaY === 'number' ? (resolved?.sourceY ?? Number(node.y || 0)) + command.deltaY : null;
  if (x !== null) {
    node.x = Math.round(x);
    if (parent && typeof node.right === 'number') node.right = Math.round(parent.w-padding[1]-padding[3]-resolved.w-x);
  }
  if (y !== null) {
    node.y = Math.round(y);
    if (parent && typeof node.bottom === 'number') node.bottom = Math.round(parent.h-padding[0]-padding[2]-resolved.h-y);
  }
}

export function validateAuthoredTree(node, cmdIdx, {historical=false}={}) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw cmdError('E_INVALID_NODE', '节点需要对象', {commandIndex:cmdIdx});
  if (node.type === 'svg' || node.type === 'sparkline') node.type = 'path';
  if (node.type !== undefined && !VALID_NODE_TYPES.has(node.type)) throw cmdError('E_NODE_TYPE', `未知节点类型 ${node.type}；可用类型：${[...VALID_NODE_TYPES].join(', ')}`, {commandIndex:cmdIdx,nodeId:node.id,extra:{candidates:[...VALID_NODE_TYPES].sort()}});
  validatePropertiesObject(Object.fromEntries(Object.entries(node).filter(([key]) => !['type','id','sourcePointer'].includes(key))),node.id,cmdIdx,{creation:true,historical});
  if (node.type === 'path' && (node.content !== undefined || node.points !== undefined)) {
    try {
      normalizeVectorNodeSpec(node);
    } catch (err) {
      throw cmdError(err.code || 'E_INVALID_VECTOR', `节点 "${node.id}" 的矢量路径语法或属性非法: ${err.message}`, {
        commandIndex: cmdIdx, nodeId: node.id, field: err.field || (node.points !== undefined ? 'points' : 'content'),
      });
    }
  }
  if(!historical){assertCanvasNodeType(node,{commandIndex:cmdIdx});if(!node.component)assertKnownNodeEffects(node,node,{commandIndex:cmdIdx,nodeId:node.id});}
  for (const key of ['children','states']) if (node[key] !== undefined && !Array.isArray(node[key])) throw cmdError('E_INVALID_NODE', `${key}需要数组`, {commandIndex:cmdIdx,nodeId:node.id,field:key});
  for (const child of node.children || []) validateAuthoredTree(child,cmdIdx,{historical});
  for (const state of node.states || []) {if(!state?.id || !state.root) throw cmdError('E_INVALID_NODE','状态需要id和root',{commandIndex:cmdIdx,nodeId:node.id});validateAuthoredTree(state.root,cmdIdx,{historical});}
  if (node.template) validateAuthoredTree(node.template,cmdIdx,{historical});
}

// 同一事务内显式设定过宽度（resizeNode/setProperties w）的标记；不可枚举，不进内容哈希，
// structuredClone 天然丢弃，作用域即当前事务。显式自动宽度据此尊重事务内宽度。
export function markExplicitWidth(node) {
  try {
    Object.defineProperty(node, '_explicitWSet', { value: true, enumerable: false, configurable: true });
  } catch {}
}

// 以自有数据属性写入用户可控键名(令牌名/变量名/组件 id/数据集名/数据行键)。
// 普通赋值 `target[key] = value` 在 key === '__proto__' 时走继承 setter,会把目标对象
// 的原型改写为 value(局部原型污染:内容哈希看不到、运行期读取被劫持)。
// defineProperty 恒为自有属性,JSON 序列化与内容哈希一致。扫荡门禁 M-SWEEP 固化该性质。
export function defineRecordEntry(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
