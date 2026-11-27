// D4: RP11 -> RP9 原生版本降级编译器（downgrade-rp）
// 执行有证据门槛的容器/记录降级：拒绝或显式记录不兼容 RP11 特性、补齐 RP9 PackageInfo.root-panel-infos、
// 重写 DocumentSettings / xml:BreakingChanges / 版本头与 manifest version-part、调用 version-adapt 转换并注入 RP9 必填键。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeBlankProject } from './blank-synthesizer.mjs';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { fixPanelRegistry } from './fix-panel-registry.mjs';
import { inspectEditorReadiness } from './native-check.mjs';
import { encodePayload, field, parsePayload, walkNodes } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { encodeManifest, encodeRecord, readManifest, readRecords, replaceRecords } from './rp-records.mjs';
import { adaptNodesForVersion } from './version-adapt.mjs';
import {
  DOA_BASE_MASK,
  RP11_ONLY_CLASSES,
  RP11_ONLY_DOA_CODES,
  RP11_ONLY_EVENTS,
  RP11_ONLY_FCALLS,
  RP11_ONLY_KEYS,
  RP9_REQUIRED_KEYS,
} from './version-fields.mjs';
import { lintVersionKeys } from './version-lint.mjs';
import { detectFileVersion } from './version.mjs';

const RP11_EVENT_CODE_NAME = new Map(Object.entries(RP11_ONLY_EVENTS).map(([k, v]) => [v, k]));
const RP11_CLASS_SET = new Set(RP11_ONLY_CLASSES);
const RP11_DOA_MAP = new Map(Object.entries(RP11_ONLY_DOA_CODES).map(([hex, name]) => [Number(hex), name]));

function strNode(strings, text) {
  let idx = strings.indexOf(text);
  if (idx < 0) {
    idx = strings.length;
    strings.push(text);
  }
  return { tag: 8, value: idx + 1, text };
}

function collectReachableObjectIds(graph, rootId, out = new Set()) {
  if (!rootId || out.has(rootId)) return out;
  const obj = graph.objects.get(rootId);
  if (!obj) return out;
  out.add(rootId);
  walkNodes([obj], node => {
    if (node.tag === 3 && node.value !== rootId && graph.objects.has(node.value) && !out.has(node.value)) {
      collectReachableObjectIds(graph, node.value, out);
    }
  });
  return out;
}

function pruneTreeSubtree(graph, treeMap, targetNodeId, removedNodeIds = new Set()) {
  if (removedNodeIds.has(targetNodeId)) return;
  removedNodeIds.add(targetNodeId);
  const nodeObj = graph.objects.get(targetNodeId);
  for (const ch of field(nodeObj?.body ?? {}, 'children')?.items ?? []) {
    pruneTreeSubtree(graph, treeMap, ch.value, removedNodeIds);
  }
  // Remove child reference from parent
  const parentId = field(nodeObj?.body ?? {}, 'parent-node')?.value;
  const parentObj = parentId ? graph.objects.get(parentId) : null;
  const parentChildren = field(parentObj?.body ?? {}, 'children');
  if (parentChildren?.items) {
    parentChildren.items = parentChildren.items.filter(ref => ref.value !== targetNodeId);
  }
  // Also unlink from any node's children just in case
  for (const o of graph.objects.values()) {
    const ch = field(o.body, 'children');
    if (ch?.items) ch.items = ch.items.filter(ref => ref.value !== targetNodeId);
  }
  // Remove from node-table & graph objects/roots
  const nodeTable = field(treeMap.body, 'node-table');
  const payloadIds = new Set();
  if (nodeTable?.entries) {
    nodeTable.entries = nodeTable.entries.filter(([kRef, vRef]) => {
      if (kRef?.value === targetNodeId) {
        if (vRef?.tag === 3) payloadIds.add(vRef.value);
        return false;
      }
      return true;
    });
  }
  graph.objects.delete(targetNodeId);
  for (const pid of payloadIds) graph.objects.delete(pid);
  graph.roots = graph.roots.filter(n => n.tag !== 9 || (!removedNodeIds.has(n.id) && !payloadIds.has(n.id)));
}

function scanAndSanitizeRecord(rec, graph, strings, { stripUnsupported, dropped, unsupported }) {
  const recLabel = rec.className || `record#${rec.index}`;
  const guids = graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
  const pkgIndex = graph.roots.find(n => n.tag === 0x12)?.value;
  const pkgGuid = pkgIndex ? guids[pkgIndex - 1] : null;
  const locBase = pkgGuid ? `${recLabel}:${pkgGuid.slice(0, 8)}` : recLabel;

  const detectFcall = rootId => {
    for (const id of collectReachableObjectIds(graph, rootId)) {
      const o = graph.objects.get(id);
      if (!o || typeof o.className !== 'string' || !o.className.startsWith('Axure:STO:')) continue;
      let hit = null;
      walkNodes([o], node => {
        if (hit || node.tag !== 8) return;
        const text = node.text ?? strings[node.value - 1];
        if (RP11_ONLY_FCALLS.has(text)) hit = text;
      });
      if (hit) return hit;
    }
    return null;
  };

  // 1. Scan Axure:InteractionTreeMap subtrees for RP11-only events, classes, or STO functions
  for (const tm of [...graph.objects.values()]) {
    if (tm.className !== 'Axure:InteractionTreeMap') continue;
    const nodeTable = field(tm.body, 'node-table');
    if (!nodeTable?.entries) continue;
    for (const [nRef, pRef] of [...nodeTable.entries]) {
      if (!graph.objects.has(nRef?.value) || pRef?.tag !== 3) continue;
      const payload = graph.objects.get(pRef.value);
      if (!payload) continue;
      let issue = null;
      if (payload.className === 'Axure:InteractionEvent') {
        const evCode = field(payload.body, 'event-type')?.value;
        const evName = RP11_EVENT_CODE_NAME.get(evCode);
        if (evName) issue = { kind: 'rp11-event', name: evName };
      } else if (RP11_CLASS_SET.has(payload.className)) {
        issue = { kind: 'rp11-class', name: payload.className };
      } else {
        for (const id of collectReachableObjectIds(graph, payload.id)) {
          const subObj = graph.objects.get(id);
          if (subObj && RP11_CLASS_SET.has(subObj.className)) {
            issue = { kind: 'rp11-class', name: subObj.className };
            break;
          }
        }
        if (!issue) {
          const hitFcall = detectFcall(payload.id);
          if (hitFcall) issue = { kind: 'rp11-fcall', name: hitFcall };
        }
      }
      if (issue) {
        const recItem = { ...issue, location: locBase };
        if (stripUnsupported) {
          pruneTreeSubtree(graph, tm, nRef.value);
          dropped.push({ ...recItem, action: 'pruned-interaction-node' });
        } else {
          unsupported.push(recItem);
        }
      }
    }
  }

  // Fallback: check any standalone RP11-only InteractionEvent or RP11-only classes not inside TreeMap
  for (const obj of [...graph.objects.values()]) {
    if (obj.className === 'Axure:InteractionEvent') {
      const evCode = field(obj.body, 'event-type')?.value;
      const evName = RP11_EVENT_CODE_NAME.get(evCode);
      if (evName) {
        const item = { kind: 'rp11-event', name: evName, location: locBase };
        if (stripUnsupported) {
          dropped.push({ ...item, action: 'neutralized-standalone-event' });
          field(obj.body, 'event-type').value = 0;
        } else if (!unsupported.some(u => u.kind === item.kind && u.name === item.name && u.location === locBase)) {
          unsupported.push(item);
        }
      }
    } else if (!stripUnsupported && RP11_CLASS_SET.has(obj.className)) {
      if (!unsupported.some(u => u.kind === 'rp11-class' && u.name === obj.className && u.location === locBase)) {
        unsupported.push({ kind: 'rp11-class', name: obj.className, location: locBase });
      }
    }
  }

  // 2. Scan & optionally strip RP11-only DOA style properties from PropList items
  for (const obj of graph.objects.values()) {
    const propList = field(obj.body, 'PropList');
    if (!propList?.items) continue;
    const kept = [];
    for (const item of propList.items) {
      const doa = field(item, 'DOAName')?.value;
      const baseCode = typeof doa === 'number' ? (doa & DOA_BASE_MASK) : null;
      if (baseCode !== null && RP11_DOA_MAP.has(baseCode)) {
        const recItem = { kind: 'rp11-doa-style', code: baseCode, name: RP11_DOA_MAP.get(baseCode), location: locBase };
        if (stripUnsupported) dropped.push({ ...recItem, action: 'stripped-style-prop' });
        else unsupported.push(recItem);
      } else {
        kept.push(item);
      }
    }
    if (stripUnsupported) propList.items = kept;
  }

  // 3. Clean any RP11_ONLY_KEYS listed on each object class before running adaptNodesForVersion
  for (const obj of graph.objects.values()) {
    const shortClass = typeof obj.className === 'string' ? obj.className.replace(/^Axure:/, '') : '';
    const rawKeys = RP11_ONLY_KEYS[obj.className] ?? RP11_ONLY_KEYS[shortClass];
    const dropKeys = rawKeys ? new Set(rawKeys) : null;
    if (!dropKeys || !obj.body?.entries) continue;
    const next = [];
    for (const entry of obj.body.entries) {
      const k = entry[0]?.text;
      if (dropKeys.has(k)) {
        dropped.push({ kind: 'rp11-key', className: obj.className, key: k, location: locBase, action: 'stripped-rp11-key' });
      } else {
        next.push(entry);
      }
    }
    obj.body.entries = next;
  }

  // 4. Adapt all nodes via shared version-adapt module & inject RP9 required keys + root-panel-infos
  adaptNodesForVersion([...graph.objects.values()], {
    version: 9,
    str: text => strNode(strings, text),
  });

  for (const obj of graph.objects.values()) {
    const shortClass = typeof obj.className === 'string' ? obj.className.replace(/^Axure:/, '') : '';
    const reqKeys = RP9_REQUIRED_KEYS[shortClass];
    if (reqKeys && obj.body?.entries) {
      for (const key of reqKeys) {
        if (!obj.body.entries.some(([k]) => k?.text === key)) {
          obj.body.entries.push([strNode(strings, key), { tag: 0x19, value: false }]);
        }
      }
    }
    if (obj.className === 'Axure:PackageInfo' && obj.body?.entries && !field(obj.body, 'root-panel-infos')) {
      obj.body.entries.push([strNode(strings, 'root-panel-infos'), { tag: 2, items: [] }]);
    }
  }
}

export function downgradeRp(input, { stripUnsupported = false } = {}) {
  const sourcePath = (Buffer.isBuffer(input) || input instanceof Uint8Array) ? '(buffer)' : resolve(String(input));
  if (sourcePath !== '(buffer)') assertNotProtected(sourcePath);
  const buf = (Buffer.isBuffer(input) || input instanceof Uint8Array) ? Buffer.from(input) : readFileSync(sourcePath);

  const ver = detectFileVersion(buf);
  if (ver !== 11) {
    throw Object.assign(new Error(`仅支持将 RP11 原型降级为 RP9；当前文件版本为 RP${ver}`), {
      code: 'E_DOWNGRADE_NOT_RP11',
      version: ver,
    });
  }

  const recs = readRecords(buf);
  const blank9 = synthesizeBlankProject({ version: 9, pageName: 'Page 1' });
  const blank9Recs = readRecords(blank9);
  const blank9Breaking = blank9Recs.find(r => r.className === 'xml:BreakingChanges');
  const blank9Settings = blank9Recs.find(r => r.className === 'Axure:DocumentSettings');

  const unsupported = [];
  const dropped = [];
  const parsed = recs.map(rec => {
    if (!rec.strings) return { rec, graph: null, strings: null };
    const graph = parsePayload(rec);
    const strings = [...rec.strings];
    scanAndSanitizeRecord(rec, graph, strings, { stripUnsupported, dropped, unsupported });
    return { rec, graph, strings };
  });

  if (unsupported.length > 0) {
    throw Object.assign(
      new Error(`发现 ${unsupported.length} 项 RP11 独占特性无法无损降级到 RP9；可传 --strip-unsupported 显式裁剪并记录台账。`),
      { code: 'E_DOWNGRADE_UNSUPPORTED_RP11', unsupported },
    );
  }

  const replacements = [];
  for (const item of parsed) {
    const { rec, graph, strings } = item;
    if (rec.className === 'xml:BreakingChanges' && blank9Breaking) {
      replacements.push({ record: rec, raw: blank9Breaking.raw });
      continue;
    }
    if (rec.className === 'Axure:DocumentSettings' && blank9Settings) {
      replacements.push({ record: rec, raw: blank9Settings.raw });
      continue;
    }
    const rawCopy = Buffer.from(rec.raw);
    if (rawCopy.length >= 8) rawCopy.writeUInt32LE(9, 4);
    if (!graph) {
      replacements.push({ record: rec, raw: rawCopy });
      continue;
    }
    const fakeRec = { ...rec, raw: rawCopy };
    const encoded = encodeRecord(fakeRec, strings, encodePayload(graph.roots));
    if (encoded.length >= 8) encoded.writeUInt32LE(9, 4);
    replacements.push({ record: rec, raw: encoded });
  }

  let outBuf = replaceRecords(buf, replacements);
  const mfOut = readManifest(outBuf);
  for (const k of Object.keys(mfOut.value.root.parts ?? {})) {
    if (k.endsWith('.version') && !k.startsWith('9.')) {
      mfOut.value.root.parts['9.0.0.3754.version'] = mfOut.value.root.parts[k];
      delete mfOut.value.root.parts[k];
    }
  }
  const headerCopy = Buffer.from(outBuf);
  headerCopy.writeUInt16LE(9, 2);
  outBuf = Buffer.concat([encodeManifest(headerCopy, mfOut.value), headerCopy.subarray(mfOut.dataStart)]);
  outBuf = fixPanelRegistry(outBuf).file;

  const lint = lintVersionKeys(outBuf, { version: 9 });
  const check = readRp(outBuf);
  const editorReadiness = inspectEditorReadiness(outBuf, 9);

  return {
    file: outBuf,
    report: {
      ok: lint.errors.length === 0 && check.version === 9 && check.records.unparseable === 0 && check.counts.danglingRefs === 0 && check.counts.problems === 0 && !editorReadiness.upgradeModalRisk,
      evidence: 'structure',
      sourcePath,
      sourceVersion: 11,
      targetVersion: check.version,
      stripUnsupported,
      editorReadiness,
      droppedCount: dropped.length,
      dropped,
      lintErrors: lint.errors,
      lintWarnings: lint.warnings,
      counts: {
        pages: check.counts.pages,
        widgets: check.counts.widgets,
        panelStates: check.counts.panelStates,
        interactions: check.counts.interactions,
        globalVariables: check.counts.globalVariables,
        records: recs.length,
      },
      structure: {
        unparseable: check.records.unparseable,
        danglingRefs: check.counts.danglingRefs,
        problems: check.counts.problems,
      },
    },
  };
}

export function formatDowngradeReport(report) {
  const c = report.counts;
  const lines = [
    `# RP11 -> RP9 降级编译报告`,
    `输入：${report.sourcePath} (RP${report.sourceVersion}) -> 输出版本：RP${report.targetVersion}`,
    `内容保留：${c.pages} 页、${c.widgets} 元件、${c.panelStates} 面板状态、${c.interactions} 交互、${c.globalVariables} 全局变量`,
    `版本检查：lintErrors=${report.lintErrors.length} lintWarnings=${report.lintWarnings.length} upgradeModalRisk=${report.editorReadiness?.upgradeModalRisk}`,
    `结构三零：unparseable=${report.structure.unparseable} danglingRefs=${report.structure.danglingRefs} problems=${report.structure.problems}`,
    `显式裁剪项：${report.droppedCount} 项`,
  ];
  for (const d of report.dropped) lines.push(`  - [${d.kind}] ${d.name ?? d.key ?? d.code} @ ${d.location} (${d.action})`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const stripUnsupported = argv.includes('--strip-unsupported');
  const json = argv.includes('--json');
  const files = argv.filter(a => !a.startsWith('--'));
  if (files.length !== 2) {
    console.error('用法: node downgrade-rp.mjs <rp11.rp> <rp9.rp> [--strip-unsupported] [--json]');
    process.exit(1);
  }
  const src = resolve(files[0]);
  const dst = resolve(files[1]);
  assertNotProtected(src);
  assertWritable(dst);
  const { file, report } = downgradeRp(src, { stripUnsupported });
  writeFileSync(dst, file, { flag: 'wx' });
  console.log(json ? JSON.stringify({ ...report, output: dst }, null, 2) : formatDowngradeReport({ ...report, output: dst }));
}
