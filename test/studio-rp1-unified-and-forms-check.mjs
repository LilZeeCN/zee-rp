import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import {
  createEmptyStudioDocument,
  normalizeStudioDocument,
  buildNodeIndex,
} from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { prepareRp1Commands } from '../studio/rp1-authoring.mjs';
import { resolveDocumentScene } from '../studio/scene-resolver.mjs';
import { queryAuthoringNodes } from '../studio/authoring-query.mjs';
import { StudioRuntimeSession } from '../studio/runtime.mjs';
import { exportStudioDocumentToCode } from '../studio/export-code.mjs';
import { exportStudioDocumentToRp } from '../studio/export-rp.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';

test('B5.1 queryAuthoringNodes supports capabilities/vector fields, macro child mapping, and deep property validation', () => {
  const doc = normalizeStudioDocument({
    domain: 'mobile',
    pages: [
      {
        id: 'home',
        name: 'Home',
        device: 'iphone-17',
        root: {
          id: 'shell',
          type: 'phone-shell',
          title: 'Demo',
          children: [
            {
              id: 'hero_card',
              type: 'card',
              title: 'Plan',
              body: 'Pro workspace',
              rightBadge: 'ACTIVE',
              rightTone: 'ok',
            },
            {
              id: 'metrics_row',
              type: 'stat-row',
              items: [
                { label: 'Conversion', value: '18.4%', sub: '+2.1% MoM' },
                { label: 'Latency', value: '42ms', sub: 'p95' },
              ],
            },
            {
              id: 'task_item',
              type: 'list-item',
              title: 'Ship release',
              subtitle: 'All gates green',
              tag: 'P0',
              rightBadge: 'Done',
            },
            {
              id: 'quota_bar',
              type: 'progress-bar',
              label: 'Storage',
              value: 65,
              max: 100,
            },
            {
              id: 'top_nav',
              type: 'nav-bar',
              title: 'Settings',
              backText: 'Back',
              rightText: 'Save',
            },
            {
              id: 'bottom_tabs',
              type: 'tab-bar',
              items: [
                { label: 'Home', active: true, goto: 'home' },
                { label: 'Profile', active: false, goto: 'home' },
              ],
            },
            {
              id: 'vec_star',
              type: 'path',
              x: 20,
              y: 20,
              w: 40,
              h: 40,
              d: 'M 20 0 L 40 40 L 0 40 Z',
              fill: '#2563EB',
            },
          ],
        },
      },
    ],
  });
  const scene = resolveDocumentScene(doc);

  // fields: ['capabilities', 'vector', 'target'] must succeed without E_QUERY_FIELDS
  const projected = queryAuthoringNodes({
    doc,
    scene,
    args: { pageId: 'home', fields: ['capabilities', 'vector', 'target'], limit: 100 },
  });
  assert.equal(projected.ok, true);
  const vecHit = projected.nodes.find(n => n.id === 'vec_star');
  assert.ok(vecHit?.capabilities, 'capabilities field must be projected');
  assert.ok(vecHit?.vector, 'vector field must be projected for path nodes');

  // Verify macro-expanded children map back to editable parent macro parameters
  const byChildId = childId =>
    queryAuthoringNodes({
      doc,
      scene,
      args: { pageId: 'home', nodeId: childId },
    }).nodes[0];

  assert.equal(byChildId('hero_card_right_badge').target.property, 'rightBadge');
  assert.equal(byChildId('metrics_row_val_0').target.property, 'items');
  assert.equal(byChildId('metrics_row_sub_0').target.property, 'items');
  assert.equal(byChildId('task_item_tag').target.property, 'tag');
  assert.equal(byChildId('task_item_badge').target.property, 'rightBadge');
  assert.equal(byChildId('quota_bar_bar').target.property, 'value');
  assert.equal(byChildId('top_nav_title').target.property, 'title');
  assert.equal(byChildId('bottom_tabs_tab_0').target.property, 'items');

  // Deep validation on fills, shadows, spans
  const store = new StudioDocumentStore(doc);
  assert.equal(
    store.applyTransaction({
      commands: [
        {
          type: 'setProperties',
          nodeId: 'hero_card',
          properties: { fills: [{ type: 'invalid-fill-kind', color: '#000000' }] },
        },
      ],
    }).code,
    'E_INVALID_VALUE'
  );
  assert.equal(
    store.applyTransaction({
      commands: [
        {
          type: 'setProperties',
          nodeId: 'hero_card',
          properties: { shadows: [{ x: 'bad', y: 2, blur: 4, color: '#000000' }] },
        },
      ],
    }).code,
    'E_INVALID_VALUE'
  );
  assert.equal(
    store.applyTransaction({
      commands: [
        {
          type: 'addNode',
          pageId: 'home',
          parentId: 'shell',
          node: { id: 'bad_spans', type: 'paragraph', spans: [{ text: 123 }] },
        },
      ],
    }).code,
    'E_INVALID_VALUE'
  );
});

test('B5.2 Studio RP/1 unified dialect: inline vars/tokens, decorative auto-IDs, panel state insert/update, tabs, progress-bar, and action shorthands', () => {
  const baseDoc = createEmptyStudioDocument({ domain: 'mobile', name: 'UnifiedRP1' });
  const store = new StudioDocumentStore(baseDoc);
  store.applyTransaction({
    commands: [
      { type: 'addPage', pageId: 'done', name: 'Done' },
      {
        type: 'addNode',
        pageId: 'done',
        node: { id: 'done_summary', type: 'label', text: 'Waiting...', x: 24, y: 80, w: 300, h: 32 },
      },
      {
        type: 'datasetOp',
        dataset: 'tasks',
        op: 'replace-all',
        rows: [{ title: 'Alpha' }, { title: 'Beta' }],
      },
    ],
  });

  // Decorative divider/spacer omit #id cleanly, while interactive/content nodes still require #id
  assert.throws(
    () =>
      prepareRp1Commands({
        doc: store.doc,
        pageId: 'home',
        mode: 'insert',
        source: 'column #bad_wrap [320xhug]\n  label "Missing explicit ID"',
      }),
    err => err.code === 'E_RP1_EXPLICIT_ID'
  );

  // Insert unified RP/1 snippet with inline vars:, tokens:, literal "$99" (not a variable!), panel tabs, progress-bar, repeater, and +onClick shorthand
  const insertSnippet = `
vars:
  progress = 40
  step = 1
tokens:
  cardGap = 12
column #flow_root [358xhug] gap=$cardGap
  label #price_banner [fillx28] "Starter bundle is $99 today"
  divider [fillx1]
  spacer [fillx8]
  progress-bar #prog [fillxhug] label="Completion" value="=$progress" max=100
  panel #wiz [fillx140] tabs=["Basic","Advanced"]
    :state #Basic
      label #basic_lbl [200x24] "Basic mode"
    :state #Advanced
      label #adv_lbl [200x24] "Advanced mode"
  repeater #task_rep [fillxhug] data=tasks gap=8
    :template
      row #tpl_row [fillx36]
        label #tpl_title [fillx24] "=item.title"
  button #advance_btn [fillx44] "Advance"
    +onClick [{"set":{"$progress":80,"$step":2,"@price_banner":"Upgraded","wiz.state":"Advanced"}},{"type":"set-text","target":"done/done_summary","text":"Completed from home"}]
  button #finish_btn [fillx44] "Finish"
    +onClick goto=done
`;
  const preparedInsert = prepareRp1Commands({
    doc: store.doc,
    pageId: 'home',
    parentId: 'home_screen',
    mode: 'insert',
    source: insertSnippet,
  });
  store.applyTransaction({ commands: preparedInsert.commands });

  assert.equal(store.doc.variables.progress, 40);
  assert.equal(store.doc.tokens.cardGap, 12);

  // Direct insertion into a specific dynamic-panel state via parentId: "wiz:Advanced"
  const stateInsert = prepareRp1Commands({
    doc: store.doc,
    pageId: 'home',
    parentId: 'wiz:Advanced',
    mode: 'insert',
    source: 'badge #adv_extra [96x24] "PRO ONLY" tone=info',
  });
  store.applyTransaction({ commands: stateInsert.commands });

  // Incremental mode: 'update' on dynamic-panel :state preserves sibling states (#Basic) and untouched children (adv_extra)
  const partialPanelUpdate = prepareRp1Commands({
    doc: store.doc,
    pageId: 'home',
    mode: 'update',
    source: `
panel #wiz
  :state #Advanced
    label #adv_lbl "Advanced mode v2"
`,
  });
  store.applyTransaction({ commands: partialPanelUpdate.commands });

  // Incremental mode: 'update' on repeater :template replaces template without wiping dataset binding
  const partialRepeaterUpdate = prepareRp1Commands({
    doc: store.doc,
    pageId: 'home',
    mode: 'update',
    source: `
repeater #task_rep
  :template
    row #tpl_row [fillx40]
      label #tpl_title [fillx24] "=concat('Task: ', item.title)"
`,
  });
  store.applyTransaction({ commands: partialRepeaterUpdate.commands });

  const wizEntry = [...buildNodeIndex(store.doc).byScopedId.values()].find(e => e.id === 'wiz')?.node;
  assert.equal(wizEntry.states.length, 2, 'mode:update must keep untouched #Basic state');
  const hasDescendant = (node, targetId) =>
    Boolean(node && (node.id === targetId || (node.children || []).some(c => hasDescendant(c, targetId))));
  assert.ok(
    hasDescendant(wizEntry.states.find(s => s.id === 'Advanced').root, 'adv_extra'),
    'mode:update inside :state must preserve existing children in that state'
  );

  // Scene resolution verifies segmented tab bar for panel tabs=["Basic","Advanced"] and progress-bar proportional fill
  const sceneBefore = resolveDocumentScene(store.doc);
  const homeNodesBefore = sceneBefore.pages.find(p => p.id === 'home').nodes;
  assert.ok(homeNodesBefore.some(n => n.id === 'wiz_Basic_tab_0'), 'panel tabs=[...] must inject segmented tab header');
  const fillBefore = homeNodesBefore.find(n => n.id === 'prog_bar');
  const trackBefore = homeNodesBefore.find(n => n.id === 'prog_track');
  assert.ok(fillBefore && trackBefore);
  const ratioBefore = fillBefore.w / trackBefore.w;
  assert.ok(Math.abs(ratioBefore - 0.4) < 0.05, `Expected ~40% progress width, got ${ratioBefore}`);

  // Run scenario to verify set shorthand, progress-bar reactive width, cross-page set-text, panel tab click, and goto shorthand
  const session = new StudioRuntimeSession(store.doc);
  const sim = session.runScenario([
    {
      action: 'click',
      target: 'advance_btn',
      expect: {
        variables: { progress: 80, step: 2 },
        text: { price_banner: 'Upgraded', adv_lbl: 'Advanced mode v2' },
        panelState: { wiz: 'Advanced' },
      },
    },
    {
      action: 'click',
      target: 'wiz_Advanced_tab_0',
      expect: {
        panelState: { wiz: 'Basic' },
        visible: { basic_lbl: true },
      },
    },
    {
      action: 'click',
      target: 'finish_btn',
      expect: {
        page: 'done',
        text: { done_summary: 'Completed from home' },
      },
    },
  ]);
  assert.equal(sim.ok, true, JSON.stringify(sim));
});

test('B5.3 first-class native form controls maintain 3-way parity across Studio runtime, standalone HTML export, and native .rp export', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-forms-parity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const baseDoc = createEmptyStudioDocument({ domain: 'web', name: 'FormsParity' });
  const store = new StudioDocumentStore(baseDoc);

  const formRp1 = `
vars:
  submitted = "no"
column #checkout_form [420xhug] x=24 y=24 gap=12 padding=16
  checkbox #agree [360x28] "I agree to Terms" checked=false
  radio #pay_card [360x28] "Credit Card" group="payment" checked=true
  radio #pay_wire [360x28] "Wire Transfer" group="payment" checked=false
  select #plan_sel [360x36] options=["Starter","Pro","Enterprise"] selectedIndex=0
  listbox #addons_list [360x96] options=["SSO","Audit","SLA"] multiple=true selectedIndices=[0]
  textarea #notes_box [360x80] placeholder="Deployment notes" value="Initial line"
  label #live_status [360x28] "=concat(text(widget.agree.checked), ':', widget.plan_sel.value)"
  button #quick_pro_btn [180x40] "Preset Enterprise"
    +onClick {"cases":[{"when":"=widget.pay_wire.checked","actions":[{"type":"set-check","target":"agree","checked":"toggle"},{"type":"set-option","target":"plan_sel","option":"Enterprise"},{"type":"set-var","name":"submitted","value":"wire"}]},{"else":true,"actions":[{"type":"set-var","name":"submitted","value":"card"}]}]}
`;
  const prepared = prepareRp1Commands({
    doc: store.doc,
    pageId: 'home',
    mode: 'insert',
    source: formRp1,
  });
  store.applyTransaction({ commands: prepared.commands });
  const doc = store.doc;

  // 1) Surface 1: StudioRuntimeSession + runScenario
  const session = new StudioRuntimeSession(doc, { projectDir: dir });
  const sim = session.runScenario([
    {
      action: 'assert',
      expect: {
        checked: { agree: false, pay_card: true, pay_wire: false },
        selected: { plan_sel: 'Starter', addons_list: ['SSO'] },
        text: { live_status: 'false:Starter' },
      },
    },
    {
      action: 'click',
      target: 'pay_wire',
      expect: {
        checked: { pay_card: false, pay_wire: true },
      },
    },
    {
      action: 'input',
      target: 'addons_list',
      value: ['SSO', 'SLA'],
      expect: {
        selected: { addons_list: ['SSO', 'SLA'] },
      },
    },
    {
      action: 'click',
      target: 'quick_pro_btn',
      expect: {
        checked: { agree: true },
        selected: { plan_sel: 'Enterprise' },
        variables: { submitted: 'wire' },
        text: { live_status: 'true:Enterprise' },
      },
    },
  ]);
  assert.equal(sim.ok, true, JSON.stringify(sim));

  // 2) Surface 2: Standalone HTML/CSS/JS export
  const codeDir = join(dir, 'code-out');
  const codeExport = await exportStudioDocumentToCode(doc, {
    projectDir: dir,
    outDir: codeDir,
    registerExport: false,
  });
  assert.equal(codeExport.ok, true);
  const indexHtml = readFileSync(join(codeDir, 'index.html'), 'utf8');
  assert.match(indexHtml, /<textarea\b[^>]*data-node-id="notes_box"/);
  assert.match(indexHtml, /<select\b[^>]*data-node-id="plan_sel"/);
  assert.match(indexHtml, /export-node-listbox"[^>]*data-node-id="addons_list"/);
  assert.match(indexHtml, /export-node-checkbox/);
  assert.match(indexHtml, /export-node-radio/);

  const appJs = readFileSync(join(codeDir, 'app.js'), 'utf8');
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    structuredClone,
  };
  vm.runInNewContext(appJs, sandbox);
  const app = sandbox.window.__STUDIO_EXPORT_APP__;
  assert.ok(app, 'ExportRuntimeApp must initialize');
  assert.equal(app.getWidgetState('pay_card', 'checked'), true);
  assert.equal(app.getWidgetState('pay_wire', 'checked'), false);
  assert.equal(app.getWidgetText('live_status'), 'false:Starter');
  app.click('pay_wire');
  assert.equal(app.getWidgetState('pay_card', 'checked'), false);
  assert.equal(app.getWidgetState('pay_wire', 'checked'), true);
  app.setInput('addons_list', ['SSO', 'SLA']);
  assert.deepEqual(app.getWidgetState('addons_list', 'selected'), ['SSO', 'SLA']);
  app.click('quick_pro_btn');
  assert.equal(app.getWidgetState('agree', 'checked'), true);
  assert.equal(app.getWidgetState('plan_sel', 'selected'), 'Enterprise');
  assert.equal(app.variables.submitted, 'wire');
  assert.equal(app.getWidgetText('live_status'), 'true:Enterprise');

  // 3) Surface 3: Native RP9 (.rp) export & threeZeros verification
  const outRp = join(dir, 'forms-parity.rp');
  const rpExport = await exportStudioDocumentToRp(doc, {
    projectDir: dir,
    outRpPath: outRp,
    registerExport: false,
  });
  assert.equal(rpExport.ok, true, JSON.stringify(rpExport));
  assert.equal(rpExport.report.summary.threeZerosPassed, true, JSON.stringify(rpExport.report));
  assert.equal(rpExport.report.geometryAlignment.passed99PercentWithin1Px, true, JSON.stringify(rpExport.report.geometryAlignment));
  assert.ok(
    rpExport.report.entries.some(item => item.nodeId === 'notes_box' && item.feature === 'input.multiline'),
    'textarea (input.multiline) must disclose RP9 single-line TextBox compatibility note'
  );

  // Inspect actual .rp binary via readRp to confirm genuine native Axure form widget classes!
  const rpParsed = readRp(readFileSync(outRp));
  assert.equal(rpParsed.problems.length, 0);
  const widgets = rpParsed.pages[0].widgets || [];
  const widgetTypes = new Set(widgets.map(w => w.type));
  for (const expectedClass of ['Checkbox', 'RadioButton', 'ComboBox', 'ListBox', 'TextBox']) {
    assert.ok(widgetTypes.has(expectedClass), `Native .rp must contain ${expectedClass} (got ${[...widgetTypes].join(', ')})`);
  }
});
