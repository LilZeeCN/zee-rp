#!/usr/bin/env node
// 素材台账门禁(figcraft "Every asset needs a row" 的等价物):
// assets/ 下每个文件必须被 ATTRIBUTION.md 至少一行的路径前缀覆盖;漏登即红。
// 同时反向校验台账前缀非空目录(台账腐烂也能抓到)。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.url.replace(/^file:\/\//, '').replace(/\/[^/]+$/, ''), '..');
const ASSETS = join(ROOT, 'assets');
const LEDGER = join(ROOT, 'ATTRIBUTION.md');

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const ledger = readFileSync(LEDGER, 'utf8');
const prefixes = [...ledger.matchAll(/^\| `([^`]+)` \|/gm)].map(m => m[1]);
if (!prefixes.length) {
  console.error('ATTRIBUTION.md 中没有解析到任何路径前缀行');
  process.exit(1);
}

const violations = [];
const covered = new Set();
for (const file of listFiles(ASSETS)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const hit = prefixes.find(prefix => rel.startsWith(prefix));
  if (hit) covered.add(hit);
  else violations.push('未登记素材: ' + rel);
}

for (const prefix of prefixes) {
  const dir = join(ROOT, prefix);
  try {
    if (!statSync(dir).isDirectory() && !prefix.endsWith('.json')) continue;
  } catch { continue; }
  if (!covered.has(prefix) && !listFiles(dir).some(f => relative(ROOT, f).split(sep).join('/').startsWith(prefix))) {
    violations.push('台账前缀指向空目录: ' + prefix);
  }
}

if (violations.length) {
  console.error(`test:attribution — ${violations.length} 处违例`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log(`test:attribution — OK(${listFiles(ASSETS).length} 个素材文件全部登记于 ATTRIBUTION.md)`);
