import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload } from '../scripts/parse-payload.mjs';
import { TEST_DIR, fixturePath } from './native-inputs.mjs';
export { TEST_DIR };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const fixtures = () => JSON.parse(readFileSync(join(TEST_DIR, 'historical-fixture-contract.json'), 'utf8'));
export function summarizeFixture(entry) {
  const file = readFileSync(fixturePath(entry.name));
  const rp = readRp(file, { full: true });
  const payloads = readRecords(file).filter(r => r.strings).map(record => {
    const graph = parsePayload(record), objects = [...graph.objects.values()].sort((a, b) => a.id - b.id), classes = {};
    for (const object of objects) classes[object.className] = (classes[object.className] ?? 0) + 1;
    return { record: record.index, className: record.className, objectCount: objects.length,
      classes: Object.fromEntries(Object.entries(classes).sort(([a], [b]) => a.localeCompare(b, 'en'))),
      semanticSha256: sha256(JSON.stringify({ strings: record.strings, roots: graph.roots, objects })) };
  });
  const complete = JSON.parse(JSON.stringify({ filename: entry.name, category: entry.category, sha256: sha256(file), bytes: file.length,
    widgetCount: rp.counts.widgets, interactionCount: rp.counts.interactions, actionCount: rp.counts.actions,
    records: rp.records, counts: rp.counts, sitemap: rp.sitemap, globalVariables: rp.globalVariables,
    pages: rp.pages, containedWidgets: rp.containedWidgets, packages: rp.packages.map(({ parts, ...rest }) => rest), problems: rp.problems, payloads }));
  // Preserve the full historical assertion as a fingerprint, without redistributing native document text or serialized assets.
  return { filename: entry.name, category: entry.category, sha256: complete.sha256, bytes: complete.bytes,
    records: { unparseable: complete.records.unparseable }, counts: { danglingRefs: complete.counts.danglingRefs, problems: complete.counts.problems },
    summarySha256: sha256(JSON.stringify(complete)) };
}
