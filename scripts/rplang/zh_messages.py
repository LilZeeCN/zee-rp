"""Translate author-facing diagnostics while retaining their stable codes."""

import os
import re


def localize_diagnostic(diagnostic):
    if os.environ.get("ZEE_LANG", "zh-CN").lower().startswith("en"):
        return diagnostic

    message = diagnostic.get("message", "")
    code = diagnostic.get("code")
    if not message:
        return diagnostic
    translations = (
        (r"Unknown event action '([^']+)'", lambda m: f"无法识别事件动作「{m[1]}」。请核对动词拼写。"),
        (r"(?:Unexpected indentation|Unexpected dedent) at line (\d+)", lambda m: f"第 {m[1]} 行缩进层级异常。"),
        (r"Unknown reference '([^']+)' in scope '([^']+)'(?:.*)",
         lambda m: f"作用域「{m[2]}」中未找到引用「{m[1]}」。" +
         ("引用含空格或运算符，请检查动作和条件语句的格式。" if re.search(r"[\s=!<>+*]", m[1]) else "")),
        (r"Unknown property '([^']+)'(?:.*)", lambda m: f"该组件不接受属性「{m[1]}」。"),
    )
    for pattern, translate in translations:
        match = re.fullmatch(pattern, message)
        if match:
            return {**diagnostic, "message": translate(match), "originalMessage": message}
    if code in {"E_DSL_SYNTAX", "E_REFERENCE", "E_PROPERTY", "E_TYPE", "E_SCHEMA"} and not re.search(r"[\u3400-\u9fff]", message):
        descriptions = {
            "E_DSL_SYNTAX": "RP/1 语法有误，请核对该行的缩进、完整语句和引号。",
            "E_REFERENCE": "未找到引用的对象，请核对当前页和容器作用域。",
            "E_PROPERTY": "属性与当前节点的声明不兼容，请核对节点的属性表。",
            "E_TYPE": "值的类型与声明不符，请核对字段的预期类型。",
            "E_SCHEMA": "源码结构不符合 RP/1 契约，请核对字段与值。",
        }
        return {**diagnostic, "message": descriptions[code], "originalMessage": message}
    return diagnostic
