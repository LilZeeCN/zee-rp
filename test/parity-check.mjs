// 对拍与安全测试：bin/axure.mjs（经引擎透传）vs 直接 node scripts/<script>.mjs 的 stdout 逐字节 / 产物 SHA-256 对拍
// （duplicate-page 例外：该工具 randomBytes(16) 生成新页 GUID 非确定，改用 rp-read 摘要规范化等价）；
// 安全负例（受保护成品红线、AXURE_WRITE_ROOT 白名单）与存量零改动回归。直接断言脚本（不用 node:test）：
// 每个断言一行 PASS/FAIL，全过 exit 0。可重复运行：工作目录 /tmp/axure-parity-<随机>/，跑前先清理。
// 阶段 6 基线随代码保存在 test/baseline-shas.json；原 0–4 阶段冻结清单保留于 workspace，不覆盖，
// 可用 AXURE_BASELINE_SHAS 覆盖；本测试不读写受保护成品本身，只把其路径当作被拒绝的参数值。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBlankTemplate } from '../scripts/blank-template.mjs';

const SKILL = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = join(SKILL, 'scripts');
const BIN = join(SKILL, 'bin', 'axure.mjs');
const ASSET_BLANK = resolveBlankTemplate();
const ASSET_SPEC = join(SKILL, 'assets', 'dashboard-example.spec.json');
// 受保护路径经 AXURE_PROTECTED_PATHS 注入假路径（无需真实文件，引擎按词法/消解路径折叠比对）；
// 本进程先写入 process.env，baseEnv 快照与全部子进程随之继承。
const PROTECTED = '/zee-rp-test-protected/final.rp';
process.env.AXURE_PROTECTED_PATHS = PROTECTED;
const BASELINE = process.env.AXURE_BASELINE_SHAS || join(SKILL, 'test', 'baseline-shas.json');
const EXPECTED_SCRIPT_COUNT = JSON.parse(readFileSync(join(SKILL, 'test', 'baseline-policy.json'), 'utf8')).expectedScriptCount;

const results = [];
function ok(name, passed, detail = '') {
  results.push(passed);
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed || !detail ? '' : ` — ${detail}`}`);
}

// first 是 node 之后的第一个参数（--check、脚本路径或 bin/axure.mjs），args 原样续后。
function execNode(first, args, { env } = {}) {
  const r = spawnSync(process.execPath, [first, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: env ?? baseEnv,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// 对拍/回归不受白名单影响：清掉外部可能存在的 AXURE_WRITE_ROOT，白名单用例单独注入。
const baseEnv = { ...process.env };
delete baseEnv.AXURE_WRITE_ROOT;

// ---- 工作目录：随机名 + 跑前清理，保证可重复 ----
const WORK = join('/tmp', `axure-parity-${Date.now().toString(36)}-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'wr'), { recursive: true });
console.log(`工作目录: ${WORK}\n`);

// ---- a) 结构 ----
for (const rel of ['scripts/registry.mjs', 'scripts/engine.mjs', 'bin/axure.mjs', 'test/parity-check.mjs']) {
  const r = execNode('--check', [join(SKILL, rel)]);
  ok(`结构 node --check ${rel}`, r.status === 0, `exit=${r.status} ${r.stderr.toString().trim()}`);
}
{
  const r = execNode(join(SCRIPTS, 'registry.mjs'), ['validate']);
  ok('结构 registry validate', r.status === 0, `exit=${r.status} ${r.stderr.toString().trim()}`);
}

// ---- b) 对拍 ----
{
  const viaCli = execNode(BIN, ['rp-read', ASSET_BLANK]);
  const direct = execNode(join(SCRIPTS, 'rp-read.mjs'), [ASSET_BLANK]);
  const passed = viaCli.status === 0 && direct.status === 0 && viaCli.stdout.equals(direct.stdout);
  ok('对拍 rp-read stdout 逐字节相等', passed,
    `cli exit=${viaCli.status} direct exit=${direct.status} 字节数 ${viaCli.stdout.length}/${direct.stdout.length}`);
}
{
  const cliRp = join(WORK, 'cli-blank.rp');
  const directRp = join(WORK, 'direct-blank.rp');
  const a = execNode(BIN, ['create-blank-project', cliRp]);
  const d = execNode(join(SCRIPTS, 'create-blank-project.mjs'), [directRp]);
  const produced = existsSync(cliRp) && existsSync(directRp);
  ok('对拍 create-blank-project 两路 exit 0 且产出文件', a.status === 0 && d.status === 0 && produced,
    `cli exit=${a.status} ${a.stderr.toString().trim()} / direct exit=${d.status} ${d.stderr.toString().trim()}`);
  if (produced) {
    const [s1, s2] = [sha256(cliRp), sha256(directRp)];
    ok('对拍 create-blank-project 两路 SHA-256 相等', s1 === s2, `${s1} vs ${s2}`);
    ok('对拍 create-blank-project 与用户本机模板 SHA-256 相等', s1 === sha256(ASSET_BLANK), '该工具承诺与模板逐字节相同');
  } else {
    ok('对拍 create-blank-project 两路 SHA-256 相等', false, '前置产物缺失');
    ok('对拍 create-blank-project 与随包模板 SHA-256 相等', false, '前置产物缺失');
  }
}
{
  const src = join(WORK, 'cli-blank.rp');
  if (existsSync(src)) {
    const a = execNode(BIN, ['duplicate-page', src, join(WORK, 'cli-dup.rp'), 'Page 1', 'Page 2']);
    const d = execNode(join(SCRIPTS, 'duplicate-page.mjs'), [src, join(WORK, 'direct-dup.rp'), 'Page 1', 'Page 2']);
    const produced = existsSync(join(WORK, 'cli-dup.rp')) && existsSync(join(WORK, 'direct-dup.rp'));
    // 该工具按设计 randomBytes(16) 为新页生成 GUID（直跑两次 SHA 也不等），SHA-256 判据不可满足；
    // 改为 rp-read 摘要规范化等价：去头部行（路径/大小/dataStart 随机尺寸浮动）+ 屏蔽全部 32 位 hex 随机 GUID
    // + 屏蔽 package@N/thumbnail@N 记录偏移数字（随机 GUID 编码长度抖动会平移尾部记录偏移，实测 ±7 字节）。
    const normalize = text => text.split('\n').slice(1).join('\n')
      .replace(/[0-9a-f]{32}/g, '<guid32>')
      .replace(/(package|thumbnail)@[0-9]+/g, '$1@<off>');
    let passed = a.status === 0 && d.status === 0 && produced;
    let detail = `cli exit=${a.status} ${a.stderr.toString().trim()} / direct exit=${d.status} ${d.stderr.toString().trim()}`;
    if (passed) {
      const ra = execNode(join(SCRIPTS, 'rp-read.mjs'), [join(WORK, 'cli-dup.rp')]);
      const rd = execNode(join(SCRIPTS, 'rp-read.mjs'), [join(WORK, 'direct-dup.rp')]);
      passed = ra.status === 0 && rd.status === 0 && normalize(ra.stdout.toString()) === normalize(rd.stdout.toString());
      detail = `rp-read exit=${ra.status}/${rd.status}，规范化摘要${passed ? '一致' : '不一致'}`;
    }
    ok('对拍 duplicate-page 规范化等价（随机 GUID 已屏蔽）', passed, detail);
  } else {
    ok('对拍 duplicate-page 规范化等价（随机 GUID 已屏蔽）', false, '前置 blank 工程缺失');
  }
}
{
  const a = execNode(BIN, ['axvg', 'build', ASSET_SPEC, '-o', join(WORK, 'cli.axvg.json')]);
  const d = execNode(join(SCRIPTS, 'axvg.mjs'), ['build', ASSET_SPEC, '-o', join(WORK, 'direct.axvg.json')]);
  const produced = existsSync(join(WORK, 'cli.axvg.json')) && existsSync(join(WORK, 'direct.axvg.json'));
  const passed = a.status === 0 && d.status === 0 && produced
    && sha256(join(WORK, 'cli.axvg.json')) === sha256(join(WORK, 'direct.axvg.json'));
  ok('对拍 axvg build 输出 JSON SHA-256 相等', passed,
    `cli exit=${a.status} ${a.stderr.toString().trim()} / direct exit=${d.status} ${d.stderr.toString().trim()}`);
}

// ---- c) 安全负例：被拒 = exit 非 0 且 stderr 带拒绝说明；全程不触碰受保护成品本体 ----
{
  const r = execNode(BIN, ['create-blank-project', PROTECTED]);
  const err = r.stderr.toString();
  ok('安全 输出=受保护成品 被拒', r.status !== 0 && err.includes('受保护'), `exit=${r.status} stderr=${err.trim().slice(0, 120)}`);
}
{
  const r = execNode(BIN, ['rp-read', PROTECTED]);
  const err = r.stderr.toString();
  ok('安全 输入源=受保护成品 被拒', r.status !== 0 && err.includes('受保护'), `exit=${r.status} stderr=${err.trim().slice(0, 120)}`);
}
{
  // 白名单根 = <WORK>/wr；输出到 <WORK>/other/ 必须在 spawn 前被引擎拒绝（文件不得落盘）
  const env = { ...baseEnv, AXURE_WRITE_ROOT: join(WORK, 'wr') };
  const target = join(WORK, 'other', 'na.rp');
  const r = execNode(BIN, ['create-blank-project', target], { env });
  const err = r.stderr.toString();
  ok('安全 白名单外输出 被拒且未落盘', r.status !== 0 && err.includes('AXURE_WRITE_ROOT') && !existsSync(target),
    `exit=${r.status} stderr=${err.trim().slice(0, 120)}`);
}
{
  const env = { ...baseEnv, AXURE_WRITE_ROOT: join(WORK, 'wr') };
  const target = join(WORK, 'wr', 'ok.rp');
  const r = execNode(BIN, ['create-blank-project', target], { env });
  ok('安全 白名单根内输出 通过', r.status === 0 && existsSync(target), `exit=${r.status} ${r.stderr.toString().trim()}`);
}
{
  // 红线穿透回归①：大小写变体（本机 APFS 大小写不敏感，同一文件可达）。探针用 create-blank-project：
  // 即使引擎回归放行，脚本 COPYFILE_EXCL 也因目标已存在而失败，不会改写成成品。
  const variant = PROTECTED.replace('/Documents/', '/documents/').replace(/final\.rp$/, 'Final.RP');
  const r = execNode(BIN, ['create-blank-project', variant]);
  const err = r.stderr.toString();
  ok('安全 大小写变体红线 被拒', r.status !== 0 && err.includes('受保护'), `exit=${r.status} stderr=${err.trim().slice(0, 120)}`);
}
{
  // 红线穿透回归②：末段符号链接指向受保护成品。建立链接不触碰目标；引擎 readlink 只读链接自身，
  // 命中即拒；即使回归放行，COPYFILE_EXCL 仍兜底。
  const link = join(WORK, 'link-to-final.rp');
  symlinkSync(PROTECTED, link);
  try {
    const r = execNode(BIN, ['create-blank-project', link]);
    const err = r.stderr.toString();
    ok('安全 符号链接指向受保护成品 被拒', r.status !== 0 && err.includes('受保护'), `exit=${r.status} stderr=${err.trim().slice(0, 120)}`);
  } finally {
    unlinkSync(link);
  }
}
{
  // 白名单定位回归①：duplicate-page --index 形态（输出在 argv[4] 而非 argv[3]），源在根外、输出在根内。
  // 修复前引擎把源文件当输出检查，合法调用被误拒。blank 模板 Page 1 的记录号为 4（实测）。
  const env = { ...baseEnv, AXURE_WRITE_ROOT: join(WORK, 'wr') };
  const target = join(WORK, 'wr', 'dp-idx.rp');
  const r = execNode(BIN, ['duplicate-page', '--index', ASSET_BLANK, target, '4', 'Index Page'], { env });
  ok('安全 duplicate-page --index 源根外输出根内 通过', r.status === 0 && existsSync(target),
    `exit=${r.status} ${r.stderr.toString().trim().slice(0, 120)}`);
}
{
  // 白名单定位回归②：duplicate-page --index 源在根内、输出在根外。修复前 exit 0 且产物泄漏到白名单外。
  const env = { ...baseEnv, AXURE_WRITE_ROOT: join(WORK, 'wr') };
  const target = join(WORK, 'other', 'dp-leak.rp');
  const r = execNode(BIN, ['duplicate-page', '--index', join(WORK, 'wr', 'ok.rp'), target, '4', 'Leak Page'], { env });
  const err = r.stderr.toString();
  ok('安全 duplicate-page --index 输出根外 被拒且未落盘', r.status !== 0 && err.includes('AXURE_WRITE_ROOT') && !existsSync(target),
    `exit=${r.status} stderr=${err.trim().slice(0, 120)}`);
}
{
  // 白名单定位回归③：axvg build 省略 -o 时脚本写 spec 同名默认输出（axvg.mjs:360-361），
  // 根外 spec 的默认输出必须被拒（修复前 exit 0 且产物落在白名单外）。
  const env = { ...baseEnv, AXURE_WRITE_ROOT: join(WORK, 'wr') };
  copyFileSync(ASSET_SPEC, join(WORK, 'dash.spec.json'));
  const r = execNode(BIN, ['axvg', 'build', join(WORK, 'dash.spec.json')], { env });
  const err = r.stderr.toString();
  ok('安全 axvg build 无 -o 默认输出在根外 被拒且未落盘', r.status !== 0 && err.includes('AXURE_WRITE_ROOT') && !existsSync(join(WORK, 'dash.axvg.json')),
    `exit=${r.status} stderr=${err.trim().slice(0, 120)}`);
}
{
  // 白名单定位回归③正例：根内 spec 的同名默认输出落在根内，应通过。
  const env = { ...baseEnv, AXURE_WRITE_ROOT: join(WORK, 'wr') };
  copyFileSync(ASSET_SPEC, join(WORK, 'wr', 'dash-ok.spec.json'));
  const r = execNode(BIN, ['axvg', 'build', join(WORK, 'wr', 'dash-ok.spec.json')], { env });
  ok('安全 axvg build 无 -o 默认输出在根内 通过', r.status === 0 && existsSync(join(WORK, 'wr', 'dash-ok.axvg.json')),
    `exit=${r.status} ${r.stderr.toString().trim().slice(0, 120)}`);
}

// ---- d) 回归：存量零改动 ----
{
  const r = execNode(join(SCRIPTS, 'axvg.mjs'), ['selftest']);
  ok('回归 axvg selftest', r.status === 0 && r.stdout.toString().includes('selftest OK'), `exit=${r.status}`);
}
{
  let passed = false;
  let detail = '';
  try {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const names = Object.keys(baseline);
    const mismatched = names.filter(n => {
      try { return sha256(join(SCRIPTS, n)) !== baseline[n]; } catch { return true; }
    });
    passed = names.length === EXPECTED_SCRIPT_COUNT && mismatched.length === 0;
    detail = `清单 ${names.length} 项${mismatched.length ? `，不符：${mismatched.join('、')}` : ''}`;
  } catch (error) {
    detail = `baseline 读取失败：${error.message}`;
  }
  ok(`回归 ${EXPECTED_SCRIPT_COUNT} 个内核脚本 SHA-256 与当前 baseline-shas.json 逐一相等`, passed, detail);
}

const failed = results.filter(p => !p).length;
console.log(`\n共 ${results.length} 项断言：${results.length - failed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
