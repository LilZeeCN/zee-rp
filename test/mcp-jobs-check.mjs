import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const skill = dirname(dirname(fileURLToPath(import.meta.url)));
const serverRoot = process.env.AXURE_MCP_TEST_ROOT ?? skill;
const outputDir = resolve(process.argv[2] ?? 'gui-jobs-check');
mkdirSync(outputDir, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
env.AXURE_WRITE_ROOT = outputDir;
const client = new Client({ name: 'axure-mcp-gui-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(serverRoot, 'bin/mcp.mjs')], env, stderr: 'pipe' });
const results = [];
const call = async (name, input) => {
  const response = await client.callTool({ name, arguments: input });
  assert.ok(!response.isError, response.content[0].text);
  return JSON.parse(response.content[0].text);
};
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); console.log(`PASS  ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL  ${name} — ${error.message}`); }
};
let handle;
try {
  await client.connect(transport);
  await check('MCP 暴露 31 个命令、8 个意图与 4 个 job 工具', async () => assert.equal((await client.listTools()).tools.length, 43));
  await check('gui_roundtrip 默认返回排队句柄', async () => {
    handle = await call('gui_roundtrip', { source: fixturePath('var-set-counter-roundtrip.rp'), output: join(outputDir, 'mcp-gui-counter.rp') });
    assert.equal(handle.status, 'queued'); assert.ok(handle.id);
  });
  await check('jobs_list/get 与排队取消', async () => {
    assert.ok((await call('jobs_list', {})).some(j => j.id === handle.id));
    const queued = await call('gui_roundtrip', { source: fixturePath('blank-ui-native.rp'), output: join(outputDir, 'cancelled-queued.rp') });
    assert.equal((await call('jobs_cancel', { id: queued.id })).status, 'cancelled');
    assert.equal((await call('jobs_get', { id: queued.id })).status, 'cancelled');
  });
  await check('真实 GUI 保存关闭重开与分层结果', async () => {
    const deadline = Date.now() + 30000;
    let job;
    while (Date.now() < deadline) {
      job = await call('jobs_get', { id: handle.id });
      if (!['queued', 'running'].includes(job.status)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    writeFileSync(join(outputDir, 'mcp-job-result.json'), JSON.stringify(job, null, 2) + '\n', { flag: 'wx' });
    assert.equal(job.status, 'completed', JSON.stringify(job));
    for (const key of ['structure', 'guiSaved', 'closed', 'reopened']) assert.equal(job.validation[key], true);
    assert.equal(job.validation.preview, false); assert.equal(job.validation.guiEdited, false);
  });
  await check('未知句柄和非法参数拒绝', async () => {
    assert.ok((await client.callTool({ name: 'jobs_get', arguments: { id: 'missing' } })).isError);
    assert.ok((await client.callTool({ name: 'jobs_list', arguments: { extra: true } })).isError);
  });
} finally { await client.close(); }
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ total: results.length, passed: results.length - failed, failed, results }));
process.exitCode = failed ? 1 : 0;
