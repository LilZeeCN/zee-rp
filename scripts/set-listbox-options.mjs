import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';

const strNode = (strings, text) => {
  let index = strings.indexOf(text);
  if (index < 0) { index = strings.length; strings.push(text); }
  return { tag: 8, value: index + 1, text };
};

export function setListBoxOptions(sourceFile, outputFile, pageName, widgetName, options, {
  multiple = true, selectedIndices = [0]
} = {}) {
  if (!pageName || !widgetName) throw new Error('pageName and widgetName are required');
  if (!Array.isArray(options) || !options.length || options.some(label => typeof label !== 'string' || !label.length))
    throw new Error('options must be a non-empty array of non-empty strings');
  if (typeof multiple !== 'boolean') throw new Error('multiple must be boolean');
  if (!Array.isArray(selectedIndices) || selectedIndices.some(index => !Number.isInteger(index) || index < 0 || index >= options.length))
    throw new Error('selectedIndices must contain valid zero-based option indices');
  if (new Set(selectedIndices).size !== selectedIndices.length) throw new Error('selectedIndices must not contain duplicates');
  if (!multiple && selectedIndices.length > 1) throw new Error('single selection allows at most one selected index');

  const input = readFileSync(sourceFile);
  const summary = readRp(input, { path: sourceFile });
  const pages = summary.pages.filter(page => page.name === pageName);
  if (pages.length !== 1) throw new Error(`Page "${pageName}" must be unique; found ${pages.length}`);
  const widgets = pages[0].widgets.filter(widget => widget.name === widgetName);
  if (widgets.length !== 1) throw new Error(`Widget "${widgetName}" on page "${pageName}" must be unique; found ${widgets.length}`);
  if (widgets[0].type !== 'ListBox') throw new Error(`Widget "${widgetName}" is ${widgets[0].type}, expected ListBox`);
  const record = readRecords(input).find(record => record.index === pages[0].record && record.className === 'Axure:Page');
  if (!record) throw new Error(`Page record for "${pageName}" not found`);
  const graph = parsePayload(record), strings = [...record.strings];
  const widget = graph.objects.get(widgets[0].id);
  const list = field(widget.body, 'list-options'), mode = field(widget.body, 'multiple');
  if (list?.tag !== 2 || mode?.tag !== 25) throw new Error(`ListBox "${widgetName}" has no editable list-options/multiple fields`);
  const guids = graph.roots.find(node => node.tag === 0x1e).values;
  let classIndex = strings.indexOf('Axure:SelectObject');
  if (classIndex < 0) { classIndex = strings.length; strings.push('Axure:SelectObject'); }
  const selected = new Set(selectedIndices);
  const created = options.map((label, index) => {
    guids.push(randomBytes(16).toString('hex'));
    const object = {
      tag: 9, id: guids.length, classIndex: classIndex + 1, className: 'Axure:SelectObject',
      body: { tag: 1, entries: [
        [strNode(strings, 'object'), strNode(strings, label)],
        [strNode(strings, 'selected'), { tag: 25, value: selected.has(index) }]
      ] }
    };
    graph.objects.set(object.id, object);
    return object;
  });
  mode.value = multiple;
  list.items = created.map(object => ({ tag: 3, value: object.id }));
  graph.roots.splice(graph.roots.length - 1, 0, ...created);
  const output = replaceRecord(input, record, encodeRecord(record, strings, encodePayload(graph.roots)));
  writeFileSync(outputFile, output, { flag: 'wx' });
  return { outputFile, page: pageName, widget: widgetName, options, multiple, selectedIndices };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceFile, outputFile, pageName, widgetName, labels, ...flags] = process.argv.slice(2);
  if (!labels) throw new Error('Usage: node set-listbox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <indices-json>] [--single]');
  let multiple = true, selectedIndices = [0];
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === '--single') multiple = false;
    else if (flags[index] === '--selected') selectedIndices = JSON.parse(flags[++index]);
    else throw new Error(`Unknown flag ${flags[index]}`);
  }
  console.log(JSON.stringify(setListBoxOptions(sourceFile, outputFile, pageName, widgetName, JSON.parse(labels), { multiple, selectedIndices }), null, 2));
}
