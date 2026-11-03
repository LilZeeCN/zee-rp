import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSvgPathD,
  parseSvgMarkup,
  hitTestVectorPath,
  booleanVectorPaths,
  normalizeVectorNodeSpec,
} from '../studio/vector-paths.mjs';
import {
  importToStudioDocument as normalizeDocument,
} from '../studio/document.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { exportStudioDocumentToRp } from '../studio/export-rp.mjs';
import { syncNativeRpToStudio } from '../studio/sync-native.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords, encodeRecord, replaceRecord } from '../scripts/rp-records.mjs';
import { parsePayload, encodePayload, field } from '../scripts/parse-payload.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { launchChrome } from '../studio/cdp.mjs';
import { decodePng } from '../studio/png-decode.mjs';
import { JobManager } from '../scripts/jobs.mjs';
import { spawnSync } from 'node:child_process';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

test('V01-1: vector paths, quadratic/cubic curves, holes, transforms, fillRule, SVG interop & hit-testing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-v01-doc-'));
  try {
    // 1. Parse SVG markup with <g transform>, <path>, <polygon>, <circle>
    const svgParsed = parseSvgMarkup(`
      <svg viewBox="0 0 120 120" fill-rule="evenodd" stroke-linecap="square" stroke-linejoin="miter" stroke-dasharray="4 2">
        <g transform="translate(10, 10) scale(1)">
          <path d="M 0 0 L 100 0 Q 100 50 100 100 C 60 100 40 100 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z" />
        </g>
      </svg>
    `);
    assert.equal(svgParsed.fillRule, 'evenodd');
    assert.equal(svgParsed.strokeLinecap, 'square');
    assert.equal(svgParsed.subpaths.length, 2, 'Outer contour + inner hole subpath');
    assert.equal(svgParsed.subpaths[0].closed, true);
    assert.equal(svgParsed.subpaths[1].hole, true);

    // 2. Hit testing: anchor point, filled ring, and hole interior
    const anchorHit = hitTestVectorPath(svgParsed, 10, 10, { hitTolerance: 4 });
    assert.equal(anchorHit.hit, true);
    assert.equal(anchorHit.hitArea, 'control-point');
    assert.equal(anchorHit.pointIndex, 0);

    const solidHit = hitTestVectorPath(svgParsed, 20, 50, { hitTolerance: 1 });
    assert.equal(solidHit.hit, true);
    assert.equal(solidHit.insideFill, true, 'Point inside outer ring and outside hole must be filled');

    const holeCenterHit = hitTestVectorPath(svgParsed, 60, 60, { hitTolerance: 1 });
    assert.equal(holeCenterHit.insideFill, false, 'Point inside interior hole (35..85 after translate(10,10)) must NOT be filled');

    // 3. Authoring document with path & sparkline shorthand, editPath commands, and save/reopen
    let doc = normalizeDocument({
      name: 'V01 Vector Check',
      pages: [
        {
          id: 'vec_page',
          name: '矢量页',
          root: {
            id: 'vec_page_root',
            type: 'box',
            layout: 'free',
            x: 0,
            y: 0,
            w: 402,
            h: 874,
            children: [
              {
                id: 'trend_spark',
                sparkline: '0,40 30,20 60,32 90,8 120,18',
                x: 24,
                y: 80,
                w: 120,
                h: 48,
                stroke: '#2E6F57',
                strokeWidth: 2.5,
                smooth: true,
              },
              {
                id: 'compound_badge',
                type: 'path',
                x: 24,
                y: 160,
                w: 120,
                h: 120,
                d: svgParsed.d,
                fill: '#2E6F57',
                fillRule: 'evenodd',
                stroke: '#1B4332',
                strokeWidth: 2,
                viewBox: { x: 0, y: 0, w: 120, h: 120 },
              },
            ],
          },
        },
      ],
    });

    const store = new StudioDocumentStore(doc);
    store.applyTransaction({
      baseRevision: doc.revision,
      commands: [
        {
          type: 'editPath',
          pageId: 'vec_page',
          nodeId: 'trend_spark',
          operation: 'set-point',
          subpathIndex: 0,
          pointIndex: 2,
          handle: 'anchor',
          x: 64,
          y: 28,
        },
        {
          type: 'editPath',
          pageId: 'vec_page',
          nodeId: 'compound_badge',
          operation: 'bake-transform',
          transform: 'translate(4, 4)',
          bakeTransform: true,
        },
      ],
    });
    doc = store.doc;

    const persistence = new StudioPersistence(tmpDir);
    persistence.saveFullSnapshot(doc);
    const reopened = new StudioPersistence(tmpDir).initOrLoad().store.doc;
    assert.equal(reopened.contentHash, doc.contentHash, 'Save and reopen must preserve exact vector contentHash');

    const scene = resolveDocumentScene(reopened);
    const sparkNode = scene.pages[0].nodes.find(n => n.id === 'trend_spark');
    const badgeNode = scene.pages[0].nodes.find(n => n.id === 'compound_badge');
    assert.equal(sparkNode.type, 'path');
    assert.equal(sparkNode.subpaths[0].points[2].x, 64);
    assert.equal(sparkNode.subpaths[0].points[2].y, 28);
    assert.equal(badgeNode.fillRule, 'evenodd');
    assert.equal(badgeNode.subpaths.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('V01-2: boolean operations (union / subtract / intersect / exclude) and explicit invalid-geometry diagnostics', () => {
  const sqA = parseSvgPathD('M 0 0 L 100 0 L 100 100 L 0 100 Z');
  const sqB = parseSvgPathD('M 50 0 L 150 0 L 150 100 L 50 100 Z');
  const innerHole = parseSvgPathD('M 25 25 L 75 25 L 75 75 L 25 75 Z');

  const uRes = booleanVectorPaths('union', sqA, sqB);
  assert.equal(uRes.ok, true);
  assert.ok(Math.abs(uRes.diagnostics.netArea - 15000) < 1, `Expected union area 15000, got ${uRes.diagnostics.netArea}`);

  const sRes = booleanVectorPaths('subtract', sqA, sqB);
  assert.equal(sRes.ok, true);
  assert.ok(Math.abs(sRes.diagnostics.netArea - 5000) < 1, `Expected subtract area 5000, got ${sRes.diagnostics.netArea}`);

  const iRes = booleanVectorPaths('intersect', sqA, sqB);
  assert.equal(iRes.ok, true);
  assert.ok(Math.abs(iRes.diagnostics.netArea - 5000) < 1, `Expected intersect area 5000, got ${iRes.diagnostics.netArea}`);

  const xRes = booleanVectorPaths('exclude', sqA, sqB);
  assert.equal(xRes.ok, true);
  assert.ok(Math.abs(xRes.diagnostics.netArea - 10000) < 1, `Expected exclude area 10000, got ${xRes.diagnostics.netArea}`);

  // Nested hole subtraction (0..100 minus 25..75)
  const holeSub = booleanVectorPaths('subtract', sqA, innerHole);
  assert.equal(holeSub.ok, true);
  assert.equal(holeSub.diagnostics.outerRingCount, 1);
  assert.equal(holeSub.diagnostics.holeRingCount, 1);
  assert.ok(Math.abs(holeSub.diagnostics.netArea - 7500) < 1);
  assert.equal(hitTestVectorPath(holeSub, 50, 50).insideFill, false, 'Subtracted inner square must be a hole');
  assert.equal(hitTestVectorPath(holeSub, 10, 10).insideFill, true, 'Outer frame must remain filled');

  // Explicit diagnostics for open, degenerate, and self-intersecting paths
  const openPath = parseSvgPathD('M 0 0 L 100 0 L 100 100');
  assert.throws(
    () => booleanVectorPaths('union', openPath, sqB),
    { code: 'E_VECTOR_NOT_CLOSED' }
  );

  const degenPath = parseSvgPathD('M 10 10 L 20 20 Z');
  assert.throws(
    () => booleanVectorPaths('union', degenPath, sqB),
    { code: 'E_VECTOR_DEGENERATE' }
  );

  // Figure-8 self-intersecting polygon
  const selfIntPath = parseSvgPathD('M 0 0 L 100 100 L 100 0 L 0 100 Z');
  assert.throws(
    () => booleanVectorPaths('union', selfIntPath, sqB),
    { code: 'E_VECTOR_SELF_INTERSECTION' }
  );
});

test('V01-3: RP9 native Shape:300 export, per-node compatibility report, and ControlPoints roundtrip', { skip: nativeTemplateSkipReason() }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-v01-rp-'));
  try {
    const doc = normalizeDocument({
      name: 'V01 RP9 Vector Roundtrip',
      pages: [
        {
          id: 'vec_rp_page',
          name: '矢量导出页',
          root: {
            id: 'vec_rp_root',
            type: 'box',
            layout: 'free',
            x: 0,
            y: 0,
            w: 402,
            h: 874,
            children: [
              {
                id: 'native_poly',
                type: 'path',
                name: '原生多边形',
                x: 40,
                y: 100,
                w: 120,
                h: 90,
                d: 'M 0 90 L 60 0 L 120 90 Z',
                fill: '#2E6F57',
                stroke: '#1B4332',
                strokeWidth: 2,
              },
              {
                id: 'complex_donut',
                type: 'path',
                name: '复合圆环',
                x: 40,
                y: 240,
                w: 120,
                h: 120,
                // Outer square and inner square with same clockwise winding + strokeDasharray -> triggers fallback report
                d: 'M 0 0 L 120 0 L 120 120 L 0 120 Z M 30 30 L 90 30 L 90 90 L 30 90 Z',
                fill: '#D97706',
                fillRule: 'evenodd',
                strokeDasharray: '4 2',
              },
            ],
          },
        },
      ],
    });

    const nativeSpec = normalizeVectorNodeSpec(doc.pages[0].root.children[0]);
    const donutSpec = normalizeVectorNodeSpec(doc.pages[0].root.children[1]);
    assert.equal(nativeSpec.nativeCompatibility.nativeEditable, true);
    assert.equal(nativeSpec.nativeCompatibility.hasFallback, false);
    assert.equal(donutSpec.nativeCompatibility.hasFallback, true);
    assert.ok(donutSpec.nativeCompatibility.fallbackReasons.some(r => r.feature.includes('strokeDasharray')));

    const rpOut = path.join(tmpDir, 'vector-out.rp');
    const expRes = await exportStudioDocumentToRp(doc, { outRpPath: rpOut });
    assert.equal(expRes.ok, true);
    assert.equal(expRes.report.summary.threeZerosPassed, true);
    assert.equal(expRes.report.wholePageRasterized, false);
    assert.equal(expRes.report.vectorAlignment.totalVectorNodes, 2);
    assert.equal(expRes.report.vectorAlignment.nativeShape300Count, 2);
    assert.equal(expRes.report.vectorAlignment.allVectorsPreserved, true);
    assert.ok(
      expRes.report.entries.some(e => e.nodeId === 'complex_donut' && e.classification === 'unsupported'),
      'Expected per-node fallback entry for complex_donut'
    );

    // Verify RP9 package actually contains Shape: 300 and ControlPoints
    let buf = fs.readFileSync(rpOut);
    const parsedRp = readRp(buf, { includeVectors: true });
    const polyWidget = parsedRp.pages[0].widgets.find(w => w.name.includes('native_poly'));
    assert.ok(polyWidget, 'Expected native_poly widget in RP9 package');
    assert.equal(polyWidget.shape, 300, 'Expected RP9 Shape: 300 (VectorShape)');
    assert.ok(Array.isArray(polyWidget.controlPoints) && polyWidget.controlPoints[0].length >= 3);

    // Real Axure RP 9 GUI open -> save -> close -> reopen verification on macOS when Axure RP 9 is installed
    if (process.platform === 'darwin' && fs.existsSync('/Applications/Axure RP 9.app')) {
      const guiRpOut = path.join(tmpDir, `vector-gui-${path.basename(tmpDir)}.rp`);
      const jobs = new JobManager();
      const rt = await jobs.startRoundtrip({ source: rpOut, output: guiRpOut, version: 9, wait: true });
      assert.equal(rt.status, 'completed', `RP9 GUI roundtrip failed: ${rt.stderr || rt.error || JSON.stringify(rt)}`);
      assert.equal(rt.validation?.guiSaved, true);
      assert.equal(rt.validation?.closed, true);
      assert.equal(rt.validation?.reopened, true);
      const guiParsed = readRp(fs.readFileSync(guiRpOut), { includeVectors: true });
      assert.equal(guiParsed.records.unparseable, 0);
      assert.equal(guiParsed.counts.danglingRefs, 0);
      assert.equal(guiParsed.counts.problems, 0);
      const guiPoly = guiParsed.pages[0].widgets.find(w => w.name.includes('native_poly'));
      assert.equal(guiPoly?.shape, 300);
      assert.ok(Array.isArray(guiPoly?.controlPoints) && guiPoly.controlPoints[0].length >= 3);
      spawnSync('swift', [path.resolve('tools/axtool.swift'), 'press', 'com.axure.AxureRP9', 'File', 'Close', '--raise', 'vector-gui-saved'], { encoding: 'utf8' });
    }

    // Mutate a ControlPoint in RP9 binary record and verify syncNativeRpToStudio roundtrips it back via editPath
    const editedRp = path.join(tmpDir, 'vector-edited.rp');
    const rec = readRecords(buf).find(r => r.index === parsedRp.pages[0].record);
    const graph = parsePayload(rec);
    const wObj = graph.objects.get(Number(polyWidget.id));
    const cpList = field(wObj.body, 'ControlPoints');
    const firstSubpath = cpList.items[0];
    const apexPoint = firstSubpath.items[1];
    const pathMap = field(apexPoint, 'Path');
    // Move apex X from 0.5 to 0.75 (60px -> 90px)
    const xEntry = pathMap.entries.find(([k]) => k.text === 'X');
    xEntry[1] = { tag: 6, value: 0.75 };
    buf = replaceRecord(buf, rec, encodeRecord(rec, [...rec.strings], encodePayload(graph.roots)));
    fs.writeFileSync(editedRp, buf);

    const syncStore = new StudioDocumentStore(doc);
    const syncRes = await syncNativeRpToStudio({
      store: syncStore,
      rpPath: editedRp,
      baseRpPath: rpOut,
      mode: 'apply',
    });
    assert.equal(syncRes.ok, true);
    assert.ok(
      syncRes.commands.some(c => c.type === 'editPath' && (c.nodeId === 'native_poly' || c.nodeId === 'vec_rp_page/native_poly')),
      `Expected editPath command from RP9 ControlPoints edit, got ${JSON.stringify(syncRes.commands)}`
    );
    const updatedPoly = syncStore.doc.pages[0].root.children.find(c => c.id === 'native_poly');
    assert.ok(Math.abs(updatedPoly.points.subpaths[0].points[1].x - 90) <= 1, `Expected apex X ~90 after RP9 roundtrip, got ${updatedPoly.points.subpaths[0].points[1].x}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('V01-4: browser SVG path rendering, control-point handle drag, and booleanPathOp command', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-v01-web-'));
  let server = null;
  let managed = null;
  try {
    const doc = normalizeDocument({
      name: 'V01 Browser Vector Check',
      pages: [
        {
          id: 'web_vec_page',
          name: '画布矢量页',
          root: {
            id: 'web_vec_root',
            type: 'box',
            layout: 'free',
            x: 0,
            y: 0,
            w: 402,
            h: 874,
            children: [
              {
                id: 'vec_a',
                type: 'path',
                name: '矢量A',
                x: 40,
                y: 120,
                w: 100,
                h: 100,
                d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
                fill: '#2E6F57',
                stroke: '#1B4332',
                strokeWidth: 2,
              },
              {
                id: 'vec_b',
                type: 'path',
                name: '矢量B',
                x: 90,
                y: 120,
                w: 100,
                h: 100,
                d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
                fill: '#3B9B78',
                stroke: '#1B4332',
                strokeWidth: 2,
              },
            ],
          },
        },
      ],
    });
    const persistence = new StudioPersistence(tmpDir);
    persistence.saveFullSnapshot(doc);
    server = await startStudioServer({ projectDir: tmpDir, port: 0 });
    managed = await launchChrome();
    const cdp = await managed.openPage(server.info.url);

    await cdp.evaluate(`new Promise(resolve => {
      const check = () => window.__STUDIO_APP__?.state?.renderedRevision >= 1 ? resolve(true) : setTimeout(check, 30);
      check();
    })`);

    // Select vec_a and verify SVG path + vector point handles are rendered
    const handleBox = await cdp.evaluate(`(() => {
      window.__STUDIO_APP__.selectNodes(['vec_a']);
      const svgPath = document.querySelector('#screen-root .studio-node[data-node-id="vec_a"] svg.studio-vector-svg path.studio-vector-path');
      const handle = document.querySelector('#overlay-layer .vector-point-handle[data-vector-point="0:1:anchor"]');
      if (!svgPath || !handle) return null;
      const r = handle.getBoundingClientRect();
      return {
        d: svgPath.getAttribute('d'),
        cx: Math.round(r.left + r.width / 2),
        cy: Math.round(r.top + r.height / 2),
      };
    })()`);
    assert.ok(handleBox && handleBox.d.includes('M 0 0'), 'Expected rendered <svg><path> and control point handle');

    // Drag control point 0:1:anchor by +20px X in the browser
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: handleBox.cx,
      y: handleBox.cy,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: handleBox.cx + 20,
      y: handleBox.cy,
      button: 'left',
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: handleBox.cx + 20,
      y: handleBox.cy,
      button: 'left',
      clickCount: 1,
    });

    await cdp.evaluate(`new Promise(resolve => {
      const check = () => window.__STUDIO_APP__?.state?.renderedRevision >= 2 ? resolve(true) : setTimeout(check, 30);
      check();
    })`);

    const afterPointDrag = await cdp.evaluate(`(() => {
      const n = window.__STUDIO_APP__.state.scene.pages[0].nodes.find(x => x.id === 'vec_a');
      return { rev: window.__STUDIO_APP__.state.renderedRevision, p1x: n.subpaths[0].points[1].x, svgD: n.svgD };
    })()`);
    assert.equal(afterPointDrag.rev, 2);
    assert.ok(afterPointDrag.p1x > 105, `Expected control point 1 X > 105 after browser drag, got ${afterPointDrag.p1x}`);

    // Now select both vec_a and vec_b in browser and click the Inspector boolean Union button
    await cdp.evaluate(`(async () => {
      window.__STUDIO_APP__.selectNodes(['vec_a', 'vec_b']);
      const btn = document.getElementById('insp-bool-union');
      if (!btn) throw new Error('Missing #insp-bool-union button in multi-select inspector');
      btn.click();
    })()`);

    await cdp.evaluate(`new Promise(resolve => {
      const check = () => window.__STUDIO_APP__?.state?.renderedRevision >= 3 ? resolve(true) : setTimeout(check, 30);
      check();
    })`);

    const afterBool = await cdp.evaluate(`(() => {
      const n = window.__STUDIO_APP__.state.scene.pages[0].nodes.find(x => x.id === 'vec_a');
      return { rev: window.__STUDIO_APP__.state.renderedRevision, w: n.w, h: n.h, svgD: n.svgD };
    })()`);
    assert.equal(afterBool.rev, 3);
    assert.ok(afterBool.w >= 145, `Union of x=40..160 and x=90..190 should have width >= 145, got ${afterBool.w}`);

    // Capture screenshot and verify non-zero pixel contrast inside the rendered vector shape
    const shotRes = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const pngBytes = Buffer.from(shotRes.data, 'base64');
    const decoded = decodePng(pngBytes);
    assert.ok(decoded.width > 100 && decoded.height > 100);
    let greenPixels = 0;
    let bgPixels = 0;
    for (let i = 0; i < decoded.pixels.length; i += 4) {
      const r = decoded.pixels[i];
      const g = decoded.pixels[i + 1];
      const b = decoded.pixels[i + 2];
      // #2E6F57 has R ~ 46, G ~ 111, B ~ 87
      if (g > r + 30 && g > b + 10 && r < 100) greenPixels++;
      else if (r > 235 && g > 235 && b > 235) bgPixels++;
    }
    assert.ok(greenPixels > 500 && bgPixels > 500, `Expected non-zero pixel contrast for vector fill (#2E6F57), got greenPixels=${greenPixels}, bgPixels=${bgPixels}`);
  } finally {
    if (managed) await managed.close();
    if (server?.studio) await server.studio.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
