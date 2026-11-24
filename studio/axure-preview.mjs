import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportStudioDocumentToRp } from './export-rp.mjs';

const run = promisify(execFile);
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

async function axurePorts() {
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 3000 });
  return new Set(stdout.split('\n').filter(line => /^Axure/.test(line)).flatMap(line => [...line.matchAll(/(?:127\.0\.0\.1|\*|\[::1?\]|localhost):(\d+)/g)].map(m => Number(m[1]))));
}

// Axure 的 start.html 里写着它此刻在服务哪个文档：
//   PREVIEW_INFO = { fileName : 'scenario-host-123-1'}
// 它比「端口是不是新的」更强：宿主复用一个端口继续发布时，仍能证明这个服务端点的就是本次作业。
export function previewFileMarker(html) {
  if (typeof html !== 'string') return null;
  const match = html.match(/PREVIEW_INFO\s*=\s*\{\s*fileName\s*:\s*(['"])(.*?)\1/);
  return match ? match[2] : null;
}

// 比较时忽略空格与大小写：宿主会规整文件名，不能要求逐字节相等。
function markerKey(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

// 在候选端口里挑出本次作业的那一个。输入是纯数据，便于单测：
//   before/after —— 发布前后 Axure 监听的端口集合
//   markers      —— Map<端口, PREVIEW_INFO 文件名 | null（无标记）| undefined（读取失败）>
//   expected     —— 本次作业副本的文件名（不含扩展名）
// 规则：先按 marker 精确归属；没有 marker 的宿主退回「唯一新端口」；其余一律视为歧义。
export function selectPreviewPort({ before = new Set(), after = new Set(), markers = new Map(), expected }) {
  const wanted = markerKey(expected);
  const all = [...after];
  const fresh = all.filter(port => !before.has(port));
  const marked = wanted ? all.filter(port => markerKey(markers.get(port)) === wanted) : [];
  if (marked.length === 1) return { port: marked[0], reusedPort: !fresh.includes(marked[0]), matchedBy: 'marker' };
  if (marked.length > 1) throw Object.assign(new Error('多个 Axure 预览端口都在服务本次作业文档'), { code: 'E_AXURE_PREVIEW_AMBIGUOUS' });
  // 老版本 Axure 不写 marker 时保持原有语义：本次作业必须拿到一个新端口。
  if (fresh.length === 1 && all.every(port => markers.get(port) === null)) {
    return { port: fresh[0], reusedPort: false, matchedBy: 'new-port' };
  }
  throw Object.assign(new Error('无法唯一定位本次新生成的 Axure 预览端口'), { code: 'E_AXURE_PREVIEW_AMBIGUOUS' });
}

// Axure 的 HTTP/1.0 响应头使用裸 LF。宽松解析仅用于本机 Axure 预览探针。
export async function readPreviewMarker(port) {
  const maxBytes = 4 * 1024 * 1024;
  try {
    const response = await new Promise((resolve, reject) => {
      get({
        host: '127.0.0.1', port, path: '/start.html', agent: false,
        insecureHTTPParser: true, signal: AbortSignal.timeout(3000),
      }, resolve).once('error', reject);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      return undefined;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) return undefined;
      chunks.push(chunk);
    }
    return previewFileMarker(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

// Opens only an owned export. Freshness is proven by the preview marker: the server we return is
// the one serving THIS job's document, so an old tab or an unrelated document can never supply a
// passing native result — even when Axure reuses its preview port for the next generation.
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
  const expected = basename(owned, '.rp');
  // 端口是宿主的事，出现顺序不定；轮询到「唯一归属」为止，超时再报歧义。
  const deadline = Date.now() + 10000;
  let selected;
  for (;;) {
    const after = new Set(await axurePorts());
    const markers = new Map();
    await Promise.all([...after].map(async port => markers.set(port, await readPreviewMarker(port))));
    try {
      selected = selectPreviewPort({ before, after, markers, expected });
      break;
    } catch (error) {
      if (error.code !== 'E_AXURE_PREVIEW_AMBIGUOUS' || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  // Let Axure open its first page. Display names are not exported filenames
  // (spaces and other characters are normalized by the host).
  return { url: `http://127.0.0.1:${selected.port}/start.html`,
    source, owned, contentHash: doc.contentHash, threeZerosPassed: exported.report.summary.threeZerosPassed,
    hostSavedClosedReopened: host.stdout.includes('saved-closed-reopened'), attempts: attempts.length,
    reusedPort: selected.reusedPort, matchedBy: selected.matchedBy };
}
