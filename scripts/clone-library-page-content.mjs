import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readRecords, readManifest, encodeManifest, encodeRecord, replaceRecord, insertRecord } from './rp-records.mjs';
import { readRp } from './rp-read.mjs';
import { fixPanelRegistry } from './fix-panel-registry.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { closureOf, cloneInto } from './clone-closure.mjs';
import { detectFileVersion } from './version.mjs';
import { guidKey } from './duplicate-page.mjs';

// 页定位：默认按名字，**要求唯一**。
// 自带库里存在重名页（Sample UI Patterns.rplib 有 4 个 "Instructions"），
// 按名字无法区分，于是这些页从来克隆不了 —— 而 Tree 页里的 TextArea、
// Instructions 页里的 Hyperlink 等类就永远不出现在产物里，
// 被类覆盖审计误读成「工具缺失」。
// 出路：`sourcePageName` 支持 `#<记录号>` 形式，或显式传 sourcePageIndex。
const uniquePage = (summary, name, role, index) => {
  if (index !== undefined) {
    const page = summary.pages.find(p => p.record === index);
    if (!page) throw new Error(`${role} page record index ${index} not found`);
    return page;
  }
  const direct = /^#(\d+)$/.exec(String(name ?? ''));
  if (direct) {
    const page = summary.pages.find(p => p.record === Number(direct[1]));
    if (!page) throw new Error(`${role} page record index ${direct[1]} not found`);
    return page;
  }
  const pages = summary.pages.filter(page => page.name === name);
  if (pages.length !== 1) throw new Error(`${role} page "${name}" must be unique; found ${pages.length}（重名页请用 #<记录号> 指定）`);
  return pages[0];
};

const styleOf = (graph, widget) => graph.objects.get(field(widget.body, 'MyStyle')?.value);
const positionOf = (graph, widget) => {
  for (const item of field(styleOf(graph, widget)?.body ?? {}, 'PropList')?.items ?? []) {
    if (field(item, 'DOAName')?.value !== 3221225573) continue;
    const value = field(item, 'Value');
    return { x: field(value, 'X')?.value, y: field(value, 'Y')?.value };
  }
  return null;
};

const moveTo = (graph, widget, dx, dy) => {
  if (!dx && !dy) return;
  for (const item of field(styleOf(graph, widget)?.body ?? {}, 'PropList')?.items ?? []) {
    if (field(item, 'DOAName')?.value !== 3221225573) continue;
    const value = field(item, 'Value');
    const x = field(value, 'X'), y = field(value, 'Y');
    if (x && typeof x.value === 'number') x.value += dx;
    if (y && typeof y.value === 'number') y.value += dy;
    return;
  }
};

const packageGuid = graph => graph.roots.find(n => n.tag === 0x1e).values[graph.roots.find(n => n.tag === 0x12).value - 1];

export function cloneLibraryPageContent(sourceFile, targetFile, outputFile, {
  sourcePageName, targetPageName, x, y, sourcePageIndex
}) {
  if (!sourcePageName || !targetPageName) throw new Error('sourcePageName and targetPageName are required');
  if (x !== undefined && !Number.isFinite(x)) throw new Error('x must be a finite number');
  if (y !== undefined && !Number.isFinite(y)) throw new Error('y must be a finite number');
  let output = readFileSync(targetFile);
  const sourceBytes = readFileSync(sourceFile);
  const sourceSummary = readRp(sourceBytes, { path: sourceFile });
  const targetSummary = readRp(output, { path: targetFile });
  const sourceMeta = uniquePage(sourceSummary, sourcePageName, 'Source', sourcePageIndex);
  const targetMeta = uniquePage(targetSummary, targetPageName, 'Target');
  const sourceRecords = readRecords(sourceBytes);
  const targetRecords = readRecords(output);
  const sourcePage = sourceRecords.find(record => record.index === sourceMeta.record && record.className === 'Axure:Page');
  const targetPage = targetRecords.find(record => record.index === targetMeta.record && record.className === 'Axure:Page');
  if (!sourcePage || !targetPage) throw new Error('Source or target Page record not found');

  const sourceGraph = parsePayload(sourcePage);
  const targetGraph = parsePayload(targetPage);
  const sourcePageObject = [...sourceGraph.objects.values()].find(object => object.className === 'Axure:Page');
  const sourceDiagram = sourceGraph.objects.get(field(sourcePageObject.body, 'diagram').value);
  const sourceRoots = (field(sourceDiagram.body, 'diagram-objects')?.items ?? [])
    .map(item => item.value).filter(id => sourceGraph.objects.has(id));
  if (!sourceRoots.length) throw new Error(`Source page "${sourcePageName}" has no diagram objects`);

  const sourceStrings = sourcePage.strings;
  const targetStrings = [...targetPage.strings];
  const closure = new Set();
  for (const rootId of sourceRoots) for (const id of closureOf(sourceGraph, rootId)) closure.add(id);

  // 依赖审计：递归收集 owned PanelState 包与母版依赖
  const sourceStates = new Map(sourceRecords.filter(r => r.className === 'Axure:PanelState').map(r => {
    const g = parsePayload(r);
    return [packageGuid(g), { record: r, graph: g }];
  }));
  const sourceGuids = sourceGraph.roots.find(n => n.tag === 0x1e).values;
  const packages = new Map();
  const masterDependencies = [];

  const collectDependencies = (graph, ids) => {
    const table = graph.roots.find(n => n.tag === 0x1e).values;
    for (const id of ids) {
      const obj = graph.objects.get(id);
      if (obj?.className === 'Axure:DiagramObject:DynamicPanel') {
        const diagrams = field(obj.body, 'panel-diagrams');
        for (const pair of (diagrams?.items ?? [])) {
          const guid = table[pair.values[1] - 1];
          if (!guid || guid === '0'.repeat(32)) continue;
          const pkg = sourceStates.get(guid);
          if (!pkg) throw new Error(`Nested panel state package is missing: ${guid}`);
          if (packages.has(guid)) continue;
          packages.set(guid, pkg);
          collectDependencies(pkg.graph, new Set(pkg.graph.objects.keys()));
        }
      }
      if (obj?.className === 'Axure:DiagramObject:ReferenceDiagramObject') {
        const pair = field(obj.body, 'ReferredMaster');
        const guid = table[pair?.values?.[1] - 1];
        const targetMasters = targetRecords.filter(r => r.className === 'Axure:Master');
        const targetHasMaster = targetMasters.some(r => packageGuid(parsePayload(r)) === guid);
        if (!targetHasMaster) {
          throw new Error(`Library page "${sourcePageName}" references master "${guid}" which is not present in target file; unverified external master import is rejected`);
        }
        if (!masterDependencies.includes(guid)) masterDependencies.push(guid);
      }
    }
  };
  collectDependencies(sourceGraph, closure);

  const positioned = sourceRoots.map(id => positionOf(sourceGraph, sourceGraph.objects.get(id))).filter(p =>
    p && typeof p.x === 'number' && typeof p.y === 'number');
  const minX = positioned.length ? Math.min(...positioned.map(p => p.x)) : 0;
  const minY = positioned.length ? Math.min(...positioned.map(p => p.y)) : 0;
  const dx = x === undefined ? 0 : Number(x) - minX;
  const dy = y === undefined ? 0 : Number(y) - minY;

  // 建立新包 GUID 映射（私有 GUID 重新随机化）
  const identities = new Map();
  for (const [oldGuid] of packages) {
    identities.set(oldGuid, randomBytes(16).toString('hex'));
  }

  // 构建导入计划摘要
  const plan = {
    sourcePage: sourcePageName,
    targetPage: targetPageName,
    sourceRoots: sourceRoots.map(id => ({ id, className: sourceGraph.objects.get(id)?.className })),
    closureObjects: closure.size,
    ownedPackages: [...packages.keys()].map(oldGuid => ({
      oldGuid,
      newGuid: identities.get(oldGuid),
      className: 'Axure:PanelState'
    })),
    masterDependencies,
    offset: { x: dx, y: dy }
  };

  // 克隆 Page 图内对象
  const cloned = cloneInto({
    version: detectFileVersion(output ?? targetBytes),
    srcGraph: sourceGraph,
    srcStrings: sourceStrings,
    dstGraph: targetGraph,
    dstStrings: targetStrings,
    closure,
    rootOldId: sourceRoots[0]
  });

  // 同步新分配的 PanelState GUID 到目标 Page 的 tag 0x1e GUID 表中
  const dstGuids = targetGraph.roots.find(n => n.tag === 0x1e).values;
  for (const [oldIdx, mapped] of cloned.guidMap) {
    const oldGuid = sourceGuids[oldIdx - 1];
    if (identities.has(oldGuid)) {
      dstGuids[mapped.index - 1] = identities.get(oldGuid);
    }
  }

  // 平移坐标
  for (const id of sourceRoots) {
    const clone = targetGraph.objects.get(cloned.idMap.get(id));
    if (clone) moveTo(targetGraph, clone, dx, dy);
  }

  const targetPageObject = [...targetGraph.objects.values()].find(object => object.className === 'Axure:Page');
  const targetDiagram = targetGraph.objects.get(field(targetPageObject.body, 'diagram').value);
  field(targetDiagram.body, 'diagram-objects').items.push(...sourceRoots.map(id => ({ tag: 3, value: cloned.idMap.get(id) })));
  targetGraph.roots.splice(targetGraph.roots.length - 1, 0, ...cloned.created);
  output = replaceRecord(output, targetPage, encodeRecord(targetPage, targetStrings, encodePayload(targetGraph.roots)));

  // 若存在子状态包，依次插入 Axure:PanelState 记录并更新 manifest
  if (packages.size > 0) {
    const targetPageGuid = packageGuid(targetGraph);
    const ownerKey = guidKey(targetPageGuid);
    const findNode = (node, predicate) => {
      for (const [key, child] of Object.entries(node.children ?? {})) {
        if (predicate(key, child)) return { key, node: child };
        const found = findNode(child, predicate);
        if (found) return found;
      }
    };

    const copiedKeys = [];
    for (const [oldGuid, pkg] of packages) {
      const newGuid = identities.get(oldGuid);
      const copiedRoots = structuredClone(pkg.graph.roots);
      const table = copiedRoots.find(n => n.tag === 0x1e).values;
      for (let i = 0; i < table.length; i++) {
        if (identities.has(table[i])) table[i] = identities.get(table[i]);
        else if (table[i] === oldGuid) table[i] = newGuid;
        else if (table[i] !== '0'.repeat(32)) table[i] = randomBytes(16).toString('hex');
      }
      const key = guidKey(newGuid);
      const manifestNow = readManifest(output);
      const ownerNode = findNode(manifestNow.value.root, k => k === ownerKey)?.node;
      if (!ownerNode) throw new Error(`Target page node not found in manifest: ${ownerKey}`);
      const ownerRecord = readRecords(output).find(r => r.offset - 8 - manifestNow.dataStart === ownerNode.parts.package);
      output = insertRecord(output, key, encodeRecord(pkg.record, pkg.record.strings, encodePayload(copiedRoots)), ownerRecord);
      copiedKeys.push({ key, ownerKey });
    }

    const manifest = readManifest(output);
    for (const { key, ownerKey } of copiedKeys) {
      const ownerNode = findNode(manifest.value.root, k => k === ownerKey).node;
      ownerNode.children ??= {};
      ownerNode.children[key] = manifest.value.root.children[key];
      delete manifest.value.root.children[key];
      const ordered = { children: ownerNode.children, ...ownerNode };
      for (const k of Object.keys(ownerNode)) delete ownerNode[k];
      Object.assign(ownerNode, ordered);
    }
    output = Buffer.concat([encodeManifest(output, manifest.value), output.subarray(manifest.dataStart)]);
  }

  // RP 9 靠 DesignDocument 里的面板注册链解析状态包；缺失时面板状态内容什么都不画。
  // RP 11 没有这个模型，fixPanelRegistry 对非 RP 9 原样跳过。
  const panelRegistry = fixPanelRegistry(output);
  output = panelRegistry.file;
  writeFileSync(outputFile, output, { flag: 'wx' });
  return {
    outputFile,
    panelRegistry: panelRegistry.report,
    sourcePage: sourcePageName,
    targetPage: targetPageName,
    clonedRoots: sourceRoots.length,
    closureObjects: cloned.created.length,
    offset: { x: dx, y: dy },
    plan
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = Number(args[++i]);
    else positionals.push(args[i]);
  }
  const [sourceFile, targetFile, outputFile, sourcePageName, targetPageName] = positionals;
  if (!targetPageName) {
    console.error('Usage: node clone-library-page-content.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> [--x N --y N]');
    process.exit(1);
  }
  console.log(JSON.stringify(cloneLibraryPageContent(sourceFile, targetFile, outputFile, {
    sourcePageName, targetPageName, x: flags.x, y: flags.y, sourcePageIndex: flags.index
  }), null, 2));
}
