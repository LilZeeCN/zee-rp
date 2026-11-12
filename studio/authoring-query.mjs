import { buildNodeIndex, canonicalJson, computeContentHash, sha256 } from './document.mjs';
import {nodeCapabilitySummary} from './node-capabilities.mjs';

const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const DEFAULT_LIMIT = 8;
const QUERY_KEYS = ['pageId', 'nodeIds', 'role', 'type', 'textContains', 'within', 'view', 'fields', 'limit'];
const ALLOWED_ARGS = new Set([...QUERY_KEYS, 'nodeId', 'offset', 'cursor', 'url', 'port', 'projectDir']);
const MACRO_TYPES = new Set(['card', 'stat-row', 'list-item', 'phone-shell', 'tab-bar', 'nav-bar', 'progress-bar', 'form-card', 'kv-list', 'detail-card', 'wizard-card', 'master-detail']);

function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('E_QUERY_CURSOR', '查询游标格式无效，请重新查询');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('E_QUERY_CURSOR', '查询游标格式无效，请重新查询'); }
  if (cursor?.version !== 1 || !isObject(cursor.shape) || typeof cursor.binding !== 'string' || !Number.isInteger(cursor.offset) || cursor.offset < 0) fail('E_QUERY_CURSOR', '查询游标格式无效，请重新查询');
  return cursor;
}

function queryShape(args, previous = {}) {
  const shape = { pageId: null, nodeIds: null, role: null, type: null, textContains: null, within: null, view: 'authoring', fields: null, limit: DEFAULT_LIMIT, ...previous };
  for (const key of QUERY_KEYS) if (own(args, key)) shape[key] = args[key];
  if (own(args, 'nodeId')) {
    if (own(args, 'nodeIds')) fail('E_QUERY_SELECTION', 'nodeId 与 nodeIds 不能同时提供');
    shape.nodeIds = [args.nodeId];
  }
  for (const key of ['pageId', 'role', 'type', 'textContains', 'within']) {
    if (shape[key] !== null && (typeof shape[key] !== 'string' || !shape[key].length)) fail('E_QUERY_FIELD', `${key} 必须是非空字符串`);
  }
  if (shape.nodeIds !== null) {
    if (!Array.isArray(shape.nodeIds) || !shape.nodeIds.length || shape.nodeIds.length > 200 || shape.nodeIds.some(id => typeof id !== 'string' || !id)) fail('E_QUERY_SELECTION', 'nodeIds 必须是1–200个非空字符串');
    shape.nodeIds = [...new Set(shape.nodeIds)].sort();
  }
  if (!['authoring', 'full'].includes(shape.view)) fail('E_QUERY_VIEW', 'view 应为 authoring 或 full');
  if (!Number.isInteger(shape.limit) || shape.limit < 1 || shape.limit > 200) fail('E_QUERY_LIMIT', 'limit 应为1–200之间的整数');
  if (shape.fields !== null) {
    if (!Array.isArray(shape.fields) || !shape.fields.length || shape.fields.some(field => typeof field !== 'string' || !field)) fail('E_QUERY_FIELDS', 'fields 必须是非空字段名数组');
    shape.fields = [...new Set(shape.fields)].sort();
  }
  return shape;
}

function sourceEntryFor(node, index) {
  const entry = index.byScopedId.get(node.scopedId);
  return entry?.pageId === node.pageId && entry.node.id === node.id ? entry : null;
}

function ownerEntryFor(id, node, index) {
  const scope = node.scopedId.slice(0, -(node.id.length + 1));
  const entry = index.byScopedId.get(`${scope}/${id}`);
  return entry?.pageId === node.pageId ? entry : null;
}

function instanceTarget(node, source, entries) {
  const metadata = node.componentSource;
  if (!metadata) return null;
  if (source && (source.node.type === 'instance' || source.node.component)) return { entry: source, subNodeId: '$root' };
  const hits = entries.filter(entry => entry.pageId === node.pageId && (entry.node.type === 'instance' || entry.node.component)
    && node.id.startsWith(`${entry.node.id}__`) && node.scopedId === `${entry.scope}/${node.id}`
    && (metadata.instanceId === entry.node.id || String(metadata.instancePath || '').split('/').includes(entry.node.id)));
  if (hits.length !== 1) return null;
  const entry = hits[0];
  let subNodeId = node.id.slice(entry.node.id.length + 2).split('__').join('/');
  if (metadata.isInstanceRoot) subNodeId += '/$root';
  return { entry, subNodeId };
}

function editableInfo(node, index, entries) {
  const source = sourceEntryFor(node, index);
  if (node.controlledByMacro) {
    const owner = ownerEntryFor(node.controlledByMacro, node, index);
    const isMacro = owner && (MACRO_TYPES.has(owner.node.type) || owner.node.macroSource);
    const cardFields = {
      title: { property: 'title', propertyMap: { text: 'title', fontSize: 'titleFontSize' } },
      subtitle: { property: 'subtitle', propertyMap: { text: 'subtitle', fontSize: 'subtitleFontSize' } },
      body: { property: 'body', propertyMap: { text: 'body', fontSize: 'bodyFontSize' } },
      action: { property: 'actionText', propertyMap: { text: 'actionText' } },
      tag: { property: 'tag', propertyMap: { text: 'tag' } },
      right_badge: { property: 'rightBadge', propertyMap: { text: 'rightBadge' } },
    };
    const rightBadgeProp = owner?.node?.rightBadge !== undefined ? 'rightBadge' : 'badge';
    const listItemFields = {
      title: { property: 'title', propertyMap: { text: 'title', fontSize: 'titleFontSize' } },
      sub: { property: 'subtitle', propertyMap: { text: 'subtitle', fontSize: 'subtitleFontSize' } },
      right: { property: 'rightText', propertyMap: { text: 'rightText', fontSize: 'rightFontSize' } },
      badge: { property: rightBadgeProp, propertyMap: { text: rightBadgeProp } },
      right_badge: { property: 'rightBadge', propertyMap: { text: 'rightBadge' } },
      tag: { property: 'tag', propertyMap: { text: 'tag' } },
      idx: { property: 'index', propertyMap: { text: 'index' } },
    };
    const progressFields = {
      label: { property: 'label', propertyMap: { text: 'label' } },
      val: { property: 'value', propertyMap: { text: 'rightText' } },
      bar: { property: 'value', propertyMap: { w: 'value' } },
      fill: { property: 'value', propertyMap: { w: 'value' } },
    };
    const navBarFields = {
      title: { property: 'title', propertyMap: { text: 'title', fontSize: 'titleFontSize' } },
      back: { property: 'backText', propertyMap: { text: 'backText' } },
      right: { property: 'rightText', propertyMap: { text: 'rightText' } },
    };
    const table = isMacro && owner.node.type === 'card'
      ? cardFields
      : isMacro && owner.node.type === 'list-item'
        ? listItemFields
        : isMacro && owner.node.type === 'progress-bar'
          ? progressFields
          : isMacro && owner.node.type === 'nav-bar'
            ? navBarFields
            : null;
    let hit = table ? Object.entries(table).find(([suffix]) => node.id === `${owner.node.id}_${suffix}`)?.[1] : null;
    if (!hit && isMacro && owner.node.type === 'stat-row' && node.id.startsWith(`${owner.node.id}_`) && /^_(?:stat|val|lbl|sub)_\d+$/.test(node.id.slice(owner.node.id.length))) {
      hit = { property: 'items', propertyMap: { text: 'items', fontSize: 'valueFontSize' } };
    } else if (!hit && isMacro && owner.node.type === 'tab-bar' && node.id.startsWith(`${owner.node.id}_tab_`)) {
      hit = { property: 'items', propertyMap: { text: 'items' } };
    }
    const property = hit?.property || null;
    return { source, owner: isMacro ? owner : null, target: {
      kind: property ? 'macro-parameter' : 'controlled', nodeId: isMacro ? owner.scopedId : null,
      ...(property ? { property, propertyMap: hit.propertyMap } : {}), editable: Boolean(property) && !owner.node.locked,
      reason: property ? `此节点由宏生成，修改 ${owner.scopedId}.${property}` : '此节点由宏生成；不能把展开节点当作源节点写入',
    } };
  }
  if (node.componentSource) {
    const mapped = instanceTarget(node, source, entries);
    return { source, owner: mapped?.entry || null, target: {
      kind: mapped ? 'instance-override' : 'controlled', nodeId: mapped?.entry.scopedId || null,
      ...(mapped ? { subNodeId: mapped.subNodeId } : {}), editable: Boolean(mapped) && !mapped.entry.node.locked,
      reason: mapped ? '修改实例覆盖，保留组件定义与其他实例' : '组件展开节点未找到唯一源实例，请先查询其组件与实例定义',
    } };
  }
  return { source, owner: source, target: {
    kind: source ? 'node' : 'controlled', nodeId: source?.scopedId || null,
    editable: Boolean(source) && !source.node.locked,
    reason: source ? '权威文档中的源节点' : '未找到对应源节点，不能直接写入此展开 ID',
  } };
}

const isScalar = value => ['string', 'number', 'boolean'].includes(typeof value);

/** Compact interaction readback: query_nodes fields=[interactions] surfaces what
 * setInteraction / RP/1 insert actually registered. `controls` is a separate edit-
 * constraint list (macro/component/locked/flow-layout/constraint/transform) and is
 * legitimately empty for stack/free children and unconstrained nodes, so `controls=[]`
 * must not be misread as "interaction lost". */
function interactionSummary(node) {
  const on = node?.on;
  if (!on || typeof on !== 'object') return null;
  const events = Object.entries(on).map(([event, spec]) => {
    const actions = Array.isArray(spec) ? spec : spec && typeof spec === 'object' ? [spec] : [];
    return [event, actions.map(action => {
      if (!action || typeof action !== 'object') return { type: 'navigate' };
      const summary = Object.fromEntries(Object.entries(action).filter(([, value]) => isScalar(value)));
      return Object.keys(summary).length ? summary : { type: action.cases ? 'cases' : 'navigate' };
    })];
  });
  return events.length ? Object.fromEntries(events) : null;
}

function suggestedEdit(node, info) {
  if (!info.target.editable) return null;
  const pageId = node.pageId;
  if (info.target.kind === 'macro-parameter') {
    const property = info.target.property;
    return { purpose: '修改宏内容参数', editableFields: [property], command: { type: 'setProperties', pageId, nodeId: info.target.nodeId, properties: { [property]: structuredClone(info.owner.node[property]) } } };
  }
  const properties = typeof node.rawText === 'string' ? { text: node.rawText } : { opacity: node.opacity ?? 1 };
  if (info.target.kind === 'instance-override') return { purpose: '修改此实例的覆盖值', editableFields: Object.keys(properties), command: { type: 'setInstanceOverride', pageId, nodeId: info.target.nodeId, subNodeId: info.target.subNodeId, properties } };
  return { purpose: '修改源节点属性', editableFields: Object.keys(properties), command: { type: 'setProperties', pageId, nodeId: info.target.nodeId, properties } };
}

function authoringNode(node, index, entries, resolvedById) {
  const info = editableInfo(node, index, entries);
  const raw = info.source?.node;
  const parent = resolvedById.get(node.parentScopedId);
  const controls = [];
  const edit = suggestedEdit(node, info);
  if (node.controlledByMacro || node.componentSource) controls.push({ kind: node.controlledByMacro ? 'macro' : 'component', ownerId: info.target.nodeId, reason: info.target.reason, ...(edit ? { suggestion: edit } : {}) });
  if (raw?.locked || info.owner?.node.locked || node.locked) controls.push({ kind: 'locked', ownerId: info.owner?.scopedId || node.scopedId, reason: '节点或控制它的源实例已锁定，请先确认锁定范围' });
  if (parent && ['row', 'column', 'grid'].includes(node.parentLayout)) {
    const parentInfo = editableInfo(parent, index, entries);
    const command = parentInfo.target.editable && parentInfo.target.kind === 'node'
      ? { type: 'setLayout', pageId: node.pageId, nodeId: parentInfo.target.nodeId, layout: { mode: parent.layout, gap: parent.gap } } : null;
    controls.push({ kind: 'flow-layout', ownerId: parent.scopedId, reason: '位置由父容器顺序、gap 与 padding 决定；只改 x/y 不会改变排布',
      ...(command ? { suggestion: { purpose: '调整父容器间距；示例值为当前值', editableFields: ['layout.gap'], command } } : {}) });
  }
  if (raw && ['after', 'alignX', 'pin', 'right', 'bottom'].some(key => raw[key] !== undefined && raw[key] !== null)) controls.push({ kind: 'constraint', ownerId: info.source.scopedId, reason: 'after/alignX/pin决定位置；right/bottom锚定边距，moveNode会更新对应边距，直接写x/y不解除锚定', fields: Object.fromEntries(['after', 'alignX', 'pin', 'right', 'bottom'].filter(key => raw[key] !== undefined).map(key => [key, structuredClone(raw[key])])) });
  let ancestor = node;
  while (ancestor) {
    if (ancestor.css?.transform || ancestor.css?.perspective || ancestor.threeDTransform) {
      controls.push({ kind: 'transform', ownerId: ancestor.scopedId, reason: '坐标平面包含变换；关系移动不可直接套用屏幕坐标，请使用明确的源局部坐标' });
      break;
    }
    ancestor = resolvedById.get(ancestor.parentScopedId);
  }
  const text = String(node.rawText ?? node.text ?? '');
  return {
    id: node.id, scopedId: node.scopedId, pageId: node.pageId, name: node.name, type: node.type, role: node.role,
    text: text.slice(0, 240), ...(text.length > 240 ? { textLength: text.length, textTruncated: true } : {}),
    visible: node.visible, locked: Boolean(node.locked || info.owner?.node.locked),
    bounds: { x: node.x, y: node.y, w: node.w, h: node.h },
    editableTargetId: info.target.nodeId, target: info.target,
    capabilities:nodeCapabilitySummary(node.type,{node:raw,target:info.target,sourceType:info.owner?.node.type}),
    source: info.source ? { nodeId: info.source.scopedId, pointer: info.source.path, type: raw.type,
      properties: Object.fromEntries(['x', 'y', 'w', 'h', 'layout', 'padding', 'gap'].filter(key => raw[key] !== undefined).map(key => [key, structuredClone(raw[key])])) } : null,
    layoutContext: { mode: node.layout, parentId: node.parentScopedId, parentMode: node.parentLayout,
      sourceX: node.sourceX, sourceY: node.sourceY, padding: structuredClone(node.padding ?? 0), parentPadding: parent ? structuredClone(parent.padding ?? 0) : null,
      gap: node.gap ?? 0, coordinates: 'sourceX/sourceY 相对父内容盒，不含父 padding；bounds 是页面屏幕坐标' },
    ...(node.type === 'path' ? {
      vector: {
        svgD: node.svgD || '',
        fillRule: node.fillRule || 'nonzero',
        subpathCount: Array.isArray(node.subpaths) ? node.subpaths.length : 0,
        subpaths: structuredClone(node.subpaths || []),
        viewBox: node.viewBox || null,
        vectorBounds: node.vectorBounds || null,
        strokeLinecap: node.strokeLinecap || 'round',
        strokeLinejoin: node.strokeLinejoin || 'round',
        strokeDasharray: node.strokeDasharray || null,
        smooth: Boolean(node.smooth),
        nativeVectorCompatible: Boolean(node.nativeVectorCompatible),
        vectorFallbackReasons: structuredClone(node.vectorFallbackReasons || []),
      },
    } : {}),
    controls, interactions: interactionSummary(raw),
    ...(edit && !controls.some(control => control.kind === 'locked') ? { suggestedEdit: edit } : {}),
  };
}

/** Read the same authored document and resolved scene used by the command bus. */
export function queryAuthoringNodes({ doc, scene, args = {} }) {
  if (!isObject(args)) fail('E_QUERY_FIELD', '查询参数必须是对象');
  for (const key of Object.keys(args)) if (!ALLOWED_ARGS.has(key)) fail('E_QUERY_FIELD', `未知查询字段 ${key}`);
  if (!doc || !Array.isArray(scene?.pages)) fail('E_QUERY_DOCUMENT', '查询需要当前权威文档与解算场景');
  if (scene.revision !== doc.revision) fail('E_STALE_SCENE', '场景与文档版本不一致，请重新读取当前场景');
  const cursor = args.cursor === undefined ? null : decodeCursor(args.cursor);
  if (cursor && own(args, 'offset')) fail('E_QUERY_CURSOR', 'cursor 与 offset 不能同时提供');
  const shape = queryShape(args, cursor?.shape);
  if (cursor && canonicalJson(shape) !== canonicalJson(cursor.shape)) fail('E_QUERY_CURSOR_MISMATCH', '游标对应的查询条件已变化，请重新查询');
  const binding = sha256(canonicalJson({ documentId: doc.documentId, revision: doc.revision, contentHash: doc.contentHash || computeContentHash(doc) }));
  if (cursor && cursor.binding !== binding) fail('E_STALE_QUERY_CURSOR', '文档已变化或游标属于其他工程，请从当前版本重新查询', { currentRevision: doc.revision });
  const offset = cursor?.offset ?? args.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) fail('E_QUERY_OFFSET', 'offset 必须是非负整数');
  if (shape.pageId && !scene.pages.some(page => page.id === shape.pageId)) fail('E_PAGE_NOT_FOUND', `页面不存在：${shape.pageId}`);
  const all = scene.pages.flatMap(page => page.nodes);
  const resolvedById = new Map(all.map(node => [node.scopedId, node]));
  let nodes = shape.pageId ? all.filter(node => node.pageId === shape.pageId) : all;
  const one = id => {
    const matches = nodes.filter(node => node.scopedId === id || node.id === id);
    if (matches.length !== 1) fail(matches.length ? 'E_AMBIGUOUS_NODE' : 'E_NODE_NOT_FOUND', matches.length ? `节点 ${id} 不唯一，请使用 scopedId` : `当前查询范围中没有节点 ${id}`, { candidates: matches.map(node => node.scopedId) });
    return matches[0];
  };
  const selected = shape.nodeIds?.map(one);
  const within = shape.within ? one(shape.within) : null;
  if (selected) nodes = selected;
  if (within) nodes = nodes.filter(node => {
    let parent = resolvedById.get(node.parentScopedId);
    while (parent) {
      if (parent.scopedId === within.scopedId) return true;
      parent = resolvedById.get(parent.parentScopedId);
    }
    return false;
  });
  for (const key of ['role', 'type', 'textContains']) if (shape[key] !== null) nodes = nodes.filter(node => key === 'textContains'
    ? String(node.rawText ?? node.text ?? '').includes(shape[key]) : node[key] === shape[key]);
  const total = nodes.length;
  const sourceIndex = buildNodeIndex(doc);
  const entries = [...new Set(sourceIndex.byScopedId.values())];
  const available = new Set(['id', 'scopedId', 'pageId', 'name', 'type', 'role', 'text', 'textLength', 'textTruncated', 'visible', 'locked', 'bounds', 'editableTargetId', 'target', 'capabilities', 'source', 'layoutContext', 'vector', 'controls', 'interactions', 'suggestedEdit']);
  if (shape.view === 'full') { available.clear(); available.add('authoring'); for (const node of all) for (const key of Object.keys(node)) available.add(key); }
  if (shape.fields) for (const field of shape.fields) if (!available.has(field)) fail('E_QUERY_FIELDS', `当前 ${shape.view} 视图没有字段 ${field}`, { candidates: [...available].sort() });
  const result = nodes.slice(offset, offset + shape.limit).map(node => {
    const authoring = authoringNode(node, sourceIndex, entries, resolvedById);
    const value = shape.view === 'full' ? { ...structuredClone(node), authoring } : authoring;
    return shape.fields ? Object.fromEntries([...new Set(['id', 'scopedId', 'pageId', ...shape.fields])].filter(key => value[key] !== undefined).map(key => [key, value[key]])) : value;
  });
  const nextOffset = offset + result.length;
  const nextCursor = nextOffset < total ? Buffer.from(JSON.stringify({ version: 1, binding, shape, offset: nextOffset })).toString('base64url') : null;
  return { ok: true, view: shape.view, pageId: shape.pageId, revision: doc.revision, contentHash: doc.contentHash || null,
    total, returned: result.length, offset, limit: shape.limit, nextCursor, empty: total === 0,
    ...(total === 0 ? { message: '当前页面和筛选条件没有匹配节点；查询范围未扩大' } : {}), nodes: result };
}
