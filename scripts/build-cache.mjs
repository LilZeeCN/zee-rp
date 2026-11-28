import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNotProtected, assertWritable } from './engine.mjs';

const groups = ['pages', 'native', 'html', 'verify'];
const maxBytes = 120 * 1024 * 1024;

export function cacheDirectory(root, group) {
  if (!groups.includes(group)) throw new Error(`未知缓存类别：${group}`);
  const dir = join(root, group);
  assertNotProtected(dir);
  assertWritable(dir);
  for (const path of [root, dir]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  }
  return dir;
}

export function touchCache(path) {
  try { utimesSync(path, new Date(), new Date()); } catch { /* Concurrent eviction. */ }
}

function entrySize(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + entrySize(join(path, name)), 0);
  return stat.isFile() ? stat.size : 0;
}

export function pruneBuildCache(root) {
  try {
    const entries = [];
    for (const group of groups) {
      const dir = cacheDirectory(root, group);
      if (!dir || !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const name of readdirSync(dir).filter(name => /^[a-f0-9]{64}$/.test(name))) {
        const path = join(dir, name);
        try {
          const info = lstatSync(path);
          if (info.isSymbolicLink()) continue;
          entries.push({ path, group, key: name, bytes: entrySize(path), lastUsed: info.mtimeMs });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    entries.sort((a, b) => a.lastUsed - b.lastUsed);
    while (bytes > maxBytes && entries.length) {
      const entry = entries.shift();
      rmSync(entry.path, { recursive: true, force: true });
      bytes -= entry.bytes;
    }
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return;
    mkdirSync(root, { recursive: true });
    const staging = join(root, `.manifest-${randomUUID()}.json`);
    try {
      writeFileSync(staging, JSON.stringify({ version: 1, maxBytes, bytes,
        entries: entries.map(({ path, ...entry }) => entry) }, null, 2) + '\n', { flag: 'wx' });
      renameSync(staging, join(root, 'manifest.json'));
    } finally { rmSync(staging, { force: true }); }
  } catch { /* The cache is an optional optimization. */ }
}
