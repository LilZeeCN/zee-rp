import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './document.mjs';

export const referencePackRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples/studio/reference-packs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const member = (root, path) => {
  if (typeof path !== 'string' || !resolve(root, path).startsWith(resolve(root) + sep)) fail('E_REFERENCE_PACK_PATH', '参考资源必须位于参考包内');
  return resolve(root, path);
};

function readPack(id, root) {
  if (!/^[a-z0-9-]+$/.test(id)) fail('E_REFERENCE_PACK', '参考包ID需要已登记的短名称');
  const directory = member(root, id), path = join(directory, 'manifest.json');
  if (!existsSync(path)) fail('E_REFERENCE_PACK', `参考包不存在：${id}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.id !== id || !manifest.version || !manifest.source || !manifest.pages?.length) fail('E_REFERENCE_PACK', `参考包清单不完整：${id}`);
  for (const [file, hash] of Object.entries(manifest.files || {})) {
    const path = member(directory, file);
    if (!existsSync(path) || sha256(readFileSync(path)) !== hash) fail('E_REFERENCE_PACK_DRIFT', `参考包资源已变化或缺失：${id}/${file}`);
  }
  if (!manifest.files?.[manifest.source]) fail('E_REFERENCE_PACK', `参考包缺少源文件指纹：${id}`);
  return { directory, manifest };
}

export function listReferencePacks(root = referencePackRoot) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json'))).map(entry => {
    const { manifest } = readPack(entry.name, root);
    return { id: manifest.id, name: manifest.name, version: manifest.version, intent: manifest.intent, platform: manifest.platform,
      pages: manifest.pages, provenance: manifest.provenance, hasPreviews: Object.keys(manifest.files).some(file => file.startsWith('previews/')) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function getReferencePack(id, { pageId = null, includeSource = false, includeImages = false, root = referencePackRoot } = {}) {
  const { directory, manifest } = readPack(id, root);
  const selectedPageId = pageId || manifest.initialPageId || manifest.pages[0].id;
  if (!manifest.pages.some(page => page.id === selectedPageId)) fail('E_REFERENCE_PAGE', `参考包${id}中没有页面${selectedPageId}`);
  const sourcePath = member(directory, manifest.source);
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const selectedPage = source.pages.find(page => page.id === selectedPageId);
  if (!selectedPage) fail('E_REFERENCE_PAGE', `参考源中没有页面${selectedPageId}`);
  const preview = Object.keys(manifest.files).find(file => [ `previews/${selectedPageId}.png`, `previews/${selectedPageId}-initial.png` ].includes(file));
  const result = { id, name: manifest.name, version: manifest.version, intent: manifest.intent, platform: manifest.platform,
    sourcePath, selectedPageId, pages: manifest.pages, design: { ...manifest.design,
      directions: manifest.design.directions.map(direction => ({...direction,
        ...(direction.preview ? {previewPath:member(directory,direction.preview)} : {}),
        ...(direction.commands ? {commandsPath:member(directory,direction.commands)} : {})})) },
    provenance: { ...manifest.provenance, userAccepted: false },
    validation: manifest.validation || null,
    scenarios: manifest.scenarios.map(item => ({ id: item.id, startPageId: item.startPageId, stepCount: item.steps.length })),
    ...(includeSource ? { pageSource: selectedPage } : {}),
    ...(preview ? { previewPath: member(directory, preview) } : {}),
    note: '可编辑参考作品，不是固定模板或当前工程内容；设计选择不代表用户认可。' };
  if (includeImages && preview) result.mcpImages = [{ mimeType: 'image/png', data: readFileSync(member(directory, preview)).toString('base64') }];
  return result;
}
