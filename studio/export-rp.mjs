import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, EXPORTER_VERSION, nodeEvents, sha256,canonicalJson } from './document.mjs';
import { exportCssPlan } from './visual-style.mjs';
import { rasterizeStudioPaint } from './css-raster.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import { repeaterDatasetName, repeaterInlineRows } from './repeater-view.mjs';
import {nodePropertyCapability,STUDIO_SOURCE_ONLY_MACROS} from './node-capabilities.mjs';
import { normalizeVectorNodeSpec, buildRp9ControlPointsForSubpaths } from './vector-paths.mjs';
import { buildInteractiveRp } from '../scripts/proto.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords, encodeRecord, replaceRecord } from '../scripts/rp-records.mjs';
import { parsePayload, encodePayload, field } from '../scripts/parse-payload.mjs';
import { resolveFontDescriptor } from './typography.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// 让导出的 interactions/actions 计数可自证：列出 .rp 内被统计的每个交互来源，
// 并区分「Studio 源稿作者交互」与「导出器为初始隐藏生成的页面 OnLoad hide」。
export function summarizeInteractionSources(rpSummary = {}, { crossPageTextState = [] } = {}) {
  const rows = [];
  const actionTypesOf = ix => (ix.cases || []).flatMap(c => (c.actions || []).map(a => a.type || a.human || 'unknown'));
  const add = (page, owner, ownerId, ix) => {
    const actionTypes = actionTypesOf(ix);
    rows.push({
      page: page.name || page.id || null,
      owner,
      ownerId,
      event: ix.event,
      actionCount: actionTypes.length,
      actionTypes,
      origin: owner === 'widget' && ix.event === 'OnLoad' && actionTypes.length > 0 && actionTypes.every(type => type === 'rotate')
        ? 'export-input-rotation'
        : owner === 'page' && ix.event === 'OnLoad' && actionTypes.length > 0 && actionTypes.every(type => type === 'hide')
        ? 'export-initial-hidden'
        : owner === 'page' && ix.event === 'OnLoad' && crossPageTextState.length && actionTypes.every(type => ['hide', 'set-text', 'set-rich-text-from-variable'].includes(type))
          ? 'export-page-state' : 'authored',
    });
  };
  for (const page of rpSummary.pages || []) {
    for (const ix of page.interactions || []) add(page, 'page', null, ix);
    (function walk(widgets) {
      for (const widget of widgets || []) {
        for (const ix of widget.interactions || []) add(page, 'widget', widget.name || widget.id || null, ix);
        walk(widget.children);
      }
    })(page.widgets);
  }
  const summaryOf = list => ({ interactions: list.length, actions: list.reduce((n, row) => n + row.actionCount, 0) });
  return {
    sources: rows,
    counts: {
      total: summaryOf(rows),
      authored: summaryOf(rows.filter(row => row.origin === 'authored')),
      exportGenerated: {
        ...summaryOf(rows.filter(row => row.origin.startsWith('export-'))),
        reason: '导出器生成 OnLoad 动作，保持初始隐藏、跨页文字和原生输入框旋转；作者事件中的原生状态更新另见 crossPageTextState',
      },
    },
  };
}

function toRp1RuntimeValue(val) {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('=@') && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed.slice(2).trim())) {
      return { widget: trimmed.slice(2).trim() };
    }
    if (trimmed.startsWith('=$') && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed.slice(2).trim())) {
      return { variable: trimmed.slice(2).trim() };
    }
  }
  return val;
}

function normalizeSingleExportAction(act, exportCtx = null) {
  if (!act || typeof act !== 'object') return act;
  const c = structuredClone(act);
  if (c.type === 'set-var') c.type = 'set-variable';
  if (c.type === 'set-variable') {
    if (c.name && !c.variable) {
      c.variable = c.name;
      delete c.name;
    }
    if (c.target && !c.variable) {
      c.variable = c.target;
      delete c.target;
    }
    if (c.expr !== undefined && c.value === undefined) {
      c.value = c.expr;
      delete c.expr;
    }
    c.value = toRp1RuntimeValue(c.value);
    return c;
  }
  if (c.type === 'set-text') {
    if (c.value !== undefined && c.text === undefined) {
      c.text = c.value;
      delete c.value;
    }
    c.text = toRp1RuntimeValue(c.text);
    if (typeof c.text === 'string' && c.text.trim().startsWith('=') || c.text && typeof c.text === 'object') c.text = { fn: 'text', args: [c.text] };
    return c;
  }
  if (c.type === 'navigate') {
    c.type = 'link';
    if (c.to && !c.page) {
      c.page = c.to;
      delete c.to;
    }
    return c;
  }
  if (typeof c.type === 'string' && (c.type.startsWith('dataset-') || c.type.startsWith('repeater-'))) {
    const op = c.type.replace(/^(?:dataset|repeater)-/, '');
    const targetRepeater =
      c.repeater ||
      exportCtx?.datasetToRepeaterId?.get(c.dataset) ||
      exportCtx?.defaultRepeaterId ||
      null;
    if (!targetRepeater) return null;
    const keyField = exportCtx?.repeaterKeyById?.get(targetRepeater) || 'id';
    if (op === 'filter') {
      const rawVal = c.query !== undefined ? c.query : c.value;
      if (rawVal === '' || rawVal === null || rawVal === undefined) {
        return { type: 'data-clear-filter', target: targetRepeater };
      }
      const fieldName = c.field || 'title';
      const valExpr = toRp1RuntimeValue(rawVal);
      const where =
        c.operator === 'includes' || c.operator === 'contains'
          ? { fn: 'contains', args: [{ item: fieldName }, valExpr] }
          : { op: '==', left: { item: fieldName }, right: valExpr };
      const safeName = `filter_${String(fieldName).replace(/[^A-Za-z0-9_-]/g, '_')}`;
      return { type: 'data-filter', target: targetRepeater, name: safeName, where };
    }
    if (op === 'sort') {
      if (!c.field) {
        return { type: 'data-clear-sort', target: targetRepeater };
      }
      const dir =
        c.order === 'desc' || c.direction === 'desc' || c.direction === 'descending'
          ? 'descending'
          : 'ascending';
      return { type: 'data-sort', target: targetRepeater, column: c.field, direction: dir };
    }
    if (op === 'add') {
      const rows = Array.isArray(c.rows) ? c.rows : c.row ? [c.row] : [];
      if (rows.length > 0) {
        return { type: 'data-add', target: targetRepeater, rows };
      }
      return null;
    }
    if (op === 'update' && c.rowId && c.patch && typeof c.patch === 'object') {
      return {
        type: 'data-update',
        target: targetRepeater,
        where: { op: '==', left: { item: keyField }, right: c.rowId },
        set: c.patch,
      };
    }
    if (op === 'delete' && c.rowId) {
      return {
        type: 'data-delete',
        target: targetRepeater,
        where: { op: '==', left: { item: keyField }, right: c.rowId },
      };
    }
    if (op === 'page' && c.page !== undefined) {
      const pVal = c.page === 'prev' ? 'previous' : c.page;
      if (['next', 'previous', 'first', 'last'].includes(pVal) || (Number.isInteger(pVal) && pVal >= 1)) {
        return { type: 'data-page', target: targetRepeater, page: pVal };
      }
      return null;
    }
    return null;
  }
  return c;
}

function normalizeExportEventSpec(evSpec, exportCtx = null) {
  // Studio normalizes an event's conditional block into a one-item array;
  // RP/1 expects cases at the event level, outside the action list.
  if (Array.isArray(evSpec) && evSpec.length === 1 && (Array.isArray(evSpec[0]?.cases) || evSpec[0]?.when !== undefined || evSpec[0]?.if !== undefined)) {
    return normalizeExportEventSpec(evSpec[0], exportCtx);
  }
  if (Array.isArray(evSpec)) {
    const mapped = evSpec.map(item => normalizeSingleExportAction(item, exportCtx)).filter(Boolean);
    return mapped.length > 0 ? mapped : null;
  }
  if (!evSpec || typeof evSpec !== 'object') return evSpec;
  if (evSpec.when !== undefined || evSpec.if !== undefined) {
    const action = { ...evSpec };
    for (const key of ['when', 'if', 'then', 'else']) delete action[key];
    const primary = normalizeExportEventSpec(evSpec.then ?? evSpec.actions ?? (evSpec.type ? [action] : []), exportCtx);
    const fallback = evSpec.else && evSpec.else !== true ? normalizeExportEventSpec(evSpec.else, exportCtx) : null;
    return { cases: [
      { when: evSpec.when ?? evSpec.if, actions: primary },
      ...(fallback ? [{ else: true, actions: fallback }] : []),
    ] };
  }
  if (Array.isArray(evSpec.cases)) {
    const cases = evSpec.cases
      .map(cs => {
        const mappedActions = Array.isArray(cs.actions)
          ? cs.actions.map(item => normalizeSingleExportAction(item, exportCtx)).filter(Boolean)
          : [];
        if (mappedActions.length === 0) return null;
        return {
          ...structuredClone(cs),
          actions: mappedActions,
        };
      })
      .filter(Boolean);
    return cases.length > 0 ? { ...structuredClone(evSpec), cases } : null;
  }
  if (evSpec.type) {
    const single = normalizeSingleExportAction(evSpec, exportCtx);
    return single ? [single] : null;
  }
  const actions = [];
  if (evSpec.setPanelState && typeof evSpec.setPanelState === 'object') {
    const st = evSpec.setPanelState.state === 'flip' ? 'back' : evSpec.setPanelState.state;
    actions.push({ type: 'set-panel-state', target: evSpec.setPanelState.target, state: st });
  }
  if (evSpec.setVar && typeof evSpec.setVar === 'object') {
    for (const [k, v] of Object.entries(evSpec.setVar)) {
      actions.push({ type: 'set-variable', variable: k, value: v });
    }
  }
  if (evSpec.navigate) {
    actions.push({ type: 'link', page: evSpec.navigate });
  }
  return actions.length > 0 ? actions : structuredClone(evSpec);
}

function normalizeExportOn(onObj, exportCtx = null) {
  if (!onObj || typeof onObj !== 'object') return undefined;
  const out = {};
  for (const [ev, spec] of Object.entries(onObj)) {
    const norm = normalizeExportEventSpec(spec, exportCtx);
    if (norm) out[ev] = norm;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Axure only has access to widgets on the loaded page. Keep text written from
// another page in native global variables, then restore it on the target page.
// Local writes to the same target update the backing value too.
function preserveCrossPageText(spec) {
  const nodes = new Map(), owners = [];
  const walk = (node, page, scope = page.id, inRow = false) => {
    if (!node) return;
    const ref = `${scope}/${node.id}`;
    nodes.set(ref, { node, page, inRow });
    owners.push({ node, page, scope });
    for (const child of node.children || []) walk(child, page, scope, inRow);
    for (const state of node.states || []) walk(state.root, page, `${ref}/${state.id}`, inRow);
    if (node.template) walk(node.template, page, `${ref}/item`, true);
  };
  for (const page of spec.pages) walk(page.root, page);
  const resolveTarget = (target, owner) => {
    if (typeof target !== 'string') return null;
    return nodes.has(target) ? target : nodes.has(`${owner.scope}/${target}`) ? `${owner.scope}/${target}` : null;
  };
  const visit = (value, fn) => {
    if (Array.isArray(value)) return value.flatMap(item => visit(item, fn));
    if (!value || typeof value !== 'object') return value;
    const out = { ...value };
    for (const key of ['actions', 'then', 'else', 'cases']) {
      if (out[key] && typeof out[key] === 'object') out[key] = visit(out[key], fn);
    }
    return fn(out);
  };
  const tracked = new Map();
  for (const owner of owners) for (const event of Object.values(owner.node.on || {})) {
    visit(event, action => {
      const target = action.type === 'set-text' && resolveTarget(action.target, owner);
      const entry = nodes.get(target);
      if (entry && entry.page !== owner.page && !entry.inRow) {
        const initial = entry.node.text ?? '';
        if (!['label', 'paragraph', 'button', 'badge'].includes(entry.node.type) || typeof initial !== 'string' || initial.startsWith('=') || entry.node.spans?.length) {
          throw Object.assign(new Error(`跨页改字目标 ${target} 需要普通文字元件；动态绑定、富文本、输入控件和行模板请用显式变量与目标页加载事件`), { code: 'E_EXPORT_CROSS_PAGE_TEXT', nodeId: target });
        }
        tracked.set(target, entry);
      }
      return action;
    });
  }
  if (!tracked.size) return [];
  spec.variables ||= {};
  for (const [target, entry] of tracked) {
    let variable = `studio_text_${sha256(target).slice(0, 12)}`;
    while (Object.hasOwn(spec.variables, variable)) variable += '_';
    spec.variables[variable] = entry.node.text ?? '';
    entry.variable = variable;
  }
  for (const owner of owners) for (const [event, value] of Object.entries(owner.node.on || {})) {
    owner.node.on[event] = visit(value, action => {
      const target = action.type === 'set-text' && resolveTarget(action.target, owner);
      const entry = tracked.get(target);
      if (!entry) return action;
      const write = { type: 'set-variable', variable: entry.variable, value: { fn: 'text', args: [action.text] } };
      return entry.page === owner.page
        ? [write, { ...action, text: { variable: entry.variable } }]
        : [write];
    });
  }
  for (const [target, entry] of tracked) {
    entry.page.on ||= {};
    entry.page.on.load ||= [];
    entry.page.on.load.push({ type: 'set-text', target, text: { variable: entry.variable } });
  }
  return [...tracked].map(([target, entry]) => ({ target, variable: entry.variable, targetPageId: entry.page.id, strategy: 'native-global-variable-and-page-load' }));
}

export function findRpWidgetByNodeId(widgets, nodeId) {
  const esc = String(nodeId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const primaryRe = new RegExp(`^(?:[a-z]+-)+${esc}-[0-9a-f]{8,16}$`);
  const bgRe = new RegExp(`^bg-(?:[a-z]+-)+${esc}-[0-9a-f]{8,16}$`);
  const list = widgets || [];
  const primary =
    list.find(w => !bgRe.test(w.name) && (w.name === nodeId || primaryRe.test(w.name)) && typeof w.w === 'number' && typeof w.h === 'number') ||
    list.find(w => !bgRe.test(w.name) && (w.name === nodeId || primaryRe.test(w.name) || w.name?.endsWith(`-${nodeId}`))) ||
    null;
  const bg = list.find(w => bgRe.test(w.name) && typeof w.w === 'number' && typeof w.h === 'number') || null;
  if (primary && bg) {
    return {
      ...primary,
      x: bg.x,
      y: bg.y,
      w: bg.w,
      h: bg.h,
    };
  }
  return primary || bg || null;
}

function patchAndVerifyRpTypography(absOutRp, scene) {
  let buf = readFileSync(absOutRp);
  const rpInitial = readRp(buf, { path: absOutRp });
  const recordsByIndex = new Map(readRecords(buf).map(r => [r.index, r]));
  const targetsByRecord = new Map();

  for (const pgScene of scene.pages) {
    const rpPage =
      (rpInitial.pages || []).find(p => p.name === pgScene.name || p.id === pgScene.id) ||
      rpInitial.pages[scene.pages.indexOf(pgScene)];
    if (!rpPage || rpPage.record === undefined) continue;

    for (const resNode of pgScene.nodes) {
      if (!resNode.visible || !['label', 'paragraph', 'button', 'badge'].includes(resNode.type)) continue;
      const esc = String(resNode.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const primaryRe = new RegExp(`^(?:[a-z]+-)+${esc}-[0-9a-f]{8,16}$`);
      const bgRe = new RegExp(`^bg-(?:[a-z]+-)+${esc}-[0-9a-f]{8,16}$`);
      const textWidget =
        (rpPage.widgets || []).find(w => !bgRe.test(w.name) && (w.name === resNode.id || primaryRe.test(w.name) || w.name?.endsWith(`-${resNode.id}`))) ||
        null;
      if (!textWidget) continue;
      if (!targetsByRecord.has(rpPage.record)) targetsByRecord.set(rpPage.record, []);
      targetsByRecord.get(rpPage.record).push({ pgScene, resNode, widgetId: textWidget.id });
    }
  }

  for (const [recIdx, items] of targetsByRecord.entries()) {
    const record = readRecords(buf).find(r => r.index === recIdx);
    if (!record) continue;
    const graph = parsePayload(record);
    const strings = [...record.strings];
    const intern = text => {
      let idx = strings.indexOf(text);
      if (idx < 0) {
        idx = strings.length;
        strings.push(text);
      }
      return { tag: 8, value: idx + 1, text };
    };
    const mapEntry = entries => ({
      tag: 1,
      entries: Object.entries(entries).map(([k, v]) => [intern(k), v]),
    });

    let modified = false;
    for (const { resNode, widgetId } of items) {
      const widget = graph.objects.get(Number(widgetId));
      if (!widget?.body) continue;
      const targetFont = resNode.fontFamily || 'PingFang SC';
      let block = field(widget.body, 'RichTextBlock');
      if (block?.tag === 3) block = graph.objects.get(block.value)?.body;
      const attributed = field(block ?? {}, 'attributed-string');
      const paragraphs = field(attributed ?? {}, 'Paragraphs');
      if (paragraphs?.items?.length) {
        for (const p of paragraphs.items) {
          const inlines = field(p, 'Inlines')?.items || [];
          for (const inl of inlines) {
            const fam = field(inl, 'Family');
            if (fam && fam.tag === 8) {
              Object.assign(fam, intern(targetFont));
              modified = true;
            }
          }
        }
      }
      const nativeStyle = graph.objects.get(field(widget.body, 'MyStyle')?.value);
      const propList = field(nativeStyle?.body ?? {}, 'PropList');
      if (propList?.items) {
        const entry = mapEntry({
          DOAName: { tag: 5, value: 0xc0000001 },
          Value: intern(targetFont),
        });
        const oldIdx = propList.items.findIndex(pr => (field(pr, 'DOAName')?.value & 0x0fffffff) === 1);
        if (oldIdx < 0) propList.items.push(entry);
        else propList.items[oldIdx] = entry;
        modified = true;
      }
    }

    if (modified) {
      buf = replaceRecord(buf, record, encodeRecord(record, strings, encodePayload(graph.roots)));
    }
  }

  writeFileSync(absOutRp, buf);

  // Verify from saved .rp buffer
  const finalRecords = new Map(readRecords(buf).map(r => [r.index, r]));
  const verifiedItems = [];
  let fontPreservedCount = 0;

  for (const [recIdx, items] of targetsByRecord.entries()) {
    const record = finalRecords.get(recIdx);
    if (!record) continue;
    const graph = parsePayload(record);
    for (const { pgScene, resNode, widgetId } of items) {
      const widget = graph.objects.get(Number(widgetId));
      let block = field(widget?.body ?? {}, 'RichTextBlock');
      if (block?.tag === 3) block = graph.objects.get(block.value)?.body;
      const attributed = field(block ?? {}, 'attributed-string');
      const paragraphs = field(attributed ?? {}, 'Paragraphs');
      const runFamilies = [];
      for (const p of paragraphs?.items || []) {
        for (const inl of field(p, 'Inlines')?.items || []) {
          const fam = field(inl, 'Family');
          if (fam?.text) runFamilies.push(fam.text);
        }
      }
      const nativeStyle = graph.objects.get(field(widget?.body ?? {}, 'MyStyle')?.value);
      const propList = field(nativeStyle?.body ?? {}, 'PropList');
      const styleFamProp = (propList?.items || []).find(pr => (field(pr, 'DOAName')?.value & 0x0fffffff) === 1);
      const styleFamily = field(styleFamProp ?? {}, 'Value')?.text || null;
      const expectedFont = resNode.fontFamily || 'PingFang SC';
      const preserved =
        (runFamilies.length === 0 || runFamilies.every(f => f === expectedFont)) &&
        styleFamily === expectedFont;
      if (preserved) fontPreservedCount++;
      const isFallback = Boolean(resNode.isFontFallback || resNode.fontStatus === 'fallback' || resNode.fontStatus === 'delayed-loading' || (resNode.requestedFontFamily && resNode.requestedFontFamily !== expectedFont));
      const requiresHostFontInstallation = !isFallback && resolveFontDescriptor(expectedFont).isFallback;
      verifiedItems.push({
        pageId: pgScene.id,
        nodeId: resNode.id,
        requestedFont: resNode.requestedFontFamily || resNode.requestedFont || expectedFont,
        resolvedFont: expectedFont,
        rpRunFamily: runFamilies[0] || styleFamily,
        rpStyleFamily: styleFamily,
        fontPreserved: preserved,
        lineCount: resNode.lineCount ?? resNode.lines?.length ?? 1,
        firstBaselineOffset: resNode.firstBaselineOffset,
        lastBaselineOffset: resNode.lastBaselineOffset,
        isFontFallback: isFallback,
        requiresHostFontInstallation,
        hostSubstituteWarning: isFallback
          ? `字体 "${resNode.requestedFontFamily || resNode.requestedFont}" 未安装，导出及宿主预览使用替代字体 "${expectedFont}"`
          : requiresHostFontInstallation ? `工程字体 "${expectedFont}" 未嵌入 .rp；Axure 宿主需另行安装该字体。本报告只验证字体族名写入，未验证宿主字形。` : null,
      });
    }
  }

  return {
    totalTextNodes: verifiedItems.length,
    verification: 'stored-font-family-only',
    fontsEmbedded: false,
    requiresHostFontInstallationCount: verifiedItems.filter(item => item.requiresHostFontInstallation).length,
    fontPreservedCount,
    allFontsPreserved: verifiedItems.every(i => i.fontPreserved),
    missingFontSubstitutionsCount: verifiedItems.filter(i => i.isFontFallback).length,
    fallbackFontNodes: verifiedItems.filter(i => i.isFontFallback),
    items: verifiedItems,
  };
}

function patchAndVerifyRpVectors(absOutRp, scene) {
  let buf = readFileSync(absOutRp);
  const rpInitial = readRp(buf, { path: absOutRp });
  const targetsByRecord = new Map();

  for (const pgScene of scene.pages) {
    const rpPage =
      (rpInitial.pages || []).find(p => p.name === pgScene.name || p.id === pgScene.id) ||
      rpInitial.pages[scene.pages.indexOf(pgScene)];
    if (!rpPage || rpPage.record === undefined) continue;

    for (const resNode of pgScene.nodes) {
      if (resNode.type !== 'path' || !Array.isArray(resNode.subpaths) || resNode.subpaths.length === 0) continue;
      const esc = String(resNode.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const primaryRe = new RegExp(`^(?:[a-z]+-)+${esc}-[0-9a-f]{8,16}$`);
      const bgRe = new RegExp(`^bg-(?:[a-z]+-)+${esc}-[0-9a-f]{8,16}$`);
      const allWidgets = [
        ...(rpPage.widgets || []),
        ...(rpInitial.containedWidgets || []).filter(cw => cw.record === rpPage.record),
      ];
      const vecWidget =
        allWidgets.find(w => !bgRe.test(w.name) && (w.name === resNode.id || primaryRe.test(w.name) || w.name?.endsWith(`-${resNode.id}`))) ||
        null;
      if (!vecWidget) continue;
      const recIdx = vecWidget.record ?? rpPage.record;
      if (!targetsByRecord.has(recIdx)) targetsByRecord.set(recIdx, []);
      targetsByRecord.get(recIdx).push({ pgScene, resNode, widgetId: vecWidget.id });
    }
  }

  for (const [recIdx, items] of targetsByRecord.entries()) {
    const record = readRecords(buf).find(r => r.index === recIdx);
    if (!record) continue;
    const graph = parsePayload(record);
    const strings = [...record.strings];
    const intern = text => {
      let idx = strings.indexOf(text);
      if (idx < 0) {
        idx = strings.indexOf(text);
        idx = strings.length;
        strings.push(text);
      }
      return { tag: 8, value: idx + 1, text };
    };
    const int = value => ({ tag: 5, value });
    const f64 = value => ({ tag: 6, value });
    const bool = value => ({ tag: 25, value });
    const list = arr => ({ tag: 2, items: arr });
    const mapEntry = entries => ({
      tag: 1,
      entries: Object.entries(entries).map(([k, v]) => [intern(k), v]),
    });
    const xy = (x, y) => mapEntry({ X: f64(x), Y: f64(y) });

    let modified = false;
    for (const { resNode, widgetId } of items) {
      const widget = graph.objects.get(Number(widgetId));
      if (!widget?.body) continue;
      const cpSubpaths = buildRp9ControlPointsForSubpaths(resNode.subpaths, resNode.w, resNode.h, {
        fillRule: resNode.fillRule || 'nonzero',
      });
      const encodedSubpaths = list(
        cpSubpaths.map(sp =>
          list(
            sp.map(cp =>
              mapEntry({
                Path: xy(cp.Path.X, cp.Path.Y),
                LowerHandle: xy(cp.LowerHandle.X, cp.LowerHandle.Y),
                HigherHandle: xy(cp.HigherHandle.X, cp.HigherHandle.Y),
                HigherSegmentExists: bool(cp.HigherSegmentExists),
              })
            )
          )
        )
      );
      const setBodyField = (key, val) => {
        const existing = widget.body.entries.findIndex(([k]) => k.text === key);
        if (existing >= 0) widget.body.entries[existing][1] = val;
        else widget.body.entries.push([intern(key), val]);
      };
      setBodyField('Shape', int(300));
      setBodyField('ControlPoints', encodedSubpaths);
      modified = true;
    }

    if (modified) {
      buf = replaceRecord(buf, record, encodeRecord(record, strings, encodePayload(graph.roots)));
    }
  }

  writeFileSync(absOutRp, buf);

  const rpVerified = readRp(buf, { path: absOutRp, includeVectors: true });
  const verifiedItems = [];
  for (const [recIdx, items] of targetsByRecord.entries()) {
    for (const { pgScene, resNode, widgetId } of items) {
      const rpPage = (rpVerified.pages || []).find(p => p.record === recIdx);
      const w =
        (rpPage?.widgets || []).find(item => item.id === widgetId) ||
        (rpVerified.containedWidgets || []).find(item => item.record === recIdx && item.id === widgetId) ||
        null;
      verifiedItems.push({
        pageId: pgScene.id,
        nodeId: resNode.id,
        shape: w?.shape ?? 0,
        subpathCount: w?.controlPoints?.length ?? 0,
        expectedSubpathCount: resNode.subpaths.length,
        preserved: w?.shape === 300 && (w?.controlPoints?.length ?? 0) === resNode.subpaths.length,
        fillRule: resNode.fillRule || 'nonzero',
        fallbackReasons: resNode.vectorFallbackReasons || [],
      });
    }
  }

  return {
    totalVectorNodes: verifiedItems.length,
    nativeShape300Count: verifiedItems.filter(i => i.preserved).length,
    allVectorsPreserved: verifiedItems.every(i => i.preserved),
    items: verifiedItems,
  };
}

export function classifyNodeCompatibility(node, pageId, entries) {
  const baseInfo = {
    pageId,
    nodeId: node.id,
    scopedId: `${pageId}/${node.id}`,
    nodeType: node.type,
    name: node.name || node.id,
  };
  const cssPlan = exportCssPlan(node);
  if (['label', 'paragraph', 'button', 'badge'].includes(node.type) && node.spans?.length) {
    entries.push({
      ...baseInfo,
      classification: 'unsupported',
      feature: 'text.spans',
      browserPreserved: true,
      reason: 'Studio 原生出口将富文本转换为普通可编辑文字',
      fallback: '保留文字内容和节点级样式；逐段样式保留在 Studio 源与 HTML 代码包',
    });
  }
  if (node.type === 'input' && node.rotation) entries.push({ ...baseInfo, classification: 'native-init-action', feature: 'input.rotation', browserPreserved: true, nativePreviewPreserved: true, reason: 'RP9 TextBox 静态旋转不参与预览；导出保留角度，并生成原生 OnLoad 绝对旋转动作，输入框仍可编辑', strategy: 'native-widget-onload-rotate', editorStaticRotationSupported: false });
  if(node.type==='repeater')for(const key of ['filter','sort','pageSize','page','on']){
    const value=key==='on'?nodeEvents(node):node[key];
    const hasValue=value!==undefined&&value!==null&&(typeof value!=='object'||Object.keys(value).length>0);
    const native=nodePropertyCapability('repeater',key).surfaces.native;
    if(hasValue&&native.status==='unsupported')entries.push({...baseInfo,classification:'unsupported',feature:`repeater.${key}`,reason:native.reason,browserPreserved:key!=='on',declarations:{[key]:structuredClone(value)},fallback:'保留可编辑列表、原始数据与画布源；严格原生交付请使用完整RP/1数据动作流程'});
  }
  let vectorSpec = null;
  if (node.type === 'path') {
    vectorSpec = normalizeVectorNodeSpec(node);
    for (const fb of vectorSpec.nativeCompatibility?.fallbackReasons || []) {
      entries.push({
        ...baseInfo,
        classification: 'unsupported',
        feature: fb.feature,
        browserPreserved: true,
        reason: fb.reason,
        fallback: '保留可编辑画布矢量源与 RP9 Shape:300 ControlPoints 曲线轮廓，仅省略宿主不支持的扩展效果，不将页面或交互容器栅格化',
      });
    }
  }
  if (cssPlan.unsupported.length) {
    entries.push({
      ...baseInfo,
      classification: 'unsupported',
      feature: `css:${cssPlan.unsupported.join(',')}`,
      browserPreserved: true,
      declarations: { ...(node.css || {}), ...(node.threeDTransform ? { transform: node.threeDTransform } : {}), ...(node.customFilter ? { filter: node.customFilter } : {}), ...(node.mixBlendMode ? { 'mix-blend-mode': node.mixBlendMode } : {}) },
      reason: '这些浏览器效果影响文字、子节点或依赖实时背景；无法在保持原生编辑能力的同时完整表达为 RP9',
      fallback: '仅在 RP9 导出中省略这些效果，保留基础几何、原生文字、子节点与交互；浏览器文档不变',
    });
  }

  // Check unsupported features first
  if (node.webglShader || node.videoStream) {
    entries.push({
      ...baseInfo,
      classification: 'unsupported',
      feature: node.webglShader ? 'webglShader' : 'videoStream',
      reason: 'Axure RP 9 原生元件模型不支持该运行时渲染特性',
      fallback: '已保留外框几何与基础文本，未导出专有渲染器特性',
    });
  }

  // Check local decorative effects that use local effect rasterization / approximation
  const effects = [];
  if (node._cssPaintAsset) effects.push(...Object.keys(cssPlan.paint));
  if (effects.length > 0) {
    entries.push({
      ...baseInfo,
      classification: 'rasterized-effect',
      feature: effects.join(','),
      reason: '用同一浏览器 CSS 渲染空白装饰面，在节点边界内导出独立 PNG；不截取文字、子节点或整个页面',
      asset: node._cssPaintAsset,
      editableTextPreserved: true,
      interactiveContainerPreserved: true,
    });
  }

  // Everything else on the node is native-editable
  entries.push({
    ...baseInfo,
    classification: 'native-editable',
    feature: node.type,
    ...(vectorSpec
      ? {
          nativeVectorMode: 'rp9-custom-shape-300',
          nativeShapeCode: 300,
          subpathCount: vectorSpec.subpaths.length,
          fillRule: vectorSpec.fillRule,
        }
      : {}),
    ...(node._fromComponentId
      ? {
          componentId: node._fromComponentId,
          componentExportMode: node._exportedAsMaster ? 'native-component' : 'expanded-editable-instance',
          editableStructurePreserved: true,
          rasterizedAsWholeImage: false,
        }
      : {}),
    reason: node._fromComponentId
      ? `组件实例 (${node._fromComponentId}) 展开为 Axure RP 9 原生可编辑节点树 (expanded-editable-instance)，保留全部子元件坐标、文本与交互`
      : vectorSpec
        ? `映射为 Axure RP 9 原生可编辑自定义形状 (Axure:DiagramObject:VectorShape, Shape: 300, ControlPoints 子路径数=${vectorSpec.subpaths.length})`
        : '映射为 Axure RP 9 原生可编辑元件（保留坐标、尺寸、文本、样式与交互事件）',
  });
}

function decorateExportNode(out, node) {
  if (!node._cssPaintAsset) return out;
  const image = { id: `${node.id}__css_paint`, type: 'image', x: 0, y: 0, w: out.w, h: out.h, src: node._cssPaintAsset.src };
  for (const key of ['gradient', 'shadow', 'backdropBlur', 'aurora', 'noise']) delete out[key];
  if ('fill' in out) out.fill = '#FFFFFF00';
  if ('stroke' in out) out.stroke = '#FFFFFF00';
  if (out.type === 'box' || out.type === 'phone-shell') {
    // Empty decoration boxes acquire children here, after layout resolution.
    // Keep them in stack coordinates too; the compiler's default flow layout
    // otherwise places the paint image at the screen origin.
    out.layout = 'stack';
    out.padding = 0;
    out.gap = 0;
    out.children = [image, ...(out.children || [])];
    return out;
  }
  const { x, y, w, h } = out;
  return { id: `${node.id}__css_layer`, type: 'box', x: x || 0, y: y || 0, w, h, layout: 'stack', fill: '#FFFFFF00', children: [image, { ...out, x: 0, y: 0 }] };
}

function resolvedTreeToRp1Node(node, pageId, compatEntries, { omitRootXY = false, exportCtx = null } = {}) {
  if(STUDIO_SOURCE_ONLY_MACROS.has(node.type)&&!node.children?.length)throw Object.assign(new Error(`尚未展开的Studio节点 ${node.type} 不能按可见画布导出；请使用完整RP/1原生入口`),{code:'E_EXPORT_UNEXPANDED_MACRO',nodeId:`${pageId}/${node.id}`,field:'type'});
  classifyNodeCompatibility(node, pageId, compatEntries);

  if (node.type === 'phone-shell') {
    return {
      id: node.id,
      type: 'phone-shell',
      device: node.device || 'iphone-17-pro',
      statusBar: node.statusBar ?? false,
      padding: node.padding ?? 0,
      gap: node.gap ?? 0,
      fill: node._resolvedFill || node.fill || '#F7F8F2',
      darkIsland: node.darkIsland !== false,
      showHomeIndicator: node.showHomeIndicator !== false,
      children: (node.children || []).map(ch =>
        resolvedTreeToRp1Node(
          {
            ...ch,
            _relX: 0,
            _relY: 0,
          },
          pageId,
          compatEntries,
          { exportCtx }
        )
      ),
    };
  }

  const out = {
    id: node.id,
    // Studio already expanded these macros. Send their resolved editable tree,
    // otherwise the native compiler would reject/expand it a second time.
    type: ['instance', 'card', 'spacer', 'divider', 'stat-row', 'list-item', 'path'].includes(node.type) || STUDIO_SOURCE_ONLY_MACROS.has(node.type) ? 'box' : node.type,
    ...(omitRootXY
      ? {}
      : {
          x: Math.round(node._relX ?? node.x ?? 0),
          y: Math.round(node._relY ?? node.y ?? 0),
        }),
    ...(typeof node.z === 'number' ? { z: node.z } : {}),
    w: Math.round(node._w ?? node.w ?? 100),
    h: Math.round(node._h ?? node.h ?? 40),
  };
  // Initially hidden nodes must stay hidden in Axure; show/hide actions reveal them at runtime.
  if (node.visible === false || node.hidden === true) out.visible = false;
  if (node.type === 'spacer') { out.fill = '#FFFFFF00'; out.stroke = '#FFFFFF00'; }
  if (['stat-row', 'list-item', 'path'].includes(node.type) && !node._resolvedFill && !node.fill) out.fill = '#FFFFFF00';
  if (node.type === 'path' && !node._resolvedStroke && !node.stroke && !node._resolvedFill && !node.fill && (node._resolvedColor || node.color)) {
    out.stroke = node._resolvedColor || node.color;
    if (node.strokeWidth === undefined) out.strokeWidth = 2;
  }

  // Layout is resolved to explicit stack coordinates so ResolvedScene is the single geometry authority
  if (out.type === 'box' && Array.isArray(node.children) && node.children.length > 0) {
    out.layout = 'stack';
    out.padding = 0;
    out.gap = 0;
  }

  if (out.type === 'image') {
    out.src = node.src || 'assets/placeholder.png';
    if (node.radius !== undefined) out.radius = node.radius;
    if (node.opacity !== undefined) out.opacity = node.opacity;
    if (node.rotation) out.rotation = node.rotation;
    if (node.shadow) out.shadow = node.shadow;
    if (nodeEvents(node)) out.on = normalizeExportOn(nodeEvents(node), exportCtx);
    return decorateExportNode(out, node);
  }

  if (out.type === 'dynamic-panel' && Array.isArray(node.states)) {
    const activeId = node.activeState || node.states[0]?.id;
    const orderedStates = [
      ...node.states.filter(s => s.id === activeId),
      ...node.states.filter(s => s.id !== activeId),
    ];
    out.states = orderedStates.map(st => ({
      id: st.id,
      name: st.name || st.id,
      root: st.root
        ? resolvedTreeToRp1Node(
            {
              ...st.root,
              _relX: 0,
              _relY: 0,
            },
            `${pageId}/${node.id}/${st.id}`,
            compatEntries,
            { omitRootXY: true, exportCtx }
          )
        : { type: 'box', id: `${st.id}_root`, layout: 'stack', w: out.w, h: out.h, children: [] },
    }));
    if (nodeEvents(node)) out.on = normalizeExportOn(nodeEvents(node), exportCtx);
    return decorateExportNode(out, node);
  }

  if (out.type === 'repeater') {
    out.dataset = repeaterDatasetName(node);
    if (node.key) out.key = node.key;
    else {
      // The native compiler requires the repeater identity column to be text,
      // nonempty and unique across rows; fall back to the first such column.
      const rows = (exportCtx?.datasetRowsByName?.get(out.dataset) || []).filter(r => r && typeof r === 'object');
      const cols = Object.keys(rows[0] || {}).filter(k => !String(k).startsWith('_'));
      const textCol = cols.find(k => {
        const vals = rows.map(r => r[k]);
        return vals.every(v => typeof v === 'string' && v !== '') && new Set(vals).size === vals.length;
      });
      if (textCol) out.key = textCol;
    }
    if (node.pageSize !== undefined) out.pageSize = node.pageSize;
    out.rowHeight = node.rowHeight || 56;
    out.rowGap = node.rowGap ?? node.gap ?? 8;
    if (node.template) {
      out.template = resolvedTreeToRp1Node(
        {
          ...node.template,
          _relX: 0,
          _relY: 0,
        },
        `${pageId}/${node.id}/template`,
        compatEntries,
        { omitRootXY: true, exportCtx }
      );
    } else {
      out.template = {
        type: 'box',
        id: `${node.id}_tpl`,
        layout: 'stack',
        w: out.w,
        h: out.rowHeight,
        fill: '#FFFFFF',
        radius: 8,
        children: [
          { type: 'label', id: `${node.id}_lbl`, text: '观测项', x: 12, y: 10, w: Math.max(40, out.w - 24), h: 24 },
        ],
      };
    }
    return decorateExportNode(out, node);
  }

  const isBoxLike = ['box', 'card', 'button', 'badge', 'input', 'label', 'paragraph', 'icon'].includes(out.type);
  const isTextLike = ['label', 'paragraph', 'button', 'badge', 'input'].includes(out.type);

  if (isBoxLike) {
    if (node._resolvedFill) out.fill = node._resolvedFill;
    else if (node.fill) out.fill = node.fill;

    if (node._resolvedStroke) out.stroke = node._resolvedStroke;
    else if (node.stroke) out.stroke = node.stroke;

    if (node.strokeWidth !== undefined) out.strokeWidth = node.strokeWidth;
    if (node.radius !== undefined) out.radius = node.radius;
    if (node.opacity !== undefined) out.opacity = node.opacity;
    if (node.rotation) out.rotation = node.rotation; // 原生可编辑 2D 旋转（.rp DOA 3221225522）
    if (node.shadow) out.shadow = node.shadow;
    if (node.innerGlow) out.innerGlow = node.innerGlow;
    if (node.gradient) out.gradient = node.gradient;
    if (node.backdropBlur) out.backdropBlur = node.backdropBlur;
    if (node.aurora) out.aurora = node.aurora;
    if (node.noise) out.noise = node.noise;
    for (const bKey of ['borderSides', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'clip']) {
      if (node[bKey] !== undefined) out[bKey] = node[bKey];
    }
  }

  if (out.type === 'icon') {
    const ICON_MAP = {
      'chevron-left': 'back',
      'chevron-right': 'arrow-up-right',
      spark: 'sparkles',
      compass: 'find',
      camera: 'flash',
      info: 'alert',
      warning: 'alert',
      error: 'alert',
    };
    const VALID_PROTO_ICONS = new Set([
      'activity', 'add', 'ai', 'alert', 'arrow-left', 'arrow-up-right', 'back', 'bell',
      'bolt', 'book', 'chart', 'check', 'chip', 'clock', 'cpu', 'done', 'external',
      'filter', 'find', 'flash', 'guard', 'heart', 'home', 'layers', 'lightning',
      'magic', 'model', 'ok', 'plus', 'pulse', 'search', 'security', 'settings',
      'shield', 'sliders', 'sparkles', 'stack', 'star', 'trend', 'tune', 'wand', 'zap',
    ]);
    const rawIcon = String(node.icon || 'sparkles').trim();
    const mappedIcon = ICON_MAP[rawIcon] || rawIcon;
    out.icon = VALID_PROTO_ICONS.has(mappedIcon) ? mappedIcon : 'sparkles';
    if (node._resolvedColor) out.color = node._resolvedColor;
    else if (node.color) out.color = node.color;
  }

  if (isTextLike) {
    if (node._resolvedFontFamily || node.fontFamily) out.fontFamily = node._resolvedFontFamily || node.fontFamily;
    if (out.type === 'input') {
      delete out.fontFamily; // Native input style family is not yet represented.
      if (node.placeholder !== undefined) out.placeholder = node.placeholder;
      if (node.value !== undefined) out.value = node.value;
      else if (node.text !== undefined) out.value = node.text;
      if (typeof node.textPaddingX === 'number') out.textPaddingX = Number(node.textPaddingX);
    } else if (node._textMetrics?.truncated) {
      out.text = node._textMetrics.displayText;
    } else if (typeof node.text === 'string' && /^=\s*(?:dataset\.|text\()/.test(node.text)) {
      out.text = node._textMetrics?.displayText ?? node.text;
    } else if (node.text !== undefined) {
      out.text = node.text;
    } else if (Array.isArray(node.spans) && node.spans.length > 0) {
      out.text = node._textMetrics?.text || node.spans.map(s => s?.text ?? '').join('');
    }

    if (node._resolvedColor) out.color = node._resolvedColor;
    else if (node.color) out.color = node.color;

    if (node.fontSize !== undefined) out.fontSize = Number(node.fontSize);
    if (node.fontWeight !== undefined) out.fontWeight = Number(node.fontWeight);
    if (node.align || node._inheritedAlign) out.align = node.align || node._inheritedAlign;

    if (['label', 'paragraph', 'button', 'badge'].includes(out.type)) {
      if (node.letterSpacing !== undefined) out.letterSpacing = Number(node.letterSpacing);
      if (node.italic) out.italic = true;
      if (node.underline) out.underline = true;
      if (node.strikethrough) out.strikethrough = true;
      if (out.type === 'paragraph' && typeof node.textPaddingX === 'number' && out.padding === undefined) {
        out.padding = Number(node.textPaddingX);
      }
    }
    if (['label', 'paragraph'].includes(out.type) && node.lineHeight !== undefined) {
      out.lineHeight = Number(node.lineHeight);
    }
    if (out.type === 'label' && node.wrap !== undefined) {
      out.wrap = Boolean(node.wrap);
    }
  }

  if (nodeEvents(node)) {
    out.on = normalizeExportOn(nodeEvents(node), exportCtx);
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    out.children = node.children.map(ch => {
      const childCopy = {
        ...ch,
        _relX: (ch._x ?? 0) - (node._x ?? 0),
        _relY: (ch._y ?? 0) - (node._y ?? 0),
      };
      return resolvedTreeToRp1Node(childCopy, pageId, compatEntries, { exportCtx });
    });
  }

  return decorateExportNode(out, node);
}

export async function exportStudioDocumentToRp(doc, { projectDir = null, outRpPath, outReportPath = null } = {}) {
  if (!outRpPath) {
    throw Object.assign(new Error('outRpPath is required'), { code: 'E_EXPORT_PATH_REQUIRED' });
  }
  const absOutRp = resolve(outRpPath);
  assertNotProtected(absOutRp);
  mkdirSync(dirname(absOutRp), { recursive: true });

  // Lock snapshot of document at current revision
  const snapshotDoc = structuredClone(doc);
  const scene = resolveDocumentScene(snapshotDoc, { projectDir });

  const workDir = mkdtempSync(join(tmpdir(), 'zee-studio-export-'));
  try {
    const exportPages = scene.pages.map(pg => ({ ...pg, rootTree: structuredClone(pg.rootTree) }));
    const inlineDatasets={},inlineOwners={};
    const collectInline=(node,pageId)=>{
      if(node.type==='repeater'){
        const name=repeaterDatasetName(node);
        if(!snapshotDoc.datasets?.[name]){
          const inline=repeaterInlineRows(node);
          const rows=inline.length?inline:(node.rows||[]);
          if(inlineDatasets[name]&&canonicalJson(inlineDatasets[name].rows)!==canonicalJson(rows))throw Object.assign(new Error(`内联列表数据名称冲突：${inlineOwners[name]}与${pageId}/${node.id}。请为不同列表声明不同dataset/source名称。`),{code:'E_EXPORT_DATASET_COLLISION',nodeId:`${pageId}/${node.id}`,field:'dataset'});
          inlineDatasets[name]={rows:structuredClone(rows)};
          inlineOwners[name]=`${pageId}/${node.id}`;
        }
      }
      for(const child of node.children||[])collectInline(child,pageId);for(const state of node.states||[])if(state.root)collectInline(state.root,pageId);if(node.template)collectInline(node.template,pageId);
    };
    for(const page of exportPages)collectInline(page.rootTree,page.id);
    const effectAssets = await rasterizeStudioPaint(exportPages, { workDir, projectDir, colors: snapshotDoc.tokens?.colors || snapshotDoc.palette || {} });
    const compatEntries = [];
    const resolvedPages = exportPages.map(pgScene => {
      const datasetToRepeaterId = new Map();
      const repeaterKeyById = new Map();
      const datasetRowsByName = new Map();
      let defaultRepeaterId = null;
      const scanRepeaters = nd => {
        if (!nd || typeof nd !== 'object') return;
        if (nd.type === 'repeater') {
          const dsName = repeaterDatasetName(nd);
          if (!datasetToRepeaterId.has(dsName)) datasetToRepeaterId.set(dsName, nd.id);
          repeaterKeyById.set(nd.id, nd.key || 'id');
          if (!defaultRepeaterId) defaultRepeaterId = nd.id;
          if (!datasetRowsByName.has(dsName)) {
            const declared = snapshotDoc.datasets?.[dsName];
            const inline = repeaterInlineRows(nd);
            const rows = Array.isArray(declared) ? declared : (declared?.rows || inline);
            datasetRowsByName.set(dsName, rows);
          }
        }
        for (const ch of nd.children || []) scanRepeaters(ch);
        for (const st of nd.states || []) if (st.root) scanRepeaters(st.root);
      };
      scanRepeaters(pgScene.rootTree);
      const exportCtx = { datasetToRepeaterId, repeaterKeyById, defaultRepeaterId, datasetRowsByName };
      const isPhoneShell = pgScene.rootTree?.type === 'phone-shell';
      return {
        id: pgScene.id,
        name: pgScene.name,
        ...(pgScene.device ? { device: pgScene.device } : {}),
        ...(isPhoneShell ? {} : { canvas: { w: pgScene.board.screenW, h: pgScene.board.screenH } }),
        root: resolvedTreeToRp1Node(pgScene.rootTree, pgScene.id, compatEntries, { exportCtx }),
      };
    });

    const cleanPalette = {};
    for (const [k, v] of Object.entries(snapshotDoc.palette || snapshotDoc.tokens?.colors || {})) {
      if (typeof v === 'string' && /^#[0-9A-Fa-f]{6}/.test(v)) {
        cleanPalette[k] = v.slice(0, 7);
      }
    }

    const cleanDatasets = {};
    for (const [dsName, dsVal] of Object.entries({...inlineDatasets,...(snapshotDoc.datasets || {})})) {
      const rawRows = Array.isArray(dsVal) ? dsVal : (dsVal?.rows || []);
      if (!rawRows.length) continue; // compiler cannot infer a model for empty rows; emitting one fails compile
      cleanDatasets[dsName] = {
        rows: rawRows.map(r => {
          const rowOut = {};
          for (const [rk, rv] of Object.entries(r || {})) {
            if (!rk.startsWith('_')) rowOut[rk] = rv;
          }
          return rowOut;
        }),
      };
    }

    const RP1_THEMES = new Set(['enterprise-light', 'modern-dark', 'cobalt-pro', 'mobile-lowfi', 'mobile-hifi', 'aurora-glass', 'editorial-warm', 'cyber-neon']);
    const exportSpec = {
      language: 'rp/1',
      target: snapshotDoc.target || 9,
      name: snapshotDoc.name,
      domain: ['mobile', 'web', 'doc', 'test'].includes(snapshotDoc.domain) ? snapshotDoc.domain : 'mobile',
      theme: RP1_THEMES.has(snapshotDoc.theme) ? snapshotDoc.theme : 'mobile-hifi',
      palette: cleanPalette,
      ...(Object.keys(snapshotDoc.variables || {}).length ? { variables: structuredClone(snapshotDoc.variables) } : {}),
      ...(Object.keys(cleanDatasets).length ? { datasets: cleanDatasets } : {}),
      pages: resolvedPages,
    };
    const crossPageTextState = preserveCrossPageText(exportSpec);

    // Copy project assets into workDir/assets so proto.py compile can package them
    const workAssetsDir = join(workDir, 'assets');
    mkdirSync(workAssetsDir, { recursive: true });
    if (projectDir && existsSync(join(projectDir, 'assets'))) {
      for (const fname of readdirSync(join(projectDir, 'assets'))) {
        const srcAsset = join(projectDir, 'assets', fname);
        const destAsset = join(workAssetsDir, fname);
        try {
          copyFileSync(srcAsset, destAsset);
        } catch {}
      }
    }
    for (const [relKey, entry] of Object.entries(snapshotDoc.assetsManifest || {})) {
      const destAsset = join(workDir, relKey);
      if (!existsSync(destAsset)) {
        const orig = entry?.originalSource || entry?.originalSrc;
        if (orig && existsSync(orig)) {
          mkdirSync(dirname(destAsset), { recursive: true });
          copyFileSync(orig, destAsset);
        }
      }
    }

    const specPath = join(workDir, 'export-spec.json');
    writeFileSync(specPath, JSON.stringify(exportSpec, null, 2), 'utf8');

    const bundleDir = join(workDir, 'bundle');
    const compileProc = await new Promise(resolveProc => {
      const child = spawn(
        'python3',
        [join(ROOT, 'scripts/proto.py'), 'compile', '--spec', specPath, '--out-dir', bundleDir],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.on('close', status => resolveProc({ status, stdout, stderr }));
      child.on('error', err => resolveProc({ status: 1, stdout, stderr: err.message }));
    });
    const planPath = join(bundleDir, 'compile-plan.json');
    if (compileProc.status !== 0 && !existsSync(planPath)) {
      throw Object.assign(
        new Error(`proto.py compile failed: ${compileProc.stderr || compileProc.stdout}`),
        { code: 'E_EXPORT_COMPILE_FAILED' }
      );
    }

    rmSync(absOutRp, { force: true });
    rmSync(`${absOutRp}.baseline.json`, { force: true });

    const sourceDir = `${absOutRp}.source`;
    const sourcePath = join(sourceDir, 'source.json');
    const studioSourcePath=join(sourceDir,'studio-document.json');
    assertNotProtected(sourcePath);
    mkdirSync(sourceDir, { recursive: true });
    cpSync(workAssetsDir, join(sourceDir, 'assets'), { recursive: true });
    copyFileSync(specPath, sourcePath);
    const studioSourceBytes=JSON.stringify(snapshotDoc,null,2)+'\n';
    writeFileSync(studioSourcePath,studioSourceBytes);
    const buildRes = buildInteractiveRp(planPath, absOutRp, { sourcePath });

    // Patch native AxRun.Family and MyStyle.PropList fontFamily so non-default fonts are preserved in .rp
    const typographyAlignment = patchAndVerifyRpTypography(absOutRp, scene);
    const vectorAlignment = patchAndVerifyRpVectors(absOutRp, scene);
    // Typography & vector patching are part of generation, not a later native user edit.
    const finalBytes = readFileSync(absOutRp), baselinePath = `${absOutRp}.baseline.json`;
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.rpSha256 = sha256(finalBytes);
    baseline.baseRpBase64 = finalBytes.toString('base64');
    baseline.studioOrigin={documentId:snapshotDoc.documentId,revision:snapshotDoc.revision,contentHash:snapshotDoc.contentHash,sourceFile:`${basename(sourceDir)}/studio-document.json`,sha256:sha256(studioSourceBytes)};
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    buildRes.rpSha256 = baseline.rpSha256;

    // Read back the generated .rp and run structural & geometry alignment verification
    const rpSummary = readRp(readFileSync(absOutRp), { path: absOutRp });

    // Compare ResolvedScene visible nodes vs native .rp widget geometries
    let totalCompared = 0;
    let within1PxCount = 0;
    let maxErrorPx = 0;
    const nodeAlignmentDetails = [];

    for (const pgScene of scene.pages) {
      const rpPage = (rpSummary.pages || []).find(
        p => p.name === pgScene.name || p.id === pgScene.id
      ) || rpSummary.pages[scene.pages.indexOf(pgScene)];
      if (!rpPage) continue;

      for (const resNode of pgScene.nodes) {
        if (!resNode.visible || resNode.type === 'phone-shell' || resNode.id === `${pgScene.id}_screen`) continue;
        const rpWidget = findRpWidgetByNodeId(rpPage.widgets, resNode.id);
        if (!rpWidget || typeof rpWidget.x !== 'number' || typeof rpWidget.w !== 'number') continue;
        // Repeater widgets live in the row template's coordinate plane, not at
        // their first-row preview position on the page.
        const templateOwner=resNode.repeaterTemplateOwner?pgScene.nodes.find(node=>node.scopedId===resNode.repeaterTemplateOwner):null;
        const expectedX=resNode.pageGlobalX-(templateOwner?.pageGlobalX||0),expectedY=resNode.pageGlobalY-(templateOwner?.pageGlobalY||0);
        const dx = Math.abs(rpWidget.x - expectedX);
        const dy = Math.abs(rpWidget.y - expectedY);
        const dw = Math.abs(rpWidget.w - resNode.w);
        const dh = Math.abs(rpWidget.h - resNode.h);
        const err = Math.max(dx, dy, dw, dh);
        totalCompared++;
        if (err <= 1) within1PxCount++;
        if (err > maxErrorPx) maxErrorPx = err;
        if (err > 1) {
          nodeAlignmentDetails.push({
            pageId: pgScene.id,
            nodeId: resNode.id,
            resolved: { x: expectedX, y: expectedY, w: resNode.w, h: resNode.h },
            ...(templateOwner?{coordinateSpace:'repeater-template',ownerId:templateOwner.scopedId}:{}),
            exported: { x: rpWidget.x, y: rpWidget.y, w: rpWidget.w, h: rpWidget.h },
            errorPx: err,
          });
        }
      }
    }

    const within1PxRatio = totalCompared > 0 ? within1PxCount / totalCompared : 1;
    const counts = {
      'native-editable': compatEntries.filter(e => e.classification === 'native-editable').length,
      'rasterized-effect': compatEntries.filter(e => e.classification === 'rasterized-effect').length,
      unsupported: compatEntries.filter(e => e.classification === 'unsupported').length,
    };

    const unparseable = rpSummary.records?.unparseable ?? 0;
    const danglingRefs = rpSummary.counts?.danglingRefs ?? 0;
    const problems = Array.isArray(rpSummary.problems) ? rpSummary.problems.length : (rpSummary.problems ?? 0);
    const interactionAudit = summarizeInteractionSources(rpSummary, { crossPageTextState });

    const report = {
      schemaVersion: 1,
      documentId: snapshotDoc.documentId,
      exportedRevision: snapshotDoc.revision,
      contentHash: snapshotDoc.contentHash,
      studioOrigin:baseline.studioOrigin,
      exporterVersion: EXPORTER_VERSION,
      exportedAt: new Date().toISOString(),
      outRpPath: absOutRp,
      summary: {
        pageCount: rpSummary.pages?.length ?? 0,
        widgetCount: rpSummary.counts?.widgets ?? 0,
        unparseable,
        danglingRefs,
        problems,
        threeZerosPassed: unparseable === 0 && danglingRefs === 0 && problems === 0,
      },
      geometryAlignment: {
        totalCompared,
        within1PxCount,
        within1PxRatio: Number(within1PxRatio.toFixed(4)),
        maxErrorPx,
        passed99PercentWithin1Px: within1PxRatio >= 0.99 && maxErrorPx <= 2,
        outliers: nodeAlignmentDetails,
      },
      typographyAlignment,
      vectorAlignment,
      componentExportSummary: {
        totalComponentInstances: compatEntries.filter(e => Boolean(e.componentExportMode)).length,
        expandedEditableInstances: compatEntries.filter(e => e.componentExportMode === 'expanded-editable-instance').length,
        nativeComponents: compatEntries.filter(e => e.componentExportMode === 'native-component').length,
        rasterizedComponentInstances: 0,
      },
      compatibilityCounts: counts,
      interactionSources: interactionAudit.sources,
      crossPageTextState,
      interactionCounts: {
        ...interactionAudit.counts,
        rpSummary: { interactions: rpSummary.counts?.interactions ?? null, actions: rpSummary.counts?.actions ?? null },
        matchesRpSummary: interactionAudit.counts.total.interactions === (rpSummary.counts?.interactions ?? null)
          && interactionAudit.counts.total.actions === (rpSummary.counts?.actions ?? null),
      },
      wholePageRasterized: false,
      editableTextRasterized: false,
      interactiveContainerRasterized: false,
      entries: compatEntries,
      effectAssets,
      fontDiagnostics: scene.fontDiagnostics,
      assetDiagnostics: scene.assetDiagnostics,
    };

    const finalReportPath = outReportPath
      ? resolve(outReportPath)
      : join(dirname(absOutRp), `${basename(absOutRp, '.rp')}.compatibility-report.json`);
    if (effectAssets.length) {
      const effectsDir = `${absOutRp}.effects`;
      mkdirSync(effectsDir, { recursive: true });
      for (const asset of effectAssets) copyFileSync(join(workDir, asset.src), join(effectsDir, basename(asset.src)));
      report.effectAssetsDirectory = effectsDir;
    }
    writeFileSync(finalReportPath, JSON.stringify(report, null, 2), 'utf8');

    return {
      ok: true,
      outRpPath: absOutRp,
      sourcePath,
      studioSourcePath,
      reportPath: finalReportPath,
      buildResult: buildRes,
      report,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
