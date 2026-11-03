import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudioServer } from '../studio/server.mjs';

// W2：studio_run_scenario 可选真实指针校验（hitTest）。
// 节点 A btn-ok(x40,y200,w120,h44)；节点 B cover(x20,y180,w200,h100) 排在 A 之后（更高层），
// 完全盖住按钮 6 个采样点。clear 页没有 cover 作为消除遮挡对照。
const root = children => ({ id: 'root', type: 'box', w: 500, h: 500, children });
const okButton = () => ({ id: 'btn-ok', type: 'button', text: 'OK', x: 40, y: 200, w: 120, h: 44, onClick: [{ type: 'set-var', name: 'clicks', value: 1 }] });
const cover = () => ({ id: 'cover', type: 'box', x: 20, y: 180, w: 200, h: 100, fill: '#333333' });
const clickSteps = [{ action: 'click', target: 'btn-ok', expect: { variables: { clicks: 1 } } }];

test('hitTest: semantic default ignores occlusion; real pointer returns E_SCENARIO_OCCLUDED without executing semantics; clear page passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-scenario-hittest-'));
  const sourcePath = join(dir, 'source.json');
  writeFileSync(sourcePath, JSON.stringify({
    variables: { clicks: 0 },
    pages: [
      { id: 'home', root: root([okButton(), cover()]) },
      { id: 'clear', root: root([okButton()]) },
    ],
  }));
  let studio;
  const post = async body => {
    const response = await fetch(`${studio.url}/api/runtime/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    ({ studio } = await startStudioServer({ projectDir: join(dir, 'project'), sourcePath, port: 0 }));

    // 1) 语义基线：默认语义层不校验遮挡，被盖住的按钮仍判 ok:true（默认行为不变，不带 hitTest 字段）
    const semantic = await post({ startPageId: 'home', steps: clickSteps });
    assert.equal(semantic.ok, true, JSON.stringify(semantic));
    assert.equal(semantic.hitTest, undefined);

    // 2) hitTest:true：真实指针发现 cover 遮挡 → E_SCENARIO_OCCLUDED，含 nodeId/遮挡者/stepIndex/采样点
    const occluded = await post({ startPageId: 'home', hitTest: true, steps: clickSteps });
    assert.equal(occluded.ok, false);
    assert.equal(occluded.code, 'E_SCENARIO_OCCLUDED');
    assert.equal(occluded.stepIndex, 0);
    assert.equal(occluded.nodeId, 'btn-ok');
    assert.equal(occluded.occludedBy?.nodeId, 'cover');
    assert.equal(occluded.occludedBy?.scopedId, 'home/cover');
    assert.ok(Array.isArray(occluded.sampledPoints) && occluded.sampledPoints.length === 6, JSON.stringify(occluded.sampledPoints));

    // 3) 运行时状态未变：语义 click 未执行，clicks 仍是 0（reset:false 续跑同一会话验证）
    const untouched = await post({ startPageId: 'home', reset: false, steps: [{ action: 'expect', expect: { variables: { clicks: 0 } } }] });
    assert.equal(untouched.ok, true, JSON.stringify(untouched));

    // 4) 消除遮挡（clear 页无 cover）：hitTest:true 通过，语义与真实指针双层一致
    const clear = await post({ startPageId: 'clear', hitTest: true, steps: clickSteps });
    assert.equal(clear.ok, true, JSON.stringify(clear));
    assert.equal(clear.hitTest?.passed, true);
    assert.equal(clear.hitTest?.verification, 'real-browser-pointer');
    assert.equal(String(clear.finalState?.variables?.clicks), '1');

    // 5) 浏览器指针层无法重放的步骤（dataset）→ 显式 unsupported，不静默降级到语义层
    const unsupported = await post({ startPageId: 'home', hitTest: true, steps: [{ action: 'dataset', dataset: 'items', op: 'sort', field: 'id', order: 'asc', expect: { datasetCount: { items: 1 } } }] });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'E_SCENARIO_HITTEST_UNSUPPORTED');

    // 6) hitTest + reset:false → 显式拒绝（续跑会话无法在真实浏览器镜像）
    const noReset = await post({ startPageId: 'home', hitTest: true, reset: false, steps: clickSteps });
    assert.equal(noReset.ok, false);
    assert.equal(noReset.code, 'E_SCENARIO_HITTEST_RESET_REQUIRED');
  } finally {
    if (studio) await studio.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
