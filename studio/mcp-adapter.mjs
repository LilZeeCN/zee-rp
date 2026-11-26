import { SCENARIO_STEP_SCHEMA } from './runtime.mjs';
import { BROWSER_SCENARIO_STEP_SCHEMA } from './scenario-executors.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { assertNotProtected, assertWritable, resolveWorkDir } from '../scripts/engine.mjs';
import { importHtmlToRp1Spec, isHtmlInput } from '../scripts/html-import.mjs';
import { exportPrototype, runWorkflow, verifyOfficialPreview, verifyStepItemsSchema } from '../scripts/authoring-workflow.mjs';
import { INSTANCE_REGISTRY_PATH, startStudioServer } from './server.mjs';
import { studioSourceFingerprint } from './source-fingerprint.mjs';
import { describeAuthoring, AUTHORING_ENTRY } from './authoring-help.mjs';
import { VALID_COMMAND_TYPES } from './commands.mjs';
import { StudioOperations, OPERATION_PROPERTIES } from './operations.mjs';
import {
  exportProjectBundle,
  verifyProjectBundle,
  importProjectBundle,
  buildBundleCompatibilityReport,
  compareProjectWithBundle,
} from './project-bundle.mjs';

/** projectDir(绝对路径) -> { kind: 'local', studio } | { kind: 'remote', url } */
const inProcessServers = new Map();
let lastActiveProjectDir = null;

function instanceRecordFor(projectDir) {
  if (!projectDir) return null;
  try {
    const instFile = join(resolve(projectDir), '.studio-instance.json');
    if (!existsSync(instFile)) return null;
    return JSON.parse(readFileSync(instFile, 'utf8'));
  } catch {
    return null;
  }
}

async function probeInstance(record, expectedProjectDir = null) {
  if (!record?.url) return null;
  if (expectedProjectDir && record.projectDir && resolve(record.projectDir) !== resolve(expectedProjectDir)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`${record.url}/api/context`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.ok) return null;
    if (expectedProjectDir && (!body.projectDir || resolve(body.projectDir) !== resolve(expectedProjectDir))) return null;
    return body;
  } catch {
    return null;
  }
}

async function resolveServerUrl({ url = null, port = null, projectDir = null } = {}) {
  if (url) return url.replace(/\/$/, '');
  if (port) return `http://127.0.0.1:${port}`;
  const targetDir = projectDir ? resolve(projectDir) : lastActiveProjectDir;
  if (projectDir) lastActiveProjectDir = targetDir;
  if (targetDir) {
    const known = inProcessServers.get(targetDir);
    if (known?.kind === 'local' && known.studio.server?.listening && known.studio.projectDir === targetDir) return known.studio.url;
    const record = instanceRecordFor(targetDir) || (known?.kind === 'remote' ? known : null);
    if (await probeInstance(record, targetDir)) return record.url.replace(/\/$/, '');
    if (projectDir) {
      // 显式指定了 projectDir 但未找到运行实例，不回退到其他工程实例
      throw Object.assign(new Error(`未找到工程 "${targetDir}" 的运行中 Studio 服务实例，请先调用 studio_open_project 启动`), {
        code: 'E_NO_STUDIO_INSTANCE',
        projectDir: targetDir,
      });
    }
  }
  if (inProcessServers.size === 1 && !projectDir) {
    const only = [...inProcessServers.values()][0];
    return only.kind === 'local' ? only.studio.url : only.url;
  }

  if (!projectDir && existsSync(INSTANCE_REGISTRY_PATH)) {
    try {
      const list = JSON.parse(readFileSync(INSTANCE_REGISTRY_PATH, 'utf8'));
      if (Array.isArray(list)) {
        for (let i = list.length - 1; i >= 0; i--) {
          const cand = list[i];
          if (cand?.url) {
            const ping = await fetch(`${cand.url}/api/context`).catch(() => null);
            if (ping && ping.ok) return cand.url;
          }
        }
      }
    } catch {}
  }

  throw Object.assign(new Error('未找到运行中的 Studio 服务实例，请先调用 studio_open_project 启动或指定 url/port'), {
    code: 'E_NO_STUDIO_INSTANCE',
  });
}

async function callServerJson(baseUrl, path, method = 'GET', body = null, { readOnly = false } = {}) {
  let lastErr = null;
  // A lost response does not mean a write failed. Reads may reconnect;
  // mutations must be inspected by revision/idempotency before any replay.
  for (let attempt = 0; attempt < (method === 'GET' || readOnly ? 2 : 1); attempt++) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  if (method !== 'GET' && !readOnly) throw Object.assign(new Error(`写入回包未确认，未自动重发。请先读取当前版本与实际内容，再决定是否使用原幂等键核对结果。原错误：${lastErr?.message || '连接中断'}`), { code: 'E_WRITE_OUTCOME_UNKNOWN' });
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 响应预算：MCP 层默认压缩，HTML 画布与 HTTP/CLI 保持全量。
// 目标：单次写操作响应 < 12KB，避免 agent 多轮迭代被上下文吃光。
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 12000;
const NODE_KEYS = ['id', 'scopedId', 'type', 'role', 'parentId', 'parentLayout', 'layout', 'padding', 'gap', 'sourceX', 'sourceY', 'x', 'y', 'w', 'h', 'name'];

function compactNode(node) {
  const out = {};
  for (const key of NODE_KEYS) {
    const value = node[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  if (typeof node.text === 'string' && node.text) {
    out.text = node.text.length > 40 ? `${node.text.slice(0, 40)}…` : node.text;
  }
  if (node.visible === false) out.visible = false;
  if (node.type === 'repeater') {
    out.dataset = node.dataset || null;
    out.rowCount = Array.isArray(node.rows) ? node.rows.length : 0;
    if (Number.isFinite(node.totalRows)) out.totalRows = node.totalRows;
    if (node.filtered) out.filtered = true;
    if (node.filter) out.filter = node.filter;
  }
  if (node.componentSource) out.component = node.componentSource.componentId || node.componentSource.component || true;
  if (node.macroSource?.macroType) out.macro = node.macroSource.macroType;
  return out;
}

function compactScene(scene) {
  if (!scene) return null;
  return {
    documentId: scene.documentId,
    revision: scene.revision,
    pages: (scene.pages || []).map(page => ({
      id: page.id,
      name: page.name,
      board: page.board,
      nodes: (page.nodes || []).map(compactNode),
    })),
  };
}

function compactDoc(doc) {
  if (!doc) return null;
  const datasets = {};
  for (const [name, ds] of Object.entries(doc.datasets || {})) {
    datasets[name] = { model: ds.model || null, rowCount: (ds.rows || []).length };
  }
  return {
    name: doc.name,
    documentId: doc.documentId,
    domain: doc.domain,
    theme: doc.theme,
    device: doc.device,
    palette: doc.palette,
    tokens: doc.tokens,
    variables: doc.variables,
    datasets,
    components: Object.keys(doc.components || {}),
    pages: (doc.pages || []).map(page => ({
      id: page.id,
      name: page.name,
      domain: page.domain,
      device: page.device,
      canvas: page.canvas,
      childCount: (page.root?.children || []).length,
    })),
  };
}

// 事务回包默认只给文档身份桩：受影响节点在 scene/affectedNodeIds，完整文档由
// includeDoc:true 显式索取，避免每笔编辑都重复传 palette/tokens/全部页面（T-C-2）。
function docStub(payload) {
  if (!payload?.doc) return null;
  return {
    documentId: payload.doc.documentId ?? payload.documentId ?? null,
    revision: payload.appliedRevision ?? payload.doc.revision ?? null,
    contentHash: payload.contentHash ?? payload.doc.contentHash ?? null,
    pageCount: (payload.doc.pages || []).length,
    fullDocument: false,
    note: '事务默认不重复回传文档；受影响节点见 scene/affectedNodeIds，完整文档传 includeDoc:true 或调用 studio_inspect(view:"context")',
  };
}

function byteLen(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * 在字节预算内逐级降级，并把降级动作写进 truncations，绝不做静默截断。
 */
function enforceBudget(payload, maxBytes = DEFAULT_MAX_BYTES) {
  if (byteLen(payload) <= maxBytes) return payload;
  const out = structuredClone(payload);
  out.truncations = out.truncations || [];

  const affectedPages = new Set(
    (payload.affectedNodeIds || [])
      .map(id => String(id).split('/')[0])
      .filter(Boolean)
  );

  if (out.scene?.pages?.length) {
    for (const page of out.scene.pages) {
      if (affectedPages.size && !affectedPages.has(page.id)) {
        // 事务回包预过滤（sceneFiltered）已写入真实 nodeCount，这里只补缺，不覆盖。
        page.nodeCount = page.nodeCount ?? (page.nodes || []).length;
        delete page.nodes;
      }
    }
    if (byteLen(out) > maxBytes) out.truncations.push({ level: 1, dropped: 'scene.nodes of unaffected pages' });
  }

  if (byteLen(out) > maxBytes && out.scene?.pages) {
    for (const page of out.scene.pages) {
      page.nodeCount = page.nodeCount ?? (page.nodes || []).length;
      delete page.nodes;
    }
    out.truncations.push({ level: 2, dropped: 'all scene.nodes', how: 'use studio_inspect for details' });
  }

  if (byteLen(out) > maxBytes && out.doc) {
    delete out.doc;
    out.truncations.push({ level: 3, dropped: 'doc', how: 'pass includeDoc:true to opt in' });
  }

  if (byteLen(out) > maxBytes && out.recentHistory) {
    out.recentHistory = out.recentHistory.slice(0, 3);
    out.truncations.push({ level: 4, dropped: 'recentHistory beyond 3' });
  }

  if (byteLen(out) > maxBytes && out.scene?.pages) {
    for (const page of out.scene.pages) delete page.board;
    out.truncations.push({ level: 5, dropped: 'page.board' });
  }

  out.payloadBytes = byteLen(out);
  return out;
}

function compactImpact(payload) {
  const impact = payload.transitiveImpact;
  if (!impact || typeof impact !== 'object') return payload;
  const count = value => (Array.isArray(value) ? value.length : 0);
  const out = { ...payload };
  out.impactSummary = {
    directTargets: count(impact.directTargetNodeIds),
    ancestors: count(impact.affectedAncestorIds),
    shiftedSiblings: count(impact.shiftedSiblingAndDescendantIds),
    componentInstances: count(impact.affectedComponentInstanceIds),
    tokenConsumers: count(impact.affectedTokenConsumerIds),
    totalAffected: count(impact.allAffectedNodeIds),
    pages: impact.affectedPageIds || [],
  };
  delete out.transitiveImpact;
  delete out.semanticDiff;
  delete out.unaffectedPagesVerification;
  if (out.humanReadableSummary && typeof out.humanReadableSummary === 'object') {
    out.humanReadableSummary = {
      whatChanged: out.humanReadableSummary.whatChanged,
      affectedScope: out.humanReadableSummary.affectedScope,
      diagnosticsSummary: out.humanReadableSummary.diagnosticsSummary,
    };
  }
  return out;
}

function projectPayload(payload, { verbose = false, includeDoc = false, includeScene = false, maxBytes, docStyle = 'summary' } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.ok === false) return { ...payload, payloadBytes: byteLen(payload) };
  if (verbose) return { ...payload, compact: false, payloadBytes: byteLen(payload) };
  const compact = compactImpact({ ...payload });
  if (!includeDoc) compact.doc = docStyle === 'stub' ? docStub(payload) : compactDoc(payload.doc);
  else compact.doc = payload.doc;
  if (!includeScene) compact.scene = compactScene(payload.scene);
  else compact.scene = payload.scene;
  compact.compact = true;
  // includeDoc is an explicit request for the complete document. Give that
  // request the schema maximum by default; otherwise the generic compact
  // budget can delete the very doc the caller asked for.
  const budgeted = enforceBudget(compact, maxBytes ?? (includeDoc ? 400000 : DEFAULT_MAX_BYTES));
  budgeted.payloadBytes = byteLen(budgeted);
  return budgeted;
}

function instanceSummary() {
  return [...inProcessServers.entries()].map(([projectDir, entry]) => ({
    projectDir,
    url: entry.kind === 'local' ? entry.studio.url : entry.url,
    kind: entry.kind,
  }));
}

// ---------------------------------------------------------------------------
// Agent 工具面(2026-11-08 收敛):28 个 studio_* 工具收敛为 13 个动词化工具,
// 参考 figcraft 的 run_command/batch/inspect 模式。HTTP /api/* 路由与浏览器
// 零变化;studioHandlers 保留旧名作为内部兼容别名(测试/CLI 直调),MCP 客户端
// 只看到 studioTools 里的 13 个。
// ---------------------------------------------------------------------------

const projectionProperties = {
  verbose: { type: 'boolean', description: 'true 返回全量回包,不做压缩与预算降级' },
  includeDoc: { type: 'boolean' },
  includeScene: { type: 'boolean' },
  maxBytes: { type: 'integer', minimum: 2048, maximum: 400000 },
};

export const studioHandlers = {
  async studio_operations(args={}) {
    const {projectDir,url,port,action='get',...body}=args;
    if(!['get','list','cancel'].includes(action))throw Object.assign(new Error('action需要get/list/cancel'),{code:'E_OPERATION_ACTION'});
    if(projectDir)return new StudioOperations(projectDir)[action](body);
    return callServerJson(await resolveServerUrl({url,port}),'/api/operations','POST',{action,...body});
  },

  async studio_describe(args = {}) {
    try { return describeAuthoring(args); }
    catch (error) {
      const contracts = args.topic === 'command' && Array.isArray(args.names) ? args.names.flatMap(name => {
        try { return [describeAuthoring({ topic: 'command', name })]; } catch { return []; }
      }) : [];
      return { ok: false, code: error.code || 'E_AUTHORING_HELP', message: error.message,
        ...(error.candidates ? { candidates: error.candidates } : {}), ...(contracts.length ? { contracts } : {}) };
    }
  },

  async studio_open_project({
    projectDir,
    cwd = null,
    sourcePath = null,
    rp1 = null,
    name = 'Studio Project',
    domain = 'mobile',
    port = null,
    url = null,
    verbose = false,
    includeDoc = false,
    includeScene = false,
    maxBytes = null,
  } = {}) {
    if (!projectDir) {
      throw Object.assign(new Error('projectDir 参数必填'), { code: 'E_PROJECT_DIR_REQUIRED' });
    }
    if (rp1 !== null && sourcePath !== null) {
      throw Object.assign(new Error('studio_open_project 中 rp1 与 sourcePath 必须二选一'), { code: 'E_RP1_INPUT' });
    }
    if (port !== null && port !== 0 && (port < 1024 || port > 65535)) {
      throw Object.assign(new Error('port 需为 0（由系统分配空闲端口）或 1024–65535'), { code: 'E_INVALID_PORT', requestedPort: port });
    }
    const workDir = resolveWorkDir(cwd);
    const absDir = isAbsolute(projectDir) ? resolve(projectDir) : resolve(workDir, projectDir);
    assertNotProtected(absDir);
    assertWritable(join(absDir, 'document.json'));
    let htmlImportSummary = null;
    let resolvedSourcePath = null;
    if (typeof sourcePath === 'string' && isHtmlInput(sourcePath)) {
      const trimmed = sourcePath.trim();
      const htmlTarget = /^(?:https?|file):\/\//i.test(trimmed)
        ? trimmed
        : (isAbsolute(trimmed) ? resolve(trimmed) : resolve(workDir, trimmed));
      if (!/^https?:\/\//i.test(htmlTarget)) assertNotProtected(htmlTarget);
      mkdirSync(absDir, { recursive: true });
      const imported = await importHtmlToRp1Spec(htmlTarget, {
        cwd: workDir,
        assetsDir: join(absDir, 'assets'),
        name: name && name !== 'Studio Project' ? name : undefined,
        domain,
      });
      const importedSpecFile = join(absDir, '.imported-html.spec.json');
      writeFileSync(importedSpecFile, JSON.stringify(imported.spec, null, 2) + '\n', 'utf8');
      writeFileSync(join(absDir, '.imported-html.rp1'), imported.rp1Text, 'utf8');
      resolvedSourcePath = importedSpecFile;
      htmlImportSummary = imported.summary;
    } else {
      resolvedSourcePath = typeof sourcePath === 'string' && sourcePath.trim() && !sourcePath.trimStart().startsWith('{')
        ? (isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workDir, sourcePath))
        : sourcePath;
      if (typeof resolvedSourcePath === 'string' && resolvedSourcePath && !resolvedSourcePath.trimStart().startsWith('{')) {
        assertNotProtected(resolvedSourcePath);
      }
    }
    if (typeof rp1 === 'string') {
      if (!rp1.trim()) throw Object.assign(new Error('rp1 源码文本不能为空'), { code: 'E_RP1_SOURCE_EMPTY' });
      mkdirSync(absDir, { recursive: true });
      const inlineFile = join(absDir, '.initial-source.rp1');
      writeFileSync(inlineFile, rp1.endsWith('\n') ? rp1 : `${rp1}\n`, 'utf8');
      resolvedSourcePath = inlineFile;
    }
    lastActiveProjectDir = absDir;
    const respond = (body, extra = {}) => {
      const diskFingerprint = studioSourceFingerprint();
      const sourceFingerprint = body.sourceFingerprint ?? null;
      const restartRequired = sourceFingerprint !== diskFingerprint;
      return {
        ...projectPayload({
          ...body,
          ...(htmlImportSummary ? { htmlImport: htmlImportSummary } : {}),
          studioRuntime: {
            sourceFingerprint,
            diskFingerprint,
            restartRequired,
            ...(restartRequired ? { nextAction: '保存项目，重启提供此 URL 的 Studio 服务后重新打开项目' } : {}),
          },
        }, { verbose, includeDoc, includeScene, maxBytes }),
        ...extra,
        ...(htmlImportSummary ? { htmlImport: htmlImportSummary } : {}),
        openInstances: instanceSummary(),
      };
    };
    if (url) {
      const body = await callServerJson(url.replace(/\/$/, ''), '/api/project/open', 'POST', {
        projectDir: absDir,
        sourcePath: resolvedSourcePath,
        name,
        domain,
      });
      return respond(body);
    }

    // 同一工程：已有本地实例就直接复用，避免重复加载与画面重置。
    const known = inProcessServers.get(absDir);
    if (known?.kind === 'local' && known.studio.server?.listening && known.studio.projectDir === absDir) {
      if (port !== null && port !== 0 && known.studio.port !== port) {
        throw Object.assign(new Error(`工程已在端口 ${known.studio.port} 运行；显式请求端口 ${port} 不会热迁移实例，请继续使用当前端口或换一个新的 projectDir`), {
          code: 'E_INSTANCE_PORT_MISMATCH', projectDir: absDir, currentPort: known.studio.port, requestedPort: port,
        });
      }
      const body = resolvedSourcePath
        ? known.studio.openProject({ projectDir: absDir, sourcePath: resolvedSourcePath, name, domain })
        : known.studio.buildContextPayload();
      return respond(body);
    }
    // 跨进程复用前先确认服务仍在运行且打开的是该工程。
    const record = instanceRecordFor(absDir) || (known?.kind === 'remote' ? known : null);
    const live = await probeInstance(record, absDir);
    if (live) {
      const endpoint = new URL(live.url || record.url);
      const currentPort = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80));
      if (port !== null && port !== 0 && currentPort !== port) {
        throw Object.assign(new Error(`工程已在端口 ${currentPort} 运行；请继续使用当前端口`), {
          code: 'E_INSTANCE_PORT_MISMATCH', projectDir: absDir, currentPort, requestedPort: port,
        });
      }
      inProcessServers.set(absDir, { kind: 'remote', url: record.url.replace(/\/$/, '') });
      const body = resolvedSourcePath
        ? await callServerJson(record.url, '/api/project/open', 'POST', { projectDir: absDir, sourcePath: resolvedSourcePath, name, domain })
        : live;
      return respond({ ...body, reusedInstance: true });
    }

    // 新工程：起独立实例。端口冲突由 server.start() 自动递增，天然得到并行端口。
    const { studio } = await startStudioServer({ projectDir: absDir, sourcePath: resolvedSourcePath, name, port: port ?? 4310, domain });
    inProcessServers.set(absDir, { kind: 'local', studio });
    return respond(studio.buildContextPayload(), { authoring: AUTHORING_ENTRY });
  },

  // ---- 写:唯一事务入口(HTTP /api/commands;as/$ref 步引用在 store 层解析) ----
  async studio_command(args = {}) {
    const rp1Source = args.rp1 !== undefined
      ? args.rp1
      : (args.sourceMode && args.commands === undefined && typeof args.source === 'string' ? args.source : undefined);
    if (rp1Source !== undefined && args.commands !== undefined) throw Object.assign(new Error('rp1 与 commands 必须二选一'), { code: 'E_RP1_INPUT' });
    const baseUrl = await resolveServerUrl(args);
    const body = await callServerJson(baseUrl, '/api/commands', 'POST', {
      clientId: args.clientId || 'mcp-ai',
      source: args.rp1 !== undefined || !args.sourceMode ? (args.source || 'mcp-ai') : 'mcp-ai',
      baseRevision: args.baseRevision,
      idempotencyKey: args.idempotencyKey,
      pageId: args.pageId || null,
      documentId: args.documentId || null,
      label: args.label || null,
      selectionId: args.selectionId,
      actor: args.actor || null,
      includeDoc: Boolean(args.includeDoc),
      includeScene: Boolean(args.includeScene),
      ...(rp1Source !== undefined ? { rp1: rp1Source, sourceMode: args.sourceMode, parentId: args.parentId, index: args.index } : { commands: args.commands || [] }),
      simulateCrashStage: args.simulateCrashStage || null,
    });
    // 默认紧凑 scene（AI 通道回包瘦身）：事务成功回包只保留受影响节点，未受影响页面只留索引。
    let projected = body;
    if (!args.includeScene && !args.verbose && body?.scene?.pages && Array.isArray(body.affectedNodeIds)) {
      const keep = new Set([...(body.affectedNodeIds || []), ...(body.directAffectedNodeIds || [])]);
      projected = {
        ...body,
        scene: {
          ...body.scene,
          pages: body.scene.pages.map(page => {
            const nodes = (page.nodes || []).filter(n => keep.has(`${page.id}/${n.id}`) || keep.has(n.id) || keep.has(n.scopedId));
            return {
              id: page.id,
              name: page.name,
              board: page.board,
              nodeCount: (page.nodes || []).length,
              ...(nodes.length ? { nodes } : {}),
            };
          }),
        },
        sceneFiltered: '默认只回受影响节点；需要全量请传 includeScene:true',
        truncations: [{ level: 1, dropped: 'scene.nodes of unaffected pages and nodes', how: 'pass includeScene:true or use studio_inspect view:nodes' }],
      };
    }
    if (!args.verbose && !args.includeDoc && !args.includeScene && projected.authoring?.sourceSpans) {
      const { sourceSpans, ...authoring } = projected.authoring;
      projected = { ...projected, authoring: { ...authoring, sourceSpanCount: sourceSpans.length,
        next: '源码定位仅在失败时默认展开；verbose:true可读取全部sourceSpans。' } };
    }
    return projectPayload(projected, {
      verbose: args.verbose,
      includeDoc: args.includeDoc,
      includeScene: args.includeScene,
      maxBytes: args.maxBytes,
      docStyle: 'stub',
    });
  },

  // ---- 读:节点查询 / 会话状态 / 组件契约 三视图合一 ----
  async studio_inspect(args = {}) {
    const view = args.view || 'nodes';
    if (view === 'context') {
      const baseUrl = await resolveServerUrl(args);
      const body = await callServerJson(baseUrl, '/api/context', 'GET');
      return {
        ...projectPayload(body, {
          verbose: args.verbose,
          includeDoc: args.includeDoc,
          includeScene: args.includeScene,
          maxBytes: args.maxBytes,
        }),
        openInstances: instanceSummary(),
        authoring: AUTHORING_ENTRY,
      };
    }
    if (view === 'contracts') {
      const baseUrl = await resolveServerUrl(args);
      return callServerJson(baseUrl, '/api/component-contracts', 'POST', {
        componentId: args.componentId || null,
      });
    }
    const baseUrl = await resolveServerUrl(args);
    const { view: mcpView, ...rest } = args;
    const httpView = mcpView === 'nodes' ? undefined : mcpView; // MCP 层 'nodes' → HTTP 默认 authoring
    return callServerJson(baseUrl, '/api/query', 'POST', { ...rest, ...(!httpView && !args.cursor ? { view: 'authoring' } : { view: httpView }) }, { readOnly: true });
  },

  // ---- 像素:截图(内部先等渲染确认,无需独立 wait 工具) ----
  async studio_screenshot(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/screenshot', 'POST', {
      revision: args.revision,
      pageId: args.pageId || null,
      nodeId: args.nodeId || null,
      panelStates: args.panelStates || null,
      outPath: args.outPath || null,
      includeImage: args.includeImage !== false,
      timeoutMs: args.timeoutMs ?? 5000,
      simulateHang: Boolean(args.simulateHang),
    });
  },

  // ---- 导出:原生 rp / 离线代码包 / 便携工程包 三出口合一 ----
  async studio_export(args = {}) {
    const format = args.format || null;
    if (args.async && args.verify) {
      return {
        ok: false,
        status: 'failed',
        diagnostics: [{
          code: 'E_VERIFY_ASYNC',
          message: 'verify:true 与 async:true 不能同时使用；请省略 async 或在导出完成后单独调用 verify_prototype。',
        }],
      };
    }
    const resolveRelativeToWork = !((args.url || args.port) && !args.cwd && !args.projectDir);
    const workDir = resolveWorkDir(args.cwd);
    const normalizedArgs = args.projectDir
      ? { ...args, projectDir: isAbsolute(args.projectDir) ? resolve(args.projectDir) : resolve(workDir, args.projectDir) }
      : args;
    const outputWorkDir = resolveWorkDir(args.cwd ?? normalizedArgs.projectDir);
    const resolveOut = p => {
      if (typeof p !== 'string' || !p.trim()) return p;
      if (isAbsolute(p)) return resolve(p);
      return resolveRelativeToWork ? resolve(outputWorkDir, p) : p;
    };
    const guardOut = p => {
      if (typeof p === 'string' && p.trim() && (isAbsolute(p) || resolveRelativeToWork)) assertWritable(p);
    };
    if (format === 'rp') {
      const baseUrl = await resolveServerUrl(normalizedArgs);
      const outRpPath = resolveOut(args.outRpPath || args.output || null);
      const outReportPath = resolveOut(args.outReportPath || null);
      guardOut(outRpPath);
      guardOut(outReportPath);
      const expRes = await callServerJson(baseUrl, '/api/export-rp', 'POST', {
        outRpPath,
        outReportPath,
        ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
        ...(args.async !== undefined ? { async: args.async, requestKey: args.requestKey } : {}),
      });
      if (!expRes?.ok || args.async || !expRes.outRpPath) {
        return expRes;
      }
      if (!args.verify) {
        return {
          ...expRes,
          nextActions: [
            { tool: 'verify_prototype', arguments: { rp: expRes.outRpPath } },
            { tool: 'export_prototype', arguments: { rp: expRes.outRpPath } },
          ],
        };
      }
      const bv = await verifyOfficialPreview({
        rp: expRes.outRpPath,
        cwd: outputWorkDir,
        engine: args.verifyEngine,
        steps: args.verifySteps,
        viewport: args.verifyViewport,
        virtualClock: args.virtualClock,
        includeStoryboard: args.includeStoryboard,
        includeImage: args.includeImage,
      }, { runWorkflow, exportHtml: exportPrototype });
      const { mcpImages: verifyImgs, ...bvSummary } = bv;
      const compactExp = args.verbose
        ? expRes
        : {
          ...expRes,
          ...(expRes.compatibilityReport && typeof expRes.compatibilityReport === 'object'
            ? {
              compatibilityReport: {
                ...Object.fromEntries(Object.entries(expRes.compatibilityReport).filter(([k]) => !['nodes', 'items'].includes(k))),
                truncatedDetails: true,
              },
            }
            : {}),
        };
      return {
        ...compactExp,
        status: bv.status === 'completed' ? 'completed' : 'failed',
        ok: Boolean(expRes.ok && bv.status === 'completed'),
        behaviorVerification: bvSummary,
        ...(bv.status !== 'completed' ? { diagnostics: bv.diagnostics } : {}),
        ...(verifyImgs?.length ? { mcpImages: verifyImgs } : {}),
      };
    }
    if (format === 'code') {
      const baseUrl = await resolveServerUrl(normalizedArgs);
      const outDir = resolveOut(args.outDir || args.output || null);
      guardOut(outDir);
      return callServerJson(baseUrl, '/api/export-code', 'POST', {
        outDir,
        ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
        ...(args.resetRegistration !== undefined ? { resetRegistration: args.resetRegistration } : {}),
        ...(args.async !== undefined ? { async: args.async, requestKey: args.requestKey } : {}),
      });
    }
    if (format === 'rp1') {
      const baseUrl = await resolveServerUrl(normalizedArgs);
      const outRp1Path = resolveOut(args.outRp1Path || args.output || null);
      guardOut(outRp1Path);
      return callServerJson(baseUrl, '/api/export-rp1', 'POST', {
        outRp1Path,
        ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
      });
    }
    if (format === 'bundle') {
      return studioHandlers._bundle({
        ...normalizedArgs,
        ...(args.outDir ? { outDir: resolveOut(args.outDir) } : {}),
        ...(args.bundleDir ? { bundleDir: resolveOut(args.bundleDir) } : {}),
        ...(args.targetProjectDir ? { targetProjectDir: resolveOut(args.targetProjectDir) } : {}),
      });
    }
    throw Object.assign(new Error(`format 需要 rp / code / bundle / rp1,收到 ${format}`), { code: 'E_EXPORT_FORMAT' });
  },

  // ---- 历史:撤销/重做/命名版本 一处管理 ----
  async studio_history(args = {}) {
    const action = args.action || null;
    if (action === 'undo') {
      const baseUrl = await resolveServerUrl(args);
      const body = await callServerJson(baseUrl, '/api/undo', 'POST', {
        clientId: args.clientId || 'mcp-ai',
        source: 'mcp-ai',
        expectedRevision: args.expectedRevision ?? null,
        expectedHeadTxId: args.expectedHeadTxId ?? null,
      });
      return projectPayload(body, { verbose: args.verbose, includeDoc: args.includeDoc, includeScene: args.includeScene, maxBytes: args.maxBytes });
    }
    if (action === 'redo') {
      const baseUrl = await resolveServerUrl(args);
      const body = await callServerJson(baseUrl, '/api/redo', 'POST', {
        clientId: args.clientId || 'mcp-ai',
        source: 'mcp-ai',
        expectedRevision: args.expectedRevision ?? null,
      });
      return projectPayload(body, { verbose: args.verbose, includeDoc: args.includeDoc, includeScene: args.includeScene, maxBytes: args.maxBytes });
    }
    if (['list', 'create', 'preview', 'restore'].includes(action)) {
      const body = await callServerJson(await resolveServerUrl(args), '/api/versions', 'POST', { ...args, action }, { readOnly: !action || ['list', 'preview'].includes(action) });
      if (body.diff) {
        const summary = value => { const raw = typeof value === 'string' ? value : JSON.stringify(value); return raw === undefined ? null : { preview: raw.slice(0, 160), length: raw.length, truncated: raw.length > 160 }; };
        const changes = body.diff.changes.slice(0, 12).map(({ before, after, ...change }) => ({ ...change, beforeSummary: summary(before), afterSummary: summary(after) }));
        body.diff = { ...body.diff, changes, returned: changes.length, truncated: body.diff.total > changes.length, valuesInline: false };
      }
      return projectPayload(body, {});
    }
    throw Object.assign(new Error(`action 需要 undo / redo / list / create / preview / restore,收到 ${action}`), { code: 'E_HISTORY_ACTION' });
  },

  // ---- 阶段上下文(创作主入口) ----
  async studio_stage(args = {}) {
    return callServerJson(await resolveServerUrl(args), '/api/design/context', 'POST', args, { readOnly: true });
  },

  // ---- 设计质量:度量/像素对比/锚点/内容脚手架/修复计划/探索/看图评审 一处管理 ----
  async studio_design(args = {}) {
    const action = args.action || 'metrics';
    const baseUrl = await resolveServerUrl(args);
    if (action === 'metrics') {
      return callServerJson(baseUrl, '/api/design/metrics', 'POST', {
        pageId: args.pageId || null,
        thresholds: args.thresholds || null,
        pixelTruth: args.pixelTruth,
      });
    }
    if (action === 'pixel_contrast') {
      return callServerJson(baseUrl, '/api/design/pixel-contrast', 'POST', {
        pageId: args.pageId || null,
        dpr: args.dpr ?? 2,
      });
    }
    if (action === 'anchors') {
      return callServerJson(baseUrl, '/api/design/anchors', 'POST', {
        action: args.anchorAction || 'list',
        pageId: args.pageId || null,
        pages: args.pages || null,
        mode: args.mode || 'append',
        includeBelowBar: Boolean(args.includeBelowBar),
        // approvedBy 如实记录调用方：MCP 通道默认 mcp-ai。
        approvedBy: args.approvedBy || 'mcp-ai',
      });
    }
    if (action === 'content_plan') {
      return callServerJson(baseUrl, '/api/design/content-plan', 'POST', { pageId: args.pageId || null });
    }
    if (action === 'fix_plan') {
      return callServerJson(baseUrl, '/api/design/fix-plan', 'POST', {
        pageId: args.pageId || null,
        ...(args.apply !== undefined ? { apply: Boolean(args.apply) } : {}),
        ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
        ...(args.clientId !== undefined ? { clientId: args.clientId } : {}),
        ...(args.label !== undefined ? { label: args.label } : {}),
      });
    }
    if (action === 'explore') {
      const wantStatesOnly = !args.candidates && Array.isArray(args.states) && args.states.length > 0;
      let resolvedBaseRev = args.baseRevision;
      if (wantStatesOnly && resolvedBaseRev === undefined) {
        const ctx = await callServerJson(baseUrl, '/api/context', 'GET', null, { readOnly: true });
        resolvedBaseRev = ctx?.appliedRevision ?? ctx?.doc?.revision ?? 1;
      }
      const candidatesPayload = args.candidates
        ? { candidates: args.candidates, baseRevision: args.baseRevision, states: args.states || [], preserve: args.preserve || {} }
        : wantStatesOnly
          ? { candidates: [{ id: 'current', label: '当前设计多态预演', commands: [] }], baseRevision: resolvedBaseRev, states: args.states, preserve: args.preserve || {} }
          : {};
      return callServerJson(baseUrl, '/api/design/explore', 'POST', {
        pageId: args.pageId || null,
        axes: args.axes || null,
        limit: args.limit || null,
        ...candidatesPayload,
        ...(args.async !== undefined ? { async: args.async, requestKey: args.requestKey, baseRevision: resolvedBaseRev } : {}),
      });
    }
    if (action === 'review') {
      const { verbose = false, ...request } = args;
      const result = await callServerJson(baseUrl, '/api/design/review', 'POST', request);
      if (verbose || !result.ok) return result;
      const { nodeSnapshots, designMetrics, ...compact } = result;
      return { ...compact, findings: (result.findings || []).slice(0, 24),
        detail: { view: 'summary', findingCount: result.findings?.length || 0, returnedFindings: Math.min(24, result.findings?.length || 0),
          reportPath: result.reportPath || null,
          next: 'verbose:true读取完整指标和节点快照；图片和具体问题默认保留。' } };
    }
    throw Object.assign(new Error(`action 需要 metrics / pixel_contrast / anchors / content_plan / fix_plan / explore / review,收到 ${action}`), { code: 'E_DESIGN_ACTION' });
  },

  // ---- 场景:交互剧本 / 12 模板验收 ----
  async studio_scenario(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    if (args.acceptance) {
      if (args.faultInjection) {
        return callServerJson(baseUrl, '/api/scenarios/fault-injection', 'POST', {
          domain: args.domain || null,
        });
      }
      return callServerJson(baseUrl, '/api/scenarios/run', 'POST', {
        domain: args.domain || null,
        scenarioIds: args.scenarioIds || null,
        category: args.category || null,
        impactReport: args.impactReport || null,
        runAll: Boolean(args.runAll),
        layers: args.layers || ['semantic'],
        screenshotDir: args.screenshotDir || null,
        exportDir: args.exportDir || null,
        axurePreviewUrl: args.axurePreviewUrl || null,
      });
    }
    const result = await callServerJson(baseUrl, '/api/runtime/scenario', 'POST', {
      startPageId: args.startPageId || null,
      reset: args.reset !== false,
      ...(args.hitTest !== undefined ? { hitTest: args.hitTest === true } : {}),
      steps: args.steps || [],
    });
    const executionLayer = args.hitTest ? 'studio-semantic+real-browser-pointer' : 'studio-semantic';
    if (args.verbose && result.finalState) {
      const fullPayload = { ...result, executionLayer };
      if (Buffer.byteLength(JSON.stringify(fullPayload), 'utf8') > 45000 && fullPayload.finalState?.activePageScene?.nodes) {
        const compactNodes = fullPayload.finalState.activePageScene.nodes.map(n => ({
          id: n.id,
          scopedId: n.scopedId,
          type: n.type,
          visible: n.visible,
          text: n.text,
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          ...(n.activeStateId ? { activeStateId: n.activeStateId } : {}),
        }));
        return {
          ...fullPayload,
          finalState: {
            ...fullPayload.finalState,
            activePageScene: {
              ...fullPayload.finalState.activePageScene,
              nodes: compactNodes,
            },
          },
          detail: {
            view: 'verbose-bounded',
            truncatedVerboseScene: true,
            note: '已按 45KB 预算精简 activePageScene 绘制字段，保留完整断言、变量、显隐、轨迹与几何。',
          },
        };
      }
      return fullPayload;
    }
    if (!result.finalState) return { ...result, executionLayer };
    const { activePageScene, trace, ...state } = result.finalState;
    return { ...result, executionLayer, finalState: state, detail: { view: 'summary', next: 'verbose:true读取完整场景和动作轨迹；默认保留每步断言与最终变量、面板、显隐状态。' } };
  },

  // ---- 素材 ----
  async studio_media(args = {}) {
    return callServerJson(await resolveServerUrl(args), '/api/media/prepare', 'POST', args);
  },

  // ---- 合并与原生回填 ----
  async studio_merge(args = {}) {
    const kind = args.kind || 'merge';
    if (kind === 'sync_native') {
      const baseUrl = await resolveServerUrl(args);
      return callServerJson(baseUrl, '/api/sync-native', 'POST', {
        rpPath: args.rpPath || args.rp || null,
        baseRpPath: args.baseRpPath || null,
        baselinePath: args.baselinePath || null,
        mode: args.mode || 'preview',
        prefer: args.prefer || 'fail',
        resolutions: args.resolutions || {},
        ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
        ...(args.previewHash !== undefined ? { previewHash: args.previewHash } : {}),
        ...(args.allowFormulaOverwrite !== undefined ? { allowFormulaOverwrite: args.allowFormulaOverwrite } : {}),
        ...(args.rebuildRp !== undefined ? { rebuildRp: args.rebuildRp } : {}),
        ...(args.outRpPath !== undefined ? { outRpPath: args.outRpPath } : {}),
        ...(args.async !== undefined ? { async: args.async, requestKey: args.requestKey } : {}),
      }, { readOnly: (args.mode || 'preview') === 'preview' && !args.async });
    }
    if (kind === 'merge') {
      const baseUrl = await resolveServerUrl(args);
      const body = await callServerJson(baseUrl, '/api/project/merge', 'POST', args, {
        readOnly: !args.mode || ['preview', 'check-external'].includes(args.mode),
      });
      return projectPayload(body, {
        verbose: args.verbose,
        includeDoc: args.includeDoc,
        includeScene: args.includeScene,
        maxBytes: args.maxBytes,
      });
    }
    throw Object.assign(new Error(`kind 需要 merge / sync_native,收到 ${kind}`), { code: 'E_MERGE_KIND' });
  },

  // ---- 便携工程包实现(studio_export format:bundle 的主体;保留本地回落) ----
  async _bundle(args = {}) {
    const action = args.action || 'report';
    if (action === 'verify' && !args.url && !args.port) {
      return verifyProjectBundle({ bundleDir: args.bundleDir || args.outDir });
    }
    if (action === 'import' && !args.url && !args.port) {
      const targetDir = args.targetProjectDir || args.projectDir;
      if (targetDir) {
        try {
          const baseUrl = await resolveServerUrl({ projectDir: targetDir });
          return callServerJson(baseUrl, '/api/project/bundle', 'POST', args, { readOnly: false });
        } catch {
          return importProjectBundle({
            bundleDir: args.bundleDir,
            targetProjectDir: targetDir,
            overwrite: Boolean(args.overwrite),
          });
        }
      }
    }
    try {
      const baseUrl = await resolveServerUrl(args);
      return await callServerJson(baseUrl, '/api/project/bundle', 'POST', args, {
        readOnly: ['report', 'verify', 'compare'].includes(action),
      });
    } catch (err) {
      if (args.projectDir && existsSync(join(resolve(args.projectDir), 'document.json'))) {
        const absProjectDir = resolve(args.projectDir);
        const doc = JSON.parse(readFileSync(join(absProjectDir, 'document.json'), 'utf8'));
        const metaPath = join(absProjectDir, 'project.json');
        const projectMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
        if (action === 'report') {
          return {
            ok: true,
            action: 'report',
            ...buildBundleCompatibilityReport(doc, { projectDir: absProjectDir, sourcePath: projectMeta.sourcePath || null }),
          };
        }
        if (action === 'export') {
          return exportProjectBundle({
            projectDir: absProjectDir,
            doc,
            projectMeta,
            outDir: args.outDir || args.bundleDir || join(absProjectDir, 'exports', `bundle-r${doc.revision || 1}`),
            includeVersions: args.includeVersions !== false,
            includeThumbnails: args.includeThumbnails !== false,
          });
        }
        if (action === 'compare') {
          return compareProjectWithBundle({
            doc,
            projectDir: absProjectDir,
            bundleDir: args.bundleDir,
          });
        }
      }
      throw err;
    }
  },

  // ---- 内部兼容别名(仅供既有测试/CLI 直调;MCP 工具面只含 studioTools 的 13 个) ----
  async studio_apply_commands(args = {}) { return studioHandlers.studio_command(args); },
  async studio_query_nodes(args = {}) { return studioHandlers.studio_inspect({ ...args, view: args.view || 'nodes' }); },
  async studio_get_context(args = {}) { return studioHandlers.studio_inspect({ ...args, view: 'context' }); },
  async studio_get_component_contracts(args = {}) { return studioHandlers.studio_inspect({ url: args.url, port: args.port, projectDir: args.projectDir, view: 'contracts', componentId: args.componentId }); },
  async studio_capture_screenshot(args = {}) { return studioHandlers.studio_screenshot(args); },
  async studio_undo(args = {}) { return studioHandlers.studio_history({ ...args, action: 'undo' }); },
  async studio_redo(args = {}) { return studioHandlers.studio_history({ ...args, action: 'redo' }); },
  async studio_project_versions(args = {}) { return studioHandlers.studio_history({ ...args, action: args.action || 'list' }); },
  async studio_get_design_context(args = {}) { return studioHandlers.studio_stage(args); },
  async studio_design_metrics(args = {}) { return studioHandlers.studio_design({ ...args, action: 'metrics' }); },
  async studio_design_pixel_contrast(args = {}) { return studioHandlers.studio_design({ ...args, action: 'pixel_contrast' }); },
  async studio_design_content_plan(args = {}) { return studioHandlers.studio_design({ ...args, action: 'content_plan' }); },
  async studio_design_fix_plan(args = {}) { return studioHandlers.studio_design({ ...args, action: 'fix_plan' }); },
  async studio_design_anchors(args = {}) { return studioHandlers.studio_design({ ...args, action: 'anchors', anchorAction: args.action || 'list', action: 'anchors' }); },
  async studio_design_explore(args = {}) { return studioHandlers.studio_design({ ...args, action: 'explore' }); },
  async studio_review_design(args = {}) { return studioHandlers.studio_design({ ...args, action: 'review' }); },
  async studio_run_scenario(args = {}) { return studioHandlers.studio_scenario(args); },
  async studio_run_acceptance_scenarios(args = {}) { return studioHandlers.studio_scenario({ ...args, acceptance: true }); },
  async studio_export_rp(args = {}) { return studioHandlers.studio_export({ ...args, format: 'rp' }); },
  async studio_export_code(args = {}) { return studioHandlers.studio_export({ ...args, format: 'code' }); },
  async studio_project_bundle(args = {}) { return studioHandlers.studio_export({ ...args, format: 'bundle' }); },
  async studio_sync_native(args = {}) { return studioHandlers.studio_merge({ ...args, kind: 'sync_native' }); },
  async studio_merge_document(args = {}) { return studioHandlers.studio_merge({ ...args, kind: 'merge' }); },
  async studio_prepare_media(args = {}) { return studioHandlers.studio_media(args); },
};

// ---------------------------------------------------------------------------
// MCP 工具面:13 个动词化工具(figcraft 式收敛)。旧 28 名不在本清单;
// studioHandlers 上的旧名键是内部兼容别名,不经 MCP 暴露。
// ---------------------------------------------------------------------------

const connectionProperties = { url: { type: 'string' }, port: { type: 'integer' }, projectDir: { type: 'string' } };
export const studioTools = [
  {
    name: 'studio_open_project',
    description: '打开或初始化自由画布工程目录(可选从 RP/1 JSON、.rp1 源码、内联 rp1 文本、存量 .rp 或 HTML/URL 导入),启动或复用本机单端口 Studio 服务并返回画布上下文和 studioRuntime 指纹状态。支持相对路径+cwd/本地工作目录。这是每个工程的第一步。',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1, description: '可选：解析相对 projectDir / sourcePath 时的本地工作目录。' },
        sourcePath: { type: 'string', description: '可选：.rp1 / .json / 存量 .rp / 本地 .html / URL（与 rp1 互斥）。' },
        rp1: { type: 'string', minLength: 1, description: '可选：直接内联 RP/1 源码文本初始化画布工程（无需先写文件，与 sourcePath 互斥）。' },
        name: { type: 'string' },
        domain: { type: 'string', enum: ['mobile', 'web'] },
        port: { type: 'integer', minimum: 0, maximum: 65535, description: '监听端口(1024–65535)，或传 0 由系统分配空闲端口；省略时默认从 4310 起自动寻找空闲端口' },
        url: { type: 'string' },
      },
      required: ['projectDir'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_open_project,
  },
  {
    name: 'studio_describe', readOnly: true,
    description: '按需发现AI创作流程、RP/1、命令schema与craft指导。topic:command用name或names;fields/operation/surface仅用于topic:node。节点用name+fields查询；源码许可与真实生效验证分开登记。无需打开工程。',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: ['workflow', 'rp1', 'command', 'node', 'design', 'craft'] }, name: { type: 'string' }, names: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } }, fields: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1 }, description: '仅用于 topic:"node"：指定要查询的属性名' }, operation: { enum: ['create', 'edit'], description: '仅用于 topic:"node"' }, surface: { enum: ['canvas', 'runtime', 'native', 'full-rp1'], description: '仅用于 topic:"node"' }, intent: { type: 'string', enum: ['editorial', 'task', 'learning'] }, platform: { type: 'string', enum: ['mobile', 'web'] }, guideId: { type: 'string' } }, additionalProperties: false },
    handler: studioHandlers.studio_describe,
  },
  {
    name: 'studio_command',
    description: '提交同一权威文档的原子修改(唯一写入口)。commands 或 rp1 片段二选一;rp1 需要 sourceMode:insert/update 和 pageId。批处理步引用:命令可带顶层 as:"名字" 命名本步产出,同事务后续命令任意字段写 {"$ref":"名字"} 引用该节点 scoped id(整批一个 undo 步)。强校验版本乐观锁、幂等键、WAL 与撤销;失败整批不写入并返回 E_* 信封。命令词表用 studio_describe(topic:"command") 发现。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        clientId: { type: 'string' },
        source: { type: 'string' },
        pageId: { type: 'string' },
        documentId: { type: 'string' },
        label: { type: 'string' },
        selectionId: { type: 'string', minLength: 1 },
        actor: { type: 'object' },
        baseRevision: { type: 'integer', minimum: 0 },
        idempotencyKey: { type: 'string', minLength: 1 },
        commands: { type: 'array', minItems: 1, items: { type: 'object', properties: { type: { type: 'string', enum: VALID_COMMAND_TYPES }, as: { type: 'string', description: '命名本步产出(scoped id),供后续步骤 {"$ref":名字} 引用' } }, required: ['type'] } },
        rp1: { type: 'string', minLength: 1, description: 'RP/1节点片段；用#id稳定命名，精确语法见studio_describe(topic:rp1)' },
        sourceMode: { type: 'string', enum: ['insert', 'update'] }, parentId: { type: 'string' }, index: { type: 'integer', minimum: 0 },
        verbose: { type: 'boolean' },
        includeDoc: { type: 'boolean' },
        includeScene: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 2048, maximum: 400000 },
      },
      required: ['baseRevision', 'idempotencyKey'],
      oneOf: [{ required: ['commands'], not: { required: ['rp1'] } }, { required: ['rp1', 'sourceMode', 'pageId'], not: { required: ['commands'] } }],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_command,
  },
  {
    name: 'studio_inspect', readOnly: true,
    description: '读取画布状态的三合一入口。view:nodes(默认)按语义/ID/区域查询真实节点,fields 精确取字段、cursor 续取,跨页重名与过期游标明确拒绝;view:context 读取会话状态(appliedRevision/durableRevision/contentHash/页面/组件/令牌/字体与恢复摘要);view:contracts 查询 6 个核心组件契约(参数/插槽/覆盖白名单/状态矩阵/调用示例)。改稿前先用 view:nodes 取可编辑源目标。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        view: { type: 'string', enum: ['nodes', 'authoring', 'full', 'context', 'contracts'], description: '默认 nodes；authoring 同 nodes；full 返回完整解算节点' },
        pageId: { type: 'string' },
        nodeId: { type: 'string' },
        type: { type: 'string' },
        textContains: { type: 'string' },
        nodeIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        role: { type: 'string' }, within: { type: 'string' },
        fields: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'nodes视图可选id/scopedId/pageId/name/type/role/text/textLength/textTruncated/visible/locked/bounds/editableTargetId/target/source/layoutContext/controls/suggestedEdit；几何用bounds' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 }, cursor: { type: 'string' },
        verbose: { type: 'boolean' }, includeDoc: { type: 'boolean' }, includeScene: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 2048, maximum: 400000 },
        componentId: { type: 'string', description: '仅 view:contracts' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_inspect,
  },
  {
    name: 'studio_screenshot', readOnly: true,
    description: '严格等待指定 revision 在真实浏览器完成布局、字体与图片渲染后截取画板或节点 PNG,返回 revision、contentHash 与文件 SHA-256。可选传 panelStates:{"panelId":"stateId"} 无副作用临时切换动态面板状态做多态视觉走查（不改源文档、不推进 revision）。"先 inspect 拿数字、再 screenshot 看像素"是标准验证流程。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
        pageId: { type: 'string' },
        nodeId: { type: 'string' },
        panelStates: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '临时覆盖动态面板激活状态（如 {"drawer_panel":"confirm"}），仅作用于本次截图渲染，不修改源文档也不递增 revision',
        },
        outPath: { type: 'string' },
        includeImage: { type: 'boolean', description: '默认 true，直接返回 MCP 图片供模型查看' },
        timeoutMs: { type: 'integer', minimum: 50 },
        simulateHang: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_screenshot,
  },
  {
    name: 'studio_export',
    description: '从当前权威快照导出产物（支持相对路径 + cwd）。format:rp——原生 .rp 与逐节点兼容报告（支持传 verify:true 一键行为验收）；format:rp1——反向导出可 diff/可继续编辑的 RP/1 .rp1 源码；format:code——独立可运行 HTML/CSS/JS 代码工程包；format:bundle——自包含可迁移工程包。async:true 加 requestKey 返回持久句柄。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        cwd: { type: 'string', minLength: 1, description: '可选：解析相对输出路径时的本地工作目录。' },
        format: { type: 'string', enum: ['rp', 'code', 'bundle', 'rp1'] },
        outRpPath: { type: 'string' },
        outRp1Path: { type: 'string', description: 'format:rp1 可选 .rp1 输出路径；省略时直接返回 rp1Text 文本' },
        output: { type: 'string', description: 'outRpPath（format:rp）、outRp1Path（format:rp1）或 outDir（format:code）的通用相对/绝对输出路径别名。' },
        outReportPath: { type: 'string' },
        outDir: { type: 'string' },
        resetRegistration: { type: 'boolean' },
        action: { type: 'string', enum: ['report', 'export', 'verify', 'import', 'compare'], description: '仅 format:bundle' },
        bundleDir: { type: 'string' },
        targetProjectDir: { type: 'string' },
        includeVersions: { type: 'boolean' },
        includeThumbnails: { type: 'boolean' },
        overwrite: { type: 'boolean' },
        verify: { type: 'boolean', description: '仅 format:rp；true 时导出后自动在无头 Chrome 中运行 verifySteps 行为断言（默认 auto 有本机 Axure 走官方导出，否则切 Studio 离线 HTML）。' },
        verifyEngine: { type: 'string', enum: ['auto', 'official', 'studio-html'], description: '配合 verify:true 使用：验证引擎（默认 auto）。' },
        verifySteps: { type: 'array', minItems: 0, maxItems: 60, items: verifyStepItemsSchema },
        verifyViewport: { type: 'object', properties: { width: { type: 'integer', minimum: 320, maximum: 3840 }, height: { type: 'integer', minimum: 320, maximum: 2160 }, dpr: { type: 'number', minimum: 1, maximum: 3 } }, additionalProperties: false },
        virtualClock: { type: 'boolean', description: '配合 verify:true 使用：加速 >=200ms 定时器。' },
        includeStoryboard: { type: 'boolean', description: '配合 verify:true 使用：在回包中附带关键帧时序拼图 PNG。' },
        includeImage: { type: 'boolean', description: '配合 verify:true 使用：在回包中附带最终 Chrome 截图 PNG。' },
        ...OPERATION_PROPERTIES,
      },
      required: ['format'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_export,
  },
  {
    name: 'studio_history',
    description: '画布历史管理:action:undo 撤销最近事务(expectedRevision/expectedHeadTxId 防回退他人修改);action:redo 重做;action:list/create/preview/restore 管理命名版本(restore 需当前 baseRevision、预览返回的 previewHash 与唯一 idempotencyKey,产生可撤销新事务)。保存包含设计决定、页面、组件、tokens、数据和资源引用。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        action: { type: 'string', enum: ['undo', 'redo', 'list', 'create', 'preview', 'restore'] },
        clientId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        expectedHeadTxId: { type: 'string', description: '仅 undo' },
        name: { type: 'string', minLength: 1, maxLength: 80, description: '仅 create' },
        versionId: { type: 'string', description: '仅 preview/restore' },
        baseRevision: { type: 'integer', minimum: 1 },
        previewHash: { type: 'string', description: '仅 restore' },
        idempotencyKey: { type: 'string', minLength: 1, description: '仅 create/restore' },
        verbose: { type: 'boolean' },
        includeDoc: { type: 'boolean' },
        includeScene: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 2048, maximum: 400000 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_history,
  },
  {
    name: 'studio_stage', readOnly: true,
    description: '按stage准备规划/骨架/内容/精修/检查/局部改稿上下文。局部改稿先studio_inspect(view:context)取版本,再传stage:edit、target.pageId/target.revision/nodeIds；返回可编辑源目标和设计决定。target是工程选区，referencePageId是参考页。',
    inputSchema: { type: 'object', properties: { ...connectionProperties,
      intent: { type: 'string', enum: ['editorial', 'task', 'learning'] }, platform: { type: 'string', enum: ['mobile', 'web'] },
      pageId: { type: 'string', description: '旧入口的栖羽参考页，非工程页；stage入口使用referencePageId与target.pageId' },
      stage: { type: 'string', enum: ['planning', 'skeleton', 'content', 'refine', 'review', 'edit'] },
      brief: { anyOf: [{ type: 'string' }, { type: 'object', properties: { task: { type: 'string' }, content: { type: 'array', items: { type: 'string' } }, states: { type: 'array', items: { type: 'string' } }, constraints: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }] },
      target: { type: 'object', properties: { selection: { enum: ['active'] }, clientId: { type: 'string' }, selectionId: { type: 'string' }, pageId: { type: 'string' }, documentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, contentHash: { type: 'string' }, nodeIds: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } }, role: { type: 'string' }, within: { type: 'string' }, textContains: { type: 'string' } }, oneOf: [{ required: ['pageId'], not: { required: ['selection'] } }, { required: ['selection'], not: { required: ['pageId'] } }], additionalProperties: false },
      referencePackId: { type: 'string' }, referencePageId: { type: 'string' }, includeSource: { type: 'boolean' },
      maxBytes: { type: 'integer', minimum: 4000, maximum: 48000, description: '文字JSON预算；图片字节数单独报告' },
      includeImages: { type: 'boolean' }, guideId: { type: 'string' }
    }, additionalProperties: false },
    handler: studioHandlers.studio_stage,
  },
  {
    name: 'studio_design',
    description: '设计质量层,action 词表分发:metrics——L1 视觉完成度代理指标(字阶/4px 栅格/留白/对比度/色相数)与反 slop 规则,阈值随 slopRules 返回,不返回审美总分;pixel_contrast——真实浏览器字形掩膜逐笔画对比度,描边/重叠/缺证据显式 unknown;anchors——把已认可页面提炼为排版配方锚点并对比偏离量(anchorAction:extract/approve/list/compare,语料是本地历史页面);content_plan——找出只有结构没有文案的槽位并给 applyWith 命令;fix_plan——把度量问题翻译成确定性修复命令(传 apply:true 且带 baseRevision 可单事务原子试跑校验并直接落盘);explore——批量设计变体按可复现判据收敛,或传 candidates/states 隔离预演 AI 自写构图,返回真实浏览器联系图;review——当前版本真实截图+机器检查,reviewId 提交 observations,compareWithReviewId 返回前后对照。评审不自评审美分、不代表用户验收。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        action: { type: 'string', enum: ['metrics', 'pixel_contrast', 'anchors', 'content_plan', 'fix_plan', 'explore', 'review'] },
        ...OPERATION_PROPERTIES,
        apply: { type: 'boolean', description: 'fix_plan: true 时在校验乐观锁与阻塞项严格减少后单事务原子提交修复命令' },
        idempotencyKey: { type: 'string', minLength: 1, description: 'fix_plan(apply:true) 幂等键' },
        clientId: { type: 'string', description: 'fix_plan(apply:true) 客户端标识' },
        label: { type: 'string', description: 'fix_plan(apply:true) 事务历史标签' },
        pageId: { type: 'string' },
        thresholds: { type: 'object' },
        pixelTruth: { type: 'boolean', description: 'metrics:默认真实浏览器像素测量;false 显式几何估算' },
        dpr: { type: 'number', minimum: 0.5, maximum: 4, description: 'pixel_contrast' },
        anchorAction: { type: 'string', enum: ['extract', 'approve', 'list', 'compare'], description: 'anchors 的子动作,默认 list' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'anchors' },
        includeBelowBar: { type: 'boolean', description: 'anchors' },
        pages: { type: 'array', items: { type: 'string' }, description: 'anchors' },
        approvedBy: { type: 'string', description: 'anchors:认可方标识,默认 mcp-ai;人工认可记 human' },
        limit: { type: 'integer', minimum: 2, maximum: 40, description: 'explore' },
        baseRevision: { type: 'integer', minimum: 1, description: 'explore/review' },
        candidates: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'commands'], properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, label: { type: 'string' }, commands: { type: 'array', minItems: 1, items: { type: 'object' } },
          designIntent: { type: 'object', additionalProperties: false, required: ['reason', 'tradeoff', 'axes'], properties: { reason: { type: 'string', minLength: 1, maxLength: 1000 }, tradeoff: { type: 'string', minLength: 1, maxLength: 1000 }, axes: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { enum: ['structure', 'reading-order', 'typography', 'density', 'imagery', 'interaction'] } } } },
        } }, description: 'explore' },
        states: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['id', 'steps'], properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, label: { type: 'string', maxLength: 120 }, steps: { type: 'array', minItems: 1, items: BROWSER_SCENARIO_STEP_SCHEMA },
        } }, description: 'explore：最多 6 项；可不传 candidates 单独传入，自动基于当前版本跑多态真机截图而不触发参数变体' },
        preserve: { type: 'object', additionalProperties: false, properties: { content: { type: 'boolean' }, interactions: { type: 'boolean' } }, description: 'explore' },
        axes: {
          type: 'object',
          properties: {
            density: { type: 'array', items: { type: 'string', enum: ['compact', 'normal', 'airy'] } },
            typeScale: { type: 'array', items: { type: 'string', enum: ['tight', 'normal', 'loose'] } },
            radius: { type: 'array', items: { type: 'string', enum: ['sharp', 'soft', 'round'] } },
            palette: { type: 'array', items: { type: 'string', enum: ['mono', 'warm', 'cool', 'ink'] } },
          },
          additionalProperties: false,
          description: 'explore',
        },
        reviewId: { type: 'string', description: 'review' },
        verbose: { type: 'boolean', description: 'review:返回完整指标和节点快照' },
        compareWithReviewId: { type: 'string', description: 'review:同页此前评审 ID,返回前后两张图与变更区域' },
        observations: { type: 'array', minItems: 1, items: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } }, issue: { type: 'string', minLength: 1, maxLength: 4000 }, consequence: { type: 'string', maxLength: 4000 }, decision: { type: 'string', maxLength: 4000 }, preserve: { type: 'string', maxLength: 4000 } }, required: ['nodeIds', 'issue'], additionalProperties: false }, description: 'review' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design,
  },
  {
    name: 'studio_scenario',
    description: '在隔离的交互运行态会话（StudioRuntimeSession）中执行业务交互剧本并断言变量、面板状态、文本、显隐与数据集，不污染设计态文档。action:"expect" 与 action:"assert" 语义完全等价（均需传 expect 对象）；click/input 等步骤也可直接带 expect。expect.text 支持精确全文或 {includes:"子串"}（兼容 {contains:"子串"}），且仅读取文本节点自身文字，容器不聚合子节点文字；写错不存在的 nodeId 会附带相近 ID 提示或 W_ASSERT_UNKNOWN_TARGET 告警。默认走语义执行层，不做遮挡/hitTest校验：click只要求目标在当前运行态可见，通过≠真实可点。hitTest:true 先用真实浏览器指针重放校验每个点击/输入与跨页跳转（支持宽屏桌面画板自动避让编辑器浮层、click 触发 link 跨页与显式 navigate 步骤；遮挡/命中按真实DOM结论），被遮挡返回E_SCENARIO_OCCLUDED（含nodeId/occludedBy遮挡者/stepIndex，语义层不执行该步）；真实浏览器不可用返回E_SCENARIO_HITTEST_UNAVAILABLE（不静默降级）；含dataset等浏览器层无法重放的步骤返回E_SCENARIO_HITTEST_UNSUPPORTED。步骤示例：{action:"click",target:"reveal",expect:{visible:{answer:true},text:{feedback:{includes:"再练"}}}}；未知步骤或零断言会拒绝。acceptance:true 改为执行12个语义验收模板（faultInjection:true 跑故障注入对照）；无操作脚本或不支持的断言返回unsupported，不记为通过。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        acceptance: { type: 'boolean', description: 'true 切换为验收模板执行' },
        startPageId: { type: 'string' },
        verbose: { type: 'boolean', description: 'true返回完整运行场景与轨迹' },
        reset: { type: 'boolean' },
        hitTest: { type: 'boolean', description: '真实浏览器指针校验,被遮挡返回 E_SCENARIO_OCCLUDED' },
        steps: { type: 'array', minItems: 1, items: SCENARIO_STEP_SCHEMA },
        domain: { type: 'string', description: 'acceptance' },
        scenarioIds: { type: 'array', items: { type: 'string' }, description: 'acceptance' },
        category: { type: 'string', description: 'acceptance' },
        impactReport: { type: 'object', description: 'acceptance' },
        runAll: { type: 'boolean', description: 'acceptance' },
        layers: { type: 'array', items: { type: 'string' }, description: 'acceptance' },
        axurePreviewUrl: { type: 'string', description: 'acceptance:可选真实 Axure 预览地址' },
        faultInjection: { type: 'boolean', description: 'acceptance:故障注入对照' },
        screenshotDir: { type: 'string' },
        exportDir: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_scenario,
  },
  {
    name: 'studio_media',
    description: '从原图按焦点/保护主体/比例/底色令牌生成可重放的摄影素材，返回带 SHA 的资源登记命令，不自动改画布。将 registerCommand 和图片节点修改用 studio_command 原子提交，支持一起撤销。需要 Python Pillow。',
    inputSchema: { type: 'object', properties: { ...connectionProperties, ...OPERATION_PROPERTIES, sourcePath: { type: 'string', minLength: 1 }, credit: { type: 'string' }, crops: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', properties: { name: { type: 'string' }, w: { type: 'integer', minimum: 1, maximum: 4096 }, h: { type: 'integer', minimum: 1, maximum: 4096 }, fx: { type: 'number', minimum: 0, maximum: 1 }, fy: { type: 'number', minimum: 0, maximum: 1 }, fh: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, scale: { type: 'integer', enum: [1, 2, 3] }, fadeFrom: { type: 'number', minimum: 0 }, fadeToToken: { type: 'string', description: 'colors 令牌的裸名（如 bg，不是 colors.bg）；令牌缺失或非六位颜色时降级为 W_MEDIA_TOKEN_STALE 警告并回落 #FFFFFF' }, protectedRegion: { type: 'object', description: '保护主体在原图中的归一化区域：0–1 相对原图宽高，不是像素坐标', properties: { x: { type: 'number', description: '归一化 0–1，相对原图宽' }, y: { type: 'number', description: '归一化 0–1，相对原图高' }, w: { type: 'number', description: '归一化 0–1，相对原图宽，需 x+w≤1' }, h: { type: 'number', description: '归一化 0–1，相对原图高，需 y+h≤1' } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false } }, required: ['w', 'h'], additionalProperties: false,
    } } }, required: ['sourcePath', 'crops'], additionalProperties: false },
    handler: studioHandlers.studio_media,
  },
  {
    name: 'studio_merge',
    description: '并发编辑整合。kind:merge(默认)——对同一工程执行人类/AI并发编辑或外部 JSON/RP1 文件的三方结构化合并(mode:preview/apply/check-external),自动合并无关修改,显式报出同字段/删改/跨容器重挂/布局耦合/实例覆盖冲突,支持逐项裁决并写入单步可撤销事务;kind:sync_native——将原生 .rp 手工修改经基线符号与 GUID 映射收敛回 Studio 源文档(mode:preview/apply),覆盖普通节点、宏参数、实例覆盖、面板状态、中继器模板(默认保护 =item.xxx 公式)与多页冲突裁决。',
    inputSchema: {
      type: 'object',
      properties: {
        ...connectionProperties,
        kind: { type: 'string', enum: ['merge', 'sync_native'] },
        ...OPERATION_PROPERTIES,
        mode: { type: 'string', enum: ['preview', 'apply', 'check-external'], description: 'merge:三方合并模式;sync_native:preview/apply' },
        baseRevision: { type: 'integer', minimum: 1 },
        baseVersionId: { type: 'string' },
        baseDoc: { type: 'object' },
        oursDoc: { type: 'object' },
        theirsDoc: { type: 'object' },
        theirsCommands: { type: 'array', items: { type: 'object' } },
        theirsRp1: { type: 'string' },
        theirsPageId: { type: 'string' },
        theirsSourceMode: { type: 'string', enum: ['insert', 'update', 'replace-children'] },
        theirsParentId: { type: 'string' },
        externalSourcePath: { type: 'string' },
        prefer: { type: 'string', enum: ['fail', 'ours', 'theirs', 'studio', 'native'] },
        resolutions: { type: 'object', additionalProperties: { type: 'string', enum: ['ours', 'theirs', 'studio', 'native'] } },
        idempotencyKey: { type: 'string', minLength: 1 },
        previewHash: { type: 'string', minLength: 1 },
        rpPath: { type: 'string', minLength: 1, description: 'sync_native' },
        baseRpPath: { type: 'string', description: 'sync_native' },
        baselinePath: { type: 'string', description: 'sync_native' },
        allowFormulaOverwrite: { type: 'boolean', description: 'sync_native' },
        rebuildRp: { type: 'boolean', description: 'sync_native' },
        outRpPath: { type: 'string', description: 'sync_native' },
        clientId: { type: 'string' },
        actor: { type: 'object' },
        label: { type: 'string' },
        verbose: { type: 'boolean' },
        includeDoc: { type: 'boolean' },
        includeScene: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 2048, maximum: 400000 },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_merge,
  },
  {
    name: 'studio_operations',
    description: '按工程持久查询、列出或取消长操作。可按id或原requestKey核对，MCP断连/服务重开不重做。cancel分别返回请求确认与实际停止；includeResult读取完成结果，过期结果移除提交建议。',
    inputSchema: { type: 'object', properties: { ...connectionProperties, action: { enum: ['get', 'list', 'cancel'] }, id: { type: 'string' }, requestKey: { type: 'string', minLength: 1, maxLength: 200 }, includeResult: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
    handler: studioHandlers.studio_operations,
  },
];

export async function runStudioFixPlanOnRp1({ rp1 = null, sourcePath = null, projectDir, pageId = null } = {}) {
  mkdirSync(projectDir, { recursive: true });
  const { studio, info } = await startStudioServer({
    projectDir,
    ...(rp1 ? { rp1 } : { sourcePath }),
    port: 0,
  });
  try {
    const baseUrl = (info?.url || `http://127.0.0.1:${studio.port}`).replace(/\/$/, '');
    const ctx = await callServerJson(baseUrl, '/api/context', 'GET', null, { readOnly: true });
    const baseRevision = ctx?.appliedRevision ?? ctx?.doc?.revision ?? 1;
    const targetPageId = pageId || ctx?.doc?.pages?.[0]?.id || 'home';
    const fixRes = await callServerJson(baseUrl, '/api/design/fix-plan', 'POST', {
      pageId: targetPageId,
      apply: true,
      baseRevision,
      idempotencyKey: `img-autofix-${baseRevision}`,
      label: 'generate_from_image autoFix',
    });
    let rp1Text = null;
    if (fixRes?.applied && Number(fixRes?.appliedCount) > 0) {
      const expRes = await callServerJson(baseUrl, '/api/export-rp1', 'POST', {});
      if (expRes?.ok && typeof expRes.rp1Text === 'string') {
        rp1Text = expRes.rp1Text;
      }
    }
    return {
      ok: Boolean(fixRes?.ok),
      attempted: true,
      applied: Boolean(fixRes?.applied),
      appliedCount: Number(fixRes?.appliedCount ?? 0),
      skippedEmpty: Boolean(fixRes?.skippedEmpty),
      beforeBlockers: fixRes?.before?.blockerCount ?? null,
      afterBlockers: fixRes?.actualAfter?.blockerCount ?? fixRes?.after?.blockerCount ?? null,
      remainingManualCount: fixRes?.manualActions?.length ?? 0,
      rp1Text,
    };
  } finally {
    try { await studio.close(); } catch {}
  }
}

export async function closeInProcessStudioServer() {
  for (const entry of inProcessServers.values()) {
    if (entry?.kind === 'local' && entry.studio) {
      try { await entry.studio.close(); } catch {}
    }
  }
  inProcessServers.clear();
  lastActiveProjectDir = null;
}
