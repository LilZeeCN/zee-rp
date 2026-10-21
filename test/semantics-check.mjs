import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_DIR } from './fixture-summary.mjs';
import { validateSemantics, validateRecord } from './check-semantics.mjs';
import { readRecords, replaceRecord, encodeRecord } from '../scripts/rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from '../scripts/parse-payload.mjs';
import { clonePageByIndex } from '../scripts/duplicate-page.mjs';
import { readRp } from '../scripts/rp-read.mjs';

export function runSemanticsChecks() {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, passed: true }); }
    catch (err) { results.push({ name, passed: false, detail: err.message }); }
  };

  const fixturePath = join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp');
  const validBytes = readFileSync(fixturePath);

  check('正常原生 fixture 结构与语义闭环体检全部通过 (0 violations)', () => {
    const res = validateSemantics(validBytes);
    assert.equal(res.valid, true);
    assert.equal(res.violationCount, 0);
  });

  check('拦截负例: tag 8 误写外部字符串 (D02 缺陷特征)', () => {
    const records = readRecords(validBytes);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    // 篡改一个 tag 8 节点的 value 为字符串
    let tampered = false;
    walkNodes(graph.roots, node => {
      if (node.tag === 8 && !tampered) {
        node.value = 'IllegalLiteralString';
        tampered = true;
      }
    });
    assert.ok(tampered);
    // 1. AST 层直接拦截
    const astViolations = validateRecord(pageRec, graph);
    const astV = astViolations.find(x => x.category === 'tag8-integrity' && x.message.includes('string literal'));
    assert.ok(astV, 'expected tag8-integrity string literal violation in AST');

    // 2. 落盘后读出拦截（NaN 写入 u32 变为 0 导致越界）
    const badBytes = replaceRecord(validBytes, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(graph.roots)));
    const res = validateSemantics(badBytes);
    assert.equal(res.valid, false);
    const binV = res.violations.find(x => x.category === 'tag8-integrity');
    assert.ok(binV, 'expected tag8-integrity violation in binary');
  });

  check('拦截负例: tag 8 索引超出字符串表界限', () => {
    const records = readRecords(validBytes);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    let tampered = false;
    walkNodes(graph.roots, node => {
      if (node.tag === 8 && !tampered) {
        node.value = pageRec.strings.length + 999;
        tampered = true;
      }
    });
    const badBytes = replaceRecord(validBytes, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(graph.roots)));
    const res = validateSemantics(badBytes);
    assert.equal(res.valid, false);
    const v = res.violations.find(x => x.category === 'tag8-integrity' && x.message.includes('out of range'));
    assert.ok(v, 'expected tag8-integrity out of range violation');
  });

  check('拦截负例: tag 0x16 误写字符串 GUID (D06 缺陷特征)', () => {
    const records = readRecords(validBytes);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    let tampered = false;
    walkNodes(graph.roots, node => {
      if (node.tag === 0x16 && !tampered) {
        node.value = '11223344556677889900aabbccddeeff';
        tampered = true;
      }
    });
    assert.ok(tampered);
    // 1. AST 层直接拦截
    const astViolations = validateRecord(pageRec, graph);
    const astV = astViolations.find(x => x.category === 'tag16-integrity' && x.message.includes('string GUID'));
    assert.ok(astV, 'expected tag16-integrity string GUID violation in AST');

    // 2. 落盘后读出拦截
    const badBytes = replaceRecord(validBytes, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(graph.roots)));
    const res = validateSemantics(badBytes);
    assert.equal(res.valid, false);
    const binV = res.violations.find(x => x.category === 'tag16-integrity');
    assert.ok(binV, 'expected tag16-integrity violation in binary');
  });

  check('拦截负例: tag 0x16 GUID 索引超出表界限', () => {
    const records = readRecords(validBytes);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    let tampered = false;
    walkNodes(graph.roots, node => {
      if (node.tag === 0x16 && !tampered) {
        node.value = 9999;
        tampered = true;
      }
    });
    const badBytes = replaceRecord(validBytes, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(graph.roots)));
    const res = validateSemantics(badBytes);
    assert.equal(res.valid, false);
    const v = res.violations.find(x => x.category === 'tag16-integrity' && x.message.includes('out of range'));
    assert.ok(v, 'expected tag16-integrity out of range violation');
  });

  check('拦截负例: ReferenceDiagramObject 指向未在 DesignDocument 登记的 Master GUID', () => {
    const masterFixture = join(TEST_DIR, 'fixtures', 'master-override-writer-image-roundtrip.rp');
    const mBytes = readFileSync(masterFixture);
    const records = readRecords(mBytes);
    let targetRec = null, graph = null, rdo = null;
    for (const r of records) {
      if (!r.strings) continue;
      try {
        const g = parsePayload(r);
        const obj = [...g.objects.values()].find(o => o.className === 'Axure:DiagramObject:ReferenceDiagramObject');
        if (obj) { targetRec = r; graph = g; rdo = obj; break; }
      } catch {}
    }
    assert.ok(rdo && targetRec && graph, 'RDO not found in fixture');
    const guidRoot = graph.roots.find(n => n.tag === 0x1e);
    // 伪造一个新 GUID 放入列表，并将 rdo.ReferredMaster 指向它（但 DesignDocument 里没有登记该 Master）
    guidRoot.values.push('deadbeefdeadbeefdeadbeefdeadbeef');
    const fakeIndex = guidRoot.values.length;
    field(rdo.body, 'ReferredMaster').values[1] = fakeIndex;

    const badBytes = replaceRecord(mBytes, targetRec, encodeRecord(targetRec, targetRec.strings, encodePayload(graph.roots)));
    const res = validateSemantics(badBytes);
    assert.equal(res.valid, false);
    const v = res.violations.find(x => x.category === 'master-closure' && x.message.includes('unregistered Master GUID'));
    assert.ok(v, 'expected master-closure unregistered master violation');
  });

  check('拦截负例: InteractionTreeMap 的 node-table 引用不存在的悬空对象', () => {
    const records = readRecords(validBytes);
    const pageRec = records.find(r => r.className === 'Axure:Page');
    const graph = parsePayload(pageRec);
    const treeMap = [...graph.objects.values()].find(o => o.className === 'Axure:InteractionTreeMap');
    assert.ok(treeMap);
    const nodeTable = field(treeMap.body, 'node-table');
    // 追加一个指向不存在对象 #999999 的悬空映射
    nodeTable.entries.push([{ tag: 3, value: 1 }, { tag: 3, value: 999999 }]);

    const badBytes = replaceRecord(validBytes, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(graph.roots)));
    const res = validateSemantics(badBytes);
    assert.equal(res.valid, false);
    const v = res.violations.find(x => x.category === 'interaction-tree-integrity' && x.message.includes('non-existent object #999999'));
    assert.ok(v, 'expected interaction-tree-integrity violation');
  });

  check('clonePageByIndex 复制含交互页面保留 tag 0x16 整数槽位与三零语义', () => {
    const srcBytes = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    const cloned = clonePageByIndex(srcBytes, 4, 'CLONED_INTERACTIVE_PAGE');
    const health = readRp(cloned.file, { full: true });
    assert.equal(health.records.unparseable, 0);
    assert.equal(health.counts.danglingRefs, 0);
    assert.equal(health.counts.problems, 0);

    const sem = validateSemantics(cloned.file);
    assert.equal(sem.valid, true);
    assert.equal(sem.violationCount, 0);

    const records = readRecords(cloned.file);
    const newPageRec = records.find(r => r.className === 'Axure:Page' && r.index !== 4);
    assert.ok(newPageRec, 'cloned page record not found');
    const graph = parsePayload(newPageRec);
    const tag16Nodes = [];
    walkNodes(graph.roots, n => { if (n.tag === 0x16) tag16Nodes.push(n); });
    assert.ok(tag16Nodes.length > 0, 'interactive page must contain tag 0x16 nodes');
    for (const n of tag16Nodes) {
      assert.equal(typeof n.value, 'number', 'tag 0x16 value must be integer');
      assert.ok(n.value > 0, 'tag 0x16 value must be positive 1-based index');
    }
  });

  return results;
}

if (process.argv[1] && process.argv[1].endsWith('semantics-check.mjs')) {
  const results = runSemanticsChecks();
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.passed);
  if (failed.length) process.exit(1);
}
