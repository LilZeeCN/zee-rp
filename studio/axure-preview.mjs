import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportStudioDocumentToRp } from './export-rp.mjs';

const run = promisify(execFile);
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

async function axurePorts() {
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  return new Set(stdout.split('\n').filter(line => /^Axure/.test(line)).flatMap(line => [...line.matchAll(/(?:127\.0\.0\.1|\*|\[::1?\]|localhost):(\d+)/g)].map(m => Number(m[1]))));
}

// Opens only a new, owned export. A fresh preview server is mandatory so an old
// tab or an unrelated document can never supply a passing native result.
export async function prepareAxurePreview(doc, directory, { projectDir = null } = {}) {
  if (process.platform !== 'darwin' || Number(doc.target || 9) !== 9) throw Object.assign(new Error('自动 Axure 预览需要 macOS 与目标版本为 Axure RP 9 的工程'), { code: 'E_AXURE_HOST_UNAVAILABLE' });
  mkdirSync(directory, { recursive: true });
  const before = await axurePorts();
  const source = join(directory, 'scenario-source.rp');
  const exported = await exportStudioDocumentToRp(doc, { outRpPath: source, projectDir });
  const attempts = [];
  let host;
  let owned;
  for (let attempt = 1; attempt <= 2; attempt++) {
    owned = join(directory, `scenario-host-${Date.now()}-${attempt}.rp`);
    copyFileSync(source, owned);
    try {
      host = await run('/usr/bin/swift', [join(scriptsDir, 'gui-roundtrip.swift'), owned, '9', 'preview'], { timeout: 45000 });
      attempts.push({ owned, passed: true, stdout: host.stdout, stderr: host.stderr });
      break;
    } catch (error) {
      attempts.push({ owned, passed: false, stdout: error.stdout, stderr: error.stderr, message: error.message });
      writeFileSync(join(directory, 'host-roundtrip.json'), JSON.stringify({ source, contentHash: doc.contentHash, attempts }, null, 2));
      if (attempt === 2) throw error;
    }
  }
  writeFileSync(join(directory, 'host-roundtrip.json'), JSON.stringify({ source, owned, stdout: host.stdout, stderr: host.stderr, contentHash: doc.contentHash, attempts }, null, 2));
  let ports = [];
  const deadline = Date.now() + 10000;
  do {
    ports = [...await axurePorts()].filter(port => !before.has(port));
    if (!ports.length) await new Promise(resolve => setTimeout(resolve, 100));
  } while (!ports.length && Date.now() < deadline);
  if (ports.length !== 1) throw Object.assign(new Error('无法唯一定位本次新生成的 Axure 预览端口'), { code: 'E_AXURE_PREVIEW_AMBIGUOUS' });
  // Let Axure open its first page. Display names are not exported filenames
  // (spaces and other characters are normalized by the host).
  return { url: `http://127.0.0.1:${ports[0]}/start.html`,
    source, owned, contentHash: doc.contentHash, threeZerosPassed: exported.report.summary.threeZerosPassed,
    hostSavedClosedReopened: host.stdout.includes('saved-closed-reopened'), attempts: attempts.length };
}
