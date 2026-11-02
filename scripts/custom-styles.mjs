// Reuse native style definitions. Never manufacture StyleSheet.CustomStyles objects.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { assertNotProtected } from './engine.mjs';

const guidText = value => {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value))
    throw new Error('Style GUID must contain 32 hexadecimal digits (hyphens optional)');
  return value.replaceAll('-', '').toLowerCase();
};
const guidPool = graph => graph.roots.find(node => node.tag === 30)?.values ?? [];
const guidOf = (graph, node) => node?.tag === 17 ? guidPool(graph)[node.value - 1] : undefined;
const identity = (graph, node) => [guidOf(graph, field(node ?? {}, 'LibraryId')), guidOf(graph, field(node ?? {}, 'Id'))];
const sameIdentity = (graph, node, style) => {
  const [library, id] = identity(graph, node);
  return id === style.guid && library === style.libraryGuid;
};

function documentStyles(file) {
  const records = readRecords(file), record = records.find(r => r.className === 'Axure:DesignDocument');
  if (!record) throw new Error('Axure:DesignDocument not found');
  const graph = parsePayload(record), doc = [...graph.objects.values()].find(o => o.className === 'Axure:DesignDocument');
  const sheet = graph.objects.get(field(doc.body, 'StyleSheet')?.value);
  const custom = field(sheet?.body ?? {}, 'CustomStyles');
  if (custom?.tag !== 2) throw new Error('Native StyleSheet.CustomStyles not found');
  const styles = custom.items.map(ref => {
    const object = graph.objects.get(ref.value);
    if (object?.className !== 'Axure:Style') throw new Error('CustomStyles contains an invalid native style');
    const [libraryGuid, guid] = identity(graph, object.body);
    if (!guid || !libraryGuid || field(object.body, 'style-name')?.tag !== 8) throw new Error('Native style identity is incomplete');
    return { object, guid, libraryGuid, name: field(object.body, 'style-name').text, libraryName: field(object.body, 'LibraryName')?.text ?? '' };
  });
  return { records, record, graph, sheet, styles };
}

export function listCustomStyles(file) {
  return documentStyles(file).styles.map(({ object, ...style }) => style);
}

function editor(record) {
  const graph = parsePayload(record), strings = [...record.strings];
  const str = text => {
    let index = strings.indexOf(text);
    if (index < 0) { index = strings.length; strings.push(text); }
    return { tag: 8, value: index + 1, text };
  };
  const guid = value => {
    const pool = guidPool(graph);
    if (!pool.length) throw new Error('Record has no native GUID pool');
    let index = pool.indexOf(value);
    if (index < 0) { index = pool.length; pool.push(value); }
    return { tag: 17, value: index + 1 };
  };
  const map = values => ({ tag: 1, entries: Object.entries(values).map(([key, value]) => [str(key), value]) });
  const put = (node, key, value) => {
    const pair = node.entries.find(([k]) => k.text === key);
    if (pair) pair[1] = value; else node.entries.push([str(key), value]);
  };
  const copy = (node, sourceGraph) => {
    const result = structuredClone(node);
    walkNodes([result], n => {
      if ([3, 9, 15, 16, 18, 19, 20, 22].includes(n.tag)) throw new Error('Custom style with object/package references is not supported; use a plain native style');
      if (n.tag === 8) Object.assign(n, str(n.text));
      if (n.tag === 17) {
        const value = guidOf(sourceGraph, n);
        if (!value) throw new Error('Custom style has an unresolved GUID');
        Object.assign(n, guid(value));
      }
    });
    return result;
  };
  return { graph, strings, str, guid, map, put, copy };
}

function replace(file, record, edit) {
  const raw = encodeRecord(record, edit.strings, encodePayload(edit.graph.roots));
  if (file[0] === 0xac && file[1] === 0xef) return replaceRecord(file, record, raw);
  // .rplib is a bare length-prefixed gzip stream, without an RP manifest.
  const compressed = gzipSync(raw), length = Buffer.alloc(4);
  length.writeUInt32LE(compressed.length);
  return Buffer.concat([file.subarray(0, record.offset - 4), length, compressed, file.subarray(record.offset + record.compressedSize)]);
}

export function renameCustomStyle(file, oldName, newName) {
  if (typeof oldName !== 'string' || !oldName.trim() || typeof newName !== 'string' || !newName.trim())
    throw new Error('Style names must be non-empty strings');
  const doc = documentStyles(file), matches = doc.styles.filter(style => style.name === oldName);
  if (matches.length !== 1) throw new Error(`Style name must be unique; found ${matches.length}: ${oldName}`);
  const target = matches[0];
  if (doc.styles.some(style => style !== target && style.name.toLowerCase() === newName.toLowerCase()))
    throw new Error(`Style name already exists: ${newName}`);
  let output = file, references = 0;
  const changedRecords = [];
  for (const { index } of doc.records.filter(r => r.strings)) {
    const record = readRecords(output)[index], edit = editor(record);
    let changed = 0;
    if (index === doc.record.index) {
      const object = edit.graph.objects.get(target.object.id);
      if (field(object.body, 'style-name').text !== newName) { edit.put(object.body, 'style-name', edit.str(newName)); changed++; }
    }
    // Includes MyStyle.MatchInfo, state/adaptive styles, and StyleCache.Styles[].Info.
    walkNodes(edit.graph.roots, node => {
      if (node.tag === 1 && field(node, 'Name')?.tag === 8 && sameIdentity(edit.graph, node, target) && field(node, 'Name').text !== newName) {
        edit.put(node, 'Name', edit.str(newName)); changed++; references++;
      }
    });
    if (changed) { output = replace(output, record, edit); changedRecords.push(index); }
  }
  return { file: output, style: { guid: target.guid, before: oldName, name: newName }, references, changedRecords };
}

// predicate receives {record, id, name, type, owner}; no eval or predicate strings.
export function rebindWidgets(file, targetStyleGuid, predicate, { resetOverrides = false } = {}) {
  if (typeof predicate !== 'function') throw new Error('A widget predicate is required (use () => true to select all)');
  if (typeof resetOverrides !== 'boolean') throw new Error('resetOverrides must be boolean');
  const doc = documentStyles(file), guid = guidText(targetStyleGuid);
  const targets = doc.styles.filter(style => style.guid === guid);
  if (targets.length !== 1) throw new Error(`Existing native custom style GUID must be unique; found ${targets.length}: ${guid}`);
  const target = targets[0], defaults = doc.graph.objects.get(field(doc.sheet.body, 'DefaultStyle')?.value);
  const styleKeys = new Set([defaults, target.object].flatMap(o => field(o?.body ?? {}, 'PropList')?.items ?? []).map(p => field(p, 'DOAName').value & 0x3fffffff));
  // Position, size, images, interaction styles and base identity have separate semantics.
  for (const key of [0, 21, 27, 101, 105]) styleKeys.delete(key);
  let output = file;
  const applied = [];
  for (const { index } of doc.records.filter(r => ['Axure:Page', 'Axure:Master', 'Axure:PanelState'].includes(r.className))) {
    const record = readRecords(output)[index], edit = editor(record);
    const selected = [...edit.graph.objects.values()].filter(o => o.className.startsWith('Axure:DiagramObject:') && predicate({
      record: index, id: o.id, name: field(field(o.body, 'name-block') ?? {}, 'text')?.text ?? '', type: o.className, owner: record.className,
    }));
    if (!selected.length) continue;
    const info = () => edit.map({ LibraryId: edit.guid(target.libraryGuid), LibraryName: edit.str(target.libraryName), Id: edit.guid(target.guid), Name: edit.str(target.name) });
    const props = edit.copy(field(target.object.body, 'PropList'), doc.graph);
    for (const widget of selected) {
      const style = edit.graph.objects.get(field(widget.body, 'MyStyle')?.value);
      if (style?.className !== 'Axure:Style' || field(style.body, 'PropList')?.tag !== 2 || widget.className.endsWith(':Layer'))
        throw new Error(`Widget ${index}:${widget.id} has no bindable native style`);
      const list = field(style.body, 'PropList');
      list.items = list.items.filter(p => {
        const key = field(p, 'DOAName').value & 0x3fffffff;
        return key !== 0 && (!resetOverrides || !styleKeys.has(key));
      });
      list.items.push(edit.map({ DOAName: { tag: 5, value: 0xc0000000 }, Value: edit.guid(target.guid) }));
      edit.put(style.body, 'MatchInfo', info());
      edit.put(style.body, 'All', { tag: 25, value: false });
      applied.push({ record: index, id: widget.id, name: field(field(widget.body, 'name-block') ?? {}, 'text')?.text ?? '' });
    }
    const owner = [...edit.graph.objects.values()].find(o => o.className === record.className);
    let cache = field(owner.body, 'StyleCache');
    if (!cache) { cache = edit.map({ Styles: { tag: 2, items: [] } }); edit.put(owner.body, 'StyleCache', cache); }
    const styles = field(cache, 'Styles');
    if (styles?.tag !== 2) throw new Error('Unsupported native StyleCache');
    const entry = edit.map({ Info: info(), Props: props });
    const existing = styles.items.findIndex(item => sameIdentity(edit.graph, field(item, 'Info'), target));
    if (existing < 0) styles.items.push(entry); else styles.items[existing] = entry;
    output = replace(output, record, edit);
  }
  return { file: output, style: { guid: target.guid, name: target.name }, resetOverrides, applied };
}

export function widgetSelector(selector) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error('Widget selector must be an object');
  for (const [key, value] of Object.entries(selector)) {
    if (!['name', 'type', 'record', 'id', 'owner', 'all'].includes(key)) throw new Error(`Unknown widget selector: ${key}`);
    if (['record', 'id'].includes(key) ? !Number.isInteger(value) || value < 0 : key === 'all' ? value !== true : typeof value !== 'string')
      throw new Error(`Invalid widget selector: ${key}`);
  }
  if (!Object.keys(selector).length || (selector.all && Object.keys(selector).length !== 1)) throw new Error('Choose explicit widget fields or {"all":true}');
  return widget => selector.all || Object.entries(selector).every(([key, value]) => widget[key] === value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node custom-styles.mjs <source.rp|source.rplib>');
    assertNotProtected(process.argv[2]);
    console.log(JSON.stringify({ styles: listCustomStyles(readFileSync(process.argv[2])) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
