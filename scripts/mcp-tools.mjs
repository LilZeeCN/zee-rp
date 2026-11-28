import { validateInput } from '../studio/schema-validation.mjs';
export { validateInput } from '../studio/schema-validation.mjs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCommands } from './registry.mjs';
import { paginateDiffRp } from './diff-rp.mjs';
import { acquireOutputLock } from './file-lock.mjs';
import { cacheDirectory, pruneBuildCache } from './build-cache.mjs';
import { localizeDiagnostic } from './diagnostics-i18n.mjs';
import { assertNotProtected, assertWritable, AxureSession, resolveWorkDir } from './engine.mjs';
import { spawnPythonSync } from './python.mjs';
import { readRp } from './rp-read.mjs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { setWidgetRichText } from './set-widget-richtext.mjs';
import { setWidgetNames } from './name-widget.mjs';
import { listCustomStyles, renameCustomStyle, rebindWidgets, widgetSelector } from './custom-styles.mjs';
import { EVENTS, addInteractionsBatch, loadBaselineMap, resolveBaselineTarget } from './ix-actions.mjs';
import { lintInteractionSpecs, lintNativeInteractions } from './interaction-lint.mjs';
import { bindNativeSymbols, nativeWidgetIdentities, officialIdOf, readSourceBaseline, saveIdentityBaseline } from './native-widget-identity.mjs';
import { patchNativeProgram } from './native-program-patch.mjs';
import { compilePrototype, buildInteractiveRp, reportPrototypeProgress } from './proto.mjs';
import { expandSpec, pasteAxvg } from './axvg.mjs';
import { createBlankProject } from './create-blank-project.mjs';
import { writeNativeScene } from './native-scene.mjs';
import { mergePages } from './merge-pages.mjs';
import { authoringTools, captureOfficialHtmlScreenshot, isInlineRp1Text, readNativeInteractionSource, recipes, recipeSource, runWorkflow, pythonEnvironment, exportPrototype, verifyOfficialPreview, renamedCompanion, companionRenamedError } from './authoring-workflow.mjs';
import { importHtmlToRp1Spec, isHtmlInput } from './html-import.mjs';
import { reviewImageStructure } from './image-structure.mjs';
import { studioTools, runStudioFixPlanOnRp1 } from '../studio/mcp-adapter.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT_DIR = resolve(SCRIPTS_DIR, '..');
const TRACE_PY = join(SCRIPTS_DIR, 'trace.py');
const PROTO_PY = join(SCRIPTS_DIR, 'proto.py');
const RP_LANG_CLI = join(SCRIPTS_DIR, 'rp_language_cli.py');
const resolveInWork = (p, explicitDir) => {
  if (typeof p !== 'string' || !p) return p;
  return isAbsolute(p) ? p : resolve(resolveWorkDir(explicitDir), p);
};

const dump = spawnSync(process.execPath, [fileURLToPath(new URL('./registry.mjs', import.meta.url)), 'dump'], { encoding: 'utf8' });
if (dump.status !== 0) throw new Error(dump.stderr || 'registry dump failed');
const config = JSON.parse(dump.stdout).libScripts.find(row => row.script === 'mcp-tools.mjs');
export const jobTools = JSON.parse(dump.stdout).libScripts.find(row => row.script === 'jobs.mjs')?.tools ?? [];
if (!config) throw new Error('mcp-tools.mjs 未在注册表登记');
export const toolName = command => command.replaceAll(/[ -]/g, '_');

// 低层 SDK 不自动执行 JSON Schema 校验；本表只使用这些 JSON Schema 关键字。
// RP 工具的宿主输入与输出位置；多源导入的第一个参数仍由调用方提供。
function commandIO(command) {
  if (command.command === 'rp-read') return { source: 'file', readOnly: true };
  if (command.output === 'index:3') return { source: 'source', output: 'output', prefix: 2 };
  if (command.output === 'index:4') return { source: 'target', output: 'output', prefix: 3, external: true };
  if (command.command === 'create-blank-project') return { output: 'output', prefix: 1 };
  return null; // Axvg 的输入输出不是 RP，会话不会改写其参数。
}

export const MCP_PROFILES = {
  full: null,
  core: new Set([
    'generate_prototype', 'revise_prototype', 'export_prototype', 'verify_prototype',
    'prototype_recipe', 'diagnose_prototype', 'sync_prototype', 'generate_from_image',
    'axure_open', 'axure_save', 'rp_inspect', 'rp_patch', 'rp_command',
    'runtime_info', 'gui_roundtrip', 'jobs',
  ]),
  studio: new Set([
    'studio_open_project', 'studio_describe', 'studio_command', 'studio_inspect',
    'studio_screenshot', 'studio_export', 'studio_history', 'studio_stage',
    'studio_design', 'studio_scenario', 'studio_media', 'studio_merge', 'studio_operations',
    'export_prototype', 'verify_prototype', 'gui_roundtrip', 'runtime_info',
  ]),
  author: new Set([
    'generate_prototype', 'revise_prototype', 'export_prototype', 'verify_prototype',
    'prototype_recipe', 'diagnose_prototype', 'sync_prototype', 'generate_from_image',
    'axure_open', 'axure_save', 'runtime_info', 'gui_roundtrip', 'jobs',
    'studio_open_project', 'studio_describe', 'studio_command', 'studio_inspect',
    'studio_screenshot', 'studio_export', 'studio_history', 'studio_stage',
    'studio_design', 'studio_scenario', 'studio_media', 'studio_merge', 'studio_operations',
  ]),
};

export function resolveMcpProfile(profile) {
  const name = String(profile || process.env.ZEE_MCP_PROFILE || 'full').trim().toLowerCase();
  if (!Object.hasOwn(MCP_PROFILES, name)) {
    throw Object.assign(new Error(`未知 MCP profile "${name}"；可选：${Object.keys(MCP_PROFILES).join(', ')}`), { code: 'E_MCP_PROFILE' });
  }
  return name;
}

export function listMcpTools({ profile } = {}) {
  const active = resolveMcpProfile(profile);
  const allow = MCP_PROFILES[active];
  const all = sessionTools.map(({ name, description, inputSchema, readOnly }) => ({
    name,
    description,
    inputSchema: stripSchemaDescriptions(inputSchema),
    annotations: { readOnlyHint: Boolean(readOnly), destructiveHint: false, openWorldHint: false },
  }));
  return allow ? all.filter(t => allow.has(t.name)) : all;
}

function commandSchema(commandName) {
  const command = listCommands().find(c => c.command === commandName);
  const binding = config.commandSchemas[commandName];
  const io = commandIO(command);
  const raw = structuredClone(config.defaultInputSchema);
  if (io) raw.properties.session = { type: 'boolean', description: 'true 时 args 省略宿主源和输出，由当前链注入；多源工具仍传导入源。' };
  if (!binding) return raw;
  const named = structuredClone(binding.inputSchema);
  named.required = named.required.filter(key => key !== io?.source && key !== io?.output);
  return config.rawArgs ? { type: 'object', oneOf: [named, raw] } : named;
}

const toolResult = (value, isError = false) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { isError, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
  const { mcpImages, ...payload } = value;
  const images = Array.isArray(mcpImages) ? mcpImages.filter(i => i.mimeType === 'image/png' && typeof i.data === 'string').slice(0, 4) : [];
  return { isError, structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) },
    ...images.map(i => ({ type: 'image', mimeType: i.mimeType, data: i.data }))] };
};
const countsOf = rp => ({ pages: rp.counts.pages, widgets: rp.counts.widgets, interactions: rp.counts.interactions, actions: rp.counts.actions, containedWidgets: rp.containedWidgets.length, masters: rp.counts.masters });

function commandArgs(command, input) {
  const binding = config.commandSchemas[command.command];
  if (!binding || Object.hasOwn(input, 'args')) return [...input.args];
  if (command.command === 'fill-panel-state' && Boolean(input.targetPage) === Boolean(input.targetMaster))
    throw new Error('Choose exactly one targetPage or targetMaster');
  const args = binding.positionals.map(key => key === 'targetPage' && command.command === 'fill-panel-state'
    ? input.targetPage ?? input.targetMaster : input[key]);
  if (command.command === 'fill-panel-state' && input.targetMaster) args.push('--master');
  args.push(...binding.constants ?? []);
  for (const [key, flag] of Object.entries(binding.flags ?? {})) if (input[key]) args.push(flag);
  for (const [key, flag] of Object.entries(binding.values ?? {})) if (input[key] !== undefined) args.push(flag, input[key]);
  for (const [key, values] of Object.entries(binding.enumFlags ?? {})) args.push(...values[input[key]] ?? []);
  if (binding.action) for (let i = 0; i < binding.action.length; i += 2) args.push(binding.action[i], input[binding.action[i + 1]]);
  if (binding.tail) args.push(...input[binding.tail] ?? []);
  return args;
}

function governReadOnlyOutput(payload, { workDir, maxBytes = 24000, label }) {
  const serialized = JSON.stringify(payload);
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= maxBytes) return payload;
  const hash = createHash('sha256').update(serialized).digest('hex');
  const dir = join(workDir, '.zee-cache', 'reports');
  const fullReportPath = join(dir, `${label}-${hash.slice(0, 20)}.json`);
  assertNotProtected(fullReportPath);
  assertWritable(fullReportPath);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(fullReportPath)) {
    const temporary = join(dir, '.' + randomUUID());
    try {
      writeFileSync(temporary, serialized + '\n', { flag: 'wx' });
      renameSync(temporary, fullReportPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const receipt = {
    ...(payload.command ? { command: payload.command, exitCode: payload.exitCode } : {}),
    ok: payload.ok ?? true, status: payload.status ?? 'completed',
    truncated: true, originalBytes, fullReportPath,
  };
  if (label === 'diff-rp') {
    try {
      const diff = JSON.parse(payload.stdout);
      for (const limit of [30, 15, 5, 0]) {
        const summary = paginateDiffRp(diff, { limit });
        const compact = { ...receipt, stdout: JSON.stringify(summary), summary: summary.summary,
          nextOffset: summary.pagination.nextOffset };
        if (Buffer.byteLength(JSON.stringify(compact)) <= maxBytes) return compact;
      }
    } catch { /* The full output is still available in the report. */ }
  }
  return receipt;
}

function runCommandPayload(command, input, { cwd } = {}) {
  const workDir = resolveWorkDir(cwd);
  const io = commandIO(command);
  const raw = Object.hasOwn(input, 'args');
  let args = commandArgs(command, input);
  let state = null, node = null, source = null, before = null;
  try {
  if (io) {
    const useSession = raw ? input.session === true : input[io.source] === undefined && input[io.output] === undefined;
    if (!raw && !useSession && ((!io.readOnly && input[io.output] === undefined) || (io.source && input[io.source] === undefined)))
      throw new Error('显式模式必须同时提供宿主源和输出；全部省略才自动接续会话。');
    if (useSession) {
      state = refreshState(requireSession());
      if (!io.readOnly && Object.values(zerosOf(state.rp)).some(Boolean)) throw new Error('链尾结构不健康，请先调用 rp_inspect({ view: "verify" }) 检查。');
      source = state.chain.at(-1);
      before = countsOf(state.rp);
      if (io.readOnly) args = raw ? [source, ...args] : commandArgs(command, { ...input, file: source });
      else {
        node = nextWorkNode(state);
        assertWritable(node);
        if (raw) {
          if (io.external && !args[0]) throw new Error('多源导入仍需 args[0] 的外部源路径。');
          args = io.external ? [args[0], source, node, ...args.slice(1)] : io.source ? [source, node, ...args] : [node, ...args];
        } else args = commandArgs(command, { ...input, [io.source]: source, output: node });
      }
    } else {
      // 显式模式只增加前后摘要，不改变原始参数或活动会话。
      const rawSource = raw ? args.filter(a => !a.startsWith('--'))[io.external ? 1 : 0] : input[io.source];
      source = io.source && rawSource ? resolveInWork(rawSource, workDir) : null;
      if (source) { assertNotProtected(source); before = countsOf(readRp(readFileSync(source), { path: source })); }
    }
  }
  if (command.command.startsWith('axvg ')) args = [command.command.split(' ')[1], ...args];
  const result = new AxureSession({ source, cwd: workDir }).run(command.command, args);
  const rawStderr = result.stderr.toString();
  const errHeaderMatch = rawStderr.match(/^(?:[\w$]*Error|ERR_[\w$]+):\s*(.+)$/m);
  const cleanStderr = errHeaderMatch
    ? errHeaderMatch[1].trim()
    : (rawStderr
        .split(/\r?\n/)
        .map(ln => ln.trim())
        .filter(ln => ln && !/^at\s+/.test(ln) && !ln.includes('file://') && !/^\^+$/.test(ln) && !/^Node\.js\s+v/i.test(ln))
        .join('\n') || rawStderr.trim());
  const value = { command: command.command, exitCode: result.status, stdout: result.stdout.toString(), stderr: result.status === 0 ? rawStderr : cleanStderr, status: result.status === 0 ? 'completed' : 'failed' };
  if (result.status !== 0) {
    if (node && !/EEXIST|already exists/i.test(rawStderr) && pathExists(node)) value.rejected = rejectNode(node);
    let detail;
    if (command.command === 'add-interaction') {
      try { detail = JSON.parse(rawStderr); } catch { /* Plain CLI error. */ }
    }
    const errCode = detail?.code ?? (/EEXIST|already exists/i.test(rawStderr) ? 'E_OUTPUT_EXISTS' : 'E_TOOL_INPUT');
    value.ok = false;
    value.code = errCode;
    value.message = detail?.message ?? (cleanStderr || `${command.command} 执行失败 (exit=${result.status})`);
    value.diagnostics = detail?.diagnostics ?? [{ code: errCode, pointer: '/arguments', message: value.message, nextAction: '检查参数或读取最新原型状态；保留原文件后重试。' }];
    value.usage = command.usage;
    value.candidates = errorCandidates(command, input, args, source, rawStderr);
    if (state) value.chainTail = state.chain.at(-1);
    return value;
  }
  if (node) {
    commitChainNode(state, node, { op: command.command, at: now(), from: source, node });
    const syncStatus = computeSyncStatus(state);
    Object.assign(value, { chainTail: node, previousTail: source, before, after: countsOf(state.rp), structure: zerosOf(state.rp), ...(syncStatus ? { syncStatus } : {}) });
  } else if (io && !io.readOnly) {
    // 宿主输出在所有 RP 工具中固定为前缀末尾；Axvg 不进入此分支。
    const rawOutput = raw ? args.filter(a => !a.startsWith('--'))[io.prefix - 1] : input.output;
    const output = rawOutput ? resolveInWork(rawOutput, workDir) : null;
    if (output) { assertNotProtected(output); value.output = output; value.before = before; value.after = countsOf(readRp(readFileSync(output), { path: output })); }
  }
  return command.output === 'none'
    ? governReadOnlyOutput(value, { workDir, maxBytes: input.maxBytes, label: command.command.replaceAll(' ', '-') })
    : value;
  } finally {
    if (node) releaseWorkNode(node);
  }
}

async function runInteractionCommand(input, cwd, dryRun) {
  const workDir = resolveWorkDir(cwd);
  const state = input.source === undefined ? refreshState(requireSession()) : null;
  if ((state && input.output !== undefined) || (!state && !dryRun && input.output === undefined)) {
    throw new Error('显式写入需同时传 source/output。只预检可仅传 source。');
  }
  const source = state?.chain.at(-1) ?? resolve(workDir, input.source);
  assertNotProtected(source);
  const originalHash = sha256Of(source);
  const file = readFileSync(source);
  const rp = state?.rp ?? readRp(file, { path: source });
  const fail = (code, message, diagnostics, extra = {}) => ({ status: 'failed', code, message, diagnostics,
    ...(state ? { chainTail: state.chain.at(-1) } : {}), ...extra });
  if (Object.values(zerosOf(rp)).some(Boolean)) throw new Error('宿主未通过结构三零，请先用 rp_inspect(view="verify") 检查。');
  const requestedBaseline = input.baseline ? resolve(workDir, input.baseline) : null;
  if (requestedBaseline && !pathExists(requestedBaseline)) throw new Error(`找不到指定基线：${input.baseline}`);
  const baselinePath = requestedBaseline ?? findBaselineForRp(source, undefined, state);
  const baseline = loadBaselineMap(source, baselinePath);
  const programRequest = input.program !== undefined || input.programs !== undefined;
  if (programRequest && [input.items, input.interactions, input.action, input.event, input.target].some(v => v !== undefined)) {
    throw new Error('program/programs 与底层 items、interactions 或 action 参数二选一。');
  }
  const sourceBaseline = programRequest ? readSourceBaseline(source, baselinePath ?? undefined) : null;
  const coerce = value => value === 'true' ? true : value === 'false' ? false
    : value !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  const singleAction = input.action ? { type: input.action, ...Object.fromEntries((input.parameters ?? []).map(param => {
    const split = param.indexOf('=');
    return [param.slice(0, split), coerce(param.slice(split + 1))];
  })) } : null;
  const items = programRequest ? [] : input.items ?? [{ target: input.target, page: input.page, onPage: input.onPage,
    interactions: input.interactions ?? [{ event: input.event, actions: [singleAction] }] }];
  const diagnostics = [], events = [];
  let expressionCount = 0;
  for (const [index, item] of items.entries()) {
    const reference = item.page ? { page: item.target } : item.onPage && typeof item.target === 'string'
      ? { widget: item.target, page: item.onPage } : item.target;
    const target = resolveBaselineTarget(reference, baseline);
    const context = { page: target?.page ?? null, target: item.target };
    try {
      const report = lintInteractionSpecs(item.interactions ?? [{ event: item.event, actions: item.actions }], {
        context, variables: rp.globalVariables.map(v => v.name), version: rp.version,
      });
      diagnostics.push(...report.diagnostics.map(d => ({ ...d, pointer: input.items ? `/items/${index}${d.pointer}` : d.pointer })));
      events.push(...report.events);
      expressionCount += report.expressionCount;
    } catch (error) {
      diagnostics.push({ ...context, code: 'E_AXURE_CASE_GROUP', severity: 'error', pointer: input.items ? `/items/${index}/interactions` : '/interactions',
        message: error.message, nextAction: '检查 condition、when 与 isNewIfGroup。' });
    }
  }
  const mode = input.preflight ?? 'auto';
  const lint = { diagnostics, events, expressionCount };
  const hasErrors = diagnostics.some(d => d.severity === 'error');
  // Explicit official probes may replay a known STO syntax error for complete
  // vendor evidence. No blocked candidate is ever published.
  if (hasErrors && (mode !== 'official' || diagnostics.some(d => d.severity === 'error' && d.code !== 'E_AXURE_STO_MATH_NAMESPACE'))) {
    return fail('E_INTERACTION_PREFLIGHT', '交互静态预检失败。', diagnostics, { lint });
  }
  let candidate;
  try {
    candidate = programRequest ? patchNativeProgram(file, rp, input, sourceBaseline, baseline,
      (spec, options) => runWorkflow('native-program', spec, options))
      : addInteractionsBatch(file, items, { replaceEvent: input.replaceEvent, baseline, widgetIdentities: nativeWidgetIdentities(rp) });
  } catch (error) {
    const code = /has no state/.test(error.message) ? 'E_AXURE_PANEL_STATE' : /exactly one (?:widget|page)|Page record not found/.test(error.message)
      ? 'E_AXURE_INTERACTION_TARGET' : 'E_AXURE_INTERACTION';
    if (error.diagnostics) return fail(error.code ?? code, error.message, [...diagnostics, ...error.diagnostics], { lint });
    const location = error.cause?.location ?? {};
    return fail(code, error.message, [...diagnostics, { ...location, code, severity: 'error', message: error.message,
      nextAction: '按报错的事件与 Case 检查目标、状态和参数。可用 rp_inspect(view="locate") 查询原生 GUID。' }], { lint });
  }
  const resultRp = readRp(candidate.file);
  const structure = zerosOf(resultRp);
  if (Object.values(structure).some(Boolean)) return fail('E_AXURE_INTERACTION_STRUCTURE', '交互候选文件未通过结构三零。', diagnostics, { structure, lint });
  let official = { status: 'skipped', reason: mode === 'static' ? 'static-only' : 'no-expressions' };
  if (mode === 'official' || (mode === 'auto' && (programRequest || expressionCount > 0))) {
    const stageParent = input.output ? dirname(resolve(workDir, input.output)) : workDir;
    assertWritable(join(stageParent, '.zee-interaction-check'));
    const stage = mkdtempSync(join(stageParent, '.zee-interaction-check-'));
    try {
      const staged = join(stage, 'candidate.rp');
      assertWritable(staged);
      writeFileSync(staged, candidate.file, { flag: 'wx' });
      const exportResult = await exportPrototype({ rp: staged, output: join(stage, 'html'), baseline: baselinePath ?? undefined, cwd: workDir, includeWidgetMap: false });
      if (exportResult.interactionCompilation) {
        official = exportResult.interactionCompilation;
        if (official.status === 'unavailable') official = { ...official, status: 'incomplete' };
      } else {
        const unavailable = /^E_ASSEMBLY_(?:PLATFORM|ARCH|INSTALL|IDENTITY|PROFILE|RUNTIME)$/.test(exportResult.diagnostics?.[0]?.code ?? '');
        official = { status: unavailable ? 'unavailable' : 'failed', diagnostics: exportResult.diagnostics };
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    if (['failed', 'incomplete'].includes(official.status) || (mode === 'official' && official.status !== 'passed') || hasErrors) {
      return fail('E_INTERACTION_PREFLIGHT', '官方交互预检未通过。', [...diagnostics, ...(official.diagnostics ?? [])], { lint, official, structure });
    }
  }
  const report = input.items || programRequest ? candidate.report : candidate.report.results[0];
  const nativeProgram = candidate.program ? summarizeNativePrograms(candidate.program) : undefined;
  const detail = { command: 'add-interaction', exitCode: 0, stdout: JSON.stringify(report), stderr: '',
    report, lint, official, structure, before: countsOf(rp), after: countsOf(resultRp), ...(nativeProgram ? { nativeProgram } : {}) };
  if (dryRun) return { status: 'completed', dryRun: true, ...detail };
  if ((state && (session !== state || state.chain.at(-1) !== source)) || sha256Of(source) !== originalHash) {
    return fail('E_STALE_INTERACTION_SOURCE', '预检期间宿主发生变化，请读取最新版本后重试。', diagnostics);
  }
  const output = state ? nextWorkNode(state) : resolve(workDir, input.output);
  let created = false, writtenBaseline;
  try {
    assertWritable(output);
    if (((!state && baselinePath) || programRequest) && pathExists(`${output}.baseline.json`)) throw new Error(`目标基线已存在：${output}.baseline.json`);
    writeFileSync(output, candidate.file, { flag: 'wx' });
    created = true;
    if (programRequest) {
      const sidecar = `${output}.baseline.json`;
      assertWritable(sidecar);
      const base = sourceBaseline ?? {};
      writeFileSync(sidecar, JSON.stringify({
        version: 1, ...base, outputRp: output,
        sourceMap: bindNativeSymbols(candidate.sourceMap, nativeWidgetIdentities(resultRp)),
        programBindings: candidate.programBindings,
      }, null, 2) + '\n', { flag: 'wx' });
      writtenBaseline = sidecar;
    }
    if (state) {
      commitChainNode(state, output, { op: 'add-interaction', at: now(), from: source, node: output });
      return { status: 'completed', ...detail, chainTail: output, previousTail: source, syncStatus: computeSyncStatus(state),
        ...(writtenBaseline ? { baseline: writtenBaseline } : {}) };
    }
    const outputBaseline = writtenBaseline ?? (baselinePath ? saveIdentityBaseline(source, output, resultRp, baselinePath) : null);
    return { status: 'completed', ...detail, output, ...(outputBaseline ? { baseline: outputBaseline } : {}) };
  } catch (error) {
    if (writtenBaseline) unlinkSync(writtenBaseline);
    if (created && pathExists(output) && state?.chain.at(-1) !== output) unlinkSync(output);
    if (error.code === 'EEXIST') return fail('E_OUTPUT_EXISTS', `输出已存在：${output}`, diagnostics);
    throw error;
  } finally {
    if (state) releaseWorkNode(output);
  }
}

function errorCandidates(command, input, args, source, message) {
  if (!source || !/unique|multiple|ambig|exactly one|重名|唯一|匹配/i.test(message)) return [];
  try {
    assertNotProtected(source);
    const rp = readRp(readFileSync(source));
    const targetCommands = ['add-interaction', 'remove-interaction', 'add-click-link'];
    const namedCommands = ['set-widget-text', 'set-combobox-options', 'set-listbox-options', 'set-connector-anchors'];
    let query = input.widget ?? (targetCommands.includes(command.command) ? input.target ?? args[2] : namedCommands.includes(command.command) ? args[3] : null);
    let container;
    if (command.command === 'remove-panel-state-content') {
      const missing = message.match(/Top-level widget (.*?) must be unique; found/);
      if (missing && args.slice(5).includes(missing[1])) { query = missing[1]; container = `${args[3]}(${args[4]})`; }
      else if (/Panel .*? must be unique/.test(message)) query = args[3];
      else return [];
    }
    if (!query) return [];
    const state = { rp, chain: [source] };
    const page = typeof input.page === 'string' ? input.page : input.onPage ?? (namedCommands.includes(command.command) || command.command === 'remove-panel-state-content' ? args[2] : undefined);
    return widgetIndex(state).filter(w => w.name === query && (page === undefined || w.page === page) && (container === undefined || w.container.join('/') === container)).map(candidateView);
  } catch { return []; }
}

const LEGACY_TOOL_HINTS = {
  axure_state: '会话状态已合并至 axure_save({}) 或 rp_inspect({ view: "state" })。',
  locate: '元件搜索已合并至 rp_inspect({ view: "locate", query, page, type, path })。',
  inspect: '元件深看已合并至 rp_inspect({ view: "widget", target, path })。',
  read_interactions: '交互树读取已合并至 rp_inspect({ view: "interactions", page, widget, path })。',
  verify: '结构与三零校验已合并至 rp_inspect({ view: "verify", deep, path })（浏览器真机验收可用 verify_prototype）。',
  rp_read: '文档总览读取已合并至 rp_inspect({ view: "overview", path, full })（底层 CLI 可用 rp_command）。',
  list_custom_styles: '自定义样式列表已合并至 rp_inspect({ view: "styles", path })。',
  edit_text: '文字与富文本修改已合并至 rp_patch({ target, text | richRuns, edits })。',
  set_widget_text: '文字修改已合并至 rp_patch({ target, text })（或 rp_command({ command: "set-widget-text", ... })）。',
  set_widget_richtext: '富文本修改已合并至 rp_patch({ target, richRuns })（或 rp_command({ command: "set-widget-richtext", ... })）。',
  rename_widget: '元件改名已合并至 rp_patch({ target, name, edits })。',
  name_widget: '元件改名已合并至 rp_patch({ target, name })（或 rp_command({ command: "name-widget", ... })）。',
  set_widget_geometry: '几何修改已合并至 rp_patch({ target, x, y, w, h, edits })。',
  set_widget_style: '视觉样式修改已合并至 rp_patch({ target, fill, stroke, color, radius, edits })。',
  rename_custom_style: '自定义样式重命名已合并至 rp_patch({ op: "rename-style", oldName, newName, source, output })。',
  rebind_widgets: '自定义样式重绑定已合并至 rp_patch({ op: "rebind-style", styleGuid, selector, resetOverrides, source, output })。',
  explain_binding: '交互与绑定追踪已合并至 diagnose_prototype({ mode: "binding", source, target })。',
  review_image_structure: '截图分层结构审查已合并至 diagnose_prototype({ mode: "image", spec })。',
  jobs_list: '异步任务管理已合并至 jobs({ action: "list" })。',
  jobs_get: '异步任务查询已合并至 jobs({ action: "get", id })。',
  jobs_cancel: '异步任务取消已合并至 jobs({ action: "cancel", id })。',
};

export function callCommandTool(name, input) {
  const legacyHint = LEGACY_TOOL_HINTS[name];
  const command = listCommands().find(c => toolName(c.command) === name);
  try {
    const sessionTool = sessionToolIndex.get(name);
    if (sessionTool) return sessionTool(input);
    if (legacyHint) throw new Error(`未知工具 ${name}：${legacyHint}`);
    if (command) throw new Error(`未知工具 ${name}：底层原生命令已折叠至 rp_command({ command: "${command.command}", params | args })。`);
    throw new Error(`未知工具 ${name}`);
  } catch (error) {
    if (name === 'generate_prototype') return toolResult({ status: 'failed', stage: 'validation', message: error.message,
      diagnostics: [{ code: 'E_GENERATE_ARGUMENT', pointer: '/arguments', message: error.message }],
    }, true);
    if (name === 'generate_from_image' || name === 'sync_prototype') return toolResult({ status: 'failed', stage: 'validation', message: error.message,
      diagnostics: [{ code: name === 'generate_from_image' ? 'E_IMAGE_ARGUMENT' : 'E_SYNC_ARGUMENT', pointer: '/arguments', message: error.message }],
    }, true);
    const nextAction = legacyHint
      || (command ? `改用 rp_command({ action: "describe", command: "${command.command}" }) 查看参数契约后通过 rp_command 执行。` : '检查参数或读取最新原型状态；保留原文件后重试。');
    const diagnostic = localizeDiagnostic({ code: error.code ?? 'E_TOOL_INPUT', message: error.message });
    return toolResult({ status: 'error', ...diagnostic,
      diagnostics: [{ ...diagnostic, pointer: '/arguments', nextAction }],
      ...(!sessionToolIndex.has(name) ? { availableTools: [...listMcpTools(), ...jobTools].map(t => t.name) } : {}),
      ...(error.availableCommands ? { availableCommands: error.availableCommands } : {}),
      ...(error.candidates ? { candidates: error.candidates } : {}),
    }, true);
  }
}

// 会话编辑保持同步事务；异步生成在独立子进程运行，预览不推进原生编辑链。
// 会话对象不导出给 MCP 客户端；不同进程不会共享链、索引或 timeline。
let session = null;

const now = () => new Date().toISOString();
const zerosOf = rp => ({ unparseable: rp.records.unparseable, danglingRefs: rp.counts.danglingRefs, problems: rp.counts.problems });
const sha256Of = file => { assertNotProtected(file); return createHash('sha256').update(readFileSync(file)).digest('hex'); };
const pathExists = file => { assertNotProtected(file); try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const writablePath = file => { assertWritable(file); const result = join(realpathSync.native(dirname(file)), basename(file)); assertWritable(result); return result; };
function refreshState(state) {
  const tail = state.chain.at(-1);
  assertNotProtected(tail);
  state.rp = readRp(readFileSync(tail), { path: tail });
  state.index = null;
  state.graphs = null;
  return state;
}

// 链式中间文件与源文件同目录：源主名.work-N.rp，N 从 1 递增到不存在的序号；
// 已存在的正常节点和 rejected 节点均占用序号，历史证据不会因后续修改被覆盖。
const reservations = new Map();
const foldName = name => ['darwin', 'win32'].includes(process.platform) ? name.toLowerCase() : name;
function nextWorkNode(state) {
  const dir = dirname(state.sourceFile);
  const base = basename(state.sourceFile).replace(/\.rp$/i, '');
  const names = readdirSync(dir).map(foldName);
  for (let n = 1; ; n++) {
    const candidate = join(dir, `${base}.work-${n}.rp`), name = foldName(basename(candidate));
    assertWritable(candidate);
    if (pathExists(candidate) || names.some(existing => existing === name || existing.startsWith(`${name}.rejected`))) continue;
    const lock = `${candidate}.lock`, token = randomUUID();
    assertWritable(lock);
    // wx 在不同服务进程间原子占号；不能把另一个进程的成功节点误认成失败产物。
    try { writeFileSync(lock, token, { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    reservations.set(candidate, { lock, token });
    try {
      // 对方可能在本次存在性检查与占锁之间完成；拿到锁后以最新目录内容再核对。
      const occupied = pathExists(candidate) || readdirSync(dir).some(existing => foldName(existing).startsWith(`${name}.rejected`));
      if (occupied) { releaseWorkNode(candidate); continue; }
      return candidate;
    } catch (error) { releaseWorkNode(candidate); throw error; }
  }
}

function releaseWorkNode(node) {
  const reserved = reservations.get(node);
  if (!reserved) return;
  reservations.delete(node);
  assertWritable(reserved.lock);
  if (pathExists(reserved.lock) && readFileSync(reserved.lock, 'utf8') === reserved.token) unlinkSync(reserved.lock);
}

// 失败节点保留并占用序号；不能再作为活动链尾或被下一次修改覆盖。
function rejectNode(node) {
  assertWritable(node);
  let keep = `${node}.rejected`;
  for (let n = 2; pathExists(keep); n++) keep = `${node}.rejected-${n}`;
  keep = writablePath(keep);
  renameSync(node, keep);
  return keep;
}

function requireSession() {
  if (!session) throw new Error('没有活动会话：先调用 axure_open <path.rp>，或改用显式路径模式。提示：若你在编辑 Studio 画布工程，请直接用 studio_command / studio_inspect（无需 axure_open）。');
  // 缓存命中也必须检查当前磁盘路径，防止链文件被换成受保护目标的链接。
  for (const node of session.chain) assertNotProtected(node);
  return session;
}

function sessionSummary(state) {
  return { sourceFile: state.sourceFile, chain: [...state.chain], chainTail: state.chain.at(-1), timeline: structuredClone(state.timeline) };
}

const eventNames = new Map(Object.entries(EVENTS).map(([name, value]) => [value, name]));
const scalar = (node, graph, depth = 0) => {
  if (!node) return null;
  if (node.tag === 8) return node.text;
  if (node.tag === 3) return { ref: node.value, className: graph.objects.get(node.value)?.className ?? null };
  if (depth > 4) return { tag: node.tag };
  if (node.entries) return Object.fromEntries(node.entries.map(([k, v]) => [k.text ?? k.value, scalar(v, graph, depth + 1)]));
  if (node.items) return node.items.map(n => scalar(n, graph, depth + 1));
  return node.values ?? node.value ?? null;
};

function graphsOf(state) {
  if (state.graphs) return state.graphs;
  const file = state.chain.at(-1);
  assertNotProtected(file);
  state.graphs = new Map(readRecords(readFileSync(file)).filter(r => r.strings).map(r => [r.index, parsePayload(r)]));
  return state.graphs;
}

// 补读原有摘要未展开的 PanelState / 行模板 / Master 交互；未知动作保留真实类名及参数。
function nestedInteractions(graph, widget) {
  const map = graph.objects.get(field(widget.body, 'InteractionMap')?.value);
  const table = field(map?.body ?? {}, 'node-table');
  const tree = graph.objects.get(field(map?.body ?? {}, 'tree')?.value);
  const children = object => (field(object?.body ?? {}, 'children')?.items ?? []).map(n => graph.objects.get(n.value)).filter(Boolean);
  const target = node => graph.objects.get(table?.entries?.find(([k]) => k.value === node.id)?.[1].value);
  return children(tree).flatMap(en => {
    const event = target(en);
    if (event?.className !== 'Axure:InteractionEvent') return [];
    const eventType = field(event.body, 'event-type')?.value;
    return [{ event: eventNames.get(eventType) ?? `Event(${eventType})`, eventType, disabled: field(event.body, 'Disabled')?.value === true,
      cases: children(en).map(cn => {
        const kase = target(cn);
        return { description: field(kase?.body ?? {}, 'Description')?.text ?? '', disabled: field(kase?.body ?? {}, 'Disabled')?.value === true,
          actions: children(cn).map(an => target(an)).filter(Boolean).map(action => {
            const type = action.className.replace(/^Axure:/, '');
            return { id: action.id, type, human: type, disabled: field(action.body, 'Disabled')?.value === true, parameters: scalar(action.body, graph) };
          }) };
      }) }];
  });
}

function widgetIndex(state) {
  if (state.index) return state.index;
  const rp = state.rp;
  const packages = new Map(rp.packages.filter(p => p.record !== null).map(p => [p.record, p]));
  const pagesByKey = new Map(rp.pages.map(p => [packages.get(p.record)?.key, p.name]));
  const graphs = graphsOf(state);
  const items = new Map();
  const add = item => {
    const pack = packages.get(item.record);
    const graph = graphs.get(item.record);
    const widget = graph?.objects.get(item.id);
    items.set(`${item.record}:${item.id}`, { ...item, guid: item.guid ?? graph?.roots.find(n => n.tag === 0x1e)?.values[item.id - 1] ?? null, recordGuid: pack?.guid ?? null,
      interactions: item.interactions ?? (widget ? nestedInteractions(graph, widget) : []),
    });
  };
  for (const p of rp.pages) for (const w of p.widgets) add({ ...w, page: p.name, record: p.record, fullText: w.text ?? '', container: [] });
  for (const w of rp.containedWidgets) add({ ...w, page: pagesByKey.get(packages.get(w.record)?.path.split('/')[0]) ?? null, fullText: w.text ?? '' });
  // 母版定义单独标注；不会把定义当成某个页面的实例，避免改错共享内容。
  for (const pack of rp.packages.filter(p => p.className === 'Axure:Master')) {
    const graph = graphs.get(pack.record);
    if (!graph) continue;
    const master = [...graph.objects.values()].find(o => o.className === 'Axure:Master');
    const diagram = graph.objects.get(field(master?.body ?? {}, 'diagram')?.value);
    const masterName = field(master?.body ?? {}, 'Name')?.text ?? field(diagram?.body ?? {}, 'Name')?.text ?? `记录${pack.record}`;
    for (const w of graph.objects.values()) if (w.className.startsWith('Axure:DiagramObject:')) {
      const style = graph.objects.get(field(w.body, 'MyStyle')?.value);
      const geo = { x: null, y: null, w: null, h: null };
      for (const prop of field(style?.body ?? {}, 'PropList')?.items ?? []) {
        const id = field(prop, 'DOAName')?.value, value = field(prop, 'Value');
        if (id === 3221225573) { geo.x = field(value, 'X')?.value; geo.y = field(value, 'Y')?.value; }
        if (id === 3221225577) { geo.w = field(value, 'Width')?.value; geo.h = field(value, 'Height')?.value; }
      }
      const texts = [];
      walkNodes([field(w.body, 'RichTextBlock') ?? field(w.body, 'TextBlock')].filter(Boolean), n => {
        for (const [k, v] of n.entries ?? []) if (['Text', 'text'].includes(k.text) && v.tag === 8) texts.push(v.text);
      });
      add({ page: null, master: masterName, record: pack.record, id: w.id, name: field(field(w.body, 'name-block') ?? {}, 'text')?.text ?? '',
        type: w.className.replace(/^Axure:DiagramObject:/, ''), className: w.className, fullText: texts.join(''), container: [`母版:${masterName}`], ...geo });
    }
  }
  state.index = [...items.values()];
  return state.index;
}

const brief = (text, limit = 80) => (typeof text === 'string' && text.length > limit ? `${text.slice(0, limit)}…` : text || null);

function candidateView(item) {
  const { fullText, interactions, ...rest } = item;
  return { ...rest, text: brief(fullText), interactions: interactions === null ? null : interactions.length };
}

const candidateList = items => items.map(m =>
  `${m.page ?? '(无页)'} 记录#${m.record}/对象${m.id} ${m.type}「${m.name || '(未命名)'}」${m.container.length ? ` @${m.container.join('/')}` : ''}`).join('；');

function matchByLogicalId(state, pool, logicalId, pageFilter) {
  const cleanId = String(logicalId ?? '').replace(/^@/, '').replace(/\./g, '/').trim();
  if (!cleanId) return [];
  if (state.sourceFile && pathExists(`${state.sourceFile}.baseline.json`)) {
    try {
      const baseMeta = JSON.parse(readFileSync(`${state.sourceFile}.baseline.json`, 'utf8'));
      const mapEntries = (baseMeta.sourceMap ?? []).filter(sym => {
        const lid = String(sym.logicalId ?? sym.id ?? '');
        const shortId = lid.split('/').pop();
        return lid === cleanId || shortId === cleanId || lid.endsWith(`/${cleanId}`);
      });
      if (mapEntries.length > 0) {
        const nativeLocs = [];
        const symNames = new Set();
        for (const sym of mapEntries) {
          for (const loc of sym.native ?? []) {
            if (Number.isInteger(loc?.record) && Number.isInteger(loc?.id)) nativeLocs.push(loc);
          }
          for (const cand of [sym.display, sym.label, sym.name]) {
            if (typeof cand === 'string' && cand) symNames.add(cand);
          }
        }
        if (nativeLocs.length > 0) {
          const byNative = pool.filter(w => nativeLocs.some(loc =>
            loc.guid ? w.guid === loc.guid : w.record === loc.record && w.id === loc.id
          ));
          if (byNative.length > 0 || nativeLocs.some(loc => loc.guid)) return byNative;
        }
        const byLineShape = pool.filter(w => w.type !== 'Layer' && [...symNames].some(nm => w.name === `${nm}-l1`));
        if (byLineShape.length > 0) return byLineShape;
        const byNonLayer = pool.filter(w => w.type !== 'Layer' && symNames.has(w.name));
        if (byNonLayer.length > 0) return byNonLayer;
        const byAnySymName = pool.filter(w => symNames.has(w.name) || [...symNames].some(nm => w.name === `${nm}-l1`));
        if (byAnySymName.length > 0) return byAnySymName;
      }
    } catch {}
  }
  const lineHits = pool.filter(w => w.name === `${cleanId}-l1`);
  if (lineHits.length > 0) return lineHits;
  const escaped = cleanId.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const primaryRe = new RegExp(`^(?:txt|btn|badge|inp|img|panel|rep|line)-${escaped}-[0-9a-f]{12}(?:-l1)?$`, 'i');
  const primaryHits = pool.filter(w => primaryRe.test(w.name));
  if (primaryHits.length > 0) return primaryHits;
  const anyCompilerRe = new RegExp(`^(?:grp(?:-box)?|bg(?:-box)?|txt|btn|badge|inp|img|panel|rep|line)-${escaped}-[0-9a-f]{12}(?:-l1)?$`, 'i');
  return pool.filter(w => anyCompilerRe.test(w.name));
}

function resolvePageFilter(state, requestedPage) {
  if (requestedPage === undefined || state.rp.pages.some(page => page.name === requestedPage)) return requestedPage;
  const baselinePath = findBaselineForRp(state.chain.at(-1), undefined, state);
  if (!baselinePath) return requestedPage;
  try {
    assertNotProtected(baselinePath);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const names = [...new Set((baseline.sourceMap ?? []).filter(symbol => symbol.pageId === requestedPage)
      .map(symbol => symbol.pageName).filter(Boolean))];
    return names.length === 1 ? names[0] : requestedPage;
  } catch {
    return requestedPage;
  }
}

function locateCandidates(state, filter) {
  filter = { ...filter, page: resolvePageFilter(state, filter.page) };
  const basePool = widgetIndex(state).filter(item => {
    if (filter.page !== undefined && item.page !== filter.page) return false;
    if (filter.type !== undefined && item.type.toLowerCase() !== filter.type.toLowerCase()) return false;
    return true;
  });
  if (filter.query === undefined) return basePool;
  const direct = basePool.filter(item => item.name.includes(filter.query) || item.fullText.includes(filter.query));
  const logical = matchByLogicalId(state, basePool, filter.query, filter.page);
  if (logical.length === 0) return direct;
  const seen = new Set(direct.map(w => `${w.record}:${w.id}:${w.container.join('/')}`));
  const merged = [...direct];
  for (const w of logical) {
    const key = `${w.record}:${w.id}:${w.container.join('/')}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(w);
    }
  }
  return merged;
}

// target 解析：record+id（可选 container 校验）为显式精确定位；否则按 query/page/type/name 搜索，须唯一。
// 红线不受影响：target 只含定位字段不含路径；写入只发生在源目录链节点上（open 时已过红线+白名单）。
function resolveTarget(state, target) {
  if (typeof target === 'string' && target.trimStart().startsWith('{')) {
    target = JSON.parse(target);
    validateInput(targetSchema, target, 'target');
  }
  const filter = typeof target === 'string' ? { query: target } : { ...target };
  filter.page = resolvePageFilter(state, filter.page);
  if (filter.guid !== undefined) {
    const hits = widgetIndex(state).filter(w => w.guid === filter.guid.toLowerCase() && (filter.page === undefined || w.page === filter.page));
    if (hits.length !== 1) throw new Error(`guid ${filter.guid} 匹配 ${hits.length} 个元件，请用 rp_inspect 定位。`);
    return hits[0];
  }
  if (filter.logicalId !== undefined) {
    const hits = matchByLogicalId(state, widgetIndex(state).filter(w => filter.page === undefined || w.page === filter.page), filter.logicalId, filter.page);
    if (hits.length !== 1) throw new Error(`logicalId ${filter.logicalId} 匹配 ${hits.length} 个元件，请指定完整 page/id 或使用 guid。`);
    return hits[0];
  }
  if (filter.record !== undefined || filter.id !== undefined) {
    if (!Number.isInteger(filter.record) || !Number.isInteger(filter.id))
      throw new Error('target 显式定位需要 record 与 id 同时为整数（用 locate 返回的定位字段）');
    const hit = widgetIndex(state).find(w => w.record === filter.record && w.id === filter.id
      && (filter.container === undefined || w.container.join('/') === filter.container.join('/')));
    if (!hit) throw new Error(`record #${filter.record} + 对象 ${filter.id} 在当前链尾不存在（文件已变化？重新 locate）`);
    return hit;
  }
  if (filter.query === undefined && filter.page === undefined && filter.type === undefined && filter.name === undefined)
    throw new Error('target 缺少定位字段：给 record+id，或 query/page/type/name 之一');
  if (filter.name !== undefined) {
    const basePool = widgetIndex(state).filter(w => (filter.page === undefined || w.page === filter.page) && (filter.type === undefined || w.type.toLowerCase() === filter.type.toLowerCase()));
    let matches = basePool.filter(w => w.name === filter.name);
    if (matches.length === 0) matches = matchByLogicalId(state, basePool, filter.name, filter.page);
    if (matches.length === 1) return matches[0];
    const error = new Error(`精确名称「${filter.name}」匹配 ${matches.length} 个元件；请用 locate 的 record+id。`);
    error.candidates = matches.map(candidateView);
    throw error;
  }
  let matches = locateCandidates(state, filter);
  if (matches.length > 1 && filter.query !== undefined) {
    const logicalHits = matchByLogicalId(state, matches, filter.query, filter.page);
    if (logicalHits.length === 1) matches = logicalHits;
  }
  if (matches.length === 0) throw new Error(`没有匹配元件（过滤条件 ${JSON.stringify(filter)}）；用 locate 查看候选`);
  if (matches.length > 1) {
    const error = new Error(`匹配到 ${matches.length} 个元件，目标不唯一：${candidateList(matches)}；请加 page/type 过滤或改用 record+id`);
    error.candidates = matches.map(candidateView);
    throw error;
  }
  return matches[0];
}

export function openSession(path) {
  assertNotProtected(path);
  if (!existsSync(path)) throw new Error(`源文件不存在：${path}`);
  const sourceFile = realpathSync.native(path);
  assertNotProtected(sourceFile);
  if (extname(sourceFile).toLowerCase() !== '.rp') throw new Error(`axure_open 只接受 .rp 源文件：${sourceFile}`);
  const bytes = readFileSync(sourceFile);
  const rp = readRp(bytes, { path: sourceFile }); // 不可解析直接抛错，不建链
  if (Object.values(zerosOf(rp)).some(Boolean)) throw new Error(`源文件结构检查失败，不建会话：${JSON.stringify(zerosOf(rp))}`);
  let node;
  try { node = nextWorkNode({ sourceFile }); assertWritable(node); } catch (error) {
    const hint = error.message.includes('AXURE_STRICT_WRITE_ROOT')
      ? '。指引：把源文件复制到 AXURE_WRITE_ROOT 白名单根内再 open，或关闭 AXURE_STRICT_WRITE_ROOT' : '';
    throw new Error(`${error.message}${hint}`);
  }
  try { writeFileSync(node, bytes, { flag: 'wx' }); } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code))
      throw new Error(`源目录不可写（${dirname(sourceFile)}），工作副本无法落盘。指引：把源文件复制到有写权限的本地工作目录后再 open。原始错误：${error.message}`);
    throw error;
  } finally { releaseWorkNode(node); }
  const sourceFileShaAtOpen = createHash('sha256').update(bytes).digest('hex');
  session = { sourceFile, sourceFileShaAtOpen, chain: [node], timeline: [{ op: 'open', at: now(), source: sourceFile, node }], rp };
  return session;
}

// 链提交关卡：新节点必须过 rp-read 三零，否则坏节点改名 .rejected 保留、链不前进，错误里说明差异。
export function commitChainNode(state, node, entry) {
  assertNotProtected(state.chain.at(-1));
  assertWritable(node);
  let rp;
  try { rp = readRp(readFileSync(node), { path: node }); }
  catch (error) {
    const kept = rejectNode(node);
    throw new Error(`新链节点 ${node} rp-read 解析失败（${error.message}）；坏节点保留为 ${kept}，链回退到 ${state.chain.at(-1)}`);
  }
  const zeros = zerosOf(rp);
  if (zeros.unparseable || zeros.danglingRefs || zeros.problems) {
    const kept = rejectNode(node);
    throw new Error(`新链节点 ${node} 未过结构三零：本次 ${JSON.stringify(zeros)}，链尾原值 ${JSON.stringify(zerosOf(state.rp))}；坏节点保留为 ${kept}，链回退到 ${state.chain.at(-1)}`);
  }
  state.chain.push(node);
  state.rp = rp;
  state.index = null;
  state.graphs = null;
  state.timeline.push(entry);
  return state;
}

// 富文本 runs 明细：复用 parse-payload 解析链尾记录（rp-read 只输出拼接文本，不暴露 runs 结构）。
const RUN_STYLE_FIELDS = {
  fontFamily: ['Family', 'text'], size: ['Size', 'value'], weight: ['Weight', 'value'], italic: ['Style', 'value'],
  underline: ['Underline', 'value'], strikethrough: ['Strikethrough', 'value'], color: ['Color', 'value'],
};

function richRunsDetail(state, cand) {
  try {
    assertNotProtected(state.chain.at(-1));
    const record = readRecords(readFileSync(state.chain.at(-1))).find(r => r.index === cand.record);
    if (!record?.strings) return { paragraphs: null, note: `记录 #${cand.record} 不可解析` };
    const graph = parsePayload(record);
    const widget = graph.objects.get(cand.id);
    if (!widget) return { paragraphs: null, note: `对象 ${cand.id} 不在记录 #${cand.record} 中` };
    let block = field(widget.body, 'RichTextBlock') ?? field(widget.body, 'TextBlock');
    if (block?.tag === 3) block = graph.objects.get(block.value)?.body;
    if (!block) return { paragraphs: [], note: '该元件没有文本块' };
    const paragraphs = field(field(block, 'attributed-string') ?? {}, 'Paragraphs')?.items;
    if (!paragraphs) {
      const texts = [];
      walkNodes([block], n => { if (n.tag === 1 && n.entries) for (const [k, v] of n.entries) if (k.text === 'Text' && v.tag === 8) texts.push(v.text); });
      return { paragraphs: [{ runs: texts.map(t => ({ text: t })) }], note: '纯文本块，无段落/run 结构' };
    }
    const aligns = ['left', 'center', 'right']; // HorizontalAlignment 0/1/2，与 set-widget-richtext 同一映射
    const linkTarget = widgetId => {
      const widget = graph.objects.get(widgetId);
      const map = graph.objects.get(field(widget?.body ?? {}, 'InteractionMap')?.value);
      const table = field(map?.body ?? {}, 'node-table');
      const tree = graph.objects.get(field(map?.body ?? {}, 'tree')?.value);
      const children = object => (field(object?.body ?? {}, 'children')?.items ?? []).map(node => graph.objects.get(node.value)).filter(Boolean);
      const targetOf = node => graph.objects.get(table?.entries?.find(([key]) => key.value === node.id)?.[1]?.value);
      for (const eventNode of children(tree)) for (const caseNode of children(eventNode)) for (const actionNode of children(caseNode)) {
        const action = targetOf(actionNode);
        if (action?.className !== 'Axure:InteractionLinkWindowAction') continue;
        const target = graph.objects.get(field(action.body, 'target')?.value);
        const targetType = field(target?.body ?? {}, 'target-type')?.value;
        const literalRef = field(target?.body ?? {}, 'target-literal');
        const literalObject = literalRef?.tag === 3 ? graph.objects.get(literalRef.value) : null;
        const literalValue = field(literalObject?.body ?? {}, 'value')?.text;
        const window = field(action.body, 'link-type')?.value === 2 ? 'new' : 'current';
        if (targetType === 1) {
          const page = state.rp.pages.find(item => `${item.name}.html` === literalValue)?.name
            ?? literalValue?.replace(/\.html$/i, '') ?? '';
          return { page, window };
        }
        if (targetType === 0) return { url: literalValue ?? '', window };
        if (targetType === 2) return { action: 'refresh', window };
        if (targetType === 3) return { action: 'back', window };
      }
      return null;
    };
    const readRun = r => {
      const run = { text: field(r, 'Text')?.text ?? '' };
      for (const [key, [name, kind]] of Object.entries(RUN_STYLE_FIELDS)) {
        const node = field(r, name);
        if (node === undefined) continue;
        run[key] = kind === 'text' ? node.text : node.value;
      }
      if (typeof run.color === 'number') run.color = `#${(run.color >>> 0).toString(16).padStart(8, '0').slice(2)}`;
      return run;
    };
    const readInline = inline => {
      const type = field(inline, 'Type')?.text;
      if (type === 'Axure:AttributedString:AxRun') return [readRun(inline)];
      if (type === 'Axure:AttributedString:AxHyperlink') {
        const target = linkTarget(field(inline, 'Link')?.value);
        return (field(inline, 'Inlines')?.items ?? []).flatMap(readInline).map(run => ({ ...run, link: target }));
      }
      throw new Error(`不支持的富文本 inline ${type ?? '(missing type)'}`);
    };
    return { paragraphs: paragraphs.map(p => ({
      align: aligns[field(p, 'HorizontalAlignment')?.value] ?? null,
      lineSpacing: field(p, 'LineSpacing')?.value ?? null,
      runs: (field(p, 'Inlines')?.items ?? []).flatMap(readInline),
    })) };
  } catch (error) { return { paragraphs: null, note: `富文本明细解析失败：${error.message}` }; }
}

function interactionLines(label, interactions) {
  const lines = [];
  for (const ix of interactions ?? []) {
    const head = `${label} ${ix.event}${ix.disabled ? '（已禁用）' : ''}`;
    if (!ix.cases.length) { lines.push(`${head} →（无用例）`); continue; }
    ix.cases.forEach((c, i) => {
      lines.push(`${head} → Case ${i + 1}${c.description ? `「${c.description}」` : ''}${c.disabled ? '（已禁用）' : ''}`);
      for (const a of c.actions) lines.push(`    · ${a.human}${a.disabled ? '（已禁用）' : ''} [${a.type}]`);
    });
  }
  return lines;
}

function overviewOf(state) {
  const rp = state.rp;
  const syncStatus = computeSyncStatus(state);
  return {
    opened: state.sourceFile,
    session: sessionSummary(state),
    pages: rp.pages.map(p => ({ name: p.name, record: p.record, widgets: p.counts.widgets, dynamicPanels: p.counts.dynamicPanels, interactions: p.counts.interactions, namedWidgets: p.counts.namedWidgets })),
    globalVariables: rp.globalVariables,
    masters: rp.sitemap.masters,
    containedWidgets: rp.containedWidgets.length,
    structure: zerosOf(rp),
    ...(syncStatus ? { syncStatus } : {}),
  };
}

const targetOf = cand => `${cand.page ?? '(无页)'} 记录#${cand.record}/对象${cand.id}「${cand.name || '(未命名)'}」${cand.container.length ? `@${cand.container.join('/')}` : '（顶层）'}`;

function parseHexArgb(hexStr) {
  if (typeof hexStr !== 'string') throw new Error(`颜色值必须是十六进制字符串：${hexStr}`);
  const clean = hexStr.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return (0xFF000000 | parseInt(clean, 16)) >>> 0;
  }
  if (/^[0-9a-fA-F]{8}$/.test(clean)) {
    const rr = parseInt(clean.slice(0, 2), 16);
    const gg = parseInt(clean.slice(2, 4), 16);
    const bb = parseInt(clean.slice(4, 6), 16);
    const aa = parseInt(clean.slice(6, 8), 16);
    return (((aa & 0xFF) << 24) | ((rr & 0xFF) << 16) | ((gg & 0xFF) << 8) | (bb & 0xFF)) >>> 0;
  }
  throw new Error(`不支持的颜色格式（需 #RRGGBB 或 #RRGGBBAA）：${hexStr}`);
}

function formatHexArgb(val) {
  if (typeof val !== 'number' || val === 0) return null;
  const u = val >>> 0;
  const aa = (u >>> 24) & 0xFF;
  const rgb = (u & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
  if (aa === 0xFF || aa === 0) return `#${rgb}`;
  return `#${rgb}${aa.toString(16).toUpperCase().padStart(2, '0')}`;
}

const PATCH_SINGLE_KEYS = [
  'op', 'target', 'widget', 'page', 'text', 'richRuns', 'runIndex', 'name', 'newName',
  'x', 'y', 'w', 'width', 'h', 'height', 'fill', 'stroke', 'color', 'radius',
  'oldName', 'styleGuid', 'selector', 'resetOverrides',
];

function setBufferWidgetText(input, recordIndex, widgetId, text, { runIndex } = {}) {
  const record = readRecords(input).find(item => item.index === Number(recordIndex));
  if (!record || !['Axure:Page', 'Axure:PanelState'].includes(record.className)) {
    throw new Error(`Editable Page or PanelState record #${recordIndex} not found`);
  }
  const graph = parsePayload(record);
  const widget = graph.objects.get(Number(widgetId));
  if (!widget?.className.startsWith('Axure:DiagramObject:')) {
    throw new Error(`Unsupported widget target: ${widget?.className ?? widgetId}`);
  }
  let textBlock = field(widget.body, 'RichTextBlock') ?? field(widget.body, 'TextBlock');
  if (textBlock?.tag === 3) textBlock = graph.objects.get(textBlock.value)?.body;
  if (!textBlock) throw new Error(`Widget #${widgetId} has no text block`);
  const textNodes = [];
  walkNodes([textBlock], node => {
    if (node.tag !== 1 || !node.entries) return;
    for (const [key, value] of node.entries) {
      if (key.text === 'Text' && value.tag === 8) textNodes.push(value);
    }
  });
  let target;
  if (runIndex !== undefined) {
    if (!Number.isInteger(runIndex) || runIndex < 0 || runIndex >= textNodes.length) {
      throw new Error(`Widget #${widgetId} has ${textNodes.length} rich text runs; --run must be between 0 and ${textNodes.length - 1}`);
    }
    target = textNodes[runIndex];
  } else if (textNodes.length === 1) {
    target = textNodes[0];
  } else if (textNodes.length === 0 && field(textBlock, 'text')?.tag === 8) {
    target = field(textBlock, 'text');
  } else {
    throw new Error(`Widget #${widgetId} must have one simple text value; found ${textNodes.length} rich text runs (select one with runIndex)`);
  }
  const value = String(text);
  let index = record.strings.indexOf(value);
  if (index < 0) {
    index = record.strings.length;
    record.strings.push(value);
  }
  target.value = index + 1;
  target.text = value;
  const file = replaceRecord(input, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
  return { file, record: record.index, widgetId: Number(widgetId), ...(runIndex === undefined ? {} : { runIndex }), text: value };
}

function applyPatchItemsToBuffer(initialBuf, items, { sourcePath, sessionState = null }) {
  let buf = initialBuf;
  const ext = extname(sourcePath).toLowerCase();
  const applied = [];

  for (const rawEdit of items) {
    const inferredOp = rawEdit.op ?? (
      rawEdit.styleGuid !== undefined ? 'rebind-style'
        : (rawEdit.oldName !== undefined && rawEdit.newName !== undefined && rawEdit.target === undefined && rawEdit.widget === undefined ? 'rename-style' : 'widget')
    );

    if (inferredOp === 'rename-style') {
      if (typeof rawEdit.oldName !== 'string' || typeof rawEdit.newName !== 'string') {
        throw new Error('rename-style 需要非空字符串 oldName 与 newName。');
      }
      const res = renameCustomStyle(buf, rawEdit.oldName, rawEdit.newName);
      buf = res.file;
      applied.push({
        op: 'rename-style',
        style: res.style,
        before: res.style.before,
        after: res.style.name,
        references: res.references,
        changedRecords: res.changedRecords,
      });
      continue;
    }

    if (inferredOp === 'rebind-style') {
      if (typeof rawEdit.styleGuid !== 'string' || !rawEdit.selector) {
        throw new Error('rebind-style 需要提供 styleGuid 与 selector（对象、JSON 字符串或选择器文件路径）。');
      }
      let selectorObj = rawEdit.selector;
      if (typeof selectorObj === 'string') {
        const trimmed = selectorObj.trim();
        if (trimmed.startsWith('{')) {
          selectorObj = JSON.parse(trimmed);
        } else {
          const selPath = resolveInWork(trimmed);
          assertNotProtected(selPath);
          selectorObj = JSON.parse(readFileSync(selPath, 'utf8'));
        }
      }
      const predicate = widgetSelector(selectorObj);
      const res = rebindWidgets(buf, rawEdit.styleGuid, predicate, { resetOverrides: Boolean(rawEdit.resetOverrides) });
      buf = res.file;
      applied.push({
        op: 'rebind-style',
        style: res.style,
        resetOverrides: res.resetOverrides,
        applied: res.applied,
        count: res.applied.length,
      });
      continue;
    }

    if (ext !== '.rp') {
      throw new Error(`元件级修改仅支持 .rp 文件（当前为 ${sourcePath}）；.rplib 仅支持 rename-style 与 rebind-style。`);
    }

    const curState = {
      sourceFile: sessionState?.sourceFile ?? sourcePath,
      chain: sessionState?.chain ?? [sourcePath],
      timeline: sessionState?.timeline ?? [],
      rp: readRp(buf, { path: sourcePath }),
    };
    const effTarget = rawEdit.target ?? (rawEdit.widget !== undefined ? { name: rawEdit.widget, ...(rawEdit.page !== undefined ? { page: rawEdit.page } : {}) } : undefined);
    if (effTarget === undefined) {
      throw new Error('rp_patch 元件修改需要提供 target 或 widget（可选加 page 过滤）。');
    }
    const hasText = rawEdit.text !== undefined;
    const hasRich = rawEdit.richRuns !== undefined;
    if (hasText && hasRich) throw new Error('每次编辑不能同时提供 text 与 richRuns。');
    const effName = rawEdit.name ?? rawEdit.newName;
    const hasRename = effName !== undefined;
    const x = rawEdit.x;
    const y = rawEdit.y;
    const w = rawEdit.w ?? rawEdit.width;
    const h = rawEdit.h ?? rawEdit.height;
    const hasGeom = x !== undefined || y !== undefined || w !== undefined || h !== undefined;
    const { fill, stroke, color, radius } = rawEdit;
    const hasStyle = fill !== undefined || stroke !== undefined || color !== undefined || radius !== undefined;

    if (!hasText && !hasRich && !hasRename && !hasGeom && !hasStyle) {
      throw new Error('rp_patch 每条修改至少需要提供 text / richRuns / name(newName) / 几何(x,y,w,h) / 样式(fill,stroke,color,radius) 之一，或指定 rename-style / rebind-style。');
    }
    if (fill !== undefined) parseHexArgb(fill);
    if (stroke !== undefined) parseHexArgb(stroke);
    if (color !== undefined) parseHexArgb(color);
    if (radius !== undefined && (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0)) {
      throw new Error(`非法圆角 radius: ${radius}（期望非负数字）`);
    }

    const cand = resolveTarget(curState, effTarget);
    const aspects = [];
    const beforeMap = {};
    const afterMap = {};
    let richReport;

    if (hasRich) {
      const paragraphs = Array.isArray(rawEdit.richRuns) ? rawEdit.richRuns : rawEdit.richRuns.paragraphs;
      const spec = { record: cand.record, widgetId: cand.id, paragraphs };
      if (!Array.isArray(rawEdit.richRuns) && rawEdit.richRuns.defaults) spec.defaults = rawEdit.richRuns.defaults;
      const res = setWidgetRichText(buf, spec);
      buf = res.file;
      richReport = res.report;
      beforeMap.text = cand.fullText;
      afterMap.text = res.report?.text ?? '';
      aspects.push('richtext');
    } else if (hasText) {
      const res = setBufferWidgetText(buf, cand.record, cand.id, rawEdit.text, { runIndex: rawEdit.runIndex });
      buf = res.file;
      beforeMap.text = cand.fullText;
      afterMap.text = String(rawEdit.text);
      aspects.push('text');
    }

    if (hasRename) {
      if (typeof effName !== 'string') throw new Error('改名需要字符串 name（或 newName）。');
      const res = setWidgetNames(buf, [{ record: cand.record, id: cand.id, name: effName }]);
      buf = res.file;
      beforeMap.name = cand.name;
      afterMap.name = effName;
      aspects.push('rename');
    }

    if (hasGeom || hasStyle) {
      const rec = readRecords(buf).find(r => r.index === cand.record);
      if (!rec) throw new Error(`记录 #${cand.record} 不存在`);
      const graph = parsePayload(rec);
      const strings = [...rec.strings];
      const obj = graph.objects.get(cand.id);
      const st = graph.objects.get(field(obj?.body ?? {}, 'MyStyle')?.value);
      if (!st) throw new Error(`元件 ${cand.name || cand.id} 缺少 MyStyle`);
      const propItems = field(st.body, 'PropList')?.items ?? [];

      if (hasGeom) {
        const geomBefore = { x: cand.x, y: cand.y, w: cand.w, h: cand.h };
        const geomAfter = {
          x: x !== undefined ? Number(x) : geomBefore.x,
          y: y !== undefined ? Number(y) : geomBefore.y,
          w: w !== undefined ? Number(w) : geomBefore.w,
          h: h !== undefined ? Number(h) : geomBefore.h,
        };
        for (const it of propItems) {
          const doaNode = field(it, 'DOAName');
          const key = (doaNode?.value ?? 0) & 0x3fffffff;
          const val = field(it, 'Value');
          if (key === 101 && val && (x !== undefined || y !== undefined)) {
            doaNode.value = (0xc0000000 + 101) >>> 0;
            if (x !== undefined && field(val, 'X')) field(val, 'X').value = geomAfter.x;
            if (y !== undefined && field(val, 'Y')) field(val, 'Y').value = geomAfter.y;
          }
          if (key === 105 && val && (w !== undefined || h !== undefined)) {
            doaNode.value = (0xc0000000 + 105) >>> 0;
            if (w !== undefined && field(val, 'Width')) field(val, 'Width').value = geomAfter.w;
            if (h !== undefined && field(val, 'Height')) field(val, 'Height').value = geomAfter.h;
          }
        }
        beforeMap.geometry = geomBefore;
        afterMap.geometry = geomAfter;
        aspects.push('geometry');
      }

      if (hasStyle) {
        const styleBefore = {};
        const styleAfter = {};
        let hitColor = false, hitFill = false, hitStroke = false, hitRadius = false;
        for (const it of propItems) {
          const doaNode = field(it, 'DOAName');
          const key = (doaNode?.value ?? 0) & 0x3fffffff;
          const val = field(it, 'Value');
          if (key === 6 && val) {
            styleBefore.color = formatHexArgb(field(val, 'fill-color')?.value);
            if (color !== undefined) {
              doaNode.value = (0xc0000000 + 6) >>> 0;
              const argb = parseHexArgb(color);
              if (field(val, 'fill-color')) field(val, 'fill-color').value = argb;
              styleAfter.color = formatHexArgb(argb);
              hitColor = true;
            }
          }
          if (key === 7 && val) {
            styleBefore.fill = formatHexArgb(field(val, 'fill-color')?.value);
            if (fill !== undefined) {
              doaNode.value = (0xc0000000 + 7) >>> 0;
              const argb = parseHexArgb(fill);
              if (field(val, 'fill-color')) field(val, 'fill-color').value = argb;
              styleAfter.fill = formatHexArgb(argb);
              hitFill = true;
            }
          }
          if (key === 8 && val) {
            styleBefore.stroke = formatHexArgb(field(val, 'fill-color')?.value);
            if (stroke !== undefined) {
              doaNode.value = (0xc0000000 + 8) >>> 0;
              const argb = parseHexArgb(stroke);
              if (field(val, 'fill-color')) field(val, 'fill-color').value = argb;
              styleAfter.stroke = formatHexArgb(argb);
              hitStroke = true;
            }
          }
          if (key === 15 && val && stroke !== undefined) {
            const argb = parseHexArgb(stroke);
            if ((argb >>> 24) > 0 && (!val.value || val.value <= 0)) {
              doaNode.value = (0xc0000000 + 15) >>> 0;
              val.value = 1;
            }
          }
          if (key === 80 && val && stroke !== undefined) {
            const argb = parseHexArgb(stroke);
            if ((argb >>> 24) > 0) {
              doaNode.value = (0xc0000000 + 80) >>> 0;
              val.value = 15;
            }
          }
          if (key === 71 && val) {
            styleBefore.radius = val.value;
            if (radius !== undefined) {
              doaNode.value = (0xc0000000 + 71) >>> 0;
              val.value = Number(radius);
              styleAfter.radius = Number(radius);
              hitRadius = true;
            }
          }
        }
        if (color !== undefined) {
          const argb = parseHexArgb(color);
          const rtb = field(obj?.body ?? {}, 'RichTextBlock');
          const attrStr = field(rtb ?? {}, 'attributed-string');
          for (const para of field(attrStr ?? {}, 'Paragraphs')?.items ?? []) {
            for (const inl of field(para, 'Inlines')?.items ?? []) {
              const colField = field(inl, 'Color');
              if (colField) {
                colField.value = argb;
                hitColor = true;
              }
            }
          }
        }
        const unsupportedProps = [];
        if (fill !== undefined && !hitFill) unsupportedProps.push('fill');
        if (stroke !== undefined && !hitStroke) unsupportedProps.push('stroke');
        if (color !== undefined && !hitColor) unsupportedProps.push('color');
        if (radius !== undefined && !hitRadius) unsupportedProps.push('radius');
        if (unsupportedProps.length > 0) {
          throw new Error(`元件 ${cand.name || cand.id} (${cand.type || 'Widget'}) 不支持样式属性: ${unsupportedProps.join(', ')}`);
        }
        beforeMap.style = styleBefore;
        afterMap.style = { ...styleBefore, ...styleAfter };
        aspects.push('style');
      }

      buf = replaceRecord(buf, rec, encodeRecord(rec, strings, encodePayload(graph.roots)));
    }

    let beforeOut = beforeMap;
    let afterOut = afterMap;
    if (aspects.length === 1) {
      const only = aspects[0];
      const mapKey = only === 'richtext' ? 'text' : (only === 'rename' ? 'name' : only);
      beforeOut = beforeMap[mapKey];
      afterOut = afterMap[mapKey];
    }

    applied.push({
      op: aspects.length === 1 ? aspects[0] : 'widget',
      record: cand.record,
      id: cand.id,
      name: hasRename ? effName : cand.name,
      page: cand.page,
      target: targetOf(cand),
      before: beforeOut,
      after: afterOut,
      ...(richReport ? { report: richReport } : {}),
    });
  }

  return { buf, applied };
}

function stripWidgetNames(file, path) {
  const rp = readRp(file, { path, includeMasterWidgets: true });
  const edits = new Map();
  const add = (w, record) => {
    if (w.name) edits.set(`${record}:${w.id}`, { record, id: w.id, name: '' });
  };
  for (const page of rp.pages) for (const w of page.widgets) add(w, page.record);
  for (const w of rp.containedWidgets) add(w, w.record);
  const result = setWidgetNames(file, [...edits.values()]);
  return { buf: result.file, applied: result.applied };
}

function rpPatch(input = {}) {
  const batchList = input.edits ?? input.operations;
  if (input.edits !== undefined && input.operations !== undefined) {
    throw new Error('edits 与 operations 二选一，不能同时提供。');
  }
  if (batchList !== undefined) {
    const mixed = PATCH_SINGLE_KEYS.filter(k => input[k] !== undefined);
    if (mixed.length > 0) {
      throw new Error(`edits/operations 批量模式不能混用顶层单条参数（${mixed.join(', ')}）。`);
    }
  }
  const items = batchList ?? [input];
  const workDir = input.cwd ?? input.projectDir;
  const rawSource = input.source ?? input.path ?? input.rp ?? input.file ?? input.rpFile;
  const rawOutput = input.output;
  if ((rawSource !== undefined) !== (rawOutput !== undefined)) {
    throw new Error('显式文件模式必须同时提供 source（或 path/rp/file）与 output；若修改当前活动会话请同时省略二者。');
  }

  if (rawSource !== undefined) {
    const resolvedSource = resolveInWork(rawSource, workDir);
    assertNotProtected(resolvedSource);
    if (!existsSync(resolvedSource)) throw new Error(`源文件不存在：${resolvedSource}`);
    const sourceFile = realpathSync.native(resolvedSource);
    assertNotProtected(sourceFile);
    const ext = extname(sourceFile).toLowerCase();
    if (!['.rp', '.rplib'].includes(ext)) throw new Error(`rp_patch 仅支持 .rp 或 .rplib 源文件：${sourceFile}`);

    const resolvedOutput = resolveInWork(rawOutput, workDir);
    assertNotProtected(resolvedOutput);
    assertWritable(resolvedOutput);
    const outDir = dirname(resolvedOutput);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const target = writablePath(resolvedOutput);
    const unlock = acquireOutputLock(target);
    try {
      if (!input.overwrite && existsSync(target)) {
        throw new Error(`目标已存在，rp_patch 默认不覆盖（如需覆盖显式传 overwrite: true）：${target}`);
      }

      const initialBuf = readFileSync(sourceFile);
      const beforeCounts = ext === '.rp' ? countsOf(readRp(initialBuf, { path: sourceFile })) : undefined;
      const { buf, applied } = input.op === 'strip-widget-names'
        ? stripWidgetNames(initialBuf, sourceFile)
        : applyPatchItemsToBuffer(initialBuf, items, { sourcePath: sourceFile });

      if (ext === '.rp') {
        const outRp = readRp(buf, { path: target });
        const zeros = zerosOf(outRp);
        if (zeros.unparseable || zeros.danglingRefs || zeros.problems) {
          throw new Error(`输出未过结构三零：${JSON.stringify(zeros)}`);
        }
        const baselineSource = findBaselineForRp(sourceFile);
        if (baselineSource && !input.overwrite && pathExists(`${target}.baseline.json`)) throw new Error(`目标基线已存在：${target}.baseline.json`);
        writeFileSync(target, buf, input.overwrite ? {} : { flag: 'wx' });
        let baseline;
        try {
          if (baselineSource && !pathExists(`${target}.baseline.json`)) baseline = saveIdentityBaseline(sourceFile, target, outRp, baselineSource);
        } catch (error) {
          if (!input.overwrite) unlinkSync(target);
          throw error;
        }
        return {
          ...(baseline ? { baseline } : {}),
          status: 'completed',
          ...(applied.length === 1 ? applied[0] : {}),
          edits: applied,
          source: sourceFile,
          output: target,
          beforeCounts,
          afterCounts: countsOf(outRp),
          structure: zeros,
        };
      }

      listCustomStyles(buf);
      writeFileSync(target, buf, input.overwrite ? {} : { flag: 'wx' });
      return {
        status: 'completed',
        ...(applied.length === 1 ? applied[0] : {}),
        edits: applied,
        source: sourceFile,
        output: target,
      };
    } finally { unlock(); }
  }

  const state = refreshState(requireSession());
  if (Object.values(zerosOf(state.rp)).some(Boolean)) {
    throw new Error(`链尾结构不健康，请先调用 rp_inspect({ view: "verify" }) 检查：${JSON.stringify(zerosOf(state.rp))}`);
  }
  const tail = state.chain.at(-1);
  const beforeCounts = countsOf(state.rp);
  const { buf, applied } = input.op === 'strip-widget-names'
    ? stripWidgetNames(readFileSync(tail), tail)
    : applyPatchItemsToBuffer(readFileSync(tail), items, { sourcePath: tail, sessionState: state });
  const node = nextWorkNode(state);
  let created = false;
  try {
    assertNotProtected(tail);
    assertWritable(node);
    writeFileSync(node, buf, { flag: 'wx' });
    created = true;
    commitChainNode(state, node, { op: 'rp_patch', at: now(), edits: applied, node });
    const syncStatus = computeSyncStatus(state);
    return {
      status: 'completed',
      ...(applied.length === 1 ? applied[0] : {}),
      edits: applied,
      chainTail: node,
      previousTail: tail,
      beforeCounts,
      afterCounts: countsOf(state.rp),
      structure: zerosOf(state.rp),
      ...(syncStatus ? { syncStatus } : {}),
    };
  } catch (error) {
    if (created && pathExists(node)) error.message += `；失败节点保留 ${rejectNode(node)}`;
    throw error;
  } finally {
    releaseWorkNode(node);
  }
}

function generationDiagnostic(diagnostic, spec, plan) {
  const symbol = (plan?.sourceMap ?? []).find(s => s.id === diagnostic.sourceId
    || diagnostic.message?.includes(s.name));
  const pointer = diagnostic.pointer ?? symbol?.pointer ?? '/';
  const parts = pointer.split('/').slice(1).map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  const index = parts[0] === 'pages' && /^\d+$/.test(parts[1] ?? '') ? Number(parts[1]) : -1;
  const page = spec.pages?.[index] ?? spec.pages?.find(p => p.id === symbol?.pageId || (p.name ?? p.id) === diagnostic.pageName);
  let value = spec, widget;
  const kinds = ['box', 'column', 'row', 'stack', 'grid', 'card', 'label', 'paragraph', 'button', 'input', 'image', 'repeater', 'panel', 'badge', 'divider'];
  for (const key of parts) {
    value = value?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const alias = kinds.find(k => typeof value[k] === 'string');
      if ((value.type && value.id) || alias) widget = { id: value.id ?? value[alias], name: value.name };
    }
  }
  return { ...localizeDiagnostic(diagnostic), pointer,
    nextAction: diagnostic.nextAction ?? '按诊断位置和候选补丁修正源码，再重新生成。',
    ...(page ? { pageId: page.id, pageName: page.name ?? page.id } : {}),
    ...(widget ? { widgetId: widget.id, ...(widget.name ? { widgetName: widget.name } : {}) } : {}),
    ...(symbol ? { sourceId: symbol.id } : {}),
  };
}

function findBaselineForRp(rpFile, baseRpArg, sessionState) {
  if (rpFile && pathExists(`${rpFile}.baseline.json`)) return `${rpFile}.baseline.json`;
  const st = sessionState ?? (session && (session.chain.includes(rpFile) || session.sourceFile === rpFile) ? session : null);
  if (st?.sourceFile && pathExists(`${st.sourceFile}.baseline.json`)) return `${st.sourceFile}.baseline.json`;
  if (baseRpArg && pathExists(`${resolve(baseRpArg)}.baseline.json`)) return `${resolve(baseRpArg)}.baseline.json`;
  return null;
}

function computeSyncStatus(target, sourceArg, baseRpArg) {
  let sessionState = null;
  let rpFile = null;
  if (target && typeof target === 'object' && Array.isArray(target.chain)) {
    sessionState = target;
    const sourceDiskChanged = pathExists(sessionState.sourceFile) && sessionState.sourceFileShaAtOpen && sha256Of(sessionState.sourceFile) !== sessionState.sourceFileShaAtOpen;
    rpFile = (sessionState.chain.length === 1 && sourceDiskChanged) ? sessionState.sourceFile : sessionState.chain.at(-1);
  } else if (typeof target === 'string' && target) {
    const resolvedTarget = resolve(target);
    if (session && (session.sourceFile === resolvedTarget || session.chain.includes(resolvedTarget))) {
      sessionState = session;
      const sourceDiskChanged = pathExists(session.sourceFile) && session.sourceFileShaAtOpen && sha256Of(session.sourceFile) !== session.sourceFileShaAtOpen;
      if (resolvedTarget === session.sourceFile && session.chain.length > 1 && !sourceDiskChanged) {
        rpFile = session.chain.at(-1);
      } else {
        rpFile = resolvedTarget;
      }
    } else {
      rpFile = resolvedTarget;
    }
  } else if (session) {
    sessionState = session;
    const sourceDiskChanged = pathExists(session.sourceFile) && session.sourceFileShaAtOpen && sha256Of(session.sourceFile) !== session.sourceFileShaAtOpen;
    rpFile = (session.chain.length === 1 && sourceDiskChanged) ? session.sourceFile : session.chain.at(-1);
  }
  const baselinePath = findBaselineForRp(rpFile, baseRpArg, sessionState);
  let baseline = null;
  if (baselinePath && pathExists(baselinePath)) {
    try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch {}
  }
  const rpExists = rpFile && pathExists(rpFile);
  const currentRpSha = rpExists ? sha256Of(rpFile) : null;
  const sourceFileDiskDirty = Boolean(sessionState?.sourceFile && pathExists(sessionState.sourceFile) && sessionState.sourceFileShaAtOpen && sha256Of(sessionState.sourceFile) !== sessionState.sourceFileShaAtOpen);
  const chainEdited = Boolean(sessionState && sessionState.chain.length > 1);
  const nativeChanged = baseline?.rpSha256
    ? ((currentRpSha !== null && currentRpSha !== baseline.rpSha256) || chainEdited)
    : (sourceFileDiskDirty || chainEdited);
  const resolvedSourcePath = typeof sourceArg === 'string' && sourceArg ? resolve(sourceArg) : (baseline?.sourcePath && pathExists(baseline.sourcePath) ? baseline.sourcePath : null);
  const currentSourceSha = resolvedSourcePath && pathExists(resolvedSourcePath) ? sha256Of(resolvedSourcePath) : null;
  const sourceChanged = Boolean(baseline?.sourceSha256 && currentSourceSha && currentSourceSha !== baseline.sourceSha256);
  const stateLabel = !baseline
    ? (nativeChanged ? 'native_modified_no_baseline' : 'no_baseline')
    : (sourceChanged && nativeChanged ? 'diverged' : sourceChanged ? 'source_ahead' : nativeChanged ? 'native_ahead' : 'in_sync');
  const recommendation = !sourceChanged && !nativeChanged
    ? 'none'
    : sourceChanged && !nativeChanged
      ? 'rebuild'
      : !sourceChanged && nativeChanged
        ? 'lift'
        : 'merge';
  return {
    state: stateLabel,
    recommendation,
    hasBaseline: Boolean(baseline),
    baselinePath,
    rpFile,
    currentRpSha256: currentRpSha,
    baselineRpSha256: baseline?.rpSha256 ?? null,
    sourcePath: resolvedSourcePath,
    currentSourceSha256: currentSourceSha,
    baselineSourceSha256: baseline?.sourceSha256 ?? null,
    semanticHash: baseline?.semanticHash ?? null,
    nativeChanged,
    nativeModified: nativeChanged,
    sourceChanged,
    sourceModified: sourceChanged,
    sourceFileDiskDirty,
    chainEdited,
  };
}

function loadSpecObjectFromSource(sourcePath) {
  const absPath = resolve(sourcePath);
  if (!pathExists(absPath)) throw new Error(`源码文件不存在：${absPath}`);
  if (absPath.toLowerCase().endsWith('.json')) {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  }
  const proc = spawnPythonSync([RP_LANG_CLI, 'dsl-to-json', '--spec', absPath], { encoding: 'utf8' });
  if (proc.status !== 0) {
    let diagPayload = null;
    try { diagPayload = JSON.parse((proc.stderr || proc.stdout || '').trim()); } catch {}
    const firstMsg = diagPayload?.diagnostics?.[0]?.message || (proc.stderr || proc.stdout || proc.error?.message || '').trim();
    const err = new Error(`解析 RP/1 源码失败：${firstMsg}`);
    if (Array.isArray(diagPayload?.diagnostics)) err.diagnostics = diagPayload.diagnostics;
    throw err;
  }
  return JSON.parse(proc.stdout);
}

function summarizeNativePrograms(program) {
  const one = page => ({ page: page.page, routineCount: page.routines.length,
    triggerCount: page.triggers.length, callbackCount: Object.keys(page.callbacks).length,
    unoptimizedCallbackCount: page.unoptimizedCallbackCount, loopCount: page.loopCount,
    asyncLoopCount: page.asyncLoopCount, reentry: page.reentry, ...(page.tasks?.length ? { tasks: page.tasks } : {}) });
  return program.pages ? { pages: program.pages.map(one) } : one(program);
}

function prototypeAssetsDir(output) {
  return join(dirname(output), basename(output, extname(output)) + '.assets');
}

function cleanLegacyArtifacts(output) {
  const directory = dirname(output);
  const stem = basename(output, extname(output));
  const prefixes = [`.${stem}.build-`, `.${stem}.img-build-`];
  const removed = [];
  if (!existsSync(directory)) return removed;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !prefixes.some(prefix => entry.name.startsWith(prefix))) continue;
    const path = join(directory, entry.name);
    assertNotProtected(path);
    assertWritable(path);
    rmSync(path, { recursive: true });
    removed.push(path);
  }
  return removed;
}

function relocateArtifactValue(value, from, to) {
  if (typeof value === 'string' && (value === from || value.startsWith(from + '/'))) return to + value.slice(from.length);
  if (Array.isArray(value)) return value.map(item => relocateArtifactValue(item, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocateArtifactValue(item, from, to)]));
  }
  return value;
}

function behaviorFingerprint(spec, plan, compiled) {
  if (!plan.pages.every(page => compiled.cacheStats?.pageCompileKeys?.[page.slug]) ||
      !plan.sourceSpec || plan.nativeProgram || compiled.audit?.autoHeal) return null;
  const primitive = new Set(['label', 'paragraph', 'button', 'badge', 'input']);
  const normalizeNode = node => {
    if (!node || typeof node !== 'object') return node;
    const copy = { ...node };
    if (primitive.has(copy.type) && typeof copy.color === 'string' && /^#[a-f0-9]{6}$/i.test(copy.color)) delete copy.color;
    if (Array.isArray(copy.children)) copy.children = copy.children.map(normalizeNode);
    if (Array.isArray(copy.states)) copy.states = copy.states.map(state => ({
      ...state,
      ...(state.root ? { root: normalizeNode(state.root) } : {}),
      ...(Array.isArray(state.children) ? { children: state.children.map(normalizeNode) } : {}),
    }));
    if (copy.template) copy.template = normalizeNode(copy.template);
    return copy;
  };
  const source = { ...spec, pages: spec.pages.map(page => ({ ...page, root: normalizeNode(page.root) })) };
  const geometry = plan.pages.map(page => [page.slug, page.canvas, page.adaptiveOverrides,
    page.allMainWidgets.map(widget => [widget.name, widget.x, widget.y, widget.w, widget.h]), page.interactions,
    // Nested scene semantics are represented by the source and normalized events.
    page.scenes.map(scene => [scene.id, scene.canvas, scene.kind])]);
  return createHash('sha256').update(JSON.stringify([source, geometry])).digest('hex');
}

function publishBuildDirectory(stage, target) {
  assertNotProtected(target);
  assertWritable(target);
  const next = join(dirname(target), '.zee-publish-' + randomUUID());
  const previous = join(dirname(target), '.zee-publish-' + randomUUID());
  let retired = false;
  try {
    cpSync(stage, next, { recursive: true, errorOnExist: true });
    const rewrite = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) rewrite(path);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          const json = readFileSync(path, 'utf8');
          if (json.includes(stage)) writeFileSync(path, JSON.stringify(relocateArtifactValue(JSON.parse(json), stage, target), null, 2) + '\n');
        }
      }
    };
    rewrite(next);
    if (pathExists(target)) { renameSync(target, previous); retired = true; }
    renameSync(next, target);
  } catch (error) {
    if (retired && !pathExists(target)) renameSync(previous, target);
    throw error;
  } finally {
    rmSync(next, { recursive: true, force: true });
    if (retired) rmSync(previous, { recursive: true, force: true });
  }
}

export function generatePrototype({ rp1: inlineRp1Arg, spec: inputSpec, program, programs, sharedRoutines, verifySteps: programSteps, source: sourcePathArg, sourcePath: sourcePathAlias, recipe, output: requestedOutput, cwd, projectDir, strictAudit = false, autoHeal = false, variants, overwrite = false, compact = true, template, baseRp, prefer = 'fail', resolutions, verifyMode, noCache = false }, { beforePublish, cacheRoot } = {}) {
  let spec = { language: 'rp/1', target: 9 };
  let unlock = null;
  let stage = 'validation', output, artifactDir, source, resolvedSourceFile = null, inlineCompilePath = null, plan;
  let publishedCompanionSource = null, publishedRecipeOutput = null, publishedInteractions = null;
  const replaced = new Map();
  try {
    const explicitWorkDir = cwd ?? projectDir;
    const workDir = resolveWorkDir(explicitWorkDir);
    if (typeof inputSpec === 'string' && inputSpec.trimStart().startsWith('{')) inputSpec = JSON.parse(inputSpec);
    if ([inlineRp1Arg, inputSpec, sourcePathArg, sourcePathAlias, recipe].filter(v => v !== undefined).length > 1)
      throw new Error('rp1、recipe、spec、source、sourcePath 只能选择一个输入入口。');
    const inlineRp1Text = typeof inlineRp1Arg === 'string'
      ? inlineRp1Arg
      : (isInlineRp1Text(inputSpec) ? inputSpec : (isInlineRp1Text(sourcePathArg ?? sourcePathAlias) ? (sourcePathArg ?? sourcePathAlias) : null));
    if (inlineRp1Text !== null && !inlineRp1Text.trim()) {
      throw new Error('rp1 源码不能为空。');
    }
    const rawSourceArg = recipe ? recipeSource(recipe) : (inlineRp1Text !== null ? null : (sourcePathArg ?? sourcePathAlias));
    resolvedSourceFile = typeof rawSourceArg === 'string'
      ? resolveInWork(rawSourceArg, explicitWorkDir)
      : (inlineRp1Text === null && typeof inputSpec === 'string' ? resolveInWork(inputSpec, explicitWorkDir) : null);
    if (typeof requestedOutput !== 'string' || !requestedOutput.trim()) {
      throw new Error('output 必须是有效的 .rp 路径。');
    }
    let effectiveRequestedOutput = requestedOutput;
    const authorProgram = program !== undefined || programs !== undefined;
    if (program !== undefined && programs !== undefined) throw new Error('program 与 programs 二选一。');
    if (!authorProgram && sharedRoutines !== undefined) throw new Error('sharedRoutines 需要 program 或 programs。');
    const hasCompanionSource = Boolean(recipe || inlineRp1Text !== null || authorProgram);
    const companionSuffix = !authorProgram || recipe || inlineRp1Text !== null ? '.rp1'
      : resolvedSourceFile ? `.source${extname(resolvedSourceFile)}` : '.json';
    if (requestedOutput === 'auto') {
      const sourceOutsideSkill = !recipe && resolvedSourceFile
        && !resolvedSourceFile.startsWith(`${SKILL_ROOT_DIR}/`) && resolvedSourceFile !== SKILL_ROOT_DIR;
      const baseDir = (!explicitWorkDir && sourceOutsideSkill) ? dirname(resolvedSourceFile) : workDir;
      const baseStem = recipe ? recipe : (resolvedSourceFile ? basename(resolvedSourceFile, extname(resolvedSourceFile)) : 'prototype');
      const isAvailable = cand => !pathExists(cand) && !pathExists(`${cand}.assets`) && !pathExists(`${cand}.baseline.json`) && (!hasCompanionSource || (!pathExists(`${cand.slice(0, -3)}${companionSuffix}`) && !pathExists(`${cand.slice(0, -3)}${companionSuffix}.interactions.json`)));
      const cand0 = join(baseDir, `${baseStem}.rp`);
      if (isAvailable(cand0)) effectiveRequestedOutput = cand0;
      else {
        for (let v = 2; ; v++) {
          const candV = join(baseDir, `${baseStem}-v${v}.rp`);
          if (isAvailable(candV)) { effectiveRequestedOutput = candV; break; }
        }
      }
    }
    const resolvedOutput = isAbsolute(effectiveRequestedOutput) ? effectiveRequestedOutput : resolve(workDir, effectiveRequestedOutput);
    if (extname(resolvedOutput).toLowerCase() !== '.rp')
      throw new Error('output 必须是新的 .rp 路径。');
    assertWritable(resolvedOutput);
    let nativeInteractions = readNativeInteractionSource(resolvedSourceFile);
    if (authorProgram && nativeInteractions) throw new Error('内联 program/programs 与源文件旁的交互源码二选一。');
    const companionSourceTarget = hasCompanionSource ? resolvedOutput.slice(0, -3) + companionSuffix : null;
    if (companionSourceTarget) {
      assertWritable(companionSourceTarget);
      if (pathExists(companionSourceTarget) && !(inlineRp1Text !== null && overwrite)) {
        throw new Error(recipe
          ? `范例源码已存在，请通过 source 继续改稿：${companionSourceTarget}`
          : `源码文件已存在，请通过 source 继续改稿（或传 overwrite: true）：${companionSourceTarget}`);
      }
    }
    const resolvedTpl = template !== undefined ? resolveInWork(template, explicitWorkDir) : undefined;
    if (resolvedTpl !== undefined) {
      assertNotProtected(resolvedTpl);
      if (!pathExists(resolvedTpl)) throw new Error(`template 不存在：${resolvedTpl}`);
    }
    if (pathExists(resolvedOutput)) {
      if (recipe) throw new Error('从范例创建需要新文件名；已有工程请使用 source 或 revise_prototype。');
      const existingSync = computeSyncStatus(resolvedOutput, resolvedSourceFile);
      if (existingSync.hasBaseline && existingSync.nativeChanged && prefer === 'fail') {
        return {
          status: 'failed',
          stage: 'drift_check',
          code: 'E_NATIVE_DRIFT_PROTECTED',
          message: '目标 .rp 存在未同步的原生改稿，拒绝在 prefer=fail 下直接重建覆盖；请使用 sync_prototype 或指定 prefer。',
          syncStatus: existingSync,
          diagnostics: [{ code: 'E_NATIVE_DRIFT_PROTECTED', pointer: '/', message: '目标 .rp 存在未同步的原生改稿' }],
        };
      }
      if (!overwrite) {
        throw new Error('输出已存在，请使用新文件名（或传 overwrite: true）。');
      }
    }
    if (baseRp !== undefined) {
      const resolvedBaseRp = resolveInWork(baseRp, explicitWorkDir);
      if (!pathExists(resolvedBaseRp)) throw new Error(`baseRp 不存在：${resolvedBaseRp}`);
      const syncStatus = computeSyncStatus(resolvedBaseRp, resolvedSourceFile);
      if (syncStatus.nativeChanged) {
        return syncPrototype({
          mode: 'merge',
          source: resolvedSourceFile ?? undefined,
          spec: resolvedSourceFile ? undefined : spec,
          rp: resolvedBaseRp,
          output: resolvedOutput,
          prefer,
          resolutions,
        }, { beforePublish });
      }
    }
    mkdirSync(dirname(resolvedOutput), { recursive: true });
    output = writablePath(resolvedOutput);
    unlock = acquireOutputLock(output);
    if (!overwrite && pathExists(output)) throw Object.assign(new Error(`目标已存在：${output}`), { code: 'E_OUTPUT_EXISTS' });
    const publishedAssets = prototypeAssetsDir(output);
    artifactDir = mkdtempSync(join(tmpdir(), 'zee-build-'));
    const publish = payload => {
      publishBuildDirectory(artifactDir, publishedAssets);
      return relocateArtifactValue(payload, artifactDir, publishedAssets);
    };
    if (inlineRp1Text !== null) {
      inlineCompilePath = join(artifactDir, 'inline.rp1');
      writeFileSync(inlineCompilePath, inlineRp1Text.endsWith('\n') ? inlineRp1Text : `${inlineRp1Text}\n`, 'utf8');
    }
    const rawSpecObj = (inlineRp1Text !== null)
      ? loadSpecObjectFromSource(inlineCompilePath)
      : ((inputSpec && typeof inputSpec === 'object' && !Array.isArray(inputSpec))
          ? inputSpec
          : (resolvedSourceFile ? loadSpecObjectFromSource(resolvedSourceFile) : null));
    if (!rawSpecObj) {
      throw new Error('arguments.spec 必须是对象（或通过 rp1/source 提供 RP/1 源码）');
    }
    spec = { language: 'rp/1', target: 9, ...rawSpecObj };
    if (!Array.isArray(spec.pages) || spec.pages.length < 1) {
      throw new Error('arguments.spec.pages 至少需要 1 项');
    }
    source = join(artifactDir, 'source.json');
    writeFileSync(source, JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' });
    if (authorProgram) {
      const path = `${inlineCompilePath ?? source}.interactions.json`;
      const steps = programSteps ?? [];
      writeFileSync(path, JSON.stringify({ program, programs, sharedRoutines, steps }, null, 2) + '\n', { flag: 'wx' });
      nativeInteractions = { path, items: [], program, programs, steps };
    }
    stage = 'compile';
    reportPrototypeProgress('compile', 0, 1);
    const buildCacheRoot = !noCache && (cacheRoot ?? join(dirname(output), '.zee-cache'));
    const compileStarted = performance.now();
    const compiled = compilePrototype(resolvedSourceFile ?? inlineCompilePath ?? source, artifactDir, {
      strictAudit, autoHeal: Boolean(autoHeal), nativeProgram: nativeInteractions?.program || nativeInteractions?.programs ? nativeInteractions.path : undefined,
      skipPreviews: verifyMode === 'fast',
      pageCacheDir: buildCacheRoot ? cacheDirectory(buildCacheRoot, 'pages') : undefined,
    });
    const compileMs = Math.round(performance.now() - compileStarted);
    reportPrototypeProgress('compile', 1, 1);
    plan = JSON.parse(readFileSync(compiled.planPath, 'utf8'));
    if (!compiled.ok) {
      const error = new Error('原型未通过布局检查。');
      error.diagnostics = (compiled.audit?.failures ?? []).map(f => {
        if (typeof f === 'string') return { severity: 'error', code: 'E_LAYOUT', pointer: '/', message: f };
        const readable = f?.message && typeof f.message === 'string' ? f.message : null;
        const entry = {
          severity: 'error',
          code: 'E_LAYOUT',
          pointer: '/',
          pageName: f?.page,
          message: readable || JSON.stringify(f),
        };
        if (f?.suggestion) entry.suggestion = f.suggestion;
        if (readable) entry.data = f;
        return entry;
      });
      if (!error.diagnostics.length) error.diagnostics = (compiled.warnings ?? []).map(message => ({
        code: 'E_LAYOUT', pointer: '/', message, pageName: message.match(/^\[([^\]]+)\]/)?.[1],
      }));
      if (!error.diagnostics.length) error.diagnostics = [{ code: 'E_LAYOUT', pointer: '/', message: error.message }];
      throw error;
    }
    stage = 'native';
    const staged = join(artifactDir, 'prototype.rp');
    const prevTpl = process.env.AXURE_BLANK_TEMPLATE_RP9;
    if (resolvedTpl !== undefined) process.env.AXURE_BLANK_TEMPLATE_RP9 = resolvedTpl;
    let build;
    try {
      build = buildInteractiveRp(compiled.planPath, staged, { backend: 'native', buildCacheRoot,
        pageCompileKeys: compiled.cacheStats?.pageCompileKeys });
    } finally {
      if (resolvedTpl !== undefined) {
        if (prevTpl === undefined) delete process.env.AXURE_BLANK_TEMPLATE_RP9;
        else process.env.AXURE_BLANK_TEMPLATE_RP9 = prevTpl;
      }
    }
    if (nativeInteractions) {
      stage = 'native-interactions';
      const tempBaseline = `${staged}.baseline.json`;
      const data = JSON.parse(readFileSync(tempBaseline, 'utf8'));
      if (nativeInteractions.items.length) {
        const baseline = loadBaselineMap(staged);
        const candidate = addInteractionsBatch(readFileSync(staged), nativeInteractions.items, { baseline });
        writeFileSync(staged, candidate.file);
        data.baseRpBase64 = candidate.file.toString('base64');
        build.nativeInteractions = candidate.report;
      }
      data.nativeInteractionsSha256 = sha256Of(nativeInteractions.path);
      data.nativeVerifySteps = nativeInteractions.steps;
      writeFileSync(tempBaseline, JSON.stringify(data, null, 2) + '\n');
    }
    stage = 'structure';
    const rp = readRp(readFileSync(staged), { path: output });
    const structure = zerosOf(rp);
    if (Object.values(structure).some(Boolean) || build.eventCoverage.declared !== build.eventCoverage.materialized)
      throw new Error('原生结构或事件覆盖检查失败。');
    const pages = plan.pages.map(p => {
      const native = rp.pages.find(page => page.name === p.pageName);
      if (!native) throw new Error(`缺少生成页面：${p.pageName}`);
      return { id: p.slug, name: native.name, record: native.record, ...native.counts };
    });
    const previews = Object.fromEntries(plan.pages
      .map(p => [p.slug, p.previews?.preview2x ?? p.previews?.preview]).filter(([, path]) => path));
    const contactSheet = compiled.previews?.contactSheet && pathExists(compiled.previews.contactSheet) ? compiled.previews.contactSheet : null;
    const statesSheet = compiled.previews?.statesSheet && pathExists(compiled.previews.statesSheet) ? compiled.previews.statesSheet : null;
    // 面板状态预览：此前只落在 .build/states 里、响应不暴露，评审多态页只能自己翻目录
    const statePreviews = Object.fromEntries((compiled.audit?.statePreviews ?? []).map(
      sp => [`${sp.page}/${sp.stable || sp.scene}`, sp.png]));
    let variantResults = undefined;
    if (Array.isArray(variants) && variants.length > 0) {
      variantResults = [];
      for (let vIdx = 0; vIdx < Math.min(variants.length, 4); vIdx++) {
        const vItem = typeof variants[vIdx] === 'string' ? { id: variants[vIdx], theme: variants[vIdx] } : (variants[vIdx] || {});
        const vId = String(vItem.id || vItem.theme || `variant-${vIdx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_');
        const vDir = join(artifactDir, 'variants', vId);
        mkdirSync(vDir, { recursive: true });
        const vSpec = { ...spec, ...(vItem.theme ? { theme: vItem.theme } : {}),
          ...(vItem.palette ? { palette: { ...(spec.palette || {}), ...vItem.palette } } : {}),
          ...(vItem.tokens ? { tokens: { ...(spec.tokens || {}), ...vItem.tokens } } : {}) };
        const vSrc = join(vDir, 'variant.json');
        writeFileSync(vSrc, JSON.stringify(vSpec, null, 2) + '\n');
        const vCompiled = compilePrototype(vSrc, vDir, { strictAudit, autoHeal: Boolean(autoHeal) });
        const vPlan = pathExists(vCompiled.planPath) ? JSON.parse(readFileSync(vCompiled.planPath, 'utf8')) : { pages: [] };
        variantResults.push({
          id: vId,
          name: vItem.name || vId,
          theme: vSpec.theme || null,
          ok: Boolean(vCompiled.ok),
          contactSheet: vCompiled.previews?.contactSheet && pathExists(vCompiled.previews.contactSheet) ? vCompiled.previews.contactSheet : null,
          previews: Object.fromEntries((vPlan.pages ?? []).map(p => [p.slug, p.previews?.preview2x ?? p.previews?.preview])),
        });
      }
    }
    for (const [file, sourceImage] of [['pages-sheet.png', contactSheet], ['states-sheet.png', statesSheet]]) {
      const targetImage = join(artifactDir, file);
      if (sourceImage && sourceImage !== targetImage) copyFileSync(sourceImage, targetImage);
    }
    const reportPath = join(artifactDir, 'build-report.json');
    writeFileSync(reportPath, JSON.stringify({ ...build, outputRp: output }, null, 2) + '\n', { flag: 'wx' });
    stage = 'output';
    const interactionOutput = companionSourceTarget && nativeInteractions ? `${companionSourceTarget}.interactions.json` : null;
    if (interactionOutput && pathExists(interactionOutput)) throw new Error(`配套交互源码已存在：${interactionOutput}`);
    beforePublish?.();
    assertWritable(output);
    const outputBaseline = `${output}.baseline.json`;
    for (const path of [output, outputBaseline, companionSourceTarget].filter(Boolean)) {
      assertWritable(path);
      if (overwrite) replaced.set(path, pathExists(path) ? readFileSync(path) : null);
    }
    const companionExistedBefore = companionSourceTarget ? pathExists(companionSourceTarget) : false;
    if (overwrite) copyFileSync(staged, output);
    else copyFileSync(staged, output, constants.COPYFILE_EXCL);
    if (recipe || !overwrite) publishedRecipeOutput = output;
    const stagedBaseline = `${staged}.baseline.json`;
    if (pathExists(stagedBaseline)) {
      const baseMeta = JSON.parse(readFileSync(stagedBaseline, 'utf8'));
      baseMeta.outputRp = output;
      const oldMeta = existsSync(outputBaseline) ? JSON.parse(readFileSync(outputBaseline, 'utf8')) : null;
      baseMeta.projectUuid = oldMeta?.projectUuid ?? randomUUID();
      baseMeta.companionFiles = { rp: basename(output), source: basename(companionSourceTarget ?? resolvedSourceFile ?? source), assetsDir: basename(publishedAssets) };
      baseMeta.rpSha256 = sha256Of(output);
      baseMeta.sourcePath = resolvedSourceFile ?? join(publishedAssets, basename(source));
      baseMeta.sourceSha256 = sha256Of(resolvedSourceFile ?? source);
      if (!nativeInteractions && resolvedTpl === undefined) baseMeta.semanticBehaviorKey = behaviorFingerprint(spec, plan, compiled);
      baseMeta.staticPageKeys = Object.fromEntries(plan.pages.filter(page => compiled.cacheStats?.pageCompileKeys?.[page.slug] &&
        !page.interactions.length && !page.repeaters.length && !page.dynamicPanels.length &&
        !page.nativeInputs.length && !page.masters?.length && !Object.keys(page.adaptiveOverrides ?? {}).length)
        .map(page => [page.slug, compiled.cacheStats.pageCompileKeys[page.slug]]));
      writeFileSync(outputBaseline, JSON.stringify(baseMeta, null, 2) + '\n');
      unlinkSync(stagedBaseline);
    }
    unlinkSync(staged);
    if (companionSourceTarget) {
      const companionSrc = resolvedSourceFile ?? inlineCompilePath ?? source;
      if (overwrite && !recipe) copyFileSync(companionSrc, companionSourceTarget);
      else copyFileSync(companionSrc, companionSourceTarget, constants.COPYFILE_EXCL);
      if (!companionExistedBefore) publishedCompanionSource = companionSourceTarget;
      resolvedSourceFile = companionSourceTarget;
      if (interactionOutput) {
        assertWritable(interactionOutput);
        copyFileSync(nativeInteractions.path, interactionOutput, constants.COPYFILE_EXCL);
        publishedInteractions = interactionOutput;
      }
      if (pathExists(outputBaseline)) {
        const baseMeta = JSON.parse(readFileSync(outputBaseline, 'utf8'));
        baseMeta.sourcePath = resolvedSourceFile;
        baseMeta.sourceSha256 = sha256Of(resolvedSourceFile);
        writeFileSync(outputBaseline, JSON.stringify(baseMeta, null, 2) + '\n');
      }
    }
    const sha256 = sha256Of(output);
    const verification = { structure: true, axureOpened: false, guiEdited: false, saveReopened: false, preview: false };
    const nextGuiOutput = (() => {
      const stem = output.slice(0, -3);
      if (!pathExists(`${stem}-gui.rp`)) return `${stem}-gui.rp`;
      for (let n = 2; ; n++) if (!pathExists(`${stem}-gui-${n}.rp`)) return `${stem}-gui-${n}.rp`;
    })();
    if (buildCacheRoot) pruneBuildCache(buildCacheRoot);
    const summary = { source: resolvedSourceFile ?? source, baseline: outputBaseline, verification,
      timings: { compileMs, nativeAssemblyMs: build.elapsedMs },
      cacheStats: { ...compiled.cacheStats, reusedNativePages: build.reusedNativePages },
      ...(nativeInteractions ? { interactionSource: publishedInteractions ?? nativeInteractions.path,
        verifySteps: nativeInteractions.steps, interactionEngine: 'official' } : {}),
      ...(plan.nativeProgram ? { nativeProgram: summarizeNativePrograms(plan.nativeProgram) } : {}),
      nextActions: [
        { tool: 'export_prototype', arguments: { rp: output } },
        { tool: 'revise_prototype', source: resolvedSourceFile ?? source, rp: output },
        { tool: 'gui_roundtrip', source: output, output: nextGuiOutput, preview: true },
      ] };
    const resultPath = join(artifactDir, 'result.json');
    writeFileSync(resultPath, JSON.stringify({ ...summary, output, sha256, pages, structure, eventCoverage: build.eventCoverage,
      previews, ...(contactSheet ? { contactSheet } : {}), ...(statesSheet ? { statesSheet } : {}),
      ...(variantResults ? { variants: variantResults } : {}),
      statePreviews, audit: compiled.audit, artifacts: { directory: artifactDir, source: summary.source,
        plan: compiled.planPath, ir: join(artifactDir, 'language-ir.json'), audit: compiled.auditPath, buildReport: reportPath } }, null, 2) + '\n');
    if (compact) {
      return publish({
        ...summary, report: resultPath,
        status: 'completed',
        output,
        sha256,
        pages,
        counts: rp.counts,
        previews,
        ...(contactSheet ? { contactSheet } : {}),
        ...(statesSheet ? { statesSheet } : {}),
        ...(variantResults ? { variants: variantResults } : {}),
        statePreviewCount: Object.keys(statePreviews).length,
        audit: {
          structuralOk: compiled.structural_ok,
          aestheticOk: compiled.aesthetic_ok,
          ...(compiled.autoHeal ? { autoHeal: { mode: compiled.autoHeal.mode, healedCount: compiled.autoHeal.healedCount,
            rolledBack: compiled.autoHeal.rolledBack, rejectedCount: compiled.autoHeal.rejectedChanges?.length ?? 0 } } : {}),
          warningCount: (compiled.warnings ?? []).length,
          applicability: compiled.audit?.applicability,
          warnings: (compiled.warnings ?? []).slice(0, 5),
          ...(compiled.audit?.sourceDiagnostics?.length ? { sourceDiagnostics: compiled.audit.sourceDiagnostics } : {}),
          ...(compiled.audit?.degradations?.length ? { degradations: compiled.audit.degradations } : {}),
        },
      });
    }
    return publish({ ...summary, report: resultPath, status: 'completed', output, sha256, baseline: pathExists(outputBaseline) ? outputBaseline : null, pages, counts: rp.counts,
      structure, eventCoverage: build.eventCoverage, previews,
      ...(contactSheet ? { contactSheet } : {}),
      ...(statesSheet ? { statesSheet } : {}),
      ...(variantResults ? { variants: variantResults } : {}),
      statePreviews,
      audit: { structuralOk: compiled.structural_ok, aestheticOk: compiled.aesthetic_ok, warnings: compiled.warnings,
        warningCount: (compiled.warnings ?? []).length, applicability: compiled.audit?.applicability,
        sourceDiagnostics: compiled.audit?.sourceDiagnostics, degradations: compiled.audit?.degradations },
      artifacts: { directory: artifactDir, source: resolvedSourceFile ?? source, plan: compiled.planPath, ir: join(artifactDir, 'language-ir.json'), audit: compiled.auditPath, buildReport: reportPath, baseline: pathExists(outputBaseline) ? outputBaseline : null },
      verification,
    });
  } catch (error) {
    if (publishedInteractions) rmSync(publishedInteractions, { force: true });
    if (publishedCompanionSource) rmSync(publishedCompanionSource, { force: true });
    if (publishedRecipeOutput) {
      rmSync(publishedRecipeOutput, { force: true });
      rmSync(`${publishedRecipeOutput}.baseline.json`, { force: true });
    }
    for (const [path, contents] of replaced) {
      if (contents === null) rmSync(path, { force: true });
      else writeFileSync(path, contents);
    }
    const diagnoseInput = resolvedSourceFile ?? inlineCompilePath ?? spec;
    const raw = error.diagnostics ?? [{ code: `E_GENERATE_${stage.toUpperCase()}`, pointer: undefined, message: error.message }];
    let diagnostics = raw.map(d => generationDiagnostic(d, spec, plan));
    let hints = [];
    try { hints = runWorkflow('diagnose', diagnoseInput).hints ?? []; } catch {}
    if (stage === 'compile' && !raw.some(d => d.code === 'E_LAYOUT')) {
      try {
        const checked = runWorkflow('diagnose', diagnoseInput);
        if (!checked.ok) diagnostics = checked.diagnostics.map(d => generationDiagnostic(d, spec, plan));
      } catch { /* Preserve the original compiler diagnostic if secondary diagnosis is unavailable. */ }
    }
    const result = { status: 'failed', stage, message: diagnostics[0]?.message ?? error.message,
      diagnostics, ...(hints.length ? { hints } : {}),
      ...(artifactDir && output ? { artifacts: { directory: prototypeAssetsDir(output), source: resolvedSourceFile ?? undefined } } : {}),
    };
    if (artifactDir && output) {
      const directory = prototypeAssetsDir(output);
      try {
        const path = join(directory, 'last-failure.json');
        assertWritable(path);
        assertNotProtected(path);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
      } catch { /* Retain the diagnostic if the report cannot be persisted. */ }
    }
    return result;
  } finally {
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    unlock?.();
  }
}

function compactSourceDeltas(sourceDeltas, includeFull = false) {
  if (!sourceDeltas || typeof sourceDeltas !== 'object' || includeFull) return sourceDeltas ?? {};
  const out = {};
  for (const [key, delta] of Object.entries(sourceDeltas)) {
    if (!delta || typeof delta !== 'object') {
      out[key] = delta;
      continue;
    }
    const summarizeVal = val => {
      if (val === null || val === undefined || typeof val !== 'object') return val;
      const json = JSON.stringify(val);
      if (json.length <= 160) return val;
      if (Array.isArray(val)) return { _summary: `Array(${val.length})` };
      return { _summary: `Object(${Object.keys(val).slice(0, 6).join(',')})` };
    };
    out[key] = { old: summarizeVal(delta.old), new: summarizeVal(delta.new) };
  }
  return out;
}

function stripReportSpec(report) {
  if (!report || typeof report !== 'object') return report;
  const { spec, rp1Spec, rp1, ...rest } = report;
  return rest;
}

function relocatePrototype(from, to) {
  if (!from || !to || from === to || ![from, to].every(path => extname(path).toLowerCase() === '.rp')) {
    throw Object.assign(new Error('迁移需要两个不同的 .rp 路径。'), { code: 'E_SYNC_INPUT' });
  }
  const unlock = [];
  const moved = [];
  const reports = new Map();
  try {
    for (const path of [from, to].sort()) unlock.push(acquireOutputLock(path));
    const oldBaseline = `${from}.baseline.json`;
    const newBaseline = `${to}.baseline.json`;
    if (!existsSync(oldBaseline)) throw Object.assign(new Error('未找到原文件名的共同基线。'), { code: 'E_BASELINE_MISSING' });
    assertNotProtected(oldBaseline);
    assertWritable(oldBaseline);
    const meta = JSON.parse(readFileSync(oldBaseline, 'utf8'));
    const oldAssets = prototypeAssetsDir(from);
    const newAssets = prototypeAssetsDir(to);
    const oldSource = meta.sourcePath;
    const fromStem = basename(from, '.rp');
    const toStem = basename(to, '.rp');
    const companion = oldSource && dirname(oldSource) === dirname(from) && basename(oldSource, extname(oldSource)) === fromStem;
    const inAssets = oldSource?.startsWith(oldAssets + '/');
    const newSource = companion ? join(dirname(to), toStem + extname(oldSource)) : inAssets ? newAssets + oldSource.slice(oldAssets.length) : oldSource;
    const alreadyMoved = !existsSync(from) && existsSync(to);
    const rpSource = alreadyMoved ? to : from;
    if (!existsSync(rpSource) || sha256Of(rpSource) !== meta.rpSha256) {
      throw Object.assign(new Error('原生文件与共同基线指纹不匹配。'), { code: 'E_CONCURRENT_MODIFICATION' });
    }
    const pairs = [
      ...(!alreadyMoved ? [[from, to]] : []),
      ...(companion ? [[oldSource, newSource]] : []),
      ...(companion && existsSync(`${oldSource}.interactions.json`) ? [[`${oldSource}.interactions.json`, `${newSource}.interactions.json`]] : []),
      ...(existsSync(oldAssets) ? [[oldAssets, newAssets]] : []),
      [oldBaseline, newBaseline],
    ];
    for (const [src, dest] of pairs) {
      assertNotProtected(src);
      assertNotProtected(dest);
      assertWritable(src);
      assertWritable(dest);
      if (pathExists(dest)) throw Object.assign(new Error(`迁移目标已存在：${dest}`), { code: 'E_OUTPUT_EXISTS' });
    }
    for (const [src, dest] of pairs) {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(src, dest);
      moved.push([src, dest]);
    }
    const rewrite = (file, value) => {
      const original = readFileSync(file, 'utf8');
      reports.set(file, original);
      const mapped = [...pairs, ...(alreadyMoved ? [[from, to]] : [])]
        .reduce((current, [src, dest]) => relocateArtifactValue(current, src, dest), value ?? JSON.parse(original));
      writeFileSync(file, JSON.stringify(mapped, null, 2) + '\n');
    };
    rewrite(newBaseline, { ...meta, outputRp: to, sourcePath: newSource,
      companionFiles: { rp: basename(to), source: newSource ? basename(newSource) : null, assetsDir: basename(newAssets) } });
    if (existsSync(newAssets)) {
      const rewriteDirectory = dir => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) rewriteDirectory(path);
          else if (entry.isFile() && entry.name.endsWith('.json')) rewrite(path);
          else if (entry.isFile() && entry.name === 'PROOF.md') {
            const original = readFileSync(path, 'utf8');
            reports.set(path, original);
            const mapped = [...pairs, [from, to]].reduce((content, [src, dest]) => content.replaceAll(src, dest), original);
            writeFileSync(path, mapped.replaceAll(`\`${basename(from)}\``, `\`${basename(to)}\``));
          }
        }
      };
      rewriteDirectory(newAssets);
    }
    return { ok: true, status: 'completed', mode: 'relocate', output: to, source: newSource,
      baseline: newBaseline, directory: existsSync(newAssets) ? newAssets : null, sha256: meta.rpSha256 };
  } catch (error) {
    for (const [file, bytes] of reports) writeFileSync(file, bytes);
    for (const [src, dest] of moved.reverse()) renameSync(dest, src);
    throw error;
  } finally {
    for (const release of unlock.reverse()) release();
  }
}

function syncPrototype({
  mode = 'merge',
  from, to,
  source: sourceArg,
  sourcePath: sourcePathArg,
  spec: specArg,
  rp: rpArg,
  path: pathArg,
  rpFile: rpFileArg,
  file: fileArg,
  baseRp: baseRpArg,
  baseline: baselineArg,
  baselinePath: baselinePathArg,
  output: outputArg,
  outRp: outRpArg,
  outSource: outSourceArg,
  outSpec: outSpecArg,
  cwd,
  projectDir,
  prefer = 'fail',
  resolutions,
  expectedRpSha256,
  expectedSemanticHash,
  overwrite = false,
  includeSpec = false,
}, { beforePublish } = {}) {
  if (mode === 'relocate') return relocatePrototype(resolveInWork(from, cwd ?? projectDir), resolveInWork(to, cwd ?? projectDir));
  let stage = 'validation', tmpDir;
  const unlocks = [];
  try {
    const explicitWorkDir = cwd ?? projectDir;
    if (typeof specArg === 'string' && specArg.trimStart().startsWith('{')) specArg = JSON.parse(specArg);
    const rpInputRaw = rpArg ?? pathArg ?? rpFileArg ?? fileArg;
    const rpInput = rpInputRaw !== undefined ? resolveInWork(rpInputRaw, explicitWorkDir) : undefined;
    const sourceRaw = sourceArg ?? sourcePathArg ?? (typeof specArg === 'string' ? specArg : undefined);
    const source = sourceRaw !== undefined ? resolveInWork(sourceRaw, explicitWorkDir) : undefined;
    const baselineInputRaw = baselineArg ?? baselinePathArg;
    const baselineInput = baselineInputRaw !== undefined ? resolveInWork(baselineInputRaw, explicitWorkDir) : undefined;
    const resolvedBaseRpArg = baseRpArg !== undefined ? resolveInWork(baseRpArg, explicitWorkDir) : undefined;
    const inlineSpec = (specArg && typeof specArg === 'object' && !Array.isArray(specArg)) ? specArg : undefined;
    const outputRaw = outputArg ?? outRpArg;
    const output = outputRaw !== undefined ? resolveInWork(outputRaw, explicitWorkDir) : undefined;
    const outSourceRaw = outSourceArg ?? outSpecArg;
    const outSource = outSourceRaw !== undefined ? resolveInWork(outSourceRaw, explicitWorkDir) : undefined;

    const activeSession = session ? refreshState(session) : null;
    const statusInfo = computeSyncStatus(rpInput ?? activeSession, source, resolvedBaseRpArg);
    const rpFile = statusInfo.rpFile ?? (rpInput ? resolve(rpInput) : null);
    const renamed = rpFile ? renamedCompanion(rpFile) : null;
    if (renamed) throw companionRenamedError(renamed);
    if (mode === 'status') {
      return { status: 'completed', mode: 'status', ...statusInfo, syncStatus: statusInfo };
    }
    if (!rpFile || !pathExists(rpFile)) {
      throw Object.assign(new Error(`目标 .rp 文件不存在：${rpFile ?? '(未指定)'}`), { code: 'E_RP_NOT_FOUND' });
    }
    assertNotProtected(rpFile);
    if (extname(rpFile).toLowerCase() !== '.rp') {
      throw Object.assign(new Error(`目标必须是 .rp 文件：${rpFile}`), { code: 'E_RP_NOT_FOUND' });
    }
    const writeTargets = new Set([output, outSource].filter(Boolean));
    if (mode === 'rebuild' && !output) writeTargets.add(rpFile);
    for (const target of [...writeTargets].sort()) unlocks.push(acquireOutputLock(target));
    const rpShaAtStart = sha256Of(rpFile);
    if (expectedRpSha256 && rpShaAtStart !== expectedRpSha256) {
      throw Object.assign(new Error(`目标 .rp 已被外部修改（期望 SHA-256 ${expectedRpSha256}，实际 ${rpShaAtStart}），拒绝过期提交。`), { code: 'E_STALE_SYNC_STATE' });
    }
    const baselinePath = baselineInput ? resolve(baselineInput) : statusInfo.baselinePath;
    let baselineData = null;
    if (baselinePath && pathExists(baselinePath)) {
      baselineData = JSON.parse(readFileSync(baselinePath, 'utf8'));
    }
    if (expectedSemanticHash && baselineData?.semanticHash && baselineData.semanticHash !== expectedSemanticHash) {
      throw Object.assign(new Error(`基线 semanticHash 不匹配（期望 ${expectedSemanticHash}，实际 ${baselineData.semanticHash}），拒绝过期更新。`), { code: 'E_STALE_SYNC_STATE' });
    }
    if (output !== undefined) {
      if (typeof output !== 'string' || !output.trim() || extname(output).toLowerCase() !== '.rp')
        throw Object.assign(new Error('output 必须是有效的 .rp 路径。'), { code: 'E_OUTPUT_PATH' });
      assertNotProtected(output);
      assertWritable(output);
    }
    if (outSource !== undefined) {
      if (typeof outSource !== 'string' || !outSource.trim())
        throw Object.assign(new Error('outSource 必须是有效的文件路径。'), { code: 'E_OUT_SOURCE_PATH' });
      assertNotProtected(outSource);
      assertWritable(outSource);
    }

    if (mode === 'decompile') {
      stage = 'decompile';
      if (outSource && !overwrite && pathExists(outSource)) {
        throw Object.assign(new Error(`源码输出已存在，拒绝覆盖（如需覆盖请传 overwrite: true）：${outSource}`), { code: 'E_OUTPUT_EXISTS' });
      }
      if (output && !overwrite && pathExists(output)) {
        throw Object.assign(new Error(`输出 .rp 已存在，拒绝覆盖（如需覆盖请传 overwrite: true）：${output}`), { code: 'E_OUTPUT_EXISTS' });
      }
      if (outSource && !['.rp1', '.json'].includes(extname(outSource).toLowerCase())) {
        throw Object.assign(new Error('outSource 必须是 .rp1 或 .json 路径。'), { code: 'E_OUT_SOURCE_PATH' });
      }
      tmpDir = mkdtempSync(join(tmpdir(), 'zee-rp-decompile-'));
      const reportPath = join(tmpDir, 'decompile-report.json');
      const pyScript = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
from rp_decompile import decompile_rp
res = decompile_rp(${JSON.stringify(rpFile)})
with open(${JSON.stringify(reportPath)}, 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
`;
      const proc = spawnPythonSync(['-c', pyScript], { encoding: 'utf8' });
      if (proc.status !== 0 || !pathExists(reportPath)) {
        throw Object.assign(new Error(`decompile 失败：${(proc.stderr || proc.stdout || '').trim()}`), { code: 'E_DECOMPILE_FAILED' });
      }
      const decomp = JSON.parse(readFileSync(reportPath, 'utf8'));
      const sourceTextOut = outSource && extname(outSource).toLowerCase() === '.json'
        ? JSON.stringify(decomp.spec, null, 2) + '\n'
        : (decomp.rp1.endsWith('\n') ? decomp.rp1 : `${decomp.rp1}\n`);
      const stagedSource = join(tmpDir, outSource && extname(outSource).toLowerCase() === '.json' ? 'decompiled.json' : 'decompiled.rp1');
      writeFileSync(stagedSource, sourceTextOut, 'utf8');

      let stagedOutputRp = null;
      let buildResult = null;
      if (output) {
        stage = 'rebuild';
        stagedOutputRp = join(tmpDir, 'decompiled.rp');
        buildResult = generatePrototype({ source: stagedSource, output: stagedOutputRp, compact: false });
        if (buildResult.status === 'failed') {
          throw Object.assign(new Error(`反编译后重编译 .rp 失败：${buildResult.message}`), { code: 'E_DECOMPILE_REBUILD_FAILED', diagnostics: buildResult.diagnostics });
        }
      }
      if (sha256Of(rpFile) !== rpShaAtStart) {
        throw Object.assign(new Error('目标 .rp 在反编译过程中被外部修改，中止提交。'), { code: 'E_CONCURRENT_MODIFICATION' });
      }
      const publishedFiles = [];
      try {
        if (outSource) {
          beforePublish?.();
          const existed = pathExists(outSource);
          mkdirSync(dirname(outSource), { recursive: true });
          if (overwrite) copyFileSync(stagedSource, outSource);
          else copyFileSync(stagedSource, outSource, constants.COPYFILE_EXCL);
          if (!existed) publishedFiles.push(outSource);
        }
        if (output && stagedOutputRp) {
          beforePublish?.();
          const existed = pathExists(output);
          mkdirSync(dirname(output), { recursive: true });
          if (overwrite) copyFileSync(stagedOutputRp, output);
          else copyFileSync(stagedOutputRp, output, constants.COPYFILE_EXCL);
          if (!existed) publishedFiles.push(output);
          if (pathExists(`${stagedOutputRp}.baseline.json`)) {
            const bMeta = JSON.parse(readFileSync(`${stagedOutputRp}.baseline.json`, 'utf8'));
            bMeta.outputRp = output;
            bMeta.rpSha256 = sha256Of(output);
            bMeta.sourcePath = outSource ?? null;
            bMeta.sourceSha256 = outSource ? sha256Of(outSource) : null;
            writeFileSync(`${output}.baseline.json`, JSON.stringify(bMeta, null, 2) + '\n');
            publishedFiles.push(`${output}.baseline.json`);
          }
        }
      } catch (pubErr) {
        for (const p of publishedFiles) rmSync(p, { recursive: true, force: true });
        throw pubErr;
      }

      const countWidgets = node => {
        if (!node || typeof node !== 'object') return 0;
        let total = 1;
        for (const c of node.children ?? []) total += countWidgets(c);
        for (const st of node.states ?? []) for (const c of st.children ?? []) total += countWidgets(c);
        return total;
      };
      const widgetCount = (decomp.spec?.pages ?? []).reduce((sum, pg) => sum + (pg.root ? countWidgets(pg.root) : 0), 0);
      return {
        ok: true,
        status: decomp.status || 'decompiled',
        mode: 'decompile',
        rp: rpFile,
        outSource: outSource ?? null,
        outSpec: outSource ?? null,
        output: output ?? null,
        ...(output ? { sha256: sha256Of(output), baseline: pathExists(`${output}.baseline.json`) ? `${output}.baseline.json` : null } : {}),
        ...(!outSource || includeSpec ? { rp1: decomp.rp1 } : {}),
        ...(includeSpec ? { spec: decomp.spec } : {}),
        summary: {
          pages: (decomp.spec?.pages ?? []).length,
          widgets: widgetCount,
          variables: Object.keys(decomp.spec?.variables ?? {}).length,
          compiledSymbols: decomp.compiledSymbolCount ?? 0,
          unsupportedNativeChanges: (decomp.unsupportedNativeChanges ?? []).length,
        },
        unsupportedNativeChanges: decomp.unsupportedNativeChanges ?? [],
        ...(output && outSource ? { syncStatus: computeSyncStatus(output, outSource, rpFile) } : {}),
        nextActions: [
          ...(outSource && output ? [{ tool: 'revise_prototype', arguments: { source: outSource, rp: output, output: 'auto', operations: [] } }] : []),
          ...(outSource && !output ? [{ tool: 'generate_prototype', arguments: { source: outSource, output: 'auto' } }] : []),
          ...(outSource ? [{ tool: 'studio_open_project', arguments: { projectDir: 'studio-from-decompile', sourcePath: outSource } }] : []),
        ],
      };
    }

    const workParentDir = dirname(output ? resolve(output) : rpFile);
    mkdirSync(workParentDir, { recursive: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'zee-rp-sync-'));
    let sourceInputFile = source ? resolve(source) : null;
    if (inlineSpec) {
      sourceInputFile = join(tmpDir, 'inline-source.json');
      writeFileSync(sourceInputFile, JSON.stringify({ language: 'rp/1', target: 9, ...inlineSpec }, null, 2) + '\n');
    } else if (!sourceInputFile && baselineData?.sourcePath && pathExists(baselineData.sourcePath)) {
      sourceInputFile = baselineData.sourcePath;
    } else if (!sourceInputFile && baselineData?.sourceSpec) {
      sourceInputFile = join(tmpDir, 'baseline-source.json');
      writeFileSync(sourceInputFile, JSON.stringify(baselineData.sourceSpec, null, 2) + '\n');
    }
    if (!sourceInputFile || !pathExists(sourceInputFile)) {
      throw Object.assign(new Error('缺少 RP/1 源码（请提供 source/spec 路径、spec 对象或包含 sourcePath/sourceSpec 的基线文件）。'), { code: 'E_SOURCE_MISSING' });
    }

    let baseRpFile = rpFile;
    if (resolvedBaseRpArg && pathExists(resolve(resolvedBaseRpArg))) {
      baseRpFile = resolve(resolvedBaseRpArg);
    } else if (baselineData?.baseRpBase64) {
      baseRpFile = join(tmpDir, 'baseline.rp');
      writeFileSync(baseRpFile, Buffer.from(baselineData.baseRpBase64, 'base64'));
    } else if (activeSession?.sourceFile && pathExists(activeSession.sourceFile)) {
      baseRpFile = activeSession.sourceFile;
    }

    let baseSpecFile = sourceInputFile;
    if (baselineData?.sourceSpec) {
      baseSpecFile = join(tmpDir, 'baseline-spec.json');
      writeFileSync(baseSpecFile, JSON.stringify(baselineData.sourceSpec, null, 2) + '\n');
    } else if (baselineData?.sourcePath && pathExists(baselineData.sourcePath)) {
      baseSpecFile = baselineData.sourcePath;
    }

    const baselineMetaFile = join(tmpDir, 'baseline-meta.json');
    writeFileSync(baselineMetaFile, JSON.stringify(baselineData ?? null));

    if (mode === 'lift') {
      stage = 'lift';
      const stagedOutSource = join(tmpDir, 'lifted' + (outSource ? extname(outSource) || '.json' : '.json'));
      const reportPath = join(tmpDir, 'lift-report.json');
      const pyScript = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
from rp_decompile import lift_rp_into_spec
with open(${JSON.stringify(baselineMetaFile)}, 'r', encoding='utf-8') as f:
    bmeta = json.load(f)
res = lift_rp_into_spec(${JSON.stringify(sourceInputFile)}, ${JSON.stringify(baseRpFile)}, ${JSON.stringify(rpFile)}, baseline_meta=bmeta)
with open(${JSON.stringify(reportPath)}, 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
out_p = ${JSON.stringify(stagedOutSource)}
with open(out_p, 'w', encoding='utf-8') as f:
    if out_p.lower().endswith('.rp1'):
        f.write(res['rp1'])
    else:
        json.dump(res['spec'], f, ensure_ascii=False, indent=2)
        f.write('\\n')
`;
      const proc = spawnPythonSync(['-c', pyScript], { encoding: 'utf8' });
      if (proc.status !== 0 || !pathExists(reportPath)) {
        throw Object.assign(new Error(`lift 失败：${(proc.stderr || proc.stdout || '').trim()}`), { code: 'E_LIFT_FAILED' });
      }
      const liftRes = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (!liftRes.ok && prefer !== 'source') {
        return {
          status: 'conflict',
          mode: 'lift',
          prefer,
          rp: rpFile,
          code: 'E_UNSUPPORTED_NATIVE_CHANGES',
          unsupportedNativeChanges: liftRes.unsupportedNativeChanges ?? [],
          details: {
            status: 'unsupported_native_changes',
            unsupportedNativeChanges: liftRes.unsupportedNativeChanges ?? [],
          },
          ...(includeSpec ? { report: stripReportSpec(liftRes.report ?? liftRes) } : {}),
          message: `检测到 ${(liftRes.unsupportedNativeChanges ?? []).length} 处不可逆原生改动，已保留原文件未覆盖。`,
        };
      }
      const liftedSpec = liftRes.spec;
      let buildResult = null;
      if (output) {
        stage = 'rebuild';
        const stagedOutputRp = join(tmpDir, 'lifted-rebuild.rp');
        if (liftRes.originKind === 'image-trace-spec') {
          buildResult = generateFromImage({
            spec: liftedSpec,
            output: stagedOutputRp,
            page: baselineData?.pageName || '图片还原页',
          });
        } else {
          buildResult = generatePrototype({ spec: liftedSpec, output: stagedOutputRp });
        }
        if (buildResult.status === 'failed') {
          throw Object.assign(new Error(`lift 后编译 .rp 失败：${buildResult.message}`), { code: 'E_LIFT_REBUILD_FAILED', diagnostics: buildResult.diagnostics });
        }
        beforePublish?.();
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(stagedOutputRp, output);
        if (pathExists(`${stagedOutputRp}.baseline.json`)) {
          copyFileSync(`${stagedOutputRp}.baseline.json`, `${output}.baseline.json`);
        }
        buildResult.output = output;
      }
      if (sha256Of(rpFile) !== rpShaAtStart) {
        throw Object.assign(new Error('目标 .rp 在同步过程中被外部修改，中止提交。'), { code: 'E_CONCURRENT_MODIFICATION' });
      }
      if (outSource) {
        beforePublish?.();
        mkdirSync(dirname(outSource), { recursive: true });
        copyFileSync(stagedOutSource, outSource);
        if (buildResult?.output && pathExists(`${buildResult.output}.baseline.json`)) {
          const bMeta = JSON.parse(readFileSync(`${buildResult.output}.baseline.json`, 'utf8'));
          bMeta.outputRp = buildResult.output;
          bMeta.sourcePath = outSource;
          bMeta.sourceSha256 = sha256Of(outSource);
          writeFileSync(`${buildResult.output}.baseline.json`, JSON.stringify(bMeta, null, 2) + '\n');
        }
      }
      const liftSummary = {
        textEdits: (liftRes.liftedTextEdits ?? []).length,
        renames: (liftRes.liftedRenames ?? []).length,
        visualEdits: (liftRes.liftedVisualEdits ?? []).length,
        interactions: (liftRes.liftedInteractions ?? []).length,
        addedWidgets: (liftRes.liftedNewWidgets ?? []).length,
        deletedWidgets: (liftRes.liftedDeletedWidgets ?? []).length,
        unsupportedNativeChanges: (liftRes.unsupportedNativeChanges ?? []).length,
      };
      return {
        ok: true,
        status: 'lifted',
        mode: 'lift',
        originKind: liftRes.originKind ?? 'rp1',
        rp: rpFile,
        outSource: outSource ?? null,
        outSpec: outSource ?? null,
        output: buildResult?.output ?? null,
        summary: liftSummary,
        ...(includeSpec ? {
          spec: liftedSpec,
          rp1Spec: liftRes.rp1Spec ?? liftedSpec,
          rp1: liftRes.rp1 ?? null,
          report: stripReportSpec(liftRes.report ?? liftRes),
        } : {}),
        liftedTextEdits: liftRes.liftedTextEdits ?? [],
        liftedRenames: liftRes.liftedRenames ?? [],
        liftedVisualEdits: liftRes.liftedVisualEdits ?? [],
        liftedInteractions: liftRes.liftedInteractions ?? [],
        addedWidgets: liftRes.liftedNewWidgets ?? [],
        deletedWidgets: liftRes.liftedDeletedWidgets ?? [],
        unsupportedNativeChanges: liftRes.unsupportedNativeChanges ?? [],
        syncStatus: computeSyncStatus(buildResult?.output ?? rpFile, outSource ?? sourceInputFile, baseRpArg),
      };
    }

    if (mode === 'rebuild') {
      stage = 'rebuild';
      if (statusInfo.nativeChanged && prefer === 'fail') {
        return {
          status: 'conflict',
          mode: 'rebuild',
          code: 'E_NATIVE_DRIFT_PROTECTED',
          message: '检测到原生 .rp 存在未同步改稿，拒绝在 prefer=fail 下直接重建覆盖；请使用 mode=merge 或显式指定 prefer=source。',
          syncStatus: statusInfo,
        };
      }
      const targetOutput = output ?? (rpInput ? resolve(rpInput) : statusInfo.rpFile);
      if (!targetOutput) throw Object.assign(new Error('rebuild 模式必须提供 output (.rp) 路径或已指定 rp。'), { code: 'E_OUTPUT_REQUIRED' });
      const specObj = inlineSpec ?? loadSpecObjectFromSource(sourceInputFile);
      const stagedRebuildRp = join(tmpDir, 'rebuilt.rp');
      const genRes = generatePrototype({ spec: specObj, output: stagedRebuildRp });
      if (genRes.status === 'failed') {
        return genRes;
      }
      beforePublish?.();
      mkdirSync(dirname(targetOutput), { recursive: true });
      copyFileSync(stagedRebuildRp, targetOutput);
      if (pathExists(`${stagedRebuildRp}.baseline.json`)) {
        const bMeta = JSON.parse(readFileSync(`${stagedRebuildRp}.baseline.json`, 'utf8'));
        bMeta.outputRp = targetOutput;
        bMeta.rpSha256 = sha256Of(targetOutput);
        bMeta.sourcePath = sourceInputFile;
        bMeta.sourceSha256 = pathExists(sourceInputFile) ? sha256Of(sourceInputFile) : null;
        writeFileSync(`${targetOutput}.baseline.json`, JSON.stringify(bMeta, null, 2) + '\n');
      }
      if (session && session.sourceFile === targetOutput) {
        openSession(targetOutput);
      }
      return {
        ...genRes,
        ok: true,
        status: 'rebuilt',
        mode: 'rebuild',
        output: targetOutput,
        sha256: sha256Of(targetOutput),
        baseline: pathExists(`${targetOutput}.baseline.json`) ? `${targetOutput}.baseline.json` : null,
        syncStatus: computeSyncStatus(targetOutput, sourceInputFile, baseRpArg),
      };
    }

    // mode === 'merge'
    stage = 'merge';
    const stagedOutSource = join(tmpDir, 'merged' + (outSource ? extname(outSource) || '.json' : '.json'));
    const stagedOutRp = output ? join(tmpDir, 'merged.rp') : null;
    const reportPath = join(tmpDir, 'merge-report.json');
    const resPath = join(tmpDir, 'resolutions.json');
    writeFileSync(resPath, JSON.stringify(resolutions ?? {}));
    const pyMerge = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
from rp_decompile import three_way_merge_rp
with open(${JSON.stringify(baselineMetaFile)}, 'r', encoding='utf-8') as f:
    bmeta = json.load(f)
with open(${JSON.stringify(resPath)}, 'r', encoding='utf-8') as f:
    res_map = json.load(f)
res = three_way_merge_rp(
    base_spec_path=${JSON.stringify(baseSpecFile)},
    base_rp_path=${JSON.stringify(baseRpFile)},
    edited_rp_path=${JSON.stringify(rpFile)},
    new_spec_path=${JSON.stringify(sourceInputFile)},
    out_spec_path=${stagedOutSource ? JSON.stringify(stagedOutSource) : 'None'},
    out_rp_path=${stagedOutRp ? JSON.stringify(stagedOutRp) : 'None'},
    prefer=${JSON.stringify(prefer)},
    baseline_meta=bmeta,
    resolutions=res_map,
)
with open(${JSON.stringify(reportPath)}, 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
sys.exit(0 if res.get('ok') else 2)
`;
    const proc = spawnPythonSync(['-c', pyMerge], { encoding: 'utf8' });
    const report = pathExists(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    if (proc.status === 2 || (report && !report.ok)) {
      if (report?.status === 'layout_gate_failed' || report?.code === 'E_MERGE_LAYOUT_GATE') {
        const compactAudit = report.audit
          ? { ok: Boolean(report.audit.ok), structural_ok: Boolean(report.audit.structural_ok), aesthetic_ok: Boolean(report.audit.aesthetic_ok), failures: report.audit.failures ?? [] }
          : null;
        return {
          ok: false,
          status: 'failed',
          stage: 'layout_audit',
          code: 'E_MERGE_LAYOUT_GATE',
          mode: 'merge',
          prefer,
          rp: rpFile,
          source: sourceInputFile,
          message: report.message || '合并后原型未通过布局审计门禁。',
          audit: compactAudit,
          diagnostics: report.diagnostics ?? [{ code: 'E_MERGE_LAYOUT_GATE', pointer: '/', message: report.message || '合并后原型未通过布局审计门禁。' }],
          ...(includeSpec ? { report: stripReportSpec(report) } : {}),
        };
      }
      const hasConflicts = (report?.conflicts?.length ?? 0) > 0;
      const compactedDeltas = compactSourceDeltas(report?.sourceDeltas, includeSpec);
      return {
        ok: false,
        status: 'conflict',
        code: hasConflicts ? 'E_SYNC_CONFLICT' : 'E_UNSUPPORTED_NATIVE_CHANGES',
        mode: 'merge',
        prefer,
        rp: rpFile,
        source: sourceInputFile,
        conflicts: report?.conflicts ?? [],
        unsupportedNativeChanges: report?.unsupportedNativeChanges ?? [],
        sourceDeltas: compactedDeltas,
        details: {
          status: report?.status || (hasConflicts ? 'conflict' : 'unsupported_native_changes'),
          conflicts: report?.conflicts ?? [],
          unsupportedNativeChanges: report?.unsupportedNativeChanges ?? [],
          sourceDeltas: compactedDeltas,
        },
        ...(includeSpec ? { report: stripReportSpec(report) } : {}),
        message: report?.message || (hasConflicts
          ? `检测到 ${report.conflicts.length} 处源码与原生同属性冲突，已保留原文件未覆盖。`
          : `检测到 ${(report?.unsupportedNativeChanges ?? []).length} 处不可逆原生改动，已保留原文件未覆盖。`),
      };
    }
    if (proc.status !== 0 || !report) {
      throw Object.assign(new Error(`三方合并失败：${(proc.stderr || proc.stdout || '').trim()}`), { code: 'E_MERGE_FAILED' });
    }
    if (sha256Of(rpFile) !== rpShaAtStart) {
      throw Object.assign(new Error('目标 .rp 在合并过程中被外部修改，拒绝提交。'), { code: 'E_CONCURRENT_MODIFICATION' });
    }
    let structure = null;
    if (stagedOutRp && output) {
      stage = 'structure';
      const parsedRp = readRp(readFileSync(stagedOutRp), { path: output });
      structure = zerosOf(parsedRp);
      if (Object.values(structure).some(Boolean)) {
        throw Object.assign(new Error(`合并生成的 .rp 结构检查未通过：${JSON.stringify(structure)}`), { code: 'E_MERGE_STRUCTURE' });
      }
      beforePublish?.();
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(stagedOutRp, output);
    }
    if (outSource) {
      beforePublish?.();
      mkdirSync(dirname(outSource), { recursive: true });
      copyFileSync(stagedOutSource, outSource);
    }
    if (stagedOutRp && output) {
      const stagedBaseline = `${stagedOutRp}.baseline.json`;
      if (pathExists(stagedBaseline)) {
        const baseMeta = JSON.parse(readFileSync(stagedBaseline, 'utf8'));
        baseMeta.outputRp = output;
        baseMeta.rpSha256 = sha256Of(output);
        const effectiveSrc = outSource ?? sourceInputFile;
        baseMeta.sourcePath = effectiveSrc;
        baseMeta.sourceSha256 = pathExists(effectiveSrc) ? sha256Of(effectiveSrc) : null;
        if (report.spec) baseMeta.sourceSpec = report.spec;
        writeFileSync(`${output}.baseline.json`, JSON.stringify(baseMeta, null, 2) + '\n');
      }
      if (session && session.sourceFile === output) {
        openSession(output);
      }
    }
    const mergedSpec = report.spec ?? null;
    const mergeSummary = {
      conflicts: (report.conflicts ?? []).length,
      resolvedConflicts: (report.resolvedConflicts ?? []).length,
      preservedTextEdits: (report.preservedTextEdits ?? []).length,
      preservedVisualEdits: (report.preservedVisualEdits ?? []).length,
      preservedRenames: (report.preservedRenames ?? []).length,
      preservedInteractions: (report.preservedInteractions ?? []).length,
      addedWidgets: (report.addedWidgets ?? []).length,
      deletedWidgets: (report.deletedWidgets ?? []).length,
      componentInstanceChanges: (report.componentInstanceChanges ?? []).length,
      sourceDeltas: Object.keys(report.sourceDeltas ?? {}).length,
      unsupportedNativeChanges: (report.unsupportedNativeChanges ?? []).length,
    };
    return {
      ok: true,
      status: 'merged',
      mode: 'merge',
      prefer,
      rp: rpFile,
      output: output ?? null,
      outRp: output ?? null,
      sha256: output && pathExists(output) ? sha256Of(output) : null,
      baseline: output && pathExists(`${output}.baseline.json`) ? `${output}.baseline.json` : baselinePath,
      outSource: outSource ?? null,
      outSpec: outSource ?? null,
      summary: mergeSummary,
      ...(includeSpec ? {
        spec: mergedSpec,
        rp1: report.rp1 ?? null,
        report: stripReportSpec(report),
      } : {}),
      structure,
      conflicts: report.conflicts ?? [],
      resolvedConflicts: report.resolvedConflicts ?? [],
      unsupportedNativeChanges: report.unsupportedNativeChanges ?? [],
      preservedTextEdits: report.preservedTextEdits ?? [],
      preservedVisualEdits: report.preservedVisualEdits ?? [],
      preservedRenames: report.preservedRenames ?? [],
      preservedInteractions: report.preservedInteractions ?? [],
      addedWidgets: report.addedWidgets ?? [],
      deletedWidgets: report.deletedWidgets ?? [],
      componentInstanceChanges: report.componentInstanceChanges ?? [],
      sourceDeltas: compactSourceDeltas(report.sourceDeltas, includeSpec),
      syncStatus: computeSyncStatus(output ?? rpFile, outSource ?? sourceInputFile, baseRpArg),
    };
  } catch (error) {
    return {
      status: 'failed',
      mode,
      stage,
      code: error.code ?? `E_SYNC_${stage.toUpperCase()}`,
      message: error.message,
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      ...(error.nextAction ? { nextAction: error.nextAction } : {}),
    };
  } finally {
    if (tmpDir && pathExists(tmpDir)) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    for (const unlock of unlocks.reverse()) unlock();
  }
}

function validateFromImageRp1Out(output, outSourceRaw, emitRp1, explicitWorkDir) {
  const rp1Out = outSourceRaw !== undefined
    ? resolveInWork(outSourceRaw, explicitWorkDir)
    : (emitRp1 ? output.replace(/\.rp$/i, '.rp1') : null);
  if (rp1Out) {
    assertNotProtected(rp1Out);
    assertWritable(rp1Out);
    if (pathExists(rp1Out)) {
      throw Object.assign(new Error(`输出 .rp1 源码已存在，禁止覆盖：${rp1Out}`), { code: 'E_OUTPUT_EXISTS' });
    }
  }
  return rp1Out;
}

function captureMacOsAxureWindow(stagedRp, autoCapPath) {
  if (process.platform !== 'darwin') return null;
  const swiftCap = `
import AppKit
import ApplicationServices
let rp = CommandLine.arguments[1]
let outPng = CommandLine.arguments[2]
let title = URL(fileURLWithPath: rp).deletingPathExtension().lastPathComponent
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
p.arguments = ["-b", "com.axure.AxureRP9", rp]
try p.run(); p.waitUntilExit()
var winId: Int? = nil
for _ in 0..<40 {
    Thread.sleep(forTimeInterval: 0.25)
    let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    for w in all {
        let owner = w[kCGWindowOwnerName as String] as? String ?? ""
        let name = w[kCGWindowName as String] as? String ?? ""
        if owner == "Axure RP 9" && name.contains(title) {
            winId = w[kCGWindowNumber as String] as? Int
            break
        }
    }
    if winId != nil { break }
}
Thread.sleep(forTimeInterval: 0.7)
if let wid = winId {
    let cap = Process()
    cap.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    cap.arguments = ["-x", "-l", String(wid), outPng]
    try cap.run(); cap.waitUntilExit()
}
if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.axure.AxureRP9" }) {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &v) == .success, let wins = v as? [AXUIElement] {
        for w in wins {
            var tv: CFTypeRef?
            let wTitle = (AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &tv) == .success ? (tv as? String) : nil) ?? ""
            if wTitle.contains(title) {
                var cb: CFTypeRef?
                if AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &cb) == .success, let btn = cb {
                    AXUIElementPerformAction(btn as! AXUIElement, kAXPressAction as CFString)
                }
            }
        }
    }
}
`;
  spawnSync('/usr/bin/swift', ['-e', swiftCap, stagedRp, autoCapPath], { encoding: 'utf8' });
  return pathExists(autoCapPath) ? autoCapPath : null;
}

function decompileRpFileToDsl(rpFilePath) {
  const decomp = spawnPythonSync(['-B', '-c', `
import sys
sys.path.insert(0, sys.argv[1])
from rp_decompile import decompile_rp
res = decompile_rp(sys.argv[2])
sys.stdout.write(res['dsl'])
`, SCRIPTS_DIR, rpFilePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (decomp.status !== 0) {
    throw Object.assign(new Error(`生成 .rp1 源码失败：${decomp.stderr || decomp.stdout || decomp.error?.message}`), { code: 'E_RP1_EMIT_FAILED' });
  }
  return decomp.stdout;
}

function finalizeFromImageBuild(ctx, { previewImgPath, previewCaptureMode = null, previewFallbackReason = null, overrideRp1Text = null, autoFixReport = null }) {
  const {
    stagedRp, stagedBlank, output, rp1Out, page, effectiveScale, refSource,
    traceSpec, rp9Spec, rp9Meta, structureReview, structureReviewPath,
    structure, artifactDir, assetsDir, specPath, rp9SpecPath, axvgPath, rp9AxvgPath, rp, reviewedAnomalies,
  } = ctx;
  let stage = 'verify_diff';
  let visualDiff = null;
  if (refSource && pathExists(refSource)) {
    const verifyArgs = [TRACE_PY, 'verify', specPath, '--source', refSource, '-o', artifactDir, '--scale', String(traceSpec.scale ?? effectiveScale)];
    if (previewImgPath) verifyArgs.push('--preview', previewImgPath);
    if (previewImgPath && reviewedAnomalies) verifyArgs.push('--exempt-host-anomalies', JSON.stringify(reviewedAnomalies));
    const verifyProc = spawnPythonSync(verifyArgs, { encoding: 'utf8' });
    const verifyReportPath = join(artifactDir, 'diff-report.json');
    if (pathExists(verifyReportPath)) {
      visualDiff = JSON.parse(readFileSync(verifyReportPath, 'utf8'));
    } else if (verifyProc.stdout) {
      try { visualDiff = JSON.parse(procStdoutJson(verifyProc.stdout)); } catch {}
    }
  }

  stage = 'output';
  let writtenRp1Source = null;
  if (rp1Out) {
    const rp1Text = overrideRp1Text ?? decompileRpFileToDsl(stagedRp);
    mkdirSync(dirname(rp1Out), { recursive: true });
    writeFileSync(rp1Out, '# [静态重建声明] 本文件来自截图。视觉图层可编辑，原始交互需另行声明。\n' + rp1Text, { encoding: 'utf8', flag: 'wx' });
    writtenRp1Source = rp1Out;
  }

  const outSha256 = sha256Of(stagedRp);
  const nativeWidgets = [...(rp.pages[0]?.widgets ?? []), ...(rp.containedWidgets ?? [])];
  const childrenItems = rp9Spec.frames?.[0]?.children ?? [];
  const sourceMap = childrenItems.map((it, idx) => {
    const itemName = it.name || it.content || `${it.kind}-${idx + 1}`;
    const matchedNative = nativeWidgets.find(nw => nw.name === itemName || (it.content && nw.text === it.content));
    return {
      id: it.id ?? `img_item_${idx + 1}`,
      name: itemName,
      kind: it.kind,
      pageId: 'page_1',
      pageName: rp.pages[0]?.name ?? page,
      pointer: `/frames/0/children/${idx}`,
      native: matchedNative ? [{ record: matchedNative.record ?? rp.pages[0]?.record, id: matchedNative.id }] : [],
    };
  });
  const baselinePath = `${output}.baseline.json`;
  const baselinePayload = {
    schemaVersion: 'rp1-baseline/1',
    originKind: 'image-trace-spec',
    createdAt: new Date().toISOString(),
    imagePath: refSource,
    sourcePath: specPath,
    sourceSha256: sha256Of(specPath),
    ...(writtenRp1Source ? { rp1Source: writtenRp1Source } : {}),
    rp9SpecPath,
    axvgPath,
    assetsDir,
    savedAssets: rp9Meta.savedAssets ?? [],
    outputRp: output,
    rpSha256: outSha256,
    ...(reviewedAnomalies ? { exemptHostAnomalies: reviewedAnomalies } : {}),
    scale: traceSpec.scale ?? effectiveScale,
    version: 9,
    pageName: rp.pages[0]?.name ?? page,
    sourceMap,
    reviewRegions: rp9Meta.reviewRegions ?? {},
  };
  const publishedAssets = prototypeAssetsDir(output);
  const published = [];
  try {
    copyFileSync(stagedRp, output, constants.COPYFILE_EXCL);
    published.push(output);
    writeFileSync(baselinePath, JSON.stringify(relocateArtifactValue(baselinePayload, artifactDir, publishedAssets), null, 2) + '\n', { flag: 'wx' });
    published.push(baselinePath);
    unlinkSync(stagedBlank);
    unlinkSync(stagedRp);
    publishBuildDirectory(artifactDir, publishedAssets);
  } catch (error) {
    for (const path of published) rmSync(path, { force: true });
    if (writtenRp1Source) rmSync(writtenRp1Source, { force: true });
    throw error;
  }

  return relocateArtifactValue({
    status: 'completed',
    backend: 'rp9-native-scene',
    interactionNotice: {
      mode: 'static-visual-reconstruction', interactionsRestored: 0,
      message: '截图已重建为可编辑视觉图层。可用 revise_prototype 或 studio_command 声明交互。',
    },
    version: 9,
    output,
    sha256: outSha256,
    baseline: baselinePath,
    ...(writtenRp1Source ? { rp1Source: writtenRp1Source } : {}),
    page: { name: rp.pages[0]?.name ?? page, record: rp.pages[0]?.record ?? 2, written: rp.counts.widgets },
    counts: rp.counts,
    widgetCounts: rp9Meta.widgetCounts ?? {},
    structureReview: { ...structureReview.summary, report: structureReviewPath, evidence: structureReview.evidence, nativeHierarchyChanged: false },
    reviewRegions: rp9Meta.reviewRegions ?? {},
    structure,
    ...(previewCaptureMode ? { previewCaptureMode } : {}),
    ...(previewFallbackReason ? { previewFallbackReason } : {}),
    ...(autoFixReport ? { autoFix: autoFixReport } : {}),
    visualDiff: visualDiff ? {
      comparisonSource: previewImgPath ? 'axure-preview-and-thin-page' : 'thin-page-render',
      alignmentMode: previewImgPath ? 'auto_locate_canvas_1to1' : 'logical_1to1',
      ...visualDiff,
    } : null,
    artifacts: {
      directory: artifactDir,
      assetsDir,
      savedAssets: rp9Meta.savedAssets ?? [],
      image: refSource,
      spec: specPath,
      rp9Spec: rp9SpecPath,
      axvg: axvgPath,
      rp9Axvg: rp9AxvgPath,
      ...(writtenRp1Source ? { rp1Source: writtenRp1Source } : {}),
      baseline: baselinePath,
      diffImage: visualDiff?.outputs?.compareAndDiff ?? null,
      hostCompareImage: visualDiff?.outputs?.axurePreviewCompare ?? null,
    },
    verification: {
      recognized: true,
      structure: true,
      axureOpened: Boolean(previewCaptureMode === 'axure-gui-window-fallback'),
      officialHtmlHeadless: Boolean(previewCaptureMode === 'axure-official-html-headless'),
      guiEdited: false,
      saveReopened: false,
      preview: Boolean(previewImgPath),
    },
  }, artifactDir, publishedAssets);
}

function generateFromImageFailure(error, stage, output) {
  const failure = {
    status: 'failed',
    stage,
    code: error.code ?? `E_IMAGE_${stage.toUpperCase()}`,
    message: error.message,
    ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
  };
  if (output) {
    const directory = prototypeAssetsDir(output);
    const path = join(directory, 'last-failure.json');
    try {
      assertWritable(path);
      assertNotProtected(path);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, JSON.stringify(failure, null, 2) + '\n');
      failure.artifacts = { directory, report: path };
    } catch { /* Return the same diagnostics when the report cannot be written. */ }
  }
  return failure;
}

function prepareFromImageBuild({
  image: imageArg,
  spec: specArg,
  output: requestedOutputRaw,
  cwd,
  projectDir,
  version = 9,
  scale,
  page = '图片还原页',
  replace = [],
  baseRp,
  prefer = 'fail',
  preview = false,
  guiPaste = false,
  emitRp1 = false,
  outSource: outSourceRaw,
}) {
  let stage = 'validation', artifactDir, output, unlock;
  let reviewedAnomalies;
  try {
    const explicitWorkDir = cwd ?? projectDir;
    const requestedOutput = resolveInWork(requestedOutputRaw, explicitWorkDir);
    if (typeof requestedOutput !== 'string' || !requestedOutput.trim() || extname(requestedOutput).toLowerCase() !== '.rp') {
      throw Object.assign(new Error('output 必须是新的 .rp 路径。'), { code: 'E_OUTPUT_PATH' });
    }
    assertNotProtected(requestedOutput);
    assertWritable(requestedOutput);
    if (pathExists(requestedOutput)) {
      throw Object.assign(new Error(`输出 .rp 已存在，请使用新文件名：${requestedOutput}`), { code: 'E_OUTPUT_EXISTS' });
    }
    const rp1Out = validateFromImageRp1Out(requestedOutput, outSourceRaw, emitRp1, explicitWorkDir);
    if (!imageArg && !specArg) {
      throw Object.assign(new Error('必须提供本地图片路径 image 或已有分层 spec。'), { code: 'E_INPUT_REQUIRED' });
    }
    const imagePath = imageArg ? resolveInWork(imageArg, explicitWorkDir) : null;
    if (imagePath && !pathExists(imagePath)) {
      throw Object.assign(new Error(`本地图片不存在：${imagePath}`), { code: 'E_IMAGE_NOT_FOUND' });
    }
    if (version !== 9 && version !== 11) {
      throw Object.assign(new Error(`不支持的目标 Axure 版本：${version}（仅支持 9 或 11）。`), { code: 'E_UNSUPPORTED_VERSION' });
    }
    const python = pythonEnvironment();
    if (python.missingImageDependencies.length) {
      const message = `当前 Python ${python.executable ?? '(不可用)'} 缺少图片依赖：${python.missingImageDependencies.join('、')}。`;
      throw Object.assign(new Error(message), { code: 'E_IMAGE_DEPENDENCY', diagnostics: [{ code: 'E_IMAGE_DEPENDENCY',
        pointer: '/environment/python', message, actual: python,
        nextAction: '在已安装 requirements.txt 依赖的 Python 环境中启动 MCP，然后用 runtime_info 核对实际解释器。' }] });
    }
    if (baseRp !== undefined) {
      const resolvedBaseRp = resolveInWork(baseRp, explicitWorkDir);
      if (!pathExists(resolvedBaseRp)) {
        throw Object.assign(new Error(`baseRp 不存在：${resolvedBaseRp}`), { code: 'E_BASE_RP_NOT_FOUND' });
      }
      const drift = computeSyncStatus(resolvedBaseRp);
      if (drift.nativeChanged && prefer === 'fail') {
        return {
          done: {
            status: 'conflict',
            stage: 'drift_check',
            code: 'E_NATIVE_DRIFT_PROTECTED',
            message: '目标 baseRp 存在未合并的原生改稿，拒绝在 prefer=fail 下重建覆盖；请先处理改稿或指定 prefer=source。',
            baseRp: resolvedBaseRp,
            syncStatus: drift,
          },
        };
      }
      if (drift.baselinePath) reviewedAnomalies = JSON.parse(readFileSync(drift.baselinePath, 'utf8')).exemptHostAnomalies;
    }

    mkdirSync(dirname(requestedOutput), { recursive: true });
    output = writablePath(requestedOutput);
    unlock = acquireOutputLock(output);
    artifactDir = mkdtempSync(join(tmpdir(), 'zee-image-'));
    const assetsDir = join(artifactDir, 'images');
    mkdirSync(assetsDir, { recursive: true });
    const specPath = join(artifactDir, 'trace.spec.json');
    const axvgPath = join(artifactDir, 'trace.axvg.json');
    const rp9SpecPath = join(artifactDir, 'trace.rp9.spec.json');

    stage = 'recognize';
    const effectiveScale = scale ?? 2;
    if (specArg) {
      if (typeof specArg === 'string') {
        const resolvedSpec = resolveInWork(specArg, explicitWorkDir);
        if (!pathExists(resolvedSpec)) throw Object.assign(new Error(`spec 文件不存在：${resolvedSpec}`), { code: 'E_SPEC_NOT_FOUND' });
        copyFileSync(resolvedSpec, specPath);
      } else {
        writeFileSync(specPath, JSON.stringify(specArg, null, 2) + '\n');
      }
      if (replace.length > 0) {
        const patchArgs = [TRACE_PY, 'patch', specPath, '-o', specPath];
        for (const r of replace) {
          if (typeof r === 'string') patchArgs.push('--replace', r);
          else if (r && typeof r.old === 'string' && typeof r.new === 'string') patchArgs.push('--replace', `${r.old}=${r.new}`);
        }
        const patchProc = spawnPythonSync(patchArgs, { encoding: 'utf8' });
        if (patchProc.status !== 0) {
          throw Object.assign(new Error(`OCR 文案替换失败：${(patchProc.stderr || patchProc.stdout || '').trim()}`), { code: 'E_TRACE_PATCH' });
        }
      }
      const curSpec = JSON.parse(readFileSync(specPath, 'utf8'));
      const refForCrop = imagePath || (curSpec.reference && pathExists(curSpec.reference) ? curSpec.reference : null);
      const hasUncropped = (curSpec.frames ?? []).some(f => (f.children ?? []).some(c => c.kind === 'image' && c.crop && !c.imageKey));
      if (hasUncropped && refForCrop) {
        const cropProc = spawnPythonSync([TRACE_PY, 'crop', specPath, '--source', refForCrop, '-o', specPath, '--scale', String(curSpec.scale ?? effectiveScale)], { encoding: 'utf8' });
        if (cropProc.status !== 0) {
          throw Object.assign(new Error(`图片局部媒体裁切失败：${(cropProc.stderr || cropProc.stdout || '').trim()}`), { code: 'E_TRACE_CROP' });
        }
      }
    } else {
      const draftArgs = [TRACE_PY, 'draft', imagePath, '-o', artifactDir, '--spec', specPath, '--scale', String(effectiveScale)];
      for (const r of replace) {
        if (typeof r === 'string') draftArgs.push('--replace', r);
        else if (r && typeof r.old === 'string' && typeof r.new === 'string') draftArgs.push('--replace', `${r.old}=${r.new}`);
      }
      const draftProc = spawnPythonSync(draftArgs, { encoding: 'utf8' });
      if (draftProc.status !== 0 || !pathExists(specPath)) {
        throw Object.assign(new Error(`图片识别与分层提取失败：${(draftProc.stderr || draftProc.stdout || '').trim()}`), { code: 'E_TRACE_DRAFT' });
      }
    }

    const traceSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    const structureReview = reviewImageStructure({ spec: traceSpec, limit: 100 });
    const structureReviewPath = join(artifactDir, 'structure-review.json');
    writeFileSync(structureReviewPath, JSON.stringify(structureReview, null, 2) + '\n');
    if (imagePath && !traceSpec.reference) traceSpec.reference = imagePath;
    if (scale !== undefined) traceSpec.scale = scale;
    if (traceSpec.frames?.[0] && page) traceSpec.frames[0].name = `${page}-画板`;
    writeFileSync(specPath, JSON.stringify(traceSpec, null, 2) + '\n');

    stage = 'axvg';
    const axvgPayload = expandSpec(traceSpec);
    writeFileSync(axvgPath, JSON.stringify(axvgPayload, null, 2) + '\n');

    if (version === 11) {
      stage = 'rp11_paste';
      const finish = result => {
        publishBuildDirectory(artifactDir, prototypeAssetsDir(output));
        rmSync(artifactDir, { recursive: true, force: true });
        unlock();
        return { done: relocateArtifactValue(result, artifactDir, prototypeAssetsDir(output)) };
      };
      if (!guiPaste) {
        return finish({
            status: 'failed',
            stage,
            code: 'E_RP11_GUI_PASTE_REQUIRED',
            message: 'RP11 原生格式使用 SQLite 单库，不支持离线直接写出二进制 .rp；已在 artifacts 中生成 RP11 专用 .axvg.json 与分层 spec，请在 Axure RP 11 打开目标工程后设置 guiPaste=true 或调用 rp_command({ command: "axvg paste", ... }) 放置。',
            version: 11,
            artifacts: { directory: artifactDir, assetsDir, image: imagePath, spec: specPath, axvg: axvgPath },
        });
      }
      const pasteResult = pasteAxvg(axvgPayload, { version: 11 });
      return finish({
          status: 'completed',
          backend: 'rp11-axvg-gui-paste',
          version: 11,
          pasteResult,
          artifacts: { directory: artifactDir, assetsDir, image: imagePath, spec: specPath, axvg: axvgPath },
          verification: { recognized: true, structure: false, axureOpened: true, guiEdited: false, saveReopened: false, preview: false },
      });
    }

    stage = 'rp9_spec';
    const rp9Proc = spawnPythonSync([TRACE_PY, 'rp9-spec', specPath, '-o', rp9SpecPath, '--assets-dir', assetsDir], { encoding: 'utf8' });
    if (rp9Proc.status !== 0 || !pathExists(rp9SpecPath)) {
      throw Object.assign(new Error(`转换 RP9 原生场景规格失败：${(rp9Proc.stderr || rp9Proc.stdout || '').trim()}`), { code: 'E_RP9_SPEC' });
    }
    const rp9Meta = JSON.parse(procStdoutJson(rp9Proc.stdout) || '{}');
    const rp9Spec = JSON.parse(readFileSync(rp9SpecPath, 'utf8'));
    const rp9Axvg = expandSpec(rp9Spec);
    const rp9AxvgPath = join(artifactDir, 'trace.rp9.axvg.json');
    writeFileSync(rp9AxvgPath, JSON.stringify(rp9Axvg, null, 2) + '\n');

    stage = 'native_write';
    const stagedBlank = join(artifactDir, 'blank.rp');
    const stagedRp = join(artifactDir, 'output.rp');
    createBlankProject(stagedBlank, { version: 9 });
    const sceneBytes = writeNativeScene(readFileSync(stagedBlank), rp9Axvg);
    const writtenBytes = mergePages([{ buf: sceneBytes, name: page || '图片还原页' }]);
    writeFileSync(stagedRp, writtenBytes);

    stage = 'structure';
    const rp = readRp(readFileSync(stagedRp), { path: output });
    const structure = zerosOf(rp);
    if (Object.values(structure).some(Boolean)) {
      throw Object.assign(new Error(`生成的二进制 .rp 结构检查未通过：${JSON.stringify(structure)}`), { code: 'E_STRUCTURE_FAILED' });
    }

    const refSource = imagePath || (traceSpec.reference && pathExists(traceSpec.reference) ? traceSpec.reference : null);
    const resolvedPreview = typeof preview === 'string' ? resolveInWork(preview, explicitWorkDir) : null;
    const previewImgPath = resolvedPreview && pathExists(resolvedPreview) ? resolvedPreview : null;
    return {
      ctx: {
        stagedRp, stagedBlank, output, rp1Out, page, effectiveScale, refSource, previewImgPath,
        traceSpec, rp9Spec, rp9Meta, structureReview, structureReviewPath,
        structure, artifactDir, assetsDir, specPath, rp9SpecPath, axvgPath, rp9AxvgPath, rp, unlock, reviewedAnomalies,
      },
    };
  } catch (error) {
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    unlock?.();
    return { done: generateFromImageFailure(error, stage, artifactDir ? output : null) };
  }
}

function generateFromImage(options = {}) {
  const prep = prepareFromImageBuild(options);
  if (prep.done) return prep.done;
  try {
    let previewImgPath = prep.ctx.previewImgPath;
    let previewCaptureMode = previewImgPath ? 'explicit-preview-file' : null;
    if (!previewImgPath && options.preview === true && process.platform === 'darwin') {
      previewImgPath = captureMacOsAxureWindow(prep.ctx.stagedRp, join(prep.ctx.artifactDir, 'host-window-capture.png'));
      if (previewImgPath) previewCaptureMode = 'axure-gui-window-fallback';
    }
    return finalizeFromImageBuild(prep.ctx, { previewImgPath, previewCaptureMode });
  } catch (error) {
    return generateFromImageFailure(error, 'output', prep.ctx.output);
  } finally {
    rmSync(prep.ctx.artifactDir, { recursive: true, force: true });
    prep.ctx.unlock();
  }
}

async function generateFromImageAsync(options = {}) {
  const prep = prepareFromImageBuild(options);
  if (prep.done) return prep.done;
  try {
    let autoFixReport = null;
    let overrideRp1Text = null;
    if (options.autoFix === true && prep.ctx.stagedRp) {
      try {
        const initialRp1 = decompileRpFileToDsl(prep.ctx.stagedRp);
        const fixRes = await runStudioFixPlanOnRp1({
          rp1: initialRp1,
          projectDir: join(prep.ctx.artifactDir, 'autofix-studio'),
        });
        autoFixReport = {
          attempted: true,
          applied: fixRes.applied,
          appliedCount: fixRes.appliedCount,
          skippedEmpty: fixRes.skippedEmpty,
          beforeBlockers: fixRes.beforeBlockers,
          afterBlockers: fixRes.afterBlockers,
          remainingManualCount: fixRes.remainingManualCount,
        };
        if (fixRes.applied && fixRes.appliedCount > 0 && fixRes.rp1Text) {
          const healedRpPath = join(prep.ctx.artifactDir, 'autofix-healed.rp');
          const rebuilt = generatePrototype({ rp1: fixRes.rp1Text, output: healedRpPath, cwd: prep.ctx.artifactDir });
          if (rebuilt?.status === 'completed' && pathExists(healedRpPath)) {
            copyFileSync(healedRpPath, prep.ctx.stagedRp);
            prep.ctx.rp = readRp(readFileSync(prep.ctx.stagedRp), { path: prep.ctx.output });
            prep.ctx.structure = zerosOf(prep.ctx.rp);
            overrideRp1Text = fixRes.rp1Text;
            autoFixReport.recompiledRp = true;
          } else {
            autoFixReport.recompiledRp = false;
            autoFixReport.compileWarning = rebuilt?.diagnostics?.[0]?.message || rebuilt?.message || '自愈后重编 .rp 未完成，已保留原可编辑 .rp';
          }
        }
      } catch (err) {
        autoFixReport = { attempted: true, applied: false, appliedCount: 0, error: err.message };
      }
    }

    let previewImgPath = prep.ctx.previewImgPath;
    let previewCaptureMode = previewImgPath ? 'explicit-preview-file' : null;
    let previewFallbackReason = null;
    if (!previewImgPath && options.preview === true) {
      const htmlDir = join(prep.ctx.artifactDir, 'official-html');
      const autoCapPath = join(prep.ctx.artifactDir, 'headless-official-preview.png');
      const exp = await exportPrototype({ rp: prep.ctx.stagedRp, output: htmlDir, cwd: prep.ctx.artifactDir });
      if (exp.status === 'completed') {
        try {
          const frame0 = prep.ctx.traceSpec?.frames?.[0];
          const vp = frame0?.w && frame0?.h ? { width: Math.round(frame0.w), height: Math.round(frame0.h), dpr: 1 } : undefined;
          await captureOfficialHtmlScreenshot({ htmlDir: exp.output, outPng: autoCapPath,
            viewport: vp, pageName: prep.ctx.rp.pages[0]?.name });
          if (pathExists(autoCapPath)) {
            previewImgPath = autoCapPath;
            previewCaptureMode = 'axure-official-html-headless';
          }
        } catch (err) {
          previewFallbackReason = err.message;
        }
      } else {
        previewFallbackReason = exp.diagnostics?.[0]?.message || 'official html export unavailable';
      }
      if (!previewImgPath && process.platform === 'darwin') {
        previewImgPath = captureMacOsAxureWindow(prep.ctx.stagedRp, join(prep.ctx.artifactDir, 'host-window-capture.png'));
        if (previewImgPath) previewCaptureMode = 'axure-gui-window-fallback';
      }
    }
    const result = finalizeFromImageBuild(prep.ctx, { previewImgPath, previewCaptureMode, previewFallbackReason, overrideRp1Text, autoFixReport });
    if (result.status === 'completed' && Array.isArray(options.verify) && options.verify.length > 0) {
      let verifySourcePath = result.rp1Source || null;
      if (!verifySourcePath) {
        const tempVerifyRp1 = join(prep.ctx.artifactDir, 'verify-source.rp1');
        writeFileSync(tempVerifyRp1, overrideRp1Text ?? decompileRpFileToDsl(result.output), 'utf8');
        verifySourcePath = tempVerifyRp1;
      }
      const verifyReport = await verifyOfficialPreview({
        rp: result.output,
        source: verifySourcePath,
        steps: options.verify,
        engine: options.verifyEngine || 'auto',
        cwd: options.cwd ?? options.projectDir,
        compact: true,
        includeStoryboard: true,
        includeImage: false,
      }, {
        runWorkflow,
        exportHtml: async expOpts => exportPrototype({ ...expOpts, cwd: options.cwd ?? options.projectDir }),
      });
      if (verifyReport?.status !== 'completed') {
        return {
          ...result,
          status: 'failed',
          stage: 'verify',
          verificationReport: verifyReport,
          verification: { ...result.verification, behavior: false, evidence: verifyReport?.evidence ?? null },
        };
      }
      return {
        ...result,
        verificationReport: verifyReport,
        verification: { ...result.verification, behavior: true, evidence: verifyReport.evidence },
      };
    }
    return result;
  } catch (error) {
    return generateFromImageFailure(error, 'output', prep.ctx.output);
  } finally {
    rmSync(prep.ctx.artifactDir, { recursive: true, force: true });
    prep.ctx.unlock();
  }
}

function procStdoutJson(stdout) {
  const text = (stdout ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end >= start ? text.slice(start, end + 1) : '';
}

function resolveReadOnlyState(pathArg, { cwd } = {}) {
  if (pathArg === undefined) return refreshState(requireSession());
  const resolved = resolveInWork(pathArg, cwd);
  assertNotProtected(resolved);
  if (!existsSync(resolved)) throw new Error(`源文件不存在：${resolved}`);
  const sourceFile = realpathSync.native(resolved);
  assertNotProtected(sourceFile);
  if (extname(sourceFile).toLowerCase() !== '.rp') throw new Error(`只接受 .rp 源文件：${sourceFile}`);
  const rp = readRp(readFileSync(sourceFile), { path: sourceFile });
  return { sourceFile, chain: [sourceFile], timeline: [], rp };
}

function resolveRegistryCommand(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) return null;
  const trimmed = rawName.trim();
  const normDash = trimmed.replaceAll('_', '-');
  const normSpace = trimmed.replace(/^axvg[-_]/i, 'axvg ');
  return listCommands().find(c =>
    c.command === trimmed || c.command === normDash || c.command === normSpace || toolName(c.command) === trimmed
  ) ?? null;
}

function sessionSnapshotPayload() {
  if (!session) {
    return {
      active: false,
      file: null,
      hint: '没有活动会话；调用 axure_open 开启，或使用 rp_inspect / rp_patch / rp_command 的显式路径模式；若在编辑 Studio 画布请用 studio_command / studio_inspect。',
    };
  }
  const state = refreshState(requireSession());
  const tail = state.chain.at(-1);
  const syncStatus = computeSyncStatus(state);
  return {
    active: true,
    file: tail,
    sha256: sha256Of(tail),
    ...sessionSummary(state),
    structure: zerosOf(state.rp),
    ...(syncStatus ? { syncStatus } : {}),
  };
}

// ---- 意图级工具的实现 ----
const sessionHandlers = {
  axure_open({ path, rp, file, rpFile, cwd, projectDir } = {}) {
    const rawPath = path ?? rp ?? file ?? rpFile;
    if (!rawPath) throw new Error('axure_open 必须提供 path（或 rp/file/rpFile）');
    const targetPath = resolveInWork(rawPath, cwd ?? projectDir);
    return overviewOf(openSession(targetPath));
  },
  axure_save({ as, cleanup = false, stripWidgetNames: strip = false, cwd, projectDir } = {}) {
    if (as === undefined) {
      if (strip) throw new Error('stripWidgetNames 需要指定新的 as 路径。');
      return sessionSnapshotPayload();
    }
    const state = refreshState(requireSession());
    const tail = state.chain.at(-1);
    if (Object.values(zerosOf(state.rp)).some(Boolean)) {
      throw new Error('链尾结构不健康，拒绝另存；请先调用 rp_inspect({ view: "verify" }) 查看问题。');
    }
    const resolvedAs = resolveInWork(as, cwd ?? projectDir);
    assertNotProtected(resolvedAs);
    assertWritable(resolvedAs);
    const outDir = dirname(resolvedAs);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const target = writablePath(resolvedAs);
    const unlock = acquireOutputLock(target);
    try {
      if (existsSync(target)) throw new Error(`目标已存在，axure_save 只写新文件不覆盖：${target}`);
      const srcBaseline = findBaselineForRp(tail, undefined, state);
      const stripped = strip ? stripWidgetNames(readFileSync(tail), tail) : null;
      const savedRp = stripped ? readRp(stripped.buf, { path: tail }) : state.rp;
      if (Object.values(zerosOf(savedRp)).some(Boolean)) throw new Error('另存副本未通过结构三零。');
      if (srcBaseline && pathExists(`${target}.baseline.json`)) throw new Error(`目标基线已存在：${target}.baseline.json`);
      if (stripped) writeFileSync(target, stripped.buf, { flag: 'wx' });
      else copyFileSync(tail, target, constants.COPYFILE_EXCL);
      let baseline;
      try {
        if (srcBaseline) baseline = saveIdentityBaseline(tail, target, savedRp, srcBaseline);
      } catch (error) {
        unlinkSync(target);
        throw error;
      }
      const digest = sha256Of(target);
      const cleanedWorkFiles = [];
      if (cleanup) {
        const keep = new Set([state.sourceFile, target].filter(Boolean));
        for (const workPath of state.chain) {
          if (!workPath || keep.has(workPath)) continue;
          try {
            assertNotProtected(workPath);
            unlinkSync(workPath);
            cleanedWorkFiles.push(workPath);
          } catch (err) {
            if (err?.code !== 'ENOENT') throw err;
          }
        }
        state.chain = [target];
      }
      state.timeline.push({ op: 'save', at: now(), from: tail, path: target, sha256: digest, ...(cleanedWorkFiles.length ? { cleanedWorkFiles } : {}) });
      return {
        path: resolvedAs,
        physicalPath: target,
        sha256: digest,
        fromChainTail: tail,
        ...(baseline ? { baseline } : {}),
        ...(stripped ? { strippedWidgetNames: stripped.applied.length, structure: zerosOf(savedRp) } : {}),
        ...(cleanup ? { cleanedWorkFiles } : {}),
      };
    } finally { unlock(); }
  },
  rp_inspect(input = {}) {
    const {
      view: explicitView,
      path, rp, file, rpFile, source,
      cwd, projectDir,
      query, page: requestedPage, type, limit, offset = 0,
      target, name, record, id, container,
      widget,
      deep = false, includeCrossPageDuplicates = false,
      full = false,
    } = input;
    const workDir = cwd ?? projectDir;
    const rawPath = path ?? rp ?? file ?? rpFile ?? source;
    const inferredView = explicitView ?? (
      (input.deep !== undefined || input.includeCrossPageDuplicates !== undefined) ? 'verify'
        : (target !== undefined || (record !== undefined && id !== undefined) || name !== undefined) ? 'widget'
          : (query !== undefined || type !== undefined) ? 'locate'
            : (widget !== undefined) ? 'interactions'
              : 'overview'
    );

    if (inferredView === 'state') {
      return { view: 'state', ...sessionSnapshotPayload() };
    }

    if (inferredView === 'styles') {
      let styleFile;
      if (rawPath !== undefined) {
        const resolved = resolveInWork(rawPath, workDir);
        assertNotProtected(resolved);
        if (!existsSync(resolved)) throw new Error(`源文件不存在：${resolved}`);
        styleFile = realpathSync.native(resolved);
        assertNotProtected(styleFile);
        if (!['.rp', '.rplib'].includes(extname(styleFile).toLowerCase())) {
          throw new Error(`styles 视图仅接受 .rp 或 .rplib 文件：${styleFile}`);
        }
      } else {
        styleFile = refreshState(requireSession()).chain.at(-1);
        assertNotProtected(styleFile);
      }
      const styles = listCustomStyles(readFileSync(styleFile));
      return { view: 'styles', file: styleFile, count: styles.length, styles };
    }

    const state = resolveReadOnlyState(rawPath, { cwd: workDir });
    const page = resolvePageFilter(state, requestedPage);

    if (inferredView === 'overview') {
      const rpDoc = state.rp;
      const syncStatus = computeSyncStatus(state);
      return {
        view: 'overview',
        file: state.chain.at(-1),
        counts: countsOf(rpDoc),
        pages: rpDoc.pages.map(p => ({
          name: p.name,
          record: p.record,
          widgets: p.counts.widgets,
          dynamicPanels: p.counts.dynamicPanels,
          interactions: p.counts.interactions,
          namedWidgets: p.counts.namedWidgets,
        })),
        globalVariables: rpDoc.globalVariables,
        masters: rpDoc.sitemap.masters,
        containedWidgets: rpDoc.containedWidgets.length,
        structure: zerosOf(rpDoc),
        ...(syncStatus ? { syncStatus } : {}),
        ...(full ? { rp: rpDoc } : {}),
      };
    }

    if (inferredView === 'locate') {
      const effLimit = limit ?? 50;
      const candidates = locateCandidates(state, { query, page, type });
      return {
        view: 'locate',
        file: state.chain.at(-1),
        total: candidates.length,
        candidates: candidates.slice(offset, offset + effLimit).map(candidateView),
        hasMore: offset + effLimit < candidates.length,
        nextOffset: offset + effLimit < candidates.length ? offset + effLimit : null,
      };
    }

    if (inferredView === 'widget') {
      const inlineRest = Object.fromEntries(
        Object.entries({ query, page, type, name, record, id, container }).filter(([, v]) => v !== undefined)
      );
      const effectiveTarget = target ?? (Object.keys(inlineRest).length > 0 ? inlineRest : undefined);
      if (effectiveTarget === undefined) {
        throw new Error('rp_inspect(view="widget") 必须提供 target（或 query/name/record+id）');
      }
      const cand = resolveTarget(state, effectiveTarget);
      const { fullText, x, y, w, h, ...candRest } = cand;
      const graph = graphsOf(state).get(cand.record);
      const widgetObj = graph?.objects.get(cand.id);
      const style = graph?.objects.get(field(widgetObj?.body ?? {}, 'MyStyle')?.value);
      return {
        view: 'widget',
        ...candRest,
        text: brief(fullText, 200),
        geometry: { x, y, w, h },
        richText: richRunsDetail(state, cand),
        style: (field(style?.body ?? {}, 'PropList')?.items ?? []).map(p => ({
          property: field(p, 'DOAName')?.value,
          value: scalar(field(p, 'Value'), graph),
        })),
        interactions: cand.interactions === null
          ? { count: null, human: [], tree: [], note: '嵌套容器内元件的交互树 rp-read 当前不解析（仅页面顶层元件有）' }
          : { count: cand.interactions.length, human: interactionLines(cand.name || `#${cand.id}`, cand.interactions), tree: cand.interactions },
      };
    }

    if (inferredView === 'interaction-lint') {
      const path = state.chain.at(-1);
      const rp = readRp(readFileSync(path), { path, includeMasterWidgets: true, includeUsage: true });
      const owners = new Map();
      const add = (item, record, ownerPage) => {
        if (item.interactions?.length) owners.set(`${record}:${item.id ?? 'page'}`, {
          page: ownerPage ?? null, widget: item.name ?? null, widgetId: officialIdOf(item.guid),
          ...(item.id ? { target: { guid: item.guid, record, id: item.id } } : {}),
          interactions: item.interactions,
        });
      };
      for (const p of rp.pages) {
        add({ interactions: p.interactions }, p.record, p.name);
        for (const w of p.widgets) add(w, p.record, p.name);
      }
      const indexed = new Map(widgetIndex(state).map(w => [`${w.record}:${w.id}`, w]));
      for (const w of [...rp.containedWidgets]) add(w, w.record, indexed.get(`${w.record}:${w.id}`)?.page);
      const summary = lintNativeInteractions([...owners.values()], rp.globalVariables, rp.version);
      const selected = summary.events.filter(ix => (page === undefined || ix.page === page) &&
        (widget === undefined || ix.widget === widget || ix.target?.guid === widget));
      const diagnostics = summary.diagnostics.filter(d => (page === undefined || d.page === page) &&
        (widget === undefined || d.widget === widget || d.target?.guid === widget));
      return { view: inferredView, file: path, status: diagnostics.some(d => d.severity === 'error') ? 'failed' : 'completed',
        total: selected.length, offset, nextOffset: offset + (limit ?? 50) < selected.length ? offset + (limit ?? 50) : null,
        events: selected.slice(offset, offset + (limit ?? 50)), diagnostics, variables: summary.variables };
    }

    if (inferredView === 'interactions') {
      const effLimit = Math.min(limit ?? 20, 100);
      const pages = page === undefined ? state.rp.pages : state.rp.pages.filter(p => p.name === page);
      if (page !== undefined && pages.length === 0) {
        throw new Error(`页面「${page}」不存在；现有页面：${state.rp.pages.map(p => p.name).join('、')}`);
      }
      const index = widgetIndex(state).filter(w => w.interactions?.length && (page === undefined || w.page === page));
      const matches = widget === undefined ? index : matchByLogicalId(state, index, widget, page);
      const selectedWidgets = widget === undefined || matches.length ? matches
        : index.filter(w => w.name === widget || String(w.id) === widget);
      const owners = pages.flatMap(p => [
        ...(widget === undefined && p.interactions?.length ? [{ kind: 'page', page: p.name, record: p.record, interactions: p.interactions }] : []),
        ...selectedWidgets.filter(w => w.page === p.name).map(w => ({ kind: 'widget', ...w })),
      ]).concat(selectedWidgets.filter(w => !pages.some(p => p.name === w.page)).map(w => ({ kind: 'widget', ...w })));
      const resultFor = selected => ({
        view: 'interactions',
        file: state.chain.at(-1),
        total: owners.length, offset, limit: selected.length, returned: selected.length,
        hasMore: offset + selected.length < owners.length,
        nextOffset: offset + selected.length < owners.length ? offset + selected.length : null,
        items: selected.map(w => w.kind === 'page'
          ? { kind: 'page', page: w.page, record: w.record, interactions: w.interactions }
          : { kind: 'widget', page: w.page, record: w.record, id: w.id, name: w.name, type: w.type,
            container: w.container, ...(w.master ? { master: w.master } : {}), interactions: w.interactions }),
        contained: selected.filter(w => w.kind === 'widget' && w.container.length).map(w => ({ ...candidateView(w), kind: undefined, interactions: w.interactions })),
        pages: pages.map(p => ({ name: p.name,
          pageInteractions: selected.find(w => w.kind === 'page' && w.page === p.name)?.interactions ?? [],
          widgets: selected.filter(w => w.kind === 'widget' && w.page === p.name && !w.container.length)
            .map(w => ({ name: w.name || `#${w.id}`, id: w.id, type: w.type, interactions: w.interactions })),
          counts: { interactions: p.counts.interactions },
        })),
        human: selected.flatMap(w => interactionLines(w.kind === 'page' ? `[页面] ${w.page}` : targetOf(w), w.interactions)),
      });
      const selected = owners.slice(offset, offset + effLimit);
      let result = resultFor(selected);
      while (selected.length > 1 && Buffer.byteLength(JSON.stringify(result)) > 20000) {
        selected.pop(); result = resultFor(selected);
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 20000) result.human = [];
      return result;
    }

    if (inferredView === 'verify') {
      const syncStatus = computeSyncStatus(state);
      const ok = !Object.values(zerosOf(state.rp)).some(Boolean);
      const base = {
        view: 'verify',
        ok,
        file: state.chain.at(-1),
        status: ok ? 'verified' : 'failed',
        structure: zerosOf(state.rp),
        ...(syncStatus ? { syncStatus } : {}),
      };
      if (!deep) return base;
      const allDuplicates = state.rp.duplicates ?? [];
      const samePageDuplicates = [];
      const crossPageDuplicates = [];
      for (const dup of allDuplicates) {
        const pageCounts = new Map();
        for (const loc of dup.locations ?? []) {
          const pageName = String(loc).split(':')[0];
          pageCounts.set(pageName, (pageCounts.get(pageName) ?? 0) + 1);
        }
        const hasSamePageDup = [...pageCounts.values()].some(c => c > 1);
        if (hasSamePageDup) samePageDuplicates.push(dup);
        else crossPageDuplicates.push(dup);
      }
      return {
        ...base,
        duplicates: includeCrossPageDuplicates ? allDuplicates : samePageDuplicates,
        duplicateSummary: {
          samePageGroups: samePageDuplicates.length,
          crossPageSharedGroups: crossPageDuplicates.length,
          ...(crossPageDuplicates.length > 0 ? { crossPageSampleNames: crossPageDuplicates.slice(0, 5).map(d => d.name) } : {}),
        },
        danglingRefs: state.rp.problems.filter(p => p.kind === 'dangling-ref'),
        problems: state.rp.problems,
        pages: state.rp.pages.map(p => ({ name: p.name, record: p.record, widgets: p.counts.widgets, interactions: p.counts.interactions })),
        containedWidgets: state.rp.containedWidgets.length,
        indexedWidgets: widgetIndex(state).length,
      };
    }

    throw new Error(`未知的 rp_inspect 视图：${inferredView}`);
  },
  rp_patch: rpPatch,
  rp_command({ action, command: rawCommand, params, args, session: useSessionFlag, cwd, projectDir } = {}) {
    const allCommands = listCommands();
    const effAction = action ?? (rawCommand === undefined ? 'describe' : 'run');
    if (rawCommand === 'clean-artifacts') {
      if (effAction === 'describe') return { command: rawCommand, usage: 'params: { output: "app.rp" }', readOnly: false };
      if (effAction !== 'run' || typeof params?.output !== 'string' || !/\.rp$/i.test(params.output) || args !== undefined) {
        throw new Error('clean-artifacts 需要 params.output 指向同一输出前缀的 .rp。');
      }
      const output = resolveInWork(params.output, cwd ?? projectDir);
      const unlock = acquireOutputLock(output);
      try { return { status: 'completed', output, removed: cleanLegacyArtifacts(output) }; }
      finally { unlock(); }
    }
    if (effAction === 'describe' && rawCommand === undefined) {
      return {
        action: 'describe',
        count: allCommands.length,
        commands: allCommands.map(c => ({
          command: c.command,
          usage: c.usage,
          readOnly: Boolean(commandIO(c)?.readOnly),
          supportsSession: Boolean(commandIO(c)),
        })),
      };
    }
    const cmd = resolveRegistryCommand(rawCommand);
    if (!cmd) {
      const err = new Error(`未知底层命令 "${rawCommand ?? ''}"；调用 rp_command({ action: "describe" }) 查看全部 ${allCommands.length} 个命令。`);
      err.availableCommands = allCommands.map(c => c.command);
      throw err;
    }
    const schema = commandSchema(cmd.command);
    if (effAction === 'describe') {
      return {
        action: 'describe',
        command: cmd.command,
        usage: cmd.usage,
        readOnly: Boolean(commandIO(cmd)?.readOnly),
        supportsSession: Boolean(commandIO(cmd)),
        inputSchema: schema,
      };
    }
    if (params !== undefined && args !== undefined) {
      throw new Error('rp_command 执行时 params 与 args 二选一，不能同时提供。');
    }
    const commandInput = args !== undefined
      ? { args, ...(useSessionFlag !== undefined ? { session: useSessionFlag } : {}) }
      : (params ?? {});
    validateInput(schema, commandInput, 'params');
    if (cmd.command === 'add-interaction' && !Object.hasOwn(commandInput, 'args')) {
      return runInteractionCommand(commandInput, cwd ?? projectDir, effAction === 'preflight');
    }
    if (effAction === 'preflight') throw new Error('预检请使用 add-interaction 的结构化 params.interactions 或 params.items。');
    return runCommandPayload(cmd, commandInput, { cwd: cwd ?? projectDir });
  },
  sync_prototype: syncPrototype,
  generate_from_image: generateFromImageAsync,
};

// ---- 意图级工具的 MCP 定义（校验复用本文件 validateInput）----
function stripSchemaDescriptions(node) {
  if (Array.isArray(node)) return node.map(stripSchemaDescriptions);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description') continue;
    if (k === 'type' && Array.isArray(node.enum) && node.enum.length && node.enum.every(value => typeof value === v)) continue;
    out[k] = stripSchemaDescriptions(v);
  }
  return out;
}

const paragraphSchema = {
  type: 'object',
  properties: {
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    wrapping: { type: 'integer', enum: [0, 1, 2, 3, 4] },
    trimming: { type: 'integer', enum: [0, 2, 3] },
    list: { oneOf: [{ type: 'boolean' }, { type: 'integer', minimum: 0, maximum: 3 }] },
    lineSpacing: { type: 'number', minimum: 0 },
    runs: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      text: { type: 'string' },
      style: { type: 'object' },
      link: { oneOf: [
        { type: 'object', properties: { page: { type: 'string', minLength: 1 }, window: { type: 'string', enum: ['current', 'new'] } }, required: ['page'], additionalProperties: false },
        { type: 'object', properties: { url: { type: 'string', pattern: '^https?://' }, window: { type: 'string', enum: ['current', 'new'] } }, required: ['url'], additionalProperties: false },
      ] },
    }, required: ['text'], additionalProperties: false } },
  },
  required: ['runs'], additionalProperties: false,
};
const richRunsSchema = {
  oneOf: [
    { type: 'array', items: paragraphSchema },
    { type: 'object', properties: { paragraphs: { type: 'array', items: paragraphSchema }, defaults: { type: 'object' } }, required: ['paragraphs'], additionalProperties: false },
  ],
};
const targetSchema = {
  oneOf: [
    { type: 'object', properties: {
      query: { type: 'string' }, page: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' },
      guid: { type: 'string', pattern: '^[0-9a-fA-F]{32}$' }, logicalId: { type: 'string', minLength: 1 },
      record: { type: 'number' }, id: { type: 'number' }, container: { type: 'array', items: { type: 'string' } },
    } },
    { type: 'string', minLength: 1 },
  ],
};
const styleSelectorSchema = {
  oneOf: [
    { type: 'string', minLength: 1 },
    {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        record: { type: 'integer', minimum: 0 },
        id: { type: 'integer', minimum: 0 },
        owner: { type: 'string', minLength: 1 },
        all: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  ],
};
const patchItemProperties = {
  op: { type: 'string', enum: ['widget', 'text', 'richtext', 'rename', 'geometry', 'style', 'rename-style', 'rebind-style'] },
  target: targetSchema,
  page: { type: 'string' },
  widget: { type: 'string' },
  text: { type: 'string' },
  runIndex: { type: 'integer' },
  richRuns: richRunsSchema,
  name: { type: 'string' },
  newName: { type: 'string' },
  x: { type: 'number' },
  y: { type: 'number' },
  w: { type: 'number' },
  width: { type: 'number' },
  h: { type: 'number' },
  height: { type: 'number' },
  fill: { type: 'string' },
  stroke: { type: 'string' },
  color: { type: 'string' },
  radius: { type: 'number' },
  oldName: { type: 'string' },
  styleGuid: { type: 'string' },
  selector: styleSelectorSchema,
  resetOverrides: { type: 'boolean' },
};
const patchItemRefProperties = {
  ...patchItemProperties,
  op: { $ref: '#/properties/op' },
  target: { $ref: '#/properties/target' },
  richRuns: { $ref: '#/properties/richRuns' },
  selector: { $ref: '#/properties/selector' },
};

export const sessionTools = [
  ...authoringTools({ generate: generatePrototype, sync: syncPrototype, listTools: () => {
    const active = resolveMcpProfile();
    const allow = MCP_PROFILES[active];
    return [...listMcpTools({ profile: active }), ...(allow ? jobTools.filter(t => allow.has(t.name)) : jobTools)];
  } }),
  {
    name: 'generate_prototype',
    description: '生成原生 RP9 .rp（rp1/spec/source/recipe）并写出 .baseline.json。',
    inputSchema: { type: 'object', properties: {
      recipe: { type: 'string', enum: recipes.map(recipe => recipe.id) },
      rp1: { type: 'string' },
      spec: { oneOf: [
        { type: 'string' }, { type: 'object', properties: {
        language: { type: 'string', enum: ['rp/1', 'RP/1'] }, target: { type: 'integer', enum: [9] },
        domain: { type: 'string', enum: ['mobile', 'web', 'doc', 'test'] },
        theme: { type: 'string' }, palette: { type: 'object' }, tokens: { type: 'object' },
        components: { oneOf: [{ type: 'object' }, { type: 'array' }] },
        variables: { oneOf: [{ type: 'object' }, { type: 'array' }] },
        pages: { type: 'array', minItems: 1, items: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' }, root: { type: 'object' } }, required: ['id'] } },
      }, required: ['pages'] }] },
      source: { type: 'string' },
      sourcePath: { type: 'string' },
      program: { type: 'object' },
      programs: { type: 'array', items: { type: 'object' } },
      sharedRoutines: { type: 'object' },
      output: { type: 'string', minLength: 1 },
      cwd: { type: 'string' },
      projectDir: { type: 'string' },
      async: { type: 'boolean' },
      includeImage: { type: 'boolean' },
      strictAudit: { type: 'boolean' },
      autoHeal: { type: 'boolean' },
      variants: { type: 'array', maxItems: 4 },
      overwrite: { type: 'boolean' },
      compact: { type: 'boolean' },
      template: { type: 'string' },
      baseRp: { type: 'string' },
      prefer: { type: 'string', enum: ['fail', 'source', 'native'] },
      resolutions: { type: 'object' },
      fitCanvas: { enum: ['auto', 'content', 'viewport'] },
      verify: { type: 'boolean' },
      verifyMode: { enum: ['fast', 'full'] },
      noCache: { type: 'boolean' },
      verifyEngine: { type: 'string', enum: ['auto', 'official', 'studio-html'] },
      verifySteps: { type: 'array' },
      verifyViewport: { type: 'object' },
      virtualClock: { type: 'boolean' },
      includeStoryboard: { type: 'boolean' },
    }, required: ['output'], additionalProperties: false },
    handler: ({ includeImage, verify, verifyEngine, verifySteps, verifyViewport, virtualClock, includeStoryboard, ...input }) => {
      const rawHtmlCandidate = input.source ?? input.sourcePath;
      const htmlMode = isHtmlInput(rawHtmlCandidate);
      if (!verify && !htmlMode) {
        const result = generatePrototype({ ...input, verifySteps });
        if (result.status !== 'completed') return result;
        const images = [];
        if (includeImage) {
          const path = result.contactSheet;
          try {
            if (path && lstatSync(path).size <= 1024 * 1024) {
              images.push({ mimeType: 'image/png', data: readFileSync(path).toString('base64') });
              result.previewImage = 'attached';
            } else {
              result.previewImage = 'use-preview-paths';
            }
          } catch {
            result.previewImage = 'use-preview-paths';
          }
        }
        return images.length ? { ...result, mcpImages: images } : result;
      }
      return (async () => {
        let stageDir = null;
        let htmlImportSummary = null;
        let genInput = input;
        let importedRp1Text = null;
        let importedAssets = [];
        try {
          if (htmlMode) {
            const workDir = resolveWorkDir(input.cwd ?? input.projectDir);
            const trimmed = String(rawHtmlCandidate).trim();
            const htmlTarget = /^(?:https?|file):\/\//i.test(trimmed)
              ? trimmed
              : (isAbsolute(trimmed) ? resolve(trimmed) : resolve(workDir, trimmed));
            if (!/^https?:\/\//i.test(htmlTarget)) assertNotProtected(htmlTarget);
            stageDir = mkdtempSync(join(tmpdir(), 'zee-html-gen-'));
            const stageAssetsDir = join(stageDir, 'assets');
            const imported = await importHtmlToRp1Spec(htmlTarget, {
              cwd: workDir,
              assetsDir: stageAssetsDir,
              viewport: verifyViewport || null,
              fitCanvas: input.fitCanvas,
            });
            htmlImportSummary = imported.summary;
            importedRp1Text = imported.rp1Text;
            importedAssets = imported.assets || [];
            const stagedRp1 = join(stageDir, 'imported.rp1');
            writeFileSync(stagedRp1, imported.rp1Text, 'utf8');
            genInput = { ...input, source: stagedRp1, sourcePath: undefined };
          }

          const result = generatePrototype({ ...genInput, verifySteps });
          if (result.status !== 'completed') return result;

          if (htmlMode) {
            const companionRp1 = input.program || input.programs ? result.source : result.output.replace(/\.rp$/i, '.rp1');
            if (stageDir && existsSync(join(stageDir, 'assets')) && importedAssets.length) {
              const outAssetsDir = join(dirname(result.output), 'assets');
              assertWritable(join(outAssetsDir, '.keep'));
              mkdirSync(outAssetsDir, { recursive: true });
              for (const relAsset of importedAssets) {
                const srcA = join(stageDir, relAsset);
                const dstA = join(dirname(result.output), relAsset);
                if (existsSync(srcA) && !existsSync(dstA)) copyFileSync(srcA, dstA);
              }
            }
            if (!pathExists(companionRp1) || input.overwrite) {
              assertWritable(companionRp1);
              writeFileSync(companionRp1, importedRp1Text, 'utf8');
              result.source = companionRp1;
              if (result.baseline && pathExists(result.baseline)) {
                try {
                  const bm = JSON.parse(readFileSync(result.baseline, 'utf8'));
                  bm.sourcePath = companionRp1;
                  bm.sourceSha256 = sha256Of(companionRp1);
                  writeFileSync(result.baseline, JSON.stringify(bm, null, 2) + '\n');
                } catch {}
              }
            }
            if (htmlImportSummary) result.htmlImport = htmlImportSummary;
          }

          const images = [];
          if (includeImage) {
            const path = result.contactSheet;
            try {
              if (path && lstatSync(path).size <= 1024 * 1024) {
                images.push({ mimeType: 'image/png', data: readFileSync(path).toString('base64') });
                result.previewImage = 'attached';
              } else {
                result.previewImage = 'use-preview-paths';
              }
            } catch {
              result.previewImage = 'use-preview-paths';
            }
          }
          if (!verify) {
            return images.length ? { ...result, mcpImages: images } : result;
          }
          const bv = await verifyOfficialPreview({
            rp: result.output,
            source: result.source ?? genInput.source ?? genInput.sourcePath,
            cwd: input.cwd,
            projectDir: input.projectDir,
            engine: verifyEngine ?? result.interactionEngine,
            steps: verifySteps ?? result.verifySteps,
            viewport: verifyViewport,
            virtualClock,
            compact: input.compact !== false,
            includeStoryboard,
            proofStoryboard: true,
            proofDirectory: prototypeAssetsDir(result.output),
            fast: input.verifyMode === 'fast',
            noCache: input.noCache,
          }, { runWorkflow, exportHtml: exportPrototype });
          const { mcpImages: verifyImgs, ...bvSummary } = bv;
          const allImgs = [...images, ...(verifyImgs ?? [])].slice(0, 4);
          return {
            ...result,
            status: bv.status === 'completed' ? 'completed' : 'failed',
            verification: {
              ...result.verification, preview: bv.status === 'completed',
              mode: input.verifyMode ?? 'full', evidence: bv.engine === 'studio-html' ? 'studio-html-cdp' : 'axure-official-html-cdp',
            },
            behaviorVerification: bvSummary,
            ...(bv.proofReport ? { proofReport: bv.proofReport } : {}),
            ...(bv.status !== 'completed' ? { diagnostics: bv.diagnostics } : {}),
            ...(allImgs.length ? { mcpImages: allImgs } : {}),
          };
        } finally {
          if (stageDir) rmSync(stageDir, { recursive: true, force: true });
        }
      })();
    },
  },
  {
    name: 'sync_prototype',
    description: '源码与原生 .rp 三方同步及逆向反编译。',
    inputSchema: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' },
      mode: { type: 'string', enum: ['status', 'lift', 'merge', 'rebuild', 'decompile', 'relocate'] },
      source: { type: 'string' },
      sourcePath: { type: 'string' },
      spec: { oneOf: [{ type: 'string' }, { type: 'object' }] },
      rp: { type: 'string' },
      path: { type: 'string' },
      rpFile: { type: 'string' },
      file: { type: 'string' },
      baseRp: { type: 'string' },
      baseline: { type: 'string' },
      baselinePath: { type: 'string' },
      output: { type: 'string' },
      outRp: { type: 'string' },
      outSource: { type: 'string' },
      outSpec: { type: 'string' },
      cwd: { type: 'string' },
      projectDir: { type: 'string' },
      prefer: { type: 'string', enum: ['fail', 'source', 'native'] },
      resolutions: { type: 'object' },
      expectedRpSha256: { type: 'string' },
      expectedSemanticHash: { type: 'string' },
      overwrite: { type: 'boolean' },
      includeSpec: { type: 'boolean' },
    }, additionalProperties: false },
    handler: sessionHandlers.sync_prototype,
  },
  {
    name: 'generate_from_image',
    description: 'UI 截图还原为原生 RP9 .rp，可选伴随 .rp1 与 Chrome 验收。',
    inputSchema: { type: 'object', properties: {
      image: { type: 'string' },
      spec: { oneOf: [{ type: 'string' }, { type: 'object' }] },
      output: { type: 'string', minLength: 1 },
      cwd: { type: 'string' },
      projectDir: { type: 'string' },
      version: { type: 'integer', enum: [9, 11] },
      scale: { type: 'number' },
      page: { type: 'string' },
      replace: { type: 'array' },
      baseRp: { type: 'string' },
      prefer: { type: 'string', enum: ['fail', 'source', 'native'] },
      preview: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
      emitRp1: { type: 'boolean' },
      outSource: { type: 'string' },
      autoFix: { type: 'boolean' },
      verify: { type: 'array' },
      verifyEngine: { type: 'string', enum: ['auto', 'official', 'studio-html'] },
      guiPaste: { type: 'boolean' },
    }, required: ['output'], additionalProperties: false },
    handler: sessionHandlers.generate_from_image,
  },
  {
    name: 'axure_open',
    description: '开启原生 .rp 编辑会话并创建工作副本链。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        rp: { type: 'string' },
        file: { type: 'string' },
        rpFile: { type: 'string' },
        cwd: { type: 'string' },
        projectDir: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: sessionHandlers.axure_open,
  },
  {
    name: 'axure_save',
    description: '查询编辑会话状态或另存链尾为新 .rp（支持去命名与清理）。',
    inputSchema: {
      type: 'object',
      properties: {
        as: { type: 'string' },
        stripWidgetNames: { type: 'boolean' },
        cleanup: { type: 'boolean' },
        cwd: { type: 'string' },
        projectDir: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: sessionHandlers.axure_save,
  },
  {
    name: 'rp_inspect',
    readOnly: true,
    description: '只读检查原生 .rp/.rplib（overview/locate/widget/interactions/interaction-lint/verify/styles/state）。',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['overview', 'locate', 'widget', 'interactions', 'interaction-lint', 'verify', 'styles', 'state'] },
        path: { type: 'string' },
        rp: { type: 'string' },
        file: { type: 'string' },
        rpFile: { type: 'string' },
        source: { type: 'string' },
        cwd: { type: 'string' },
        projectDir: { type: 'string' },
        query: { type: 'string' },
        page: { type: 'string' },
        type: { type: 'string' },
        target: { oneOf: [{ type: 'object' }, { type: 'string' }] },
        name: { type: 'string' },
        record: { type: 'integer', minimum: 0 },
        id: { type: 'integer', minimum: 0 },
        container: { type: 'array', items: { type: 'string' } },
        widget: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
        deep: { type: 'boolean' },
        includeCrossPageDuplicates: { type: 'boolean' },
        full: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 1024 },
      },
      additionalProperties: false,
    },
    handler: input => governReadOnlyOutput(sessionHandlers.rp_inspect(input), {
      workDir: resolveWorkDir(input.cwd ?? input.projectDir), maxBytes: input.maxBytes, label: 'rp-inspect',
    }),
  },
  {
    name: 'rp_patch',
    description: '原生 .rp/.rplib 补丁：单条或 edits/operations 原子批量修改。',
    inputSchema: {
      type: 'object',
      $defs: {
        patchItem: { type: 'object', properties: patchItemRefProperties, additionalProperties: false },
      },
      properties: {
        ...patchItemProperties,
        op: { ...patchItemProperties.op, enum: [...patchItemProperties.op.enum, 'strip-widget-names'] },
        edits: { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/$defs/patchItem' } },
        operations: { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/$defs/patchItem' } },
        source: { type: 'string' },
        path: { type: 'string' },
        rp: { type: 'string' },
        file: { type: 'string' },
        rpFile: { type: 'string' },
        output: { type: 'string' },
        overwrite: { type: 'boolean' },
        cwd: { type: 'string' },
        projectDir: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: sessionHandlers.rp_patch,
  },
  {
    name: 'rp_command',
    description: '受控底层原生命令入口（折叠全部注册表 CLI 命令）：action="describe" 查用法与 schema；action="run" 执行（自动接续活动会话）；add-interaction 支持 action="preflight"。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['describe', 'run', 'preflight'] },
        command: { type: 'string', minLength: 1 },
        params: { type: 'object' },
        args: { type: 'array', items: { type: 'string' } },
        session: { type: 'boolean' },
        cwd: { type: 'string', minLength: 1 },
        projectDir: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    handler: sessionHandlers.rp_command,
  },
  ...studioTools,
];

const sessionToolIndex = new Map(sessionTools.map(tool => [tool.name, input => {
  const unexpected = tool.name === 'export_prototype' && input && typeof input === 'object'
    ? Object.keys(input).find(key => !Object.hasOwn(tool.inputSchema.properties, key)) : null;
  if (unexpected) {
    const nextAction = unexpected === 'overwrite'
      ? '选用一个尚不存在的 output 目录，或把已有导出目录传给 verify_prototype 的 html 字段。'
      : '使用 rp 指定源 .rp，output 指定新目录，或用 baseline 指定元件映射。';
    return toolResult({ status: 'failed', stage: 'validation', diagnostics: [{ code: 'E_TOOL_INPUT', field: unexpected,
      pointer: `/arguments/${unexpected}`, message: `export_prototype 不接受 ${unexpected}。`, nextAction,
      acceptedFields: Object.keys(tool.inputSchema.properties) }] }, true);
  }
  validateInput(tool.inputSchema, input);
  const value = tool.handler(input);
  const finish = result => toolResult(result, result.ok === false || result.status === 'failed' || result.status === 'conflict');
  if (value && typeof value.then === 'function') return value.then(finish).catch(error => toolResult({ status: 'failed',
    diagnostics: [{ code: error.code ?? 'E_TOOL_INPUT', message: error.message,
      ...Object.fromEntries(['field', 'candidates', 'sourceSpan', 'line', 'column', 'snippet', 'currentRevision', 'requestedBaseRevision', 'renderedRevision'].filter(key => error[key] !== undefined).map(key => [key, error[key]])),
      nextAction: error.code === 'E_WRITE_OUTCOME_UNKNOWN' ? '先读取当前版本和实际内容，确认本次写入结果；不要盲目重发。' : '按返回字段与候选修正参数；用studio_describe按需读取公开契约。' }],
  }, true));
  return finish(value);
}]));
