import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(process.env.AXURE_FIXTURE_ROOT || join(TEST_DIR, 'fixtures'));
export const RP9_FIXTURE_DIR = resolve(process.env.AXURE_RP9_FIXTURE_ROOT || join(FIXTURE_DIR, '..', 'rp9-fixtures'));
export const hasPrivateFixtures = () => existsSync(join(FIXTURE_DIR, 'blank-ui-native.rp'));
export const fixturePath = name => {
  const direct = join(FIXTURE_DIR, name);
  if (existsSync(direct)) return direct;
  const extraDirs = (process.env.AXURE_EXTRA_FIXTURE_DIRS || '').split(':').filter(Boolean);
  for (const dir of extraDirs) {
    const candidate = join(resolve(dir), name);
    if (existsSync(candidate)) return candidate;
  }
  const shipped = join(TEST_DIR, 'fixtures', name);
  if (existsSync(shipped)) return shipped;
  return direct;
};
export const rp9FixturePath = name => {
  const direct = join(RP9_FIXTURE_DIR, name);
  if (existsSync(direct)) return direct;
  return join(TEST_DIR, 'rp9-fixtures', name);
};
export const settingsRoot = () => {
  const root = process.env.AXURE_SETTINGS_ROOT || (process.platform === 'darwin'
    ? '/Applications/Axure RP 11.app/Contents/Resources/DefaultSettings' : '');
  if (!root || !existsSync(root)) throw new Error('Set AXURE_SETTINGS_ROOT to your local Axure RP 11 DefaultSettings directory. Native assets are never downloaded or bundled.');
  return resolve(root);
};
export const resolveLibrary = name => join(process.env.AXURE_LIBRARY_ROOT || join(settingsRoot(), 'Libraries'), name);
export const resolveRuntime = () => join(settingsRoot(), 'Prototype_Files/resources/scripts/axure/expr.js');
