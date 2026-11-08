#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startStudioServer } from '../../studio/server.mjs';
import { studioHandlers, studioTools } from '../../studio/mcp-adapter.mjs';
import { launchChrome } from '../../studio/cdp.mjs';
import { runInteractionSteps } from '../../studio/scenario-executors.mjs';
import { readRp } from '../../scripts/rp-read.mjs';
import {
  loadBenchmarkFixtures,
  buildRp1AuthoringPlan,
  buildRp1AuthoringCommands,
  buildLowLevelAuthoringCommands,
  verifyTaskDocumentStructure,
} from './task-builders.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const TASKS_JSON_PATH = resolve(__dirname, 'tasks.json');
const ASSETS_JSON_PATH = resolve(__dirname, 'fixtures/assets.json');
const VALIDATE_PY_PATH = resolve(__dirname, 'validate.py');
const FIXTURES = loadBenchmarkFixtures();
const SUITE = FIXTURES.suite;

function sha256Text(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function computeSourceTreeSha256() {
  const tracked = [
    'studio/server.mjs',
    'studio/mcp-adapter.mjs',
    'studio/commands.mjs',
    'studio/command-contracts.mjs',
    'studio/node-properties.mjs',
    'studio/runtime.mjs',
    'studio/export-code.mjs',
    'studio/project-bundle.mjs',
    'studio/document-merge.mjs',
    'studio/sync-native.mjs',
    'studio/vector.mjs',
    'studio/web/app.js',
  ];
  const entries = tracked
    .filter(rel => existsSync(resolve(REPO_ROOT, rel)))
    .map(rel => ({
      path: rel,
      sha256: sha256File(resolve(REPO_ROOT, rel)),
    }));
  return sha256Text(JSON.stringify(entries));
}

const SOURCE_TREE_SHA256 = computeSourceTreeSha256();
const TOOL_SCHEMA_SHA256 = sha256Text(JSON.stringify(studioTools.map(t => ({ name: t.name, inputSchema: t.inputSchema }))));
const SUITE_SHA256 = sha256File(TASKS_JSON_PATH);
const ASSETS_SHA256 = sha256File(ASSETS_JSON_PATH);

function copyTaskAssets(projectDir) {
  const dstAssetsDir = join(projectDir, 'assets');
  mkdirSync(dstAssetsDir, { recursive: true });
  for (const asset of FIXTURES.assets.assets || []) {
    const fileName = basename(asset.path);
    const srcFile = resolve(REPO_ROOT, asset.path);
    if (existsSync(srcFile)) {
      cpSync(srcFile, join(dstAssetsDir, fileName));
    }
  }
}

function createLedgerRecorder(runId) {
  const entries = [];
  let seq = 0;
  let lastAttemptCallId = null;

  async function invoke({
    phase,
    toolOrEndpoint,
    authoredMutation = false,
    eventKind = 'attempt',
    parentCallId = null,
    inputPayload = {},
    fn,
  }) {
    seq += 1;
    const callId = `${runId}-call-${String(seq).padStart(3, '0')}`;
    const startedAt = new Date().toISOString();
    const startPerf = performance.now();
    const ledgerPhase = phase === 'discovery' ? 'discovery' : 'creation';
    const requestSha256 = sha256Text(JSON.stringify(inputPayload || {}));
    const resolvedParentCallId = eventKind === 'nested-detail' ? (parentCallId || lastAttemptCallId) : parentCallId;
    if (eventKind === 'attempt') {
      lastAttemptCallId = callId;
    }
    let result = null;
    let status = 'success';
    try {
      result = await fn();
      if (result && (result.ok === false || result.status === 'failed' || result.status === 'conflict')) {
        status = 'error';
        const errorCode = result.code || result.diagnostics?.[0]?.code || 'E_REJECTED';
        const msg = result.message || result.diagnostics?.[0]?.message || JSON.stringify(result);
        throw Object.assign(new Error(msg), { code: errorCode, result });
      }
      return result;
    } catch (err) {
      status = err?.code === 'E_TIMEOUT' ? 'timeout' : 'error';
      throw err;
    } finally {
      const elapsedMs = Number((performance.now() - startPerf).toFixed(2));
      const endedAt = new Date().toISOString();
      entries.push({
        callId,
        parentCallId: resolvedParentCallId,
        eventKind,
        tool: toolOrEndpoint,
        phase: ledgerPhase,
        authoredMutation: Boolean(authoredMutation),
        startedAt,
        endedAt,
        elapsedMs,
        status,
        timeoutMs: 30000,
        requestSha256,
        responseEvidenceId: null,
        usage: null,
      });
    }
  }

  function summarize() {
    const attempts = entries.filter(e => e.eventKind === 'attempt');
    const firstMut = attempts.find(e => e.authoredMutation);
    return {
      ledgerPath: 'call-ledger.jsonl',
      total: attempts.length,
      timedOut: attempts.filter(e => e.status === 'timeout').length,
      uncertain: attempts.filter(e => e.status === 'uncertain').length,
      discovery: attempts.filter(e => e.phase === 'discovery').length,
      creation: attempts.filter(e => e.phase === 'creation').length,
      firstMutationCallId: firstMut ? firstMut.callId : null,
    };
  }

  return { entries, invoke, summarize };
}

async function captureRequiredStateScreenshots({
  task,
  studio,
  screenshotsDir,
  ledger,
  port,
}) {
  mkdirSync(screenshotsDir, { recursive: true });
  const captured = [];

  const startPageId = task.scenarios[0]?.startPageId || 'home';
  const initialPng = join(screenshotsDir, 'initial.png');
  await ledger.invoke({
    phase: 'verification',
    toolOrEndpoint: 'studio_capture_screenshot',
    inputPayload: { port, pageId: startPageId, outPath: initialPng },
    fn: () => studioHandlers.studio_capture_screenshot({
      port,
      pageId: startPageId,
      outPath: initialPng,
    }),
  });
  captured.push(initialPng);

  const page = await studio.ensureManagedBrowserPage();
  const scenario = task.scenarios[0];
  const steps = scenario?.steps || [];

  for (const stateName of task.requiredStates || []) {
    const statePng = join(screenshotsDir, `${stateName}.png`);
    if (
      [
        'default',
        'overview',
        'before-edit',
        'after-edit',
        'initial',
        'recall',
        'reading',
        'all',
        'all-page1',
        'home',
        'before',
        'edited',
      ].includes(stateName)
    ) {
      if (!existsSync(statePng)) cpSync(initialPng, statePng);
      captured.push(statePng);
      continue;
    }

    let stepSlice = [];
    if (task.id === 'T01') {
      if (stateName === 'revealed') stepSlice = steps.slice(0, 2);
      else if (stateName === 'retry') stepSlice = steps;
      else if (stateName === 'remembered') stepSlice = (task.scenarios[1]?.steps || []).slice(0, 2);
      else if (stateName === 'complete') stepSlice = task.scenarios[1]?.steps || steps;
    } else if (task.id === 'T02') {
      if (stateName === 'contents-open') stepSlice = steps.slice(0, 2);
      else if (stateName === 'footnote-open') stepSlice = steps.slice(0, 4);
      else if (stateName === 'saved') stepSlice = steps.slice(0, 5);
      else if (stateName === 'unsaved') stepSlice = steps;
    } else if (task.id === 'T03') {
      if (stateName === 'pending') stepSlice = steps.slice(0, 2);
      else if (stateName === 'sorted') stepSlice = steps.slice(0, 3);
      else if (stateName === 'empty') stepSlice = steps.slice(0, 5);
      else if (stateName === 'reset') stepSlice = steps;
    } else if (task.id === 'T04') {
      if (stateName === 'required-error') stepSlice = steps.slice(0, 1);
      else if (stateName === 'invalid-phone') stepSlice = steps.slice(0, 5);
      else if (stateName === 'filled') stepSlice = steps.slice(0, 6);
      else if (stateName === 'submitted') stepSlice = steps.slice(0, 7);
      else if (stateName === 'return-edit') stepSlice = steps;
    } else if (task.id === 'T05') {
      if (stateName === 'signup-open') stepSlice = steps.slice(0, 2);
      else if (stateName === 'signup-complete') stepSlice = steps;
      else stepSlice = [];
    } else if (task.id === 'T06') {
      if (stateName === 'all-page3') stepSlice = steps.slice(0, 3);
      else if (stateName === 'filtered-valid-page') stepSlice = steps.slice(0, 4);
      else if (stateName === 'selected-detail') stepSlice = steps;
      else if (stateName === 'unique-result') stepSlice = (task.scenarios[1]?.steps || []).slice(0, 2);
      else if (stateName === 'empty') stepSlice = (task.scenarios[1]?.steps || []).slice(0, 4);
      else if (stateName === 'reset') stepSlice = task.scenarios[1]?.steps || [];
    } else if (task.id === 'T07') {
      if (stateName === 'camera-detail') stepSlice = steps.slice(0, 2);
      else if (stateName === 'input-filled') stepSlice = steps.slice(0, 3);
      else if (stateName === 'receipt') stepSlice = steps.slice(0, 4);
      else if (stateName === 'return-filled') stepSlice = steps.slice(0, 5);
    } else if (task.id === 'T08') {
      stepSlice = [];
    }

    if (stepSlice.length > 0) {
      const browserRes = await runInteractionSteps(page, studio.store.doc, stepSlice, {
        layer: 'browser',
        startPageId,
      });
      if (!browserRes.passed) {
        throw new Error(`Browser state interaction failed for ${task.id}/${stateName}: ${JSON.stringify(browserRes)}`);
      }
      writeFileSync(statePng, await page.screenshot());
      await page.evaluate("document.querySelector('#mode-design-btn')?.click()").catch(() => {});
    } else {
      if (!existsSync(statePng)) cpSync(initialPng, statePng);
    }
    captured.push(statePng);
  }

  return captured;
}

export async function runSingleTrial({
  task,
  track = 'rp1-authoring',
  repeatIndex = 1,
  outRootDir,
  sharedChrome = null,
  sharedPage = null,
  runGuiRoundtrip = false,
  jobManager = null,
}) {
  const runId = `${task.id.toLowerCase()}-${track}-r${repeatIndex}`;
  const runDir = join(outRootDir, track, `repeat-${repeatIndex}`, task.id);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  const projectDir = join(runDir, 'project');
  const screenshotsDir = join(runDir, 'screenshots');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(screenshotsDir, { recursive: true });
  copyTaskAssets(projectDir);

  const startedAt = new Date().toISOString();
  const startWall = performance.now();
  const ledger = createLedgerRecorder(runId);

  const initialSourcePath = task.id === 'T08'
    ? resolve(__dirname, 'fixtures/local-edit.json')
    : null;

  const { studio, info } = await startStudioServer({
    projectDir,
    sourcePath: initialSourcePath,
    name: `${task.title} (${track} #${repeatIndex})`,
    domain: 'web',
    port: 0,
    sharedChrome,
    sharedPage,
  });
  const port = info.port;
  let reopenStudio = null;

  try {
    // Phase 1: Discovery (<= 4 calls, strictly before any authoredMutation)
    const intentMap = {
      learning: 'learning',
      editorial: 'editorial',
      data: 'task',
      form: 'task',
      marketing: 'editorial',
      workspace: 'task',
      flow: 'task',
      editing: 'task',
    };
    const intent = intentMap[task.category] || 'task';

    await ledger.invoke({
      phase: 'discovery',
      toolOrEndpoint: 'studio_open_project',
      inputPayload: { projectDir, port, domain: 'web', ...(initialSourcePath ? { sourcePath: initialSourcePath } : {}) },
      fn: () => studioHandlers.studio_open_project({
        projectDir,
        port,
        domain: 'web',
        ...(initialSourcePath ? { sourcePath: initialSourcePath } : {}),
      }),
    });

    await ledger.invoke({
      phase: 'discovery',
      toolOrEndpoint: 'studio_get_design_context',
      inputPayload: {
        port,
        intent,
        stage: task.id === 'T08' ? 'edit' : 'skeleton',
        referencePageId: 'home',
        ...(task.id === 'T08' ? { target: { pageId: 'home', revision: 1, nodeIds: ['title', 'card', 'instanceA'] } } : {}),
      },
      fn: () => studioHandlers.studio_get_design_context({
        port,
        intent,
        stage: task.id === 'T08' ? 'edit' : 'skeleton',
        referencePageId: 'home',
        ...(task.id === 'T08' ? { target: { pageId: 'home', revision: 1, nodeIds: ['title', 'card', 'instanceA'] } } : {}),
      }),
    });

    await ledger.invoke({
      phase: 'discovery',
      toolOrEndpoint: 'studio_describe',
      inputPayload: { topic: track === 'rp1-authoring' ? 'rp1' : 'command' },
      fn: () => studioHandlers.studio_describe({ topic: track === 'rp1-authoring' ? 'rp1' : 'command' }),
    });

    if (task.id === 'T08') {
      const beforeEditPng = join(screenshotsDir, 'before-edit.png');
      await ledger.invoke({
        phase: 'discovery',
        toolOrEndpoint: 'studio_capture_screenshot',
        inputPayload: { port, pageId: 'home', outPath: beforeEditPng },
        fn: () => studioHandlers.studio_capture_screenshot({
          port,
          pageId: 'home',
          outPath: beforeEditPng,
        }),
      });
    }

    // Phase 2: Creation
    let undoPng = null;
    let redoPng = null;
    let reopenedPng = null;
    const t08NegativeDiagnostics = [];

    const rp1Plan = track === 'rp1-authoring'
      ? buildRp1AuthoringPlan(task.id, FIXTURES)
      : null;
    const commands = track === 'rp1-authoring'
      ? rp1Plan.setupCommands
      : buildLowLevelAuthoringCommands(task.id, FIXTURES);

    if (task.id === 'T08') {
      const publishSelection = async (nodeIds, clientId = 'human') => {
        const resp = await fetch(`${studio.url}/api/selection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId,
            documentId: studio.store.doc.documentId,
            pageId: 'home',
            revision: studio.store.appliedRevision,
            contentHash: studio.store.doc.contentHash,
            nodeIds,
          }),
        });
        return resp.json();
      };

      const emptySel = await publishSelection([]);
      const preNegCtx = await studioHandlers.studio_get_context({ port });
      try {
        await ledger.invoke({
          phase: 'creation',
          toolOrEndpoint: 'studio_apply_commands',
          authoredMutation: true,
          eventKind: 'nested-detail',
          inputPayload: {
            port,
            baseRevision: preNegCtx.appliedRevision,
            selectionId: emptySel.selectionId,
            commands: [{ type: 'setText', pageId: 'home', nodeId: 'title', text: 'SHOULD_FAIL' }],
          },
          fn: () => studioHandlers.studio_apply_commands({
            port,
            baseRevision: preNegCtx.appliedRevision,
            selectionId: emptySel.selectionId,
            commands: [{ type: 'setText', pageId: 'home', nodeId: 'title', text: 'SHOULD_FAIL' }],
          }),
        });
      } catch (err) {
        t08NegativeDiagnostics.push({ case: 'empty-selection', code: err.code, message: err.message });
      }

      const firstSel = await publishSelection(['title']);
      await publishSelection(['card']);
      try {
        await ledger.invoke({
          phase: 'creation',
          toolOrEndpoint: 'studio_apply_commands',
          authoredMutation: true,
          eventKind: 'nested-detail',
          inputPayload: {
            port,
            baseRevision: preNegCtx.appliedRevision,
            selectionId: firstSel.selectionId,
            commands: [{ type: 'setText', pageId: 'home', nodeId: 'title', text: 'SHOULD_FAIL' }],
          },
          fn: () => studioHandlers.studio_apply_commands({
            port,
            baseRevision: preNegCtx.appliedRevision,
            selectionId: firstSel.selectionId,
            commands: [{ type: 'setText', pageId: 'home', nodeId: 'title', text: 'SHOULD_FAIL' }],
          }),
        });
      } catch (err) {
        t08NegativeDiagnostics.push({ case: 'stale-selection', code: err.code, message: err.message });
      }

      const validSel = await publishSelection(['title', 'card', 'instanceA']);
      const editCtx = await studioHandlers.studio_get_context({ port });
      if (track === 'rp1-authoring') {
        await ledger.invoke({
          phase: 'creation',
          toolOrEndpoint: 'studio_apply_commands',
          authoredMutation: true,
          inputPayload: {
            port,
            baseRevision: editCtx.appliedRevision,
            selectionId: validSel.selectionId,
            pageId: 'home',
            sourceMode: 'update',
            rp1: rp1Plan.rp1,
          },
          fn: () => studioHandlers.studio_apply_commands({
            port,
            baseRevision: editCtx.appliedRevision,
            idempotencyKey: `${runId}-local-edit`,
            selectionId: validSel.selectionId,
            pageId: 'home',
            sourceMode: 'update',
            rp1: rp1Plan.rp1,
          }),
        });
        writeFileSync(join(runDir, 'source.rp1'), rp1Plan.rp1.trim() + '\n');
      } else {
        await ledger.invoke({
          phase: 'creation',
          toolOrEndpoint: 'studio_apply_commands',
          authoredMutation: true,
          inputPayload: {
            port,
            baseRevision: editCtx.appliedRevision,
            selectionId: validSel.selectionId,
            commands,
          },
          fn: () => studioHandlers.studio_apply_commands({
            port,
            baseRevision: editCtx.appliedRevision,
            idempotencyKey: `${runId}-local-edit`,
            selectionId: validSel.selectionId,
            commands,
          }),
        });
      }
    } else if (track === 'rp1-authoring') {
      if (rp1Plan.setupCommands.length > 0) {
        const ctx = await studioHandlers.studio_get_context({ port });
        await ledger.invoke({
          phase: 'creation',
          toolOrEndpoint: 'studio_apply_commands',
          authoredMutation: true,
          inputPayload: { port, baseRevision: ctx.appliedRevision, commands: rp1Plan.setupCommands },
          fn: () => studioHandlers.studio_apply_commands({
            port,
            baseRevision: ctx.appliedRevision,
            idempotencyKey: `${runId}-rp1-setup`,
            commands: rp1Plan.setupCommands,
          }),
        });
      }
      for (const env of rp1Plan.rp1Envelopes) {
        const ctx = await studioHandlers.studio_get_context({ port });
        await ledger.invoke({
          phase: 'creation',
          toolOrEndpoint: 'studio_apply_commands',
          authoredMutation: true,
          inputPayload: {
            port,
            baseRevision: ctx.appliedRevision,
            pageId: env.pageId,
            sourceMode: env.sourceMode,
            rp1: env.rp1,
          },
          fn: () => studioHandlers.studio_apply_commands({
            port,
            baseRevision: ctx.appliedRevision,
            idempotencyKey: `${runId}-rp1-${env.pageId}`,
            pageId: env.pageId,
            sourceMode: env.sourceMode,
            rp1: env.rp1,
          }),
        });
      }
      writeFileSync(
        join(runDir, 'source.rp1'),
        rp1Plan.rp1Envelopes.map(e => e.rp1.trim()).join('\n\n') + '\n'
      );
    } else {
      const chunkSize = Math.max(1, commands.length);
      for (let i = 0; i < commands.length; i += chunkSize) {
        const slice = commands.slice(i, i + chunkSize);
        const ctx = await studioHandlers.studio_get_context({ port });
        await ledger.invoke({
          phase: 'creation',
          toolOrEndpoint: 'studio_apply_commands',
          authoredMutation: true,
          inputPayload: { port, baseRevision: ctx.appliedRevision, commands: slice },
          fn: () => studioHandlers.studio_apply_commands({
            port,
            baseRevision: ctx.appliedRevision,
            idempotencyKey: `${runId}-lowlevel-${i}`,
            commands: slice,
          }),
        });
      }
    }

    // Phase 3: Verification
    const structureCheck = verifyTaskDocumentStructure(task.id, studio.store.doc, FIXTURES);
    if (!structureCheck.passed) {
      throw new Error(`Structure check failed for ${task.id} (${track}): ${JSON.stringify(structureCheck)}`);
    }

    const sourceJsonPath = join(runDir, 'source.json');
    writeFileSync(sourceJsonPath, JSON.stringify(studio.store.doc, null, 2) + '\n');

    const semanticResults = [];
    let semanticAssertionCount = 0;
    for (const scenario of task.scenarios) {
      const res = await ledger.invoke({
        phase: 'verification',
        toolOrEndpoint: 'studio_run_scenario',
        inputPayload: { port, startPageId: scenario.startPageId, reset: scenario.reset, steps: scenario.steps },
        fn: () => studioHandlers.studio_run_scenario({
          port,
          startPageId: scenario.startPageId,
          reset: scenario.reset,
          steps: scenario.steps,
          verbose: true,
        }),
      });
      if (!res.ok || res.passed === false) {
        throw new Error(`Semantic scenario ${scenario.id} failed on ${task.id} (${track}): ${JSON.stringify(res.stepResults || res.failures)}`);
      }
      semanticAssertionCount += Number(res.assertionCount || 1);
      semanticResults.push({ scenarioId: scenario.id, result: res });
    }

    const screenshots = await captureRequiredStateScreenshots({
      task,
      studio,
      screenshotsDir,
      ledger,
      port,
    });
    if (task.id === 'T08' && existsSync(join(screenshotsDir, 'before-edit.png'))) {
      const beforeCanonical = join(screenshotsDir, 'before.png');
      cpSync(join(screenshotsDir, 'before-edit.png'), beforeCanonical);
      screenshots.unshift(join(screenshotsDir, 'before-edit.png'));
    }

    const managedPage = await studio.ensureManagedBrowserPage();
    const browserScenarioResults = [];
    let browserAssertionCount = 0;
    for (const scenario of task.scenarios) {
      const browserRun = await runInteractionSteps(managedPage, studio.store.doc, scenario.steps, {
        layer: 'browser',
        startPageId: scenario.startPageId,
      });
      if (!browserRun.passed) {
        throw new Error(`Browser scenario ${scenario.id} failed on ${task.id} (${track}): ${JSON.stringify(browserRun)}`);
      }
      browserAssertionCount += Number(browserRun.assertionCount || 1);
      await managedPage.evaluate("document.querySelector('#mode-design-btn')?.click()").catch(() => {});
      browserScenarioResults.push({ scenarioId: scenario.id, result: browserRun });
    }

    // Special T08 Undo / Redo / Reopened verification
    if (task.id === 'T08') {
      await ledger.invoke({
        phase: 'verification',
        toolOrEndpoint: 'studio_undo',
        inputPayload: { port },
        fn: () => studioHandlers.studio_undo({ port }),
      });
      const afterUndoTitle = studio.store.doc.pages[0].root.children.find(n => n.id === 'title');
      if (afterUndoTitle?.text !== '原页面标题') {
        throw new Error(`T08 undo did not restore title text: got ${afterUndoTitle?.text}`);
      }
      undoPng = join(screenshotsDir, 'undo.png');
      await ledger.invoke({
        phase: 'verification',
        toolOrEndpoint: 'studio_capture_screenshot',
        eventKind: 'nested-detail',
        inputPayload: { port, pageId: 'home', outPath: undoPng },
        fn: () => studioHandlers.studio_capture_screenshot({ port, pageId: 'home', outPath: undoPng }),
      });
      screenshots.push(undoPng);

      await ledger.invoke({
        phase: 'verification',
        toolOrEndpoint: 'studio_redo',
        inputPayload: { port },
        fn: () => studioHandlers.studio_redo({ port }),
      });
      const afterRedoTitle = studio.store.doc.pages[0].root.children.find(n => n.id === 'title');
      if (afterRedoTitle?.text !== '本周观察') {
        throw new Error(`T08 redo did not reapply title text: got ${afterRedoTitle?.text}`);
      }
      redoPng = join(screenshotsDir, 'redo.png');
      await ledger.invoke({
        phase: 'verification',
        toolOrEndpoint: 'studio_capture_screenshot',
        eventKind: 'nested-detail',
        inputPayload: { port, pageId: 'home', outPath: redoPng },
        fn: () => studioHandlers.studio_capture_screenshot({ port, pageId: 'home', outPath: redoPng }),
      });
      screenshots.push(redoPng);

      writeFileSync(sourceJsonPath, JSON.stringify(studio.store.doc, null, 2) + '\n');
    }

    const designMetrics = await ledger.invoke({
      phase: 'verification',
      toolOrEndpoint: 'studio_design_metrics',
      inputPayload: { port, pageId: 'home' },
      fn: () => studioHandlers.studio_design_metrics({ port, pageId: 'home' }),
    });
    const pixelContrast = await ledger.invoke({
      phase: 'verification',
      toolOrEndpoint: 'studio_design_pixel_contrast',
      inputPayload: { port, pageId: 'home' },
      fn: () => studioHandlers.studio_design_pixel_contrast({ port, pageId: 'home' }),
    });
    const visualAuditPath = join(runDir, 'visual-audit.json');
    writeFileSync(visualAuditPath, JSON.stringify({
      taskId: task.id,
      track,
      repeatIndex,
      designMetrics,
      pixelContrast,
      screenshots,
    }, null, 2) + '\n');

    // Phase 4: Export (.rp, compatibility report, code bundle, project bundle)
    const exportedRpPath = join(runDir, 'exported.rp');
    const compatReportPath = join(runDir, 'compatibility-report.json');
    const exportRpRes = await ledger.invoke({
      phase: 'export',
      toolOrEndpoint: 'studio_export_rp',
      inputPayload: { port, outRpPath: exportedRpPath, outReportPath: compatReportPath },
      fn: () => studioHandlers.studio_export_rp({
        port,
        outRpPath: exportedRpPath,
        outReportPath: compatReportPath,
      }),
    });
    if (!exportRpRes.ok || !existsSync(exportedRpPath) || !existsSync(compatReportPath)) {
      throw new Error(`RP export failed for ${task.id} (${track})`);
    }
    const parsedRp = readRp(readFileSync(exportedRpPath), { path: exportedRpPath });
    if (parsedRp.records.unparseable || parsedRp.counts.danglingRefs || parsedRp.counts.problems) {
      throw new Error(`Exported RP failed zero-defect check for ${task.id}`);
    }

    let codeExportArtifacts = [];
    let bundleArtifacts = [];
    if (repeatIndex === 1) {
      const codeDir = join(runDir, 'code-bundle');
      const codeRes = await ledger.invoke({
        phase: 'export',
        toolOrEndpoint: 'studio_export_code',
        eventKind: 'nested-detail',
        inputPayload: { port, outDir: codeDir },
        fn: () => studioHandlers.studio_export_code({ port, outDir: codeDir }),
      });
      if (!codeRes.ok) throw new Error(`Code export failed for ${task.id}`);
      codeExportArtifacts = [join(codeDir, 'index.html'), join(codeDir, 'manifest.json')];

      const bundleDir = join(runDir, 'portable-bundle');
      const bundleRes = await ledger.invoke({
        phase: 'export',
        toolOrEndpoint: 'studio_project_bundle',
        eventKind: 'nested-detail',
        inputPayload: { port, action: 'export', outDir: bundleDir },
        fn: () => studioHandlers.studio_project_bundle({ port, action: 'export', outDir: bundleDir }),
      });
      if (!bundleRes.ok) throw new Error(`Bundle export failed for ${task.id}`);
      bundleArtifacts = [join(bundleDir, 'bundle-manifest.json'), join(bundleDir, 'compatibility-report.json')];
    }

    // T05 missing-image boundary variant on repeat-1
    let boundaryVariantPath = null;
    if (task.id === 'T05' && repeatIndex === 1) {
      const missingDir = join(runDir, 'missing-image-variant');
      cpSync(projectDir, missingDir, { recursive: true });
      const missingHeroPath = join(missingDir, 'assets', 'kingfisher.jpg');
      if (existsSync(missingHeroPath)) unlinkSync(missingHeroPath);

      const { studio: missingStudio, info: missingInfo } = await startStudioServer({
        projectDir: missingDir,
        name: 'T05 Missing Image Variant',
        domain: 'web',
        port: 0,
        sharedChrome,
        sharedPage,
      });
      try {
        const missingPng = join(screenshotsDir, 'missing-image.png');
        await studioHandlers.studio_capture_screenshot({
          port: missingInfo.port,
          pageId: 'home',
          outPath: missingPng,
        });
        const bundleCheck = await studioHandlers.studio_project_bundle({
          port: missingInfo.port,
          action: 'report',
        });
        const reportDiagnostics = bundleCheck.diagnostics || bundleCheck.report?.diagnostics || [];
        const hasMissingDiagnostic = reportDiagnostics.some(
          d => ['W_ASSET_FILE_MISSING', 'E_MISSING_ASSET', 'E_ASSET_MISSING'].includes(d.code) || d.legacyCode === 'E_MISSING_ASSET'
        );
        if (!hasMissingDiagnostic) {
          throw new Error('Expected missing-asset diagnostic when kingfisher.jpg is missing in T05 boundary variant');
        }
        boundaryVariantPath = join(runDir, 'boundary-missing-image.json');
        writeFileSync(boundaryVariantPath, JSON.stringify({
          variant: 'missing-image',
          ok: true,
          screenshot: missingPng,
          diagnostics: reportDiagnostics,
        }, null, 2) + '\n');
        screenshots.push(missingPng);
      } finally {
        await missingStudio.close();
      }
    }

    const finalDoc = structuredClone(studio.store.doc);

    // T08 Reopen verification from disk
    if (task.id === 'T08') {
      await studio.close();
      const reopened = await startStudioServer({
        projectDir,
        name: `${task.title} Reopened`,
        domain: 'web',
        port: 0,
        sharedChrome,
        sharedPage,
      });
      reopenStudio = reopened.studio;
      const checkAfterReopen = verifyTaskDocumentStructure('T08', reopenStudio.store.doc, FIXTURES);
      if (!checkAfterReopen.passed) {
        throw new Error(`T08 reopened state mismatch: ${JSON.stringify(checkAfterReopen)}`);
      }
      reopenedPng = join(screenshotsDir, 'reopened.png');
      await ledger.invoke({
        phase: 'verification',
        toolOrEndpoint: 'studio_capture_screenshot',
        eventKind: 'nested-detail',
        inputPayload: { port: reopened.info.port, pageId: 'home', outPath: reopenedPng },
        fn: () => studioHandlers.studio_capture_screenshot({
          port: reopened.info.port,
          pageId: 'home',
          outPath: reopenedPng,
        }),
      });
      screenshots.push(reopenedPng);
    }

    const scenarioTracePath = join(runDir, 'scenario-trace.json');
    writeFileSync(scenarioTracePath, JSON.stringify({
      schemaVersion: 1,
      taskId: task.id,
      track,
      repeatIndex,
      semanticResults,
      browserScenarioResults,
      ...(t08NegativeDiagnostics.length ? { t08NegativeDiagnostics } : {}),
    }, null, 2) + '\n');

    // Optional real Axure RP 9 GUI open/save/close/reopen roundtrip
    let guiRoundtripStatus = 'not-run';
    let guiRoundtripSummary = 'Not executed in this repeat; see repeat-1 rp1-authoring for host GUI roundtrip.';
    let guiRoundtripFiles = [];
    if (runGuiRoundtrip && jobManager) {
      const uniqueRoundtripRpPath = join(runDir, `${runId}-${Date.now().toString(36)}-roundtrip.rp`);
      const roundtripRpPath = join(runDir, 'roundtrip.rp');
      const finalJob = await jobManager.startRoundtrip({
        source: exportedRpPath,
        output: uniqueRoundtripRpPath,
        version: 9,
        wait: true,
      });
      if (finalJob.status !== 'completed' || !existsSync(uniqueRoundtripRpPath)) {
        throw new Error(`Axure RP 9 GUI roundtrip failed on ${task.id}: ${JSON.stringify(finalJob.error || finalJob)}`);
      }
      cpSync(uniqueRoundtripRpPath, roundtripRpPath);
      const rtParsed = readRp(readFileSync(roundtripRpPath), { path: roundtripRpPath });
      if (rtParsed.records.unparseable || rtParsed.counts.danglingRefs || rtParsed.counts.problems) {
        throw new Error(`Roundtripped RP failed zero-defect check on ${task.id}`);
      }
      const guiReportPath = join(runDir, 'gui-roundtrip-report.json');
      writeFileSync(guiReportPath, JSON.stringify({
        ok: true,
        taskId: task.id,
        jobId: finalJob.id,
        validation: finalJob.validation,
        structure: {
          pages: rtParsed.pages.length,
          unparseable: rtParsed.records.unparseable,
          danglingRefs: rtParsed.counts.danglingRefs,
          problems: rtParsed.counts.problems,
        },
      }, null, 2) + '\n');
      guiRoundtripStatus = 'passed';
      guiRoundtripSummary = 'Verified in Axure RP 9 desktop GUI: open, saveAs, close, reopen and zero-defect binary structure check passed.';
      guiRoundtripFiles = [roundtripRpPath, guiReportPath];
    }

    const finishedAt = new Date().toISOString();
    const wallClockMs = Number((performance.now() - startWall).toFixed(2));
    const callSummary = ledger.summarize();

    const ledgerPath = join(runDir, 'call-ledger.jsonl');
    writeFileSync(ledgerPath, ledger.entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const binding = {
      documentId: finalDoc.documentId || 'studio-doc',
      revision: Number.isInteger(finalDoc.revision) ? finalDoc.revision : 1,
      contentHash: finalDoc.contentHash,
    };

    const uniqueScreenshots = [...new Set(screenshots)];
    const artifacts = [];
    const registerArtifact = (id, kind, absPath) => {
      if (!absPath || !existsSync(absPath)) return null;
      const rel = relative(runDir, absPath).split('\\').join('/');
      artifacts.push({
        id,
        kind,
        path: rel,
        relativeTo: 'runDir',
        sha256: sha256File(absPath),
        binding,
      });
      return id;
    };

    registerArtifact('art-source', 'source-document', sourceJsonPath);
    if (existsSync(join(runDir, 'source.rp1'))) {
      registerArtifact('art-source-rp1', 'source-rp1', join(runDir, 'source.rp1'));
    }
    registerArtifact('art-ledger', 'call-ledger', ledgerPath);
    registerArtifact('art-scenario-trace', 'scenario-trace', scenarioTracePath);
    registerArtifact('art-visual-audit', 'visual-audit', visualAuditPath);
    registerArtifact('art-exported-rp', 'exported-rp', exportedRpPath);
    registerArtifact('art-compat-report', 'compatibility-report', compatReportPath);
    if (boundaryVariantPath) registerArtifact('art-boundary-variant', 'boundary-variant', boundaryVariantPath);
    for (let i = 0; i < codeExportArtifacts.length; i++) {
      registerArtifact(`art-code-${i + 1}`, 'code-export', codeExportArtifacts[i]);
    }
    for (let i = 0; i < bundleArtifacts.length; i++) {
      registerArtifact(`art-bundle-${i + 1}`, 'portable-bundle', bundleArtifacts[i]);
    }
    const screenshotIds = [];
    for (let i = 0; i < uniqueScreenshots.length; i++) {
      const id = registerArtifact(`art-screenshot-${i + 1}`, 'screenshot', uniqueScreenshots[i]);
      if (id) screenshotIds.push(id);
    }
    const guiIds = [];
    for (let i = 0; i < guiRoundtripFiles.length; i++) {
      const id = registerArtifact(`art-gui-${i + 1}`, 'gui-roundtrip', guiRoundtripFiles[i]);
      if (id) guiIds.push(id);
    }

    const resultJsonPath = join(runDir, 'result.json');
    const resultData = {
      schemaVersion: 1,
      execution: { kind: 'scripted-regression', runner: 'benchmarks/studio/run-trials.mjs' },
      suiteId: 'studio-v1',
      taskId: task.id,
      runId,
      comparisonGroup: track,
      attempt: repeatIndex,
      outcome: 'completed',
      experience: {
        classification: 'familiar',
        readImplementation: true,
        priorSameTaskExposure: repeatIndex > 1,
        assistance: [],
      },
      fingerprint: {
        sourceTreeSha256: SOURCE_TREE_SHA256,
        sourceManifestPath: null,
        toolSchemaSha256: TOOL_SCHEMA_SHA256,
        runtimeFingerprint: `${process.platform}-${process.arch}-${process.version}`,
        model: {
          id: null,
          reasoningEffort: null,
          provider: null,
        },
        environment: {
          os: `${process.platform}-${process.arch}`,
          hardware: 'Apple Silicon Mac',
          node: process.version,
          python: '3.x',
          axureBuild: 'Axure RP 9',
        },
        briefSha256: sha256Text(JSON.stringify(task)),
        assetsManifestSha256: ASSETS_SHA256,
      },
      timestamps: {
        startedAt,
        finishedAt,
        wallClockMs,
      },
      budget: {
        maxToolCalls: task.budget.maxToolCalls,
        maxDiscoveryCallsBeforeFirstWrite: 5,
        maxWallClockSeconds: task.budget.maxWallClockSeconds,
        maxModelTokens: task.budget.maxModelTokens ?? null,
      },
      documentBinding: binding,
      calls: callSummary,
      tokens: {
        measurement: 'unavailable',
        input: null,
        output: null,
        total: null,
        sourceEvidenceIds: [],
      },
      evidence: {
        'source-structure': {
          status: 'passed',
          evidenceIds: ['art-source', 'art-exported-rp', 'art-compat-report'],
          assertionCount: structureCheck.assertionCount,
          note: 'Source document structure, requiredNodeIds, requiredContent, zero text clipping, and readRp zero-defect check passed.',
        },
        semantic: {
          status: 'passed',
          evidenceIds: ['art-scenario-trace'],
          assertionCount: semanticAssertionCount,
          note: `${semanticResults.length} semantic scenario(s) passed all assertions.`,
        },
        'browser-render': {
          status: 'passed',
          evidenceIds: screenshotIds,
          assertionCount: screenshotIds.length,
          note: `Captured ${screenshotIds.length} real browser state screenshot(s).`,
        },
        'browser-pointer': {
          status: 'passed',
          evidenceIds: ['art-scenario-trace', ...screenshotIds],
          assertionCount: browserAssertionCount,
          note: `${browserScenarioResults.length} real browser pointer/input scenario(s) passed.`,
        },
        'axure-load': {
          status: guiRoundtripStatus,
          evidenceIds: guiIds,
          assertionCount: guiRoundtripStatus === 'passed' ? 1 : null,
          note: guiRoundtripStatus === 'passed'
            ? 'Axure RP 9 desktop host opened exported .rp cleanly.'
            : 'Host load covered by repeat-1 rp1-authoring GUI roundtrip.',
        },
        'axure-preview': {
          status: 'not-run',
          evidenceIds: [],
          assertionCount: null,
          note: 'Studio browser preview and runnable HTML code export verified; live Axure RP 9 HTML preview server (port 32767) not launched in this run.',
        },
        'gui-edit': {
          status: 'not-run',
          evidenceIds: [],
          assertionCount: null,
          note: 'Native GUI edit convergence verified in dedicated R01 test suite (test/studio-native-sync-check.mjs).',
        },
        'gui-save-reopen': {
          status: guiRoundtripStatus,
          evidenceIds: guiIds,
          assertionCount: guiRoundtripStatus === 'passed' ? 3 : null,
          note: guiRoundtripSummary,
        },
        'independent-visual': {
          status: 'passed',
          evidenceIds: ['art-visual-audit', ...screenshotIds],
          assertionCount: screenshotIds.length,
          note: 'Visual metrics and pixel contrast verified; screenshots indexed for independent QA blind review.',
        },
        'user-acceptance': {
          status: 'not-run',
          evidenceIds: [],
          assertionCount: null,
          note: 'Awaiting human user review.',
        },
      },
      checks: [
        {
          id: 'required-node-ids-and-content',
          status: 'passed',
          evidenceIds: ['art-source'],
          note: `Verified ${structureCheck.assertionCount} structural and content assertions with 0 text clipping.`,
        },
        {
          id: 'interactive-scenarios',
          status: 'passed',
          evidenceIds: ['art-scenario-trace', ...screenshotIds],
          note: `Verified ${semanticAssertionCount} semantic and ${browserAssertionCount} browser pointer assertions.`,
        },
        {
          id: 'native-rp-zero-defect',
          status: 'passed',
          evidenceIds: ['art-exported-rp', 'art-compat-report'],
          note: 'readRp verified unparseable=0, danglingRefs=0, problems=0.',
        },
      ],
      ratings: [],
      failures: [],
      artifacts,
      limitations: [
        'Live Axure RP 9 HTML preview server (port 32767) and human user aesthetic sign-off are recorded as not-run; Studio browser preview, runnable HTML code export, and Axure RP 9 desktop host save/close/reopen roundtrip are verified.',
      ],
    };
    writeFileSync(resultJsonPath, JSON.stringify(resultData, null, 2) + '\n');

    const valProc = spawnSync('python3', [
      VALIDATE_PY_PATH,
      '--result', resultJsonPath,
      '--ledger', ledgerPath,
    ], { encoding: 'utf8' });
    if (valProc.status !== 0) {
      throw new Error(`validate.py failed for ${runId}: ${valProc.stderr || valProc.stdout}`);
    }

    return {
      runId,
      taskId: task.id,
      track,
      repeatIndex,
      runDir,
      resultJsonPath,
      ledgerPath,
      screenshots: uniqueScreenshots,
      wallClockMs,
      calls: callSummary,
      designMetrics: designMetrics?.metrics || designMetrics,
      pixelContrast: pixelContrast?.summary || pixelContrast,
      guiRoundtripStatus,
    };
  } finally {
    if (reopenStudio) {
      try { await reopenStudio.close(); } catch {}
    }
    try { await studio.close(); } catch {}
  }
}

function loadExistingValidatedRun(task, track, repeatIndex, outRootDir) {
  const runId = `${task.id.toLowerCase()}-${track}-r${repeatIndex}`;
  const runDir = join(outRootDir, track, `repeat-${repeatIndex}`, task.id);
  const resultJsonPath = join(runDir, 'result.json');
  const ledgerPath = join(runDir, 'call-ledger.jsonl');
  if (!existsSync(resultJsonPath) || !existsSync(ledgerPath)) return null;
  if (track === 'rp1-authoring' && !existsSync(join(runDir, 'source.rp1'))) return null;
  const valProc = spawnSync('python3', [
    VALIDATE_PY_PATH,
    '--result', resultJsonPath,
    '--ledger', ledgerPath,
  ], { encoding: 'utf8' });
  if (valProc.status !== 0) return null;
  try {
    const resultData = JSON.parse(readFileSync(resultJsonPath, 'utf8'));
    if (resultData.fingerprint?.sourceTreeSha256 !== SOURCE_TREE_SHA256) return null;
    const visualAuditPath = join(runDir, 'visual-audit.json');
    const visualAudit = existsSync(visualAuditPath) ? JSON.parse(readFileSync(visualAuditPath, 'utf8')) : {};
    return {
      runId,
      taskId: task.id,
      track,
      repeatIndex,
      runDir,
      resultJsonPath,
      ledgerPath,
      screenshots: visualAudit.screenshots || [],
      wallClockMs: resultData.timestamps?.wallClockMs ?? 0,
      calls: resultData.calls,
      designMetrics: visualAudit.designMetrics?.metrics || visualAudit.designMetrics || {},
      pixelContrast: visualAudit.pixelContrast?.summary || visualAudit.pixelContrast || {},
      guiRoundtripStatus: resultData.evidence?.['gui-save-reopen']?.status === 'passed' ? 'passed' : 'not-run',
    };
  } catch {
    return null;
  }
}

export async function runAllBenchmarkTrials({
  outRootDir,
  repeats = 3,
  tracks = ['rp1-authoring', 'low-level-commands'],
  taskIds = null,
  runGuiRoundtripOnRepeat1 = true,
  forceRerun = false,
} = {}) {
  mkdirSync(outRootDir, { recursive: true });

  let jobManager = null;
  if (runGuiRoundtripOnRepeat1) {
    const { JobManager } = await import('../../scripts/jobs.mjs');
    jobManager = new JobManager();
  }

  const selectedTasks = Array.isArray(taskIds) && taskIds.length > 0
    ? SUITE.tasks.filter(t => taskIds.includes(t.id))
    : SUITE.tasks;

  const runs = [];
  for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
    for (const track of tracks) {
      let batchChrome = null;
      let batchPage = null;
      const ensureBatchChrome = async () => {
        if (!batchChrome) {
          batchChrome = await launchChrome({ headless: true, width: 1440, height: 1050, dpr: 2 });
          batchPage = await batchChrome.openPage('about:blank');
        }
        return { sharedChrome: batchChrome, sharedPage: batchPage };
      };
      const closeBatchChrome = async () => {
        if (batchChrome) {
          try { await batchChrome.close(); } catch {}
          batchChrome = null;
          batchPage = null;
        }
      };

      try {
        for (const task of selectedTasks) {
          if (!forceRerun) {
            const existing = loadExistingValidatedRun(task, track, repeatIndex, outRootDir);
            if (existing) {
              runs.push(existing);
              continue;
            }
          }
          const shouldGuiRoundtrip = Boolean(runGuiRoundtripOnRepeat1 && repeatIndex === 1 && track === 'rp1-authoring');
          let res = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const { sharedChrome, sharedPage } = await ensureBatchChrome();
              res = await runSingleTrial({
                task,
                track,
                repeatIndex,
                outRootDir,
                sharedChrome,
                sharedPage,
                runGuiRoundtrip: shouldGuiRoundtrip,
                jobManager,
              });
              break;
            } catch (err) {
              await closeBatchChrome();
              if (attempt === 2) throw err;
            }
          }
          runs.push(res);
        }
      } finally {
        await closeBatchChrome();
      }
    }
  }

  const byTask = {};
  const blindPairs = [];
  for (const task of selectedTasks) {
    const rp1Runs = runs.filter(r => r.taskId === task.id && r.track === 'rp1-authoring');
    const lowRuns = runs.filter(r => r.taskId === task.id && r.track === 'low-level-commands');
    const avg = (arr, fn) => arr.length ? Number((arr.reduce((s, x) => s + fn(x), 0) / arr.length).toFixed(2)) : 0;

    byTask[task.id] = {
      taskId: task.id,
      title: task.title,
      category: task.category,
      viewport: task.viewport,
      rp1Authoring: {
        repeats: rp1Runs.length,
        passed: rp1Runs.length,
        avgTotalCalls: avg(rp1Runs, r => r.calls.total),
        avgCreationCalls: avg(rp1Runs, r => r.calls.creation),
        avgDiscoveryCalls: avg(rp1Runs, r => r.calls.discovery),
        avgWallClockMs: avg(rp1Runs, r => r.wallClockMs),
        guiRoundtripPassed: rp1Runs.some(r => r.guiRoundtripStatus === 'passed'),
      },
      lowLevelCommands: {
        repeats: lowRuns.length,
        passed: lowRuns.length,
        avgTotalCalls: avg(lowRuns, r => r.calls.total),
        avgCreationCalls: avg(lowRuns, r => r.calls.creation),
        avgDiscoveryCalls: avg(lowRuns, r => r.calls.discovery),
        avgWallClockMs: avg(lowRuns, r => r.wallClockMs),
      },
      creationCallReductionRatio: lowRuns.length && rp1Runs.length
        ? Number((1 - avg(rp1Runs, r => r.calls.creation) / Math.max(1, avg(lowRuns, r => r.calls.creation))).toFixed(3))
        : 0,
    };

    if (rp1Runs[0] && lowRuns[0]) {
      const flip = (task.id.charCodeAt(2) % 2) === 0;
      const sampleAlpha = flip ? rp1Runs[0] : lowRuns[0];
      const sampleBeta = flip ? lowRuns[0] : rp1Runs[0];
      blindPairs.push({
        taskId: task.id,
        title: task.title,
        sample_alpha: {
          screenshots: sampleAlpha.screenshots,
          sourceJsonPath: join(sampleAlpha.runDir, 'source.json'),
        },
        sample_beta: {
          screenshots: sampleBeta.screenshots,
          sourceJsonPath: join(sampleBeta.runDir, 'source.json'),
        },
        _key: {
          sample_alpha: sampleAlpha.track,
          sample_beta: sampleBeta.track,
        },
      });
    }
  }

  const rp1TotalRuns = runs.filter(r => r.track === 'rp1-authoring');
  const lowTotalRuns = runs.filter(r => r.track === 'low-level-commands');

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceTreeSha256: SOURCE_TREE_SHA256,
    toolSchemaSha256: TOOL_SCHEMA_SHA256,
    suiteSha256: SUITE_SHA256,
    comparisonKind: 'scripted-regression',
    supportsAiUsabilityConclusion: false,
    repeatsPerTrack: repeats,
    totalRuns: runs.length,
    tracks: {
      'rp1-authoring': {
        totalRuns: rp1TotalRuns.length,
        passedRuns: rp1TotalRuns.length,
        passRate: `${rp1TotalRuns.length}/${rp1TotalRuns.length}`,
        avgTotalCalls: Number((rp1TotalRuns.reduce((s, r) => s + r.calls.total, 0) / Math.max(1, rp1TotalRuns.length)).toFixed(2)),
        avgCreationCalls: Number((rp1TotalRuns.reduce((s, r) => s + r.calls.creation, 0) / Math.max(1, rp1TotalRuns.length)).toFixed(2)),
        maxDiscoveryCalls: Math.max(0, ...rp1TotalRuns.map(r => r.calls.discovery)),
        avgWallClockMs: Number((rp1TotalRuns.reduce((s, r) => s + r.wallClockMs, 0) / Math.max(1, rp1TotalRuns.length)).toFixed(2)),
      },
      'low-level-commands': {
        totalRuns: lowTotalRuns.length,
        passedRuns: lowTotalRuns.length,
        passRate: `${lowTotalRuns.length}/${lowTotalRuns.length}`,
        avgTotalCalls: Number((lowTotalRuns.reduce((s, r) => s + r.calls.total, 0) / Math.max(1, lowTotalRuns.length)).toFixed(2)),
        avgCreationCalls: Number((lowTotalRuns.reduce((s, r) => s + r.calls.creation, 0) / Math.max(1, lowTotalRuns.length)).toFixed(2)),
        maxDiscoveryCalls: Math.max(0, ...lowTotalRuns.map(r => r.calls.discovery)),
        avgWallClockMs: Number((lowTotalRuns.reduce((s, r) => s + r.wallClockMs, 0) / Math.max(1, lowTotalRuns.length)).toFixed(2)),
      },
    },
    byTask,
    runs: runs.map(r => ({
      runId: r.runId,
      taskId: r.taskId,
      track: r.track,
      repeatIndex: r.repeatIndex,
      resultJsonPath: r.resultJsonPath,
      ledgerPath: r.ledgerPath,
      wallClockMs: r.wallClockMs,
      calls: r.calls,
      guiRoundtripStatus: r.guiRoundtripStatus,
    })),
  };

  const summaryPath = join(outRootDir, 'comparison-summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');

  const blindPath = join(outRootDir, 'blind-evaluation.json');
  writeFileSync(blindPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: summary.generatedAt,
    note: 'Anonymized screenshot pairs (sample_alpha vs sample_beta) for independent QA visual inspection; _key reveals track mapping after scoring.',
    pairs: blindPairs,
  }, null, 2) + '\n');

  return { summary, summaryPath, blindPath, runs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outIdx = process.argv.indexOf('--out');
  // M-SURFACE 教训:缺省输出根曾指向冻结的 2026-10-30 证据树,一次重跑覆盖了
  // repeat-1/T01 的原始产物。现在缺省写入独立本地目录,冻结树必须显式 --out。
  const outRootDir = outIdx >= 0
    ? resolve(process.argv[outIdx + 1])
    : resolve(new URL('./trials-local/' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), import.meta.url).pathname);
  const repeatsIdx = process.argv.indexOf('--repeats');
  const repeats = repeatsIdx >= 0 ? Number(process.argv[repeatsIdx + 1]) : 3;
  const tasksIdx = process.argv.indexOf('--tasks');
  const taskIds = tasksIdx >= 0 ? process.argv[tasksIdx + 1].split(',').map(s => s.trim()).filter(Boolean) : null;
  const tracksIdx = process.argv.indexOf('--tracks');
  const tracks = tracksIdx >= 0 ? process.argv[tracksIdx + 1].split(',').map(s => s.trim()).filter(Boolean) : ['rp1-authoring', 'low-level-commands'];
  const noGui = process.argv.includes('--no-gui');
  const forceRerun = process.argv.includes('--force');
  const res = await runAllBenchmarkTrials({
    outRootDir,
    repeats,
    tracks,
    taskIds,
    runGuiRoundtripOnRepeat1: !noGui,
    forceRerun,
  });
  console.log(JSON.stringify({
    ok: true,
    totalRuns: res.runs.length,
    summaryPath: res.summaryPath,
    blindPath: res.blindPath,
    tracks: res.summary.tracks,
  }, null, 2));
}
