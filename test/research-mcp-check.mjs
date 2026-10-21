import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { commitChainNode, openSession } from '../scripts/mcp-tools.mjs';

let Client, StdioClientTransport;
try {
  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
} catch (err) {
  if (process.argv.includes('--allow-missing-sdk') || process.env.AXURE_ALLOW_MISSING_SDK === '1') {
    console.log('SKIP  mcp-check.mjs: 未检测到 @modelcontextprotocol/sdk（当前处于无 node_modules 副本目录），已按预期跳过');
    process.exit(0);
  }
  console.error('[MCP-CHECK DIAGNOSTIC] 无法加载 @modelcontextprotocol/sdk。若在 /tmp 等无 node_modules 副本中运行，请先执行 `npm install` 或传入 `--allow-missing-sdk`。原始错误:', err.message);
  process.exit(1);
}


const skill = dirname(dirname(fileURLToPath(import.meta.url)));
const serverRoot = process.env.AXURE_MCP_TEST_ROOT ?? skill;
const work = mkdtempSync(join(tmpdir(), 'axure-mcp-check-'));
const fixture = name => join(process.env.AXURE_FIXTURE_ROOT || join(skill, 'test/fixtures'), name);
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
env.AXURE_WRITE_ROOT = work;
const transport = new StdioClientTransport({ command: process.execPath, args: [join(serverRoot, 'bin/mcp.mjs')], env, stderr: 'pipe' });
const client = new Client({ name: 'axure-mcp-check', version: '1.0.0' });
const results = [];
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); console.log(`PASS  ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL  ${name} — ${error.message}`); }
};
const call = (name, args) => client.callTool({ name, arguments: args });
const protectedPath = '/zee-rp-test-protected/final.rp';
env.AXURE_PROTECTED_PATHS = protectedPath;
process.env.AXURE_PROTECTED_PATHS = protectedPath;

try {
  await client.connect(transport);
  await check('stdio 初始化与注册表 30 命令', async () => {
    const { tools } = await client.listTools();
    // 会话层 8 个意图工具加入 listMcpTools 后，本断言的排除集同步扩展；30 命令工具数本身不变。
    const sessionNames = new Set(['axure_open', 'axure_state', 'axure_save', 'locate', 'inspect', 'read_interactions', 'edit_text', 'verify']);
    assert.equal(tools.filter(t => !t.name.startsWith('jobs_') && t.name !== 'gui_roundtrip' && !sessionNames.has(t.name)).length, 31);
    for (const name of ['rp_read', 'add_interaction', 'fill_panel_state', 'set_widget_text']) {
      const schema = tools.find(t => t.name === name).inputSchema;
      assert.equal(schema.oneOf.length, 2);
      for (const branch of schema.oneOf) assert.equal(branch.additionalProperties, false);
    }
  });
  await check('rp_read 实际调用', async () => {
    const r = await call('rp_read', { file: fixture('blank-ui-native.rp') }); assert.ok(!r.isError);
    const output = JSON.parse(r.content[0].text); assert.equal(output.exitCode, 0);
    assert.equal(JSON.parse(output.stdout).counts.widgets, 0);
  });
  await check('set_widget_text 具名参数写入', async () => {
    const output = join(work, 'text.rp');
    const r = await call('set_widget_text', { source: fixture('var-set-counter-roundtrip.rp'), output, page: 'Page 1', widget: 'VALUE_PREVIEW', text: 'MCP_VERIFIED' });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(readRp(readFileSync(output)).pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'MCP_VERIFIED');
  });
  await check('add_interaction 具名参数追加动作', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'interaction.rp');
    const before = readRp(readFileSync(source)).counts.actions;
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'wait', parameters: ['ms=1'] });
    assert.ok(!r.isError, r.content[0].text); assert.equal(readRp(readFileSync(output)).counts.actions, before + 1);
  });
  await check('add_interaction MCP writes apply-style fontSize to native property ID 2', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-font-size.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'fontSize=28'], replaceEvent: true });
    assert.ok(!r.isError, r.content[0].text);
    const bytes = readFileSync(output), rp = readRp(bytes);
    assert.equal(rp.counts.problems, 0);
    const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const properties = field(style.body, 'PropList').items;
    const fontSize = properties.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 2);
    assert.equal(field(fontSize, 'DOAName').value, 0xc0000002);
    assert.equal(field(fontSize, 'Value').value, 21);
    assert.match(rp.pages[0].widgets.find(widget => widget.name === 'SET_BUTTON').interactions[0].cases[0].actions[0].human, /VALUE_PREVIEW/);
  });
  await check('add_interaction MCP writes apply-style fontFamily to native property ID 1', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-font-family.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'fontFamily=Courier New'], replaceEvent: true });
    assert.ok(!r.isError, r.content[0].text);
    const bytes = readFileSync(output), rp = readRp(bytes);
    assert.equal(rp.counts.problems, 0);
    const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const properties = field(style.body, 'PropList').items;
    const font = properties.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 1);
    assert.equal(field(font, 'DOAName').value, 0xc0000001);
    assert.equal(field(font, 'Value').text, 'Courier New');
  });
  await check('add_interaction MCP writes apply-style textColor to native property ID 6', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-text-color.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'textColor=#D72638'], replaceEvent: true });
    assert.ok(!r.isError, r.content[0].text);
    const bytes = readFileSync(output), rp = readRp(bytes);
    assert.equal(rp.counts.problems, 0);
    const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const properties = field(style.body, 'PropList').items;
    const textColor = properties.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 6);
    assert.equal(field(textColor, 'DOAName').value, 0xc0000006);
    assert.equal(field(field(textColor, 'Value'), 'fill-color').value, 0xffd72638);
  });
  await check('add_interaction MCP writes apply-style bold to native property ID 3', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-bold.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'bold=true'], replaceEvent: true });
    assert.ok(!r.isError, r.content[0].text);
    const bytes = readFileSync(output), rp = readRp(bytes);
    assert.equal(rp.counts.problems, 0);
    const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const bold = field(style.body, 'PropList').items.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 3);
    assert.equal(field(bold, 'DOAName').value, 0xc0000003);
    assert.equal(field(bold, 'Value').value, 0);
  });
  await check('add_interaction MCP writes apply-style bold=false to the native unchecked value', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-bold-false.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'bold=false'], replaceEvent: true });
    assert.ok(!r.isError, r.content[0].text);
    const bytes = readFileSync(output), rp = readRp(bytes);
    assert.equal(rp.counts.problems, 0);
    const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const bold = field(style.body, 'PropList').items.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 3);
    assert.equal(field(bold, 'DOAName').value, 0xc0000003);
    assert.equal(field(bold, 'Value').value, 2);
    assert.equal(field(info.body, 'clear-previous').value, false);
  });
  await check('add_interaction MCP rejects apply-style italic=true without runtime effect', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-italic.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'italic=true'], replaceEvent: true });
    assert.ok(r.isError, r.content[0].text);
    assert.match(r.content[0].text, /apply-style italic=true is unavailable: the serialized action did not change computed fontStyle/);
  });
  await check('add_interaction MCP rejects unverified apply-style italic=false', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-italic-false.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'italic=false'], replaceEvent: true });
    assert.ok(r.isError, r.content[0].text);
    assert.match(r.content[0].text, /apply-style italic=false is unavailable: the serialized action did not change computed fontStyle/);
  });
  await check('add_interaction MCP writes apply-style underline to native property ID 5', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-underline.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'underline=true'], replaceEvent: true });
    assert.ok(!r.isError, r.content[0].text);
    const bytes = readFileSync(output), rp = readRp(bytes);
    assert.equal(rp.counts.problems, 0);
    const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const underline = field(style.body, 'PropList').items.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 5);
    assert.equal(field(underline, 'DOAName').value, 0xc0000005);
    assert.equal(field(underline, 'Value').value, true);
  });
  await check('add_interaction MCP writes apply-style strikethrough to Boolean property ID 95', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-strikethrough.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'strikethrough=true'], replaceEvent: true });
    assert.ok(!r.isError, r.content[0].text);
    const bytes = readFileSync(output), rp = readRp(bytes);
    assert.equal(rp.counts.problems, 0);
    const page = readRecords(bytes).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const property = field(style.body, 'PropList').items.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 95);
    assert.equal(field(property, 'DOAName').value, 0xc000005f);
    assert.equal(field(property, 'Value').value, true);
  });
  await check('add_interaction MCP rejects unverified apply-style strikethrough=false', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'style-strikethrough-false.rp');
    const r = await call('add_interaction', { source, output, target: 'SET_BUTTON', event: 'OnClick', action: 'apply-style', parameters: ['target=VALUE_PREVIEW', 'strikethrough=false'], replaceEvent: true });
    assert.ok(r.isError, r.content[0].text);
    assert.match(r.content[0].text, /apply-style strikethrough currently supports true only/);
  });
  await check('fill_panel_state 具名参数替换普通状态', async () => {
    const output = join(work, 'panel.rp');
    const r = await call('fill_panel_state', { source: fixture('richtext-whole-block-v2-roundtrip.rp'), target: fixture('panel-replace-roundtrip.rp'), output, sourcePage: 'Page 1', targetPage: 'Page 1', panel: 'CONTENT_PANEL', state: 'Form', mode: 'replace' });
    assert.ok(!r.isError, r.content[0].text);
    const rp = readRp(readFileSync(output)); assert.equal(rp.counts.problems, 0);
    assert.equal(rp.containedWidgets.filter(w => w.container.join('/') === 'CONTENT_PANEL(Form)').length,
      readRp(readFileSync(fixture('richtext-whole-block-v2-roundtrip.rp'))).counts.widgets);
  });
  await check('具名工具仍可用原始 argv 精确改面板内文字', async () => {
    const source = fixture('panel-replace-roundtrip.rp'), output = join(work, 'raw-text.rp');
    const target = readRp(readFileSync(source)).containedWidgets.find(w => w.type === 'TextBox');
    assert.ok(target);
    const r = await call('set_widget_text', { args: [source, output, '--record', String(target.record), '--widget', String(target.id), 'MCP_RAW_TEXT'] });
    assert.ok(!r.isError, r.content[0].text);
    const after = readRp(readFileSync(output)).containedWidgets.find(w => w.id === target.id && w.record === target.record);
    assert.equal(after.text, 'MCP_RAW_TEXT');
  });
  await check('原始 argv 支持 JSON 交互且不能混用具名字段', async () => {
    const source = fixture('var-set-counter-roundtrip.rp'), output = join(work, 'json-interaction.rp'), spec = join(work, 'interaction.json');
    writeFileSync(spec, JSON.stringify({ target: 'SET_BUTTON', interactions: [{ event: 'OnClick', actions: [{ type: 'wait', ms: 1 }] }] }), { flag: 'wx' });
    const r = await call('add_interaction', { args: [source, output, '--json', spec] });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(readRp(readFileSync(output)).counts.actions, readRp(readFileSync(source)).counts.actions + 1);
    assert.ok((await call('rp_read', { args: [source, '--json'], file: source })).isError);
    assert.ok((await call('rp_read', { args: [protectedPath, '--json'] })).isError);
  });
  await check('通用 argv 命令创建工程与防覆盖', async () => {
    const output = join(work, 'blank.rp'); const r = await call('create_blank_project', { args: [output] });
    assert.ok(!r.isError, r.content[0].text); const before = readFileSync(output);
    const again = await call('create_blank_project', { args: [output] }); assert.ok(again.isError); assert.ok(before.equals(readFileSync(output)));
  });
  await check('Axvg 子命令自动加入且离线自检通过', async () => {
    const r = await call('axvg_selftest', { args: [] }); assert.ok(!r.isError, r.content[0].text);
    assert.ok(JSON.parse(r.content[0].text).stdout.includes('selftest OK'));
  });
  await check('参数类型、未登记字段及未知工具拒绝', async () => {
    assert.ok((await call('rp_read', { file: 123 })).isError);
    assert.ok((await call('rp_read', { file: fixture('blank-ui-native.rp'), extra: true })).isError);
    assert.ok((await call('unknown_tool', {})).isError);
  });
  await check('受保护输入拒绝', async () => assert.ok((await call('rp_read', { file: protectedPath })).isError));
  await check('受保护输出与符号链接拒绝', async () => {
    assert.ok((await call('create_blank_project', { args: [protectedPath] })).isError);
    const link = join(work, 'final-link.rp'); symlinkSync(protectedPath, link);
    assert.ok((await call('rp_read', { file: link })).isError);
  });
  await check('白名单外输出拒绝且未落盘', async () => {
    const output = join(work, '..', `axure-mcp-outside-${process.pid}.rp`);
    assert.ok((await call('create_blank_project', { args: [output] })).isError); assert.ok(!existsSync(output));
  });
  // ---- 会话状态层（任务 A 追加；上方旧 13 项原样保留）----
  await check('会话层 8 个意图工具登记', async () => {
    const { tools } = await client.listTools();
    for (const name of ['axure_open', 'axure_state', 'axure_save', 'locate', 'inspect', 'read_interactions', 'edit_text', 'verify']) {
      const tool = tools.find(t => t.name === name);
      assert.ok(tool, `缺工具 ${name}`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const richRuns = tools.find(tool => tool.name === 'edit_text').inputSchema.properties.richRuns;
    const link = richRuns.oneOf[0].items.properties.runs.items.properties.link;
    assert.ok(link.oneOf.some(branch => branch.required.includes('page')));
    assert.ok(link.oneOf.some(branch => branch.required.includes('url')));
  });
  await check('axure_open 建链并返回总览', async () => {
    copyFileSync(fixture('var-set-counter-roundtrip.rp'), join(work, 'open.rp'));
    const r = await call('axure_open', { path: join(work, 'open.rp') });
    assert.ok(!r.isError, r.content[0].text);
    const overview = JSON.parse(r.content[0].text);
    assert.equal(overview.pages.length, 1);
    assert.equal(overview.pages[0].name, 'Page 1');
    assert.equal(overview.pages[0].widgets, 2);
    assert.ok(overview.pages[0].interactions >= 1);
    assert.deepEqual(overview.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    assert.ok(overview.session.chain[0].endsWith('open.work-1.rp'), overview.session.chain[0]);
    assert.ok(existsSync(overview.session.chain[0]));
    assert.ok(Array.isArray(overview.globalVariables));
    assert.ok(Array.isArray(overview.masters));
  });
  await check('locate 唯一命中与多候选全列', async () => {
    const one = JSON.parse((await call('locate', { query: 'VALUE_PREVIEW' })).content[0].text);
    assert.equal(one.total, 1);
    assert.equal(one.candidates[0].page, 'Page 1');
    assert.equal(one.candidates[0].record, 4);
    assert.equal(typeof one.candidates[0].id, 'number');
    assert.equal(one.candidates[0].type, 'VectorShape');
    assert.deepEqual(one.candidates[0].container, []);
    assert.ok(one.candidates[0].guid, '应有记录包 guid');
    const many = JSON.parse((await call('locate', { type: 'vectorshape' })).content[0].text);
    assert.equal(many.total, 2, '多候选必须全部列出而非报错');
    const none = JSON.parse((await call('locate', { query: 'NO_SUCH' })).content[0].text);
    assert.equal(none.total, 0);
  });
  await check('inspect 单元件深看', async () => {
    const r = await call('inspect', { target: { query: 'SET_BUTTON' } });
    assert.ok(!r.isError, r.content[0].text);
    const detail = JSON.parse(r.content[0].text);
    assert.equal(detail.name, 'SET_BUTTON');
    assert.equal(typeof detail.geometry.x, 'number');
    assert.ok(detail.interactions.tree.length >= 1);
    assert.ok(detail.interactions.human.some(line => line.includes('OnClick')), JSON.stringify(detail.interactions.human));
    assert.ok(detail.richText.paragraphs.length >= 1);
  });
  await check('read_interactions 页面交互树', async () => {
    const r = await call('read_interactions', { page: 'Page 1' });
    assert.ok(!r.isError, r.content[0].text);
    const tree = JSON.parse(r.content[0].text);
    assert.equal(tree.pages.length, 1);
    assert.ok(tree.pages[0].counts.interactions >= 1);
    assert.ok(tree.human.some(line => line.includes('SET_BUTTON')));
  });
  await check('edit_text 前进链并返回 before/after', async () => {
    const r = await call('edit_text', { target: { query: 'VALUE_PREVIEW' }, text: 'SESSION_EDITED' });
    assert.ok(!r.isError, r.content[0].text);
    const edit = JSON.parse(r.content[0].text);
    assert.equal(edit.after, 'SESSION_EDITED');
    assert.ok(edit.chainTail.endsWith('open.work-2.rp'), edit.chainTail);
    assert.ok(existsSync(edit.chainTail));
    assert.ok(existsSync(edit.previousTail), '链式快照：上一节点保留');
    const state = JSON.parse((await call('axure_state', {})).content[0].text);
    assert.equal(state.active, true);
    assert.equal(state.chain.length, 2);
    assert.equal(state.timeline.length, 2);
    assert.deepEqual(state.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    assert.equal(readRp(readFileSync(edit.chainTail)).pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'SESSION_EDITED');
  });
  await check('verify 浅查与深查', async () => {
    const shallow = JSON.parse((await call('verify', {})).content[0].text);
    assert.deepEqual(shallow.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    const deep = JSON.parse((await call('verify', { deep: true })).content[0].text);
    assert.deepEqual(deep.duplicates, []);
    assert.deepEqual(deep.danglingRefs, []);
    assert.equal(deep.pages[0].name, 'Page 1');
  });
  await check('axure_save 另存、防覆盖与链尾现状', async () => {
    const saved = join(work, 'saved.rp');
    const r = await call('axure_save', { as: saved });
    assert.ok(!r.isError, r.content[0].text);
    const save = JSON.parse(r.content[0].text);
    assert.equal(save.path, saved);
    assert.equal(save.sha256, createHash('sha256').update(readFileSync(saved)).digest('hex'));
    assert.ok((await call('axure_save', { as: saved })).isError, '已存在目标必须拒绝（防覆盖）');
    const tail = JSON.parse((await call('axure_save', {})).content[0].text);
    assert.ok(tail.file.endsWith('open.work-2.rp'));
    assert.equal(tail.sha256, createHash('sha256').update(readFileSync(tail.file)).digest('hex'));
  });
  await check('回滚：目标不存在则失败且链尾不变', async () => {
    const before = JSON.parse((await call('axure_state', {})).content[0].text);
    const r = await call('edit_text', { target: { query: 'NO_SUCH_WIDGET' }, text: 'x' });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /NO_SUCH_WIDGET|没有匹配/);
    const after = JSON.parse((await call('axure_state', {})).content[0].text);
    assert.equal(after.chain.length, before.chain.length);
    assert.equal(after.chain.at(-1), before.chain.at(-1));
    assert.ok(!existsSync(join(work, 'open.work-3.rp')), '失败不得产生新链节点');
    assert.ok(!readdirSync(work).some(f => f.includes('.rejected')), '定位失败未写盘，不应出现 .rejected');
  });
  await check('红线：axure_open 受保护成品拒绝', async () => {
    const r = await call('axure_open', { path: protectedPath });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /受保护/);
  });
  await check('红线：会话下命令工具显式路径语义不变', async () => {
    const output = join(work, 'explicit.rp');
    const r = await call('set_widget_text', { source: fixture('var-set-counter-roundtrip.rp'), output, page: 'Page 1', widget: 'VALUE_PREVIEW', text: 'EXPLICIT_PATH' });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(readRp(readFileSync(output)).pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'EXPLICIT_PATH');
    const state = JSON.parse((await call('axure_state', {})).content[0].text);
    assert.ok(state.chain.at(-1).endsWith('open.work-2.rp'), '命令工具不得改动会话链');
  });
  await check('白名单：源目录在根外时 open 给出明确指引', async () => {
    const r = await call('axure_open', { path: fixture('var-set-counter-roundtrip.rp') });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /AXURE_WRITE_ROOT/);
  });
  await check('富文本会话流（set-widget-richtext 库导出路径）', async () => {
    copyFileSync(fixture('richtext-whole-block-v2-roundtrip.rp'), join(work, 'rt.rp'));
    const opened = JSON.parse((await call('axure_open', { path: join(work, 'rt.rp') })).content[0].text);
    assert.deepEqual(opened.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    const r = await call('edit_text', { target: { query: 'RICH_TEXT' }, richRuns: [{ runs: [{ text: '会话富文本' }] }] });
    assert.ok(!r.isError, r.content[0].text);
    const edit = JSON.parse(r.content[0].text);
    assert.ok(edit.chainTail.endsWith('rt.work-2.rp'), edit.chainTail);
    const state = JSON.parse((await call('axure_state', {})).content[0].text);
    assert.deepEqual(state.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
  });
  await check('坏节点 .rejected 回退（进程内直测提交关卡）', async () => {
    copyFileSync(fixture('var-set-counter-roundtrip.rp'), join(work, 'reject.rp'));
    const state = openSession(join(work, 'reject.rp'));
    const bad = join(work, 'reject.work-2.rp');
    const bytes = readFileSync(join(work, 'reject.rp'));
    // 截断 30% 制造必坏节点：manifest 登记的全部记录读不齐，rp-read 必然失败
    writeFileSync(bad, bytes.subarray(0, Math.floor(bytes.length * 0.7)));
    assert.throws(() => commitChainNode(state, bad, { op: 'edit_text' }), /\.rejected/);
    assert.ok(existsSync(`${bad}.rejected`));
    assert.ok(!existsSync(bad));
    assert.equal(state.chain.length, 1, '链必须停在原节点');
  });

  // 以下只追加 MCP 会话化、效率与失败路径验证；原有 27 项保持原样。
  const valueOf = r => { assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  const stateOf = async () => valueOf(await call('axure_state', {}));
  const openFixture = async (name, label) => {
    const path = join(work, `${label}.rp`); copyFileSync(fixture(name), path);
    return valueOf(await call('axure_open', { path }));
  };
  await check('MCP 富文本链接可写入、inspect 可读回目标并经结构关卡', async () => {
    await openFixture('richtext-hyperlink-template.rp', 'richtext-link-session');
    const edited = valueOf(await call('edit_text', { target: { name: 'RICH_TEXT', page: 'Page 1' }, richRuns: [
      { runs: [{ text: 'Open ' }, { text: 'Page Two', link: { page: 'Page 2' } }] },
    ] }));
    assert.ok(edited.chainTail.endsWith('richtext-link-session.work-2.rp'), edited.chainTail);
    assert.deepEqual(valueOf(await call('verify', { deep: true })).structure, { unparseable: 0, danglingRefs: 0, problems: 0 });
    const detail = valueOf(await call('inspect', { target: { name: 'RICH_TEXT', page: 'Page 1' } }));
    const linked = detail.richText.paragraphs[0].runs.find(run => run.text === 'Page Two');
    assert.deepEqual(linked.link, { page: 'Page 2', window: 'current' });
    const rp = readRp(readFileSync(edited.chainTail));
    assert.ok(rp.pages.find(page => page.name === 'Page 1').widgets.some(widget => widget.type === 'Hyperlink'
      && widget.interactions.some(event => event.cases.some(kase => kase.actions.some(action => action.human.includes('Page 2.html'))))));
  });
  await check('具名省路径修改接续会话并返回真实 before/after', async () => {
    await openFixture('var-set-counter-roundtrip.rp', 'named-session');
    const edited = valueOf(await call('set_widget_text', { page: 'Page 1', widget: 'VALUE_PREVIEW', text: 'NAMED_SESSION' }));
    assert.equal(edited.status, 'completed'); assert.equal(edited.before.pages, 1); assert.equal(edited.after.widgets, 2);
    assert.equal((await stateOf()).chainTail, edited.chainTail);
    assert.equal(readRp(readFileSync(edited.chainTail)).pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'NAMED_SESSION');
    const added = valueOf(await call('add_interaction', { target: 'SET_BUTTON', event: 'OnClick', action: 'wait', parameters: ['ms=5'] }));
    assert.equal(added.after.actions, added.before.actions + 1); assert.equal(added.previousTail, edited.chainTail);
    const read = valueOf(await call('rp_read', {}));
    assert.equal(JSON.parse(read.stdout).counts.actions, added.after.actions);
  });
  await check('原始 args 会话模式创建页、复制页与改字保留前一步修改', async () => {
    await openFixture('var-set-counter-roundtrip.rp', 'raw-session');
    const first = valueOf(await call('create_blank_page', { session: true, args: ['Extra'] }));
    assert.equal(first.after.pages, 2);
    const second = valueOf(await call('duplicate_page', { session: true, args: ['Page 1', 'Copied'] }));
    assert.equal(second.after.pages, 3); assert.equal(second.previousTail, first.chainTail);
    const third = valueOf(await call('set_widget_text', { session: true, args: ['Page 1', 'VALUE_PREVIEW', 'RAW_SESSION'] }));
    const rp = readRp(readFileSync(third.chainTail));
    assert.equal(rp.pages.length, 3); assert.equal(rp.pages.find(p => p.name === 'Page 1').widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'RAW_SESSION');
    assert.notEqual(rp.pages.find(p => p.name === 'Copied').widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'RAW_SESSION');
  });
  await check('显式前置 --index 保留 CLI 语义且不推进链', async () => {
    const before = await stateOf(), output = join(work, 'explicit-index.rp');
    const source = fixture('var-set-counter-roundtrip.rp');
    const record = readRp(readFileSync(source)).pages[0].record;
    valueOf(await call('duplicate_page', { args: ['--index', source, output, String(record), 'ByIndex'] }));
    assert.equal(readRp(readFileSync(output)).pages.length, 2);
    assert.deepEqual((await stateOf()).chain, before.chain);
  });
  await check('显式只传源或只传输出均拒绝，链与文件不变', async () => {
    const before = await stateOf(), output = join(work, 'partial.rp');
    for (const paths of [{ source: fixture('var-set-counter-roundtrip.rp') }, { output }]) {
      const r = await call('set_widget_text', { ...paths, page: 'Page 1', widget: 'VALUE_PREVIEW', text: 'BAD' });
      assert.ok(r.isError); assert.match(r.content[0].text, /同时提供/);
    }
    assert.deepEqual((await stateOf()).chain, before.chain); assert.ok(!existsSync(output));
  });
  await check('多源导入只省宿主和输出，外部源与模式仍正确', async () => {
    await openFixture('panel-replace-roundtrip.rp', 'import-session');
    const source = fixture('richtext-whole-block-v2-roundtrip.rp');
    const r = valueOf(await call('fill_panel_state', { source, sourcePage: 'Page 1', targetPage: 'Page 1', panel: 'CONTENT_PANEL', state: 'Form', mode: 'replace' }));
    const imported = readRp(readFileSync(r.chainTail));
    assert.equal(imported.containedWidgets.filter(w => w.container.join('/') === 'CONTENT_PANEL(Form)').length, readRp(readFileSync(source)).counts.widgets);
    assert.equal((await stateOf()).chainTail, r.chainTail);
    const raw = valueOf(await call('fill_panel_state', { session: true, args: [source, 'Page 1', 'Page 1', 'CONTENT_PANEL', 'Form', '--replace'] }));
    assert.equal(raw.previousTail, r.chainTail);
  });
  await check('命令目标重名错误附真实候选和 usage', async () => {
    await openFixture('var-set-counter-roundtrip.rp', 'duplicates');
    valueOf(await call('duplicate_page', { session: true, args: ['Page 1', 'Other'] }));
    const r = await call('add_interaction', { target: 'SET_BUTTON', event: 'OnClick', action: 'wait', parameters: ['ms=1'] });
    assert.ok(r.isError, r.content[0].text);
    const e = JSON.parse(r.content[0].text);
    assert.match(e.usage, /add-interaction/); assert.equal(e.candidates.length, 2);
    assert.deepEqual(e.candidates.map(w => w.page).sort(), ['Other', 'Page 1']);
    const direct = await call('edit_text', { target: 'VALUE_PREVIEW', text: 'AMBIG' });
    assert.ok(direct.isError); assert.equal(JSON.parse(direct.content[0].text).candidates.length, 2);
  });
  await check('缺参数返回真实 usage；未知工具列出真实名称', async () => {
    const r = await call('set_widget_text', { page: 'Page 1' }); assert.ok(r.isError);
    assert.match(JSON.parse(r.content[0].text).usage, /<widgetName>/);
    const unknown = await call('not_registered', {}); assert.ok(unknown.isError);
    const actual = (await client.listTools()).tools.filter(t => !t.name.startsWith('jobs_') && t.name !== 'gui_roundtrip').map(t => t.name);
    assert.deepEqual(JSON.parse(unknown.content[0].text).availableTools, actual);
  });
  await check('locate 分页保持总数、下一页且拒绝非法范围', async () => {
    const first = valueOf(await call('locate', { query: 'VALUE_PREVIEW', limit: 1 }));
    assert.equal(first.total, 2); assert.equal(first.candidates.length, 1); assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 1);
    const next = valueOf(await call('locate', { query: 'VALUE_PREVIEW', limit: 1, offset: first.nextOffset }));
    assert.equal(next.total, 2); assert.equal(next.hasMore, false); assert.equal(next.nextOffset, null);
    assert.notEqual(next.candidates[0].page, first.candidates[0].page);
    for (const paging of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { offset: 0.5 }]) assert.ok((await call('locate', { query: '', ...paging })).isError);
  });
  await check('批量改文字一次调用完成且原件、之前链节点不变', async () => {
    const opened = await openFixture('var-set-counter-roundtrip.rp', 'batch');
    const original = readFileSync(opened.session.sourceFile), old = readFileSync(opened.session.chainTail);
    const r = valueOf(await call('edit_text', { edits: [{ target: { name: 'VALUE_PREVIEW' }, text: 'BATCH_VALUE' }, { target: { name: 'SET_BUTTON' }, text: 'BATCH_BUTTON' }] }));
    assert.equal(r.edits.length, 2); assert.equal((await stateOf()).chain.length, 3);
    const rp = readRp(readFileSync(r.chainTail));
    assert.equal(rp.pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'BATCH_VALUE');
    assert.equal(rp.pages[0].widgets.find(w => w.name === 'SET_BUTTON').text, 'BATCH_BUTTON');
    assert.ok(original.equals(readFileSync(opened.session.sourceFile))); assert.ok(old.equals(readFileSync(opened.session.chainTail)));
  });
  await check('批量第二条失败整批回退，成功中间节点隔离且不复用序号', async () => {
    const before = await stateOf(), bytes = readFileSync(before.chainTail);
    const files = new Set(readdirSync(work));
    const r = await call('edit_text', { edits: [{ target: { name: 'VALUE_PREVIEW' }, text: 'MUST_ROLL_BACK' }, { target: 'NOT_FOUND', text: 'BAD' }] });
    assert.ok(r.isError); assert.match(r.content[0].text, /整批回退/);
    assert.deepEqual((await stateOf()).chain, before.chain); assert.ok(bytes.equals(readFileSync(before.chainTail)));
    const rejected = readdirSync(work).filter(n => !files.has(n) && n.endsWith('.rejected'));
    assert.equal(rejected.length, 1);
    const recovered = valueOf(await call('edit_text', { target: { name: 'VALUE_PREVIEW' }, text: 'RECOVERED' }));
    assert.notEqual(join(work, rejected[0].replace(/\.rejected$/, '')), recovered.chainTail);
    assert.equal(readRp(readFileSync(recovered.chainTail)).pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'RECOVERED');
  });
  await check('批量非法项与混用单条参数在写盘前拒绝', async () => {
    const before = await stateOf(), files = readdirSync(work);
    for (const args of [{ edits: [] }, { edits: [{ target: 'VALUE_PREVIEW', text: 'x', richRuns: [] }] }, { target: 'VALUE_PREVIEW', edits: [{ target: 'VALUE_PREVIEW', text: 'x' }] }]) assert.ok((await call('edit_text', args)).isError);
    assert.deepEqual((await stateOf()).chain, before.chain); assert.deepEqual(readdirSync(work), files);
  });
  await check('批量富文本保留显式字体、颜色、对齐并回传结构化内容', async () => {
    await openFixture('richtext-whole-block-v2-roundtrip.rp', 'batch-rich');
    const r = await call('edit_text', { edits: [{ target: { name: 'RICH_TEXT' }, richRuns: [{ align: 'right', lineSpacing: 72, runs: [{ text: 'STYLED', style: { fontFamily: 'Arial', size: 20, color: '#245bdb', bold: true } }] }] }] });
    const edit = valueOf(r); assert.deepEqual(r.structuredContent, edit);
    const detail = valueOf(await call('inspect', { target: { name: 'RICH_TEXT' } }));
    assert.equal(detail.richText.paragraphs[0].align, 'right'); assert.equal(detail.richText.paragraphs[0].lineSpacing, 72); assert.equal(detail.richText.paragraphs[0].runs[0].size, 20);
    assert.equal(detail.richText.paragraphs[0].runs[0].color.toLowerCase(), '#245bdb'); assert.ok(detail.style.length);
  });
  await check('深层面板 page 过滤与交互树可读，精确 ID 可改嵌套文本', async () => {
    await openFixture('panel-nested-three-level-gui-edit.rp', 'deep-panel');
    const candidates = valueOf(await call('locate', { type: 'TextBox', page: 'Page 1' })).candidates;
    assert.ok(candidates.some(c => c.container.length >= 3));
    const checkbox = valueOf(await call('locate', { type: 'Checkbox', page: 'Page 1' })).candidates[0];
    const detail = valueOf(await call('inspect', { target: checkbox }));
    assert.ok(detail.interactions.count >= 1); assert.equal(detail.interactions.tree[0].event, 'OnClick');
    assert.ok(detail.interactions.tree[0].cases[0].actions.length);
    const overview = valueOf(await call('read_interactions', { page: 'Page 1' }));
    assert.ok(overview.contained.some(w => w.record === checkbox.record && w.id === checkbox.id));
    const textbox = candidates.find(c => c.container.length >= 3);
    const edit = valueOf(await call('edit_text', { target: textbox, text: 'DEEP_MCP' }));
    assert.equal(readRp(readFileSync(edit.chainTail)).containedWidgets.find(w => w.record === textbox.record && w.id === textbox.id).text, 'DEEP_MCP');
  });
  await check('verify 重读磁盘检测外部坏档；拒绝继续修改和另存', async () => {
    const state = await stateOf(), original = readFileSync(state.chainTail);
    writeFileSync(state.chainTail, original.subarray(0, Math.floor(original.length * 0.7)));
    assert.ok((await call('verify', { deep: true })).isError);
    assert.ok((await call('edit_text', { target: 'ANY', text: 'BAD' })).isError);
    const output = join(work, 'corrupt-save.rp'); assert.ok((await call('axure_save', { as: output })).isError); assert.ok(!existsSync(output));
    writeFileSync(state.chainTail, original); assert.equal(valueOf(await call('verify', {})).status, 'verified');
  });
  await check('物理路径 link/.. 的 open 与 save 指向实际文件', async () => {
    const physical = join(work, 'physical'); const nested = join(physical, 'nested');
    const { mkdirSync } = await import('node:fs'); mkdirSync(nested, { recursive: true });
    const link = join(work, 'nested-link'); symlinkSync(nested, link);
    copyFileSync(fixture('var-set-counter-roundtrip.rp'), join(physical, 'source.rp'));
    const opened = valueOf(await call('axure_open', { path: `${link}/../source.rp` }));
    assert.ok(opened.session.sourceFile.endsWith('/physical/source.rp'));
    const saved = valueOf(await call('axure_save', { as: `${link}/../saved.rp` }));
    assert.ok(saved.physicalPath.endsWith('/physical/saved.rp')); assert.ok(existsSync(join(physical, 'saved.rp'))); assert.ok(!existsSync(join(work, 'saved.rp.bad')));
  });
  await check('保护红线覆盖 open/save/链尾替换链接而不触碰成品', async () => {
    const r = await call('axure_save', { as: protectedPath }); assert.ok(r.isError); assert.match(r.content[0].text, /受保护/);
    const link = join(work, 'protected-open-link.rp'); symlinkSync(protectedPath, link);
    const open = await call('axure_open', { path: link }); assert.ok(open.isError); assert.match(open.content[0].text, /受保护/);
    const state = await stateOf(), original = readFileSync(state.chainTail); rmSync(state.chainTail); symlinkSync(protectedPath, state.chainTail);
    for (const name of ['verify', 'axure_save']) { const denied = await call(name, {}); assert.ok(denied.isError); assert.match(denied.content[0].text, /受保护/); }
    const denied = await call('edit_text', { target: 'VALUE_PREVIEW', text: 'BAD' }); assert.ok(denied.isError); assert.match(denied.content[0].text, /受保护/);
    rmSync(state.chainTail); writeFileSync(state.chainTail, original, { flag: 'wx' }); valueOf(await call('verify', {}));
  });
  await check('第二 stdio 连接无会话泄漏；无会话显式模式保持可用', async () => {
    const another = new Client({ name: 'isolated', version: '1.0.0' });
    const tr = new StdioClientTransport({ command: process.execPath, args: [join(serverRoot, 'bin/mcp.mjs')], env, stderr: 'pipe' });
    try {
      await another.connect(tr);
      const inactive = valueOf(await another.callTool({ name: 'axure_state', arguments: {} })); assert.equal(inactive.active, false);
      const missing = await another.callTool({ name: 'rp_read', arguments: {} }); assert.ok(missing.isError); assert.match(missing.content[0].text, /没有活动会话/);
      const read = valueOf(await another.callTool({ name: 'rp_read', arguments: { file: fixture('blank-ui-native.rp') } })); assert.equal(JSON.parse(read.stdout).counts.widgets, 0);
      const out = join(work, 'isolated-explicit.rp'); valueOf(await another.callTool({ name: 'set_widget_text', arguments: { source: fixture('var-set-counter-roundtrip.rp'), output: out, page: 'Page 1', widget: 'VALUE_PREVIEW', text: 'ISOLATED' } }));
      assert.equal(valueOf(await another.callTool({ name: 'axure_state', arguments: {} })).active, false);
    } finally { await another.close(); }
  });
  await check('并发命令请求串行提交，不丢失任一修改', async () => {
    await openFixture('var-set-counter-roundtrip.rp', 'concurrent');
    const edits = await Promise.all([call('set_widget_text', { page: 'Page 1', widget: 'VALUE_PREVIEW', text: 'CONCURRENT_VALUE' }), call('set_widget_text', { page: 'Page 1', widget: 'SET_BUTTON', text: 'CONCURRENT_BUTTON' })]);
    edits.forEach(valueOf);
    const state = await stateOf(), rp = readRp(readFileSync(state.chainTail)); assert.equal(state.chain.length, 3);
    assert.equal(rp.pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, 'CONCURRENT_VALUE'); assert.equal(rp.pages[0].widgets.find(w => w.name === 'SET_BUTTON').text, 'CONCURRENT_BUTTON');
  });


  await check('缓存预热后 protected 链尾链接仍阻断 locate/inspect/read_interactions/state', async () => {
    const opened = await openFixture('var-set-counter-roundtrip.rp', 'cached-guard');
    const cand = valueOf(await call('locate', { query: 'VALUE_PREVIEW' })).candidates[0];
    valueOf(await call('inspect', { target: cand })); valueOf(await call('read_interactions', {}));
    const tail = opened.session.chainTail, original = readFileSync(tail); rmSync(tail); symlinkSync(protectedPath, tail);
    for (const [name, args] of [['locate', { query: '' }], ['inspect', { target: cand }], ['read_interactions', {}], ['axure_state', {}]]) {
      const denied = await call(name, args); assert.ok(denied.isError, denied.content[0].text); assert.match(denied.content[0].text, /受保护/);
    }
    rmSync(tail); writeFileSync(tail, original, { flag: 'wx' }); valueOf(await call('verify', {}));
  });
  await check('链中间节点被换为 protected 链接时命令也拒绝', async () => {
    const state = await stateOf();
    valueOf(await call('edit_text', { target: { name: 'VALUE_PREVIEW' }, text: 'LATEST' }));
    const middle = state.chainTail, original = readFileSync(middle); rmSync(middle); symlinkSync(protectedPath, middle);
    const denied = await call('set_widget_text', { page: 'Page 1', widget: 'VALUE_PREVIEW', text: 'BAD' });
    assert.ok(denied.isError); assert.match(denied.content[0].text, /受保护/);
    rmSync(middle); writeFileSync(middle, original, { flag: 'wx' }); valueOf(await call('verify', {}));
  });


  await check('remove_interaction 重名拒绝也返回真实候选', async () => {
    await openFixture('var-set-counter-roundtrip.rp', 'remove-duplicate');
    valueOf(await call('duplicate_page', { session: true, args: ['Page 1', 'Other'] }));
    const r = await call('remove_interaction', { session: true, args: ['SET_BUTTON', '--event', 'OnClick', '--remove-event'] });
    assert.ok(r.isError); assert.equal(JSON.parse(r.content[0].text).candidates.length, 2);
  });
  await check('大小写占用节点保留原位和原始字节', async () => {
    const opened = await openFixture('var-set-counter-roundtrip.rp', 'case-node');
    const existing = join(work, 'case-node.WORK-2.RP'); copyFileSync(fixture('blank-ui-native.rp'), existing);
    const original = readFileSync(existing);
    const edited = valueOf(await call('edit_text', { target: { name: 'VALUE_PREVIEW' }, text: 'CASE_SAFE' }));
    assert.ok(edited.chainTail.endsWith('case-node.work-3.rp')); assert.ok(existsSync(existing)); assert.ok(readFileSync(existing).equals(original));
    assert.ok(!existsSync(`${existing}.rejected`)); assert.equal(opened.session.chain.length, 1);
  });
  await check('不同进程同源并发原子占号，双方链尾都保留（3轮）', async () => {
    const another = new Client({ name: 'concurrent-process', version: '1.0.0' });
    const tr = new StdioClientTransport({ command: process.execPath, args: [join(serverRoot, 'bin/mcp.mjs')], env, stderr: 'pipe' });
    try {
      await another.connect(tr);
      for (let i = 0; i < 3; i++) {
        const opened = await openFixture('var-set-counter-roundtrip.rp', `two-process-${i}`);
        valueOf(await another.callTool({ name: 'axure_open', arguments: { path: opened.session.sourceFile } }));
        const args = text => ({ page: 'Page 1', widget: 'VALUE_PREVIEW', text });
        const [one, two] = await Promise.all([call('set_widget_text', args('PROCESS_ONE')), another.callTool({ name: 'set_widget_text', arguments: args('PROCESS_TWO') })]);
        const a = valueOf(one), b = valueOf(two); assert.notEqual(a.chainTail, b.chainTail);
        assert.ok(existsSync(a.chainTail)); assert.ok(existsSync(b.chainTail));
        for (const [result, text] of [[a, 'PROCESS_ONE'], [b, 'PROCESS_TWO']]) assert.equal(readRp(readFileSync(result.chainTail)).pages[0].widgets.find(w => w.name === 'VALUE_PREVIEW').text, text);
        valueOf(await call('verify', {})); valueOf(await another.callTool({ name: 'verify', arguments: {} }));
      }
    } finally { await another.close(); }
    assert.ok(!readdirSync(work).some(name => name.endsWith('.lock')), '正常结束不留下预约锁');
  });
  await check('白名单根外 open 仍明确指引复制源到根内', async () => {
    const r = await call('axure_open', { path: fixture('var-set-counter-roundtrip.rp') });
    assert.ok(r.isError); assert.match(r.content[0].text, /指引/); assert.match(r.content[0].text, /复制到 AXURE_WRITE_ROOT/);
  });


  await check('删除不存在内容的建议不返回无关面板', async () => {
    await openFixture('panel-replace-roundtrip.rp', 'missing-child');
    const r = await call('remove_panel_state_content', { session: true, args: ['Page 1', 'CONTENT_PANEL', 'Form', 'MISSING_WIDGET'] });
    assert.ok(r.isError); assert.match(r.content[0].text, /MISSING_WIDGET/); assert.deepEqual(JSON.parse(r.content[0].text).candidates, []);
  });
  await check('占锁间隙竞争方完成或拒绝后重新取号，保留对方证据', async () => {
    const fs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const { callCommandTool } = await import('../scripts/mcp-tools.mjs');
    const originalWrite = fs.writeFileSync;
    for (const rejected of [false, true]) {
      const label = rejected ? 'race-rejected' : 'race-completed';
      const source = join(work, `${label}.rp`); copyFileSync(fixture('var-set-counter-roundtrip.rp'), source);
      const opened = openSession(source), raced = join(dirname(opened.sourceFile), `${label}.work-2.rp${rejected ? '.rejected' : ''}`);
      const original = readFileSync(fixture('blank-ui-native.rp'));
      let injected = false;
      try {
        fs.writeFileSync = function(path, ...args) {
          if (!injected && String(path).endsWith(`${label}.work-2.rp.lock`)) { injected = true; originalWrite(raced, original, { flag: 'wx' }); }
          return originalWrite(path, ...args);
        };
        syncBuiltinESMExports();
        const r = callCommandTool('edit_text', { target: { name: 'VALUE_PREVIEW' }, text: 'AFTER_RACE' });
        assert.ok(!r.isError, r.content[0].text); assert.ok(JSON.parse(r.content[0].text).chainTail.endsWith(`${label}.work-3.rp`));
      } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
      assert.ok(injected); assert.ok(readFileSync(raced).equals(original)); assert.ok(!readdirSync(work).some(n => n.endsWith('.lock')));
    }
  });

  await check('Master 状态具名替换及 owner 歧义拒绝', async () => {
    const output = join(work, 'master-named.rp');
    const input = { source: fixture('master-state-form-source.rp'), target: fixture('panel-master-dependency-panel-gui-edit.rp'), output, sourcePage: 'Page 1', targetMaster: 'NESTED_MASTER', panel: 'CONTENT_PANEL', state: 'Form', mode: 'replace' };
    const result = valueOf(await call('fill_panel_state', input));
    assert.equal(JSON.parse(result.stdout).targetMaster, 'NESTED_MASTER');
    assert.equal(readRp(readFileSync(output)).counts.problems, 0);
    assert.ok((await call('fill_panel_state', { ...input, output: join(work, 'ambiguous-master.rp'), targetPage: 'Page 1' })).isError);
    assert.ok(!existsSync(join(work, 'ambiguous-master.rp')));
  });
  await check('Master 会话链具名替换和原始参数清空', async () => {
    await openFixture('panel-master-dependency-panel-gui-edit.rp', 'master-session');
    valueOf(await call('fill_panel_state', { source: fixture('master-state-form-source.rp'), sourcePage: 'Page 1', targetMaster: 'NESTED_MASTER', panel: 'CONTENT_PANEL', state: 'Form', mode: 'replace' }));
    assert.equal((await stateOf()).chain.length, 2);
    const cleared = valueOf(await call('remove_panel_state_content', { session: true, args: ['NESTED_MASTER', 'CONTENT_PANEL', 'Form', '--master', '--all'] }));
    assert.equal((await stateOf()).chain.length, 3); assert.equal(JSON.parse(cleared.stdout).retainedRoots, 0); assert.equal(cleared.after.masters, 2);
  });
  await check('Master 原始参数按名删除 PNG', async () => {
    const output = join(work, 'master-delete.rp');
    const result = valueOf(await call('remove_panel_state_content', { args: [fixture('panel-master-dependency-panel-gui-edit.rp'), output, 'NESTED_MASTER', 'CONTENT_PANEL', 'Form', '--master', 'PANEL_IMAGE'] }));
    assert.equal(JSON.parse(result.stdout).retainedRoots, 4); assert.equal(readRp(readFileSync(output)).counts.problems, 0);
  });
} finally { await client.close(); rmSync(work, { recursive: true, force: true }); }
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ total: results.length, passed: results.length - failed, failed, results }));
process.exitCode = failed ? 1 : 0;
