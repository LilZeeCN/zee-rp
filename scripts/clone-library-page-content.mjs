import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { readRp } from './rp-read.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { closureOf, cloneInto } from './clone-closure.mjs';

const uniquePage = (summary, name, role) => {
  const pages = summary.pages.filter(page => page.name === name);
  if (pages.length !== 1) throw new Error(`${role} page "${name}" must be unique; found ${pages.length}`);
  return pages[0];
};

const styleOf = (graph, widget) => graph.objects.get(field(widget.body, 'MyStyle')?.value);
const positionOf = (graph, widget) => {
  for (const item of field(styleOf(graph, widget)?.body ?? {}, 'PropList')?.items ?? []) {
    if (field(item, 'DOAName')?.value !== 3221225573) continue;
    const value = field(item, 'Value');
    return { x: field(value, 'X')?.value, y: field(value, 'Y')?.value };
  }
  return null;
};

const moveTo = (graph, widget, dx, dy) => {
  if (!dx && !dy) return;
  for (const item of field(styleOf(graph, widget)?.body ?? {}, 'PropList')?.items ?? []) {
    if (field(item, 'DOAName')?.value !== 3221225573) continue;
    const value = field(item, 'Value');
    const x = field(value, 'X'), y = field(value, 'Y');
    if (x && typeof x.value === 'number') x.value += dx;
    if (y && typeof y.value === 'number') y.value += dy;
    return;
  }
};

export function cloneLibraryPageContent(sourceFile, targetFile, outputFile, {
  sourcePageName, targetPageName, x, y
}) {
  if (!sourcePageName || !targetPageName) throw new Error('sourcePageName and targetPageName are required');
  if (x !== undefined && !Number.isFinite(x)) throw new Error('x must be a finite number');
  if (y !== undefined && !Number.isFinite(y)) throw new Error('y must be a finite number');
  let output = readFileSync(targetFile);
  const sourceBytes = readFileSync(sourceFile);
  const sourceSummary = readRp(sourceBytes, { path: sourceFile });
  const targetSummary = readRp(output, { path: targetFile });
  const sourceMeta = uniquePage(sourceSummary, sourcePageName, 'Source');
  const targetMeta = uniquePage(targetSummary, targetPageName, 'Target');
  const sourceRecords = readRecords(sourceBytes);
  const targetRecords = readRecords(output);
  const sourcePage = sourceRecords.find(record => record.index === sourceMeta.record && record.className === 'Axure:Page');
  const targetPage = targetRecords.find(record => record.index === targetMeta.record && record.className === 'Axure:Page');
  if (!sourcePage || !targetPage) throw new Error('Source or target Page record not found');

  const sourceGraph = parsePayload(sourcePage);
  const targetGraph = parsePayload(targetPage);
  const sourcePageObject = [...sourceGraph.objects.values()].find(object => object.className === 'Axure:Page');
  const sourceDiagram = sourceGraph.objects.get(field(sourcePageObject.body, 'diagram').value);
  const sourceRoots = (field(sourceDiagram.body, 'diagram-objects')?.items ?? [])
    .map(item => item.value).filter(id => sourceGraph.objects.has(id));
  if (!sourceRoots.length) throw new Error(`Source page "${sourcePageName}" has no diagram objects`);

  const sourceStrings = sourcePage.strings;
  const targetStrings = [...targetPage.strings];
  const closure = new Set();
  for (const rootId of sourceRoots) for (const id of closureOf(sourceGraph, rootId)) closure.add(id);
  const cloned = cloneInto({
    srcGraph: sourceGraph,
    srcStrings: sourceStrings,
    dstGraph: targetGraph,
    dstStrings: targetStrings,
    closure,
    rootOldId: sourceRoots[0]
  });

  const positioned = sourceRoots.map(id => positionOf(sourceGraph, sourceGraph.objects.get(id))).filter(p =>
    p && typeof p.x === 'number' && typeof p.y === 'number');
  const minX = positioned.length ? Math.min(...positioned.map(p => p.x)) : 0;
  const minY = positioned.length ? Math.min(...positioned.map(p => p.y)) : 0;
  const dx = x === undefined ? 0 : Number(x) - minX;
  const dy = y === undefined ? 0 : Number(y) - minY;
  for (const id of sourceRoots) {
    const clone = targetGraph.objects.get(cloned.idMap.get(id));
    if (clone) moveTo(targetGraph, clone, dx, dy);
  }

  const targetPageObject = [...targetGraph.objects.values()].find(object => object.className === 'Axure:Page');
  const targetDiagram = targetGraph.objects.get(field(targetPageObject.body, 'diagram').value);
  field(targetDiagram.body, 'diagram-objects').items.push(...sourceRoots.map(id => ({ tag: 3, value: cloned.idMap.get(id) })));
  targetGraph.roots.splice(targetGraph.roots.length - 1, 0, ...cloned.created);
  output = replaceRecord(output, targetPage, encodeRecord(targetPage, targetStrings, encodePayload(targetGraph.roots)));
  writeFileSync(outputFile, output, { flag: 'wx' });
  return {
    outputFile,
    sourcePage: sourcePageName,
    targetPage: targetPageName,
    clonedRoots: sourceRoots.length,
    closureObjects: cloned.created.length,
    offset: { x: dx, y: dy }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = Number(args[++i]);
    else positionals.push(args[i]);
  }
  const [sourceFile, targetFile, outputFile, sourcePageName, targetPageName] = positionals;
  if (!targetPageName) {
    console.error('Usage: node clone-library-page-content.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> [--x N --y N]');
    process.exit(1);
  }
  console.log(JSON.stringify(cloneLibraryPageContent(sourceFile, targetFile, outputFile, {
    sourcePageName, targetPageName, x: flags.x, y: flags.y
  }), null, 2));
}
