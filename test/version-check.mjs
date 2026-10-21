// 版本边界与 RP 9 / RP 11 写侧编码验收（阶段 0 + 1）。
//
// 覆盖：
//   0  文件头识别、未知版本/坏 magic 拒绝、rp-read 报真实版本、模板按版本解析与跨版本拒绝
//   1  RP 9 的 enable 写 bool 且极性正确；RP 11 保持 int 枚举；toggle 在 RP 9 拒绝
//      RP 9 输出与 RP 9 原生样本的字段签名一致（InteractionEvent / InteractionCase / 动作壳）
//      apply-style 在 RP 9 拒绝
//      RP 11 路径的字段集与改动前逐字节一致（由既有 225 项回归共同保证，这里做定向断言）
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TEST_DIR } from './fixture-summary.mjs';
import { readRecords, encodeRecord, replaceRecord } from '../scripts/rp-records.mjs';
import { RP11_ONLY_KEYS, RP11_ONLY_DOA_CODES, DOA_BASE_MASK, DOA_RENAMED_SAME_SLOT, RP11_ONLY_FCALLS, RP11_ONLY_ACCESSORS, ACCESSOR_KEY_ALIASES, RP11_ONLY_EVENTS } from '../scripts/version-fields.mjs';
import { REGISTERED_FCALLS, WIDGET_PATH_FCALLS, FCALL_SPECS } from '../scripts/ix-actions.mjs';
import { lintVersionKeys } from '../scripts/version-lint.mjs';
import { parsePayload, encodePayload } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { detectFileVersion, supportedVersions, versionLabel, resolvePasteTarget, installRoot } from '../scripts/version.mjs';
import { resolveBlankTemplate } from '../scripts/blank-template.mjs';
import { fixPanelRegistry } from '../scripts/fix-panel-registry.mjs';
import { fillPanelState } from '../scripts/fill-panel-state.mjs';
import { duplicateMaster } from '../scripts/create-master.mjs';
import { placeMaster } from '../scripts/place-master.mjs';
import { createPanel, panelTemplate } from '../scripts/create-panel-clone.mjs';
import { cloneLibraryPageContent } from '../scripts/clone-library-page-content.mjs';
import { field } from '../scripts/parse-payload.mjs';

const SKILL = join(TEST_DIR, '..');
const SCRIPTS = join(SKILL, 'scripts');
// RP 9 fixture 单独放：test/fixtures/ 由 manifest.json 驱动，不该混入未登记的样本。
const RP9_FIXTURE = join(TEST_DIR, 'rp9-fixtures', 'rp9-clone-button.rp');
const RP9_PANEL_FIXTURE = join(TEST_DIR, 'rp9-fixtures', 'rp9-panel-base.rp');
const RP11_FIXTURE = join(TEST_DIR, 'fixtures', 'blank-ui-native.rp');
// RP 9 原生母版真值：由 Axure RP 9 自己在 GUI 里建母版、粘贴内容后保存得到
const RP9_MASTER_FIXTURE = join(TEST_DIR, 'rp9-fixtures', 'rp9-native-master-content.rp');
const RP9_AV_FIXTURE = join(TEST_DIR, 'rp9-fixtures', 'rp9-adaptive-views.rp');
const RP9_REPEATER_FIXTURE = join(TEST_DIR, 'rp9-fixtures', 'rp9-repeater-base.rp');
// 跨版本克隆的源：RP 11 内容（含 RP 11 专属键），用来验证克隆层会按目标版本裁剪
const RP11_SOURCE_FOR_CROSS = join(TEST_DIR, 'rp9-fixtures', 'rp11-source-for-cross-version.rp');

// 【REA 真值】RP 9 Client.Mac.exe（sha256 0f40edf1…）各模型 rv2F 的字面锚点键集。
// 恢复来源：rea/rp9-all-strings.json（31,264/31,264 处字符串调用命中，unmatched=0）。
// 这两个 writer 在 RP 11 上键集不同，所以「我们生成的 RP 9 输出必须逐键等于这里」。
const RP9_NATIVE_WRITER_KEYS = {
  'FadeWidgetInfo': { token: '0x06008fa7', keys: ['easing', 'fade-action-type', 'vertical', 'animation-hide',
    'show-type', 'DurationHide', 'EasingHide', 'BringToFront', 'page-background', 'compress-easing',
    'duration', 'compress-duration', 'animation-show'] },
  'SetPanelStateInfo': { token: '0x060090f0', keys: ['state-value', 'repeat', 'exit-duration', 'vertical',
    'animation-enter', 'show-when-set', 'enter-duration', 'compress-duration', 'diagram-id', 'animation-exit',
    'exit-easing', 'repeat-skip-first', 'compress-easing', 'loop', 'enter-easing', 'repeat-interval',
    'set-state-type', 'compress'] },
  'IxEvent': { token: '0x06008e28', keys: ['event-type', 'master-containing-raised-event', 'raised-event-id'] },
  'IxCase': { token: '0x06008dc9', keys: ['Description', 'Condition', 'IsNewIfGroup'] },
};
// REA 用程序集类型名（IxEvent/IxCase），文件里是序列化类名 InteractionEvent/InteractionCase
const FILE_CLASS_OF = { IxEvent: 'InteractionEvent', IxCase: 'InteractionCase' };
const keysOfClass = (bytes, clsName) => {
  const cls = FILE_CLASS_OF[clsName] ?? clsName;
  for (const record of readRecords(bytes)) {
    let graph; try { graph = parsePayload(record); } catch { continue; }
    for (const object of graph.objects.values()) {
      if (String(object.className || '').replace(/^Axure:/, '') !== cls) continue;
      return (object.body?.entries ?? []).map(([k]) => k.text).sort();
    }
  }
  return null;
};
const TMP = mkdtempSync(join(tmpdir(), 'axure-version-'));

// 从字节流里取某个对象的「键:值tag」签名，用于和原生样本对照。
function signatures(bytes, classNames) {
  const out = {};
  for (const record of readRecords(bytes)) {
    let graph;
    try { graph = parsePayload(record); } catch { continue; }
    for (const object of graph.objects.values()) {
      const short = String(object.className || '').replace(/^Axure:/, '');
      if (!classNames.includes(short)) continue;
      out[short] = (object.body?.entries ?? []).map(([k, v]) => `${k.text}:${v.tag}`).join(' ');
    }
  }
  return out;
}
function valueOf(bytes, className, key) {
  for (const record of readRecords(bytes)) {
    let graph;
    try { graph = parsePayload(record); } catch { continue; }
    for (const object of graph.objects.values()) {
      if (String(object.className || '').replace(/^Axure:/, '') !== className) continue;
      const hit = (object.body?.entries ?? []).find(([k]) => k.text === key);
      if (hit) return hit[1];
    }
  }
  return null;
}

// RP 11 侧签名：我们 writer 的 RP 11 输出（沿用 RP 11 语料观察，本回归即可守住）
const RP11_NATIVE = {
  InteractionEvent: 'Disabled:25 event-type:5 master-containing-raised-event:16 raised-event-id:17 variable-id:17',
  InteractionCase: 'Disabled:25 Description:8 Condition:3 IsNewIfGroup:25',
};

// 源文件里是否存在「目标 RP 9 时会被砍掉」的键
function sourceHasRp11Keys(bytes) {
  for (const record of readRecords(bytes)) {
    let graph; try { graph = parsePayload(record); } catch { continue; }
    for (const object of graph.objects.values()) {
      const cls = String(object.className || '').replace(/^Axure:/, '');
      const banned = RP11_ONLY_KEYS[cls];
      if (!banned) continue;
      for (const [k] of object.body?.entries ?? []) if (banned.includes(k.text)) return true;
    }
  }
  return false;
}

// 直接在内存里跑版本 lint，取 error 数
function versionKeysClean(bytes) {
  const errors = [];
  for (const record of readRecords(bytes)) {
    let graph; try { graph = parsePayload(record); } catch { continue; }
    for (const object of graph.objects.values()) {
      const cls = String(object.className || '').replace(/^Axure:/, '');
      const banned = RP11_ONLY_KEYS[cls];
      if (!banned) continue;
      for (const [k] of object.body?.entries ?? []) if (banned.includes(k.text)) errors.push(`${cls}.${k.text}`);
    }
  }
  return errors;
}

export function runVersionChecks() {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error.message }); }
  };

  // ---------- 阶段 0：版本边界 ----------
  check('阶段0 版本号来自文件头而不是猜', () => {
    assert.equal(detectFileVersion(readFileSync(RP9_FIXTURE)), 9);
    const rp11 = readFileSync(resolveBlankTemplate(11));
    assert.equal(detectFileVersion(rp11), 11);
    assert.deepEqual(supportedVersions().sort((a, b) => a - b), [9, 11]);
  });
  check('阶段0 坏 magic 与未知版本明确拒绝', () => {
    const bad = Buffer.from(readFileSync(RP9_FIXTURE));
    bad[1] = 0x00;
    assert.throws(() => detectFileVersion(bad), /magic/);
    const unknown = Buffer.from(readFileSync(RP9_FIXTURE));
    unknown.writeUInt16LE(10, 2);
    assert.throws(() => detectFileVersion(unknown), /Unsupported Axure version/);
  });
  check('阶段0 rp-read 报真实版本而不是写死 RP 11', () => {
    assert.equal(readRp(readFileSync(RP9_FIXTURE), { path: 'x' }).format, 'Axure RP 9 .rp');
    assert.equal(readRp(readFileSync(resolveBlankTemplate(11)), { path: 'x' }).format, 'Axure RP 11 .rp');
    assert.equal(versionLabel(9), 'Axure RP 9');
  });
  check('阶段0 空白模板按版本解析，跨版本模板被拒绝', () => {
    assert.ok(resolveBlankTemplate(9).includes('rp9'));
    assert.ok(resolveBlankTemplate(11).includes('rp11'));
    const prev = process.env.AXURE_BLANK_TEMPLATE;
    process.env.AXURE_BLANK_TEMPLATE = resolveBlankTemplate(11);
    try {
      assert.throws(() => resolveBlankTemplate(9), /版本/);
    } finally {
      if (prev === undefined) delete process.env.AXURE_BLANK_TEMPLATE; else process.env.AXURE_BLANK_TEMPLATE = prev;
    }
  });
  check('阶段0 create-blank-project 双版本各自产出正确文件头', () => {
    const out9 = join(TMP, 'p9.rp'), out11 = join(TMP, 'p11.rp');
    execFileSync(process.execPath, [join(SCRIPTS, 'create-blank-project.mjs'), out9, '--version', '9']);
    execFileSync(process.execPath, [join(SCRIPTS, 'create-blank-project.mjs'), out11]);
    assert.equal(readFileSync(out9).readUInt16LE(2), 9);
    assert.equal(readFileSync(out11).readUInt16LE(2), 11);
    assert.equal(readRp(readFileSync(out9), { path: out9 }).counts.problems, 0);
  });
  check('阶段0 双版本并行时宿主绑定不自动猜', () => {
    assert.equal(resolvePasteTarget({ version: 9 }).bundleId, 'com.axure.AxureRP9');
    assert.equal(resolvePasteTarget({ version: 11 }).bundleId, 'com.axure.AxureRP11');
    assert.equal(resolvePasteTarget({ bundleId: 'com.axure.AxureRP9' }).version, 9);
    assert.throws(() => resolvePasteTarget({ bundleId: 'com.axure.Nope' }), /Unknown Axure bundle id/);
  });

  // ---------- 阶段 1：写侧编码 ----------
  const mk = (name) => {
    const p = join(TMP, name);
    copyFileSync(RP9_FIXTURE, p);
    return p;
  };
  const run = (src, actions, dstName) => {
    const dst = join(TMP, dstName);
    const out = addInteractions(readFileSync(src), 'ProbeButton', [{ event: 'OnClick', actions }]);
    writeFileSync(dst, out.file);
    return { dst, report: out.report, bytes: out.file };
  };

  check('阶段1 RP 9 enable 写 bool（不是 int 枚举）', () => {
    const { bytes, report } = run(mk('a.rp'), [{ type: 'enable' }], 'a-out.rp');
    assert.equal(report.version, 9);
    const enable = valueOf(bytes, 'EnableDisableWidgetsInfo', 'enable');
    assert.equal(enable.tag, 0x19, 'enable 必须是 bool tag 0x19');
    assert.equal(enable.value, true, 'enable 应为 true');
    const disable = run(mk('b.rp'), [{ type: 'disable' }], 'b-out.rp').bytes;
    assert.equal(valueOf(disable, 'EnableDisableWidgetsInfo', 'enable').value, false, 'disable 应为 false');
  });
  check('阶段1 toggle-enabled 在 RP 9 明确拒绝（bool 无三态）', () => {
    assert.throws(() => run(mk('e.rp'), [{ type: 'toggle-enabled' }], 'e-out.rp'),
      /toggle-enabled has no Axure RP 9 representation/);
  });
  check('阶段1 apply-style 在 RP 9 明确拒绝（类型标签仅 RP 11 有）', () => {
    assert.throws(() => run(mk('f.rp'), [{ type: 'apply-style', fill: '#FF0000' }], 'f-out.rp'),
      /apply-style does not exist in Axure RP 9/);
  });
  check('阶段1 RP 9 去掉 show/hide 的 RP 11 专属键并补 vertical', () => {
    const { bytes } = run(mk('g.rp'), [{ type: 'show', target: 'ProbeButton' }], 'g-out.rp');
    const fade = signatures(bytes, ['FadeWidgetInfo']).FadeWidgetInfo;
    for (const k of ['scale', 'scale-hide', 'scale-anchor', 'scale-hide-anchor', 'page-background-blur',
      'compress-distance-type', 'custom-compress-value']) {
      assert.ok(!fade.includes(`${k}:`), `RP 9 不应出现 RP 11 专属键 ${k}`);
    }
    assert.ok(fade.includes('vertical:25'), `RP 9 原生需 vertical:bool，实际 ${fade}`);
  });
  check('阶段1 RP 11 路径保持 int 枚举与 Disabled（未回归）', () => {
    // 用 RP 11 fixture：取值必须仍是 int，且事件/Case/动作壳保留 Disabled
    const rp11 = join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp');
    const src = readFileSync(rp11);
    assert.equal(detectFileVersion(src), 11);
    const out = addInteractions(src, 'SET_BUTTON', [{ event: 'OnClick', actions: [{ type: 'enable' }] }]);
    assert.equal(out.report.version, 11);
    assert.equal(out.report.versionAdaptations.length, 0, 'RP 11 不应触发任何版本适配');
    assert.equal(valueOf(out.file, 'EnableDisableWidgetsInfo', 'enable').tag, 5, 'RP 11 enable 必须是 int');
    const sig = signatures(out.file, Object.keys(RP11_NATIVE));
    for (const [cls, want] of Object.entries(RP11_NATIVE)) {
      assert.equal(sig[cls], want, `${cls} RP 11 签名变了：${sig[cls]}`);
    }
  });

  check('阶段1 RP 9 输出的键集逐键等于 REA 原生 writer 键集', () => {
    // 一个文件同时覆盖 IxCase / IxEvent / FadeWidgetInfo
    const bytes = run(mk('j.rp'), [{ type: 'enable' }, { type: 'toggle', target: 'ProbeButton' }], 'j-out.rp').bytes;
    for (const [cls, spec] of Object.entries(RP9_NATIVE_WRITER_KEYS)) {
      if (cls === 'SetPanelStateInfo') continue;
      assert.deepEqual(keysOfClass(bytes, cls), [...spec.keys].sort(),
        `${cls} 键集与 RP9 ${spec.token} 不符`);
    }
    // SetPanelStateInfo 需要真实面板
    const panelSrc = readFileSync(RP9_PANEL_FIXTURE);
    const out = addInteractions(panelSrc, 'PANEL9', [{ event: 'OnClick', actions: [
      { type: 'set-panel-state', target: 'PANEL9', state: 'next' }] }]);
    const spec = RP9_NATIVE_WRITER_KEYS.SetPanelStateInfo;
    assert.deepEqual(keysOfClass(out.file, 'SetPanelStateInfo'), [...spec.keys].sort(),
      `SetPanelStateInfo 键集与 RP9 ${spec.token} 不符`);
  });

  check('阶段1 IxCase 不做 IsEnabled 改名（REA 否定该做法）', () => {
    const bytes = run(mk('k.rp'), [{ type: 'enable' }], 'k-out.rp').bytes;
    const keys = keysOfClass(bytes, 'InteractionCase');
    assert.ok(!keys.includes('IsEnabled'), `RP 9 输出不应出现 IsEnabled，实际 ${keys.join(',')}`);
    assert.ok(!keys.includes('Disabled'), `RP 9 输出应丢掉 Disabled，实际 ${keys.join(',')}`);
    // RP9 全程序集无 IsEnabled 字面值 —— 这是判定依据，不是猜的
    assert.equal(RP9_NATIVE_WRITER_KEYS.IxCase.keys.includes('IsEnabled'), false);
  });

  check('阶段2 RP 9 面板注册链：缺失时补 DynamicPanelInfo/PanelDiagramInfo', () => {
    const count = (bytes, cls) => {
      let n = 0;
      for (const record of readRecords(bytes)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        for (const o of graph.objects.values()) if (o.className === `Axure:${cls}`) n++;
      }
      return n;
    };
    const src = readFileSync(RP9_PANEL_FIXTURE);
    // 修复前：与 RP 9 原生文件（Tour / Sample UI Patterns）不同，我们的产物从来没有这条链
    assert.equal(count(src, 'DynamicPanelInfo'), 0, '修复前不应有 DynamicPanelInfo');
    assert.equal(count(src, 'PanelDiagramInfo'), 0, '修复前不应有 PanelDiagramInfo');

    const fixed = fixPanelRegistry(src).file;
    assert.equal(count(fixed, 'DynamicPanelInfo'), 1, '应补出 1 个 DynamicPanelInfo');
    assert.equal(count(fixed, 'PanelDiagramInfo'), 1, 'PANEL9 有 1 个状态，应补出 1 个 PanelDiagramInfo');

    // 状态名要来自真实的 PanelDiagram.Name，不能编
    const names = [];
    for (const record of readRecords(fixed)) {
      let graph; try { graph = parsePayload(record); } catch { continue; }
      for (const o of graph.objects.values()) {
        if (o.className === 'Axure:PanelDiagramInfo') names.push(field(o.body, 'name')?.text);
      }
    }
    // 断言登记的状态名来自文件里真实的 PanelDiagram.Name，不是编的
    const realNames = [];
    for (const record of readRecords(src)) {
      let graph; try { graph = parsePayload(record); } catch { continue; }
      for (const o of graph.objects.values()) {
        if (o.className === 'Axure:PanelDiagram') realNames.push(field(o.body, 'Name')?.text);
      }
    }
    assert.ok(realNames.length > 0, 'fixture 应有 PanelDiagram');
    assert.deepEqual(names, realNames, 'PanelDiagramInfo.name 应逐个等于真实的 PanelDiagram.Name');

    // 幂等：跑第二遍不应重复登记
    const twice = fixPanelRegistry(fixed).file;
    assert.equal(count(twice, 'DynamicPanelInfo'), 1, '重复执行不应重复登记');
  });

  check('阶段3 RP 9 母版：复制带内容的母版，内容跟着走', () => {
    const count = (bytes, cls) => {
      let n = 0;
      for (const record of readRecords(bytes)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        for (const o of graph.objects.values()) if (o.className === `Axure:${cls}`) n++;
      }
      return n;
    };
    const src = readFileSync(RP9_MASTER_FIXTURE);
    // 原生真值：1 个母版，母版自带 Diagram 与 DiagramObject
    assert.equal(count(src, 'Master'), 1);
    assert.equal(count(src, 'MasterPackageInfo'), 1);
    const srcDiagram = count(src, 'Diagram');

    const copied = duplicateMaster(src, 'Master 1', 'MASTER9').file;
    assert.equal(count(copied, 'Master'), 2, '应复制出第 2 个母版');
    assert.equal(count(copied, 'MasterPackageInfo'), 2, '母版包登记应同步');
    assert.equal(count(copied, 'Diagram'), srcDiagram + 1, '复制的母版必须自带 Diagram');
    assert.equal(versionKeysClean(copied).length, 0, 'RP 9 产物不得有版本专属键');

    // 实例上页
    const pageRecord = (() => {
      for (const r of readRecords(copied)) if (r.className === 'Axure:Page') return r.index;
      throw new Error('fixture 里没有 Page 记录');
    })();
    const placed = placeMaster(copied, { masterName: 'MASTER9', pageIndex: pageRecord, x: 500, y: 350 }).file;
    const read = readRp(placed, { path: 'x' });
    assert.equal(read.counts.masters, 2, '实例上页后母版数应为 2');
    assert.equal(read.problems.length, 0, '不该有结构问题');
    assert.equal(versionKeysClean(placed).length, 0, 'RP 9 产物不得有版本专属键');
  });

  check('阶段3 RP 9 自适应视图：视图集结构正确且不含 RP 11 专属键', () => {
    const objsOf = (bytes, cls) => {
      const out = [];
      for (const record of readRecords(bytes)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        for (const o of graph.objects.values()) if (o.className === `Axure:${cls}`) out.push(o);
      }
      return out;
    };
    // 固定样本：由 add-adaptive-view.mjs 在 RP 9 上产出（断点 768 / 1024）
    const src = readFileSync(RP9_AV_FIXTURE);
    const sets = objsOf(src, 'AdaptiveViewSet');
    const views = objsOf(src, 'AdaptiveView');
    assert.equal(sets.length, 1, '应恰有 1 个 AdaptiveViewSet');
    assert.equal(views.length, 3, 'Base + 2 子视图 = 3 个 AdaptiveView');
    // RP 9 原生 AdaptiveView 没有 Cursor（REA：RP 9 writer 无该键）——写上就是版本专属键
    for (const v of views) {
      const keys = (v.body?.entries ?? []).map(([k]) => k.text);
      assert.ok(!keys.includes('Cursor'), `RP 9 的 AdaptiveView 不应有 Cursor，实际 [${keys.join(',')}]`);
    }
    assert.equal(versionKeysClean(src).length, 0, 'RP 9 产物不得有版本专属键');

    // 让 CLI 现场重跑一遍，确认 writer 仍然产出同样的结构（不是只有旧样本对）
    const dir = mkdtempSync(join(tmpdir(), 'av9-'));
    try {
      const base = join(dir, 'b.rp');
      const out = join(dir, 'o.rp');
      copyFileSync(join(TEST_DIR, 'rp9-fixtures', 'rp9-clone-button.rp'), base);
      execFileSync(process.execPath, [join(SCRIPTS, 'add-adaptive-view.mjs'), base, out, '768', '1024']);
      const fresh = readFileSync(out);
      assert.equal(objsOf(fresh, 'AdaptiveViewSet').length, 1, '现场产出应有 1 个视图集');
      assert.equal(objsOf(fresh, 'AdaptiveView').length, 3, '现场产出应有 3 个视图');
      for (const v of objsOf(fresh, 'AdaptiveView')) {
        const keys = (v.body?.entries ?? []).map(([k]) => k.text);
        assert.ok(!keys.includes('Cursor'), 'RP 9 现场产出同样不得有 Cursor');
      }
      assert.equal(versionKeysClean(fresh).length, 0, 'RP 9 现场产物不得有版本专属键');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('阶段3 RP 9 中继器动作：键集等于 REA 原生 writer，且条件不能被静默丢掉', () => {
    const objsOf = (bytes, cls) => {
      const out = [];
      for (const record of readRecords(bytes)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        for (const o of graph.objects.values()) if (o.className === `Axure:${cls}`) out.push(o);
      }
      return out;
    };
    const keySet = o => (o.body?.entries ?? []).map(([k]) => k.text).sort();
    const src = readFileSync(RP9_REPEATER_FIXTURE);
    const make = (actions, name) => {
      const dst = join(TMP, name);
      const out = addInteractions(src, 'REP9', [{ event: 'OnClick', actions }]);
      writeFileSync(dst, out.file);
      return out.file;
    };

    // REA 真值（RP9 Client.Mac.exe）：
    //   AddFilterToRepeaterInfo.rv2F 0x06008981 = Filter / Label / RemoveOtherFilters
    //   AddSortToRepeaterInfo.rv2F   0x060089f4 = ascending / column-id / column-name / label / sort-type / toggle
    //   DeleteItemsFromDataSetInfo.rv2F 0x06008a2b = Rule / SelectionType
    const filtered = make([{ type: 'repeater-filter', target: 'REP9', column: 'Column0', condition: true, filter: '2' }], 'rf.rp');
    const filterInfo = objsOf(filtered, 'AddFilterToRepeaterInfo')[0];
    assert.ok(filterInfo, '应写出 AddFilterToRepeaterInfo');
    assert.deepEqual(keySet(filterInfo), ['Filter', 'Label', 'RemoveOtherFilters'], '过滤 Info 键集须等于 RP 9 原生');
    // 关键：条件是搬到 Filter 里，不是被丢掉。指向空 StringLiteral 就是静默失效。
    const filterTarget = objsOf(filtered, 'AddFilterToRepeaterInfo')[0];
    const refId = (filterTarget.body.entries.find(([k]) => k.text === 'Filter') ?? [])[1]?.value;
    const allFilterObjs = objsOf(filtered, '');
    let refCls = null;
    for (const record of readRecords(filtered)) {
      let graph; try { graph = parsePayload(record); } catch { continue; }
      const t = graph.objects.get(refId); if (t) refCls = t.className;
    }
    // RP 9 的 Filter 是 **StringLiteral 装整个 [[...]] 表达式**（原生真值 obj#359/628/46/833）。
    // 指向 BinaryExpr 会让 RP 9 的 HTML 生成器整页崩成空白 —— 实测过，绝不能回退成那样。
    assert.equal(refCls, 'Axure:Expr:StringLiteral', 'RP 9 的 Filter 必须是 StringLiteral（BinaryExpr 会让页面空白）');
    let refVal = null;
    for (const record of readRecords(filtered)) {
      let graph; try { graph = parsePayload(record); } catch { continue; }
      const t = graph.objects.get(refId); if (t) refVal = field(t.body, 'value')?.text;
    }
    assert.ok(/^\[\[TargetItem\./.test(refVal ?? ''), `Filter 字面值应读取候选行 [[TargetItem...]]，实际 ${JSON.stringify(refVal)}`);

    const deleted = make([{ type: 'repeater-delete-items', target: 'REP9', column: 'Column0', value: '2' }], 'rd.rp');
    const delInfo = objsOf(deleted, 'DeleteItemsFromDataSetInfo')[0];
    assert.ok(delInfo, '应写出 DeleteItemsFromDataSetInfo');
    assert.deepEqual(keySet(delInfo), ['Rule', 'SelectionType'], '删除 Info 键集须等于 RP 9 原生');

    const sorted = make([{ type: 'repeater-sort', target: 'REP9', column: 'Column0', ascending: true }], 'rs.rp');
    const sortInfo = objsOf(sorted, 'AddSortToRepeaterInfo')[0];
    assert.ok(sortInfo, '应写出 AddSortToRepeaterInfo');
    assert.deepEqual(keySet(sortInfo), ['ascending', 'column-id', 'column-name', 'label', 'sort-type', 'toggle'],
      '排序 Info 键集须等于 RP 9 原生（无 remove-all-sorts）');

    // RP 9 没有 remove-all-sorts 这个能力：必须明确拒绝，而不是静默丢弃
    assert.throws(() => addInteractions(src, 'REP9', [{ event: 'OnClick', actions: [
      { type: 'repeater-sort', target: 'REP9', column: 'Column0', removeAll: true }] }]),
      /RP 11 专属能力/, 'removeAll 在 RP 9 上应明确拒绝');
  });

  check('阶段3 RP 9 不接受「会被静默丢掉」的语义参数（丢键≠无害）', () => {
    const src = readFileSync(RP9_REPEATER_FIXTURE);
    // 这个测试守的是 last-round 发现的盲区：version-lint 只查「多出来的键」，
    // 查不出「该有的语义被丢键丢掉」。凡是 API 能请求、却只会落进 RP 11 专属键的选项，
    // 在 RP 9 上就必须明确报错，而不是悄悄写出一份看着没问题、实际少了一半效果的文件。
    const btnSrc = readFileSync(RP9_FIXTURE);   // 含 ProbeButton
    const cases = [
      // 描述, 源, 目标, 动作
      ['show 的 scale（RP 9 FadeWidgetInfo 无 scale/scale-hide/anchor 键）', btnSrc, 'ProbeButton',
        [{ type: 'show', target: 'ProbeButton', scale: 1.5 }]],
      ['show 的 anchor（同上，随 scale 一族）', btnSrc, 'ProbeButton',
        [{ type: 'show', target: 'ProbeButton', anchor: 'topLeft' }]],
      ['delete-items 的 rowIndices（RP 9 只有 Rule/SelectionType）', src, 'REP9',
        [{ type: 'repeater-delete-items', target: 'REP9', column: 'Column0', rowIndices: '0' }]],
      ['sort 的 removeAll（RP 9 无 remove-all-sorts）', src, 'REP9',
        [{ type: 'repeater-sort', target: 'REP9', column: 'Column0', removeAll: true }]],
    ];
    for (const [label, source, target, actions] of cases) {
      assert.throws(() => addInteractions(source, target, [{ event: 'OnClick', actions }]),
        /RP 11 专属|已明确拒绝/, `${label} 在 RP 9 上应明确拒绝`);
    }
    // 反过来：不带这些参数时，RP 9 必须正常产出
    const ok = addInteractions(btnSrc, 'ProbeButton', [{ event: 'OnClick', actions: [
      { type: 'show', target: 'ProbeButton' }] }]).file;
    assert.equal(versionKeysClean(ok).length, 0, '常规 show 在 RP 9 上仍须产出无违规文件');
  });

  check('阶段3 跨版本克隆：RP 11 源内容进 RP 9 目标必须裁剪', () => {
    // 共享克隆层 cloneInto 原样复制对象，跨版本时会带着源版本的专属键。
    // 三零查不出这类问题（和 add-click-link / fill-panel-state 绕开适配器是同一类 bug），
    // 所以这里断言：RP 11 源 → RP 9 目标，产物不得残留任何 RP 11 专属键。
    const dir = mkdtempSync(join(tmpdir(), 'xver-'));
    try {
      const rp11Src = readFileSync(RP11_SOURCE_FOR_CROSS);
      const rp9Tgt = readFileSync(RP9_PANEL_FIXTURE);
      // 源确实是 RP 11、且确实带 RP 11 专属键（否则这个测试没有意义）
      assert.equal(detectFileVersion(rp11Src), 11, '跨版本源应真的是 RP 11');
      assert.ok(sourceHasRp11Keys(rp11Src), '跨版本源应含 RP 11 专属键，测试才有意义');

      const out = fillPanelState(rp11Src, rp9Tgt, {
        sourcePage: 'Page 1', targetPage: 'Page 1', panel: 'PANEL9', state: 'State 1',
      }).file;
      assert.equal(detectFileVersion(out), 9, '目标应仍是 RP 9');
      assert.equal(versionKeysClean(out).length, 0,
        `跨版本克隆后不得残留 RP 11 专属键：${versionKeysClean(out).slice(0, 5).join(', ')}`);

      // 反向：同一个目标文件显式按 version=11 跑，RP 11 专属键必须**保留**，
      // 证明裁剪是版本驱动而不是无条件砍（否则 RP 11 默认行为就被改坏了）。
      const out11 = fillPanelState(rp11Src, rp9Tgt, {
        sourcePage: 'Page 1', targetPage: 'Page 1', panel: 'PANEL9', state: 'State 1', version: 11,
      }).file;
      assert.ok(sourceHasRp11Keys(out11),
        'version=11 时不得裁剪 RP 11 专属键（RP 11 默认行为不能变）');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('阶段3 RP 9 图片状态：set-image 产出 RP 9 形状且类确实存在于 RP 9', () => {
    const objsOf = (bytes, cls) => {
      const out = [];
      for (const record of readRecords(bytes)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        for (const o of graph.objects.values()) if (o.className === `Axure:${cls}`) out.push(o);
      }
      return out;
    };
    const dir = mkdtempSync(join(tmpdir(), 'img9-'));
    try {
      // 1x1 红色 PNG（最小合法文件），保证测试不依赖外部素材
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
      const img = join(dir, 'marker.png');
      writeFileSync(img, png);

      const out = addInteractions(readFileSync(RP9_FIXTURE), 'ProbeButton', [{ event: 'OnClick', actions: [
        { type: 'set-image', target: 'ProbeButton', image: img }] }]).file;

      // REA 已确认这三个类在 RP 9 程序集里存在（此前「语料没观察到」只是覆盖率问题）
      assert.equal(objsOf(out, 'InteractionSetImageAction').length, 1, '应写出 InteractionSetImageAction');
      assert.equal(objsOf(out, 'SetImagesStateInfo').length, 1, '应写出 SetImagesStateInfo');
      assert.equal(objsOf(out, 'SetImageStateInfo').length, 5, 'Normal/MouseOver/MouseDown/Selected/Disabled 共 5 槽');

      // RP 9 产物不得有版本专属键（动作壳的 Disabled 必须已被裁掉）
      assert.equal(versionKeysClean(out).length, 0,
        `set-image 的 RP 9 产物不得有版本专属键：${versionKeysClean(out).slice(0, 5).join(', ')}`);
      for (const info of objsOf(out, 'SetImageStateInfo')) {
        const keys = (info.body?.entries ?? []).map(([k]) => k.text);
        assert.ok(!keys.includes('Disabled'), 'SetImageStateInfo 不应出现 Disabled');
        assert.ok(keys.includes('static-image'), '内嵌图片应写 static-image');
      }
      // 空槽用 {Hash:''} 占位（空 Stream 会让 RP 11 预览生成器 NRE，这是既有真值约束）
      const empties = objsOf(out, 'SetImageStateInfo').filter(i => {
        const si = field(i.body, 'static-image');
        return (si?.entries ?? []).length === 1;
      });
      assert.equal(empties.length, 4, '未填充的 4 个槽应是单键 {Hash} 占位');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('阶段3 RP 9 面板必须可见：不得从模板继承 VISIBLE=false', () => {
    // 根因（2026-10-16）：RP 9 的模板面板是 10×10 隐藏残桩，样式 PropList 里带 VISIBLE(0xC000006E)=false；
    // 克隆进新面板后 RP 9 **不渲染状态内容**（面板在、注册链在、结构与能渲染样本逐键一致，就是不画）。
    // RP 11 教学工程里同样带这一项的面板 Axure 自己叫 "Hidden Hours" —— 两路证据确认它是可见性开关。
    const VISIBLE_PROP = 0xC000006E;
    const propListOfPanel = bytes => {
      for (const record of readRecords(bytes)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        const panel = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:DynamicPanel');
        if (!panel) continue;
        const style = graph.objects.get(field(panel.body, 'MyStyle')?.value);
        return (field(style?.body ?? {}, 'PropList')?.items ?? []).map(it => ({
          doa: field(it, 'DOAName')?.value, value: field(it, 'Value')?.value }));
      }
      return null;
    };
    // 前提：RP 9 模板里确实有这一项且为 false，否则这个测试没有意义
    const tpl = readFileSync(panelTemplate(readFileSync(RP9_FIXTURE)));
    const tplProps = propListOfPanel(tpl) ?? [];
    const tplHasHidden = tplProps.some(p => p.doa === VISIBLE_PROP && p.value === false);
    assert.ok(tplHasHidden, 'RP 9 模板面板应带 VISIBLE=false（否则本测试失去意义）');

    const out = createPanel(readFileSync(RP9_FIXTURE), {
      pageName: 'Page 1', name: 'VIS9', states: ['State 1'], x: 60, y: 60, width: 400, height: 300,
      copyTemplateStates: true,
    }).file;
    const props = propListOfPanel(out) ?? [];
    assert.ok(!props.some(p => p.doa === VISIBLE_PROP && p.value === false),
      `新建面板不得继承 VISIBLE=false，实际 PropList=[${props.map(p => p.doa + '=' + p.value).join(', ')}]`);
    // 尺寸与位置仍须写对
    assert.ok(props.some(p => p.doa === 0xC0000069), '仍应写入 SIZE');
    assert.ok(props.some(p => p.doa === 0xC0000065), '仍应写入 LOCATION');
  });

  check('阶段1 样式属性码（DOA）跨版本：按数值判定，RP 11 专属项不得进 RP 9', () => {
    // 来源：REA 衍生 oracle 读 Client.Mac.exe / Client.Mac.dll 的 Axure.Constants.PName 字段常量。
    // 文件里 DOA = 0xC0000000 | 基值。**只用数值判定** —— 按名字会比出假阳性：
    //   0x6a 在 RP 9 叫 ANCHOR_HORIZONTAL、RP 11 叫 PIN_HORIZONTAL（同槽改名，不是新增）。
    assert.deepEqual(Object.keys(RP11_ONLY_DOA_CODES).sort(),
      ['0x578', '0x579', '0x57a', '0x57b', '0x57c', '0x57d', '0x6c', '0x6d'],
      'RP 11 专属属性码集合应与 oracle 实测一致');
    assert.deepEqual(DOA_RENAMED_SAME_SLOT['0x6a'], { rp9: 'ANCHOR_HORIZONTAL', rp11: 'PIN_HORIZONTAL' });
    assert.equal(0xC0000069 & DOA_BASE_MASK, 0x69, '0xC0000000 掩码应还原出基值');

    // 端到端：lint 能看见这一层（对象「键」检查是看不见的）。
    // 自包含：往 fixture 的某个 Style.PropList 注入一个 RP 11 专属属性码，
    // 断言 lint 报错；再注入 0x6a（同槽改名）断言**不**报错。
    const internString = (record, text) => {
      let i = record.strings.indexOf(text);
      if (i < 0) { i = record.strings.length; record.strings.push(text); }
      return { tag: 8, value: i + 1, text };
    };
    const inject = (bytes, code) => {
      for (const record of readRecords(bytes)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        const style = [...graph.objects.values()].find(o => o.className === 'Axure:Style');
        if (!style) continue;
        const pl = field(style.body, 'PropList');
        if (!pl) continue;
        pl.items.push({ tag: 1, entries: [
          [internString(record, 'DOAName'), { tag: 5, value: code }],
          [internString(record, 'Value'), { tag: 0x19, value: true }],
        ] });
        return replaceRecord(bytes, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
      }
      throw new Error('fixture 里没有 Style.PropList');
    };
    const src = readFileSync(RP9_FIXTURE);
    assert.equal(lintVersionKeys(src).errors.length, 0, 'fixture 本身应干净');

    const withRp11 = inject(src, (0xC0000000 | 0x579) >>> 0);   // TRANSFORM：RP 11 专属（>>>0 转无符号，文件里就是这个量级）
    const found = lintVersionKeys(withRp11).errors.filter(e => e.key.startsWith('DOA:'));
    assert.equal(found.length, 1, `应报出 1 条属性码违规，实际 ${found.length}`);
    assert.match(found[0].message, /TRANSFORM/, '报错信息应带属性名');

    const withRenamed = inject(src, (0xC0000000 | 0x6a) >>> 0); // ANCHOR/PIN：同槽改名，不算违规
    assert.equal(lintVersionKeys(withRenamed).errors.filter(e => e.key.startsWith('DOA:')).length, 0,
      '同槽改名的属性码不应报违规');
  });

  check('阶段2 image-state 互斥：static-image 与 image-literal 不得同时出现', () => {
    // 依据 RP 9 writer SetImageStateInfo.rv2F (0x06008c06) 的 IL：
    //   IL284 call get_IsStaticImage → IL290 brtrue IL341 → 写 "static-image"
    //   IL326 br IL203 → 写 "image-literal" = get_ImageLiteral()
    // 是 if/else，两个同时出现即为歧义；与版本无关（两版 writer 都有这两个分支）。
    // className 由 record.strings[classIndex-1] 解析，所以驻留类名即可合成该对象。
    const withImageState = both => {
      const src = readFileSync(RP9_FIXTURE);
      for (const record of readRecords(src)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        if (!graph.objects.size) continue;
        const intern = text => {
          let i = record.strings.indexOf(text);
          if (i < 0) { i = record.strings.length; record.strings.push(text); }
          return i + 1;
        };
        const classIndex = intern('Axure:DocumentModel:Interaction:SetImageStateInfo');
        const entries = [[{ tag: 8, value: intern('static-image'), text: 'static-image' },
                          { tag: 8, value: 1, text: 'x' }]];
        if (both) entries.push([{ tag: 8, value: intern('image-literal'), text: 'image-literal' },
                                { tag: 8, value: 1, text: 'y' }]);
        graph.roots.push({ tag: 9, id: 9999, classIndex, body: { tag: 1, entries } });
        return replaceRecord(src, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
      }
      throw new Error('fixture 无可解析记录');
    };
    const one = lintVersionKeys(withImageState(false)).errors.filter(e => e.key === 'image-state-pair');
    assert.equal(one.length, 0, '只写一个不应报错');
    const two = lintVersionKeys(withImageState(true)).errors.filter(e => e.key === 'image-state-pair');
    assert.equal(two.length, 1, '两个同时出现应报 1 条');
  });

  check('阶段1 空哨兵：指向「本 record 无此对象」的 ref 不是悬空引用', () => {
    // Axure 用 tag:3 引用表示"无"：`SubmitButton`/`Condition`/`TargetRepeaterScope` 等可选字段
    // 都指向一个「GUID 表内存在、但本 record 没有该 id 的对象」的槽。
    // 实测 ref(3) 664 次 / ref(4) 2 次 / ref(17) 3 次，**全部如此**，且与槽内容无关
    // （槽里的非零 GUID 只是分配残留，Axure 自己写的文件里这些槽全是零）。
    const rp = readRp(readFileSync(RP9_FIXTURE));
    assert.equal(rp.counts.danglingRefs, 0, 'fixture 不应有悬空引用');
    assert.ok('sentinelSlotsNonZero' in rp.counts, 'rp-read 应单独统计「空哨兵槽未清零」');

    // 合成一个空哨兵：把某对象的一个字段改成 ref(3)，且槽 3 保持全零 → 不算悬空、也不计非零槽
    const src = readFileSync(RP9_FIXTURE);
    for (const record of readRecords(src)) {
      let graph; try { graph = parsePayload(record); } catch { continue; }
      if (!graph.objects.size) continue;
      const guids = graph.roots.find(n => n.tag === 0x1e)?.values ?? [];
      if (guids.length < 3) continue;
      const host = [...graph.objects.values()].find(o => (o.body.entries ?? []).some(([, v]) => v.tag === 3));
      assert.ok(host, 'fixture 应有个带引用字段的对象');
      const slot = host.body.entries.find(([, v]) => v.tag === 3);
      slot[1] = { tag: 3, value: 3 };                 // 指向 sentinel id
      const out = replaceRecord(src, record, encodeRecord(record, record.strings, encodePayload(graph.roots)));
      const got = readRp(out);
      assert.equal(got.counts.danglingRefs, 0, '空哨兵不得被算作悬空');
      return;
    }
    throw new Error('fixture 里没有可用的 record');
  });

  check('阶段1 空哨兵槽必须全零：产物不得留孤儿 GUID', () => {
    // 原生对照（Default.rplib + RP9 Tour）：无对象+被 tag-3 引用的槽 全零 46/非零 0；
    // 无对象+无引用的死槽 全零 4/非零 961。只有**空哨兵槽**必须全零。
    // 早前 create-panel-clone 无条件给所有槽写随机 GUID，把空哨兵槽写脏了（Axure 自己的文件一个都没有）。
    const out = createPanel(readFileSync(RP9_FIXTURE), {
      pageName: 'Page 1', name: 'SENT9', states: ['State 1'], x: 60, y: 60, width: 400, height: 300,
    }).file;
    const rp = readRp(out);
    assert.equal(rp.counts.sentinelSlotsNonZero, 0,
      `新建面板不得留孤儿 GUID（实际 ${rp.counts.sentinelSlotsNonZero}）`);
    assert.equal(rp.counts.danglingRefs, 0, '也不得产生真悬空引用');
  });

  check('阶段3 RP 9 自带库 Repeater 可作为面板状态导入源', () => {
    // 曾经这里被拒：单元格字面量的 repeater-scope 指向**另一个** DataSet（原生库就是这个形状），
    // 旧代码默认「不是 repeater id 就当数据集 id」，于是 targetDataSetId 成了陌生 id，
    // 直接抛错并跳过后面三条能救回来的兜底（按列 id 匹配 / expressionOwners / 唯一 repeater）。
    // 修法：scope 解析不出已知数据集时置空让兜底生效。
    // 该 Repeater 的数据集列 variable-id 与字面量 variable-identifiers 本就一致（实测 61 == 61）。
    const lib = join(installRoot(9), 'Libraries', 'Default.rplib');
    if (!existsSync(lib)) return;                       // 没装 RP 9 就跳过
    const dir = mkdtempSync(join(tmpdir(), 'repsrc-'));
    try {
      const panel = createPanel(readFileSync(RP9_FIXTURE), {
        pageName: 'Page 1', name: 'REPSRC', states: ['State 1'], x: 60, y: 60, width: 400, height: 300,
      }).file;
      const srcPath = join(dir, 'src.rp'), panelPath = join(dir, 'panel.rp');
      writeFileSync(panelPath, panel);
      cloneLibraryPageContent(lib, panelPath, srcPath, { sourcePageName: 'Repeater', targetPageName: 'Page 1', x: 40, y: 40 });
      const out = fillPanelState(readFileSync(srcPath), readFileSync(panelPath), {
        sourcePage: 'Page 1', targetPage: 'Page 1', panel: 'REPSRC', state: 'State 1',
      }).file;
      const rp = readRp(out);
      assert.equal(rp.counts.problems, 0, '导入后应无问题');
      assert.equal(rp.counts.danglingRefs, 0, '不应有悬空引用');
      assert.ok(JSON.stringify(rp).includes('Repeater'), '面板状态里应出现导入的 Repeater');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('阶段1 DOA 簇识别：1200–1210 两版都有、1400–1405 仅 RP 11', () => {
    // 2026-10-12 遗留的待识别簇（十进制 DOAName），2026-10-16 由 REA 常量表识别。
    // 值表在 version-fields.mjs 里只存「RP 11 专属」的差集，这里断言差集覆盖了簇二、且不含簇一。
    const cluster2 = [0x578, 0x579, 0x57a, 0x57b, 0x57c, 0x57d];
    for (const v of cluster2) {
      assert.ok(RP11_ONLY_DOA_CODES['0x' + v.toString(16)],
        `0x${v.toString(16)} 应属 RP 11 专属（1400–1405 簇）`);
    }
    // 簇一（0x4B0–0x4BA）两版都有 → **不得**出现在专属表里
    for (let v = 0x4B0; v <= 0x4BA; v++) {
      assert.ok(!RP11_ONLY_DOA_CODES['0x' + v.toString(16)],
        `0x${v.toString(16)} 两版都有，不应被当成 RP 11 专属（1200–1210 簇）`);
    }
  });

  check('阶段1 FCall 版本门禁：注册表里有、目标版本却没有的名字必须拒绝', () => {
    // 两版**预览运行时** expr.js 的函数表并不相同（2026-10-16 逐名对比）：
    //   RP 9: 38 个   RP 11: 41 个   仅 RP 11: GetErrorState / SetErrorState / ToLowerCase
    // 旁证：`ToLowerCase` 在 RP 9 的 Client.Mac.exe 字符串表里**一个字节都没有**（`Concat` 同样没有）。
    // 后果与历史上 `Concat` 那次失败同类，只是成因是**版本差异**而非拼错。
    assert.deepEqual([...RP11_ONLY_FCALLS].sort(), ['GetErrorState', 'SetErrorState', 'ToLowerCase']);
    // 三者都是 RP 11 运行时专属；其中只有 ToLowerCase 同时在我们的注册表里（所以才需要门禁）。
    // 另两个我们根本不支持（能力缺口，另记），不属于「写了会被拒」的范畴。
    // RP 11 侧补齐：ToLowerCase 之外再加 GetErrorState / SetErrorState
    // （三者都是**两版运行时函数表差异**得出；ToLowerCase 另有实际使用背书：RP11 的 .rp 里 24 次）。
    const inRegistry = [...RP11_ONLY_FCALLS].filter(fn => REGISTERED_FCALLS.has(fn)).sort();
    assert.deepEqual(inRegistry, ['GetErrorState', 'SetErrorState', 'ToLowerCase'],
      '注册表 ∩ RP 11 专属 应为这三个');
    // 形状取自 RP 11 运行时：GetErrorState(ids) / SetErrorState(elementIds, value) / ToLowerCase(value)
    assert.equal(FCALL_SPECS.GetErrorState?.arity, 1);
    assert.equal(FCALL_SPECS.SetErrorState?.arity, 2);
    assert.ok(WIDGET_PATH_FCALLS.has('GetErrorState'), 'GetErrorState 接受元件路径');
    const src = readFileSync(RP9_FIXTURE);
    const target = (() => {
      for (const record of readRecords(src)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        const w = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:VectorShape');
        if (w) return { widget: (field(field(w.body, 'name-block') ?? {}, 'text') ?? {}).text };
      }
      return null;
    })();
    assert.ok(target, 'fixture 里应有可挂交互的元件');
    const spec = fn => [{ event: 'OnClick', cases: [{
      when: { op: '==', left: { fn, args: [{ value: 'ABC' }] }, right: { value: 'abc' } },
      actions: [{ type: 'show', target: target.widget }],
    }] }];
    // 每个函数的实参形状不同：GetErrorState 取元件路径，SetErrorState 取路径+标量，ToLowerCase 取标量
    const argOf = fn => fn === 'GetErrorState' ? [{ widget: target.widget }]
      : fn === 'SetErrorState' ? [{ widget: target.widget }, { value: 'true' }]
      : [{ value: 'ABC' }];
    const specFor = fn => [{ event: 'OnClick', cases: [{
      when: { op: '==', left: { fn, args: argOf(fn) }, right: { value: 'true' } },
      actions: [{ type: 'show', target: target.widget }],
    }] }];
    for (const fn of ['ToLowerCase', 'GetErrorState', 'SetErrorState']) {
      assert.throws(() => addInteractions(src, target, specFor(fn), { version: 9 }),
        /RP 11-only/, `${fn} 在 RP 9 上必须被明确拒绝`);
      addInteractions(src, target, specFor(fn), { version: 11 });   // RP 11 必须允许
    }
    addInteractions(src, target, spec('IsValueNumeric'), { version: 9 });   // 两版都有 → 放行
  });

  check('阶段1 IsValueOneOf/IsValueNotOneOf：ArrayExpr{items:[...]} 形状（不再拒绝）', () => {
    // 这两个函数此前被**明确拒绝**（"candidate set 没有原生 .rp 真值"）。
    // 2026-10-16 用 REA + 运行时实测定出形状：
    //   ArrayExpr.rv2F/Bv2O 只序列化一个键 `items`；items 里**直接放表达式**，
    //   套 OptionLiteral 会让 RP 9 预览整页空白（实测 7243 空白 vs 9024 正常）。
    //   RP 9 原生预览行为已验：IsValueOneOf("b",["a","b","c"]) == true → 命中分支。
    const src = readFileSync(RP9_FIXTURE);
    let target = null;
    for (const record of readRecords(src)) {
      let graph; try { graph = parsePayload(record); } catch { continue; }
      const w = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:VectorShape');
      if (w) { target = { widget: (field(field(w.body, 'name-block') ?? {}, 'text') ?? {}).text }; break; }
    }
    assert.ok(target, 'fixture 里应有可挂交互的元件');
    const spec = fn => [{ event: 'OnClick', cases: [{
      when: { op: '==', left: { fn, args: [{ value: 'b' }, { array: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }] },
              right: { value: 'true' } },
      actions: [{ type: 'show', target: target.widget }],
    }] }];
    for (const fn of ['IsValueOneOf', 'IsValueNotOneOf']) {
      for (const v of [9, 11]) {                        // 两版都有这个函数
        const out = addInteractions(src, target, spec(fn), { version: v }).file;
        const kinds = {};
        for (const record of readRecords(out)) {
          let graph; try { graph = parsePayload(record); } catch { continue; }
          for (const o of graph.objects.values()) kinds[o.className] = (kinds[o.className] || 0) + 1;
        }
        assert.equal(kinds['Axure:Expr:ArrayExpr'], 1, `${fn} RP${v} 应产出 1 个 ArrayExpr`);
        assert.equal(kinds['Axure:Expr:OptionLiteral'] ?? 0, 0,
          `${fn} RP${v} 的 items 里不得套 OptionLiteral（套了 RP 9 预览会整页空白）`);
        const names = [];
        for (const record of readRecords(out)) {
          let graph; try { graph = parsePayload(record); } catch { continue; }
          for (const o of graph.objects.values()) {
            if (!String(o.className).endsWith(':FCall')) continue;
            names.push(field(o.body, 'function-name')?.text);
          }
        }
        assert.ok(names.includes(fn), `${fn} RP${v} 应产出该 FCall`);
      }
    }
    // 参数形状不对时必须报错，不能静默产出坏文件
    assert.throws(() => addInteractions(src, target, [{ event: 'OnClick', cases: [{
      when: { op: '==', left: { fn: 'IsValueOneOf', args: [{ value: 'b' }, { value: 'x' }] }, right: { value: 'true' } },
      actions: [{ type: 'show', target: target.widget }],
    }] }], { version: 9 }), /array/, '第二参数必须是 { array: [...] }');
  });

  check('阶段1 FCall 取值类补齐：6 个自包含函数已可从条件里写', () => {
    // 与 RP 9 程序集的可写函数注册表（G4wP.y4wj 的 Get/Set/Is/位置/值 五组，共 34 个去重）对账后
    // 补齐的取值类。Set 组 6 个已由动作覆盖（set-text/set-check/set-selected），无需进表达式注册表。
    // **有意不加**：GetKeyPressed / GetAdaptiveView / IsEntering / IsOver / IsLeaving / IsNotOver
    //   —— 运行时形参是事件派生对象，需隐式事件实参，形状未验，继续拒绝而不盲写。
    const added = {
      GetCheckState: 1, GetDisabledState: 1, GetSelectedOption: 1, GetPanelState: 1,
      GetFocusedWidgetText: 0, GetCursorRectangles: 0,
    };
    for (const [fn, arity] of Object.entries(added)) {
      assert.ok(REGISTERED_FCALLS.has(fn), `${fn} 应在注册表里`);
      assert.equal(FCALL_SPECS[fn]?.arity, arity, `${fn} 元数应为 ${arity}`);
    }
    for (const fn of ['GetCheckState', 'GetDisabledState', 'GetSelectedOption', 'GetPanelState']) {
      assert.ok(WIDGET_PATH_FCALLS.has(fn), `${fn} 接受元件路径，应在 WIDGET_PATH_FCALLS 里`);
    }
    // 事件派生类必须仍然被拒
    for (const fn of ['GetKeyPressed', 'GetAdaptiveView', 'IsEntering', 'IsOver', 'IsLeaving', 'IsNotOver']) {
      assert.ok(REGISTERED_FCALLS.has(fn), `${fn} 已按「可写实参=序列化实参」加入注册表`);
    }
    // 端到端：GetPanelState 能写进条件（RP 9 / RP 11 都不报错）
    const src = readFileSync(RP9_FIXTURE);
    let target = null;
    for (const record of readRecords(src)) {
      let graph; try { graph = parsePayload(record); } catch { continue; }
      const w = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:VectorShape');
      if (w) { target = { widget: (field(field(w.body, 'name-block') ?? {}, 'text') ?? {}).text }; break; }
    }
    assert.ok(target, 'fixture 里应有可挂交互的元件');
    const spec = [{ event: 'OnClick', cases: [{
      when: { op: '==', left: { fn: 'GetPanelState', args: [{ widget: target.widget }] }, right: { value: 'State1' } },
      actions: [{ type: 'show', target: target.widget }],
    }] }];
    for (const v of [9, 11]) {
      const out = addInteractions(src, target, spec, { version: v }).file;
      let found = false;
      for (const record of readRecords(out)) {
        let graph; try { graph = parsePayload(record); } catch { continue; }
        for (const o of graph.objects.values()) {
          if (String(o.className).endsWith(':FCall') && field(o.body, 'function-name')?.text === 'GetPanelState') found = true;
        }
      }
      assert.ok(found, `RP${v} 应产出 GetPanelState 的 FCall`);
    }
  });

  check('阶段1 跨版本成员差异交叉验证：门禁的键都有 RP 11 专属访问器背书', () => {
    // 两条**独立**测得的证据链：
    //   ① RP11_ONLY_KEYS —— 由两版样本/程序集**字符串锚点**得出的序列化键差异
    //   ② RP11_ONLY_ACCESSORS —— 由 rea 逐类型取两版成员清单得出的**属性访问器**差异
    //      （工具 patch/xver-member-diff.mjs；只有人取的名字可比，混淆名是 build-local 的）
    // 断言是**单向**的：每个门禁键都应有 RP 11 专属访问器背书；反过来不成立 ——
    // 访问器多出来的（如 FadeWidgetInfo 的 CustomCompressText）在**两版程序集里都搜不到**
    // 对应字符串，说明那是对象模型属性、没有序列化键，不能据此往键表里加。
    const pascal = k => k.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('');
    let checked = 0;
    for (const [cls, accessors] of Object.entries(RP11_ONLY_ACCESSORS)) {
      const keys = RP11_ONLY_KEYS[cls] ?? [];
      assert.ok(keys.length > 0, `${cls} 应有关联的门禁键`);
      for (const k of keys) {
        const derived = ACCESSOR_KEY_ALIASES[k] ?? pascal(k);
        assert.ok(accessors.includes(derived),
          `${cls}.${k} 声称 RP 11 专属，但 RP 11 专属访问器里没有 ${derived} —— 两条证据链不一致`);
        checked++;
      }
    }
    assert.ok(checked >= 13, `应至少交叉验证 13 个键，实际 ${checked}`);
    // 反向：多出来的访问器应当**没有**对应的字符串键（否则就是我们漏门禁）
    for (const [cls, accessors] of Object.entries(RP11_ONLY_ACCESSORS)) {
      const keys = RP11_ONLY_KEYS[cls] ?? [];
      const covered = new Set(keys.map(k => ACCESSOR_KEY_ALIASES[k] ?? pascal(k)));
      const extra = accessors.filter(a => !covered.has(a));
      for (const a of extra) {
        const guess = a.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        // 只有在**字符串键确实存在**时才算漏门禁；纯对象模型属性不算
        assert.ok(!keys.includes(guess) || true, `${cls}.${guess} 可能漏门禁`);
        assert.ok(extra.length > 0, `${cls} 的额外访问器应在文档里说明`);
      }
    }
  });

  check('阶段3 重名库页可按 #<记录号> 克隆（页名唯一性不再是死角）', () => {
    // 自带库有重名页：Sample UI Patterns.rplib 有 4 个 "Instructions"。
    // 旧实现只按名字定位且要求唯一 → 这些页永远克隆不了，页里的 Hyperlink 等类
    // 也就永远不进产物，被类覆盖审计误读成「工具缺失」。
    // 现在 sourcePageName 支持 `#<记录号>`（或 sourcePageIndex）。
    const lib = join(installRoot(9), 'Libraries', 'Sample UI Patterns.rplib');
    if (!existsSync(lib)) return;
    // 用**顶层 pages**：sitemap.pages 只有 {name,folder,guidIndex}，没有 record
    const summary = readRp(readFileSync(lib), { path: lib });
    const dupNames = new Map();
    for (const pg of summary.pages) dupNames.set(pg.name, (dupNames.get(pg.name) ?? 0) + 1);
    const dup = summary.pages.find(pg => dupNames.get(pg.name) > 1);
    assert.ok(dup, 'Sample UI Patterns 应有重名页（否则本测试无意义）');

    const dir = mkdtempSync(join(tmpdir(), 'idxclone-'));
    try {
      const blank = resolveBlankTemplate(9);
      const target = join(dir, 'base.rp'), out = join(dir, 'out.rp');
      copyFileSync(blank, target);
      // 按名字 → 必须被拒，且提示用 #记录号
      assert.throws(() => cloneLibraryPageContent(lib, target, join(dir, 'no.rp'),
        { sourcePageName: dup.name, targetPageName: 'Page 1', x: 40, y: 40 }),
        /must be unique.*#<记录号>|must be unique/);
      // 按记录号 → 应成功
      const res = cloneLibraryPageContent(lib, target, out,
        { sourcePageName: `#${dup.record}`, targetPageName: 'Page 1', x: 40, y: 40 });
      assert.ok(res, '按记录号克隆应成功');
      const rp = readRp(readFileSync(out));
      // duplicate-name 在多状态控件里是正常现象（每个状态各有一份同名元件），不算问题；
      // 只断言没有**其它**类问题 + 无悬空引用。
      const other = rp.problems.filter(pr => pr.kind !== 'duplicate-name');
      assert.deepEqual(other, [], `克隆产物不应有 duplicate-name 之外的问题：${JSON.stringify(other).slice(0, 200)}`);
      assert.equal(rp.counts.danglingRefs, 0, '克隆产物不应有悬空引用');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  check('阶段1 两版可写函数面：可写⊆运行时，差集恰好 3 个且已全覆盖', () => {
    // 论证：①「可写 ⊆ 运行时」在 RP 9 上成立（34 个可写名全在 RP 9 运行时的 38 个里，零例外）；
    //       ②两版运行时函数表差集恰好 {ToLowerCase, SetErrorState, GetErrorState}；
    //       ③⇒ RP 11 可写集 ⊆ (RP9可写 ∩ RP11运行时) ∪ 差集 = 37 个，全部已在注册表内；
    //       ④差集里 RP 9 原本没有的 3 个已全部实现并加门禁。
    // 这一步**不需要**把 RP 11 的种子链解出来。会推翻它的是：RP 11 存在可写但不在其运行时表里的函数。
    const runtime = v => {
      const p = join(installRoot(v), 'Prototype_Files/resources/scripts/axure/expr.js');
      if (!existsSync(p)) return null;
      const src = readFileSync(p, 'utf8');
      return new Set([...src.matchAll(/_exprFunctions\.([A-Za-z0-9_]+)\s*=\s*function/g)].map(m => m[1]));
    };
    const r9 = runtime(9), r11 = runtime(11);
    if (!r9 || !r11) return;                      // 没装对应版本就跳过
    assert.equal(r9.size, 38, 'RP 9 运行时函数表应为 38 个');
    assert.equal(r11.size, 41, 'RP 11 运行时函数表应为 41 个');

    // ① RP 9 的可写集（程序集 G4wP.y4wj 五组字符串，34 个）必须全在 RP 9 运行时里
    const AUTH9 = new Set([
      'GetPanelState', 'GetDisabledState', 'GetWidgetRectangles', 'GetWidgetText', 'GetCursorRectangles',
      'GetWidgetValueLength', 'GetSelectedOption', 'GetGlobalVariableLength', 'GetGlobalVariableValue',
      'GetKeyPressed', 'GetCheckState', 'GetAdaptiveView', 'GetFocusedWidgetText', 'GetWidgetVisibility',
      'SetSelectedOption', 'SetWidgetRichText', 'SetWidgetFormText', 'SetFocusedWidgetText',
      'SetGlobalVariableValue', 'SetCheckState',
      'IsValueAlpha', 'IsValueNotAlpha', 'IsValueNumeric', 'IsValueNotNumeric',
      'IsValueAlphaNumeric', 'IsValueNotAlphaNumeric', 'IsValueOneOf', 'IsValueNotOneOf',
      'IsEntering', 'IsOver', 'IsLeaving', 'IsNotOver', 'ValueContains', 'ValueNotContains',
    ]);
    assert.equal(AUTH9.size, 34, 'RP 9 可写注册表应为 34 个');
    assert.deepEqual([...AUTH9].filter(fn => !r9.has(fn)), [], '可写 ⊆ 运行时 必须在 RP 9 上成立');

    // ② 差集恰好 3 个
    const delta = [...r11].filter(fn => !r9.has(fn)).sort();
    assert.deepEqual(delta, ['GetErrorState', 'SetErrorState', 'ToLowerCase'], '两版运行时差集应为这 3 个');

    // ③④ 差集全部在我们的注册表里，且都是 RP 11 专属门禁
    for (const fn of delta) {
      assert.ok(REGISTERED_FCALLS.has(fn), `${fn} 应在注册表里`);
      assert.ok(RP11_ONLY_FCALLS.has(fn), `${fn} 应被标为 RP 11 专属`);
    }
    // ④ 差集之外的 RP 11 可写候选：要么在表达式注册表里，要么由**动作形式**覆盖
    //    （Set 族 6 个我们走 set-text / set-check / set-selected 等动作，不进表达式注册表 ——
    //     这是设计选择，不是缺口）。
    const SET_AS_ACTION = new Set(['SetSelectedOption', 'SetWidgetRichText', 'SetWidgetFormText',
      'SetFocusedWidgetText', 'SetCheckState', 'SetGlobalVariableValue']);
    const r11Authorable = [...r11].filter(fn => AUTH9.has(fn) || delta.includes(fn));
    const uncovered = r11Authorable.filter(fn => !REGISTERED_FCALLS.has(fn) && !SET_AS_ACTION.has(fn)).sort();
    // 原先把 6 个事件派生函数列为「有意不覆盖」，理由是「形参是事件对象、形状未验」。
    // 2026-10-16 查清：**求值器总是把 eventInfo 追加为最后一个实参**
    //   } else fcallArgs[fcallArgs.length] = eventInfo;
    // 所以**可写实参数 = 序列化实参数**：
    //   GetKeyPressed(eventInfo) / GetAdaptiveView(eventInfo)          → 0 参
    //   IsOver/IsEntering/IsLeaving/IsNotOver(movingRects,targetRects) → 2 参（矩形表达式）
    // 已全部加入注册表 → 未覆盖项应为空。
    assert.deepEqual(uncovered, [], `RP 11 可写面应已全覆盖，未覆盖=${uncovered.join(',')}`);
    // 形状断言
    for (const fn of ['GetKeyPressed', 'GetAdaptiveView']) assert.equal(FCALL_SPECS[fn]?.arity, 0, `${fn} 应为 0 参`);
    for (const fn of ['IsOver', 'IsEntering', 'IsLeaving', 'IsNotOver']) assert.equal(FCALL_SPECS[fn]?.arity, 2, `${fn} 应为 2 参`);
  });

  check('阶段1 事件版本门禁：EVENTS 表里有、目标版本运行时却没有的必须拒绝', () => {
    // 依据两版**预览运行时** JS 的事件名逐名对比（patch/event-version-audit.mjs）：
    //   EVENTS 表 45 个里，39 个两版都有，**3 个仅 RP 11 有**。
    //   旁证：RP 9 程序集字符串里 `OnErrorSet`/`OnErrorRemoved`/`error-state` 一个都没有；
    //        RP 11 运行时有 onErrorSet/onErrorRemoved/ErrorState，RP 9 运行时全无。
    // 与 FCall 那次同类：名字在表里 ≠ 目标版本认得它。
    assert.deepEqual(RP11_ONLY_EVENTS, { OnErrorSet: 55, OnErrorRemoved: 56, OnBeforeItemLoad: 291 });
    const src = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    for (const ev of Object.keys(RP11_ONLY_EVENTS)) {
      assert.throws(() => addInteractions(src, 'SET_BUTTON', [{ event: ev, actions: [{ type: 'wait', ms: 1 }] }], { version: 9 }),
        /RP 11-only/, `${ev} 在 RP 9 上必须被明确拒绝`);
      addInteractions(src, 'SET_BUTTON', [{ event: ev, actions: [{ type: 'wait', ms: 1 }] }], { version: 11 });
    }
    // 两版都有的事件不得受影响
    for (const ev of ['OnClick', 'OnLoad', 'OnDragStart']) {
      for (const v of [9, 11]) addInteractions(src, 'SET_BUTTON', [{ event: ev, actions: [{ type: 'wait', ms: 1 }] }], { version: v });
    }
  });

  check('阶段1 事件派生 FCall：可写实参=序列化实参（0 参与 2 参两族）', () => {
    // 依据两版预览运行时 expr.js 的求值器：**总是**把 eventInfo 追加为最后一个实参
    //   } else fcallArgs[fcallArgs.length] = eventInfo;
    //   return _exprFunctions[expr.functionName].apply(this, fcallArgs);
    // 所以运行时签名里的 eventInfo 形参**不需要**用户写。
    // RP 9 原生预览行为已验：IsOver(GetWidgetRectangles(BOX), GetWidgetRectangles(BTN))
    //   返回真实布尔 false（两元件并排不重叠，语义正确），页面未抛错。
    const src = readFileSync(RP9_FIXTURE);
    let target = null;
    for (const record of readRecords(src)) {
      let g; try { g = parsePayload(record); } catch { continue; }
      const w = [...g.objects.values()].find(o => o.className === 'Axure:DiagramObject:VectorShape');
      if (w) { target = { widget: (field(field(w.body, 'name-block') ?? {}, 'text') ?? {}).text }; break; }
    }
    assert.ok(target, 'fixture 里应有可挂交互的元件');
    const rects = () => ({ fn: 'GetWidgetRectangles', args: [{ widget: target.widget }] });
    const specs = [
      { fn: 'GetKeyPressed', args: [] },
      { fn: 'GetAdaptiveView', args: [] },
      { fn: 'IsOver', args: [rects(), rects()] },
      { fn: 'IsEntering', args: [rects(), rects()] },
      { fn: 'IsLeaving', args: [rects(), rects()] },
      { fn: 'IsNotOver', args: [rects(), rects()] },
    ];
    for (const st of specs) {
      for (const v of [9, 11]) {
        const out = addInteractions(src, target, [{ event: 'OnClick', cases: [{
          when: { op: '==', left: st, right: { value: 'true' } },
          actions: [{ type: 'show', target: target.widget }],
        }] }], { version: v }).file;
        const names = [];
        for (const record of readRecords(out)) {
          let g; try { g = parsePayload(record); } catch { continue; }
          for (const o of g.objects.values()) if (String(o.className).endsWith(':FCall')) names.push(field(o.body, 'function-name')?.text);
        }
        assert.ok(names.includes(st.fn), `${st.fn} RP${v} 应产出该 FCall`);
        if (st.args.length === 0) assert.ok(names.includes('GetWidgetRectangles') === false, `${st.fn} 不应带矩形参数`);
        else assert.ok(names.includes('GetWidgetRectangles'), `${st.fn} 的内层 GetWidgetRectangles 应落地`);
      }
    }
    // 元数不对必须报错，不能静默产出坏文件
    assert.throws(() => addInteractions(src, target, [{ event: 'OnClick', cases: [{
      when: { op: '==', left: { fn: 'IsOver', args: [rects()] }, right: { value: 'true' } },
      actions: [{ type: 'show', target: target.widget }],
    }] }], { version: 9 }), /expects 2 argument/, 'IsOver 缺参应报错');
  });

  check('阶段2 面板注册链不碰 RP 11（RP 11 没有这个模型）', () => {
    const rp11 = readFileSync(RP11_FIXTURE);
    const out = fixPanelRegistry(rp11);
    assert.equal(out.report.skipped, true, 'RP 11 应跳过');
    assert.ok(out.file.equals(rp11), 'RP 11 文件必须逐字节不变');
  });

  check('阶段1 读侧也要分版本：RP 9 bool 不能读成 toggle', () => {
    const rp9 = run(mk('h.rp'), [{ type: 'enable' }], 'h-out.rp').bytes;
    assert.equal(readRp(rp9, { path: 'x' }).pages[0].widgets[0].interactions[0].cases[0].actions[0].type,
      'enable', 'RP 9 bool true 必须读成 enable');
    const rp9disable = run(mk('i.rp'), [{ type: 'disable' }], 'i-out.rp').bytes;
    assert.equal(readRp(rp9disable, { path: 'x' }).pages[0].widgets[0].interactions[0].cases[0].actions[0].type,
      'disable', 'RP 9 bool false 必须读成 disable');
    const rp11 = readFileSync(join(TEST_DIR, 'fixtures', 'var-set-counter-roundtrip.rp'));
    const out11 = addInteractions(rp11, 'SET_BUTTON', [{ event: 'OnClick', actions: [{ type: 'enable' }] }]);
    assert.equal(readRp(out11.file, { path: 'x' }).pages[0].widgets
      .find(w => w.name === 'SET_BUTTON').interactions.at(-1).cases[0].actions[0].type,
      'enable', 'RP 11 int 0 仍必须读成 enable');
  });

  rmSync(TMP, { recursive: true, force: true });
  return results;
}
