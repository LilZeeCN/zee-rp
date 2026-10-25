"""Author-facing diagnostics and binding explanations. No source or native writes."""
import copy
import re
from rp_language import Frontend, LanguageError, SHORTHAND_NODE_KINDS, _resolve_pointer, DEVICE_CANVAS_PRESETS, validate_source_tree, MAX_FONT_SIZE


def _node_identity(node):
    if not isinstance(node, dict):
        return None
    kind = node.get("type") or next((k for k in SHORTHAND_NODE_KINDS if isinstance(node.get(k), str)), None)
    identity = node.get("id", node.get(kind))
    return identity if isinstance(identity, str) else None


def contextualize(diagnostic, spec, spans=None, source_text=None):
    """Keep compiler codes/pointers; add context and reviewable, untrusted suggestions."""
    out = copy.deepcopy(diagnostic)
    pointer = out.get("pointer", "/")
    parts = pointer.strip("/").split("/") if pointer != "/" else []
    current, node = spec, None
    for index, part in enumerate(parts):
        try:
            current = current[int(part)] if isinstance(current, list) else current[part.replace("~1", "/").replace("~0", "~")]
        except (KeyError, IndexError, TypeError, ValueError):
            break
        if index == 1 and parts[0] == "pages" and isinstance(current, dict):
            out.update(pageId=current.get("id"), pageName=current.get("name", current.get("id")))
        if _node_identity(current):
            node = current
    if node:
        out.update(widgetId=_node_identity(node), widgetName=node.get("name", _node_identity(node)))
    out["field"] = parts[-1] if parts else None
    try:
        out["actual"] = _resolve_pointer(spec, pointer)
    except (LanguageError, KeyError, IndexError, TypeError, ValueError):
        pass
    expected = re.search(r"[Ee]xpected ([^,;]+)", out.get("message", ""))
    if expected:
        out["expected"] = expected.group(1)
    cur = pointer
    while cur:
        if spans and cur in spans:
            out["sourceSpan"] = spans[cur]
            break
        cur = cur.rpartition("/")[0]
    if isinstance(out.get("sourceSpan"), dict):
        out.update(line=out["sourceSpan"].get("line"), column=out["sourceSpan"].get("column"))
        if source_text and out.get("line"):
            lines = source_text.splitlines()
            line = out["line"]
            if 0 < line <= len(lines):
                out["snippet"] = lines[line - 1]
    code = out.get("code", "")
    fixes = out.get("candidatePatches", [])
    for fix in fixes:
        fix["requiresReview"] = True
        fix["validation"] = "not-applied"
        for op in fix.get("operations", []):
            try:
                op.setdefault("oldValue", copy.deepcopy(_resolve_pointer(spec, op["path"])))
            except (LanguageError, KeyError, IndexError, TypeError, ValueError):
                pass
    hints = {
        "E_REFERENCE": "使用目标的逻辑 ID；嵌套元件使用完整 panel/state/widget 路径。",
        "E_TYPE": "检查该字段的期望类型；运行期文本数字须显式 number(...) 转换。",
        "E_NODE_TYPE": "从支持的元件类型中选择；先修类型，再检查该节点的字段。",
        "E_PROPERTY": "删除不支持的字段，或按候选补丁修正拼写。",
        "E_SIZE": "将宽高设为正数；隐藏元件请使用 visible:false。",
        "E_PATCH_CONFLICT": "重新读取当前源码及 semanticHash，再决定是否重做补丁。",
    }
    out["nextAction"] = hints.get(code, "按源码位置修正后重新诊断；编译通过后仍需验证实际交互。")
    if code == "E_SIZE" and out.get("field") in {"fontSize", "size", "headerFontSize", "titleFontSize"}:
        out["nextAction"] = f"将字号设为大于 0 且不超过 {MAX_FONT_SIZE} 的数值。"
    if code == "E_SIZE" and out.get("field") == "letterSpacing":
        out["nextAction"] = "将 letterSpacing 设为非负数；0 表示默认字距。"
    if out.get("field") == "right" and node and node.get("type") == "phone-shell":
        out["nextAction"] = "phone-shell.right 是数字几何约束；右侧状态栏用 statusRight，顶栏按钮文案用 rightText，事件用 onRight。"
    if out.get("field") == "fontFamily":
        out["nextAction"] = "RP/1 当前不开放字体族字段；使用 fontSize/fontWeight/letterSpacing 控制排版，字体回退须在实际 Axure 预览核对。"
    if "requires a native input" in out.get("message", ""):
        out["nextAction"] = "enable/disable/focus 仅用于原生 input；普通按钮的提交拦截请使用条件 Case 守卫或显隐状态。"
    out["location"] = " → ".join(str(v) for v in (out.get("pageName"), out.get("widgetName"), out.get("field")) if v)
    return out


def authoring_hints(spec, spans=None, source_text=None):
    hints = []

    def walk(node, pointer):
        if isinstance(node, dict):
            kind = node.get("type") or next((k for k in SHORTHAND_NODE_KINDS if isinstance(node.get(k), str)), None)
            height = node.get("h", node.get("size", [None, None])[1] if isinstance(node.get("size"), list) and len(node["size"]) == 2 else None)
            if isinstance(kind, str) and kind in {"button", "badge", "input"} and isinstance(height, (int, float)) and height > 96:
                hint = contextualize({"code": "W_CONTROL_HEIGHT", "severity": "warning", "pointer": pointer + "/h",
                                      "message": f"Control height is {height}px; check width/height intent."}, spec, spans, source_text)
                hint["nextAction"] = "尺寸简写 [WxH] 是宽×高；[fillx180] 为高 180。宽 180 的普通按钮用 [180x44] 或 w=180 h=44。若有意使用大控件，可保留。"
                hints.append(hint)
            if isinstance(node.get("device"), str) and node["device"] in DEVICE_CANVAS_PRESETS and "canvas" in node:
                preset = DEVICE_CANVAS_PRESETS[node["device"]]
                canvas = node["canvas"]
                expected = [preset["w"], preset["h"]]
                actual = [canvas.get("w"), canvas.get("h")] if isinstance(canvas, dict) else canvas
                if actual != expected:
                    hints.append({"code": "W_DEVICE_CANVAS", "severity": "warning", "pointer": pointer + "/canvas",
                                  "message": "Custom canvas differs from the device content screen.", "actual": actual, "expected": expected,
                                  "nextAction": "canvas 是内容屏幕尺寸，推荐省略；device 会自动加机身，不要再次手画外框或预加 20px 偏移。"})
            for key, value in node.items():
                walk(value, pointer + "/" + str(key).replace("~", "~0").replace("/", "~1"))
        elif isinstance(node, list):
            for index, value in enumerate(node): walk(value, pointer + "/" + str(index))

    walk(spec, "")
    return hints


def diagnose_spec(spec, max_diagnostics=20, spans=None, source_text=None):
    """Collect independent node failures, suppress diagnostics caused by recovery stubs.

    Recovery is in a private deep copy only. Global/dependent semantic validation
    remains fail-first, explicitly reported as incomplete when a node failed.
    """
    class DiagnosticFrontend(Frontend):
        def __init__(self, source):
            self.issues = []
            super().__init__(source)

        def node(self, source, scope, env, path, stack=(), panel_depth=0):
            try:
                return super().node(source, scope, env, path, stack, panel_depth)
            except LanguageError as error:
                self.issues.append(error.diagnostic)
                # A failed subtree is represented only so sibling nodes can be checked.
                # No lowered output or successful result from this recovery run escapes.
                nid = f"diagnostic_stub_{len(self.issues)}"
                return super().node({"type": "box", "id": nid, "w": 1, "h": 1}, scope, env,
                                    path + "/diagnostic-stub", stack, panel_depth)

    frontend = None
    ir = None
    issues = []
    try:
        frontend = DiagnosticFrontend(spec)
        _, ir = frontend.compile()
    except LanguageError as error:
        if not frontend or not frontend.issues:
            issues.append(error.diagnostic)
    if frontend and frontend.issues:
        issues = frontend.issues
    unique = {(d.get("code"), d.get("pointer"), d.get("message")): d for d in issues}
    diagnostics = [contextualize(d, spec, spans, source_text) for d in unique.values()]
    return {
        "ok": not diagnostics,
        "stage": "semantic-check",
        "diagnostics": diagnostics[:max_diagnostics],
        "total": len(diagnostics), "truncated": len(diagnostics) > max_diagnostics,
        "dependentChecksComplete": not diagnostics,
        "semanticHash": ir["semanticHash"] if not diagnostics and ir else None,
        "verification": {"semantic": not diagnostics, "nativePreview": False},
        "hints": authoring_hints(spec, spans, source_text)[:max_diagnostics],
    }


def explain_binding(spec, target):
    frontend = Frontend(spec)
    lowered, ir = frontend.compile()
    symbols = ir["symbols"]
    matches = [s for s in symbols if target in (s["id"], s["name"], s["pointer"], s.get("display"))
               or s["id"].endswith("/" + target)]
    # The progress macro replaces its source node with several native symbols.
    progress = [b for b in frontend.progress_bindings
                if target in (b["pointer"], b["pointer"].rpartition("/")[0], b["fill"].removesuffix("_fill"),
                              b["scope"] + "/" + b["fill"].removesuffix("_fill"))]
    if not progress and len(matches) != 1:
        raise LanguageError("E_REFERENCE", "/target", "Target is missing or ambiguous; use a page-qualified logical ID",
                            suggestions=[s["id"] for s in matches[:5]])
    if len(progress) > 1:
        raise LanguageError("E_REFERENCE", "/target", "Progress target is ambiguous; use its full source pointer")
    bindings = []
    if progress:
        p = progress[0]
        symbol = frontend.resolve(p["fill"], p["scope"], p["pointer"])
        ast = frontend.runtime(p["percent"], p["scope"], p["pointer"], expected="number")
        bindings.append((symbol, ast, p["pointer"], "progress"))
    else:
        symbol = matches[0]
        for logical, scope, expr, path in frontend.value_bindings:
            if logical == symbol["id"]:
                bindings.append((symbol, frontend.runtime(expr, scope, path, expected="text"), path, "text"))
    output = []
    for symbol, ast, pointer, kind in bindings:
        variables, widgets = set(), set()

        def dependencies(value):
            if isinstance(value, dict):
                if value.get("kind") == "variable": variables.add(value["name"])
                if value.get("kind") == "widget": widgets.add(value["name"])
                for child in value.values(): dependencies(child)
            elif isinstance(value, list):
                for child in value: dependencies(child)
        dependencies(ast)
        refresh = []

        def writes(value):
            if isinstance(value, dict):
                if value.get("target") == symbol["name"] and value.get("type") in ("set-text", "set-panel-state"):
                    return True
                return any(writes(v) for v in value.values())
            return isinstance(value, list) and any(writes(v) for v in value)
        for page in lowered["pages"]:
            for interaction in page.get("interactions", []):
                for event in interaction.get("events", []):
                    if writes(event):
                        refresh.append({"page": page["slug"], "trigger": interaction["trigger"], "event": event["event"]})
        output.append({
            "kind": kind, "target": symbol["id"], "nativeName": symbol["name"], "pointer": pointer,
            "expression": ast, "dependencies": {"variables": sorted(variables), "widgets": sorted(widgets)},
            "initialValue": frontend._eval_static_ast(ast), "refreshEvents": refresh,
            "presentation": ({"stepPercent": 10, "fillRange": [0, 100], "zeroFillPixels": 1,
                              "text": "raw expression percentage"} if kind == "progress" else {"type": "text"}),
        })
    return {"ok": True, "target": target, "bindings": output, "semanticHash": ir["semanticHash"],
            "evidence": "compiled-static", "nativePreviewObserved": False,
            "nextAction": "在真实 Axure 预览中修改依赖值、离开并返回页面，核对实际文字及填充。"}


def main():
    import json
    import sys
    import rp_language_cli as cli
    from rp_language import compile_language, patch_spec, _pointer_parts, _array_index
    from rp_dsl import dsl_to_spec
    from pathlib import Path
    request = json.load(sys.stdin)
    source = request["source"]
    if not isinstance(source, str):
        validate_source_tree(source)
    spec = cli.read_source(source) if isinstance(source, str) else copy.deepcopy(source)
    raw = cli._LAST_RAW_RP1_TEXT if isinstance(source, str) else None
    spans = cli._LAST_SPAN_MAP if isinstance(source, str) else {}
    raw_spec = dsl_to_spec(raw) if raw else (json.loads(Path(source).read_text(encoding="utf-8"))
                                           if isinstance(source, str) else copy.deepcopy(source))
    if request["command"] == "diagnose":
        result = diagnose_spec(spec, request.get("limit", 20), spans, raw)
    elif request["command"] == "binding":
        result = explain_binding(spec, request["target"])
    elif request["command"] == "preview-map":
        _, ir = compile_language(spec)
        result = {"ok": True, "semanticHash": ir["semanticHash"],
                  "variables": list(spec.get("variables", {})),
                  "pages": [{"id": p["id"], "name": p.get("name", p["id"])} for p in spec["pages"]],
                  "symbols": [{**s, "context": contextualize({"pointer": s["pointer"]}, spec, spans, raw)}
                              for s in ir["symbols"]]}
    elif request["command"] == "patch":
        import textwrap
        _, ir = compile_language(spec)
        operations = copy.deepcopy(request["operations"])

        def _find_symbol(query, op_idx=0):
            q_str = str(query).strip()
            matches = [s for s in ir["symbols"] if q_str in (s["id"], s["name"], s.get("display"))
                       or s["id"].endswith("/" + q_str)]
            if not matches and "/" in q_str:
                page_part, leaf_part = q_str.split("/", 1)
                leaf_norm = leaf_part.replace(".", "/")
                matches = [s for s in ir["symbols"]
                           if s["id"].startswith(page_part + "/")
                           and (s["id"].endswith("/" + leaf_norm) or s.get("label") == leaf_norm or s.get("display") == leaf_norm)]
            if len(matches) != 1:
                cands = matches if matches else [s for s in ir["symbols"] if q_str.rsplit("/", 1)[-1] in s["id"]]
                raise LanguageError("E_PATCH", f"/operations/{op_idx}/target",
                                    f"Target '{q_str}' missing or ambiguous; use a page-qualified logical ID",
                                    suggestions=[s["id"] for s in cands[:5]])
            return matches[0]

        def _coerce_node_value(val):
            if isinstance(val, str):
                lines = ["rp/1", "page _patch:", "  column _patch_root:"]
                for raw_line in textwrap.dedent(val).splitlines():
                    if raw_line.strip():
                        lines.append("    " + raw_line)
                parsed = dsl_to_spec("\n".join(lines))
                nodes = (parsed["pages"][0].get("root") or {}).get("children") or []
                if not nodes:
                    raise LanguageError("E_PATCH", "/operations", "Empty DSL node snippet")
                return nodes[0] if len(nodes) == 1 else nodes
            return val

        for op_idx, operation in enumerate(operations):
            if ("target" in operation or "parent" in operation) and "path" in operation:
                raise LanguageError("E_PATCH", f"/operations/{op_idx}", "Choose target/property or path, not both")
            raw_op = operation.get("op", "replace")
            if raw_op == "set-token" or ("token" in operation and "path" not in operation and "target" not in operation):
                tok_name = str(operation.pop("token", "")).lstrip("$")
                if not tok_name:
                    raise LanguageError("E_PATCH", f"/operations/{op_idx}", "set-token requires token name")
                operation["op"] = "replace" if isinstance(raw_spec.get("palette"), dict) and tok_name in raw_spec["palette"] else "add"
                operation["path"] = f"/palette/{tok_name}"
                continue
            if "node" in operation and "value" not in operation:
                operation["value"] = operation.pop("node")
            if raw_op in ("add-node", "insert-node", "addNode"):
                operation["op"] = "add"
                if "value" in operation:
                    operation["value"] = _coerce_node_value(operation["value"])
                raw_path_sel = operation.pop("path", None)
                if isinstance(raw_path_sel, str):
                    if raw_path_sel.startswith("after:"):
                        operation["after"] = raw_path_sel[6:]
                    elif raw_path_sel.startswith("before:"):
                        operation["before"] = raw_path_sel[7:]
                    elif not raw_path_sel.startswith("/"):
                        operation["target"] = raw_path_sel
                    else:
                        operation["path"] = raw_path_sel
                        continue
                has_after = "after" in operation
                sibling_ref = operation.pop("after", None) or operation.pop("before", None)
                if sibling_ref:
                    sib = _find_symbol(sibling_ref, op_idx)
                    ptr_parts = sib["pointer"].rsplit("/", 1)
                    if len(ptr_parts) == 2 and ptr_parts[1].isdigit():
                        idx_num = int(ptr_parts[1]) + (1 if has_after else 0)
                        operation["path"] = f"{ptr_parts[0]}/{idx_num}"
                        operation.pop("target", None)
                        operation.pop("parent", None)
                        operation.pop("index", None)
                        continue
                container_ref = operation.pop("parent", None) or operation.pop("target", None)
                idx_arg = operation.pop("index", "-")
                if not container_ref:
                    raise LanguageError("E_PATCH", f"/operations/{op_idx}", "add-node requires target, parent, or after/before")
                page_hits = [i for i, p in enumerate(spec.get("pages", [])) if container_ref in (p.get("id"), p.get("name"))]
                if len(page_hits) == 1:
                    base_ptr = f"/pages/{page_hits[0]}/root"
                else:
                    base_ptr = _find_symbol(container_ref, op_idx)["pointer"]
                operation["path"] = f"{base_ptr}/children/{idx_arg}"
                continue
            elif raw_op in ("remove-node", "delete-node", "removeNode") or (raw_op == "remove" and "target" in operation and "property" not in operation and "value" not in operation):
                operation["op"] = "remove"
                target = operation.pop("target", None) or operation.pop("path", None)
                if not target:
                    raise LanguageError("E_PATCH", f"/operations/{op_idx}", "remove-node requires target")
                operation["path"] = target if str(target).startswith("/") else _find_symbol(target, op_idx)["pointer"]
                continue
            elif raw_op in ("replace-node", "replaceNode"):
                operation["op"] = "replace"
                target = operation.pop("target", None) or operation.pop("path", None)
                if not target or "value" not in operation:
                    raise LanguageError("E_PATCH", f"/operations/{op_idx}", "replace-node requires target and value/node")
                operation["value"] = _coerce_node_value(operation["value"])
                operation["path"] = target if str(target).startswith("/") else _find_symbol(target, op_idx)["pointer"]
                continue
            if "target" not in operation:
                p_str = operation.get("path")
                if isinstance(p_str, str) and not p_str.startswith("/"):
                    if operation.get("op") == "add":
                        if "value" in operation:
                            operation["value"] = _coerce_node_value(operation["value"])
                        if p_str.startswith(("after:", "before:")):
                            is_after = p_str.startswith("after:")
                            sib = _find_symbol(p_str.split(":", 1)[1], op_idx)
                            ptr_parts = sib["pointer"].rsplit("/", 1)
                            if len(ptr_parts) == 2 and ptr_parts[1].isdigit():
                                operation["path"] = f"{ptr_parts[0]}/{int(ptr_parts[1]) + (1 if is_after else 0)}"
                                continue
                        page_hits = [i for i, p in enumerate(spec.get("pages", [])) if p_str in (p.get("id"), p.get("name"))]
                        base_ptr = f"/pages/{page_hits[0]}/root" if len(page_hits) == 1 else _find_symbol(p_str, op_idx)["pointer"]
                        operation["path"] = f"{base_ptr}/children/-"
                        continue
                    elif operation.get("op") == "remove":
                        operation["path"] = _find_symbol(p_str, op_idx)["pointer"]
                        continue
                    elif operation.get("op") == "replace":
                        if "value" in operation:
                            operation["value"] = _coerce_node_value(operation["value"])
                        operation["path"] = _find_symbol(p_str, op_idx)["pointer"]
                        continue
                if operation.get("op") == "add" and isinstance(p_str, str) and "/children/" in p_str and isinstance(operation.get("value"), str):
                    operation["value"] = _coerce_node_value(operation["value"])
                continue
            target = operation.pop("target")
            if not isinstance(operation.get("property"), str) or not operation["property"]:
                raise LanguageError("E_PATCH", f"/operations/{op_idx}", "Logical target requires a nonempty property")
            prop = operation.pop("property")
            sym = _find_symbol(target, op_idx)
            if operation.get("op") == "add" and prop == "children" and not isinstance(operation.get("value"), list):
                operation["value"] = _coerce_node_value(operation["value"])
                operation["path"] = sym["pointer"] + "/children/-"
            elif operation.get("op") == "add" and prop in ("after", "before"):
                operation["value"] = _coerce_node_value(operation["value"])
                ptr_parts = sym["pointer"].rsplit("/", 1)
                if len(ptr_parts) == 2 and ptr_parts[1].isdigit():
                    operation["path"] = f"{ptr_parts[0]}/{int(ptr_parts[1]) + (1 if prop == 'after' else 0)}"
                else:
                    operation["path"] = sym["pointer"] + "/children/-"
            elif prop in ("node", "self"):
                if operation.get("op") != "remove" and "value" in operation:
                    operation["value"] = _coerce_node_value(operation["value"])
                operation["path"] = sym["pointer"]
            else:
                operation["_from_logical_target"] = sym["id"]
                operation["path"] = sym["pointer"] + "/" + prop.replace("~", "~0").replace("/", "~1")
        # Apply edits to the authoring document before expanding numeric tokens.
        # patch_spec then compares checked, resolved documents for accurate impact.
        candidate = copy.deepcopy(raw_spec)
        for index, operation in enumerate(operations):
            from_logical = operation.pop("_from_logical_target", None)
            if set(operation) - {"op", "path", "value", "oldValue"}:
                raise LanguageError("E_PATCH", f"/operations/{index}", "Unknown patch operation property")
            op = operation.get("op", "replace")
            if op not in ("replace", "add", "remove") or (op != "remove" and "value" not in operation):
                raise LanguageError("E_PATCH", f"/operations/{index}", "Expected replace/add with value, or remove")
            parts = _pointer_parts(operation.get("path"), "E_PATCH")
            if not parts:
                raise LanguageError("E_PATCH", f"/operations/{index}", "Patch a property, not the document root")
            parent = candidate
            for p_idx, part in enumerate(parts[:-1]):
                if op == "add" and part == "children" and isinstance(parent, dict) and "children" not in parent and p_idx == len(parts) - 2:
                    parent["children"] = []
                try:
                    parent = parent[_array_index(part, len(parent), operation["path"], "E_PATCH")] if isinstance(parent, list) else parent[part]
                except (KeyError, TypeError):
                    raise LanguageError("E_PATCH", operation["path"], "Patch parent does not exist")
            if not isinstance(parent, (dict, list)):
                raise LanguageError("E_PATCH", operation["path"], "Cannot patch a scalar")
            key = _array_index(parts[-1], len(parent), operation["path"], "E_PATCH", append=op == "add") if isinstance(parent, list) else parts[-1]
            if isinstance(parent, dict) and key not in parent and from_logical and key == "text":
                if from_logical.endswith("_subtitle") and "subtitle" in parent:
                    key = "subtitle"
                elif from_logical.endswith("_tag") and "tag" in parent:
                    key = "tag"
                elif from_logical.endswith("_rbadge") and "rightBadge" in parent:
                    key = "rightBadge"
                elif from_logical.endswith("_right") and "rightText" in parent:
                    key = "rightText"
                elif from_logical.endswith("_body") and "body" in parent:
                    key = "body"
                elif from_logical.endswith("_action") and "actionText" in parent:
                    key = "actionText"
                elif "title" in parent:
                    key = "title"
                elif "label" in parent:
                    key = "label"
                elif "value" in parent:
                    key = "value"
            exists = key < len(parent) if isinstance(parent, list) else key in parent
            if (op != "add" and not exists and not (from_logical and isinstance(parent, dict) and op == "replace" and "oldValue" not in operation)) or ("oldValue" in operation and (not exists or parent[key] != operation["oldValue"])):
                raise LanguageError("E_PATCH_CONFLICT", operation["path"], "Target missing or oldValue does not match source")
            if op == "remove":
                if isinstance(parent, list): parent.pop(key)
                else: del parent[key]
            elif op == "add" and isinstance(parent, list):
                val_copy = copy.deepcopy(operation["value"])
                if isinstance(val_copy, list) and parts[-2:] and parts[-2] == "children":
                    for offset, item in enumerate(val_copy):
                        parent.insert(key + offset, item)
                else:
                    parent.insert(key, val_copy)
            else:
                parent[key] = copy.deepcopy(operation["value"])
        checked_candidate = cli._apply_numeric_tokens(candidate)
        changed_top = [{"op": "remove" if k not in checked_candidate else "replace" if k in spec else "add", "path": "/" + k,
                        **({"value": checked_candidate[k]} if k in checked_candidate else {})}
                       for k in sorted(set(spec) | set(checked_candidate)) if spec.get(k) != checked_candidate.get(k)]
        patched = patch_spec(spec, changed_top or [{"path": "/language", "value": spec["language"]}], expected_hash=request.get("expectedHash"))
        diff_clean = copy.deepcopy(patched["diff"])
        for dk in ("addedSymbols", "removedSymbols", "changedSymbols", "identityChangedSymbols", "propertyChangedSymbols", "behaviorChangedSymbols", "sourceChangedSymbols"):
            if isinstance(diff_clean.get(dk), list):
                diff_clean[dk] = [s for s in diff_clean[dk] if not re.search(r"_(?:fillstate|fill|space)_(?:\d+|s\d+)$", str(s))]
        result = {"ok": True, "spec": candidate, "diff": diff_clean, "operations": operations,
                  "sourceText": cli._emit_rp1_preserving_comments(candidate, raw)
                  if request.get("format") == ".rp1" else json.dumps(candidate, ensure_ascii=False, indent=2) + "\n"}
    elif request["command"] == "restore-tokens":
        merged_path = request["merged"]
        merged_checked = cli.read_source(merged_path)
        merged_raw = cli._LAST_RAW_RP1_TEXT
        merged = dsl_to_spec(merged_raw) if merged_raw else json.loads(Path(merged_path).read_text(encoding="utf-8"))
        restored_count = [0]

        def restore(reference, resolved, target):
            if isinstance(reference, str) and reference.startswith("$") and isinstance(resolved, (int, float)) and not isinstance(resolved, bool) and target == resolved:
                restored_count[0] += 1
                return reference
            if isinstance(reference, dict) and isinstance(target, dict):
                return {k: restore(reference[k], resolved.get(k), value) if k in reference else value for k, value in target.items()}
            if isinstance(reference, list) and isinstance(target, list):
                by_id = {identity: (v, resolved[i]) for i, v in enumerate(reference)
                         if isinstance(identity := _node_identity(v), str)}
                out = []
                for i, value in enumerate(target):
                    identity = _node_identity(value)
                    match = by_id.get(identity) if identity else ((reference[i], resolved[i]) if len(reference) == len(target) else None)
                    out.append(restore(*match, value) if match else value)
                return out
            return target
        restored = restore(raw_spec, spec, merged)
        _, before_ir = compile_language(merged_checked)
        _, after_ir = compile_language(cli._apply_numeric_tokens(restored))
        if before_ir["semanticHash"] != after_ir["semanticHash"]:
            raise LanguageError("E_TOKEN_RESTORE", "/", "Token restoration would change compiled semantics")
        result = {"ok": True, "restoredTokenReferences": restored_count[0],
                  "sourceText": cli._emit_rp1_preserving_comments(restored, merged_raw)
                  if request.get("format") == ".rp1" else json.dumps(restored, ensure_ascii=False, indent=2) + "\n"}
    else:
        raise LanguageError("E_CLI", "/command", "Unknown workflow command")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    import json
    import sys
    try:
        main()
    except LanguageError as error:
        import rp_language_cli as cli
        print(json.dumps({"ok": False, "diagnostics": [contextualize(error.diagnostic, {}, cli._LAST_SPAN_MAP,
                                                                   cli._LAST_RAW_RP1_TEXT)]}, ensure_ascii=False))
    except (KeyError, TypeError) as error:
        print(json.dumps({"ok": False, "diagnostics": [{"code": "E_WORKFLOW_INTERNAL", "pointer": "/",
                                                      "message": str(error), "nextAction": "工作流内部处理失败；原文件保留，请附源码和操作参数报告此问题。"}]}, ensure_ascii=False))
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "diagnostics": [{"code": "E_WORKFLOW_INPUT", "pointer": "/",
                                                      "message": str(error), "nextAction": "检查输入路径、JSON 和参数。"}]}, ensure_ascii=False))
