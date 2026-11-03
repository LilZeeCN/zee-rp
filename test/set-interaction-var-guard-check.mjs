/**
 * W8 2026-11-02：setInteraction 的 set-var 写入时变量校验（复检 r214 缺口）。
 * 正例：声明变量后挂 set-var → ok；负例：未声明 → E_VARIABLE 整批拒绝，零写入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioDocumentStore } from '../studio/commands.mjs';
import { createEmptyStudioDocument } from '../studio/document.mjs';
import { StudioRuntimeSession } from '../studio/runtime.mjs';
import { describeAuthoring } from '../studio/authoring-help.mjs';

const fresh = () => {
  const store = new StudioDocumentStore(createEmptyStudioDocument({ domain: 'mobile' }));
  const added = store.applyTransaction({ commands: [{ type: 'addNode', node: { type: 'button', id: 'btn', x: 10, y: 10, w: 120, h: 44, text: '计数' } }] });
  assert.equal(added.ok, true, JSON.stringify(added));
  return store;
};

test('public interaction guide executes all three words and cross-page restart in one transaction', () => {
  const store = fresh();
  const guide = describeAuthoring({ topic: 'workflow' }).interactionGuide;
  const result = store.applyTransaction({ commands: guide.example.commands });
  assert.equal(result.ok, true, JSON.stringify(result));
  const scenario = new StudioRuntimeSession(store.doc).runScenario(guide.example.scenario);
  assert.equal(scenario.ok, true, JSON.stringify(scenario));
  assert.equal(scenario.totalSteps, 4);
  assert.equal(scenario.assertionCount, 8);
});

test('conditions reject unknown variables, malformed expressions and mismatched comparisons before writing', () => {
  for (const [when, code] of [['=$missing === 1', 'E_VARIABLE'], ['=$count === "1"', 'E_TYPE'], ['=(', 'E_EXPRESSION'], ['=$count + 1', 'E_TYPE'], [{ variable: 'count', equals: 1 }, 'E_CONDITION']]) {
    const store = fresh();
    store.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
    const before = store.doc.contentHash;
    const result = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', actions: { cases: [{ when, actions: [{ type: 'set-var', name: 'count', value: 1 }] }] } }] });
    assert.equal(result.code, code, JSON.stringify(result));
    assert.match(result.field, /when/);
    assert.equal(store.doc.contentHash, before);
  }
});

test('condition aliases and missing equals markers normalize; scenarios explain the chosen branch', () => {
  const store = fresh();
  const result = store.applyTransaction({ commands: [
    { type: 'set-variable', name: 'count', value: 0 },
    { type: 'setInteraction', nodeId: 'btn', actions: { cases: [
      { condition: '$count === 1', actions: [{ type: 'set-var', name: 'count', value: 9 }] },
      { when: 'false', actions: [{ type: 'set-var', name: 'count', value: 8 }] },
      { when: 'else', actions: [{ type: 'set-var', name: 'count', value: 1 }] },
    ] } },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const runtime = new StudioRuntimeSession(store.doc);
  const scenario = runtime.runScenario([{ action: 'click', target: 'btn', expect: { variables: { count: 1 } } }]);
  assert.equal(scenario.ok, true, JSON.stringify(scenario));
  assert.deepEqual(scenario.stepResults[0].executed.filter(item => item.action === 'condition').map(item => item.matched), [false, false, true]);
  assert.equal(scenario.stepResults[0].executed[0].value, false);
});

test('RP/1 text functions and bare variables execute without rewriting quoted references', () => {
  const store = fresh();
  const result = store.applyTransaction({ commands: [
    { type: 'set-variable', name: 'count', value: 2 },
    { type: 'set-variable', name: 'copy', value: '' },
    { type: 'setInteraction', nodeId: 'btn', actions: [{ type: 'set-var', name: 'copy', value: '=concat("literal $count @btn ", upper("ok"), text(count + 1))' }] },
  ] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const runtime = new StudioRuntimeSession(store.doc);
  runtime.click('btn');
  assert.equal(runtime.variables.copy, 'literal $count @btn OK3');
});

test('未声明变量的 set-var 在写入时被 E_VARIABLE 拒绝且零写入', () => {
  const store = fresh();
  const bad = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', event: 'click', actions: [{ type: 'set-var', name: 'undeclared_count', value: '1' }] }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_VARIABLE');
  assert.match(bad.message, /undeclared_count/);
  assert.match(String(bad.suggestion || ''), /set-variable/);
  const findById = (n, id) => n.id === id ? n : (n.children || []).map(c => findById(c, id)).find(Boolean);
  const node = store.doc.pages.flatMap(p => [p.root || { children: p.children || [] }]).map(r => findById(r, 'btn')).find(Boolean);
  assert.ok(node, 'btn 节点应存在');
  assert.equal((node.on && node.on.click) || undefined, undefined, '交互不得写入');
});

test('声明变量后 set-var 正常写入', () => {
  const store = fresh();
  const decl = store.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
  assert.equal(decl.ok, true, JSON.stringify(decl));
  const good = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', event: 'click', actions: [{ type: 'set-var', name: 'count', value: 1 }] }] });
  assert.equal(good.ok, true, JSON.stringify(good));
  const findById = (n, id) => n.id === id ? n : (n.children || []).map(c => findById(c, id)).find(Boolean);
  const node = store.doc.pages.flatMap(p => [p.root || { children: p.children || [] }]).map(r => findById(r, 'btn')).find(Boolean);
  assert.ok(node, 'btn 节点应存在');
  assert.equal(node.on.click[0].type, 'set-var');
});

test('已声明变量但值类型不符：写入时 E_TYPE 拒绝（W8 评分B 拦路项）', () => {
  const store = fresh();
  const decl = store.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
  assert.equal(decl.ok, true, JSON.stringify(decl));
  const bad = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', event: 'click', actions: [{ type: 'set-var', name: 'count', value: '1' }] }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_TYPE');
  assert.match(bad.message, /number/);
  assert.match(String(bad.suggestion || ''), /set-variable|字面量/);
  const findById = (n, id) => n.id === id ? n : (n.children || []).map(c => findById(c, id)).find(Boolean);
  const node = store.doc.pages.flatMap(p => [p.root || { children: p.children || [] }]).map(r => findById(r, 'btn')).find(Boolean);
  assert.equal((node.on && node.on.click) || undefined, undefined, '类型不符的交互不得写入');
});

test('类型匹配的正例不受影响（number 变量 + number 值）', () => {
  const store = fresh();
  store.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
  const good = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', event: 'click', actions: [{ type: 'set-var', name: 'count', value: 2 }] }] });
  assert.equal(good.ok, true, JSON.stringify(good));
});

test('数值公式及 expr 别名可以写入并计算，嵌套和简写的未声明变量仍会被拒绝', () => {
  for (const action of [
    { type: 'set-var', name: 'count', value: '=$count + 1' },
    { type: 'set-var', name: 'count', expr: '=$count + 1' },
  ]) {
    const store = fresh();
    store.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
    const result = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', event: 'click', actions: [action] }] });
    assert.equal(result.ok, true, JSON.stringify(result));
    const runtime = new StudioRuntimeSession(store.doc);
    runtime.click('btn');
    assert.equal(runtime.variables.count, 1);
  }
  for (const action of [
    { cases: [{ when: true, actions: [{ type: 'set-var', name: 'missing', value: 1 }] }] },
    { setVar: { missing: 1 } },
  ]) {
    const store = fresh();
    const result = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', event: 'click', actions: [action] }] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_VARIABLE');
  }
});

test('text() 公式使用 RP/1 text 类型，合法写入口不被 Studio string 类型误拒', () => {
  for (const command of [
    { type: 'setInteraction', nodeId: 'btn', actions: [{ type: 'set-var', name: 'label', value: '=text($count)' }] },
    { type: 'addNode', node: { id: 'other_button', type: 'button', text: 'Test', w: 100, h: 40, on: { click: [{ type: 'set-var', name: 'label', value: '=text($count)' }] } } },
    { type: 'setProperties', nodeId: 'btn', properties: { on: { click: [{ type: 'set-var', name: 'label', value: '=text($count)' }] } } },
  ]) {
    const store = fresh();
    const declared = store.applyTransaction({ commands: [
      { type: 'set-variable', name: 'count', value: 0 },
      { type: 'set-variable', name: 'label', value: '' },
    ] });
    assert.equal(declared.ok, true, JSON.stringify(declared));
    const result = store.applyTransaction({ commands: [command] });
    assert.equal(result.ok, true, JSON.stringify(result));
  }

  const store = fresh();
  store.applyTransaction({ commands: [
    { type: 'set-variable', name: 'count', value: 0 },
    { type: 'set-variable', name: 'label', value: '' },
    { type: 'setInteraction', nodeId: 'btn', actions: [{ type: 'set-var', name: 'label', value: '=text($count)' }] },
  ] });
  const runtime = new StudioRuntimeSession(store.doc);
  runtime.click('btn');
  assert.equal(runtime.variables.label, '0');
});

test('确定错误的表达式及其他写入口的未声明变量被拒绝', () => {
  for (const [value, code] of [['=true', 'E_TYPE'], ['=(', 'E_EXPRESSION']]) {
    const store = fresh();
    store.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
    const result = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', actions: [{ type: 'set-var', name: 'count', value }] }] });
    assert.equal(result.code, code, JSON.stringify(result));
  }
  for (const [value, code] of [['=Number($count)', 'E_FUNCTION'], ['=missing + 1', 'E_VARIABLE'], ['=/count/', 'E_EXPRESSION']]) {
    const store = fresh();
    store.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
    const result = store.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', actions: [{ type: 'set-var', name: 'count', value }] }] });
    assert.equal(result.code, code, JSON.stringify(result));
  }
  const action = { click: [{ type: 'set-var', name: 'missing', value: 1 }] };
  for (const command of [
    { type: 'addNode', node: { id: 'other', type: 'button', text: 'Test', w: 100, h: 40, on: action } },
    { type: 'setProperties', nodeId: 'btn', properties: { on: action } },
  ]) {
    const result = fresh().applyTransaction({ commands: [command] });
    assert.equal(result.code, 'E_VARIABLE', JSON.stringify(result));
  }
});

test('静态类型不匹配在写入时拒绝，历史坏数据在运行时仍有第二道防线', () => {
  const rejected = fresh();
  rejected.applyTransaction({ commands: [{ type: 'set-variable', name: 'count', value: 0 }] });
  const bad = rejected.applyTransaction({ commands: [{ type: 'setInteraction', nodeId: 'btn', actions: [{ type: 'set-var', name: 'count', value: '=$count > 0' }] }] });
  assert.equal(bad.code, 'E_TYPE', JSON.stringify(bad));

  const store = new StudioDocumentStore(createEmptyStudioDocument());
  const added = store.applyTransaction({ commands: [
    { type: 'addNode', node: { id: 'btn', type: 'button', w: 100, h: 40, on: { click: [{ type: 'set-var', name: 'count', value: '=$count' }] } } },
    { type: 'set-variable', name: 'count', value: 0 },
  ] });
  assert.equal(added.ok, true, JSON.stringify(added));
  const runtime = new StudioRuntimeSession(store.doc);
  runtime.click('btn');
  assert.equal(runtime.variables.count, 0);

  const historical = structuredClone(store.doc);
  historical.pages[0].root.children.find(node => node.id === 'home_screen').children.find(node => node.id === 'btn').on.click[0].value = '=true';
  assert.throws(() => new StudioRuntimeSession(historical).click('btn'), { code: 'E_TYPE' });
});
