import { SCENARIO_STEP_SCHEMA } from './runtime.mjs';
import { BROWSER_SCENARIO_STEP_SCHEMA } from './scenario-executors.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startStudioServer } from './server.mjs';
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

const INSTANCE_REGISTRY_PATH = '/tmp/zee-rp-studio-instances.json';
/** projectDir(绝对路径) -> { kind: 'local', studio } | { kind: 'remote', url } */
const inProcessServers = new Map();

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
    if (expectedProjectDir && body.projectDir && resolve(body.projectDir) !== resolve(expectedProjectDir)) return null;
    return body;
  } catch {
    return null;
  }
}

async function resolveServerUrl({ url = null, port = null, projectDir = null } = {}) {
  if (url) return url.replace(/\/$/, '');
  if (port) return `http://127.0.0.1:${port}`;
  if (projectDir) {
    const known = inProcessServers.get(resolve(projectDir));
    if (known) return known.kind === 'local' ? known.studio.url : known.url;
  }
  if (inProcessServers.size === 1 && !projectDir) {
    const only = [...inProcessServers.values()][0];
    return only.kind === 'local' ? only.studio.url : only.url;
  }

  if (projectDir) {
    const rec = instanceRecordFor(projectDir);
    if (rec && (await probeInstance(rec, projectDir))) return rec.url.replace(/\/$/, '');
  }

  if (existsSync(INSTANCE_REGISTRY_PATH)) {
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
    note: '事务默认不重复回传文档；受影响节点见 scene/affectedNodeIds，完整文档传 includeDoc:true 或调用 studio_get_context',
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
    out.truncations.push({ level: 2, dropped: 'all scene.nodes', how: 'use studio_query_nodes for details' });
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

export const studioHandlers = {
  async studio_operations(args={}){
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
  async studio_get_design_context(args = {}) {
    return callServerJson(await resolveServerUrl(args), '/api/design/context', 'POST', args, { readOnly: true });
  },
  async studio_design_metrics(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/metrics', 'POST', {
      pageId: args.pageId || null,
      thresholds: args.thresholds || null,
      pixelTruth: args.pixelTruth,
    });
  },
  async studio_design_pixel_contrast(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/pixel-contrast', 'POST', {
      pageId: args.pageId || null,
      dpr: args.dpr ?? 2,
    });
  },
  async studio_design_content_plan(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/content-plan', 'POST', { pageId: args.pageId || null });
  },
  async studio_design_fix_plan(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/fix-plan', 'POST', { pageId: args.pageId || null });
  },
  async studio_design_anchors(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/anchors', 'POST', {
      action: args.action || 'list',
      pageId: args.pageId || null,
      pages: args.pages || null,
      mode: args.mode || 'append',
      includeBelowBar: Boolean(args.includeBelowBar),
      // approvedBy 如实记录调用方：MCP 通道默认 mcp-ai，与 apply_commands 的 clientId 口径一致。
      approvedBy: args.approvedBy || 'mcp-ai',
    });
  },
  async studio_design_explore(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/explore', 'POST', {
      pageId: args.pageId || null,
      axes: args.axes || null,
      limit: args.limit || null,
      ...(args.candidates ? { candidates: args.candidates, baseRevision: args.baseRevision, states: args.states || [], preserve: args.preserve || {} } : {}),
      ...(args.async!==undefined?{async:args.async,requestKey:args.requestKey,baseRevision:args.baseRevision}:{}),
    });
  },
  async studio_prepare_media(args = {}) {
    return callServerJson(await resolveServerUrl(args), '/api/media/prepare', 'POST', args);
  },
  async studio_review_design(args = {}) {
    const { verbose = false, ...request } = args;
    const result = await callServerJson(await resolveServerUrl(args), '/api/design/review', 'POST', request);
    if (verbose || !result.ok) return result;
    const { nodeSnapshots, designMetrics, ...compact } = result;
    return { ...compact, findings: (result.findings || []).slice(0, 24),
      detail: { view: 'summary', findingCount: result.findings?.length || 0, returnedFindings: Math.min(24, result.findings?.length || 0),
        reportPath: result.reportPath || null,
        next: 'verbose:true读取完整指标和节点快照；图片和具体问题默认保留。' } };

  },
  async studio_open_project({
    projectDir,
    sourcePath = null,
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
    const absDir = resolve(projectDir);
    if (url) {
      const body = await callServerJson(url.replace(/\/$/, ''), '/api/project/open', 'POST', {
        projectDir: absDir,
        sourcePath,
        name,
        domain,
      });
      return { ...projectPayload(body, { verbose, includeDoc, includeScene, maxBytes }), openInstances: instanceSummary() };
    }

    // 同一工程：已有本地实例就直接复用，避免重复加载与画面重置。
    const known = inProcessServers.get(absDir);
    if (known?.kind === 'local') {
      if (port !== null && known.studio.port !== port) {
        throw Object.assign(new Error(`工程已在端口 ${known.studio.port} 运行；显式请求端口 ${port} 不会热迁移实例，请继续使用当前端口或换一个新的 projectDir`), {
          code: 'E_INSTANCE_PORT_MISMATCH', projectDir: absDir, currentPort: known.studio.port, requestedPort: port,
        });
      }
      const body = sourcePath
        ? known.studio.openProject({ projectDir: absDir, sourcePath, name, domain })
        : known.studio.buildContextPayload();
      return { ...projectPayload(body, { verbose, includeDoc, includeScene, maxBytes }), openInstances: instanceSummary() };
    }
    if (known?.kind === 'remote') {
      try {
        const body = await callServerJson(known.url, '/api/context', 'GET');
        return { ...projectPayload(body, { verbose, includeDoc, includeScene, maxBytes }), openInstances: instanceSummary() };
      } catch {
        inProcessServers.delete(absDir);
      }
    }

    // 不同工程：先看是否已有别的进程在该目录上跑着（跨进程复用，防止双写）。
    const rec = instanceRecordFor(absDir);
    if (rec) {
      if (port !== null && rec.port !== port) {
        throw Object.assign(new Error(`工程已在端口 ${rec.port} 运行；显式请求端口 ${port} 不会热迁移实例，请继续使用当前端口或换一个新的 projectDir`), {
          code: 'E_INSTANCE_PORT_MISMATCH', projectDir: absDir, currentPort: rec.port, requestedPort: port,
        });
      }
      const live = await probeInstance(rec, absDir);
      if (live) {
        inProcessServers.set(absDir, { kind: 'remote', url: rec.url.replace(/\/$/, '') });
        return {
          ...projectPayload({ ...live, reusedInstance: true }, { verbose, includeDoc, includeScene, maxBytes }),
          openInstances: instanceSummary(),
        };
      }
    }

    // 新工程：起独立实例。端口冲突由 server.start() 自动递增，天然得到并行端口。
    const { studio } = await startStudioServer({ projectDir: absDir, sourcePath, name, port: port ?? 4310, domain });
    inProcessServers.set(absDir, { kind: 'local', studio });
    return {
      ...projectPayload(studio.buildContextPayload(), { verbose, includeDoc, includeScene, maxBytes }),
      authoring: AUTHORING_ENTRY,
      openInstances: instanceSummary(),
    };
  },

  async studio_project_versions(args = {}) {
    const body=await callServerJson(await resolveServerUrl(args),'/api/versions','POST',args,{readOnly:!args.action||['list','preview'].includes(args.action)});
    if(body.diff){const summary=value=>{const raw=typeof value==='string'?value:JSON.stringify(value);return raw===undefined?null:{preview:raw.slice(0,160),length:raw.length,truncated:raw.length>160};};const changes=body.diff.changes.slice(0,12).map(({before,after,...change})=>({...change,beforeSummary:summary(before),afterSummary:summary(after)}));body.diff={...body.diff,changes,returned:changes.length,truncated:body.diff.total>changes.length,valuesInline:false};}
    return projectPayload(body,{});
  },

  async studio_project_bundle(args = {}) {
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

  async studio_merge_document(args = {}) {
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
  },

  async studio_get_context(args = {}) {
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
  },

  async studio_query_nodes(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/query', 'POST', { ...args, ...(!args.view && !args.cursor ? { view: 'authoring' } : {}) }, { readOnly: true });
  },

  async studio_apply_commands(args = {}) {
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
    // 默认紧凑 scene（AI 通道回包瘦身）：事务成功回包只保留受影响节点（affectedNodeIds 含
    // 传递影响，directAffectedNodeIds 为直接目标），未受影响页面只留 id/name/board/nodeCount 索引。
    // 降级动作显式记入 truncations（与 enforceBudget 同一约定，不静默截断）；全量 scene 仍由
    // includeScene:true / verbose:true 显式索取。服务端未上报受影响清单时保持原样，不猜。
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
        truncations: [{ level: 1, dropped: 'scene.nodes of unaffected pages and nodes', how: 'pass includeScene:true or use studio_query_nodes' }],
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

  async studio_wait_for_render(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/wait-render', 'POST', {
      revision: args.revision,
      timeoutMs: args.timeoutMs ?? 4000,
      simulateHang: Boolean(args.simulateHang),
    });
  },

  async studio_capture_screenshot(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/screenshot', 'POST', {
      revision: args.revision,
      pageId: args.pageId || null,
      nodeId: args.nodeId || null,
      outPath: args.outPath || null,
      includeImage: args.includeImage !== false,
      timeoutMs: args.timeoutMs ?? 5000,
      simulateHang: Boolean(args.simulateHang),
    });
  },

  async studio_undo(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    const body = await callServerJson(baseUrl, '/api/undo', 'POST', {
      clientId: args.clientId || 'mcp-ai',
      source: 'mcp-ai',
      expectedRevision: args.expectedRevision ?? null,
      expectedHeadTxId: args.expectedHeadTxId ?? null,
    });
    return projectPayload(body, { verbose: args.verbose, includeDoc: args.includeDoc, includeScene: args.includeScene, maxBytes: args.maxBytes });
  },

  async studio_redo(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    const body = await callServerJson(baseUrl, '/api/redo', 'POST', {
      clientId: args.clientId || 'mcp-ai',
      source: 'mcp-ai',
      expectedRevision: args.expectedRevision ?? null,
    });
    return projectPayload(body, { verbose: args.verbose, includeDoc: args.includeDoc, includeScene: args.includeScene, maxBytes: args.maxBytes });
  },

  async studio_run_scenario(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    const result = await callServerJson(baseUrl, '/api/runtime/scenario', 'POST', {
      startPageId: args.startPageId || null,
      reset: args.reset !== false,
      ...(args.hitTest !== undefined ? { hitTest: args.hitTest === true } : {}),
      steps: args.steps || [],
    });
    const executionLayer = args.hitTest ? 'studio-semantic+real-browser-pointer' : 'studio-semantic';
    if (args.verbose || !result.finalState) return { ...result, executionLayer };
    const { activePageScene, trace, ...state } = result.finalState;
    return { ...result, executionLayer, finalState: state, detail: { view: 'summary', next: 'verbose:true读取完整场景和动作轨迹；默认保留每步断言与最终变量、面板、显隐状态。' } };
  },

  async studio_export_rp(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/export-rp', 'POST', {
      outRpPath: args.outRpPath || args.output || null,
      outReportPath: args.outReportPath || null,
      ...(args.baseRevision!==undefined?{baseRevision:args.baseRevision}:{}),
      ...(args.async!==undefined?{async:args.async,requestKey:args.requestKey}:{}),
    });
  },

  async studio_export_code(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/export-code', 'POST', {
      outDir: args.outDir || args.output || null,
      ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
      ...(args.resetRegistration !== undefined ? { resetRegistration: args.resetRegistration } : {}),
      ...(args.async !== undefined ? { async: args.async, requestKey: args.requestKey } : {}),
    });
  },

  async studio_sync_native(args = {}) {
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
  },

  async studio_get_component_contracts(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/component-contracts', 'POST', {
      componentId: args.componentId || null,
    });
  },

  async studio_run_acceptance_scenarios(args = {}) {
    const baseUrl = await resolveServerUrl(args);
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
  },
};

const connectionProperties = { url: { type: 'string' }, port: { type: 'integer' }, projectDir: { type: 'string' } };
export const studioTools = [
  {name:'studio_operations',description:'按工程持久查询、列出或取消长操作。可按id或原requestKey核对，MCP断连/服务重开不重做。cancel分别返回请求确认与实际停止；includeResult读取完成结果，过期结果移除提交建议。',inputSchema:{type:'object',properties:{...connectionProperties,action:{enum:['get','list','cancel']},id:{type:'string'},requestKey:{type:'string',minLength:1,maxLength:200},includeResult:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false},handler:studioHandlers.studio_operations},
  {
    name:'studio_project_versions',
    description:'命名保存、列出和预览工程版本；恢复需当前baseRevision、预览返回的previewHash及唯一idempotencyKey，产生可撤销新事务。保存包含设计决定、页面、组件、tokens、数据和资源引用。',
    inputSchema:{type:'object',properties:{...connectionProperties,action:{enum:['list','create','preview','restore']},name:{type:'string',minLength:1,maxLength:80},versionId:{type:'string'},baseRevision:{type:'integer',minimum:1},previewHash:{type:'string'},idempotencyKey:{type:'string',minLength:1}},additionalProperties:false},
    handler:async(args={})=>studioHandlers.studio_project_versions(args),
  },
  {
    name: 'studio_describe', readOnly: true,
    description: '按需发现AI创作流程、RP/1、命令schema与craft指导。topic:command用name或names；fields/operation/surface仅用于topic:node。节点用name+fields查询；源码许可与真实生效验证分开登记。无需打开工程。',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: ['workflow', 'rp1', 'command', 'node', 'design', 'craft'] }, name: { type: 'string' }, names: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } }, fields:{type:'array',minItems:1,maxItems:16,items:{type:'string',minLength:1}},operation:{enum:['create','edit']},surface:{enum:['canvas','runtime','native','full-rp1']},intent: { type: 'string', enum: ['editorial', 'task', 'learning'] }, platform: { type: 'string', enum: ['mobile', 'web'] }, guideId: { type: 'string' } }, additionalProperties: false },
    handler: studioHandlers.studio_describe,
  },
  {
    name: 'studio_get_design_context',
    description: '按stage准备规划/骨架/内容/精修/检查/局部改稿上下文。局部改稿先get_context取版本，再传stage:edit、target.pageId/target.revision/nodeIds；返回可编辑源目标和设计决定。target是工程选区，referencePageId是参考页。',
    readOnly: true,
    inputSchema: { type: 'object', properties: { ...connectionProperties,
      intent: { type: 'string', enum: ['editorial', 'task', 'learning'] }, platform: { type: 'string', enum: ['mobile', 'web'] },
      pageId: { type: 'string', description: '旧入口的栖羽参考页，非工程页；stage入口使用referencePageId与target.pageId' },
      stage: {type:'string',enum:['planning','skeleton','content','refine','review','edit']},
      brief: {anyOf:[{type:'string'}, {type:'object',properties:{task:{type:'string'},content:{type:'array',items:{type:'string'}},states:{type:'array',items:{type:'string'}},constraints:{type:'array',items:{type:'string'}}},additionalProperties:false}]},
      target: {type:'object',properties:{selection:{enum:['active']},clientId:{type:'string'},selectionId:{type:'string'},pageId:{type:'string'},documentId:{type:'string'},revision:{type:'integer',minimum:1},contentHash:{type:'string'},nodeIds:{type:'array',minItems:1,maxItems:32,items:{type:'string'}},role:{type:'string'},within:{type:'string'},textContains:{type:'string'}},oneOf:[{required:['pageId'],not:{required:['selection']}},{required:['selection'],not:{required:['pageId']}}],additionalProperties:false},
      referencePackId:{type:'string'},referencePageId:{type:'string'},includeSource:{type:'boolean'},
      maxBytes:{type:'integer',minimum:4000,maximum:48000,description:'文字JSON预算；图片字节数单独报告'},
      includeImages: { type: 'boolean' }, guideId: { type: 'string' }
    }, additionalProperties: false },
    handler: studioHandlers.studio_get_design_context,
  },
  {
    name: 'studio_design_metrics',
    description: '计算页面的 L1 视觉完成度代理指标（字阶比、4px 栅格一致性、留白占比、文本对比度、主色相数）与反 AI-slop 负样本规则（等距三卡、紫渐变、空洞居中标题、图标圆角方块、首屏无素材、圆角过度）。每条 slop 规则的触发阈值随结果 slopRules 返回——未命中可能只是样本低于阈值，不代表规则失效。不返回审美总分：只给可复现的结构判断与具体改法。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
        thresholds: { type: 'object' },
        pixelTruth: { type: 'boolean', description: '默认真实浏览器像素测量；false 显式使用几何估算。失败回落时标注原因。' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_metrics,
  },
  {
    name: 'studio_design_pixel_contrast',
    description: '像素对比度：用真实浏览器原图、隐藏字形底图和字形掩膜，逐笔画测量对比度；支持非整数DPR。描边、重叠文本和缺失证据显式unknown且不通过。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
        dpr: { type: 'number', minimum: 0.5, maximum: 4 },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_pixel_contrast,
  },
  {
    name: 'studio_design_content_plan',
    description: '内容脚手架：找出"只有结构没有文案"的位置（空态、口号式大标题），给出需要的槽位、可套用模板与示例，以及一条可直接提交的 applyWith 命令。它不假装会写好文案——只把"该说清什么"变成可填的空。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_content_plan,
  },
  {
    name: 'studio_design_fix_plan',
    description: '把度量发现的问题翻译成可直接提交的命令：栅格位置吸附、热区补足、为未绑定的列表补空态、把被撑高的文字框回缩。只开确定性处方（可计算、无需品味判断），不自动提交；字阶/配色/构图等取舍类问题交给 studio_design_explore 与锚点对比。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_fix_plan,
  },
  {
    name: 'studio_design_anchors',
    description: '把项目里已认可的页面提炼成"排版配方"锚点（字阶/栅格/留白/色相/主次比），并让其它页面与锚点比对给出偏离量。语料是本地历史页面而不是互联网美图：这才是这个产品自己的参照系。action=extract 写入设计锚点文件，list 读取，compare 对比某页。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        action: { type: 'string', enum: ['extract', 'approve', 'list', 'compare'] },
        mode: { type: 'string', enum: ['append', 'replace'] },
        includeBelowBar: { type: 'boolean' },
        pageId: { type: 'string' },
        pages: { type: 'array', items: { type: 'string' } },
        approvedBy: { type: 'string', description: '认可方标识，默认 mcp-ai；人工在界面上认可时记 human' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_anchors,
  },
  {
    name: 'studio_design_explore',
    description: '批量生成设计变体并按可复现判据自动收敛：在密度/字阶/圆角/配色四条轴上展开组合，对每个变体计算同一套 L1 指标与反 slop 规则，按「未达标项 → 硬伤 → 提示 → 改动量」排序，返回入选变体可直接提交的 commands。也可传 candidates/baseRevision/states，隔离预演 AI 自写的任意构图命令，返回真实浏览器多状态联系图，默认保留内容和交互。不改源文档，不自动代选审美。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
        limit: { type: 'integer', minimum: 2, maximum: 40 },
        ...OPERATION_PROPERTIES,
        baseRevision: { type: 'integer', minimum: 1 },
        candidates: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'commands'], properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, label: { type: 'string' }, commands: { type: 'array', minItems: 1, items: { type: 'object' } },
          designIntent:{type:'object',additionalProperties:false,required:['reason','tradeoff','axes'],properties:{reason:{type:'string',minLength:1,maxLength:1000},tradeoff:{type:'string',minLength:1,maxLength:1000},axes:{type:'array',minItems:1,maxItems:6,uniqueItems:true,items:{enum:['structure','reading-order','typography','density','imagery','interaction']}}}},
        } } },
        states: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'steps'], properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, steps: { type: 'array', minItems: 1, items: BROWSER_SCENARIO_STEP_SCHEMA },
        } } },
        preserve: { type: 'object', additionalProperties: false, properties: { content: { type: 'boolean' }, interactions: { type: 'boolean' } } },
        axes: {
          type: 'object',
          properties: {
            density: { type: 'array', items: { type: 'string', enum: ['compact', 'normal', 'airy'] } },
            typeScale: { type: 'array', items: { type: 'string', enum: ['tight', 'normal', 'loose'] } },
            radius: { type: 'array', items: { type: 'string', enum: ['sharp', 'soft', 'round'] } },
            palette: { type: 'array', items: { type: 'string', enum: ['mono', 'warm', 'cool', 'ink'] } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_explore,
  },
  {
    name: 'studio_prepare_media',
    description: '从原图按焦点/保护主体/比例/底色令牌生成可重放的摄影素材，返回带 SHA 的资源登记命令，不自动改画布。将 registerCommand 和图片节点修改原子提交，支持一起撤销。需要 Python Pillow。',
    inputSchema: { type: 'object', properties: { ...connectionProperties,...OPERATION_PROPERTIES, sourcePath: { type: 'string', minLength: 1 }, credit: { type: 'string' }, crops: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', properties: { name: { type: 'string' }, w: { type: 'integer', minimum: 1, maximum: 4096 }, h: { type: 'integer', minimum: 1, maximum: 4096 }, fx: { type: 'number', minimum: 0, maximum: 1 }, fy: { type: 'number', minimum: 0, maximum: 1 }, fh: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, scale: { type: 'integer', enum: [1, 2, 3] }, fadeFrom: { type: 'number', minimum: 0 }, fadeToToken: { type: 'string', description: 'colors 令牌的裸名（如 bg，不是 colors.bg）；令牌缺失或非六位颜色时降级为 W_MEDIA_TOKEN_STALE 警告并回落 #FFFFFF' }, protectedRegion: { type: 'object', description: '保护主体在原图中的归一化区域：0–1 相对原图宽高，不是像素坐标', properties: { x: { type: 'number', description: '归一化 0–1，相对原图宽' }, y: { type: 'number', description: '归一化 0–1，相对原图高' }, w: { type: 'number', description: '归一化 0–1，相对原图宽，需 x+w≤1' }, h: { type: 'number', description: '归一化 0–1，相对原图高，需 y+h≤1' } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false } }, required: ['w', 'h'], additionalProperties: false,
    } } }, required: ['sourcePath', 'crops'], additionalProperties: false },
    handler: studioHandlers.studio_prepare_media,
  },
  {
    name: 'studio_review_design',
    description: '为当前版本创建真实截图和机器检查，返回图片供模型看图；用 reviewId 提交具体 observations。旧版本拒收。compareWithReviewId 可返回前后两张图及变更区域。评审不调用额外模型、不自评审美分、不代表用户验收。',
    inputSchema: { type: 'object', properties: { ...connectionProperties, verbose: { type: 'boolean', description: '默认摘要；true返回完整指标和节点快照' }, pageId: { type: 'string' }, baseRevision: { type: 'integer', minimum: 1 }, reviewId: { type: 'string' }, compareWithReviewId: { type: 'string', description: '同页此前评审 ID，返回前后两张真实图片、变更节点范围和指标变化' }, observations: { type: 'array', minItems: 1, items: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } }, issue: { type: 'string', minLength: 1, maxLength: 4000 }, consequence:{type:'string',maxLength:4000}, decision: { type: 'string',maxLength:4000 }, preserve:{type:'string',maxLength:4000} }, required: ['nodeIds', 'issue'], additionalProperties: false } } }, required: ['pageId', 'baseRevision'], additionalProperties: false },
    handler: studioHandlers.studio_review_design,
  },
  {
    name: 'studio_open_project',
    description: '打开或初始化自由画布工程目录（可选从 RP/1 JSON 或 .rp1 源码导入），启动或复用本机单端口 Studio 服务并返回画布上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', minLength: 1 },
        sourcePath: { type: 'string' },
        name: { type: 'string' },
        domain: { type: 'string', enum: ['mobile', 'web'] },
        port: { type: 'integer', minimum: 1024, maximum: 65535 },
        url: { type: 'string' },
      },
      required: ['projectDir'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_open_project,
  },
  {
    name: 'studio_get_context',
    description: '读取自由画布当前会话状态（appliedRevision、durableRevision、renderedRevision、contentHash、页面、组件、令牌、字体与恢复摘要）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        verbose: { type: 'boolean' }, includeDoc: { type: 'boolean' }, includeScene: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 2048, maximum: 400000 },
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: studioHandlers.studio_get_context,
  },
  {
    name: 'studio_query_nodes',
    description: '按语义/ID/区域查询真实节点，默认8项，返回可编辑源目标、宏/组件控制关系和父布局/padding坐标说明。fields精确取字段、cursor按版本续取；view:full取完整解算节点。跨页重名及过期游标明确拒绝，不扩大目标。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
        nodeId: { type: 'string' },
        type: { type: 'string' },
        textContains: { type: 'string' },
        nodeIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        role: { type: 'string' }, within: { type: 'string' },
        view: { type: 'string', enum: ['authoring', 'full'] },
        fields: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'authoring可选id/scopedId/pageId/name/type/role/text/textLength/textTruncated/visible/locked/bounds/editableTargetId/target/source/layoutContext/controls/suggestedEdit；几何用bounds。view:full才使用解算字段如x/y/w/h。' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 }, cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: studioHandlers.studio_query_nodes,
  },
  {
    name: 'studio_apply_commands',
    description: '提交同一权威文档的原子修改。commands或rp1片段二选一；rp1需要sourceMode:insert/update和pageId，显式字段增量更新、省略内容保留，支持行列号诊断。editNodes按role/within批量改稿；精确参数用studio_describe按需发现。强校验版本、幂等、WAL与撤销。',
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
        selectionId: {type:'string',minLength:1},
        actor: { type: 'object' },
        baseRevision: { type: 'integer', minimum: 0 },
        idempotencyKey: { type: 'string', minLength: 1 },
        commands: { type: 'array', minItems: 1, items: { type: 'object', properties: { type: { type: 'string', enum: VALID_COMMAND_TYPES } }, required: ['type'] } },
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
    handler: studioHandlers.studio_apply_commands,
  },
  {
    name: 'studio_wait_for_render',
    description: '等待真实浏览器画布完成指定文档版本（revision）的布局、字体与图片绘制确认。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
        timeoutMs: { type: 'integer', minimum: 50 },
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: studioHandlers.studio_wait_for_render,
  },
  {
    name: 'studio_capture_screenshot',
    description: '严格等待指定 revision 在真实浏览器完成字体与图片渲染后截取画板或节点 PNG，返回 revision、contentHash 与文件 SHA-256。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
        pageId: { type: 'string' },
        nodeId: { type: 'string' },
        outPath: { type: 'string' },
        includeImage: { type: 'boolean', description: '默认 true，直接返回 MCP 图片供模型查看' },
        timeoutMs: { type: 'integer', minimum: 50 },
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: studioHandlers.studio_capture_screenshot,
  },
  {
    name: 'studio_undo',
    description: '撤销最近一次已提交的画布事务并同步浏览器与磁盘。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        clientId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        expectedHeadTxId: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_undo,
  },
  {
    name: 'studio_redo',
    description: '重做最近一次已撤销的画布事务并同步浏览器与磁盘。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        clientId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_redo,
  },
  {
    name: 'studio_run_scenario',
    description: '在隔离的交互运行态会话（StudioRuntimeSession）中执行业务交互剧本并断言变量、面板状态、文本、显隐与数据集，不污染设计态文档。默认走语义执行层，不做遮挡/hitTest校验：click只要求目标在当前运行态可见，通过≠真实可点。hitTest:true 先用真实浏览器指针重放校验每个点击目标（遮挡/命中按真实DOM结论），被遮挡返回E_SCENARIO_OCCLUDED（含nodeId/occludedBy遮挡者/stepIndex，语义层不执行该步）；真实浏览器不可用返回E_SCENARIO_HITTEST_UNAVAILABLE（不静默降级）；含navigate/dataset等浏览器层无法重放的步骤返回E_SCENARIO_HITTEST_UNSUPPORTED。步骤示例：{action:"click",target:"reveal",expect:{visible:{answer:true}}}；未知步骤或零断言会拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        startPageId: { type: 'string' },
        verbose: { type: 'boolean', description: 'true返回完整运行场景与轨迹' },
        reset: { type: 'boolean' },
        hitTest: { type: 'boolean', description: '默认false走语义层（不校验遮挡，通过≠真实可点）；true用真实浏览器指针校验点击目标，被遮挡返回E_SCENARIO_OCCLUDED（含nodeId/遮挡者），不可用返回E_SCENARIO_HITTEST_UNAVAILABLE，不静默降级' },
        steps: { type: 'array', minItems: 1, items: SCENARIO_STEP_SCHEMA },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_run_scenario,
  },
  {
    name: 'studio_export_rp',
    description: '从当前权威快照导出原生.rp与逐节点兼容报告。baseRevision指定时必须仍为当前版。async:true加requestKey/baseRevision返回持久句柄，产物保存在独立操作目录；用studio_operations核对或取消。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        outRpPath: { type: 'string' },
        outReportPath: { type: 'string' },
        ...OPERATION_PROPERTIES,
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_export_rp,
  },
  {
    name: 'studio_export_code',
    description: '从当前权威快照导出独立可运行 HTML/CSS/JS 代码工程包（含源码、资源闭包、版本绑定 manifest.json 与运行说明 README.md），复用语义源布局、变量、动态面板、导航、中继器与矢量路径，显式列明并禁用未支持交互。支持 baseRevision 校验与 async:true 持久操作。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        outDir: { type: 'string' },
        resetRegistration: { type: 'boolean' },
        ...OPERATION_PROPERTIES,
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_export_code,
  },
  {
    name: 'studio_sync_native',
    description: '将原生 .rp 修改自动收敛回同一 Studio 源文档（preview/apply）。通过基线符号与 GUID 映射到真实作者源 target/propertyMap/父内容盒坐标，覆盖普通节点、宏参数、组件实例覆盖、流式布局排布提示、非激活面板状态、中继器模板（默认保护 =item.xxx 公式不被首行字面量覆盖）与多页三方冲突裁决。',
    inputSchema: {
      type: 'object',
      properties: {
        ...connectionProperties,
        ...OPERATION_PROPERTIES,
        rpPath: { type: 'string', minLength: 1 },
        baseRpPath: { type: 'string' },
        baselinePath: { type: 'string' },
        mode: { type: 'string', enum: ['preview', 'apply'] },
        prefer: { type: 'string', enum: ['fail', 'studio', 'native'] },
        resolutions: { type: 'object', additionalProperties: { type: 'string', enum: ['studio', 'native'] } },
        idempotencyKey: { type: 'string', minLength: 1 },
        previewHash: { type: 'string', minLength: 1 },
        allowFormulaOverwrite: { type: 'boolean' },
        rebuildRp: { type: 'boolean' },
        outRpPath: { type: 'string' },
      },
      required: ['rpPath'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_sync_native,
  },
  {
    name: 'studio_project_bundle',
    description: '导出、校验、导入或对比自包含可迁移工程包（report/export/verify/import/compare）。包含权威文档、组件契约、tokens、变量、数据集、设计决定、版本快照及引用资源/字体闭包（全部相对路径，零宿主机绝对路径泄漏），并生成兼容诊断报告。',
    inputSchema: {
      type: 'object',
      properties: {
        ...connectionProperties,
        action: { type: 'string', enum: ['report', 'export', 'verify', 'import', 'compare'] },
        bundleDir: { type: 'string' },
        outDir: { type: 'string' },
        targetProjectDir: { type: 'string' },
        includeVersions: { type: 'boolean' },
        includeThumbnails: { type: 'boolean' },
        overwrite: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_project_bundle,
  },
  {
    name: 'studio_merge_document',
    description: '对同一工程执行人类/AI并发编辑或外部 JSON/RP1 文件的三方结构化合并（preview/apply/check-external）。自动合并无关修改，显式报出同字段、删改、跨容器重挂、布局耦合（如 x vs right、父流式 vs 子坐标）、组件实例覆盖与引用冲突，支持逐项裁决并写入单步可撤销事务。',
    inputSchema: {
      type: 'object',
      properties: {
        ...connectionProperties,
        mode: { type: 'string', enum: ['preview', 'apply', 'check-external'] },
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
        prefer: { type: 'string', enum: ['fail', 'ours', 'theirs'] },
        resolutions: { type: 'object', additionalProperties: { type: 'string', enum: ['ours', 'theirs'] } },
        idempotencyKey: { type: 'string', minLength: 1 },
        previewHash: { type: 'string', minLength: 1 },
        clientId: { type: 'string' },
        actor: { type: 'object' },
        label: { type: 'string' },
        verbose: { type: 'boolean' },
        includeDoc: { type: 'boolean' },
        includeScene: { type: 'boolean' },
        maxBytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_merge_document,
  },
  {
    name: 'studio_get_component_contracts',
    description: '查询自由画布 6 个核心高频组件（button、input-field、list-item、info-card、nav-bar、status-zone）的契约规范（参数、插槽、允许覆盖白名单、锁定内部结构、尺寸规则、状态矩阵、事件语义与调用示例）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        componentId: { type: 'string' },
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: studioHandlers.studio_get_component_contracts,
  },
  {
    name: 'studio_run_acceptance_scenarios',
    description: '执行12个语义验收模板；有interactionSteps的场景可重放真实浏览器与Axure预览操作。无操作脚本或不支持的断言返回unsupported，不记为通过。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        domain: { type: 'string' },
        scenarioIds: { type: 'array', items: { type: 'string' } },
        category: { type: 'string' },
        impactReport: { type: 'object' },
        runAll: { type: 'boolean' },
        layers: { type: 'array', items: { type: 'string' } },
        axurePreviewUrl: { type: 'string', description: '可选的真实 Axure 预览地址；未提供时在 macOS RP9 中打开本次独立导出并生成新预览。' },
        faultInjection: { type: 'boolean' },
        screenshotDir: { type: 'string' },
        exportDir: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_run_acceptance_scenarios,
  },
];

export async function closeInProcessStudioServer() {
  for (const entry of inProcessServers.values()) {
    if (entry?.kind === 'local' && entry.studio) {
      try { await entry.studio.close(); } catch {}
    }
  }
  inProcessServers.clear();
}
