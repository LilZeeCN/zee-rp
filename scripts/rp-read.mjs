// 友好读取器：吃一个 .rp，吐一份 AI 可消费的结构化摘要
// （manifest 包列表 / 站点地图 / 页面 widget + 几何 + 文本 / 动态面板状态 / 交互 / 全局变量 / 问题清单）。
//
// 复用的都是已 roundtrip 验证过的解析层：rp-records.mjs（记录 + LZ4 manifest）、
// parse-payload.mjs（payload 图）、duplicate-page.mjs 的 guidKey（.NET GUID 字节序）、
// ix-actions.mjs 的 EVENTS 表（事件名）。
//
// Usage: node rp-read.mjs <file.rp> [--json] [--full]
//   --json  输出 JSON（默认输出人读文本摘要）
//   --full  额外输出每个 widget 的原始字段 dump
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readManifest, readRecords } from './rp-records.mjs';
import { parsePayload, field, walkNodes } from './parse-payload.mjs';
import { guidKey } from './duplicate-page.mjs';
import { EVENTS } from './ix-actions.mjs';
import { detectFileVersion, versionLabel } from './version.mjs';

// wx.MSDataObject 的 DOAName 常量（实测值）。
const DOA = { POSITION: 3221225573, SIZE: 3221225577 };

// EVENTS 表反查：数值 → 事件名。
const EVENT_NAMES = new Map(Object.entries(EVENTS).map(([name, type]) => [type, name]));
const eventName = type => EVENT_NAMES.get(type) ?? `Event(${type})`;

// guidKey 的逆运算：manifest 的键是 .NET 字节序，翻回标准 GUID 十六进制。
function unguidKey(key) {
  const b = Buffer.from(key, 'hex');
  if (b.length !== 16) return key;
  return Buffer.concat([b.subarray(0, 4).reverse(), b.subarray(4, 6).reverse(), b.subarray(6, 8).reverse(), b.subarray(8)]).toString('hex');
}

const guidsOf = graph => graph?.roots?.find(n => n.tag === 0x1e)?.values ?? [];
const strOf = node => (node && node.tag === 8 ? node.text : undefined);
const intOf = node => (node === undefined || node === null ? undefined : node.value);
const pairValues = node => (node && Array.isArray(node.values) ? node.values : null);
const isWidget = o => o.className.startsWith('Axure:DiagramObject:') || o.className.startsWith('Axure:Repeater');
const shortType = className => className.replace(/^Axure:(DiagramObject:)?/, '') || className;

// MyStyle → Axure:Style → PropList 里的几何。
function geometryOf(graph, widget) {
  const style = graph.objects.get(field(widget.body, 'MyStyle')?.value);
  const out = { x: null, y: null, w: null, h: null };
  for (const item of field(style?.body ?? {}, 'PropList')?.items ?? []) {
    const name = intOf(field(item, 'DOAName'));
    const value = field(item, 'Value');
    if (!value || value.tag !== 1) continue;
    const get = key => intOf(field(value, key));
    if (name === DOA.POSITION) { out.x = get('X'); out.y = get('Y'); }
    if (name === DOA.SIZE) { out.w = get('Width'); out.h = get('Height'); }
  }
  return out;
}

// RichTextBlock → attributed-string → Paragraphs → Text。
// 段落里可能直接是 Text，也可能包在 Runs 里，递归收集最省事。
function textOf(node) {
  if (!node) return undefined;
  const direct = node.entries?.find(([key, value]) => key.text === 'text' && value.tag === 8)?.[1];
  if (direct) return direct.text;
  const parts = [];
  walkNodes([node], n => {
    if (n.tag !== 1 || !n.entries) return;
    for (const [key, value] of n.entries) {
      if (key.text === 'Text' && value.tag === 8 && value.text) parts.push(value.text);
    }
  });
  return parts.join('') || undefined;
}

const widgetName = widget => strOf(field(field(widget.body, 'name-block') ?? {}, 'text')) ?? '';

// ---- 交互树读取 ----
// InteractionTreeMap = { node-table: dict(nodeId → 对象), tree: Tree }；
// Tree.children = 事件 Node；事件 Node.children = 用例 Node；用例 Node.children = 动作 Node。
function readInteractions(graph, mapNode, version) {
  const results = [];
  if (!mapNode) return results;
  const nodeTable = field(mapNode.body, 'node-table');
  const target = id => {
    const entry = nodeTable?.entries?.find(([key]) => key.value === id);
    return entry ? graph.objects.get(entry[1].value) : undefined;
  };
  const tree = graph.objects.get(field(mapNode.body, 'tree')?.value);
  const childrenOf = obj => (field(obj?.body ?? {}, 'children')?.items ?? [])
    .map(item => graph.objects.get(item.value)).filter(Boolean);
  for (const eventNode of childrenOf(tree)) {
    const event = target(eventNode.id);
    if (!event || event.className !== 'Axure:InteractionEvent') continue;
    const cases = [];
    for (const caseNode of childrenOf(eventNode)) {
      const kase = target(caseNode.id);
      if (!kase) continue;
      const actions = childrenOf(caseNode)
        .map(actionNode => target(actionNode.id))
        .filter(Boolean)
        .map(action => describeAction(graph, action, version));
      cases.push({
        description: strOf(field(kase.body, 'Description')) ?? '',
        disabled: field(kase.body, 'Disabled')?.value === true,
        actions
      });
    }
    results.push({
      event: eventName(intOf(field(event.body, 'event-type'))),
      eventType: intOf(field(event.body, 'event-type')),
      disabled: field(event.body, 'Disabled')?.value === true,
      cases
    });
  }
  return results;
}

// 动作 → 人读文本。未知类型退化成「类名 → 目标」。
function describeAction(graph, action, version = 11) {
  const disabled = field(action.body, 'Disabled')?.value === true;
  const literal = node => {
    if (!node) return undefined;
    if (node.tag === 8) return node.text;
    return strOf(field(graph.objects.get(node.value)?.body ?? {}, 'value'));
  };
  // WidgetPaths / Paths / PanelPaths 里的 DiagramObjectPath.object-id → widget 名。
  const targets = keys => {
    const names = [], seen = new Set();
    for (const key of keys) {
      for (const item of field(action.body, key)?.items ?? []) {
        const path = graph.objects.get(item.value);
        if (!path) continue;
        const id = field(path.body, 'object-id')?.value;
        // WidgetPaths 和 panelobjectpaths 常常指向同一条路径，去重。
        if (seen.has(id)) continue;
        seen.add(id);
        const widget = graph.objects.get(id);
        names.push(widget ? (widgetName(widget) || `${shortType(widget.className)}#${widget.id}`) : `#${id}`);
      }
    }
    return names;
  };
  const info = key => {
    const first = field(action.body, key)?.items?.[0];
    return first ? graph.objects.get(first.value) : undefined;
  };
  const bodyOf = key => info(key)?.body ?? {};

  const class_ = action.className.replace(/^Axure:/, '');
  let type = class_, human = class_;
  switch (class_) {
    case 'InteractionLinkWindowAction': {
      const target = graph.objects.get(field(action.body, 'target')?.value);
      const targetType = intOf(field(target?.body ?? {}, 'target-type'));
      const value = literal(field(target?.body ?? {}, 'target-literal'));
      const window_ = intOf(field(action.body, 'link-type')) === 2 ? '新窗口' : '当前窗口';
      type = 'link';
      human = targetType === 1
        ? `打开页面「${value}」（${window_}）`
        : targetType === 2 ? '刷新当前页面'
          : targetType === 3 ? '返回上一页'
            : `打开链接 ${value}（${window_}）`;
      break;
    }
    case 'InteractionFadeWidgetAction': {
      const fade = bodyOf('FadeInfos');
      const kind = intOf(field(fade, 'fade-action-type'));
      const duration = intOf(field(fade, 'duration'));
      const showType = intOf(field(fade, 'show-type'));
      type = kind === 1 ? 'show' : kind === 0 ? 'hide' : 'toggle';
      const verb = kind === 1 ? '显示' : kind === 0 ? '隐藏' : '切换显示';
      const where = showType === 1 ? '，置于顶层' : showType === 2 ? '，灯箱' : showType === 3 ? '，浮出' : '';
      human = `${verb} ${targets(['WidgetPaths', 'panelobjectpaths']).join('、') || '(未指定)'}（${duration}ms${where}）`;
      break;
    }
    case 'InteractionMoveWidgetAction': {
      const move = bodyOf('MoveInfos');
      const mode = intOf(field(move, 'MoveType'));
      const duration = intOf(field(move, 'Duration'));
      type = mode === 0 ? 'set-position' : 'move';
      human = `${mode === 0 ? '移动到' : '相对移动'} ${targets(['WidgetPaths']).join('、') || '(未指定)'}`
        + ` x=${literal(field(move, 'XValue'))} y=${literal(field(move, 'YValue'))}（${duration}ms）`;
      break;
    }
    case 'InteractionSetPanelStateAction': {
      const state = bodyOf('SetStateInfos');
      const mode = intOf(field(state, 'set-state-type'));
      const modes = { 0: '指定状态', 1: '下一状态', 2: '上一状态', 3: '状态值', 4: '当前状态' };
      type = 'set-panel-state';
      human = `设置面板 ${targets(['PanelPaths']).join('、') || '(未指定)'} ${modes[mode] ?? mode}`
        + (mode === 3 ? ` → ${literal(field(state, 'state-value'))}` : '')
        + (field(state, 'loop')?.value === true ? '，循环' : '');
      break;
    }
    case 'InteractionSetPanelOrderAction': {
      const order = bodyOf('SetOrderInfos');
      type = 'set-panel-order';
      human = `${field(order, 'bring-to-front')?.value === true ? '置于顶层' : '置于底层'} ${targets(['PanelPaths']).join('、')}`;
      break;
    }
    case 'InteractionSetWidgetSizeAction': {
      const size = bodyOf('SetSizeInfos');
      type = 'set-size';
      human = `设置尺寸 ${targets(['WidgetPaths']).join('、')} w=${literal(field(size, 'width'))} h=${literal(field(size, 'height'))}`;
      break;
    }
    case 'InteractionEnableDisableWidgetsAction': {
      // RP 9 的 enable 是 bool（true=启用 / false=禁用）；RP 11 是同键的 int 枚举 0/1/2。
      // 不区分版本的话，bool true 会被读成「切换启用」。
      const node = field(bodyOf('EnableDisableInfos'), 'enable');
      const names = targets(['WidgetPaths']).join('、');
      if (node?.tag === 0x19) {
        type = node.value ? 'enable' : 'disable';
        human = `${node.value ? '启用' : '禁用'} ${names}`;
      } else {
        const value = intOf(node);
        type = value === 0 ? 'enable' : value === 1 ? 'disable' : 'toggle-enabled';
        human = `${value === 0 ? '启用' : value === 1 ? '禁用' : '切换启用'} ${names}`;
      }
      break;
    }
    case 'InteractionWaitAction': {
      type = 'wait';
      human = `等待 ${intOf(field(action.body, 'wait_time'))}ms`;
      break;
    }
    case 'InteractionRotateWidgetAction': {
      const rotate = bodyOf('Infos');
      type = 'rotate';
      human = `旋转 ${targets(['Paths']).join('、')} ${literal(field(rotate, 'Degree'))}°`;
      break;
    }
    case 'InteractionSetFocusOnWidgetAction': {
      type = 'focus';
      human = `聚焦 ${targets(['WidgetPaths', 'panelobjectpaths']).join('、')}`;
      break;
    }
    case 'InterationActionSetFunction': {
      const fn = strOf(field(action.body, 'SetFunction')) ?? '';
      if (fn === 'SetGlobalVariableValue') {
        const block = graph.objects.get(field(action.body, 'action')?.value);
        const call = graph.objects.get(field(block?.body ?? {}, 'subexpressions')?.items?.[0]?.value);
        const args = field(call?.body ?? {}, 'args')?.items ?? [];
        const variable = graph.objects.get(args[0]?.value);
        const variableName = strOf(field(variable?.body ?? {}, 'variable-name')) ?? '(未知变量)';
        type = 'set-variable';
        human = `设置全局变量 ${variableName} = ${JSON.stringify(literal(args[1]) ?? '')}`;
      } else if (fn === 'SetWidgetRichText') {
        const block = graph.objects.get(field(action.body, 'action')?.value);
        const call = graph.objects.get(field(block?.body ?? {}, 'subexpressions')?.items?.[0]?.value);
        const args = field(call?.body ?? {}, 'args')?.items ?? [];
        const pathLiteral = graph.objects.get(args[0]?.value);
        const path = graph.objects.get(field(pathLiteral?.body ?? {}, 'value')?.value);
        const targetId = field(path?.body ?? {}, 'object-id')?.value;
        const target = graph.objects.get(targetId);
        const value = graph.objects.get(args[1]?.value);
        const text = strOf(field(value?.body ?? {}, 'value')) ?? '';
        const targetName = target ? widgetName(target) || `${shortType(target.className)}#${target.id}` : '(未指定)';
        const identifier = (field(value?.body ?? {}, 'variable-identifiers')?.items ?? [])
          .map(item => graph.objects.get(item.value))
          .find(candidate => candidate?.className === 'Axure:Expr:TextVariableIdentifier');
        const variableName = strOf(field(identifier?.body ?? {}, 'Name'));
        if (variableName && text.includes(`[[${variableName}]]`)) {
          type = 'set-rich-text-from-variable';
          human = `设置富文本 ${targetName} = 全局变量 ${variableName}`;
        } else {
          type = 'set-rich-text';
          human = `设置富文本 ${targetName} = ${JSON.stringify(text)}`;
        }
      } else {
        type = /SetText/i.test(fn) ? 'set-text' : /Check/i.test(fn) ? 'set-check' : /Select/i.test(fn) ? 'set-selected' : 'set-function';
        human = `${type} ${targets(['WidgetPaths', 'panelobjectpaths']).join('、')}（${fn}）`;
      }
      break;
    }
    default: {
      const names = targets(['WidgetPaths', 'panelobjectpaths', 'PanelPaths', 'Paths']);
      human = names.length ? `${class_} → ${names.join('、')}` : class_;
    }
  }
  return { type, className: class_, disabled, human };
}

// 原始字段 dump（--full 用）：把 payload 图翻成普通 JS 对象，引用标注指向。
// 交互树/大纲树里有自引用（Tree.tree → 自己），用 seen 断环，否则会展开成一坨。
function rawDump(graph, node, depth = 0, seen = new Set()) {
  if (!node || depth > 12) return '…';
  switch (node.tag) {
    case 1: {
      const out = {};
      for (const [key, value] of node.entries) out[key.text ?? `tag${key.tag}`] = rawDump(graph, value, depth + 1, seen);
      return out;
    }
    case 2: return node.items.map(item => rawDump(graph, item, depth + 1, seen));
    case 8: return node.text;
    case 6: return node.value;
    case 3: case 0x16: {
      const target = graph.objects.get(node.value);
      if (!target) return { ref: node.value };
      if (seen.has(target.id)) return { ref: `${target.className}#${target.id}`, circular: true };
      seen.add(target.id);
      return { ref: `${target.className}#${target.id}`, body: rawDump(graph, target.body, depth + 1, seen) };
    }
    case 0x13: case 0x10: return node.values;
    case 0x1d: return `guid:${node.value}`;
    case 9: return { object: `${node.className}#${node.id}`, body: rawDump(graph, node.body, depth + 1, seen) };
    default: return node.value ?? `tag${node.tag}`;
  }
}

// ---- 主分析 ----
export function readRp(file, { full = false, path = null, includeMasterWidgets = false } = {}) {
  const problems = [];
  const problem = (kind, message, extra = {}) => problems.push({ kind, message, ...extra });

  const version = detectFileVersion(file);
  const records = readRecords(file);
  const manifest = readManifest(file);

  // 每个记录只解析一次，缓存起来给后面所有查询用。
  const graphs = new Map();
  let parseFailures = 0;
  for (const record of records) {
    if (!record.strings) continue;
    try { graphs.set(record.index, parsePayload(record)); }
    catch (e) {
      parseFailures++;
      problem('unparseable-record', `${record.className} #${record.index} 解析失败：${e.message}`, { record: record.index });
    }
  }
  // 包 GUID（记录 GUID 列表的索引 2）→ 记录。
  const recordByPackageGuid = new Map();
  for (const record of records) {
    const guid = guidsOf(graphs.get(record.index))[1];
    if (guid) recordByPackageGuid.set(guid, record);
  }

  // manifest 的 parts 偏移相对 dataStart，package 指向 8 字节前缀（gzip 流在 +8）。
  const recordByRel = new Map(records.map(r => [r.offset - 8 - manifest.dataStart, r]));
  const packages = [];
  const walkManifest = (node, path) => {
    for (const [key, child] of Object.entries(node.children ?? {})) {
      const rel = child.parts?.package;
      const record = rel === undefined ? undefined : recordByRel.get(rel);
      const entry = {
        key, guid: unguidKey(key), path: path ? `${path}/${key}` : key,
        parts: child.parts ?? {},
        record: record?.index ?? null,
        className: record?.className ?? null,
        container: Object.keys(child.children ?? {}).length > 0
      };
      packages.push(entry);
      if (rel !== undefined && !record) {
        problem('unreadable-record', `manifest 登记了包 ${key}（偏移 ${rel}）但读不出记录`, { key, offset: rel });
      }
      walkManifest(child, entry.path);
    }
  };
  walkManifest(manifest.value.root, '');

  // DesignDocument：PackageInfo 表 + 站点树 + 母版树 + 全局变量。
  const docRecord = records.find(r => r.className === 'Axure:DesignDocument');
  if (!docRecord) throw new Error(`No Axure:DesignDocument record — not a readable ${versionLabel(version)} file`);
  const docGraph = graphs.get(docRecord.index) ?? parsePayload(docRecord);
  const docRoot = docGraph.objects.get(docGraph.roots.find(n => n.tag === 0xf)?.value);
  if (!docRoot) throw new Error('DesignDocument root object is missing');

  // guidIndex → PackageInfo（名称 + 类型）。页面和母版共用这一张表。
  const packageInfos = new Map();
  for (const item of field(docRoot.body, 'PackageInfos')?.items ?? []) {
    const info = docGraph.objects.get(item.value);
    const values = pairValues(field(info?.body ?? {}, 'package-id'));
    if (!values) continue;
    packageInfos.set(values[1], {
      name: strOf(field(info.body, 'package-name')) ?? '(未命名)',
      kind: docRecord.strings[values[0] - 1],
      className: info.className,
      guidIndex: values[1]
    });
  }

  // 站点地图 / 母版面板：按树的顺序（含文件夹递归）遍历，比 PackageInfo 列表顺序更贴近 Axure 面板。
  // node-table 的值有两种：tag 0x13 值对 [类型字符串, 包 GUID 下标] = 页面/母版；
  //                        tag 3 引用 = 文件夹（Axure:MasterTreeFolder，name 在对象里）。
  const readTreeMap = (mapField, kind) => {
    const folders = [], items = [];
    const mapNode = docGraph.objects.get(field(docRoot.body, mapField)?.value);
    const nodeTable = field(mapNode?.body ?? {}, 'node-table');
    const tree = docGraph.objects.get(field(mapNode?.body ?? {}, 'tree')?.value);
    const metaOf = nodeId => {
      const entry = nodeTable?.entries?.find(([key]) => key.value === nodeId);
      const value = entry?.[1];
      const pair = pairValues(value);
      if (pair) {
        const info = packageInfos.get(pair[1]);
        return { label: info?.name ?? `(节点#${nodeId})`, kind: info?.kind, guidIndex: info?.guidIndex, folder: false };
      }
      if (value?.tag === 3) {
        const folder = docGraph.objects.get(value.value);
        return { label: strOf(field(folder?.body ?? {}, 'name')) ?? `(节点#${nodeId})`, folder: true };
      }
      return { label: `(节点#${nodeId})`, folder: false };
    };
    const visit = (node, trail) => {
      for (const item of field(node?.body ?? {}, 'children')?.items ?? []) {
        const child = docGraph.objects.get(item.value);
        if (!child) continue;
        const meta = metaOf(child.id);
        if (meta.folder || (field(child.body, 'children')?.items ?? []).length) {
          folders.push({ name: meta.label, folder: [...trail] });
          visit(child, [...trail, meta.label]);
          continue;
        }
        items.push({ name: meta.label, kind: meta.kind ?? kind, folder: [...trail], guidIndex: meta.guidIndex });
      }
    };
    if (tree) visit(tree, []);
    if (!items.length && !folders.length) {
      // 树被裁剪或为空的旧文件：退回 PackageInfo 列表（只取目标类型）。
      for (const info of packageInfos.values()) if (info.kind === kind) items.push({ name: info.name, kind, folder: [], guidIndex: info.guidIndex });
    }
    return { items, folders };
  };
  const site = readTreeMap('sitemap', 'Axure:Page');
  const masterMap = readTreeMap('mastermap', 'Axure:Master');
  const pages = site.items, masters = masterMap.items;

  // 全局变量。
  const globalVariables = [];
  const variableSet = [...docGraph.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
  for (const item of field(variableSet?.body ?? {}, 'global-variables')?.items ?? []) {
    const variable = docGraph.objects.get(item.value);
    if (!variable) continue;
    globalVariables.push({
      name: strOf(field(variable.body, 'name')) ?? '',
      value: strOf(field(variable.body, 'default-value')) ?? '',
      variableId: intOf(field(variable.body, 'variable-id'))
    });
  }

  // 面板状态索引：状态 GUID → {状态名, 记录}。状态 GUID = PanelState 记录 GUID 列表的索引 2。
  const panelStates = new Map();
  const panelStateByRecord = new Map();
  let panelStateRecords = 0;
  for (const record of records) {
    if (record.className !== 'Axure:PanelState') continue;
    panelStateRecords++;
    const graph = graphs.get(record.index);
    if (!graph) continue;
    const guids = guidsOf(graph);
    const diagram = [...graph.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
    const name = strOf(field(diagram?.body ?? {}, 'Name'));
    const state = { name: name ?? '(未命名状态)', record: record.index };
    panelStateByRecord.set(record.index, state);
    for (const guid of [guids[1], guids[0]]) if (guid && !panelStates.has(guid)) panelStates.set(guid, state);
    if (!name) problem('unnamed-panel-state', `PanelState 记录 #${record.index} 没有 Axure:PanelDiagram.Name`, { record: record.index });
  }

  // 递归列表：面板状态内部、中继器行模板内部的 widget（含所属容器路径）。
  // 用于定位（重名歧义停机）与读取（阶段1：嵌套状态中的同名控件要能按容器区分）。
  const containedWidgets = [];
  const graphRecords = new Map([...graphs].map(([index, graph]) => [graph, index]));
  const visitedDiagrams = new Set();
  const visitedPanelStates = new Set();
  const visitPanelState = (state, containerPath) => {
    if (!state || visitedPanelStates.has(state.record)) return;
    const graph = graphs.get(state.record);
    if (!graph) return;
    visitedPanelStates.add(state.record);
    const diagram = [...graph.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
    visitDiagram(graph, diagram, containerPath);
  };
  const visitWidgetContainers = (graph, object, containerPath) => {
    const owner = widgetName(object) || `#${object.id}`;
    const guids = guidsOf(graph);
    for (const pitem of field(object.body, 'panel-diagrams')?.items ?? []) {
      const guidIndex = pairValues(pitem)?.[1] ?? pitem.value;
      const state = panelStates.get(guids[guidIndex - 1]);
      if (state) visitPanelState(state, [...containerPath, `${owner}(${state.name})`]);
    }
    const repeatable = graph.objects.get(field(object.body, 'BaseDiagram')?.value);
    if (repeatable) visitDiagram(graph, repeatable, [...containerPath, `${owner}(行模板)`]);
  };
  const visitDiagram = (graph, diagram, containerPath) => {
    if (!diagram) return;
    const diagramKey = `${graphRecords.get(graph)}:${diagram.id}`;
    if (visitedDiagrams.has(diagramKey)) return;
    visitedDiagrams.add(diagramKey);
    for (const item of field(diagram?.body ?? {}, 'diagram-objects')?.items ?? []) {
      const object = graph.objects.get(item.value);
      if (!object || !isWidget(object)) continue;
      const geo = geometryOf(graph, object);
      containedWidgets.push({
        id: object.id,
        name: widgetName(object),
        type: shortType(object.className),
        className: object.className,
        text: textOf(field(object.body, 'RichTextBlock') ?? field(object.body, 'TextBlock')),
        x: geo.x, y: geo.y, w: geo.w, h: geo.h,
        container: containerPath,
        record: graphRecords.get(graph) ?? null,
        ...(includeMasterWidgets ? { interactions: readInteractions(graph, graph.objects.get(field(object.body, 'InteractionMap')?.value), version) } : {})
      });
      visitWidgetContainers(graph, object, containerPath);
    }
  };

  // 从页面根开始进入其中的面板状态和中继器行模板，避免把页面根元件与容器内元件重复统计。
  for (const record of records.filter(item => item.className === 'Axure:Page')) {
    const graph = graphs.get(record.index);
    if (!graph) continue;
    const page = [...graph.objects.values()].find(o => o.className === 'Axure:Page');
    const diagram = graph.objects.get(field(page?.body ?? {}, 'diagram')?.value);
    for (const item of field(diagram?.body ?? {}, 'diagram-objects')?.items ?? []) {
      const object = graph.objects.get(item.value);
      if (object && isWidget(object)) visitWidgetContainers(graph, object, []);
    }
  }
  // 母版定义只读一次；页面中的实例仍保留为 ReferenceDiagramObject。
  for (const record of records.filter(item => includeMasterWidgets && item.className === 'Axure:Master')) {
    const graph = graphs.get(record.index);
    if (!graph) continue;
    const master = [...graph.objects.values()].find(o => o.className === 'Axure:Master');
    const name = strOf(field(master?.body ?? {}, 'name')) ?? `#${record.index}`;
    visitDiagram(graph, graph.objects.get(field(master?.body ?? {}, 'diagram')?.value), [`母版:${name}`]);
  }
  // 保留未被页面引用的状态记录，便于诊断孤儿 PanelState 内容。
  for (const record of records.filter(item => item.className === 'Axure:PanelState')) {
    const state = panelStateByRecord.get(record.index);
    if (state && !visitedPanelStates.has(record.index)) visitPanelState(state, [`面板状态:${state.name}`]);
  }

  // 记录级健康检查：悬空引用。
  let danglingRefs = 0;
  let sentinelSlotsNonZero = 0;
  for (const record of records) {
    const graph = graphs.get(record.index);
    if (!graph) continue;
    const guidCount = guidsOf(graph).length;
    const bad = [];
    walkNodes(graph.roots, node => {
      if (node.tag !== 3) return;
      if (graph.objects.has(node.value)) return;
      if (node.value >= 1 && node.value <= guidCount) {
        // 交互对象用 GUID 表下标当 id。指向「表内存在但本 record 无此对象」的 id 一律是
        // **空哨兵**（`SubmitButton`/`Condition`/`TargetRepeaterScope` 用它表示"无"）——
        // 实测 ref(3) 664 次、ref(4) 2 次、ref(17) 3 次，全部如此，且**与槽内容无关**：
        // 槽里的非零 GUID 只是分配残留。所以不算悬空。
        // 但 Axure 自己写的文件里这些槽**全是零**；槽非零只有外观差异（已验证照常加载渲染），
        // 单独计入 sentinelSlotsNonZero，不污染 problems。
        if ((guidsOf(graph)[node.value - 1] || '') !== '0'.repeat(32)) sentinelSlotsNonZero++;
        return;
      }
      bad.push(node.value);
    });
    if (bad.length) {
      danglingRefs += bad.length;
      problem('dangling-ref', `${record.className} #${record.index} 有 ${bad.length} 个悬空引用`, { record: record.index, refs: bad.slice(0, 5) });
    }
  }

  // 页面明细。
  const pageSummaries = [];
  let widgetCount = 0, panelCount = 0, interactionCount = 0, actionCount = 0;
  const tally = interactions => {
    interactionCount += interactions.length;
    for (const ix of interactions) actionCount += ix.cases.reduce((n, c) => n + c.actions.length, 0);
  };
  for (const page of pages) {
    const record = page.guidIndex !== undefined ? recordByPackageGuid.get(guidsOf(docGraph)[page.guidIndex - 1]) : undefined;
    const graph = record ? graphs.get(record.index) : undefined;
    if (!record || !graph) {
      problem('missing-page-record', `页面「${page.name}」找不到可解析的记录`, { page: page.name });
      pageSummaries.push({ name: page.name, folder: page.folder, record: record?.index ?? null, widgets: [], interactions: [], counts: { widgets: 0, dynamicPanels: 0, interactions: 0, namedWidgets: 0 } });
      continue;
    }
    const guids = guidsOf(graph);
    const pageObject = [...graph.objects.values()].find(o => o.className === 'Axure:Page');
    const widgets = [];
    for (const object of graph.objects.values()) {
      if (!isWidget(object)) continue;
      widgetCount++;
      const geo = geometryOf(graph, object);
      const widget = {
        id: object.id,
        name: widgetName(object),
        type: shortType(object.className),
        className: object.className,
        x: geo.x, y: geo.y, w: geo.w, h: geo.h,
        text: textOf(field(object.body, 'RichTextBlock') ?? field(object.body, 'TextBlock'))
      };
      // 动态面板：panel-diagrams = [strIdx('Axure:PanelState'), 页面 GUID 表下标]。
      const panel = field(object.body, 'panel-diagrams');
      if (panel) {
        panelCount++;
        widget.panel = (panel.items ?? []).map(item => {
          const guidIndex = pairValues(item)?.[1] ?? item.value;
          const guid = guids[guidIndex - 1];
          const state = guid ? panelStates.get(guid) : undefined;
          if (!state) {
            problem('unresolved-panel-state', `页面「${page.name}」面板「${widget.name}」的状态 ${guidIndex} 解析不到 PanelState 记录`, { page: page.name, widget: widget.name, guidIndex });
          }
          return { name: state?.name ?? `(状态 ${guidIndex})`, guidIndex, record: state?.record ?? null };
        });
      }
      const mapNode = graph.objects.get(field(object.body, 'InteractionMap')?.value);
      const interactions = readInteractions(graph, mapNode, version);
      if (interactions.length) { tally(interactions); widget.interactions = interactions; }
      if (full) widget.raw = rawDump(graph, object.body);
      widgets.push(widget);
    }
    const pageInteractions = readInteractions(graph, graph.objects.get(field(pageObject?.body ?? {}, 'interactionmap')?.value), version);
    tally(pageInteractions);
    pageSummaries.push({
      name: page.name, folder: page.folder, record: record.index,
      interactions: pageInteractions,
      widgets,
      counts: {
        widgets: widgets.length,
        dynamicPanels: widgets.filter(w => w.panel).length,
        interactions: widgets.reduce((n, w) => n + (w.interactions?.length ?? 0), 0) + pageInteractions.length,
        namedWidgets: widgets.filter(w => w.name).length
      }
    });
  }

  // 重名检测：顶层页面间重名 + 容器内重名（阶段1：无法消除歧义时必须让调用者看见）
  const duplicates = [];
  {
    const byName = new Map();
    const note = (name, where) => {
      if (!name) return;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(where);
    };
    for (const p of pages) note(p.name, `页面(${p.name})`);
    for (const w of containedWidgets) if (!w.container[0]?.startsWith('母版:')) note(w.name, `${w.container.join('/')}#${w.id}(记录${w.record})`);
    for (const [name, wheres] of byName) {
      if (wheres.length > 1) duplicates.push({ name, locations: wheres });
    }
    for (const d of duplicates) problem('duplicate-name', `名字「${d.name}」有 ${d.locations.length} 处：${d.locations.join(' | ')}（修改前必须消歧）`, { name: d.name, locations: d.locations });
  }

  return {
    path,
    version,
    format: `${versionLabel(version)} .rp`,
    bytes: file.length,
    dataStart: manifest.dataStart,
    records: {
      total: records.length,
      parsed: graphs.size,
      xml: records.filter(r => r.className.startsWith('xml:')).map(r => r.className),
      unparseable: parseFailures
    },
    packages,
    sitemap: {
      pages: pages.map(p => ({ name: p.name, folder: p.folder, guidIndex: p.guidIndex })),
      masters: masters.map(m => ({ name: m.name, folder: m.folder, guidIndex: m.guidIndex })),
      folders: site.folders,
      masterFolders: masterMap.folders
    },
    globalVariables,
    containedWidgets,
    duplicates,
    pages: pageSummaries,
    counts: {
      packages: packages.length,
      pages: pages.length,
      masters: masters.length,
      widgets: widgetCount,
      dynamicPanels: panelCount,
      panelStates: panelStateRecords,
      interactions: interactionCount,
      actions: actionCount,
      globalVariables: globalVariables.length,
      danglingRefs,
      sentinelSlotsNonZero,
      problems: problems.length
    },
    problems
  };
}

// ---- 文本渲染 ----
const humanBytes = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const indent = (text, pad) => text.split('\n').map(line => pad + line).join('\n');

export function formatRpSummary(rp, { full = false } = {}) {
  const lines = [];
  lines.push(`# ${rp.path ?? '(buffer)'}  （${humanBytes(rp.bytes)}，manifest dataStart=${rp.dataStart}）`);
  lines.push(`记录 ${rp.records.total} 条（可解析 ${rp.records.parsed}${rp.records.xml.length ? `，XML：${rp.records.xml.join(', ')}` : ''}）、包 ${rp.counts.packages} 个`);
  lines.push('');

  lines.push('## manifest 包列表');
  for (const p of rp.packages) {
    const parts = Object.entries(p.parts).map(([k, v]) => `${k}@${v}`).join(' ');
    const parent = p.path.includes('/') ? `  ← ${p.path.split('/').slice(0, -1).join('/')}` : '';
    lines.push(`  ${p.guid}  ${(p.className ?? '(读不出)').padEnd(46)} ${p.container ? '[容器] ' : ''}${parts}${parent}`);
  }
  lines.push('');

  lines.push('## 站点地图');
  if (!rp.sitemap.pages.length && !rp.sitemap.masters.length) lines.push('  （空）');
  for (const p of rp.sitemap.pages) lines.push(`  ▸ 页面 ${p.name}${p.folder.length ? `  （${p.folder.join(' / ')}）` : ''}  guid#${p.guidIndex}`);
  for (const m of rp.sitemap.masters) lines.push(`  ▸ 母版 ${m.name}${m.folder.length ? `  （${m.folder.join(' / ')}）` : ''}  guid#${m.guidIndex}`);
  if (rp.sitemap.folders.length) lines.push(`  （页面文件夹：${rp.sitemap.folders.map(f => f.name).join('、')}）`);
  if (rp.sitemap.masterFolders.length) lines.push(`  （母版文件夹：${rp.sitemap.masterFolders.map(f => f.name).join('、')}）`);
  lines.push('');

  lines.push('## 全局变量');
  if (!rp.globalVariables.length) lines.push('  （无）');
  for (const v of rp.globalVariables) lines.push(`  ${v.name} = ${JSON.stringify(v.value)}${v.variableId !== undefined ? `   [id ${v.variableId}]` : ''}`);
  lines.push('');

  lines.push('## 容器内元件（面板状态 / 中继器行模板，递归）');
  if (!rp.containedWidgets.length) lines.push('  （无）');
  for (const w of rp.containedWidgets) {
    const label = w.name ? `「${w.name}」` : `(#${w.id})`;
    const num = v => (typeof v === 'number' ? Number(v.toFixed(2)) : v);
    const geo = [w.x, w.y, w.w, w.h].some(v => v !== null && v !== undefined)
      ? `x=${num(w.x)} y=${num(w.y)} w=${num(w.w)} h=${num(w.h)}` : '无几何信息';
    lines.push(`  - ${label} ${w.type}  ${geo}  ← ${w.container.join(' / ')}`);
    if (w.text) lines.push(`      文本：${JSON.stringify(w.text.length > 120 ? `${w.text.slice(0, 120)}…` : w.text)}`);
  }
  lines.push('');

  lines.push('## 重名清单（歧义停机判据）');
  if (!rp.duplicates.length) lines.push('  （无重名）');
  else for (const d of rp.duplicates) lines.push(`  ⚠️ 「${d.name}」× ${d.locations.length}: ${d.locations.join(' | ')}`);
  lines.push('');

  lines.push('## 页面明细');
  for (const page of rp.pages) {
    lines.push(`### ${page.name}${page.folder.length ? `  （${page.folder.join(' / ')}）` : ''}  记录#${page.record ?? '?'}  widget ${page.counts.widgets} 个`);
    for (const ix of page.interactions ?? []) {
      lines.push(`  [页面交互] ${ix.event}${ix.disabled ? '（已禁用）' : ''} → ${ix.cases.flatMap(c => c.actions.map(a => a.human)).join(' → ') || '(无用例)'}`);
    }
    for (const w of page.widgets ?? []) {
      const hasGeo = [w.x, w.y, w.w, w.h].some(v => v !== null && v !== undefined);
      const num = v => (typeof v === 'number' ? Number(v.toFixed(2)) : v);
      const label = w.name ? `「${w.name}」` : `(#${w.id})`;
      lines.push(`  - ${label} ${w.type}  ${hasGeo ? `x=${num(w.x)} y=${num(w.y)} w=${num(w.w)} h=${num(w.h)}` : '无几何信息'}`);
      if (w.text) lines.push(`      文本：${JSON.stringify(w.text.length > 120 ? `${w.text.slice(0, 120)}…` : w.text)}`);
      if (w.panel) lines.push(`      动态面板（${w.panel.length} 个状态）：${w.panel.map(s => s.name).join(' | ')}`);
      for (const ix of w.interactions ?? []) {
        lines.push(`      交互 ${ix.event}${ix.disabled ? '（已禁用）' : ''}`);
        for (const c of ix.cases) {
          if (c.description) lines.push(`        用例「${c.description}」`);
          for (const a of c.actions) lines.push(`          · ${a.human}${a.disabled ? '（已禁用）' : ''}`);
        }
      }
      if (full && w.raw) lines.push(indent(JSON.stringify(w.raw, null, 1), '      '));
    }
    lines.push('');
  }

  lines.push('## 统计');
  lines.push(`  ${Object.entries(rp.counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  lines.push('');
  lines.push('## 问题清单');
  if (!rp.problems.length) lines.push('  ✅ 无（记录全部可解析、引用完整）');
  else for (const p of rp.problems) lines.push(`  ⚠️ [${p.kind}] ${p.message}`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const positional = args.filter(a => !a.startsWith('--'));
  const target = positional[0];
  if (!target) {
    console.error('Usage: node rp-read.mjs <file.rp> [--json] [--full] [--include-master-widgets]');
    console.error('  --json  JSON 输出（默认人读摘要）');
    console.error('  --full  附每个 widget 的原始字段 dump');
    console.error('  --include-master-widgets  附共享母版定义中的元件及容器交互');
    process.exit(1);
  }
  const rp = readRp(readFileSync(target), { full: flags.has('--full'), path: target, includeMasterWidgets: flags.has('--include-master-widgets') });
  console.log(flags.has('--json') ? JSON.stringify(rp, null, 2) : formatRpSummary(rp, { full: flags.has('--full') }));
}
