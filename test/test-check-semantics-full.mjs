import { resolveBlankTemplate } from '../scripts/blank-template.mjs';
import { readFileSync } from 'node:fs';
import { validateSemantics, validateRecord } from './check-semantics.mjs';
import { readRecords, readManifest } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';

console.log('=== Running D04 comprehensive semantic diagnostics tests ===\n');

// 1. 正例测试
const blankPath = resolveBlankTemplate();
const blankRes = validateSemantics(blankPath);
if (!blankRes.valid || blankRes.violationCount !== 0) {
  console.error('Blank template failed semantic validation:', blankRes.violations);
  process.exit(1);
}
console.log('PASS: Blank template passes semantic validation (0 violations)');

// 2. 负例 A: registeredMasters 为空集合时，引用未注册母版 GUID
{
  const file = readFileSync(blankPath);
  const records = readRecords(file);
  const pageRec = records.find(r => r.className === 'Axure:Page');
  const graph = parsePayload(pageRec);

  // 构造一个 ReferenceDiagramObject 挂载在图上
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
              // 寻找 Axure:Master 在 strings 中的位置，没有就塞一个
              (() => {
                let idx = pageRec.strings.indexOf('Axure:Master');
                if (idx < 0) { pageRec.strings.push('Axure:Master'); idx = pageRec.strings.length - 1; }
                return idx + 1;
              })(),
              1 // 指向 GUID 槽位 1
            ]
          }
        ]
      ]
    }
  };
  graph.objects.set(999, fakeRefObj);

  // 传入空集合 registeredMasters
  const violations = validateRecord(pageRec, graph, { registeredMasters: new Set() });
  const masterViolation = violations.find(v => v.category === 'master-closure');
  if (!masterViolation) {
    console.error('FAILED: Unregistered master reference with empty registeredMasters should have been caught!');
    process.exit(1);
  }
  console.log(`PASS: Unregistered master with empty registeredMasters correctly flagged: "${masterViolation.message}"`);
}

// 3. 负例 B: tag 0x16 整数槽被写成字符串 GUID
{
  const file = readFileSync(blankPath);
  const records = readRecords(file);
  const pageRec = records.find(r => r.className === 'Axure:Page');
  const graph = parsePayload(pageRec);

  // 注入一个包含 tag 0x16 字符串的节点
  graph.roots.push({
    tag: 0x16,
    value: 'abcd1234abcd1234abcd1234abcd1234' // 非整数
  });

  const violations = validateRecord(pageRec, graph);
  const tag16Violation = violations.find(v => v.category === 'tag16-integrity');
  if (!tag16Violation) {
    console.error('FAILED: String in tag 0x16 should have been caught!');
    process.exit(1);
  }
  console.log(`PASS: String in tag 0x16 correctly flagged: "${tag16Violation.message}"`);
}

// 4. 负例 C: tag 8 索引越界
{
  const file = readFileSync(blankPath);
  const records = readRecords(file);
  const pageRec = records.find(r => r.className === 'Axure:Page');
  const graph = parsePayload(pageRec);

  graph.roots.push({
    tag: 8,
    value: 999999 // 远超 strings 长度
  });

  const violations = validateRecord(pageRec, graph);
  const tag8Violation = violations.find(v => v.category === 'tag8-integrity');
  if (!tag8Violation) {
    console.error('FAILED: Out-of-bounds tag 8 index should have been caught!');
    process.exit(1);
  }
  console.log(`PASS: Out-of-bounds tag 8 index correctly flagged: "${tag8Violation.message}"`);
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
        [{ tag: 8, value: 1, text: 'start-diagram-object' }, { tag: 3, value: 7777 }], // 不存在的对象
        [{ tag: 8, value: 1, text: 'start-connector-id' }, { tag: 17, value: 1 }]
      ]
    }
  };
  graph.objects.set(888, fakeConnector);

  const violations = validateRecord(pageRec, graph);
  const connViolation = violations.find(v => v.category === 'connector-integrity');
  if (!connViolation) {
    console.error('FAILED: Connector endpoint pointing to non-existent object should have been caught!');
    process.exit(1);
  }
  console.log(`PASS: Connector endpoint violation correctly flagged: "${connViolation.message}"`);
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
      entries: [
        [{ tag: 8, value: 1, text: 'items' }, { tag: 2, items: [{ tag: 3, value: 6666 }] }] // 6666 不存在
      ]
    }
  };
  const fakeAction = {
    id: 556,
    className: 'Axure:InteractionMoveWidgetAction',
    body: {
      tag: 1,
      entries: [
        [{ tag: 8, value: 1, text: 'object-path' }, { tag: 3, value: 555 }]
      ]
    }
  };
  graph.objects.set(555, fakePath);
  graph.objects.set(556, fakeAction);

  const violations = validateRecord(pageRec, graph);
  const pathViolation = violations.find(v => v.category === 'interaction-path-integrity');
  if (!pathViolation) {
    console.error('FAILED: DiagramObjectPath pointing to non-existent widget should have been caught!');
    process.exit(1);
  }
  console.log(`PASS: DiagramObjectPath violation correctly flagged: "${pathViolation.message}"`);
}

console.log('\n=== All D04 semantic diagnostic tests passed successfully! ===');
