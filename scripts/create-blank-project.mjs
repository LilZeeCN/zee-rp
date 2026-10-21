import { copyFileSync, readFileSync, constants } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from './rp-records.mjs';
import { readRp } from './rp-read.mjs';
import { parsePayload, field } from './parse-payload.mjs';

import { resolveBlankTemplate } from './blank-template.mjs';
import { assertNotProtected } from './engine.mjs';
import { DEFAULT_VERSION, detectFileVersion, resolveTargetVersion } from './version.mjs';

export function createBlankProject(outputPath, { version = DEFAULT_VERSION } = {}) {
  const target = resolveTargetVersion(version);
  const TEMPLATE = resolveBlankTemplate(target);
  const output = resolve(outputPath);
  assertNotProtected(output);
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
    throw new Error('Resolved Axure template is no longer a one-page blank project');
  }
  copyFileSync(TEMPLATE, output, constants.COPYFILE_EXCL);
  return {
    output,
    version: detectFileVersion(template),
    template: TEMPLATE,
    page: summary.pages[0].name,
    pages: summary.counts.pages,
    widgets: summary.counts.widgets,
    panelStates: summary.counts.panelStates,
    bytes: template.length
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 注意：不能用「第一个非 -- 开头的参数」直接取 output，--version 的值会被误当路径。
  const argv = process.argv.slice(2);
  const positional = [];
  let version = DEFAULT_VERSION;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') { version = argv[++i]; continue; }
    if (argv[i].startsWith('--')) continue;
    positional.push(argv[i]);
  }
  const output = positional[0];
  if (!output) {
    console.error('Usage: node create-blank-project.mjs <output.rp> [--version 9|11]');
    process.exit(1);
  }
  console.log(JSON.stringify(createBlankProject(output, { version }), null, 2));
}
