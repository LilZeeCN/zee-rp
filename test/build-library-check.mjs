import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { buildLibrary, formatBuildLibraryReport } from '../scripts/build-library.mjs';
import { cloneLibraryPageContent } from '../scripts/clone-library-page-content.mjs';
import { indexLibrary } from '../scripts/index-library.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';

const LIB_RP1 = [
  'rp/1 target=9 name="ZeeCustomUI"',
  'page #btn name="PrimaryButton"',
  '  box #root [200x48] fill="#2563EB" radius=8',
  '    button #cta [180x40] x=10 y=4 "立即提交"',
  'page #card name="StatCard"',
  '  box #card_root [240x120] fill="#FFFFFF" stroke="#E2E8F0" radius=12 layout=column padding=16 gap=8',
  '    label #kpi_label [200x20] "活跃用户"',
  '    label #kpi_val [200x32] "12,840" fontSize=24 fontWeight=700',
  'page #badge name="StatusPill"',
  '  box #pill_root [120x32] fill="#DCFCE7" radius=16',
  '    label #pill_txt [100x20] x=10 y=6 "已上线"',
].join('\n');

test('buildLibrary compiles RP9 & RP11 .rplib with DesignDocument type=2, passes indexLibrary and cloneLibraryWidget', async () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-build-lib-check-'));
  try {
    const rp1File = join(work, 'custom-ui.rp1');
    writeFileSync(rp1File, LIB_RP1, 'utf8');

    for (const version of [9, 11]) {
      const rplibOut = join(work, `custom-ui-rp${version}.rplib`);
      const { file, report } = buildLibrary(rp1File, { version });
      writeFileSync(rplibOut, file);

      assert.equal(report.ok, true);
      assert.equal(report.version, version);
      assert.equal(report.documentType, 2);
      assert.equal(report.savedEdition, 2);
      assert.equal(report.widgetPages, 3);
      assert.deepEqual(report.widgets.sort(), ['PrimaryButton', 'StatCard', 'StatusPill']);
      assert.match(formatBuildLibraryReport(report), /document-type=2 SavedEdition=2/);

      const docRec = readRecords(file).find(r => r.className === 'Axure:DesignDocument');
      const docGraph = parsePayload(docRec);
      const docRoot = docGraph.objects.get(docGraph.roots.find(n => n.tag === 0xf)?.value);
      assert.equal(field(docRoot.body, 'document-type')?.value, 2);
      assert.equal(field(docRoot.body, 'SavedEdition')?.value, 2);

      const idx = indexLibrary(rplibOut, { limit: 10000 });
      assert.equal(idx.counts.pages, 3);
      const info = readRp(file);
      assert.equal(info.version, version);
      assert.equal(info.records.unparseable, 0);
      assert.equal(info.counts.danglingRefs, 0);
      assert.equal(info.counts.problems, 0);

      const ncLib = await nativeCheck(rplibOut, { version });
      if (ncLib.status !== 'unavailable') {
        assert.equal(ncLib.status, 'accepted', `RP${version} .rplib failed nativeCheck: ${JSON.stringify(ncLib.error)}`);
      }
    }

    // Clone widget from generated RP9 .rplib into fresh blank .rp and run nativeCheck --compile
    const rp9LibPath = join(work, 'custom-ui-rp9.rplib');
    const consumerBlank = join(work, 'blank.rp');
    const consumerOut = join(work, 'consumer.rp');
    writeFileSync(consumerBlank, synthesizeBlankProject({ version: 9, pageName: 'Page 1' }));
    cloneLibraryPageContent(rp9LibPath, consumerBlank, consumerOut, {
      sourcePageName: 'PrimaryButton',
      targetPageName: 'Page 1',
      x: 40,
      y: 40,
    });
    const consumerInfo = readRp(readFileSync(consumerOut));
    assert.equal(consumerInfo.records.unparseable, 0);
    assert.equal(consumerInfo.counts.danglingRefs, 0);
    assert.equal(consumerInfo.counts.problems, 0);
    assert.ok(consumerInfo.counts.widgets >= 1);

    const ncConsumer = await nativeCheck(consumerOut, { version: 9, compile: true });
    if (ncConsumer.status !== 'unavailable') {
      assert.equal(ncConsumer.status, 'accepted', `Consumer .rp nativeCheck --compile failed: ${JSON.stringify(ncConsumer.error)}`);
      assert.equal(ncConsumer.officialCompile?.status, 'accepted');
    }

    // Also accept .rp file input directly -> .rplib
    const rpLibFromRp = buildLibrary(consumerOut, { version: 9 });
    assert.equal(rpLibFromRp.report.ok, true);
    assert.equal(rpLibFromRp.report.sourceKind, 'rp');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
