#!/usr/bin/env python3
"""Language tools use only the Python standard library; rendering is separate."""
import argparse
import json
from pathlib import Path
import sys
from rp_language import (
    compile_language, LanguageError, EVENTS,
    explore_state_space, inspect_spec, explain_spec, complete_spec,
    simulate_spec, patch_spec, auto_heal_spec,
)
from rp_schema import language_schema


from rp_dsl import dsl_to_spec, spec_to_dsl, format_dsl

_LAST_SPAN_MAP = {}


class LanguageParser(argparse.ArgumentParser):
    def error(self, message):
        raise LanguageError("E_CLI", "/arguments", message)


def read_source(path):
    global _LAST_SPAN_MAP
    text = Path(path).read_text(encoding="utf-8")
    if str(path).endswith(".rp1"):
        spec, spans = dsl_to_spec(text, return_spans=True)
        _LAST_SPAN_MAP = spans
        return spec

    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise LanguageError("E_DUPLICATE_PROPERTY", "/", f"Duplicate JSON property '{key}'")
            value[key] = item
        return value
    try:
        _LAST_SPAN_MAP = {}
        return json.loads(text, object_pairs_hook=pairs,
                          parse_constant=lambda v: (_ for _ in ()).throw(LanguageError("E_JSON_NUMBER", "/", f"Non-finite JSON number {v}")))
    except json.JSONDecodeError as error:
        issue = LanguageError("E_JSON_SYNTAX", "/", error.msg)
        issue.diagnostic.update(line=error.lineno, column=error.colno)
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
    for name in ("check", "auto-heal", "format", "schema", "explore", "inspect", "explain", "complete", "simulate", "patch", "dsl-to-json", "json-to-dsl", "dsl-format", "decompile", "lift-rp"):
        command = commands.add_parser(name)
        if name == "decompile":
            command.add_argument("--rp", required=True, help="Binary .rp file to decompile into .rp1 / JSON AST")
            command.add_argument("--out", "-o", required=False, help="New output file (.rp1 or .json)")
            continue
        if name == "lift-rp":
            command.add_argument("--spec", required=True, help="Base .rp1 or .json spec")
            command.add_argument("--base-rp", required=True, help="Baseline binary .rp file")
            command.add_argument("--gui-rp", required=True, help="GUI-edited binary .rp file")
            command.add_argument("--out", "-o", required=False, help="New output file (.rp1 or .json)")
            continue
        if name != "schema":
            command.add_argument("--spec", required=True)
        if name != "check":
            command.add_argument("--out", "-o", required=name == "patch", help="New output file; existing files are never overwritten")
        else:
            command.add_argument("--auto-heal", action="store_true")
            command.add_argument("--out", "-o", required=False, help="New output file when --auto-heal is used")
        if name in ("inspect", "explain"):
            command.add_argument("--target", required=name == "explain")
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
    return parser.parse_args()


def main():
    args = parse_args()
    if args.command == "schema":
        result = language_schema()
    elif args.command == "decompile":
        from rp_decompile import decompile_rp
        dec = decompile_rp(args.rp)
        if getattr(args, "out", None):
            out_val = dec["rp1"] if str(args.out).endswith(".rp1") else dec["spec"]
            print(json.dumps({"ok": True, "output": write_new(args.out, out_val), "pageCount": dec["pageCount"], "variableCount": dec["variableCount"]}))
            return 0
        result = {"ok": True, **dec}
    elif args.command == "lift-rp":
        from rp_decompile import lift_rp_into_spec
        source = read_source(args.spec)
        lifted = lift_rp_into_spec(source, args.base_rp, args.gui_rp)
        if getattr(args, "out", None):
            out_val = lifted["rp1"] if str(args.out).endswith(".rp1") else lifted["spec"]
            print(json.dumps({"ok": True, "output": write_new(args.out, out_val), "liftedTextEdits": lifted["liftedTextEdits"], "liftedInteractions": lifted["liftedInteractions"], "liftedNewWidgets": lifted["liftedNewWidgets"]}))
            return 0
        result = lifted
    else:
        source = read_source(args.spec)
        if args.command == "dsl-to-json":
            result = source
        elif args.command in ("json-to-dsl", "dsl-format"):
            dsl_out = spec_to_dsl(source)
            if getattr(args, "check", False):
                matches = Path(args.spec).read_text(encoding="utf-8") == dsl_out
                print(json.dumps({"ok": matches, "formatted": matches}))
                return 0 if matches else 1
            if args.out:
                print(json.dumps({"ok": True, "output": write_new(args.out, dsl_out)}))
                return 0
            print(dsl_out, end="")
            return 0
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
            result = patch_spec(source, read_source(args.operations), expected_hash=args.expected_hash)
            out_val = spec_to_dsl(result["spec"]) if str(args.out).endswith(".rp1") else result["spec"]
            output = write_new(args.out, out_val)
            print(json.dumps({"ok": True, "output": output, "diff": result["diff"]}, ensure_ascii=False, indent=2))
            return 0
        elif args.command == "auto-heal" or (args.command == "check" and getattr(args, "auto_heal", False)):
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
                out_val = spec_to_dsl(healed["spec"]) if str(args.out).endswith(".rp1") else healed["spec"]
                result["output"] = write_new(args.out, out_val)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        else:
            _, ir = compile_language(source)
            if args.command == "check":
                result = {"ok": True, "language": "rp/1", "target": 9, "irVersion": ir["irVersion"], "pages": len(ir["pages"]), "symbols": len(ir["symbols"]), "semanticHash": ir["semanticHash"], "diagnostics": []}
            else:
                if args.check and args.out:
                    raise LanguageError("E_CLI", "/arguments", "format --check cannot be combined with --out")
                is_rp1 = str(args.spec).endswith(".rp1")
                formatted = spec_to_dsl(source) if is_rp1 else (json.dumps(source, ensure_ascii=False, indent=2) + "\n")
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
        print(json.dumps({"ok": False, "language": "rp/1", "diagnostics": [error.diagnostic]}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    except (OSError, UnicodeError) as error:
        print(json.dumps({"ok": False, "language": "rp/1", "diagnostics": [{"code": "E_SOURCE_IO", "pointer": "/", "severity": "error", "message": str(error)}]}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
