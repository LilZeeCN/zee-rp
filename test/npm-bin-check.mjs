// npm 包的命令行入口必须能被操作系统直接执行。
//
// 背景：package.json 的 bin 把 `.bin/zee-rp` 链接到 bin/*.mjs。目标文件没有 shebang 时，npm 照样安装成功，
// 但执行会以 ENOEXEC 失败并被 shell 当成脚本解释——`npx zee-rp` 在用户第一面就报错（0.2.0 起存在，
// 首次准备发布 npm 时由隔离安装冒烟发现）。这里同时守住 shebang 与“直接执行可用”两件事。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bins = Object.values(pkg.bin);

test('package.json 声明了命令行入口', () => {
  assert.ok(bins.length >= 2, 'bin 里应当至少有 zee-rp 与 zee-rp-mcp');
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['zee-rp', 'zee-rp-mcp']);
});

test('每个 bin 目标都以 node shebang 开头', () => {
  for (const target of bins) {
    const first = readFileSync(join(root, target), 'utf8').split('\n')[0];
    assert.equal(first, '#!/usr/bin/env node', `${target} 的首行必须是 shebang，否则 npx <bin> 无法执行`);
  }
});

test('bin 目标可以直接执行，不需要显式写在命令里的 node', { skip: process.platform === 'win32' }, () => {
  // CLI：直接跑 doctor，应有输出
  const cli = spawnSync(join(root, pkg.bin['zee-rp']), ['doctor'], { encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(cli.error?.code, 'ENOEXEC', `${pkg.bin['zee-rp']} 无法作为程序执行：${cli.error?.message}`);
  assert.match(cli.stdout + cli.stderr, /zee-rp|Node\.js/, 'CLI 没有输出自检结果');
  // MCP：stdio 服务不响应 --help，用一次 initialize 握手验证入口能启动并报出自身版本
  const hello = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'npm-bin-check', version: '0' } } }) + '\n';
  const mcp = spawnSync(join(root, pkg.bin['zee-rp-mcp']), [], { input: hello, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(mcp.error?.code, 'ENOEXEC', `${pkg.bin['zee-rp-mcp']} 无法作为程序执行：${mcp.error?.message}`);
  const reply = mcp.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(message => message?.id === 1);
  assert.equal(reply?.result?.serverInfo?.name, 'zee-rp', `MCP 入口没有完成 initialize 握手：${(mcp.stderr || '').slice(0, 200)}`);
  assert.equal(reply?.result?.serverInfo?.version, pkg.version, 'MCP 服务报出的版本应当等于 package.json 的版本');
});
