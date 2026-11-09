import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskSpec, loadBenchmarkFixtures, verifyTaskDocumentStructure } from '../benchmarks/studio/task-builders.mjs';
import { importToStudioDocument } from '../studio/document.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkActorEvidence, checkObservedContent } from '../benchmarks/studio/real-trial-acceptance.mjs';
import { parseTrialFeedback, selectModelConfiguration } from '../benchmarks/studio/model-selection.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VALIDATE_PY = resolve(REPO_ROOT, 'benchmarks/studio/validate.py');
import {nativeTemplateSkipReason} from './host-capabilities.mjs';
const REPLAY_MJS = resolve(REPO_ROOT, 'benchmarks/studio/replay.mjs');

test('model feedback accepts fenced JSON and ignores malformed ratings', () => {
  const value = { claimCompleted: false, easeScore: 1, scoreReason: 'blocked', frictions: ['unavailable'], summary: 'unfinished' };
  assert.deepEqual(parseTrialFeedback('```json\n' + JSON.stringify(value) + '\n```'), value);
  assert.equal(parseTrialFeedback('{broken'), null);
  assert.equal(parseTrialFeedback(JSON.stringify({ ...value, easeScore: 11 })), null);
});

test('model provenance uses explicit CLI selection without inheriting an unrelated configured model', () => {
  const configured = { model: 'zcode/GLM-5.3', model_reasoning_effort: 'max', model_provider: 'magpie' };
  assert.deepEqual(
    selectModelConfiguration(configured, { model: 'deepseek/deepseek-flash', reasoning: 'high', provider: 'magpie' }),
    { model: 'deepseek/deepseek-flash', model_reasoning_effort: 'high', model_provider: 'magpie' },
  );
  assert.throws(
    () => selectModelConfiguration(configured, { model: 'deepseek/deepseek-flash', reasoning: 'high' }),
    /--provider is required/,
  );
  assert.deepEqual(
    selectModelConfiguration(configured, {}),
    { model: 'zcode/GLM-5.3', model_reasoning_effort: 'max', model_provider: 'magpie' },
  );
});

test('A00/B01: replay.mjs schema check and validate.py suite check pass', () => {
  const replayProc = spawnSync('node', [REPLAY_MJS, '--check-schema'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(replayProc.status, 0, replayProc.stderr || replayProc.stdout);
  const replayData = JSON.parse(replayProc.stdout.trim());
  assert.equal(replayData.ok, true);
  assert.equal(replayData.tasks, 8);
  assert.ok(replayData.declaredAssertions >= 20);

  const valProc = spawnSync('python3', [VALIDATE_PY], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(valProc.status, 0, valProc.stderr || valProc.stdout);
  const valData = JSON.parse(valProc.stdout.trim());
  assert.equal(valData.ok, true);
  assert.equal(valData.suite.taskCount, 8);
});

test('benchmark accounting distinguishes scripted replay from real model work and rejects invented model/rating evidence', () => {
  const program = [
    "import sys,json,copy",
    "sys.path.insert(0,'benchmarks/studio')",
    'from validate import accounting',
    "r=json.load(open('benchmarks/studio/result-template.json'))",
    "r['outcome']='completed'",
    "r['calls'].update({key:0 for key in ['total','timedOut','uncertain','discovery','creation']})",
    "r['experience']={'classification':'familiar','readImplementation':True,'priorSameTaskExposure':False,'assistance':[]}",
    "r['documentBinding']={'documentId':'test','revision':1,'contentHash':'0'*64}",
    "r['fingerprint']['sourceTreeSha256']='0'*64",
    "r['fingerprint']['briefSha256']='0'*64",
    "r['fingerprint']['model']['id']='studio-task-runner-v1'",
    "ids=['structure','semantic','render','pointer','actor-evidence','fresh-reopen','observed-content','events','feedback']",
    "r['artifacts']=[{'id':i,'kind':'test','path':i,'relativeTo':'runDir','sha256':'0'*64,'binding':copy.deepcopy(r['documentBinding'])} for i in ids]",
    "for level,artifact in [('source-structure','structure'),('semantic','semantic'),('browser-render','render'),('browser-pointer','pointer')]:",
    " r['evidence'][level].update(status='passed',evidenceIds=[artifact],assertionCount=1)",
    'def rejects(v):',
    ' try: accounting(v,[]); return False',
    ' except ValueError: return True',
    "assert rejects(r), 'script name must not impersonate a model'",
    "r['execution']={'kind':'scripted-regression','runner':'test'}",
    "r['fingerprint']['model']['id']=None",
    "kinds={'structure':'source-document','semantic':'scenario-trace','render':'screenshot','pointer':'scenario-trace'}",
    "for a in r['artifacts']: a['kind']=kinds.get(a['id'],'test')",
    "r['evidence']['browser-pointer']['evidenceIds'].append('render')",
    'accounting(r,[])',
    'for level in ("semantic","browser-render","browser-pointer"):',
    " bad=copy.deepcopy(r); bad['evidence'][level]['evidenceIds']=['structure']",
    " assert rejects(bad), f'{level} cannot reuse a source document as evidence'",
    "bad=copy.deepcopy(r); next(a for a in bad['artifacts'] if a['id']=='render')['relativeTo']='sourceRoot'",
    "assert rejects(bad), 'browser evidence must be hash-verified in the run directory'",
    "r['ratings']=[{'source':'agent','score':9,'reason':'invented','evidenceIds':[]}]",
    "assert rejects(r), 'script must not fabricate an agent usability score'",
    "print('accounting ok')",
  ].join('\n');
  const result=spawnSync('python3',['-c',program],{cwd:REPO_ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

test('validate.py rejects a self-labelled completed trial without core evidence and ledger proof', () => {
  const work = mkdtempSync(join(tmpdir(), 'studio-result-validation-'));
  try {
    const result = JSON.parse(readFileSync(resolve(REPO_ROOT, 'benchmarks/studio/result-template.json'), 'utf8'));
    Object.assign(result, {
      runId: 'T01-rp1-authoring-r1',
      taskId: 'T01',
      comparisonGroup: 'T01-repeat-1',
      attempt: 1,
      outcome: 'completed',
      execution: { kind: 'model-agent', runner: 'test' },
      experience: { classification: 'independent', readImplementation: false, priorSameTaskExposure: false, assistance: [] },
      documentBinding: { documentId: 'doc', revision: 1, contentHash: '0'.repeat(64) },
      calls: { ledgerPath: 'call-ledger.jsonl', total: 0, timedOut: 0, uncertain: 0, discovery: 0, creation: 0, firstMutationCallId: null },
    });
    result.fingerprint.sourceTreeSha256 = '0'.repeat(64);
    result.fingerprint.briefSha256 = '0'.repeat(64);
    result.fingerprint.model.id = 'actual-model';
    writeFileSync(join(work, 'result.json'), JSON.stringify(result));
    writeFileSync(join(work, 'call-ledger.jsonl'), '');
    const checked = spawnSync('python3', [VALIDATE_PY, '--root', REPO_ROOT, '--result', join(work, 'result.json'), '--ledger', join(work, 'call-ledger.jsonl')], { encoding: 'utf8' });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /core|evidence|artifact|Completed/i);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('T08 acceptance rejects changes outside the three authorized source leaves', () => {
  const fixtures = loadBenchmarkFixtures(), doc = importToStudioDocument(fixtures.localEdit);
  const home = doc.pages.find(p => p.id === 'home');
  home.root.children.find(n => n.id === 'title').text = '本周观察';
  home.root.children.find(n => n.id === 'card').title = '现场记录';
  home.root.children.find(n => n.id === 'instanceA').overrides = { caption: { text: '只改当前实例' } };
  assert.equal(verifyTaskDocumentStructure('T08', doc, fixtures).outOfScopeMutations, 0);
  for (const mutate of [
    d => { d.pages[0].root.children[0].x = 40; },
    d => { d.tokens.unrelated = 24; },
    d => { d.pages[0].root.children.find(n => n.id === 'instanceA').overrides.caption.fontSize = 30; },
    d => { d.pages[1].root.children[0].onClick = [{ type: 'navigate', page: 'home' }]; },
  ]) {
    const changed = structuredClone(doc); mutate(changed);
    const result = verifyTaskDocumentStructure('T08', changed, fixtures);
    assert(result.outOfScopeMutations > 0); assert.equal(result.passed, false);
  }
});

test('benchmark content cannot be satisfied by metadata or incomplete data rows', () => {
  const fixtures = loadBenchmarkFixtures();
  for (const id of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07']) {
    const doc = importToStudioDocument(buildTaskSpec(id, fixtures));
    assert.equal(verifyTaskDocumentStructure(id, doc, fixtures).passed, true, id);
    doc.auditMetadata = JSON.stringify(fixtures.content);
    doc.datasets = {};
    const clear = node => {
      if (!node) return;
      for (const key of ['text', 'title', 'subtitle', 'body', 'value', 'label', 'placeholder', 'content']) if (typeof node[key] === 'string') node[key] = '';
      delete node.on;
      for (const child of node.children || []) clear(child);
      for (const state of node.states || []) clear(state.root);
      clear(node.template);
    };
    for (const page of doc.pages) clear(page.root);
    for (const component of Object.values(doc.components || {})) clear(component.root);
    const result = verifyTaskDocumentStructure(id, doc, fixtures);
    assert.equal(result.passed, false, id);
    assert(result.missingContent.length > 0, id);
  }
  const recordsDoc = importToStudioDocument(buildTaskSpec('T03', fixtures));
  assert.equal(verifyTaskDocumentStructure('T03', recordsDoc, fixtures).missingContent.length, 0);
  const rows = Object.values(recordsDoc.datasets).find(dataset => dataset.rows?.length === 12).rows;
  rows[0].amount = -1;
  assert(verifyTaskDocumentStructure('T03', recordsDoc, fixtures).missingContent.some(text => text.includes('R01')));
});

test('T06 runtime paging copy is delegated to its mandatory scenario', () => {
  const fixtures = loadBenchmarkFixtures();
  const doc = importToStudioDocument(buildTaskSpec('T06', fixtures));
  const scenario = fixtures.suite.tasks.find(task => task.id === 'T06').scenarios[0];
  assert.equal(verifyTaskDocumentStructure('T06', doc, fixtures).missingContent.length, 0);
  assert.equal(scenario.steps[0].expect.text['page-status'], '第 1 / 3 页');

  doc.auditMetadata = JSON.stringify({ paging: '第 1 / 3 页' });
  const clearText = node => {
    if (!node) return;
    if (node.id === 'page-status') node.text = '';
    for (const child of node.children || []) clearText(child);
  };
  clearText(doc.pages[0].root);
  const result = verifyTaskDocumentStructure('T06', doc, fixtures);
  assert.equal(result.missingContent.includes('每页 5 条'), false);
  assert.equal(result.missingContent.includes('第 1 / 3 页'), false);
});

test('scripted baseline T01 runs end-to-end and passes current validate (M-GAPS#2 regression)', { skip: nativeTemplateSkipReason() }, () => {
  const outDir = mkdtempSync(join(tmpdir(), 'scripted-gate-'));
  try {
  const runProc = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'benchmarks/studio/run-trials.mjs'),
    '--repeats', '1', '--tasks', 'T01', '--tracks', 'rp1-authoring',
    '--no-gui', '--out', outDir, '--force',
  ], { encoding: 'utf8', timeout: 240000 });
  assert.equal(runProc.status, 0, (runProc.stderr || runProc.stdout || '').slice(-600));
  const runDir = join(outDir, 'rp1-authoring', 'repeat-1', 'T01');
  const resultPath = join(runDir, 'result.json');
  const ledgerPath = join(runDir, 'call-ledger.jsonl');
  const valProc = spawnSync('python3', [VALIDATE_PY, '--result', resultPath, '--ledger', ledgerPath], { encoding: 'utf8', timeout: 60000 });
  assert.equal(valProc.status, 0, (valProc.stderr || valProc.stdout || '').slice(-600));
  assert.equal(JSON.parse(valProc.stdout).resultValidated, true);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

test('actor evidence requires the author screenshot, scenario and T08 atomic undo/redo', () => {
  const receipt = (name, result, args = {}, images = []) => ({ request: { name, args }, row: { status: result.ok === false ? 'error' : 'success' }, result, images });
  const rows = [
    receipt('studio_screenshot', { ok:true, contentHash:'before' }, {}, ['before.png']),
    receipt('studio_command', { ok:true, txId:'tx1', contentHash:'after', directAffectedNodeIds:['home/title','home/card','home/instanceA'] }),
    receipt('studio_screenshot', { ok:true, contentHash:'after' }, {}, ['edited.png']),
    receipt('studio_history', { ok:true, undoneTxId:'tx1', contentHash:'before' }, { action: 'undo' }),
    receipt('studio_screenshot', { ok:true, contentHash:'before' }, {}, ['undo.png']),
    receipt('studio_history', { ok:true, redoneTxId:'tx1', contentHash:'after' }, { action: 'redo' }),
    receipt('studio_command', { ok:false, code:'E_COMMAND_VALUE', message:'command.select.nodeIds 至少需要 1 项' }, { commands:[{ type:'editNodes', select:{ nodeIds:[] } }] }),
    receipt('studio_command', { ok:false, code:'E_STALE_REVISION', currentContentHash:'after' }),
    receipt('studio_screenshot', { ok:true, contentHash:'after' }, {}, ['after.png']),
    receipt('studio_scenario', { ok:true, assertionCount:4 }, { startPageId:'home', steps:[{action:'click',target:'next',expect:{page:'detail'}}] }),
  ];
  const scenarios = [{startPageId:'home',steps:[{action:'click',target:'next',expect:{page:'detail'}}]}];
  assert.equal(checkActorEvidence('T08', rows, { easeScore:8 }, 'after', scenarios, {contentHash:'before'}).passed, true);
  const emptyCommands = rows.map(row => row.result?.code === 'E_COMMAND_VALUE'
    ? {
        ...row,
        result: { ok:false, code:'E_TRIAL_TOOL', message:'arguments.commands 至少需要 1 项' },
        request: { ...row.request, args: { commands:[] } },
      }
    : row);
  assert.equal(checkActorEvidence('T08', emptyCommands, { easeScore:8 }, 'after', scenarios, {contentHash:'before'}).passed, true);
  const emptyQuery = rows.map(row => row.result?.code === 'E_COMMAND_VALUE'
    ? receipt('studio_inspect', { ok:true, empty:true, contentHash:'after', message:'没有匹配节点' }, { pageId:'home', textContains:'不存在' })
    : row);
  assert.equal(checkActorEvidence('T08', emptyQuery, { easeScore:8 }, 'after', scenarios, {contentHash:'before'}).passed, true);
  const staleAfterTemporaryEdit = rows.map(row => row.result?.code === 'E_STALE_REVISION'
    ? { ...row, result: { ...row.result, currentContentHash:'temporary' } }
    : row);
  assert.equal(checkActorEvidence('T08', staleAfterTemporaryEdit, { easeScore:8 }, 'after', scenarios, {contentHash:'before'}).passed, true);
  const reviewed = rows.map(row => row.request.name === 'studio_screenshot'
    ? { ...row, request: { ...row.request, name: 'studio_design', args: { ...(row.request.args || {}), action: 'review' } } }
    : row);
  assert.equal(checkActorEvidence('T08', reviewed, { easeScore:8 }, 'after', scenarios, {contentHash:'before'}).passed, true);
  for (const index of [0,1,2,3,4,5,6,7,8,9]) assert.equal(checkActorEvidence('T08', rows.filter((_, i) => i !== index), { easeScore:8 }, 'after', scenarios, {contentHash:'before'}).passed, false, `missing receipt ${index}`);
  assert.equal(checkActorEvidence('T08', rows, null, 'after', scenarios, {contentHash:'before'}).passed, false);
});

test('browser evidence requires observed text and ordered article paragraphs', () => {
  const content = loadBenchmarkFixtures().content;
  const observed = text => [{result:{history:[{actual:{widgets:[{visible:true,text}]}}]}}];
  const article = content.article;
  const meta = [article.title, article.author, article.date, article.source, article.footnote];
  const paras = article.sections.flatMap(section => [section.heading, ...section.paragraphs]);
  assert.equal(checkObservedContent('T02', observed([...meta,...paras].join('\n')), content).passed, true);
  assert.equal(checkObservedContent('T02', observed([...meta,...paras].reverse().join('\n')), content).passed, false);
  assert.equal(checkObservedContent('T01', [], content).passed, false);
  assert.equal(checkObservedContent('T01', observed('abandon'), content).passed, false);
});
