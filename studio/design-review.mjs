import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeDesignMetrics, summarizeMetrics } from './design-metrics.mjs';

const checkList = ['主任务和主操作是否足够明确', '图像主体、图文比例和留白是否服务内容', '标题、正文、辅助信息的层级是否清楚', '空态、错误态、长文本及连续操作是否可用', '与所选参考相比，哪些决定需要改，为什么'];
export async function reviewDesign(studio, { pageId, baseRevision, reviewId = null, observations = null } = {}) {
  if (baseRevision !== studio.store.appliedRevision) throw Object.assign(new Error('画布已变化，请使用当前版本重新截图评审'), { code: 'E_STALE_REVIEW' });
  const page = studio.scene.pages.find(p => p.id === pageId);
  if (!page) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
  const dir = join(studio.projectDir, 'design-reviews'); mkdirSync(dir, { recursive: true });
  if (reviewId) {
    if (!/^[a-f0-9-]{36}$/.test(reviewId) || !existsSync(join(dir, `${reviewId}.json`))) throw Object.assign(new Error('评审记录不存在'), { code: 'E_REVIEW_NOT_FOUND' });
    const review = JSON.parse(readFileSync(join(dir, `${reviewId}.json`)));
    if (review.contentHash !== studio.store.doc.contentHash || review.pageId !== pageId) throw Object.assign(new Error('记录对应其他画布版本或页面，请重新截图'), { code: 'E_STALE_REVIEW' });
    const ids = new Set(page.nodes.map(n => n.id));
    if (!Array.isArray(observations) || !observations.length || observations.some(o => typeof o.issue !== 'string' || !o.issue.trim() || !Array.isArray(o.nodeIds) || o.nodeIds.some(id => !ids.has(id)))) {
      throw Object.assign(new Error('每条 observations 需要具体 issue 和有效 nodeIds（全页问题可为空数组）'), { code: 'E_REVIEW_OBSERVATIONS' });
    }
    const recorded = { ...review, status: 'agent-reviewed', observations, userAccepted: false };
    writeFileSync(join(dir, `${reviewId}.observations.json`), JSON.stringify(recorded, null, 2), { flag: 'wx' });
    return { ok: true, ...recorded, next: '按具体问题提交原子修改，再创建新版本评审；agent-reviewed 不代表用户认可。' };
  }
  const id = randomUUID();
  const shot = await studio.captureScreenshot({ revision: baseRevision, pageId, outPath: join(dir, `${id}.png`), includeImage: true });
  if (shot.revision !== baseRevision) throw Object.assign(new Error('截图期间画布已变化，请重新评审'), { code: 'E_STALE_REVIEW' });
  const findings = [...(page.fontReport?.clipDiagnostics || [])].map(f => ({ severity: 'warning', ...f }));
  for (const n of page.nodes.filter(n => n.visible)) {
    if (n.type === 'image' && n.src?.startsWith('assets/') && !existsSync(join(studio.projectDir, n.src))) {
      findings.push({ code: 'E_ASSET_MISSING', severity: 'error', nodeId: n.id });
    }
  }
  const usedSources = new Set(page.nodes.filter(n => n.visible && n.type === 'image').map(n => n.src));
  for (const asset of Object.values(studio.store.doc.assetsManifest || {}).filter(a => usedSources.has(a.relativePath))) {
    const r = asset.media?.recipe;
    if (r?.fadeToToken && studio.store.doc.tokens?.colors?.[r.fadeToToken] !== r.fadeColor) findings.push({ code: 'W_MEDIA_TOKEN_STALE', src: asset.relativePath, token: r.fadeToToken });
  }
  const metrics = computeDesignMetrics(page, { doc: studio.store.doc });
  // 越界以度量层为唯一来源，避免两套阈值（0.5px vs 1px）打出相反结论。
  for (const item of metrics.metrics.containment?.outside || []) {
    const sides = Object.entries(item.over).filter(([, value]) => value > 0).map(([key, value]) => `${key}+${Math.round(value)}`);
    findings.push({ code: 'W_OUTSIDE_SCREEN', severity: 'error', nodeId: item.id, detail: `越出画板 ${sides.join('/')}px` });
  }
  for (const item of metrics.metrics.containment?.textOverflow || []) {
    findings.push({ code: 'W_TEXT_OVERFLOW', severity: 'error', nodeId: item.id, parentId: item.parentId });
  }
  // 对比度：红在哪一处必须点得开，不能只说"N 处"。
  for (const item of metrics.metrics?.contrast?.worst || []) {
    findings.push({
      code: 'W_CONTRAST_LOW',
      severity: 'error',
      nodeId: item.id,
      detail: `对比度 ${item.ratio}:1，低于 ${item.required}:1`,
    });
  }
  for (const nodeId of metrics.metrics?.contrast?.unknownNodes || []) {
    findings.push({
      code: 'W_CONTRAST_UNKNOWN',
      severity: 'error',
      nodeId,
      detail: '文字压在图片/渐变上，底色不可计算——请确认可读性或加遮罩',
    });
  }

  for (const check of metrics.checks.filter(c => !c.ok)) {
    // 越界已经用 W_OUTSIDE_SCREEN / W_TEXT_OVERFLOW 逐条报过，不再重复一条聚合项。
    if (check.key === 'containment' || check.key === 'contrast') continue;
    findings.push({ code: 'W_DESIGN_METRIC', severity: 'error', check: check.key, detail: check.detail });
  }
  for (const warning of metrics.warnings || []) {
    findings.push({ code: 'W_DESIGN_ADVISORY', severity: 'warning', check: warning.check, detail: warning.detail });
  }
  for (const v of metrics.slop) {
    findings.push({
      code: 'W_ANTI_SLOP',
      severity: v.severity === 'warn' ? 'warning' : 'error',
      rule: v.rule, message: v.message, fix: v.fix, nodeIds: v.nodeIds,
    });
  }
  const { mcpImages, base64, ...screenshot } = shot;
  const review = { reviewId: id, pageId, revision: baseRevision, contentHash: shot.contentHash, screenshot,
    status: 'awaiting-visual-review', userAccepted: false, findings, checkList,
    designMetrics: metrics,
    metricsSummary: summarizeMetrics(metrics) };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(review, null, 2), { flag: 'wx' });
  return { ok: true, ...review, mcpImages, next: '查看截图后用同一 reviewId/baseRevision 记录具体 observations；机器检查不会给审美评分。' };
}
