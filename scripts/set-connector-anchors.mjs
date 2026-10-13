import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRecords, replaceRecord, encodeRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { CONNECTOR_POINTS } from './clone-native-connector.mjs';

const DIRECTION_BY_NAME = Object.fromEntries(Object.entries(CONNECTOR_POINTS).map(([name, point]) => [name, point.direction]));

function customPointDirection({ x, y }) {
  // Mirrors ConnectorPoint.Direction for an unrotated VectorShape.
  if (x > y) return 1 - x > y ? CONNECTOR_POINTS.top.direction : CONNECTOR_POINTS.right.direction;
  return 1 - x > y ? CONNECTOR_POINTS.left.direction : CONNECTOR_POINTS.bottom.direction;
}

function addOrFindCustomPoint(widget, point, { guids, strings, keepGuid }) {
  if (!point || typeof point !== 'object' || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)
    throw new Error('Custom point x and y must be finite normalized values from 0 to 1');
  const direction = point.direction === undefined ? customPointDirection(point) : DIRECTION_BY_NAME[point.direction];
  if (!direction) throw new Error('Custom point direction must be top, left, right, or bottom');

  const ensureString = text => {
    let index = strings.indexOf(text);
    if (index < 0) { strings.push(text); index = strings.length - 1; }
    return { tag: 8, value: index + 1, text };
  };
  const connectorPointsKey = 'ConnectorPoints';
  let points = field(widget.body, connectorPointsKey);
  if (!points) {
    points = { tag: 1, entries: [] };
    const key = ensureString(connectorPointsKey);
    const insertion = widget.body.entries.findIndex(([name]) => name.text === 'AutoFitHeight');
    if (insertion < 0) widget.body.entries.push([key, points]);
    else widget.body.entries.splice(insertion, 0, [key, points]);
  }
  if (points.tag !== 1 || !Array.isArray(points.entries))
    throw new Error('VectorShape ConnectorPoints must be a native GUID-keyed map');

  const add = (guid, x, y) => {
    const index = keepGuid(guid);
    points.entries.push([
      { tag: 0x11, value: index },
      { tag: 1, entries: [[ensureString('X'), { tag: 6, value: x }], [ensureString('Y'), { tag: 6, value: y }]] }
    ]);
    return { index, guid };
  };
  const entriesByGuid = () => new Map(points.entries.map(([key, value]) => [guids[key.value - 1], { key, value }]));
  let byGuid = entriesByGuid();
  for (const standard of Object.values(CONNECTOR_POINTS)) {
    const existing = byGuid.get(standard.guid);
    if (existing) {
      if (Math.abs(field(existing.value, 'X').value - standard.x) > 1e-9 || Math.abs(field(existing.value, 'Y').value - standard.y) > 1e-9)
        throw new Error('Existing default connector point has unexpected coordinates');
    } else {
      add(standard.guid, standard.x, standard.y);
      byGuid = entriesByGuid();
    }
  }

  const match = points.entries.find(([key, value]) => {
    if (!guids[key.value - 1]) throw new Error('Connector point references a missing GUID');
    return Math.abs(field(value, 'X').value - point.x) <= 1e-9 && Math.abs(field(value, 'Y').value - point.y) <= 1e-9;
  });
  if (match) return { index: match[0].value, guid: guids[match[0].value - 1], direction };

  let guid;
  do { guid = randomBytes(16).toString('hex'); } while (guids.includes(guid));
  return { ...add(guid, point.x, point.y), direction };
}

export function setConnectorAnchors(sourceFile, outputFile, pageName, connectorSelector, endpoints) {
  if (!endpoints || typeof endpoints !== 'object' || !['start', 'end'].some(key => Object.hasOwn(endpoints, key)))
    throw new Error('Provide start and/or end as {widget, side}, {widget, point: {x, y}}, {widgetId, side}, {widgetId, point: {x, y}}, or null for a free endpoint');
  const input=readFileSync(sourceFile),summary=readRp(input),pages=summary.pages.filter(page=>page.name===pageName);
  if (pages.length!==1) throw new Error('Page name must be unique');
  const page=pages[0],records=readRecords(input),pageRecord=records.find(r=>r.index===page.record),pagePackage=summary.packages.find(pkg=>pkg.record===page.record);
  if(!pageRecord||!pagePackage)throw new Error('Page record or package is missing');
  const selector=typeof connectorSelector==='string'?{widget:connectorSelector}:connectorSelector;
  if(!selector||typeof selector!=='object')throw new Error('Connector selector must be a name or {record, widgetId}');
  const recordIndex=selector.record===undefined?page.record:Number(selector.record);
  const record=records.find(r=>r.index===recordIndex);
  if(!record||!['Axure:Page','Axure:PanelState'].includes(record.className))throw new Error('Connector record must be the selected Page or one of its PanelState records');
  if(record.index!==page.record){
    const recordPackage=summary.packages.find(pkg=>pkg.record===record.index);
    if(record.className!=='Axure:PanelState'||!recordPackage?.path?.startsWith(`${pagePackage.path}/`))
      throw new Error('PanelState record must belong to the selected Page');
  }
  const graph=parsePayload(record),strings=[...record.strings];
  const owner=[...graph.objects.values()].find(o=>o.className===record.className);
  const diagram=owner&&graph.objects.get(field(owner.body,'diagram')?.value);
  const diagramObjects=field(diagram?.body??{},'diagram-objects')?.items;
  if(!Array.isArray(diagramObjects))throw new Error('Connector record needs a diagram-objects list');
  const roots=new Set(diagramObjects.map(n=>n.value));
  const widgets=record.index===page.record?page.widgets:summary.containedWidgets.filter(w=>w.record===record.index);
  const find=(target,label='Endpoint')=>{
    if(!target||typeof target!=='object')throw new Error(`${label} selector must be {widget}, {widgetId}, or {record, widgetId}`);
    if(target.record!==undefined&&Number(target.record)!==record.index)throw new Error('Connector and endpoints must be in the same diagram record');
    const id=target.widgetId===undefined?target.id:target.widgetId;
    let matches;
    if(id!==undefined){
      const objectId=Number(id);
      matches=widgets.filter(w=>w.id===objectId&&roots.has(objectId));
    }else if(typeof target.widget==='string'){
      matches=widgets.filter(w=>w.name===target.widget&&roots.has(w.id));
    }else throw new Error(`${label} selector requires widget or widgetId`);
    if(matches.length!==1)throw new Error(`${label} must uniquely match a direct object in record ${record.index}`);
    const object=graph.objects.get(matches[0].id);
    if(!object)throw new Error(`${label} object is missing from record ${record.index}`);
    return object;
  };
  const connector=find(selector,'Connector');
  if(connector.className!=='Axure:DiagramObject:Connector')throw new Error('Expected a native Connector');
  const guids=graph.roots.find(n=>n.tag===0x1e).values,nullIndex=guids.indexOf('0'.repeat(32))+1;
  const keepGuid=raw=>{let index=guids.indexOf(raw)+1;if(!index){guids.push(raw);index=guids.length;}return index;};
  for(const side of ['start','end']){
    if(!Object.hasOwn(endpoints,side))continue;
    const spec=endpoints[side];
    if(spec===null){
      field(connector.body,side+'-diagram-object').value=nullIndex;
      field(connector.body,side+'-connector-id').value=nullIndex;
      continue;
    }
    if (!spec || typeof spec !== 'object' || (typeof spec.widget!=='string'&&spec.widgetId===undefined&&spec.id===undefined))
      throw new Error('An endpoint requires a widget name or widgetId and either side or point coordinates');
    const hasSide = Object.hasOwn(spec, 'side'), hasPoint = Object.hasOwn(spec, 'point');
    if (hasSide === hasPoint) throw new Error('Provide exactly one of side or point for an attached endpoint');
    const widget=find(spec);
    if(widget.className!=='Axure:DiagramObject:VectorShape')throw new Error('Only flat VectorShape endpoints are supported');
    const point = hasPoint ? addOrFindCustomPoint(widget,spec.point,{guids,strings,keepGuid}) : CONNECTOR_POINTS[spec.side];
    if(!point)throw new Error('Provide side top/left/right/bottom, or a custom point with normalized x/y');
    field(connector.body,side+'-diagram-object').value=widget.id;
    field(connector.body,side+'-connector-id').value=point.index ?? keepGuid(point.guid);
    field(connector.body,side+'-point-direction').value=point.direction;
  }
  // Axure resolves the real point from the shape and key. Keep cached geometry
  // and native control points; editor reflow and the preview compiler use the anchors.
  const output=replaceRecord(input,record,encodeRecord(record,strings,encodePayload(graph.roots)));
  writeFileSync(outputFile,output,{flag:'wx'});
  return {outputFile,page:pageName,record:record.index,connector:selector,endpoints};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [source,output,page,connectorArg,json]=process.argv.slice(2);
  if(!json)throw new Error('Usage: node set-connector-anchors.mjs <source.rp> <output.rp> <pageName> <connector-name-or-selector-json> <endpoints-json>');
  const connector=connectorArg.startsWith('{')?JSON.parse(connectorArg):connectorArg;
  console.log(JSON.stringify(setConnectorAnchors(source,output,page,connector,JSON.parse(json)),null,2));
}
