// Change only name-block text; object identities, content and events stay intact.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { assertNotProtected, assertWritable } from './engine.mjs';

export function setWidgetNames(file, edits) {
  const grouped = new Map(), applied = [];
  for (const edit of edits) {
    if (!Number.isInteger(edit.record) || !Number.isInteger(edit.id) || typeof edit.name !== 'string')
      throw new Error('Rename requires integer record/id and a string name');
    if (!grouped.has(edit.record)) grouped.set(edit.record, []);
    grouped.get(edit.record).push(edit);
  }
  let output = file;
  for (const [index, changes] of grouped) {
    // Re-encoding the manifest can move even earlier record offsets.
    const record = readRecords(output).find(r => r.index === index);
    if (!record || !['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(record.className))
      throw new Error(`Editable record #${index} not found`);
    const graph = parsePayload(record), strings = [...record.strings];
    for (const { id, name } of changes) {
      const widget = graph.objects.get(id);
      if (!widget?.className.startsWith('Axure:DiagramObject:')) throw new Error(`Widget #${id} not found in record #${index}`);
      const text = field(field(widget.body, 'name-block') ?? {}, 'text');
      if (text?.tag !== 8) throw new Error(`Widget #${id} has no name-block text`);
      const before = text.text;
      let pos = strings.indexOf(name);
      if (pos < 0) { pos = strings.length; strings.push(name); }
      text.value = pos + 1; text.text = name;
      applied.push({ record: index, id, before, name });
    }
    output = replaceRecord(output, record, encodeRecord(record, strings, encodePayload(graph.roots)));
  }
  return { file: output, applied };
}

const usage = 'node name-widget.mjs <source.rp> <new.rp> --name <oldName> --to <newName> [--page <pageName>]\n'
  + '  or: <source.rp> <new.rp> --record <record> --widget <id> --to <newName>\n'
  + '  or: <source.rp> <new.rp> <pageRecordsIndex|页名> <widgetId> <newName> [...]';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [source, destination, ...args] = process.argv.slice(2);
    if (!source || !destination || !args.length) throw new Error(usage);
    assertNotProtected(source); assertWritable(destination);
    const file = readFileSync(source), summary = readRp(file, { includeMasterWidgets: true });
    let edits;
    if (args[0].startsWith('--')) {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!['--name', '--to', '--page', '--record', '--widget'].includes(args[i]) || args[i + 1] === undefined || Object.hasOwn(options, args[i])) throw new Error(usage);
        options[args[i]] = args[i + 1];
      }
      if (options['--to'] === undefined) throw new Error(usage);
      if (options['--record'] !== undefined || options['--widget'] !== undefined) {
        if (options['--name'] !== undefined || options['--page'] !== undefined || options['--record'] === undefined || options['--widget'] === undefined) throw new Error(usage);
        edits = [{ record: Number(options['--record']), id: Number(options['--widget']), name: options['--to'] }];
      } else {
        if (options['--name'] === undefined) throw new Error(usage);
        const candidates = new Map(summary.pages.flatMap(p => p.widgets.map(w => [`${p.record}:${w.id}`, { ...w, record: p.record, page: p.name }])));
        for (const w of summary.containedWidgets) candidates.set(`${w.record}:${w.id}`, { ...candidates.get(`${w.record}:${w.id}`), ...w });
        const page = options['--page'] === undefined ? null : summary.pages.filter(p => p.name === options['--page']);
        if (page && page.length !== 1) throw new Error(`Page must be unique: ${options['--page']}`);
        const pageKey = page ? summary.packages.find(p => p.record === page[0].record)?.key : null;
        const matches = [...candidates.values()].filter(w => w.name === options['--name'] && (!page || w.record === page[0].record || summary.packages.find(p => p.record === w.record)?.path.startsWith(pageKey + '/')));
        if (matches.length !== 1) throw new Error(`Name must be unique; found ${matches.length}: ${JSON.stringify(matches.map(({ record, id, name, container }) => ({ record, id, name, container })))}`);
        edits = [{ record: matches[0].record, id: matches[0].id, name: options['--to'] }];
      }
    } else {
      const [pageArg, ...pairs] = args;
      if (pairs.length < 2 || pairs.length % 2) throw new Error(usage);
      const pages = summary.pages.filter(p => p.name === pageArg);
      const pageRecord = /^\d+$/.test(pageArg) ? readRecords(file).filter(r => r.className === 'Axure:Page')[Number(pageArg)] : null;
      const page = pages.length === 1 ? pages[0] : !pages.length && pageRecord ? { record: pageRecord.index } : null;
      if (!page) throw new Error(`Page not found or ambiguous: ${pageArg}`);
      edits = [];
      for (let i = 0; i < pairs.length; i += 2) edits.push({ record: page.record, id: Number(pairs[i]), name: pairs[i + 1] });
    }
    const result = setWidgetNames(file, edits);
    writeFileSync(destination, result.file, { flag: 'wx' });
    console.log(JSON.stringify({ destination, applied: result.applied, oldSize: file.length, newSize: result.file.length }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
