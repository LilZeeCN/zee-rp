import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';

import { importToStudioDocument as normalizeDocument, computeContentHash } from '../studio/document.mjs';
import { exportStudioDocumentToCode } from '../studio/export-code.mjs';
import { StudioPersistence } from '../studio/persistence.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { studioHandlers } from '../studio/mcp-adapter.mjs';
import { launchChrome } from '../studio/cdp.mjs';
import { createDomainProjectDocument } from '../studio/scenarios.mjs';
import { referencePackRoot } from '../studio/reference-packs.mjs';

function serveStaticDir(rootDir) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  const srv = http.createServer((req, res) => {
    const cleanUrl = (req.url || '/').split('?')[0];
    const rel = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
    const filePath = path.join(rootDir, rel);
    if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        server: srv,
        close: () => new Promise(resolveClose => {
          srv.close(resolveClose);
          // A browser can leave preconnected sockets open without sending a request.
          srv.closeAllConnections();
        }),
      });
    });
  });
}

test('export test server closes even if a browser preconnect has not sent a request', { timeout: 3000 }, async t => {
  const fixture = await serveStaticDir(os.tmpdir());
  const accepted = once(fixture.server, 'connection', { signal: t.signal });
  const client = connect(fixture.server.address().port, '127.0.0.1');
  t.after(() => {
    client.destroy();
    if (fixture.server.listening) return fixture.close();
  });
  await Promise.all([accepted, once(client, 'connect', { signal: t.signal })]);
  await fixture.close();
});

test('G01-1: 8 applicable tasks (5 reference packs + 3 domain presets) export to standalone HTML/CSS/JS, relocate to a new directory, and pass browser scenarios', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-g01-tasks-'));
  let managed = null;
  try {
    managed = await launchChrome();
    const packIds = [
      'deep-recall-mobile',
      'daily-margin-mobile',
      'field-ledger-web',
      'materials-desk-web',
      'shore-notes-web',
    ];

    for (const packId of packIds) {
      const packDir = path.join(referencePackRoot, packId);
      const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
      const rawSource = JSON.parse(fs.readFileSync(path.join(packDir, manifest.source), 'utf8'));
      const doc = normalizeDocument(rawSource);

      const stageOut = path.join(tmpRoot, 'stage', packId);
      const relocatedDir = path.join(tmpRoot, 'relocated', packId);

      const exp = await exportStudioDocumentToCode(doc, {
        projectDir: packDir,
        outDir: stageOut,
        registerExport: false,
      });
      assert.equal(exp.ok, true);
      assert.equal(exp.manifest.documentId, doc.documentId);
      assert.equal(exp.manifest.revision, doc.revision);
      assert.equal(exp.manifest.contentHash, doc.contentHash);
      assert.equal(exp.manifest.layoutMode.responsiveFabricated, false);
      assert.equal(exp.manifest.interactionCompatibility.fakeButtonsEmitted, 0);

      // Move exported bundle to a brand-new directory and delete the staging directory
      fs.mkdirSync(path.dirname(relocatedDir), { recursive: true });
      fs.cpSync(stageOut, relocatedDir, { recursive: true });
      fs.rmSync(stageOut, { recursive: true, force: true });

      const staticSrv = await serveStaticDir(relocatedDir);
      let cdp = null;
      try {
        cdp = await managed.openPage(`${staticSrv.url}/index.html`);
        const ready = await cdp.evaluate(`Boolean(window.__STUDIO_EXPORT_APP__ && document.getElementById('studio-export-board'))`);
        assert.equal(ready, true, `Exported app failed to boot for ${packId}`);

        // Run all scenarios defined in the reference pack manifest inside the real browser
        for (const scen of manifest.scenarios || []) {
          const res = await cdp.evaluate(`(() => {
            window.__STUDIO_EXPORT_APP__.reset(${JSON.stringify(scen.startPageId || null)});
            return window.__STUDIO_EXPORT_APP__.runScenario(${JSON.stringify(scen.steps)});
          })()`);
          assert.equal(res.ok, true, `Browser scenario ${packId}/${scen.id} failed: ${JSON.stringify(res)}`);
        }

        // Verify all <img> elements in the relocated bundle loaded cleanly (if any)
        const brokenImages = await cdp.evaluate(`(() => {
          const imgs = [...document.querySelectorAll('#studio-export-board img')];
          return imgs.filter(img => !img.complete || img.naturalWidth === 0).map(img => img.getAttribute('src'));
        })()`);
        assert.deepEqual(brokenImages, [], `Broken images in relocated bundle ${packId}: ${JSON.stringify(brokenImages)}`);
      } finally {
        if (cdp) await cdp.close();
        await staticSrv.close();
      }
    }

    // Also verify the 3 interactive domain presets (birding, study-cards, equipment-loan) with repeater filter/add & navigation
    for (const domainId of ['birding', 'study-cards', 'equipment-loan']) {
      const doc = createDomainProjectDocument({ domainId });
      const relocatedDir = path.join(tmpRoot, 'relocated-domains', domainId);
      const exp = await exportStudioDocumentToCode(doc, {
        outDir: relocatedDir,
        registerExport: false,
      });
      assert.equal(exp.ok, true);

      const staticSrv = await serveStaticDir(relocatedDir);
      let cdp = null;
      try {
        cdp = await managed.openPage(`${staticSrv.url}/index.html`);
        const domainCheck = await cdp.evaluate(`(() => {
          const app = window.__STUDIO_EXPORT_APP__;
          const initialPage = app.currentPageId;
          // Navigate to list page and verify repeater rows rendered in DOM
          app.navigate('list');
          const initialRows = document.querySelectorAll('#studio-export-board [data-repeater-row-id]').length;
          // Add a row via dataset action and verify DOM updates
          const dsRes = app.runScenario([
            {
              action: 'dataset',
              dataset: 'records',
              op: 'add',
              row: { id: 'rec_new', title: '新增验证条目', subtitle: '测试副标题', badge: '新', count: 5 },
              expect: { datasetCount: { records: 4 } },
            },
          ]);
          const afterAddRows = document.querySelectorAll('#studio-export-board [data-repeater-row-id]').length;
          return { initialPage, pageAfterNav: app.currentPageId, initialRows, afterAddRows, dsOk: dsRes.ok };
        })()`);
        assert.equal(domainCheck.pageAfterNav, 'list');
        assert.equal(domainCheck.dsOk, true);
        assert.ok(domainCheck.afterAddRows > domainCheck.initialRows, `Expected repeater DOM rows to grow after dataset add in ${domainId}`);
      } finally {
        if (cdp) await cdp.close();
        await staticSrv.close();
      }
    }
  } finally {
    if (managed) await managed.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('G01-2: vector path SVG export, declared breakpoints vs fixed board, and explicit unsupported interaction listing (no fake buttons)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-g01-compat-'));
  let managed = null;
  try {
    const doc = normalizeDocument({
      name: 'G01 Vector & Compatibility Check',
      adaptiveViews: [
        { id: 'tablet', name: 'Tablet', width: 768, height: 1024 },
      ],
      pages: [
        {
          id: 'home',
          name: '首页',
          root: {
            id: 'root_box',
            type: 'box',
            layout: 'free',
            x: 0,
            y: 0,
            w: 1024,
            h: 768,
            children: [
              {
                id: 'vec_badge',
                type: 'path',
                name: '矢量徽章',
                x: 40,
                y: 40,
                w: 80,
                h: 80,
                d: 'M 0 0 L 80 0 L 80 80 L 0 80 Z M 20 20 L 20 60 L 60 60 L 60 20 Z',
                fill: '#2E6F57',
                fillRule: 'evenodd',
              },
              {
                id: 'valid_btn',
                type: 'button',
                text: '有效按钮',
                x: 40,
                y: 150,
                w: 140,
                h: 44,
                on: {
                  click: [{ type: 'set-text', target: 'status_lbl', text: '已点击有效按钮' }],
                },
              },
              {
                id: 'unsupported_btn',
                type: 'button',
                text: '未支持手势按钮',
                x: 200,
                y: 150,
                w: 160,
                h: 44,
                on: {
                  swipeLeft: [{ type: 'link', to: 'home' }],
                },
              },
              {
                id: 'status_lbl',
                type: 'label',
                text: '初始状态',
                x: 40,
                y: 220,
                w: 240,
                h: 32,
              },
            ],
          },
        },
      ],
    });

    const outDir = path.join(tmpDir, 'bundle');
    const exp = await exportStudioDocumentToCode(doc, { outDir, registerExport: false });
    assert.equal(exp.ok, true);
    assert.equal(exp.manifest.layoutMode.fixedBoard, false);
    assert.equal(exp.manifest.layoutMode.declaredBreakpoints.length, 1);
    assert.equal(exp.manifest.layoutMode.declaredBreakpoints[0].width, 768);
    assert.equal(exp.manifest.interactionCompatibility.supportedCount, 1);
    assert.equal(exp.manifest.interactionCompatibility.unsupportedCount, 1);
    assert.equal(exp.manifest.interactionCompatibility.unsupported[0].nodeId, 'unsupported_btn');
    assert.equal(exp.manifest.interactionCompatibility.unsupported[0].event, 'swipeLeft');

    const cssText = fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8');
    assert.ok(cssText.includes('@media (max-width: 768px)'), 'Expected declared breakpoint in styles.css');

    managed = await launchChrome();
    const staticSrv = await serveStaticDir(outDir);
    let cdp = null;
    try {
      cdp = await managed.openPage(`${staticSrv.url}/index.html`);
      const domCheck = await cdp.evaluate(`(() => {
        const svgPath = document.querySelector('[data-node-id="vec_badge"] svg.export-vector-svg path');
        const validBtn = document.querySelector('[data-node-id="valid_btn"]');
        const unsupBtn = document.querySelector('[data-node-id="unsupported_btn"]');
        validBtn.click();
        const statusText = document.querySelector('[data-node-id="status_lbl"]')?.textContent;
        return {
          hasSvgPath: Boolean(svgPath),
          fillRule: svgPath?.getAttribute('fill-rule'),
          validTag: validBtn?.tagName,
          unsupTag: unsupBtn?.tagName,
          unsupAttr: unsupBtn?.getAttribute('data-unsupported-interaction'),
          unsupAriaDisabled: unsupBtn?.getAttribute('aria-disabled'),
          statusText,
        };
      })()`);
      assert.equal(domCheck.hasSvgPath, true);
      assert.equal(domCheck.fillRule, 'evenodd');
      assert.equal(domCheck.validTag, 'BUTTON');
      assert.equal(domCheck.unsupTag, 'DIV', 'Button with only unsupported interactions must not be emitted as an active <button>');
      assert.ok(domCheck.unsupAttr && domCheck.unsupAttr.includes('swipeLeft'));
      assert.equal(domCheck.unsupAriaDisabled, 'true');
      assert.equal(domCheck.statusText, '已点击有效按钮');
    } finally {
      if (cdp) await cdp.close();
      await staticSrv.close();
    }
  } finally {
    if (managed) await managed.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('G01-3: revision/contentHash binding, stale baseRevision rejection, registration & async operation support', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-g01-ops-'));
  let server = null;
  try {
    const docV1 = normalizeDocument({
      documentId: 'doc_g01_reg',
      name: 'G01 Registration Project',
      revision: 1,
      pages: [
        {
          id: 'home',
          name: '首页',
          root: {
            id: 'root',
            type: 'box',
            layout: 'column',
            w: 402,
            h: 874,
            children: [{ id: 'title', type: 'label', text: '版本一', w: 200, h: 32 }],
          },
        },
      ],
    });
    const persistence = new StudioPersistence(tmpDir);
    persistence.saveFullSnapshot(docV1);
    server = await startStudioServer({ projectDir: tmpDir, port: 0 });

    // 1. Synchronous studio_export_code via MCP handler registers export in .studio/code-exports.json
    const outV1 = path.join(tmpDir, 'out-v1');
    const syncExp = await studioHandlers.studio_export_code({
      port: server.info.port,
      outDir: outV1,
      baseRevision: 1,
    });
    assert.equal(syncExp.ok, true);
    assert.equal(syncExp.revision, 1);
    assert.ok(syncExp.registration?.manifestSha256);

    // 2. Advance project to r2
    await studioHandlers.studio_apply_commands({
      port: server.info.port,
      baseRevision: 1,
      idempotencyKey: 'g01-advance-r2',
      commands: [{ type: 'setText', pageId: 'home', nodeId: 'title', text: '版本二' }],
    });

    // 3. Stale baseRevision (r1 when server is at r2) must reject with E_STALE_REVISION
    const staleMcpRes = await studioHandlers.studio_export_code({
      port: server.info.port,
      outDir: path.join(tmpDir, 'out-stale'),
      baseRevision: 1,
    });
    assert.equal(staleMcpRes.ok, false);
    assert.equal(staleMcpRes.code, 'E_STALE_REVISION');

    await assert.rejects(
      () =>
        exportStudioDocumentToCode(server.studio.store.doc, {
          projectDir: tmpDir,
          outDir: path.join(tmpDir, 'out-stale-direct'),
          baseRevision: 1,
        }),
      { code: 'E_STALE_REVISION' }
    );

    // 4. Export r2; re-exporting the same content reuses the registration row even when registered revisions were higher.
    const outV2 = path.join(tmpDir, 'out-v2');
    const syncExpV2 = await studioHandlers.studio_export_code({
      port: server.info.port,
      outDir: outV2,
      baseRevision: 2,
    });
    assert.equal(syncExpV2.ok, true);
    assert.equal(syncExpV2.revision, 2);
    assert.equal(syncExpV2.registration.reused, false);

    const regPath = path.join(tmpDir, '.studio', 'code-exports.json');
    const registered = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    for (const entry of registered.exports) entry.revision = 500;
    fs.writeFileSync(regPath, JSON.stringify(registered, null, 2) + '\n');

    const reusedExp = await studioHandlers.studio_export_code({
      port: server.info.port,
      outDir: path.join(tmpDir, 'out-v2-reused'),
      baseRevision: 2,
    });
    assert.equal(reusedExp.ok, true);
    assert.equal(reusedExp.registration.reused, true);
    assert.equal(JSON.parse(fs.readFileSync(regPath, 'utf8')).exports.length, registered.exports.length);

    // 4b. The original r1 content re-exported at a lower revision reuses the existing row (revision is not identity).
    const regressedExp = await exportStudioDocumentToCode(docV1, {
      projectDir: tmpDir,
      persistence,
      outDir: path.join(tmpDir, 'out-regress-v1'),
      registerExport: true,
    });
    assert.equal(regressedExp.ok, true);
    assert.equal(regressedExp.registration.reused, true);

    // 4c. Different content at a lower revision is registered as new content with a rollback warning, not rejected.
    const docOlderChanged = structuredClone(docV1);
    docOlderChanged.pages[0].root.children[0].text = '版本一-新内容';
    docOlderChanged.contentHash = computeContentHash(docOlderChanged);
    const changedExp = await exportStudioDocumentToCode(docOlderChanged, {
      projectDir: tmpDir,
      persistence,
      outDir: path.join(tmpDir, 'out-regress-v1-changed'),
      registerExport: true,
    });
    assert.equal(changedExp.ok, true);
    assert.equal(changedExp.registration.reused, false);
    assert.ok(changedExp.warnings?.some(w => w.code === 'W_CODE_EXPORT_REVISION_ROLLBACK'));

    // 5. Async operation via studio_export_code(async: true)
    const asyncOp = await studioHandlers.studio_export_code({
      port: server.info.port,
      async: true,
      requestKey: 'g01-async-export-r2',
      baseRevision: 2,
    });
    assert.ok(asyncOp.id.startsWith('op_'));
    let opState = asyncOp;
    for (let i = 0; i < 40 && !['succeeded', 'failed'].includes(opState.status); i++) {
      await new Promise(r => setTimeout(r, 150));
      opState = await studioHandlers.studio_operations({
        port: server.info.port,
        action: 'get',
        id: asyncOp.id,
      });
    }
    assert.equal(opState.status, 'succeeded', `Async export-code operation failed: ${JSON.stringify(opState)}`);
    assert.ok(opState.resultSummary?.output && fs.existsSync(path.join(opState.resultSummary.output, 'index.html')));
  } finally {
    if (server?.studio) await server.studio.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('G01-4: exported code bundle honors repeater pageSize, rowGap, dataset-page, and dynamic dataset formulas', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-g01-repeater-page-'));
  let managed = null;
  try {
    const { loadBenchmarkFixtures, buildRp1AuthoringPlan } = await import('../benchmarks/studio/task-builders.mjs');
    const { createEmptyStudioDocument } = await import('../studio/document.mjs');
    const { StudioDocumentStore } = await import('../studio/commands.mjs');
    const { prepareRp1Commands } = await import('../studio/rp1-authoring.mjs');
    const fixtures = loadBenchmarkFixtures();
    const t06Task = fixtures.suite.tasks.find(t => t.id === 'T06');
    const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
    const plan = buildRp1AuthoringPlan('T06', fixtures);
    if (plan.setupCommands.length) assert.equal(store.applyTransaction({ commands: plan.setupCommands }).ok, true);
    for (const env of plan.rp1Envelopes) {
      const prep = prepareRp1Commands({ doc: store.doc, source: env.rp1, mode: env.sourceMode, pageId: env.pageId });
      assert.equal(store.applyTransaction({ commands: prep.commands }).ok, true);
    }
    const doc = store.doc;
    const outDir = path.join(tmpDir, 't06-code-bundle');
    const exp = await exportStudioDocumentToCode(doc, { outDir, registerExport: false });
    assert.equal(exp.ok, true);

    managed = await launchChrome();
    const staticSrv = await serveStaticDir(outDir);
    let cdp = null;
    try {
      cdp = await managed.openPage(`${staticSrv.url}/index.html`);
      const check = await cdp.evaluate(`(() => {
        const app = window.__STUDIO_EXPORT_APP__;
        const initialRows = [...document.querySelectorAll('#studio-export-board [data-template-node-id="list-tpl"]')];
        const rowTops = initialRows.map(el => el.getBoundingClientRect().top);
        const s1 = app.runScenario(${JSON.stringify(t06Task.scenarios[0].steps)});
        app.reset('home');
        const s2 = app.runScenario(${JSON.stringify(t06Task.scenarios[1].steps)});
        return {
          initialRowCount: initialRows.length,
          rowTops,
          s1,
          s2,
        };
      })()`);
      assert.equal(check.initialRowCount, 5, 'Expected page 1 of T06 repeater to render exactly 5 rows (pageSize=5)');
      for (let i = 1; i < check.rowTops.length; i++) {
        assert.ok(check.rowTops[i] >= check.rowTops[i - 1] + 48, `Expected repeater rows not to overlap: ${JSON.stringify(check.rowTops)}`);
      }
      assert.equal(check.s1.ok, true, `T06 pagination-filter scenario failed in exported code: ${JSON.stringify(check.s1)}`);
      assert.equal(check.s2.ok, true, `T06 zero-one-many scenario failed in exported code: ${JSON.stringify(check.s2)}`);
    } finally {
      if (cdp) await cdp.close();
      await staticSrv.close();
    }
  } finally {
    if (managed) await managed.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('layered paint and inline styles reach Studio and the standalone export', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-layered-paint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const doc = normalizeDocument({ domain: 'web', pages: [{ id: 'home', root: {
    id: 'root', type: 'box', w: 400, h: 250, children: [
      { id: 'paint', type: 'box', x: 10, y: 10, w: 140, h: 100,
        fills: ['linear-gradient(90deg, transparent, #FFFFFF)', '#123456'],
        shadows: ['1px 2px 3px #000000', 'inset 0 0 2px #000000'], mixBlendMode: 'multiply' },
      { id: 'words', type: 'label', x: 20, y: 150, w: 280, h: 40,
        spans: [{ text: 'Layered ', color: '#123456' }, { text: 'paint', italic: true }] },
    ],
  } }] });
  const source = path.join(dir, 'source.json');
  fs.writeFileSync(source, JSON.stringify(doc));
  const { studio } = await startStudioServer({ projectDir: path.join(dir, 'project'), sourcePath: source, port: 0 });
  const staticDir = path.join(dir, 'export');
  let exported;
  let offlinePage;
  try {
    const design = await studio.ensureManagedBrowserPage();
    await exportStudioDocumentToCode(doc, { outDir: staticDir, registerExport: false });
    const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
    assert.match(html, /mix-blend-mode:multiply/);
    assert.match(html, /<span style="color:#123456">Layered <\/span>/);
    exported = await serveStaticDir(staticDir);
    offlinePage = await studio.managedChrome.openPage(exported.url);
    await offlinePage.waitForFunction('Boolean(window.__STUDIO_EXPORT_APP__)');
    const probe = `(() => {
      const style = getComputedStyle(document.querySelector('[data-node-id="paint"]'));
      const spans = [...document.querySelectorAll('[data-node-id="words"] span')];
      return { background: style.backgroundImage, shadow: style.boxShadow, blend: style.mixBlendMode,
        spans: spans.map(el => [el.textContent, getComputedStyle(el).color, getComputedStyle(el).fontStyle]) };
    })()`;
    const browser = await design.evaluate(probe);
    const offline = await offlinePage.evaluate(probe);
    for (const actual of [browser, offline]) {
      assert.match(actual.background, /linear-gradient\(rgb\(18, 52, 86\), rgb\(18, 52, 86\)\)/);
      assert.match(actual.shadow, /inset/);
      assert.equal(actual.blend, 'multiply');
      assert.deepEqual(actual.spans[0].slice(0, 2), ['Layered ', 'rgb(18, 52, 86)']);
      assert.deepEqual([actual.spans[1][0], actual.spans[1][2]], ['paint', 'italic']);
    }
  } finally {
    await offlinePage?.close();
    await exported?.close();
    await studio.close();
  }
});
