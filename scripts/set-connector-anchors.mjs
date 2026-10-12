import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords, replaceRecord, encodeRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { CONNECTOR_POINTS } from './clone-native-connector.mjs';

export function setConnectorAnchors(sourceFile, outputFile, pageName, connectorName, endpoints) {
  if (!endpoints || typeof endpoints !== 'object' || !['start', 'end'].some(key => Object.hasOwn(endpoints, key)))
    throw new Error('Provide start and/or end as {widget, side}, or null for a free endpoint');
  const input=readFileSync(sourceFile),pages=readRp(input).pages.filter(page=>page.name===pageName);
  if (pages.length!==1) throw new Error('Page name must be unique');
  const page=pages[0],record=readRecords(input).find(r=>r.index===page.record),graph=parsePayload(record);
  const pageObject=[...graph.objects.values()].find(o=>o.className==='Axure:Page');
  const diagram=graph.objects.get(field(pageObject.body,'diagram').value);
  const roots=new Set(field(diagram.body,'diagram-objects').items.map(n=>n.value));
  const find=name=>{
    const widgets=page.widgets.filter(w=>w.name===name);
    if(widgets.length!==1)throw new Error(`Widget "${name}" must be unique on "${pageName}"`);
    if(!roots.has(widgets[0].id))throw new Error('Connector and endpoints must be directly on the Page');
    return graph.objects.get(widgets[0].id);
  };
  const connector=find(connectorName);
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
    const point=CONNECTOR_POINTS[spec.side],widget=find(spec.widget);
    if(!point)throw new Error('Connector side must be top, left, right, or bottom');
    if(widget.className!=='Axure:DiagramObject:VectorShape')throw new Error('Only flat VectorShape endpoints are supported');
    field(connector.body,side+'-diagram-object').value=widget.id;
    field(connector.body,side+'-connector-id').value=keepGuid(point.guid);
    field(connector.body,side+'-point-direction').value=point.direction;
  }
  // Axure resolves the real point from the shape and key. Keep cached geometry
  // and native control points; editor reflow and the preview compiler use the anchors.
  const output=replaceRecord(input,record,encodeRecord(record,record.strings,encodePayload(graph.roots)));
  writeFileSync(outputFile,output,{flag:'wx'});
  return {outputFile,page:pageName,connector:connectorName,endpoints};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [source,output,page,connector,json]=process.argv.slice(2);
  if(!json)throw new Error('Usage: node set-connector-anchors.mjs <source.rp> <output.rp> <pageName> <connectorName> <endpoints-json>');
  console.log(JSON.stringify(setConnectorAnchors(source,output,page,connector,JSON.parse(json)),null,2));
}
