import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.AXURE_MCP_EXPORT_OUTPUT;
const browserModule = process.env.PLAYWRIGHT_MODULE;
const verifyHost = process.env.AXURE_MCP_EXPORT_HOST === '1';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function session(run, env = {}) {
  const dir = evidence ? resolve(evidence) : mkdtempSync(join(tmpdir(), 'zee-rp-export-'));
  if (evidence) mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(dir, 'stdio-'));
  const client = new Client({ name: 'zee-rp-export-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/mcp.mjs')],
    cwd: work, stderr: 'pipe', env: { ...process.env, AXURE_WRITE_ROOT: work,
      AXURE_PROTECTED_PATHS: join(work, 'protected.rp'), ...env } });
  try {
    await client.connect(transport);
    const call = async (name, args = {}, isError = false) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
      assert.equal(Boolean(result.isError), isError, result.content[0].text);
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    return await run({ client, call, work: realpathSync(work) });
  } finally {
    await client.close();
    if (!evidence) rmSync(dir, { recursive: true, force: true });
  }
}

test('agent can discover official export and a runnable native-interaction recipe from MCP alone', async () => {
  await session(async ({ client, call }) => {
    assert.match(client.getInstructions(), /generate_prototype.*export_prototype.*gui_roundtrip/);
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'export_prototype');
    assert.deepEqual(tool.inputSchema.required, ['rp']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, false);
    const generation = tools.find(t => t.name === 'generate_prototype');
    assert(generation.inputSchema.properties.recipe.enum.includes('native-gestures'));
    const catalog = await call('prototype_recipe', { recipe: 'native-gestures', includeSource: true });
    assert.match(catalog.recipes[0].sourceText, /onSwipeLeft/);
    assert.deepEqual(catalog.recipes[0].pages, ['demo']);
    assert.deepEqual(catalog.recipes[0].generate, { tool: 'generate_prototype',
      arguments: { recipe: 'native-gestures', output: 'native-gestures.rp' } });
    const runtime = await call('runtime_info');
    assert.equal(runtime.host.officialHtml.tool, 'export_prototype');
    assert.equal(runtime.host.officialHtml.generatorSettings, 'fresh-defaults');
    assert.equal(runtime.restartRequired, false);
  });
});

test('MCP export protects files and returns recovery guidance for invalid input and missing host', async () => {
  const missingInstallation = join(tmpdir(), 'zee-rp-export-no-such-axure.app');
  await session(async ({ call, work }) => {
    writeFileSync(join(work, 'plain.rp'), 'a non-Axure file');
    const header = Buffer.from([0xac, 0xef, 9, 0, 0, 0, 0, 0]);
    writeFileSync(join(work, 'probe.rp'), header);
    writeFileSync(join(work, 'protected.rp'), header);
    const incompatibleOptions = await call('generate_prototype', {
      recipe: 'native-gestures', output: 'conflict.rp', includeImage: true, async: true,
    }, true);
    assert.equal(incompatibleOptions.diagnostics[0].code, 'E_PREVIEW_IMAGE_ASYNC');
    const invalid = await call('export_prototype', { rp: 'plain.rp' }, true);
    assert.equal(invalid.diagnostics[0].code, 'E_HTML_RP');
    assert.match(invalid.diagnostics[0].nextAction, /generate_prototype/);
    const protectedInput = await call('export_prototype', { rp: 'protected.rp' }, true);
    assert.match(protectedInput.diagnostics[0].message, /受保护/);
    assert(!existsSync(join(work, 'protected-html')));
    mkdirSync(join(work, 'probe-html'));
    writeFileSync(join(work, 'probe-html', 'sentinel.txt'), 'preserve');
    const occupied = await call('export_prototype', { rp: 'probe.rp' }, true);
    assert.equal(occupied.diagnostics[0].code, 'E_HTML_OUTPUT_EXISTS');
    assert.equal(readFileSync(join(work, 'probe-html', 'sentinel.txt'), 'utf8'), 'preserve');
    const unavailable = await call('export_prototype', { rp: 'probe.rp', output: 'new-html' }, true);
    assert.equal(unavailable.stage, 'assembly');
    assert.equal(unavailable.rpVersion, 9);
    assert.match(unavailable.diagnostics[0].code, /^E_ASSEMBLY_(INSTALL|PLATFORM)$/);
    assert.match(unavailable.diagnostics[0].nextAction, /runtime_info/);
    assert(!existsSync(join(work, 'new-html')));
  }, { AXURE_APP_RP9: missingInstallation });
});

function runBrowser(work, scenario, html, expected) {
  const args = [join(root, 'tools/native-assembly/browser-check.mjs'), scenario, html];
  if (expected !== undefined) args.push(expected);
  const raw = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 45_000 });
  writeFileSync(join(work, `browser-${scenario}.json`), raw);
  return JSON.parse(raw);
}

test('RP/1 recipe → native RP9 → official HTML → real browser', {
  skip: !verifyHost && 'Set AXURE_MCP_EXPORT_HOST=1 on a verified macOS Axure host.',
}, async () => {
  await session(async ({ client, call, work }) => {
    const { recipes } = await call('prototype_recipe', { recipe: 'native-gestures' });
    const action = recipes[0].generate;
    const response = await client.callTool({ name: action.tool, arguments: { ...action.arguments, includeImage: true } },
      undefined, { timeout: 180_000 });
    assert.ok(!response.isError, response.content[0].text);
    const generated = response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.equal(generated.previewImage, 'attached');
    const image = response.content.find(part => part.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(image.data, 'base64'), readFileSync(generated.contactSheet));
    assert.equal(generated.verification.structure, true);
    const before = hash(generated.output);
    const exportAction = generated.nextActions.find(next => next.tool === 'export_prototype');
    const exported = await call(exportAction.tool, exportAction.arguments);
    assert.equal(exported.rpVersion, 9);
    assert.equal(exported.axureBuild, '9.0.0.3754');
    assert.equal(exported.entry, join(exported.output, 'start.html'));
    assert(existsSync(join(exported.output, 'data/document.js')));
    assert.deepEqual(exported.verification, { officialHtmlExported: true, browserLoaded: false, behaviorVerified: false });
    assert.equal(hash(generated.output), before);
    writeFileSync(join(work, 'export.json'), JSON.stringify(exported, null, 2) + '\n');
    assert(browserModule, 'Set PLAYWRIGHT_MODULE to run the native browser acceptance.');
    assert.equal(runBrowser(work, 'rp1-native', exported.output).assertions.length, 10);
  });
});

test('existing RP11 → official HTML → native textbox behavior', {
  skip: (!verifyHost || !process.env.AXURE_MCP_EXPORT_RP11) && 'Provide a verified RP11 textbox fixture with maxlength=7.',
}, async () => {
  await session(async ({ call, work }) => {
    const source = resolve(process.env.AXURE_MCP_EXPORT_RP11);
    const localCopy = join(work, 'input-rp11.rp');
    writeFileSync(localCopy, readFileSync(source), { flag: 'wx' });
    const before = hash(localCopy);
    const exported = await call('export_prototype', { rp: localCopy, output: 'rp11-html' });
    assert.equal(exported.rpVersion, 11);
    assert.equal(exported.axureBuild, '11.0.0.4137');
    assert.equal(hash(localCopy), before);
    assert(existsSync(exported.entry));
    writeFileSync(join(work, 'export.json'), JSON.stringify(exported, null, 2) + '\n');
    assert(browserModule, 'Set PLAYWRIGHT_MODULE to run the native browser acceptance.');
    assert.equal(runBrowser(work, 'maxlength', exported.output, '7').assertions.length, 2);
  });
});
