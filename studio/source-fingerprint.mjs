import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFile = /\.(mjs|js|py|swift|rp1|html|css)$/;

export function listImplementationFiles(directory) {
  const path = join(root, directory);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !['node_modules', '__pycache__'].includes(entry.name)) {
      return listImplementationFiles(relative);
    }
    return entry.isFile() && sourceFile.test(entry.name) ? [relative] : [];
  });
}

export function studioSourceFingerprint() {
  const hash = createHash('sha256');
  for (const file of listImplementationFiles('studio').sort()) {
    hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
  }
  return hash.digest('hex');
}
