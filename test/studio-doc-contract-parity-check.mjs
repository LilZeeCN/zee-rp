#!/usr/bin/env node
/**
 * 文档与公开工具面一致性门禁（Batch 6 B6.4）：
 *  1. 锁定公开 MCP 工具总数为 72（其中 studioTools 精确为 13 个动词化工具）
 *  2. 断言 SKILL.md、studio/authoring-help.mjs（全部 6 个 topic 返回值）、studioTools schema 及现行 docs/*.md 中
 *     出现的每一个 studio_* 标识符都属于公开注册的 13 个 studioTools，杜绝已删旧工具名残留误导 AI
 *  3. 断言上述活跃入口中不再残留已删裸工具名（get_design_context / run_scenario / apply_commands 等）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioTools } from '../studio/mcp-adapter.mjs';
import { describeAuthoring } from '../studio/authoring-help.mjs';
import { listMcpTools, jobTools } from '../scripts/mcp-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ACTIVE_DOC_PATHS = [
  'SKILL.md',
  'studio/authoring-help.mjs',
  'docs/studio-ai-authoring.md',
  'docs/studio-design-workflow.md',
  'docs/studio-stages.md',
  'docs/studio-node-capabilities.md',
  'docs/studio-native-roundtrip.md',
  'docs/architecture.md',
  'docs/gaps.md',
];

const BANNED_LEGACY_BARE_NAMES = [
  'get_design_context',
  'run_scenario',
  'apply_commands',
  'query_nodes',
  'review_design',
  'prepare_media',
];

test('公开 MCP 工具面规模与 13 个 studio_* 动词锁定', () => {
  const allMcpTools = [...listMcpTools(), ...jobTools];
  assert.equal(studioTools.length, 13, `studioTools 应保持 13 个动词工具，实际为 ${studioTools.length}`);
  assert.equal(allMcpTools.length, 72, `公开 MCP 工具总数应为 72，实际为 ${allMcpTools.length}`);
});

test('SKILL.md、authoring-help、公开 schema 与现行文档零旧工具名残留', () => {
  const validStudioNames = new Set(studioTools.map(t => t.name));

  // 1) 检查 studioTools 自身描述与 schema
  const schemaText = JSON.stringify(studioTools);
  const schemaRefs = [...new Set([...schemaText.matchAll(/\bstudio_[a-z0-9_]+\b/g)].map(m => m[0]))];
  const invalidInSchema = schemaRefs.filter(name => !validStudioNames.has(name));
  assert.deepEqual(invalidInSchema, [], `studioTools schema 中残留了未公开的旧工具名: ${invalidInSchema.join(', ')}`);

  // 2) 检查 describeAuthoring 全部 6 个 topic 的动态输出
  for (const topic of ['workflow', 'rp1', 'command', 'node', 'design', 'craft']) {
    const out = JSON.stringify(describeAuthoring({ topic }));
    const refs = [...new Set([...out.matchAll(/\bstudio_[a-z0-9_]+\b/g)].map(m => m[0]))];
    const invalid = refs.filter(name => !validStudioNames.has(name));
    assert.deepEqual(invalid, [], `studio_describe(topic:${topic}) 返回了未公开的旧工具名: ${invalid.join(', ')}`);
    for (const legacy of BANNED_LEGACY_BARE_NAMES) {
      assert.ok(
        !new RegExp(`\\b${legacy}\\b`).test(out),
        `studio_describe(topic:${topic}) 仍残留已删旧工具名 "${legacy}"`
      );
    }
  }

  // 3) 检查所有活跃文档文件
  for (const relPath of ACTIVE_DOC_PATHS) {
    const absPath = join(ROOT, relPath);
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, 'utf8');
    const refs = [...new Set([...content.matchAll(/\bstudio_[a-z0-9_]+\b/g)].map(m => m[0]))];
    const invalid = refs.filter(name => !validStudioNames.has(name));
    assert.deepEqual(invalid, [], `${relPath} 中引用了不存在的 studio_* 工具名: ${invalid.join(', ')}`);

    if (relPath === 'SKILL.md' || relPath === 'studio/authoring-help.mjs' || relPath.startsWith('docs/studio-')) {
      for (const legacy of BANNED_LEGACY_BARE_NAMES) {
        assert.ok(
          !new RegExp(`\\b${legacy}\\b`).test(content),
          `${relPath} 中仍残留已删旧工具名 "${legacy}"`
        );
      }
    }
  }
});
