import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const officialWidgetMapFile = 'zee-widget-map.json';

// Axure RP9/RP11 emit literals, an _() object constructor and interned
// constants. Decode that data grammar without executing any exported JS.
export function decodeAxureData(input) {
  const source = input.replace(/^\uFEFF/, '').trim();
  const json = source.match(/^\$axure\.(?:loadCurrentPage|loadDocument)\(\s*(\{[\s\S]*\})\s*\);?$/);
  if (json) return JSON.parse(json[1]);
  const start = /\bvar\s+_creator\s*=\s*function\s*\(\)\s*\{\s*return\s*/.exec(source);
  if (!/^\$axure\.(?:loadCurrentPage|loadDocument)\(/.test(source) || !start) throw new Error('Unknown Axure page-data format');
  const suffix = /\s*return\s+_creator\(\)\s*;\s*\}\)\(\)\);?\s*$/.exec(source);
  if (!suffix || suffix.index <= start.index) throw new Error('Missing Axure page-data footer');

  const constants = new Map();
  const lex = /\s*(?:"(?:[^"\\]|\\[\s\S])*"|[a-zA-Z_$][\w$]*|-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)|[()\[\]{},:;=])/y;
  let token;
  const next = () => { token = lex.exec(source)?.[0].trim(); return token; };
  const take = expected => {
    if (token !== expected) throw new Error(`Expected ${expected} in Axure page data`);
    next();
  };
  function sequence(end, depth) {
    const values = [];
    while (token !== end) {
      values.push(value(depth + 1));
      if (token === end) break;
      take(',');
    }
    take(end);
    return values;
  }
  function value(depth = 0, literalsOnly = false) {
    if (depth > 256 || token === undefined) throw new Error('Invalid or deeply nested Axure page data');
    const item = token;
    next();
    if (item.startsWith('"')) return JSON.parse(item);
    if (/^-?\d/.test(item)) return item.startsWith('-0x') ? -Number(item.slice(1)) : Number(item);
    if (item === 'null' || item === 'true' || item === 'false') return JSON.parse(item);
    if (item === 'new' && token === 'Date') {
      take('Date');
      take('(');
      const timestamp = value(depth + 1, true);
      take(')');
      if (typeof timestamp !== 'number') throw new Error('Invalid Axure generation date');
      return timestamp;
    }
    if (!literalsOnly && item === '[') return sequence(']', depth);
    if (!literalsOnly && item === '_' && token === '(') {
      take('(');
      const values = sequence(')', depth);
      if (values.length % 2) throw new Error('Invalid Axure object constructor');
      const pairs = [];
      for (let i = 0; i < values.length; i += 2) pairs.push([values[i], values[i + 1]]);
      return Object.fromEntries(pairs);
    }
    if (!literalsOnly && constants.has(item)) return constants.get(item);
    throw new Error(`Unsupported token in Axure page data: ${item.slice(0, 40)}`);
  }
  const end = /;\s*\};\s*(?:var\s+)?(?=[\w$]+\s*=)/g;
  end.lastIndex = start.index + start[0].length;
  // Skip quoted strings when locating the constructor's end.
  lex.lastIndex = end.lastIndex;
  while (next() !== ';') {
    if (token === undefined) throw new Error('Missing Axure page-data constructor end');
  }
  const constructorEnd = lex.lastIndex - 1;
  end.lastIndex = constructorEnd;
  const declaration = end.exec(source);
  if (!declaration || declaration.index !== constructorEnd)
    throw new Error('Missing Axure page-data constant table');
  lex.lastIndex = end.lastIndex;
  next();
  for (;;) {
    const key = token;
    if (!/^[\w$]+$/.test(key ?? '')) throw new Error('Invalid Axure page-data constant');
    next();
    take('=');
    constants.set(key, value(0, true));
    if (token === ';') break;
    take(',');
  }
  if (source.slice(lex.lastIndex, suffix.index).trim()) throw new Error('Unexpected Axure page-data statement');
  lex.lastIndex = start.index + start[0].length;
  next();
  const result = value();
  if (token !== ';') throw new Error('Invalid Axure page-data constructor');
  return result;
}

const pointer = path => '/' + path.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
const present = (path, index) => index >= 0 ? Number(path[index + 1]) + 1 : null;

export function scanOfficialInteractions(directory, { symbols = [] } = {}) {
  const files = [];
  const diagnostics = [];
  const visitFiles = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visitFiles(path);
      else if (entry.isFile() && entry.name === 'data.js') files.push(path);
    }
  };
  const pageFiles = join(directory, 'files');
  if (lstatSync(pageFiles, { throwIfNoEntry: false })?.isDirectory()) visitFiles(pageFiles);
  const symbolsById = new Map(symbols.filter(s => s.officialId).map(s => [s.officialId, s]));
  let parsedPages = 0;
  for (const file of files.sort()) {
    try {
      const data = decodeAxureData(readFileSync(file, 'utf8'));
      if (!data.page || typeof data.page.name !== 'string') throw new Error('Axure page data has no page name');
      parsedPages++;
      const visit = (node, path, context) => {
        if (!node || typeof node !== 'object') return;
        const widget = node.id && (node.friendlyType || node.type) ? node : context.widget;
        const id = widget?.id;
        const symbol = symbolsById.get(id);
        const expression = typeof node.value === 'string' && node.exprType === 'stringLiteral' ? node.value : context.expression;
        const kase = path.at(-2) === 'cases' ? node : context.kase;
        const action = path.at(-2) === 'actions' ? node : context.action;
        const event = path.at(-2) === 'interactionMap' ? node.eventType || path.at(-1) : context.event;
        if (node.sto === 'error') {
          const caseIndex = path.lastIndexOf('cases');
          const actionIndex = path.lastIndexOf('actions');
          const programPointer = symbol?.programCasePointers?.[path[caseIndex + 1]] ?? symbol?.programPointer;
          diagnostics.push({
            code: 'E_AXURE_STO_COMPILE', severity: 'error', file: file.slice(directory.length + 1),
            page: data.page.name, widget: id ? widget.label || null : null, widgetId: id ?? null,
            ...(id && widget.friendlyType ? { widgetType: widget.friendlyType } : {}),
            ...(symbol ? { logicalId: symbol.logicalId, ...(symbol.sourceSpan ? { sourceSpan: symbol.sourceSpan } : {}), ...(programPointer ? { programPointer } : {}) } : {}),
            event: event ?? null, case: kase?.description ?? null, caseIndex: present(path, caseIndex),
            action: action?.displayName ?? action?.action ?? null, actionIndex: present(path, actionIndex),
            expression: expression ?? null, pointer: pointer(path),
            message: 'Axure 官方编译器无法编译此表达式。',
            nextAction: expression?.match(/\bMath\s*\.\s*round\b/)
              ? '按小数位舍入可用 (数值).toFixed(位数)。调整后重新执行官方预检。'
              : '检查变量作用域、括号与 Axure 函数，调整该表达式后重新执行官方预检。',
          });
        }
        for (const [key, child] of Object.entries(node)) {
          if (child && typeof child === 'object') visit(child, [...path, key], { widget, expression, kase, action, event });
        }
      };
      visit(data, [], {});
    } catch (error) {
      diagnostics.push({ code: 'W_AXURE_DATA_UNREADABLE', severity: 'warning', file: file.slice(directory.length + 1), message: error.message });
    }
  }
  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  return { status: errorCount ? 'failed' : !files.length ? 'unavailable' : parsedPages === files.length ? 'passed' : 'incomplete',
    pagesScanned: parsedPages, pageFiles: files.length, errorCount, diagnostics };
}
