import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field, walkNodes } from '../scripts/parse-payload.mjs';
import { buildNodeIndex, canonicalJson, computeContentHash, sha256 } from './document.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';
import { queryAuthoringNodes } from './authoring-query.mjs';
import { locateDiagnostic } from './diagnostics.mjs';
import { exportStudioDocumentToRp } from './export-rp.mjs';
import { rp9ControlPointsToSubpaths } from './vector-paths.mjs';

const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code, ...extra });
};

function formatHexArgb(val) {
  if (typeof val !== 'number' || val === 0) return null;
  const u = val >>> 0;
  const aa = (u >>> 24) & 0xff;
  const rgb = (u & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
  if (aa === 0xff) return `#${rgb}`;
  if (aa === 0) return null;
  return `#${rgb}${aa.toString(16).toUpperCase().padStart(2, '0')}`;
}

function normalizeColor(c) {
  if (typeof c !== 'string' || !c.trim()) return null;
  const s = c.trim().toUpperCase();
  if (/^#[0-9A-F]{6}FF$/.test(s)) return s.slice(0, 7);
  return s;
}

function extractWidgetDetail(graph, obj, baseInfo) {
  const detail = {
    ...baseInfo,
    fontSize: null,
    fontFamily: null,
    fontWeight: null,
    italic: null,
    underline: null,
    strikethrough: null,
    color: null,
    fill: null,
    stroke: null,
    strokeWidth: null,
    radius: null,
    richParagraphs: null,
    rotation: 0,
  };
  if (!graph || !obj?.body) return detail;

  const st = graph.objects.get(field(obj.body, 'MyStyle')?.value);
  const propItems = field(st?.body ?? {}, 'PropList')?.items ?? [];
  for (const it of propItems) {
    const doaNode = field(it, 'DOAName');
    const key = (doaNode?.value ?? 0) & 0x3fffffff;
    const val = field(it, 'Value');
    if (!val) continue;
    if (key === 50 && typeof val.value === 'number' && Number.isFinite(val.value)) {
      detail.rotation = val.value;
    } else if (key === 1 && typeof val.text === 'string' && val.text) {
      detail.fontFamily = val.text;
    } else if (key === 2 && typeof val.value === 'number' && Number.isFinite(val.value)) {
      detail.fontSize = Math.round(val.value);
    } else if (key === 6) {
      const col = formatHexArgb(field(val, 'fill-color')?.value);
      if (col) detail.color = col;
    } else if (key === 7) {
      const fill = formatHexArgb(field(val, 'fill-color')?.value);
      if (fill) detail.fill = fill;
    } else if (key === 8) {
      const stroke = formatHexArgb(field(val, 'fill-color')?.value);
      if (stroke) detail.stroke = stroke;
    } else if (key === 15 && typeof val.value === 'number' && Number.isFinite(val.value)) {
      detail.strokeWidth = val.value;
    } else if (key === 71 && typeof val.value === 'number' && Number.isFinite(val.value)) {
      detail.radius = val.value;
    }
  }

  let block = field(obj.body, 'RichTextBlock') ?? field(obj.body, 'TextBlock');
  if (block?.tag === 3) block = graph.objects.get(block.value)?.body;
  if (block) {
    const paragraphs = field(field(block, 'attributed-string') ?? {}, 'Paragraphs')?.items;
    if (Array.isArray(paragraphs) && paragraphs.length > 0) {
      const paraTexts = [];
      let firstRunStyled = false;
      for (const p of paragraphs) {
        const inlines = field(p, 'Inlines')?.items ?? [];
        const runTexts = [];
        const inspectRun = r => {
          const t = field(r, 'Text')?.text;
          if (typeof t === 'string') runTexts.push(t);
          if (!firstRunStyled) {
            const fam = field(r, 'Family')?.text;
            const sz = field(r, 'Size')?.value;
            const wt = field(r, 'Weight')?.value;
            const stVal = field(r, 'Style')?.value;
            const ul = field(r, 'Underline')?.value;
            const sk = field(r, 'Strikethrough')?.value;
            const col = field(r, 'Color')?.value;
            if (typeof fam === 'string' && fam) detail.fontFamily = fam;
            if (typeof sz === 'number' && Number.isFinite(sz) && sz > 0) detail.fontSize = Math.round(sz);
            if (typeof wt === 'number' && Number.isFinite(wt)) detail.fontWeight = wt;
            if (typeof stVal === 'number') detail.italic = stVal > 0;
            if (typeof ul === 'boolean') detail.underline = ul;
            if (typeof sk === 'boolean') detail.strikethrough = sk;
            if (typeof col === 'number') {
              const hex = formatHexArgb(col);
              if (hex) detail.color = hex;
            }
            firstRunStyled = true;
          }
        };
        for (const inl of inlines) {
          const inlType = field(inl, 'Type')?.text;
          if (inlType === 'Axure:AttributedString:AxRun') {
            inspectRun(inl);
          } else if (inlType === 'Axure:AttributedString:AxHyperlink') {
            for (const sub of field(inl, 'Inlines')?.items ?? []) inspectRun(sub);
          }
        }
        paraTexts.push(runTexts.join(''));
      }
      const joined = paraTexts.join('\n');
      if (joined || detail.text === undefined) detail.text = joined;
    } else if (detail.text === undefined) {
      const texts = [];
      walkNodes([block], n => {
        if (n.tag === 1 && n.entries) {
          for (const [k, v] of n.entries) {
            if (k.text === 'Text' && v.tag === 8 && typeof v.text === 'string') texts.push(v.text);
          }
        }
      });
      if (texts.length) detail.text = texts.join('');
    }
  }
  return detail;
}

export function extractRpModel(rpBuffer, rpPath = null) {
  const rp = readRp(rpBuffer, { path: rpPath, includeMasterWidgets: true, includeVectors: true });
  const records = readRecords(rpBuffer);
  const graphs = new Map();
  for (const rec of records) {
    if (!rec.strings) continue;
    try {
      graphs.set(rec.index, parsePayload(rec));
    } catch {}
  }

  const byGuid = new Map();
  const byRecordId = new Map();
  const byPageAndName = new Map();
  const allWidgets = [];

  for (const pg of rp.pages || []) {
    const graph = graphs.get(pg.record);
    for (const w of pg.widgets || []) {
      const obj = graph?.objects.get(w.id);
      const containerKey = `page:${pg.name}`;
      const enriched = extractWidgetDetail(graph, obj, {
        ...w,
        record: pg.record,
        pageName: pg.name,
        container: [],
        containerKey,
      });
      allWidgets.push(enriched);
      if (enriched.guid) byGuid.set(enriched.guid, enriched);
      byRecordId.set(`${pg.record}:${w.id}`, enriched);
      const pnKey = `${pg.name}::${enriched.name}`;
      if (!byPageAndName.has(pnKey)) byPageAndName.set(pnKey, []);
      byPageAndName.get(pnKey).push(enriched);
    }
  }

  for (const cw of rp.containedWidgets || []) {
    const graph = graphs.get(cw.record);
    const obj = graph?.objects.get(cw.id);
    const containerKey = `container:${(cw.container || []).join('/')}`;
    const enriched = extractWidgetDetail(graph, obj, {
      ...cw,
      pageName: null,
      container: cw.container || [],
      containerKey,
    });
    allWidgets.push(enriched);
    if (enriched.guid) byGuid.set(enriched.guid, enriched);
    byRecordId.set(`${cw.record}:${cw.id}`, enriched);
  }

  return {
    rp,
    allWidgets,
    byGuid,
    byRecordId,
    byPageAndName,
  };
}

function buildCompleteAuthoringMap(doc) {
  const defaultScene = resolveDocumentScene(doc);
  const authoringByScopedId = new Map();
  const resolvedByScopedId = new Map();
  const index = buildNodeIndex(doc);

  const collectFromScene = scene => {
    for (const pg of scene.pages || []) {
      for (const node of pg.nodes || []) {
        if (!resolvedByScopedId.has(node.scopedId)) {
          resolvedByScopedId.set(node.scopedId, node);
        }
        if (!authoringByScopedId.has(node.scopedId)) {
          try {
            const q = queryAuthoringNodes({
              doc,
              scene,
              args: { pageId: pg.id, nodeIds: [node.scopedId], limit: 1 },
            });
            if (q.nodes?.[0]) authoringByScopedId.set(node.scopedId, q.nodes[0]);
          } catch {}
        }
      }
    }
  };

  collectFromScene(defaultScene);

  // Also resolve inactive dynamic-panel states so every state's children have full authoring targets
  const panelEntries = [...new Set(index.byScopedId.values())].filter(
    e => e.node?.type === 'dynamic-panel' && Array.isArray(e.node.states) && e.node.states.length > 1
  );
  for (const panelEntry of panelEntries) {
    const activeId = panelEntry.node.activeState || panelEntry.node.states[0]?.id;
    for (const st of panelEntry.node.states) {
      if (!st?.id || st.id === activeId) continue;
      try {
        const stScene = resolveDocumentScene(doc, {
          activePanelStates: {
            [panelEntry.scopedId]: st.id,
            [panelEntry.id]: st.id,
          },
        });
        collectFromScene(stScene);
      } catch {}
    }
  }

  return {
    defaultScene,
    index,
    authoringByScopedId,
    resolvedByScopedId,
  };
}

function normalizeSymbolScopedId(sym, index) {
  const rawId = sym.id || sym.logicalId || '';
  if (!rawId) return null;
  if (index.byScopedId.has(rawId)) return rawId;
  if (rawId.includes('/item/')) {
    const tplId = rawId.replace('/item/', '/template/');
    if (index.byScopedId.has(tplId)) return tplId;
  }
  return rawId;
}

function matchSymbolWidgetsInModel(sym, model, pageName) {
  const matches = [];
  if (Array.isArray(sym.native) && sym.native.length > 0) {
    for (const loc of sym.native) {
      const hit = model.byRecordId.get(`${loc.record}:${loc.id}`);
      if (hit) matches.push(hit);
    }
  }
  const symName = sym.name || sym.display || sym.nativeName || '';
  const symLabel = sym.label || String(sym.id || '').split('/').pop();
  const escLabel = String(symLabel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const primaryRe = new RegExp(`^(?:[a-z]+-)+${escLabel}-[0-9a-f]{8,16}$`);
  const bgRe = new RegExp(`^bg-(?:[a-z]+-)+${escLabel}-[0-9a-f]{8,16}$`);

  const pool = model.allWidgets.filter(w => {
    if (w.pageName && pageName && w.pageName !== pageName) return false;
    return true;
  });

  let primary = matches.find(w => !String(w.name || '').startsWith('bg-')) || null;
  if (!primary) {
    primary =
      pool.find(
        w =>
          !String(w.name || '').startsWith('bg-') &&
          (w.name === symName || w.name === symLabel || primaryRe.test(w.name || ''))
      ) || null;
  }
  const bg =
    matches.find(w => String(w.name || '').startsWith('bg-')) ||
    pool.find(
      w =>
        ((symName && w.name === `bg-${symName}`) || bgRe.test(w.name || '')) &&
        w.containerKey === (primary?.containerKey || `page:${pageName}`)
    ) ||
    null;

  return { primary, bg };
}

function findCounterpartInEdited(baseW, editedModel) {
  if (!baseW) return null;
  if (baseW.guid && editedModel.byGuid.has(baseW.guid)) {
    return editedModel.byGuid.get(baseW.guid);
  }
  const byRec = editedModel.byRecordId.get(`${baseW.record}:${baseW.id}`);
  if (byRec && (byRec.name === baseW.name || byRec.type === baseW.type)) {
    return byRec;
  }
  return (
    editedModel.allWidgets.find(
      w => w.containerKey === baseW.containerKey && w.name === baseW.name && w.type === baseW.type
    ) || null
  );
}

function effectiveWidgetState(primary, bg) {
  if (!primary && !bg) return null;
  const main = primary || bg;
  const box = bg || primary;
  return {
    guid: main.guid,
    bgGuid: bg?.guid || null,
    record: main.record,
    id: main.id,
    name: main.name,
    type: main.type,
    className: main.className,
    containerKey: main.containerKey,
    container: main.container || [],
    x: typeof box.x === 'number' ? box.x : main.x,
    y: typeof box.y === 'number' ? box.y : main.y,
    w: typeof box.w === 'number' ? box.w : main.w,
    h: typeof box.h === 'number' ? box.h : main.h,
    text: main.text,
    fontSize: main.fontSize,
    fontFamily: main.fontFamily,
    fontWeight: main.fontWeight,
    italic: main.italic,
    underline: main.underline,
    strikethrough: main.strikethrough,
    color: normalizeColor(main.color),
    fill: normalizeColor(box.fill ?? main.fill),
    stroke: normalizeColor(box.stroke ?? main.stroke),
    strokeWidth: box.strokeWidth ?? main.strokeWidth,
    radius: box.radius ?? main.radius,
    rotation: box.rotation ?? main.rotation ?? 0,
    shape: box.shape ?? main.shape ?? 0,
    controlPoints: box.controlPoints ?? main.controlPoints ?? null,
    interactions: main.interactions || [],
  };
}

function isRepeaterBindingFormula(text) {
  if (typeof text !== 'string') return false;
  return /^=\s*item\.[a-zA-Z0-9_]+/.test(text.trim()) || /\$\{\s*item\.[a-zA-Z0-9_]+/.test(text);
}

function readNodeSnapshot(docIndex, scopedId, subNodeId = null) {
  const entry = docIndex.byScopedId.get(scopedId);
  if (!entry?.node) return null;
  if (subNodeId) {
    return structuredClone(entry.node.overrides?.[subNodeId] || {});
  }
  const n = entry.node;
  return {
    name: n.name,
    text: n.text ?? n.content,
    title: n.title,
    subtitle: n.subtitle,
    body: n.body,
    actionText: n.actionText,
    tag: n.tag,
    titleFontSize: n.titleFontSize,
    subtitleFontSize: n.subtitleFontSize,
    bodyFontSize: n.bodyFontSize,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    fontSize: n.fontSize,
    fontFamily: n.fontFamily,
    fontWeight: n.fontWeight,
    color: normalizeColor(n.color),
    fill: normalizeColor(n.fill),
    stroke: normalizeColor(n.stroke),
    strokeWidth: n.strokeWidth,
    radius: n.radius,
    rotation: n.rotation ?? 0,
  };
}

export async function syncNativeRpToStudio({
  doc,
  store = null,
  persistence = null,
  projectDir = null,
  rpPath,
  baseRpPath = null,
  baselinePath = null,
  mode = 'preview',
  prefer = 'fail',
  resolutions = {},
  baseRevision = undefined,
  idempotencyKey = undefined,
  previewHash = undefined,
  allowFormulaOverwrite = false,
  rebuildRp = false,
  outRpPath = null,
  simulateCrashStage = null,
} = {}) {
  if (!['preview', 'apply'].includes(mode)) {
    fail('E_NATIVE_SYNC_MODE', `mode 必须为 preview 或 apply（收到 ${mode}）`);
  }
  if (!['fail', 'studio', 'native'].includes(prefer)) {
    fail('E_NATIVE_SYNC_PREFER', `prefer 必须为 fail、studio 或 native（收到 ${prefer}）`);
  }
  if (!rpPath || typeof rpPath !== 'string') {
    fail('E_NATIVE_RP_REQUIRED', '必须提供 rpPath');
  }
  const absRpPath = isAbsolute(rpPath) ? rpPath : resolve(projectDir || process.cwd(), rpPath);
  if (!existsSync(absRpPath)) {
    fail('E_NATIVE_RP_NOT_FOUND', `找不到 .rp 文件：${absRpPath}`);
  }

  const currentDoc = store?.doc || doc;
  if (!currentDoc) {
    fail('E_NATIVE_SYNC_DOC', '缺少当前 Studio 权威文档');
  }
  if (baseRevision !== undefined && baseRevision !== null && Number(baseRevision) !== currentDoc.revision) {
    const scene = resolveDocumentScene(currentDoc);
    fail('E_STALE_REVISION', `基准版本 r${baseRevision} 已过期，当前版本为 r${currentDoc.revision}`, {
      currentRevision: currentDoc.revision,
      diagnostic: locateDiagnostic({ doc: currentDoc, scene, code: 'E_STALE_REVISION' }),
    });
  }

  const resolvedBaselinePath = baselinePath
    ? (isAbsolute(baselinePath) ? baselinePath : resolve(projectDir || process.cwd(), baselinePath))
    : existsSync(`${absRpPath}.baseline.json`)
      ? `${absRpPath}.baseline.json`
      : baseRpPath && existsSync(`${resolve(projectDir || process.cwd(), baseRpPath)}.baseline.json`)
        ? `${resolve(projectDir || process.cwd(), baseRpPath)}.baseline.json`
        : null;

  if (!resolvedBaselinePath || !existsSync(resolvedBaselinePath)) {
    fail('E_NATIVE_BASELINE_MISSING', `找不到导出基线文件 (.baseline.json)：${absRpPath}.baseline.json`);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(resolvedBaselinePath, 'utf8'));
  } catch (err) {
    fail('E_NATIVE_BASELINE_CORRUPT', `无法解析导出基线文件：${err.message}`);
  }

  const studioOrigin = baseline.studioOrigin || null;
  if (studioOrigin?.documentId && currentDoc.documentId && studioOrigin.documentId !== currentDoc.documentId) {
    fail(
      'E_NATIVE_DOCUMENT_MISMATCH',
      `原生文件源自工程 ${studioOrigin.documentId}，与当前画布工程 ${currentDoc.documentId} 不匹配`,
      { expectedDocumentId: currentDoc.documentId, actualDocumentId: studioOrigin.documentId }
    );
  }

  // Load baseline .rp buffer
  let baseRpBuf = null;
  if (baseRpPath) {
    const absBaseRp = isAbsolute(baseRpPath) ? baseRpPath : resolve(projectDir || process.cwd(), baseRpPath);
    if (existsSync(absBaseRp)) baseRpBuf = readFileSync(absBaseRp);
  }
  if (!baseRpBuf && typeof baseline.baseRpBase64 === 'string' && baseline.baseRpBase64.length > 0) {
    baseRpBuf = Buffer.from(baseline.baseRpBase64, 'base64');
  }
  if (!baseRpBuf) {
    fail('E_NATIVE_BASE_RP_MISSING', '基线文件中缺少 baseRpBase64 且未提供有效的 baseRpPath');
  }

  // Load baseline StudioDocument snapshot
  let baseStudioDoc = null;
  const candidateSourcePaths = [
    studioOrigin?.sourceFile ? resolve(dirname(resolvedBaselinePath), studioOrigin.sourceFile) : null,
    `${absRpPath}.source/studio-document.json`,
    `${resolvedBaselinePath.replace(/\.baseline\.json$/, '')}.source/studio-document.json`,
  ].filter(Boolean);
  for (const cand of candidateSourcePaths) {
    if (existsSync(cand)) {
      try {
        const rawBytes = readFileSync(cand);
        if (studioOrigin?.sha256 && sha256(rawBytes) !== studioOrigin.sha256) {
          fail('E_NATIVE_BASELINE_SHA_MISMATCH', `基线源文档哈希校验失败：${cand}`);
        }
        baseStudioDoc = JSON.parse(rawBytes.toString('utf8'));
        break;
      } catch (err) {
        if (err.code === 'E_NATIVE_BASELINE_SHA_MISMATCH') throw err;
      }
    }
  }
  if (!baseStudioDoc) {
    baseStudioDoc = structuredClone(currentDoc);
  }

  const editedRpBuf = readFileSync(absRpPath);
  const editedRpSha256 = sha256(editedRpBuf);
  const baseRpSha256 = baseline.rpSha256 || sha256(baseRpBuf);

  const baseModel = extractRpModel(baseRpBuf, `${absRpPath}.base`);
  const editedModel = extractRpModel(editedRpBuf, absRpPath);

  const baseAuth = buildCompleteAuthoringMap(baseStudioDoc);
  const currAuth = buildCompleteAuthoringMap(currentDoc);

  const pageById = new Map((currentDoc.pages || []).map(p => [p.id, p]));
  const pageByName = new Map((currentDoc.pages || []).map(p => [p.name, p]));

  // Map every symbol in baseline.sourceMap to its base & edited widget state
  const symbolStates = new Map();
  const mappedBaseGuids = new Set();
  const symbols = Array.isArray(baseline.sourceMap) ? baseline.sourceMap : [];

  for (const sym of symbols) {
    const scopedId = normalizeSymbolScopedId(sym, currAuth.index);
    if (!scopedId) continue;
    const pageId = sym.pageId || scopedId.split('/')[0];
    const pageObj = pageById.get(pageId) || pageByName.get(sym.pageName);
    const pageName = sym.pageName || pageObj?.name || pageId;

    const { primary: basePrimary, bg: baseBg } = matchSymbolWidgetsInModel(sym, baseModel, pageName);
    if (!basePrimary && !baseBg) continue;
    if (basePrimary?.guid) mappedBaseGuids.add(basePrimary.guid);
    if (baseBg?.guid) mappedBaseGuids.add(baseBg.guid);

    const editPrimary = findCounterpartInEdited(basePrimary, editedModel);
    const editBg = findCounterpartInEdited(baseBg, editedModel);

    const baseState = effectiveWidgetState(basePrimary, baseBg);
    const editState = effectiveWidgetState(editPrimary, editBg);

    symbolStates.set(scopedId, {
      sym,
      scopedId,
      pageId: pageObj?.id || pageId,
      pageName,
      baseState,
      editState,
      deletedInNative: Boolean(baseState && !editState),
    });
  }

  const commands = [];
  const changes = [];
  const ignoredFlowPositions = [];
  const formulaProtectedNodes = [];
  const unsupportedNativeChanges = [];
  const conflicts = [];
  const deletedOwnerIds = new Set();

  // Helper to check if a target node/property was modified in Studio since baseline
  const checkConflict = ({ scopedId, targetNodeId, pageId, subNodeId = null, fieldName, nativeValue, baseValue }) => {
    if (currentDoc.revision === baseStudioDoc.revision && currentDoc.contentHash === baseStudioDoc.contentHash) {
      return { conflicted: false, applyNative: true };
    }
    const baseSnap = readNodeSnapshot(baseAuth.index, targetNodeId, subNodeId);
    const currSnap = readNodeSnapshot(currAuth.index, targetNodeId, subNodeId);
    if (!baseSnap || !currSnap) return { conflicted: false, applyNative: true };
    const baseFieldVal = baseSnap[fieldName];
    const studioFieldVal = currSnap[fieldName];
    const studioChanged = canonicalJson(baseFieldVal) !== canonicalJson(studioFieldVal);
    const matchesNative = canonicalJson(studioFieldVal) === canonicalJson(nativeValue);
    if (!studioChanged || matchesNative) {
      return { conflicted: false, applyNative: true };
    }
    const choice = resolutions?.[targetNodeId] || resolutions?.[scopedId] || resolutions?.[`${targetNodeId}.${fieldName}`] || prefer;
    const conflictItem = {
      scopedId,
      targetNodeId,
      pageId,
      ...(subNodeId ? { subNodeId } : {}),
      field: fieldName,
      baseValue: baseFieldVal ?? baseValue ?? null,
      studioValue: studioFieldVal ?? null,
      nativeValue,
      resolution: choice === 'fail' ? 'unresolved' : choice,
    };
    conflicts.push(conflictItem);
    return {
      conflicted: true,
      applyNative: choice === 'native',
      resolution: choice,
    };
  };

  for (const [scopedId, item] of symbolStates.entries()) {
    const { sym, pageId, baseState, editState, deletedInNative } = item;
    const pageObj = pageById.get(pageId);
    // Skip synthetic page root container unless deleted/styled
    if (sym.pointer && /^\/pages\/\d+\/root$/.test(sym.pointer)) continue;
    if (pageObj?.root?.id && scopedId === `${pageId}/${pageObj.root.id}`) continue;

    const authNode = currAuth.authoringByScopedId.get(scopedId) || baseAuth.authoringByScopedId.get(scopedId);
    const sourceEntry = currAuth.index.byScopedId.get(scopedId);
    if (!authNode && !sourceEntry) continue;

    const target = authNode?.target || {
      kind: 'node',
      nodeId: sourceEntry?.scopedId || scopedId,
      editable: !sourceEntry?.node?.locked,
    };
    const targetNodeId = target.nodeId || scopedId;

    if (deletedInNative) {
      if (target.kind === 'node') {
        if (!deletedOwnerIds.has(targetNodeId)) {
          const c = checkConflict({
            scopedId,
            targetNodeId,
            pageId,
            fieldName: 'name',
            nativeValue: null,
            baseValue: baseState.name,
          });
          if (c.applyNative) {
            deletedOwnerIds.add(targetNodeId);
            commands.push({ type: 'removeNode', pageId, nodeId: targetNodeId });
            changes.push({
              kind: 'remove-node',
              scopedId,
              targetNodeId,
              pageId,
            });
          }
        }
      } else {
        unsupportedNativeChanges.push({
          scopedId,
          ownerId: targetNodeId,
          field: 'delete',
          reason: '受控子节点（宏或组件内部节点）不支持单独在原生端删除；请修改源宏参数或删除整个源实例',
        });
      }
      continue;
    }

    if (!baseState || !editState) continue;
    if (deletedOwnerIds.has(targetNodeId)) continue;

    // Compute deltas between baseState and editState
    const rawDx = (editState.x ?? 0) - (baseState.x ?? 0);
    const rawDy = (editState.y ?? 0) - (baseState.y ?? 0);
    const dw = (editState.w ?? 0) - (baseState.w ?? 0);
    const dh = (editState.h ?? 0) - (baseState.h ?? 0);

    // Subtract parent delta if parent is in the same native diagram container
    const parentScopedId = authNode?.layoutContext?.parentId || (sourceEntry?.parent ? `${sourceEntry.scope}/${sourceEntry.parent.id}` : null);
    const parentSymState = parentScopedId ? symbolStates.get(parentScopedId) : null;
    const sameDiagramAsParent =
      parentSymState?.baseState &&
      parentSymState?.editState &&
      parentSymState.baseState.containerKey === baseState.containerKey;
    const parentDx = sameDiagramAsParent ? (parentSymState.editState.x ?? 0) - (parentSymState.baseState.x ?? 0) : 0;
    const parentDy = sameDiagramAsParent ? (parentSymState.editState.y ?? 0) - (parentSymState.baseState.y ?? 0) : 0;
    const dx = rawDx - parentDx;
    const dy = rawDy - parentDy;

    const baseResolvedNode = baseAuth.resolvedByScopedId.get(scopedId) || currAuth.resolvedByScopedId.get(scopedId) || null;
    const baseRawForCompare = baseAuth.index.byScopedId.get(targetNodeId)?.node || sourceEntry?.node || null;
    const effectiveBaseFontSize =
      typeof baseState.fontSize === 'number'
        ? baseState.fontSize
        : typeof baseResolvedNode?.fontSize === 'number'
          ? baseResolvedNode.fontSize
          : typeof baseRawForCompare?.fontSize === 'number'
            ? baseRawForCompare.fontSize
            : null;
    const effectiveBaseColor = normalizeColor(
      baseState.color ?? baseResolvedNode?.color ?? baseRawForCompare?.color ?? null
    );
    const effectiveBaseFill = normalizeColor(
      baseState.fill ?? baseResolvedNode?.fill ?? baseRawForCompare?.fill ?? null
    );

    const textChanged =
      editState.text !== undefined &&
      editState.text !== baseState.text &&
      String(editState.text ?? '') !== String(baseState.text ?? '');
    const fontSizeChanged =
      typeof editState.fontSize === 'number' &&
      editState.fontSize !== baseState.fontSize &&
      (effectiveBaseFontSize === null || Math.abs(editState.fontSize - effectiveBaseFontSize) >= 1);
    const fontFamilyChanged =
      typeof editState.fontFamily === 'string' &&
      editState.fontFamily &&
      editState.fontFamily !== baseState.fontFamily;
    const colorChanged =
      Boolean(editState.color) &&
      editState.color !== baseState.color &&
      editState.color !== effectiveBaseColor;
    const fillChanged =
      Boolean(editState.fill) &&
      editState.fill !== baseState.fill &&
      editState.fill !== effectiveBaseFill;
    const strokeChanged =
      Boolean(editState.stroke) &&
      editState.stroke !== baseState.stroke;
    const radiusChanged =
      typeof editState.radius === 'number' &&
      editState.radius !== baseState.radius;

    const rotationChanged = editState.rotation !== baseState.rotation;

    // Case 1: Macro-controlled child (e.g. card_title, card_body, list-item_title)
    if (target.kind === 'macro-parameter' || (target.kind === 'controlled' && authNode?.controls?.some(c => c.kind === 'macro'))) {
      if (rotationChanged) unsupportedNativeChanges.push({ scopedId, ownerId: targetNodeId, field: 'rotation', reason: '宏展开子节点旋转不能直接回填' });
      const ownerSymState = targetNodeId ? symbolStates.get(targetNodeId) : null;
      const ownerDx = ownerSymState?.baseState && ownerSymState?.editState
        ? (ownerSymState.editState.x ?? 0) - (ownerSymState.baseState.x ?? 0)
        : 0;
      const ownerDy = ownerSymState?.baseState && ownerSymState?.editState
        ? (ownerSymState.editState.y ?? 0) - (ownerSymState.baseState.y ?? 0)
        : 0;
      const relMacroDx = rawDx - ownerDx;
      const relMacroDy = rawDy - ownerDy;

      if (target.kind === 'macro-parameter' && target.propertyMap) {
        const macroProps = {};
        if (textChanged && target.propertyMap.text) {
          const propName = target.propertyMap.text;
          const c = checkConflict({
            scopedId,
            targetNodeId,
            pageId,
            fieldName: propName,
            nativeValue: editState.text,
            baseValue: baseState.text,
          });
          if (c.applyNative) macroProps[propName] = editState.text;
        }
        if (fontSizeChanged) {
          if (target.propertyMap.fontSize) {
            const propName = target.propertyMap.fontSize;
            const c = checkConflict({
              scopedId,
              targetNodeId,
              pageId,
              fieldName: propName,
              nativeValue: editState.fontSize,
              baseValue: baseState.fontSize,
            });
            if (c.applyNative) macroProps[propName] = editState.fontSize;
          } else {
            unsupportedNativeChanges.push({
              scopedId,
              ownerId: targetNodeId,
              field: 'fontSize',
              reason: `宏节点 ${targetNodeId} 未暴露 ${scopedId} 的字号参数`,
            });
          }
        }
        if (Object.keys(macroProps).length > 0) {
          commands.push({
            type: 'setProperties',
            pageId,
            nodeId: targetNodeId,
            properties: macroProps,
          });
          changes.push({
            kind: 'macro-parameter',
            scopedId,
            targetNodeId,
            pageId,
            properties: macroProps,
          });
        }
      } else if (textChanged || fontSizeChanged) {
        unsupportedNativeChanges.push({
          scopedId,
          ownerId: targetNodeId,
          field: textChanged ? 'text' : 'fontSize',
          reason: `宏展开子节点 ${scopedId} 由宏内部控制，不支持直接写回`,
        });
      }

      if (Math.abs(relMacroDx) > 1 || Math.abs(relMacroDy) > 1 || Math.abs(dw) > 1 || Math.abs(dh) > 1) {
        unsupportedNativeChanges.push({
          scopedId,
          ownerId: targetNodeId,
          field: 'geometry',
          delta: { dx: relMacroDx, dy: relMacroDy, dw, dh },
          reason: `宏展开子节点 ${scopedId} 的内部坐标与尺寸由宏模板决定，已忽略内部几何偏移`,
        });
      }
      continue;
    }

    // Case 2: Component instance descendant (`instance-override`)
    if (target.kind === 'instance-override' && target.nodeId && target.subNodeId) {
      const isInstanceRoot = target.subNodeId === '$root' || target.subNodeId.endsWith('/$root');
      const instEntry = currAuth.index.byScopedId.get(target.nodeId);
      const baseInstEntry = baseAuth.index.byScopedId.get(target.nodeId);

      if (isInstanceRoot && (Math.abs(dx) >= 1 || Math.abs(dy) >= 1)) {
        const baseX = Number(baseInstEntry?.node?.x ?? instEntry?.node?.x ?? 0);
        const baseY = Number(baseInstEntry?.node?.y ?? instEntry?.node?.y ?? 0);
        const nextX = Math.round(baseX + dx);
        const nextY = Math.round(baseY + dy);
        const c = checkConflict({
          scopedId,
          targetNodeId: target.nodeId,
          pageId,
          fieldName: 'x',
          nativeValue: nextX,
          baseValue: baseX,
        });
        if (c.applyNative) {
          commands.push({ type: 'moveNode', pageId, nodeId: target.nodeId, x: nextX, y: nextY });
          changes.push({ kind: 'move-instance', scopedId, targetNodeId: target.nodeId, pageId, x: nextX, y: nextY });
        }
      }

      const overrideProps = {};
      if (rotationChanged) {
        const c = checkConflict({ scopedId, targetNodeId: target.nodeId, pageId, subNodeId: target.subNodeId, fieldName: 'rotation', nativeValue: editState.rotation, baseValue: baseState.rotation });
        if (c.applyNative) overrideProps.rotation = editState.rotation;
      }
      if (textChanged) {
        const c = checkConflict({
          scopedId,
          targetNodeId: target.nodeId,
          pageId,
          subNodeId: target.subNodeId,
          fieldName: 'text',
          nativeValue: editState.text,
          baseValue: baseState.text,
        });
        if (c.applyNative) overrideProps.text = editState.text;
      }
      if (fontSizeChanged) {
        const c = checkConflict({
          scopedId,
          targetNodeId: target.nodeId,
          pageId,
          subNodeId: target.subNodeId,
          fieldName: 'fontSize',
          nativeValue: editState.fontSize,
          baseValue: baseState.fontSize,
        });
        if (c.applyNative) overrideProps.fontSize = editState.fontSize;
      }
      if (fontFamilyChanged) overrideProps.fontFamily = editState.fontFamily;
      if (colorChanged) overrideProps.color = editState.color;
      if (fillChanged) overrideProps.fill = editState.fill;
      if (strokeChanged) overrideProps.stroke = editState.stroke;
      if (radiusChanged) overrideProps.radius = editState.radius;
      if (Math.abs(dw) >= 1) overrideProps.w = Math.round(editState.w);
      if (Math.abs(dh) >= 1) overrideProps.h = Math.round(editState.h);

      if (Object.keys(overrideProps).length > 0) {
        commands.push({
          type: 'setInstanceOverride',
          pageId,
          nodeId: target.nodeId,
          subNodeId: target.subNodeId,
          properties: overrideProps,
        });
        changes.push({
          kind: 'instance-override',
          scopedId,
          targetNodeId: target.nodeId,
          subNodeId: target.subNodeId,
          pageId,
          properties: overrideProps,
        });
      }
      continue;
    }

    // Case 3: Regular source node (including flow layout children, inactive panel states, repeater templates, macro root boxes)
    const rawNode = sourceEntry?.node || baseAuth.index.byScopedId.get(targetNodeId)?.node;
    if (!rawNode) continue;
    const baseRawNode = baseAuth.index.byScopedId.get(targetNodeId)?.node || rawNode;
    const parentMode = authNode?.layoutContext?.parentMode || sourceEntry?.parent?.layout || 'stack';
    const isFlowChild = ['row', 'column', 'grid'].includes(parentMode);
    const inRepeaterTemplate = targetNodeId.includes('/template/');

    // 3a. Position change (moveNode vs flow layout guidance)
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
      if (isFlowChild) {
        const flowControl = authNode?.controls?.find(c => c.kind === 'flow-layout');
        ignoredFlowPositions.push({
          code: 'W_FLOW_POSITION_IGNORED',
          scopedId,
          targetNodeId,
          pageId,
          parentId: authNode?.layoutContext?.parentId || sourceEntry?.parent?.id || null,
          parentLayout: parentMode,
          nativeDelta: { dx, dy },
          suggestion: flowControl?.suggestion || null,
          reason: `父容器采用 ${parentMode} 流式布局，位置由子节点顺序、gap 与 padding 决定，已忽略原生坐标偏移 (${dx}, ${dy})`,
        });
      } else {
        const baseSourceX = Number(
          authNode?.layoutContext?.sourceX ??
          baseRawNode.x ??
          rawNode.x ??
          baseState.x ??
          0
        );
        const baseSourceY = Number(
          authNode?.layoutContext?.sourceY ??
          baseRawNode.y ??
          rawNode.y ??
          baseState.y ??
          0
        );
        const nextX = Math.round(baseSourceX + dx);
        const nextY = Math.round(baseSourceY + dy);
        const cx = checkConflict({
          scopedId,
          targetNodeId,
          pageId,
          fieldName: 'x',
          nativeValue: nextX,
          baseValue: baseSourceX,
        });
        const cy = checkConflict({
          scopedId,
          targetNodeId,
          pageId,
          fieldName: 'y',
          nativeValue: nextY,
          baseValue: baseSourceY,
        });
        if (cx.applyNative && cy.applyNative) {
          commands.push({
            type: 'moveNode',
            pageId,
            nodeId: targetNodeId,
            x: nextX,
            y: nextY,
          });
          changes.push({
            kind: 'move',
            scopedId,
            targetNodeId,
            pageId,
            before: { x: baseSourceX, y: baseSourceY },
            after: { x: nextX, y: nextY },
          });
        }
      }
    }

    // 3b. Size change (resizeNode) - preserve hug/fill unless native size actually changed
    if (Math.abs(dw) >= 1 || Math.abs(dh) >= 1) {
      const nextW = Math.abs(dw) >= 1 ? Math.round(editState.w) : (rawNode.w ?? Math.round(editState.w));
      const nextH = Math.abs(dh) >= 1 ? Math.round(editState.h) : (rawNode.h ?? Math.round(editState.h));
      const cw = Math.abs(dw) >= 1
        ? checkConflict({ scopedId, targetNodeId, pageId, fieldName: 'w', nativeValue: nextW, baseValue: baseRawNode.w })
        : { applyNative: true };
      const ch = Math.abs(dh) >= 1
        ? checkConflict({ scopedId, targetNodeId, pageId, fieldName: 'h', nativeValue: nextH, baseValue: baseRawNode.h })
        : { applyNative: true };
      if (cw.applyNative && ch.applyNative) {
        commands.push({
          type: 'resizeNode',
          pageId,
          nodeId: targetNodeId,
          w: nextW,
          h: nextH,
        });
        changes.push({
          kind: 'resize',
          scopedId,
          targetNodeId,
          pageId,
          before: { w: baseState.w, h: baseState.h },
          after: { w: nextW, h: nextH },
        });
      }
    }

    // 3c. Text change (protect repeater binding formulas!)
    if (textChanged) {
      const currentRawText = rawNode.text ?? rawNode.content ?? '';
      if (inRepeaterTemplate && isRepeaterBindingFormula(currentRawText) && !allowFormulaOverwrite && !isRepeaterBindingFormula(editState.text)) {
        formulaProtectedNodes.push({
          scopedId,
          targetNodeId,
          pageId,
          formula: currentRawText,
          ignoredNativeText: editState.text,
          reason: '保护中继器模板绑定公式，拒绝将原生首行预览字面量覆盖回 =item.xxx 源公式',
        });
      } else if (rawNode.type === 'card' && rawNode.title !== undefined && !Array.isArray(rawNode.children)) {
        const c = checkConflict({
          scopedId,
          targetNodeId,
          pageId,
          fieldName: 'title',
          nativeValue: editState.text,
          baseValue: baseRawNode.title,
        });
        if (c.applyNative) {
          commands.push({ type: 'setProperties', pageId, nodeId: targetNodeId, properties: { title: editState.text } });
          changes.push({ kind: 'text', scopedId, targetNodeId, pageId, before: baseState.text, after: editState.text });
        }
      } else {
        const c = checkConflict({
          scopedId,
          targetNodeId,
          pageId,
          fieldName: 'text',
          nativeValue: editState.text,
          baseValue: baseState.text,
        });
        if (c.applyNative) {
          commands.push({ type: 'setText', pageId, nodeId: targetNodeId, text: editState.text });
          changes.push({ kind: 'text', scopedId, targetNodeId, pageId, before: baseState.text, after: editState.text });
        }
      }
    }

    // 3d. Vector path controlPoints change (if edited in RP9 Shape: 300)
    if (
      rawNode.type === 'path' &&
      Array.isArray(editState.controlPoints) &&
      editState.controlPoints.length > 0 &&
      canonicalJson(editState.controlPoints) !== canonicalJson(baseState.controlPoints)
    ) {
      const convertedSubpaths = rp9ControlPointsToSubpaths(
        editState.controlPoints,
        editState.w ?? rawNode.w ?? 100,
        editState.h ?? rawNode.h ?? 100
      );
      const c = checkConflict({
        scopedId,
        targetNodeId,
        pageId,
        fieldName: 'points',
        nativeValue: convertedSubpaths,
        baseValue: baseRawNode.points,
      });
      if (c.applyNative) {
        commands.push({
          type: 'editPath',
          pageId,
          nodeId: targetNodeId,
          operation: 'set-subpaths',
          subpaths: convertedSubpaths,
        });
        changes.push({
          kind: 'vector-control-points',
          scopedId,
          targetNodeId,
          pageId,
          subpaths: convertedSubpaths,
        });
      }
    }

    // 3e. Style & typography changes
    const styleProps = {};
    if (rotationChanged) {
      const c = checkConflict({ scopedId, targetNodeId, pageId, fieldName: 'rotation', nativeValue: editState.rotation, baseValue: baseState.rotation });
      if (c.applyNative) styleProps.rotation = editState.rotation;
    }
    if (fontSizeChanged) {
      if (rawNode.type === 'card' && !Array.isArray(rawNode.children)) {
        const c = checkConflict({
          scopedId,
          targetNodeId,
          pageId,
          fieldName: 'titleFontSize',
          nativeValue: editState.fontSize,
          baseValue: baseState.fontSize,
        });
        if (c.applyNative) styleProps.titleFontSize = editState.fontSize;
      } else {
        const c = checkConflict({
          scopedId,
          targetNodeId,
          pageId,
          fieldName: 'fontSize',
          nativeValue: editState.fontSize,
          baseValue: baseState.fontSize,
        });
        if (c.applyNative) styleProps.fontSize = editState.fontSize;
      }
    }
    if (fontFamilyChanged && rawNode.type !== 'input') {
      const c = checkConflict({
        scopedId,
        targetNodeId,
        pageId,
        fieldName: 'fontFamily',
        nativeValue: editState.fontFamily,
        baseValue: baseState.fontFamily,
      });
      if (c.applyNative) styleProps.fontFamily = editState.fontFamily;
    }
    if (colorChanged) {
      const c = checkConflict({
        scopedId,
        targetNodeId,
        pageId,
        fieldName: 'color',
        nativeValue: editState.color,
        baseValue: baseState.color,
      });
      if (c.applyNative) styleProps.color = editState.color;
    }
    if (fillChanged) {
      const c = checkConflict({
        scopedId,
        targetNodeId,
        pageId,
        fieldName: 'fill',
        nativeValue: editState.fill,
        baseValue: baseState.fill,
      });
      if (c.applyNative) styleProps.fill = editState.fill;
    }
    if (strokeChanged) {
      const c = checkConflict({
        scopedId,
        targetNodeId,
        pageId,
        fieldName: 'stroke',
        nativeValue: editState.stroke,
        baseValue: baseState.stroke,
      });
      if (c.applyNative) styleProps.stroke = editState.stroke;
    }
    if (radiusChanged) {
      const c = checkConflict({
        scopedId,
        targetNodeId,
        pageId,
        fieldName: 'radius',
        nativeValue: editState.radius,
        baseValue: baseState.radius,
      });
      if (c.applyNative) styleProps.radius = editState.radius;
    }

    if (Object.keys(styleProps).length > 0) {
      commands.push({
        type: 'setProperties',
        pageId,
        nodeId: targetNodeId,
        properties: styleProps,
      });
      changes.push({
        kind: 'style',
        scopedId,
        targetNodeId,
        pageId,
        properties: styleProps,
      });
    }

    // 3e. Widget rename in native
    if (editState.name && editState.name !== baseState.name) {
      const c = checkConflict({
        scopedId,
        targetNodeId,
        pageId,
        fieldName: 'name',
        nativeValue: editState.name,
        baseValue: baseRawNode.name ?? baseState.name,
      });
      if (c.applyNative) {
        commands.push({
          type: 'renameNode',
          pageId,
          nodeId: targetNodeId,
          name: editState.name,
        });
        changes.push({
          kind: 'rename',
          scopedId,
          targetNodeId,
          pageId,
          before: baseState.name,
          after: editState.name,
        });
      }
    }
  }

  // Detect brand-new widgets added in editedRp on known pages
  const baseGuids = new Set(baseModel.allWidgets.map(w => w.guid).filter(Boolean));
  const baseRecordIds = new Set(baseModel.allWidgets.map(w => `${w.record}:${w.id}`));
  const baseContainerNames = new Set(baseModel.allWidgets.map(w => `${w.containerKey}::${w.name}`));
  for (const w of editedModel.allWidgets) {
    if ((w.guid && baseGuids.has(w.guid)) || baseRecordIds.has(`${w.record}:${w.id}`) || baseContainerNames.has(`${w.containerKey}::${w.name}`)) {
      continue;
    }
    if (!w.pageName || /^bg-/.test(w.name || '')) continue;
    const pageObj = pageByName.get(w.pageName) || pageById.get(w.pageName);
    if (!pageObj) continue;
    const rawId = String(w.name || `native_${w.guid.slice(0, 8)}`)
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || `native_${w.guid.slice(0, 8)}`;
    const nodeType =
      w.type === 'TextBox' || w.type === 'TextArea'
        ? 'input'
        : w.type === 'ImageBox'
          ? 'image'
          : w.type === 'Button' || w.type === 'ButtonShape' && w.fill && w.fill !== '#FFFFFF' && w.text
            ? 'label'
            : w.text
              ? 'label'
              : 'box';
    const newNode = {
      id: rawId,
      name: w.name || rawId,
      type: nodeType,
      x: Math.round(w.x ?? 0),
      y: Math.round(w.y ?? 0),
      w: Math.round(w.w ?? 120),
      h: Math.round(w.h ?? 40),
      ...(w.text ? { text: w.text } : {}),
      ...(w.fontSize ? { fontSize: w.fontSize } : {}),
      ...(w.fontFamily && nodeType !== 'input' ? { fontFamily: w.fontFamily } : {}),
      ...(w.color ? { color: w.color } : {}),
      ...(w.fill ? { fill: w.fill } : {}),
      ...(w.stroke ? { stroke: w.stroke } : {}),
      ...(typeof w.radius === 'number' && w.radius > 0 ? { radius: w.radius } : {}),
    };
    commands.push({
      type: 'addNode',
      pageId: pageObj.id,
      node: newNode,
    });
    changes.push({
      kind: 'add-node',
      scopedId: `${pageObj.id}/${rawId}`,
      targetNodeId: `${pageObj.id}/${rawId}`,
      pageId: pageObj.id,
      node: newNode,
    });
  }

  const computedPreviewHash = sha256(
    canonicalJson({
      documentId: currentDoc.documentId,
      baseRevision: currentDoc.revision,
      editedRpSha256,
      commands,
      conflicts,
    })
  );

  const unresolvedConflicts = conflicts.filter(c => c.resolution === 'unresolved');
  const syncStatus = {
    state:
      unresolvedConflicts.length > 0
        ? 'diverged_conflict'
        : commands.length > 0
          ? 'native_changes_ready'
          : unsupportedNativeChanges.length > 0 ? 'native_changes_unsupported' : 'in_sync',
    baseRpSha256,
    editedRpSha256,
    baselineRevision: studioOrigin?.revision ?? null,
    currentRevision: currentDoc.revision,
    currentContentHash: currentDoc.contentHash,
    previewHash: computedPreviewHash,
  };

  if (mode === 'preview') {
    return {
      ok: true,
      mode: 'preview',
      applied: false,
      documentId: currentDoc.documentId,
      revision: currentDoc.revision,
      contentHash: currentDoc.contentHash,
      previewHash: computedPreviewHash,
      syncStatus,
      summary: {
        commandCount: commands.length,
        changeCount: changes.length,
        ignoredFlowPositionCount: ignoredFlowPositions.length,
        formulaProtectedCount: formulaProtectedNodes.length,
        unsupportedChangeCount: unsupportedNativeChanges.length,
        conflictCount: conflicts.length,
        unresolvedConflictCount: unresolvedConflicts.length,
      },
      commands,
      changes,
      ignoredFlowPositions,
      formulaProtectedNodes,
      unsupportedNativeChanges,
      conflicts,
    };
  }

  // mode === 'apply'
  if (previewHash && previewHash !== computedPreviewHash) {
    fail(
      'E_NATIVE_PREVIEW_STALE',
      'previewHash 与当前计算的原生差异不一致（画布或 .rp 已发生变化），请重新 preview 后再 apply',
      { expectedPreviewHash: previewHash, actualPreviewHash: computedPreviewHash }
    );
  }
  if (unresolvedConflicts.length > 0) {
    return {
      ok: false,
      code: 'E_NATIVE_SYNC_CONFLICT',
      message: `检测到 ${unresolvedConflicts.length} 处画布与原生并发修改冲突；请指定 prefer ('studio' | 'native') 或 resolutions 后重试`,
      mode: 'apply',
      applied: false,
      documentId: currentDoc.documentId,
      revision: currentDoc.revision,
      contentHash: currentDoc.contentHash,
      previewHash: computedPreviewHash,
      syncStatus,
      conflicts,
      unresolvedConflicts,
      commands,
      changes,
      ignoredFlowPositions,
      formulaProtectedNodes,
      unsupportedNativeChanges,
    };
  }

  if (!store) {
    fail('E_NATIVE_SYNC_STORE_REQUIRED', 'apply 模式需要提供 StudioDocumentStore');
  }

  let transactionResult = null;
  if (commands.length > 0) {
    const applySync = beforeCommit => store.applyTransaction({
      baseRevision: currentDoc.revision,
      idempotencyKey: idempotencyKey || `sync-native-${computedPreviewHash.slice(0, 16)}`,
      source: 'native-sync',
      commands,
    }, { beforeCommit });
    if (persistence && typeof persistence.commit === 'function') {
      transactionResult = persistence.commit(store, applySync, { simulateCrashStage });
    } else {
      transactionResult = applySync();
      if (transactionResult.ok && persistence) {
        if (typeof persistence.persistTransaction === 'function') {
          persistence.persistTransaction(store, store.lastHistoryRecord || store.history?.at(-1));
        } else if (typeof persistence.saveDocument === 'function') {
          persistence.saveDocument(store.doc, { reason: 'sync-native', commands });
        }
      }
    }
    if (!transactionResult.ok) {
      return {
        ok: false,
        code: transactionResult.code || 'E_NATIVE_APPLY_FAILED',
        message: transactionResult.message || '原生变更回填命令执行失败',
        mode: 'apply',
        applied: false,
        transactionResult,
        commands,
        changes,
      };
    }
  }

  let rebuiltRp = null;
  if (rebuildRp) {
    const targetRp = outRpPath
      ? (isAbsolute(outRpPath) ? outRpPath : resolve(projectDir || process.cwd(), outRpPath))
      : absRpPath;
    rebuiltRp = await exportStudioDocumentToRp(store.doc, {
      projectDir: projectDir || dirname(targetRp),
      outRpPath: targetRp,
    });
  }

  return {
    ok: true,
    mode: 'apply',
    applied: true,
    noop: commands.length === 0,
    documentId: store.doc.documentId,
    previousRevision: currentDoc.revision,
    appliedRevision: store.doc.revision,
    durableRevision: store.durableRevision,
    ...(transactionResult?.persistenceWarning ? { persistenceWarning: transactionResult.persistenceWarning } : {}),
    contentHash: store.doc.contentHash,
    previewHash: computedPreviewHash,
    syncStatus: {
      ...syncStatus,
      state: unsupportedNativeChanges.length ? 'native_changes_unsupported' : 'in_sync',
      currentRevision: store.doc.revision,
      currentContentHash: store.doc.contentHash,
    },
    summary: {
      commandCount: commands.length,
      changeCount: changes.length,
      ignoredFlowPositionCount: ignoredFlowPositions.length,
      formulaProtectedCount: formulaProtectedNodes.length,
      unsupportedChangeCount: unsupportedNativeChanges.length,
      conflictCount: conflicts.length,
      unresolvedConflictCount: 0,
    },
    commands,
    changes,
    ignoredFlowPositions,
    formulaProtectedNodes,
    unsupportedNativeChanges,
    conflicts,
    ...(rebuiltRp ? { rebuiltRp: { outRpPath: rebuiltRp.outRpPath, reportPath: rebuiltRp.reportPath } } : {}),
  };
}
