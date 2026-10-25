#!/usr/bin/env node
/**
 * 渐变填充格式探针：给定一个"手工在 Axure 里画过渐变"的 .rp，
 * 打印出 RP9 实际使用的渐变填充结构（键名、类型值、停靠点编码）。
 *
 * 用法：
 *   node tools/probe-gradient-fill.mjs <file.rp> [--json]
 *
 * 背景：本仓库目前只写 solid 填充（`fill-type: "solid"` + `fill-color`）。
 * 渐变要写成原生矢量而不是位图，必须先有真值样本；没有样本就猜键名，
 * 会得到"能写进去但不生效"的假成功（`Set Size` 已经验证过这个坑）。
 *
 * 拿到样本后的落地位置：
 *   1. proto.py  make_axvg_vector_shape() 的 fill 编码处（加 gradient 分支）
 *   2. proto.py  emit 路径里 _has_optical_fx 的分支（改为优先矢量渐变，位图仅兜底）
 *   3. rp_language.py 不用改：`gradient` 已经是合法属性，只是当前走位图实现。
 */
import { readFileSync } from 'node:fs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload } from '../scripts/parse-payload.mjs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) {
  console.error('用法: node tools/probe-gradient-fill.mjs <file.rp> [--json]');
  process.exit(2);
}

const MARKERS = ['linear', 'radial', 'gradient', 'stop', 'Stop'];
const records = readRecords(readFileSync(file));
let hits = 0;
const findings = [];

for (let i = 0; i < records.length; i++) {
  const raw = records[i].payload ?? records[i];
  let text;
  try { text = Buffer.from(raw).toString('latin1'); } catch { continue; }
  const marker = MARKERS.find(m => text.includes(m));
  if (!marker) continue;
  hits++;
  let node = null;
  try { node = parsePayload(raw); } catch { /* 结构不可解析时只报命中 */ }
  findings.push({ record: i, marker, parsed: node ? summarize(node) : '(不可解析，仅命中字符串)' });
  if (findings.length >= 8) break;
}

function summarize(node, depth = 0) {
  // 只保留与填充相关的片段，避免整棵树
  const out = [];
  const walk = (o, path) => {
    if (!o || typeof o !== 'object' || depth > 64) return;
    const keys = Object.keys(o);
    if (keys.some(k => /fill|stop|gradient/i.test(k))) {
      out.push({ path, keys, sample: JSON.stringify(o).slice(0, 400) });
    }
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') walk(v, path + '/' + k);
    }
  };
  walk(node, '');
  return out.slice(0, 6);
}

if (asJson) {
  console.log(JSON.stringify({ file, hits, findings }, null, 2));
} else {
  console.log(`文件: ${file}`);
  console.log(`命中记录: ${hits}`);
  for (const f of findings) {
    console.log(`\n— record #${f.record}  marker="${f.marker}"`);
    if (Array.isArray(f.parsed)) {
      for (const s of f.parsed) console.log(`  path=${s.path}\n  keys=${s.keys.join(',')}\n  ${s.sample}`);
    } else {
      console.log('  ' + f.parsed);
    }
  }
  if (!hits) console.log('\n未发现渐变填充。请先在 Axure RP 9 里手画一个渐变矩形并另存，再用本脚本解析。');
}
process.exit(hits ? 0 : 1);
