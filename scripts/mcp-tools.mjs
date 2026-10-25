import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCommands } from './registry.mjs';
import { assertNotProtected, assertWritable, AxureSession } from './engine.mjs';
import { readRp } from './rp-read.mjs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { setRecordWidgetText } from './set-widget-text.mjs';
import { setWidgetRichText } from './set-widget-richtext.mjs';
import { setWidgetNames } from './name-widget.mjs';
import { EVENTS } from './ix-actions.mjs';
import { compilePrototype, buildInteractiveRp } from './proto.mjs';
import { expandSpec, pasteAxvg } from './axvg.mjs';
import { createBlankProject } from './create-blank-project.mjs';
import { writeNativeScene } from './native-scene.mjs';
import { mergePages } from './merge-pages.mjs';
import { authoringTools, recipeSource, runWorkflow, pythonEnvironment } from './authoring-workflow.mjs';
import { reviewImageStructure } from './image-structure.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TRACE_PY = join(SCRIPTS_DIR, 'trace.py');
const PROTO_PY = join(SCRIPTS_DIR, 'proto.py');
const RP_LANG_CLI = join(SCRIPTS_DIR, 'rp_language_cli.py');

const dump = spawnSync(process.execPath, [fileURLToPath(new URL('./registry.mjs', import.meta.url)), 'dump'], { encoding: 'utf8' });
if (dump.status !== 0) throw new Error(dump.stderr || 'registry dump failed');
const config = JSON.parse(dump.stdout).libScripts.find(row => row.script === 'mcp-tools.mjs');
export const jobTools = JSON.parse(dump.stdout).libScripts.find(row => row.script === 'jobs.mjs')?.tools ?? [];
if (!config) throw new Error('mcp-tools.mjs 未在注册表登记');
export const toolName = command => command.replaceAll(/[ -]/g, '_');

// 低层 SDK 不自动执行 JSON Schema 校验；本表只使用这些 JSON Schema 关键字。
export function validateInput(schema, value, at = 'arguments') {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(branch => { try { validateInput(branch, value, at); return true; } catch { return false; } });
    if (matches.length !== 1) throw new Error(at === 'arguments' ? `${at} 必须选择具名参数或 args，不能混用` : `${at} 格式或类型不匹配`);
    return;
  }
  if (!schema.type) return; // Unrestricted JSON values in source patch operations.
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} 必须是对象`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key} 缺失`);
    for (const [key, field] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub && schema.additionalProperties === false) throw new Error(`${at}.${key} 未登记`);
      if (sub) validateInput(sub, field, `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${at} 必须是数组`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${at} 至少需要 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${at} 最多允许 ${schema.maxItems} 项`);
    value.forEach((item, i) => validateInput(schema.items, item, `${at}[${i}]`));
  } else {
    if (schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) throw new Error(`${at} 必须是 ${schema.type}`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${at} 不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${at} 不能大于 ${schema.maximum}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${at} 不能为空`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${at} 格式错误`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} 不在允许值内`);
  }
}

// RP 工具的宿主输入与输出位置；多源导入的第一个参数仍由调用方提供。
function commandIO(command) {
  if (command.command === 'rp-read') return { source: 'file', readOnly: true };
  if (command.output === 'index:3') return { source: 'source', output: 'output', prefix: 2 };
  if (command.output === 'index:4') return { source: 'target', output: 'output', prefix: 3, external: true };
  if (command.command === 'create-blank-project') return { output: 'output', prefix: 1 };
  return null; // Axvg 的输入输出不是 RP，会话不会改写其参数。
}

export function listMcpTools() {
  return [...listCommands().map(c => ({
    name: toolName(c.command),
    description: `${c.summary}。${commandIO(c) ? '具名调用省略宿主源/输出即使用会话链；原始 args 用 session:true 并省略这两个参数（多源工具保留导入源）。显式路径不推进链。' : ''} 登记证据 ${c.evidence}，只适用 capabilities.md 的已验样本。CLI: ${c.usage}${c.command.startsWith('axvg ') ? '；args 省略子命令词，服务自动加入。' : ''}`,
    inputSchema: commandSchema(c.command),
    annotations: { readOnlyHint: ['rp-read', 'axvg selftest', 'list-custom-styles'].includes(c.command), destructiveHint: false, openWorldHint: c.command === 'axvg paste' },
  })), ...sessionTools.map(({ name, description, inputSchema, readOnly }) => ({
    name, description, inputSchema,
    annotations: { readOnlyHint: readOnly ?? ['axure_state', 'locate', 'inspect', 'read_interactions', 'verify'].includes(name), destructiveHint: false, openWorldHint: false },
  }))];
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

const toolResult = (value, isError = false) => ({ isError, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
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

function runCommandTool(command, input) {
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
      if (!io.readOnly && Object.values(zerosOf(state.rp)).some(Boolean)) throw new Error('链尾结构不健康，请先 verify。');
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
      source = raw ? args.filter(a => !a.startsWith('--'))[io.external ? 1 : 0] : input[io.source];
      if (!io.source) source = null;
      if (source) { assertNotProtected(source); before = countsOf(readRp(readFileSync(source), { path: source })); }
    }
  }
  if (command.command.startsWith('axvg ')) args = [command.command.split(' ')[1], ...args];
  const result = new AxureSession({ source }).run(command.command, args);
  const rawStderr = result.stderr.toString();
  const errHeaderMatch = rawStderr.match(/^(?:[\w$]*Error|ERR_[\w$]+):\s*(.+)$/m);
  const cleanStderr = errHeaderMatch
    ? errHeaderMatch[1].trim()
    : (rawStderr
        .split(/\r?\n/)
        .map(ln => ln.trim())
        .filter(ln => ln && !/^at\s+/.test(ln) && !ln.includes('file://') && !/^\^+$/.test(ln) && !/^Node\.js\s+v/i.test(ln))
        .join('\n') || rawStderr.trim());
  const value = { exitCode: result.status, stdout: result.stdout.toString(), stderr: result.status === 0 ? rawStderr : cleanStderr, status: result.status === 0 ? 'completed' : 'failed' };
  if (result.status !== 0) {
    if (node && !/EEXIST|already exists/i.test(rawStderr) && pathExists(node)) value.rejected = rejectNode(node);
    const errCode = /EEXIST|already exists/i.test(rawStderr) ? 'E_OUTPUT_EXISTS' : 'E_TOOL_INPUT';
    value.code = errCode;
    value.message = cleanStderr || `${command.command} 执行失败 (exit=${result.status})`;
    value.diagnostics = [{ code: errCode, pointer: '/arguments', message: value.message, nextAction: '检查参数或读取最新原型状态；保留原文件后重试。' }];
    value.usage = command.usage;
    value.candidates = errorCandidates(command, input, args, source, rawStderr);
    if (state) value.chainTail = state.chain.at(-1);
    return toolResult(value, true);
  }
  if (node) {
    commitChainNode(state, node, { op: command.command, at: now(), from: source, node });
    Object.assign(value, { chainTail: node, previousTail: source, before, after: countsOf(state.rp), structure: zerosOf(state.rp) });
  } else if (io && !io.readOnly) {
    // 宿主输出在所有 RP 工具中固定为前缀末尾；Axvg 不进入此分支。
    const output = raw ? args.filter(a => !a.startsWith('--'))[io.prefix - 1] : input.output;
    if (output) { assertNotProtected(output); value.output = output; value.before = before; value.after = countsOf(readRp(readFileSync(output), { path: output })); }
  }
  return toolResult(value);
  } finally { if (node) releaseWorkNode(node); }
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

export function callCommandTool(name, input) {
  const command = listCommands().find(c => toolName(c.command) === name);
  try {
    const sessionTool = sessionToolIndex.get(name);
    if (sessionTool) return sessionTool(input);
    if (!command) throw new Error(`未知工具 ${name}`);
    validateInput(commandSchema(command.command), input);
    return runCommandTool(command, input);
  } catch (error) {
    if (name === 'generate_prototype') return toolResult({ status: 'failed', stage: 'validation', message: error.message,
      diagnostics: [{ code: 'E_GENERATE_ARGUMENT', pointer: '/arguments', message: error.message }],
    }, true);
    if (name === 'generate_from_image' || name === 'sync_prototype') return toolResult({ status: 'failed', stage: 'validation', message: error.message,
      diagnostics: [{ code: name === 'generate_from_image' ? 'E_IMAGE_ARGUMENT' : 'E_SYNC_ARGUMENT', pointer: '/arguments', message: error.message }],
    }, true);
    return toolResult({ status: 'error', code: error.code ?? 'E_TOOL_INPUT', message: error.message,
      diagnostics: [{ code: error.code ?? 'E_TOOL_INPUT', pointer: '/arguments', message: error.message,
        nextAction: '检查参数或读取最新原型状态；保留原文件后重试。' }],
      ...(command ? { usage: command.usage } : !sessionToolIndex.has(name) ? { availableTools: listMcpTools().map(t => t.name) } : {}),
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
  if (!session) throw new Error('没有活动会话：先调用 axure_open <path.rp>；或继续用命令工具的显式路径模式');
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
    items.set(`${item.record}:${item.id}`, { ...item, guid: pack?.guid ?? null, recordGuid: pack?.guid ?? null,
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
            w.record === loc.record && w.id === loc.id
            && (!Array.isArray(loc.container) || w.container.join('/') === loc.container.join('/'))
          ));
          if (byNative.length > 0) return byNative;
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

function locateCandidates(state, filter) {
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
  const sourceFile = realpathSync.native(path);
  assertNotProtected(sourceFile);
  if (extname(sourceFile).toLowerCase() !== '.rp') throw new Error(`axure_open 只接受 .rp 源文件：${sourceFile}`);
  if (!existsSync(sourceFile)) throw new Error(`源文件不存在：${sourceFile}`);
  const bytes = readFileSync(sourceFile);
  const rp = readRp(bytes, { path: sourceFile }); // 不可解析直接抛错，不建链
  if (Object.values(zerosOf(rp)).some(Boolean)) throw new Error(`源文件结构检查失败，不建会话：${JSON.stringify(zerosOf(rp))}`);
  let node;
  try { node = nextWorkNode({ sourceFile }); assertWritable(node); } catch (error) {
    // 白名单拒绝时补充可执行指引，避免“工作副本落不了盘”的静默失败（硬规则 3）。
    const hint = error.message.includes('AXURE_WRITE_ROOT')
      ? '。指引：把源文件复制到 AXURE_WRITE_ROOT 白名单根内再 open，或把源目录加入白名单' : '';
    throw new Error(`${error.message}${hint}`);
  }
  try { writeFileSync(node, bytes, { flag: 'wx' }); } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code))
      throw new Error(`源目录不可写（${dirname(sourceFile)}），工作副本无法落盘。指引：把源文件复制到可写目录后再 open，或设置/调整 AXURE_WRITE_ROOT。原始错误：${error.message}`);
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

function textEdit(state, { target, widget, page, text, richRuns }) {
  if ((text === undefined) === (richRuns === undefined)) throw new Error('每次编辑必须提供 text 或 richRuns 之一，不能同时提供。');
  const effectiveTarget = target ?? (widget !== undefined ? { name: widget, ...(page !== undefined ? { page } : {}) } : undefined);
  const cand = resolveTarget(state, effectiveTarget);
  const tail = state.chain.at(-1), node = nextWorkNode(state);
  assertNotProtected(tail); assertWritable(node);
  let report, created = false;
  try {
    if (richRuns !== undefined) {
      const paragraphs = Array.isArray(richRuns) ? richRuns : richRuns.paragraphs;
      const spec = { record: cand.record, widgetId: cand.id, paragraphs };
      if (!Array.isArray(richRuns) && richRuns.defaults) spec.defaults = richRuns.defaults;
      const result = setWidgetRichText(readFileSync(tail), spec);
      report = result.report;
      writeFileSync(node, result.file, { flag: 'wx' });
    } else setRecordWidgetText(tail, node, cand.record, cand.id, text);
    created = true;
    commitChainNode(state, node, { op: 'edit_text', kind: richRuns === undefined ? 'text' : 'richtext', at: now(), target: targetOf(cand), before: cand.fullText, after: report?.text ?? text, node });
  } catch (error) {
    if (created && pathExists(node)) error.message += `；失败节点保留 ${rejectNode(node)}`;
    throw error;
  } finally { releaseWorkNode(node); }
  const syncStatus = computeSyncStatus(state);
  return { before: cand.fullText, after: report?.text ?? text, chainTail: node, previousTail: tail, ...(report ? { report } : {}), ...(syncStatus ? { syncStatus } : {}) };
}

function editTexts(input) {
  const state = refreshState(requireSession());
  if (Object.values(zerosOf(state.rp)).some(Boolean)) throw new Error(`链尾结构不健康，请先 verify：${JSON.stringify(zerosOf(state.rp))}`);
  if (!input.edits) return textEdit(state, input);
  if (input.target !== undefined || input.text !== undefined || input.richRuns !== undefined) throw new Error('edits 批量模式不能混用单条 target/text/richRuns。');
  for (const edit of input.edits) if ((edit.text === undefined) === (edit.richRuns === undefined)) throw new Error('每条 edits 必须提供 text 或 richRuns 之一。');
  // 在私有分支上完整执行后提交；失败不触碰活动链，已写出的节点隔离为 rejected。
  const branch = { ...state, chain: [...state.chain], timeline: [...state.timeline], index: null, graphs: null };
  const previousTail = state.chain.at(-1), before = countsOf(state.rp);
  const edits = [];
  try { for (const edit of input.edits) edits.push(textEdit(branch, edit)); }
  catch (error) {
    const rejected = branch.chain.slice(state.chain.length).filter(pathExists).map(rejectNode);
    error.message = `批量编辑失败，整批回退到 ${previousTail}；隔离 ${rejected.length} 个已写节点。${error.message}`;
    throw error;
  }
  Object.assign(state, branch);
  const syncStatus = computeSyncStatus(state);
  return { status: 'completed', edits, previousTail, chainTail: state.chain.at(-1), before, after: countsOf(state.rp), structure: zerosOf(state.rp), ...(syncStatus ? { syncStatus } : {}) };
}

function renameWidgets(input) {
  const state = refreshState(requireSession());
  if (Object.values(zerosOf(state.rp)).some(Boolean)) throw new Error('链尾结构不健康，请先 verify。');
  if (input.edits && (input.target !== undefined || input.name !== undefined || input.newName !== undefined)) throw new Error('edits 不能混用 target/name。');
  const edits = input.edits ?? [input];
  const resolved = edits.map(edit => {
    const effTarget = edit.target ?? (edit.widget !== undefined ? { name: edit.widget, ...(edit.page !== undefined ? { page: edit.page } : {}) } : undefined);
    const effName = edit.name ?? edit.newName;
    if (effTarget === undefined || typeof effName !== 'string') throw new Error('改名需要 target (或 widget) 和 name (或 newName)。');
    const cand = resolveTarget(state, effTarget);
    return { record: cand.record, id: cand.id, name: effName };
  });
  const tail = state.chain.at(-1), node = nextWorkNode(state);
  let created = false;
  try {
    assertNotProtected(tail); assertWritable(node);
    const result = setWidgetNames(readFileSync(tail), resolved);
    writeFileSync(node, result.file, { flag: 'wx' }); created = true;
    commitChainNode(state, node, { op: 'rename_widget', at: now(), edits: result.applied, node });
    const syncStatus = computeSyncStatus(state);
    return { status: 'completed', edits: result.applied, chainTail: node, previousTail: tail, structure: zerosOf(state.rp), ...(syncStatus ? { syncStatus } : {}) };
  } catch (error) {
    if (created && pathExists(node)) error.message += `；失败节点保留 ${rejectNode(node)}`;
    throw error;
  } finally { releaseWorkNode(node); }
}

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

function setWidgetGeometries(input) {
  const state = refreshState(requireSession());
  if (Object.values(zerosOf(state.rp)).some(Boolean)) throw new Error('链尾结构不健康，请先 verify。');
  if (input.edits && (input.target !== undefined || input.widget !== undefined || input.x !== undefined || input.y !== undefined || input.w !== undefined || input.h !== undefined)) {
    throw new Error('edits 批量模式不能混用单条参数。');
  }
  const edits = input.edits ?? [input];
  const resolved = edits.map(edit => {
    const effTarget = edit.target ?? (edit.widget !== undefined ? { name: edit.widget, ...(edit.page !== undefined ? { page: edit.page } : {}) } : undefined);
    if (effTarget === undefined) throw new Error('set_widget_geometry 需要 target 或 widget。');
    const x = edit.x;
    const y = edit.y;
    const w = edit.w ?? edit.width;
    const h = edit.h ?? edit.height;
    if (x === undefined && y === undefined && w === undefined && h === undefined) {
      throw new Error('set_widget_geometry 至少需要提供 x、y、w/width、h/height 之一。');
    }
    const cand = resolveTarget(state, effTarget);
    return { cand, record: cand.record, id: cand.id, x, y, w, h };
  });
  const tail = state.chain.at(-1), node = nextWorkNode(state);
  let created = false;
  try {
    assertNotProtected(tail); assertWritable(node);
    let fileBuf = readFileSync(tail);
    const byRecord = new Map();
    for (const item of resolved) {
      if (!byRecord.has(item.record)) byRecord.set(item.record, []);
      byRecord.get(item.record).push(item);
    }
    const applied = [];
    for (const [recIdx, items] of byRecord.entries()) {
      const rec = readRecords(fileBuf).find(r => r.index === recIdx);
      if (!rec) throw new Error(`记录 #${recIdx} 不存在`);
      const graph = parsePayload(rec);
      const strings = [...rec.strings];
      for (const item of items) {
        const obj = graph.objects.get(item.id);
        const st = graph.objects.get(field(obj?.body ?? {}, 'MyStyle')?.value);
        if (!st) throw new Error(`元件 ${item.cand.name || item.id} 缺少 MyStyle`);
        const propItems = field(st.body, 'PropList')?.items ?? [];
        const before = { x: item.cand.x, y: item.cand.y, w: item.cand.w, h: item.cand.h };
        const after = {
          x: item.x !== undefined ? Number(item.x) : before.x,
          y: item.y !== undefined ? Number(item.y) : before.y,
          w: item.w !== undefined ? Number(item.w) : before.w,
          h: item.h !== undefined ? Number(item.h) : before.h,
        };
        for (const it of propItems) {
          const doaNode = field(it, 'DOAName');
          const key = (doaNode?.value ?? 0) & 0x3fffffff;
          const val = field(it, 'Value');
          if (key === 101 && val && (item.x !== undefined || item.y !== undefined)) {
            doaNode.value = (0xc0000000 + 101) >>> 0;
            if (item.x !== undefined && field(val, 'X')) field(val, 'X').value = after.x;
            if (item.y !== undefined && field(val, 'Y')) field(val, 'Y').value = after.y;
          }
          if (key === 105 && val && (item.w !== undefined || item.h !== undefined)) {
            doaNode.value = (0xc0000000 + 105) >>> 0;
            if (item.w !== undefined && field(val, 'Width')) field(val, 'Width').value = after.w;
            if (item.h !== undefined && field(val, 'Height')) field(val, 'Height').value = after.h;
          }
        }
        applied.push({ record: item.record, id: item.id, name: item.cand.name, page: item.cand.page, before, after });
      }
      fileBuf = replaceRecord(fileBuf, rec, encodeRecord(rec, strings, encodePayload(graph.roots)));
    }
    writeFileSync(node, fileBuf, { flag: 'wx' }); created = true;
    commitChainNode(state, node, { op: 'set_widget_geometry', at: now(), edits: applied, node });
    const syncStatus = computeSyncStatus(state);
    return {
      status: 'completed',
      ...(applied.length === 1 ? { before: applied[0].before, after: applied[0].after } : {}),
      edits: applied,
      chainTail: node,
      previousTail: tail,
      structure: zerosOf(state.rp),
      ...(syncStatus ? { syncStatus } : {}),
    };
  } catch (error) {
    if (created && pathExists(node)) error.message += `；失败节点保留 ${rejectNode(node)}`;
    throw error;
  } finally { releaseWorkNode(node); }
}

function setWidgetStyles(input) {
  const state = refreshState(requireSession());
  if (Object.values(zerosOf(state.rp)).some(Boolean)) throw new Error('链尾结构不健康，请先 verify。');
  if (input.edits && (input.target !== undefined || input.widget !== undefined || input.fill !== undefined || input.stroke !== undefined || input.color !== undefined || input.radius !== undefined)) {
    throw new Error('edits 批量模式不能混用单条参数。');
  }
  const edits = input.edits ?? [input];
  const resolved = edits.map(edit => {
    const effTarget = edit.target ?? (edit.widget !== undefined ? { name: edit.widget, ...(edit.page !== undefined ? { page: edit.page } : {}) } : undefined);
    if (effTarget === undefined) throw new Error('set_widget_style 需要 target 或 widget。');
    const { fill, stroke, color, radius } = edit;
    if (fill === undefined && stroke === undefined && color === undefined && radius === undefined) {
      throw new Error('set_widget_style 至少需要提供 fill、stroke、color、radius 之一。');
    }
    if (fill !== undefined) parseHexArgb(fill);
    if (stroke !== undefined) parseHexArgb(stroke);
    if (color !== undefined) parseHexArgb(color);
    if (radius !== undefined && (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0)) {
      throw new Error(`非法圆角 radius: ${radius}（期望非负数字）`);
    }
    const cand = resolveTarget(state, effTarget);
    return { cand, record: cand.record, id: cand.id, fill, stroke, color, radius };
  });
  const tail = state.chain.at(-1), node = nextWorkNode(state);
  let created = false;
  try {
    assertNotProtected(tail); assertWritable(node);
    let fileBuf = readFileSync(tail);
    const byRecord = new Map();
    for (const item of resolved) {
      if (!byRecord.has(item.record)) byRecord.set(item.record, []);
      byRecord.get(item.record).push(item);
    }
    const applied = [];
    for (const [recIdx, items] of byRecord.entries()) {
      const rec = readRecords(fileBuf).find(r => r.index === recIdx);
      if (!rec) throw new Error(`记录 #${recIdx} 不存在`);
      const graph = parsePayload(rec);
      const strings = [...rec.strings];
      for (const item of items) {
        const obj = graph.objects.get(item.id);
        const st = graph.objects.get(field(obj?.body ?? {}, 'MyStyle')?.value);
        if (!st) throw new Error(`元件 ${item.cand.name || item.id} 缺少 MyStyle`);
        const propItems = field(st.body, 'PropList')?.items ?? [];
        const before = {};
        const after = {};
        let hitColor = false, hitFill = false, hitStroke = false, hitRadius = false;
        for (const it of propItems) {
          const doaNode = field(it, 'DOAName');
          const key = (doaNode?.value ?? 0) & 0x3fffffff;
          const val = field(it, 'Value');
          if (key === 6 && val) {
            before.color = formatHexArgb(field(val, 'fill-color')?.value);
            if (item.color !== undefined) {
              doaNode.value = (0xc0000000 + 6) >>> 0;
              const argb = parseHexArgb(item.color);
              if (field(val, 'fill-color')) field(val, 'fill-color').value = argb;
              after.color = formatHexArgb(argb);
              hitColor = true;
            }
          }
          if (key === 7 && val) {
            before.fill = formatHexArgb(field(val, 'fill-color')?.value);
            if (item.fill !== undefined) {
              doaNode.value = (0xc0000000 + 7) >>> 0;
              const argb = parseHexArgb(item.fill);
              if (field(val, 'fill-color')) field(val, 'fill-color').value = argb;
              after.fill = formatHexArgb(argb);
              hitFill = true;
            }
          }
          if (key === 8 && val) {
            before.stroke = formatHexArgb(field(val, 'fill-color')?.value);
            if (item.stroke !== undefined) {
              doaNode.value = (0xc0000000 + 8) >>> 0;
              const argb = parseHexArgb(item.stroke);
              if (field(val, 'fill-color')) field(val, 'fill-color').value = argb;
              after.stroke = formatHexArgb(argb);
              hitStroke = true;
            }
          }
          if (key === 15 && val && item.stroke !== undefined) {
            const argb = parseHexArgb(item.stroke);
            if ((argb >>> 24) > 0 && (!val.value || val.value <= 0)) {
              doaNode.value = (0xc0000000 + 15) >>> 0;
              val.value = 1;
            }
          }
          if (key === 80 && val && item.stroke !== undefined) {
            const argb = parseHexArgb(item.stroke);
            if ((argb >>> 24) > 0) {
              doaNode.value = (0xc0000000 + 80) >>> 0;
              val.value = 15;
            }
          }
          if (key === 71 && val) {
            before.radius = val.value;
            if (item.radius !== undefined) {
              doaNode.value = (0xc0000000 + 71) >>> 0;
              val.value = Number(item.radius);
              after.radius = Number(item.radius);
              hitRadius = true;
            }
          }
        }
        if (item.color !== undefined) {
          const argb = parseHexArgb(item.color);
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
        if (item.fill !== undefined && !hitFill) unsupportedProps.push('fill');
        if (item.stroke !== undefined && !hitStroke) unsupportedProps.push('stroke');
        if (item.color !== undefined && !hitColor) unsupportedProps.push('color');
        if (item.radius !== undefined && !hitRadius) unsupportedProps.push('radius');
        if (unsupportedProps.length > 0) {
          throw new Error(`元件 ${item.cand.name || item.id} (${item.cand.type || 'Widget'}) 不支持样式属性: ${unsupportedProps.join(', ')}`);
        }
        applied.push({ record: item.record, id: item.id, name: item.cand.name, page: item.cand.page, before, after: { ...before, ...after } });
      }
      fileBuf = replaceRecord(fileBuf, rec, encodeRecord(rec, strings, encodePayload(graph.roots)));
    }
    writeFileSync(node, fileBuf, { flag: 'wx' }); created = true;
    commitChainNode(state, node, { op: 'set_widget_style', at: now(), edits: applied, node });
    const syncStatus = computeSyncStatus(state);
    return {
      status: 'completed',
      ...(applied.length === 1 ? { before: applied[0].before, after: applied[0].after } : {}),
      edits: applied,
      chainTail: node,
      previousTail: tail,
      structure: zerosOf(state.rp),
      ...(syncStatus ? { syncStatus } : {}),
    };
  } catch (error) {
    if (created && pathExists(node)) error.message += `；失败节点保留 ${rejectNode(node)}`;
    throw error;
  } finally { releaseWorkNode(node); }
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
  return { ...diagnostic, pointer,
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
  const proc = spawnSync('python3', [RP_LANG_CLI, 'dsl-to-json', '--spec', absPath], { encoding: 'utf8' });
  if (proc.status !== 0) {
    let diagPayload = null;
    try { diagPayload = JSON.parse((proc.stderr || proc.stdout || '').trim()); } catch {}
    const firstMsg = diagPayload?.diagnostics?.[0]?.message || (proc.stderr || proc.stdout || '').trim();
    const err = new Error(`解析 RP/1 源码失败：${firstMsg}`);
    if (Array.isArray(diagPayload?.diagnostics)) err.diagnostics = diagPayload.diagnostics;
    throw err;
  }
  return JSON.parse(proc.stdout);
}

export function generatePrototype({ spec: inputSpec, source: sourcePathArg, sourcePath: sourcePathAlias, recipe, output: requestedOutput, strictAudit = false, autoHeal = false, variants, overwrite = false, compact = true, template, baseRp, prefer = 'fail', resolutions }, { beforePublish } = {}) {
  let spec = { language: 'rp/1', target: 9 };
  let stage = 'validation', output, artifactDir, source, resolvedSourceFile = null, plan;
  let publishedRecipeSource = null, publishedRecipeOutput = null;
  try {
    if (typeof inputSpec === 'string' && inputSpec.trimStart().startsWith('{')) inputSpec = JSON.parse(inputSpec);
    if ([inputSpec, sourcePathArg, sourcePathAlias, recipe].filter(v => v !== undefined).length > 1)
      throw new Error('recipe、spec、source、sourcePath 只能选择一个输入入口。');
    if (recipe && (inputSpec || sourcePathArg || sourcePathAlias)) throw new Error('recipe 与 spec/source 只能选择一个。');
    const rawSourceArg = recipe ? recipeSource(recipe) : sourcePathArg ?? sourcePathAlias;
    resolvedSourceFile = typeof rawSourceArg === 'string'
      ? resolve(rawSourceArg)
      : (typeof inputSpec === 'string' ? resolve(inputSpec) : null);
    const rawSpecObj = (inputSpec && typeof inputSpec === 'object' && !Array.isArray(inputSpec))
      ? inputSpec
      : (resolvedSourceFile ? loadSpecObjectFromSource(resolvedSourceFile) : null);
    if (!rawSpecObj) {
      throw new Error('arguments.spec 必须是对象（或通过 source 提供 .rp1/.json 路径）');
    }
    spec = { language: 'rp/1', target: 9, ...rawSpecObj };
    if (!Array.isArray(spec.pages) || spec.pages.length < 1) {
      throw new Error('arguments.spec.pages 至少需要 1 项');
    }
    if (typeof requestedOutput !== 'string' || !requestedOutput.trim()) {
      throw new Error('output 必须是有效的 .rp 路径。');
    }
    const defaultRoot = (process.env.AXURE_WRITE_ROOT || '').split(':').filter(Boolean)[0] || process.cwd();
    let effectiveRequestedOutput = requestedOutput;
    if (requestedOutput === 'auto') {
      const baseDir = resolvedSourceFile ? dirname(resolvedSourceFile) : defaultRoot;
      const baseStem = recipe ? recipe : (resolvedSourceFile ? basename(resolvedSourceFile, extname(resolvedSourceFile)) : 'prototype');
      const cand0 = join(baseDir, `${baseStem}.rp`);
      if (!pathExists(cand0)) effectiveRequestedOutput = cand0;
      else {
        for (let v = 2; ; v++) {
          const candV = join(baseDir, `${baseStem}-v${v}.rp`);
          if (!pathExists(candV)) { effectiveRequestedOutput = candV; break; }
        }
      }
    }
    const resolvedOutput = isAbsolute(effectiveRequestedOutput) ? effectiveRequestedOutput : resolve(defaultRoot, effectiveRequestedOutput);
    if (extname(resolvedOutput).toLowerCase() !== '.rp')
      throw new Error('output 必须是新的 .rp 路径。');
    assertWritable(resolvedOutput);
    const recipeOutputSource = recipe ? resolvedOutput.slice(0, -3) + '.rp1' : null;
    if (recipeOutputSource) {
      assertWritable(recipeOutputSource);
      if (pathExists(recipeOutputSource)) throw new Error(`范例源码已存在，请通过 source 继续改稿：${recipeOutputSource}`);
    }
    if (template !== undefined) {
      const resolvedTpl = resolve(template);
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
      const resolvedBaseRp = resolve(baseRp);
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
    artifactDir = mkdtempSync(join(dirname(output), '.' + basename(output, extname(output)) + '.build-'));
    source = join(artifactDir, 'source.json');
    writeFileSync(source, JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' });
    stage = 'compile';
    const compiled = compilePrototype(resolvedSourceFile ?? source, artifactDir, { strictAudit, autoHeal: Boolean(autoHeal) });
    plan = JSON.parse(readFileSync(compiled.planPath, 'utf8'));
    if (!compiled.ok) {
      const error = new Error('原型未通过布局检查。');
      error.diagnostics = (compiled.audit?.failures ?? []).map(f => ({
        severity: 'error', code: 'E_LAYOUT', pointer: '/', pageName: f.page,
        message: typeof f === 'string' ? f : JSON.stringify(f),
      }));
      if (!error.diagnostics.length) error.diagnostics = (compiled.warnings ?? []).map(message => ({
        code: 'E_LAYOUT', pointer: '/', message, pageName: message.match(/^\[([^\]]+)\]/)?.[1],
      }));
      if (!error.diagnostics.length) error.diagnostics = [{ code: 'E_LAYOUT', pointer: '/', message: error.message }];
      throw error;
    }
    stage = 'native';
    const staged = join(artifactDir, 'prototype.rp');
    const prevTpl = process.env.AXURE_BLANK_TEMPLATE_RP9;
    if (template !== undefined) process.env.AXURE_BLANK_TEMPLATE_RP9 = resolve(template);
    let build;
    try {
      build = buildInteractiveRp(compiled.planPath, staged, { backend: 'native' });
    } finally {
      if (template !== undefined) {
        if (prevTpl === undefined) delete process.env.AXURE_BLANK_TEMPLATE_RP9;
        else process.env.AXURE_BLANK_TEMPLATE_RP9 = prevTpl;
      }
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
    const previews = Object.fromEntries(plan.pages.map(p => [p.slug, p.previews?.preview2x ?? p.previews?.preview ?? join(artifactDir, `${p.slug}@2x.png`)]));
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
    const reportPath = join(artifactDir, 'build-report.json');
    writeFileSync(reportPath, JSON.stringify({ ...build, outputRp: output }, null, 2) + '\n', { flag: 'wx' });
    stage = 'output';
    beforePublish?.();
    assertWritable(output);
    if (overwrite) copyFileSync(staged, output);
    else copyFileSync(staged, output, constants.COPYFILE_EXCL);
    if (recipe) publishedRecipeOutput = output;
    const stagedBaseline = `${staged}.baseline.json`;
    const outputBaseline = `${output}.baseline.json`;
    if (pathExists(stagedBaseline)) {
      const baseMeta = JSON.parse(readFileSync(stagedBaseline, 'utf8'));
      baseMeta.outputRp = output;
      baseMeta.rpSha256 = sha256Of(output);
      baseMeta.sourcePath = resolvedSourceFile ?? source;
      baseMeta.sourceSha256 = sha256Of(resolvedSourceFile ?? source);
      writeFileSync(outputBaseline, JSON.stringify(baseMeta, null, 2) + '\n');
      unlinkSync(stagedBaseline);
    }
    unlinkSync(staged);
    if (recipeOutputSource) {
      copyFileSync(resolvedSourceFile, recipeOutputSource, constants.COPYFILE_EXCL);
      publishedRecipeSource = recipeOutputSource;
      resolvedSourceFile = recipeOutputSource;
      const baseMeta = JSON.parse(readFileSync(outputBaseline, 'utf8'));
      baseMeta.sourcePath = resolvedSourceFile;
      baseMeta.sourceSha256 = sha256Of(resolvedSourceFile);
      writeFileSync(outputBaseline, JSON.stringify(baseMeta, null, 2) + '\n');
    }
    const buildPrefix = `.${basename(output, extname(output))}.build-`;
    const currentBuildDirName = basename(artifactDir);
    for (const entry of readdirSync(dirname(output))) {
      if (entry.startsWith(buildPrefix) && entry !== currentBuildDirName) {
        try { rmSync(join(dirname(output), entry), { recursive: true, force: true }); } catch {}
      }
    }
    const sha256 = sha256Of(output);
    const verification = { structure: true, axureOpened: false, guiEdited: false, saveReopened: false, preview: false };
    const nextGuiOutput = (() => {
      const stem = output.slice(0, -3);
      if (!pathExists(`${stem}-gui.rp`)) return `${stem}-gui.rp`;
      for (let n = 2; ; n++) if (!pathExists(`${stem}-gui-${n}.rp`)) return `${stem}-gui-${n}.rp`;
    })();
    const summary = { source: resolvedSourceFile ?? source, baseline: outputBaseline, verification,
      nextActions: [
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
      return {
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
          warnings: (compiled.warnings ?? []).slice(0, 5),
        },
      };
    }
    return { ...summary, report: resultPath, status: 'completed', output, sha256, baseline: pathExists(outputBaseline) ? outputBaseline : null, pages, counts: rp.counts,
      structure, eventCoverage: build.eventCoverage, previews,
      ...(contactSheet ? { contactSheet } : {}),
      ...(statesSheet ? { statesSheet } : {}),
      ...(variantResults ? { variants: variantResults } : {}),
      statePreviews,
      audit: { structuralOk: compiled.structural_ok, aestheticOk: compiled.aesthetic_ok, warnings: compiled.warnings },
      artifacts: { directory: artifactDir, source: resolvedSourceFile ?? source, plan: compiled.planPath, ir: join(artifactDir, 'language-ir.json'), audit: compiled.auditPath, buildReport: reportPath, baseline: pathExists(outputBaseline) ? outputBaseline : null },
      verification,
    };
  } catch (error) {
    if (publishedRecipeSource) rmSync(publishedRecipeSource, { force: true });
    if (publishedRecipeOutput) {
      rmSync(publishedRecipeOutput, { force: true });
      rmSync(`${publishedRecipeOutput}.baseline.json`, { force: true });
    }
    const raw = error.diagnostics ?? [{ code: `E_GENERATE_${stage.toUpperCase()}`, pointer: undefined, message: error.message }];
    let diagnostics = raw.map(d => generationDiagnostic(d, spec, plan));
    let hints = [];
    try { hints = runWorkflow('diagnose', resolvedSourceFile ?? spec).hints ?? []; } catch {}
    if (stage === 'compile' && !raw.some(d => d.code === 'E_LAYOUT')) {
      try {
        const checked = runWorkflow('diagnose', resolvedSourceFile ?? spec);
        if (!checked.ok) diagnostics = checked.diagnostics.map(d => generationDiagnostic(d, spec, plan));
      } catch { /* Preserve the original compiler diagnostic if secondary diagnosis is unavailable. */ }
    }
    const result = { status: 'failed', stage, message: error.message,
      diagnostics, ...(hints.length ? { hints } : {}),
      ...(artifactDir ? { artifacts: { directory: artifactDir, source: resolvedSourceFile ?? source } } : {}),
    };
    if (artifactDir) writeFileSync(join(artifactDir, 'failure.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
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

function syncPrototype({
  mode = 'merge',
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
  prefer = 'fail',
  resolutions,
  expectedRpSha256,
  expectedSemanticHash,
  includeSpec = false,
}, { beforePublish } = {}) {
  let stage = 'validation', tmpDir;
  try {
    if (typeof specArg === 'string' && specArg.trimStart().startsWith('{')) specArg = JSON.parse(specArg);
    const rpInput = rpArg ?? pathArg ?? rpFileArg ?? fileArg;
    const source = sourceArg ?? sourcePathArg ?? (typeof specArg === 'string' ? specArg : undefined);
    const baselineInput = baselineArg ?? baselinePathArg;
    const inlineSpec = (specArg && typeof specArg === 'object' && !Array.isArray(specArg)) ? specArg : undefined;
    const output = outputArg ?? outRpArg;
    const outSource = outSourceArg ?? outSpecArg;

    const activeSession = session ? refreshState(session) : null;
    const statusInfo = computeSyncStatus(rpInput ?? activeSession, source, baseRpArg);
    const rpFile = statusInfo.rpFile ?? (rpInput ? resolve(rpInput) : null);
    if (mode === 'status') {
      return { status: 'completed', mode: 'status', ...statusInfo, syncStatus: statusInfo };
    }
    if (!rpFile || !pathExists(rpFile)) {
      throw Object.assign(new Error(`目标 .rp 文件不存在：${rpFile ?? '(未指定)'}`), { code: 'E_RP_NOT_FOUND' });
    }
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
      if (!isAbsolute(output) || extname(output).toLowerCase() !== '.rp')
        throw Object.assign(new Error('output 必须是 .rp 绝对路径。'), { code: 'E_OUTPUT_PATH' });
      assertNotProtected(output);
      assertWritable(output);
    }
    if (outSource !== undefined) {
      if (!isAbsolute(outSource))
        throw Object.assign(new Error('outSource 必须是绝对路径。'), { code: 'E_OUT_SOURCE_PATH' });
      assertNotProtected(outSource);
      assertWritable(outSource);
    }

    const workParentDir = dirname(output ? resolve(output) : rpFile);
    mkdirSync(workParentDir, { recursive: true });
    tmpDir = mkdtempSync(join(workParentDir, '.zee-rp-sync-'));
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
    if (baseRpArg && pathExists(resolve(baseRpArg))) {
      baseRpFile = resolve(baseRpArg);
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
      const proc = spawnSync('python3', ['-c', pyScript], { encoding: 'utf8' });
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
    const proc = spawnSync('python3', ['-c', pyMerge], { encoding: 'utf8' });
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
    };
  } finally {
    if (tmpDir && pathExists(tmpDir)) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function generateFromImage({
  image: imageArg,
  spec: specArg,
  output: requestedOutput,
  version = 9,
  scale,
  page = '图片还原页',
  replace = [],
  baseRp,
  prefer = 'fail',
  preview = false,
  guiPaste = false,
}) {
  let stage = 'validation', artifactDir, output;
  try {
    if (!isAbsolute(requestedOutput) || extname(requestedOutput).toLowerCase() !== '.rp') {
      throw Object.assign(new Error('output 必须是新的 .rp 绝对路径。'), { code: 'E_OUTPUT_PATH' });
    }
    assertNotProtected(requestedOutput);
    assertWritable(requestedOutput);
    if (pathExists(requestedOutput)) {
      throw Object.assign(new Error(`输出 .rp 已存在，请使用新文件名：${requestedOutput}`), { code: 'E_OUTPUT_EXISTS' });
    }
    if (!imageArg && !specArg) {
      throw Object.assign(new Error('必须提供本地图片路径 image 或已有分层 spec。'), { code: 'E_INPUT_REQUIRED' });
    }
    const imagePath = imageArg ? resolve(imageArg) : null;
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
      const resolvedBaseRp = resolve(baseRp);
      if (!pathExists(resolvedBaseRp)) {
        throw Object.assign(new Error(`baseRp 不存在：${resolvedBaseRp}`), { code: 'E_BASE_RP_NOT_FOUND' });
      }
      const drift = computeSyncStatus(resolvedBaseRp);
      if (drift.nativeChanged && prefer === 'fail') {
        return {
          status: 'conflict',
          stage: 'drift_check',
          code: 'E_NATIVE_DRIFT_PROTECTED',
          message: '目标 baseRp 存在未合并的原生改稿，拒绝在 prefer=fail 下重建覆盖；请先处理改稿或指定 prefer=source。',
          baseRp: resolvedBaseRp,
          syncStatus: drift,
        };
      }
    }

    mkdirSync(dirname(requestedOutput), { recursive: true });
    output = writablePath(requestedOutput);
    artifactDir = mkdtempSync(join(dirname(output), '.' + basename(output, extname(output)) + '.img-build-'));
    const assetsDir = join(dirname(output), basename(output, extname(output)) + '.assets');
    mkdirSync(assetsDir, { recursive: true });
    const specPath = join(artifactDir, 'trace.spec.json');
    const axvgPath = join(artifactDir, 'trace.axvg.json');
    const rp9SpecPath = join(artifactDir, 'trace.rp9.spec.json');

    stage = 'recognize';
    const effectiveScale = scale ?? 2;
    if (specArg) {
      if (typeof specArg === 'string') {
        const resolvedSpec = resolve(specArg);
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
        const patchProc = spawnSync('python3', patchArgs, { encoding: 'utf8' });
        if (patchProc.status !== 0) {
          throw Object.assign(new Error(`OCR 文案替换失败：${(patchProc.stderr || patchProc.stdout || '').trim()}`), { code: 'E_TRACE_PATCH' });
        }
      }
      const curSpec = JSON.parse(readFileSync(specPath, 'utf8'));
      const refForCrop = imagePath || (curSpec.reference && pathExists(curSpec.reference) ? curSpec.reference : null);
      const hasUncropped = (curSpec.frames ?? []).some(f => (f.children ?? []).some(c => c.kind === 'image' && c.crop && !c.imageKey));
      if (hasUncropped && refForCrop) {
        const cropProc = spawnSync('python3', [TRACE_PY, 'crop', specPath, '--source', refForCrop, '-o', specPath, '--scale', String(curSpec.scale ?? effectiveScale)], { encoding: 'utf8' });
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
      const draftProc = spawnSync('python3', draftArgs, { encoding: 'utf8' });
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
      if (!guiPaste) {
        return {
          status: 'failed',
          stage,
          code: 'E_RP11_GUI_PASTE_REQUIRED',
          message: 'RP11 原生格式使用 SQLite 单库，不支持离线直接写出二进制 .rp；已在 artifacts 中生成 RP11 专用 .axvg.json 与分层 spec，请在 Axure RP 11 打开目标工程后设置 guiPaste=true 或调用 axvg_paste 放置。',
          version: 11,
          artifacts: { directory: artifactDir, assetsDir, image: imagePath, spec: specPath, axvg: axvgPath },
        };
      }
      const pasteResult = pasteAxvg(axvgPayload, { version: 11 });
      return {
        status: 'completed',
        backend: 'rp11-axvg-gui-paste',
        version: 11,
        pasteResult,
        artifacts: { directory: artifactDir, assetsDir, image: imagePath, spec: specPath, axvg: axvgPath },
        verification: { recognized: true, structure: false, axureOpened: true, guiEdited: false, saveReopened: false, preview: false },
      };
    }

    stage = 'rp9_spec';
    const rp9Proc = spawnSync('python3', [TRACE_PY, 'rp9-spec', specPath, '-o', rp9SpecPath, '--assets-dir', assetsDir], { encoding: 'utf8' });
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

    stage = 'verify_diff';
    const refSource = imagePath || (traceSpec.reference && pathExists(traceSpec.reference) ? traceSpec.reference : null);
    let previewImgPath = typeof preview === 'string' && pathExists(resolve(preview)) ? resolve(preview) : null;
    if (!previewImgPath && preview === true && process.platform === 'darwin') {
      const autoCapPath = join(artifactDir, 'host-window-capture.png');
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
      if (pathExists(autoCapPath)) previewImgPath = autoCapPath;
    }
    let visualDiff = null;
    if (refSource && pathExists(refSource)) {
      const verifyArgs = [TRACE_PY, 'verify', specPath, '--source', refSource, '-o', artifactDir, '--scale', String(traceSpec.scale ?? effectiveScale)];
      if (previewImgPath) verifyArgs.push('--preview', previewImgPath);
      const verifyProc = spawnSync('python3', verifyArgs, { encoding: 'utf8' });
      const verifyReportPath = join(artifactDir, 'diff-report.json');
      if (pathExists(verifyReportPath)) {
        visualDiff = JSON.parse(readFileSync(verifyReportPath, 'utf8'));
      } else if (verifyProc.stdout) {
        try { visualDiff = JSON.parse(procStdoutJson(verifyProc.stdout)); } catch {}
      }
    }

    stage = 'output';
    copyFileSync(stagedRp, output, constants.COPYFILE_EXCL);
    const outSha256 = sha256Of(output);
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
      rp9SpecPath,
      axvgPath,
      assetsDir,
      savedAssets: rp9Meta.savedAssets ?? [],
      outputRp: output,
      rpSha256: outSha256,
      scale: traceSpec.scale ?? effectiveScale,
      version: 9,
      pageName: rp.pages[0]?.name ?? page,
      sourceMap,
      reviewRegions: rp9Meta.reviewRegions ?? {},
    };
    writeFileSync(baselinePath, JSON.stringify(baselinePayload, null, 2) + '\n');
    unlinkSync(stagedBlank);
    unlinkSync(stagedRp);

    return {
      status: 'completed',
      backend: 'rp9-native-scene',
      version: 9,
      output,
      sha256: outSha256,
      baseline: baselinePath,
      page: { name: rp.pages[0]?.name ?? page, record: rp.pages[0]?.record ?? 2, written: rp.counts.widgets },
      counts: rp.counts,
      widgetCounts: rp9Meta.widgetCounts ?? {},
      structureReview: { ...structureReview.summary, report: structureReviewPath, evidence: structureReview.evidence, nativeHierarchyChanged: false },
      reviewRegions: rp9Meta.reviewRegions ?? {},
      structure,
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
        baseline: baselinePath,
        diffImage: visualDiff?.outputs?.compareAndDiff ?? null,
        hostCompareImage: visualDiff?.outputs?.axurePreviewCompare ?? null,
      },
      verification: {
        recognized: true,
        structure: true,
        axureOpened: Boolean(previewImgPath),
        guiEdited: false,
        saveReopened: false,
        preview: Boolean(previewImgPath),
      },
    };
  } catch (error) {
    const failure = {
      status: 'failed',
      stage,
      code: error.code ?? `E_IMAGE_${stage.toUpperCase()}`,
      message: error.message,
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      ...(artifactDir ? {
        artifacts: {
          directory: artifactDir,
          spec: pathExists(join(artifactDir, 'trace.spec.json')) ? join(artifactDir, 'trace.spec.json') : null,
          axvg: pathExists(join(artifactDir, 'trace.axvg.json')) ? join(artifactDir, 'trace.axvg.json') : null,
          rp9Spec: pathExists(join(artifactDir, 'trace.rp9.spec.json')) ? join(artifactDir, 'trace.rp9.spec.json') : null,
        },
      } : {}),
    };
    if (artifactDir && pathExists(artifactDir)) {
      writeFileSync(join(artifactDir, 'failure.json'), JSON.stringify(failure, null, 2) + '\n');
    }
    return failure;
  }
}

function procStdoutJson(stdout) {
  const text = (stdout ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end >= start ? text.slice(start, end + 1) : '';
}

function resolveReadOnlyState(pathArg) {
  if (pathArg === undefined) return refreshState(requireSession());
  assertNotProtected(pathArg);
  if (!existsSync(pathArg)) throw new Error(`源文件不存在：${pathArg}`);
  const sourceFile = realpathSync.native(pathArg);
  assertNotProtected(sourceFile);
  if (extname(sourceFile).toLowerCase() !== '.rp') throw new Error(`只接受 .rp 源文件：${sourceFile}`);
  const rp = readRp(readFileSync(sourceFile), { path: sourceFile });
  return { sourceFile, chain: [sourceFile], timeline: [], rp };
}

// ---- 意图级工具的实现 ----
const sessionHandlers = {
  axure_open({ path, rp, file, rpFile } = {}) {
    const targetPath = path ?? rp ?? file ?? rpFile;
    if (!targetPath) throw new Error('axure_open 必须提供 path（或 rp/file/rpFile）');
    return overviewOf(openSession(targetPath));
  },
  axure_state() {
    if (!session) return { active: false, hint: '没有活动会话；调用 axure_open <path.rp> 开启，或继续用命令工具的显式路径模式' };
    const state = requireSession();
    const syncStatus = computeSyncStatus(state);
    return { active: true, ...sessionSummary(state), structure: zerosOf(state.rp), ...(syncStatus ? { syncStatus } : {}) };
  },
  axure_save({ as }) {
    const state = refreshState(requireSession());
    const tail = state.chain.at(-1);
    if (Object.values(zerosOf(state.rp)).some(Boolean)) throw new Error('链尾结构不健康，拒绝另存；先 verify 查看问题。');
    if (as === undefined) return { file: tail, sha256: sha256Of(tail), structure: zerosOf(state.rp) };
    assertNotProtected(as);
    assertWritable(as);
    const target = writablePath(as);
    if (existsSync(target)) throw new Error(`目标已存在，axure_save 只写新文件不覆盖：${target}`);
    copyFileSync(tail, target, constants.COPYFILE_EXCL);
    const srcBaseline = findBaselineForRp(tail, undefined, state);
    if (srcBaseline && pathExists(srcBaseline) && !pathExists(`${target}.baseline.json`)) {
      copyFileSync(srcBaseline, `${target}.baseline.json`);
    }
    const digest = sha256Of(target);
    state.timeline.push({ op: 'save', at: now(), from: tail, path: target, sha256: digest });
    return { path: as.startsWith('/') ? as : join(process.cwd(), as), physicalPath: target, sha256: digest, fromChainTail: tail };
  },
  locate({ path, rp, file, rpFile, query, page, type, limit = 50, offset = 0 } = {}) {
    const targetPath = path ?? rp ?? file ?? rpFile;
    const state = targetPath !== undefined ? resolveReadOnlyState(targetPath) : requireSession();
    if (query === undefined && page === undefined && type === undefined) throw new Error('locate 至少提供 query/page/type 之一');
    const candidates = locateCandidates(state, { query, page, type });
    return { file: state.chain.at(-1), total: candidates.length, candidates: candidates.slice(offset, offset + limit).map(candidateView), hasMore: offset + limit < candidates.length, nextOffset: offset + limit < candidates.length ? offset + limit : null };
  },
  inspect({ path, rp, file, rpFile, target, ...rest } = {}) {
    const targetPath = path ?? rp ?? file ?? rpFile;
    const state = targetPath !== undefined ? resolveReadOnlyState(targetPath) : requireSession();
    const effectiveTarget = target ?? (Object.keys(rest).length > 0 ? rest : undefined);
    if (effectiveTarget === undefined) throw new Error('inspect 必须提供 target（或 query/name/record+id）');
    const cand = resolveTarget(state, effectiveTarget);
    const { fullText, x, y, w, h, ...candRest } = cand;
    const graph = graphsOf(state).get(cand.record);
    const widget = graph?.objects.get(cand.id);
    const style = graph?.objects.get(field(widget?.body ?? {}, 'MyStyle')?.value);
    return {
      ...candRest, text: brief(fullText, 200), geometry: { x, y, w, h },
      richText: richRunsDetail(state, cand),
      style: (field(style?.body ?? {}, 'PropList')?.items ?? []).map(p => ({ property: field(p, 'DOAName')?.value, value: scalar(field(p, 'Value'), graph) })),
      interactions: cand.interactions === null
        ? { count: null, human: [], tree: [], note: '嵌套容器内元件的交互树 rp-read 当前不解析（仅页面顶层元件有）' }
        : { count: cand.interactions.length, human: interactionLines(cand.name || `#${cand.id}`, cand.interactions), tree: cand.interactions },
    };
  },
  read_interactions({ path, rp, file, rpFile, page, widget, limit = 20, offset = 0 } = {}) {
    const targetPath = path ?? rp ?? file ?? rpFile;
    const state = targetPath !== undefined ? resolveReadOnlyState(targetPath) : requireSession();
    const pages = page === undefined ? state.rp.pages : state.rp.pages.filter(p => p.name === page);
    if (page !== undefined && pages.length === 0) throw new Error(`页面「${page}」不存在；现有页面：${state.rp.pages.map(p => p.name).join('、')}`);
    const index = widgetIndex(state).filter(w => w.interactions?.length && (page === undefined || w.page === page));
    const matches = widget === undefined ? index : matchByLogicalId(state, index, widget, page);
    const selectedWidgets = widget === undefined || matches.length ? matches
      : index.filter(w => w.name === widget || String(w.id) === widget);
    const owners = pages.flatMap(p => [
      ...(widget === undefined && p.interactions?.length ? [{ kind: 'page', page: p.name, record: p.record, interactions: p.interactions }] : []),
      ...selectedWidgets.filter(w => w.page === p.name).map(w => ({ kind: 'widget', ...w })),
    ]).concat(selectedWidgets.filter(w => !pages.some(p => p.name === w.page)).map(w => ({ kind: 'widget', ...w })));
    const resultFor = selected => ({
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
    const selected = owners.slice(offset, offset + limit);
    let result = resultFor(selected);
    while (selected.length > 1 && Buffer.byteLength(JSON.stringify(result)) > 20000) {
      selected.pop(); result = resultFor(selected);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 20000) result.human = [];
    return result;
  },
  edit_text: editTexts,
  rename_widget: renameWidgets,
  set_widget_geometry: setWidgetGeometries,
  set_widget_style: setWidgetStyles,
  sync_prototype: syncPrototype,
  generate_from_image: generateFromImage,
  verify({ path, rp, file, rpFile, deep, includeCrossPageDuplicates = false } = {}) {
    const targetPath = path ?? rp ?? file ?? rpFile;
    const state = resolveReadOnlyState(targetPath);
    const syncStatus = computeSyncStatus(state);
    const ok = !Object.values(zerosOf(state.rp)).some(Boolean);
    const base = { ok, file: state.chain.at(-1), status: ok ? 'verified' : 'failed', structure: zerosOf(state.rp), ...(syncStatus ? { syncStatus } : {}) };
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
  },
};

// ---- 意图级工具的 MCP 定义（校验复用本文件 validateInput）----
const paragraphSchema = {
  type: 'object',
  properties: {
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    wrapping: { type: 'integer', enum: [0, 1, 2, 3, 4] },
    trimming: { type: 'integer', enum: [0, 2, 3] },
    list: { oneOf: [{ type: 'boolean' }, { type: 'integer', minimum: 0, maximum: 3 }] },
    lineSpacing: { type: 'number', minimum: 0, description: '原生段落 LineSpacing；留空沿用模板值，0 为自动行距。已验 72 显示为 96px 行高' },
    runs: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      text: { type: 'string' },
      style: { type: 'object', description: '允许 fontFamily、size、bold、italic、underline、strikethrough、color；由现有 writer 验证值。' },
      link: { oneOf: [
        { type: 'object', properties: { page: { type: 'string', minLength: 1 }, window: { type: 'string', enum: ['current', 'new'] } }, required: ['page'], additionalProperties: false },
        { type: 'object', properties: { url: { type: 'string', pattern: '^https?://' }, window: { type: 'string', enum: ['current', 'new'] } }, required: ['url'], additionalProperties: false },
      ] },
    }, required: ['text'], additionalProperties: false } },
  },
  required: ['runs'], additionalProperties: false,
};
const richRunsSchema = {
  description: '段落数组（同 set-widget-richtext 的 paragraphs），或 {paragraphs, defaults}；支持 paragraph.lineSpacing/wrapping/trimming/list（布尔或 0-3 级原生列表）、run.link（page 或 HTTP(S) url，可选 window=current/new）及 style 全量键（含 weight/style/stretch/characterSpacing/baseline，键集合由该库校验）',
  oneOf: [
    { type: 'array', items: paragraphSchema },
    { type: 'object', properties: { paragraphs: { type: 'array', items: paragraphSchema }, defaults: { type: 'object' } }, required: ['paragraphs'], additionalProperties: false },
  ],
};
const targetSchema = {
  description: 'locate 返回的定位字段对象（record+id [+container] 精确定位）或 {query[,page][,type]} 搜索（须唯一）或字符串（按名称/文本搜）',
  oneOf: [
    { type: 'object', properties: {
      query: { type: 'string' }, page: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' },
      record: { type: 'number' }, id: { type: 'number' }, container: { type: 'array', items: { type: 'string' } },
    } },
    { type: 'string', minLength: 1 },
  ],
};

export const sessionTools = [
  ...authoringTools({ generate: generatePrototype, sync: syncPrototype, listTools: () => [...listMcpTools(), ...jobTools] }),
  {
    name: 'generate_prototype',
    description: '一次生成完整单页/多页原生 RP9 原型：spec 直接传 RP/1 结构化页面（或 .rp1/.json 文件路径）、共享 theme/palette/components、variables 与交互，自动编译、装配和检查跨页引用及事件覆盖，并记录 <output>.baseline.json 共同基线；无需装配脚本。若提供 baseRp 且检测到原生已改稿，自动按 prefer 执行三方合并或冲突保护。output 为 .rp 路径（相对路径基于 AXURE_WRITE_ROOT 或当前工作目录解析）。',
    inputSchema: { type: 'object', properties: {
      recipe: { type: 'string', enum: ['mobile-cards', 'list-detail', 'step-form'], description: '从完整范例直接生成；与 spec/source 二选一。成功后在 .rp 旁保留独立 .rp1 源码。' },
      spec: { description: 'RP/1 内联对象或 .rp1/.json 文件路径。文件输入优先使用 source；二者互斥。', oneOf: [
        { type: 'string', minLength: 1 }, { type: 'object', properties: {
        language: { type: 'string', enum: ['rp/1', 'RP/1'] }, target: { type: 'integer', enum: [9] },
        domain: { type: 'string', enum: ['mobile', 'web', 'doc', 'test'] },
        device: { type: 'string' }, shell: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
        theme: { type: 'string' }, palette: { type: 'object' }, tokens: { type: 'object' },
        components: { oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }] },
        variables: { oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }] },
        pages: { type: 'array', minItems: 1, items: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' }, domain: { type: 'string', enum: ['mobile', 'web', 'doc', 'test'] }, device: { type: 'string' }, shell: { oneOf: [{ type: 'boolean' }, { type: 'string' }] }, canvas: { oneOf: [{ type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, { type: 'object' }] }, root: { type: 'object' }, master: { type: 'string' }, slot: { type: 'object' } }, required: ['id'] } },
      }, required: ['pages'] }] },
      source: { type: 'string', minLength: 1, description: '可选：RP/1 源码文件绝对路径（.rp1 或 .json），与 spec 二选一（别名 sourcePath）。' },
      sourcePath: { type: 'string', minLength: 1, description: '可选：RP/1 源码文件绝对路径（同 source）。' },
      output: { type: 'string', minLength: 1, description: '输出 .rp 路径（相对路径基于 AXURE_WRITE_ROOT 或当前工作目录解析；传 "auto" 时按源码/范例名自动生成不重名 .rp 路径）。' },
      async: { type: 'boolean', description: 'true 时立即返回生成任务句柄，用 jobs_get(id) 查询最终结果；适合超过客户端超时的大原型。仅 stdio MCP 服务入口支持。' },
      strictAudit: { type: 'boolean', description: 'true 时额外要求美学审计通过；结构检查始终执行。' },
      autoHeal: { type: 'boolean', description: '默认 false，与 CLI 一致。true 时尝试布局自愈；完整重验后回退引入新错误的变更，审计记录接受与回退详情。' },
      variants: { type: 'array', maxItems: 4, description: '可选：一次额外编译多个主题/色板变体并返回对比拼图（每项为主题名字符串或 {id, name, theme, palette, tokens}）。', items: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] } },
      overwrite: { type: 'boolean', description: '可选：为 true 时允许覆盖已存在的无原生漂移 .rp 文件，默认 false。' },
      compact: { type: 'boolean', description: '默认 true：返回成品、源码、预览、验证状态及完整报告路径。false 展开中间产物和事件覆盖信息。' },
      template: { type: 'string', minLength: 1, description: '可选：显式指定 RP9 空白模板 .rp 路径（沙箱环境下无需重启 MCP 即可指定模板）。' },
      baseRp: { type: 'string', minLength: 1, description: '可选：已有 .rp 路径；若检测到原生改稿则自动走三方合并而非静默覆盖。' },
      prefer: { type: 'string', enum: ['fail', 'source', 'native'], description: '当 baseRp 有原生改稿且出现同属性冲突时的策略，默认 fail。' },
      resolutions: { type: 'object', description: '可选：按冲突键（logicalId:prop 或 pointer:prop）指定 source/native/{value}。' },
    }, required: ['output'], additionalProperties: false },
    handler: generatePrototype,
  },
  {
    name: 'sync_prototype',
    description: '源码（RP/1 .rp1/.json 或内联 spec）、MCP 原生改稿与 Axure GUI 改稿三方一致性同步工具。支持 status（检查源码与原生 .rp 是否漂移）、lift（将原生文字/几何/样式/改名/增删元件/交互提取回 RP/1 源码）、merge（基于共同基线做源码与原生改稿三方合并并可输出合并后 .rp 与源码）及 rebuild（带原生改稿防覆盖保护的重建）。默认返回精简变更摘要（summary/lifted*/preserved*）与输出文件路径，避免内联完整源码撑爆上下文；如需在返回 JSON 中内联完整 spec/rp1，可传 includeSpec=true。',
    inputSchema: { type: 'object', properties: {
      mode: { type: 'string', enum: ['status', 'lift', 'merge', 'rebuild'], description: '同步模式：status 检查状态，lift 导回源码，merge 三方合并，rebuild 受保护重建。默认 merge。' },
      source: { type: 'string', minLength: 1, description: 'RP/1 源码路径（.rp1 或 .json，别名 sourcePath）；省略时尝试从基线读取。' },
      sourcePath: { type: 'string', minLength: 1, description: 'RP/1 源码路径（同 source）。' },
      spec: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }], description: '可选：RP/1 源码路径（.rp1 或 .json）或内联 JSON 规格。' },
      rp: { type: 'string', minLength: 1, description: '当前原生 .rp 路径（别名 path/rpFile/file）；省略时使用当前活动会话的链尾或源文件。' },
      path: { type: 'string', minLength: 1, description: '当前原生 .rp 路径（同 rp）。' },
      rpFile: { type: 'string', minLength: 1, description: '当前原生 .rp 路径（同 rp）。' },
      file: { type: 'string', minLength: 1, description: '当前原生 .rp 路径（同 rp）。' },
      baseRp: { type: 'string', minLength: 1, description: '可选：显式指定共同基线 .rp 路径。' },
      baseline: { type: 'string', minLength: 1, description: '可选：显式指定 .baseline.json 路径（别名 baselinePath）。' },
      baselinePath: { type: 'string', minLength: 1, description: '可选：显式指定 .baseline.json 路径（同 baseline）。' },
      output: { type: 'string', minLength: 1, description: '可选：合并或重建后的 .rp 输出绝对路径（别名 outRp）。' },
      outRp: { type: 'string', minLength: 1, description: '可选：合并或重建后的 .rp 输出绝对路径（同 output）。' },
      outSource: { type: 'string', minLength: 1, description: '可选：导回或合并后的源码输出绝对路径（.rp1 或 .json，别名 outSpec）。' },
      outSpec: { type: 'string', minLength: 1, description: '可选：导回或合并后的源码输出绝对路径（.rp1 或 .json，同 outSource）。' },
      prefer: { type: 'string', enum: ['fail', 'source', 'native'], description: '冲突解决策略：fail（默认，报冲突并保留原文件）、source（源码优先）、native（原生改稿优先）。' },
      resolutions: { type: 'object', description: '可选：逐项冲突解决方案映射（键为 logicalId:prop 或 pointer:prop，值为 "source"、"native" 或 {"value": ...}）。' },
      expectedRpSha256: { type: 'string', minLength: 1, description: '可选：乐观并发校验的期望 .rp SHA-256；若磁盘文件已变化则拒绝提交。' },
      expectedSemanticHash: { type: 'string', minLength: 1, description: '可选：期望的基线 semanticHash；若基线已过期则拒绝提交。' },
      includeSpec: { type: 'boolean', description: '可选：是否在返回 JSON 中内联完整 spec/rp1 源码文本，默认 false（仅返回变更摘要与文件路径，避免大响应撑爆上下文）。' },
    }, additionalProperties: false },
    handler: sessionHandlers.sync_prototype,
  },
  {
    name: 'generate_from_image',
    description: '高层图片转原型入口：从本地 UI 截图（或已提取的分层 spec）自动执行 Apple Vision OCR、几何卡片/分割线/图标媒体切片识别、可选文案替换（replace），并在 RP9 下直接写出真实可编辑二进制 .rp（文字、矩形、卡片、圆、分割线为独立原生元件，复杂矢量/图表/裁剪媒体为独立透明 PNG ImageBox，素材持久保存在 <output>.assets 目录），同时记录 <output>.baseline.json 与分层校验摘要。',
    inputSchema: { type: 'object', properties: {
      image: { type: 'string', minLength: 1, description: '本地截图文件绝对路径（PNG/JPG）。' },
      spec: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }], description: '可选：已校对的分层 trace spec 路径或对象（用于二次校对后重建）。' },
      output: { type: 'string', minLength: 1, description: '新生成的二进制 .rp 绝对路径（只写新文件，不覆盖）。' },
      version: { type: 'integer', enum: [9, 11], description: '目标 Axure 版本，默认 9（直接写二进制 .rp）；11 生成 .axvg.json 并需 GUI 粘贴。' },
      scale: { type: 'number', minimum: 0.25, maximum: 4, description: '截图逻辑像素缩放比（如 1 表示 1x，2 表示 Retina 2x）；省略时默认 2。' },
      page: { type: 'string', minLength: 1, description: '生成的目标页面/画板名称，默认「图片还原页」。' },
      replace: {
        type: 'array',
        description: '可选：OCR 文本修正规则列表，每项为 "旧文本=新文本" 或 {old, new}。',
        items: {
          oneOf: [
            { type: 'string', minLength: 3 },
            { type: 'object', properties: { old: { type: 'string', minLength: 1 }, new: { type: 'string' } }, required: ['old', 'new'], additionalProperties: false },
          ],
        },
      },
      baseRp: { type: 'string', minLength: 1, description: '可选：上次生成的 .rp 路径；若检测到已有原生改稿且 prefer=fail，则拒绝静默覆盖。' },
      prefer: { type: 'string', enum: ['fail', 'source', 'native'], description: '当 baseRp 有原生改稿时的保护策略，默认 fail。' },
      preview: { oneOf: [{ type: 'boolean' }, { type: 'string', minLength: 1 }], description: '可选：传入真实 Axure 预览截图路径（或布尔值）进行宿主预览与薄页/原图的像素差分。' },
      guiPaste: { type: 'boolean', description: '当 version=11 时是否立即执行 Axure RP 11 GUI 粘贴，默认 false。' },
    }, required: ['output'], additionalProperties: false },
    handler: sessionHandlers.generate_from_image,
  },
  {
    name: 'axure_open',
    description: '开启编辑会话：红线检查源 .rp → 复制出工作副本链[0]（与源同目录，源主名.work-1.rp）→ 返回总览（页面清单/元件数/交互数、全局变量、母版、结构三零）。每连接一个会话；再次 open 换源重建。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, rp: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 }, rpFile: { type: 'string', minLength: 1 } }, additionalProperties: false },
    handler: sessionHandlers.axure_open,
  },
  {
    name: 'axure_state',
    description: '当前会话快照（缓存摘要；重新检查磁盘用 verify）：源文件、工作副本链全部节点、timeline、链尾结构三零。上下文被压缩后用一次调用恢复状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: sessionHandlers.axure_state,
  },
  {
    name: 'axure_save',
    description: '链尾另存为交付文件（白名单+防覆盖，只写新文件），返回绝对路径与 SHA-256；省略 as 时返回链尾现状（路径/SHA/三零）。',
    inputSchema: { type: 'object', properties: { as: { type: 'string', minLength: 1 } }, additionalProperties: false },
    handler: sessionHandlers.axure_save,
  },
  {
    name: 'locate',
    description: '按名称或显示文本子串搜全文档元件（可选 page/type 过滤），覆盖页面顶层与面板状态/中继器行模板内元件；返回候选（page、record、对象 id、guid、name、text 摘要、type、容器路径），默认最多 50 项，limit/offset 分页并返回 total/hasMore/nextOffset。可选传 path/rp/file 直接只读查询指定 .rp（不建 .work 副本）。把 record+id（嵌套再加 container）喂给 inspect/edit_text，或 set_widget_text 的 --record/--widget。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, rp: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 }, rpFile: { type: 'string', minLength: 1 }, query: { type: 'string' }, page: { type: 'string' }, type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    handler: sessionHandlers.locate,
  },
  {
    name: 'inspect',
    description: '单元件深看：富文本段落/runs 明细（字体/字号/样式/颜色/链接目标）、几何、交互树人类可读展开。target 接受 locate 返回的定位字段（也可直接在顶层传 query/name/page/record/id）；可选传 path/rp/file 直接只读查看指定 .rp。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, rp: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 }, rpFile: { type: 'string', minLength: 1 }, target: targetSchema, query: { type: 'string' }, page: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' }, record: { type: 'number' }, id: { type: 'number' }, container: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
    handler: sessionHandlers.inspect,
  },
  {
    name: 'read_interactions',
    description: '读取完整事件/Case/动作树。分页以统一 items 为准，包含页面事件、顶层元件、嵌套元件和母版；offset 是跳过的拥有者数，returned 是本次条数。contained 仅为嵌套元件的兼容视图，为空不代表本页没有交互。默认 limit=20，响应接近 20KB 时减少条数，按 nextOffset 继续；支持 page/widget（逻辑 ID、原生名称或对象 ID）过滤，可传 path/rp/file 只读查看 .rp。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, rp: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 }, rpFile: { type: 'string', minLength: 1 }, page: { type: 'string' }, widget: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多读取的交互拥有者数量；响应预算可能减少本次 returned。' }, offset: { type: 'integer', minimum: 0, description: '从统一 items 顺序跳过的拥有者数量，默认 0；继续使用 nextOffset。' } }, additionalProperties: false },
    handler: sessionHandlers.read_interactions,
  },
  {
    name: 'edit_text',
    description: '改一个元件的文字：定位（唯一匹配或 locate 定位字段；多匹配报错列候选）→ 经 set-widget-text / set-widget-richtext 库导出写新链节点 → 新节点过 rp-read 三零（失败则坏节点保留 .rejected、链回退并报差异）。text=简单文本；richRuns=富文本段落/runs，可含段落行距、原生列表级别（list）、wrapping/trimming 及链接目标。edits 数组一次批量改多个元件，全部成功才提交，任一失败整批回退。返回逐条 before/after 与新链尾；GUI/预览需另验。',
    inputSchema: { type: 'object', properties: { target: targetSchema, page: { type: 'string' }, widget: { type: 'string' }, text: { type: 'string' }, richRuns: richRunsSchema, edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { target: targetSchema, page: { type: 'string' }, widget: { type: 'string' }, text: { type: 'string' }, richRuns: richRunsSchema }, additionalProperties: false } } }, additionalProperties: false },
    handler: sessionHandlers.edit_text,
  },
  {
    name: 'rename_widget',
    description: '快捷改名：target 为名称/文本或 locate 的 record+id，name（或 newName）为新名称；edits 可批量修改。覆盖页面、面板状态、中继器模板和母版定义。只改元件名，保留文字、身份与交互；允许重名，目标歧义时返回候选。全部成功后提交一个新链节点。',
    inputSchema: { type: 'object', properties: { target: targetSchema, page: { type: 'string' }, widget: { type: 'string' }, name: { type: 'string' }, newName: { type: 'string' }, edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { target: targetSchema, page: { type: 'string' }, widget: { type: 'string' }, name: { type: 'string' }, newName: { type: 'string' } }, additionalProperties: false } } }, additionalProperties: false },
    handler: sessionHandlers.rename_widget,
  },
  {
    name: 'set_widget_geometry',
    description: '快捷修改元件几何位置与尺寸（x、y、w/width、h/height）：定位（target 或 widget+page）→ 更新二进制 MyStyle 坐标与尺寸（DOAName 3221225573 / 3221225577）→ 写新链节点并校验三零。支持单条或 edits 批量修改，改动可被 sync_prototype(lift/merge) 自动导回 RP/1 源码。',
    inputSchema: {
      type: 'object',
      properties: {
        target: targetSchema,
        page: { type: 'string' },
        widget: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number', minimum: 1 },
        width: { type: 'number', minimum: 1 },
        h: { type: 'number', minimum: 1 },
        height: { type: 'number', minimum: 1 },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              target: targetSchema,
              page: { type: 'string' },
              widget: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number', minimum: 1 },
              width: { type: 'number', minimum: 1 },
              h: { type: 'number', minimum: 1 },
              height: { type: 'number', minimum: 1 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: sessionHandlers.set_widget_geometry,
  },
  {
    name: 'set_widget_style',
    description: '快捷修改元件视觉样式（fill 背景色、stroke 边框色、color 文字颜色、radius 圆角）：定位（target 或 widget+page）→ 更新二进制 MyStyle（DOAName 3221225479 / 3221225480 / 3221225478 / 3221225543）及富文本 Run 颜色 → 写新链节点并校验三零。颜色支持 #RRGGBB 或 #RRGGBBAA；改动可被 sync_prototype(lift/merge) 自动导回 RP/1 源码。',
    inputSchema: {
      type: 'object',
      properties: {
        target: targetSchema,
        page: { type: 'string' },
        widget: { type: 'string' },
        fill: { type: 'string', minLength: 4 },
        stroke: { type: 'string', minLength: 4 },
        color: { type: 'string', minLength: 4 },
        radius: { type: 'number', minimum: 0 },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              target: targetSchema,
              page: { type: 'string' },
              widget: { type: 'string' },
              fill: { type: 'string', minLength: 4 },
              stroke: { type: 'string', minLength: 4 },
              color: { type: 'string', minLength: 4 },
              radius: { type: 'number', minimum: 0 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: sessionHandlers.set_widget_style,
  },
  {
    name: 'verify',
    description: '重新读取磁盘链尾（或通过 path/rp/file 指定的 .rp 文件）并校验（包含 GUI 或外部改动）：浅查=三零（unparseable/danglingRefs/problems）；deep=true 加同页重复名（跨页共享组件同名汇总在 duplicateSummary，传 includeCrossPageDuplicates=true 可展开全部）、悬空引用与问题明细、全页全容器遍历统计。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, rp: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 }, rpFile: { type: 'string', minLength: 1 }, deep: { type: 'boolean' }, includeCrossPageDuplicates: { type: 'boolean', description: '可选：deep=true 时是否返回跨页面共享组件同名元件列表，默认 false（仅返回同页内重名元件）。' } }, additionalProperties: false },
    handler: sessionHandlers.verify,
  },
];

const sessionToolIndex = new Map(sessionTools.map(tool => [tool.name, input => {
  validateInput(tool.inputSchema, input);
  const value = tool.handler(input);
  const finish = result => toolResult(result, result.ok === false || result.status === 'failed' || result.status === 'conflict');
  if (value && typeof value.then === 'function') return value.then(finish).catch(error => toolResult({ status: 'failed',
    diagnostics: [{ code: error.code ?? 'E_TOOL_INPUT', message: error.message, nextAction: '检查参数、当前源码及浏览器控制权后重试。' }],
  }, true));
  return finish(value);
}]));
