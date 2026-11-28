#!/usr/bin/env node
// 将 scripts/rp-browser-core.mjs 无损同步嵌入 tools/rp-inspector/index.html 的 Blob Worker 内核块。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PATH = join(ROOT, 'scripts', 'rp-browser-core.mjs');
const HTML_PATH = join(ROOT, 'tools', 'rp-inspector', 'index.html');
const START_MARK = '<script id="rp-worker-core" type="text/plain">';
const END_MARK = '</script>';

export function syncInspectorHtml({ check = false } = {}) {
  const core = readFileSync(CORE_PATH, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const html = readFileSync(HTML_PATH, 'utf8');
  const startIdx = html.indexOf(START_MARK);
  if (startIdx < 0) throw new Error(`Missing ${START_MARK} in tools/rp-inspector/index.html`);
  const bodyStart = startIdx + START_MARK.length;
  const endIdx = html.indexOf(END_MARK, bodyStart);
  if (endIdx < 0) throw new Error('Missing closing </script> after rp-worker-core');
  const current = html.slice(bodyStart, endIdx).replace(/\r\n/g, '\n').replace(/^\n|\n$/g, '');
  if (check) {
    if (current !== core) {
      throw new Error('tools/rp-inspector/index.html is out of sync with scripts/rp-browser-core.mjs; run node tools/sync-inspector.mjs');
    }
    return { synced: true, bytes: core.length };
  }
  const updated = `${html.slice(0, bodyStart)}\n${core}\n${html.slice(endIdx)}`;
  writeFileSync(HTML_PATH, updated, 'utf8');
  return { synced: true, updated: current !== core, bytes: core.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const res = syncInspectorHtml({ check });
  console.log(JSON.stringify(res));
}
