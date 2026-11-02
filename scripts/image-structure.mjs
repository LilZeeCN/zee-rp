import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertNotProtected } from './engine.mjs';

function bounds(node) {
  const x = node.x ?? (node.cx === undefined ? 0 : node.cx - node.r);
  const y = node.y ?? (node.cy === undefined ? 0 : node.cy - node.r);
  const w = node.w ?? node.d ?? (node.r === undefined ? 0 : node.r * 2);
  const h = node.h ?? node.d ?? (node.r === undefined ? node.thickness ?? 0 : node.r * 2);
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
}
const contains = (outer, inner) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1
  && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

// Geometry is evidence for grouping, not proof of a component's business role.
// Keep the original trace spec and native hierarchy untouched until reviewed.
export function reviewImageStructure({ spec, limit = 20 }) {
  if (typeof spec === 'string' && spec.trimStart().startsWith('{')) spec = JSON.parse(spec);
  if (typeof spec === 'string') { spec = resolve(spec); assertNotProtected(spec); spec = JSON.parse(readFileSync(spec, 'utf8')); }
  if (!Array.isArray(spec?.frames)) throw new Error('需要 trace spec 的 frames 数组；图片先调用 generate_from_image。');
  const groups = [], repeated = [], textHierarchy = [], reviewItems = [], styles = new Map();
  let total = 0, nativeEditable = 0, rasterOnly = 0;
  for (const [fi, frame] of spec.frames.entries()) {
    const items = [];
    function walk(children, path) {
      for (const [i, node] of children.entries()) {
        const pointer = `${path}/${i}`, box = bounds(node);
        if (node.kind === 'group') { walk(node.children ?? [], pointer + '/children'); continue; }
        total++;
        const editable = ['text', 'rect', 'card', 'circle', 'ellipse', 'hline', 'vline'].includes(node.kind) && typeof node.fill !== 'object' && !node.shadows?.length;
        if (editable) nativeEditable++; else rasterOnly++;
        const item = { pointer, name: node.name ?? node.id ?? `${node.kind}-${i + 1}`, kind: node.kind, bounds: box,
          editable: editable ? 'native-properties' : 'image-object-only', node };
        items.push(item);
        if (!editable || (node.kind === 'text' && (node.size < 12 || box?.w < 24))) reviewItems.push({
          pointer, name: item.name, reason: editable ? 'small-text-needs-proofreading' : 'raster-content-not-editable', requiresReview: true,
          nextAction: editable ? '对照原图校对文案。' : '保留独立图片，需修改内部内容时替换素材或手工重建。' });
        if (node.kind === 'text') textHierarchy.push({ pointer, name: item.name, text: node.content ?? node.text ?? '',
          fontSize: node.size ?? 14, weight: node.weight ?? 400, classification: 'visual-size-only' });
        const style = Object.fromEntries(['fill', 'color', 'size', 'weight', 'corners'].filter(k => node[k] !== undefined && typeof node[k] !== 'object').map(k => [k, node[k]]));
        if (Object.keys(style).length) {
          const key = JSON.stringify(style);
          if (!styles.has(key)) styles.set(key, { style, members: [] });
          styles.get(key).members.push({ pointer, name: item.name });
        }
      }
    }
    walk(frame.children ?? [], `/frames/${fi}/children`);
    const candidates = items.filter(it => ['rect', 'card'].includes(it.kind) && it.bounds
      && it.bounds.w * it.bounds.h < frame.w * frame.h * 0.9);
    const owned = new Map();
    for (const child of items) {
      if (!child.bounds) continue;
      const owners = candidates.filter(c => c !== child && c.bounds.w * c.bounds.h > child.bounds.w * child.bounds.h
        && contains(c.bounds, child.bounds)).sort((a, b) => a.bounds.w * a.bounds.h - b.bounds.w * b.bounds.h);
      if (owners.length) {
        const owner = owners[0];
        if (!owned.has(owner.pointer)) owned.set(owner.pointer, []);
        owned.get(owner.pointer).push(child);
      }
    }
    for (const card of candidates) {
      const members = owned.get(card.pointer) ?? [];
      if (members.length < 2 || !members.some(m => m.kind === 'text')) continue;
      groups.push({ id: card.pointer, role: 'card-candidate', evidence: 'smallest-containing-background',
        confidence: 'heuristic-unrated', requiresReview: true, bounds: card.bounds,
        background: { pointer: card.pointer, name: card.name },
        members: members.map(({ pointer, name, kind, editable }) => ({ pointer, name, kind, editable })),
        signature: members.map(m => m.kind + (m.kind === 'text' ? ':' + Math.round((m.node.size ?? 14) / 2) * 2 : '')).sort().join('|') });
    }
    const frameGroups = groups.filter(g => g.id.startsWith(`/frames/${fi}/`));
    const buckets = [];
    for (const group of frameGroups) {
      let bucket = buckets.find(b => b.signature === group.signature
        && Math.abs(b.bounds.w - group.bounds.w) <= Math.max(4, b.bounds.w * .08)
        && Math.abs(b.bounds.h - group.bounds.h) <= Math.max(4, b.bounds.h * .08));
      if (!bucket) { bucket = { signature: group.signature, bounds: group.bounds, instances: [] }; buckets.push(bucket); }
      bucket.instances.push(group.id);
    }
    repeated.push(...buckets.filter(b => b.instances.length > 1).map(({ signature, instances }) => ({ signature, instances,
      role: 'repeated-card-candidate', requiresReview: true, nextAction: '确认这些区域属于同类卡片，再抽取内容参数；单张图片无法证明交互。' })));
  }
  const reusableStyles = [...styles.values()].filter(s => s.members.length > 1);
  return { status: 'completed', evidence: 'image-geometry-heuristics', nativeHierarchyChanged: false,
    summary: { total, nativeEditable, rasterOnly, groupCandidates: groups.length, repeatedPatterns: repeated.length,
      sharedStyles: reusableStyles.length, reviewItems: reviewItems.length },
    groups: groups.slice(0, limit), repeatedPatterns: repeated.slice(0, limit),
    textHierarchy: textHierarchy.sort((a, b) => b.fontSize - a.fontSize).slice(0, limit),
    reusableStyles: reusableStyles.slice(0, limit), reviewItems: reviewItems.slice(0, limit),
    truncated: [groups, repeated, textHierarchy, reusableStyles, reviewItems].some(a => a.length > limit),
    limits: ['分组和重复结构需要人工确认，未自动改写原生层级。', '图片内部内容不可按原生形状编辑；未从截图猜测交互。'] };
}
