import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBlankTemplate } from '../scripts/blank-template.mjs';
import { jobTools, listMcpTools } from '../scripts/mcp-tools.mjs';

let Client, StdioClientTransport;
try {
  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
} catch (err) {
  if (process.argv.includes('--allow-missing-sdk') || process.env.AXURE_ALLOW_MISSING_SDK === '1') {
    test('MCP jobs stdio check skipped (missing optional @modelcontextprotocol/sdk)', { skip: true }, () => {});
    process.exit(0);
  }
  throw err;
}

const skill = dirname(dirname(fileURLToPath(import.meta.url)));
const serverRoot = process.env.AXURE_MCP_TEST_ROOT ?? skill;
const outputDir = mkdtempSync(join(tmpdir(), 'axure-mcp-jobs-check-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
env.AXURE_WRITE_ROOT = outputDir;
const client = new Client({ name: 'axure-mcp-jobs-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(serverRoot, 'bin/mcp.mjs')], env, stderr: 'pipe' });

after(async () => {
  try { await client.close(); } catch {}
  try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
});

const call = async (name, input) => {
  const response = await client.callTool({ name, arguments: input });
  assert.ok(!response.isError, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};

await client.connect(transport);

test('MCP 暴露完整注册表与 4 个 job 队列工具', async () => {
  const expected = [...listMcpTools(), ...jobTools].map(t => t.name).sort();
  const actual = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(actual, expected);
});

test('异步队列提交、jobs_list/jobs_get 轮询与排队任务取消', async () => {
  const firstOut = join(outputDir, 'async-first.rp');
  const secondOut = join(outputDir, 'async-cancelled.rp');
  const first = await call('generate_prototype', { recipe: 'mobile-cards', output: firstOut, async: true });
  const second = await call('generate_prototype', { recipe: 'step-form', output: secondOut, async: true });
  assert.ok(first.id);
  assert.ok(second.id);
  assert.ok(['queued', 'running'].includes(first.status));

  const cancelled = await call('jobs_cancel', { id: second.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await call('jobs_get', { id: second.id })).status, 'cancelled');

  const list = await call('jobs_list', {});
  assert.ok(list.some(j => j.id === first.id));

  const deadline = Date.now() + 45000;
  let finalJob = await call('jobs_get', { id: first.id });
  while (Date.now() < deadline && ['queued', 'running'].includes(finalJob.status)) {
    await new Promise(r => setTimeout(r, 150));
    finalJob = await call('jobs_get', { id: first.id });
  }
  assert.equal(finalJob.status, 'completed', JSON.stringify(finalJob));
  assert.equal(existsSync(firstOut), true);
});

test('未知句柄和非法参数拒绝', async () => {
  assert.ok((await client.callTool({ name: 'jobs_get', arguments: { id: 'missing-job-id' } })).isError);
  assert.ok((await client.callTool({ name: 'jobs_list', arguments: { extra: true } })).isError);
});

test('可选真实 macOS GUI 保存关闭重开往返', { skip: process.env.AXURE_RUN_LIVE_GUI !== '1' }, async () => {
  const handle = await call('gui_roundtrip', { source: resolveBlankTemplate(), output: join(outputDir, 'mcp-gui-roundtrip.rp') });
  const deadline = Date.now() + 45000;
  let job = handle;
  while (Date.now() < deadline && ['queued', 'running'].includes(job.status)) {
    await new Promise(r => setTimeout(r, 150));
    job = await call('jobs_get', { id: handle.id });
  }
  assert.equal(job.status, 'completed', JSON.stringify(job));
  for (const key of ['structure', 'guiSaved', 'closed', 'reopened']) {
    assert.equal(job.validation[key], true);
  }
});
