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
        '  design-context  读取设计参考 (--port <port> [--intent editorial|task|learning] [--page home])',
        '  prepare-media   按 JSON 配方生成素材 (--port <port> --input <request.json>)',
        '  review          截图或提交看图意见 (--port <port> --input <request.json>)',
        '  screenshot  按版本截取画板或节点 PNG (--port <port> [--revision <n>] [--page <id>] [--node <id>] [--out <file.png>])',
        '  export      导出 Axure RP 9 原生 .rp 与兼容报告 (--port <port> [--out <file.rp>] [--report <report.json>])',
        '  contracts   查询核心组件契约规范 (--port <port> [--component <id>])',
        '  scenarios   执行验收模板 (--port <port> [--domain <domain>] [--ids <ids>] [--layers semantic,browser,axure-preview,native-structure] [--axure-preview-url <url>] [--fault-injection])',
      ].join('\n')
    );
    return;
  }
  const args = parseArgs(rawArgv);
  const sub = args._[0] || 'start';

  if (['design-context', 'prepare-media', 'review'].includes(sub)) {
    const handler = { 'design-context': 'studio_get_design_context', 'prepare-media': 'studio_prepare_media', review: 'studio_review_design' }[sub];
    const input = args.input ? JSON.parse(readFileSync(resolve(args.input), 'utf8')) : {};
    const result = await studioHandlers[handler]({ ...input, url: args.url, port: args.port ? Number(args.port) : undefined,
      projectDir: args.project, ...(sub === 'design-context' ? { intent: args.intent || 'editorial', pageId: args.page || 'home', includeImages: false } : {}) });
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
    const res = await studioHandlers.studio_capture_screenshot({
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
