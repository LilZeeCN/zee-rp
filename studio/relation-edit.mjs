import { buildNodeIndex } from './document.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';

const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const finite = (value, name) => {
  if (!Number.isFinite(value)) fail('E_RELATION_VALUE', `${name} 必须是有限数字`);
  return value;
};

// Compile intent to the existing primitive command bus; no second document or writer.
export function resolveNodeEdits(doc, command, preferredPageId = null) {
  const commandFields = new Set(['type', 'pageId', 'select', 'operation', 'properties', 'dx', 'dy', 'edge', 'referenceId', 'side', 'gap', 'axis']);
  for (const key of Object.keys(command)) if (!commandFields.has(key)) fail('E_RELATION_FIELD', `未知 editNodes 参数 ${key}`);
  const select = command.select;
  if (!select || typeof select !== 'object' || Array.isArray(select)) fail('E_SELECTION_REQUIRED', 'editNodes 需要 select（nodeIds、role、type、textContains 或 within）');
  const allowed = new Set(['pageId', 'nodeIds', 'role', 'type', 'textContains', 'within']);
  for (const key of Object.keys(select)) if (!allowed.has(key)) fail('E_SELECTION_FIELD', `未知选择条件 ${key}`);
  if (!['nodeIds', 'role', 'type', 'textContains', 'within'].some(key => select[key] !== undefined)) fail('E_SELECTION_REQUIRED', '需要明确节点或筛选条件，不能只传 pageId');
  const scene = resolveDocumentScene(doc);
  const pageId = select.pageId || command.pageId || preferredPageId;
  if (pageId && !scene.pages.some(p => p.id === pageId)) fail('E_PAGE_NOT_FOUND', `页面不存在：${pageId}`);
  const all = scene.pages.flatMap(p => p.nodes);
  const scope = pageId ? all.filter(n => n.pageId === pageId) : all;
  function one(id, nodes = scope) {
    const hits = nodes.filter(n => n.scopedId === id || n.id === id || `${n.pageId}/${n.id}` === id);
    if (hits.length !== 1) fail(hits.length ? 'E_AMBIGUOUS_NODE' : 'E_NODE_NOT_FOUND', `节点 ${id} ${hits.length ? '不唯一，请用 scopedId' : '不存在'}`, { candidates: hits.map(n => n.scopedId) });
    return hits[0];
  }
  let nodes = scope;
  if (select.nodeIds !== undefined) {
    if (!Array.isArray(select.nodeIds) || !select.nodeIds.length || select.nodeIds.some(id => typeof id !== 'string' || !id)) fail('E_SELECTION_REQUIRED', 'nodeIds 必须是非空字符串数组');
    nodes = [...new Set(select.nodeIds)].map(id => one(id));
  }
  if (select.within !== undefined) {
    const parent = one(select.within);
    const byId = new Map(all.map(n => [n.scopedId, n]));
    nodes = nodes.filter(n => {
      let p = byId.get(n.parentScopedId);
      while (p) { if (p.scopedId === parent.scopedId) return true; p = byId.get(p.parentScopedId); }
      return false;
    });
  }
  for (const key of ['role', 'type', 'textContains']) {
    if (select[key] !== undefined) {
      if (typeof select[key] !== 'string' || !select[key]) fail('E_SELECTION_FIELD', `${key} 必须是非空字符串`);
      nodes = nodes.filter(n => key === 'textContains' ? String(n.rawText ?? n.text ?? '').includes(select[key]) : n[key] === select[key]);
    }
  }
  if (!nodes.length) fail('E_SELECTION_EMPTY', '选择条件没有匹配节点');
  const primitive = (n, type, props) => ({ type, pageId: n.pageId, nodeId: n.scopedId, ...props });
  if (command.operation === 'set') {
    if (!command.properties || typeof command.properties !== 'object' || Array.isArray(command.properties) || !Object.keys(command.properties).length) fail('E_INVALID_PROPERTIES', '批量修改需要非空 properties');
    for (const key of ['id', 'type', 'children', 'states', 'template']) if (key in command.properties) fail('E_RELATION_FIELD', `批量样式不能修改结构字段 ${key}`);
    return nodes.map(n => primitive(n, 'setProperties', { properties: command.properties }));
  }
  const pages = new Set(nodes.map(n => n.pageId));
  if (pages.size !== 1) fail('E_RELATION_PAGE', '位置关系要求节点位于同一页面；跨页批量样式请用 operation:set');
  const byId = new Map(all.map(n => [n.scopedId, n]));
  const sourceIndex = buildNodeIndex(doc);
  const selected = new Set(nodes.map(n => n.scopedId));
  for (const n of nodes) {
    const raw = sourceIndex.byScopedId.get(n.scopedId)?.node;
    if (raw?.after || raw?.alignX || raw?.pin) fail('E_RELATION_CONSTRAINT', `节点 ${n.id} 受 after/alignX/pin 控制，请先显式解除定位约束`);
    if (!n.parentId || !['stack', 'free'].includes(n.parentLayout)) fail('E_RELATION_LAYOUT', `节点 ${n.id} 不是自由布局子项，请调整容器顺序/gap 或显式切换布局`, { nodeId: n.id });
    let p = byId.get(n.parentScopedId);
    while (p) { if (selected.has(p.scopedId)) fail('E_RELATION_NESTED', '不能同时定位父节点和它的后代'); p = byId.get(p.parentScopedId); }
  }
  function checkGeometry(n) {
    let p = n;
    while (p) {
      if (p.css?.transform || p.css?.perspective || p.threeDTransform) fail('E_RELATION_TRANSFORM', `节点 ${n.id} 的坐标平面包含变换，请使用显式局部坐标`, { nodeId: n.id });
      p = byId.get(p.parentScopedId);
    }
  }
  nodes.forEach(checkGeometry);
  function move(n, x = n.x, y = n.y) {
    return primitive(n, 'moveNode', { x: Math.round(n.sourceX + x - n.x), y: Math.round(n.sourceY + y - n.y) });
  }
  if (command.operation === 'move') {
    const dx = finite(command.dx ?? 0, 'dx'), dy = finite(command.dy ?? 0, 'dy');
    return nodes.map(n => move(n, n.x + dx, n.y + dy));
  }
  let reference = null;
  if (command.referenceId) {
    reference = one(command.referenceId, all.filter(n => n.pageId === nodes[0].pageId));
    checkGeometry(reference);
    // Moving a reference ancestor/descendant would invalidate the solved relation.
    for (const n of nodes) {
      let p = reference;
      while (p) { if (p.scopedId === n.scopedId) fail('E_RELATION_REFERENCE', '参照节点不能在移动的节点内部或选中集合中'); p = byId.get(p.parentScopedId); }
    }
  }
  if (command.operation === 'align') {
    const edge = command.edge;
    if (!['left', 'right', 'top', 'bottom', 'center-x', 'center-y'].includes(edge)) fail('E_RELATION_VALUE', 'edge 应为 left/right/top/bottom/center-x/center-y');
    const bounds = reference || { x: Math.min(...nodes.map(n => n.x)), y: Math.min(...nodes.map(n => n.y)),
      w: Math.max(...nodes.map(n => n.x + n.w)) - Math.min(...nodes.map(n => n.x)),
      h: Math.max(...nodes.map(n => n.y + n.h)) - Math.min(...nodes.map(n => n.y)) };
    return nodes.map(n => move(n,
      edge === 'left' ? bounds.x : edge === 'right' ? bounds.x + bounds.w - n.w : edge === 'center-x' ? bounds.x + (bounds.w - n.w) / 2 : n.x,
      edge === 'top' ? bounds.y : edge === 'bottom' ? bounds.y + bounds.h - n.h : edge === 'center-y' ? bounds.y + (bounds.h - n.h) / 2 : n.y));
  }
  if (command.operation === 'place') {
    if (!reference) fail('E_RELATION_REFERENCE', '相对放置需要 referenceId');
    const gap = finite(command.gap ?? 0, 'gap');
    if (!['below', 'above', 'left', 'right'].includes(command.side)) fail('E_RELATION_VALUE', 'side 应为 below/above/left/right');
    return nodes.map(n => move(n,
      command.side === 'left' ? reference.x - gap - n.w : command.side === 'right' ? reference.x + reference.w + gap : n.x,
      command.side === 'above' ? reference.y - gap - n.h : command.side === 'below' ? reference.y + reference.h + gap : n.y));
  }
  if (command.operation === 'distribute') {
    if (!['x', 'y'].includes(command.axis) || nodes.length < 2) fail('E_RELATION_VALUE', '分布需要 axis:x/y 和至少两个节点');
    const axis = command.axis, size = axis === 'x' ? 'w' : 'h';
    const sorted = [...nodes].sort((a, b) => a[axis] - b[axis] || a.renderOrder - b.renderOrder);
    let cursor = sorted[0][axis];
    const end = Math.max(...sorted.map(n => n[axis] + n[size]));
    const gap = command.gap === undefined ? (end - cursor - sorted.reduce((s, n) => s + n[size], 0)) / (sorted.length - 1) : finite(command.gap, 'gap');
    return sorted.map(n => { const cmd = move(n, axis === 'x' ? cursor : n.x, axis === 'y' ? cursor : n.y); cursor += n[size] + gap; return cmd; });
  }
  fail('E_RELATION_OPERATION', 'operation 应为 set/move/align/place/distribute');
}
