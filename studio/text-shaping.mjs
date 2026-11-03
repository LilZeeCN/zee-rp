import { BoundedCache, textWeight } from './bounded-cache.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new BoundedCache({maxEntries:8192,maxWeight:8*1024*1024,weight:textWeight});
let binary;
let unavailable;

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
    const result = JSON.parse(execFileSync(binary, [JSON.stringify({ text, family, size, weight, italic, file })], {
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
