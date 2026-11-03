import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotProtected, canonicalJson, sha256 } from './document.mjs';

const worker = join(dirname(fileURLToPath(import.meta.url)), 'media-worker.py');
const fail = message => { throw Object.assign(new Error(message), { code: 'E_MEDIA_RECIPE' }); };
function normalizeRecipe(c, tokens, warnings = [], cropLabel = null) {
  const r = { w: c.w, h: c.h, fx: c.fx ?? 0.5, fy: c.fy ?? 0.5, fh: c.fh ?? 1, scale: c.scale ?? 2 };
  if (![r.w, r.h].every(v => Number.isInteger(v) && v >= 1 && v <= 4096) || ![1, 2, 3].includes(r.scale)) fail('w/h 为 1–4096 整数；scale 为 1、2 或 3');
  if (![r.fx, r.fy, r.fh].every(v => Number.isFinite(v) && v >= 0 && v <= 1) || r.fh === 0) fail('fx/fy 为 0–1，fh 为 (0,1]');
  if (c.protectedRegion) {
    const p = c.protectedRegion;
    if (!['x', 'y', 'w', 'h'].every(k => Number.isFinite(p[k]) && p[k] >= 0) || p.w <= 0 || p.h <= 0 || p.x + p.w > 1 || p.y + p.h > 1) fail('protectedRegion 为原图中归一化的有效 x/y/w/h');
    r.protectedRegion = p;
  }
  if (c.fadeToToken !== undefined) {
    const color = tokens?.colors?.[c.fadeToToken];
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) {
      // 底色令牌过期/缺失走警告级（T-F-2）：与评审期 W_MEDIA_TOKEN_STALE 同名同因，
      // 回落白底继续出图，不再让有效裁切为令牌改名整单陪葬。
      warnings.push({
        code: 'W_MEDIA_TOKEN_STALE',
        crop: cropLabel,
        token: c.fadeToToken,
        message: `渐变底色令牌不存在或不是六位颜色：${c.fadeToToken}，本裁切已回落 #FFFFFF`,
      });
      if (!Number.isFinite(c.fadeFrom) || c.fadeFrom < 0 || c.fadeFrom >= r.h) fail('fadeFrom 必须在图框高度内');
      Object.assign(r, { fadeFrom: c.fadeFrom, fadeToToken: c.fadeToToken, fadeColor: '#FFFFFF' });
    } else {
      if (!Number.isFinite(c.fadeFrom) || c.fadeFrom < 0 || c.fadeFrom >= r.h) fail('fadeFrom 必须在图框高度内');
      Object.assign(r, { fadeFrom: c.fadeFrom, fadeToToken: c.fadeToToken, fadeColor: color });
    }
  }
  return r;
}
function runWorker(job) {
  return new Promise((resolveJob, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', [worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        if (code) throw Object.assign(new Error(error.slice(-1500)), { code: 'E_MEDIA_WORKER' });
        const result = JSON.parse(output);
        if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
        resolveJob(result);
      } catch (err) { reject(err); }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

export async function prepareMedia({ projectDir, sourcePath, crops, tokens = {}, credit = null, onProgress = null }) {
  if (!sourcePath || !Array.isArray(crops) || !crops.length || crops.length > 20) fail('需要 sourcePath 和 1–20 项 crops');
  const source = resolve(sourcePath); assertNotProtected(source);
  const bytes = readFileSync(source), sourceSha256 = sha256(bytes);
  const originalPath = `assets/original-${sourceSha256}${extname(source).toLowerCase() || '.img'}`;
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  mkdirSync(join(projectDir, 'media', 'recipes'), { recursive: true });
  if (!existsSync(join(projectDir, originalPath))) copyFileSync(source, join(projectDir, originalPath));
  if (sha256(readFileSync(join(projectDir, originalPath))) !== sourceSha256) throw Object.assign(new Error('工程中保留的原图已变化，请恢复原图'), { code: 'E_MEDIA_ORIGINAL_DRIFT' });
  const results = [], failures = [], warnings = [];
  // 本单写盘的产物路径：失败单要清掉未登记的孤儿文件（T-F-5/T-FR-1）。
  const written = [];
  for (const [index, crop] of crops.entries()) {
    const label = crop.name || crop.out || null;
    if(typeof onProgress==='function')await onProgress('preparing-crop',{index,total:crops.length});
    try {
      const recipe = normalizeRecipe(crop, tokens, warnings, label);
      const recipeHash = sha256(canonicalJson({ version: 1, sourceSha256, recipe }));
      const relativePath = `assets/media-${recipeHash}.jpg`, outputPath = join(projectDir, relativePath);
      const recipePath = join(projectDir, 'media', 'recipes', `${recipeHash}.json`);
      let geometry;
      if (existsSync(recipePath) && existsSync(outputPath)) {
        geometry = JSON.parse(readFileSync(recipePath)).geometry;
        // G7 之前的存量配方不含 warnings/sourceFormat：重放检测补齐并回写配方文件，
        // 让缓存命中路径同样给出透明/动画丢失警告（T-F-1）；检测失败时保留旧产物不升级。
        if (!Array.isArray(geometry.warnings) || !geometry.sourceFormat) {
          const temp = `${outputPath}.probe-${process.pid}`;
          try {
            const fresh = await runWorker({ sourcePath: join(projectDir, originalPath), outputPath: temp, recipe });
            geometry = { width: geometry.width, height: geometry.height, ...fresh };
            writeFileSync(recipePath, JSON.stringify({ version: 1, sourceSha256, originalPath, recipe, geometry, credit }, null, 2));
          } catch { /* 保留旧 geometry */ } finally { rmSync(temp, { force: true }); }
        }
      }
      else {
        const temp = `${outputPath}.tmp-${process.pid}`;
        try {
          geometry = await runWorker({ sourcePath: join(projectDir, originalPath), outputPath: temp, recipe });
          copyFileSync(temp, outputPath);
        } finally { rmSync(temp, { force: true }); }
        written.push(outputPath);
        writeFileSync(recipePath, JSON.stringify({ version: 1, sourceSha256, originalPath, recipe, geometry, credit }, null, 2));
      }
      for (const w of geometry.warnings || []) warnings.push({ ...w, crop: label });
      const asset = { relativePath, sha256: sha256(readFileSync(outputPath)), width: geometry.width, height: geometry.height,
        media: { recipeHash, sourceSha256, originalPath, recipe, credit,
          ...(geometry.sourceFormat ? { sourceFormat: geometry.sourceFormat } : {}) } };
      results.push({ name: label, src: relativePath, asset, geometry, registerCommand: { type: 'registerAsset', asset } });
    } catch (err) {
      // 逐项隔离（T-F-5）：一个坏配方不再拖垮整单，成功 crop 照常登记。
      failures.push({ name: label, index, code: err.code || 'E_MEDIA_RECIPE', message: err.message });
    }
  }
  // 清理孤儿：本单写过、但没有进入登记列表的产物一律删除，保证 assets/ 与响应登记零 diff。
  const registered = new Set(results.map(r => join(projectDir, r.asset.relativePath)));
  for (const path of written) if (!registered.has(path)) rmSync(path, { force: true });
  if (!results.length) {
    return { ok: false, code: failures[0]?.code || 'E_MEDIA_RECIPE', documentChanged: false,
      sourceSha256, originalPath, results, failures, warnings,
      message: failures[0]?.message || '所有裁切均失败',
      next: '按 failures 逐项修正配方后重试；原图已按内容寻址保留，可直接重放。' };
  }
  return { ok: true, documentChanged: false, sourceSha256, originalPath, results,
    ...(failures.length ? { failures } : {}), warnings,
    next: '把 registerCommand 与 image 节点的 src/w/h 修改一起提交给 studio_apply_commands；资源登记与挂载可共同撤销。' };
}
