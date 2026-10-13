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
  await check('real stdio initializes and discovers all 43 unique tools', async () => {
    const result = await client.listTools();
    assert.equal(result.tools.length,43); assert.equal(new Set(result.tools.map(t=>t.name)).size,43);
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
