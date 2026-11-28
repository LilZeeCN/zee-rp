// 净室原生控件合成器：不依赖本机安装的 Axure 教学工程（RP9 Tour.rp / Quick Win.rp）与 Default.rplib，
// 直接在内存中构建与原厂等价的 DynamicPanel / PanelState（RP9 & RP11）、Repeater 与 5 类原生表单控件。
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { defaultStyleProperties, defaultStyleValues } from './blank-synthesizer.mjs';
import { cloneInto, closureOf } from './clone-closure.mjs';
import { guidKey } from './duplicate-page.mjs';
import { assertNotProtected } from './engine.mjs';
import { encodePayload, field, parsePayload } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { encodeRecord, parseRecord, readRecords, replaceRecord } from './rp-records.mjs';
import { detectFileVersion, resolveTargetVersion } from './version.mjs';

const ZERO_GUID = '0'.repeat(32);
const newGuid = () => guidKey(randomUUID().replaceAll('-', ''));

function buildRecordObject(version, className, buildFn) {
  const strings = [];
  const textIndex = new Map();
  const str = value => {
    const text = String(value);
    if (!textIndex.has(text)) textIndex.set(text, strings.push(text));
    return { tag: 8, value: textIndex.get(text), text };
  };
  const int = value => ({ tag: 5, value });
  const num = value => ({ tag: 6, value });
  const bool = value => ({ tag: 0x19, value: Boolean(value) });
  const ref = value => ({ tag: 3, value });
  const guid = value => ({ tag: 0x11, value });
  const id22 = value => ({ tag: 0x16, value });
  const caps = value => ({ tag: 0x1d, value });
  const list = (items = []) => ({ tag: 2, items });
  const dict = (entries = []) => ({ tag: 1, entries });
  const fields = obj => dict(Object.entries(obj).map(([k, v]) => [str(k), v]));
  const object = (id, type, values) => ({
    tag: 9,
    id,
    classIndex: str(`Axure:${type}`).value,
    body: fields(values),
  });
  const solid = argb => fields({ 'fill-type': str('solid'), 'fill-color': int(argb) });
  const propEntry = (doaCode, Value, enabled = true) => fields({
    DOAName: int((enabled ? 0xc0000000 : 0x80000000) + doaCode),
    Value,
  });

  str(`Axure:${className}`);
  const guids = [newGuid(), newGuid(), ZERO_GUID];
  const objects = buildFn({
    str, string: str, int, num, bool, ref, guid, id22, caps, list, dict, fields, object, solid, propEntry, guids,
  });

  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x1b, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(version === 9 ? 1 : 0, 12);
  header.writeUInt32LE(0xc351, 20);
  header.writeUInt32LE(31, 24);
  const raw = encodeRecord({ raw: header }, strings, encodePayload([
    { tag: 0x1e, values: guids },
    { tag: 0x1a },
    { tag: 0xf, value: 1 },
    { tag: 0x12, value: 2 },
    ...objects,
    { tag: 0x1c },
  ]));
  return { index: 0, offset: 0, compressedSize: 0, raw, ...parseRecord(raw) };
}

function reserveGuids(guids, count) {
  while (guids.length < count) guids.push(newGuid());
}

/**
 * 合成干净的 DynamicPanel 原型模板对象图与空白 PanelState 记录（同时支持 RP9 与 RP11）。
 */
export function synthesizeDynamicPanelTemplate(version = 9) {
  const target = resolveTargetVersion(version);
  const is11 = target === 11;

  const pageRec = buildRecordObject(target, 'Page', context => {
    const { str, int, num, bool, ref, guid, caps, list, fields, object, propEntry, guids } = context;
    // id=1: Page, id=2: Diagram, id=3: ZERO_GUID 哨兵, id=4: DynamicPanel, id=5: MyStyle, slot 6: Style.Id GUID
    reserveGuids(guids, 6);
    const panelBody = {
      'name-block': fields({
        '*type': str('text-block'),
        text: str('Panel Template'),
        'property-dictionary': fields({
          type: str('label'),
          'diagram-object-id': guid(4),
          'parent-diagram-id': guid(2),
        }),
      }),
      tooltip: str(''),
      IsContained: bool(false),
      IsLocked: bool(false),
      SelectedStyleGroup: str(''),
      MyStyle: ref(5),
      AdaptiveStyles: list(),
      SubmitButton: ref(3),
      Disabled: bool(false),
      Selected: bool(false),
      ...(is11 && { Error: bool(false) }),
      VisibleFromSettings: bool(true),
      'panel-diagrams': list(),
      scrollbars: int(0),
      'is-fixed': bool(false),
      'horizontal-pin-alignment': int(0),
      'vertical-pin-alignment': int(0),
      'horizontal-pin-margin': num(0),
      'vertical-pin-margin': num(0),
      'keep-pinned-in-front': bool(true),
      'fit-to-content': bool(false),
      'propagate-styles': bool(false),
      'is-percent-width': bool(false),
      ...(is11 && { ExpandedOnOutlineTreeView: bool(true) }),
    };
    const styleProps = list([
      propEntry(101, fields({ X: num(0), Y: num(0) })),
      propEntry(105, fields({ Width: num(300), Height: num(200) })),
    ]);
    return [
      object(1, 'Page', { diagram: ref(2) }),
      object(2, 'Diagram', { 'diagram-objects': list([ref(4)]) }),
      object(4, 'DiagramObject:DynamicPanel', panelBody),
      object(5, 'Style', {
        LibraryId: guid(3),
        LibraryName: str(''),
        LegacyName: str(''),
        'style-name': str('MyStyle-Axure:DiagramObject:DynamicPanel'),
        Id: guid(6),
        PropList: styleProps,
        Capabilities: caps(is11 ? '0000001c00200000' : '0000000000080000'),
        All: bool(false),
      }),
    ];
  });

  const stateRecord = buildRecordObject(target, 'PanelState', context => {
    const { str, int, bool, ref, guid, id22, caps, list, dict, fields, object, guids } = context;
    // slot 1: stateObj, slot 2: PanelDiagram (packageGuid), slot 3: ZERO_GUID,
    // slot 4..8: objects, slot 9: Default style GUID, slot 10: Typeface GUID
    reserveGuids(guids, 10);
    const styleInfo = fields({
      LibraryId: guid(3),
      LibraryName: str(''),
      Id: guid(9),
      Name: str('Default'),
    });
    return [
      object(1, 'PanelState', {
        AdaptiveViewSetId: guid(3),
        AdaptiveViewSet: ref(3),
        diagram: ref(2),
        'page-style': ref(4),
        AdaptiveStyles: list(),
        AdaptiveViewMatchInfos: list(),
        annotation: ref(5),
        interactionmap: ref(6),
        StyleCache: fields({
          Styles: list([fields({ Info: styleInfo, Props: defaultStyleProperties(target, context, 9, 10) })]),
          TypefaceToFullName: list(),
          TypefaceToCssName: list(),
        }),
        HackLegacyContainedObjects2: bool(true),
      }),
      object(2, 'PanelDiagram', {
        'diagram-objects': list(),
        'ruler-guide-set': ref(7),
        GroupsClean3: bool(true),
        Name: str('State 1'),
        PanelDiagramStyle: ref(4),
        AdaptivePanelDiagramStyles: list(),
        ...(is11 && { ExpandedOnOutlineTreeView: bool(true) }),
      }),
      object(4, 'PanelDiagramStyle', {
        'BaseStyle.Name': str(''),
        'style-name': str(is11 ? 'MyPageStyle' : ''),
        Id: guid(4),
        PropList: list(),
        Capabilities: caps('ffffffffffffffff'),
        All: bool(false),
      }),
      object(5, 'Annotation', {
        'property-name-id-to-value': dict(),
        'property-name-id-to-name-text': dict(),
        'annotation-field-set-type': str('PageFragment'),
        OwnerId: id22(3),
        StaticFields: int(0),
      }),
      object(6, 'InteractionTreeMap', {
        'node-table': dict(),
        tree: ref(8),
        PackageMode: bool(false),
      }),
      object(8, 'Tree', {
        children: list(),
        tree: ref(8),
      }),
      object(7, 'RulerGuideSet', { 'ruler-guides': list() }),
    ];
  });

  const templateGraph = parsePayload(pageRec);
  const templateWidget = templateGraph.objects.get(4);
  return { templateRecord: pageRec, templateGraph, templateWidget, stateRecord };
}

/**
 * 合成干净的 RP9 Repeater 原型壳对象图（替代对 Default.rplib 中 Repeater 模板页的扫描）。
 */
export function synthesizeRepeaterTemplate() {
  const sourceRecord = buildRecordObject(9, 'Page', context => {
    const { str, int, num, bool, ref, guid, caps, list, dict, fields, object, solid, propEntry, guids } = context;
    // id=1: Page, id=2: Diagram, id=3: ZERO_GUID, id=4: Repeater, id=5: MyStyle,
    // id=6: RepeatableDiagram, id=7: DataSet, id=8: RepeaterStyle, id=9: RulerGuideSet, slot 10..11: Style Ids
    reserveGuids(guids, 11);
    const repeaterStyleProps = list([
      propEntry(1200, int(0xffffffff)),
      propEntry(1201, bool(true)),
      propEntry(1202, num(0)),
      propEntry(1203, num(0)),
      propEntry(11, num(0)),
      propEntry(12, num(0)),
      propEntry(13, num(0)),
      propEntry(14, num(0)),
      propEntry(1208, int(0xffffffff)),
      propEntry(1209, int(1)),
      propEntry(1210, bool(true)),
      propEntry(1204, solid(0x00ffffff)),
      propEntry(1205, bool(false)),
      propEntry(1206, solid(0x00ffffff)),
    ]);
    return [
      object(1, 'Page', { diagram: ref(2) }),
      object(2, 'Diagram', { 'diagram-objects': list([ref(4)]) }),
      object(4, 'DiagramObject:Repeater', {
        'name-block': fields({
          '*type': str('text-block'),
          text: str('Repeater Template'),
          'property-dictionary': fields({
            type: str('label'),
            'diagram-object-id': guid(4),
            'parent-diagram-id': guid(2),
          }),
        }),
        tooltip: str(''),
        IsContained: bool(false),
        IsLocked: bool(false),
        SelectedStyleGroup: str(''),
        MyStyle: ref(5),
        AdaptiveStyles: list(),
        SubmitButton: ref(3),
        Disabled: bool(false),
        Selected: bool(false),
        VisibleFromSettings: bool(true),
        BaseDiagram: ref(6),
        Data: ref(7),
        RepeaterStyle: ref(8),
        AdaptiveRepeaterStyles: list(),
        FitToContent: bool(true),
        IsolateRadioGroups: bool(true),
        IsolateSelectionGroups: bool(true),
      }),
      object(5, 'Style', {
        LibraryId: guid(3),
        LibraryName: str(''),
        LegacyName: str(''),
        'style-name': str('MyStyle-Axure:DiagramObject:Repeater'),
        Id: guid(10),
        PropList: list([
          propEntry(101, fields({ X: num(100), Y: num(100) })),
          propEntry(105, fields({ Width: num(250), Height: num(150) })),
        ]),
        Capabilities: caps('0000000000080000'),
        All: bool(false),
      }),
      object(6, 'RepeatableDiagram', {
        'diagram-objects': list(),
        'ruler-guide-set': ref(9),
        GroupsClean3: bool(true),
        Name: str(''),
      }),
      object(9, 'RulerGuideSet', { 'ruler-guides': list() }),
      object(7, 'DocumentModel:DataSet', {
        'parent-data': ref(3),
        'obj-to-repeats': dict(),
        columns: list(),
        rows: list(),
      }),
      object(8, 'RepeaterStyle', {
        'style-name': str(''),
        Id: guid(11),
        PropList: repeaterStyleProps,
        Capabilities: caps('ffffffffffffffff'),
        All: bool(false),
      }),
    ];
  });
  const sourceGraph = parsePayload(sourceRecord);
  const repeater = sourceGraph.objects.get(4);
  return { sourceRecord, sourceGraph, repeater };
}

const FORM_SPECS = {
  input: {
    sourcePage: 'Text Field',
    className: 'Axure:DiagramObject:TextBox',
    caps: '9f8f777f0bbfa132',
    defaultW: 300,
    defaultH: 25,
  },
  textarea: {
    sourcePage: 'Text Area',
    className: 'Axure:DiagramObject:TextArea',
    caps: '9f8f777f0bbfa132',
    defaultW: 300,
    defaultH: 170,
  },
  radio: {
    sourcePage: 'Radio Button',
    className: 'Axure:DiagramObject:RadioButton',
    caps: 'bfff77ff1f7bec33',
    defaultW: 100,
    defaultH: 15,
    defaultText: 'Radio Button',
  },
  checkbox: {
    sourcePage: 'Checkbox',
    className: 'Axure:DiagramObject:Checkbox',
    caps: 'bfff77ff1f7bec33',
    defaultW: 100,
    defaultH: 15,
    defaultText: 'Checkbox',
  },
  combobox: {
    sourcePage: 'Droplist',
    className: 'Axure:DiagramObject:ComboBox',
    caps: '9f8d777f0bbba130',
    defaultW: 300,
    defaultH: 22,
  },
  listbox: {
    sourcePage: 'List Box',
    className: 'Axure:DiagramObject:ListBox',
    caps: '9f8d777f0bbba130',
    defaultW: 300,
    defaultH: 170,
  },
};

const FORM_KIND_ALIASES = {
  'text field': 'input',
  'text area': 'textarea',
  'radio button': 'radio',
  checkbox: 'checkbox',
  droplist: 'combobox',
  'list box': 'listbox',
  input: 'input',
  textarea: 'textarea',
  radio: 'radio',
  combobox: 'combobox',
  listbox: 'listbox',
};

function checkedStyleProperties(values, context) {
  const { fields, int } = context;
  return {
    tag: 2,
    items: Object.entries(values).map(([id, Value]) => fields({
      DOAName: int(0xc0000000 + Number(id)),
      Value,
    })),
  };
}

function buildStateStyleObject(context, objectId, styleGuidSlot, typefaceGuidSlot, name, propEntries) {
  const { str, bool, guid, caps, object, fields, int } = context;
  const baseMap = defaultStyleValues(9, context, styleGuidSlot, typefaceGuidSlot);
  const propList = {
    tag: 2,
    items: Object.entries(baseMap).map(([id, Value]) => {
      const hasOverride = Object.hasOwn(propEntries, Number(id));
      return fields({
        DOAName: int((hasOverride ? 0xc0000000 : 0x80000000) + Number(id)),
        Value: hasOverride ? propEntries[Number(id)] : Value,
      });
    }),
  };
  return object(objectId, 'Style', {
    LibraryId: guid(3),
    LibraryName: str(''),
    LegacyName: str(''),
    'style-name': str(name),
    Id: guid(styleGuidSlot),
    PropList: propList,
    Capabilities: caps('ffffffffffffffff'),
    All: bool(false),
  });
}

/**
 * 合成单个干净的 RP9 原生表单控件对象图模板，供 cloneInto 注入任意页面。
 */
export function synthesizeFormTemplate(kindOrPageName) {
  const normalized = FORM_KIND_ALIASES[String(kindOrPageName || '').toLowerCase()];
  const spec = normalized ? FORM_SPECS[normalized] : null;
  if (!spec) throw new Error(`Unsupported native form kind: ${kindOrPageName}`);

  const sourceRecord = buildRecordObject(9, 'Page', context => {
    const { str, int, num, bool, ref, guid, caps, list, fields, object, solid, guids } = context;
    // 1=Page, 2=Diagram, 3=ZERO_GUID, 4=Widget, 5=MyStyle, 6=DisabledStyle, 7=HintStyle(optional)
    // 8=MyStyle.Id, 9=Disabled.Id, 10=Hint.Id, 11=TypefaceGuid
    reserveGuids(guids, 11);

    const stateMapEntries = { Disabled: ref(6) };
    if (normalized === 'input' || normalized === 'textarea') stateMapEntries.Hint = ref(7);

    const styleEnabled = {
      101: fields({ X: num(100), Y: num(100) }),
      105: fields({ Width: num(spec.defaultW), Height: num(spec.defaultH) }),
      21: fields(stateMapEntries),
    };
    if (normalized === 'input') {
      styleEnabled[6] = solid(0xff000000);
      styleEnabled[9] = int(0);
      styleEnabled[10] = int(1);
    } else if (normalized === 'textarea') {
      styleEnabled[6] = solid(0xff000000);
      styleEnabled[9] = int(0);
      styleEnabled[10] = int(0);
    } else if (normalized === 'radio' || normalized === 'checkbox') {
      styleEnabled[12] = num(0);
      styleEnabled[14] = num(0);
      styleEnabled[10] = int(1);
    } else {
      styleEnabled[6] = solid(0xff000000);
      styleEnabled[9] = int(0);
      styleEnabled[10] = int(0);
    }

    const commonWidget = {
      'name-block': fields({
        '*type': str('text-block'),
        text: str(''),
        'property-dictionary': fields({
          type: str('label'),
          'diagram-object-id': guid(4),
          'parent-diagram-id': guid(2),
        }),
      }),
      tooltip: str(''),
      IsContained: bool(false),
      IsLocked: bool(false),
      SelectedStyleGroup: str(''),
      MyStyle: ref(5),
      AdaptiveStyles: list(),
      SubmitButton: ref(3),
      Disabled: bool(false),
      Selected: bool(false),
      VisibleFromSettings: bool(true),
    };

    const richTextBlock = text => fields({
      '*type': str('rich-text-block'),
      'attributed-string': fields({
        Version: fields({ Major: int(9), Minor: int(0), Build: int(1), Revision: int(0) }),
        Paragraphs: list([fields({
          HorizontalAlignment: int(0),
          LineSpacing: num(0),
          ListInfo: fields({ IndentLevel: int(0), ListType: int(0) }),
          Inlines: list([fields({
            Type: str('Axure:AttributedString:AxRun'),
            Text: str(text),
            Family: str('Arial'),
            Size: num(9.75),
            Weight: int(400),
            Style: int(0),
            Stretch: int(5),
            Underline: bool(false),
            Color: int(0xff333333),
            Baseline: int(0),
            CharacterSpacing: num(0),
            Strikethrough: bool(false),
          })]),
        })]),
      }),
      'property-dictionary': fields({
        type: str('rich-text-object'),
        'diagram-object-label': str(''),
        'text-object-id': guid(4),
        'parent-diagram-id': guid(2),
      }),
    });

    const plainTextBlock = fields({
      '*type': str('text-block'),
      text: str(''),
      'property-dictionary': fields({
        type: str('plain-text-object'),
        'diagram-object-label': str(''),
        'text-object-id': guid(4),
        'parent-diagram-id': guid(2),
      }),
    });

    let widgetBody;
    if (normalized === 'input') {
      widgetBody = {
        ...commonWidget,
        TextBlock: plainTextBlock,
        WordWrap: bool(false),
        ReadOnly: bool(false),
        PlaceholderText: str(''),
        HideHintOnFocus: bool(false),
        Type: int(0),
        MaxLength: int(2147483647),
      };
    } else if (normalized === 'textarea') {
      widgetBody = {
        ...commonWidget,
        TextBlock: plainTextBlock,
        WordWrap: bool(true),
        ReadOnly: bool(false),
        PlaceholderText: str(''),
        HideHintOnFocus: bool(false),
        Type: int(0),
      };
    } else if (normalized === 'radio') {
      widgetBody = {
        ...commonWidget,
        RichTextBlock: richTextBlock(spec.defaultText),
        AutoFitHeight: bool(false),
        AutoFitWidth: bool(false),
        'align-selection-button-right': str('False'),
        'radio-group': str(''),
      };
    } else if (normalized === 'checkbox') {
      widgetBody = {
        ...commonWidget,
        RichTextBlock: richTextBlock(spec.defaultText),
        AutoFitHeight: bool(false),
        AutoFitWidth: bool(false),
        'align-selection-button-right': str('False'),
      };
    } else {
      widgetBody = {
        ...commonWidget,
        TextBlock: plainTextBlock,
        WordWrap: bool(true),
        ReadOnly: bool(false),
        PlaceholderText: str(''),
        HideHintOnFocus: bool(false),
        Type: int(0),
        multiple: bool(false),
        'list-options': list(),
      };
    }

    const typeSuffix = spec.className.slice('Axure:'.length);
    const out = [
      object(1, 'Page', { diagram: ref(2) }),
      object(2, 'Diagram', { 'diagram-objects': list([ref(4)]) }),
      object(4, typeSuffix, widgetBody),
      object(5, 'Style', {
        LibraryId: guid(3),
        LibraryName: str(''),
        LegacyName: str(''),
        'style-name': str(`MyStyle-${spec.className}`),
        Id: guid(8),
        PropList: checkedStyleProperties(styleEnabled, context),
        Capabilities: caps(spec.caps),
        All: bool(false),
      }),
      buildStateStyleObject(context, 6, 9, 11, 'Disabled', { 7: solid(0xfff0f0f0) }),
    ];
    if (normalized === 'input' || normalized === 'textarea') {
      out.push(buildStateStyleObject(context, 7, 10, 11, 'Hint', { 6: solid(0xff999999) }));
    }
    return out;
  });

  const sourceGraph = parsePayload(sourceRecord);
  return { sourceRecord, sourceGraph, widgetId: 4, spec, kind: normalized };
}

/**
 * 免模板将指定原生表单控件写入目标 RP9 工程页面，返回与 cloneLibraryWidget 对齐的结果对象。
 */
export function synthesizeNativeFormWidget(targetFile, outputFile, {
  kind,
  targetPageName = 'Page 1',
  name,
  x,
  y,
  width,
  height,
  inputStyle,
  placeholder,
  maxLength,
}) {
  if (!kind || !targetPageName || !name) {
    throw new Error('kind, targetPageName, and name are required');
  }
  assertNotProtected(targetFile);
  assertNotProtected(outputFile);

  let output = readFileSync(targetFile);
  if (detectFileVersion(output) !== 9) {
    throw new Error('Native form controls require RP 9');
  }
  const targetSummary = readRp(output, { path: targetFile });
  const matchingPages = targetSummary.pages.filter(p => p.name === targetPageName);
  if (matchingPages.length !== 1) {
    throw new Error(`Target page "${targetPageName}" must be unique; found ${matchingPages.length}`);
  }
  const targetPageMeta = matchingPages[0];
  const { sourceRecord, sourceGraph, widgetId, spec } = synthesizeFormTemplate(kind);
  const targetRecords = readRecords(output);
  const targetPage = targetRecords.find(r => r.index === targetPageMeta.record && r.className === 'Axure:Page');
  const targetGraph = parsePayload(targetPage);
  const targetStrings = [...targetPage.strings];
  const targetPageObject = [...targetGraph.objects.values()].find(o => o.className === 'Axure:Page');
  const diagram = targetGraph.objects.get(field(targetPageObject.body, 'diagram').value);

  const closure = closureOf(sourceGraph, widgetId);
  const clone = cloneInto({
    version: 9,
    srcGraph: sourceGraph,
    srcStrings: sourceRecord.strings,
    dstGraph: targetGraph,
    dstStrings: targetStrings,
    closure,
    rootOldId: widgetId,
  });

  const widget = targetGraph.objects.get(clone.rootNewId);
  const nameNode = field(field(widget.body, 'name-block') ?? {}, 'text');
  if (!nameNode) throw new Error(`${widget.className} has no name-block text`);
  const intern = text => {
    let idx = targetStrings.indexOf(text);
    if (idx < 0) { idx = targetStrings.length; targetStrings.push(text); }
    return { tag: 8, value: idx + 1, text };
  };
  Object.assign(nameNode, intern(name));

  const geometry = {
    x: x ?? 100,
    y: y ?? 100,
    width: width ?? spec.defaultW,
    height: height ?? spec.defaultH,
  };
  const style = targetGraph.objects.get(field(widget.body, 'MyStyle').value);
  for (const item of field(style.body, 'PropList').items) {
    const prop = field(item, 'DOAName')?.value;
    const val = field(item, 'Value');
    if (prop === 3221225573) {
      field(val, 'X').value = geometry.x;
      field(val, 'Y').value = geometry.y;
    } else if (prop === 3221225577) {
      field(val, 'Width').value = geometry.width;
      field(val, 'Height').value = geometry.height;
    }
  }

  if (maxLength !== undefined) {
    if (widget.className !== 'Axure:DiagramObject:TextBox'
        || !Number.isInteger(maxLength) || maxLength < 0 || maxLength > 2147483647) {
      throw new Error('maxLength requires a TextBox and a nonnegative 32-bit integer');
    }
    const entry = field(widget.body, 'MaxLength');
    const val = { tag: 5, value: maxLength };
    if (entry) Object.assign(entry, val);
    else widget.body.entries.push([intern('MaxLength'), val]);
  }

  if (inputStyle) {
    if (widget.className !== 'Axure:DiagramObject:TextBox') throw new Error('inputStyle requires a TextBox');
    const map = obj => ({ tag: 1, entries: Object.entries(obj).map(([k, v]) => [intern(k), v]) });
    const num = value => ({ tag: 6, value });
    const int = value => ({ tag: 5, value });
    const props = field(style.body, 'PropList').items;
    const put = (key, value) => {
      const item = map({ DOAName: int(0xc0000000 + key), Value: value });
      const idx = props.findIndex(p => (field(p, 'DOAName').value & 0x3fffffff) === key);
      if (idx < 0) props.push(item);
      else props[idx] = item;
    };
    const paint = argb => map({ 'fill-type': intern('solid'), 'fill-color': int(argb) });
    put(7, paint(0));
    put(8, paint(0));
    put(15, num(0));
    put(80, int(0));
    put(1, intern('Inter'));
    put(2, num(inputStyle.fontSize * 0.75));
    put(1001, int(inputStyle.fontWeight));
    const hex = inputStyle.color === 'transparent' ? '00000000' : inputStyle.color.replace('#', '');
    put(6, paint(parseInt((hex.length === 8 ? hex.slice(6) : 'ff') + hex.slice(0, 6), 16)));
    put(9, int({ left: 0, center: 1, right: 2 }[inputStyle.align]));
    put(11, num(inputStyle.textPaddingX));
    put(13, num(inputStyle.textPaddingX));
    put(12, num(0));
    put(14, num(0));
    if (inputStyle.rotation !== undefined) put(50, num(inputStyle.rotation));
    Object.assign(field(widget.body, 'PlaceholderText'), intern(placeholder ?? ''));
  }

  field(diagram.body, 'diagram-objects').items.push({ tag: 3, value: widget.id });
  targetGraph.roots.splice(targetGraph.roots.length - 1, 0, ...clone.created);
  const pageRaw = encodeRecord(targetPage, targetStrings, encodePayload(targetGraph.roots));
  output = replaceRecord(output, targetPage, pageRaw);
  writeFileSync(outputFile, output, { flag: 'wx' });
  return {
    outputFile,
    sourcePage: spec.sourcePage,
    targetPage: targetPageName,
    type: widget.className,
    name,
    id: widget.id,
    geometry,
    closureObjects: clone.created.length,
  };
}
