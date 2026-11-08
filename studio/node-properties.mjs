import { readFileSync } from 'node:fs';

// Reuse the RP/1 vocabulary shipped with the compiler. Studio adds only the
// fields its visual renderer, layout and component model actually consume.
const languageSchema = JSON.parse(readFileSync(new URL('../references/rp-language.schema.json', import.meta.url), 'utf8'));
export const RP1_SOURCE_PROPERTIES_BY_TYPE = new Map(Object.entries(languageSchema['x-source-properties-by-type'] || {}).map(([type, fields]) => [type, new Set(fields)]));
export const RP1_SOURCE_PROPERTY_CONDITIONS = languageSchema['x-source-property-conditions'] || {};
const sourceFields = (languageSchema.$defs.node.anyOf || []).flatMap(shape => Object.keys(shape.properties || {}));
const typedFields=new Set((languageSchema.$defs.node.anyOf||[]).filter(shape=>shape.properties?.type?.const).flatMap(shape=>Object.keys(shape.properties)));
// The shorthand key in {card:{...}} names a node; it is not a property of an
// already typed node. `use` remains an explicit Studio component alias.
export const NODE_SYNTAX_ONLY_PROPERTIES=new Set(sourceFields.filter(key=>!typedFields.has(key)&&key!=='use'));
const studioFields = [
  'fontFamily', 'textAlign', 'textPaddingY', 'minW', 'maxW', 'minH', 'maxH',
  'visible', 'hidden', 'locked', 'role', 'hitW', 'hitH', 'hitArea', 'for', 'emptyFor', 'boundTo',
  'css', 'customFilter', 'threeDTransform', 'rotation', 'interactive', 'component', 'props',
  'overrides', 'slots', 'variantKey', 'activeState', 'rows', 'source', 'data',
  'filter', 'sort', 'activeFilter', 'activeSort', 'macroSource', 'controlledByMacro', 'componentSource',
  'constraints', 'state', 'tone', 'content', 'clip', 'overflow',
  'mixBlendMode', 'shadows', 'fills',
];
export const NODE_PROPERTY_NAMES = new Set([...sourceFields, ...studioFields]);
export const NODE_READONLY_PROPERTIES = new Set(['id','type','sourcePointer','macroSource','controlledByMacro','componentSource']);
export const NODE_UNCONSUMED_PROPERTIES = new Set(['activeFilter','activeSort',...NODE_SYNTAX_ONLY_PROPERTIES]);

// W1 2026-11-02：rotate/rot 的编辑距离最近词是 state（距离 2 < rotation 的 4），
// 模糊建议会重新引入已被 T-H-4 修复消除的误导候选；显式别名优先。
const PROPERTY_ALIASES = { rotate: ['rotation'], rot: ['rotation'], turn: ['rotation'] };

export function propertySuggestions(key) {
  const alias = PROPERTY_ALIASES[String(key).toLowerCase()];
  if (alias) return alias.slice();
  const distance = (a, b) => {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)));
      previous = next;
    }
    return previous[b.length];
  };
  return [...NODE_PROPERTY_NAMES].map(name => ({ name, d: distance(key.toLowerCase(), name.toLowerCase()) }))
    .filter(item => item.d <= 2).sort((a, b) => a.d - b.d || a.name.localeCompare(b.name)).slice(0, 4).map(item => item.name);
}
