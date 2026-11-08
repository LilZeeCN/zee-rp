#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { startStudioServer } from './server.mjs';
import { studioHandlers } from './mcp-adapter.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--help') || rawArgv.includes('-h') || rawArgv[0] === 'help') {
    console.log(
      [
        '用法: node bin/axure.mjs studio <subcommand> [options]',
        '',
        '子命令:',
        '  start       启动单端口自由画布服务 (--project <dir> [--source <spec.json>] [--port 4310] [--name <name>])',
        '  context     读取当前画布上下文与版本状态 (--port <port> | --url <url> | --project <dir>)',
        '  query       按语义查询画布节点 (--port <port> | --project <dir> [--input <request.json>])',
        '  apply       执行结构化画布编辑命令 (--port <port> | --project <dir> --input <request.json>)',
        '  describe    按需发现AI/RP1创作接口 (--topic workflow|rp1|command|node|design|craft [--name label --fields text,fontSize --surface canvas --operation edit])',
        '  design-context  读取设计参考 (--port <port> [--intent editorial|task|learning] [--page home])',
        '  prepare-media   按 JSON 配方生成素材 (--port <port> --input <request.json>)',
        '  review          截图或提交看图意见 (--port <port> --input <request.json>)',
        '  screenshot  按版本截取画板或节点 PNG (--port <port> [--revision <n>] [--page <id>] [--node <id>] [--out <file.png>])',
        '  export      导出 Axure RP 9 原生 .rp 与兼容报告 (--port <port> [--out <file.rp>] [--report <report.json>])',
        '  versions    列出/命名/预览/恢复工程版本 (--project <dir> --input <request.json>)',
        '  operations  查询/列出/取消持久操作 (--project <dir> --input <request.json>)',
        '  explore     预演候选；可async (--project <dir> --input <request.json>)',
        '  export-rp   导出原生；可async (--project <dir> --input <request.json>)',
        '  export-code 导出可运行 HTML/CSS/JS 代码工程包；可async (--project <dir> [--out <dir>] [--input <request.json>] [--reset-registration])',
        '  sync-native 原生 .rp 修改收敛回填 (--project <dir> --rp <edited.rp> [--mode preview|apply] [--prefer fail|studio|native] [--input <request.json>])',
        '  bundle      可迁移工程包导出/校验/导入/对比 (--project <dir> --action report|export|verify|import|compare [--bundle <dir>] [--target <dir>] [--input <request.json>])',
        '  merge       三方并发/外部文件安全合并 (--project <dir> [--mode preview|apply|check-external] [--external <file>] [--prefer fail|ours|theirs] [--input <request.json>])',
        '  contracts   查询核心组件契约规范 (--port <port> [--component <id>])',
        '  scenarios   执行验收模板 (--port <port> [--domain <domain>] [--ids <ids>] [--layers semantic,browser,axure-preview,native-structure] [--axure-preview-url <url>] [--fault-injection])',
      ].join('\n')
    );
    return;
  }
  const args = parseArgs(rawArgv);
  const sub = args._[0] || 'start';
  if (sub === 'describe') {
    console.log(JSON.stringify(await studioHandlers.studio_describe({ topic: args.topic || 'workflow', name: args.name,
      intent: args.intent || 'learning', platform: args.platform || 'mobile', guideId: args.guide,...(args.fields?{fields:String(args.fields).split(',')}:{}),...(args.surface?{surface:args.surface}:{}),...(args.operation?{operation:args.operation}:{}) }), null, 2));
    return;
  }

  if (['query', 'apply', 'design-context', 'prepare-media', 'review', 'versions','operations','explore','export-rp','export-code','sync-native','bundle','project-bundle','merge','command','inspect','screenshot','export','history','stage','design','scenario','media'].includes(sub)) {
    const handler = { query: 'studio_query_nodes', apply: 'studio_apply_commands', 'design-context': 'studio_get_design_context', 'prepare-media': 'studio_prepare_media', review: 'studio_review_design', versions: 'studio_project_versions',operations:'studio_operations',explore:'studio_design_explore','export-rp':'studio_export_rp','export-code':'studio_export_code','sync-native':'studio_sync_native',bundle:'studio_project_bundle','project-bundle':'studio_project_bundle',merge:'studio_merge_document',command:'studio_command',inspect:'studio_inspect',screenshot:'studio_screenshot',export:'studio_export',history:'studio_history',stage:'studio_stage',design:'studio_design',scenario:'studio_scenario',media:'studio_media' }[sub];
    const input = args.input ? JSON.parse(readFileSync(resolve(args.input), 'utf8')) : {};
    if (sub === 'export-code') {
      if (args.out || args.outDir) input.outDir = resolve(args.out || args.outDir);
      if (args['base-revision']) input.baseRevision = Number(args['base-revision']);
      if (args['reset-registration']) input.resetRegistration = true;
    }
    if (sub === 'sync-native') {
      if (args.rp || args.rpPath) input.rpPath = resolve(args.rp || args.rpPath);
      if (args.mode) input.mode = args.mode;
      if (args.prefer) input.prefer = args.prefer;
      if (args.baseline) input.baselinePath = resolve(args.baseline);
      if (args['base-revision']) input.baseRevision = Number(args['base-revision']);
    }
    if (sub === 'bundle' || sub === 'project-bundle') {
      if (args.action) input.action = args.action;
      if (args.bundle || args.bundleDir) input.bundleDir = resolve(args.bundle || args.bundleDir);
      if (args.out || args.outDir) input.outDir = resolve(args.out || args.outDir);
      if (args.target || args.targetProjectDir) input.targetProjectDir = resolve(args.target || args.targetProjectDir);
      if (args.overwrite !== undefined) input.overwrite = Boolean(args.overwrite);
    }
    if (sub === 'merge') {
      if (args.mode) input.mode = args.mode;
      if (args.prefer) input.prefer = args.prefer;
      if (args.external || args.externalSourcePath) input.externalSourcePath = resolve(args.external || args.externalSourcePath);
      if (args['base-revision']) input.baseRevision = Number(args['base-revision']);
      if (args['base-version']) input.baseVersionId = args['base-version'];
      if (args.key || args.idempotencyKey) input.idempotencyKey = args.key || args.idempotencyKey;
      if (args.previewHash) input.previewHash = args.previewHash;
    }
    const result = await studioHandlers[handler]({ ...input, url: args.url, port: args.port ? Number(args.port) : undefined,
      projectDir: args.project, ...(sub === 'design-context' ? { intent: args.intent || input.intent || 'editorial', ...(args.stage ? {stage:args.stage} : {}), ...(!args.stage && !input.stage ? {pageId:args.page || input.pageId || 'home'} : args.page ? {referencePageId:args.page} : {}), includeImages: false } : {}) });
    const { mcpImages, ...textResult } = result;
    console.log(JSON.stringify(textResult, null, 2));
    return;
  }

  if (sub === 'start') {
    const projectDir = resolve(args.project || args.projectDir || './.studio-project');
    const sourcePath = args.source || args.spec ? resolve(args.source || args.spec) : null;
    const port = Number(args.port || 4310);
    const { studio, info } = await startStudioServer({
      projectDir,
      sourcePath,
      name: args.name || 'Studio Project',
      port,
    });
    console.log(JSON.stringify({ ok: true, event: 'studio_started', ...info }));
    process.on('SIGINT', async () => {
      await studio.close();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await studio.close();
      process.exit(0);
    });
    return;
  }

  if (sub === 'context') {
    const res = await studioHandlers.studio_get_context({
      url: args.url,
      port: args.port ? Number(args.port) : undefined,
      projectDir: args.project,
    });
    console.log(args.pretty ? JSON.stringify(res, null, 2) : JSON.stringify(res));
    return;
  }

  if (sub === 'screenshot') {
    const res = await studioHandlers.studio_screenshot({
      url: args.url,
      port: args.port ? Number(args.port) : undefined,
      projectDir: args.project,
      revision: args.revision ? Number(args.revision) : undefined,
      pageId: args.page,
      nodeId: args.node,
      outPath: args.out,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (sub === 'export') {
    const res = await studioHandlers.studio_export_rp({
      url: args.url,
      port: args.port ? Number(args.port) : undefined,
      projectDir: args.project,
      outRpPath: args.out,
      outReportPath: args.report,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (sub === 'contracts') {
    const res = await studioHandlers.studio_get_component_contracts({
      url: args.url,
      port: args.port ? Number(args.port) : undefined,
      projectDir: args.project,
      componentId: args.component || args.id || null,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (sub === 'scenarios') {
    const layers = typeof args.layers === 'string'
      ? args.layers.split(',').map(s => s.trim()).filter(Boolean)
      : ['semantic'];
    const scenarioIds = typeof args.ids === 'string'
      ? args.ids.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const res = await studioHandlers.studio_run_acceptance_scenarios({
      url: args.url,
      port: args.port ? Number(args.port) : undefined,
      projectDir: args.project,
      domain: args.domain || null,
      scenarioIds,
      category: args.category || null,
      layers,
      faultInjection: Boolean(args['fault-injection'] || args.faultInjection),
      screenshotDir: args.screenshots || null,
      exportDir: args.exports || null,
      axurePreviewUrl: args['axure-preview-url'] || null,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  throw new Error(`Unknown studio command: ${sub}`);
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, code: err.code || 'E_CLI_ERROR', message: err.message }));
  process.exit(1);
});
