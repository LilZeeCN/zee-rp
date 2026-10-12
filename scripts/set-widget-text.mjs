import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';

const textBlockOf = (graph, widget) => {
  let block = field(widget.body, 'RichTextBlock') ?? field(widget.body, 'TextBlock');
  if (block?.tag === 3) block = graph.objects.get(block.value)?.body;
  return block;
};

const writeTextBlock = (record, graph, widget, widgetLabel, text, { runIndex } = {}) => {
  const textBlock = textBlockOf(graph, widget);
  if (!textBlock) throw new Error(`Widget ${widgetLabel} has no text block`);
  const textNodes = [];
  walkNodes([textBlock], node => {
    if (node.tag !== 1 || !node.entries) return;
    for (const [key, value] of node.entries) {
      if (key.text === 'Text' && value.tag === 8) textNodes.push(value);
    }
  });
  let target;
  if (runIndex !== undefined) {
    if (!Number.isInteger(runIndex) || runIndex < 0 || runIndex >= textNodes.length)
      throw new Error(`Widget ${widgetLabel} has ${textNodes.length} rich text runs; --run must be between 0 and ${textNodes.length - 1}`);
    target = textNodes[runIndex];
  } else if (textNodes.length === 1) target = textNodes[0];
  else if (textNodes.length === 0 && field(textBlock, 'text')?.tag === 8) target = field(textBlock, 'text');
  else throw new Error(`Widget ${widgetLabel} must have one simple text value; found ${textNodes.length} rich text runs (select one with --run <index>)`);

  const value = String(text);
  let index = record.strings.indexOf(value);
  if (index < 0) { index = record.strings.length; record.strings.push(value); }
  target.value = index + 1;
  target.text = value;
};

export function setWidgetText(sourceFile, outputFile, pageName, widgetName, text) {
  if (!pageName || !widgetName) throw new Error('pageName and widgetName are required');
  const input = readFileSync(sourceFile);
  const summary = readRp(input, { path: sourceFile });
  const pages = summary.pages.filter(page => page.name === pageName);
  if (pages.length !== 1) throw new Error(`Page "${pageName}" must be unique; found ${pages.length}`);
  const widgets = pages[0].widgets.filter(widget => widget.name === widgetName);
  if (widgets.length !== 1) throw new Error(`Widget "${widgetName}" on page "${pageName}" must be unique; found ${widgets.length}`);

  const records = readRecords(input);
  const page = records.find(record => record.index === pages[0].record && record.className === 'Axure:Page');
  if (!page) throw new Error(`Page record for "${pageName}" not found`);
  const graph = parsePayload(page);
  const widget = graph.objects.get(widgets[0].id);
  if (!widget?.className.startsWith('Axure:DiagramObject:')) throw new Error(`Unsupported widget target: ${widget?.className ?? widgets[0].id}`);
  writeTextBlock(page, graph, widget, `"${widgetName}"`, text);
  const output = replaceRecord(input, page, encodeRecord(page, page.strings, encodePayload(graph.roots)));
  writeFileSync(outputFile, output, { flag: 'wx' });
  return { outputFile, page: pageName, widget: widgetName, text: String(text) };
}

export function setRecordWidgetText(sourceFile, outputFile, recordIndex, widgetId, text, { runIndex } = {}) {
  const input = readFileSync(sourceFile);
  const record = readRecords(input).find(item => item.index === Number(recordIndex));
  if (!record || !['Axure:Page', 'Axure:PanelState'].includes(record.className))
    throw new Error(`Editable Page or PanelState record #${recordIndex} not found`);
  const graph = parsePayload(record);
  const widget = graph.objects.get(Number(widgetId));
  if (!widget?.className.startsWith('Axure:DiagramObject:'))
    throw new Error(`Unsupported widget target: ${widget?.className ?? widgetId}`);
  writeTextBlock(record, graph, widget, `#${widgetId}`, text, { runIndex });
  const output = replaceRecord(input, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
  writeFileSync(outputFile, output, { flag: 'wx' });
  return { outputFile, record: record.index, widgetId: Number(widgetId), ...(runIndex === undefined ? {} : { runIndex }), text: String(text) };
}

export function setContainedWidgetText(sourceFile, outputFile, recordIndex, containerPath, widgetName, text, { runIndex } = {}) {
  if (!Number.isInteger(Number(recordIndex)) || Number(recordIndex) < 0 || !widgetName)
    throw new Error('recordIndex and a non-empty widgetName are required');
  const pathParts = Array.isArray(containerPath)
    ? containerPath.map(String)
    : String(containerPath ?? '').split('/').filter(Boolean);
  if (!pathParts.length) throw new Error('containerPath is required');
  const input = readFileSync(sourceFile);
  const summary = readRp(input, { path: sourceFile });
  const pathKey = pathParts.join('/');
  const matches = summary.containedWidgets.filter(widget =>
    widget.record === Number(recordIndex) && widget.name === widgetName && widget.container.join('/') === pathKey);
  if (matches.length !== 1) {
    const candidates = matches.map(({ id, type }) => `#${id} ${type}`).join(', ');
    throw new Error(`Widget "${widgetName}" in "${pathKey}" at record #${recordIndex} must be unique; found ${matches.length}${candidates ? ` (${candidates})` : ''}`);
  }
  const record = readRecords(input).find(item => item.index === Number(recordIndex));
  if (!record || !['Axure:Page', 'Axure:PanelState'].includes(record.className))
    throw new Error(`Editable Page or PanelState record #${recordIndex} not found`);
  const graph = parsePayload(record);
  const widget = graph.objects.get(matches[0].id);
  if (!widget?.className.startsWith('Axure:DiagramObject:'))
    throw new Error(`Unsupported widget target: ${widget?.className ?? matches[0].id}`);
  writeTextBlock(record, graph, widget, `"${widgetName}" in "${pathKey}"`, text, { runIndex });
  const output = replaceRecord(input, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
  writeFileSync(outputFile, output, { flag: 'wx' });
  return { outputFile, record: record.index, container: pathParts, widgetId: matches[0].id, widget: widgetName, ...(runIndex === undefined ? {} : { runIndex }), text: String(text) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceFile, outputFile, ...args] = process.argv.slice(2);
  if (!sourceFile || !outputFile) {
    console.error('Usage: node set-widget-text.mjs <source.rp> <output.rp> <pageName> <widgetName> <text>');
    console.error('   or: node set-widget-text.mjs <source.rp> <output.rp> --record <recordIndex> --widget <widgetId> [--run <zeroBasedRunIndex>] <text>');
    console.error('   or: node set-widget-text.mjs <source.rp> <output.rp> --record <recordIndex> --container <path> --widget-name <name> [--run <zeroBasedRunIndex>] <text>');
    process.exit(1);
  }
  if (args[0] === '--record' && args[2] === '--container') {
    const [ , recordIndex, , containerPath, nameFlag, widgetName, ...rest] = args;
    const runFlagIndex = rest.indexOf('--run');
    const runIndex = runFlagIndex < 0 ? undefined : Number(rest[runFlagIndex + 1]);
    const textParts = runFlagIndex < 0 ? rest : rest.slice(runFlagIndex + 2);
    if (!recordIndex || !containerPath || nameFlag !== '--widget-name' || !widgetName || !textParts.length
      || (runFlagIndex >= 0 && (!Number.isInteger(runIndex) || runIndex < 0))) {
      console.error('Usage: node set-widget-text.mjs <source.rp> <output.rp> --record <recordIndex> --container <path> --widget-name <name> [--run <zeroBasedRunIndex>] <text>');
      process.exit(1);
    }
    console.log(JSON.stringify(setContainedWidgetText(sourceFile, outputFile, recordIndex, containerPath, widgetName, textParts.join(' '), { runIndex }), null, 2));
  } else if (args[0] === '--record') {
    const [recordIndex, widgetFlag, widgetId, ...rest] = args.slice(1);
    const runFlagIndex = rest.indexOf('--run');
    const runIndex = runFlagIndex < 0 ? undefined : Number(rest[runFlagIndex + 1]);
    const textParts = runFlagIndex < 0 ? rest : rest.slice(runFlagIndex + 2);
    if (!recordIndex || widgetFlag !== '--widget' || !widgetId || !textParts.length
      || (runFlagIndex >= 0 && (!Number.isInteger(runIndex) || runIndex < 0))) {
      console.error('Usage: node set-widget-text.mjs <source.rp> <output.rp> --record <recordIndex> --widget <widgetId> [--run <zeroBasedRunIndex>] <text>');
      process.exit(1);
    }
    console.log(JSON.stringify(setRecordWidgetText(sourceFile, outputFile, recordIndex, widgetId, textParts.join(' '), { runIndex }), null, 2));
  } else {
    const [pageName, widgetName, ...textParts] = args;
    if (!pageName || !widgetName || !textParts.length) {
      console.error('Usage: node set-widget-text.mjs <source.rp> <output.rp> <pageName> <widgetName> <text>');
      console.error('   or: node set-widget-text.mjs <source.rp> <output.rp> --record <recordIndex> --widget <widgetId> [--run <zeroBasedRunIndex>] <text>');
      console.error('   or: node set-widget-text.mjs <source.rp> <output.rp> --record <recordIndex> --container <path> --widget-name <name> [--run <zeroBasedRunIndex>] <text>');
      process.exit(1);
    }
    console.log(JSON.stringify(setWidgetText(sourceFile, outputFile, pageName, widgetName, textParts.join(' ')), null, 2));
  }
}
