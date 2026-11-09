import test from 'node:test';
import assert from 'node:assert/strict';
// 批处理步引用(figcraft batch 语义):as 命名本步产出,后续步骤 {"$ref":name} 引用;
// 整批一个事务、一次 undo;WAL 重放消费解析后命令;未注册/歧义引用显式报错。
import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioDocumentStore } from '../studio/commands.mjs';

const apply = (store, commands) => store.applyTransaction({ baseRevision: store.appliedRevision, commands });
const seed = () => {
  const s = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'web' }));
  assert(apply(s, [{ type: 'addNode', node: { id: 'root-card', type: 'box', w: 300, h: 200 } }]).ok);
  return s;
};
const pageRoot = s => s.doc.pages[0].root;

test('as 命名 addNode 产出,后续步骤 $ref 引用,整批一次 undo', () => {
  const s = seed();
  const base = s.doc.contentHash, rev = s.appliedRevision;
  const result = apply(s, [
    { type: 'addNode', as: 'card', pageId: 'home', node: { type: 'box', w: 200, h: 120 } },
    { type: 'addNode', as: 'title', parentId: { $ref: 'card' }, node: { type: 'label', id: 'inside', text: 'hi', w: 80, h: 20 } },
    { type: 'setText', nodeId: { $ref: 'title' }, text: 'renamed via ref' },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.message || ''));
  const card = pageRoot(s).children.find(n => n.id !== 'root-card');
  assert.ok(card, 'card 节点存在');
  assert.equal(card.children?.[0]?.id, 'inside', '子节点通过 $ref parentId 挂进卡片');
  assert.equal(card.children[0].text, 'renamed via ref', 'setText 通过 $ref 命中子 label');
  // 整批一个事务:一次 undo 全退(undo 产生新修订号,内容哈希回到基线)
  const undo = s.undo({ expectedRevision: s.doc.revision });
  assert.equal(undo.ok, true);
  assert.equal(s.doc.contentHash, base);
  assert.equal(s.appliedRevision, rev + 2, 'undo 是一步:撤销后的修订号 = 基线 + 2');
});

test('$ref 解析的是 scoped id,自动生成的 id 可被引用', () => {
  const s = seed();
  const result = apply(s, [
    { type: 'addNode', as: 'auto', pageId: 'home', node: { type: 'label', text: 'auto', w: 60, h: 20 } },
    { type: 'renameNode', nodeId: { $ref: 'auto' }, name: 'auto-renamed' },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.message || ''));
  const auto = pageRoot(s).children.find(n => n.name === 'auto-renamed');
  assert.ok(auto, '自动 id 节点被 $ref 命中并改名');
  assert.match(auto.id, /^label_r/, 'addNode 自动 id 形态');
});

test('未注册引用报 E_REF_NOT_FOUND,文档不变', () => {
  const s = seed();
  const hash = s.doc.contentHash, rev = s.appliedRevision;
  const result = apply(s, [{ type: 'setText', nodeId: { $ref: 'nope' }, text: 'x' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_REF_NOT_FOUND');
  assert.equal(s.doc.contentHash, hash);
  assert.equal(s.appliedRevision, rev);
});

test('命名步骤的额外字段仍按自有属性校验，失败时整批不写入', () => {
  const store = seed();
  const { revision, contentHash } = store.doc;
  const invalid = JSON.parse('{"type":"moveNode","as":"move","nodeId":"home/root-card","__proto__":{"x":99}}');
  const result = apply(store, [
    { type: 'addNode', as: 'new', node: { id: 'new', type: 'label', text: 'new' } },
    invalid,
  ]);
  assert.equal(result.code, 'E_COMMAND_FIELD');
  assert.equal(result.field, '__proto__');
  assert.equal(result.failedCommandIndex, 1);
  assert.equal(store.doc.revision, revision);
  assert.equal(store.doc.contentHash, contentHash);
});

test('前向引用(引用后面步骤的 as 名)报 E_REF_NOT_FOUND', () => {
  const s = seed();
  const hash = s.doc.contentHash;
  const result = apply(s, [
    { type: 'setText', nodeId: { $ref: 'later' }, text: 'x' },
    { type: 'addNode', as: 'later', pageId: 'home', node: { type: 'label', text: 'later', w: 40, h: 16 } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_REF_NOT_FOUND');
  assert.equal(s.doc.contentHash, hash, '整批未写入');
});

test('多产出引用报 E_REF_AMBIGUOUS 并列候选', () => {
  const s = seed();
  const result = apply(s, [
    { type: 'pasteNodes', as: 'pasted', pageId: 'home', nodes: [
      { type: 'label', id: 'p1', text: 'a', w: 40, h: 16 },
      { type: 'label', id: 'p2', text: 'b', w: 40, h: 16 },
    ] },
    { type: 'setText', nodeId: { $ref: 'pasted' }, text: 'x' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_REF_AMBIGUOUS');
  assert.ok(Array.isArray(result.candidates) && result.candidates.length === 2, '候选含两个 scoped id');
});

test('as/$ref 不进入事务记录:WAL 重放面是解析后命令,可在新 store 上原样重放', () => {
  const s = seed();
  const commands = [
    { type: 'addNode', as: 'card', pageId: 'home', node: { type: 'box', w: 120, h: 80 } },
    { type: 'addNode', as: 'title', parentId: { $ref: 'card' }, node: { type: 'label', text: 'persisted', w: 80, h: 20 } },
  ];
  const result = apply(s, commands);
  assert.equal(result.ok, true);
  const tx = s.history.at(-1);
  for (const cmd of tx.commands) {
    assert.equal(cmd.as, undefined, 'txRecord.commands 不含 as');
    assert.equal(JSON.stringify(cmd).includes('"$ref"'), false, 'txRecord.commands 不含 $ref');
  }
  // 用解析后命令在本事务 beforeSnapshot 的克隆上重放,内容哈希一致(WAL 崩溃恢复路径的等价证明)
  const replay = new StudioDocumentStore(structuredClone(tx.beforeSnapshot));
  const replayResult = apply(replay, tx.commands);
  assert.equal(replayResult.ok, true);
  assert.equal(replay.doc.contentHash, s.doc.contentHash);
});

test('幂等重放不受 $ref 影响:同一原始请求重放命中 idempotentReplay', () => {
  const s = seed();
  const request = { baseRevision: s.appliedRevision, idempotencyKey: 'ref-idem', commands: [
    { type: 'addNode', as: 'title', pageId: 'home', node: { type: 'label', w: 100, h: 24 } },
    { type: 'setText', nodeId: { $ref: 'title' }, text: 'same' },
  ] };
  const first = s.applyTransaction(request);
  assert.equal(first.ok, true, JSON.stringify(first.message || ''));
  const second = s.applyTransaction(request);
  assert.equal(second.ok, true);
  assert.equal(second.idempotentReplay, true);
  assert.equal(s.appliedRevision, first.appliedRevision, '重放不推进版本');
});

test('$ref 深层可用:node.id、beforeId、properties 内层均解析', () => {
  const s = seed();
  const result = apply(s, [
    { type: 'addNode', as: 'a', pageId: 'home', node: { type: 'box', id: 'node-a', w: 50, h: 50 } },
    { type: 'addNode', pageId: 'home', node: { type: 'box', id: 'node-b', w: 50, h: 50 } },
    { type: 'reorderNode', nodeId: 'node-b', parentId: 'node-a', toIndex: 0 },
    { type: 'addNode', pageId: 'home', node: { type: 'label', id: 'deep', text: 'x', w: 40, h: 16 } },
    { type: 'setProperties', nodeId: { $ref: 'a' }, properties: { on: { click: [{ type: 'set-text', target: { $ref: 'a' }, value: 'clicked' }] } } },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.message || ''));
});
