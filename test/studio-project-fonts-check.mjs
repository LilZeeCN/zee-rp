import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudioServer } from '../studio/server.mjs';
import { exportProjectBundle, importProjectBundle } from '../studio/project-bundle.mjs';
import { studioHandlers } from '../studio/mcp-adapter.mjs';
import { measureLineWidthExact } from '../studio/typography.mjs';
import { exportStudioDocumentToCode } from '../studio/export-code.mjs';
import { launchChrome } from '../studio/cdp.mjs';
const family = 'Zee Studio Test Sans';
const text = 'WWW iii MMMMM 0123';

test('project font catalog drives browser pixels, measurement, edits, preview and portable reopen without a system font', { timeout: 45000, skip: process.platform !== 'darwin' ? '工程字体度量依赖 CoreText；本切片仅在 macOS 验证' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-project-font-'));
  const original = join(dir, 'original'), migrated = join(dir, 'migrated'), bundleDir = join(dir, 'bundle');
  mkdirSync(join(original, 'fonts', 'deep'), { recursive: true });
  cpSync(new URL('./fixtures/fonts/studio-test-sans.ttf', import.meta.url), join(original, 'fonts', 'deep', 'arbitrary-file-name.ttf'));
  const sourcePath = join(dir, 'source.json');
  writeFileSync(sourcePath, JSON.stringify({ fonts: { defaultFamily: family, catalog: [{ family, source: 'project', path: 'fonts/deep/arbitrary-file-name.ttf' }] }, pages: [{ id: 'home', root: { id: 'root', type: 'box', w: 600, h: 400, children: [{ id: 'title', type: 'label', text, fontFamily: family, fontSize: 20, w: 'hug', h: 'hug' }, { id: 'change', type: 'button', text: 'Change', y: 100, w: 120, h: 44, onClick: [{ type: 'set-text', target: 'title', text: text + ' A' }, { type: 'set-text', target: 'wrap', text: 'AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA' }] }, { id: 'flow', type: 'box', layout: 'column', y: 160, w: 200, h: 'hug', children: [{ id: 'wrap', type: 'paragraph', text: 'A', fontFamily: family, fontSize: 20, lineHeight: 28, w: 100, h: 'hug' }, { id: 'following', type: 'label', text: 'Next', w: 100, h: 28 }] }] } }] }));
  let studio;
  const check = async () => {
    const n = studio.scene.pages[0].nodes.find(n => n.id === 'title');
    assert.equal(n.fontFamily, family, JSON.stringify(studio.scene.fontDiagnostics));
    assert.notEqual(n.fontStatus, 'fallback');
    const page = await studio.ensureManagedBrowserPage();
    const actual = await page.evaluate(`(()=>{const node=document.querySelector('[data-node-id="title"]');const context=document.createElement('canvas').getContext('2d');context.font='20px "${family}"';return {family:getComputedStyle(node).fontFamily,faces:[...document.fonts].map(f=>({family:f.family,status:f.status})),width:context.measureText(${JSON.stringify(text)}).width};})()`);
    assert(actual.faces.some(f => f.family.replaceAll('"', '') === family && f.status === 'loaded'), JSON.stringify(actual));
    assert(actual.family.includes(family));
    // Original font has explicit advances, unlike any system fallback.
    const expectedWidth = [...text].reduce((sum, c) => sum + (c === ' ' ? 300 : ['W','M'].includes(c) ? 750 : ['i','l'].includes(c) ? 280 : 550), 0) / 1000 * 20;
    assert(Math.abs(actual.width - expectedWidth) < 0.1, JSON.stringify({ actual, expectedWidth }));
    if (process.platform === 'darwin') {
      const measured = measureLineWidthExact(text, { fontFamily: family, fontSize: 20, projectDir: studio.projectDir, fontCatalog: studio.store.doc.fonts.catalog });
      assert(Math.abs(measured - actual.width) < 0.2, JSON.stringify({ measured, actual }));
    }
  };
  try {
    ({ studio } = await startStudioServer({ projectDir: original, sourcePath, port: 0 }));
    await check();
    assert.equal((await studioHandlers.studio_apply_commands({ url: studio.url, baseRevision: studio.store.appliedRevision, idempotencyKey: 'font-edit', commands: [{ type: 'setText', nodeId: 'title', text: text + ' A' }] })).ok, true);
    await check();
    assert.equal((await studioHandlers.studio_undo({ url: studio.url })).ok, true);
    await check();
    const runtime = await (await fetch(studio.url + '/api/runtime/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    // Preview may have its own response envelope but must keep the requested family.
    assert(!JSON.stringify(runtime).includes('"fontStatus":"fallback"'), JSON.stringify(runtime).slice(0, 500));
    const changed = await (await fetch(studio.url + '/api/runtime/click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: 'change' }) })).json();
    const runtimeTitle = (changed.runtimeState || changed.state || changed).activePageScene?.nodes.find(n => n.id === 'title');
    assert(runtimeTitle, JSON.stringify(changed).slice(0, 500));
    assert.equal(runtimeTitle.text, text + ' A');
    assert.equal(runtimeTitle.w, 216);
    assert(Math.abs(runtimeTitle.contentW - 215.8) < 1, JSON.stringify(runtimeTitle));
    assert.equal(exportProjectBundle({ doc: studio.store.doc, projectDir: original, bundleDir }).ok, true);
    await studio.close(); studio = null;
    rmSync(original, { recursive: true, force: true });
    rmSync(sourcePath);
    assert.equal(importProjectBundle({ bundleDir, targetProjectDir: migrated }).ok, true);
    assert(existsSync(join(migrated, 'fonts', 'deep', 'arbitrary-file-name.ttf')));
    ({ studio } = await startStudioServer({ projectDir: migrated, port: 0 }));
    await check();
    const codeDir = join(dir, 'code');
    const code = await exportStudioDocumentToCode(studio.store.doc, { projectDir: migrated, outDir: codeDir, registerExport: false });
    assert(code.manifest.fonts.some(font => font.family === family));
    await studio.close(); studio = null;
    rmSync(migrated, { recursive: true, force: true });
    const server = createServer((req,res) => {
      const path = join(codeDir, decodeURIComponent(req.url.split('?')[0]).replace(/^\//,'') || 'index.html');
      if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'application/javascript' : path.endsWith('.ttf') ? 'font/ttf' : 'text/html');
      res.end(readFileSync(path));
    });
    await new Promise(done => server.listen(0,'127.0.0.1',done));
    let browser;
    try {
      browser = await launchChrome();
      const page = await browser.openPage(`http://127.0.0.1:${server.address().port}/index.html`);
      await page.evaluate('document.fonts.ready.then(()=>true)');
      const actual = await page.evaluate(`(()=>{const c=document.createElement('canvas').getContext('2d');c.font='20px "${family}"';return {faces:[...document.fonts].map(f=>({family:f.family,status:f.status})),width:c.measureText(${JSON.stringify(text)}).width};})()`);
      assert(actual.faces.some(face => face.family.replaceAll('"','')===family && face.status==='loaded'), JSON.stringify(actual));
      assert(Math.abs(actual.width - 198.8)<.1,JSON.stringify(actual));
      const before = await page.evaluate(`Number.parseFloat(document.querySelector('[data-node-id="following"]').style.top)`);
      await page.evaluate(`document.querySelector('[data-node-id="change"]').click()`);
      const layout = await page.evaluate(`(()=>{const el=id=>document.querySelector('[data-node-id="'+id+'"]');return {titleW:parseFloat(el('title').style.width),wrapH:parseFloat(el('wrap').style.height),followingY:parseFloat(el('following').style.top),flowH:parseFloat(el('flow').style.height)};})()`);
      assert.equal(layout.titleW,216,JSON.stringify(layout));
      assert.equal(layout.wrapH,112,JSON.stringify(layout));
      assert.equal(layout.followingY-before,84,JSON.stringify(layout));
      assert.equal(layout.flowH,140,JSON.stringify(layout));
    } finally {
      if (browser) await browser.close();
      await new Promise(done => server.close(done));
    }
  } finally {
    if (studio) await studio.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
