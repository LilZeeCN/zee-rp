import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, replaceRecord, encodeRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { closureOf, cloneInto } from './clone-closure.mjs';
import { readRp } from './rp-read.mjs';

// Built-in VectorShape connector point keys, RP 11.0.0.4137, .NET GUID bytes.
export const CONNECTOR_POINTS = {
  top: { guid: '4ffb380b33f19a4791117af9ea33bbd0', direction: 2, x: 0.5, y: 0 },
  left: { guid: '0c0da41305fd2748bca3d523cb855c91', direction: 1, x: 0, y: 0.5 },
  right: { guid: 'a70aa02f1f4bdc499321e356041b831c', direction: 4, x: 1, y: 0.5 },
  bottom: { guid: 'a70aa03f1f4bdc499321e356041b831c', direction: 8, x: 0.5, y: 1 }
};

export function cloneNativeConnector(sourceFile, targetFile, outputFile, sourceRecord, connectorId, targetPage, {
  name = 'ANCHORED_CONNECTOR', startName = 'ANCHOR_A', endName = 'ANCHOR_B', dx = 0, dy = 0
} = {}) {
  if (![dx, dy].every(Number.isFinite)) throw new Error('dx/dy must be finite numbers');
  const source = readFileSync(sourceFile), target = readFileSync(targetFile);
  const sr = readRecords(source).find(r => r.index === Number(sourceRecord) && r.className === 'Axure:Page');
  if (!sr) throw new Error('Source Page record not found');
  const sg = parsePayload(sr), sourceGuids = sg.roots.find(n => n.tag === 0x1e).values;
  const sc = sg.objects.get(Number(connectorId));
  if (sc?.className !== 'Axure:DiagramObject:Connector') throw new Error('Source object must be a native Connector');
  const sourcePage = [...sg.objects.values()].find(o => o.className === 'Axure:Page');
  const sourceDiagram = sg.objects.get(field(sourcePage.body, 'diagram').value);
  const sourceRoots = new Set(field(sourceDiagram.body, 'diagram-objects').items.map(n => n.value));
  if (!sourceRoots.has(sc.id)) throw new Error('Connector must be directly on the source Page');
  const pages = readRp(target).pages.filter(p => p.name === targetPage);
  if (pages.length !== 1) throw new Error('Target Page name must be unique');
  const tr = readRecords(target).find(r => r.index === pages[0].record), tg = parsePayload(tr), strings = [...tr.strings];
  const page = [...tg.objects.values()].find(o => o.className === 'Axure:Page');
  const diagram = tg.objects.get(field(page.body, 'diagram').value);
  const endpoints = ['start', 'end'].map(side => {
    const id = field(sc.body, side + '-diagram-object').value;
    if (sourceGuids[id - 1] === '0'.repeat(32)) return null;
    const shape = sg.objects.get(id);
    if (shape?.className !== 'Axure:DiagramObject:VectorShape') throw new Error('Only flat VectorShape endpoints are supported');
    if (!sourceRoots.has(shape.id)) throw new Error('Endpoint must be directly on the source Page');
    const key = sourceGuids[field(sc.body, side + '-connector-id').value - 1];
    if (!Object.values(CONNECTOR_POINTS).some(point => point.guid === key)) throw new Error('Custom connector point keys are not supported');
    return { shape, key };
  });
  const closure = closureOf(sg, sc.id);
  for (const endpoint of endpoints) if (endpoint) for (const id of closureOf(sg, endpoint.shape.id)) closure.add(id);
  const clone = cloneInto({ srcGraph: sg, srcStrings: sr.strings, dstGraph: tg, dstStrings: strings, closure, rootOldId: sc.id });
  const guids = tg.roots.find(n => n.tag === 0x1e).values;
  const keepGuid = raw => { let index = guids.indexOf(raw) + 1; if (!index) { guids.push(raw); index = guids.length; } return index; };
  const connector = tg.objects.get(clone.rootNewId);
  const nameObject = (object, text) => {
    const node = field(field(object.body, 'name-block'), 'text');
    let index = strings.indexOf(text); if (index < 0) { index = strings.length; strings.push(text); }
    node.value = index + 1; node.text = text;
  };
  nameObject(connector, name);
  const roots = [connector];
  for (let i = 0; i < endpoints.length; i++) {
    const side = i ? 'end' : 'start', endpoint = endpoints[i];
    if (!endpoint) continue;
    const shape = tg.objects.get(clone.idMap.get(endpoint.shape.id));
    field(connector.body, side + '-diagram-object').value = shape.id;
    field(connector.body, side + '-connector-id').value = keepGuid(endpoint.key);
    if (!roots.includes(shape)) { roots.push(shape); nameObject(shape, i ? endName : startName); }
  }
  // The source Diagram is outside the closure; all copied flat objects attach here.
  walkNodes(clone.created, node => {
    for (const [key, value] of node.entries ?? []) if (key.text === 'parent-diagram-id') value.value = diagram.id;
  });
  for (const object of roots) {
    const style = tg.objects.get(field(object.body, 'MyStyle').value);
    const position = field(style.body, 'PropList').items.find(p => field(p, 'DOAName')?.value === 3221225573);
    const value = field(position, 'Value');
    field(value, 'X').value += dx; field(value, 'Y').value += dy;
    field(diagram.body, 'diagram-objects').items.push({ tag: 3, value: object.id });
  }
  field(connector.body, 'end-point-x').value += dx;
  field(connector.body, 'end-point-y').value += dy;
  for (const point of field(connector.body, 'control-points').items) for (const key of ['Path', 'LowerHandle', 'HigherHandle']) {
    const value = field(point, key);
    if (value) { field(value, 'X').value += dx; field(value, 'Y').value += dy; }
  }
  tg.roots.splice(tg.roots.length - 1, 0, ...clone.created);
  const output = replaceRecord(target, tr, encodeRecord(tr, strings, encodePayload(tg.roots)));
  writeFileSync(outputFile, output, { flag: 'wx' });
  return { outputFile, connector: connector.id, shapes: roots.slice(1).map(o => o.id), name, dx, dy };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, target, output, record, connector, page, options = '{}'] = process.argv.slice(2);
  if (!page) throw new Error('Usage: node clone-native-connector.mjs <source.rp> <target.rp> <output.rp> <sourceRecord> <connectorId> <targetPage> [options-json]');
  console.log(JSON.stringify(cloneNativeConnector(source, target, output, record, connector, page, JSON.parse(options)), null, 2));
}
