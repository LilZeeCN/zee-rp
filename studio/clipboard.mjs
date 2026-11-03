// Shared by the browser and command bus. A clipboard owns authored snapshots,
// never live IDs; materialization allocates every descendant before retargeting.
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const children = node => [...(node.children || []), ...(node.states || []).flatMap(state => state.root ? [state.root] : []), ...(node.template ? [node.template] : [])];
function walk(node, fn, parent = null) { if (!node) return; fn(node, parent); for (const child of children(node)) walk(child, fn, node); }

export function copyNodeSnapshots({ doc, pageId, nodeIds }) {
  const page = doc.pages.find(item => item.id === pageId);
  if (!page) fail('E_PAGE_NOT_FOUND', `页面不存在：${pageId}`);
  const entries = []; walk(page.root, (node, parent) => entries.push({ node, parent }));
  const selected = [...new Set(nodeIds)].map(id => {
    const matches = entries.filter(entry => entry.node.id === id);
    if (matches.length !== 1) fail('E_CLIPBOARD_TARGET', '请选择唯一的源节点；宏和组件展开子节点请复制它们的源容器');
    return matches[0];
  });
  const selectedNodes = new Set(selected.map(entry => entry.node));
  return selected.filter(entry => {
    let parent = entry.parent;
    while (parent) { if (selectedNodes.has(parent)) return false; parent = entries.find(item => item.node === parent)?.parent; }
    return true;
  }).map(entry => structuredClone(entry.node));
}

export function materializeNodeSnapshots({ doc, nodes, sourcePageId, pageId, offset = { x: 20, y: 20 }, firstId = null }) {
  if (!Array.isArray(nodes) || !nodes.length) fail('E_CLIPBOARD_EMPTY', '没有可粘贴的节点快照');
  const taken = new Set();
  for (const page of doc.pages || []) walk(page.root, node => taken.add(node.id));
  const clones = structuredClone(nodes), ids = new Map();
  for (const root of clones) walk(root, node => {
    if (!node || typeof node !== 'object' || !node.id || ids.has(node.id)) fail('E_CLIPBOARD_IDS', '复制范围内节点ID重复，无法安全重映射引用');
    const base = ids.size === 0 && firstId ? firstId : `${node.id}_copy`;
    let id = base, suffix = 2;
    while (taken.has(id)) id = `${base}_${suffix++}`;
    taken.add(id); ids.set(node.id, id);
  });
  const targetIds = new Set();
  const targetPage = doc.pages.find(page => page.id === pageId);
  if (!targetPage) fail('E_PAGE_NOT_FOUND', `页面不存在：${pageId}`);
  walk(targetPage.root, node => targetIds.add(node.id));
  const checkActions = value => {
    if (!value || typeof value !== 'object') return;
    if (['show', 'hide', 'toggle', 'set-text', 'set-panel-state', 'enable', 'disable', 'focus'].includes(value.type)) {
      const target = value.target || value.widget;
      const local = typeof target === 'string' ? target.replace(/^@/, '').split('/').at(-1) : null;
      if (local && !ids.has(local) && (sourcePageId !== pageId || !targetIds.has(local))) fail('E_CLIPBOARD_REFERENCE', `复制范围外的交互目标 ${target} 未随节点带入，请一并复制目标或显式重新绑定`);
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') checkActions(child);
  };
  for (const root of clones) walk(root, node => checkActions(node.on || node.onClick));
  const reference = value => {
    if (typeof value !== 'string') return value;
    const prefix = value.startsWith('@') ? '@' : '';
    const segments = value.replace(/^@/, '').split('/');
    if (!segments.some(part => ids.has(part))) return value;
    if (sourcePageId && segments.length > 1 && segments[0] === sourcePageId) segments[0] = pageId;
    return prefix + segments.map(part => ids.get(part) || part).join('/');
  };
  const remap = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['target', 'widget', 'after', 'for', 'emptyFor', 'boundTo'].includes(key)) value[key] = reference(child);
      else if (typeof child === 'string' && child.startsWith('=')) value[key] = child.replace(/@([A-Za-z0-9_/-]+)/g, (_, id) => reference('@' + id));
      else if (child && typeof child === 'object') remap(child);
    }
  };
  for (const node of clones) {
    walk(node, child => { child.id = ids.get(child.id); });
    remap(node);
    node.x = Number(node.x || 0) + Number(offset.x ?? 20);
    node.y = Number(node.y || 0) + Number(offset.y ?? 20);
    node.name = `${node.name || nodes[clones.indexOf(node)].id} 副本`;
  }
  return clones;
}
