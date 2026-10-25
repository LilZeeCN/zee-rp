import { nativeRuntimeValue } from './runtime-expr.mjs';
// Offline interaction builder: append events + actions to a widget (or a page) inside a .rp file.
// Schemas were reverse engineered from Axure's own sample documents
// (DefaultSettings/Training/*.rp and DefaultSettings/Libraries/*.rplib).
// See references/rp-format-research.md for the encoding notes.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { detectFileVersion, resolveTargetVersion } from './version.mjs';
import { RP9_ENABLE_VALUES, RP11_ONLY_FCALLS, RP11_ONLY_EVENTS } from './version-fields.mjs';
import { adaptNodesForVersion } from './version-adapt.mjs';

// Complete FCall function registry recovered statically from
// Axure.DocumentModel.Expressions.ExprFunctions on RP 11.0.0.4137 (2026-10-12).
// Serializing a name outside this set produces an undefined-function FCall that
// fails at preview runtime (the historical Concat failure).
// 与 RP 9 程序集里**可写函数注册表**（G4wP.y4wj 的 Get/Set/Is/位置/值 五组）逐名对账过：
//   注册表全集 34 个（去重）；其中 Set 组 6 个我们以动作形式覆盖（set-text/set-check/set-selected）。
//   本集合是**表达式取值**这一侧我们能写的名字。对账脚本：patch/fcall-audit.mjs
// 事件派生类（GetKeyPressed / GetAdaptiveView / IsEntering / IsOver / IsLeaving / IsNotOver）：
// **可写实参数 = 序列化实参数**，事件上下文由求值器自动补。
// 依据两版预览运行时 expr.js 的求值器（2026-10-16 实测）：
//     } else fcallArgs[fcallArgs.length] = eventInfo;      // ← **总是**把 eventInfo 追加为最后一个实参
//     return _exprFunctions[expr.functionName].apply(this, fcallArgs);
// 所以运行时签名里的 eventInfo 形参**不需要**用户写：
//   GetKeyPressed(eventInfo) / GetAdaptiveView(eventInfo)                     → 0 参
//   IsOver/IsEntering/IsLeaving/IsNotOver(movingRects, targetRects)           → 2 参（矩形表达式）
// 矩形表达式由 GetWidgetRectangles(widget) / GetCursorRectangles() 提供（两者都已在注册表里）。
export const REGISTERED_FCALLS = new Set([
  'GetKeyPressed', 'GetAdaptiveView', 'IsEntering', 'IsOver', 'IsLeaving', 'IsNotOver',
  'GetCheckState', 'GetCursorRectangles', 'GetDisabledState', 'GetErrorState', 'GetFocusedWidgetText',
  'GetGlobalVariableLength', 'GetGlobalVariableValue', 'GetPanelState', 'GetSelectedOption',
  'GetWidgetRectangles', 'GetWidgetText', 'GetWidgetValueLength', 'GetWidgetVisibility',
  'IsValueAlpha', 'IsValueAlphaNumeric', 'IsValueNotAlpha', 'IsValueNotAlphaNumeric',
  'IsValueNotNumeric', 'IsValueNotOneOf', 'IsValueNumeric', 'IsValueOneOf',
  'SetErrorState', 'SetGlobalVariableValue', 'ToLowerCase', 'ValueContains', 'ValueNotContains'
]);
export const WIDGET_PATH_FCALLS = new Set([
  'GetWidgetText', 'GetWidgetValueLength', 'GetWidgetVisibility', 'GetWidgetRectangles',
  'GetCheckState', 'GetDisabledState', 'GetSelectedOption', 'GetPanelState', 'GetErrorState'
]);
export const FCALL_SPECS = {
  GetWidgetText: { arity: 1, paramTypes: ['widgetPath'] },
  GetWidgetValueLength: { arity: 1, paramTypes: ['widgetPath'] },
  GetWidgetVisibility: { arity: 1, paramTypes: ['widgetPath'] },
  GetWidgetRectangles: { arity: 1, paramTypes: ['widgetPath'] },
  GetGlobalVariableValue: { arity: 1, paramTypes: ['globalVariable'] },
  GetGlobalVariableLength: { arity: 1, paramTypes: ['globalVariable'] },
  SetGlobalVariableValue: { arity: 2, paramTypes: ['globalVariable', 'scalar'] },
  IsValueAlpha: { arity: 1, paramTypes: ['scalar'] },
  IsValueNumeric: { arity: 1, paramTypes: ['scalar'] },
  IsValueAlphaNumeric: { arity: 1, paramTypes: ['scalar'] },
  IsValueNotAlpha: { arity: 1, paramTypes: ['scalar'] },
  IsValueNotNumeric: { arity: 1, paramTypes: ['scalar'] },
  IsValueNotAlphaNumeric: { arity: 1, paramTypes: ['scalar'] },
  ToLowerCase: { arity: 1, paramTypes: ['scalar'] },
  // 事件派生：0 参（事件由求值器自动追加）
  GetKeyPressed: { arity: 0, paramTypes: [] },
  GetAdaptiveView: { arity: 0, paramTypes: [] },
  // 事件派生：2 个矩形表达式
  IsOver: { arity: 2, paramTypes: ['scalar', 'scalar'] },
  IsEntering: { arity: 2, paramTypes: ['scalar', 'scalar'] },
  IsLeaving: { arity: 2, paramTypes: ['scalar', 'scalar'] },
  IsNotOver: { arity: 2, paramTypes: ['scalar', 'scalar'] },
  // RP 11 专属：两版运行时函数表不同（RP11 的 expr.js 有，RP9 没有）。
  //   GetErrorState(ids)            → $ax('#'+ids[0]).error()   形状同 GetCheckState（已验）
  //   SetErrorState(elementIds, value) → value 取 'toggle' / 真值 / 'false'
  GetErrorState: { arity: 1, paramTypes: ['widgetPath'] },
  SetErrorState: { arity: 2, paramTypes: ['widgetPath', 'scalar'] },
  GetCheckState: { arity: 1, paramTypes: ['widgetPath'] },
  GetDisabledState: { arity: 1, paramTypes: ['widgetPath'] },
  GetSelectedOption: { arity: 1, paramTypes: ['widgetPath'] },
  GetPanelState: { arity: 1, paramTypes: ['widgetPath'] },
  GetFocusedWidgetText: { arity: 0, paramTypes: [] },
  GetCursorRectangles: { arity: 0, paramTypes: [] },
  ValueContains: { arity: 2, paramTypes: ['scalar', 'scalar'] },
  ValueNotContains: { arity: 2, paramTypes: ['scalar', 'scalar'] },
  IsValueOneOf: { arity: 2, paramTypes: ['scalar', 'optionSet'] },
  IsValueNotOneOf: { arity: 2, paramTypes: ['scalar', 'optionSet'] }
};
export const FCALL_ARITIES = Object.fromEntries(
  Object.entries(FCALL_SPECS).map(([k, v]) => [k, v.arity])
);
// Axure.Constants.IxEventType (values verified against Axure's own assemblies)
export const EVENTS = {  OnClick: 16, OnDoubleClick: 17, OnMouseOver: 18, OnMouseMove: 19, OnMouseOut: 20,
  OnMouseDown: 21, OnMouseUp: 22, OnKeyDown: 32, OnKeyUp: 33, OnFocus: 48, OnLostFocus: 49,
  OnTextChange: 50, OnSelectionChange: 51, OnSelectedChange: 52, OnSelect: 53, OnUnselect: 54,
  OnErrorSet: 55, OnErrorRemoved: 56, OnSwipeLeft: 256, OnSwipeRight: 257, OnSwipeUp: 258,
  OnSwipeDown: 259, OnDragStart: 272, OnDrag: 273, OnDragDrop: 274, OnMove: 275, OnShow: 276,
  OnHide: 277, OnPanelStateChange: 278, OnRotate: 279, OnLoad: 288, OnItemLoad: 289,
  OnItemResize: 290, OnBeforeItemLoad: 291, Raised: 304, OnPageLoad: 320, OnResize: 321,
  OnScroll: 322, OnContextMenu: 323, OnScrollDown: 324, OnScrollUp: 325, OnMouseHover: 336,
  OnLongClick: 337, OnAdaptiveViewChange: 338, Variable: 352
};
// Axure.DocumentModel.Expressions.FadeEasingType
// .NET GUID bytes → manifest key（同 duplicate-page.guidKey；本地副本避免跨文件循环依赖）
const guidKeyRev = hex => { const b = Buffer.from(hex.replace(/-/g, ''), 'hex'); return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]).toString('hex'); };

const FADE_EASE = {
  none: 0, fade: 1, slideRight: 2, slideLeft: 3, slideUp: 4, slideDown: 5, flipRight: 6,
  flipLeft: 7, flipUp: 8, flipDown: 9, fadeAndScale: 10, scale: 11
};
// Axure.DocumentModel.Interaction.ShowType
const SHOW_TYPE = { none: 0, front: 1, lightbox: 2, flyout: 3, compressVertical: 4, compressRight: 5 };
// Axure.DocumentModel.Expressions.AnimationEasing (move / rotate / panel transitions)
const EASE = {
  none: 0, swing: 1, linear: 2, easeInCubic: 3, easeOutCubic: 4, easeInSine: 8, easeInQuad: 9,
  easeInQuart: 10, easeInQuint: 11, easeInExpo: 12, easeInCirc: 13, easeInBack: 14,
  easeInElastic: 15, easeInBounce: 16, easeOutSine: 17, easeOutQuad: 18, easeOutQuart: 19,
  easeOutQuint: 20, easeOutExpo: 21, easeOutCirc: 22, easeOutBack: 23, easeOutElastic: 24,
  easeOutBounce: 25, easeInOutSine: 26, easeInOutQuad: 27, easeInOutCubic: 28
};
const MOVE_BEHAVIOR = { location: 0, delta: 1, drag: 2, withThis: 6 };
const SET_STATE = { diagram: 0, next: 1, previous: 2, value: 3, current: 4 };
const TARGET_TYPE = { url: 0, page: 1, reload: 2, back: 3 };

const num = v => (typeof v === 'string' ? Number(v) : v);
function pick(table, value, what) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (Object.values(table).includes(value)) return value;
    throw new Error(`Unknown ${what} numeric code ${value}. Known values: ${[...new Set(Object.values(table))].join(', ')}`);
  }
  const key = String(value);
  if (table[key] !== undefined) return table[key];
  const ci = Object.keys(table).find(k => k.toLowerCase() === key.toLowerCase());
  if (ci !== undefined) return table[ci];
  throw new Error(`Unknown ${what} "${value}". Known: ${Object.keys(table).join(', ')}`);
}


// Resolve a page name (as shown in the sitemap) to its Axure:Page record.
// Page names live in the DesignDocument's PackageInfo list; the package GUID links to the page record
// (the page's own GUID list carries its package GUID at index 2).
export function resolvePageRecord(file, pageName) {
  const records = readRecords(file);
  const doc = records.find(r => r.className === 'Axure:DesignDocument');
  if (!doc) throw new Error('No DesignDocument record');
  const d = parsePayload(doc);
  const dg = d.roots.find(n => n.tag === 0x1e)?.values ?? [];
  const infos = [...d.objects.values()].filter(o => o.className === 'Axure:PackageInfo'
    && field(o.body, 'package-name')?.text === pageName
    && doc.strings[field(o.body, 'package-id').values[0] - 1] === 'Axure:Page');
  if (infos.length !== 1) throw new Error(`Expected exactly one page named "${pageName}", found ${infos.length}: ${infos.map(o => `PackageInfo#${o.id}`).join(', ')}`);
  const [info] = infos;
  const packageGuid = dg[field(info.body, 'package-id').values[1] - 1];
  const rec = records.find(r => {
    if (r.className !== 'Axure:Page') return false;
    let g; try { g = parsePayload(r); } catch { return false; }
    const gl = g.roots.find(n => n.tag === 0x1e)?.values ?? [];
    const packageIndex = g.roots.find(n => n.tag === 0x12)?.value;
    return gl[packageIndex - 1] === packageGuid;
  });
  if (!rec) throw new Error(`Page record not found for "${pageName}"`);
  return rec;
}

// The same page owns its root diagram and every reachable panel-state diagram.
// Keep the owning record/graph with each widget so event owners and action paths
// can live in different records without confusing local object IDs with GUIDs.
export function pageWidgetContexts(file, pageName) {
  const records = readRecords(file);
  const root = resolvePageRecord(file, pageName);
  const parsed = records.filter(r => r.className === 'Axure:PanelState').map(r => {
    const graph = parsePayload(r);
    const table = graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
    const diagram = [...graph.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
    return { r, graph, guid: diagram ? table[diagram.id - 1] : null };
  });
  const result = [], visited = new Set();
  const visit = (r, graph, container) => {
    if (visited.has(r.index)) return;
    visited.add(r.index);
    const widgets = [...graph.objects.values()].filter(o => o.className.startsWith('Axure:DiagramObject:'));
    result.push({ r, graph, widgets, container, pageName });
    const guids = graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
    for (const panel of widgets.filter(o => o.className === 'Axure:DiagramObject:DynamicPanel')) {
      const name = field(field(panel.body, 'name-block') ?? {}, 'text')?.text;
      for (const pair of field(panel.body, 'panel-diagrams')?.items ?? []) {
        const guid = guids[(pair.values?.[1] ?? pair.value) - 1];
        const state = parsed.find(context => context.guid === guid);
        if (!state) throw new Error(`Panel state record missing for ${pageName}/${name}`);
        const diagram = [...state.graph.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
        visit(state.r, state.graph, [...container, `${name}(${field(diagram.body, 'Name')?.text})`]);
      }
    }
  };
  visit(root, parsePayload(root), []);
  return result;
}

export function addInteractions(file, target, interactions, { replaceEvent = false, version } = {}) {
  if (!Array.isArray(interactions) || !interactions.length) throw new Error('No interactions given');
  // 写侧编码必须跟随「这个文件自己的版本」，不是本机装的哪个 Axure。
  const targetVersion = version !== undefined ? resolveTargetVersion(version) : resolveTargetVersion(detectFileVersion(file));
  // target 三种形态：
  //   'WidgetName'                      全局按名找 widget（重名报错并列候选）
  //   { page: 'PageName' }              页面级交互
  //   { widget: 'Name', page: 'PageName' }  限定页面内找 widget（两页同名只改指定页）
  const masterName = typeof target === 'object' && target !== null ? target.master : null;
  const pageOnly = typeof target === 'object' && target !== null && (target.page !== undefined || masterName) && target.widget === undefined;
  const widgetName = pageOnly ? null : (typeof target === 'string' ? target : target.widget);
  const pageName = pageOnly ? target.page : (target && target.page ? target.page : null);

  const matches = [];
  let masterRecord;
  if (masterName) {
    const records = readRecords(file), doc = records.find(r => r.className === 'Axure:DesignDocument');
    const g = parsePayload(doc), guids = g.roots.find(n => n.tag === 0x1e).values;
    const info = [...g.objects.values()].find(o => o.className === 'Axure:MasterPackageInfo' && field(o.body, 'package-name')?.text === masterName);
    if (!info) throw new Error(`Master not found: ${masterName}`);
    const guid = guids[field(info.body, 'package-id').values[1] - 1];
    masterRecord = records.find(r => r.className === 'Axure:Master' && (() => {
      const pg = parsePayload(r); return pg.roots.find(n => n.tag === 0x1e).values[pg.roots.find(n => n.tag === 0x12).value - 1] === guid;
    })());
    if (!masterRecord) throw new Error(`Master package not found: ${masterName}`);
  }
  const pageRecords = masterRecord ? [masterRecord] : pageName ? [resolvePageRecord(file, pageName)] : readRecords(file).filter(r => r.className === 'Axure:Page');
  // Legacy global-name lookup retains its root-only semantics. Page-scoped calls
  // explicitly opt into reachable panel-state lookup.
  const contexts = !masterRecord && pageName && !pageOnly ? pageWidgetContexts(file, pageName)
    : pageRecords.map(r => ({ r, graph: parsePayload(r), container: [] }));
  for (const { r, graph, container } of contexts) {
    const pageObj = [...graph.objects.values()].find(o => o.className === (masterName ? 'Axure:Master' : 'Axure:Page'));
    if (pageOnly) { matches.push({ kind: 'page', r, graph, pageObj }); continue; }
    for (const widget of graph.objects.values()) {
      if (!widget.className.startsWith('Axure:DiagramObject:') && !widget.className.startsWith('Axure:Repeater')) continue;
      if (typeof target === 'object' && target.record !== undefined && target.record !== r.index) continue;
      if (typeof target === 'object' && target.container && JSON.stringify(target.container) !== JSON.stringify(container)) continue;
      if (field(field(widget.body, 'name-block') ?? {}, 'text')?.text === widgetName) matches.push({ kind: 'widget', r, graph, widget });
    }
  }
  const what = pageOnly ? `page ${pageName}` : `widget ${widgetName}${pageName ? `（限定页面 ${pageName}）` : ''}`;
  if (matches.length !== 1) {
    const candidates = matches.map(m => `  · ${m.kind} #${m.r.index} obj#${m.widget?.id ?? m.pageObj?.id} ${m.widget?.className ?? ''}`);
    throw new Error(`Expected exactly one ${what}, found ${matches.length}\n${candidates.join('\n')}`);
  }

  const { kind, r, graph, widget, pageObj } = matches[0];
  const strings = [...r.strings];
  const guidNode = graph.roots.find(n => n.tag === 0x1e);
  if (!guidNode) throw new Error('Record has no GUID list root');
  const guids = guidNode.values;
  const nullId = guids.indexOf('00000000000000000000000000000000') + 1;
  if (!nullId) throw new Error('Missing null GUID');

  const str = text => { let i = strings.indexOf(text); if (i < 0) { i = strings.length; strings.push(text); } return { tag: 8, value: i + 1, text }; };
  const ref = v => ({ tag: 3, value: v });
  const guidRef = v => ({ tag: 0x16, value: v });
  const int = v => ({ tag: 5, value: v });
  const bool = v => ({ tag: 0x19, value: !!v });
  const f64 = v => ({ tag: 6, value: num(v) });
  const list = items => ({ tag: 2, items });
  const dict = entries => ({ tag: 1, entries });
  const map = props => dict(Object.entries(props).filter(([, v]) => v !== undefined).map(([k, v]) => [str(k), v]));
  const newGuid = () => { guids.push(randomBytes(16).toString('hex')); return guids.length; };

  const defs = [];
  const versionAdaptations = [];   // 本次为适配目标版本所做的编码改动（进 report，避免被当成宿主通过）
  const obj = (id, className, props) => {
    const node = { tag: 9, id, classIndex: str(className).value, className, body: map(props) };
    defs.push(node);
    return node;
  };
  const literal = text => obj(newGuid(), 'Axure:Expr:StringLiteral', {
    value: str(String(text)), 'variable-identifiers': list([]),
    'repeater-scope': ref(nullId), TargetRepeaterScope: ref(nullId)
  });

  const nameOf = o => field(field(o.body, 'name-block') ?? {}, 'text')?.text;
  const importGuid = guid => {
    if (!guid) throw new Error('Missing GUID for cross-container reference');
    let id = guids.indexOf(guid) + 1;
    if (!id) { guids.push(guid); id = guids.length; }
    return id;
  };
  const findWidget = name => {
    const candidates = [...graph.objects.values()].filter(o =>
      (o.className.startsWith('Axure:DiagramObject:') || o.className.startsWith('Axure:Repeater')) && nameOf(o) === name);
    if (!candidates.length && pageName) {
      const external = pageWidgetContexts(file, pageName).flatMap(context => context.widgets
        .filter(o => nameOf(o) === name).map(node => ({ node, context })));
      if (external.length !== 1) throw new Error(`Expected exactly one widget named "${name}" in page "${pageName}", found ${external.length}`);
      const { node, context } = external[0];
      const sourceGuids = context.graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
      return { ...node, id: importGuid(sourceGuids[node.id - 1]), sourceGraph: context.graph, sourceGuids };
    }
    if (candidates.length !== 1) throw new Error(`Expected exactly one widget named "${name}" on record #${r.index}, found ${candidates.length}: ${candidates.map(o => `obj#${o.id}`).join(', ')}`);
    return candidates[0];
  };
  const repeaterColumnId = (repeater, columnName) => {
    if (repeater.className !== 'Axure:DiagramObject:Repeater')
      throw new Error(`"${nameOf(repeater)}" is not a repeater`);
    const data = graph.objects.get(field(repeater.body, 'Data')?.value);
    for (const entry of field(data?.body ?? {}, 'columns')?.items ?? []) {
      const column = graph.objects.get(entry.value);
      if (field(column?.body ?? {}, 'name')?.text === columnName)
        return field(column.body, 'variable-id').value;
    }
    throw new Error(`Repeater column "${columnName}" not found`);
  };
  const globalVariableInfo = variableName => {
    const doc = readRecords(file).find(record => record.className === 'Axure:DesignDocument');
    if (!doc) throw new Error('No DesignDocument record for global variable lookup');
    const docGraph = parsePayload(doc);
    const variableSet = [...docGraph.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
    const matches = (field(variableSet?.body ?? {}, 'global-variables')?.items ?? [])
      .map(item => docGraph.objects.get(item.value))
      .filter(variable => field(variable?.body ?? {}, 'name')?.text === variableName);
    if (matches.length !== 1)
      throw new Error(`Expected exactly one global variable named "${variableName}", found ${matches.length}`);
    const variableId = field(matches[0].body, 'variable-id')?.value;
    const variableGuid = docGraph.roots.find(node => node.tag === 0x1e)?.values?.[variableId - 1];
    if (!variableGuid) throw new Error(`Global variable "${variableName}" has no GUID entry`);
    let pageGuidIndex = guids.indexOf(variableGuid) + 1;
    if (!pageGuidIndex) { guids.push(variableGuid); pageGuidIndex = guids.length; }
    return { variableId, pageGuidIndex };
  };
  const globalVariableGuidIndex = variableName => globalVariableInfo(variableName).pageGuidIndex;
  // Dynamic panels store states as (typeNameStringIdx, guidIdx) pairs; the state name + GUID live in the
  // matching Axure:PanelState record (its PanelDiagram node id indexes that record's own GUID list).
  const panelStates = panelWidget => {
    const states = new Map();
    for (const pair of field(panelWidget.body, 'panel-diagrams')?.items ?? []) {
      const guidIndex = pair.tag === 0x13 ? pair.values[1] : pair.value;
      const guid = (panelWidget.sourceGuids ?? guids)[guidIndex - 1];
      if (!guid) continue;
      let named = false;
      for (const rec of readRecords(file)) {
        if (rec.className !== 'Axure:PanelState') continue;
        let g2; try { g2 = parsePayload(rec); } catch { continue; }
        const own = g2.roots.find(n => n.tag === 0x1e)?.values ?? [];
        const diagram = [...g2.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
        if (!diagram || own[diagram.id - 1] !== guid) continue;
        const nm = field(diagram.body, 'Name');
        if (nm && nm.tag === 8) { states.set(nm.text, importGuid(guid)); named = true; }
      }
      if (!named) states.set(`(state ${guidIndex})`, guidIndex);
    }
    return states;
  };
  const repeaterByWidgetId = new Map();
  for (const o of graph.objects.values()) {
    if (o.className === 'Axure:DiagramObject:Repeater') {
      const bd = graph.objects.get(field(o.body, 'BaseDiagram')?.value);
      const collect = items => {
        for (const item of items ?? []) {
          repeaterByWidgetId.set(item.value, o.id);
          const child = graph.objects.get(item.value);
          if (child) collect(field(child.body, 'DiagramObjects')?.items);
        }
      };
      if (bd) collect(field(bd.body, 'diagram-objects')?.items);
    }
  }
  const pathTo = targetNodeId => {
    const ownerRepId = repeaterByWidgetId.get(targetNodeId);
    return obj(newGuid(), 'Axure:DiagramObjectPath', {
      'rdo-path': list([]),
      'repeater-path': list(ownerRepId ? [guidRef(ownerRepId)] : []),
      'object-id': guidRef(targetNodeId),
      'is-dummy': bool(false)
    });
  };
  const treeNodePath = (treeName, nodeText) => {
    const tree = findWidget(treeName);
    if (tree.className !== 'Axure:DiagramObject:TreeNodeObject')
      throw new Error(`"${treeName}" is not a tree widget`);
    const labelOf = node => {
      const texts = [];
      for (const item of field(node.body, 'diagram-objects')?.items ?? []) {
        const child = graph.objects.get(item.value);
        const richText = field(child?.body ?? {}, 'RichTextBlock');
        if (!richText) continue;
        const direct = richText.entries?.find(([key, value]) => key.text === 'text' && value.tag === 8)?.[1];
        if (direct) { texts.push(direct.text); continue; }
        walkNodes([richText], n => {
          if (n.tag !== 1 || !n.entries) return;
          for (const [key, value] of n.entries)
            if (key.text === 'Text' && value.tag === 8 && value.text) texts.push(value.text);
        });
      }
      return texts.join('').trim();
    };
    const matches = [];
    const visit = (node, seen = new Set()) => {
      if (!node || seen.has(node.id)) return;
      seen.add(node.id);
      if (labelOf(node) === String(nodeText)) matches.push(node);
      for (const item of field(node.body, 'childnodes')?.items ?? [])
        visit(graph.objects.get(item.value), seen);
    };
    visit(tree);
    if (matches.length !== 1)
      throw new Error(`Expected exactly one tree node named "${nodeText}" inside "${treeName}", found ${matches.length}: ${matches.map(n => `obj#${n.id}`).join(', ')}`);
    return pathTo(matches[0].id);
  };

  const runtimeValue = (ast, options) => nativeRuntimeValue(ast, {
    obj, newGuid, str, list, ref, dict, bool, nullId, graph, findWidget, globalVariableInfo, pathTo,
  }, options);

  // ---- 条件构造器：取自自带控件库的真实 BinaryExpr ----
  const OPS = { '&&': 1, '||': 2, '==': 3, '!=': 4, '>': 5, '<': 6, '>=': 7, '<=': 8 };
  const buildCondition = when => {
    if (!when || typeof when !== 'object') throw new Error('Condition "when" must be a non-null object');
    // when: { op:'==', left:{widget:'X', fn:'GetWidgetText'} | {value:'abc'}, right:{value:'Yes'} | {widget} }
    const operation = expression => {
      const op = typeof expression.op === 'number' ? expression.op : OPS[expression.op];
      if (op === undefined) throw new Error(`Unknown condition operator "${expression.op}". Known: ${Object.keys(OPS).join(', ')}`);
      return op;
    };
    const side = e => {
      if (e === undefined || e === null) throw new Error('condition side 不能为空');
      if (typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean') return ref(literal(e).id);
      if (typeof e !== 'object') throw new Error(`Unsupported condition side expression type: ${typeof e}`);
      if (e.runtime) return ref(runtimeValue(e.runtime).id);
      const semanticCount = [
        e.value !== undefined,
        e.op !== undefined,
        e.globalVariable !== undefined || e.variable !== undefined,
        e.widgetPath !== undefined,
        (e.fn !== undefined && Array.isArray(e.args)),
        e.widget !== undefined,
      ].filter(Boolean).length;
      if (semanticCount > 1) {
        throw new Error(`Ambiguous condition side expression: contains multiple semantic forms in ${JSON.stringify(e)}`);
      }
      if (e.value !== undefined) return ref(literal(e.value).id);
      if (e.op !== undefined) {
        if (e.left === undefined || e.right === undefined)
          throw new Error('nested condition expressions require both left and right sides');
        return ref(obj(newGuid(), 'Axure:Expr:BinaryExpr', {
          'left-expr': side(e.left), 'right-expr': side(e.right), operation: int(operation(e))
        }).id);
      }
      if (e.globalVariable !== undefined) {
        const varName = String(e.globalVariable);
        const varInfo = globalVariableInfo(varName);
        return ref(obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
          value: { tag: 0x11, value: varInfo.pageGuidIndex },
          'is-dummy': bool(false),
          'variable-name': str(varName)
        }).id);
      }
      if (e.widgetPath !== undefined) {
        const path = pathTo(findWidget(e.widgetPath).id);
        return ref(obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(path.id) }).id);
      }
      if (typeof e.fn === 'string' && Array.isArray(e.args)) {
        if (e.fn === 'Concat')
          throw new Error('Concat is not an Axure RP 11.0.0.4137 FCall; use a StringLiteral value such as [["A".concat("B")]]');
        if (!REGISTERED_FCALLS.has(e.fn))
          throw new Error(`Unknown FCall function "${e.fn}". Registered functions (Axure.DocumentModel.Expressions.ExprFunctions on RP 11.0.0.4137): ${[...REGISTERED_FCALLS].join(', ')}`);
        // 名字在注册表里不等于目标版本有它：这两版预览运行时的函数表并不相同。
        if (targetVersion === 9 && RP11_ONLY_FCALLS.has(e.fn))
          throw new Error(`FCall function "${e.fn}" is RP 11-only; Axure RP 9 does not provide it (RP 9 运行时只有 38 个表达式函数，此名不在其中)`);
        const spec = FCALL_SPECS[e.fn];
        if (spec && spec.arity !== undefined && e.args.length !== spec.arity)
          throw new Error(`FCall function "${e.fn}" expects ${spec.arity} argument${spec.arity === 1 ? '' : 's'}, received ${e.args.length}`);
        // `IsValueOneOf(val, values)` / `IsValueNotOneOf` 的第二个参数在磁盘上是
        //   Axure:Expr:ArrayExpr { items: [ <表达式>, <表达式>, ... ] }
        // 依据（REA + 运行时实测，2026-10-16）：
        //   ① 两版预览运行时 expr.js：IsValueOneOf = function(val, values){ for(...) if(val==values[i]) return true; return false; }
        //      —— 第二个形参是**数组**；
        //   ② 程序集 ArrayExpr.rv2F/Bv2O 只序列化一个键 `items`；类名 `Axure:Expr:ArrayExpr`
        //      在 RP 9 类注册表字符串里（两版都有，非版本差异）；
        //   ③ **items 里直接放表达式，不要再套 OptionLiteral** —— 套了会让 RP 9 预览整页空白
        //      （实测：套 OptionLiteral 暗像素 7243=空白；不套 9024=正常，且 data.js 里出现
        //        IsValueOneOf）。虽然程序集里确实存在 `Axure:Expr:OptionLiteral{Option}`，
        //      但那不是这个参数要的形状。
        //   ④ RP 9 原生预览行为实测：IsValueOneOf("b",["a","b","c"]) == true → 命中分支。
        const buildOptionSet = arg => {
          const arr = arg?.array ?? arg?.values;
          if (!Array.isArray(arr) || arr.length === 0)
            throw new Error(`FCall function "${e.fn}" argument must be { array: [...] } with at least one option, received ${JSON.stringify(arg)}`);
          const items = arr.map(v => side(v));   // 变体 B：items 直接放表达式，不套 OptionLiteral
          return ref(obj(newGuid(), 'Axure:Expr:ArrayExpr', { items: list(items) }).id);
        };

        const args = e.args.map((arg, idx) => {
          const expectedType = spec?.paramTypes?.[idx];
          if (expectedType === 'widgetPath') {
            if (arg?.widgetPath !== undefined) return side(arg);
            if (arg?.widget !== undefined) {
              const path = pathTo(findWidget(arg.widget).id);
              return ref(obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(path.id) }).id);
            }
            throw new Error(`FCall function "${e.fn}" argument #${idx + 1} expects a widget target, received ${JSON.stringify(arg)}`);
          }
          if (expectedType === 'globalVariable') {
            if (arg?.globalVariable !== undefined) return side(arg);
            if (arg?.variable !== undefined) {
              const varName = String(arg.variable);
              const varInfo = globalVariableInfo(varName);
              return ref(obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
                value: { tag: 0x11, value: varInfo.pageGuidIndex },
                'is-dummy': bool(false),
                'variable-name': str(varName)
              }).id);
            }
            throw new Error(`FCall function "${e.fn}" argument #${idx + 1} expects a global variable identifier, received ${JSON.stringify(arg)}`);
          }
          if (expectedType === 'scalar') {
            if (arg?.widgetPath !== undefined || arg?.globalVariable !== undefined)
              throw new Error(`FCall function "${e.fn}" argument #${idx + 1} expects a scalar expression or literal, received target reference`);
          }
          if (expectedType === 'optionSet') return buildOptionSet(arg);
          return side(arg);
        });

        return ref(obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str(e.fn), args: list(args)
        }).id);
      }
      if (e.variable !== undefined) {
        const varName = String(e.variable);
        const varInfo = globalVariableInfo(varName);
        const varLiteral = obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
          value: { tag: 0x11, value: varInfo.pageGuidIndex },
          'is-dummy': bool(false),
          'variable-name': str(varName)
        });
        return ref(obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str('GetGlobalVariableValue'),
          args: list([ref(varLiteral.id)])
        }).id);
      }
      if (e.widget) {
        const fnName = e.fn ?? 'GetWidgetText';
        if (!REGISTERED_FCALLS.has(fnName))
          throw new Error(`Unknown FCall function "${fnName}". Registered functions: ${[...REGISTERED_FCALLS].join(', ')}`);
        if (targetVersion === 9 && RP11_ONLY_FCALLS.has(fnName))
          throw new Error(`FCall function "${fnName}" is RP 11-only; Axure RP 9 does not provide it`);
        if (!WIDGET_PATH_FCALLS.has(fnName))
          throw new Error(`FCall function "${fnName}" does not accept a single widget target path. Supported widget path functions: ${[...WIDGET_PATH_FCALLS].join(', ')}`);
        const path = pathTo(findWidget(e.widget).id);
        return ref(obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str(fnName),
          args: list([ref(obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(path.id) }).id)])
        }).id);
      }
      throw new Error('无法识别的 condition side: ' + JSON.stringify(e));
    };
    const leftSide = when.left !== undefined ? when.left : (widget ? { widget: nameOf(widget), fn: 'GetWidgetText' } : undefined);
    const rightSide = when.right !== undefined ? when.right : { value: '' };
    return obj(newGuid(), 'Axure:Expr:BinaryExpr', {
      'left-expr': side(leftSide),
      'right-expr': side(rightSide),
      operation: int(operation({ ...when, op: when.op ?? '==' }))
    });
  };

  // ---- action builders: field sets copied from Axure-authored sample documents ----
  const build = (spec, ctx) => {
    const type = String(spec.type ?? spec.action ?? '').toLowerCase();
    const targetName = spec.target ?? spec.widget ?? (ctx.widget ? nameOf(ctx.widget) : null);
    const paths = () => ({ widget: findWidget(targetName), path: pathTo(findWidget(targetName).id) });
    const info = (cls, props) => obj(newGuid(), cls, props);
    switch (type) {
      case 'link': {
        if (Boolean(spec.page) === Boolean(spec.url)) throw new Error('link requires exactly one of page or url');
        if (spec.window !== undefined && !['current', 'new'].includes(spec.window))
          throw new Error('link window must be current or new');
        let pageTypeIndex = spec.pageTypeIndex ?? 1, pageGuidIndex = spec.pageGuidIndex ?? nullId;
        if (spec.page) {
          const destination = parsePayload(resolvePageRecord(file, String(spec.page)));
          const table = destination.roots.find(n => n.tag === 0x1e).values;
          const pageGuid = table[destination.roots.find(n => n.tag === 0x12).value - 1];
          pageGuidIndex = guids.indexOf(pageGuid) + 1;
          if (!pageGuidIndex) { guids.push(pageGuid); pageGuidIndex = guids.length; }
          pageTypeIndex = str('Axure:Page').value;
        }
        const target = obj(newGuid(), 'Axure:InteractionTarget', {
          'target-type': int(spec.page ? TARGET_TYPE.page : TARGET_TYPE.url),
          'target-page-id': { tag: 0x13, values: [pageTypeIndex, pageGuidIndex] },
          'target-literal': ref(literal(spec.url ?? spec.page).id)
        });
        return obj(newGuid(), 'Axure:InteractionLinkWindowAction',
          { Disabled: bool(false), target: ref(target.id), 'link-type': int(spec.window === 'new' ? 2 : 1) });
      }
      case 'show': case 'hide': case 'toggle': {
        const { path } = paths();
        const fade = type === 'show' ? 1 : type === 'hide' ? 0 : 2;
        if (spec.duration !== undefined) {
          const dur = num(spec.duration);
          if (!Number.isFinite(dur) || dur < 0) throw new Error('fade duration must be a non-negative finite number');
        }
        const duration = spec.duration !== undefined ? num(spec.duration) : 250;
        const easing = pick(FADE_EASE, spec.animation ?? 'fade', 'animation');
        // RP 9 的 FadeWidgetInfo writer 只有 13 键，**没有** scale / scale-hide / scale-anchor /
        // scale-hide-anchor（REA Axure.DocumentModel.Interaction.FadeWidgetInfo.rv2F = 0x06008fa7）。
        // 这四个键由 spec.scale / spec.anchor 驱动；静默丢掉 = 缩放效果无声消失，所以按版本明确拒绝。
        if (targetVersion === 9 && (spec.scale !== undefined || spec.anchor !== undefined)) {
          throw new Error('show/toggle 的 scale / anchor 是 RP 11 专属能力（RP 9 的 FadeWidgetInfo 无对应键），已明确拒绝；RP 9 上请去掉 scale/anchor');
        }
        const fold = info('Axure:FadeWidgetInfo', {
          duration: f64(duration), 'fade-action-type': int(fade), easing: int(easing),
          DurationHide: f64(duration), EasingHide: int(easing), BringToFront: bool(spec.bringToFront),
          'show-type': int(pick(SHOW_TYPE, spec.showType ?? 'none', 'showType')),
          'compress-easing': int(0), 'compress-duration': f64(500), 'compress-distance-type': int(0),
          'custom-compress-value': ref(literal('').id), 'page-background': int(0),
          'page-background-blur': dict([[str('On'), bool(false)], [str('Radius'), int(4)]]),
          'animation-hide': int(pick(EASE, spec.hideEasing ?? 'none', 'easing')),
          'animation-show': int(pick(EASE, spec.showEasing ?? 'none', 'easing')),
          scale: f64(spec.scale ?? 0), 'scale-hide': f64(spec.scale ?? 0),
          'scale-anchor': str(spec.anchor ?? 'center'), 'scale-hide-anchor': str(spec.anchor ?? 'center'),
          // RP 9 原生 FadeWidgetInfo 有 vertical:bool，RP 11 已移除该键。按 showType 的压缩方向回填。
          ...(targetVersion === 9 ? { vertical: bool((spec.showType ?? 'none') === 'compressVertical') } : {})
        });
        return obj(newGuid(), 'Axure:InteractionFadeWidgetAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          WidgetPaths: list([ref(path.id)]), FadeInfos: list([ref(fold.id)])
        });
      }
      case 'move': case 'set-position': {
        const { path } = paths();
        const validModes = ['location', 'delta', 'drag', 'withThis'];
        const mode = spec.mode !== undefined ? String(spec.mode) : (type === 'move' ? 'delta' : 'location');
        if (!validModes.includes(mode)) {
          throw new Error(`Unknown move mode "${spec.mode}". Supported: ${validModes.join(', ')}`);
        }
        if (spec.duration !== undefined) {
          const dur = num(spec.duration);
          if (!Number.isFinite(dur) || dur < 0) throw new Error('move duration must be a non-negative finite number');
        }
        const delta = mode !== 'location';
        const moveInfo = info('Axure:MoveWidgetInfo', {
          Easing: int(pick(EASE, spec.easing ?? 'swing', 'easing')), Duration: f64(spec.duration ?? 300),
          XValue: ref(literal(spec.x ?? 0).id), YValue: ref(literal(spec.y ?? 0).id),
          MoveType: int(delta ? MOVE_BEHAVIOR.delta : MOVE_BEHAVIOR.location),
          BoundaryCondition: ref(nullId), MoveTrajectory: int(0), scope: dict([])
        });
        return obj(newGuid(), 'Axure:InteractionMoveWidgetAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          WidgetPaths: list([ref(path.id)]), MoveInfos: list([ref(moveInfo.id)])
        });
      }
      case 'set-panel-state': {
        const panel = findWidget(spec.target ?? spec.panel);
        const path = pathTo(panel.id);
        const states = panelStates(panel);
        let stateType = SET_STATE.diagram, diagramId = nullId;
        if (spec.state !== undefined) {
          const key = String(spec.state);
          if (states.has(key)) diagramId = states.get(key);
          else if (SET_STATE[key.toLowerCase()] !== undefined) stateType = SET_STATE[key.toLowerCase()];
          else throw new Error(`Panel "${nameOf(panel)}" has no state "${key}". Known: ${[...states.keys()].join(', ')}, next, previous`);
        }
        const st = info('Axure:SetPanelStateInfo', {
          'set-state-type': int(stateType), 'diagram-id': guidRef(diagramId), 'state-value': ref(literal(spec.state ?? '').id),
          loop: bool(spec.loop), 'show-when-set': bool(spec.showWhenSet), compress: bool(spec.compress),
          'compress-easing': int(0), 'compress-duration': f64(0), vertical: bool(spec.vertical),
          'custom-compress-value': ref(literal('').id), 'compress-distance-type': int(0),
          'exit-easing': int(pick(FADE_EASE, spec.exitAnimation ?? 'none', 'animation')),
          'exit-duration': f64(spec.exitDuration ?? 500),
          'enter-easing': int(pick(FADE_EASE, spec.enterAnimation ?? 'none', 'animation')),
          'enter-duration': f64(spec.enterDuration ?? 500),
          repeat: bool(spec.repeat), 'repeat-interval': f64(spec.repeatInterval ?? 1000),
          'repeat-skip-first': bool(spec.repeatSkipFirst ?? true),
          'animation-enter': int(pick(EASE, spec.enterEasing ?? 'none', 'easing')),
          'animation-exit': int(pick(EASE, spec.exitEasing ?? 'none', 'easing')),
          'enter-scale': f64(0), 'enter-anchor': str('center'), 'exit-scale': f64(0), 'exit-anchor': str('center')
        });
        return obj(newGuid(), 'Axure:InteractionSetPanelStateAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          PanelPaths: list([ref(path.id)]), SetStateInfos: list([ref(st.id)])
        });
      }
      case 'set-panel-order': case 'bring-to-front': case 'send-to-back': {
        const { path } = paths();
        const front = type === 'bring-to-front' ? true
          : type === 'send-to-back' ? false
            : !(spec.front === false || spec.front === 'false');
        const order = info('Axure:SetPanelOrderInfo', { 'bring-to-front': bool(front) });
        return obj(newGuid(), 'Axure:InteractionSetPanelOrderAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          PanelPaths: list([ref(path.id)]), SetOrderInfos: list([ref(order.id)])
        });
      }
      case 'set-size': {
        const { path } = paths();
        // width / height 既接受字面量，也接受 RP/1 运行期表达式 AST（{kind:'binary'|'variable'|...}）
        const sizeOperand = v => (v && typeof v === 'object' && typeof v.kind === 'string')
          ? runtimeValue(v) : literal(v ?? '');
        const size = info('Axure:SetWidgetSizeInfo', {
          width: ref(sizeOperand(spec.width).id), height: ref(sizeOperand(spec.height).id),
          easing: int(pick(EASE, spec.easing ?? 'none', 'easing')), duration: f64(spec.duration ?? 500),
          anchor: str(spec.anchor ?? 'top left')
        });
        return obj(newGuid(), 'Axure:InteractionSetWidgetSizeAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          WidgetPaths: list([ref(path.id)]), SetSizeInfos: list([ref(size.id)])
        });
      }
      case 'enable': case 'disable': case 'toggle-enabled': {
        const { path } = paths();
        // RP 9 原生 EnableDisableWidgetsInfo.enable 是 bool（样本实测），只有启用/禁用两种状态；
        // RP 11 是同键的 int 枚举 Enable=0 / Disable=1 / Toggle=2。同名不同型，不能机械换算。
        if (targetVersion === 9) {
          if (type === 'toggle-enabled') {
            throw new Error('toggle-enabled has no Axure RP 9 representation: RP 9 EnableDisableWidgetsInfo.enable is a bool (enable/disable only). Use enable or disable.');
          }
          const en = info('Axure:EnableDisableWidgetsInfo', { enable: bool(RP9_ENABLE_VALUES[type]) });
          versionAdaptations.push(`enable/disable 按 RP 9 原生 bool 写入（RP 11 为 int 枚举）`);
          return obj(newGuid(), 'Axure:InteractionEnableDisableWidgetsAction', {
            Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
            WidgetPaths: list([ref(path.id)]), EnableDisableInfos: list([ref(en.id)])
          });
        }
        const value = type === 'enable' ? 0 : type === 'disable' ? 1 : 2;
        const en = info('Axure:EnableDisableWidgetsInfo', { enable: int(value) });
        return obj(newGuid(), 'Axure:InteractionEnableDisableWidgetsAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          WidgetPaths: list([ref(path.id)]), EnableDisableInfos: list([ref(en.id)])
        });
      }
      case 'wait':
        return obj(newGuid(), 'Axure:InteractionWaitAction',
          { Disabled: bool(false), wait_time: int(num(spec.ms ?? spec.wait ?? 1000)) });
      case 'rotate': {
        const { path } = paths();
        const rot = info('Axure:RotateWidgetInfo', {
          Clockwise: bool(!(spec.clockwise === false || spec.clockwise === 'false')),
          Duration: f64(spec.duration ?? 1000), Degree: ref(literal(spec.degree ?? spec.degrees ?? 90).id),
          RotateType: int(1), Easing: int(pick(EASE, spec.easing ?? 'linear', 'easing')),
          OffsetX: ref(literal(0).id), OffsetY: ref(literal(0).id), Anchor: str(spec.anchor ?? 'center')
        });
        return obj(newGuid(), 'Axure:InteractionRotateWidgetAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          Paths: list([ref(path.id)]), Infos: list([ref(rot.id)])
        });
      }
      case 'focus': {
        const { path } = paths();
        return obj(newGuid(), 'Axure:InteractionSetFocusOnWidgetAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]), SelectTextOnFocus: bool(spec.selectText)
        });
      }
      case 'set-text': case 'set-check': case 'set-selected': {
        const { widget: targetWidget, path } = paths();
        let fn = { 'set-check': 'SetCheckState', 'set-selected': 'SetSelectedOption' }[type];
        if (type === 'set-text') {
          if (targetWidget.className === 'Axure:DiagramObject:TextBox') fn = 'SetWidgetFormText';
          else if (targetWidget.className === 'Axure:DiagramObject:VectorShape') fn = 'SetWidgetRichText';
          else throw new Error(`set-text target "${targetName}" must be a TextBox or VectorShape; found ${targetWidget.className}`);
        }
        const arg = type === 'set-text' ? (spec.text ?? '') : (spec.checked ?? spec.value ?? 'true');
        const pathLiteral = obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(path.id) });
        const args = [ref(pathLiteral.id), ref((spec.runtime ? runtimeValue(spec.runtime) : literal(arg)).id)];
        if (fn === 'SetWidgetRichText') args.push(ref(obj(newGuid(), 'Axure:Expr:BooleanLiteral', { value: str('True') }).id));
        const call = obj(newGuid(), 'Axure:Expr:FCall', { 'function-name': str(fn), args: list(args) });
        const block = obj(newGuid(), 'Axure:Expr:Block', { subexpressions: list([ref(call.id)]) });
        return obj(newGuid(), 'Axure:InterationActionSetFunction',
          { Disabled: bool(false), action: ref(block.id), SetFunction: str(fn) });
      }
      case 'set-variable': {
        const variableName = String(spec.variable ?? spec.name ?? '');
        if (!variableName) throw new Error('set-variable requires variable=<global variable name>');
        const variable = obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
          value: { tag: 0x11, value: globalVariableGuidIndex(variableName) },
          'is-dummy': bool(false), 'variable-name': str(variableName)
        });
        let valueExpr;
        if (spec.runtime) valueExpr = runtimeValue(spec.runtime);
        else if (spec.expression !== undefined) {
          if (spec.value !== undefined) throw new Error('set-variable accepts value or expression, not both');
          const expression = String(spec.expression);
          if (!/^\[\[[\s\S]+\]\]$/.test(expression))
            throw new Error('set-variable expression must be a [[...]] expression');
          const bindings = spec.bindings ?? {};
          if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
            throw new Error('set-variable bindings must map aliases to {variable} or {widget}');
          const scope = [];
          const identifiers = [];
          valueExpr = obj(newGuid(), 'Axure:Expr:StringLiteral', {
            value: str(expression), 'variable-identifiers': list(identifiers), scope: dict(scope),
            'repeater-scope': ref(nullId), TargetRepeaterScope: ref(nullId)
          });
          for (const [alias, source] of Object.entries(bindings)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias))
              throw new Error(`Invalid set-variable expression alias "${alias}"`);
            if (!source || typeof source !== 'object' || Array.isArray(source) ||
              (Object.hasOwn(source, 'variable') === Object.hasOwn(source, 'widget')))
              throw new Error(`Binding "${alias}" needs exactly one of variable or widget`);
            let read;
            if (source.variable !== undefined) {
              const sourceName = String(source.variable);
              const sourceInfo = globalVariableInfo(sourceName);
              const sourceLiteral = obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
                value: { tag: 0x11, value: sourceInfo.pageGuidIndex },
                'is-dummy': bool(false), 'variable-name': str(sourceName)
              });
              read = obj(newGuid(), 'Axure:Expr:FCall', {
                'function-name': str('GetGlobalVariableValue'), args: list([ref(sourceLiteral.id)])
              });
              const identifier = obj(newGuid(), 'Axure:Expr:TextVariableIdentifier', {
                Id: { tag: 0x11, value: sourceInfo.variableId }, Name: str(alias),
                Expr: ref(valueExpr.id), TargetOverride: bool(false)
              });
              identifiers.push(ref(identifier.id));
            } else {
              const sourcePath = pathTo(findWidget(String(source.widget)).id);
              const pathLiteral = obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(sourcePath.id) });
              read = obj(newGuid(), 'Axure:Expr:FCall', {
                'function-name': str('GetWidgetText'), args: list([ref(pathLiteral.id)])
              });
            }
            scope.push([str(source.variable !== undefined ? alias.toLowerCase() : alias), ref(read.id)]);
          }
        } else valueExpr = literal(spec.value ?? '');
        const fn = 'SetGlobalVariableValue';
        const call = obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str(fn), args: list([ref(variable.id), ref(valueExpr.id)])
        });
        const block = obj(newGuid(), 'Axure:Expr:Block', { subexpressions: list([ref(call.id)]) });
        return obj(newGuid(), 'Axure:InterationActionSetFunction', {
          Disabled: bool(false), action: ref(block.id), SetFunction: str(fn)
        });
      }
      case 'set-rich-text': {
        const { path } = paths();
        const pathLiteral = obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(path.id) });
        const plain = obj(newGuid(), 'Axure:Expr:BooleanLiteral', { value: str('True') });
        const fn = 'SetWidgetRichText';
        const call = obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str(fn), args: list([ref(pathLiteral.id), ref(literal(spec.text ?? '').id), ref(plain.id)])
        });
        const block = obj(newGuid(), 'Axure:Expr:Block', { subexpressions: list([ref(call.id)]) });
        return obj(newGuid(), 'Axure:InterationActionSetFunction', {
          Disabled: bool(false), action: ref(block.id), SetFunction: str(fn)
        });
      }
      case 'set-rich-text-from-variable': {
        const { path } = paths();
        const variableName = String(spec.variable ?? spec.name ?? '');
        if (!variableName) throw new Error('set-rich-text-from-variable requires variable=<global variable name>');
        const { variableId, pageGuidIndex } = globalVariableInfo(variableName);
        const globalVariable = obj(newGuid(), 'Axure:Expr:GlobalVariableLiteral', {
          value: { tag: 0x11, value: pageGuidIndex },
          'is-dummy': bool(false), 'variable-name': str(variableName)
        });
        const variableValue = obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str('GetGlobalVariableValue'), args: list([ref(globalVariable.id)])
        });
        const value = obj(newGuid(), 'Axure:Expr:StringLiteral', {
          value: str(`${spec.prefix ?? ''}[[${variableName}]]${spec.suffix ?? ''}`),
          'variable-identifiers': list([]),
          scope: dict([[str(variableName.toLowerCase()), ref(variableValue.id)]]),
          'repeater-scope': ref(nullId), TargetRepeaterScope: ref(nullId)
        });
        const identifier = obj(newGuid(), 'Axure:Expr:TextVariableIdentifier', {
          Id: { tag: 0x11, value: variableId }, Name: str(variableName),
          Expr: ref(value.id), TargetOverride: bool(false)
        });
        field(value.body, 'variable-identifiers').items.push(ref(identifier.id));
        const pathLiteral = obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(path.id) });
        const plain = obj(newGuid(), 'Axure:Expr:BooleanLiteral', { value: str('True') });
        const fn = 'SetWidgetRichText';
        const call = obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str(fn), args: list([ref(pathLiteral.id), ref(value.id), ref(plain.id)])
        });
        const block = obj(newGuid(), 'Axure:Expr:Block', { subexpressions: list([ref(call.id)]) });
        return obj(newGuid(), 'Axure:InterationActionSetFunction', {
          Disabled: bool(false), action: ref(block.id), SetFunction: str(fn)
        });
      }
      case 'set-text-from-repeater-item': {
        // Set an external form field from the row handled by an interaction inside a repeater item.
        // The Item.Column expression shape is based on Axure-authored Sample form patterns.rplib.
        const { path } = paths();
        if (!spec.repeater || !spec.column) throw new Error('set-text-from-repeater-item requires repeater=<name> and column=<name>');
        const repeater = findWidget(spec.repeater);
        const columnId = repeaterColumnId(repeater, String(spec.column));
        const data = graph.objects.get(field(repeater.body, 'Data').value);
        if (!data) throw new Error(`Repeater "${nameOf(repeater)}" has no DataSet`);
        const item = graph.objects.get(field(repeater.body, 'BaseDiagram')?.value);
        const itemRoots = (field(item?.body ?? {}, 'diagram-objects')?.items ?? []).map(n => n.value);
        if (!ctx.widget || !itemRoots.includes(ctx.widget.id))
          throw new Error(`set-text-from-repeater-item must be attached to a root widget in repeater "${nameOf(repeater)}"`);
        const expression = obj(newGuid(), 'Axure:Expr:StringLiteral', {
          value: str(`[[Item.${spec.column}]]`), 'variable-identifiers': list([]), scope: dict([]),
          'repeater-scope': ref(data.id), TargetRepeaterScope: ref(nullId)
        });
        const variable = obj(newGuid(), 'Axure:Expr:TextVariableIdentifier', {
          Id: { tag: 0x11, value: columnId }, Name: str(`Item.${spec.column}`),
          Expr: ref(expression.id), TargetOverride: bool(false)
        });
        field(expression.body, 'variable-identifiers').items.push(ref(variable.id));
        const pathLiteral = obj(newGuid(), 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(path.id) });
        const call = obj(newGuid(), 'Axure:Expr:FCall', {
          'function-name': str('SetWidgetFormText'), args: list([ref(pathLiteral.id), ref(expression.id)])
        });
        const block = obj(newGuid(), 'Axure:Expr:Block', { subexpressions: list([ref(call.id)]) });
        return obj(newGuid(), 'Axure:InterationActionSetFunction',
          { Disabled: bool(false), action: ref(block.id), SetFunction: str('SetWidgetFormText') });
      }
      case 'raise-event': {
        // Axure:InteractionRaiseEventAction + Axure:FireEventsActionInfo.
        // Axure's Sample UI patterns.rplib sets IsPage=true even when the path
        // targets a named widget; the false variant did not fire in RP 11.0.0.4137.
        let path;
        if (spec.targetPage === true) {
          if (spec.target !== undefined) throw new Error('raise-event accepts targetPage=true or target=<widget>, not both');
          // RP 11.0.0.4137 DiagramObjectPath.Eb4f: current Page sentinel,
          // 12345678-ABCD-CDEF-EFAB-ABCDEFFEDCBA in .NET GUID byte order.
          // The actual Page object GUID is omitted by the preview compiler.
          const pageTargetGuid = '78563412cdabefcdefababcdeffedcba';
          let index = guids.indexOf(pageTargetGuid) + 1;
          if (!index) { guids.push(pageTargetGuid); index = guids.length; }
          path = pathTo(index);
        } else {
          ({ path } = paths());
        }
        const fireInfo = info('Axure:FireEventsActionInfo', {
          IsPage: bool(spec.firePage === undefined ? true : !!spec.firePage),
          RaisedEventIds: list([]),
          FireEventTypes: list([int(num(spec.eventType ?? EVENTS.OnClick))]),
          Raised: bool(!!spec.raised)
        });
        return obj(newGuid(), 'Axure:InteractionRaiseEventAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          Paths: list([ref(path.id)]), Infos: list([ref(fireInfo.id)]), Raised: bool(!!spec.raised)
        });
      }
      case 'set-image': {
        // 真值来源：2026-09-22 用户 UI 样本 set-image-truth.rp（单态）+ setimg-truth-saved.rp（双态，round7）。
        // InteractionSetImageAction → SetImagesStateInfo(5 状态) → SetImageStateInfo。
        // 静态图片内嵌：static-image = {Stream: tag4 图片字节, Extension, Hash: base64(md5(字节))}。
        // 双态真值实证：填充槽与 Normal 槽完全同构（MouseOver 也走 Stream/Extension/Hash 三键），
        // 未填充槽 = {Hash: ''} 占位（空 Stream 会让预览生成器 NRE）。
        // spec: image=<file> 普通态（必填）；mouseover=/mousedown=/selected=/disabled=<file> 可选多态。
        const { path } = paths();
        if (!spec.image) throw new Error('set-image requires image=<file path> (PNG/JPG/GIF/SVG)');
        const mkStatic = file => {
          const bytes = readFileSync(file);
          return dict([
            [str('Stream'), { tag: 4, value: bytes.toString('base64') }],
            [str('Extension'), str(extname(file).toLowerCase())],
            [str('Hash'), str(createHash('md5').update(bytes).digest('base64'))]
          ]);
        };
        // image-state 枚举（真值）：Normal=0 MouseOver=1 MouseDown=2 Selected=8 Disabled=64
        const stateSpecs = [
          [0, spec.image],
          [1, spec.mouseover ?? spec.hover],
          [2, spec.mousedown],
          [8, spec.selected],
          [64, spec.disabled],
        ];
        const stateInfos = stateSpecs.map(([state, file]) => info('Axure:SetImageStateInfo', {
          'image-state': int(state),
          'is-static-image': bool(true),
          'static-image': file ? mkStatic(file) : dict([[str('Hash'), str('')]])
        }));
        const statesInfo = info('Axure:SetImagesStateInfo', {
          Normal: ref(stateInfos[0].id), MouseOver: ref(stateInfos[1].id),
          MouseDown: ref(stateInfos[2].id), Selected: ref(stateInfos[3].id),
          Disabled: ref(stateInfos[4].id)
        });
        return obj(newGuid(), 'Axure:InteractionSetImageAction', {
          Disabled: bool(false),
          panelobjectpaths: list([ref(path.id)]),
          ImagePaths: list([ref(path.id)]),
          ImageStatesInfos: list([ref(statesInfo.id)])
        });
      }
      case 'data-sort': return build({ ...spec, type:'repeater-sort' }, ctx);
      case 'data-clear-sort': return build({ ...spec, type:'remove-sort', removeAll:true }, ctx);
      case 'data-clear-filter': return build({ ...spec, type:'remove-filter', removeAll:true }, ctx);
      case 'data-page': return build({ ...spec, type:'set-repeater-page' }, ctx);
      case 'data-add': return build({ ...spec, type:'repeater-add-items' }, ctx);
      case 'data-delete': return build({ ...spec, type:'repeater-delete-items' }, ctx);
      case 'data-update': return build({ ...spec, type:'repeater-update-items' }, ctx);
      case 'data-filter': return build({ ...spec, type:'repeater-filter' }, ctx);
      case 'repeater-sort': case 'repeater-filter': case 'repeater-add-items': case 'repeater-delete-items':
      case 'repeater-update-items': {
        // 中继器数据操作；Info 结构逆向自 Axure 自带 Sample UI/form patterns.rplib
        const { widget: repeater, path } = paths();
        if (type === 'repeater-sort') {
          // RP 9 的 AddSortToRepeaterInfo writer 只有 ascending / column-id / column-name /
          // label / sort-type / toggle（REA 0x060089f4），没有 remove-all-sorts。
          // 静默丢掉会让「清除其它排序」这个意图无声消失，所以按版本明确拒绝。
          if (targetVersion === 9 && spec.removeAll) {
            throw new Error('repeater-sort 的 removeAll（remove-all-sorts）是 RP 11 专属能力，RP 9 无对应键，已明确拒绝');
          }
          const sortInfo = info('Axure:AddSortToRepeaterInfo', {
            label: str(spec.label ?? ''), 'column-id': guidRef(repeaterColumnId(repeater, spec.column)),
            'column-name': str(spec.column ?? ''), ascending: bool(!!spec.ascending),
            toggle: bool(!!spec.toggle), 'sort-type': int(num(spec.sortType ?? 1)),
            'remove-all-sorts': bool(!!spec.removeAll)
          });
          return obj(newGuid(), 'Axure:InteractionAddSortToRepeaterAction', {
            Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
            RepeaterPaths: list([ref(path.id)]), AddSortInfos: list([ref(sortInfo.id)])
          });
        }
        if (type === 'repeater-filter') {
          const columnId = spec.predicate ? null : repeaterColumnId(repeater, spec.column);
          let condition = literal('');
          if (spec.condition) {
            const data = graph.objects.get(field(repeater.body, 'Data').value);
            const item = literal(`[[Item.${spec.column}]]`);
            field(item.body, 'repeater-scope').value = data.id;
            const variable = obj(newGuid(), 'Axure:Expr:TextVariableIdentifier', {
              Id: { tag: 0x11, value: columnId }, Name: str(`Item.${spec.column}`),
              Expr: ref(item.id), TargetOverride: bool(false)
            });
            field(item.body, 'variable-identifiers').items.push(ref(variable.id));
            condition = obj(newGuid(), 'Axure:Expr:BinaryExpr', {
              'left-expr': ref(item.id), 'right-expr': ref(literal(spec.filter ?? '').id),
              operation: int(3)
            });
          }
          // RP 9 的 AddFilterToRepeaterInfo writer 只有 Filter / Label / RemoveOtherFilters
          // （REA Axure.DocumentModel.Interaction.AddFilterToRepeaterInfo.rv2F = 0x06008981），
          // 过滤条件必须放进 Filter 自身；RP 11 才另立 Condition 等键。
          // ⚠ 这里必须「搬值」而不是「丢键」：若照旧写空字面量，版本适配会把条件整个丢掉，
          //   产出键集与 RP 9 原生一模一样、却是个空操作 —— 三零与 version-lint 都查不出这种静默损坏。
          if (targetVersion === 9 && spec.comboType !== undefined) {
            throw new Error('repeater-filter 的 comboType 是 RP 11 专属键（RP 9 的 AddFilterToRepeaterInfo 无对应）');
          }
          // RP 9 的 Filter 是 **StringLiteral，装整个 [[...]] 表达式**，不是表达式树：
          //   原生真值 Sample UI Patterns.rplib obj#359/628/46/833，value 形如
          //   "[[Item.ProductName.toLowerCase().indexOf(filter) >= 0]]"，variable-identifiers 列出引用变量。
          // ⚠ 指向 BinaryExpr 会让 RP 9 的 HTML 生成器**整页崩成空白**（2026-10-16 实测：
          //   不带动作的对照页正常渲染，带该动作的页全白）。此处沿用已验证的 Rule 表达式写法。
          let filterExprId = literal('').id;
          if (spec.predicate) filterExprId = runtimeValue(spec.predicate, { targetRows:true }).id;
          else if (targetVersion === 9) {
            const repDataForFilter = graph.objects.get(field(repeater.body, 'Data').value);
            const ruleLitId = newGuid(), identId = newGuid();
            obj(ruleLitId, 'Axure:Expr:StringLiteral', {
              value: str(`[[TargetItem.${spec.column} == '${spec.filter ?? ''}']]`),
              'variable-identifiers': list([ref(identId)]),
              scope: dict([]), 'repeater-scope': ref(nullId), TargetRepeaterScope: ref(repDataForFilter.id)
            });
            obj(identId, 'Axure:Expr:TextVariableIdentifier', {
              Id: { tag: 0x11, value: columnId }, Name: str(`TargetTargetItem.${spec.column}`),
              Expr: ref(ruleLitId), TargetOverride: bool(true)
            });
            filterExprId = ruleLitId;
          }
          const filterInfo = info('Axure:AddFilterToRepeaterInfo', {
            RemoveOtherFilters: bool(spec.removeOthers !== false),
            Label: str(spec.label ?? ''),
            Filter: ref(targetVersion === 9 ? filterExprId : literal('').id),
            UseCondition: bool(!!spec.condition),
            Condition: ref(condition.id),
            FilterComboType: int(num(spec.comboType ?? 2)),
            ColumnName: str(spec.column ?? ''),
            ColumnId: guidRef(columnId)
          });
          // Official Sample form/UI patterns.rplib serializes this class with
          // a dot after Axure; the colon form is rejected as unregistered.
          return obj(newGuid(), 'Axure.InteractionAddFilterToRepeaterAction', {
            Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
            RepeaterPaths: list([ref(path.id)]), AddFilterInfos: list([ref(filterInfo.id)])
          });
        }
        // add / delete / update items —— 2026-09-22 UI ground truth 全量重写
        // （用户在 Axure UI 配置后另存的 repeater-truth-saved.rp，obj#151/154 增、#178/181 删、
        //  #193/196 改（「编辑行数据」）；此前空哨兵版会让预览生成器 NRE，作废）。
        // 关键真值：
        //  · 动作壳四键 PascalCase：Disabled/panelobjectpaths/RepeaterPaths/<X>ItemInfos
        //    （add=AddItemInfos, delete=DeleteItemInfos, update=UpdateItemInfos）
        //  · 路径 = pathTo(中继器本体 id)：rdo-path/repeater-path 空 + object-id=guidRef(中继器 id)
        //  · AddItemsToDataSetInfo 三键：add-data-set(全新 DataSet 对象) + actual(中继器列 vid 的
        //    guidRef 并行列表) + add(新 DataSet 列 vid 的 guidRef 并行列表) —— actual[i]↔add[i] 是列映射
        //  · 新 DataSet 内 Element = {column-id: id11(新列vid), type: u32(3), value: →StringLiteral}
        //    （字面值如此；表单值用 [[LVAR1]] + StringLiteral.scope{LVAR1→GetWidgetText(...)}，
        //    对齐 Axure 官方动态增行真值；Literal.repeater-scope 指回该 DataSet）
        //  · Delete/Update Info（基类 DataSetInfoWithRowSelection）：
        //    SelectionType: u32(2)=规则模式, Rule: →StringLiteral(整个 [[...]] 串 + 变量标识符),
        //    RowIndicesText: str(''), RowIndicesRule: null
        //  · Rule 的 StringLiteral 五键：value/variable-identifiers/scope{}/repeater-scope=null/
        //    TargetRepeaterScope=→中继器的真实 DataSet；标识符 Name 恒 'TargetTargetItem.<列>'
        //  · UpdateInfo 另有：column-names(列名 str 列表) + update-data({Type:3, Text, Literal:→StringLiteral}
        //    字典列表) + actual(目标列 vid 列表)；值 StringLiteral 的 repeater-scope 指向 UI 的
        //    「列/值」迷你 DataSet（照抄真值形状）
        const repData = graph.objects.get(field(repeater.body, 'Data').value);
        if (type === 'repeater-add-items') {
          // spec: target=R7 columns=First_Name,Last_Name,Score rows=Frank,999,1008;Grace,777,1009
          const colNames = Array.isArray(spec.columns)
            ? spec.columns.map(s => String(s).trim()).filter(Boolean)
            : String(spec.columns ?? '').split(',').map(s => s.trim()).filter(Boolean);
          if (!colNames.length) throw new Error('repeater-add-items requires columns=<c1,c2,...>');
          // CLI 的 coerce() 会把 `rows=9` 这类纯数字值转成 Number；这里统一接受数字，
          // 否则「只有数字的数据行」根本传不进来（RP 11 上也一样）。
          const rawRows = spec.rows;
          if (rawRows === undefined || ((typeof rawRows === 'string' || typeof rawRows === 'number') && String(rawRows).trim() === '')) {
            throw new Error('repeater-add-items requires rows=<v1,v2,...;...>');
          }
          const rows = (typeof rawRows === 'string' || typeof rawRows === 'number')
            ? String(rawRows).split(';').map(row => row.split(',').map(value => ({ value: value.trim() })))
            : rawRows;
          if (!Array.isArray(rows) || !rows.length || rows.some(row => !Array.isArray(row)))
            throw new Error('repeater-add-items rows must be a non-empty array of row arrays or a delimited string');
          const cells = rows.map((row, rowIndex) => row.map((cell, columnIndex) => {
            if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean')
              return { kind: 'value', value: String(cell ?? '') };
            if (typeof cell !== 'object') throw new Error(`repeater-add-items row ${rowIndex + 1} cell ${columnIndex + 1} must be a value or {widget: name}`);
            if (cell.runtime) return {kind:'runtime', ast:cell.runtime};
            if (Object.hasOwn(cell, 'widget') && typeof cell.widget === 'string' && cell.widget.trim()) {
              if (cell.fn !== undefined && cell.fn !== 'GetWidgetText')
                throw new Error(`repeater-add-items row ${rowIndex + 1} cell ${columnIndex + 1} supports only GetWidgetText`);
              return { kind: 'widget', widget: cell.widget.trim(), fn: 'GetWidgetText' };
            }
            if (Object.hasOwn(cell, 'value')) return { kind: 'value', value: String(cell.value ?? '') };
            throw new Error(`repeater-add-items row ${rowIndex + 1} cell ${columnIndex + 1} must have value or widget`);
          }));
          if (new Set(colNames).size !== colNames.length) throw new Error('repeater-add-items requires unique columns');
          cells.forEach((row, i) => {
            if (row.length !== colNames.length) throw new Error(`repeater-add-items row ${i + 1} has ${row.length} cells; expected ${colNames.length} columns`);
          });
          const actionId = newGuid(), pathId = newGuid(), infoId = newGuid(), dsId = newGuid();
          // ⚠️ 列的 variable-id 是独立 GUID 槽（真值：vid 156/157/158 ≠ prop 对象 id 159/161）
          const newVids = colNames.map(() => newGuid());
          const propIds = colNames.map(() => newGuid());
          const rowIds = cells.map(() => newGuid());
          const elemIds = cells.map(row => row.map(() => newGuid()));
          const litIds = cells.map(row => row.map(() => newGuid()));
          const exprIds = cells.map(row => row.map(cell => cell.kind === 'widget'
            ? { path: newGuid(), pathLiteral: newGuid(), call: newGuid() } : null));
          const addAction = obj(actionId, 'Axure:InteractionAddItemsToDataSetAction', {
            Disabled: bool(false), panelobjectpaths: list([ref(pathId)]),
            RepeaterPaths: list([ref(pathId)]), AddItemInfos: list([ref(infoId)])
          });
          obj(pathId, 'Axure:DiagramObjectPath', {
            'rdo-path': list([]), 'repeater-path': list([]), 'object-id': guidRef(repeater.id), 'is-dummy': bool(false)
          });
          obj(infoId, 'Axure:AddItemsToDataSetInfo', {
            'add-data-set': ref(dsId),
            actual: list(colNames.map(n => guidRef(repeaterColumnId(repeater, n)))),
            add: list(newVids.map(v => guidRef(v)))
          });
          obj(dsId, 'Axure:DocumentModel:DataSet', {
            'parent-data': ref(nullId), 'obj-to-repeats': dict([]),
            columns: list(propIds.map(p => ref(p))), rows: list(rowIds.map(r => ref(r)))
          });
          propIds.forEach((pid, i) => obj(pid, 'Axure:DocumentModel:DataSetProp', {
            name: str(colNames[i]), 'variable-id': { tag: 0x11, value: newVids[i] }, 'linked-widget-path': ref(nullId)
          }));
          cells.forEach((row, r) => obj(rowIds[r], 'Axure:DocumentModel:DataSet:Row', {
            elements: list(elemIds[r].map(e => ref(e)))
          }));
          cells.forEach((row, r) => row.forEach((cell, c) => {
            obj(elemIds[r][c], 'Axure:DocumentModel:DataSet:Element', {
              'column-id': { tag: 0x11, value: newVids[c] }, type: int(3), value: ref(litIds[r][c])
            });
          }));
          cells.forEach((row, r) => row.forEach((cell, c) => {
            if (cell.kind === 'runtime') {
              const value = runtimeValue(cell.ast);
              const element = graph.objects.get(elemIds[r][c]) ?? defs.find(n=>n.id===elemIds[r][c]);
              field(element.body,'value').value = value.id;
              // Add cells are evaluated in their private AddItems DataSet.
              if (field(value.body,'repeater-scope').value === nullId) field(value.body,'repeater-scope').value = dsId;
              return;
            }
            const ids = exprIds[r][c];
            const variableName = 'LVAR1';
            obj(litIds[r][c], 'Axure:Expr:StringLiteral', {
              value: str(cell.kind === 'widget' ? `[[${variableName}]]` : cell.value),
              'variable-identifiers': list([]),
              ...(ids ? { scope: dict([[str(variableName), ref(ids.call)]]) } : {}),
              'repeater-scope': ref(dsId), TargetRepeaterScope: ref(nullId)
            });
            if (!ids) return;
            const widget = findWidget(cell.widget);
            obj(ids.call, 'Axure:Expr:FCall', {
              'function-name': str(cell.fn), args: list([ref(ids.pathLiteral)])
            });
            obj(ids.pathLiteral, 'Axure:Expr:DiagramObjectPathLiteral', { value: ref(ids.path) });
            obj(ids.path, 'Axure:DiagramObjectPath', {
              'rdo-path': list([]), 'repeater-path': list([]), 'object-id': guidRef(widget.id), 'is-dummy': bool(false)
            });
          }));
          return addAction;
        }
        if (type === 'repeater-delete-items') {
          // spec: target=R7 column=First_Name value=Bob（自动拼规则）或 rule="[[...]]" + column=
          const ruleText = spec.rule ?? `[[TargetItem.${spec.column} == '${spec.value}']]`;
          const colVid = spec.predicate ? null : repeaterColumnId(repeater, spec.column);
          const actionId = newGuid(), pathId = newGuid(), infoId = newGuid(), litId = newGuid(), identId = newGuid();
          const delAction = obj(actionId, 'Axure:InteractionDeleteItemsFromDataSetAction', {
            Disabled: bool(false), panelobjectpaths: list([ref(pathId)]),
            RepeaterPaths: list([ref(pathId)]), DeleteItemInfos: list([ref(infoId)])
          });
          obj(pathId, 'Axure:DiagramObjectPath', {
            'rdo-path': list([]), 'repeater-path': list([]), 'object-id': guidRef(repeater.id), 'is-dummy': bool(false)
          });
          // RP 9 的 DeleteItemsFromDataSetInfo writer 只有 Rule / SelectionType（REA 0x06008a2b），
          // 没有 RowIndicesText / RowIndicesRule。行序号只落在 RowIndicesText 里，静默丢掉会让
          // 删除按 Rule 表达式选行 —— 选错行，所以按版本明确拒绝。
          if (targetVersion === 9 && spec.rowIndices !== undefined) {
            throw new Error('rowIndices 是 RP 11 专属键（RP 9 的 DataSetInfoWithRowSelection 只有 Rule/SelectionType），已明确拒绝；RP 9 上请改用 rule=<[[]]> 指定规则');
          }
          obj(infoId, 'Axure:DeleteItemsFromDataSetInfo', {
            SelectionType: int(num(spec.selectionType ?? 2)), Rule: ref(spec.predicate ? runtimeValue(spec.predicate, {targetRows:true}).id : litId),
            RowIndicesText: str(String(spec.rowIndices ?? '')), RowIndicesRule: ref(nullId)
          });
          if (!spec.predicate) obj(litId, 'Axure:Expr:StringLiteral', {
            value: str(ruleText), 'variable-identifiers': list([ref(identId)]),
            scope: dict([]), 'repeater-scope': ref(nullId), TargetRepeaterScope: ref(repData.id)
          });
          if (!spec.predicate) obj(identId, 'Axure:Expr:TextVariableIdentifier', {
            Id: { tag: 0x11, value: colVid }, Name: str(`TargetTargetItem.${spec.column}`),
            Expr: ref(litId), TargetOverride: bool(true)
          });
          return delAction;
        }
        // repeater-update-items（「编辑行数据」）
        // spec: target=R7 column=First_Name value=Alice setColumn=Last_Name setValue=CHANGED
        const requestedUpdates = spec.updates ?? [{ column: spec.setColumn, value: spec.setValue }];
        // UI 真值当前只含一列；DataSetInfo 的列名、目标 ID 和更新值均为并行列表，
        // 迷你 DataSet 则按每个列/值对各存一行。多列形状仍需 Axure GUI/预览验收。
        if (!Array.isArray(requestedUpdates) || requestedUpdates.length === 0 ||
          requestedUpdates.some(u => u?.column === undefined || (u?.value === undefined && !u?.runtime))) {
          throw new Error('repeater-update-items requires a non-empty updates array of {column, value} pairs (or setColumn and setValue)');
        }
        const updates = requestedUpdates
          .map(u => ({ column: String(u.column), value: String(u.value ?? ''), runtime:u.runtime }));
        if (new Set(updates.map(u => u.column)).size !== updates.length)
          throw new Error('repeater-update-items updates must use each column only once');
        const updateColumnIds = updates.map(u => repeaterColumnId(repeater, u.column));
        const ruleText = spec.rule ?? `[[TargetItem.${spec.column} == '${spec.value}']]`;
        const ruleVid = spec.predicate ? null : repeaterColumnId(repeater, spec.column);
        const actionId = newGuid(), pathId = newGuid(), infoId = newGuid();
        const ruleLitId = newGuid(), identId = newGuid();
        const valueLiteralIds = updates.map(u => u.runtime ? runtimeValue(u.runtime, {targetRows:true}).id : newGuid());
        const miniDsId = newGuid(), mc1 = newGuid(), mc2 = newGuid();
        const miniRows = updates.map(() => ({ row: newGuid(), cells: [newGuid(), newGuid()] }));
        const mv1 = newGuid(), mv2 = newGuid(); // 列 vid 独立槽（真值 204/205 ≠ prop 对象 201/202）
        const updAction = obj(actionId, 'Axure:InteractionUpdateEditItemsInDataSetAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(pathId)]),
          RepeaterPaths: list([ref(pathId)]), UpdateItemInfos: list([ref(infoId)])
        });
        obj(pathId, 'Axure:DiagramObjectPath', {
          'rdo-path': list([]), 'repeater-path': list([]), 'object-id': guidRef(repeater.id), 'is-dummy': bool(false)
        });
        obj(infoId, 'Axure:UpdateEditItemsInDataSetInfo', {
          SelectionType: int(num(spec.selectionType ?? 2)), Rule: ref(spec.predicate ? runtimeValue(spec.predicate, {targetRows:true}).id : ruleLitId),
          RowIndicesText: str(String(spec.rowIndices ?? '')), RowIndicesRule: ref(nullId),
          'column-names': list(updates.map(u => str(u.column))),
          'update-data': list(updates.map((u, i) => dict([
            [str('Type'), int(3)], [str('Text'), str(u.value)], [str('Literal'), ref(valueLiteralIds[i])]
          ]))),
          actual: list(updateColumnIds.map(guidRef))
        });
        if (!spec.predicate) obj(ruleLitId, 'Axure:Expr:StringLiteral', {
          value: str(ruleText), 'variable-identifiers': list([ref(identId)]),
          scope: dict([]), 'repeater-scope': ref(nullId), TargetRepeaterScope: ref(repData.id)
        });
        if (!spec.predicate) obj(identId, 'Axure:Expr:TextVariableIdentifier', {
          Id: { tag: 0x11, value: ruleVid }, Name: str(`TargetTargetItem.${spec.column}`),
          Expr: ref(ruleLitId), TargetOverride: bool(true)
        });
        // UI 的「列/值」迷你 DataSet（值字面量的 repeater-scope 指向它；每列更新占一行）
        obj(miniDsId, 'Axure:DocumentModel:DataSet', {
          'parent-data': ref(nullId), 'obj-to-repeats': dict([]),
          columns: list([ref(mc1), ref(mc2)]), rows: list(miniRows.map(({ row }) => ref(row)))
        });
        obj(mc1, 'Axure:DocumentModel:DataSetProp', {
          name: str('列'), 'variable-id': { tag: 0x11, value: mv1 }, 'linked-widget-path': ref(nullId)
        });
        obj(mc2, 'Axure:DocumentModel:DataSetProp', {
          name: str('值'), 'variable-id': { tag: 0x11, value: mv2 }, 'linked-widget-path': ref(nullId)
        });
        updates.forEach((u, i) => {
          const { row, cells: [columnCell, valueCell] } = miniRows[i];
          const literalId = valueLiteralIds[i];
          if (!u.runtime) obj(literalId, 'Axure:Expr:StringLiteral', {
            value: str(u.value), 'variable-identifiers': list([]),
            'repeater-scope': ref(miniDsId), TargetRepeaterScope: ref(nullId)
          });
          obj(row, 'Axure:DocumentModel:DataSet:Row', { elements: list([ref(columnCell), ref(valueCell)]) });
          obj(columnCell, 'Axure:DocumentModel:DataSet:Element', {
            'column-id': { tag: 0x11, value: mv1 }, type: int(0), value: str(u.column)
          });
          obj(valueCell, 'Axure:DocumentModel:DataSet:Element', {
            'column-id': { tag: 0x11, value: mv2 }, type: int(3), value: ref(literalId)
          });
        });
        return updAction;
      }
      case 'set-opacity': {
        // Axure:InteractionSetOpacityAction + Axure:SetOpacityInfo
        // 对齐官方样本 gt-opacity.rp：Paths 代替 WidgetPaths，Duration(double)+Easing(int)+Opacity(Expr:StringLiteral)
        const { path } = paths();
        const opInfo = info('Axure:SetOpacityInfo', {
          Duration: f64(num(spec.duration ?? 500)),
          Easing: int(pick(EASE, spec.easing ?? 'none', 'easing')),
          Opacity: ref(literal(String(spec.opacity ?? 50)).id)
        });
        return obj(newGuid(), 'Axure:InteractionSetOpacityAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          Paths: list([ref(path.id)]), Infos: list([ref(opInfo.id)])
        });
      }
      case 'scroll-to': {
        // Native Axure 11.0.0.4137 truth, saved/reopened 2026-10-05:
        // fields live directly on the action; there is no Info child.
        const { path } = paths();
        return obj(newGuid(), 'Axure:InteractionScrollToWidgetAction', {
          Disabled: bool(false), targetwidgetpath: ref(path.id),
          scrolldirection: int(pick({ horizontal: 0, vertical: 1, both: 2 }, spec.direction ?? 'vertical', 'direction')),
          easing: int(pick(EASE, spec.easing ?? 'none', 'easing')),
          duration: f64(num(spec.duration ?? 500))
        });
      }
      case 'close-current': {
        // Axure:InteractionCloseCurrentAction（无路径参数，作用于当前窗口）
        return obj(newGuid(), 'Axure:InteractionCloseCurrentAction', { Disabled: bool(false) });
      }
      case 'apply-style': {
        // RP 9 的 get_TypeName 标签全集里没有 Axure:InteractionApplyStyle / InteractionApplyStyleInfo
        // （静态证据：RP 9 181 个标签全部出现在 RP 11，RP 11 只多这两个）。目标 RP 9 时明确拒绝。
        if (targetVersion === 9) {
          throw new Error('apply-style does not exist in Axure RP 9: the InteractionApplyStyle / InteractionApplyStyleInfo type tags are RP 11 additions. No RP 9 equivalent action has been established yet.');
        }
        // Native saved truth: InteractionApplyStyle + InteractionApplyStyleInfo.
        // Border width: native UI truth c000000f / Float64, saved 2026-10-09.
        // Opacity: native UI truth c0000046 / Float64, saved 2026-10-10.
        // Typeface: DefaultStyle DOA ID 1 stores the family name as a string.
        // Font size: native UI value 28 saves as DOA ID 2 / Float64 21, saved 2026-10-10.
        // Bold: native checked/unchecked fields save as DOA ID 3 / Integer 0/2,
        // with the unchecked state captured from Apply Style UI on 2026-10-10.
        // Italic: native checked field saves as DOA ID 4 / Integer 0, saved 2026-10-10.
        // Underline: native checked field saves as DOA ID 5 / Boolean true, saved 2026-10-10.
        // Strikethrough uses native RichText Style DOA ID 95; preview behavior is separately verified.
        const { path, widget: targetWidget } = paths();
        if (spec.fill === undefined && spec.borderColor === undefined && spec.textColor === undefined && spec.borderWidth === undefined && spec.opacity === undefined && spec.fontSize === undefined && spec.fontFamily === undefined && spec.bold === undefined && spec.italic === undefined && spec.underline === undefined && spec.strikethrough === undefined && !spec.clearPrevious)
          throw new Error('apply-style requires fill=#RRGGBB, textColor=#RRGGBB, borderColor=#RRGGBB, borderWidth, opacity=0..100, fontSize>0, fontFamily, bold=true|false, italic=true, underline=true, strikethrough=true or clearPrevious=true');
        const properties = [];
        if (spec.fill !== undefined) {
          if (!/^#[0-9a-f]{6}$/i.test(String(spec.fill)))
            throw new Error('apply-style fill must be #RRGGBB');
          const color = 0xff000000 + parseInt(String(spec.fill).slice(1), 16);
          properties.push(map({ DOAName: int(3221225479), Value: map({ 'fill-type': str('solid'), 'fill-color': int(color) }) }));
        }
        if (spec.borderColor !== undefined) {
          if (!/^#[0-9a-f]{6}$/i.test(String(spec.borderColor)))
            throw new Error('apply-style borderColor must be #RRGGBB');
          const color = 0xff000000 + parseInt(String(spec.borderColor).slice(1), 16);
          // Native RP 11.0.0.4137 ApplyStyle UI saved border color as property ID 8.
          properties.push(map({ DOAName: int(3221225480), Value: map({ 'fill-type': str('solid'), 'fill-color': int(color) }) }));
        }
        if (spec.textColor !== undefined) {
          if (!/^#[0-9a-f]{6}$/i.test(String(spec.textColor)))
            throw new Error('apply-style textColor must be #RRGGBB');
          const color = 0xff000000 + parseInt(String(spec.textColor).slice(1), 16);
          // Native RP 11.0.0.4137 Apply Style UI saved font color as property ID 6.
          properties.push(map({ DOAName: int(3221225478), Value: map({ 'fill-type': str('solid'), 'fill-color': int(color) }) }));
        }
        if (spec.borderWidth !== undefined) {
          const width = num(spec.borderWidth);
          if (!Number.isFinite(width) || width < 0)
            throw new Error('apply-style borderWidth must be a finite non-negative number');
          properties.push(map({ DOAName: int(3221225487), Value: f64(width) }));
        }
        if (spec.opacity !== undefined) {
          const opacity = num(spec.opacity);
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100)
            throw new Error('apply-style opacity must be a finite number from 0 to 100');
          properties.push(map({ DOAName: int(3221225542), Value: f64(opacity / 100) }));
        }
        if (spec.fontSize !== undefined) {
          const fontSize = num(spec.fontSize);
          if (!Number.isFinite(fontSize) || fontSize <= 0)
            throw new Error('apply-style fontSize must be a finite positive number');
          // Axure's UI displays CSS-style px, while style DOA ID 2 stores 3/4 of that value.
          properties.push(map({ DOAName: int(3221225474), Value: f64(fontSize * 0.75) }));
        }
        if (spec.fontFamily !== undefined) {
          if (typeof spec.fontFamily !== 'string' || !spec.fontFamily.trim())
            throw new Error('apply-style fontFamily must be a non-empty string');
          properties.push(map({ DOAName: int(3221225473), Value: str(spec.fontFamily) }));
        }
        if (spec.bold !== undefined) {
          if (targetWidget?.className === 'Axure:DiagramObject:TextBox')
            throw new Error('apply-style bold is unavailable on TextBox: the serialized action did not change computed fontWeight in the tested Axure RP 11 preview');
          if (typeof spec.bold !== 'boolean')
            throw new Error('apply-style bold must be a boolean');
          properties.push(map({ DOAName: int(3221225475), Value: int(spec.bold ? 0 : 2) }));
        }
        if (spec.italic !== undefined) {
          if (typeof spec.italic !== 'boolean')
            throw new Error('apply-style italic must be a boolean');
          throw new Error(`apply-style italic=${spec.italic} is unavailable: the serialized action did not change computed fontStyle in the tested Axure RP 11 preview`);
        }
        if (spec.underline !== undefined) {
          if (spec.underline !== true)
            throw new Error('apply-style underline currently supports true only');
          properties.push(map({ DOAName: int(3221225477), Value: bool(true) }));
        }
        if (spec.strikethrough !== undefined) {
          if (spec.strikethrough !== true)
            throw new Error('apply-style strikethrough currently supports true only');
          properties.push(map({ DOAName: int(3221225567), Value: bool(true) }));
        }
        // The native editor needs the unchecked default properties too (including
        // Typeface). Sparse styles preview correctly but fail when edited.
        const docRecord = readRecords(file).find(record => record.className === 'Axure:DesignDocument');
        const docGraph = parsePayload(docRecord);
        const doc = [...docGraph.objects.values()].find(object => object.className === 'Axure:DesignDocument');
        const sheet = docGraph.objects.get(field(doc.body, 'StyleSheet').value);
        const defaults = docGraph.objects.get(field(sheet.body, 'DefaultStyle').value);
        const docGuids = docGraph.roots.find(node => node.tag === 0x1e).values;
        const styleProperties = structuredClone(field(defaults.body, 'PropList'));
        walkNodes([styleProperties], node => {
          if (![1, 2, 5, 6, 8, 17, 25].includes(node.tag))
            throw new Error(`Unsupported default style value tag ${node.tag}`);
          if (node.tag === 8) Object.assign(node, str(node.text));
          if (node.tag === 17) {
            const guid = docGuids[node.value - 1];
            if (!guid) throw new Error('Default style GUID reference is missing');
            let index = guids.indexOf(guid) + 1;
            if (!index) { guids.push(guid); index = guids.length; }
            node.value = index;
          }
        });
        for (const property of styleProperties.items) {
          const key = field(property, 'DOAName');
          key.value = (key.value & 0x3fffffff) + 0x80000000;
        }
        for (const property of properties) {
          const key = field(property, 'DOAName').value & 0x3fffffff;
          const index = styleProperties.items.findIndex(item => (field(item, 'DOAName').value & 0x3fffffff) === key);
          if (index < 0) throw new Error(`Default style lacks property ${key}`);
          styleProperties.items[index] = property;
        }
        const nativeStyle = graph.objects.get(field(targetWidget.body, 'MyStyle')?.value);
        const style = obj(newGuid(), 'Axure:Style', {
          LibraryId: { tag: 0x11, value: nullId }, LibraryName: str(''), LegacyName: str(''),
          'style-name': str('IxApplyStyle'), Id: { tag: 0x11, value: newGuid() },
          PropList: styleProperties,
          Capabilities: field(nativeStyle?.body ?? {}, 'Capabilities') ?? { tag: 0x1d, value: 'bf7fdeffffeddff5' },
          All: bool(true)
        });
        const styleInfo = info('Axure:InteractionApplyStyleInfo', {
          style: ref(style.id), 'clear-previous': bool(spec.clearPrevious ?? false)
        });
        return obj(newGuid(), 'Axure:InteractionApplyStyle', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          Paths: list([ref(path.id)]), Infos: list([ref(styleInfo.id)])
        });
      }
      case 'refresh-repeater':
        // The preview generator inserts this pseudo action after supported
        // repeater mutations. An explicit .rp action compiles without its
        // required repeatersToRefresh array and crashes at runtime.
        throw new Error('refresh-repeater is an internal pseudo action in Axure RP 11.0.0.4137; use a supported repeater sort, filter, add, delete, or update action, which refreshes automatically');
      case 'set-repeater-items-per-page': {
        const { path, widget: repeater } = paths();
        if (repeater.className !== 'Axure:DiagramObject:Repeater')
          throw new Error('set-repeater-items-per-page target must be a repeater');
        const data = graph.objects.get(field(repeater.body, 'Data')?.value);
        if (!data) throw new Error('Repeater has no dataset scope');
        const noLimit = spec.noLimit === true;
        const count = num(spec.count ?? spec.itemsPerPage ?? 20);
        if (!Number.isInteger(count) || count < 1)
          throw new Error('set-repeater-items-per-page count must be a positive integer');
        const amount = literal(String(count));
        field(amount.body, 'TargetRepeaterScope').value = data.id;
        const perPage = info('Axure:SetItemPerRepeaterPageInfo', {
          'no-limit': bool(noLimit), 'items-per-page': ref(amount.id)
        });
        return obj(newGuid(), 'Axure:InteractionSetItemPerRepeaterPageAction', {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          RepeaterPaths: list([ref(path.id)]), SetItemsPerPageInfos: list([ref(perPage.id)])
        });
      }
      case 'expand-collapse-tree': case 'set-repeater-page':
      case 'set-repeater-dataset': case 'remove-filter': case 'remove-sort': {
        // 中继器相关动作族；类名依程序集元数据 Ix<X>Action -> Axure:Interaction<X>Action 推导
        if (type === 'set-repeater-dataset')
          throw new Error('set-repeater-dataset does not replace a dataset; use set-repeater-items-per-page count=<number> for pagination');
        const { path } = paths();
        const rep = list([ref(path.id)]);
        const wrap = (cls, key, infoObj) => obj(newGuid(), cls, {
          Disabled: bool(false), panelobjectpaths: list([ref(path.id)]),
          RepeaterPaths: rep, [key]: list([ref(infoObj.id)])
        });
        if (type === 'expand-collapse-tree') {
          // Axure UI truth (RP 11.0.0.4137): tree node targets use TreePaths and
          // ExpandCollapseInfos, not the repeater-family fields used below.
          // `target` names the tree widget; optional `node` selects one contained
          // TreeNodeObject by its visible label (required for collapsing a branch).
          const treePath = spec.node === undefined ? path : treeNodePath(targetName, spec.node);
          const treeInfo = info('Axure:ExpandCollapseTreeInfo', { expand: bool(spec.expand !== false) });
          return obj(newGuid(), 'Axure:InteractionExpandCollapseTreeAction', {
            Disabled: bool(false), panelobjectpaths: list([ref(treePath.id)]),
            TreePaths: list([ref(treePath.id)]), ExpandCollapseInfos: list([ref(treeInfo.id)])
          });
        }
        // 真值来源：2026-09-22 通过 C# IL 反编译 + 字符串解密表 (XHwm.tH1a) 直接提取的 100% 精确反序列化字段：
        // 1. RemoveSortFromRepeaterInfo: { 'remove-all': bool, 'label': str }
        //    InteractionRemoveSortFromRepeaterAction: { Disabled, panelobjectpaths, 'repeater-paths', 'remove-sort-infos' }
        // 2. RemoveFilterFromRepeaterInfo: { 'remove-all': bool, 'filter-name': str }
        //    InteractionRemoveFilterFromRepeaterAction: { Disabled, panelobjectpaths, 'repeater-paths', 'remove-filter-infos' }
        if (type === 'remove-sort') {
          const removeAll = !!(spec.removeAll || spec['remove-all']);
          const sortLabel = removeAll ? '' : String(spec.label ?? spec['sort-id'] ?? '');
          if (!removeAll && !sortLabel) throw new Error('remove-sort requires label=<sort label> or removeAll=true');
          const sortInfo = info('Axure:RemoveSortFromRepeaterInfo', {
            'remove-all': bool(removeAll),
            label: str(sortLabel)
          });
          return obj(newGuid(), 'Axure:InteractionRemoveSortFromRepeaterAction', {
            Disabled: bool(false),
            panelobjectpaths: list([ref(path.id)]),
            'repeater-paths': rep,
            'remove-sort-infos': list([ref(sortInfo.id)])
          });
        }
        if (type === 'remove-filter') {
          const removeAll = !!(spec.removeAll || spec['remove-all']);
          const filterName = removeAll ? '' : String(spec.label ?? spec['filter-id'] ?? spec['filter-name'] ?? spec.name ?? '');
          if (!removeAll && !filterName) throw new Error('remove-filter requires label=<filter name> or removeAll=true');
          const filterInfo = info('Axure:RemoveFilterFromRepeaterInfo', {
            'remove-all': bool(removeAll),
            'filter-name': str(filterName)
          });
          return obj(newGuid(), 'Axure:InteractionRemoveFilterFromRepeaterAction', {
            Disabled: bool(false),
            panelobjectpaths: list([ref(path.id)]),
            'repeater-paths': rep,
            'remove-filter-infos': list([ref(filterInfo.id)])
          });
        }
        if (type === 'set-repeater-page') {
          // Exact Axure tutorial sample: action shell has no Disabled field. SetPageType is
          // Value=0, Previous=1, Next=2, Last=3; the page value is a StringLiteral.
          const pageTypes = { value: 0, previous: 1, next: 2, last: 3 };
          const requestedPageType = spec.pageType ?? 'next';
          const namedPageType = typeof requestedPageType === 'string'
            ? pageTypes[requestedPageType.toLowerCase()]
            : undefined;
          const pageType = namedPageType ?? num(requestedPageType);
          if (!Number.isInteger(pageType) || !Object.values(pageTypes).includes(pageType))
            throw new Error('set-repeater-page pageType must be value/0, previous/1, next/2, or last/3');
          const pageInfo = info('Axure:SetRepeaterToPageInfo', {
            'set-page-type': int(pageType), 'page-value': ref(literal(String(spec.page ?? '1')).id)
          });
          return obj(newGuid(), 'Axure:InteractionSetRepeaterToPageAction', {
            panelobjectpaths: list([ref(path.id)]), RepeaterPaths: rep, SetPageInfos: list([ref(pageInfo.id)])
          });
        }
        throw new Error(`Unsupported repeater action: ${type}`);
      }
      case 'link-frame': {
        // 与 link 同构（IxLinkFrameAction : IxLinkAction），区别是作用于内联框架元件
        const target = obj(newGuid(), 'Axure:InteractionTarget', {
          'target-type': int(spec.page ? TARGET_TYPE.page : TARGET_TYPE.url),
          'target-page-id': { tag: 0x13, values: [spec.pageTypeIndex ?? 1, spec.pageGuidIndex ?? nullId] },
          'target-literal': ref(literal(spec.url ?? spec.page).id)
        });
        return obj(newGuid(), 'Axure:InteractionLinkFrameAction',
          { Disabled: bool(false), target: ref(target.id), 'link-type': int(spec.window === 'new' ? 2 : 1) });
      }
      case 'set-adaptive-view': {
        const auto = spec.auto === true || spec.view === 'auto';
        let viewId = nullId;
        if (!auto) {
          if (spec.view === undefined) throw new Error('set-adaptive-view requires view=<name|base> or auto=true');
          const doc = readRecords(file).find(record => record.className === 'Axure:DesignDocument');
          const docGraph = parsePayload(doc);
          const docGuids = docGraph.roots.find(node => node.tag === 0x1e).values;
          const page = [...graph.objects.values()].find(object => object.className === 'Axure:Page');
          const setGuid = guids[field(page.body, 'AdaptiveViewSetId')?.value - 1];
          const sets = [...docGraph.objects.values()].filter(object => object.className === 'Axure:AdaptiveViewSet'
            && docGuids[field(object.body, 'Id')?.value - 1] === setGuid);
          if (sets.length !== 1) throw new Error('Page must have exactly one registered adaptive view set');
          const set = sets[0];
          const views = [field(set.body, 'DefaultAdaptiveView'), ...(field(set.body, 'AdaptiveViews')?.items ?? [])]
            .map(entry => docGraph.objects.get(entry?.value)).filter(Boolean);
          const base = ['base', '基本'].includes(String(spec.view).toLowerCase());
          const matches = base ? [views[0]] : views.filter(view => field(view.body, 'Name')?.text === spec.view);
          if (matches.length !== 1) throw new Error(`Expected exactly one adaptive view named "${spec.view}", found ${matches.length}`);
          const viewGuid = docGuids[field(matches[0].body, 'Id').value - 1];
          viewId = guids.indexOf(viewGuid) + 1;
          if (!viewId) { guids.push(viewGuid); viewId = guids.length; }
        }
        return obj(newGuid(), 'Axure:InteractionSetAdaptiveView', {
          Disabled: bool(false), 'set_adaptive_view_id': { tag: 0x11, value: viewId },
          'set_adaptive_view_to_auto': bool(auto)
        });
      }
      default:
        throw new Error(`Unsupported action type "${type}". Available action names and evidence: references/capabilities.md`);
    }
  };

  // ---- attach to the target's interaction map ----
  const ctx = { widget };
  const mapField = kind === 'widget' ? 'InteractionMap' : 'interactionmap';
  const ownerBody = kind === 'widget' ? widget.body : pageObj.body;
  let mapObj, treeObj, treeId;
  const existing = ownerBody.entries.find(([k]) => k.text === mapField);
  if (existing) {
    mapObj = graph.objects.get(existing[1].value);
    if (!mapObj) throw new Error('Interaction map reference is dangling');
    treeId = field(mapObj.body, 'tree')?.value;
    treeObj = graph.objects.get(treeId);
    if (!treeObj) throw new Error('Interaction tree reference is dangling');
  } else {
    treeId = newGuid();
    treeObj = obj(treeId, 'Axure:Tree', { children: list([]), tree: ref(treeId) });
    const mapId = newGuid();
    mapObj = obj(mapId, 'Axure:InteractionTreeMap',
      { 'node-table': dict([]), tree: ref(treeId), PackageMode: bool(false) });
    const pos = ownerBody.entries.findIndex(([k]) => k.text === 'MyStyle');
    ownerBody.entries.splice(pos < 0 ? ownerBody.entries.length : pos, 0, [str(mapField), ref(mapId)]);
  }
  const nodeTable = field(mapObj.body, 'node-table');
  if (!nodeTable || nodeTable.tag !== 1) throw new Error('Interaction node table is not a dictionary');
  const existingEvents = () => (field(treeObj.body, 'children')?.items ?? []).map(item => {
    const node = graph.objects.get(item.value);
    const entry = nodeTable.entries.find(([key]) => key.value === node?.id);
    const event = entry ? graph.objects.get(entry[1].value) : undefined;
    return node && event?.className === 'Axure:InteractionEvent'
      ? { node, event, eventType: field(event.body, 'event-type')?.value }
      : undefined;
  }).filter(Boolean);

  const added = [];
  const replaceSeenTypes = new Set();
  for (const ix of interactions) {
    const eventName = ix.event ?? ix.on ?? 'OnClick';
    let eventType = EVENTS[eventName] !== undefined ? EVENTS[eventName] : pick(EVENTS, eventName, 'event');
    if (eventType === undefined) throw new Error(`Unknown event "${eventName}"`);
    // 事件也有版本差异：名字在 EVENTS 表里不等于目标版本认得它。
    // 依据两版**预览运行时** JS 的事件名逐名对比（patch/event-version-audit.mjs）：
    //   RP 11 运行时有 onErrorSet/onErrorRemoved/onBeforeItemLoad，RP 9 运行时全无；
    //   旁证：RP 9 程序集字符串里 `OnErrorSet`/`OnErrorRemoved`/`error-state` 一个都没有。
    if (targetVersion === 9 && RP11_ONLY_EVENTS[eventName] !== undefined)
      throw new Error(`Event "${eventName}" (event-type ${RP11_ONLY_EVENTS[eventName]}) is RP 11-only; Axure RP 9 does not provide it`);
    // ⚠️ 页面级「载入时」必须用 OnLoad(288)，不能用 OnPageLoad(320)：
    // Axure 预览运行时的页面加载分发（events.js loadDynamicPanelsAndMasters →
    // fireEventThroughContainers('onLoad')）只产生 'onLoad' key；生成器把 320 写成
    // 'onPageLoad' key，运行时永远查不到 → 页面级载入交互被静默吞掉（2026-09-22 实测：
    // 288 的 hide 动作在预览加载时正常执行，320 的无任何反应）。
    // widget 上的载入事件仍按原名表（OnPageLoad 320 保持原值，勿动）。
    if (pageOnly && eventType === EVENTS.OnPageLoad) eventType = EVENTS.OnLoad;
    const cases = ix.cases ?? [{
      when: ix.when,
      else: ix.else,
      elseIf: ix.elseIf,
      description: ix.description,
      actions: ix.actions ?? []
    }];
    if (!cases.length) throw new Error(`Interaction "${eventName}" has no cases`);

    let replaceTarget;
    if (replaceEvent) {
      if (replaceSeenTypes.has(eventType)) throw new Error(`Cannot replace event type ${eventType} more than once in a single request`);
      replaceSeenTypes.add(eventType);
      const matches = existingEvents().filter(item => item.eventType === eventType);
      if (matches.length > 1) throw new Error(`Cannot replace ${eventName}: found ${matches.length} existing events of type ${eventType}`);
      replaceTarget = matches[0];
    }
    const eventNodeId = replaceTarget?.node.id ?? newGuid();
    const eventId = replaceTarget?.event.id ?? newGuid();
    const caseNodeIds = [];

    if (replaceTarget) {
      const oldNodeIds = new Set();
      const collectDescendants = node => {
        for (const child of field(node?.body ?? {}, 'children')?.items ?? []) {
          const childNode = graph.objects.get(child.value);
          if (!childNode || oldNodeIds.has(childNode.id)) continue;
          oldNodeIds.add(childNode.id);
          collectDescendants(childNode);
        }
      };
      collectDescendants(replaceTarget.node);
      nodeTable.entries = nodeTable.entries.filter(([key]) => !oldNodeIds.has(key.value));
      if (ix.disabled !== undefined) {
        const disabled = field(replaceTarget.event.body, 'Disabled');
        if (disabled) disabled.value = !!ix.disabled;
      }
    } else {
      obj(eventId, 'Axure:InteractionEvent', {
        Disabled: bool(ix.disabled), 'event-type': int(eventType),
        'master-containing-raised-event': { tag: 0x10, values: [0, nullId] },
        'raised-event-id': { tag: 0x11, value: nullId }, 'variable-id': { tag: 0x11, value: nullId }
      });
      nodeTable.entries.push([ref(eventNodeId), ref(eventId)]);
    }

    for (const c of cases) {
      const actionSpecs = c.actions ?? [];
      const caseNodeId = newGuid(), caseId = newGuid();
      caseNodeIds.push(caseNodeId);
      const actionNodeIds = actionSpecs.map(() => newGuid());

      obj(caseNodeId, 'Axure:Node', { children: list(actionNodeIds.map(id => ref(id))), 'parent-node': ref(eventNodeId), tree: ref(treeId) });
      for (const id of actionNodeIds) obj(id, 'Axure:Node', { children: list([]), 'parent-node': ref(caseNodeId), tree: ref(treeId) });

      if (c.when !== undefined) {
        if (c.when === null || typeof c.when !== 'object') throw new Error('Condition "when" must be a non-null object');
      }
      const condRef = c.when !== undefined ? ref(buildCondition(c.when).id) : ref(nullId);
      obj(caseId, 'Axure:InteractionCase', {
        Disabled: bool(false), Description: str(c.description ?? ''),
        Condition: condRef, IsNewIfGroup: bool(!!c.isNewIfGroup)
      });
      const actionIds = actionSpecs.map(spec => build(spec, ctx).id);
      nodeTable.entries.push([ref(caseNodeId), ref(caseId)]);
      actionIds.forEach((id, i) => nodeTable.entries.push([ref(actionNodeIds[i]), ref(id)]));
    }

    if (!replaceTarget) {
      obj(eventNodeId, 'Axure:Node', { children: list(caseNodeIds.map(id => ref(id))), 'parent-node': ref(treeId), tree: ref(treeId) });
      field(treeObj.body, 'children').items.push(ref(eventNodeId));
    } else {
      field(replaceTarget.node.body, 'children').items = caseNodeIds.map(id => ref(id));
    }
    added.push({ event: eventName, eventType, replaced: !!replaceTarget, cases: cases.map(c => ({ description: c.description, actions: (c.actions ?? []).map(s => s.type) })) });
  }

  // ---- 版本字段适配（共享实现，见 version-adapt.mjs）----
  adaptNodesForVersion(defs, { version: targetVersion, str, log: m => versionAdaptations.push(m) });

  graph.roots.splice(graph.roots.length - 1, 0, ...defs);
  const raw = encodeRecord(r, strings, encodePayload(graph.roots));
  return {
    file: replaceRecord(file, r, raw),
    report: {
      target: kind === 'widget' ? `widget:${widgetName}` : `page:${pageName}`,
      record: r.index, version: targetVersion, addedObjects: defs.length,
      addedStrings: strings.length - r.strings.length,
      versionAdaptations: [...new Set(versionAdaptations)],
      interactions: added
    }
  };
}
