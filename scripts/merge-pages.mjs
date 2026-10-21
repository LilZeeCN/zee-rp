#!/usr/bin/env node
// merge-pages.mjs — 将多个单页或多页 .rp 合并为一个多页 .rp（支持重命名、GUID 重映射与动态面板 PanelState 闭包迁移）
// 用法：
//   node scripts/merge-pages.mjs -o <merged.rp> <page1.rp[:页面1名称]> <page2.rp[:页面2名称]> ...
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readRecords,
  encodeRecord,
  replaceRecord,
  appendPackage,
  insertRecord,
  readManifest,
  encodeManifest,
} from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { guidKey } from './duplicate-page.mjs';
import { fixPanelRegistry } from './fix-panel-registry.mjs';

const NULL_GUID = '0'.repeat(32);
const RESERVED_GUIDS = new Set([
  NULL_GUID,
  '78563412cdabefcdefababcdeffedcba',
  '4ffb380b33f19a4791117af9ea33bbd0',
  '0c0da41305fd2748bca3d523cb855c91',
  'a70aa02f1f4bdc499321e356041b831c',
  'a70aa03f1f4bdc499321e356041b831c',
]);

const guidTable = graph => graph.roots.find(n => n.tag === 0x1e)?.values;
const packageGuid = graph => guidTable(graph)?.[graph.roots.find(n => n.tag === 0x12)?.value - 1];

function stringNode(strings, text) {
  let index = strings.indexOf(text);
  if (index < 0) {
    index = strings.length;
    strings.push(text);
  }
  return { tag: 8, value: index + 1, text };
}

function pagePackageName(info, strings) {
  const packageId = field(info.body, 'package-id');
  const type = strings[packageId?.values?.[0] - 1];
  return type === 'Axure:Page' ? field(info.body, 'package-name')?.text : undefined;
}

function planExternalPageCopy(srcBuf, srcRecords, pageGraph) {
  const manifest = readManifest(srcBuf);
  const graphs = srcRecords
    .filter(r => ['Axure:Page', 'Axure:Master', 'Axure:PanelState'].includes(r.className))
    .map(record => ({ record, graph: parsePayload(record) }));
  const states = new Map(
    graphs
      .filter(pkg => pkg.record.className === 'Axure:PanelState')
      .map(pkg => [packageGuid(pkg.graph), pkg])
  );
  const sourceGuid = packageGuid(pageGraph);
  const owners = new Map();
  const visit = (node, owner) => {
    const pkg = graphs.find(p => p.record.offset === manifest.dataStart + (node.parts?.package ?? -9) + 8);
    if (pkg && ['Axure:Page', 'Axure:Master'].includes(pkg.record.className)) owner = packageGuid(pkg.graph);
    if (pkg?.record.className === 'Axure:PanelState') owners.set(packageGuid(pkg.graph), owner);
    for (const child of Object.values(node.children ?? {})) visit(child, owner);
  };
  visit(manifest.value.root, null);

  const packages = new Map();
  const identities = new Map();
  const collect = graph => {
    const table = guidTable(graph);
    for (const object of graph.objects.values()) {
      if (object.className !== 'Axure:DiagramObject:DynamicPanel') continue;
      for (const pair of field(object.body, 'panel-diagrams')?.items ?? []) {
        const guid = table[pair.values?.[1] - 1];
        const pkg = states.get(guid);
        if (!pkg || owners.get(guid) !== sourceGuid) {
          throw new Error(`PanelState ${guid} must exist and belong to the source Page`);
        }
        if (packages.has(guid)) continue;
        packages.set(guid, pkg);
        collect(pkg.graph);
      }
    }
  };
  collect(pageGraph);

  const allocate = guid => {
    if (!guid || RESERVED_GUIDS.has(guid)) return;
    if (!identities.has(guid)) identities.set(guid, randomBytes(16).toString('hex'));
  };
  for (const graph of [pageGraph, ...[...packages.values()].map(pkg => pkg.graph)]) {
    const table = guidTable(graph);
    for (let i = 0; i < table.length; i++) {
      allocate(table[i]);
    }
  }
  return { packages, identities };
}

function remapGuidsInPlace(graph, identities) {
  const table = guidTable(graph);
  for (let i = 0; i < table.length; i++) {
    if (identities.has(table[i])) table[i] = identities.get(table[i]);
  }
}

function cloneOwnedStatesIntoTarget(out, newPageGuid, packages, identities) {
  if (packages.size === 0) return out;
  const ownerKey = guidKey(newPageGuid);
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
    remapGuidsInPlace({ roots: copiedRoots }, identities);
    const key = guidKey(newGuid);
    const manifestNow = readManifest(out);
    const ownerNode = findNode(manifestNow.value.root, k => k === ownerKey)?.node;
    if (!ownerNode) throw new Error(`Target page node not found in manifest: ${ownerKey}`);
    const ownerRecord = readRecords(out).find(r => r.offset - 8 - manifestNow.dataStart === ownerNode.parts.package);
    out = insertRecord(out, key, encodeRecord(pkg.record, pkg.record.strings, encodePayload(copiedRoots)), ownerRecord);
    copiedKeys.push({ key, ownerKey });
  }
  const manifest = readManifest(out);
  for (const { key, ownerKey: ok } of copiedKeys) {
    const ownerNode = findNode(manifest.value.root, k => k === ok).node;
    ownerNode.children ??= {};
    ownerNode.children[key] = manifest.value.root.children[key];
    delete manifest.value.root.children[key];
    const ordered = { children: ownerNode.children, ...ownerNode };
    for (const k of Object.keys(ownerNode)) delete ownerNode[k];
    Object.assign(ownerNode, ordered);
  }
  return Buffer.concat([encodeManifest(out, manifest.value), out.subarray(manifest.dataStart)]);
}

function selectSourcePageRecord(srcRecords, sourcePageName = null) {
  const pageRecs = srcRecords.filter(r => r.className === 'Axure:Page');
  if (!pageRecs.length) throw new Error('Source .rp has no Axure:Page records');
  if (!sourcePageName) return { pageRec: pageRecs[0], origName: 'Page 1' };

  const docRec = srcRecords.find(r => r.className === 'Axure:DesignDocument');
  if (!docRec) return { pageRec: pageRecs[0], origName: sourcePageName };
  const doc = parsePayload(docRec);
  const docGuids = doc.roots[0]?.values ?? [];
  const strings = docRec.strings;
  const infos = [...doc.objects.values()].filter(o => o.className === 'Axure:PackageInfo');

  for (const pr of pageRecs) {
    const pg = parsePayload(pr);
    const pGuid = packageGuid(pg);
    const info = infos.find(
      inf => pagePackageName(inf, strings) && docGuids[field(inf.body, 'package-id')?.values?.[1] - 1] === pGuid
    );
    const pName = info ? pagePackageName(info, strings) : null;
    if (pName === sourcePageName) {
      return { pageRec: pr, origName: pName };
    }
  }
  return { pageRec: pageRecs[0], origName: sourcePageName };
}

/**
 * 将多个单页或多页 .rp 合并为一个多页 .rp Buffer。
 * @param {Array<{buf?: Buffer, file?: string, name?: string, sourcePageName?: string}>} pageInputs
 * @returns {Buffer}
 */
export function mergePages(pageInputs) {
  if (!Array.isArray(pageInputs) || pageInputs.length === 0) {
    throw new Error('mergePages requires at least 1 page input');
  }

  const firstInput = pageInputs[0];
  let out = firstInput.buf ? Buffer.from(firstInput.buf) : readFileSync(firstInput.file);

  if (firstInput.name) {
    const baseRecs = readRecords(out);
    const baseDocRec = baseRecs.find(r => r.className === 'Axure:DesignDocument');
    if (!baseDocRec) throw new Error('Base .rp: DesignDocument not found');
    const baseDoc = parsePayload(baseDocRec);
    const baseStrings = [...baseDocRec.strings];
    const infos = [...baseDoc.objects.values()].filter(o => o.className === 'Axure:PackageInfo');
    const baseInfo = infos.find(info => pagePackageName(info, baseStrings));
    if (baseInfo) {
      Object.assign(field(baseInfo.body, 'package-name'), stringNode(baseStrings, firstInput.name));
      out = replaceRecord(out, baseDocRec, encodeRecord(baseDocRec, baseStrings, encodePayload(baseDoc.roots)));
    }
  }

  for (let i = 1; i < pageInputs.length; i++) {
    const item = pageInputs[i];
    const srcBuf = item.buf ? Buffer.from(item.buf) : readFileSync(item.file);
    const srcRecs = readRecords(srcBuf);
    const { pageRec: extraPageRec, origName } = selectSourcePageRecord(srcRecs, item.sourcePageName || null);
    const extraName = item.name || origName || `Page ${i + 1}`;
    const extraPage = parsePayload(extraPageRec);

    const { packages, identities } = planExternalPageCopy(srcBuf, srcRecs, extraPage);
    remapGuidsInPlace(extraPage, identities);
    const newPackageGuid = packageGuid(extraPage);
    if (!newPackageGuid || newPackageGuid === NULL_GUID) {
      throw new Error(`Extra page ${extraName}: invalid package GUID after remap`);
    }

    const curRecs = readRecords(out);
    const curDocRec = curRecs.find(r => r.className === 'Axure:DesignDocument');
    const curDoc = parsePayload(curDocRec);
    const docGuids = curDoc.roots[0]?.values;
    const curStrings = [...curDocRec.strings];
    const infos = [...curDoc.objects.values()].filter(o => o.className === 'Axure:PackageInfo');
    const baseInfo = infos.find(info => pagePackageName(info, curStrings));
    if (!baseInfo) throw new Error('Target .rp: page PackageInfo not found');
    if (infos.some(info => pagePackageName(info, curStrings) === extraName)) {
      throw new Error(
        `[ERR_DUPLICATE_PAGE_NAME] Target .rp already has page named "${extraName}". Use <file.rp:新页名> or --name "${extraName}=新页名" to disambiguate.`
      );
    }

    const alloc = hex => {
      docGuids.push(hex ?? randomBytes(16).toString('hex'));
      return docGuids.length;
    };
    const newNodeId = alloc();
    const newInfoId = alloc();
    const newPackageId = alloc(newPackageGuid);
    const newInfo = structuredClone(baseInfo);
    newInfo.id = newInfoId;
    field(newInfo.body, 'package-id').values[1] = newPackageId;
    Object.assign(field(newInfo.body, 'package-name'), stringNode(curStrings, extraName));

    const docRoot = curDoc.objects.get(curDoc.roots.find(n => n.tag === 0x0f)?.value);
    const site = curDoc.objects.get(field(docRoot?.body ?? {}, 'sitemap')?.value);
    const tree = curDoc.objects.get(field(site?.body ?? {}, 'tree')?.value);
    if (!docRoot || !site || !tree) throw new Error('Target .rp: sitemap structure not found');
    const ref = value => ({ tag: 3, value });
    field(docRoot.body, 'PackageInfos').items.push(ref(newInfoId));
    field(site.body, 'node-table').entries.push([
      ref(newNodeId),
      { tag: 0x13, values: [stringNode(curStrings, 'Axure:PackageInfo').value, newPackageId] },
    ]);
    field(tree.body, 'children').items.push(ref(newNodeId));
    const node = {
      tag: 9,
      id: newNodeId,
      classIndex: stringNode(curStrings, 'Axure:Node').value,
      className: 'Axure:Node',
      body: {
        tag: 1,
        entries: [
          [stringNode(curStrings, 'children'), { tag: 2, items: [] }],
          [stringNode(curStrings, 'parent-node'), ref(tree.id)],
          [stringNode(curStrings, 'tree'), ref(tree.id)],
        ],
      },
    };
    curDoc.roots.splice(curDoc.roots.length - 1, 0, newInfo, node);

    out = replaceRecord(out, curDocRec, encodeRecord(curDocRec, curStrings, encodePayload(curDoc.roots)));
    out = appendPackage(
      out,
      guidKey(newPackageGuid),
      encodeRecord(extraPageRec, extraPageRec.strings, encodePayload(extraPage.roots))
    );
    out = cloneOwnedStatesIntoTarget(out, newPackageGuid, packages, identities);
  }

  return fixPanelRegistry(out).file;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    console.log(`用法:
  node scripts/merge-pages.mjs -o <merged.rp> [--name <原名或序号=新页名>] <page1.rp[:页面1名称]> <page2.rp[:页面2名称]> ...

选项:
  -o, --out <path>          输出合并后的多页 .rp 路径 (必填)
  --name <old=new>          重命名指定页面 (可多次传入；序号为输入页顺序、从 1 开始，例如 "2=详情页"；也可用 "Page 1=首页")
  -h, --help                显示帮助信息`);
    process.exit(args.length === 0 ? 1 : 0);
  }
  let outFile = null;
  const pageSpecs = [];
  const nameMappings = new Map();
  const usedNameMappings = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--out') {
      outFile = resolve(args[++i]);
    } else if (args[i] === '--name') {
      const pair = String(args[++i] || '');
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        nameMappings.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
      } else if (pair) {
        console.warn(`[WARN_INVALID_NAME_MAPPING] 忽略无法解析的 --name "${pair}"（应为 old=new）`);
      }
    } else {
      const arg = args[i];
      const colonIdx = arg.indexOf(':');
      if (colonIdx > 0) {
        pageSpecs.push({ file: resolve(arg.slice(0, colonIdx)), name: arg.slice(colonIdx + 1) });
      } else {
        pageSpecs.push({ file: resolve(arg) });
      }
    }
  }
  for (let idx = 0; idx < pageSpecs.length; idx++) {
    const spec = pageSpecs[idx];
    const idxKey = String(idx + 1);
    if (nameMappings.has(idxKey)) {
      spec.name = nameMappings.get(idxKey);
      usedNameMappings.add(idxKey);
    } else if (spec.name && nameMappings.has(spec.name)) {
      spec.name = nameMappings.get(spec.name);
      usedNameMappings.add(spec.name);
    } else if (!spec.name && nameMappings.has('Page 1') && idx === 0) {
      spec.name = nameMappings.get('Page 1');
      usedNameMappings.add('Page 1');
    }
  }
  const unusedMappings = [...nameMappings.keys()].filter(key => !usedNameMappings.has(key));
  if (unusedMappings.length) {
    console.warn(
      `[WARN_UNUSED_NAME_MAPPING] 以下 --name 未匹配任何输入页，已忽略：${unusedMappings.join(', ')}` +
      `（序号按输入页顺序从 1 开始；也可用原页名匹配）`
    );
  }
  if (!outFile || pageSpecs.length === 0) {
    console.error('Usage: node scripts/merge-pages.mjs -o <merged.rp> [--name <old=new>] <page1.rp[:页面1名称]> <page2.rp[:页面2名称]> ...');
    process.exit(1);
  }
  const merged = mergePages(pageSpecs);
  writeFileSync(outFile, merged);
  console.log(JSON.stringify({ ok: true, outFile, pagesMerged: pageSpecs.length, bytes: merged.length }, null, 2));
}
