// Replace a native RichTextBlock's paragraphs and runs, retaining its identity.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';

const unique = (items, label) => {
  if (items.length !== 1) throw new Error(`${label} must be unique; found ${items.length}`);
  return items[0];
};
const STYLE_FIELDS = {
  fontFamily: ['Family', 8], size: ['Size', 6], bold: ['Weight', 5], italic: ['Style', 5],
  underline: ['Underline', 25], strikethrough: ['Strikethrough', 25], color: ['Color', 5]
};

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
  const paragraphTemplate = paragraphs.items[0];
  const runTemplate = paragraphs.items.flatMap(p => field(p, 'Inlines')?.items ?? [])
    .find(r => field(r, 'Type')?.text === 'Axure:AttributedString:AxRun');
  if (!runTemplate) throw new Error('Target has no native AxRun template');
  if (!Array.isArray(spec.paragraphs) || !spec.paragraphs.length) throw new Error('paragraphs must be a nonempty array');
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
    for (const [key, value] of Object.entries(style)) {
      const mapping = STYLE_FIELDS[key];
      if (!mapping) throw new Error(`Unknown rich text style ${key}`);
      const [fieldName, tag] = mapping;
      let encoded = value;
      if (key === 'fontFamily' && (typeof value !== 'string' || !value)) throw new Error('fontFamily must be a nonempty string');
      if (key === 'size' && (!Number.isFinite(value) || value <= 0)) throw new Error('size must be positive');
      if (['bold', 'italic', 'underline', 'strikethrough'].includes(key)) {
        if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
        if (key === 'bold') encoded = value ? 700 : 400;
        if (key === 'italic') encoded = value ? 1 : 0;
      }
      if (key === 'color') {
        if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('color must be #RRGGBB');
        encoded = Number.parseInt(`ff${value.slice(1)}`, 16);
      }
      set(run, fieldName, encoded, tag);
    }
  };
  let runCount = 0;
  const plain = [];
  paragraphs.items = spec.paragraphs.map((paragraph, index) => {
    if (!Array.isArray(paragraph.runs) || !paragraph.runs.length) throw new Error(`Paragraph ${index} needs a nonempty runs array`);
    const current = structuredClone(paragraphTemplate);
    if (paragraph.align !== undefined) {
      const alignment = { left: 0, center: 1, right: 2 }[paragraph.align];
      if (alignment === undefined) throw new Error('align must be left/center/right');
      set(current, 'HorizontalAlignment', alignment, 5);
    }
    const texts = [];
    field(current, 'Inlines').items = paragraph.runs.map((source, runIndex) => {
      if (typeof source.text !== 'string' || /[\r\n]/.test(source.text)) throw new Error('Run text must be a string without line breaks; use separate paragraphs');
      const run = structuredClone(runTemplate);
      applyStyle(run, spec.defaults ?? {});
      applyStyle(run, source.style ?? {});
      const newline = index < spec.paragraphs.length - 1 && runIndex === paragraph.runs.length - 1 ? '\n' : '';
      set(run, 'Text', source.text + newline, 8);
      texts.push(source.text); runCount++;
      return run;
    });
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
  const runs = paragraphs.items.flatMap(paragraph => field(paragraph, 'Inlines').items);
  for (const [name, key] of [[1, 'Family'], [2, 'Size'], [1001, 'Weight'], [1002, 'Style'], [5, 'Underline'], [95, 'Strikethrough']]) {
    registerStyle(name, runs.map(run => field(run, key)));
  }
  registerStyle(6, runs.map(run => field(run, 'Color')), color => map({
    'fill-type': intern('solid'), 'fill-color': structuredClone(color)
  }));
  registerStyle(9, paragraphs.items.map(paragraph => field(paragraph, 'HorizontalAlignment')));
  const file = replaceRecord(input, record, encodeRecord(record, strings, encodePayload(graph.roots)));
  return { file, report: { record: record.index, widgetId: widget.id, paragraphs: paragraphs.items.length, runs: runCount, text: plain.join('\n') } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output, specFile] = process.argv.slice(2);
  if (!specFile) throw new Error('Usage: node set-widget-richtext.mjs source.rp new.rp richtext.json');
  const result = setWidgetRichText(readFileSync(source), JSON.parse(readFileSync(specFile, 'utf8')));
  writeFileSync(output, result.file, { flag: 'wx' });
  console.log(JSON.stringify({ output, ...result.report }, null, 2));
}
