// RP 9 / RP 11 结构 lint：按目标版本检查文件里有没有「不该出现的版本专属键」。
//
// 为什么需要它：写侧的版本适配只在已知差异上分支（见 version-fields.mjs）。凡是没覆盖到的
// writer 路径，都可能把 RP 11 的键写进 RP 9 文件——而三零（unparseable/danglingRefs/problems）
// **查不出这类问题**，就像早期的 enable bool/int 反例一样。这个 lint 用实测键表做全量扫描。
//
// 判据：
//   error  —— 对象里有该类的 RP 11 专属键（两版语料都出现、键集不同，高置信）
//   warn   —— 类只在 RP 11 语料里观察到（弱信号，可能是语料覆盖不足，不据此拒绝）
//
// 用法：
//   node version-lint.mjs <file.rp>            # 按文件头版本判定目标版本
//   node version-lint.mjs <file.rp> --version 9
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecords } from './rp-records.mjs';
import { parsePayload } from './parse-payload.mjs';
import { detectFileVersion, versionLabel } from './version.mjs';
import {
  RP11_ONLY_KEYS, RP9_REQUIRED_KEYS, CLASSES_NOT_IN_RP9_CORPUS,
  RP11_ONLY_DOA_CODES, DOA_RENAMED_SAME_SLOT, DOA_BASE_MASK,
} from './version-fields.mjs';

const shortName = className => String(className || '').replace(/^Axure:/, '');
// DiagramObject:* 在实测表里按短名归档；Interaction*Action 统一带 Disabled
const rp11OnlyKeysFor = cls => {
  const direct = RP11_ONLY_KEYS[cls];
  if (direct) return direct;
  return null;
};

export function lintVersionKeys(file, { version } = {}) {
  const target = version ?? detectFileVersion(file);
  const errors = [];
  const warnings = [];
  let objects = 0;

  for (const record of readRecords(file)) {
    let graph;
    try { graph = parsePayload(record); } catch { continue; }
    for (const object of graph.objects.values()) {
      objects++;
      const cls = shortName(object.className);
      const keys = (object.body?.entries ?? []).map(([k]) => k.text);

      // 样式属性码（DOA）检查：对象「键」查不出这一层。
      // 文件里 DOA = 0xC0000000 | 基值；跨版本判定只用数值，因为名字会变
      // （0x6a 在 RP 9 叫 ANCHOR_HORIZONTAL、RP 11 叫 PIN_HORIZONTAL）。
      const props = object.body?.entries?.find(([k]) => k.text === 'PropList')?.[1];
      for (const item of props?.items ?? []) {
        const doa = (item.entries ?? []).find(([k]) => k.text === 'DOAName')?.[1]?.value;
        if (doa === undefined) continue;
        const code = doa & DOA_BASE_MASK;
        const name = RP11_ONLY_DOA_CODES['0x' + code.toString(16)];
        if (name) {
      if (target === 9) {
            errors.push({ record: record.index, class: cls, objectId: object.id, key: `DOA:0x${code.toString(16)}`,
              message: `样式属性码 0x${code.toString(16)}（${name}）是 RP 11 专属，不应出现在 RP 9 的 PropList 里` });
          }
        } else {
          const rn = DOA_RENAMED_SAME_SLOT['0x' + code.toString(16)];
          if (rn) warnings.push({ kind: 'doa-renamed-slot', record: record.index, class: cls, objectId: object.id,
            message: `样式属性码 0x${code.toString(16)} 跨版本同槽改名：RP 9「${rn.rp9}」/ RP 11「${rn.rp11}」（按数值判定，不算违规）` });
        }
      }

          // SetImageStateInfo：`static-image` 与 `image-literal` 是**互斥**的一对。
      // 依据 RP 9 writer SetImageStateInfo.rv2F (0x06008c06) 的 IL：
      //   IL284 `call get_IsStaticImage` → IL290 brtrue IL341 → 写 "static-image"
      //   IL326 br IL203 → 写 "image-literal" = get_ImageLiteral()
      // 两个同时出现即为歧义（reader 按 if/else 取值）。这是模型不变量，与版本无关。
      if (/(^|:)SetImageStateInfo$/.test(cls)) {
        const hasStatic = keys.includes('static-image');
        const hasLiteral = keys.includes('image-literal');
        if (hasStatic && hasLiteral) {
          errors.push({ record: record.index, class: cls, objectId: object.id, key: 'image-state-pair',
            message: 'static-image 与 image-literal 互斥（RP 9 writer IL 为 if/else 分支），不得同时出现' });
        }
      }

      if (target === 9) {
        const banned = rp11OnlyKeysFor(cls);
        if (banned) {
          for (const key of keys) {
            if (banned.includes(key)) {
              errors.push({ record: record.index, class: cls, objectId: object.id, key,
                message: `${cls}.${key} 是 RP 11 新增键，不应出现在 RP 9 文件里` });
            }
          }
        }
        for (const key of RP9_REQUIRED_KEYS[cls] ?? []) {
          if (!keys.includes(key)) {
            errors.push({ record: record.index, class: cls, objectId: object.id, key,
              message: `${cls}.${key} 是 RP 9 原生 writer 键（REA 确证），目标 RP 9 时缺失` });
          }
        }
        if (CLASSES_NOT_IN_RP9_CORPUS.includes(cls)) {
          warnings.push({ kind: 'not-in-rp9-corpus', record: record.index, class: cls, objectId: object.id,
            message: `${cls} 未在两版对照的 RP 9 语料中出现（弱信号，仅提示）` });
        }
      }
    }
  }
  return { version: target, label: versionLabel(target), objects,
    errors, warnings: [...new Map(warnings.map(w => [w.kind + '|' + w.class, w])).values()] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) { console.error('用法: node version-lint.mjs <file.rp> [--version 9|11]'); process.exit(2); }
  const vAt = argv.indexOf('--version');
  const result = lintVersionKeys(readFileSync(file), vAt >= 0 ? { version: Number(argv[vAt + 1]) } : {});
  console.log(`${file}  目标版本 ${result.label}  扫描 ${result.objects} 个对象`);
  if (!result.errors.length) console.log('  ✅ 无版本专属键违规');
  else for (const e of result.errors) console.log(`  ❌ record#${e.record} obj#${e.objectId}  ${e.message}`);
  for (const kind of ['not-in-rp9-corpus', 'doa-renamed-slot']) {
    const group = result.warnings.filter(w => w.kind === kind);
    if (!group.length) continue;
    console.log(kind === 'not-in-rp9-corpus'
      ? `  ⚠️  ${group.length} 类只在 RP 11 语料中出现（弱信号，不据此拒绝）：`
      : `  ℹ️  ${group.length} 处样式属性码跨版本同槽改名（按数值判定，不算违规）：`);
    for (const w of group) console.log(`       ${w.class}  record#${w.record}  ${w.message}`);
  }
  process.exit(result.errors.length ? 1 : 0);
}
