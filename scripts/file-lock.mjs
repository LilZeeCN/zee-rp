import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { assertNotProtected, assertWritable } from './engine.mjs';

const locked = (file, owner) => Object.assign(new Error(`目标正在写入：${file}`), {
  code: 'E_OUTPUT_LOCKED', path: file, ...(owner?.pid ? { ownerPid: owner.pid } : {}),
});

function ownerOf(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function pidIsGone(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  return false;
}

export function acquireOutputLock(input) {
  const target = resolve(input);
  assertNotProtected(target);
  assertWritable(target);
  mkdirSync(dirname(target), { recursive: true });
  const path = join(realpathSync(dirname(target)), basename(target)) + '.lock';
  assertNotProtected(path);
  assertWritable(path);
  const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  let file;
  try { file = openSync(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = ownerOf(path);
    if (!pidIsGone(previous?.pid)) throw locked(target, previous);

    // Only a single process may reclaim a dead owner's lock.
    const claim = path + '.reclaim';
    let claimFd;
    try { claimFd = openSync(claim, 'wx'); }
    catch (claimError) {
      if (claimError.code === 'EEXIST') throw locked(target, previous);
      throw claimError;
    }
    try {
      const current = ownerOf(path);
      if (current?.token !== previous.token) throw locked(target, current);
      unlinkSync(path);
      try { file = openSync(path, 'wx'); }
      catch (retryError) {
        if (retryError.code === 'EEXIST') throw locked(target, ownerOf(path));
        throw retryError;
      }
    } finally {
      closeSync(claimFd);
      unlinkSync(claim);
    }
  }
  try { writeFileSync(file, JSON.stringify(owner) + '\n'); }
  catch (error) { unlinkSync(path); throw error; }
  finally { closeSync(file); }
  return () => {
    if (ownerOf(path)?.token === owner.token) unlinkSync(path);
  };
}
