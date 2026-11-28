import { sessionTools } from '../../scripts/mcp-tools.mjs';
import { studioHandlers } from '../../studio/mcp-adapter.mjs';

process.once('message', async ({ operation, input, value }) => {
  try {
    const result = operation === 'studio'
      ? await studioHandlers.studio_command({ ...input, idempotencyKey: value,
        commands: [{ type: 'setText', pageId: 'home', nodeId: 'title', text: value }] })
      : await sessionTools.find(tool => tool.name === 'revise_prototype').handler({
        ...input, operations: [{ target: 'home/title', property: 'text', value }],
      });
    process.send({ answer: result });
  } catch (error) {
    process.send({ answer: { status: 'failed', code: error.code, message: error.message } });
  }
});
process.send('ready');
