// RP11 实验样本中已验证的链接打开方式：1=current，2=new。
// 使用已确认的局部结构定位，拒绝多候选或未知布局；不是通用 payload 解析器。
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, replaceRecord } from './rp-records.mjs';

const [source, destination, mode] = process.argv.slice(2);
const value = { current: 1, new: 2 }[mode];
if (!source || !destination || !value) {
  throw new Error('用法: node patch-link-window.mjs <source.rp> <new.rp> <current|new>');
}
const file = readFileSync(source), matches = [];
for (const r of readRecords(file).filter(r => r.className === 'Axure:Page')) {
  const field = r.strings.indexOf('link-type'), target = r.strings.indexOf('Axure:InteractionTarget');
  if (field < 0 || target < 0) continue;
  const needle = Buffer.alloc(8); needle.writeUInt32LE(8); needle.writeUInt32LE(field, 4);
  for (let p = r.raw.indexOf(needle, r.payloadStart); p >= 0; p = r.raw.indexOf(needle, p + 1)) {
    if (p + 32 > r.raw.length) continue;
    if (r.raw.readUInt32LE(p + 8) !== 3 || r.raw.readUInt32LE(p + 16) !== 8 ||
        r.raw.readUInt32LE(p + 20) !== target || r.raw.readUInt32LE(p + 24) !== 5) continue;
    const before = r.raw.readUInt32LE(p + 28);
    if (before === 1 || before === 2) matches.push({ r, p: p + 28, before });
  }
}
if (matches.length !== 1) throw new Error(`Expected one supported link, found ${matches.length}`);
const { r, p, before } = matches[0], raw = Buffer.from(r.raw);
raw.writeUInt32LE(value, p);
writeFileSync(destination, replaceRecord(file, r, raw), { flag: 'wx' });
console.log(JSON.stringify({ destination, record: r.index, rawOffset: p,
  payloadOffset: p - r.payloadStart, before, after: value }, null, 2));
