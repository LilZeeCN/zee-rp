import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listCommands } from './registry.mjs';
import { assertWritable } from './engine.mjs';
import { runRegression } from '../test/regression.mjs';

export function generateCapabilities() {
  // LIB_SCRIPTS 未导出；用既有 dump 接口取数据，保持注册表逻辑和导出契约不变。
  const dump = spawnSync(process.execPath, [fileURLToPath(new URL('./registry.mjs', import.meta.url)), 'dump'], { encoding: 'utf8' });
  if (dump.status !== 0) throw new Error(dump.stderr || 'registry dump failed');
  const { libScripts } = JSON.parse(dump.stdout);
  const commands = listCommands();
  const snapshots = JSON.parse(readFileSync(new URL('../test/snapshots.json', import.meta.url), 'utf8'));
  const regression = runRegression();
  if (regression.failed) throw new Error(`回归失败 ${regression.failed} 项，拒绝生成通过状态文档`);
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
    '## Fixture 回归状态', '',
    `生成时实际运行：${regression.total} 项断言全部通过，其中既有 parity 23 项。`,
    `快照 ${Object.keys(snapshots).length} 个文件，${Object.keys(regression.categories).length} 类；每件核对 SHA、解析、引用及完整摘要。`,
    '容器内部记录包含对象类计数和完整 payload 语义 SHA，覆盖状态、母版和中继器行模板；顶层交互计数单独保留。',
    '这是已保存样本的离线回归；本次没有重跑 GUI 和预览，历史 GUI 证据仍按原样本范围使用。', '',
    '| 类别 | 样本数 |', '| --- | --- |'
  );
  for (const [category, count] of Object.entries(regression.categories)) lines.push(`| ${esc(category)} | ${count} |`);
  lines.push('', '运行：`node test/regression.mjs`；明确更新基线：`node test/regression.mjs --update`。', '');
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4 || process.argv[2] !== '-o') throw new Error('Usage: node scripts/gen-capabilities.mjs -o <new.md>');
  const output = process.argv[3];
  assertWritable(output);
  writeFileSync(output, generateCapabilities(), { flag: 'wx' });
  console.log(`已生成 ${output}`);
}
