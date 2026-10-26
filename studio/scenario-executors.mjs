import { observeAxure } from '../scripts/preview-runtime.mjs';

async function pointerTarget(page, selector, action, value) {
  const target = await page.evaluate(`(() => {
    const docs = [document];
    let el;
    for (let i=0;i<docs.length && i<20;i++) {
      el = docs[i].querySelector(${JSON.stringify(selector)});
      if (el) break;
      for (const frame of docs[i].querySelectorAll('iframe')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
    }
    if (!el) throw new Error('未找到可见操作目标');
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
    const point = rect.width && rect.height && points.map(([a,b]) => [rect.left+rect.width*a,rect.top+rect.height*b]).find(([x,y])=>{
      const hit=el.ownerDocument.elementFromPoint(x,y); return hit && (hitContainer===hit || hitContainer.contains(hit));
    });
    if (!point) throw new Error('目标不可见或被遮挡');
    let [x,y] = point;
    let win = el.ownerDocument.defaultView;
    while(win.frameElement) { const frameRect=win.frameElement.getBoundingClientRect(); x+=frameRect.left; y+=frameRect.top; win=win.parent; }
    return {x,y};
  })()`);
  await page.mouseClick(target.x, target.y);
  if (action === 'input' || action === 'fill') {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await page.send('Input.insertText', { text: String(value ?? '') });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
  }
}

// Reads only the real renderer/runtime. Expected values are never injected.
export async function runInteractionSteps(page, doc, steps, { layer, url = null, startPageId = null } = {}) {
  if (!Array.isArray(steps) || !steps.length) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ACTIONS_REQUIRED', reason: '场景尚未提供可重放的用户操作，不能将静态渲染或结构检查记为通过' };
  for (const step of steps) {
    const unsupported = Object.keys(step.expect || {}).filter(key => !['page', 'variables', 'text'].includes(key));
    if (unsupported.length) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ASSERTION_UNSUPPORTED', fields: unsupported };
    if (step.action && !['click', 'input', 'fill', 'expect'].includes(step.action)) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ACTION_UNSUPPORTED', action: step.action };
  }
  const assertionCount = steps.reduce((count, step) => count + (step.expect?.page !== undefined ? 1 : 0)
    + Object.keys(step.expect?.variables || {}).length + Object.keys(step.expect?.text || {}).length, 0);
  if (!assertionCount) return { passed: false, status: 'unsupported', code: 'E_SCENARIO_ASSERTIONS_REQUIRED', reason: '场景需要至少一项页面、变量或可见文字断言' };
  const native = layer === 'axure-preview';
  if (native && !url) return { passed: false, status: 'blocked', code: 'E_AXURE_PREVIEW_REQUIRED', reason: '需要由目标 .rp 在 Axure 生成的真实预览地址' };
  const history = [];
  const names = new Set();
  for (const step of steps) {
    if (step.target || step.click || step.fill) names.add(String(step.target || step.click || step.fill).split('/').at(-1));
    for (const key of Object.keys(step.expect?.text || {})) names.add(key.split('/').at(-1));
  }
  const read = async () => {
    if (!native) return page.evaluate(`(() => {
      const state = window.__STUDIO_APP__.state;
      const rt = state.runtimeState;
      const widgets = [...document.querySelectorAll('#screen-root .studio-node')].map(el => ({
        name: el.dataset.nodeId, text: el.matches('input,textarea') ? el.value : el.innerText,
        visible: el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden'
      }));
      return { ready: Boolean(rt), page: rt?.currentPageId, variables: rt?.variables, widgets };
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
      if (label === name || new RegExp(`^(?:bg-)?(?:grp|txt|btn|input|shape|badge)-${escaped}-[a-f0-9]{12}$`).test(label)) mapping.set(label, name);
    }
    const observed = await page.evaluate(`(${observeAxure.toString()})(${JSON.stringify({ names: [...mapping.keys()], variables: Object.keys(doc.variables || {}) })})`);
    const matched = doc.pages.find(p => p.name === observed.page || p.id === observed.page);
    return { ...observed, widgets: (observed.widgets || []).map(w => ({ ...w, nativeName: w.name, name: mapping.get(w.name) || w.name })), page: matched?.id ?? observed.page };
  };
  try {
    if (native) {
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
      const target = step.target || step.click || step.fill;
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
          const id = String(target).split('/').at(-1);
          selector = `#screen-root [data-node-id=${JSON.stringify(id)}]`;
        }
        await pointerTarget(page, selector, action, step.value);
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
        for (const [name, value] of Object.entries(step.expect?.text || {})) {
          const widget = actual.widgets?.find(w => w.name === name.split('/').at(-1) && w.visible);
          const substring = value !== null && typeof value === 'object' && typeof value.includes === 'string';
          if (!widget || !(substring ? widget.text.includes(value.includes) : widget.text.trim() === String(value))) failures.push(`text:${name}`);
        }
        if (failures.length) await new Promise(r => setTimeout(r, 40));
      } while (failures.length && Date.now() < deadline);
      history.push({ action, target, expected: step.expect, actual, failures, passed: failures.length === 0 });
      if (failures.length) break;
    }
    const assertions = history.filter(step => step.expected && Object.keys(step.expected).length);
    return { passed: history.length === steps.length && assertions.length > 0 && history.every(s => s.passed), status: 'executed', layer, assertionCount, history };
  } catch (error) {
    return { passed: false, status: 'failed', layer, code: error.code || 'E_SCENARIO_INTERACTION', message: error.message, history };
  }
}
