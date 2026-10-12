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
import { addInteractions, EVENTS } from './ix-actions.mjs';

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
  const replaceEvent = argv.includes('--replace-event');
  let src, dst, target, interactions, page = argv.includes('--page');
  if (jsonAt >= 0) {
    const spec = JSON.parse(readFileSync(argv[jsonAt + 1], 'utf8'));
    const rest = argv.filter((a, i) => i !== jsonAt && i !== jsonAt + 1 && !a.startsWith('--'));
    [src, dst] = rest;
    target = spec.target;
    page = page || !!spec.page;
    interactions = spec.interactions;
  } else {
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--page') continue;
      if (a === '--on-page') { i++; continue; }
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
  if (!src || !dst || (!target && !page)) {
    console.error('Usage: node add-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] [--replace-event] --event <EventName> --action <type> [key=value ...] ...');
    console.error('  --page      目标为页面级交互');
    console.error('  --on-page   限定在某页面内找 widget（两页同名只改指定页；重名时报候选清单）');
    console.error('  --replace-event   替换目标上同类型的唯一已有事件；多个同类型事件时报错');
    console.error('  expand-collapse-tree 可用 node=<树节点可见文本> 指定树中节点；文本含空格时引用整个 node=... 参数');
    console.error('Events: ' + Object.keys(EVENTS).join(', '));
    process.exit(1);
  }
  const finalTarget = page ? { page: target } : (onPage ? { widget: target, page: onPage } : target);
  const out = addInteractions(readFileSync(src), finalTarget, interactions, { replaceEvent });
  writeFileSync(dst, out.file, { flag: 'wx' });
  console.log(JSON.stringify(out.report, null, 2));
}
