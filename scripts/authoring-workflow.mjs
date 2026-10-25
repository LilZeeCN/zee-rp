import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { appExists, templateCandidates } from './version.mjs';
import { previewPrototype } from './preview-runtime.mjs';
import { reviewImageStructure } from './image-structure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE_DIR = join(ROOT, 'examples/authoring');
const digest = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => { assertNotProtected(path); return digest(readFileSync(path)); };
const startedAt = new Date().toISOString();
export const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'))).version;
function implementation() {
  const files = ['package.json', ...['scripts', 'bin', 'examples/authoring'].filter(dir => existsSync(join(ROOT, dir)))
    .flatMap(dir => readdirSync(join(ROOT, dir)).filter(f => /\.(mjs|py|rp1)$/.test(f)).sort().map(f => `${dir}/${f}`))];
  return Object.fromEntries(files.map(file => [file, fileHash(join(ROOT, file))]));
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

const tokenQuery = spawnSync('python3', ['-B', '-c', `import json,sys
sys.path.insert(0, sys.argv[1])
from rp_language import COLOR_TOKENS, COLOR_TOKEN_ALIASES, DEVICE_CANVAS_PRESETS, THEMES
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, SPACING_TOKENS, RADIUS_TOKENS
print(json.dumps(dict(fontSize=FONT_SIZE_TOKENS, fontWeight=FONT_WEIGHT_TOKENS,
 spacing=SPACING_TOKENS, radius=RADIUS_TOKENS,
 colorTokens=sorted({'$'+c for c in COLOR_TOKENS} | set(COLOR_TOKEN_ALIASES)),
 themes=sorted(THEMES), devices={k:[v['w'],v['h']] for k,v in DEVICE_CANVAS_PRESETS.items()})))`, join(ROOT, 'scripts')], { encoding: 'utf8' });
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
    '诊断后验证实际 Axure 预览'], guide: join(ROOT, 'references/authoring-workflow.md') };
}

export function runWorkflow(command, source, extra = {}) {
  if (typeof source === 'string' && source.trimStart().startsWith('{')) source = JSON.parse(source);
  if (typeof source === 'string') { source = resolve(source); assertNotProtected(source); }
  const proc = spawnSync('python3', ['-B', join(ROOT, 'scripts/rp_workflow.py')], {
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
      axureInstalled: appExists(9), blankTemplate: templateCandidates(9).find(c => existsSync(c.path))?.path ?? null },
    nextAction: changedFiles.length ? '磁盘实现已变化，请重新连接 MCP 以加载一致版本；Python 子进程每次读取磁盘实现。'
      : '当前服务与磁盘指纹一致（含 scripts/*.mjs 与 scripts/*.py 编译器）。若客户端缺少工具，重新连接以刷新工具清单。' };
}

export function pythonEnvironment() {
  const proc = spawnSync('python3', ['-B', '-c', `import json,sys,importlib
modules={}
for name in ('PIL','numpy','scipy'):
 try:
  importlib.import_module(name); modules[name]=True
 except ImportError: modules[name]=False
print(json.dumps({'executable':sys.executable,'version':sys.version.split()[0],'imageModules':modules,'missingImageDependencies':[k for k,v in modules.items() if not v]}))`],
  { encoding: 'utf8', timeout: 10000 });
  return proc.status === 0 ? JSON.parse(proc.stdout) : { error: proc.error?.message ?? proc.stderr.trim(), missingImageDependencies: ['python3-runtime'] };
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
  const writeRoot = (process.env.AXURE_WRITE_ROOT || '').split(':').filter(Boolean)[0] || process.cwd();
  let output = input.output && input.output !== 'auto' ? resolve(writeRoot, input.output) : null;
  if (!dryRun && !output) {
    const stem = rpPath.replace(/\.rp$/i, '').replace(/-v\d+$/, '');
    for (let v = 2; ; v++) {
      const candRp = `${stem}-v${v}.rp`;
      const candSrc = `${stem}-v${v}${extname(sourcePath)}`;
      if (!existsSync(candRp) && !existsSync(candSrc) && !existsSync(`${candRp}.baseline.json`)) {
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
    if (existsSync(path)) throw Object.assign(new Error(`改稿输出已存在，请使用新文件名：${path}`), { code: 'E_OUTPUT_EXISTS' });
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
    mkdirSync(assets);
    published.push(assets);
    cpSync(built.artifacts.directory, assets, { recursive: true, errorOnExist: true, force: false });
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
      copyFileSync(from, to, constants.COPYFILE_EXCL); published.push(to);
    }
    const baseline = rebase(JSON.parse(readFileSync(built.baseline, 'utf8')));
    baseline.outputRp = output; baseline.sourcePath = outSource;
    baseline.rpSha256 = fileHash(output); baseline.sourceSha256 = fileHash(outSource);
    writeFileSync(`${output}.baseline.json`, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
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

const sourceSchema = { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }], description: 'RP/1 源码 .rp1/.json 路径或 JSON 对象。' };
export function authoringTools({ generate, sync, listTools }) {
  return [
    { name: 'review_image_structure', description: '只读审阅图片重建的 trace spec：列出卡片分组、重复结构、文字层级、共享样式及不可编辑图片/待校对文案。结果是带源码指针的候选，不推测交互或自动改层级。',
      inputSchema: { type: 'object', properties: { spec: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] },
        limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['spec'], additionalProperties: false },
      handler: reviewImageStructure, readOnly: true },
    { name: 'preview_prototype', description: '在已有 ego lite 任务空间中验证真实 Axure 预览。按逻辑 ID 点击、输入并断言文字/变量/面板状态，返回实际状态、源码位置及报告截图。需要先运行 gui_roundtrip(preview:true) 或发布 HTML；不接管用户空间，不把模拟当原生证据。',
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
    { name: 'prototype_recipe', description: '查看三套完整创作范例、RP/1 零算高语法速查表（cheatsheet/tokens/gotchas）、推荐修改入口和可直接调用的生成参数；不写文件。',
      inputSchema: { type: 'object', properties: { recipe: { type: 'string', enum: recipes.map(r => r.id) }, includeSource: { type: 'boolean' } }, additionalProperties: false },
      handler: recipeCatalog, readOnly: true },
    { name: 'diagnose_prototype', description: '只读诊断 RP/1；收集独立节点错误并给出页面/元件/字段、源码行列、当前值及可审查补丁。依赖检查未完成时明确标记；不自动改源码。',
      inputSchema: { type: 'object', properties: { source: sourceSchema, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['source'], additionalProperties: false },
      handler: ({ source, limit }) => runWorkflow('diagnose', source, { limit }), readOnly: true },
    { name: 'explain_binding', description: '解释 RP/1 文字或进度条绑定的完整表达式、依赖、初始值、实际编译出的刷新事件和显示精度。静态编译关系，不冒充原生运行观测。重名用 page/id 或源码指针。',
      inputSchema: { type: 'object', properties: { source: sourceSchema, target: { type: 'string', minLength: 1 } }, required: ['source', 'target'], additionalProperties: false },
      handler: ({ source, target }) => runWorkflow('binding', source, { target }), readOnly: true },
    { name: 'runtime_info', description: '读取活动 MCP 版本、启动实现指纹、磁盘差异、工具清单指纹及 RP9 模板可用性；判断是否需要重新连接服务。',
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
