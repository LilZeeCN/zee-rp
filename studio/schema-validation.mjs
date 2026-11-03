// Shared structural validation for public MCP input and Studio commands.
// Semantic constraints (targets, layout, events and resources) remain in their consumers.
export function validateInput(schema, value, at = 'arguments') {
  if (schema === true || schema === undefined) return;
  if (schema === false) throw new Error(`${at} 不接受该值`);
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) throw new Error(`${at} 必须为 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${at} 不在允许值内`);
  const matches = branch => { try { validateInput(branch, value, at); return true; } catch { return false; } };
  if (schema.not && matches(schema.not)) throw new Error(`${at} 包含互斥参数`);
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1) throw new Error(`${at} 必须满足且仅满足一种参数形式，不能混用`);
  if (schema.anyOf && !schema.anyOf.some(matches)) throw new Error(`${at} 不符合允许的参数形式`);
  for (const branch of schema.allOf || []) validateInput(branch, value, at);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key} 缺失`);
  }
  if (!schema.type) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const accepts = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? Number.isFinite(value) : typeof value === type;
  if (!types.some(accepts)) throw new Error(`${at} 必须是 ${types.join('/')}`);
  if (value === null) return;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) throw new Error(`${at} 需要至少 ${schema.minProperties} 个字段`);
    for (const [key, field] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub && schema.additionalProperties === false) throw new Error(`${at}.${key} 未登记`);
      if (sub) validateInput(sub, field, `${at}.${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateInput(schema.additionalProperties, field, `${at}.${key}`);
    }
  } else if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${at} 至少需要 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${at} 最多允许 ${schema.maxItems} 项`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) throw new Error(`${at} 不能包含重复项`);
    value.forEach((item, i) => validateInput(schema.items, item, `${at}[${i}]`));
  } else if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${at} 不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${at} 不能大于 ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw new Error(`${at} 必须大于 ${schema.exclusiveMinimum}`);
  } else if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${at} 不能为空`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${at} 超出 ${schema.maxLength} 字符`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${at} 格式错误`);
  }
}
