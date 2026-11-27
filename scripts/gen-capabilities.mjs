import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listCommands } from './registry.mjs';
import { assertWritable } from './engine.mjs';

export function generateCapabilities() {
  // LIB_SCRIPTS 未导出；用既有 dump 接口取数据，保持注册表逻辑和导出契约不变。
  const dump = spawnSync(process.execPath, [fileURLToPath(new URL('./registry.mjs', import.meta.url)), 'dump'], { encoding: 'utf8' });
  if (dump.status !== 0) throw new Error(dump.stderr || 'registry dump failed');
  const { libScripts } = JSON.parse(dump.stdout);
  const commands = listCommands();
  // 公开主回归（npm test）作为子进程实际跑一遍，读它最后一行的 JSON 汇总；失败就拒绝生成“通过”文档。
  const test = spawnSync(process.execPath, [fileURLToPath(new URL('../test/regression.mjs', import.meta.url))], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const summary = (test.stdout || '').split('\n').filter(Boolean).at(-1);
  let regression;
  try { regression = JSON.parse(summary); } catch { throw new Error(`回归没有输出汇总：${(test.stderr || test.stdout || '').slice(-300)}`); }
  if (test.status !== 0 || regression.failed) throw new Error(`回归失败 ${regression.failed ?? '?'} 项，拒绝生成通过状态文档`);
  const esc = text => String(text).replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const lines = [
    '# 命令注册表与离线回归', '',
    '> 本文件由 registry.mjs 自动生成，勿手编；改注册表后重跑 `node scripts/gen-capabilities.mjs -o <新文件.md>`。',
    '> 登记证据仅描述已有指定样本。实际能力边界以 [capabilities.md](capabilities.md) 和 [验证流程](verification.md) 为准。', '',
    '## 命令总览', '', '| 命令 | 脚本 | 用途 | 输出定位 | 证据层级 |', '| --- | --- | --- | --- | --- |'
  ];
  for (const c of commands) lines.push(`| ${esc(c.command)} | ${esc(c.script)} | ${esc(c.summary)} | ${esc(c.output)} | ${esc(c.evidence)} |`);
  lines.push('', '参数定位（原生 CLI 用法；统一入口使用同一参数顺序）：', '');
  for (const c of commands) lines.push(`- **${c.command}**：\`${c.usage}\``);
  lines.push('', '## 库脚本', '', '| 脚本 | 用途 | 证据层级 |', '| --- | --- | --- |');
  for (const l of libScripts) lines.push(`| ${esc(l.script)} | ${esc(l.summary)} | ${esc(l.evidence)} |`);
  lines.push('', '## 证据标签', '',
    '- `structure`：结构级登记，不能替代 Axure 加载或行为检查。',
    '- `loaded`：指定样本有加载记录。',
    '- `preview`：指定样本有预览记录；具体动作和参数范围见能力表。',
    '- `gui-roundtrip`：指定样本有原生保存、关闭、重开记录；不代表该命令全部组合已验证。',
    '- `channel-a`：Axvg 剪贴板静态路线的登记标签，build/selftest 是离线编码检查，paste 是原生粘贴入口；标签本身不证明任意元件或行为通过。',
    '- `internal`：内部库或研究工具，没有面向用户的能力承诺。', '',
    '## 公开主回归状态', '',
    `生成时实际运行 \`node test/regression.mjs\`：${regression.total} 项断言，${regression.passed} 项通过。`,
    '这是离线回归；本次没有重跑 Axure 加载、保存重开和预览，原生证据仍按各样本的原记录范围使用。', ''
  );
  lines.push('', '运行：`npm test`。', '');
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4 || process.argv[2] !== '-o') throw new Error('Usage: node scripts/gen-capabilities.mjs -o <new.md>');
  const output = process.argv[3];
  assertWritable(output);
  writeFileSync(output, generateCapabilities(), { flag: 'wx' });
  console.log(`已生成 ${output}`);
}
