import { fixturePath, resolveLibrary } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TEST_DIR } from './fixture-summary.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { addInteractions, resolvePageRecord } from '../scripts/ix-actions.mjs';
import { setComboBoxOptions } from '../scripts/set-combobox-options.mjs';
import { duplicateMaster } from '../scripts/create-master.mjs';
import { placeMaster } from '../scripts/place-master.mjs';
import { cloneLibraryWidget } from '../scripts/clone-library-widget.mjs';
import { cloneLibraryPageContent } from '../scripts/clone-library-page-content.mjs';
import { validateSemantics } from './check-semantics.mjs';

function assertThreeZero(bytes, label = '') {
  const summary = readRp(bytes, { full: true });
  assert.equal(summary.records.unparseable, 0, `${label} unparseable !== 0`);
  assert.equal(summary.counts.danglingRefs, 0, `${label} danglingRefs !== 0`);
  assert.equal(summary.counts.problems, 0, `${label} problems !== 0`);
  return summary;
}

export function runWriterSemanticsChecks() {
  const results = [];
  const check = (name, run) => {
    try { run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error.message }); }
  };

  check('ix-actions 基础动作 (show/hide/toggle/wait) 字段语义及动画属性断言', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      actions: [
        { type: 'show', duration: 350, animation: 'slideUp', bringToFront: true },
        { type: 'hide', duration: 400, animation: 'fade' },
        { type: 'toggle', duration: 250, animation: 'fade' },
        { type: 'wait', ms: 800 },
      ],
    }], { replaceEvent: true });

    assertThreeZero(file, 'show/hide/toggle/wait');
    const page = readRecords(file).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(page);

    const targetWidget = [...graph.objects.values()].find(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'SET_BUTTON');
    assert.ok(targetWidget, 'SET_BUTTON not found');

    // 从 targetWidget 的活动 InteractionMap -> node-table 链路获取动作
    const ixMap = graph.objects.get(field(targetWidget.body, 'InteractionMap').value);
    const nodeTable = field(ixMap.body, 'node-table');
    const actions = nodeTable.entries
      .map(([k, v]) => graph.objects.get(v.value))
      .filter(o => o && o.className.includes('Action'));
    assert.equal(actions.length, 4, 'expected 4 active actions');

    // action 0: show
    assert.equal(actions[0].className, 'Axure:InteractionFadeWidgetAction');
    const showInfo = graph.objects.get(field(actions[0].body, 'FadeInfos').items[0].value);
    assert.equal(field(showInfo.body, 'fade-action-type').value, 1, 'show fade-action-type !== 1');
    assert.equal(field(showInfo.body, 'duration').value, 350);
    assert.equal(field(showInfo.body, 'BringToFront').value, true);
    assert.equal(field(showInfo.body, 'easing').value, 4, 'slideUp easing code');

    // action 1: hide
    assert.equal(actions[1].className, 'Axure:InteractionFadeWidgetAction');
    const hideInfo = graph.objects.get(field(actions[1].body, 'FadeInfos').items[0].value);
    assert.equal(field(hideInfo.body, 'fade-action-type').value, 0, 'hide fade-action-type !== 0');
    assert.equal(field(hideInfo.body, 'duration').value, 400);

    // action 2: toggle
    assert.equal(actions[2].className, 'Axure:InteractionFadeWidgetAction');
    const toggleInfo = graph.objects.get(field(actions[2].body, 'FadeInfos').items[0].value);
    assert.equal(field(toggleInfo.body, 'fade-action-type').value, 2, 'toggle fade-action-type !== 2');
    assert.equal(field(toggleInfo.body, 'duration').value, 250);

    // action 3: wait
    assert.equal(actions[3].className, 'Axure:InteractionWaitAction');
    assert.equal(field(actions[3].body, 'wait_time').value, 800);
  });

  check('ix-actions 变换动作 (move/set-size/rotate) 坐标、尺寸、角度与 easing 断言', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      actions: [
        { type: 'move', x: 120, y: 240, mode: 'delta', duration: 400, easing: 'linear' },
        { type: 'move', x: 50, y: 80, mode: 'location', duration: 300, easing: 'swing' },
        { type: 'set-size', width: 200, height: 60, easing: 'swing', duration: 300, anchor: 'center' },
        { type: 'rotate', degree: 45, clockwise: true, duration: 500, easing: 'linear' },
      ],
    }], { replaceEvent: true });

    assertThreeZero(file, 'move/size/rotate');
    const page = readRecords(file).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(page);

    const targetWidget = [...graph.objects.values()].find(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'SET_BUTTON');
    const ixMap = graph.objects.get(field(targetWidget.body, 'InteractionMap').value);
    const nodeTable = field(ixMap.body, 'node-table');
    const actions = nodeTable.entries
      .map(([k, v]) => graph.objects.get(v.value))
      .filter(o => o && o.className.includes('Action'));
    assert.equal(actions.length, 4, 'expected 4 active actions');

    // action 0: move delta
    assert.equal(actions[0].className, 'Axure:InteractionMoveWidgetAction');
    const moveInfoDelta = graph.objects.get(field(actions[0].body, 'MoveInfos').items[0].value);
    assert.equal(field(moveInfoDelta.body, 'MoveType').value, 1, 'MoveType delta');
    assert.equal(field(moveInfoDelta.body, 'Duration').value, 400);
    assert.equal(field(moveInfoDelta.body, 'Easing').value, 2, 'linear easing');

    // action 1: move location (absolute)
    assert.equal(actions[1].className, 'Axure:InteractionMoveWidgetAction');
    const moveInfoLoc = graph.objects.get(field(actions[1].body, 'MoveInfos').items[0].value);
    assert.equal(field(moveInfoLoc.body, 'MoveType').value, 0, 'MoveType location');
    assert.equal(field(moveInfoLoc.body, 'Duration').value, 300);
    assert.equal(field(moveInfoLoc.body, 'Easing').value, 1, 'swing easing');

    // action 2: set-size
    assert.equal(actions[2].className, 'Axure:InteractionSetWidgetSizeAction');
    const sizeInfo = graph.objects.get(field(actions[2].body, 'SetSizeInfos').items[0].value);
    const widthLit = graph.objects.get(field(sizeInfo.body, 'width').value);
    const heightLit = graph.objects.get(field(sizeInfo.body, 'height').value);
    assert.equal(field(widthLit.body, 'value').text, '200');
    assert.equal(field(heightLit.body, 'value').text, '60');
    assert.equal(field(sizeInfo.body, 'anchor').text, 'center');

    // action 3: rotate
    assert.equal(actions[3].className, 'Axure:InteractionRotateWidgetAction');
    const rotInfo = graph.objects.get(field(actions[3].body, 'Infos').items[0].value);
    const degLit = graph.objects.get(field(rotInfo.body, 'Degree').value);
    assert.equal(field(degLit.body, 'value').text, '45');
    assert.equal(field(rotInfo.body, 'Clockwise').value, true);

    // 负例 1: move 非法 mode 拒绝
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      actions: [{ type: 'move', x: 10, y: 10, mode: 'invalidMode' }],
    }]), /Unknown move mode "invalidMode"/);

    // 负例 2: 非法 easing 数字代码拒绝
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      actions: [{ type: 'move', x: 10, y: 10, easing: 99999 }],
    }]), /Unknown easing numeric code 99999/);

    // 负例 3: 负数 duration 拒绝
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      actions: [{ type: 'move', x: 10, y: 10, duration: -100 }],
    }]), /move duration must be a non-negative finite number/);
  });

  check('ix-actions set-opacity 动画参数、百分比转换与非法值拒绝断言', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      actions: [
        { type: 'set-opacity', opacity: 75, duration: 450, easing: 'swing' },
      ],
    }], { replaceEvent: true });

    assertThreeZero(file, 'set-opacity');
    const page = readRecords(file).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(page);

    const opAction = [...graph.objects.values()].find(o => o.className === 'Axure:InteractionSetOpacityAction');
    assert.ok(opAction, 'set-opacity action not found');
    const opInfo = graph.objects.get(field(opAction.body, 'Infos').items[0].value);
    assert.equal(field(opInfo.body, 'Duration').value, 450);
    assert.equal(field(opInfo.body, 'Easing').value, 1, 'swing easing');
    const opLit = graph.objects.get(field(opInfo.body, 'Opacity').value);
    assert.equal(field(opLit.body, 'value').text, '75');

    // 负例: 非法 easing
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      actions: [{ type: 'set-opacity', opacity: 50, easing: 'invalidEasingName' }],
    }]), /Unknown easing "invalidEasingName"/);
  });

  check('ix-actions 状态与层级动作 (set-panel-state/set-panel-order/enable/disable/focus) 断言', () => {
    const source = readFileSync(fixturePath('panel-repeater-direct-roundtrip.rp'));
    const { file } = addInteractions(source, 'Show Data', [{
      event: 'OnClick',
      actions: [
        { type: 'set-panel-state', panel: 'REPEATER_PANEL', state: 'next', loop: true, repeatInterval: 1200 },
        { type: 'bring-to-front', target: 'REPEATER_PANEL' },
        { type: 'disable', target: 'Show Data' },
        { type: 'enable', target: 'Show Data' },
        { type: 'focus', target: 'Show Data', selectText: true },
      ],
    }], { replaceEvent: true });

    assertThreeZero(file, 'panel-state/order/disable/enable/focus');
    const page = readRecords(file).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(page);

    const targetWidget = [...graph.objects.values()].find(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'Show Data');
    const ixMap = graph.objects.get(field(targetWidget.body, 'InteractionMap').value);
    const nodeTable = field(ixMap.body, 'node-table');
    const actions = nodeTable.entries
      .map(([k, v]) => graph.objects.get(v.value))
      .filter(o => o && o.className.includes('Action'));
    assert.equal(actions.length, 5, 'expected 5 active actions');

    // action 0: panel-state
    assert.equal(actions[0].className, 'Axure:InteractionSetPanelStateAction');
    const stateInfo = graph.objects.get(field(actions[0].body, 'SetStateInfos').items[0].value);
    assert.equal(field(stateInfo.body, 'loop').value, true);
    assert.equal(field(stateInfo.body, 'repeat-interval').value, 1200);

    // action 1: panel-order
    assert.equal(actions[1].className, 'Axure:InteractionSetPanelOrderAction');
    const orderInfo = graph.objects.get(field(actions[1].body, 'SetOrderInfos').items[0].value);
    assert.equal(field(orderInfo.body, 'bring-to-front').value, true);

    // action 2: disable
    assert.equal(actions[2].className, 'Axure:InteractionEnableDisableWidgetsAction');
    const disInfo = graph.objects.get(field(actions[2].body, 'EnableDisableInfos').items[0].value);
    assert.equal(field(disInfo.body, 'enable').value, 1, 'disable is 1');

    // action 3: enable
    assert.equal(actions[3].className, 'Axure:InteractionEnableDisableWidgetsAction');
    const enInfo = graph.objects.get(field(actions[3].body, 'EnableDisableInfos').items[0].value);
    assert.equal(field(enInfo.body, 'enable').value, 0, 'enable is 0');

    // action 4: focus
    assert.equal(actions[4].className, 'Axure:InteractionSetFocusOnWidgetAction');
    assert.equal(field(actions[4].body, 'SelectTextOnFocus').value, true);
  });

  check('ix-actions 链接与树节点动作 (link/expand-collapse-tree) 断言', () => {
    const treeFixture = fixturePath('native-widgets-tree-trigger.rp');
    const source = readFileSync(treeFixture);
    const { file } = addInteractions(source, 'GUI_TREE_TRIGGER', [{
      event: 'OnClick',
      actions: [
        { type: 'expand-collapse-tree', target: 'TR1', expand: false },
        { type: 'link', url: 'https://example.com/test', window: 'new' },
      ],
    }], { replaceEvent: true });

    assertThreeZero(file, 'link/tree');
    const page = readRecords(file).find(r => r.className === 'Axure:Page');
    const graph = parsePayload(page);

    // link
    const linkActions = [...graph.objects.values()].filter(o => o.className === 'Axure:InteractionLinkWindowAction');
    const linkAction = linkActions[linkActions.length - 1];
    assert.ok(linkAction, 'link action not found');
    assert.equal(field(linkAction.body, 'link-type').value, 2, 'new window is 2');
    const target = graph.objects.get(field(linkAction.body, 'target').value);
    assert.equal(field(target.body, 'target-type').value, 0, 'url target is 0');
    const lit = graph.objects.get(field(target.body, 'target-literal').value);
    assert.equal(field(lit.body, 'value').text, 'https://example.com/test');

    // tree
    const treeActions = [...graph.objects.values()].filter(o => o.className === 'Axure:InteractionExpandCollapseTreeAction');
    const treeAction = treeActions[treeActions.length - 1];
    assert.ok(treeAction, 'tree action not found');
    const treeInfo = graph.objects.get(field(treeAction.body, 'ExpandCollapseInfos').items[0].value);
    assert.equal(field(treeInfo.body, 'expand').value, false);
  });

  check('ix-actions 中继器增删改排筛与分页动作断言', () => {
    const source = readFileSync(fixturePath('blank-page-in-existing-project-v2-gui.rp'));
    const { file } = addInteractions(source, { widget: 'R7', page: 'Quick win' }, [{
      event: 'OnClick',
      actions: [
        { type: 'repeater-sort', column: 'Score', ascending: false, label: 'SortScore' },
        { type: 'repeater-filter', column: 'First_Name', filter: 'Alice', condition: true, label: 'FilterAlice' },
        { type: 'set-repeater-items-per-page', count: 10, noLimit: false },
        { type: 'set-repeater-page', pageType: 'next' },
      ],
    }], { replaceEvent: true });

    assertThreeZero(file, 'repeater-sort/filter/paging');
    const pageRec = resolvePageRecord(file, 'Quick win');
    const graph = parsePayload(pageRec);

    // sort
    const sortActions = [...graph.objects.values()].filter(o => o.className === 'Axure:InteractionAddSortToRepeaterAction');
    const sortAction = sortActions[sortActions.length - 1];
    assert.ok(sortAction, 'repeater sort action not found');
    const sortInfo = graph.objects.get(field(sortAction.body, 'AddSortInfos').items[0].value);
    assert.equal(field(sortInfo.body, 'ascending').value, false);
    assert.equal(field(sortInfo.body, 'column-name').text, 'Score');
    assert.equal(field(sortInfo.body, 'label').text, 'SortScore');

    // filter
    const filterActions = [...graph.objects.values()].filter(o => o.className === 'Axure.InteractionAddFilterToRepeaterAction');
    const filterAction = filterActions[filterActions.length - 1];
    assert.ok(filterAction, 'repeater filter action not found');
    const filterInfo = graph.objects.get(field(filterAction.body, 'AddFilterInfos').items[0].value);
    assert.equal(field(filterInfo.body, 'Label').text, 'FilterAlice');
    assert.equal(field(filterInfo.body, 'UseCondition').value, true);

    // items per page
    const ippActions = [...graph.objects.values()].filter(o => o.className === 'Axure:InteractionSetItemPerRepeaterPageAction');
    const ippAction = ippActions[ippActions.length - 1];
    assert.ok(ippAction, 'items per page action not found');
    const ippInfo = graph.objects.get(field(ippAction.body, 'SetItemsPerPageInfos').items[0].value);
    assert.equal(field(ippInfo.body, 'no-limit').value, false);
    const countLit = graph.objects.get(field(ippInfo.body, 'items-per-page').value);
    assert.equal(field(countLit.body, 'value').text, '10');

    // set page
    const pageActions = [...graph.objects.values()].filter(o => o.className === 'Axure:InteractionSetRepeaterToPageAction');
    const pageAction = pageActions[pageActions.length - 1];
    assert.ok(pageAction, 'set page action not found');
    const pageInfo = graph.objects.get(field(pageAction.body, 'SetPageInfos').items[0].value);
    assert.equal(field(pageInfo.body, 'set-page-type').value, 2, 'next is 2');
  });

  check('set-combobox-options 选项数组、默认选定与越界保护断言', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'combobox-check-'));
    try {
      const src = fixturePath('master-state-form-source.rp');
      const out = join(tmpDir, 'out.rp');

      const res = setComboBoxOptions(src, out, 'Page 1', 'REPLACEMENT_DROPLIST', ['Option A', 'Option B', 'Option C'], { selectedIndex: 1 });
      assert.equal(res.addedObjects, 3);

      const bytes = readFileSync(out);
      assertThreeZero(bytes, 'combobox-options');

      const page = readRecords(bytes).find(r => r.className === 'Axure:Page');
      const graph = parsePayload(page);
      const widget = [...graph.objects.values()].find(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'REPLACEMENT_DROPLIST');
      assert.ok(widget, 'REPLACEMENT_DROPLIST not found');

      const options = field(widget.body, 'list-options').items.map(i => graph.objects.get(i.value));
      assert.equal(options.length, 3);
      assert.equal(field(options[0].body, 'object').text, 'Option A');
      assert.equal(field(options[0].body, 'selected').value, false);
      assert.equal(field(options[1].body, 'object').text, 'Option B');
      assert.equal(field(options[1].body, 'selected').value, true);

      // 负例: 越界 selectedIndex
      assert.throws(() => setComboBoxOptions(src, join(tmpDir, 'err1.rp'), 'Page 1', 'REPLACEMENT_DROPLIST', ['A', 'B'], { selectedIndex: 5 }),
        /selectedIndex must be between 0 and 1/);

      // 负例: 空 options
      assert.throws(() => setComboBoxOptions(src, join(tmpDir, 'err2.rp'), 'Page 1', 'REPLACEMENT_DROPLIST', []),
        /options must be a non-empty array/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  check('create-master 与 place-master 引用、GUID 与包依赖断言', () => {
    const src = readFileSync(fixturePath('master-direct-image-base.rp'));

    // 1. duplicateMaster
    const duplicated = duplicateMaster(src, 'OUTER_VISUAL_MASTER', 'CLONED_MASTER');
    assertThreeZero(duplicated.file, 'duplicateMaster');

    const doc = readRecords(duplicated.file).find(r => r.className === 'Axure:DesignDocument');
    const docGraph = parsePayload(doc);
    const infos = [...docGraph.objects.values()].filter(o => o.className === 'Axure:MasterPackageInfo');
    const clonedInfo = infos.find(i => field(i.body, 'package-name')?.text === 'CLONED_MASTER');
    assert.ok(clonedInfo, 'CLONED_MASTER not registered in DesignDocument');

    // 2. placeMaster
    // Target page index 4 is the page record
    const targetPageRecord = readRecords(duplicated.file).find(r => r.className === 'Axure:Page');
    assert.ok(targetPageRecord, 'Target Page record not found');
    const placed = placeMaster(duplicated.file, { masterName: 'CLONED_MASTER', pageIndex: targetPageRecord.index, x: 180, y: 220 });
    assertThreeZero(placed.file, 'placeMaster');

    const placedPage = readRecords(placed.file).find(r => r.index === targetPageRecord.index);
    const placedGraph = parsePayload(placedPage);
    const rdo = [...placedGraph.objects.values()].find(o => o.className === 'Axure:DiagramObject:ReferenceDiagramObject' && field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'CLONED_MASTER');
    assert.ok(rdo, 'ReferenceDiagramObject for CLONED_MASTER not found on page');

    // 验证 ReferredMaster tag 0x10 pair
    const refMaster = field(rdo.body, 'ReferredMaster');
    assert.equal(refMaster.tag, 0x10);
    assert.equal(placedPage.strings[refMaster.values[0] - 1], 'Axure:Master');

    // 验证 MyStyle 坐标
    const styleObj = placedGraph.objects.get(field(rdo.body, 'MyStyle').value);
    assert.ok(styleObj, 'MyStyle object not found');
    const prop = field(styleObj.body, 'PropList').items[0];
    assert.equal(field(prop, 'DOAName').value, 3221225573);
    const val = field(prop, 'Value');
    assert.equal(field(val, 'X').value, 180);
    assert.equal(field(val, 'Y').value, 220);
  });

  check('name-widget 定位与只改目标语义断言', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'name-widget-check-'));
    try {
      const srcPath = join(tmpDir, 'source.rp');
      const outPath = join(tmpDir, 'renamed.rp');
      const fixtureBytes = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
      writeFileSync(srcPath, fixtureBytes);

      const recsBefore = readRecords(fixtureBytes);
      const pageBefore = recsBefore.find(r => r.className === 'Axure:Page');
      const graphBefore = parsePayload(pageBefore);

      const targetBefore = [...graphBefore.objects.values()].find(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'SET_BUTTON');
      const otherBefore = [...graphBefore.objects.values()].find(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'VALUE_PREVIEW');
      assert.ok(targetBefore && otherBefore);

      // 调用 scripts/name-widget.mjs CLI 改名
      const scriptPath = join(TEST_DIR, '..', 'scripts', 'name-widget.mjs');
      execFileSync(process.execPath, [scriptPath, srcPath, outPath, '0', String(targetBefore.id), 'SET_BUTTON_RENAMED']);

      const outBytes = readFileSync(outPath);
      assertThreeZero(outBytes, 'name-widget output');

      const recsAfter = readRecords(outBytes);
      const pageAfter = recsAfter.find(r => r.className === 'Axure:Page');
      const graphAfter = parsePayload(pageAfter);

      // 目标元件 ID 相同，名字已改
      const targetAfter = graphAfter.objects.get(targetBefore.id);
      assert.ok(targetAfter, 'target widget by id not found');
      assert.equal(field(field(targetAfter.body, 'name-block'), 'text').text, 'SET_BUTTON_RENAMED');

      // 目标元件其他属性保持不变：GUID、MyStyle 引用、InteractionMap 引用
      const getGuidIdx = o => {
        const pd = field(field(o.body, 'name-block'), 'property-dictionary');
        return pd?.entries?.find(([k]) => k.text === 'diagram-object-id')?.[1]?.value;
      };
      assert.equal(getGuidIdx(targetAfter), getGuidIdx(targetBefore), 'diagram-object-id should not change');
      assert.equal(field(targetAfter.body, 'MyStyle')?.value, field(targetBefore.body, 'MyStyle')?.value);
      assert.equal(field(targetAfter.body, 'InteractionMap')?.value, field(targetBefore.body, 'InteractionMap')?.value);

      // 其他元件保持未变
      const otherAfter = graphAfter.objects.get(otherBefore.id);
      assert.ok(otherAfter, 'other widget by id not found');
      assert.equal(field(field(otherAfter.body, 'name-block'), 'text').text, 'VALUE_PREVIEW');
      assert.equal(getGuidIdx(otherAfter), getGuidIdx(otherBefore), 'other widget diagram-object-id should not change');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  check('clone-library-widget 闭包复制与几何坐标断言', () => {
    const libPath = resolveLibrary('Default.rplib');
    const targetPath = fixturePath('blank-ui-native.rp');
    const tmpDir = mkdtempSync(join(tmpdir(), 'lib-clone-check-'));
    try {
      const outPath = join(tmpDir, 'out.rp');
      const res = cloneLibraryWidget(libPath, targetPath, outPath, {
        sourcePageName: 'Box 1',
        targetPageName: 'Page 1',
        name: 'CLONED_BOX_1',
        x: 210,
        y: 160,
      });

      assert.equal(res.name, 'CLONED_BOX_1');
      assert.equal(res.geometry.x, 210);
      assert.equal(res.geometry.y, 160);

      const bytes = readFileSync(outPath);
      assertThreeZero(bytes, 'clone-library-widget');

      const page = readRecords(bytes).find(r => r.className === 'Axure:Page');
      const graph = parsePayload(page);
      const cloned = [...graph.objects.values()].find(o => field(field(o.body, 'name-block') ?? {}, 'text')?.text === 'CLONED_BOX_1');
      assert.ok(cloned, 'CLONED_BOX_1 not found in target page');
      assert.equal(cloned.className, 'Axure:DiagramObject:VectorShape');

      // 从输出文件中实际读取并验证其 MyStyle 坐标与属性
      const myStyleId = field(cloned.body, 'MyStyle')?.value;
      assert.ok(myStyleId, 'MyStyle reference missing');
      const myStyleObj = graph.objects.get(myStyleId);
      assert.ok(myStyleObj, 'MyStyle object not found');
      const propList = field(myStyleObj.body, 'PropList')?.items ?? [];
      const locProp = propList.find(p => field(p, 'DOAName')?.value === 3221225573);
      assert.ok(locProp, 'Location DOA property not found');
      const locVal = field(locProp, 'Value');
      assert.equal(field(locVal, 'X')?.value, 210, 'cloned X !== 210 in output file');
      assert.equal(field(locVal, 'Y')?.value, 160, 'cloned Y !== 160 in output file');

      // 验证克隆后的 GUID 与原库中不同（不是空也不是未分配）
      const pd = field(field(cloned.body, 'name-block'), 'property-dictionary');
      const objIdVal = pd?.entries?.find(([k]) => k.text === 'diagram-object-id')?.[1]?.value;
      assert.ok(objIdVal, 'cloned widget must have diagram-object-id');
      const guidNode = graph.roots.find(n => n.tag === 0x1e);
      const clonedGuid = guidNode?.values?.[objIdVal - 1];
      assert.ok(clonedGuid && clonedGuid !== '00000000000000000000000000000000', 'cloned widget must have valid non-null guid');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  check('clone-library-page-content 导入计划、动态面板包闭包与独立状态 GUID 断言', () => {
    const libPath = resolveLibrary('Sample UI patterns.rplib');
    const targetPath = fixturePath('blank-ui-native.rp');
    const tmpDir = mkdtempSync(join(tmpdir(), 'lib-page-clone-check-'));
    try {
      const outPath1 = join(tmpDir, 'out1.rp');
      const res1 = cloneLibraryPageContent(libPath, targetPath, outPath1, {
        sourcePageName: 'Tabs',
        targetPageName: 'Page 1',
        x: 100,
        y: 80,
      });

      // 1. 断言导入计划 (Import Plan) 的完整性
      assert.ok(res1.plan, 'cloneLibraryPageContent must return an import plan');
      assert.equal(res1.plan.sourcePage, 'Tabs');
      assert.equal(res1.plan.targetPage, 'Page 1');
      assert.equal(res1.plan.ownedPackages.length, 3, 'Tabs must identify exactly 3 owned PanelState packages');
      assert.equal(res1.plan.offset.x, 100 - 20); // 最小 X 为 20
      assert.equal(res1.plan.offset.y, 80 - 20);  // 最小 Y 为 20

      // 2. 检查输出文件 1 的三零与语义闭环
      const bytes1 = readFileSync(outPath1);
      assertThreeZero(bytes1, 'clone-library-page-content Tabs run 1');
      const sem1 = validateSemantics(bytes1);
      assert.equal(sem1.valid, true, `Semantics validation failed: ${JSON.stringify(sem1.violations)}`);
      assert.equal(sem1.violationCount, 0);

      // 3. 验证目标文件包含新插入的 3 个 PanelState records
      const records1 = readRecords(bytes1);
      const states1 = records1.filter(r => r.className === 'Axure:PanelState');
      assert.equal(states1.length, 3, 'Target file must contain exactly 3 PanelState records');

      // 4. 验证 DynamicPanel 的 panel-diagrams 精准指向这 3 个 PanelState
      const page1 = records1.find(r => r.className === 'Axure:Page');
      const graph1 = parsePayload(page1);
      const guids1 = graph1.roots.find(n => n.tag === 0x1e).values;
      const panel1 = [...graph1.objects.values()].find(o => o.className === 'Axure:DiagramObject:DynamicPanel');
      assert.ok(panel1, 'DynamicPanel not found on cloned page');
      const panelDiagrams = field(panel1.body, 'panel-diagrams')?.items ?? [];
      assert.equal(panelDiagrams.length, 3, 'DynamicPanel must contain 3 state diagrams');
      const stateGuids1 = panelDiagrams.map(p => guids1[p.values[1] - 1]);
      for (const sg of stateGuids1) {
        assert.ok(sg && sg !== '0'.repeat(32), 'State GUID must not be null');
        const match = states1.find(r => {
          const g = parsePayload(r);
          const pGuids = g.roots.find(n => n.tag === 0x1e).values;
          const pIdx = g.roots.find(n => n.tag === 0x12).value;
          return pGuids[pIdx - 1] === sg;
        });
        assert.ok(match, `PanelState record for GUID ${sg} must exist in target file`);
      }

      // 5. 进行第二次独立克隆，断言私有 GUID 完全隔离（不复用）
      const outPath2 = join(tmpDir, 'out2.rp');
      const res2 = cloneLibraryPageContent(libPath, targetPath, outPath2, {
        sourcePageName: 'Tabs',
        targetPageName: 'Page 1',
        x: 100,
        y: 80,
      });
      const bytes2 = readFileSync(outPath2);
      const records2 = readRecords(bytes2);
      const states2 = records2.filter(r => r.className === 'Axure:PanelState');
      const packageGuid = g => g.roots.find(n => n.tag === 0x1e).values[g.roots.find(n => n.tag === 0x12).value - 1];
      const set1 = new Set(states1.map(r => packageGuid(parsePayload(r))));
      const set2 = new Set(states2.map(r => packageGuid(parsePayload(r))));
      for (const g of set2) {
        assert.ok(!set1.has(g), `Cloned run 2 must allocate distinct private GUIDs; collision on ${g}`);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  return results;
}

if (process.argv[1] && process.argv[1].endsWith('writer-semantics-check.mjs')) {
  const results = runWriterSemanticsChecks();
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    process.exit(1);
  }
}
