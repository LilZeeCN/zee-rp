import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { readRp } from './rp-read.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const cell = value => (value === undefined || value === null ? '—' : typeof value === 'object'
  ? JSON.stringify(value) : String(value)).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

function writeAtomic(path, contents) {
  assertNotProtected(path);
  assertWritable(path);
  const staging = join(dirname(path), '.proof-' + randomUUID());
  try {
    writeFileSync(staging, contents, { flag: 'wx' });
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}

export function writeProofReport({ directory, rp, rpHash, source, semanticHash, verification, steps }) {
  let structure = null;
  let counts = null;
  let sha256 = null;
  if (rp) {
    assertNotProtected(rp);
    const bytes = readFileSync(rp);
    const parsed = readRp(bytes, { path: rp });
    sha256 = createHash('sha256').update(bytes).digest('hex');
    if (rpHash && rpHash !== sha256) throw Object.assign(new Error('原生文件在回放过程中发生变化。'), { code: 'E_CONCURRENT_MODIFICATION' });
    structure = { unparseable: parsed.records.unparseable, danglingRefs: parsed.counts.danglingRefs, problems: parsed.counts.problems };
    counts = parsed.counts;
  }
  const auditPath = join(directory, 'audit-report.json');
  const audit = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')) : null;
  const storyboard = verification.storyboard;
  const evidence = ['pages-sheet.png', 'states-sheet.png'].map(file => join(directory, file))
    .concat(storyboard || [], verification.screenshot || []).filter(file => existsSync(file));
  const proof = {
    version, createdAt: new Date().toISOString(), rp: rp ?? null, source: source ?? null, sha256, semanticHash: semanticHash ?? null,
    engine: verification.engine, evidence: verification.evidence, status: verification.status, structure, counts,
    priorBrowserEvidence: verification.priorBrowserEvidence ?? null,
    degradations: audit?.degradations ?? [],
    reachability: verification.reachability ?? null, diagnostics: verification.diagnostics ?? [],
    passed: verification.passed, failed: verification.failed, notRun: verification.notRun,
    steps: steps.map((step, index) => ({ ...step, ...(verification.steps[index] ?? {}) })), images: evidence,
  };
  const lines = [
    '# 原型行为证明',
    '',
    `- 交付文件 \`${cell(rp ? basename(rp) : source ? basename(source) : null)}\``,
    `- 原生文件 SHA-256 \`${cell(sha256)}\``,
    `- RP/1 语义哈希 \`${cell(semanticHash)}\``,
    `- 验证时间 ${proof.createdAt}`,
    `- 版本 ${version} · ${cell(proof.engine)} · ${cell(proof.evidence)}`,
    `- 步骤 ${proof.passed} 通过 / ${proof.failed} 失败 / ${proof.notRun} 未执行`,
    ...(proof.priorBrowserEvidence ? [
      `- 复用已验证的浏览器行为。前次原生 SHA-256 \`${cell(proof.priorBrowserEvidence.rpSha256)}\` · ${cell(proof.priorBrowserEvidence.verifiedAt)}`,
    ] : []),
    '',
    '## 文件结构与样式',
    '',
    `- 结构检查 ${cell(structure)}`,
    `- 页面 ${cell(counts?.pages)} · 元件 ${cell(counts?.widgets)} · 交互 ${cell(counts?.interactions)}`,
    '',
  ];
  if (proof.degradations.length) {
    lines.push('| 元件 | 属性 | 交付行为 | 说明 |', '|---|---|---|---|');
    for (const d of proof.degradations) lines.push(`| ${cell(d.nodeId)} | ${cell(d.property)} | ${cell(d.mode)} | ${cell(d.detail)} |`);
    lines.push('');
  }
  const reach = proof.reachability;
  lines.push('## 页面可达性', '', `- 首屏 ${cell(reach?.entryPage)}`,
    `- 真实交互到达 ${cell(reach?.reachedByInteraction)}`, `- 测试器直接到达 ${cell(reach?.reachedOnlyByBypass)}`,
    `- 未覆盖 ${cell(reach?.unvisitedPages)}`, '',
    '## 行为回放', '', '| 步 | 动作 | 目标 | 期望 | 观察 | 耗时（ms） | 结果 |', '|---:|---|---|---|---|---:|---|');
  for (const step of proof.steps) {
    const actual = step.failures?.length ? step.failures : step.visual ?? step.observedWidget ?? step.variableChanges;
    lines.push(`| ${step.index + 1} | ${cell(step.action)} | ${cell(step.target ?? step.page)} | ${cell(step.expect)} | ${cell(actual)} | ${cell(step.elapsedMs)} | ${cell(step.status)} |`);
  }
  if (evidence.length) {
    lines.push('', '## 视觉证据', '');
    for (const file of evidence) lines.push(`![${basename(file)}](${encodeURI(relative(directory, file))})`, '');
  }

  mkdirSync(directory, { recursive: true });
  const proofReport = join(directory, 'PROOF.md');
  writeAtomic(join(directory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  writeAtomic(proofReport, lines.join('\n') + '\n');
  return proofReport;
}
