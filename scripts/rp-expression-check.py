#!/usr/bin/env python3
"""Validate Studio assignment expressions with the RP/1 expression parser."""
import json
import sys

from rp_language import LanguageError, parse_inline_expr


FUNCTIONS = {
    "concat": "text",
    "contains": "boolean",
    "length": "number",
    "lower": "text",
    "not": "boolean",
    "number": "number",
    "remove": "text",
    "text": "text",
    "upper": "text",
}


def failure(code, message):
    return {"code": code, "message": message}


def infer(node, variables):
    if isinstance(node, bool):
        return "boolean"
    if type(node) in (int, float):
        return "number"
    if isinstance(node, str):
        return "text"
    if not isinstance(node, dict):
        return None
    if "_auto_ident" in node:
        name = node["_auto_ident"]
        if name not in variables:
            raise ValueError(failure("E_VARIABLE", f'Unknown variable "{name}"'))
        return variables[name]
    if "_sigil_var" in node:
        name = node["_sigil_var"]
        if name not in variables:
            raise ValueError(failure("E_VARIABLE", f'Unknown variable "{name}"'))
        return variables[name]
    if "variable" in node:
        name = node["variable"]
        if name not in variables:
            raise ValueError(failure("E_VARIABLE", f'Unknown variable "{name}"'))
        return variables[name]
    if "widget" in node:
        wref = node.get("widget")
        ref_str = str(wref.get("ref", "")) if isinstance(wref, dict) else str(wref or "")
        prop = node.get("property") or (ref_str.rsplit(".", 1)[1] if "." in ref_str else None)
        if prop in ("checked", "disabled"):
            return "boolean"
        if prop == "selected":
            return None
        return "text"
    if "_auto_path" in node:
        parts = str(node["_auto_path"]).split(".")
        if parts[0] == "var" and len(parts) == 2 and parts[1]:
            name = parts[1]
            if name not in variables:
                raise ValueError(failure("E_VARIABLE", f'Unknown variable "{name}"'))
            return variables[name]
        if parts[0] == "widget" and len(parts) == 3 and parts[1]:
            if parts[2] in ("checked", "disabled"):
                return "boolean"
            if parts[2] == "selected":
                return None
            if parts[2] in ("text", "value"):
                return "text"
        return None
    if "op" in node:
        left = infer(node.get("left"), variables)
        right = infer(node.get("right"), variables)
        op = node["op"]
        if op in {"+", "-", "*", "/", ">", "<", ">=", "<="}:
            if left is not None and right is not None and op != "+" and (left != "number" or right != "number"):
                raise ValueError(failure("E_TYPE", f'Operator {op} requires number operands'))
            if left == "text" and right == "text" and op == "+":
                return "text"
            if op == "+" and left is not None and right is not None and (left != "number" or right != "number"):
                raise ValueError(failure("E_TYPE", 'Addition requires two numbers or two text values; use text() for conversion'))
            return "boolean" if op in {">", "<", ">=", "<="} else "number"
        if op in {"&&", "||"}:
            if left is not None and right is not None and (left != "boolean" or right != "boolean"):
                raise ValueError(failure("E_TYPE", f'Operator {op} requires boolean operands'))
            return "boolean"
        if op in {"==", "!="}:
            if left is not None and right is not None and left != right:
                raise ValueError(failure("E_TYPE", f'Comparison requires matching types, got {left} and {right}'))
            return "boolean"
        raise ValueError(failure("E_OPERATOR", f"Unsupported expression operator {op}"))
    if "fn" in node:
        name = node["fn"]
        if name not in FUNCTIONS:
            raise ValueError(failure("E_FUNCTION", f'Unknown runtime function "{name}"'))
        args = node.get("args")
        if not isinstance(args, list):
            raise ValueError(failure("E_ARGUMENT", f"Runtime function {name} requires arguments"))
        required = {"contains": 2, "remove": 2}.get(name, 1)
        if (name == "concat" and len(args) < 2) or (name != "concat" and len(args) != required):
            raise ValueError(failure("E_ARGUMENT", f"Runtime function {name} has the wrong argument count"))
        for arg in args:
            infer(arg, variables)
        return FUNCTIONS[name]
    return None


def main():
    request = json.load(sys.stdin)
    for index, item in enumerate(request.get("expressions", [])):
        try:
            ast = parse_inline_expr(item["expr"], f"$.expressions[{index}]")
            actual = infer(ast, item.get("variables", {}))
            expected = item.get("expected")
            if expected and actual and actual != expected:
                raise ValueError(failure("E_TYPE", f"Expected {expected}, got {actual}"))
        except LanguageError as error:
            print(json.dumps({"ok": False, "index": index, "code": error.diagnostic["code"], "message": str(error)}, ensure_ascii=False))
            return 1
        except ValueError as error:
            payload = error.args[0] if error.args and isinstance(error.args[0], dict) else failure("E_EXPRESSION", str(error))
            print(json.dumps({"ok": False, "index": index, **payload}, ensure_ascii=False))
            return 1
    print(json.dumps({"ok": True, "checked": len(request.get("expressions", []))}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main() or 0)
