#!/usr/bin/env node
// zee-axure 截图临摹工具链统一 Node 入口 v3.2：
//
// 【最快一键路径 (耗时 < 1s)】
//   node scripts/trace.mjs draft <image.png> -o <out-dir> [--scale 1.0|2.0] [--axvg <out.axvg.json>] [--replace "旧文本=新文本"]
//
// 【Spec.json 核心结构速查 (无需写探针猜字段)】
//   - 元件数组路径 : spec.frames[0].children
//   - 文本内容字段 : child.content  (注意：是 content 而不是 text！)
//   - 矩形/圆点字段: { kind: "rect"|"circle", name, x, y, w, h, fill: "#RRGGBB", corners?: number, border?: { color, thickness } }
//   - 细线字段     : { kind: "hline", name, x, y, w, thickness, color }
//   - 批量改字命令 : node scripts/trace.mjs patch <spec.json> --replace "冈二=周二" --replace "蒜姜=蒜薹"
//
// 【重要避坑：.axvg.json 与 .rp 的区别】
//   - `trace.mjs build` / `axvg.mjs build` 产出的是 Axure 剪贴板 JSON 包 (`.axvg.json`，首字节 `7b 22`)，
//     不是二进制 `.rp` 容器文件（首字节 `ac ef`）。
//   - 切勿把 `-o xxx.rp` 传给 `axvg.mjs build`！若传给 `trace.mjs build -o xxx.rp`，本脚本会自动将剪贴板包重定向到
//     `xxx.axvg.json`，防止覆盖损坏二进制 `.rp` 文件。
//
// 子命令列表：
//   node scripts/trace.mjs draft <image.png> -o <out-dir> [--scale 2.0] [--spec <out.spec.json>] [--axvg <out.axvg.json>] [--replace "旧=新"] [--preview <axure-preview.png>]
//   node scripts/trace.mjs patch <spec.json> [-o <out.spec.json>] --replace "旧文本=新文本" [--replace "旧2=新2"]
//   node scripts/trace.mjs build <spec.json> -o <out.axvg.json> [--replace "旧=新"] [--source <image.png>] [--verify-dir <out-dir>] [--scale 2.0] [--safe-lines] [--preview <axure-preview.png>]
//   node scripts/trace.mjs scan <image.png> -o <out-dir> [--scale 2.0] [--sheet]
//   node scripts/trace.mjs crop <spec.json> --source <image.png> [-o <out.spec.json>] [--scale 2.0]
//   node scripts/trace.mjs normalize-lines <spec.json> [-o <out.spec.json>]
//   node scripts/trace.mjs verify <spec.json> --source <image.png> -o <out-dir> [--scale 2.0] [--preview <axure-preview.png>]
//   node scripts/trace.mjs selftest
//
// 安全语义复用 engine.mjs：任何输入/输出命中受保护成品即拒绝；输出路径遵循 AXURE_WRITE_ROOT 白名单。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNotProtected, assertWritable } from './engine.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const TRACE_PY = join(SCRIPTS_DIR, 'trace.py');
const AXVG_MJS = join(SCRIPTS_DIR, 'axvg.mjs');

function runPy(args) {
  for (const a of args) assertNotProtected(a);
  const res = spawnSync('python3', [TRACE_PY, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error((res.stderr?.toString() || res.stdout?.toString() || `trace.py exited ${res.status}`).trim());
  }
  return res.stdout.toString().trim();
}

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && typeof args[idx + 1] === 'string' ? args[idx + 1] : null;
}

function getAllFlags(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && typeof args[i + 1] === 'string') {
      out.push(args[i + 1]);
      i++;
    }
  }
  return out;
}

function sanitizeAxvgOutputPath(rawPath) {
  if (!rawPath) return { axvgPath: null, redirectedFromRp: null };
  if (/\.rp$/i.test(rawPath)) {
    const redirected = rawPath.replace(/\.rp$/i, '.axvg.json');
    // 若磁盘上存在之前误写入 JSON (magic 7b 22) 的伪 .rp 文件，自动清理以免阻塞后续命令
    if (existsSync(rawPath)) {
      try {
        const head = readFileSync(rawPath).subarray(0, 2);
        if (head.length === 2 && head[0] === 0x7b && head[1] === 0x22) {
          unlinkSync(rawPath);
        }
      } catch {}
    }
    return { axvgPath: redirected, redirectedFromRp: resolve(rawPath) };
  }
  return { axvgPath: rawPath, redirectedFromRp: null };
}

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  for (const a of argv) assertNotProtected(a);

  const sub = argv[0];
  try {
    if (sub === 'selftest') {
      const out = runPy(['selftest']);
      console.log(out);
    } else if (sub === 'scan') {
      const outDir = getFlag(argv, '-o') || getFlag(argv, '--out-dir');
      if (outDir) assertWritable(outDir);
      console.log(runPy(argv));
    } else if (sub === 'patch') {
      const specPath = argv[1];
      const outSpec = getFlag(argv, '-o') || getFlag(argv, '--output') || specPath;
      if (outSpec) assertWritable(outSpec);
      console.log(runPy(argv));
    } else if (sub === 'draft') {
      const outDir = getFlag(argv, '-o') || getFlag(argv, '--out-dir');
      const specOut = getFlag(argv, '--spec');
      const rawAxvgOut = getFlag(argv, '--axvg');
      const { axvgPath: axvgOut, redirectedFromRp } = sanitizeAxvgOutputPath(rawAxvgOut);
      if (outDir) assertWritable(outDir);
      if (specOut) assertWritable(specOut);
      if (axvgOut) assertWritable(axvgOut);
      const pyArgs = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--axvg') {
          i++;
          continue;
        }
        pyArgs.push(argv[i]);
      }
      const draftRes = JSON.parse(runPy(pyArgs));
      if (axvgOut && draftRes.draft_spec_path) {
        if (existsSync(axvgOut) && (axvgOut.endsWith('.axvg.json') || axvgOut.endsWith('.json'))) {
          unlinkSync(axvgOut);
        }
        const buildRes = spawnSync(process.execPath, [AXVG_MJS, 'build', draftRes.draft_spec_path, '-o', axvgOut], {
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
        });
        if (buildRes.status !== 0) {
          throw new Error((buildRes.stderr?.toString() || `axvg build exited ${buildRes.status}`).trim());
        }
        draftRes.axvg_out = resolve(axvgOut);
        draftRes.axvg_stdout = buildRes.stdout.toString().trim();
        if (redirectedFromRp) {
          draftRes.rp_redirect_notice = `注意：--axvg 产出的是 Axure 剪贴板 JSON 包而非二进制 .rp 容器，已自动保存至 ${resolve(axvgOut)}（避免写入 ${redirectedFromRp} 导致 magic 7b 22 != ac ef 报错）。`;
        }
      }
      console.log(JSON.stringify(draftRes, null, 2));
    } else if (sub === 'crop') {
      const outSpec = getFlag(argv, '-o') || getFlag(argv, '--output') || argv[1];
      if (outSpec) assertWritable(outSpec);
      console.log(runPy(argv));
    } else if (sub === 'normalize-lines') {
      const outSpec = getFlag(argv, '-o') || getFlag(argv, '--output') || argv[1];
      if (outSpec) assertWritable(outSpec);
      console.log(runPy(argv));
    } else if (sub === 'verify') {
      const outDir = getFlag(argv, '-o') || getFlag(argv, '--out-dir');
      if (outDir) assertWritable(outDir);
      console.log(runPy(argv));
    } else if (sub === 'build') {
      const specPath = argv[1];
      if (!specPath) {
        throw new Error('用法: node scripts/trace.mjs build <spec.json> -o <out.axvg.json> [--replace "旧=新"] [--source <image.png>] [--verify-dir <dir>] [--scale 2.0] [--safe-lines] [--preview <axure-preview.png>]');
      }
      const rawOut = getFlag(argv, '-o') || specPath.replace(/\.spec\.json$/, '') + '.axvg.json';
      const { axvgPath: outAxvg, redirectedFromRp } = sanitizeAxvgOutputPath(rawOut);
      const sourceImg = getFlag(argv, '--source');
      const verifyDir = getFlag(argv, '--verify-dir');
      const previewImg = getFlag(argv, '--preview');
      const scale = getFlag(argv, '--scale') || '2.0';
      const safeLines = argv.includes('--safe-lines');
      const replacements = getAllFlags(argv, '--replace');
      assertWritable(outAxvg);

      let patchSummary = null;
      if (replacements.length > 0) {
        assertWritable(specPath);
        const patchArgs = ['patch', specPath];
        for (const r of replacements) patchArgs.push('--replace', r);
        patchSummary = JSON.parse(runPy(patchArgs));
      }

      let normalizedLines = null;
      if (safeLines) {
        assertWritable(specPath);
        normalizedLines = JSON.parse(runPy(['normalize-lines', specPath]));
      }

      let cropSummary = null;
      if (sourceImg) {
        const specObj = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
        const hasCrop = (specObj.frames ?? []).some(f => (f.children ?? []).some(c => c.kind === 'image' && c.crop));
        if (hasCrop) {
          assertWritable(specPath);
          cropSummary = JSON.parse(runPy(['crop', specPath, '--source', sourceImg, '--scale', scale]));
        }
      }

      if (existsSync(outAxvg) && (outAxvg.endsWith('.axvg.json') || outAxvg.endsWith('.json'))) {
        unlinkSync(outAxvg);
      }
      const buildRes = spawnSync(process.execPath, [AXVG_MJS, 'build', specPath, '-o', outAxvg], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (buildRes.status !== 0) {
        throw new Error((buildRes.stderr?.toString() || `axvg build exited ${buildRes.status}`).trim());
      }

      let verifySummary = null;
      if (verifyDir && sourceImg) {
        assertWritable(verifyDir);
        const verArgs = ['verify', specPath, '--source', sourceImg, '-o', verifyDir, '--scale', scale];
        if (previewImg) verArgs.push('--preview', previewImg);
        verifySummary = JSON.parse(runPy(verArgs));
      }

      console.log(JSON.stringify({
        axvgOut: resolve(outAxvg),
        axvgStdout: buildRes.stdout.toString().trim(),
        ...(redirectedFromRp ? {
          rpRedirectNotice: `注意：build 产出的是 Axure 剪贴板 JSON 包 (.axvg.json) 而非二进制 .rp 容器，已自动重定向至 ${resolve(outAxvg)}（避免写入 ${redirectedFromRp} 导致 magic 7b 22 != ac ef 报错）。请使用 node scripts/axvg.mjs paste ${resolve(outAxvg)} 粘贴到已打开的 Axure 文档并保存。`,
        } : {}),
        ...(patchSummary ? { patch: patchSummary } : {}),
        ...(normalizedLines ? { normalizeLines: normalizedLines } : {}),
        ...(cropSummary ? { crop: cropSummary } : {}),
        ...(verifySummary ? { verify: verifySummary } : {}),
      }, null, 2));
    } else {
      console.error([
        '用法:',
        '  node scripts/trace.mjs draft <image.png> -o <out-dir> [--scale 2.0] [--spec <out.spec.json>] [--axvg <out.axvg.json>] [--replace "旧=新"] [--preview <axure-preview.png>]',
        '  node scripts/trace.mjs patch <spec.json> [-o <out.spec.json>] --replace "旧文本=新文本" [--replace "旧2=新2"]',
        '  node scripts/trace.mjs build <spec.json> -o <out.axvg.json> [--replace "旧=新"] [--source <image.png>] [--verify-dir <out-dir>] [--scale 2.0] [--safe-lines] [--preview <axure-preview.png>]',
        '  node scripts/trace.mjs scan <image.png> -o <out-dir> [--scale 2.0] [--sheet]',
        '  node scripts/trace.mjs crop <spec.json> --source <image.png> [-o <out.spec.json>] [--scale 2.0]',
        '  node scripts/trace.mjs normalize-lines <spec.json> [-o <out.spec.json>]',
        '  node scripts/trace.mjs verify <spec.json> --source <image.png> -o <out-dir> [--scale 2.0] [--preview <axure-preview.png>]',
        '  node scripts/trace.mjs selftest',
      ].join('\n'));
      process.exit(1);
    }
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
}
