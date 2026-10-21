// Called only inside ego-browser nodejs with its documented Page API.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
export function difference(expected, actual, path = '') {
  if (typeof expected === 'number' && typeof actual === 'number' && Math.abs(expected - actual) < 1e-8) return null;
  if (expected === actual) return null;
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    if (Array.isArray(expected) !== Array.isArray(actual)) return { path, expected, actual };
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const diff = difference(expected[key], actual[key], path + '/' + key);
      if (diff) return diff;
    }
    return null;
  }
  return { path, expected, actual };
}

// A deletion-minimal counterexample, never advertised as a globally shortest path.
export async function reduceSteps(steps, reproduces, maxRuns = 64) {
  let current = [...steps], runs = 0, changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i++) {
      if (runs >= maxRuns) return { steps: current, runs, oneMinimal: false };
      const candidate = current.filter((_, n) => n !== i);
      runs++;
      if (await reproduces(candidate)) { current = candidate; changed = true; break; }
    }
  }
  return { steps: current, runs, oneMinimal: true };
}

export async function runNativeAcceptance(page, oraclePath, outputDir, previewUrl, { minimize = false, artifactPath } = {}) {
  const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
  const sourceHash = createHash('sha256').update(await readFile(oracle.source)).digest('hex');
  if (sourceHash !== oracle.sourceHash) throw new Error('Source changed since oracle preparation');
  await mkdir(outputDir, { recursive: false }); // evidence never overwritten
  const save = (name, value) => writeFile(join(outputDir, name), JSON.stringify(value, null, 2) + '\n');
  await save('oracle.json', oracle);
  await writeFile(join(outputDir, 'source' + extname(oracle.source)), oracle.sourceText ?? await readFile(oracle.source), { flag: 'wx' });
  const symbols = Object.fromEntries(oracle.symbols.map(s => [s.id, s]));
  for (const symbol of Object.values(symbols))
    if (symbol.display && symbol.display !== symbol.name) symbol.nativeName = symbol.display;
  const hook = await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__rpAcceptanceErrors=[];
    addEventListener('error',e=>window.__rpAcceptanceErrors.push(e.message));
    addEventListener('unhandledrejection',e=>window.__rpAcceptanceErrors.push(String(e.reason)));
  ` });
  const hookId = hook.identifier ?? hook.result?.identifier;
  let entryUrl;

  async function readState() {
    return page.evaluate(config => {
      const { observe, symbols, pages, variableTypes, repeaterModels } = config;
      const pageId = pages.find(p => p.name === document.title)?.id;
      if (!pageId || !window.$axure) throw new Error('Not a prepared Axure page: ' + document.title);
      const state = { page: pageId, widgets: {}, variables: {}, repeaters: {}, panels: {} };
      const el = ident => {
        const matches = [...document.querySelectorAll('[data-label]')].filter(e => e.dataset.label === (symbols[ident].nativeName ?? symbols[ident].name) && e.tagName !== 'SCRIPT');
        if (matches.length !== 1) throw new Error('Ambiguous/missing observed element ' + ident + ': ' + matches.length);
        return matches[0];
      };
      const typed = (value, type) => {
        if (type === 'number') {
          const n = Number(value);
          if (!Number.isFinite(n)) throw new Error('Non-numeric native data: ' + value);
          return n;
        }
        if (type === 'boolean') return value === true || value === 'true' || value === '1';
        return String(value ?? '');
      };
      $axure.internal($ax => {
        for (const id of observe.widgets ?? []) {
          if (symbols[id].pageId !== pageId) continue;
          const e = el(id), input = e.querySelector('input,textarea');
          state.widgets[id] = input ? ($ax.placeholderManager.isActive(e.id) ? '' : input.value) : e.textContent.trim();
        }
        for (const name of observe.variables ?? []) state.variables[name] = typed($ax.globalVariableProvider.getVariableValue(name), variableTypes[name]);
        for (const id of observe.repeaters ?? []) {
          if (symbols[id].pageId !== pageId) continue;
          const e = el(id), model = repeaterModels[id];
          const row = item => Object.fromEntries(Object.entries(model).map(([key, type]) => [key, typed($ax.repeater.getData({}, e.id, item, key.toLowerCase(), 'data'), type)]));
          const all = $ax.repeater.getAllItemIds(e.id);
          const visible = [...e.children].filter(child => child.tagName === 'DIV' && child.id.startsWith(e.id + '-') && getComputedStyle(child).display !== 'none')
            .map(child => $ax.repeater.getItemIdFromElementId(child.id));
          state.repeaters[id] = { rows: all.map(row), visible: visible.map(row), page: $ax.repeater.getPageIndex(e.id) };
        }
        for (const id of observe.panels ?? []) {
          if (symbols[id].pageId !== pageId) continue;
          const e = el(id), current = $ax.visibility.GetPanelState(e.id);
          const active = document.getElementById(current);
          if (!active) throw new Error('Panel state missing: ' + current);
          state.panels[id] = active.getAttribute('data-label');
        }
      });
      const inputStyles = {};
      for (const id of observe.widgets ?? []) {
        if (symbols[id].pageId !== pageId || symbols[id].kind !== 'input') continue;
        const input = el(id).querySelector('input'), css = getComputedStyle(input), r = input.getBoundingClientRect();
        inputStyles[id] = { fontSize: css.fontSize, fontWeight: css.fontWeight, color: css.color, align: css.textAlign,
          padding: css.padding, placeholder: $axure.internal($ax => $ax.getObjectFromElementId(el(id).id).placeholderText ?? ''), x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return { state, inputStyles, errors: window.__rpAcceptanceErrors ?? [] };
    }, { ...oracle, symbols });
  }

  async function settle() {
    let last, stable = 0;
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      // Background native previews throttle animation frames; use the event queue.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      const current = await readState();
      stable = last && !difference(last, current) ? stable + 1 : 0;
      if (stable >= 2) return current;
      last = current;
    }
    await save('unsettled-state.json', last);
    throw new Error('Native state did not settle');
  }

  async function act(step) {
    const id = step.click ?? step.input, name = symbols[id].nativeName ?? symbols[id].name;
    const matches = await page.evaluate(name => [...document.querySelectorAll('[data-label]')]
      .filter(e => e.dataset.label === name && e.tagName !== 'SCRIPT' && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
      .map(e => e.id), name);
    const index = step.rowIndex ?? 0;
    if (!matches[index] || (!('rowIndex' in step) && matches.length !== 1)) throw new Error('Action requires unique visible target or rowIndex: ' + id);
    const selector = '#' + matches[index];
    if ('input' in step) {
      // RP 9 renders hints as values; a real keydown clears the native hint first.
      await page.press(selector + ' input', 'ControlOrMeta+A');
      if (String(step.value)) await page.keyboard.type(String(step.value));
      else await page.press(selector + ' input', 'Backspace');
      await page.press(selector + ' input', 'Tab');
    } else await page.click(selector, { label: '验收 ' + id.split('/').at(-1) });
    await page.waitForLoadState();
  }

  const stateHash = state => {
    const canonical = value => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
      : typeof value === 'number' ? Number(value.toFixed(8)) : value;
    return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
  };

  async function replay(scenario) {
    const trail = [];
    try {
      await page.goto(entryUrl);
      await page.waitForLoadState();
      await page.waitForFunction(() => !!window.$axure && document.readyState === 'complete');
      for (let i = 0; i <= scenario.steps.length; i++) {
        if (i) await act(scenario.steps[i - 1]);
        const observed = await settle();
        const diff = observed.errors.length ? { path: '/errors', expected: [], actual: observed.errors } : difference(scenario.states[i], observed.state);
        trail.push({ step: i, action: i ? scenario.steps[i - 1] : null, expected: scenario.states[i], actual: observed.state, expectedStateHash: stateHash(scenario.states[i]), nativeStateHash: stateHash(observed.state), inputStyles: observed.inputStyles, errors: observed.errors });
        if (scenario.captureAt?.includes(i)) await page.screenshot({ path: join(outputDir, `checkpoint-${report.results.length}-${i}.png`), fullPage: true });
        if (diff) return { pass: false, kind: 'differential', step: i, diff, trail };
      }
      // Independent business expectations are additional checks, not the model's own claims.
      const actual = trail.at(-1).actual;
      for (const [section, values] of Object.entries(scenario.assert ?? {})) {
        for (const [key, expected] of Object.entries(values)) {
          const diff = difference(expected, actual[section]?.[key], '/' + section + '/' + key);
          if (diff) return { pass: false, kind: 'business', step: scenario.steps.length, diff, trail };
        }
      }
      return { pass: true, steps: scenario.steps.length, trail };
    } catch (error) {
      return { pass: false, kind: 'operation', error: error.message, trail };
    }
  }

  const report = { pass: true, sourceHash, previewUrl, oraclePath, validationLevel: 'axure_preview_state_differential',
    ...(artifactPath ? { rpArtifact: { path: artifactPath, sha256: createHash('sha256').update(await readFile(artifactPath)).digest('hex') } } : {}),
    started: new Date().toISOString(), results: [] };
  try {
    await page.goto(previewUrl);
    await page.waitForLoadState();
    await page.waitForFunction(title => (document.title === title && !!window.$axure)
      || (document.querySelector('iframe')?.contentDocument?.title === title && !!document.querySelector('iframe')?.contentWindow?.$axure), oracle.pages[0].name);
    entryUrl = await page.evaluate(() => document.querySelector('iframe')?.contentDocument?.location.href ?? location.href);
    report.entryUrl = entryUrl;
    for (const scenario of oracle.scenarios) {
      const result = await replay(scenario);
      report.results.push({ id: scenario.id, ...result });
      console.log(result.pass ? 'PASS' : 'FAIL', scenario.id, result.diff ?? result.error ?? result.steps);
      if (!result.pass) {
        report.pass = false;
        await page.screenshot({ path: join(outputDir, 'first-failure.png'), fullPage: true });
        await save('first-failure.json', { scenario, ...result });
        const prefix = scenario.steps.slice(0, result.step ?? scenario.steps.length);
        await save('replay-plan.json', { observe: oracle.observe, scenarios: [{ id: scenario.id, steps: prefix, assert: scenario.assert }] });
        if (minimize && result.kind === 'differential') {
          const signature = result.diff.path;
          const candidate = steps => {
            const plan = { observe: oracle.observe, scenarios: [{ id: 'reduced', steps }] };
            const process = spawnSync('python3', [join(scripts, 'rp_acceptance.py'), 'trace', '--source', oracle.source, '--plan', '-'], { input: JSON.stringify(plan), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
            if (process.status) throw new Error(process.stderr);
            return JSON.parse(process.stdout).scenarios[0];
          };
          const reduced = await reduceSteps(prefix, async steps => {
            const r = await replay(candidate(steps));
            return !r.pass && r.kind === 'differential' && r.diff.path === signature;
          });
          const minimizedScenario = candidate(reduced.steps);
          const final = await replay(minimizedScenario);
          if (final.pass || final.kind !== 'differential' || final.diff.path !== signature) throw new Error('Reduced failure did not reproduce');
          await page.screenshot({ path: join(outputDir, 'minimal-failure.png'), fullPage: true });
          await save('minimal-failure.json', { ...reduced, result: final });
          await save('minimal-plan.json', { observe: oracle.observe, scenarios: [{ id: scenario.id, steps: reduced.steps }] });
          report.minimization = reduced;
        }
        break;
      }
    }
    if (report.pass) await page.screenshot({ path: join(outputDir, 'passed.png'), fullPage: true });
  } catch (error) {
    report.pass = false;
    report.harnessError = error.message;
  } finally {
    report.stateComparisons = report.results.reduce((n, r) => n + r.trail.length, 0);
    report.executedSteps = report.results.reduce((n, r) => n + r.trail.filter(t => t.action).length, 0);
    report.stateHashMismatches = report.results.reduce((n, r) => n + r.trail.filter(t => t.expectedStateHash !== t.nativeStateHash).length, 0);
    report.finished = new Date().toISOString();
    await save('report.json', report);
    if (hookId) await page.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: hookId });
  }
  if (!report.pass) throw new Error('Native acceptance failed; see ' + join(outputDir, 'report.json'));
  return report;
}
