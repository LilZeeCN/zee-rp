import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNativeDemo } from '../examples/build-native-demo.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { setWidgetRichText } from '../scripts/set-widget-richtext.mjs';
import { callCommandTool } from '../scripts/mcp-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'zee-rp-native-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
function check(name, action) {
  try { action(); results.push({ name, passed: true }); console.log(`PASS  ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL  ${name} — ${error.message}`); }
}
function cli(args) {
  const result = spawnSync(process.execPath, [join(root, 'bin/axure.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result;
}
const pageGraph = bytes => parsePayload(readRecords(bytes).find(r => r.className === 'Axure:Page'));
function healthy(bytes) {
  const rp = readRp(bytes);
  assert.equal(rp.records.unparseable, 0); assert.equal(rp.counts.danglingRefs, 0); assert.equal(rp.counts.problems, 0);
  return rp;
}
try {
  // Missing native prerequisites fail the command; they never count as passing tests.
  const demo = buildNativeDemo(join(work, 'demo'));
  const source = join(demo.output, demo.source), bytes = readFileSync(source), before = sha(bytes);
  const page = demo.page;
  check('public recipe generates native widgets and a table', () => {
    assert.deepEqual(healthy(bytes).pages[0].widgets.map(w => w.name), demo.widgets);
    assert.ok(healthy(readFileSync(join(demo.output, demo.table))).pages[0].widgets.some(w => w.type === 'Table'));
  });
  check('nested BinaryExpr and multi-argument FCall preserve semantic structure', () => {
    const result = addInteractions(bytes, 'SubmitButton', [{ event: 'OnClick', cases: [{
      when: { op: '&&', left: {fn:'ValueContains',args:[{value:'alphabet'},{value:'pha'}]},
        right: {op:'==',left:{fn:'ToLowerCase',args:[{value:'HELLO'}]},right:{value:'hello'}} },
      actions: [{type:'wait',ms:1}] }] }], { replaceEvent: true });
    healthy(result.file);
    const graph = pageGraph(result.file);
    assert.ok([...graph.objects.values()].some(o => o.className === 'Axure:Expr:BinaryExpr' && field(o.body, 'operation').value === 1));
    const call = [...graph.objects.values()].find(o => o.className === 'Axure:Expr:FCall' && field(o.body, 'function-name').text === 'ValueContains');
    assert.equal(field(call.body, 'args').items.length, 2);
  });
  check('unknown FCall and incomplete nested expressions are rejected', () => {
    const action = when => addInteractions(bytes, 'SubmitButton', [{event:'OnClick',cases:[{when,actions:[{type:'wait',ms:1}]}]}]);
    assert.throws(() => action({op:'==',left:{fn:'MadeUpFunction',args:[]},right:{value:'x'}}), /Unknown FCall/);
    assert.throws(() => action({op:'&&',left:{op:'==',left:{value:'true'}},right:{value:'true'}}), /both left and right/);
  });
  check('README text and rich-text CLI recipes produce the requested native content', () => {
    const textOut = join(work, 'text.rp');
    cli(['set-widget-text', source, textOut, page, 'SubmitButton', 'Confirm & Proceed']);
    assert.equal(healthy(readFileSync(textOut)).pages[0].widgets.find(w => w.name === 'SubmitButton').text, 'Confirm & Proceed');
    const spec = JSON.parse(readFileSync(join(root, 'examples/richtext.json'))); spec.page = page;
    const specPath = join(work, 'richtext.json'); writeFileSync(specPath, JSON.stringify(spec));
    const richOut = join(work, 'rich.rp'); cli(['set-widget-richtext', source, richOut, specPath]);
    const rich = readFileSync(richOut), rp = healthy(rich), graph = pageGraph(rich);
    const widget = rp.pages[0].widgets.find(w => w.name === 'StatusBanner');
    assert.equal(widget.text, 'Notice: Documentation');
    const paragraphs = field(field(field(graph.objects.get(widget.id).body, 'RichTextBlock'), 'attributed-string'), 'Paragraphs').items;
    assert.equal(field(paragraphs[0], 'LineSpacing').value, 72);
    assert.equal(field(field(paragraphs[0], 'ListInfo'), 'ListType').value, 1);
    assert.ok([...graph.objects.values()].some(o => o.className === 'Axure:DiagramObject:Hyperlink'));
  });
  check('MCP rich-text named fields create hyperlinks, lists, and line spacing', () => {
    const spec = JSON.parse(readFileSync(join(root, 'examples/richtext.json')));
    const opened = callCommandTool('axure_open', {path:source});
    assert.ok(!opened.isError, opened.content[0].text);
    const result = callCommandTool('edit_text', {target:{page,name:'StatusBanner'},richRuns:spec.paragraphs});
    assert.ok(!result.isError, result.content[0].text);
    const rich = readFileSync(JSON.parse(result.content[0].text).chainTail); healthy(rich);
    assert.ok([...pageGraph(rich).objects.values()].some(o => o.className === 'Axure:DiagramObject:Hyperlink'));
  });
  check('table multi-run cells retain text and style instead of object coercion', () => {
    const output = join(work, 'table.rp');
    cli(['set-native-table', join(demo.output, demo.table), output, join(root, 'examples/table.json')]);
    const tableBytes = readFileSync(output); healthy(tableBytes);
    const graph = pageGraph(tableBytes), table = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:Table');
    const cell = graph.objects.get(field(table.body, 'cells').items[0].value);
    const runs = field(field(field(cell.body, 'RichTextBlock'), 'attributed-string'), 'Paragraphs').items.flatMap(p => field(p, 'Inlines').items);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(r => field(r, 'Text').text), ['H ', '1']);
    assert.ok(!tableBytes.includes(Buffer.from('[object Object]')));
  });
  check('README interaction flags write a widget click action on the selected page', () => {
    const output = join(work, 'click.rp');
    cli(['add-interaction', source, output, 'SubmitButton', '--on-page', page, '--event', 'OnClick', '--action', 'wait', 'ms=100']);
    const rp = healthy(readFileSync(output));
    assert.equal(rp.counts.actions, 1);
    assert.equal(rp.pages[0].widgets.find(w => w.name === 'SubmitButton').interactions.length, 1);
  });
  check('global-variable CLI and MCP defaults persist and duplicates are rejected', () => {
    const output = join(work, 'variable.rp'); cli(['create-global-variable', source, output, 'Counter', '--default-value', '7']);
    const rp = healthy(readFileSync(output));
    assert.ok(rp.globalVariables.some(v => v.name === 'Counter' && v.value === '7'));
    const second = join(work, 'mcp-variable.rp');
    const result = callCommandTool('create_global_variable', {source, output:second, name:'McpCounter', defaultValue:'9'});
    assert.ok(!result.isError, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).exitCode, 0, result.content[0].text);
    assert.ok(healthy(readFileSync(second)).globalVariables.some(v => v.name === 'McpCounter' && v.value === '9'));
    const rejected = spawnSync(process.execPath, [join(root, 'bin/axure.mjs'), 'create-global-variable', output, join(work,'duplicate.rp'), 'Counter']);
    assert.notEqual(rejected.status, 0);
  });
  check('duplicate-page preserves widgets and isolates native GUIDs', () => {
    const output = join(work, 'pages.rp'); cli(['duplicate-page', source, output, page, 'Page Copy']);
    const rp = healthy(readFileSync(output)); assert.equal(rp.pages.length, 2);
    assert.equal(rp.pages.find(p => p.name === 'Page Copy').widgets.length, 5);
    assert.notEqual(rp.pages[0].record, rp.pages[1].record);
    const pageIdentities = rp.packages.filter(p => p.className === 'Axure:Page').map(p => p.guid);
    assert.equal(pageIdentities.length, 2);
    assert.equal(new Set(pageIdentities).size, pageIdentities.length);
  });
  check('invalid rich-text parameters fail and original native source remains unchanged', () => {
    assert.throws(() => setWidgetRichText(bytes, {page,widget:'StatusBanner',paragraphs:[{lineSpacing:-1,runs:[{text:'bad'}]}]}), /lineSpacing/);
    assert.equal(sha(readFileSync(source)), before);
  });
} finally { rmSync(work, { recursive: true, force: true }); }
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ evidence:'offline-only', total:results.length, passed:results.length-failed, failed }));
process.exitCode = failed ? 1 : 0;
