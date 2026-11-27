import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyOfficialPreview, runWorkflow, exportPrototype } from '../scripts/authoring-workflow.mjs';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { downgradeRp, formatDowngradeReport } from '../scripts/downgrade-rp.mjs';
import { JobManager } from '../scripts/jobs.mjs';
import { generatePrototype } from '../scripts/mcp-tools.mjs';
import { nativeCheck } from '../scripts/native-check.mjs';
import { encodePayload, field, parsePayload } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { encodeManifest, encodeRecord, readManifest, readRecords, replaceRecord, replaceRecords } from '../scripts/rp-records.mjs';
import { setWidgetText } from '../scripts/set-widget-text.mjs';
import { adaptNodesForVersion } from '../scripts/version-adapt.mjs';
import { RP11_ONLY_DOA_CODES, RP11_ONLY_EVENTS } from '../scripts/version-fields.mjs';
import { lintVersionKeys } from '../scripts/version-lint.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const IPHONE_RP11 = '/Users/lilzee/axure-exp/outputs/dimensional-strike-20261127/review-remediation/exercise2-iphone-shell-repaired.rp';
const TRAINING_RP11 = '/Applications/Axure RP 11.app/Contents/Resources/DefaultSettings/Training/Prototyping Basics.rp';

function rp9To11(buf) {
  const b11 = synthesizeBlankProject({ version: 11, pageName: 'P1' });
  const b11Recs = readRecords(b11);
  const bc11 = b11Recs.find(r => r.className === 'xml:BreakingChanges');
  const ds11 = b11Recs.find(r => r.className === 'Axure:DocumentSettings');
  const reps = [];
  for (const rec of readRecords(buf)) {
    if (rec.className === 'xml:BreakingChanges' && bc11) { reps.push({ record: rec, raw: bc11.raw }); continue; }
    if (rec.className === 'Axure:DocumentSettings' && ds11) { reps.push({ record: rec, raw: ds11.raw }); continue; }
    const rc = Buffer.from(rec.raw);
    if (rc.length >= 8) rc.writeUInt32LE(11, 4);
    if (!rec.strings) { reps.push({ record: rec, raw: rc }); continue; }
    const g = parsePayload(rec);
    const s = [...rec.strings];
    adaptNodesForVersion([...g.objects.values()], { version: 11, str: t => { let i = s.indexOf(t); if (i < 0) { i = s.length; s.push(t); } return { tag: 8, value: i + 1, text: t }; } });
    const enc = encodeRecord({ ...rec, raw: rc }, s, encodePayload(g.roots));
    if (enc.length >= 8) enc.writeUInt32LE(11, 4);
    reps.push({ record: rec, raw: enc });
  }
  const out = replaceRecords(buf, reps);
  const mf = readManifest(out);
  for (const k of Object.keys(mf.value.root.parts ?? {})) {
    if (k.endsWith('.version') && !k.startsWith('11.')) {
      mf.value.root.parts['11.0.0.4137.version'] = mf.value.root.parts[k];
      delete mf.value.root.parts[k];
    }
  }
  const hdr = Buffer.from(out);
  hdr.writeUInt16LE(11, 2);
  return Buffer.concat([encodeManifest(hdr, mf.value), hdr.subarray(mf.dataStart)]);
}

test('downgradeRp rejects non-RP11 files and gates RP11-only constructs unless stripUnsupported=true', async () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-dg-gate-'));
  try {
    const blank9 = synthesizeBlankProject({ version: 9, pageName: 'P1' });
    assert.throws(() => downgradeRp(blank9), err => err.code === 'E_DOWNGRADE_NOT_RP11');

    // Generate a prototype with an InteractionEvent (button + onClick), convert to RP11, then inject RP11-only DOA + Event
    const gRes = generatePrototype({
      rp1: 'rp/1 target=9 name="Gate"\npage #p1 name="P1"\n  box #root [300x200]\n    button #b1 [120x40] x=20 y=20 "Click" goto="p1"',
      output: join(work, 'src.rp'),
      cwd: work,
    });
    assert.equal(gRes.status, 'completed', JSON.stringify(gRes.diagnostics));
    const base11 = rp9To11(readFileSync(gRes.output));

    const docRec = readRecords(base11).find(r => r.className === 'Axure:DesignDocument');
    const g = parsePayload(docRec);
    const strings = [...docRec.strings];
    const firstDoa = Number(Object.keys(RP11_ONLY_DOA_CODES)[0]);
    const anyStyleWithProp = [...g.objects.values()].find(o => field(o.body, 'PropList')?.items);
    assert.ok(anyStyleWithProp, 'Expected style object with PropList in base11');
    const propList = field(anyStyleWithProp.body, 'PropList');
    const strNode = t => { let idx = strings.indexOf(t); if (idx < 0) { idx = strings.length; strings.push(t); } return { tag: 8, value: idx + 1, text: t }; };
    propList.items.push({ tag: 1, entries: [[strNode('DOAName'), { tag: 5, value: firstDoa }], [strNode('Value'), { tag: 5, value: 1 }]] });

    let rp11Mut = replaceRecord(base11, docRec, encodeRecord(docRec, strings, encodePayload(g.roots)));
    const pageRec = readRecords(rp11Mut).find(r => r.className === 'Axure:Page');
    const pg = parsePayload(pageRec);
    const evObj = [...pg.objects.values()].find(o => o.className === 'Axure:InteractionEvent');
    assert.ok(evObj, 'Expected native Axure:InteractionEvent on page');
    field(evObj.body, 'event-type').value = RP11_ONLY_EVENTS.OnErrorSet;
    rp11Mut = replaceRecord(rp11Mut, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(pg.roots)));

    assert.throws(() => downgradeRp(rp11Mut), err => err.code === 'E_DOWNGRADE_UNSUPPORTED_RP11' && err.unsupported.length >= 2);

    const { file: out9, report } = downgradeRp(rp11Mut, { stripUnsupported: true });
    assert.equal(report.ok, true);
    assert.equal(report.targetVersion, 9);
    assert.equal(report.editorReadiness.upgradeModalRisk, false);
    assert.ok(report.droppedCount >= 2);
    assert.equal(report.lintErrors.length, 0);
    assert.equal(lintVersionKeys(out9, { version: 9 }).errors.length, 0);
    assert.match(formatDowngradeReport(report), /结构三零：unparseable=0 danglingRefs=0 problems=0/);

    const out9Path = join(work, 'stripped-out9.rp');
    writeFileSync(out9Path, out9);
    const nc = await nativeCheck(out9Path, { version: 9 });
    if (nc.status !== 'unavailable') assert.equal(nc.status, 'accepted', JSON.stringify(nc.error));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('downgradeRp converts real rich RP11 samples to RP9 with native --compile, edit, GUI roundtrip, and Chrome load', async t => {
  const work = mkdtempSync(join(tmpdir(), 'zee-downgrade-check-'));
  try {
    if (!existsSync(IPHONE_RP11) || !existsSync(TRAINING_RP11)) {
      return t.skip('Local RP11 corpus files not present on host');
    }

    for (const [tag, srcOrig] of [['iphone', IPHONE_RP11], ['training', TRAINING_RP11]]) {
      const copySrc = join(work, `${tag}-rp11.rp`);
      const outRp9 = join(work, `${tag}-rp9.rp`);
      copyFileSync(srcOrig, copySrc);

      const { file, report } = downgradeRp(copySrc, { stripUnsupported: true });
      assert.equal(report.ok, true, `${tag} downgrade failed: ${JSON.stringify(report.lintErrors)}`);
      assert.equal(report.targetVersion, 9);
      assert.equal(report.editorReadiness.upgradeModalRisk, false);
      assert.equal(report.structure.unparseable, 0);
      assert.equal(report.structure.danglingRefs, 0);
      assert.equal(report.structure.problems, 0);
      writeFileSync(outRp9, file);

      const nc = await nativeCheck(outRp9, { version: 9, compile: true });
      if (nc.status !== 'unavailable') {
        assert.equal(nc.status, 'accepted', `${tag} RP9 native-check --compile failed: ${JSON.stringify(nc.error)}`);
        assert.equal(nc.officialCompile?.status, 'accepted');
      }

      if (tag === 'training' && nc.status !== 'unavailable') {
        const info = readRp(file, { includeWidgets: true });
        const pageWithText = info.pages.find(p => p.widgets.some(w => w.name && w.text && w.text.length > 2));
        assert.ok(pageWithText, 'Expected editable widget on Training prototype');
        const targetWidget = pageWithText.widgets.find(w => w.name && w.text && w.text.length > 2);
        const editedPath = join(work, 'training-rp9-edited.rp');
        setWidgetText(outRp9, editedPath, pageWithText.name, targetWidget.name, 'RP9 降级编辑验证');

        const guiOut = join(work, 'training-rp9-gui.rp');
        const jm = new JobManager();
        const rt = await jm.startRoundtrip({ source: editedPath, output: guiOut, wait: true, version: 9 });
        try {
          execFileSync('swift', [join(REPO, 'scripts/gui-roundtrip.swift'), '--close', guiOut, '9'], { encoding: 'utf8', timeout: 30000 });
        } catch {}
        assert.equal(rt.status, 'completed', `RP9 GUI roundtrip failed: ${JSON.stringify(rt)}`);
        const savedInfo = readRp(readFileSync(guiOut));
        assert.equal(savedInfo.version, 9);
        assert.equal(savedInfo.records.unparseable, 0);
        assert.equal(savedInfo.counts.danglingRefs, 0);
        assert.equal(savedInfo.counts.problems, 0);

        const bv = await verifyOfficialPreview({ rp: guiOut, engine: 'official', steps: [] }, { runWorkflow, exportHtml: exportPrototype });
        assert.equal(bv.status, 'completed', `Chrome official preview check failed: ${JSON.stringify(bv.diagnostics)}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
