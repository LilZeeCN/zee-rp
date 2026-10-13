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

function copyPropToStrings(prop, strings) {
  const copy = structuredClone(prop);
  walkNodes([copy], node => {
    if (node.tag === 3) {
      throw new Error(`Cannot copy connector style property with unresolved object reference tag 3 (value=${node.value})`);
    }
    if ([0x11, 0x12, 0x14, 0x16].includes(node.tag)) {
      throw new Error(`Cannot copy connector style property with unmapped GUID tag ${node.tag}`);
    }
    if (node.tag === 8) {
      if (typeof node.text !== 'string') throw new Error('Cannot copy connector style property with an unresolved string');
      let index = strings.indexOf(node.text);
      if (index < 0) { strings.push(node.text); index = strings.length - 1; }
      node.value = index + 1;
    }
  });
  return copy;
}

export function cloneNativeConnector(sourceFile, targetFile, outputFile, sourceRecord, connectorId, targetPage, {
  name = 'ANCHORED_CONNECTOR', startName = 'ANCHOR_A', endName = 'ANCHOR_B', dx = 0, dy = 0
} = {}) {
  if (![dx, dy].every(Number.isFinite)) throw new Error('dx/dy must be finite numbers');
  const source = readFileSync(sourceFile), target = readFileSync(targetFile), sourceRecords = readRecords(source);
  const sr = sourceRecords.find(r => r.index === Number(sourceRecord) && ['Axure:Page', 'Axure:PanelState'].includes(r.className));
  if (!sr) throw new Error('Source Page or PanelState record not found');
  const sg = parsePayload(sr), sourceGuids = sg.roots.find(n => n.tag === 0x1e).values;
  const sc = sg.objects.get(Number(connectorId));
  if (sc?.className !== 'Axure:DiagramObject:Connector') throw new Error('Source object must be a native Connector');
  const sourceOwner = [...sg.objects.values()].find(o => o.className === sr.className);
  const sourceDiagram = sg.objects.get(field(sourceOwner.body, 'diagram').value);
  const sourceRoots = new Set(field(sourceDiagram.body, 'diagram-objects').items.map(n => n.value));
  if (!sourceRoots.has(sc.id)) throw new Error('Connector must be directly in the source diagram');
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
    if (!sourceRoots.has(shape.id)) throw new Error('Connector and endpoints must be in the same diagram record');
    const key = sourceGuids[field(sc.body, side + '-connector-id').value - 1];
    const isStandard = Object.values(CONNECTOR_POINTS).some(point => point.guid === key);
    const srcPoints = field(shape.body, 'ConnectorPoints');
    const isCustom = srcPoints?.tag === 1 && Array.isArray(srcPoints.entries) && srcPoints.entries.some(([k]) => sourceGuids[k.value - 1] === key);
    if (!isStandard && !isCustom) throw new Error('Endpoint connector point key not found on shape');
    const direction = field(sc.body, side + '-point-direction')?.value;
    return { shape, key, direction };
  });
  const closure = closureOf(sg, sc.id);
  for (const endpoint of endpoints) if (endpoint) for (const id of closureOf(sg, endpoint.shape.id)) closure.add(id);
  const clone = cloneInto({ srcGraph: sg, srcStrings: sr.strings, dstGraph: tg, dstStrings: strings, closure, rootOldId: sc.id });
  const guids = tg.roots.find(n => n.tag === 0x1e).values;
  const keepGuid = raw => { let index = guids.indexOf(raw) + 1; if (!index) { guids.push(raw); index = guids.length; } return index; };
  const connector = tg.objects.get(clone.rootNewId);
  const sourceLocalStyle = sg.objects.get(field(sc.body, 'MyStyle').value);
  const sourceStyleRef = field(sourceLocalStyle.body, 'PropList').items.find(p => field(p, 'DOAName')?.value === 0xc0000000);
  const sourceStyleGuid = sourceStyleRef ? sourceGuids[field(sourceStyleRef, 'Value').value - 1] : undefined;
  const sourceDesignRecord = sourceRecords.find(r => r.className === 'Axure:DesignDocument');
  const targetRecords = readRecords(target);
  const targetDesignRecord = targetRecords.find(r => r.className === 'Axure:DesignDocument');
  const targetRegisteredStyles = new Set();
  if (targetDesignRecord) {
    const tdg = parsePayload(targetDesignRecord);
    const tdGuids = tdg.roots.find(n => n.tag === 0x1e)?.values ?? [];
    for (const obj of tdg.objects.values()) {
      if (obj.className === 'Axure:Style') {
        const idIdx = field(obj.body, 'Id')?.value;
        if (idIdx && tdGuids[idIdx - 1]) targetRegisteredStyles.add(tdGuids[idIdx - 1]);
      }
    }
  }
  if (sourceStyleGuid && sourceDesignRecord) {
    const design = parsePayload(sourceDesignRecord), designGuids = design.roots.find(n => n.tag === 0x1e).values;
    const inheritedStyle = [...design.objects.values()].find(o => o.className === 'Axure:Style' && designGuids[field(o.body, 'Id')?.value - 1] === sourceStyleGuid);
    const inheritedProps = inheritedStyle && field(inheritedStyle.body, 'PropList')?.items;
    if (inheritedProps && inheritedProps.length) {
      if (!targetRegisteredStyles.has(sourceStyleGuid)
        && inheritedProps.some(p => (field(p, 'DOAName')?.value & 0x0fffffff) === 21))
        throw new Error('Cross-document connector state styles (DOA 21) require the registered source style; state-style migration is not yet verified');
      const localStyle = tg.objects.get(field(connector.body, 'MyStyle').value);
      const localProps = field(localStyle.body, 'PropList').items;
      const localStyleRef = localProps.find(p => field(p, 'DOAName')?.value === 0xc0000000);
      if (localStyleRef) {
        if (targetRegisteredStyles.has(sourceStyleGuid)) {
          field(localStyleRef, 'Value').value = keepGuid(sourceStyleGuid);
        } else {
          // 未在目标文档注册：材料化全部属性，BaseStyle 重置为空哨兵，杜绝悬空引用
          field(localStyleRef, 'Value').value = keepGuid('0'.repeat(32));
        }
      }
      // 扩展材料化属性支持：边框色(8)、线宽(15)、线型(16)、箭头(17)、填充(7)、前景色(6)
      const supportedDoas = [0xc0000008, 0xc000000f, 0xc0000010, 0xc0000011, 0xc0000007, 0xc0000006];
      for (const doa of supportedDoas) {
        const prop = inheritedProps.find(p => field(p, 'DOAName')?.value === doa);
        if (prop && !localProps.some(p => field(p, 'DOAName')?.value === doa)) {
          localProps.push(copyPropToStrings(prop, strings));
        }
      }
    }
  }
  const ensureString = text => {
    let index = strings.indexOf(text);
    if (index < 0) { index = strings.length; strings.push(text); }
    return { tag: 8, value: index + 1, text };
  };
  const nameObject = (object, text) => {
    const node = field(field(object.body, 'name-block'), 'text');
    const s = ensureString(text);
    node.value = s.value; node.text = s.text;
  };
  nameObject(connector, name);
  const roots = [connector];
  for (let i = 0; i < endpoints.length; i++) {
    const side = i ? 'end' : 'start', endpoint = endpoints[i];
    if (!endpoint) continue;
    const shape = tg.objects.get(clone.idMap.get(endpoint.shape.id));
    field(connector.body, side + '-diagram-object').value = shape.id;
    field(connector.body, side + '-connector-id').value = keepGuid(endpoint.key);
    if (endpoint.direction !== undefined) {
      const dirNode = field(connector.body, side + '-point-direction');
      if (dirNode) dirNode.value = endpoint.direction;
    }
    if (!roots.includes(shape)) { roots.push(shape); nameObject(shape, i ? endName : startName); }
    const srcPoints = field(endpoint.shape.body, 'ConnectorPoints');
    if (srcPoints?.tag === 1 && Array.isArray(srcPoints.entries)) {
      const dstPointsEntries = [];
      for (const [k, v] of srcPoints.entries) {
        const ptGuid = sourceGuids[k.value - 1];
        const ptGuidIdx = keepGuid(ptGuid);
        const x = field(v, 'X')?.value ?? 0;
        const y = field(v, 'Y')?.value ?? 0;
        dstPointsEntries.push([
          { tag: 0x11, value: ptGuidIdx },
          { tag: 1, entries: [
            [ensureString('X'), { tag: 6, value: x }],
            [ensureString('Y'), { tag: 6, value: y }]
          ]}
        ]);
      }
      let targetPoints = field(shape.body, 'ConnectorPoints');
      if (!targetPoints) {
        targetPoints = { tag: 1, entries: dstPointsEntries };
        const key = ensureString('ConnectorPoints');
        const insertion = shape.body.entries.findIndex(([name]) => name.text === 'AutoFitHeight');
        if (insertion < 0) shape.body.entries.push([key, targetPoints]);
        else shape.body.entries.splice(insertion, 0, [key, targetPoints]);
      } else {
        targetPoints.entries = dstPointsEntries;
      }
    }
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
