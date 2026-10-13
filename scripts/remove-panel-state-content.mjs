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

// A state's packages are siblings under the Page or Master that owns the panel.
export function resolvePanelState(input, { page, master, panel, state }) {
  if (Boolean(page) === Boolean(master)) throw new Error('Choose exactly one Page or Master owner');
  const records = readRecords(input);
  let ownerRecord, stateRecord;
  if (page) {
    const meta = unique(readRp(input).pages.filter(item => item.name === page), `Page ${page}`);
    const widget = unique(meta.widgets.filter(item => item.name === panel && item.type === 'DynamicPanel'), `Panel ${panel}`);
    const selected = unique(widget.panel.filter(item => item.name === state), `State ${state}`);
    ownerRecord = records.find(item => item.index === meta.record);
    stateRecord = records.find(item => item.index === selected.record && item.className === 'Axure:PanelState');
  } else {
    const doc = parsePayload(records.find(item => item.className === 'Axure:DesignDocument'));
    const info = unique([...doc.objects.values()].filter(item => item.className === 'Axure:MasterPackageInfo'
      && field(item.body, 'package-name')?.text === master), `Master ${master}`);
    const guid = tableOf(doc)[field(info.body, 'package-id').values[1] - 1];
    ownerRecord = unique(records.filter(item => item.className === 'Axure:Master'
      && packageGuid(parsePayload(item)) === guid), `Master package ${master}`);
    const graph = parsePayload(ownerRecord), root = graph.objects.get(graph.roots.find(item => item.tag === 0xf).value);
    const diagram = graph.objects.get(field(root.body, 'diagram').value);
    const widget = unique(field(diagram.body, 'diagram-objects').items.map(ref => graph.objects.get(ref.value))
      .filter(item => item.className === 'Axure:DiagramObject:DynamicPanel' && nameOf(item) === panel), `Panel ${panel}`);
    const states = field(widget.body, 'panel-diagrams').items.map(pair => {
      if (pair.tag !== 0x13) throw new Error('Panel state requires a native package reference');
      const guid = tableOf(graph)[pair.values[1] - 1];
      const record = unique(records.filter(item => item.className === 'Axure:PanelState'
        && packageGuid(parsePayload(item)) === guid), `PanelState package ${guid}`);
      const stateGraph = parsePayload(record);
      const diagram = unique([...stateGraph.objects.values()].filter(item => item.className === 'Axure:PanelDiagram'), 'PanelDiagram');
      return { record, name: field(diagram.body, 'Name')?.text };
    });
    stateRecord = unique(states.filter(item => item.name === state), `State ${state}`).record;
  }
  if (!ownerRecord || !stateRecord) throw new Error('Panel owner or state package is missing');
  const ownerGuid = packageGuid(parsePayload(ownerRecord)), stateGuid = packageGuid(parsePayload(stateRecord));
  const manifest = readManifest(input);
  const ownerNode = manifest.value.root.children?.[guidKey(ownerGuid)];
  const node = ownerNode?.children?.[guidKey(stateGuid)];
  if (ownerNode?.parts?.package !== ownerRecord.offset - 8 - manifest.dataStart
    || node?.parts?.package !== stateRecord.offset - 8 - manifest.dataStart)
    throw new Error('PanelState package must belong to the selected Page or Master');
  return { ownerRecord, stateRecord, ownerGuid };
}

// Native deletion removes owned states, but keeps shared Master definitions.
function removeStatePackage(input, guid, ownerGuid) {
  const manifest = readManifest(input), parent = manifest.value.root.children?.[guidKey(ownerGuid)];
  const key = guidKey(guid), node = parent?.children?.[key];
  if (!node || Object.keys(node.parts ?? {}).length !== 1 || node.parts.package === undefined
    || Object.keys(node.children ?? {}).length)
    throw new Error('Removed panel states require a package-only entry under the owning Page or Master');
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

export function removePanelStateContent(input, { page: pageName, master, panel, state, widgets, widgetIds, all = false }) {
  if ([all, Boolean(widgets?.length), Boolean(widgetIds?.length)].filter(Boolean).length !== 1)
    throw new Error('Choose all:true, a nonempty widgets array, or a nonempty widgetIds array');
  if (widgets && (!Array.isArray(widgets) || widgets.some(name => typeof name !== 'string' || !name)
    || new Set(widgets).size !== widgets.length)) throw new Error('widgets must contain unique nonempty names');
  if (widgetIds && (!Array.isArray(widgetIds) || widgetIds.some(id => !Number.isInteger(id) || id < 1)
    || new Set(widgetIds).size !== widgetIds.length)) throw new Error('widgetIds must contain unique positive integer IDs');
  const { stateRecord: record, ownerGuid } = resolvePanelState(input, { page: pageName, master, panel, state });
  const records = readRecords(input);
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
  const stateGuid = packageGuid(graph);
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
  for (const guid of removedStates.keys()) file = removeStatePackage(file, guid, ownerGuid);
  return { file, report: { ...(master ? { master } : { page: pageName }), panel, state, record: record.index, all,
    removedWidgets: [...removedWidgets].map(id => ({ id, guid: guids[id - 1], name: nameOf(graph.objects.get(id)) ?? '' })),
    removedObjects: removed.length, removedStates: [...removedStates.keys()],
    retainedRoots: roots.items.length, stateGuid } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output, owner, panel, state, ...options] = process.argv.slice(2);
  const master = options.includes('--master'), names = options.filter(item => item !== '--master');
  if (options.filter(item => item === '--master').length > 1) throw new Error('Duplicate --master option');
  if (!state || !names.length || (names.includes('--all') && names.length !== 1)
    || names[0] === '--ids' && (names.length < 2 || names.slice(1).some(id => !/^[1-9]\d*$/.test(id))))
    throw new Error('Usage: node remove-panel-state-content.mjs source.rp new.rp <pageOrMaster> <panel> <state> [--master] (--all | --ids <id>... | <widgetName>...)');
  const result = removePanelStateContent(readFileSync(source), { ...(master ? { master: owner } : { page: owner }), panel, state, all: names[0] === '--all',
    widgets: ['--all', '--ids'].includes(names[0]) ? undefined : names,
    widgetIds: names[0] === '--ids' ? names.slice(1).map(Number) : undefined });
  writeFileSync(output, result.file, { flag: 'wx' });
  console.log(JSON.stringify(result.report, null, 2));
}
