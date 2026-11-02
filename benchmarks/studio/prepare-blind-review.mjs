#!/usr/bin/env node
// Copies actual screenshots into anonymous pairs. The key stays outside the
// review directory; neither route names nor original paths reach the reviewer.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomInt, createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
if (!args.includes('--trials') || !args.includes('--out')) throw new Error('Usage: --trials /evidence/trials --out /new/anonymous-directory');
const trials = resolve(value('--trials')), out = resolve(value('--out'));
if (existsSync(out)) throw new Error('Preserve existing review; use a new directory');
mkdirSync(out, { recursive: true });
const suite = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tasks.json')));
const groups = new Map();
for (const dir of readdirSync(trials, { withFileTypes: true }).filter(e => e.isDirectory())) {
  const path = join(trials, dir.name, 'result.json'); if (!existsSync(path)) continue;
  const result = JSON.parse(readFileSync(path));
  const group = result.comparisonGroup; if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push({ result, dir: dir.name });
}
const items = [], privateKey = [];
for (const [group, runs] of groups) {
  if (runs.length !== 2) throw new Error('Each anonymous pair needs both routes: ' + group);
  const order = randomInt(2) ? runs : [...runs].reverse();
  const id = `pair-${String(items.length + 1).padStart(3, '0')}`;
  const task = suite.tasks.find(t => t.id === runs[0].result.taskId);
  const candidates = [];
  for (const [i, run] of order.entries()) {
    const label = ['A', 'B'][i], target = join(out, id, label); mkdirSync(target, { recursive: true });
    const source = join(trials, run.dir, 'screenshots');
    const files = existsSync(source) ? readdirSync(source).filter(f => f.endsWith('.png')).sort() : [];
    const images = files.map((file, j) => {
      const name = `${id}/${label}/image-${j + 1}.png`, bytes = readFileSync(join(source, file));
      cpSync(join(source, file), join(out, name));
      return { path: name, sha256: createHash('sha256').update(bytes).digest('hex'), kind: file.startsWith('state-') ? 'after-scenario' : 'final-design-page' };
    });
    candidates.push({ label, images, behaviorEvidence: Object.fromEntries(['source-structure', 'semantic', 'browser-render', 'browser-pointer'].map(layer => [layer, run.result.evidence[layer].status])) });
    privateKey.push({ pair: id, label, runId: run.result.runId, resultPath: join(trials, run.dir, 'result.json') });
  }
  items.push({ id, brief: { title: task.title, brief: task.brief, platform: task.platform, viewport: task.viewport, requiredContent: task.requiredContent, requiredStates: task.requiredStates, allowedScope: task.allowedScope }, candidates });
}
const manifest = { reviewKind: 'anonymous-independent-visual-review', rubric: '分别评估信息层级、内容可读性、构图/留白/字形、状态清晰度、视觉完成度和任务适配；0–10分并给出具体像素观察。不要将机器正确性当成审美，交互未亲自执行须保留边界；不得读取本目录之外的作者结果或私钥。', items };
writeFileSync(join(out, 'review.json'), JSON.stringify(manifest, null, 2) + '\n');
const keyPath = join(trials, `blind-review-key-${Date.now()}.json`);
writeFileSync(keyPath, JSON.stringify({ reviewDir: out, privateKey }, null, 2) + '\n');
console.log(JSON.stringify({ anonymousReview: out, pairs: items.length, privateKey: keyPath }));
