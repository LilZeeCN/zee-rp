const fields = ['parentId', 'x', 'y', 'w', 'h', 'text', 'fill', 'color', 'stroke', 'fontSize', 'fontFamily', 'fontWeight', 'radius', 'opacity', 'visible', 'on', 'css', 'src'];
export function reviewNodeSnapshots(page) {
  return page.nodes.map(node => Object.fromEntries(['id', 'scopedId', ...fields].map(key => [key, node[key] ?? null])));
}
export function compareReviews(before, after) {
  const previous = new Map(before.nodeSnapshots.map(n => [n.scopedId, n]));
  const current = new Map(after.nodeSnapshots.map(n => [n.scopedId, n]));
  const region = (n, board) => !n || n.visible === false ? null : ({ x: n.x + (board?.shellPad || 0), y: n.y + (board?.shellPad || 0), w: n.w, h: n.h });
  const changedNodes = [];
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(id), next = current.get(id);
    const changedFields = fields.filter(key => JSON.stringify(old?.[key]) !== JSON.stringify(next?.[key]));
    if (!changedFields.length) continue;
    changedNodes.push({ nodeId: next?.id || old.id, scopedId: id, status: !old ? 'added' : !next ? 'removed' : 'modified', changedFields,
      before: region(old, before.board), after: region(next, after.board) });
  }
  const oldChecks = new Map((before.designMetrics?.checks || []).map(c => [c.key, c]));
  const checkChanges = (after.designMetrics?.checks || []).filter(c => oldChecks.has(c.key) && oldChecks.get(c.key).ok !== c.ok)
    .map(c => ({ key: c.key, before: oldChecks.get(c.key).ok, after: c.ok, detail: c.detail }));
  return { beforeReviewId: before.reviewId, afterReviewId: after.reviewId, beforeRevision: before.revision, afterRevision: after.revision,
    beforeBoard: before.board, afterBoard: after.board, changedNodes, checkChanges, regionBasis: 'resolved-node-bounds', note: '边框标出发生变更的图层范围；指标变化不代表审美优劣。' };
}
