// D3: 事故级损坏 .rp 文件外科手术抢救引擎（repair-rp）
// 从截断、中段置零、破坏 LZ4 manifest 头或删除单条记录的损坏 .rp 中打捞所有 CRC32 完好的 gzip 记录，
// 重建合法容器与版本号自述、修复悬空引用并输出诚实的《丢弃台账》（绝不静默丢弃、绝不覆盖原文件）。
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { synthesizeBlankProject } from './blank-synthesizer.mjs';
import { createGlobalVariable } from './create-global-variable.mjs';
import { guidKey } from './duplicate-page.mjs';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { fixPanelRegistry } from './fix-panel-registry.mjs';
import { encodePayload, field, parsePayload, walkNodes } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { appendPackage, encodeManifest, encodeRecord, insertRecord, parseRecord, readManifest, readRecords, replaceRecord } from './rp-records.mjs';
import { adaptNodesForVersion } from './version-adapt.mjs';

const NULL_GUID = '0'.repeat(32);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function tryDecompressGzipAt(file, offset) {
  // 1. Fast path: valid [4B compressedSize] prefix immediately before gzip magic
  if (offset >= 4) {
    const len = file.readUInt32LE(offset - 4);
    if (len >= 18 && offset + len <= file.length) {
      try {
        const raw = gunzipSync(file.subarray(offset, offset + len));
        return { raw, compressedSize: len };
      } catch {}
    }
  }
  // 2. Salvage path: 4-byte prefix wiped/corrupted; parse gzip header + inflateRawSync + verify CRC32/ISIZE
  if (offset + 18 > file.length) return null;
  if (file[offset] !== 0x1f || file[offset + 1] !== 0x8b || file[offset + 2] !== 8) return null;
  const flags = file[offset + 3];
  let p = offset + 10;
  if (flags & 4) {
    if (p + 2 > file.length) return null;
    p += 2 + file.readUInt16LE(p);
  }
  if (flags & 8) {
    while (p < file.length && file[p] !== 0) p++;
    p++;
  }
  if (flags & 16) {
    while (p < file.length && file[p] !== 0) p++;
    p++;
  }
  if (flags & 2) p += 2;
  if (p >= file.length) return null;
  try {
    const res = inflateRawSync(file.subarray(p), { info: true });
    const raw = res.buffer;
    const trailerOff = p + res.engine.bytesWritten;
    if (trailerOff + 8 > file.length) return null;
    const expectedCrc = file.readUInt32LE(trailerOff);
    const expectedSize = file.readUInt32LE(trailerOff + 4);
    if (crc32(raw) !== expectedCrc || (raw.length >>> 0) !== expectedSize) return null;
    return { raw, compressedSize: trailerOff + 8 - offset };
  } catch {
    return null;
  }
}

function scanSalvageableRecords(file, discarded) {
  const salvaged = [];
  for (let offset = 0; offset + 18 <= file.length; offset++) {
    if (file[offset] !== 0x1f || file[offset + 1] !== 0x8b || file[offset + 2] !== 8) continue;
    const dec = tryDecompressGzipAt(file, offset);
    if (!dec) continue;
    let parsed;
    try { parsed = parseRecord(dec.raw); } catch (err) {
      discarded.push({ kind: 'corrupt-record', offset, reason: err.message });
      continue;
    }
    const record = { index: salvaged.length, offset, compressedSize: dec.compressedSize, raw: dec.raw, ...parsed };
    if (record.strings) {
      try {
        record.graph = parsePayload(record);
      } catch (err) {
        discarded.push({ kind: 'unparseable-record', className: record.className, offset, reason: err.message });
        offset += dec.compressedSize - 1;
        continue;
      }
    }
    salvaged.push(record);
    offset += dec.compressedSize - 1;
  }
  return salvaged;
}

const guidsOf = g => g?.roots?.find(n => n.tag === 0x1e)?.values ?? [];
const packageGuidOf = g => guidsOf(g)[g?.roots?.find(n => n.tag === 0x12)?.value - 1] ?? guidsOf(g)[1];
const strOf = n => (n && n.tag === 8 ? n.text : undefined);
const widgetName = w => strOf(field(field(w.body, 'name-block') ?? {}, 'text')) ?? '';

function stringNode(strings, text) {
  let index = strings.indexOf(text);
  if (index < 0) { index = strings.length; strings.push(text); }
  return { tag: 8, value: index + 1, text };
}

function ensureNullGuid(graph) {
  const guids = guidsOf(graph);
  let idx = guids.indexOf(NULL_GUID);
  if (idx < 0) {
    guids.push(NULL_GUID);
    idx = guids.length - 1;
  }
  return idx + 1;
}

function sanitizeDiagramGraph(graph, strings, survivingStateGuids, version, pageLabel, discarded) {
  const guids = guidsOf(graph);
  const nullSlot = ensureNullGuid(graph);
  const rootObj = graph.objects.get(graph.roots.find(n => n.tag === 0xf)?.value);
  const diagram = graph.objects.get(field(rootObj?.body ?? {}, 'diagram')?.value);
  const diagItems = field(diagram?.body ?? {}, 'diagram-objects');

  const droppedWidgetIds = new Set();
  for (const obj of [...graph.objects.values()]) {
    if (obj.className === 'Axure:DiagramObject:ReferenceDiagramObject') {
      droppedWidgetIds.add(obj.id);
      discarded.push({
        kind: 'dropped-master-instance',
        page: pageLabel,
        widget: widgetName(obj) || `#${obj.id}`,
        reason: '母版跨包闭包未整体验证，为防反序列化空引用已安全移除母版实例',
      });
      continue;
    }
    if (obj.className === 'Axure:DiagramObject:DynamicPanel') {
      const pd = field(obj.body, 'panel-diagrams');
      const items = pd?.items ?? [];
      const kept = [];
      for (const item of items) {
        const gIdx = item.tag === 0x13 ? item.values[1] : item.value;
        const stateGuid = guids[gIdx - 1];
        if (stateGuid && survivingStateGuids.has(stateGuid)) {
          kept.push(item);
        } else {
          discarded.push({
            kind: 'dropped-panel-state',
            page: pageLabel,
            panel: widgetName(obj) || `#${obj.id}`,
            stateGuid: stateGuid ?? null,
            reason: '对应的 PanelState 记录已损坏或截断',
          });
        }
      }
      if (pd) pd.items = kept;
      if (kept.length === 0) {
        droppedWidgetIds.add(obj.id);
        discarded.push({
          kind: 'dropped-empty-panel',
          page: pageLabel,
          panel: widgetName(obj) || `#${obj.id}`,
          reason: '动态面板的所有状态记录均已损坏，已移除空面板以保证文件可打开',
        });
      }
    }
  }

  if (droppedWidgetIds.size && diagItems?.items) {
    diagItems.items = diagItems.items.filter(ref => !droppedWidgetIds.has(ref.value));
    graph.roots = graph.roots.filter(n => n.tag !== 9 || !droppedWidgetIds.has(n.id));
    for (const id of droppedWidgetIds) graph.objects.delete(id);
  }

  // Repair any dangling tag:3 references to nullSlot
  let repairedRefs = 0;
  walkNodes(graph.roots, node => {
    if (node.tag !== 3) return;
    if (graph.objects.has(node.value)) return;
    if (node.value >= 1 && node.value <= guids.length) return;
    node.value = nullSlot;
    repairedRefs++;
  });
  if (repairedRefs) {
    discarded.push({
      kind: 'repaired-dangling-refs',
      page: pageLabel,
      count: repairedRefs,
      reason: '损坏记录裁剪留下的悬空对象引用已重定向到空哨兵',
    });
  }

  adaptNodesForVersion([...graph.objects.values()], {
    version,
    str: text => stringNode(strings, text),
  });
}

function attachOwnedStates(outBuf, ownerPkgGuid, ownerRecordMeta, statesMap, version, pageLabel, discarded) {
  const guids = guidsOf(ownerRecordMeta.graph);
  const needed = [];
  const collect = g => {
    const gs = guidsOf(g);
    for (const obj of g.objects.values()) {
      if (obj.className !== 'Axure:DiagramObject:DynamicPanel') continue;
      for (const pair of field(obj.body, 'panel-diagrams')?.items ?? []) {
        const gIdx = pair.tag === 0x13 ? pair.values[1] : pair.value;
        const sg = gs[gIdx - 1];
        const rec = sg && statesMap.get(sg);
        if (rec && !needed.some(x => x.guid === sg)) {
          needed.push({ guid: sg, record: rec });
          collect(rec.graph);
        }
      }
    }
  };
  collect(ownerRecordMeta.graph);
  if (!needed.length) return outBuf;

  const ownerKey = guidKey(ownerPkgGuid);
  const findNode = (node, pred) => {
    for (const [k, child] of Object.entries(node.children ?? {})) {
      if (pred(k, child)) return child;
      const hit = findNode(child, pred);
      if (hit) return hit;
    }
    return null;
  };
  const insertedKeys = [];
  for (const { guid, record } of needed) {
    const stStrings = [...record.strings];
    sanitizeDiagramGraph(record.graph, stStrings, new Set(statesMap.keys()), version, pageLabel, discarded);
    const key = guidKey(guid);
    const mfNow = readManifest(outBuf);
    const ownerNode = findNode(mfNow.value.root, k => k === ownerKey);
    const ownerRec = readRecords(outBuf).find(r => r.offset - 8 - mfNow.dataStart === ownerNode.parts.package);
    outBuf = insertRecord(outBuf, key, encodeRecord(record, stStrings, encodePayload(record.graph.roots)), ownerRec);
    insertedKeys.push(key);
  }
  const mf = readManifest(outBuf);
  const ownerNode = findNode(mf.value.root, k => k === ownerKey);
  ownerNode.children ??= {};
  for (const key of insertedKeys) {
    ownerNode.children[key] = mf.value.root.children[key];
    delete mf.value.root.children[key];
  }
  return Buffer.concat([encodeManifest(outBuf, mf.value), outBuf.subarray(mf.dataStart)]);
}

export function repairRp(corruptInput, { allowEmpty = false } = {}) {
  const inputPath = (Buffer.isBuffer(corruptInput) || corruptInput instanceof Uint8Array) ? '(buffer)' : resolve(String(corruptInput));
  if (inputPath !== '(buffer)') assertNotProtected(inputPath);
  const buf = (Buffer.isBuffer(corruptInput) || corruptInput instanceof Uint8Array) ? Buffer.from(corruptInput) : readFileSync(inputPath);

  const discarded = [];
  let manifestOk = false;
  let origManifest = null;
  try {
    origManifest = readManifest(buf);
    manifestOk = true;
  } catch (err) {
    discarded.push({ kind: 'corrupt-manifest', reason: err.message });
  }

  const salvaged = scanSalvageableRecords(buf, discarded);
  let version = 11;
  if (buf.length >= 8 && buf[0] === 0xac && buf[1] === 0xef) {
    const hv = buf.readUInt16LE(2);
    if (hv === 9 || hv === 11) version = hv;
  } else {
    const firstRec = salvaged.find(r => r.strings);
    const rv = firstRec?.raw?.readUInt32LE(4);
    if (rv === 9 || rv === 11) version = rv;
  }

  const docRecord = salvaged.find(r => r.className === 'Axure:DesignDocument' && r.graph);
  const pageMetaByGuid = new Map();
  const pageOrder = [];
  const salvagedVars = [];
  if (docRecord) {
    const dg = docRecord.graph;
    const dGuids = guidsOf(dg);
    const dRoot = dg.objects.get(dg.roots.find(n => n.tag === 0xf)?.value);
    const infos = new Map();
    for (const item of field(dRoot?.body ?? {}, 'PackageInfos')?.items ?? []) {
      const info = dg.objects.get(item.value);
      const pid = field(info?.body ?? {}, 'package-id')?.values;
      if (!pid) continue;
      const kind = docRecord.strings[pid[0] - 1];
      const pkgGuid = dGuids[pid[1] - 1];
      const name = strOf(field(info.body, 'package-name')) ?? '(未命名)';
      if (kind === 'Axure:Page' && pkgGuid) infos.set(pid[1], { pkgGuid, name });
    }
    const site = dg.objects.get(field(dRoot?.body ?? {}, 'sitemap')?.value);
    const nodeTable = field(site?.body ?? {}, 'node-table');
    const tree = dg.objects.get(field(site?.body ?? {}, 'tree')?.value);
    const visitTree = node => {
      for (const ch of field(node?.body ?? {}, 'children')?.items ?? []) {
        const child = dg.objects.get(ch.value);
        if (!child) continue;
        const entry = nodeTable?.entries?.find(([k]) => k.value === child.id)?.[1];
        if (entry?.values) {
          const meta = infos.get(entry.values[1]);
          if (meta) {
            pageMetaByGuid.set(meta.pkgGuid, meta.name);
            pageOrder.push(meta.pkgGuid);
          }
        }
        visitTree(child);
      }
    };
    if (tree) visitTree(tree);
    for (const meta of infos.values()) {
      if (!pageMetaByGuid.has(meta.pkgGuid)) {
        pageMetaByGuid.set(meta.pkgGuid, meta.name);
        pageOrder.push(meta.pkgGuid);
      }
    }
    const varSet = [...dg.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
    for (const item of field(varSet?.body ?? {}, 'global-variables')?.items ?? []) {
      const v = dg.objects.get(item.value);
      const name = strOf(field(v?.body ?? {}, 'name'));
      if (name) salvagedVars.push({ name, value: strOf(field(v.body, 'default-value')) ?? '' });
    }
  } else {
    discarded.push({ kind: 'missing-design-document', reason: 'Axure:DesignDocument 记录损坏或丢失，页面名称将按顺序回退为「恢复页面 N」' });
  }

  const pageRecords = salvaged.filter(r => r.className === 'Axure:Page' && r.graph);
  const stateRecords = salvaged.filter(r => r.className === 'Axure:PanelState' && r.graph);
  const masterRecords = salvaged.filter(r => r.className === 'Axure:Master');
  for (const mr of masterRecords) {
    discarded.push({ kind: 'dropped-master', record: mr.index, reason: '独立母版包不参与第一阶段重构，已记录于丢弃台账' });
  }

  const statesByGuid = new Map();
  for (const sr of stateRecords) {
    const g = packageGuidOf(sr.graph);
    if (g && g !== NULL_GUID) statesByGuid.set(g, sr);
  }
  const pagesByGuid = new Map();
  for (const pr of pageRecords) {
    const g = packageGuidOf(pr.graph);
    if (g && g !== NULL_GUID) pagesByGuid.set(g, pr);
  }

  // Record any pages registered in DesignDocument/manifest whose Page record was lost
  for (const [pgGuid, pgName] of pageMetaByGuid) {
    if (!pagesByGuid.has(pgGuid)) {
      discarded.push({ kind: 'lost-page', page: pgName, guid: pgGuid, reason: '页面记录本身已损坏或被截断' });
    }
  }
  if (manifestOk && origManifest) {
    for (const [k] of Object.entries(origManifest.value.root.children ?? {})) {
      const found = salvaged.some(r => r.graph && guidKey(packageGuidOf(r.graph)) === k);
      if (!found) discarded.push({ kind: 'lost-manifest-package', key: k, reason: 'manifest 中登记的包记录未能从损坏流中打捞' });
    }
  }

  // Order surviving pages cleanly & deduplicate names
  const orderedPages = [];
  const seenPageGuids = new Set();
  for (const g of pageOrder) {
    const pr = pagesByGuid.get(g);
    if (pr && !seenPageGuids.has(g)) {
      seenPageGuids.add(g);
      orderedPages.push({ guid: g, record: pr, preferredName: pageMetaByGuid.get(g) });
    }
  }
  let fallbackIdx = 1;
  for (const [g, pr] of pagesByGuid) {
    if (seenPageGuids.has(g)) continue;
    seenPageGuids.add(g);
    orderedPages.push({ guid: g, record: pr, preferredName: pageMetaByGuid.get(g) || `恢复页面 ${fallbackIdx++}` });
  }

  if (orderedPages.length === 0 && !allowEmpty) {
    throw Object.assign(new Error('无法从损坏文件中抢救出任何完整页面记录（0 个可用 Axure:Page）'), {
      code: 'E_REPAIR_NO_PAGES_SALVAGED',
      discarded,
    });
  }

  const usedNames = new Set();
  const uniqueName = raw => {
    let name = (raw && raw.trim()) || `恢复页面 ${usedNames.size + 1}`;
    if (!usedNames.has(name.toLowerCase())) {
      usedNames.add(name.toLowerCase());
      return name;
    }
    let k = 2;
    while (usedNames.has(`${name} (${k})`.toLowerCase())) k++;
    const finalName = `${name} (${k})`;
    usedNames.add(finalName.toLowerCase());
    return finalName;
  };

  let outBuf = synthesizeBlankProject({ version, pageName: orderedPages.length ? uniqueName(orderedPages[0].preferredName) : 'Page 1' });
  const survivingStateGuids = new Set(statesByGuid.keys());

  if (orderedPages.length > 0) {
    const first = orderedPages[0];
    const firstName = [...usedNames][0] ? orderedPages[0].preferredName : 'Page 1';
    const firstRecStrings = [...first.record.strings];
    sanitizeDiagramGraph(first.record.graph, firstRecStrings, survivingStateGuids, version, firstName, discarded);

    // Replace synthesized seed Page 1 with salvaged first page, keeping its GUID
    const seedRecords = readRecords(outBuf);
    const seedPageRec = seedRecords.find(r => r.className === 'Axure:Page');
    const seedPageGraph = parsePayload(seedPageRec);
    const oldSeedGuid = packageGuidOf(seedPageGraph);
    const oldSeedKey = guidKey(oldSeedGuid);
    const newFirstKey = guidKey(first.guid);

    // Update DesignDocument PackageInfo GUID to match first.guid
    const docRec = seedRecords.find(r => r.className === 'Axure:DesignDocument');
    const docGraph = parsePayload(docRec);
    const docGuids = guidsOf(docGraph);
    const seedIdx = docGuids.indexOf(oldSeedGuid);
    if (seedIdx >= 0) docGuids[seedIdx] = first.guid;
    outBuf = replaceRecord(outBuf, docRec, encodeRecord(docRec, docRec.strings, encodePayload(docGraph.roots)));

    const curPageRec = readRecords(outBuf).find(r => r.className === 'Axure:Page');
    outBuf = replaceRecord(outBuf, curPageRec, encodeRecord(first.record, firstRecStrings, encodePayload(first.record.graph.roots)));

    const mf = readManifest(outBuf);
    if (mf.value.root.children?.[oldSeedKey] && oldSeedKey !== newFirstKey) {
      mf.value.root.children[newFirstKey] = mf.value.root.children[oldSeedKey];
      delete mf.value.root.children[oldSeedKey];
      outBuf = Buffer.concat([encodeManifest(outBuf, mf.value), outBuf.subarray(mf.dataStart)]);
    }
    outBuf = attachOwnedStates(outBuf, first.guid, first.record, statesByGuid, version, firstName, discarded);

    // Append remaining salvaged pages
    for (let i = 1; i < orderedPages.length; i++) {
      const item = orderedPages[i];
      const pageName = uniqueName(item.preferredName);
      const pStrings = [...item.record.strings];
      sanitizeDiagramGraph(item.record.graph, pStrings, survivingStateGuids, version, pageName, discarded);

      const curRecs = readRecords(outBuf);
      const curDocRec = curRecs.find(r => r.className === 'Axure:DesignDocument');
      const curDoc = parsePayload(curDocRec);
      const curDocGuids = guidsOf(curDoc);
      const curStrings = [...curDocRec.strings];
      const infos = [...curDoc.objects.values()].filter(o => o.className === 'Axure:PackageInfo');
      const baseInfo = infos.find(inf => curStrings[field(inf.body, 'package-id')?.values?.[0] - 1] === 'Axure:Page');
      const alloc = hex => { curDocGuids.push(hex ?? randomBytes(16).toString('hex')); return curDocGuids.length; };
      const newNodeId = alloc();
      const newInfoId = alloc();
      const newPkgId = alloc(item.guid);
      const newInfo = structuredClone(baseInfo);
      newInfo.id = newInfoId;
      field(newInfo.body, 'package-id').values[1] = newPkgId;
      Object.assign(field(newInfo.body, 'package-name'), stringNode(curStrings, pageName));
      const dRoot = curDoc.objects.get(curDoc.roots.find(n => n.tag === 0xf)?.value);
      const site = curDoc.objects.get(field(dRoot.body, 'sitemap')?.value);
      const tree = curDoc.objects.get(field(site.body, 'tree')?.value);
      const ref = v => ({ tag: 3, value: v });
      field(dRoot.body, 'PackageInfos').items.push(ref(newInfoId));
      field(site.body, 'node-table').entries.push([ref(newNodeId), { tag: 0x13, values: [stringNode(curStrings, 'Axure:PackageInfo').value, newPkgId] }]);
      field(tree.body, 'children').items.push(ref(newNodeId));
      const node = {
        tag: 9, id: newNodeId, classIndex: stringNode(curStrings, 'Axure:Node').value, className: 'Axure:Node',
        body: { tag: 1, entries: [[stringNode(curStrings, 'children'), { tag: 2, items: [] }], [stringNode(curStrings, 'parent-node'), ref(tree.id)], [stringNode(curStrings, 'tree'), ref(tree.id)]] },
      };
      curDoc.roots.splice(curDoc.roots.length - 1, 0, newInfo, node);
      outBuf = replaceRecord(outBuf, curDocRec, encodeRecord(curDocRec, curStrings, encodePayload(curDoc.roots)));
      outBuf = appendPackage(outBuf, guidKey(item.guid), encodeRecord(item.record, pStrings, encodePayload(item.record.graph.roots)));
      outBuf = attachOwnedStates(outBuf, item.guid, item.record, statesByGuid, version, pageName, discarded);
    }
  }

  for (const v of salvagedVars) {
    outBuf = createGlobalVariable(outBuf, v.name, { defaultValue: v.value, updateDefault: true }).file;
  }

  if (version === 9) outBuf = fixPanelRegistry(outBuf).file;

  const verification = readRp(outBuf);
  return {
    file: outBuf,
    report: {
      ok: true,
      evidence: 'structure',
      sourcePath: inputPath,
      sourceBytes: buf.length,
      outputBytes: outBuf.length,
      version,
      salvaged: {
        records: salvaged.length,
        pages: verification.counts.pages,
        widgets: verification.counts.widgets,
        panelStates: verification.counts.panelStates,
        interactions: verification.counts.interactions,
        globalVariables: verification.counts.globalVariables,
      },
      structure: {
        unparseable: verification.records.unparseable,
        danglingRefs: verification.counts.danglingRefs,
        problems: verification.counts.problems,
      },
      discardedCount: discarded.length,
      discarded,
    },
  };
}

export function formatRepairReport(report) {
  const s = report.salvaged;
  const lines = [
    `# Axure 损坏文件抢救报告 (RP${report.version})`,
    `输入：${report.sourcePath} (${report.sourceBytes} B) -> 重建：${report.outputBytes} B`,
    `抢救成果：${s.pages} 页、${s.widgets} 元件、${s.panelStates} 面板状态、${s.interactions} 交互、${s.globalVariables} 全局变量`,
    `结构三零：unparseable=${report.structure.unparseable} danglingRefs=${report.structure.danglingRefs} problems=${report.structure.problems}`,
    '',
    `## 丢弃与修正清单（共 ${report.discardedCount} 项，绝不静默丢失）`,
  ];
  if (!report.discarded.length) lines.push('  （无丢弃项）');
  else for (const d of report.discarded) lines.push(`  - [${d.kind}] ${d.page ?? d.record ?? ''} ${d.widget ?? d.panel ?? d.key ?? ''}：${d.reason}`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const files = argv.filter(a => !a.startsWith('--'));
  if (files.length !== 2) {
    console.error('用法: node repair-rp.mjs <corrupt.rp> <recovered.rp> [--json]');
    process.exit(1);
  }
  const src = resolve(files[0]);
  const dst = resolve(files[1]);
  assertNotProtected(src);
  assertWritable(dst);
  const { file, report } = repairRp(src);
  writeFileSync(dst, file, { flag: 'wx' });
  console.log(json ? JSON.stringify({ ...report, output: dst }, null, 2) : formatRepairReport({ ...report, output: dst }));
}
