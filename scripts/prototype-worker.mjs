// A generation job has its own process, keeping the stdio MCP responsive.
import { generatePrototype, callCommandTool } from './mcp-tools.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertNotProtected } from './engine.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { type, arguments: args, inputHashes } = JSON.parse(input);
  delete args.async;
  const unchanged = () => {
    for (const [path, hash] of Object.entries(inputHashes)) {
      assertNotProtected(path);
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash)
        throw Object.assign(new Error('排队或生成期间输入已变化：' + path), { code: 'E_STALE_JOB_INPUT',
          diagnostics: [{ code: 'E_STALE_JOB_INPUT', pointer: '/source', message: '排队或生成期间输入已变化，请以最新内容重新提交。' }] });
    }
  };
  unchanged();
  const result = type === 'revise-prototype'
    ? callCommandTool('revise_prototype', args).structuredContent
    : generatePrototype(args, { beforePublish: unchanged });
  process.stdout.write(JSON.stringify(result));
  process.exitCode = ['completed', 'merged', 'planned'].includes(result.status) ? 0 : 1;
} catch (error) {
  process.stdout.write(JSON.stringify({ status: 'failed', diagnostics: [{ code: error.code ?? 'E_GENERATION_WORKER',
    message: error.message, nextAction: '保留失败现场，检查源码与环境后重试。' }] }));
  process.exitCode = 1;
}
