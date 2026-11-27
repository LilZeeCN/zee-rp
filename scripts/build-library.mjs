// 原生 .rplib 组件库编译器（build-library）
// 将 .rp 或 .rp1 源码编译为 RP9 / RP11 原生组件库 (.rplib)，设置 DesignDocument document-type=2 & SavedEdition=2，
// 验证索引可检索且可通过 clone-library-widget 回灌任意原型。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeBlankProject } from './blank-synthesizer.mjs';
import { downgradeRp } from './downgrade-rp.mjs';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { fixPanelRegistry } from './fix-panel-registry.mjs';
import { indexLibrary } from './index-library.mjs';
import { generatePrototype } from './mcp-tools.mjs';
import { encodePayload, field, parsePayload } from './parse-payload.mjs';
import { readRp } from './rp-read.mjs';
import { encodeManifest, encodeRecord, readManifest, readRecords, replaceRecords } from './rp-records.mjs';
import { adaptNodesForVersion } from './version-adapt.mjs';
import { detectFileVersion } from './version.mjs';

function strNode(strings, text) {
  let idx = strings.indexOf(text);
  if (idx < 0) {
    idx = strings.length;
    strings.push(text);
  }
  return { tag: 8, value: idx + 1, text };
}

function setIntField(obj, strings, key, value) {
  const existing = obj.body.entries.find(([k]) => k?.text === key);
  if (existing) {
    existing[1] = { tag: 5, value };
  } else {
    obj.body.entries.unshift([strNode(strings, key), { tag: 5, value }]);
  }
}

function convertRp9ToRp11(buf) {
  const blank11 = synthesizeBlankProject({ version: 11, pageName: 'Page 1' });
  const blank11Recs = readRecords(blank11);
  const blank11Breaking = blank11Recs.find(r => r.className === 'xml:BreakingChanges');
  const blank11Settings = blank11Recs.find(r => r.className === 'Axure:DocumentSettings');
  const recs = readRecords(buf);
  const replacements = [];
  for (const rec of recs) {
    if (rec.className === 'xml:BreakingChanges' && blank11Breaking) {
      replacements.push({ record: rec, raw: blank11Breaking.raw });
      continue;
    }
    if (rec.className === 'Axure:DocumentSettings' && blank11Settings) {
      replacements.push({ record: rec, raw: blank11Settings.raw });
      continue;
    }
    const rawCopy = Buffer.from(rec.raw);
    if (rawCopy.length >= 8) rawCopy.writeUInt32LE(11, 4);
    if (!rec.strings) {
      replacements.push({ record: rec, raw: rawCopy });
      continue;
    }
    const graph = parsePayload(rec);
    const strings = [...rec.strings];
    adaptNodesForVersion([...graph.objects.values()], {
      version: 11,
      str: text => strNode(strings, text),
    });
    const fakeRec = { ...rec, raw: rawCopy };
    const encoded = encodeRecord(fakeRec, strings, encodePayload(graph.roots));
    if (encoded.length >= 8) encoded.writeUInt32LE(11, 4);
    replacements.push({ record: rec, raw: encoded });
  }
  let outBuf = replaceRecords(buf, replacements);
  const mf = readManifest(outBuf);
  for (const k of Object.keys(mf.value.root.parts ?? {})) {
    if (k.endsWith('.version') && !k.startsWith('11.')) {
      mf.value.root.parts['11.0.0.4137.version'] = mf.value.root.parts[k];
      delete mf.value.root.parts[k];
    }
  }
  const headerCopy = Buffer.from(outBuf);
  headerCopy.writeUInt16LE(11, 2);
  outBuf = Buffer.concat([encodeManifest(headerCopy, mf.value), headerCopy.subarray(mf.dataStart)]);
  return outBuf;
}

export function buildLibrary(sourceInput, { version = 9, cwd, stripUnsupported = true } = {}) {
  const targetVersion = Number(version);
  if (![9, 11].includes(targetVersion)) {
    throw Object.assign(new Error(`仅支持导出 RP9 或 RP11 组件库，收到 version=${version}`), { code: 'E_BUILD_LIB_VERSION' });
  }

  let rpBuf;
  let sourceKind = 'buffer';
  let sourceLabel = '(buffer)';

  if (Buffer.isBuffer(sourceInput) || sourceInput instanceof Uint8Array) {
    rpBuf = Buffer.from(sourceInput);
  } else {
    const rawText = String(sourceInput);
    const looksInlineRp1 = rawText.includes('\n') || rawText.trimStart().startsWith('rp/1 ');
    const resolved = looksInlineRp1 ? null : resolve(cwd ?? process.cwd(), rawText);
    if (!looksInlineRp1 && resolved && existsSync(resolved)) {
      assertNotProtected(resolved);
      sourceLabel = resolved;
      if (extname(resolved).toLowerCase() === '.rp' || extname(resolved).toLowerCase() === '.rplib') {
        sourceKind = 'rp';
        rpBuf = readFileSync(resolved);
      } else {
        sourceKind = 'rp1-file';
        const rp1Raw = readFileSync(resolved, 'utf8');
        const normalized = rp1Raw.replace(/^(\s*rp\/1\b[^\n]*?\btarget=)(9|11)\b/m, '$19');
        const tmpDir = mkdtempSync(join(tmpdir(), 'zee-build-lib-'));
        try {
          const outRp = join(tmpDir, 'compiled.rp');
          const res = generatePrototype({ rp1: normalized, output: outRp, cwd: tmpDir });
          if (res.status !== 'completed') {
            throw Object.assign(new Error(`RP/1 编译失败: ${JSON.stringify(res.diagnostics)}`), {
              code: 'E_BUILD_LIB_COMPILE',
              diagnostics: res.diagnostics,
            });
          }
          rpBuf = readFileSync(res.output);
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    } else if (looksInlineRp1) {
      sourceKind = 'rp1-inline';
      sourceLabel = '(inline rp1)';
      const normalized = rawText.replace(/^(\s*rp\/1\b[^\n]*?\btarget=)(9|11)\b/m, '$19');
      const tmpDir = mkdtempSync(join(tmpdir(), 'zee-build-lib-'));
      try {
        const outRp = join(tmpDir, 'compiled.rp');
        const res = generatePrototype({ rp1: normalized, output: outRp, cwd: tmpDir });
        if (res.status !== 'completed') {
          throw Object.assign(new Error(`RP/1 编译失败: ${JSON.stringify(res.diagnostics)}`), {
            code: 'E_BUILD_LIB_COMPILE',
            diagnostics: res.diagnostics,
          });
        }
        rpBuf = readFileSync(res.output);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      throw new Error(`找不到组件库源文件：${rawText}`);
    }
  }

  const curVer = detectFileVersion(rpBuf);
  if (curVer === 11 && targetVersion === 9) {
    rpBuf = downgradeRp(rpBuf, { stripUnsupported }).file;
  } else if (curVer === 9 && targetVersion === 11) {
    rpBuf = convertRp9ToRp11(rpBuf);
  }

  // Flip DesignDocument flags to Axure widget library (document-type=2, SavedEdition=2)
  const recs = readRecords(rpBuf);
  const docRec = recs.find(r => r.className === 'Axure:DesignDocument');
  const docGraph = parsePayload(docRec);
  const docStrings = [...docRec.strings];
  const docRoot = docGraph.objects.get(docGraph.roots.find(n => n.tag === 0xf)?.value);
  setIntField(docRoot, docStrings, 'document-type', 2);
  setIntField(docRoot, docStrings, 'SavedEdition', 2);

  const rawCopy = Buffer.from(docRec.raw);
  if (rawCopy.length >= 8) rawCopy.writeUInt32LE(targetVersion, 4);
  const encodedDoc = encodeRecord({ ...docRec, raw: rawCopy }, docStrings, encodePayload(docGraph.roots));
  if (encodedDoc.length >= 8) encodedDoc.writeUInt32LE(targetVersion, 4);

  let outBuf = replaceRecords(rpBuf, [{ record: docRec, raw: encodedDoc }]);
  const mf = readManifest(outBuf);
  const headerCopy = Buffer.from(outBuf);
  headerCopy.writeUInt16LE(targetVersion, 2);
  outBuf = Buffer.concat([encodeManifest(headerCopy, mf.value), headerCopy.subarray(mf.dataStart)]);
  if (targetVersion === 9) outBuf = fixPanelRegistry(outBuf).file;

  const check = readRp(outBuf);
  const tmpIdxDir = mkdtempSync(join(tmpdir(), 'zee-lib-idx-'));
  let libIndex;
  try {
    const tmpLib = join(tmpIdxDir, 'preview.rplib');
    writeFileSync(tmpLib, outBuf);
    libIndex = indexLibrary(tmpLib, { limit: 10000 });
  } finally {
    rmSync(tmpIdxDir, { recursive: true, force: true });
  }

  return {
    file: outBuf,
    report: {
      ok: check.records.unparseable === 0 && check.counts.danglingRefs === 0 && check.counts.problems === 0,
      evidence: 'structure',
      sourceKind,
      source: sourceLabel,
      version: check.version,
      documentType: 2,
      savedEdition: 2,
      widgetPages: libIndex.counts.pages,
      widgets: libIndex.pages.map(p => p.name),
      structure: {
        unparseable: check.records.unparseable,
        danglingRefs: check.counts.danglingRefs,
        problems: check.counts.problems,
      },
    },
  };
}

export function formatBuildLibraryReport(report) {
  return [
    `# 原生组件库编译报告 (RP${report.version} .rplib)`,
    `来源：${report.source} (${report.sourceKind}) | document-type=${report.documentType} SavedEdition=${report.savedEdition}`,
    `收录组件页（${report.widgetPages} 个）：${report.widgets.join(', ')}`,
    `结构三零：unparseable=${report.structure.unparseable} danglingRefs=${report.structure.danglingRefs} problems=${report.structure.problems}`,
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const vIdx = argv.indexOf('--version');
  const version = vIdx >= 0 && argv[vIdx + 1] ? Number(argv[vIdx + 1]) : 9;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') { i++; continue; }
    if (argv[i].startsWith('--')) continue;
    positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    console.error('用法: node build-library.mjs <source.rp|source.rp1> <output.rplib> [--version 9|11] [--json]');
    process.exit(1);
  }
  const src = resolve(positional[0]);
  const dst = resolve(positional[1]);
  assertNotProtected(src);
  assertWritable(dst);
  const { file, report } = buildLibrary(src, { version });
  writeFileSync(dst, file, { flag: 'wx' });
  console.log(json ? JSON.stringify({ ...report, output: dst }, null, 2) : formatBuildLibraryReport({ ...report, output: dst }));
}
