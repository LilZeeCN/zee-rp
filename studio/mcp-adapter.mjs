import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startStudioServer } from './server.mjs';

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

async function callServerJson(baseUrl, path, method = 'GET', body = null) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
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
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 响应预算：MCP 层默认压缩，HTML 画布与 HTTP/CLI 保持全量。
// 目标：单次写操作响应 < 12KB，避免 agent 多轮迭代被上下文吃光。
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 12000;
const NODE_KEYS = ['id', 'type', 'parentId', 'x', 'y', 'w', 'h', 'name'];

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
        page.nodeCount = (page.nodes || []).length;
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

function projectPayload(payload, { verbose = false, includeDoc = false, includeScene = false, maxBytes } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.ok === false) return { ...payload, payloadBytes: byteLen(payload) };
  if (verbose) return { ...payload, compact: false, payloadBytes: byteLen(payload) };
  const compact = compactImpact({ ...payload });
  if (!includeDoc) compact.doc = compactDoc(payload.doc);
  else compact.doc = payload.doc;
  if (!includeScene) compact.scene = compactScene(payload.scene);
  else compact.scene = payload.scene;
  compact.compact = true;
  const budgeted = enforceBudget(compact, maxBytes ?? DEFAULT_MAX_BYTES);
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
  async studio_get_design_context(args = {}) {
    return callServerJson(await resolveServerUrl(args), '/api/design/context', 'POST', args);
  },
  async studio_design_metrics(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/metrics', 'POST', {
      pageId: args.pageId || null,
      thresholds: args.thresholds || null,
    });
  },
  async studio_design_pixel_contrast(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/pixel-contrast', 'POST', {
      pageId: args.pageId || null,
      dpr: args.dpr || 2,
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
    });
  },
  async studio_design_explore(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/design/explore', 'POST', {
      pageId: args.pageId || null,
      axes: args.axes || null,
      limit: args.limit || null,
    });
  },
  async studio_prepare_media(args = {}) {
    return callServerJson(await resolveServerUrl(args), '/api/media/prepare', 'POST', args);
  },
  async studio_review_design(args = {}) {
    return callServerJson(await resolveServerUrl(args), '/api/design/review', 'POST', args);
  },
  async studio_open_project({
    projectDir,
    sourcePath = null,
    name = 'Studio Project',
    domain = 'mobile',
    port = 4310,
    url = null,
    verbose = false,
    includeDoc = false,
    includeScene = false,
    maxBytes = DEFAULT_MAX_BYTES,
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
      const body = sourcePath
        ? known.studio.openProject({ projectDir: absDir, sourcePath, name, domain })
        : known.studio.buildContextPayload();
      return { ...projectPayload(body, { verbose, includeDoc, includeScene, maxBytes }), openInstances: instanceSummary() };
    }
    if (known?.kind === 'remote') {
      const body = await callServerJson(known.url, '/api/context', 'GET');
      return { ...projectPayload(body, { verbose, includeDoc, includeScene, maxBytes }), openInstances: instanceSummary() };
    }

    // 不同工程：先看是否已有别的进程在该目录上跑着（跨进程复用，防止双写）。
    const rec = instanceRecordFor(absDir);
    if (rec) {
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
    const { studio } = await startStudioServer({ projectDir: absDir, sourcePath, name, port, domain });
    inProcessServers.set(absDir, { kind: 'local', studio });
    return {
      ...projectPayload(studio.buildContextPayload(), { verbose, includeDoc, includeScene, maxBytes }),
      openInstances: instanceSummary(),
    };
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
    };
  },

  async studio_query_nodes(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/query', 'POST', args);
  },

  async studio_apply_commands(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    const body = await callServerJson(baseUrl, '/api/commands', 'POST', {
      clientId: args.clientId || 'mcp-ai',
      source: args.source || 'mcp-ai',
      baseRevision: args.baseRevision,
      idempotencyKey: args.idempotencyKey,
      pageId: args.pageId || null,
      documentId: args.documentId || null,
      label: args.label || null,
      actor: args.actor || null,
      commands: args.commands || [],
      simulateCrashStage: args.simulateCrashStage || null,
    });
    const TEXTLIKE = new Set(['setText', 'set-props', 'setProperties', 'setFont', 'renameNode', 'setToken', 'set-tokens', 'setTokens', 'setInteraction', 'removeInteraction']);
    const lightweight = !args.includeScene
      && Array.isArray(args.commands)
      && args.commands.length > 0
      && args.commands.length <= 4
      && args.commands.every(c => TEXTLIKE.has(c?.type));
    let projected = body;
    if (lightweight && body?.scene?.pages) {
      const keep = new Set(body.affectedNodeIds || []);
      projected = {
        ...body,
        scene: {
          ...body.scene,
          pages: body.scene.pages.map(page => ({
            id: page.id,
            name: page.name,
            board: page.board,
            nodeCount: (page.nodes || []).length,
            nodes: (page.nodes || []).filter(n => keep.has(`${page.id}/${n.id}`) || keep.has(n.id)),
          })),
        },
        sceneFiltered: '只回受影响节点；需要全量请传 includeScene:true',
      };
    }
    return projectPayload(projected, {
      verbose: args.verbose,
      includeDoc: args.includeDoc,
      includeScene: args.includeScene,
      maxBytes: args.maxBytes,
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
    return callServerJson(baseUrl, '/api/runtime/scenario', 'POST', {
      startPageId: args.startPageId || null,
      reset: args.reset !== false,
      steps: args.steps || [],
    });
  },

  async studio_export_rp(args = {}) {
    const baseUrl = await resolveServerUrl(args);
    return callServerJson(baseUrl, '/api/export-rp', 'POST', {
      outRpPath: args.outRpPath || args.output || null,
      outReportPath: args.outReportPath || null,
    });
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
  {
    name: 'studio_get_design_context',
    description: '根据 editorial/task/learning 题材读取设计原则、适用边界和当前工程信息；editorial 返回用户认可的栖羽页面源与真实参考图，其他题材明确暂无获认可标杆。',
    readOnly: true,
    inputSchema: { type: 'object', properties: { ...connectionProperties, intent: { type: 'string', enum: ['editorial', 'task', 'learning'] }, pageId: { type: 'string', enum: ['home', 'species', 'record', 'saved'] }, includeImages: { type: 'boolean' } }, additionalProperties: false },
    handler: studioHandlers.studio_get_design_context,
  },
  {
    name: 'studio_design_metrics',
    description: '计算页面的 L1 视觉完成度代理指标（字阶比、4px 栅格一致性、留白占比、文本对比度、主色相数）与反 AI-slop 负样本规则（等距三卡、紫渐变、空洞居中标题、图标圆角方块、首屏无素材、圆角过度）。不返回审美总分：只给可复现的结构判断与具体改法。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
        thresholds: { type: 'object' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_metrics,
  },
  {
    name: 'studio_design_pixel_contrast',
    description: '像素真值对比度：截图后用真实像素取样计算，不再用几何猜 CSS 合成结果（遮罩、滤镜、混合模式、图片底一次覆盖）。返回每处文字的底色、比值、是否达标。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
        dpr: { type: 'integer' },
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
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_design_anchors,
  },
  {
    name: 'studio_design_explore',
    description: '批量生成设计变体并按可复现判据自动收敛：在密度/字阶/圆角/配色四条轴上展开组合，对每个变体计算同一套 L1 指标与反 slop 规则，按「未达标项 → 硬伤 → 提示 → 改动量」排序，返回入选变体可直接提交的 commands。没有审美总分，也不改文档（纯预演）。',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        pageId: { type: 'string' },
        limit: { type: 'integer', minimum: 2, maximum: 40 },
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
    inputSchema: { type: 'object', properties: { ...connectionProperties, sourcePath: { type: 'string', minLength: 1 }, credit: { type: 'string' }, crops: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', properties: { name: { type: 'string' }, w: { type: 'integer', minimum: 1, maximum: 4096 }, h: { type: 'integer', minimum: 1, maximum: 4096 }, fx: { type: 'number', minimum: 0, maximum: 1 }, fy: { type: 'number', minimum: 0, maximum: 1 }, fh: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, scale: { type: 'integer', enum: [1, 2, 3] }, fadeFrom: { type: 'number', minimum: 0 }, fadeToToken: { type: 'string' }, protectedRegion: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false } }, required: ['w', 'h'], additionalProperties: false,
    } } }, required: ['sourcePath', 'crops'], additionalProperties: false },
    handler: studioHandlers.studio_prepare_media,
  },
  {
    name: 'studio_review_design',
    description: '为当前版本创建真实截图和机器检查，返回图片供模型看图；用 reviewId 提交具体 observations。旧版本拒收。评审不调用额外模型、不自评审美分、不代表用户验收。',
    inputSchema: { type: 'object', properties: { ...connectionProperties, pageId: { type: 'string' }, baseRevision: { type: 'integer', minimum: 1 }, reviewId: { type: 'string' }, observations: { type: 'array', minItems: 1, items: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } }, issue: { type: 'string', minLength: 1 }, decision: { type: 'string' } }, required: ['nodeIds', 'issue'], additionalProperties: false } } }, required: ['pageId', 'baseRevision'], additionalProperties: false },
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
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: studioHandlers.studio_get_context,
  },
  {
    name: 'studio_query_nodes',
    description: '按页面、节点 ID、类型或文本子串查询画布节点，返回 ResolvedScene 精确坐标尺寸、计算样式、组件/宏来源及诊断。',
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
      },
      additionalProperties: false,
    },
    readOnly: true,
    handler: studioHandlers.studio_query_nodes,
  },
  {
    name: 'studio_apply_commands',
    description: '向权威语义文档提交单条或原子批量编辑命令（强校验 baseRevision 与 idempotencyKey，落盘 WAL 并实时同步浏览器画布）。',
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
        actor: { type: 'object' },
        baseRevision: { type: 'integer', minimum: 0 },
        idempotencyKey: { type: 'string', minLength: 1 },
        commands: { type: 'array', minItems: 1, items: { type: 'object' } },
        verbose: { type: 'boolean' },
        includeDoc: { type: 'boolean' },
        includeScene: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 2048, maximum: 400000 },
      },
      required: ['baseRevision', 'idempotencyKey', 'commands'],
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
    description: '在隔离的交互运行态会话（StudioRuntimeSession）中执行业务交互剧本并断言变量、面板状态、文本、显隐与数据集，不污染设计态文档。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        startPageId: { type: 'string' },
        reset: { type: 'boolean' },
        steps: { type: 'array', items: { type: 'object' } },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    handler: studioHandlers.studio_run_scenario,
  },
  {
    name: 'studio_export_rp',
    description: '锁住当前或指定 revision 的权威快照导出 Axure 原生 .rp 与结构化兼容报告（native-editable / rasterized-effect / unsupported 及几何对齐指标）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        port: { type: 'integer' },
        projectDir: { type: 'string' },
        outRpPath: { type: 'string' },
        outReportPath: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: studioHandlers.studio_export_rp,
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
  if (inProcessServer) {
    await inProcessServer.close();
    inProcessServer = null;
  }
}
