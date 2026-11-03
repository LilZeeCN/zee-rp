import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importToStudioDocument } from '../studio/document.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { exportCssPlan, visualCss } from '../studio/visual-style.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { exportStudioDocumentToRp } from '../studio/export-rp.mjs';

const css = { background: 'conic-gradient(#904bdb, #63e4ce, #904bdb)', transform: 'perspective(800px) rotateY(35deg) scale(.8)', filter: 'saturate(1.3)', maskImage: 'linear-gradient(black, transparent)' };
const source = { pages: [{ id: 'effects', canvas: { w: 600, h: 500 }, root: { id: 'root', type: 'box', layout: 'stack', w: 600, h: 500, children: [{ id: 'card', type: 'box', x: 40, y: 60, w: 300, h: 200, css, children: [{ id: 'title', type: 'label', text: 'Editable text', x: 20, y: 20, w: 200, h: 30 }] }] } }] };

test('browser scene preserves advanced CSS instead of dropping it at the RP boundary', () => {
  const doc = importToStudioDocument(source);
  const scene = resolveDocumentScene(doc);
  assert.deepEqual(scene.pages[0].nodes.find(n => n.id === 'card').css, css);
  assert.deepEqual(doc.pages[0].root.children[0].css, css);
});

test('scene retains the actual DOM parent for container effects and transforms', () => {
  const scene = resolveDocumentScene(importToStudioDocument(source));
  const nodes = scene.pages[0].nodes;
  assert.equal(nodes.find(n => n.id === 'title').parentScopedId, nodes.find(n => n.id === 'card').scopedId);
});

test('CSS edits share atomic history, reject stale writes, undo and survive document reload', () => {
  const store = new StudioDocumentStore(importToStudioDocument(source));
  const tx = { baseRevision: 1, idempotencyKey: 'css-edit', pageId: 'effects', commands: [{ type: 'setProperties', nodeId: 'card', properties: { css: { background: 'radial-gradient(#fff, #123456)', mixBlendMode: 'screen' } } }] };
  const result = store.applyTransaction(tx);
  assert.equal(result.ok, true);
  const after = structuredClone(store.doc.pages[0].root.children[0].css);
  assert.deepEqual(importToStudioDocument(structuredClone(store.doc)).pages[0].root.children[0].css, after);
  assert.equal(store.applyTransaction(tx).idempotentReplay, true);
  assert.equal(store.applyTransaction({ ...tx, idempotencyKey: 'stale' }).ok, false);
  assert.equal(store.undo({ expectedRevision: store.doc.revision }).ok, true);
  assert.deepEqual(store.doc.pages[0].root.children[0].css, css);
});

test('CSS cannot bypass geometry authority and a rejected batch leaves the document unchanged', () => {
  const store = new StudioDocumentStore(importToStudioDocument(source));
  const hash = store.doc.contentHash;
  const result = store.applyTransaction({ baseRevision: 1, idempotencyKey: 'invalid-css', pageId: 'effects', commands: [
    { type: 'setText', nodeId: 'title', text: 'must roll back' },
    { type: 'setProperties', nodeId: 'card', properties: { css: { width: '900px' } } },
  ] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_CSS_LAYOUT_PROPERTY');
  assert.equal(store.doc.contentHash, hash);
});

test('native export separates decoration paint from group/text effects without deleting CSS', () => {
  const before = structuredClone(source);
  const plan = exportCssPlan(source.pages[0].root.children[0]);
  assert.ok(plan.paint.background);
  assert.equal(plan.paint['mask-image'], undefined);
  assert.deepEqual(plan.unsupported.sort(), ['filter', 'mask-image', 'transform']);
  const decoration = exportCssPlan({ type: 'box', css: { maskImage: 'linear-gradient(black, transparent)', filter: 'contrast(1.2)' } });
  assert.ok(decoration.paint['mask-image']);
  assert.ok(decoration.paint.filter);
  const text = exportCssPlan({ type: 'label', css: { background: 'linear-gradient(red,blue)', backgroundClip: 'text', color: 'transparent' } });
  assert.equal(text.hasPaint, false);
  assert.ok(text.unsupported.includes('background-clip'));
  assert.deepEqual(source, before);
});

test('legacy optical effects produce real browser CSS and backdrop dependence is disclosed on export', () => {
  const node = { gradient: { angle: 40, stops: ['#000000', '#FFFFFF'] }, noise: .1, aurora: true, backdropBlur: 12, customFilter: 'contrast(1.2)', threeDTransform: 'rotateY(25deg)' };
  const style = visualCss(node);
  assert.match(style['background-image'], /linear-gradient\(40deg/);
  assert.match(style['background-image'], /feTurbulence/);
  assert.equal(style.transform, 'rotateY(25deg)');
  assert.equal(style.filter, 'contrast(1.2)');
  assert.ok(exportCssPlan(node).unsupported.includes('backdrop-filter'));
});

test('real browser renders rich CSS on a DOM subtree and screenshot metadata matches the PNG pixels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-studio-css-browser-'));
  let studio;
  try {
    const sourcePath = join(dir, 'source.json');
    writeFileSync(sourcePath, JSON.stringify(source));
    ({ studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath, port: 4390 }));
    const outPath = join(dir, 'effects.png');
    const shot = await studio.captureScreenshot({ pageId: 'effects', outPath, timeoutMs: 10000 });
    const png = readFileSync(outPath);
    assert.equal(shot.width, png.readUInt32BE(16));
    assert.equal(shot.height, png.readUInt32BE(20));
    const rendered = await studio.managedPage.evaluate(`(() => {
      const card = document.querySelector('[data-node-id="card"]');
      const title = document.querySelector('[data-node-id="title"]');
      const style = getComputedStyle(card);
      return { background: style.backgroundImage, transform: style.transform, filter: style.filter, mask: style.maskImage, nested: card.contains(title) };
    })()`);
    assert.match(rendered.background, /conic-gradient/);
    assert.match(rendered.transform, /matrix3d/);
    assert.equal(rendered.filter, 'saturate(1.3)');
    assert.notEqual(rendered.mask, 'none');
    assert.equal(rendered.nested, true);
    // Return from the capture's 1:1 crop to the editor's unobstructed work area.
    await studio.managedPage.evaluate("document.getElementById('btn-zoom-fit').click()");
    const center = await studio.managedPage.evaluate(`(() => { const r = document.querySelector('[data-node-id="title"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await studio.managedPage.mouseDrag(center.x, center.y, center.x + 80, center.y + 30);
    await studio.managedPage.waitForFunction(`window.__STUDIO_RENDERED_REVISION__ > ${shot.revision}`);
    const moved = await studio.managedPage.evaluate(`(() => { const r = document.querySelector('[data-node-id="title"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    assert.ok(Math.abs(moved.x - center.x - 80) < 2, `child drag should follow the pointer through parent CSS transforms: ${moved.x - center.x}px instead of 80px`);
    assert.ok(Math.abs(moved.y - center.y - 30) < 2);
  } finally {
    if (studio) await studio.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('floating workspace chrome never contaminates artwork captures and returns after capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-studio-capture-chrome-'));
  let studio;
  try {
    const sourcePath = join(dir, 'source.json');
    writeFileSync(sourcePath, JSON.stringify({ pages: [{ id: 'sample', canvas: { w: 320, h: 240 }, root: { id: 'root', type: 'box', w: 320, h: 240, fill: '#14B8A6' } }] }));
    ({ studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath, port: 0 }));
    const outPath = join(dir, 'artwork.png');
    const shot = await studio.captureScreenshot({ pageId: 'sample', outPath });
    const base64 = readFileSync(outPath).toString('base64');
    const pixels = await studio.managedPage.evaluate(`(async () => {
      const img = new Image(); img.src = 'data:image/png;base64,${base64}'; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
      return [[20, 160], [300, 20]].map(([x,y]) => [...context.getImageData(x, y, 1, 1).data]);
    })()`);
    assert.deepEqual(pixels, [[20, 184, 166, 255], [20, 184, 166, 255]]);
    assert.equal(shot.width, 640);
    assert.equal(shot.height, 480);
    assert.equal(await studio.managedPage.evaluate("document.body.classList.contains('studio-capture')"), false);
    assert.equal(await studio.managedPage.evaluate("getComputedStyle(document.getElementById('left-sidebar')).visibility"), 'visible');
    assert.equal(shot.revision, 1);
  } finally {
    if (studio) await studio.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RP9 export embeds real decoration PNGs, keeps native text and reports incompatible group effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-studio-css-export-'));
  try {
    const doc = importToStudioDocument(source);
    const before = JSON.stringify(doc);
    const result = await exportStudioDocumentToRp(doc, { projectDir: dir, outRpPath: join(dir, 'effects.rp') });
    assert.equal(result.report.summary.threeZerosPassed, true);
    assert.equal(result.report.geometryAlignment.passed99PercentWithin1Px, true, JSON.stringify(result.report.geometryAlignment));
    assert.equal(JSON.stringify(doc), before);
    const image = result.report.effectAssets[0];
    assert.ok(image.paintOnly);
    const png = readFileSync(join(result.report.effectAssetsDirectory, image.src.split('/').at(-1)));
    assert.equal(png.readUInt32BE(16), 300);
    assert.equal(png.readUInt32BE(20), 200);
    assert.ok(result.report.entries.some(e => e.nodeId === 'title' && e.classification === 'native-editable'));
    assert.ok(result.report.entries.some(e => e.nodeId === 'card' && e.classification === 'unsupported' && e.feature.includes('transform') && e.feature.includes('mask-image')));
    assert.equal(result.report.editableTextRasterized, false);
    assert.equal(resolveDocumentScene(doc).pages[0].rootTree.children[0]._cssPaintAsset, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
