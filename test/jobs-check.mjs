import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../scripts/jobs.mjs';
import { resolveBlankTemplate } from '../scripts/blank-template.mjs';
import { createBlankPage } from '../scripts/create-blank-page.mjs';

const work = mkdtempSync(join(tmpdir(), 'axure-jobs-check-'));
const source = resolveBlankTemplate();
const original = readFileSync(source);
const previousRoot = process.env.AXURE_WRITE_ROOT;
process.env.AXURE_WRITE_ROOT = work;
let running = 0, maximum = 0;
const mockRunner = ([output]) => {
  running++; maximum = Math.max(maximum, running);
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'import{readFileSync,writeFileSync}from"node:fs";setTimeout(()=>{const p=process.argv[1];writeFileSync(p,readFileSync(p));console.log("saved-closed-reopened")},200)', output]);
  child.once('close', () => { running--; });
  return child;
};
const manager = new JobManager({ runner: mockRunner });
const results = [];
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); console.log(`PASS  ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL  ${name} — ${error.message}`); }
};
const until = async (id, status) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (manager.get(id).status === status) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`job 未进入 ${status}`);
};
try {
  await check('wait:false 立即返回排队句柄，队列串行', async () => {
    const a = await manager.startRoundtrip({ source, output: join(work, 'a.rp') });
    const b = await manager.startRoundtrip({ source, output: join(work, 'b.rp') });
    assert.equal(a.status, 'queued'); assert.equal(b.status, 'queued');
    await until(a.id, 'completed'); await until(b.id, 'completed'); assert.equal(maximum, 1);
    assert.equal(manager.get(a.id).validation.preview, false);
  });
  await check('wait:true 等待结果，读取句柄不会修改内部状态', async () => {
    const job = await manager.startRoundtrip({ source, output: join(work, 'wait.rp'), wait: true });
    assert.equal(job.status, 'completed'); job.status = 'wrong'; assert.equal(manager.get(job.id).status, 'completed');
  });
  await check('排队任务取消不会执行', async () => {
    const active = await manager.startRoundtrip({ source, output: join(work, 'active.rp') });
    await until(active.id, 'running');
    const queued = await manager.startRoundtrip({ source, output: join(work, 'cancel-queued.rp') });
    assert.equal(manager.cancel(queued.id).status, 'cancelled');
    await until(active.id, 'completed'); assert.equal(manager.get(queued.id).status, 'cancelled');
  });
  await check('运行任务取消终止子进程', async () => {
    const job = await manager.startRoundtrip({ source, output: join(work, 'cancel-running.rp') });
    await until(job.id, 'running'); assert.equal(manager.cancel(job.id).status, 'cancelled');
    await manager.close(); assert.equal(manager.active, null);
  });
  await check('同名输出拒绝且已有内容原样保留', async () => {
    const file = join(work, 'a.rp'), before = readFileSync(file);
    await assert.rejects(manager.startRoundtrip({ source, output: file })); assert.ok(before.equals(readFileSync(file)));
  });
  await check('白名单外输出与非法扩展拒绝', async () => {
    const output = join(work, '..', `axure-job-outside-${process.pid}.rp`);
    await assert.rejects(manager.startRoundtrip({ source, output })); assert.ok(!existsSync(output));
    await assert.rejects(manager.startRoundtrip({ source, output: join(work, 'bad.txt') }));
  });
  await check('受保护路径及链接在读取前拒绝', async () => {
    // 经 AXURE_PROTECTED_PATHS 注入假路径；引擎惰性读取环境，调用前设置即生效。
    const protectedPath = '/zee-rp-test-protected/final.rp';
    process.env.AXURE_PROTECTED_PATHS = protectedPath;
    await assert.rejects(manager.startRoundtrip({ source: protectedPath, output: join(work, 'never.rp') }), /受保护/);
    const link = join(work, 'link.rp'); symlinkSync(protectedPath, link);
    await assert.rejects(manager.startRoundtrip({ source: link, output: join(work, 'never-link.rp') }), /受保护/);
  });
  await check('未知句柄拒绝；输入源从未改写', async () => {
    assert.throws(() => manager.get('missing')); assert.throws(() => manager.cancel('missing'));
    assert.ok(original.equals(readFileSync(source)));
  });
  await check('子进程失败不会声称 GUI 通过', async () => {
    const failed = new JobManager({ runner: () => spawn(process.execPath, ['-e', 'process.exit(1)']) });
    const job = await failed.startRoundtrip({ source, output: join(work, 'failed.rp'), wait: true });
    assert.equal(job.status, 'failed'); assert.equal(job.validation.guiSaved, false); await failed.close();
  });
  await check('符号链接加 .. 保留真实输入与输出位置', async () => {
    const a = join(work, 'a'), b = join(work, 'b');
    mkdirSync(a); mkdirSync(join(b, 'nested'), { recursive: true });
    writeFileSync(join(a, 'source.rp'), original);
    const other = createBlankPage(original, 'Physical page').file;
    writeFileSync(join(b, 'source.rp'), other);
    symlinkSync(join(b, 'nested'), join(a, 'link'));
    const rawBase = `${a}/link/..`;
    const job = await manager.startRoundtrip({ source: `${rawBase}/source.rp`, output: `${rawBase}/physical.rp`, wait: true });
    assert.equal(job.status, 'completed');
    assert.ok(other.equals(readFileSync(join(b, 'physical.rp'))));
    assert.equal(job.source, realpathSync(join(b, 'source.rp')));
    assert.equal(job.output, join(realpathSync(b), 'physical.rp'));
    assert.ok(!existsSync(join(a, 'physical.rp')));
  });
  await check('只保存但未关闭重开不能完成往返任务', async () => {
    const partial = new JobManager({ runner: ([output]) => spawn(process.execPath, ['--input-type=module', '-e', 'import{readFileSync,writeFileSync}from"node:fs";setTimeout(()=>{const p=process.argv[1];writeFileSync(p,readFileSync(p));console.error("AXURE_GUI_PHASE saved")},20)', output]) });
    const job = await partial.startRoundtrip({ source, output: join(work, 'partial.rp'), wait: true });
    assert.equal(job.validation.guiSaved, true); assert.equal(job.validation.closed, false);
    assert.equal(job.validation.reopened, false); assert.equal(job.status, 'failed'); await partial.close();
  });
} finally {
  await manager.close();
  if (previousRoot === undefined) delete process.env.AXURE_WRITE_ROOT; else process.env.AXURE_WRITE_ROOT = previousRoot;
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ total: results.length, passed: results.length - failed, failed, evidence: 'mock process lifecycle; no real GUI', results }));
process.exitCode = failed ? 1 : 0;
