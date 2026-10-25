import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, assertWritable } from './engine.mjs';
import { renameCustomStyle } from './custom-styles.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [source, output, oldName, newName] = process.argv.slice(2);
    if (process.argv.length !== 6) throw new Error('Usage: node rename-custom-style.mjs <source.rp|rplib> <output.rp|rplib> <oldName> <newName>');
    assertNotProtected(source); assertWritable(output);
    const { file, ...result } = renameCustomStyle(readFileSync(source), oldName, newName);
    writeFileSync(output, file, { flag: 'wx' });
    console.log(JSON.stringify({ output, ...result }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
