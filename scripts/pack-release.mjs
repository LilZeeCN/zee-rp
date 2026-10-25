import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, constants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertWritable } from './engine.mjs';
import { listCommands } from './registry.mjs';
import { listMcpTools, jobTools } from './mcp-tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOP = ['README.md', 'README.en.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE', 'SKILL.md', '.gitignore', '.npmignore', 'package.json', 'package-lock.json', 'requirements.txt'];
const DIRS = ['bin', 'scripts', 'test', 'references', 'examples', 'docs', 'assets', 'tools', 'benchmarks', '.github'];
const EXTENSIONS = /\.(mjs|py|swift|md|json|rp1|svg|png|ya?ml)$/;

// Copy the public source without pruning implementations, tests, or rewriting their contents.
export function releasePaths(root = ROOT) {
  const paths = TOP.filter(path => existsSync(join(root, path)));
  const packagePath = join(root, 'package.json');
  const declared = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')).files : null;
  const publicTests = Array.isArray(declared) ? new Set(declared.filter(path => path.startsWith('test/'))) : null;
  const walk = dir => {
    if (!existsSync(join(root, dir))) return;
    for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (['node_modules', '__pycache__', '.venv', '.git', 'outputs', '.proto-axvg-cache'].includes(item.name)) continue;
      const path = `${dir}/${item.name}`;
      // Workspace-specific research harnesses are not public regression sources.
      if (item.isFile() && path.startsWith('test/') && publicTests && !publicTests.has(path)) continue;
      if (dir === 'test/fixtures' && !['rp-aggregate-cases.json', 'rp-aggregate-matrix.json', 'rp-aggregate-panel.json', 'rp-aggregate-startup.json', 'rp-native-visual.json', 'rp1-master-adaptive.json', 'round3-runtime-rows.json', 'round3-master-slot.json'].includes(item.name)) continue;
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && EXTENSIONS.test(item.name)) paths.push(path);
    }
  };
  for (const dir of DIRS) walk(dir);
  return paths.sort();
}

export function packRelease(destination) {
  const output = resolve(destination);
  assertWritable(output);
  if (existsSync(output)) throw new Error('Release directory must be a new directory');
  const paths = releasePaths(), files = {};
  mkdirSync(output);
  for (const path of paths) {
    const target = join(output, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, path), target, constants.COPYFILE_EXCL);
    files[relative(output, target)] = createHash('sha256').update(readFileSync(target)).digest('hex');
  }
  const manifest = { version: JSON.parse(readFileSync(join(ROOT, 'package.json'))).version,
    commands: listCommands().length, mcpTools: listMcpTools().length + jobTools.length, files };
  writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output, files: paths.length, commands: manifest.commands, mcpTools: manifest.mcpTools };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 4 || process.argv[2] !== '-o') throw new Error('Usage: node scripts/pack-release.mjs -o <new-directory>');
  console.log(JSON.stringify(packRelease(process.argv[3]), null, 2));
}
