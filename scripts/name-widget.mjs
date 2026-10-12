// 研究用：给指定 Page 记录里的具名/无名元件设置名称（补 skill 缺失的 rename 能力）。
// 原理：元件名 = name-block 的 text 字段（tag8 字符串引用）。
// 用法: node name-widget.mjs <source.rp> <new.rp> <pageName> <widgetId> <newName> [<widgetId2> <newName2> ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';

const [source, destination, pageIndexArg, ...pairs] = process.argv.slice(2);
if (!source || !destination || !pageIndexArg || pairs.length < 2 || pairs.length % 2) {
  throw new Error('用法: node name-widget.mjs <source.rp> <new.rp> <pageRecordsIndex|页名> <widgetId> <newName> [...]');
}
const file = readFileSync(source);
const recs = readRecords(file);
const pageRecords = recs.filter(r => r.className === 'Axure:Page');
// pageIndexArg 可以是页名（在 Page 记录字符串表中唯一出现）或 Page 记录序号（0 起，纯数字）
const byName = /^\d+$/.test(pageIndexArg) ? undefined
  : recs.find(r => r.className === 'Axure:Page' && r.strings.includes(pageIndexArg));
const page = byName ?? pageRecords[Number(pageIndexArg)];
if (!page) throw new Error(`Page not found: ${pageIndexArg}`);

const g = parsePayload(page);
const strings = [...page.strings];
const ensure = name => {
  const i = strings.indexOf(name);
  if (i >= 0) return i + 1;
  strings.push(name);
  return strings.length;
};
const applied = [];
for (let i = 0; i < pairs.length; i += 2) {
  const id = Number(pairs[i]), name = pairs[i + 1];
  const o = g.objects.get(id);
  if (!o) throw new Error(`Widget #${id} not found in page record #${page.index}`);
  const nb = field(o.body, 'name-block');
  if (!nb) throw new Error(`Widget #${id} has no name-block`);
  const textField = nb.entries.find(([k]) => k.text === 'text');
  if (!textField) throw new Error(`Widget #${id} name-block has no text field`);
  const idx = ensure(name);
  textField[1].value = idx;
  textField[1].text = name;
  applied.push({ id, name, stringIndex: idx });
}
const payload = encodePayload(g.roots);
const raw = encodeRecord(page, strings, payload);
const output = replaceRecord(file, page, raw);
writeFileSync(destination, output, { flag: 'wx' });
console.log(JSON.stringify({ destination, pageRecord: page.index, applied, oldSize: file.length, newSize: output.length }, null, 2));
