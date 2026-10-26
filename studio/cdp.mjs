import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export function findChromeExecutable() {
  for (const cand of CHROME_CANDIDATES) {
    if (existsSync(cand)) return cand;
  }
  throw new Error('未找到本机 Google Chrome / Chromium 可执行文件');
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message}`));
          else entry.resolve(msg.result);
        }
      } else if (msg.method) {
        const list = this.listeners.get(msg.method) || [];
        for (const fn of list) fn(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`CDP WebSocket closed during ${entry.method}`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs}ms) on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: val => { clearTimeout(timer); resolve(val); },
        reject: err => { clearTimeout(timer); reject(err); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 15000 } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
    }, timeoutMs);
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'JS evaluation error';
      throw new Error(`Browser evaluate failed: ${desc}`);
    }
    return res.result?.value;
  }

  async navigate(url, timeoutMs = 15000) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Page.navigate', { url }, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState');
        if (state === 'complete' || state === 'interactive') return;
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }
  }

  async waitForFunction(fnSource, optionsOrTimeout = {}) {
    const timeoutMs = typeof optionsOrTimeout === 'number' ? optionsOrTimeout : (optionsOrTimeout?.timeoutMs ?? 10000);
    const pollMs = typeof optionsOrTimeout === 'object' && optionsOrTimeout?.pollMs ? optionsOrTimeout.pollMs : 40;
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    const src = typeof fnSource === 'function' ? fnSource.toString() : String(fnSource);
    while (Date.now() < deadline) {
      try {
        const val = await this.evaluate(`(() => { const __v = (${src}); return Boolean(typeof __v === 'function' ? __v() : __v); })()`);
        if (val) return true;
      } catch (e) {
        lastErr = e;
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`waitForFunction timed out after ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ''}`);
  }

  async screenshot({ clip = null, format = 'png', captureBeyondViewport = false } = {}) {
    const params = { format, captureBeyondViewport };
    if (clip) {
      params.clip = {
        x: Number(clip.x),
        y: Number(clip.y),
        width: Number(clip.w ?? clip.width),
        height: Number(clip.h ?? clip.height),
        scale: Number(clip.scale ?? 1),
      };
    }
    const res = await this.send('Page.captureScreenshot', params, 20000);
    return Buffer.from(res.data, 'base64');
  }

  async mouseClick(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
  }

  async mouseDrag(fromX, fromY, toX, toY, { steps = 10, stepDelayMs = 8 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cx = fromX + (toX - fromX) * t;
      const cy = fromY + (toY - fromY) * t;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'left', buttons: 1 });
      if (stepDelayMs > 0) await new Promise(r => setTimeout(r, stepDelayMs));
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 });
  }

  async close() {
    try { this.ws.close(); } catch {}
  }
}

export async function launchChrome({ headless = true, width = 1440, height = 900, dpr = 2 } = {}) {
  const bin = findChromeExecutable();
  const userDataDir = mkdtempSync(join(tmpdir(), 'zee-studio-chrome-'));
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dpr}`,
    ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
    'about:blank',
  ];

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const killProcessTree = sig => {
    try { process.kill(-proc.pid, sig); } catch {}
    try { proc.kill(sig); } catch {}
  };
  const onNodeExit = () => killProcessTree('SIGKILL');
  process.once('exit', onNodeExit);

  let stderrBuf = '';
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderrBuf}`)), 15000);
    proc.stderr.on('data', chunk => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderrBuf}`));
    });
  });

  const portMatch = wsEndpoint.match(/127\.0\.0\.1:(\d+)/);
  const debugPort = Number(portMatch[1]);

  async function openPage(url = 'about:blank') {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const session = new CdpSession(ws);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    try { await session.send('Page.bringToFront'); } catch {}
    return session;
  }

  async function close() {
    process.removeListener('exit', onNodeExit);
    killProcessTree('SIGTERM');
    await new Promise(r => setTimeout(r, 150));
    killProcessTree('SIGKILL');
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  return { proc, debugPort, wsEndpoint, userDataDir, openPage, close };
}
