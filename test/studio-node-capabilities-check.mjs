import test from 'node:test';
import assert from 'node:assert/strict';
import {StudioDocumentStore} from '../studio/commands.mjs';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {describeAuthoring} from '../studio/authoring-help.mjs';
import {queryAuthoringNodes} from '../studio/authoring-query.mjs';
import {resolveDocumentScene} from '../studio/scene-resolver.mjs';
import {nodePropertyCapability} from '../studio/node-capabilities.mjs';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startStudioServer} from '../studio/server.mjs';
import {spawnSync} from 'node:child_process';

test('node discovery distinguishes source permission, consumer, phase and native boundaries across all 282 properties',()=>{
 const catalog=describeAuthoring({topic:'node'});assert(catalog.types.includes('nav-bar'));assert(catalog.vocabulary.total>=282);assert.equal(catalog.vocabulary.supportContractComplete,true);assert.equal(catalog.vocabulary.completeAudit,false);assert(catalog.writableFields.length<25);assert(JSON.stringify(catalog).length<3500);assert(catalog.typeAvailability.explicitChildrenOnly.includes('nav-bar'));
 const label=describeAuthoring({topic:'node',name:'label',fields:['fontSize','id','adaptive']});assert.equal(label.capabilities[0].surfaces.canvas.status,'implemented');assert.equal(label.capabilities[1].sourceWrite,'read-only');assert.equal(label.capabilities[2].surfaces.canvas.status,'unsupported');assert.equal(label.capabilities[2].sourceWrite,'rejected');assert.equal(label.capabilities[2].surfaces['full-rp1'].status,'implemented');
 assert.equal(describeAuthoring({topic:'node',name:'label',fields:['id'],operation:'create'}).capabilities[0].sourceWrite,'allowed');
 const cardStyle=describeAuthoring({topic:'node',name:'card',fields:['fontSize'],surface:'canvas'}).capabilities[0];assert.equal(cardStyle.canvas.status,'unsupported');assert.equal(cardStyle.sourceWrite,'rejected');assert(describeAuthoring({topic:'node',name:'nav-bar'}).summary.boundary);
 assert.equal(nodePropertyCapability('input','fontFamily').surfaces.native.status,'unsupported');
 const repeater=describeAuthoring({topic:'node',name:'repeater',fields:['rows','template','filter','sort','pageSize']});assert.equal(repeater.capabilities[1].surfaces.canvas.status,'partial');assert.equal(repeater.capabilities[1].surfaces.native.status,'implemented');assert.equal(repeater.capabilities[2].surfaces.canvas.status,'implemented');assert.equal(repeater.capabilities[2].surfaces.native.status,'unsupported');assert.equal(repeater.capabilities[4].surfaces.canvas.status,'implemented');
 assert.throws(()=>describeAuthoring({topic:'node',fields:['text']}),{code:'E_NODE_CAPABILITY_QUERY'});assert.throws(()=>describeAuthoring({topic:'command',name:'setText',fields:['text']}),{code:'E_NODE_CAPABILITY_QUERY'});assert.throws(()=>describeAuthoring({topic:'node',name:'label',fields:Array(17).fill('text')}),{code:'E_NODE_CAPABILITY_QUERY'});
});

test('all vocabulary fields have explicit classifications without implying runtime verification from status counts',async ()=>{
 const {NODE_PROPERTY_NAMES}=await import('../studio/node-properties.mjs');
 const {VALID_NODE_TYPES}=await import('../studio/commands.mjs');
 const {NODE_CAPABILITY_SURFACES}=await import('../studio/node-capabilities.mjs');
 assert(NODE_PROPERTY_NAMES.size>=282);
 let totalCells=0;
 for(const type of VALID_NODE_TYPES){
  for(const field of NODE_PROPERTY_NAMES){
   const cap=nodePropertyCapability(type,field);
   assert(['allowed','read-only','rejected'].includes(cap.sourceWrite),`${type}.${field} invalid sourceWrite: ${cap.sourceWrite}`);
   for(const surface of NODE_CAPABILITY_SURFACES){
    const s=cap.surfaces[surface];
    assert(s&&typeof s.reason==='string'&&s.reason.length>0,`${type}.${field}.${surface} missing reason`);
    assert.notEqual(s.status,'unverified',`${type}.${field}.${surface} is still unverified`);
    assert(['implemented','partial','metadata','unsupported'].includes(s.status),`${type}.${field}.${surface} invalid status: ${s.status}`);
    totalCells++;
   }
  }
 }
 assert.equal(totalCells,NODE_PROPERTY_NAMES.size*VALID_NODE_TYPES.size*4);
});

test('full RP/1 claims agree with real compiler acceptance, rejection and normalization', () => {
 const cases=[
  {type:'label',field:'fontSize',props:{text:'Hello',fontSize:18},accepted:true},
  {type:'label',field:'rows',props:{text:'Hello',rows:[]},accepted:false},
  {type:'label',field:'columns',props:{text:'Hello',columns:2},accepted:false},
  {type:'label',field:'activeState',props:{text:'Hello',activeState:'a'},accepted:false},
  {type:'label',field:'visible',props:{text:'Hello',visible:false},accepted:true},
  {type:'box',field:'css',props:{css:{filter:'blur(2px)'}},accepted:false},
  {type:'card',field:'title',props:{title:'A real card',titleFontSize:22},accepted:true},
  {type:'card',field:'fontSize',props:{fontSize:22},accepted:false},
  {type:'box',field:'text',props:{text:'Box sugar'},accepted:true,status:'partial'},
  {type:'box',field:'font',props:{text:'Box sugar',font:'22/600'},accepted:true,status:'partial'},
  {type:'box',field:'fontFamily',props:{text:'Box sugar',fontFamily:'Georgia'},accepted:true,status:'partial'},
 ];
 const py=`import sys,json\nsys.path.insert(0,'scripts')\nfrom rp_language import compile_language\nout=[]\nfor case in json.loads(sys.argv[1]):\n spec={'language':'rp/1','target':9,'name':'Contract test','pages':[{'id':'home','root':{'id':'root','type':'box','w':500,'h':500,'children':[{'id':'probe','type':case['type'],'w':250,'h':80,**case['props']}]}}]}\n try:\n  compile_language(spec);out.append({'accepted':True})\n except Exception as e:\n  out.append({'accepted':False,'diagnostic':getattr(e,'diagnostic',{'message':str(e)})})\nprint(json.dumps(out))`;
 const result=spawnSync('python3',['-c',py,JSON.stringify(cases)],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const actual=JSON.parse(result.stdout);
 for(let i=0;i<cases.length;i++){
  const item=cases[i],cap=nodePropertyCapability(item.type,item.field).surfaces['full-rp1'];
  assert.equal(actual[i].accepted,item.accepted,JSON.stringify({item,actual:actual[i]}));
  assert.equal(cap.status,item.status || (item.accepted?'implemented':'unsupported'),JSON.stringify({item,cap}));
 }
 assert.equal(nodePropertyCapability('card','titleFontSize').surfaces['full-rp1'].status,'partial');
});

test('newly wired canvas consumers affect layout, typography, visual style, repeater pagination and macros',()=>{
 const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));
 const res=store.applyTransaction({baseRevision:1,commands:[
  {type:'addNode',node:{type:'box',id:'PinBox',w:300,h:200,layout:'stack',clip:true,borderSides:'top,bottom',stroke:'#203B32',strokeWidth:2,innerGlow:'#365E4944',children:[
   {type:'label',id:'PinnedTopRight',content:'Anchor Test',x:150,y:100,anchor:'center',z:5,font:'Georgia',size:18,weight:600,lineGap:8,strikethrough:true,textPaddingX:10,textPaddingY:4},
   {type:'label',id:'PinnedBottom',text:'Bottom Pin',pin:'bottom',pinGap:12,w:100,h:24},
   {type:'divider',id:'VertDiv',direction:'vertical',color:'#DC2626',h:40},
  ]}},
  {type:'addNode',node:{type:'repeater',id:'PagedList',w:300,h:'hug',rowHeight:40,rowGap:6,pageSize:2,key:'code',rows:[{code:'A',name:'One'},{code:'B',name:'Two'},{code:'C',name:'Three'}]}},
  {type:'addNode',node:{type:'stat-row',id:'StatsCustom',w:300,h:'hug',cardPadding:20,equalHeight:true,items:[{label:'Alpha',value:10},{label:'Beta',value:20}]}},
  {type:'addNode',node:{type:'list-item',id:'RichItem',w:300,h:'hug',index:1,title:'Row Title',meta:'Sub Meta',badge:'NEW',badgeVariant:'danger',page:'home'}},
 ]});
 assert(res.ok,JSON.stringify(res));
 const get=id=>res.scene.pages[0].nodes.find(n=>n.id===id);
 const pinLbl=get('PinnedTopRight');
 assert.equal(pinLbl.text,'Anchor Test');
 assert.equal(pinLbl.fontFamily,'Georgia');
 assert.equal(pinLbl.fontSize,18);
 assert.equal(pinLbl.fontWeight,600);
 assert.equal(pinLbl.lineHeight,26);
 assert.equal(pinLbl.strikethrough,true);
 assert.equal(pinLbl.padX,20);
 assert.equal(pinLbl.padY,8);
 assert.equal(pinLbl.z,5);
 assert.equal(get('PinnedBottom').relY,200-24-12);
 assert.equal(get('VertDiv').w,1);
 assert.equal(get('VertDiv').h,40);
 assert.equal(get('VertDiv').fill,'#DC2626');
 assert.equal(get('PagedList').rows.length,2);
 assert.equal(get('PagedList').totalRows,3);
 assert.equal(get('PagedList').key,'code');
 assert.equal(get('StatsCustom_stat_0').padding,20);
 assert.equal(get('RichItem_idx').text,'1');
 assert.equal(get('RichItem_sub').text,'Sub Meta');
 assert.equal(get('RichItem_badge').text,'NEW');
 assert.equal(get('RichItem').on.click[0].page,'home');
});

test('unexpanded raw macros cannot create empty canvas success while component and full RP/1 routes remain available',()=>{
 const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'})),hash=store.doc.contentHash;
 for(const type of ['tab-bar','nav-bar','progress-bar','detail-card','data-table','searchable-list','master-detail']){const rejected=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type,id:'raw_macro',w:300,h:60}}]});assert.equal(rejected.code,'E_STUDIO_MACRO_UNEXPANDED',type);assert.equal(store.doc.contentHash,hash);}
 const valid=store.applyTransaction({baseRevision:1,commands:[{type:'createInstance',componentId:'nav-bar',instanceId:'navigation',props:{title:'Actual navigation'}},{type:'addNode',node:{type:'nav-bar',id:'explicit',w:300,h:60,children:[{type:'label',id:'explicit_title',text:'Explicit content',w:280,h:40}]}}]});assert(valid.ok,JSON.stringify(valid));assert(valid.scene.pages[0].nodes.some(node=>node.text==='Actual navigation'));assert(valid.scene.pages[0].nodes.some(node=>node.text==='Explicit content'));
 const compiler=spawnSync('python3',['-B','-c','import sys,json;sys.path.insert(0,"scripts");from rp_language import compile_language;_,ir=compile_language(json.loads(sys.stdin.read()));print(json.dumps({"symbols":len(ir["symbols"])}))'],{cwd:new URL('..',import.meta.url),input:JSON.stringify({language:'rp/1',target:9,pages:[{id:'home',root:{type:'nav-bar',id:'native_nav',title:'Full RP1 navigation',w:390,h:60}}]}),encoding:'utf8'});assert.equal(compiler.status,0,compiler.stderr);assert(JSON.parse(compiler.stdout).symbols>1);
});

test('known ineffective macro edits reject atomically while source targets remain specific',()=>{
 const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));const emptyHash=store.doc.contentHash;let r=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'card',id:'bad',title:'A card',fontSize:40,w:320,h:'hug'}}]});assert.equal(r.code,'E_NODE_PROPERTY_EFFECT');assert.equal(store.doc.contentHash,emptyHash);
 r=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'card',id:'note',title:'A card',w:320,h:'hug'}},{type:'addNode',node:{type:'label',id:'outside',text:'Keep',w:200,h:30}}]});assert(r.ok);const hash=store.doc.contentHash;
 r=store.applyTransaction({baseRevision:2,commands:[{type:'setText',nodeId:'outside',text:'Must roll back'},{type:'setProperties',nodeId:'note',properties:{fontSize:40}}]});assert.equal(r.code,'E_NODE_PROPERTY_EFFECT');assert.equal(r.field,'fontSize');assert.equal(store.doc.contentHash,hash);
 r=store.applyTransaction({baseRevision:2,commands:[{type:'editNodes',operation:'set',select:{nodeIds:['note']},properties:{fontSize:40}}]});assert.equal(r.code,'E_NODE_PROPERTY_EFFECT');assert.equal(store.doc.contentHash,hash);
 r=store.applyTransaction({baseRevision:2,commands:[{type:'setFont',nodeId:'note',fontSize:40,defaultFamily:'Georgia'}]});assert.equal(r.code,'E_NODE_PROPERTY_EFFECT');assert.equal(store.doc.contentHash,hash);
 const query=queryAuthoringNodes({doc:store.doc,scene:resolveDocumentScene(store.doc),args:{nodeId:'note_title'}});assert.deepEqual(query.nodes[0].capabilities.commonFields,['title','titleFontSize']);assert.deepEqual(query.nodes[0].capabilities.editableFields,['title','titleFontSize']);assert.equal(query.nodes[0].target.nodeId,'home/note');
 r=store.applyTransaction({baseRevision:2,commands:[{type:'setProperties',nodeId:'note',properties:{title:'Changed content'}}]});assert(r.ok);
 const doc=structuredClone(store.doc),card=doc.pages[0].root.children.find(node=>node.id==='note');card.children=[{type:'label',id:'explicit_title',text:'Explicit',w:200,h:30}];const explicit=new StudioDocumentStore(doc);r=explicit.applyTransaction({baseRevision:explicit.doc.revision,commands:[{type:'setProperties',nodeId:'explicit_title',properties:{fontSize:26}}]});assert(r.ok);
});

test('repeater templates bind before layout and expose one stable editable source across rows',()=>{
 const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));let r=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'repeater',id:'words',w:340,h:'hug',rowHeight:88,rowGap:8,rows:[{id:'a',label:'Brief'},{id:'b',label:'A much longer row value which must wrap within its assigned column'}],template:{type:'box',id:'row',w:'fill',h:88,padding:12,layout:'column',fill:'#FFFFFF',radius:8,children:[{type:'paragraph',id:'word',text:'=item.label',fontSize:20,w:180,h:'hug'},{type:'label',id:'caption',text:'ID: ${item.id}',fontSize:12,w:180,h:20}]}}}]});assert(r.ok,JSON.stringify(r));
 const scene=resolveDocumentScene(store.doc),repeater=scene.pages[0].nodes.find(n=>n.id==='words');assert.equal(repeater.rowViews.length,2);assert.equal(repeater.rowViews[0].nodes.find(n=>n.id==='word').text,'Brief');assert.equal(repeater.rowViews[1].nodes.find(n=>n.id==='caption').text,'ID: b');assert(repeater.rowViews[1].nodes.find(n=>n.id==='word').lineCount>1);
 assert.equal(scene.pages[0].nodes.filter(n=>n.id==='word').length,1);const query=queryAuthoringNodes({doc:store.doc,scene,args:{nodeId:'home/words/template/word'}});assert.equal(query.nodes[0].target.nodeId,'home/words/template/word');assert.equal(query.nodes[0].text,'=item.label');
 const hash=store.doc.contentHash;r=store.applyTransaction({baseRevision:2,commands:[{type:'setProperties',nodeId:query.nodes[0].target.nodeId,properties:{fontSize:24}}]});assert(r.ok);assert.notEqual(store.doc.contentHash,hash);assert(r.scene.pages[0].nodes.find(n=>n.id==='words').rowViews.every(row=>row.nodes.find(n=>n.id==='word').fontSize===24));assert.equal(store.doc.pages[0].root.children[0].template.children[0].text,'=item.label');assert(store.undo().ok);assert.equal(store.doc.contentHash,hash);
});

test('a live template edit refreshes every browser row instead of patching the first repeated element',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-template-browser-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const doc=createEmptyStudioDocument({domain:'web'});doc.pages[0].root.children=[{type:'repeater',id:'words',w:400,h:200,rowHeight:60,rows:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}],template:{type:'label',id:'word',text:'=item.label',fontSize:20,w:380,h:60}},{type:'card',id:'note',title:'A real macro',body:'Keep the body',x:0,y:240,w:360,h:'hug'}];const source=join(dir,'source.json');writeFileSync(source,JSON.stringify(doc));
 const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:source,port:0});t.after(()=>studio.close());const page=await studio.ensureManagedBrowserPage();
 const response=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:studio.store.appliedRevision,idempotencyKey:'edit-every-row',commands:[{type:'setProperties',nodeId:'home/words/template/word',properties:{fontSize:30,color:'#2E6F57'}}]})})).json();assert(response.ok,JSON.stringify(response));await page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${response.appliedRevision}`);
 const rows=await page.evaluate(`[...document.querySelectorAll('.repeater-row-template .studio-text')].map(el=>({text:el.innerText,fontSize:getComputedStyle(el).fontSize,color:getComputedStyle(el).color}))`);assert.deepEqual(rows,[{text:'Alpha',fontSize:'30px',color:'rgb(46, 111, 87)'},{text:'Beta',fontSize:'30px',color:'rgb(46, 111, 87)'}]);assert.equal(await page.evaluate('window.__STUDIO_LAST_PATCH_MODE__'),'full-render');assert.equal(page.scriptErrors.length,0);
 const query=queryAuthoringNodes({doc:studio.store.doc,scene:studio.scene,args:{nodeId:'note_title'}}),target=query.nodes[0].target;assert.equal(target.propertyMap.fontSize,'titleFontSize');
 const styled=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:response.appliedRevision,idempotencyKey:'style-macro-title',commands:[{type:'setProperties',nodeId:target.nodeId,properties:{[target.propertyMap.fontSize]:32}}]})})).json();assert(styled.ok,JSON.stringify(styled));await page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${styled.appliedRevision}`);assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('[data-node-id="note_title"]')).fontSize`),'32px');assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('[data-node-id="note_body"]')).fontSize`),'13px');
});

test('existing RP/1 macro typography parameters affect their declared text and reject invalid sizes',()=>{
 const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));const result=store.applyTransaction({baseRevision:1,commands:[{type:'addNode',node:{type:'card',id:'note',title:'Title',titleFontSize:30,w:300,h:'hug'}},{type:'addNode',node:{type:'list-item',id:'entry',title:'Entry',w:300,h:'hug'}},{type:'addNode',node:{type:'stat-row',id:'stats',valueFontSize:28,items:[{label:'First',value:7},{label:'Second',value:8,valueFontSize:34}],w:600,h:'hug'}}]});assert(result.ok,JSON.stringify(result));const node=id=>result.scene.pages[0].nodes.find(n=>n.id===id);assert.equal(node('note_title').fontSize,30);assert.equal(node('entry_title').fontSize,15);assert.equal(node('stats_val_0').fontSize,28);assert.equal(node('stats_val_1').fontSize,34);
 for(const value of[0,-2,121,'$unresolved']){const rejected=store.applyTransaction({baseRevision:2,commands:[{type:'setProperties',nodeId:'note',properties:{titleFontSize:value}}]});assert.equal(rejected.code,'E_INVALID_VALUE');}
 const hash=store.doc.contentHash,rejected=store.applyTransaction({baseRevision:2,commands:[{type:'setProperties',nodeId:'stats',properties:{items:[{label:'Bad',value:1,valueFontSize:200}]}}]});assert.equal(rejected.code,'E_INVALID_VALUE');assert.equal(rejected.field,'items[0].valueFontSize');assert.equal(store.doc.contentHash,hash);
});

test('shared numeric tokens change measured typography and spacing without flattening source references',()=>{
 const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));
 const seed=store.applyTransaction({baseRevision:1,commands:[{type:'setTokens',tokens:{display:30,space:12}},{type:'addNode',node:{type:'box',id:'layout',layout:'column',w:400,h:'hug',padding:['$space',20],gap:'$space',children:[{type:'paragraph',id:'title',text:'A shared typography token controls line wrapping and height.',fontSize:'$display',w:220,h:'hug'},{type:'label',id:'caption',text:'Keep explicit size',fontSize:14,w:220,h:30}]}}]});assert(seed.ok,JSON.stringify(seed));
 const get=(scene,id)=>scene.pages[0].nodes.find(node=>node.id===id),before=get(seed.scene,'title'),hash=store.doc.contentHash;assert.equal(before.fontSize,30);assert(Number.isFinite(before.contentH));assert.equal(get(seed.scene,'layout').gap,12);assert.equal(before.tokenRefs.fontSize,'$display');
 const changed=store.applyTransaction({baseRevision:2,commands:[{type:'setToken',category:'size',name:'display',value:42},{type:'setToken',category:'spacing',name:'space',value:24}]});assert(changed.ok,JSON.stringify(changed));assert.equal(get(changed.scene,'title').fontSize,42);assert(get(changed.scene,'title').contentH>before.contentH);assert.equal(get(changed.scene,'caption').fontSize,14);assert.equal(get(changed.scene,'layout').gap,24);assert.deepEqual(get(changed.scene,'layout').padding,[24,20]);assert.equal(store.doc.pages[0].root.children[0].children[0].fontSize,'$display');
 const current=store.doc.contentHash;
 for(const value of[undefined,'36',0,121,'$display',NaN]){const commands=value===undefined?[{type:'setProperties',nodeId:'title',properties:{fontSize:'$missing'}}]:[{type:'setToken',category:'size',name:'display',value}];const rejected=store.applyTransaction({baseRevision:3,commands:[{type:'setText',nodeId:'caption',text:'Must roll back'},...commands]});assert.equal(rejected.code,'E_NUMERIC_TOKEN',JSON.stringify(rejected));assert.equal(rejected.field,'fontSize');assert.equal(store.doc.contentHash,current);}
 assert(store.undo().ok);assert.equal(store.doc.contentHash,hash);assert.equal(get(resolveDocumentScene(store.doc),'title').fontSize,30);
});

test('a font catalog declaration cannot suppress missing font diagnostics or override actual fallback',()=>{
 const doc=createEmptyStudioDocument({domain:'web'}),family='Missing_Font_Catalog_Only';doc.fonts.catalog.push({family,source:'project',path:'fonts/not-installed.ttf'});doc.pages[0].root.children=[{type:'label',id:'title',text:'Missing font',fontFamily:family,fontSize:24,w:400,h:50}];
 const scene=resolveDocumentScene(doc),page=scene.pages[0],node=page.nodes.find(node=>node.id==='title');assert.equal(node.requestedFontFamily,family);assert.notEqual(node.fontFamily,family);assert.equal(node.fontStatus,'fallback');assert(page.fontReport.missingFamilies.includes(family));assert(!page.fontReport.loadedFamilies.includes(family));assert(page.fontReport.diagnostics.some(diagnostic=>diagnostic.code==='E_FONT_FALLBACK'&&diagnostic.fontFamily===family));assert.equal(doc.pages[0].root.children[0].fontFamily,family);
});

test('shared typography changes reach actual browser text and layout while explicit overrides stay intact',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-token-browser-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const doc=createEmptyStudioDocument({domain:'web'});doc.tokens.display=28;doc.tokens.space=12;doc.pages[0].root.children=[{type:'box',id:'layout',x:60,y:60,w:600,h:'hug',layout:'column',gap:'$space',padding:'$space',children:[{type:'label',id:'title',text:'Typography is design',fontSize:'$display',w:520,h:'hug'},{type:'label',id:'subtitle',text:'A second shared consumer',fontSize:'$display',w:520,h:'hug'},{type:'label',id:'fixed',text:'Explicit override',fontSize:16,w:520,h:32}]}];const source=join(dir,'source.json');writeFileSync(source,JSON.stringify(doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:source,port:0});t.after(()=>studio.close());const page=await studio.ensureManagedBrowserPage();
 const sizes=()=>page.evaluate(`[...['title','subtitle','fixed']].map(id=>getComputedStyle(document.querySelector('[data-node-id="'+id+'"]')).fontSize)`);assert.deepEqual(await sizes(),['28px','28px','16px']);
 const response=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:studio.store.appliedRevision,idempotencyKey:'shared-type-update',commands:[{type:'setToken',category:'size',name:'display',value:40},{type:'setToken',category:'spacing',name:'space',value:24}]})})).json();assert(response.ok,JSON.stringify(response));await page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${response.appliedRevision}`);assert.deepEqual(await sizes(),['40px','40px','16px']);assert.equal(studio.scene.pages[0].nodes.find(node=>node.id==='layout').gap,24);assert.equal(studio.store.doc.pages[0].root.children[0].children[0].fontSize,'$display');assert.equal(page.scriptErrors.length,0);
});
