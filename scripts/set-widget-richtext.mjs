// Replace a native RichTextBlock's paragraphs and runs, retaining its identity.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { cloneInto, closureOf } from './clone-closure.mjs';

const unique = (items, label) => {
  if (items.length !== 1) throw new Error(`${label} must be unique; found ${items.length}`);
  return items[0];
};
export const STYLE_FIELDS = {
  fontFamily: ['Family', 8], size: ['Size', 6], bold: ['Weight', 5], italic: ['Style', 5],
  underline: ['Underline', 25], strikethrough: ['Strikethrough', 25], color: ['Color', 5],
  // Full-range native run keys (Axvg enums): weight 100..950, style 0=Normal/1=Oblique/2=Italic,
  // stretch 0..9 (5=Normal). characterSpacing is the serialized f64; baseline is the serialized
  // integer (native key names Baseline/CharacterSpacing/Stretch per the Run serializer wXjs).
  weight: ['Weight', 5], style: ['Style', 5], stretch: ['Stretch', 5],
  characterSpacing: ['CharacterSpacing', 6], baseline: ['Baseline', 5]
};

// Validate and encode one style entry; shared with set-native-table.mjs multi-run cells.
export function encodeStyleEntry(key, value) {
  if (!STYLE_FIELDS[key]) throw new Error(`Unknown rich text style ${key}`);
  let encoded = value;
  if (key === 'fontFamily' && (typeof value !== 'string' || !value)) throw new Error('fontFamily must be a nonempty string');
  if (key === 'size' && (!Number.isFinite(value) || value <= 0)) throw new Error('size must be positive');
  if (key === 'weight' && (!Number.isInteger(value) || value < 100 || value > 950)) throw new Error('weight must be an integer 100-950');
  if (key === 'style' && (!Number.isInteger(value) || value < 0 || value > 2)) throw new Error('style must be 0 (normal), 1 (oblique) or 2 (italic)');
  if (key === 'stretch' && (!Number.isInteger(value) || value < 0 || value > 9)) throw new Error('stretch must be an integer 0-9 (5 is normal)');
  if (key === 'characterSpacing' && !Number.isFinite(value)) throw new Error('characterSpacing must be a finite number');
  if (key === 'baseline' && !Number.isInteger(value)) throw new Error('baseline must be an integer');
  if (['bold', 'italic', 'underline', 'strikethrough'].includes(key)) {
    if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    if (key === 'bold') encoded = value ? 700 : 400;
    if (key === 'italic') encoded = value ? 1 : 0;
  }
  if (key === 'color') {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('color must be #RRGGBB');
    encoded = Number.parseInt(`ff${value.slice(1)}`, 16);
  }
  return { field: STYLE_FIELDS[key][0], tag: STYLE_FIELDS[key][1], value: encoded };
}

export function setWidgetRichText(input, spec) {
  const records = readRecords(input);
  let recordIndex = spec.record, widgetId = spec.widgetId;
  if (recordIndex === undefined) {
    const page = unique(readRp(input).pages.filter(p => p.name === spec.page), `Page ${spec.page}`);
    const widget = unique(page.widgets.filter(w => w.name === spec.widget), `Widget ${spec.widget}`);
    recordIndex = page.record; widgetId = widget.id;
  }
  const record = records.find(r => r.index === Number(recordIndex) && ['Axure:Page', 'Axure:PanelState'].includes(r.className));
  if (!record) throw new Error(`Editable Page/PanelState record ${recordIndex} not found`);
  const graph = parsePayload(record), widget = graph.objects.get(Number(widgetId));
  if (!widget?.className.startsWith('Axure:DiagramObject:')) throw new Error(`Widget ${widgetId} not found`);
  let block = field(widget.body, 'RichTextBlock');
  if (block?.tag === 3) block = graph.objects.get(block.value)?.body;
  const attributed = field(block ?? {}, 'attributed-string');
  const paragraphs = field(attributed ?? {}, 'Paragraphs');
  if (!paragraphs?.items?.length) throw new Error('Target needs an existing native RichTextBlock with paragraph/run templates');
  const sourceParagraphs = paragraphs.items;
  const paragraphTemplate = paragraphs.items[0];
  const sourceInlines = sourceParagraphs.flatMap(p => field(p, 'Inlines')?.items ?? []);
  const runTemplate = sourceInlines
    .find(r => field(r, 'Type')?.text === 'Axure:AttributedString:AxRun');
  if (!runTemplate) throw new Error('Target has no native AxRun template');
  if (!Array.isArray(spec.paragraphs) || !spec.paragraphs.length) throw new Error('paragraphs must be a nonempty array');
  const linkedRuns = spec.paragraphs.flatMap(paragraph => paragraph.runs ?? []).filter(run => run.link !== undefined);
  let hyperlinkInlineTemplate, hyperlinkWidgetId, hyperlinkWidgetTemplate, isBuiltinTemplate = false;
  if (linkedRuns.length) {
    const templates = sourceInlines.filter(inline => field(inline, 'Type')?.text === 'Axure:AttributedString:AxHyperlink');
    if (templates.length >= 1) {
      hyperlinkInlineTemplate = templates[0];
      hyperlinkWidgetId = Number(spec.hyperlinkTemplateWidgetId ?? field(hyperlinkInlineTemplate, 'Link')?.value);
      hyperlinkWidgetTemplate = graph.objects.get(hyperlinkWidgetId);
      if (hyperlinkWidgetTemplate?.className !== 'Axure:DiagramObject:Hyperlink')
        throw new Error(`Hyperlink template widget ${hyperlinkWidgetId} is not a native Hyperlink widget`);
      const innerRuns = field(hyperlinkInlineTemplate, 'Inlines')?.items ?? [];
      if (!innerRuns.length || innerRuns.some(inline => field(inline, 'Type')?.text !== 'Axure:AttributedString:AxRun'))
        throw new Error('Native AxHyperlink template needs one or more AxRun children');
    } else {
      // 目标控件原先无链接模板，使用自包含的原生真值内置模板
      const builtin = getBuiltinHyperlinkTemplate();
      hyperlinkInlineTemplate = builtin.inline;
      hyperlinkWidgetId = builtin.rootId;
      isBuiltinTemplate = true;
    }
  }
  const strings = [...record.strings];
  const intern = text => {
    let index = strings.indexOf(text);
    if (index < 0) { index = strings.length; strings.push(text); }
    return { tag: 8, value: index + 1, text };
  };
  const set = (node, key, value, tag) => {
    const current = field(node, key);
    if (!current || current.tag !== tag) throw new Error(`Unsupported native field ${key}`);
    if (tag === 8) Object.assign(current, intern(value));
    else current.value = value;
  };
  const applyStyle = (run, style) => {
    if (style.bold !== undefined && style.weight !== undefined) throw new Error('bold and weight both write the native Weight key; use one');
    if (style.italic !== undefined && style.style !== undefined) throw new Error('italic and style both write the native Style key; use one');
    for (const [key, value] of Object.entries(style)) {
      const { field: fieldName, tag, value: encoded } = encodeStyleEntry(key, value);
      set(run, fieldName, encoded, tag);
    }
  };
  const linkTargetGuidIndex = pageName => {
    if (typeof pageName !== 'string' || !pageName) throw new Error('link.page must be a nonempty page name');
    const documentRecord = records.find(item => item.className === 'Axure:DesignDocument');
    if (!documentRecord) throw new Error('No DesignDocument record for hyperlink page lookup');
    const documentGraph = parsePayload(documentRecord);
    const documentGuids = documentGraph.roots.find(node => node.tag === 0x1e)?.values ?? [];
    const infos = [...documentGraph.objects.values()].filter(object => object.className === 'Axure:PackageInfo'
      && field(object.body, 'package-name')?.text === pageName
      && documentRecord.strings[field(object.body, 'package-id')?.values?.[0] - 1] === 'Axure:Page');
    if (infos.length !== 1) throw new Error(`Expected exactly one page named "${pageName}", found ${infos.length}`);
    const packageId = field(infos[0].body, 'package-id')?.values;
    const packageGuid = documentGuids[(packageId?.[1] ?? 0) - 1];
    if (!packageGuid) throw new Error(`Page "${pageName}" has no package GUID`);
    const guidRoot = graph.roots.find(node => node.tag === 0x1e);
    if (!guidRoot) throw new Error('Target record has no GUID table');
    let index = guidRoot.values.indexOf(packageGuid) + 1;
    if (!index) { guidRoot.values.push(packageGuid); index = guidRoot.values.length; }
    return index;
  };
  const cloneHyperlink = linkSpec => {
    if (!linkSpec || typeof linkSpec !== 'object' || Array.isArray(linkSpec)) throw new Error('run.link must be an object with page or url');
    const hasPage = typeof linkSpec.page === 'string' && linkSpec.page.length > 0;
    const hasUrl = typeof linkSpec.url === 'string' && linkSpec.url.length > 0;
    if (hasPage === hasUrl) throw new Error('run.link must specify exactly one of page or url');
    if (hasUrl && !/^https?:\/\//i.test(linkSpec.url)) throw new Error('run.link.url must use http or https');

    let cloned;
    if (isBuiltinTemplate) {
      const builtin = getBuiltinHyperlinkTemplate();
      cloned = cloneInto({
        srcGraph: builtin.graph,
        srcStrings: builtin.strings,
        dstGraph: graph,
        dstStrings: strings,
        closure: builtin.closure,
        rootOldId: builtin.rootId
      });
      const targetParentDiagramId = field(field(field(widget.body, 'name-block') ?? {}, 'property-dictionary') ?? {}, 'parent-diagram-id');
      if (targetParentDiagramId) {
        const hyperlinkWidget = graph.objects.get(cloned.rootNewId);
        const nameBlockPropDict = field(field(hyperlinkWidget?.body ?? {}, 'name-block') ?? {}, 'property-dictionary');
        const parentDiagramField = field(nameBlockPropDict ?? {}, 'parent-diagram-id');
        if (parentDiagramField) parentDiagramField.value = targetParentDiagramId.value;
      }
    } else {
      const closure = closureOf(graph, hyperlinkWidgetId);
      cloned = cloneInto({
        srcGraph: graph,
        srcStrings: record.strings,
        dstGraph: graph,
        dstStrings: strings,
        closure,
        rootOldId: hyperlinkWidgetId
      });
    }

    createdLinkObjects.push(...cloned.created);
    const actions = cloned.created.filter(object => object.className === 'Axure:InteractionLinkWindowAction');
    if (actions.length !== 1) throw new Error(`Native Hyperlink template needs exactly one link action; found ${actions.length}`);
    const targetRef = field(actions[0].body, 'target');
    const target = targetRef?.tag === 3 ? graph.objects.get(targetRef.value) : null;
    if (target?.className !== 'Axure:InteractionTarget') throw new Error('Native Hyperlink action has no InteractionTarget');
    const targetType = field(target.body, 'target-type'), targetPage = field(target.body, 'target-page-id');
    if (!targetType || targetType.tag !== 5 || !targetPage || targetPage.tag !== 0x13)
      throw new Error('Native Hyperlink target fields are not supported');
    targetType.value = hasPage ? 1 : 0;
    targetPage.values[1] = hasPage ? linkTargetGuidIndex(linkSpec.page) : graph.roots.find(node => node.tag === 0x1e).values.indexOf('0'.repeat(32)) + 1;
    const literalRef = field(target.body, 'target-literal');
    const literalObject = literalRef?.tag === 3 ? graph.objects.get(literalRef.value) : null;
    const literalValue = field(literalObject?.body ?? {}, 'value');
    if (literalObject?.className !== 'Axure:Expr:StringLiteral' || literalValue?.tag !== 8)
      throw new Error('Native Hyperlink target has no string literal');
    Object.assign(literalValue, intern(hasPage ? `${linkSpec.page}.html` : linkSpec.url));
    const windowType = field(actions[0].body, 'link-type');
    if (linkSpec.window !== undefined) {
      if (!['current', 'new'].includes(linkSpec.window)) throw new Error('link.window must be current or new');
      if (windowType?.tag !== 5) throw new Error('Native Hyperlink link-type field is unsupported');
      windowType.value = linkSpec.window === 'new' ? 2 : 1;
    }
    return cloned.rootNewId;
  };
  let runCount = 0, linkCount = 0;
  const createdLinkObjects = [];
  const plain = [];
  paragraphs.items = spec.paragraphs.map((paragraph, index) => {
    if (!Array.isArray(paragraph.runs) || !paragraph.runs.length) throw new Error(`Paragraph ${index} needs a nonempty runs array`);
    const current = structuredClone(paragraphTemplate);
    if (paragraph.lineSpacing !== undefined) {
      if (!Number.isFinite(paragraph.lineSpacing) || paragraph.lineSpacing < 0) throw new Error('lineSpacing must be a finite nonnegative number');
      set(current, 'LineSpacing', paragraph.lineSpacing, 6);
    }
    if (paragraph.align !== undefined) {
      const alignment = { left: 0, center: 1, right: 2 }[paragraph.align];
      if (alignment === undefined) throw new Error('align must be left/center/right');
      set(current, 'HorizontalAlignment', alignment, 5);
    }
    if (paragraph.wrapping !== undefined) {
      // AxWordWrapping: 0 Wrap, 1 NoWrap, 2 EmergencyBreak, 3 WholeWord, 4 Character.
      if (!Number.isInteger(paragraph.wrapping) || paragraph.wrapping < 0 || paragraph.wrapping > 4)
        throw new Error('wrapping must be an integer 0-4 (0 wrap, 1 no-wrap)');
      set(current, 'Wrapping', paragraph.wrapping, 5);
    }
    if (paragraph.trimming !== undefined) {
      // AxStringTrimming: 0 None, 2 Word, 3 EllipsisCharacter (1 is not a member).
      if (![0, 2, 3].includes(paragraph.trimming))
        throw new Error('trimming must be 0 (none), 2 (word) or 3 (ellipsis)');
      set(current, 'Trimming', paragraph.trimming, 5);
    }
    if (paragraph.list !== undefined) {
      // Native list persistence is a dict under the paragraph with two u32 keys:
      // IndentLevel (0 = none, 1..3 = level; the bullet glyph '•'/'◦'/'▪' derives
      // from this level at render time) and ListType (0 = no list, 1 = list).
      // The in-memory TextListType enum is flattened to this boolean by Axure's
      // own AxvgToRP conversion on this build, so numbered lists are not
      // representable here and deliberately not offered.
      const level = paragraph.list === true ? 1 : paragraph.list === false ? 0 : paragraph.list;
      if (!Number.isInteger(level) || level < 0 || level > 3) throw new Error('list must be a boolean or an integer level 0-3');
      let listInfo = field(current, 'ListInfo');
      if (!listInfo) {
        const entries = current.entries;
        const inlinesAt = entries.findIndex(([key]) => key.text === 'Inlines');
        if (inlinesAt < 0) throw new Error('Paragraph template has no Inlines entry to anchor a new ListInfo');
        listInfo = { tag: 1, entries: [
          [intern('IndentLevel'), { tag: 5, value: level }],
          [intern('ListType'), { tag: 5, value: level ? 1 : 0 }]
        ] };
        entries.splice(inlinesAt, 0, [intern('ListInfo'), listInfo]);
      } else {
        if (listInfo.tag !== 1) throw new Error('Unsupported native ListInfo field');
        set(listInfo, 'IndentLevel', level, 5);
        set(listInfo, 'ListType', level ? 1 : 0, 5);
      }
    }
    const texts = [], inlines = [];
    paragraph.runs.forEach((source, runIndex) => {
      if (typeof source.text !== 'string' || /[\r\n]/.test(source.text)) throw new Error('Run text must be a string without line breaks; use separate paragraphs');
      const linked = source.link !== undefined;
      const template = linked
        ? field(hyperlinkInlineTemplate, 'Inlines').items[0]
        : runTemplate;
      const run = structuredClone(template);
      applyStyle(run, spec.defaults ?? {});
      applyStyle(run, source.style ?? {});
      const newline = !linked && index < spec.paragraphs.length - 1 && runIndex === paragraph.runs.length - 1 ? '\n' : '';
      set(run, 'Text', source.text + newline, 8);
      texts.push(source.text); runCount++;
      if (linked) {
        const wrapper = structuredClone(hyperlinkInlineTemplate);
        const linkField = field(wrapper, 'Link');
        if (linkField?.tag !== 3) throw new Error('Native AxHyperlink template has no object reference');
        linkField.value = cloneHyperlink(source.link);
        field(wrapper, 'Inlines').items = [run];
        inlines.push(wrapper);
        linkCount++;
        if (index < spec.paragraphs.length - 1 && runIndex === paragraph.runs.length - 1) {
          const lineBreak = structuredClone(runTemplate);
          set(lineBreak, 'Text', '\n', 8);
          inlines.push(lineBreak);
          runCount++;
        }
      } else {
        inlines.push(run);
      }
    });
    field(current, 'Inlines').items = inlines;
    plain.push(texts.join(''));
    return current;
  });
  // Axure reapplies the widget's style chain on load. A property shared by all
  // runs is determined; a mixed property is overridden but indeterminate.
  // Without these local entries, inherited styles overwrite the run formats.
  const nativeStyle = graph.objects.get(field(widget.body, 'MyStyle')?.value);
  const properties = field(nativeStyle?.body ?? {}, 'PropList');
  if (!properties?.items) throw new Error('Target needs an existing native MyStyle PropList');
  const map = entries => ({ tag: 1, entries: Object.entries(entries).map(([key, value]) => [intern(key), value]) });
  const registerStyle = (name, nodes, encode = node => structuredClone(node)) => {
    const first = nodes[0];
    const value = node => node.tag === 8 ? node.text : node.value;
    const determined = nodes.every(node => value(node) === value(first));
    const entry = map({
      DOAName: { tag: 5, value: (determined ? 0xc0000000 : 0x40000000) + name },
      Value: encode(first)
    });
    const old = properties.items.findIndex(prop => (field(prop, 'DOAName')?.value & 0x0fffffff) === name);
    if (old < 0) properties.items.push(entry);
    else properties.items[old] = entry;
  };
  const collectRuns = inline => {
    if (field(inline, 'Type')?.text === 'Axure:AttributedString:AxRun') return [inline];
    if (field(inline, 'Type')?.text === 'Axure:AttributedString:AxHyperlink')
      return (field(inline, 'Inlines')?.items ?? []).flatMap(collectRuns);
    throw new Error(`Unsupported native rich text inline ${field(inline, 'Type')?.text ?? '(missing type)'}`);
  };
  const runs = paragraphs.items.flatMap(paragraph => field(paragraph, 'Inlines').items.flatMap(collectRuns));
  for (const [name, key] of [[1, 'Family'], [2, 'Size'], [1001, 'Weight'], [1002, 'Style'], [5, 'Underline'], [95, 'Strikethrough']]) {
    registerStyle(name, runs.map(run => field(run, key)));
  }
  registerStyle(6, runs.map(run => field(run, 'Color')), color => map({
    'fill-type': intern('solid'), 'fill-color': structuredClone(color)
  }));
  registerStyle(9, paragraphs.items.map(paragraph => field(paragraph, 'HorizontalAlignment')));
  registerStyle(20, paragraphs.items.map(paragraph => field(paragraph, 'LineSpacing')));
  graph.roots.splice(graph.roots.length - 1, 0, ...createdLinkObjects);
  const file = replaceRecord(input, record, encodeRecord(record, strings, encodePayload(graph.roots)));
  return { file, report: { record: record.index, widgetId: widget.id, paragraphs: paragraphs.items.length, runs: runCount, links: linkCount, text: plain.join('\n') } };
}

// Self-contained native AxHyperlink template extracted from native UI ground truth
const TEMPLATE_DATA = {"inline":{"tag":1,"entries":[[{"tag":8,"value":124,"text":"Type"},{"tag":8,"value":137,"text":"Axure:AttributedString:AxHyperlink"}],[{"tag":8,"value":138,"text":"Link"},{"tag":3,"value":19}],[{"tag":8,"value":123,"text":"Inlines"},{"tag":2,"items":[{"tag":1,"entries":[[{"tag":8,"value":124,"text":"Type"},{"tag":8,"value":125,"text":"Axure:AttributedString:AxRun"}],[{"tag":8,"value":126,"text":"Text"},{"tag":8,"value":139,"text":"Link Candidate"}],[{"tag":8,"value":59,"text":"Family"},{"tag":8,"value":28,"text":"Arial"}],[{"tag":8,"value":128,"text":"Size"},{"tag":6,"rawNumber":"0000000000004240","value":36}],[{"tag":8,"value":60,"text":"Weight"},{"tag":5,"value":400}],[{"tag":8,"value":61,"text":"Style"},{"tag":5,"value":0}],[{"tag":8,"value":62,"text":"Stretch"},{"tag":5,"value":5}],[{"tag":8,"value":129,"text":"Underline"},{"tag":25,"value":false}],[{"tag":8,"value":48,"text":"Color"},{"tag":5,"value":4278190335}],[{"tag":8,"value":130,"text":"Baseline"},{"tag":5,"value":0}],[{"tag":8,"value":131,"text":"CharacterSpacing"},{"tag":6,"rawNumber":"0000000000000000","value":0}],[{"tag":8,"value":132,"text":"Strikethrough"},{"tag":25,"value":false}]]}]}]]},"closureObjects":[{"tag":9,"id":19,"classIndex":207,"className":"Axure:DiagramObject:Hyperlink","body":{"tag":1,"entries":[[{"tag":8,"value":89,"text":"name-block"},{"tag":1,"entries":[[{"tag":8,"value":90,"text":"*type"},{"tag":8,"value":91,"text":"text-block"}],[{"tag":8,"value":92,"text":"text"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":94,"text":"property-dictionary"},{"tag":1,"entries":[[{"tag":8,"value":95,"text":"type"},{"tag":8,"value":96,"text":"label"}],[{"tag":8,"value":97,"text":"diagram-object-id"},{"tag":17,"value":19}],[{"tag":8,"value":98,"text":"parent-diagram-id"},{"tag":17,"value":4}]]}]]}],[{"tag":8,"value":99,"text":"tooltip"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":100,"text":"IsContained"},{"tag":25,"value":false}],[{"tag":8,"value":101,"text":"IsLocked"},{"tag":25,"value":false}],[{"tag":8,"value":102,"text":"SelectedStyleGroup"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":103,"text":"InteractionMap"},{"tag":3,"value":33}],[{"tag":8,"value":104,"text":"MyStyle"},{"tag":3,"value":34}],[{"tag":8,"value":6,"text":"AdaptiveStyles"},{"tag":2,"items":[]}],[{"tag":8,"value":105,"text":"SubmitButton"},{"tag":3,"value":3}],[{"tag":8,"value":106,"text":"Disabled"},{"tag":25,"value":false}],[{"tag":8,"value":107,"text":"Selected"},{"tag":25,"value":false}],[{"tag":8,"value":108,"text":"Error"},{"tag":25,"value":false}],[{"tag":8,"value":109,"text":"VisibleFromSettings"},{"tag":25,"value":true}]]}},{"tag":9,"id":34,"classIndex":198,"className":"Axure:Style","body":{"tag":1,"entries":[[{"tag":8,"value":13,"text":"LibraryId"},{"tag":17,"value":3}],[{"tag":8,"value":14,"text":"LibraryName"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":199,"text":"MatchInfo"},{"tag":1,"entries":[[{"tag":8,"value":13,"text":"LibraryId"},{"tag":17,"value":8}],[{"tag":8,"value":14,"text":"LibraryName"},{"tag":8,"value":15,"text":"Default"}],[{"tag":8,"value":16,"text":"Id"},{"tag":17,"value":11}],[{"tag":8,"value":17,"text":"Name"},{"tag":8,"value":23,"text":"文本链接"}]]}],[{"tag":8,"value":201,"text":"LegacyName"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":202,"text":"style-name"},{"tag":8,"value":104,"text":"MyStyle"}],[{"tag":8,"value":16,"text":"Id"},{"tag":17,"value":44}],[{"tag":8,"value":204,"text":"PropList"},{"tag":2,"items":[{"tag":1,"entries":[[{"tag":8,"value":20,"text":"DOAName"},{"tag":5,"value":3221225472}],[{"tag":8,"value":21,"text":"Value"},{"tag":17,"value":11}]]},{"tag":1,"entries":[[{"tag":8,"value":20,"text":"DOAName"},{"tag":5,"value":3221225493}],[{"tag":8,"value":21,"text":"Value"},{"tag":1,"entries":[[{"tag":8,"value":216,"text":"MouseOver"},{"tag":3,"value":45}],[{"tag":8,"value":217,"text":"MouseDown"},{"tag":3,"value":46}]]}]]}]}],[{"tag":8,"value":205,"text":"Capabilities"},{"tag":29,"value":"bf0008800100c004"}],[{"tag":8,"value":206,"text":"All"},{"tag":25,"value":false}]]}},{"tag":9,"id":46,"classIndex":198,"className":"Axure:Style","body":{"tag":1,"entries":[[{"tag":8,"value":13,"text":"LibraryId"},{"tag":17,"value":3}],[{"tag":8,"value":14,"text":"LibraryName"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":199,"text":"MatchInfo"},{"tag":1,"entries":[[{"tag":8,"value":13,"text":"LibraryId"},{"tag":17,"value":8}],[{"tag":8,"value":14,"text":"LibraryName"},{"tag":8,"value":15,"text":"Default"}],[{"tag":8,"value":16,"text":"Id"},{"tag":17,"value":10}],[{"tag":8,"value":17,"text":"Name"},{"tag":8,"value":22,"text":"Text link mouse down"}]]}],[{"tag":8,"value":201,"text":"LegacyName"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":202,"text":"style-name"},{"tag":8,"value":217,"text":"MouseDown"}],[{"tag":8,"value":16,"text":"Id"},{"tag":17,"value":48}],[{"tag":8,"value":204,"text":"PropList"},{"tag":2,"items":[{"tag":1,"entries":[[{"tag":8,"value":20,"text":"DOAName"},{"tag":5,"value":3221225472}],[{"tag":8,"value":21,"text":"Value"},{"tag":17,"value":10}]]}]}],[{"tag":8,"value":205,"text":"Capabilities"},{"tag":29,"value":"ffffffffffffffff"}],[{"tag":8,"value":206,"text":"All"},{"tag":25,"value":false}]]}},{"tag":9,"id":45,"classIndex":198,"className":"Axure:Style","body":{"tag":1,"entries":[[{"tag":8,"value":13,"text":"LibraryId"},{"tag":17,"value":3}],[{"tag":8,"value":14,"text":"LibraryName"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":199,"text":"MatchInfo"},{"tag":1,"entries":[[{"tag":8,"value":13,"text":"LibraryId"},{"tag":17,"value":8}],[{"tag":8,"value":14,"text":"LibraryName"},{"tag":8,"value":15,"text":"Default"}],[{"tag":8,"value":16,"text":"Id"},{"tag":17,"value":9}],[{"tag":8,"value":17,"text":"Name"},{"tag":8,"value":18,"text":"Text link mouse over"}]]}],[{"tag":8,"value":201,"text":"LegacyName"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":202,"text":"style-name"},{"tag":8,"value":216,"text":"MouseOver"}],[{"tag":8,"value":16,"text":"Id"},{"tag":17,"value":47}],[{"tag":8,"value":204,"text":"PropList"},{"tag":2,"items":[{"tag":1,"entries":[[{"tag":8,"value":20,"text":"DOAName"},{"tag":5,"value":3221225472}],[{"tag":8,"value":21,"text":"Value"},{"tag":17,"value":9}]]}]}],[{"tag":8,"value":205,"text":"Capabilities"},{"tag":29,"value":"ffffffffffffffff"}],[{"tag":8,"value":206,"text":"All"},{"tag":25,"value":false}]]}},{"tag":9,"id":33,"classIndex":146,"className":"Axure:InteractionTreeMap","body":{"tag":1,"entries":[[{"tag":8,"value":147,"text":"node-table"},{"tag":1,"entries":[[{"tag":3,"value":35},{"tag":3,"value":36}],[{"tag":3,"value":37},{"tag":3,"value":38}],[{"tag":3,"value":39},{"tag":3,"value":40}]]}],[{"tag":8,"value":148,"text":"tree"},{"tag":3,"value":41}],[{"tag":8,"value":149,"text":"PackageMode"},{"tag":25,"value":false}]]}},{"tag":9,"id":41,"classIndex":153,"className":"Axure:Tree","body":{"tag":1,"entries":[[{"tag":8,"value":151,"text":"children"},{"tag":2,"items":[{"tag":3,"value":35}]}],[{"tag":8,"value":148,"text":"tree"},{"tag":3,"value":41}]]}},{"tag":9,"id":35,"classIndex":150,"className":"Axure:Node","body":{"tag":1,"entries":[[{"tag":8,"value":151,"text":"children"},{"tag":2,"items":[{"tag":3,"value":37}]}],[{"tag":8,"value":152,"text":"parent-node"},{"tag":3,"value":41}],[{"tag":8,"value":148,"text":"tree"},{"tag":3,"value":41}]]}},{"tag":9,"id":37,"classIndex":150,"className":"Axure:Node","body":{"tag":1,"entries":[[{"tag":8,"value":151,"text":"children"},{"tag":2,"items":[{"tag":3,"value":39}]}],[{"tag":8,"value":152,"text":"parent-node"},{"tag":3,"value":35}],[{"tag":8,"value":148,"text":"tree"},{"tag":3,"value":41}]]}},{"tag":9,"id":39,"classIndex":150,"className":"Axure:Node","body":{"tag":1,"entries":[[{"tag":8,"value":151,"text":"children"},{"tag":2,"items":[]}],[{"tag":8,"value":152,"text":"parent-node"},{"tag":3,"value":37}],[{"tag":8,"value":148,"text":"tree"},{"tag":3,"value":41}]]}},{"tag":9,"id":40,"classIndex":208,"className":"Axure:InteractionLinkWindowAction","body":{"tag":1,"entries":[[{"tag":8,"value":106,"text":"Disabled"},{"tag":25,"value":false}],[{"tag":8,"value":209,"text":"target"},{"tag":3,"value":42}],[{"tag":8,"value":210,"text":"link-type"},{"tag":5,"value":1}]]}},{"tag":9,"id":42,"classIndex":211,"className":"Axure:InteractionTarget","body":{"tag":1,"entries":[[{"tag":8,"value":212,"text":"target-type"},{"tag":5,"value":1}],[{"tag":8,"value":213,"text":"target-page-id"},{"tag":19,"values":[1,2]}],[{"tag":8,"value":214,"text":"target-literal"},{"tag":3,"value":43}]]}},{"tag":9,"id":43,"classIndex":193,"className":"Axure:Expr:StringLiteral","body":{"tag":1,"entries":[[{"tag":8,"value":194,"text":"value"},{"tag":8,"value":215,"text":"Page 1.html"}],[{"tag":8,"value":195,"text":"variable-identifiers"},{"tag":2,"items":[]}],[{"tag":8,"value":196,"text":"repeater-scope"},{"tag":3,"value":3}],[{"tag":8,"value":197,"text":"TargetRepeaterScope"},{"tag":3,"value":3}]]}},{"tag":9,"id":38,"classIndex":159,"className":"Axure:InteractionCase","body":{"tag":1,"entries":[[{"tag":8,"value":106,"text":"Disabled"},{"tag":25,"value":false}],[{"tag":8,"value":160,"text":"Description"},{"tag":8,"value":27,"text":""}],[{"tag":8,"value":161,"text":"Condition"},{"tag":3,"value":3}],[{"tag":8,"value":162,"text":"IsNewIfGroup"},{"tag":25,"value":false}]]}},{"tag":9,"id":36,"classIndex":154,"className":"Axure:InteractionEvent","body":{"tag":1,"entries":[[{"tag":8,"value":106,"text":"Disabled"},{"tag":25,"value":false}],[{"tag":8,"value":155,"text":"event-type"},{"tag":5,"value":16}],[{"tag":8,"value":156,"text":"master-containing-raised-event"},{"tag":16,"values":[0,3]}],[{"tag":8,"value":157,"text":"raised-event-id"},{"tag":17,"value":3}],[{"tag":8,"value":158,"text":"variable-id"},{"tag":17,"value":3}]]}}],"rootId":19};
const NATIVE_GUIDS = ["a669b3475894fe4ea616ca411b06e2f0","4a043d15ba1fcc4983c02aa03d1fdfb4","00000000000000000000000000000000","6a6c26582b8193449abf36c23cb72386","09bbb30996dc6743b6c757ff0a1700a1","67b7e6b82db0c14e80b69ae1735661a4","626454e0e6eb884d83191fcf04f5f62b","89a1f4538b16484793d409a1b736ad03","c947c60f4b6a1748bab08f8d82ad1637","0be05582838a1f49b20d94cf549dec7c","85eb6b2e6aee064d8795f484f2d6f09e","b68775628d03cc43a051c114ac41ad32","0921e81902f16f47933582835c373474","4dde5f757add75f4a419df42ce58dbb0","6faf0c182b29e54dbcbcbaee0f7c93e2","d3240f390a44ae4fb7df3d0919e5c949","37ae37e3e75ab8f8e8195efee612ebd0","d36ad63026d225a03cd1f3ba6fdf5864","aff07abf907e3a4f8dab676ec2a08d90","544531a4e516a62cec61ce6e5c667c18","ec7efa7c6e9ffbcb308b0177b916fc27","9e1585566d5b3ab03fc07c102c521226","8e85a104636c36e5c3fe50bb3c38f21b","1eb3fbe2ef4901ffd1ad3b75be8b8bed","47c83bb45b7ca85920570480348d7fd7","21feb385f999daf8c5dd0acc77808923","3156f345e86bde42b5a9d017c7e6bb34","289323006bf98d03bfd89c7dbafa37a8","7fd246e3340300f691c49e6e798266b7","67e7e1ec6b2a3e9169fe1f7bee654357","c8cefea19e5bb2bea1ffbcf1c31c79ae","ab029afdeb1dc3ce0adabf7f806427c5","41448deafceb064289d6d8119951bc82","0818079d5afe43418b8ca57b980127b8","7ed1dd6f4f59b547bb9845c00c93a014","24895148dcf8bc4c84fb5948e301166a","cfd299e7c9e1ce46bea0df61b2eca5cf","82b9e6d43fa2e746b686bdc26ee21343","2cd4b818807f8c4aaf850742b70488a2","dd9fc34e1ed2844e8070a3665ec91549","3e0a5a675280c14981c2e9c8fb0cf2dd","1a72ac9d23267141908be618c8a519c4","120f748c35fbe9468da1a5fb9f178e44","12188356fcd06646ad8cb95d8be08d24","c76ea7fcc2347444bf0eebb36e75db08","a2e5c8280ee89245b0905adfca00fc7f","5c498c68c66e9f4a9c8f1cc993647411","456c53df45ff6b40bc295e410d857e90","f6d6740df19c5641801109528d2b4aab","2b01e5fffba10d49947b765b90629977","62b6061436c26447b0aed18c5f9a28ad"];
const NATIVE_STRINGS = ["Axure:Page","AdaptiveViewSetId","AdaptiveViewSet","diagram","page-style","AdaptiveStyles","AdaptiveViewMatchInfos","annotation","interactionmap","StyleCache","Styles","Info","LibraryId","LibraryName","Default","Id","Name","Text link mouse over","Props","DOAName","Value","Text link mouse down","文本链接","fill-type","solid","fill-color","","Arial","IndentLevel","ListType","X","Y","Width","Height","Start","End","Hash","HorizontalAlignment","VerticalAlignment","On","ColorSaturation","ColorBrightness","ColorContrast","HueRotation","OffsetX","OffsetY","BlurRadius","Color","Spread","Radius","Duration","Easing","ScaleX","ScaleY","TranslateX","TranslateY","Rotate","TypefaceToFullName","Family","Weight","Style","Stretch","Regular","Italic","Arial Italic","Bold","Arial Bold","Bold Italic","Arial Bold Italic","TypefaceToCssName","\"ArialMT\", \"Arial\"","\"Arial-ItalicMT\", \"Arial Italic\", \"Arial\"","\"Arial-BoldMT\", \"Arial Bold\", \"Arial\"","\"Arial-BoldItalicMT\", \"Arial Bold Italic\", \"Arial\"","HackLegacyContainedObjects2","Axure:Diagram","diagram-objects","AnnLinkList","ruler-guide-set","GroupsClean3","Axure:DiagramObject:VectorShape","ControlPoints","Path","LowerHandle","HigherHandle","HigherSegmentExists","Shape","reference-page-package-id","name-block","*type","text-block","text","RICH_TEXT","property-dictionary","type","label","diagram-object-id","parent-diagram-id","tooltip","IsContained","IsLocked","SelectedStyleGroup","InteractionMap","MyStyle","SubmitButton","Disabled","Selected","Error","VisibleFromSettings","RichTextBlock","rich-text-block","attributed-string","Version","Major","Minor","Build","Revision","Paragraphs","Wrapping","Trimming","LineSpacing","ListInfo","Inlines","Type","Axure:AttributedString:AxRun","Text","List Probe\n","Size","Underline","Baseline","CharacterSpacing","Strikethrough","Bullet Alpha\n","Bullet Beta\n","Number One\n","Number Two\n","Axure:AttributedString:AxHyperlink","Link","Link Candidate","\n","rich-text-object","diagram-object-label","text-object-id","AutoFitHeight","AutoFitWidth","Axure:InteractionTreeMap","node-table","tree","PackageMode","Axure:Node","children","parent-node","Axure:Tree","Axure:InteractionEvent","event-type","master-containing-raised-event","raised-event-id","variable-id","Axure:InteractionCase","Description","Condition","IsNewIfGroup","Axure:InteractionFadeWidgetAction","panelobjectpaths","WidgetPaths","FadeInfos","Axure:DiagramObjectPath","rdo-path","repeater-path","object-id","is-dummy","Axure:FadeWidgetInfo","duration","fade-action-type","easing","DurationHide","EasingHide","BringToFront","show-type","compress-easing","compress-duration","compress-distance-type","custom-compress-value","page-background","page-background-blur","animation-hide","animation-show","scale","scale-hide","scale-anchor","center","scale-hide-anchor","Axure:Expr:StringLiteral","value","variable-identifiers","repeater-scope","TargetRepeaterScope","Axure:Style","MatchInfo","T Page Description","LegacyName","style-name","MyStyle-Axure:DiagramObject:VectorShape","PropList","Capabilities","All","Axure:DiagramObject:Hyperlink","Axure:InteractionLinkWindowAction","target","link-type","Axure:InteractionTarget","target-type","target-page-id","target-literal","Page 1.html","MouseOver","MouseDown","Axure:AnnotationTreeMap","Axure:RulerGuideSet","ruler-guides","Axure:PageStyle","BaseStyle.Name","MyPageStyle","Axure:Annotation","property-name-id-to-value","property-name-id-to-name-text","annotation-field-set-type","PageFragment","OwnerId","StaticFields"];

function getBuiltinHyperlinkTemplate() {
  const objectsMap = new Map();
  for (const obj of TEMPLATE_DATA.closureObjects) {
    objectsMap.set(obj.id, obj);
  }
  return {
    inline: structuredClone(TEMPLATE_DATA.inline),
    graph: {
      roots: [{ tag: 0x1e, values: [...NATIVE_GUIDS] }],
      objects: objectsMap
    },
    strings: [...NATIVE_STRINGS],
    closure: new Set(TEMPLATE_DATA.closureObjects.map(o => o.id)),
    rootId: TEMPLATE_DATA.rootId
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output, specFile] = process.argv.slice(2);
  if (!specFile) throw new Error('Usage: node set-widget-richtext.mjs source.rp new.rp richtext.json');
  const result = setWidgetRichText(readFileSync(source), JSON.parse(readFileSync(specFile, 'utf8')));
  writeFileSync(output, result.file, { flag: 'wx' });
  console.log(JSON.stringify({ output, ...result.report }, null, 2));
}
