import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { EVENTS, resolvePageRecord } from './ix-actions.mjs';

function eventTypeOf(value) {
  if (EVENTS[value] !== undefined) return EVENTS[value];
  const key = Object.keys(EVENTS).find(name => name.toLowerCase() === String(value).toLowerCase());
  if (key === undefined) throw new Error(`Unknown event "${value}"`);
  return EVENTS[key];
}

function refTarget(graph, nodeTable, node) {
  const entry = nodeTable.entries.find(([key]) => key.value === node?.id);
  return entry ? graph.objects.get(entry[1].value) : undefined;
}

function childrenOf(graph, node) {
  return (field(node?.body ?? {}, 'children')?.items ?? [])
    .map(item => graph.objects.get(item.value)).filter(Boolean);
}

export function removeInteraction(file, target, { event, caseIndex, actionIndex } = {}) {
  if (!Buffer.isBuffer(file)) throw new Error('Input must be an Axure .rp project buffer');
  let eventType = eventTypeOf(event);
  const removeAction = actionIndex !== undefined || caseIndex !== undefined;
  if (removeAction && (!Number.isInteger(caseIndex) || caseIndex < 0 || !Number.isInteger(actionIndex) || actionIndex < 0)) {
    throw new Error('Removing one action requires non-negative integer caseIndex and actionIndex');
  }

  const pageOnly = typeof target === 'object' && target !== null && target.page !== undefined && target.widget === undefined;
  if (pageOnly && eventType === EVENTS.OnPageLoad) eventType = EVENTS.OnLoad;
  const widgetName = pageOnly ? null : (typeof target === 'string' ? target : target?.widget);
  const pageName = pageOnly ? target.page : (target?.page ?? null);
  const records = readRecords(Buffer.from(file));
  const pageRecords = pageName ? [resolvePageRecord(Buffer.from(file), pageName)] : records.filter(record => record.className === 'Axure:Page');
  const matches = [];
  for (const record of pageRecords) {
    const graph = parsePayload(record);
    if (pageOnly) {
      const page = [...graph.objects.values()].find(object => object.className === 'Axure:Page');
      if (page) matches.push({ record, graph, owner: page, ownerName: `page:${pageName}` });
      continue;
    }
    for (const widget of graph.objects.values()) {
      if (!widget.className.startsWith('Axure:DiagramObject:') && !widget.className.startsWith('Axure:Repeater')) continue;
      const name = field(field(widget.body, 'name-block') ?? {}, 'text')?.text;
      if (name === widgetName) matches.push({ record, graph, owner: widget, ownerName: `widget:${widgetName}` });
    }
  }
  if (matches.length !== 1) {
    const candidates = matches.map(match => `  · record #${match.record.index}, object #${match.owner.id}`);
    throw new Error(`Expected exactly one ${pageOnly ? `page "${pageName}"` : `widget "${widgetName}"`}, found ${matches.length}${candidates.length ? `\n${candidates.join('\n')}` : ''}`);
  }

  const { record, graph, owner, ownerName } = matches[0];
  const mapField = pageOnly ? 'interactionmap' : 'InteractionMap';
  const mapObject = graph.objects.get(field(owner.body, mapField)?.value);
  if (!mapObject) throw new Error(`No interaction map on ${ownerName}`);
  const tree = graph.objects.get(field(mapObject.body, 'tree')?.value);
  const nodeTable = field(mapObject.body, 'node-table');
  const treeChildren = field(tree?.body ?? {}, 'children');
  if (!tree || !nodeTable || !treeChildren) throw new Error('Interaction map is incomplete');

  const events = treeChildren.items.map(item => graph.objects.get(item.value)).filter(Boolean)
    .map(node => ({ node, eventObject: refTarget(graph, nodeTable, node) }))
    .filter(item => item.eventObject?.className === 'Axure:InteractionEvent'
      && field(item.eventObject.body, 'event-type')?.value === eventType);
  if (events.length !== 1) throw new Error(`Expected exactly one event type ${eventType} on ${ownerName}, found ${events.length}`);

  const selected = events[0];
  let removedDetails;
  let removedNodeIds;
  if (removeAction) {
    const cases = childrenOf(graph, selected.node);
    const caseNode = cases[caseIndex];
    if (!caseNode) throw new Error(`Case index ${caseIndex} is out of range (found ${cases.length})`);
    const actions = childrenOf(graph, caseNode);
    const actionNode = actions[actionIndex];
    if (!actionNode) throw new Error(`Action index ${actionIndex} is out of range (found ${actions.length})`);
    const actionObject = refTarget(graph, nodeTable, actionNode);
    if (!actionObject) throw new Error(`Action node #${actionNode.id} has no node-table entry`);
    const caseChildren = field(caseNode.body, 'children');
    caseChildren.items = caseChildren.items.filter(item => item.value !== actionNode.id);
    const removedIds = new Set();
    const collect = node => {
      if (removedIds.has(node.id)) return;
      removedIds.add(node.id);
      childrenOf(graph, node).forEach(collect);
    };
    collect(actionNode);
    nodeTable.entries = nodeTable.entries.filter(([key]) => !removedIds.has(key.value));
    removedNodeIds = [...removedIds];
    removedDetails = { caseIndex, actionIndex, actionClass: actionObject.className };
  } else {
    const descendants = new Set();
    const collect = node => {
      for (const child of childrenOf(graph, node)) {
        if (descendants.has(child.id)) continue;
        descendants.add(child.id);
        collect(child);
      }
    };
    collect(selected.node);
    descendants.add(selected.node.id);
    treeChildren.items = treeChildren.items.filter(item => item.value !== selected.node.id);
    nodeTable.entries = nodeTable.entries.filter(([key]) => !descendants.has(key.value));
    removedNodeIds = [...descendants];
    removedDetails = { removedNodeCount: removedNodeIds.length };
  }

  const output = replaceRecord(file, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
  return {
    file: output,
    report: {
      target: ownerName,
      record: record.index,
      event,
      eventType,
      removed: removeAction ? 'action' : 'event',
      ...removedDetails,
      removedNodeTableEntries: removedNodeIds.length,
      orphanDefinitionsRetained: true
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (arg === '--page' || arg === '--remove-event' || arg === '--remove-action') flags.set(arg, true);
      else if (['--on-page', '--event', '--case-index', '--action-index'].includes(arg)) flags.set(arg, argv[++i]);
      else throw new Error(`Unknown option ${arg}`);
    } else positionals.push(arg);
  }
  const [inputPath, outputPath, targetName] = positionals;
  const isPage = flags.has('--page');
  const removeEvent = flags.has('--remove-event');
  const removeAction = flags.has('--remove-action');
  if (!inputPath || !outputPath || !targetName || !flags.has('--event') || removeEvent === removeAction) {
    console.error('Usage: node remove-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] --event <EventName> (--remove-event | --remove-action --case-index <n> --action-index <n>)');
    process.exit(1);
  }
  if (isPage && flags.has('--on-page')) throw new Error('--on-page cannot be used with --page');
  const target = isPage ? { page: targetName } : (flags.has('--on-page') ? { widget: targetName, page: flags.get('--on-page') } : targetName);
  const caseIndex = flags.has('--case-index') ? Number(flags.get('--case-index')) : undefined;
  const actionIndex = flags.has('--action-index') ? Number(flags.get('--action-index')) : undefined;
  if (removeAction && (caseIndex === undefined || actionIndex === undefined)) {
    throw new Error('--remove-action requires --case-index and --action-index');
  }
  if (removeEvent && (flags.has('--case-index') || flags.has('--action-index'))) {
    throw new Error('--case-index and --action-index are only valid with --remove-action');
  }
  const result = removeInteraction(readFileSync(inputPath), target, {
    event: flags.get('--event'), caseIndex, actionIndex
  });
  if (extname(outputPath).toLowerCase() !== '.rp') throw new Error('Output path must end in .rp');
  const output = resolve(outputPath);
  writeFileSync(output, result.file, { flag: 'wx' });
  console.log(JSON.stringify({ output, ...result.report }, null, 2));
}
