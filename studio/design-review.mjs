import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './document.mjs';
import { reviewNodeSnapshots, compareReviews } from './review-comparison.mjs';
import { summarizeMetrics } from './design-metrics.mjs';
import {locateDiagnostic} from './diagnostics.mjs';

const checkList = ['主任务和主操作是否足够明确', '图像主体、图文比例和留白是否服务内容', '标题、正文、辅助信息的层级是否清楚', '空态、错误态、长文本及连续操作是否可用', '与所选参考相比，哪些决定需要改，为什么'];
export async function reviewDesign(studio, { pageId, baseRevision, reviewId = null, observations = null, compareWithReviewId = null } = {}) {
  if (baseRevision !== studio.store.appliedRevision) throw Object.assign(new Error('画布已变化，请使用当前版本重新截图评审'), { code: 'E_STALE_REVIEW' });
  const page = studio.scene.pages.find(p => p.id === pageId);
  if (!page) throw Object.assign(new Error(`页面不存在：${pageId}`), { code: 'E_PAGE_NOT_FOUND' });
  const dir = join(studio.projectDir, 'design-reviews'); mkdirSync(dir, { recursive: true });
  if (reviewId) {
    if (!/^[a-f0-9-]{36}$/.test(reviewId) || !existsSync(join(dir, `${reviewId}.json`))) throw Object.assign(new Error('评审记录不存在'), { code: 'E_REVIEW_NOT_FOUND' });
    const review = JSON.parse(readFileSync(join(dir, `${reviewId}.json`)));
    if (review.contentHash !== studio.store.doc.contentHash || review.pageId !== pageId) throw Object.assign(new Error('记录对应其他画布版本或页面，请重新截图'), { code: 'E_STALE_REVIEW' });
    const ids = new Set(page.nodes.map(n => n.id));
    if (!Array.isArray(observations) || !observations.length || observations.some(o => !o || Object.keys(o).some(key=>!['nodeIds','issue','consequence','decision','preserve'].includes(key)) || typeof o.issue !== 'string' || !o.issue.trim() || o.issue.length>4000 || ['consequence','decision','preserve'].some(key=>o[key]!==undefined&&(typeof o[key]!=='string'||o[key].length>4000)) || !Array.isArray(o.nodeIds) || o.nodeIds.some(id => !ids.has(id)))) {
      throw Object.assign(new Error('每条 observations 需要具体 issue 和有效 nodeIds（全页问题可为空数组）'), { code: 'E_REVIEW_OBSERVATIONS' });
    }
    const recorded = { ...review, status: 'agent-reviewed', observations, userAccepted: false };
    writeFileSync(join(dir, `${reviewId}.observations.json`), JSON.stringify(recorded, null, 2), { flag: 'wx' });
    return { ok: true, ...recorded, reportPath: join(dir, `${reviewId}.observations.json`), next: '按具体问题提交原子修改，再创建新版本评审；agent-reviewed 不代表用户认可。' };
  }
  let previous = null;
  if (compareWithReviewId) {
    if (!/^[a-f0-9-]{36}$/.test(compareWithReviewId) || !existsSync(join(dir, `${compareWithReviewId}.json`))) throw Object.assign(new Error('对照记录不存在'), { code: 'E_REVIEW_NOT_FOUND' });
    previous = JSON.parse(readFileSync(join(dir, `${compareWithReviewId}.json`)));
    if (previous.pageId !== pageId || previous.revision > baseRevision) throw Object.assign(new Error('对照记录必须属于同一页面，且不晚于当前版本'), { code: 'E_REVIEW_COMPARISON' });
    if (!previous.nodeSnapshots) throw Object.assign(new Error('旧记录缺少节点快照，请先记录一张新的基准画面'), { code: 'E_REVIEW_BASELINE_REQUIRED' });
    const bytes = readFileSync(join(dir, `${compareWithReviewId}.png`));
    if (sha256(bytes) !== previous.screenshot.sha256) throw Object.assign(new Error('基准图片已改变，请重新记录'), { code: 'E_REVIEW_IMAGE_CHANGED' });
    previous.imageBytes = bytes;
  }
  const id = randomUUID();
  const shot = await studio.captureScreenshot({ revision: baseRevision, pageId, outPath: join(dir, `${id}.png`), includeImage: true });
  if (shot.revision !== baseRevision) throw Object.assign(new Error('截图期间画布已变化，请重新评审'), { code: 'E_STALE_REVIEW' });
  const findings = [...(page.fontReport?.clipDiagnostics || [])].map(f => ({ severity: 'warning', ...f }));
  for (const n of page.nodes.filter(n => n.visible)) {
    if (n.type === 'image' && n.src?.startsWith('assets/') && !existsSync(join(studio.projectDir, n.src))) {
      findings.push({ code: 'E_ASSET_MISSING', severity: 'error', nodeId: n.id, message:`图片文件缺失：${n.src}`,resource:{kind:'image',path:n.src} });
    }
  }
  const usedSources = new Set(page.nodes.filter(n => n.visible && n.type === 'image').map(n => n.src));
  for (const asset of Object.values(studio.store.doc.assetsManifest || {}).filter(a => usedSources.has(a.relativePath))) {
    const r = asset.media?.recipe;
    if (r?.fadeToToken && studio.store.doc.tokens?.colors?.[r.fadeToToken] !== r.fadeColor) findings.push({ code: 'W_MEDIA_TOKEN_STALE', src: asset.relativePath, token: r.fadeToToken });
  }
  const metrics = await studio.measureDesignMetrics(pageId);
  if (metrics.baseRevision !== baseRevision) throw Object.assign(new Error('测量期间画布已变化，请重新评审'), { code: 'E_STALE_REVIEW' });
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
      detail: `文字像素无法确认：${metrics.metrics.contrast.unknownReasons?.find(r => r.id === nodeId)?.reason || '底色不可解析'}，需要进一步检查可读性`,
    });
  }

  for (const check of metrics.checks.filter(c => !c.ok)) {
    // 越界已经用 W_OUTSIDE_SCREEN / W_TEXT_OVERFLOW 逐条报过，不再重复一条聚合项。
    if (check.key === 'containment' || check.key === 'contrast') continue;
    findings.push({ code: 'W_DESIGN_METRIC', severity: ['content-presence', 'tap-target', 'empty-state-coverage'].includes(check.key) ? 'error' : 'warning', check: check.key, detail: check.detail });
  }
  for (const warning of metrics.warnings || []) {
    findings.push({ code: 'W_DESIGN_ADVISORY', severity: 'warning', check: warning.check, detail: warning.detail });
  }
  for (const v of metrics.slop) {
    findings.push({
      code: 'W_ANTI_SLOP',
      severity: 'warning',
      rule: v.rule, message: v.message, fix: v.fix, nodeIds: v.nodeIds,
    });
  }
  const { mcpImages, base64, ...screenshot } = shot;
  const review = { schemaVersion: 2, board: page.board, nodeSnapshots: reviewNodeSnapshots(page), reviewId: id, pageId, revision: baseRevision, contentHash: shot.contentHash, screenshot,
    status: 'awaiting-visual-review', userAccepted: false, findings:findings.map(finding=>({...finding,location:locateDiagnostic({doc:studio.store.doc,scene:studio.scene,pageId,nodeIds:finding.nodeIds||[finding.nodeId||finding.scopedId].filter(Boolean),field:finding.field,code:finding.code,limit:1})})), checkList,
    assessment: { blockingCount: findings.filter(f => f.severity === 'error').length, advisoryCount: findings.filter(f => f.severity !== 'error').length, note: '硬问题与风格建议分别记录；unknown 不计为通过。' },
    designMetrics: metrics,
    metricsSummary: summarizeMetrics(metrics) };
  if (studio.store.appliedRevision !== baseRevision) throw Object.assign(new Error('评审期间文档已变化，请重试'), { code: 'E_STALE_REVIEW' });
  if (previous) review.comparison = compareReviews(previous, review);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(review, null, 2), { flag: 'wx' });
  return { ok: true, ...review, reportPath: join(dir, `${id}.json`), mcpImages: previous ? [{ mimeType: 'image/png', data: previous.imageBytes.toString('base64') }, ...mcpImages] : mcpImages, next: '查看截图后用同一 reviewId/baseRevision 记录具体 observations；机器检查不会给审美评分。' };
}
