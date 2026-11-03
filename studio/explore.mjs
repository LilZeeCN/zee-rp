/**
 * 批量探索与自动收敛（studio_explore 的引擎）
 *
 * 设计立场：
 *  - 不生成"漂亮图片"，只生成**可评估的变体**：同一份文档在不同约束下的投影。
 *  - 排序不用"审美分"，用可复现的结构判据：未达标项数 → slop 硬伤数 → 与基线的偏离度。
 *  - 每个变体都带**可直接提交的命令**，选中即落地，不需要人工翻译。
 *
 * 轴的取舍来自实测反馈：设计师要"关系型"判据，PM 要"能落地"，所以轴只动
 * 那些真正影响关系的量（密度、字阶、圆角、配色），不乱改内容。
 */

import { resolveDocumentScene } from './scene-resolver.mjs';
import { computeDesignMetrics } from './design-metrics.mjs';

const PALETTES = {
  mono: { bg: '#FFFFFF', surface: '#F7F7F8', ink: '#111113', 'ink-2': '#5A5A63', brand: '#111113', 'brand-soft': '#EFEFF2', line: '#E4E4E9' },
  warm: { bg: '#FBF7F0', surface: '#FFFFFF', ink: '#2A2118', 'ink-2': '#6B5B49', brand: '#8C4A1F', 'brand-soft': '#F2E4D6', line: '#E6D9C8' },
  cool: { bg: '#F5F8FB', surface: '#FFFFFF', ink: '#0E1726', 'ink-2': '#4C5A6B', brand: '#1D4ED8', 'brand-soft': '#E3EBFB', line: '#D8E1EC' },
  ink: { bg: '#0F1115', surface: '#171A21', ink: '#F2F4F7', 'ink-2': '#A7B0BE', brand: '#D8E1EC', 'brand-soft': '#242A34', line: '#2C333F' },
};

const AXES = {
  // 结构轴：真正会改变"谁说话"的轴，而不是调色盘。
  proportion: { even: 'even', dominant: 'dominant' },
  // 堆叠页（没有行容器）用高度重分配制造主次，而不是只调间距。
  hierarchy: { 'feature-first': 'feature-first' },
  density: { compact: 0.85, normal: 1, airy: 1.2 },
  typeScale: { tight: 0.92, normal: 1, loose: 1.12 },
  radius: { sharp: 0, soft: 10, round: 22 },
  palette: PALETTES,
};

function cloneDoc(doc) {
  return structuredClone(doc);
}

function walkNodes(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const child of node.children || []) walkNodes(child, fn);
  for (const state of node.states || []) if (state?.root) walkNodes(state.root, fn);
  if (node.template) walkNodes(node.template, fn);
}

function scalePadding(value, factor) {
  if (Array.isArray(value)) return value.map(v => (Number.isFinite(v) && v > 0 ? Math.round(v * factor) : v));
  if (Number.isFinite(value) && value > 0) return Math.round(value * factor);
  return value;
}

function applyParams(doc, params) {
  const next = cloneDoc(doc);
  if (params.palette && AXES.palette[params.palette]) {
    next.palette = { ...(next.palette || {}), ...AXES.palette[params.palette] };
    next.tokens = { ...(next.tokens || {}), colors: { ...(next.tokens?.colors || {}), ...AXES.palette[params.palette] } };
  }
  const density = AXES.density[params.density] ?? 1;
  const typeFactor = AXES.typeScale[params.typeScale] ?? 1;
  const radius = AXES.radius[params.radius];

  if (params.hierarchy === 'feature-first') {
    for (const page of next.pages || []) {
      const root = page.root;
      if (!root || !Array.isArray(root.children)) continue;
      const blocks = root.children.filter(ch => Number.isFinite(ch.h) && Number.isFinite(ch.w));
      if (blocks.length < 3) continue;
      const sorted = [...blocks].sort((a, b) => (a.y || 0) - (b.y || 0));
      const totalH = sorted.reduce((sum, ch) => sum + ch.h, 0);
      const snap4 = value => Math.max(4, Math.round(value / 4) * 4);
      const targetFirst = snap4(Math.min(totalH * 0.6, sorted[0].h * 2.4));
      const restTotal = totalH - targetFirst;
      const each = snap4(Math.max(24, restTotal / (sorted.length - 1)));
      const boardH = page.canvas?.h || page.height || null;
      sorted.forEach((ch, index) => {
        const proposed = index === 0 ? Math.max(ch.h, targetFirst) : each;
        // 不能把内容撑出画板：按剩余可用高度夹一次。
        const maxH = Number.isFinite(boardH) ? Math.max(24, Math.round((boardH - (ch.y || 0) - 16) / 4) * 4) : proposed;
        ch.h = Math.max(24, Math.min(proposed, maxH));
      });
    }
  }

  if (params.proportion) {
    for (const page of next.pages || []) {
      walkNodes(page.root, node => {
        if (node.layout !== 'row' || !Array.isArray(node.children) || node.children.length < 2) return;
        const fixed = node.children.filter(ch => Number.isFinite(ch.w));
        if (fixed.length < 2) return;
        const total = fixed.reduce((sum, ch) => sum + ch.w, 0);
        if (total <= 0) return;
        const gap = Number(node.gap) || 0;
        const available = total + gap * (fixed.length - 1) - gap * (fixed.length - 1);
        if (params.proportion === 'even') {
          const each = Math.round(available / fixed.length);
          fixed.forEach(ch => { ch.w = each; });
        } else {
          // 2:1 主次分割：第一个子项吃 2/3，其余均分 1/3
          const first = Math.round((available * 2) / 3);
          const rest = Math.round((available - first) / Math.max(1, fixed.length - 1));
          fixed.forEach((ch, index) => { ch.w = index === 0 ? first : rest; });
        }
      });
    }
  }

  for (const page of next.pages || []) {
    // 字阶轴：只放大"最大的那一级正文字号"，比值才会变。
    // （等比缩放所有正文在数学上不会改变任何字阶比，曾是一段死代码。）
    let maxBody = 0;
    if (typeFactor !== 1) {
      walkNodes(page.root, node => {
        if (Number.isFinite(node.fontSize) && node.fontSize > 0 && node.fontSize <= 20) {
          maxBody = Math.max(maxBody, node.fontSize);
        }
      });
    }
    walkNodes(page.root, node => {
      if (density !== 1) {
        if (node.padding !== undefined) node.padding = scalePadding(node.padding, density);
        if (Number.isFinite(node.gap) && node.gap > 0) node.gap = Math.round(node.gap * density);
      }
      if (maxBody && Number.isFinite(node.fontSize) && node.fontSize === maxBody) {
        node.fontSize = Math.round(maxBody * typeFactor * 10) / 10;
      }
      if (radius !== undefined && node.radius !== undefined) {
        const current = Number(node.radius) || 0;
        if (current > 0 && current < 40) node.radius = Math.max(0, Math.min(32, Math.round(current * (radius / 12))));
      }
    });
  }
  return next;
}

function scoreVariant(doc, pageId) {
  let scene;
  try {
    scene = resolveDocumentScene(doc);
  } catch (err) {
    return { ok: false, error: err.message, blocking: 99, slopErrors: 99, checks: [] };
  }
  const page = scene.pages.find(p => p.id === pageId);
  if (!page) return { ok: false, error: `页面不存在：${pageId}`, blocking: 99, slopErrors: 99, checks: [] };
  const metrics = computeDesignMetrics(page, { doc });
  const blocking = metrics.checks.filter(c => !c.ok).length;
  const slopErrors = (metrics.slop || []).filter(v => v.severity !== 'warn').length;
  const warnings = (metrics.warnings || []).length;
  return {
    ok: true,
    blocking,
    objective: objectiveOf({ blocking, slopErrors, metrics }),
    slopErrors,
    warnings,
    checks: metrics.checks.map(c => ({ key: c.key, ok: c.ok, detail: c.detail })),
    hierarchy: metrics.metrics.visualHierarchy,
    containment: metrics.metrics.containment?.total ?? 0,
    balance: metrics.metrics.compositionBalance,
    metrics,
  };
}

function diffCommands(baseDoc, variantDoc, pageId, params) {
  const commands = [];
  if (params.palette && AXES.palette[params.palette]) {
    for (const [name, value] of Object.entries(AXES.palette[params.palette])) {
      commands.push({ type: 'setToken', name, value });
    }
  }
  const baseNodes = new Map();
  const basePage = (baseDoc.pages || []).find(p => p.id === pageId);
  if (basePage) walkNodes(basePage.root, node => { if (node.id) baseNodes.set(node.id, node); });
  const variantPage = (variantDoc.pages || []).find(p => p.id === pageId);
  if (!variantPage) return commands;
  walkNodes(variantPage.root, node => {
    const before = baseNodes.get(node.id);
    if (!before) return;
    const properties = {};
    for (const key of ['padding', 'gap', 'fontSize', 'radius', 'h', 'w']) {
      if (JSON.stringify(before[key]) !== JSON.stringify(node[key]) && node[key] !== undefined) properties[key] = node[key];
    }
    if (Object.keys(properties).length) commands.push({ type: 'setProperties', nodeId: node.id, properties });
  });
  return commands;
}

export function exploreVariants(doc, { pageId, axes = {}, limit = 12, includeBaseline = true } = {}) {
  const page = (doc.pages || []).find(p => p.id === pageId) || doc.pages?.[0];
  if (!page) throw Object.assign(new Error('工程里没有可探索的页面'), { code: 'E_NO_PAGE' });
  const targetPageId = page.id;

  const hierarchies = axes.hierarchy || Object.keys(AXES.hierarchy);
  const densities = axes.density || Object.keys(AXES.density);
  const typeScales = axes.typeScale || Object.keys(AXES.typeScale);
  const radii = axes.radius || Object.keys(AXES.radius);
  const palettes = axes.palette || Object.keys(AXES.palette);

  const variants = [];
  const baseline = scoreVariant(doc, targetPageId);
  if (includeBaseline && baseline.ok) {
    variants.push({
      id: 'baseline',
      label: '当前版本（基线）',
      params: {},
      score: baseline,
      commands: [],
      delta: { blocking: 0, slopErrors: 0 },
    });
  }

  const combos = [];
  for (const hierarchy of hierarchies) {
    for (const palette of palettes) {
      for (const density of densities) {
      for (const typeScale of typeScales) {
        for (const radius of radii) {
          const params = {};
          if (hierarchy === 'feature-first') params.hierarchy = 'feature-first';
          if (palette) params.palette = palette;
          if (density !== 'normal') params.density = density;
          if (typeScale !== 'normal') params.typeScale = typeScale;
          if (radius !== 'soft') params.radius = radius;
          if (!Object.keys(params).length) continue;
          combos.push(params);
        }
        }
      }
    }
  }

  // 先给每条轴单独一个"纯净变体"（只动一维），再铺开组合。
  // 否则所有候选都同时改密度，无法判断是哪个轴把指标改坏了。
  const singleAxis = [];
  if (hierarchies.length) singleAxis.push({ hierarchy: 'feature-first' });
  const providedAxes = Object.keys(axes);
  for (const [axis, values] of Object.entries({ palette: palettes, density: densities, typeScale: typeScales, radius: radii })) {
    if (providedAxes.length && !providedAxes.includes(axis)) continue;
    for (const value of values) {
      const combo = {};
      if (axis === 'palette') {
        if (value) combo.palette = value;
      } else if (value !== ({ density: 'normal', typeScale: 'normal', radius: 'soft' })[axis]) {
        combo[axis] = value;
      }
      if (Object.keys(combo).length) singleAxis.push(combo);
    }
  }
  const picked = [...singleAxis, ...pickSpread(combos, Math.max(0, limit - singleAxis.length))];
  const seenCommands = new Set();
  let index = 0;
  for (const params of picked) {
    const variantDoc = applyParams(doc, params);
    const score = scoreVariant(variantDoc, targetPageId);
    if (!score.ok) continue;
    const commands = diffCommands(doc, variantDoc, targetPageId, params);
    if (!commands.length) continue; // 参数对这页无效（例如没有 padding），不该占一个名额
    // 不同参数可能落到完全相同的命令集（例如这页没有圆角，radius 轴空转）。
    // 这种"看起来 8 个、其实 4 个"的候选池要如实去重。
    const signature = JSON.stringify(commands);
    if (seenCommands.has(signature)) continue;
    seenCommands.add(signature);
    variants.push({
      id: `v${++index}`,
      label: labelFromChanges(params, commands),
      params,
      score,
      commands,
      delta: {
        blocking: score.blocking - baseline.blocking,
        slopErrors: score.slopErrors - baseline.slopErrors,
        warnings: score.warnings - baseline.warnings,
      },
    });
  }

  const ranked = variants
    .map(v => ({
      ...v,
      rankKey: [
        v.score.blocking,
        // 硬伤（反 slop error 级）先于连续目标：不能为了"更接近达标"
        // 而把一个带硬伤的方案排在干净方案前面。
        v.score.slopErrors,
        -v.score.objective,
        distanceToPass(v.score),
        v.commands.length,
      ],
    }))
    .sort((a, b) => {
      for (let i = 0; i < a.rankKey.length; i++) {
        if (a.rankKey[i] !== b.rankKey[i]) return a.rankKey[i] - b.rankKey[i];
      }
      return a.id.localeCompare(b.id);
    })
    .map(({ rankKey, ...rest }) => ({ ...rest, objective: rest.score.objective }));

  const baselineObjective = baseline.ok ? baseline.objective : 0;
  const baseGrid = baseline.ok ? (baseline.metrics.metrics.gridAlignment?.ratio ?? 0) : 0;
  const baseDominance = baseline.ok ? (baseline.metrics.metrics.visualHierarchy?.dominanceRatio ?? 0) : 0;
  const kept = [];
  const discarded = [];
  const fallback = [];
  for (const variant of ranked) {
    // 只有"硬指标明显退化"才淘汰；配色/密度这类等价方案不该因为目标值差 0.003 就被丢掉。
    const grid = variant.score.metrics.metrics.gridAlignment?.ratio ?? 0;
    const dominance = variant.score.metrics.metrics.visualHierarchy?.dominanceRatio ?? 0;
    const containment = variant.score.containment || 0;
    const reasons = [];
    if (containment > (baseline.containment || 0)) reasons.push(`越界元素 ${containment} 个（基线 ${baseline.containment || 0}）`);
    if (variant.score.slopErrors > baseline.slopErrors) reasons.push('反 slop 硬伤增加');
    if (grid < baseGrid - 0.05) reasons.push(`栅格率 ${Math.round(grid * 100)}% < 基线 ${Math.round(baseGrid * 100)}%`);
    if (baseDominance > 0 && dominance < baseDominance - 0.25) reasons.push(`主次比 ${dominance}× < 基线 ${baseDominance}×`);
    const worse = reasons.length > 0;
    if (worse) {
      discarded.push({ id: variant.id, label: variant.label, params: variant.params, objective: variant.score.objective, reason: reasons.join('；') });
      if (fallback.length < 2) fallback.push({ ...variant, worseThanBaseline: true });
    } else {
      kept.push(variant);
    }
  }
  // 全部更差时也保留最好的两个并明确标注"比基线差"，而不是给一个空列表。
  const visible = kept.length ? kept : [...(ranked[0]?.id === 'baseline' ? [ranked[0]] : []), ...fallback];
  let best = visible.find(v => !v.worseThanBaseline) || visible[0] || ranked[0];
  // 基线已通过且没有任何候选带来实质提升时，不要为了"有输出"而推荐改动。
  if (baseline.ok && baseline.blocking === 0 && best.id !== 'baseline') {
    const gain = (best.score.objective ?? 0) - baselineObjective;
    if (gain < 0.02) best = { id: 'baseline', label: '当前版本（基线）', params: {}, score: baseline, commands: [], delta: {} };
  }
  return {
    ok: true,
    pageId: targetPageId,
    baseline: includeBaseline ? baseline : null,
    variants: visible,
    discarded,
    baselineObjective,
    best: best ? { id: best.id, label: best.label, params: best.params, commands: best.commands, score: summarize(best.score) } : null,
    advice: buildAdvice(best, baseline, ranked, limit),
    rule: '排序依据：未达标项数 → 反 slop 硬伤数 → 连续目标(越大越好) → 离门槛距离 → 命令条数。没有审美总分。',
  };
}


const PARAM_FIXABLE = new Set(['grid-alignment', 'type-scale', 'whitespace']);
const STRUCTURAL = new Set(['anti-slop', 'visual-hierarchy', 'hue-discipline']);
const CHECK_LABELS = {
  'type-scale': '字号阶梯',
  'grid-alignment': '间距栅格',
  'whitespace': '留白节奏',
  'hue-discipline': '配色数量',
  'anti-slop': 'AI 味样式',
  'visual-hierarchy': '主次关系',
  'content-presence': '页面内容',
};
const labelOf = key => CHECK_LABELS[key] || key;

function buildAdvice(best, baseline, ranked = [], requested = 0) {
  if (!best) return '没有生成可用变体：先确认页面有内容再探索。';
  if (best.id === 'baseline' && baseline.blocking === 0) {
    const tried = Math.max(0, ranked.length - 1);
    return `当前版本已通过全部结构性判据；${tried} 个参数级变体没有一个是更优的（同分或更差）。`
      + '要再往上走，需要改结构：主图占比、栏宽比、图文换位——这些不在参数轴里。';
  }
  const failing = best.score.checks.filter(c => !c.ok).map(c => c.key);
  // 只有"确实有变体把这项修好了"才算参数可修，否则就是在骗人。
  const improved = new Set();
  for (const variant of ranked) {
    for (const c of variant.score.checks) if (c.ok) improved.add(c.key);
  }
  const structural = failing.filter(k => STRUCTURAL.has(k) || !improved.has(k));
  const param = failing.filter(k => PARAM_FIXABLE.has(k) && improved.has(k));
  if (!failing.length) {
    return `「${best.label}」已通过全部结构性判据，可直接提交（${best.commands.length} 条命令）。`;
  }
  const parts = [];
  if (best.id !== 'baseline' && best.score.blocking < baseline.blocking) {
    parts.push(`「${best.label}」把未达标项从 ${baseline.blocking} 降到 ${best.score.blocking}`);
  } else {
    parts.push(`参数级调整无法再减少未达标项（基线 ${baseline.blocking}，最优 ${best.score.blocking}）`);
  }
  if (!ranked.length) {
    return '没有生成任何变体：页面缺少可变换的结构（没有并排定宽子项，也没有可调间距）。';
  }
  if (param.length) parts.push(`还能靠参数调的：${param.map(labelOf).join('、')}`);
  if (structural.length) parts.push(`必须改版式或补素材的：${structural.map(labelOf).join('、')}`);
  return parts.join('；') + '。';
}


function pickSpread(combos, limit) {
  const seen = new Map();
  const remaining = [...combos];
  const picked = [];
  const scoreOf = combo => Object.entries(combo)
    .reduce((sum, [axis, value]) => sum + 1 / (1 + (seen.get(`${axis}:${value}`) || 0)), 0);
  while (picked.length < limit && remaining.length) {
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const value = scoreOf(remaining[i]);
      if (value > bestScore) { bestScore = value; bestIdx = i; }
    }
    const [combo] = remaining.splice(bestIdx, 1);
    picked.push(combo);
    for (const [axis, value] of Object.entries(combo)) {
      seen.set(`${axis}:${value}`, (seen.get(`${axis}:${value}`) || 0) + 1);
    }
  }
  return picked;
}

const AXIS_WORDS = {
  hierarchy: { 'feature-first': '主块前置' },
  palette: { mono: '配色 单色', warm: '配色 暖', cool: '配色 冷', ink: '配色 暗' },
  density: { compact: '紧凑', airy: '疏朗' },
  typeScale: { tight: '正文字阶收', loose: '正文字阶放' },
  radius: { sharp: '直角', round: '大圆角' },
};

function labelFromChanges(params, commands) {
  const parts = [];
  const touches = {
    palette: commands.some(c => c.type === 'setToken'),
    density: commands.some(c => c.type === 'setProperties' && (c.properties?.padding || c.properties?.gap)),
    typeScale: commands.some(c => c.type === 'setProperties' && c.properties?.fontSize),
    hierarchy: commands.some(c => c.type === 'setProperties' && c.properties?.h),
    radius: commands.some(c => c.type === 'setProperties' && c.properties?.radius),
  };
  for (const [axis, word] of Object.entries(AXIS_WORDS)) {
    if (!touches[axis]) continue;
    const value = params[axis];
    if (value && word[value]) parts.push(word[value]);
  }
  // 标签必须能区分两个变体；否则候选看起来又是"同一批"。
  return parts.length ? parts.join(' · ') : '微调';
}

function distanceToPass(score) {
  let distance = 0;
  for (const check of score.checks) {
    if (check.ok) continue;
    const text = String(check.detail || '');
    if (check.key === 'grid-alignment') {
      const match = /（(\d+)%）/.exec(text);
      if (match) distance += Math.max(0, (90 - Number(match[1])) / 90);
      else distance += 1;
    } else if (check.key === 'visual-hierarchy') {
      const match = /主次比 ([\d.]+)×/.exec(text);
      distance += match ? Math.max(0, (2.2 - Number(match[1])) / 2.2) : 1;
    } else if (check.key === 'hue-discipline') {
      const match = /主色相 (\d+) 类/.exec(text);
      distance += match ? Math.max(0, (Number(match[1]) - 4) / 4) : 0.5;
    } else {
      distance += 1;
    }
  }
  return Math.round(distance * 1000) / 1000;
}


function objectiveOf(score) {
  const metrics = score.metrics?.metrics || {};
  const grid = metrics.gridAlignment?.ratio ?? 0;
  const dominance = metrics.visualHierarchy?.dominanceRatio ?? 0;
  const dominanceScore = Math.min(1, dominance / 2.2);
  const slopScore = Math.max(0, 1 - (score.slopErrors || 0) / 3);
  const hues = metrics.palette?.distinctHues ?? 0;
  const hueScore = hues <= 4 ? 1 : Math.max(0, 1 - (hues - 4) / 4);
  const whitespace = metrics.whitespace?.whitespaceRatio ?? 0.45;
  const whitespaceScore = 1 - Math.min(1, Math.abs(whitespace - 0.45) / 0.45);
  // 越界是硬伤：一个把内容挤出画板的"主次比改善"不是改善。
  const containmentPenalty = Math.min(0.6, (score.containment || 0) * 0.12);
  const value = grid * 0.35 + dominanceScore * 0.3 + slopScore * 0.2 + hueScore * 0.1 + whitespaceScore * 0.05 - containmentPenalty;
  return Math.round(value * 1000) / 1000;
}

function summarize(score) {
  return {
    blocking: score.blocking,
    slopErrors: score.slopErrors,
    warnings: score.warnings,
    checks: score.checks,
    hierarchyRatio: score.hierarchy?.dominanceRatio ?? null,
  };
}

function describe(params) {
  const parts = [];
  if (params.palette) parts.push(`配色 ${params.palette}`);
  if (params.density) parts.push(params.density === 'compact' ? '紧凑' : '疏朗');
  if (params.typeScale) parts.push(params.typeScale === 'tight' ? '字阶收' : '字阶放');
  if (params.radius) parts.push(params.radius === 'sharp' ? '直角' : '大圆角');
  return parts.join(' · ') || '基线';
}

export { AXES, PALETTES };
