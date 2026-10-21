#!/usr/bin/env node
// extract-assets.mjs — 从任意 .rp 文件中提取全部内嵌图片素材（PNG/JPG/GIF/SVG）与几何坐标清单
// 用法：
//   node scripts/extract-assets.mjs <source.rp> -o <out-dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecords } from './rp-records.mjs';
import { parsePayload, field, walkNodes } from './parse-payload.mjs';

function recordOwnerLabels(records) {
  const labels = new Map();
  const docRec = records.find(r => r.className === 'Axure:DesignDocument');
  if (!docRec) return labels;
  let doc;
  try { doc = parsePayload(docRec); } catch { return labels; }
  const docGuids = doc.roots.find(n => n.tag === 0x1e)?.values ?? [];
  const guidToName = new Map();
  for (const obj of doc.objects.values()) {
    if (obj.className !== 'Axure:PackageInfo') continue;
    const pkgId = field(obj.body, 'package-id');
    const pkgGuid = docGuids[(pkgId?.values?.[1] ?? 0) - 1];
    const pkgName = field(obj.body, 'package-name')?.text;
    if (pkgGuid && pkgName) guidToName.set(pkgGuid, pkgName);
  }
  for (const r of records) {
    let g;
    try { g = parsePayload(r); } catch { continue; }
    const gl = g.roots.find(n => n.tag === 0x1e)?.values ?? [];
    const pkgIdx = g.roots.find(n => n.tag === 0x12)?.value;
    const pkgGuid = pkgIdx ? gl[pkgIdx - 1] : null;
    if (pkgGuid && guidToName.has(pkgGuid)) {
      labels.set(r.index, guidToName.get(pkgGuid));
    }
  }
  return labels;
}

function extractStyleGeometry(styleBody, widgetBody) {
  let x = null, y = null, w = null, h = null;
  if (widgetBody) {
    const loc = field(widgetBody, 'location')?.values;
    const sz = field(widgetBody, 'size')?.values;
    if (Array.isArray(loc)) { x = loc[0] ?? x; y = loc[1] ?? y; }
    if (Array.isArray(sz)) { w = sz[0] ?? w; h = sz[1] ?? h; }
  }
  const propList = field(styleBody, 'PropList')?.items ?? [];
  for (const item of propList) {
    const val = field(item, 'Value');
    if (val?.tag !== 1 || !Array.isArray(val.entries)) continue;
    const vx = field(val, 'X')?.value;
    const vy = field(val, 'Y')?.value;
    const vw = field(val, 'Width')?.value;
    const vh = field(val, 'Height')?.value;
    if (typeof vx === 'number') x = vx;
    if (typeof vy === 'number') y = vy;
    if (typeof vw === 'number') w = vw;
    if (typeof vh === 'number') h = vh;
  }
  if (w === null && h === null && x === null && y === null) return null;
  return { x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 };
}

function sanitizeSlug(s) {
  return String(s || 'unnamed')
    .replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
}

export function extractAssets(rpFileOrBuf, outDir) {
  const buf = Buffer.isBuffer(rpFileOrBuf) ? rpFileOrBuf : readFileSync(rpFileOrBuf);
  const absOut = resolve(outDir);
  mkdirSync(absOut, { recursive: true });

  const records = readRecords(buf);
  const ownerMap = recordOwnerLabels(records);
  const assets = [];

  for (const r of records) {
    let graph;
    try { graph = parsePayload(r); } catch { continue; }
    const ownerName = ownerMap.get(r.index) || `${r.className}#${r.index}`;

    const styleToWidget = new Map();
    for (const obj of graph.objects.values()) {
      if (!obj.className.startsWith('Axure:DiagramObject:')) continue;
      const myStyleId = field(obj.body, 'MyStyle')?.value;
      if (typeof myStyleId === 'number') {
        styleToWidget.set(myStyleId, obj);
      }
    }

    for (const obj of graph.objects.values()) {
      const parentWidget = obj.className.startsWith('Axure:DiagramObject:')
        ? obj
        : styleToWidget.get(obj.id) || null;
      const widgetName = parentWidget
        ? (field(field(parentWidget.body, 'name-block') ?? {}, 'text')?.text || '')
        : '';
      const geom = extractStyleGeometry(obj.body, parentWidget?.body);

      let streamIdx = 0;
      walkNodes([obj.body], node => {
        if (node?.tag !== 1 || !Array.isArray(node.entries)) return;
        const streamEntry = node.entries.find(([k]) => k?.text === 'Stream');
        const extEntry = node.entries.find(([k]) => k?.text === 'Extension');
        if (!streamEntry || streamEntry[1]?.tag !== 4 || !streamEntry[1]?.value) return;

        const rawBytes = Buffer.from(streamEntry[1].value, 'base64');
        if (!rawBytes.length) return;
        const rawExt = (extEntry?.[1]?.text || '.png').toLowerCase();
        const ext = rawExt.startsWith('.') ? rawExt : `.${rawExt}`;
        const sha1 = createHash('sha1').update(rawBytes).digest('hex').slice(0, 12);
        const ownerSlug = sanitizeSlug(ownerName);
        const nameSlug = widgetName ? `-${sanitizeSlug(widgetName)}` : '';
        const dimSlug = geom && (geom.w || geom.h) ? `-${Math.round(geom.w)}x${Math.round(geom.h)}` : '';
        const suffix = streamIdx > 0 ? `-s${streamIdx}` : '';
        streamIdx++;

        const fileName = `rec${r.index}-${ownerSlug}-obj${parentWidget ? parentWidget.id : obj.id}${nameSlug}${dimSlug}${suffix}${ext}`;
        const filePath = join(absOut, fileName);
        writeFileSync(filePath, rawBytes);

        assets.push({
          fileName,
          filePath,
          recordIndex: r.index,
          recordClass: r.className,
          ownerName,
          objectId: obj.id,
          widgetId: parentWidget ? parentWidget.id : null,
          objectClass: obj.className,
          widgetClass: parentWidget ? parentWidget.className : null,
          widgetName,
          geometry: geom,
          extension: ext,
          bytes: rawBytes.length,
          sha1,
        });
      });
    }
  }

  const manifest = {
    ok: true,
    source: Buffer.isBuffer(rpFileOrBuf) ? '<buffer>' : resolve(rpFileOrBuf),
    outDir: absOut,
    count: assets.length,
    assets,
  };
  writeFileSync(join(absOut, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let src = null;
  let outDir = null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-o' || args[i] === '--out-dir') && args[i + 1]) {
      outDir = args[++i];
    } else if (!args[i].startsWith('-') && !src) {
      src = args[i];
    } else if (!args[i].startsWith('-') && !outDir) {
      outDir = args[i];
    }
  }
  if (!src || !outDir) {
    console.error('Usage: node extract-assets.mjs <source.rp> -o <out-dir>');
    process.exit(1);
  }
  const res = extractAssets(src, outDir);
  console.log(JSON.stringify(res, null, 2));
}
