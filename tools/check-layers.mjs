#!/usr/bin/env node
// 分层门禁(figcraft "cargo xtask layers" 的等价物):
//   A. studio/** 静态 import 图及浏览器字面量动态 import 必须无环
//   B. web/ 前端(浏览器侧)不得 import Node 内建模块;相对/URL 绝对引用仅指向同构模块
//   C. 核心层(core)不得反向依赖命令层/服务层/特性层(figcraft L0-L6 方向约束的 JS 落地)
//   D. scripts/mcp-tools.mjs 对 studio 的引用面冻结在 mcp-adapter 与 schema-validation 两个入口
// 违例即非零退出;新增分层约束先改本文件并说明理由,再进 CI。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO = join(ROOT, 'studio');
const WEB = join(STUDIO, 'web');
const WEB_SHARED = new Set(['clipboard.mjs', 'visual-style.mjs'].map(file => join(STUDIO, file)));
const NODE_BUILTINS = new Set(builtinModules);
const isWeb = file => file.startsWith(WEB + sep);
const violations = [];

// ---- 收集 studio 下全部 .mjs ----
function listMjs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules') continue;
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) out.push(...listMjs(p));
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}
const studioFiles = listMjs(STUDIO);
const rel = p => p.slice(ROOT.length + 1);

// ---- 收集静态声明、无绑定导入和字面量动态 import ----
function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const entries = [
    ...Array.from(text.matchAll(/\b(?:from\s+|import\s*)['"]([^'"\r\n]+)['"]/g), match => ({ spec: match[1], dynamic: false })),
    ...Array.from(text.matchAll(/\bimport\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g), match => ({ spec: match[1], dynamic: true })),
  ];
  return entries.map(entry => {
    const { spec } = entry;
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec)) return { ...entry, node: true };
    let candidates = [];
    if (spec.startsWith('.')) {
      const abs = resolve(dirname(file), spec);
      candidates = [abs, `${abs}.mjs`, join(abs, 'index.mjs')];
    } else if (spec.startsWith('/')) {
      candidates = [join(WEB, spec), join(STUDIO, spec)];
    }
    const target = candidates.find(path => path.endsWith('.mjs') && existsSync(path));
    return { ...entry, target };
  });
}
const moduleImports = new Map(studioFiles.map(file => [file, importsOf(file)]));

// ---- A. 全部静态引用和浏览器字面量动态 import 环检测 ----
// 服务端延迟加载的已知例外见 AGENTS.md；前端由 main.mjs 装配，禁止通过延迟加载引入环。
const graph = new Map(); // file -> Set(static targets)
for (const f of studioFiles) {
  const browserModule = isWeb(f) || WEB_SHARED.has(f);
  const targets = moduleImports.get(f).filter(imp => imp.target && (!imp.dynamic || browserModule)).map(imp => imp.target);
  graph.set(f, new Set(targets));
}
const color = new Map(); // 0 未访问 1 在栈 2 完成
function dfs(u, stack) {
  color.set(u, 1);
  for (const v of graph.get(u) || []) {
    if ((color.get(v) ?? 0) === 1) violations.push(`A 循环依赖: ${rel(u)} -> ${rel(v)}(栈:${[...stack, rel(u)].join(' -> ')})`);
    else if ((color.get(v) ?? 0) === 0) dfs(v, [...stack, rel(u)]);
  }
  color.set(u, 2);
}
for (const f of studioFiles) if ((color.get(f) ?? 0) === 0) dfs(f, []);

// ---- B. web/ 浏览器侧约束 ----
for (const f of studioFiles.filter(file => isWeb(file) || WEB_SHARED.has(file))) {
  for (const imp of moduleImports.get(f)) {
    if (imp.node) violations.push(`B 浏览器模块引用 Node 内建: ${rel(f)} -> ${imp.spec}`);
    else if (imp.target && !isWeb(imp.target) && !WEB_SHARED.has(imp.target)) {
      violations.push(`B 浏览器模块引用非同构模块: ${rel(f)} -> ${imp.spec}`);
    }
  }
}

// ---- C. 核心层方向约束 ----
const CORE = new Set([
  // L0 叶子
  'bounded-cache', 'schema-validation', 'node-properties', 'repeater-view', 'png-decode', 'cdp',
  'interactions', 'vector-paths', 'visual-style', 'clipboard',
  // L1 文档核心
  'document', 'component-contracts', 'text-shaping', 'typography', 'pixel-truth', 'design-metrics',
  'document-diff', 'command-contracts', 'node-capabilities',
  // L2 几何/语义
  'scene-resolver', 'authoring-query', 'relation-edit', 'design-decisions', 'design-craft',
  'design-guidance', 'reference-packs', 'media', 'runtime', 'scenario-executors', 'selection',
  'impact-diff', 'css-raster',
]);
const UPPER = new Set([
  'commands', 'server', 'server-capture', 'mcp-adapter', 'cli', 'operation-worker',
  'persistence', 'versions', 'operations', 'document-merge', 'sync-native',
  'export-rp', 'export-code', 'project-bundle', 'scenarios', 'candidate-explorations',
  'design-review', 'design-context', 'phase-context', 'content-plan', 'fix-plan', 'anchors',
  'diagnostics', 'explorations', 'rp1-authoring', 'authoring-help',
]);
function upperTargets(spec) {
  const base = spec.split('/').pop().replace(/\.mjs$/, '');
  if (UPPER.has(base)) return base;
  if (spec.startsWith('./commands/') || spec.startsWith('../commands/') || spec.includes('/commands/')) return 'commands';
  return null;
}
for (const f of studioFiles) {
  const base = rel(f).replace(/^studio\//, '').replace(/\.mjs$/, '');
  const coreName = base.split('/').pop();
  if (!CORE.has(coreName) || base.includes('web/')) continue;
  for (const imp of moduleImports.get(f)) {
    if (!imp.target) continue;
    // 仅按原始 spec 判定:解析后的绝对路径会误中 '/commands/' 目录规则(命令包内部文件)。
    const up = upperTargets(imp.spec);
    if (up) violations.push(`C 核心层反向依赖: ${rel(f)} -> ${up}`);
    if (isWeb(imp.target)) violations.push(`C 核心层引用浏览器前端: ${rel(f)}`);
  }
}

// ---- D. scripts/mcp-tools.mjs 的 studio 引用面冻结 ----
const mcpToolsPath = join(ROOT, 'scripts', 'mcp-tools.mjs');
if (existsSync(mcpToolsPath)) {
  for (const imp of importsOf(mcpToolsPath)) {
    if (imp.target && rel(imp.target).startsWith('studio/')) {
      const allowed = ['studio/mcp-adapter.mjs', 'studio/schema-validation.mjs'];
      if (!allowed.includes(rel(imp.target))) violations.push(`D scripts 越界引用 studio: ${rel(imp.target)}(冻结面:${allowed.join(', ')})`);
    }
  }
}

if (violations.length) {
  console.error(`check-layers: ${violations.length} 处违例`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log(`check-layers: OK(${studioFiles.length} 个 studio 模块,静态图无环,web 无 Node 依赖,核心层方向正确,scripts 引用面冻结)`);
