import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyStudioDocument } from '../studio/document.mjs';
import { generateGeneralExplorations, validateExplorationsUsability } from '../studio/explorations.mjs';
import { validateComponentInstanceAgainstContract, evolveComponentContractOnDocument } from '../studio/component-contracts.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { applyCommandsToDocument, StudioDocumentStore } from '../studio/commands.mjs';
import { createDomainProjectDocument, selectAffectedScenarios } from '../studio/scenarios.mjs';
import { measureTextBoxExact, measureLineWidthExact, clearTypographyCache } from '../studio/typography.mjs';
import { registerProjectFont } from '../studio/typography.mjs';
import { runInteractionSteps } from '../studio/scenario-executors.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('exploration preserves single required row, additional content, and non-link behavior', () => {
  const doc = createEmptyStudioDocument();
  doc.variables.approved = false;
  doc.pages[0].root.children[0].children = [{
    id: 'approve', type: 'button', text: '批准申请', w: 120, h: 44,
    on: { click: [{ type: 'set-variable', name: 'approved', value: true }] },
  }];
  const schemes = generateGeneralExplorations(doc.pages[0], doc, {
    pageGoal: '审批工作台', primaryAction: { label: '批准申请' },
    requiredContent: [
      { role: 'mandatory-notice', title: '必须保留的审批须知' },
      { role: 'content-list', items: [{ id: 'record-only', title: '唯一必备记录' }] },
    ],
  });
  for (const scheme of schemes) {
    const source = JSON.stringify(scheme);
    assert.ok(source.includes('必须保留的审批须知'), scheme.id);
    assert.ok(source.includes('唯一必备记录'), scheme.id);
    assert.ok(source.includes('set-variable'), scheme.id);
    assert.ok(!source.includes('核心事项二'));
  }
});

test('contract enforces declared label length and accepts valid content', () => {
  const doc = createEmptyStudioDocument();
  for (const label of ['', 'X'.repeat(1000), '🦜'.repeat(25)]) {
    const instance = { type: 'instance', id: 'button-test', component: 'button', props: { label } };
    assert.equal(validateComponentInstanceAgainstContract(instance, doc, { strict: false }).valid, false);
    assert.throws(() => validateComponentInstanceAgainstContract(instance, doc), { code: 'E_COMPONENT_CONTRACT' });
  }
  assert.equal(validateComponentInstanceAgainstContract({ type: 'instance', id: 'button-test', component: 'button', props: { label: '提交申请' } }, doc).valid, true);
  assert.equal(validateComponentInstanceAgainstContract({ type: 'instance', id: 'button-test', component: 'button', props: { label: '🦜'.repeat(24) } }, doc).valid, true);
});

test('contract evolution migrates instances inside component definitions', () => {
  const doc = createEmptyStudioDocument();
  doc.components.wrapper = { id: 'wrapper', root: { id: 'wrap', type: 'box', layout: 'column', w: 250, h: 'hug', children: [
    { id: 'inner', type: 'instance', component: 'button', props: { label: '保留文字' } },
  ] } };
  doc.pages[0].root.children[0].children = [{ id: 'outer', type: 'instance', component: 'wrapper', w: 250, h: 'hug' }];
  const result = evolveComponentContractOnDocument(doc, { componentId: 'button', newVersion: '1.1.0', renamedParameters: { label: 'caption' } });
  assert.ok(result.migratedInstances.some(i => i.instanceId === 'inner'));
  const labels = resolveDocumentScene(doc).pages[0].nodes.filter(n => n.id.includes('btn_label')).map(n => n.text);
  assert.deepEqual(labels, ['保留文字']);
});

test('deleting interactive content requires verification and selects affected business flows', () => {
  const doc = createDomainProjectDocument('birding');
  const result = applyCommandsToDocument(doc, [{ type: 'deleteNode', nodeId: 'home/hero_card' }]);
  assert.ok(result.ok);
  assert.notEqual(result.humanReadableSummary.interactionVerification.verifiedByInteractionHash, true);
  assert.equal(result.humanReadableSummary.interactionVerification.requiresScenarioRun, true);
  const selected = selectAffectedScenarios({ semanticDiff: result.semanticDiff, transitiveImpact: result.transitiveImpact }).map(s => s.scenarioId);
  assert.ok(selected.includes('flow-list-to-detail-and-back'));
  assert.ok(selected.includes('idempotency-rapid-double-submit'));
});

test('shaped text includes kerning and non-ASCII glyphs', () => {
  assert.ok(Math.abs(measureLineWidthExact('AVAVAVAVAV', { fontFamily: 'Helvetica Neue', fontSize: 32 }) - 188.1953) <= 1);
  assert.ok(Math.abs(measureLineWidthExact('Café naïve résumé façade', { fontFamily: 'Helvetica Neue', fontSize: 24 }) - 279.1484) <= 1);
});

test('maxLines limits displayed text while preserving original source', () => {
  clearTypographyCache();
  const node = { type: 'paragraph', text: '第一行\n第二行\n第三行\n第四行', fontSize: 16, w: 120, wrap: true, maxLines: 1, ellipsis: true };
  const result = measureTextBoxExact(node, 120);
  assert.equal(result.lineCount, 1);
  assert.ok(result.lines[0].endsWith('…'));
  assert.equal(node.text.split('\n').length, 4);
  const doc = createEmptyStudioDocument();
  doc.pages[0].root.children[0].children = [{ ...node, id: 'limited', h: 'hug' }];
  const displayed = resolveDocumentScene(doc).pages[0].nodes.find(n => n.id === 'limited');
  assert.equal(displayed.lineCount, 1);
  assert.ok(displayed.text.endsWith('…'));
});

test('height changes invalidate clipping diagnostics without clearing caches', () => {
  clearTypographyCache();
  const node = { type: 'paragraph', text: '第一行\n第二行\n第三行\n第四行', fontSize: 16, w: 120, wrap: true };
  measureTextBoxExact(node, 120);
  const cached = measureTextBoxExact({ ...node, h: 10 }, 120);
  clearTypographyCache();
  const fresh = measureTextBoxExact({ ...node, h: 10 }, 120);
  assert.equal(cached.clipped, true);
  assert.equal(cached.verticalOverflowPx, fresh.verticalOverflowPx);
});

test('scoped references and colliding original IDs survive exploration', () => {
  const doc = createEmptyStudioDocument();
  doc.pages[0].root.children[0].children = [
    { type: 'button', id: 'identify_entry', text: '批准', w: 100, h: 40, on: { click: [{ type: 'set-text', target: 'home/result', text: '已批准' }] } },
    { type: 'label', id: 'result', text: '待审批', w: 200, h: 30 },
  ];
  const walk = node => [node, ...(node.children || []).flatMap(walk)];
  for (const scheme of generateGeneralExplorations(doc.pages[0], doc, { pageGoal: '审批', requiredContent: [{ role: 'content-list', items: [{ id: 'rowB', title: '唯一记录' }] }] })) {
    const nodes = walk(scheme.root);
    assert.equal(nodes.filter(n => n.id === 'identify_entry').length, 1);
    assert.ok(nodes.some(n => n.id === 'result'));
    assert.ok(nodes.some(n => n.id === 'rowB'));
  }
});

test('parameter and subnode overrides obey the same declared contract', () => {
  const doc = createEmptyStudioDocument();
  for (const value of ['', 'X'.repeat(1000), 7]) {
    for (const overrides of [{ label: value }, { btn_label: { text: value } }]) {
      assert.equal(validateComponentInstanceAgainstContract({ id: 'b', type: 'instance', component: 'button', overrides }, doc, { strict: false }).valid, false);
    }
  }
});

test('contract upgrades migrate slot content', () => {
  const doc = createEmptyStudioDocument();
  doc.pages[0].root.children[0].children = [{ id: 'card', type: 'instance', component: 'info-card', props: { title: '测试' }, slots: {
    footerActions: [{ id: 'slotBtn', type: 'instance', component: 'button', props: { label: '插槽文案' } }],
  } }];
  const report = evolveComponentContractOnDocument(doc, { componentId: 'button', newVersion: '1.1.0', renamedParameters: { label: 'caption' } });
  assert.ok(report.migratedInstances.some(i => i.instanceId === 'slotBtn'));
  assert.equal(resolveDocumentScene(doc).pages[0].nodes.find(n => n.id === 'slotBtn__btn_label').text, '插槽文案');
});

test('unsupported assertions do not produce passing browser results', async () => {
  const result = await runInteractionSteps(null, {}, [{ action: 'expect', expect: { datasetCount: { records: 3 } } }], { layer: 'browser' });
  assert.equal(result.passed, false);
  assert.equal(result.status, 'unsupported');
});

test('missing registered fonts are diagnosed instead of labelled as loaded', () => {
  registerProjectFont('ReviewMissingFamily_20261026');
  const result = measureTextBoxExact({ text: 'Font probe', fontFamily: 'ReviewMissingFamily_20261026', fontSize: 16, w: 'hug' });
  assert.equal(result.isFontFallback, true);
  assert.equal(result.fontStatus, 'fallback');
});

test('invalid project font files cannot be reported as loaded system fonts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zee-bad-font-'));
  try {
    mkdirSync(join(dir, 'fonts'));
    writeFileSync(join(dir, 'fonts', 'Helvetica Neue.ttf'), 'not a font');
    const result = measureTextBoxExact({ text: 'Font probe', fontFamily: 'Helvetica Neue', fontSize: 16, w: 'hug' }, null, { projectDir: dir });
    assert.equal(result.isFontFallback, true);
    assert.equal(result.fontStatus, 'fallback');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('empty nested expectations cannot produce a passing execution', async () => {
  for (const expect of [{ variables: {} }, { text: {} }, {}]) {
    const result = await runInteractionSteps(null, {}, [{ action: 'expect', expect }], { layer: 'browser' });
    assert.equal(result.passed, false);
    assert.equal(result.code, 'E_SCENARIO_ASSERTIONS_REQUIRED');
  }
});

test('explorations retain hero summary and report the actual zero/one/many list count', () => {
  const doc = createEmptyStudioDocument();
  for (const count of [0, 1, 4]) {
    const schemes = generateGeneralExplorations(doc.pages[0], doc, { pageGoal: '审批', requiredContent: [
      { role: 'hero', title: '申请列表', summary: '必备摘要唯一XYZ' },
      { role: 'content-list', items: Array.from({ length: count }, (_, i) => ({ id: `record${i}`, title: `记录${i}` })) },
    ] });
    for (const scheme of schemes) {
      assert.ok(JSON.stringify(scheme).includes('必备摘要唯一XYZ'), scheme.id);
      const list = scheme.root.children[0].children.find(n => n.sectionRole === 'content-list');
      assert.equal(list.children.length, count);
    }
    assert.ok(JSON.stringify(schemes[2]).includes(`TOTAL: ${count} ITEMS`));
  }
});

test('required node IDs take precedence over generated template IDs', () => {
  const doc = createEmptyStudioDocument();
  doc.variables.approved = false;
  const schemes = generateGeneralExplorations(doc.pages[0], doc, { requiredContent: [
    { role: 'mandatory-action', node: { id: 'identify_entry', type: 'button', text: '必备审批', w: 100, h: 40, on: { click: [{ type: 'set-variable', name: 'approved', value: true }] } } },
    { role: 'content-list', items: [] },
  ] });
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  for (const scheme of schemes) {
    const nodes = walk(scheme.root).filter(n => n.id === 'identify_entry');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].on.click[0].type, 'set-variable');
  }
});

test('nested contract migration survives serialized reload, undo and redo', () => {
  const doc = createEmptyStudioDocument();
  doc.components.wrapper = { id: 'wrapper', root: { id: 'wrap', type: 'box', w: 250, h: 'hug', children: [
    { id: 'nested', type: 'instance', component: 'button', props: { label: '升级后仍保留' } },
  ] } };
  doc.pages[0].root.children[0].children = [{ id: 'outer', type: 'instance', component: 'wrapper', w: 250, h: 'hug' }];
  const store = new StudioDocumentStore(doc);
  const result = store.applyTransaction({ baseRevision: doc.revision, idempotencyKey: 'evolve-nested', commands: [
    { type: 'evolve-component-contract', componentId: 'button', newVersion: '1.1.0', renamedParameters: { label: 'caption' } },
  ] });
  assert.equal(result.ok, true);
  const reloaded = JSON.parse(JSON.stringify(store.doc));
  assert.equal(reloaded.components.wrapper.root.children[0].props.caption, '升级后仍保留');
  assert.ok(resolveDocumentScene(reloaded).pages[0].nodes.some(n => n.text === '升级后仍保留'));
  assert.equal(store.undo({ expectedRevision: store.doc.revision }).ok, true);
  assert.equal(store.doc.components.wrapper.root.children[0].props.label, '升级后仍保留');
  assert.equal(store.redo({ expectedRevision: store.doc.revision }).ok, true);
  assert.equal(store.doc.components.wrapper.root.children[0].props.caption, '升级后仍保留');
});

test('mobile templates and new canvases reserve space below the dynamic island', () => {
  for (const domain of ['birding', 'study-cards', 'equipment-loan']) {
    const doc = createDomainProjectDocument(domain);
    for (const page of resolveDocumentScene(doc).pages) {
      const nav = page.nodes.find(n => ['top_nav', 'list_nav', 'detail_nav'].includes(n.id));
      assert.ok(nav.y >= 60, `${domain}/${page.id}: navigation starts at ${nav.y}`);
      assert.ok(nav.y > page.board.island.y + page.board.island.h);
    }
    const schemes = generateGeneralExplorations(doc.pages[0], doc);
    doc.pages.push(...schemes);
    assert.ok(validateExplorationsUsability(doc, schemes).schemeReports.every(r => r.safeAreaViolationNodeIds.length === 0));
    schemes[0].root.children[0].padding[0] = 0;
    const failed = validateExplorationsUsability(doc, [schemes[0]]).schemeReports[0];
    assert.equal(failed.passedUsability, false);
    assert.ok(failed.safeAreaViolationNodeIds.length > 0);
  }
  const empty = createEmptyStudioDocument();
  empty.pages[0].root.children[0].children.push({ id: 'title', type: 'label', x: 0, y: 0, w: 200, h: 24, text: '从安全区开始' });
  assert.equal(resolveDocumentScene(empty).pages[0].nodes.find(n => n.id === 'title').y, 60);
});
