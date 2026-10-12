#!/usr/bin/env node
// Resize and fill one existing native Table. The source file is never overwritten.
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, replaceRecord, encodeRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { cloneInto, closureOf } from './clone-closure.mjs';

const [input, output, specPath] = process.argv.slice(2);
if (!input || !output || !specPath) {
  console.error('Usage: node set-native-table.mjs input.rp output.rp table.json');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const rows = spec.cells;
if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length ||
  rows.some(row => !Array.isArray(row) || row.length !== rows[0].length))
  throw new Error('cells must be a nonempty rectangular array of strings');
const rowCount = rows.length, columnCount = rows[0].length;
const rowHeights = spec.rowHeights ?? Array(rowCount).fill(30);
const columnWidths = spec.columnWidths ?? Array(columnCount).fill(100);
if (rowHeights.length !== rowCount || columnWidths.length !== columnCount ||
  [...rowHeights,...columnWidths].some(x => !Number.isFinite(x) || x <= 0))
  throw new Error('rowHeights/columnWidths must match the table size and contain positive numbers');

const file = readFileSync(input);
const records = readRecords(file);
const matches = [];
for (const record of records.filter(r => r.className === 'Axure:Page')) {
  const graph = parsePayload(record);
  for (const table of graph.objects.values()) {
    if (table.className !== 'Axure:DiagramObject:Table') continue;
    const name = field(field(table.body, 'name-block'), 'text')?.text ?? '';
    if (spec.table === undefined || spec.table === name) matches.push({record,graph,table});
  }
}
if (matches.length !== 1) throw new Error(`Expected one matching native Table; found ${matches.length}`);
const {record,graph,table} = matches[0];
const sourceGraph = parsePayload(record);
const strings = [...record.strings];
const oldCells = field(table.body,'cells').items.map(n => n.value);
const templateId = oldCells.find(id => field(sourceGraph.objects.get(id)?.body,'RichTextBlock'));
if (!templateId) throw new Error('Native Table needs a cell with native rich text as a cloning template');
const textTemplate = structuredClone(field(sourceGraph.objects.get(templateId).body,'RichTextBlock'));
const intern = text => { let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text);}return i+1; };
const cells = [], created = [];
for (let index=0; index<rowCount*columnCount; index++) {
  const row=Math.floor(index/columnCount), col=index%columnCount;
  const id = index < oldCells.length ? oldCells[index] : (() => {
    const clone=cloneInto({srcGraph:sourceGraph,srcStrings:record.strings,dstGraph:graph,dstStrings:strings,
      closure:closureOf(sourceGraph,templateId),rootOldId:templateId});
    created.push(...clone.created);return clone.rootNewId;
  })();
  const cell=graph.objects.get(id);
  let rich=field(cell.body,'RichTextBlock');
  if(!rich){
    rich=structuredClone(textTemplate);
    const at=cell.body.entries.findIndex(([key])=>key.text==='AutoFitHeight');
    cell.body.entries.splice(at,0,[{tag:8,value:intern('RichTextBlock'),text:'RichTextBlock'},rich]);
  }
  let count=0;
  walkNodes([rich],node=>{if(node.tag!==1)return;for(const[key,value]of node.entries){
    if(key.text==='Text'&&value.tag===8){
      value.text=String(rows[row][col]??'');value.value=intern(value.text);count++;
    }
  }});
  if(count!==1)throw new Error(`Cell ${row+1},${col+1} has ${count} text runs; only one run is supported`);
  field(field(rich,'property-dictionary'),'text-object-id').value=id;
  field(field(field(cell.body,'name-block'),'property-dictionary'),'diagram-object-id').value=id;
  const style=graph.objects.get(field(cell.body,'MyStyle').value);
  const size=field(style.body,'PropList').items.find(p=>field(p,'DOAName')?.value===3221225577);
  field(field(size,'Value'),'Width').value=columnWidths[col];
  field(field(size,'Value'),'Height').value=rowHeights[row];
  cells.push(id);
}
field(table.body,'rows').value=rowCount;
field(table.body,'columns').value=columnCount;
field(table.body,'cells').items=cells.map(value=>({tag:3,value}));
field(table.body,'diagram-objects').items=cells.map(value=>({tag:3,value}));
field(table.body,'row-heights').items=rowHeights.map(value=>({tag:6,value}));
field(table.body,'column-widths').items=columnWidths.map(value=>({tag:6,value}));
const style=graph.objects.get(field(table.body,'MyStyle').value);
const size=field(style.body,'PropList').items.find(p=>field(p,'DOAName')?.value===3221225577);
field(field(size,'Value'),'Width').value=columnWidths.reduce((a,b)=>a+b,0);
field(field(size,'Value'),'Height').value=rowHeights.reduce((a,b)=>a+b,0);
graph.roots.splice(graph.roots.findIndex(node=>node.tag===28),0,...created);
const changed=replaceRecord(file,record,encodeRecord(record,strings,encodePayload(graph.roots)));
writeFileSync(output,changed,{flag:'wx'});
console.log(JSON.stringify({table:table.id,rows:rowCount,columns:columnCount,cells:cells.length,output}));
