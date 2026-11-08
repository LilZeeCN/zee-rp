import assert from 'node:assert/strict';
import test from 'node:test';
// 命令注册表三方 parity(figcraft xtask parity 的等价门禁):
// 分组表(COMMAND_TYPES_BY_GROUP)↔ 派生全集(VALID_COMMAND_TYPES)↔ dispatch 表(COMMAND_HANDLERS)
// ↔ 字段契约(COMMAND_CONTRACTS)必须精确一致。新增命令只改一处,其余面由本门禁强制同步。
import { COMMAND_TYPES_BY_GROUP, VALID_COMMAND_TYPES, COMMAND_HANDLERS } from '../studio/commands.mjs';
import { COMMAND_CONTRACTS } from '../studio/command-contracts.mjs';

test('命令注册表三方 parity:分组表、dispatch 表与字段契约精确覆盖同一命令全集', () => {
  // 1. 分组表无重复(同一类型出现在两组会让文档口径与 MCP enum 漂移)
  const flat = Object.values(COMMAND_TYPES_BY_GROUP).flat();
  const seen = new Set();
  for (const type of flat) {
    assert.ok(!seen.has(type), `命令类型 ${type} 在 COMMAND_TYPES_BY_GROUP 中重复出现`);
    seen.add(type);
  }
  // 2. 派生全集与分组表一致
  assert.deepEqual(VALID_COMMAND_TYPES, flat);
  // 3. dispatch 表双向精确覆盖注册表(缺处理器=运行时落 default 报错;多出的键=死处理器)
  const handlerKeys = new Set(Object.keys(COMMAND_HANDLERS));
  for (const type of VALID_COMMAND_TYPES) {
    assert.ok(handlerKeys.has(type), `命令 ${type} 在 COMMAND_HANDLERS 中缺少 dispatch 处理器`);
  }
  for (const key of handlerKeys) {
    assert.ok(VALID_COMMAND_TYPES.includes(key), `COMMAND_HANDLERS 存在注册表外的键 ${key}(死处理器)`);
  }
  // 4. 字段契约覆盖所有命令(含别名),且不包含注册表外的键
  const contractKeys = new Set(Object.keys(COMMAND_CONTRACTS));
  for (const type of VALID_COMMAND_TYPES) {
    assert.ok(contractKeys.has(type), `命令 ${type} 在 COMMAND_CONTRACTS 中缺少字段契约`);
  }
  for (const key of contractKeys) {
    assert.ok(VALID_COMMAND_TYPES.includes(key), `COMMAND_CONTRACTS 存在注册表外的键 ${key}`);
  }
});
