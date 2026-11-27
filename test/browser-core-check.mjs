import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { diffRpBytes, inspectRpBytes, sha256Hex } from '../scripts/rp-browser-core.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { setWidgetText } from '../scripts/set-widget-text.mjs';
import { findChromeExecutable, launchChrome } from '../studio/cdp.mjs';

const corePath = fileURLToPath(new URL('../scripts/rp-browser-core.mjs', import.meta.url));
const inspectorPath = fileURLToPath(new URL('../tools/rp-inspector/index.html', import.meta.url));

test('rp-browser-core: 零 node:* 依赖，嵌入页面逐字同步，SHA-256 与同构解析等价', async () => {
  const coreText = readFileSync(corePath, 'utf8');
  const codeOnly = coreText.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /from\s+['"]node:|require\s*\(\s*['"]node:/);
  assert.doesNotMatch(codeOnly, /\bBuffer\b/);
  const htmlText = readFileSync(inspectorPath, 'utf8');
  const embedded = htmlText.match(/<script id="rp-worker-core" type="text\/plain">\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.equal(embedded, coreText, 'tools/rp-inspector/index.html 嵌入的核心必须与 scripts/rp-browser-core.mjs 一致');

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
});

test('rp-inspector: 无头 Chrome file:// 0 网络请求、Web Worker 解析及 Diff 逐项一致', { timeout: 60_000 }, async t => {
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

    const ex9 = '/Users/lilzee/axure-exp/outputs/dimensional-strike-20261127/review-remediation/exercise2-iphone-shell-repaired.rp';
    const bigBytes = existsSync(ex9) ? readFileSync(ex9) : cardsBytes;

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
    assert.ok(blankRes.elapsedMs < 2000, `Blank parse too slow: ${blankRes.elapsedMs}`);

    const bigRes = await page.evaluate(`window.__RP_INSPECTOR__.inspectBase64(${JSON.stringify(bigBytes.toString('base64'))}, "big.rp")`);
    const nodeBig = readRp(bigBytes);
    assert.deepEqual(bigRes.report.pages.map(p => p.name), nodeBig.pages.map(p => p.name));
    assert.deepEqual(bigRes.report.pages.map(p => p.widgets.length), nodeBig.pages.map(p => p.widgets.length));
    assert.ok(bigRes.elapsedMs < 5000, `Large parse too slow: ${bigRes.elapsedMs}`);

    const diffRes = await page.evaluate(`window.__RP_INSPECTOR__.diffBase64(${JSON.stringify(cardsBytes.toString('base64'))}, ${JSON.stringify(cardsModBytes.toString('base64'))})`);
    const nodeDiff = await diffRpBytes(new Uint8Array(cardsBytes), new Uint8Array(cardsModBytes));
    assert.equal(diffRes.diff.totalChanges, nodeDiff.totalChanges);
    assert.equal(diffRes.diff.totalChanges, 1);
  } finally {
    await page?.close?.();
    await chrome?.close?.();
    rmSync(work, { recursive: true, force: true });
  }
});
