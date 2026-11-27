import { addInteractionsBatch, resolveBaselineTarget } from './ix-actions.mjs';
import { createGlobalVariable } from './create-global-variable.mjs';
import { writeNativeScene } from './native-scene.mjs';
import { nativeWidgetIdentities } from './native-widget-identity.mjs';
import { readRp } from './rp-read.mjs';

const sourceId = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const kindOf = widget => ({
  VectorShape: 'label', Layer: 'box', TextBox: 'input', DynamicPanel: 'dynamic-panel',
  Checkbox: 'checkbox', RadioButton: 'radio', ComboBox: 'combobox', ListBox: 'listbox',
  ImageBox: 'image',
}[widget.type] ?? 'label');
const target = widget => ({ page: widget.page, guid: widget.guid });
const pageKeyOf = (document, page) => document.packages.find(p => p.record === page.record)?.guid ?? page.name;
const problem = (code, message, pointer = '/program') => Object.assign(new Error(message), { code, diagnostics: [{ code, message, pointer }] });

function layoutStub(id, widget) {
  const type = kindOf(widget);
  const node = { id, type: type === 'image' ? 'label' : type, w: 32, h: 32 };
  if (type === 'box') node.children = [];
  if (['combobox', 'listbox'].includes(type)) node.options = [''];
  if (type === 'dynamic-panel') node.states = (widget.panel ?? []).map((state, index) => ({
    id: sourceId.test(state.name ?? '') ? state.name : `state_${index + 1}`, name: state.name,
    root: { type: 'box', id: 'content', children: [] },
  }));
  return node;
}

function candidateLocator(alias, locator, page, widgets, baseline) {
  const match = resolveBaselineTarget(typeof locator === 'string' ? { widget: locator, page: page.name } : locator, baseline);
  const hits = widgets.filter(w => match.guid ? w.guid === match.guid.toLowerCase()
    : Number.isInteger(match.record) && Number.isInteger(match.id) ? w.record === match.record && w.id === match.id
    : w.name === (match.widget ?? match.name));
  if (hits.length !== 1) throw problem('E_PROGRAM_TARGET',
    `页面「${page.name}」的别名「${alias}」匹配 ${hits.length} 个元件，请使用 GUID。`, `/program/targets/${alias}`);
  return hits[0];
}

function translateActions(node, bindings) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(value => translateActions(value, bindings));
  const mapped = {};
  for (const [key, value] of Object.entries(node)) {
    const isTarget = ['target', 'widget', 'widgetPath', 'within', 'repeater', 'panel'].includes(key) ||
      (key === 'name' && ['widget', 'widget-ref'].includes(node.kind));
    Object.defineProperty(mapped, key, { enumerable: true, value: isTarget && typeof value === 'string' && bindings.has(value)
      ? bindings.get(value) : translateActions(value, bindings) });
  }
  return mapped;
}

export function patchNativeProgram(file, document, input, base, baseline, compile) {
  if (document.version !== 9) throw problem('E_PROGRAM_VERSION', '原生程序增量编译目前支持 RP9。');
  const sources = input.programs ?? (input.program ? [input.program] : []);
  if ((input.program && input.programs) || !sources.length) throw problem('E_PROGRAM_INPUT', '请提供 program 或 programs，二选一。');
  const existingWidgets = nativeWidgetIdentities(document);
  const actualById = new Map(), anchors = new Map();
  const canonicalPage = new Map();
  const managed = { ...(base?.programBindings ?? {}) };
  const programs = sources.map((program, index) => {
    const expected = program?.page;
    if (typeof expected !== 'string' || !expected) throw problem('E_PROGRAM_PAGE', '请指定原生程序的页面。');
    const actualName = baseline?.pages.find(p => p.id === expected)?.name ?? expected;
    const found = document.pages.filter(p => p.name === actualName);
    if (found.length !== 1) throw problem('E_PROGRAM_PAGE', `找不到唯一页面「${expected}」。`, `/programs/${index}/page`);
    const page = found[0];
    const previous = managed[pageKeyOf(document, page)];
    const identity = previous?.pageId ?? baseline?.pages.find(p => p.name === page.name)?.id ?? expected;
    const id = sourceId.test(identity) ? identity : `page_${page.record}`;
    if (canonicalPage.has(page.record)) throw problem('E_PROGRAM_PAGE', `页面「${page.name}」只能绑定一份程序。`);
    canonicalPage.set(page.record, id);
    actualById.set(id, page);
    const byAlias = new Map();
    const pageWidgets = existingWidgets.filter(w => w.page === page.name && w.guid !== previous?.driverGuid);
    for (const w of pageWidgets) {
      if (sourceId.test(w.name) && pageWidgets.filter(other => other.name === w.name).length === 1) byAlias.set(w.name, w);
    }
    for (const s of baseline?.symbols ?? []) {
      if (s.pageName !== page.name && s.pageId !== id) continue;
      const name = s.logicalId?.split('/').at(-1);
      if (!sourceId.test(name ?? '') || s.native?.length !== 1) continue;
      const loc = s.native[0];
      const w = pageWidgets.find(item => loc.guid ? item.guid === loc.guid : item.record === loc.record && item.id === loc.id);
      if (w) byAlias.set(name, w);
    }
    const { targets: requested = {}, ...rest } = program;
    for (const [alias, ref] of Object.entries(requested)) {
      if (!sourceId.test(alias)) throw problem('E_PROGRAM_TARGET', `目标别名「${alias}」不是 RP/1 标识符。`);
      byAlias.set(alias, candidateLocator(alias, ref, page, pageWidgets, baseline));
    }
    anchors.set(id, byAlias);
    return { ...rest, page: id };
  });
  const priorVariables = new Set([...actualById.values()].flatMap(page =>
    managed[pageKeyOf(document, page)]?.variableNames ?? []));
  const variableDefs = Object.fromEntries([
    ...document.globalVariables.filter(v => !priorVariables.has(v.name)).map(v => [v.name, { type: 'text', value: v.value }]),
    ...Object.entries(input.variables ?? {}),
  ]);
  const spec = { language: 'rp/1', target: 9, variables: variableDefs, pages: document.pages.map(page => {
    const id = canonicalPage.get(page.record) ?? baseline?.pages.find(p => p.name === page.name)?.id ?? `page_${page.record}`;
    return { id, name: page.name, canvas: [360, 360], root: { type: 'box', id: `rp1_root_${page.record}`,
      children: [...(anchors.get(id) ?? [])].map(([alias, w]) => layoutStub(alias, w)) } };
  }) };
  const compiled = compile(spec, { programs, sharedRoutines: input.sharedRoutines });
  if (!compiled.ok) throw Object.assign(problem(compiled.diagnostics[0]?.code ?? 'E_PROGRAM_COMPILE',
    compiled.diagnostics[0]?.message ?? '交互程序编译失败。'), { diagnostics: compiled.diagnostics });

  const oldVars = new Set(document.globalVariables.map(v => v.name.toLowerCase()));
  let bytes = file;
  for (const [name, definition] of Object.entries(compiled.variables)) {
    const updateDefault = priorVariables.has(name);
    if (updateDefault || !oldVars.has(name.toLowerCase())) {
      bytes = createGlobalVariable(bytes, name, { defaultValue: String(definition.value), updateDefault }).file;
    }
  }
  const driverNames = new Map();
  for (const report of compiled.program.pages) {
    const page = actualById.get(report.page);
    const pageKey = pageKeyOf(document, page);
    const previous = managed[pageKey];
    const driverId = Object.keys(report.callbacks)[0];
    if (driverId) {
      const symbol = compiled.symbols.find(s => s.id === `${report.page}/${driverId}`);
      const oldDriver = previous && existingWidgets.find(w => w.guid === previous.driverGuid && w.page === page.name);
      if (!oldDriver) {
        if (existingWidgets.some(w => w.page === page.name && w.name === symbol.name)) {
          throw problem('E_PROGRAM_TARGET', `页面「${page.name}」已存在同名调度元件，请保留上一版的基线。`);
        }
        bytes = writeNativeScene(bytes, { scene: { items: [{ itemType: 1, type: 0, name: symbol.name,
          visible: false, rect: { location: { x: 0, y: 0 }, size: { width: 1, height: 1 } } }] } },
        { pageRecord: page.record, append: true });
      }
      driverNames.set(report.page, { id: driverId, name: symbol.name, guid: oldDriver?.guid });
    }
  }
  const updated = readRp(bytes);
  const widgets = nativeWidgetIdentities(updated);
  const items = [], mappedSymbols = new Map((base?.sourceMap ?? []).map(s => [s.id, s]));
  for (const pageProgram of compiled.program.pages) {
    const id = pageProgram.page, page = actualById.get(id);
    const pageKey = pageKeyOf(document, page);
    const previous = managed[pageKey];
    const legacyReset = previous?.resetInstalled
      ? previous.variableNames?.find(name => /^rp1flow_[a-f0-9]{10}_busy$/.test(name))
      : undefined;
    let installedResets = new Set(previous?.resetSlots ?? (legacyReset ? [legacyReset] : []));
    const aliases = anchors.get(id);
    const driver = driverNames.get(id);
    if (driver) {
      const found = widgets.find(w => w.page === page.name && (driver.guid ? w.guid === driver.guid : w.name === driver.name));
      if (!found) throw problem('E_PROGRAM_DRIVER', `页面「${page.name}」缺少程序调度元件。`);
      driver.guid = found.guid;
      aliases.set(driver.id, found);
    }
    const bindings = new Map(), ownerWidgets = new Map();
    for (const symbol of compiled.symbols.filter(s => s.pageId === id)) {
      const alias = symbol.id.slice(id.length + 1);
      const widget = aliases.get(alias);
      if (!widget) continue;
      bindings.set(symbol.name, target(widget));
      ownerWidgets.set(symbol.name, widget);
      const prior = mappedSymbols.get(symbol.id) ?? {};
      mappedSymbols.set(symbol.id, { ...prior, ...symbol, id: symbol.id, logicalId: symbol.id, pageId: id, pageName: page.name,
        native: [{ record: widget.record, id: widget.id, guid: widget.guid }],
        ...(alias === driver?.id ? { programPointer: pageProgram.callbacks[alias].sourcePointer } : {}) });
    }
    const keys = [];
    for (const interaction of compiled.pages.find(p => p.id === id).interactions) {
      const w = ownerWidgets.get(interaction.trigger);
      const owner = interaction.trigger === 'page' ? { page: page.name } : bindings.get(interaction.trigger);
      if (!owner) throw problem('E_PROGRAM_TARGET', `无法映射触发对象 ${interaction.trigger}。`);
      const generated = w?.guid === driver?.guid && Boolean(driver);
      const priorEvents = w ? w.interactions ?? [] : page.interactions ?? [];
      for (const ix of interaction.events) {
        // The appended native shape already starts hidden, so the source builder's hide case is redundant.
        const cases = ix.cases.filter(kase => !(driver && kase.description === 'RP/1 initial hidden' &&
          kase.actions.length === 1 && kase.actions[0].target === driver.name));
        if (!cases.length) continue;
        const key = `${w?.guid ?? 'page'}:${ix.event}`;
        const resetOnly = !w && pageProgram.triggers.some(t => t.event === ix.event && t.resetOnly);
        if (!generated && !resetOnly) keys.push(key);
        if (resetOnly && pageProgram.resetSlots.every(slot => installedResets.has(slot))) continue;
        const existing = priorEvents.some(event => event.event === ix.event);
        if (existing && !resetOnly && !input.replaceEvent) {
          throw problem('E_PROGRAM_EVENT_EXISTS', `「${page.name}」的 ${w?.name || interaction.trigger} 已有 ${ix.event}，请指定 replaceEvent。`);
        }
        items.push({ target: owner, interactions: [translateActions({ ...ix, cases }, bindings)], prependEvent: resetOnly && existing,
          replaceEvent: !resetOnly && Boolean(input.replaceEvent) });
        if (!w && ix.event === 'OnLoad') {
          if (!resetOnly) installedResets = new Set();
          for (const slot of pageProgram.resetSlots) installedResets.add(slot);
        }
      }
    }
    if (previous?.keys.some(key => !keys.includes(key))) {
      throw problem('E_PROGRAM_PARTIAL_REPLACE', `页面「${page.name}」重新编译时需包含已安装的事件入口。`);
    }
    managed[pageKey] = { keys, pageId: id, driverGuid: driver?.guid ?? previous?.driverGuid ?? null,
      variableNames: [...new Set([...(previous?.variableNames ?? []), ...pageProgram.generatedVariables])],
      resetSlots: [...installedResets] };
  }
  const candidate = addInteractionsBatch(bytes, items, { widgetIdentities: widgets });
  return { ...candidate, program: compiled.program, sourceMap: [...mappedSymbols.values()], programBindings: managed };
}
