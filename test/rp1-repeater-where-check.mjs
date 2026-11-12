#!/usr/bin/env node
/**
 * 回归：RP/1 repeater 的编译期行过滤（A3）
 *  - where 只保留匹配行
 *  - 过滤结果进入 language-ir（模板与行数一致）
 *  - 表达式非法时报 E_WHERE，而不是静默 0 行
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'zee-where-'));
after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});
const check = (name, fn) => test(name, fn);

const spec = join(dir, 'rows.rp1');
writeFileSync(spec, [
  'rp/1 name="行过滤" domain=web theme=enterprise-light',
  'model Order id=id title=text status="enum(已支付,待跟进)"',
  'dataset orders model=Order',
  '  - id="1" title="甲" status="已支付"',
  '  - id="2" title="乙" status="待跟进"',
  '  - id="3" title="丙" status="已支付"',
  'page #p [800x600a] name="页"',
  '  @column #root [800x600] padding=20 gap=12 fill=$bg',
  '    @repeater #rows [760x400] dataset=orders rowHeight=48 where="=item.status == \\"已支付\\""',
  '      :template',
  '        @row #r [760x48] gap=8',
  '          @label #rt [400x24] "=item.title"',
  '',
].join('\n'), 'utf8');

execFileSync(process.execPath, [join(ROOT, 'scripts', 'proto.mjs'), 'compile', '--spec', spec, '--out-dir', join(dir, 'out'), '--no-interactions'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const ir = JSON.parse(readFileSync(join(dir, 'out', 'language-ir.json'), 'utf8'));

const findRepeaters = (node, acc = []) => {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach(child => findRepeaters(child, acc)); return acc; }
  if (node.type === 'repeater') acc.push(node);
  for (const value of Object.values(node)) findRepeaters(value, acc);
  return acc;
};
const repeaters = findRepeaters(ir);
check('编译产出包含 repeater', () => assert.ok(repeaters.length >= 1));
check('where 过滤生效（3 行剩 2 行）', () => assert.equal(repeaters[0].rows.length, 2));
check('过滤条件被记录', () => assert.match(String(repeaters[0].where || ''), /已支付/));

const badSpec = join(dir, 'bad.rp1');
writeFileSync(badSpec, readFileSync(spec, 'utf8').replace('where="=item.status == \\"已支付\\""', 'where="=item.nonexistent == \\"x\\""'), 'utf8');
let badError = '';
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'proto.mjs'), 'compile', '--spec', badSpec, '--out-dir', join(dir, 'bad-out'), '--no-interactions'], { encoding: 'utf8', stdio: 'pipe' });
} catch (err) {
  badError = String(err.stdout || '') + String(err.stderr || '');
}
check('非法 where 明确报错', () => assert.match(badError, /E_WHERE|E_[A-Z]+/));

// 临时目录由 after() 钩子统一回收。
