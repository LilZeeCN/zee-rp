// RP9 native form widgets and state styles, using the installed RP9 library.
// The state map is MyStyle DOA 21; it is independent of InteractionMap events.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneLibraryWidget } from './clone-library-widget.mjs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { detectFileVersion, installRoot } from './version.mjs';

const LIBRARY_PAGES = { input: 'Text Field', radio: 'Radio Button', checkbox: 'Checkbox', combobox: 'Droplist', listbox: 'List Box' };
const STATE_NAMES = { hover: 'MouseOver', selected: 'Selected', disabled: 'Disabled', focused: 'Focused' };
const STYLE_KEYS = new Set(['fill', 'stroke', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'radius', 'strokeWidth', 'align', 'textPaddingX', 'opacity']);

function editor(graph, strings) {
  const guids = graph.roots.find(n => n.tag === 30).values;
  const str = value => {
    const text = String(value);
    let index = strings.indexOf(text);
    if (index < 0) { index = strings.length; strings.push(text); }
    return { tag: 8, value: index + 1, text };
  };
  const int = value => ({ tag: 5, value });
  const num = value => ({ tag: 6, value });
  const bool = value => ({ tag: 25, value });
  const ref = value => ({ tag: 3, value });
  const guid = value => ({ tag: 17, value });
  const list = items => ({ tag: 2, items });
  const map = object => ({ tag: 1, entries: Object.entries(object).map(([key, value]) => [str(key), value]) });
  const put = (body, key, value) => {
    const entry = body.entries.find(([name]) => name.text === key);
    if (entry) entry[1] = value; else body.entries.push([str(key), value]);
  };
  const property = (style, key, value) => {
    const props = field(style.body, 'PropList').items;
    const entry = map({ DOAName: int(0xc0000000 + key), Value: value });
    const index = props.findIndex(p => (field(p, 'DOAName').value & 0x3fffffff) === key);
    if (index < 0) props.push(entry); else props[index] = entry;
  };
  const newId = () => { guids.push(randomBytes(16).toString('hex')); return guids.length; };
  const object = (className, body) => {
    const obj = { tag: 9, id: newId(), className, classIndex: str(className).value, body: map(body) };
    graph.objects.set(obj.id, obj);
    graph.roots.splice(graph.roots.length - 1, 0, obj);
    return obj;
  };
  return { graph, strings, guids, str, int, num, bool, ref, guid, list, map, put, property, newId, object };
}

function argb(value) {
  if (value === 'transparent' || value === null) return 0;
  if (typeof value !== 'string' || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) throw new Error(`Native style color must be #RRGGBB or #RRGGBBAA: ${value}`);
  const hex = value.slice(1);
  return parseInt((hex.length === 8 ? hex.slice(6) : 'ff') + hex.slice(0, 6), 16);
}

function writeStyle(e, style, values = {}) {
  const paint = value => e.map({ 'fill-type': e.str('solid'), 'fill-color': e.int(argb(value)) });
  for (const [key, value] of Object.entries(values)) {
    if (!STYLE_KEYS.has(key)) throw new Error(`Unsupported native state style property: ${key}`);
    if (key === 'fill') e.property(style, 7, paint(value));
    else if (key === 'stroke') { e.property(style, 8, paint(value)); e.property(style, 80, e.int(15)); }
    else if (key === 'color') e.property(style, 6, paint(value));
    else if (key === 'fontFamily') e.property(style, 1, e.str(value));
    else if (key === 'fontSize') e.property(style, 2, e.num(value * .75));
    else if (key === 'fontWeight') e.property(style, 1001, e.int(value));
    else if (key === 'radius') e.property(style, 71, e.num(value));
    else if (key === 'strokeWidth') e.property(style, 15, e.num(value));
    else if (key === 'opacity') e.property(style, 70, e.num(value));
    else if (key === 'align') {
      if (!['left', 'center', 'right'].includes(value)) throw new Error(`Unsupported native text alignment: ${value}`);
      e.property(style, 9, e.int({ left: 0, center: 1, right: 2 }[value]));
    } else if (key === 'textPaddingX') {
      e.property(style, 11, e.num(value)); e.property(style, 13, e.num(value));
    }
  }
}

// State styles retain complete unchecked defaults, like RP9's own style records.
function defaultProperties(file, e) {
  const record = readRecords(file).find(r => r.className === 'Axure:DesignDocument');
  const graph = parsePayload(record);
  const document = [...graph.objects.values()].find(o => o.className === 'Axure:DesignDocument');
  const sheet = graph.objects.get(field(document.body, 'StyleSheet').value);
  const defaults = graph.objects.get(field(sheet.body, 'DefaultStyle').value);
  const guids = graph.roots.find(n => n.tag === 30).values;
  const props = structuredClone(field(defaults.body, 'PropList'));
  walkNodes([props], node => {
    if (node.tag === 8) Object.assign(node, e.str(node.text));
    if (node.tag === 17) {
      const value = guids[node.value - 1];
      let index = e.guids.indexOf(value) + 1;
      if (!index) { e.guids.push(value); index = e.guids.length; }
      node.value = index;
    }
  });
  for (const prop of props.items) field(prop, 'DOAName').value = 0x80000000 + (field(prop, 'DOAName').value & 0x3fffffff);
  return props;
}

function writeWidget(e, widget, config, file) {
  if (config.selected !== undefined) e.put(widget.body, 'Selected', e.bool(config.selected));
  if (config.disabled !== undefined) e.put(widget.body, 'Disabled', e.bool(config.disabled));
  if (config.selectionGroup !== undefined) e.put(widget.body, 'SelectedStyleGroup', e.str(config.selectionGroup));
  if (config.visible !== undefined) e.put(widget.body, 'VisibleFromSettings', e.bool(config.visible));
  const style = e.graph.objects.get(field(widget.body, 'MyStyle')?.value);
  if (!style) throw new Error(`Native widget ${config.name} has no MyStyle`);
  if (config.style) writeStyle(e, style, config.style);
  if (!config.styles || !Object.keys(config.styles).length) return;
  const props = field(style.body, 'PropList').items;
  let states = props.find(p => (field(p, 'DOAName').value & 0x3fffffff) === 21);
  if (!states) { e.property(style, 21, e.map({})); states = props.at(-1); }
  field(states, 'DOAName').value = 0xc0000015;
  const stateMap = field(states, 'Value');
  let nullId = e.guids.indexOf('0'.repeat(32)) + 1;
  if (!nullId) { e.guids.push('0'.repeat(32)); nullId = e.guids.length; }
  for (const [name, values] of Object.entries(config.styles)) {
    const stateName = STATE_NAMES[name];
    if (!stateName) throw new Error(`Unsupported native style state: ${name}`);
    const state = e.object('Axure:Style', {
      LibraryId: e.guid(nullId), LibraryName: e.str(''), LegacyName: e.str(''),
      'style-name': e.str(stateName), Id: e.guid(e.newId()),
      PropList: defaultProperties(file, e), Capabilities: { tag: 29, value: 'ffffffffffffffff' }, All: e.bool(false),
    });
    writeStyle(e, state, values);
    e.put(stateMap, stateName, e.ref(state.id));
  }
}

export function applyNativeWidgetStyles(buffer, configs) {
  if (!configs.length) return buffer;
  if (detectFileVersion(buffer) !== 9) throw new Error('Native form styles require RP 9');
  const matches = configs.map(() => 0);
  let output = buffer;
  for (const index of readRecords(buffer).filter(r => ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(r.className)).map(r => r.index)) {
    const record = readRecords(output).find(r => r.index === index);
    const graph = parsePayload(record), strings = [...record.strings], e = editor(graph, strings);
    let changed = false;
    for (const widget of graph.objects.values()) {
      if (!widget.className.startsWith('Axure:DiagramObject:')) continue;
      const name = field(field(widget.body, 'name-block') ?? {}, 'text')?.text;
      configs.forEach((config, i) => {
        if (name !== config.name) return;
        matches[i]++;
        writeWidget(e, widget, config, output);
        changed = true;
      });
    }
    if (changed) output = replaceRecord(output, record, encodeRecord(record, strings, encodePayload(graph.roots)));
  }
  configs.forEach((config, i) => { if (matches[i] !== 1) throw new Error(`Native style target ${config.name} must be unique; found ${matches[i]}`); });
  return output;
}

function writeText(e, widget, text, style) {
  const block = field(widget.body, 'TextBlock');
  if (block) e.put(block, 'text', e.str(text));
  const rich = field(widget.body, 'RichTextBlock');
  if (!rich) return;
  const paragraphs = field(field(rich, 'attributed-string'), 'Paragraphs');
  paragraphs.items = paragraphs.items.slice(0, 1);
  const inlines = field(paragraphs.items[0], 'Inlines');
  inlines.items = inlines.items.slice(0, 1);
  const run = inlines.items[0];
  e.put(run, 'Text', e.str(text));
  if (style?.fontFamily !== undefined) e.put(run, 'Family', e.str(style.fontFamily));
  if (style?.fontSize !== undefined) e.put(run, 'Size', e.num(style.fontSize * .75));
  if (style?.fontWeight !== undefined) e.put(run, 'Weight', e.int(style.fontWeight));
  if (style?.color !== undefined) e.put(run, 'Color', e.int(argb(style.color)));
}

function replaceNativeSlot(e, widget, slotName) {
  const slots = [...e.graph.objects.values()].filter(object => object.className.startsWith('Axure:DiagramObject:')
    && field(field(object.body, 'name-block') ?? {}, 'text')?.text === slotName);
  if (slots.length !== 1) throw new Error(`Native form slot ${slotName} must be unique; found ${slots.length}`);
  const slot = slots[0], slotId = slot.id, widgetId = widget.id, slotStyleId = field(slot.body, 'MyStyle')?.value;
  // cloneLibraryWidget appended the widget to the Page's flat object list.
  // Replace the slot in both that list and its original parent Layer instead.
  walkNodes(e.graph.roots, node => {
    if (node.items) node.items = node.items.filter(item => !(item.tag === 3 && item.value === widgetId));
  });
  let attached = false;
  walkNodes(e.graph.roots, node => { if (node.tag === 3 && node.value === slotId) attached = true; });
  if (!attached) throw new Error(`Native form slot ${slotName} is not attached to its diagram`);
  const parent = field(field(field(slot.body, 'name-block'), 'property-dictionary'), 'parent-diagram-id');
  if (parent) walkNodes([widget.body], node => {
    for (const [key, value] of node.entries ?? []) if (key.text === 'parent-diagram-id') Object.assign(value, structuredClone(parent));
  });
  const visibility = field(slot.body, 'VisibleFromSettings');
  if (visibility?.value === false) e.put(widget.body, 'VisibleFromSettings', e.bool(false));
  // RP9's HTML exporter also follows object-definition/identity order, even
  // when diagram-objects and Layer references have a different order. Reuse
  // the slot identity and its serialized definition position as well.
  e.graph.roots = e.graph.roots.flatMap(node => node === slot ? [widget]
    : node === widget || (node.tag === 9 && node.id === slotStyleId) ? [] : [node]);
  widget.id = slotId;
  walkNodes(e.graph.roots, node => {
    if ([3, 17, 18, 20, 22].includes(node.tag) && node.value === widgetId) node.value = slotId;
    if ([16, 19].includes(node.tag) && node.values[1] === widgetId) node.values[1] = slotId;
  });
  e.graph.objects = new Map(e.graph.roots.filter(node => node.tag === 9).map(node => [node.id, node]));
}

export function materializeNativeControl(sourceFile, outputFile, config) {
  const sourcePageName = LIBRARY_PAGES[config.kind];
  if (!sourcePageName) throw new Error(`Unsupported native form kind: ${config.kind}`);
  const source = readFileSync(sourceFile);
  if (detectFileVersion(source) !== 9) throw new Error('Native form controls require RP 9');
  const work = mkdtempSync(join(tmpdir(), 'zee-native-form-'));
  try {
    const cloneFile = join(work, 'clone.rp');
    const report = cloneLibraryWidget(join(installRoot(9), 'Libraries/Default.rplib'), sourceFile, cloneFile, {
      sourcePageName, targetPageName: config.pageName, name: config.name,
      x: config.x, y: config.y, width: config.width, height: config.height,
    });
    let output = readFileSync(cloneFile);
    const record = readRecords(output).find(r => r.className === 'Axure:Page' && parsePayload(r).objects.has(report.id)
      && field(field(parsePayload(r).objects.get(report.id)?.body ?? {}, 'name-block') ?? {}, 'text')?.text === config.name);
    const graph = parsePayload(record), strings = [...record.strings], e = editor(graph, strings);
    const widget = graph.objects.get(report.id);
    const { kind, checked, group, options, selectedIndex = 0, multiple = false, selectedIndices = [selectedIndex], style } = config;
    if (['input', 'radio', 'checkbox'].includes(kind)) writeText(e, widget, config.text ?? config.value ?? '', style);
    if (kind === 'input' && config.placeholder !== undefined) e.put(widget.body, 'PlaceholderText', e.str(config.placeholder));
    if (['radio', 'checkbox'].includes(kind) && checked !== undefined) e.put(widget.body, 'Selected', e.bool(checked));
    if (kind === 'radio') e.put(widget.body, 'radio-group', e.str(group ?? ''));
    if (kind === 'combobox' || kind === 'listbox') {
      if (!Array.isArray(options) || !options.length || options.some(label => typeof label !== 'string' || !label.length)) throw new Error('Native list options must be a non-empty array of non-empty strings');
      const indices = kind === 'combobox' ? [selectedIndex] : selectedIndices;
      if (!Array.isArray(indices) || indices.some(index => !Number.isInteger(index) || index < 0 || index >= options.length)
        || new Set(indices).size !== indices.length || ((kind === 'combobox' || !multiple) && indices.length > 1)) throw new Error('Native list selected indices must match the options and selection mode');
      const selected = new Set(indices);
      e.put(widget.body, 'multiple', e.bool(kind === 'listbox' && multiple));
      e.put(widget.body, 'list-options', e.list(options.map((label, index) => e.ref(e.object('Axure:SelectObject', { object: e.str(label), selected: e.bool(selected.has(index)) }).id))));
    }
    writeWidget(e, widget, config, output);
    if (config.slotName) replaceNativeSlot(e, widget, config.slotName);
    output = replaceRecord(output, record, encodeRecord(record, strings, encodePayload(graph.roots)));
    writeFileSync(outputFile, output, { flag: 'wx' });
    return { ...report, outputFile, kind, id: widget.id };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
