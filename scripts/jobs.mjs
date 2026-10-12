import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync, statSync, realpathSync, constants } from 'node:fs';
import { dirname, basename, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { readRp } from './rp-read.mjs';

const HELPER = fileURLToPath(new URL('./gui-roundtrip.swift', import.meta.url));

export class JobManager {
  constructor({ runner = (args) => spawn('/usr/bin/swift', [HELPER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
    this.runner = runner;
    this.jobs = new Map();
    this.active = null;
  }

  list() { return [...this.jobs.values()].map(job => this.get(job.id)); }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`未知 job ${id}`);
    const { child, done, finish, ...data } = job;
    return structuredClone(data);
  }

  async startRoundtrip({ source, output, wait = false }) {
    if (process.platform !== 'darwin') throw new Error('GUI roundtrip 当前仅支持 macOS / Axure RP 11');
    assertNotProtected(source); assertWritable(output);
    // 不先做词法归一化；link/.. 必须按操作系统的真实路径顺序解析。
    source = realpathSync.native(source); output = join(realpathSync.native(dirname(output)), basename(output));
    assertNotProtected(source); assertWritable(output);
    if (extname(source).toLowerCase() !== '.rp' || extname(output).toLowerCase() !== '.rp') throw new Error('source/output 必须是 .rp');
    const before = readRp(readFileSync(source));
    if (before.records.unparseable || before.counts.danglingRefs || before.counts.problems) throw new Error('源文件结构检查失败，拒绝 GUI job');
    copyFileSync(source, output, constants.COPYFILE_EXCL);
    const id = randomUUID();
    const job = { id, type: 'gui-roundtrip', source, output, status: 'queued', stdout: '', stderr: '', phase: 'queued', validation: null };
    job.done = new Promise(resolveDone => { job.finish = resolveDone; });
    this.jobs.set(id, job);
    setImmediate(() => this.pump());
    if (wait) { await job.done; return this.get(id); }
    return this.get(id);
  }

  pump() {
    if (this.active) return;
    const job = [...this.jobs.values()].find(j => j.status === 'queued');
    if (!job) return;
    this.active = job.id;
    job.status = 'running';
    let originalMtime;
    try {
      assertNotProtected(job.output); assertWritable(job.output);
      originalMtime = statSync(job.output).mtimeMs;
      job.child = this.runner([job.output]);
      job.child.stdout.on('data', chunk => { job.stdout += chunk.toString(); });
      job.child.stderr.on('data', chunk => {
        job.stderr += chunk.toString();
        const phases = [...job.stderr.matchAll(/^AXURE_GUI_PHASE (opened|saved|closed|reopened)$/gm)];
        if (phases.length) job.phase = phases.at(-1)[1];
      });
      job.child.once('error', error => this.complete(job, 1, error.message));
      job.child.once('close', code => {
        if (job.status === 'cancelled') { this.complete(job, code); return; }
        try {
          assertNotProtected(job.output);
          const rp = readRp(readFileSync(job.output));
          const gui = job.stdout.trim() === 'saved-closed-reopened';
          job.validation = {
            structure: rp.records.unparseable === 0 && rp.counts.danglingRefs === 0 && rp.counts.problems === 0,
            guiSaved: (gui || job.stderr.includes('AXURE_GUI_PHASE saved')) && statSync(job.output).mtimeMs > originalMtime,
            closed: gui || job.stderr.includes('AXURE_GUI_PHASE closed'),
            reopened: gui || job.stderr.includes('AXURE_GUI_PHASE reopened'), preview: false, guiEdited: false,
            counts: rp.counts
          };
          const passed = job.validation.structure && job.validation.guiSaved && job.validation.closed && job.validation.reopened;
          this.complete(job, code, code === 0 && !passed ? '没有确认结构健康及 GUI 保存、关闭、重开全部完成' : '');
        } catch (error) { this.complete(job, 1, error.message); }
      });
    } catch (error) { this.complete(job, 1, error.message); }
  }

  complete(job, code, error = '') {
    if (job.finished) return;
    job.finished = true;
    if (job.status !== 'cancelled') job.status = code === 0 && !error ? 'completed' : 'failed';
    if (error) job.stderr += error;
    job.exitCode = code;
    this.active = null;
    job.finish();
    setImmediate(() => this.pump());
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`未知 job ${id}`);
    if (!['queued', 'running'].includes(job.status)) return this.get(id);
    const running = job.status === 'running';
    job.status = 'cancelled';
    if (running) job.child.kill('SIGTERM');
    else { job.finished = true; job.finish(); }
    return this.get(id);
  }

  async close() {
    for (const job of this.jobs.values()) if (['queued', 'running'].includes(job.status)) this.cancel(job.id);
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}
