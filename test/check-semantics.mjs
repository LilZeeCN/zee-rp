#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, readManifest } from '../scripts/rp-records.mjs';
import { parsePayload, walkNodes, field } from '../scripts/parse-payload.mjs';
import { guidKey } from '../scripts/duplicate-page.mjs';

/**
 * 校验单个记录的结构与语义
 */
export function validateRecord(record, graph, { docRecord = null, docGraph = null, registeredMasters = new Set() } = {}) {
  const violations = [];
  const addViolation = (category, message, context = {}) => {
    violations.push({ category, message, ...context });
  };

  const strings = record.strings ?? [];
  const guidRoot = graph.roots.find(n => n.tag === 0x1e);
  const guids = guidRoot?.values ?? [];

  // 1. 递归扫描所有 AST 节点
  walkNodes(graph.roots, node => {
    if (!node || typeof node !== 'object') return;

    // ---- 规则 1: tag 8 字符串表引用合法性 ----
    if (node.tag === 8) {
      if (typeof node.value === 'string') {
        addViolation('tag8-integrity', `Record #${record.index}: tag 8 node contains string literal instead of integer index: "${node.value}"`, {
          record: record.index, value: node.value, text: node.text
        });
      } else if (!Number.isInteger(node.value) || node.value < 1 || node.value > strings.length) {
        addViolation('tag8-integrity', `Record #${record.index}: tag 8 string index out of range: ${node.value} (strings length: ${strings.length})`, {
          record: record.index, value: node.value
        });
      } else if (node.text !== undefined && node.text !== strings[node.value - 1]) {
        addViolation('tag8-integrity', `Record #${record.index}: tag 8 text mismatch: "${node.text}" vs strings[${node.value - 1}]="${strings[node.value - 1]}"`, {
          record: record.index, value: node.value, nodeText: node.text, stringTableText: strings[node.value - 1]
        });
      }
    }

    // ---- 规则 2: tag 0x16 GUID 槽位合法性 ----
    if (node.tag === 0x16) {
      if (typeof node.value === 'string') {
        addViolation('tag16-integrity', `Record #${record.index}: tag 0x16 node contains string GUID instead of integer index: "${node.value}"`, {
          record: record.index, value: node.value
        });
      } else if (!Number.isInteger(node.value) || node.value < 1 || node.value > guids.length) {
        addViolation('tag16-integrity', `Record #${record.index}: tag 0x16 guid index out of range: ${node.value} (guids length: ${guids.length})`, {
          record: record.index, value: node.value
        });
      }
    }

    // ---- 规则 3: typed pair (tag 0x10 / 0x13) 索引与类型名合法性 ----
    if (node.tag === 0x10 || node.tag === 0x13) {
      if (!Array.isArray(node.values) || node.values.length !== 2) {
        addViolation('typed-pair-integrity', `Record #${record.index}: tag ${node.tag} values must be a 2-tuple, got ${JSON.stringify(node.values)}`, {
          record: record.index, node
        });
      } else {
        const [typeIdx, targetIdx] = node.values;
        if (typeIdx !== 0) {
          if (!Number.isInteger(typeIdx) || typeIdx < 1 || typeIdx > strings.length) {
            addViolation('typed-pair-integrity', `Record #${record.index}: tag ${node.tag} type index out of range: ${typeIdx}`, {
              record: record.index, typeIdx
            });
          }
        }
        if (targetIdx !== 0 && (!Number.isInteger(targetIdx) || targetIdx < 1 || targetIdx > guids.length)) {
          addViolation('typed-pair-integrity', `Record #${record.index}: tag ${node.tag} target index invalid: ${targetIdx}`, {
            record: record.index, targetIdx
          });
        }
      }
    }
  });

  // 2. 规则 4: 活动交互树闭环
  for (const obj of graph.objects.values()) {
    if (obj.className === 'Axure:InteractionTreeMap') {
      const nodeTable = field(obj.body, 'node-table');
      if (!nodeTable || nodeTable.tag !== 1) {
        addViolation('interaction-tree-integrity', `Record #${record.index}: InteractionTreeMap node-table is not a dict`, {
          record: record.index, objId: obj.id
        });
        continue;
      }
      for (const [keyNode, valNode] of nodeTable.entries ?? []) {
        if (!keyNode || keyNode.tag !== 3 || !valNode || valNode.tag !== 3) {
          addViolation('interaction-tree-integrity', `Record #${record.index}: node-table entry must contain ref keys and values`, {
            record: record.index, keyNode, valNode
          });
          continue;
        }
        const treeNode = graph.objects.get(keyNode.value);
        const targetObj = graph.objects.get(valNode.value);
        if (!treeNode) {
          addViolation('interaction-tree-integrity', `Record #${record.index}: node-table key references non-existent tree node #${keyNode.value}`, {
            record: record.index, keyId: keyNode.value
          });
        }
        if (!targetObj) {
          addViolation('interaction-tree-integrity', `Record #${record.index}: node-table value references non-existent object #${valNode.value}`, {
            record: record.index, valId: valNode.value
          });
        }
      }
    }

    // 3. 规则 5: ReferenceDiagramObject 所指向的 Master 闭环
    if (obj.className === 'Axure:DiagramObject:ReferenceDiagramObject') {
      const refMaster = field(obj.body, 'ReferredMaster');
      if (!refMaster || refMaster.tag !== 0x10 || !Array.isArray(refMaster.values)) {
        addViolation('master-closure', `Record #${record.index}: ReferenceDiagramObject #${obj.id} missing valid ReferredMaster tag 0x10`, {
          record: record.index, objId: obj.id
        });
      } else {
        const [typeIdx, guidIdx] = refMaster.values;
        const typeName = strings[typeIdx - 1];
        if (typeName !== 'Axure:Master') {
          addViolation('master-closure', `Record #${record.index}: ReferredMaster type is not Axure:Master: "${typeName}"`, {
            record: record.index, objId: obj.id, typeName
          });
        }
        const masterGuid = guids[guidIdx - 1];
        if (!masterGuid || !registeredMasters.has(masterGuid)) {
          addViolation('master-closure', `Record #${record.index}: ReferenceDiagramObject #${obj.id} references unregistered Master GUID ${masterGuid}`, {
            record: record.index, objId: obj.id, masterGuid
          });
        }
      }
    }

    // 4. 规则 6: Connector 端点与所属 diagram 闭环
    if (obj.className === 'Axure:DiagramObject:Connector') {
      for (const side of ['start', 'end']) {
        const targetObjId = field(obj.body, side + '-diagram-object')?.value;
        const connectorPointGuidIdx = field(obj.body, side + '-connector-id')?.value;
        const pointGuid = guids[connectorPointGuidIdx - 1];
        if (targetObjId && pointGuid && pointGuid !== '0'.repeat(32)) {
          if (!graph.objects.has(targetObjId)) {
            addViolation('connector-integrity', `Record #${record.index}: Connector #${obj.id} ${side} endpoint references non-existent object #${targetObjId}`, {
              record: record.index, connectorId: obj.id, targetObjId
            });
          }
        }
      }
    }

  }

  return violations;
}

/**
 * 结构与语义闭环深度诊断器
 */
export function validateSemantics(fileBytesOrPath, { allowThrow = false } = {}) {
  const bytes = typeof fileBytesOrPath === 'string' ? readFileSync(fileBytesOrPath) : fileBytesOrPath;
  const violations = [];
  const addViolation = (category, message, context = {}) => {
    violations.push({ category, message, ...context });
  };

  let records, manifest;
  try {
    records = readRecords(bytes);
    manifest = readManifest(bytes);
  } catch (err) {
    addViolation('container-integrity', `Failed to read records or manifest: ${err.message}`);
    return { valid: false, violations };
  }

  // 1. 收集全局包清单与 DesignDocument
  const docRecord = records.find(r => r.className === 'Axure:DesignDocument');
  let docGraph = null, docGuids = [], registeredMasters = new Set(), registeredPages = new Set();
  if (!docRecord) {
    addViolation('manifest-closure', 'Axure:DesignDocument record missing');
  } else {
    try {
      docGraph = parsePayload(docRecord);
      docGuids = docGraph.roots.find(n => n.tag === 0x1e)?.values ?? [];
      const docRoot = docGraph.objects.get(docGraph.roots.find(n => n.tag === 0xf)?.value);
      for (const item of field(docRoot?.body ?? {}, 'PackageInfos')?.items ?? []) {
        const info = docGraph.objects.get(item.value);
        const pid = field(info?.body ?? {}, 'package-id');
        if (pid && Array.isArray(pid.values) && pid.values.length === 2) {
          const kind = docRecord.strings[pid.values[0] - 1];
          const guid = docGuids[pid.values[1] - 1];
          if (kind === 'Axure:Master' && guid) registeredMasters.add(guid);
          if (kind === 'Axure:Page' && guid) registeredPages.add(guid);
        }
      }
    } catch (err) {
      addViolation('container-integrity', `Failed to parse Axure:DesignDocument: ${err.message}`);
    }
  }

  // 1.5 校验 manifest 与 package records 的物理闭环
  if (manifest?.value?.root) {
    const root = manifest.value.root;
    const manifestOffsets = new Set();
    const collectOffsets = node => {
      if (!node) return;
      if (node.parts) {
        for (const [partName, offset] of Object.entries(node.parts)) {
          manifestOffsets.add(manifest.dataStart + offset + 8);
        }
      }
      if (node.children) {
        for (const child of Object.values(node.children)) {
          collectOffsets(child);
        }
      }
    };
    collectOffsets(root);

    // 检查所有 Page/Master/PanelState/DesignDocument 记录是否在 manifest 中登记
    for (const record of records) {
      if (['Axure:Page', 'Axure:Master', 'Axure:PanelState', 'Axure:DesignDocument'].includes(record.className)) {
        if (!manifestOffsets.has(record.offset)) {
          addViolation('manifest-closure', `Record #${record.index} (${record.className}) at offset ${record.offset} has no corresponding entry in manifest`);
        }
      }
    }
  }

  // 2. 逐记录扫描 payload 节点
  for (const record of records) {
    if (!record.strings) continue;
    let graph;
    try {
      graph = parsePayload(record);
    } catch (err) {
      addViolation('parse-payload', `Record #${record.index} (${record.className}) payload parse failed: ${err.message}`, { record: record.index });
      continue;
    }

    const recordViolations = validateRecord(record, graph, { docRecord, docGraph, registeredMasters });
    violations.push(...recordViolations);
  }

  violations.push(...validatePackagePaths(records, manifest));

  const valid = violations.length === 0;
  if (!valid && allowThrow) {
    const summary = violations.map(v => `[${v.category}] ${v.message}`).join('\n');
    throw new Error(`Semantic validations failed with ${violations.length} violations:\n${summary}`);
  }

  return { valid, violations, violationCount: violations.length };
}

function validatePackagePaths(records, manifest) {
  const violations = [], packages = [], byOffset = new Map(), byGuid = new Map();
  const add = (category, message, context = {}) => violations.push({ category, message, ...context });
  const table = graph => graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
  const packageGuid = graph => table(graph)[graph.roots.find(n => n.tag === 0x12)?.value - 1];
  const nullGuid = '0'.repeat(32), pageSentinel = '78563412cdabefcdefababcdeffedcba';
  for (const record of records.filter(r => ['Axure:Page', 'Axure:Master', 'Axure:PanelState'].includes(r.className))) {
    let graph;
    try { graph = parsePayload(record); } catch { continue; }
    const pkg = { record, graph, guid: packageGuid(graph), owner: null, active: new Set() };
    packages.push(pkg); byOffset.set(record.offset, pkg); byGuid.set(pkg.guid, pkg);
    const pending = [graph.roots.find(n => n.tag === 0xf)?.value];
    while (pending.length) {
      const id = pending.pop();
      if (pkg.active.has(id)) continue;
      pkg.active.add(id);
      const object = graph.objects.get(id);
      if (object) walkNodes([object.body], node => { if (node.tag === 3) pending.push(node.value); });
    }
  }
  const visit = (node, owner, key = null) => {
    const pkg = byOffset.get(manifest.dataStart + (node.parts?.package ?? -9) + 8);
    if (pkg && (typeof pkg.guid !== 'string' || !/^[0-9a-f]{32}$/i.test(pkg.guid) || key !== guidKey(pkg.guid)))
      add('manifest-closure', `Record #${pkg.record.index}: manifest key ${key} does not match package GUID ${pkg.guid}`, { record: pkg.record.index });
    if (pkg && ['Axure:Page', 'Axure:Master'].includes(pkg.record.className)) owner = pkg;
    if (pkg) pkg.owner = owner;
    for (const [key, child] of Object.entries(node.children ?? {})) visit(child, owner, key);
  };
  if (manifest?.value?.root) visit(manifest.value.root, null);
  const scopes = new Map();
  for (const pkg of packages) {
    if (pkg.record.className === 'Axure:PanelState' && !pkg.owner)
      add('panel-state-owner', `PanelState record #${pkg.record.index} is not owned by a Page or Master`, { record: pkg.record.index });
    if (!pkg.owner) continue;
    let scope = scopes.get(pkg.owner.guid);
    if (!scope) scopes.set(pkg.owner.guid, scope = new Map());
    for (const object of pkg.graph.objects.values()) {
      if (pkg.active.has(object.id) && object.className.startsWith('Axure:DiagramObject:'))
        scope.set(table(pkg.graph)[object.id - 1], { pkg, object });
    }
  }

  const rowScope = ({ pkg, object }) => {
    const scope = new Map(), seen = new Set();
    const visitObject = id => {
      if (seen.has(id)) return;
      seen.add(id);
      const object = pkg.graph.objects.get(id);
      if (!object) return;
      if (object.className.startsWith('Axure:DiagramObject:')) scope.set(table(pkg.graph)[id - 1], { pkg, object });
      for (const ref of field(object.body, 'diagram-objects')?.items ?? []) visitObject(ref.value);
      const base = field(object.body, 'BaseDiagram');
      if (base?.tag === 3) visitObject(base.value);
    };
    visitObject(field(object.body, 'BaseDiagram')?.value);
    return scope;
  };
  for (const pkg of packages) {
    const guids = table(pkg.graph), defaultScope = scopes.get(pkg.owner?.guid) ?? new Map();
    const overrideScopes = new Map();
    for (const object of pkg.graph.objects.values()) {
      if (!pkg.active.has(object.id)) continue;
      if (object.className === 'Axure:DiagramObject:DynamicPanel') {
        for (const pair of field(object.body, 'panel-diagrams')?.items ?? []) {
          const guid = guids[pair.values?.[1] - 1], state = byGuid.get(guid);
          if (state?.record.className !== 'Axure:PanelState' || state.owner !== pkg.owner)
            add('panel-state-owner', `Record #${pkg.record.index}: DynamicPanel #${object.id} state ${guid} is missing or belongs to a different Page/Master`, { record: pkg.record.index, objId: object.id, stateGuid: guid });
        }
      }
      if (object.className === 'Axure:DiagramObject:ReferenceDiagramObject') {
        const master = guids[field(object.body, 'ReferredMaster')?.values?.[1] - 1];
        const refs = field(object.body, 'ObjectOverrides')?.items ?? [];
        for (let i = 0; i < refs.length; i += 2) {
          if (refs[i]?.tag === 3) overrideScopes.set(refs[i].value, scopes.get(master) ?? new Map());
        }
      }
    }
    for (const object of pkg.graph.objects.values()) {
      if (object.className !== 'Axure:DiagramObjectPath' || !pkg.active.has(object.id)) continue;
      const fail = message => add('interaction-path-integrity', `Record #${pkg.record.index}: DiagramObjectPath #${object.id} ${message}`, { record: pkg.record.index, pathId: object.id });
      const targetNode = field(object.body, 'object-id'), target = guids[targetNode?.value - 1];
      const dummy = field(object.body, 'is-dummy'), rdo = field(object.body, 'rdo-path'), repeater = field(object.body, 'repeater-path');
      if (targetNode?.tag !== 0x16 || dummy?.tag !== 0x19 || rdo?.tag !== 2 || repeater?.tag !== 2) {
        fail('must have native object-id, is-dummy, rdo-path and repeater-path fields'); continue;
      }
      if (dummy.value) continue;
      const hasContext = rdo.items.length || repeater.items.length || overrideScopes.has(object.id);
      if ((target === nullGuid || target === pageSentinel) && !hasContext) continue;
      let scope = overrideScopes.get(object.id) ?? defaultScope, invalid = false;
      for (const ref of rdo.items) {
        const item = scope.get(guids[ref.value - 1]);
        if (![0x11, 0x16].includes(ref.tag) || item?.object.className !== 'Axure:DiagramObject:ReferenceDiagramObject') {
          fail('has an unresolved or non-Master instance in rdo-path'); invalid = true; break;
        }
        const master = table(item.pkg.graph)[field(item.object.body, 'ReferredMaster')?.values?.[1] - 1];
        scope = scopes.get(master) ?? new Map();
      }
      if (invalid) continue;
      for (const ref of repeater.items) {
        const item = scope.get(guids[ref.value - 1]);
        if (![0x11, 0x16].includes(ref.tag) || item?.object.className !== 'Axure:DiagramObject:Repeater') {
          fail('has an unresolved or non-Repeater item in repeater-path'); invalid = true; break;
        }
        scope = rowScope(item);
      }
      if (!invalid && !scope.has(target)) fail(`target ${target} does not resolve in its Page/Master/repeater scope`);
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node check-semantics.mjs <file.rp>');
    process.exit(2);
  }
  const res = validateSemantics(file);
  console.log(JSON.stringify(res, null, 2));
  if (!res.valid) process.exit(1);
}
