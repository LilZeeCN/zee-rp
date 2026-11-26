import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRp } from '../scripts/rp-read.mjs';
import { listCommands } from '../scripts/registry.mjs';
import { jobTools, listMcpTools } from '../scripts/mcp-tools.mjs';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withMcpClient({ cwd, env = {} }, fn) {
  const mergedEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(([, v]) => typeof v === 'string')
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(skillRoot, 'bin/mcp.mjs')],
    cwd,
    env: mergedEnv,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mcp-convergence-workdir-check', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parseToolJson(res) {
  assert.ok(res?.content?.[0]?.text, 'Expected text payload from MCP tool');
  return JSON.parse(res.content[0].text);
}

test('MCP surface exposes 30 tools, folds 34 CLI commands into rp_command, and returns migration hints for retired tools', async () => {
  const work = mkdtempSync(join(tmpdir(), 'zee-mcp-conv-'));
  try {
    await withMcpClient({ cwd: work }, async client => {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name).sort();
      const expected = [...listMcpTools(), ...jobTools].map(t => t.name).sort();
      assert.equal(expected.length, 30);
      assert.deepEqual(names, expected);

      const studioTools = names.filter(n => n.startsWith('studio_'));
      assert.equal(studioTools.length, 13);
      for (const required of [
        'axure_open', 'axure_save', 'rp_inspect', 'rp_patch', 'rp_command',
        'prototype_recipe', 'generate_prototype', 'revise_prototype', 'sync_prototype',
        'diagnose_prototype', 'preview_prototype', 'export_prototype', 'verify_prototype',
        'runtime_info', 'generate_from_image', 'gui_roundtrip', 'jobs',
      ]) {
        assert.ok(names.includes(required), `Missing expected converged tool: ${required}`);
      }

      const descAllRes = await client.callTool({ name: 'rp_command', arguments: { action: 'describe' } });
      assert.ok(!descAllRes.isError, descAllRes.content[0].text);
      const descAll = parseToolJson(descAllRes);
      assert.equal(descAll.count, 34);
      assert.deepEqual(
        descAll.commands.map(c => c.command).sort(),
        listCommands().map(c => c.command).sort()
      );

      const retiredExpectations = [
        ['edit_text', /rp_patch/],
        ['set_widget_text', /rp_patch/],
        ['rename_widget', /rp_patch/],
        ['set_widget_geometry', /rp_patch/],
        ['set_widget_style', /rp_patch/],
        ['rename_custom_style', /rp_patch/],
        ['rebind_widgets', /rp_patch/],
        ['axure_state', /axure_save/],
        ['locate', /rp_inspect/],
        ['inspect', /rp_inspect/],
        ['read_interactions', /rp_inspect/],
        ['verify', /rp_inspect/],
        ['rp_read', /rp_inspect/],
        ['list_custom_styles', /rp_inspect/],
        ['explain_binding', /diagnose_prototype/],
        ['review_image_structure', /diagnose_prototype/],
        ['jobs_list', /jobs/],
        ['jobs_get', /jobs/],
        ['jobs_cancel', /jobs/],
        ['create_blank_page', /rp_command/],
      ];
      for (const [legacyName, hintPattern] of retiredExpectations) {
        const res = await client.callTool({ name: legacyName, arguments: {} });
        assert.ok(res.isError, `Retired tool ${legacyName} should return isError`);
        const payload = parseToolJson(res);
        assert.match(payload.message, hintPattern, `Unexpected migration message for ${legacyName}: ${payload.message}`);
        assert.equal(payload.availableTools.length, 30);
      }
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Local working directory allows free read/write even when legacy AXURE_WRITE_ROOT points elsewhere, while preserving protected/overwrite/system guardrails', { skip: nativeTemplateSkipReason() }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'zee-workdir-free-'));
  const legacyWhitelist = join(base, 'legacy-whitelist');
  const userWorkDir = join(base, 'user-project');
  const protectedDir = join(base, 'protected');
  mkdirSync(legacyWhitelist, { recursive: true });
  mkdirSync(userWorkDir, { recursive: true });
  mkdirSync(protectedDir, { recursive: true });
  const protectedRp = join(protectedDir, 'final.rp');
  writeFileSync(protectedRp, 'protected-artifact');

  try {
    await withMcpClient({
      cwd: userWorkDir,
      env: {
        AXURE_WRITE_ROOT: legacyWhitelist,
        AXURE_STRICT_WRITE_ROOT: '',
        AXURE_PROTECTED_PATHS: protectedRp,
      },
    }, async client => {
      const realUserWorkDir = realpathSync.native(userWorkDir);
      const realLegacyWhitelist = realpathSync.native(legacyWhitelist);

      // 1. generate_prototype output:"auto" with built-in recipe writes to userWorkDir (NOT legacyWhitelist)
      const genAutoRes = await client.callTool({
        name: 'generate_prototype',
        arguments: { recipe: 'list-detail', output: 'auto' },
      });
      assert.ok(!genAutoRes.isError, genAutoRes.content[0].text);
      const genAuto = parseToolJson(genAutoRes);
      assert.ok(realpathSync.native(genAuto.output).startsWith(realUserWorkDir), `Expected auto output in ${realUserWorkDir}, got ${genAuto.output}`);
      assert.ok(!realpathSync.native(genAuto.output).startsWith(realLegacyWhitelist));
      assert.ok(existsSync(genAuto.output));

      // 2. Explicit relative output resolves against userWorkDir
      const genRelRes = await client.callTool({
        name: 'generate_prototype',
        arguments: { recipe: 'step-form', output: 'sub/step-form-local.rp' },
      });
      assert.ok(!genRelRes.isError, genRelRes.content[0].text);
      const genRel = parseToolJson(genRelRes);
      assert.equal(realpathSync.native(genRel.output), realpathSync.native(join(userWorkDir, 'sub/step-form-local.rp')));
      assert.ok(existsSync(genRel.output));

      // 3. revise_prototype output:"auto" writes into local source directory cleanly
      const revRes = await client.callTool({
        name: 'revise_prototype',
        arguments: {
          source: genAuto.source,
          rp: genAuto.output,
          output: 'auto',
          operations: [{ path: '/palette/brand', value: '#2563EB' }],
        },
      });
      assert.ok(!revRes.isError, revRes.content[0].text);
      const rev = parseToolJson(revRes);
      assert.ok(realpathSync.native(rev.output).startsWith(realUserWorkDir));
      assert.ok(existsSync(rev.output));

      // 4. Native session chain (axure_open -> rp_inspect -> rp_patch -> rp_command -> axure_save) works in userWorkDir
      const openRes = await client.callTool({ name: 'axure_open', arguments: { path: genRel.output } });
      assert.ok(!openRes.isError, openRes.content[0].text);
      const opened = parseToolJson(openRes);
      assert.deepEqual(opened.structure, { unparseable: 0, danglingRefs: 0, problems: 0 });

      const locRes = await client.callTool({ name: 'rp_inspect', arguments: { view: 'locate', query: '' } });
      assert.ok(!locRes.isError, locRes.content[0].text);
      const firstNamed = parseToolJson(locRes).candidates.find(c => c.name && c.text);
      assert.ok(firstNamed, 'Expected at least one named widget');

      const patchRes = await client.callTool({
        name: 'rp_patch',
        arguments: { target: { record: firstNamed.record, id: firstNamed.id }, text: '本地自由目录已生效' },
      });
      assert.ok(!patchRes.isError, patchRes.content[0].text);

      const cmdRes = await client.callTool({
        name: 'rp_command',
        arguments: { action: 'run', command: 'create-blank-page', session: true, args: ['ExtraLocalPage'] },
      });
      assert.ok(!cmdRes.isError, cmdRes.content[0].text);

      const stateSnap = parseToolJson(await client.callTool({ name: 'axure_save', arguments: {} }));
      assert.equal(stateSnap.active, true);
      assert.equal(stateSnap.chain.length, 3);

      const saveRelRes = await client.callTool({ name: 'axure_save', arguments: { as: 'saved-local.rp' } });
      assert.ok(!saveRelRes.isError, saveRelRes.content[0].text);
      const savedLocalPath = join(userWorkDir, 'saved-local.rp');
      assert.ok(existsSync(savedLocalPath));
      assert.equal(readRp(readFileSync(savedLocalPath)).pages.some(p => p.name === 'ExtraLocalPage'), true);

      // 5. Safety guardrails remain enforced:
      // 5a) Anti-overwrite (overwrite=false by default)
      const overwriteDenied = await client.callTool({ name: 'axure_save', arguments: { as: 'saved-local.rp' } });
      assert.ok(overwriteDenied.isError);

      // 5b) Protected path (direct & symlink)
      const directProt = await client.callTool({ name: 'axure_open', arguments: { path: protectedRp } });
      assert.ok(directProt.isError);
      assert.match(directProt.content[0].text, /受保护/);

      const linkProt = join(userWorkDir, 'link-to-final.rp');
      symlinkSync(protectedRp, linkProt);
      const symlinkProt = await client.callTool({ name: 'rp_inspect', arguments: { view: 'overview', path: linkProt } });
      assert.ok(symlinkProt.isError);
      assert.match(symlinkProt.content[0].text, /受保护/);

      // 5c) System directory & skill install root write block
      const sysBlocked = await client.callTool({
        name: 'rp_command',
        arguments: { action: 'run', command: 'create-blank-project', args: ['/System/forbidden-zee.rp'] },
      });
      assert.ok(sysBlocked.isError);
      assert.match(sysBlocked.content[0].text, /系统目录|禁止/);

      const skillBlocked = await client.callTool({
        name: 'rp_command',
        arguments: { action: 'run', command: 'create-blank-project', args: [join(skillRoot, 'forbidden-in-skill-root.rp')] },
      });
      assert.ok(skillBlocked.isError);
      assert.match(skillBlocked.content[0].text, /技能安装目录|禁止/);
      assert.ok(!existsSync(join(skillRoot, 'forbidden-in-skill-root.rp')));
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Explicit opt-in AXURE_STRICT_WRITE_ROOT=1 enforces strict AXURE_WRITE_ROOT directory sandbox', { skip: nativeTemplateSkipReason() }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'zee-workdir-strict-'));
  const strictRoot = join(base, 'allowed-root');
  const outsideDir = join(base, 'outside-dir');
  mkdirSync(strictRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  try {
    await withMcpClient({
      cwd: outsideDir,
      env: {
        AXURE_WRITE_ROOT: strictRoot,
        AXURE_STRICT_WRITE_ROOT: '1',
      },
    }, async client => {
      const deniedOutside = await client.callTool({
        name: 'rp_command',
        arguments: { action: 'run', command: 'create-blank-project', args: [join(outsideDir, 'blocked.rp')] },
      });
      assert.ok(deniedOutside.isError);
      assert.match(deniedOutside.content[0].text, /AXURE_STRICT_WRITE_ROOT|AXURE_WRITE_ROOT/);
      assert.ok(!existsSync(join(outsideDir, 'blocked.rp')));

      const allowedInside = await client.callTool({
        name: 'rp_command',
        arguments: { action: 'run', command: 'create-blank-project', args: [join(strictRoot, 'allowed.rp')] },
      });
      assert.ok(!allowedInside.isError, allowedInside.content[0].text);
      assert.ok(existsSync(join(strictRoot, 'allowed.rp')));
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
