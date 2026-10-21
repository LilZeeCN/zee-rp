import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { readRp } from './rp-read.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { closureOf, cloneInto } from './clone-closure.mjs';
import { detectFileVersion } from './version.mjs';

const uniquePage = (summary, name, role) => {
  const pages = summary.pages.filter(page => page.name === name);
  if (pages.length !== 1) throw new Error(`${role} page "${name}" must be unique; found ${pages.length}`);
  return pages[0];
};

export function cloneLibraryWidget(sourceFile, targetFile, outputFile, {
  sourcePageName, targetPageName, name, x, y, width, height, inputStyle, placeholder
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
    version: detectFileVersion(output),
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

  if (inputStyle) {
    if (widget.className !== 'Axure:DiagramObject:TextBox') throw new Error('inputStyle requires a TextBox');
    const str = text => {
      let index = targetStrings.indexOf(text);
      if (index < 0) { index = targetStrings.length; targetStrings.push(text); }
      return { tag: 8, value: index + 1, text };
    };
    const map = obj => ({ tag: 1, entries: Object.entries(obj).map(([k, v]) => [str(k), v]) });
    const num = value => ({ tag: 6, value });
    const int = value => ({ tag: 5, value });
    const props = field(style.body, 'PropList').items;
    const put = (key, value) => {
      const item = map({ DOAName: int(0xc0000000 + key), Value: value });
      const index = props.findIndex(p => (field(p, 'DOAName').value & 0x3fffffff) === key);
      if (index < 0) props.push(item); else props[index] = item;
    };
    const paint = argb => map({ 'fill-type': str('solid'), 'fill-color': int(argb) });
    // The editable vector behind the TextBox owns fill, stroke and radius.
    put(7, paint(0)); put(8, paint(0)); put(15, num(0)); put(80, int(0));
    put(1, str('Inter')); put(2, num(inputStyle.fontSize * .75));
    put(1001, int(inputStyle.fontWeight));
    const hex = inputStyle.color === 'transparent' ? '00000000' : inputStyle.color.replace('#', '');
    put(6, paint(parseInt((hex.length === 8 ? hex.slice(6) : 'ff') + hex.slice(0, 6), 16)));
    put(9, int({ left: 0, center: 1, right: 2 }[inputStyle.align]));
    put(11, num(inputStyle.textPaddingX)); put(13, num(inputStyle.textPaddingX));
    put(12, num(0)); put(14, num(0));
    Object.assign(field(widget.body, 'PlaceholderText'), str(placeholder ?? ''));
  }

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
