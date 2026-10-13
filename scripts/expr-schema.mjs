// 从 Axure 自带控件库（.rplib）系统提取条件表达式语法。
//
// ⚠️ 关键教训：条件样本在 **.rplib** 里，不在 .rp 里。
// 只扫 .rp 会得出「本机没有任何真实条件」的错误结论（本项目曾因此卡住很久）。
// 本机 .rplib 里有 769 个真实条件用例、208 个 BinaryExpr。
import { readFileSync, readdirSync } from 'node:fs';
import { readRecords } from './rp-records.mjs';
import { parsePayload, field } from './parse-payload.mjs';
const D = process.argv[2] ?? '/Applications/Axure RP 11.app/Contents/Resources/DefaultSettings/Libraries';
const cls = new Map(), ops = new Map(), fns = new Map();
let conds = 0;
const walkCol = (n, cls2) => { if (n.tag === 3) return cls2; };
for (const f of readdirSync(D)) {
  if (!f.endsWith('.rplib')) continue;
  for (const r of readRecords(readFileSync(`${D}/${f}`))) {
    if (!r.strings) continue;
    let g; try { g = parsePayload(r); } catch { continue; }
    for (const o of g.objects.values()) {
      cls.set(o.className, (cls.get(o.className) || 0) + 1);
      if (o.className === 'Axure:Expr:BinaryExpr') {
        const op = field(o.body, 'operation'); if (op) ops.set(op.value, (ops.get(op.value) || 0) + 1);
      }
      if (o.className === 'Axure:Expr:FCall') {
        const fn = field(o.body, 'function-name')?.text; if (fn) fns.set(fn, (fns.get(fn) || 0) + 1);
      }
      if (o.className === 'Axure:InteractionCase') {
        const c = field(o.body, 'Condition');
        if (c && c.tag === 3 && g.objects.get(c.value)?.className !== 'Axure:Expr:StringLiteral') conds++;
      }
    }
  }
}
console.log(`真正的条件用例（Condition 指向非 StringLiteral）: ${conds} 个\n`);
console.log('=== 表达式类 ===');
for (const [k, v] of [...cls].filter(([k]) => k.startsWith('Axure:Expr')).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)} ${k}`);
console.log('\n=== BinaryExpr.operation 取值 ===');
for (const [k, v] of [...ops].sort((a, b) => b[1] - a[1])) console.log(`  operation=${k}  出现 ${v} 次`);
console.log('\n=== FCall.function-name 全表 ===');
for (const [k, v] of [...fns].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)} ${k}`);
