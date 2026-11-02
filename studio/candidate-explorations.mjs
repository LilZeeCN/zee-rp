import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { StudioDocumentStore } from './commands.mjs';
import { buildNodeIndex, canonicalJson, nodeEvents, sha256 } from './document.mjs';
import { StudioRuntimeSession } from './runtime.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import { runInteractionSteps, countScenarioAssertions } from './scenario-executors.mjs';
import { reviewDesign } from './design-review.mjs';
import { DESIGN_AXES } from './design-craft.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function semanticContract(doc, pageId) {
  const entries = [...new Set(buildNodeIndex(doc).byScopedId.values())].filter(e => e.pageId === pageId);
  const visible = new Map(resolveDocumentScene(doc).pages.find(p => p.id === pageId).nodes.map(n => [n.scopedId, n.visible]));
  return new Map(entries.filter(e => e.node.text !== undefined || e.node.src || e.node.value !== undefined || e.node.placeholder !== undefined || nodeEvents(e.node) || e.node.type === 'dynamic-panel')
    .map(({ scopedId, node }) => [scopedId, {
      content: Object.fromEntries(['text', 'src', 'value', 'placeholder'].filter(k => node[k] !== undefined).map(k => [k, node[k]])),
      events: nodeEvents(node), visible: visible.get(scopedId) ?? (node.visible !== false && node.hidden !== true),
      states: node.states?.map(s => s.id) || null, activeState: node.activeState || null,
    }]));
}
function verifyPreserved(before, after, { content = true, interactions = true } = {}) {
  const errors = [];
  for (const [id, previous] of before) {
    const next = after.get(id);
    if (!next) { errors.push({ nodeId: id, issue: 'required-node-removed' }); continue; }
    if (content && canonicalJson(previous.content) !== canonicalJson(next.content)) errors.push({ nodeId: id, issue: 'content-changed' });
    if (interactions && canonicalJson([previous.events, previous.visible, previous.states, previous.activeState]) !== canonicalJson([next.events, next.visible, next.states, next.activeState])) errors.push({ nodeId: id, issue: 'behavior-changed' });
  }
  return errors;
}
async function runtimeScreenshot(page, targetPath) {
  await page.evaluate(`(async () => {
    const a=window.__STUDIO_APP__; a.setPanZoom(-20,0,1);
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('#screen-root img')].map(img => img.decode()));
    await new Promise(r=>requestAnimationFrame(r));
    document.body.classList.add('studio-capture');
  })()`);
  try {
    const rect = await page.evaluate(`(() => {const r=document.querySelector('#screen-root').closest('.artboard-wrapper').querySelector('.artboard-outer').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
    const png = await page.screenshot({ clip: { ...rect, scale: 1 } });
    writeFileSync(targetPath, png);
    return { path: targetPath, sha256: sha256(png) };
  } finally { await page.evaluate(`document.body.classList.remove('studio-capture')`); }
}

// AI authors arbitrary command trees. The server isolates, renders and checks them.
export async function previewCandidates(studio, { pageId, baseRevision, candidates, states = [], preserve = {} }) {
  if (baseRevision !== studio.store.appliedRevision) fail('E_STALE_EXPLORATION', '探索必须基于当前 baseRevision');
  if (!studio.scene.pages.some(p => p.id === pageId)) fail('E_PAGE_NOT_FOUND', `页面不存在：${pageId}`);
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 4) fail('E_CANDIDATES', 'candidates 需要1–4个由 AI 编写的候选');
  if (!Array.isArray(states) || states.length > 3) fail('E_EXPLORATION_STATES', '最多选择3个要实际验证和截图的状态');
  const stateIds = new Set();
  for (const state of states) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(state?.id || '') || stateIds.has(state.id)) fail('E_EXPLORATION_STATES', '状态需要唯一安全 id');
    stateIds.add(state.id);
    // 与 studio_run_scenario 同口径：零断言/零操作在入口拒绝，不先跑完像素审计再在帧里失败。
    if (!Array.isArray(state.steps) || !state.steps.length) fail('E_SCENARIO_ACTIONS_REQUIRED', `状态 ${state.id} 尚未提供可重放的用户操作；请补充 click/input/fill/expect 步骤`);
    if (!countScenarioAssertions(state.steps)) fail('E_SCENARIO_ASSERTIONS_REQUIRED', `状态 ${state.id} 没有任何断言，不能认证为通过；请为 expect 增加页面、变量、可见文字、面板状态或数据集断言`);
  }
  const ids = new Set();
  for (const candidate of candidates) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.id || '') || ids.has(candidate.id) || !Array.isArray(candidate.commands) || !candidate.commands.length) fail('E_CANDIDATES', '候选需要唯一安全 id 和非空 commands');
    ids.add(candidate.id);
    if(candidate.designIntent !== undefined){
      const intent=candidate.designIntent;
      if(!intent||typeof intent!=='object'||Array.isArray(intent)||Object.keys(intent).some(key=>!['reason','tradeoff','axes'].includes(key))||['reason','tradeoff'].some(key=>typeof intent[key]!=='string'||!intent[key].trim()||intent[key].length>1000)||!Array.isArray(intent.axes)||!intent.axes.length||intent.axes.length>6||new Set(intent.axes).size!==intent.axes.length||intent.axes.some(axis=>!DESIGN_AXES.includes(axis)))fail('E_CANDIDATE_INTENT','designIntent需要reason、tradeoff和不重复的有效axes；这是调用者的设计理由，不是自动验证结论');
    }
  }
  const source = structuredClone(studio.store.doc), sourceHash = source.contentHash;
  const baseContract = semanticContract(source, pageId);
  const explorationId = randomUUID(), dir = join(studio.projectDir, 'design-explorations', explorationId);
  mkdirSync(dir, { recursive: true });
  const results = [], columns = [];
  for (const candidate of candidates) {
    const store = new StudioDocumentStore(source);
    await studio.operationProgress?.('rendering-candidate',{candidateId:candidate.id});
    const applied = store.applyTransaction({ baseRevision, idempotencyKey: `candidate-${candidate.id}`, pageId, commands: candidate.commands });
    const result = { id: candidate.id, label: candidate.label || candidate.id, ...(candidate.designIntent?{designIntent:{...structuredClone(candidate.designIntent),source:'caller-provided',userAccepted:false}}:{}),status: 'rejected', frames: [] };
    results.push(result);
    if (!applied.ok) { result.error = { code: applied.code, message: applied.message }; continue; }
    const errors = verifyPreserved(baseContract, semanticContract(store.doc, pageId), preserve);
    if (canonicalJson(source.variables) !== canonicalJson(store.doc.variables) || canonicalJson(source.datasets) !== canonicalJson(store.doc.datasets)) errors.push({ issue: 'runtime-data-changed' });
    if (applied.transitiveImpact.affectedPageIds.some(id => id !== pageId)) errors.push({ issue: 'other-page-changed' });
    if (errors.length) { result.error = { code: 'E_CANDIDATE_PRESERVATION', details: errors }; continue; }
    const projectDir = join(dir, candidate.id); mkdirSync(projectDir, { recursive: true });
    for (const assetDir of ['assets', 'fonts']) if (existsSync(join(studio.projectDir, assetDir))) cpSync(join(studio.projectDir, assetDir), join(projectDir, assetDir), { recursive: true });
    writeFileSync(join(projectDir, 'document.json'), JSON.stringify(store.doc));
    const { startStudioServer } = await import('./server.mjs');
    let sandbox;
    try {
      ({ studio: sandbox } = await startStudioServer({ projectDir, port: 0 }));
      const review = await reviewDesign(sandbox, { pageId, baseRevision: sandbox.store.appliedRevision });
      result.findings = { hard: review.findings.filter(f => f.severity === 'error'), advisory: review.findings.filter(f => f.severity !== 'error') };
      result.initialContrastSource = review.designMetrics.metrics.contrast.source;
      const page = await sandbox.ensureManagedBrowserPage();
      const renderStates = states.length ? states : [{ id: 'initial', steps: [{ expect: { page: pageId } }] }];
      let verified = true;
      for (let index = 0; index < renderStates.length; index++) {
        const state = renderStates[index];
        await studio.operationProgress?.('checking-state',{candidateId:candidate.id,stateId:state.id});
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(state.id || '')) fail('E_EXPLORATION_STATES', '状态需要安全 id');
        const runtime = new StudioRuntimeSession(sandbox.store.doc); runtime.reset(pageId);
        const semantic = runtime.runScenario(state.steps || []);
        if (!semantic.ok) { writeFileSync(join(projectDir, `state-${index}-semantic.json`), JSON.stringify(semantic)); result.frames.push({ id: state.id, status: 'failed', layer: 'semantic', code: semantic.code, detailsPath: join(projectDir, `state-${index}-semantic.json`) }); verified = false; continue; }
        const browser = await runInteractionSteps(page, sandbox.store.doc, state.steps, { layer: 'browser', startPageId: pageId });
        if (!browser.passed) { writeFileSync(join(projectDir, `state-${index}-browser.json`), JSON.stringify(browser)); result.frames.push({ id: state.id, status: 'failed', layer: 'browser', code: browser.code, detailsPath: join(projectDir, `state-${index}-browser.json`) }); verified = false; continue; }
        const shot = await runtimeScreenshot(page, join(projectDir, `state-${index}.png`));
        result.frames.push({ id: state.id, status: 'passed', ...shot, assertionCount: browser.assertionCount, verification: 'real-browser-pointer' });
      }
      result.projectDir = projectDir;
      result.status = verified ? 'rendered' : 'failed';
      if (verified && !result.findings.hard.length) result.applyWith = { baseRevision, idempotencyKey: `apply-${explorationId}-${candidate.id}`, pageId, commands: candidate.commands };
      const frames = result.frames.filter(f => f.path);
      if (frames.length) columns.push({ label: result.label, frames: result.frames });
    } catch (error) { result.error = { code: error.code || 'E_CANDIDATE_RENDER', message: error.message }; result.status = 'failed'; }
    finally { await sandbox?.stop(); }
  }
  if (studio.store.appliedRevision !== baseRevision || studio.store.doc.contentHash !== sourceHash) fail('E_STALE_EXPLORATION', '探索期间源工程已变化，候选不能作为当前版本证据');
  let contactSheet = null, mcpImages = [];
  if (columns.length) {
    await studio.operationProgress?.('building-contact-sheet');
    const manifestPath = join(dir, 'contact-sheet.json'), path = join(dir, 'contact-sheet.png');
    writeFileSync(manifestPath, JSON.stringify({ columns }));
    execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'contact-sheet.py'), manifestPath, path], { timeout: 30000 });
    const bytes = readFileSync(path); contactSheet = { path, sha256: sha256(bytes) }; mcpImages = [{ mimeType: 'image/png', data: bytes.toString('base64') }];
  }
  const result = { ok: true, explorationId, pageId, baseRevision, contentHash: sourceHash, candidates: results, contactSheet,
    basis: 'AI-authored arbitrary commands; initial pixel review and real browser state replays',
    selection: '候选按提交顺序展示，由看图的 AI 或用户选择；不以审美分自动代选。' };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return { ...result, mcpImages };
}
