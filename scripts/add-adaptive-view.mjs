// 自适应视图集：按 2026-09-22 UI 真值（round7 A/B 实验）重建编码模型。
//
// 用法: node add-adaptive-view.mjs <src.rp> <out.rp> [断点宽度...]
//         [--override "<视图名>:<元件名>:w=<宽>[,h=<高>][,x=<x>,y=<y>]" ...]
//       例: node add-adaptive-view.mjs src.rp out.rp 768 1024 \
//             --override "V768:TESTRECT:w=450" --override "V1024:TESTRECT:w=600,h=300"
//
// ⚠️ 绑定模型（已反编译 Axure 源码及对齐 UI 真值确认）：
//   1. BaseView.Id 固定为 Axure 常量 GUID 0921e81902f16f47933582835c373474
//   2. AdaptiveViewSet.Id 拥有独立 GUID（setGuidHex），在 DesignDocument 记录内注册
//   3. 子视图拥有独立 GUID（childGuidHex），BaseViewId 指向 BaseView
//   4. Page 绑定核心：
//      - Page.AdaptiveViewSetId（tag 17）指向 Page GUID 表中的 setGuidHex 槽位。
//        原有槽位可能是被其他引用共享的空 GUID；追加新槽，不能覆盖公共空哨兵。
//        （反编译 CbRj.AdaptiveViewSet: XHFn().pVko(cbRj.obuq)，若 obuq 为 Guid.Empty 则为 null，
//         导致 AbuW() 返回 false，UI 工具栏显示 "+ 添加自适应视图"）
//      - Page.AdaptiveViewMatchInfos[i].Id（tag 17）必须指向 childGuidHex
//        （反编译 ybEe: current.eVwe == wVw1.Id）
//      - Page.AdaptiveStyles 和 Widget.AdaptiveStyles 字典 key（tag 17）必须指向 childGuidHex
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { detectFileVersion } from './version.mjs';

const args = process.argv.slice(2);
const overrides = [];
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--override') overrides.push(args[++i]);
  else positional.push(args[i]);
}
const [src, dst, ...breaks] = positional;
const srcVersion = (() => { try { return detectFileVersion(readFileSync(src)); } catch { return 11; } })();
// RP 11 原生 AdaptiveView 有 Cursor 键；RP 9 原生没有，写进去就是版本专属键。
const adaptiveViewExtra = srcVersion === 9 ? [] : [['Cursor', int(1)]];
const WIDTHS = (breaks.length ? breaks : ['768', '1024']).map(Number);
// 解析 --override: "V768:TESTRECT:w=450,h=200" → {view:'V768', widget:'TESTRECT', props:{w:450,h:200}}
const overrideSpec = s => {
  const [view, widget, rest] = s.split(':');
  const props = {};
  for (const kv of (rest ?? '').split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'w') props.width = Number(v);
    if (k === 'h') props.height = Number(v);
    if (k === 'x') props.x = Number(v);
    if (k === 'y') props.y = Number(v);
  }
  return { view, widget, props };
};
const overrideList = overrides.map(overrideSpec);

const data = readFileSync(src);
const records = readRecords(data);
const doc = records.find(r => r.className === 'Axure:DesignDocument');
const g = parsePayload(doc);
const strings = [...doc.strings];
const str = t => { let i = strings.indexOf(t); if (i < 0) { i = strings.length; strings.push(t); } return { tag: 8, value: i + 1, text: t }; };
const int = v => ({ tag: 5, value: v });
const id11 = v => ({ tag: 0x11, value: v });
const f64 = v => ({ tag: 6, value: v });
const ref = v => ({ tag: 3, value: v });
const dictOf = e => ({ tag: 1, entries: e });
const list = items => ({ tag: 2, items });
const obj = (id, cls, props) => ({ tag: 9, id, classIndex: str(cls).value, className: cls, body: dictOf(props.map(([name, v]) => [str(name), v])) });

const docObj = [...g.objects.values()].find(o => o.className === 'Axure:DesignDocument');
const guids = g.roots.find(n => n.tag === 0x1e).values;

// ---- 1) DesignDocument：一个集合（基本 + 子视图）----
const BASE_VIEW_GUID = '0921e81902f16f47933582835c373474';
let baseViewGuidIdx = guids.indexOf(BASE_VIEW_GUID) + 1;
if (baseViewGuidIdx === 0) {
  guids.push(BASE_VIEW_GUID);
  baseViewGuidIdx = guids.length;
}
const baseViewId = baseViewGuidIdx;

const setGuidHex = randomBytes(16).toString('hex');
guids.push(setGuidHex);
const setId = guids.length;

const specs = WIDTHS.map(w => {
  const guid = randomBytes(16).toString('hex');
  guids.push(guid);
  return { name: `V${w}`, width: w, guid, id: guids.length };
});

const setObjId = guids.length + 1;
guids.push(randomBytes(16).toString('hex'));

const baseViewObjId = guids.length + 1;
guids.push(randomBytes(16).toString('hex'));

const childObjIds = specs.map(() => {
  const id = guids.length + 1;
  guids.push(randomBytes(16).toString('hex'));
  return id;
});

const baseView = obj(baseViewObjId, 'Axure:AdaptiveView', [
  ['Id', id11(baseViewId)],
  ['Size', dictOf([[str('Width'), f64(0)], [str('Height'), f64(0)]])],
  ['Name', str('')], ['BaseViewId', id11(baseViewId)], ['BaseViewName', str('')],
  ...adaptiveViewExtra, ['ParentAdaptiveViewSet', ref(setObjId)]
]);
const childViews = specs.map((sp, i) => obj(childObjIds[i], 'Axure:AdaptiveView', [
  ['Id', id11(sp.id)],
  ['Size', dictOf([[str('Width'), f64(sp.width)], [str('Height'), f64(0)]])],
  ['Name', str(sp.name)], ['BaseViewId', id11(baseViewId)], ['BaseViewName', str('')],
  ...adaptiveViewExtra, ['ParentAdaptiveViewSet', ref(setObjId)]
]));
const set = obj(setObjId, 'Axure:AdaptiveViewSet', [
  ['Id', id11(setId)], ['Name', str('')],
  ['DefaultAdaptiveView', ref(baseViewObjId)],
  ['AdaptiveViews', list(childViews.map(v => ref(v.id)))]
]);
const setsField = field(docObj.body, 'AdaptiveViewSets');
for (const s of [set, baseView, ...childViews]) g.objects.set(s.id, s);
setsField.items.push(ref(set.id));
// 插入位置：PackageInfos 之后、SiteTreeMap 之前（沿用既有约定）
const sitemapAt = g.roots.findIndex(n => n.tag === 9 && n.className === 'Axure:SiteTreeMap');
g.roots.splice(sitemapAt >= 0 ? sitemapAt : g.roots.length - 1, 0, set, baseView, ...childViews);

let out = replaceRecord(data, doc, encodeRecord(doc, strings, encodePayload(g.roots)));

// ---- 2) 每个 Page 记录：绑定 AdaptiveViewSetId + MatchInfos + AdaptiveStyles ----
const pagePatch = records => {
  let out = records;
  const pageCount = readRecords(out).filter(r => r.className === 'Axure:Page').length;
  // 从后往前（replaceRecord 移动后续偏移）
  for (let pageIdx = pageCount - 1; pageIdx >= 0; pageIdx--) {
    const curPages = readRecords(out).filter(r => r.className === 'Axure:Page');
    const r = curPages[pageIdx];
    const pg = parsePayload(r);
    const pstr = [...r.strings];
    const pstrIntern = t => { let i = pstr.indexOf(t); if (i < 0) { i = pstr.length; pstr.push(t); } return { tag: 8, value: i + 1, text: t }; };
    const po = [...pg.objects.values()].find(o => o.className === 'Axure:Page');
    if (!po) continue;
    const miField = field(po.body, 'AdaptiveViewMatchInfos');
    if (!miField) continue;   // 没有该字段的旧文件跳过（不应发生）

    const pgGuids = pg.roots.find(n => n.tag === 0x1e).values;

    // 1) 关键修复：绑定 AdaptiveViewSetId
    // 保留所有旧 GUID 槽；空哨兵也被交互、数据集等对象引用，不能就地替换。
    const avSetIdField = field(po.body, 'AdaptiveViewSetId');
    let setGuidIndex = pgGuids.indexOf(setGuidHex) + 1;
    if (!setGuidIndex) {
      pgGuids.push(setGuidHex);
      setGuidIndex = pgGuids.length;
    }
    if (avSetIdField) {
      avSetIdField.value = setGuidIndex;
    } else {
      po.body.entries.unshift([pstrIntern('AdaptiveViewSetId'), id11(setGuidIndex)]);
    }

    // 2) 关键修复：将各个子视图的 GUID 写入 Page 的 GUID 表
    const pageKeys = specs.map(sp => {
      let idx = pgGuids.indexOf(sp.guid) + 1;
      if (idx === 0) {
        pgGuids.push(sp.guid);
        idx = pgGuids.length;
      }
      return id11(idx);
    });

    const newObjId = () => { pgGuids.push(randomBytes(16).toString('hex')); return pgGuids.length; };
    const newGuidId11 = () => { pgGuids.push(randomBytes(16).toString('hex')); return id11(pgGuids.length); };

    // 每个视图写入 MatchInfo + 页面级占位
    const pageStyle = pg.objects.get(field(po.body, 'page-style')?.value);
    for (const [i, sp] of specs.entries()) {
      miField.items.push(dictOf([
        [pstrIntern('Id'), pageKeys[i]],
        [pstrIntern('Name'), pstrIntern(sp.name)],
        [pstrIntern('Size'), dictOf([[pstrIntern('Width'), f64(sp.width)], [pstrIntern('Height'), f64(0)]])]
      ]));
      // 页面级占位 style
      const stId = newObjId();
      const stObjId = newGuidId11();
      const styleObj = {
        tag: 9, id: stId, classIndex: pstrIntern('Axure:PageStyle').value, className: 'Axure:PageStyle',
        body: dictOf([
          [pstrIntern('style-name'), pstrIntern('AdaptivePageStyle')],
          [pstrIntern('Id'), stObjId],
          [pstrIntern('PropList'), list([])],
          [pstrIntern('Capabilities'), pageStyle ? field(pageStyle.body, 'Capabilities') : { tag: 0x1d, value: 'bf7fdeffffeddff5' }],
          [pstrIntern('All'), { tag: 0x19, value: false }]
        ])
      };
      pg.objects.set(stId, styleObj);
      pg.roots.splice(pg.roots.length - 1, 0, styleObj);
      field(po.body, 'AdaptiveStyles').items.push(pageKeys[i], ref(stId));
    }

    // 每个顶层 widget 的 AdaptiveStyle 占位
    const dia = pg.objects.get(field(po.body, 'diagram').value);
    const widgets = (field(dia?.body ?? {}, 'diagram-objects')?.items ?? [])
      .map(it => pg.objects.get(it.value)).filter(Boolean);
    const widgetPlaceholders = new Map();   // widgetObjId → {viewName → styleObj}
    for (const w of widgets) {
      const asField = field(w.body, 'AdaptiveStyles');
      if (!asField) continue;
      // 清掉模板/旧文档带来的小写 "adaptive style" 占位对
      const stripped = [];
      for (let i = 0; i + 1 < asField.items.length; i += 2) {
        const st = pg.objects.get(asField.items[i + 1].value);
        const nm = st && field(st.body, 'style-name');
        if (nm?.tag === 8 && nm.text === 'adaptive style') stripped.push(asField.items[i], asField.items[i + 1]);
      }
      if (stripped.length) {
        asField.items = asField.items.filter(it => !stripped.includes(it));
        const strippedIds = new Set(stripped.filter(it => it.tag === 3).map(it => it.value));
        pg.roots = pg.roots.filter(n => !(n.tag === 9 && strippedIds.has(n.id)));
        for (const id of strippedIds) pg.objects.delete(id);
      }
      const myStyle = pg.objects.get(field(w.body, 'MyStyle')?.value);
      const capabilities = myStyle ? field(myStyle.body, 'Capabilities') : undefined;
      const perView = {};
      for (const [i, sp] of specs.entries()) {
        const key = pageKeys[i];
        const stId = newObjId();
        const stObjId = newGuidId11();
        const libId = newGuidId11();
        const styleObj = {
          tag: 9, id: stId, classIndex: pstrIntern('Axure:Style').value, className: 'Axure:Style',
          body: dictOf([
            [pstrIntern('LibraryId'), libId],
            [pstrIntern('LibraryName'), pstrIntern('')],
            [pstrIntern('style-name'), pstrIntern('AdaptiveStyle')],
            [pstrIntern('Id'), stObjId],
            [pstrIntern('PropList'), list([])],
            [pstrIntern('Capabilities'), capabilities ?? { tag: 0x1d, value: 'bf7fdeffffeddff5' }],
            [pstrIntern('All'), { tag: 0x19, value: false }]
          ])
        };
        pg.objects.set(stId, styleObj);
        pg.roots.splice(pg.roots.length - 1, 0, styleObj);
        asField.items.push(key, ref(stId));
        perView[sp.name] = styleObj;
      }
      widgetPlaceholders.set(w.id, perView);
    }

    // --override：写 DOA 进占位
    const wname = o => { const t = field(field(o.body, 'name-block') ?? {}, 'text'); return t?.tag === 8 ? t.text : ''; };
    for (const ov of overrideList) {
      const targetWidget = [...widgets].find(w => wname(w) === ov.widget);
      // override 是逐页尝试的：元件本来就不在这一页时静默跳过，
      // 只有「这一页有这个元件、却没拿到该视图的占位样式」才值得报警。
      if (!targetWidget) continue;
      const perView = widgetPlaceholders.get(targetWidget.id);
      const styleObj = perView?.[ov.view];
      if (!styleObj) { console.error(`⚠️ override 目标未找到: ${ov.view}/${ov.widget}（页#${r.index}）`); continue; }
      const pl = field(styleObj.body, 'PropList');
      const setDoa = (doa, entries) => {
        const existing = pl.items.find(it => it.tag === 1 && field(it, 'DOAName')?.value === doa);
        if (existing) pl.items = pl.items.filter(it => it !== existing);
        pl.items.push(dictOf([[pstrIntern('DOAName'), int(doa)], [pstrIntern('Value'), dictOf(entries)]]));
      };
      if (ov.props.width !== undefined || ov.props.height !== undefined) {
        const w0 = ov.props.width, h0 = ov.props.height;
        // 与基础值合并：只写指定的维度
        const base = pg.objects.get(field([...widgets].find(w => wname(w) === ov.widget)?.body ?? {}, 'MyStyle')?.value);
        let bw = 0, bh = 0;
        for (const it of field(base?.body ?? {}, 'PropList')?.items ?? []) {
          if (field(it, 'DOAName')?.value === 3221225577) { bw = field(field(it, 'Value'), 'Width')?.value ?? 0; bh = field(field(it, 'Value'), 'Height')?.value ?? 0; }
        }
        setDoa(3221225577, [[pstrIntern('Width'), f64(w0 ?? bw)], [pstrIntern('Height'), f64(h0 ?? bh)]]);
      }
      if (ov.props.x !== undefined || ov.props.y !== undefined) {
        const base = pg.objects.get(field([...widgets].find(w => wname(w) === ov.widget)?.body ?? {}, 'MyStyle')?.value);
        let bx = 0, by = 0;
        for (const it of field(base?.body ?? {}, 'PropList')?.items ?? []) {
          if (field(it, 'DOAName')?.value === 3221225573) { bx = field(field(it, 'Value'), 'X')?.value ?? 0; by = field(field(it, 'Value'), 'Y')?.value ?? 0; }
        }
        setDoa(3221225573, [[pstrIntern('X'), f64(ov.props.x ?? bx)], [pstrIntern('Y'), f64(ov.props.y ?? by)]]);
      }
    }
    out = replaceRecord(out, r, encodeRecord(r, pstr, encodePayload(pg.roots)));
  }
  return out;
};
out = pagePatch(out);
writeFileSync(dst, out, { flag: 'wx' });
console.log(JSON.stringify({
  dst,
  viewSet: { setId, setGuid: setGuidHex, baseViewId, children: specs.map((s) => ({ name: s.name, viewId: s.id, guid: s.guid, baseViewId, width: s.width })) },
  overrides: overrideList.map(o => `${o.view}/${o.widget}`),
  note: '自适应视图集注册与页面绑定完成：SetId与ChildId的GUID在DesignDocument和Page间严格对齐'
}, null, 1));
