import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildNativeDemo } from '../examples/build-native-demo.mjs';
import { readRp } from '../scripts/rp-read.mjs';

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
  await check('real stdio initializes and discovers all 44 unique tools', async () => {
    const result = await client.listTools();
    assert.equal(result.tools.length,44); assert.equal(new Set(result.tools.map(t=>t.name)).size,44);
  });
  await check('real transport reads generated native widgets', async () => {
    const result = await call('rp_read',{args:[source,'--json']});
    assert.equal(result.exitCode,0); assert.equal(JSON.parse(result.stdout).counts.widgets,5);
  });
  await check('global-variable named default passes through stdio to native storage', async () => {
    const output=join(work,'variable.rp');
    const result=await call('create_global_variable',{source,output,name:'TransportCounter',defaultValue:'13'});
    assert.equal(result.exitCode,0);
    assert.ok(readRp(readFileSync(output)).globalVariables.some(v=>v.name==='TransportCounter'&&v.value==='13'));
  });
  await check('session rich-text link/list/spacing survives save and re-read', async () => {
    await call('axure_open',{path:source});
    const spec=JSON.parse(readFileSync(join(root,'examples/richtext.json')));
    await call('edit_text',{target:{name:'StatusBanner'},richRuns:spec.paragraphs});
    const output=join(work,'saved.rp');await call('axure_save',{as:output});
    const rp=readRp(readFileSync(output));
    assert.equal(rp.pages[0].widgets.find(w=>w.name==='StatusBanner').text,'Notice: Documentation');
    assert.ok(rp.pages[0].widgets.some(w=>w.type==='Hyperlink'));assert.equal(rp.counts.problems,0);
    const verification=await call('verify',{deep:true}); assert.equal(verification.structure.problems,0);
  });
  await check('raw session variable call advances the working chain', async () => {
    const result=await call('create_global_variable',{session:true,args:['SessionCounter','--default-value','17']});
    assert.equal(result.exitCode,0);
    assert.ok(readRp(readFileSync(result.chainTail)).globalVariables.some(v=>v.name==='SessionCounter'&&v.value==='17'));
  });
  await check('quick rename preserves content/events and rejects ambiguous batches atomically', async () => {
    const beforeState = await call('axure_state', {});
    const before = readRp(readFileSync(beforeState.chain.at(-1)));
    const result = await call('rename_widget', { target: { name: 'StatusBanner' }, name: '中文 状态 ★' });
    const after = readRp(readFileSync(result.chainTail));
    assert.equal(after.pages[0].widgets.find(w => w.name === '中文 状态 ★').text, 'Notice: Documentation');
    assert.deepEqual(after.counts, before.counts);
    const other = after.pages[0].widgets.find(w => w.name && w.name !== '中文 状态 ★');
    await call('rename_widget', { target: { name: other.name }, name: '中文 状态 ★' });
    const stable = await call('axure_state', {});
    const failed = await client.callTool({ name: 'rename_widget', arguments: { edits: [
      { target: { name: '中文 状态 ★' }, name: 'must not commit' },
      { target: { name: 'missing' }, name: 'missing' },
    ] } });
    assert(failed.isError);
    assert.deepEqual((await call('axure_state', {})).chain, stable.chain);
    const target = (await call('locate', { query: '中文 状态 ★' })).candidates[0];
    const exact = await call('rename_widget', { target: { record: target.record, id: target.id }, name: '精确改名' });
    assert.equal(readRp(readFileSync(exact.chainTail)).counts.problems, 0);
    const both = (await call('locate', { query: '中文 状态 ★' })).candidates[0];
    const start = (await call('axure_state', {})).chain.length;
    const bulk = await call('rename_widget', { edits: [
      { target: { name: '精确改名' }, name: '批量一' },
      { target: { record: both.record, id: both.id }, name: '批量二' },
    ] });
    assert.equal(bulk.edits.length, 2);
    assert.equal((await call('axure_state', {})).chain.length, start + 1);
  });
  await check('stdio rejects unknown rich-text fields and protected paths', async () => {
    const invalid=await client.callTool({name:'edit_text',arguments:{target:{name:'StatusBanner'},richRuns:[{runs:[{text:'x'}],unknown:true}]}});
    assert.ok(invalid.isError);
    const protectedResult=await client.callTool({name:'rp_read',arguments:{args:[env.AXURE_PROTECTED_PATHS]}});
    assert.ok(protectedResult.isError);
  });
} finally { await client.close(); rmSync(work,{recursive:true,force:true}); }
const failed=results.filter(r=>!r.passed).length;
console.log(JSON.stringify({evidence:'offline-stdio',total:results.length,passed:results.length-failed,failed}));
process.exitCode=failed?1:0;
