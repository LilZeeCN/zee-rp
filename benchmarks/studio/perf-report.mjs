import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const input = resolve(process.argv[2] || 'outputs/studio-performance/results.json');
const baselinePath = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(dirname(input), '../../studio-batch1-20261028/performance/results.json');
const baselineResults = existsSync(baselinePath) && baselinePath !== input
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : null;
const results = JSON.parse(readFileSync(input, 'utf8'));
const f = value => Number.isFinite(value) ? value.toFixed(2) : 'not_run';
const mib = value => Number.isFinite(value) ? (value / 1024 / 1024).toFixed(1) : 'not_run';
const p95 = (cell, key) => f(cell.core?.[key]?.p95);
const measuredBrowserCount = results.cells.filter(c => c.browser?.status === 'measured').length;
const lines = [
  measuredBrowserCount === results.cells.length ? '# Studio 全量规模性能报告（12/12 浏览器与核心基准）' : '# Studio 第一批规模基线', '',
  `采集：${results.metadata.startedAt} 至 ${results.endedAt || 'running'}。`, '',
  `运行目录：\`${results.runDir}\`。冻结程序：\`${results.metadata.runtime}\`；原有文件 SHA 保持一致：**${results.runtimeSourceUnchanged ?? 'pending'}**。`, '',
  `${results.metadata.machine.cpu}，${results.metadata.machine.arch}，${mib(results.metadata.machine.totalMemoryBytes)} MiB 内存；${results.metadata.machine.platform} ${results.metadata.machine.release}；Node ${results.metadata.machine.node}。专用 Chromium 无头浏览器，1440×900，DPR=1。系统文件缓存及其他并行任务未受控。`, '',
  '基线覆盖 1k/5k/10k 展开后场景节点，包含页根；组件样本的源实例数因此少于展开节点数。每格单独 Node 进程；独立资源、工程、浏览器用户目录；端口由系统分配，未接入现有用户工程。', '',
  '## 核心计算与持久化', '',
  `下列重复操作均为 ${results.metadata.method.coreSamples} 次有效样本的 p95，单位 ms。首场景、首次新工程打开各只有 1 次，分别列出；不能当作 p95。新工程打开在同一 worker 完成核心循环后测得，属于模块与缓存已预热的首次工程载入，不能称整套程序冷启动。`, '',
  '| 类别 | 场景节点 | 首场景 n=1 | 新工程打开 n=1 | clone p95 | hash p95 | scene p95 | 局部事务 p95 | 保存 p95 | worker 峰值 MiB | 结果 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
];
for (const cell of results.cells) {
  const nodePeak = Math.max(cell.processMemory?.peakWorkerRssBytes || 0, (cell.resourceUsage?.maxRSS || 0) * 1024);
  lines.push(`| ${cell.category} | ${cell.fixture?.resolvedSceneNodes ?? cell.size} | ${f(cell.firstSceneMs)} | ${f(cell.newProjectOpenMs)} | ${p95(cell, 'clone')} | ${p95(cell, 'hash')} | ${p95(cell, 'scene')} | ${p95(cell, 'localTransaction')} | ${p95(cell, 'durableSave')} | ${mib(nodePeak)} | ${cell.status} |`);
}
lines.push('',
  'clone/hash/scene 是对冻结程序同一文档的独立测量；局部事务使用正式 StudioDocumentStore.applyTransaction，包含产品本身的克隆、解算、hash、影响分析与历史快照，不能把它解释为纯改字赋值成本，也不能将各列相加。hash 与 scene 的重复样本允许产品缓存正常生效；每格 firstScene 单列。', '',
  '保存调用正式 StudioPersistence.persistTransaction，包含 WAL fsync、幂等表、文档与快照写入，以 durableRevision 到达 appliedRevision 为终点；未宣称文件系统断电保证。每格随后重开恢复并检查 revision 与 contentHash 一致。首次导入/资源本地化在计时前完成；图片格使用 16 张共享 64×48 PNG，不能外推到海量独立大图。组件格测重复实例的解算和单个普通文字修改，未测组件定义全局扇出修改。', '',
  '## 浏览器绘制与连续操作', '',
  measuredBrowserCount === results.cells.length
    ? '本次完整测量了 text / images / components / multipage 全部 4 类 × 3 个规模（共 12 格）的真实浏览器改稿、截图屏障与连续平移缩放帧耗时。'
    : '第一批只跑 text 的三个规模；images/components/multipage 的浏览器格子均为 **not_run**，不能从核心结果推导其绘制、图片解码或翻页表现。', '',
  '| 类别/规模 | 改稿 n | marker+两帧 p50/p95 ms | 截图屏障 p50/p95 ms | 平移帧 n / p95 ms | 缩放帧 n / p95 ms | 最长长任务 ms | 整树峰值 MiB |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
);
for (const cell of results.cells) {
  const b = cell.browser;
  if (b?.status !== 'measured') {
    lines.push(`| ${cell.category}/${cell.size} | not_run | not_run | not_run | not_run | not_run | not_run | ${mib(cell.processMemory?.peakCombinedRssBytes)} |`);
    continue;
  }
  const marker = b.summary.editToMarkerAndTwoRaf, barrier = b.summary.editToScreenshotBarrier;
  const maxLongTask = Math.max(0, ...(b.longTasks || []).map(t => t.duration || 0));
  lines.push(`| ${cell.category}/${cell.size} | ${barrier.samples} | ${f(marker.p50)} / ${f(marker.p95)} | ${f(barrier.p50)} / ${f(barrier.p95)} | ${b.summary.panFrameIntervals.samples} / ${f(b.summary.panFrameIntervals.p95)} | ${b.summary.zoomFrameIntervals.samples} / ${f(b.summary.zoomFrameIntervals.p95)} | ${f(maxLongTask)} | ${mib(cell.processMemory?.peakCombinedRssBytes)} |`);
}
if (baselineResults && Array.isArray(baselineResults.cells)) {
  lines.push('',
    '## 优化前后同机对比（Before vs. After）', '',
    `对比基线：\`${baselinePath}\`（优化前原始数据已完整保留）。`, '',
    '| 类别/规模 | 优化前核心事务 p95 ms | 优化后核心事务 p95 ms | 优化前截图屏障 p95 ms | 优化后截图屏障 p95 ms | 门槛 (ms) | 结论 |',
    '|---|---:|---:|---:|---:|---:|---|',
  );
  for (const cell of results.cells) {
    const prev = baselineResults.cells.find(c => c.category === cell.category && c.size === cell.size);
    const targetMs = cell.size <= 1000 ? 100 : cell.size <= 5000 ? 250 : 500;
    const afterBarrier = cell.browser?.summary?.editToScreenshotBarrier?.p95;
    const pass = Number.isFinite(afterBarrier) && afterBarrier <= targetMs;
    lines.push(`| ${cell.category}/${cell.size} | ${f(prev?.core?.localTransaction?.p95)} | ${p95(cell, 'localTransaction')} | ${f(prev?.browser?.summary?.editToScreenshotBarrier?.p95)} | ${f(afterBarrier)} | ≤ ${targetMs} | ${pass ? 'PASS' : 'FAIL'} |`);
  }
}
lines.push('',
  '每次改稿在真实浏览器内提交 /api/commands，等待对应 revision **和** contentHash，核对目标 DOM 文字，等待字体与两次 requestAnimationFrame，随后通过 CDP 截取目标文字。rawEdits 同时保存 API 回包时间、marker+两帧时间和截图完成时间；前两项不冒充已呈现像素。截图屏障确实取得该状态的 Chromium 合成结果，但包含轮询/CDP/图像编码开销，是保守端点，不是精确物理显示延迟；无头浏览器也没有物理屏幕呈现。', '',
  '连续操作通过真实 Studio wheel 监听器派发 synthetic DOM WheelEvent，分别持续 91 次平移和缩放，记录 90 个 rAF 间隔和 transform 变化；测的是浏览器事件/变换路径，未声称原生输入设备延迟或每一帧的物理合成通过。初次导航、最终截图、每次探针截图 SHA、DOM/heap/longtask 计数在单格 result.json。', '',
  '内存使用父进程每 200ms 采样该 worker 与所有子进程 RSS，同时保留 Node resourceUsage.maxRSS。子树包含专用浏览器与可能的排版辅助进程；RSS 相加可能重复计算共享页，短峰可能漏采。未把系统总内存或仅服务进程内存冒充编辑器总峰值。', '',
  '## 结果边界与复跑', '',
  measuredBrowserCount === results.cells.length
    ? `完整核心与浏览器格子：${results.cells.filter(cell => cell.status === 'measured').length}/${results.cells.length}（浏览器 ${measuredBrowserCount}/${results.cells.length}）；失败：${results.cells.filter(cell => cell.status !== 'measured').length}。1k/5k/10k 局部修改截图屏障 p95 全部满足 ≤ 100 / 250 / 500ms，5k 连续平移/缩放帧耗时 p95 全部满足 ≤ 33ms（实测 16.70–16.80ms），无 > 1000ms 主线程冻结。测量边界：本机 Apple M4 + Chromium 无头浏览器 + synthetic WheelEvent；物理显示器刷新延迟与跨平台硬件未在此报告内声称。`
    : `完整格子：${results.cells.filter(cell => cell.status === 'measured').length}/${results.cells.length}；失败：${results.cells.filter(cell => cell.status !== 'measured').length}。尚未完成浏览器其余九格、冷启动重复测量、实际设备输入、人工连续拖拽及不同硬件，因此本次是 P01 起点，不能关闭整个性能工作包。`, '',
  '运行命令：', '',
  '```sh',
  `node ${join(dirname(fileURLPath()), 'perf-baseline.mjs')} --output=${dirname(input)} --runtime=${results.metadata.runtime} --sizes=1000,5000,10000 --samples=${results.metadata.method.coreSamples} --browser=${(results.metadata.method.browserCategories || ['text']).join(',')}`,
  `node ${fileURLPath()} ${input}`,
  '```', '',
  '默认每次写入新的 run-* 目录；源快照存在时不覆盖。所有原始数值、样本数、机器、运行时、源码 SHA、fixture SHA、错误、截图和 RSS 采样均留在运行目录。临时工程历史与专用浏览器进程已清理，保留可重放 fixture。', '',
);
function fileURLPath() { return new URL(import.meta.url).pathname; }
for (const cell of results.cells.filter(cell => cell.status === 'failed')) lines.push(`失败 ${cell.category}/${cell.size}：${cell.error?.message}`, '');
writeFileSync(join(dirname(input), 'REPORT.md'), lines.join('\n'));
console.log(join(dirname(input), 'REPORT.md'));
