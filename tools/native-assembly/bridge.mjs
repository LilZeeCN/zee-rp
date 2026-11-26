#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, assertWritable } from '../../scripts/engine.mjs';
import { parsePayload } from '../../scripts/parse-payload.mjs';
import { readRp } from '../../scripts/rp-read.mjs';
import { readRecords } from '../../scripts/rp-records.mjs';
import { detectFileVersion, versionSpec } from '../../scripts/version.mjs';

const profiles = {
  9: {
    build: '9.0.0.3754', mvid: '2d412208-b31e-413e-9b68-fb5ea6830f64',
    sha256: '0f40edf1b8f5e4db8f999abd76e186157a457056b14a161cf53f514b2646abe1',
    workerArch: 'X64',
  },
  11: {
    build: '11.0.0.4137', mvid: '2743c1df-a331-4cd0-9018-a9ef9e36c143',
    sha256: 'e50b2ce406eee5e5666ae02c74694ec1be99310ae4a4e19de9d4aba1c37ed8a8',
    workerArch: 'Arm64',
  },
};
const code = (name, message) => Object.assign(new Error(message), { code: name });
const dotnet = process.env.ZEE_DOTNET || (process.platform === 'darwin' && [
  ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'dotnet')),
  '/opt/homebrew/bin/dotnet', '/usr/local/share/dotnet/dotnet', join(homedir(), '.dotnet/dotnet'),
].find(existsSync)) || 'dotnet';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export function locateInstallation(version, app = versionSpec(version).appPath, platform = process.platform) {
  const root = resolve(app);
  if (platform === 'darwin') {
    const resources = join(root, 'Contents', 'Resources');
    const managed = version === 9 ? resources : join(root, 'Contents', 'MacOS');
    return {
      root, resources, managed, platform,
      entry: join(managed, version === 9 ? 'Client.Mac.exe' : 'Client.Mac.dll'),
      mono: version === 9 ? join(resources, 'mono-6.8.0.105-s1') : null,
    };
  }
  if (platform === 'win32') {
    const folder = extname(root).toLowerCase() === '.exe' ? dirname(root) : root;
    const candidates = [
      extname(root).toLowerCase() === '.exe' ? root : join(folder, `AxureRP${version}.exe`),
      join(folder, `Axure RP ${version}.exe`),
    ];
    return { root: folder, managed: folder, platform, entry: candidates.find(existsSync) ?? candidates[0] };
  }
  throw code('E_ASSEMBLY_PLATFORM', `Unsupported host: ${platform}`);
}

function identify(version, installation) {
  if (!existsSync(installation.entry)) {
    throw code('E_ASSEMBLY_INSTALL', `Axure RP${version} assembly or executable missing: ${installation.entry}`);
  }
  return { ...installation, version, sha256: sha256(installation.entry) };
}

function requireProfile(installation) {
  const profile = profiles[installation.version];
  if (installation.platform === 'win32') {
    throw code('E_ASSEMBLY_PROFILE', 'Windows installation discovered. No Windows invocation profile has been verified.');
  }
  if (profile.sha256 !== installation.sha256) {
    throw code('E_ASSEMBLY_PROFILE', `Unknown RP${installation.version} binary SHA-256: ${installation.sha256}`);
  }
  if (process.arch !== 'arm64') {
    throw code('E_ASSEMBLY_ARCH', 'This macOS bridge profile was validated on Apple Silicon.');
  }
  return profile;
}

function inventory(installation) {
  const base = realpathSync(installation.root);
  const visit = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const path = join(prefix, entry.name);
    const ext = extname(entry.name).toLowerCase();
    if (entry.isDirectory() && !/\.(?:app|framework)$/.test(entry.name)) {
      return visit(join(dir, entry.name), path);
    }
    if (entry.isSymbolicLink() || /\.(?:app|framework)$/.test(entry.name) ||
        /\.(?:dll|exe|dylib|a|so|rppkg|config|plist|nib|deps\.json)$/.test(ext) ||
        entry.name.endsWith('.deps.json') || /^(?:MacOS|bin)$/.test(basename(dir))) {
      return [{ path, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'bundle' : ext || 'executable' }];
    }
    return [];
  });
  return { installation, files: visit(base) };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000, killSignal: 'SIGKILL', ...options,
  });
  if (result.error || result.status !== 0) {
    throw code('E_ASSEMBLY_PROCESS', [
      `${basename(command)} failed (${result.error?.code ?? result.signal ?? result.status})`,
      result.stderr?.trim(), result.stdout?.trim(),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function buildWorker(installation, temp, env, cwd) {
  const sdk = run(dotnet, ['--list-sdks'], { env, cwd }).trim().split(/\r?\n/)
    .map(line => /^(\d+(?:\.\d+){2}[^ ]*) \[(.+)\]$/.exec(line)).filter(Boolean).at(-1);
  if (!sdk) throw code('E_ASSEMBLY_RUNTIME', 'The bridge requires a local .NET SDK to compile its worker.');
  const csc = join(sdk[2], sdk[1], 'Roslyn', 'bincore', 'csc.dll');
  const executable = join(temp, 'Worker.exe');
  let references;
  if (installation.mono) {
    const monoLib = join(installation.mono, 'lib', 'mono');
    const gac = name => join(monoLib, 'gac', name, '4.0.0.0__b77a5c561934e089', `${name}.dll`);
    references = [join(monoLib, '4.5', 'mscorlib.dll'), gac('System'), gac('System.Core')];
  } else {
    // Use only the target's framework contract as references. The worker does not reference Axure.
    references = ['System.Private.CoreLib', 'System.Runtime', 'System.Console', 'System.Linq',
      'System.Collections', 'System.Runtime.InteropServices', 'System.IO.FileSystem', 'System.Runtime.Extensions']
      .map(name => join(installation.managed, `${name}.dll`));
    const runtime = run(dotnet, ['--list-runtimes'], { env, cwd })
      .trim().split(/\r?\n/).map(line => /^Microsoft\.AspNetCore\.App (\d+\.\d+\.\d+) /.exec(line))
      .filter(match => match && Number(match[1].split('.')[0]) >= 8).at(-1)?.[1];
    if (!runtime) {
      throw code('E_ASSEMBLY_RUNTIME', 'RP11 needs an arm64 Microsoft.AspNetCore.App runtime, version 8 or newer.');
    }
    writeFileSync(join(temp, 'Worker.runtimeconfig.json'), JSON.stringify({ runtimeOptions: {
      tfm: `net${runtime.split('.').slice(0, 2).join('.')}`,
      framework: { name: 'Microsoft.AspNetCore.App', version: runtime },
    } }));
  }
  run(dotnet, [csc, '-nologo', '-noconfig', '-nostdlib',
    ...references.map(path => `-r:${path}`), `-out:${executable}`,
    fileURLToPath(new URL('Worker.cs', import.meta.url)),
  ], { env, cwd });
  return executable;
}

function worker(installation, profile, temp, command, args) {
  const home = join(temp, 'home');
  const scratch = join(temp, 'scratch');
  mkdirSync(home);
  mkdirSync(scratch);
  const env = {
    ...process.env,
    HOME: home, CFFIXED_USER_HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), TMPDIR: scratch, DOTNET_CLI_HOME: home,
    DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  };
  const executable = buildWorker(installation, temp, env, home);
  const mono = installation.mono;
  const runtime = mono ? join(mono, 'bin', 'mono-sgen') : dotnet;
  env.DYLD_LIBRARY_PATH = [installation.managed, mono && join(mono, 'lib')].filter(Boolean).join(delimiter);
  if (mono) {
    env.MONO_PATH = installation.managed;
    env.MONO_CFG_DIR = join(mono, 'etc');
  }
  const stdout = run(runtime, [
    executable, installation.entry, profile.mvid, command, installation.resources, scratch, ...args,
  ], { env, cwd: home });
  const rows = stdout.split(/\r?\n/).filter(line => line.startsWith('zee-assembly:')).map(line => {
    const [kind, ...values] = line.slice('zee-assembly:'.length).split('\t');
    return { kind, values: values.map(value => Buffer.from(value, 'base64').toString('utf8')) };
  });
  const [build, mvid, architecture, clr] = rows.find(row => row.kind === 'identity')?.values ?? [];
  if (build !== profile.build || mvid !== profile.mvid || architecture !== profile.workerArch) {
    throw code('E_ASSEMBLY_IDENTITY', 'The native worker did not confirm the selected build and process architecture.');
  }
  return { identity: { build, mvid, architecture, clr, sha256: profile.sha256 }, rows: rows.slice(1) };
}

function targetPath(path, installation) {
  assertWritable(path);
  const absolute = resolve(path);
  const parent = realpathSync(dirname(absolute));
  const root = realpathSync(installation.root).toLowerCase();
  if (parent.toLowerCase() === root || parent.toLowerCase().startsWith(root + sep) ||
      parent.split(sep).some(segment => segment.toLowerCase().endsWith('.app'))) {
    throw code('E_ASSEMBLY_OUTPUT', `Output must be outside the installed application: ${absolute}`);
  }
  const target = join(parent, basename(absolute));
  try {
    lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return target;
    throw error;
  }
  throw code('E_ASSEMBLY_OUTPUT', `Output already exists: ${target}`);
}

function checkRp(path, version) {
  const rp = readRp(readFileSync(path), { full: true });
  if (rp.version !== version || rp.records.unparseable || rp.counts.danglingRefs || rp.counts.problems) {
    throw code('E_ASSEMBLY_STRUCTURE', `Generated .rp failed validation: ${JSON.stringify({
      counts: rp.counts, unparseable: rp.records.unparseable, problems: rp.problems,
    })}`);
  }
  return rp.counts;
}

function shapeOf(value) {
  if (value.entries) return Object.fromEntries(value.entries.map(([key, child]) =>
    [key.text, shapeOf(child)]));
  if (value.items) return value.items.map(shapeOf);
  if (value.body) return { className: value.className, fields: shapeOf(value.body) };
  return { tag: value.tag, value: value.text ?? value.value ?? value.values };
}

function textBoxFields(path) {
  const boxes = readRecords(readFileSync(path)).filter(record => record.className === 'Axure:Page')
    .flatMap(record => [...parsePayload(record).objects.values()])
    .filter(object => object.className === 'Axure:DiagramObject:TextBox');
  if (boxes.length !== 1) throw code('E_ASSEMBLY_ORACLE', `Expected one native TextBox, found ${boxes.length}`);
  return shapeOf(boxes[0].body);
}

function changedFields(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .map(key => ({ key, before: a[key] ?? null, after: b[key] ?? null }));
}

function compareModels(input, rows) {
  const binary = readRp(readFileSync(input), { full: true });
  const pages = rows.filter(row => row.kind === 'page');
  const widgets = rows.filter(row => row.kind === 'widget');
  const differences = [];
  if (pages.length !== binary.pages.length) {
    differences.push({ field: 'pageCount', managed: pages.length, binary: binary.pages.length });
  }
  for (const [id, name] of pages.map(row => row.values)) {
    const matches = binary.pages.filter(page => page.name === name);
    if (matches.length !== 1) {
      differences.push({ page: name, field: 'pageMatch', managed: 1, binary: matches.length });
      continue;
    }
    const nativeWidgets = widgets.filter(row => row.values[0] === id);
    const decodedWidgets = matches[0].widgets;
    if (nativeWidgets.length !== decodedWidgets.length) {
      differences.push({ page: name, field: 'widgetCount', managed: nativeWidgets.length, binary: decodedWidgets.length });
    }
    for (const [index, row] of nativeWidgets.entries()) {
      const binaryWidget = decodedWidgets[index];
      if (!binaryWidget) continue;
      const [, , widgetName, x, y, width, height] = row.values;
      const fields = { name: widgetName, x: Number(x), y: Number(y), w: Number(width), h: Number(height) };
      for (const [field, managed] of Object.entries(fields)) {
        if (managed !== binaryWidget[field]) {
          differences.push({ page: name, widgetIndex: index, field, managed, binary: binaryWidget[field] ?? null });
        }
      }
    }
  }
  return {
    scope: 'page names and ordered top-level widget names/bounds',
    pages: pages.length, widgets: widgets.length, differences,
    structuralProblems: binary.problems, unparseableRecords: binary.records.unparseable,
  };
}

const operations = { probe: 0, catalog: 0, inventory: 0, members: 1, inspect: 1, compare: 1, export: 2, create: [1, 2], pair: 3 };
const maxLength = value => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || Number(value) > 2147483647) {
    throw code('E_ASSEMBLY_ARGUMENT', `Expected an integer maxLength from 0 to 2147483647, got ${value}`);
  }
  return value;
};

export function runAssemblyBridge({ version, app, command, args = [] }) {
  const arity = operations[command];
  if (!Object.hasOwn(operations, command) || ![arity].flat().includes(args.length)) {
    throw code('E_ASSEMBLY_ARGUMENT', `Unsupported operation or arguments: ${command}`);
  }
  const installation = identify(version, locateInstallation(version, app));
  if (command === 'inventory') return inventory(installation);
  const profile = requireProfile(installation);
  const temp = mkdtempSync(join(tmpdir(), 'zee-rp-assembly-'));
  try {
    if (command === 'create') {
      const [output, length] = args;
      const target = targetPath(output, installation);
      if (extname(target).toLowerCase() !== '.rp') throw code('E_ASSEMBLY_OUTPUT', 'Use an .rp output filename.');
      const staged = join(temp, 'created.rp');
      const result = worker(installation, profile, temp, command,
        length === undefined ? [staged] : [staged, maxLength(length)]);
      const counts = checkRp(staged, version);
      copyFileSync(staged, target, constants.COPYFILE_EXCL);
      return { ...result, output: target, counts };
    }
    if (command === 'pair') {
      const [outDir, before, after] = args;
      const target = targetPath(outDir, installation);
      if (maxLength(before) === maxLength(after)) throw code('E_ASSEMBLY_ARGUMENT', 'The values must differ.');
      const staged = join(temp, 'pair');
      mkdirSync(staged);
      const a = join(staged, 'before.rp');
      const b = join(staged, 'after.rp');
      const result = worker(installation, profile, temp, command, [a, before, b, after]);
      const counts = [checkRp(a, version), checkRp(b, version)];
      const fields = changedFields(textBoxFields(a), textBoxFields(b));
      publishDirectory(staged, target);
      return { ...result, output: target, counts, fields };
    }
    if (['export', 'inspect', 'compare'].includes(command)) {
      assertNotProtected(args[0]);
      const input = realpathSync(args[0]);
      const inputVersion = detectFileVersion(readFileSync(input));
      if (inputVersion !== version) {
        throw code('E_ASSEMBLY_INPUT_VERSION', `Use RP${inputVersion} for this input, selected RP${version}.`);
      }
      if (command === 'inspect' || command === 'compare') {
        const result = worker(installation, profile, temp, 'inspect', [input]);
        return command === 'inspect' ? result : { ...result, comparison: compareModels(input, result.rows) };
      }
      const target = targetPath(args[1], installation);
      const staged = join(temp, 'html');
      const result = worker(installation, profile, temp, command, [input, staged]);
      for (const file of ['start.html', 'data/document.js']) {
        if (!lstatSync(join(staged, file)).isFile()) {
          throw code('E_ASSEMBLY_EXPORT', `Missing Axure HTML output: ${file}`);
        }
      }
      publishDirectory(staged, target);
      return { ...result, output: target, entry: join(target, 'start.html'), generatorSettings: 'fresh-defaults' };
    }
    return worker(installation, profile, temp, command, args);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

function publishDirectory(source, target) {
  mkdirSync(target);
  try {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isFile()) copyFileSync(from, to, constants.COPYFILE_EXCL);
      else if (entry.isDirectory()) publishDirectory(from, to);
      else throw code('E_ASSEMBLY_OUTPUT', `Unexpected non-regular Axure output: ${from}`);
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , command, version, ...args] = process.argv;
  if (command === '--help' || !command) {
    console.log(`Usage: node tools/native-assembly/bridge.mjs <operation> <9|11> [args]
  inventory | probe | catalog
  members <managed-type>
  create <new.rp> [text-box-max-length]
  inspect | compare <source.rp>
  pair <new-directory> <before-max-length> <after-max-length>
  export <source.rp> <new-directory>
Set AXURE_APP_RP9 or AXURE_APP_RP11 for a custom installation path.`);
  } else {
    try {
      console.log(JSON.stringify(runAssemblyBridge({ command, version: Number(version), args }), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ code: error.code ?? 'E_ASSEMBLY', message: error.message }));
      process.exitCode = 1;
    }
  }
}
