import { SCENARIO_STEP_SCHEMA } from './runtime.mjs';
import { observeAxure } from '../scripts/preview-runtime.mjs';

export const BROWSER_SCENARIO_STEP_SCHEMA = {
  ...SCENARIO_STEP_SCHEMA,
  properties: Object.fromEntries(['action', 'target', 'id', 'fill', 'click', 'value', 'text', 'expect'].map(key => [key,
    key === 'action' ? { type: 'string', enum: ['click', 'input', 'expect'] } :
    key === 'expect' ? SCENARIO_STEP_SCHEMA.properties.expect : SCENARIO_STEP_SCHEMA.properties[key]])),
};

// 单次真实指针命中判定：滚动到可见后取 6 个采样点做 elementFromPoint。
// 返回 {ok:true, point, sampledPoints} 或 {ok:false, reason:'not-found'|'occluded', occludedBy:{nodeId, scopedId, tagName}, sampledPoints}。
// occludedBy 指向第一个拦截采样点的 .studio-node（nodeId/scopedId），非 Studio 画布元素（如原生预览标签）仅给 tagName。
export async function resolvePointerHit(page, selector) {
  const info = await page.evaluate(`(() => {
    const docs = [document];
    let el;
    for (let i=0;i<docs.length && i<20;i++) {
      el = docs[i].querySelector(${JSON.stringify(selector)});
      if (el) break;
      for (const frame of docs[i].querySelectorAll('iframe')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
    }
    if (!el) return { found: false, reason: 'not-found' };
    el.scrollIntoView({block:'center', inline:'center'});
    let rect = el.getBoundingClientRect();
    if ((!rect.width || !rect.height) && el.getAttribute('data-label')?.startsWith('grp-')) {
      const child = [...el.querySelectorAll('[data-label]')].find(child => {
        const r = child.getBoundingClientRect(), cs = child.ownerDocument.defaultView.getComputedStyle(child);
        return r.width && r.height && cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      if (child) { child.scrollIntoView({block:'center', inline:'center'}); rect = child.getBoundingClientRect(); }
    }
    const hitContainer = el.getAttribute('data-label')?.startsWith('bg-grp-') ? el.parentElement : el;
    const points = [[.5,.5],[.25,.5],[.75,.5],[.5,.8],[.25,.8],[.75,.8]];
    const samples = rect.width && rect.height ? points.map(([a,b]) => [rect.left+rect.width*a,rect.top+rect.height*b]) : [];
    let point = null, occludedBy = null;
    for (const [x,y] of samples) {
      const hit = el.ownerDocument.elementFromPoint(x,y);
      if (hit && (hitContainer===hit || hitContainer.contains(hit))) { point = [x,y]; break; }
      if (!occludedBy && hit) {
        const nodeEl = hit.closest('.studio-node');
        occludedBy = {
          nodeId: nodeEl?.dataset?.nodeId ?? null,
          scopedId: nodeEl?.dataset?.scopedId ?? null,
          tagName: (hit.tagName || '').toLowerCase() || null,
        };
      }
    }
    const sampledPoints = samples.map(([x,y]) => ({x: Math.round(x), y: Math.round(y)}));
    if (!point) return { found: true, reason: 'occluded', occludedBy, sampledPoints };
    let [x,y] = point;
    let win = el.ownerDocument.defaultView;
    while(win.frameElement) { const frameRect=win.frameElement.getBoundingClientRect(); x+=frameRect.left; y+=frameRect.top; win=win.parent; }
    return { found: true, reason: null, occludedBy: null, sampledPoints, point: {x,y} };
      })()`);
  const found = Boolean(info?.found);
  const occluded = found && info.reason === 'occluded';
  return { ok: found && !occluded, ...(info || {}) };
}

// 语义步骤目标 → 浏览器层 CSS 选择器（data-node-id 或作用域 data-scoped-id）。
export async function resolveBrowserStepSelector(page, target) {
  const id = String(target);
  const resolved = id.includes('/') ? await page.evaluate(`(() => { const rt=window.__STUDIO_APP__.state.runtimeState;const id=${JSON.stringify(id)};return (rt.activePageScene?.nodes || []).find(n=>n.scopedId===id || n.scopedId===rt.currentPageId+'/'+id)?.scopedId; })()`) : null;
  if (id.includes('/') && !resolved) throw new Error(`未找到指定作用域目标: ${id}`);
  return resolved ? `#screen-root [data-scoped-id=${JSON.stringify(resolved)}]` : `#screen-root [data-node-id=${JSON.stringify(id)}]`;
}

async function pointerTarget(page, selector, action, value) {
  let target, lastError;
  const deadline = Date.now() + 5000;
  do {
    try {
      target = await resolvePointerHit(page, selector);
      if (target.ok) break;
      lastError = Object.assign(new Error(target.reason === 'not-found' ? '未找到可见操作目标' : '目标不可见或被遮挡'), { hit: target });
      target = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  if (!target) throw lastError;
  await page.mouseClick(target.point.x, target.point.y);
  if (action === 'input' || action === 'fill') {
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2,
      commands: ['selectAll'],
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    const textVal = String(value ?? '');
    if (textVal.length > 0) {
      await page.send('Input.insertText', { text: textVal });
    } else {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
  }
}

// Counts only assertions that the executor actually evaluates; shared with the
// exploration entry so zero-assertion states are rejected before rendering.
export function countScenarioAssertions(steps = []) {
  return steps.reduce((count, step) => count + (step.expect?.page !== undefined ? 1 : 0)
    + Object.keys(step.expect?.variables || {}).length + Object.keys(step.expect?.text || {}).length + Object.keys(step.expect?.visible || {}).length
    + Object.keys(step.expect?.panelState || {}).length + Object.keys(step.expect?.datasetCount || {}).length + Object.keys(step.expect?.datasetFirstRow || {}).length, 0);
}

// Reads only the real renderer/runtime. Expected values are never injected.
export async function runInteractionSteps(page, doc, steps, { layer, url = null, startPageId = null } = {}) {
  if (!Array.isArray(steps) || !steps.length) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ACTIONS_REQUIRED', reason: '场景尚未提供可重放的用户操作，不能将静态渲染或结构检查记为通过' };
  const native = layer === 'axure-preview';
  for (const step of steps) {
    const unknown = Object.keys(step).filter(key => !Object.hasOwn(BROWSER_SCENARIO_STEP_SCHEMA.properties, key));
    if (unknown.length) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_STEP', fields: unknown, reason: `步骤包含未知字段 ${unknown.join(', ')}；可用字段：${Object.keys(BROWSER_SCENARIO_STEP_SCHEMA.properties).join(', ')}` };
    const unsupported = Object.keys(step.expect || {}).filter(key => !(native ? ['page', 'variables', 'text', 'visible'] : Object.keys(SCENARIO_STEP_SCHEMA.properties.expect.properties)).includes(key));
    if (unsupported.length) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ASSERTION_UNSUPPORTED', fields: unsupported };
    if (step.type !== undefined) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_STEP', reason: '步骤使用 action/expect，不能用 type' };
    if (step.action && !['click', 'input', 'fill', 'expect'].includes(step.action)) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ACTION_UNSUPPORTED', action: step.action, reason: `步骤动作 ${step.action} 不受支持；可用动作：click、input、fill、expect` };
  }
  const assertionCount = countScenarioAssertions(steps);
  if (!assertionCount) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ASSERTIONS_REQUIRED', reason: '场景需要至少一项页面、变量或可见文字断言' };
  if (native && !url) return { passed: false, status: 'blocked', code: 'E_AXURE_PREVIEW_REQUIRED', reason: '需要由目标 .rp 在 Axure 生成的真实预览地址' };
  const history = [];
  const names = new Set();
  for (const step of steps) {
    if (step.target || step.id || step.click || step.fill) names.add(String(step.target || step.id || step.click || step.fill).split('/').at(-1));
    for (const key of [...Object.keys(step.expect?.text || {}), ...Object.keys(step.expect?.visible || {})]) names.add(key.split('/').at(-1));
  }
  const read = async () => {
    if (!native) return page.evaluate(`(() => {
      const state = window.__STUDIO_APP__.state;
      const rt = state.runtimeState;
      const widgets = [...document.querySelectorAll('#screen-root .studio-node')].map(el => ({
        name: el.dataset.nodeId, scopedId: el.dataset.scopedId, text: el.matches('input,textarea') ? el.value : el.innerText,
        visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden'
      }));
      return { ready: Boolean(rt), page: rt?.currentPageId, variables: rt?.variables, panelStates: rt?.panelStates, datasets: rt?.datasets, nodes: rt?.activePageScene?.nodes, widgets };
    })()`);
    const labels = await page.evaluate(`(() => {
      const windows=[window], labels=[];
      for(let i=0;i<windows.length && i<20;i++) { try {
        labels.push(...[...windows[i].document.querySelectorAll('[data-label]')].map(el=>el.getAttribute('data-label')));
        for(let j=0;j<windows[i].frames.length;j++) windows.push(windows[i].frames[j]);
      } catch {} }
      return labels;
    })()`);
    const mapping = new Map();
    for (const label of labels) for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (label === name || new RegExp(`^(?:bg-)?(?:grp|txt|btn|inp|input|shape|badge)-${escaped}-[a-f0-9]{12}$`).test(label)) mapping.set(label, name);
    }
    const observed = await page.evaluate(`(${observeAxure.toString()})(${JSON.stringify({ names: [...mapping.keys()], variables: Object.keys(doc.variables || {}) })})`);
    const matched = doc.pages.find(p => p.name === observed.page || p.id === observed.page);
    const widgets = (observed.widgets || []).map(w => ({ ...w, nativeName: w.name, name: mapping.get(w.name) || w.name }));
    return { ...observed, widgets: widgets.filter(w => !w.nativeName.startsWith('bg-') || !widgets.some(other => other.name === w.name && !other.nativeName.startsWith('bg-'))), page: matched?.id ?? observed.page };
  };
  try {
    if (native) {
      // An already loaded start.html can still expose the preceding scenario's
      // iframe while navigation is pending. Clear it before testing readiness.
      await page.navigate('about:blank');
      await page.navigate(url);
      await page.waitForFunction(`(${observeAxure.toString()})(${JSON.stringify({ names: [...names], variables: Object.keys(doc.variables || {}) })}).ready`);
    } else {
      await page.navigate(`${new URL(await page.evaluate('location.href')).origin}/?clientId=scenario_executor`);
      await page.waitForFunction('Boolean(window.__STUDIO_APP__ && window.__STUDIO_RENDERED_REVISION__)');
      if (startPageId) await page.evaluate(`window.__STUDIO_APP__.selectNodes([], ${JSON.stringify(startPageId)})`);
      await pointerTarget(page, '#mode-interact-btn', 'click');
      await page.waitForFunction('Boolean(window.__STUDIO_APP__.state.runtimeState)');
    }
    for (const step of steps) {
      const action = step.action || (step.click ? 'click' : step.fill ? 'input' : 'expect');
      const target = step.target || step.id || step.click || step.fill;
      if (action !== 'expect') {
        let selector;
        if (native) {
          const name = String(target).split('/').at(-1);
          let matches = [];
          const readyDeadline = Date.now() + 5000;
          do {
            const observed = await read();
            matches = observed.widgets.filter(w => w.name === name && w.visible);
            if (matches.some(w => !w.nativeName.startsWith('bg-'))) matches = matches.filter(w => !w.nativeName.startsWith('bg-'));
            if (!matches.length) await new Promise(r => setTimeout(r, 40));
          } while (!matches.length && Date.now() < readyDeadline);
          if (matches.length !== 1) throw new Error(`原生目标缺失或重名: ${target}`);
          selector = `#${action === 'input' || action === 'fill' ? matches[0].inputId : matches[0].id}`;
        } else {
          selector = await resolveBrowserStepSelector(page, target);
        }
        const previousTrace = native ? null : await page.evaluate('window.__STUDIO_APP__.state.runtimeState.traceCount');
        await pointerTarget(page, selector, action, step.value ?? step.text);
        if (!native) await page.waitForFunction(`window.__STUDIO_APP__.state.runtimeState.traceCount > ${previousTrace}`);
      }
      let actual;
      let failures;
      const deadline = Date.now() + 4000;
      do {
        actual = await read();
        failures = [];
        if (!actual.ready) failures.push('runtime-not-ready');
        if (step.expect?.page !== undefined && actual.page !== step.expect.page) failures.push('page');
        for (const [name, value] of Object.entries(step.expect?.variables || {})) if (String(actual.variables?.[name]) !== String(value)) failures.push(`variable:${name}`);
        for (const [name, value] of Object.entries(step.expect?.visible || {})) {
          const matches = w => !native && name.includes('/') ? w.scopedId === name || w.scopedId === `${actual.page}/${name}` : w.name === name.split('/').at(-1);
          const visible = actual.widgets?.some(w => matches(w) && w.visible) || false;
          if (typeof value !== 'boolean' || visible !== value) failures.push(`visible:${name}`);
        }
        for (const [name, value] of Object.entries(step.expect?.text || {})) {
          const widget = actual.widgets?.find(w => (!native && name.includes('/') ? w.scopedId === name || w.scopedId === `${actual.page}/${name}` : w.name === name.split('/').at(-1)) && w.visible);
          const substring = value !== null && typeof value === 'object' && typeof value.includes === 'string';
          if (!widget || !(substring ? widget.text.includes(value.includes) : widget.text.trim() === String(value))) failures.push(`text:${name}`);
        }
        if (!native) {
          for (const [name, value] of Object.entries(step.expect?.panelState || {})) {
            const candidates = (actual.nodes || []).filter(n => n.type === 'dynamic-panel' && (name.includes('/') ? n.scopedId === name || n.scopedId === `${actual.page}/${name}` : n.id === name));
            if (candidates.length !== 1 || actual.panelStates?.[candidates[0].scopedId] !== value) failures.push(`panelState:${name}`);
          }
          for (const [name, value] of Object.entries(step.expect?.datasetCount || {})) if (actual.datasets?.[name]?.visibleRows?.length !== value) failures.push(`datasetCount:${name}`);
          for (const [name, fields] of Object.entries(step.expect?.datasetFirstRow || {})) {
            const row = actual.datasets?.[name]?.visibleRows?.[0];
            if (!row || Object.entries(fields).some(([key, value]) => String(row[key]) !== String(value))) failures.push(`datasetFirstRow:${name}`);
          }
        }
        if (failures.length) await new Promise(r => setTimeout(r, 40));
      } while (failures.length && Date.now() < deadline);
      history.push({ action, target, expected: step.expect, actual, failures, passed: failures.length === 0 });
      if (failures.length) break;
    }
    const assertions = history.filter(step => step.expected && Object.keys(step.expected).length);
    return { passed: history.length === steps.length && assertions.length > 0 && history.every(s => s.passed), status: 'executed', layer, assertionCount, history };
  } catch (error) {
    return { passed: false, status: 'failed', layer, code: error.code || 'E_SCENARIO_INTERACTION', message: error.message, ...(error.hit ? { hitDetail: error.hit } : {}), history };
  }
}
