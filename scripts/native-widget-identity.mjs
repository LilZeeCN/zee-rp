import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assertNotProtected } from './engine.mjs';
import { guidKey } from './duplicate-page.mjs';
import { readRp } from './rp-read.mjs';

export const officialIdOf = guid => typeof guid === 'string' && /^[0-9a-f]{32}$/i.test(guid) ? guidKey(guid.toLowerCase()) : null;

export function readSourceBaseline(rp, explicit) {
  const path = explicit ?? (rp ? `${rp}.baseline.json` : null);
  if (!path) return null;
  assertNotProtected(path);
  if (!existsSync(path)) {
    if (explicit) throw new Error(`找不到基线文件：${path}`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function nativeWidgetIdentities(rp) {
  const packages = new Map(rp.packages.map(p => [p.record, p]));
  const pages = new Map(rp.pages.map(p => [packages.get(p.record)?.key, p.name]));
  const widgets = new Map();
  const add = (w, record, page) => {
    if (!w.guid) return;
    widgets.set(`${record}:${w.id}`, { ...w, page, record, id: w.id, guid: w.guid, officialId: officialIdOf(w.guid) });
  };
  for (const p of rp.pages) for (const w of p.widgets) add(w, p.record, p.name);
  for (const w of rp.containedWidgets) add(w, w.record, pages.get(packages.get(w.record)?.path?.split('/')[0]));
  return [...widgets.values()];
}

export function bindNativeSymbols(symbols, widgets) {
  const byRecord = new Map(widgets.map(w => [`${w.record}:${w.id}`, w]));
  const byGuid = new Map(widgets.map(w => [w.guid, w]));
  return symbols.map(s => {
    const native = (s.native ?? []).map(loc => {
      const widget = loc.guid ? byGuid.get(loc.guid) : byRecord.get(`${loc.record}:${loc.id}`);
      return !widget || (s.pageName && widget.page && s.pageName !== widget.page && !loc.guid) ? null : {
        ...loc, record: widget.record, id: widget.id, guid: widget.guid, officialId: widget.officialId,
      };
    }).filter(Boolean);
    // Some RP/1 symbols are drawn by several objects (for example a box and
    // its decoration). Keep the primary object's GUID ahead of its pieces.
    const primary = native.find(loc => byGuid.get(loc.guid)?.name && [s.name, s.nativeName, s.display].includes(byGuid.get(loc.guid).name))
      ?? native.find(loc => byGuid.get(loc.guid)?.type !== 'Layer') ?? native[0];
    return { ...s, logicalId: s.logicalId ?? s.id, native, ...(primary ? { officialId: primary.officialId } : {}) };
  });
}

export function readNativeWidgetMap(rp, explicitBaseline) {
  assertNotProtected(rp);
  const baseline = readSourceBaseline(rp, explicitBaseline);
  const widgets = nativeWidgetIdentities(readRp(readFileSync(rp), { path: rp }));
  const symbols = bindNativeSymbols(baseline?.sourceMap ?? [], widgets);
  return { widgets, symbols, baseline };
}

export function saveIdentityBaseline(source, target, rp, explicitBaseline) {
  const baseline = readSourceBaseline(source, explicitBaseline);
  if (!baseline?.sourceMap) return null;
  const path = `${target}.baseline.json`;
  assertNotProtected(path);
  writeFileSync(path, JSON.stringify({
    ...baseline, outputRp: target,
    sourceMap: bindNativeSymbols(baseline.sourceMap, nativeWidgetIdentities(rp)),
  }, null, 2) + '\n', { flag: 'wx' });
  return path;
}
