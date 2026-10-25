import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNotProtected, assertWritable } from './engine.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

// Serialized into the real browser. Only reads Axure state and installs bounded
// passive listeners; never evaluates source expressions or writes test values.
export function observeAxure({ names = [], variables = [] } = {}) {
  const windows = [window];
  for (let i = 0; i < windows.length && i < 20; i++) {
    const w = windows[i];
    try {
      if (w.$axure?.internal) {
        const ax = w.$axure.internal(api => api);
        if (ax.pageData?.page && ax.globalVariableProvider) {
          const d = w.document;
          if (!w.__zeeRpPreviewProbe) {
            const probe = w.__zeeRpPreviewProbe = { events: [], errors: [] };
            const add = (list, value) => { list.push(value); if (list.length > 50) list.shift(); };
            d.addEventListener('click', e => add(probe.events, { event: 'click', name: e.target.closest?.('[data-label]')?.getAttribute('data-label') ?? null, at: Date.now() }), true);
            d.addEventListener('change', e => add(probe.events, { event: 'change', name: e.target.closest?.('[data-label]')?.getAttribute('data-label') ?? null, at: Date.now() }), true);
            w.addEventListener('error', e => add(probe.errors, { message: e.message, source: e.filename, line: e.lineno }));
            w.addEventListener('unhandledrejection', e => add(probe.errors, { message: String(e.reason) }));
          }
          const widgets = [...d.querySelectorAll('[data-label]')].filter(el => names.includes(el.getAttribute('data-label'))).map(el => {
            const r = el.getBoundingClientRect(), input = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select');
            let visible = r.width > 0 && r.height > 0;
            for (let cur = el; cur; cur = cur.parentElement) {
              const cs = w.getComputedStyle(cur);
              if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') visible = false;
            }
            const state = [...el.children].find(c => c.classList.contains('panel_state') && w.getComputedStyle(c).display !== 'none' && w.getComputedStyle(c).visibility !== 'hidden');
            return { id: el.id, name: el.getAttribute('data-label'), text: input ? input.value : el.innerText?.trim() ?? '', visible,
              enabled: !input?.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('disabled'),
              inputId: input?.id ?? null, panelState: state?.getAttribute('data-label') ?? null,
              width: r.width, height: r.height };
          });
          const values = {};
          const defined = ax.globalVariableProvider.getDefinedVariables();
          for (const name of variables) if (defined.some(key => key.toLowerCase() === name.toLowerCase()))
            values[name] = ax.globalVariableProvider.getVariableValue(name);
          return { ready: true, page: ax.pageData.page.name, url: w.location.href, widgets, variables: values,
            events: [...w.__zeeRpPreviewProbe.events], errors: [...w.__zeeRpPreviewProbe.errors] };
        }
      }
      for (let n = 0; n < w.frames.length; n++) { try { if (w.frames[n].document) windows.push(w.frames[n]); } catch {} }
    } catch {}
  }
  return { ready: false, reason: '当前页面尚未加载可读取的 Axure 原生运行时。' };
}

export function resolvePreviewSymbol(map, target) {
  const found = map.symbols.filter(s => [s.id, s.name, s.display, s.pointer].includes(target) || s.id.endsWith('/' + target));
  if (found.length !== 1) throw Object.assign(new Error('目标缺失或重名，请使用 page/id。'),
    { code: 'E_PREVIEW_TARGET', candidates: found.map(s => s.id) });
  return found[0];
}

export function clickObservedAxure({ url, id }) {
  const windows = [window];
  for (let i = 0; i < windows.length && i < 20; i++) {
    const w = windows[i];
    try {
      if (w.location.href === url) {
        const el = w.document.getElementById(id);
        if (el && w.getComputedStyle(el).display !== 'none') { el.click(); return true; }
      }
      for (let n = 0; n < w.frames.length; n++) { try { if (w.frames[n].document) windows.push(w.frames[n]); } catch {} }
    } catch {}
  }
  return false;
}

export function previewMismatch(step, observation, widget, map) {
  const expected = step.expect ?? {}, failures = [];
  if ('page' in expected) {
    const page = map.pages.find(p => p.id === expected.page);
    if (observation.page !== (page?.name ?? expected.page)) failures.push({ field: 'page', expected: page?.name ?? expected.page, actual: observation.page });
  }
  if ('variable' in expected && (!Object.hasOwn(observation.variables, expected.variable) || String(observation.variables[expected.variable]) !== String(expected.equals)))
    failures.push({ field: 'variable:' + expected.variable, expected: expected.equals, actual: observation.variables[expected.variable] ?? null });
  for (const field of ['text', 'visible', 'panelState']) if (field in expected && widget?.[field] !== expected[field])
    failures.push({ field, expected: expected[field], actual: widget?.[field] ?? null });
  for (const field of ['width', 'height']) if (field in expected && (typeof widget?.[field] !== 'number' || Math.abs(widget[field] - expected[field]) > .5))
    failures.push({ field, expected: expected[field], actual: widget?.[field] ?? null });
  return failures;
}

// Called by ego-browser nodejs in an existing, agent-owned TaskSpace. Browser
// ownership and user-control checks remain enforced by ego, with no takeover.
export async function runEgoPreview(input) {
  const task = await taskSpace(input.spaceId);
  const page = task.page(input.pageLabel ?? 'p1');
  const { map, steps } = input;
  const names = [...new Set(map.symbols.flatMap(s => [s.name, s.display]).filter(Boolean))];
  const variables = [...new Set([...map.variables, ...steps.flatMap(s => s.expect?.variable ? [s.expect.variable] : [])])];
  const observe = () => page.evaluate(observeAxure, { names, variables });
  const timeout = input.timeoutMs ?? 5000;
  const history = [];
  const result = { status: 'completed', evidence: 'axure-browser-runtime', semanticHash: map.semanticHash,
    verification: { nativePreviewObserved: false, businessAssertionsPassed: false, guiEdited: false, saveReopened: false },
    artifactAssociation: 'logical-labels-and-page-names', steps: history };
  try {
    if (input.url) await page.goto(input.url);
    const ready = new Function('args', `return (${observeAxure.toString()})(args).ready;`);
    await page.waitForFunction(ready, { names, variables }, { timeout });
    let before = await observe();
    if (!before.ready) throw Object.assign(new Error(before.reason), { code: 'E_PREVIEW_RUNTIME' });
    result.verification.nativePreviewObserved = true;
    result.initial = before;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], symbol = step.target ? resolvePreviewSymbol(map, step.target) : null;
      let current = await observe();
      let candidates = symbol ? current.widgets.filter(w => [symbol.name, symbol.display].includes(w.name) && w.visible) : [];
      if (symbol && step.expect?.visible === false) candidates = current.widgets.filter(w => [symbol.name, symbol.display].includes(w.name));
      let widget = candidates[step.rowIndex ?? 0];
      const entry = { index: i, action: step.action, target: symbol?.id ?? null, before: current, status: 'running' };
      history.push(entry);
      if (symbol && step.rowIndex === undefined && candidates.length > 1)
        throw Object.assign(new Error('真实预览中有多个实例，请指定 rowIndex。'), { code: 'E_PREVIEW_AMBIGUOUS', stepIndex: i });
      if (symbol && !widget && step.expect?.visible !== false)
        throw Object.assign(new Error('当前页未找到可见目标。'), { code: 'E_PREVIEW_NOT_VISIBLE', stepIndex: i });
      if (step.action !== 'expect') {
        if (!widget?.enabled) throw Object.assign(new Error('目标不可操作。'), { code: 'E_PREVIEW_DISABLED', stepIndex: i });
        // The ID was read from the current DOM immediately above.
        const id = step.action === 'fill' ? widget.inputId : widget.id;
        if (!id) throw Object.assign(new Error('目标不是输入框。'), { code: 'E_PREVIEW_INPUT', stepIndex: i });
        const selector = 'loc=css:#' + id.replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
        if (step.action === 'fill') { await page.focus(selector); await page.fill(selector, step.value); await page.press(selector, 'Tab'); }
        else {
          try { await page.click(selector, { label: '验证原型交互' }); entry.dispatch = 'ego-pointer'; }
          catch (error) {
            const checked = await observe();
            const same = checked.widgets?.find(w => w.id === id && w.visible && w.enabled);
            if (!/not visible in the viewport/.test(error.message) || !same || checked.url !== current.url) throw error;
            if (!await page.evaluate(clickObservedAxure, { url: checked.url, id })) throw error;
            entry.dispatch = 'dom-click-after-viewport-check';
            entry.browserWarning = error.message;
          }
        }
      }
      const deadline = Date.now() + timeout;
      let failures;
      do {
        current = await observe();
        candidates = symbol && current.ready ? current.widgets.filter(w => [symbol.name, symbol.display].includes(w.name) && (step.expect?.visible === false || w.visible)) : [];
        widget = candidates[step.rowIndex ?? 0];
        failures = current.ready ? previewMismatch(step, current, widget, map) : [{ field: 'runtime', expected: 'ready', actual: false }];
        if (!failures.length) break;
        await new Promise(r => setTimeout(r, 100));
      } while (Date.now() < deadline);
      entry.after = current;
      entry.variableChanges = Object.fromEntries(Object.entries(current.variables ?? {}).filter(([key, value]) => String(before.variables?.[key]) !== String(value)));
      entry.failures = failures;
      entry.status = failures.length ? 'failed' : 'passed';
      before = current;
      if (failures.length) throw Object.assign(new Error('真实预览与期望不一致。'), { code: 'E_PREVIEW_ASSERTION', stepIndex: i });
      if (current.errors?.length) throw Object.assign(new Error('原生预览捕获到运行错误。'), { code: 'E_PREVIEW_RUNTIME_ERROR', stepIndex: i });
    }
    result.verification.businessAssertionsPassed = steps.some(s => Object.keys(s.expect ?? {}).length > 0);
  } catch (error) {
    result.status = 'failed';
    const index = error.stepIndex ?? history.at(-1)?.index;
    const step = steps[index], symbol = step?.target ? map.symbols.find(s => s.id === step.target || s.id.endsWith('/' + step.target)) : null;
    if (history.at(-1)?.status === 'running') history.at(-1).status = 'failed';
    const observed = history.at(-1)?.after ?? history.at(-1)?.before;
    result.diagnostics = [{ code: error.code ?? 'E_PREVIEW_BROWSER', message: error.message, stepIndex: index ?? null,
      target: symbol?.id ?? step?.target ?? null, ...symbol?.context,
      actual: observed ? { page: observed.page, variables: observed.variables,
        widgets: observed.widgets?.filter(w => symbol && [symbol.name, symbol.display].includes(w.name)),
        events: observed.events?.slice(-5), errors: observed.errors } : null,
      expected: step?.expect ?? null,
      nextAction: '对照实际变量变化、可见状态和源码事件；未触发的绑定可用 explain_binding 查看编译刷新关系。' }];
  }
  try { result.screenshot = await page.screenshot({ path: input.screenshot }); }
  catch (error) { result.screenshotError = error.message; }
  writeFileSync(input.output, JSON.stringify(result, null, 2) + '\n');
  console.log('ZEE_RP_PREVIEW_RESULT ' + JSON.stringify(result));
}

export async function previewPrototype(input, runWorkflow) {
  const source = resolve(input.source);
  assertNotProtected(source);
  const output = resolve(input.output);
  assertWritable(output);
  if (extname(output) !== '.json' || existsSync(output) || existsSync(output + '.png'))
    throw new Error('output 需要新的 .json 文件名，报告和截图均不覆盖已有文件。');
  if (input.url) {
    const url = new URL(input.url);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('url 需要真实 Axure 预览或已发布 HTML 地址。');
  }
  const sourceHash = sha(readFileSync(source));
  const map = runWorkflow('preview-map', source);
  if (!map.ok) return { status: 'failed', ...map };
  for (const step of input.steps) {
    if (step.target) resolvePreviewSymbol(map, step.target);
    if (step.action !== 'expect' && !step.target) throw new Error('click/fill 需要 target 逻辑 ID。');
    if (step.action === 'fill' && typeof step.value !== 'string') throw new Error('fill 需要 value 文本。');
    if (step.action === 'expect' && !Object.keys(step.expect ?? {}).length) throw new Error('expect 至少需要一个期望字段。');
    if (step.expect?.variable && !Object.hasOwn(step.expect, 'equals')) throw new Error('变量断言需要 equals。');
    if (['text', 'visible', 'panelState', 'width', 'height'].some(k => Object.hasOwn(step.expect ?? {}, k)) && !step.target) throw new Error('元件断言需要 target。');
  }
  mkdirSync(dirname(output), { recursive: true });
  // Reserve the report so a concurrent caller cannot overwrite this run.
  writeFileSync(output, JSON.stringify({ status: 'running', source, sourceHash }) + '\n', { flag: 'wx' });
  const payload = { ...input, source, output, screenshot: output + '.png', map };
  const code = `const {runEgoPreview}=await import(${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}); await runEgoPreview(${JSON.stringify(payload)});`;
  const execution = await new Promise(resolveExecution => {
    const child = spawn('ego-browser', ['nodejs', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.once('error', e => resolveExecution({ code: 1, stdout, stderr: e.message }));
    child.once('close', code => resolveExecution({ code, stdout, stderr }));
  });
  let result;
  try { result = JSON.parse(readFileSync(output)); } catch {}
  if (!result || result.status === 'running') result = { status: 'failed', diagnostics: [{ code: 'E_PREVIEW_BROWSER',
    message: execution.stderr || execution.stdout || '浏览器未返回完整记录。', nextAction: '检查现有 ego 任务空间及控制权；不自动接管用户空间。' }] };
  result.source = source; result.sourceHash = sourceHash; result.report = output;
  result.sourceChangedDuringRun = sha(readFileSync(source)) !== sourceHash;
  if (result.sourceChangedDuringRun) { result.status = 'failed'; result.diagnostics = [...(result.diagnostics ?? []), { code: 'E_STALE_PREVIEW_SOURCE', message: '预览期间源码已变化，请使用一致版本重测。' }]; }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return { status: result.status, evidence: result.evidence, verification: result.verification,
    passed: result.steps?.filter(s => s.status === 'passed').length ?? 0, total: input.steps.length,
    report: output, screenshot: result.screenshot, diagnostics: result.diagnostics,
    final: (() => { const last = result.steps?.at(-1)?.after ?? result.initial; return last ? {
      page: last.page, url: last.url, variables: last.variables, errors: last.errors,
    } : undefined; })(),
    artifactAssociation: result.artifactAssociation, sourceChangedDuringRun: result.sourceChangedDuringRun };
}
