import { listMcpTools, callCommandTool, jobTools, validateInput, MCP_PROFILES, resolveMcpProfile } from '../scripts/mcp-tools.mjs';
import { JobManager } from '../scripts/jobs.mjs';
import { mcpInstructions, packageVersion } from '../scripts/authoring-workflow.mjs';

const shutdownDaemons = async () => {
  try {
    const { closeAssemblyDaemons } = await import('../tools/native-assembly/bridge.mjs');
    await closeAssemblyDaemons();
  } catch {}
};

const profileFlag = process.argv.find(a => a.startsWith('--profile='))?.slice('--profile='.length)
  ?? (process.argv.indexOf('--profile') >= 0 ? process.argv[process.argv.indexOf('--profile') + 1] : undefined);
const activeProfile = resolveMcpProfile(profileFlag);
if (profileFlag) process.env.ZEE_MCP_PROFILE = activeProfile;

try {
  const [{ Server }, { StdioServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js')
  ]);
  const server = new Server({ name: 'zee-rp', version: packageVersion }, { capabilities: { tools: {} }, instructions: mcpInstructions });
  const jobs = new JobManager();
  const profileAllow = MCP_PROFILES[activeProfile];
  const exposedTools = () => [
    ...listMcpTools({ profile: activeProfile }),
    ...(profileAllow ? jobTools.filter(t => profileAllow.has(t.name)) : jobTools),
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const name = request.params.name, input = request.params.arguments ?? {};
      if (['generate_prototype', 'revise_prototype'].includes(name) && input.async === true) {
        validateInput(listMcpTools().find(t => t.name === name).inputSchema, input);
        if (name === 'generate_prototype' && input.includeImage) {
          throw Object.assign(new Error('includeImage:true 需要同步生成，请省略 async 或通过任务结果读取预览路径。'), { code: 'E_PREVIEW_IMAGE_ASYNC' });
        }
        const value = name === 'revise_prototype' ? jobs.startRevision(input) : jobs.startGeneration(input);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
      }
      const tool = jobTools.find(t => t.name === name);
      if (!tool) return callCommandTool(name, input);
      validateInput(tool.inputSchema, input);
      const value = name === 'gui_roundtrip' ? await jobs.startRoundtrip(input)
        : name === 'jobs_list' ? jobs.list()
        : name === 'jobs_get' ? jobs.get(input.id) : jobs.cancel(input.id);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: value?.status === 'failed' };
    }
    catch (error) {
      const value = { status: 'failed', diagnostics: [{ code: error.code ?? 'E_TOOL_ARGUMENT', message: error.message,
        nextAction: '检查工具参数、输入文件与输出路径；原文件保留。' }] };
      return { isError: true, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
  });
  process.stdin.once('end', () => { void jobs.close(); void shutdownDaemons(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await Promise.all([jobs.close(), shutdownDaemons()]); await server.close(); process.exit(0); });
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error.code === 'ERR_MODULE_NOT_FOUND' ? 'MCP 需要可选依赖：在 zee-rp 目录运行 npm ci --ignore-scripts。核心 CLI 无需安装依赖。' : error.message);
  process.exitCode = 1;
}
