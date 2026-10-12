// Write Base-view label/embedded PNG overrides on one existing native instance.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { readRecords, readManifest, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { guidKey } from './duplicate-page.mjs';

const unique = (items, label) => {
  if (items.length !== 1) throw new Error(`${label} must be unique; found ${items.length}`);
  return items[0];
};
const table = graph => graph.roots.find(node => node.tag === 0x1e).values;
const packageGuid = graph => table(graph)[graph.roots.find(node => node.tag === 0x12).value - 1];
const nameOf = object => field(field(object.body, 'name-block') ?? {}, 'text')?.text;

export function setMasterOverrides(input, spec) {
  const records = readRecords(input);
  const record = records.find(record => record.index === spec.record
    && ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(record.className));
  if (!record) throw new Error('record must identify an existing Page, PanelState or Master');
  const graph = parsePayload(record), instance = graph.objects.get(spec.instanceId);
  if (instance?.className !== 'Axure:DiagramObject:ReferenceDiagramObject')
    throw new Error('instanceId must identify an existing ReferenceDiagramObject');
  if (!Array.isArray(spec.overrides) || !spec.overrides.length) throw new Error('overrides must be a nonempty array');
  const guids = table(graph), masterGuid = guids[field(instance.body, 'ReferredMaster')?.values?.[1] - 1];
  const master = unique(records.filter(record => record.className === 'Axure:Master')
    .map(record => ({ record, graph: parsePayload(record) })).filter(pkg => packageGuid(pkg.graph) === masterGuid), 'Referenced master');
  const owner = readManifest(input).value.root.children[guidKey(masterGuid)];
  const targetGraphs = [master.graph, ...records.filter(record => record.className === 'Axure:PanelState')
    .map(record => parsePayload(record)).filter(state => owner?.children?.[guidKey(packageGuid(state))])];
  const targets = targetGraphs.flatMap(graph => [...graph.objects.values()]
    .filter(object => object.className.startsWith('Axure:DiagramObject:'))
    .map(object => ({ object, guid: table(graph)[object.id - 1] })));
  const strings = [...record.strings], defs = [], changes = [], seen = new Set();
  const str = text => {
    let index = strings.indexOf(text);
    if (index < 0) { index = strings.length; strings.push(text); }
    return { tag: 8, value: index + 1, text };
  };
  const map = values => ({ tag: 1, entries: Object.entries(values).map(([key, value]) => [str(key), value]) });
  const guidId = guid => {
    let index = guids.indexOf(guid);
    if (index < 0) { index = guids.length; guids.push(guid); }
    return index + 1;
  };
  const nullId = guidId('0'.repeat(32));
  let list = field(instance.body, 'ObjectOverrides');
  if (!list) {
    list = { tag: 2, items: [] };
    instance.body.entries.push([str('ObjectOverrides'), list]);
  }
  if (list.tag !== 2 || list.items.length % 2) throw new Error('Expected native alternating override path/value list');
  const current = [];
  for (let index = 0; index < list.items.length; index += 2) {
    const ref = list.items[index], path = graph.objects.get(ref.value), value = list.items[index + 1];
    if (ref.tag !== 3 || path?.className !== 'Axure:DiagramObjectPath' || field(path.body, 'object-id')?.tag !== 0x16
      || !targets.some(target => target.guid === guids[field(path.body, 'object-id').value - 1])
      || ['rdo-path', 'repeater-path'].some(key => field(path.body, key)?.tag !== 2 || field(path.body, key).items.length)
      || field(path.body, 'is-dummy')?.tag !== 0x19 || field(path.body, 'is-dummy').value || value?.tag !== 1
      || field(value, 'ViewId')?.tag !== 0x11
      || guids[field(value, 'ViewId')?.value - 1] !== '0'.repeat(32))
      throw new Error('Existing overrides must use direct native Base-view paths');
    current.push({ index, path, value, guid: guids[field(path.body, 'object-id').value - 1] });
  }
  for (const item of spec.overrides) {
    if (!item || Object.keys(item).some(key => !['target', 'targetGuid', 'text', 'imagePath', 'clear'].includes(key)))
      throw new Error('Unknown override field; use target/targetGuid and text, imagePath or clear');
    if ((typeof item.target === 'string') === (typeof item.targetGuid === 'string'))
      throw new Error('Select exactly one target name or targetGuid');
    const target = unique(targets.filter(target => item.targetGuid !== undefined
      ? target.guid === item.targetGuid : nameOf(target.object) === item.target), 'Override target in referenced master');
    if (seen.has(target.guid)) throw new Error('Duplicate override target');
    seen.add(target.guid);
    const modes = [item.text !== undefined, item.imagePath !== undefined, item.clear !== undefined];
    if (modes.filter(Boolean).length !== 1 || (item.clear !== undefined && item.clear !== true))
      throw new Error('Choose exactly one text, imagePath or clear:true operation');
    const matches = current.filter(entry => entry.guid === target.guid);
    if (matches.length > 1) throw new Error('Existing Base override target is duplicated');
    const old = matches[0];
    if (item.clear) {
      if (!old) throw new Error('Cannot clear a target without an existing override');
      old.remove = true;
    } else {
      let image = map({ Hash: str('') }), text = '';
      if (item.text !== undefined) {
        if (typeof item.text !== 'string' || !['VectorShape', 'Checkbox', 'RadioButton'].includes(target.object.className.split(':').at(-1)))
          throw new Error('Text overrides require a string and native shape/checkbox/radio label target');
        text = item.text;
      } else {
        if (target.object.className !== 'Axure:DiagramObject:ImageBox' || typeof item.imagePath !== 'string')
          throw new Error('Image overrides require imagePath and an ImageBox target');
        const bytes = readFileSync(item.imagePath);
        if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
          throw new Error('Image overrides currently require PNG bytes');
        image = map({ Stream: { tag: 4, value: bytes.toString('base64') }, Extension: str('.png'),
          Hash: str(createHash('md5').update(bytes).digest('base64')) });
      }
      const value = map({ Text: str(text), Image: image, ViewId: { tag: 0x11, value: nullId } });
      if (old) list.items[old.index + 1] = value;
      else {
        const id = guidId(randomBytes(16).toString('hex'));
        const path = { tag: 9, id, classIndex: str('Axure:DiagramObjectPath').value, className: 'Axure:DiagramObjectPath',
          body: map({ 'rdo-path': { tag: 2, items: [] }, 'repeater-path': { tag: 2, items: [] },
            'object-id': { tag: 0x16, value: guidId(target.guid) }, 'is-dummy': { tag: 0x19, value: false } }) };
        defs.push(path);
        list.items.push({ tag: 3, value: id }, value);
      }
    }
    changes.push({ targetGuid: target.guid, target: nameOf(target.object) ?? '', operation: item.clear ? 'clear' : item.imagePath ? 'image' : 'text' });
  }
  for (const entry of current.filter(entry => entry.remove).sort((a, b) => b.index - a.index)) list.items.splice(entry.index, 2);
  graph.roots.splice(graph.roots.length - 1, 0, ...defs);
  const file = replaceRecord(input, record, encodeRecord(record, strings, encodePayload(graph.roots)));
  return { file, report: { record: record.index, instanceId: instance.id, instanceGuid: guids[instance.id - 1], masterGuid, addedPaths: defs.length, changes } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output, specFile] = process.argv.slice(2);
  if (!specFile) throw new Error('Usage: node set-master-overrides.mjs source.rp new.rp overrides.json');
  const result = setMasterOverrides(readFileSync(source), JSON.parse(readFileSync(specFile, 'utf8')));
  writeFileSync(output, result.file, { flag: 'wx' });
  console.log(JSON.stringify({ output, ...result.report }, null, 2));
}
