// A recording transport around the public Studio tools; it never authors a design.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const load = path => import(pathToFileURL(join(config.runtimeRoot, path)));
const [{ startStudioServer }, { studioHandlers, studioTools }, { validateInput }] = await Promise.all([
  load('studio/server.mjs'), load('studio/mcp-adapter.mjs'), load('scripts/mcp-tools.mjs'),
]);
const { studio } = await startStudioServer({ projectDir: config.projectDir, sourcePath: config.sourcePath, port: 0 });
mkdirSync(config.receiptsDir, { recursive: true });
writeFileSync(config.instancePath, JSON.stringify({ url: studio.url, projectDir: studio.projectDir, pid: process.pid, initialBinding: { revision: studio.store.doc.revision, contentHash: studio.store.doc.contentHash } }));
const excluded = new Set(['studio_sync_native', 'studio_merge_document', 'studio_project_bundle']);
const tools = studioTools.filter(t => !excluded.has(t.name)).map(t => {
  const inputSchema = structuredClone(t.inputSchema);
  for (const field of ['url', 'port', 'projectDir']) delete inputSchema.properties[field];
  if (inputSchema.required) inputSchema.required = inputSchema.required.filter(f => !['url', 'port', 'projectDir'].includes(f));
  return { name: t.name, description: t.description, inputSchema };
});
writeFileSync(join(config.receiptsDir, '..', 'tool-schema.json'), JSON.stringify(tools, null, 2));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let firstMutation = null, counter = 0, queue = Promise.resolve(), closed = false;
const server = new Server({ name: 'studio-independent-trial', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, request => {
  const operation = async () => {
    const { name, arguments: args = {} } = request.params;
    const callId = `mcp-${++counter}`, startedAt = new Date().toISOString(), start = performance.now();
    const authoredMutation = ['studio_apply_commands', 'studio_undo', 'studio_redo'].includes(name)
      || name === 'studio_project_versions' && args.action === 'restore';
    if (authoredMutation && !firstMutation) firstMutation = callId;
    const row = { callId, parentCallId: null, eventKind: 'attempt', tool: name, phase: firstMutation ? 'creation' : 'discovery', authoredMutation,
      startedAt, endedAt: null, elapsedMs: null, status: 'uncertain', timeoutMs: 120000, requestSha256: hash(args), responseEvidenceId: `receipt-${counter}`, usage: null };
    const receiptPath = join(config.receiptsDir, `${String(counter).padStart(3, '0')}.json`);
    // Persist the attempt before execution, including an interrupted/uncertain call.
    const receipt = { row, request: { name, args }, result: null };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    let value;
    try {
      const tool = tools.find(t => t.name === name);
      if (!tool) throw new Error('Tool unavailable in this trial');
      validateInput(tool.inputSchema, args);
      if (counter > config.maxToolCalls) throw Object.assign(new Error('Trial call budget exhausted'), { code: 'E_TRIAL_BUDGET' });
      if (config.track === 'low-level' && name === 'studio_apply_commands' && (args.rp1 || args.sourceMode)) throw Object.assign(new Error('This track uses commands; RP/1 authoring is the compared track.'), { code: 'E_TRIAL_TRACK' });
      for (const field of ['outPath', 'outRpPath', 'outDir', 'outputDir']) if (args[field] && !resolve(args[field]).startsWith(resolve(config.workDir) + '/')) throw new Error('Trial outputs must stay inside its own work directory');
      if (name === 'studio_open_project' && args.sourcePath && !resolve(args.sourcePath).startsWith(resolve(config.workDir) + '/')) throw new Error('Only this trial project can be opened');
      value = await studioHandlers[name]({ ...args, url: studio.url, projectDir: studio.projectDir });
      row.status = value?.ok === false || value?.status === 'failed' ? 'error' : 'success';
    } catch (error) {
      value = { ok: false, code: error.code || 'E_TRIAL_TOOL', message: error.message,
        ...Object.fromEntries(['candidates', 'diagnostic', 'suggestion', 'binding'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) };
      row.status = 'error';
    }
    row.endedAt = new Date().toISOString(); row.elapsedMs = performance.now() - start;
    const { mcpImages = [], ...payload } = value;
    receipt.result = payload;
    receipt.images = mcpImages.map((image, index) => {
      const path = join(config.receiptsDir, `${counter}-${index}.png`);
      writeFileSync(path, Buffer.from(image.data, 'base64'));
      return { path, sha256: createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex') };
    });
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    appendFileSync(config.ledgerPath, JSON.stringify(row) + '\n');
    return { content: [{ type: 'text', text: JSON.stringify(payload) }, ...mcpImages.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data }))], isError: row.status !== 'success' };
  };
  const pending = queue.then(operation); queue = pending.catch(() => {}); return pending;
});
async function close() {
  if (closed) return; closed = true;
  await queue; await studio.close(); await server.close();
}
process.stdin.once('end', () => void close());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close().finally(() => process.exit(0)); });
await server.connect(new StdioServerTransport());
