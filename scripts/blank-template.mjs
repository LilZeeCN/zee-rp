import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertNotProtected } from './engine.mjs';
import { DEFAULT_VERSION, detectFileVersion, resolveTargetVersion, templateCandidates, versionLabel } from './version.mjs';

// 空白工程模板按目标版本解析。Axure 安装包只带教学工程，没有独立空白 .rp，
// 因此模板取自用户本机保存的空白件，不随代码分发。
//   版本 9  -> AXURE_BLANK_TEMPLATE_RP9  或 ~/Library/Application Support/zee-axure/templates/axure-rp9-blank.rp
//   版本 11 -> AXURE_BLANK_TEMPLATE_RP11 或 ~/Library/Application Support/zee-axure/templates/axure-rp11-blank.rp
// 旧变量 AXURE_BLANK_TEMPLATE 仍被接受，但会校验文件头版本是否等于目标版本，
// 避免把 RP 11 的空白 Page 导进 RP 9 工程（或反过来）。
export function resolveBlankTemplate(version = DEFAULT_VERSION) {
  const target = resolveTargetVersion(version);
  const candidates = templateCandidates(target);
  if (process.env.AXURE_BLANK_TEMPLATE) {
    candidates.unshift({ path: process.env.AXURE_BLANK_TEMPLATE, from: 'AXURE_BLANK_TEMPLATE' });
  }

  const tried = [];
  let versionMismatch = null;
  for (const c of candidates) {
    const path = resolve(c.path);
    assertNotProtected(path);
    const isExplicitEnv = c.from !== 'default' && c.from !== 'tmp-fallback';
    if (!existsSync(path)) {
      if (isExplicitEnv) throw new Error(`${c.from} 指定的空白模板不存在：${path}`);
      tried.push(`${c.from}: ${path}（不存在）`);
      continue;
    }
    let actual;
    try { actual = detectFileVersion(readFileSync(path)); }
    catch (e) {
      if (isExplicitEnv) throw new Error(`${c.from} 不是可识别的 Axure 容器（${path}）：${e.message}`);
      tried.push(`${c.from}: ${path}（不是可识别的 Axure 容器：${e.message}）`);
      continue;
    }
    if (actual !== target) {
      const detail = `${c.from} 指向 ${versionLabel(actual)} 模板，但目标版本是 ${versionLabel(target)}：${path}`;
      if (isExplicitEnv) {
        throw new Error(`${detail}\n请改用 ${target === 9 ? 'AXURE_BLANK_TEMPLATE_RP9' : 'AXURE_BLANK_TEMPLATE_RP11'}，或清掉 AXURE_BLANK_TEMPLATE。`);
      }
      versionMismatch = detail;
      tried.push(`${c.from}: ${path}（版本 ${actual} ≠ 目标 ${target}）`);
      continue;
    }
    return path;
  }

  const envName = target === 9 ? 'AXURE_BLANK_TEMPLATE_RP9' : 'AXURE_BLANK_TEMPLATE_RP11';
  const lines = [
    `缺少 ${versionLabel(target)} 的空白工程模板。`,
    `请用 ${versionLabel(target)} 新建单页空白工程并另存为新文件，再设置 ${envName} 指向它。代码包不包含 Axure .rp 模板。`,
    `已尝试：\n  ${tried.join('\n  ')}`,
  ];
  if (versionMismatch) lines.push(`版本不匹配：${versionMismatch}`);
  throw new Error(lines.join('\n'));
}
