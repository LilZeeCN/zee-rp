#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAssemblyBridge } from './bridge.mjs';
import { readRp } from '../../scripts/rp-read.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const source = process.argv[2];
if (!source) throw new Error('Usage: node tools/native-assembly/verify.mjs <new evidence directory>');
const directory = resolve(source);
mkdirSync(directory);

function child(args, environment = process.env) {
  const proc = spawnSync(process.execPath, args, {
    cwd: root, env: environment, encoding: 'utf8', timeout: 150_000,
    maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL',
  });
  if (proc.error || proc.status !== 0) {
    throw new Error([args.join(' '), proc.error?.message, proc.stderr, proc.stdout].filter(Boolean).join('\n'));
  }
  return proc.stdout;
}

function save(name, result) {
  writeFileSync(join(directory, name + '.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const browserCheck = (...args) =>
  JSON.parse(child(['tools/native-assembly/browser-check.mjs', ...args.map(String)]));

function bridge(version, command, ...args) {
  return runAssemblyBridge({ version, command, args: args.map(String) });
}

function verifyExport(version, input, output) {
  const original = digest(input);
  const result = bridge(version, 'export', input, output);
  assert.equal(digest(input), original, 'export preserves the source RP');
  return result;
}

function editorProcesses() {
  const result = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split('\n').map(line => line.trim()).filter(line =>
    /\/Axure RP (?:9|11)\.app\/Contents\/MacOS\/Axure RP (?:9|11)$/.test(line));
}

const processesBefore = editorProcesses();
const versions = [];
for (const version of [9, 11]) {
  const blank = join(directory, `blank-${version}.rp`);
  const creation = save(`create-${version}`, bridge(version, 'create', blank));
  assert.equal(creation.counts.pages, 1);
  assert.equal(creation.counts.widgets, 0);
  const pairDir = join(directory, `pair-${version}`);
  const pair = save(`pair-${version}`, bridge(version, 'pair', pairDir, 3, 7));
  assert.deepEqual(pair.fields, [{
    key: 'MaxLength', before: { tag: 5, value: 3 }, after: { tag: 5, value: 7 },
  }]);
  assert.throws(() => bridge(version, 'create', blank), { code: 'E_ASSEMBLY_OUTPUT' });
  const tested = [];
  for (const [sample, expected] of [['before', 3], ['after', 7]]) {
    const input = join(pairDir, sample + '.rp');
    const inspected = bridge(version, 'compare', input);
    save(`model-${version}-${sample}`, inspected);
    assert.deepEqual(inspected.comparison.differences, []);
    assert.deepEqual(inspected.comparison.structuralProblems, []);
    const [widget] = inspected.rows.filter(row => row.kind === 'widget');
    assert.deepEqual(widget.values.slice(1), ['TextBox', 'Native input', '20', '20', '220', '32', String(expected)]);
    const output = join(directory, `html-${version}-${sample}`);
    save(`export-${version}-${sample}`, verifyExport(version, input, output));
    const browser = save(`browser-${version}-${sample}`, browserCheck('maxlength', output, expected));
    tested.push(browser.assertions.length);
  }
  versions.push({ version, identity: creation.identity, widgetMaxLengthAssertions: tested });
}
const blank9 = join(directory, 'blank-9.rp');
assert.throws(() => bridge(11, 'inspect', blank9), { code: 'E_ASSEMBLY_INPUT_VERSION' });

const rp1 = join(directory, 'list-detail.rp');
const generation = child(['scripts/proto.mjs', 'generate',
  '--spec', 'examples/authoring/list-detail.rp1', '--out-dir', join(directory, 'rp1-build'), '--out-rp', rp1,
], { ...process.env, AXURE_BLANK_TEMPLATE_RP9: blank9, AXURE_BLANK_TEMPLATE: '' });
writeFileSync(join(directory, 'rp1-generation.log'), generation);
const rp1Summary = readRp(readFileSync(rp1));
assert.equal(rp1Summary.counts.danglingRefs, 0);
assert.equal(rp1Summary.counts.problems, 0);
assert.equal(rp1Summary.records.unparseable, 0);
const rp1Html = join(directory, 'list-detail-html');
save('export-rp1', verifyExport(9, rp1, rp1Html));
const rp1Browser = save('browser-rp1', browserCheck('list-detail', rp1Html));

const page = rp1Summary.pages.find(page => page.name === '复习资料');
const widget = prefix => {
  const matches = page.widgets.filter(widget => widget.name.startsWith(prefix));
  assert.equal(matches.length, 1, prefix);
  return matches[0].name;
};
const panelName = widget('panel-resourcesPanel-');
const startRp = join(directory, 'timer-start.rp');
const timerRp = join(directory, 'timer.rp');
function action(input, output, owner, event, type, ...properties) {
  child(['bin/axure.mjs', 'add-interaction', input, output, owner, '--on-page', page.name,
    '--replace-event', '--event', event, '--action', type, `target=${panelName}`, ...properties]);
}
action(rp1, startRp, widget('btn-clear-'), 'OnClick', 'set-panel-state',
  'state=next', 'loop=true', 'repeat=true', 'repeatInterval=450', 'repeatSkipFirst=true');
action(startRp, timerRp, widget('btn-restore-'), 'OnClick', 'set-panel-state', 'state=current');
const timerHtml = join(directory, 'timer-html');
save('export-timer', verifyExport(9, timerRp, timerHtml));
const timerBrowser = save('browser-timer', browserCheck('timer', timerHtml));

const gestures = [];
for (const axis of ['x', 'y']) {
  const first = join(directory, `drag-${axis}-start.rp`);
  const input = join(directory, `drag-${axis}.rp`);
  const output = join(directory, `drag-${axis}-html`);
  action(rp1, first, panelName, 'OnDrag', 'move', `mode=drag-${axis}`);
  action(first, input, panelName, 'OnDragDrop', 'move', 'mode=locationBeforeDrag', 'duration=0');
  save(`export-drag-${axis}`, verifyExport(9, input, output));
  gestures.push(save(`browser-drag-${axis}`, browserCheck('drag', output, axis)));
}

const swipeStart = join(directory, 'swipe-start.rp');
const swipeRp = join(directory, 'swipe.rp');
const swipeHtml = join(directory, 'swipe-html');
action(rp1, swipeStart, panelName, 'OnSwipeLeft', 'set-panel-state',
  'state=empty', 'enterAnimation=slideLeft', 'enterDuration=120');
action(swipeStart, swipeRp, panelName, 'OnSwipeRight', 'set-panel-state',
  'state=ready', 'enterAnimation=slideRight', 'enterDuration=120');
save('export-swipe', verifyExport(9, swipeRp, swipeHtml));
gestures.push(save('browser-swipe', browserCheck('swipe', swipeHtml)));

console.log(JSON.stringify(save('summary', {
  versions,
  rp1: { ...rp1Summary.counts, browserAssertions: rp1Browser.assertions },
  timer: timerBrowser.assertions,
  gestures,
  editorProcesses: { before: processesBefore, after: editorProcesses() },
}), null, 2));
