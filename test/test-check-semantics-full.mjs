import { fixturePath } from './native-inputs.mjs';
import { readFileSync } from 'node:fs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { validateSemantics, validateRecord } from './check-semantics.mjs';
import { readRecords, replaceRecord, encodeRecord } from '../scripts/rp-records.mjs';
import { parsePayload, encodePayload, field } from '../scripts/parse-payload.mjs';

console.log('=== Running D04 comprehensive semantic diagnostics tests ===\n');

// 1. 正例测试
const blankPath = fixturePath('axure-rp11-blank.rp');
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

// 6. Active paths are a document-scope invariant, checked by validateSemantics.
{
  const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
  const active = addInteractions(source, 'SET_BUTTON', [{event:'OnClick',actions:[{type:'move',target:'VALUE_PREVIEW',x:10,y:0}]}], {replaceEvent:true}).file;
  const pageRec = readRecords(active).find(r => r.className === 'Axure:Page');
  const graph = parsePayload(pageRec);
  let changed = 0;
  for (const object of graph.objects.values()) {
    if (object.className !== 'Axure:DiagramObjectPath') continue;
    const target = field(object.body, 'object-id');
    if (target) { target.value = 999999; changed++; }
  }
  if (!changed) throw new Error('Native path prerequisite was not constructed');
  const corrupted = replaceRecord(active, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(graph.roots)));
  const violations = validateSemantics(corrupted).violations;
  const pathViolation = violations.find(v => v.category === 'interaction-path-integrity');
  if (!pathViolation) throw new Error('Active native DiagramObjectPath was not diagnosed');
  console.log('PASS: Active native DiagramObjectPath corruption is diagnosed at document scope');
}

console.log('\n=== All D04 semantic diagnostic tests passed successfully! ===');
