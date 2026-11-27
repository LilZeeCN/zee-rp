// 用 Axure 自己的程序集加载 .rp / .rplib，回答“Axure 是否接受这个文件”。
//
// rp-read 的三零检查是拿我们自己的解码器验证我们自己的编码器：结构全绿不等于 Axure 能读，
// 项目历史上的几层假 ✅ 都源于此。这里换成真正的实现来判。tools/native-assembly/bridge.mjs 在独立进程里
// 用本机 Axure 的程序集无头加载文件，不打开编辑器窗口，每个文件约 3–8 秒；
// 传 --compile 时额外执行官方 HTML 编译并扫描 STO 表达式编译错误。
//
// 结论分三种，不混为一谈：
//   accepted    Axure 的加载器读完并列出页面（--compile 时同时通过官方 HTML 编译与零 STO 错误）。
//   rejected    Axure 的加载器或官方编译器抛出异常，附原始异常或 STO 诊断信息。
//   unavailable 本机没有可用判据（非 macOS、未装 Axure 或 .NET SDK）。这时不下结论，不要把结构检查当成 Axure 能读。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected } from './engine.mjs';
import { scanOfficialInteractions } from './official-interactions.mjs';
import { field, parsePayload } from './parse-payload.mjs';
import { readManifest, readRecords } from './rp-records.mjs';
import { detectFileVersion } from './version.mjs';

// 判据缺失（环境问题）与文件被拒（加载器异常）共用 E_ASSEMBLY_ 前缀，靠错误码区分。
const ENVIRONMENT_CODES = new Set(['E_ASSEMBLY_ARCH', 'E_ASSEMBLY_IDENTITY', 'E_ASSEMBLY_INSTALL', 'E_ASSEMBLY_PLATFORM', 'E_ASSEMBLY_PROFILE', 'E_ASSEMBLY_RUNTIME']);
export const NATIVE_LOAD_LAYER = '加载级：Axure 自己的程序集读完了文件。不等于编辑器能保存重开，也不等于预览行为。';
export const NATIVE_COMPILE_LAYER = '编译级：Axure 自己的程序集完成加载并导出官方 HTML，且 STO 表达式编译零错误。仍不等于浏览器预览交互与 GUI 编辑通过。';

export function inspectEditorReadiness(fileBytes, detectedVersion) {
  let versionPart = false;
  let documentSettings = false;
  let hasVersionHistory = false;
  try {
    const manifest = readManifest(fileBytes);
    const partKeys = Object.keys(manifest.value.root.parts ?? {});
    versionPart = partKeys.some(key => key === `${detectedVersion}.version` || (key.startsWith(`${detectedVersion}.`) && key.endsWith('.version')));
  } catch {}
  try {
    const settingsRecord = readRecords(fileBytes).find(record => record.className === 'Axure:DocumentSettings');
    if (settingsRecord) {
      const graph = parsePayload(settingsRecord);
      const root = [...graph.objects.values()].find(object => object.className === 'Axure:DocumentSettings');
      const fileHist = field(root?.body ?? {}, 'FileVersionHistory')?.items ?? [];
      const asmHist = field(root?.body ?? {}, 'AssemblyVersionHistory')?.items ?? [];
      hasVersionHistory = fileHist.length > 0 && asmHist.length > 0;
      documentSettings = hasVersionHistory;
    }
  } catch {}
  return {
    versionPart,
    documentSettings,
    hasVersionHistory,
    upgradeModalRisk: !(versionPart && documentSettings),
  };
}

export async function nativeCheck(input, { version, compile = false } = {}) {
  const file = resolve(input);
  assertNotProtected(file);
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
  const fileBytes = readFileSync(file);
  const detected = detectFileVersion(fileBytes);
  // 参数与文件不符不是对文件的判定：在调用判据之前就拦下。
  if (version !== undefined && version !== null && Number(version) !== detected) {
    throw new Error(`--version ${version} 与文件头版本 RP${detected} 不一致。文件版本以文件头为准。`);
  }
  const target = detected;
  const editorReadiness = inspectEditorReadiness(fileBytes, target);
  const base = {
    evidence: compile ? 'native-compile' : 'native-load',
    file,
    version: target,
    layer: compile ? NATIVE_COMPILE_LAYER : NATIVE_LOAD_LAYER,
    editorReadiness,
  };
  let bridge;
  try { ({ runAssemblyBridge: bridge } = await import('../tools/native-assembly/bridge.mjs')); }
  catch (error) { return { ...base, status: 'unavailable', reason: error.message, ...UNAVAILABLE_NEXT }; }
  try {
    const { rows = [] } = bridge({ version: target, command: 'inspect', args: [file] });
    const pages = rows.filter(row => row.kind === 'page').map(row => row.values?.[1]);
    if (!compile) {
      return {
        ...base,
        status: 'accepted',
        pages,
        nextAction: editorReadiness.upgradeModalRisk
          ? '加载级已通过，但缺少版本自述或 DocumentSettings，编辑器打开可能触发升级弹窗。'
          : '加载级已通过。要声称编辑器可用，还需要 Axure 打开、保存、关闭、重开；要声称预览行为，还需要官方导出与浏览器验证。',
      };
    }
    const compileStage = mkdtempSync(join(tmpdir(), 'zee-native-compile-'));
    try {
      const htmlDir = join(compileStage, 'html');
      bridge({ version: target, command: 'export', args: [file, htmlDir] });
      const scan = scanOfficialInteractions(htmlDir);
      const compileErrors = scan.diagnostics.filter(d => d.severity === 'error');
      const officialCompile = {
        status: compileErrors.length ? 'rejected' : 'accepted',
        pagesScanned: scan.pagesScanned,
        pageFiles: scan.pageFiles,
        errorCount: compileErrors.length,
        errors: compileErrors,
      };
      if (compileErrors.length > 0) {
        return {
          ...base,
          status: 'rejected',
          pages,
          officialCompile,
          error: {
            code: 'E_OFFICIAL_COMPILE',
            message: `官方 HTML 导出发现 ${compileErrors.length} 处 STO 表达式编译错误：${compileErrors[0].page} / ${compileErrors[0].widget ?? '(page)'} -> ${compileErrors[0].expression ?? compileErrors[0].message}`,
          },
          nextAction: '先修复 officialCompile.errors 列出的表达式或动作问题，再重新编译导出。',
        };
      }
      return {
        ...base,
        status: 'accepted',
        pages,
        officialCompile,
        nextAction: '加载级与官方编译级已通过。要声称编辑器可用或浏览器行为正确，仍需对应级验证。',
      };
    } finally {
      rmSync(compileStage, { recursive: true, force: true });
    }
  } catch (error) {
    if (ENVIRONMENT_CODES.has(error.code)) return { ...base, status: 'unavailable', reason: error.message, ...UNAVAILABLE_NEXT };
    if (error.code === 'E_ASSEMBLY_ARGUMENT') throw error;
    return {
      ...base,
      status: 'rejected',
      error: { code: error.code ?? 'E_ASSEMBLY', message: String(error.message ?? error) },
      nextAction: 'Axure 的加载器或官方编译器拒绝了该文件。先看异常信息定位是容器、记录还是某个对象，再用 rp-read / rp_inspect(view:"verify") 对照结构；不要在它之上继续叠加修改。',
    };
  }
}
const UNAVAILABLE_NEXT = { nextAction: '判据需要 macOS（Apple Silicon 已验证）、本机 Axure 与 .NET SDK；可用 AXURE_APP_RP9 / AXURE_APP_RP11 与 ZEE_DOTNET 指定路径。没有判据时，结构检查通过只能算结构级证据。' };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const compile = argv.includes('--compile');
  const at = argv.indexOf('--version');
  const version = at >= 0 ? argv[at + 1] : undefined;
  const valueIndex = at >= 0 ? at + 1 : -1;
  const input = argv.filter((arg, index) => !arg.startsWith('--') && index !== valueIndex)[0];
  if (!input || (at >= 0 && !/^(9|11)$/.test(String(version)))) {
    console.error('用法: node native-check.mjs <file.rp|file.rplib> [--version 9|11] [--compile] [--json]');
    process.exit(1);
  }
  try {
    const result = await nativeCheck(input, { version: version ? Number(version) : undefined, compile });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      const head = { accepted: '接受', rejected: '拒绝', unavailable: '判据不可用' }[result.status];
      console.log(`Axure RP${result.version} ${compile ? '加载与编译' : '加载'}${head}：${result.file}`);
      if (result.pages?.length) console.log(`页面（${result.pages.length}）：${result.pages.join('、')}`);
      if (result.editorReadiness) {
        console.log(`编辑器版本自述：versionPart=${result.editorReadiness.versionPart} documentSettings=${result.editorReadiness.documentSettings} upgradeModalRisk=${result.editorReadiness.upgradeModalRisk}`);
      }
      if (result.officialCompile) {
        console.log(`官方编译：${result.officialCompile.status}（扫描 ${result.officialCompile.pagesScanned}/${result.officialCompile.pageFiles} 页，错误 ${result.officialCompile.errorCount}）`);
      }
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
