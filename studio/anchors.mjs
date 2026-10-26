/**
 * 锚点驱动参考：把项目里"已认可的页面"提炼成可复用的排版配方。
 *
 * 为什么不用互联网美图：通用审美打不过 Figma 的语料；本项目历史页面的
 * 栅格、字阶、留白、层次才是"这个产品该长什么样"的真实依据。
 *
 * 配方只记可复现的量，不记"风格形容词"。
 */

import { computeDesignMetrics } from './design-metrics.mjs';
import { resolveDocumentScene } from './scene-resolver.mjs';

const ANCHOR_FILE = 'design-anchors.json';

function recipeFromScene(page) {
  const nodes = (page.nodes || []).filter(n => n.visible !== false);
  const board = page.board || {};
  const pageArea = (board.screenW || 0) * (board.screenH || 0);
  const media = nodes.filter(n => n.src && Number.isFinite(n.w) && Number.isFinite(n.h));
  const mediaArea = media.reduce((sum, n) => sum + n.w * n.h, 0);
  const blocks = nodes.filter(n => n.parentId === (nodes.find(x => !x.parentId)?.id) && Number.isFinite(n.w));
  const widths = [...new Set(blocks.map(n => Math.round(n.w)))].sort((a, b) => b - a).slice(0, 5);
  const leftEdges = [...new Set(blocks.map(n => Math.round(n.x)))].sort((a, b) => a - b).slice(0, 6);
  const gaps = [...new Set(nodes.map(n => n.gap).filter(v => Number.isFinite(v) && v > 0))].sort((a, b) => a - b).slice(0, 8);
  return {
    imageShare: pageArea ? Math.round((mediaArea / pageArea) * 1000) / 1000 : null,
    columnWidths: widths,
    leftEdges,
    spacingRhythm: gaps,
    blockCount: blocks.length,
  };
}

function recipeFromMetrics(metrics) {
  const scale = metrics.metrics.typeScale || {};
  return {
    typeScale: {
      sizes: scale.sizes || [],
      bodyLevels: scale.levels ?? (scale.bodySizes || []).length,
      bodyRatios: scale.bodyRatios || [],
      displaySizes: scale.displaySizes || [],
    },
    grid: {
      grid: metrics.metrics.gridAlignment?.grid ?? 4,
      ratio: metrics.metrics.gridAlignment?.ratio ?? null,
    },
    whitespace: metrics.metrics.whitespace?.whitespaceRatio ?? null,
    palette: {
      distinctHues: metrics.metrics.palette?.distinctHues ?? null,
      hueBuckets: (metrics.metrics.palette?.hueBuckets || []).slice(0, 4).map(b => b.hue),
    },
    hierarchy: {
      dominanceRatio: metrics.metrics.visualHierarchy?.dominanceRatio ?? null,
      flat: metrics.metrics.visualHierarchy?.flat ?? null,
      topThree: (metrics.metrics.visualHierarchy?.topThree || []).map(t => ({ id: t.id, mass: t.mass })),
    },
    composition: {
      sharesByThird: metrics.metrics.compositionBalance?.sharesByThird || null,
      deadRight: metrics.metrics.compositionBalance?.deadRight ?? null,
    },
    l1Verdict: metrics.l1?.verdict || null,
    antiSlopRules: (metrics.slop || []).map(v => v.rule),
  };
}

export function extractAnchors(doc, { pages = null, includeBelowBar = false } = {}) {
  const scene = resolveDocumentScene(doc);
  let targets = pages ? scene.pages.filter(p => pages.includes(p.id)) : scene.pages;
  const skipped = [];
  const missing = pages ? pages.filter(id => !scene.pages.some(p => p.id === id)) : [];
  if (missing.length) throw Object.assign(new Error(`页面不存在：${missing.join(', ')}`), { code: 'E_PAGE_NOT_FOUND' });
  if (!includeBelowBar) {
    // 把"度量自己判不合格的页面"立成锚点，会让两个工具自相矛盾。
    const passing = [];
    for (const page of targets) {
      const m = computeDesignMetrics(page, { doc });
      if (m.l1?.verdict === 'meets-l1-bar') passing.push(page);
      else skipped.push({ pageId: page.id, reason: m.l1?.verdict || 'unknown' });
    }
    targets = passing;
  }
  const anchors = [];
  for (const page of targets) {
    const metrics = computeDesignMetrics(page, { doc });
    anchors.push({
      pageId: page.id,
      pageName: page.name,
      domain: page.domain || doc.domain || 'mobile',
      recipe: { ...recipeFromMetrics(metrics), structure: recipeFromScene(page) },
      extractedAt: new Date().toISOString(),
    });
  }
  return { schemaVersion: 1, documentId: doc.documentId || null, anchors, skipped };
}

function mean(values) {
  const nums = values.filter(v => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function summarizeAnchors(anchorSet) {
  const list = anchorSet.anchors || [];
  if (!list.length) return null;
  return {
    pageCount: list.length,
    pages: list.map(a => a.pageId),
    typeScale: {
      bodyLevels: mean(list.map(a => a.recipe.typeScale.bodyLevels)),
      typicalSizes: [...new Set(list.flatMap(a => a.recipe.typeScale.sizes))].sort((a, b) => b - a).slice(0, 8),
    },
    grid: { grid: 4, ratioMean: mean(list.map(a => a.recipe.grid.ratio)) },
    whitespaceMean: mean(list.map(a => a.recipe.whitespace)),
    distinctHuesMean: mean(list.map(a => a.recipe.palette.distinctHues)),
    dominanceRatioMean: mean(list.map(a => a.recipe.hierarchy.dominanceRatio)),
  };
}

export function compareToAnchors(doc, pageId, anchorSet) {
  const scene = resolveDocumentScene(doc);
  const page = scene.pages.find(p => p.id === pageId);
  if (!page) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
  const metrics = computeDesignMetrics(page, { doc });
  const current = recipeFromMetrics(metrics);
  const allAnchors = (anchorSet.anchors || []).filter(a => a.pageId !== pageId);
  // 参照系卫生：不可评估页（空页）与低于达标线的页不能参与求均值，
  // 否则会给出"留白加到 86%""字阶合并到 0.5 级"这种物理上不存在的建议。
  const anchors = allAnchors.filter(a => a.l1Verdict === 'meets-l1-bar' || a.approvedBy === 'human');
  const droppedAnchors = allAnchors.filter(a => !anchors.includes(a))
    .map(a => ({ pageId: a.pageId, reason: a.l1Verdict || 'unknown' }));
  const pool = anchors.length ? anchors : (anchorSet.anchors || []);
  if (!pool.length) {
    return {
      ok: true, pageId, current, anchors: 0, deviations: [],
      droppedAnchors,
      note: droppedAnchors.length
        ? `锚点里没有可用参照（${droppedAnchors.map(d => `${d.pageId}:${d.reason}`).join('，')}）；先用 approve 人工认可一页，或修好后再 extract。`
        : '还没有锚点：先对已认可的页面执行 extract。',
    };
  }
  const ref = (pick) => mean(pool.map(a => pick(a.recipe)));
  const deviations = [];
  const push = (key, currentValue, anchorValue, unit = '', betterWhen = 'closer') => {
    if (!Number.isFinite(currentValue) || !Number.isFinite(anchorValue)) return;
    // 内部存的是比例（0–1），对外报百分比时必须换算，否则会出现"留白 0.647%"这种误导。
    const scaleFactor = unit === '%' ? 100 : 1;
    const current = Math.round(currentValue * scaleFactor * 10) / 10;
    const anchor = Math.round(anchorValue * scaleFactor * 10) / 10;
    const delta = Math.round((current - anchor) * 10) / 10;
    deviations.push({
      key,
      current,
      anchor,
      delta,
      unit,
      betterWhen,
      meaningful: Math.abs(delta) > (unit === '%' ? 8 : 0.25),
    });
  };

  push('字阶层级数', current.typeScale.bodyLevels, ref(r => r.typeScale.bodyLevels), '级');
  push('最小字阶比', current.typeScale.bodyRatios.length ? Math.min(...current.typeScale.bodyRatios) : NaN,
    mean(pool.flatMap(a => a.recipe.typeScale.bodyRatios.length ? [Math.min(...a.recipe.typeScale.bodyRatios)] : [])), '');
  push('栅格对齐率', current.grid.ratio, ref(r => r.grid.ratio), '%');
  push('留白占比', current.whitespace, ref(r => r.whitespace), '%');
  push('主色相数', current.palette.distinctHues, ref(r => r.palette.distinctHues), '类');
  push('主次比', current.hierarchy.dominanceRatio, ref(r => r.hierarchy.dominanceRatio), '×', 'higher');

  const meaningful = deviations.filter(d => d.meaningful);
  const suggestions = buildSuggestions(current, metrics, meaningful, anchorSet);
  return {
    ok: true,
    pageId,
    anchors: pool.length,
    droppedAnchors,
    anchorPages: pool.map(a => a.pageId),
    current,
    deviations,
    meaningful,
    suggestions,
    note: (droppedAnchors.length ? `参照系已剔除 ${droppedAnchors.length} 个不合格页（${droppedAnchors.map(d => d.pageId).join('、')}）。` : '') + (meaningful.length
      ? `与项目锚点偏离明显的项：${meaningful.map(d => `${d.key} ${d.current}${d.unit} vs ${d.anchor}${d.unit}`).join('；')}`
      : '与项目锚点的偏离都在容差内。'),
  };
}

export function mergeAnchorSets(existing, incoming, { mode = 'append' } = {}) {
  const base = mode === 'replace' ? [] : [...(existing?.anchors || [])];
  const byPage = new Map(base.map(anchor => [anchor.pageId, anchor]));
  for (const anchor of incoming.anchors || []) {
    byPage.set(anchor.pageId, anchor);
  }
  return {
    schemaVersion: 1,
    documentId: incoming.documentId || existing?.documentId || null,
    anchors: [...byPage.values()],
    skipped: incoming.skipped || [],
  };
}


function topBlockIds(recipe, count = 3) {
  return (recipe.hierarchy?.topThree || []).slice(0, count).map(t => t.id);
}

function buildSuggestions(current, metrics, meaningful, anchorSet) {
  const out = [];
  for (const deviation of meaningful) {
    if (deviation.key === '留白占比') {
      const more = deviation.delta > 0;
      out.push({
        key: deviation.key,
        direction: more ? '减少留白' : '增加留白',
        action: more
          ? `留白比锚点多 ${Math.abs(deviation.delta)} 个百分点：把主内容列加宽或把主图放大占位（当前锚点均值 ${deviation.anchor}%）。`
          : `留白比锚点少 ${Math.abs(deviation.delta)} 个百分点：收窄内容列或加大段落间距（锚点均值 ${deviation.anchor}%）。`,
      });
    } else if (deviation.key === '主次比') {
      const ids = topBlockIds(current);
      out.push({
        key: deviation.key,
        direction: '强化主次',
        action: `主次比 ${deviation.current}×，锚点 ${deviation.anchor}×：把 ${ids[0] || '主块'} 放到第二名的 2.5 倍视觉重量（放大高度/换图/加深底色），其余块降级。`,
      });
    } else if (deviation.key === '栅格对齐率') {
      const offenders = (metrics.metrics.gridAlignment?.offenders || []).slice(0, 4);
      out.push({
        key: deviation.key,
        direction: '对齐栅格',
        action: offenders.length
          ? `这些值不在 4px 网格：${offenders.map(o => `${o.id}.${o.prop}=${o.value}→${o.nearest}`).join('，')}`
          : `栅格率 ${deviation.current}%（锚点 ${deviation.anchor}%）：把间距统一到 4 的倍数。`,
      });
    } else if (deviation.key === '主色相数') {
      out.push({
        key: deviation.key,
        direction: '收敛配色',
        action: `主色相 ${deviation.current} 类，锚点 ${deviation.anchor} 类：把次要色降饱和或并入主色，只保留一个强调色。`,
      });
    } else if (deviation.key === '字阶层级数') {
      out.push({
        key: deviation.key,
        direction: '整理字阶',
        action: `正文层级 ${deviation.current} 级，锚点 ${deviation.anchor} 级：合并相邻两级字号（相差 <8% 视为同一级）。`,
      });
    }
  }
  return out;
}

export { ANCHOR_FILE };
