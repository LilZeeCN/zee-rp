import { listMcpTools, callCommandTool, jobTools, validateInput } from '../scripts/mcp-tools.mjs';
import { JobManager } from '../scripts/jobs.mjs';
import { packageVersion } from '../scripts/authoring-workflow.mjs';

try {
  const [{ Server }, { StdioServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js')
  ]);
  const server = new Server({ name: 'zee-rp', version: packageVersion }, { capabilities: { tools: {} } });
  const jobs = new JobManager();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...listMcpTools(), ...jobTools] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const name = request.params.name, input = request.params.arguments ?? {};
      if (['generate_prototype', 'revise_prototype'].includes(name) && input.async === true) {
        validateInput(listMcpTools().find(t => t.name === name).inputSchema, input);
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
  process.stdin.once('end', () => { void jobs.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await jobs.close(); await server.close(); process.exit(0); });
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error.code === 'ERR_MODULE_NOT_FOUND' ? 'MCP 需要可选依赖：在 zee-rp 目录运行 npm ci --ignore-scripts。核心 CLI 无需安装依赖。' : error.message);
  process.exitCode = 1;
}
