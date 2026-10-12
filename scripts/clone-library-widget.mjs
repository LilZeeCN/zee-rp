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

export function cloneLibraryWidget(sourceFile, targetFile, outputFile, {
  sourcePageName, targetPageName, name, x, y, width, height
}) {
  if (!sourcePageName || !targetPageName || !name) throw new Error('sourcePageName, targetPageName, and name are required');
  let output = readFileSync(targetFile);
  const sourceBytes = readFileSync(sourceFile);
  const sourceSummary = readRp(sourceBytes, { path: sourceFile });
  const targetSummary = readRp(output, { path: targetFile });
  const sourcePageMeta = uniquePage(sourceSummary, sourcePageName, 'Source');
  const targetPageMeta = uniquePage(targetSummary, targetPageName, 'Target');

  if (sourcePageMeta.widgets.length !== 1 || sourcePageMeta.widgets[0].panel) {
    throw new Error(`Source page "${sourcePageName}" must contain exactly one non-container widget`);
  }
  const sourceRecords = readRecords(sourceBytes);
  const sourcePage = sourceRecords.find(record => record.index === sourcePageMeta.record && record.className === 'Axure:Page');
  const sourceGraph = parsePayload(sourcePage);
  const sourceWidget = sourceGraph.objects.get(sourcePageMeta.widgets[0].id);
  if (!sourceWidget.className.startsWith('Axure:DiagramObject:')) {
    throw new Error(`Unsupported source widget type: ${sourceWidget.className}`);
  }

  const targetRecords = readRecords(output);
  const targetPage = targetRecords.find(record => record.index === targetPageMeta.record && record.className === 'Axure:Page');
  const targetGraph = parsePayload(targetPage);
  const targetStrings = [...targetPage.strings];
  const targetPageObject = [...targetGraph.objects.values()].find(object => object.className === 'Axure:Page');
  const diagram = targetGraph.objects.get(field(targetPageObject.body, 'diagram').value);
  const clone = cloneInto({
    srcGraph: sourceGraph,
    srcStrings: sourcePage.strings,
    dstGraph: targetGraph,
    dstStrings: targetStrings,
    closure: closureOf(sourceGraph, sourceWidget.id),
    rootOldId: sourceWidget.id
  });
  const widget = targetGraph.objects.get(clone.rootNewId);
  const nameNode = field(field(widget.body, 'name-block') ?? {}, 'text');
  if (!nameNode) throw new Error(`${widget.className} has no name-block text`);
  let nameIndex = targetStrings.indexOf(name);
  if (nameIndex < 0) { nameIndex = targetStrings.length; targetStrings.push(name); }
  nameNode.value = nameIndex + 1;
  nameNode.text = name;

  const geometry = {
    x: x ?? sourcePageMeta.widgets[0].x,
    y: y ?? sourcePageMeta.widgets[0].y,
    width: width ?? sourcePageMeta.widgets[0].w,
    height: height ?? sourcePageMeta.widgets[0].h
  };
  const style = targetGraph.objects.get(field(widget.body, 'MyStyle').value);
  let positioned = false, sized = false;
  for (const item of field(style.body, 'PropList').items) {
    const property = field(item, 'DOAName')?.value;
    const value = field(item, 'Value');
    if (property === 3221225573) {
      field(value, 'X').value = geometry.x; field(value, 'Y').value = geometry.y; positioned = true;
    }
    if (property === 3221225577) {
      field(value, 'Width').value = geometry.width; field(value, 'Height').value = geometry.height; sized = true;
    }
  }
  if (!positioned || !sized) throw new Error(`${widget.className} has no editable position/size properties`);

  field(diagram.body, 'diagram-objects').items.push({ tag: 3, value: widget.id });
  targetGraph.roots.splice(targetGraph.roots.length - 1, 0, ...clone.created);
  const pageRaw = encodeRecord(targetPage, targetStrings, encodePayload(targetGraph.roots));
  output = replaceRecord(output, targetPage, pageRaw);
  writeFileSync(outputFile, output, { flag: 'wx' });
  return {
    outputFile,
    sourcePage: sourcePageName,
    targetPage: targetPageName,
    type: widget.className,
    name,
    id: widget.id,
    geometry,
    closureObjects: clone.created.length
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
  const [sourceFile, targetFile, outputFile, sourcePageName, targetPageName, name] = positionals;
  if (!name) {
    console.error('Usage: node clone-library-widget.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> <newName> [--x N --y N --w N --h N]');
    process.exit(1);
  }
  console.log(JSON.stringify(cloneLibraryWidget(sourceFile, targetFile, outputFile, {
    sourcePageName, targetPageName, name,
    x: flags.x, y: flags.y, width: flags.w, height: flags.h
  }), null, 2));
}
