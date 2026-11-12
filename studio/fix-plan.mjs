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

export function countUnplacedStackContainers(doc, pageId) {
  const pg = (doc?.pages || []).find(p => p.id === pageId);
  if (!pg?.root) return 0;
  let count = 0;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    const children = Array.isArray(node.children) ? node.children : [];
    if ((node.layout === 'stack' || (!node.layout && node.type === 'box')) && children.length >= 2) {
      const positions = new Map();
      for (const child of children) {
        if (child.after || child.pin || child.anchor || child.alignX || child.right != null || child.bottom != null) continue;
        const pos = JSON.stringify([child.x ?? 0, child.y ?? 0]);
        const group = positions.get(pos) || [];
        group.push(child);
        positions.set(pos, group);
      }
      const hasOverlap = [...positions.values()].some(
        group => group.length > 1 && group.some(child => child.x == null || child.y == null)
      );
      if (hasOverlap) count++;
    }
    for (const child of children) walk(child);
    for (const st of node.states || []) if (st?.root) walk(st.root);
  };
  walk(pg.root);
  return count;
}

export function buildFixPlan(scenePage, metrics, doc = null) {
  const nodes = scenePage.nodes || [];
  // 沿用页面上已有的正文字号，避免补一个空态顺带改掉字阶。
  const bodySize = metrics.metrics?.typeScale?.bodySizes?.slice(-1)[0] || 14;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const docPage = (doc?.pages || []).find(p => p.id === scenePage.id);
  const sourceNodeIds = docPage?.root ? (() => {
    const ids = new Set();
    const walkIds = n => {
      if (!n || typeof n !== 'object') return;
      if (n.id) ids.add(n.id);
      for (const ch of n.children || []) walkIds(ch);
      for (const st of n.states || []) if (st?.root) walkIds(st.root);
      if (n.template) walkIds(n.template);
    };
    walkIds(docPage.root);
    return ids;
  })() : null;
  const isEditableSourceNode = n => Boolean(
    n && !n.controlledByMacro && !n.componentSource && !n.repeaterRowOwner && !n.repeaterTemplateOwner
      && (!sourceNodeIds || sourceNodeIds.has(n.id))
  );
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
    if (!isEditableSourceNode(node)) {
      notes.push({ nodeId, reason: `由宏或组件托管（${node.controlledByMacro || node.component || '受控节点'}），跳过直接写虚拟子节点` });
      continue;
    }
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
    if (covered.has(list.id) || !isEditableSourceNode(list)) continue;
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
    if (!node || !isEditableSourceNode(node)) continue;
    const target = Math.max(nearest(item.contentH), GRID);
    pushProperties(item.id, { h: target }, `文字框 ${item.boxH} → ${target}（内容实际 ${item.contentH}）`);
  }

  // 5) 文本裁切 (E_TEXT_CLIP)：按测量所需尺寸对齐 4px 栅格扩容
  const seenClipIds = new Set();
  for (const clip of scenePage.fontReport?.clipDiagnostics || []) {
    if (!clip?.nodeId || clip.repeaterId || seenClipIds.has(clip.nodeId)) continue;
    const node = byId.get(clip.nodeId);
    if (!node || !isEditableSourceNode(node)) continue;
    seenClipIds.add(clip.nodeId);
    const props = {};
    if (clip.direction === 'vertical' && Number.isFinite(clip.requiredBounds?.h) && clip.requiredBounds.h > (clip.actualBounds?.h || 0)) {
      props.h = Math.max(nearest(Math.ceil(clip.requiredBounds.h)), GRID);
    } else if (clip.direction === 'horizontal' && Number.isFinite(clip.requiredBounds?.w) && clip.requiredBounds.w > (clip.actualBounds?.w || 0)) {
      props.w = Math.max(nearest(Math.ceil(clip.requiredBounds.w)), GRID);
    }
    if (Object.keys(props).length) {
      pushProperties(clip.nodeId, props, `修复文本裁切 E_TEXT_CLIP（${clip.direction === 'vertical' ? `h=${clip.actualBounds?.h}→${props.h}` : `w=${clip.actualBounds?.w}→${props.w}`}）`);
    }
  }

  // 6) stack 容器子节点省略坐标共用起点 (W_STACK_CHILDREN_UNPLACED)
  if (docPage?.root) {
    const walkStack = node => {
      if (!node || typeof node !== 'object') return;
      const children = Array.isArray(node.children) ? node.children : [];
      if ((node.layout === 'stack' || (!node.layout && node.type === 'box')) && children.length >= 2) {
        const positions = new Map();
        for (const child of children) {
          if (child.after || child.pin || child.anchor || child.alignX || child.right != null || child.bottom != null) continue;
          const pos = JSON.stringify([child.x ?? 0, child.y ?? 0]);
          const group = positions.get(pos) || [];
          group.push(child);
          positions.set(pos, group);
        }
        const overlappingGroups = [...positions.values()].filter(
          group => group.length > 1 && group.some(child => child.x == null || child.y == null)
        );
        if (overlappingGroups.length > 0) {
          const hasExplicitXY = children.some(ch => ch.x !== undefined || ch.y !== undefined);
          const isPageRoot = node.id === docPage.root.id || node.type === 'phone-shell';
          if (!hasExplicitXY && !isPageRoot) {
            const gap = typeof node.gap === 'number' ? node.gap : 12;
            commands.push({ type: 'setLayout', nodeId: node.id, mode: 'column', gap });
            notes.push({ nodeId: node.id, reason: `修复 W_STACK_CHILDREN_UNPLACED：将未指定坐标的 stack 容器切换为 column 流式排布（gap=${gap}）` });
          } else {
            const gap = typeof node.gap === 'number' ? node.gap : 12;
            for (const group of overlappingGroups) {
              const baseX = nearest(Number(group[0]?.x) || 0);
              let cursorY = nearest(Number(group[0]?.y) || 0);
              for (let idx = 0; idx < group.length; idx++) {
                const ch = group[idx];
                const sceneChild = byId.get(ch.id);
                const chH = Number(sceneChild?.h || ch.h || 40);
                if (idx > 0 || ch.x == null || ch.y == null) {
                  pushProperties(ch.id, { x: baseX, y: cursorY }, `修复 W_STACK_CHILDREN_UNPLACED：为共用起点的子节点分配纵向坐标 y=${cursorY}`);
                }
                cursorY = nearest(cursorY + chH + gap);
              }
            }
          }
        }
      }
      for (const child of children) walkStack(child);
      for (const st of node.states || []) if (st?.root) walkStack(st.root);
    };
    walkStack(docPage.root);
  }

  return {
    ok: true,
    pageId: scenePage.id,
    commands,
    notes,
    manual,
    deterministic: true,
    caveat: '只包含可直接计算的修复（网格/空态/撑高文字/文本裁切/stack重叠子节点排布），并在服务端试跑验证。字阶、配色、构图属于取舍，交给 studio_design(action:explore) 与锚点对比；热区需要渲染层支持，列为 manual。',
  };
}

export { GRID };
