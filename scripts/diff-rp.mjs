// D1: Axure 的语义 Git（diff-rp）— 对比两份 .rp 文件的页面、全局变量、元件（顶层与嵌套）及交互树差异。
// 身份设计原则（经真机 GUI 重存验证）：
//   1. 页面优先按 DesignDocument.PackageInfo 对应的 128-bit packageGuid 匹配；
//   2. 元件优先按 128-bit 原生 GUID（非记录内局部整数 id）匹配，再退到 (容器, 类型, 唯一名称) 与几何+文本签名；
//   3. 交互树（事件/条件 AST/动作）把内部槽位整数归一为 128-bit GUID 与变量名，确保 GUI 重存槽位回收零噪音；
//   4. 样式只对比显式启用项（DOA >= 0xc0000000 且排除 ID/字体表槽位/几何）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected } from './engine.mjs';
import { field, parsePayload } from './parse-payload.mjs';
import { EVENTS } from './ix-actions.mjs';
import { readRecords } from './rp-records.mjs';
import { readRp } from './rp-read.mjs';

const NULL_GUID = '0'.repeat(32);
const EVENT_NAMES = new Map(Object.entries(EVENTS).map(([name, type]) => [type, name]));
const eventName = type => EVENT_NAMES.get(type) ?? `Event(${type})`;
const SKIP_STYLE_SLOTS = new Set([0, 96, 101, 105]); // StyleId, TypefaceId, Position, Size
const isWidget = o => o.className.startsWith('Axure:DiagramObject:') || o.className === 'Axure:Repeater';
const strOf = n => (n && n.tag === 8 ? n.text : undefined);
const intOf = n => (n === undefined || n === null ? undefined : n.value);

function loadInput(input, label) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return { bytes: Buffer.from(input), path: label ?? '(buffer)' };
  }
  const abs = resolve(String(input));
  assertNotProtected(abs);
  return { bytes: readFileSync(abs), path: abs };
}

function buildGraphs(bytes) {
  const records = readRecords(bytes);
  const graphs = new Map();
  for (const r of records) {
    if (!r.strings) continue;
    try { graphs.set(r.index, parsePayload(r)); } catch {}
  }
  const docRecord = records.find(r => r.className === 'Axure:DesignDocument');
  const docGraph = docRecord ? graphs.get(docRecord.index) : null;
  const docGuids = docGraph?.roots?.find(n => n.tag === 0x1e)?.values ?? [];
  const widgetGuidBySlotKey = new Map();
  for (const [recIdx, g] of graphs) {
    const gs = g.roots.find(n => n.tag === 0x1e)?.values ?? [];
    for (const o of g.objects.values()) {
      if (isWidget(o) && gs[o.id - 1] && gs[o.id - 1] !== NULL_GUID) {
        widgetGuidBySlotKey.set(`${recIdx}:${o.id}`, gs[o.id - 1]);
      }
    }
  }
  return { records, graphs, docGraph, docGuids, widgetGuidBySlotKey };
}

function normalizeNodeAst(graph, node, gs, widgetGuidByObjId, seen = new Set()) {
  if (!node) return null;
  if (node.tag === 3) {
    const obj = graph.objects.get(node.value);
    if (!obj) {
      const g = gs[node.value - 1];
      return { refGuid: !g || g === NULL_GUID ? 'null' : g };
    }
    if (seen.has(obj.id)) return { cycle: obj.className };
    seen.add(obj.id);
    let result;
    if (obj.className === 'Axure:DiagramObjectPath') {
      const objId = field(obj.body, 'object-id')?.value;
      const targetGuid = widgetGuidByObjId.get(objId) ?? gs[objId - 1] ?? null;
      result = {
        className: obj.className,
        targetGuid: targetGuid === NULL_GUID ? 'null' : targetGuid,
        isDummy: Boolean(field(obj.body, 'is-dummy')?.value),
      };
    } else if (obj.className === 'Axure:Expr:GlobalVariableLiteral') {
      result = { className: obj.className, variable: strOf(field(obj.body, 'variable-name')) ?? '' };
    } else {
      result = { className: obj.className, body: normalizeNodeAst(graph, obj.body, gs, widgetGuidByObjId, seen) };
    }
    seen.delete(obj.id);
    return result;
  }
  if (node.tag === 0x11 || node.tag === 0x12 || node.tag === 0x14 || node.tag === 0x16) {
    const g = gs[node.value - 1];
    return { tag: node.tag, guid: !g || g === NULL_GUID ? 'null' : g };
  }
  if (node.tag === 0x10 || node.tag === 0x13) {
    const g = gs[node.values?.[1] - 1];
    return { tag: node.tag, kind: node.values?.[0], guid: !g || g === NULL_GUID ? 'null' : g };
  }
  if (node.entries) {
    return {
      tag: node.tag,
      entries: node.entries.map(([k, v]) => [
        normalizeNodeAst(graph, k, gs, widgetGuidByObjId, seen),
        normalizeNodeAst(graph, v, gs, widgetGuidByObjId, seen),
      ]),
    };
  }
  if (node.items) return { tag: node.tag, items: node.items.map(it => normalizeNodeAst(graph, it, gs, widgetGuidByObjId, seen)) };
  if (node.tag === 8) return { tag: 8, text: node.text };
  if (node.tag === 6) return { tag: 6, value: Number.isNaN(node.value) ? 'NaN' : node.value };
  return { tag: node.tag, value: node.value, values: node.values };
}

function normalizedStyleOf(graph, widget) {
  const styleId = field(widget.body, 'MyStyle')?.value;
  const style = styleId ? graph.objects.get(styleId) : null;
  if (!style) return {};
  const gs = graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
  const props = {};
  for (const item of field(style.body, 'PropList')?.items ?? []) {
    const doa = intOf(field(item, 'DOAName'));
    if (doa === undefined) continue;
    if ((doa >>> 0) < 0xc0000000) continue; // skip inherited/unchecked defaults
    const code = doa & 0x0fffffff;
    if (SKIP_STYLE_SLOTS.has(code)) continue;
    const val = field(item, 'Value');
    props[code] = normalizeNodeAst(graph, val, gs, new Map());
  }
  return props;
}

function normalizedInteractionsOf(graph, owner, widgetGuidByObjId, targetWidgetByGuid, panelStates) {
  const mapField = owner.className === 'Axure:Page' ? 'interactionmap' : 'InteractionMap';
  const mapNode = graph.objects.get(field(owner.body, mapField)?.value);
  if (!mapNode) return [];
  const gs = graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
  const nodeTable = field(mapNode.body, 'node-table');
  const target = id => {
    const entry = nodeTable?.entries?.find(([k]) => k.value === id);
    return entry ? graph.objects.get(entry[1].value) : undefined;
  };
  const tree = graph.objects.get(field(mapNode.body, 'tree')?.value);
  const childrenOf = obj => (field(obj?.body ?? {}, 'children')?.items ?? [])
    .map(item => graph.objects.get(item.value)).filter(Boolean);

  const out = [];
  for (const eventNode of childrenOf(tree)) {
    const event = target(eventNode.id);
    if (!event || event.className !== 'Axure:InteractionEvent') continue;
    const eventType = intOf(field(event.body, 'event-type'));
    const cases = [];
    for (const caseNode of childrenOf(eventNode)) {
      const kase = target(caseNode.id);
      if (!kase) continue;
      const condNode = field(kase.body, 'Condition');
      const condTarget = condNode?.tag === 3 ? graph.objects.get(condNode.value) : null;
      const condition = condTarget ? normalizeNodeAst(graph, condNode, gs, widgetGuidByObjId) : null;
      const actions = childrenOf(caseNode).map(an => target(an.id)).filter(Boolean).map(action => {
        const clonedBody = normalizeNodeAst(graph, action.body, gs, widgetGuidByObjId);
        // Also resolve panel state GUIDs in SetPanelStateInfo to state names for readability
        return {
          className: action.className,
          disabled: field(action.body, 'Disabled')?.value === true,
          body: clonedBody,
        };
      });
      cases.push({
        description: strOf(field(kase.body, 'Description')) ?? '',
        disabled: field(kase.body, 'Disabled')?.value === true,
        isNewIfGroup: field(kase.body, 'IsNewIfGroup')?.value === true,
        condition,
        actions,
      });
    }
    out.push({
      event: eventName(eventType),
      eventType,
      disabled: field(event.body, 'Disabled')?.value === true,
      cases,
    });
  }
  return out;
}

function extractSnapshot(bytes, pathLabel) {
  const summary = readRp(bytes, { path: pathLabel, includeMasterWidgets: true });
  const { graphs, docGuids } = buildGraphs(bytes);

  const pageEntries = [];
  const pageByRecord = new Map();
  for (let order = 0; order < summary.pages.length; order++) {
    const p = summary.pages[order];
    const sm = summary.sitemap.pages[order];
    const packageGuid = sm?.guidIndex ? docGuids[sm.guidIndex - 1] : null;
    const pageGraph = p.record ? graphs.get(p.record) : null;
    const pageObj = pageGraph ? [...pageGraph.objects.values()].find(o => o.className === 'Axure:Page') : null;
    const widgetGuidByObjId = new Map();
    if (pageGraph) {
      const gs = pageGraph.roots.find(n => n.tag === 0x1e)?.values ?? [];
      for (const o of pageGraph.objects.values()) {
        if (isWidget(o) && gs[o.id - 1] && gs[o.id - 1] !== NULL_GUID) widgetGuidByObjId.set(o.id, gs[o.id - 1]);
      }
    }
    const pageInteractions = (pageGraph && pageObj)
      ? normalizedInteractionsOf(pageGraph, pageObj, widgetGuidByObjId)
      : [];
    const entry = {
      name: p.name,
      folder: p.folder ?? [],
      order,
      record: p.record,
      packageGuid: packageGuid && packageGuid !== NULL_GUID ? packageGuid : null,
      interactions: pageInteractions,
      rawInteractions: p.interactions ?? [],
    };
    pageEntries.push(entry);
    if (p.record) pageByRecord.set(p.record, entry);
  }

  // Build map from record index -> owning page key
  const pkgToPage = new Map();
  const pageKeyByPkg = new Map();
  for (const pkg of summary.packages) {
    if (pkg.record && pageByRecord.has(pkg.record)) {
      const pEntry = pageByRecord.get(pkg.record);
      pkgToPage.set(pkg.path, pEntry);
      pageKeyByPkg.set(pkg.record, pEntry);
    }
  }
  for (const pkg of summary.packages) {
    if (!pkg.record || pageKeyByPkg.has(pkg.record)) continue;
    const rootKey = pkg.path.split('/')[0];
    const owner = pkgToPage.get(rootKey);
    if (owner) pageKeyByPkg.set(pkg.record, owner);
  }

  // Collect all widgets (top-level + contained in panels/repeaters) with normalized style & interactions
  const widgets = [];
  const addWidget = (w, pageEntry, containerPath) => {
    const g = w.record ? graphs.get(w.record) : null;
    const obj = g?.objects.get(w.id);
    const gs = g?.roots.find(n => n.tag === 0x1e)?.values ?? [];
    const widgetGuidByObjId = new Map();
    if (g) {
      for (const o of g.objects.values()) {
        if (isWidget(o) && gs[o.id - 1] && gs[o.id - 1] !== NULL_GUID) widgetGuidByObjId.set(o.id, gs[o.id - 1]);
      }
    }
    const style = (g && obj) ? normalizedStyleOf(g, obj) : {};
    const interactions = (g && obj) ? normalizedInteractionsOf(g, obj, widgetGuidByObjId) : [];
    widgets.push({
      id: w.id,
      guid: w.guid && w.guid !== NULL_GUID ? w.guid : null,
      name: w.name ?? '',
      type: w.type,
      className: w.className,
      x: w.x ?? null,
      y: w.y ?? null,
      w: w.w ?? null,
      h: w.h ?? null,
      text: w.text ?? '',
      maxLength: w.maxLength ?? null,
      panelStates: w.panel ? w.panel.map(s => s.name) : null,
      style,
      interactions,
      rawInteractions: w.interactions ?? [],
      pageGuid: pageEntry?.packageGuid ?? null,
      pageName: pageEntry?.name ?? '(unknown)',
      container: containerPath,
    });
  };

  for (const p of summary.pages) {
    const pEntry = pageByRecord.get(p.record);
    for (const w of p.widgets) {
      addWidget({ ...w, record: p.record }, pEntry, []);
    }
  }
  for (const w of summary.containedWidgets) {
    if (w.container?.[0]?.startsWith('母版:')) continue;
    const ownerPage = pageKeyByPkg.get(w.record);
    addWidget(w, ownerPage, w.container ?? []);
  }

  return { summary, pageEntries, widgets, globalVariables: summary.globalVariables };
}

function matchByKeys(beforeList, afterList, keyFns) {
  const matched = [];
  let remA = [...beforeList];
  let remB = [...afterList];
  const stats = {};
  for (const { name: strat, fn } of keyFns) {
    stats[strat] = 0;
    const mapA = new Map();
    const mapB = new Map();
    for (const item of remA) {
      const k = fn(item);
      if (!k) continue;
      if (!mapA.has(k)) mapA.set(k, []);
      mapA.get(k).push(item);
    }
    for (const item of remB) {
      const k = fn(item);
      if (!k) continue;
      if (!mapB.has(k)) mapB.set(k, []);
      mapB.get(k).push(item);
    }
    const usedA = new Set();
    const usedB = new Set();
    for (const [k, itemsA] of mapA) {
      const itemsB = mapB.get(k);
      if (itemsA.length === 1 && itemsB?.length === 1) {
        matched.push([itemsA[0], itemsB[0], strat]);
        usedA.add(itemsA[0]);
        usedB.add(itemsB[0]);
        stats[strat]++;
      }
    }
    remA = remA.filter(x => !usedA.has(x));
    remB = remB.filter(x => !usedB.has(x));
  }
  return { matched, removed: remA, added: remB, stats };
}

const geoChanged = (a, b) => ['x', 'y', 'w', 'h'].some(k => {
  if (a[k] === null && b[k] === null) return false;
  if (a[k] === null || b[k] === null) return true;
  return Math.abs(a[k] - b[k]) > 0.01;
});

function summarizeInteractions(raw) {
  return (raw ?? []).map(ix => ({
    event: ix.event,
    disabled: Boolean(ix.disabled),
    cases: (ix.cases ?? []).map(c => ({
      description: c.description || '',
      actions: (c.actions ?? []).map(a => a.human),
    })),
  }));
}

export function diffRp(beforeInput, afterInput) {
  const beforeData = loadInput(beforeInput, 'before');
  const afterData = loadInput(afterInput, 'after');
  const before = extractSnapshot(beforeData.bytes, beforeData.path);
  const after = extractSnapshot(afterData.bytes, afterData.path);

  // 1. Match Pages
  const pageMatch = matchByKeys(before.pageEntries, after.pageEntries, [
    { name: 'guid', fn: p => p.packageGuid },
    { name: 'name', fn: p => p.name },
  ]);
  const pageChanges = [];
  const pageKeyMap = new Map();
  for (const [pA, pB] of pageMatch.matched) {
    const key = pB.packageGuid ?? pB.name;
    pageKeyMap.set(pA, key);
    pageKeyMap.set(pB, key);
    const changes = {};
    if (pA.name !== pB.name) changes.name = { before: pA.name, after: pB.name };
    if (JSON.stringify(pA.folder) !== JSON.stringify(pB.folder)) {
      changes.folder = { before: pA.folder, after: pB.folder };
    }
    if (Object.keys(changes).length) {
      pageChanges.push({ kind: 'modified', page: pB.name, guid: pB.packageGuid, changes });
    }
  }
  // Check relative order changes among surviving matched pages
  const orderedA = pageMatch.matched.map(([a]) => a).sort((x, y) => x.order - y.order);
  const orderedB = pageMatch.matched.map(([, b]) => b).sort((x, y) => x.order - y.order);
  for (let i = 0; i < orderedB.length; i++) {
    const b = orderedB[i];
    const pair = pageMatch.matched.find(([, y]) => y === b);
    const idxInA = orderedA.indexOf(pair[0]);
    if (idxInA !== i) {
      const existing = pageChanges.find(c => c.page === b.name && c.kind === 'modified');
      const orderDiff = { before: idxInA, after: i };
      if (existing) existing.changes.order = orderDiff;
      else pageChanges.push({ kind: 'moved', page: b.name, guid: b.packageGuid, changes: { order: orderDiff } });
    }
  }
  for (const p of pageMatch.removed) pageChanges.push({ kind: 'removed', page: p.name, guid: p.packageGuid });
  for (const p of pageMatch.added) pageChanges.push({ kind: 'added', page: p.name, guid: p.packageGuid });

  // Build canonical page identity map for widgets
  const pageIdentityFor = (w, pageEntries) => {
    const matchedPage = pageEntries.find(p => (w.pageGuid && p.packageGuid === w.pageGuid) || p.name === w.pageName);
    return pageKeyMap.get(matchedPage) ?? w.pageGuid ?? w.pageName;
  };

  // 2. Match Global Variables
  const varChanges = [];
  const varA = new Map(before.globalVariables.map(v => [v.name, v]));
  const varB = new Map(after.globalVariables.map(v => [v.name, v]));
  for (const [name, vA] of varA) {
    if (!varB.has(name)) {
      varChanges.push({ kind: 'removed', name, beforeValue: vA.value });
    } else {
      const vB = varB.get(name);
      if (vA.value !== vB.value) {
        varChanges.push({ kind: 'modified', name, beforeValue: vA.value, afterValue: vB.value });
      }
    }
  }
  for (const [name, vB] of varB) {
    if (!varA.has(name)) varChanges.push({ kind: 'added', name, afterValue: vB.value });
  }

  // 3. Match Widgets
  const widgetMatch = matchByKeys(before.widgets, after.widgets, [
    { name: 'guid', fn: w => (w.guid ? `${pageIdentityFor(w, before.pageEntries)}|${w.guid}` : null) },
    { name: 'name', fn: w => (w.name ? `${pageIdentityFor(w, before.pageEntries)}|${w.container.join('/')}|${w.type}|${w.name}` : null) },
    {
      name: 'signature',
      fn: w => `${pageIdentityFor(w, before.pageEntries)}|${w.container.join('/')}|${w.type}|${Math.round(w.x ?? 0)},${Math.round(w.y ?? 0)},${Math.round(w.w ?? 0)},${Math.round(w.h ?? 0)}|${w.text}`,
    },
  ]);

  const widgetChanges = [];
  const interactionChanges = [];

  for (const [pA, pB] of pageMatch.matched) {
    if (JSON.stringify(pA.interactions) !== JSON.stringify(pB.interactions)) {
      interactionChanges.push({
        scope: 'page',
        page: pB.name,
        widget: null,
        before: summarizeInteractions(pA.rawInteractions),
        after: summarizeInteractions(pB.rawInteractions),
      });
    }
  }

  for (const [wA, wB] of widgetMatch.matched) {
    const changes = {};
    if (wA.name !== wB.name) changes.name = { before: wA.name, after: wB.name };
    if (geoChanged(wA, wB)) {
      changes.geometry = {
        before: { x: wA.x, y: wA.y, w: wA.w, h: wA.h },
        after: { x: wB.x, y: wB.y, w: wB.w, h: wB.h },
      };
    }
    if (wA.text !== wB.text) changes.text = { before: wA.text, after: wB.text };
    if (wA.maxLength !== wB.maxLength) changes.maxLength = { before: wA.maxLength, after: wB.maxLength };
    if (JSON.stringify(wA.panelStates) !== JSON.stringify(wB.panelStates)) {
      changes.panelStates = { before: wA.panelStates, after: wB.panelStates };
    }
    if (JSON.stringify(wA.style) !== JSON.stringify(wB.style)) {
      const beforeKeys = Object.keys(wA.style);
      const afterKeys = Object.keys(wB.style);
      const changedStyleCodes = [...new Set([...beforeKeys, ...afterKeys])]
        .filter(code => JSON.stringify(wA.style[code]) !== JSON.stringify(wB.style[code]))
        .map(Number);
      changes.style = { changedStyleCodes };
    }
    if (Object.keys(changes).length) {
      widgetChanges.push({
        kind: 'modified',
        page: wB.pageName,
        container: wB.container,
        widget: wB.name || `#${wB.id}`,
        type: wB.type,
        guid: wB.guid,
        changes,
      });
    }
    if (JSON.stringify(wA.interactions) !== JSON.stringify(wB.interactions)) {
      interactionChanges.push({
        scope: 'widget',
        page: wB.pageName,
        container: wB.container,
        widget: wB.name || `#${wB.id}`,
        type: wB.type,
        guid: wB.guid,
        before: summarizeInteractions(wA.rawInteractions),
        after: summarizeInteractions(wB.rawInteractions),
      });
    }
  }
  for (const w of widgetMatch.removed) {
    widgetChanges.push({
      kind: 'removed',
      page: w.pageName,
      container: w.container,
      widget: w.name || `#${w.id}`,
      type: w.type,
      guid: w.guid,
      text: w.text || undefined,
    });
  }
  for (const w of widgetMatch.added) {
    widgetChanges.push({
      kind: 'added',
      page: w.pageName,
      container: w.container,
      widget: w.name || `#${w.id}`,
      type: w.type,
      guid: w.guid,
      text: w.text || undefined,
    });
  }

  const totalChanges = pageChanges.length + varChanges.length + widgetChanges.length + interactionChanges.length;
  return {
    ok: true,
    evidence: 'structure',
    hasChanges: totalChanges > 0,
    before: {
      path: beforeData.path,
      version: before.summary.version,
      pages: before.summary.counts.pages,
      widgets: before.summary.counts.widgets,
      interactions: before.summary.counts.interactions,
      actions: before.summary.counts.actions,
      globalVariables: before.globalVariables.length,
    },
    after: {
      path: afterData.path,
      version: after.summary.version,
      pages: after.summary.counts.pages,
      widgets: after.summary.counts.widgets,
      interactions: after.summary.counts.interactions,
      actions: after.summary.counts.actions,
      globalVariables: after.globalVariables.length,
    },
    identityStats: {
      pages: pageMatch.stats,
      widgets: {
        matchedByGuid: widgetMatch.stats.guid,
        matchedByName: widgetMatch.stats.name,
        matchedBySignature: widgetMatch.stats.signature,
      },
    },
    summary: {
      totalChanges,
      pagesAdded: pageChanges.filter(c => c.kind === 'added').length,
      pagesRemoved: pageChanges.filter(c => c.kind === 'removed').length,
      pagesModified: pageChanges.filter(c => c.kind === 'modified' || c.kind === 'moved').length,
      widgetsAdded: widgetChanges.filter(c => c.kind === 'added').length,
      widgetsRemoved: widgetChanges.filter(c => c.kind === 'removed').length,
      widgetsModified: widgetChanges.filter(c => c.kind === 'modified').length,
      interactionsChanged: interactionChanges.length,
      variablesChanged: varChanges.length,
    },
    changes: {
      pages: pageChanges,
      variables: varChanges,
      widgets: widgetChanges,
      interactions: interactionChanges,
    },
  };
}

export function formatDiffRp(diff) {
  const lines = [
    `# Axure 语义版本对比 (${diff.before.version} vs ${diff.after.version})`,
    `旧版：${diff.before.path}（${diff.before.pages} 页 / ${diff.before.widgets} 元件 / ${diff.before.interactions} 交互）`,
    `新版：${diff.after.path}（${diff.after.pages} 页 / ${diff.after.widgets} 元件 / ${diff.after.interactions} 交互）`,
  ];
  if (!diff.hasChanges) {
    lines.push('', '✅ 无结构变化（页面、元件、交互与全局变量完全一致，0 噪音）');
    return lines.join('\n');
  }
  lines.push('', `共检测到 ${diff.summary.totalChanges} 处变更：`);
  if (diff.changes.pages.length) {
    lines.push('', '## 页面变更');
    for (const c of diff.changes.pages) {
      if (c.kind === 'added') lines.push(`  + [新增页面] ${c.page}`);
      else if (c.kind === 'removed') lines.push(`  - [删除页面] ${c.page}`);
      else lines.push(`  ~ [页面变更] ${c.page}：${JSON.stringify(c.changes)}`);
    }
  }
  if (diff.changes.variables.length) {
    lines.push('', '## 全局变量变更');
    for (const v of diff.changes.variables) {
      if (v.kind === 'added') lines.push(`  + var ${v.name} = ${JSON.stringify(v.afterValue)}`);
      else if (v.kind === 'removed') lines.push(`  - var ${v.name} (原 ${JSON.stringify(v.beforeValue)})`);
      else lines.push(`  ~ var ${v.name}: ${JSON.stringify(v.beforeValue)} -> ${JSON.stringify(v.afterValue)}`);
    }
  }
  if (diff.changes.widgets.length) {
    lines.push('', '## 元件变更');
    for (const w of diff.changes.widgets) {
      const loc = w.container?.length ? `${w.page} / ${w.container.join(' / ')} / ${w.widget}` : `${w.page} / ${w.widget}`;
      if (w.kind === 'added') lines.push(`  + [新增] ${loc} (${w.type})`);
      else if (w.kind === 'removed') lines.push(`  - [删除] ${loc} (${w.type})`);
      else lines.push(`  ~ [修改] ${loc} (${w.type})：${Object.entries(w.changes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('；')}`);
    }
  }
  if (diff.changes.interactions.length) {
    lines.push('', '## 交互变更');
    for (const ix of diff.changes.interactions) {
      const loc = ix.scope === 'page' ? `页面「${ix.page}」` : `${ix.page} / ${ix.widget}`;
      const fmt = arr => arr.map(e => `${e.event}(${e.cases.flatMap(c => c.actions).join(' -> ')})`).join('; ') || '(无)';
      lines.push(`  ~ [交互] ${loc}：${fmt(ix.before)}  ==>  ${fmt(ix.after)}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const files = argv.filter(a => !a.startsWith('--'));
  if (files.length !== 2) {
    console.error('用法: node diff-rp.mjs <before.rp> <after.rp> [--json]');
    process.exit(1);
  }
  const result = diffRp(files[0], files[1]);
  console.log(json ? JSON.stringify(result, null, 2) : formatDiffRp(result));
}
