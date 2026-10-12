// 研究用：只替换唯一 Axure:Page 记录中的一个已有字符串，输出新副本。
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';

const [source, destination, before, after] = process.argv.slice(2);
if (!source || !destination || before === undefined || after === undefined) {
  throw new Error('用法: node patch-string.mjs <source.rp> <new.rp> <old string> <new string>');
}
const file = readFileSync(source);
const matches = readRecords(file).filter(r => r.className === 'Axure:Page' && r.strings.includes(before));
if (matches.length !== 1) throw new Error(`Expected one matching page, found ${matches.length}`);
const record = matches[0], strings = [...record.strings];
const index = strings.indexOf(before);
if (strings.lastIndexOf(before) !== index) throw new Error('String is not unique');
strings[index] = after;
const output = replaceRecord(file, record, encodeRecord(record, strings));
writeFileSync(destination, output, { flag: 'wx' });
console.log(JSON.stringify({ destination, record: record.index, stringIndex: index,
  before, after, oldSize: file.length, newSize: output.length }, null, 2));
