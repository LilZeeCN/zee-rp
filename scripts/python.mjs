// 跨平台 Python 3 解析：Windows 通常提供 python / py，而不是 python3。
// 用 ZEE_PYTHON 可显式指定解释器（例如虚拟环境里的绝对路径）。
import { spawnSync } from 'node:child_process';

// Windows 的 Python 默认按 GBK 读取文件/标准流；本项目源码与规格都是 UTF-8。
// 子进程继承 process.env，设置一次即可覆盖所有 Python 调用点。
process.env.PYTHONUTF8 ??= '1';
process.env.PYTHONIOENCODING ??= 'utf-8';

let cached = null;

export function pythonCommand() {
  if (cached) return cached;
  const candidates = new Set([
    process.env.ZEE_PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python',
    'py',
  ].filter(Boolean));
  for (const command of candidates) {
    const prefix = command === 'py' ? ['-3'] : [];
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 5000 });
    const version = (probe.stdout || probe.stderr || '').match(/^Python (\d+)\.(\d+)/);
    if (probe.status === 0 && version && Number(version[1]) === 3 && Number(version[2]) >= 10) {
      cached = { command, prefix };
      return cached;
    }
  }
  throw new Error('找不到 Python 3。请安装 Python 3.10+ 并加入 PATH，或用 ZEE_PYTHON 指定解释器。');
}

export function pythonInvocation(args) {
  const { command, prefix } = pythonCommand();
  return { command, args: [...prefix, ...args] };
}

export function spawnPythonSync(args, options) {
  const { command, args: invocationArgs } = pythonInvocation(args);
  return spawnSync(command, invocationArgs, options);
}
