// Public, zero-dependency checks: no Axure installation or private workspace required.
// 特殊形态保留理由（gaps #7）：公开零依赖主回归聚合器（npm test），负责串行调度设计度量套件并向 CI 输出机器 JSON 汇总。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, parse, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandSpec, resetIds } from '../scripts/axvg.mjs';
import { listCommands } from '../scripts/registry.mjs';
import { listMcpTools, jobTools, validateInput, callCommandTool } from '../scripts/mcp-tools.mjs';
import { encodeStyleEntry } from '../scripts/set-widget-richtext.mjs';
import { assertNotProtected, assertWritable, defaultWriteRoot } from '../scripts/engine.mjs';
import { spawnPythonSync } from '../scripts/python.mjs';
import { revisePrototype } from '../scripts/authoring-workflow.mjs';
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
  // 设计质量层的套件以前只能手动跑，CI 看不到；这里聚合进来。
  check('design quality suites (studio)', () => {
    const suites = [
      'test/studio-design-metrics-check.mjs',
      'test/studio-pixel-contrast-check.mjs',
      'test/studio-anti-gaming-check.mjs',
      'test/studio-consistency-check.mjs',
      'test/studio-fix-plan-check.mjs',
      'test/studio-content-plan-check.mjs',
    ];
    for (const file of suites) {
      console.log(`RUN   ${file}`);
      const result = spawnSync(process.execPath, [file], {
        cwd: root, stdio: 'inherit', timeout: 90_000, killSignal: 'SIGKILL',
      });
      assert.equal(result.status, 0, `${file}: ${result.error?.message ?? result.signal ?? 'failed'}`);
    }
  });
  check('all public JavaScript sources parse', () => {
    for (const dir of ['bin', 'scripts', 'test', 'examples', 'studio']) {
      for (const file of readdirSync(join(root, dir)).filter(f => f.endsWith('.mjs'))) {
        const result = run('--check', [join(root, dir, file)]);
        assert.equal(result.status, 0, `${dir}/${file}: ${result.stderr}`);
      }
    }
  });
  check('Axure host lifecycle helpers (driver contract + preview port identity)', () => {
    const result = run('test/host-lifecycle-check.mjs');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  check('registry covers every production script', () => assert.equal(run('scripts/registry.mjs', ['validate']).status, 0));
  check('CLI and converged MCP rp_command expose the global-variable writer', () => {
    assert.ok(listCommands().some(c => c.command === 'create-global-variable'));
    assert.ok(listMcpTools().some(t => t.name === 'rp_command'));
    const desc = JSON.parse(callCommandTool('rp_command', { action: 'describe', command: 'create-global-variable' }).content[0].text);
    assert.equal(desc.command, 'create-global-variable');
    assert.match(run('bin/axure.mjs', ['create-global-variable', '--help']).stdout, /--default-value/);
  });
  check('MCP tool names are unique (30 tools) and rp_command covers all registered CLI commands', () => {
    const tools = [...listMcpTools(), ...jobTools];
    assert.equal(tools.length, 30);
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    const catalog = JSON.parse(callCommandTool('rp_command', { action: 'describe' }).content[0].text);
    for (const command of listCommands()) assert.ok(catalog.commands.some(c => c.command === command.command));
  });
  check('MCP rp_patch accepts paragraph list/wrapping/trimming/spacing/link fields', () => {
    const schema = listMcpTools().find(t => t.name === 'rp_patch').inputSchema;
    validateInput(schema, { target: {name:'StatusBanner'},
      richRuns: [{ list: true, wrapping: 1, trimming: 2, lineSpacing: 72, runs: [{ text: 'Docs', link: { url: 'https://example.com', window: 'new' } }] }] });
    assert.throws(() => validateInput(schema, { target:{name:'W'}, richRuns: [{ runs: [{text:'x'}], unknown: true }] }));
  });
  check('MCP rp_command global-variable named arguments include the default value', () => {
    const desc = JSON.parse(callCommandTool('rp_command', { action: 'describe', command: 'create-global-variable' }).content[0].text);
    validateInput(desc.inputSchema, { source: '/s.rp', output: '/o.rp', name: 'Counter', defaultValue: '7' });
    assert.throws(() => validateInput(desc.inputSchema, { source: '/s.rp', output: '/o.rp' }));
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
    // SVG 是文本资源；Windows checkout 的 CRLF 不应影响等价性比较。
    assert.equal(readFileSync(join(root, 'assets/demo-layout.svg'), 'utf8').replace(/\r\n/g, '\n'), renderLayout(spec));
  });
  check('all published Markdown file links resolve within the release', () => {
    const paths = new Set(releasePaths());
    for (const path of paths) {
      if (!path.endsWith('.md')) continue;
      const text = readFileSync(join(root, path), 'utf8');
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!href || /^[a-zA-Z]+:/.test(href)) continue;
        // releasePaths 一律输出 POSIX 相对路径；Windows 的 path.join 会引入反斜杠。
        const destination = posix.normalize(posix.join(posix.dirname(path), href));
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
  check('path guard allows local working directories by default, blocks system/skill dirs, and honors opt-in AXURE_STRICT_WRITE_ROOT', () => {
    process.env.AXURE_WRITE_ROOT = [work, join(work, 'second')].join(delimiter);
    delete process.env.AXURE_STRICT_WRITE_ROOT;
    assertWritable(join(work, 'allowed.json'));
    assertWritable(join(tmpdir(), 'zee-rp-outside.json'));
    const sysBad = process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'bad.rp')
      : '/System/bad.rp';
    assert.throws(() => assertWritable(sysBad), /操作系统受保护目录/);
    assert.throws(() => assertWritable(join(root, 'bad.rp')), /技能安装目录/);
    process.env.AXURE_STRICT_WRITE_ROOT = '1';
    assert.throws(() => assertWritable(join(tmpdir(), 'zee-rp-outside.json')), /AXURE_WRITE_ROOT/);
    assert.equal(defaultWriteRoot(), work);
    assertWritable(join(work, 'second', 'allowed.json'));
    const child = join(work, 'first', 'child');
    mkdirSync(child, { recursive: true });
    assertWritable(join(realpathSync.native(work), 'physical-name.json'));
    const shortcut = join(work, 'shortcut');
    if (process.platform === 'win32') symlinkSync(child, shortcut, 'junction');
    else symlinkSync(join('first', 'child'), shortcut, 'dir');
    assertWritable(shortcut + sep + '..' + sep + 'project.json');
    process.env.AXURE_WRITE_ROOT = parse(work).root;
    assertWritable(join(work, 'root-allowed.json'));
    delete process.env.AXURE_STRICT_WRITE_ROOT;
    delete process.env.AXURE_WRITE_ROOT;
  });
  check('MCP file generation compiles RP/1 with the configured Python and a relative output', () => {
    const python = spawnPythonSync(['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    const outputRoot = join(work, 'MCP output');
    mkdirSync(outputRoot);
    const invalidTemplate = join(work, 'invalid-template.rp');
    writeFileSync(invalidTemplate, 'Not an Axure project');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
    // Public CI does not ship an Axure template. Require a completed compile and the expected native-template error.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { generatePrototype } from './scripts/mcp-tools.mjs';
      const [source, template] = process.argv.slice(1);
      console.log(JSON.stringify(generatePrototype({ source, template, output: '原型.rp', compact: false })));
    `, join(root, 'examples/authoring/mobile-cards.rp1'), invalidTemplate], {
      cwd: root, encoding: 'utf8', env: {
        ...env,
        PATH: work,
        ZEE_PYTHON: python.stdout.trim(),
        AXURE_WRITE_ROOT: [outputRoot, join(work, 'other output')].join(delimiter),
        AXURE_STRICT_WRITE_ROOT: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stage, 'native', JSON.stringify(report));
    assert.match(report.message, /不是可识别的 Axure 容器/);
    assert.equal(dirname(report.artifacts.directory), realpathSync.native(outputRoot));
    const failure = JSON.parse(readFileSync(join(report.artifacts.directory, 'last-failure.json'), 'utf8'));
    assert.equal(failure.stage, 'native');
    assert.match(failure.message, /不是可识别的 Axure 容器/);
    assert.ok(!existsSync(join(outputRoot, '原型.rp')));
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
    const manifest = JSON.parse(readFileSync(join(output, 'release-manifest.json'), 'utf8'));
    const paths = releasePaths();
    assert.deepEqual(Object.keys(manifest.files), paths);
    for (const path of paths) {
      const bytes = readFileSync(join(output, path));
      assert.deepEqual(bytes, readFileSync(join(root, path)), path);
      assert.equal(manifest.files[path], createHash('sha256').update(bytes).digest('hex'), path);
    }
    assert.ok(existsSync(join(output, '.gitattributes')));
    assert.ok(existsSync(join(output, 'scripts/expr-schema.mjs')));
    assert.ok(existsSync(join(output, 'test/historical-regression.mjs')));
    assert.ok(existsSync(join(output, 'test/host-lifecycle-check.mjs')));
    assert.ok(existsSync(join(output, 'README.zh-CN.md')));
    assert.equal(run(join(output, 'scripts/registry.mjs'), ['validate']).status, 0);
  });
  check('npm tarball includes runtime modules and shipped test entry points', () => {
    // Windows 上 npm 是 npm.cmd，必须经 shell 启动；其他平台保持直接调用。
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = spawnSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(packed.status, 0, packed.error?.message || packed.stderr);
    const paths = new Set(JSON.parse(packed.stdout)[0].files.map(file => file.path));
    assert.ok(paths.has('test/host-lifecycle-check.mjs'));
    const runtime = releasePaths().filter(path => /^(bin|scripts|studio)\//.test(path));
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const testEntrypoints = Object.values(scripts).flatMap(script => script.match(/\b(?:test|tools)\/[\w./-]+\.(?:mjs|py)\b/g) || []);
    const missing = [...new Set([...runtime, ...testEntrypoints])].filter(path => !paths.has(path));
    assert.deepEqual(missing, []);
  });
  check('layer gate detects side-effect import cycles and browser/MCP boundary violations', () => {
    const probe = join(work, 'layers');
    for (const dir of ['tools', 'studio/web', 'scripts']) mkdirSync(join(probe, dir), { recursive: true });
    const checker = join(probe, 'tools/check-layers.mjs');
    copyFileSync(join(root, 'tools/check-layers.mjs'), checker);
    writeFileSync(join(probe, 'studio/server.mjs'), "import './capture.mjs';\n");
    writeFileSync(join(probe, 'studio/capture.mjs'), "import './server.mjs';\n");
    writeFileSync(join(probe, 'studio/web/app.mjs'), "import fs from 'fs';\nimport '/server.mjs';\nimport './canvas.mjs';\n");
    writeFileSync(join(probe, 'studio/web/canvas.mjs'), "export const loadApp = () => import('./app.mjs');\n");
    writeFileSync(join(probe, 'scripts/mcp-tools.mjs'), "import '../studio/server.mjs';\n");
    const checked = run(checker);
    assert.equal(checked.status, 1);
    for (const diagnostic of [/A .*循环依赖.*studio\/server\.mjs/, /A .*循环依赖.*studio\/web\/app\.mjs/, /B .*Node 内建.*fs/, /B .*非同构模块.*server\.mjs/, /D .*越界引用/]) {
      assert.match(checked.stderr, diagnostic);
    }
  });
  check('revisePrototype publishes nested assets without ERR_FS_CP_EEXIST and protects occupied targets', () => {
    const revDir = join(work, 'revise-publish');
    mkdirSync(revDir, { recursive: true });
    const srcPath = join(revDir, 'app.rp1');
    const rpPath = join(revDir, 'app.rp');
    writeFileSync(srcPath, 'rp/1 target=9 name="Demo"\n\npage #home name="首页"\n  label #title [200x40] "旧标题"\n');
    writeFileSync(rpPath, 'stub-rp-v1');
    writeFileSync(`${rpPath}.baseline.json`, JSON.stringify({ version: 1 }) + '\n');
    const sync = ({ source, outSource }) => {
      copyFileSync(source, outSource);
      return { ok: true, summary: { state: 'in_sync' } };
    };
    const makeGenerate = onBeforeReturn => ({ source, output }) => {
      const buildDir = mkdtempSync(join(dirname(output), '.stub-build-'));
      mkdirSync(join(buildDir, 'states/nested'), { recursive: true });
      const preview = join(buildDir, 'states/nested/preview.png');
      const sheet = join(buildDir, 'pages-sheet.png');
      const ir = join(buildDir, 'language-ir.json');
      writeFileSync(preview, 'png');
      writeFileSync(sheet, 'sheet');
      writeFileSync(ir, JSON.stringify({ stagedSource: source, stagedOut: output, stagedDir: buildDir }) + '\n');
      writeFileSync(output, 'stub-rp-v2');
      writeFileSync(`${output}.baseline.json`, JSON.stringify({ version: 1, sourcePath: source, outputRp: output }) + '\n');
      onBeforeReturn?.();
      return {
        status: 'completed', output, baseline: `${output}.baseline.json`,
        previews: { home: preview }, contactSheet: sheet,
        artifacts: { directory: buildDir, ir },
        verification: { structure: true, preview: false },
        structure: { unparseable: 0, danglingRefs: 0, problems: 0 },
        eventCoverage: { declared: 0, materialized: 0 },
      };
    };
    const ops = [{ target: 'home/title', property: 'text', value: '新标题' }];
    const explicit = revisePrototype({ source: srcPath, rp: rpPath, output: join(revDir, 'explicit.rp'), operations: ops },
      { sync, generate: makeGenerate() });
    assert.equal(explicit.status, 'completed');
    assert.ok(existsSync(join(revDir, 'explicit.assets/states/nested/preview.png')));
    assert.ok(existsSync(explicit.report));
    assert.ok(!readFileSync(explicit.artifacts.ir, 'utf8').includes('.revision-'));
    assert.ok(!readdirSync(revDir).some(name => name.startsWith('.revision-')));

    // A pre-existing asset directory reserves the version even if the RP is absent.
    mkdirSync(join(revDir, 'app-v2.assets'));
    writeFileSync(join(revDir, 'app-v2.assets/keep.txt'), 'keep');
    const auto = revisePrototype({ source: srcPath, rp: rpPath, output: 'auto', operations: ops },
      { sync, generate: makeGenerate() });
    assert.equal(auto.output, join(revDir, 'app-v3.rp'));
    assert.ok(existsSync(join(revDir, 'app-v3.assets/revision-report.json')));
    assert.equal(readFileSync(join(revDir, 'app-v2.assets/keep.txt'), 'utf8'), 'keep');

    // Concurrent .assets creation during build must throw E_OUTPUT_EXISTS and never delete the pre-existing directory.
    const raceOut = join(revDir, 'race.rp');
    assert.throws(
      () => revisePrototype({ source: srcPath, rp: rpPath, output: raceOut, operations: ops }, {
        sync,
        generate: makeGenerate(() => {
          mkdirSync(join(revDir, 'race.assets'));
          writeFileSync(join(revDir, 'race.assets/foreign.txt'), 'foreign');
        }),
      }),
      err => err.code === 'E_OUTPUT_EXISTS'
    );
    assert.equal(readFileSync(join(revDir, 'race.assets/foreign.txt'), 'utf8'), 'foreign');
    assert.ok(!existsSync(raceOut) && !existsSync(`${raceOut}.baseline.json`));
    assert.ok(!readdirSync(revDir).some(name => name.startsWith('.revision-')));
  });
  check('source baseline fingerprints match every registered script', () => {
    const baseline = JSON.parse(readFileSync(join(root, 'test/baseline-shas.json')));
    for (const [file, hash] of Object.entries(baseline)) {
      // 基线按 LF 计算；Windows 的 core.autocrlf 会把工作区文件转成 CRLF，先归一化再哈希。
      const text = readFileSync(join(root, 'scripts', file), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), hash, file);
    }
    assert.equal(Object.keys(baseline).length, readdirSync(join(root, 'scripts')).filter(f => f.endsWith('.mjs')).length);
  });
} finally { rmSync(work, { recursive: true, force: true }); }
const failed = results.filter(r => !r.passed).length;
console.log(JSON.stringify({ total: results.length, passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;
