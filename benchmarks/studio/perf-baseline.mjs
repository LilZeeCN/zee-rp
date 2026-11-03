import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { makePerfFixture, countSourceNodes, PERF_CATEGORIES } from './perf-fixtures.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const canonical = resolve(dirname(scriptPath), '../..');
const flags = Object.fromEntries(process.argv.slice(2).map(value => {
  const at = value.indexOf('='); return at < 0 ? [value.replace(/^--/, ''), true] : [value.slice(2, at), value.slice(at + 1)];
}));
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const elapsed = start => performance.now() - start;

export function summarize(values) {
  if (!values.length) return { status: 'not_run', samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { status: 'measured', samples: values.length, p50: percentile(0.5), p95: percentile(0.95), min: sorted[0], max: sorted.at(-1), unit: 'ms' };
}

function fileManifest(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path: relative(root, path), sha256: sha(readFileSync(path)) });
    }
  }
  walk(root); return files;
}

function freezeRuntime(runtime, studioSource) {
  if (existsSync(runtime)) return;
  mkdirSync(runtime, { recursive: true });
  for (const dir of ['scripts', 'assets', 'examples', 'bin', 'tools', 'references']) cpSync(join(canonical, dir), join(runtime, dir), { recursive: true });
  cpSync(studioSource, join(runtime, 'studio'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(canonical, file), join(runtime, file));
  symlinkSync(join(canonical, 'node_modules'), join(runtime, 'node_modules'), 'dir');
}

async function browserMeasurements({ studio, launchChrome, result, samples, cellDir }) {
  let chrome, page;
  try {
    chrome = await launchChrome({ headless: true, width: 1440, height: 900, dpr: 1 });
    result.browser = { status: 'running', pid: chrome.proc.pid, viewport: { width: 1440, height: 900, dpr: 1 }, rawEdits: [], rawFrames: {} };
    page = await chrome.openPage();
    result.browser.version = await page.send('Browser.getVersion');
    await page.send('Performance.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__PERF_LONG_TASKS__=[];try{new PerformanceObserver(list=>window.__PERF_LONG_TASKS__.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true})}catch{}` });
    const start = performance.now();
    await page.navigate(studio.url, 120000);
    await page.waitForFunction(`window.__STUDIO_APP__?.state.renderedRevision === ${studio.store.appliedRevision} && window.__STUDIO_RENDERED_HASH__ === ${JSON.stringify(studio.store.doc.contentHash)}`, { timeoutMs: 120000 });
    result.browser.navigationToRenderMarkerMs = elapsed(start);
    await page.evaluate(`(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode?.().catch(()=>{})||Promise.resolve()));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`, { timeoutMs: 120000 });
    const initial = await page.screenshot();
    result.browser.navigationToScreenshotBarrierMs = elapsed(start);
    writeFileSync(join(cellDir, 'browser-initial.png'), initial);
    await page.evaluate(`window.__STUDIO_APP__.setPanZoom(20,20,1)`);
    await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    const clip = await page.evaluate(`(()=>{const el=document.querySelector('[data-node-id="probe"]');const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    if (clip.x < 0 || clip.y < 0 || clip.x + clip.w > 1440 || clip.y + clip.h > 900) throw new Error(`Probe outside viewport: ${JSON.stringify(clip)}`);
    result.browser.probeClip = clip;
    for (let i = 0; i < samples; i++) {
      const text = `Performance probe ${String(i + 1).padStart(3, '0')}`;
      const body = { documentId: studio.store.doc.documentId, baseRevision: studio.store.appliedRevision, idempotencyKey: `browser-${i}`, pageId: 'p0', commands: [{ type: 'setText', pageId: 'p0', nodeId: 'probe', text }] };
      const t = performance.now();
      const observed = await page.evaluate(`(async()=>{
        const start=performance.now();
        const response=await fetch('/api/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
        const result=await response.json();if(!result.ok)throw new Error(JSON.stringify(result));
        const responseMs=performance.now()-start;
        const deadline=performance.now()+120000;
        while(window.__STUDIO_RENDERED_REVISION__!==result.appliedRevision||window.__STUDIO_RENDERED_HASH__!==result.contentHash){if(performance.now()>deadline)throw new Error('render marker timeout');await new Promise(r=>setTimeout(r,4))}
        await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const el=document.querySelector('[data-node-id="probe"]');
        if(!el||!el.textContent.includes(${JSON.stringify(text)}))throw new Error('Rendered probe mismatch');
        return {responseMs,markerAndTwoRafMs:performance.now()-start,revision:result.appliedRevision,contentHash:result.contentHash,text:el.textContent,patchMode:window.__STUDIO_LAST_PATCH_MODE__};
      })()`, { timeoutMs: 150000 });
      const screenshot = await page.screenshot({ clip });
      result.browser.rawEdits.push({ ...observed, screenshotBarrierMs: elapsed(t), screenshotSha256: sha(screenshot) });
      if (i === samples - 1) writeFileSync(join(cellDir, 'browser-final-probe.png'), screenshot);
    }
    for (const kind of ['pan', 'zoom']) result.browser.rawFrames[kind] = await page.evaluate(`(async()=>{
      const viewport=document.getElementById('canvas-viewport');if(!viewport)throw new Error('viewport missing');
      const intervals=[],transforms=[];let previous=null;
      await new Promise(resolve=>{let index=0;function step(now){if(previous!==null)intervals.push(now-previous);previous=now;
        const zoom=${kind === 'zoom'};
        viewport.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:zoom?0:(index%2?6:-6),deltaY:zoom?(index%2?8:-8):4,ctrlKey:zoom}));
        transforms.push(document.getElementById('canvas-stage').style.transform);
        if(++index<91)requestAnimationFrame(step);else requestAnimationFrame(resolve)}requestAnimationFrame(step)});
      return {intervals,changedTransforms:new Set(transforms).size,eventCount:91,input:'synthetic DOM WheelEvent through actual Studio listener'};
    })()`, { timeoutMs: 30000 });
    result.browser.finalScreenshotSha256 = sha(await page.screenshot());
    result.browser.dom = await page.send('Memory.getDOMCounters');
    result.browser.heap = await page.send('Runtime.getHeapUsage');
    result.browser.performanceMetrics = (await page.send('Performance.getMetrics')).metrics;
    result.browser.longTasks = await page.evaluate('window.__PERF_LONG_TASKS__');
    result.browser.domMountedNodes = await page.evaluate('document.querySelectorAll(".studio-node").length');
    result.browser.summary = {
      apiResponse: summarize(result.browser.rawEdits.map(row => row.responseMs)),
      editToMarkerAndTwoRaf: summarize(result.browser.rawEdits.map(row => row.markerAndTwoRafMs)),
      editToScreenshotBarrier: summarize(result.browser.rawEdits.map(row => row.screenshotBarrierMs)),
      panFrameIntervals: summarize(result.browser.rawFrames.pan.intervals),
      zoomFrameIntervals: summarize(result.browser.rawFrames.zoom.intervals),
      uniqueProbeScreenshots: new Set(result.browser.rawEdits.map(row => row.screenshotSha256)).size,
    };
    result.browser.status = 'measured';
  } finally {
    if (page) await page.close().catch(() => {});
    if (chrome) await chrome.close().catch(() => {});
  }
}

async function worker() {
  const { runtime, cellDir, size, category, samples, browser } = JSON.parse(readFileSync(flags.worker, 'utf8'));
  mkdirSync(cellDir, { recursive: true });
  const result = { size, category, samplesRequested: samples, status: 'running', startedAt: new Date().toISOString(), node: process.version, pid: process.pid, browser: { status: 'not_run', reason: 'First batch browser subset: text at each size' } };
  const work = mkdtempSync(join(cellDir, 'work-'));
  const resultPath = join(cellDir, 'result.json');
  let studio;
  try {
    const tImport = performance.now();
    const load = name => import(pathToFileURL(join(runtime, 'studio', name)));
    const [{ normalizeStudioDocument, computeContentHash }, { resolveDocumentScene }, { StudioDocumentStore }, { StudioPersistence }, { StudioServer }, { launchChrome }] = await Promise.all([load('document.mjs'), load('scene-resolver.mjs'), load('commands.mjs'), load('persistence.mjs'), load('server.mjs'), load('cdp.mjs')]);
    result.moduleImportMs = elapsed(tImport);
    const fixtureDir = join(cellDir, 'fixture'); mkdirSync(fixtureDir, { recursive: true });
    const fixture = makePerfFixture({ size, category, projectDir: fixtureDir });
    const fixtureText = JSON.stringify(fixture);
    const sourcePath = join(fixtureDir, 'source.json'); writeFileSync(sourcePath, fixtureText);
    result.fixture = { sourcePath, sha256: sha(fixtureText), bytes: Buffer.byteLength(fixtureText), sourcePageNodes: countSourceNodes(fixture), pageCount: fixture.pages.length,
      componentDefinitions: category === 'components' ? 1 : 0, images: category === 'images' ? { uniqueAssets: 16, width: 64, height: 48, pattern: '80% image slots, shared lossless PNGs' } : null };
    let doc = normalizeStudioDocument(structuredClone(fixture), fixtureDir);
    let at = performance.now(); let firstScene = resolveDocumentScene(doc); result.firstSceneMs = elapsed(at);
    result.fixture.resolvedSceneNodes = firstScene.pages.reduce((sum, page) => sum + page.nodes.length, 0);
    if (result.fixture.resolvedSceneNodes !== size) throw new Error(`Fixture scene count ${result.fixture.resolvedSceneNodes} != ${size}`);
    const raw = { clone: [], hash: [], scene: [], localTransaction: [], durableSave: [] };
    at = performance.now(); computeContentHash(doc); result.firstHashMs = elapsed(at);
    for (let i = 0; i < samples; i++) {
      at = performance.now(); structuredClone(doc); raw.clone.push(elapsed(at));
      at = performance.now(); computeContentHash(doc); raw.hash.push(elapsed(at));
      at = performance.now(); resolveDocumentScene(doc); raw.scene.push(elapsed(at));
    }
    global.gc?.();
    const persistence = new StudioPersistence(join(work, 'core'));
    if (category === 'images') cpSync(join(fixtureDir, 'assets'), join(work, 'core', 'assets'), { recursive: true });
    let store = new StudioDocumentStore(doc);
    persistence.saveFullSnapshot(store.doc);
    for (let i = 0; i < samples; i++) {
      at = performance.now();
      const tx = store.applyTransaction({ baseRevision: store.appliedRevision, idempotencyKey: `core-${i}`, pageId: 'p0', commands: [{ type: 'setText', pageId: 'p0', nodeId: 'probe', text: `Performance probe ${String(i + 1).padStart(3, '0')}` }] });
      raw.localTransaction.push(elapsed(at));
      if (!tx.ok) throw new Error(`Transaction failed: ${JSON.stringify(tx)}`);
      at = performance.now(); persistence.persistTransaction(store, store.history.at(-1)); raw.durableSave.push(elapsed(at));
      if (store.durableRevision !== store.appliedRevision) throw new Error('Durable revision mismatch');
    }
    at = performance.now(); let recovered = persistence.recoverAndLoad(); result.recoveryMs = elapsed(at);
    result.persistenceCheck = { revision: store.appliedRevision, durableRevision: store.durableRevision, recoveredRevision: recovered.store.appliedRevision,
      expectedHash: store.doc.contentHash, recoveredHash: recovered.store.doc.contentHash, matches: store.doc.contentHash === recovered.store.doc.contentHash };
    if (!result.persistenceCheck.matches) throw new Error('Persistence recovery hash mismatch');
    result.raw = raw; result.core = Object.fromEntries(Object.entries(raw).map(([key, values]) => [key, summarize(values)]));
    result.nodeMemoryAfterCore = process.memoryUsage();
    store = null; recovered = null; firstScene = null; doc = null; global.gc?.();
    if (browser) {
      const browserProject = join(work, 'browser'); mkdirSync(browserProject, { recursive: true });
      if (category === 'images') cpSync(join(fixtureDir, 'assets'), join(browserProject, 'assets'), { recursive: true });
      at = performance.now(); studio = new StudioServer({ projectDir: browserProject, sourcePath, port: 0, domain: 'web' });
      result.newProjectOpenMs = elapsed(at);
      await studio.start();
      result.server = { port: studio.port, projectDir: browserProject };
      await browserMeasurements({ studio, launchChrome, result, samples, cellDir });
    } else {
      at = performance.now();
      const openDir = join(work, 'open'); mkdirSync(openDir, { recursive: true });
      if (category === 'images') cpSync(join(fixtureDir, 'assets'), join(openDir, 'assets'), { recursive: true });
      studio = new StudioServer({ projectDir: openDir, sourcePath, port: 0, domain: 'web' });
      result.newProjectOpenMs = elapsed(at);
    }
    result.status = 'measured';
  } catch (error) {
    result.status = 'failed'; result.error = { message: error.message, stack: error.stack };
  } finally {
    if (studio) await studio.close().catch(() => {});
    result.nodeMemoryAtEnd = process.memoryUsage(); result.resourceUsage = process.resourceUsage();
    result.endedAt = new Date().toISOString();
    save(resultPath, result);
    rmSync(work, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ size, category, status: result.status, resultPath, error: result.error?.message }));
  if (result.status !== 'measured') process.exitCode = 1;
}

function processTree(rootPid) {
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
    const pids = new Set([rootPid]); let grew = true;
    while (grew) { grew = false; for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); grew = true; } }
    const owned = rows.filter(([pid]) => pids.has(pid));
    return { at: Date.now(), workerRssBytes: (owned.find(([pid]) => pid === rootPid)?.[2] || 0) * 1024,
      descendantsRssBytes: owned.filter(([pid]) => pid !== rootPid).reduce((sum, row) => sum + row[2] * 1024, 0),
      totalRssBytes: owned.reduce((sum, row) => sum + row[2] * 1024, 0), processCount: owned.length };
  } catch { return null; }
}

async function main() {
  const output = resolve(flags.output || join(process.cwd(), 'outputs', 'studio-performance'));
  const runtime = resolve(flags.runtime || join(output, 'runtime-before'));
  mkdirSync(output, { recursive: true });
  freezeRuntime(runtime, resolve(flags['studio-source'] || join(canonical, 'studio')));
  const before = fileManifest(runtime);
  const runId = new Date().toISOString().replaceAll(':', '-');
  const runDir = join(output, `run-${runId}`); mkdirSync(runDir, { recursive: true });
  const sizes = String(flags.sizes || '1000,5000,10000').split(',').map(Number);
  const categories = String(flags.categories || PERF_CATEGORIES.join(',')).split(',');
  const browserCategories = String(flags.browser || 'text').split(',');
  const samples = Number(flags.samples || 30);
  const metadata = { startedAt: new Date().toISOString(), runId, runtime, runtimeFiles: before,
    harness: [scriptPath, join(dirname(scriptPath), 'perf-fixtures.mjs')].map(path => ({ path, sha256: sha(readFileSync(path)) })),
    machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version, executable: process.execPath },
    method: { coreSamples: samples, browserCategories, sizes, categories, rssPollMs: 200, runtimeDependencies: 'canonical node_modules symlink; not modified', browserInput: 'synthetic wheel dispatched to real product listener', sceneSize: 'expanded nodes including page roots', initialOpen: 'fresh project and profile, OS filesystem cache uncontrolled' } };
  save(join(runDir, 'metadata.json'), metadata);
  const cells = [];
  for (const category of categories) for (const size of sizes) {
    const cellDir = join(runDir, `${category}-${size}`); mkdirSync(cellDir, { recursive: true });
    const configPath = join(cellDir, 'config.json');
    save(configPath, { runtime, cellDir, size, category, samples, browser: browserCategories.includes(category) });
    const child = spawn(process.execPath, ['--expose-gc', scriptPath, `--worker=${configPath}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    const rss = []; const poll = () => { const row = processTree(child.pid); if (row) rss.push(row); };
    poll(); const timer = setInterval(poll, 200);
    const code = await new Promise(done => child.once('exit', done)); clearInterval(timer);
    writeFileSync(join(cellDir, 'worker.log'), stdout + stderr); save(join(cellDir, 'rss-samples.json'), rss);
    const resultPath = join(cellDir, 'result.json');
    const cell = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { size, category, status: 'failed', error: { message: `Worker exit ${code}`, stderr } };
    cell.processMemory = { samplingIntervalMs: 200, samples: rss.length,
      peakWorkerRssBytes: Math.max(0, ...rss.map(row => row.workerRssBytes)),
      peakDescendantsRssBytes: Math.max(0, ...rss.map(row => row.descendantsRssBytes)),
      peakCombinedRssBytes: Math.max(0, ...rss.map(row => row.totalRssBytes)),
      note: 'sampled RSS sums may double count shared memory; short spikes may be missed; descendants include browser and typography helper processes' };
    save(resultPath, cell); cells.push(cell);
    save(join(output, 'results.json'), { runDir, metadata, cells });
    console.log(JSON.stringify({ category, size, status: cell.status, error: cell.error?.message, coreEditP95: cell.core?.localTransaction.p95, browserPaintBarrierP95: cell.browser?.summary?.editToScreenshotBarrier.p95 }));
  }
  const after = fileManifest(runtime);
  const unchanged = before.every(file => after.find(other => other.path === file.path)?.sha256 === file.sha256);
  const summary = { runDir, metadata, endedAt: new Date().toISOString(), runtimeSourceUnchanged: unchanged, generatedRuntimeFiles: after.filter(file => !before.some(old => old.path === file.path)), cells };
  save(join(output, 'results.json'), summary); save(join(runDir, 'results.json'), summary);
  console.log(JSON.stringify({ runDir, measured: cells.filter(cell => cell.status === 'measured').length, failed: cells.filter(cell => cell.status !== 'measured').length, runtimeSourceUnchanged: unchanged }));
  if (!unchanged || cells.some(cell => cell.status !== 'measured')) process.exitCode = 1;
}

if (flags.worker) await worker(); else await main();
