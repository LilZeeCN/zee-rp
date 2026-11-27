import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { synthesizeBlankProject } from './blank-synthesizer.mjs';
import { assertNotProtected } from './engine.mjs';
import { DEFAULT_VERSION, detectFileVersion, resolveTargetVersion, templateCandidates, versionLabel } from './version.mjs';

// 空白工程模板按目标版本解析。Axure 安装包只带教学工程，没有独立空白 .rp，
// 因此模板取自用户本机保存的空白件，不随代码分发。
//   版本 9  -> AXURE_BLANK_TEMPLATE_RP9  或 ~/Library/Application Support/zee-axure/templates/axure-rp9-blank.rp
//   版本 11 -> AXURE_BLANK_TEMPLATE_RP11 或 ~/Library/Application Support/zee-axure/templates/axure-rp11-blank.rp
// 旧变量 AXURE_BLANK_TEMPLATE 仍被接受，但会校验文件头版本是否等于目标版本，
// 避免把 RP 11 的空白 Page 导进 RP 9 工程（或反过来）。
export function readBlankTemplate(version = DEFAULT_VERSION) {
  const target = resolveTargetVersion(version);
  const candidates = templateCandidates(target);
  if (process.env.AXURE_BLANK_TEMPLATE) {
    candidates.unshift({ path: process.env.AXURE_BLANK_TEMPLATE, from: 'AXURE_BLANK_TEMPLATE' });
  }

  for (const c of candidates) {
    const path = resolve(c.path);
    assertNotProtected(path);
    const isExplicitEnv = c.from !== 'default' && c.from !== 'tmp-fallback';
    if (!existsSync(path)) {
      if (isExplicitEnv) throw new Error(`${c.from} 指定的空白模板不存在：${path}`);
      continue;
    }
    let actual, buffer;
    try {
      buffer = readFileSync(path);
      actual = detectFileVersion(buffer);
    }
    catch (e) {
      if (isExplicitEnv) throw new Error(`${c.from} 不是可识别的 Axure 容器（${path}）：${e.message}`);
      continue;
    }
    if (actual !== target) {
      const detail = `${c.from} 指向 ${versionLabel(actual)} 模板，但目标版本是 ${versionLabel(target)}：${path}`;
      if (isExplicitEnv) {
        throw new Error(`${detail}\n请改用 ${target === 9 ? 'AXURE_BLANK_TEMPLATE_RP9' : 'AXURE_BLANK_TEMPLATE_RP11'}，或清掉 AXURE_BLANK_TEMPLATE。`);
      }
      continue;
    }
    return { path, source: c.from, buffer };
  }

  return { path: null, source: 'synthesized', buffer: synthesizeBlankProject({ version: target }) };
}

// Path-based callers get a private temporary file. Authoring uses the buffer
// directly and generates fresh identities for each new project.
let scratch;
export function resolveBlankTemplate(version = DEFAULT_VERSION) {
  const blank = readBlankTemplate(version);
  if (blank.path) return blank.path;
  if (!scratch) {
    scratch = mkdtempSync(join(tmpdir(), 'zee-rp-blank-'));
    process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
  }
  const path = join(scratch, `axure-rp${detectFileVersion(blank.buffer)}-blank.rp`);
  if (!existsSync(path)) writeFileSync(path, blank.buffer, { flag: 'wx' });
  return path;
}
