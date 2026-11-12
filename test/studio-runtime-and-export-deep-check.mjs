import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { evaluatePrototypeExpression, executePrototypeInteraction } from '../studio/prototype-runtime.mjs';
import { createRuntimeState, applyRuntimeStep } from '../studio/commands/runtime.mjs';
import { normalizeStudioDocument } from '../studio/document.mjs';
import { StudioRuntimeSession } from '../studio/runtime.mjs';
import { exportStudioDocumentToCode } from '../studio/export-code.mjs';
import { exportStudioDocumentToRp } from '../studio/export-rp.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('safe expression evaluator handles hyphen subtraction, negative vars, functions, and blocks host JS', () => {
  const ctx = {
    variables: { count: 5, delta: -3, 'my-var': 10, label: '  Hello World  ' },
    getWidgetText: id => (id === 'my-input' ? '42' : ''),
    resolveDatasetPath: (ds, p) => (ds === 'orders' && p === 'count' ? 7 : ''),
    itemRow: { price: 19 },
  };

  assert.equal(evaluatePrototypeExpression('=$count-1', ctx), 4);
  assert.equal(evaluatePrototypeExpression('=var.count-2', ctx), 3);
  assert.equal(evaluatePrototypeExpression('=count-3', ctx), 2);
  assert.equal(evaluatePrototypeExpression('=$my-var-3', ctx), 7);
  assert.equal(evaluatePrototypeExpression('=10-$delta', ctx), 13);
  assert.equal(evaluatePrototypeExpression('=number(@my-input) + item.price - dataset.orders.count', ctx), 54);
  assert.equal(evaluatePrototypeExpression('=$count > 3 ? trim($label) : "no"', ctx), 'Hello World');
  assert.equal(evaluatePrototypeExpression('=max(1, min(10, abs($delta) * 2))', ctx), 6);
  assert.equal(evaluatePrototypeExpression('=replace(lower(trim($label)), "world", "axure")', ctx), 'hello axure');

  // Host globals / arbitrary JS execution must NOT evaluate
  assert.equal(evaluatePrototypeExpression('=globalThis', ctx), '=globalThis');
  assert.equal(evaluatePrototypeExpression('=process', ctx), '=process');
  assert.equal(evaluatePrototypeExpression('=constructor', ctx), '=constructor');

  // setVariable guards NaN / Infinity and allows null-initialized variables
  const runtime = {
    currentPageId: 'home',
    variables: { score: 0, nullableVar: null },
    visibility: {},
    textOverrides: {},
    textFormulas: {},
    panelStates: {},
    evaluateExpression: expr => evaluatePrototypeExpression(expr, {
      variables: runtime.variables,
      getWidgetText: () => '',
      resolveDatasetPath: () => '',
    }),
    navigate: () => {},
    targetKey: id => id,
    findNodeInPage: () => null,
  };
  assert.throws(
    () => executePrototypeInteraction(
      runtime,
      { type: 'set-variable', name: 'score', value: '=0/0' },
      [],
      { declaredVariables: { score: 0, nullableVar: null } }
    ),
    err => err?.code === 'E_TYPE'
  );
  const executed = [];
  executePrototypeInteraction(
    runtime,
    { type: 'set-variable', name: 'nullableVar', value: '="assigned"' },
    executed,
    { declaredVariables: { score: 0, nullableVar: null } }
  );
  assert.equal(runtime.variables.nullableVar, 'assigned');
});

test('commands/runtime unwraps variable descriptors and sorts numeric dataset columns numerically', () => {
  const doc = {
    variables: {
      tab: { type: 'string', value: 'overview' },
      legacyVar: { default: 'ready' },
      plain: 3,
    },
    datasets: {
      metrics: {
        rows: [
          { id: 'r1', score: 10 },
          { id: 'r2', score: 2 },
          { id: 'r3', score: 100 },
        ],
      },
    },
    pages: [{
      id: 'home',
      root: {
        id: 'root',
        type: 'box',
        children: [{
          id: 'btn',
          type: 'button',
          on: {
            click: {
              cases: [{
                condition: { variable: 'tab', equals: 'overview' },
                actions: [{ type: 'set-variable', variable: 'tab', value: 'detail' }],
              }],
            },
          },
        }],
      },
    }],
  };
  const state = createRuntimeState(doc);
  assert.equal(state.variables.tab, 'overview');
  assert.equal(state.variables.legacyVar, 'ready');
  applyRuntimeStep(doc, state, { action: 'click', nodeId: 'btn' });
  assert.equal(state.variables.tab, 'detail');

  applyRuntimeStep(doc, state, { action: 'dataset-sort', dataset: 'metrics', field: 'score', direction: 'asc' });
  assert.deepEqual(state.datasets.metrics.visibleRows.map(r => r.score), [2, 10, 100]);
});

test('code export handles nested dynamic panels in inactive states, CSS url() assets, and comment sanitization', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-deep-code-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const projectDir = join(dir, 'project');
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  writeFileSync(join(projectDir, 'assets', 'nested-icon.png'), TINY_PNG);
  writeFileSync(join(projectDir, 'assets', 'bg-tile.png'), TINY_PNG);

  const doc = normalizeStudioDocument({
    documentId: 'doc_inject */ body{display:none}',
    domain: 'web',
    adaptiveViews: [{ id: 'sm', name: 'Mobile */ body{opacity:0}', width: 480 }],
    pages: [{
      id: 'home',
      name: 'Home',
      root: {
        id: 'root',
        type: 'box',
        w: 600,
        h: 400,
        fills: ['url("assets/bg-tile.png")'],
        children: [
          {
            id: 'go_s2',
            type: 'button',
            text: 'Open S2',
            x: 20,
            y: 20,
            w: 120,
            h: 36,
            on: { click: [{ type: 'set-panel-state', target: 'outer', state: 's2' }] },
          },
          {
            id: 'outer',
            type: 'dynamic-panel',
            x: 20,
            y: 80,
            w: 400,
            h: 260,
            activeState: 's1',
            states: [
              {
                id: 's1',
                root: {
                  id: 's1_root',
                  type: 'box',
                  w: 400,
                  h: 260,
                  children: [{ id: 's1_lbl', type: 'label', text: 'Outer S1', x: 10, y: 10, w: 160, h: 28 }],
                },
              },
              {
                id: 's2',
                root: {
                  id: 's2_root',
                  type: 'box',
                  w: 400,
                  h: 260,
                  children: [
                    { id: 'inactive_img', type: 'image', src: 'assets/nested-icon.png', x: 10, y: 10, w: 32, h: 32 },
                    {
                      id: 'go_inner_b',
                      type: 'button',
                      text: 'Inner B',
                      x: 60,
                      y: 10,
                      w: 100,
                      h: 32,
                      on: { click: [{ type: 'set-panel-state', target: 'inner', state: 'b' }] },
                    },
                    {
                      id: 'inner',
                      type: 'dynamic-panel',
                      x: 10,
                      y: 60,
                      w: 320,
                      h: 160,
                      activeState: 'a',
                      states: [
                        {
                          id: 'a',
                          root: {
                            id: 'inner_a_root',
                            type: 'box',
                            w: 320,
                            h: 160,
                            children: [{ id: 'leaf_a', type: 'label', text: 'Leaf A', x: 8, y: 8, w: 120, h: 24 }],
                          },
                        },
                        {
                          id: 'b',
                          root: {
                            id: 'inner_b_root',
                            type: 'box',
                            w: 320,
                            h: 160,
                            children: [{ id: 'leaf_b', type: 'label', text: 'Leaf B', x: 8, y: 8, w: 120, h: 24 }],
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    }],
  });

  const outDir = join(dir, 'exported');
  const exported = await exportStudioDocumentToCode(doc, { projectDir, outDir, registerExport: false });
  assert.equal(exported.ok, true);
  assert.equal(exported.manifest.assets.length, 2, 'Both inactive panel image and CSS fill url() must be copied');

  const stylesCss = readFileSync(join(outDir, 'styles.css'), 'utf8');
  assert.doesNotMatch(stylesCss, /\*\/\s*body\{/);

  const indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
  assert.match(indexHtml, /background-image:url\(&quot;assets\/\d+_bg-tile\.png&quot;\)/);

  // Execute standalone app.js in an isolated DOM stub to verify nested dynamic panel switching
  const appJs = readFileSync(join(outDir, 'app.js'), 'utf8');
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    structuredClone,
  };
  vm.runInNewContext(appJs, sandbox);
  const app = sandbox.window.__STUDIO_EXPORT_APP__;
  assert.ok(app, 'Standalone ExportRuntimeApp should mount on window');
  assert.equal(app.isNodeVisible('s1_lbl'), true);
  assert.equal(app.isNodeVisible('leaf_a'), false);
  app.click('go_s2');
  assert.equal(app.isNodeVisible('leaf_a'), true);
  assert.equal(app.isNodeVisible('leaf_b'), false);
  app.click('go_inner_b');
  assert.equal(app.isNodeVisible('leaf_a'), false);
  assert.equal(app.isNodeVisible('leaf_b'), true);

  // StudioRuntimeSession parity on the same nested panel flow
  const session = new StudioRuntimeSession(doc, { projectDir });
  const sim = session.runScenario([
    { action: 'click', target: 'go_s2', expect: { visible: { leaf_a: true, leaf_b: false } } },
    { action: 'click', target: 'go_inner_b', expect: { visible: { leaf_a: false, leaf_b: true } } },
  ]);
  assert.equal(sim.ok, true, JSON.stringify(sim));
});

test('RP9 export preserves multi-run RichText spans natively and propagates hidden/rotation on CSS-painted widgets', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-deep-rp-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const doc = normalizeStudioDocument({
    domain: 'web',
    pages: [
      {
        id: 'home',
        name: 'Home',
        root: {
          id: 'root',
          type: 'box',
          w: 640,
          h: 420,
          children: [
            {
              id: 'rich_headline',
              type: 'paragraph',
              x: 24,
              y: 24,
              w: 420,
              h: 72,
              fontFamily: 'PingFang SC',
              fontSize: 16,
              color: '#1E293B',
              spans: [
                { text: 'Primary ', color: '#2563EB', fontWeight: 700 },
                { text: 'italic\nSecond line ', italic: true, underline: true },
                { text: 'Details', color: '#DC2626', link: { page: 'Detail' } },
              ],
            },
            {
              id: 'hidden_grad_btn',
              type: 'button',
              text: 'Secret CTA',
              x: 24,
              y: 140,
              w: 160,
              h: 44,
              visible: false,
              rotation: -15,
              gradient: { angle: 90, stops: ['#2563EB', '#7C3AED'] },
            },
          ],
        },
      },
      {
        id: 'detail',
        name: 'Detail',
        root: {
          id: 'detail_root',
          type: 'box',
          w: 640,
          h: 420,
          children: [{ id: 'detail_lbl', type: 'label', text: 'Detail Page', x: 24, y: 24, w: 200, h: 32 }],
        },
      },
    ],
  });

  const outRpPath = join(dir, 'rich-and-decorated.rp');
  const res = await exportStudioDocumentToRp(doc, { projectDir: dir, outRpPath });
  assert.equal(res.ok, true);
  assert.equal(res.report.summary.threeZerosPassed, true, JSON.stringify(res.report.summary));
  assert.equal(res.report.compatibilityCounts.unsupported, 0, JSON.stringify(res.report.entries));
  assert.equal(res.report.richTextAlignment.totalSpanNodes, 1);
  assert.equal(res.report.richTextAlignment.allSpansPreserved, true);
  assert.equal(res.report.richTextAlignment.items[0].paragraphs, 2);
  assert.equal(res.report.richTextAlignment.items[0].links, 1);

  // Verify binary RichTextBlock has 2 paragraphs, weighted/colored/italic runs, and AxHyperlink
  const spanItem = res.report.richTextAlignment.items[0];
  const rec = readRecords(readFileSync(outRpPath)).find(r => r.index === spanItem.record);
  const graph = parsePayload(rec);
  const widget = graph.objects.get(spanItem.widgetId);
  let block = field(widget.body, 'RichTextBlock');
  if (block?.tag === 3) block = graph.objects.get(block.value)?.body;
  const paragraphs = field(field(block, 'attributed-string'), 'Paragraphs').items;
  assert.equal(paragraphs.length, 2);
  const p0Inlines = field(paragraphs[0], 'Inlines').items;
  assert.equal(p0Inlines.length, 2);
  assert.equal(field(p0Inlines[0], 'Weight').value, 700);
  assert.equal(field(p0Inlines[0], 'Color').value, 0xff2563eb);
  assert.equal(field(p0Inlines[1], 'Style').value, 1);
  assert.equal(field(p0Inlines[1], 'Underline').value, true);
  const p1Inlines = field(paragraphs[1], 'Inlines').items;
  assert.equal(field(p1Inlines[1], 'Type').text, 'Axure:AttributedString:AxHyperlink');

  // Verify hidden_grad_btn exported spec propagated visible:false and rotation:-15 to __css_paint
  const exportedSpec = JSON.parse(readFileSync(res.sourcePath, 'utf8'));
  const cssLayer = exportedSpec.pages[0].root.children.find(c => c.id === 'hidden_grad_btn__css_layer');
  assert.ok(cssLayer, 'Expected __css_layer wrapper for decorated button');
  assert.equal(cssLayer.visible, false);
  const paintImg = cssLayer.children.find(c => c.id === 'hidden_grad_btn__css_paint');
  assert.equal(paintImg.visible, false);
  assert.equal(paintImg.rotation, -15);

  const rpSummary = readRp(readFileSync(outRpPath), { path: outRpPath });
  assert.equal(rpSummary.records.unparseable, 0);
  assert.equal(rpSummary.counts.danglingRefs, 0);
  assert.equal(rpSummary.problems.length, 0);
});
