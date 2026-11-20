#!/usr/bin/env node
// 用当前平台的 Python 3 执行脚本，供 package.json 的测试命令使用。
import { spawnSync } from 'node:child_process';
import { pythonInvocation } from './python.mjs';

try {
  const invocation = pythonInvocation(process.argv.slice(2));
  const result = spawnSync(invocation.command, invocation.args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
