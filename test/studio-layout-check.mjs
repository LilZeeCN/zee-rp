import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmptyStudioDocument} from '../studio/document.mjs';
import {StudioDocumentStore} from '../studio/commands.mjs';
import {startStudioServer} from '../studio/server.mjs';
import {exportStudioDocumentToRp} from '../studio/export-rp.mjs';
import {nativeTemplateSkipReason} from './host-capabilities.mjs';
const grid=()=>({type:'box',id:'grid',x:30,y:40,layout:'grid',columns:3,padding:12,columnGap:12,rowGap:16,w:600,h:'hug',children:[{type:'label',id:'wide',text:'Across two columns',fontSize:16,colSpan:2,w:'fill',h:80},{type:'label',id:'tall',text:'Across two rows',fontSize:16,rowSpan:2,w:'fill',h:180},{type:'label',id:'small',text:'Small',fontSize:16,w:'fill',h:60}]});
const seed=()=>{const store=new StudioDocumentStore(createEmptyStudioDocument({domain:'web'}));const result=store.applyTransaction({commands:[{type:'addNode',node:grid()}]});assert(result.ok,JSON.stringify(result));return{store,result};};
const node=(scene,id)=>scene.pages[0].nodes.find(node=>node.id===id);

test('grid spans consume distinct cells, fit measured rows and retain editable layout source',()=>{
 const {store,result}=seed(),scene=result.scene;assert.deepEqual(['wide','tall','small'].map(id=>{const n=node(scene,id);return{x:n.x,y:n.y,w:n.w,h:n.h}}),[{x:42,y:52,w:380,h:80},{x:434,y:52,w:184,h:180},{x:42,y:160,w:184,h:60}]);assert.equal(node(scene,'grid').h,204);const hash=store.doc.contentHash;
 const bad=store.applyTransaction({commands:[{type:'setProperties',nodeId:'wide',properties:{text:'Must roll back'}},{type:'setProperties',nodeId:'grid',properties:{columns:0}}]});assert.equal(bad.code,'E_INVALID_VALUE');assert.equal(store.doc.contentHash,hash);
 const changed=store.applyTransaction({commands:[{type:'setTokens',tokens:{rows:24,cols:20}},{type:'setLayout',nodeId:'grid',layout:{rowGap:'$rows',columnGap:'$cols'}}]});assert(changed.ok,JSON.stringify(changed));assert.equal(node(changed.scene,'small').y,164);assert.equal(store.doc.pages[0].root.children[0].rowGap,'$rows');assert(store.undo().ok);assert.equal(store.doc.contentHash,hash);
 const frozen=store.applyTransaction({commands:[{type:'switchLayoutMode',nodeId:'grid',mode:'stack'}]});assert(frozen.ok);for(const id of['wide','tall','small'])for(const key of['x','y','w','h'])assert.equal(node(frozen.scene,id)[key],node(scene,id)[key],`${id}.${key} changed while switching layout`);
});

test('right/bottom anchors and equal-height rows affect real geometry instead of inert stored fields',()=>{
 const {store}=seed();const result=store.applyTransaction({commands:[{type:'addNode',node:{type:'box',id:'anchor',x:10,y:300,w:400,h:200,padding:20,children:[{type:'label',id:'pinned',text:'Pinned',w:100,h:30,right:12,bottom:16}]}},{type:'addNode',node:{type:'box',id:'row',layout:'row',equalHeight:true,x:10,y:550,w:400,h:100,gap:12,children:[{type:'box',id:'short',w:100,h:30},{type:'box',id:'high',w:100,h:70}]}}]});assert(result.ok);assert.deepEqual(['x','y','w','h'].map(key=>node(result.scene,'pinned')[key]),[278,434,100,30]);assert.equal(node(result.scene,'short').h,100);assert.equal(node(result.scene,'high').h,100);
 const moved=store.applyTransaction({commands:[{type:'moveNode',nodeId:'pinned',deltaX:10,deltaY:20}]});assert(moved.ok);assert.deepEqual(['x','y'].map(key=>node(moved.scene,'pinned')[key]),[288,454]);const resized=store.applyTransaction({commands:[{type:'resizeNode',nodeId:'pinned',w:120,h:50,x:258,y:134}]});assert(resized.ok);assert.deepEqual(['x','y','w','h'].map(key=>node(resized.scene,'pinned')[key]),[288,454,120,50]);
});

test('grid geometry reaches browser DOM after column edits and matches the authoritative scene',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-grid-browser-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const doc=createEmptyStudioDocument({domain:'web'});doc.pages[0].root.children=[grid()];const path=join(dir,'source.json');writeFileSync(path,JSON.stringify(doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:path,port:0});t.after(()=>studio.close());const page=await studio.ensureManagedBrowserPage();await page.evaluate(`window.__STUDIO_APP__.setPanZoom(340,80,0.75)`);
 const check=async()=>{const actual=await page.evaluate(`(()=>{const root=document.querySelector('[data-node-id="grid"]').getBoundingClientRect();return ['wide','tall','small'].map(id=>{const r=document.querySelector('[data-node-id="'+id+'"]').getBoundingClientRect();return{id,x:(r.x-root.x)/0.75,y:(r.y-root.y)/0.75,w:r.width/0.75,h:r.height/0.75}})})()`);for(const item of actual){const expected=node(studio.scene,item.id),parent=node(studio.scene,'grid');for(const key of['x','y','w','h'])assert(Math.abs(item[key]-(key==='x'?expected.x-parent.x:key==='y'?expected.y-parent.y:expected[key]))<0.1,JSON.stringify({item,expected}));}};await check();const result=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:studio.store.appliedRevision,idempotencyKey:'two-columns',commands:[{type:'setProperties',nodeId:'grid',properties:{columns:2}}]})})).json();assert(result.ok);await page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${result.appliedRevision}`);await check();assert.equal(page.scriptErrors.length,0);
});

test('grid exports resolved editable native children without a second layout pass',{skip:nativeTemplateSkipReason()},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-grid-native-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const {store}=seed(),hash=store.doc.contentHash;const result=await exportStudioDocumentToRp(store.doc,{projectDir:dir,outRpPath:join(dir,'grid.rp')});assert(result.report.summary.threeZerosPassed);assert(result.report.geometryAlignment.passed99PercentWithin1Px,JSON.stringify(result.report.geometryAlignment));const source=JSON.parse(readFileSync(result.sourcePath));assert.equal(source.pages[0].root.children[0].layout,'stack');assert.equal(source.pages[0].root.children[0].children.find(node=>node.id==='wide').w,380);assert.equal(JSON.parse(readFileSync(result.studioSourcePath)).pages[0].root.children[0].layout,'grid');assert.equal(store.doc.contentHash,hash);
});

test('wrapped rows honor justification, equal heights, and a hug width limit on each line', () => {
 const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
 const children = [30, 60, 20].map((h, i) => ({ id: `wrapped_${i}`, type: 'box', w: 70, h }));
 const result = store.applyTransaction({ commands: [{ type: 'addNode', node: {
  id: 'wrapped', type: 'box', layout: 'row', wrap: true, w: 180, h: 'hug',
  gap: 10, justify: 'end', equalHeight: true, children,
 } }] });
 assert.equal(result.ok, true, JSON.stringify(result));
 assert.equal(node(result.scene, 'wrapped').h, 90);
 assert.deepEqual(children.map(({ id }) => {
  const { relX, relY, h } = node(result.scene, id);
  return [relX, relY, h];
 }), [[30, 0, 60], [110, 0, 60], [110, 70, 20]]);
 const hug = store.applyTransaction({ commands: [{ type: 'setProperties', nodeId: 'wrapped', properties: { w: 'hug', maxW: 150 } }] });
 assert.equal(hug.ok, true, JSON.stringify(hug));
 assert.equal(node(hug.scene, 'wrapped').w, 150);
 assert.equal(node(hug.scene, 'wrapped_2').relY, 70);
});
