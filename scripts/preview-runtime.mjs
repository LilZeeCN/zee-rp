import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNotProtected, assertWritable, resolveWorkDir } from './engine.mjs';
import { tryDetectFileVersion } from './version.mjs';
import { writeProofReport } from './proof-report.mjs';
import { cacheDirectory, pruneBuildCache, touchCache } from './build-cache.mjs';
import { pythonInvocation } from './python.mjs';
import { findChromeExecutable, launchChrome } from '../studio/cdp.mjs';
import { decodePng, encodeRgbaPng } from '../studio/png-decode.mjs';
import { readComputedWidgetStyle } from '../studio/prototype-runtime.mjs';

import { bindNativeSymbols, officialIdOf, readNativeWidgetMap } from './native-widget-identity.mjs';
import { decodeAxureData, scanOfficialInteractions, officialWidgetMapFile } from './official-interactions.mjs';

const VIRTUAL_CLOCK_SHIM = `(() => {
  if (window.__zeeClockInstalled) return;
  window.__zeeClockInstalled = true;
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const epoch = Date.now();
  const pageTimes = new Map();
  let nextId = 100000;
  const queue = [];
  const ownerPage = () => {
    try {
      return window.__STUDIO_EXPORT_APP__?.getCurrentPage()?.name
        || window.$axure?.internal?.(api => api.pageData?.page?.name)
        || document.title
        || null;
    } catch { return document.title || null; }
  };
  const timeOf = owner => pageTimes.get(owner) ?? 0;
  const timer = (id, fn, delay, interval, args) => {
    const owner = ownerPage();
    const now = timeOf(owner);
    return { id, seq: seq++, fn, delay, at: now + delay, interval, args, ownerPage: owner, registeredAt: now };
  };
  const clock = window.__zeeClock = {
    get now() { return timeOf(ownerPage()); },
    get timestamp() { return epoch + timeOf(ownerPage()); },
    get pending() { return queue.length; },
    advance(ms, { activePage } = {}) {
      const delta = Math.max(0, Number(ms) || 0);
      const owners = activePage ? [activePage] : [...new Set([ownerPage(), ...pageTimes.keys(), ...queue.map(item => item.ownerPage)])];
      const start = new Map(owners.map(owner => [owner, timeOf(owner)]));
      const dueIn = item => item.at - start.get(item.ownerPage);
      const fired = new Map();
      while (true) {
        const next = queue.filter(item => start.has(item.ownerPage) && dueIn(item) <= delta)
          .sort((a, b) => dueIn(a) - dueIn(b) || a.seq - b.seq)[0];
        const index = next ? queue.indexOf(next) : -1;
        if (index === -1) break;
        const [item] = queue.splice(index, 1);
        pageTimes.set(item.ownerPage, Math.max(timeOf(item.ownerPage), item.at));
        const receipt = fired.get(item.id) || {
          id: item.id, ownerPage: item.ownerPage, registeredAt: item.registeredAt,
          delay: item.delay, interval: item.interval, fireCount: 0,
        };
        receipt.fireCount++;
        fired.set(item.id, receipt);
        if (item.interval) {
          queue.push({ ...item, at: item.at + item.delay });
        }
        try {
          if (typeof item.fn === 'function') item.fn.apply(null, item.args);
        } catch (err) {
          setTimeout(() => { throw err; }, 0);
        }
      }
      for (const [owner, now] of start) pageTimes.set(owner, now + delta);
      return [...fired.values()];
    },
  };
  let seq = 1;
  window.setTimeout = function(fn, delay = 0, ...args) {
    const d = Number(delay) || 0;
    if (d < 200) return origSetTimeout(fn, delay, ...args);
    const id = nextId++;
    queue.push(timer(id, fn, d, false, args));
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
    queue.push(timer(id, fn, d, true, args));
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
    const api = window.$axure?.internal?.(internal => internal);
    const provider = api?.globalVariableProvider;
    const getVariable = provider?.getVariableValue;
    if (window.__zeeClock && typeof getVariable === 'function' && !startup.virtualNow) {
      startup.virtualNow = true;
      provider.getVariableValue = function(name, eventInfo, ...rest) {
        // Keep the browser's real clock for painting/animation. Only Axure's
        // event-local Now advances with the CDP scenario clock.
        if (typeof name === 'string' && name.toLowerCase() === 'now' && eventInfo) {
          eventInfo = { ...eventInfo, now: new Date(window.__zeeClock.timestamp) };
        }
        return Reflect.apply(getVariable, this, [name, eventInfo, ...rest]);
      };
    }
    const adaptive = api?.adaptive;
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
export function observeAxure({ names = [], officialIds = [], variables = [], waitForInitialization = false } = {}, readStyle = null) {
  const windows = [window];
  let lastFrameError;
  const wantFilter = names.length > 0 || officialIds.length > 0;
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
          const labelElements = [...d.querySelectorAll('[data-label]')];
          const nativeElements = (ax.getAllElementIds?.() ?? []).map(id => d.getElementById(id)).filter(Boolean);
          const identities = new Set(officialIds);
          const labels = new Set(names);
          const baseRect = d.getElementById('base')?.getBoundingClientRect();
          const probe = w.__zeeRpPreviewProbe;
          const widgets = [...new Set([...labelElements, ...nativeElements])]
            .filter(el => el.tagName !== 'SCRIPT' && !el.classList.contains('panel_state'))
            .flatMap(el => {
              try {
                // Axure's static object table contains the template ID only.
                const clone = el.id.match(/^(u\d+)-(\d+)$/);
                const baseId = clone?.[1] ?? el.id;
                let rowBox = null;
                if (clone) {
                  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
                    const repeater = parent.parentElement;
                    if (repeater?.id && parent.id === repeater.id + '-' + clone[2] &&
                        repeater.querySelector(':scope > script[type="axure-repeater-template"]')) {
                      rowBox = parent.getBoundingClientRect();
                      break;
                    }
                  }
                }
                let officialId = baseId || null;
                if (baseId) {
                  try { officialId = ax.getObjectFromElementId?.(baseId)?.id ?? baseId; } catch { /* Keep the DOM ID. */ }
                }
                if (wantFilter && !labels.has(el.getAttribute('data-label')) && !identities.has(officialId)) return [];
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
                let info = null;
                if (!clone && el.id) {
                  try { info = ax.getWidgetInfo?.(el.id); } catch { /* Use DOM geometry if the assembly lacks widget metadata. */ }
                }
                const x = typeof info?.x === 'number' ? info.x : r.left - (baseRect?.left ?? 0);
                const y = typeof info?.y === 'number' ? info.y : r.top - (baseRect?.top ?? 0);
                const width = typeof info?.width === 'number' && info.width > 0 ? info.width : r.width;
                const height = typeof info?.height === 'number' && info.height > 0 ? info.height : r.height;
                const textVal = input ? input.value : (el.innerText?.trim() ?? '');
                return [{
                  id: el.id, officialId: officialId ?? null,
                  ...(clone ? { domRowSuffix: Number(clone[2]), rowKey: clone[2],
                    ...(rowBox ? { rowX: rowBox.left, rowY: rowBox.top, rowVisible: rowBox.width > 0 && rowBox.height > 0 } : {}),
                  } : {}),
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
                  ...(readStyle ? readStyle(el, {
                    shape: d.getElementById(el.id + '_div') || el,
                    textNode: el.querySelector('.text span, input, textarea, select') || el,
                    svg: el.querySelector('svg path, svg rect'),
                  }) : {}),
                }];
              } catch (error) {
                probe.errors.push({ message: String(error?.message ?? error), element: el.id });
                if (probe.errors.length > 50) probe.errors.shift();
                return [];
              }
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
    } catch (error) {
      lastFrameError = String(error?.stack ?? error);
    }
  }
  return {
    ready: false, reason: '当前页面尚未加载可读取的 Axure 原生运行时。',
    ...(lastFrameError ? { internalError: lastFrameError } : {}),
  };
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

export function resolvePreviewSymbol(map, target, { activePageName, activePageId } = {}) {
  let found = (map.symbols ?? []).filter(s =>
    [s.id, s.logicalId, s.name, s.display, s.label, s.pointer, ...(Array.isArray(s.aliases) ? s.aliases : [])]
      .filter(Boolean)
      .includes(target)
    || (typeof s.id === 'string' && s.id.endsWith('/' + target))
  );
  if (found.length > 1 && !target.includes('/') && (activePageId || activePageName)) {
    const local = found.filter(symbol => {
      const pageId = symbol.pageId ?? symbol.id?.split('/')[0];
      const pageName = symbol.pageName ?? symbol.page;
      return activePageId ? pageId === activePageId : pageName === activePageName || (map.pages || []).some(p => p.id === pageId && p.name === activePageName);
    });
    if (local.length) found = local;
  }
  if (found.length !== 1) throw Object.assign(new Error(`当前页未找到唯一目标「${target}」。请用页面ID/元件ID（如 home/save_btn）或候选项定位。外部 HTML 可使用 Axure 元件名（DOM 中的 data-label）。`),
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

// CDP coordinates are viewport-relative. Scroll the real Axure content frame
// when a widget is drawn below the player's visible area.
async function revealPreviewTarget(page, widget) {
  await page.evaluate(`(() => {
    const windows = [window];
    for (let i = 0; i < windows.length && i < 20; i++) {
      try {
        const w = windows[i];
        const widgetId = ${JSON.stringify(widget.id)};
        const el = w.document.getElementById(widgetId)
          || [...w.document.querySelectorAll('[data-node-id]')].find(node => node.dataset.nodeId === widgetId);
        if (el) { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); return; }
        windows.push(...w.frames);
      } catch { /* Cross-origin frame. */ }
    }
  })()`);
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

const STYLE_EXPECT_FIELDS = ['fill', 'color', 'opacity', 'fontFamily', 'fontSize', 'fontWeight', 'radius'];

function verifyColor(value) {
  const color = String(value ?? '').trim().toLowerCase();
  if (color === 'none' || color === 'transparent') return 'transparent';
  if (/^#[0-9a-f]{3}$/.test(color)) return '#' + [...color.slice(1)].map(ch => ch + ch).join('');
  const rgb = color.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)$/);
  if (!rgb) return color;
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return 'transparent';
  const hex = rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, '0')).join('');
  return rgb[4] === undefined || Number(rgb[4]) === 1 ? '#' + hex : color;
}

async function compareVisualBaseline(expect, { capture, workDir, diffDir, index }) {
  const path = resolve(workDir, expect.visualBaseline);
  assertNotProtected(path);
  const png = await capture();
  if (!existsSync(path)) {
    if (expect.saveBaselineIfMissing === true) {
      assertWritable(path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, png, { flag: 'wx' });
      return { evidence: { baseline: path, created: true } };
    }
    return { failure: { field: 'visualBaseline', expected: path, actual: 'missing' } };
  }
  const actual = decodePng(png);
  const expected = decodePng(readFileSync(path));
  if (actual.width !== expected.width || actual.height !== expected.height) return {
    failure: { field: 'visualBaseline', expected: [expected.width, expected.height], actual: [actual.width, actual.height] },
  };
  let differenceCount = 0;
  let absoluteError = 0;
  for (let offset = 0; offset < actual.pixels.length; offset += 4) {
    let largest = 0;
    for (let channel = 0; channel < 4; channel++) {
      const diff = Math.abs(actual.pixels[offset + channel] - expected.pixels[offset + channel]);
      absoluteError += diff;
      largest = Math.max(largest, diff);
    }
    if (largest > 16) {
      differenceCount++;
      actual.pixels.set([255, 36, 73, 255], offset);
    }
  }
  const diffPct = differenceCount * 100 / (actual.width * actual.height);
  const mae = absoluteError / actual.pixels.length;
  const maxDiffPct = expect.maxDiffPct ?? 0.5;
  const evidence = { baseline: path, diffPct, mae, maxDiffPct };
  if (diffPct <= maxDiffPct) return { evidence };
  const diffImage = join(diffDir, `visual-diff-step-${index}.png`);
  assertNotProtected(diffImage);
  assertWritable(diffImage);
  mkdirSync(diffDir, { recursive: true });
  writeFileSync(diffImage, encodeRgbaPng(actual));
  return { evidence, failure: { field: 'visualBaseline', expected: maxDiffPct, actual: diffPct, diffImage } };
}

export function previewMismatch(step, observation, widget, map, baselineWidget = null, knownTarget = false) {
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
    const value = field === 'visible' && (widget || knownTarget) ? Boolean(widget?.visible) : widget?.[field];
    if (field in expected && value !== expected[field]) {
      failures.push({ field, expected: expected[field], actual: value ?? null });
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
  for (const field of STYLE_EXPECT_FIELDS) {
    if (!(field in expected)) continue;
    const actual = widget?.[field];
    const wanted = expected[field];
    let matches = false;
    if (field === 'fill' || field === 'color') matches = verifyColor(actual) === verifyColor(wanted);
    else if (field === 'fontFamily') {
      matches = String(actual ?? '').split(',')[0].replace(/["']/g, '').trim().toLowerCase() === String(wanted).toLowerCase();
    } else if (Number.isFinite(actual) && Number.isFinite(Number(wanted))) {
      matches = Math.abs(actual - Number(wanted)) <= (field === 'opacity' ? 0.02 : field === 'fontWeight' ? 0 : 0.5);
    }
    if (!matches) failures.push({ field, expected: wanted, actual: actual ?? null });
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

function buildVerificationMap({ source, rp, baseline, html, runWorkflow }) {
  let compiled;
  if (source) {
    const absSrc = resolve(source);
    assertNotProtected(absSrc);
    compiled = runWorkflow('preview-map', absSrc);
    if (!compiled.ok) throw Object.assign(new Error(compiled.diagnostics?.[0]?.message || 'Unable to read RP/1 preview map'), { code: 'E_VERIFY_SOURCE' });
  }
  let native, exported;
  if (rp) {
    try { native = readNativeWidgetMap(rp, baseline); }
    catch (error) { if (baseline) throw error; }
  }
  if (html) {
    const path = join(html, officialWidgetMapFile);
    assertNotProtected(path);
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.version === 1 && Array.isArray(data.symbols)) exported = data.symbols;
    }
  }
  const base = native?.baseline;
  if (!compiled && !native && !exported) return null;
  const nativeSymbols = new Map([...(native?.symbols ?? []), ...(exported ?? [])].map(s => [s.logicalId ?? s.id, s]));
  let studioNames;
  if (base?.studioOrigin?.sourceFile) {
    const studioDocPath = resolve(dirname(rp), base.studioOrigin.sourceFile);
    assertNotProtected(studioDocPath);
    try { studioNames = collectStudioNodeNames(JSON.parse(readFileSync(studioDocPath, 'utf8'))); } catch {}
  }
  if (compiled) {
    const symbols = native?.widgets && !nativeSymbols.size ? bindNativeSymbols(compiled.symbols, native.widgets) : compiled.symbols;
    for (const s of symbols) {
      const bound = nativeSymbols.get(s.logicalId ?? s.id);
      nativeSymbols.set(s.logicalId ?? s.id, { ...s, ...(bound?.officialId ? { officialId: bound.officialId } : {}) });
    }
  }
  const pages = new Map((compiled?.pages ?? []).map(p => [p.id, p]));
  const symbols = [...nativeSymbols.values()].map(s => {
    if (s.pageId && !pages.has(s.pageId)) pages.set(s.pageId, { id: s.pageId, name: s.pageName ?? s.pageId });
    const name = studioNames?.get(s.id);
    return name ? { ...s, aliases: [name, `${s.pageId}/${name}`] } : s;
  });
  return {
    ...compiled, ok: true, symbols, pages: [...pages.values()], widgets: native?.widgets ?? [],
    ...(base?.staticPageKeys ? { staticPageKeys: base.staticPageKeys, baselineRpHash: base.rpSha256,
      baselineSourceHash: base.sourceSha256, semanticBehaviorKey: base.semanticBehaviorKey } : {}),
    semanticHash: compiled?.semanticHash ?? base?.semanticHash ?? null,
    variables: compiled?.variables ?? Object.keys(base?.sourceSpec?.variables ?? {}),
    verifySteps: compiled?.verifySteps?.length ? compiled.verifySteps : base?.nativeVerifySteps ?? [],
  };
}

function explicitPreviewTarget(map, target) {
  if (typeof target === 'object') {
    if (target.guid) return { id: `guid:${target.guid}`, officialId: officialIdOf(target.guid) };
    if (target.logicalId) return resolvePreviewSymbol(map ?? {}, target.logicalId);
    const widget = map?.widgets?.find(w => w.record === target.record && w.id === target.id);
    if (widget) return { id: `${target.record}:${target.id}`, officialId: widget.officialId };
    throw Object.assign(new Error('record/id 需要一份与 HTML 对应的 .rp 文件。'), { code: 'E_PREVIEW_TARGET' });
  }
  if (/^guid:[0-9a-f]{32}$/i.test(target)) return { id: target, officialId: officialIdOf(target.slice(5)) };
  return null;
}

function findWidgetMatch(observation, symbol, target, { allowHidden = false, rowIndex } = {}) {
  const pool = observation.widgets ?? [];
  const candidates = symbol?.officialId && observation.engine !== 'studio-html'
    ? pool.filter(w => w.officialId === symbol.officialId)
    : symbol
    ? pool.filter(w => {
      const targetKeys = new Set([symbol.name, symbol.display, symbol.label, symbol.id, symbol.logicalId, ...(Array.isArray(symbol.aliases) ? symbol.aliases : [])].filter(Boolean));
      const widgetKeys = [w.name, w.id, w.scopedId, w.label, w.logicalAlias].filter(Boolean);
      return widgetKeys.some(k => targetKeys.has(k));
    })
    : pool.filter(w => [w.name, w.id, w.scopedId, w.label, w.logicalAlias].includes(target));
  if (candidates.some(w => w.rowKey !== undefined)) {
    const rows = candidates.filter(w => w.rowVisible !== false);
    rows.sort((a, b) => observation.engine === 'studio-html'
      ? a.domRowSuffix - b.domRowSuffix
      : ((a.rowY ?? a.y) - (b.rowY ?? b.y)) || ((a.rowX ?? a.x) - (b.rowX ?? b.x)) || (a.domRowSuffix - b.domRowSuffix));
    const eligible = allowHidden ? rows : rows.filter(item => item.visible);
    const widget = rowIndex === undefined ? eligible[0] : rows[rowIndex];
    return { candidates: eligible,
      widget: allowHidden || widget?.visible ? widget : undefined };
  }
  const eligible = allowHidden ? candidates : candidates.filter(item => item.visible);
  return { candidates: eligible, widget: eligible[rowIndex ?? 0] };
}

function officialPageTarget(htmlDir, name) {
  const fallback = { fragment: `p=${encodeURIComponent(name)}` };
  let rootNodes;
  try {
    rootNodes = decodeAxureData(readFileSync(join(htmlDir, 'data', 'document.js'), 'utf8')).sitemap?.rootNodes;
  } catch {
    // Older/custom HTML exports may use a different document-data grammar.
    return fallback;
  }
  const stack = Array.isArray(rootNodes) ? [...rootNodes] : [];
  const pages = new Map();
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node?.children)) stack.push(...node.children);
    if ((node?.pageName === name || node?.id === name) && /^[^/\\?#]+\.html$/i.test(node?.url ?? '')) {
      pages.set(node.url, node);
    }
  }
  if (pages.size !== 1) return fallback;
  const page = pages.values().next().value;
  // Both players resolve sitemap IDs. RP11 migrates hashes to query strings
  // and re-encodes percent escapes in a Unicode filename supplied as p=.
  const fragment = typeof page.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(page.id)
    ? `id=${page.id}` : `p=${encodeURIComponent(page.url.slice(0, -5))}`;
  return { fragment, name: page.pageName, file: page.url };
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
  pageName,
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
    const entry = pageName ? officialPageTarget(htmlDir, pageName).file : null;
    const file = entry && !entry.includes('%') ? encodeURIComponent(entry) : entry;
    const url = `http://127.0.0.1:${port}/${file || 'start.html'}`;
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
    try { server.close(); server.closeAllConnections?.(); server.unref?.(); } catch {}
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

async function officialHtmlCachePath(workDir, rp, rpHash, baseline) {
  try {
    const { locateInstallation } = await import('../tools/native-assembly/bridge.mjs');
    const version = Number(tryDetectFileVersion(readFileSync(rp).subarray(0, 8)));
    if (version !== 9 && version !== 11) return null;
    const installed = locateInstallation(version);
    const host = statSync(installed.entry);
    const baselineHash = baseline ? createHash('sha256').update(readFileSync(baseline)).digest('hex') : null;
    const key = createHash('sha256').update(JSON.stringify([rpHash, installed.entry, host.size, host.mtimeMs, baselineHash])).digest('hex');
    const directory = cacheDirectory(join(workDir, '.zee-cache'), 'html');
    const target = directory && join(directory, key);
    return target && !lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() ? target : null;
  } catch { return null; }
}

async function behaviorCachePath(workDir, input, engine, map, rp, rpHash, source, steps, viewport) {
  if (input.noCache || engine === 'studio-html' || !rp || !source || !map?.semanticBehaviorKey ||
      map.baselineRpHash !== rpHash || input.includeStoryboard || input.storyboard || input.screenshot || input.includeImage ||
      !steps.length || steps.some(step => step.expect?.visualBaseline ||
        STYLE_EXPECT_FIELDS.some(field => Object.hasOwn(step.expect ?? {}, field)))) return null;
  try {
    if (createHash('sha256').update(readFileSync(source)).digest('hex') !== map.baselineSourceHash) return null;
    const { locateInstallation } = await import('../tools/native-assembly/bridge.mjs');
    const version = Number(tryDetectFileVersion(readFileSync(rp).subarray(0, 8)));
    const host = locateInstallation(version);
    const stamps = [host.entry, findChromeExecutable()].map(path => {
      const value = statSync(path);
      return [path, value.size, value.mtimeMs];
    });
    const key = createHash('sha256').update(JSON.stringify(['behavior', map.semanticBehaviorKey, steps, viewport,
      input.page ?? null, input.virtualClock ?? false, input.clockScope ?? null, stamps]));
    for (const name of ['preview-runtime.mjs', 'proto.mjs', 'ix-actions.mjs', 'official-interactions.mjs']) {
      key.update(readFileSync(new URL(name, import.meta.url)));
    }
    const directory = cacheDirectory(join(workDir, '.zee-cache'), 'verify');
    return directory && join(directory, key.digest('hex'));
  } catch { return null; }
}

function storeOfficialHtmlCache(exported, target) {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.stage-'));
  try {
    const staged = join(staging, 'html');
    cpSync(exported, staged, { recursive: true });
    if (!existsSync(target)) {
      try { renameSync(staged, target); }
      catch (error) { if (!existsSync(target)) throw error; }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  pruneBuildCache(dirname(parent));
}

function defaultProofDirectory(owner, workDir) {
  if (!owner) return null;
  const folder = basename(owner, extname(owner)) + '.assets';
  const beside = join(dirname(owner), folder);
  try {
    assertNotProtected(beside);
    assertWritable(beside);
    return beside;
  } catch {
    return join(workDir, folder);
  }
}

export async function verifyOfficialPreview(input, { runWorkflow, exportHtml }) {
  const engine = input.fast ? 'studio-html' : input.engine ?? 'auto';
  if (!['auto', 'official', 'studio-html'].includes(engine)) {
    throw Object.assign(new Error(`未知 verify 引擎 "${engine}"，可选 auto / official / studio-html`), { code: 'E_VERIFY_INPUT' });
  }
  const workDir = resolveWorkDir(input.cwd ?? input.projectDir);
  const rpPath = input.rp ? resolve(workDir, input.rp) : null;
  const htmlInputDir = input.html ? resolve(workDir, input.html) : null;
  const sourcePath = input.source ? resolve(workDir, input.source) : null;
  const baselinePath = input.baseline ? resolve(workDir, input.baseline) : null;
  const screenshotPath = input.screenshot ? resolve(workDir, input.screenshot) : null;
  const owner = rpPath || sourcePath;
  const proofDirectory = input.proofDirectory ?? defaultProofDirectory(owner, workDir);
  const autoStoryboard = Boolean(proofDirectory && !input.fast && (input.includeStoryboard || input.proofStoryboard));
  const storyboardPath = input.storyboard ? resolve(workDir, input.storyboard) : autoStoryboard ? join(proofDirectory, 'storyboard.png') : null;
  if (!rpPath && !htmlInputDir && !(engine === 'studio-html' && sourcePath)) {
    throw Object.assign(new Error('verify_prototype 需要至少提供 rp（已生成 .rp）或 html（HTML 目录）之一（或传 engine:"studio-html" + source）。'), { code: 'E_VERIFY_INPUT' });
  }
  if (rpPath) assertNotProtected(rpPath);
  if (baselinePath) assertNotProtected(baselinePath);
  const rpHash = rpPath ? createHash('sha256').update(readFileSync(rpPath)).digest('hex') : null;
  if (sourcePath) assertNotProtected(sourcePath);
  if (htmlInputDir) assertNotProtected(htmlInputDir);
  for (const [kind, p] of [['screenshot', screenshotPath], ['storyboard', storyboardPath]]) {
    if (!p) continue;
    assertNotProtected(p);
    assertWritable(p);
    if (extname(p).toLowerCase() !== '.png') {
      throw Object.assign(new Error(`${kind} 必须是以 .png 结尾的新文件路径。`), { code: 'E_VERIFY_SCREENSHOT' });
    }
    if (!(kind === 'storyboard' && autoStoryboard && !input.storyboard) && lstatSync(p, { throwIfNoEntry: false })) {
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
  let interactionCompilation;
  let studioHtmlExported = false;
  let engineFallbackReason = null;
  const cacheStats = { officialHtmlHit: false, cachedStepCount: 0, reexecutedStepCount: 0 };
  const verifyStarted = performance.now();
  const timings = {};

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
  const map = buildVerificationMap({ source: sourcePath, rp: rpPath, baseline: input.baseline ? resolve(workDir, input.baseline) : undefined,
    html: htmlInputDir, runWorkflow });
  timings.sourceMapMs = Math.round(performance.now() - verifyStarted);
  const htmlStarted = performance.now();
  const frameMode = input.frame === 'artboard' ? 'artboard' : 'viewport';
  const rawSteps = (Array.isArray(input.steps) && input.steps.length > 0) ? input.steps : (map?.verifySteps ?? []);
  const steps = normalizeVerifySteps(rawSteps);
  const useVirtualClock = Boolean(input.virtualClock || steps.some(s => s.action === 'advanceTime'));
  const wantStoryboard = Boolean(storyboardPath || input.includeStoryboard);
  const storyboardFrames = [];
  const behaviorCache = htmlInputDir ? null : await behaviorCachePath(workDir, input, engine, map, rpPath, rpHash, sourcePath, steps, vp);
  if (behaviorCache) {
    try {
      const cached = JSON.parse(readFileSync(behaviorCache, 'utf8'));
      if (cached.rpSha256 !== rpHash && cached.sourceSha256 !== map.baselineSourceHash &&
          cached.result?.verification?.behaviorVerified &&
          cached.result.steps.length === steps.length) {
        touchCache(behaviorCache);
        const reused = {
          ...cached.result,
          rp: rpPath, officialHtmlSource: 'prior-evidence', officialHtmlReady: false,
          evidence: 'axure-official-html-cdp-reused',
          verification: { ...cached.result.verification, officialHtmlExported: false, browserLoaded: false },
          cacheStats: { officialHtmlHit: false, cacheHit: true, cachedStepCount: steps.length, reexecutedStepCount: 0 },
          priorBrowserEvidence: { rpSha256: cached.rpSha256, verifiedAt: cached.at, scope: 'non-geometric-foreground-color' },
          elapsedMs: Math.round(performance.now() - verifyStarted), timings,
          steps: cached.result.steps.map(step => ({ ...step, cacheHit: true, elapsedMs: 0 })),
        };
        return finishVerification(reused, { proofDirectory, rpPath, rpHash, sourcePath, map, steps,
          stepDetail: input.stepDetail ?? (input.compact ? 'failures-only' : 'full') });
      }
    } catch { /* Recheck in Chrome if prior evidence cannot be used. */ }
  }
  if (!activeHtmlDir) {
    tempStageDir = mkdtempSync(join(tmpdir(), 'zee-verify-'));
    if (engine === 'studio-html') {
      const studioExp = await exportStudioHtmlForVerify({ rpPath, sourcePath, tempStageDir });
      activeHtmlDir = studioExp.htmlDir;
      studioHtmlExported = true;
      activeEngine = 'studio-html';
    } else {
      const exportedHtml = join(tempStageDir, 'html');
      const cachePath = !input.noCache && rpPath ? await officialHtmlCachePath(workDir, rpPath, rpHash, baselinePath) : null;
      let exp;
      if (cachePath && existsSync(join(cachePath, 'start.html'))) {
        // Replay from a private copy so another run can evict cache entries safely.
        try {
          cpSync(cachePath, exportedHtml, { recursive: true });
          touchCache(cachePath);
          exp = { status: 'completed', output: exportedHtml };
          cacheStats.officialHtmlHit = true;
        } catch {
          rmSync(exportedHtml, { recursive: true, force: true });
        }
      }
      if (!exp) {
        const exportStart = performance.now();
        exp = await exportHtml({ rp: rpPath, output: exportedHtml, cwd: workDir, baseline: input.baseline });
        cacheStats.officialExportMs = Math.round(performance.now() - exportStart);
        if (exp.status === 'completed' && cachePath && createHash('sha256').update(readFileSync(rpPath)).digest('hex') === rpHash) {
          try { storeOfficialHtmlCache(exp.output, cachePath); } catch { /* Cache is optional evidence reuse. */ }
        }
      }
      if (exp.status === 'completed') {
        activeHtmlDir = exp.output;
        officialHtmlExported = !cacheStats.officialHtmlHit;
        interactionCompilation = exp.interactionCompilation;
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

  if (activeEngine === 'official') {
    interactionCompilation ??= scanOfficialInteractions(activeHtmlDir, { symbols: map?.symbols });
    if (interactionCompilation.errorCount) {
      if (tempStageDir) rmSync(tempStageDir, { recursive: true, force: true });
      return { status: 'failed', engine: 'official', evidence: 'axure-official-html-cdp', stage: 'interaction-compilation',
        officialHtmlSource: cacheStats.officialHtmlHit ? 'cache' : officialHtmlExported ? 'exported' : 'provided', officialHtmlReady: true,
        verification: { officialHtmlExported, browserLoaded: false, behaviorVerified: false },
        passed: 0, total: steps.length, steps: [], interactionCompilation, diagnostics: interactionCompilation.diagnostics };
    }
  }
  timings.prepareHtmlMs = Math.round(performance.now() - htmlStarted);
  const extraNames = steps.flatMap(s => typeof s.target === 'string' ? [s.target] : []);
  const mapNames = map ? map.symbols.flatMap(s => [s.name, s.display, s.label]).filter(Boolean) : [];
  const officialIds = (map?.symbols ?? []).map(s => s.officialId).filter(Boolean);
  for (const step of steps) {
    if (!step.target) continue;
    try {
      const id = explicitPreviewTarget(map, step.target)?.officialId;
      if (id) officialIds.push(id);
    } catch { /* Report an invalid target on its original step. */ }
  }
  const names = map || officialIds.length ? [...new Set([...mapNames, ...extraNames])] : [];
  const variables = [...new Set([...(map?.variables ?? []), ...steps.flatMap(s => s.expect?.variable ? [s.expect.variable] : [])])];

  const observeStyles = steps.some(step => STYLE_EXPECT_FIELDS.some(key => Object.hasOwn(step.expect ?? {}, key)));
  const observeExpr = activeEngine === 'official'
    ? `(${observeAxure.toString()})(${JSON.stringify({ names, officialIds, variables, waitForInitialization: true })}, ${observeStyles ? readComputedWidgetStyle.toString() : 'null'})`
    : `(() => window.__STUDIO_EXPORT_APP__ ? ({ ...window.__STUDIO_EXPORT_APP__.observeForVerify({ styles: ${observeStyles} }), engine: 'studio-html' }) : { ready: false })()`;
  const entryHtmlFile = activeEngine === 'official' ? 'start.html' : 'index.html';
  const server = startStaticServer(activeHtmlDir, entryHtmlFile);
  let browser = null;
  let page = null;
  let before = null;
  const history = steps.map((step, index) => ({ index, action: step.action,
    ...(step.target !== undefined ? { target: step.target } : {}), status: 'not_run' }));
  const failureSummaries = [];
  const reachedByInteraction = new Map();
  const bypass = new Set();
  const stepDetail = input.stepDetail ?? (input.compact ? 'failures-only' : 'full');
  const result = {
    status: 'completed',
    ...(input.fast ? { mode: 'fast' } : {}),
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
    ...(interactionCompilation ? { interactionCompilation } : {}),
    ...(useVirtualClock ? { virtualClock: true } : {}),
    passed: 0,
    total: steps.length,
    ...(rpPath ? { rp: rpPath } : {}),
    html: htmlInputDir ?? '(temporary)',
    steps: history,
  };

  const verifyCacheRoot = join(workDir, '.zee-cache');
  let verifyCache, verifyFingerprint;
  if (!input.noCache && !useVirtualClock && !htmlInputDir && map?.staticPageKeys && map.baselineRpHash === rpHash &&
      sourcePath && createHash('sha256').update(readFileSync(sourcePath)).digest('hex') === map.baselineSourceHash) {
    try {
      verifyCache = cacheDirectory(verifyCacheRoot, 'verify');
      const chrome = statSync(findChromeExecutable());
      verifyFingerprint = createHash('sha256').update(JSON.stringify([activeEngine, chrome.size, chrome.mtimeMs]))
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .update(activeEngine === 'official'
          ? readFileSync(join(activeHtmlDir, 'resources', 'scripts', 'axure', 'axQuery.js'))
          : readFileSync(fileURLToPath(new URL('../studio/export-code.mjs', import.meta.url)))).digest('hex');
    } catch { verifyCache = null; }
  }

  const recordFailure = (error, index = null) => {
    result.status = 'failed';
    const step = index !== null ? steps[index] : null;
    const failedEntry = index !== null ? history[index] : null;
    const code = error.code ?? 'E_VERIFY_BROWSER';
    if (failedEntry) Object.assign(failedEntry, {
      status: 'failed', code, error: error.message, ...(step.expect ? { expected: step.expect } : {}),
    });
    const summary = {
      index, action: step?.action ?? null, target: failedEntry?.target ?? step?.target ?? null, code,
      message: error.message, ...(failedEntry?.failures?.length ? { failures: failedEntry.failures } : {}),
    };
    if (failedEntry) failureSummaries.push(summary);
    if (result.failedStep) return;
    result.failedStep = summary;
    const observed = error.actual ?? (before?.widgets ? before : null);
    const errCanvas = map?.pages?.[0]?.canvas;
    const canvasW = Array.isArray(errCanvas) ? Number(errCanvas[0]) : errCanvas?.w;
    const canvasH = Array.isArray(errCanvas) ? Number(errCanvas[1]) : errCanvas?.h;
    const coordFail = (failedEntry?.failures ?? []).find(f => ['x', 'left', 'right'].includes(f.field));
    const centerShift = canvasW && vp.width > canvasW ? Math.round((vp.width - canvasW) / 2) : 0;
    const isCenterHint = Boolean(coordFail && centerShift && Math.abs((Number(coordFail.actual) - Number(coordFail.expected)) - centerShift) <= 3);
    const targetNameList = observed?.widgets?.filter(w => w.visible && w.name).map(w => w.name) ?? [];
    const symbolIdList = (map?.symbols ?? [])
      .filter(s => !observed?.page || !s.page || s.page === observed.page)
      .map(s => s.id)
      .filter(Boolean);
    const availableTargets = [...new Set([...symbolIdList, ...targetNameList])].slice(0, 15);
    result.diagnostics = [{
      code: error.code ?? 'E_VERIFY_BROWSER',
      message: error.message,
      stepIndex: index,
      target: step?.target ?? null,
      ...(error.candidates?.length ? { candidates: error.candidates } : {}),
      ...(error.symbol?.context?.line ? { sourceSpan: { line: error.symbol.context.line, column: error.symbol.context.column, snippet: error.symbol.context.snippet } } : {}),
      expected: step?.expect ?? null,
      failures: failedEntry?.failures ?? null,
      ...(availableTargets.length ? { availableTargets } : {}),
      actual: observed?.ready === false ? {
        ready: false, reason: observed.reason, internalError: observed.internalError,
      } : observed ? {
        page: observed.page,
        variables: observed.variables,
        widgets: (observed.widgets ?? []).slice(0, 12).map(w => ({
          name: w.name, text: w.text, visible: w.visible, panelState: w.panelState, x: w.x, y: w.y,
        })),
        errors: observed.errors,
      } : null,
      nextAction: error.code === 'E_PREVIEW_OUTSIDE_VIEWPORT' ? '增大 viewport，让目标中心进入浏览器可见范围。' : isCenterHint
        ? `检测到 Axure Web 页面在 ${vp.width}px 视口中居中产生了 +${centerShift}px 水平偏移；请传 viewport: { width: ${canvasW}, height: ${Math.max(320, Math.round(canvasH ?? 700))}, dpr: 1 } 以 1:1 对齐画布坐标。`
        : '对照 actual 与 availableTargets 中的真实目标、面板状态、坐标与变量，调整 RP/1 交互或步骤目标后重新验证。',
    }];
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
      const pageName = targetPageEntry?.name ?? input.page;
      const fragment = activeEngine === 'official' ? officialPageTarget(activeHtmlDir, pageName).fragment
        : `p=${encodeURIComponent(pageName)}`;
      startUrl += `#${fragment}`;
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

    const browserStarted = performance.now();
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
    timings.browserStartupMs = Math.round(performance.now() - browserStarted);

    const compact = Boolean(input.compact);
    const observe = () => page.evaluate(observeExpr);
    const safeObserve = async () => {
      try {
        return await observe();
      } catch (err) {
        const msg = String(err?.message || err || '');
        if (/Execution context was destroyed|Cannot find context|Frame was detached|Inspected target navigated|detached|navigat/i.test(msg)) {
          return { ready: false, animating: true, navigating: true, widgets: [], variables: {}, errors: [] };
        }
        throw err;
      }
    };
    const waitForRuntime = (expectedPage = null) => page.waitForFunction(`(() => {
      const r = ${observeExpr}, expected = ${JSON.stringify(expectedPage)};
      return Boolean(r && r.ready && (!expected || r.page === expected));
    })()`, { timeoutMs, pollMs: 50 });
    const settle = async (waitMs = Math.min(timeoutMs, 2500)) => {
      const deadline = Date.now() + waitMs;
      let latest = { ready: false, animating: true, widgets: [], variables: {}, errors: [] };
      while (Date.now() < deadline) {
        const obs = await safeObserve();
        latest = obs;
        if (obs.ready && !obs.animating) return obs;
        await new Promise(r => setTimeout(r, 40));
      }
      return await safeObserve();
    };

    const captureInitial = wantStoryboard
      ? () => captureFramedScreenshot(page, { frame: frameMode, activeEngine, canvasW, canvasH, vp })
      : null;
    let initialKey = null;
    let isolatedPage = true;
    if (activeEngine === 'official') {
      const initial = await captureStableAxureInitial(safeObserve, captureInitial, timeoutMs);
      before = initial.observation;
      initialKey = initialStateKey(before);
      if (initial.png) storyboardFrames.push({ label: '#0 Initial', png: initial.png, failed: false });
    } else {
      await waitForRuntime();
      before = await settle();
      if (captureInitial) storyboardFrames.push({ label: '#0 Initial', png: await captureInitial(), failed: false });
    }
    result.verification.browserLoaded = true;
    const entryPage = before.page;
    result.initial = compact
      ? {
          page: before.page,
          url: before.url,
          variables: before.variables,
          widgetCount: before.widgets?.length ?? 0,
          errors: before.errors ?? [],
        }
      : before;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const entry = history[i];
      entry.status = 'running';
      const started = performance.now();
      try {
        if (step.action === 'navigate') isolatedPage = true;
        else if (step.action !== 'expect') isolatedPage = false;
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
          try { symbol = explicitPreviewTarget(map, step.target) ?? (map?.symbols.length ? resolvePreviewSymbol(map, step.target, { activePageName: before.page, activePageId: before.pageId }) : null); }
          catch (err) {
            const direct = before.widgets.find(w => [w.name, w.id].includes(step.target));
            if (!direct) throw Object.assign(err, { stepIndex: i });
          }
        }
        if (symbol?.id) { entry.resolvedTarget = symbol.id; entry.target = symbol.id; }
        const pageId = map?.pages?.find(item => item.name === before.page)?.id;
        const pageKey = map?.staticPageKeys?.[pageId];
        const canReuse = verifyCache && isolatedPage && pageKey && step.action === 'expect' && symbol?.pageId === pageId &&
          Object.keys(step.expect ?? {}).length > 0 && Object.keys(step.expect).every(key => key === 'text' || key === 'visible');
        let cachedStep;
        if (canReuse) {
          const key = createHash('sha256').update(JSON.stringify([verifyFingerprint, frameMode, vp, pageId, pageKey,
            symbol.id, step.expect, before.variables])).digest('hex');
          cachedStep = join(verifyCache, key);
          try {
            const saved = JSON.parse(readFileSync(cachedStep, 'utf8'));
            if (saved.key === key && saved.observedWidget && before.ready && !before.animating && !before.errors?.length) {
              Object.assign(entry, { status: 'passed', observedWidget: saved.observedWidget, failures: [], cacheHit: true });
              cacheStats.cachedStepCount++;
              touchCache(cachedStep);
              continue;
            }
          } catch { /* Cold or evicted cache entry. */ }
        }
        const allowHidden = step.action === 'expect' && step.expect?.visible === false;
        let { candidates, widget } = step.target
          ? findWidgetMatch(before, symbol, step.target, { allowHidden, rowIndex: step.rowIndex })
          : { candidates: [], widget: null };
        if (step.target && step.rowIndex === undefined && candidates.length > 1) {
          throw Object.assign(new Error(`目标 "${step.target}" 在预览中匹配到 ${candidates.length} 个实例，请指定 rowIndex。`), { code: 'E_PREVIEW_AMBIGUOUS', stepIndex: i });
        }
        if (step.target && !widget && !allowHidden) {
          throw Object.assign(new Error(`当前页未找到可见目标 "${step.target}"。`), { code: 'E_PREVIEW_NOT_VISIBLE', stepIndex: i });
        }

        const outsideViewport = w => !w || w.centerX < 0 || w.centerY < 0 || w.centerX >= vp.width || w.centerY >= vp.height;
        if (['click', 'drag', 'swipe'].includes(step.action) && outsideViewport(widget)) {
          if (widget) {
            await revealPreviewTarget(page, widget);
            const scrolled = await observe();
            widget = findWidgetMatch(scrolled, symbol, step.target, { rowIndex: step.rowIndex }).widget;
          }
          if (outsideViewport(widget)) throw Object.assign(
            new Error(`目标 "${step.target}" 的可点击中心仍在视口外。`), { code: 'E_PREVIEW_OUTSIDE_VIEWPORT', stepIndex: i });
        }
        const baselineWidget = widget ? { ...widget } : null;

        if (step.action === 'click') {
          if (!widget.enabled) throw Object.assign(new Error(`目标 "${step.target}" 当前被禁用。`), { code: 'E_PREVIEW_DISABLED', stepIndex: i });
          await page.mouseClick(widget.centerX, widget.centerY);
          if (!input.fast || activeEngine === 'official') await new Promise(r => setTimeout(r, 60));
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
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new w.KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
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
          if (!input.fast) await new Promise(r => setTimeout(r, 60));
        } else if (step.action === 'drag') {
          const dx = Number(step.dx ?? 0);
          const dy = Number(step.dy ?? 0);
          await page.mouseDrag(widget.centerX, widget.centerY, widget.centerX + dx, widget.centerY + dy, {
            steps: step.steps ?? 12,
            stepDelayMs: step.stepDelayMs ?? (input.fast ? 3 : 10),
          });
          if (!input.fast) await new Promise(r => setTimeout(r, 60));
        } else if (step.action === 'swipe') {
          const dist = Number(step.distance ?? 160);
          const dir = step.direction ?? 'left';
          const vec = { left: [-dist, 0], right: [dist, 0], up: [0, -dist], down: [0, dist] }[dir];
          if (!vec) throw Object.assign(new Error(`不支持的滑动方向 "${dir}"`), { code: 'E_VERIFY_INPUT', stepIndex: i });
          await page.mouseDrag(widget.centerX, widget.centerY, widget.centerX + vec[0], widget.centerY + vec[1], {
            steps: step.steps ?? 6,
            stepDelayMs: input.fast ? 3 : 8,
          });
          if (!input.fast) await new Promise(r => setTimeout(r, 120));
        } else if (step.action === 'advanceTime' || (step.action === 'wait' && useVirtualClock && Number(step.ms ?? 0) >= 200)) {
          const advMs = Number(step.ms ?? 0);
          const activePage = input.clockScope === 'global' ? null : before.page;
          entry.timersTriggered = await page.evaluate(`(() => {
            const wins = [window];
            const triggered = [];
            for (let k = 0; k < wins.length && k < 20; k++) {
              const w = wins[k];
              try {
                triggered.push(...(w.__zeeClock?.advance(${JSON.stringify(advMs)}, { activePage: ${JSON.stringify(activePage)} }) ?? []));
                for (let n = 0; n < w.frames.length; n++) wins.push(w.frames[n]);
              } catch { /* A frame may navigate as a timer runs. */ }
            }
            return triggered;
          })()`);
          if (entry.timersTriggered.length > 1) entry.coupledTimersWarning = '本步触发了多个页面定时器。';
          if (!input.fast) await new Promise(r => setTimeout(r, 60));
        } else if (step.action === 'wait') {
          await new Promise(r => setTimeout(r, Number(step.ms ?? 250)));
          await new Promise(r => setTimeout(r, 40));
        } else if (step.action === 'navigate') {
          entry.navigationMode = 'runner-bypass';
          entry.note = '此步骤由测试器直接跳页。';
          const pageEntry = map?.pages?.find(p => p.id === step.page || p.name === step.page);
          const targetPageName = pageEntry?.name ?? step.page;
          if (activeEngine === 'studio-html') {
            await page.evaluate(`window.__STUDIO_EXPORT_APP__.navigate(${JSON.stringify(step.page)})`);
            await waitForRuntime();
          } else {
            const destination = officialPageTarget(activeHtmlDir, targetPageName);
            await page.navigate(`${baseUrl}#${destination.fragment}`, timeoutMs);
            await waitForRuntime(destination.name);
          }
        } else if (step.action !== 'expect') {
          throw Object.assign(new Error(`未知验收步骤动作 "${step.action}"`), { code: 'E_VERIFY_INPUT', stepIndex: i });
        }

        const deadline = Date.now() + timeoutMs;
        let current = await settle();
        let failures = [];
        for (;;) {
          if (current.ready && !current.animating) {
            checkInitialState(current);
            const match = step.target
              ? findWidgetMatch(current, symbol, step.target, { allowHidden, rowIndex: step.rowIndex })
              : { widget: null };
            failures = step.expect ? previewMismatch(step, current, match.widget, map, baselineWidget, Boolean(symbol)) : [];
            if (!failures.length) break;
          }
          if (Date.now() >= deadline) break;
          await new Promise(r => setTimeout(r, current.ready && !current.animating ? 80 : 50));
          current = await safeObserve();
        }

        if (!current.ready || current.animating) {
          current = await settle();
        }
        checkInitialState(current);
        const finalMatch = step.target
          ? findWidgetMatch(current, symbol, step.target, { allowHidden, rowIndex: step.rowIndex })
          : { widget: null };
        if (step.expect && !failures.length) {
          failures = previewMismatch(step, current, finalMatch.widget, map, baselineWidget, Boolean(symbol));
        }

        if (!failures.length && step.expect?.visualBaseline) {
          const activeCanvas = map?.pages?.find(p => p.name === current.page)?.canvas ?? rawCanvas;
          const [width, height] = Array.isArray(activeCanvas) ? activeCanvas : [activeCanvas?.w, activeCanvas?.h];
          const owner = rpPath ?? sourcePath;
          const diffDir = owner ? join(dirname(owner), basename(owner, extname(owner)) + '.assets') : workDir;
          const { evidence, failure } = await compareVisualBaseline(step.expect, {
            capture: () => captureFramedScreenshot(page, { frame: 'artboard', activeEngine, vp, canvasW: width, canvasH: height }),
            workDir, diffDir, index: i,
          });
          if (evidence) entry.visual = evidence;
          if (failure) failures.push(failure);
        }
        if (step.action === 'navigate') bypass.add(current.page);
        if (current.page !== before.page && ['click', 'swipe', 'drag', 'fill'].includes(step.action)) {
          reachedByInteraction.set(current.page, { page: current.page, fromPage: before.page, stepIndex: i, trigger: step.target });
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
            ...Object.fromEntries(STYLE_EXPECT_FIELDS.filter(key => key in (step.expect || {})).map(key => [key, finalMatch.widget[key]])),
          };
        }
        entry.failures = failures;
        entry.status = failures.length ? 'failed' : 'passed';
        if (cachedStep && entry.observedWidget && !failures.length && !current.errors?.length) {
          try {
            mkdirSync(verifyCache, { recursive: true });
            writeFileSync(cachedStep, JSON.stringify({ key: basename(cachedStep), observedWidget: entry.observedWidget }), { flag: 'wx' });
          } catch { /* A fresh observation is already in the proof. */ }
        }
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
      } catch (error) {
        recordFailure(error, i);
        initialKey = null;
        if (input.failFast === true || /connection closed|target closed|socket.*closed|websocket.*closed/i.test(error.message)) break;
        before = await settle();
      } finally {
        entry.elapsedMs = Math.round(performance.now() - started);
      }
    }

    const reachedOnlyByBypass = [...bypass].filter(name => name && name !== entryPage && !reachedByInteraction.has(name));
    result.reachability = {
      entryPage,
      reachedByInteraction: [...reachedByInteraction.keys()],
      reachedOnlyByBypass,
      unvisitedPages: (map?.pages ?? []).map(p => p.name).filter(name => name !== entryPage && !bypass.has(name) && !reachedByInteraction.has(name)),
      ...(reachedByInteraction.size ? { paths: [...reachedByInteraction.values()] } : {}),
    };
    if (reachedOnlyByBypass.length) result.warnings = [{ code: 'W_BYPASS_NAVIGATION_ONLY', pages: reachedOnlyByBypass }];
    result.final = { page: before.page, url: before.url, variables: before.variables, errors: before.errors ?? [] };
    result.errors = [...(before.errors ?? []), ...(page?.scriptErrors ?? []).map(e => ({ message: e.text }))];
    result.verification.behaviorVerified = result.status === 'completed' && steps.length > 0 && result.errors.length === 0;
  } catch (error) {
    recordFailure(error, error.stepIndex ?? null);
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
    const browserCloseStarted = performance.now();
    try { await browser?.close(); } catch {}
    timings.browserCloseMs = Math.round(performance.now() - browserCloseStarted);
    try { server.close(); server.closeAllConnections?.(); server.unref?.(); } catch {}
    if (tempStageDir) rmSync(tempStageDir, { recursive: true, force: true });
  }
  result.passed = history.filter(step => step.status === 'passed').length;
  result.failed = failureSummaries.length;
  result.notRun = history.filter(step => step.status === 'not_run').length;
  result.failedSteps = failureSummaries;
  if (verifyCache) pruneBuildCache(verifyCacheRoot);
  cacheStats.reexecutedStepCount = result.passed + result.failed - cacheStats.cachedStepCount;
  result.cacheStats = cacheStats;
  result.elapsedMs = Math.round(performance.now() - verifyStarted);
  result.timings = timings;
  if (behaviorCache && activeEngine === 'official' && result.verification.behaviorVerified) {
    try {
      mkdirSync(dirname(behaviorCache), { recursive: true });
      const { storyboard, screenshot, mcpImages, storyboardImage, previewImage, ...receipt } = result;
      writeFileSync(behaviorCache, JSON.stringify({
        rpSha256: rpHash, sourceSha256: map.baselineSourceHash, at: new Date().toISOString(), result: receipt,
      }), { flag: 'wx' });
      pruneBuildCache(join(workDir, '.zee-cache'));
    } catch { /* Verification still uses the fresh browser result. */ }
  }
  return finishVerification(result, { proofDirectory, rpPath, rpHash, sourcePath, map, steps, stepDetail });
}

function finishVerification(result, { proofDirectory, rpPath, rpHash, sourcePath, map, steps, stepDetail }) {
  if (proofDirectory) {
    try {
      result.proofReport = writeProofReport({
        directory: proofDirectory, rp: rpPath, rpHash, source: sourcePath, semanticHash: map?.semanticHash,
        verification: result, steps,
      });
    } catch (error) {
      result.proofError = { code: error.code ?? 'E_PROOF_REPORT', message: error.message };
    }
  }
  if (stepDetail !== 'full') {
    result.steps = result.steps.map(entry => {
      if (entry.status === 'failed') return entry;
      const { observedWidget, failures, elapsedMs, resolvedTarget, ...compact } = entry;
      if (!Object.keys(compact.variableChanges || {}).length) delete compact.variableChanges;
      return { ...compact, ...(stepDetail === 'compact' && observedWidget ? { observedWidget: { text: observedWidget.text, panelState: observedWidget.panelState } } : {}) };
    });
  }
  if (result.status === 'failed') {
    const { status, passed, failed, notRun, total, failedStep, failedSteps, diagnostics, engine: eng, frame, evidence, ...rest } = result;
    return {
      status,
      passed,
      failed,
      notRun,
      total,
      failedSteps,
      ...(failedStep ? { failedStep } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      engine: eng,
      frame,
      evidence,
      ...rest,
    };
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
