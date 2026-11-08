import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createEmptyStudioDocument,importToStudioDocument} from '../studio/document.mjs';
import {StudioPersistence} from '../studio/persistence.mjs';
import {StudioDocumentStore} from '../studio/commands.mjs';
import {StudioRuntimeSession} from '../studio/runtime.mjs';
import {resolveDocumentScene} from '../studio/scene-resolver.mjs';
import {exportStudioDocumentToRp} from '../studio/export-rp.mjs';
import {describeAuthoring} from '../studio/authoring-help.mjs';
import {studioHandlers,studioTools} from '../studio/mcp-adapter.mjs';
import {validateInput} from '../scripts/mcp-tools.mjs';
import {nativeTemplateSkipReason} from './host-capabilities.mjs';
import {sha256} from '../studio/document.mjs';
import {startStudioServer} from '../studio/server.mjs';
import {runInteractionSteps} from '../studio/scenario-executors.mjs';
import {readRp} from '../scripts/rp-read.mjs';
import {decodePng,pixelAt} from '../studio/png-decode.mjs';

const label=(id,text,extra={})=>({type:'label',id,text,w:400,h:40,fontSize:24,...extra});
const fixture=()=>importToStudioDocument({domain:'web',pages:[{id:'home',domain:'web',canvas:{w:800,h:600},root:{type:'box',id:'root',layout:'column',padding:32,w:800,h:600,fill:'#F6F3EB',children:[
 label('title','The art of\npaying attention',{h:'hug',fontFamily:'Georgia',fontSize:58,lineHeight:64,color:'#24372E'}),
 {type:'button',id:'start',text:'Start',w:240,h:48,goto:'review'}]}},
 {id:'review',domain:'web',canvas:{w:800,h:600},root:{type:'box',id:'review_root',layout:'column',w:800,h:600,children:[
 {type:'dynamic-panel',id:'stage',w:500,h:'hug',activeState:'recall',states:[{id:'recall',root:{type:'box',id:'recall_root',w:500,h:64,children:[label('prompt','Recall')]}},{id:'revealed',root:{type:'box',id:'revealed_root',w:500,h:96,children:[label('answer','A fortunate discovery')]}}]},
 {type:'button',id:'reveal',text:'Reveal',w:240,h:48,onClick:[{type:'set-panel-state',target:{ref:'stage'},state:'revealed'}]},
 label('hint','Hint',{visible:false}),{type:'button',id:'toggle',text:'Toggle',w:240,h:48,onClick:[{type:'toggle',target:{ref:'hint'}}]}]}}]});

test('exact text measurement cache reuses repeated shaping without changing Unicode or weight metrics',()=>{
 const root=fileURLToPath(new URL('../scripts',import.meta.url));
 const code=`import sys;sys.path.insert(0,sys.argv[1]);import proto
f=proto._measure_line_with_fallbacks;f.cache_clear()
for text in ['A place to stay', '中文与 linger', 'serendipity — gy']:
 for size in [16,58,92]:
  for weight in [400,700]:
   assert f(text,size,weight)==f.__wrapped__(text,size,weight)
   assert f(text,size,weight)==f(text,size,weight)
assert f.cache_info().hits>=36
assert f.cache_info().maxsize==32768
`;
 const result=spawnSync('python3',['-c',code,root],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});

test('normal creation and import have stable hashes across persistence reopen',t=>{
 const dir=mkdtempSync(join(tmpdir(),'canvas-hash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const domain of ['web','mobile']){const p=new StudioPersistence(join(dir,domain));const first=p.initOrLoad({domain}).store.doc;const after=new StudioPersistence(join(dir,domain)).initOrLoad().store.doc;assert.equal(after.revision,first.revision);assert.equal(after.contentHash,first.contentHash);assert(Object.keys(first.components).length>0);}
});
test('web source without canvas keeps its numeric root dimensions and all original geometry',()=>{
 const page={id:'home',domain:'web',root:{id:'root',type:'box',w:960,h:720,children:[{id:'right',type:'label',text:'Right',x:700,y:300,w:200,h:30}]}};
 const doc=importToStudioDocument({domain:'web',pages:[page]});
 assert.equal(doc.pages[0].canvas.w,960);assert.equal(doc.pages[0].canvas.h,720);assert.equal(doc.pages[0].root.children[0].x,700);
 const explicit=importToStudioDocument({domain:'web',pages:[{...page,canvas:{w:1200,h:900}}]});assert.equal(explicit.pages[0].canvas.w,1200);
 const device=importToStudioDocument({domain:'web',pages:[{...page,device:'iphone-17-pro'}]});assert.equal(device.pages[0].canvas.w,402);
});
test('public batch command discovery returns the same enforced contracts',()=>{
 const r=describeAuthoring({topic:'command',names:['addPage','setProperties','addNode']});assert.equal(r.contracts.length,3);assert.deepEqual(r.contracts[1],describeAuthoring({topic:'command',name:'setProperties'}));
});
test('public help errors retain valid requested contracts and actionable command candidates',async()=>{
 const result=await studioHandlers.studio_describe({topic:'command',names:['setText','updateNode']});
 assert.equal(result.ok,false);assert.equal(result.code,'E_COMMAND_HELP');assert(result.candidates.includes('setProperties'));assert.equal(result.contracts[0].name,'setText');
});
test('accepted goto, ref targets and toggle execute; unknown actions reject atomically',()=>{
 const doc=fixture(),rt=new StudioRuntimeSession(doc);const r=rt.runScenario([{action:'click',target:'start',expect:{page:'review',panelState:{stage:'recall'}}},{action:'click',target:'reveal',expect:{panelState:{stage:'revealed'},visible:{answer:true}}},{action:'click',target:'toggle',expect:{visible:{hint:true}}},{action:'click',target:'toggle',expect:{visible:{hint:false}}}]);assert.equal(r.ok,true,JSON.stringify(r.stepResults));
 const store=new StudioDocumentStore(doc),hash=store.doc.contentHash;const bad=store.applyTransaction({pageId:'home',commands:[{type:'setProperties',nodeId:'start',properties:{onClick:[{type:'invented-action'}]}}]});assert.equal(bad.code,'E_INTERACTION_ACTION');assert.equal(store.doc.contentHash,hash);
 const panel=resolveDocumentScene(doc).pages[1].nodes.find(n=>n.id==='stage');assert.equal(panel.h,96);assert(panel.h<panel.w);
});
test('runtime text changes remeasure hug sizes, wrapping and sibling positions without changing the design',()=>{
 const doc=importToStudioDocument({pages:[{id:'home',canvas:{w:400,h:600},root:{type:'box',id:'root',layout:'column',w:400,h:600,children:[
  {type:'label',id:'dynamic',text:'Short',w:120,h:'hug',wrap:true,fontSize:20},
  {type:'label',id:'next',text:'Next',w:'hug',h:'hug'},
  {type:'button',id:'change',text:'Change',w:100,h:44,onClick:[{type:'set-text',target:'dynamic',text:'A much longer runtime sentence that must wrap across several lines.'}]},
  {type:'button',id:'clear',text:'Clear',w:100,h:44,onClick:[{type:'set-text',target:'dynamic',text:''}]}
 ]}}]});
 const before=structuredClone(doc),rt=new StudioRuntimeSession(doc),find=(s,id)=>s.activePageScene.nodes.find(n=>n.id===id),initial=rt.getState();
 const result=rt.runScenario([{action:'click',target:'change',expect:{text:{dynamic:'A much longer runtime sentence that must wrap across several lines.'}}}]);assert(result.ok,JSON.stringify(result));
 const changed=result.finalState,n=find(changed,'dynamic');
 assert(n.lineCount>1);assert(n.lines.join(' ').includes('runtime sentence'));assert(n.h>find(initial,'dynamic').h);assert(find(changed,'next').y>find(initial,'next').y);
 assert.equal(n.rawText,'A much longer runtime sentence that must wrap across several lines.');
 rt.runScenario([{action:'click',target:'clear',expect:{text:{dynamic:''}}}]);assert.equal(find(rt.getState(),'dynamic').text,'');assert.equal(find(rt.getState(),'dynamic').contentW,0);
 assert.equal(find(rt.reset(),'dynamic').h,find(initial,'dynamic').h);assert.deepEqual(doc,before);
});
test('button variants paint usable defaults while explicit styles remain authoritative',()=>{
 const doc=createEmptyStudioDocument({domain:'web'});doc.pages[0].root.children=['primary','outline','ghost','secondary','soft','danger','accent'].map((variant,i)=>({type:'button',id:variant,text:variant,variant,w:240,h:48,y:i*52}));
 doc.pages[0].root.children.push({type:'button',id:'explicit',text:'Explicit',variant:'primary',fill:null,color:'#112233',stroke:'#334455',w:240,h:48});
 const nodes=resolveDocumentScene(doc).pages[0].nodes;const n=id=>nodes.find(n=>n.id===id);assert.equal(n('primary').fill,doc.palette.brand);assert.equal(n('primary').color,'#FFFFFF');assert(n('outline').stroke);assert.equal(n('ghost').fill,null);assert.equal(n('ghost').color,doc.palette.ink);assert.equal(n('explicit').fill,null);assert.equal(n('explicit').color,'#112233');
 const schema=studioTools.find(t=>t.name==='studio_design').inputSchema;
 assert.throws(()=>validateInput(schema,{action:'explore',pageId:'home',states:[{id:'bad',steps:[{action:'navigate',page:'home',expect:{page:'home'}}]}]}));
 validateInput(schema,{action:'explore',pageId:'home',states:[{id:'good',steps:[{action:'click',target:'start',expect:{page:'review'}}]}]});
});

test('large serif text and spacers export as editable native text and geometry',{skip:nativeTemplateSkipReason()},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'canvas-native-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const doc=createEmptyStudioDocument({domain:'web'});doc.pages[0].root.children=[label('word','serendipity',{fontFamily:'Georgia',fontSize:92,w:760,h:120}),{type:'spacer',id:'space',w:400,h:24}];
 const out=join(dir,'large-serif.rp');const r=await exportStudioDocumentToRp(doc,{projectDir:dir,outRpPath:out});assert(r.ok);assert(r.report.summary.threeZerosPassed,JSON.stringify(r.report.summary));
 const native=readRp(readFileSync(out),{full:true});const text=JSON.stringify(native);assert(text.includes('serendipity'));assert(r.report.typographyAlignment.allFontsPreserved);assert.equal(r.report.typographyAlignment.items.find(n=>n.nodeId==='word').rpRunFamily,'Georgia');assert(readFileSync(out).length>1000);
 const baseline=JSON.parse(readFileSync(`${out}.baseline.json`));assert.equal(baseline.rpSha256,sha256(readFileSync(out)));assert.equal(sha256(Buffer.from(baseline.baseRpBase64,'base64')),baseline.rpSha256);assert.equal(baseline.sourceSha256,sha256(readFileSync(r.sourcePath)));assert.equal(baseline.sourcePath,r.sourcePath);
});
test('real browser executes original aliases and compact MCP responses preserve evidence',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'canvas-browser-trial-'));const sourcePath=join(dir,'source.json');writeFileSync(sourcePath,JSON.stringify(fixture()));const{studio}=await startStudioServer({projectDir:dir,sourcePath,port:0});
 try{
  const page=await studio.ensureManagedBrowserPage();const browser=await runInteractionSteps(page,studio.store.doc,[{action:'click',target:'start',expect:{page:'review'}},{action:'click',target:'reveal',expect:{visible:{answer:true}}},{action:'click',target:'toggle',expect:{visible:{hint:true}}}],{layer:'browser',startPageId:'home'});assert.equal(browser.passed,true,JSON.stringify(browser));
  const pixels=await studio.capturePixelContrast('home');assert.equal(pixels.results.find(r=>r.id==='start').passes,true);assert.equal(pixels.results.find(r=>r.id==='title').passes,true,JSON.stringify(pixels.results.find(r=>r.id==='title')));
  const args={url:studio.url,startPageId:'home',steps:[{action:'click',target:'start',expect:{page:'review'}}]};const compact=await studioHandlers.studio_run_scenario(args),full=await studioHandlers.studio_run_scenario({...args,verbose:true});assert.equal(compact.ok,true);assert(!compact.finalState.activePageScene);assert(full.finalState.activePageScene);assert(JSON.stringify(compact).length<JSON.stringify(full).length/3);
  const review=await studioHandlers.studio_review_design({url:studio.url,pageId:'home',baseRevision:studio.store.appliedRevision});assert(review.mcpImages.length);assert(!review.nodeSnapshots);assert(!review.designMetrics);assert(review.reportPath);const raw=JSON.parse(readFileSync(review.reportPath));assert(raw.nodeSnapshots);assert(raw.designMetrics);assert.equal(review.revision,raw.revision);
  assert(studio.store.applyTransaction({commands:[{type:'resizeArtboard',pageId:'home',w:800,h:1660},{type:'setProperties',pageId:'home',nodeId:'root',properties:{h:1660}}]}).ok);
  studio.scene=resolveDocumentScene(studio.store.doc);
  for(let i=0;i<4;i++){
   await studio.captureScreenshot({revision:studio.store.appliedRevision,pageId:'review'});
   const shot=await studio.captureScreenshot({revision:studio.store.appliedRevision,pageId:'home'});
   const png=decodePng(Buffer.from(shot.base64,'base64'));
   const bottom=pixelAt(png,20,(1660-10)*2);assert.deepEqual([bottom.r,bottom.g,bottom.b],[246,243,235],`long artboard must remain painted after a short page: ${JSON.stringify(bottom)}`);
  }
 }finally{await studio.close();rmSync(dir,{recursive:true,force:true});}
});
