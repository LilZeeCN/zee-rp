/**
 * 修复计划：把"哪里错了"翻译成"可以直接提交的命令"。
 *
 * 设计立场：
 *  - 只开确定性处方（数值可算、无需品味判断）：栅格对齐、热区补足、空态补绑、撑高文字回缩。
 *  - 不给"我觉得这样更好看"的建议——那些交给 explore 与锚点。
 *  - 只生成命令，不自动提交；调用方决定是否应用。
 */

const GRID = 4;

function nearest(value, grid = GRID) {
  return Math.max(grid, Math.round(value / grid) * grid);
}

export function buildFixPlan(scenePage, metrics, doc = null) {
  const nodes = scenePage.nodes || [];
  // 沿用页面上已有的正文字号，避免补一个空态顺带改掉字阶。
  const bodySize = metrics.metrics?.typeScale?.bodySizes?.slice(-1)[0] || 14;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const commands = [];
  const notes = [];
  const manual = [];

  const pushProperties = (nodeId, properties, reason) => {
    if (!Object.keys(properties).length) return;
    commands.push({ type: 'setProperties', nodeId, properties });
    notes.push({ nodeId, reason, properties });
  };

  // 1) 栅格对齐：把越界值吸到最近的 4 的倍数
  const offenders = metrics.metrics?.gridAlignment?.offenders || [];
  const grouped = new Map();
  for (const item of offenders) {
    const key = item.id;
    grouped.set(key, { ...(grouped.get(key) || {}), [item.prop]: item.nearest });
  }
  for (const [nodeId, props] of grouped) {
    const node = byId.get(nodeId);
    if (!node) continue;
    // 只修 x/y（位置）。宽高改动会牵动兄弟布局，风险高于收益，放进 notes 让人决定。
    // 命令层写的是**局部坐标**（相对父容器）。scene 的 x/y 是页面绝对坐标，
    // 直接写回会被父容器 padding 再加一次（实测 73 → 104，位移 31px）。
    const safe = {};
    for (const key of ['x', 'y']) {
      if (props[key] === undefined) continue;
      const rel = key === 'x' ? node.relX : node.relY;
      const abs = key === 'x' ? node.x : node.y;
      const delta = Math.round(props[key] - abs);
      const target = Number.isFinite(rel) ? rel + delta : props[key];
      safe[key] = Math.max(0, Math.round(target));
    }
    if (Object.keys(safe).length) pushProperties(nodeId, safe, `位置吸到 ${GRID}px 网格`);
    const other = Object.keys(props).filter(k => k !== 'x' && k !== 'y');
    if (other.length) {
      notes.push({ nodeId, reason: `宽/高不在网格，需人工确认：${other.map(k => `${k}=${node[k]}→${props[k]}`).join('，')}` });
    }
  }

  // 2) 热区不足：补 hitW/hitH
  const interactive = nodes.filter(n => n.type === 'button' || n.type === 'input'
    || (n.type === 'icon' && (n.on || n.role === 'action')));
  const domain = scenePage.domain || 'mobile';
  const minTarget = domain === 'web' ? 32 : 44;
  for (const node of interactive) {
    const w = Number(node.hitW ?? node.w);
    const h = Number(node.hitH ?? node.h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (Math.min(w, h) >= minTarget) continue;
    manual.push({
      nodeId: node.id,
      reason: `热区 ${Math.min(w, h)}px < ${minTarget}px：当前渲染层还没有消费 hitW/hitH，写进去只会让检查变绿而画面不变`,
      options: [`撑大图形到 ${minTarget}px（会改变视觉）`, '在渲染层实现命中区（hitW/hitH → 透明热区）'],
    });
  }

  // 3) 有列表但没有绑定空态：为每个未覆盖列表生成一个空态块
  const lists = nodes.filter(n => n.type === 'repeater' || n.type === 'list-item' || n.type === 'data-table');
  const empties = nodes.filter(n => n.role === 'empty-state');
  const boundFor = node => node.for || null;
  const covered = new Set(empties.map(boundFor).filter(Boolean));
  for (const list of lists) {
    if (covered.has(list.id)) continue;
    const y = Math.round(((list.y || 0) + (list.h || 0) + 16) / GRID) * GRID;
    // 空态不能是白板：必须带一句可读文案，否则检查变绿、页面仍是空白。
    const relX = Number.isFinite(list.relX) ? list.relX : 0;
    const node = {
      id: `${list.id}_empty`,
      type: 'box',
      layout: 'column',
      role: 'empty-state',
      for: list.id,
      x: Math.max(0, nearest(relX)),
      y: Math.max(0, nearest((Number(list.relY) || 0) + (Number(list.h) || 0) + 16)),
      w: nearest(list.w || 320),
      h: 96,
      padding: 16,
      gap: 8,
      fill: '$surface-2',
      radius: 12,
      // 只用已有的正文字号：新引入字号会改变字阶，把"补空态"变成"新增 type-scale 阻塞"。
      children: [
        {
          id: `${list.id}_empty_text`,
          type: 'label',
          text: '暂无数据，点右上角新建一条',
          w: 'fill',
          h: 24,
          fontSize: bodySize,
          color: '$ink',
        },
      ],
    };
    // 必须挂到列表所在的父容器里：挂到 page root 会被流式布局重排到页面底部并越界。
    commands.push({ type: 'addNode', pageId: scenePage.id, parentId: list.parentId || undefined, node });
    notes.push({ nodeId: node.id, reason: `为列表 ${list.id} 补一个绑定空态` });
  }

  // 4) 撑高文字：把外框高度回缩到文字高度
  for (const item of metrics.metrics?.visualHierarchy?.stretchedText || []) {
    const node = byId.get(item.id);
    if (!node) continue;
    const target = Math.max(nearest(item.contentH), GRID);
    pushProperties(item.id, { h: target }, `文字框 ${item.boxH} → ${target}（内容实际 ${item.contentH}）`);
  }

  return {
    ok: true,
    pageId: scenePage.id,
    commands,
    notes,
    manual,
    deterministic: true,
    caveat: '只包含可直接计算的修复（网格/空态/撑高文字），并在服务端试跑验证。字阶、配色、构图属于取舍，交给 studio_design_explore 与锚点对比；热区需要渲染层支持，列为 manual。',
  };
}

export { GRID };
