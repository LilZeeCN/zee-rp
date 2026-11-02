import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { rebindWidgets, widgetSelector } from './custom-styles.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [source, output, guid, selector, flag] = process.argv.slice(2);
    if (!selector || process.argv.length > 7 || (flag !== undefined && flag !== '--reset-overrides'))
      throw new Error('Usage: node rebind-widgets.mjs <source.rp|rplib> <output.rp|rplib> <styleGuid> <selector.json> [--reset-overrides]');
    assertNotProtected(source); assertWritable(output); assertNotProtected(selector);
    const { file, ...result } = rebindWidgets(readFileSync(source), guid, widgetSelector(JSON.parse(readFileSync(selector, 'utf8'))), { resetOverrides: flag === '--reset-overrides' });
    writeFileSync(output, file, { flag: 'wx' });
    console.log(JSON.stringify({ output, ...result }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
