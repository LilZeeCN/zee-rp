# 从 scripts/rp_language.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 2;行为不变,勿手改)。
from rp_icons import ICON_NAMES
import copy
import difflib
from rp_product import expand_product_spec, compute_product_impact
import hashlib
import math
import re
import string
from .core import ACTION_PROPS, BOX_ALIGN_ALIASES, BOX_TEXT_CONTAINER_KEYS, BOX_TEXT_STYLE_KEYS, CARD_CONTENT_KEYS, CHECK_KINDS, COLOR_TOKENS, DEVICE_CANVAS_PRESETS, EVENTS, EVENT_SHORTHANDS, FORM_KINDS, GEOMETRY, INLINE_EXPR_HINT_RE, JUSTIFY_ALIASES, LanguageError, MACRO_ITEM_PROPS, MACRO_PROPS, MACRO_SLOTS, NODE_PROPS, NODE_SOURCE_ALIASES, OPTION_KINDS, SCALARS, SHORTHAND_NODE_KINDS, STATE_STYLE_KEYS, TEXT_ALIGN_ALIASES, THEMES, _estimate_visual_px, _resolve_pointer, are_when_asts_mutually_exclusive, expand_data_table_macro, expand_detail_card_macro, expand_form_card_macro, expand_kv_list_macro, expand_list_item_macro, expand_master_detail_macro, expand_nav_bar_macro, expand_phone_shell_macro, expand_progress_bar_macro, expand_searchable_list_macro, expand_stat_row_macro, expand_tab_bar_macro, expand_wizard_card_macro, fail, fields, ident, normalize_color_token, normalize_font_weight, normalize_panel_state_dict, normalize_panel_states_in_tree, parse_domain_type, parse_font_shorthand, parse_inline_expr, parse_template_string, ptr, sanitize_dingbats, validate_device, validate_font_size, validate_source_tree, validate_statecharts

class Frontend:
    def __init__(self, spec):
        validate_source_tree(spec)
        self.raw_spec = copy.deepcopy(spec)
        self.spec = copy.deepcopy(spec)
        self.models = {}
        self.domain_models = {}
        self.datasets = {}
        self.components = {}
        self.variables = {}
        self.computed_vars = {}
        self.symbols = {}
        self.identity_labels = {}
        self.pages = {}
        self.pending = []
        self.repeaters = {}
        self.value_bindings = []
        self.progress_bindings = []
        self.row_conditionals = []
        self.page_conditionals = []
        self.initial_hidden_nodes = []
        self.input_rotations = []
        self.passthrough_layers = {}
        self.source_origins = {}
        self.macro_calls = {}
        self.bridge_ops = {}
        self.bridge_var_counter = 0
        self.when_group_counter = 0
        self.current_trigger_name = None
        self.product_provenance = None
        self.declarative_rules = {}
        self.compiled_selection_views = []
        self.page_master_placements = {}
        self.desugar_spec()

    def _compile_declarative_rule_cases(self, rule_id, rule_obj, extra_actions=None):
        if not isinstance(rule_obj, dict):
            return []
        effect = rule_obj.get("effect") if isinstance(rule_obj.get("effect"), dict) else {}
        fb_target = (
            rule_obj.get("feedback")
            or rule_obj.get("errorTarget")
            or effect.get("feedback")
            or next(iter((effect.get("setText") or effect.get("widgets") or {}).keys()), None)
        )
        req_parts = []
        for req in (rule_obj.get("require") or []):
            if isinstance(req, str) and req.strip():
                r_clean = req.strip()
                if r_clean.startswith(("$", "@")):
                    req_parts.append(f"length({r_clean}) > 0")
                else:
                    req_parts.append(f"length(@{r_clean}) > 0")
        raw_guards = []
        if "guard" in rule_obj and rule_obj["guard"] is not None:
            raw_guards.append(rule_obj["guard"])
        if isinstance(rule_obj.get("guards"), list):
            raw_guards.extend(rule_obj["guards"])
        guard_parts = list(req_parts)
        guard_fail_cases = []
        err_msg = rule_obj.get("errorMessage", effect.get("errorMessage"))
        if req_parts and fb_target and err_msg is not None:
            neg_reqs = " || ".join(p.replace("> 0", "== 0") for p in req_parts)
            guard_fail_cases.append({"when": f"={neg_reqs}", "actions": [{"type": "set-text", "target": fb_target.lstrip("@"), "text": err_msg}]})
        for g in raw_guards:
            g_str = g.get("assert", g.get("when", g.get("expr", ""))) if isinstance(g, dict) else g
            g_msg = g.get("message", g.get("errorMessage")) if isinstance(g, dict) else None
            if isinstance(g_str, str) and g_str.strip():
                gs = g_str.strip()
                if gs.startswith("=") and not gs.startswith("=="):
                    gs = gs[1:].strip()
                guard_parts.append(f"({gs})")
                if fb_target and g_msg is not None:
                    guard_fail_cases.append({"when": f"=!({gs})", "actions": [{"type": "set-text", "target": fb_target.lstrip("@"), "text": g_msg}]})
        when_expr = ("=" + " && ".join(guard_parts)) if guard_parts else None
        then_actions = []
        target_rep = effect.get("target") or rule_obj.get("target")
        where_expr = effect.get("where") or rule_obj.get("where") or "=true"
        upd_set = dict(effect.get("set") or {})
        if "status" in effect:
            upd_set[effect.get("statusField", "status")] = effect["status"]
        if "transitionTo" in effect:
            upd_set[effect.get("statusField", "status")] = effect["transitionTo"]
        if upd_set and target_rep:
            then_actions.append({
                "type": "data-update",
                "target": target_rep,
                "where": where_expr,
                "set": upd_set,
            })
        if "dataAdd" in effect or "add" in effect:
            add_spec = effect.get("dataAdd") or effect.get("add")
            add_target = add_spec.get("target", target_rep) if isinstance(add_spec, dict) and "rows" in add_spec else target_rep
            add_rows = add_spec.get("rows", [add_spec]) if isinstance(add_spec, dict) and "rows" in add_spec else (add_spec if isinstance(add_spec, list) else [add_spec])
            if add_target:
                then_actions.append({"type": "data-add", "target": add_target, "rows": add_rows})
        if "dataDelete" in effect or "delete" in effect:
            del_spec = effect.get("dataDelete") or effect.get("delete")
            del_where = del_spec if isinstance(del_spec, str) else where_expr
            if target_rep:
                then_actions.append({"type": "data-delete", "target": target_rep, "where": del_where})
        if "excludeFrom" in effect:
            ex_targets = effect["excludeFrom"] if isinstance(effect["excludeFrom"], list) else [effect["excludeFrom"]]
            ex_status = effect.get("status") or effect.get("transitionTo") or upd_set.get("status")
            status_col = effect.get("statusField", "status")
            ex_where = effect.get("filterWhere") or (f'=item.{status_col} != "{ex_status}"' if ex_status else "=true")
            for ex_t in ex_targets:
                then_actions.append({
                    "type": "data-filter",
                    "target": ex_t,
                    "name": f"rule_{rule_id}_exclude",
                    "where": ex_where,
                })
        for vk, vv in (effect.get("variables") or effect.get("setVariables") or {}).items():
            then_actions.append({"type": "set-variable", "variable": vk.lstrip("$"), "value": vv})
        for wk, wv in (effect.get("setText") or effect.get("widgets") or {}).items():
            then_actions.append({"type": "set-text", "target": wk.lstrip("@"), "text": wv})
        st_spec = effect.get("panelState") or effect.get("state")
        if isinstance(st_spec, dict):
            for pk, pv in st_spec.items():
                then_actions.append({"type": "set-panel-state", "target": pk.lstrip("@"), "state": pv})
        if isinstance(effect.get("actions"), list):
            then_actions.extend(copy.deepcopy(effect["actions"]))
        succ_msg = rule_obj.get("successMessage", effect.get("successMessage"))
        if fb_target and succ_msg is not None:
            then_actions.append({"type": "set-text", "target": fb_target.lstrip("@"), "text": succ_msg})
        if extra_actions:
            then_actions.extend(copy.deepcopy(extra_actions))
        if "goto" in effect:
            then_actions.append({"type": "link", "page": effect["goto"]})
        else_actions = []
        if fb_target and err_msg is not None and not guard_fail_cases:
            else_actions.append({"type": "set-text", "target": fb_target.lstrip("@"), "text": err_msg})
        if isinstance(rule_obj.get("elseActions"), list):
            else_actions.extend(copy.deepcopy(rule_obj["elseActions"]))
        if when_expr:
            cases = [*guard_fail_cases, {"when": when_expr, "actions": then_actions}]
            if else_actions:
                cases.append({"else": True, "actions": else_actions})
            return cases
        return [{"actions": then_actions}]

    def desugar_spec(self):
        if not isinstance(self.spec, dict):
            return
        validate_device(self.spec, "")
        if "statecharts" in self.spec:
            validate_statecharts(self.spec["statecharts"])
        if isinstance(self.spec.get("product"), dict) and "statecharts" in self.spec["product"]:
            validate_statecharts(self.spec["product"]["statecharts"], "/product/statecharts")
        if isinstance(self.spec.get("product"), dict):
            expanded, prov = expand_product_spec(self.spec, fail, ident, fields, self.typecheck)
            self.spec.clear()
            self.spec.update(expanded)
            self.product_provenance = prov
        if "title" in self.spec:
            if "name" not in self.spec:
                self.spec["name"] = self.spec.pop("title")
            else:
                self.spec.pop("title", None)
        if "theme" not in self.spec and self.spec.get("domain") in ("web", "doc"):
            self.spec["theme"] = "enterprise-light"
        raw_models = self.spec.get("models")
        if isinstance(raw_models, dict):
            for mname, mdef in list(raw_models.items()):
                if isinstance(mdef, dict):
                    for fk, fval in list(mdef.items()):
                        scalar_t, dom_meta = parse_domain_type(fval, ptr(ptr("/models", mname), fk))
                        if dom_meta is not None:
                            self.domain_models.setdefault(mname, {})[fk] = dom_meta
                        if isinstance(scalar_t, str):
                            mdef[fk] = scalar_t
        if isinstance(self.spec.get("computed"), dict):
            comp_map = self.spec.pop("computed")
            raw_vars = self.spec.setdefault("variables", {})
            if isinstance(raw_vars, dict):
                for ck, cval in comp_map.items():
                    if isinstance(cval, dict) and "compute" in cval:
                        raw_vars[ck] = copy.deepcopy(cval)
                    elif isinstance(cval, dict) and "op" in cval:
                        raw_vars[ck] = {"type": "number", "compute": copy.deepcopy(cval)}
                    else:
                        raw_vars[ck] = {"type": "number", "compute": cval}
        raw_vars = self.spec.get("variables")
        if isinstance(raw_vars, dict):
            for k, v in list(raw_vars.items()):
                if type(v) is bool:
                    raw_vars[k] = {"type": "boolean", "value": v}
                elif type(v) in (int, float) and math.isfinite(v):
                    raw_vars[k] = {"type": "number", "value": v}
                elif type(v) is str:
                    if v.strip().startswith("=") and not v.strip().startswith("=="):
                        self.computed_vars[k] = {"compute": v.strip(), "pointer": ptr("/variables", k)}
                        raw_vars[k] = {"type": "number", "value": 0}
                    else:
                        raw_vars[k] = {"type": "text", "value": sanitize_dingbats(v)}
                elif isinstance(v, dict):
                    if "type" in v:
                        st, _ = parse_domain_type(v["type"], ptr(ptr("/variables", k), "type"))
                        v["type"] = st
                    if "compute" in v:
                        comp_spec = v.pop("compute")
                        vtype = v.get("type", "number")
                        v["type"] = vtype
                        v.setdefault("value", False if vtype == "boolean" else (0 if vtype == "number" else ""))
                        self.computed_vars[k] = {"compute": comp_spec, "type": vtype, "pointer": ptr("/variables", k)}
                    if isinstance(v.get("value"), str):
                        v["value"] = sanitize_dingbats(v["value"])
        raw_datasets = self.spec.get("datasets")
        if isinstance(raw_datasets, dict):
            models = self.spec.setdefault("models", {}) if isinstance(self.spec.get("models", {}), dict) else {}
            for dname, dval in list(raw_datasets.items()):
                rows = None
                if isinstance(dval, list) and dval and isinstance(dval[0], dict):
                    rows = dval
                    dval = {"rows": rows}
                    raw_datasets[dname] = dval
                elif isinstance(dval, dict) and "model" not in dval and isinstance(dval.get("rows"), list) and dval["rows"] and isinstance(dval["rows"][0], dict):
                    rows = dval["rows"]
                if rows is not None and isinstance(models, dict):
                    mname = dname if dname not in models else f"{dname}_model"
                    inferred = {}
                    for fk, fv in rows[0].items():
                        inferred[fk] = "boolean" if type(fv) is bool else "number" if type(fv) in (int, float) else "text"
                    models[mname] = inferred
                    dval["model"] = mname
                if isinstance(dval, dict) and isinstance(dval.get("rows"), list):
                    for r in dval["rows"]:
                        if isinstance(r, dict):
                            for rk, rv in list(r.items()):
                                if isinstance(rv, str):
                                    r[rk] = sanitize_dingbats(rv)
        raw_rules = self.spec.get("rules")
        if isinstance(raw_rules, dict):
            self.declarative_rules = copy.deepcopy(raw_rules)
        elif isinstance(raw_rules, list):
            for idx, r_item in enumerate(raw_rules):
                if isinstance(r_item, dict):
                    rid = r_item.get("id", f"rule_{idx + 1}")
                    self.declarative_rules[rid] = copy.deepcopy(r_item)
        raw_masters = self.spec.get("masters")
        if isinstance(raw_masters, dict):
            for m_def in raw_masters.values():
                if isinstance(m_def, dict):
                    normalize_panel_states_in_tree(m_def.get("root") or m_def.get("layout"))
        raw_comps = self.spec.get("components")
        if isinstance(raw_comps, dict):
            for c_def in raw_comps.values():
                if isinstance(c_def, dict):
                    normalize_panel_states_in_tree(c_def.get("root"))
        raw_pages = self.spec.get("pages")
        if isinstance(raw_pages, list):
            domain = self.spec.get("domain", "mobile")
            if self.spec.get("shell") in DEVICE_CANVAS_PRESETS and "device" not in self.spec:
                self.spec["device"] = self.spec["shell"]
            top_device = self.spec.get("device") if self.spec.get("device") in DEVICE_CANVAS_PRESETS else None
            default_canvas = {"w": 1440, "h": 900} if domain in ("web", "doc") else {"w": 375, "h": 812}
            for idx, page in enumerate(raw_pages):
                if isinstance(page, dict):
                    validate_device(page, ptr("/pages", idx))
                    if "slug" in page:
                        page.setdefault("id", page.pop("slug"))
                    if "name" not in page and isinstance(page.get("id"), str):
                        page["name"] = page["id"]
                    if "passthrough_layer" in page:
                        pid_key = page.get("id", f"page_{idx}")
                        self.passthrough_layers[pid_key] = copy.deepcopy(page.pop("passthrough_layer"))
                    if page.get("shell") in DEVICE_CANVAS_PRESETS:
                        page.setdefault("device", page.pop("shell"))
                    if "device" not in page:
                        def _find_shell_device(node):
                            if isinstance(node, dict):
                                if node.get("type") == "phone-shell" and isinstance(node.get("device"), str) and node["device"] in DEVICE_CANVAS_PRESETS:
                                    return node["device"]
                                for value in node.values():
                                    found = _find_shell_device(value)
                                    if found:
                                        return found
                            elif isinstance(node, list):
                                for value in node:
                                    found = _find_shell_device(value)
                                    if found:
                                        return found
                            return None
                        _shell_dev = _find_shell_device(page.get("root"))
                        if _shell_dev:
                            page["device"] = _shell_dev
                    if "device" not in page and top_device and page.get("domain", domain) not in ("web", "doc"):
                        page["device"] = top_device
                    if "canvas" not in page:
                        dev_preset = DEVICE_CANVAS_PRESETS.get(page.get("device"))
                        page["canvas"] = copy.deepcopy(dev_preset if dev_preset else default_canvas)
                    elif isinstance(page.get("canvas"), list) and len(page["canvas"]) == 2:
                        page["canvas"] = {"w": page["canvas"][0], "h": page["canvas"][1]}
                    if ("layout" in page or "children" in page) and "root" not in page:
                        lay_val = page.pop("layout") if "layout" in page else page.pop("children")
                        page["root"] = {
                            "type": "box",
                            "id": "root",
                            "layout": "column",
                            "w": "fill",
                            "h": "fill",
                            "padding": 24,
                            "gap": 16,
                            "children": lay_val if isinstance(lay_val, list) else [lay_val],
                        }
                    normalize_panel_states_in_tree(page.get("root"))
                    if "slot" in page:
                        normalize_panel_states_in_tree(page.get("slot"))
                    if "onLoad" in page:
                        page_path = ptr("/pages", idx)
                        events = page.get("on", {})
                        if not isinstance(events, dict):
                            fail("E_EVENT", ptr(page_path, "on"), "on must be an event map")
                        if "load" in events or "OnLoad" in events:
                            fail("E_EVENT", ptr(page_path, "onLoad"), "Duplicate event alias 'onLoad'")
                        page["on"] = {**events, "load": page.pop("onLoad")}
                    # P1-3a: Desugar page master / masters + slot
                    if isinstance(raw_masters, dict) and ("master" in page or "masters" in page):
                        m_refs = page.get("masters") if "masters" in page else [page["master"]]
                        if isinstance(m_refs, str):
                            m_refs = [m_refs]
                        placements, master_nodes = [], []
                        slots_injected = False
                        for m_item in (m_refs if isinstance(m_refs, list) else []):
                            m_id = m_item if isinstance(m_item, str) else m_item.get("master", m_item.get("id"))
                            m_x = 0 if isinstance(m_item, str) else m_item.get("x", 0)
                            m_y = 0 if isinstance(m_item, str) else m_item.get("y", 0)
                            m_def = raw_masters.get(m_id)
                            def contains_phone(node):
                                if isinstance(node, dict):
                                    return node.get("type") == "phone-shell" or "phone-shell" in node or any(contains_phone(v) for v in node.values())
                                return isinstance(node, list) and any(contains_phone(v) for v in node)
                            default_master_w = page["canvas"]["w"] if contains_phone(m_def) else 220
                            if isinstance(m_def, dict) and "root" not in m_def and isinstance(m_def.get("layout"), list):
                                m_def["root"] = {"column": m_id, "w": m_def.get("w", default_master_w), "h": m_def.get("h", page["canvas"]["h"]), "children": copy.deepcopy(m_def["layout"])}
                            if not isinstance(m_def, dict) or not isinstance(m_def.get("root"), dict):
                                fail("E_MASTER", ptr("/masters", m_id), "Master must exist and define a root or layout")
                            if isinstance(m_def, dict) and isinstance(m_def.get("root"), dict):
                                placements.append({
                                    "master": m_id,
                                    "name": m_def.get("name", m_id),
                                    "x": m_x,
                                    "y": m_y,
                                    "w": m_def.get("w", default_master_w),
                                    "h": m_def.get("h", page["canvas"]["h"]),
                                })
                                m_copy = copy.deepcopy(m_def["root"])
                                m_copy["_master_instance"] = m_id
                                def inject_slots(node):
                                    nonlocal slots_injected
                                    if not isinstance(node, dict):
                                        return
                                    node_id = node.get("id") or next((node[k] for k in SHORTHAND_NODE_KINDS if isinstance(node.get(k), str)), None)
                                    slots = page.get("slot")
                                    if isinstance(slots, dict) and node_id in slots:
                                        value = slots[node_id]
                                        content = value if isinstance(value, list) else [value]
                                        node["children"] = []
                                        for slot_index, child in enumerate(content):
                                            if not isinstance(child, dict):
                                                fail("E_MASTER", ptr(ptr(ptr("/pages", idx), "slot"), node_id), "Slot content must be a node or node array")
                                            origin = ptr(ptr(ptr("/pages", idx), "slot"), node_id)
                                            if isinstance(value, list):
                                                origin = ptr(origin, slot_index)
                                            node["children"].append({**copy.deepcopy(child), "_master_slot": True, "_slot_origin": origin})
                                        slots_injected = True
                                        return
                                    for child in node.get("children", []):
                                        inject_slots(child)
                                inject_slots(m_copy)
                                master_nodes.append(m_copy)
                        if placements:
                            self.page_master_placements[page.get("id", f"page_{idx}")] = placements
                        if slots_injected and "root" not in page:
                            page["root"] = {"type": "box", "id": f"{page['id']}_shell", "layout": "stack",
                                            "w": page["canvas"]["w"], "h": page["canvas"]["h"], "children": master_nodes}
                        elif "slot" in page and "root" not in page:
                            slot_map = page["slot"]
                            body_node = slot_map.get("body") if isinstance(slot_map, dict) and "body" in slot_map else (
                                next(iter(slot_map.values())) if isinstance(slot_map, dict) and slot_map else slot_map
                            )
                            if isinstance(body_node, list):
                                body_node = {
                                    "type": "box",
                                    "id": f"{page.get('id', f'page_{idx}')}_body",
                                    "layout": "column",
                                    "w": "fill",
                                    "h": "fill",
                                    "padding": 24,
                                    "gap": 16,
                                    "children": body_node,
                                }
                            first_m = raw_masters.get(placements[0]["master"], {}) if placements else {}
                            is_top_bar = first_m.get("direction") == "vertical" or (isinstance(first_m.get("h"), (int, float)) and first_m["h"] <= 120)
                            page["root"] = {
                                "type": "box",
                                "id": f"{page.get('id', f'page_{idx}')}_shell",
                                "layout": "column" if is_top_bar else "row",
                                "w": page["canvas"]["w"],
                                "h": page["canvas"]["h"],
                                "padding": 0,
                                "gap": 0,
                                "children": [*master_nodes, copy.deepcopy(body_node)],
                            }
                        elif "root" in page and isinstance(page["root"], dict) and master_nodes:
                            if isinstance(page["root"].get("children"), list):
                                page["root"]["children"] = [*master_nodes, *page["root"]["children"]]
            # Top-level tabBar auto-injection into each page's phone-shell (or root column)
            top_tab_bar = self.spec.get("tabBar")
            if top_tab_bar is not None and top_tab_bar is not False and not isinstance(top_tab_bar, (list, dict)):
                fail("E_TYPE", "/tabBar", "tabBar must be an array, object or false")
            if top_tab_bar is not None and isinstance(raw_pages, list):
                all_page_ids = {p.get("id") for p in raw_pages if isinstance(p, dict) and isinstance(p.get("id"), str)}
                for idx_tb, page in enumerate(raw_pages):
                    if not isinstance(page, dict) or page.get("tabBar") is False:
                        continue
                    pid_tb = page.get("id", f"page_{idx_tb}")
                    if isinstance(top_tab_bar, list):
                        tb_cfg = {"id": f"{pid_tb}_tabs", "active": pid_tb, "items": copy.deepcopy(top_tab_bar)}
                    elif isinstance(top_tab_bar, dict):
                        tb_cfg = copy.deepcopy(top_tab_bar)
                        tb_cfg["id"] = f"{pid_tb}_{tb_cfg.get('id', 'tabs')}"
                        tb_cfg.setdefault("active", pid_tb)
                    else:
                        continue
                    for arr_k in ("items", "tabs"):
                        if isinstance(tb_cfg.get(arr_k), list):
                            for item_idx, it in enumerate(tb_cfg[arr_k]):
                                item_path = ptr("/tabBar", item_idx) if isinstance(top_tab_bar, list) else ptr(ptr("/tabBar", arr_k), item_idx)
                                if isinstance(it, str):
                                    if it not in all_page_ids:
                                        fail("E_REFERENCE", item_path, "Tab target page does not exist")
                                    it = {"id": it, "text": it, "page": it}
                                    tb_cfg[arr_k][item_idx] = it
                                if isinstance(it, dict):
                                    orig_id = it.get("id")
                                    if not any(k in it for k in ("onClick", "on")):
                                        target = it.get("page", it.get("goto", it.get("link", orig_id)))
                                        if not isinstance(target, str) or target not in all_page_ids:
                                            fail("E_REFERENCE", item_path, "Tab target page does not exist")
                                    if not any(k in it for k in ("page", "goto", "link", "onClick", "on")) and orig_id in all_page_ids:
                                        it["page"] = orig_id
                                    if orig_id == pid_tb and tb_cfg.get("active") == pid_tb:
                                        it["active"] = True
                                    if isinstance(orig_id, str) and not orig_id.startswith("tab_"):
                                        it["id"] = f"tab_{orig_id}"
                    def _inject_tab_bar(node):
                        if not isinstance(node, dict):
                            return False
                        if node.get("type") == "phone-shell" or isinstance(node.get("phone-shell"), str):
                            if "tabBar" not in node:
                                node["tabBar"] = tb_cfg
                            return True
                        for ch in (node.get("children") or []):
                            if _inject_tab_bar(ch):
                                return True
                        return False
                    if isinstance(page.get("root"), dict):
                        if not _inject_tab_bar(page["root"]):
                            r_node = page["root"]
                            if isinstance(r_node.get("children"), list) and not any(
                                isinstance(c, dict) and (c.get("type") == "tab-bar" or "tab-bar" in c) for c in r_node["children"]
                            ):
                                r_node["children"].append({"type": "tab-bar", **tb_cfg})
            # P0-1: Desugar top-level and page-level `views` into runtime selection bindings
            def _collect_node_ids(node, out_set):
                if not isinstance(node, dict):
                    return
                for k in ("id", *SHORTHAND_NODE_KINDS):
                    if k in node and isinstance(node[k], str) and k != "type":
                        out_set.add(node[k])
                for ch in (node.get("children") if isinstance(node.get("children"), list) else []):
                    _collect_node_ids(ch, out_set)
                for st in (node.get("states") if isinstance(node.get("states"), list) else []):
                    if isinstance(st, dict):
                        _collect_node_ids(st.get("root"), out_set)
                if isinstance(node.get("template"), dict):
                    _collect_node_ids(node["template"], out_set)

            page_widget_ids = {}
            for page in raw_pages:
                if isinstance(page, dict) and isinstance(page.get("id"), str):
                    s_ids = set()
                    _collect_node_ids(page.get("root"), s_ids)
                    page_widget_ids[page["id"]] = s_ids

            def _normalize_view_entry(vid, vdef, default_page_id=None, view_path="/views"):
                if not isinstance(vdef, dict):
                    return None
                ds_name = vdef.get("source") or vdef.get("dataset")
                key_field = vdef.get("key", "id")
                sel_value = vdef.get("selector", vdef.get("variable", f"selected_{ds_name}"))
                if not isinstance(sel_value, str) or not sel_value:
                    fail("E_VARIABLE", view_path, "View selector must name a text variable")
                sel_var = sel_value.lstrip("$")
                if "selector" in vdef or "variable" in vdef:
                    vp = ptr(view_path, "selector" if "selector" in vdef else "variable")
                    declared = self.spec.get("variables", {}).get(sel_var, {})
                    if not isinstance(declared, dict) or declared.get("type") != "text":
                        fail("E_VARIABLE", vp, "View selector requires a declared text variable")
                    dataset = self.spec.get("datasets", {}).get(ds_name, {})
                    rows = dataset.get("rows", []) if isinstance(dataset, dict) else []
                    if not any(isinstance(row, dict) and row.get(key_field) == declared.get("value") for row in rows):
                        fail("E_VARIABLE", vp, "View selector default must identify an existing row")
                fields_map = vdef.get("fields") or vdef.get("targets") or {}
                target_page_id = vdef.get("page") or default_page_id
                if not target_page_id and fields_map:
                    first_target = next(iter(fields_map.keys())).lstrip("@")
                    for pid_cand, wset in page_widget_ids.items():
                        if first_target in wset:
                            target_page_id = pid_cand
                            break
                if not target_page_id and raw_pages:
                    target_page_id = raw_pages[-1].get("id")
                clean_targets = {k.lstrip("@"): v for k, v in fields_map.items()}
                return target_page_id, {
                    "dataset": ds_name,
                    "key": key_field,
                    "variable": sel_var,
                    "targets": clean_targets,
                    "mode": "runtime",
                    "_from_view": True,
                    "viewId": vid,
                }

            top_views = self.spec.get("views")
            normalized_views = []
            if isinstance(top_views, dict):
                for vid, vdef in top_views.items():
                    nv = _normalize_view_entry(vid, vdef, view_path=ptr("/views", vid))
                    if nv:
                        normalized_views.append(nv)
            elif isinstance(top_views, list):
                for idx_v, vdef in enumerate(top_views):
                    vid = vdef.get("id", f"view_{idx_v + 1}") if isinstance(vdef, dict) else f"view_{idx_v + 1}"
                    nv = _normalize_view_entry(vid, vdef, view_path=ptr("/views", idx_v))
                    if nv:
                        normalized_views.append(nv)
            for page_idx, page in enumerate(raw_pages):
                if not isinstance(page, dict):
                    continue
                p_views = page.get("views")
                if isinstance(p_views, dict):
                    for vid, vdef in p_views.items():
                        nv = _normalize_view_entry(vid, vdef, default_page_id=page.get("id"), view_path=ptr(ptr(ptr("/pages", page_idx), "views"), vid))
                        if nv:
                            normalized_views.append(nv)
                elif isinstance(p_views, list):
                    for idx_v, vdef in enumerate(p_views):
                        vid = vdef.get("id", f"view_{idx_v + 1}") if isinstance(vdef, dict) else f"view_{idx_v + 1}"
                        nv = _normalize_view_entry(vid, vdef, default_page_id=page.get("id"), view_path=ptr(ptr(ptr("/pages", page_idx), "views"), idx_v))
                        if nv:
                            normalized_views.append(nv)
            for target_pid, b_entry in normalized_views:
                for page in raw_pages:
                    if isinstance(page, dict) and page.get("id") == target_pid:
                        page.setdefault("bindings", []).append(b_entry)
                        break

            # P0-2: Expand declarative rules in widget events
            if self.declarative_rules:
                op_to_rule = {}
                widget_event_rules = {}
                for rid, robj in self.declarative_rules.items():
                    if not isinstance(robj, dict):
                        continue
                    w_trig = str(robj.get("when", "")).strip()
                    if w_trig.startswith("op."):
                        op_name = w_trig[3:].split("(")[0].strip()
                        op_to_rule[op_name] = (rid, robj)
                    elif "." in w_trig and (w_trig.startswith("@") or w_trig.split(".", 1)[0] in set().union(*page_widget_ids.values())):
                        w_part, ev_part = w_trig.lstrip("@").split(".", 1)
                        widget_event_rules.setdefault((w_part, ev_part), []).append((rid, robj))

                def _expand_rules_in_node(node):
                    if not isinstance(node, dict):
                        return
                    nid = node.get("id") or next((node[k] for k in SHORTHAND_NODE_KINDS if k in node and isinstance(node[k], str) and k != "type"), None)
                    if isinstance(nid, str):
                        for (w_target, ev_name), r_list in widget_event_rules.items():
                            if w_target == nid:
                                ev_shorthand = "onClick" if ev_name in ("click", "OnClick") else None
                                all_cases = []
                                for rid, robj in r_list:
                                    all_cases.extend(self._compile_declarative_rule_cases(rid, robj))
                                if ev_shorthand and ev_shorthand in node and isinstance(node[ev_shorthand], list):
                                    extra = [a for a in node[ev_shorthand] if not (isinstance(a, dict) and ("rule" in a or "op" in a or a.get("type") == "apply-rule"))]
                                    all_cases = []
                                    for rid, robj in r_list:
                                        all_cases.extend(self._compile_declarative_rule_cases(rid, robj, extra_actions=extra))
                                    node[ev_shorthand] = {"cases": all_cases}
                                else:
                                    node.setdefault("on", {})[ev_name] = {"cases": all_cases}
                    for ev_key in ("on", *EVENT_SHORTHANDS.keys()):
                        if ev_key not in node:
                            continue
                        if ev_key == "on" and isinstance(node["on"], dict):
                            for ek, ev_val in list(node["on"].items()):
                                if isinstance(ev_val, list):
                                    rule_hit = None
                                    extra = []
                                    for act in ev_val:
                                        if isinstance(act, dict) and ("rule" in act or act.get("type") == "apply-rule"):
                                            rname = act.get("rule")
                                            if rname in self.declarative_rules:
                                                rule_hit = (rname, self.declarative_rules[rname])
                                        elif isinstance(act, dict) and "op" in act and act["op"] in op_to_rule:
                                            rule_hit = op_to_rule[act["op"]]
                                        else:
                                            extra.append(act)
                                    if rule_hit is not None:
                                        node["on"][ek] = {"cases": self._compile_declarative_rule_cases(rule_hit[0], rule_hit[1], extra_actions=extra)}
                        elif ev_key in EVENT_SHORTHANDS and isinstance(node[ev_key], list):
                            rule_hit = None
                            extra = []
                            for act in node[ev_key]:
                                if isinstance(act, dict) and ("rule" in act or act.get("type") == "apply-rule"):
                                    rname = act.get("rule")
                                    if rname in self.declarative_rules:
                                        rule_hit = (rname, self.declarative_rules[rname])
                                elif isinstance(act, dict) and "op" in act and act["op"] in op_to_rule:
                                    rule_hit = op_to_rule[act["op"]]
                                else:
                                    extra.append(act)
                            if rule_hit is not None:
                                node[ev_key] = {"cases": self._compile_declarative_rule_cases(rule_hit[0], rule_hit[1], extra_actions=extra)}
                    for ch in (node.get("children") if isinstance(node.get("children"), list) else []):
                        _expand_rules_in_node(ch)
                    for st in (node.get("states") if isinstance(node.get("states"), list) else []):
                        if isinstance(st, dict):
                            _expand_rules_in_node(st.get("root"))
                    if isinstance(node.get("template"), dict):
                        _expand_rules_in_node(node["template"])

                for page in raw_pages:
                    if isinstance(page, dict):
                        _expand_rules_in_node(page.get("root"))

            # Detect repeaters and data-add per dataset across pages for P0-1 runtime selection
            page_repeaters_by_ds = {}
            datasets_with_runtime_rep = set()
            datasets_with_data_add = set()

            def _scan_repeaters_and_adds(node, pid, rep_id_to_ds):
                if not isinstance(node, dict):
                    return
                is_rep = node.get("type") == "repeater" or isinstance(node.get("repeater"), str)
                if is_rep and isinstance(node.get("dataset"), str):
                    rid = node.get("id") or node.get("repeater")
                    ds_n = node["dataset"]
                    datasets_with_runtime_rep.add(ds_n)
                    if isinstance(rid, str):
                        page_repeaters_by_ds.setdefault((pid, ds_n), []).append(rid)
                        rep_id_to_ds[rid] = ds_n
                for ch in (node.get("children") if isinstance(node.get("children"), list) else []):
                    _scan_repeaters_and_adds(ch, pid, rep_id_to_ds)
                for st in (node.get("states") if isinstance(node.get("states"), list) else []):
                    if isinstance(st, dict):
                        _scan_repeaters_and_adds(st.get("root"), pid, rep_id_to_ds)
                if isinstance(node.get("template"), dict):
                    _scan_repeaters_and_adds(node["template"], pid, rep_id_to_ds)

            rep_id_to_ds = {}
            for page in raw_pages:
                if isinstance(page, dict):
                    _scan_repeaters_and_adds(page.get("root"), page.get("id", ""), rep_id_to_ds)

            def _scan_actions_for_add(obj):
                if isinstance(obj, dict):
                    if obj.get("type") == "data-add" or "data-add" in obj:
                        t_ref = obj.get("target") or obj.get("data-add")
                        if isinstance(t_ref, dict):
                            t_ref = t_ref.get("ref")
                        if isinstance(t_ref, str) and t_ref in rep_id_to_ds:
                            datasets_with_data_add.add(rep_id_to_ds[t_ref])
                    for v in obj.values():
                        _scan_actions_for_add(v)
                elif isinstance(obj, list):
                    for item in obj:
                        _scan_actions_for_add(item)

            _scan_actions_for_add(raw_pages)

            raw_vars = self.spec.setdefault("variables", {}) if isinstance(self.spec.get("variables", {}), dict) else {}
            raw_datasets = self.spec.get("datasets") or {}
            models = self.spec.get("models") or {}
            for page in raw_pages:
                if not isinstance(page, dict) or not isinstance(page.get("bindings"), list):
                    continue
                pid = page.get("id", "")
                for b_entry in page["bindings"]:
                    if not isinstance(b_entry, dict):
                        continue
                    ds_n = b_entry.get("dataset")
                    ds_obj = raw_datasets.get(ds_n) if isinstance(raw_datasets, dict) else None
                    if not isinstance(ds_obj, dict) or not isinstance(ds_obj.get("rows"), list):
                        continue
                    rows = ds_obj["rows"]
                    key_col = b_entry.get("key", "id")
                    var_name = b_entry.get("variable", "")
                    model_def = models.get(ds_obj.get("model"), {})
                    if not isinstance(model_def, dict) or model_def.get(key_col) != "text":
                        continue
                    if b_entry.get("_from_view") and var_name and var_name not in raw_vars and rows and isinstance(rows[0].get(key_col), str):
                        raw_vars[var_name] = {"type": "text", "value": rows[0][key_col]}
                    use_runtime_sel = bool(
                        b_entry.get("_from_view")
                        or b_entry.get("mode") == "runtime"
                        or len(rows) > 3
                        or ds_n in datasets_with_runtime_rep
                        or ds_n in datasets_with_data_add
                    )
                    if not use_runtime_sel:
                        continue
                    b_entry["_runtime_selection"] = True
                    existing_reps = page_repeaters_by_ds.get((pid, ds_n), [])
                    if existing_reps:
                        b_entry["_lookup_repeater_id"] = existing_reps[0]
                    else:
                        lookup_id = f"__rp1_view_rep_{ds_n}"
                        b_entry["_lookup_repeater_id"] = lookup_id
                        if isinstance(page.get("root"), dict) and isinstance(page["root"].get("children"), list):
                            if not any(isinstance(c, dict) and c.get("id") == lookup_id for c in page["root"]["children"]):
                                page["root"]["children"].append({
                                    "type": "repeater",
                                    "id": lookup_id,
                                    "dataset": ds_n,
                                    "key": key_col,
                                    "x": 0, "y": 0, "w": 1, "h": 1,
                                    "rowHeight": 1, "rowGap": 0,
                                    "_hidden_lookup": True,
                                    "template": {
                                        "type": "label",
                                        "id": f"__rp1_view_cell_{ds_n}",
                                        "text": "",
                                        "w": 1, "h": 1,
                                    },
                                })
                                page_repeaters_by_ds.setdefault((pid, ds_n), []).append(lookup_id)

    def validate_macro(self, source, path):
        kind = source["type"]
        fields(source, MACRO_PROPS[kind] | {"adaptive", "_master_instance", "_master_slot"}, path)
        if kind == "phone-shell":
            validate_device(source, path)
            for key in ("navBar", "tabBar"):
                if key in source and not isinstance(source[key], dict) and source[key] is not False:
                    fail("E_TYPE", ptr(path, key), f"{key} must be an object or false")
        if kind == "tab-bar" and "items" not in source and "tabs" not in source:
            fail("E_PROPERTY_REQUIRED", ptr(path, "items"), "tab-bar requires 'items' or 'tabs'")
        if kind == "progress-bar" and "percent" in source and "value" in source:
            fail("E_PROPERTY", ptr(path, "percent"), "progress-bar accepts either 'percent' or 'value' (+ 'max'), not both")
        if "slots" in source:
            if not isinstance(source["slots"], dict):
                fail("E_OBJECT", ptr(path, "slots"), "slots must be an object mapping slot names to node objects")
            allowed_slots = MACRO_SLOTS.get(kind, set())
            fields(source["slots"], allowed_slots, ptr(path, "slots"))
            for sk, sval in source["slots"].items():
                if not isinstance(sval, dict):
                    fail("E_OBJECT", ptr(ptr(path, "slots"), sk), f"Slot '{sk}' must be a node object")
        if kind in ("searchable-list", "master-detail"):
            dataset = self.datasets.get(source.get("dataset")) if isinstance(source.get("dataset"), str) else None
            if dataset is not None and (source.get("filters") == "auto" or ("filters" not in source and "filterField" in source)):
                mname = dataset["model"]
                ff = source.get("filterField", source.get("searchField"))
                dom_meta = self.domain_models.get(mname, {}).get(ff)
                if dom_meta and dom_meta.get("domain") == "enum":
                    labels = dom_meta.get("labels", {})
                    source["filters"] = [{"label": "全部", "value": "全部", "all": True}] + [
                        {"label": labels.get(v, v), "value": v} for v in dom_meta["values"]
                    ]
                elif source.get("filters") == "auto":
                    fail("E_PROPERTY", ptr(path, "filters"), f"filters: 'auto' requires filterField '{ff}' to be an enum field in model '{mname}'")
        for array_key, allowed in MACRO_ITEM_PROPS[kind].items():
            if array_key not in source and (
                array_key in ("filters", "actions")
                or (kind == "tab-bar" and array_key in ("items", "tabs"))
                or (kind == "phone-shell" and array_key == "children")
            ):
                continue
            entries = source.get(array_key)
            optional_empty = array_key in ("filters", "actions") or (kind == "phone-shell" and array_key == "children")
            if not isinstance(entries, list) or (not entries and not optional_empty):
                fail("E_TYPE", ptr(path, array_key), f"{array_key} must be a {'nonempty ' if not optional_empty else ''}array")
            if kind == "phone-shell" and array_key == "children":
                continue
            for idx, entry in enumerate(entries):
                ep = ptr(ptr(path, array_key), idx)
                if array_key in ("filters", "items", "tabs") and isinstance(entry, str) and kind in ("searchable-list", "tab-bar"):
                    continue
                fields(entry, allowed, ep)
                for w_prop in ("fontWeight", "headerFontWeight"):
                    if w_prop in entry:
                        entry[w_prop] = normalize_font_weight(entry[w_prop])
                for a_prop in ("align", "headerAlign"):
                    if a_prop in entry and isinstance(entry[a_prop], str):
                        entry[a_prop] = TEXT_ALIGN_ALIASES.get(entry[a_prop].strip().lower(), entry[a_prop])
                if "all" in entry:
                    self.typecheck(entry["all"], "boolean", ptr(ep, "all"))
                if "active" in entry:
                    self.typecheck(entry["active"], "boolean", ptr(ep, "active"))
                for prop in {"h", "fontSize", "fontWeight", "headerFontSize", "headerFontWeight", "radius", "flex"} & set(entry):
                    self.typecheck(entry[prop], "number", ptr(ep, prop))
                    if prop in {"fontSize", "headerFontSize"}:
                        validate_font_size(entry[prop], ptr(ep, prop))
                    if entry[prop] < 0:
                        fail("E_SIZE", ptr(ep, prop), "Value must be nonnegative")
                for prop in {"w", "width"} & set(entry):
                    if entry[prop] not in ("fill", "hug", "auto"):
                        self.typecheck(entry[prop], "number", ptr(ep, prop))
                        if entry[prop] < 0:
                            fail("E_SIZE", ptr(ep, prop), "Size must be nonnegative")
                if "cell" in entry and not isinstance(entry["cell"], dict):
                    fail("E_OBJECT", ptr(ep, "cell"), "Column cell must be a node object")
                if "body" in entry and not isinstance(entry["body"], dict):
                    fail("E_OBJECT", ptr(ep, "body"), "Step body must be a node object")
        for prop in {"rowHeight", "headerHeight", "columnGap", "gap", "rowGap", "tableGap", "inputHeight", "inputRadius", "titleFontSize", "submitHeight", "labelWidth", "fontSize", "radius", "pageSize", "bodyHeight", "masterWidth", "itemHeight", "percent", "value", "max", "barHeight", "trackHeight"} & set(source):
            value = source[prop]
            if kind == "progress-bar" and prop in {"value", "percent"} and (
                isinstance(value, dict)
                or (isinstance(value, str) and (value.startswith("$") or value.startswith("=") or "${" in value or INLINE_EXPR_HINT_RE.search(value)))
            ):
                continue
            self.typecheck(value, "number", ptr(path, prop))
            if prop in {"fontSize", "titleFontSize"}:
                validate_font_size(value, ptr(path, prop))
            if value < 0:
                fail("E_SIZE", ptr(path, prop), "Value must be nonnegative")
            if prop == "max" and value <= 0:
                fail("E_SIZE", ptr(path, prop), "max must be positive")
            if prop in {"rowHeight", "pageSize"} and kind in {"data-table", "searchable-list"} and (type(value) is not int or value < 1):
                fail("E_SIZE", ptr(path, prop), f"{prop} must be a positive integer")
        if kind in ("kv-list", "detail-card") and source.get("rowHeight", 24) < 4:
            fail("E_SIZE", ptr(path, "rowHeight"), f"{kind} rowHeight must be at least 4")
        if kind == "data-table" and "rowOn" in source:
            if not isinstance(source["rowOn"], dict):
                fail("E_EVENT", ptr(path, "rowOn"), "rowOn must be an event map")
            if "onRowClick" in source and any(k in source["rowOn"] for k in ("click", "OnClick")):
                fail("E_EVENT", ptr(path, "onRowClick"), "Duplicate row click event")
        if kind == "searchable-list":
            dataset = self.datasets.get(source.get("dataset")) if isinstance(source.get("dataset"), str) else None
            if dataset is None:
                fail("E_DATASET", ptr(path, "dataset"), "Unknown Repeater dataset")
            model = self.models[dataset["model"]]
            for prop in ("searchField", "filterField"):
                if prop == "filterField" and prop not in source:
                    continue
                field = source.get(prop)
                self.typecheck(field, "text", ptr(path, prop))
                if field not in model:
                    fail("E_DATA_FIELD", ptr(path, prop), f"Unknown row field '{field}'")
            filter_field = source.get("filterField", source["searchField"])
            dom_meta = self.domain_models.get(dataset["model"], {}).get(filter_field)
            for idx, item in enumerate(source.get("filters", [])):
                if isinstance(item, str):
                    value, is_all = item, idx == 0 and item in ("全部", "All", "all", "*")
                else:
                    value = item.get("value", item.get("label", item.get("text", f"Filter {idx+1}")))
                    is_all = item.get("all", False)
                if not is_all:
                    value_path = ptr(ptr(path, "filters"), idx)
                    err_ptr = ptr(value_path, "value") if isinstance(item, dict) and "value" in item else value_path
                    self.typecheck(value, model[filter_field], err_ptr)
                    if dom_meta and dom_meta.get("domain") == "enum" and value not in dom_meta["values"]:
                        hint = difflib.get_close_matches(str(value), dom_meta["values"], n=3)
                        fail("E_ENUM_VARIANT", err_ptr, f"Filter value '{value}' is not in enum {dom_meta['values']}", suggestions=hint)

    def mark_macro_sources(self, expanded, source, path):
        kind = source["type"]
        self.macro_calls[path] = kind

        def mark(node, origin, structural=False):
            if not isinstance(node, dict):
                return
            if "_slot_origin" in node:
                origin = node.pop("_slot_origin")
                structural = True
            self.source_origins[id(node)] = (node, origin)
            if isinstance(node.get("children"), list):
                for idx, child in enumerate(node["children"]):
                    if isinstance(child, dict):
                        mark(child, ptr(ptr(origin, "children"), idx) if structural else origin, structural)
            if isinstance(node.get("template"), dict):
                mark(node["template"], ptr(origin, "template") if structural else origin, structural)
            for idx, state in enumerate(node.get("states") if isinstance(node.get("states"), list) else []):
                if not isinstance(state, dict):
                    continue
                st_origin = ptr(ptr(origin, "states"), idx) if structural else origin
                if isinstance(state.get("root"), dict):
                    st_root = state["root"]
                    if st_root.get("_auto_state_root"):
                        self.source_origins[id(st_root)] = (st_root, st_origin)
                        for c_idx, s_ch in enumerate(st_root.get("children") if isinstance(st_root.get("children"), list) else []):
                            if isinstance(s_ch, dict):
                                mark(s_ch, ptr(ptr(st_origin, "children"), c_idx) if structural else origin, structural)
                    else:
                        mark(st_root, ptr(st_origin, "root") if structural else origin, structural)
                elif isinstance(state.get("children"), list):
                    for c_idx, s_ch in enumerate(state["children"]):
                        if isinstance(s_ch, dict):
                            mark(s_ch, ptr(ptr(st_origin, "children"), c_idx) if structural else origin, structural)

        mark(expanded, path)
        children = expanded.get("children", [])
        macro_id = source.get("id")
        if kind == "data-table":
            header_box = next((c for c in children if c.get("id") == f"{macro_id}_header"), children[0])
            rep_node = next((c for c in children if c.get("id") == macro_id), children[1])
            for idx, col in enumerate(source["columns"]):
                cp = ptr(ptr(path, "columns"), idx)
                mark(header_box["children"][idx], cp)
                mark(rep_node["template"]["children"][idx], ptr(cp, "cell") if "cell" in col else cp, "cell" in col)
        elif kind == "searchable-list":
            rep_node = next((c for c in children if c.get("id") == macro_id), children[-1])
            mark(rep_node["template"], ptr(path, "template"), True)
            if source.get("filters") and isinstance(source.get("filters"), list):
                fbox = next((c for c in children if c.get("id") == f"{macro_id}_filters"), None)
                if fbox:
                    for idx, button in enumerate(fbox["children"]):
                        mark(button, ptr(ptr(path, "filters"), idx))
        elif kind == "form-card":
            for idx, fld in enumerate(source["fields"]):
                fid = fld.get("id", f"{macro_id}_field_{idx+1}")
                fgroup = next((c for c in children if c.get("id") == f"{fid}_group"), None)
                if fgroup:
                    mark(fgroup, ptr(ptr(path, "fields"), idx))
        elif kind in ("kv-list", "detail-card"):
            for idx, entry in enumerate(source["items"]):
                row_id = entry.get("id", f"{macro_id}_item_{idx+1}")
                rbox = next((c for c in children if c.get("id") == f"{row_id}_row"), None)
                if rbox:
                    mark(rbox, ptr(ptr(path, "items"), idx))

    def desugar_node(self, source, path, scope=""):
        if not isinstance(source, dict):
            return source
        source = copy.copy(source)
        if "type" not in source:
            if "when" in source and ("then" in source or "else" in source) and "id" in source:
                source["type"] = "when"
                source["condition"] = source.pop("when")
            else:
                for k in list(source.keys()):
                    if k == "when" and "then" not in source and "else" not in source:
                        continue
                    if k in SHORTHAND_NODE_KINDS and isinstance(source[k], str):
                        val = source.pop(k)
                        if k in ("row", "column", "grid", "stack"):
                            source["type"] = "box"
                            source["id"] = val
                            source.setdefault("layout", k)
                        elif k == "use" and "component" not in source and "id" in source:
                            source["type"] = "use"
                            source["component"] = val
                        elif k == "panel":
                            source["type"] = "dynamic-panel"
                            source["id"] = val
                        else:
                            source["type"] = k
                            source["id"] = val
                        break
        elif source.get("type") in ("row", "column", "grid", "stack"):
            kind = source["type"]
            source["type"] = "box"
            source.setdefault("layout", kind)
        elif source.get("type") == "panel":
            source["type"] = "dynamic-panel"
        # Intuitive property aliases (zero-guesswork for common CSS/UI naming)
        for alias_k, canonical_k in NODE_SOURCE_ALIASES.items():
            if alias_k in source:
                val_a = source.pop(alias_k)
                source.setdefault(canonical_k, val_a)
        if source.get("type") not in MACRO_PROPS:
            for nav_k in ("goto", "link", "navigate"):
                if nav_k in source:
                    nav_target = source.pop(nav_k)
                    if isinstance(nav_target, str):
                        nav_act = {"type": "link", "page": nav_target}
                        if "onClick" not in source and "on" not in source:
                            source["onClick"] = [nav_act]
                        elif isinstance(source.get("onClick"), list):
                            source["onClick"] = [*source["onClick"], nav_act]
                        elif isinstance(source.get("onClick"), dict) and "cases" not in source["onClick"]:
                            source["onClick"] = [source["onClick"], nav_act]
        # Allow box with `text` and no `children` to gracefully act as a styled label/box
        if source.get("type") == "box" and "text" in source and "children" not in source:
            txt_val = source.pop("text")
            if not any(k in source for k in BOX_TEXT_CONTAINER_KEYS):
                source["type"] = "label"
                source["text"] = txt_val
            else:
                source["children"] = [{
                    "type": "label",
                    "id": f"{source.get('id', 'box')}_text",
                    "text": txt_val,
                    "w": "fill",
                    "h": "hug",
                    **({k: source.pop(k) for k in BOX_TEXT_STYLE_KEYS if k in source}),
                }]
        # Card content shorthand props (title, subtitle, body/text, tag/eyebrow/badge, rightBadge, rightText/meta, actionText/buttonText)
        if source.get("type") == "card" and any(
            k in source for k in CARD_CONTENT_KEYS
        ):
            cid = source.get("id", "card")
            c_tag = source.pop("tag", source.pop("eyebrow", source.pop("badge", None)))
            c_tag_tone = source.pop("tagTone", source.pop("badgeVariant", "soft"))
            c_right_badge = source.pop("rightBadge", None)
            c_right_tone = source.pop("rightTone", "soft")
            c_right = source.pop("rightText", source.pop("meta", None))
            c_title = source.pop("title", None)
            c_title_fs = source.pop("titleFontSize", 16)
            c_sub = source.pop("subtitle", None)
            c_body = source.pop("body", source.pop("text", None))
            c_act = source.pop("actionText", source.pop("buttonText", None))
            c_act_var = source.pop("actionVariant", "soft")
            auto_children = []
            hdr_right_node = None
            if c_right_badge is not None:
                hdr_right_node = {"type": "badge", "id": f"{cid}_rbadge", "text": str(c_right_badge), "variant": c_right_tone if c_right_tone in ("soft", "solid", "outline", "brand", "primary", "secondary", "ghost", "glass", "success", "warning", "danger", "error", "neutral") else "soft", "w": "hug", "h": 22, "radius": 6, "fontSize": 11}
            elif c_right is not None:
                hdr_right_node = {"type": "label", "id": f"{cid}_meta", "text": str(c_right), "w": "hug", "h": 18, "fontSize": 12, "color": "$ink-3", "align": "right"}
            if c_tag is not None and hdr_right_node is not None:
                auto_children.append({
                    "type": "box",
                    "id": f"{cid}_hdr",
                    "layout": "row",
                    "w": "fill",
                    "h": "hug",
                    "justify": "space-between",
                    "align": "center",
                    "children": [
                        {"type": "badge", "id": f"{cid}_tag", "text": str(c_tag), "variant": c_tag_tone if c_tag_tone in ("soft", "solid", "outline", "brand", "primary", "secondary", "ghost", "glass", "success", "warning", "danger", "error", "neutral") else "soft", "w": "hug", "h": 22, "radius": 6, "fontSize": 11},
                        hdr_right_node,
                    ],
                })
            elif c_tag is not None:
                auto_children.append({"type": "badge", "id": f"{cid}_tag", "text": str(c_tag), "variant": c_tag_tone if c_tag_tone in ("soft", "solid", "outline", "brand", "primary", "secondary", "ghost", "glass", "success", "warning", "danger", "error", "neutral") else "soft", "w": "hug", "h": 22, "radius": 6, "fontSize": 11})
            elif hdr_right_node is not None:
                auto_children.append(hdr_right_node)
            if c_title is not None:
                auto_children.append({
                    "type": "label",
                    "id": f"{cid}_title",
                    "text": str(c_title),
                    "w": "fill",
                    "h": "hug",
                    "fontSize": c_title_fs,
                    "fontWeight": 700,
                    "color": "$ink",
                    "wrap": True,
                })
            if c_sub is not None:
                auto_children.append({
                    "type": "label",
                    "id": f"{cid}_subtitle",
                    "text": str(c_sub),
                    "w": "fill",
                    "h": "hug",
                    "fontSize": 12,
                    "color": "$ink-2",
                    "wrap": True,
                })
            if c_body is not None:
                auto_children.append({
                    "type": "paragraph",
                    "id": f"{cid}_body",
                    "text": str(c_body),
                    "w": "fill",
                    "h": "hug",
                    "fontSize": 13,
                    "color": "$ink-2",
                })
            if c_act is not None:
                act_btn = {
                    "type": "button",
                    "id": f"{cid}_action",
                    "text": str(c_act),
                    "variant": c_act_var,
                    "w": "hug",
                    "h": 32,
                    "radius": 8,
                    "fontSize": 12,
                }
                if "onClick" in source:
                    act_btn["onClick"] = copy.deepcopy(source["onClick"])
                auto_children.append(act_btn)
            if "children" in source:
                if not isinstance(source["children"], list):
                    fail("E_CHILDREN", ptr(path, "children"), "children must be an array")
                for c_idx, ch in enumerate(source["children"]):
                    if not isinstance(ch, dict):
                        fail("E_OBJECT", ptr(ptr(path, "children"), c_idx), "Expected a node object")
            source["children"] = auto_children + list(source.get("children") or [])
            source.setdefault("w", "fill")
            source.setdefault("h", "hug")
        source.pop("_auto_state_root", None)
        # Dynamic-panel state root normalization and optional `tabs` bar auto-generation
        if source.get("type") == "dynamic-panel":
            pid = source.get("id", "panel")
            if isinstance(source.get("states"), dict) and source["states"]:
                source["states"] = [
                    (
                        {"id": sk, **sv}
                        if isinstance(sv, dict) and any(k in sv for k in ("root", "children", "body", "tree"))
                        else ({"id": sk, "root": sv} if isinstance(sv, dict) else {"id": sk, "children": sv})
                    )
                    for sk, sv in source["states"].items()
                ]
            if isinstance(source.get("states"), list):
                source["states"] = [
                    normalize_panel_state_dict(st, pid, s_idx)
                    for s_idx, st in enumerate(source["states"])
                ]
            if source.get("tabs"):
                tabs_cfg = source.pop("tabs")
                tab_gap = source.pop("tabGap", 10)
                if "panelHeight" in source:
                    source["h"] = source.pop("panelHeight")
                states_list = source.get("states") or []
                state_tab_meta = []
                for s_idx, st in enumerate(states_list):
                    sid = st.get("id", f"state_{s_idx + 1}") if isinstance(st, dict) else f"state_{s_idx + 1}"
                    if isinstance(tabs_cfg, list) and s_idx < len(tabs_cfg):
                        t_item = tabs_cfg[s_idx]
                        t_label = t_item.get("text", t_item.get("label", sid)) if isinstance(t_item, dict) else str(t_item)
                    else:
                        t_label = (st.get("name", sid) if isinstance(st, dict) else sid)
                    state_tab_meta.append((sid, str(t_label)))
                for s_idx, st in enumerate(states_list):
                    if not isinstance(st, dict):
                        continue
                    sid, _ = state_tab_meta[s_idx]
                    tab_btns = []
                    for t_idx, (target_sid, t_label) in enumerate(state_tab_meta):
                        btn_id = f"{pid}_tab_{target_sid}" if s_idx == 0 else f"{pid}_{sid}_tab_{target_sid}"
                        tab_btns.append({
                            "type": "button",
                            "id": btn_id,
                            "text": t_label,
                            "variant": "primary" if t_idx == s_idx else "ghost",
                            "flex": 1,
                            "h": 28,
                            "radius": 8,
                            "fontSize": 12,
                            "onClick": [{"type": "set-panel-state", "target": {"ref": pid}, "state": target_sid}],
                        })
                    tabbar_box = {
                        "type": "box",
                        "id": f"{pid}_tabbar" if s_idx == 0 else f"{pid}_{sid}_tabbar",
                        "layout": "row",
                        "w": "fill",
                        "h": 36,
                        "padding": 4,
                        "gap": 6,
                        "radius": 10,
                        "fill": "$surface-2",
                        "children": tab_btns,
                    }
                    st_root = st.get("root")
                    if isinstance(st_root, dict) and st_root.get("id") == f"{pid}_{sid}_root" and st_root.get("layout", "column") == "column":
                        if "children" in st_root and not isinstance(st_root["children"], list):
                            fail("E_CHILDREN", ptr(ptr(ptr(path, "states"), s_idx), "children"), "children must be an array")
                        for c_idx, ch in enumerate(st_root.get("children") or []):
                            if not isinstance(ch, dict):
                                fail("E_OBJECT", ptr(ptr(ptr(ptr(path, "states"), s_idx), "children"), c_idx), "Expected a node object")
                        st_root["children"] = [tabbar_box] + list(st_root.get("children") or [])
                    elif isinstance(st_root, dict):
                        st["root"] = {
                            "type": "box",
                            "id": f"{pid}_{sid}_tabs_root",
                            "layout": "column",
                            "w": "fill",
                            "h": "hug",
                            "gap": tab_gap,
                            "children": [tabbar_box, st_root],
                        }
                if isinstance(source.get("h"), (int, float)):
                    source["h"] = int(source["h"]) + 36 + tab_gap
        if "size" in source and isinstance(source["size"], list) and len(source["size"]) == 2:
            w_val, h_val = source.pop("size")
            source.setdefault("w", w_val)
            source.setdefault("h", h_val)
        elif "size" in source and source.get("type") in MACRO_PROPS:
            fail("E_TYPE", ptr(path, "size"), "size needs [width, height]")
        if source.get("type") in MACRO_PROPS:
            self.validate_macro(source, path)
            original = source
            kind = source["type"]
            if kind == "searchable-list":
                variable = None
                if source.get("filters"):
                    variable = "rp1_filter_" + hashlib.sha256((scope + "/" + str(source.get("id"))).encode()).hexdigest()[:16]
                    if variable in self.variables:
                        fail("E_VARIABLE", path, "Generated macro state collides with a declared variable")
                    self.variables[variable] = {"type": "number", "value": -1}
                source = expand_searchable_list_macro(source, path, variable)
            elif kind == "wizard-card":
                step_var = source.get("stepVariable")
                first_step = source["steps"][0].get("id", "step_1") if source.get("steps") else "step_1"
                if not step_var:
                    step_var = "rp1_wiz_" + hashlib.sha256((scope + "/" + str(source.get("id"))).encode()).hexdigest()[:12]
                if step_var not in self.variables:
                    self.variables[step_var] = {"type": "text", "value": first_step}
                source = expand_wizard_card_macro(source, path, step_var)
            elif kind == "progress-bar":
                source = expand_progress_bar_macro(
                    source, path, self.variables or (self.spec.get("variables") if isinstance(self.spec, dict) else None),
                    bindings=self.progress_bindings, scope=scope)
            else:
                source = {
                    "data-table": expand_data_table_macro,
                    "form-card": expand_form_card_macro,
                    "kv-list": expand_kv_list_macro,
                    "detail-card": expand_detail_card_macro,
                    "master-detail": expand_master_detail_macro,
                    "tab-bar": expand_tab_bar_macro,
                    "nav-bar": expand_nav_bar_macro,
                    "phone-shell": expand_phone_shell_macro,
                    "stat-row": expand_stat_row_macro,
                    "list-item": expand_list_item_macro,
                }[kind](source, path)
            for key in {"on", "name", "when", "visible", "hidden", "adaptive", "_master_instance", "_master_slot"} | set(EVENT_SHORTHANDS):
                if key in original:
                    source[key] = copy.deepcopy(original[key])
            self.mark_macro_sources(source, original, path)
        if "font" in source:
            parse_font_shorthand(source.pop("font"), source, ptr(path, "font"))
        for w_prop in ("fontWeight", "weight"):
            if w_prop in source:
                source[w_prop] = normalize_font_weight(source[w_prop])
        for c_prop in ("fill", "stroke", "color"):
            if c_prop in source:
                source[c_prop] = normalize_color_token(source[c_prop])
        if "justify" in source and isinstance(source["justify"], str):
            source["justify"] = JUSTIFY_ALIASES.get(source["justify"].strip().lower(), source["justify"])
        for sh_key, ev_name in EVENT_SHORTHANDS.items():
            if sh_key in source:
                ev_val = source.pop(sh_key)
                events = source.get("on", {})
                if not isinstance(events, dict):
                    fail("E_EVENT", ptr(path, "on"), "on must be an event map")
                if ev_name in events or EVENTS[ev_name] in events:
                    fail("E_EVENT", ptr(path, sh_key), f"Duplicate event alias '{sh_key}'")
                source["on"] = {**events, ev_name: ev_val}
        if source.get("type") == "use" and "args" not in source:
            comp_name = source.get("component")
            comp_def = self.components.get(comp_name, {})
            declared_params = set(comp_def.get("params", {}).keys())
            reserved = {"type", "id", "component", "args", "name", "on", "when"} | GEOMETRY
            inline_args = {}
            for k in list(source.keys()):
                if k not in reserved and (k in declared_params or declared_params):
                    inline_args[k] = source.pop(k)
            if inline_args:
                source["args"] = inline_args
        for txt_k in ("text", "value", "placeholder", "title", "subtitle", "rightText"):
            if isinstance(source.get(txt_k), str):
                source[txt_k] = sanitize_dingbats(source[txt_k])
        return source

    def desugar_action_list(self, actions, path):
        if isinstance(actions, str):
            actions = [actions]
        elif isinstance(actions, dict) and "cases" not in actions:
            actions = [actions]
        if not isinstance(actions, list):
            return actions
        expanded = []
        for idx, act in enumerate(actions):
            if isinstance(act, str):
                s_act = act.strip()
                if s_act.startswith(("goto ", "link ", "navigate ")):
                    expanded.append({"type": "link", "page": s_act.split(None, 1)[1].strip()})
                    continue
                if "=" in s_act and not s_act.startswith("=="):
                    lhs, rhs = s_act.split("=", 1)
                    lhs_k = lhs.strip()
                    rhs_s = rhs.strip()
                    if (rhs_s.startswith('"') and rhs_s.endswith('"')) or (rhs_s.startswith("'") and rhs_s.endswith("'")):
                        rhs_v = rhs_s[1:-1]
                    elif rhs_s in ("true", "false"):
                        rhs_v = rhs_s == "true"
                    else:
                        try:
                            rhs_v = int(rhs_s) if rhs_s.lstrip("-").isdigit() else float(rhs_s)
                        except ValueError:
                            rhs_v = rhs_s if rhs_s.startswith("=") else f"={rhs_s}"
                    act = {"set": {lhs_k: rhs_v}}
                elif "." in s_act and " " not in s_act:
                    p, s = s_act.split(".", 1)
                    expanded.append({"type": "set-panel-state", "target": {"ref": p}, "state": s})
                    continue
                elif re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", s_act):
                    expanded.append({"type": "link", "page": s_act})
                    continue
                else:
                    fail("E_EVENT", ptr(path, idx), "Unrecognized action shorthand; use an action object or a documented string shorthand")
            elif not isinstance(act, dict):
                expanded.append(act)
                continue
            act = copy.deepcopy(act)
            if "type" not in act:
                keys = set(act.keys())
                ap = ptr(path, idx)
                if "set" in act:
                    fields(act, {"set"}, ap)
                    if not isinstance(act["set"], dict) or not act["set"]:
                        fail("E_ACTION", ptr(ap, "set"), "set requires a nonempty assignment map")
                    for k, v in act["set"].items():
                        self.typecheck(k, "text", ptr(ap, "set"))
                        if k.startswith("$"):
                            expanded.append({"type": "set-variable", "variable": k[1:], "value": v})
                        elif k.startswith("var."):
                            expanded.append({"type": "set-variable", "variable": k[4:], "value": v})
                        elif k.startswith("@"):
                            expanded.append({"type": "set-text", "target": {"ref": k[1:]}, "text": v})
                        elif k.endswith(".state"):
                            expanded.append({"type": "set-panel-state", "target": {"ref": k[:-6]}, "state": v})
                        elif k in self.variables and not any(s.endswith("/" + k) or s == k for s in self.symbols):
                            expanded.append({"type": "set-variable", "variable": k, "value": v})
                        else:
                            expanded.append({"type": "set-text", "target": {"ref": k}, "text": v})
                    continue
                if "set-variable" in act:
                    fields(act, {"set-variable", "value"}, ap)
                    expanded.append({"type": "set-variable", "variable": act["set-variable"], "value": act.get("value")})
                    continue
                if "state" in act or "set-state" in act:
                    state_key = "state" if "state" in act else "set-state"
                    fields(act, {state_key, "panel", "target"}, ap)
                    st = act[state_key]
                    panel_ref = act.get("panel") or act.get("target")
                    if panel_ref and isinstance(st, str):
                        expanded.append({"type": "set-panel-state", "target": {"ref": panel_ref} if isinstance(panel_ref, str) else panel_ref, "state": st})
                        continue
                    if isinstance(st, list) and len(st) == 2:
                        expanded.append({"type": "set-panel-state", "target": {"ref": st[0]}, "state": st[1]})
                        continue
                    if isinstance(st, str) and "." in st:
                        p, s = st.split(".", 1)
                        expanded.append({"type": "set-panel-state", "target": {"ref": p}, "state": s})
                        continue
                if keys in ({"goto"}, {"link"}, {"navigate"}):
                    page_target = act.get("goto", act.get("link", act.get("navigate")))
                    expanded.append({"type": "link", "page": page_target})
                    continue
                for simple_act in ("show", "hide", "toggle", "enable", "disable", "focus"):
                    if simple_act in act:
                        fields(act, {simple_act}, ap)
                        t = act[simple_act]
                        expanded.append({"type": simple_act, "target": {"ref": t} if isinstance(t, str) else t})
                        break
                else:
                    expanded.append(act)
                continue
            if act.get("type") in ("goto", "navigate"):
                act["type"] = "link"
            if act.get("type") == "link" and "target" in act and "page" not in act and "url" not in act:
                act["page"] = act.pop("target")
            if isinstance(act.get("target"), str):
                act["target"] = {"ref": act["target"]}
            if act.get("type") == "set-text" and "value" in act and "text" not in act:
                act["text"] = act.pop("value")
            if act.get("type") == "data-filter" and "name" not in act:
                act["name"] = "default_filter"
            if act.get("type") == "data-sort" and act.get("direction") in ("asc", "desc"):
                act["direction"] = "ascending" if act["direction"] == "asc" else "descending"
            if act.get("type") == "data-add" and "row" in act and "rows" not in act:
                row_val = act.pop("row")
                act["rows"] = [row_val] if isinstance(row_val, dict) else row_val
            expanded.append(act)
        return expanded


    def typecheck(self, value, typename, path):
        if typename in SCALARS:
            valid = isinstance(value, SCALARS[typename])
            if typename == "number":
                valid = valid and not isinstance(value, bool) and math.isfinite(value)
            if not valid:
                fail("E_TYPE", path, f"Expected {typename}, got {type(value).__name__}")
        elif typename in self.models:
            if isinstance(value, dict):
                unknown = next((key for key in value if key not in self.models[typename]), None)
                if unknown is not None:
                    fail("E_DATA_FIELD", ptr(path, unknown), f"Unknown field '{unknown}' of {typename}")
            fields(value, self.models[typename], path)
            for name, typ in self.models[typename].items():
                if name not in value:
                    fail("E_FIELD_MISSING", ptr(path, name), f"Required field of {typename}")
                self.typecheck(value[name], typ, ptr(path, name))
        else:
            hint = difflib.get_close_matches(str(typename), sorted(list(SCALARS.keys()) + list(self.models.keys())), n=3)
            fail("E_TYPE_NAME", path, f"Unknown type '{typename}'", suggestions=hint)

    def _format_scalar(self, val):
        if type(val) is bool:
            return str(val).lower()
        if type(val) is float and val.is_integer():
            return str(int(val))
        return str(val)

    def _fold_compile_ast(self, node, path):
        if isinstance(node, dict):
            if "op" in node and "left" in node and "right" in node and set(node.keys()) <= {"op", "left", "right", "_inline_plus"}:
                l = self._fold_compile_ast(node["left"], ptr(path, "left"))
                r = self._fold_compile_ast(node["right"], ptr(path, "right"))
                op = node["op"]
                if type(l) in (int, float) and type(r) in (int, float):
                    if op == "+": return l + r
                    if op == "-": return l - r
                    if op == "*": return l * r
                    if op == "/":
                        if r == 0: fail("E_DIVISION_ZERO", path, "Division by zero")
                        return l / r
                    if op == ">": return l > r
                    if op == "<": return l < r
                    if op == ">=": return l >= r
                    if op == "<=": return l <= r
                if type(l) in (str, int, float, bool) and type(r) in (str, int, float, bool) and type(l) is type(r):
                    if op == "==": return l == r
                    if op == "!=": return l != r
                if type(l) is bool and type(r) is bool:
                    if op == "&&": return l and r
                    if op == "||": return l or r
                res = {"op": op, "left": l, "right": r}
                if "_inline_plus" in node:
                    res["_inline_plus"] = node["_inline_plus"]
                return res
            if "fn" in node and isinstance(node.get("args"), list) and set(node.keys()) == {"fn", "args"}:
                args = [self._fold_compile_ast(a, ptr(ptr(path, "args"), i)) for i, a in enumerate(node["args"])]
                fn = node["fn"]
                if all(type(a) in (str, int, float, bool) for a in args):
                    if fn == "not" and len(args) == 1 and type(args[0]) is bool:
                        return not args[0]
                    if fn == "text" and len(args) == 1:
                        return self._format_scalar(args[0])
                    if fn == "lower" and len(args) == 1 and type(args[0]) is str:
                        return args[0].lower()
                    if fn == "upper" and len(args) == 1 and type(args[0]) is str:
                        return args[0].upper()
                    if fn == "length" and len(args) == 1 and type(args[0]) is str:
                        return len(args[0].encode("utf-16-le")) // 2
                    if fn == "contains" and len(args) == 2 and all(type(a) is str for a in args):
                        return args[1] in args[0]
                    if fn == "remove" and len(args) == 2 and all(type(a) is str for a in args):
                        return args[0].replace(args[1], "", 1)
                    if fn == "concat" and len(args) >= 2 and all(type(a) in (str, int, float, bool) for a in args):
                        return "".join(self._format_scalar(a) for a in args)
                return {"fn": fn, "args": args}
        return node

    def expression(self, value, env, path):
        if isinstance(value, str):
            if "${" in value:
                return self.expression(parse_template_string(value, path), env, path)
            if (value.startswith("=") and not value.startswith("==")) or (value.startswith("[[") and value.endswith("]]")):
                return self.expression(parse_inline_expr(value, path), env, path)
            if value.startswith("$") and len(value) > 1 and "." not in value:
                vname = value[1:]
                if vname in env and not vname.startswith("_"):
                    return copy.deepcopy(env[vname])
                if vname in self.variables and vname not in COLOR_TOKENS:
                    return {"variable": vname}
            return value
        if isinstance(value, dict) and "expr" in value and set(value.keys()) == {"expr"}:
            return self._fold_compile_ast(self.expression(parse_inline_expr(value["expr"], ptr(path, "expr")), env, path), path)
        if isinstance(value, dict) and "_template_parts" in value:
            parts = [p if isinstance(p, str) else self.expression(p, env, path) for p in value["_template_parts"]]
            if all(type(p) in (str, int, float, bool) for p in parts):
                return "".join(self._format_scalar(p) for p in parts)
            runtime_parts = []
            for p in parts:
                if type(p) in (str, int, float, bool):
                    s = self._format_scalar(p)
                    if s != "":
                        runtime_parts.append(s)
                elif isinstance(p, dict) and "_coerce_text" in p:
                    runtime_parts.append(p)
                else:
                    runtime_parts.append({"_coerce_text": p})
            if not runtime_parts:
                return ""
            if len(runtime_parts) == 1:
                return runtime_parts[0]
            return {"fn": "concat", "args": runtime_parts}
        if isinstance(value, dict) and "_coerce_text" in value:
            inner = self.expression(value["_coerce_text"], env, path)
            if type(inner) in (str, int, float, bool):
                return self._format_scalar(inner)
            return {"_coerce_text": inner}
        if isinstance(value, dict) and "_auto_path" in value:
            expr = value["_auto_path"]
            parts = expr.split(".")
            shadowed_by_repeater = bool(env.get("_repeater_shadows_item")) and parts[0] == "item"
            if parts[0] in env and not parts[0].startswith("_") and not shadowed_by_repeater:
                result = env[parts[0]]
                for part in parts[1:]:
                    if not isinstance(result, dict) or part not in result:
                        avail = sorted(result.keys()) if isinstance(result, dict) else []
                        hint = difflib.get_close_matches(part, avail, n=3)
                        suffix = f" (available: {', '.join(avail)})" if avail else ""
                        fail("E_DATA_FIELD", path, f"Unknown field in '{expr}': {part}{suffix}", suggestions=hint)
                    result = result[part]
                return copy.deepcopy(result)
            if parts[0] in ("item", "row") and len(parts) == 2 and parts[1]:
                return {"item": parts[1]}
            if parts[0] == "caller" and len(parts) == 2 and parts[1]:
                return {"caller": parts[1]}
            if parts[0] == "var" and len(parts) == 2 and parts[1]:
                return {"variable": parts[1]}
            if parts[0] == "widget" and len(parts) == 3 and parts[1] and parts[2] in ("text", "checked", "selected", "value"):
                return {"widget": parts[1]}
            avail_env = sorted(k for k in env.keys() if not k.startswith("_"))
            hint = difflib.get_close_matches(parts[0], avail_env, n=3)
            fail("E_DATA_NAME", path, f"Unknown data name '{parts[0]}'", suggestions=hint)
        if isinstance(value, dict) and "_auto_ident" in value:
            name = value["_auto_ident"]
            if name in env and not name.startswith("_") and not (name == "item" and env.get("_repeater_shadows_item")):
                return copy.deepcopy(env[name])
            return {"_auto_ident": name}
        if isinstance(value, dict) and "_sigil_var" in value:
            name = value["_sigil_var"]
            if name in env and not name.startswith("_"):
                return copy.deepcopy(env[name])
            return {"variable": name}
        if isinstance(value, dict) and "$" in value:
            fields(value, {"$"}, path)
            expr = value["$"]
            if not isinstance(expr, str):
                fail("E_EXPRESSION", ptr(path, "$"), "Expected a dotted data path")
            parts = expr.split(".")
            if not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", p) for p in parts):
                fail("E_EXPRESSION", path, "Only dotted data paths are supported")
            if parts[0] not in env or parts[0].startswith("_"):
                avail_env = sorted(k for k in env.keys() if not k.startswith("_"))
                hint = difflib.get_close_matches(parts[0], avail_env, n=3)
                fail("E_DATA_NAME", path, f"Unknown data name '{parts[0]}'", suggestions=hint)
            result = env[parts[0]]
            for part in parts[1:]:
                if not isinstance(result, dict) or part not in result:
                    avail = sorted(result.keys()) if isinstance(result, dict) else []
                    hint = difflib.get_close_matches(part, avail, n=3)
                    suffix = f" (available: {', '.join(avail)})" if avail else ""
                    fail("E_DATA_FIELD", path, f"Unknown field in '{expr}': {part}{suffix}", suggestions=hint)
                result = result[part]
            return copy.deepcopy(result)
        if isinstance(value, dict) and "format" in value:
            fields(value, {"format"}, path)
            template = value["format"]
            if not isinstance(template, str):
                fail("E_TYPE", path, "format must be text")
            try:
                pieces = []
                for literal, field, fmt, conversion in string.Formatter().parse(template):
                    pieces.append(literal)
                    if field is not None:
                        if fmt or conversion:
                            fail("E_EXPRESSION", path, "Formatting conversions are not supported")
                        datum = self.expression({"$": field}, env, path)
                        if isinstance(datum, (dict, list)):
                            fail("E_TYPE", path, "Only scalar fields can be formatted")
                        pieces.append(str(datum))
                return "".join(pieces)
            except ValueError as error:
                if isinstance(error, LanguageError):
                    raise
                fail("E_EXPRESSION", path, str(error))
        if isinstance(value, list):
            return [self.expression(v, env, ptr(path, i)) for i, v in enumerate(value)]
        if isinstance(value, dict):
            return {k: self.expression(v, env, ptr(path, k)) for k, v in value.items()}
        return value

    def resolve(self, reference, scope, path):
        if isinstance(reference, str):
            reference = {"ref": reference}
        fields(reference, {"ref"}, path)
        name = reference.get("ref")
        if not isinstance(name, str) or not name:
            fail("E_REFERENCE", path, "Expected {ref: 'id'}")
        if name.startswith("@") and len(name) > 1:
            name = name[1:]
        variants = [name]
        if "." in name and "/" not in name:
            variants.append(name.replace(".", "/"))
        candidates = []
        for var_name in variants:
            current = scope
            while current:
                candidates.append(current + "/" + var_name)
                current = current.rpartition("/")[0]
            candidates.append(var_name)
        for candidate in candidates:
            if candidate in self.symbols:
                return self.symbols[candidate]
        page_prefix = scope.split("/")[0] + "/"
        nested_matches = sorted(
            k for k in self.symbols
            if k.startswith(page_prefix) and (k.rsplit("/", 1)[-1] == name or k.endswith("/" + name))
        )
        if nested_matches:
            rel_suggestions = []
            for k in nested_matches:
                rel = k[len(scope) + 1:] if k.startswith(scope + "/") else k[len(page_prefix):]
                dot_rel = rel.replace("/", ".")
                for cand_rel in (rel, dot_rel, k):
                    if cand_rel not in rel_suggestions:
                        rel_suggestions.append(cand_rel)
            best_rel = rel_suggestions[0]
            best_dot = best_rel.replace("/", ".")
            fail(
                "E_REFERENCE",
                path,
                f"Unknown reference '{name}' in scope '{scope}'; target is inside a nested panel/component scope — use '{best_rel}' (or '{best_dot}')",
                suggestions=rel_suggestions[:3],
            )
        local_ids = sorted({k.rsplit("/", 1)[-1] for k in self.symbols if k.startswith(page_prefix) and k.rsplit("/", 1)[-1] != name})
        hint = difflib.get_close_matches(name, local_ids, n=3)
        fail("E_REFERENCE", path, f"Unknown reference '{name}' in scope '{scope}'", suggestions=hint)

    _COLOR_PROPS = {"fill", "stroke", "color", "trackColor", "trackFill", "barColor", "barFill",
                    "headerFill", "headerStroke", "rowFill", "rowStroke", "screenFill", "frameFill",
                    "activeFill", "activeColor", "inactiveFill", "inactiveColor", "headerColor"}

    def _check_color_tokens(self, source, path):
        for key in self._COLOR_PROPS & set(source):
            value = source.get(key)
            if isinstance(value, str) and value.startswith("$") and len(value) > 1:
                token = value[1:]
                palette = self.spec.get("palette") if isinstance(self.spec, dict) else None
                palette_keys = set(palette.keys()) if isinstance(palette, dict) else set()
                if token not in COLOR_TOKENS and token not in palette_keys:
                    hint = difflib.get_close_matches(token, sorted(COLOR_TOKENS), n=3, cutoff=0.5)
                    fail("E_COLOR", ptr(path, key),
                         f"Unknown color token '${token}'（不在内置颜色令牌或 palette 里；可跑 proto.py tokens 查内置表）",
                         suggestions=hint)

    def node(self, source, scope, env, path, stack=(), panel_depth=0):
        if not isinstance(source, dict):
            fail("E_OBJECT", path, "Expected a node object")
        if "_slot_origin" in source:
            path = source["_slot_origin"]
            source = {k: v for k, v in source.items() if k != "_slot_origin"}
        origin = self.source_origins.get(id(source))
        if origin is not None and origin[0] is source:
            path = origin[1]
        elif source.get("_auto_state_root") and path.endswith("/root"):
            path = path[:-5]
        source = self.desugar_node(source, path, scope)
        if not isinstance(source.get("type"), str):
            # 常见情况是把 @label 拼成 @lable：节点键名本身就是"类型"，但拼错后 type 为空。
            reserved = {"id", "name", "children", "text", "states", "template", "w", "h", "x", "y",
                        "padding", "gap", "fill", "stroke", "radius", "color", "on", "visible", "hidden"}
            suspect = [k for k in source if isinstance(k, str) and k not in reserved and not k.startswith("_")]
            known = sorted(set(NODE_PROPS.keys()) | set(MACRO_PROPS.keys())
                           | {"use", "repeat", "when", "row", "column", "grid", "stack", "label", "paragraph",
                              "button", "badge", "icon", "image", "input", "divider", "spacer"})
            hints = []
            for key in suspect:
                hints.extend(difflib.get_close_matches(str(key), known, n=1, cutoff=0.6))
            if hints:
                fail("E_NODE_TYPE", ptr(path, "type"),
                     f"节点缺少类型，疑似 '@{suspect[0]}' 拼写错误；did you mean '@{hints[0]}'?",
                     suggestions=hints[:3])
            fail("E_NODE_TYPE", ptr(path, "type"),
                 f"Node type must be text；可用类型：{', '.join(known[:14])}")
        kind = source.get("type")
        if kind == "droplist":
            kind = "combobox"
            source = {**source, "type": kind}
        if kind not in NODE_PROPS and kind not in {"use", "repeat", "when"}:
            known_types = sorted(set(NODE_PROPS.keys()) | set(MACRO_PROPS.keys()) | {"use", "repeat", "when", "row", "column", "grid", "stack"})
            hint = difflib.get_close_matches(str(kind), known_types, n=3, cutoff=0.5)
            fail("E_NODE_TYPE", ptr(path, "type"), f"Unsupported RP/1 node '{kind}'", suggestions=hint)
        fields(source, {"type", "id", "name", "on", "when", "visible", "hidden", "adaptive", "_hidden_lookup", "_master_instance", "_master_slot", "_phone_shell_opts"} | GEOMETRY |
               NODE_PROPS.get(kind, set()) |
               ({"component", "args"} if kind == "use" else set()) |
               ({"dataset", "as", "key", "template"} if kind == "repeat" else set()), path)
        self._check_color_tokens(source, path)
        nid = ident(source.get("id"), ptr(path, "id"))
        for _gk in ("w", "h"):
            _gv = source.get(_gk)
            if isinstance(_gv, (int, float)) and not isinstance(_gv, bool) and _gv <= 0:
                fail("E_SIZE", ptr(path, _gk),
                     f"{_gk} must be positive (got {_gv}); zero-size widgets cannot be laid out or rendered")
        logical = scope + "/" + nid
        for vis_key in ("visible", "hidden"):
            if vis_key in source:
                self.typecheck(source[vis_key], "boolean", ptr(path, vis_key))
        if "visible" in source and "hidden" in source and bool(source["visible"]) == bool(source["hidden"]):
            fail("E_PROPERTY", ptr(path, "hidden"), "Conflicting 'visible' and 'hidden' values on node")
        init_hidden = (source.get("hidden") is True) or (source.get("visible") is False)
        if init_hidden and "when" not in source and kind != "when":
            self.initial_hidden_nodes.append((scope, logical, ptr(path, "hidden" if "hidden" in source else "visible")))
        node_when_meta = None
        if "when" in source and kind != "when":
            cond_expr = self.expression(source.get("when"), env, ptr(path, "when"))
            node_when_meta = (scope, cond_expr, ptr(path, "when"), False)
            rep_id, rep_ctx = self.row_context(scope)
            if rep_ctx is not None:
                self.row_conditionals.append((rep_id, scope, cond_expr, [logical], [], ptr(path, "when")))
            else:
                self.page_conditionals.append((scope.split("/")[0], scope, cond_expr, [logical], [], ptr(path, "when")))
        if kind == "when":
            if "condition" not in source:
                fail("E_PROPERTY_REQUIRED", ptr(path, "condition"), "when node requires 'condition'")
            if "then" not in source and "else" not in source:
                fail("E_PROPERTY_REQUIRED", ptr(path, "then"), "when node requires 'then' or 'else'")
            cond_expr = self.expression(source.get("condition"), env, ptr(path, "condition"))
            then_children, then_ids, else_ids = [], [], []
            tnode, enode = None, None
            if "then" in source:
                if not isinstance(source["then"], dict):
                    fail("E_OBJECT", ptr(path, "then"), "then branch must be a node object")
                then_desugared = self.desugar_node(source["then"], ptr(path, "then"), scope)
                tnode = self.node(source["then"], scope, env, ptr(path, "then"), stack, panel_depth)
                tnode["_when_meta"] = (scope, cond_expr, ptr(path, "condition"), False)
                then_children.append(tnode)
                then_ids.append(scope + "/" + then_desugared["id"])
            if "else" in source:
                if not isinstance(source["else"], dict):
                    fail("E_OBJECT", ptr(path, "else"), "else branch must be a node object")
                else_desugared = self.desugar_node(source["else"], ptr(path, "else"), scope)
                enode = self.node(source["else"], scope, env, ptr(path, "else"), stack, panel_depth)
                enode["_when_meta"] = (scope, cond_expr, ptr(path, "condition"), True)
                then_children.append(enode)
                else_ids.append(scope + "/" + else_desugared["id"])
            if tnode is not None and enode is not None:
                wg_id = f"wg_{logical}"
                tnode["_when_group"] = wg_id
                tnode["_when_branch"] = 0
                enode["_when_group"] = wg_id
                enode["_when_branch"] = 1
            rep_id, rep_ctx = self.row_context(scope)
            if rep_ctx is not None:
                self.row_conditionals.append((rep_id, scope, cond_expr, then_ids, else_ids, ptr(path, "condition")))
            else:
                self.page_conditionals.append((scope.split("/")[0], scope, cond_expr, then_ids, else_ids, ptr(path, "condition")))
            when_box = {
                "type": "box",
                "name": self.register(logical, "box", source, path),
                "layout": source.get("layout", "row"),
                "gap": source.get("gap", 6),
                "w": source.get("w", "hug"),
                "h": source.get("h", "hug"),
                "children": then_children,
                **{k: source[k] for k in ("x", "y", "flex") if k in source},
            }
            if node_when_meta is not None:
                when_box["_when_meta"] = node_when_meta
            if init_hidden:
                when_box["visible"] = False
                when_box["hidden"] = True
                when_box["_when_default_visible"] = False
            return when_box
        if kind == "use":
            component = source.get("component")
            if component not in self.components:
                hint = difflib.get_close_matches(str(component), sorted(self.components.keys()), n=3)
                fail("E_COMPONENT", ptr(path, "component"), f"Unknown component '{component}'", suggestions=hint)
            if component in stack:
                fail("E_COMPONENT_CYCLE", path, " -> ".join((*stack, component)))
            definition = self.components[component]
            args = self.expression(source.get("args", {}), env, ptr(path, "args"))
            fields(args, definition.get("params", {}), ptr(path, "args"))
            for key, typ in definition.get("params", {}).items():
                if key not in args:
                    fail("E_ARGUMENT", ptr(path, "args"), f"Missing argument '{key}'")
                self.typecheck(args[key], typ, ptr(ptr(path, "args"), key))
            if any(k in source for k in GEOMETRY | {"on", "name"}):
                fail("E_PROPERTY", path, "Configure component layout/events through declared parameters")
            comp_env = dict(args)
            if "item" not in comp_env and env.get("_repeater_shadows_item"):
                comp_env["_repeater_shadows_item"] = True
            use_res = self.node(definition["root"], logical, comp_env,
                                ptr(ptr("/components", component), "root"), (*stack, component), panel_depth)
            if source.get("_master_slot") and isinstance(use_res, dict):
                use_res["_master_slot"] = True
            if node_when_meta is not None and isinstance(use_res, dict):
                use_res["_when_meta"] = node_when_meta
            if init_hidden and isinstance(use_res, dict):
                use_res["visible"] = False
                use_res["hidden"] = True
                use_res["_when_default_visible"] = False
            return use_res
        if kind == "repeater":
            rep_res = self.repeater_node(source, scope, env, path, stack, panel_depth)
            if node_when_meta is not None and isinstance(rep_res, dict):
                rep_res["_when_meta"] = node_when_meta
            if init_hidden and isinstance(rep_res, dict):
                rep_res["visible"] = False
                rep_res["hidden"] = True
                rep_res["_when_default_visible"] = False
            return rep_res
        if kind == "repeat":
            if "on" in source or "name" in source:
                fail("E_PROPERTY", path, "Put repeat events and labels on its template")
            dataset = source.get("dataset")
            if dataset not in self.datasets:
                hint = difflib.get_close_matches(str(dataset), sorted(self.datasets.keys()), n=3)
                fail("E_DATASET", ptr(path, "dataset"), f"Unknown dataset '{dataset}'", suggestions=hint)
            alias = ident(source.get("as", "item"), ptr(path, "as"))
            key = source.get("key", "id")
            rows = self.datasets[dataset]["rows"]
            model = self.models[self.datasets[dataset]["model"]]
            if key not in model or model[key] != "text":
                fail("E_DATA_KEY", ptr(path, "key"), "Repeat key must be a text field")
            seen, children = set(), []
            for idx, row in enumerate(rows):
                item_key = row[key]
                if not item_key or item_key in seen:
                    fail("E_DATA_KEY", path, f"Empty or duplicate repeat key '{item_key}'")
                seen.add(item_key)
                # Key hash makes all Unicode data identities safe in output names.
                row_scope = logical + "[" + hashlib.sha256(item_key.encode()).hexdigest()[:16] + "]"
                child_env = {**env, alias: row}
                if alias == "item":
                    child_env.pop("_repeater_shadows_item", None)
                children.append(self.node(source.get("template"), row_scope, child_env,
                                          ptr(path, "template"), stack, panel_depth))
            repeat_box = {"type": "box", "name": self.register(logical, "box", source, path),
                          "layout": "column", "children": children,
                          **{k: source[k] for k in GEOMETRY if k in source}}
            if node_when_meta is not None:
                repeat_box["_when_meta"] = node_when_meta
            if init_hidden:
                repeat_box["visible"] = False
                repeat_box["hidden"] = True
                repeat_box["_when_default_visible"] = False
            return repeat_box
        raw_src_text = source.get("text")
        is_shorthand_text = isinstance(raw_src_text, str) or (isinstance(raw_src_text, dict) and "_sigil_var" in raw_src_text)
        eval_text = self.expression(raw_src_text, env, ptr(path, "text")) if "text" in source else None
        runtime_text = ({"_coerce_text": eval_text} if (is_shorthand_text and "_coerce_text" not in eval_text) else eval_text) if isinstance(eval_text, dict) else None
        if runtime_text is not None:
            if kind not in {"label", "paragraph", "button", "badge"}:
                fail("E_TARGET_TYPE", ptr(path, "text"), "Runtime text bindings need label/paragraph/button/badge")
            self.value_bindings.append((logical, scope, runtime_text, ptr(path, "text")))
        if self.row_context(scope)[1] is not None and kind in FORM_KINDS | {"dynamic-panel"}:
            fail("E_ROW_CONTAINER", path, "Row templates currently support visual nodes and events")
        if "size" in source and "fontSize" not in source:
            source = {**source, "fontSize": source["size"]}
        if "weight" in source and "fontWeight" not in source:
            source = {**source, "fontWeight": source["weight"]}
        values = self.expression({k: ("" if k == "text" and runtime_text is not None else (eval_text if k == "text" else v)) for k, v in source.items()
                                  if k not in {"children", "states", "on", "id", "name", "when", "size", "weight"}}, env, path)
        if kind == "icon" and isinstance(values.get("icon"), str) and values["icon"].strip().lower() not in ICON_NAMES:
            fail("E_ICON_NAME", ptr(path, "icon"), f"Unknown built-in icon '{values['icon']}'",
                 suggestions=sorted(ICON_NAMES))
        if "fontWeight" in values:
            values["fontWeight"] = normalize_font_weight(values["fontWeight"])
        if "fontFamily" in values and (not isinstance(values["fontFamily"], str) or not values["fontFamily"].strip()):
            fail("E_TYPE", ptr(path, "fontFamily"), "fontFamily must be a non-empty family name")
        if "variant" in values and isinstance(values["variant"], str):
            v_norm = values["variant"].strip().lower()
            if v_norm in ("solid", "brand"):
                if kind == "badge" and v_norm == "brand":
                    values.setdefault("fill", "$brand-soft")
                    values.setdefault("color", "$brand")
                    values["variant"] = "soft"
                else:
                    values["variant"] = "primary"
            elif v_norm in ("success", "ok"):
                values.setdefault("fill", "$success-soft")
                values.setdefault("color", "$success")
                values["variant"] = "soft"
            elif v_norm in ("warning", "warn"):
                values.setdefault("fill", "$warning-soft")
                values.setdefault("color", "$warning")
                values["variant"] = "soft"
            elif v_norm in ("error", "err", "danger"):
                if kind == "badge":
                    values.setdefault("fill", "$danger-soft")
                    values.setdefault("color", "$danger")
                    values["variant"] = "soft"
                else:
                    values["variant"] = "danger"
            elif v_norm in ("muted", "default", "neutral"):
                if kind == "badge":
                    values.setdefault("fill", "$surface-2")
                    values.setdefault("color", "$ink-2")
                values["variant"] = "soft"
        for c_prop in ("fill", "stroke", "color"):
            if c_prop in values:
                values[c_prop] = normalize_color_token(values[c_prop])
        if "justify" in values and isinstance(values["justify"], str):
            values["justify"] = JUSTIFY_ALIASES.get(values["justify"].strip().lower(), values["justify"])
        if "align" in values and isinstance(values["align"], str):
            al_map = BOX_ALIGN_ALIASES if kind in {"box", "card"} else TEXT_ALIGN_ALIASES
            values["align"] = al_map.get(values["align"].strip().lower(), values["align"])
        for key, value in values.items():
            pp = ptr(path, key)
            if key in {"w", "h"}:
                if value not in ("fill", "hug", "auto"):
                    self.typecheck(value, "number", pp)
                    if value < 0:
                        fail("E_SIZE", pp, "Size must be nonnegative")
            elif key in {"x", "y", "right", "bottom", "rotation", "flex", "gap", "columnGap", "rowGap", "radius", "fontSize", "fontWeight", "textPaddingX", "lineGap", "lineHeight", "letterSpacing", "opacity", "strokeWidth", "backdropBlur", "maxLines"}:
                self.typecheck(value, "number", pp)
                if key not in {"x", "y", "right", "bottom", "rotation"} and value < 0:
                    fail("E_SIZE", pp, "Value must be nonnegative")
                if key == "fontSize":
                    validate_font_size(value, pp)
                if key in {"lineHeight", "fontSize"} and value == 0:
                    fail("E_SIZE", pp, f"{key} must be positive")
            elif key in {"colSpan", "rowSpan"}:
                if type(value) is not int or value < 1:
                    fail("E_SIZE", pp, f"{key} must be a positive integer")
            elif key in {"text", "title", "subtitle", "rightText", "placeholder", "value", "src", "fill", "stroke", "color", "icon"}:
                self.typecheck(value, "text", pp)
                if key in {"fill", "stroke", "color"}:
                    custom_tokens = set((self.spec.get("palette") or {}).keys())
                    valid_token = value.startswith("$") and (value[1:] in COLOR_TOKENS or value[1:] in custom_tokens)
                    valid_hex = bool(re.fullmatch(r"#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})", value))
                    valid_rgba = bool(re.fullmatch(r"rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)", value))
                    if not (valid_token or valid_hex or valid_rgba or value == "transparent"):
                        fail("E_COLOR", pp, "Expected a known $color-token, #RGB, #RRGGBB, #RRGGBBAA, or rgba(...)")
            elif key in {"native", "equalHeight", "wrap", "italic", "underline", "strikethrough", "smooth", "borderTop", "borderBottom", "borderLeft", "borderRight", "visible", "hidden", "checked", "selected", "disabled", "multiple"}:
                self.typecheck(value, "boolean", pp)
            elif key == "columns":
                if type(value) is not int or value < 1:
                    fail("E_TYPE", pp, "columns must be a positive integer")
            elif key == "padding":
                vals = value if isinstance(value, list) else [value]
                if len(vals) not in (1, 2, 4):
                    fail("E_TYPE", pp, "padding needs 1, 2 or 4 numbers")
                for val in vals:
                    self.typecheck(val, "number", pp)
                    if val < 0:
                        fail("E_SIZE", pp, "padding must be nonnegative")
        if isinstance(values.get("spans"), list):
            for index, span in enumerate(values["spans"]):
                if isinstance(span, dict):
                    for key in ("fontSize", "size"):
                        if key in span:
                            validate_font_size(span[key], ptr(ptr(ptr(path, "spans"), index), key))
        if init_hidden:
            values["visible"] = False
            values["hidden"] = True
            values["_when_default_visible"] = False
        for key, choices in {"layout": {"row", "column", "stack", "grid"},
                             "justify": {"start", "center", "end", "space-between", "space-around", "space-evenly"},
                             "variant": {"primary", "secondary", "outline", "soft", "danger", "glass", "ghost"},
                             "direction": {"horizontal", "vertical"},
                             "anchor": {"top-left", "top-right", "bottom-left", "bottom-right", "center"}}.items():
            if key in values and values[key] not in choices:
                fail("E_ENUM", ptr(path, key), f"Expected one of {sorted(choices)}")
        for key, choices in {"alignX": {"left", "center", "right"}, "pin": {"top", "bottom", "left", "right"}}.items():
            if key in values and (not isinstance(values[key], str) or values[key] not in choices):
                fail("E_PROPERTY", ptr(path, key), f"Expected one of {sorted(choices)}")
        for key in ("afterGap", "pinGap"):
            if key in values:
                self.typecheck(values[key], "number", ptr(path, key))
        if "align" in values:
            choices = {"start", "center", "end", "stretch"} if kind in {"box", "card"} else {"left", "center", "right"}
            if values["align"] not in choices:
                fail("E_ENUM", ptr(path, "align"), f"Expected one of {sorted(choices)}")
        if kind == "input":
            if values.get("native") is False:
                fail("E_INPUT", path, "RP/1 inputs are native; use a box/label for decoration")
            values["native"] = True
        if kind in CHECK_KINDS:
            if "selected" in values and "checked" in values and values["selected"] != values["checked"]:
                fail("E_PROPERTY", ptr(path, "selected"), "selected and checked must agree; use checked for checkbox/radio")
            values.setdefault("checked", values.get("selected", False))
            if "group" in values:
                self.typecheck(values["group"], "text", ptr(path, "group"))
                if not values["group"].strip():
                    fail("E_PROPERTY", ptr(path, "group"), "Radio group must be nonempty")
        if kind in OPTION_KINDS:
            options = values.get("options")
            if not isinstance(options, list) or not options or any(not isinstance(v, str) or not v for v in options):
                fail("E_OPTIONS", ptr(path, "options"), "options must be a nonempty array of nonempty strings")
            selected_index = values.get("selectedIndex", 0)
            if type(selected_index) is not int or not 0 <= selected_index < len(options):
                fail("E_OPTIONS", ptr(path, "selectedIndex"), "selectedIndex must address an existing option")
            if "selectedIndices" in values:
                indices = values["selectedIndices"]
                if "selectedIndex" in values:
                    fail("E_OPTIONS", path, "Use selectedIndex or selectedIndices, not both")
                if not isinstance(indices, list) or any(type(i) is not int or not 0 <= i < len(options) for i in indices) or len(indices) != len(set(indices)):
                    fail("E_OPTIONS", ptr(path, "selectedIndices"), "selectedIndices must contain distinct valid indices")
                if not values.get("multiple", False) and len(indices) > 1:
                    fail("E_OPTIONS", ptr(path, "selectedIndices"), "Single-select listbox accepts at most one selection")
            else:
                values["selectedIndex"] = selected_index
            if kind == "listbox":
                values.setdefault("multiple", False)
        if "selectionGroup" in values:
            self.typecheck(values["selectionGroup"], "text", ptr(path, "selectionGroup"))
        if "styles" in values:
            styles = values["styles"]
            if not isinstance(styles, dict):
                fail("E_TYPE", ptr(path, "styles"), "styles must be an object")
            fields(styles, {"hover", "selected", "disabled", "focused"}, ptr(path, "styles"))
            for state, overrides in styles.items():
                sp = ptr(ptr(path, "styles"), state)
                if not isinstance(overrides, dict):
                    fail("E_TYPE", sp, "State style must be an object")
                fields(overrides, STATE_STYLE_KEYS, sp)
                self._check_color_tokens(overrides, sp)
                for key, value in overrides.items():
                    self.typecheck(value, "text" if key in {"fill", "stroke", "color", "fontFamily"} else "number", ptr(sp, key))
                    if key == "fontSize":
                        validate_font_size(value, ptr(sp, key))
                    elif key not in {"fill", "stroke", "color", "fontFamily"} and value < 0:
                        fail("E_SIZE", ptr(sp, key), "Style value must be nonnegative")
        if kind == "image" and not values.get("src"):
            fail("E_PROPERTY_REQUIRED", ptr(path, "src"), "Image requires src")
        if "name" in source:
            eval_name = self.expression(source["name"], env, ptr(path, "name")) if isinstance(source["name"], str) and source["name"].startswith("$") and env else source["name"]
            self.typecheck(eval_name, "text", ptr(path, "name"))
            source = {**source, "name": eval_name}
        if runtime_text is not None: values.setdefault("w", "fill")
        if kind == "paragraph":
            values["_rp1_single_shape"] = True
        values["name"] = self.register(logical, kind, source, path)
        if kind == "input" and values.get("rotation"):
            self.input_rotations.append((logical, values["name"], values["rotation"], path))
        if "children" in source:
            if not isinstance(source["children"], list):
                fail("E_TYPE", ptr(path, "children"), "Expected a node array")
            values["children"] = [self.node(c, scope, env, ptr(ptr(path, "children"), i), stack, panel_depth)
                                  for i, c in enumerate(source["children"])]
            if any(isinstance(child, dict) and "after" in child for child in source["children"]):
                sibling_refs = {}
                for child, lowered_child in zip(source["children"], values["children"]):
                    if not isinstance(child, dict):
                        continue
                    child_id = child.get("id") or next((child[k] for k in SHORTHAND_NODE_KINDS if isinstance(child.get(k), str)), None)
                    for alias in (child_id, child.get("name"), lowered_child.get("name")):
                        if isinstance(alias, str):
                            sibling_refs[alias] = lowered_child
                for i, child in enumerate(source["children"]):
                    if isinstance(child, dict) and "after" in child:
                        ref = child["after"]
                        target = sibling_refs.get(ref) if isinstance(ref, str) else None
                        if target is None and isinstance(ref, str) and ref.startswith(scope + "/"):
                            target = sibling_refs.get(ref[len(scope) + 1:])
                        if target is None or target is values["children"][i]:
                            origin = self.source_origins.get(id(child))
                            child_path = origin[1] if origin is not None and origin[0] is child else ptr(ptr(path, "children"), i)
                            fail("E_REFERENCE", ptr(child_path, "after"), "after must reference another sibling ID")
                        if values.get("layout") == "stack":
                            values["children"][i]["after"] = target["name"]
        if kind == "dynamic-panel":
            states = source.get("states")
            if not isinstance(states, list) or not states:
                fail("E_STATE", ptr(path, "states"), "Panel requires nonempty states")
            values["states"], names = [], set()
            for i, state in enumerate(states):
                sp = ptr(ptr(path, "states"), i)
                if not isinstance(state, dict):
                    fail("E_STATE", sp, "Panel state must be an object with 'id' and 'root' (or 'children')")
                fields(state, {"id", "name", "root"}, sp)
                if "name" in state:
                    self.typecheck(state["name"], "text", ptr(sp, "name"))
                sid = ident(state.get("id"), ptr(sp, "id"))
                if sid in names:
                    fail("E_STATE", sp, f"Duplicate state '{sid}'")
                if not isinstance(state.get("root"), dict):
                    fail("E_STATE", ptr(sp, "root"), f"Panel state '{sid}' requires a 'root' node object or 'children' array")
                names.add(sid)
                values["states"].append({"name": sid, "prefix": values["name"] + "-" + sid,
                    "root": self.node(state.get("root"), logical + "/" + sid, env,
                                      ptr(sp, "root"), stack, panel_depth + 1)})
            self.symbols[logical]["states"] = sorted(names)
        if "on" in source:
            if not isinstance(source["on"], dict):
                fail("E_EVENT", ptr(path, "on"), "on must be an event map")
            if any(event in source["on"] for event in ("load", "OnLoad")):
                fail("E_EVENT_TARGET", ptr(path, "on"), "load events require a page target")
            if kind not in FORM_KINDS and any(event in source["on"] for event in ("change", "focus", "blur", "OnTextChange", "OnFocus", "OnLostFocus")):
                fail("E_EVENT_TARGET", ptr(path, "on"), "Input events require a native input")
            if kind != "dynamic-panel" and any(event in source["on"] for event in ("statechange", "OnPanelStateChange")):
                fail("E_EVENT_TARGET", ptr(path, "on"), "State-change events require a dynamic panel")
            self.pending.append((logical, scope, self.expression(source["on"], env, ptr(path, "on")), ptr(path, "on")))
        if node_when_meta is not None:
            values["_when_meta"] = node_when_meta
        return values

    def register(self, logical, kind, source, path):
        if logical in self.symbols:
            fail("E_DUPLICATE_ID", ptr(path, "id"), f"Duplicate identity '{logical}'")
        prefix = {"box": "grp", "card": "grp", "label": "txt", "paragraph": "txt",
                  "button": "btn", "badge": "badge", "input": "inp", "radio": "radio", "checkbox": "check", "combobox": "combo", "listbox": "list", "image": "img",
                  "icon": "img", "sparkline": "img",
                  "dynamic-panel": "panel", "repeater": "rep", "divider": "line"}[kind]
        name = prefix + "-" + re.sub(r"[^A-Za-z0-9_-]", "-", logical.rsplit("/", 1)[-1]) + "-" + hashlib.sha256(logical.encode()).hexdigest()[:12]
        if "name" in source:
            self.typecheck(source["name"], "text", ptr(path, "name"))
        display = re.sub(r"[\r\n]+", " ", source.get("name", "")).strip() or name
        self.identity_labels[logical] = source.get("id")
        self.symbols[logical] = {"id": logical, "kind": kind, "name": name,
                                 "display": display,
                                 "label": source.get("name", source.get("id")), "pointer": path,
                                 "pageId": logical.split("/")[0]}
        macro_path = max((p for p in self.macro_calls if path == p or path.startswith(p + "/")), key=len, default=None)
        if macro_path is not None:
            self.symbols[logical]["source"] = {"macro": self.macro_calls[macro_path], "macroPointer": macro_path, "parameterPointer": path}
        if self.product_provenance:
            psym = self.product_provenance.get("symbolOrigins") or self.product_provenance.get("symbols") or {}
            if logical in psym:
                self.symbols[logical]["productOrigin"] = copy.deepcopy(psym[logical])
            else:
                best_prefix = max((k for k in psym if logical.startswith(k + "/") or logical.startswith(k + "_")), key=len, default=None)
                if best_prefix is not None:
                    self.symbols[logical]["productOrigin"] = copy.deepcopy(psym[best_prefix])
        return name

    def compile_bindings(self, by_id):
        bindings = []
        for logical, scope, value, path in self.value_bindings:
            symbol = self.symbols[logical]
            ast = self.runtime(value, scope, path, expected="text")
            variables, widgets = set(), set()
            def dependencies(node):
                if node.get("kind") == "variable": variables.add(node["name"])
                if node.get("kind") == "widget": widgets.add(node["name"])
                for v in node.values():
                    if isinstance(v, dict): dependencies(v)
                    if isinstance(v, list):
                        for c in v:
                            if isinstance(c, dict): dependencies(c)
            dependencies(ast)
            bindings.append({"symbol": symbol, "scope": scope, "path": path, "ast": ast,
                             "variables": variables, "widgets": widgets, "row": self.row_context(scope)[1]})
        by_name = {b["symbol"]["name"]: b for b in bindings}
        ordered, done, visiting = [], set(), set()
        def visit(binding):
            name = binding["symbol"]["name"]
            if name in visiting: fail("E_BINDING_CYCLE", binding["path"], "Cyclic text bindings")
            if name in done: return
            visiting.add(name)
            for dependency in sorted(binding["widgets"]):
                if dependency in by_name: visit(by_name[dependency])
            visiting.remove(name); done.add(name); ordered.append(binding)
        for binding in bindings: visit(binding)
        native_nodes = {}
        def index(node):
            if node.get("name"): native_nodes[node["name"]] = node
            for child in node.get("children", []): index(child)
            for state in node.get("states", []): index(state["root"])
            if isinstance(node.get("template"), dict): index(node["template"])
        for page in by_id.values(): index(page["root"])
        self._native_nodes = native_nodes
        self.prepare_computed_vars()
        grouped_bindings = {}
        for binding in ordered:
            symbol, row = binding["symbol"], binding["row"]
            node = native_nodes[symbol["name"]]
            node["text"] = self._eval_static_ast(binding["ast"])
            if row and row.get("rows"):
                fsz = node.get("fontSize", 12 if node.get("type") == "badge" else 13)
                fwt = node.get("fontWeight", 600 if node.get("type") == "badge" else 400)
                samples = []
                for r_idx, r_data in enumerate(row["rows"]):
                    r_txt = str(self._eval_static_ast(binding["ast"], row_override=r_data))
                    samples.append((r_idx, r_txt, _estimate_visual_px(r_txt, fsz, fwt)))
                node["_row_texts"] = [s[1] for s in samples if s[0] >= 0]
                if binding["ast"].get("kind") == "item" and binding["ast"].get("modelName"):
                    dom_meta = self.domain_models.get(binding["ast"]["modelName"], {}).get(binding["ast"]["field"])
                    if dom_meta and dom_meta.get("domain") == "enum":
                        for ev_val in dom_meta.get("values", []):
                            samples.append((-1, str(ev_val), _estimate_visual_px(str(ev_val), fsz, fwt)))
                if samples:
                    widths = sorted(s[2] for s in samples)
                    worst_idx, worst_txt, max_px = max(samples, key=lambda x: x[2])
                    envelope = {
                        "minPx": round(widths[0], 1),
                        "typicalPx": round(widths[len(widths) // 2], 1),
                        "maxPx": round(max_px, 1),
                        "worstRowIndex": worst_idx,
                        "worstText": worst_txt,
                        "pointer": symbol["pointer"],
                        "symbolId": symbol["id"],
                    }
                    symbol["inkEnvelope"] = envelope
                    node["_worst_case"] = envelope
                    if isinstance(node.get("w"), (int, float)):
                        actual_w = node["w"]
                        actual_h = node.get("h", 24) if isinstance(node.get("h"), (int, float)) else 24
                        lines_cap = max(1, int(actual_h // max(14, fsz + 3))) if (node.get("type") == "label" and bool(node.get("wrap"))) else 1
                        pad_extra = 8 if node.get("type") in ("badge", "button") else 0
                        needed_w = int(math.ceil((max_px / lines_cap) + max(12, pad_extra)))
                        if (max_px / lines_cap) + max(4, pad_extra) > actual_w + 2:
                            w_ptr = ptr(symbol["pointer"], "w")
                            wrap_ptr = ptr(symbol["pointer"], "wrap")
                            h_ptr = ptr(symbol["pointer"], "h")
                            eff_line_w = max(20.0, float(actual_w) - 18.0)
                            needed_lines = max(2, int(math.ceil(max_px / eff_line_w)) + 1)
                            needed_h = max(actual_h, needed_lines * max(16, int(math.ceil(fsz * 1.5))) + 4)
                            wrap_expand_ops = [
                                {"op": "add", "path": wrap_ptr, "value": True},
                                {"op": "replace", "path": h_ptr, "value": needed_h},
                            ]
                            if "/template/" in symbol["pointer"]:
                                tpl_h_ptr = symbol["pointer"].split("/template/")[0] + "/template/h"
                                wrap_expand_ops.append({"op": "replace", "path": tpl_h_ptr, "value": needed_h + 18})
                            cands = [
                                {
                                    "description": f"Expand width to {needed_w}px to fit worst-case dataset row #{worst_idx} ('{worst_txt}')",
                                    "operations": [{"op": "replace", "path": w_ptr, "value": needed_w}],
                                },
                                *(
                                    [
                                        {
                                            "description": "Enable multi-line text wrapping ('wrap': true)",
                                            "operations": [{"op": "add", "path": wrap_ptr, "value": True}],
                                        }
                                    ]
                                    if node.get("type") == "label" and actual_h >= max(26, int(round(fsz * 2.1)))
                                    else []
                                ),
                                *(
                                    [
                                        {
                                            "description": f"Enable multi-line text wrapping ('wrap': true) and expand height to {needed_h}px",
                                            "operations": wrap_expand_ops,
                                        }
                                    ]
                                    if node.get("type") == "label" and needed_h > actual_h
                                    else []
                                ),
                                {
                                    "description": "Use elastic width 'fill'",
                                    "operations": [{"op": "replace", "path": w_ptr, "value": "fill"}],
                                },
                            ]
                            fail(
                                "E_DATASET_WORST_CASE_OVERFLOW",
                                w_ptr,
                                f"Dataset row #{worst_idx} text '{worst_txt}' (~{int(math.ceil(max_px + 4))}px) overflows fixed width {actual_w}px (recommended >= {needed_w}px)",
                                counterexample={
                                    "rowIndex": worst_idx,
                                    "worstText": worst_txt,
                                    "actualWidth": actual_w,
                                    "neededWidth": needed_w,
                                    "inkEnvelope": envelope,
                                },
                                candidate_patches=cands,
                            )
            key = (symbol["pageId"], row["name"] if row else "page", "OnItemLoad" if row else "OnLoad")
            grouped_bindings.setdefault(key, {
                "sourceId": symbol["id"],
                "sourcePointer": binding["path"],
                "actions": [],
            })["actions"].append({"type": "set-text", "target": symbol["name"], "runtime": binding["ast"]})
        for (page_id, trigger_name, ev_name), ginfo in grouped_bindings.items():
            by_id[page_id]["interactions"].append({
                "trigger": trigger_name,
                "sourceId": ginfo["sourceId"],
                "sourcePointer": ginfo["sourcePointer"],
                "events": [{
                    "event": ev_name,
                    "cases": [{
                        "description": "RP/1 value binding",
                        "isNewIfGroup": False,
                        "actions": ginfo["actions"],
                    }],
                }],
            })
        return ordered

    def _eval_static_ast(self, ast, row_override=None):
        kind = ast["kind"]
        if kind == "literal": return ast["value"]
        if kind == "variable": return self.variables[ast["name"]]["value"]
        if kind == "widget":
            node = self._native_nodes[ast["name"]]
            if node["type"] in CHECK_KINDS: return node.get("checked", False)
            if node["type"] in OPTION_KINDS:
                indices = node.get("selectedIndices", [node.get("selectedIndex", 0)])
                return node["options"][indices[0]] if indices else ""
            return node.get("value" if node["type"] == "input" else "text", "")
        if kind in ("item", "caller_item"):
            if row_override is not None and ast["field"] in row_override:
                return row_override[ast["field"]]
            context = next(c for c in self.repeaters.values() if c["name"] == ast["repeater"])
            return context["rows"][0][ast["field"]] if context["rows"] else {"text":"", "number":0, "boolean":False}[ast["valueType"]]
        if kind == "binary":
            left, right = self._eval_static_ast(ast["left"], row_override), self._eval_static_ast(ast["right"], row_override)
            operations = {"+":lambda: left+right,"-":lambda:left-right,"*":lambda:left*right,"/":lambda:left/right,
                          "==":lambda:left==right,"!=":lambda:left!=right,">":lambda:left>right,"<":lambda:left<right,
                          ">=":lambda:left>=right,"<=":lambda:left<=right,"&&":lambda:left and right,"||":lambda:left or right}
            try: return operations[ast["op"]]()
            except ZeroDivisionError: return 0
        args = [self._eval_static_ast(a, row_override) for a in ast["args"]]
        fn = ast["fn"]
        if fn == "text": return str(args[0]).lower() if type(args[0]) is bool else str(int(args[0])) if type(args[0]) is float and args[0].is_integer() else str(args[0])
        if fn == "concat": return "".join(self._format_scalar(a) if type(a) in (str, int, float, bool) else str(a) for a in args)
        if fn == "lower": return args[0].lower()
        if fn == "upper": return args[0].upper()
        if fn == "length": return len(args[0].encode("utf-16-le")) // 2
        if fn == "contains": return args[1] in args[0]
        if fn == "remove": return args[0].replace(args[1], "", 1)
        if fn == "not": return not args[0]
        if fn == "number":
            if type(args[0]) in (int, float): return args[0]
            value = args[0].strip()
            if re.fullmatch(r"0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+", value):
                return int(value, 0)
            try:
                number = float(value) if value else 0
                return 0 if math.isnan(number) else number
            except ValueError: return 0

    def prepare_computed_vars(self):
        self.compiled_aggregates = []
        self.compiled_formulas = []
        if not self.computed_vars:
            return
        default_page_id = self.spec["pages"][0]["id"]
        for vname, cinfo in self.computed_vars.items():
            cspec = cinfo["compute"]
            cptr = cinfo["pointer"]
            if isinstance(cspec, dict):
                op = cspec.get("op")
                if op not in ("count", "sum"):
                    fail("E_COMPUTED", cptr, f"Unsupported aggregate op '{op}'; expected 'count' or 'sum'")
                tref = cspec.get("dataset") or cspec.get("target") or cspec.get("repeater")
                rep_entry = next(
                    ((rid, rctx) for rid, rctx in self.repeaters.items()
                     if rctx.get("datasetName") == tref or rid == tref or rid.endswith("/" + str(tref)) or rctx["name"] == tref),
                    None,
                )
                if rep_entry is None:
                    fail("E_DATASET", cptr, f"Aggregate variable '{vname}' references unknown Repeater/dataset '{tref}'")
                rep_id, rep_ctx = rep_entry
                row_scope = rep_id + "/item"
                where_ast = None
                if "where" in cspec and cspec["where"] is not None:
                    where_ast = self.runtime(self.expression(cspec["where"], {"_repeater_shadows_item": True}, cptr), row_scope, cptr, expected="boolean", row=(rep_id, rep_ctx))
                if op == "count":
                    val_ast = {"kind": "literal", "value": 1, "valueType": "number"}
                else:
                    fspec = cspec.get("field") or cspec.get("expr")
                    if not fspec:
                        fail("E_PROPERTY_REQUIRED", cptr, "sum aggregate requires 'field' or 'expr'")
                    raw_f = fspec if (isinstance(fspec, str) and fspec.startswith("=")) or isinstance(fspec, dict) else {"item": fspec}
                    val_ast = self.runtime(self.expression(raw_f, {"_repeater_shadows_item": True}, cptr), row_scope, cptr, expected="number", row=(rep_id, rep_ctx))
                agg_scope = cspec.get("scope", "visible")
                if agg_scope not in ("visible", "dataset"):
                    fail("E_ENUM", ptr(cptr, "scope"), "Aggregate scope must be 'visible' or 'dataset'")
                initial_rows = rep_ctx["rows"]
                if agg_scope == "visible" and rep_ctx.get("pageSize"):
                    initial_rows = initial_rows[:rep_ctx["pageSize"]]
                init_total = 0
                for r in initial_rows:
                    if where_ast is None or bool(self._eval_static_ast(where_ast, r)):
                        v = self._eval_static_ast(val_ast, r)
                        init_total += v
                if isinstance(init_total, float) and init_total.is_integer():
                    init_total = int(init_total)
                self.variables[vname]["value"] = init_total
                guard_var = f"rp1_agg_{vname}"
                self.variables[guard_var] = {"type": "number", "value": 0}
                variables, widgets = set(), set()
                def dependencies(ast):
                    if not isinstance(ast, dict): return
                    if ast.get("kind") == "variable": variables.add(ast["name"])
                    if ast.get("kind") == "widget": widgets.add(ast["name"])
                    for value in ast.values():
                        if isinstance(value, dict): dependencies(value)
                        elif isinstance(value, list):
                            for item in value: dependencies(item)
                dependencies(where_ast); dependencies(val_ast)
                self.compiled_aggregates.append({
                    "name": vname, "guardVar": guard_var, "repeaterId": rep_id,
                    "repeaterName": rep_ctx["name"], "pageId": rep_ctx["pageId"],
                    "whereAst": where_ast, "valAst": val_ast, "scope": agg_scope, "pointer": cptr,
                    "variables": sorted(variables), "widgets": sorted(widgets),
                })
            else:
                vtype = self.variables[vname]["type"]
                fast = self.runtime(self.expression(cspec, {}, cptr), default_page_id, cptr, expected=vtype)
                deps_v, deps_w = set(), set()
                def collect_deps(n):
                    if not isinstance(n, dict): return
                    if n.get("kind") == "variable": deps_v.add(n["name"])
                    if n.get("kind") == "widget": deps_w.add(n["name"])
                    for ch in n.values():
                        if isinstance(ch, dict): collect_deps(ch)
                        elif isinstance(ch, list):
                            for item in ch:
                                if isinstance(item, dict): collect_deps(item)
                collect_deps(fast)
                self.compiled_formulas.append({
                    "name": vname, "ast": fast, "variables": deps_v, "widgets": deps_w, "pointer": cptr,
                })
        computed_graph = {item["name"]: item for item in self.compiled_aggregates + self.compiled_formulas}
        visited_computed, visiting_computed, ordered_computed = set(), set(), []
        def visit_computed(name):
            item = computed_graph[name]
            if name in visiting_computed:
                fail("E_BINDING_CYCLE", item["pointer"], f"Cyclic computed variable '{name}'")
            if name in visited_computed: return
            visiting_computed.add(name)
            for dependency in sorted(item["variables"]):
                if dependency in computed_graph: visit_computed(dependency)
            visiting_computed.remove(name); visited_computed.add(name); ordered_computed.append(item)
        for name in computed_graph: visit_computed(name)
        self.computed_order = ordered_computed
        # Visible totals settle during repeater refresh, after normal actions.
        # Feeding them back into another aggregate cannot be evaluated safely.
        def has_visible_dependency(name):
            item = computed_graph.get(name)
            return item is not None and (item.get("scope") == "visible" or any(has_visible_dependency(dep) for dep in item["variables"]))
        for aggregate in self.compiled_aggregates:
            if any(has_visible_dependency(dep) for dep in aggregate["variables"]):
                fail("E_COMPUTED_DEPENDENCY", aggregate["pointer"], "An aggregate cannot depend on a visible aggregate; use a formula for derived visible totals")
        self.compiled_formulas = [item for item in ordered_computed if "ast" in item]
        for item in ordered_computed:
            if "ast" in item:
                value = self._eval_static_ast(item["ast"])
            else:
                context = self.repeaters[item["repeaterId"]]
                rows = context["rows"]
                if item["scope"] == "visible" and context["pageSize"]: rows = rows[:context["pageSize"]]
                value = sum(self._eval_static_ast(item["valAst"], row) for row in rows if item["whereAst"] is None or bool(self._eval_static_ast(item["whereAst"], row)))
            if isinstance(value, float) and value.is_integer(): value = int(value)
            self.variables[item["name"]]["value"] = value

    def emit_conditionals_and_aggregates(self, by_id, bindings):
        page_bindings = [b for b in bindings if not b["row"]]
        # Native PageLoaded precedes the first repeater refresh. Source-row
        # initialization also avoids cross-record DataSet expressions when a
        # repeater belongs to a private panel-state record.
        def source_row_ast(ast, row):
            if isinstance(ast, list): return [source_row_ast(value, row) for value in ast]
            if not isinstance(ast, dict): return ast
            if ast.get("kind") == "item":
                return {"kind": "literal", "value": row[ast["field"]], "valueType": ast["valueType"]}
            return {key: source_row_ast(value, row) for key, value in ast.items()}
        aggregate_pages = {}
        for aggregate in getattr(self, "computed_order", []):
            if "repeaterId" in aggregate:
                aggregate_pages.setdefault(aggregate["pageId"], []).append(aggregate)
        for page_id, page_aggregates in aggregate_pages.items():
            page_widgets = {symbol["name"] for symbol in self.symbols.values() if symbol["pageId"] == page_id}
            changed_formulas, cases = set(), []
            for formula in getattr(self, "compiled_formulas", []):
                if formula["widgets"] & page_widgets or formula["variables"] & changed_formulas:
                    cases.append({"description": "RP/1 initialize input formula", "isNewIfGroup": True,
                        "actions": [{"type": "set-variable", "variable": formula["name"], "runtime": formula["ast"]}]})
                    changed_formulas.add(formula["name"])
            for aggregate in page_aggregates:
                cases.append({"description": "RP/1 initialize aggregate", "isNewIfGroup": True,
                    "actions": [{"type": "set-variable", "variable": aggregate["name"], "value": 0}]})
                context = self.repeaters[aggregate["repeaterId"]]
                rows = context["rows"]
                if aggregate["scope"] == "visible" and context["pageSize"]: rows = rows[:context["pageSize"]]
                for row in rows:
                    case = {"description": "RP/1 initial aggregate row", "isNewIfGroup": True,
                        "actions": [{"type": "set-variable", "variable": aggregate["name"], "runtime": {
                            "kind": "binary", "op": "+", "valueType": "number",
                            "left": {"kind": "variable", "name": aggregate["name"], "valueType": "number"},
                            "right": source_row_ast(aggregate["valAst"], row)}}]}
                    if aggregate["whereAst"] is not None:
                        case["condition"] = "if"
                        case["when"] = {"left": {"runtime": source_row_ast(aggregate["whereAst"], row)}, "op": "==", "right": True}
                    cases.append(case)
            by_id[page_id]["interactions"].insert(0, {
                "trigger": "page", "sourceId": page_id, "sourcePointer": "/computed",
                "aggregateInitialization": True,
                "events": [{"event": "OnLoad", "cases": cases}],
            })
        for h_scope, h_logical, h_ptr in self.initial_hidden_nodes:
            if h_logical not in self.symbols:
                continue
            h_name = self.symbols[h_logical]["name"]
            rep_id, rep_ctx = self.row_context(h_scope)
            if rep_ctx is not None:
                by_id[rep_ctx["pageId"]]["interactions"].insert(0, {
                    "trigger": rep_ctx["name"], "sourceId": rep_id, "sourcePointer": h_ptr,
                    "events": [{"event": "OnItemLoad", "cases": [{
                        "description": "RP/1 initial hidden",
                        "isNewIfGroup": True,
                        "actions": [{"type": "hide", "target": h_name}],
                    }]}],
                })
            else:
                page_id = h_scope.split("/")[0]
                by_id[page_id]["interactions"].insert(0, {
                    "trigger": "page", "sourceId": page_id, "sourcePointer": h_ptr,
                    "events": [{"event": "OnLoad", "cases": [{
                        "description": "RP/1 initial hidden",
                        "isNewIfGroup": True,
                        "actions": [{"type": "hide", "target": h_name}],
                    }]}],
                })
        for rep_id, scope, cond_expr, then_ids, else_ids, cond_ptr in self.row_conditionals:
            rep_ctx = self.repeaters[rep_id]
            cond_ast = self.condition(cond_expr, scope, cond_ptr)
            then_acts = [{"type": "show", "target": self.symbols[tid]["name"]} for tid in then_ids] + [
                {"type": "hide", "target": self.symbols[eid]["name"]} for eid in else_ids
            ]
            else_acts = [{"type": "hide", "target": self.symbols[tid]["name"]} for tid in then_ids] + [
                {"type": "show", "target": self.symbols[eid]["name"]} for eid in else_ids
            ]
            cases = [{"description": "RP/1 row when-then", "isNewIfGroup": True, "condition": "if", "when": cond_ast, "actions": then_acts}]
            if else_acts:
                cases.append({"description": "RP/1 row when-else", "isNewIfGroup": False, "condition": "else", "actions": else_acts})
            by_id[rep_ctx["pageId"]]["interactions"].append({
                "trigger": rep_ctx["name"], "sourceId": rep_id, "sourcePointer": cond_ptr,
                "events": [{"event": "OnItemLoad", "cases": cases}],
            })
        self.compiled_page_conditionals = []
        for page_id, scope, cond_expr, then_ids, else_ids, cond_ptr in self.page_conditionals:
            cond_ast = self.condition(cond_expr, scope, cond_ptr)
            deps_v, deps_w = set(), set()
            def collect_cond_deps(n):
                if not isinstance(n, dict):
                    return
                if n.get("kind") == "variable":
                    deps_v.add(n["name"])
                if n.get("kind") == "widget":
                    deps_w.add(n["name"])
                for ch in n.values():
                    if isinstance(ch, dict):
                        collect_cond_deps(ch)
                    elif isinstance(ch, list):
                        for item in ch:
                            if isinstance(item, dict):
                                collect_cond_deps(item)
            collect_cond_deps(cond_ast)
            then_acts = [{"type": "show", "target": self.symbols[tid]["name"]} for tid in then_ids] + [
                {"type": "hide", "target": self.symbols[eid]["name"]} for eid in else_ids
            ]
            else_acts = [{"type": "hide", "target": self.symbols[tid]["name"]} for tid in then_ids] + [
                {"type": "show", "target": self.symbols[eid]["name"]} for eid in else_ids
            ]
            cases = [{"description": "RP/1 page when-then", "isNewIfGroup": True, "condition": "if", "when": cond_ast, "actions": then_acts}]
            if else_acts:
                cases.append({"description": "RP/1 page when-else", "isNewIfGroup": False, "condition": "else", "actions": else_acts})
            self.compiled_page_conditionals.append({
                "pageId": page_id,
                "variables": deps_v,
                "widgets": deps_w,
                "cases": cases,
            })
            by_id[page_id]["interactions"].append({
                "trigger": "page", "sourceId": page_id, "sourcePointer": cond_ptr,
                "events": [{"event": "OnLoad", "cases": copy.deepcopy(cases)}],
            })

        for binding in self.progress_bindings:
            symbol = self.resolve(binding["fill"], binding["scope"], binding["pointer"])
            percent = self.runtime(binding["percent"], binding["scope"], binding["pointer"], expected="number")
            variables, widgets = set(), set()

            def collect_progress_dependencies(node):
                if node.get("kind") == "variable": variables.add(node["name"])
                if node.get("kind") == "widget": widgets.add(node["name"])
                for value in node.values():
                    if isinstance(value, dict): collect_progress_dependencies(value)
                    elif isinstance(value, list):
                        for child in value:
                            if isinstance(child, dict): collect_progress_dependencies(child)

            collect_progress_dependencies(percent)
            cases = []
            for idx, threshold in enumerate(range(100, 0, -10)):
                comparison = {"kind": "binary", "op": ">=", "left": percent,
                              "right": {"kind": "literal", "value": threshold, "valueType": "number"},
                              "valueType": "boolean"}
                cases.append({
                    "description": f"progress-bar {binding['fill']} >= {threshold}%",
                    "isNewIfGroup": idx == 0, "condition": "if" if idx == 0 else "else-if",
                    "when": {"left": {"runtime": comparison}, "op": "==",
                             "right": {"runtime": {"kind": "literal", "value": True, "valueType": "boolean"}}},
                    "actions": [{"type": "set-panel-state", "target": symbol["name"], "state": f"s{threshold}"}],
                })
            cases.append({"description": f"progress-bar {binding['fill']} < 10%",
                          "isNewIfGroup": False, "condition": "else",
                          "actions": [{"type": "set-panel-state", "target": symbol["name"], "state": "s0"}]})
            self.compiled_page_conditionals.append({"pageId": symbol["pageId"], "variables": variables,
                                                    "widgets": widgets, "cases": cases})
            by_id[symbol["pageId"]]["interactions"].append({
                "trigger": "page", "sourceId": symbol["id"], "sourcePointer": binding["pointer"],
                "events": [{"event": "OnLoad", "cases": copy.deepcopy(cases)}],
            })

        def _annotate_when_tree(node):
            if not isinstance(node, dict):
                return
            meta = node.pop("_when_meta", None)
            if meta is not None:
                w_scope, w_expr, w_ptr, is_else = meta
                w_ast = self.runtime(w_expr, w_scope, w_ptr, expected="boolean")
                eff_ast = {"kind": "call", "fn": "not", "args": [w_ast], "valueType": "boolean"} if is_else else w_ast
                node["_when_ast"] = eff_ast
                node["_when_default_visible"] = bool(self._eval_static_ast(eff_ast))
                _, r_ctx = self.row_context(w_scope)
                if r_ctx is not None and r_ctx.get("rows"):
                    node["_row_visibles"] = [bool(self._eval_static_ast(eff_ast, row_override=r_data)) for r_data in r_ctx["rows"]]
            children = node.get("children")
            if isinstance(children, list):
                for ch in children:
                    _annotate_when_tree(ch)
                run = []
                def _flush_run(r_list):
                    if len(r_list) >= 2:
                        self.when_group_counter += 1
                        wg_id = f"wg_sib_{self.when_group_counter}"
                        for b_idx, c_item in enumerate(r_list):
                            c_item["_when_group"] = wg_id
                            c_item["_when_branch"] = b_idx
                for ch in children:
                    if isinstance(ch, dict) and "_when_ast" in ch and "_when_group" not in ch:
                        if not run or all(are_when_asts_mutually_exclusive(ch["_when_ast"], prev["_when_ast"]) for prev in run):
                            run.append(ch)
                        else:
                            _flush_run(run)
                            run = [ch]
                    else:
                        _flush_run(run)
                        run = []
                _flush_run(run)
                for ch in children:
                    if isinstance(ch, dict):
                        ch.pop("_when_ast", None)
            for st in (node.get("states") or []):
                if isinstance(st, dict) and isinstance(st.get("root"), dict):
                    _annotate_when_tree(st["root"])
                    st["root"].pop("_when_ast", None)
            if isinstance(node.get("template"), dict):
                _annotate_when_tree(node["template"])
                node["template"].pop("_when_ast", None)

        for p_obj in by_id.values():
            _annotate_when_tree(p_obj["root"])
            p_obj["root"].pop("_when_ast", None)

        for agg in getattr(self, "compiled_aggregates", []):
            if agg.get("scope") == "dataset":
                continue
            guard_check = {
                "kind": "binary", "op": "==",
                "left": {"kind": "variable", "name": agg["guardVar"], "valueType": "number"},
                "right": {"kind": "literal", "value": 1, "valueType": "number"},
                "valueType": "boolean",
            }
            if agg["whereAst"] is not None:
                guard_check = {
                    "kind": "binary", "op": "&&",
                    "left": guard_check, "right": agg["whereAst"], "valueType": "boolean",
                }
            accum_ast = {
                "kind": "binary", "op": "+",
                "left": {"kind": "variable", "name": agg["name"], "valueType": "number"},
                "right": agg["valAst"], "valueType": "number",
            }
            by_id[agg["pageId"]]["interactions"].append({
                "trigger": agg["repeaterName"], "sourceId": agg["repeaterId"], "sourcePointer": agg["pointer"],
                "events": [{"event": "OnItemLoad", "cases": [{
                    "description": f"RP/1 aggregate {agg['name']}",
                    "isNewIfGroup": True, "condition": "if",
                    "when": {"left": {"runtime": guard_check}, "op": "==", "right": {"runtime": {"kind": "literal", "value": True, "valueType": "boolean"}}},
                    "actions": [{"type": "set-variable", "variable": agg["name"], "runtime": accum_ast}],
                }]}],
            })

    def add_binding_refresh(self, pages, bindings):
        page_bindings = [b for b in bindings if not b["row"]]
        symbols_by_name = {s["name"]: s for s in self.symbols.values()}
        formulas = getattr(self, "compiled_formulas", [])
        aggregates = getattr(self, "compiled_aggregates", [])
        page_conditionals = getattr(self, "compiled_page_conditionals", [])
        for page in pages:
            f_inputs = set().union(*(f["widgets"] for f in formulas)) if formulas else set()
            a_inputs = set().union(*(set(a["widgets"]) for a in aggregates)) if aggregates else set()
            b_inputs = set().union(*(b["widgets"] for b in page_bindings if b["symbol"]["pageId"] == page["slug"])) if page_bindings else set()
            c_inputs = set().union(*(pc["widgets"] for pc in page_conditionals if pc["pageId"] == page["slug"])) if page_conditionals else set()
            for name in sorted(b_inputs | f_inputs | a_inputs | c_inputs):
                if name in symbols_by_name and symbols_by_name[name]["pageId"] == page["slug"] and symbols_by_name[name]["kind"] in FORM_KINDS:
                    page["interactions"].append({"trigger":name,"sourceId":symbols_by_name[name]["id"],
                        "sourcePointer":symbols_by_name[name]["pointer"],"events":[{"event":"OnTextChange","cases":[{
                        "description":"RP/1 input binding","isNewIfGroup":True,"when":{"left":True,"op":"==","right":True},
                        "actions":[{"type":"binding-refresh","changedWidget":name}]}]}]})
            for interaction in page["interactions"]:
                for event in interaction["events"]:
                    event_changed_variables, event_changed_widgets = set(), set()
                    for case in event["cases"]:
                        actions = []
                        for action in case["actions"]:
                            changed_variables, changed_widgets, guards_to_close = set(), set(), set()
                            if action["type"] == "link":
                                for view in self.compiled_selection_views:
                                    if action.get("page") != self.pages[view["pageId"]]["name"] or view["pageId"] == page["slug"]:
                                        continue
                                    source_rep = next((r for r in self.repeaters.values()
                                        if r["pageId"] == page["slug"] and r.get("datasetName") == view["datasetName"]
                                        and not r.get("hiddenLookup")), None)
                                    if source_rep is not None:
                                        def retarget(value):
                                            if isinstance(value, dict):
                                                return {k: (source_rep["name"] if k in {"target", "repeater"} and v == view["repeaterName"] else retarget(v)) for k, v in value.items()}
                                            if isinstance(value, list):
                                                return [retarget(v) for v in value]
                                            return value
                                        actions.extend(retarget(view["captureActions"]))
                            if action["type"] in {"data-add", "data-delete", "data-update", "data-filter", "data-clear-filter", "data-sort", "data-clear-sort", "data-page"}:
                                is_view_op = action["type"] not in {"data-add", "data-delete", "data-update"}
                                target_aggs = [
                                    a for a in aggregates
                                    if a["repeaterName"] == action.get("target")
                                    and a.get("scope", "visible") == "visible"
                                    and not interaction.get("aggregateInitialization")
                                ]
                                for a in target_aggs:
                                    actions.append({"type": "set-variable", "variable": a["guardVar"], "value": 1})
                                    guards_to_close.add(a["guardVar"])
                                    actions.append({"type": "set-variable", "variable": a["name"], "value": 0})
                                actions.append(action)
                                if action["type"] in {"data-filter", "data-clear-filter"}:
                                    actions.append({"type": "data-page", "target": action["target"], "pageType": "value", "page": "1"})
                                dataset_aggs = [a for a in aggregates if a["repeaterName"] == action.get("target") and a.get("scope") == "dataset"] if not is_view_op else []
                                if dataset_aggs:
                                    for a in dataset_aggs:
                                        actions.append({"type": "set-variable", "variable": a["name"], "value": 0})
                                        changed_variables.add(a["name"])
                                    actions.append({"type": "data-delete", "target": action["target"], "selectionType": 2,
                                        "predicate": {"kind": "aggregate-scan", "valueType": "boolean", "aggregates": dataset_aggs}})
                                for a in target_aggs:
                                    changed_variables.add(a["name"])
                            elif action["type"] == "binding-refresh":
                                changed_widgets.add(action["changedWidget"])
                            else:
                                actions.append(action)
                            if action["type"] == "set-variable":
                                changed_variables.add(action["variable"])

                            if action["type"] == "set-text":
                                changed_widgets.add(action["target"])
                            for computed in getattr(self, "computed_order", []):
                                if not (changed_variables & set(computed["variables"]) or changed_widgets & set(computed["widgets"])):
                                    continue
                                if "ast" in computed:
                                    if action["type"] != "set-variable" or action.get("variable") != computed["name"]:
                                        actions.append({"type": "set-variable", "variable": computed["name"], "runtime": computed["ast"]})
                                        changed_variables.add(computed["name"])
                                    continue
                                if interaction.get("aggregateInitialization"):
                                    continue
                                a = computed
                                if a["pageId"] != page["slug"]:
                                    continue
                                if a["scope"] == "visible":
                                    actions.append({"type": "set-variable", "variable": a["guardVar"], "value": 1})
                                    guards_to_close.add(a["guardVar"])
                                actions.append({"type": "set-variable", "variable": a["name"], "value": 0})
                                predicate = {"kind": "aggregate-scan", "valueType": "boolean", "aggregates": [a]} if a["scope"] == "dataset" else {"kind": "literal", "valueType": "boolean", "value": False}
                                actions.append({"type": "data-delete", "target": a["repeaterName"], "selectionType": 2, "predicate": predicate})
                                changed_variables.add(a["name"])
                            for guard in sorted(guards_to_close):
                                actions.append({"type": "set-variable", "variable": guard, "value": 0})
                            for b in page_bindings:
                                if b["symbol"]["pageId"] != page["slug"]: continue
                                if changed_variables & b["variables"] or changed_widgets & b["widgets"]:
                                    actions.append({"type":"set-text","target":b["symbol"]["name"],"runtime":b["ast"]})
                                    changed_widgets.add(b["symbol"]["name"])
                            if not (interaction["trigger"] == "page" and event["event"] == "OnLoad"):
                                for sv in getattr(self, "compiled_selection_views", []):
                                    if sv["pageId"] != page["slug"]:
                                        continue
                                    if sv["variable"] in changed_variables or (
                                        action["type"] in {"data-add", "data-update", "data-delete"} and action.get("target") == sv["repeaterName"]
                                    ):
                                        actions.extend(copy.deepcopy(sv["scanActions"]))
                                        for s_act in sv["scanActions"]:
                                            if s_act["type"] == "set-text":
                                                changed_widgets.add(s_act["target"])
                            event_changed_variables.update(changed_variables)
                            event_changed_widgets.update(changed_widgets)
                        # PageLoaded executes before Axure's first repeater
                        # refresh. A native zero-duration wait yields to that
                        # initialization before touching visible aggregates.
                        visible_repeaters = {a["repeaterName"] for a in aggregates if a["scope"] == "visible"}
                        if interaction["trigger"] == "page" and event["event"] == "OnLoad" and any(
                            a["type"].startswith("data-") and a.get("target") in visible_repeaters for a in actions
                        ):
                            actions.insert(0, {"type": "wait", "ms": 0})
                        case["actions"] = actions
                    if not (interaction["trigger"] == "page" and event["event"] == "OnLoad"):
                        extra_cases = []
                        for pc in page_conditionals:
                            if pc["pageId"] != page["slug"]:
                                continue
                            if (event_changed_variables & pc["variables"]) or (event_changed_widgets & pc["widgets"]):
                                extra_cases.extend(copy.deepcopy(pc["cases"]))
                        if extra_cases:
                            event["cases"] = [c for c in event["cases"] if c["actions"]] + extra_cases

    def row_context(self, scope):
        matches = [(key, data) for key, data in self.repeaters.items() if scope == key + "/item" or scope.startswith(key + "/item/")]
        return max(matches, key=lambda x: len(x[0])) if matches else (None, None)

    def runtime(self, value, scope, path, expected=None, row=None):
        if isinstance(value, str):
            if "${" in value:
                parsed = self.expression(parse_template_string(value, path), {}, path)
                return self.runtime(parsed, scope, path, expected=expected, row=row)
            if (value.startswith("=") and not value.startswith("==")) or (
                value.startswith("[[") and value.endswith("]]")
            ) or (
                expected in ("boolean", "number") and INLINE_EXPR_HINT_RE.search(value)
            ):
                parsed = self.expression(parse_inline_expr(value, path), {}, path)
                return self.runtime(parsed, scope, path, expected=expected, row=row)
        if type(value) in (str, int, float, bool):
            typ = "boolean" if type(value) is bool else "number" if type(value) in (int, float) else "text"
            self.typecheck(value, typ, path)
            out = {"kind": "literal", "value": value, "valueType": typ}
        elif isinstance(value, dict):
            if "expr" in value and set(value.keys()) == {"expr"}:
                parsed = self.expression(parse_inline_expr(value["expr"], ptr(path, "expr")), {}, path)
                return self.runtime(parsed, scope, path, expected=expected, row=row)
            if "_coerce_text" in value:
                inner = self.runtime(value["_coerce_text"], scope, path, expected=None, row=row)
                if inner["valueType"] == "text":
                    out = inner
                elif inner["kind"] == "literal":
                    out = {"kind": "literal", "value": self._format_scalar(inner["value"]), "valueType": "text"}
                else:
                    out = {"kind": "call", "fn": "text", "args": [inner], "valueType": "text"}
                typ = "text"
            elif "_auto_ident" in value:
                name = value["_auto_ident"]
                rid, context = row or self.row_context(scope)
                if context is not None and name in context["model"]:
                    return self.runtime({"item": name}, scope, path, expected=expected, row=row)
                if name in self.variables:
                    return self.runtime({"variable": name}, scope, path, expected=expected, row=row)
                hint = difflib.get_close_matches(name, sorted(set(self.variables) | (set(context["model"]) if context else set())), n=3)
                fail("E_VARIABLE", path, f"Unknown variable or row field '{name}'", suggestions=hint)
            elif "_sigil_var" in value:
                return self.runtime({"variable": value["_sigil_var"]}, scope, path, expected=expected, row=row)
            elif "variable" in value or "var" in value:
                vkey = "variable" if "variable" in value else "var"
                fields(value, {vkey}, path)
                name = value[vkey]
                self.typecheck(name, "text", ptr(path, vkey))
                if name not in self.variables:
                    hint = difflib.get_close_matches(name, sorted(self.variables), n=3)
                    fail("E_VARIABLE", path, f"Unknown variable '{name}'", suggestions=hint)
                typ = self.variables[name]["type"]
                out = {"kind": "variable", "name": name, "valueType": typ}
            elif "widget" in value:
                fields(value, {"widget"}, path)
                raw_wref = value["widget"]
                if isinstance(raw_wref, dict) and isinstance(raw_wref.get("ref"), str) and "." in raw_wref["ref"]:
                    base_ref, suffix_prop = raw_wref["ref"].rsplit(".", 1)
                    if suffix_prop in ("text", "checked", "selected", "value") and base_ref:
                        raw_wref = {**raw_wref, "ref": base_ref}
                elif isinstance(raw_wref, str) and "." in raw_wref:
                    base_ref, suffix_prop = raw_wref.rsplit(".", 1)
                    if suffix_prop in ("text", "checked", "selected", "value") and base_ref:
                        raw_wref = base_ref
                symbol = self.resolve(raw_wref, scope, ptr(path, "widget"))
                if symbol["pageId"] != scope.split("/")[0] or symbol["kind"] not in FORM_KINDS | {"label", "paragraph", "button", "badge"}:
                    fail("E_TARGET_TYPE", path, "Runtime text read needs a text-capable widget in this page")
                source_row = self.row_context(symbol["id"])[0]
                if source_row and source_row != self.row_context(scope)[0]:
                    fail("E_ROW_SCOPE", path, "Row widget text belongs to its row instance")
                typ = "boolean" if symbol["kind"] in CHECK_KINDS else "text"
                out = {"kind": "widget", "name": symbol["name"], "valueType": typ}
                if symbol["kind"] in CHECK_KINDS: out["accessor"] = "checked"
                elif symbol["kind"] in OPTION_KINDS: out["accessor"] = "value"
            elif "item" in value:
                fields(value, {"item"}, path)
                rid, context = row or self.row_context(scope)
                if context is None:
                    fail("E_ROW_SCOPE", path, "item is only available in a Repeater template or row predicate")
                name = value["item"]
                self.typecheck(name, "text", ptr(path, "item"))
                if name not in context["model"]:
                    hint = difflib.get_close_matches(name, sorted(context["model"]), n=3)
                    fail("E_DATA_FIELD", path, f"Unknown row field '{name}'", suggestions=hint)
                typ = context["model"][name]
                out = {"kind": "item", "repeater": context["name"], "field": name, "valueType": typ}
                if context.get("modelName"):
                    out["modelName"] = context["modelName"]
            elif "caller" in value:
                fields(value, {"caller"}, path)
                caller_rid, caller_ctx = self.row_context(scope)
                if caller_ctx is None:
                    fail("E_ROW_SCOPE", path, "caller.<field> is only available inside a Repeater row template event")
                name = value["caller"]
                self.typecheck(name, "text", ptr(path, "caller"))
                if name not in caller_ctx["model"]:
                    hint = difflib.get_close_matches(name, sorted(caller_ctx["model"]), n=3)
                    fail("E_DATA_FIELD", path, f"Unknown caller row field '{name}'", suggestions=hint)
                typ = caller_ctx["model"][name]
                out = {"kind": "caller_item", "repeater": caller_ctx["name"], "field": name, "valueType": typ}
                if caller_ctx.get("modelName"):
                    out["modelName"] = caller_ctx["modelName"]
            elif "op" in value:
                inline_plus = bool(value.get("_inline_plus"))
                fields(value, {"op", "left", "right", "_inline_plus"}, path)
                op = value["op"]
                self.typecheck(op, "text", ptr(path, "op"))
                if op not in {"+", "-", "*", "/", "==", "!=", ">", "<", ">=", "<=", "&&", "||"}:
                    fail("E_OPERATOR", ptr(path, "op"), "Unsupported runtime operator")
                left = self.runtime(value.get("left"), scope, ptr(path, "left"), row=row)
                right = self.runtime(value.get("right"), scope, ptr(path, "right"), row=row)
                lt, rt = left["valueType"], right["valueType"]
                if inline_plus and op == "+" and ("text" in (lt, rt)):
                    l_txt = left if lt == "text" else {"kind": "call", "fn": "text", "args": [left], "valueType": "text"}
                    r_txt = right if rt == "text" else {"kind": "call", "fn": "text", "args": [right], "valueType": "text"}
                    typ = "text"
                    out = {"kind": "call", "fn": "concat", "args": [l_txt, r_txt], "valueType": "text"}
                else:
                    if lt != rt:
                        fail("E_TYPE", path, "Operator operands must have the same type; use an explicit conversion")
                    if op in {"+", "-", "*", "/", ">", "<", ">=", "<="} and lt != "number":
                        fail("E_TYPE", path, f"{op} requires numbers")
                    if op in {"&&", "||"} and lt != "boolean":
                        fail("E_TYPE", path, f"{op} requires booleans")
                    if op == "/" and right == {"kind": "literal", "value": 0, "valueType": "number"}:
                        fail("E_DIVISION_ZERO", path, "Constant division by zero")
                    if op in {"==", "!="}:
                        for item_side, lit_side, lit_ptr in ((left, right, ptr(path, "right")), (right, left, ptr(path, "left"))):
                            if item_side.get("kind") in ("item", "caller_item") and lit_side.get("kind") == "literal" and isinstance(lit_side.get("value"), str):
                                mname = item_side.get("modelName")
                                fname = item_side.get("field")
                                dom_meta = self.domain_models.get(mname, {}).get(fname) if mname else None
                                if dom_meta and dom_meta.get("domain") == "enum":
                                    allowed_vals = dom_meta["values"]
                                    if lit_side["value"] not in allowed_vals:
                                        hint = difflib.get_close_matches(lit_side["value"], allowed_vals, n=3)
                                        fail("E_ENUM_VARIANT", lit_ptr, f"Unknown enum variant '{lit_side['value']}' for '{fname}'; expected one of {allowed_vals}", suggestions=hint)
                    typ = "number" if op in {"+", "-", "*", "/"} else "boolean"
                    out = {"kind": "binary", "op": op, "left": left, "right": right, "valueType": typ}
            elif "fn" in value:
                fields(value, {"fn", "args"}, path)
                fn, args = value["fn"], value.get("args")
                self.typecheck(fn, "text", ptr(path, "fn"))
                signatures = {"text": (None, "text"), "number": (None, "number"), "not": ("boolean", "boolean"),
                              "lower": ("text", "text"), "upper": ("text", "text"), "length": ("text", "number"),
                              "contains": ("text", "boolean"), "remove": ("text", "text")}
                arity = {"contains": 2, "remove": 2}.get(fn, 1)
                if not isinstance(args, list) or (fn == "concat" and len(args) < 2) or (fn != "concat" and len(args) != arity):
                    fail("E_ARGUMENT", path, f"concat needs at least two values; {fn} needs {arity}")
                if fn != "concat" and fn not in signatures:
                    fail("E_FUNCTION", path, f"Unknown runtime function '{fn}'")
                arg_type, typ = (None, "text") if fn == "concat" else signatures[fn]
                compiled = [self.runtime(v, scope, ptr(ptr(path, "args"), i), expected=arg_type, row=row) for i, v in enumerate(args)]
                if fn == "concat":
                    coerced = []
                    for c in compiled:
                        if c.get("valueType") == "text":
                            coerced.append(c)
                        elif c.get("kind") == "literal" and type(c.get("value")) in (int, float, bool):
                            coerced.append({"kind": "literal", "value": self._format_scalar(c["value"]), "valueType": "text"})
                        else:
                            coerced.append({"kind": "call", "fn": "text", "args": [c], "valueType": "text"})
                    compiled = coerced
                if fn == "number" and compiled[0]["valueType"] not in {"text", "number"}:
                    fail("E_TYPE", ptr(path, "args"), "number requires text or number")
                out = {"kind": "call", "fn": fn, "args": compiled, "valueType": typ}
            else:
                fail("E_EXPRESSION", path, "Expected variable, widget, item, op or fn")
        else:
            fail("E_EXPRESSION", path, "Expected a scalar or typed runtime expression")
        if expected is not None and typ != expected:
            fail("E_TYPE", path, f"Expected {expected}, got {typ}; use an explicit conversion")
        return out

    def repeater_node(self, source, scope, env, path, stack, panel_depth):
        logical = scope + "/" + source["id"]
        if self.row_context(scope)[1] is not None:
            fail("E_ROW_CONTAINER", path, "Nested Repeaters are not supported in row templates")
        self.typecheck(source.get("dataset"), "text", ptr(path, "dataset"))
        dataset = self.datasets.get(source.get("dataset"))
        if dataset is None:
            fail("E_DATASET", ptr(path, "dataset"), "Unknown Repeater dataset")
        model = self.models[dataset["model"]]
        key = source.get("key", "id")
        self.typecheck(key, "text", ptr(path, "key"))
        if model.get(key) != "text":
            fail("E_DATA_KEY", ptr(path, "key"), "Repeater identity must be a text column")
        keys = [r[key] for r in dataset["rows"]]
        if any(not k for k in keys) or len(keys) != len(set(keys)):
            fail("E_DATA_KEY", path, "Initial Repeater keys must be nonempty and unique")
        for column in model:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", column):
                fail("E_DATA_COLUMN_NAME", path, "Native Repeater fields use letters, digits and underscores")
        for prop in ("rowGap", "pageSize", "rowHeight"):
            val = source.get(prop, 0 if prop != "rowHeight" else 48)
            if type(val) is not int or val < (1 if prop in {"rowHeight", "pageSize"} and prop in source else 0):
                fail("E_SIZE", ptr(path, prop), f"{prop} must be a nonnegative integer; explicit pageSize/rowHeight must be positive")
        for k in GEOMETRY:
            if k in {"adaptive", "_hidden_lookup", "_master_instance"}:
                continue
            if k in source and not (k in {"w", "h"} and source[k] in ("fill", "hug", "auto")):
                self.typecheck(source[k], "number", ptr(path, k))
                if k not in {"x", "y"} and source[k] < 0: fail("E_SIZE", ptr(path, k), "Size must be nonnegative")
        name = self.register(logical, "repeater", source, path)
        context = {"name": name, "model": model, "modelName": dataset["model"], "datasetName": source.get("dataset"),
                   "rows": dataset["rows"], "key": key, "ownerScope": scope, "pageId": scope.split("/")[0],
                   "pageSize": source.get("pageSize", 0), "hiddenLookup": bool(source.get("_hidden_lookup"))}
        self.repeaters[logical] = context
        # 编译期行过滤：repeater 自带 where 时，模板与行集合都用过滤后的结果。
        # 与 Studio 的 repeaterSetFilter 是同一语义，只是发生在源码编译阶段。
        if source.get("where") is not None:
            wptr = ptr(path, "where")
            try:
                where_ast = self.runtime(
                    self.expression(source["where"], {"_repeater_shadows_item": True}, wptr),
                    logical + "/item", wptr, expected="boolean", row=(logical, context)
                )
                filtered = [row for row in dataset["rows"] if bool(self._eval_static_ast(where_ast, row))]
            except Exception as err:
                fail("E_WHERE", wptr, f"repeater where 求值失败：{err}")
            context["rows"] = filtered
            context["filteredBy"] = source["where"]
        rows_for_render = context["rows"]
        template = self.node(source.get("template"), logical + "/item", {**env, "_repeater_shadows_item": True}, ptr(path, "template"), stack, panel_depth)
        result = {"type": "repeater", "name": name, "template": template, "rows": rows_for_render, "model": model,
                  "rowGap": source.get("rowGap", 0), "rowHeight": source.get("rowHeight", 48), "pageSize": source.get("pageSize", 0),
                  **({"where": source["where"]} if source.get("where") is not None else {}),
                  **{k: source[k] for k in (GEOMETRY | {"adaptive", "_hidden_lookup", "_master_instance", "_master_slot"}) if k in source}}
        if "on" in source:
            fields(source["on"], source["on"], ptr(path, "on"))
            for event in source["on"]:
                if event in {"change", "OnTextChange", "statechange", "OnPanelStateChange"}:
                    fail("E_EVENT", ptr(ptr(path, "on"), event), "Repeater does not own input or panel-state events")
            self.pending.append((logical, scope, self.expression(source["on"], env, ptr(path, "on")), ptr(path, "on")))
        return result

    def data_action(self, action, scope, path):
        kind = action["type"]
        symbol = self.resolve(action.get("target"), scope, ptr(path, "target"))
        if symbol["kind"] != "repeater" or symbol["pageId"] != scope.split("/")[0]:
            fail("E_TARGET_TYPE", path, "Data action requires a Repeater in this page")
        context = self.repeaters[symbol["id"]]
        # DataSet scope must remain in the owning native record. Cross-record actions from
        # inside a child DynamicPanel state lower via an OnPanelStateChange bridge on the
        # enclosing DynamicPanel that shares the Repeater's native record.
        owner = context["ownerScope"]
        def state_scope(value):
            states = [s["id"] + "/" + st for s in self.symbols.values() if s["kind"] == "dynamic-panel" for st in s.get("states", [])]
            return max((s for s in states if value == s or value.startswith(s + "/")), key=len, default="")
        caller_state = state_scope(scope)
        owner_state = state_scope(owner)
        bridge_panel = None
        if caller_state != owner_state:
            bridge_panel = next(
                (s for s in self.symbols.values()
                 if s["kind"] == "dynamic-panel"
                 and state_scope(s["id"]) == owner_state
                 and any(caller_state == s["id"] + "/" + st or caller_state.startswith(s["id"] + "/" + st + "/") for st in s.get("states", []))),
                None,
            )
            if bridge_panel is None:
                fail("E_DATA_SCOPE", path, "Repeater data actions must share its panel-state record or target an enclosing record")
        out = {"type": kind, "target": symbol["name"]}
        if kind == "data-add":
            rows = action.get("rows")
            if not isinstance(rows, list) or not rows:
                fail("E_DATA_ROWS", ptr(path, "rows"), "data-add requires nonempty complete rows")
            out["columns"] = list(context["model"])
            out["rows"] = []
            for i, record in enumerate(rows):
                rp = ptr(ptr(path, "rows"), i)
                if isinstance(record, dict):
                    unknown = next((key for key in record if key not in context["model"]), None)
                    if unknown is not None:
                        fail("E_DATA_FIELD", ptr(rp, unknown), f"Unknown data-add field '{unknown}'")
                fields(record, context["model"], rp)
                for key in context["model"]:
                    if key not in record:
                        fail("E_FIELD_MISSING", ptr(rp, key), "data-add requires a complete model row")
                compiled_cells = []
                for k, typ in context["model"].items():
                    rt_cell = self.runtime(record.get(k), scope, ptr(rp, k), expected=typ)
                    compiled_cells.append({"runtime": rt_cell})
                out["rows"].append(compiled_cells)
        elif kind in {"data-delete", "data-update", "data-filter"}:
            out["predicate"] = self.runtime(action.get("where"), scope, ptr(path, "where"), expected="boolean", row=(symbol["id"], context))
            if kind == "data-update":
                updates = action.get("set")
                fields(updates, context["model"], ptr(path, "set"))
                if not updates:
                    fail("E_DATA_UPDATE", path, "Update needs at least one column")
                if context["key"] in updates:
                    fail("E_DATA_KEY", ptr(path, "set"), "Row identity is immutable")
                out["updates"] = [{"column": k, "runtime": self.runtime(v, scope, ptr(ptr(path, "set"), k), expected=context["model"][k], row=(symbol["id"], context))} for k, v in updates.items()]
            if kind == "data-filter":
                ident(action.get("name"), ptr(path, "name"))
                out["label"] = action["name"]
        elif kind == "data-sort":
            column = action.get("column")
            self.typecheck(column, "text", ptr(path, "column"))
            if column not in context["model"]:
                fail("E_DATA_FIELD", ptr(path, "column"), "Unknown sort column")
            direction = action.get("direction", "ascending")
            if not isinstance(direction, str) or direction not in {"ascending", "descending"}:
                fail("E_ENUM", path, "Sort direction must be ascending or descending")
            out.update(column=column, ascending=direction == "ascending", sortType=1 if context["model"][column] == "number" else 0)
        elif kind == "data-page":
            page = action.get("page")
            if not (isinstance(page, str) and page in {"next", "previous", "first", "last"}) and (type(page) is not int or page < 1):
                fail("E_PAGE", ptr(path, "page"), "Expected next/previous/first/last or a positive integer")
            out.update(pageType="value" if type(page) is int or page == "first" else page, page=str(page if type(page) is int else 1))
        caller_item_pre = []
        caller_rep_id, caller_rep_ctx = self.row_context(scope)

        def hoist_caller_items(node):
            if not isinstance(node, dict):
                return node
            if node.get("kind") == "caller_item" or (
                node.get("kind") == "item" and caller_rep_ctx is not None and node.get("repeater") == caller_rep_ctx["name"] and caller_rep_ctx["name"] != context["name"]
            ):
                self.bridge_var_counter += 1
                cvar = f"rp1_caller_{self.bridge_var_counter}"
                vtype = node.get("valueType", "text")
                default_val = False if vtype == "boolean" else (0 if vtype == "number" else "")
                self.variables[cvar] = {"type": vtype, "value": default_val}
                caller_item_pre.append({
                    "type": "set-variable",
                    "variable": cvar,
                    "runtime": {"kind": "item", "repeater": node["repeater"], "field": node["field"], "valueType": vtype},
                })
                return {"kind": "variable", "name": cvar, "valueType": vtype}
            out_node = dict(node)
            if "left" in out_node:
                out_node["left"] = hoist_caller_items(out_node["left"])
            if "right" in out_node:
                out_node["right"] = hoist_caller_items(out_node["right"])
            if "args" in out_node and isinstance(out_node["args"], list):
                out_node["args"] = [hoist_caller_items(a) for a in out_node["args"]]
            return out_node

        if "rows" in out:
            out["rows"] = [[{"runtime": hoist_caller_items(cell["runtime"])} for cell in row_cells] for row_cells in out["rows"]]
        if "predicate" in out:
            out["predicate"] = hoist_caller_items(out["predicate"])
        if "updates" in out:
            out["updates"] = [{"column": u["column"], "runtime": hoist_caller_items(u["runtime"])} for u in out["updates"]]

        if bridge_panel is None:
            base_acts = [{"type": "data-clear-sort", "target": out["target"]}, out] if kind == "data-sort" else [out]
            if caller_item_pre:
                return [*caller_item_pre, *base_acts]
            return base_acts if kind == "data-sort" else out
        panel_hash = hashlib.sha256(bridge_panel["id"].encode()).hexdigest()[:10]
        bop_var = f"rp1_bop_{panel_hash}"
        if bop_var not in self.variables:
            self.variables[bop_var] = {"type": "number", "value": 0}
        caller_pre, bridge_post = list(caller_item_pre), []

        def has_item(node):
            if not isinstance(node, dict):
                return False
            if node.get("kind") == "item":
                return True
            for v in node.values():
                if isinstance(v, dict) and has_item(v):
                    return True
                if isinstance(v, list) and any(isinstance(c, dict) and has_item(c) for c in v):
                    return True
            return False

        def hoist_ast(node):
            if not isinstance(node, dict):
                return node
            if not has_item(node):
                if node.get("kind") == "literal":
                    return node
                self.bridge_var_counter += 1
                bvar = f"rp1_bvar_{panel_hash}_{self.bridge_var_counter}"
                vtype = node.get("valueType", "text")
                default_val = False if vtype == "boolean" else (0 if vtype == "number" else "")
                self.variables[bvar] = {"type": vtype, "value": default_val}
                caller_pre.append({"type": "set-variable", "variable": bvar, "runtime": copy.deepcopy(node)})
                if kind in {"data-add", "data-delete", "data-update"}:
                    bridge_post.append({"type": "set-variable", "variable": bvar, "value": default_val})
                return {"kind": "variable", "name": bvar, "valueType": vtype}
            out_node = dict(node)
            if "left" in out_node:
                out_node["left"] = hoist_ast(out_node["left"])
            if "right" in out_node:
                out_node["right"] = hoist_ast(out_node["right"])
            if "args" in out_node and isinstance(out_node["args"], list):
                out_node["args"] = [hoist_ast(a) for a in out_node["args"]]
            return out_node

        if "rows" in out:
            out["rows"] = [[{"runtime": hoist_ast(cell["runtime"])} for cell in row_cells] for row_cells in out["rows"]]
        if "predicate" in out:
            out["predicate"] = hoist_ast(out["predicate"])
        if "updates" in out:
            out["updates"] = [{"column": u["column"], "runtime": hoist_ast(u["runtime"])} for u in out["updates"]]
        native_actions = [{"type": "data-clear-sort", "target": out["target"]}, out] if kind == "data-sort" else [out]
        op_list = self.bridge_ops.setdefault((bridge_panel["pageId"], bridge_panel["name"]), [])
        op_id = len(op_list) + 1
        op_list.append({
            "opId": op_id,
            "bopVar": bop_var,
            "panelId": bridge_panel["id"],
            "panelPointer": bridge_panel["pointer"],
            "callerTrigger": self.current_trigger_name,
            "actions": [{"type": "set-variable", "variable": bop_var, "value": 0}, *native_actions, *bridge_post],
        })
        return [
            *caller_pre,
            {"type": "set-variable", "variable": bop_var, "value": op_id},
            {"type": "raise-event", "target": bridge_panel["name"], "eventType": 278},
        ]

    def action(self, action, scope, path):
        if isinstance(action, dict):
            if "type" not in action or action.get("type") in ("goto", "navigate") or (
                action.get("type") == "link" and "target" in action and "page" not in action
            ):
                expanded = self.desugar_action_list([action], path)
                if len(expanded) > 1:
                    return [self.action(item, scope, path) for item in expanded]
                action = expanded[0]
        kind = action.get("type") if isinstance(action, dict) else None
        if not isinstance(kind, str) or kind not in ACTION_PROPS:
            if isinstance(action, dict) and kind is None:
                fail("E_ACTION", path, f"Action object missing 'type' (got keys {sorted(action.keys())}); expected 'type' or shorthand like 'set', 'goto', 'link', 'state', 'show', 'hide'")
            fail("E_ACTION", path, f"Unsupported action '{kind}'")
        fields(action, {"type"} | ACTION_PROPS[kind], path)
        if kind.startswith("data-"):
            return self.data_action(action, scope, path)
        out = copy.deepcopy(action)
        if "target" in ACTION_PROPS[kind]:
            target = self.resolve(action.get("target"), scope, ptr(path, "target"))
            if target["pageId"] != scope.split("/")[0]:
                fail("E_ACTION_SCOPE", path, "Widget actions must target the current page; navigate to change pages")
            target_row = self.row_context(target["id"])[0]
            if target_row and self.row_context(scope)[0] != target_row:
                fail("E_ROW_SCOPE", path, "Row widgets are only accessible from their own row events")
            if kind == "set-text" and target["kind"] not in {"label", "paragraph", "button", "badge", "input"}:
                fail("E_TARGET_TYPE", path, "set-text requires label/paragraph/button/badge/input")
            if kind == "focus" and target["kind"] not in FORM_KINDS:
                fail("E_TARGET_TYPE", path, f"{kind} requires a native input")
            if kind == "set-panel-state":
                if target["kind"] != "dynamic-panel" or action.get("state") not in target.get("states", []):
                    fail("E_STATE", ptr(path, "state"), "State must belong to the target panel")
            out["target"] = target["name"]
        if kind in {"set-check", "set-selected", "set-option"}:
            expected_kinds = CHECK_KINDS if kind == "set-check" else OPTION_KINDS if kind == "set-option" else {"label", "paragraph", "button", "badge"}
            if target["kind"] not in expected_kinds:
                fail("E_TARGET_TYPE", path, f"{kind} target must be one of {sorted(expected_kinds)}")
            key = {"set-check": "checked", "set-selected": "selected", "set-option": "value"}[kind]
            value = self.runtime(action.get(key), scope, ptr(path, key), expected="text" if kind == "set-option" else "boolean")
            out = {"type": "set-selected" if kind == "set-option" else "set-check", "target": target["name"]}
            if value["kind"] != "literal": out["runtime"] = value
            else:
                out["value" if kind == "set-option" else "checked"] = value["value"]
                if kind == "set-option" and value["value"] not in self._native_nodes[target["name"]]["options"]:
                    fail("E_OPTIONS", ptr(path, key), "Selected option must exist on the target")
        if kind == "set-text":
            raw_act_text = action.get("text")
            if isinstance(raw_act_text, str) and (
                (raw_act_text.startswith("=") and not raw_act_text.startswith("=="))
                or (raw_act_text.startswith("[[") and raw_act_text.endswith("]]"))
            ):
                raw_act_text = {"_coerce_text": raw_act_text}
            value = self.runtime(raw_act_text, scope, ptr(path, "text"), expected="text")
            if value["kind"] != "literal": out["runtime"] = value
            else: out["text"] = value["value"]
        if kind == "set-variable":
            variable = action.get("variable")
            self.typecheck(variable, "text", ptr(path, "variable"))
            if variable not in self.variables:
                fail("E_VARIABLE", ptr(path, "variable"), f"Unknown variable '{variable}'")
            value = self.runtime(action.get("value"), scope, ptr(path, "value"), expected=self.variables[variable]["type"])
            if value["kind"] != "literal": out["runtime"] = value
            else: out["value"] = value["value"]
        if kind == "link":
            page = action.get("page")
            if page not in self.pages:
                fail("E_PAGE", ptr(path, "page"), f"Unknown page '{page}'")
            out["page"] = self.pages[page]["name"]
        if kind == "wait":
            self.typecheck(action.get("ms"), "number", ptr(path, "ms"))
            if type(action["ms"]) is not int or action["ms"] < 0:
                fail("E_SIZE", ptr(path, "ms"), "Wait must be a nonnegative integer")
        return out

    def condition(self, condition, scope, path):
        value = self.runtime(condition, scope, path, expected="boolean")
        return {"left": {"runtime": value}, "op": "==", "right": {"runtime": {"kind": "literal", "value": True, "valueType": "boolean"}}}

    def events(self, declarations, scope, path, page=False):
        if not isinstance(declarations, dict):
            fail("E_EVENT", path, "on must map event names to action arrays")
        out, names = [], set()
        for event, actions in declarations.items():
            ep = ptr(path, event)
            native = EVENTS.get(event, event if event in EVENTS.values() else None)
            trigger_symbol = self.symbols.get(getattr(self, "current_trigger_id", ""), {})
            if native == "OnTextChange":
                trigger_kind = trigger_symbol.get("kind")
                if trigger_kind in CHECK_KINDS: native = "OnSelectedChange"
                elif trigger_kind in OPTION_KINDS: native = "OnSelectionChange"
            if not native or (page and event not in {"load", "OnLoad"}):
                fail("E_EVENT", ep, f"Unsupported event '{event}'")
            if native in names:
                fail("E_EVENT", ep, f"Duplicate event alias '{event}'")
            names.add(native)
            if isinstance(actions, str):
                actions = [actions]
            elif isinstance(actions, dict) and "cases" not in actions:
                actions = [actions]
            shorthand = isinstance(actions, list)
            if shorthand:
                cases = [{"actions": self.desugar_action_list(actions, ep)}]
            else:
                fields(actions, {"cases"}, ep)
                cases = actions.get("cases")
            if not isinstance(cases, list) or not cases:
                fail("E_EVENT", ep, "Event requires a nonempty action array or cases")
            compiled_cases = []
            for i, case in enumerate(cases):
                cp = ep if shorthand else ptr(ptr(ep, "cases"), i)
                if isinstance(case, dict) and "do" in case and "actions" not in case:
                    case = {**case, "actions": case["do"]}
                    del case["do"]
                when_origin = None
                if isinstance(case, dict) and "_when_origin" in case:
                    case = dict(case)
                    when_origin = case.pop("_when_origin", None)
                fields(case, {"when", "else", "actions"}, cp)
                if "when" in case and isinstance(case["when"], str) and not case["when"].strip():
                    fail("E_EXPRESSION", when_origin or ptr(cp, "when"), "Expected a nonempty condition expression")
                if not shorthand and "when" not in case and not case.get("else") and not case.get("actions"):
                    fail("E_EXPRESSION", cp, "Case requires when/else and actions, or a nonempty unconditional action list")
                if "else" in case:
                    self.typecheck(case["else"], "boolean", ptr(cp, "else"))
                checked_when = self.condition(case["when"], scope, when_origin or ptr(cp, "when")) if "when" in case else None
                desugared_acts = self.desugar_action_list(case.get("actions"), cp) if not shorthand else case.get("actions")
                if not isinstance(desugared_acts, list) or not desugared_acts:
                    fail("E_EVENT", cp, "Case requires nonempty actions")
                compiled = {"description": "RP/1 " + event,
                            "isNewIfGroup": i == 0,
                            "actions": [item for j, a in enumerate(desugared_acts) for result in [self.action(a, scope, ptr(ep if shorthand else ptr(cp, "actions"), j))] for item in (result if isinstance(result, list) else [result])]}
                if case.get("else"):
                    if i == 0 or "when" in case or i != len(cases) - 1 or not any("when" in c for c in cases[:i]):
                        fail("E_CONDITION", cp, "else must end a conditional chain")
                    compiled["condition"] = "else"
                elif "when" in case:
                    compiled["when"] = checked_when
                    compiled["condition"] = "if" if i == 0 else "else-if"
                elif len(cases) > 1:
                    fail("E_CONDITION", cp, "Multi-case events require when or final else")
                compiled_cases.append(compiled)
            out.append({"event": native, "cases": compiled_cases})
        return out

    def compile(self):
        try:
            return self._compile()
        except LanguageError as error:
            # Generated operations can have no spelling in the caller's JSON.
            # Keep their diagnosis at the nearest real macro parameter/call site.
            path = error.diagnostic["pointer"]
            if any(path == call or path.startswith(call + "/") for call in self.macro_calls):
                call = max((call for call in self.macro_calls if path == call or path.startswith(call + "/")), key=len)
                try:
                    raw_macro = _resolve_pointer(self.raw_spec, call)
                except LanguageError:
                    try:
                        raw_macro = _resolve_pointer(self.spec, call)
                    except LanguageError:
                        raw_macro = {}
                if self.macro_calls[call] == "form-card" and path.startswith(call + "/on/click"):
                    error.diagnostic["pointer"] = path = call + "/onSubmit" + path[len(call + "/on/click"):]
                if error.diagnostic["code"] == "E_EVENT_TARGET" and path == ptr(call, "on") and "on" not in raw_macro:
                    unsupported = next((key for key in ("onLoad", "onChange", "onFocus", "onBlur", "onStateChange") if key in raw_macro), None)
                    if unsupported:
                        fail(error.diagnostic["code"], ptr(call, unsupported), error.diagnostic["message"])
                candidate = path
                while candidate:
                    try:
                        try:
                            _resolve_pointer(self.raw_spec, candidate)
                        except LanguageError:
                            _resolve_pointer(self.spec, candidate)
                        break
                    except LanguageError:
                        candidate = candidate.rpartition("/")[0]
                if candidate and candidate != path:
                    fail(
                        error.diagnostic["code"],
                        candidate,
                        error.diagnostic["message"],
                        error.diagnostic.get("suggestions"),
                        counterexample=error.diagnostic.get("counterexample"),
                        candidate_patches=error.diagnostic.get("candidatePatches"),
                    )
            raise

    def _compile(self):
        fields(self.spec, {"$schema", "language", "target", "name", "theme", "palette", "tokens", "domain", "device", "shell", "static", "strictAudit", "devMode",
                           "product", "models", "datasets", "variables", "computed", "statecharts", "transactions", "invariants", "components",
                           "views", "rules", "masters", "adaptiveViews", "tabBar", "pages"}, "")
        if "$schema" in self.spec: self.typecheck(self.spec["$schema"], "text", "/$schema")
        if self.spec.get("language") != "rp/1":
            fail("E_LANGUAGE", "/language", "Expected language: rp/1")
        if "name" in self.spec:
            self.typecheck(self.spec["name"], "text", "/name")
        if self.spec.get("target", 9) != 9:
            fail("E_TARGET_UNSUPPORTED", "/target", "RP/1 v1 native backend supports target 9")
        if self.spec.get("theme", "mobile-lowfi") not in THEMES:
            fail("E_THEME", "/theme", "Unknown theme")
        for key in ("static", "strictAudit", "devMode"):
            if key in self.spec:
                self.typecheck(self.spec[key], "boolean", ptr("", key))
        if self.spec.get("domain", "mobile") not in {"mobile", "web", "doc", "test"}:
            fail("E_ENUM", "/domain", "Expected mobile/web/doc/test")
        palette = self.spec.get("palette", {})
        if not isinstance(palette, dict):
            fail("E_COLOR", "/palette", "Expected a palette object")
        for name, color in palette.items():
            if not isinstance(color, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
                fail("E_COLOR", ptr("/palette", name), "Palette colors must use #RRGGBB")
        self.models = self.spec.get("models", {})
        fields(self.models, self.models, "/models")
        for name, definition in self.models.items():
            ident(name, ptr("/models", name))
            fields(definition, definition, ptr("/models", name))
            for key, typ in definition.items():
                ident(key, ptr(ptr("/models", name), key))
                if typ not in SCALARS:
                    fail("E_TYPE_NAME", ptr(ptr("/models", name), key), "Model fields must be text/number/boolean")
        self.datasets = self.spec.get("datasets", {})
        fields(self.datasets, self.datasets, "/datasets")
        for name, dataset in self.datasets.items():
            dp = ptr("/datasets", name)
            fields(dataset, {"model", "rows"}, dp)
            if dataset.get("model") not in self.models:
                fail("E_TYPE_NAME", ptr(dp, "model"), "Unknown dataset model")
            if not isinstance(dataset.get("rows"), list):
                fail("E_TYPE", ptr(dp, "rows"), "Expected a row array")
            for i, row in enumerate(dataset["rows"]):
                rp = ptr(ptr(dp, "rows"), i)
                self.typecheck(row, dataset["model"], rp)
                dom_fields = self.domain_models.get(dataset["model"], {})
                for fk, fmeta in dom_fields.items():
                    if fk not in row:
                        continue
                    rval = row[fk]
                    if fmeta.get("domain") == "enum" and rval not in fmeta["values"]:
                        hint = difflib.get_close_matches(str(rval), fmeta["values"], n=3)
                        fail("E_ENUM_VARIANT", ptr(rp, fk), f"Row value '{rval}' is not in enum {fmeta['values']}", suggestions=hint)
                    elif fmeta.get("domain") == "ref" and rval != "":
                        tent = fmeta["entity"]
                        tfield = fmeta.get("field", "id")
                        tds = self.datasets.get(tent) or next((d for d in self.datasets.values() if d.get("model") == tent), None)
                        if tds is not None:
                            valid_keys = {r.get(tfield) for r in tds.get("rows", []) if isinstance(r, dict)}
                            if rval not in valid_keys:
                                fail("E_FOREIGN_KEY", ptr(rp, fk), f"Foreign key '{rval}' not found in '{tent}.{tfield}'")
        self.variables = self.spec.get("variables", {})
        fields(self.variables, self.variables, "/variables")
        for name, variable in self.variables.items():
            ident(name, ptr("/variables", name))
            if name.lower() == "onloadvariable":
                fail("E_VARIABLE", ptr("/variables", name), "Reserved host variable")
            fields(variable, {"type", "value"}, ptr("/variables", name))
            if variable.get("type") not in SCALARS:
                fail("E_TYPE_NAME", ptr("/variables", name), "Variable type must be scalar")
            self.typecheck(variable.get("value"), variable["type"], ptr(ptr("/variables", name), "value"))
        if len({k.lower() for k in self.variables}) != len(self.variables):
            fail("E_VARIABLE", "/variables", "Variable names must be unique ignoring case")
        self.components = self.spec.get("components", {})
        fields(self.components, self.components, "/components")
        for name, component in self.components.items():
            fields(component, {"params", "root"}, ptr("/components", name))
            fields(component.get("params", {}), component.get("params", {}), ptr(ptr("/components", name), "params"))
            for param, typ in component.get("params", {}).items():
                ident(param, ptr(ptr("/components", name), param))
                if typ not in SCALARS and typ not in self.models:
                    fail("E_TYPE_NAME", ptr("/components", name), f"Unknown parameter type '{typ}'")
        pages = self.spec.get("pages")
        if not isinstance(pages, list) or not pages:
            fail("E_PAGE", "/pages", "Expected a nonempty page array")
        lowered = {k: copy.deepcopy(self.spec[k]) for k in ["name", "theme", "palette", "domain", "device", "static", "strictAudit", "masters", "adaptiveViews"] if k in self.spec}
        lowered["pages"] = []
        for i, page in enumerate(pages):
            pp = ptr("/pages", i)
            fields(page, {"id", "slug", "name", "canvas", "domain", "device", "shell", "root", "on", "bindings", "views", "master", "masters", "slot", "tabBar"}, pp)
            if "slug" in page:
                if "id" in page and page["id"] != page["slug"]:
                    fail("E_PAGE", ptr(pp, "slug"), "slug 与 id 冲突；只保留一个")
                page.setdefault("id", page.pop("slug"))
            pid = ident(page.get("id"), ptr(pp, "id"))
            self.typecheck(page.get("name"), "text", ptr(pp, "name"))
            if pid in self.pages:
                fail("E_ID_DUPLICATE", ptr(pp, "id"), "Duplicate page ID")
            if any(p["name"] == page["name"] for p in self.pages.values()):
                fail("E_PAGE", ptr(pp, "name"), "Duplicate page name")
            fields(page.get("canvas"), {"w", "h"}, ptr(pp, "canvas"))
            for axis in ("w", "h"):
                value = page["canvas"].get(axis)
                self.typecheck(value, "number", ptr(ptr(pp, "canvas"), axis))
                if value <= 0:
                    fail("E_SIZE", ptr(ptr(pp, "canvas"), axis), "Canvas must be positive")
            self.pages[pid] = page
        for i, page in enumerate(pages):
            pid, pp = page["id"], ptr("/pages", i)
            result = {"name": page["name"], "slug": pid, "canvas": page["canvas"],
                      **({"domain": page["domain"]} if "domain" in page else ({"domain": self.spec["domain"]} if "domain" in self.spec else {})),
                      **({"device": page["device"]} if "device" in page else {}),
                      "root": self.node(page["root"], pid, {}, ptr(pp, "root")), "interactions": []}
            if pid in self.passthrough_layers:
                result["passthrough_layer"] = copy.deepcopy(self.passthrough_layers[pid])
            if pid in self.page_master_placements:
                result["masters"] = copy.deepcopy(self.page_master_placements[pid])
            lowered["pages"].append(result)
        by_id = {p["slug"]: p for p in lowered["pages"]}
        compiled_bindings = self.compile_bindings(by_id)
        for logical, scope, declarations, path in self.pending:
            symbol = self.symbols[logical]
            self.current_trigger_name = symbol["name"]
            self.current_trigger_id = logical
            by_id[symbol["pageId"]]["interactions"].append({"trigger": symbol["name"],
                "sourceId": logical, "sourcePointer": path,
                "events": self.events(declarations, scope, path)})
        # RP9 TextBox lacks static Rotation capability (REA get_Capabilities),
        # but its native centered Rotate action works. Apply an absolute angle
        # on widget load so panel/master instances keep their own initialization.
        for logical, name, angle, path in self.input_rotations:
            by_id[logical.split("/")[0]]["interactions"].append({
                "trigger": name, "sourceId": logical, "sourcePointer": path,
                "events": [{"event": "OnLoad", "cases": [{
                    "description": "RP/1 input rotation", "isNewIfGroup": True,
                    "actions": [{"type": "rotate", "target": name, "degree": angle,
                                 "rotateType": "location", "duration": 0, "easing": "none"}],
                }]}],
            })
        for i, page in enumerate(pages):
            pid, pp = page["id"], ptr("/pages", i)
            self.current_trigger_name = "page"
            self.current_trigger_id = None
            page_events = self.events(page.get("on", {}), pid, ptr(pp, "on"), page=True)
            load_cases = []
            bindings = page.get("bindings", [])
            if not isinstance(bindings, list):
                fail("E_BINDING", ptr(pp, "bindings"), "Expected a binding array")
            seen_variables, bound_targets = set(), set()
            for j, binding in enumerate(bindings):
                bp = ptr(ptr(pp, "bindings"), j)
                fields(binding, {"dataset", "key", "variable", "targets", "mode", "_from_view", "viewId", "_runtime_selection", "_lookup_repeater_id"}, bp)
                dataset_name = binding.get("dataset")
                dataset = self.datasets.get(dataset_name)
                if dataset is None:
                    fail("E_DATASET", ptr(bp, "dataset"), "Unknown binding dataset")
                key, variable = binding.get("key"), binding.get("variable")
                if self.models[dataset["model"]].get(key) != "text":
                    fail("E_DATA_KEY", ptr(bp, "key"), "Binding key must be a text field")
                if self.variables.get(variable, {}).get("type") != "text":
                    fail("E_VARIABLE", ptr(bp, "variable"), "Binding requires a declared text variable")
                if variable in seen_variables:
                    fail("E_BINDING", bp, "Combine bindings using the same selector variable")
                seen_variables.add(variable)
                targets = binding.get("targets")
                if not isinstance(targets, dict) or not targets:
                    fail("E_BINDING", ptr(bp, "targets"), "Expected target-ID to data-field mappings")
                resolved = []
                for target_id, field_name in targets.items():
                    self.typecheck(field_name, "text", ptr(ptr(bp, "targets"), target_id))
                    symbol = self.resolve({"ref": target_id}, pid, ptr(ptr(bp, "targets"), target_id))
                    if symbol["pageId"] != pid or symbol["kind"] not in {"label", "paragraph", "button", "badge", "input"}:
                        fail("E_TARGET_TYPE", bp, "Binding requires text-capable targets in this page")
                    if field_name not in self.models[dataset["model"]]:
                        fail("E_DATA_FIELD", ptr(ptr(bp, "targets"), target_id), f"Unknown field '{field_name}'")
                    if symbol["id"] in bound_targets:
                        fail("E_BINDING", bp, f"Multiple bindings write '{symbol['id']}'")
                    bound_targets.add(symbol["id"])
                    resolved.append((symbol["name"], field_name))
                keys = [row[key] for row in dataset["rows"]]
                if not keys or len(set(keys)) != len(keys) or any(not k for k in keys):
                    fail("E_DATA_KEY", bp, "Binding dataset needs nonempty, unique keys")
                if self.variables[variable]["value"] not in keys:
                    fail("E_BINDING_DEFAULT", bp, "Selector default must identify an existing row")
                default = next(row for row in dataset["rows"] if row[key] == self.variables[variable]["value"])
                initial = {name: str(default[field]) if not isinstance(default[field], bool)
                           else str(default[field]).lower() for name, field in resolved}

                def initialize(node):
                    if node.get("name") in initial:
                        node["value" if node["type"] == "input" else "text"] = initial[node["name"]]
                    for child in node.get("children", []):
                        initialize(child)
                    for state in node.get("states", []):
                        initialize(state["root"])

                initialize(by_id[pid]["root"])
                if binding.get("_runtime_selection"):
                    lookup_id = binding.get("_lookup_repeater_id")
                    rep_ctx = None
                    if lookup_id and (pid + "/" + lookup_id) in self.repeaters:
                        rep_ctx = self.repeaters[pid + "/" + lookup_id]
                    else:
                        rep_ctx = next((rc for rc in self.repeaters.values() if rc["pageId"] == pid and rc.get("datasetName") == dataset_name), None)
                    if rep_ctx is not None:
                        model_def = self.models[dataset["model"]]
                        where_ast = {
                            "kind": "binary",
                            "op": "==",
                            "left": {"kind": "item", "repeater": rep_ctx["name"], "field": key, "valueType": "text"},
                            "right": {"kind": "variable", "name": variable, "valueType": "text"},
                            "valueType": "boolean",
                        }
                        assignments = []
                        sel_targets = []
                        for t_name, f_name in resolved:
                            sel_var = "rp1_sel_" + re.sub(r"[^A-Za-z0-9_]", "_", t_name)
                            self.variables[sel_var] = {"type": "text", "value": initial[t_name]}
                            f_type = model_def[f_name]
                            val_ast = {"kind": "item", "repeater": rep_ctx["name"], "field": f_name, "valueType": f_type}
                            if f_type != "text":
                                val_ast = {"kind": "call", "fn": "text", "args": [val_ast], "valueType": "text"}
                            assignments.append({
                                "variable": sel_var,
                                "valAst": val_ast,
                                "whereAst": where_ast,
                            })
                            sel_targets.append((t_name, sel_var))
                        cache_key = "rp1_view_key_" + hashlib.sha256((pid + "/" + variable).encode()).hexdigest()[:12]
                        self.variables[cache_key] = {"type": "text", "value": ""}
                        capture_actions = [
                            *[{"type": "set-variable", "variable": var, "value": ""} for _, var in sel_targets],
                            {"type": "data-delete", "target": rep_ctx["name"], "selectionType": 2,
                             "predicate": {"kind": "selection-scan", "valueType": "boolean", "assignments": assignments}},
                            {"type": "set-variable", "variable": cache_key,
                             "runtime": {"kind": "variable", "name": variable, "valueType": "text"}},
                        ]
                        display_actions = [
                            {"type": "set-text", "target": name,
                             "runtime": {"kind": "variable", "name": var, "valueType": "text"}}
                            for name, var in sel_targets
                        ]
                        # Capture the selected row before leaving its live source page.
                        # This carries one selected snapshot, rather than the last added row.
                        load_cases.extend([
                            {"description": f"RP/1 selected snapshot {variable}", "isNewIfGroup": True,
                             "when": {"left": {"variable": cache_key}, "op": "==", "right": {"variable": variable}},
                             "actions": copy.deepcopy(display_actions)},
                            {"description": f"RP/1 initial lookup {variable}", "condition": "else", "isNewIfGroup": False,
                             "actions": copy.deepcopy(capture_actions + display_actions)},
                        ])
                        self.compiled_selection_views.append({
                            "pageId": pid, "datasetName": dataset_name,
                            "repeaterName": rep_ctx["name"], "variable": variable,
                            "captureActions": capture_actions,
                            "scanActions": capture_actions + display_actions,
                        })
                        continue
                for row in dataset["rows"]:
                    load_cases.append({"description": f"RP/1 bind {variable}={row[key]}",
                        "isNewIfGroup": True,
                        "when": {"left": {"variable": variable}, "op": "==", "right": row[key]},
                        "actions": [{"type": "set-text", "target": name,
                                     "text": str(row[field]) if not isinstance(row[field], bool) else str(row[field]).lower()}
                                    for name, field in resolved]})
            # Binding cases are independent `if`s. Distinct variables may match together.
            if load_cases:
                load = next((event for event in page_events if event["event"] == "OnLoad"), None)
                if load is None:
                    load = {"event": "OnLoad", "cases": []}
                    page_events.insert(0, load)
                load["cases"] = load_cases + load["cases"]
            if page_events:
                by_id[pid]["interactions"].append({"trigger": "page", "sourceId": pid,
                    "sourcePointer": pp, "events": page_events})
        self.emit_conditionals_and_aggregates(by_id, compiled_bindings)
        for (page_id, panel_name), ops in self.bridge_ops.items():
            bop_var = ops[0]["bopVar"]
            bop_zero = {
                "kind": "binary",
                "op": "==",
                "left": {"kind": "variable", "name": bop_var, "valueType": "number"},
                "right": {"kind": "literal", "value": 0, "valueType": "number"},
                "valueType": "boolean",
            }
            for ix in by_id[page_id]["interactions"]:
                if ix["trigger"] != panel_name:
                    continue
                for ev in ix["events"]:
                    if ev["event"] != "OnPanelStateChange":
                        continue
                    for uc in ev["cases"]:
                        if "when" not in uc and uc.get("condition") != "else":
                            uc["when"] = {"left": {"runtime": bop_zero}, "op": "==", "right": {"runtime": {"kind": "literal", "value": True, "valueType": "boolean"}}}
                            uc["condition"] = "if"
                            uc["isNewIfGroup"] = True
                        elif "when" in uc and isinstance(uc["when"].get("left"), dict) and "runtime" in uc["when"]["left"]:
                            orig_rt = uc["when"]["left"]["runtime"]
                            uc["when"]["left"]["runtime"] = {"kind": "binary", "op": "&&", "left": bop_zero, "right": orig_rt, "valueType": "boolean"}
                        elif uc.get("condition") == "else":
                            uc["condition"] = "else-if"
                            uc["isNewIfGroup"] = False
                            uc["when"] = {"left": {"runtime": bop_zero}, "op": "==", "right": {"runtime": {"kind": "literal", "value": True, "valueType": "boolean"}}}
            bridge_cases = [
                {
                    "description": f"RP/1 data bridge #{op['opId']}",
                    "isNewIfGroup": True,
                    "condition": "if",
                    "bridgeCaller": op.get("callerTrigger"),
                    "when": {
                        "left": {"runtime": {
                            "kind": "binary",
                            "op": "==",
                            "left": {"kind": "variable", "name": bop_var, "valueType": "number"},
                            "right": {"kind": "literal", "value": op["opId"], "valueType": "number"},
                            "valueType": "boolean",
                        }},
                        "op": "==",
                        "right": {"runtime": {"kind": "literal", "value": True, "valueType": "boolean"}},
                    },
                    "actions": op["actions"],
                }
                for op in ops
            ]
            by_id[page_id]["interactions"].append({
                "trigger": panel_name,
                "sourceId": ops[0]["panelId"],
                "sourcePointer": ops[0]["panelPointer"],
                "events": [{"event": "OnPanelStateChange", "cases": bridge_cases}],
            })
        self.add_binding_refresh(lowered["pages"], compiled_bindings)
        for page in lowered["pages"]:
            merged = {}
            for interaction in page["interactions"]:
                entry = merged.setdefault(interaction["trigger"], {**interaction, "events": []})
                for event in interaction["events"]:
                    previous = next((e for e in entry["events"] if e["event"] == event["event"]), None)
                    if previous: previous["cases"].extend(event["cases"])
                    else: entry["events"].append(event)
            page["interactions"] = list(merged.values())
            for interaction in page["interactions"]:
                for event in interaction["events"]:
                    if len(event["cases"]) > 1:
                        for case in event["cases"]:
                            if "when" not in case and case.get("condition") != "else":
                                case.update(when={"left": True, "op": "==", "right": True}, isNewIfGroup=True)
        compiled_invariants = []
        raw_invs = self.spec.get("invariants")
        default_page_id = lowered["pages"][0]["slug"] if lowered["pages"] else ""
        if isinstance(raw_invs, dict):
            for inv_id, inv_val in raw_invs.items():
                iptr = ptr("/invariants", inv_id)
                expr_val = inv_val.get("assert", inv_val.get("expr", inv_val.get("when"))) if isinstance(inv_val, dict) and any(k in inv_val for k in ("assert", "expr", "when")) else inv_val
                msg = inv_val.get("message", inv_id) if isinstance(inv_val, dict) else inv_id
                ast = self.runtime(self.expression(expr_val, {}, iptr), default_page_id, iptr, expected="boolean")
                compiled_invariants.append({"id": inv_id, "ast": ast, "message": msg, "pointer": iptr})
        elif isinstance(raw_invs, list):
            for idx, inv_item in enumerate(raw_invs):
                iptr = ptr("/invariants", idx)
                if not isinstance(inv_item, dict):
                    fail("E_OBJECT", iptr, "Invariant entry must be an object")
                inv_id = inv_item.get("id", f"inv_{idx+1}")
                expr_val = inv_item.get("assert", inv_item.get("expr", inv_item.get("when")))
                msg = inv_item.get("message", inv_id)
                ast = self.runtime(self.expression(expr_val, {}, iptr), default_page_id, iptr, expected="boolean")
                compiled_invariants.append({"id": inv_id, "ast": ast, "message": msg, "pointer": iptr})
        master_native_names = {}
        symbols_by_name = {symbol["name"]: symbol for symbol in self.symbols.values()}
        def assign_master_names(node, page_id, owner=None):
            owner = None if node.get("_master_slot") else node.get("_master_instance", owner)
            symbol = symbols_by_name.get(node.get("name"))
            if owner and symbol:
                relative = symbol["id"][len(page_id) + 1:]
                symbol["nativeName"] = master_native_names.setdefault((owner, relative), symbol["name"])
                symbol["master"] = owner
            for child in node.get("children", []):
                assign_master_names(child, page_id, owner)
        for page in lowered["pages"]:
            assign_master_names(page["root"], page["slug"])
        symbols = sorted(self.symbols.values(), key=lambda symbol: symbol["id"])
        ir = {"language": "rp/1", "irVersion": 2, "target": 9,
              "theme": lowered.get("theme", "slate"),
              "palette": copy.deepcopy(lowered.get("palette") or {}),
              "models": self.models, "datasets": self.datasets, "variables": self.variables,
              "symbols": symbols, "pages": lowered["pages"], "diagnostics": []}
        def validate_adaptive(node, in_master=False, in_container=False):
            if not isinstance(node, dict):
                return
            in_master = False if node.get("_master_slot") else in_master or bool(node.get("_master_instance"))
            symbol = symbols_by_name.get(node.get("name"))
            path = symbol["pointer"] if symbol else "/"
            if "adaptive" in node:
                ap = ptr(path, "adaptive")
                if in_master or in_container:
                    fail("E_ADAPTIVE", ap, "adaptive overrides require page widgets outside masters/panels/repeaters")
                if not isinstance(node["adaptive"], dict):
                    fail("E_ADAPTIVE", ap, "adaptive must map declared view IDs to geometry objects")
                for view_id, props in node["adaptive"].items():
                    vp = ptr(ap, view_id)
                    if view_id not in view_ids:
                        fail("E_ADAPTIVE", vp, f"Unknown adaptive view '{view_id}'")
                    if not isinstance(props, dict):
                        fail("E_ADAPTIVE", vp, "Expected x/y/w/h geometry overrides")
                    for key, value in props.items():
                        if key not in {"x", "y", "w", "h"}:
                            fail("E_PROPERTY", ptr(vp, key), "adaptive overrides support x/y/w/h")
                        self.typecheck(value, "number", ptr(vp, key))
                        if key in {"w", "h"} and value < 0:
                            fail("E_SIZE", ptr(vp, key), "Adaptive size must be nonnegative")
            for child in node.get("children", []):
                validate_adaptive(child, in_master, in_container)
            for state in node.get("states", []):
                validate_adaptive(state.get("root"), in_master, True)
            if isinstance(node.get("template"), dict):
                validate_adaptive(node["template"], in_master, True)

        view_ids = set()
        views = self.spec.get("adaptiveViews", [])
        if not isinstance(views, list):
            fail("E_ADAPTIVE", "/adaptiveViews", "Expected an adaptive view array")
        for i, view in enumerate(views):
            vp = ptr("/adaptiveViews", i)
            fields(view, {"id", "name", "width", "height", "condition"}, vp)
            vid = ident(view.get("id", view.get("name")), ptr(vp, "id"))
            if vid in view_ids:
                fail("E_ADAPTIVE", ptr(vp, "id"), "Duplicate adaptive view ID")
            view_ids.add(vid)
            for key in ("width", "height"):
                if key == "width" or key in view:
                    self.typecheck(view.get(key), "number", ptr(vp, key))
                    if view[key] < 0 or (key == "width" and view[key] == 0):
                        fail("E_SIZE", ptr(vp, key), "Adaptive view width must be positive and height nonnegative")
            if "condition" in view and view["condition"] not in {"<=", ">="}:
                fail("E_ADAPTIVE", ptr(vp, "condition"), "Expected <= or >=")
        for page in lowered["pages"]:
            validate_adaptive(page["root"])
        if self.domain_models:
            ir["domainModels"] = self.domain_models
        if self.spec.get("statecharts"):
            ir["statecharts"] = copy.deepcopy(self.spec["statecharts"])
        if self.product_provenance is not None:
            ir["productProvenance"] = self.product_provenance
        if compiled_invariants:
            ir["invariants"] = compiled_invariants
        if getattr(self, "compiled_aggregates", None) or getattr(self, "compiled_formulas", None):
            ir["computedMeta"] = {
                "aggregates": getattr(self, "compiled_aggregates", []),
                "formulas": [{"name": f["name"], "ast": f["ast"], "pointer": f["pointer"]} for f in getattr(self, "compiled_formulas", [])],
            }
        # Display metadata must not change identity or the semantic patch guard.
        hash_ir = {**ir, "symbols": [{k: v for k, v in symbol.items() if k != "display"}
                                      for symbol in symbols]}
        for symbol in hash_ir["symbols"]:
            symbol["label"] = self.identity_labels[symbol["id"]]
        ir["semanticHash"] = hashlib.sha256(__import__("json").dumps(hash_ir, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return lowered, ir


def compile_language(spec):
    try:
        return Frontend(spec).compile()
    except RecursionError:
        fail("E_DEPTH", "/", "Expanded source exceeds the compiler recursion limit")
