// 编排引擎：按注册表把命令名分发到 scripts/ 存量脚本，spawn 透传、参数原样转发，保证零行为改动。
// 安全语义只在引擎层落地（存量脚本不改一行）：
//   红线——任何路径参数（含会话源文件与定位到的输出）物理消解后命中受保护成品即拒绝，输入输出同权。
//     消解为左到右逐组件处理符号链接与 '..'（readlink 只读链接文件自身，链接目标从未被触碰），
//     并在 darwin/win32 这类大小写不敏感文件系统上做大小写折叠比较——堵住大小写变体与符号链接两种
//     resolve() 字符串比较的穿透（两者在本机已实测复现）。
//   白名单——AXURE_WRITE_ROOT（冒号分隔多根）设置时，输出绝对路径必须位于某个根之下，未设置时只查红线；
//     输出定位按脚本真实解析规则取位（前置 flag 形态滤 '--' 后按位置参数序），axvg build 省略 -o 时
//     纳管 spec 同名默认输出。
// 引擎自身不写 stdout（子进程 stdout 以 Buffer 原样返回给调用方），日志与拒绝信息只走 stderr（由调用方打印）。
import { lstatSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCommand, listCommands } from './registry.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// 受保护路径（硬规则），与 registry.mjs 保持同一来源：AXURE_PROTECTED_PATHS 环境变量提供
// 冒号分隔的绝对路径列表，命中任一即拒绝作为任何路径参数（输入或输出）；未设置时为空列表。
function protectedPaths() {
  return [process.env.AXURE_PROTECTED_PATH, ...(process.env.AXURE_PROTECTED_PATHS || '').split(':')].filter(Boolean).map(p => resolve(p));
}

// darwin（APFS/HFS+ 默认卷）与 win32 大小写不敏感；其余平台按大小写敏感精确比较。
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const fold = p => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);

function protectedError(hit) {
  return new Error(`拒绝执行：${hit} 归一化后命中 AXURE_PROTECTED_PATHS 受保护路径，禁止作为任何路径参数（输入或输出）`);
}

// 左到右逐组件物理消解：不预先词法折叠 '..'（符号链接后的 '..' 语义取决于物理父级），
// 每个已消解前缀先与受保护成品折叠比对，命中即刻抛错——因此对受保护成品本体不会发起任何
// lstat/stat（消解永远在触碰它之前停下），readlink 也只读链接文件自身。
// 组件不存在的尾段按词法路径收尾（输出文件通常尚未创建）；链接跳数超限视为环，报错停机（fail-closed）。
function physResolve(input, guard = true) {
  const parts = p => String(p).split(sep).filter(part => part !== '' && part !== '.');
  const anchor = String(input).startsWith('/') ? [] : parts(process.cwd()); // getcwd 返回物理路径
  const queue = [...anchor, ...parts(input)];
  const stack = [];
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift();
    if (part === '..') { stack.pop(); continue; }
    const current = `/${[...stack, part].join(sep)}`;
    if (guard && protectedPaths().some(pp => fold(current) === fold(canonicalProtected(pp)))) throw protectedError(current);
    let stat = null;
    try { stat = lstatSync(current); } catch { stack.push(part); continue; }
    if (stat.isSymbolicLink()) {
      if (++hops > 64) throw new Error(`拒绝执行：路径消解超限（疑似符号链接环）：${input}`);
      const target = readlinkSync(current);
      if (target.startsWith('/')) stack.length = 0;
      queue.unshift(...parts(target));
    } else {
      stack.push(part);
    }
  }
  return `/${stack.join(sep)}`;
}

// 受保护路径的规范形：只物理消解目录链（目录可安全触碰），末段 basename 永不做任何 stat。
const protectedCanonicalCache = new Map();
function canonicalProtected(pp) {
  if (!protectedCanonicalCache.has(pp)) {
    let dir = resolve(dirname(pp));
    try { dir = physResolve(dirname(pp), false); } catch { /* 目录链不可消解时退回词法路径 */ }
    protectedCanonicalCache.set(pp, join(dir, basename(pp)));
  }
  return protectedCanonicalCache.get(pp);
}

// 红线检查：物理消解 + 平台大小写归一后与受保护成品比对；非字符串/空串不可能是路径，直接放行。
export function assertNotProtected(path) {
  if (typeof path !== 'string' || path.length === 0) return;
  physResolve(path); // 命中受保护路径时在消解过程中抛错
}

// 输出检查：先红线，再可选白名单。输出与根都做物理消解（符号链接目录归位），
// 按路径段比较避免 /wr 误匹配 /wr2 这类前缀假阳性；大小写折叠与红线同一策略。
export function assertWritable(path) {
  assertNotProtected(path);
  const roots = (process.env.AXURE_WRITE_ROOT || '').split(':').filter(Boolean);
  if (roots.length === 0 || typeof path !== 'string' || path.length === 0) return;
  const abs = physResolve(path);
  const under = roots.some(root => {
    const base = physResolve(root);
    return fold(abs) === fold(base) || fold(abs).startsWith(`${fold(base)}${sep}`);
  });
  if (!under) throw new Error(`拒绝执行：输出 ${path}（消解为 ${abs}）不在 AXURE_WRITE_ROOT 白名单（${roots.join(':')}）内`);
}

// 注册表 output → 本次调用的输出路径（供白名单定位）。
// index:N 的 N 指 process.argv 索引（argv[2]=第 1 个用户参数），但存量脚本解析位置参数前会滤掉 '--' 前缀
// 的 flag token——duplicate-page --index、add-interaction --page 等前置 flag 形态的输出位会整体后移，
// 故此处按同一滤除规则取第 N-2 个非 flag 位置参数，两种形态都定位到真实输出而非源文件。
// flag:-o 取选项后随值；axvg build 省略 -o 时脚本写 spec 同名默认输出（axvg.mjs:360-361），须一并纳管。
// none 或定位不到返回 null，交给脚本自身用法校验（红线不受影响：全参数扫描独立于本函数）。
function locateOutput(command, args) {
  if (command.output === 'none') return null;
  if (command.output.startsWith('index:')) {
    const positional = args.filter(a => typeof a === 'string' && !a.startsWith('--'));
    const value = positional[Number(command.output.slice(6)) - 2];
    return typeof value === 'string' ? value : null;
  }
  const flag = command.output.slice(5);
  const i = args.indexOf(flag);
  if (i >= 0) return typeof args[i + 1] === 'string' ? args[i + 1] : null;
  if (command.command === 'axvg build' && flag === '-o') {
    const spec = args[0] === 'build' ? args[1] : args[0]; // 透传形态 args 以子命令词 'build' 开头
    return typeof spec === 'string' ? spec.replace(/\.spec\.json$/, '') + '.axvg.json' : null;
  }
  return null;
}

export class AxureSession {
  // source 是可选的会话级输入源（多步编排时的共同上游），同样受红线约束。
  constructor({ source } = {}) {
    this.source = typeof source === 'string' && source.length > 0 ? resolve(source) : null;
    assertNotProtected(this.source);
  }

  // 输出落盘统一检查点（红线 + 可选白名单），run 内部与未来多步编排复用。
  saveAs(path) {
    assertWritable(path);
    return resolve(path);
  }

  // commandName 为注册表命令名（axvg 三个子命令各占一条，如 'axvg build'）；
  // args 是子进程 argv[2..] 的原样转发，因此 axvg 系列的 'build'/'paste'/'selftest' 子命令词留在 args 里。
  run(commandName, args = []) {
    const command = getCommand(commandName);
    if (!command) {
      throw new Error(`未知命令 "${commandName}"；可用命令：${listCommands().map(c => c.command).join('、')}`);
    }
    assertNotProtected(this.source);
    // 红线扫全部字符串参数：注册表 output 只标记输出位，输入位（源 .rp/.rplib/spec）没有机读标记，
    // 逐参数物理消解比对是安全超集——非路径参数不可能消解成受保护绝对路径。
    for (const a of args) assertNotProtected(a);
    const output = locateOutput(command, args);
    if (output !== null) this.saveAs(output); // 白名单只约束输出；输入只查红线。

    // 透传执行：node + 脚本绝对路径 + 原样参数，不经 shell、不改写任何参数。
    const child = spawnSync(process.execPath, [join(SCRIPTS_DIR, command.script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }
}
