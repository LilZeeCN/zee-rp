// Public, zero-dependency checks: no Axure installation or private workspace required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandSpec, resetIds } from '../scripts/axvg.mjs';
import { listCommands } from '../scripts/registry.mjs';
import { listMcpTools, jobTools, validateInput } from '../scripts/mcp-tools.mjs';
import { encodeStyleEntry } from '../scripts/set-widget-richtext.mjs';
import { assertNotProtected, assertWritable } from '../scripts/engine.mjs';
import { packRelease, releasePaths } from '../scripts/pack-release.mjs';
import { renderLayout } from '../examples/render-layout.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'zee-rp-core-'));
const results = [];
function check(name, action) {
  try { action(); results.push({ name, passed: true }); console.log(`PASS  ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL  ${name} — ${error.message}`); }
}
function run(file, args = []) {
  return spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
try {
  check('all public JavaScript sources parse', () => {
    for (const dir of ['bin', 'scripts', 'test', 'examples']) {
      for (const file of readdirSync(join(root, dir)).filter(f => f.endsWith('.mjs'))) {
        const result = run('--check', [join(root, dir, file)]);
        assert.equal(result.status, 0, `${dir}/${file}: ${result.stderr}`);
      }
    }
  });
  check('registry covers every production script', () => assert.equal(run('scripts/registry.mjs', ['validate']).status, 0));
  check('CLI and MCP expose the global-variable writer', () => {
    assert.ok(listCommands().some(c => c.command === 'create-global-variable'));
    assert.ok(listMcpTools().some(t => t.name === 'create_global_variable'));
    assert.match(run('bin/axure.mjs', ['create-global-variable', '--help']).stdout, /--default-value/);
  });
  check('MCP tool names are unique and cover CLI commands', () => {
    const tools = [...listMcpTools(), ...jobTools];
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    for (const command of listCommands()) assert.ok(tools.some(t => t.name === command.command.replaceAll(/[ -]/g, '_')));
  });
  check('MCP accepts paragraph list/wrapping/trimming/spacing/link fields', () => {
    const schema = listMcpTools().find(t => t.name === 'edit_text').inputSchema;
    validateInput(schema, { target: {name:'StatusBanner'},
      richRuns: [{ list: true, wrapping: 1, trimming: 2, lineSpacing: 72, runs: [{ text: 'Docs', link: { url: 'https://example.com', window: 'new' } }] }] });
    assert.throws(() => validateInput(schema, { target:{name:'W'}, richRuns: [{ runs: [{text:'x'}], unknown: true }] }));
  });
  check('MCP global-variable named arguments include the default value', () => {
    const schema = listMcpTools().find(t => t.name === 'create_global_variable').inputSchema;
    validateInput(schema, { source: '/s.rp', output: '/o.rp', name: 'Counter', defaultValue: '7' });
    assert.throws(() => validateInput(schema, { source: '/s.rp', output: '/o.rp' }));
  });
  check('MCP generation schema exposes structured pages and restricts native target', () => {
    const schema = listMcpTools().find(t => t.name === 'generate_prototype').inputSchema;
    validateInput(schema, { spec: { pages: [{ id: 'home', root: { type: 'label', id: 'title', text: 'Hello' } }] }, output: '/new.rp' });
    assert.throws(() => validateInput(schema, { spec: { pages: [] }, output: '/new.rp' }));
    assert.throws(() => validateInput(schema, { spec: { target: 11, pages: [{ id: 'home' }] }, output: '/new.rp' }));
  });
  check('Axvg public example builds deterministically', () => {
    const spec = JSON.parse(readFileSync(join(root, 'assets/dashboard-example.spec.json')));
    resetIds(); const first = expandSpec(spec); resetIds(); const second = expandSpec(spec);
    assert.deepEqual(first, second); assert.ok(first.scene.items[0].scene.items.length > 10);
  });
  check('Axvg encoding selftest', () => assert.match(run('scripts/axvg.mjs', ['selftest']).stdout, /selftest OK/));
  check('published reference SVG matches the authored public specification', () => {
    const spec = JSON.parse(readFileSync(join(root, 'assets/dashboard-example.spec.json')));
    assert.equal(readFileSync(join(root, 'assets/demo-layout.svg'), 'utf8'), renderLayout(spec));
  });
  check('all published Markdown file links resolve within the release', () => {
    const paths = new Set(releasePaths());
    for (const path of paths) {
      if (!path.endsWith('.md')) continue;
      const text = readFileSync(join(root, path), 'utf8');
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!href || /^[a-zA-Z]+:/.test(href)) continue;
        const destination = join(dirname(path), href);
        assert.ok(paths.has(destination), `${path}: ${href}`);
      }
    }
  });
  check('rich text style validation rejects unsupported or invalid values', () => {
    assert.throws(() => encodeStyleEntry('fontSize', 18));
    assert.throws(() => encodeStyleEntry('size', -1));
    assert.equal(encodeStyleEntry('bold', true).value, 700);
    assert.equal(encodeStyleEntry('color', '#2563EB').value, 0xff2563eb);
  });
  check('path guard rejects protected inputs and symlink targets', () => {
    const protectedPath = join(work, 'protected.rp');
    process.env.AXURE_PROTECTED_PATHS = protectedPath;
    assert.throws(() => assertNotProtected(protectedPath), /受保护/);
    const link = join(work, 'protected-link.rp'); symlinkSync(protectedPath, link);
    assert.throws(() => assertNotProtected(link), /受保护/);
    delete process.env.AXURE_PROTECTED_PATHS;
  });
  check('path guard rejects writes outside the allowed directory', () => {
    process.env.AXURE_WRITE_ROOT = work;
    assertWritable(join(work, 'allowed.json'));
    assert.throws(() => assertWritable(join(tmpdir(), 'zee-rp-outside.json')), /AXURE_WRITE_ROOT/);
    delete process.env.AXURE_WRITE_ROOT;
  });
  check('release selection excludes native files, symlinks, and fixture payloads', () => {
    const probe = join(work, 'probe'); mkdirSync(join(probe, 'scripts'), { recursive: true });
    mkdirSync(join(probe, 'test/fixtures'), { recursive: true });
    writeFileSync(join(probe, 'scripts/public.mjs'), 'export const ok = true;');
    writeFileSync(join(probe, 'scripts/private.rp'), 'native');
    writeFileSync(join(probe, 'test/fixtures/private.json'), 'private');
    symlinkSync(join(probe, 'test/fixtures/private.json'), join(probe, 'scripts/link.json'));
    assert.deepEqual(releasePaths(probe), ['scripts/public.mjs']);
    writeFileSync(join(probe, 'package.json'), JSON.stringify({ files: ['test/public-check.mjs'] }));
    writeFileSync(join(probe, 'test/public-check.mjs'), 'export const publicCheck = true;');
    writeFileSync(join(probe, 'test/local-research.mjs'), 'export const localOnly = true;');
    assert.deepEqual(releasePaths(probe), ['package.json', 'scripts/public.mjs', 'test/public-check.mjs']);
  });
  check('release preserves all public implementations, tests, bilingual docs, and examples', () => {
    const output = join(work, 'release'); packRelease(output);
    for (const path of releasePaths()) assert.deepEqual(readFileSync(join(output, path)), readFileSync(join(root, path)), path);
    assert.ok(existsSync(join(output, 'scripts/expr-schema.mjs')));
    assert.ok(existsSync(join(output, 'test/historical-regression.mjs')));
    assert.ok(existsSync(join(output, 'README.zh-CN.md')));
    assert.equal(run(join(output, 'scripts/registry.mjs'), ['validate']).status, 0);
  });
  check('source baseline fingerprints match every registered script', () => {
    const baseline = JSON.parse(readFileSync(join(root, 'test/baseline-shas.json')));
    for (const [file, hash] of Object.entries(baseline))
      assert.equal(createHash('sha256').update(readFileSync(join(root, 'scripts', file))).digest('hex'), hash, file);
    assert.equal(Object.keys(baseline).length, readdirSync(join(root, 'scripts')).filter(f => f.endsWith('.mjs')).length);
  });
} finally { rmSync(work, { recursive: true, force: true }); }
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ total: results.length, passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
