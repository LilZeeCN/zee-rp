import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportPrototype, runWorkflow, verifyOfficialPreview } from '../scripts/authoring-workflow.mjs';
import { generatePrototype, sessionTools } from '../scripts/mcp-tools.mjs';

const services = { runWorkflow, exportHtml: exportPrototype };
const syncPrototype = sessionTools.find(tool => tool.name === 'sync_prototype').handler;
const output = process.env.ZEE_GATE_EVIDENCE;
const click = (target, rowIndex) => ({ action: 'click', target, rowIndex });
const expect = (target, fields, rowIndex) => ({ action: 'expect', target, rowIndex, expect: fields });
const text = (target, value, rowIndex) => expect(target, { text: value }, rowIndex);
const save = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n');
async function inWorkspace(name, fn) {
  const dir = output ? join(output, name) : mkdtempSync(join(tmpdir(), 'zee-gate-'));
  mkdirSync(dir, { recursive: true });
  try { await fn(dir); }
  finally { if (!output) rmSync(dir, { recursive: true, force: true }); }
}

test('Gate R: add, row update, delete, composite filter, sort, pagination and an automatic enum search in both browsers', { timeout: 180_000 }, () => inWorkspace('gate-r-full', async cwd => {
  const source = join(cwd, 'gate-r-full.rp1');
  copyFileSync(new URL('./fixtures/full-score-repeater.rp1', import.meta.url), source);
  const rp = join(cwd, 'gate-r-full.rp');
  const built = generatePrototype({ source, output: rp, cwd, overwrite: true, compact: false });
  save(cwd, 'generation.json', built);
  assert.equal(built.status, 'completed', JSON.stringify(built.diagnostics));
  const steps = [
    text('title', 'Alpha', 0), text('count', '8'), expect('high', { visible: false }, 0),
    click('add'), text('count', '9'), click('last'), text('title', 'Iota', 2), text('high', '高', 2),
    click('first'), text('title', 'Alpha', 0), click('pick', 0), text('score', '85', 0),
    text('high', '高', 0), text('selection', '选中 a'),
    click('remove'), text('title', 'Beta', 0), text('count', '8'), click('empty'),
    expect('title', { visible: false }, 0), click('clear'), text('title', 'Beta', 0),
    click('filter'), text('title', 'Gamma', 0), text('title', 'Epsilon', 1), text('title', 'Iota', 2),
    click('clear'), text('title', 'Beta', 0), click('desc'), text('title', 'Iota', 0),
    text('title', 'Epsilon', 1), text('score', '95', 0), click('asc'), text('title', 'Zeta', 0),
    text('title', 'Delta', 1), text('score', '20', 1), click('next'), text('title', 'Eta', 0),
    click('last'), text('title', 'Epsilon', 0), click('first'), text('title', 'Zeta', 0),
    click('go'), text('result', 'Alpha', 0), click('quick_filter_1'), text('result', 'Gamma', 0),
    { action: 'fill', target: 'quick_search', value: 'epsilon' }, text('result', 'Epsilon', 0),
  ];
  save(cwd, 'steps.json', steps);
  const outcomes = [];
  for (const engine of ['official', 'studio-html']) {
    const result = await verifyOfficialPreview({ source, rp, cwd, engine, steps, timeoutMs: 1800,
      proofDirectory: join(cwd, engine + '.assets'), proofStoryboard: true }, services);
    save(cwd, engine + '.json', result);
    outcomes.push([engine, result.passed, result.total, result.failedSteps]);
  }
  for (const [engine, passed, total, failed] of outcomes) {
    assert.equal(passed, total ?? steps.length, JSON.stringify({ engine, failed }));
  }
}));

test('F2: manually renamed RP files are rediscovered and relocated with their companions', { timeout: 30_000 }, () => inWorkspace('f2-relocate', async directory => {
  const cwd = mkdtempSync(join(directory, 'run-'));
  const source = join(cwd, 'app.rp1'), rp = join(cwd, 'app.rp'), moved = join(cwd, 'renamed.rp');
  writeFileSync(source, 'rp/1 target=9 name="测试"\npage #home [400x220] name="首页"\n  column #root [fillxfill] padding=16\n    label #title [120x40] "原来的标题"\n');
  const built = generatePrototype({ source, output: rp, cwd, overwrite: true });
  assert.equal(built.status, 'completed', JSON.stringify(built.diagnostics));
  renameSync(rp, moved);
  const found = syncPrototype({ mode: 'status', rp: moved, cwd });
  assert.equal(found.code, 'E_COMPANION_RENAMED');
  assert.equal((await verifyOfficialPreview({ rp: moved, cwd }, services)).code, 'E_COMPANION_RENAMED');
  const relocated = syncPrototype({ mode: 'relocate', from: rp, to: moved, cwd });
  save(cwd, 'relocate.json', relocated);
  assert.equal(relocated.status, 'completed', JSON.stringify(relocated));
  const metadata = JSON.parse(readFileSync(relocated.baseline));
  assert.equal(metadata.rpSha256, built.sha256);
  assert.equal(metadata.sourcePath, join(cwd, 'renamed.rp1'));
  assert.equal(existsSync(join(cwd, 'renamed.assets/build-report.json')), true);
  assert.equal(syncPrototype({ mode: 'status', rp: moved, source: metadata.sourcePath, cwd }).nativeChanged, false);
  const edited = await sessionTools.find(tool => tool.name === 'revise_prototype').handler({
    source: metadata.sourcePath, rp: moved, cwd, operations: [{ target: 'home/title', property: 'text', value: '迁移后继续编辑' }],
  });
  save(cwd, 'revision.json', edited);
  assert.equal(edited.status, 'completed', JSON.stringify(edited.diagnostics));
  assert.match(readFileSync(edited.source, 'utf8'), /迁移后继续编辑/);
}));

test('Gate P: guard rejection keeps data and variables unchanged, then commit applies all effects', { timeout: 90_000 }, () => inWorkspace('gate-p-transaction', async cwd => {
  const source = join(cwd, 'guarded.json'), rp = join(cwd, 'guarded.rp');
  const change = { type: 'data-update', target: 'items', where: '=item.id == "a"', set: { qty: '=number(@quantity)' } };
  const rule = {
    require: ['quantity'], guards: [{ assert: 'number(@quantity) >= 1 && number(@quantity) <= 10', message: '数量为 1 到 10' }],
    feedback: 'feedback', errorMessage: '请输入数量',
  };
  const spec = {
    language: 'rp/1', target: 9, name: '守卫生效前后',
    models: { Stock: { id: 'text', qty: 'number' } },
    datasets: { stock: { model: 'Stock', rows: [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }] } },
    variables: { committed: { type: 'number', value: 0 }, confirmed: { type: 'boolean', value: false } },
    computed: {
      totalQty: { op: 'sum', dataset: 'stock', field: 'qty', scope: 'dataset' },
      visibleQty: { op: 'sum', dataset: 'stock', field: 'qty', scope: 'visible' },
    },
    rules: { save_qty: { ...rule, successMessage: '数量已更新', effect: { actions: [change] } } },
    transactions: { commit_qty: { ...rule, successMessage: '事务已提交', actions: [
      { type: 'set-variable', variable: 'committed', value: '=number(@quantity)' }, change,
      { type: 'set-variable', variable: 'confirmed', value: true },
    ] } },
    pages: [{ id: 'home', name: '库存', canvas: { w: 540, h: 560 },
      root: { type: 'box', id: 'root', w: 'fill', h: 'fill', layout: 'column', gap: 8, padding: 16, children: [
        { type: 'input', id: 'quantity', w: 200, h: 40 },
        { type: 'button', id: 'rule', w: 200, h: 40, text: '更新数量', on: { click: [{ rule: 'save_qty' }] } },
        { type: 'button', id: 'commit', w: 200, h: 40, text: '提交事务', on: { click: [{ transaction: 'commit_qty' }] } },
        { type: 'button', id: 'filter', w: 200, h: 40, text: '只显示 B', on: { click: [{ type: 'data-filter', target: 'items', name: 'b', where: '=item.id == "b"' }] } },
        { type: 'label', id: 'feedback', w: 240, h: 32, text: '待输入' },
        { type: 'label', id: 'total', w: 150, h: 32, text: '=text(var.totalQty)' },
        { type: 'label', id: 'visible', w: 150, h: 32, text: '=text(var.visibleQty)' },
        { type: 'repeater', id: 'items', dataset: 'stock', key: 'id', w: 200, h: 120, rowHeight: 40,
          template: { type: 'label', id: 'qty', text: '=text(item.qty)', w: 160, h: 36 } },
      ] } }],
  };
  save(cwd, 'guarded.json', spec);
  const built = generatePrototype({ source, output: rp, cwd, overwrite: true });
  save(cwd, 'generation.json', built);
  assert.equal(built.status, 'completed', JSON.stringify(built.diagnostics));
  const quantity = value => ({ action: 'fill', target: 'quantity', value });
  const variable = (variable, equals) => ({ action: 'expect', expect: { variable, equals } });
  const steps = [
    click('rule'), text('feedback', '请输入数量'), text('qty', '1', 0), text('total', '3'),
    quantity('12'), click('commit'), text('feedback', '数量为 1 到 10'),
    variable('committed', 0), variable('confirmed', false), text('qty', '1', 0),
    quantity('4'), click('rule'), text('feedback', '数量已更新'), text('qty', '4', 0), text('total', '6'),
    quantity('7'), click('commit'), text('feedback', '事务已提交'),
    variable('committed', 7), variable('confirmed', true), text('qty', '7', 0),
    text('total', '9'), text('visible', '9'), click('filter'), text('qty', '2', 0), text('visible', '2'), text('total', '9'),
  ];
  save(cwd, 'steps.json', steps);
  const results = [];
  for (const engine of ['official', 'studio-html']) {
    const result = await verifyOfficialPreview({ source, rp, cwd, engine, steps, timeoutMs: 1600,
      proofDirectory: join(cwd, engine + '.assets') }, services);
    save(cwd, engine + '.json', result);
    results.push(result);
  }
  for (const result of results) assert.equal(result.passed, steps.length, JSON.stringify(result.failedSteps ?? result.diagnostics));
}));

test('Gate T: two clients cannot publish the same RP destination or the same Studio revision', { timeout: 90_000 }, () => inWorkspace('gate-t-concurrent', async directory => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { studioHandlers } = await import('../studio/mcp-adapter.mjs');
  const cwd = mkdtempSync(join(directory, 'run-'));
  const source = join(cwd, 'shared.rp1'), rp = join(cwd, 'shared.rp'), target = join(cwd, 'revision.rp');
  writeFileSync(source, 'rp/1 target=9 name="并发测试"\npage #home [400x220] name="首页"\n  column #root [fillxfill] padding=16\n    label #title [120x40] "原来的标题"\n');
  const built = generatePrototype({ source, output: rp, cwd });
  assert.equal(built.status, 'completed', JSON.stringify(built.diagnostics));
  const studioDir = join(cwd, 'studio');
  const opened = await studioHandlers.studio_open_project({ projectDir: studioDir, sourcePath: source, port: 0 });
  try {
    const wave = async (operation, input) => {
      const workers = ['甲', '乙'].map((value) => {
        const child = fork(new URL('./fixtures/concurrent-writer.mjs', import.meta.url), [],
          { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        return { child, value, ready: once(child, 'message'), done: once(child, 'exit') };
      });
      try {
        await Promise.all(workers.map(worker => worker.ready));
        const results = Promise.all(workers.map(({ child }) => new Promise(resolve => {
          const accept = message => {
            if (!Object.hasOwn(message, 'answer')) return;
            child.off('message', accept);
            resolve(message.answer);
          };
          child.on('message', accept);
        })));
        for (const { child, value } of workers) child.send({ operation, input, value });
        return await results;
      } finally {
        for (const { child } of workers) if (child.connected) child.disconnect();
        await Promise.all(workers.map(worker => worker.done));
      }
    };
    const studioResults = await wave('studio', { url: opened.url, baseRevision: opened.appliedRevision });
    save(cwd, 'studio-writes.json', studioResults);
    assert.equal(studioResults.filter(result => result.ok).length, 1, JSON.stringify(studioResults));
    assert.ok(studioResults.some(result => result.code === 'E_STALE_REVISION'), JSON.stringify(studioResults));
    const listed = await studioHandlers.studio_open_project({ action: 'list' });
    assert.equal(listed.instances.find(instance => instance.url === opened.url)?.revision, opened.appliedRevision + 1);
    const kept = await studioHandlers.studio_open_project({ projectDir: studioDir });
    assert.equal(kept.appliedRevision, opened.appliedRevision + 1);
    await studioHandlers.studio_open_project({ action: 'close', projectDir: studioDir });
    const restarted = await studioHandlers.studio_open_project({ projectDir: studioDir, port: 0 });
    save(cwd, 'studio-restarted.json', restarted);
    assert.equal(restarted.appliedRevision, kept.appliedRevision);
    assert.equal(restarted.contentHash, kept.contentHash);
    const nativeResults = await wave('native', { source, rp, cwd, output: target });
    save(cwd, 'native-writes.json', nativeResults);
    assert.equal(nativeResults.filter(result => result.status === 'completed').length, 1, JSON.stringify(nativeResults));
    assert.ok(nativeResults.some(result => result.code === 'E_OUTPUT_LOCKED'), JSON.stringify(nativeResults));
    const verify = sessionTools.find(tool => tool.name === 'rp_inspect').handler({ path: target, view: 'verify' });
    save(cwd, 'native-structure.json', verify);
    assert.deepEqual(verify.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    assert.equal(existsSync(target + '.lock'), false);
  } finally {
    await studioHandlers.studio_open_project({ action: 'close', projectDir: studioDir }).catch(() => {});
  }
}));

test('B1: only a non-geometric foreground color change reuses the prior browser evidence', { timeout: 90_000 }, () => inWorkspace('b1-equivalence', async directory => {
  const cwd = mkdtempSync(join(directory, 'run-'));
  const original = `rp/1 target=9 name="复验证明"
page #home [440x340] name="主页"
  column #root [fillxfill] padding=16 gap=8
    label #message [160x40] "准备"
    button #submit [140x40] "提交" color=#102030
      +on.click:
        set message = "已提交"
`;
  const steps = [click('submit'), text('message', '已提交')];
  const build = async (stem, authored) => {
    const source = join(cwd, stem + '.rp1'), rp = join(cwd, stem + '.rp');
    writeFileSync(source, authored);
    const generated = generatePrototype({ source, output: rp, cwd });
    assert.equal(generated.status, 'completed', JSON.stringify(generated.diagnostics));
    const checked = await verifyOfficialPreview({ engine: 'official', source, rp, cwd, steps, timeoutMs: 900 }, services);
    save(cwd, stem + '.json', checked);
    return checked;
  };
  const cold = await build('cold', original);
  assert.equal(cold.passed, steps.length);
  assert.equal(cold.cacheStats.reexecutedStepCount, steps.length);
  const changed = await build('color', original.replace('#102030', '#506070'));
  assert.equal(changed.passed, steps.length);
  assert.equal(changed.cacheStats.cachedStepCount, steps.length);
  assert.equal(changed.verification.browserLoaded, false);
  assert.ok(changed.priorBrowserEvidence.rpSha256);
  const wrong = await build('behavior', original.replace('set message = "已提交"', 'set message = "实际变化"'));
  assert.equal(wrong.cacheStats.cachedStepCount, 0);
  assert.equal(wrong.failed, 1);
}));
