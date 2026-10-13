import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCommands } from './registry.mjs';
import { assertNotProtected, assertWritable, AxureSession } from './engine.mjs';
import { readRp } from './rp-read.mjs';
import { readRecords } from './rp-records.mjs';
import { parsePayload, field, walkNodes } from './parse-payload.mjs';
import { setRecordWidgetText } from './set-widget-text.mjs';
import { setWidgetRichText } from './set-widget-richtext.mjs';
import { EVENTS } from './ix-actions.mjs';

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
    if (matches.length !== 1) throw new Error(`${at} 必须选择具名参数或 args，不能混用`);
    return;
  }
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
    annotations: { readOnlyHint: c.command === 'rp-read' || c.command === 'axvg selftest', destructiveHint: false, openWorldHint: c.command === 'axvg paste' },
  })), ...sessionTools.map(({ name, description, inputSchema }) => ({
    name, description, inputSchema,
    annotations: { readOnlyHint: ['axure_state', 'locate', 'inspect', 'read_interactions', 'verify'].includes(name), destructiveHint: false, openWorldHint: false },
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
  const value = { exitCode: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString(), status: result.status === 0 ? 'completed' : 'failed' };
  if (result.status !== 0) {
    if (node && !/EEXIST|already exists/i.test(value.stderr) && pathExists(node)) value.rejected = rejectNode(node);
    value.usage = command.usage;
    value.candidates = errorCandidates(command, input, args, source, value.stderr);
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
    return toolResult({ status: 'error', message: error.message,
      ...(command ? { usage: command.usage } : !sessionToolIndex.has(name) ? { availableTools: listMcpTools().map(t => t.name) } : {}),
      ...(error.candidates ? { candidates: error.candidates } : {}),
    }, true);
  }
}

// 同一 stdio 服务进程只接一个连接；修改调用全为同步事务，没有跨 await 的链推进竞态。
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

function locateCandidates(state, filter) {
  return widgetIndex(state).filter(item => {
    if (filter.page !== undefined && item.page !== filter.page) return false;
    if (filter.type !== undefined && item.type.toLowerCase() !== filter.type.toLowerCase()) return false;
    if (filter.query !== undefined && !(item.name.includes(filter.query) || item.fullText.includes(filter.query))) return false;
    return true;
  });
}

// target 解析：record+id（可选 container 校验）为显式精确定位；否则按 query/page/type/name 搜索，须唯一。
// 红线不受影响：target 只含定位字段不含路径；写入只发生在源目录链节点上（open 时已过红线+白名单）。
function resolveTarget(state, target) {
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
    const matches = widgetIndex(state).filter(w => w.name === filter.name && (filter.page === undefined || w.page === filter.page) && (filter.type === undefined || w.type.toLowerCase() === filter.type.toLowerCase()));
    if (matches.length === 1) return matches[0];
    const error = new Error(`精确名称「${filter.name}」匹配 ${matches.length} 个元件；请用 locate 的 record+id。`);
    error.candidates = matches.map(candidateView);
    throw error;
  }
  const matches = locateCandidates(state, filter);
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
  session = { sourceFile, chain: [node], timeline: [{ op: 'open', at: now(), source: sourceFile, node }], rp };
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
  return {
    opened: state.sourceFile,
    session: sessionSummary(state),
    pages: rp.pages.map(p => ({ name: p.name, record: p.record, widgets: p.counts.widgets, dynamicPanels: p.counts.dynamicPanels, interactions: p.counts.interactions, namedWidgets: p.counts.namedWidgets })),
    globalVariables: rp.globalVariables,
    masters: rp.sitemap.masters,
    containedWidgets: rp.containedWidgets.length,
    structure: zerosOf(rp),
  };
}

const targetOf = cand => `${cand.page ?? '(无页)'} 记录#${cand.record}/对象${cand.id}「${cand.name || '(未命名)'}」${cand.container.length ? `@${cand.container.join('/')}` : '（顶层）'}`;

function textEdit(state, { target, text, richRuns }) {
  if ((text === undefined) === (richRuns === undefined)) throw new Error('每次编辑必须提供 text 或 richRuns 之一，不能同时提供。');
  const cand = resolveTarget(state, target);
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
  return { before: cand.fullText, after: report?.text ?? text, chainTail: node, previousTail: tail, ...(report ? { report } : {}) };
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
  return { status: 'completed', edits, previousTail, chainTail: state.chain.at(-1), before, after: countsOf(state.rp), structure: zerosOf(state.rp) };
}

// ---- 8 个意图级工具的实现 ----
const sessionHandlers = {
  axure_open({ path }) { return overviewOf(openSession(path)); },
  axure_state() {
    if (!session) return { active: false, hint: '没有活动会话；调用 axure_open <path.rp> 开启，或继续用命令工具的显式路径模式' };
    const state = requireSession();
    return { active: true, ...sessionSummary(state), structure: zerosOf(state.rp) };
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
    const digest = sha256Of(target);
    state.timeline.push({ op: 'save', at: now(), from: tail, path: target, sha256: digest });
    return { path: as.startsWith('/') ? as : join(process.cwd(), as), physicalPath: target, sha256: digest, fromChainTail: tail };
  },
  locate({ query, page, type, limit = 50, offset = 0 }) {
    const state = requireSession();
    if (query === undefined && page === undefined && type === undefined) throw new Error('locate 至少提供 query/page/type 之一');
    const candidates = locateCandidates(state, { query, page, type });
    return { file: state.chain.at(-1), total: candidates.length, candidates: candidates.slice(offset, offset + limit).map(candidateView), hasMore: offset + limit < candidates.length, nextOffset: offset + limit < candidates.length ? offset + limit : null };
  },
  inspect({ target }) {
    const state = requireSession();
    const cand = resolveTarget(state, target);
    const { fullText, x, y, w, h, ...rest } = cand;
    const graph = graphsOf(state).get(cand.record);
    const widget = graph?.objects.get(cand.id);
    const style = graph?.objects.get(field(widget?.body ?? {}, 'MyStyle')?.value);
    return {
      ...rest, text: brief(fullText, 200), geometry: { x, y, w, h },
      richText: richRunsDetail(state, cand),
      style: (field(style?.body ?? {}, 'PropList')?.items ?? []).map(p => ({ property: field(p, 'DOAName')?.value, value: scalar(field(p, 'Value'), graph) })),
      interactions: cand.interactions === null
        ? { count: null, human: [], tree: [], note: '嵌套容器内元件的交互树 rp-read 当前不解析（仅页面顶层元件有）' }
        : { count: cand.interactions.length, human: interactionLines(cand.name || `#${cand.id}`, cand.interactions), tree: cand.interactions },
    };
  },
  read_interactions({ page } = {}) {
    const state = requireSession();
    const pages = page === undefined ? state.rp.pages : state.rp.pages.filter(p => p.name === page);
    if (page !== undefined && pages.length === 0) throw new Error(`页面「${page}」不存在；现有页面：${state.rp.pages.map(p => p.name).join('、')}`);
    const nested = widgetIndex(state).filter(w => w.container.length > 0 && w.interactions.length && (page === undefined || w.page === page));
    return {
      file: state.chain.at(-1),
      contained: nested.map(w => ({ ...candidateView(w), interactions: w.interactions })),
      pages: pages.map(p => ({
        name: p.name,
        pageInteractions: p.interactions,
        widgets: p.widgets.filter(w => w.interactions?.length).map(w => ({ name: w.name || `#${w.id}`, id: w.id, type: w.type, interactions: w.interactions })),
        counts: { interactions: p.counts.interactions },
      })),
      human: pages.flatMap(p => [
        `## ${p.name}`,
        ...interactionLines(`[页面] ${p.name}`, p.interactions),
        ...p.widgets.flatMap(w => interactionLines(w.name || `#${w.id}`, w.interactions)),
      ]).concat(nested.flatMap(w => interactionLines(targetOf(w), w.interactions))),
    };
  },
  edit_text: editTexts,
  verify({ deep } = {}) {
    const state = refreshState(requireSession());
    const base = { file: state.chain.at(-1), status: Object.values(zerosOf(state.rp)).some(Boolean) ? 'failed' : 'verified', structure: zerosOf(state.rp) };
    if (!deep) return base;
    return {
      ...base,
      duplicates: state.rp.duplicates,
      danglingRefs: state.rp.problems.filter(p => p.kind === 'dangling-ref'),
      problems: state.rp.problems,
      pages: state.rp.pages.map(p => ({ name: p.name, record: p.record, widgets: p.counts.widgets, interactions: p.counts.interactions })),
      containedWidgets: state.rp.containedWidgets.length,
      indexedWidgets: widgetIndex(state).length,
    };
  },
};

// ---- 8 个意图级工具的 MCP 定义（校验复用本文件 validateInput）----
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
  {
    name: 'axure_open',
    description: '开启编辑会话：红线检查源 .rp → 复制出工作副本链[0]（与源同目录，源主名.work-1.rp）→ 返回总览（页面清单/元件数/交互数、全局变量、母版、结构三零）。每连接一个会话；再次 open 换源重建。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
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
    description: '按名称或显示文本子串搜全文档元件（可选 page/type 过滤），覆盖页面顶层与面板状态/中继器行模板内元件；返回候选（page、record、对象 id、guid、name、text 摘要、type、容器路径），默认最多 50 项，limit/offset 分页并返回 total/hasMore/nextOffset。guid/recordGuid 是所属包 GUID，不是元件 GUID。把 record+id（嵌套再加 container）喂给 inspect/edit_text，或 set_widget_text 的 --record/--widget。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, page: { type: 'string' }, type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    handler: sessionHandlers.locate,
  },
  {
    name: 'inspect',
    description: '单元件深看：富文本段落/runs 明细（字体/字号/样式/颜色/链接目标）、几何、交互树人类可读展开。target 接受 locate 返回的定位字段。',
    inputSchema: { type: 'object', properties: { target: targetSchema }, required: ['target'], additionalProperties: false },
    handler: sessionHandlers.inspect,
  },
  {
    name: 'read_interactions',
    description: '页面及其状态/行模板、母版定义（省略 page 则全文档）交互总览树：元件→事件→Case→动作，人类可读行 + 结构化树。改交互前先看现状。',
    inputSchema: { type: 'object', properties: { page: { type: 'string' } }, additionalProperties: false },
    handler: sessionHandlers.read_interactions,
  },
  {
    name: 'edit_text',
    description: '改一个元件的文字：定位（唯一匹配或 locate 定位字段；多匹配报错列候选）→ 经 set-widget-text / set-widget-richtext 库导出写新链节点 → 新节点过 rp-read 三零（失败则坏节点保留 .rejected、链回退并报差异）。text=简单文本；richRuns=富文本段落/runs，可含段落行距、原生列表级别（list）、wrapping/trimming 及链接目标。edits 数组一次批量改多个元件，全部成功才提交，任一失败整批回退。返回逐条 before/after 与新链尾；GUI/预览需另验。',
    inputSchema: { type: 'object', properties: { target: targetSchema, text: { type: 'string' }, richRuns: richRunsSchema, edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { target: targetSchema, text: { type: 'string' }, richRuns: richRunsSchema }, required: ['target'], additionalProperties: false } } }, additionalProperties: false },
    handler: sessionHandlers.edit_text,
  },
  {
    name: 'verify',
    description: '重新读取磁盘链尾并校验（包含 GUI 或外部改动）：浅查=三零（unparseable/danglingRefs/problems）；deep=true 加重复名、悬空引用与问题明细、全页全容器遍历统计。',
    inputSchema: { type: 'object', properties: { deep: { type: 'boolean' } }, additionalProperties: false },
    handler: sessionHandlers.verify,
  },
];

const sessionToolIndex = new Map(sessionTools.map(tool => [tool.name, input => {
  validateInput(tool.inputSchema, input);
  const value = tool.handler(input);
  return toolResult(value, value.status === 'failed');
}]));
