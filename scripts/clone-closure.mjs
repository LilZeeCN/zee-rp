// 对象引用闭包克隆器——复杂元件优先采用的样本复用路线。
//
// 背景：从零构造的元件（widget-factory.mjs）字段结构、顺序、tag、字节数全对，Axure 仍拒收；
// 克隆样本已获得加载/切页记录，但仍需验证挂载、跨包资源和实际行为。
//
// 做法：给定源文件里的某个对象，取其**引用闭包**（它引用的一切 + 递归），
// 为闭包内每个对象分配新 id、为新 GUID 分配新值，然后整体改写后注入目标记录。
//
// 用法（库）：
//   import { closureOf, cloneInto } from './clone-closure.mjs';
//   const closure = closureOf(srcGraph, rootId);          // 取引用闭包
//   const res = cloneInto({ srcGraph, srcStrings, dstGraph, dstStrings, closure, rootOldId: rootId });
//   dstGraph.roots.splice(dstGraph.roots.length - 1, 0, ...res.created);   // 插在最后一个 root 之前
//
// 已验证：用这条路线把 Axure 控件库里的中继器（61 对象闭包）克隆进页面，Axure ✅ 接受。
// 参考实现见 research-rp/round4/add-repeater.mjs。
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readRecords } from './rp-records.mjs';
import { parsePayload, field } from './parse-payload.mjs';

const NULL_GUID = '0'.repeat(32);

// 取一个对象在给定图里的引用闭包（含自身）
export function closureOf(graph, rootId) {
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const obj = graph.objects.get(id);
    if (!obj) continue;
    const walk = n => {
      if (!n || typeof n !== 'object') return;
      if (n.tag === 3) stack.push(n.value);
      if (n.items) n.items.forEach(walk);
      if (n.body) walk(n.body);
      if (n.entries) n.entries.forEach(([k, v]) => { walk(k); walk(v); });
    };
    walk(obj.body);
  }
  return seen;
}

// 把闭包从源图克隆进目标图，返回新对象 id 列表与新 GUID 映射
export function cloneInto({ srcGraph, srcStrings, dstGraph, dstStrings, closure, rootOldId }) {
  // 1) 列出待克隆的对象；新 id 随后与目标 GUID 表索引一起分配。
  //    闭包是 Set，迭代顺序不保证，所以先固定成一个数组，后续一律按它走。
  const ids = [...closure].filter(id => srcGraph.objects.has(id));
  const idMap = new Map();
  if (rootOldId === undefined) rootOldId = ids[0];

  // 2) 为源图 GUID 分配目标 GUID；空哨兵原样保留
  const srcGuids = srcGraph.roots.find(n => n.tag === 0x1e)?.values ?? [];
  const dstGuids = dstGraph.roots.find(n => n.tag === 0x1e).values;
  const guidMap = new Map();
  const ensureGuid = oldIdx => {
    if (!oldIdx) return null;
    if (guidMap.has(oldIdx)) return guidMap.get(oldIdx);
    const old = srcGuids[oldIdx - 1];
    if (old === undefined) return null;
    if (old === NULL_GUID) { guidMap.set(oldIdx, { index: dstGuids.indexOf(NULL_GUID) + 1 }); return guidMap.get(oldIdx); }
    dstGuids.push(randomBytes(16).toString('hex'));
    guidMap.set(oldIdx, { index: dstGuids.length });
    return guidMap.get(oldIdx);
  };
  // An object ID and a GUID reference use the same one-based table index.
  // Allocate them together; the null GUID must never become a cloned object.
  for (const oldId of ids) idMap.set(oldId, ensureGuid(oldId).index);

  const intern = t => { let i = dstStrings.indexOf(t); if (i < 0) { i = dstStrings.length; dstStrings.push(t); } return i + 1; };

  // 3) 深克隆 + 改写
  const clone = n => {
    const out = { tag: n.tag };
    if (n.tag === 9) {
      out.id = idMap.get(n.id) ?? n.id;
      out.classIndex = intern(srcStrings[n.classIndex - 1]);
      out.className = srcStrings[n.classIndex - 1];
    } else if (n.tag === 8) {
      out.value = intern(n.text); out.text = n.text;
    } else if (n.tag === 3) {
      // 对象引用：闭包内的重映射到新 id；闭包外的一律指向空哨兵，避免悬空引用
      out.value = idMap.has(n.value) ? idMap.get(n.value) : (dstGuids.indexOf(NULL_GUID) + 1);
    } else if ([0x11, 0x12, 0x14, 0x16].includes(n.tag)) {
      const g = ensureGuid(n.value);
      out.value = g ? g.index : (dstGuids.indexOf(NULL_GUID) + 1);
    } else if ([0x10, 0x13].includes(n.tag)) {
      out.values = [n.values[0] ? intern(srcStrings[n.values[0] - 1]) : 0,
        ensureGuid(n.values[1])?.index ?? 0];
    } else if (n.tag === 0x1e) {
      out.values = (n.values ?? n.value).map((_, i) => { const g = ensureGuid(i + 1); return g ? dstGuids[g.index - 1] : NULL_GUID; });
    } else if (n.values !== undefined) {
      out.values = [...n.values];
    } else if (n.value !== undefined) {
      out.value = n.value;
    }
    if (n.items) out.items = n.items.map(clone);
    if (n.body) out.body = clone(n.body);
    if (n.entries) out.entries = n.entries.map(([k, v]) => {
      const value = clone(v);
      if (v.tag === 5 && ['diagram-object-id', 'parent-diagram-id', 'LibraryId', 'Id'].includes(k.text)
        && srcGuids[v.value - 1]) value.value = ensureGuid(v.value).index;
      return [clone(k), value];
    });
    return out;
  };

  // 先把全部克隆体建出来（此时 idMap 已完整，clone 里的 tag-3 重映射才有效），
  // 再统一注册进目标图。顺序不能颠倒 —— 边克隆边注册会让部分引用解析到目标图的旧对象。
  const created = [];
  for (const oldId of ids) {
    const src = srcGraph.objects.get(oldId);
    if (!src) continue;
    created.push(clone({ tag: 9, ...src }));
  }
  for (const c of created) dstGraph.objects.set(c.id, c);
  return { created, idMap, guidMap, rootNewId: idMap.get(rootOldId) };
}
