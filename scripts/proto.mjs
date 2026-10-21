#!/usr/bin/env node
// 直接原型生成总控 CLI 与原生 / GUI 双后端 .rp 编译器 (proto.mjs)
// 用法：
//   node proto.mjs compile    --out-dir <dir> [--spec <spec.json>] [--preset web-dashboard|mobile-lostfound]
//                             [--theme enterprise-light|modern-dark|cobalt-pro|mobile-lowfi|mobile-hifi]
//                             [--title "..."] [--no-interactions] [--strict-audit] [--verbose]
//   node proto.mjs build-rp   --plan <compile-plan.json> --out <output.rp> [--cache-dir <dir>]
//                             [--no-interactions] [--verbose]
//   node proto.mjs generate   --out-dir <dir> [--out-rp <output.rp>] [--spec <spec.json>]
//                             [--preset web-dashboard|mobile-lostfound] [--theme ...] [--title "..."]
//                             [--no-interactions] [--strict-audit] [--compile-only] [--cache-dir <dir>] [--verbose]
//   node proto.mjs dump-spec  [--preset mobile-lostfound] -o <output.proto.json>
//   node proto.mjs selftest
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNativeRepeater } from './native-repeater.mjs';
import { writeNativeScene } from './native-scene.mjs';
import { createBlankProject } from './create-blank-project.mjs';
import { createPanel } from './create-panel-clone.mjs';
import { fillPanelState } from './fill-panel-state.mjs';
import { cloneLibraryWidget } from './clone-library-widget.mjs';
import { addInteractions } from './ix-actions.mjs';
import { mergePages } from './merge-pages.mjs';
import { placeMaster } from './place-master.mjs';
import { resolvePageRecord } from './ix-actions.mjs';
import { readRp } from './rp-read.mjs';
import { createGlobalVariable } from './create-global-variable.mjs';
import { setWidgetText } from './set-widget-text.mjs';
import { readRecords, encodeRecord, replaceRecord, appendPackage } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
import { guidKey } from './duplicate-page.mjs';
import { installRoot } from './version.mjs';
import { assertNotProtected } from './engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PY = join(HERE, 'proto.py');
const LANGUAGE_PY = join(HERE, 'rp_language_cli.py');
const TOOLS_DIR = process.env.ZEE_AXURE_TOOLS_DIR || join(HERE, '..', 'tools');
const RP9_PLACE_PY = process.env.ZEE_RP9_PLACE || join(TOOLS_DIR, 'rp9_place.py');
const AXTOOL_SWIFT = process.env.ZEE_AXTOOL_SWIFT || join(TOOLS_DIR, 'axtool.swift');
const DEFAULT_CACHE_DIR = process.env.ZEE_AXURE_CACHE_DIR || join(HERE, '..', '.proto-axvg-cache');

const HELP_TEXT = {
  main: `zee-axure 直接原型生成总控 CLI (proto.mjs)

用法:
  node scripts/proto.mjs <command> [options]

命令:
  schema            输出编辑器 JSON Schema（可用 --out 保存）
  format            格式化 RP/1 源文件（--check 检查格式；--out 写新文件）
  check             检查 RP/1 类型、数据、组件与作用域，不渲染或启动 Axure
  inspect           查看语义对象、来源与依赖（可选 --target）
  explain           解释指定对象的属性来源与作用域（--target 必填）
  complete          按源码位置补全（--pointer 默认为 /）
  explore           有界探索参考模型状态（不是原生行为证明）
  simulate          按 --steps JSON 文件执行参考模型步骤
  patch             按 --operations JSON 文件修改源码，--out 写新文件
  compile           编译声明式 spec.json 或内置预设为 .axvg.json + .spec.json + 2x 预览图 + 两级审计报告
  build-rp          从 compile-plan.json 装配单页/多页/多状态 .rp 文件并执行 rp-read 三零校验
  generate          一键执行 compile -> build-rp 全流程 (传 --compile-only 可仅执行离线编译与预览)
  dump-spec         导出内置预设的声明式 spec.json 模板 (别名: dump-preset-spec)
  selftest          运行 6 组全链路回归自检 (Web 三主题 + Mobile 双主题 + 自定义小画布两级审计)

公共参数:
  --spec <path>         声明式多页/组件树 spec.json 路径 (见 references/proto-spec.md)
  --preset <name>       内置预设: web-dashboard | mobile-lostfound (默认: web-dashboard)
  --theme <name>        设计令牌主题: enterprise-light | modern-dark | cobalt-pro | mobile-lowfi | mobile-hifi
  --title <text>        覆盖原型/页面主标题
  --no-interactions     静态交付模式：跳过全部交互绑定，生成纯静态原型 (interactions=0)
  --strict-audit        严格审计模式：将审美与令牌告警 (aesthetic_gates) 升级为硬失败 (exit 1)
  --compile-only        (仅 generate) 只生成 2x 预览图与审计报告，不启动 Axure GUI 装配 .rp
  --backend <name>      native | gui (RP/1 默认 native，旧规格默认 gui)
  --cache-dir <dir>     Axvg 粘贴阶段缓存目录 (默认: <skill>/.proto-axvg-cache)
  --verbose             在 stderr 打印分阶段耗时与详细错误分类日志
  -h, --help            显示帮助信息 (支持 node proto.mjs <command> --help)
`,
  schema: `用法: node scripts/proto.mjs schema [--out <schema.json>]\n`,
  format: `用法: node scripts/proto.mjs format --spec <source.json> [--out <new.json> | --check]\n`,
  check: `用法: node scripts/proto.mjs check --spec <rp-language.json>\n检查 language: "rp/1" 的类型、引用、数据和事件；失败返回 JSON Pointer 诊断。\n`,
  inspect: `用法: node scripts/proto.mjs inspect --spec <source.json> [--target <logical-id|pointer>] [--out <new.json>]\n`,
  explain: `用法: node scripts/proto.mjs explain --spec <source.json> --target <logical-id|pointer> [--out <new.json>]\n`,
  complete: `用法: node scripts/proto.mjs complete --spec <source.json> [--pointer <json-pointer>] [--out <new.json>]\n`,
  explore: `用法: node scripts/proto.mjs explore --spec <source.json> [--max-depth <nonnegative-int>] [--max-states <positive-int>] [--out <new.json>]\n有界参考模型探索；结果不能代替 RP9 原生点击验证。\n`,
  simulate: `用法: node scripts/proto.mjs simulate --spec <source.json> [--steps <steps.json>] [--out <new.json>]\nsteps 为 JSON 数组，例如 [{"target":"main/submit","event":"click"}] 或 [{"input":"main/name","value":"Alice"}]。省略表示初态。\n`,
  patch: `用法: node scripts/proto.mjs patch --spec <source.json> --operations <operations.json> --out <new-source.json> [--expected-hash <semanticHash>]\noperations 为 JSON 数组，例如 [{"op":"replace","path":"/pages/0/root/text","oldValue":"旧","value":"新"}]。输出源码永不覆盖已有文件；stdout 返回变化说明。\n`,
  compile: `用法:
  node scripts/proto.mjs compile --out-dir <dir> [options]

选项:
  --out-dir <dir>       编译产物输出目录 (必填)
  --spec <spec.json>    声明式多页/组件树 JSON 路径
  --preset <name>       内置预设: web-dashboard | mobile-lostfound
  --theme <name>        主题: enterprise-light | modern-dark | cobalt-pro | mobile-lowfi | mobile-hifi
  --title <text>        主标题覆盖
  --no-interactions     静态交付模式 (清空 compile-plan.json 中的交互列表)
  --strict-audit        严格审计模式 (审美门禁不达标时返回 exit 1)
  --verbose             打印编译耗时日志
`,
  'build-rp': `用法:
  node scripts/proto.mjs build-rp --plan <compile-plan.json> --out <output.rp> [options]

选项:
  --plan <path>         compile 生成的 compile-plan.json 路径 (必填)
  --out, -o <path>      输出 .rp 文件路径 (必填，禁止覆盖已存在文件)
  --backend <name>      native | gui (RP/1 默认 native，旧规格默认 gui)
  --cache-dir <dir>     Axvg 粘贴缓存目录
  --no-interactions     静态交付模式：跳过 addInteractions，产生物理 0 交互 .rp
  --verbose             打印每页图形生成、面板填充、多页合并、三零审计的分阶段耗时
`,
  generate: `用法:
  node scripts/proto.mjs generate --out-dir <dir> [--out-rp <output.rp>] [options]

选项:
  --out-dir <dir>       编译产物目录 (必填)
  --out-rp, -o <path>   输出 .rp 文件路径 (未传 --compile-only 时必填)
  --spec <spec.json>    声明式多页/组件树 JSON 路径
  --preset <name>       内置预设: web-dashboard | mobile-lostfound
  --theme <name>        主题: enterprise-light | modern-dark | cobalt-pro | mobile-lowfi | mobile-hifi
  --title <text>        主标题覆盖
  --no-interactions     静态交付模式：产出纯静态 .rp (interactions=0)
  --strict-audit        严格审计模式：审美门禁不达标时中止生成
  --compile-only        仅执行离线布局编译、2x 预览图渲染与审计，不调用 Axure GUI
  --backend <name>      native | gui (RP/1 默认 native，旧规格默认 gui)
  --cache-dir <dir>     Axvg 粘贴缓存目录
  --verbose             打印分阶段进度与耗时 (ms)
`,
  'dump-spec': `用法:
  node scripts/proto.mjs dump-spec [--preset mobile-lostfound] -o <output.proto.json>

选项:
  --preset <name>       内置预设名称 (默认: mobile-lostfound)
  -o, --out <path>      导出的 spec.json 文件路径 (必填)
`,
  selftest: `用法:
  node scripts/proto.mjs selftest

说明:
  依次验证 enterprise-light、modern-dark、cobalt-pro、mobile-lowfi、mobile-hifi 及自定义小画布两级审计门禁。
`,
};

function logVerbose(verbose, stage, detail, elapsedMs) {
  if (!verbose) return;
  const suffix = elapsedMs !== undefined ? ` (${elapsedMs}ms)` : '';
  console.error(`[proto] [${stage}] ${detail}${suffix}`);
}

function dedupStagePageNames(buf, prefix = '') {
  const records = readRecords(buf);
  const pageRec = records.find(r => r.className === 'Axure:Page');
  if (!pageRec) return buf;
  const graph = parsePayload(pageRec);
  const strings = [...pageRec.strings];
  const seen = new Map();
  let changed = false;
  for (const obj of graph.objects.values()) {
    if (!obj.className.startsWith('Axure:DiagramObject:')) continue;
    const nb = field(obj.body, 'name-block');
    const txtNode = nb && field(nb, 'text');
    let nm = txtNode?.text;
    if (!nm) continue;
    if (prefix && (nm.startsWith('frame-page') || nm.startsWith('bg-frame-'))) {
      nm = `${prefix}-${nm}`;
      let idx = strings.indexOf(nm);
      if (idx < 0) { idx = strings.length; strings.push(nm); }
      txtNode.value = idx + 1;
      txtNode.text = nm;
      changed = true;
    }
    const count = (seen.get(nm) ?? 0) + 1;
    seen.set(nm, count);
    if (count > 1) {
      const newName = `${nm}-inner-${count}`;
      let idx = strings.indexOf(newName);
      if (idx < 0) { idx = strings.length; strings.push(newName); }
      txtNode.value = idx + 1;
      txtNode.text = newName;
      changed = true;
    }
  }
  if (!changed) return buf;
  const pageRaw = encodeRecord(pageRec, strings, encodePayload(graph.roots));
  return replaceRecord(buf, pageRec, pageRaw);
}

function parseFlags(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else if (a === '-o') {
      flags.out = argv[++i];
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function runPy(args, { verbose = false } = {}) {
  const t0 = Date.now();
  logVerbose(verbose, 'compile:start', `python3 proto.py ${args.join(' ')}`);
  const r = spawnSync('python3', [PROTO_PY, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const elapsed = Date.now() - t0;
  if (r.status !== 0) {
    let diagnostics;
    try { diagnostics = JSON.parse(r.stderr.trim()).diagnostics; } catch {}
    if (diagnostics) {
      const error = new Error('RP/1 semantic check failed');
      error.diagnostics = diagnostics;
      throw error;
    }
    throw new Error(`[ERR_COMPILE] proto.py ${args.join(' ')} failed (exit=${r.status}, ${elapsed}ms):\n${r.stderr || r.stdout}`);
  }
  const parsed = JSON.parse(r.stdout.trim());
  logVerbose(verbose, 'compile:done', `ok=${parsed.ok} warnings=${(parsed.warnings ?? []).length}`, elapsed);
  return parsed;
}

function classifyPlaceError(status, axvgName, stdout, stderr) {
  const out = `${stdout || ''}\n${stderr || ''}`.trim();
  if (status === 4) {
    return `[ERR_DUPLICATE_NAME] Spec 存在重名元件或引用不唯一 (${axvgName}, exit=4):\n${out}`;
  }
  if (status === 3) {
    return `[ERR_COORD_MISMATCH] 粘贴后全量坐标校验未通过 (${axvgName}, exit=3):\n${out}`;
  }
  return `[ERR_GUI_PLACE] rp9_place.py 粘贴失败 (${axvgName}, exit=${status}，请确认 Axure RP 9 已启动且终端具备辅助功能权限):\n${out}`;
}

function placeAxvgToCachedRp(axvgPath, cacheDir = DEFAULT_CACHE_DIR, verbose = false) {
  const t0 = Date.now();
  mkdirSync(cacheDir, { recursive: true });
  const absAxvg = resolve(axvgPath);
  const specCand = absAxvg.replace(/\.axvg\.json$/, '.spec.json');
  const hashInput = Buffer.concat([
    readFileSync(absAxvg),
    existsSync(specCand) ? readFileSync(specCand) : Buffer.alloc(0),
  ]);
  const sha = createHash('sha256').update(hashInput).digest('hex').slice(0, 24);
  const cachedRp = join(cacheDir, `stage-${sha}.rp`);

  if (existsSync(cachedRp)) {
    const check = readRp(readFileSync(cachedRp), { path: cachedRp });
    if (check.counts.widgets > 0 && check.problems.length === 0 && (check.counts.danglingRefs ?? 0) === 0) {
      const elapsed = Date.now() - t0;
      logVerbose(verbose, 'place:cache-hit', `${basename(absAxvg)} -> widgets=${check.counts.widgets}`, elapsed);
      return { rpPath: cachedRp, cached: true, widgets: check.counts.widgets, elapsedMs: elapsed };
    }
    rmSync(cachedRp, { force: true });
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'proto-stage-'));
  try {
    let lastRes = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const titleTag = `stage-${sha.slice(0, 8)}-${attempt}`;
      const stageRp = join(tmpDir, `${titleTag}.rp`);
      createBlankProject(stageRp, { version: 9 });
      logVerbose(verbose, 'place:gui-run', `${basename(absAxvg)} (tag=${titleTag}, attempt=${attempt})`);
      const r = spawnSync('python3', [RP9_PLACE_PY, stageRp, titleTag, '--axvg', absAxvg], {
        encoding: 'utf8',
        timeout: 90000,
      });
      spawnSync('swift', [AXTOOL_SWIFT, 'press', 'com.axure.AxureRP9', 'File', 'Close', '--raise', titleTag], {
        encoding: 'utf8',
        timeout: 10000,
      });
      lastRes = r;
      if (r.status === 0) {
        const summary = readRp(readFileSync(stageRp), { path: stageRp });
        if (summary.problems.length > 0 || (summary.counts.danglingRefs ?? 0) > 0) {
          throw new Error(`[ERR_STAGE_THREE_ZEROS] Placed stage RP failed three-zeros: problems=${JSON.stringify(summary.problems)}`);
        }
        copyFileSync(stageRp, cachedRp);
        const elapsed = Date.now() - t0;
        logVerbose(verbose, 'place:gui-done', `${basename(absAxvg)} -> widgets=${summary.counts.widgets}`, elapsed);
        return { rpPath: cachedRp, cached: false, widgets: summary.counts.widgets, elapsedMs: elapsed };
      }
      if (r.status === 3 || r.status === 4) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    }
    throw new Error(classifyPlaceError(lastRes?.status ?? 1, basename(absAxvg), lastRes?.stdout, lastRes?.stderr));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function normalizeConditionWhen(when) {
  if (!when || typeof when !== 'object') return when;
  const out = { ...when };
  if (out.left && typeof out.left === 'object' && out.left.globalVariable && !out.left.variable) {
    out.left = { variable: out.left.globalVariable };
  }
  if (out.right && typeof out.right === 'object' && out.right.globalVariable && !out.right.variable) {
    out.right = { variable: out.right.globalVariable };
  }
  return out;
}

function normalizeEvents(events) {
  return (events ?? []).map(ev => ({
    ...ev,
    cases: (ev.cases ?? []).map((c, idx) => ({
      ...c,
      ...(c.when ? { when: normalizeConditionWhen(c.when) } : {}),
      description: c.description || c.name || `Case ${idx + 1}`,
      isNewIfGroup: c.isNewIfGroup ?? c.condition === 'if',
      actions: (c.actions ?? []).map(a => ({
        ...a,
        ...(a.type === 'set-text' || a.type === 'set-rich-text'
          ? { text: a.text ?? a.value ?? '' }
          : {}),
        ...(a.type === 'link'
          ? { page: a.page ?? a.target }
          : {}),
      })),
    })),
  }));
}

function createBlankPageBuffer() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'proto-blank-'));
  const blankRp = join(tmpDir, 'blank.rp');
  try {
    createBlankProject(blankRp, { version: 9 });
    return readFileSync(blankRp);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function buildInteractiveRp(
  planPath,
  outputRpPath,
  { cacheDir = DEFAULT_CACHE_DIR, backend, noInteractions = false, verbose = false } = {}
) {
  const buildT0 = Date.now();
  const absOut = resolve(outputRpPath);
  assertNotProtected(absOut);
  if (existsSync(absOut)) {
    throw new Error(`Output .rp already exists (refusing to overwrite): ${absOut}`);
  }
  const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
  backend ??= plan.language === 'rp/1' ? 'native' : 'gui';
  if (!['native', 'gui'].includes(backend)) throw new Error('backend must be native or gui');
  const buildStage = path => {
    if (backend === 'gui') return placeAxvgToCachedRp(path, cacheDir, verbose);
    const start = Date.now();
    const buffer = writeNativeScene(createBlankPageBuffer(), JSON.parse(readFileSync(path, 'utf8')));
    const summary = readRp(buffer);
    return { buffer, backend, cached: false, widgets: summary.counts.widgets, elapsedMs: Date.now() - start };
  };
  const stageBuffer = stage => stage.buffer ?? readFileSync(stage.rpPath);
  const stageInfo = ({ buffer, ...info }) => info;
  const pagesList = Array.isArray(plan.pages) && plan.pages.length > 0 ? plan.pages : [plan];
  const staticMode = Boolean(noInteractions || plan.static || plan.noInteractions);

  const stageReport = [];
  const panelReports = [];
  const inputReports = [];
  const interactionReports = [];
  const deferredInteractions = [];
  const builtPageInputs = [];

  const materializeInputs = (buf, inputs, pageLabel) => {
    if (!inputs.length) return buf;
    const tmpWork = mkdtempSync(join(tmpdir(), 'proto-inputs-'));
    try {
      const rplibPath = join(installRoot(9), 'Libraries', 'Default.rplib');
      let step = 0;
      for (const inp of inputs) {
        const input = join(tmpWork, `step-${step++}.rp`);
        const output = join(tmpWork, `step-${step++}.rp`);
        const initialized = join(tmpWork, `step-${step++}.rp`);
        writeFileSync(input, buf);
        const report = cloneLibraryWidget(rplibPath, input, output, {
          sourcePageName: 'Text Field', targetPageName: 'Page 1', name: inp.name,
          x: inp.x, y: inp.y, width: inp.w, height: inp.h,
          inputStyle: inp.style, placeholder: inp.placeholder,
        });
        setWidgetText(output, initialized, 'Page 1', inp.name, inp.value ?? '');
        buf = readFileSync(initialized);
        inputReports.push({ page: pageLabel, name: inp.name, id: report.id, geometry: report.geometry });
      }
      return buf;
    } finally { rmSync(tmpWork, { recursive: true, force: true }); }
  };

  const assemble = (stage, label, prefix) => {
    const start = buildStage(stage.mainAxvgPath ?? stage.axvgPath);
    stageReport.push({ page:label, role:'scene', ...stageInfo(start) });
    let buffer = dedupStagePageNames(stageBuffer(start),prefix);
    for (const dp of stage.dynamicPanels ?? []) {
      buffer = createPanel(buffer, {pageName:'Page 1',name:dp.name,states:dp.states.map(s=>s.name),x:dp.x,y:dp.y,width:dp.w,height:dp.h}).file;
      for (const state of dp.states) {
        const source = assemble(state,`${label}/${dp.name}/${state.name}`,state.prefix ?? state.name);
        const filled = fillPanelState(source,buffer,{sourcePage:'Page 1',targetPage:'Page 1',panel:dp.name,state:state.name,version:9});
        buffer = filled.file;
      }
      panelReports.push({page:label,panel:dp.name,states:dp.states.map(s=>s.name)});
    }
    for (const repeater of stage.repeaters ?? []) {
      const row = assemble(repeater.item,`${label}/${repeater.name}/item`,repeater.name);
      buffer = createNativeRepeater(buffer,row,repeater);
    }
    return materializeInputs(buffer,stage.nativeInputs ?? [],label);
  };

  for (let pIdx = 0; pIdx < pagesList.length; pIdx++) {
    const pPlan = pagesList[pIdx];
    const targetPageName = pPlan.pageName || `Page ${pIdx + 1}`;
    const pageSlug = pPlan.slug || `p${pIdx + 1}`;
    const pageStatic = Boolean(staticMode || pPlan.static || pPlan.noInteractions);
    let pageBuf = assemble(pPlan,targetPageName,pageSlug);

    // Bind all events after the final page/global-variable identities exist.
    if (!pageStatic) {
      for (const ix of pPlan.interactions ?? []) deferredInteractions.push({ pageName: targetPageName, ix });
    }

    builtPageInputs.push({ buf: pageBuf, name: targetPageName });
  }

  // Step 2: 合并全部单页为多页 .rp (或重命名单页)
  const mergeT0 = Date.now();
  let currentBuf = mergePages(builtPageInputs);
  logVerbose(verbose, 'merge-pages', `pages=${builtPageInputs.length}`, Date.now() - mergeT0);

  if ((plan.masters ?? []).length) {
    for (const mPlan of plan.masters) {
      const mBuf = materializeInputs(stageBuffer(buildStage(mPlan.axvgPath)), mPlan.nativeInputs ?? [], mPlan.name);
      const mRec = readRecords(mBuf).find(r => r.className === 'Axure:Page');
      const mGraph = parsePayload(mRec), mGuids = mGraph.roots.find(n => n.tag === 0x1e).values, mStrings = [...mRec.strings];
      mStrings[0] = 'Axure:Master';
      const ms = t => { let i = mStrings.indexOf(t); if (i < 0) { i = mStrings.length; mStrings.push(t); } return { tag: 8, value: i + 1, text: t }; };
      for (const id of mGraph.objects.keys()) mGuids[id - 1] = randomBytes(16).toString('hex');
      const pkgIdx = mGraph.roots.find(n => n.tag === 0x12).value;
      const newPkgGuid = (mGuids[pkgIdx - 1] = randomBytes(16).toString('hex'));
      const mRoot = [...mGraph.objects.values()].find(o => o.className === 'Axure:Page');
      mRoot.className = 'Axure:Master'; mRoot.classIndex = ms('Axure:Master').value;
      mRoot.body.entries = mRoot.body.entries.filter(([k]) => k.text !== 'Notes');
      mRoot.body.entries.push([ms('raised-event-list'), { tag: 2, items: [] }], [ms('LegacyViewToOffset'), { tag: 1, entries: [] }]);
      mRec.className = 'Axure:Master';
      const recs = readRecords(currentBuf), doc = recs.find(r => r.className === 'Axure:DesignDocument'), d = parsePayload(doc);
      const dg = d.roots.find(n => n.tag === 0x1e).values, dStrings = [...doc.strings];
      const ds = t => { let i = dStrings.indexOf(t); if (i < 0) { i = dStrings.length; dStrings.push(t); } return { tag: 8, value: i + 1, text: t }; };
      const alloc = hex => { dg.push(hex ?? randomBytes(16).toString('hex')); return dg.length; };
      const newNodeId = alloc(), newInfoId = alloc(), newPackageId = alloc(newPkgGuid);
      const baseInfo = [...d.objects.values()].find(n => n.className === 'Axure:PackageInfo');
      const newInfo = structuredClone(baseInfo);
      newInfo.id = newInfoId; newInfo.className = 'Axure:MasterPackageInfo'; newInfo.classIndex = ds('Axure:MasterPackageInfo').value;
      field(newInfo.body, 'package-id').values = [ds('Axure:Master').value, newPackageId];
      Object.assign(field(newInfo.body, 'package-name'), ds(mPlan.name || mPlan.id));
      field(newInfo.body, 'dependencies').items = [];
      if (!field(newInfo.body, 'master-mode')) newInfo.body.entries.push([ds('master-mode'), { tag: 5, value: 0 }]);
      const docRoot = d.objects.get(d.roots.find(n => n.tag === 0xf).value);
      field(docRoot.body, 'PackageInfos').items.push({ tag: 3, value: newInfoId });
      const masterMap = [...d.objects.values()].find(n => n.className === 'Axure:MasterTreeMap');
      const tree = d.objects.get(field(masterMap.body, 'tree').value);
      field(masterMap.body, 'node-table').entries.push([{ tag: 3, value: newNodeId }, { tag: 0x13, values: [ds('Axure:MasterPackageInfo').value, newPackageId] }]);
      field(tree.body, 'children').items.push({ tag: 3, value: newNodeId });
      const node = { tag: 9, id: newNodeId, classIndex: ds('Axure:Node').value, className: 'Axure:Node',
        body: { tag: 1, entries: [[ds('children'), { tag: 2, items: [] }], [ds('parent-node'), { tag: 3, value: tree.id }], [ds('tree'), { tag: 3, value: tree.id }]] } };
      d.roots.splice(d.roots.length - 1, 0, newInfo, node);
      currentBuf = replaceRecord(currentBuf, doc, encodeRecord(doc, dStrings, encodePayload(d.roots)));
      currentBuf = appendPackage(currentBuf, guidKey(newPkgGuid), encodeRecord(mRec, mStrings, encodePayload(mGraph.roots)));
      if (!staticMode) for (const ix of mPlan.interactions ?? []) deferredInteractions.push({ masterName: mPlan.name || mPlan.id, ix });
    }
    for (const page of pagesList) for (const instance of page.masters ?? []) {
      const master = plan.masters.find(m => m.id === instance.master);
      if (!master) throw new Error(`Unknown master instance: ${instance.master}`);
      const record = resolvePageRecord(currentBuf, page.pageName);
      currentBuf = placeMaster(currentBuf, { masterName: master.name || master.id, pageIndex: record.index, x: instance.x, y: instance.y }).file;
    }
  }

  if ((plan.adaptiveViews ?? []).length) {
    const recs = readRecords(currentBuf), doc = recs.find(r => r.className === 'Axure:DesignDocument'), g = parsePayload(doc);
    const strings = [...doc.strings], guids = g.roots.find(n => n.tag === 0x1e).values;
    const str = t => { let i = strings.indexOf(t); if (i < 0) { i = strings.length; strings.push(t); } return { tag: 8, value: i + 1, text: t }; };
    const id11 = v => ({ tag: 0x11, value: v }), f64 = v => ({ tag: 6, value: v }), ref = v => ({ tag: 3, value: v });
    const int = v => ({ tag: 5, value: v }), bool = v => ({ tag: 0x19, value: v });
    const dictOf = e => ({ tag: 1, entries: e }), list = items => ({ tag: 2, items });
    const obj = (id, cls, props) => ({ tag: 9, id, classIndex: str(cls).value, className: cls, body: dictOf(props.map(([n, v]) => [str(n), v])) });
    const BASE_VIEW_GUID = '0921e81902f16f47933582835c373474';
    let baseViewId = guids.indexOf(BASE_VIEW_GUID) + 1;
    if (!baseViewId) { guids.push(BASE_VIEW_GUID); baseViewId = guids.length; }
    const setGuidHex = randomBytes(16).toString('hex'); guids.push(setGuidHex); const setId = guids.length;
    const specs = plan.adaptiveViews.map(av => {
      if (av.condition !== undefined && !['<=', '>='].includes(av.condition)) throw new Error('adaptiveViews condition must be <= or >=');
      const guid = randomBytes(16).toString('hex'); guids.push(guid);
      return { sourceId: av.id || av.name, condition: av.condition, name: String(av.name || av.id), width: Number(av.width || 768), height: Number(av.height || 0), guid, id: guids.length };
    });
    const allocObj = () => { guids.push(randomBytes(16).toString('hex')); return guids.length; };
    const setObjId = allocObj(), baseViewObjId = allocObj(), childObjIds = specs.map(() => allocObj());
    const baseView = obj(baseViewObjId, 'Axure:AdaptiveView', [
      ['Id', id11(baseViewId)], ['Size', dictOf([[str('Width'), f64(0)], [str('Height'), f64(0)]])],
      ['Name', str('')], ['BaseViewId', id11(baseViewId)], ['BaseViewName', str('')], ['ParentAdaptiveViewSet', ref(setObjId)]]);
    const childViews = specs.map((sp, i) => obj(childObjIds[i], 'Axure:AdaptiveView', [
      ['Id', id11(sp.id)], ['Size', dictOf([[str('Width'), f64(sp.width)], [str('Height'), f64(sp.height)]])],
      ['Name', str(sp.name)], ['BaseViewId', id11(baseViewId)], ['BaseViewName', str('')], ['ParentAdaptiveViewSet', ref(setObjId)]]));
    const set = obj(setObjId, 'Axure:AdaptiveViewSet', [
      ['Id', id11(setId)], ['Name', str('')], ['DefaultAdaptiveView', ref(baseViewObjId)], ['AdaptiveViews', list(childViews.map(v => ref(v.id)))]]);
    const docObj = [...g.objects.values()].find(o => o.className === 'Axure:DesignDocument');
    for (const s of [set, baseView, ...childViews]) g.objects.set(s.id, s);
    field(docObj.body, 'AdaptiveViewSets').items.push(ref(set.id));
    const sitemapAt = g.roots.findIndex(n => n.tag === 9 && n.className === 'Axure:SiteTreeMap');
    g.roots.splice(sitemapAt >= 0 ? sitemapAt : g.roots.length - 1, 0, set, baseView, ...childViews);
    currentBuf = replaceRecord(currentBuf, doc, encodeRecord(doc, strings, encodePayload(g.roots)));
    const pageCount = readRecords(currentBuf).filter(r => r.className === 'Axure:Page').length;
    for (let pageIdx = pageCount - 1; pageIdx >= 0; pageIdx--) {
      const r = readRecords(currentBuf).filter(rec => rec.className === 'Axure:Page')[pageIdx];
      const pg = parsePayload(r), pstr = [...r.strings], pgGuids = pg.roots.find(n => n.tag === 0x1e).values;
      const ps = t => { let i = pstr.indexOf(t); if (i < 0) { i = pstr.length; pstr.push(t); } return { tag: 8, value: i + 1, text: t }; };
      const po = [...pg.objects.values()].find(o => o.className === 'Axure:Page');
      const miField = po && field(po.body, 'AdaptiveViewMatchInfos');
      if (!miField) continue;
      let setGuidIdx = pgGuids.indexOf(setGuidHex) + 1;
      if (!setGuidIdx) { pgGuids.push(setGuidHex); setGuidIdx = pgGuids.length; }
      const avSetIdField = field(po.body, 'AdaptiveViewSetId');
      if (avSetIdField) avSetIdField.value = setGuidIdx;
      for (const sp of specs) {
        let idx = pgGuids.indexOf(sp.guid) + 1; if (!idx) { pgGuids.push(sp.guid); idx = pgGuids.length; }
        miField.items.push(dictOf([[ps('Id'), id11(idx)], [ps('Name'), ps(sp.name)], [ps('Size'), dictOf([[ps('Width'), f64(sp.width)], [ps('Height'), f64(sp.height)]])]]));
        const alloc = () => { pgGuids.push(randomBytes(16).toString('hex')); return pgGuids.length; };
        const addStyle = (owner, className, props, base) => {
          const id = alloc();
          const style = { tag: 9, id, className, classIndex: ps(className).value, body: dictOf([
            ...(className === 'Axure:Style' ? [[ps('LibraryId'), id11(pgGuids.indexOf('0'.repeat(32)) + 1)], [ps('LibraryName'), ps('')], [ps('LegacyName'), ps('')]] : []),
            [ps('style-name'), ps('AdaptiveStyle')], [ps('Id'), id11(alloc())], [ps('PropList'), list(props)],
            [ps('Capabilities'), structuredClone(field(base?.body ?? {}, 'Capabilities') ?? { tag: 0x1d, value: 'bf7fdeffffeddff5' })], [ps('All'), bool(false)]
          ]) };
          pg.roots.splice(pg.roots.length - 1, 0, style); pg.objects.set(id, style);
          field(owner.body, 'AdaptiveStyles').items.push(id11(idx), ref(id));
        };
        const pageStyle = pg.objects.get(field(po.body, 'page-style')?.value);
        addStyle(po, 'Axure:PageStyle', [], pageStyle);
        const overrides = Object.assign({}, ...pagesList.map(p => p.adaptiveOverrides ?? {}));
        for (const widget of [...pg.objects.values()].filter(o => o.className?.startsWith('Axure:DiagramObject:'))) {
          const name = field(field(widget.body, 'name-block') ?? {}, 'text')?.text;
          const geom = overrides[name]?.[sp.sourceId] ?? overrides[name]?.[sp.name];
          if (!geom) continue;
          const base = pg.objects.get(field(widget.body, 'MyStyle')?.value), props = [];
          const baseValue = (doa, key, fallback) => {
            const prop = field(base?.body ?? {}, 'PropList')?.items.find(p => field(p, 'DOAName')?.value === doa);
            return field(field(prop ?? {}, 'Value') ?? {}, key)?.value ?? fallback;
          };
          if (geom.w !== undefined || geom.h !== undefined) props.push(dictOf([
            [ps('DOAName'), int(3221225577)], [ps('Value'), dictOf([[ps('Width'), f64(geom.w ?? baseValue(3221225577, 'Width', 0))], [ps('Height'), f64(geom.h ?? baseValue(3221225577, 'Height', 0))]])]
          ]));
          if (geom.x !== undefined || geom.y !== undefined) props.push(dictOf([
            [ps('DOAName'), int(3221225573)], [ps('Value'), dictOf([[ps('X'), f64(geom.x ?? baseValue(3221225573, 'X', 0))], [ps('Y'), f64(geom.y ?? baseValue(3221225573, 'Y', 0))]])]
          ]));
          addStyle(widget, 'Axure:Style', props, base);
        }
      }
      currentBuf = replaceRecord(currentBuf, r, encodeRecord(r, pstr, encodePayload(pg.roots)));
    }
  }

  if ((plan.adaptiveViews ?? []).length && !staticMode) {
    const views = plan.adaptiveViews;
    const ordered = views.some(v => v.condition) ? views : [...views].sort((a, b) => b.width - a.width);
    const cases = ordered.map((view, index) => ({
      description: `RP/1 adaptive ${view.id || view.name}`, isNewIfGroup: index === 0,
      condition: index === 0 ? 'if' : 'else-if',
      when: { left: { runtime: { kind: 'viewport-width', valueType: 'number' } }, op: view.condition ?? '>=', right: view.width },
      actions: [{ type: 'set-adaptive-view', view: view.name || view.id }],
    }));
    cases.push({ description: 'RP/1 adaptive fallback', condition: 'else', isNewIfGroup: false,
      actions: [{ type: 'set-adaptive-view', view: views.some(v => v.condition) ? 'base' : ordered.at(-1).name || ordered.at(-1).id }] });
    for (const page of pagesList.filter(p => !p.static)) {
      let ix = deferredInteractions.find(d => d.pageName === page.pageName && d.ix.trigger === 'page')?.ix;
      if (!ix) { ix = { trigger: 'page', events: [] }; deferredInteractions.push({ pageName: page.pageName, ix }); }
      for (const event of ['OnLoad', 'OnResize']) {
        const existing = ix.events.find(e => e.event === event);
        if (existing) existing.cases.push(...structuredClone(cases));
        else ix.events.push({ event, cases: structuredClone(cases) });
      }
    }
  }

  for (const [name, variable] of Object.entries(plan.variables ?? {})) {
    currentBuf = createGlobalVariable(currentBuf, name, { defaultValue: String(variable.value) }).file;
  }

  // Every accepted event must be materialized, including panel-state owners.
  const ixT0 = Date.now();
  for (const { pageName, masterName, ix } of deferredInteractions) {
    const isPageTrig = ix.trigger === 'page' || (typeof ix.trigger === 'object' && ix.trigger?.page && !ix.trigger?.widget);
    const owner = masterName ? { master: masterName } : { page: pageName };
    const trig = isPageTrig ? owner
      : { ...(typeof ix.trigger === 'object' ? ix.trigger : { widget: ix.trigger }), ...owner };
    let res;
    try {
      res = addInteractions(currentBuf, trig, normalizeEvents(ix.events), { replaceEvent: true, version: 9 });
    } catch (cause) {
      if (!ix.sourcePointer) throw cause;
      const error = new Error(cause.message);
      error.diagnostics = [{ severity: 'error', code: 'E_NATIVE_EVENT', pointer: ix.sourcePointer,
        sourceId: ix.sourceId, message: cause.message }];
      throw error;
    }
    currentBuf = res.file;
    interactionReports.push({ page: pageName, trigger: res.report.target,
      sourceId: ix.sourceId, sourcePointer: ix.sourcePointer, record: res.report.record,
      addedObjects: res.report.addedObjects, events: res.report.interactions.map(e => e.event) });
  }
  logVerbose(verbose, 'interactions:all', `bound=${deferredInteractions.length}`, Date.now() - ixT0);

  // Step 4: 落盘并执行 rp-read 三零与结构验证
  const auditT0 = Date.now();
  mkdirSync(dirname(absOut), { recursive: true });
  const finalSummary = readRp(currentBuf, { path: absOut, includeMasterWidgets: true });
  const allPageWidgets = finalSummary.pages.flatMap(p => (p.widgets ?? []).map(w => ({ ...w, record: p.record })));
  // The reader also exposes row-template objects in the page record. Prefer
  // their precise container path instead of reporting one native object twice.
  const mappedWidgets = new Map([...allPageWidgets, ...(finalSummary.containedWidgets ?? [])]
    .map(w => [`${w.record}:${w.id}`, w]));
  const nativeWidgets = [...mappedWidgets.values()];
  const layerCount = nativeWidgets.filter(w => w.type === 'Layer').length;
  const dynamicPanelCount = nativeWidgets.filter(w => w.type === 'DynamicPanel').length;

  const threeZerosOk = (finalSummary.counts.danglingRefs ?? 0) === 0
    && (finalSummary.counts.sentinelSlotsNonZero ?? 0) === 0
    && finalSummary.problems.length === 0
    && (finalSummary.duplicates ?? []).length === 0;

  if (!threeZerosOk) {
    throw new Error(`[ERR_FINAL_THREE_ZEROS] Final .rp failed three-zeros or duplicate check: ${JSON.stringify({
      danglingRefs: finalSummary.counts.danglingRefs,
      sentinelSlotsNonZero: finalSummary.counts.sentinelSlotsNonZero,
      problems: finalSummary.problems,
      duplicates: finalSummary.duplicates,
    })}`);
  }
  writeFileSync(absOut, currentBuf, { flag: 'wx' });
  const totalElapsedMs = Date.now() - buildT0;
  logVerbose(verbose, 'audit:rp-read', `pages=${finalSummary.counts.pages} widgets=${finalSummary.counts.widgets} interactions=${finalSummary.counts.interactions} problems=0`, Date.now() - auditT0);
  logVerbose(verbose, 'build-rp:done', `${absOut}`, totalElapsedMs);

  return {
    ok: true,
    outputRp: absOut,
    backend,
    version: finalSummary.version,
    static: staticMode,
    elapsedMs: totalElapsedMs,
    counts: {
      ...finalSummary.counts,
      containedWidgets: (finalSummary.containedWidgets ?? []).length,
      layers: layerCount,
      dynamicPanels: dynamicPanelCount,
      repeaters: nativeWidgets.filter(w => w.type === 'Repeater').length,
      nativeTextBoxes: inputReports.length,
      duplicates: (finalSummary.duplicates ?? []).length,
    },
    threeZeros: {
      danglingRefs: finalSummary.counts.danglingRefs ?? 0,
      sentinelSlotsNonZero: finalSummary.counts.sentinelSlotsNonZero ?? 0,
      problems: finalSummary.problems.length,
    },
    sourceMap: (plan.sourceMap ?? []).map(symbol => {
      const widgets = nativeWidgets.filter(w => w.name === (symbol.nativeName ?? symbol.name));
      return { ...symbol, native: widgets.map(w => ({ record: w.record, id: w.id, container: w.container ?? [] })) };
    }),
    eventCoverage: { declared: deferredInteractions.reduce((n, x) => n + (x.ix.events ?? []).length, 0),
      materialized: interactionReports.reduce((n, x) => n + x.events.length, 0) },
    stages: stageReport,
    panels: panelReports,
    nativeInputs: inputReports,
    interactions: interactionReports,
  };
}

function buildCompileArgs(flags, outDir) {
  const pyArgs = ['compile', '--out-dir', resolve(outDir)];
  if (flags.spec) pyArgs.push('--spec', resolve(String(flags.spec)));
  if (flags.preset) pyArgs.push('--preset', String(flags.preset));
  if (flags.theme) pyArgs.push('--theme', String(flags.theme));
  if (flags.title) pyArgs.push('--title', String(flags.title));
  if (flags['no-interactions']) pyArgs.push('--no-interactions');
  if (flags['strict-audit']) pyArgs.push('--strict-audit');
  return pyArgs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { flags, positionals } = parseFlags(process.argv.slice(2));
  const cmd = positionals[0];
  const verbose = Boolean(flags.verbose);

  if (flags.help || !cmd) {
    const helpKey = cmd && HELP_TEXT[cmd] ? cmd : (cmd === 'dump-preset-spec' ? 'dump-spec' : 'main');
    console.log(HELP_TEXT[helpKey]);
    process.exit(0);
  }

  try {
    if (['check', 'format', 'schema', 'inspect', 'explain', 'complete', 'explore', 'simulate', 'patch', 'dsl-to-json', 'json-to-dsl', 'dsl-format'].includes(process.argv[2])) {
      // Preserve the actual tokens: the language parser rejects unknown or misplaced
      // options instead of silently dropping them in the general prototype parser.
      const result = spawnSync('python3', [LANGUAGE_PY, ...process.argv.slice(2)], {encoding:'utf8', maxBuffer:32*1024*1024});
      if (result.error) throw Object.assign(new Error(result.error.message), { diagnostics: [{code:'E_TOOL_EXEC', pointer:'/arguments', severity:'error', message:result.error.message}] });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
    } else if (cmd === 'compile') {
      const outDir = flags['out-dir'] || positionals[1];
      if (!outDir) {
        console.error(HELP_TEXT.compile);
        process.exit(1);
      }
      console.log(JSON.stringify(runPy(buildCompileArgs(flags, outDir), { verbose }), null, 2));
    } else if (cmd === 'build-rp') {
      const plan = flags.plan || positionals[1];
      const out = flags.out || positionals[2];
      if (!plan || !out) {
        console.error(HELP_TEXT['build-rp']);
        process.exit(1);
      }
      console.log(
        JSON.stringify(
          buildInteractiveRp(plan, out, {
            cacheDir: flags['cache-dir'] || DEFAULT_CACHE_DIR,
            backend: flags.backend,
            noInteractions: Boolean(flags['no-interactions']),
            verbose,
          }),
          null,
          2
        )
      );
    } else if (cmd === 'generate') {
      const outDir = flags['out-dir'] || positionals[1];
      const outRp = flags['out-rp'] || flags.out || positionals[2];
      const compileOnly = Boolean(flags['compile-only']);
      if (!outDir || (!compileOnly && !outRp)) {
        console.error(HELP_TEXT.generate);
        process.exit(1);
      }
      const compiled = runPy(buildCompileArgs(flags, outDir), { verbose });
      if (compileOnly) {
        console.log(JSON.stringify({ ok: compiled.ok, compileOnly: true, compiled }, null, 2));
      } else {
        const rpBuilt = buildInteractiveRp(compiled.planPath, outRp, {
          cacheDir: flags['cache-dir'] || DEFAULT_CACHE_DIR,
          backend: flags.backend,
          noInteractions: Boolean(flags['no-interactions']),
          verbose,
        });
        console.log(JSON.stringify({ ok: compiled.ok && rpBuilt.ok, compiled, rpBuilt }, null, 2));
      }
    } else if (cmd === 'dump-spec' || cmd === 'dump-preset-spec') {
      const outFile = flags.out || positionals[1];
      if (!outFile) {
        console.error(HELP_TEXT['dump-spec']);
        process.exit(1);
      }
      const pyArgs = ['dump-spec', '-o', resolve(String(outFile))];
      if (flags.preset) pyArgs.push('--preset', String(flags.preset));
      console.log(JSON.stringify(runPy(pyArgs, { verbose }), null, 2));
    } else if (cmd === 'merge') {
      const result = spawnSync('python3', [PROTO_PY, ...process.argv.slice(2)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
    } else if (cmd === 'selftest') {
      console.log(JSON.stringify(runPy(['selftest'], { verbose }), null, 2));
    } else {
      console.error(`未知子命令: ${cmd}\n\n${HELP_TEXT.main}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(err.diagnostics ? JSON.stringify({ ok: false, language: 'rp/1', diagnostics: err.diagnostics })
      : err.stack || err.message || String(err));
    process.exit(1);
  }
}
