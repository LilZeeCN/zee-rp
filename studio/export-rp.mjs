import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, EXPORTER_VERSION } from './document.mjs';
import { exportCssPlan } from './visual-style.mjs';
import { rasterizeStudioPaint } from './css-raster.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import { buildInteractiveRp } from '../scripts/proto.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords, encodeRecord, replaceRecord } from '../scripts/rp-records.mjs';
import { parsePayload, encodePayload, field } from '../scripts/parse-payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function normalizeSingleExportAction(act) {
  if (!act || typeof act !== 'object') return act;
  const c = structuredClone(act);
  if (c.type === 'set-variable' && c.target && !c.variable) {
    c.variable = c.target;
    delete c.target;
  }
  return c;
}

function normalizeExportEventSpec(evSpec) {
  if (Array.isArray(evSpec)) return evSpec.map(normalizeSingleExportAction);
  if (!evSpec || typeof evSpec !== 'object') return evSpec;
  if (Array.isArray(evSpec.cases)) {
    return {
      ...structuredClone(evSpec),
      cases: evSpec.cases.map(cs => ({
        ...structuredClone(cs),
        ...(Array.isArray(cs.actions) ? { actions: cs.actions.map(normalizeSingleExportAction) } : {}),
      })),
    };
  }
  if (evSpec.type) return [normalizeSingleExportAction(evSpec)];
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

function normalizeExportOn(onObj) {
  if (!onObj || typeof onObj !== 'object') return undefined;
  const out = {};
  for (const [ev, spec] of Object.entries(onObj)) {
    out[ev] = normalizeExportEventSpec(spec);
  }
  return out;
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
        hostSubstituteWarning: isFallback
          ? `字体 "${resNode.requestedFontFamily || resNode.requestedFont}" 未安装，导出及宿主预览使用替代字体 "${expectedFont}"`
          : null,
      });
    }
  }

  return {
    totalTextNodes: verifiedItems.length,
    fontPreservedCount,
    allFontsPreserved: verifiedItems.every(i => i.fontPreserved),
    missingFontSubstitutionsCount: verifiedItems.filter(i => i.isFontFallback).length,
    fallbackFontNodes: verifiedItems.filter(i => i.isFontFallback),
    items: verifiedItems,
  };
}

function classifyNodeCompatibility(node, pageId, entries) {
  const baseInfo = {
    pageId,
    nodeId: node.id,
    scopedId: `${pageId}/${node.id}`,
    nodeType: node.type,
    name: node.name || node.id,
  };
  const cssPlan = exportCssPlan(node);
  if (cssPlan.unsupported.length) {
    entries.push({
      ...baseInfo,
      classification: 'unsupported',
      feature: `css:${cssPlan.unsupported.join(',')}`,
      browserPreserved: true,
      declarations: { ...(node.css || {}), ...(node.threeDTransform ? { transform: node.threeDTransform } : {}), ...(node.customFilter ? { filter: node.customFilter } : {}) },
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

function resolvedTreeToRp1Node(node, pageId, compatEntries, { omitRootXY = false } = {}) {
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
          compatEntries
        )
      ),
    };
  }

  const out = {
    id: node.id,
    type: node.type === 'instance' ? 'box' : node.type,
    ...(omitRootXY
      ? {}
      : {
          x: Math.round(node._relX ?? node.x ?? 0),
          y: Math.round(node._relY ?? node.y ?? 0),
        }),
    w: Math.round(node._w ?? node.w ?? 100),
    h: Math.round(node._h ?? node.h ?? 40),
  };
  // Initially hidden nodes must stay hidden in Axure; show/hide actions reveal them at runtime.
  if (node.visible === false || node.hidden === true) out.visible = false;

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
    if (node.shadow) out.shadow = node.shadow;
    if (node.on && Object.keys(node.on).length > 0) out.on = structuredClone(node.on);
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
            { omitRootXY: true }
          )
        : { type: 'box', id: `${st.id}_root`, layout: 'stack', w: out.w, h: out.h, children: [] },
    }));
    if (node.on && Object.keys(node.on).length > 0) out.on = structuredClone(node.on);
    return decorateExportNode(out, node);
  }

  if (out.type === 'repeater') {
    out.dataset = node.dataset || node.source;
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
        { omitRootXY: true }
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
    if (node.shadow) out.shadow = node.shadow;
    if (node.gradient) out.gradient = node.gradient;
    if (node.backdropBlur) out.backdropBlur = node.backdropBlur;
    if (node.aurora) out.aurora = node.aurora;
    if (node.noise) out.noise = node.noise;
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
    if (out.type === 'input') {
      if (node.placeholder !== undefined) out.placeholder = node.placeholder;
      if (node.value !== undefined) out.value = node.value;
      else if (node.text !== undefined) out.value = node.text;
    } else if (node._textMetrics?.truncated) {
      out.text = node._textMetrics.displayText;
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
    }
    if (['label', 'paragraph'].includes(out.type) && node.lineHeight !== undefined) {
      out.lineHeight = Number(node.lineHeight);
    }
    if (out.type === 'label' && node.wrap !== undefined) {
      out.wrap = Boolean(node.wrap);
    }
  }

  if (node.on && Object.keys(node.on).length > 0) {
    out.on = normalizeExportOn(node.on);
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    out.children = node.children.map(ch => {
      const childCopy = {
        ...ch,
        _relX: (ch._x ?? 0) - (node._x ?? 0),
        _relY: (ch._y ?? 0) - (node._y ?? 0),
      };
      return resolvedTreeToRp1Node(childCopy, pageId, compatEntries);
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
  const scene = resolveDocumentScene(snapshotDoc);

  const workDir = mkdtempSync(join(tmpdir(), 'zee-studio-export-'));
  try {
    const exportPages = scene.pages.map(pg => ({ ...pg, rootTree: structuredClone(pg.rootTree) }));
    const effectAssets = await rasterizeStudioPaint(exportPages, { workDir, projectDir, colors: snapshotDoc.tokens?.colors || snapshotDoc.palette || {} });
    const compatEntries = [];
    const resolvedPages = exportPages.map(pgScene => {
      const isPhoneShell = pgScene.rootTree?.type === 'phone-shell';
      return {
        id: pgScene.id,
        name: pgScene.name,
        ...(pgScene.device ? { device: pgScene.device } : {}),
        ...(isPhoneShell ? {} : { canvas: { w: pgScene.board.screenW, h: pgScene.board.screenH } }),
        root: resolvedTreeToRp1Node(pgScene.rootTree, pgScene.id, compatEntries),
      };
    });

    const cleanPalette = {};
    for (const [k, v] of Object.entries(snapshotDoc.palette || snapshotDoc.tokens?.colors || {})) {
      if (typeof v === 'string' && /^#[0-9A-Fa-f]{6}/.test(v)) {
        cleanPalette[k] = v.slice(0, 7);
      }
    }

    const cleanDatasets = {};
    for (const [dsName, dsVal] of Object.entries(snapshotDoc.datasets || {})) {
      const rawRows = Array.isArray(dsVal) ? dsVal : (dsVal?.rows || []);
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

    const exportSpec = {
      language: 'rp/1',
      target: snapshotDoc.target || 9,
      name: snapshotDoc.name,
      domain: snapshotDoc.domain || 'mobile',
      theme: snapshotDoc.theme || 'mobile-hifi',
      palette: cleanPalette,
      ...(Object.keys(snapshotDoc.variables || {}).length ? { variables: structuredClone(snapshotDoc.variables) } : {}),
      ...(Object.keys(cleanDatasets).length ? { datasets: cleanDatasets } : {}),
      pages: resolvedPages,
    };

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

    const buildRes = buildInteractiveRp(planPath, absOutRp);

    // Patch native AxRun.Family and MyStyle.PropList fontFamily so non-default fonts are preserved in .rp
    const typographyAlignment = patchAndVerifyRpTypography(absOutRp, scene);

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
        const dx = Math.abs(rpWidget.x - resNode.pageGlobalX);
        const dy = Math.abs(rpWidget.y - resNode.pageGlobalY);
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
            resolved: { x: resNode.pageGlobalX, y: resNode.pageGlobalY, w: resNode.w, h: resNode.h },
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

    const report = {
      schemaVersion: 1,
      documentId: snapshotDoc.documentId,
      exportedRevision: snapshotDoc.revision,
      contentHash: snapshotDoc.contentHash,
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
      componentExportSummary: {
        totalComponentInstances: compatEntries.filter(e => Boolean(e.componentExportMode)).length,
        expandedEditableInstances: compatEntries.filter(e => e.componentExportMode === 'expanded-editable-instance').length,
        nativeComponents: compatEntries.filter(e => e.componentExportMode === 'native-component').length,
        rasterizedComponentInstances: 0,
      },
      compatibilityCounts: counts,
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
      reportPath: finalReportPath,
      buildResult: buildRes,
      report,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
