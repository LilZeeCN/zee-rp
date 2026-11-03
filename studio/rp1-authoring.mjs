import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNodeIndex, normalizeNodeInteractions, normalizeSpecShorthand } from './document.mjs';
import { StudioDocumentStore, VALID_NODE_TYPES, validatePropertiesObject } from './commands.mjs';
import { CORE_COMPONENT_CONTRACTS } from './component-contracts.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const ROOT_POINTER = '/pages/0/root';
const SOURCE_LIMIT = 512 * 1024;
const PARSE = `import json, sys
sys.path.insert(0, sys.argv[1])
from rp_dsl import dsl_to_spec, _scan_token, _parse_value, IDENT_RE
try:
    text = sys.stdin.read()
    spec, spans = dsl_to_spec(text, return_spans=True)
    explicit = {}
    for line, raw in enumerate(text.splitlines(), 1):
        content = raw.strip()
        if not content or content.startswith(('#', '//')): continue
        kind, pos = _scan_token(content, 0, line)
        kind = kind.lstrip(':')
        if kind in ('rp/1', 'page') or kind.startswith('+'): continue
        identity = None
        while pos < len(content):
            token, pos = _scan_token(content, pos, line)
            if token is None: break
            if token.startswith('#') and '=' not in token and identity is None:
                identity = _parse_value(token[1:], line)
            elif token.startswith('id='):
                identity = _parse_value(token[3:], line)
            elif kind != 'use' and identity is None and '=' not in token and not token.startswith(('"', "'", '{', '[', '(')) and IDENT_RE.match(token):
                identity = _parse_value(token, line)
        if identity is not None: explicit[str(line)] = identity
    print(json.dumps({'ok': True, 'spec': spec, 'spans': spans, 'explicit': explicit}, ensure_ascii=False))
except Exception as error:
    diagnostic = getattr(error, 'diagnostic', {'code': 'E_DSL_PARSE', 'message': str(error)})
    print(json.dumps({'ok': False, 'diagnostic': diagnostic}, ensure_ascii=False))
`;

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, ...details, diagnostic: { code, message, ...details } });
}

function parseSource(source, pageId) {
  if (typeof source !== 'string' || !source.trim()) fail('E_RP1_SOURCE_EMPTY', 'source 必须是非空 RP/1 节点片段');
  if (Buffer.byteLength(source) > SOURCE_LIMIT) fail('E_RP1_SOURCE_SIZE', '单次 RP/1 片段不能超过 512 KiB');
  const lines = source.split(/\r?\n/);
  const significant = lines.filter(line => line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('//'));
  if (!significant.length) fail('E_RP1_SOURCE_EMPTY', 'RP/1 片段只有注释，没有节点');
  const full = /^rp\/1(?:\s|$)/.test(significant[0].trim());
  const indent = full ? 0 : Math.min(...significant.map(line => line.length - line.trimStart().length));
  const wrapped = full ? source : `rp/1 target=9\npage #${pageId}\n${lines.map(line => '  ' + line.slice(Math.min(indent, line.length))).join('\n')}`;
  const shift = span => span ? { line: Math.max(1, span.line - (full ? 0 : 2)), column: Math.max(1, span.column - (full ? 0 : 2) + indent) } : null;
  const proc = spawnSync('python3', ['-B', '-c', PARSE, SCRIPTS], { input: wrapped, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (proc.error || proc.status !== 0) fail('E_RP1_PARSER', 'RP/1 解析器未能完成；请检查 Python 与片段大小', { cause: proc.error?.message || proc.stderr?.slice(0, 1000) });
  let parsed;
  try { parsed = JSON.parse(proc.stdout); } catch { fail('E_RP1_PARSER', 'RP/1 解析器返回无效结果'); }
  const locate = pointer => {
    let current = pointer;
    while (current && !parsed.spans?.[current]) current = current.slice(0, current.lastIndexOf('/'));
    const sourceSpan = shift(parsed.spans?.[current || '/']);
    return sourceSpan ? { sourceSpan, line: sourceSpan.line, column: sourceSpan.column, snippet: lines[sourceSpan.line - 1] || '' } : {};
  };
  if (!parsed.ok) {
    const diagnostic = parsed.diagnostic || {};
    const sourceSpan = shift(diagnostic.sourceSpan || { line: diagnostic.line || 1, column: diagnostic.column || 1 });
    fail(diagnostic.code || 'E_DSL_PARSE', diagnostic.message || 'RP/1 片段语法错误', { ...diagnostic, sourceSpan, line: sourceSpan.line, column: sourceSpan.column, snippet: lines[sourceSpan.line - 1] || '' });
  }
  const spec = parsed.spec;
  for (const key of Object.keys(spec)) {
    if (!['language', 'target', 'pages'].includes(key)) fail('E_RP1_SOURCE_UNSUPPORTED', `局部创作不接受顶层 ${key}；请通过现有文档命令修改共享定义`, { field: key, ...locate('/' + key) });
  }
  if (spec.target !== undefined && spec.target !== 9) fail('E_RP1_SOURCE_UNSUPPORTED', '局部 Studio RP/1 入口当前只接受 target=9');
  if (!Array.isArray(spec.pages) || spec.pages.length !== 1 || spec.pages[0].id !== pageId) fail('E_RP1_SOURCE_PAGE', `片段只能修改指定页面 ${pageId}`);
  for (const key of Object.keys(spec.pages[0])) {
    if (!['id', 'root'].includes(key)) fail('E_RP1_SOURCE_UNSUPPORTED', `局部片段不修改页面属性 ${key}`, { field: key, ...locate('/pages/0/' + key) });
  }
  if (!spec.pages[0].root) fail('E_RP1_SOURCE_EMPTY', 'RP/1 片段没有节点');
  const normalized = normalizeSpecShorthand(spec);
  return { root: normalized.pages[0].root, spans: parsed.spans, explicit: parsed.explicit, locate, shift };
}

function entries(index) { return [...new Set(index.byScopedId.values())]; }

function resolveExact(index, target, pageId, pointer, locate) {
  const raw = String(target || '').replace(/^@/, '');
  const exact = index.byScopedId.get(raw);
  const candidates = exact ? [exact] : (index.byId.get(raw) || []).filter(entry => entry.pageId === pageId);
  if (!candidates.length) fail('E_RP1_REFERENCE', `未找到页面 ${pageId} 中的节点 ${raw}`, { nodeId: raw, ...locate(pointer) });
  if (candidates.length !== 1) fail('E_RP1_REFERENCE_SCOPE', `节点 ${raw} 在多个作用域重名，请使用完整作用域路径`, { nodeId: raw, candidates: candidates.map(entry => entry.scopedId), ...locate(pointer) });
  if (candidates[0].pageId !== pageId) fail('E_RP1_REFERENCE_SCOPE', '局部节点修改与元件动作不能跨页面；跨页使用 link', { nodeId: raw, ...locate(pointer) });
  return candidates[0];
}

function nodeRecords(root, pointer = ROOT_POINTER, context = null, result = []) {
  result.push({ node: root, pointer, autoStateRoot: context && root.type === 'box' && root.id === `${context.panel}_${context.state}_root` });
  for (let i = 0; i < (root.children || []).length; i++) nodeRecords(root.children[i], `${pointer}/children/${i}`, null, result);
  for (let i = 0; i < (root.states || []).length; i++) {
    const state = root.states[i];
    if (state.root) nodeRecords(state.root, `${pointer}/states/${i}/root`, { panel: root.id, state: state.id }, result);
  }
  if (root.template) nodeRecords(root.template, `${pointer}/template`, null, result);
  for (const [name, slot] of Object.entries(root.slots || {})) if (slot && typeof slot === 'object' && !Array.isArray(slot)) nodeRecords(slot, `${pointer}/slots/${name}`, null, result);
  return result;
}

function checkReferences(doc, records, index, pageId, locate) {
  const dependencies = { variables: new Set(), components: new Set(), datasets: new Set(), nodes: new Set() };
  const interactions = [];
  const variable = (name, pointer) => {
    if (typeof name !== 'string' || !Object.hasOwn(doc.variables || {}, name)) fail('E_RP1_VARIABLE', `工程中没有声明变量 ${name}`, { variable: name, ...locate(pointer) });
    dependencies.variables.add(name);
  };
  const target = (name, pointer) => {
    const entry = resolveExact(index, name, pageId, pointer, locate);
    // Current browser actions resolve the final local ID. Do not pretend a
    // fully scoped spelling can disambiguate duplicate runtime local IDs.
    if ((index.byId.get(entry.id) || []).filter(e => e.pageId === pageId).length > 1) fail('E_RP1_REFERENCE_SCOPE', `浏览器动作尚不能安全区分重名目标 ${entry.id}；请使用页面内唯一逻辑 ID`, { nodeId: entry.id, ...locate(pointer) });
    dependencies.nodes.add(entry.scopedId);return entry.node;
  };
  const expression = (value, pointer) => {
    if (value && typeof value === 'object') fail('E_RP1_SOURCE_UNSUPPORTED', 'Studio 局部事件表达式只接受标量或 = 开头表达式，尚不支持完整 RP/1 运算 AST', { ...locate(pointer) });
    if (typeof value !== 'string' || !value.startsWith('=')) return;
    for (const match of value.matchAll(/\bvar\.([A-Za-z0-9_]+)|\$([A-Za-z0-9_]+)/g)) variable(match[1] || match[2], pointer);
    for (const match of value.matchAll(/@([A-Za-z0-9_/-]+)|\bwidget\.([A-Za-z0-9_-]+)\.text/g)) target(match[1] || match[2], pointer);
    for (const match of value.matchAll(/\bdataset\.([A-Za-z0-9_-]+)\b/g)) {
      const ds = match[1];
      if (!Object.hasOwn(doc.datasets || {}, ds)) fail('E_RP1_DATASET', `工程中没有数据集 ${ds}`, { dataset: ds, ...locate(pointer) });
      dependencies.datasets.add(ds);
    }
  };
  const navigate = (value, pointer) => {
    const matches = (doc.pages || []).filter(page => page.id === value || page.name === value);
    if (matches.length !== 1) fail('E_RP1_PAGE_REFERENCE', `跳转页面 ${value} 不存在或名称不唯一`, { ...locate(pointer) });
  };
  const dataActionFields = ['type', 'dataset', 'repeater', 'op', 'rowId', 'clearOthers', 'row', 'patch', 'requireNonEmpty', 'onEmptyShow', 'onEmptySelectionShow', 'query', 'field', 'operator', 'order', 'page'];
  const datasetOps = new Set(['add', 'update', 'delete', 'select', 'toggle-select', 'filter', 'sort', 'page']);
  const action = (value, pointer) => {
    if (Array.isArray(value)) { value.forEach((item, i) => action(item, `${pointer}/${i}`)); return; }
    if (typeof value === 'string') { navigate(value, pointer); return; }
    if (!value || typeof value !== 'object') fail('E_RP1_ACTION', '点击交互需要动作对象或数组', { ...locate(pointer) });
    if (Array.isArray(value.cases)) {
      if (Object.keys(value).some(key => key !== 'cases') || !value.cases.length) fail('E_RP1_ACTION', 'cases 必须是非空分支数组', { ...locate(pointer) });
      value.cases.forEach((item, i) => {
        if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['when', 'if', 'condition', 'else', 'actions', 'break'].includes(key)) || !Array.isArray(item.actions)) fail('E_RP1_ACTION', 'Case 只接受条件、else、actions 与 break', { ...locate(`${pointer}/cases/${i}`) });
        expression(item.when ?? item.if ?? item.condition, pointer);
        action(item.actions, `${pointer}/cases/${i}/actions`);
      });
      return;
    }
    if ((value.when !== undefined || value.if !== undefined || value.condition !== undefined) && !value.type) {
      expression(value.when ?? value.if ?? value.condition, pointer);
      if (value.then !== undefined) action(value.then, `${pointer}/then`);
      if (value.actions !== undefined) action(value.actions, `${pointer}/actions`);
      if (value.else !== undefined && value.else !== true) action(value.else, `${pointer}/else`);
      return;
    }
    if (typeof value.type === 'string' && (value.type.startsWith('dataset-') || value.type.startsWith('repeater-'))) {
      const op = value.type.replace(/^(dataset-|repeater-)/, '');
      if (!datasetOps.has(op) || Object.keys(value).some(key => !dataActionFields.includes(key))) {
        fail('E_RP1_ACTION_UNSUPPORTED', `局部 Studio RP/1 不支持动作 ${value.type} 或其字段`, { ...locate(pointer) });
      }
      if (value.dataset) {
        if (typeof value.dataset !== 'string' || !Object.hasOwn(doc.datasets || {}, value.dataset)) {
          fail('E_RP1_DATASET', `工程中没有数据集 ${value.dataset}`, { dataset: value.dataset, ...locate(pointer) });
        }
        dependencies.datasets.add(value.dataset);
      }
      if (value.repeater && !Object.hasOwn(doc.datasets || {}, value.repeater)) {
        target(value.repeater, pointer);
      }
      if (value.onEmptyShow) target(value.onEmptyShow, pointer);
      if (value.onEmptySelectionShow) target(value.onEmptySelectionShow, pointer);
      if (value.query !== undefined) expression(value.query, pointer);
      if (value.page !== undefined) expression(value.page, pointer);
      if (typeof value.rowId === 'string' && value.rowId.startsWith('=')) expression(value.rowId, pointer);
      for (const obj of [value.row, value.patch]) {
        if (obj && typeof obj === 'object') {
          for (const v of Object.values(obj)) expression(v, pointer);
        }
      }
      return;
    }
    const allowed = {
      'show': ['type', 'target'], 'hide': ['type', 'target'], 'toggle': ['type', 'target'],
      'set-text': ['type', 'target', 'text', 'value'],
      'set-var': ['type', 'name', 'variable', 'value', 'expr'],
      'set-variable': ['type', 'name', 'variable', 'value', 'expr'],
      'set-panel-state': ['type', 'target', 'panel', 'state'],
      'link': ['type', 'page', 'to', 'target'], 'navigate': ['type', 'page', 'to', 'target'],
    };
    const fields = allowed[value.type];
    if (!fields || Object.keys(value).some(key => !fields.includes(key))) fail('E_RP1_ACTION_UNSUPPORTED', `局部 Studio RP/1 不支持动作 ${value.type || '(缺少type)'} 或其字段`, { ...locate(pointer) });
    if (value.type === 'link' || value.type === 'navigate') navigate(value.page || value.to || value.target, pointer);
    else if (value.type === 'set-variable' || value.type === 'set-var') { variable(value.variable || value.name, pointer); expression(value.value ?? value.expr, pointer); }
    else {
      const node = target(value.target || value.panel, pointer);
      if (value.type === 'set-text') expression(value.text ?? value.value, pointer);
      if (value.type === 'set-panel-state' && (node.type !== 'dynamic-panel' || ![...(node.states || []).map(state => state.id), 'next', 'prev', 'toggle', 'flip'].includes(value.state))) fail('E_RP1_PANEL_STATE', '切态动作需要真实动态面板及有效状态', { ...locate(pointer) });
    }
  };
  for (const { node, pointer } of records) {
    if (node.component) dependencies.components.add(node.component);
    if (node.dataset) {
      if (typeof node.dataset !== 'string' || !Object.hasOwn(doc.datasets || {}, node.dataset)) fail('E_RP1_DATASET', `工程中没有数据集 ${node.dataset}`, { ...locate(pointer + '/dataset') });
      dependencies.datasets.add(node.dataset);
    }
    const scan = (value, path) => {
      if (!value || typeof value !== 'object') { if (typeof value === 'string' && value.startsWith('=')) expression(value, path);return; }
      if (!Array.isArray(value) && typeof value.variable === 'string') variable(value.variable, path);
      for (const [key, child] of Object.entries(value)) if (!['children', 'states', 'template', 'slots', 'on'].includes(key)) scan(child, `${path}/${key}`);
    };
    scan(node, pointer);
    if (node.on) {
      if (!node.on || typeof node.on !== 'object' || Array.isArray(node.on) || Object.keys(node.on).some(event => event !== 'click')) fail('E_RP1_EVENT_UNSUPPORTED', '当前 Studio 片段只保证 click 事件；其他 RP/1 事件请通过完整原生原型工作流验证', { ...locate(pointer + '/on') });
      if (Object.hasOwn(node.on, 'click')) {
        action(node.on.click, pointer + '/on/click');
        const actions = Array.isArray(node.on.click) ? node.on.click : [node.on.click];
        interactions.push({
          nodeId: node.id, event: 'click',
          actionTypes: actions.map(item => item && typeof item === 'object'
            ? (item.type || (item.cases ? 'cases' : 'navigate'))
            : 'link'),
        });
      }
    }
  }
  return {
    dependencies: Object.fromEntries(Object.entries(dependencies).map(([key, set]) => [key, [...set]])),
    interactions,
  };
}

/** Parse compact RP/1 into the existing transaction vocabulary. Never writes
 * a source file, changes the live Store, or replaces the document. */
export function prepareRp1Commands({ doc, source, pageId, parentId = null, mode, index: insertIndex } = {}) {
  if (!doc || !Array.isArray(doc.pages)) fail('E_RP1_DOCUMENT', '需要当前权威 Studio 文档');
  if (!['insert', 'update'].includes(mode)) fail('E_RP1_SOURCE_MODE', 'sourceMode 必须明确选择 insert 或 update');
  if (!pageId || !(doc.pages || []).some(page => page.id === pageId)) fail('E_RP1_SOURCE_PAGE', '必须指定当前文档中的 pageId');
  const parsed = parseSource(source, pageId);
  const { root, locate } = parsed;
  const records = nodeRecords(root);
  const ids = new Set();
  for (const { node, pointer, autoStateRoot } of records) {
    const originalSpan = parsed.spans[pointer];
    if (typeof node.id !== 'string' || !node.id.trim() || /[\s/:]/.test(node.id) || (!autoStateRoot && (!originalSpan || parsed.explicit[String(originalSpan.line)] !== node.id))) fail('E_RP1_EXPLICIT_ID', '每个创作节点都需要显式稳定 ID；请写 #id，并用单个显式根容器组织片段', { nodeId: node.id, ...locate(pointer) });
    if (ids.has(node.id)) fail('E_RP1_DUPLICATE_ID', `片段中重复逻辑 ID ${node.id}，不会自动改名`, { nodeId: node.id, ...locate(pointer) });
    ids.add(node.id);
    if (node.type === 'use') { node.type = 'instance';node.props = node.props || node.args || {};delete node.args; }
    if (!VALID_NODE_TYPES.has(node.type)) fail('E_NODE_TYPE', `Studio 当前不支持片段节点类型 ${node.type}；可用类型：${[...VALID_NODE_TYPES].join(', ')}`, { nodeId: node.id, ...locate(pointer) });
    for (const key of ['product', 'bindings', 'binding', 'computed', 'models', 'rules', 'statecharts', 'adaptive', 'onLoad', 'onChange', 'onBack', 'onRight', 'onFocus', 'onBlur']) {
      if (Object.hasOwn(node, key)) fail('E_RP1_SOURCE_UNSUPPORTED', `Studio 局部入口尚不支持 ${key} 语义；请使用完整 RP/1 原型工作流`, { nodeId: node.id, field: key, ...locate(pointer + '/' + key) });
    }
    const props = Object.fromEntries(Object.entries(node).filter(([key]) => !['id', 'type'].includes(key)));
    try { validatePropertiesObject(props, node.id, 0,{creation:true});normalizeNodeInteractions(node); }
    catch (error) { fail(error.code || 'E_RP1_PROPERTY', error.message, { nodeId: node.id, field: error.field, ...locate(pointer + '/' + (error.field || '')) }); }
    if (node.component && !doc.components?.[node.component] && !CORE_COMPONENT_CONTRACTS[node.component]) fail('E_UNKNOWN_COMPONENT', `工程中没有组件 ${node.component}`, { nodeId: node.id, ...locate(pointer + '/component') });
    if (node.src && !doc.assetsManifest?.[node.src]) fail('E_RP1_ASSET', '片段图片需要先通过素材准备登记到当前工程，再引用返回的 src', { nodeId: node.id, ...locate(pointer + '/src') });
    for (const key of ['fill', 'stroke', 'color']) {
      if (typeof node[key] === 'string' && node[key].startsWith('$') && !Object.hasOwn({ ...(doc.palette || {}), ...(doc.tokens?.colors || {}) }, node[key].slice(1))) fail('E_RP1_TOKEN', `工程中没有颜色令牌 ${node[key]}`, { nodeId: node.id, ...locate(pointer + '/' + key) });
    }
    for (const key of ['w', 'h', 'radius']) if (typeof node[key] === 'string' && node[key].startsWith('$')) fail('E_RP1_SOURCE_UNSUPPORTED', `Studio 片段尚不能绑定 ${key} 数值令牌，请提供数值`, { nodeId: node.id, ...locate(pointer + '/' + key) });
  }
  const index = buildNodeIndex(doc);
  const pageEntries = entries(index).filter(entry => entry.pageId === pageId);
  const parent = parentId ? resolveExact(index, parentId, pageId, ROOT_POINTER, locate) : null;
  const commands = [];
  if (mode === 'insert') {
    if (parent && !['box', 'card', 'phone-shell', 'dynamic-panel', 'instance', 'use'].includes(parent.node.type)) fail('E_INVALID_PARENT', '插入目标需要可容纳 children 的普通容器', { nodeId: parent.node.id, ...locate(ROOT_POINTER) });
    if (parent && ['dynamic-panel', 'instance', 'use'].includes(parent.node.type)) fail('E_RP1_SOURCE_UNSUPPORTED', '请将片段插入面板的明确状态根容器；组件内容请使用现有实例覆盖命令', { nodeId: parent.node.id, ...locate(ROOT_POINTER) });
    for (const { node, pointer } of records) if (pageEntries.some(entry => entry.id === node.id)) fail('E_RP1_DUPLICATE_ID', `页面已有逻辑 ID ${node.id}；请使用 update 或选择新的稳定 ID`, { nodeId: node.id, ...locate(pointer) });
    commands.push({ type: 'addNode', pageId, ...(parent ? { parentId: parent.scopedId } : {}), ...(insertIndex !== undefined ? { index: insertIndex } : {}), node: root });
  } else {
    for (const { node, pointer } of records) {
      if (node.states || node.template || node.slots) fail('E_RP1_SOURCE_UNSUPPORTED', 'update 不从片段推断状态、模板或插槽结构替换；请定位叶节点，或使用原有结构命令', { nodeId: node.id, ...locate(pointer) });
      const current = resolveExact(index, node.id, pageId, pointer, locate);
      if (parent && current.path !== parent.path && !current.path.startsWith(parent.path + '/')) fail('E_RP1_SOURCE_SCOPE', `节点 ${node.id} 不在指定更新区域内`, { nodeId: node.id, ...locate(pointer) });
      if (current.node.type !== node.type) fail('E_RP1_SOURCE_TYPE', `update 不改变节点 ${node.id} 类型 ${current.node.type} → ${node.type}`, { nodeId: node.id, ...locate(pointer) });
      const props = Object.fromEntries(
        Object.entries(node).filter(
          ([key, val]) => !['id', 'type', 'children'].includes(key) && JSON.stringify(current.node[key]) !== JSON.stringify(val)
        )
      );
      if (Object.keys(props).length) commands.push({ type: 'setProperties', pageId, nodeId: current.scopedId, properties: props });
      for (const child of node.children || []) {
        const childEntry = resolveExact(index, child.id, pageId, pointer, locate);
        if (childEntry.parent !== current.node) fail('E_RP1_SOURCE_STRUCTURE', 'update 不改变层级；需要移动节点时请使用原有结构命令', { nodeId: child.id, ...locate(pointer) });
      }
    }
  }
  if (!commands.length) fail('E_RP1_SOURCE_NO_CHANGE', '片段没有显式可更新字段');
  const trial = new StudioDocumentStore(doc);
  const result = trial.applyTransaction({ baseRevision: trial.appliedRevision, commands });
  if (!result.ok) {
    const command = commands[result.failedCommandIndex || 0];
    const record = records.find(entry => entry.node.id === (result.nodeId || command.nodeId?.split('/').pop())) || records[0];
    fail(result.code || 'E_RP1_SOURCE_INVALID', result.message, { nodeId: result.nodeId || record.node.id, field: result.field, ...locate(record.pointer) });
  }
  const { dependencies, interactions } = checkReferences(trial.doc, records, buildNodeIndex(trial.doc), pageId, locate);
  return {
    commands,
    format: 'studio-rp1-subset',
    sourceSpans: records.map(({ node, pointer }) => ({ nodeId: node.id, pointer, ...locate(pointer) })),
    diagnostics: [],
    summary: { mode, pageId, rootId: root.id, nodeCount: records.length, commandCount: commands.length, omittedContent: 'preserved', dependencies, interactions },
  };
}
