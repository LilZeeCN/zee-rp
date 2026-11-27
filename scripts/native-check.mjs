// 用 Axure 自己的程序集加载 .rp，回答“Axure 是否接受这个文件”。
//
// rp-read 的三零检查是拿我们自己的解码器验证我们自己的编码器：结构全绿不等于 Axure 能读，
// 项目历史上的几层假 ✅ 都源于此。这里换成真正的实现来判。tools/native-assembly/bridge.mjs 在独立进程里
// 用本机 Axure 的程序集无头加载文件，不打开编辑器窗口，每个文件约 3–8 秒。
//
// 结论分三种，不混为一谈：
//   accepted    Axure 的加载器读完并列出页面。这是加载级证据，仍不等于编辑器能保存重开，也不等于预览行为。
//   rejected    Axure 的加载器抛出异常，附原始异常信息。
//   unavailable 本机没有可用判据（非 macOS、未装 Axure 或 .NET SDK）。这时不下结论，不要把结构检查当成 Axure 能读。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected } from './engine.mjs';
import { detectFileVersion } from './version.mjs';

// 判据缺失（环境问题）与文件被拒（加载器异常）共用 E_ASSEMBLY_ 前缀，靠错误码区分。
const ENVIRONMENT_CODES = new Set(['E_ASSEMBLY_ARCH', 'E_ASSEMBLY_IDENTITY', 'E_ASSEMBLY_INSTALL', 'E_ASSEMBLY_PLATFORM', 'E_ASSEMBLY_PROFILE', 'E_ASSEMBLY_RUNTIME']);
export const NATIVE_LOAD_LAYER = '加载级：Axure 自己的程序集读完了文件。不等于编辑器能保存重开，也不等于预览行为。';

export async function nativeCheck(input, { version } = {}) {
  const file = resolve(input);
  assertNotProtected(file);
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
  const detected = detectFileVersion(readFileSync(file));
  // 参数与文件不符不是对文件的判定：在调用判据之前就拦下。
  if (version !== undefined && version !== null && Number(version) !== detected) {
    throw new Error(`--version ${version} 与文件头版本 RP${detected} 不一致。文件版本以文件头为准。`);
  }
  const target = detected;
  const base = { evidence: 'native-load', file, version: target, layer: NATIVE_LOAD_LAYER };
  let bridge;
  try { ({ runAssemblyBridge: bridge } = await import('../tools/native-assembly/bridge.mjs')); }
  catch (error) { return { ...base, status: 'unavailable', reason: error.message, ...UNAVAILABLE_NEXT }; }
  try {
    const { rows = [] } = bridge({ version: target, command: 'inspect', args: [file] });
    const pages = rows.filter(row => row.kind === 'page').map(row => row.values?.[1]);
    return { ...base, status: 'accepted', pages,
      nextAction: '加载级已通过。要声称编辑器可用，还需要 Axure 打开、保存、关闭、重开；要声称预览行为，还需要官方导出与浏览器验证。' };
  } catch (error) {
    if (ENVIRONMENT_CODES.has(error.code)) return { ...base, status: 'unavailable', reason: error.message, ...UNAVAILABLE_NEXT };
    if (error.code === 'E_ASSEMBLY_ARGUMENT') throw error;   // 参数问题（如文件版本与 --version 不符）不是对文件的判定
    return { ...base, status: 'rejected', error: { code: error.code ?? 'E_ASSEMBLY', message: String(error.message ?? error) },
      nextAction: 'Axure 的加载器拒绝了该文件。先看异常信息定位是容器、记录还是某个对象，再用 rp-read / rp_inspect(view:"verify") 对照结构；不要在它之上继续叠加修改。' };
  }
}
const UNAVAILABLE_NEXT = { nextAction: '判据需要 macOS（Apple Silicon 已验证）、本机 Axure 与 .NET SDK；可用 AXURE_APP_RP9 / AXURE_APP_RP11 与 ZEE_DOTNET 指定路径。没有判据时，结构检查通过只能算结构级证据。' };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const at = argv.indexOf('--version');
  const version = at >= 0 ? argv[at + 1] : undefined;
  const valueIndex = at >= 0 ? at + 1 : -1;   // --version 的取值不是位置参数
  const input = argv.filter((arg, index) => !arg.startsWith('--') && index !== valueIndex)[0];
  if (!input || (at >= 0 && !/^(9|11)$/.test(String(version)))) {
    console.error('用法: node native-check.mjs <file.rp> [--version 9|11] [--json]');
    process.exit(1);
  }
  try {
    const result = await nativeCheck(input, { version: version ? Number(version) : undefined });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      const head = { accepted: '接受', rejected: '拒绝', unavailable: '判据不可用' }[result.status];
      console.log(`Axure RP${result.version} 加载${head}：${result.file}`);
      if (result.status === 'accepted') console.log(`页面（${result.pages.length}）：${result.pages.join('、')}`);
      if (result.status === 'rejected') console.log(`异常：${result.error.message.split('\n')[0]}`);
      if (result.status === 'unavailable') console.log(`原因：${result.reason}`);
      console.log(`证据：${result.layer}`);
      console.log(`下一步：${result.nextAction}`);
    }
    process.exit({ accepted: 0, rejected: 2, unavailable: 3 }[result.status]);
  } catch (error) {
    if (json) console.log(JSON.stringify({ status: 'error', message: error.message }, null, 2));
    else console.error(error.message);
    process.exit(1);
  }
}
