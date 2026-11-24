// Axure 宿主生命周期：纯函数 + 驱动契约。
// 不需要 Axure 安装：端口归属与 marker 解析都是纯数据，驱动部分只检查源码契约。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFileMarker, selectPreviewPort } from '../studio/axure-preview.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
function check(name, action) {
  try { action(); results.push({ name, passed: true }); console.log(`PASS  ${name}`); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); console.log(`FAIL  ${name} — ${error.message}`); }
}

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

// Axure 预览服务只发裸 LF 头；这里用一个裸 LF 的本地服务证明 marker 读取不依赖 CRLF。
// ESM 顶层 await：check() 本身是同步的，异步准备放在外面做。
const bareLfMarker = await (async () => {
  const { createServer } = await import('node:net');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const server = createServer(socket => {
    socket.once('data', () => {
      const body = "PREVIEW_INFO = { fileName : 'job-lf' }";
      socket.end(`HTTP/1.0 200 OK\nContent-Type: text/html\nContent-Length: ${body.length}\n\n${body}`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/curl', ['-sS', `http://127.0.0.1:${server.address().port}/start.html`]);
    return previewFileMarker(stdout);
  } finally {
    server.close();
  }
})();
check('preview marker: reads a bare-LF HTTP/1.0 response', () => assert.equal(bareLfMarker, 'job-lf'));

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
    markers: new Map(), expected: 'job' });
  assert.deepEqual(picked, { port: 2000, reusedPort: false, matchedBy: 'new-port' });
});
check('port: two jobs marked the same are ambiguous', () => {
  assert.throws(() => selectPreviewPort({ before: new Set(), after: new Set([1000, 2000]),
    markers: new Map([[1000, 'job'], [2000, 'job']]), expected: 'job' }),
  (error) => error.code === 'E_AXURE_PREVIEW_AMBIGUOUS');
});
check('port: two new ports with no marker are ambiguous', () => {
  assert.throws(() => selectPreviewPort({ before: new Set(), after: new Set([1000, 2000]),
    markers: new Map(), expected: 'job' }),
  (error) => error.code === 'E_AXURE_PREVIEW_AMBIGUOUS');
});
check('port: nothing listening is ambiguous, not a silent success', () => {
  assert.throws(() => selectPreviewPort({ before, after: new Set([1000]),
    markers: new Map([[1000, 'other']]), expected: 'job' }),
  (error) => error.code === 'E_AXURE_PREVIEW_AMBIGUOUS');
});

// 驱动契约：这些是回归护栏。真正的 GUI 行为仍需真机验证（见 PR 说明）。
const driver = readFileSync(join(root, 'scripts/gui-roundtrip.swift'), 'utf8');
check('driver: closes through the window close button', () => {
  assert.match(driver, /kAXCloseButtonAttribute/);
  assert.match(driver, /func closeOwnedWindow/);
});
check('driver: no per-window System Events probe', () => {
  assert.doesNotMatch(driver, /to exists window/);
});
check('driver: every System Events call carries an Apple event timeout', () => {
  // 每次告诉 System Events 都必须在 250 字符内声明 with timeout，否则宿主一忙就挂两分钟。
  const parts = driver.split('tell application "System Events"');
  assert.ok(parts.length > 1, 'expected System Events usage');
  parts.slice(1).forEach((chunk, index) => {
    const head = parts[index].slice(-250);
    assert.ok(head.includes('with timeout of'), `System Events call #${index + 1} has no timeout`);
  });
});
check('driver: window titles are normalised against the licence suffix', () => {
  assert.match(driver, /func documentKey/);
  assert.match(driver, / - \\\(procName\)/);
});
check('driver: auxiliary modes stay flag-prefixed and never launch the app', () => {
  for (const mode of ['--tcc', '--windows', '--close', '--quit']) assert.ok(driver.includes(`"${mode}"`), mode);
  assert.match(driver, /辅助形态绝不启动应用/);
});
check('driver: legacy positional contract is preserved', () => {
  // jobs.mjs / axure-preview.mjs 依赖这三段输出（用字面量比较，避免正则转义歧义）
  assert.ok(driver.includes('print("saved-closed-reopened")'), 'missing final status word');
  assert.ok(driver.includes('AXURE_GUI_PHASE \\(value)'), 'missing phase marker');
  assert.ok(driver.includes('let wantPreview = arguments.count > 2 && arguments[2] == "preview"'),
    'missing positional preview flag');
});

const failed = results.filter(result => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;