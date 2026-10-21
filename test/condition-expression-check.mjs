import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { TEST_DIR } from './fixture-summary.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { addInteractions, WIDGET_PATH_FCALLS, FCALL_SPECS } from '../scripts/ix-actions.mjs';

export async function runConditionExpressionChecks() {
  const results = [];
  // async-aware：run() 可能是 async，必须 await 才能捕获 rejection。
  const check = async (name, run) => {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error.message }); }
  };

  await check('nested BinaryExpr and multi-argument FCall serialization', () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{
        when: {
          op: '&&',
          left: { fn: 'ValueContains', args: [{ value: 'alphabet' }, { value: 'pha' }] },
          right: { op: '==', left: { fn: 'ToLowerCase', args: [{ value: 'HELLO' }] }, right: { value: 'hello' } },
        },
        actions: [{ type: 'wait', ms: 1 }],
      }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const condition = [...graph.objects.values()].find(object => {
      if (object.className !== 'Axure:Expr:BinaryExpr') return false;
      const left = graph.objects.get(field(object.body, 'left-expr').value);
      return left?.className === 'Axure:Expr:FCall' && field(left.body, 'function-name').text === 'ValueContains';
    });
    assert.ok(condition, 'nested condition was not serialized');
    assert.equal(condition.className, 'Axure:Expr:BinaryExpr');
    assert.equal(field(condition.body, 'operation').value, 1);

    const left = graph.objects.get(field(condition.body, 'left-expr').value);
    assert.equal(left.className, 'Axure:Expr:FCall');
    assert.equal(field(left.body, 'function-name').text, 'ValueContains');
    assert.equal(field(left.body, 'args').items.length, 2);

    const right = graph.objects.get(field(condition.body, 'right-expr').value);
    assert.equal(right.className, 'Axure:Expr:BinaryExpr');
    assert.equal(field(right.body, 'operation').value, 3);
    const rightLeft = graph.objects.get(field(right.body, 'left-expr').value);
    assert.equal(field(rightLeft.body, 'function-name').text, 'ToLowerCase');
  });

  await check('reject incomplete nested BinaryExpr before output', () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{
        when: { op: '&&', left: { op: '==', left: { value: 'x' } }, right: { value: 'true' } },
        actions: [{ type: 'wait', ms: 1 }],
      }],
    }]), /nested condition expressions require both left and right sides/);
  });

  await check('set-text selects the native TextBox or VectorShape function', () => {
    const cases = [
      { file: 'var-set-from-widget-roundtrip.rp', target: 'NATIVE_TEXT_FIELD', expected: 'SetWidgetFormText', value: 'TEXTBOX_WRITE_TEST' },
      { file: 'var-set-counter-roundtrip.rp', target: 'VALUE_PREVIEW', expected: 'SetWidgetRichText', value: 'VECTOR_WRITE_TEST' },
    ];
    for (const item of cases) {
      const source = readFileSync(join(TEST_DIR, 'fixtures', item.file));
      const { file } = addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        actions: [{ type: 'set-text', target: item.target, text: item.value }],
      }], { replaceEvent: true });
      const page = readRecords(file).find(record => record.className === 'Axure:Page');
      const graph = parsePayload(page);
      const call = [...graph.objects.values()].find(object => {
        if (object.className !== 'Axure:Expr:FCall' || field(object.body, 'function-name').text !== item.expected) return false;
        return field(object.body, 'args').items.some(arg => {
          const value = graph.objects.get(arg.value);
          return value?.className === 'Axure:Expr:StringLiteral' && field(value.body, 'value').text === item.value;
        });
      });
      assert.ok(call, `${item.target} did not use ${item.expected}`);
      if (item.expected === 'SetWidgetRichText') {
        const args = field(call.body, 'args').items;
        assert.equal(args.length, 3);
        assert.equal(graph.objects.get(args[2].value).className, 'Axure:Expr:BooleanLiteral');
      }
    }
  });

  await check('FCall function names outside the static registry are rejected', async () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'MadeUpFunction', args: [{ value: 'x' }] }, right: { value: 'y' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /Unknown FCall function "MadeUpFunction"/);
    const { REGISTERED_FCALLS } = await import('../scripts/ix-actions.mjs');
    // 不写死数量（注册表会随版本扩充）；只断言下界与关键成员存在。
    assert.ok(REGISTERED_FCALLS.size >= 18, `REGISTERED_FCALLS.size=${REGISTERED_FCALLS.size} < 18`);
    for (const name of ['GetWidgetText', 'IsValueNumeric', 'IsValueOneOf', 'GetGlobalVariableValue', 'ToLowerCase', 'ValueNotContains'])
      assert.ok(REGISTERED_FCALLS.has(name), name + ' missing');
  });

  await check('FCall argument arity mismatch is rejected before serialization', async () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'ValueContains', args: [{ value: 'abc' }] }, right: { value: 'y' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /FCall function "ValueContains" expects 2 arguments, received 1/);

    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'ToLowerCase', args: [{ value: 'a' }, { value: 'b' }] }, right: { value: 'y' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /FCall function "ToLowerCase" expects 1 argument, received 2/);

    const { FCALL_ARITIES } = await import('../scripts/ix-actions.mjs');
    assert.ok(Object.keys(FCALL_ARITIES).length >= 18, `FCALL_ARITIES=${Object.keys(FCALL_ARITIES).length} < 18`);
    assert.equal(FCALL_ARITIES.ValueContains, 2);
    assert.equal(FCALL_ARITIES.ToLowerCase, 1);
  });

  await check('{variable} condition side resolves to GetGlobalVariableValue FCall and GlobalVariableLiteral', () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{
        when: { op: '==', left: { variable: 'DemoValue' }, right: { value: '0' } },
        actions: [{ type: 'wait', ms: 10 }],
      }],
    }], { replaceEvent: true });

    const page = readRecords(file).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const call = [...graph.objects.values()].find(o => o.className === 'Axure:Expr:FCall' && field(o.body, 'function-name')?.text === 'GetGlobalVariableValue');
    assert.ok(call, 'GetGlobalVariableValue FCall was not created');
    const args = field(call.body, 'args').items;
    assert.equal(args.length, 1);
    const varLit = graph.objects.get(args[0].value);
    assert.equal(varLit.className, 'Axure:Expr:GlobalVariableLiteral');
    assert.equal(field(varLit.body, 'variable-name').text, 'DemoValue');
    assert.equal(field(varLit.body, 'is-dummy').value, false);

    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { variable: 'NonExistentVar' }, right: { value: '0' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /Expected exactly one global variable named "NonExistentVar", found 0/);
  });

  await check('FCall {widget, fn} gate rejects non-widget functions and unknown functions', () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    // 负例 1: 传两参函数 ValueContains 到单一元件路径入口
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { widget: 'SET_BUTTON', fn: 'ValueContains' }, right: { value: '0' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /does not accept a single widget target path/);

    // 负例 2: 传变量函数 GetGlobalVariableValue 到元件路径入口
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { widget: 'SET_BUTTON', fn: 'GetGlobalVariableValue' }, right: { value: '0' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /does not accept a single widget target path/);

    // 正例: 合法元件路径函数 GetWidgetVisibility 正确构造
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { widget: 'SET_BUTTON', fn: 'GetWidgetVisibility' }, right: { value: 'true' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(page);
    const visCall = [...graph.objects.values()].find(o => o.className === 'Axure:Expr:FCall' && field(o.body, 'function-name')?.text === 'GetWidgetVisibility');
    assert.ok(visCall, 'GetWidgetVisibility FCall not found');
    const args = field(visCall.body, 'args').items;
    assert.equal(args.length, 1);
    assert.equal(graph.objects.get(args[0].value).className, 'Axure:Expr:DiagramObjectPathLiteral');
  });

  await check('FCall argument category and shape contract enforcement', () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    // 负例 1: widgetPath 函数传纯 scalar
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'GetWidgetText', args: [{ value: 'plainText' }] }, right: { value: 'x' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /expects a widget target/);

    // 负例 2: globalVariable 函数传纯 scalar
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'GetGlobalVariableLength', args: [{ value: 'plainText' }] }, right: { value: '0' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /expects a global variable identifier/);

    // 负例 3: scalar 纯值函数传 widgetPath
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'IsValueNumeric', args: [{ widgetPath: 'SET_BUTTON' }] }, right: { value: 'true' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /expects a scalar expression or literal/);

    // 正例: GetGlobalVariableLength 传合法 globalVariable 标识
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'GetGlobalVariableLength', args: [{ globalVariable: 'DemoValue' }] }, right: { value: '1' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(page);
    const lenCall = [...graph.objects.values()].find(o => o.className === 'Axure:Expr:FCall' && field(o.body, 'function-name')?.text === 'GetGlobalVariableLength');
    assert.ok(lenCall, 'GetGlobalVariableLength FCall not found');
    const args = field(lenCall.body, 'args').items;
    assert.equal(args.length, 1);
    assert.equal(graph.objects.get(args[0].value).className, 'Axure:Expr:GlobalVariableLiteral');
  });

  await check('FCall candidate set now supported for IsValueOneOf and IsValueNotOneOf', () => {
    // 曾因「无原生 Literal 真值」明确拒绝。2026-10-16 定出形状后改为支持：
    //   第二参数 = Axure:Expr:ArrayExpr { items: [ <表达式>, ... ] }
    //   依据 ArrayExpr.rv2F/Bv2O 只序列化 `items`（REA），且 RP 9 原生预览实测行为正确。
    // **items 里不得套 OptionLiteral** —— 套了 RP 9 预览整页空白（7243 空白 vs 9024 正常）。
    // 参数形状不对（不是 { array: [...] }）仍必须报错，不能静默产出坏文件。
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    for (const fn of ['IsValueOneOf', 'IsValueNotOneOf']) {
      const out = addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ when: { op: '==', left: { fn, args: [{ value: 'a' }, { array: [{ value: 'a' }, { value: 'b' }] }] }, right: { value: 'true' } }, actions: [{ type: 'wait', ms: 1 }] }],
      }], { replaceEvent: true }).file;
      const kinds = [];
      for (const record of readRecords(out)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        for (const o of graph.objects.values()) kinds.push(o.className);
      }
      assert.equal(kinds.filter(k => k === 'Axure:Expr:ArrayExpr').length, 1, `${fn} 应产出 1 个 ArrayExpr`);
      assert.equal(kinds.filter(k => k === 'Axure:Expr:OptionLiteral').length, 0, `${fn} 不得套 OptionLiteral`);
    }
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ when: { op: '==', left: { fn: 'IsValueOneOf', args: [{ value: 'a' }, { value: 'b' }] }, right: { value: 'true' } }, actions: [{ type: 'wait', ms: 1 }] }],
    }], { replaceEvent: true }), /array/, '第二参数必须是 { array: [...] }');
  });

  await check('FCall runtime JS evaluation check for scalar validation and string functions', () => {
    const runtimePath = '/Applications/Axure RP 11.app/Contents/Resources/DefaultSettings/Prototype_Files/resources/scripts/axure/expr.js';
    if (!existsSync(runtimePath)) return;
    const code = readFileSync(runtimePath, 'utf8');
    const ax = { expr: {}, placeholderManager: { isActive: () => false }, visibility: {}, INPUT: () => '' };
    const sandbox = {
      $axure: { internal: fn => fn(ax) },
      $ax: ax,
      window: {},
      $jobj: () => ({ length: 0 }),
      RegExp, isNaN, Number, String, Boolean, Object, Array
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const evalExpr = (fn, ...rawArgs) => {
      const fcall = {
        exprType: 'fcall',
        functionName: fn,
        arguments: rawArgs.map(v => ({ exprType: 'stringLiteral', value: String(v), stos: [], localVariables: {} }))
      };
      return ax.expr.evaluateExpr(fcall, {});
    };

    // 单元纯值语义核验
    assert.equal(evalExpr('IsValueAlpha', 'helloWorld'), true);
    assert.equal(evalExpr('IsValueAlpha', 'hello123'), false);
    assert.equal(evalExpr('IsValueNumeric', '12345'), true);
    assert.equal(evalExpr('IsValueNumeric', '12a'), false);
    assert.equal(evalExpr('IsValueAlphaNumeric', 'abc123'), true);
    assert.equal(evalExpr('IsValueAlphaNumeric', 'abc!'), false);
    assert.equal(evalExpr('IsValueNotAlpha', '123'), true);
    assert.equal(evalExpr('IsValueNotNumeric', 'abc'), true);
    assert.equal(evalExpr('IsValueNotAlphaNumeric', 'abc#'), true);
    assert.equal(evalExpr('ToLowerCase', 'HELLO'), 'hello');
    assert.equal(evalExpr('ValueContains', 'axure-exp', 'exp'), true);
    assert.equal(evalExpr('ValueContains', 'axure-exp', 'xyz'), false);
    assert.equal(evalExpr('ValueNotContains', 'axure-exp', 'xyz'), true);
  });

  await check('condition side null、未定义操作符与歧义语义严谨拒绝', () => {
    const source = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));

    // 负例 1: side 为 null
    assert.throws(() => {
      addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ when: { left: null, right: { value: '1' } }, actions: [{ type: 'wait', ms: 1 }] }]
      }]);
    }, /condition side 不能为空/);

    // 负例 2: when 为 null
    assert.throws(() => {
      addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ when: null, actions: [{ type: 'wait', ms: 1 }] }]
      }]);
    }, /Condition "when" must be a non-null object/);

    // 负例 3: 歧义 side (同时包含 value 和 widget)
    assert.throws(() => {
      addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ when: { left: { value: 'x', widget: 'SET_BUTTON' }, right: { value: '1' } }, actions: [{ type: 'wait', ms: 1 }] }]
      }]);
    }, /Ambiguous condition side expression/);

    // 负例 4: 非法操作符
    assert.throws(() => {
      addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ when: { op: '===', left: { value: 'a' }, right: { value: 'b' } }, actions: [{ type: 'wait', ms: 1 }] }]
      }]);
    }, /Unknown condition operator "==="/);
  });

  // P0-1 自毁式元测试：构造一个微任务后 reject('sentinel') 的异步伪检查，
  // 验证上方 check() 必须真正 await 并将其记为 passed: false。
  // 一旦有人把第 13 行 check 的 async/await 删掉，probe.passed 会变成 true，本元测试立即爆红。
  await check('__sentinel_async_rejection_probe__', async () => {
    await Promise.resolve();
    throw new Error('sentinel');
  });
  const probe = results.pop();
  results.push({
    name: 'async check() captures rejected Promise as passed:false (anti-fake-green meta-test)',
    passed: Boolean(probe && probe.passed === false && probe.detail === 'sentinel'),
    ...(probe && probe.passed === false && probe.detail === 'sentinel'
      ? {}
      : { detail: `expected passed:false detail:"sentinel", got ${JSON.stringify(probe)}` }),
  });

  return results;
}
