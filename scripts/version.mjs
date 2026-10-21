// Axure 版本边界：文件头识别 + 目标版本解析 + 宿主/模板/安装根按版本绑定。
//
// 文件头结构：magic 0xAC 0xEF + u16 LE 版本号。
//   Axure RP 9  -> ac ef 09 00
//   Axure RP 11 -> ac ef 0b 00
// 版本号是「文件自己的属性」。写侧的字段编码必须跟它走，不能按「本机此刻开着哪个 Axure」猜，
// 也不能只改文件头当降级器——两版的字段类型与值语义都不同（见 version-fields.mjs）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_VERSION = 11;
export const MAGIC0 = 0xac;
export const MAGIC1 = 0xef;

function spec(version) {
  const v = Number(version);
  const table = {
    9: {
      version: 9,
      label: 'Axure RP 9',
      appPath: process.env.AXURE_APP_RP9 || '/Applications/Axure RP 9.app',
      bundleId: process.env.AXURE_BUNDLE_RP9 || 'com.axure.AxureRP9',
      processName: 'Axure RP 9',
      templateEnv: 'AXURE_BLANK_TEMPLATE_RP9',
      defaultTemplate: join(homedir(), 'Library/Application Support/zee-axure/templates/axure-rp9-blank.rp'),
    },
    11: {
      version: 11,
      label: 'Axure RP 11',
      appPath: process.env.AXURE_APP_RP11 || '/Applications/Axure RP 11.app',
      bundleId: process.env.AXURE_BUNDLE_RP11 || 'com.axure.AxureRP11',
      processName: 'Axure RP 11',
      templateEnv: 'AXURE_BLANK_TEMPLATE_RP11',
      defaultTemplate: join(homedir(), 'Library/Application Support/zee-axure/templates/axure-rp11-blank.rp'),
    },
  };
  const found = table[v];
  if (!found) {
    throw new Error(`Unsupported Axure version ${JSON.stringify(version)}. Supported: ${Object.keys(table).join(', ')}`);
  }
  return found;
}

export function supportedVersions() { return [9, 11]; }
export function versionSpec(version) { return spec(version); }
export function versionLabel(version) { return spec(version).label; }
export function bundleId(version) { return spec(version).bundleId; }
export function installRoot(version) { return join(spec(version).appPath, 'Contents/Resources/DefaultSettings'); }

// 从 .rp 字节流读版本；不是 Axure 容器或版本未知时抛错（不猜）。
export function detectFileVersion(file) {
  if (!file || file.length < 8) throw new Error('Not an Axure .rp container: too short');
  if (file[0] !== MAGIC0 || file[1] !== MAGIC1) {
    throw new Error(`Not an Axure .rp container: magic ${file[0]?.toString(16)} ${file[1]?.toString(16)} != ac ef`);
  }
  const version = file.readUInt16LE(2);
  spec(version);                       // 未支持的版本在这里抛错
  return version;
}

export function tryDetectFileVersion(file) {
  try { return detectFileVersion(file); } catch { return null; }
}

// 目标版本：显式参数 > AXURE_TARGET_VERSION > 默认 11（保持 RP 11 默认行为不变）。
export function resolveTargetVersion(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return spec(explicit).version;
  const env = process.env.AXURE_TARGET_VERSION;
  if (env) return spec(env).version;
  return DEFAULT_VERSION;
}

export function templateCandidates(version) {
  const s = spec(version);
  const out = [];
  if (process.env[s.templateEnv]) out.push({ path: process.env[s.templateEnv], from: s.templateEnv });
  out.push({ path: s.defaultTemplate, from: 'default' });
  return out;
}

export function appExists(version) {
  return existsSync(spec(version).appPath);
}

// 本机正在运行的 Axure 版本（可能同时开着 9 和 11）。
export function runningVersions() {
  let out = '';
  try {
    out = spawnSync('pgrep', ['-fl', 'Axure RP'], { encoding: 'utf8' }).stdout ?? '';
  } catch { return []; }
  return supportedVersions().filter(v => out.includes(spec(v).appPath));
}

// 宿主绑定：显式指定 > AXURE_TARGET_VERSION > 唯一在跑的 Axure > 报错。
// 双版本并行时「第一个名字含 Axure 的进程」会选错程序，所以这里不猜。
export function resolvePasteTarget({ version, bundleId } = {}) {
  if (bundleId) {
    const hit = supportedVersions().find(v => spec(v).bundleId === bundleId);
    if (!hit) throw new Error(`Unknown Axure bundle id "${bundleId}". Known: ${supportedVersions().map(v => spec(v).bundleId).join(', ')}`);
    return spec(hit);
  }
  if (version !== undefined && version !== null && version !== '') return spec(version);
  if (process.env.AXURE_TARGET_VERSION) return spec(process.env.AXURE_TARGET_VERSION);
  const running = runningVersions();
  if (running.length === 1) return spec(running[0]);
  if (running.length === 0) {
    throw new Error('No running Axure detected. Start Axure RP 9 or 11, or pass an explicit target version / bundle id.');
  }
  throw new Error(`Multiple Axure versions are running (${running.join(', ')}); refusing to guess. Pass --version 9|11 or set AXURE_TARGET_VERSION.`);
}
