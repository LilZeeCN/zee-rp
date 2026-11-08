import test from 'node:test';
import assert from 'node:assert/strict';
// 全命令垃圾参数扫荡(figcraft junk-parameter sweep 的等价门禁,M-SWEEP):
// 对注册表里的每个命令 × 7 类垃圾输入,断言三层性质——
//   1) 永不裸异常(要么 ok:true 要么 ok:false 信封);
//   2) 失败信封 code 恒为 E_ 前缀;
//   3) 失败后文档逐字节不变(contentHash/appliedRevision),全局原型永不被污染。
// 纯函数层(applySingleCommand 直调,fix-plan/WAL 消费)另设辅矩阵:可抛,但抛出的
// 必须是带 E_* code 与 commandIndex 的 cmdError。
import { COMMAND_CONTRACTS } from '../studio/command-contracts.mjs';
import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore, applySingleCommand } from '../studio/commands.mjs';

// ---- 垃圾输入矩阵(7 类) ----
// 每类拿到命令的契约(required 字段与字段类型),构造一个候选命令;构造器返回 null 表示
// 该类垃圾对本命令不适用(如无对象字段的命令没有深嵌套面),跳过。
const DEEP = (() => { let node = { leaf: true }; for (let i = 0; i < 20000; i++) node = { n: node }; return node; })();
const JUNK_BUILDERS = [
  ['缺全部必填', (type, contract) => ({ type })],
  ['必填错类型', (type, contract) => {
    const cmd = { type };
    for (const field of contract.required) cmd[field] = typeof contract.properties[field]?.type === 'string' && contract.properties[field].type !== 'string' ? 'not-an-object' : 42;
    return cmd;
  }],
  ['必填为 null', (type, contract) => {
    const cmd = { type };
    for (const field of contract.required) cmd[field] = null;
    return cmd;
  }],
  ['对象字段喂数组', (type, contract) => {
    const cmd = { type };
    for (const field of contract.required) {
      const t = contract.properties[field]?.type;
      cmd[field] = t === 'object' ? [] : t === 'number' ? 'not-a-number' : t === 'string' ? { not: 'a-string' } : [];
    }
    return cmd;
  }],
  ['超深嵌套', (type, contract) => {
    const objectFields = contract.required.filter(f => contract.properties[f]?.type === 'object');
    if (!objectFields.length) return null;
    const cmd = { type };
    for (const field of objectFields) cmd[field] = DEEP;
    return cmd;
  }],
  ['__proto__ 自有键', (type, contract) => {
    const objectFields = Object.keys(contract.properties).filter(f => contract.properties[f]?.type === 'object').slice(0, 2);
    if (!objectFields.length) return null;
    // 顶层与对象字段均用 JSON 形态注入自有 __proto__(真实攻击面来自 JSON 输入)
    const poisoned = JSON.parse('{"__proto__":{"__sweepMarker":true}}');
    const cmd = JSON.parse(`{"type":${JSON.stringify(type)},"__proto__":{"__sweepMarker":true}}`);
    for (const field of objectFields) cmd[field] = { ...poisoned };
    return cmd;
  }],
  ['超大数', (type, contract) => {
    const cmd = { type };
    for (const field of contract.required) {
      const t = contract.properties[field]?.type;
      cmd[field] = t === 'number' ? 1e15 : t === 'object' ? { w: 1e15, x: -1e15, h: Number.MAX_VALUE } : 'ok';
    }
    return cmd;
  }],
];

const freshStore = () => new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
const GLOBAL_MARK = '__sweepMarker';

function runCase(store, payload) {
  const hash = store.doc.contentHash, rev = store.appliedRevision;
  let result, threw = null;
  try {
    result = store.applyTransaction({ baseRevision: rev, idempotencyKey: `sweep-${Math.random()}`, commands: [payload] });
  } catch (err) { threw = err; }
  // 1) 永不裸异常
  assert.ok(!threw, `裸异常 ${threw?.constructor?.name}: ${threw?.message?.slice(0, 160)}`);
  // 3) 全局原型永不被污染(JSON 形态自有 __proto__ 经任何路径不得改写 Object.prototype)
  assert.equal(({}[GLOBAL_MARK]), undefined, '全局 Object.prototype 被污染');
  if (result.ok) {
    assert.equal(store.appliedRevision, rev + 1, '成功事务恰好推进一版');
  } else {
    // 2) 失败信封 code 恒为 E_ 前缀
    assert.match(String(result.code), /^E_/, `失败信封 code=${result.code}`);
    assert.equal(store.doc.contentHash, hash, '失败后文档哈希变化');
    assert.equal(store.appliedRevision, rev, '失败后版本推进');
  }
  return result;
}

for (const [type, contract] of Object.entries(COMMAND_CONTRACTS)) {
  test(`M-SWEEP ${type}:7 类垃圾输入均产出干净信封且不污染`, () => {
    for (const [name, build] of JUNK_BUILDERS) {
      const payload = build(type, contract);
      if (payload === null) continue;
      const store = freshStore();
      let result;
      try { result = runCase(store, payload); } catch (err) {
        err.message = `垃圾类「${name}」 payload=${safePreview(payload)} → ${err.message}`;
        throw err;
      }
      // 原型污染局部面:文档关键容器原型必须仍是 Object.prototype
      assert.equal(Object.getPrototypeOf(store.doc.tokens || {}), Object.prototype, `垃圾类「${name}」 doc.tokens 原型被改写`);
      assert.equal(Object.getPrototypeOf(store.doc.variables || {}), Object.prototype, `垃圾类「${name}」 doc.variables 原型被改写`);
      assert.equal(Object.getPrototypeOf(store.doc.datasets || {}), Object.prototype, `垃圾类「${name}」 doc.datasets 原型被改写`);
      assert.equal(Object.getPrototypeOf(store.doc.components || {}), Object.prototype, `垃圾类「${name}」 doc.components 原型被改写`);
    }
  });
}

function safePreview(payload) {
  try { const s = JSON.stringify(payload); return s.length > 200 ? `${s.slice(0, 200)}…` : s; } catch { return '[unserializable]'; }
}

test('M-SWEEP 辅矩阵:applySingleCommand 直调层可抛,但必须是带 E_* code 的 cmdError', () => {
  for (const [type, contract] of Object.entries(COMMAND_CONTRACTS)) {
    const cmd = { type };
    for (const field of contract.required) cmd[field] = null;
    const doc = createEmptyStudioDocument({ domain: 'web' });
    let threw = null;
    try {
      applySingleCommand(doc, structuredClone(cmd), 3, null, null, null, {});
    } catch (err) { threw = err; }
    if (threw) {
      assert.match(String(threw.code), /^E_/, `${type} 直调层裸异常缺 E_ code: ${threw.message?.slice(0, 120)}`);
      assert.equal(typeof threw.commandIndex, 'number', `${type} 直调层异常缺 commandIndex`);
    }
    // 返回(垃圾恰好合法)也接受;纯函数层无原子性承诺,由 store 层守护。
  }
});
