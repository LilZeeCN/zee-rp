#!/usr/bin/env node
// 统一 CLI 入口：node bin/axure.mjs <command> [args...] → 经 AxureSession 透传执行 scripts/ 存量脚本。
// --help 列注册表全部命令与一句话用途；<command> --help 显示该命令 usage；退出码透传子进程退出码。
// 命令名解析只消费 argv[0] 一个词，但先按两词再按一词查注册表——axvg 三个子命令在注册表里各占一条
// （'axvg build' 等），子命令词 'build' 必须原样留在参数里转发给 axvg.mjs。
import { AxureSession } from '../scripts/engine.mjs';
import { getCommand, listCommands } from '../scripts/registry.mjs';

const argv = process.argv.slice(2);

function commandList() {
  return listCommands().map(c => `  ${c.command.padEnd(24)} ${c.summary}`).join('\n');
}

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(`用法: node bin/axure.mjs <command> [args...]\n\n可用命令（node bin/axure.mjs <command> --help 看脚本原生 usage）：\n${commandList()}`);
  process.exit(0);
}

// 两词优先：'axvg build' 命中后 'build' 仍在参数流里；一词命令退化到 argv[0]。
let resolved = null;
for (const words of [2, 1]) {
  const hit = getCommand(argv.slice(0, words).join(' '));
  if (hit) { resolved = hit; break; }
}

if (!resolved) {
  console.error(`未知命令 "${argv.slice(0, 2).join(' ')}"；可用命令：\n${commandList()}`);
  process.exit(1);
}

const args = argv.slice(1); // 只消费命令词本身，其余参数原样转发
if (args.includes('--help') || args.includes('-h')) {
  console.log(`${resolved.command} — ${resolved.summary}\n透传用法: node bin/axure.mjs ${resolved.command} [脚本原参数...]\n脚本 usage: ${resolved.usage}`);
  process.exit(0);
}

try {
  const result = new AxureSession().run(resolved.command, args);
  if (result.stdout.length) process.stdout.write(result.stdout);
  if (result.stderr.length) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
} catch (error) {
  // 引擎拒绝（红线/白名单/未知命令）只走 stderr，不污染 stdout。
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
