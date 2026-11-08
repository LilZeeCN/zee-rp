import { state } from './state.mjs';

export function indexScenePages(scene) {
  for (const pg of scene?.pages || []) {
    pg._nodeMap = new Map(pg.nodes.map(n => [n.scopedId, n]));
    pg._indexByScopedId = new Map(pg.nodes.map((n, i) => [n.scopedId, i]));
  }
}

export let projectFontKey = '';

export let projectFontsReady = Promise.resolve();

export const projectFontFaces = new Set();

export function loadProjectFonts(fonts, projectDir) {
  const entries = (fonts?.catalog || []).filter(font => font.family && typeof font.path === 'string');
  const key = JSON.stringify([projectDir, entries]);
  if (key === projectFontKey) return projectFontsReady;
  projectFontKey = key;
  for (const face of projectFontFaces) document.fonts.delete(face);
  projectFontFaces.clear();
  state.projectFontErrors = [];
  projectFontsReady = Promise.all(entries.map(async font => {
    try {
      const parts = font.path.replaceAll('\\', '/').split('/');
      if (parts[0] !== 'fonts' || parts.some(part => !part || part === '.' || part === '..')) throw new Error('工程字体需使用 fonts/ 下的相对路径');
      const url = '/' + parts.map(encodeURIComponent).join('/') + '?project=' + encodeURIComponent(projectDir || '');
      const face = new FontFace(font.family, `url(${JSON.stringify(url)})`, {
        ...(font.weight ? { weight: String(font.weight) } : {}),
        ...(font.style ? { style: font.style } : {}),
      });
      await face.load();
      if (key !== projectFontKey) return;
      document.fonts.add(face);
      projectFontFaces.add(face);
    } catch (error) {
      if (key === projectFontKey) state.projectFontErrors.push({ code: 'E_BROWSER_FONT_LOAD', family: font.family, message: error.message });
    }
  }));
  return projectFontsReady;
}
