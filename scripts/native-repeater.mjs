import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { closureOf, cloneInto } from './clone-closure.mjs';
import { installRoot, detectFileVersion } from './version.mjs';

// Only the native Repeater shell/style comes from the installed library.
// Its example rows, events and row widgets are replaced before cloning.
export function createNativeRepeater(file, rowFile, plan) {
  if (detectFileVersion(file) !== 9) throw new Error('Native Repeater requires RP 9');
  const library = readFileSync(join(installRoot(9), 'Libraries/Default.rplib'));
  let sourceRecord, sourceGraph, repeater;
  for (const record of readRecords(library).filter(r => r.className === 'Axure:Page')) {
    const graph = parsePayload(record);
    const found = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:Repeater');
    if (found) { sourceRecord = record; sourceGraph = graph; repeater = found; break; }
  }
  if (!repeater) throw new Error('Installed Default library has no Repeater');
  repeater.body.entries = repeater.body.entries.filter(([key]) => key.text !== 'InteractionMap');
  field(repeater.body, 'AdaptiveStyles').items = [];
  const sourceRow = sourceGraph.objects.get(field(repeater.body, 'BaseDiagram').value);
  const sourceData = sourceGraph.objects.get(field(repeater.body, 'Data').value);
  field(sourceRow.body, 'diagram-objects').items = [];
  field(sourceData.body, 'columns').items = [];
  field(sourceData.body, 'rows').items = [];
  const record = readRecords(file).find(r => r.className === 'Axure:Page');
  const graph = parsePayload(record), strings = [...record.strings];
  const page = [...graph.objects.values()].find(o => o.className === 'Axure:Page');
  const diagram = graph.objects.get(field(page.body, 'diagram').value);
  const guids = graph.roots.find(n => n.tag === 30).values;
  const str = text => { let i = strings.indexOf(text); if (i < 0) { i = strings.length; strings.push(text); } return { tag: 8, value: i+1, text }; };
  const int = value => ({ tag: 5, value }), ref = value => ({ tag: 3, value }), guid = value => ({ tag: 17, value });
  const list = items => ({ tag: 2, items });
  const map = obj => ({ tag: 1, entries: Object.entries(obj).map(([k,v]) => [str(k),v]) });
  const newId = () => { guids.push(randomBytes(16).toString('hex')); return guids.length; };
  const cloned = cloneInto({ version: 9, srcGraph: sourceGraph, srcStrings: sourceRecord.strings, dstGraph: graph, dstStrings: strings, closure: closureOf(sourceGraph, repeater.id), rootOldId: repeater.id });
  const rep = graph.objects.get(cloned.rootNewId), created = [...cloned.created];
  const row = graph.objects.get(field(rep.body, 'BaseDiagram').value), data = graph.objects.get(field(rep.body, 'Data').value);
  Object.assign(field(field(rep.body, 'name-block'), 'text'), str(plan.name));
  field(rep.body, 'FitToContent').value = false;
  const setProp = (object, key, value) => {
    const props = field(object.body, 'PropList').items;
    const index = props.findIndex(n => (field(n,'DOAName').value & 0x3fffffff) === key);
    const node = map({ DOAName: int(0xc0000000 + key), Value: value });
    if (index < 0) props.push(node); else props[index] = node;
  };
  const f64 = value => ({ tag: 6, value });
  const style = graph.objects.get(field(rep.body, 'MyStyle').value);
  setProp(style, 101, map({ X: f64(plan.x), Y: f64(plan.y) }));
  setProp(style, 105, map({ Width: f64(plan.w), Height: f64(plan.h) }));
  const repStyle = graph.objects.get(field(rep.body, 'RepeaterStyle').value);
  setProp(repStyle, 1202, f64(0)); setProp(repStyle, 1203, f64(plan.rowGap ?? 0));
  if (plan.pageSize) { setProp(repStyle, 1208, int(plan.pageSize)); }
  const obj = (className, props) => {
    const id = newId(), node = { tag: 9, id, className, classIndex: str(className).value, body: map(props) };
    graph.objects.set(id,node); created.push(node); return node;
  };
  const columns = Object.keys(plan.model).map(name => {
    const vid = newId();
    return obj('Axure:DocumentModel:DataSetProp', { name: str(name), 'variable-id': guid(vid), 'linked-widget-path': ref(guids.indexOf('0'.repeat(32))+1) });
  });
  field(data.body, 'columns').items = columns.map(c => ref(c.id));
  field(data.body, 'rows').items = plan.rows.map(record => {
    const r = obj('Axure:DocumentModel:DataSet:Row', { elements: list([]) });
    field(r.body,'elements').items = columns.map(c => {
      const value = record[field(c.body,'name').text];
      return ref(obj('Axure:DocumentModel:DataSet:Element', {
        'column-id': guid(field(c.body,'variable-id').value), type: int(0), value: str(String(value)),
      }).id);
    });
    return ref(r.id);
  });
  const rowRecord = readRecords(rowFile).find(r => r.className === 'Axure:Page');
  const rowGraph = parsePayload(rowRecord);
  const rowPage = [...rowGraph.objects.values()].find(o => o.className === 'Axure:Page');
  const rowDiagram = rowGraph.objects.get(field(rowPage.body,'diagram').value);
  const roots = field(rowDiagram.body,'diagram-objects').items;
  const closure = new Set(roots.flatMap(n => [...closureOf(rowGraph,n.value)]));
  const content = cloneInto({ version:9, srcGraph:rowGraph, srcStrings:rowRecord.strings, dstGraph:graph, dstStrings:strings, closure, rootOldId:roots[0]?.value });
  field(row.body,'diagram-objects').items = roots.map(n => ref(content.idMap.get(n.value)));
  created.push(...content.created);
  for (const object of [...cloned.created,...content.created]) walkNodes([object.body], n => {
    for (const [key,value] of n.entries ?? []) if (key.text === 'parent-diagram-id') value.value = content.created.includes(object) ? row.id : diagram.id;
  });
  field(diagram.body,'diagram-objects').items.push(ref(rep.id));
  graph.roots.splice(graph.roots.length-1,0,...created);
  return replaceRecord(file,record,encodeRecord(record,strings,encodePayload(graph.roots)));
}
