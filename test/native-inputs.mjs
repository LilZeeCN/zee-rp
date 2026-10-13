import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(process.env.AXURE_FIXTURE_ROOT || join(TEST_DIR, 'fixtures'));
export const fixturePath = name => join(FIXTURE_DIR, name);
export const settingsRoot = () => {
  const root = process.env.AXURE_SETTINGS_ROOT || (process.platform === 'darwin'
    ? '/Applications/Axure RP 11.app/Contents/Resources/DefaultSettings' : '');
  if (!root || !existsSync(root)) throw new Error('Set AXURE_SETTINGS_ROOT to your local Axure RP 11 DefaultSettings directory. Native assets are never downloaded or bundled.');
  return resolve(root);
};
export const resolveLibrary = name => join(process.env.AXURE_LIBRARY_ROOT || join(settingsRoot(), 'Libraries'), name);
export const resolveRuntime = () => join(settingsRoot(), 'Prototype_Files/resources/scripts/axure/expr.js');
