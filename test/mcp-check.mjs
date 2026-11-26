// 特殊形态保留理由（gaps #7）：单会话 MCP stdio 客户端顺序流门禁，在末行输出结构化 JSON 汇总供打包与发布脚本解析。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildNativeDemo } from '../examples/build-native-demo.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { listMcpTools, jobTools } from '../scripts/mcp-tools.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'zee-rp-stdio-'));
const env = { ...process.env, AXURE_WRITE_ROOT: work, AXURE_PROTECTED_PATHS: join(work, 'protected.rp') };
const transport = new StdioClientTransport({command:process.execPath,args:[join(root,'bin/mcp.mjs')],env,stderr:'pipe'});
const client = new Client({name:'zee-rp-public-tests',version:'0.1.1'});
const results = [];
async function check(name, action) {
  try { await action(); results.push({name,passed:true}); console.log(`PASS  ${name}`); }
  catch(error) { results.push({name,passed:false,detail:error.message}); console.log(`FAIL  ${name} — ${error.message}`); }
}
async function call(name, args) {
  const result = await client.callTool({name,arguments:args});
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
try {
  const demo = buildNativeDemo(join(work,'demo')), source = join(demo.output,demo.source);
  await client.connect(transport);
  await check('real stdio initializes and discovers every registered tool (30 tools) exactly once', async () => {
    const result = await client.listTools();
    const expected = [...listMcpTools(), ...jobTools].map(t => t.name).sort();
    assert.equal(expected.length, 30);
    assert.deepEqual(result.tools.map(t => t.name).sort(), expected);
    assert.equal(new Set(result.tools.map(t => t.name)).size, expected.length);
  });
  await check('real transport reads generated native widgets via rp_inspect and rp_command', async () => {
    const overview = await call('rp_inspect',{view:'overview',path:source});
    assert.equal(overview.counts.widgets,5);
    const result = await call('rp_command',{action:'run',command:'rp-read',args:[source,'--json']});
    assert.equal(result.exitCode,0); assert.equal(JSON.parse(result.stdout).counts.widgets,5);
  });
  await check('global-variable named default passes through stdio to native storage', async () => {
    const output=join(work,'variable.rp');
    const result=await call('rp_command',{action:'run',command:'create-global-variable',params:{source,output,name:'TransportCounter',defaultValue:'13'}});
    assert.equal(result.exitCode,0);
    assert.ok(readRp(readFileSync(output)).globalVariables.some(v=>v.name==='TransportCounter'&&v.value==='13'));
  });
  await check('session rich-text link/list/spacing survives save and re-read', async () => {
    await call('axure_open',{path:source});
    const spec=JSON.parse(readFileSync(join(root,'examples/richtext.json')));
    await call('rp_patch',{target:{name:'StatusBanner'},richRuns:spec.paragraphs});
    const output=join(work,'saved.rp');await call('axure_save',{as:output});
    const rp=readRp(readFileSync(output));
    assert.equal(rp.pages[0].widgets.find(w=>w.name==='StatusBanner').text,'Notice: Documentation');
    assert.ok(rp.pages[0].widgets.some(w=>w.type==='Hyperlink'));assert.equal(rp.counts.problems,0);
    const verification=await call('rp_inspect',{view:'verify',deep:true}); assert.equal(verification.structure.problems,0);
  });
  await check('raw session variable call advances the working chain', async () => {
    const result=await call('rp_command',{action:'run',command:'create-global-variable',session:true,args:['SessionCounter','--default-value','17']});
    assert.equal(result.exitCode,0);
    assert.ok(readRp(readFileSync(result.chainTail)).globalVariables.some(v=>v.name==='SessionCounter'&&v.value==='17'));
  });
  await check('quick rename preserves content/events and rejects ambiguous batches atomically', async () => {
    const beforeState = await call('axure_save', {});
    const before = readRp(readFileSync(beforeState.chain.at(-1)));
    const result = await call('rp_patch', { target: { name: 'StatusBanner' }, name: '中文 状态 ★' });
    const after = readRp(readFileSync(result.chainTail));
    assert.equal(after.pages[0].widgets.find(w => w.name === '中文 状态 ★').text, 'Notice: Documentation');
    assert.deepEqual(after.counts, before.counts);
    const other = after.pages[0].widgets.find(w => w.name && w.name !== '中文 状态 ★');
    await call('rp_patch', { target: { name: other.name }, name: '中文 状态 ★' });
    const stable = await call('axure_save', {});
    const failed = await client.callTool({ name: 'rp_patch', arguments: { edits: [
      { target: { name: '中文 状态 ★' }, name: 'must not commit' },
      { target: { name: 'missing' }, name: 'missing' },
    ] } });
    assert(failed.isError);
    assert.deepEqual((await call('axure_save', {})).chain, stable.chain);
    const target = (await call('rp_inspect', { view: 'locate', query: '中文 状态 ★' })).candidates[0];
    const exact = await call('rp_patch', { target: { record: target.record, id: target.id }, name: '精确改名' });
    assert.equal(readRp(readFileSync(exact.chainTail)).counts.problems, 0);
    const both = (await call('rp_inspect', { view: 'locate', query: '中文 状态 ★' })).candidates[0];
    const start = (await call('axure_save', {})).chain.length;
    const bulk = await call('rp_patch', { edits: [
      { target: { name: '精确改名' }, name: '批量一' },
      { target: { record: both.record, id: both.id }, name: '批量二' },
    ] });
    assert.equal(bulk.edits.length, 2);
    assert.equal((await call('axure_save', {})).chain.length, start + 1);
  });
  await check('stdio rejects unknown rich-text fields, retired tool names with migration hints, and protected paths', async () => {
    const invalid=await client.callTool({name:'rp_patch',arguments:{target:{name:'StatusBanner'},richRuns:[{runs:[{text:'x'}],unknown:true}]}});
    assert.ok(invalid.isError);
    const retired=await client.callTool({name:'edit_text',arguments:{target:{name:'StatusBanner'},text:'x'}});
    assert.ok(retired.isError);
    assert.match(retired.content[0].text,/rp_patch/);
    const protectedResult=await client.callTool({name:'rp_inspect',arguments:{view:'overview',path:env.AXURE_PROTECTED_PATHS}});
    assert.ok(protectedResult.isError);
  });
} finally { await client.close(); rmSync(work,{recursive:true,force:true}); }
const failed=results.filter(r=>!r.passed).length;
console.log(JSON.stringify({evidence:'offline-stdio',total:results.length,passed:results.length-failed,failed}));
process.exitCode=failed?1:0;
