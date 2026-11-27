// Axure 宿主生命周期：纯函数 + 驱动契约。
// 不需要 Axure 安装：端口归属与 marker 解析都是纯数据，驱动部分只检查源码契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFileMarker, readPreviewMarker, selectPreviewPort } from '../studio/axure-preview.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = (name, action) => test(name, action);

check('preview marker: single quotes', () => {
  assert.equal(previewFileMarker("PREVIEW_INFO = { fileName : 'scenario-host-1'}"), 'scenario-host-1');
});
check('preview marker: double quotes and spacing', () => {
  assert.equal(previewFileMarker('PREVIEW_INFO={fileName:"job-x"}'), 'job-x');
});
check('preview marker: absent', () => {
  assert.equal(previewFileMarker('<html><body>no marker</body></html>'), null);
  assert.equal(previewFileMarker(undefined), null);
});

async function previewResponse(status, body, length = Buffer.byteLength(body)) {
  const server = createServer(socket => {
    socket.once('data', () => {
      socket.end(`HTTP/1.0 ${status}\nContent-Type: text/html\nContent-Length: ${length}\n\n${body}`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await readPreviewMarker(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
test('preview marker HTTP response variants: bare-LF and status distinction', async () => {
  const body = "PREVIEW_INFO = { fileName : '作业-lf' }";
  const bareLfMarker = await previewResponse('200 OK', body);
  const markerless = await previewResponse('200 OK', '<html>旧版预览</html>');
  const missingPage = await previewResponse('404 Not Found', body);
  const truncatedPage = await previewResponse('200 OK', body, Buffer.byteLength(body) + 1);
  assert.equal(bareLfMarker, '作业-lf');
  assert.equal(markerless, null);
  assert.equal(missingPage, undefined);
  assert.equal(truncatedPage, undefined);
});

const before = new Set([1000]);
check('port: a new port serving this job wins', () => {
  const picked = selectPreviewPort({ before, after: new Set([1000, 2000]),
    markers: new Map([[1000, 'other'], [2000, 'job']]), expected: 'job' });
  assert.deepEqual(picked, { port: 2000, reusedPort: false, matchedBy: 'marker' });
});
check('port: a reused port is accepted when it serves this job', () => {
  const picked = selectPreviewPort({ before: new Set([1000]), after: new Set([1000]),
    markers: new Map([[1000, 'job']]), expected: 'job' });
  assert.deepEqual(picked, { port: 1000, reusedPort: true, matchedBy: 'marker' });
});
check('port: marker comparison ignores spaces and case', () => {
  const picked = selectPreviewPort({ before: new Set(), after: new Set([1000]),
    markers: new Map([[1000, 'Job  X']]), expected: 'jobx' });
  assert.equal(picked.port, 1000);
});
check('port: hosts without a marker keep the old “one new port” rule', () => {
  const picked = selectPreviewPort({ before: new Set([1000]), after: new Set([1000, 2000]),
    markers: new Map([[1000, null], [2000, null]]), expected: 'job' });
  assert.deepEqual(picked, { port: 2000, reusedPort: false, matchedBy: 'new-port' });
});
check('port: a new port marked for another document is rejected', () => {
  assert.throws(() => selectPreviewPort({ before, after: new Set([1000, 2000]),
    markers: new Map([[1000, 'previous-job'], [2000, 'other-document']]), expected: 'job' }),
  { code: 'E_AXURE_PREVIEW_AMBIGUOUS' });
});
check('port: a failed probe or a known marker cannot trigger the legacy fallback', () => {
  for (const markers of [new Map([[1000, null]]), new Map([[1000, 'previous-job'], [2000, null]])]) {
    assert.throws(() => selectPreviewPort({ before, after: new Set([1000, 2000]), markers, expected: 'job' }),
      { code: 'E_AXURE_PREVIEW_AMBIGUOUS' });
  }
});
check('port: two jobs marked the same are ambiguous', () => {
  assert.throws(() => selectPreviewPort({ before: new Set(), after: new Set([1000, 2000]),
    markers: new Map([[1000, 'job'], [2000, 'job']]), expected: 'job' }),
  (error) => error.code === 'E_AXURE_PREVIEW_AMBIGUOUS');
});
check('port: two new ports with no marker are ambiguous', () => {
  assert.throws(() => selectPreviewPort({ before: new Set(), after: new Set([1000, 2000]),
    markers: new Map([[1000, null], [2000, null]]), expected: 'job' }),
  (error) => error.code === 'E_AXURE_PREVIEW_AMBIGUOUS');
});
check('port: nothing listening is ambiguous, not a silent success', () => {
  assert.throws(() => selectPreviewPort({ before, after: new Set([1000]),
    markers: new Map([[1000, 'other']]), expected: 'job' }),
  (error) => error.code === 'E_AXURE_PREVIEW_AMBIGUOUS');
});

// 驱动契约：这些是回归护栏。真正的 GUI 行为仍需真机验证（见 PR 说明）。
const driver = readFileSync(join(root, 'scripts/gui-roundtrip.swift'), 'utf8');
check('driver: window close and menu close require an owned target', () => {
  assert.match(driver, /kAXCloseButtonAttribute/);
  assert.match(driver, /guard closeDocument\(app, path, title\)/);
  assert.match(driver, /if name of value of attribute "AXFocusedWindow" is not .* then return false/);
  assert.doesNotMatch(driver, /fileAction\("关闭", "Close"\)/);
});
check('driver: no per-window System Events probe', () => {
  assert.doesNotMatch(driver, /to exists window/);
});
check('driver: all Apple events go through the bounded script executor', () => {
  assert.equal([...driver.matchAll(/\bNSAppleScript\(/g)].length, 1);
  assert.match(driver, /let boundedSource = "with timeout of .*end timeout"/);
  assert.match(driver, /NSAppleScript\(source: boundedSource\)/);
});
check('driver: window titles are normalised against the licence suffix', () => {
  assert.match(driver, /func documentKey/);
  assert.match(driver, / - \\\(procName\)/);
});
check('driver: auxiliary modes stay flag-prefixed and never launch the app', () => {
  for (const mode of ['--tcc', '--windows', '--close', '--quit']) assert.ok(driver.includes(`"${mode}"`), mode);
  assert.match(driver, /辅助形态绝不启动应用/);
});
check('driver: quit observes the requested instance and preserves normal termination', () => {
  assert.match(driver, /app\.terminate\(\)/);
  assert.match(driver, /kill\(pid, 0\) == -1 && errno == ESRCH/);
  assert.doesNotMatch(driver, /runningApp\(\) == nil|forceTerminate\(|\bpkill\b/);
});
check('driver: legacy positional contract is preserved', () => {
  // jobs.mjs / axure-preview.mjs 依赖这三段输出（用字面量比较，避免正则转义歧义）
  assert.ok(driver.includes('print("saved-closed-reopened")'), 'missing final status word');
  assert.ok(driver.includes('AXURE_GUI_PHASE \\(value)'), 'missing phase marker');
  assert.ok(driver.includes('let wantPreview = arguments.count > 2 && arguments[2] == "preview"'),
    'missing positional preview flag');
});
