import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNotProtected, assertWritable, resolveWorkDir } from './engine.mjs';
import { pythonInvocation } from './python.mjs';
import { findChromeExecutable, launchChrome } from '../studio/cdp.mjs';

const VIRTUAL_CLOCK_SHIM = `(() => {
  if (window.__zeeClockInstalled) return;
  window.__zeeClockInstalled = true;
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  let now = 0;
  let nextId = 100000;
  const queue = [];
  const clock = window.__zeeClock = {
    get now() { return now; },
    get pending() { return queue.length; },
    advance(ms) {
      const delta = Math.max(0, Number(ms) || 0);
      const target = now + delta;
      while (true) {
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const item = queue[0];
        if (!item || item.at > target) break;
        queue.shift();
        now = item.at;
        if (item.interval) {
          queue.push({ ...item, at: item.at + item.delay });
        }
        try {
          if (typeof item.fn === 'function') item.fn.apply(null, item.args);
        } catch (err) {
          setTimeout(() => { throw err; }, 0);
        }
      }
      now = target;
      return now;
    },
  };
  let seq = 1;
  window.setTimeout = function(fn, delay = 0, ...args) {
    const d = Number(delay) || 0;
    if (d < 200) return origSetTimeout(fn, delay, ...args);
    const id = nextId++;
    queue.push({ id, seq: seq++, fn, delay: d, at: now + d, interval: false, args });
    return id;
  };
  window.clearTimeout = function(id) {
    const idx = queue.findIndex(q => q.id === id);
    if (idx >= 0) { queue.splice(idx, 1); return; }
    origClearTimeout(id);
  };
  window.setInterval = function(fn, delay = 0, ...args) {
    const d = Number(delay) || 0;
    if (d < 200) return origSetInterval(fn, delay, ...args);
    const id = nextId++;
    queue.push({ id, seq: seq++, fn, delay: Math.max(200, d), at: now + Math.max(200, d), interval: true, args });
    return id;
  };
  window.clearInterval = function(id) {
    const idx = queue.findIndex(q => q.id === id);
    if (idx >= 0) { queue.splice(idx, 1); return; }
    origClearInterval(id);
  };
})();`;

const STITCH_STORYBOARD_PY = `
import json, sys
from PIL import Image, ImageDraw
meta = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
out_path = sys.argv[2]
frames = meta.get('frames', [])
if not frames:
    sys.exit(1)
imgs = []
for f in frames:
    im = Image.open(f['path']).convert('RGB')
    imgs.append((im, f.get('label', ''), f.get('failed', False)))
gap = 12
header_h = 30
max_h = max(im.height for im, _, _ in imgs)
total_w = sum(im.width for im, _, _ in imgs) + gap * (len(imgs) + 1)
canvas = Image.new('RGB', (total_w, max_h + header_h + gap * 2), (241, 245, 249))
draw = ImageDraw.Draw(canvas)
x = gap
for im, label, failed in imgs:
    bar_bg = (220, 38, 38) if failed else (15, 23, 42)
    draw.rectangle([x, gap, x + im.width - 1, gap + header_h - 1], fill=bar_bg)
    safe_lbl = ''.join(ch if 32 <= ord(ch) < 127 else '?' for ch in str(label))[:46]
    draw.text((x + 8, gap + 9), safe_lbl, fill=(255, 255, 255))
    canvas.paste(im, (x, gap + header_h))
    border = (220, 38, 38) if failed else (203, 213, 225)
    draw.rectangle([x, gap, x + im.width - 1, gap + header_h + im.height - 1], outline=border, width=2 if failed else 1)
    x += im.width + gap
canvas.save(out_path, format='PNG')
`;

function buildStoryboardPng(frames, outPngPath = null) {
  if (!frames.length) return null;
  const stage = mkdtempSync(join(tmpdir(), 'zee-storyboard-'));
  try {
    const manifest = frames.map((f, idx) => {
      const p = join(stage, `frame-${idx}.png`);
      writeFileSync(p, f.png);
      return { path: p, label: f.label, failed: Boolean(f.failed) };
    });
    const metaPath = join(stage, 'manifest.json');
    const targetPng = outPngPath || join(stage, 'storyboard.png');
    writeFileSync(metaPath, JSON.stringify({ frames: manifest }));
    const inv = pythonInvocation(['-B', '-c', STITCH_STORYBOARD_PY, metaPath, targetPng]);
    const proc = spawnSync(inv.command, inv.args, { encoding: 'utf8', timeout: 30_000 });
    if (proc.status !== 0) throw new Error(proc.stderr || 'Storyboard stitch failed');
    return readFileSync(targetPng);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const sha = value => createHash('sha256').update(value).digest('hex');

// Install before navigating, including in the player's content iframe. The
// Axure data API exists before the player sends finishInit. RP's adaptive
// loadFinished runs after visibility setup and dispatch of OnPageLoad.
function installAxureStartupProbe() {
  const startup = window.__zeeAxureStartup = { waiting: false, revision: 0 };
  const hook = () => {
    const adaptive = window.$axure?.internal?.(api => api.adaptive);
    const loadFinished = adaptive?.loadFinished;
    if (typeof loadFinished !== 'function' || startup.hooked) return;
    startup.hooked = true;
    startup.waiting = true;
    adaptive.loadFinished = function (...args) {
      const result = Reflect.apply(loadFinished, this, args);
      startup.waiting = false;
      return result;
    };
  };
  document.addEventListener('readystatechange', hook);
  document.addEventListener('load', event => {
    if (event.target.tagName === 'SCRIPT') hook();
  }, true);
  new MutationObserver(records => {
    if (records.some(record => (record.target.parentElement?.closest('#base') || record.target.id === 'base'))) {
      startup.revision++;
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// Serialized into the real browser. Only reads Axure state and installs bounded
// passive listeners; never evaluates source expressions or writes test values.
export function observeAxure({ names = [], variables = [], waitForInitialization = false } = {}) {
  const windows = [window];
  const wantFilter = Array.isArray(names) && names.length > 0;
  for (let i = 0; i < windows.length && i < 20; i++) {
    const w = windows[i];
    try {
      if (w.$axure?.internal) {
        const ax = w.$axure.internal(api => api);
        if (ax.pageData?.page && ax.globalVariableProvider) {
          const d = w.document;
          const startup = w.__zeeAxureStartup;
          if (waitForInitialization && (d.readyState !== 'complete' || startup?.waiting || d.fonts?.status === 'loading')) {
            return { ready: false, reason: '正在等待 Axure 内容页及初始显隐完成。' };
          }
          if (!w.__zeeRpPreviewProbe) {
            const probe = w.__zeeRpPreviewProbe = { events: [], errors: [] };
            const add = (list, value) => { list.push(value); if (list.length > 50) list.shift(); };
            d.addEventListener('click', e => add(probe.events, { event: 'click', name: e.target.closest?.('[data-label]')?.getAttribute('data-label') ?? null, at: Date.now() }), true);
            d.addEventListener('change', e => add(probe.events, { event: 'change', name: e.target.closest?.('[data-label]')?.getAttribute('data-label') ?? null, at: Date.now() }), true);
            w.addEventListener('error', e => add(probe.errors, { message: e.message, source: e.filename, line: e.lineno }));
            w.addEventListener('unhandledrejection', e => add(probe.errors, { message: String(e.reason) }));
          }
          let offX = 0, offY = 0, curW = w;
          while (curW && curW !== window) {
            const fe = curW.frameElement;
            if (!fe) break;
            const fr = fe.getBoundingClientRect();
            offX += fr.left + (fe.clientLeft || 0);
            offY += fr.top + (fe.clientTop || 0);
            curW = curW.parent;
          }
          const widgets = [...d.querySelectorAll('[data-label]')]
            .filter(el => !el.classList.contains('panel_state'))
            .filter(el => !wantFilter || names.includes(el.getAttribute('data-label')))
            .map(el => {
              let r = el.getBoundingClientRect();
              // Axure Layer wrappers have zero CSS size while their children are
              // visible and receive the group's click. Measure actual children.
              if ((!r.width || !r.height) && (/^grp-/.test(el.getAttribute('data-label') || '') || el.classList.contains('ax_default'))) {
                const rects = [...el.querySelectorAll('[data-label]')].filter(child => {
                  for (let cur = child; cur && cur !== el; cur = cur.parentElement) {
                    const cs = w.getComputedStyle(cur);
                    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
                  }
                  return true;
                }).map(child => child.getBoundingClientRect()).filter(rect => rect.width && rect.height);
                if (rects.length) {
                  const left = Math.min(...rects.map(rc => rc.left));
                  const top = Math.min(...rects.map(rc => rc.top));
                  const right = Math.max(...rects.map(rc => rc.right));
                  const bottom = Math.max(...rects.map(rc => rc.bottom));
                  r = { left, top, right, bottom, width: right - left, height: bottom - top };
                }
              }
              const input = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select');
              let visible = r.width > 0 && r.height > 0;
              for (let cur = el; cur; cur = cur.parentElement) {
                const cs = w.getComputedStyle(cur);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') visible = false;
              }
              let panelState = null;
              if (el.querySelector(':scope > .panel_state')) {
                const sid = ax.visibility?.GetPanelState?.(el.id);
                const stateEl = sid ? d.getElementById(sid) : null;
                panelState = stateEl?.getAttribute('data-label') ?? null;
                if (!panelState) {
                  const st = [...el.children].find(c => c.classList.contains('panel_state') && w.getComputedStyle(c).display !== 'none' && w.getComputedStyle(c).visibility !== 'hidden');
                  panelState = st?.getAttribute('data-label') ?? null;
                }
              }
              const info = typeof ax.getWidgetInfo === 'function' ? ax.getWidgetInfo(el.id) : null;
              const x = typeof info?.x === 'number' ? info.x : r.left;
              const y = typeof info?.y === 'number' ? info.y : r.top;
              const width = typeof info?.width === 'number' && info.width > 0 ? info.width : r.width;
              const height = typeof info?.height === 'number' && info.height > 0 ? info.height : r.height;
              const textVal = input ? input.value : (el.innerText?.trim() ?? '');
              return {
                id: el.id,
                name: el.getAttribute('data-label'),
                text: textVal,
                value: textVal,
                visible,
                enabled: !input?.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('disabled'),
                checked: Boolean(input?.checked),
                inputId: input?.id ?? null,
                inputTag: input?.tagName?.toLowerCase() ?? null,
                panelState,
                x, y, left: x, top: y, right: x + width, bottom: y + height,
                width, height,
                centerX: offX + r.left + r.width / 2,
                centerY: offY + r.top + r.height / 2,
              };
            });
          const values = {};
          const defined = ax.globalVariableProvider.getDefinedVariables();
          const wantVars = variables.length ? variables : defined;
          for (const name of wantVars) {
            if (defined.some(key => key.toLowerCase() === name.toLowerCase())) {
              values[name] = ax.globalVariableProvider.getVariableValue(name);
            }
          }
          const animating = Boolean(w.jQuery && w.jQuery(':animated').length > 0);
          return {
            ready: true,
            page: ax.pageData.page.name,
            url: w.location.href,
            animating,
            ...(waitForInitialization ? { startupRevision: startup?.revision ?? 0 } : {}),
            widgets,
            variables: values,
            events: [...w.__zeeRpPreviewProbe.events],
            errors: [...w.__zeeRpPreviewProbe.errors],
          };
        }
      }
      for (let n = 0; n < w.frames.length; n++) { try { if (w.frames[n].document) windows.push(w.frames[n]); } catch {} }
    } catch {}
  }
  return { ready: false, reason: '当前页面尚未加载可读取的 Axure 原生运行时。' };
}

function initialStateKey(observation) {
  return JSON.stringify([observation.page, observation.url, observation.variables, observation.widgets]);
}

async function captureStableAxureInitial(observe, capture, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const key = observation => JSON.stringify([observation.startupRevision, initialStateKey(observation)]);
  let lastKey = null;
  let stableSince = 0;
  let observation;
  do {
    observation = await observe();
    const currentKey = observation.ready && !observation.animating ? key(observation) : null;
    if (currentKey !== lastKey) {
      lastKey = currentKey;
      stableSince = Date.now();
    } else if (currentKey !== null && Date.now() - stableSince >= 100) {
      if (!capture) return { observation };
      const png = await capture();
      observation = await observe();
      if (observation.ready && !observation.animating && key(observation) === currentKey) return { observation, png };
      lastKey = null;
    }
    await new Promise(resolve => setTimeout(resolve, 35));
  } while (Date.now() < deadline);
  throw Object.assign(new Error('Axure 初始显隐未在超时前稳定，无法采集一致的首帧。'), {
    code: 'E_VERIFY_INITIAL_UNSTABLE', actual: observation,
  });
}

export function resolvePreviewSymbol(map, target) {
  const found = (map.symbols ?? []).filter(s =>
    [s.id, s.logicalId, s.name, s.display, s.label, s.pointer, ...(Array.isArray(s.aliases) ? s.aliases : [])]
      .filter(Boolean)
      .includes(target)
    || (typeof s.id === 'string' && s.id.endsWith('/' + target))
  );
  if (found.length !== 1) throw Object.assign(new Error(`目标 "${target}" 缺失或重名，请使用 page/id 或精确 data-label。`),
    { code: 'E_PREVIEW_TARGET', candidates: found.map(s => s.id) });
  return found[0];
}

export function clickObservedAxure({ url, id }) {
  const windows = [window];
  for (let i = 0; i < windows.length && i < 20; i++) {
    const w = windows[i];
    try {
      if (w.location.href === url) {
        const el = w.document.getElementById(id);
        if (el && w.getComputedStyle(el).display !== 'none') { el.click(); return true; }
      }
      for (let n = 0; n < w.frames.length; n++) { try { if (w.frames[n].document) windows.push(w.frames[n]); } catch {} }
    } catch {}
  }
  return false;
}

const normVerifyWs = value => String(value ?? '').replace(/[ \t]+/g, ' ').trim();

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function normalizeVerifySteps(rawSteps = []) {
  const out = [];
  for (const step of rawSteps || []) {
    if (!step || typeof step !== 'object') continue;
    const rawAction = step.action === 'assert' ? 'expect' : step.action === 'input' ? 'fill' : (step.action || 'expect');
    const exp = step.expect;
    const hasStudioExpectMaps = isPlainObject(exp) && (
      isPlainObject(exp.visible)
      || isPlainObject(exp.checked)
      || isPlainObject(exp.panelState)
      || isPlainObject(exp.variables)
      || (isPlainObject(exp.text) && !Object.hasOwn(exp.text, 'includes') && !Object.hasOwn(exp.text, 'contains'))
    );
    if (!hasStudioExpectMaps) {
      out.push(rawAction === step.action ? step : { ...step, action: rawAction });
      continue;
    }
    if (rawAction !== 'expect') {
      const { expect: _dropped, ...actionOnly } = step;
      out.push({ ...actionOnly, action: rawAction });
    }
    if ('page' in exp) {
      out.push({ action: 'expect', expect: { page: exp.page } });
    }
    if (isPlainObject(exp.variables)) {
      for (const [variable, equals] of Object.entries(exp.variables)) {
        out.push({ action: 'expect', expect: { variable, equals } });
      }
    }
    if (isPlainObject(exp.visible)) {
      for (const [target, visible] of Object.entries(exp.visible)) {
        out.push({ action: 'expect', target, expect: { visible } });
      }
    }
    if (isPlainObject(exp.text)) {
      for (const [target, text] of Object.entries(exp.text)) {
        out.push({ action: 'expect', target, expect: { text } });
      }
    }
    if (isPlainObject(exp.checked)) {
      for (const [target, checked] of Object.entries(exp.checked)) {
        out.push({ action: 'expect', target, expect: { checked } });
      }
    }
    if (isPlainObject(exp.panelState)) {
      for (const [target, panelState] of Object.entries(exp.panelState)) {
        out.push({ action: 'expect', target, expect: { panelState } });
      }
    }
  }
  return out;
}

async function captureFramedScreenshot(page, { frame = 'viewport', activeEngine, canvasW = null, canvasH = null, vp }) {
  if (frame !== 'artboard') return page.screenshot({ format: 'png' });
  try {
    const clip = await page.evaluate(`(() => {
      const vw = window.innerWidth || ${Math.round(vp?.width || 1280)};
      const vh = window.innerHeight || ${Math.round(vp?.height || 900)};
      const cw = ${Number.isFinite(canvasW) && canvasW > 0 ? Math.round(canvasW) : 'null'};
      const ch = ${Number.isFinite(canvasH) && canvasH > 0 ? Math.round(canvasH) : 'null'};
      if (${JSON.stringify(activeEngine)} === 'studio-html') {
        const el = document.querySelector('#studio-export-board') || document.querySelector('#screen-root') || document.querySelector('.artboard-outer');
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width >= 32 && r.height >= 32) {
            const x = Math.max(0, Math.floor(r.left));
            const y = Math.max(0, Math.floor(r.top));
            return { x, y, width: Math.min(vw - x, Math.ceil(r.width)), height: Math.min(vh - y, Math.ceil(r.height)) };
          }
        }
      } else {
        const mainFrame = document.querySelector('#mainFrame') || document.querySelector('iframe');
        const frameRect = mainFrame ? mainFrame.getBoundingClientRect() : { left: 0, top: 0, width: vw, height: vh };
        const doc = mainFrame?.contentDocument || document;
        const base = doc.getElementById('base') || doc.body;
        const items = [...doc.querySelectorAll('[data-label]')].map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
        let x = Math.max(0, Math.floor(frameRect.left));
        let y = Math.max(0, Math.floor(frameRect.top));
        if (items.length && !cw) {
          const minL = Math.min(...items.map(r => r.left));
          const minT = Math.min(...items.map(r => r.top));
          const maxR = Math.max(...items.map(r => r.right));
          const maxB = Math.max(...items.map(r => r.bottom));
          const w = Math.min(vw - x, Math.ceil(maxR - Math.max(0, minL)));
          const h = Math.min(vh - y, Math.ceil(maxB - Math.max(0, minT)));
          x = Math.max(0, Math.floor(frameRect.left + Math.max(0, minL)));
          y = Math.max(0, Math.floor(frameRect.top + Math.max(0, minT)));
          if (w >= 32 && h >= 32) return { x, y, width: w, height: h };
        }
        const bRect = base ? base.getBoundingClientRect() : frameRect;
        const w = Math.min(vw - x, Math.round(cw || bRect.width || frameRect.width));
        const h = Math.min(vh - y, Math.round(ch || bRect.height || frameRect.height));
        if (w >= 32 && h >= 32) return { x, y, width: w, height: h };
      }
      return null;
    })()`);
    if (clip && clip.width >= 32 && clip.height >= 32) {
      return await page.screenshot({ format: 'png', clip: { ...clip, scale: 1 } });
    }
  } catch {}
  return page.screenshot({ format: 'png' });
}

export function previewMismatch(step, observation, widget, map, baselineWidget = null) {
  const expected = step.expect ?? {}, failures = [];
  const tol = typeof expected.tolerance === 'number' && Number.isFinite(expected.tolerance) ? expected.tolerance : 1.5;
  if ('page' in expected) {
    const page = (map?.pages ?? []).find(p => p.id === expected.page);
    if (observation.page !== (page?.name ?? expected.page)) failures.push({ field: 'page', expected: page?.name ?? expected.page, actual: observation.page });
  }
  if ('variable' in expected && (!Object.hasOwn(observation.variables, expected.variable) || String(observation.variables[expected.variable]) !== String(expected.equals)))
    failures.push({ field: 'variable:' + expected.variable, expected: expected.equals, actual: observation.variables[expected.variable] ?? null });
  if ('text' in expected) {
    const actualText = String(widget?.text ?? '');
    const expText = expected.text;
    const needle = isPlainObject(expText) ? (expText.includes ?? expText.contains) : null;
    const textMatched = needle !== null && needle !== undefined
      ? (actualText.includes(String(needle)) || normVerifyWs(actualText).includes(normVerifyWs(needle)))
      : (actualText.trim() === String(expText).trim() || normVerifyWs(actualText) === normVerifyWs(expText));
    if (!widget || !textMatched) failures.push({ field: 'text', expected: expText, actual: widget?.text ?? null });
  }
  for (const field of ['value', 'visible', 'enabled', 'checked', 'panelState']) {
    if (field in expected && widget?.[field] !== expected[field]) {
      failures.push({ field, expected: expected[field], actual: widget?.[field] ?? null });
    }
  }
  for (const field of ['width', 'height', 'x', 'y', 'left', 'right', 'top', 'bottom']) {
    if (field in expected && (typeof widget?.[field] !== 'number' || Math.abs(widget[field] - expected[field]) > (['width', 'height'].includes(field) ? 0.5 : tol))) {
      failures.push({ field, expected: expected[field], actual: widget?.[field] ?? null });
    }
  }
  if ('dx' in expected) {
    const actualDx = baselineWidget && widget ? widget.x - baselineWidget.x : null;
    if (actualDx === null || Math.abs(actualDx - expected.dx) > tol) failures.push({ field: 'dx', expected: expected.dx, actual: actualDx });
  }
  if ('dy' in expected) {
    const actualDy = baselineWidget && widget ? widget.y - baselineWidget.y : null;
    if (actualDy === null || Math.abs(actualDy - expected.dy) > tol) failures.push({ field: 'dy', expected: expected.dy, actual: actualDy });
  }
  return failures;
}

function collectStudioNodeNames(studioDoc) {
  const namesByScoped = new Map();
  const walk = (node, pageId) => {
    if (!node || typeof node !== 'object') return;
    if (node.id && typeof node.name === 'string' && node.name.trim()) {
      namesByScoped.set(`${pageId}/${node.id}`, node.name.trim());
    }
    for (const child of node.children ?? []) walk(child, pageId);
    for (const st of node.states ?? []) {
      if (st.root) walk(st.root, pageId);
      for (const child of st.children ?? []) walk(child, pageId);
    }
    if (node.template) walk(node.template, pageId);
  };
  for (const page of studioDoc?.pages ?? []) {
    if (page?.id && page.root) walk(page.root, page.id);
  }
  return namesByScoped;
}

function buildVerificationMap({ source, rp, runWorkflow }) {
  if (source) {
    const absSrc = resolve(source);
    assertNotProtected(absSrc);
    const map = runWorkflow('preview-map', absSrc);
    if (!map.ok) throw Object.assign(new Error(map.diagnostics?.[0]?.message || 'Unable to read RP/1 preview map'), { code: 'E_VERIFY_SOURCE' });
    return map;
  }
  if (rp && existsSync(`${rp}.baseline.json`)) {
    try {
      const base = JSON.parse(readFileSync(`${rp}.baseline.json`, 'utf8'));
      const pages = [];
      const seenPages = new Set();
      let studioNames = null;
      if (base.studioOrigin?.sourceFile) {
        const studioDocPath = resolve(dirname(rp), base.studioOrigin.sourceFile);
        if (existsSync(studioDocPath)) {
          try {
            studioNames = collectStudioNodeNames(JSON.parse(readFileSync(studioDocPath, 'utf8')));
          } catch {}
        }
      }
      const symbols = (base.sourceMap ?? []).map(s => {
        if (s.pageId && !seenPages.has(s.pageId)) {
          seenPages.add(s.pageId);
          pages.push({ id: s.pageId, name: s.pageName ?? s.pageId });
        }
        const studioName = studioNames?.get(s.id);
        const studioQualified = studioName && s.pageId ? `${s.pageId}/${studioName}` : null;
        const aliases = [studioName, studioQualified].filter(a => a && a !== s.label && a !== s.id);
        return aliases.length ? { ...s, aliases } : s;
      });
      return {
        ok: true,
        semanticHash: base.semanticHash ?? null,
        variables: Object.keys(base.sourceSpec?.variables ?? {}),
        pages,
        symbols,
      };
    } catch {}
  }
  return null;
}

function findWidgetMatch(observation, symbol, target, { allowHidden = false, rowIndex = 0 } = {}) {
  const pool = observation.widgets ?? [];
  const candidates = symbol
    ? pool.filter(w => {
      const targetKeys = new Set([symbol.name, symbol.display, symbol.label, symbol.id, symbol.logicalId, ...(Array.isArray(symbol.aliases) ? symbol.aliases : [])].filter(Boolean));
      const widgetKeys = [w.name, w.id, w.scopedId, w.label].filter(Boolean);
      return widgetKeys.some(k => targetKeys.has(k)) && (allowHidden || w.visible);
    })
    : pool.filter(w => [w.name, w.id, w.scopedId, w.label].includes(target) && (allowHidden || w.visible));
  return { candidates, widget: candidates[rowIndex] };
}

function startStaticServer(rootDir, defaultEntry = 'start.html') {
  const realRoot = realpathSync(rootDir);
  const server = createServer((req, res) => {
    try {
      const reqPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const relPath = reqPath === '/' ? defaultEntry : reqPath.replace(/^\/+/, '');
      const full = realpathSync(resolve(realRoot, relPath));
      if (!full.startsWith(realRoot + sep) || !statSync(full).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', MIME_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream');
      createReadStream(full).on('error', () => res.destroy()).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return server;
}

export async function captureOfficialHtmlScreenshot({
  htmlDir,
  outPng,
  viewport = { width: 1280, height: 900, dpr: 1 },
  timeoutMs = 10000,
} = {}) {
  findChromeExecutable();
  const server = startStaticServer(htmlDir);
  let browser = null;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/start.html`;
    const vp = {
      width: Math.min(3840, Math.max(320, Math.round(viewport?.width ?? 1280))),
      height: Math.min(2160, Math.max(320, Math.round(viewport?.height ?? 900))),
      dpr: viewport?.dpr ?? 1,
    };
    browser = await launchChrome({ headless: true, width: vp.width, height: vp.height, dpr: vp.dpr });
    const page = await browser.openPage(url);
    const obsExpr = `(${observeAxure.toString()})({ names: [], variables: [] })`;
    await page.waitForFunction(`(() => { const r = ${obsExpr}; return Boolean(r && r.ready); })()`, { timeoutMs, pollMs: 50 });
    await page.evaluate('document.fonts ? document.fonts.ready.catch(() => {}) : Promise.resolve()');
    await new Promise(r => setTimeout(r, 80));
    const png = await page.screenshot({ format: 'png' });
    mkdirSync(dirname(outPng), { recursive: true });
    writeFileSync(outPng, png);
    return outPng;
  } finally {
    try { await browser?.close(); } catch {}
    try { server.close(); server.closeAllConnections?.(); } catch {}
  }
}

async function exportStudioHtmlForVerify({ rpPath, sourcePath, tempStageDir }) {
  const { importToStudioDocument } = await import('../studio/document.mjs');
  const { exportStudioDocumentToCode } = await import('../studio/export-code.mjs');
  let docInput = sourcePath || rpPath;
  if (rpPath) {
    const studioDocFile = `${rpPath}.source/studio-document.json`;
    if (existsSync(studioDocFile)) {
      docInput = studioDocFile;
    } else if (!sourcePath) {
      const stemRp1 = rpPath.replace(/\.rp$/i, '.rp1');
      if (existsSync(stemRp1)) {
        docInput = stemRp1;
      } else if (existsSync(`${rpPath}.baseline.json`)) {
        try {
          const base = JSON.parse(readFileSync(`${rpPath}.baseline.json`, 'utf8'));
          if (base?.sourcePath && existsSync(base.sourcePath)) docInput = base.sourcePath;
        } catch {}
      }
    }
  }
  const doc = importToStudioDocument(docInput, { projectDir: tempStageDir });
  const htmlDir = join(tempStageDir, 'studio-html');
  await exportStudioDocumentToCode(doc, { outDir: htmlDir, registerExport: false });
  return { htmlDir, doc };
}

export async function verifyOfficialPreview(input, { runWorkflow, exportHtml }) {
  const engine = input.engine ?? 'auto';
  if (!['auto', 'official', 'studio-html'].includes(engine)) {
    throw Object.assign(new Error(`未知 verify 引擎 "${engine}"，可选 auto / official / studio-html`), { code: 'E_VERIFY_INPUT' });
  }
  const workDir = resolveWorkDir(input.cwd ?? input.projectDir);
  const rpPath = input.rp ? resolve(workDir, input.rp) : null;
  const htmlInputDir = input.html ? resolve(workDir, input.html) : null;
  const sourcePath = input.source ? resolve(workDir, input.source) : null;
  const screenshotPath = input.screenshot ? resolve(workDir, input.screenshot) : null;
  const storyboardPath = input.storyboard ? resolve(workDir, input.storyboard) : null;
  if (!rpPath && !htmlInputDir && !(engine === 'studio-html' && sourcePath)) {
    throw Object.assign(new Error('verify_prototype 需要至少提供 rp（已生成 .rp）或 html（HTML 目录）之一（或传 engine:"studio-html" + source）。'), { code: 'E_VERIFY_INPUT' });
  }
  if (rpPath) assertNotProtected(rpPath);
  if (sourcePath) assertNotProtected(sourcePath);
  if (htmlInputDir) assertNotProtected(htmlInputDir);
  for (const [kind, p] of [['screenshot', screenshotPath], ['storyboard', storyboardPath]]) {
    if (!p) continue;
    assertNotProtected(p);
    assertWritable(p);
    if (extname(p).toLowerCase() !== '.png') {
      throw Object.assign(new Error(`${kind} 必须是以 .png 结尾的新文件路径。`), { code: 'E_VERIFY_SCREENSHOT' });
    }
    if (lstatSync(p, { throwIfNoEntry: false })) {
      throw Object.assign(new Error(`截图输出已存在，禁止覆盖：${p}`), { code: 'E_VERIFY_SCREENSHOT_EXISTS' });
    }
  }

  const timeoutMs = input.timeoutMs ?? 8000;
  const vp = {
    width: input.viewport?.width ?? 1280,
    height: input.viewport?.height ?? 900,
    dpr: input.viewport?.dpr ?? 1,
  };
  let tempStageDir = null;
  let activeHtmlDir = htmlInputDir;
  let activeEngine = engine;
  let officialHtmlExported = false;
  let studioHtmlExported = false;
  let engineFallbackReason = null;

  if (activeHtmlDir) {
    const hasOfficial = existsSync(join(activeHtmlDir, 'start.html'));
    const hasStudio = existsSync(join(activeHtmlDir, 'index.html'));
    if (engine === 'official' && !hasOfficial) {
      throw Object.assign(new Error(`官方 HTML 目录缺少 start.html：${activeHtmlDir}`), { code: 'E_VERIFY_HTML' });
    }
    if (engine === 'studio-html' && !hasStudio) {
      throw Object.assign(new Error(`Studio HTML 目录缺少 index.html：${activeHtmlDir}`), { code: 'E_VERIFY_HTML' });
    }
    if (!hasOfficial && !hasStudio) {
      throw Object.assign(new Error(`HTML 目录缺少 start.html 或 index.html：${activeHtmlDir}`), { code: 'E_VERIFY_HTML' });
    }
    activeEngine = hasOfficial && engine !== 'studio-html' ? 'official' : 'studio-html';
    findChromeExecutable();
  } else {
    findChromeExecutable();
  }
  const map = buildVerificationMap({ source: sourcePath, rp: rpPath, runWorkflow });
  const frameMode = input.frame === 'artboard' ? 'artboard' : 'viewport';
  const rawSteps = (Array.isArray(input.steps) && input.steps.length > 0) ? input.steps : (map?.verifySteps ?? []);
  const steps = normalizeVerifySteps(rawSteps);
  const useVirtualClock = Boolean(input.virtualClock || steps.some(s => s.action === 'advanceTime'));
  const wantStoryboard = Boolean(storyboardPath || input.includeStoryboard);
  const storyboardFrames = [];
  if (!activeHtmlDir) {
    tempStageDir = mkdtempSync(join(workDir, '.zee-verify-'));
    if (engine === 'studio-html') {
      const studioExp = await exportStudioHtmlForVerify({ rpPath, sourcePath, tempStageDir });
      activeHtmlDir = studioExp.htmlDir;
      studioHtmlExported = true;
      activeEngine = 'studio-html';
    } else {
      const exportedHtml = join(tempStageDir, 'html');
      const exp = await exportHtml({ rp: rpPath, output: exportedHtml, cwd: workDir });
      if (exp.status === 'completed') {
        activeHtmlDir = exp.output;
        officialHtmlExported = true;
        activeEngine = 'official';
      } else if (engine === 'official') {
        rmSync(tempStageDir, { recursive: true, force: true });
        return {
          status: 'failed',
          engine: 'official',
          evidence: 'axure-official-html-cdp',
          officialHtmlReady: false,
          verification: { officialHtmlExported: false, browserLoaded: false, behaviorVerified: false },
          diagnostics: exp.diagnostics,
        };
      } else {
        engineFallbackReason = exp.diagnostics?.[0]?.message || '本机 Axure 官方 HTML 导出不可用，已自动切换 Studio 离线 HTML 引擎';
        const studioExp = await exportStudioHtmlForVerify({ rpPath, sourcePath, tempStageDir });
        activeHtmlDir = studioExp.htmlDir;
        studioHtmlExported = true;
        activeEngine = 'studio-html';
      }
    }
  }

  const extraNames = steps.flatMap(s => s.target ? [s.target] : []);
  const mapNames = map ? map.symbols.flatMap(s => [s.name, s.display, s.label]).filter(Boolean) : [];
  const names = map ? [...new Set([...mapNames, ...extraNames])] : [];
  const variables = [...new Set([...(map?.variables ?? []), ...steps.flatMap(s => s.expect?.variable ? [s.expect.variable] : [])])];

  const observeExpr = activeEngine === 'official'
    ? `(${observeAxure.toString()})(${JSON.stringify({ names, variables, waitForInitialization: true })})`
    : `(() => window.__STUDIO_EXPORT_APP__ ? window.__STUDIO_EXPORT_APP__.observeForVerify() : { ready: false })()`;
  const entryHtmlFile = activeEngine === 'official' ? 'start.html' : 'index.html';
  const server = startStaticServer(activeHtmlDir, entryHtmlFile);
  let browser = null;
  let page = null;
  const history = [];
  const result = {
    status: 'completed',
    engine: activeEngine,
    frame: frameMode,
    evidence: activeEngine === 'official' ? 'axure-official-html-cdp' : 'studio-html-cdp',
    ...(activeEngine === 'official' ? {
      officialHtmlSource: officialHtmlExported ? 'exported' : 'provided',
      officialHtmlReady: true,
    } : {}),
    verification: activeEngine === 'official'
      ? { officialHtmlExported, browserLoaded: false, behaviorVerified: false }
      : { officialHtmlExported: false, studioHtmlExported, browserLoaded: false, behaviorVerified: false },
    ...(engineFallbackReason ? { engineFallbackReason } : {}),
    passed: 0,
    total: steps.length,
    ...(rpPath ? { rp: rpPath } : {}),
    html: htmlInputDir ?? '(temporary)',
    steps: history,
  };

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/${entryHtmlFile}`;
    let startUrl = baseUrl;
    const targetPageEntry = input.page
      ? map?.pages?.find(p => p.id === input.page || p.name === input.page)
      : map?.pages?.[0];
    if (input.page) {
      startUrl += `#p=${encodeURIComponent(targetPageEntry?.name ?? input.page)}`;
    }
    const rawCanvas = targetPageEntry?.canvas;
    const canvasW = Array.isArray(rawCanvas) ? Number(rawCanvas[0]) : Number(rawCanvas?.w);
    const canvasH = Array.isArray(rawCanvas) ? Number(rawCanvas[1]) : Number(rawCanvas?.h);
    if (!input.viewport && Number.isFinite(canvasW) && canvasW > 0) {
      vp.width = Math.min(3840, Math.max(320, Math.round(canvasW)));
      if (Number.isFinite(canvasH) && canvasH > 0) {
        vp.height = Math.min(2160, Math.max(320, Math.round(canvasH)));
      }
    }

    browser = await launchChrome({ headless: true, width: vp.width, height: vp.height, dpr: vp.dpr });
    if (useVirtualClock || activeEngine === 'official') {
      page = await browser.openPage('about:blank');
      if (activeEngine === 'official') {
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installAxureStartupProbe.toString()})()` });
      }
      if (useVirtualClock) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: VIRTUAL_CLOCK_SHIM });
      await page.navigate(startUrl, timeoutMs);
    } else {
      page = await browser.openPage(startUrl);
    }

    const observe = () => page.evaluate(observeExpr);
    const waitForRuntime = () => page.waitForFunction(`(() => { const r = ${observeExpr}; return Boolean(r && r.ready); })()`, { timeoutMs, pollMs: 50 });
    const settle = async (waitMs = Math.min(timeoutMs, 2500)) => {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const obs = await observe();
        if (obs.ready && !obs.animating) return obs;
        await new Promise(r => setTimeout(r, 40));
      }
      return observe();
    };

    const captureInitial = wantStoryboard
      ? () => captureFramedScreenshot(page, { frame: frameMode, activeEngine, canvasW, canvasH, vp })
      : null;
    let before;
    let initialKey = null;
    if (activeEngine === 'official') {
      const initial = await captureStableAxureInitial(observe, captureInitial, timeoutMs);
      before = initial.observation;
      initialKey = initialStateKey(before);
      if (initial.png) storyboardFrames.push({ label: '#0 Initial', png: initial.png, failed: false });
    } else {
      await waitForRuntime();
      before = await settle();
      if (captureInitial) storyboardFrames.push({ label: '#0 Initial', png: await captureInitial(), failed: false });
    }
    result.verification.browserLoaded = true;
    result.initial = before;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.action !== 'expect') initialKey = null;
      const checkInitialState = current => {
        if (initialKey !== null && initialStateKey(current) !== initialKey) {
          throw Object.assign(new Error('首屏断言期间 Axure 状态发生变化，已停止重放以保留首帧与断言的一致性。'), {
            code: 'E_VERIFY_INITIAL_DRIFT', stepIndex: i, actual: current,
          });
        }
      };
      let symbol = null;
      if (step.target) {
        try { symbol = map ? resolvePreviewSymbol(map, step.target) : null; }
        catch (err) {
          const direct = before.widgets.find(w => w.name === step.target);
          if (!direct) throw err;
        }
      }
      const allowHidden = step.action === 'expect' && step.expect?.visible === false;
      const { candidates, widget } = step.target
        ? findWidgetMatch(before, symbol, step.target, { allowHidden, rowIndex: step.rowIndex ?? 0 })
        : { candidates: [], widget: null };
      const entry = { index: i, action: step.action, target: symbol?.id ?? step.target ?? null, status: 'running' };
      history.push(entry);
      if (step.target && step.rowIndex === undefined && candidates.length > 1) {
        throw Object.assign(new Error(`目标 "${step.target}" 在预览中匹配到 ${candidates.length} 个实例，请指定 rowIndex。`), { code: 'E_PREVIEW_AMBIGUOUS', stepIndex: i });
      }
      if (step.target && !widget && !allowHidden) {
        throw Object.assign(new Error(`当前页未找到可见目标 "${step.target}"。`), { code: 'E_PREVIEW_NOT_VISIBLE', stepIndex: i });
      }

      const baselineWidget = widget ? { ...widget } : null;

      if (step.action === 'click') {
        if (!widget.enabled) throw Object.assign(new Error(`目标 "${step.target}" 当前被禁用。`), { code: 'E_PREVIEW_DISABLED', stepIndex: i });
        await page.mouseClick(widget.centerX, widget.centerY);
        await new Promise(r => setTimeout(r, 60));
      } else if (step.action === 'fill') {
        if (!widget.enabled) throw Object.assign(new Error(`目标 "${step.target}" 当前被禁用。`), { code: 'E_PREVIEW_DISABLED', stepIndex: i });
        if (!widget.inputId) throw Object.assign(new Error(`目标 "${step.target}" 不含原生表单输入控件。`), { code: 'E_PREVIEW_INPUT', stepIndex: i });
        const fillResult = await page.evaluate(`(() => {
          const wins = [window];
          for (let k = 0; k < wins.length && k < 20; k++) {
            const w = wins[k];
            try {
              const el = w.document.getElementById(${JSON.stringify(widget.inputId)});
              if (el) {
                el.focus();
                if (el.tagName === 'SELECT') {
                  el.value = ${JSON.stringify(step.value ?? '')};
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return { mode: 'select', ok: true };
                }
                if (el.type === 'checkbox' || el.type === 'radio') {
                  el.click();
                  return { mode: 'check', ok: true };
                }
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                if (typeof el.select === 'function') el.select();
                return { mode: 'text', ok: true };
              }
              for (let n = 0; n < w.frames.length; n++) { try { if (w.frames[n].document) wins.push(w.frames[n]); } catch {} }
            } catch {}
          }
          return { ok: false };
        })()`);
        if (!fillResult?.ok) throw Object.assign(new Error(`无法聚焦输入框 "${step.target}"。`), { code: 'E_PREVIEW_INPUT', stepIndex: i });
        if (fillResult.mode === 'text') {
          await page.send('Input.insertText', { text: String(step.value ?? '') });
          await page.evaluate(`(() => {
            const wins = [window];
            for (let k = 0; k < wins.length && k < 20; k++) {
              const w = wins[k];
              try {
                const el = w.document.getElementById(${JSON.stringify(widget.inputId)});
                if (el) {
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.blur();
                  return true;
                }
                for (let n = 0; n < w.frames.length; n++) { try { if (w.frames[n].document) wins.push(w.frames[n]); } catch {} }
              } catch {}
            }
            return false;
          })()`);
        }
        await new Promise(r => setTimeout(r, 60));
      } else if (step.action === 'drag') {
        const dx = Number(step.dx ?? 0);
        const dy = Number(step.dy ?? 0);
        await page.mouseDrag(widget.centerX, widget.centerY, widget.centerX + dx, widget.centerY + dy, {
          steps: step.steps ?? 12,
          stepDelayMs: step.stepDelayMs ?? 10,
        });
        await new Promise(r => setTimeout(r, 60));
      } else if (step.action === 'swipe') {
        const dist = Number(step.distance ?? 160);
        const dir = step.direction ?? 'left';
        const vec = { left: [-dist, 0], right: [dist, 0], up: [0, -dist], down: [0, dist] }[dir];
        if (!vec) throw Object.assign(new Error(`不支持的滑动方向 "${dir}"`), { code: 'E_VERIFY_INPUT', stepIndex: i });
        await page.mouseDrag(widget.centerX, widget.centerY, widget.centerX + vec[0], widget.centerY + vec[1], {
          steps: step.steps ?? 6,
          stepDelayMs: 8,
        });
        await new Promise(r => setTimeout(r, 120));
      } else if (step.action === 'advanceTime' || (step.action === 'wait' && useVirtualClock && Number(step.ms ?? 0) >= 200)) {
        const advMs = Number(step.ms ?? 0);
        await page.evaluate(`(() => {
          const wins = [window];
          for (let k = 0; k < wins.length && k < 20; k++) {
            const w = wins[k];
            try { w.__zeeClock?.advance(${JSON.stringify(advMs)}); } catch {}
            try { for (let n = 0; n < w.frames.length; n++) wins.push(w.frames[n]); } catch {}
          }
          return true;
        })()`);
        await new Promise(r => setTimeout(r, 60));
      } else if (step.action === 'wait') {
        await new Promise(r => setTimeout(r, Number(step.ms ?? 250)));
        await new Promise(r => setTimeout(r, 40));
      } else if (step.action === 'navigate') {
        const pageEntry = map?.pages?.find(p => p.id === step.page || p.name === step.page);
        const targetPageName = pageEntry?.name ?? step.page;
        if (activeEngine === 'studio-html') {
          await page.evaluate(`window.__STUDIO_EXPORT_APP__.navigate(${JSON.stringify(step.page)})`);
        } else {
          await page.navigate(`${baseUrl}#p=${encodeURIComponent(targetPageName)}`, timeoutMs);
        }
        await waitForRuntime();
      } else if (step.action !== 'expect') {
        throw Object.assign(new Error(`未知验收步骤动作 "${step.action}"`), { code: 'E_VERIFY_INPUT', stepIndex: i });
      }

      const deadline = Date.now() + timeoutMs;
      let current = await settle();
      let failures = [];
      do {
        current = await observe();
        if (!current.ready || current.animating) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        checkInitialState(current);
        const match = step.target
          ? findWidgetMatch(current, symbol, step.target, { allowHidden, rowIndex: step.rowIndex ?? 0 })
          : { widget: null };
        failures = step.expect ? previewMismatch(step, current, match.widget, map, baselineWidget) : [];
        if (!failures.length) break;
        await new Promise(r => setTimeout(r, 80));
      } while (Date.now() < deadline);

      if (!current.ready || current.animating) {
        current = await observe();
      }
      checkInitialState(current);
      const finalMatch = step.target
        ? findWidgetMatch(current, symbol, step.target, { allowHidden, rowIndex: step.rowIndex ?? 0 })
        : { widget: null };
      if (step.expect && !failures.length) {
        failures = previewMismatch(step, current, finalMatch.widget, map, baselineWidget);
      }

      entry.variableChanges = Object.fromEntries(
        Object.entries(current.variables ?? {}).filter(([key, value]) => String(before.variables?.[key]) !== String(value))
      );
      if (finalMatch.widget) {
        entry.observedWidget = {
          name: finalMatch.widget.name,
          text: finalMatch.widget.text,
          visible: finalMatch.widget.visible,
          panelState: finalMatch.widget.panelState,
          x: finalMatch.widget.x,
          y: finalMatch.widget.y,
          width: finalMatch.widget.width,
          height: finalMatch.widget.height,
        };
      }
      entry.failures = failures;
      entry.status = failures.length ? 'failed' : 'passed';
      before = current;
      if (wantStoryboard && storyboardFrames.length < 12 && (failures.length || !['expect'].includes(step.action))) {
        const tag = step.target ? `${step.action} ${step.target}` : `${step.action} ${step.ms ?? step.page ?? ''}`.trim();
        storyboardFrames.push({
          label: `#${i + 1} ${tag} ${failures.length ? 'FAIL' : 'OK'}`,
          png: await captureFramedScreenshot(page, { frame: frameMode, activeEngine, canvasW: Number(map?.pages?.[0]?.canvas?.[0] ?? map?.pages?.[0]?.canvas?.w), canvasH: Number(map?.pages?.[0]?.canvas?.[1] ?? map?.pages?.[0]?.canvas?.h), vp }),
          failed: Boolean(failures.length),
        });
      }
      if (failures.length) {
        throw Object.assign(new Error(`步骤 #${i} (${step.action}) 与真实 Axure 预览断言不一致。`), {
          code: 'E_VERIFY_ASSERTION', stepIndex: i, actual: current, symbol,
        });
      }
      if ((current.errors?.length ?? 0) > 0 || (page?.scriptErrors?.length ?? 0) > 0) {
        throw Object.assign(new Error('Axure 官方 HTML 运行期间捕获到 JS 运行错误。'), {
          code: 'E_VERIFY_RUNTIME_ERROR', stepIndex: i, actual: current, symbol,
        });
      }
    }

    result.passed = history.filter(s => s.status === 'passed').length;
    result.final = { page: before.page, url: before.url, variables: before.variables, errors: before.errors ?? [] };
    result.errors = [...(before.errors ?? []), ...(page?.scriptErrors ?? []).map(e => ({ message: e.text }))];
    result.verification.behaviorVerified = steps.some(s => Object.keys(s.expect ?? {}).length > 0) || (steps.length > 0 && result.errors.length === 0);
  } catch (error) {
    result.status = 'failed';
    result.passed = history.filter(s => s.status === 'passed').length;
    const index = error.stepIndex ?? history.at(-1)?.index ?? null;
    const step = index !== null ? steps[index] : null;
    if (history.at(-1)?.status === 'running') history.at(-1).status = 'failed';
    const observed = error.actual;
    const errCanvas = map?.pages?.[0]?.canvas;
    const canvasW = Array.isArray(errCanvas) ? Number(errCanvas[0]) : errCanvas?.w;
    const canvasH = Array.isArray(errCanvas) ? Number(errCanvas[1]) : errCanvas?.h;
    const coordFail = (history.at(-1)?.failures ?? []).find(f => ['x', 'left', 'right'].includes(f.field));
    const centerShift = canvasW && vp.width > canvasW ? Math.round((vp.width - canvasW) / 2) : 0;
    const isCenterHint = Boolean(coordFail && centerShift && Math.abs((Number(coordFail.actual) - Number(coordFail.expected)) - centerShift) <= 3);
    result.diagnostics = [{
      code: error.code ?? 'E_VERIFY_BROWSER',
      message: error.message,
      stepIndex: index,
      target: step?.target ?? null,
      ...(error.symbol?.context?.line ? { sourceSpan: { line: error.symbol.context.line, column: error.symbol.context.column, snippet: error.symbol.context.snippet } } : {}),
      expected: step?.expect ?? null,
      failures: history.at(-1)?.failures ?? null,
      actual: observed ? {
        page: observed.page,
        variables: observed.variables,
        widgets: (observed.widgets ?? []).slice(0, 12).map(w => ({
          name: w.name, text: w.text, visible: w.visible, panelState: w.panelState, x: w.x, y: w.y,
        })),
        errors: observed.errors,
      } : null,
      nextAction: isCenterHint
        ? `检测到 Axure Web 页面在 ${vp.width}px 视口中居中产生了 +${centerShift}px 水平偏移；请传 viewport: { width: ${canvasW}, height: ${Math.max(320, Math.round(canvasH ?? 700))}, dpr: 1 } 以 1:1 对齐画布坐标。`
        : '对照 actual 中的真实面板状态、坐标与变量，调整 RP/1 交互或 bounds/expression 后重新生成并验证。',
    }];
  } finally {
    if (page && (screenshotPath || input.includeImage)) {
      try {
        const png = await captureFramedScreenshot(page, {
          frame: frameMode,
          activeEngine,
          canvasW: Number(map?.pages?.[0]?.canvas?.[0] ?? map?.pages?.[0]?.canvas?.w),
          canvasH: Number(map?.pages?.[0]?.canvas?.[1] ?? map?.pages?.[0]?.canvas?.h),
          vp,
        });
        if (screenshotPath) {
          mkdirSync(dirname(screenshotPath), { recursive: true });
          writeFileSync(screenshotPath, png, { flag: 'wx' });
          result.screenshot = screenshotPath;
        }
        if (input.includeImage) {
          result.previewImage = 'attached';
          result.mcpImages = [...(result.mcpImages ?? []), { mimeType: 'image/png', data: png.toString('base64') }];
        }
      } catch (err) {
        result.screenshotError = err.message;
      }
    }
    if (wantStoryboard && storyboardFrames.length > 0) {
      try {
        if (storyboardPath) mkdirSync(dirname(storyboardPath), { recursive: true });
        const sbPng = buildStoryboardPng(storyboardFrames, storyboardPath);
        if (storyboardPath && sbPng) result.storyboard = storyboardPath;
        if (input.includeStoryboard && sbPng) {
          result.storyboardImage = 'attached';
          result.mcpImages = [...(result.mcpImages ?? []), { mimeType: 'image/png', data: sbPng.toString('base64') }];
        }
      } catch (err) {
        result.storyboardError = err.message;
      }
    }
    try { await browser?.close(); } catch {}
    try { server.close(); server.closeAllConnections?.(); } catch {}
    if (tempStageDir) rmSync(tempStageDir, { recursive: true, force: true });
  }
  return result;
}

// Called by ego-browser nodejs in an existing, agent-owned TaskSpace. Browser
// ownership and user-control checks remain enforced by ego, with no takeover.
export async function runEgoPreview(input) {
  const task = await taskSpace(input.spaceId);
  const page = task.page(input.pageLabel ?? 'p1');
  const { map, steps } = input;
  const names = [...new Set(map.symbols.flatMap(s => [s.name, s.display]).filter(Boolean))];
  const variables = [...new Set([...map.variables, ...steps.flatMap(s => s.expect?.variable ? [s.expect.variable] : [])])];
  const observe = () => page.evaluate(observeAxure, { names, variables });
  const timeout = input.timeoutMs ?? 5000;
  const history = [];
  const result = { status: 'completed', evidence: 'axure-browser-runtime', semanticHash: map.semanticHash,
    verification: { nativePreviewObserved: false, businessAssertionsPassed: false, guiEdited: false, saveReopened: false },
    artifactAssociation: 'logical-labels-and-page-names', steps: history };
  try {
    if (input.url) await page.goto(input.url);
    const ready = new Function('args', `return (${observeAxure.toString()})(args).ready;`);
    await page.waitForFunction(ready, { names, variables }, { timeout });
    let before = await observe();
    if (!before.ready) throw Object.assign(new Error(before.reason), { code: 'E_PREVIEW_RUNTIME' });
    result.verification.nativePreviewObserved = true;
    result.initial = before;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], symbol = step.target ? resolvePreviewSymbol(map, step.target) : null;
      let current = await observe();
      let candidates = symbol ? current.widgets.filter(w => [symbol.name, symbol.display].includes(w.name) && w.visible) : [];
      if (symbol && step.expect?.visible === false) candidates = current.widgets.filter(w => [symbol.name, symbol.display].includes(w.name));
      let widget = candidates[step.rowIndex ?? 0];
      const entry = { index: i, action: step.action, target: symbol?.id ?? null, before: current, status: 'running' };
      history.push(entry);
      if (symbol && step.rowIndex === undefined && candidates.length > 1)
        throw Object.assign(new Error('真实预览中有多个实例，请指定 rowIndex。'), { code: 'E_PREVIEW_AMBIGUOUS', stepIndex: i });
      if (symbol && !widget && step.expect?.visible !== false)
        throw Object.assign(new Error('当前页未找到可见目标。'), { code: 'E_PREVIEW_NOT_VISIBLE', stepIndex: i });
      if (step.action !== 'expect') {
        if (!widget?.enabled) throw Object.assign(new Error('目标不可操作。'), { code: 'E_PREVIEW_DISABLED', stepIndex: i });
        // The ID was read from the current DOM immediately above.
        const id = step.action === 'fill' ? widget.inputId : widget.id;
        if (!id) throw Object.assign(new Error('目标不是输入框。'), { code: 'E_PREVIEW_INPUT', stepIndex: i });
        const selector = 'loc=css:#' + id.replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
        if (step.action === 'fill') { await page.focus(selector); await page.fill(selector, step.value); await page.press(selector, 'Tab'); }
        else {
          try { await page.click(selector, { label: '验证原型交互' }); entry.dispatch = 'ego-pointer'; }
          catch (error) {
            const checked = await observe();
            const same = checked.widgets?.find(w => w.id === id && w.visible && w.enabled);
            if (!/not visible in the viewport/.test(error.message) || !same || checked.url !== current.url) throw error;
            if (!await page.evaluate(clickObservedAxure, { url: checked.url, id })) throw error;
            entry.dispatch = 'dom-click-after-viewport-check';
            entry.browserWarning = error.message;
          }
        }
      }
      const deadline = Date.now() + timeout;
      let failures;
      do {
        current = await observe();
        candidates = symbol && current.ready ? current.widgets.filter(w => [symbol.name, symbol.display].includes(w.name) && (step.expect?.visible === false || w.visible)) : [];
        widget = candidates[step.rowIndex ?? 0];
        failures = current.ready ? previewMismatch(step, current, widget, map) : [{ field: 'runtime', expected: 'ready', actual: false }];
        if (!failures.length) break;
        await new Promise(r => setTimeout(r, 100));
      } while (Date.now() < deadline);
      entry.after = current;
      entry.variableChanges = Object.fromEntries(Object.entries(current.variables ?? {}).filter(([key, value]) => String(before.variables?.[key]) !== String(value)));
      entry.failures = failures;
      entry.status = failures.length ? 'failed' : 'passed';
      before = current;
      if (failures.length) throw Object.assign(new Error('真实预览与期望不一致。'), { code: 'E_PREVIEW_ASSERTION', stepIndex: i });
      if (current.errors?.length) throw Object.assign(new Error('原生预览捕获到运行错误。'), { code: 'E_PREVIEW_RUNTIME_ERROR', stepIndex: i });
    }
    result.verification.businessAssertionsPassed = steps.some(s => Object.keys(s.expect ?? {}).length > 0);
  } catch (error) {
    result.status = 'failed';
    const index = error.stepIndex ?? history.at(-1)?.index;
    const step = steps[index], symbol = step?.target ? map.symbols.find(s => s.id === step.target || s.id.endsWith('/' + step.target)) : null;
    if (history.at(-1)?.status === 'running') history.at(-1).status = 'failed';
    const observed = history.at(-1)?.after ?? history.at(-1)?.before;
    result.diagnostics = [{ code: error.code ?? 'E_PREVIEW_BROWSER', message: error.message, stepIndex: index ?? null,
      target: symbol?.id ?? step?.target ?? null, ...symbol?.context,
      actual: observed ? { page: observed.page, variables: observed.variables,
        widgets: observed.widgets?.filter(w => symbol && [symbol.name, symbol.display].includes(w.name)),
        events: observed.events?.slice(-5), errors: observed.errors } : null,
      expected: step?.expect ?? null,
      nextAction: '对照实际变量变化、可见状态和源码事件；未触发的绑定可用 explain_binding 查看编译刷新关系。' }];
  }
  try { result.screenshot = await page.screenshot({ path: input.screenshot }); }
  catch (error) { result.screenshotError = error.message; }
  writeFileSync(input.output, JSON.stringify(result, null, 2) + '\n');
  console.log('ZEE_RP_PREVIEW_RESULT ' + JSON.stringify(result));
}

export async function previewPrototype(input, runWorkflow) {
  const source = resolve(input.source);
  assertNotProtected(source);
  const output = resolve(input.output);
  assertWritable(output);
  if (extname(output) !== '.json' || existsSync(output) || existsSync(output + '.png'))
    throw new Error('output 需要新的 .json 文件名，报告和截图均不覆盖已有文件。');
  if (input.url) {
    const url = new URL(input.url);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('url 需要真实 Axure 预览或已发布 HTML 地址。');
  }
  const sourceHash = sha(readFileSync(source));
  const map = runWorkflow('preview-map', source);
  if (!map.ok) return { status: 'failed', ...map };
  for (const step of input.steps) {
    if (step.target) resolvePreviewSymbol(map, step.target);
    if (step.action !== 'expect' && !step.target) throw new Error('click/fill 需要 target 逻辑 ID。');
    if (step.action === 'fill' && typeof step.value !== 'string') throw new Error('fill 需要 value 文本。');
    if (step.action === 'expect' && !Object.keys(step.expect ?? {}).length) throw new Error('expect 至少需要一个期望字段。');
    if (step.expect?.variable && !Object.hasOwn(step.expect, 'equals')) throw new Error('变量断言需要 equals。');
    if (['text', 'visible', 'panelState', 'width', 'height'].some(k => Object.hasOwn(step.expect ?? {}, k)) && !step.target) throw new Error('元件断言需要 target。');
  }
  mkdirSync(dirname(output), { recursive: true });
  // Reserve the report so a concurrent caller cannot overwrite this run.
  writeFileSync(output, JSON.stringify({ status: 'running', source, sourceHash }) + '\n', { flag: 'wx' });
  const payload = { ...input, source, output, screenshot: output + '.png', map };
  const code = `const {runEgoPreview}=await import(${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}); await runEgoPreview(${JSON.stringify(payload)});`;
  const execution = await new Promise(resolveExecution => {
    const child = spawn('ego-browser', ['nodejs', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', e => resolveExecution({ code: 1, stdout, stderr: e.message }));
    child.once('close', code => resolveExecution({ code, stdout, stderr }));
  });
  let result;
  try { result = JSON.parse(readFileSync(output)); } catch {}
  if (!result || result.status === 'running') result = { status: 'failed', diagnostics: [{ code: 'E_PREVIEW_BROWSER',
    message: execution.stderr || execution.stdout || '浏览器未返回完整记录。', nextAction: '检查现有 ego 任务空间及控制权；不自动接管用户空间。' }] };
  result.source = source; result.sourceHash = sourceHash; result.report = output;
  result.sourceChangedDuringRun = sha(readFileSync(source)) !== sourceHash;
  if (result.sourceChangedDuringRun) { result.status = 'failed'; result.diagnostics = [...(result.diagnostics ?? []), { code: 'E_STALE_PREVIEW_SOURCE', message: '预览期间源码已变化，请使用一致版本重测。' }]; }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return { status: result.status, evidence: result.evidence, verification: result.verification,
    passed: result.steps?.filter(s => s.status === 'passed').length ?? 0, total: input.steps.length,
    report: output, screenshot: result.screenshot, diagnostics: result.diagnostics,
    final: (() => { const last = result.steps?.at(-1)?.after ?? result.initial; return last ? {
      page: last.page, url: last.url, variables: last.variables, errors: last.errors,
    } : undefined; })(),
    artifactAssociation: result.artifactAssociation, sourceChangedDuringRun: result.sourceChangedDuringRun };
}
