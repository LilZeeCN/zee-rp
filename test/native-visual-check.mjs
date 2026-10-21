import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInteractiveRp } from '../scripts/proto.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'rp-visual-check-'));
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log('PASS', label); };
try {
  const compiler = process.argv[2] ?? join(root, 'scripts/proto.py');
  const run = spawnSync('python3', [compiler, 'compile', '--spec', join(root, 'test/fixtures/rp-native-visual.json'), '--out-dir', work], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(root, 'scripts') },
  });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(readFileSync(join(work, 'compile-plan.json')));
  const page = plan.pages[0];
  check('native input keeps independent placeholder and requested text style', () => {
    assert.equal(page.nativeInputs[0].placeholder, '独立提示');
    assert.deepEqual(page.nativeInputs[0].style, { fontSize: 16, fontWeight: 700, color: '#173A63', align: 'left', textPaddingX: 12 });
  });
  check('repeater and panel scenes have no rectangular canvas under rounded content', () => {
    for (const scene of [page.repeaters[0].item.axvgPath, page.dynamicPanels[0].states[0].axvgPath])
      assert.equal(JSON.parse(readFileSync(scene)).scene.items[0].backgroundShape, null);
    assert(JSON.parse(readFileSync(page.mainAxvgPath)).scene.items[0].backgroundShape);
  });
  const out = join(work, 'native.rp');
  const report = buildInteractiveRp(join(work, 'compile-plan.json'), out);
  const graphs = readRecords(readFileSync(out)).filter(r => ['Axure:Page', 'Axure:PanelState'].includes(r.className)).map(parsePayload);
  const inputs = graphs.flatMap(g => [...g.objects.values()].filter(o => o.className === 'Axure:DiagramObject:TextBox').map(o => ({ o, g })));
  check('root and panel inputs remain editable TextBoxes with complete event mapping', () => {
    assert.equal(inputs.length, 2);
    assert.equal(report.eventCoverage.declared, report.eventCoverage.materialized);
    assert.deepEqual(report.threeZeros, { danglingRefs: 0, sentinelSlotsNonZero: 0, problems: 0 });
  });
  check('native font units, fill transparency, padding and placeholder survive serialization', () => {
    const { o, g } = inputs.find(({ o }) => field(o.body, 'PlaceholderText')?.text === '独立提示');
    const props = field(g.objects.get(field(o.body, 'MyStyle').value).body, 'PropList').items;
    const prop = key => field(props.find(p => (field(p, 'DOAName').value & 0x3fffffff) === key), 'Value');
    assert.equal(prop(1).text, 'Inter'); assert.equal(prop(2).value, 12); assert.equal(prop(1001).value, 700);
    assert.equal(field(prop(6), 'fill-color').value, 0xff173a63);
    assert.equal(field(prop(7), 'fill-color').value, 0); assert.equal(prop(15).value, 0);
    assert.equal(prop(11).value, 12); assert.equal(prop(13).value, 12);
  });
  console.log(`${checks}/${checks} native visual contracts passed`);
} finally { rmSync(work, { recursive: true, force: true }); }
