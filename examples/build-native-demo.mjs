import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBlankProject } from '../scripts/create-blank-project.mjs';
import { cloneLibraryWidget } from '../scripts/clone-library-widget.mjs';
import { cloneLibraryPageContent } from '../scripts/clone-library-page-content.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { resolveLibrary } from '../test/native-inputs.mjs';
import { assertWritable } from '../scripts/engine.mjs';

// All native bytes come from the user's local installation and blank template.
// This recipe and its content are public; generated .rp/.rplib files are never distributed.
export function buildNativeDemo(destination) {
  const output = resolve(destination);
  assertWritable(output);
  mkdirSync(output);
  let source = join(output, '00-blank.rp');
  const blank = createBlankProject(source), page = blank.page;
  const library = resolveLibrary('Default.rplib');
  const widgets = [
    ['Button', 'SubmitButton', 40, 40, 160, 40],
    ['Paragraph', 'StatusBanner', 40, 110, 400, 70],
    ['Text field', 'NameInput', 40, 210, 260, 40],
    ['Box 1', 'AnchorA', 40, 290, 120, 60],
    ['Box 1', 'AnchorB', 240, 290, 120, 60]
  ];
  for (const [index, [sourcePageName, name, x, y, width, height]] of widgets.entries()) {
    const target = join(output, `${index + 1}-widget.rp`);
    cloneLibraryWidget(library, source, target, { sourcePageName, targetPageName: page, name, x, y, width, height });
    source = target;
  }
  const table = join(output, 'table.rp');
  cloneLibraryPageContent(library, join(output, '00-blank.rp'), table,
    { sourcePageName: 'Classic table', targetPageName: page, x: 40, y: 40 });
  const manifest = { page, source: '5-widget.rp', table: 'table.rp', widgets: widgets.map(w => w[1]),
    evidence: 'Generated from local native assets; offline structure only until opened and tested in Axure.' };
  writeFileSync(join(output, 'demo.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  for (const name of [manifest.source, manifest.table]) {
    const summary = readRp(readFileSync(join(output, name)));
    if (summary.counts.problems || summary.counts.danglingRefs || summary.records.unparseable)
      throw new Error(`Generated ${name} has structural problems`);
  }
  return { output, ...manifest };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 3) throw new Error('Usage: node examples/build-native-demo.mjs <new-directory>');
  console.log(JSON.stringify(buildNativeDemo(process.argv[2]), null, 2));
}
