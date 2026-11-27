import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertNotProtected } from './engine.mjs';
import { readRp } from './rp-read.mjs';

export function indexLibrary(path, { folder, limit } = {}) {
  const file = resolve(path);
  assertNotProtected(file);
  if (extname(file).toLowerCase() !== '.rplib') throw new Error('Input must be an .rplib file');
  const summary = readRp(readFileSync(file), { path: file });
  const matching = folder === undefined ? summary.pages : summary.pages.filter(page => {
    const path = page.folder.join('/');
    return path === folder || path.startsWith(folder + '/');
  });
  const pages = (limit === undefined ? matching : matching.slice(0, limit)).map(({ name, folder, record, widgets }) => ({
    name, folder, record,
    widgets: widgets.map(({ id, name, className, w, h, text }) => ({
      id, ...(name && { name }), className, width: w, height: h,
      ...(text !== undefined && { text }),
    })),
  }));
  // Repeated labels in different folders are valid library items. Records disambiguate them.
  const problems = summary.problems.filter(problem => problem.kind !== 'duplicate-name');
  return {
    file, version: summary.version, pages,
    counts: { pages: matching.length, widgets: matching.reduce((count, page) => count + page.widgets.length, 0) },
    ...(pages.length < matching.length && { omitted: matching.length - pages.length }),
    ...(problems.length && { problems }),
  };
}

const usage = 'Usage: zee-rp index-library <source.rplib> [--folder <path>] [--limit <count>] [--json]';
const maxSummaryBytes = 4096;

function formatIndex(index, showItems) {
  const head = `RP${index.version} · ${index.counts.pages} library items · ${index.counts.widgets} top-level widgets`;
  const folders = new Map();
  for (const page of index.pages) {
    const folder = page.folder.join('/') || '(root)';
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  const lines = showItems
    ? index.pages.map(page => `#${page.record} ${[...page.folder, page.name].join(' / ')} (${page.widgets.length} widgets)`)
    : [...folders].map(([folder, count]) => `${folder}: ${count}`);
  const details = showItems ? 'Use --json for widget IDs, sizes and text.' : 'Use --limit N to list items, or --json for the full index.';
  const diagnostics = index.problems ? ` · ${index.problems.length} structural diagnostics in --json` : '';
  let output = head + diagnostics + '\n';
  let listed = 0;
  for (const line of lines) {
    const safe = line.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
    if (Buffer.byteLength(output) + Buffer.byteLength(safe) + 200 > maxSummaryBytes) break;
    output += safe + '\n';
    listed++;
  }
  const omitted = lines.length - listed + (index.omitted ?? 0);
  if (omitted) output += `${omitted} more ${showItems ? 'items' : 'folders'} omitted.\n`;
  return output + details + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
      json: { type: 'boolean' },
      folder: { type: 'string' },
      limit: { type: 'string' },
    } });
    if (positionals.length !== 1 || values.folder === '') throw new Error(usage);
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && (!/^\d+$/.test(values.limit) || !Number.isSafeInteger(limit))) {
      throw new Error('--limit must be a non-negative integer');
    }
    const index = indexLibrary(positionals[0], { folder: values.folder, limit });
    if (values.json) console.log(JSON.stringify(index));
    else process.stdout.write(formatIndex(index, limit !== undefined));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
