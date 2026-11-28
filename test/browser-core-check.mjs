import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { indexLibrary } from '../scripts/index-library.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import {
  buildLibraryBytes,
  diffRpBytes,
  downgradeRpBytes,
  inflateRawWithEnd,
  inspectRpBytes,
  repairRpBytes,
  sha256Hex,
} from '../scripts/rp-browser-core.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { setWidgetText } from '../scripts/set-widget-text.mjs';
import { lintVersionKeys } from '../scripts/version-lint.mjs';
import { findChromeExecutable, launchChrome } from '../studio/cdp.mjs';
import { syncInspectorHtml } from '../tools/sync-inspector.mjs';

const corePath = fileURLToPath(new URL('../scripts/rp-browser-core.mjs', import.meta.url));
const inspectorPath = fileURLToPath(new URL('../tools/rp-inspector/index.html', import.meta.url));
const TRAINING_RP11 = '/Applications/Axure RP 11.app/Contents/Resources/DefaultSettings/Training/Prototyping Basics.rp';

test('rp-browser-core: 零 node:* 依赖，嵌入页面逐字同步，SHA-256 与同构解析/修复/降级/元件库一致', async () => {
  const coreText = readFileSync(corePath, 'utf8');
  const codeOnly = coreText.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /from\s+['"]node:|require\s*\(\s*['"]node:/);
  assert.doesNotMatch(codeOnly, /\bBuffer\b/);
  assert.equal(syncInspectorHtml({ check: true }).synced, true);
  const htmlText = readFileSync(inspectorPath, 'utf8');
  const embedded = htmlText.match(/<script id="rp-worker-core" type="text\/plain">\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.equal(embedded, coreText.trimEnd(), 'tools/rp-inspector/index.html 嵌入的核心必须与 scripts/rp-browser-core.mjs 一致');

  assert.equal(sha256Hex('zee-rp'), createHash('sha256').update('zee-rp').digest('hex'));

  const samples = [
    { label: 'RP9 blank', buf: synthesizeBlankProject({ version: 9 }) },
    { label: 'RP11 blank', buf: synthesizeBlankProject({ version: 11 }) },
  ];
  const ex9 = '/Users/lilzee/axure-exp/outputs/dimensional-strike-20261127/review-remediation/exercise2-iphone-shell-repaired.rp';
  if (existsSync(ex9)) samples.push({ label: '9-page 689-widget', buf: readFileSync(ex9) });

  for (const { label, buf } of samples) {
    const nodeRp = readRp(buf);
    const browserRp = await inspectRpBytes(new Uint8Array(buf), { path: label });
    assert.equal(browserRp.version, nodeRp.version, label);
    assert.deepEqual(browserRp.pages.map(p => p.name), nodeRp.pages.map(p => p.name), label);
    assert.deepEqual(browserRp.pages.map(p => p.widgets.length), nodeRp.pages.map(p => p.widgets.length), label);
    for (let i = 0; i < nodeRp.pages.length; i++) {
      const nw = nodeRp.pages[i].widgets.map(w => ({ name: w.name, className: w.className, w: w.w, h: w.h, text: w.text }));
      const bw = browserRp.pages[i].widgets.map(w => ({ name: w.name, className: w.className, w: w.w, h: w.h, text: w.text }));
      assert.deepEqual(bw, nw, `${label} page ${i}`);
    }
  }

  // Node-isomorphic sanity for repair/downgrade/buildLibrary
  const dg11 = await downgradeRpBytes(new Uint8Array(synthesizeBlankProject({ version: 11 })), { stripUnsupported: true });
  assert.equal(dg11.report.ok, true);
  assert.equal(dg11.report.targetVersion, 9);
  const corrupt = new Uint8Array(dg11.bytes);
  corrupt.fill(0, 8, 28);
  const rep = await repairRpBytes(corrupt);
  assert.equal(rep.report.ok, true);
  const lib = await buildLibraryBytes(dg11.bytes, { version: 9 });
  assert.equal(lib.report.ok, true);
  assert.equal(lib.report.format, 'RP9 .rplib');
  assert.equal(typeof inflateRawWithEnd, 'function');
});

test('rp-inspector: 无头 Chrome file:// 0 网络请求，全能 Worker 透视/对比/抢救/降级/元件库通过原生 compile 校验', { timeout: 120_000 }, async t => {
  try { findChromeExecutable(); } catch { return t.skip('未检测到 Chrome/Chromium'); }
  const work = mkdtempSync(join(tmpdir(), 'zee-browser-core-'));
  let chrome = null;
  let page = null;
  try {
    const blank = synthesizeBlankProject({ version: 9 });
    const gen = generatePrototype({ recipe: 'mobile-cards', output: join(work, 'cards.rp'), cwd: work });
    assert.equal(gen.status, 'completed');
    const cardsBytes = readFileSync(gen.output);
    const cardsModPath = join(work, 'cards-v2.rp');
    const firstNamed = readRp(cardsBytes).pages[0].widgets.find(w => w.name && w.text);
    setWidgetText(gen.output, cardsModPath, gen.pages[0].name, firstNamed.name, 'Browser Diff Text');
    const cardsModBytes = readFileSync(cardsModPath);

    const corruptCards = Buffer.from(cardsBytes);
    corruptCards.fill(0, 12, 64); // wreck LZ4 manifest header
    const mid = Math.floor(corruptCards.length * 0.55);
    corruptCards.fill(0, mid, Math.min(corruptCards.length, mid + 1024)); // wipe mid-stream record

    const rp11Source = existsSync(TRAINING_RP11) ? readFileSync(TRAINING_RP11) : synthesizeBlankProject({ version: 11, pageName: 'RP11 Browser Src' });

    chrome = await launchChrome({ headless: true, width: 1280, height: 800, dpr: 1 });
    page = await chrome.openPage('about:blank');
    await page.send('Network.enable');
    const networkRequests = [];
    page.on('Network.requestWillBeSent', params => networkRequests.push(params.request?.url || ''));

    await page.navigate(pathToFileURL(inspectorPath).href);

    const remoteHttpRequests = networkRequests.filter(u => /^https?:/i.test(u));
    assert.deepEqual(remoteHttpRequests, [], `禁止外部网络请求: ${remoteHttpRequests.join(', ')}`);

    const blankRes = await page.evaluate(`window.__RP_INSPECTOR__.inspectBase64(${JSON.stringify(blank.toString('base64'))}, "blank.rp")`);
    assert.deepEqual(blankRes.report.pages.map(p => p.name), ['Page 1']);

    const diffRes = await page.evaluate(`window.__RP_INSPECTOR__.diffBase64(${JSON.stringify(cardsBytes.toString('base64'))}, ${JSON.stringify(cardsModBytes.toString('base64'))})`);
    const nodeDiff = await diffRpBytes(new Uint8Array(cardsBytes), new Uint8Array(cardsModBytes));
    assert.equal(diffRes.diff.totalChanges, nodeDiff.totalChanges);
    assert.equal(diffRes.diff.totalChanges, 1);

    // 1. Browser Worker Repair
    const repairRes = await page.evaluate(`window.__RP_INSPECTOR__.repairBase64(${JSON.stringify(corruptCards.toString('base64'))})`);
    assert.equal(repairRes.report.ok, true);
    assert.ok(repairRes.report.salvaged.pages >= 1);
    const repairedPath = join(work, 'browser-repaired.rp');
    writeFileSync(repairedPath, Buffer.from(repairRes.base64, 'base64'));
    const ncRep = await nativeCheck(repairedPath, { version: 9, compile: true });
    if (ncRep.status !== 'unavailable') {
      assert.equal(ncRep.status, 'accepted', `Browser repair rejected: ${JSON.stringify(ncRep.error)}`);
      assert.equal(ncRep.officialCompile?.status, 'accepted');
    }

    // 2. Browser Worker Downgrade (RP11 -> RP9)
    const dgRes = await page.evaluate(`window.__RP_INSPECTOR__.downgradeBase64(${JSON.stringify(rp11Source.toString('base64'))}, { stripUnsupported: true })`);
    assert.equal(dgRes.report.ok, true);
    assert.equal(dgRes.report.targetVersion, 9);
    assert.equal(dgRes.report.editorReadiness.upgradeModalRisk, false);
    const dgBuf = Buffer.from(dgRes.base64, 'base64');
    assert.equal(lintVersionKeys(dgBuf, { version: 9 }).errors.length, 0);
    const dgPath = join(work, 'browser-downgraded.rp');
    writeFileSync(dgPath, dgBuf);
    const ncDg = await nativeCheck(dgPath, { version: 9, compile: true });
    if (ncDg.status !== 'unavailable') {
      assert.equal(ncDg.status, 'accepted', `Browser downgrade rejected: ${JSON.stringify(ncDg.error)}`);
      assert.equal(ncDg.officialCompile?.status, 'accepted');
    }

    // 3. Browser Worker Build Library (.rplib)
    const libRes = await page.evaluate(`window.__RP_INSPECTOR__.buildLibraryBase64(${JSON.stringify(cardsBytes.toString('base64'))}, { version: 9 })`);
    assert.equal(libRes.report.ok, true);
    assert.equal(libRes.report.format, 'RP9 .rplib');
    const libPath = join(work, 'browser-built.rplib');
    writeFileSync(libPath, Buffer.from(libRes.base64, 'base64'));
    const idx = indexLibrary(libPath, { limit: 10000 });
    assert.ok(idx.counts.pages >= 1);
    const ncLib = await nativeCheck(libPath, { version: 9, compile: true });
    if (ncLib.status !== 'unavailable') {
      assert.equal(ncLib.status, 'accepted', `Browser rplib rejected: ${JSON.stringify(ncLib.error)}`);
    }

    assert.deepEqual(networkRequests.filter(u => /^https?:/i.test(u)), []);
  } finally {
    await page?.close?.();
    await chrome?.close?.();
    rmSync(work, { recursive: true, force: true });
  }
});
