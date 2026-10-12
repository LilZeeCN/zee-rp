// Import a closed Page layout into a native PanelState; images must be embedded.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readRecords, readManifest, encodeManifest, encodeRecord, replaceRecord, insertRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { closureOf, cloneInto } from './clone-closure.mjs';
import { guidKey } from './duplicate-page.mjs';
import { removePanelStateContent } from './remove-panel-state-content.mjs';

const unique = (items, label) => {
  if (items.length !== 1) throw new Error(`${label} must be unique; found ${items.length}`);
  return items[0];
};

export function fillPanelState(source, target, { sourcePage, targetPage, panel, state, append = false, replace = false }) {
  if (append && replace) throw new Error('append and replace cannot be combined');
  let removal;
  if (replace) {
    const result = removePanelStateContent(target, { page: targetPage, panel, state, all: true });
    target = result.file;
    removal = result.report;
  }
  const sourceMeta = unique(readRp(source).pages.filter(p => p.name === sourcePage), `Source page ${sourcePage}`);
  const page = unique(readRp(target).pages.filter(p => p.name === targetPage), `Target page ${targetPage}`);
  const widget = unique(page.widgets.filter(w => w.name === panel && w.type === 'DynamicPanel'), `Panel ${panel}`);
  const stateMeta = unique(widget.panel.filter(s => s.name === state), `State ${state}`);
  const sourceRecord = readRecords(source).find(r => r.index === sourceMeta.record);
  const targetRecord = readRecords(target).find(r => r.index === stateMeta.record && r.className === 'Axure:PanelState');
  if (!targetRecord) throw new Error('Target PanelState record not found');
  const sg = parsePayload(sourceRecord), tg = parsePayload(targetRecord);
  const sourcePageObject = [...sg.objects.values()].find(o => o.className === 'Axure:Page');
  const sourceDiagram = sg.objects.get(field(sourcePageObject.body, 'diagram').value);
  const targetDiagram = [...tg.objects.values()].find(o => o.className === 'Axure:PanelDiagram');
  const roots = field(sourceDiagram.body, 'diagram-objects').items.map(n => n.value);
  if (!roots.length) throw new Error('Source page has no content');
  const existingRoots = field(targetDiagram.body, 'diagram-objects').items;
  if (existingRoots.length && !append)
    throw new Error('Target state must be empty; existing state contents are preserved');

  const closure = new Set();
  for (const id of roots) for (const item of closureOf(sg, id)) closure.add(item);
  const supported = new Set(['VectorShape', 'TextBox', 'TextArea', 'Checkbox', 'RadioButton', 'ComboBox', 'ListBox', 'Layer', 'Table', 'TableCell', 'ImageBox', 'DynamicPanel', 'Repeater', 'ReferenceDiagramObject']);
  const existingNames = new Set([...tg.objects.values()].filter(o => o.className.startsWith('Axure:DiagramObject:'))
    .map(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text).filter(Boolean));
  const packageGuid = graph => graph.roots.find(n => n.tag === 0x1e).values[graph.roots.find(n => n.tag === 0x12).value - 1];
  const sourceRecords = readRecords(source);
  const sourceStates = new Map(sourceRecords.filter(r => r.className === 'Axure:PanelState').map(record => {
    const graph = parsePayload(record);
    return [packageGuid(graph), { record, graph }];
  }));
  const sourceMasters = new Map(sourceRecords.filter(r => r.className === 'Axure:Master').map(record => {
    const graph = parsePayload(record);
    return [packageGuid(graph), { record, graph }];
  }));
  const sourceDocRecord = sourceRecords.find(r => r.className === 'Axure:DesignDocument');
  const sourceDoc = parsePayload(sourceDocRecord);
  const sourceDocGuids = sourceDoc.roots.find(n => n.tag === 0x1e).values;
  const masterInfos = new Map([...sourceDoc.objects.values()].filter(o => o.className === 'Axure:MasterPackageInfo')
    .map(o => [sourceDocGuids[field(o.body, 'package-id').values[1] - 1], o]));
  const packages = new Map();
  const masters = new Map();
  const visitingMasters = new Set(), masterOrder = [], pageMasters = new Set();
  const validate = (graph, ids, checkNames, owner = null) => {
    const repeaters = [...ids].map(id => graph.objects.get(id)).filter(o => o?.className === 'Axure:DiagramObject:Repeater');
    const columns = new Set(repeaters.flatMap(repeater => {
      const data = graph.objects.get(field(repeater.body, 'Data')?.value);
      return field(data?.body ?? {}, 'columns')?.items.map(item => field(graph.objects.get(item.value).body, 'name')?.text) ?? [];
    }));
    const localDataset = id => graph.roots.find(n => n.tag === 0x1e).values[id - 1] === '0'.repeat(32)
      || (ids.has(id) && graph.objects.get(id)?.className === 'Axure:DocumentModel:DataSet');
    const overridePaths = new Set();
    for (const id of ids) {
      const instance = graph.objects.get(id);
      if (instance?.className !== 'Axure:DiagramObject:ReferenceDiagramObject') continue;
      const pair = field(instance.body, 'ReferredMaster');
      const table = graph.roots.find(n => n.tag === 0x1e).values;
      const guid = table[pair?.values?.[1] - 1];
      if (owner === null) pageMasters.add(guid);
      includeMaster(guid);
      const overrides = field(instance.body, 'ObjectOverrides');
      if (!overrides) continue;
      if (overrides.tag !== 2 || overrides.items.length % 2)
        throw new Error('State import overrides require the native alternating path/value list');
      const targetGraphs = [masters.get(guid).graph, ...[...packages.values()].filter(pkg => pkg.owner === guid).map(pkg => pkg.graph)];
      const targetWidgets = new Map(targetGraphs.flatMap(targetGraph => {
        const guids = targetGraph.roots.find(n => n.tag === 0x1e).values;
        return [...targetGraph.objects.values()].filter(o => o.className.startsWith('Axure:DiagramObject:')).map(o => [guids[o.id - 1], o]);
      }));
      for (let i = 0; i < overrides.items.length; i += 2) {
        const ref = overrides.items[i], value = overrides.items[i + 1];
        const path = graph.objects.get(ref.value);
        const target = targetWidgets.get(table[field(path?.body ?? {}, 'object-id')?.value - 1]);
        if (ref.tag !== 3 || path?.className !== 'Axure:DiagramObjectPath'
          || field(path.body, 'object-id')?.tag !== 0x16 || field(path.body, 'is-dummy')?.value
          || field(path.body, 'rdo-path')?.items.length || field(path.body, 'repeater-path')?.items.length || !target)
          throw new Error('State import override targets must be direct widgets in the referenced master or its panel states');
        if (value.tag !== 1 || value.entries.some(([key]) => !['Text', 'Image', 'ViewId'].includes(key.text))
          || field(value, 'Text')?.tag !== 8 || field(value, 'ViewId')?.tag !== 0x11
          || table[field(value, 'ViewId').value - 1] !== '0'.repeat(32))
          throw new Error('State import overrides only preserve native base-view Text/Image fields');
        const image = field(value, 'Image'), stream = field(image ?? {}, 'Stream');
        if (image?.tag !== 1 || image.entries.some(([key]) => !['Hash', 'Stream', 'Extension'].includes(key.text)))
          throw new Error('State import override images require the native embedded image dictionary');
        if (stream) {
          if (target.className !== 'Axure:DiagramObject:ImageBox' || stream.tag !== 4 || !stream.value
            || field(image, 'Extension')?.text !== '.png')
            throw new Error('State import override images require an embedded PNG targeting ImageBox');
        } else if (field(image, 'Hash')?.text || field(image, 'Extension')
          || !['VectorShape', 'Checkbox', 'RadioButton'].includes(target.className.split(':').at(-1)))
          throw new Error('State import text overrides only preserve native shape/checkbox/radio labels');
        overridePaths.add(path.id);
      }
    }
    const usesOverridePath = node => node?.tag === 3 && overridePaths.has(node.value)
      || node?.items?.some(usesOverridePath) || node?.entries?.some(([, value]) => usesOverridePath(value));
    for (const id of ids) {
    const object = graph.objects.get(id);
    const body = object?.className === 'Axure:DiagramObject:ReferenceDiagramObject'
      ? { tag: 1, entries: object.body.entries.filter(([key]) => key.text !== 'ObjectOverrides') } : object?.body;
    if (usesOverridePath(body)) throw new Error('State import override paths cannot also be used as interaction targets');
    if (object?.className.startsWith('Axure:DiagramObject:')) {
      const name = field(field(object.body, 'name-block') ?? {}, 'text')?.text;
      if (checkNames && name && existingNames.has(name)) throw new Error(`Imported widget name already exists in the state: ${name}`);
    }
    if (object?.className.startsWith('Axure:DiagramObject:') && !supported.has(object.className.split(':').at(-1)))
      throw new Error(`State import does not yet copy packages/resources for ${object.className}`);
    if (object?.className === 'Axure:DiagramObject:ImageBox') {
      const style = graph.objects.get(field(object.body, 'MyStyle')?.value);
      const property = field(style?.body ?? {}, 'PropList')?.items.find(p => (field(p, 'DOAName')?.value & 0x0fffffff) === 27);
      const value = property && field(property, 'Value');
      if (field(value ?? {}, 'Stream')?.tag !== 4 || !field(value ?? {}, 'Stream')?.value
        || !field(value ?? {}, 'Extension')?.text)
        throw new Error('State import images require an embedded Stream and Extension in the local native style');
    }
    if (object?.className.startsWith('Axure:Interaction') && !['Axure:InteractionTreeMap', 'Axure:InteractionCase', 'Axure:InteractionEvent', 'Axure:InteractionSetPanelStateAction', 'Axure:InteractionAddItemsToDataSetAction', 'Axure:InteractionDeleteItemsFromDataSetAction', 'Axure:InteractionUpdateEditItemsInDataSetAction'].includes(object.className))
      throw new Error(`State import has not verified ${object.className}; add the interaction after importing`);
    if (object?.className === 'Axure:Expr:FCall' && !['SetWidgetFormText', 'SetWidgetRichText'].includes(field(object.body, 'function-name')?.text))
      throw new Error('State import only preserves local form/rich text assignment; external scopes are not copied');
    if (object?.className === 'Axure:Expr:StringLiteral') {
      const text = field(object.body, 'value')?.text;
      if (text?.includes('[[')) {
        const row = /^\[\[Item\.([A-Za-z_][A-Za-z_0-9]*)(?:\s*==\s*(?:'[^']*'|"[^"]*"))?\]\]$/.exec(text);
        if (!row || !columns.has(row[1]) || field(object.body, 'scope')?.entries.length)
          throw new Error('State import expressions must be local repeater column values or single-column equality rules');
      }
      for (const key of ['repeater-scope', 'TargetRepeaterScope']) {
        const scope = field(object.body, key);
        if (scope && !localDataset(scope.value)) throw new Error('State import expression dataset scopes must belong to the imported layout');
      }
    }
    if (object?.className === 'Axure:DiagramObjectPath' && !overridePaths.has(id)) {
      const localId = field(object.body, 'object-id')?.value;
      const repeaterPath = field(object.body, 'repeater-path')?.items ?? [];
      if (!ids.has(localId) || field(object.body, 'rdo-path')?.items.length
        || repeaterPath.some(item => !ids.has(item.value) || graph.objects.get(item.value)?.className !== 'Axure:DiagramObject:Repeater'))
        throw new Error('State import interaction targets must belong to the imported layout');
    }
    if (object?.className === 'Axure:DiagramObject:DynamicPanel') {
      const sourceGuids = graph.roots.find(n => n.tag === 0x1e).values;
      for (const pair of field(object.body, 'panel-diagrams').items) {
        const guid = sourceGuids[pair.values[1] - 1], pkg = sourceStates.get(guid);
        if (!pkg) throw new Error(`Nested panel state package is missing: ${guid}`);
        if (packages.has(guid)) continue;
        packages.set(guid, { ...pkg, owner });
        validate(pkg.graph, new Set(pkg.graph.objects.keys()), false, owner);
      }
    }
  } };
  const includeMaster = guid => {
    if (visitingMasters.has(guid)) throw new Error('State import master dependencies must not contain cycles');
    if (masters.has(guid)) return;
    const pkg = sourceMasters.get(guid), info = masterInfos.get(guid);
    if (!pkg || !info) throw new Error(`Referenced master package or registration is missing: ${guid}`);
    for (const key of ['LoadedRdoPackages', 'LoadedScreenshotPackages'])
      if (field(info.body, key)?.items.length) throw new Error(`State import master ${key} are not yet verified`);
    const dependencies = (field(info.body, 'dependencies')?.items ?? []).map(item => {
      const [pair, kind] = item.items ?? [];
      if (item.tag !== 2 || item.items.length !== 2 || pair.tag !== 0x13
        || sourceDocRecord.strings[pair.values[0] - 1] !== 'Axure:MasterPackageInfo' || kind.tag !== 5 || kind.value !== 2)
        throw new Error('State import master dependencies require the verified native MasterPackageInfo/type 2 pair');
      return sourceDocGuids[pair.values[1] - 1];
    });
    visitingMasters.add(guid);
    masters.set(guid, { ...pkg, info });
    validate(pkg.graph, new Set(pkg.graph.objects.keys()), false, guid);
    for (const dependency of dependencies) includeMaster(dependency);
    visitingMasters.delete(guid);
    masterOrder.push(guid);
  };
  validate(sg, closure, true);
  for (const [graph, ids] of [[sg, closure], ...[...packages.values(), ...masters.values()].map(pkg => [pkg.graph, new Set(pkg.graph.objects.keys())])]) {
    const sourceGuids = graph.roots.find(n => n.tag === 0x1e).values;
    for (const id of ids) {
      const object = graph.objects.get(id);
      if (object?.className !== 'Axure:SetPanelStateInfo') continue;
      const guid = sourceGuids[field(object.body, 'diagram-id')?.value - 1];
      if (field(object.body, 'set-state-type')?.value !== 0 || !packages.has(guid))
        throw new Error('State import only preserves explicit state switches within copied panel packages');
    }
  }
  const guids = tg.roots.find(n => n.tag === 0x1e).values;
  if (!guids.includes('0'.repeat(32))) guids.push('0'.repeat(32));
  const strings = [...targetRecord.strings];
  const clone = cloneInto({ srcGraph: sg, srcStrings: sourceRecord.strings, dstGraph: tg, dstStrings: strings, closure, rootOldId: roots[0] });
  for (const oldId of closure) {
    const old = sg.objects.get(oldId), current = tg.objects.get(clone.idMap.get(oldId));
    if (!old?.className.startsWith('Axure:DiagramObject:')) continue;
    const oldProps = field(field(old.body, 'name-block') ?? {}, 'property-dictionary');
    const props = field(field(current.body, 'name-block') ?? {}, 'property-dictionary');
    if (field(oldProps ?? {}, 'parent-diagram-id')?.value === sourceDiagram.id)
      field(props, 'parent-diagram-id').value = targetDiagram.id;
  }
  field(targetDiagram.body, 'diagram-objects').items.push(...roots.map(id => ({ tag: 3, value: clone.idMap.get(id) })));
  tg.roots.splice(tg.roots.length - 1, 0, ...clone.created);
  let output = replaceRecord(target, targetRecord, encodeRecord(targetRecord, strings, encodePayload(tg.roots)));
  if (packages.size || masters.size) {
    const identities = new Map([['0'.repeat(32), '0'.repeat(32)]]);
    const sourceGuids = sg.roots.find(n => n.tag === 0x1e).values;
    for (const [oldIndex, mapped] of clone.guidMap)
      identities.set(sourceGuids[oldIndex - 1], guids[mapped.index - 1]);
    const mapIdentity = guid => {
      if (!identities.has(guid)) identities.set(guid, randomBytes(16).toString('hex'));
      return identities.get(guid);
    };
    const pageRecord = readRecords(target).find(r => r.index === page.record);
    const originalManifest = readManifest(target);
    const findNode = (node, predicate) => {
      for (const [key, child] of Object.entries(node.children ?? {})) {
        if (predicate(key, child)) return { key, node: child };
        const found = findNode(child, predicate);
        if (found) return found;
      }
    };
    const ownerKey = findNode(originalManifest.value.root,
      (key, node) => node.parts?.package === pageRecord.offset - 8 - originalManifest.dataStart).key;
    if (masters.size) {
      const docRecord = readRecords(output).find(r => r.className === 'Axure:DesignDocument');
      const doc = parsePayload(docRecord), docStrings = [...docRecord.strings];
      const docGuids = doc.roots.find(n => n.tag === 0x1e).values;
      if (!docGuids.includes('0'.repeat(32))) docGuids.push('0'.repeat(32));
      const root = doc.objects.get(doc.roots.find(n => n.tag === 0xf).value);
      const masterMap = [...doc.objects.values()].find(o => o.className === 'Axure:MasterTreeMap');
      const tree = doc.objects.get(field(masterMap.body, 'tree').value);
      const names = new Set([...doc.objects.values()].filter(o => o.className === 'Axure:MasterPackageInfo').map(o => field(o.body, 'package-name').text));
      const packageIndices = new Map();
      const str = text => {
        let index = docStrings.indexOf(text);
        if (index < 0) { index = docStrings.length; docStrings.push(text); }
        return { tag: 8, value: index + 1, text };
      };
      for (const [guid, pkg] of masters) {
        const name = field(pkg.info.body, 'package-name').text;
        if (names.has(name)) throw new Error(`Imported master name already exists: ${name}`);
        names.add(name);
        const infoClone = cloneInto({ srcGraph: sourceDoc, srcStrings: sourceDocRecord.strings, dstGraph: doc, dstStrings: docStrings, closure: closureOf(sourceDoc, pkg.info.id) });
        for (const [oldIndex, mapped] of infoClone.guidMap)
          docGuids[mapped.index - 1] = mapIdentity(sourceDocGuids[oldIndex - 1]);
        const info = doc.objects.get(infoClone.rootNewId);
        docGuids.push(mapIdentity(guid));
        const packageIndex = docGuids.length;
        packageIndices.set(guid, packageIndex);
        field(info.body, 'package-id').values[1] = packageIndex;
        docGuids.push(randomBytes(16).toString('hex'));
        const nodeId = docGuids.length, ref = value => ({ tag: 3, value });
        const node = { tag: 9, id: nodeId, classIndex: str('Axure:Node').value, className: 'Axure:Node', body: { tag: 1, entries: [
          [str('children'), { tag: 2, items: [] }], [str('parent-node'), ref(tree.id)], [str('tree'), ref(tree.id)]
        ] } };
        field(root.body, 'PackageInfos').items.push(ref(info.id));
        field(masterMap.body, 'node-table').entries.push([ref(nodeId), { tag: 0x13, values: [str('Axure:MasterPackageInfo').value, packageIndex] }]);
        field(tree.body, 'children').items.push(ref(nodeId));
        doc.roots.splice(doc.roots.length - 1, 0, ...infoClone.created, node);
      }
      const pageInfo = [...doc.objects.values()].find(o => o.className === 'Axure:PackageInfo'
        && docGuids[field(o.body, 'package-id')?.values?.[1] - 1] === packageGuid(parsePayload(pageRecord)));
      const pageDependencies = field(pageInfo.body, 'dependencies').items;
      for (const guid of pageMasters) {
        const index = packageIndices.get(guid);
        pageDependencies.push({ tag: 2, items: [{ tag: 0x13, values: [str('Axure:MasterPackageInfo').value, index] }, { tag: 5, value: 2 }] });
      }
      output = replaceRecord(output, docRecord, encodeRecord(docRecord, docStrings, encodePayload(doc.roots)));
      for (const guid of masterOrder) {
        const pkg = masters.get(guid);
        const copied = structuredClone(pkg.graph.roots), table = copied.find(n => n.tag === 0x1e).values;
        for (let i = 0; i < table.length; i++) table[i] = mapIdentity(table[i]);
        const before = readRecords(output).find(r => r.className === 'Axure:DesignDocument');
        output = insertRecord(output, guidKey(mapIdentity(guid)), encodeRecord(pkg.record, pkg.record.strings, encodePayload(copied)), before);
      }
    }
    const copiedKeys = [];
    for (const [guid, pkg] of packages) {
      const copied = structuredClone(pkg.graph.roots);
      const table = copied.find(n => n.tag === 0x1e).values;
      for (let i = 0; i < table.length; i++) table[i] = mapIdentity(table[i]);
      const key = guidKey(mapIdentity(guid));
      // Native states remain siblings under their owning Page or Master node.
      const manifestNow = readManifest(output);
      const stateOwnerKey = pkg.owner ? guidKey(mapIdentity(pkg.owner)) : ownerKey;
      const ownerNode = findNode(manifestNow.value.root, key => key === stateOwnerKey).node;
      const owner = readRecords(output).find(r => r.offset - 8 - manifestNow.dataStart === ownerNode.parts.package);
      output = insertRecord(output, key, encodeRecord(pkg.record, pkg.record.strings, encodePayload(copied)), owner);
      copiedKeys.push({ key, ownerKey: stateOwnerKey });
    }
    const manifest = readManifest(output);
    for (const { key, ownerKey: copiedOwnerKey } of copiedKeys) {
      const ownerNode = findNode(manifest.value.root, key => key === copiedOwnerKey).node;
      ownerNode.children ??= {};
      ownerNode.children[key] = manifest.value.root.children[key];
      delete manifest.value.root.children[key];
      const ordered = { children: ownerNode.children, ...ownerNode };
      for (const key of Object.keys(ownerNode)) delete ownerNode[key];
      Object.assign(ownerNode, ordered);
    }
    output = Buffer.concat([encodeManifest(output, manifest.value), output.subarray(manifest.dataStart)]);
  }
  return { file: output, report: { sourcePage, targetPage, panel, state, append, replace, ...(removal ? { removal } : {}), record: targetRecord.index, roots: roots.length, objects: clone.created.length, statePackages: packages.size, masterPackages: masters.size } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceFile, targetFile, outputFile, sourcePage, targetPage, panel, state, ...options] = process.argv.slice(2);
  const [option] = options;
  if (!state || options.length > 1 || (option && !['--append', '--replace'].includes(option))) throw new Error('Usage: node fill-panel-state.mjs <source.rp> <target.rp> <new.rp> <sourcePage> <targetPage> <panel> <state> [--append | --replace]');
  const result = fillPanelState(readFileSync(sourceFile), readFileSync(targetFile), { sourcePage, targetPage, panel, state, append: option === '--append', replace: option === '--replace' });
  writeFileSync(outputFile, result.file, { flag: 'wx' });
  console.log(JSON.stringify(result.report, null, 2));
}
