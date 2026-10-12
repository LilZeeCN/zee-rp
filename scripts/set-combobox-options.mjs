import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';

const strNode = (strings, value) => {
  const text = String(value);
  let index = strings.indexOf(text);
  if (index < 0) { index = strings.length; strings.push(text); }
  return { tag: 8, value: index + 1, text };
};

export function setComboBoxOptions(sourceFile, outputFile, pageName, widgetName, options, { selectedIndex = 0 } = {}) {
  if (!pageName || !widgetName) throw new Error('pageName and widgetName are required');
  if (!Array.isArray(options) || options.length === 0) throw new Error('options must be a non-empty array of labels');
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= options.length)
    throw new Error(`selectedIndex must be between 0 and ${options.length - 1}`);

  const input = readFileSync(sourceFile);
  const summary = readRp(input, { path: sourceFile });
  const pages = summary.pages.filter(page => page.name === pageName);
  if (pages.length !== 1) throw new Error(`Page "${pageName}" must be unique; found ${pages.length}`);
  const widgets = pages[0].widgets.filter(widget => widget.name === widgetName);
  if (widgets.length !== 1) throw new Error(`Widget "${widgetName}" on page "${pageName}" must be unique; found ${widgets.length}`);
  if (widgets[0].type !== 'ComboBox') throw new Error(`Widget "${widgetName}" is ${widgets[0].type}, expected ComboBox`);

  const records = readRecords(input);
  const page = records.find(record => record.index === pages[0].record && record.className === 'Axure:Page');
  if (!page) throw new Error(`Page record for "${pageName}" not found`);
  const graph = parsePayload(page);
  const widget = graph.objects.get(widgets[0].id);
  const optionList = field(widget?.body ?? {}, 'list-options');
  if (!optionList || optionList.tag !== 2) throw new Error(`ComboBox "${widgetName}" has no editable list-options field`);
  if (field(widget.body, 'multiple')?.value === true) throw new Error(`ComboBox "${widgetName}" uses multiple selection; this writer supports single selection only`);

  const strings = [...page.strings];
  let classIndex = strings.indexOf('Axure:SelectObject');
  if (classIndex < 0) { classIndex = strings.length; strings.push('Axure:SelectObject'); }
  const firstId = Math.max(...graph.objects.keys()) + 1;
  const created = options.map((label, index) => {
    if (typeof label !== 'string' || label.length === 0) throw new Error(`Option ${index} must be a non-empty string`);
    const id = firstId + index;
    const object = {
      tag: 9,
      id,
      classIndex: classIndex + 1,
      className: 'Axure:SelectObject',
      body: {
        tag: 1,
        entries: [
          [strNode(strings, 'object'), strNode(strings, label)],
          [strNode(strings, 'selected'), { tag: 25, value: index === selectedIndex }]
        ]
      }
    };
    graph.objects.set(id, object);
    return object;
  });

  optionList.items = created.map(option => ({ tag: 3, value: option.id }));
  graph.roots.splice(graph.roots.length - 1, 0, ...created);
  const output = replaceRecord(input, page, encodeRecord(page, strings, encodePayload(graph.roots)));
  writeFileSync(outputFile, output, { flag: 'wx' });
  return { outputFile, page: pageName, widget: widgetName, options, selectedIndex, addedObjects: created.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceFile, outputFile, pageName, widgetName, jsonOptions, ...flags] = process.argv.slice(2);
  if (!jsonOptions) {
    console.error('Usage: node set-combobox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <zeroBasedIndex>]');
    process.exit(1);
  }
  const selectedFlag = flags.indexOf('--selected');
  if (flags.some((flag, index) => flag.startsWith('--') && flag !== '--selected')
    || (selectedFlag >= 0 && (flags.length !== 2 || selectedFlag !== 0))) {
    throw new Error('Expected only optional --selected <zeroBasedIndex>');
  }
  const selectedIndex = selectedFlag < 0 ? 0 : Number(flags[1]);
  if (selectedFlag >= 0 && (!Number.isInteger(selectedIndex) || selectedIndex < 0))
    throw new Error('--selected must be a non-negative integer');
  const options = JSON.parse(jsonOptions);
  console.log(JSON.stringify(setComboBoxOptions(sourceFile, outputFile, pageName, widgetName, options, { selectedIndex }), null, 2));
}
