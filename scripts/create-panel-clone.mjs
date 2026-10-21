// 已知边界：与 Axure 形态逐项对齐的三处（对照 UI 新建 ground truth panel-ui-resaved.rp）：
//   ① 状态记录清洗：清空 PanelDiagram.diagram-objects 后，移除不再被任何 tag-3 字段引用的
//      DiagramObject/Style 根对象（模板残留孤儿）和 StyleCache.Styles 里的模板遗留条目，
//      并重排 GUID 表——否则残留 ImageBox+Style+"Image" 样式缓存，GUI 双击编辑报类型转换；
//   ② PanelState 包挂在目标 Page 的 children 里（挂 manifest 根会让编辑器丢弃状态内容），
//      且序列化时 children 在 parts 前；
//   ③ PanelState 记录写在拥有它的 Page 记录之前（Axure 重存/UI 新建皆如此），不能追加到流尾。
// 离线创建动态面板 —— 走「克隆真实模板」路线（本项目唯一通过 Axure 验收的路线）。
//
// 为什么是克隆而不是从零构造：
//   从零构造的元件（历史源码已归档）与克隆件**字段集、字段顺序、逐字段 tag、
//   序列化字节数全部相同**，Axure 仍判 invalid document；而克隆件被接受。
//   也就是说 Axure 校验的不只是这些字段，还有某个尚未定位的东西。
//   在定位出来之前，这个工具用「克隆 + 改」的稳妥路线。
//
// 用法：
//   node create-panel-clone.mjs <src.rp> <out.rp> <pageName> <panelName> <state...> [--x N --y N --w N --h N]
//
// 模板：默认取 Axure 自带 Quick Win.rp 里的 "Hours Panel"（含 2 个状态），
//       可用环境变量 AXURE_PANEL_TEMPLATE 指定别的 .rp。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readRecords, readManifest, encodeManifest, encodeRecord, replaceRecord, insertRecord }
  from './rp-records.mjs';
import { parsePayload, encodePayload, field }
  from './parse-payload.mjs';

import { cloneInto, closureOf } from './clone-closure.mjs';
import { resolvePageRecord } from './ix-actions.mjs';
import { guidKey } from './duplicate-page.mjs';
import { detectFileVersion, installRoot, versionLabel } from './version.mjs';
import { fixPanelRegistry } from './fix-panel-registry.mjs';
import { join } from 'node:path';

// 面板模板取自「与目标文件同版本」的 Axure 安装资源；跨版本模板会带来版本专属字段。
export function panelTemplate(file) {
  if (process.env.AXURE_PANEL_TEMPLATE) return process.env.AXURE_PANEL_TEMPLATE;
  const version = detectFileVersion(file);
  const name = version === 9 ? 'RP9 Tour.rp' : 'Quick Win.rp';
  return join(installRoot(version), 'Training', name);
}

// 两版教学工程里的多状态面板不同名：RP 9 = RP9 Tour.rp/Discount Panel，RP 11 = Quick Win.rp/Hours Panel。
function panelTemplateName(file) {
  if (process.env.AXURE_PANEL_TEMPLATE_NAME) return process.env.AXURE_PANEL_TEMPLATE_NAME;
  return detectFileVersion(file) === 9 ? 'Discount Panel' : 'Hours Panel';
}
// TEMPLATE_PANEL_NAME 现在按目标文件版本解析，见 panelTemplateName()。

export function createPanel(file, { pageName, pageIndex, name, states = ['State 1'], x = 100, y = 100, width = 300, height = 200, copyTemplateStates = false }) {
  const TEMPLATE = panelTemplate(file);
  const TEMPLATE_PANEL_NAME = panelTemplateName(file);
  const records = readRecords(file);
  const pageRec = pageIndex === undefined ? resolvePageRecord(file, pageName)
    : records.find(r => r.index === Number(pageIndex) && r.className === 'Axure:Page');
  if (!pageRec) throw new Error(`Page record not found: ${pageName ?? pageIndex}`);
  const sourceManifest = readManifest(file);
  const pageOffset = pageRec.offset - 8 - sourceManifest.dataStart;
  const findKey = node => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      if (child.parts?.package === pageOffset) return key;
      const nested = findKey(child);
      if (nested) return nested;
    }
  };
  const pageKey = findKey(sourceManifest.value.root);
  const graph = parsePayload(pageRec), strings = [...pageRec.strings];
  const guids = graph.roots.find(n => n.tag === 0x1e).values;
  const intern = text => { let i = strings.indexOf(text); if (i < 0) { i = strings.length; strings.push(text); } return { tag: 8, value: i + 1, text }; };
  const page = [...graph.objects.values()].find(o => o.className === 'Axure:Page');
  const diagram = graph.objects.get(field(page.body, 'diagram').value);
  const source = readRecords(readFileSync(TEMPLATE));
  let templateRecord, templateGraph, templateWidget;
  for (const r of source.filter(r => r.className === 'Axure:Page')) {
    const g = parsePayload(r);
    const w = [...g.objects.values()].find(o => o.className === 'Axure:DiagramObject:DynamicPanel'
      && field(field(o.body, 'name-block'), 'text')?.text === TEMPLATE_PANEL_NAME);
    if (w) { templateRecord = r; templateGraph = g; templateWidget = w; break; }
  }
  if (!templateWidget) throw new Error(`Missing template panel: ${TEMPLATE_PANEL_NAME}`);
  let templateStateRecords = [];
  if (copyTemplateStates) {
    const templateGuids = templateGraph.roots.find(n => n.tag === 0x1e).values;
    const refs = field(templateWidget.body, 'panel-diagrams').items.map(item => item.values?.[1]);
    templateStateRecords = refs.map(index => {
      const stateGuid = templateGuids[index - 1];
      return source.find(record => record.className === 'Axure:PanelState'
        && parsePayload(record).roots.find(n => n.tag === 0x1e)?.values?.[1] === stateGuid);
    });
    if (!templateStateRecords.length || templateStateRecords.some(record => !record)) {
      throw new Error(`Could not resolve all states for template panel: ${TEMPLATE_PANEL_NAME}`);
    }
    if (states.length !== templateStateRecords.length) {
      throw new Error(`Template panel has ${templateStateRecords.length} states; received ${states.length} state names`);
    }
  }
  const closure = closureOf(templateGraph, templateWidget.id);
  const cloned = cloneInto({ version: detectFileVersion(file),
    srcGraph: templateGraph, srcStrings: templateRecord.strings,
    dstGraph: graph, dstStrings: strings, closure, rootOldId: templateWidget.id });
  const widget = graph.objects.get(cloned.rootNewId);
  const style = graph.objects.get(field(widget.body, 'MyStyle').value);
  field(widget.body, 'name-block').entries.find(([k]) => k.text === 'text')[1] = intern(name);
  const pd = field(field(widget.body, 'name-block'), 'property-dictionary');
  field(pd, 'diagram-object-id').value = widget.id;
  field(pd, 'parent-diagram-id').value = diagram.id;
  const pl = field(style.body, 'PropList');
  // 【RP 9 渲染缺口根因，2026-10-16】模板面板可能是**隐藏**的：RP 9 的模板 Discount Panel 是
  // 10×10 残桩，样式里带 VISIBLE(0xC000006E)=false；RP 11 教学工程里同样带这一项的面板
  // Axure 自己就叫 "Hidden Hours"。这个 false 被克隆进新面板后，RP 9 **不渲染它的状态内容**
  // （面板在、注册链在、结构签名与能渲染样本逐键一致，就是不画）——三零与 version-lint 都查不出。
  // 原生**可见**面板（RP 9 Tour 的大面板、RP 11 的 Hours Panel）都根本没有这一项，
  // 所以这里直接删掉该条目，而不是写 true。
  const VISIBLE_PROP = 0xC000006E;
  pl.items = pl.items.filter(n =>
    !(field(n, 'DOAName')?.value === VISIBLE_PROP && field(n, 'Value')?.value === false));
  const setProp = (code, values) => {
    let item = pl.items.find(n => field(n, 'DOAName')?.value === code);
    const value = { tag: 1, entries: Object.entries(values).map(([k, v]) => [intern(k), { tag: 6, value: v }]) };
    if (item) item.entries.find(([k]) => k.text === 'Value')[1] = value;
    else pl.items.push({ tag: 1, entries: [[intern('DOAName'), { tag: 5, value: code }], [intern('Value'), value]] });
  };
  setProp(3221225573, { X: x, Y: y });
  setProp(3221225577, { Width: width, Height: height });
  field(widget.body, 'fit-to-content').value = false;
  // A real PanelState record is required for every requested state. An empty GUID is not a state.
  const stateTemplate = source.find(r => r.className === 'Axure:PanelState');
  const packages = [], pairs = [];
  const stateNames = states.length ? states : ['State 1'];
  for (let stateIndex = 0; stateIndex < stateNames.length; stateIndex++) {
    const stateName = stateNames[stateIndex];
    const recordTemplate = copyTemplateStates ? templateStateRecords[stateIndex] : stateTemplate;
    const sg = parsePayload(recordTemplate), ss = [...recordTemplate.strings];
    const sd = [...sg.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
    if (!copyTemplateStates) field(sd.body, 'diagram-objects').items = [];
    // 状态记录清洗：diagram-objects 清空后，模板状态里会残留不再被任何 tag-3 字段引用的
    // DiagramObject/Style 根对象（Quick Win 的 Hours Panel 即 ImageBox + 其 Style），
    // StyleCache.Styles 里也留着一条模板遗留条目（Name="Image"）。UI 新建的 ground truth
    // 是 7 对象且只有 Default 一条样式缓存——这两处残留是相对 ground truth 的 payload 级
    // 差异，也是最可疑的 GUI 编辑器转换失败点，加载/保存路径虽能容忍，仍一并清掉。
    // 迭代到不动点：删掉 ImageBox 后，它的 MyStyle（Style）也随之变成孤儿。
    if (!copyTemplateStates) {
      let removed = 0;
      do {
        removed = 0;
        const referenced = new Set();
        const collect = n => {
          if (n.tag === 3) referenced.add(n.value);
          if (n.entries) for (const [k, v] of n.entries) { collect(k); collect(v); }
          if (n.items) for (const it of n.items) collect(it);
          if (n.tag === 9) collect(n.body);
        };
        for (const root of sg.roots) if (root.tag !== 9) collect(root);
        for (const o of sg.objects.values()) collect(o.body);
        for (const o of [...sg.objects.values()]) {
          const orphan = (o.className.startsWith('Axure:DiagramObject') || o.className === 'Axure:Style')
            && !referenced.has(o.id);
          if (!orphan) continue;
          sg.objects.delete(o.id);
          const at = sg.roots.findIndex(n => n.tag === 9 && n.id === o.id);
          if (at >= 0) sg.roots.splice(at, 1);
          removed++;
        }
      } while (removed > 0);
      const stateObj = [...sg.objects.values()].find(o => o.className === 'Axure:PanelState');
      const styles = field(field(stateObj.body, 'StyleCache') ?? {}, 'Styles');
      if (styles) styles.items = styles.items
        .filter(it => field(field(it, 'Info') ?? {}, 'Name')?.text !== 'Image');
    }
    // 重排 GUID 表：槽位换新 GUID，不残留模板 GUID。但**空哨兵槽必须保持全零**。
    // 对象 id 与 tag-3 引用保持不变——Axure 自己的状态记录同样有洞（PanelState 的
    // AdaptiveViewSet 指向不存在的 id=3），致密重编号会让引用撞上真实对象。
    //
    // 原生对照（Default.rplib + RP9 Tour，2026-10-16 实测）：
    //   无对象 + 被 tag-3 引用（空哨兵）: 全零 46 / 非零 0   ← 必须全零
    //   无对象 + 无引用（死槽）        : 全零  4 / 非零 961 ← 保留新 GUID 是对的
    // 早前无条件给**所有**槽写随机 GUID，把空哨兵槽也写脏了 → 产物出现孤儿 GUID
    // （Axure 自己的文件一个都没有）。看着能加载，但那是我们独有的偏差，不该留。
    const gl = sg.roots.find(n => n.tag === 0x1e).values;
    const sentinelIds = new Set();          // 被 tag-3 引用、但本 record 无此对象的 id
    {
      const referenced = new Set();
      const collect = n => {
        if (!n) return;
        if (n.tag === 3) referenced.add(n.value);
        if (n.tag === 1) for (const [, v] of n.entries) collect(v);
        if (n.tag === 2) for (const it of n.items) collect(it);
        if (n.tag === 9) collect(n.body);
      };
      for (const root of sg.roots) collect(root);
      for (const id of referenced) if (!sg.objects.has(id)) sentinelIds.add(id);
    }
    for (let i = 0; i < gl.length; i++) {
      gl[i] = sentinelIds.has(i + 1) ? '0'.repeat(32) : randomBytes(16).toString('hex');
    }
    let nameIndex = ss.indexOf(stateName); if (nameIndex < 0) { nameIndex = ss.length; ss.push(stateName); }
    Object.assign(field(sd.body, 'Name'), { tag: 8, value: nameIndex + 1, text: stateName });
    const stateGuid = gl[sd.id - 1];
    guids.push(stateGuid);
    pairs.push({ tag: 0x13, values: [intern('Axure:PanelState').value, guids.length] });
    packages.push({ key: guidKey(stateGuid), raw: encodeRecord(recordTemplate, ss, encodePayload(sg.roots)) });
  }
  field(widget.body, 'panel-diagrams').items = pairs;
  graph.roots.splice(graph.roots.length - 1, 0, ...cloned.created);
  field(diagram.body, 'diagram-objects').items.push({ tag: 3, value: widget.id });
  const pageRaw = encodeRecord(pageRec, strings, encodePayload(graph.roots));
  let out = replaceRecord(file, pageRec, pageRaw);
  // PanelState 记录必须写在拥有它的 Page 记录之前（Axure 重存与 UI 新建都把状态记录放在
  // Page 之前、DesignDocument/DocumentSettings 之前）：用 insertRecord 插入而非 appendPackage
  // 追加到流尾。每次插入后 Page 记录整体下移，按编码字节重新定位它。
  for (const pkg of packages) {
    const pageNow = readRecords(out).find(r => r.className === 'Axure:Page' && r.raw.equals(pageRaw));
    if (!pageNow) throw new Error('Page record lost after insert');
    out = insertRecord(out, pkg.key, pkg.raw, pageNow);
  }
  const manifest = readManifest(out);
  const findPage = node => node.children?.[pageKey]
    ?? Object.values(node.children ?? {}).map(findPage).find(Boolean);
  const pageNode = findPage(manifest.value.root);
  if (!pageNode) throw new Error(`Missing manifest page: ${pageKey}`);
  pageNode.children ??= {};
  for (const pkg of packages) {
    pageNode.children[pkg.key] = manifest.value.root.children[pkg.key];
    delete manifest.value.root.children[pkg.key];
  }
  // Axure 序列化 page 节点时 children 在 parts 之前（panel-ui-resaved.rp 的 manifest 原文）。
  // JS 对象按键插入序序列化，这里显式把 children 挪到 parts 前。
  const ordered = {};
  if (pageNode.children) ordered.children = pageNode.children;
  for (const [k, v] of Object.entries(pageNode)) if (k !== 'children') ordered[k] = v;
  for (const k of Object.keys(pageNode)) delete pageNode[k];
  Object.assign(pageNode, ordered);
  out = Buffer.concat([encodeManifest(out, manifest.value), out.subarray(manifest.dataStart)]);
  const panelRegistry = fixPanelRegistry(out);
  return { file: panelRegistry.file, report: { page: pageName ?? pageIndex, panel: name, widgetId: widget.id, states: stateNames, copiedTemplateStateContent: copyTemplateStates, x, y, width, height, panelRegistry: panelRegistry.report } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--copy-template-states') flags.copyTemplateStates = true;
    else if (a[i].startsWith('--')) flags[a[i].slice(2)] = Number(a[++i]);
    else pos.push(a[i]);
  }
  const [src, dst, pageName, panelName, ...states] = pos;
  if (!src || !dst || !panelName) {
    console.error('Usage: node create-panel-clone.mjs <src.rp> <out.rp> <pageName> <panelName> [state...] [--x N --y N --w N --h N] [--page-index N]');
    process.exit(1);
  }
  const out = createPanel(readFileSync(src), {
    pageName, pageIndex: flags['page-index'], name: panelName, states,
    x: flags.x ?? 100, y: flags.y ?? 100, width: flags.w ?? 300, height: flags.h ?? 200,
    copyTemplateStates: flags.copyTemplateStates ?? false
  });
  writeFileSync(dst, out.file, { flag: 'wx' });
  console.log(JSON.stringify(out.report, null, 2));
}
