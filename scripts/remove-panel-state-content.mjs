// Remove selected top-level widgets, or clear a native PanelState, in a new file.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, readManifest, encodeManifest, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { closureOf } from './clone-closure.mjs';
import { guidKey } from './duplicate-page.mjs';

const unique = (items, label) => {
  if (items.length !== 1) throw new Error(`${label} must be unique; found ${items.length}`);
  return items[0];
};
const nameOf = object => field(field(object.body, 'name-block') ?? {}, 'text')?.text;
const tableOf = graph => graph.roots.find(node => node.tag === 0x1e).values;
const packageGuid = graph => tableOf(graph)[graph.roots.find(node => node.tag === 0x12).value - 1];

// Native deletion removes owned states, but keeps shared Master definitions.
function removeStatePackage(input, guid, pageGuid) {
  const manifest = readManifest(input), parent = manifest.value.root.children?.[guidKey(pageGuid)];
  const key = guidKey(guid), node = parent?.children?.[key];
  if (!node || Object.keys(node.parts ?? {}).length !== 1 || node.parts.package === undefined
    || Object.keys(node.children ?? {}).length)
    throw new Error('Removed panel states require a package-only entry under the owning Page');
  const record = unique(readRecords(input).filter(record => record.className === 'Axure:PanelState'
    && packageGuid(parsePayload(record)) === guid), `PanelState package ${guid}`);
  const start = record.offset - 8 - manifest.dataStart, length = record.compressedSize + 8;
  if (node.parts.package !== start) throw new Error('PanelState manifest offset does not match its record');
  delete parent.children[key];
  const shift = node => {
    for (const [key, offset] of Object.entries(node.parts ?? {})) {
      if (offset >= start && offset < start + length) throw new Error('Another manifest part overlaps a removed state');
      if (offset >= start + length) node.parts[key] = offset - length;
    }
    for (const child of Object.values(node.children ?? {})) shift(child);
  };
  shift(manifest.value.root);
  return Buffer.concat([encodeManifest(input, manifest.value), input.subarray(manifest.dataStart, record.offset - 8),
    input.subarray(record.offset + record.compressedSize)]);
}

export function removePanelStateContent(input, { page: pageName, panel, state, widgets, widgetIds, all = false }) {
  if ([all, Boolean(widgets?.length), Boolean(widgetIds?.length)].filter(Boolean).length !== 1)
    throw new Error('Choose all:true, a nonempty widgets array, or a nonempty widgetIds array');
  if (widgets && (!Array.isArray(widgets) || widgets.some(name => typeof name !== 'string' || !name)
    || new Set(widgets).size !== widgets.length)) throw new Error('widgets must contain unique nonempty names');
  if (widgetIds && (!Array.isArray(widgetIds) || widgetIds.some(id => !Number.isInteger(id) || id < 1)
    || new Set(widgetIds).size !== widgetIds.length)) throw new Error('widgetIds must contain unique positive integer IDs');
  const page = unique(readRp(input).pages.filter(page => page.name === pageName), `Page ${pageName}`);
  const owner = unique(page.widgets.filter(widget => widget.name === panel && widget.type === 'DynamicPanel'), `Panel ${panel}`);
  const meta = unique(owner.panel.filter(item => item.name === state), `State ${state}`);
  const records = readRecords(input), record = records.find(record => record.index === meta.record && record.className === 'Axure:PanelState');
  const graph = parsePayload(record), guids = graph.roots.find(node => node.tag === 0x1e).values;
  const diagram = unique([...graph.objects.values()].filter(object => object.className === 'Axure:PanelDiagram'), 'PanelDiagram');
  const roots = field(diagram.body, 'diagram-objects');
  const top = roots.items.map(ref => graph.objects.get(ref.value));
  const selected = all ? top : widgetIds?.length
    ? widgetIds.map(id => unique(top.filter(object => object.id === id), `Top-level widget ID ${id}`))
    : widgets.map(name => unique(top.filter(object => nameOf(object) === name), `Top-level widget ${name}`));
  const candidates = new Set(selected.flatMap(object => [...closureOf(graph, object.id)]));
  const selectedIds = new Set(selected.map(object => object.id));
  roots.items = roots.items.filter(ref => !selectedIds.has(ref.value));
  const retained = closureOf(graph, graph.roots.find(node => node.tag === 0xf).value);
  if ([...selectedIds].some(id => retained.has(id)))
    throw new Error('Remaining state content references a selected widget; remove or retarget that reference first');
  const removed = [...candidates].filter(id => graph.objects.has(id) && !retained.has(id));
  const removedWidgets = new Set(removed.filter(id => graph.objects.get(id).className.startsWith('Axure:DiagramObject:')));
  const removedGuids = new Set(removed.map(id => guids[id - 1]));
  const pageGraph = parsePayload(records.find(record => record.index === page.record));
  const pageGuid = packageGuid(pageGraph), stateGuid = packageGuid(graph);
  const packages = new Map(records.filter(record => record.className === 'Axure:PanelState').map(record => {
    const graph = parsePayload(record);
    return [packageGuid(graph), { record, graph }];
  }));
  const removedStates = new Map(), visiting = new Set();
  const includeStates = (graph, ids) => {
    const table = tableOf(graph);
    for (const id of ids) {
      const object = graph.objects.get(id);
      if (object?.className !== 'Axure:DiagramObject:DynamicPanel') continue;
      for (const pair of field(object.body, 'panel-diagrams').items) {
        const guid = table[pair.values[1] - 1], pkg = packages.get(guid);
        if (!pkg || pair.tag !== 0x13) throw new Error('Removed nested panel state package is missing or has an unknown reference');
        if (guid === stateGuid || visiting.has(guid)) throw new Error('Removed panel state ownership must not contain cycles');
        if (removedStates.has(guid)) continue;
        visiting.add(guid);
        removedStates.set(guid, pkg);
        removedGuids.add(guid);
        for (const id of pkg.graph.objects.keys()) removedGuids.add(tableOf(pkg.graph)[id - 1]);
        includeStates(pkg.graph, closureOf(pkg.graph, pkg.graph.roots.find(node => node.tag === 0xf).value));
        visiting.delete(guid);
      }
    }
  };
  includeStates(graph, removed);
  // Check all active GUID references, including nested state, RDO/repeater paths
  // and expression DataSet scopes. Dead object definitions are not active users.
  for (const pkg of records.filter(pkg => ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(pkg.className))) {
    const pg = pkg.index === record.index ? graph : parsePayload(pkg), table = tableOf(pg);
    if (removedStates.has(packageGuid(pg))) continue;
    const active = pkg.index === record.index ? retained : closureOf(pg, pg.roots.find(node => node.tag === 0xf).value);
    const check = node => {
      const index = [3, 0x11, 0x12, 0x14, 0x16].includes(node.tag) ? node.value
        : [0x10, 0x13].includes(node.tag) ? node.values[1] : undefined;
      if (index && removedGuids.has(table[index - 1]))
        throw new Error('Remaining content references an object or state being removed; remove or retarget that reference first');
      if (node.items) node.items.forEach(check);
      if (node.entries) node.entries.forEach(([key, value]) => { check(key); check(value); });
    };
    for (const id of active) {
      const object = pg.objects.get(id);
      if (object) check(object.body);
    }
  }
  const removedIds = new Set(removed);
  graph.roots = graph.roots.filter(node => node.tag !== 9 || !removedIds.has(node.id));
  let file = replaceRecord(input, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
  for (const guid of removedStates.keys()) file = removeStatePackage(file, guid, pageGuid);
  return { file, report: { page: pageName, panel, state, record: record.index, all,
    removedWidgets: [...removedWidgets].map(id => ({ id, guid: guids[id - 1], name: nameOf(graph.objects.get(id)) ?? '' })),
    removedObjects: removed.length, removedStates: [...removedStates.keys()],
    retainedRoots: roots.items.length, stateGuid } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output, page, panel, state, ...names] = process.argv.slice(2);
  if (!state || !names.length || (names.includes('--all') && names.length !== 1)
    || names[0] === '--ids' && (names.length < 2 || names.slice(1).some(id => !/^[1-9]\d*$/.test(id))))
    throw new Error('Usage: node remove-panel-state-content.mjs source.rp new.rp <page> <panel> <state> (--all | --ids <id>... | <widgetName>...)');
  const result = removePanelStateContent(readFileSync(source), { page, panel, state, all: names[0] === '--all',
    widgets: ['--all', '--ids'].includes(names[0]) ? undefined : names,
    widgetIds: names[0] === '--ids' ? names.slice(1).map(Number) : undefined });
  writeFileSync(output, result.file, { flag: 'wx' });
  console.log(JSON.stringify(result.report, null, 2));
}
