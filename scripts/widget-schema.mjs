// 从 Axure 自带控件库提取「每个元件类型的完整字段清单」。
// 目标：验证「通用元件构造器 + 每类型字段表」是否可行 —— 即字段集合是否稳定且完备。
import { readFileSync, readdirSync } from 'node:fs';
import { readRecords } from './rp-records.mjs';
import { parsePayload } from './parse-payload.mjs';

import { installRoot, resolveTargetVersion } from './version.mjs';
import { join } from 'node:path';
const DIR = process.argv[2] ?? join(installRoot(resolveTargetVersion()), 'Libraries');
const byType = new Map();   // className -> { count, fieldSets: Map<signature, count>, fields: Map<name, Set<tag>> }

const tagName = t => ({ 1: 'dict', 2: 'list', 3: 'ref', 4: 'blob', 5: 'int', 6: 'f64', 8: 'str',
  9: 'obj', 0xf: 'f?', 0x10: 'pair', 0x11: 'v11', 0x12: 'v12', 0x13: 'pair13', 0x16: 'guidref',
  0x19: 'bool', 0x1a: 'm1a', 0x1c: 'm1c', 0x1d: 'guid', 0x1e: 'guidlist' }[t] ?? ('tag' + t));

for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.rplib')) continue;
  for (const r of readRecords(readFileSync(`${DIR}/${f}`))) {
    if (!r.strings) continue;
    let g; try { g = parsePayload(r); } catch { continue; }
    for (const o of g.objects.values()) {
      if (!o.className.startsWith('Axure:DiagramObject:') && !o.className.startsWith('Axure:Repeater')) continue;
      if (!byType.has(o.className)) byType.set(o.className, { count: 0, sigs: new Map(), fields: new Map() });
      const e = byType.get(o.className);
      e.count++;
      const names = o.body.entries.map(([k]) => k.text);
      const sig = names.join('|');
      e.sigs.set(sig, (e.sigs.get(sig) || 0) + 1);
      for (const [k, v] of o.body.entries) {
        if (!e.fields.has(k.text)) e.fields.set(k.text, new Map());
        const m = e.fields.get(k.text);
        m.set(tagName(v.tag), (m.get(tagName(v.tag)) || 0) + 1);
      }
    }
  }
}

console.log(`控件库里的元件类型：${byType.size} 种\n`);
const rows = [...byType].sort((a, b) => b[1].count - a[1].count);
for (const [cls, e] of rows) {
  const multi = e.sigs.size > 1;
  console.log(`${cls.replace('Axure:DiagramObject:', '').padEnd(20)} 实例=${String(e.count).padStart(4)}  字段数=${String(e.fields.size).padStart(3)}  字段组合变体=${e.sigs.size}${multi ? '  ⚠️字段集合不固定' : '  ✅字段集合唯一'}`);
}
console.log('\n--- 字段出现频次 Top（判断哪些是共性字段）---');
const global = new Map();
for (const [, e] of rows) for (const [name, tags] of e.fields) {
  if (!global.has(name)) global.set(name, { types: 0, total: 0 });
  const gg = global.get(name); gg.types++; gg.total += [...tags.values()].reduce((a, b) => a + b, 0);
}
for (const [k, v] of [...global].sort((a, b) => b[1].types - a[1].types).slice(0, 22))
  console.log(`  ${String(v.types).padStart(2)}/${byType.size} 类型  总出现${String(v.total).padStart(5)}  ${k}`);
