// Repeatable tool-pipeline benchmark. This does not measure an AI's creative time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.env.AXURE_TEST_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Provide a new output directory');
const work = resolve(process.argv[2]); mkdirSync(work, { recursive: false });
const tasks = JSON.parse(readFileSync(join(root, 'benchmarks/authoring/v1/tasks.json'))).tasks;
const client = new Client({ name: 'authoring-scripted-benchmark', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
  env: { ...process.env, AXURE_WRITE_ROOT: work }, stderr: 'pipe' });
const calls = [], results = [], projects = {};
let runtime;
async function call(name, input, expectedError = false) {
  const started = performance.now();
  const raw = await client.callTool({ name, arguments: input }, undefined, { timeout: 120000 });
  const r = raw.structuredContent ?? JSON.parse(raw.content[0].text);
  calls.push({ name, durationMs: Math.round(performance.now() - started), bytes: Buffer.byteLength(JSON.stringify(r)), error: Boolean(raw.isError), expectedError });
  assert.equal(Boolean(raw.isError), expectedError, JSON.stringify(r));
  return r;
}
async function task(id, action) {
  const start = performance.now(), index = calls.length;
  try {
    const artifact = await action();
    results.push({ id, status: 'structurally-verified', artifact, pipelineWallTimeMs: Math.round(performance.now() - start),
      toolWallTimeMs: calls.slice(index).reduce((n, c) => n + c.durationMs, 0),
      toolCalls: calls.length - index, responseBytes: calls.slice(index).reduce((n, c) => n + c.bytes, 0),
      errorResponses: calls.slice(index).filter(c => c.error).length,
      unexpectedErrors: calls.slice(index).filter(c => c.error && !c.expectedError).length,
      firstUsableDraftMs: null, documentationReads: null, repairRounds: null, modelTokens: null, nativePreview: false });
    console.log(`PASS ${id} ${results.at(-1).toolWallTimeMs}ms ${results.at(-1).toolCalls} calls`);
  } catch (error) {
    results.push({ id, status: 'failed', failure: error.message, toolWallTimeMs: Math.round(performance.now() - start), toolCalls: calls.length - index });
    console.log(`FAIL ${id}: ${error.message}`);
  }
}
function spec(recipe) {
  const proc = spawnSync('python3', ['-B', join(root, 'scripts/rp_language_cli.py'), 'dsl-to-json', '--spec', join(root, 'examples/authoring', `${recipe}.rp1`)], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr); return JSON.parse(proc.stdout);
}
function textReplace(value, mapping) {
  if (typeof value === 'string') {
    for (const [old, next] of Object.entries(mapping)) value = value.replaceAll(old, next);
    return value;
  }
  if (Array.isArray(value)) return value.map(v => textReplace(v, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, textReplace(v, mapping)]));
  return value;
}
async function create(id, sourceSpec) {
  const source = join(work, `${id}.json`); writeFileSync(source, JSON.stringify(sourceSpec, null, 2) + '\n');
  const r = await call('generate_prototype', { source, output: join(work, `${id}.rp`), strictAudit: true });
  const verification = await call('verify', { path: r.output }); assert(verification.ok);
  projects[id] = r; return { output: r.output, source: r.source, previews: r.previews, verification: r.verification };
}
try {
  await client.connect(transport); runtime = await call('runtime_info', {});
  await task('habit-cards', async () => {
    let s = spec('mobile-cards'); s.name = '微习惯 · 学习小步'; s.palette.brand = '#0D9488'; s.palette['brand-soft'] = '#DDF4EE';
    s = textReplace(s, { '把今天，稳稳学扎实。': '今天，记住一个运动习惯。', '虚拟内存': '间隔训练',
      '操作系统为什么需要间隔训练？': '为什么训练后需要安排恢复时间？' });
    return create('habit-cards', s);
  });
  await task('equipment-list', async () => {
    let s = spec('list-detail'); s.name = '校园设备借用';
    s.datasets.resources.rows = [
      { id: 'a', title: '便携投影仪', body: '适合小组展示，借用时检查电源与转接线。' },
      { id: 'b', title: '采访录音笔', body: '适合课程采访，归还前清理个人录音。' },
    ];
    s.variables.selectedTitle = '便携投影仪'; s.variables.selectedBody = s.datasets.resources.rows[0].body;
    s = textReplace(s, { '复习资料': '设备清单', '资料详情': '设备详情', '资料少一点，记得牢一点。': '为下一次展示做好准备。',
      '查看资料': '查看设备', '还没有复习资料': '暂时没有可借设备', '恢复示例资料': '恢复设备清单' });
    return create('equipment-list', s);
  });
  await task('volunteer-form', async () => {
    const s = textReplace(spec('step-form'), { '研途 · 制定计划': '校园志愿报名', '制定学习计划': '志愿活动报名',
      '让下一步足够具体': '一起参与校园志愿服务', '先填写科目，再确认目标。': '先填写姓名，再选择时段。',
      '两步建立计划': '两步完成报名', '选择科目': '填写姓名', '确认目标': '服务时段', '复习科目': '报名姓名',
      '今天复习什么？': '你的姓名是？', '例如：高等数学': '例如：林同学', '请填写一个明确科目': '请填写你的姓名',
      '请先填写具体目标': '请先填写服务时段', '例如：完成三道极限题': '例如：周六上午',
      '填写一个能在 25 分钟内完成的目标。': '请填写你能参加服务的具体时段。', '计划已建立': '报名已提交',
      '现在，开始专注': '报名成功，感谢参与', '本次目标：': '服务时段：', '建议专注 25 分钟': '集合地点将由活动负责人通知', '再建一个计划': '重新报名' });
    return create('volunteer-form', s);
  });
  await task('shared-revision', async () => {
    const p = projects['habit-cards'];
    const r = await call('revise_prototype', { source: p.source, rp: p.output, output: join(work, 'habit-v2.rp'),
      operations: [{ path: '/palette/brand', value: '#2563EB' }, { path: '/components/StudyCard/root/children/1/fontSize', value: 22 }] });
    assert(r.impact.affectedPages.includes('today') && r.impact.affectedPages.includes('review'));
    const state = await call('sync_prototype', { mode: 'status', source: r.source, rp: r.output });
    assert(!state.nativeChanged && !state.sourceChanged); return r;
  });
  await task('native-source-merge', async () => {
    const p = projects['habit-cards'];
    await call('axure_open', { path: p.output });
    await call('edit_text', { target: { name: 'headline', page: '今日复习' }, text: '原生改稿：从一个小习惯开始' });
    const saved = await call('axure_save', { as: join(work, 'habit-native.rp') });
    const r = await call('revise_prototype', { source: p.source, rp: saved.physicalPath, output: join(work, 'habit-merged.rp'),
      operations: [{ target: 'today/intro', property: 'text', value: '源码改稿：每次只练一个动作。' }] });
    const body = readFileSync(r.source, 'utf8'); assert(body.includes('原生改稿：') && body.includes('源码改稿：'));
    const conflict = await call('revise_prototype', { source: p.source, rp: saved.physicalPath, output: join(work, 'conflict.rp'),
      operations: [{ target: 'today/headline', property: 'text', value: '冲突修改' }] }, true);
    assert.equal(conflict.status, 'conflict'); return { ...r, conflictDetected: true };
  });
  await task('image-reconstruction', async () => {
    const image = projects['equipment-list'].previews.list;
    const r = await call('generate_from_image', { image, output: join(work, 'equipment-image.rp'), scale: 2, page: '设备清单图片还原' });
    assert(r.widgetCounts.texts > 0 || r.widgetCounts.text > 0);
    assert(r.widgetCounts.shapes > 0); assert(r.baseline);
    const verified = await call('verify', { path: r.output }); assert(verified.ok);
    return { output: r.output, counts: r.widgetCounts, source: r.artifacts.spec, verification: r.verification };
  });
} finally {
  await client.close();
  writeFileSync(join(work, 'benchmark.json'), JSON.stringify({ runKind: 'scripted-scenarios', runtime, tasks, results, calls,
    measurementScope: 'Tool pipeline only. Creative time, documentation reads, model use and real preview are not measured here.' }, null, 2) + '\n');
}
process.exitCode = results.some(r => r.status === 'failed') ? 1 : 0;
