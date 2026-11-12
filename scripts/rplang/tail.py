# 从 scripts/rp_language.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 2;行为不变,勿手改)。
from rp_product import expand_product_spec, compute_product_impact
import copy
import hashlib
import math
import re
from .core import ACTION_PROPS, COLOR_TOKENS, EVENTS, EVENT_SHORTHANDS, GEOMETRY, LanguageError, MACRO_PROPS, NODE_PROPS, SHORTHAND_NODE_KINDS, THEMES, _array_index, _pointer_parts, _resolve_pointer, fail, fields, ident, ptr
from .frontend import Frontend, compile_language
from .runtime import ReferenceRuntime

def simulate_spec(spec, steps=None):
    rt = ReferenceRuntime(spec)
    trace = [{"step": 0, "state": rt.snapshot()}]
    for idx, step in enumerate(steps or [], 1):
        if "input" in step:
            fired = rt.set_input(step["input"], step.get("value", ""))
        else:
            fired = rt.trigger(step.get("target", step.get("trigger")), step.get("event", "click"),
                               row_index=step.get("rowIndex", 0))
        trace.append({"step": idx, "action": step, "fired": fired, "state": rt.snapshot()})
    return {"final": rt.snapshot(), "trace": trace, "executionTrace": rt.execution_trace,
            "limitations": {"referenceModel": "per-row and template-level widgets; native host behavior verified via expr.js oracle",
                            "perRowWidgetState": True, "eventDepthLimit": 64, "caseFiringLimit": 10000}}


def explore_state_space(spec, max_depth=5, max_states=48, input_samples=None):
    """Bounded BFS over execution states; display snapshots are not deduplication keys."""
    if type(max_depth) is not int or max_depth < 0:
        fail("E_ARGUMENT", "/maxDepth", "maxDepth must be a nonnegative integer")
    if type(max_states) is not int or max_states < 1:
        fail("E_ARGUMENT", "/maxStates", "maxStates must be a positive integer")
    compiled = compile_language(spec)
    _, ir = compiled
    json_mod = __import__("json")
    total_pages = [p["slug"] for p in ir["pages"]]
    total_panel_states = {(s["name"], st) for s in ir["symbols"] if s["kind"] == "dynamic-panel" for st in s.get("states", [])}
    total_interactions, total_cases = set(), set()
    for p in ir["pages"]:
        for ix in p["interactions"]:
            for ev in ix.get("events", []):
                total_interactions.add((p["slug"], ix["trigger"], ev["event"]))
                total_cases.update((p["slug"], ix["trigger"], ev["event"], idx) for idx in range(len(ev.get("cases", []))))

    def state_hash(rt):
        return hashlib.sha256(json_mod.dumps(rt.execution_state(), sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    init_rt = ReferenceRuntime(compiled)
    init_id = state_hash(init_rt)
    visited = {init_id: {"id": init_id, "depth": 0, "snapshot": init_rt.snapshot(), "path": []}}
    transitions, execution_trace = [], []
    covered_pages, covered_panel_states, covered_interactions, covered_cases = set(), set(), set(), set()
    shortest_to_page, shortest_to_panel_state = {}, {}
    invariant_violations = []
    seen_violations = set()
    user_invariants = ir.get("invariants", [])
    comp_meta = ir.get("computedMeta", {})
    checked_invariant_ids = ["no_runtime_nan_or_null", "statechart_valid_states"]
    if comp_meta:
        checked_invariant_ids.append("computed_aggregates_consistent")
    checked_invariant_ids.extend(inv["id"] for inv in user_invariants)

    def check_invariants(rt, state_id, path):
        for vk, vv in rt.variables.items():
            if vv is None or (isinstance(vv, float) and math.isnan(vv)) or str(vv) in ("NaN", "undefined"):
                vkey = ("no_runtime_nan_or_null", vk)
                if vkey not in seen_violations:
                    seen_violations.add(vkey)
                    invariant_violations.append({
                        "invariant": "no_runtime_nan_or_null",
                        "message": f"Variable '{vk}' has invalid runtime value '{vv}'",
                        "stateId": state_id, "counterexamplePath": path, "snapshot": rt.snapshot(),
                    })
        for pname, pinfo in rt.panels.items():
            if pinfo["states"] and pinfo["current"] not in pinfo["states"]:
                vkey = ("statechart_valid_states", pname)
                if vkey not in seen_violations:
                    seen_violations.add(vkey)
                    invariant_violations.append({
                        "invariant": "statechart_valid_states",
                        "message": f"Panel '{pname}' entered undeclared state '{pinfo['current']}'",
                        "stateId": state_id, "counterexamplePath": path, "snapshot": rt.snapshot(),
                    })
        for agg in comp_meta.get("aggregates", []):
            expected_sum = 0
            target_rows = rt.repeaters[agg["repeaterName"]]["rows"] if agg.get("scope") == "dataset" else rt.visible_rows(agg["repeaterName"])
            for r in target_rows:
                if agg.get("whereAst") is None or bool(rt.eval_expr(agg["whereAst"], row=r)):
                    expected_sum += rt.eval_expr(agg["valAst"], row=r)
            if isinstance(expected_sum, float) and expected_sum.is_integer():
                expected_sum = int(expected_sum)
            actual_val = rt.variables.get(agg["name"])
            if actual_val != expected_sum:
                vkey = ("computed_aggregates_consistent", agg["name"])
                if vkey not in seen_violations:
                    seen_violations.add(vkey)
                    invariant_violations.append({
                        "invariant": "computed_aggregates_consistent",
                        "message": f"Aggregate '{agg['name']}' is {actual_val}, expected {expected_sum}",
                        "stateId": state_id, "counterexamplePath": path, "snapshot": rt.snapshot(),
                    })
        for inv in user_invariants:
            if not bool(rt.eval_expr(inv["ast"])):
                vkey = (inv["id"],)
                if vkey not in seen_violations:
                    seen_violations.add(vkey)
                    invariant_violations.append({
                        "invariant": inv["id"],
                        "message": inv.get("message", inv["id"]),
                        "pointer": inv.get("pointer", "/invariants"),
                        "stateId": state_id, "counterexamplePath": path, "snapshot": rt.snapshot(),
                    })

    def record(rt, path, trace_start=0, state_id=init_id):
        covered_pages.add(rt.current_page)
        shortest_to_page.setdefault(rt.current_page, path)
        for name, panel in rt.panels.items():
            if rt.is_operable(name, check_enabled=False):
                covered_panel_states.add((name, panel["current"]))
                shortest_to_panel_state.setdefault(f"{name}:{panel['current']}", path)
        for entry in rt.execution_trace[trace_start:]:
            covered_interactions.add((entry["page"], entry["trigger"], entry["event"]))
            covered_cases.add((entry["page"], entry["trigger"], entry["event"], entry["case"]))
            execution_trace.append({**entry, "path": path})
        check_invariants(rt, state_id, path)

    record(init_rt, [], 0, init_id)
    queue = [(init_rt, [], init_id)]
    state_bound = depth_bound = row_sampling = input_sampling = False
    while queue:
        rt, path, cur_id = queue.pop(0)
        page = rt.pages_by_slug[rt.current_page]
        candidate_steps = []
        for wname, winfo in rt.widgets.items():
            if winfo["kind"] == "input" and rt.is_operable(wname):
                samples = (input_samples or {}).get(wname) or (input_samples or {}).get(rt.symbols_by_name.get(wname, {}).get("id", "").rsplit("/", 1)[-1]) or ["sample_val", ""]
                input_sampling = input_sampling or len(samples) > 2
                for value in samples[:2]:
                    if str(value) != winfo["text"]: candidate_steps.append({"input": wname, "value": value})
        for ix in page["interactions"]:
            trigger = ix["trigger"]
            if trigger == "page" or not rt.is_operable(trigger): continue
            widget = rt.widgets[trigger]
            for ev in ix.get("events", []):
                event = ev["event"]
                if event in {"OnLoad", "OnItemLoad", "OnTextChange", "OnPanelStateChange"}: continue
                count = len(rt.visible_rows(widget["repeater"])) if widget.get("repeater") else 1
                row_sampling = row_sampling or count > 2
                for row_index in range(min(2, count)):
                    candidate_steps.append({"target": trigger, "event": event, "rowIndex": row_index})
        if len(path) >= max_depth:
            depth_bound = depth_bound or bool(candidate_steps)
            continue
        for step in candidate_steps:
            next_rt = copy.deepcopy(rt)
            trace_start = len(next_rt.execution_trace)
            if "input" in step: next_rt.set_input(step["input"], step["value"])
            else: next_rt.trigger(step["target"], step["event"], row_index=step["rowIndex"])
            next_id = state_hash(next_rt)
            new_path = path + [step]
            record(next_rt, new_path, trace_start, next_id)
            transitions.append({"from": cur_id, "to": next_id, "step": step, "firedCount": len(next_rt.execution_trace) - trace_start})
            if next_id not in visited:
                if len(visited) >= max_states:
                    state_bound = True
                    break
                visited[next_id] = {"id": next_id, "depth": len(new_path), "snapshot": next_rt.snapshot(), "path": new_path}
                queue.append((next_rt, new_path, next_id))
        if state_bound: break
    return {
        "statesExplored": len(visited), "transitionsExplored": len(transitions),
        "truncatedByBudget": state_bound or depth_bound or row_sampling or input_sampling,
        "budget": {"maxDepth": max_depth, "maxStates": max_states, "rowSampleLimit": 2, "inputSampleLimit": 2},
        "limitations": {"depthBoundReached": depth_bound, "stateBoundReached": state_bound,
                        "rowSamplingApplied": row_sampling, "inputSamplingApplied": input_sampling,
                        "rowSampleLimit": 2, "inputSampleLimit": 2, "exhaustive": False,
                        "referenceModel": "template-level widgets; native host behavior requires separate verification"},
        "coverage": {
            "pages": {"covered": len(covered_pages), "total": len(total_pages)},
            "panelStates": {"covered": len(covered_panel_states), "total": len(total_panel_states)},
            "interactions": {"covered": len(covered_interactions), "total": len(total_interactions)},
            "cases": {"covered": len(covered_cases), "total": len(total_cases)},
        },
        "invariants": {
            "ok": len(invariant_violations) == 0,
            "checkedCount": len(checked_invariant_ids),
            "checked": checked_invariant_ids,
            "violations": invariant_violations,
        },
        "executionTrace": execution_trace,
        "shortestPaths": {"pages": shortest_to_page, "panelStates": shortest_to_panel_state},
        "states": list(visited.values()),
    }








def inspect_spec(spec, target=None):
    """Inspect semantic structure, symbol lineage, and variable/widget dependency graph."""
    fe = Frontend(spec)
    lowered, ir = fe.compile()
    by_id = {s["id"]: s for s in ir["symbols"]}
    by_name = {s["name"]: s for s in ir["symbols"]}
    by_ptr = {s["pointer"]: s for s in ir["symbols"]}
    var_readers = {k: set() for k in ir["variables"]}
    var_writers = {k: set() for k in ir["variables"]}
    widget_readers, widget_writers = {}, {}

    def scan_rt(ast, owner):
        if not isinstance(ast, dict):
            return
        if ast.get("kind") == "variable" and ast.get("name") in var_readers:
            var_readers[ast["name"]].add(owner)
        elif ast.get("kind") == "widget" and ast.get("name"):
            widget_readers.setdefault(ast["name"], set()).add(owner)
        for v in ast.values():
            if isinstance(v, dict): scan_rt(v, owner)
            elif isinstance(v, list):
                for item in v:
                    if isinstance(item, dict): scan_rt(item, owner)

    for p in ir["pages"]:
        for ix in p["interactions"]:
            trig = ix["trigger"]
            for ev in ix.get("events", []):
                for case in ev.get("cases", []):
                    owner_trig = case.get("bridgeCaller") or trig
                    if "when" in case:
                        scan_rt(case["when"], owner_trig)
                    for act in case.get("actions", []):
                        if "runtime" in act:
                            scan_rt(act["runtime"], owner_trig)
                        if "predicate" in act:
                            scan_rt(act["predicate"], owner_trig)
                        for r_cells in act.get("rows", []):
                            for cell in r_cells:
                                if isinstance(cell, dict) and "runtime" in cell:
                                    scan_rt(cell["runtime"], owner_trig)
                        for u in act.get("updates", []):
                            scan_rt(u.get("runtime"), owner_trig)
                        if act["type"] == "set-variable" and act.get("variable") in var_writers:
                            var_writers[act["variable"]].add(owner_trig)
                        if act.get("target"):
                            widget_writers.setdefault(act["target"], set()).add(owner_trig)

    deps = {
        "variables": {k: {"readers": sorted(var_readers[k]), "writers": sorted(var_writers[k])} for k in ir["variables"]},
        "widgets": {k: {"readers": sorted(widget_readers.get(k, set())), "writers": sorted(widget_writers.get(k, set()))}
                    for k in sorted(set(widget_readers) | set(widget_writers))},
    }
    if target is None:
        res = {"semanticHash": ir["semanticHash"], "pages": [p["slug"] for p in ir["pages"]],
               "symbolCount": len(ir["symbols"]), "symbols": ir["symbols"], "dependencies": deps}
        if "productProvenance" in ir:
            res["productProvenance"] = ir["productProvenance"]
        return res
    sym = by_id.get(target) or by_name.get(target) or by_ptr.get(target)
    if sym is None:
        matches = [s for s in ir["symbols"] if s["id"].endswith("/" + str(target))]
        if len(matches) == 1:
            sym = matches[0]
    if sym is None and "productProvenance" in ir:
        pprov = ir["productProvenance"]
        rname = str(target).removeprefix("/product/rules/").split("/")[0]
        if rname in pprov.get("rules", {}):
            affected = sorted(
                s["id"] for s in ir["symbols"]
                if rname in (s.get("productOrigin", {}).get("rules") or [])
                or s.get("productOrigin", {}).get("rule") == rname
            )
            return {
                "productRule": pprov["rules"][rname],
                "affectedSymbols": affected,
                "semanticHash": ir["semanticHash"],
            }
        ename = str(target).removeprefix("/product/entities/").split("/")[0]
        if ename in pprov.get("entities", {}):
            affected = sorted(s["id"] for s in ir["symbols"] if s.get("productOrigin", {}).get("entity") == ename)
            return {
                "productEntity": pprov["entities"][ename],
                "affectedSymbols": affected,
                "semanticHash": ir["semanticHash"],
            }
    if sym is None:
        fail("E_REFERENCE", "/", f"Cannot inspect unknown symbol or pointer '{target}'")
    out = {
        "symbol": sym,
        "readers": sorted(widget_readers.get(sym["name"], set())),
        "writers": sorted(widget_writers.get(sym["name"], set())),
        "semanticHash": ir["semanticHash"],
    }
    if "productOrigin" in sym:
        out["productOrigin"] = sym["productOrigin"]
    return out


def explain_spec(spec, target):
    """Explain symbol scope chain, property provenance (explicit vs desugared vs product), and bindings."""
    info = inspect_spec(spec, target)
    if "productRule" in info or "productEntity" in info:
        return info
    sym = info["symbol"]
    ptr_path = sym["pointer"]
    raw_node = None
    try:
        raw_node = _resolve_pointer(spec, ptr_path)
    except LanguageError:
        raw_node = None
    fe = Frontend(spec)
    lowered, ir = fe.compile()
    compiled_node = None

    def find_compiled(node):
        if node.get("name") == sym["name"]:
            return node
        for c in node.get("children", []):
            res = find_compiled(c)
            if res: return res
        for st in node.get("states", []):
            res = find_compiled(st["root"])
            if res: return res
        if isinstance(node.get("template"), dict):
            res = find_compiled(node["template"])
            if res: return res
        return None

    for p in lowered["pages"]:
        compiled_node = find_compiled(p["root"])
        if compiled_node:
            break
    provenance = {}
    prod_origin = sym.get("productOrigin")
    if isinstance(compiled_node, dict):
        for k, v in compiled_node.items():
            if k in ("children", "states", "template"):
                continue
            if isinstance(raw_node, dict) and k in raw_node:
                provenance[k] = {"value": v, "origin": "explicit"}
            elif ptr_path.startswith("/components/"):
                provenance[k] = {"value": v, "origin": "component-template"}
            elif isinstance(raw_node, dict) and raw_node.get("type") in MACRO_PROPS:
                provenance[k] = {"value": v, "origin": f"macro:{raw_node.get('type')}"}
            elif prod_origin is not None:
                origin_label = prod_origin.get("view") or prod_origin.get("operation") or prod_origin.get("query") or prod_origin.get("id") or "product"
                rules_list = prod_origin.get("rules") or ([prod_origin["rule"]] if prod_origin.get("rule") else [])
                provenance[k] = {
                    "value": v,
                    "origin": f"product:{origin_label}",
                    "productPointer": prod_origin.get("pointer"),
                    "rules": rules_list,
                }
            else:
                provenance[k] = {"value": v, "origin": "desugared-or-default"}
    scope_chain = []
    cur = sym["id"]
    while cur:
        scope_chain.append(cur)
        cur = cur.rpartition("/")[0]
    out = {
        "symbol": sym,
        "scopeChain": scope_chain,
        "provenance": provenance,
        "readers": info["readers"],
        "writers": info["writers"],
    }
    if prod_origin is not None:
        out["productOrigin"] = prod_origin
    return out


SEMANTIC_PATCH_OPS = {"add_field", "remove_field", "modify_rule", "override_slot", "add_state_transition", "switch_shell"}


def _apply_semantic_intent_op(patched, op_spec, op_path):
    op = op_spec.get("op")
    prod = patched.get("product") if isinstance(patched.get("product"), dict) else None
    if op == "add_field":
        entity = op_spec.get("entity")
        field = op_spec.get("field")
        fspec = op_spec.get("spec", op_spec.get("fieldSpec", "text"))
        if not isinstance(entity, str) or not isinstance(field, str):
            fail("E_PATCH", op_path, "add_field requires 'entity' and 'field'")
        default_val = op_spec.get("default")
        if default_val is None:
            if isinstance(fspec, dict) and "default" in fspec:
                default_val = fspec["default"]
            elif isinstance(fspec, dict) and isinstance(fspec.get("enum"), list) and fspec["enum"]:
                default_val = fspec["enum"][0]
            elif isinstance(fspec, str) and fspec.startswith("enum(") and fspec.endswith(")"):
                vals = [x.strip() for x in fspec[5:-1].replace("|", ",").split(",") if x.strip()]
                default_val = vals[0] if vals else ""
            else:
                raw_t = fspec.get("type", "text") if isinstance(fspec, dict) else fspec
                default_val = 0 if raw_t in ("number", "money", "percent") else (False if raw_t == "boolean" else "")
        if prod and entity in prod.get("entities", {}):
            ent = prod["entities"][entity]
            ent.setdefault("fields", {})[field] = copy.deepcopy(fspec)
            for r in ent.get("rows", []):
                if isinstance(r, dict) and field not in r:
                    r[field] = default_val
            if op_spec.get("addToViews", True):
                for op_entry in prod.get("operations", {}).values():
                    if isinstance(op_entry, dict) and op_entry.get("entity") == entity and op_entry.get("kind") == "create":
                        if isinstance(op_entry.get("fields"), list) and field not in op_entry["fields"]:
                            op_entry["fields"].append(field)
                for vw in prod.get("views", []):
                    if isinstance(vw, dict) and vw.get("entity") == entity and vw.get("kind") == "detail":
                        if isinstance(vw.get("displayFields"), list) and field not in vw["displayFields"]:
                            vw["displayFields"].append(field)
        elif isinstance(patched.get("models"), dict) and entity in patched["models"]:
            patched["models"][entity][field] = copy.deepcopy(fspec)
            for ds in patched.get("datasets", {}).values():
                if isinstance(ds, dict) and ds.get("model") == entity:
                    for r in ds.get("rows", []):
                        if isinstance(r, dict) and field not in r:
                            r[field] = default_val
        else:
            fail("E_PATCH", op_path, f"Unknown entity or model '{entity}'")
    elif op == "remove_field":
        entity = op_spec.get("entity")
        field = op_spec.get("field")
        if prod and entity in prod.get("entities", {}):
            ent = prod["entities"][entity]
            ent.get("fields", {}).pop(field, None)
            for r in ent.get("rows", []):
                if isinstance(r, dict):
                    r.pop(field, None)
            for op_entry in prod.get("operations", {}).values():
                if isinstance(op_entry, dict) and isinstance(op_entry.get("fields"), list) and field in op_entry["fields"]:
                    op_entry["fields"].remove(field)
            for vw in prod.get("views", []):
                if isinstance(vw, dict) and isinstance(vw.get("displayFields"), list) and field in vw["displayFields"]:
                    vw["displayFields"].remove(field)
        elif isinstance(patched.get("models"), dict) and entity in patched["models"]:
            patched["models"][entity].pop(field, None)
            for ds in patched.get("datasets", {}).values():
                if isinstance(ds, dict) and ds.get("model") == entity:
                    for r in ds.get("rows", []):
                        if isinstance(r, dict):
                            r.pop(field, None)
        else:
            fail("E_PATCH", op_path, f"Unknown entity or model '{entity}'")
    elif op == "modify_rule":
        rule = op_spec.get("rule")
        changes = op_spec.get("changes", op_spec.get("value", {}))
        if not isinstance(rule, str) or not isinstance(changes, dict):
            fail("E_PATCH", op_path, "modify_rule requires 'rule' and 'changes' object")
        if prod and rule in prod.get("rules", {}):
            prod["rules"][rule].update(copy.deepcopy(changes))
        elif prod and rule in prod.get("transactions", {}):
            prod["transactions"][rule].update(copy.deepcopy(changes))
        elif isinstance(patched.get("transactions"), dict) and rule in patched["transactions"]:
            patched["transactions"][rule].update(copy.deepcopy(changes))
        else:
            fail("E_PATCH", op_path, f"Unknown rule or transaction '{rule}'")
    elif op == "override_slot":
        target = op_spec.get("target")
        slot = op_spec.get("slot")
        node = op_spec.get("node", op_spec.get("value"))
        if not isinstance(target, str) or not isinstance(slot, str) or not isinstance(node, dict):
            fail("E_PATCH", op_path, "override_slot requires 'target', 'slot', and 'node'")
        applied = False
        if prod and isinstance(prod.get("views"), list):
            for vw in prod["views"]:
                if isinstance(vw, dict) and vw.get("id") == target:
                    vw.setdefault("slots", {})[slot] = copy.deepcopy(node)
                    applied = True
        def inject_node_slot(n):
            nonlocal applied
            if not isinstance(n, dict):
                return
            nid = n.get("id") or next((n.get(k) for k in SHORTHAND_NODE_KINDS if isinstance(n.get(k), str)), None)
            if nid == target:
                n.setdefault("slots", {})[slot] = copy.deepcopy(node)
                applied = True
            for ch in n.get("children", []) if isinstance(n.get("children"), list) else []:
                inject_node_slot(ch)
            for st in n.get("states", []) if isinstance(n.get("states"), list) else []:
                if isinstance(st, dict):
                    inject_node_slot(st.get("root"))
            if isinstance(n.get("template"), dict):
                inject_node_slot(n["template"])
        for pg in patched.get("pages", []) if isinstance(patched.get("pages"), list) else []:
            if isinstance(pg, dict):
                inject_node_slot(pg.get("root"))
        if not applied:
            fail("E_PATCH", op_path, f"Target view or macro '{target}' not found for override_slot")
    elif op == "add_state_transition":
        sc_name = op_spec.get("statechart")
        from_st = op_spec.get("from")
        to_st = op_spec.get("to")
        ev_name = op_spec.get("on", op_spec.get("event", f"{from_st}_to_{to_st}"))
        sc_map = (prod.get("statecharts") if prod and isinstance(prod.get("statecharts"), dict) else None) or (
            patched.get("statecharts") if isinstance(patched.get("statecharts"), dict) else None
        )
        if not sc_map or sc_name not in sc_map:
            fail("E_PATCH", op_path, f"Unknown statechart '{sc_name}'")
        sc = sc_map[sc_name]
        states = sc.setdefault("states", [])
        if from_st not in states:
            states.append(from_st)
        if to_st not in states:
            states.append(to_st)
        trans = sc.setdefault("transitions", [])
        if isinstance(trans, list):
            trans.append({"from": from_st, "to": to_st, "on": ev_name})
        elif isinstance(trans, dict):
            trans[ev_name] = {"from": from_st, "to": to_st}
    elif op == "switch_shell":
        shell = op_spec.get("shell", op_spec.get("value"))
        if shell not in {"mobile-stack", "tablet-split", "web-console"}:
            fail("E_PATCH", op_path, f"Unsupported shell '{shell}'")
        patched["shell"] = shell
        patched["domain"] = "mobile" if shell == "mobile-stack" else "web"
        if prod is not None:
            prod["shell"] = shell


def merge_gui_passthrough(base_spec, gui_spec, ai_patched_spec=None):
    """3-way merge preserving GUI passthrough_layer decorations alongside AI semantic updates."""
    target = copy.deepcopy(ai_patched_spec if ai_patched_spec is not None else base_spec)
    gui_layers = {}
    for idx, pg in enumerate(gui_spec.get("pages", []) if isinstance(gui_spec, dict) else []):
        if isinstance(pg, dict) and "passthrough_layer" in pg:
            gui_layers[pg.get("id", f"page_{idx}")] = copy.deepcopy(pg["passthrough_layer"])
    if isinstance(target.get("pages"), list):
        for idx, pg in enumerate(target["pages"]):
            if isinstance(pg, dict):
                pid = pg.get("id", f"page_{idx}")
                if pid in gui_layers:
                    existing = pg.get("passthrough_layer", [])
                    merged = list(existing) if isinstance(existing, list) else []
                    seen_names = {item.get("name") for item in merged if isinstance(item, dict) and item.get("name")}
                    for item in gui_layers[pid] if isinstance(gui_layers[pid], list) else [gui_layers[pid]]:
                        if isinstance(item, dict) and item.get("name") in seen_names:
                            continue
                        merged.append(item)
                    pg["passthrough_layer"] = merged
    return target


def _build_effective_theme(lowered, page):
    try:
        from proto import THEMES, resolve_color as _res_col
    except Exception:
        THEMES, _res_col = {}, None
    th_name = page.get("theme") or lowered.get("theme", "enterprise-light")
    th = dict(THEMES.get(th_name, THEMES.get("enterprise-light", {})))
    pal = lowered.get("palette")
    if isinstance(pal, dict) and th_name == lowered.get("theme", "enterprise-light"):
        for k, v in pal.items():
            th[k.lstrip("$")] = v
    page_pal = page.get("palette")
    if isinstance(page_pal, dict):
        for k, v in page_pal.items():
            th[k.lstrip("$")] = v
    return th, _res_col

def _effective_node_props(node, th, _res_col):
    ntype = node.get("type", "box")
    out = {k: copy.deepcopy(v) for k, v in node.items() if k not in {"children", "states", "template"}}
    variant = out.get("variant")
    if ntype in ("button", "badge"):
        is_badge = ntype == "badge"
        var = variant or ("soft" if is_badge else "primary")
        if "fill" not in out:
            out["fill"] = {
                "primary": "$brand", "soft": "$brand-soft", "secondary": "$surface",
                "ghost": "transparent", "danger": "$danger", "danger-soft": "$danger-soft",
                "success-soft": "$success-soft", "warning-soft": "$warning-soft", "neutral-soft": "$surface-2",
            }.get(var, "$surface")
        if "color" not in out:
            out["color"] = {
                "primary": "#FFFFFF", "soft": "$brand", "secondary": "$ink",
                "ghost": "$ink-2", "danger": "#FFFFFF", "danger-soft": "$danger",
                "success-soft": "$success", "warning-soft": "$warning", "neutral-soft": "$ink-2",
            }.get(var, "$ink")
        if "stroke" not in out:
            out["stroke"] = "$line" if var == "secondary" else None
    elif ntype == "label":
        out.setdefault("color", "$ink")
    elif ntype == "input":
        out.setdefault("fill", "$surface-2")
        out.setdefault("stroke", "$line-strong" if out.get("native") is True else "$line")
        out.setdefault("color", "$ink" if ("value" in out or "text" in out) else "$ink-2")
    elif ntype == "divider":
        out.setdefault("fill", out.get("color", "$line"))
    elif ntype == "card":
        is_glass = variant == "glass"
        out.setdefault("fill", "$glass" if is_glass else "$surface")
        out.setdefault("stroke", "$glass-border" if is_glass else "$line")

    def _resolve_val(v):
        if isinstance(v, str) and v.startswith("$") and _res_col is not None:
            return _res_col(v, th)
        if isinstance(v, dict):
            return {dk: _resolve_val(dv) for dk, dv in v.items()}
        if isinstance(v, list):
            return [_resolve_val(x) for x in v]
        return v

    return _resolve_val(out)

def effective_scene_nodes(lowered):
    nodes = {}
    for page in lowered["pages"]:
        th, _res_col = _build_effective_theme(lowered, page)
        def index(node):
            if node.get("name"):
                nodes[node["name"]] = _effective_node_props(node, th, _res_col)
            for child in node.get("children", []):
                index(child)
            for state in node.get("states", []):
                index(state["root"])
            if isinstance(node.get("template"), dict):
                index(node["template"])
        index(page["root"])
    return nodes


def patch_spec(spec, operations, expected_hash=None):
    """Apply preconditioned source patches with semanticHash guard and impact analysis."""
    before_lowered, before_ir = compile_language(spec)
    if expected_hash is not None and before_ir["semanticHash"] != expected_hash:
        fail("E_PATCH_CONFLICT", "/", f"Stale semanticHash: expected {expected_hash}, got {before_ir['semanticHash']}")
    if not isinstance(operations, list) or not operations:
        fail("E_PATCH", "/", "Expected a nonempty patch operation array")
    patched = copy.deepcopy(spec)
    for idx, op_spec in enumerate(operations):
        op_path = ptr("/operations", idx)
        if not isinstance(op_spec, dict):
            fail("E_PATCH", op_path, "Patch operation must be an object")
        op = op_spec.get("op", "replace")
        if isinstance(op, str) and op in SEMANTIC_PATCH_OPS:
            _apply_semantic_intent_op(patched, op_spec, op_path)
            continue
        if set(op_spec) - {"op", "path", "value", "oldValue"}:
            fail("E_PATCH", op_path, "Unknown patch operation property")
        if not isinstance(op, str) or op not in {"replace", "add", "remove"}:
            fail("E_PATCH", ptr(op_path, "op"), "Expected replace, add, remove, or semantic intent op")
        target_ptr = op_spec.get("path")
        parts = _pointer_parts(target_ptr, "E_PATCH")
        if not parts:
            fail("E_PATCH", ptr(op_path, "path"), "Patch a source property, not the document root")
        if op != "remove" and "value" not in op_spec:
            fail("E_PATCH", ptr(op_path, "value"), "Patch operation requires value")
        parent_pointer = "".join(ptr("", part) for part in parts[:-1])
        parent = _resolve_pointer(patched, parent_pointer, "E_PATCH", target_ptr)
        last = parts[-1]
        if isinstance(parent, list):
            key = _array_index(last, len(parent), target_ptr, "E_PATCH", append=op == "add")
            exists = key < len(parent)
        elif isinstance(parent, dict):
            key, exists = last, last in parent
        else:
            fail("E_PATCH", target_ptr, "Cannot patch a property of a scalar")
        if op != "add" and not exists:
            fail("E_PATCH", target_ptr, "Patch target does not exist")
        if "oldValue" in op_spec and (not exists or parent[key] != op_spec["oldValue"]):
            fail("E_PATCH_CONFLICT", target_ptr, "oldValue does not match the target")
        if op == "remove":
            if isinstance(parent, list): parent.pop(key)
            else: del parent[key]
        elif op == "add" and isinstance(parent, list):
            parent.insert(key, copy.deepcopy(op_spec["value"]))
        else:
            parent[key] = copy.deepcopy(op_spec["value"])
    after_lowered, after_ir = compile_language(patched)
    before_syms = {s["id"]: s for s in before_ir["symbols"]}
    after_syms = {s["id"]: s for s in after_ir["symbols"]}
    added = sorted(set(after_syms) - set(before_syms))
    removed = sorted(set(before_syms) - set(after_syms))
    def behaviors(ir):
        return {ix["trigger"]: ix["events"] for page in ir["pages"] for ix in page["interactions"]}
    before_nodes, after_nodes = effective_scene_nodes(before_lowered), effective_scene_nodes(after_lowered)
    before_behavior, after_behavior = behaviors(before_ir), behaviors(after_ir)
    shared = set(before_syms) & set(after_syms)
    identity_changed = sorted(k for k in shared if any(before_syms[k].get(p) != after_syms[k].get(p) for p in ("kind", "name")))
    property_changed = sorted(k for k in shared if before_nodes.get(before_syms[k]["name"]) != after_nodes.get(after_syms[k]["name"]))
    behavior_changed = sorted(k for k in shared if before_behavior.get(before_syms[k]["name"]) != after_behavior.get(after_syms[k]["name"]))
    source_changed = sorted(k for k in shared if any(before_syms[k].get(p) != after_syms[k].get(p) for p in ("pointer", "source", "productOrigin")))
    changed = sorted(set(identity_changed + property_changed + behavior_changed + source_changed))
    before_pages = {p["slug"]: p for p in before_ir["pages"]}
    after_pages = {p["slug"]: p for p in after_ir["pages"]}
    sym_affected_pages = {
        (after_syms.get(sid) or before_syms.get(sid, {})).get("pageId")
        for sid in (set(added) | set(removed) | set(changed))
    }
    sym_affected_pages.discard(None)
    raw_changed_pages = {k for k in set(before_pages) | set(after_pages) if before_pages.get(k) != after_pages.get(k)}
    affected_pages = sorted(raw_changed_pages | sym_affected_pages)
    diff_obj = {
        "beforeHash": before_ir["semanticHash"],
        "afterHash": after_ir["semanticHash"],
        "addedSymbols": added,
        "removedSymbols": removed,
        "changedSymbols": changed,
        "identityChangedSymbols": identity_changed,
        "propertyChangedSymbols": property_changed,
        "behaviorChangedSymbols": behavior_changed,
        "sourceChangedSymbols": source_changed,
        "affectedPages": affected_pages,
    }
    prod_impact = compute_product_impact(spec, patched, before_ir, after_ir, operations)
    if prod_impact is not None:
        diff_obj["productImpact"] = prod_impact
    res = {
        "spec": patched,
        "lowered": after_lowered,
        "ir": after_ir,
        "diff": diff_obj,
    }
    if prod_impact is not None:
        res["productImpact"] = prod_impact
    return res


def complete_spec(spec, pointer="/"):
    """Recover local completion context without requiring an unfinished file to compile."""
    fe = Frontend(spec)
    doc = fe.spec
    target_obj = _resolve_pointer(doc, pointer)
    parts = _pointer_parts(pointer)
    page = None
    if len(parts) >= 2 and parts[0] == "pages":
        page = doc["pages"][_array_index(parts[1], len(doc["pages"]), pointer)]
    page_slug = page.get("id", "") if isinstance(page, dict) else ""

    def kind_of(node):
        if not isinstance(node, dict): return None
        return node.get("type") or next((k for k in SHORTHAND_NODE_KINDS if isinstance(node.get(k), str)), None)

    def node_id(node):
        kind = kind_of(node)
        return node.get("id", node.get(kind)) if isinstance(node, dict) else None

    ancestors, current = [], doc
    for idx, part in enumerate(parts):
        if isinstance(current, dict):
            ancestors.append((current, parts[idx:]))
            current = current[part]
        elif isinstance(current, list): current = current[int(part)]
    if isinstance(target_obj, dict): ancestors.append((target_obj, []))
    models, datasets = doc.get("models", {}), doc.get("datasets", {})
    def dataset_model(name):
        dataset = datasets.get(name, {})
        return models.get(dataset.get("model"), {}) if isinstance(dataset, dict) else {}
    row_fields = []
    for ancestor, remaining in ancestors:
        if kind_of(ancestor) == "repeater" and remaining[:1] == ["template"]:
            row_fields = sorted(dataset_model(ancestor.get("dataset")))
    parameter_names = []
    if len(parts) >= 2 and parts[0] == "components":
        definition = doc.get("components", {}).get(parts[1], {})
        for name, typename in definition.get("params", {}).items():
            parameter_names.append("param." + name)
            parameter_names.extend("param." + name + "." + field for field in models.get(typename, {}))
    compile_fields = []
    for ancestor, remaining in ancestors:
        if kind_of(ancestor) == "repeat" and remaining[:1] == ["template"]:
            alias = ancestor.get("as", "item")
            compile_fields.extend(alias + "." + field for field in dataset_model(ancestor.get("dataset")))

    candidates, panels = [], {}
    def collect(node, stack=()):
        if not isinstance(node, dict): return
        kind, nid = kind_of(node), node_id(node)
        if isinstance(nid, str): candidates.append(nid)
        if kind == "dynamic-panel" and isinstance(nid, str):
            panels[nid] = [st["id"] for st in node.get("states", []) if isinstance(st, dict) and isinstance(st.get("id"), str)]
        if kind in {"repeater", "repeat"}: return  # Other row instances are not in this lexical scope.
        if kind == "use":
            component = node.get("component", node.get("use"))
            if component not in stack:
                definition = doc.get("components", {}).get(component, {})
                collect(definition.get("root"), (*stack, component))
        for child in node.get("children", []) if isinstance(node.get("children", []), list) else []: collect(child, stack)
        for state in node.get("states", []) if isinstance(node.get("states", []), list) else []:
            if isinstance(state, dict): collect(state.get("root"), stack)
    if page: collect(page.get("root"))
    for ancestor, remaining in ancestors:
        if kind_of(ancestor) == "repeater" and remaining[:1] == ["template"]:
            collect(ancestor.get("template"))
    unique_widgets = sorted(name for name in set(candidates) if candidates.count(name) == 1)
    node_kind = kind_of(target_obj)
    normalized_kind = "box" if node_kind in {"row", "column", "stack", "grid"} else node_kind
    common = {"type", "id", "name", "on", "font", "size"} | set(EVENT_SHORTHANDS) | GEOMETRY
    allowed_props = common | NODE_PROPS.get(normalized_kind, set())
    if normalized_kind in MACRO_PROPS: allowed_props = MACRO_PROPS[normalized_kind]
    elif normalized_kind is None: allowed_props |= SHORTHAND_NODE_KINDS
    variables = doc.get("variables", {})
    out = {
        "pointer": pointer, "page": page_slug,
        "nodeKinds": sorted(SHORTHAND_NODE_KINDS), "properties": sorted(allowed_props),
        "events": sorted(list(EVENTS) + list(EVENT_SHORTHANDS)),
        "actions": sorted(list(ACTION_PROPS) + ["set", "state", "set-state", "goto"]),
        "variables": sorted("$" + k for k in variables) if isinstance(variables, dict) else [],
        "widgets": ["@" + w for w in unique_widgets],
        "rowFields": [prefix + f for prefix in ("item.", "row.") for f in row_fields],
        "parameters": sorted(parameter_names), "compileTimeFields": sorted(compile_fields),
        "panelStates": panels, "colorTokens": sorted("$" + c for c in COLOR_TOKENS), "themes": sorted(THEMES),
    }
    if isinstance(doc.get("product"), dict):
        prod = doc["product"]
        out["productEntities"] = sorted(prod.get("entities", {}).keys()) if isinstance(prod.get("entities"), dict) else []
        out["productRules"] = sorted(prod.get("rules", {}).keys()) if isinstance(prod.get("rules"), dict) else []
        out["productQueries"] = sorted(prod.get("queries", {}).keys()) if isinstance(prod.get("queries"), dict) else []
        out["productOperations"] = sorted(prod.get("operations", {}).keys()) if isinstance(prod.get("operations"), dict) else []
        out["productViews"] = [v.get("id") for v in prod.get("views", []) if isinstance(v, dict) and v.get("id")]
    return out


def auto_heal_spec(spec, max_rounds=5, base_dir=None):
    """Automatically heal static/layout/type diagnostics using pre-verified candidatePatches."""
    import sys
    cur_spec = copy.deepcopy(spec)
    applied = []
    for round_idx in range(1, max_rounds + 1):
        try:
            lowered, ir = compile_language(cur_spec)
            if not getattr(sys.flags, "no_site", 0):
                try:
                    import tempfile
                    from proto import compile_spec_bundle
                    with tempfile.TemporaryDirectory(prefix="zee-rp-heal-") as _td:
                        _bres = compile_spec_bundle(copy.deepcopy(cur_spec), _td, base_dir=base_dir, strict_audit=False)
                    if not _bres.get("structural_ok", True):
                        _raw_fails = _bres.get("failures") or (_bres.get("audit") or {}).get("failures") or []
                        for _f in _raw_fails:
                            if isinstance(_f, dict) and _f.get("candidatePatches"):
                                fail(
                                    _f.get("code", "E_LAYOUT"),
                                    _f.get("pointer", "/"),
                                    _f.get("detail") or _f.get("message") or "Layout gate failed",
                                    candidate_patches=_f["candidatePatches"],
                                )
                except LanguageError:
                    raise
                except Exception:
                    pass
            return {
                "ok": True,
                "healed": len(applied) > 0,
                "rounds": len(applied),
                "appliedPatches": applied,
                "spec": cur_spec,
                "lowered": lowered,
                "ir": ir,
                "semanticHash": ir["semanticHash"],
            }
        except LanguageError as err:
            diag = err.diagnostic
            cands = diag.get("candidatePatches") or []
            if not cands:
                raise
            healed_this_round = False
            for cand in cands:
                trial = copy.deepcopy(cur_spec)
                try:
                    ops = cand.get("operations", [])
                    if (
                        isinstance(trial, dict)
                        and "pages" not in trial
                        and isinstance(trial.get("product"), dict)
                        and any(str(op_s.get("path", "")).startswith("/pages/") for op_s in ops)
                    ):
                        expanded_trial, _ = expand_product_spec(
                            copy.deepcopy(trial), fail, ident, fields, lambda v, t, p: None
                        )
                        if "pages" in expanded_trial:
                            trial["pages"] = expanded_trial["pages"]
                    for op_spec in ops:
                        op = op_spec.get("op", "replace")
                        t_ptr = op_spec.get("path", "/")
                        parts = _pointer_parts(t_ptr, "E_PATCH")
                        if not parts:
                            continue
                        parent_ptr = "".join(ptr("", p) for p in parts[:-1])
                        parent = _resolve_pointer(trial, parent_ptr, "E_PATCH", t_ptr)
                        last = parts[-1]
                        val = copy.deepcopy(op_spec.get("value"))
                        if isinstance(parent, list):
                            k = _array_index(last, len(parent), t_ptr, "E_PATCH", append=op == "add")
                            if op == "remove":
                                parent.pop(k)
                            elif op == "add":
                                parent.insert(k, val)
                            else:
                                parent[k] = val
                        elif isinstance(parent, dict):
                            if op == "remove":
                                parent.pop(last, None)
                            else:
                                existing = parent.get(last)
                                if isinstance(existing, dict) and isinstance(val, str) and len(existing) == 1:
                                    only_k = next(iter(existing))
                                    if only_k in ("item", "caller", "ref", "variable", "var", "$"):
                                        existing[only_k] = val
                                    else:
                                        parent[last] = val
                                elif isinstance(existing, str) and isinstance(val, str) and "${" in existing and "${" not in val:
                                    parent[last] = re.sub(r"\.[A-Za-z0-9_-]+\}", f".{val}}}", existing)
                                else:
                                    parent[last] = val
                                if last == "w" and "width" in parent:
                                    parent.pop("width", None)
                    if (
                        len(cands) > 1
                        and diag.get("code") in ("E_DATASET_WORST_CASE_OVERFLOW", "E_LAYOUT")
                        and not getattr(sys.flags, "no_site", 0)
                    ):
                        import tempfile
                        from proto import compile_spec_bundle
                        compile_language(copy.deepcopy(trial))
                        with tempfile.TemporaryDirectory(prefix="zee-rp-cand-") as _ctd:
                            _cbres = compile_spec_bundle(copy.deepcopy(trial), _ctd, strict_audit=False)
                        if not _cbres.get("structural_ok", True):
                            continue
                    cur_spec = trial
                    applied.append({
                        "round": round_idx,
                        "code": diag["code"],
                        "pointer": diag["pointer"],
                        "description": cand.get("description", ""),
                        "operations": cand.get("operations", []),
                    })
                    healed_this_round = True
                    break
                except Exception:
                    continue
            if not healed_this_round:
                raise
    lowered, ir = compile_language(cur_spec)
    return {
        "ok": True,
        "healed": len(applied) > 0,
        "rounds": len(applied),
        "appliedPatches": applied,
        "spec": cur_spec,
        "lowered": lowered,
        "ir": ir,
        "semanticHash": ir["semanticHash"],
    }
