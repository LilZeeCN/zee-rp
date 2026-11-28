import { BoundedCache, textWeight } from './bounded-cache.mjs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new BoundedCache({maxEntries:8192,maxWeight:8*1024*1024,weight:textWeight});
let binary;
let unavailable;
let shaperWorker;
let shaperBuffer;

if (!isMainThread && workerData?.kind === 'studio-shaping') {
  const child = spawn(workerData.binary, ['--stream'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const status = new Int32Array(workerData.buffer, 0, 2);
  const reply = new Uint8Array(workerData.buffer, 8);
  const finish = (line) => {
    if (Atomics.load(status, 0) !== 0) return;
    const bytes = line ? Buffer.from(line, 'utf8') : null;
    if (!bytes || bytes.length > reply.length) {
      Atomics.store(status, 0, 2);
    } else {
      reply.set(bytes);
      Atomics.store(status, 1, bytes.length);
      Atomics.store(status, 0, 1);
    }
    Atomics.notify(status, 0);
  };
  const reader = createInterface({ input: child.stdout });
  reader.on('line', finish);
  child.on('error', () => finish(null));
  child.on('close', () => finish(null));
  child.stdin.on('error', () => finish(null));
  parentPort.on('message', request => child.stdin.write(request + '\n'));
  parentPort.on('close', () => child.stdin.end());
}

function measureSystemText(request) {
  if (shaperWorker === false) return null;
  if (!shaperWorker) {
    shaperBuffer = new SharedArrayBuffer(4 * 1024 * 1024 + 8);
    shaperWorker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: {
      kind: 'studio-shaping', binary, buffer: shaperBuffer,
    } });
    shaperWorker.on('error', () => { shaperWorker = false; });
    shaperWorker.unref();
  }
  const status = new Int32Array(shaperBuffer, 0, 2);
  Atomics.store(status, 0, 0);
  shaperWorker.postMessage(request);
  Atomics.wait(status, 0, 0, 1500);
  if (Atomics.load(status, 0) === 1) {
    const bytes = Buffer.from(shaperBuffer, 8, Atomics.load(status, 1));
    return JSON.parse(bytes.toString('utf8'));
  }
  shaperWorker.terminate().catch(() => {});
  shaperWorker = false;
  return null;
}

export function clearShapingCache() { cache.clear(); }

export function shapeText(text, { family, size, weight = 400, italic = false, file = null }) {
  if (process.platform !== 'darwin' || unavailable) return null;
  const runKey = JSON.stringify([family, size, weight, italic, file]);
  const key = `${runKey}:${text}`;
  if (cache.has(key)) return cache.get(key);
  try {
    if (!binary) {
      const source = join(dirname(fileURLToPath(import.meta.url)), 'text-shaping.swift');
      const digest = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 20);
      const dir = join(tmpdir(), 'zee-rp-text-shaping');
      mkdirSync(dir, { recursive: true });
      binary = join(dir, `shape-${digest}`);
      if (!existsSync(binary)) {
        const pending = `${binary}-${process.pid}`;
        execFileSync('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', pending], { timeout: 60000 });
        renameSync(pending, binary);
      }
    }
    const request = JSON.stringify({ text, family, size, weight, italic, file });
    // A font loaded from a project stays isolated in a single-request process.
    const systemFont = !file || file.startsWith('/System/Library/Fonts/') || file.startsWith('/System/Library/AssetsV2/');
    const result = (systemFont ? measureSystemText(request) : null) ?? JSON.parse(execFileSync(binary, [request], {
      timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    }));
    for (const [prefix, width] of Object.entries(result.prefixes)) {
      cache.set(`${runKey}:${prefix}`, { width, ascent: result.ascent, descent: result.descent, resolvedFamily: result.resolvedFamily, fileValid: result.fileValid });
    }
    const measurement = { width: result.width, ascent: result.ascent, descent: result.descent, resolvedFamily: result.resolvedFamily, fileValid: result.fileValid };
    cache.set(key, measurement);
    return measurement;
  } catch (error) {
    unavailable = error.message;
    return null;
  }
}

export function getShapingStatus() {
  return { provider: process.platform === 'darwin' && !unavailable ? 'coretext' : 'degraded-estimate', unavailable: unavailable || null };
}
