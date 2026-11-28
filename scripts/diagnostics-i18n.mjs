const translations = {
  E_DSL_SYNTAX: 'RP/1 语法有误，请核对该行的缩进、完整语句和引号。',
  E_REFERENCE: '未找到引用的对象，请核对当前页、容器作用域和候选目标。',
  E_PROPERTY: '属性与当前节点的声明不兼容，请核对支持的字段。',
  E_TYPE: '值的类型与声明不符，请核对该字段的预期类型。',
  E_SCHEMA: '源码结构不符合 RP/1 契约，请核对相关字段与值。',
  E_TOOL_INPUT: '工具参数未通过校验，请按照参数契约修正。',
};

export function localizeDiagnostic(diagnostic) {
  if (/^en/i.test(process.env.ZEE_LANG ?? 'zh-CN')) {
    return diagnostic.originalMessage ? { ...diagnostic, message: diagnostic.originalMessage } : diagnostic;
  }
  const { code, message } = diagnostic;
  if (!translations[code] || !message || /[\u3400-\u9fff]/u.test(message)) return diagnostic;
  return { ...diagnostic, message: translations[code], originalMessage: message };
}
