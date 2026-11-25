#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const playwright = process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright';
const { chromium } = await import(playwright);
const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [scenario, path, expectedLength] = process.argv.slice(2);
const root = realpathSync(path);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.gif': 'image/gif',
};
const server = createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = realpathSync(resolve(root, '.' + pathname));
    if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error('Not found');
    res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const target = file => `http://127.0.0.1:${server.address().port}/${encodeURIComponent(file)}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(chrome) ? chrome : undefined,
  });
  const page = await browser.newPage({ hasTouch: scenario === 'swipe' });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const assertions = [];

  const frame = page.frameLocator('#mainFrame');
  const text = value => frame.getByText(value, { exact: true }).filter({ visible: true });
  if (scenario === 'maxlength') {
    await page.goto(target('start.html'));
    const input = page.frameLocator('#mainFrame').locator('input[type=text]');
    await input.waitFor();
    assert.equal(await input.getAttribute('maxlength'), expectedLength);
    assertions.push('Axure output maxlength');
    await input.pressSequentially('0123456789');
    assert.equal(await input.inputValue(), '0123456789'.slice(0, Number(expectedLength)));
    assertions.push('typed input respects native limit');
  } else if (scenario === 'list-detail') {
    await page.goto(target('start.html'));
    await text('高数极限速查').waitFor();
    await text('英语长难句训练').waitFor();
    assertions.push('two visible repeater cards in the official player');
    await text('查看空状态').click();
    await text('还没有复习资料').waitFor();
    assert.equal(await text('查看资料').count(), 0);
    assertions.push('panel switches to empty and hides the repeater');
    await text('恢复示例资料').click();
    await text('英语长难句训练').waitFor();
    assert.equal(await text('还没有复习资料').count(), 0);
    assertions.push('panel returns to populated state');
    await text('查看资料').nth(1).click();
    await text('英语长难句训练').waitFor();
    await text('圈出主干，划分从句，再做完整翻译。').waitFor();
    assertions.push('repeater variables survive page navigation');
    await text('收藏状态：false').waitFor();
    await text('切换收藏').click();
    await text('收藏状态：true').waitFor();
    await text('切换收藏').click();
    await text('收藏状态：false').waitFor();
    assertions.push('both conditional branches update the favorite status');
    await text('返回列表').click();
    await text('高数极限速查').waitFor();
    assertions.push('return link reaches the list');
  } else if (scenario === 'timer') {
    await page.goto(target('start.html'));
    const empty = text('还没有复习资料');
    const ready = text('英语长难句训练');
    const start = text('查看空状态');
    const stop = text('恢复示例资料');
    await ready.waitFor();
    await start.click();
    await empty.waitFor();
    await ready.waitFor();
    assertions.push('timer cycles between two panel states');
    await stop.click();
    const held = await empty.isVisible() ? empty : ready;
    // Check across more than two configured 450 ms intervals.
    for (let i = 0; i < 12; i++) {
      assert.equal(await held.isVisible(), true);
      await new Promise(resolve => setTimeout(resolve, 90));
    }
    assertions.push('set current stops repetition at the visible state');
    await start.click();
    await (held === empty ? ready : empty).waitFor();
    await held.waitFor();
    assertions.push('a new timer starts and cycles again');
  } else if (scenario === 'drag') {
    assert.ok(expectedLength === 'x' || expectedLength === 'y');
    await page.goto(target('start.html'));
    await text('英语长难句训练').waitFor();
    const panel = frame.locator('[data-label^="panel-resourcesPanel-"]');
    const before = await panel.boundingBox();
    const x = before.x + before.width * 0.5;
    const y = before.y + 30;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y + 60, { steps: 12 });
    const dragged = await panel.boundingBox();
    const deltas = { x: dragged.x - before.x, y: dragged.y - before.y };
    assert.ok(deltas[expectedLength] >= 35, JSON.stringify(deltas));
    assert.ok(Math.abs(deltas[expectedLength === 'x' ? 'y' : 'x']) <= 2, JSON.stringify(deltas));
    assertions.push(`native drag follows only the ${expectedLength} axis`);
    await page.mouse.up();
    const end = await panel.boundingBox();
    assert.ok(Math.abs(end.x - before.x) <= 2 && Math.abs(end.y - before.y) <= 2);
    assertions.push('native drag-drop restores pre-drag coordinates');
  } else if (scenario === 'swipe') {
    await page.goto(target('start.html'));
    await text('英语长难句训练').waitFor();
    const panel = frame.locator('[data-label^="panel-resourcesPanel-"]');
    const session = await page.context().newCDPSession(page);
    const swipe = async direction => {
      const rect = await panel.boundingBox();
      const x = rect.x + rect.width * (direction < 0 ? 0.72 : 0.25);
      const y = rect.y + 32;
      const touch = (type, touchPoints) => session.send('Input.dispatchTouchEvent', { type, touchPoints });
      await touch('touchStart', [{ x, y }]);
      for (let i = 1; i <= 12; i++) {
        await touch('touchMove', [{ x: x + direction * i * 12, y }]);
      }
      await touch('touchEnd', []);
    };
    await swipe(-1);
    await text('还没有复习资料').waitFor();
    assertions.push('left swipe switches to the empty panel state');
    // Avoid starting the reverse gesture on the outgoing element during its slide.
    await panel.evaluate(async element => {
      const win = element.ownerDocument.defaultView;
      const jq = win.jQuery;
      if (!jq) return;
      await new Promise(resolve => jq(element).find(':animated').promise().done(resolve));
    });
    await swipe(1);
    await text('英语长难句训练').waitFor();
    assertions.push('right swipe returns to the populated panel state');
  } else {
    throw new Error('Usage: node browser-check.mjs <maxlength|list-detail|timer|drag|swipe> <HTML directory> [length]');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ scenario, assertions, errors }, null, 2));
} finally {
  await browser?.close();
  server.close();
}
