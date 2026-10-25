#!/usr/bin/env python3
"""Language tools use only the Python standard library; rendering is separate."""
import argparse
import copy
import json
from pathlib import Path
import sys
import tempfile
from rp_language import (
    compile_language, LanguageError, EVENTS,
    explore_state_space, inspect_spec, explain_spec, complete_spec,
    simulate_spec, patch_spec, auto_heal_spec, validate_source_tree,
)
from rp_schema import language_schema


from rp_dsl import dsl_to_spec, spec_to_dsl, format_dsl, preserve_rp1_comments

_LAST_SPAN_MAP = {}
_LAST_RAW_RP1_TEXT = None


class LanguageParser(argparse.ArgumentParser):
    def error(self, message):
        raise LanguageError("E_CLI", "/arguments", message)



def _apply_numeric_tokens(spec):
    """把 "$font.h1" 这类引用替换为 tokens 里声明过的数值；颜色等非数值令牌保持原样。"""
    if not isinstance(spec, dict):
        return spec
    toks = spec.get("tokens")
    if not isinstance(toks, dict) or not toks:
        return spec
    flat = {}

    def walk(node, prefix=""):
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, prefix + ("." if prefix else "") + str(key))
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            flat[prefix] = node

    walk(toks)

    def sub(node):
        if isinstance(node, dict):
            return {k: sub(v) for k, v in node.items()}
        if isinstance(node, list):
            return [sub(v) for v in node]
        if isinstance(node, str) and node.startswith("$"):
            hit = flat.get(node[1:])
            if isinstance(hit, (int, float)) and not isinstance(hit, bool):
                return hit
        return node

    return sub(spec)

def read_source(path):
    global _LAST_SPAN_MAP, _LAST_RAW_RP1_TEXT
    text = Path(path).read_text(encoding="utf-8")
    if str(path).endswith(".rp1"):
        _LAST_RAW_RP1_TEXT = text
        try:
            spec, spans = dsl_to_spec(text, return_spans=True)
        except RecursionError:
            raise LanguageError("E_DEPTH", "/", "Source nesting exceeds the DSL parser depth limit")
        _LAST_SPAN_MAP = spans
        validate_source_tree(spec)
        return _apply_numeric_tokens(spec)

    _LAST_RAW_RP1_TEXT = None

    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise LanguageError("E_DUPLICATE_PROPERTY", "/", f"Duplicate JSON property '{key}'")
            value[key] = item
        return value
    try:
        _LAST_SPAN_MAP = {}
        _loaded = json.loads(text, object_pairs_hook=pairs,
                          parse_constant=lambda v: (_ for _ in ()).throw(LanguageError("E_JSON_NUMBER", "/", f"Non-finite JSON number {v}")))
        validate_source_tree(_loaded)
        return _apply_numeric_tokens(_loaded)
    except RecursionError:
        raise LanguageError("E_DEPTH", "/", "Source nesting exceeds the JSON parser depth limit")
    except json.JSONDecodeError as error:
        issue = LanguageError("E_JSON_SYNTAX", "/", error.msg)
        issue.diagnostic.update(line=error.lineno, column=error.colno, sourceSpan={"line": error.lineno, "column": error.colno})
        raise issue


def write_new(path, value):
    try:
        with open(path, "x", encoding="utf-8") as output:
            output.write(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    except FileExistsError:
        raise LanguageError("E_OUTPUT_EXISTS", "/arguments/out", f"Output already exists: {path}")
    return str(Path(path).resolve())


def validate_steps(steps):
    if not isinstance(steps, list):
        raise LanguageError("E_TYPE", "/steps", "Expected an array of simulation steps")
    for index, step in enumerate(steps):
        pointer = f"/steps/{index}"
        if not isinstance(step, dict):
            raise LanguageError("E_OBJECT", pointer, "Simulation step must be an object")
        allowed = {"input", "value"} if "input" in step else {"target", "trigger", "event", "rowIndex"}
        for key in step:
            if key not in allowed:
                raise LanguageError("E_PROPERTY", pointer + "/" + key, f"Unknown simulation property '{key}'")
        target = step.get("input") if "input" in step else step.get("target", step.get("trigger"))
        if not isinstance(target, str) or not target:
            raise LanguageError("E_REFERENCE", pointer, "Simulation step requires an input or target name")
        if "target" in step and "trigger" in step:
            raise LanguageError("E_PROPERTY", pointer + "/trigger", "Use target or trigger, not both")
        if "value" in step and not isinstance(step["value"], str):
            raise LanguageError("E_TYPE", pointer + "/value", "Input value must be text")
        if "event" in step and (not isinstance(step["event"], str) or step["event"] not in set(EVENTS) | set(EVENTS.values())):
            raise LanguageError("E_EVENT", pointer + "/event", "Unknown simulation event")
        if "rowIndex" in step and (type(step["rowIndex"]) is not int or step["rowIndex"] < 0):
            raise LanguageError("E_TYPE", pointer + "/rowIndex", "rowIndex must be a nonnegative integer")
    return steps


def parse_args():
    parser = LanguageParser(description="RP/1 language tools; inspect/explore/simulate are reference-model tools, not native behavior proof")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=LanguageParser)
    for name in ("check", "diagnose", "binding", "auto-heal", "format", "schema", "explore", "inspect", "explain", "complete", "simulate", "patch", "dsl-to-json", "json-to-dsl", "dsl-format", "decompile", "lift-rp"):
        command = commands.add_parser(name)
        if name == "decompile":
            command.add_argument("--rp", required=False, help="Binary .rp file to decompile into .rp1 / JSON AST")
            command.add_argument("rp_pos", nargs="?", help="Optional positional binary .rp file")
            command.add_argument("--out", "-o", required=False, help="New output file (.rp1 or .json)")
            continue
        if name == "lift-rp":
            command.add_argument("--spec", required=True, help="Base .rp1 or .json spec")
            command.add_argument("--base-rp", required=True, help="Baseline binary .rp file")
            command.add_argument("--gui-rp", required=True, help="GUI-edited binary .rp file")
            command.add_argument("--out", "-o", required=False, help="New output file (.rp1 or .json)")
            continue
        if name != "schema":
            command.add_argument("--spec", required=False)
            command.add_argument("spec_pos", nargs="?", help="Optional positional .rp1 or .json spec file")
        if name != "check":
            command.add_argument("--out", "-o", required=name == "patch", help="New output file; existing files are never overwritten")
        else:
            command.add_argument("--auto-heal", action="store_true")
            command.add_argument("--out", "-o", required=False, help="New output file when --auto-heal is used")
        if name in ("inspect", "explain", "binding"):
            command.add_argument("--target", required=name in ("explain", "binding"))
        if name == "diagnose":
            command.add_argument("--limit", type=int, default=20, choices=range(1, 51))
        if name == "complete":
            command.add_argument("--pointer", default="/")
        if name == "explore":
            command.add_argument("--max-depth", type=int, default=5)
            command.add_argument("--max-states", type=int, default=48)
        if name in ("format", "dsl-format"):
            command.add_argument("--check", action="store_true")
        if name == "simulate":
            command.add_argument("--steps", help="JSON array of input or target/event steps; omitted means initial state")
        if name == "patch":
            command.add_argument("--operations", required=True, help="JSON array of source patch operations")
            command.add_argument("--expected-hash", help="Expected source semanticHash precondition")
    parsed = parser.parse_args()
    if parsed.command == "decompile":
        if not getattr(parsed, "rp", None) and getattr(parsed, "rp_pos", None):
            parsed.rp = parsed.rp_pos
        if not getattr(parsed, "rp", None):
            raise LanguageError("E_CLI", "/arguments", "the following arguments are required: --rp")
    elif parsed.command not in ("schema", "lift-rp"):
        if not getattr(parsed, "spec", None) and getattr(parsed, "spec_pos", None):
            parsed.spec = parsed.spec_pos
        if not getattr(parsed, "spec", None):
            raise LanguageError("E_CLI", "/arguments", "the following arguments are required: --spec")
    return parsed


def _emit_rp1_preserving_comments(spec, raw_rp1_text=None):
    dsl_out = spec_to_dsl(spec)
    if raw_rp1_text:
        return preserve_rp1_comments(raw_rp1_text, dsl_out)
    return dsl_out


def main():
    args = parse_args()
    if args.command == "schema":
        result = language_schema()
    elif args.command == "decompile":
        if getattr(args, "out", None) and not (str(args.out).endswith(".rp1") or str(args.out).endswith(".json")):
            raise LanguageError("E_CLI", "/arguments/out", f"Unsupported output extension for decompile: {args.out} (expected .rp1 or .json)")
        from rp_decompile import decompile_rp
        dec = decompile_rp(args.rp)
        if not dec.get("ok"):
            print(json.dumps(dec, ensure_ascii=False))
            return 1
        if getattr(args, "out", None):
            out_val = dec["rp1"] if str(args.out).endswith(".rp1") else dec["spec"]
            print(json.dumps({"ok": True, "output": write_new(args.out, out_val), "pageCount": dec["pageCount"], "variableCount": dec["variableCount"]}))
            return 0
        result = {"ok": True, **dec}
    elif args.command == "lift-rp":
        if getattr(args, "out", None) and not (str(args.out).endswith(".rp1") or str(args.out).endswith(".json")):
            raise LanguageError("E_CLI", "/arguments/out", f"Unsupported output extension for lift-rp: {args.out} (expected .rp1 or .json)")
        from rp_decompile import lift_rp_into_spec
        source = read_source(args.spec)
        raw_rp1 = _LAST_RAW_RP1_TEXT
        lifted = lift_rp_into_spec(source, args.base_rp, args.gui_rp, original_dsl_text=raw_rp1)
        if not lifted.get("ok"):
            print(json.dumps(lifted, ensure_ascii=False))
            return 1
        if getattr(args, "out", None):
            out_val = lifted["rp1"] if str(args.out).endswith(".rp1") else lifted["spec"]
            print(json.dumps({
                "ok": True,
                "output": write_new(args.out, out_val),
                "report": lifted["report"],
                "liftedTextEdits": lifted["liftedTextEdits"],
                "liftedRenames": lifted["liftedRenames"],
                "liftedVisualEdits": lifted["liftedVisualEdits"],
                "liftedInteractions": lifted["liftedInteractions"],
                "liftedNewWidgets": lifted["liftedNewWidgets"],
                "liftedComponentInstances": lifted["liftedComponentInstances"],
                "unsupportedNativeChanges": lifted["unsupportedNativeChanges"],
            }, ensure_ascii=False))
            return 0
        result = lifted
    else:
        if args.command == "dsl-to-json" and not str(args.spec).endswith(".rp1"):
            raise LanguageError("E_CLI", "/arguments/spec", f"dsl-to-json requires a .rp1 DSL input file, got: {args.spec}")
        source = read_source(args.spec)
        raw_rp1 = _LAST_RAW_RP1_TEXT
        if args.command == "dsl-to-json":
            if getattr(args, "out", None) and not str(args.out).endswith(".json"):
                raise LanguageError("E_CLI", "/arguments/out", "dsl-to-json outputs JSON and requires a .json output file")
            compile_language(copy.deepcopy(source))
            result = source
        elif args.command in ("json-to-dsl", "dsl-format"):
            if getattr(args, "out", None) and not str(args.out).endswith(".rp1"):
                raise LanguageError("E_CLI", "/arguments/out", f"{args.command} outputs .rp1 DSL and requires a .rp1 output file")
            compile_language(copy.deepcopy(source))
            dsl_out = _emit_rp1_preserving_comments(source, raw_rp1)
            if getattr(args, "check", False):
                matches = Path(args.spec).read_text(encoding="utf-8") == dsl_out
                print(json.dumps({"ok": matches, "formatted": matches}))
                return 0 if matches else 1
            if args.out:
                print(json.dumps({"ok": True, "output": write_new(args.out, dsl_out)}))
                return 0
            print(dsl_out, end="")
            return 0
        elif args.command == "diagnose":
            from rp_workflow import diagnose_spec
            result = diagnose_spec(source, args.limit, _LAST_SPAN_MAP, raw_rp1)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if result["ok"] else 1
        elif args.command == "binding":
            from rp_workflow import explain_binding
            result = explain_binding(source, args.target)
        elif args.command == "explore":
            if args.max_depth < 0 or args.max_states < 1:
                raise LanguageError("E_CLI", "/arguments", "max-depth must be nonnegative and max-states must be positive")
            result = {"ok": True, **explore_state_space(source, max_depth=args.max_depth, max_states=args.max_states)}
        elif args.command == "inspect":
            result = {"ok": True, **inspect_spec(source, target=args.target)}
        elif args.command == "explain":
            result = {"ok": True, **explain_spec(source, target=args.target)}
        elif args.command == "complete":
            result = {"ok": True, **complete_spec(source, pointer=args.pointer)}
        elif args.command == "simulate":
            steps = validate_steps(read_source(args.steps)) if args.steps else []
            result = {"ok": True, **simulate_spec(source, steps=steps)}
        elif args.command == "patch":
            if not (str(args.out).endswith(".rp1") or str(args.out).endswith(".json")):
                raise LanguageError("E_CLI", "/arguments/out", f"Unsupported output extension for patch: {args.out} (expected .rp1 or .json)")
            result = patch_spec(source, read_source(args.operations), expected_hash=args.expected_hash)
            out_val = _emit_rp1_preserving_comments(result["spec"], raw_rp1) if str(args.out).endswith(".rp1") else result["spec"]
            output = write_new(args.out, out_val)
            print(json.dumps({"ok": True, "output": output, "diff": result["diff"]}, ensure_ascii=False, indent=2))
            return 0
        elif args.command == "auto-heal" or (args.command == "check" and getattr(args, "auto_heal", False)):
            if getattr(args, "out", None) and not (str(args.out).endswith(".rp1") or str(args.out).endswith(".json")):
                raise LanguageError("E_CLI", "/arguments/out", f"Unsupported output extension for auto-heal: {args.out} (expected .rp1 or .json)")
            healed = auto_heal_spec(source)
            ir = healed["ir"]
            result = {
                "ok": True,
                "healed": healed["healed"],
                "rounds": healed["rounds"],
                "appliedPatches": healed["appliedPatches"],
                "language": "rp/1",
                "target": 9,
                "irVersion": ir["irVersion"],
                "pages": len(ir["pages"]),
                "symbols": len(ir["symbols"]),
                "semanticHash": ir["semanticHash"],
                "diagnostics": [],
            }
            if getattr(args, "out", None):
                out_val = _emit_rp1_preserving_comments(healed["spec"], raw_rp1) if str(args.out).endswith(".rp1") else healed["spec"]
                result["output"] = write_new(args.out, out_val)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        else:
            _, ir = compile_language(copy.deepcopy(source))
            if args.command == "check":
                layout_diags = []
                structural_ok = True
                aesthetic_ok = True
                warnings = []
                is_ok = True
                if not getattr(sys.flags, "no_site", 0):
                    from proto import compile_spec_bundle, _build_layout_diagnostics
                    spec_abs = str(Path(args.spec).resolve())
                    with tempfile.TemporaryDirectory(prefix="rp1-check-") as tmp_dir:
                        bundle_res = compile_spec_bundle(
                            copy.deepcopy(source),
                            tmp_dir,
                            base_dir=str(Path(spec_abs).parent),
                            source_path=spec_abs,
                        )
                    layout_diags = _build_layout_diagnostics(bundle_res, ir)
                    structural_ok = bool(bundle_res.get("structural_ok", True))
                    aesthetic_ok = bool(bundle_res.get("aesthetic_ok", True))
                    warnings = bundle_res.get("warnings", [])
                    is_ok = bool(bundle_res.get("ok", True)) and len(layout_diags) == 0
                result = {
                    "ok": is_ok,
                    "structural_ok": structural_ok,
                    "aesthetic_ok": aesthetic_ok,
                    "warnings": warnings,
                    "language": "rp/1",
                    "target": 9,
                    "irVersion": ir["irVersion"],
                    "pages": len(ir["pages"]),
                    "symbols": len(ir["symbols"]),
                    "semanticHash": ir["semanticHash"],
                    "diagnostics": layout_diags,
                }
                if getattr(args, "out", None):
                    print(json.dumps({"ok": is_ok, "output": write_new(args.out, result)}))
                else:
                    print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0 if is_ok else 1
            else:
                if args.check and args.out:
                    raise LanguageError("E_CLI", "/arguments", "format --check cannot be combined with --out")
                target_path = str(args.out) if args.out else str(args.spec)
                if args.out and not (target_path.endswith(".rp1") or target_path.endswith(".json")):
                    raise LanguageError("E_CLI", "/arguments/out", f"Unsupported output extension for format: {args.out} (expected .rp1 or .json)")
                is_rp1 = target_path.endswith(".rp1")
                formatted = _emit_rp1_preserving_comments(source, raw_rp1) if is_rp1 else (json.dumps(source, ensure_ascii=False, indent=2) + "\n")
                if args.check:
                    matches = Path(args.spec).read_text(encoding="utf-8") == formatted
                    print(json.dumps({"ok": matches, "formatted": matches}))
                    return 0 if matches else 1
                if args.out:
                    print(json.dumps({"ok": True, "output": write_new(args.out, formatted)}))
                    return 0
                print(formatted, end="")
                return 0
    if getattr(args, "out", None):
        print(json.dumps({"ok": True, "output": write_new(args.out, result)}))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except LanguageError as error:
        if _LAST_SPAN_MAP and "sourceSpan" not in error.diagnostic:
            p = error.diagnostic.get("pointer", "/")
            cur = p
            while cur:
                if cur in _LAST_SPAN_MAP:
                    error.diagnostic["sourceSpan"] = _LAST_SPAN_MAP[cur]
                    break
                cur = cur.rpartition("/")[0]
            if "sourceSpan" not in error.diagnostic and "/" in _LAST_SPAN_MAP:
                error.diagnostic["sourceSpan"] = _LAST_SPAN_MAP["/"]
        if "sourceSpan" in error.diagnostic and isinstance(error.diagnostic["sourceSpan"], dict):
            error.diagnostic.setdefault("line", error.diagnostic["sourceSpan"].get("line"))
            error.diagnostic.setdefault("column", error.diagnostic["sourceSpan"].get("column"))
        elif "line" in error.diagnostic and "column" in error.diagnostic:
            error.diagnostic["sourceSpan"] = {"line": error.diagnostic["line"], "column": error.diagnostic["column"]}
        print(json.dumps({"ok": False, "language": "rp/1", "diagnostics": [error.diagnostic]}, ensure_ascii=False))
        sys.exit(1)
    except (OSError, UnicodeError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "language": "rp/1", "diagnostics": [{"code": "E_SOURCE_IO", "pointer": "/", "severity": "error", "message": str(error)}]}, ensure_ascii=False))
        sys.exit(1)
