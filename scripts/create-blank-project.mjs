import { copyFileSync, readFileSync, constants } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from './rp-records.mjs';
import { readRp } from './rp-read.mjs';
import { parsePayload, field } from './parse-payload.mjs';

import { resolveBlankTemplate } from './blank-template.mjs';

export function createBlankProject(outputPath) {
  const TEMPLATE = resolveBlankTemplate();
  const output = resolve(outputPath);
  if (extname(output).toLowerCase() !== '.rp') throw new Error('Output path must end in .rp');

  const template = readFileSync(TEMPLATE);
  const summary = readRp(template, { path: TEMPLATE });
  const records = readRecords(template);
  const page = records.find(record => record.index === summary.pages[0]?.record && record.className === 'Axure:Page');
  const graph = page && parsePayload(page);
  const pageObject = graph && [...graph.objects.values()].find(object => object.className === 'Axure:Page');
  const diagram = pageObject && graph.objects.get(field(pageObject.body, 'diagram')?.value);
  const objects = field(diagram?.body ?? {}, 'diagram-objects')?.items ?? [];

  if (summary.pages.length !== 1 || summary.counts.widgets !== 0 || summary.counts.panelStates !== 0 || objects.length !== 0) {
    throw new Error('Bundled Axure template is no longer a one-page blank project');
  }
  copyFileSync(TEMPLATE, output, constants.COPYFILE_EXCL);
  return {
    output,
    template: TEMPLATE,
    page: summary.pages[0].name,
    pages: summary.counts.pages,
    widgets: summary.counts.widgets,
    panelStates: summary.counts.panelStates,
    bytes: template.length
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [output] = process.argv.slice(2);
  if (!output) {
    console.error('Usage: node create-blank-project.mjs <output.rp>');
    process.exit(1);
  }
  console.log(JSON.stringify(createBlankProject(output), null, 2));
}
