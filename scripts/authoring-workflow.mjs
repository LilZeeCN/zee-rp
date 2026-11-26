import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNotProtected, assertWritable, defaultWriteRoot } from './engine.mjs';
import { pythonInvocation } from './python.mjs';
import { appExists, supportedVersions, templateCandidates, tryDetectFileVersion } from './version.mjs';
import { previewPrototype, verifyOfficialPreview } from './preview-runtime.mjs';
import { reviewImageStructure } from './image-structure.mjs';
import { findChromeExecutable } from '../studio/cdp.mjs';
import { listImplementationFiles } from '../studio/source-fingerprint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE_DIR = join(ROOT, 'examples/authoring');
const ASSEMBLY_BRIDGE = 'tools/native-assembly/bridge.mjs';
const ASSEMBLY_WORKER = 'tools/native-assembly/Worker.cs';
const invoke = promisify(execFile);

export const mcpInstructions = [
  'Create an editable Axure .rp from RP/1 with generate_prototype. Use prototype_recipe for runnable examples, includeImage:true for direct visual review, and diagnose_prototype to repair source errors. For a free canvas project use studio_describe(topic="workflow") before writing.',
  'Use revise_prototype to edit an existing RP/1 project with its .rp; preserve the shared baseline for native edits.',
  'Use export_prototype for official Axure HTML from an existing .rp, and verify_prototype to run real clicks, drags, swipes, fills, waits and geometry/state assertions in headless Chrome. Use gui_roundtrip when evidence must include editor open/save/reopen. Report structure, HTML export and browser behavior as separate results.',
].join(' ');
const digest = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => { assertNotProtected(path); return digest(readFileSync(path)); };
const startedAt = new Date().toISOString();
export const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'))).version;
function implementation() {
  const sourceDirs = ['scripts', 'bin', 'studio', 'examples/authoring'];
  const files = ['package.json', 'references/rp-language.schema.json', ...sourceDirs.flatMap(listImplementationFiles),
    ...[ASSEMBLY_BRIDGE, ASSEMBLY_WORKER, 'examples/rp-language/native-gestures.rp1', 'examples/rp-language/carousel-slider-captcha.rp1'].filter(path => existsSync(join(ROOT, path)))];
  const packsRoot = join(ROOT, 'examples/studio/reference-packs');
  if (existsSync(packsRoot)) for (const name of readdirSync(packsRoot)) {
    for (const file of ['manifest.json','source.json']) {
      const relative = `examples/studio/reference-packs/${name}/${file}`;
      if (existsSync(join(ROOT, relative))) files.push(relative);
    }
  }
  return Object.fromEntries(files.sort().map(file => [file, fileHash(join(ROOT, file))]));
}
const loadedFiles = implementation();
const loadedFingerprint = digest(JSON.stringify(loadedFiles));

export const recipes = [
  { id: 'mobile-cards', name: '移动学习卡片', file: 'mobile-cards.rp1', pages: ['today', 'review', 'stats'],
    scenario: '今日计划 → 翻卡自测 → 标记掌握 → 跨页进度',
    customize: ['应用标题：/name', '主题色：/palette/brand', '卡片内容：/components/StudyCard/root'] },
  { id: 'list-detail', name: '列表与详情', file: 'list-detail.rp1', pages: ['list', 'detail'],
    scenario: '选择列表项 → 详情切换 → 收藏 → 空状态 → 恢复列表',
    customize: ['应用标题：/name', '列表内容：/datasets/resources/rows', '共享卡片：/components/ResourceCard/root'] },
  { id: 'step-form', name: '分步表单', file: 'step-form.rp1', pages: ['form', 'result'],
    scenario: '空输入提示 → 填写 → 下一步 → 返回保留输入 → 提交结果 → 重置',
    customize: ['应用标题：/name', '主题色：/palette/brand', '表单字段：form 页面逻辑 ID'] },
  { id: 'native-gestures', name: '原生轮播、手势与输入长度', file: '../rp-language/native-gestures.rp1', pages: ['demo'],
    scenario: '轮播启动、停止、重启 → 左右滑动 → 双轴拖动与松手复位 → 输入长度上限',
    customize: ['面板的切态与 repeatInterval', 'onSwipeLeft / onSwipeRight', '拖动 axis 与 onDragDrop 复位', '文本框 maxLength'] },
  { id: 'carousel-slider-captcha', name: '同步轮播与有界滑块拼图验证', file: '../rp-language/carousel-slider-captcha.rp1', pages: ['demo'],
    scenario: '自动轮播+@panel.state指示器同步+滑动重启计时 → within有界水平拖滑块 → ±2px自动吸附校准与失败复位',
    customize: ['onStateChange 读取 @banner.state 同步指示器', 'drag-x 的 bounds: { within } 轨道边界', 'dragdrop 中 @piece.x 与 @target.x 容差判断与自动吸附'] },
];

export function recipeSource(id) {
  const recipe = recipes.find(r => r.id === id);
  if (!recipe) throw Object.assign(new Error(`未知范例 ${id}；可用：${recipes.map(r => r.id).join('、')}`), { code: 'E_RECIPE' });
  return join(RECIPE_DIR, recipe.file);
}

export const AUTHORING_CHEATSHEET = {
  header: 'rp/1 title="应用名称" domain="mobile" device="iphone-16-pro" theme="mobile-hifi"',
  zeroCalcSizing: '纵向容器/卡片/多行文本/动态面板/中继器一律推荐 [fillxhug]（或省略尺寸自动推导），编译器自动测量包裹高度与面板最高状态，无需手算像素高度。',
  topLevelTabBar: '顶层声明 tab-bar: 即可自动注入所有 phone-shell 页面并自动激活当前页与绑定跨页跳转（单页不显示可设 tabBar=false）。',
  highLevelMacros: [
    'stat-row #stats [fillxhug] gap=10 items=[{"label":"今日目标","value":"=var.done","sub":"已完成","color":"$brand"},{"label":"掌握率","value":"86%","sub":"+12%","color":"$success"}]',
    'list-item #item1 [fillxhug] tag="高频" tagTone="brand" title="间隔重复法" subtitle="艾宾浩斯记忆曲线" rightBadge="进行中" rightTone="success" goto="detail"',
    'card #hero [fillxhug] tag="今日重点" title="核心概念复盘" subtitle="预计 10 分钟" body="完成 3 张高频卡片自测" rightBadge="必做" actionText="开始复习" goto="review"',
    'panel #view_panel [fillxhug] tabs=["清单视图","看板视图"]: 后跟 :state list 与 :state board，自动生成顶部分段切换栏与状态切换交互',
  ],
  eventShorthands: [
    'goto="page_id"（属性简写，直接跳页）',
    'onClick: goto page_id | set-panel-state panel_id state_id | set $var = expr',
    'JSON onClick 支持字符串简写：["goto review", "view_panel.board", "$done = var.done + 1"]',
  ],
  patchOperations: [
    '属性修改：{"target": "today/headline", "property": "text", "value": "新文案"}',
    '新增节点（支持 RP/1 DSL 字符串或 JSON）：{"op": "add-node", "target": "today/shell", "value": "card #tip [fillxhug] title=\\"提示\\" body=\\"内容\\""}（亦可用 after/before 兄弟节点 ID 定位插入位置）',
    '替换节点：{"op": "replace-node", "target": "today/intro", "value": "label #intro \\"新说明\\" [fillxhug] fontSize=13 color=$muted"}',
    '删除节点：{"op": "remove-node", "target": "today/intro"}',
  ],
};

const tokenInvocation = pythonInvocation(['-B', '-c', `import json,sys
sys.path.insert(0, sys.argv[1])
from rp_language import COLOR_TOKENS, COLOR_TOKEN_ALIASES, DEVICE_CANVAS_PRESETS, THEMES
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, SPACING_TOKENS, RADIUS_TOKENS
print(json.dumps(dict(fontSize=FONT_SIZE_TOKENS, fontWeight=FONT_WEIGHT_TOKENS,
 spacing=SPACING_TOKENS, radius=RADIUS_TOKENS,
 colorTokens=sorted({'$'+c for c in COLOR_TOKENS} | set(COLOR_TOKEN_ALIASES)),
 themes=sorted(THEMES), devices={k:[v['w'],v['h']] for k,v in DEVICE_CANVAS_PRESETS.items()})))`, join(ROOT, 'scripts')]);
const tokenQuery = spawnSync(tokenInvocation.command, tokenInvocation.args, { encoding: 'utf8' });
if (tokenQuery.status !== 0) throw new Error(tokenQuery.stderr || 'Unable to read compiler token catalog');
export const AUTHORING_TOKENS = JSON.parse(tokenQuery.stdout);

export const AUTHORING_GOTCHAS = [
  'iphone-16-pro 逻辑视口为 393x852；iphone-17 为 402x874。现代机身各外扩 20px；devices 表为逻辑视口，页面不要填写外框尺寸。',
  'autoHeal 默认 false，与 CLI 一致；显式 true 时会完整重验并回退引入新错误的变更，详情记录在 audit.autoHeal。',
  'generate_prototype 默认返回 contactSheet（pages-sheet.png 全页面横向拼图）与 statesSheet（states-sheet.png 全状态拼图），一次看图即可巡检全量页面与面板状态。',
];

export function recipeCatalog({ recipe, includeSource = false } = {}) {
  const selection = recipe ? recipes.filter(r => r.id === recipe) : recipes;
  if (!selection.length) recipeSource(recipe);
  return { status: 'completed', recipes: selection.map(r => ({ ...r, source: recipeSource(r.id),
    ...(includeSource ? { sourceText: readFileSync(recipeSource(r.id), 'utf8') } : {}),
    generate: { tool: 'generate_prototype', arguments: { recipe: r.id, output: `${r.id}.rp` } },
  })), cheatsheet: AUTHORING_CHEATSHEET, tokens: AUTHORING_TOKENS, gotchas: AUTHORING_GOTCHAS,
  workflow: ['选范例或提交 RP/1 源码（善用 [fillxhug]、stat-row、list-item、card 简写与顶层 tab-bar）',
    '调用 generate_prototype 一次生成并直接查看 contactSheet / statesSheet 拼图',
    '使用 revise_prototype 按逻辑 ID 改属性或增删改节点（支持直接传 .rp1 片段）',
    '需要官方 HTML 时，把生成结果的 output 作为 export_prototype.rp；用真实浏览器验收交互'], guide: join(ROOT, 'references/authoring-workflow.md') };
}

export function runWorkflow(command, source, extra = {}) {
  if (typeof source === 'string' && source.trimStart().startsWith('{')) source = JSON.parse(source);
  if (typeof source === 'string') { source = resolve(source); assertNotProtected(source); }
  const workflowInvocation = pythonInvocation(['-B', join(ROOT, 'scripts/rp_workflow.py')]);
  const proc = spawnSync(workflowInvocation.command, workflowInvocation.args, {
    input: JSON.stringify({ command, source, ...extra }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || 'RP/1 workflow process failed');
  return JSON.parse(proc.stdout);
}

export function runtimeInfo(toolList) {
  const disk = implementation();
  const changedFiles = [...new Set([...Object.keys(loadedFiles), ...Object.keys(disk)])]
    .filter(path => loadedFiles[path] !== disk[path]);
  const compilerKeys = ['scripts/rp_language.py', 'scripts/rp_dsl.py', 'scripts/proto.py', 'scripts/rp_workflow.py', 'scripts/mcp-tools.mjs', 'scripts/authoring-workflow.mjs'];
  const compilerHashes = Object.fromEntries(compilerKeys.filter(k => disk[k] || loadedFiles[k]).map(k => [k, { loaded: loadedFiles[k] ?? null, disk: disk[k] ?? null }]));
  return { status: 'completed', name: 'zee-rp', version: packageVersion, root: ROOT, pid: process.pid, startedAt,
    fingerprint: loadedFingerprint, diskFingerprint: digest(JSON.stringify(disk)),
    trackedFileCount: Object.keys(disk).length, compilerHashes,
    restartRequired: changedFiles.length > 0, changedFiles,
    toolCount: toolList.length, toolSchemaHash: digest(JSON.stringify(toolList)),
    python: pythonEnvironment(),
    host: { platform: process.platform, node: process.version, nativeTarget: 9,
      axureInstalled: appExists(9), blankTemplate: templateCandidates(9).find(c => existsSync(c.path))?.path ?? null,
      officialHtml: {
        tool: 'export_prototype',
        verifyTool: 'verify_prototype',
        platformSupported: process.platform === 'darwin' && process.arch === 'arm64',
        discoveredVersions: supportedVersions().filter(appExists),
        chromeAvailable: (() => { try { findChromeExecutable(); return true; } catch { return false; } })(),
        generatorSettings: 'fresh-defaults',
      } },
    nextAction: changedFiles.length ? '磁盘实现已变化，请重新连接 MCP 以加载一致版本；Python 子进程每次读取磁盘实现。'
      : '当前服务与磁盘指纹一致（含编译器与 Studio 服务/前端）。若客户端缺少工具，重新连接以刷新工具清单。' };
}

export function pythonEnvironment() {
  const envInvocation = pythonInvocation(['-B', '-c', `import json,sys,importlib
modules={}
for name in ('PIL','numpy','scipy'):
 try:
  importlib.import_module(name); modules[name]=True
 except ImportError: modules[name]=False
print(json.dumps({'executable':sys.executable,'version':sys.version.split()[0],'imageModules':modules,'missingImageDependencies':[k for k,v in modules.items() if not v]}))`]);
  const proc = spawnSync(envInvocation.command, envInvocation.args, { encoding: 'utf8', timeout: 10000 });
  return proc.status === 0 ? JSON.parse(proc.stdout) : { error: proc.error?.message ?? proc.stderr.trim(), missingImageDependencies: ['python3-runtime'] };
}

const pathOccupied = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
function failIfOutputExists(error, path) {
  if (error?.code === 'EEXIST')
    throw Object.assign(new Error(`改稿输出已存在，请使用新文件名：${path}`), { code: 'E_OUTPUT_EXISTS' });
  throw error;
}
function copyTreeExclusive(fromDir, toDir, onRootCreated) {
  try {
    mkdirSync(toDir);
  } catch (error) {
    failIfOutputExists(error, toDir);
  }
  onRootCreated?.();
  const copyChildren = (src, dst) => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const dstPath = join(dst, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(dstPath);
        copyChildren(srcPath, dstPath);
      } else {
        copyFileSync(srcPath, dstPath, constants.COPYFILE_EXCL);
      }
    }
  };
  copyChildren(fromDir, toDir);
}

export function revisePrototype(input, { generate, sync }) {
  const { source, rp, operations, expectedHash, expectedRpSha256, dryRun = false, prefer = 'fail', resolutions } = input;
  const sourcePath = resolve(source), rpPath = resolve(rp);
  assertNotProtected(sourcePath); assertNotProtected(rpPath);
  if (!existsSync(`${rpPath}.baseline.json`))
    throw Object.assign(new Error('缺少共同基线；请先使用 generate_prototype 创建带基线的工程，或对已有文件使用原生编辑工具。'), { code: 'E_BASELINE_MISSING' });
  const originalHashes = new Map([sourcePath, rpPath, `${rpPath}.baseline.json`].map(path => [path, fileHash(path)]));
  if (expectedRpSha256 && originalHashes.get(rpPath) !== expectedRpSha256)
    throw Object.assign(new Error('原型已变化，请读取最新状态后重试。'), { code: 'E_STALE_SYNC_STATE' });
  const writeRoot = defaultWriteRoot();
  let output = input.output && input.output !== 'auto' ? resolve(writeRoot, input.output) : null;
  if (!dryRun && !output) {
    const stem = rpPath.replace(/\.rp$/i, '').replace(/-v\d+$/, '');
    for (let v = 2; ; v++) {
      const candRp = `${stem}-v${v}.rp`;
      const candSrc = `${stem}-v${v}${extname(sourcePath)}`;
      if (!pathOccupied(candRp) && !pathOccupied(candSrc) && !pathOccupied(`${candRp}.baseline.json`) && !pathOccupied(`${candRp}.assets`)) {
        output = candRp;
        break;
      }
    }
  }
  const outSource = input.outSource ? resolve(writeRoot, input.outSource) : output ? output.slice(0, -3) + extname(sourcePath) : null;
  if (!dryRun && (!output || extname(output) !== '.rp')) throw new Error('改稿需要新的 output .rp 路径；只查看影响请传 dryRun:true。');
  if (outSource && !['.rp1', '.json'].includes(extname(outSource))) throw new Error('outSource 必须是 .rp1 或 .json。');
  const assets = output && `${output}.assets`;
  const destinations = [output, outSource, output && `${output}.baseline.json`, assets].filter(Boolean);
  for (const path of destinations) {
    assertWritable(path);
    if (pathOccupied(path)) throw Object.assign(new Error(`改稿输出已存在，请使用新文件名：${path}`), { code: 'E_OUTPUT_EXISTS' });
  }
  const parent = dirname(output ?? rpPath);
  assertWritable(join(parent, '.revision'));
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, '.revision-'));
  const published = [];
  try {
    const patched = runWorkflow('patch', sourcePath, { operations, expectedHash, format: extname(sourcePath) });
    if (!patched.ok) return { status: 'failed', stage: 'source-patch', ...patched };
    const candidateSource = join(stage, 'candidate' + extname(sourcePath));
    writeFileSync(candidateSource, patched.sourceText);
    const mergedSource = join(stage, 'merged' + extname(outSource ?? sourcePath));
    const merged = sync({ mode: 'merge', source: candidateSource, rp: rpPath, outSource: mergedSource,
      prefer, resolutions, expectedRpSha256: originalHashes.get(rpPath) });
    if (!merged.ok) return { ...merged, source: sourcePath, stage: merged.stage ?? 'merge', impact: patched.diff };
    const restored = runWorkflow('restore-tokens', candidateSource, { merged: mergedSource, format: extname(mergedSource) });
    if (!restored.ok) return { status: 'failed', stage: 'source-preservation', ...restored };
    writeFileSync(mergedSource, restored.sourceText);
    const summary = { status: dryRun ? 'planned' : 'completed', impact: patched.diff, sync: merged.summary,
      operations: patched.operations, restoredTokenReferences: restored.restoredTokenReferences, originalFilesPreserved: true };
    if (dryRun) return { ...summary, verification: { semantic: true, nativePreview: false } };
    const built = generate({ source: mergedSource, output: join(stage, 'result.rp'), compact: false });
    if (built.status !== 'completed') return built;
    for (const [path, hash] of originalHashes) if (fileHash(path) !== hash)
      throw Object.assign(new Error(`改稿过程中输入已被修改：${path}`), { code: 'E_CONCURRENT_MODIFICATION' });
    copyTreeExclusive(built.artifacts.directory, assets, () => published.push(assets));
    const rebase = value => {
      if (typeof value === 'string') return value.replaceAll(built.artifacts.directory, assets)
        .replaceAll(mergedSource, outSource).replaceAll(built.output, output).replaceAll(stage, assets);
      if (Array.isArray(value)) return value.map(rebase);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v)]));
      return value;
    };
    const rewriteReports = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) rewriteReports(path);
        else if (entry.name.endsWith('.json')) writeFileSync(path, JSON.stringify(rebase(JSON.parse(readFileSync(path, 'utf8'))), null, 2) + '\n');
      }
    };
    rewriteReports(assets);
    const durable = rebase(built);
    for (const [from, to] of [[mergedSource, outSource], [built.output, output]]) {
      mkdirSync(dirname(to), { recursive: true });
      try { copyFileSync(from, to, constants.COPYFILE_EXCL); }
      catch (error) { failIfOutputExists(error, to); }
      published.push(to);
    }
    const baseline = rebase(JSON.parse(readFileSync(built.baseline, 'utf8')));
    baseline.outputRp = output; baseline.sourcePath = outSource;
    baseline.rpSha256 = fileHash(output); baseline.sourceSha256 = fileHash(outSource);
    try { writeFileSync(`${output}.baseline.json`, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { failIfOutputExists(error, `${output}.baseline.json`); }
    published.push(`${output}.baseline.json`);
    const report = { ...summary, output, source: outSource, baseline: `${output}.baseline.json`,
      sha256: fileHash(output), previews: durable.previews, artifacts: durable.artifacts,
      ...(durable.contactSheet ? { contactSheet: durable.contactSheet } : {}),
      ...(durable.statesSheet ? { statesSheet: durable.statesSheet } : {}),
      verification: built.verification,
      structure: built.structure, eventCoverage: built.eventCoverage,
      report: join(assets, 'revision-report.json') };
    writeFileSync(report.report, JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    for (const path of published) rmSync(path, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function exportPrototype({ rp, output, cwd, projectDir }) {
  const workDir = resolve(cwd ?? projectDir ?? defaultWriteRoot());
  const source = resolve(workDir, rp);
  let rpVersion;
  let stage = 'input';
  try {
    assertNotProtected(source);
    if (extname(source).toLowerCase() !== '.rp') {
      throw Object.assign(new Error('rp 需要指向已存在的 Axure .rp 文件。'), { code: 'E_HTML_RP' });
    }
    const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const header = Buffer.alloc(8);
      if (fstatSync(fd).isFile() && readSync(fd, header, 0, header.length, 0) === header.length) {
        rpVersion = tryDetectFileVersion(header);
      }
    } finally {
      closeSync(fd);
    }
    if (!rpVersion) {
      throw Object.assign(new Error('无法识别 RP9 或 RP11 的文件头。'), { code: 'E_HTML_RP' });
    }
    stage = 'output';
    const target = output === undefined ? source.slice(0, -3) + '-html' : resolve(workDir, output);
    assertWritable(target);
    if (!existsSync(dirname(target))) {
      throw Object.assign(new Error('输出目录的父目录必须先存在。'), { code: 'E_HTML_OUTPUT_PARENT' });
    }
    if (lstatSync(target, { throwIfNoEntry: false })) {
      throw Object.assign(new Error('输出路径已存在。'), { code: 'E_HTML_OUTPUT_EXISTS' });
    }
    stage = 'assembly';
    const { stdout } = await invoke(process.execPath, [join(ROOT, ASSEMBLY_BRIDGE), 'export', String(rpVersion), source, target]);
    const { output: htmlDir, entry, identity, generatorSettings } = JSON.parse(stdout);
    return {
      status: 'completed', rp: source, rpVersion, output: htmlDir, entry, axureBuild: identity.build, generatorSettings,
      verification: { officialHtmlExported: true, browserLoaded: false, behaviorVerified: false },
      nextAction: '可用 verify_prototype(html=output, steps=[...]) 在无头 Chrome 中直接验证点击、滑动、拖动与状态/坐标断言，或打开输出目录中的 start.html 人工查看。',
    };
  } catch (error) {
    let nativeError;
    if (error.stderr) {
      try { nativeError = JSON.parse(error.stderr.trim()); } catch { /* Keep the original error. */ }
    }
    const code = nativeError?.code ?? (typeof error.code === 'string' && error.code.startsWith('E_HTML_')
      ? error.code : { input: 'E_HTML_RP', output: 'E_HTML_OUTPUT', assembly: 'E_HTML_EXPORT' }[stage]);
    const nextAction = stage === 'input' ? '使用 generate_prototype 返回的 output，或指定一份可读取的 RP9/RP11 .rp。'
      : stage === 'output' || code === 'E_ASSEMBLY_OUTPUT' ? '为 output 指定一个父目录已存在、尚未创建的输出目录。'
      : '用 runtime_info 查看宿主，检查对应 Axure 安装、已验证构建和本机 .NET。';
    return { status: 'failed', stage, ...(rpVersion ? { rpVersion } : {}),
      diagnostics: [{ code, message: (nativeError?.message ?? error.message).slice(0, 1400), nextAction }] };
  }
}

const sourceSchema = { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }], description: 'RP/1 源码 .rp1/.json 路径或 JSON 对象。' };
export function authoringTools({ generate, sync, listTools }) {
  return [
    { name: 'review_image_structure', description: '只读审阅图片重建的 trace spec：列出卡片分组、重复结构、文字层级、共享样式及不可编辑图片/待校对文案。结果是带源码指针的候选，不推测交互或自动改层级。',
      inputSchema: { type: 'object', properties: { spec: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] },
        limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['spec'], additionalProperties: false },
      handler: reviewImageStructure, readOnly: true },
    { name: 'export_prototype', description: '将现有 RP9 或 RP11 .rp 导出为 Axure 官方 HTML（含 start.html 和资源），无需打开编辑器。自动按文件版本调用本机 Axure 程序集，使用出厂发布设置。适合交付浏览器原型或为验收准备 HTML。',
      inputSchema: { type: 'object', properties: {
        rp: { type: 'string', minLength: 1, description: '现有 .rp 路径，例如 generate_prototype 返回的 output。' },
        output: { type: 'string', minLength: 1, description: '新的 HTML 输出目录。省略则使用 .rp 旁的 <文件名>-html。' },
        cwd: { type: 'string', minLength: 1, description: '可选工作目录，用于解析相对路径。' },
        projectDir: { type: 'string', minLength: 1, description: 'cwd 的别名。' },
      }, required: ['rp'], additionalProperties: false },
      handler: exportPrototype, readOnly: false },
    { name: 'verify_prototype', description: '零外部依赖（复用内置无头 Chrome CDP 与本地环回 HTTP）验证 Axure 官方 HTML 交互行为：支持 click / fill / drag / swipe / wait / navigate / expect（支持文案、可见性、面板状态、变量、x/y/dx/dy 坐标与宽高等断言），可自动从 .rp 导出官方 HTML 或复用 html 目录，并支持 screenshot/includeImage 截图回看。',
      inputSchema: { type: 'object', properties: {
        rp: { type: 'string', minLength: 1, description: '现有 .rp 路径；若未传 html 将自动导出临时官方 HTML。' },
        html: { type: 'string', minLength: 1, description: '已导出的 Axure 官方 HTML 目录（含 start.html）。' },
        source: { type: 'string', minLength: 1, description: '可选 RP/1 源码路径；省略时自动读取 .rp.baseline.json 或按页面 [data-label] 匹配。' },
        page: { type: 'string', minLength: 1, description: '可选起始页面 ID 或名称。' },
        cwd: { type: 'string', minLength: 1 },
        projectDir: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 30000 },
        viewport: { type: 'object', properties: {
          width: { type: 'integer', minimum: 320, maximum: 3840 },
          height: { type: 'integer', minimum: 320, maximum: 2160 },
          dpr: { type: 'number', minimum: 1, maximum: 3 },
        }, additionalProperties: false },
        screenshot: { type: 'string', minLength: 1, description: '可选 .png 截图输出路径（禁止覆盖已有文件）。' },
        includeImage: { type: 'boolean', description: 'true 时在 MCP 响应中附带最终截图 PNG。' },
        steps: { type: 'array', minItems: 0, maxItems: 60, items: { type: 'object', properties: {
          action: { type: 'string', enum: ['click', 'fill', 'drag', 'swipe', 'wait', 'navigate', 'expect'] },
          target: { type: 'string', minLength: 1 },
          value: { type: 'string' },
          rowIndex: { type: 'integer', minimum: 0 },
          dx: { type: 'number' },
          dy: { type: 'number' },
          steps: { type: 'integer', minimum: 1, maximum: 60 },
          stepDelayMs: { type: 'integer', minimum: 0, maximum: 100 },
          direction: { type: 'string', enum: ['left', 'right', 'up', 'down'] },
          distance: { type: 'number', minimum: 20, maximum: 2000 },
          ms: { type: 'integer', minimum: 0, maximum: 30000 },
          page: { type: 'string', minLength: 1 },
          expect: { type: 'object', properties: {
            text: { type: 'string' }, value: { type: 'string' }, visible: { type: 'boolean' },
            enabled: { type: 'boolean' }, checked: { type: 'boolean' }, panelState: { type: 'string' },
            width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 },
            x: { type: 'number' }, y: { type: 'number' }, left: { type: 'number' }, right: { type: 'number' },
            top: { type: 'number' }, bottom: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' },
            tolerance: { type: 'number', minimum: 0, maximum: 50 },
            page: { type: 'string' }, variable: { type: 'string' }, equals: {},
          }, additionalProperties: false },
        }, required: ['action'], additionalProperties: false } },
      }, additionalProperties: false },
      handler: input => verifyOfficialPreview(input, { runWorkflow, exportHtml: exportPrototype }), readOnly: false },
    { name: 'preview_prototype', description: '在已有 ego lite 任务空间中验证真实 Axure 预览。按逻辑 ID 点击、输入并断言文字/变量/面板状态，返回实际状态、源码位置及报告截图。用 export_prototype 准备官方 HTML 地址，或先运行 gui_roundtrip(preview:true)；不接管用户空间，不把模拟当原生证据。',
      inputSchema: { type: 'object', properties: {
        source: { type: 'string', minLength: 1 }, output: { type: 'string', minLength: 1 },
        spaceId: { type: 'integer', minimum: 1 }, pageLabel: { type: 'string' }, url: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 10000 },
        steps: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: {
          action: { type: 'string', enum: ['click', 'fill', 'expect'] }, target: { type: 'string', minLength: 1 },
          value: { type: 'string' }, rowIndex: { type: 'integer', minimum: 0 },
          expect: { type: 'object', properties: { text: { type: 'string' }, visible: { type: 'boolean' }, panelState: { type: 'string' },
            width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 },
            page: { type: 'string' }, variable: { type: 'string' }, equals: {} }, additionalProperties: false },
        }, required: ['action'], additionalProperties: false } },
      }, required: ['source', 'output', 'spaceId', 'steps'], additionalProperties: false },
      handler: input => previewPrototype(input, runWorkflow), readOnly: false },
    { name: 'prototype_recipe', description: '查看完整 RP/1 创作范例（含原生轮播、左右滑动、拖动与输入长度）、RP/1 零算高语法速查表（cheatsheet/tokens/gotchas）、推荐修改入口和可直接调用的生成参数；不写文件。',
      inputSchema: { type: 'object', properties: { recipe: { type: 'string', enum: recipes.map(r => r.id) }, includeSource: { type: 'boolean' } }, additionalProperties: false },
      handler: recipeCatalog, readOnly: true },
    { name: 'diagnose_prototype', description: '只读诊断 RP/1；收集独立节点错误并给出页面/元件/字段、源码行列、当前值及可审查补丁。依赖检查未完成时明确标记；不自动改源码。',
      inputSchema: { type: 'object', properties: { source: sourceSchema, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['source'], additionalProperties: false },
      handler: ({ source, limit }) => runWorkflow('diagnose', source, { limit }), readOnly: true },
    { name: 'explain_binding', description: '解释 RP/1 文字或进度条绑定的完整表达式、依赖、初始值、实际编译出的刷新事件和显示精度。静态编译关系，不冒充原生运行观测。重名用 page/id 或源码指针。',
      inputSchema: { type: 'object', properties: { source: sourceSchema, target: { type: 'string', minLength: 1 } }, required: ['source', 'target'], additionalProperties: false },
      handler: ({ source, target }) => runWorkflow('binding', source, { target }), readOnly: true },
    { name: 'runtime_info', description: '读取活动 MCP 版本、启动实现指纹、磁盘差异、工具清单指纹、RP9 模板与官方 HTML 导出的宿主发现结果；判断是否需要重新连接服务。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => runtimeInfo(listTools()), readOnly: true },
    { name: 'revise_prototype', description: '一次完成最小源码改稿、原生漂移检查、三方合并、原型生成和共同基线。支持逻辑 ID + property、结构节点增删改（add-node/remove-node/replace-node，value 支持直接传 .rp1 片段或 JSON）或 JSON Pointer 操作；output 省略或传 "auto" 时自动递增生成 -v2.rp；保留输入，输出新的源码与 .rp。冲突默认拒绝，dryRun 只返回影响。',
      inputSchema: { type: 'object', properties: {
        source: { type: 'string', minLength: 1 }, rp: { type: 'string', minLength: 1 }, output: { type: 'string', minLength: 1 }, outSource: { type: 'string', minLength: 1 },
        operations: { type: 'array', minItems: 1, items: { type: 'object', properties: {
          op: { type: 'string', enum: ['replace', 'add', 'remove', 'add-node', 'insert-node', 'addNode', 'remove-node', 'delete-node', 'removeNode', 'replace-node', 'replaceNode'] },
          target: { type: 'string' }, parent: { type: 'string' }, after: { type: 'string' }, before: { type: 'string' },
          index: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] },
          property: { type: 'string', minLength: 1 }, path: { type: 'string' }, value: {}, node: {}, oldValue: {},
        }, additionalProperties: false } },
        async: { type: 'boolean', description: 'stdio MCP 中 true 立即返回 revise-prototype 任务句柄，使用 jobs_get 查询；支持 dryRun。' }, dryRun: { type: 'boolean' }, prefer: { type: 'string', enum: ['fail', 'source', 'native'] }, resolutions: { type: 'object' },
        expectedHash: { type: 'string' }, expectedRpSha256: { type: 'string' },
      }, required: ['source', 'rp', 'operations'], additionalProperties: false },
      handler: input => revisePrototype(input, { generate, sync }), readOnly: false },
  ];
}
