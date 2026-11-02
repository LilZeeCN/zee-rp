import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChromeExecutable() {
  for (const cand of CHROME_CANDIDATES) {
    if (existsSync(cand)) return cand;
  }
  throw new Error('未找到本机 Google Chrome / Chromium 可执行文件');
}

export class CdpSession {
  constructor(ws, { onClose = null } = {}) {
    this.ws = ws;
    this.onClose = onClose;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.scriptErrors = [];
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
        if (msg.method === 'Runtime.exceptionThrown') this.scriptErrors.push(msg.params.exceptionDetails);
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
    const navigation = await this.send('Page.navigate', { url }, timeoutMs);
    if (navigation.errorText) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const frame = (await this.send('Page.getFrameTree')).frameTree.frame;
        const state = await this.evaluate('document.readyState');
        if ((!navigation.loaderId || frame.loaderId === navigation.loaderId)
          && (state === 'complete' || state === 'interactive')) return;
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`Browser navigation timed out: ${url}`);
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
    if (this.onClose) {
      const fn = this.onClose;
      this.onClose = null;
      try { await fn(); } catch {}
    }
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
    '--no-proxy-server',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-ipc-flooding-protection',
    '--disable-sync',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain',
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dpr}`,
    ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
    'about:blank',
  ];

  const ownedOperation=Boolean(process.env.ZEE_STUDIO_OPERATION_DIR);
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: !ownedOperation });
  const killProcessTree = sig => {
    if(!ownedOperation)try { process.kill(-proc.pid, sig); } catch {}
    try { proc.kill(sig); } catch {}
  };
  const onNodeExit = () => killProcessTree('SIGKILL');
  process.once('exit', onNodeExit);

  let stderrBuf = '';
  let startupResolved = false;
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderrBuf}`)), 15000);
    proc.once('error',error=>{clearTimeout(timer);reject(error);});
    proc.stderr.on('data', chunk => {
      if (startupResolved) return;
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) {
        startupResolved = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderrBuf}`));
    });
  }).catch(error=>{
    process.removeListener('exit',onNodeExit);killProcessTree('SIGKILL');
    try{rmSync(userDataDir,{recursive:true,force:true});}catch{}
    throw error;
  });

  const portMatch = wsEndpoint.match(/127\.0\.0\.1:(\d+)/);
  const debugPort = Number(portMatch[1]);
  const activeSessions = new Set();

  async function openPage(url = 'about:blank') {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const WebSocketClient = globalThis.WebSocket || (await import('ws')).WebSocket;
    const ws = new WebSocketClient(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const session = new CdpSession(ws, {
      onClose: async () => {
        activeSessions.delete(session);
        if (target?.id && proc.exitCode === null) {
          await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => {});
        }
      },
    });
    activeSessions.add(session);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    try { await session.send('Page.bringToFront'); } catch {}
    if(url!=='about:blank')await session.navigate(url);
    return session;
  }

  async function close() {
    process.removeListener('exit', onNodeExit);
    for (const session of activeSessions) {
      try { await session.close(); } catch {}
    }
    activeSessions.clear();
    killProcessTree('SIGTERM');
    await Promise.race([
      proc.exitCode !== null ? Promise.resolve() : new Promise(r => proc.once('exit', r)),
      new Promise(r => setTimeout(r, 150)),
    ]);
    if (proc.exitCode === null) {
      killProcessTree('SIGKILL');
      await Promise.race([
        new Promise(r => proc.once('exit', r)),
        new Promise(r => setTimeout(r, 100)),
      ]);
    }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  return { proc, debugPort, wsEndpoint, userDataDir, openPage, close };
}
