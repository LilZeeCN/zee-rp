import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioDocumentStore} from '../studio/commands.mjs';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {exportStudioDocumentToRp} from '../studio/export-rp.mjs';
import {readRp} from '../scripts/rp-read.mjs';
import {sha256} from '../studio/document.mjs';
import {nativeTemplateSkipReason} from './host-capabilities.mjs';
import {readRecords} from '../scripts/rp-records.mjs';
import {parsePayload,field} from '../scripts/parse-payload.mjs';

test('inline repeater rows modified in Studio reach the native source and editable RP container',{skip:nativeTemplateSkipReason()},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-repeater-export-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));let r=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'repeater',id:'words',x:80,y:120,w:360,h:240,rows:[{id:'a',label:'Alpha'}],template:{type:'label',id:'word_label',text:'=item.label',w:300,h:40}}},{type:'datasetOp',nodeId:'words',op:'add',row:{id:'b',label:'Beta'}}]});assert(r.ok,JSON.stringify(r));const hash=store.doc.contentHash;
 r=await exportStudioDocumentToRp(store.doc,{projectDir:dir,outRpPath:join(dir,'inline.rp')});assert(r.report.summary.threeZerosPassed,JSON.stringify(r.report.summary));assert.equal(r.report.compatibilityCounts.unsupported,0);
 assert(r.report.geometryAlignment.passed99PercentWithin1Px,JSON.stringify(r.report.geometryAlignment));
 const source=JSON.parse(readFileSync(r.sourcePath));assert.equal(source.datasets.words.rows.length,2);assert.equal(source.pages[0].root.children[0].dataset,'words');
 const origin=JSON.parse(readFileSync(r.outRpPath+'.baseline.json')).studioOrigin,studioBytes=readFileSync(r.studioSourcePath);assert.equal(origin.sha256,sha256(studioBytes));assert.equal(origin.contentHash,hash);assert.deepEqual(JSON.parse(studioBytes),store.doc);
 const native=readRp(readFileSync(r.outRpPath));assert(native.pages.flatMap(page=>page.widgets).some(widget=>widget.type==='Repeater'));assert.equal(store.doc.contentHash,hash);assert.equal(store.doc.datasets.words,undefined);
});

test('browser-only repeater view behavior is explicit in the native compatibility report',{skip:nativeTemplateSkipReason()},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-repeater-boundary-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));
 const result=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'repeater',id:'rows',w:320,h:220,rows:[{id:'a',status:'ready',value:2},{id:'b',status:'borrowed',value:1}],filter:{field:'status',equals:'ready'},sort:{field:'value',direction:'desc'},template:{type:'label',id:'row_label',text:'=item.status',w:300,h:40}}}]});assert(result.ok);
 const output=await exportStudioDocumentToRp(store.doc,{projectDir:dir,outRpPath:join(dir,'boundary.rp')});assert(output.report.summary.threeZerosPassed);assert.equal(output.report.compatibilityCounts.unsupported,2);
 assert(output.report.entries.some(node=>node.feature==='repeater.filter'));assert(output.report.entries.some(node=>node.feature==='repeater.sort'));
});

test('different inline datasets with the same implicit name never overwrite one another during export',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-repeater-collision-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));
 const list=value=>({type:'repeater',id:'rows',w:300,h:200,rows:[{id:'a',label:value}],template:{type:'label',id:'row_label',text:'=item.label',w:280,h:40}});
 const result=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:list('First')},{type:'addPage',id:'second',root:{type:'box',id:'second_root',w:900,h:800,children:[list('Second')]}}]});assert(result.ok,JSON.stringify(result));const hash=store.doc.contentHash;
 await assert.rejects(()=>exportStudioDocumentToRp(store.doc,{projectDir:dir,outRpPath:join(dir,'conflict.rp')}),{code:'E_EXPORT_DATASET_COLLISION',nodeId:'second/rows'});assert.equal(store.doc.contentHash,hash);
});

test('resolved Studio macro typography exports as editable children without running a second different macro expansion',{skip:nativeTemplateSkipReason()},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-macro-export-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));const result=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'card',id:'note',title:'Card title',titleFontSize:32,x:40,y:120,w:300,h:'hug'}},{type:'addNode',node:{type:'stat-row',id:'stats',x:400,y:40,valueFontSize:28,items:[{label:'First',value:7},{label:'Second',value:8,valueFontSize:34}],w:600,h:'hug'}},{type:'addNode',node:{type:'list-item',id:'entry',x:0,y:300,title:'List title',w:300,h:'hug'}}]});assert(result.ok);
 const output=await exportStudioDocumentToRp(store.doc,{projectDir:dir,outRpPath:join(dir,'macros.rp')});assert(output.report.summary.threeZerosPassed);assert(output.report.geometryAlignment.passed99PercentWithin1Px,JSON.stringify(output.report.geometryAlignment));const source=JSON.parse(readFileSync(output.sourcePath));
 const find=(node,id)=>node.id===id?node:(node.children||[]).map(child=>find(child,id)).find(Boolean);assert.equal(find(source.pages[0].root,'note_title').fontSize,32);assert.equal(find(source.pages[0].root,'stats_val_1').fontSize,34);assert.equal(find(source.pages[0].root,'stats').type,'box');assert.equal(find(source.pages[0].root,'entry').type,'box');
 const text=readRp(readFileSync(output.outRpPath)).pages.flatMap(page=>page.widgets).map(widget=>widget.text).join('\n');assert(text.includes('Card title')&&text.includes('List title')&&text.includes('First'));
});

test('shared typography tokens export concrete native run sizes while retaining authoritative editable references',{skip:nativeTemplateSkipReason()},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-token-export-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));let result=store.applyTransaction({baseRevision:1,commands:[{type:'setTokens',tokens:{display:28,space:16}},{type:'addNode',node:{type:'box',id:'layout',x:50,y:60,w:680,h:'hug',layout:'column',padding:'$space',gap:'$space',children:[{type:'label',id:'word',text:'serendipity',fontFamily:'Georgia',fontSize:'$display',w:600,h:'hug'},{type:'label',id:'caption',text:'Explicit caption',fontSize:16,w:600,h:32}]}}]});assert(result.ok,JSON.stringify(result));result=store.applyTransaction({baseRevision:2,commands:[{type:'setToken',category:'size',name:'display',value:44}]});assert(result.ok);const hash=store.doc.contentHash;
 const output=await exportStudioDocumentToRp(store.doc,{projectDir:dir,outRpPath:join(dir,'tokens.rp')});assert(output.report.summary.threeZerosPassed);assert(output.report.geometryAlignment.passed99PercentWithin1Px,JSON.stringify(output.report.geometryAlignment));assert(output.report.typographyAlignment.allFontsPreserved);const source=JSON.parse(readFileSync(output.sourcePath)),authoritative=JSON.parse(readFileSync(output.studioSourcePath));assert.equal(source.pages[0].root.children[0].children[0].fontSize,44);assert.equal(authoritative.pages[0].root.children[0].children[0].fontSize,'$display');assert.equal(store.doc.contentHash,hash);
 const bytes=readFileSync(output.outRpPath),native=readRp(bytes),page=native.pages.find(page=>page.widgets.some(widget=>widget.text==='serendipity')),widget=page.widgets.find(widget=>widget.text==='serendipity');assert(widget);const graph=parsePayload(readRecords(bytes).find(record=>record.index===page.record)),object=graph.objects.get(widget.id);let block=field(object.body,'RichTextBlock');if(block?.tag===3)block=graph.objects.get(block.value).body;const paragraphs=field(field(block,'attributed-string'),'Paragraphs'),runs=(paragraphs?.items||[]).flatMap(paragraph=>field(paragraph,'Inlines')?.items||[]);assert(runs.length);
 // Native AxRun stores points; the UI/Studio size is CSS px (see native-scene.mjs).
 assert(runs.every(run=>field(run,'Size')?.value===33));
});
