import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromeExecutable } from '../studio/cdp.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { studioHandlers } from '../studio/mcp-adapter.mjs';
import { computeDesignMetrics } from '../studio/design-metrics.mjs';

const label = (id, x, y, color, extra = {}) => ({ id, type: 'label', text: 'MMMMMMMM', x, y, w: 300, h: 40, fontSize: 24, fontWeight: 700, color, ...extra });
const source = { domain: 'web', pages: [{ id: 'pixels', domain: 'web', canvas: { w: 1600, h: 1000 }, root: {
  id: 'root', type: 'box', layout: 'stack', w: 1600, h: 1000, fill: '#000000', children: [
    label('white', 30, 30, '#FFFFFF'),
    label('own-clip', 1220, 400, '#FFFFFF', {text:'gy', fontSize:58, lineHeight:64, h:32}),
    label('alpha', 30, 100, '#FFFFFF33'),
    label('opacity', 30, 170, '#FFFFFF', { opacity: .2 }),
    label('covered', 30, 240, '#FFFFFF'),
    { id: 'cover', type: 'box', x: 25, y: 235, w: 320, h: 50, fill: '#000000' },
    label('partial', 400, 240, '#FFFFFF'),
    { id: 'partial-cover', type: 'box', x: 400, y: 235, w: 60, h: 50, fill: '#000000' },
    { id: 'gradient', type: 'box', layout: 'stack', x: 400, y: 30, w: 800, h: 100,
      css: { background: 'linear-gradient(90deg, #000 0%, #000 12%, #fff 16%, #fff 100%)' },
      children: [label('on-gradient', 0, 0, '#FFFFFF', { w: 800 })] },
    label('intra-gradient', 800, 240, '#FFFFFF', { text: 'M', w: 120, h: 80, fontSize: 72, lineHeight: 80,
      css: { background: 'linear-gradient(to bottom, #000 35%, #fff 45%)' } }),
    label('half-glyph', 1000, 240, '#FFFFFF', { text: 'M', w: 120, h: 80, fontSize: 72, lineHeight: 80 }),
    { id: 'half-cover', type: 'box', x: 1000, y: 280, w: 120, h: 40, fill: '#000000' },
    label('scaled-small', 800, 400, '#888888', { text: 'MMMM', fontSize: 40, w: 300, h: 60,
      fill: '#FFFFFF', css: { transform: 'scale(.25)', transformOrigin: 'top left' } }),
    { id: 'clip-parent', type: 'box', layout: 'stack', x: 800, y: 520, w: 120, h: 40, radius: 1, children: [
      label('clipped-half', 0, 0, '#FFFFFF', { text: 'M', w: 120, h: 80, fontSize: 72, lineHeight: 80 })] },
    label('current-color', 1000, 520, '#FFFFFF', { css: { background: 'currentColor' } }),
    label('far-right', 1400, 100, '#FFFFFF', { w: 190 }),
    { id: 'transformed', type: 'box', layout: 'stack', x: 400, y: 400, w: 400, h: 80, fill: '#FFFFFF',
      css: { transform: 'translate(180px, 20px)' }, children: [label('moved', 0, 0, '#000000')] },
  ],
} }, { id: 'phone', device: 'iphone-17', root: { id: 'phone-root', type: 'box', layout: 'stack', w: 393, h: 852, fill: '#FFFFFF', children: [label('phone-title', 30, 100, '#000000')] } }] };

let browserAvailable = typeof WebSocket !== 'undefined';
try { findChromeExecutable(); } catch { browserAvailable = false; }
test('pixel measurement uses rendered glyphs, local backgrounds and real capture coordinates', { skip: !browserAvailable && 'requires local Chrome and a WebSocket-capable Node runtime' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-pixel-regression-'));
  const sourcePath = join(dir, 'source.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  const { studio } = await startStudioServer({ projectDir: dir, sourcePath, port: 0, domain: 'web' });
  const metric = () => studioHandlers.studio_design_metrics({ url: studio.url, pageId: 'pixels' });
  try {
    await t.test('MCP defaults to pixel measurement', async () => {
      const m = await metric();
      assert.equal(m.metrics.contrast.source, 'pixel');
    });
    const shot = await studio.capturePixelContrast('pixels', { dpr: 1.25 });
    const byId = new Map(shot.results.map(r => [r.id, r]));
    await t.test('fractional DPR and far edge survive floating panels', () => {
      assert.equal(shot.dpr, 1.25);
      for (const id of ['white', 'far-right', 'moved']) {
        assert.equal(byId.get(id)?.passes, true, JSON.stringify(byId.get(id)));
        assert.ok(byId.get(id).ratio > 19, JSON.stringify(byId.get(id)));
      }
    });
    await t.test('foreground alpha and element opacity are measured after composition', () => {
      for (const id of ['alpha', 'opacity']) {
        const r = byId.get(id);
        assert.equal(r?.passes, false, JSON.stringify(r));
        assert.ok(r.ratio > 1.5 && r.ratio < 1.8, JSON.stringify(r));
      }
    });
    await t.test('fully and partly occluded text cannot pass', () => {
      for (const id of ['covered', 'partial', 'own-clip']) {
        assert.equal(byId.get(id)?.passes, false, JSON.stringify(byId.get(id)));
        assert.ok(byId.get(id)?.status === 'unknown' || byId.get(id)?.ratio < 3);
      }
    });
    await t.test('gradient evaluates backgrounds under each glyph', () => {
      const r = byId.get('on-gradient');
      assert.equal(r?.passes, false, JSON.stringify(r));
    });
    await t.test('the weakest core stroke matters within a glyph', () => {
      for (const id of ['intra-gradient', 'half-glyph', 'clipped-half', 'current-color']) assert.equal(byId.get(id)?.passes, false, JSON.stringify(byId.get(id)));
    });
    await t.test('scaled text uses its rendered size threshold', () => {
      const r = byId.get('scaled-small');
      assert.equal(r?.required, 4.5, JSON.stringify(r));
      assert.equal(r?.passes, false);
    });
    await t.test('device shell offset uses the actual text DOM', async () => {
      const phone = await studio.capturePixelContrast('phone', { dpr: 1.5 });
      assert.equal(phone.results.find(r => r.id === 'phone-title')?.passes, true, JSON.stringify(phone));
    });
    await t.test('capture calls serialize and restore temporary paint changes', async () => {
      const [a, b] = await Promise.all([studio.capturePixelContrast('pixels'), studio.capturePixelContrast('phone')]);
      assert.equal(a.results.find(r => r.id === 'white')?.passes, true);
      assert.equal(b.results.find(r => r.id === 'phone-title')?.passes, true);
      assert.equal(await studio.managedPage.evaluate("document.querySelectorAll('[data-studio-hide-glyphs]').length"), 0);
    });
    await t.test('fallback and explicit geometry carry their source and reason', async () => {
      const capture = studio.capturePixelContrast;
      studio.capturePixelContrast = async () => { throw Object.assign(new Error('injected browser unavailable'), { code: 'E_TEST_BROWSER' }); };
      try {
        const fallback = await metric();
        assert.equal(fallback.metrics.contrast.source, 'geometry');
        assert.match(fallback.metrics.contrast.fallbackReason, /injected browser unavailable/);
        const explicit = await studioHandlers.studio_design_metrics({ url: studio.url, pageId: 'pixels', pixelTruth: false });
        assert.equal(explicit.metrics.contrast.source, 'geometry');
        assert.equal(explicit.metrics.contrast.fallbackReason, undefined);
      } finally { studio.capturePixelContrast = capture; }
    });
    await t.test('missing measurements remain node-addressable unknowns', () => {
      const pg = studio.scene.pages.find(p => p.id === 'pixels');
      const report = computeDesignMetrics(pg, { doc: studio.store.doc, pixelContrast: [] }).metrics.contrast;
      assert.ok(report.unknownNodes.includes('white'));
      assert.ok(report.unknown > 0);
    });
    await t.test('failed capture restores all temporary glyph paint', async () => {
      const page = studio.managedPage, original = page.screenshot;
      let shots = 0;
      page.screenshot = function (...args) {
        if (++shots === 2) throw new Error('injected screenshot failure');
        return original.apply(this, args);
      };
      try { await assert.rejects(studio.capturePixelContrast('pixels'), /injected screenshot failure/); }
      finally { page.screenshot = original; }
      assert.equal(await page.evaluate("document.querySelectorAll('#studio-pixel-paint, [data-studio-hide-glyphs], [data-studio-original-paint], body.studio-capture').length"), 0);
      assert.equal((await studio.capturePixelContrast('pixels')).results.find(r => r.id === 'white')?.passes, true);
    });
    await t.test('concurrent document edits invalidate the measured revision', async () => {
      const page = studio.managedPage, original = page.screenshot;
      let shots = 0;
      page.screenshot = async function (...args) {
        const png = await original.apply(this, args);
        if (++shots === 2) studio.store.applyTransaction({ baseRevision: studio.store.appliedRevision,
          idempotencyKey: 'pixel-concurrent-edit', pageId: 'pixels', commands: [{ type: 'setText', nodeId: 'white', text: 'Changed' }] });
        return png;
      };
      try { await assert.rejects(studio.capturePixelContrast('pixels'), { code: 'E_PIXEL_REVISION_CHANGED' }); }
      finally { page.screenshot = original; }
    });
  } finally {
    await studio.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
