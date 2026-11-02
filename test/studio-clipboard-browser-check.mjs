import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudioServer } from '../studio/server.mjs';
import { buildNodeIndex, createEmptyStudioDocument } from '../studio/document.mjs';

test('browser copy survives source edit/delete and repeated paste remaps descendants', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-clipboard-browser-'));
  const { studio } = await startStudioServer({ projectDir: dir, port: 0 });
  const command = async commands => {
    const result = await (await fetch(studio.url + '/api/commands', { method: 'POST', body: JSON.stringify({ baseRevision: studio.store.appliedRevision, idempotencyKey: `keyboard-${studio.store.appliedRevision}`, commands }) })).json();
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  try {
    await command([{ type: 'addNode', node: { id: 'copy-region', type: 'box', w: 320, h: 140, children: [{ id: 'copy-title', type: 'label', text: 'Copied text', w: 280, h: 40 }] } }]);
    const page = await studio.ensureManagedBrowserPage();
    const shortcut = async key => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: 'Key' + key.toUpperCase(), modifiers: 4 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'Key' + key.toUpperCase(), modifiers: 0 });
    };
    await page.evaluate('window.__STUDIO_APP__.selectNodes(["copy-region"],"home")');
    await shortcut('c');
    assert.equal(await page.evaluate('window.__STUDIO_STATE__.clipboardNodes[0].children[0].text'), 'Copied text');
    await command([{ type: 'setText', nodeId: 'copy-title', text: 'Changed after copy' }, { type: 'deleteNode', nodeId: 'copy-region' }]);
    await page.evaluate(`new Promise((resolve,reject)=>{let count=0;const timer=setInterval(()=>{if(window.__STUDIO_STATE__.appliedRevision===${studio.store.appliedRevision}){clearInterval(timer);resolve(true)}else if(++count>100){clearInterval(timer);reject(new Error('UI sync timed out'))}},20)})`);
    await page.evaluate('window.__STUDIO_APP__.selectNodes([],"home")');
    await shortcut('v');
    await page.evaluate(`new Promise((resolve,reject)=>{let count=0;const timer=setInterval(()=>{if(window.__STUDIO_STATE__.scene.pages[0].nodes.some(n=>n.id==='copy-title_copy')){clearInterval(timer);resolve(true)}else if(++count>100){clearInterval(timer);reject(new Error('Paste timed out'))}},20)})`);
    let entries = [...new Set(buildNodeIndex(studio.store.doc).byScopedId.values())];
    assert.equal(entries.find(entry => entry.id === 'copy-title_copy').node.text, 'Copied text');
    await page.evaluate('window.__STUDIO_APP__.selectNodes([],"home")'); await shortcut('v');
    await page.evaluate(`new Promise((resolve,reject)=>{let count=0;const timer=setInterval(()=>{if(window.__STUDIO_STATE__.scene.pages[0].nodes.some(n=>n.id==='copy-title_copy_2')){clearInterval(timer);resolve(true)}else if(++count>100){clearInterval(timer);reject(new Error('Second paste timed out'))}},20)})`);
    entries = [...new Set(buildNodeIndex(studio.store.doc).byScopedId.values())];
    assert.equal(entries.find(entry => entry.id === 'copy-title_copy_2').node.text, 'Copied text');
  } finally { await studio.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mixed parent selections act once, cut owns a snapshot, and cross-page paste is one undoable transaction',{timeout:60000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-mixed-clipboard-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const doc=createEmptyStudioDocument({domain:'web'});doc.pages[0].root.children=[{type:'box',id:'group',x:60,y:100,w:320,h:140,layout:'stack',children:[{type:'label',id:'child',x:20,y:20,w:240,h:40,text:'Owned clipboard content'}]},{type:'label',id:'locked',x:60,y:300,w:200,h:40,text:'Locked',locked:true}];const source=join(dir,'source.json');writeFileSync(source,JSON.stringify(doc));const {studio}=await startStudioServer({projectDir:join(dir,'project'),sourcePath:source,port:0});t.after(()=>studio.close());const page=await studio.ensureManagedBrowserPage();
 const key=async(key,modifiers=0)=>{await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key.length===1?'Key'+key.toUpperCase():key,modifiers});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key.length===1?'Key'+key.toUpperCase():key});};
 const select=async(ids,pageId='home')=>page.evaluate(`window.__STUDIO_APP__.selectNodes(${JSON.stringify(ids)},${JSON.stringify(pageId)})`),wait=()=>page.waitForFunction(`window.__STUDIO_RENDERED_REVISION__===${studio.store.appliedRevision}`),entries=()=>[...new Set(buildNodeIndex(studio.store.doc).byScopedId.values())],get=id=>entries().find(entry=>entry.id===id)?.node;
 await select(['group','child']);await key('ArrowRight');await page.waitForFunction(`window.__STUDIO_STATE__.doc.pages[0].root.children.find(node=>node.id==='group').x===61`);assert.equal(get('child').x,20,'selected descendants must not move twice');
 await key('z',4);await page.waitForFunction(`window.__STUDIO_STATE__.doc.pages[0].root.children.find(node=>node.id==='group').x===60`);await select(['group','child']);await page.evaluate(`window.__STUDIO_APP__.setPanZoom(360,80,0.75)`);const point=await page.evaluate(`(()=>{const r=document.querySelector('[data-node-id="child"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await page.mouseDrag(point.x,point.y,point.x+20,point.y+15);await page.waitForFunction(`window.__STUDIO_STATE__.doc.pages[0].root.children.find(node=>node.id==='group').x===87`);assert.equal(get('child').x,20);await key('z',4);await page.waitForFunction(`window.__STUDIO_STATE__.doc.pages[0].root.children.find(node=>node.id==='group').x===60`);
 await select(['group','child']);await key('d',4);await page.waitForFunction(`window.__STUDIO_STATE__.scene.pages[0].nodes.some(node=>node.id==='group_copy')`);assert.equal(entries().filter(entry=>entry.id.startsWith('child_copy')).length,1,JSON.stringify(entries().map(entry=>entry.node)));await key('z',4);await page.waitForFunction(`!window.__STUDIO_STATE__.scene.pages[0].nodes.some(node=>node.id==='group_copy')`);
 await select(['group','child']);await key('Delete');await page.waitForFunction(`!window.__STUDIO_STATE__.scene.pages[0].nodes.some(node=>node.id==='group')`);await key('z',4);await page.waitForFunction(`window.__STUDIO_STATE__.scene.pages[0].nodes.some(node=>node.id==='child')`);
 const second=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:studio.store.appliedRevision,idempotencyKey:'second-page',commands:[{type:'addPage',id:'second',domain:'web'}]})})).json();assert(second.ok);await wait();await select(['group','child']);const cutRevision=studio.store.appliedRevision;await key('x',4);await page.waitForFunction(`window.__STUDIO_STATE__.appliedRevision===${cutRevision+1}&&!window.__STUDIO_STATE__.clipboardPending`);assert.equal(get('group'),undefined);assert.equal(await page.evaluate(`window.__STUDIO_STATE__.clipboardNodes.length`),1);
 await select([],'second');const beforePaste=studio.store.appliedRevision;await key('v',4);await page.waitForFunction(`window.__STUDIO_STATE__.appliedRevision===${beforePaste+1}`);assert.equal(get('child_copy').text,'Owned clipboard content');assert.equal(entries().find(entry=>entry.id==='group_copy').pageId,'second');await key('z',4);await page.waitForFunction(`!window.__STUDIO_STATE__.scene.pages.find(page=>page.id==='second').nodes.some(node=>node.id==='group_copy')`);assert.equal(get('child_copy'),undefined);
 await key('z',4);await page.waitForFunction(`window.__STUDIO_STATE__.scene.pages.find(page=>page.id==='home').nodes.some(node=>node.id==='group')`);const changed=await(await fetch(studio.url+'/api/commands',{method:'POST',body:JSON.stringify({baseRevision:studio.store.appliedRevision,idempotencyKey:'rapid-payload',commands:[{type:'setText',nodeId:'home/child',text:'Rapid cut payload'}]})})).json();assert(changed.ok);await wait();await select(['group'],'home');const rapidRevision=studio.store.appliedRevision;await key('x',4);await select([],'second');await key('v',4);await page.waitForFunction(`window.__STUDIO_STATE__.appliedRevision===${rapidRevision+2}`);assert.equal(get('child_copy').text,'Rapid cut payload','immediate paste must await the new cut payload');
 await select(['locked'],'home');const hash=studio.store.doc.contentHash,clipboard=await page.evaluate('JSON.stringify(window.__STUDIO_STATE__.clipboardNodes)');await key('x',4);await page.evaluate('new Promise(resolve=>setTimeout(resolve,100))');assert.equal(studio.store.doc.contentHash,hash);assert.equal(await page.evaluate('JSON.stringify(window.__STUDIO_STATE__.clipboardNodes)'),clipboard);assert.equal(page.scriptErrors.length,0);
});
