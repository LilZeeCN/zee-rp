import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PROFILES, jobTools, listMcpTools } from '../scripts/mcp-tools.mjs';

function toolsFor(profile) {
  const allow = MCP_PROFILES[profile];
  return [...listMcpTools({ profile }), ...(allow ? jobTools.filter(t => allow.has(t.name)) : jobTools)];
}

test('MCP schema character budgets stay disciplined across all profiles', () => {
  const budgets = {
    full: 35000,
    author: 28000,
    studio: 20000,
    core: 20000,
  };

  for (const [profile, limit] of Object.entries(budgets)) {
    const tools = toolsFor(profile);
    const total = JSON.stringify(tools).length;
    assert.ok(total <= limit, `Profile "${profile}" schema budget exceeded: ${total} > ${limit} chars`);
  }

  const fullTools = toolsFor('full');
  assert.equal(fullTools.length, 30, `Expected 30 tools in full profile, got ${fullTools.length}`);
  for (const tool of fullTools) {
    const len = JSON.stringify(tool).length;
    assert.ok(len <= 5000, `Tool "${tool.name}" schema exceeded per-tool cap: ${len} > 5000 chars`);
  }
});
