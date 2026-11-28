import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNotProtected, assertWritable, resolveWorkDir } from './engine.mjs';
import { pythonInvocation } from './python.mjs';
import { appExists, supportedVersions, templateCandidates, tryDetectFileVersion } from './version.mjs';
import { captureOfficialHtmlScreenshot, previewPrototype, verifyOfficialPreview as replayOfficialPreview } from './preview-runtime.mjs';
export { captureOfficialHtmlScreenshot };

export function verifyOfficialPreview(input, services = { runWorkflow, exportHtml: exportPrototype }) {
  if (input.rp) {
    const rp = resolve(resolveWorkDir(input.cwd ?? input.projectDir), input.rp);
    assertNotProtected(rp);
    const moved = renamedCompanion(rp);
    if (moved) {
      const error = companionRenamedError(moved);
      return Promise.resolve({ status: 'failed', code: error.code, message: error.message, nextAction: error.nextAction });
    }
  }
  return replayOfficialPreview(input, services);
}
import { reviewImageStructure } from './image-structure.mjs';
import { findChromeExecutable } from '../studio/cdp.mjs';
import { listImplementationFiles, updateFileHash } from '../studio/source-fingerprint.mjs';

import { readNativeWidgetMap } from './native-widget-identity.mjs';
import { scanOfficialInteractions, officialWidgetMapFile } from './official-interactions.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE_DIR = join(ROOT, 'examples/authoring');
const ASSEMBLY_BRIDGE = 'tools/native-assembly/bridge.mjs';
const ASSEMBLY_WORKER = 'tools/native-assembly/Worker.cs';
import { acquireOutputLock } from './file-lock.mjs';

const invoke = promisify(execFile);

export function isInlineRp1Text(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  if (!trimmed.includes('\n') && /\.(?:rp1|json)$/i.test(trimmed)) return false;
  if (/^rp\/1(?:\s|$)/m.test(trimmed)) return true;
  return trimmed.includes('\n') && /^(?:palette:|tab-bar:|var\s+[A-Za-z_]|page\s+#?|component\s+|master\s+|dataset\s+|tokens:)/m.test(trimmed);
}

export function withTempRp1File(rp1Text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zee-rp1-inline-'));
  const file = join(dir, 'inline.rp1');
  const content = String(rp1Text ?? '').endsWith('\n') ? String(rp1Text) : `${rp1Text}\n`;
  writeFileSync(file, content, 'utf8');
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const verifyStepItemsSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click', 'fill', 'input', 'drag', 'swipe', 'wait', 'advanceTime', 'navigate', 'expect', 'assert'] },
    target: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object', anyOf: [
      { required: ['logicalId'] }, { required: ['guid'] }, { required: ['record', 'id'] },
    ], properties: { logicalId: { type: 'string', minLength: 1 }, guid: { type: 'string', pattern: '^[0-9a-fA-F]{32}$' },
      record: { type: 'integer' }, id: { type: 'integer' } }, additionalProperties: false }] },
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
    expect: {
      type: 'object',
      properties: {
        text: { anyOf: [{ type: 'string' }, { type: 'object' }] }, value: { type: 'string' }, visible: { anyOf: [{ type: 'boolean' }, { type: 'object' }] },
        enabled: { type: 'boolean' }, checked: { anyOf: [{ type: 'boolean' }, { type: 'object' }] }, panelState: { anyOf: [{ type: 'string' }, { type: 'object' }] },
        variables: { type: 'object' },
        width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 },
        x: { type: 'number' }, y: { type: 'number' }, left: { type: 'number' }, right: { type: 'number' },
        top: { type: 'number' }, bottom: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' },
        tolerance: { type: 'number', minimum: 0, maximum: 50 },
        page: { type: 'string' }, variable: { type: 'string' }, equals: {},
        fill: { type: 'string' }, color: { type: 'string' }, fontFamily: { type: 'string' },
        fontSize: { type: 'number' }, fontWeight: { type: 'number' }, radius: { type: 'number' },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        visualBaseline: { type: 'string' }, maxDiffPct: { type: 'number', minimum: 0, maximum: 100 }, saveBaselineIfMissing: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  required: ['action'],
  additionalProperties: false,
};

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
    ...['scripts/surface-capabilities.json', 'references/versioned-capabilities.md', ASSEMBLY_BRIDGE, ASSEMBLY_WORKER,
      'examples/rp-language/native-gestures.rp1', 'examples/rp-language/carousel-slider-captcha.rp1'].filter(path => existsSync(join(ROOT, path)))];
  const packsRoot = join(ROOT, 'examples/studio/reference-packs');
  if (existsSync(packsRoot)) for (const name of readdirSync(packsRoot)) {
    for (const file of ['manifest.json','source.json']) {
      const relative = `examples/studio/reference-packs/${name}/${file}`;
      if (existsSync(join(ROOT, relative))) files.push(relative);
    }
  }
  const scratch = Buffer.allocUnsafe(64 * 1024);
  return Object.fromEntries(files.sort().map(file => {
    const path = join(ROOT, file);
    assertNotProtected(path);
    return [file, updateFileHash(createHash('sha256'), path, scratch).digest('hex')];
  }));
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
  { id: 'native-countdown', name: '双态毫秒倒计时', file: 'native-countdown.rp1', nativeInteractions: true, pages: ['timer'],
    scenario: '启动 → 停止并等待 → 重启 → 毫秒时间戳到期归零',
    customize: ['调整 deadline 与 left_ms 的时长', '调整双态面板的 repeatInterval', '停止动作使用 stateMode=current'] },
  { id: 'native-async-tasks', name: '同页并行的原生倒计时', file: 'native-async-tasks.rp1', nativeInteractions: true, pages: ['tasks'],
    scenario: '同时运行两个倒计时 → 重启或取消 A → B 独立完成，且运行时忽略重复启动',
    customize: ['给每个任务定义 locals', '用 start / with 填入初始参数', '选 restart 或 ignore，按需使用 cancel'] },
  { id: 'native-loop', name: '有界 raise-event 循环求值', file: 'native-loop.rp1', nativeInteractions: true, pages: ['loop'],
    scenario: '输入底数与次数 → 原生递归累乘 → 计算 99³ 及 2⁵ → 拒绝超限',
    customize: ['将累乘动作替换为业务更新', '保留次数上限和递减动作', '递归放在条件分支末尾'] },
  { id: 'native-blur-form', name: '多字段失焦联合校验', file: 'native-blur-form.rp1', nativeInteractions: true, pages: ['form'],
    scenario: '空提交 → 逐字段失焦 → 联合比对 → 提交',
    customize: ['多个 OnLostFocus 与提交按钮共用一个校验事件', '新增规则时将 else-if 放在兜底之前'] },
  { id: 'native-calculator', name: '连续四则计算器', file: 'native-calculator.rp1', nativeInteractions: true, pages: ['calc'],
    scenario: '连续运算、十进制舍入、除零提示、出错后继续输入',
    customize: ['program.bind 批量绑定数字与运算键', '用 if 和 call 组织分支与复用过程', '用 fixed 设置小数显示精度'] },
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

export function readNativeInteractionSource(source) {
  if (!source || !/\.(?:rp1|json)$/i.test(source)) return null;
  const path = `${source}.interactions.json`;
  assertNotProtected(path);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if ((!data.program && !data.programs && (!Array.isArray(data.items) || !data.items.length)) ||
      (data.items !== undefined && !Array.isArray(data.items)) || !Array.isArray(data.steps)) {
    throw new Error(`原生交互源码须包含 program、programs 或非空 items，并提供 steps：${path}`);
  }
  return { path, items: data.items ?? [], program: data.program, programs: data.programs, steps: data.steps };
}

export function recipeCatalog({ recipe, includeSource = false } = {}) {
  const selection = recipe ? recipes.filter(r => r.id === recipe) : recipes;
  if (!selection.length) recipeSource(recipe);
  return { status: 'completed', recipes: selection.map(r => ({ ...r, source: recipeSource(r.id),
    ...(includeSource ? { sourceText: readFileSync(recipeSource(r.id), 'utf8') } : {}),
    ...(r.nativeInteractions ? {
      interactionSource: `${recipeSource(r.id)}.interactions.json`,
      ...(includeSource ? { interactionSourceText: readFileSync(`${recipeSource(r.id)}.interactions.json`, 'utf8') } : {}),
      verify: { tool: 'verify_prototype', arguments: { rp: `${r.id}.rp`, engine: 'official',
        steps: readNativeInteractionSource(recipeSource(r.id)).steps } },
    } : {}),
    generate: { tool: 'generate_prototype', arguments: { recipe: r.id, output: `${r.id}.rp` } },
  })), cheatsheet: AUTHORING_CHEATSHEET, tokens: AUTHORING_TOKENS, gotchas: AUTHORING_GOTCHAS,
  workflow: ['选范例或提交 RP/1 源码（善用 [fillxhug]、stat-row、list-item、card 简写与顶层 tab-bar）',
    '复杂交互可通过 program 编写条件、循环及可复用过程，先查看 native-calculator 范例',
    '调用 generate_prototype 一次生成并直接查看 contactSheet / statesSheet 拼图',
    '使用 revise_prototype 按逻辑 ID 改属性或增删改节点（支持直接传 .rp1 片段）',
    '需要官方 HTML 时，把生成结果的 output 作为 export_prototype.rp；用真实浏览器验收交互'], guide: join(ROOT, 'references/authoring-workflow.md') };
}

export function runWorkflow(command, source, extra = {}) {
  const { cwd, projectDir, ...restExtra } = extra;
  const workDir = resolveWorkDir(cwd ?? projectDir);
  if (typeof source === 'string' && source.trimStart().startsWith('{')) source = JSON.parse(source);
  if (typeof source === 'string') {
    source = isAbsolute(source) ? resolve(source) : resolve(workDir, source);
    assertNotProtected(source);
  }
  const workflowInvocation = pythonInvocation(['-B', join(ROOT, 'scripts/rp_workflow.py')]);
  const proc = spawnSync(workflowInvocation.command, workflowInvocation.args, {
    input: JSON.stringify({ command, source, ...restExtra }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
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
    capabilitiesMatrixPath: join(ROOT, 'references', 'versioned-capabilities.md'),
    languageFeatureVersion: '0.4.5',
    fingerprint: loadedFingerprint, diskFingerprint: digest(JSON.stringify(disk)),
    trackedFileCount: Object.keys(disk).length, compilerHashes,
    restartRequired: changedFiles.length > 0, changedFiles,
    toolCount: toolList.length, toolSchemaHash: digest(JSON.stringify(toolList)),
    mcpProfile: process.env.ZEE_MCP_PROFILE || 'full',
    schemaChars: JSON.stringify(toolList).length,
    availableProfiles: ['full', 'core', 'author', 'studio'],
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

export function renamedCompanion(rpPath) {
  if (!existsSync(rpPath) || existsSync(`${rpPath}.baseline.json`)) return null;
  const rpSha256 = fileHash(rpPath);
  const dir = dirname(rpPath);
  const candidates = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.rp.baseline.json')) continue;
    const path = join(dir, name);
    try {
      assertNotProtected(path);
      const baseline = JSON.parse(readFileSync(path, 'utf8'));
      const from = path.slice(0, -'.baseline.json'.length);
      if (baseline.rpSha256 === rpSha256 && !existsSync(from)) candidates.push({ from, to: rpPath, baseline: path, source: baseline.sourcePath });
    } catch { /* Ignore unrelated or invalid metadata. */ }
  }
  if (candidates.length !== 1) return null;
  return candidates[0];
}

export function companionRenamedError(companion) {
  return Object.assign(new Error(`原型已从 ${basename(companion.from)} 改名为 ${basename(companion.to)}，共同基线仍使用原文件名。请使用 sync_prototype 的 relocate 模式迁移配套文件。`), {
    code: 'E_COMPANION_RENAMED', companion,
    nextAction: { tool: 'sync_prototype', arguments: { mode: 'relocate', from: companion.from, to: companion.to } },
  });
}

export function revisePrototype(input, { generate, sync }) {
  const { source, rp, operations, expectedHash, expectedRpSha256, dryRun = false, prefer = 'fail', resolutions, cwd, projectDir } = input;
  const explicitWorkDir = cwd ?? projectDir;
  const workDir = resolveWorkDir(explicitWorkDir);
  const resolveInWork = p => (isAbsolute(p) ? resolve(p) : resolve(workDir, p));
  const sourcePath = resolveInWork(source), rpPath = resolveInWork(rp);
  assertNotProtected(sourcePath); assertNotProtected(rpPath);
  const renamed = renamedCompanion(rpPath);
  if (renamed) throw companionRenamedError(renamed);
  if (!existsSync(`${rpPath}.baseline.json`))
    throw Object.assign(new Error('缺少共同基线；请先使用 generate_prototype 创建带基线的工程，或对已有文件使用原生编辑工具。'), { code: 'E_BASELINE_MISSING' });
  const interactionSource = readNativeInteractionSource(sourcePath);
  const originalHashes = new Map([sourcePath, rpPath, `${rpPath}.baseline.json`, interactionSource?.path].filter(Boolean).map(path => [path, fileHash(path)]));
  if (expectedRpSha256 && originalHashes.get(rpPath) !== expectedRpSha256)
    throw Object.assign(new Error('原型已变化，请读取最新状态后重试。'), { code: 'E_STALE_SYNC_STATE' });
  let output = input.output && input.output !== 'auto' ? resolveInWork(input.output) : null;
  if (!dryRun && !output) {
    const baseName = basename(rpPath).replace(/\.rp$/i, '').replace(/-v\d+$/, '');
    const inSkillRoot = sourcePath.startsWith(`${ROOT}/`) || rpPath.startsWith(`${ROOT}/`);
    const autoDir = explicitWorkDir ? workDir : (inSkillRoot ? workDir : dirname(rpPath));
    const stem = join(autoDir, baseName);
    for (let v = 2; ; v++) {
      const candRp = `${stem}-v${v}.rp`;
      const candSrc = `${stem}-v${v}${extname(sourcePath)}`;
      if (!pathOccupied(candRp) && !pathOccupied(candSrc) && !pathOccupied(`${candRp}.baseline.json`) && !pathOccupied(candRp.replace(/\.rp$/i, '.assets'))) {
        output = candRp;
        break;
      }
    }
  }
  const outSource = input.outSource ? resolveInWork(input.outSource) : output ? output.slice(0, -3) + extname(sourcePath) : null;
  if (!dryRun && (!output || extname(output) !== '.rp')) throw new Error('改稿需要新的 output .rp 路径；只查看影响请传 dryRun:true。');
  if (outSource && !['.rp1', '.json'].includes(extname(outSource))) throw new Error('outSource 必须是 .rp1 或 .json。');
  const assets = output && output.replace(/\.rp$/i, '.assets');
  const outInteractions = interactionSource && outSource ? `${outSource}.interactions.json` : null;
  const destinations = [output, outSource, outInteractions, output && `${output}.baseline.json`, assets].filter(Boolean);
  for (const path of destinations) {
    assertWritable(path);
    if (pathOccupied(path)) throw Object.assign(new Error(`改稿输出已存在，请使用新文件名：${path}`), { code: 'E_OUTPUT_EXISTS' });
  }
  const parent = dirname(output ?? rpPath);
  assertWritable(join(parent, '.revision'));
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'zee-revision-'));
  const published = [];
  let unlock;
  try {
    if (output && !dryRun) unlock = acquireOutputLock(output);
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
    if (interactionSource) copyFileSync(interactionSource.path, `${mergedSource}.interactions.json`, constants.COPYFILE_EXCL);
    const built = generate({ source: mergedSource, output: join(stage, 'result.rp'), compact: false,
      verifyMode: input.verifyMode, noCache: input.noCache }, { cacheRoot: join(parent, '.zee-cache') });
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
    const publications = [[mergedSource, outSource], [built.output, output]];
    if (outInteractions) publications.push([`${mergedSource}.interactions.json`, outInteractions]);
    for (const [from, to] of publications) {
      mkdirSync(dirname(to), { recursive: true });
      try { copyFileSync(from, to, constants.COPYFILE_EXCL); }
      catch (error) { failIfOutputExists(error, to); }
      published.push(to);
    }
    const baseline = rebase(JSON.parse(readFileSync(built.baseline, 'utf8')));
    baseline.outputRp = output; baseline.sourcePath = outSource;
    baseline.rpSha256 = fileHash(output); baseline.sourceSha256 = fileHash(outSource);
    const previousBaseline = JSON.parse(readFileSync(`${rpPath}.baseline.json`, 'utf8'));
    baseline.projectUuid = previousBaseline.projectUuid ?? baseline.projectUuid;
    baseline.companionFiles = { rp: basename(output), source: basename(outSource), assetsDir: basename(assets) };
    try { writeFileSync(`${output}.baseline.json`, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { failIfOutputExists(error, `${output}.baseline.json`); }
    published.push(`${output}.baseline.json`);
    const report = { ...summary, output, source: outSource, baseline: `${output}.baseline.json`,
      ...(outInteractions ? { interactionSource: outInteractions, verifySteps: built.verifySteps } : {}),
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
    unlock?.();
  }
}

export async function exportPrototype({ rp, output, cwd, projectDir, baseline, includeWidgetMap = true }) {
  const workDir = resolveWorkDir(cwd ?? projectDir);
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
    const { runAssemblyBridgeAsync } = await import('../tools/native-assembly/bridge.mjs');
    const { output: htmlDir, entry, identity, generatorSettings } = await runAssemblyBridgeAsync({
      command: 'export',
      version: Number(rpVersion),
      args: [source, target],
    });
    let widgetMap = null, mappingDiagnostic;
    try {
      widgetMap = readNativeWidgetMap(source, baseline ? resolve(workDir, baseline) : undefined);
    } catch (error) {
      mappingDiagnostic = { code: 'W_AXURE_WIDGET_MAP', severity: 'warning', message: error.message };
    }
    const interactionCompilation = scanOfficialInteractions(htmlDir, { symbols: widgetMap?.symbols });
    let widgetMapPath;
    if (includeWidgetMap && widgetMap?.symbols.length) {
      widgetMapPath = join(htmlDir, officialWidgetMapFile);
      const symbols = widgetMap.symbols.map(s => ({
        id: s.id, logicalId: s.logicalId, label: s.label, name: s.name, display: s.display, pageId: s.pageId, pageName: s.pageName,
        officialId: s.officialId,
      }));
      try { writeFileSync(widgetMapPath, JSON.stringify({ version: 1, symbols }) + '\n', { flag: 'wx' }); }
      catch (error) {
        widgetMapPath = undefined;
        mappingDiagnostic = { code: 'W_AXURE_WIDGET_MAP', severity: 'warning', message: error.message };
      }
    }
    return {
      status: 'completed', rp: source, rpVersion, output: htmlDir, entry, axureBuild: identity.build, generatorSettings,
      interactionCompilation,
      ...(widgetMapPath ? { widgetMap: widgetMapPath } : {}),
      ...(mappingDiagnostic || interactionCompilation.diagnostics.length ? { diagnostics: [
        ...interactionCompilation.diagnostics, ...(mappingDiagnostic ? [mappingDiagnostic] : []),
      ] } : {}),
      officialHtmlSource: 'exported', officialHtmlReady: true,
      verification: { officialHtmlExported: true, browserLoaded: false, behaviorVerified: false },
      nextAction: interactionCompilation.errorCount ? '从 diagnostics 定位并修正表达式，再导出新目录或用 rp_command(action="preflight") 验证。'
        : '可用 verify_prototype(html=output, steps=[...]) 在无头 Chrome 中直接验证点击、滑动、拖动与状态/坐标断言，或打开输出目录中的 start.html 人工查看。',
    };
  } catch (error) {
    let nativeError;
    if (error.stderr) {
      try { nativeError = JSON.parse(error.stderr.trim()); } catch { /* Keep the original error. */ }
    }
    const code = nativeError?.code ?? (typeof error.code === 'string' && (error.code.startsWith('E_HTML_') || error.code.startsWith('E_ASSEMBLY_'))
      ? error.code : { input: 'E_HTML_RP', output: 'E_HTML_OUTPUT', assembly: 'E_HTML_EXPORT' }[stage]);
    const nextAction = stage === 'input' ? '使用 generate_prototype 返回的 output，或指定一份可读取的 RP9/RP11 .rp。'
      : stage === 'output' || code === 'E_ASSEMBLY_OUTPUT' ? '为 output 指定一个父目录已存在、尚未创建的输出目录。'
      : '用 runtime_info 查看宿主，检查对应 Axure 安装、已验证构建和本机 .NET。';
    return { status: 'failed', stage, ...(rpVersion ? { rpVersion } : {}),
      diagnostics: [{ code, message: (nativeError?.message ?? error.message).slice(0, 1400), nextAction }] };
  }
}

const sourceSchema = { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }], description: 'RP/1 源码 .rp1/.json 路径、JSON 对象文本或 JSON 对象。' };
function stripSchemaDescriptions(node) {
  if (Array.isArray(node)) return node.map(stripSchemaDescriptions);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description') continue;
    out[k] = stripSchemaDescriptions(v);
  }
  return out;
}

const compactVerifyStepSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click', 'fill', 'input', 'drag', 'swipe', 'wait', 'advanceTime', 'navigate', 'expect', 'assert'] },
    target: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] },
    value: { type: 'string' },
    page: { type: 'string', minLength: 1 },
    ms: { type: 'number', minimum: 0 },
    expect: { type: 'object' },
  },
  required: ['action'],
};

export function authoringTools({ generate, sync, listTools }) {
  return [
    { name: 'export_prototype', description: '按版本无头导出 RP9/RP11 .rp 为 Axure 官方 HTML。',
      inputSchema: { type: 'object', properties: {
        rp: { type: 'string', minLength: 1 },
        output: { type: 'string', minLength: 1 },
        baseline: { type: 'string', minLength: 1 },
        includeWidgetMap: { type: 'boolean' },
        cwd: { type: 'string', minLength: 1 },
        projectDir: { type: 'string', minLength: 1 },
      }, required: ['rp'], additionalProperties: false },
      handler: exportPrototype, readOnly: false },
    { name: 'verify_prototype', description: 'Chrome CDP 原型交互验收，支持官方 HTML 与 studio-html 双引擎及 studio_scenario 步骤。',
      inputSchema: { type: 'object', properties: {
        rp: { type: 'string', minLength: 1 },
        html: { type: 'string', minLength: 1 },
        engine: { type: 'string', enum: ['auto', 'official', 'studio-html'] },
        frame: { type: 'string', enum: ['viewport', 'artboard'] },
        baseline: { type: 'string', minLength: 1 },
        source: { type: 'string', minLength: 1 },
        page: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1 },
        projectDir: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 120000, description: '超时 ms（500–120000）' },
        virtualClock: { type: 'boolean' },
        viewport: { type: 'object', properties: {
          width: { type: 'integer', minimum: 320, maximum: 3840 },
          height: { type: 'integer', minimum: 320, maximum: 2160 },
          dpr: { type: 'number', minimum: 1, maximum: 3 },
        }, additionalProperties: false },
        screenshot: { type: 'string', minLength: 1 },
        includeImage: { type: 'boolean' },
        storyboard: { type: 'string', minLength: 1 },
        includeStoryboard: { type: 'boolean' },
        compact: { type: 'boolean' },
        failFast: { type: 'boolean' },
        fast: { type: 'boolean' },
        noCache: { type: 'boolean' },
        stepDetail: { enum: ['failures-only', 'compact', 'full'] },
        clockScope: { enum: ['page', 'global'] },
        steps: { type: 'array', minItems: 0, maxItems: 120, items: compactVerifyStepSchema },
      }, additionalProperties: false },
      handler: input => verifyOfficialPreview({ compact: true, ...input }, { runWorkflow, exportHtml: exportPrototype }), readOnly: false },
    { name: 'preview_prototype', description: '在 ego lite 空间验证真实 Axure 预览（优先使用 export_prototype + verify_prototype 做无头 Chrome 验收）。',
      inputSchema: { type: 'object', properties: {
        source: { type: 'string' }, output: { type: 'string' },
        cwd: { type: 'string' },
        projectDir: { type: 'string' },
        spaceId: { type: 'integer', minimum: 1 }, pageLabel: { type: 'string' }, url: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 10000 },
        steps: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: {
          action: { type: 'string', enum: ['click', 'fill', 'expect'] }, target: { type: 'string' },
          value: { type: 'string' }, rowIndex: { type: 'integer' },
          expect: { type: 'object' },
        }, required: ['action'], additionalProperties: false } },
      }, required: ['source', 'output', 'spaceId', 'steps'], additionalProperties: false },
      handler: input => {
        const workDir = resolveWorkDir(input.cwd ?? input.projectDir);
        const resolveInWork = p => (isAbsolute(p) ? p : resolve(workDir, p));
        return previewPrototype({ ...input, source: resolveInWork(input.source), output: resolveInWork(input.output) }, runWorkflow);
      }, readOnly: false },
    { name: 'prototype_recipe', description: '查看 RP/1 创作范例与语法速查表（只读）。',
      inputSchema: { type: 'object', properties: { recipe: { type: 'string', enum: recipes.map(r => r.id) }, includeSource: { type: 'boolean' } }, additionalProperties: false },
      handler: recipeCatalog, readOnly: true },
    { name: 'diagnose_prototype', description: '静态诊断 RP/1、查询能力、追踪绑定和审阅图片分层。',
      inputSchema: { type: 'object', properties: {
        mode: { type: 'string', enum: ['diagnose', 'binding', 'image', 'capabilities'] },
        rp1: { type: 'string' },
        source: sourceSchema,
        target: { type: 'string' },
        query: { type: 'string' },
        baseline: { type: 'string' },
        exemptReviewed: { type: 'boolean' },
        spec: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        limit: { type: 'integer' },
        cwd: { type: 'string' },
        projectDir: { type: 'string' },
      }, additionalProperties: false },
      handler: ({ mode, rp1, source, target, query, spec, limit, cwd, projectDir, baseline, exemptReviewed } = {}) => {
        if (mode === 'capabilities') {
          const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'surface-capabilities.json'), 'utf8'));
          return { ok: true, ...registry, properties: registry.properties.filter(entry =>
            !query || entry.property.toLowerCase().includes(query.toLowerCase())).slice(0, limit ?? registry.properties.length) };
        }
        const workDir = resolveWorkDir(cwd ?? projectDir);
        const resolveInput = val => {
          if (typeof val !== 'string') return val;
          if (val.trimStart().startsWith('{')) return JSON.parse(val);
          return isAbsolute(val) ? resolve(val) : resolve(workDir, val);
        };
        const effectiveMode = mode ?? (target !== undefined ? 'binding' : (rp1 === undefined && source === undefined && spec !== undefined ? 'image' : 'diagnose'));
        if (effectiveMode === 'image') {
          if (exemptReviewed) {
            const path = resolveInput(baseline);
            if (typeof path !== 'string' || !path.endsWith('.rp.baseline.json')) throw new Error('请提供截图反推的 baseline 路径。');
            const rp = path.slice(0, -'.baseline.json'.length);
            assertNotProtected(path);
            assertWritable(path);
            const unlock = acquireOutputLock(rp);
            try {
              const metadata = JSON.parse(readFileSync(path, 'utf8'));
              if (metadata.originKind !== 'image-trace-spec') throw new Error('只可在截图反推的共同基线中记录已审阅异常。');
              const evidence = join(rp.replace(/\.rp$/i, '.assets'), 'diff-report.json');
              assertNotProtected(evidence);
              const report = JSON.parse(readFileSync(evidence, 'utf8'));
              const current = (report.host_anomalies ?? []).map(anomaly => anomaly.id).filter(Boolean);
              const earlier = Array.isArray(metadata.exemptHostAnomalies) ? metadata.exemptHostAnomalies : [];
              metadata.exemptHostAnomalies = [...new Set([...earlier, ...current])];
              writeFileSync(path, JSON.stringify(metadata, null, 2) + '\n');
              return { ok: true, baseline: path, exemptHostAnomalies: metadata.exemptHostAnomalies };
            } finally { unlock(); }
          }
          const traceInput = spec ?? source;
          if (traceInput === undefined) throw new Error('diagnose_prototype(mode="image") 需要提供 spec。');
          return reviewImageStructure({ spec: typeof traceInput === 'string' && !traceInput.trimStart().startsWith('{') ? resolveInput(traceInput) : traceInput, limit });
        }
        if (rp1 !== undefined && (source !== undefined || spec !== undefined)) {
          throw new Error('diagnose_prototype 中 rp1 与 source/spec 不能同时提供。');
        }
        const inlineRp1 = rp1 ?? (isInlineRp1Text(source) ? source : (isInlineRp1Text(spec) ? spec : null));
        if (inlineRp1 !== null) {
          return withTempRp1File(inlineRp1, tempRp1 => {
            if (effectiveMode === 'binding') {
              if (!target) throw new Error('diagnose_prototype(mode="binding") 需要提供 target（如 page/widget）。');
              return runWorkflow('binding', tempRp1, { target, cwd, projectDir });
            }
            return runWorkflow('diagnose', tempRp1, { limit, cwd, projectDir });
          });
        }
        const rpSource = resolveInput(source ?? spec);
        if (rpSource === undefined) throw new Error('diagnose_prototype 需要提供 rp1、source（RP/1）或 spec（图片分层规格）。');
        if (effectiveMode === 'binding') {
          if (!target) throw new Error('diagnose_prototype(mode="binding") 需要提供 target（如 page/widget）。');
          return runWorkflow('binding', rpSource, { target, cwd, projectDir });
        }
        return runWorkflow('diagnose', rpSource, { limit, cwd, projectDir });
      }, readOnly: false },
    { name: 'runtime_info', description: '读取 MCP 版本、实现指纹与本机 Axure 宿主发现结果。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => runtimeInfo(listTools()), readOnly: true },
    { name: 'revise_prototype', description: '最小源码改稿、漂移检查、三方合并并重编 .rp 与共同基线。',
      inputSchema: { type: 'object', properties: {
        source: { type: 'string' }, rp: { type: 'string' }, output: { type: 'string' }, outSource: { type: 'string' },
        cwd: { type: 'string' },
        projectDir: { type: 'string' },
        operations: { type: 'array', minItems: 1, items: { type: 'object', properties: {
          op: { type: 'string', enum: ['replace', 'add', 'remove', 'add-node', 'insert-node', 'addNode', 'remove-node', 'delete-node', 'removeNode', 'replace-node', 'replaceNode'] },
          target: { type: 'string' }, parent: { type: 'string' }, after: { type: 'string' }, before: { type: 'string' },
          index: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          property: { type: 'string' }, path: { type: 'string' }, value: {}, node: {}, oldValue: {},
        }, additionalProperties: false } },
        async: { type: 'boolean' }, dryRun: { type: 'boolean' }, prefer: { type: 'string', enum: ['fail', 'source', 'native'] }, resolutions: { type: 'object' },
        expectedHash: { type: 'string' }, expectedRpSha256: { type: 'string' },
        verify: { type: 'boolean' }, verifyMode: { enum: ['fast', 'full'] }, noCache: { type: 'boolean' },
      }, required: ['source', 'rp', 'operations'], additionalProperties: false },
      handler: async input => {
        const result = revisePrototype(input, { generate, sync });
        if (!input.verify || result.status !== 'completed') return result;
        const bv = await verifyOfficialPreview({ rp: result.output, source: result.source, cwd: dirname(result.output),
          compact: true, proofStoryboard: true, fast: input.verifyMode === 'fast', noCache: input.noCache },
          { runWorkflow, exportHtml: exportPrototype });
        return { ...result, status: bv.status, behaviorVerification: bv, ...(bv.proofReport ? { proofReport: bv.proofReport } : {}) };
      }, readOnly: false },
  ];
}
