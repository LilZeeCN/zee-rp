import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBlankTemplate } from '../scripts/blank-template.mjs';
import { readFileSync } from 'node:fs';
import { validateSemantics, validateRecord } from './check-semantics.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload } from '../scripts/parse-payload.mjs';

test('D04 comprehensive semantic diagnostics contracts', () => {
  const blankPath = resolveBlankTemplate();
  // 1. 正例测试
  const blankRes = validateSemantics(blankPath);
  assert.equal(blankRes.valid, true, `Blank template failed semantic validation: ${JSON.stringify(blankRes.violations)}`);
  assert.equal(blankRes.violationCount, 0);

  // 2. 负例 A: registeredMasters 为空集合时，引用未注册母版 GUID
  {
    const file = readFileSync(blankPath);
    const records = readRecords(file);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    const fakeRefObj = {
      id: 999,
      classIndex: 1,
      className: 'Axure:DiagramObject:ReferenceDiagramObject',
      body: {
        tag: 1,
        entries: [
          [
            { tag: 8, value: 1, text: 'ReferredMaster' },
            {
              tag: 0x10,
              values: [
                (() => {
                  let idx = pageRec.strings.indexOf('Axure:Master');
                  if (idx < 0) { pageRec.strings.push('Axure:Master'); idx = pageRec.strings.length - 1; }
                  return idx + 1;
                })(),
                1
              ]
            }
          ]
        ]
      }
    };
    graph.objects.set(999, fakeRefObj);
    const violations = validateRecord(pageRec, graph, { registeredMasters: new Set() });
    const masterViolation = violations.find(v => v.category === 'master-closure');
    assert.ok(masterViolation, 'Unregistered master reference with empty registeredMasters should have been caught!');
  }

  // 3. 负例 B: tag 0x16 整数槽被写成字符串 GUID
  {
    const file = readFileSync(blankPath);
    const records = readRecords(file);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    graph.roots.push({ tag: 0x16, value: 'abcd1234abcd1234abcd1234abcd1234' });
    const violations = validateRecord(pageRec, graph);
    const tag16Violation = violations.find(v => v.category === 'tag16-integrity');
    assert.ok(tag16Violation, 'String in tag 0x16 should have been caught!');
  }

  // 4. 负例 C: tag 8 索引越界
  {
    const file = readFileSync(blankPath);
    const records = readRecords(file);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    graph.roots.push({ tag: 8, value: 999999 });
    const violations = validateRecord(pageRec, graph);
    const tag8Violation = violations.find(v => v.category === 'tag8-integrity');
    assert.ok(tag8Violation, 'Out-of-bounds tag 8 index should have been caught!');
  }

  // 5. 负例 D: Connector 端点指向不存在的对象
  {
    const file = readFileSync(blankPath);
    const records = readRecords(file);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    const fakeConnector = {
      id: 888,
      classIndex: 1,
      className: 'Axure:DiagramObject:Connector',
      body: {
        tag: 1,
        entries: [
          [{ tag: 8, value: 1, text: 'start-diagram-object' }, { tag: 3, value: 7777 }],
          [{ tag: 8, value: 1, text: 'start-connector-id' }, { tag: 17, value: 1 }]
        ]
      }
    };
    graph.objects.set(888, fakeConnector);
    const violations = validateRecord(pageRec, graph);
    const connViolation = violations.find(v => v.category === 'connector-integrity');
    assert.ok(connViolation, 'Connector endpoint pointing to non-existent object should have been caught!');
  }

  // 6. 负例 E: DiagramObjectPath 动作路径指向不存在的 widget
  {
    const file = readFileSync(blankPath);
    const records = readRecords(file);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    const fakePath = {
      id: 555,
      className: 'Axure:DiagramObjectPath',
      body: {
        tag: 1,
        entries: [[{ tag: 8, value: 1, text: 'items' }, { tag: 2, items: [{ tag: 3, value: 6666 }] }]]
      }
    };
    const fakeAction = {
      id: 556,
      className: 'Axure:InteractionMoveWidgetAction',
      body: {
        tag: 1,
        entries: [[{ tag: 8, value: 1, text: 'object-path' }, { tag: 3, value: 555 }]]
      }
    };
    graph.objects.set(555, fakePath);
    graph.objects.set(556, fakeAction);
    const violations = validateRecord(pageRec, graph);
    const pathViolation = violations.find(v => v.category === 'interaction-path-integrity');
    assert.ok(pathViolation, 'DiagramObjectPath pointing to non-existent widget should have been caught!');
  }
});
