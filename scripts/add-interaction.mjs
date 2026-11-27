// CLI: append interactions (events + actions) to a widget or a page inside a .rp file, offline.
// Usage:
//   node add-interaction.mjs source.rp output.rp <widgetName> [--page] \
//        --event OnClick --action hide target=PanelB duration=300 \
//        --action wait ms=200 --action show target=PanelB animation=slideDown
//   node add-interaction.mjs source.rp output.rp GUI_TREE_TRIGGER --on-page Quick\ win \
//        --event OnClick --action expand-collapse-tree target=TR1 'node=Item 1' expand=false
//   node add-interaction.mjs source.rp output.rp --json spec.json
// spec.json: { "target": "PanelB", "page": false, "interactions": [ { "event": "OnClick", "actions": [ { "type": "hide", "target": "PanelB" } ] } ] }
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addInteractionsBatch, loadBaselineMap, EVENTS } from './ix-actions.mjs';
import { lintInteractionSpecs } from './interaction-lint.mjs';
import { readRp } from './rp-read.mjs';
import { nativeWidgetIdentities } from './native-widget-identity.mjs';

function parseArgs(argv) {
  const positional = [];
  const interactions = [];
  let current = null;
  const coerce = v => (v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--event') {
      current = { event: argv[++i], actions: [] };
      interactions.push(current);
    } else if (token === '--action') {
      const type = argv[++i];
      const spec = { type };
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        const [k, ...rest] = argv[++i].split('=');
        spec[k] = rest.length ? coerce(rest.join('=')) : true;
      }
      if (!current) { current = { event: 'OnClick', actions: [] }; interactions.push(current); }
      current.actions.push(spec);
    } else if (token.startsWith('--')) {
      positional.push(token);
    } else {
      positional.push(token);
    }
  }
  return { positional, interactions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const jsonAt = argv.indexOf('--json');
  const onPageIdx = argv.indexOf('--on-page');
  const onPage = onPageIdx >= 0 ? argv[onPageIdx + 1] : null;
  const baselineIdx = argv.indexOf('--baseline');
  const baselineArg = baselineIdx >= 0 ? argv[baselineIdx + 1] : null;
  const replaceEvent = argv.includes('--replace-event');
  let src, dst, target, interactions, batchItems = null, page = argv.includes('--page');
  if (jsonAt >= 0) {
    const spec = JSON.parse(readFileSync(argv[jsonAt + 1], 'utf8'));
    const rest = argv.filter((a, i) => i !== jsonAt && i !== jsonAt + 1
      && !(baselineIdx >= 0 && (i === baselineIdx || i === baselineIdx + 1))
      && !(onPageIdx >= 0 && (i === onPageIdx || i === onPageIdx + 1))
      && !a.startsWith('--'));
    [src, dst] = rest;
    if (Array.isArray(spec.items)) {
      batchItems = spec.items;
    } else {
      target = spec.target;
      page = page || !!spec.page;
      if (spec.onPage && typeof target === 'string') target = { widget: target, page: spec.onPage };
      interactions = spec.interactions;
    }
  } else {
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--page') continue;
      if (a === '--on-page' || a === '--baseline') { i++; continue; }
      if (a === '--event') { i++; continue; }
      if (a === '--action') {
        i++;
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++;
        continue;
      }
      if (a.startsWith('--')) continue;
      rest.push(a);
    }
    [src, dst, target] = rest;
    interactions = parseArgs(argv).interactions;
  }
  if (!src || !dst || (!batchItems && !target && !page)) {
    console.error('Usage: node add-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] [--baseline <file.baseline.json>] [--replace-event] --event <EventName> --action <type> [key=value ...] ...');
    console.error('  --page      目标为页面级交互');
    console.error('  --on-page   限定在某页面内找 widget（两页同名只改指定页；重名时报候选清单）');
    console.error('  --baseline  显式指定 .baseline.json 以解析逻辑 ID（省略时自动读取 <source>.baseline.json）');
    console.error('  --json      支持单目标 {target,interactions} 或批量事务 {items:[{target,interactions},...]}');
    console.error('  --replace-event   替换目标上同类型的唯一已有事件；多个同类型事件时报错');
    console.error('  expand-collapse-tree 可用 node=<树节点可见文本> 指定树中节点；文本含空格时引用整个 node=... 参数');
    console.error('Events: ' + Object.keys(EVENTS).join(', '));
    process.exit(1);
  }
  const baseline = loadBaselineMap(src, baselineArg);
  const file = readFileSync(src);
  const rp = readRp(file, { path: src });
  const variables = rp.globalVariables.map(v => v.name);
  const rawTarget = page ? { page: typeof target === 'string' ? target : target?.page } : onPage && typeof target === 'string' ? { widget: target, page: onPage } : target;
  const items = batchItems ?? [{ target: rawTarget, interactions }];
  const diagnostics = items.flatMap((item, index) => lintInteractionSpecs(
    item.interactions ?? [{ event: item.event, actions: item.actions ?? [] }], { variables, version: rp.version, context: { target: item.target } },
  ).diagnostics.map(d => ({ ...d, pointer: batchItems ? `/items/${index}${d.pointer}` : d.pointer })));
  if (diagnostics.some(d => d.severity === 'error')) {
    console.error(JSON.stringify({ code: 'E_INTERACTION_PREFLIGHT', message: '交互静态预检失败。', diagnostics }));
    process.exit(1);
  }
  const out = addInteractionsBatch(file, items, { replaceEvent, baseline, widgetIdentities: nativeWidgetIdentities(rp) });
  writeFileSync(dst, out.file, { flag: 'wx' });
  const report = batchItems ? out.report : out.report.results[0];
  console.log(JSON.stringify({ ...report, lint: { diagnostics } }, null, 2));
}
