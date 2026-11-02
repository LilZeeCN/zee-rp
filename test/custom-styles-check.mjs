// Synthetic serialization only: no Axure files or vendor style definitions shipped.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeManifest, readRecords } from '../scripts/rp-records.mjs';
import { encodePayload, parsePayload, field, walkNodes } from '../scripts/parse-payload.mjs';
import { listCustomStyles, renameCustomStyle, rebindWidgets, widgetSelector } from '../scripts/custom-styles.mjs';
import { listMcpTools, validateInput } from '../scripts/mcp-tools.mjs';

const A = '11'.repeat(16), B = '22'.repeat(16), LIB = '33'.repeat(16), OTHER = '44'.repeat(16);
function record(owner, doc = false, external = false) {
  const strings = [owner], pool = doc ? [LIB, A, B, OTHER] : [OTHER, B, LIB, A];
  const s = text => { let i = strings.indexOf(text); if (i < 0) { i = strings.length; strings.push(text); } return { tag: 8, value: i + 1, text }; };
  const g = text => ({ tag: 17, value: pool.indexOf(text) + 1 });
  const ref = value => ({ tag: 3, value });
  const num = value => ({ tag: 5, value });
  const list = items => ({ tag: 2, items });
  const map = obj => ({ tag: 1, entries: Object.entries(obj).map(([key, value]) => [s(key), value]) });
  const obj = (id, className, value) => ({ tag: 9, id, className, classIndex: s(className).value, body: map(value) });
  const prop = (id, value) => map({ DOAName: num(0xc0000000 + id), Value: value });
  const info = () => map({ LibraryId: g(external ? OTHER : LIB), LibraryName: s('Native'), Id: g(A), Name: s('Style_A') });
  const style = (id, name, guid) => obj(id, 'Axure:Style', { LibraryId: g(LIB), LibraryName: s('Native'), Id: g(guid), 'style-name': s(name), PropList: list([prop(7, num(123))]), Capabilities: { tag: 29, value: 'ffffffffffffffff' }, All: { tag: 25, value: true } });
  const roots = doc ? [
    obj(1, owner, { StyleSheet: ref(2) }),
    obj(2, 'Axure:StyleSheet', { CustomStyles: list([ref(3), ref(4)]), DefaultStyle: ref(4) }),
    style(3, 'Style_A', A), style(4, 'Style_B', B),
  ] : [
    obj(1, owner, { StyleCache: map({ Styles: list([map({ Info: info(), Props: list([]) })]) }) }),
    obj(2, 'Axure:DiagramObject:VectorShape', { 'name-block': map({ text: s('Style_A') }), MyStyle: ref(3), InteractionMap: ref(4) }),
    obj(3, 'Axure:Style', { Id: g(OTHER), 'style-name': s('MyStyle'), MatchInfo: info(), PropList: list([prop(0, g(A)), prop(101, num(40)), prop(105, num(80)), prop(7, num(789)), prop(27, s('image-bytes'))]), Capabilities: { tag: 29, value: 'bfff77ff7ffbed32' } }),
    obj(4, 'Axure:InteractionTreeMap', { marker: s('Style_A') }),
  ];
  roots.push({ tag: 30, values: pool });
  const header = Buffer.alloc(32); header.writeUInt32LE(0xc351, 20); header.writeUInt32LE(strings.length, 28);
  const raw = Buffer.concat([header, ...strings.flatMap(text => { const b = Buffer.from(text), size = Buffer.alloc(4); size.writeUInt32LE(b.length); return [size, b]; }), encodePayload(roots)]);
  const data = gzipSync(raw), prefix = Buffer.alloc(8); prefix.writeUInt32LE(data.length, 4);
  return Buffer.concat([prefix, data]);
}
function fixture(rp = false) {
  const records = [record('Axure:Page'), record('Axure:Master'), record('Axure:PanelState'), record('Axure:Page', false, true), record('Axure:DesignDocument', true)];
  if (!rp) return Buffer.concat(records);
  const header = Buffer.from('acef090000000000', 'hex'), children = {};
  let offset = 0;
  records.forEach((r, i) => { children[`synthetic-package-${i}`] = { parts: { package: offset } }; offset += r.length; });
  return Buffer.concat([encodeManifest(header, { root: { children } }), ...records]);
}
function graph(file, index) { return parsePayload(readRecords(file)[index]); }
const checks = [];
function check(name, fn) { fn(); checks.push(name); console.log('PASS', name); }
for (const rp of [false, true]) {
  const source = fixture(rp), original = Buffer.from(source);
  check(`${rp ? 'RP' : 'RPLIB'} rename cascades by GUID and library, preserving unrelated names/identities`, () => {
    const result = renameCustomStyle(source, 'Style_A', '新样式_测试');
    assert.equal(result.references, 6); assert.deepEqual(result.changedRecords, [0, 1, 2, 4]);
    assert.equal(listCustomStyles(result.file)[0].name, '新样式_测试');
    for (let i = 0; i < 3; i++) {
      const before = graph(source, i), after = graph(result.file, i);
      assert.deepEqual([...after.objects.keys()], [...before.objects.keys()]);
      assert.equal(field(field(after.objects.get(3).body, 'MatchInfo'), 'Name').text, '新样式_测试');
      assert.equal(field(field(after.objects.get(2).body, 'name-block'), 'text').text, 'Style_A');
      assert.deepEqual(encodePayload([field(after.objects.get(3).body, 'PropList')]), encodePayload([field(before.objects.get(3).body, 'PropList')]));
      const strings = readRecords(result.file)[i].strings;
      walkNodes(after.roots, n => { if (n.tag === 8) assert.equal(strings[n.value - 1], n.text); });
    }
    assert.deepEqual(readRecords(result.file)[3].raw, readRecords(source)[3].raw);
    assert.deepEqual(renameCustomStyle(result.file, '新样式_测试', '新样式_测试').file, result.file);
    assert.deepEqual(source, original);
  });
  check(`${rp ? 'RP' : 'RPLIB'} rebind changes base GUID and cache, preserving geometry/events/local overrides`, () => {
    const result = rebindWidgets(source, B, widgetSelector({ all: true }));
    assert.equal(result.applied.length, 4);
    for (let i = 0; i < 4; i++) {
      const before = graph(source, i), after = graph(result.file, i), style = after.objects.get(3);
      const info = field(style.body, 'MatchInfo'), pool = after.roots.find(n => n.tag === 30).values;
      assert.equal(field(info, 'Name').text, 'Style_B');
      assert.equal(field(style.body, 'All').value, false);
      assert.equal(pool[field(info, 'Id').value - 1], B);
      const props = field(style.body, 'PropList').items;
      const prop = id => field(props.find(p => (field(p, 'DOAName').value & 0x3fffffff) === id), 'Value');
      assert.equal(pool[prop(0).value - 1], B);
      assert.equal(prop(101).value, 40); assert.equal(prop(105).value, 80); assert.equal(prop(7).value, 789);
      assert.deepEqual(before.objects.get(2).id, after.objects.get(2).id);
      assert.deepEqual(encodePayload([field(before.objects.get(2).body, 'InteractionMap')]), encodePayload([field(after.objects.get(2).body, 'InteractionMap')]));
      const cache = field(field(after.objects.get(1).body, 'StyleCache'), 'Styles').items;
      assert.equal(cache.length, 2); assert.equal(field(field(cache[1], 'Info'), 'Name').text, 'Style_B');
    }
    assert.deepEqual(readRecords(result.file).at(-1).raw, readRecords(source).at(-1).raw);
    assert.deepEqual(source, original);
  });
  check(`${rp ? 'RP' : 'RPLIB'} explicit override reset keeps geometry and image content`, () => {
    const result = rebindWidgets(source, B, widgetSelector({ record: 1, name: 'Style_A' }), { resetOverrides: true });
    assert.equal(result.applied.length, 1);
    const props = field(graph(result.file, 1).objects.get(3).body, 'PropList').items;
    assert.deepEqual(props.map(p => field(p, 'DOAName').value & 0x3fffffff), [101, 105, 27, 0]);
    assert.deepEqual(readRecords(result.file)[0].raw, readRecords(source)[0].raw);
  });
}
check('invalid names, collisions, GUIDs and selectors fail before mutation', () => {
  const file = fixture();
  for (const name of ['', ' ', null]) assert.throws(() => renameCustomStyle(file, 'Style_A', name));
  assert.throws(() => renameCustomStyle(file, 'Style_A', 'style_b'), /already exists/);
  assert.throws(() => renameCustomStyle(file, 'Missing', 'x'), /found 0/);
  assert.throws(() => rebindWidgets(file, 'bad', () => true), /GUID/);
  assert.throws(() => rebindWidgets(file, OTHER, () => true), /found 0/);
  assert.throws(() => rebindWidgets(file, B), /predicate/);
  for (const selector of [{}, { typo: 'x' }, { all: false }, { record: '1' }, { all: true, name: 'x' }]) assert.throws(() => widgetSelector(selector));
  assert.deepEqual(rebindWidgets(file, B, widgetSelector({ name: 'Missing' })).file, file);
});
check('CLI writes a new file, refuses collisions, and MCP schemas expose named arguments', () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-style-'));
  try {
    const input = join(work, 'input.rplib'), output = join(work, 'renamed.rplib'), failed = join(work, 'failed.rplib');
    writeFileSync(input, fixture());
    const run = args => spawnSync(process.execPath, ['bin/axure.mjs', ...args], { encoding: 'utf8' });
    assert.equal(run(['rename-custom-style', input, output, 'Style_A', 'Style_C']).status, 0);
    assert.equal(listCustomStyles(readFileSync(output))[0].name, 'Style_C');
    assert.notEqual(run(['rename-custom-style', input, output, 'Style_A', 'Style_D']).status, 0);
    assert.notEqual(run(['rename-custom-style', input, failed, 'Style_A', 'Style_B']).status, 0);
    assert.equal(existsSync(failed), false);
    const selector = join(work, 'selector.json'); writeFileSync(selector, '{"record":0}');
    assert.equal(run(['rebind-widgets', input, join(work, 'bound.rplib'), B, selector, '--reset-overrides']).status, 0);
    const tools = listMcpTools();
    validateInput(tools.find(t => t.name === 'rename_custom_style').inputSchema, { source: input, output, oldName: 'Style_A', newName: 'Style_C' });
    validateInput(tools.find(t => t.name === 'rebind_widgets').inputSchema, { source: input, output, styleGuid: B, selector, resetOverrides: true });
    assert.equal(tools.find(t => t.name === 'list_custom_styles').annotations.readOnlyHint, true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
console.log(JSON.stringify({ total: checks.length, passed: checks.length }));
