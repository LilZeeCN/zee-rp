import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertWritable } from './engine.mjs';
export function generateCapabilities() {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./registry.mjs', import.meta.url)), 'dump'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || 'registry dump failed');
  const registry = JSON.parse(run.stdout), esc = text => String(text).replaceAll('|', '\\|');
  const lines = ['# Published command registry', '', '> Generated from registry.mjs. Evidence labels describe historical samples, not full command coverage. See [capabilities.md](capabilities.md) and [public validation](../docs/validation.md).', '',
    '| Command | Script | Purpose | Evidence |', '| --- | --- | --- | --- |'];
  for (const c of registry.commands) lines.push(`| ${esc(c.command)} | ${esc(c.script)} | ${esc(c.summary)} | ${c.evidence} |`);
  lines.push('', '## CLI arguments', '');
  for (const c of registry.commands) lines.push(`- **${c.command}**: \`${c.usage}\``);
  lines.push('', '## Support and research tools', '', '| Script | Purpose | Evidence |', '| --- | --- | --- |');
  for (const row of registry.libScripts) lines.push(`| ${esc(row.script)} | ${esc(row.summary)} | ${row.evidence} |`);
  lines.push('', 'Core checks: `npm test`. Local native integration: `npm run test:native`. Optional MCP integration: `npm run test:mcp`. Historical fixture replay: `npm run test:historical` with your external, hash-matching fixture pack. Native assets are never bundled.', '');
  return lines.join('\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4 || process.argv[2] !== '-o') throw new Error('Usage: node scripts/gen-capabilities.mjs -o <new.md>');
  assertWritable(process.argv[3]); writeFileSync(process.argv[3], generateCapabilities(), { flag: 'wx' });
}
