// Import a closed Page layout into a native PanelState; images must be embedded.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readRecords, readManifest, encodeManifest, encodeRecord, replaceRecord, insertRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { closureOf, cloneInto } from './clone-closure.mjs';
import { guidKey } from './duplicate-page.mjs';
import { removePanelStateContent, resolvePanelState } from './remove-panel-state-content.mjs';
import { fixPanelRegistry } from './fix-panel-registry.mjs';
import { detectFileVersion } from './version.mjs';

const unique = (items, label) => {
  if (items.length !== 1) throw new Error(`${label} must be unique; found ${items.length}`);
  return items[0];
};

export function fillPanelState(source, target, { sourcePage, targetPage, targetMaster, panel, state, append = false, replace = false, version }) {
  // 目标版本决定克隆体落地前的裁剪；不传时按目标文件头判。
  const targetVersion = version ?? detectFileVersion(target);
  if (append && replace) throw new Error('append and replace cannot be combined');
  let removal;
  if (replace) {
    const result = removePanelStateContent(target, { page: targetPage, master: targetMaster, panel, state, all: true });
    target = result.file;
    removal = result.report;
  }
  const sourceMeta = unique(readRp(source).pages.filter(p => p.name === sourcePage), `Source page ${sourcePage}`);
  const { ownerRecord, stateRecord: targetRecord } = resolvePanelState(target, { page: targetPage, master: targetMaster, panel, state });
  const sourceRecord = readRecords(source).find(r => r.index === sourceMeta.record);
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
  const supported = new Set(['VectorShape', 'TextBox', 'TextArea', 'Checkbox', 'RadioButton', 'ComboBox', 'ListBox', 'Layer', 'Table', 'TableCell', 'ImageBox', 'DynamicPanel', 'Repeater', 'ReferenceDiagramObject', 'Connector']);
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
    const dataSetToColumns = new Map();
    const dataSetToColumnIds = new Map();
    const expressionOwners = new Map();
    const repeaterToDataSet = new Map();
    for (const repeater of repeaters) {
      const dataId = field(repeater.body, 'Data')?.value;
      repeaterToDataSet.set(repeater.id, dataId);
      const data = graph.objects.get(dataId);
      const cols = new Set(field(data?.body ?? {}, 'columns')?.items.map(item => field(graph.objects.get(item.value)?.body, 'name')?.text).filter(Boolean) ?? []);
      dataSetToColumns.set(dataId, cols);
      dataSetToColumnIds.set(dataId, new Set((field(data?.body ?? {}, 'columns')?.items ?? [])
        .map(item => field(graph.objects.get(item.value)?.body ?? {}, 'variable-id')?.value).filter(Boolean)));
      const item = graph.objects.get(field(repeater.body, 'BaseDiagram')?.value);
      const owners = [repeater, ...(field(item?.body ?? {}, 'diagram-objects')?.items ?? [])
        .map(ref => graph.objects.get(ref.value)).filter(Boolean)];
      for (const owner of owners) {
        const map = field(owner.body, 'InteractionMap')?.value;
        if (!map) continue;
        for (const id of closureOf(graph, map)) {
          if (graph.objects.get(id)?.className !== 'Axure:Expr:StringLiteral') continue;
          if (!expressionOwners.has(id)) expressionOwners.set(id, new Set());
          expressionOwners.get(id).add(dataId);
        }
      }
    }
    const sourceGuids = graph.roots.find(n => n.tag === 0x1e).values;
    const nonNullScope = id => id && sourceGuids[id - 1] !== '0'.repeat(32) ? id : undefined;
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
    const isInteractionAction = cls => cls && (
      cls.startsWith('Axure:Interaction') ||
      cls.startsWith('Axure.Interaction') ||
      cls.startsWith('Axure:Interation') ||
      cls.endsWith('Action')
    );
    const verifiedActions = new Set([
      'Axure:InteractionTreeMap', 'Axure:InteractionCase', 'Axure:InteractionEvent',
      'Axure:InteractionSetPanelStateAction', 'Axure:InteractionAddItemsToDataSetAction',
      'Axure:InteractionDeleteItemsFromDataSetAction', 'Axure:InteractionUpdateEditItemsInDataSetAction',
      'Axure:InteractionFadeWidgetAction', 'Axure:InteractionWaitAction',
      'Axure:InteractionMoveWidgetAction', 'Axure:InteractionEnableDisableWidgetsAction',
      'Axure:InteractionSetFocusOnWidgetAction',
      'Axure:InterationActionSetFunction',
      'Axure:InteractionSetWidgetSizeAction',
      'Axure:InteractionRotateWidgetAction',
      'Axure:InteractionSetOpacityAction',
      'Axure:InteractionSetPanelOrderAction',
      'Axure.InteractionAddFilterToRepeaterAction',
      'Axure:InteractionAddFilterToRepeaterAction',
      'Axure:InteractionRemoveFilterFromRepeaterAction',
      'Axure:InteractionRemoveSortFromRepeaterAction',
      'Axure:InteractionSetItemPerRepeaterPageAction'
    ]);
    if (isInteractionAction(object?.className) && !verifiedActions.has(object.className))
      throw new Error(`State import has not verified ${object.className}; add the interaction after importing`);
    if (object?.className === 'Axure:InterationActionSetFunction' && !['SetWidgetFormText', 'SetWidgetRichText'].includes(field(object.body, 'SetFunction')?.text))
      throw new Error(`State import has not verified set function ${field(object.body, 'SetFunction')?.text}`);
    if (object?.className === 'Axure:FadeWidgetInfo' && field(object.body, 'show-type')?.value !== 0)
      throw new Error('State import only preserves standard fade show/hide actions; lightbox/flyout are not verified');
    if (object?.className === 'Axure:MoveWidgetInfo') {
      const boundary = field(object.body, 'BoundaryCondition')?.value;
      const boundaryGuid = boundary ? graph.roots.find(n => n.tag === 0x1e)?.values[boundary - 1] : null;
      if (boundaryGuid && boundaryGuid !== '0'.repeat(32))
        throw new Error('State import move actions require boundary condition to be unconstrained');
      if (field(object.body, 'scope')?.entries?.length)
        throw new Error('State import move actions require empty variable scope');
    }
    if (object?.className === 'Axure:Expr:FCall' && !['SetWidgetFormText', 'SetWidgetRichText', 'GetWidgetText'].includes(field(object.body, 'function-name')?.text))
      throw new Error('State import only preserves local form/rich text assignment; external scopes are not copied');
    if (object?.className === 'Axure:Expr:StringLiteral') {
      const text = field(object.body, 'value')?.text;
      if (text?.includes('[[')) {
        const itemCols = [...text.matchAll(/Item\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
        const userCols = itemCols.filter(c => !['index', 'Repeater'].includes(c));
        const scopeEntries = field(object.body, 'scope')?.entries ?? [];
        let isRepeaterRule = false;
        if (itemCols.length > 0 && scopeEntries.length === 0) {
          let targetScopeId = nonNullScope(field(object.body, 'TargetRepeaterScope')?.value)
            ?? nonNullScope(field(object.body, 'repeater-scope')?.value);
          let targetDataSetId = repeaterToDataSet.has(targetScopeId) ? repeaterToDataSet.get(targetScopeId) : targetScopeId;
          // scope 指向的既不是本闭包的 repeater、也不是已知数据集时，**必须置空**让下面几条兜底生效。
          // 原生库的中继器就是这种形状：Repeater.Data 指向一个 DataSet，而单元格字面量的
          // repeater-scope 指向**另一个** DataSet；此时 targetDataSetId 会是个陌生 id，
          // 不置空就会直接抛错，把「按列 id 匹配」「expressionOwners」「唯一 repeater」全跳过。
          if (targetDataSetId && !dataSetToColumns.has(targetDataSetId)) targetDataSetId = undefined;
          if (!targetDataSetId) {
            // Native Item-load literals can carry null scopes; their column identities
            // identify the owning dataset even when multiple repeaters share a name.
            const columnIds = (field(object.body, 'variable-identifiers')?.items ?? [])
              .map(item => field(graph.objects.get(item.value)?.body ?? {}, 'Id')?.value).filter(Boolean);
            const candidates = [...dataSetToColumnIds].filter(([, ids]) =>
              columnIds.length > 0 && columnIds.every(id => ids.has(id))).map(([id]) => id);
            if (candidates.length === 1) targetDataSetId = candidates[0];
            if (!targetDataSetId && expressionOwners.get(object.id)?.size === 1)
              targetDataSetId = [...expressionOwners.get(object.id)][0];
          }
          if (!targetDataSetId && repeaters.length === 1) {
            targetDataSetId = repeaterToDataSet.get(repeaters[0].id);
          }
          if (targetDataSetId && dataSetToColumns.has(targetDataSetId)) {
            const allowedCols = dataSetToColumns.get(targetDataSetId);
            if (userCols.length > 0) {
              isRepeaterRule = userCols.every(col => allowedCols.has(col));
              if (!isRepeaterRule)
                throw new Error(`State import rule column does not belong to the target dataset`);
            } else {
              // 仅包含 Item.index 或 Item.Repeater 内置属性的合法中继器规则
              isRepeaterRule = true;
            }
          } else {
            throw new Error(`State import rule expression cannot resolve target dataset scope; ambiguous or unmapped repeater target (object #${object.id}: ${text})`);
          }
        }
        const isLocalVarBinding = scopeEntries.length > 0 && scopeEntries.every(([k, v]) => {
          const callObj = graph.objects.get(v.value);
          if (callObj?.className !== 'Axure:Expr:FCall' || field(callObj.body, 'function-name')?.text !== 'GetWidgetText') return false;
          const arg = field(callObj.body, 'args')?.items?.[0];
          const pathObj = graph.objects.get(arg?.value);
          const targetId = field(pathObj?.body ?? {}, 'object-id')?.value;
          return ids.has(targetId);
        });
        if (!isRepeaterRule && !isLocalVarBinding)
          throw new Error('State import expressions must be local repeater column values or local variable bindings inside the imported layout');
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
    if (object?.className === 'Axure:DiagramObject:Connector') {
      const sourceGuids = graph.roots.find(n => n.tag === 0x1e).values;
      for (const side of ['start', 'end']) {
        const shapeId = field(object.body, side + '-diagram-object')?.value;
        if (shapeId && sourceGuids[shapeId - 1] !== '0'.repeat(32)) {
          if (!ids.has(shapeId)) throw new Error('Connector endpoints must belong to the imported layout');
          const shape = graph.objects.get(shapeId);
          if (shape?.className !== 'Axure:DiagramObject:VectorShape')
            throw new Error('Only flat VectorShape endpoints are supported for imported connectors');
        }
      }
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
      const stateType = field(object.body, 'set-state-type')?.value;
      if (stateType === 0) {
        const guid = sourceGuids[field(object.body, 'diagram-id')?.value - 1];
        if (!packages.has(guid))
          throw new Error('State import only preserves explicit state switches within copied panel packages');
      } else if (stateType === 1 || stateType === 2) {
        // next(1) 或 previous(2) 相对切换：无需绑定固定 GUID，作用于闭包内 target panel
      } else {
        throw new Error(`State import only preserves explicit state switches (0) or relative transitions (next=1, previous=2); received type ${stateType}`);
      }
    }
  }
  const guids = tg.roots.find(n => n.tag === 0x1e).values;
  if (!guids.includes('0'.repeat(32))) guids.push('0'.repeat(32));
  const strings = [...targetRecord.strings];
  const clone = cloneInto({ srcGraph: sg, srcStrings: sourceRecord.strings, dstGraph: tg, dstStrings: strings, closure, rootOldId: roots[0], version: targetVersion });
  for (const oldId of closure) {
    const old = sg.objects.get(oldId), current = tg.objects.get(clone.idMap.get(oldId));
    if (!old?.className.startsWith('Axure:DiagramObject:')) continue;
    const oldProps = field(field(old.body, 'name-block') ?? {}, 'property-dictionary');
    const props = field(field(current.body, 'name-block') ?? {}, 'property-dictionary');
    if (field(oldProps ?? {}, 'parent-diagram-id')?.value === sourceDiagram.id)
      field(props, 'parent-diagram-id').value = targetDiagram.id;
  }
  field(targetDiagram.body, 'diagram-objects').items.push(...roots.map(id => ({ tag: 3, value: clone.idMap.get(id) })));
  const keepGuid = raw => { let index = guids.indexOf(raw) + 1; if (!index) { guids.push(raw); index = guids.length; } return index; };
  const ensureString = text => { let index = strings.indexOf(text); if (index < 0) { index = strings.length; strings.push(text); } return { tag: 8, value: index + 1, text }; };
  const sourceGuids = sg.roots.find(n => n.tag === 0x1e).values;
  for (const oldId of closure) {
    const oldObj = sg.objects.get(oldId);
    if (oldObj?.className !== 'Axure:DiagramObject:Connector') continue;
    const currentConn = tg.objects.get(clone.idMap.get(oldId));
    if (!currentConn) continue;
    for (const side of ['start', 'end']) {
      const oldShapeId = field(oldObj.body, side + '-diagram-object')?.value;
      if (!oldShapeId || sourceGuids[oldShapeId - 1] === '0'.repeat(32)) continue;
      const oldKeyGuid = sourceGuids[field(oldObj.body, side + '-connector-id')?.value - 1];
      if (oldKeyGuid) field(currentConn.body, side + '-connector-id').value = keepGuid(oldKeyGuid);
      const dirVal = field(oldObj.body, side + '-point-direction')?.value;
      if (dirVal !== undefined) {
        const dirNode = field(currentConn.body, side + '-point-direction');
        if (dirNode) dirNode.value = dirVal;
      }
      const oldShape = sg.objects.get(oldShapeId);
      const targetShape = tg.objects.get(clone.idMap.get(oldShapeId));
      const srcPoints = field(oldShape?.body ?? {}, 'ConnectorPoints');
      if (targetShape && srcPoints?.tag === 1 && Array.isArray(srcPoints.entries)) {
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
        let targetPoints = field(targetShape.body, 'ConnectorPoints');
        if (!targetPoints) {
          targetPoints = { tag: 1, entries: dstPointsEntries };
          const key = ensureString('ConnectorPoints');
          const insertion = targetShape.body.entries.findIndex(([name]) => name.text === 'AutoFitHeight');
          if (insertion < 0) targetShape.body.entries.push([key, targetPoints]);
          else targetShape.body.entries.splice(insertion, 0, [key, targetPoints]);
        } else {
          targetPoints.entries = dstPointsEntries;
        }
      }
    }
  }
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
    const pageRecord = ownerRecord;
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
        const infoClone = cloneInto({ srcGraph: sourceDoc, srcStrings: sourceDocRecord.strings, dstGraph: doc, dstStrings: docStrings, closure: closureOf(sourceDoc, pkg.info.id), version: targetVersion });
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
      const pageInfo = unique([...doc.objects.values()].filter(o => o.className === (targetMaster ? 'Axure:MasterPackageInfo' : 'Axure:PackageInfo')
        && docGuids[field(o.body, 'package-id')?.values?.[1] - 1] === packageGuid(parsePayload(pageRecord))), 'Owner package info');
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
        const before = readRecords(output).find(r => targetMaster
          ? r.className === 'Axure:Master' && packageGuid(parsePayload(r)) === packageGuid(parsePayload(ownerRecord))
          : r.className === 'Axure:DesignDocument');
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
  const panelRegistry = fixPanelRegistry(output);
  return { file: panelRegistry.file, report: { sourcePage, ...(targetMaster ? { targetMaster } : { targetPage }), panel, state, append, replace, ...(removal ? { removal } : {}), record: targetRecord.index, roots: roots.length, objects: clone.created.length, statePackages: packages.size, masterPackages: masters.size, panelRegistry: panelRegistry.report } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceFile, targetFile, outputFile, sourcePage, owner, panel, state, ...options] = process.argv.slice(2);
  if (!state || new Set(options).size !== options.length || options.some(item => !['--append', '--replace', '--master'].includes(item)))
    throw new Error('Usage: node fill-panel-state.mjs <source.rp> <target.rp> <new.rp> <sourcePage> <pageOrMaster> <panel> <state> [--master] [--append | --replace]');
  const result = fillPanelState(readFileSync(sourceFile), readFileSync(targetFile), { sourcePage, ...(options.includes('--master') ? { targetMaster: owner } : { targetPage: owner }), panel, state, append: options.includes('--append'), replace: options.includes('--replace') });
  writeFileSync(outputFile, result.file, { flag: 'wx' });
  console.log(JSON.stringify(result.report, null, 2));
}
