import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { listCustomStyles } from '../scripts/custom-styles.mjs';
import { field, parsePayload, walkNodes } from '../scripts/parse-payload.mjs';
import { readManifest, readRecords } from '../scripts/rp-records.mjs';
import { readRp } from '../scripts/rp-read.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const assertBlank = (bytes, version, name) => {
  const result = readRp(bytes);
  assert.equal(result.version, version);
  assert.deepEqual(result.pages.map(page => page.name), [name]);
  assert.equal(result.records.unparseable, 0);
  for (const key of ['widgets', 'danglingRefs', 'sentinelSlotsNonZero', 'problems']) assert.equal(result.counts[key], 0);
  return result;
};

test('RP9 and RP11 emit fresh native identities and carry no embedded source assets', () => {
  for (const version of [9, 11]) {
    const first = synthesizeBlankProject({ version, pageName: '空白🧪' });
    const second = synthesizeBlankProject({ version, pageName: '空白🧪' });
    const a = assertBlank(first, version, '空白🧪');
    const b = assertBlank(second, version, '空白🧪');
    const packageGuids = index => index.packages.map(item => item.guid);
    assert(!packageGuids(a).some(guid => packageGuids(b).includes(guid)));
    const { dataStart, value } = readManifest(first);
    const thumb = Object.values(value.root.children).find(entry => entry.parts.thumbnail !== undefined).parts.thumbnail;
    assert.equal(first.subarray(dataStart + thumb + 8, dataStart + thumb + 16).toString('hex'), '89504e470d0a1a0a');
    for (const record of readRecords(first).filter(record => record.strings)) {
      walkNodes(parsePayload(record).roots, node => assert.notEqual(node.tag, 4, 'no binary template assets'));
    }
    const doc = readRecords(first).find(record => record.className === 'Axure:DesignDocument');
    const graph = parsePayload(doc);
    const defaultStyle = [...graph.objects.values()].find(object => object.className === 'Axure:Style');
    assert(field(defaultStyle.body, 'PropList').items.length >= 49, 'writers reuse native unchecked defaults');
  }
});

test('each synthesized document declares both version histories and a loadable version part', () => {
  for (const { version, build, revision } of [{ version: 9, build: 1, revision: 3754 }, { version: 11, build: 0, revision: 4137 }]) {
    const file = synthesizeBlankProject({ version });
    const { dataStart, value } = readManifest(file);
    const records = readRecords(file);
    const versionPart = records.find(record => record.offset === dataStart + value.root.parts[`${version}.0.0.${revision}.version`] + 8);
    assert.equal(versionPart?.className, 'xml:BreakingChanges');
    assert.match(versionPart.raw.toString(), new RegExp(`<Version>${version}\\.0\\.0\\.0</Version>`));
    const settings = records.find(record => record.offset === dataStart + value.root.parts.DocumentSettings + 8);
    assert.equal(settings?.className, 'Axure:DocumentSettings');
    const graph = parsePayload(settings);
    const body = graph.objects.get(1).body;
    const history = name => field(body, name).items.map(item => ['Major', 'Minor', 'Build', 'Revision'].map(key => field(item, key).value));
    assert.deepEqual(history('FileVersionHistory'), [[version, 0, build, 0]]);
    assert.deepEqual(history('AssemblyVersionHistory'), [[version, 0, 0, revision]]);
    const page = records.find(record => record.className === 'Axure:Page');
    assert.equal(graph.roots[0].values[field(body, 'selected-tab-package-id').value - 1], parsePayload(page).roots[0].values[1]);
  }
});

test('both blank project versions expose the nine native presets with their active properties', () => {
  const labels = ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6',
    'Paragraph', 'Form Hint', 'Form Disabled'];
  for (const version of [9, 11]) {
    const file = synthesizeBlankProject({ version });
    const styles = listCustomStyles(file);
    assert.deepEqual(styles.map(style => style.name), labels);
    assert.equal(new Set(styles.map(style => style.guid)).size, labels.length);
    const record = readRecords(file).find(item => item.className === 'Axure:DesignDocument');
    const graph = parsePayload(record);
    const presets = labels.map(label => [...graph.objects.values()].find(object =>
      object.className === 'Axure:Style' && field(object.body, 'style-name').text === label));
    const active = (style, property) => field(style.body, 'PropList').items.find(item =>
      field(item, 'DOAName').value === 0xc0000000 + property);
    const headingSizes = presets.slice(0, 6).map(style => {
      assert.equal(field(active(style, 3), 'Value').value, 1);
      return active(style, 2) ? field(active(style, 2), 'Value').value : null;
    });
    assert.deepEqual(headingSizes, [24, 18, 13.5, 10.5, null, 7.5]);
    for (const [index, key, color] of [[6, 7, 0x00ffffff], [7, 6, 0xff999999], [8, 7, 0xfff0f0f0]]) {
      assert.equal(field(field(active(presets[index], key), 'Value'), 'fill-color').value, color);
    }
    assert.equal(active(presets[6], 3), undefined);
    assert.equal(active(presets[7], 7), undefined);
  }
});

test('the public command synthesizes without installed templates and keeps explicit templates strict', t => {
  const work = mkdtempSync(join(tmpdir(), 'zee-blank-synth-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const preload = join(work, 'hide-installed-templates.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const exists = fs.existsSync;
    fs.existsSync = path => /(?:^|[\\\\/])axure-rp(?:9|11)-blank\\.rp$/.test(String(path)) ? false : exists(path);
    require('node:module').syncBuiltinESMExports();
  `);
  const env = { ...process.env };
  for (const name of ['AXURE_BLANK_TEMPLATE', 'AXURE_BLANK_TEMPLATE_RP9', 'AXURE_BLANK_TEMPLATE_RP11']) delete env[name];
  const cli = (args, overrides = {}) => spawnSync(process.execPath, ['--require', preload, join(root, 'bin/axure.mjs'), ...args], {
    cwd: work, encoding: 'utf8', env: { ...env, ...overrides },
  });
  // Preload applies to the registered CLI script as well as the dispatcher.
  env.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`;
  for (const version of [9, 11]) {
    const file = join(work, `offline-${version}.rp`);
    const made = cli(['create-blank-project', file, '--version', String(version)]);
    assert.equal(made.status, 0, made.stderr);
    assert.equal(JSON.parse(made.stdout).templateSource, 'synthesized');
    assertBlank(readFileSync(file), version, 'Page 1');

    const extra = join(work, `with-second-page-${version}.rp`);
    const added = cli(['create-blank-page', file, extra, '第二页']);
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(readRp(readFileSync(extra)).pages.map(page => page.name), ['Page 1', '第二页']);

    const usingTemplate = join(work, `explicit-${version}.rp`);
    const explicit = cli(['create-blank-project', usingTemplate, '--version', String(version)], { AXURE_BLANK_TEMPLATE: file });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(readFileSync(usingTemplate), readFileSync(file));
    const rejected = join(work, `rejected-${version}.rp`);
    assert.notEqual(cli(['create-blank-project', rejected, '--version', String(version)], {
      AXURE_BLANK_TEMPLATE: join(work, 'missing.rp'),
    }).status, 0);
    assert.equal(existsSync(rejected), false);
  }
  const doctor = cli(['doctor', '--json']);
  assert.equal(JSON.parse(doctor.stdout).checks.axureTemplate.source, 'synthesized');
});
