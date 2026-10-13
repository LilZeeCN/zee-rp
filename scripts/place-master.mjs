// 离线把「母版实例」放到页面上 —— 补上 HANDOFF 缺口 3。
//
// 编码逆向自本项目自己的产物（create-master 已把实例放上页面）：
//   元件类 = Axure:DiagramObject:ReferenceDiagramObject
//   关键字段 = ReferredMaster: pair(类名字符串索引, GUID表索引)
//     · pair[0] 指向字符串表里的 "Axure:Master"
//     · pair[1] 是目标页面 GUID 表里的索引，该位 GUID == 母版记录 GUID[1]（即 manifest key）
//   其余字段与普通元件同族；ObjectOverrides 为空表示不做覆盖。
//
// 用法：
//   node place-master.mjs <src.rp> <out.rp> <masterName> <pageIndex> [--x N --y N]
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { guidKey } from './duplicate-page.mjs';

export function placeMaster(file, { masterName, pageIndex, x = 100, y = 100 }) {
  const records = readRecords(file);
  const doc = records.find(r => r.className === 'Axure:DesignDocument');
  const d = parsePayload(doc);
  const dg = d.roots.find(n => n.tag === 0x1e).values;

  // 找母版：MasterPackageInfo 按名定位，再用 package-id 索引取包 GUID
  const infos = [...d.objects.values()].filter(n => n.className === 'Axure:MasterPackageInfo');
  const info = infos.find(n => field(n.body, 'package-name')?.text === masterName);
  if (!info) {
    throw new Error(`找不到母版 "${masterName}"。现有：${infos.map(n => field(n.body, 'package-name')?.text).join(', ') || '(无)'}`);
  }
  const masterGuid = dg[field(info.body, 'package-id').values[1] - 1];
  if (!masterGuid) throw new Error('母版包 GUID 索引越界');
  const masterRec = records.find(r => r.className === 'Axure:Master'
    && (parsePayload(r).roots.find(n => n.tag === 0x1e)?.values ?? []).includes(masterGuid));
  if (!masterRec) throw new Error('按包 GUID 找不到 Axure:Master 记录');

  const pageRec = records.find(r => r.index === Number(pageIndex) && r.className === 'Axure:Page');
  if (!pageRec) throw new Error(`没有 Page 记录 index=${pageIndex}`);

  const graph = parsePayload(pageRec);
  const strings = [...pageRec.strings];
  const str = t => { let i = strings.indexOf(t); if (i < 0) { i = strings.length; strings.push(t); } return { tag: 8, value: i + 1, text: t }; };
  const ref = v => ({ tag: 3, value: v });
  const int = v => ({ tag: 5, value: v });
  const guid = v => ({ tag: 0x11, value: v });
  const bool = v => ({ tag: 0x19, value: !!v });
  const list = items => ({ tag: 2, items });
  const dictOf = e => ({ tag: 1, entries: e });
  const f64 = v => ({ tag: 6, value: v });

  const guids = graph.roots.find(n => n.tag === 0x1e).values;
  const nullId = guids.indexOf('0'.repeat(32)) + 1;
  if (!nullId) throw new Error('GUID 表里没有全零哨兵');

  // 把母版包 GUID 登记进本页 GUID 表，ReferredMaster 指向它
  if (!guids.includes(masterGuid)) guids.push(masterGuid);
  const masterGuidIdx = guids.indexOf(masterGuid) + 1;

  const pageObj = [...graph.objects.values()].find(o => o.className === 'Axure:Page');
  const diagram = graph.objects.get(field(pageObj.body, 'diagram').value);
  // Object IDs index the record's GUID table, including IDs of Style objects.
  const newId = () => { guids.push(randomBytes(16).toString('hex')); return guids.length; };
  const wId = newId(), sId = newId();

  const widget = {
    tag: 9, id: wId, classIndex: str('Axure:DiagramObject:ReferenceDiagramObject').value,
    className: 'Axure:DiagramObject:ReferenceDiagramObject',
    body: dictOf([
      [str('name-block'), dictOf([
        [str('*type'), str('text-block')], [str('text'), str(masterName)],
        [str('property-dictionary'), dictOf([
          [str('type'), str('label')], [str('diagram-object-id'), int(wId)],
          [str('parent-diagram-id'), int(diagram.id)]])]])],
      [str('tooltip'), str('')], [str('IsContained'), bool(false)], [str('IsLocked'), bool(false)],
      [str('SelectedStyleGroup'), str('')], [str('MyStyle'), ref(sId)], [str('AdaptiveStyles'), list([])],
      [str('SubmitButton'), ref(nullId)], [str('Disabled'), bool(false)], [str('Selected'), bool(false)],
      [str('Error'), bool(false)], [str('VisibleFromSettings'), bool(true)],
      // 核心：pair(字符串表里的 "Axure:Master", 本页 GUID 表里的母版包 GUID 索引)
      [str('ReferredMaster'), { tag: 0x10, values: [str('Axure:Master').value, masterGuidIdx] }],
      [str('IsBackground'), bool(false)],
      [str('IsolateRadioGroups'), bool(true)], [str('IsolateSelectionGroups'), bool(true)],
      [str('ObjectOverrides'), list([])], [str('Propagate'), bool(false)]
    ])
  };
  const style = {
    tag: 9, id: sId, classIndex: str('Axure:Style').value, className: 'Axure:Style',
    body: dictOf([
      [str('LibraryId'), guid(nullId)], [str('LibraryName'), str('')], [str('LegacyName'), str('')],
      [str('style-name'), str('MyStyle')], [str('Id'), guid(newId())],
      [str('PropList'), list([
        dictOf([[str('DOAName'), int(3221225573)], [str('Value'), dictOf([[str('X'), f64(x)], [str('Y'), f64(y)]])]])
      ])],
      [str('Capabilities'), { tag: 0x1d, value: '0000000400200008' }], [str('All'), bool(false)]
    ])
  };

  for (const o of [style, widget]) graph.objects.set(o.id, o);
  graph.roots.splice(graph.roots.length - 1, 0, style, widget);
  field(diagram.body, 'diagram-objects').items.push(ref(wId));

  const out = replaceRecord(file, pageRec, encodeRecord(pageRec, strings, encodePayload(graph.roots)));
  return {
    file: out,
    report: {
      master: masterName, masterGuid: guidKey(masterGuid), page: `#${pageIndex}`,
      widgetId: wId, referredMasterPair: `(str:"Axure:Master", guidIdx:${masterGuidIdx})`, x, y
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) flags[a[i].slice(2)] = Number(a[++i]);
    else pos.push(a[i]);
  }
  const [src, dst, masterName, pageIndex] = pos;
  if (!src || !dst || !masterName || pageIndex === undefined) {
    console.error('Usage: node place-master.mjs <src.rp> <out.rp> <masterName> <pageIndex> [--x N --y N]');
    process.exit(1);
  }
  const out = placeMaster(readFileSync(src), {
    masterName, pageIndex, x: flags.x ?? 100, y: flags.y ?? 100
  });
  writeFileSync(dst, out.file, { flag: 'wx' });
  console.log(JSON.stringify(out.report, null, 2));
}
