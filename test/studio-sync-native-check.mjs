import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { exportStudioDocumentToRp, classifyNodeCompatibility } from '../studio/export-rp.mjs';
import { syncNativeRpToStudio, extractRpModel } from '../studio/sync-native.mjs';
import { startStudioServer } from '../studio/server.mjs';
import { studioTools } from '../studio/mcp-adapter.mjs';
import { validateInput } from '../studio/schema-validation.mjs';
import { setRecordWidgetText } from '../scripts/set-widget-text.mjs';
import { setWidgetRichText } from '../scripts/set-widget-richtext.mjs';
import { readRecords, encodeRecord, replaceRecord } from '../scripts/rp-records.mjs';
import { parsePayload, encodePayload, field } from '../scripts/parse-payload.mjs';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

function setNativeTextInPlace(rpPath, recordIdx, widgetId, text) {
  const tmpOut = `${rpPath}.tmp-text-${Date.now()}.rp`;
  setRecordWidgetText(rpPath, tmpOut, recordIdx, widgetId, text);
  copyFileSync(tmpOut, rpPath);
  rmSync(tmpOut, { force: true });
}

function patchNativeGeometryAndStyle(rpPath, recordIdx, widgetId, { x, y, w, h, fill, color, radius, rotation } = {}) {
  let fileBuf = readFileSync(rpPath);
  const rec = readRecords(fileBuf).find(r => r.index === recordIdx);
  assert(rec, `Record #${recordIdx} not found`);
  const graph = parsePayload(rec);
  const strings = [...rec.strings];
  const obj = graph.objects.get(widgetId);
  assert(obj, `Widget #${widgetId} not found in record #${recordIdx}`);
  const st = graph.objects.get(field(obj.body, 'MyStyle')?.value);
  assert(st, `MyStyle missing on widget #${widgetId}`);
  const propItems = field(st.body, 'PropList')?.items ?? [];
  const parseArgb = hex => (0xff000000 | parseInt(hex.replace(/^#/, ''), 16)) >>> 0;

  for (const it of propItems) {
    const doaNode = field(it, 'DOAName');
    const key = (doaNode?.value ?? 0) & 0x3fffffff;
    const val = field(it, 'Value');
    if (key === 50 && val && rotation !== undefined) val.value = rotation;
    if (key === 101 && val && (x !== undefined || y !== undefined)) {
      doaNode.value = (0xc0000000 + 101) >>> 0;
      if (x !== undefined && field(val, 'X')) field(val, 'X').value = x;
      if (y !== undefined && field(val, 'Y')) field(val, 'Y').value = y;
    }
    if (key === 105 && val && (w !== undefined || h !== undefined)) {
      doaNode.value = (0xc0000000 + 105) >>> 0;
      if (w !== undefined && field(val, 'Width')) field(val, 'Width').value = w;
      if (h !== undefined && field(val, 'Height')) field(val, 'Height').value = h;
    }
    if (key === 6 && val && color !== undefined) {
      doaNode.value = (0xc0000000 + 6) >>> 0;
      if (field(val, 'fill-color')) field(val, 'fill-color').value = parseArgb(color);
    }
    if (key === 7 && val && fill !== undefined) {
      doaNode.value = (0xc0000000 + 7) >>> 0;
      if (field(val, 'fill-color')) field(val, 'fill-color').value = parseArgb(fill);
    }
    if (key === 71 && val && radius !== undefined) {
      doaNode.value = (0xc0000000 + 71) >>> 0;
      val.value = radius;
    }
  }
  fileBuf = replaceRecord(fileBuf, rec, encodeRecord(rec, strings, encodePayload(graph.roots)));
  writeFileSync(rpPath, fileBuf);
}

function buildCompositeFixtureStore() {
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  const r = store.applyTransaction({
    baseRevision: 1,
    idempotencyKey: 'seed-composite',
    commands: [
      {
        type: 'createComponent',
        componentId: 'InfoBadge',
        root: {
          type: 'box',
          id: 'badge_root',
          layout: 'row',
          w: 180,
          h: 44,
          padding: 8,
          fill: '#EEF2FF',
          children: [
            { type: 'label', id: 'badge_lbl', text: 'Component Default', fontSize: 14, color: '#1E293B', w: 150, h: 24 },
          ],
        },
      },
      {
        type: 'addNode',
        pageId: 'home',
        node: {
          type: 'box',
          id: 'padded_stack',
          layout: 'stack',
          x: 24,
          y: 20,
          w: 320,
          h: 120,
          padding: [12, 16, 12, 16],
          fill: '#FFFFFF',
          children: [
            { type: 'label', id: 'plain_lbl', text: 'Original Heading', fontSize: 18, color: '#111827', x: 10, y: 14, w: 200, h: 32 },
          ],
        },
      },
      {
        type: 'addNode',
        pageId: 'home',
        node: {
          type: 'box',
          id: 'flow_col',
          layout: 'column',
          x: 24,
          y: 160,
          w: 320,
          h: 140,
          gap: 12,
          padding: 12,
          children: [
            { type: 'label', id: 'flow_item_1', text: 'Flow Row One', fontSize: 15, w: 240, h: 28 },
            { type: 'label', id: 'flow_item_2', text: 'Flow Row Two', fontSize: 15, w: 240, h: 28 },
          ],
        },
      },
      {
        type: 'addNode',
        pageId: 'home',
        node: {
          type: 'card',
          id: 'my_card',
          title: 'Initial Card Title',
          body: 'Initial Card Body',
          titleFontSize: 18,
          x: 380,
          y: 20,
          w: 280,
          h: 140,
        },
      },
      {
        type: 'createInstance',
        pageId: 'home',
        componentId: 'InfoBadge',
        instanceId: 'my_inst',
        x: 380,
        y: 180,
      },
      {
        type: 'addNode',
        pageId: 'home',
        node: {
          type: 'dynamic-panel',
          id: 'my_panel',
          x: 380,
          y: 250,
          w: 280,
          h: 120,
          activeState: 'st1',
          states: [
            {
              id: 'st1',
              name: 'State 1',
              root: {
                type: 'box',
                id: 'st1_root',
                layout: 'stack',
                w: 280,
                h: 120,
                children: [{ type: 'label', id: 'st1_lbl', text: 'Active State Copy', x: 12, y: 12, w: 180, h: 28 }],
              },
            },
            {
              id: 'st2',
              name: 'State 2',
              root: {
                type: 'box',
                id: 'st2_root',
                layout: 'stack',
                w: 280,
                h: 120,
                children: [{ type: 'label', id: 'st2_lbl', text: 'Inactive State Copy', x: 16, y: 20, w: 180, h: 28 }],
              },
            },
          ],
        },
      },
      {
        type: 'addNode',
        pageId: 'home',
        node: {
          type: 'repeater',
          id: 'my_rep',
          x: 700,
          y: 20,
          w: 280,
          h: 180,
          rowHeight: 48,
          rowGap: 8,
          key: 'code',
          rows: [
            { code: 'ROW-01', title: 'First Item' },
            { code: 'ROW-02', title: 'Second Item' },
          ],
          template: {
            type: 'box',
            id: 'tpl_root',
            layout: 'stack',
            w: 280,
            h: 48,
            fill: '#F8FAFC',
            children: [
              { type: 'label', id: 'tpl_code', text: '=item.code', fontSize: 14, color: '#334155', x: 12, y: 10, w: 140, h: 24 },
            ],
          },
        },
      },
      {
        type: 'addPage',
        pageId: 'detail',
        name: '详情页',
      },
      {
        type: 'addNode',
        pageId: 'detail',
        node: {
          type: 'label',
          id: 'detail_lbl',
          text: 'Detail Original',
          fontSize: 20,
          x: 40,
          y: 40,
          w: 240,
          h: 36,
        },
      },
    ],
  });
  assert(r.ok, JSON.stringify(r));
  return store;
}

function findLoc(baseline, scopedId) {
  const sym = baseline.sourceMap.find(s => s.id === scopedId || s.logicalId === scopedId);
  assert(sym && sym.native?.length, `Missing symbol native loc for ${scopedId}`);
  return sym.native[0];
}

test(
  'studio_sync_native converges plain nodes, flow layout guidance, macro parameters, instance overrides, inactive panel states, repeater templates and multi-page edits into one undoable transaction',
  { timeout: 60000, skip: nativeTemplateSkipReason() },
  async t => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-sync-native-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const store = buildCompositeFixtureStore();
    const baseRpPath = join(dir, 'exported.rp');
    const exp = await exportStudioDocumentToRp(store.doc, { projectDir: dir, outRpPath: baseRpPath });
    assert(exp.ok);

    const editedRpPath = join(dir, 'edited.rp');
    copyFileSync(baseRpPath, editedRpPath);
    copyFileSync(`${baseRpPath}.baseline.json`, `${editedRpPath}.baseline.json`);

    const baseline = JSON.parse(readFileSync(`${baseRpPath}.baseline.json`, 'utf8'));
    const baseModel = extractRpModel(readFileSync(baseRpPath), baseRpPath);

    // 1. Plain node inside padded stack: move (+20, +10), resize (220, 40), change text & fontSize (24) & color (#DC2626)
    const plainLoc = findLoc(baseline, 'home/plain_lbl');
    const plainBaseW = baseModel.byRecordId.get(`${plainLoc.record}:${plainLoc.id}`);
    patchNativeGeometryAndStyle(editedRpPath, plainLoc.record, plainLoc.id, {
      x: plainBaseW.x + 20,
      y: plainBaseW.y + 10,
      w: 220,
      h: 40,
    });
    const plainRich = setWidgetRichText(readFileSync(editedRpPath), {
      record: plainLoc.record,
      widgetId: plainLoc.id,
      paragraphs: [{ runs: [{ text: 'Updated Plain Heading', style: { size: 24, color: '#DC2626' } }] }],
    });
    writeFileSync(editedRpPath, plainRich.file);

    // 2. Flow layout child: change text & width, and drag (x + 35, y + 18) -> x/y should be ignored with flow guidance
    const flowLoc = findLoc(baseline, 'home/flow_item_2');
    const flowBaseW = baseModel.byRecordId.get(`${flowLoc.record}:${flowLoc.id}`);
    patchNativeGeometryAndStyle(editedRpPath, flowLoc.record, flowLoc.id, {
      x: flowBaseW.x + 35,
      y: flowBaseW.y + 18,
      w: 260,
    });
    setNativeTextInPlace(editedRpPath, flowLoc.record, flowLoc.id, 'Flow Row Two Edited');

    // 3. Macro child (`my_card_title` and `my_card_body`): edit title text + fontSize (26) and body text, plus inner offset
    const cardTitleLoc = findLoc(baseline, 'home/my_card_title');
    const cardTitleBaseW = baseModel.byRecordId.get(`${cardTitleLoc.record}:${cardTitleLoc.id}`);
    patchNativeGeometryAndStyle(editedRpPath, cardTitleLoc.record, cardTitleLoc.id, {
      x: cardTitleBaseW.x + 12,
      y: cardTitleBaseW.y + 8,
    });
    const cardTitleRich = setWidgetRichText(readFileSync(editedRpPath), {
      record: cardTitleLoc.record,
      widgetId: cardTitleLoc.id,
      paragraphs: [{ runs: [{ text: 'Macro Title From RP9', style: { size: 26 } }] }],
    });
    writeFileSync(editedRpPath, cardTitleRich.file);

    const cardBodyLoc = findLoc(baseline, 'home/my_card_body');
    setNativeTextInPlace(editedRpPath, cardBodyLoc.record, cardBodyLoc.id, 'Macro Body From RP9');

    // 4. Component instance child (`home/my_inst__badge_lbl`): change text & fontSize (18) & color (#059669)
    const instLblLoc = findLoc(baseline, 'home/my_inst__badge_lbl');
    const instRich = setWidgetRichText(readFileSync(editedRpPath), {
      record: instLblLoc.record,
      widgetId: instLblLoc.id,
      paragraphs: [{ runs: [{ text: 'Instance Override Copy', style: { size: 18, color: '#059669' } }] }],
    });
    writeFileSync(editedRpPath, instRich.file);

    // 5. Inactive dynamic-panel state (`home/my_panel/st2/st2_lbl`): change text & move (+14, +6)
    const st2Loc = findLoc(baseline, 'home/my_panel/st2/st2_lbl');
    const st2BaseW = baseModel.byRecordId.get(`${st2Loc.record}:${st2Loc.id}`);
    patchNativeGeometryAndStyle(editedRpPath, st2Loc.record, st2Loc.id, {
      x: st2BaseW.x + 14,
      y: st2BaseW.y + 6,
    });
    setNativeTextInPlace(editedRpPath, st2Loc.record, st2Loc.id, 'Inactive State Updated');

    // 6. Repeater template (`home/my_rep/item/tpl_code`): change fontSize (20), color (#2563EB), width (180), AND overwrite text with literal 'ROW-01-LITERAL'
    const repTplLoc = findLoc(baseline, 'home/my_rep/item/tpl_code');
    patchNativeGeometryAndStyle(editedRpPath, repTplLoc.record, repTplLoc.id, {
      w: 180,
    });
    const repRich = setWidgetRichText(readFileSync(editedRpPath), {
      record: repTplLoc.record,
      widgetId: repTplLoc.id,
      paragraphs: [{ runs: [{ text: 'ROW-01-LITERAL', style: { size: 20, color: '#2563EB' } }] }],
    });
    writeFileSync(editedRpPath, repRich.file);

    // 7. Second page (`detail/detail_lbl`): change text
    const detailLoc = findLoc(baseline, 'detail/detail_lbl');
    setNativeTextInPlace(editedRpPath, detailLoc.record, detailLoc.id, 'Detail Page Updated');

    const beforeHash = store.doc.contentHash;
    const beforeCompJson = JSON.stringify(store.doc.components.InfoBadge);

    // Preview first
    const preview = await syncNativeRpToStudio({
      doc: store.doc,
      projectDir: dir,
      rpPath: editedRpPath,
      mode: 'preview',
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.applied, false);
    assert.equal(store.doc.contentHash, beforeHash, 'preview must not mutate doc');
    assert(preview.previewHash);
    assert(preview.commands.length >= 7);
    assert.equal(preview.ignoredFlowPositions.length, 1);
    assert.equal(preview.ignoredFlowPositions[0].code, 'W_FLOW_POSITION_IGNORED');
    assert.equal(preview.ignoredFlowPositions[0].scopedId, 'home/flow_item_2');
    assert.equal(preview.ignoredFlowPositions[0].suggestion?.command?.nodeId, 'home/flow_col');
    assert.equal(preview.formulaProtectedNodes.length, 1);
    assert.equal(preview.formulaProtectedNodes[0].targetNodeId, 'home/my_rep/template/tpl_code');
    assert.equal(preview.formulaProtectedNodes[0].formula, '=item.code');
    assert.equal(preview.formulaProtectedNodes[0].ignoredNativeText, 'ROW-01-LITERAL');
    assert(preview.unsupportedNativeChanges.some(u => u.scopedId === 'home/my_card_title' && u.field === 'geometry'));

    // Apply with previewHash
    const applied = await syncNativeRpToStudio({
      doc: store.doc,
      store,
      projectDir: dir,
      rpPath: editedRpPath,
      mode: 'apply',
      previewHash: preview.previewHash,
      idempotencyKey: 'apply-composite-native',
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.applied, true);
    assert.equal(applied.appliedRevision, 3);
    assert.notEqual(store.doc.contentHash, beforeHash);

    // Verify 1: Plain node source coordinates (10 + 20 = 30, 14 + 10 = 24), parent padding preserved, text/fontSize/color updated
    const paddedStack = store.doc.pages[0].root.children.find(n => n.id === 'padded_stack');
    const plainNode = paddedStack.children[0];
    assert.deepEqual(paddedStack.padding, [12, 16, 12, 16]);
    assert.equal(plainNode.x, 30);
    assert.equal(plainNode.y, 24);
    assert.equal(plainNode.w, 220);
    assert.equal(plainNode.h, 40);
    assert.equal(plainNode.text, 'Updated Plain Heading');
    assert.equal(plainNode.fontSize, 24);
    assert.equal(plainNode.color, '#DC2626');

    // Verify 2: Flow layout child updated text & width, but has NO x/y pollution and zero W_LAYOUT_IGNORES_POSITION diagnostics
    const flowCol = store.doc.pages[0].root.children.find(n => n.id === 'flow_col');
    const flowItem2 = flowCol.children[1];
    assert.equal(flowItem2.text, 'Flow Row Two Edited');
    assert.equal(flowItem2.w, 260);
    assert.equal(flowItem2.x, undefined);
    assert.equal(flowItem2.y, undefined);
    assert(!store.doc.diagnostics.some(d => d.code === 'W_LAYOUT_IGNORES_POSITION'));

    // Verify 3: Macro parameters updated on owner card (`my_card`)
    const myCard = store.doc.pages[0].root.children.find(n => n.id === 'my_card');
    assert.equal(myCard.title, 'Macro Title From RP9');
    assert.equal(myCard.titleFontSize, 26);
    assert.equal(myCard.body, 'Macro Body From RP9');

    // Verify 4: Component instance override updated, while component definition stays untouched
    const myInst = store.doc.pages[0].root.children.find(n => n.id === 'my_inst');
    assert.equal(myInst.overrides?.badge_lbl?.text, 'Instance Override Copy');
    assert.equal(myInst.overrides?.badge_lbl?.fontSize, 18);
    assert.equal(myInst.overrides?.badge_lbl?.color, '#059669');
    assert.equal(JSON.stringify(store.doc.components.InfoBadge), beforeCompJson);

    // Verify 5: Inactive panel state (`st2`) updated while `st1` and activeState remain untouched
    const myPanel = store.doc.pages[0].root.children.find(n => n.id === 'my_panel');
    assert.equal(myPanel.activeState, 'st1');
    assert.equal(myPanel.states[0].root.children[0].text, 'Active State Copy');
    assert.equal(myPanel.states[1].root.children[0].text, 'Inactive State Updated');
    assert.equal(myPanel.states[1].root.children[0].x, 30);
    assert.equal(myPanel.states[1].root.children[0].y, 26);

    // Verify 6: Repeater template updated style/size for all rows while preserving `=item.code` formula
    const myRep = store.doc.pages[0].root.children.find(n => n.id === 'my_rep');
    const tplCode = myRep.template.children[0];
    assert.equal(tplCode.text, '=item.code');
    assert.equal(tplCode.fontSize, 20);
    assert.equal(tplCode.color, '#2563EB');
    assert.equal(tplCode.w, 180);
    const resolvedScene = resolveDocumentScene(store.doc);
    const resolvedRep = resolvedScene.pages[0].nodes.find(n => n.id === 'my_rep');
    assert.deepEqual(
      resolvedRep.rowViews.map(rv => rv.nodes.find(n => n.id === 'tpl_code').text),
      ['ROW-01', 'ROW-02']
    );
    assert(resolvedRep.rowViews.every(rv => rv.nodes.find(n => n.id === 'tpl_code').fontSize === 20));

    // Verify 7: Second page updated
    const detailLbl = store.doc.pages[1].root.children.find(n => n.id === 'detail_lbl');
    assert.equal(detailLbl.text, 'Detail Page Updated');

    // Verify single undo restores the entire document to beforeHash
    const undone = store.undo();
    assert(undone.ok);
    assert.equal(store.doc.contentHash, beforeHash);
  }
);

test(
  'three-way conflict detection, explicit resolution policies and HTTP/async operations work end-to-end',
  { timeout: 60000, skip: nativeTemplateSkipReason() },
  async t => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-sync-conflict-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const { studio } = await startStudioServer({ projectDir: dir, port: 0 });
    t.after(() => studio.stop());

    const seed = await (
      await fetch(`${studio.url}/api/commands`, {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: 1,
          idempotencyKey: 'seed-conflict',
          commands: [
            { type: 'addNode', node: { type: 'label', id: 'headline', text: 'Base Headline', x: 24, y: 24, w: 280, h: 40 } },
            { type: 'addNode', node: { type: 'label', id: 'subline', text: 'Base Subline', x: 24, y: 80, w: 280, h: 32 } },
          ],
        }),
      })
    ).json();
    assert(seed.ok);

    const rpPath = join(dir, 'conflict-test.rp');
    const exp = await studio.exportRp({ outRpPath: rpPath });
    assert(exp.ok);
    const baseline = JSON.parse(readFileSync(`${rpPath}.baseline.json`, 'utf8'));
    const headlineLoc = findLoc(baseline, 'home/headline');
    const sublineLoc = findLoc(baseline, 'home/subline');

    // Concurrent edit in Studio: headline -> 'Studio Headline', while subline stays 'Base Subline'
    const studioEdit = await (
      await fetch(`${studio.url}/api/commands`, {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: 2,
          idempotencyKey: 'studio-concurrent',
          commands: [{ type: 'setText', nodeId: 'headline', text: 'Studio Headline' }],
        }),
      })
    ).json();
    assert(studioEdit.ok);
    const hashBeforeSync = studio.store.doc.contentHash;

    // Concurrent edit in Native .rp: headline -> 'Native Headline', subline -> 'Native Subline'
    setNativeTextInPlace(rpPath, headlineLoc.record, headlineLoc.id, 'Native Headline');
    setNativeTextInPlace(rpPath, sublineLoc.record, sublineLoc.id, 'Native Subline');

    // Validate MCP schema
    const syncTool = studioTools.find(tool => tool.name === 'studio_sync_native');
    assert(syncTool);
    validateInput(syncTool.inputSchema, { rpPath, mode: 'preview', prefer: 'fail' });

    // 1. Default prefer: 'fail' on apply rejects without mutating Studio document
    const conflictRes = await (
      await fetch(`${studio.url}/api/sync-native`, {
        method: 'POST',
        body: JSON.stringify({ rpPath, mode: 'apply', prefer: 'fail' }),
      })
    ).json();
    assert.equal(conflictRes.ok, false);
    assert.equal(conflictRes.code, 'E_NATIVE_SYNC_CONFLICT');
    assert.equal(conflictRes.unresolvedConflicts.length, 1);
    assert.equal(conflictRes.unresolvedConflicts[0].targetNodeId, 'home/headline');
    assert.equal(conflictRes.unresolvedConflicts[0].studioValue, 'Studio Headline');
    assert.equal(conflictRes.unresolvedConflicts[0].nativeValue, 'Native Headline');
    assert.equal(studio.store.doc.contentHash, hashBeforeSync);

    // 2. Async operation preview via StudioOperations
    const asyncJob = await (
      await fetch(`${studio.url}/api/sync-native`, {
        method: 'POST',
        body: JSON.stringify({
          async: true,
          requestKey: 'sync-preview-job',
          baseRevision: studio.store.appliedRevision,
          rpPath,
          mode: 'preview',
        }),
      })
    ).json();
    assert.equal(asyncJob.ok, true);
    assert(asyncJob.id);

    let opDone = null;
    for (let i = 0; i < 60; i++) {
      const st = await studio.operations.get({ id: asyncJob.id, includeResult: true });
      if (st.status === 'succeeded') {
        opDone = st;
        break;
      }
      if (st.status === 'failed' || st.status === 'interrupted') {
        throw new Error(`Async sync-native failed: ${JSON.stringify(st)}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert(opDone);
    assert.equal(opDone.result.summary.conflictCount, 1);

    // 3. Explicit per-node resolution: keep 'studio' for headline, apply non-conflicting native edit on subline
    const resolvedApply = await (
      await fetch(`${studio.url}/api/sync-native`, {
        method: 'POST',
        body: JSON.stringify({
          rpPath,
          mode: 'apply',
          resolutions: { 'home/headline': 'studio' },
          idempotencyKey: 'resolve-keep-studio',
        }),
      })
    ).json();
    assert.equal(resolvedApply.ok, true, JSON.stringify(resolvedApply));
    const nodesAfter = studio.scene.pages[0].nodes;
    assert.equal(nodesAfter.find(n => n.id === 'headline').text, 'Studio Headline');
    assert.equal(nodesAfter.find(n => n.id === 'subline').text, 'Native Subline');
  }
);


test('native rotation change is detected, applied, undoable, and conflicts with a concurrent rotation', { timeout: 60000, skip: nativeTemplateSkipReason() }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-sync-rotation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  assert.equal(store.applyTransaction({commands:[{type:'addNode',node:{id:'rot',type:'box',x:20,y:20,w:100,h:80,rotation:15}}]}).ok, true);
  const rpPath = join(dir, 'source.rp');
  assert((await exportStudioDocumentToRp(store.doc, {projectDir:dir,outRpPath:rpPath})).ok);
  const edited = join(dir, 'edited.rp');
  copyFileSync(rpPath, edited);
  copyFileSync(`${rpPath}.baseline.json`, `${edited}.baseline.json`);
  const baseline = JSON.parse(readFileSync(`${rpPath}.baseline.json`, 'utf8'));
  const loc = findLoc(baseline, 'home/rot');
  patchNativeGeometryAndStyle(edited, loc.record, loc.id, {rotation:45});
  const preview = await syncNativeRpToStudio({doc:store.doc,projectDir:dir,rpPath:edited,mode:'preview'});
  assert.equal(preview.syncStatus.state, 'native_changes_ready');
  assert(preview.commands.some(c => c.properties?.rotation === 45));
  const applied = await syncNativeRpToStudio({doc:store.doc,store,projectDir:dir,rpPath:edited,mode:'apply',previewHash:preview.previewHash});
  assert.equal(applied.ok,true,JSON.stringify(applied));
  assert.equal(store.doc.pages[0].root.children.find(n=>n.id==='rot').rotation,45);
  assert.equal(store.undo().ok,true);
  assert.equal(store.doc.pages[0].root.children.find(n=>n.id==='rot').rotation,15);
  assert.equal(store.applyTransaction({commands:[{type:'setProperties',nodeId:'rot',properties:{rotation:30}}]}).ok,true);
  const conflict = await syncNativeRpToStudio({doc:store.doc,projectDir:dir,rpPath:edited,mode:'preview'});
  assert(conflict.conflicts.some(c=>c.field === 'rotation' || c.fieldName === 'rotation'), JSON.stringify(conflict.conflicts));
});

test('button and badge rotations survive Studio native export', { timeout: 60000, skip: nativeTemplateSkipReason() }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-export-rotation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  const made = store.applyTransaction({ commands: [
    { type: 'addNode', node: { id: 'btn_rot', type: 'button', text: 'Continue', x: 20, y: 20, w: 150, h: 48, rotation: 25 } },
    { type: 'addNode', node: { id: 'badge_rot', type: 'badge', text: 'New', x: 20, y: 100, w: 100, h: 40, rotation: -30 } },
  ] });
  assert.equal(made.ok, true, JSON.stringify(made));
  const path = join(dir, 'rotation.rp');
  assert((await exportStudioDocumentToRp(store.doc, { projectDir: dir, outRpPath: path })).ok);
  const baseline = JSON.parse(readFileSync(`${path}.baseline.json`, 'utf8'));
  const model = extractRpModel(readFileSync(path), path);
  for (const [id, angle] of [['btn_rot', 25], ['badge_rot', -30]]) {
    const loc = findLoc(baseline, `home/${id}`);
    assert.equal(model.byRecordId.get(`${loc.record}:${loc.id}`).rotation, angle);
  }
});

test('input rotation is explicitly reported as unsupported by native export', () => {
  const entries = [];
  classifyNodeCompatibility({ id: 'input_rot', type: 'input', rotation: 76 }, 'home', entries);
  assert(entries.some(entry => entry.classification === 'unsupported' && entry.feature === 'input.rotation'));
});

test('conditional event wrappers export as native cases with converted branch actions', { timeout: 60000, skip: nativeTemplateSkipReason() }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-export-cases-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  const result = store.applyTransaction({ commands: [
    { type: 'set-variable', name: 'step', value: 1 },
    { type: 'addNode', node: { type: 'label', id: 'word', text: 'First', x: 20, y: 20, w: 200, h: 40 } },
    { type: 'addNode', node: { type: 'button', id: 'next', text: 'Next', x: 20, y: 80, w: 200, h: 44 } },
    { type: 'setInteraction', nodeId: 'next', event: 'click', actions: { cases: [
      { when: '=$step === 1', actions: [{ type: 'set-text', target: 'word', text: 'Second === word' }, { type: 'set-var', name: 'step', value: 2 }] },
      { when: '=$step !== 1', actions: [{ type: 'set-text', target: 'word', text: 'Complete' }] },
    ] } },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const exported = await exportStudioDocumentToRp(store.doc, { projectDir: dir, outRpPath: join(dir, 'cases.rp') });
  assert(exported.ok);
  assert(exported.report.summary.threeZerosPassed, JSON.stringify(exported.report.summary));
  const spec = JSON.parse(readFileSync(exported.sourcePath, 'utf8'));
  const find = node => node.id === 'next' ? node : (node.children || []).map(find).find(Boolean);
  const event = find(spec.pages[0].root).on.click;
  assert.equal(event.cases.length, 2);
  assert.equal(event.cases[0].actions[0].text, 'Second === word');
  assert.equal(event.cases[0].actions[1].type, 'set-variable');
  assert.equal(event.cases[0].actions[1].variable, 'step');
  assert(exported.report.interactionSources.some(source => source.actionCount === 3));
});
