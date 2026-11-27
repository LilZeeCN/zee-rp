import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected } from './engine.mjs';
import { readRp } from './rp-read.mjs';

export function indexLibrary(path) {
  const file = resolve(path);
  assertNotProtected(file);
  if (extname(file).toLowerCase() !== '.rplib') throw new Error('Input must be an .rplib file');
  const summary = readRp(readFileSync(file), { path: file });
  const pages = summary.pages.map(({ name, folder, record, widgets }) => ({
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
    counts: { pages: pages.length, widgets: pages.reduce((count, page) => count + page.widgets.length, 0) },
    ...(problems.length && { problems }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file || file.startsWith('--') || flags.some(flag => flag !== '--json')) {
    console.error('Usage: zee-rp index-library <source.rplib> [--json]');
    process.exitCode = 1;
  } else {
    try {
      const index = indexLibrary(file);
      if (flags.includes('--json')) console.log(JSON.stringify(index));
      else {
        console.log(`RP${index.version} · ${index.counts.pages} library items · ${index.counts.widgets} top-level widgets`);
        for (const page of index.pages) {
          const widgets = page.widgets.map(widget =>
            `#${widget.id} ${widget.name || widget.className.replace(/^Axure:DiagramObject:/, '')} ${widget.width ?? '?'}×${widget.height ?? '?'}`);
          console.log(`#${page.record} ${[...page.folder, page.name].join(' / ')}  ${widgets.join(', ')}`);
        }
        if (index.problems) console.error(JSON.stringify(index.problems));
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
