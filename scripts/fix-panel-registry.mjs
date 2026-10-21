// 补齐 RP 9 的面板注册链（DynamicPanelInfo / PanelDiagramInfo）。
//
// 为什么需要：RP 9 在 DesignDocument 记录里维护面板注册树
//   Axure:PackageInfo.root-panel-infos → Axure:DynamicPanelInfo → Axure:PanelDiagramInfo
// 每个状态包一条。RP 9 靠它解析面板的状态包；缺失时面板还在、外部元件正常，但**状态内容什么都不画**。
// RP 11 没有这个模型，所以同一份产物在 RP 11 上是正常的 —— 这正是「同工具、同内容、换宿主表现不同」的原因。
// 详见 rp9-compat-20261016/PANEL-REGISTRY-ROOTCAUSE.md。
//
// 这是写后修正：任何在 RP 9 上产出带状态面板的 writer 之后都可以跑一次。
//   node fix-panel-registry.mjs <source.rp> <output.rp>
// 非 RP 9 文件原样跳过（不改 RP 11 行为）。
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, readManifest, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { detectFileVersion } from './version.mjs';

const unguidKey = key => {
  const b = Buffer.from(key, 'hex');
  if (b.length !== 16) return key;
  return Buffer.concat([b.subarray(0, 4).reverse(), b.subarray(4, 6).reverse(), b.subarray(6, 8).reverse(), b.subarray(8)]).toString('hex');
};
const guidsOf = graph => graph?.roots?.find(n => n.tag === 0x1e)?.values ?? [];

export function fixPanelRegistry(file, { version } = {}) {
  const target = version ?? detectFileVersion(file);
  if (target !== 9) {
    return { file, report: { version: target, skipped: true, reason: '面板注册链只存在于 RP 9；非 RP 9 文件不改' } };
  }

  const records = readRecords(file);
  const graphs = new Map();
  for (const r of records) { try { graphs.set(r.index, parsePayload(r)); } catch { /* 缺图跳过 */ } }

  // 1) 状态包：GUID → { 记录, 状态名 }
  const stateByGuid = new Map();
  for (const r of records) {
    if (r.className !== 'Axure:PanelState') continue;
    const g = graphs.get(r.index);
    const guid = guidsOf(g)[1];
    if (!guid) continue;
    const pd = [...g.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
    stateByGuid.set(guid, { record: r, index: r.index, name: field(pd?.body ?? {}, 'Name')?.text ?? '' });
  }

  // 2) manifest 里的父子关系（子包 GUID → 父包 GUID）
  const parentOf = new Map();
  const walk = (node, parentGuid) => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      const guid = unguidKey(key);
      if (parentGuid) parentOf.set(guid, parentGuid);
      walk(child, guid);
    }
  };
  walk(readManifest(file).value.root, null);

  // 3) DesignDocument：GUID 表 + PackageInfo 表
  const docRec = records.find(r => r.className === 'Axure:DesignDocument');
  if (!docRec) throw new Error('没有 Axure:DesignDocument 记录');
  const docGraph = graphs.get(docRec.index);
  const strings = [...docRec.strings];
  const dg = guidsOf(docGraph);
  const nullId = dg.indexOf('0'.repeat(32)) + 1;

  const str = t => { let i = strings.indexOf(t); if (i < 0) { i = strings.length; strings.push(t); } return { tag: 8, value: i + 1, text: t }; };
  const dictOf = entries => ({ tag: 1, entries });
  const list = items => ({ tag: 2, items });
  const ref = v => ({ tag: 3, value: v });
  const u32 = v => ({ tag: 0x11, value: v });
  const typed2 = (t, g) => ({ tag: 0x13, values: [t, g] });
  const bool = v => ({ tag: 0x19, value: !!v });

  const pkgInfoByGuid = new Map();
  for (const pi of docGraph.objects.values()) {
    if (pi.className !== 'Axure:PackageInfo') continue;
    const idx = field(pi.body, 'package-id')?.values?.[1];
    const g = idx ? dg[idx - 1] : null;
    if (g) pkgInfoByGuid.set(g, pi);
  }

  const added = [];
  const already = [];
  const newObjectId = () => { dg.push(randomBytes(16).toString('hex')); return dg.length; };
  const guidIndexOf = g => { let i = dg.indexOf(g); if (i < 0) { dg.push(g); i = dg.length - 1; } return i + 1; };

  // 4) 逐个动态面板补注册
  for (const r of records) {
    const g = graphs.get(r.index);
    if (!g) continue;
    const panels = [...g.objects.values()].filter(o => o.className === 'Axure:DiagramObject:DynamicPanel');
    if (!panels.length) continue;
    const ownerGuid = guidsOf(g)[1];                 // 该记录自身的包 GUID
    const ownerParent = parentOf.get(ownerGuid) ?? ownerGuid;
    const pkgInfo = pkgInfoByGuid.get(ownerGuid) ?? pkgInfoByGuid.get(ownerParent);
    if (!pkgInfo) continue;                          // 找不到归属包就不动

    let rootList = field(pkgInfo.body, 'root-panel-infos');
    if (!rootList) {
      rootList = list([]);
      pkgInfo.body.entries.push([str('root-panel-infos'), rootList]);
    }

    const panelGuids = guidsOf(g);
    for (const panel of panels) {
      const items = field(panel.body, 'panel-diagrams')?.items ?? [];
      const stateGuids = items.map(it => panelGuids[(it.values?.[1] ?? 0) - 1]).filter(Boolean);
      const states = stateGuids.map(sg => stateByGuid.get(sg)).filter(Boolean);
      if (!states.length) continue;
      const panelName = field(field(panel.body, 'name-block') ?? {}, 'text')?.text ?? '';

      // 去重：同一个面板（按 object-id + 名字）已登记就跳过
      const existing = rootList.items
        .map(it => docGraph.objects.get(it.value))
        .find(o => o && field(o.body, 'name')?.text === panelName
          && (field(o.body, 'panel-diagram-infos')?.items?.length ?? 0) === states.length);
      if (existing) { already.push(panelName || '(无名面板)'); continue; }

      const stateInfoIds = states.map(st => {
        const id = newObjectId();
        docGraph.objects.set(id, {
          tag: 9, id, classIndex: str('Axure:PanelDiagramInfo').value, className: 'Axure:PanelDiagramInfo',
          body: dictOf([
            [str('name'), str(st.name)],
            [str('PackageId'), typed2(str('Axure:PanelState').value, guidIndexOf(stateGuids[states.indexOf(st)]))],
            [str('IsSubPackage'), bool(false)],
            [str('contained-panel-infos'), list([])],
            [str('LoadedRdoPackages'), list([])],
            [str('LoadedScreenshotPackages'), list([])],
          ]),
        });
        docGraph.roots.splice(docGraph.roots.length - 1, 0, docGraph.objects.get(id));
        return id;
      });

      const dpiId = newObjectId();
      docGraph.objects.set(dpiId, {
        tag: 9, id: dpiId, classIndex: str('Axure:DynamicPanelInfo').value, className: 'Axure:DynamicPanelInfo',
        body: dictOf([
          [str('name'), str(panelName)],
          [str('object-id'), u32(nullId)],
          [str('panel-diagram-infos'), list(stateInfoIds.map(id => ref(id)))],
          [str('subdiagram-parent-type'), str('Axure:DiagramObject:DynamicPanel')],
        ]),
      });
      docGraph.roots.splice(docGraph.roots.length - 1, 0, docGraph.objects.get(dpiId));
      rootList.items.push(ref(dpiId));
      added.push({ panel: panelName || '(无名面板)', record: r.index, states: states.map(s => s.name) });
    }
  }

  if (!added.length) {
    return { file, report: { version: target, addedPanels: 0, alreadyRegistered: already, note: '没有需要补的面板' } };
  }

  const raw = encodeRecord(docRec, strings, encodePayload(docGraph.roots));
  return {
    file: replaceRecord(file, docRec, raw),
    report: { version: target, addedPanels: added.length, added, alreadyRegistered: already, docRecord: docRec.index },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) { console.error('用法: node fix-panel-registry.mjs <source.rp> <output.rp>'); process.exit(2); }
  const srcVersion = detectFileVersion(readFileSync(src));
  const out = fixPanelRegistry(readFileSync(src), { version: srcVersion });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(dst, out.file, { flag: 'wx' });
  console.log(JSON.stringify(out.report, null, 2));
}
