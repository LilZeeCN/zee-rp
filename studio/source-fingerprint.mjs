import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
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
  const scratch = Buffer.allocUnsafe(64 * 1024);
  for (const file of listImplementationFiles('studio').sort()) {
    hash.update(file).update('\0');
    updateFileHash(hash, join(root, file), scratch);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function updateFileHash(hash, path, scratch) {
  const fd = openSync(path, 'r');
  try {
    for (let bytes; (bytes = readSync(fd, scratch, 0, scratch.length, null)) > 0;) {
      hash.update(scratch.subarray(0, bytes));
    }
  } finally { closeSync(fd); }
  return hash;
}
