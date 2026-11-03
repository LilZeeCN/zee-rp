import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importToStudioDocument } from '../studio/document.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { exportStudioDocumentToRp } from '../studio/export-rp.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { measureTextBoxExact } from '../studio/typography.mjs';

const source = { device: 'iphone-17-pro', pages: [{ id: 'home', name: '01 测试 页', device: 'iphone-17-pro', root: {
  id: 'home_shell', type: 'phone-shell', padding: 0, statusBar: false, children: [{
    id: 'home_screen', type: 'box', layout: 'stack', w: 402, h: 874, fill: '#112233', children: [
      { id: 'effect', type: 'box', x: 40, y: 150, w: 220, h: 100, css: { background: 'linear-gradient(red,blue)' }, children: [
        { id: 'title', type: 'label', x: 12, y: 15, w: 160, h: 24, text: '真实内容' },
      ] },
      { id: 'leaf_effect', type: 'box', x: 50, y: 320, w: 220, h: 60, css: { background: 'linear-gradient(green,blue)' } },
    ],
  }],
} }] };

test('filled labels use their actual text box, not implicit button padding', () => {
  const m = measureTextBoxExact({ type: 'label', text: '2', w: 22, h: 22, fontSize: 12, lineHeight: 22, fill: '#C2602B', radius: 11 });
  assert.equal(m.clipped, false);
});

test('phone screen paints its own background without a duplicate rectangle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-design-bg-'));
  let studio;
  try {
    const path = join(dir, 'source.json'); writeFileSync(path, JSON.stringify(source));
    ({ studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath: path, port: 0 }));
    const page = await studio.ensureManagedBrowserPage();
    const fill = await page.evaluate(`(() => { const el=document.querySelector('[data-node-id="home_screen"]'); return el && getComputedStyle(el).backgroundColor; })()`);
    assert.equal(fill, 'rgb(17, 34, 51)');
  } finally { await studio?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('decoration in a phone shell keeps the same native parent coordinates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-design-effect-'));
  try {
    const out = join(dir, 'effect.rp');
    await exportStudioDocumentToRp(importToStudioDocument(source), { outRpPath: out });
    const rp = readRp(readFileSync(out));
    const paint = rp.pages[0].widgets.find(w => w.name?.includes('effect__css_paint'));
    assert.ok(paint);
    assert.equal(paint.x, 60); assert.equal(paint.y, 170);
    const leaf = rp.pages[0].widgets.find(w => w.name?.includes('leaf_effect__css_paint'));
    assert.equal(leaf.x, 70); assert.equal(leaf.y, 340);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
