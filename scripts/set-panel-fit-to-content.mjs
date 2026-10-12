import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';

export function setPanelFitToContent(input, { record: index, widgetId, enabled }) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const record = readRecords(input).find(record => record.index === index && ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(record.className));
  if (!record) throw new Error('record must identify an existing Page, PanelState or Master');
  const graph = parsePayload(record), widget = graph.objects.get(widgetId);
  const fit = field(widget?.body ?? {}, 'fit-to-content');
  if (widget?.className !== 'Axure:DiagramObject:DynamicPanel' || fit?.tag !== 0x19)
    throw new Error('widgetId must identify a native DynamicPanel with a boolean fit-to-content field');
  fit.value = enabled;
  return { file: replaceRecord(input, record, encodeRecord(record, record.strings, encodePayload(graph.roots))),
    report: { record: index, widgetId, enabled } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output, spec] = process.argv.slice(2);
  if (!spec) throw new Error('Usage: node set-panel-fit-to-content.mjs source.rp new.rp spec.json');
  const result = setPanelFitToContent(readFileSync(source), JSON.parse(readFileSync(spec, 'utf8')));
  writeFileSync(output, result.file, { flag: 'wx' });
  console.log(JSON.stringify(result.report, null, 2));
}
