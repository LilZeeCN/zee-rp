import copy
import math
import re
from .core import fixed_decimal
from .core import CHECK_KINDS, EVENTS, FORM_KINDS, OPTION_KINDS, TEXT_INPUT_KINDS, WIDGET_GEOM_ACCESSORS, fail
from .frontend import compile_language

class ReferenceRuntime:
    """Pure in-memory reference executor for RP/1 IR v2."""

    def __init__(self, spec_or_compiled):
        if isinstance(spec_or_compiled, tuple) and len(spec_or_compiled) == 2:
            self.lowered, self.ir = copy.deepcopy(spec_or_compiled[0]), copy.deepcopy(spec_or_compiled[1])
        else:
            self.lowered, self.ir = compile_language(spec_or_compiled)
        self.symbols_by_id = {s["id"]: s for s in self.ir["symbols"]}
        self.symbols_by_name = {s["name"]: s for s in self.ir["symbols"]}
        self.pages_by_slug = {p["slug"]: p for p in self.ir["pages"]}
        self.pages_by_name = {p["name"]: p["slug"] for p in self.ir["pages"]}
        self.variables = {k: copy.deepcopy(v["value"]) for k, v in self.ir.get("variables", {}).items()}
        self.widgets = {}
        self.row_widgets = {}
        self.panels = {}
        self.repeaters = {}
        self.focused_widget = None
        self.execution_trace = []
        self.event_depth = 0
        self.time_ms = 0
        self.panel_repeats = {}
        self.offsets = {}
        self.drag_origins = {}
        self.drag_delta = (0, 0)
        self.base_rects = {}
        self.last_move_delta = {}
        self.current_trigger = None
        for p in self.ir["pages"]:
            self._index_tree(p["root"], p["slug"], None)
        self.current_page = self.ir["pages"][0]["slug"]
        self._run_page_load(self.current_page)

    def _index_tree(self, node, page_slug, rep_name, parent=None, panel_states=(), parent_xy=(0, 0)):
        name, kind = node.get("name"), node.get("type")
        nx = node.get("x") if isinstance(node.get("x"), (int, float)) else 0
        ny = node.get("y") if isinstance(node.get("y"), (int, float)) else 0
        nw = node.get("w") if isinstance(node.get("w"), (int, float)) else 0
        nh = node.get("h") if isinstance(node.get("h"), (int, float)) else 0
        abs_x, abs_y = parent_xy[0] + nx, parent_xy[1] + ny
        if name:
            self.base_rects[name] = (abs_x, abs_y, nw, nh)
            self.widgets[name] = {
                "name": name, "kind": kind, "page": page_slug, "repeater": rep_name,
                "text": str(node.get("value" if kind in TEXT_INPUT_KINDS else "text", "")),
                "visible": (node.get("visible", True) is not False) and not bool(node.get("hidden", False)), "enabled": True,
                "parent": parent, "panelStates": list(panel_states),
                "selected": node.get("selected", node.get("checked", False)),
                "rotation": node.get("rotation", 0),
                "checked": node.get("checked", False),
                "group": node.get("group", ""), "selectionGroup": node.get("selectionGroup", ""),
                "options": copy.deepcopy(node.get("options", [])),
                "selectedIndices": copy.deepcopy(node.get("selectedIndices", [node.get("selectedIndex", 0)] if kind in OPTION_KINDS else [])),
            }
        if name and kind == "input" and "maxLength" in node:
            self.widgets[name]["maxLength"] = node["maxLength"]
        if name and kind in OPTION_KINDS:
            indices = self.widgets[name]["selectedIndices"]
            self.widgets[name]["text"] = node["options"][indices[0]] if indices else ""
        if name and node.get("disabled", False):
            self.widgets[name]["enabled"] = False
        if kind == "dynamic-panel":
            states = [s["name"] for s in node.get("states", [])]
            self.panels[name] = {"current": states[0] if states else "", "states": states, "page": page_slug}
            for st in node.get("states", []):
                self._index_tree(st["root"], page_slug, rep_name, name, (*panel_states, (name, st["name"])), (abs_x, abs_y))
        elif kind == "repeater":
            self.repeaters[name] = {
                "name": name, "page": page_slug, "model": copy.deepcopy(node.get("model", {})),
                "rows": copy.deepcopy(node.get("rows", [])), "filters": {}, "sort": None,
                "page_num": 1, "page_size": node.get("pageSize", 0), "template": node.get("template"),
                "visible_rows": None,
            }
            if isinstance(node.get("template"), dict):
                self._index_tree(node["template"], page_slug, name, name, panel_states, (abs_x, abs_y))
        for child in node.get("children", []):
            self._index_tree(child, page_slug, rep_name, name, panel_states, (abs_x, abs_y))

    def _get_row_widget(self, rep_name, row_index, wname):
        key = (rep_name, row_index, wname)
        if key not in self.row_widgets and wname in self.widgets:
            base = self.widgets[wname]
            self.row_widgets[key] = {"text": base["text"], "visible": base["visible"], "enabled": base["enabled"]}
        return self.row_widgets.get(key)

    def is_operable(self, name, row_index=0, check_enabled=True):
        widget = self.widgets.get(name)
        if not widget or widget["page"] != self.current_page:
            return False
        repeater = widget.get("repeater")
        if repeater and not (0 <= row_index < len(self.visible_rows(repeater))):
            return False
        current = widget
        while current:
            cur_rep = current.get("repeater")
            if cur_rep and (cur_rep, row_index, current["name"]) in self.row_widgets:
                rw = self.row_widgets[(cur_rep, row_index, current["name"])]
                if not rw["visible"] or (check_enabled and not rw["enabled"]):
                    return False
            elif not current["visible"] or (check_enabled and not current["enabled"]):
                return False
            current = self.widgets.get(current.get("parent"))
        if any(self.panels[panel]["current"] != state for panel, state in widget["panelStates"]):
            return False
        return True

    def _compute_visible_rows(self, rep_name):
        rep = self.repeaters[rep_name]
        rows = [r for r in rep["rows"] if all(self.eval_expr(pred, row=r) for pred in rep["filters"].values())]
        if rep["sort"]:
            col, asc = rep["sort"]["column"], rep["sort"]["ascending"]
            rows = sorted(rows, key=lambda r: r.get(col, 0 if rep["model"].get(col) == "number" else ""), reverse=not asc)
        ps = rep["page_size"]
        if ps and ps > 0:
            total_pages = max(1, (len(rows) + ps - 1) // ps)
            p = min(max(1, rep["page_num"]), total_pages)
            rep["page_num"] = p
            rows = rows[(p - 1) * ps : p * ps]
        rep["visible_rows"] = copy.deepcopy(rows)
        return copy.deepcopy(rows)

    def visible_rows(self, rep_name):
        rep = self.repeaters[rep_name]
        if rep.get("visible_rows") is None:
            return self._compute_visible_rows(rep_name)
        return copy.deepcopy(rep["visible_rows"])

    def _widget_rect(self, name):
        bx, by, bw, bh = self.base_rects.get(name, (0, 0, 0, 0))
        dx, dy = self.offsets.get(name, (0, 0))
        return bx + dx, by + dy, bw, bh

    def eval_expr(self, ast, row=None):
        if not isinstance(ast, dict):
            return ast
        if "runtime" in ast and len(ast) == 1:
            return self.eval_expr(ast["runtime"], row=row)
        kind = ast.get("kind")
        if kind == "literal":
            return ast["value"]
        if kind == "variable" or "variable" in ast:
            return self.variables.get(ast.get("name", ast.get("variable")), "")
        if kind == "widget":
            acc = ast.get("accessor")
            if acc == "state":
                return self.panels.get(ast["name"], {}).get("current", "")
            if acc in WIDGET_GEOM_ACCESSORS:
                rx, ry, rw, rh = self._widget_rect(ast["name"])
                if acc in ("x", "left"): return rx
                if acc in ("y", "top"): return ry
                if acc == "right": return rx + rw
                if acc == "bottom": return ry + rh
                if acc == "width": return rw
                if acc == "height": return rh
            w = self.widgets.get(ast["name"], {})
            return w.get("checked", w.get("selected", False)) if acc in {"checked", "selected"} else w.get("text", "")
        if kind in ("item", "caller_item"):
            if row is not None and ast["field"] in row:
                return row[ast["field"]]
            vrows = self.visible_rows(ast["repeater"])
            if vrows:
                return vrows[0].get(ast["field"], "")
            return {"text": "", "number": 0, "boolean": False}.get(ast.get("valueType"), "")
        if kind == "aggregate-scan":
            for aggregate in ast["aggregates"]:
                if aggregate["whereAst"] is None or bool(self.eval_expr(aggregate["whereAst"], row=row)):
                    self.variables[aggregate["name"]] += self.eval_expr(aggregate["valAst"], row=row)
            return False
        if kind == "selection-scan":
            for assign in ast.get("assignments", []):
                if assign.get("whereAst") is None or bool(self.eval_expr(assign["whereAst"], row=row)):
                    val = self.eval_expr(assign["valAst"], row=row)
                    s_val = str(val).lower() if type(val) is bool else (str(int(val)) if type(val) is float and val.is_integer() else str(val))
                    self.variables[assign["variable"]] = s_val
            return False
        if kind == "binary" or ("op" in ast and "left" in ast and "right" in ast):
            l, r = self.eval_expr(ast["left"], row=row), self.eval_expr(ast["right"], row=row)
            op = ast["op"]
            if op == "&&": return bool(l and r)
            if op == "||": return bool(l or r)
            if op == "+": return l + r
            if op == "-": return l - r
            if op == "*": return l * r
            if op == "/": return (l / r) if r != 0 else 0
            if op == "==": return l == r
            if op == "!=": return l != r
            if op == ">": return l > r
            if op == "<": return l < r
            if op == ">=": return l >= r
            if op == "<=": return l <= r
        if kind == "call":
            fn = ast["fn"]
            if fn in ("isOver", "isNotOver"):
                ax, ay, aw, ah = self._widget_rect(ast["args"][0]["name"])
                bx, by, bw, bh = self._widget_rect(ast["args"][1]["name"])
                over = (ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by)
                return over if fn == "isOver" else not over
            args = [self.eval_expr(a, row=row) for a in ast.get("args", [])]
            if fn == "text":
                v = args[0]
                return str(v).lower() if type(v) is bool else str(int(v)) if type(v) is float and v.is_integer() else str(v)
            if fn == "concat": return "".join(str(a) for a in args)
            if fn == "lower": return str(args[0]).lower()
            if fn == "upper": return str(args[0]).upper()
            if fn == "length": return len(str(args[0]).encode("utf-16-le")) // 2
            if fn == "fixed": return fixed_decimal(*args)
            if fn == "nowMs": return self.time_ms
            if fn == "contains": return args[1] in args[0]
            if fn == "remove": return args[0].replace(args[1], "", 1)
            if fn == "not": return not bool(args[0])
            if fn == "number":
                v = args[0]
                if type(v) in (int, float) and not isinstance(v, bool): return v
                s = str(v).strip()
                if re.fullmatch(r"0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+", s): return int(s, 0)
                try:
                    num = float(s) if s else 0
                    return 0 if math.isnan(num) else (int(num) if num.is_integer() else num)
                except ValueError: return 0
        return ""

    def resolve_trigger_name(self, ref_or_name):
        if not isinstance(ref_or_name, str) or not ref_or_name:
            fail("E_REFERENCE", "/", "Trigger must be a nonempty widget identity")
        if ref_or_name == "page":
            return "page"
        if ref_or_name in self.symbols_by_name:
            return ref_or_name
        if ref_or_name in self.symbols_by_id:
            return self.symbols_by_id[ref_or_name]["name"]
        pref = self.current_page + "/" + ref_or_name
        if pref in self.symbols_by_id:
            return self.symbols_by_id[pref]["name"]
        matches = [
            s["name"] for s in self.ir["symbols"]
            if s["pageId"] == self.current_page and (
                s["id"].endswith("/" + ref_or_name)
                or s["id"].replace("/item/", "/") in (ref_or_name, pref)
                or s["id"].replace("/item/", "/").endswith("/" + ref_or_name)
            )
        ]
        if len(matches) == 1:
            return matches[0]
        fail("E_REFERENCE", "/", f"Unknown trigger '{ref_or_name}' on page '{self.current_page}'")

    def _run_page_load(self, page_slug, reset=False):
        page = self.pages_by_slug[page_slug]
        if reset:
            page_repeaters = {name for name, repeater in self.repeaters.items() if repeater["page"] == page_slug}
            self.row_widgets = {key: value for key, value in self.row_widgets.items() if key[0] not in page_repeaters}
            self._index_tree(page["root"], page_slug, None)
        for ix in page["interactions"]:
            if ix["trigger"] == "page":
                self._exec_events(ix, "OnLoad", row=None, reason="page-load")
            elif ix["trigger"] in self.repeaters:
                vrows = self.visible_rows(ix["trigger"])
                for r_idx, row in enumerate(vrows):
                    self._exec_events(ix, "OnItemLoad", row=row, reason="row-load", row_index=r_idx)
            else:
                self._exec_events(ix, "OnLoad", row=None, reason="widget-load")

    def _exec_events(self, interaction, native_event, row=None, reason="user-event", row_index=None):
        if self.event_depth >= 64:
            fail("E_RUNTIME_LIMIT", interaction.get("sourcePointer", "/"), "Reference event recursion exceeded 64 nested events")
        self.event_depth += 1
        prev_trigger = self.current_trigger
        self.current_trigger = interaction.get("trigger")
        try:
            return self._exec_event_cases(interaction, native_event, row, reason, row_index=row_index)
        finally:
            self.current_trigger = prev_trigger
            self.event_depth -= 1

    def _exec_event_cases(self, interaction, native_event, row, reason, row_index=None):
        fired_cases = []
        event_page = self.current_page
        for ev in interaction.get("events", []):
            if ev["event"] != native_event:
                continue
            chain_matched = False
            for idx, case in enumerate(ev.get("cases", [])):
                if case.get("isNewIfGroup", idx == 0):
                    chain_matched = False
                cond_type = case.get("condition")
                if cond_type == "else":
                    should_run = not chain_matched
                elif "when" in case:
                    if cond_type == "else-if" and chain_matched:
                        should_run = False
                    else:
                        should_run = bool(self.eval_expr(case["when"], row=row))
                else:
                    should_run = True
                if should_run:
                    chain_matched = True
                    fired_cases.append((interaction["trigger"], native_event, idx))
                    if len(self.execution_trace) >= 10000:
                        fail("E_RUNTIME_LIMIT", interaction.get("sourcePointer", "/"), "Reference execution exceeded 10000 case firings")
                    self.execution_trace.append({"page": event_page, "trigger": interaction["trigger"], "event": native_event, "case": idx, "reason": reason})
                    case_actions = case.get("actions", [])
                    # Axure coalesces repeater refreshes after the last data action
                    # for that target, rather than reloading rows after every action.
                    last_refresh = {}
                    for position, act in enumerate(case_actions):
                        if act["type"].startswith("data-"):
                            last_refresh[act["target"]] = position
                    for position, act in enumerate(case_actions):
                        self._exec_action(act, row=row, row_index=row_index, defer_refresh=True)
                        if act["type"].startswith("data-") and last_refresh[act["target"]] == position:
                            self._refresh_repeater(act["target"])
        return fired_cases

    def _refresh_repeater(self, target):
        if target not in self.repeaters:
            return
        for k in [k for k in self.row_widgets if k[0] == target]:
            del self.row_widgets[k]
        vrows = self._compute_visible_rows(target)
        for interaction in self.pages_by_slug[self.current_page]["interactions"]:
            if interaction["trigger"] == target:
                for r_idx, row in enumerate(vrows):
                    self._exec_events(interaction, "OnItemLoad", row=row, reason="data-refresh", row_index=r_idx)

    def _set_panel_state(self, target, state, row, row_index):
        panel = self.panels[target]
        if state != panel["current"]:
            panel["current"] = state
            return self.trigger(target, "OnPanelStateChange", row=row, row_index=row_index)
        return []

    def _progress_panel(self, act, row, row_index, skip_first=False):
        target = act["target"]
        panel = self.panels[target]
        states = panel["states"]
        direction = 1 if act["stateMode"] == "next" else -1
        index = states.index(panel["current"]) + direction
        if not 0 <= index < len(states) and not act.get("loop"):
            self.panel_repeats.pop(target, None)
            return []
        if act.get("repeat"):
            durations = [act.get(phase + "Duration", 500) for phase in ("enter", "exit")
                         if act.get(phase + "Animation", "none") != "none"]
            delay = max([act["repeatInterval"], *durations])
            self.panel_repeats[target] = (self.time_ms + delay, act, row, row_index)
        if not skip_first:
            return self._set_panel_state(target, states[index % len(states)], row, row_index)
        return []

    def advance(self, milliseconds):
        if type(milliseconds) is not int or milliseconds < 0:
            fail("E_ARGUMENT", "/advanceMs", "advanceMs must be a nonnegative integer")
        until = self.time_ms + milliseconds
        fired = []
        for _ in range(10000):
            target = min(self.panel_repeats, key=lambda k: self.panel_repeats[k][0], default=None)
            if target is None or self.panel_repeats[target][0] > until:
                self.time_ms = until
                return fired
            self.time_ms, act, row, row_index = self.panel_repeats.pop(target)
            fired.extend(self._progress_panel(act, row, row_index))
        fail("E_RUNTIME_LIMIT", "/advanceMs", "Reference execution exceeded 10000 timer ticks")

    def _clamp_bounds(self, target, dx, dy, bounds, row=None):
        if not bounds:
            return dx, dy
        bx, by, bw, bh = self.base_rects.get(target, (0, 0, 0, 0))
        nx, ny = bx + dx, by + dy
        for b in bounds:
            side, op = b["side"], b["op"]
            val = self.eval_expr(b["value"], row=row)
            if type(val) not in (int, float) or isinstance(val, bool):
                continue
            if side == "left":
                if op in (">=", ">"):
                    if nx < val: nx = val
                elif op in ("<=", "<"):
                    if nx > val: nx = val
            elif side == "right":
                if op in ("<=", "<"):
                    if nx + bw > val: nx = val - bw
                elif op in (">=", ">"):
                    if nx + bw < val: nx = val - bw
            elif side == "top":
                if op in (">=", ">"):
                    if ny < val: ny = val
                elif op in ("<=", "<"):
                    if ny > val: ny = val
            elif side == "bottom":
                if op in ("<=", "<"):
                    if ny + bh > val: ny = val - bh
                elif op in (">=", ">"):
                    if ny + bh < val: ny = val - bh
        return nx - bx, ny - by

    def _move_with_drag(self, target, act, row=None):
        mode = act["mode"]
        bounds = act.get("bounds")
        cur_off = self.offsets.get(target, (0, 0))
        if mode == "locationBeforeDrag":
            if target in self.drag_origins:
                new_off = self.drag_origins[target]
                self.offsets[target] = new_off
                self.last_move_delta[target] = (new_off[0] - cur_off[0], new_off[1] - cur_off[1])
            return
        if mode in ("drag", "drag-x", "drag-y"):
            x, y = self.drag_origins.setdefault(target, cur_off)
            dx, dy = self.drag_delta
            nx = x + (0 if mode == "drag-y" else dx)
            ny = y + (0 if mode == "drag-x" else dy)
        elif mode == "withThis":
            self.drag_origins.setdefault(target, cur_off)
            tdx, tdy = self.last_move_delta.get(self.current_trigger, self.drag_delta)
            nx, ny = cur_off[0] + tdx, cur_off[1] + tdy
        elif mode == "location":
            bx, by, _, _ = self.base_rects.get(target, (0, 0, 0, 0))
            tx = self.eval_expr(act["xRuntime"], row=row) if "xRuntime" in act else act.get("x", bx + cur_off[0])
            ty = self.eval_expr(act["yRuntime"], row=row) if "yRuntime" in act else act.get("y", by + cur_off[1])
            nx, ny = tx - bx, ty - by
        elif mode == "delta":
            ddx = self.eval_expr(act["xRuntime"], row=row) if "xRuntime" in act else act.get("x", 0)
            ddy = self.eval_expr(act["yRuntime"], row=row) if "yRuntime" in act else act.get("y", 0)
            nx, ny = cur_off[0] + ddx, cur_off[1] + ddy
        else:
            return
        new_off = self._clamp_bounds(target, nx, ny, bounds, row=row)
        self.offsets[target] = new_off
        self.last_move_delta[target] = (new_off[0] - cur_off[0], new_off[1] - cur_off[1])

    def _exec_action(self, act, row=None, row_index=None, defer_refresh=False):
        kind = act["type"]
        target = act.get("target")
        if kind == "set-text":
            val = self.eval_expr(act["runtime"], row=row) if "runtime" in act else act.get("text", "")
            if target in self.widgets:
                self.widgets[target]["text"] = str(val)
                rep_n = self.widgets[target].get("repeater")
                if rep_n and row_index is not None:
                    rw = self._get_row_widget(rep_n, row_index, target)
                    if rw is not None:
                        rw["text"] = str(val)
        elif kind == "set-check":
            val = self.eval_expr(act["runtime"], row=row) if "runtime" in act else act.get("checked", False)
            self._set_checked(target, bool(val))
        elif kind == "set-selected":
            val = self.eval_expr(act["runtime"], row=row) if "runtime" in act else act.get("value", "")
            self._set_option(target, str(val))
        elif kind == "set-variable":
            val = self.eval_expr(act["runtime"], row=row) if "runtime" in act else act.get("value")
            self.variables[act["variable"]] = val
        elif kind == "set-panel-state" and target in self.panels:
            self.panel_repeats.pop(target, None)
            if act.get("stateMode") in ("next", "previous"):
                self._progress_panel(act, row, row_index or 0, act.get("repeat") and act.get("repeatSkipFirst", True))
            elif act.get("state") in self.panels[target]["states"]:
                self._set_panel_state(target, act["state"], row, row_index or 0)
        elif kind == "move":
            self._move_with_drag(target, act, row=row)
        elif kind == "raise-event":
            ev_name = "OnPanelStateChange" if act.get("eventType") == 278 else "OnClick"
            self.trigger(target, ev_name, row=row, row_index=row_index or 0, raised=True)
        elif kind in ("show", "hide", "toggle"):
            if target in self.widgets:
                rep_n = self.widgets[target].get("repeater")
                if rep_n and row_index is not None:
                    rw = self._get_row_widget(rep_n, row_index, target)
                    if rw is not None:
                        rw["visible"] = True if kind == "show" else False if kind == "hide" else not rw["visible"]
                        self.widgets[target]["visible"] = rw["visible"]
                else:
                    self.widgets[target]["visible"] = True if kind == "show" else False if kind == "hide" else not self.widgets[target]["visible"]
        elif kind in ("enable", "disable"):
            if target in self.widgets:
                rep_n = self.widgets[target].get("repeater")
                if rep_n and row_index is not None:
                    rw = self._get_row_widget(rep_n, row_index, target)
                    if rw is not None:
                        rw["enabled"] = (kind == "enable")
                self.widgets[target]["enabled"] = (kind == "enable")
        elif kind == "focus":
            self.focused_widget = target
        elif kind == "rotate" and target in self.widgets:
            widget = self.widgets[target]
            angle = act.get("degree", 90)
            widget["rotation"] = angle if act.get("rotateType") == "location" else widget["rotation"] + angle
        elif kind == "link":
            dest_slug = self.pages_by_name.get(act.get("page"), act.get("page"))
            if dest_slug in self.pages_by_slug:
                self.panel_repeats.clear()
                self.drag_origins.clear()
                self.offsets = {name: pos for name, pos in self.offsets.items()
                                if self.widgets[name]["page"] != dest_slug}
                self.current_page = dest_slug
                self._run_page_load(dest_slug, reset=True)
        elif kind == "data-add" and target in self.repeaters:
            rep = self.repeaters[target]
            cols = act.get("columns", list(rep["model"].keys()))
            for r_cells in act.get("rows", []):
                new_row = {col: self.eval_expr(cell.get("runtime", cell), row=row) for col, cell in zip(cols, r_cells)}
                rep["rows"].append(new_row)
        elif kind == "data-delete" and target in self.repeaters:
            rep = self.repeaters[target]
            rep["rows"] = [r for r in rep["rows"] if not bool(self.eval_expr(act["predicate"], row=r))]
        elif kind == "data-update" and target in self.repeaters:
            rep = self.repeaters[target]
            for r in rep["rows"]:
                if bool(self.eval_expr(act["predicate"], row=r)):
                    for u in act.get("updates", []):
                        r[u["column"]] = self.eval_expr(u["runtime"], row=r)
        elif kind == "data-filter" and target in self.repeaters:
            self.repeaters[target]["filters"] = {act.get("label", "default_filter"): act["predicate"]}
            self.repeaters[target]["page_num"] = 1
        elif kind == "data-clear-filter" and target in self.repeaters:
            self.repeaters[target]["filters"].clear()
            self.repeaters[target]["page_num"] = 1
        elif kind == "data-sort" and target in self.repeaters:
            self.repeaters[target]["sort"] = {"column": act["column"], "ascending": act.get("ascending", True)}
        elif kind == "data-clear-sort" and target in self.repeaters:
            self.repeaters[target]["sort"] = None
        elif kind == "data-page" and target in self.repeaters:
            rep = self.repeaters[target]
            pt, pv = act.get("pageType"), act.get("page", "1")
            if pt == "next": rep["page_num"] += 1
            elif pt == "previous": rep["page_num"] = max(1, rep["page_num"] - 1)
            elif pt == "last":
                ps = max(1, rep["page_size"] or len(rep["rows"]) or 1)
                rep["page_num"] = max(1, (len(rep["rows"]) + ps - 1) // ps)
            else:
                rep["page_num"] = max(1, int(pv))
        if kind.startswith("data-") and not defer_refresh:
            self._refresh_repeater(target)

    def _set_checked(self, name, checked):
        widget = self.widgets[name]
        if not widget["enabled"]: return []
        group = widget.get("group") if widget["kind"] == "radio" else widget.get("selectionGroup")
        if checked and group:
            for other_name, other in self.widgets.items():
                other_group = other.get("group") if other["kind"] == "radio" else other.get("selectionGroup")
                same_kind = (other["kind"] == "radio") == (widget["kind"] == "radio")
                if other_name != name and same_kind and other["page"] == widget["page"] and other_group == group:
                    self._set_checked(other_name, False)
        changed = widget["selected"] != checked
        widget["selected"] = checked
        if widget["kind"] in CHECK_KINDS: widget["checked"] = checked
        return self.trigger(name, "OnSelectedChange") if changed else []

    def _set_option(self, name, value):
        widget = self.widgets[name]
        if value not in widget["options"]:
            fail("E_OPTIONS", "/", "Selected option must exist on the target")
        changed = widget["text"] != value
        widget["text"] = value
        widget["selectedIndices"] = [widget["options"].index(value)]
        return self.trigger(name, "OnSelectionChange") if changed else []

    def set_input(self, target_id_or_name, text):
        tname = self.resolve_trigger_name(target_id_or_name)
        if tname not in self.widgets or self.widgets[tname]["kind"] not in FORM_KINDS:
            fail("E_TARGET_TYPE", "/", "Input step requires a native form control")
        if not self.is_operable(tname):
            return []
        kind = self.widgets[tname]["kind"]
        if kind in CHECK_KINDS:
            if type(text) is not bool: fail("E_TYPE", "/", "Checkbox/radio input steps require boolean values")
            return self._set_checked(tname, text)
        if kind in OPTION_KINDS: return self._set_option(tname, str(text))
        text = str(text)
        limit = self.widgets[tname].get("maxLength")
        if limit is not None:
            text = text.encode("utf-16-le", errors="surrogatepass")[:limit * 2].decode("utf-16-le", errors="ignore")
        self.widgets[tname]["text"] = text
        return self.trigger(tname, "change")

    def trigger(self, target_id_or_name, event="click", row_index=0, row=None, dx=0, dy=0, *, raised=False):
        native_ev = EVENTS.get(event, event)
        tname = self.resolve_trigger_name(target_id_or_name)
        kind = self.widgets.get(tname, {}).get("kind")
        if event == "change":
            if kind in CHECK_KINDS: native_ev = "OnSelectedChange"
            elif kind in OPTION_KINDS: native_ev = "OnSelectionChange"
        if native_ev not in EVENTS.values() and native_ev != "OnItemLoad":
            fail("E_EVENT", "/", f"Unsupported reference event '{event}'")
        page = self.pages_by_slug[self.current_page]
        if not raised and tname != "page" and native_ev not in {"OnLoad", "OnItemLoad", "OnPanelStateChange"} and not self.is_operable(tname, row_index):
            return []
        if row is None and tname in self.widgets and self.widgets[tname].get("repeater"):
            vrows = self.visible_rows(self.widgets[tname]["repeater"])
            if 0 <= row_index < len(vrows):
                row = vrows[row_index]
            else:
                return []
        if not raised and native_ev == "OnClick" and kind in CHECK_KINDS:
            self._set_checked(tname, True if kind == "radio" else not self.widgets[tname]["checked"])
        if native_ev == "OnFocus": self.focused_widget = tname
        elif native_ev == "OnLostFocus" and self.focused_widget == tname: self.focused_widget = None
        if native_ev == "OnDragStart":
            self.drag_origins.clear()
        if native_ev == "OnDrag":
            if any(type(value) not in (int, float) or not math.isfinite(value) for value in (dx, dy)):
                fail("E_ARGUMENT", "/", "Drag dx and dy must be finite numbers")
            self.drag_delta = (dx, dy)
        fired = []
        try:
            for ix in page["interactions"]:
                if ix["trigger"] == tname:
                    fired.extend(self._exec_events(ix, native_ev, row=row, reason="raised-event" if raised else "input-change" if native_ev == "OnTextChange" else "panel-state-change" if native_ev == "OnPanelStateChange" else "user-event", row_index=row_index))
        finally:
            if native_ev == "OnDragDrop":
                self.drag_origins.clear()
        return fired

    def execution_state(self):
        """All mutable semantics that can affect the next transition, across pages."""
        return {"page": self.current_page, "variables": copy.deepcopy(self.variables),
                "widgets": copy.deepcopy(self.widgets), "panels": copy.deepcopy(self.panels),
                "rowWidgets": {f"{k[0]}:{k[1]}:{k[2]}": copy.deepcopy(v) for k, v in self.row_widgets.items()},
                "repeaters": {name: {k:copy.deepcopy(v) for k,v in rep.items() if k != "template"} for name,rep in self.repeaters.items()},
                "focusedWidget": self.focused_widget,
                **({"offsets": copy.deepcopy(self.offsets)} if self.offsets else {}),
                **({"dragOrigins": copy.deepcopy(self.drag_origins)} if self.drag_origins else {}),
                **({"panelRepeats": {key: (timer[0] - self.time_ms, *copy.deepcopy(timer[1:]))
                                     for key, timer in self.panel_repeats.items()}} if self.panel_repeats else {})}

    def snapshot(self):
        snap = {
            "page": self.current_page,
            "variables": copy.deepcopy(self.variables),
            "panels": {k: v["current"] for k, v in self.panels.items() if v["page"] == self.current_page},
            "widgets": {k: {"text": v["text"], "visible": v["visible"], "enabled": v["enabled"],
                            **({"checked": v["checked"]} if v["kind"] in CHECK_KINDS else {}),
                            **({"selectedIndices": v["selectedIndices"]} if v["kind"] in OPTION_KINDS else {}),
                            "selected": v["selected"],
                            **(dict(zip(("dx", "dy"), self.offsets[k])) if k in self.offsets else {})}
                        for k, v in self.widgets.items() if v["page"] == self.current_page},
            "repeaters": {k: self.visible_rows(k) for k, v in self.repeaters.items() if v["page"] == self.current_page},
        }
        if self.row_widgets:
            rw_map = {}
            for (rep_n, r_idx, wname), rw in self.row_widgets.items():
                if rep_n in self.repeaters and self.repeaters[rep_n]["page"] == self.current_page:
                    rep_short = self.symbols_by_name.get(rep_n, {}).get("id", rep_n).rsplit("/", 1)[-1]
                    w_short = self.symbols_by_name.get(wname, {}).get("id", wname).rsplit("/", 1)[-1]
                    for rk in {rep_n, rep_short}:
                        row_dict = rw_map.setdefault(rk, {}).setdefault(str(r_idx), {})
                        row_dict[wname] = copy.deepcopy(rw)
                        row_dict[w_short] = copy.deepcopy(rw)
            if rw_map:
                snap["rowWidgets"] = rw_map
        return snap
