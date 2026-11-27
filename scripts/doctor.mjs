// 跨平台运行环境自检工具：3 秒排查 Node / Python / 依赖 / Chrome / RP9 空白模板 / Axure RP 宿主。
// CLI：node bin/axure.mjs doctor [--json] [--strict]
// 库调用：import { runDoctor } from './doctor.mjs'
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pythonCommand, spawnPythonSync } from './python.mjs';
import { readBlankTemplate } from './blank-template.mjs';
import { findChromeExecutable } from '../studio/cdp.mjs';

function detectAxureHost() {
  const candidates = [];
  if (process.env.AXURE_APP_RP9) candidates.push(process.env.AXURE_APP_RP9);
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Axure RP 9.app');
    if (process.env.HOME) candidates.push(join(process.env.HOME, 'Applications', 'Axure RP 9.app'));
  } else if (process.platform === 'win32') {
    candidates.push('C:\\AxureRP9.exe', 'D:\\AxureRP9.exe');
    if (process.env['ProgramFiles(x86)']) {
      candidates.push(join(process.env['ProgramFiles(x86)'], 'Axure', 'Axure RP 9', 'AxureRP9.exe'));
    }
    if (process.env.ProgramFiles) {
      candidates.push(join(process.env.ProgramFiles, 'Axure', 'Axure RP 9', 'AxureRP9.exe'));
    }
  }
  const found = candidates.find(p => p && existsSync(p)) || null;
  return {
    ok: Boolean(found),
    path: found,
    platformSupported: process.platform === 'darwin' || process.platform === 'win32',
    candidates,
  };
}

function checkBlankTemplate(version) {
  try {
    const { path, source } = readBlankTemplate(version);
    const check = { ok: true, path, source, error: null };
    if (source === 'synthesized') {
      check.limitation = `内置合成工程不带 Heading 1–6、Paragraph、Form Hint、Form Disabled 这 9 个预置样式。需要在 Axure 的样式列表中选用这些样式时，请设置 AXURE_BLANK_TEMPLATE_RP${version} 指向含这些样式的原厂空白模板。`;
    }
    return check;
  } catch (error) {
    return { ok: false, path: null, error: error.message };
  }
}

export function runDoctor({ strict = false } = {}) {
  const isWin = process.platform === 'win32';
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0] || 0);
  const nodeCheck = { ok: nodeMajor >= 18, version: nodeVersion, required: '>=18' };

  let pythonCheck = { ok: false, command: null, version: null, error: null };
  let pythonDepsCheck = {
    ok: false,
    required: { pillow: false, numpy: false, jsonschema: false },
    optional: { scipy: false },
    missingRequired: ['pillow', 'numpy', 'jsonschema'],
    missingOptional: ['scipy'],
  };

  try {
    const py = pythonCommand();
    const ver = spawnPythonSync(['--version'], { encoding: 'utf8', timeout: 5000 });
    const verStr = (ver.stdout || ver.stderr || '').trim().replace(/^Python\s+/i, '');
    pythonCheck = {
      ok: true,
      command: [py.command, ...py.prefix].join(' '),
      version: verStr || null,
      error: null,
    };

    const probeCode = 'import importlib.util, json; mods={"pillow":"PIL","numpy":"numpy","jsonschema":"jsonschema","scipy":"scipy"}; print(json.dumps({k: importlib.util.find_spec(v) is not None for k,v in mods.items()}))';
    const deps = spawnPythonSync(['-c', probeCode], { encoding: 'utf8', timeout: 8000 });
    if (deps.status === 0 && deps.stdout.trim()) {
      const parsed = JSON.parse(deps.stdout.trim());
      const reqKeys = ['pillow', 'numpy', 'jsonschema'];
      const optKeys = ['scipy'];
      const missingRequired = reqKeys.filter(k => !parsed[k]);
      const missingOptional = optKeys.filter(k => !parsed[k]);
      pythonDepsCheck = {
        ok: missingRequired.length === 0,
        required: Object.fromEntries(reqKeys.map(k => [k, Boolean(parsed[k])])),
        optional: Object.fromEntries(optKeys.map(k => [k, Boolean(parsed[k])])),
        missingRequired,
        missingOptional,
      };
    }
  } catch (err) {
    pythonCheck.error = err.message;
  }

  let chromeCheck = { ok: false, path: null, error: null };
  try {
    chromeCheck = { ok: true, path: findChromeExecutable(), error: null };
  } catch (err) {
    chromeCheck.error = err.message;
  }

  const templateCheck = checkBlankTemplate(9);
  const templateCheckRp11 = checkBlankTemplate(11);
  const axureHostCheck = detectAxureHost();

  const capabilities = {
    studioCanvas: nodeCheck.ok && pythonCheck.ok && pythonDepsCheck.ok,
    htmlImportAndChromeVerify: nodeCheck.ok && pythonCheck.ok && pythonDepsCheck.ok && chromeCheck.ok,
    nativeRpWrite: nodeCheck.ok && pythonCheck.ok && pythonDepsCheck.ok && templateCheck.ok,
    officialAxureExport: nodeCheck.ok && pythonCheck.ok && pythonDepsCheck.ok && templateCheck.ok && axureHostCheck.ok,
  };

  const recommendations = [];
  if (!nodeCheck.ok) {
    recommendations.push('请升级 Node.js 至 18+（建议 Node 22 或 24）。');
  }
  if (!pythonCheck.ok) {
    recommendations.push(isWin
      ? '请安装 Python 3.10+ 并设置 $env:ZEE_PYTHON 指向 .venv\\Scripts\\python.exe。'
      : '请安装 Python 3.10+ 并创建 .venv，可用 ZEE_PYTHON 指向 .venv/bin/python。');
  } else if (!pythonDepsCheck.ok) {
    const pkgs = pythonDepsCheck.missingRequired.join(' ');
    recommendations.push(isWin
      ? `& ${pythonCheck.command} -m pip install ${pkgs}`
      : `${pythonCheck.command} -m pip install ${pkgs}`);
  }
  if (pythonDepsCheck.ok && pythonDepsCheck.missingOptional.includes('scipy')) {
    recommendations.push(`可选（截图识别提纯）：${pythonCheck.command || 'python3'} -m pip install scipy`);
  }
  if (!chromeCheck.ok) {
    recommendations.push(isWin
      ? '请安装 Google Chrome / Edge，或设置 $env:CHROME_BIN 指向 chrome.exe（用于 Studio 截图、HTML 导入与免 Axure 真机验收）。'
      : '请安装 Google Chrome / Chromium，或设置 CHROME_BIN 指向浏览器可执行文件（用于 Studio 截图、HTML 导入与免 Axure 真机验收）。');
  }
  if (!templateCheck.ok) {
    recommendations.push(templateCheck.error);
  }

  const coreOk = nodeCheck.ok && pythonCheck.ok && pythonDepsCheck.ok;
  const strictOk = coreOk && capabilities.htmlImportAndChromeVerify && capabilities.nativeRpWrite;
  return {
    ok: strict ? strictOk : coreOk,
    strict,
    platform: process.platform,
    arch: process.arch,
    checks: {
      node: nodeCheck,
      python: pythonCheck,
      pythonDeps: pythonDepsCheck,
      chrome: chromeCheck,
      axureTemplate: templateCheck,
      axureTemplateRp11: templateCheckRp11,
      axureHost: axureHostCheck,
    },
    capabilities,
    recommendations,
  };
}

function formatDoctorText(report) {
  const mark = ok => (ok ? '[OK]  ' : '[MISS]');
  const templateLines = (version, check) => [
    `${mark(check.ok)} RP${version} 空白模板   ${check.path ?? (check.ok ? '内置合成' : check.error)}`,
    ...(check.limitation ? [`       ${check.limitation}`] : []),
  ];
  const lines = [
    `zee-rp 环境自检 (${report.platform}/${report.arch})`,
    `${mark(report.checks.node.ok)} Node.js        ${report.checks.node.version} (要求 ${report.checks.node.required})`,
    `${mark(report.checks.python.ok)} Python         ${report.checks.python.ok ? `${report.checks.python.version} (${report.checks.python.command})` : report.checks.python.error}`,
    `${mark(report.checks.pythonDeps.ok)} Python 依赖    ${report.checks.pythonDeps.ok ? 'pillow / numpy / jsonschema 就绪' : `缺少: ${report.checks.pythonDeps.missingRequired.join(', ')}`}${report.checks.pythonDeps.optional.scipy ? ' (+ scipy)' : ' (可选 scipy 未装)'}`,
    `${mark(report.checks.chrome.ok)} Chrome / CDP   ${report.checks.chrome.ok ? report.checks.chrome.path : '未检测到浏览器'}`,
    ...templateLines(9, report.checks.axureTemplate),
    ...templateLines(11, report.checks.axureTemplateRp11),
    `${mark(report.checks.axureHost.ok)} Axure RP 9     ${report.checks.axureHost.ok ? report.checks.axureHost.path : '未在本机检测到（Studio / HTML 导入 / studio-html 真机验收不受影响）'}`,
    '',
    '可用能力矩阵：',
    `  - Studio 画布与 RP/1 编辑      : ${report.capabilities.studioCanvas ? '可用' : '不可用'}`,
    `  - HTML/URL 导入与免 Axure 验收 : ${report.capabilities.htmlImportAndChromeVerify ? '可用 (studio-html)' : '需先安装 Chrome'}`,
    `  - 原生 .rp 二进制读写生成       : ${report.capabilities.nativeRpWrite ? '可用' : '需先配置 RP9 空白模板'}`,
    `  - 官方 Axure HTML 导出宿主     : ${report.capabilities.officialAxureExport ? '可用' : '未就绪（可用 engine:"studio-html" 替代验收）'}`,
  ];
  if (report.recommendations.length) {
    lines.push('', '修复建议：', ...report.recommendations.map(r => `  * ${r}`));
  }
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');
  const report = runDoctor({ strict });
  console.log(asJson ? JSON.stringify(report, null, 2) : formatDoctorText(report));
  process.exit(report.ok ? 0 : 1);
}
