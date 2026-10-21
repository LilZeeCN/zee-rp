import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload } from '../scripts/parse-payload.mjs';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const fixtures = () => JSON.parse(readFileSync(join(process.env.AXURE_FIXTURE_ROOT || join(TEST_DIR, 'fixtures'), 'manifest.json'), 'utf8'));

export function summarizeFixture(entry) {
  const file = readFileSync(join(process.env.AXURE_FIXTURE_ROOT || join(TEST_DIR, 'fixtures'), entry.name));
  const rp = readRp(file, { full: true });
  // rp-read 的顶层交互计数不含所有容器；另锁定每个 payload 的完整解析结果，覆盖母版、行模板和状态内部。
  const payloads = readRecords(file).filter(r => r.strings).map(record => {
    const graph = parsePayload(record);
    const objects = [...graph.objects.values()].sort((a, b) => a.id - b.id);
    const classes = {};
    for (const object of objects) classes[object.className] = (classes[object.className] ?? 0) + 1;
    return {
      record: record.index,
      className: record.className,
      objectCount: objects.length,
      classes: Object.fromEntries(Object.entries(classes).sort(([a], [b]) => a.localeCompare(b, 'en'))),
      semanticSha256: sha256(JSON.stringify({ strings: record.strings, roots: graph.roots, objects }))
    };
  });
  return JSON.parse(JSON.stringify({
    filename: entry.name, category: entry.category, sha256: sha256(file), bytes: file.length,
    widgetCount: rp.counts.widgets, interactionCount: rp.counts.interactions, actionCount: rp.counts.actions,
    records: rp.records, counts: rp.counts, sitemap: rp.sitemap, globalVariables: rp.globalVariables,
    pages: rp.pages, containedWidgets: rp.containedWidgets,
    packages: rp.packages.map(({ parts, ...rest }) => rest), problems: rp.problems, payloads
  }));
}
