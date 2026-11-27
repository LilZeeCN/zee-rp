import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
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
