#!/usr/bin/env node
/**
 * 回归：宏节点内部文字的回写（A5）
 *
 * 背景：`.rp` 里点进宏（card / detail-card 等）改内部标题，lift 会把改动识别成
 * 该宏子节点的 text；若直接写回源码，宏节点会多出一个非法的 `text` 属性，
 * merge 阶段报 "Unknown property 'text'" 而整体失败。
 *
 * 期望：能映射到宏参数（title）就提升为参数；不能就明确报 unsupported，
 * 绝不产出一个语义非法的 spec。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'zee-macro-lift-'));

const run = (script, args) => execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

const spec = join(dir, 'fixture.rp1');
writeFileSync(spec, [
  'rp/1 name="宏标题回写" domain=web theme=enterprise-light',
  'page #p [800x600a] name="页"',
  '  @column #root [800x600] padding=20 gap=12 fill=$bg',
  '    @card #c [400x200] title="原标题" body="正文"',
  '',
].join('\n'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('[1] 生成基线 .rp');
const baseRp = join(dir, 'base.rp');
run('proto.mjs', ['generate', '--spec', spec, '--out-dir', join(dir, 'gen'), '-o', baseRp]);
check('基线 .rp 存在', () => assert.ok(readFileSync(baseRp).length > 1000));

console.log('[2] 找到宏内部标题控件并改字');
const read = run('rp-read.mjs', [baseRp]);
const widget = /「(txt-[a-z0-9_]*title[^」]*)」/i.exec(read)?.[1];
check('能在 .rp 里定位到标题控件', () => assert.ok(widget, '未找到 title 控件'));

const editedRp = join(dir, 'edited.rp');
run('set-widget-text.mjs', [baseRp, editedRp, '页', widget, '改后标题']);
check('改后 .rp 已生成', () => assert.ok(readFileSync(editedRp).length > 1000));

console.log('[3] lift 回源码：必须提升为宏参数，而不是加 text');
const lifted = join(dir, 'lifted.rp1');
run('proto.mjs', ['lift-rp', '--spec', spec, '--base-rp', baseRp, '--gui-rp', editedRp, '--out', lifted]);
const liftedText = readFileSync(lifted, 'utf8');
const cardLine = liftedText.split('\n').find(line => line.includes('@card')) || '';
check('宏行带上新标题参数', () => assert.ok(cardLine.includes('title="改后标题"'), cardLine));
check('宏行没有多余的位置参数文本', () => {
  const afterId = cardLine.split('#c')[1] || '';
  const positional = /\[\d+x\d+\]\s+"[^"]+"/.test(afterId) || /^\s+"[^"]+"/.test(afterId.trim());
  assert.ok(!positional, `宏行出现位置参数文本：${cardLine}`);
});

console.log('[4] merge 回 .rp：必须编译通过');
const mergedSpec = join(dir, 'merged.rp1');
const mergedRp = join(dir, 'merged.rp');
let mergeOut = '';
try {
  mergeOut = execFileSync(process.execPath, [join(ROOT, 'scripts', 'proto.mjs'), 'merge',
    '--base-spec', spec,
    '--base-rp', baseRp,
    '--edited-rp', editedRp,
    '--new-spec', spec,
    '--out-spec', mergedSpec,
    '--out-rp', mergedRp,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} catch (err) {
  mergeOut = String(err.stdout || '') + String(err.stderr || '');
}
check('merge 状态为 merged', () => assert.ok(/"status":\s*"merged"/.test(mergeOut), mergeOut.slice(0, 400)));
check('合入的源码保留新标题', () => {
  const text = readFileSync(mergedSpec, 'utf8');
  const line = text.split('\n').find(l => l.includes('@card')) || '';
  assert.ok(line.includes('title="改后标题"'), line);
});
check('重建的 .rp 存在且非空', () => assert.ok(readFileSync(mergedRp).length > 1000));

try { rmSync(dir, { recursive: true, force: true }); } catch {}
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
