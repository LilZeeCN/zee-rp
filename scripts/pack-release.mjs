import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync, constants } from 'node:fs';
import { dirname, basename, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertWritable } from './engine.mjs';
import { listMcpTools, jobTools } from './mcp-tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXCLUDED = new Set(['expr-schema.mjs', 'widget-schema.mjs', 'gen-capabilities.mjs']);
const DOCS = ['capabilities.md', 'verification.md', 'rp-workflow.md', 'axvg-format.md', 'screenshot-workflow.md', 'html-workflow.md', 'adaptive-views.md', 'repeaters.md', 'troubleshooting.md'];
const sha = data => createHash('sha256').update(data).digest('hex');

export function packRelease(output) {
  assertWritable(output);
  output = join(realpathSync.native(dirname(output)), basename(output));
  assertWritable(output);
  if (existsSync(output)) throw new Error('发布目录必须是新目录');
  const dump = spawnSync(process.execPath, [join(ROOT, 'scripts/registry.mjs'), 'dump'], { encoding: 'utf8' });
  if (dump.status !== 0) throw new Error(dump.stderr);
  const registry = JSON.parse(dump.stdout);
  const libs = registry.libScripts.filter(row => !EXCLUDED.has(row.script));
  const scripts = [...new Set([...registry.commands, ...libs].map(row => row.script)), 'registry.mjs', 'gui-roundtrip.swift'].sort();
  const paths = [
    ...scripts.map(f => `scripts/${f}`), 'bin/axure.mjs', 'bin/mcp.mjs',
    'test/parity-check.mjs', 'test/jobs-check.mjs', 'test/baseline-shas.json', 'test/baseline-policy.json',
    ...DOCS.map(f => `references/${f}`), 'assets/dashboard-example.spec.json',
    'README.md', 'LICENSE', '.gitignore', 'package.json', 'package-lock.json'
  ].sort();
  const published = new Set([...paths, 'SKILL.md', 'references/commands-generated.md', 'release-manifest.json']);
  mkdirSync(output);
  for (const path of paths) {
    mkdirSync(dirname(join(output, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(output, path), constants.COPYFILE_EXCL);
  }
  // 发布副本只移除不分发的研究/文档生成库数据行；命令与引擎逻辑保持原样。
  const regPath = join(output, 'scripts/registry.mjs');
  let source = readFileSync(regPath, 'utf8');
  const start = source.indexOf('const LIB_SCRIPTS = [');
  const end = source.indexOf('\n];', start) + 4;
  if (start < 0 || end < start) throw new Error('无法定位注册表库数据');
  source = source.slice(0, start) + 'const LIB_SCRIPTS = ' + JSON.stringify(libs, null, 2) + ';' + source.slice(end);
  source = source.replace(registry.source, 'scripts').replace(registry.evidenceSource, 'references/capabilities.md');
  writeFileSync(regPath, source);

  const baselinePath = join(output, 'test/baseline-shas.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  for (const name of Object.keys(baseline)) if (EXCLUDED.has(name)) delete baseline[name];
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  writeFileSync(join(output, 'test/baseline-policy.json'), JSON.stringify({ expectedScriptCount: Object.keys(baseline).length }, null, 2) + '\n');
  const pkgPath = join(output, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.scripts = { test: 'node test/parity-check.mjs', 'test:jobs': 'node test/jobs-check.mjs', mcp: 'node bin/mcp.mjs' };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const lockPath = join(output, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages[''].license = pkg.license;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

  for (const path of paths.filter(p => p.endsWith('.md'))) {
    const target = join(output, path);
    const content = readFileSync(target, 'utf8').replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, href) => {
      href = href.replace(/^<|>$/g, '');
      if (/^(https?:|#)/.test(href)) return whole;
      const base = href.split('#')[0].replace(/:\d+$/, '');
      const abs = resolve(dirname(join(ROOT, path)), base);
      const local = relative(ROOT, abs);
      if (published.has(local)) return `[${label}](${relative(dirname(path), local) || './'}${href.includes('#') ? '#' + href.split('#')[1] : ''})`;
      return `${label}（本地研究参考不随发布包）`;
    }).replace(/\/Users\/[^\s`)<>]+/g, '本地研究路径')
      .replace('> 更新注册表后运行 `node scripts/gen-capabilities.mjs -o <新文件.md>`。', '> 发布命令表由 `node scripts/pack-release.mjs -o <新目录>` 生成；研究回归生成器不随发布包。');
    writeFileSync(target, content);
  }
  const esc = s => String(s).replaceAll('|', '\\|');
  const lines = ['# 发布命令注册表', '', '> 由打包器根据发布注册表自动生成；勿手编。样本证据边界见 capabilities.md。', '', '| 命令 | 脚本 | 用途 | 输出定位 | 登记证据 |', '| --- | --- | --- | --- | --- |'];
  for (const c of registry.commands) lines.push(`| ${esc(c.command)} | ${esc(c.script)} | ${esc(c.summary)} | ${esc(c.output)} | ${esc(c.evidence)} |`);
  lines.push('', 'CLI 参数：', '');
  for (const c of registry.commands) lines.push(`- **${c.command}**：\`${c.usage}\``);
  lines.push('', '库脚本：', '', '| 脚本 | 用途 | 登记证据 |', '| --- | --- | --- |');
  for (const l of libs) lines.push(`| ${esc(l.script)} | ${esc(l.summary)} | ${esc(l.evidence)} |`);
  lines.push('', '`channel-a` 是静态剪贴板路线登记标签，不能当作任意元件或行为通过。其余证据标签只适用 capabilities.md 的指定样本。', '',
    '研究 fixture 与快照不随发布包；本包没有实时 fixture 全绿结论。运行 `npm test` 可在用户本机模板上执行 23 项对拍/路径检查。', '');
  writeFileSync(join(output, 'references/commands-generated.md'), lines.join('\n'), { flag: 'wx' });
  writeFileSync(join(output, 'SKILL.md'), '---\nname: zee-rp\ndescription: 读取、加工 Axure RP 11 原型，使用统一 CLI、可选 MCP 和 macOS GUI roundtrip jobs。\n---\n\n# zee-rp\n\n先读 [README](README.md)、[能力边界](references/capabilities.md) 和 [验证流程](references/verification.md)。使用 `node bin/axure.mjs --help` 查询命令，输出必须使用新文件名；结构通过不等于 GUI、预览或编辑通过。空白模板及元件库来自用户本机 Axure，不随代码包提供。MCP 配置、任务句柄和取消行为见 README。研究材料及原型样本不随发布包。\n', { flag: 'wx' });
  const validate = spawnSync(process.execPath, [regPath, 'validate'], { encoding: 'utf8' });
  if (validate.status !== 0) throw new Error(validate.stderr);
  const files = {};
  const walk = dir => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else files[relative(output, path)] = sha(readFileSync(path));
    }
  };
  walk(output);
  const manifest = { commands: registry.commands.length, mcpTools: listMcpTools().length + jobTools.length, kernelScripts: Object.keys(baseline).length, files };
  writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output, files: Object.keys(files).length, commands: manifest.commands, mcpTools: manifest.mcpTools, kernelScripts: manifest.kernelScripts };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4 || process.argv[2] !== '-o') throw new Error('Usage: node scripts/pack-release.mjs -o <new-directory>');
  console.log(JSON.stringify(packRelease(process.argv[3]), null, 2));
}
