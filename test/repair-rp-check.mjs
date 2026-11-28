import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlankPage } from '../scripts/create-blank-page.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import { readManifest, readRecords } from '../scripts/rp-records.mjs';
import { formatRepairReport, repairRp } from '../scripts/repair-rp.mjs';
import { installRoot } from '../scripts/version.mjs';

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const TRAINING_RP11 = join(installRoot(11), 'Training', 'Prototyping Basics.rp');
const HAS_RP9_PANEL_TPL = existsSync(join(installRoot(9), 'Training', 'RP9 Tour.rp'));

function makeFixture(dir, version) {
  const rpPath = join(dir, `fixture-rp${version}.rp`);
  if (version === 11) {
    const raw0 = existsSync(TRAINING_RP11)
      ? readFileSync(TRAINING_RP11)
      : synthesizeBlankProject({ version: 11, pageName: '首页' });
    const step2 = createBlankPage(raw0, '详情页').file;
    const step3 = createBlankPage(step2, '设置页').file;
    writeFileSync(rpPath, step3);
    return { rpPath, buf: step3, expectPanels: existsSync(TRAINING_RP11) };
  }
  const detailsBlock = HAS_RP9_PANEL_TPL
    ? [
        '    panel #dp [300x120]',
        '      state #s1',
        '        label #s1_txt [200x30] "状态一"',
        '      state #s2',
        '        label #s2_txt [200x30] "状态二"',
      ]
    : [
        '    label #s1_txt [200x30] "无模板兜底状态文本一"',
        '    button #s2_btn [180x40] "切换状态"',
      ];
  const res = generatePrototype({
    rp1: [
      `rp/1 target=9 name="RepairFixtureV${version}"`,
      'var g_count: text = "42"',
      'page #home name="首页"',
      '  box #root [360x400] layout=column gap=12 padding=16',
      '    label #title [300x32] "首页标题"',
      '    button #btn1 [180x40] "去详情" goto="details"',
      'page #details name="详情页"',
      '  box #root2 [360x400] layout=column gap=12 padding=16',
      '    label #dtitle [300x32] "详情标题"',
      ...detailsBlock,
      'page #settings name="设置页"',
      '  box #root3 [360x400] layout=column gap=12 padding=16',
      '    label #stitle [300x32] "设置标题"',
      '    button #sbtn [180x40] "保存"',
    ].join('\n'),
    output: rpPath,
    cwd: dir,
  });
  assert.equal(res.status, 'completed', JSON.stringify(res.diagnostics));
  return { rpPath: res.output, buf: readFileSync(res.output), expectPanels: HAS_RP9_PANEL_TPL };
}

test('repairRp salvages multi-page + dynamic panel prototypes across 4 corruption modes on RP9 & RP11', async t => {
  const work = mkdtempSync(join(tmpdir(), 'zee-repair-check-'));
  try {
    const assertNative = async (tag, buf, version) => {
      const p = join(work, `repaired-${version}-${tag}.rp`);
      writeFileSync(p, buf);
      const nc = await nativeCheck(p, { version });
      if (nc.status !== 'unavailable') assert.equal(nc.status, 'accepted', `${tag} RP${version}: ${JSON.stringify(nc.error)}`);
    };
    for (const version of [9, 11]) {
      const { buf, expectPanels } = makeFixture(work, version);
      const mf = readManifest(buf);
      const recs = readRecords(buf);
      assert.equal(recs.filter(r => r.className === 'Axure:Page').length, 3);

      // Mode 1: corrupt manifest header (first 32 bytes zeroed)
      await t.test(`RP${version}: corrupt manifest header still salvages 100% pages`, async () => {
        const corrupt = Buffer.from(buf);
        corrupt.fill(0, 0, Math.min(32, mf.dataStart));
        const { file, report } = repairRp(corrupt);
        assert.equal(report.ok, true);
        assert.equal(report.version, version);
        assert.equal(report.salvaged.pages, 3);
        if (expectPanels) assert.ok(report.salvaged.panelStates >= 2);
        assert.equal(report.structure.unparseable, 0);
        assert.equal(report.structure.danglingRefs, 0);
        assert.equal(report.structure.problems, 0);
        assert.ok(report.discarded.some(d => d.kind === 'corrupt-manifest'));
        assert.match(formatRepairReport(report), /结构三零：unparseable=0 danglingRefs=0 problems=0/);
        await assertNative('manifest', file, version);
      });

      // Mode 2: truncate last page tail
      await t.test(`RP${version}: truncated tail salvages intact leading pages`, async () => {
        const lastPage = [...recs].reverse().find(r => r.className === 'Axure:Page');
        const corrupt = buf.subarray(0, lastPage.offset + 20);
        const { file, report } = repairRp(corrupt);
        assert.equal(report.ok, true);
        assert.ok(report.salvaged.pages >= 1 && report.salvaged.pages < 3);
        assert.equal(report.structure.unparseable, 0);
        assert.equal(report.structure.danglingRefs, 0);
        assert.equal(report.structure.problems, 0);
        assert.ok(report.discarded.some(d => d.kind === 'lost-page' || d.kind === 'lost-manifest-package'));
        await assertNative('tail', file, version);
      });

      // Mode 3: mid-file 1024-byte zeroing hitting middle page
      await t.test(`RP${version}: mid-file 1KB zeroing skips damaged page cleanly`, async () => {
        const pageRecs = recs.filter(r => r.className === 'Axure:Page');
        const mid = pageRecs[1];
        const corrupt = Buffer.from(buf);
        corrupt.fill(0, mid.offset, Math.min(corrupt.length, mid.offset + 1024));
        const { file, report } = repairRp(corrupt);
        assert.equal(report.ok, true);
        assert.equal(report.salvaged.pages, 2);
        assert.equal(report.structure.unparseable, 0);
        assert.equal(report.structure.danglingRefs, 0);
        assert.equal(report.structure.problems, 0);
        assert.ok(report.discarded.some(d => d.kind === 'lost-page'));
        await assertNative('midzero', file, version);
      });

      // Mode 4: delete a whole page record segment cleanly from middle of stream
      await t.test(`RP${version}: deleted middle record still salvages surviving pages`, async () => {
        const pageRecs = recs.filter(r => r.className === 'Axure:Page');
        const target = pageRecs[2];
        const endOff = target.offset + target.compressedSize;
        const corrupt = Buffer.concat([buf.subarray(0, target.offset - 4), buf.subarray(endOff)]);
        const { file, report } = repairRp(corrupt);
        assert.equal(report.ok, true);
        assert.equal(report.salvaged.pages, 2);
        assert.equal(report.structure.unparseable, 0);
        assert.equal(report.structure.danglingRefs, 0);
        assert.equal(report.structure.problems, 0);
        await assertNative('deleted', file, version);
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('repairRp refuses empty salvage by default, honors allowEmpty, and leaves source untouched', () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-repair-empty-'));
  try {
    const { rpPath, buf } = makeFixture(work, 9);
    const beforeHash = sha256(readFileSync(rpPath));
    const tiny = buf.subarray(0, 64);
    assert.throws(() => repairRp(tiny), err => err.code === 'E_REPAIR_NO_PAGES_SALVAGED');
    const fallback = repairRp(tiny, { allowEmpty: true });
    assert.equal(fallback.report.ok, true);
    assert.equal(readRp(fallback.file).counts.pages, 1);
    assert.equal(sha256(readFileSync(rpPath)), beforeHash);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
