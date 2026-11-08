#!/usr/bin/env node
// Real fresh model sessions. No task builder is used to author any document.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir, platform, release, cpus } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTrialFeedback, selectModelConfiguration } from './model-selection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const flags = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return at < 0 ? [arg.slice(2), true] : [arg.slice(2, at), arg.slice(at + 1)]; }));
const root = resolve(flags.runtime || join(here, '../..'));
const output = resolve(flags.output || (() => { throw new Error('--output=/new/evidence/directory is required'); })());
const load = path => import(pathToFileURL(join(root, path)));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const sha = data => createHash('sha256').update(data).digest('hex');
function evidenceManifest(dir) {
  const files = [];
  const scan = (folder, prefix = '') => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name), rel = join(prefix, entry.name);
      if (rel === 'run-evidence-manifest.json') continue;
      if (entry.isDirectory()) scan(path, rel);
      else if (entry.isFile()) files.push({ path: rel, sha256: sha(readFileSync(path)) });
      else throw new Error(`E_TRIAL_ARTIFACT_MISMATCH: unsupported evidence entry ${rel}`);
    }
  };
  scan(dir);
  return files.sort((a,b) => a.path.localeCompare(b.path));
}
const suite = json(join(root, 'benchmarks/studio/tasks.json'));
const content = json(join(root, 'benchmarks/studio/fixtures/content.json'));
const records = json(join(root, 'benchmarks/studio/fixtures/records.json'));
const assets = json(join(root, 'benchmarks/studio/fixtures/assets.json'));
const localEdit = json(join(root, 'benchmarks/studio/fixtures/local-edit.json'));
const [{ studioTools, studioHandlers }, { startStudioServer }, { runInteractionSteps }, { verifyTaskDocumentStructure }, { importToStudioDocument, normalizeStudioDocument }, { checkActorEvidence, checkObservedContent }] = await Promise.all([
  load('studio/mcp-adapter.mjs'), load('studio/server.mjs'), load('studio/scenario-executors.mjs'), load('benchmarks/studio/task-builders.mjs'), load('studio/document.mjs'), load('benchmarks/studio/real-trial-acceptance.mjs'),
]);
const assetSize = spawnSync('python3', ['-c', 'from PIL import Image;import sys,json;im=Image.open(sys.argv[1]);print(json.dumps(dict(width=im.width,height=im.height)))', join(root, assets.assets[0].path)], { encoding: 'utf8' });
if (assetSize.status !== 0) throw new Error('Cannot inspect fixed asset: ' + assetSize.stderr);
const assetDimensions = JSON.parse(assetSize.stdout);
const manifest = [];
function walk(dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (['node_modules', '__pycache__', '.git', '.venv'].includes(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path); else if (e.isFile()) manifest.push({ path, sha256: sha(readFileSync(join(root, path))) });
  }
}
for (const dir of ['studio', 'scripts', 'bin', 'references', 'benchmarks/studio']) walk(dir);
for (const path of ['package.json', 'package-lock.json', assets.assets[0].path]) manifest.push({ path, sha256: sha(readFileSync(join(root, path))) });
if (sha(readFileSync(join(root, assets.assets[0].path))) !== assets.assets[0].sha256) throw new Error('Fixed asset SHA does not match its manifest');
manifest.sort((a, b) => a.path.localeCompare(b.path));
const sourceSha = sha(JSON.stringify(manifest));
mkdirSync(output, { recursive: true });
if (existsSync(join(output, 'protocol.json')) && !flags.resume) throw new Error('Output already used; preserve it and use a new directory');
// Existing evidence remains immutable until the protocol has been checked.
// Read only the selected non-secret settings. No credential or provider key is read.
const configRead = spawnSync('python3', ['-c', 'import json,tomllib,pathlib;d=tomllib.loads(pathlib.Path.home().joinpath(".codex/config.toml").read_text());print(json.dumps({k:d.get(k) for k in ["model","model_reasoning_effort","model_provider"]}))'], { encoding: 'utf8' });
if (configRead.status !== 0) throw new Error('Cannot record selected model configuration');
const configured = JSON.parse(configRead.stdout);
const selected = selectModelConfiguration(configured, flags);
const agentSchema = { type: 'object', additionalProperties: false, required: ['claimCompleted', 'easeScore', 'scoreReason', 'frictions', 'summary'], properties: {
  claimCompleted: { type: 'boolean' }, easeScore: { type: 'number', minimum: 0, maximum: 10 }, scoreReason: { type: 'string' }, frictions: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' },
} };

const protocol = { kind: 'model-agent', suite: suite.suiteId, selectedModel: selected, sourceSha256: sourceSha, toolSchemaSha256: sha(JSON.stringify(studioTools.map(({ name, inputSchema }) => ({ name, inputSchema })))),
  briefHash: sha(readFileSync(join(root, 'benchmarks/studio/tasks.json'))), budgetPolicy: suite.comparisonPolicy,
  configuredBy: flags.model
    ? 'per-process explicit --model and optional reasoning CLI override; user configuration unchanged'
    : 'per-process MCP CLI overrides only; model inherited from user configuration',
  authoring: 'fresh ephemeral Codex process per task/track/repeat; public Studio MCP tools only; no scripted task builders or internal hints; full batching allowed on both routes',
  verification: 'post-author harness calls stored separately, excluded from the actor call budget and never represented as actor decisions',
  visualReview: 'pending separate anonymous artifact review; author ease rating is self-report, not independent visual or user acceptance',
  environment: { os: `${platform()} ${release()}`, hardware: cpus()[0]?.model || null, node: process.version },
};
if (flags.resume) {
  if (!existsSync(join(output, 'protocol.json')) || !existsSync(join(output, 'source-manifest.json'))) throw new Error('E_TRIAL_PROTOCOL_MISMATCH: missing original protocol');
  const previous = json(join(output, 'protocol.json'));
  if (JSON.stringify(previous) !== JSON.stringify(protocol) || JSON.stringify(json(join(output, 'source-manifest.json'))) !== JSON.stringify(manifest)) throw new Error('E_TRIAL_PROTOCOL_MISMATCH: original evidence is unchanged');
} else {
  save(join(output, 'source-manifest.json'), manifest);
  save(join(output, 'agent-feedback.schema.json'), agentSchema);
  save(join(output, 'protocol.json'), protocol);
}

function promptFor(task, track, workDir) {
  return `你是首次使用 Studio 自由画布的独立设计者。请实际创建可编辑、高完成度的原型。不要只给建议。\n
仅使用 studio-trial 提供的公开 MCP 工具。禁止读取产品实现、测试、旧成果、task-builders、其他试用结果；禁止调用其他 MCP、浏览器或 shell 工具。你已打开自己的隔离工程（home 空白页，给定画板与固定素材；T08为给定旧工程）。你可以按需查询公开 studio_describe / studio_inspect(view:context 或 view:nodes) / studio_stage。studio_open_project({})只会重新打开自己的工程。不要操作其他工程。\n
本路线：${track === 'rp1-authoring' ? '主要视觉结构请用 studio_command 的 rp1/sourceMode 创作；变量、数据、页面、组件覆盖与精确编辑可结合公开 commands。' : '仅使用 studio_command 的 commands 创作；不使用 rp1/sourceMode。可自由选择嵌套节点与任意合法完整批次，没有人为分批上限。'}\n
预算：${task.budget.maxToolCalls} 次实际工具尝试（含错误、截图、验收、撤销），首次改稿前最多 ${task.budget.maxDiscoveryCallsBeforeFirstWrite} 次发现，${task.budget.maxWallClockSeconds} 秒。要及时开始写入，再看实际截图精修。一旦收到 E_TRIAL_BUDGET，立即停止所有工具调用并输出当前真实结果与摩擦。根据业务选择有辨识度的构图、字形、阅读顺序和留白，避免把所有信息塞成同一种小卡片。内容、交互及范围全部遵守下面固定任务；没有额外设计范例或内部提示。\n
工具中的截图/审阅会返回真实图片。至少亲自看一次成稿，执行任务给定的实际交互场景并修复自己发现的问题。保留失败回包，不要自己说完成就当作验收通过。给出真实易用性分数和具体阻碍，低分也如实记录。工程源码自动保存；call-ledger和result.json由外部记录器根据真实调用生成，结束后外部验证器也会新进程重开检查。你负责创作、看图和交互验证，不需要手写这些记录。所有输出路径只在 ${workDir} 内。\n
${task.id === 'T08' ? 'T08证据硬要求：必须在第一次改稿事务之前拍 before 截图；改稿后拍 edited；撤销后拍 undo；重做后拍 redo；重新打开后拍 reopened。空选择和过期选择负向验证保留真实错误回包。requiredOutputs和requiredStates属于验收条件，不是建议。\n' : ''}
固定任务（含公开验收剧本）：\n${JSON.stringify(task, null, 2)}\n
固定内容：\n${JSON.stringify(content, null, 2)}\n固定数据：\n${JSON.stringify(records, null, 2)}\n
固定素材：已复制并登记 assets/kingfisher.jpg，图片src使用此相对路径，尺寸${assetDimensions.width}×${assetDimensions.height}；来源与SHA：${JSON.stringify(assets)}。T08仅使用已打开旧工程，不重建、不改非授权字段。\n
结束时按要求的 JSON 格式给出你自己对易用性的真实评价及发现的摩擦，不把机器验收当审美评分。`;
}

async function executeModel(configPath, workDir, runDir, prompt, timeoutSeconds, maxToolCalls) {
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never', '-C', workDir,
    ...(flags.model ? ['--model', selected.model] : []),
    ...(flags.provider ? ['--config', `model_provider="${selected.model_provider}"`] : []),
    ...(flags.reasoning ? ['--config', `model_reasoning_effort="${selected.model_reasoning_effort}"`] : []),
    '-c', 'mcp_servers.zee-axure.enabled=false', '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'mcp_servers.huashu-chrome.enabled=false',
    '-c', 'mcp_servers.studio-trial.command="node"', '-c', `mcp_servers.studio-trial.args=${JSON.stringify([join(root, 'benchmarks/studio/model-trial-server.mjs'), configPath])}`,
    // The user authorizes this isolated Studio trial. Scope that grant to this
    // local server for this process; never change global approval settings.
    '-c', 'mcp_servers.studio-trial.default_tools_approval_mode="approve"', '-c', 'mcp_servers.studio-trial.required=true',
    '--output-schema', join(output, 'agent-feedback.schema.json'), '-o', join(runDir, 'agent-feedback.json'), '-'];
  save(join(runDir, 'invocation.json'), { executable: flags.codex || 'codex', args, stdinPromptSha256: sha(prompt), selectedModel: selected });
  const proc = spawn(flags.codex || 'codex', args, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const eventTimes = [];
  proc.stdout.on('data', chunk => { appendFileSync(join(runDir, 'events.jsonl'), chunk); eventTimes.push({ at: new Date().toISOString(), bytes: chunk.length }); });
  proc.stderr.on('data', chunk => appendFileSync(join(runDir, 'runtime.log'), chunk));
  proc.stdin.end(prompt);
  let timedOut = false, budgetAborted = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, timeoutSeconds * 1000);
  const hardTimer = setTimeout(() => proc.kill('SIGKILL'), timeoutSeconds * 1000 + 15000);
  const budgetTimer = setInterval(() => {
    if (!existsSync(join(runDir, 'call-ledger.jsonl'))) return;
    const attempts = readFileSync(join(runDir, 'call-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    if (attempts > maxToolCalls) {
      budgetAborted = true;
      proc.kill('SIGTERM');
    }
  }, 250);
  const code = await new Promise((done, reject) => { proc.once('close', done); proc.once('error', reject); });
  clearTimeout(timer); clearTimeout(hardTimer); clearInterval(budgetTimer);
  save(join(runDir, 'event-arrival-times.json'), eventTimes);
  return { code, timedOut, budgetAborted };
}

function cachedTrial(task, track, repeat) {
  const runId = `${task.id}-${track}-r${repeat}`, runDir = join(output, runId);
  if (!flags.resume || !existsSync(runDir)) return null;
  if (!existsSync(join(runDir, 'result.json'))) throw new Error(`E_TRIAL_INCOMPLETE: retain ${runDir} and start a new cohort`);
  if (!existsSync(join(runDir, 'call-ledger.jsonl'))) throw new Error(`E_TRIAL_INCOMPLETE: retain ${runDir} and start a new cohort`);
  const proofPath = join(runDir, 'run-evidence-manifest.json');
  if (!existsSync(proofPath) || JSON.stringify(json(proofPath)) !== JSON.stringify(evidenceManifest(runDir))) throw new Error(`E_TRIAL_ARTIFACT_MISMATCH: ${runId}`);
  const prior = json(join(runDir, 'result.json'));
  if (prior.runId !== runId || prior.taskId !== task.id || prior.attempt !== repeat || prior.comparisonGroup !== `${task.id}-repeat-${repeat}` ||
      prior.execution?.kind !== 'model-agent' || prior.fingerprint?.sourceTreeSha256 !== sourceSha ||
      prior.fingerprint?.briefSha256 !== sha(JSON.stringify(task)) || prior.fingerprint?.toolSchemaSha256 !== sha(JSON.stringify(json(join(runDir, 'tool-schema.json')))) ||
      prior.fingerprint?.model?.id !== selected.model) throw new Error(`E_TRIAL_PROTOCOL_MISMATCH: ${runId}`);
  const checked = spawnSync('python3', [join(root, 'benchmarks/studio/validate.py'), '--root', root, '--result', join(runDir, 'result.json'), '--ledger', join(runDir, 'call-ledger.jsonl')], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(`E_TRIAL_RESULT_INVALID: ${runId}: ${checked.stderr.trim() || checked.stdout.trim()}`);
  for (const artifact of prior.artifacts || []) if (!existsSync(join(runDir, artifact.path)) || sha(readFileSync(join(runDir, artifact.path))) !== artifact.sha256) throw new Error(`E_TRIAL_ARTIFACT_MISMATCH: ${runId}/${artifact.path}`);
  return prior;
}
async function trial(task, track, repeat) {
  const runId = `${task.id}-${track}-r${repeat}`, runDir = join(output, runId);
  const prior = cachedTrial(task, track, repeat);
  if (prior) return prior;
  mkdirSync(runDir, { recursive: false });
  const workDir = mkdtempSync(join(tmpdir(), 'studio-model-task-'));
  const projectDir = join(workDir, 'project'), sourcePath = join(workDir, 'initial.json');
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  cpSync(join(root, assets.assets[0].path), join(projectDir, 'assets/kingfisher.jpg'));
  const initial = importToStudioDocument(task.id === 'T08' ? localEdit : { name: task.title, domain: task.platform === 'mobile' ? 'mobile' : 'web', pages: [{ id: 'home', canvas: { w: task.viewport.width, h: task.viewport.height }, root: { id: 'root', type: 'box', w: task.viewport.width, h: task.viewport.height, children: [] } }] });
  if (task.id !== 'T08') initial.assetsManifest['assets/kingfisher.jpg'] = { relativePath: 'assets/kingfisher.jpg', originalSrc: 'assets/kingfisher.jpg', sha256: assets.assets[0].sha256, bytes: readFileSync(join(projectDir, 'assets/kingfisher.jpg')).length, ...assetDimensions, missing: false };
  save(sourcePath, normalizeStudioDocument(initial));
  const config = { runtimeRoot: root, workDir, projectDir, sourcePath, track, maxToolCalls: task.budget.maxToolCalls, receiptsDir: join(runDir, 'receipts'), ledgerPath: join(runDir, 'call-ledger.jsonl'), instancePath: join(runDir, 'instance.json') };
  const configPath = join(runDir, 'transport-config.json'); save(configPath, config);
  const prompt = promptFor(task, track, workDir); writeFileSync(join(runDir, 'prompt.txt'), prompt);
  const startedAt = new Date().toISOString(), start = performance.now();
  console.log(JSON.stringify({ event: 'started', runId, at: startedAt }));
  const actor = await executeModel(configPath, workDir, runDir, prompt, task.budget.maxWallClockSeconds, task.budget.maxToolCalls).catch(error => ({ code: null, timedOut: false, budgetAborted: false, error: error.message }));
  const wallClockMs = performance.now() - start, finishedAt = new Date().toISOString();
  const events = existsSync(join(runDir, 'events.jsonl')) ? readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const receipts = existsSync(config.receiptsDir) ? readdirSync(config.receiptsDir).filter(f => f.endsWith('.json')).sort().map(f => json(join(config.receiptsDir, f))) : [];
  const attempts = events.filter(e => e.type === 'item.started' && ['command_execution', 'file_change', 'web_search', 'mcp_tool_call'].includes(e.item?.type));
  const completed = new Map(events.filter(e => e.type === 'item.completed').map(e => [e.item?.id, e.item]));
  const otherTools = attempts.filter(e => !(e.item.type === 'mcp_tool_call' && e.item.server === 'studio-trial'));
  let receiptIndex = 0, creating = false;
  const rows = attempts.map((event, i) => {
    const item = event.item, official = item.type === 'mcp_tool_call' && item.server === 'studio-trial';
    const receipt = official && receipts[receiptIndex]?.request.name === item.tool ? receipts[receiptIndex++] : null;
    const authoredMutation = receipt?.row.authoredMutation || official && item.tool === 'studio_command' || (item.tool === 'studio_history' && ['undo', 'redo', 'restore'].includes(item.arguments?.action || item.args?.action)) || item.type === 'file_change';
    if (authoredMutation) creating = true;
    const end = completed.get(item.id), timeout = /timed? out|timeout/i.test(JSON.stringify(end?.error || ''));
    const status = !official ? 'error' : !end ? 'uncertain' : timeout ? authoredMutation ? 'uncertain' : 'timeout' : end.status === 'failed' ? 'error' : receipt?.row.status || 'uncertain';
    return { callId: `call-${i + 1}`, parentCallId: null, eventKind: 'attempt', tool: official ? item.tool : item.type, phase: creating ? 'creation' : 'discovery', authoredMutation: Boolean(authoredMutation),
      startedAt: receipt?.row.startedAt || startedAt, endedAt: receipt?.row.endedAt || (end ? finishedAt : null), elapsedMs: receipt?.row.elapsedMs ?? null,
      status, timeoutMs: receipt?.row.timeoutMs ?? null, requestSha256: sha(JSON.stringify(item.arguments || item)), responseEvidenceId: receipt?.row.responseEvidenceId || 'events', usage: null };
  });
  writeFileSync(config.ledgerPath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  receipts.forEach((receipt, i) => { if (receipt.request.args.rp1) writeFileSync(join(runDir, `authored-${i + 1}.rp1`), receipt.request.args.rp1); });
  const usage = events.findLast?.(e => e.type === 'turn.completed')?.usage || [...events].reverse().find(e => e.type === 'turn.completed')?.usage;
  const feedback = existsSync(join(runDir, 'agent-feedback.json')) ? parseTrialFeedback(readFileSync(join(runDir, 'agent-feedback.json'), 'utf8')) : null;
  const result = json(join(root, 'benchmarks/studio/result-template.json'));
  Object.assign(result, { runId, taskId: task.id, attempt: repeat, comparisonGroup: `${task.id}-repeat-${repeat}`, execution: { kind: 'model-agent', runner: 'benchmarks/studio/run-model-trials.mjs' },
    experience: { classification: otherTools.length ? 'unclassified' : 'independent', readImplementation: otherTools.length ? null : false, priorSameTaskExposure: false, assistance: [] },
    timestamps: { startedAt, finishedAt, wallClockMs }, budget: Object.fromEntries(['maxToolCalls', 'maxDiscoveryCallsBeforeFirstWrite', 'maxWallClockSeconds', 'maxModelTokens'].map(key => [key, task.budget[key]])),
    calls: { ledgerPath: 'call-ledger.jsonl', total: rows.length, timedOut: rows.filter(r => r.status === 'timeout').length, uncertain: rows.filter(r => r.status === 'uncertain').length, discovery: rows.filter(r => r.phase === 'discovery').length, creation: rows.filter(r => r.phase === 'creation').length, firstMutationCallId: rows.find(r => r.authoredMutation)?.callId || null },
    tokens: usage ? { measurement: 'provider-usage', input: usage.input_tokens, output: usage.output_tokens, total: usage.input_tokens + usage.output_tokens, sourceEvidenceIds: ['events'] } : result.tokens,
    ratings: feedback ? [{ source: 'agent', score: feedback.easeScore, reason: feedback.scoreReason + '；' + feedback.frictions.join('；'), evidenceIds: ['feedback'] }] : [],
    limitations: ['易用性分数为实际作者自评；独立视觉与用户验收另列。',
      flags.model
        ? '模型身份按每次 codex exec 的显式 --model 调用记录；provider 沿用该进程实际 Codex 配置，无后台模型路由证明。'
        : '模型身份按本机所选Codex配置及无模型覆盖的实际调用记录；无后台模型路由证明。',
      '操作系统/原生Axure层未在此轮重测。'],
  });
  result.fingerprint = { ...result.fingerprint, sourceTreeSha256: sourceSha, sourceManifestPath: '../source-manifest.json', toolSchemaSha256: protocol.toolSchemaSha256, runtimeFingerprint: sourceSha,
    model: { id: selected.model, reasoningEffort: selected.model_reasoning_effort || null, provider: selected.model_provider || 'openai-default' }, environment: { ...result.fingerprint.environment, ...protocol.environment }, briefSha256: sha(JSON.stringify(task)), assetsManifestSha256: sha(JSON.stringify(assets)) };
  if (existsSync(join(runDir, 'tool-schema.json'))) result.fingerprint.toolSchemaSha256 = sha(JSON.stringify(json(join(runDir, 'tool-schema.json'))));
  let studio;
  try {
    ({ studio } = await startStudioServer({ projectDir, port: 0 }));
    const doc = structuredClone(studio.store.doc); save(join(runDir, 'source.json'), doc);
    result.documentBinding = { documentId: doc.documentId, revision: doc.revision, contentHash: doc.contentHash };
    const structure = verifyTaskDocumentStructure(task.id, doc); save(join(runDir, 'structure.json'), structure);
    const actorEvidence = checkActorEvidence(task.id, receipts, feedback, doc.contentHash, task.scenarios, existsSync(config.instancePath) ? json(config.instancePath).initialBinding : null);
    save(join(runDir, 'actor-evidence.json'), actorEvidence);
    // Reopen in a fresh Node process after the author session closed.
    const reopenProgram = `import {StudioPersistence} from ${JSON.stringify(pathToFileURL(join(root, 'studio/persistence.mjs')).href)}; const v = new StudioPersistence(process.argv[1]).recoverAndLoad(); console.log(JSON.stringify({revision:v.store.doc.revision,contentHash:v.store.doc.contentHash}));`;
    const reopened = spawnSync(process.execPath, ['--input-type=module','-e',reopenProgram,projectDir], {encoding:'utf8'});
    let reopenEvidence = { passed: false, stderr: reopened.stderr };
    if (reopened.status === 0) { const fresh = JSON.parse(reopened.stdout.trim()); reopenEvidence = { passed: fresh.revision === doc.revision && fresh.contentHash === doc.contentHash, ...fresh }; }
    save(join(runDir, 'fresh-reopen.json'), reopenEvidence);
    const scenarios = [];
    for (const scenario of task.scenarios) {
      try { scenarios.push({ id: scenario.id, result: await studioHandlers.studio_run_scenario({ url: studio.url, reset: true, startPageId: scenario.startPageId, steps: scenario.steps, verbose: true }) }); }
      catch (error) { scenarios.push({ id: scenario.id, result: { ok: false, message: error.message } }); }
    }
    save(join(runDir, 'harness-semantic.json'), { authorCalls: false, scenarios });
    const semanticPassed = scenarios.every(s => s.result.ok === true);
    const images = []; mkdirSync(join(runDir, 'screenshots'));
    for (const page of doc.pages) {
      const path = join(runDir, 'screenshots', `${page.id}.png`);
      const screenshot = await studio.captureScreenshot({ revision: doc.revision, pageId: page.id, outPath: path });
      images.push({ pageId: page.id, path: relative(runDir, path), revision: screenshot.revision, contentHash: screenshot.contentHash });
    }
    save(join(runDir, 'harness-render.json'), { authorCalls: false, images });
    const browser = [], page = await studio.ensureManagedBrowserPage();
    for (const scenario of task.scenarios) {
      browser.push({ id: scenario.id, result: await runInteractionSteps(page, doc, scenario.steps, { layer: 'browser', startPageId: scenario.startPageId }) });
      writeFileSync(join(runDir, 'screenshots', `state-${scenario.id}.png`), await page.screenshot());
    }
    save(join(runDir, 'harness-pointer.json'), { authorCalls: false, scenarios: browser });
    const observedContent = checkObservedContent(task.id, browser, content);
    save(join(runDir, 'observed-content.json'), observedContent);
    const layer = (passed, evidence, count, note) => ({ status: passed ? 'passed' : 'failed', evidenceIds: [evidence], assertionCount: count, note });
    result.evidence['source-structure'] = layer(structure.passed, 'structure', structure.assertionCount, '验证真实作者工程；不根据作者完成声明判断。');
    result.evidence.semantic = layer(semanticPassed, 'semantic', scenarios.reduce((n, s) => n + (s.result.assertionCount || 0), 0), '作者结束后，隔离语义会话执行原任务全部断言。');
    result.evidence['browser-render'] = layer(images.length === doc.pages.length, 'render', images.length, '真实浏览器、指定revision/hash绘制及PNG；不等于审美通过。');
    result.evidence['browser-pointer'] = layer(browser.every(s => s.result.passed), 'pointer', browser.reduce((n, s) => n + (s.result.assertionCount || 0), 0), '真实浏览器指针/输入与实际状态断言；没有向运行态注入期望值。');
    const budgetExceeded = actor.budgetAborted || rows.length > task.budget.maxToolCalls || result.calls.discovery > task.budget.maxDiscoveryCallsBeforeFirstWrite || wallClockMs > task.budget.maxWallClockSeconds * 1000;
    const routeUsed = track !== 'rp1-authoring' || task.id === 'T08' || receipts.some(r => typeof r.request.args.rp1 === 'string' && r.row.status === 'success');
    result.outcome = budgetExceeded ? 'budget-exceeded' : structure.passed && semanticPassed && browser.every(s => s.result.passed) && actorEvidence.passed && reopenEvidence.passed && observedContent.passed && !actor.timedOut && actor.code === 0 && !otherTools.length && routeUsed ? 'completed' : 'failed';
    if (!routeUsed) result.limitations.push('指定RP/1路线未实际成功使用RP/1，未计路线成功。');
    cpSync(projectDir, join(runDir, 'project'), { recursive: true });
  } catch (error) {
    result.outcome = actor.timedOut ? 'budget-exceeded' : 'failed';
    result.failures.push({ id: 'harness', phase: 'verification', originalEvidenceIds: ['events'], reason: error.stack || error.message, resolution: null });
  } finally { if (studio) await studio.close(); rmSync(workDir, { recursive: true, force: true }); }
  const kinds = { 'observed-content.json': ['observed-content', 'browser-observed-content'], 'actor-evidence.json': ['actor-evidence', 'actor-behavior'], 'fresh-reopen.json': ['fresh-reopen', 'fresh-process-reopen'], 'events.jsonl': ['events', 'actual-model-events'], 'agent-feedback.json': ['feedback', 'agent-self-report'], 'structure.json': ['structure', 'source-check'], 'harness-semantic.json': ['semantic', 'scenario-trace'], 'harness-render.json': ['render', 'browser-render'], 'harness-pointer.json': ['pointer', 'browser-pointer'] };
  for (const [path, [id, kind]] of Object.entries(kinds)) if (existsSync(join(runDir, path))) result.artifacts.push({ id, kind, path, relativeTo: 'runDir', sha256: sha(readFileSync(join(runDir, path))), binding: result.documentBinding });
  save(join(runDir, 'result.json'), result);
  save(join(runDir, 'run-evidence-manifest.json'), evidenceManifest(runDir));
  console.log(JSON.stringify({ event: 'finished', runId, outcome: result.outcome, calls: result.calls.total, ease: feedback?.easeScore, wallSeconds: Math.round(wallClockMs / 1000) }));
  return result;
}

const jobs = [];
const ids = flags.tasks ? String(flags.tasks).split(',') : suite.tasks.map(t => t.id);
const repeats = Number(flags.repeats || 3), tracks = flags.tracks ? String(flags.tracks).split(',') : ['rp1-authoring', 'low-level'];
for (let repeat = 1; repeat <= repeats; repeat++) for (const task of suite.tasks.filter(t => ids.includes(t.id))) for (const track of tracks) jobs.push({ task, track, repeat });
// Validate every cached result before launching any actor or updating progress.
if (flags.resume) for (const job of jobs) cachedTrial(job.task, job.track, job.repeat);
let next = 0; const results = [];
await Promise.all(Array.from({ length: Math.min(Number(flags.concurrency || 2), jobs.length) }, async () => { while (next < jobs.length) { const job = jobs[next++]; results.push(await trial(job.task, job.track, job.repeat)); save(join(output, 'progress.json'), { planned: jobs.length, finished: results.length, results: results.map(r => ({ runId: r.runId, outcome: r.outcome })) }); } }));
save(join(output, 'summary.json'), { protocol, runs: results.map(r => ({ runId: r.runId, outcome: r.outcome, calls: r.calls, ratings: r.ratings })), authoringMethod: 'actual independent model sessions', independentVisualStatus: 'not-run', userAcceptance: 'not-run' });
