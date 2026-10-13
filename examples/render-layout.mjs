// Render the authored rectangle/text/line reference spec, not native Axure output.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertWritable } from '../scripts/engine.mjs';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function renderLayout(spec) {
  const frame = spec.frames[0];
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frame.w} ${frame.h}" role="img" aria-label="zee-rp public reference layout">`,
    `<rect width="${frame.w}" height="${frame.h}" fill="${escape(frame.bg)}"/>`];
  for (const child of frame.children) {
    if (child.kind === 'rect') parts.push(`<rect x="${child.x}" y="${child.y}" width="${child.w}" height="${child.h}" rx="${child.corners ?? 0}" fill="${escape(child.fill ?? 'none')}" stroke="${escape(child.border?.color ?? 'none')}" stroke-width="${child.border?.thickness ?? 1}"/>`);
    else if (child.kind === 'text') parts.push(`<text x="${child.x}" y="${child.y + child.size}" font-family="Arial,sans-serif" font-size="${child.size}" font-weight="${child.weight ?? 400}" fill="${escape(child.color)}">${escape(child.content)}</text>`);
    else if (child.kind === 'line') parts.push(`<line x1="${child.x1}" y1="${child.y1}" x2="${child.x2}" y2="${child.y2}" stroke="${escape(child.color)}" stroke-width="${child.thickness ?? 1}"/>`);
    else throw new Error(`Reference renderer does not support ${child.kind}`);
  }
  return parts.join('\n') + '\n</svg>\n';
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [source, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node examples/render-layout.mjs spec.json preview.svg');
  assertWritable(output);
  writeFileSync(output, renderLayout(JSON.parse(readFileSync(source, 'utf8'))));
}
