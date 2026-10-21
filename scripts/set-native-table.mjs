#!/usr/bin/env node
// Resize/fill one existing native Table and optionally add visual merge overlays.
// Overlay templates are same-page VectorShapes; the source file is never overwritten.
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, replaceRecord, encodeRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { cloneInto, closureOf } from './clone-closure.mjs';
import { encodeStyleEntry } from './set-widget-richtext.mjs';

const [input, output, specPath] = process.argv.slice(2);
if (!input || !output || !specPath) {
  console.error('Usage: node set-native-table.mjs input.rp output.rp table.json');
  console.error('Optional table.json fields: visualMergeTemplateWidgetId and visualMerges');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const rows = spec.cells;
const isRunsCell = cell => cell !== null && typeof cell === 'object' && !Array.isArray(cell);
if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length ||
  rows.some(row => !Array.isArray(row) || row.length !== rows[0].length))
  throw new Error('cells must be a nonempty rectangular array of strings or {runs:[{text,style}]} cells');
rows.flat().forEach((cell, index) => {
  if (typeof cell === 'string' || cell === null || cell === undefined) return;
  if (!isRunsCell(cell)) throw new Error(`cells[${Math.floor(index / rows[0].length)}][${index % rows[0].length}] must be a string or a {runs} object`);
  const runs = cell.runs;
  if (!Array.isArray(runs) || !runs.length) throw new Error('runs cells need a nonempty runs array');
  runs.forEach((run, runIndex) => {
    if (!run || typeof run !== 'object' || typeof run.text !== 'string' || /[\r\n]/.test(run.text))
      throw new Error(`runs[${runIndex}].text must be a string without line breaks`);
    if (run.style !== undefined && (run.style === null || typeof run.style !== 'object'))
      throw new Error(`runs[${runIndex}].style must be an object`);
  });
});
const rowCount = rows.length, columnCount = rows[0].length;
const visualMerges = spec.visualMerges ?? [];
if (!Array.isArray(visualMerges)) throw new Error('visualMerges must be an array');
if (visualMerges.length && !Number.isInteger(spec.visualMergeTemplateWidgetId))
  throw new Error('visualMergeTemplateWidgetId must identify a VectorShape template on the same page');
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
const tableParentId = field(field(field(table.body,'name-block'),'property-dictionary'),'parent-diagram-id');
const mergeTemplateId = spec.visualMergeTemplateWidgetId;
const mergeTemplate = visualMerges.length ? sourceGraph.objects.get(mergeTemplateId) : null;
if (visualMerges.length && mergeTemplate?.className !== 'Axure:DiagramObject:VectorShape')
  throw new Error(`visualMergeTemplateWidgetId ${mergeTemplateId} must identify a page-level VectorShape`);
if (visualMerges.length) {
  const templateParent=field(field(mergeTemplate.body,'name-block'),'property-dictionary');
  const tableParent=field(field(table.body,'name-block'),'property-dictionary');
  if (field(templateParent,'parent-diagram-id')?.value!==field(tableParent,'parent-diagram-id')?.value)
    throw new Error(`visualMergeTemplateWidgetId ${mergeTemplateId} must belong to the same Page as the table`);
}
const mergeCells = new Set();
const mergeRanges = [];
for (const [index, merge] of visualMerges.entries()) {
  if (!merge || typeof merge!=='object') throw new Error(`visualMerges[${index}] must be an object`);
  const {row,column,rowSpan,columnSpan} = merge ?? {};
  if (![row,column,rowSpan,columnSpan].every(Number.isInteger) || row < 0 || column < 0 || rowSpan < 1 || columnSpan < 1 ||
    row + rowSpan > rowCount || column + columnSpan > columnCount)
    throw new Error(`visualMerges[${index}] needs zero-based row/column and positive spans within the table`);
  if (merge.text !== undefined && typeof merge.text !== 'string')
    throw new Error(`visualMerges[${index}].text must be a string`);
  if (merge.text !== undefined && isRunsCell(rows[row][column]))
    throw new Error(`visualMerges[${index}].text cannot replace a multi-run cell; keep the cell empty or a plain string`);
  if (merge.text !== undefined) rows[row][column] = merge.text;
  for (const previous of mergeRanges) {
    const rowsOverlap=row<previous.row+previous.rowSpan && previous.row<row+rowSpan;
    const columnsOverlap=column<previous.column+previous.columnSpan && previous.column<column+columnSpan;
    if ((rowsOverlap && (column===previous.column+previous.columnSpan || column+columnSpan===previous.column)) ||
      (columnsOverlap && (row===previous.row+previous.rowSpan || row+rowSpan===previous.row)))
      throw new Error(`visualMerges[${index}] shares a side with another merge; combine touching ranges`);
  }
  mergeRanges.push({row,column,rowSpan,columnSpan});
  for (let r=row;r<row+rowSpan;r++) for (let c=column;c<column+columnSpan;c++) {
    const key=`${r}:${c}`;
    if (mergeCells.has(key)) throw new Error(`visualMerges[${index}] overlaps another merged range at row ${r}, column ${c}`);
    mergeCells.add(key);
    if ((r!==row || c!==column) && String(rows[r][c]??'')!=='')
      throw new Error(`visualMerges[${index}] covers nonempty cell ${r},${c}; clear that cell in cells first`);
  }
}
const templateId = oldCells.find(id => field(sourceGraph.objects.get(id)?.body,'RichTextBlock'));
if (!templateId) throw new Error('Native Table needs a cell with native rich text as a cloning template');
const textTemplate = structuredClone(field(sourceGraph.objects.get(templateId).body,'RichTextBlock'));
const intern = text => { let i=strings.indexOf(text);if(i<0){i=strings.length;strings.push(text);}return i+1; };
const cells = [], created = [];
for (let index=0; index<rowCount*columnCount; index++) {
  const row=Math.floor(index/columnCount), col=index%columnCount;
  const id = index < oldCells.length ? oldCells[index] : (() => {
    const clone=cloneInto({
    srcGraph:sourceGraph,srcStrings:record.strings,dstGraph:graph,dstStrings:strings,
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
  const paragraphsNode = field(rich, 'Paragraphs');
  if (paragraphsNode && paragraphsNode.tag === 2 && paragraphsNode.items.length > 1) {
    paragraphsNode.items.length = 1;
  }
  const cellSpec = rows[row][col];
  let cellInlines = null;
  if (isRunsCell(cellSpec)) {
    // Multi-run cell: clone the native run template for each {text,style} entry.
    let inlinesNode = null;
    walkNodes([rich], node => { if (node.tag !== 1 || inlinesNode) return;
      for (const [key, value] of node.entries) if (key.text === 'Inlines' && value.tag === 2 && value.items?.length) inlinesNode = value; });
    if (!inlinesNode) throw new Error(`Cell ${row+1},${col+1} has no native Inlines list for multi-run content`);
    if (inlinesNode.items.some(inline => inline.tag === 1 && field(inline, 'Type')?.text === 'Axure:AttributedString:AxHyperlink'))
      throw new Error(`Cell ${row+1},${col+1} has unsupported AxHyperlink in run template`);
    const templateRun = inlinesNode.items.find(inline => inline.tag === 1 && field(inline, 'Type')?.text === 'Axure:AttributedString:AxRun' && (inline.entries ?? []).some(([k, v]) => k.text === 'Text' && v.tag === 8));
    if (!templateRun) throw new Error(`Cell ${row+1},${col+1} has no native AxRun template`);
    inlinesNode.items = cellSpec.runs.map(run => {
      const clone = structuredClone(templateRun);
      for (const [key, value] of clone.entries) {
        if (key.text === 'Text' && value.tag === 8) { value.text = run.text; value.value = intern(run.text); }
      }
      const style = run.style ?? {};
      if (style.bold !== undefined && style.weight !== undefined) throw new Error('bold and weight both write the native Weight key; use one');
      if (style.italic !== undefined && style.style !== undefined) throw new Error('italic and style both write the native Style key; use one');
      for (const [styleKey, styleValue] of Object.entries(style)) {
        const { field: fieldName, tag, value: encoded } = encodeStyleEntry(styleKey, styleValue);
        const target = clone.entries.find(([k, v]) => k.text === fieldName);
        if (!target || target[1].tag !== tag) throw new Error(`Unsupported native field ${fieldName} in table run template`);
        if (tag === 8) {
          target[1].value = intern(encoded);
          target[1].text = encoded;
        } else {
          target[1].value = encoded;
        }
      }
      return clone;
    });
    cellInlines = inlinesNode.items;
  } else {
    let count=0;
    walkNodes([rich],node=>{if(node.tag!==1)return;for(const[key,value]of node.entries){
      if(key.text==='Text'&&value.tag===8){
        value.text=mergeCells.has(`${row}:${col}`)?'':String(cellSpec??'');value.value=intern(value.text);count++;
      }
    }});
    if(count!==1)throw new Error(`Cell ${row+1},${col+1} has ${count} text runs; only one run is supported (pass {runs:[...]} for multi-run cells)`);
  }
  field(field(rich,'property-dictionary'),'text-object-id').value=id;
  field(field(field(cell.body,'name-block'),'property-dictionary'),'diagram-object-id').value=id;
  const style=graph.objects.get(field(cell.body,'MyStyle').value);
  const size=field(style.body,'PropList').items.find(p=>field(p,'DOAName')?.value===3221225577);
  field(field(size,'Value'),'Width').value=columnWidths[col];
  field(field(size,'Value'),'Height').value=rowHeights[row];
  if (cellInlines && field(style.body, 'PropList')?.items) {
    const propList = field(style.body, 'PropList');
    const mapStyleProp = (doa, val) => ({
      tag: 1,
      entries: [
        [{ tag: 8, value: intern('DOAName'), text: 'DOAName' }, { tag: 5, value: doa }],
        [{ tag: 8, value: intern('Value'), text: 'Value' }, val]
      ]
    });
    const registerCellStyle = (name, nodes, encode = node => structuredClone(node)) => {
      const valid = nodes.filter(Boolean);
      if (!valid.length) return;
      const first = valid[0];
      const getVal = n => n.tag === 8 ? n.text : n.value;
      const determined = valid.length === nodes.length && valid.every(n => getVal(n) === getVal(first));
      const entry = mapStyleProp((determined ? 0xc0000000 : 0x40000000) + name, encode(first));
      const oldIdx = propList.items.findIndex(prop => (field(prop, 'DOAName')?.value & 0x0fffffff) === name);
      if (oldIdx < 0) propList.items.push(entry);
      else propList.items[oldIdx] = entry;
    };
    registerCellStyle(1, cellInlines.map(r => field(r, 'Family')));
    registerCellStyle(2, cellInlines.map(r => field(r, 'Size')));
    registerCellStyle(1001, cellInlines.map(r => field(r, 'Weight')));
    registerCellStyle(1002, cellInlines.map(r => field(r, 'Style')));
    registerCellStyle(5, cellInlines.map(r => field(r, 'Underline')));
    registerCellStyle(95, cellInlines.map(r => field(r, 'Strikethrough')));
    registerCellStyle(6, cellInlines.map(r => field(r, 'Color')), color => ({
      tag: 1,
      entries: [
        [{ tag: 8, value: intern('fill-type'), text: 'fill-type' }, { tag: 8, value: intern('solid'), text: 'solid' }],
        [{ tag: 8, value: intern('fill-color'), text: 'fill-color' }, structuredClone(color)]
      ]
    }));
  }
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
const overlayClosure=visualMerges.length ? closureOf(sourceGraph,mergeTemplateId) : null;
const tablePosition=field(field(style.body,'PropList').items.find(p=>field(p,'DOAName')?.value===3221225573),'Value');
if (visualMerges.length && (!tablePosition || !field(tablePosition,'X') || !field(tablePosition,'Y')))
  throw new Error('The native Table needs X/Y position properties before visual merges can be added');
for (const [index,merge] of visualMerges.entries()) {
  const overlay=index===0 ? graph.objects.get(mergeTemplateId) : (()=>{
    const clone=cloneInto({srcGraph:sourceGraph,srcStrings:record.strings,dstGraph:graph,dstStrings:strings,
      closure:overlayClosure,rootOldId:mergeTemplateId});
    created.push(...clone.created);return graph.objects.get(clone.rootNewId);
  })();
  if (!overlay || overlay.className!=='Axure:DiagramObject:VectorShape')
    throw new Error(`visualMerges[${index}] could not materialize its VectorShape overlay`);
  const overlayParent=field(field(field(overlay.body,'name-block'),'property-dictionary'),'parent-diagram-id');
  if (!tableParentId || !overlayParent || tableParentId.tag!==0x11 || overlayParent.tag!==0x11)
    throw new Error('The native Table and VectorShape need valid Page parent diagram ids');
  // cloneInto remaps every GUID reference, including the cloned shape's Page parent.
  // Point the overlay back to the table's actual Page diagram so Axure renders it.
  overlayParent.value=tableParentId.value;
  const overlayStyle=graph.objects.get(field(overlay.body,'MyStyle').value);
  const props=field(overlayStyle.body,'PropList').items;
  const position=field(props.find(p=>field(p,'DOAName')?.value===3221225573),'Value');
  const dimensions=field(props.find(p=>field(p,'DOAName')?.value===3221225577),'Value');
  if (!position || !field(position,'X') || !field(position,'Y') || !dimensions || !field(dimensions,'Width') || !field(dimensions,'Height'))
    throw new Error(`visualMergeTemplateWidgetId ${mergeTemplateId} needs native position and size properties`);
  field(position,'X').value=field(tablePosition,'X').value+columnWidths.slice(0,merge.column).reduce((a,b)=>a+b,0);
  field(position,'Y').value=field(tablePosition,'Y').value+rowHeights.slice(0,merge.row).reduce((a,b)=>a+b,0);
  field(dimensions,'Width').value=columnWidths.slice(merge.column,merge.column+merge.columnSpan).reduce((a,b)=>a+b,0);
  field(dimensions,'Height').value=rowHeights.slice(merge.row,merge.row+merge.rowSpan).reduce((a,b)=>a+b,0);
  const rich=field(overlay.body,'RichTextBlock');
  if (!rich) throw new Error(`visualMergeTemplateWidgetId ${mergeTemplateId} needs one native RichTextBlock`);
  let runs=0;
  walkNodes([rich],node=>{if(node.tag!==1)return;for(const[key,value]of node.entries){
    if(key.text==='Text'&&value.tag===8){value.text=String(rows[merge.row][merge.column]??'');value.value=intern(value.text);runs++;}
  }});
  if (runs!==1) throw new Error(`visualMergeTemplateWidgetId ${mergeTemplateId} has ${runs} text runs; exactly one is supported`);
  const richProperties=field(rich,'property-dictionary');
  field(richProperties,'text-object-id').value=overlay.id;
  const richParent=field(richProperties,'parent-diagram-id');
  if (!richParent || richParent.tag!==0x11)
    throw new Error(`visualMergeTemplateWidgetId ${mergeTemplateId} needs a valid RichTextBlock Page parent id`);
  richParent.value=tableParentId.value;
  const pageDiagram=graph.objects.get(tableParentId.value);
  const diagramChildren=field(pageDiagram?.body,'diagram-objects');
  if (!diagramChildren?.items)
    throw new Error('The Page diagram needs a diagram-objects list before visual merges can be added');
  if (!diagramChildren.items.some(child=>child.tag===3&&child.value===overlay.id))
    diagramChildren.items.push({tag:3,value:overlay.id});
}
graph.roots.splice(graph.roots.findIndex(node=>node.tag===28),0,...created);
const changed=replaceRecord(file,record,encodeRecord(record,strings,encodePayload(graph.roots)));
writeFileSync(output,changed,{flag:'wx'});
console.log(JSON.stringify({table:table.id,rows:rowCount,columns:columnCount,cells:cells.length,visualMerges:visualMerges.length,output}));
