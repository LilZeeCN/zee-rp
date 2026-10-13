import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloneNativeConnector } from '../scripts/clone-native-connector.mjs';
import { resolveBlankTemplate } from '../scripts/blank-template.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { parsePayload, field } from '../scripts/parse-payload.mjs';

export function runCloneConnectorChecks() {
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, passed: true });
    } catch (err) {
      results.push({ name, passed: false, detail: err.message });
    }
  };

  const blank = resolveBlankTemplate();
  const customSrc = fixturePath('connector-custom-anchor-writer-roundtrip-20261012.rp');
  const nestedSrc = fixturePath('connector-nested-panel-writer-positioned-gui-roundtrip-20261012.rp');

  check('克隆带自定义锚点的连接线保留点 GUID、坐标、方向与三零', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'axure-clone-custom-'));
    try {
      const out = join(tmp, 'out.rp');
      const res = cloneNativeConnector(customSrc, blank, out, 4, 14, 'Page 1');
      const rp = readRp(readFileSync(out), { full: true });
      assert.equal(rp.records.unparseable, 0);
      assert.equal(rp.counts.danglingRefs, 0);
      assert.equal(rp.counts.problems, 0);

      const rec = readRecords(readFileSync(out)).find(r => r.className === 'Axure:Page');
      const g = parsePayload(rec);
      const guids = g.roots.find(n => n.tag === 0x1e).values;
      const conn = g.objects.get(res.connector);
      const targetShapeId = field(conn.body, 'end-diagram-object').value;
      const endConnGuidIdx = field(conn.body, 'end-connector-id').value;
      const endConnGuid = guids[endConnGuidIdx - 1];
      assert.equal(endConnGuid, '9b37625998f5cda98cd50fd24a38f1cd');
      assert.equal(field(conn.body, 'end-point-direction').value, 2);

      const targetShape = g.objects.get(targetShapeId);
      const cp = field(targetShape.body, 'ConnectorPoints');
      assert.ok(cp);
      const points = cp.entries.map(([k, v]) => ({
        guid: guids[k.value - 1],
        x: field(v, 'X').value,
        y: field(v, 'Y').value
      }));
      const customPoint = points.find(p => p.guid === '9b37625998f5cda98cd50fd24a38f1cd');
      assert.ok(customPoint);
      assert.equal(customPoint.x, 0.25);
      assert.equal(customPoint.y, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  check('克隆 PanelState 嵌套端点连接线保留源绑定、方向与三零', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'axure-clone-nested-'));
    try {
      const out = join(tmp, 'out.rp');
      const res = cloneNativeConnector(nestedSrc, blank, out, 4, 16, 'Page 1');
      const rp = readRp(readFileSync(out), { full: true });
      assert.equal(rp.records.unparseable, 0);
      assert.equal(rp.counts.danglingRefs, 0);
      assert.equal(rp.counts.problems, 0);

      const rec = readRecords(readFileSync(out)).find(r => r.className === 'Axure:Page');
      const g = parsePayload(rec);
      const guids = g.roots.find(n => n.tag === 0x1e).values;
      const conn = g.objects.get(res.connector);
      const startConnGuidIdx = field(conn.body, 'start-connector-id').value;
      const startConnGuid = guids[startConnGuidIdx - 1];
      assert.equal(startConnGuid, '2d8b061a4ec67420fde756d82a8d2a31');
      assert.equal(field(conn.body, 'start-point-direction').value, 8);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  check('非法记录类型或跨 diagram 连接线拒绝', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'axure-clone-neg-'));
    try {
      const out = join(tmp, 'out.rp');
      // Record 1 is DesignDocument, not Page or PanelState
      assert.throws(() => cloneNativeConnector(customSrc, blank, out, 1, 14, 'Page 1'), /Source Page or PanelState record not found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  return results;
}

if (process.argv[1] && process.argv[1].endsWith('clone-connector-check.mjs')) {
  for (const r of runCloneConnectorChecks()) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
}
