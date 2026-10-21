"""
RP/1 Unified Product Model & Business Intent Compiler (rp_product.py)
Pure in-memory deterministic compiler from structured product intent
(entities, rules, queries, operations, views) to RP/1 specifications
with full provenance tracking and rule-driven impact analysis.
"""
import copy


PRODUCT_TOP_FIELDS = {"shell", "entities", "computed", "statecharts", "transactions", "rules", "queries", "operations", "views"}
ENTITY_FIELDS = {"key", "fields", "rows", "selectionVariable", "nextIdVariable", "nextIdDefault", "statusField"}
FIELD_SPEC_PROPS = {"type", "label", "required", "default", "enum", "values", "target", "entity", "placeholder", "min", "max"}
RULE_PROPS = {
    "entity",
    "operation",
    "when",
    "description",
    "guard",
    "guards",
    "require",
    "conflict",
    "exists",
    "effect",
    "errorMessage",
    "requiredFields",
    "requireContact",
    "contactField",
    "contactRequiredMessage",
    "statusTransition",
    "claimedStatus",
    "excludeClaimedFromList",
    "listWhere",
    "detailClaimedText",
    "detailStatusPrefix",
}
QUERY_PROPS = {"entity", "searchField", "filterField", "filters", "where", "respectRule", "emptyText", "pageSize", "rowHeight"}
OPERATION_PROPS = {
    "kind",
    "entity",
    "targetEntity",
    "rule",
    "rules",
    "fields",
    "defaults",
    "set",
    "where",
    "guard",
    "errorMessage",
    "successText",
    "navigateTo",
    "targetView",
}
VIEW_PROPS = {
    "id",
    "title",
    "subtitle",
    "kind",
    "entity",
    "secondaryEntity",
    "query",
    "operation",
    "rule",
    "selectOperation",
    "displayFields",
    "cardFields",
    "primaryAction",
    "secondaryAction",
    "submitText",
    "backTo",
    "slots",
    "steps",
    "tabs",
}

DOMAIN_SCALAR_MAP = {
    "text": "text", "number": "number", "boolean": "boolean",
    "id": "text", "enum": "text", "money": "number",
    "phone": "text", "date": "text", "percent": "number", "ref": "text",
}


def _base_scalar_type(ftype):
    if not isinstance(ftype, str):
        return None
    if ftype in DOMAIN_SCALAR_MAP:
        return DOMAIN_SCALAR_MAP[ftype]
    if ftype.startswith("enum(") and ftype.endswith(")"):
        return "text"
    if ftype.startswith("ref<") and ftype.endswith(">"):
        return "text"
    return None


def _ptr(base, token):
    token_str = str(token).replace("~", "~0").replace("/", "~1")
    return f"{base}/{token_str}" if base else f"/{token_str}"


def _active_required_fields(rule_id, rule_def, entity_def):
    """Return normalized list of {field, message, ruleId, pointer} for active required field checks."""
    out = []
    if not isinstance(rule_def, dict):
        return out
    base_ptr = _ptr("/product/rules", rule_id)
    req_list = list(rule_def.get("requiredFields") or []) + list(rule_def.get("require") or [])
    for idx, entry in enumerate(req_list):
        ep = _ptr(_ptr(base_ptr, "require" if "require" in rule_def else "requiredFields"), idx)
        if isinstance(entry, str):
            fname = entry
            enabled = True
            fmeta = (entity_def or {}).get("fields", {}).get(fname, {})
            label = fmeta.get("label", fname) if isinstance(fmeta, dict) else fname
            msg = f"请填写{label}"
        elif isinstance(entry, dict):
            fname = entry.get("field")
            enabled = bool(entry.get("required", True))
            fmeta = (entity_def or {}).get("fields", {}).get(fname, {})
            label = fmeta.get("label", fname) if isinstance(fmeta, dict) else fname
            msg = entry.get("message") or f"请填写{label}"
        else:
            continue
        if enabled and fname and not any(r["field"] == fname for r in out):
            out.append({"field": fname, "message": msg, "ruleId": rule_id, "pointer": ep})
    if rule_def.get("requireContact"):
        cf = rule_def.get("contactField", "contact")
        if not any(r["field"] == cf for r in out):
            fmeta = (entity_def or {}).get("fields", {}).get(cf, {})
            label = fmeta.get("label", cf) if isinstance(fmeta, dict) else cf
            msg = rule_def.get("contactRequiredMessage") or f"请填写{label}"
            out.append({
                "field": cf,
                "message": msg,
                "ruleId": rule_id,
                "pointer": _ptr(base_ptr, "requireContact"),
            })
    return out


def _rule_status_transition(rule_id, rule_def, entity_def):
    if not isinstance(rule_def, dict):
        return None
    status_field = (entity_def or {}).get("statusField", "status")
    effect = rule_def.get("effect") if isinstance(rule_def.get("effect"), dict) else {}
    if effect.get("status") or effect.get("transitionTo") or (isinstance(effect.get("set"), dict) and status_field in effect["set"]):
        to_val = effect.get("status") or effect.get("transitionTo") or effect["set"][status_field]
        return {
            "field": effect.get("statusField", status_field),
            "from": effect.get("from"),
            "to": to_val,
            "ruleId": rule_id,
            "pointer": _ptr(_ptr("/product/rules", rule_id), "effect"),
        }
    st = rule_def.get("statusTransition")
    if isinstance(st, dict) and st.get("to"):
        return {
            "field": st.get("field", status_field),
            "from": st.get("from"),
            "to": st["to"],
            "ruleId": rule_id,
            "pointer": _ptr(_ptr("/product/rules", rule_id), "statusTransition"),
        }
    if rule_def.get("claimedStatus"):
        return {
            "field": status_field,
            "from": None,
            "to": rule_def["claimedStatus"],
            "ruleId": rule_id,
            "pointer": _ptr(_ptr("/product/rules", rule_id), "claimedStatus"),
        }
    return None


def _rule_list_exclusion(rule_id, rule_def, entity_def):
    if not isinstance(rule_def, dict):
        return None
    effect = rule_def.get("effect") if isinstance(rule_def.get("effect"), dict) else {}
    if effect.get("excludeFrom"):
        st = _rule_status_transition(rule_id, rule_def, entity_def)
        status_field = st["field"] if st else (entity_def or {}).get("statusField", "status")
        target_status = st["to"] if st else (effect.get("status") or "已认领")
        return {
            "expr": effect.get("filterWhere") or f"=item.{status_field} != '{target_status}'",
            "statusField": status_field,
            "excludedValue": target_status,
            "excludeFrom": effect["excludeFrom"],
            "ruleId": rule_id,
            "pointer": _ptr(_ptr("/product/rules", rule_id), "effect"),
        }
    if rule_def.get("listWhere"):
        return {
            "expr": rule_def["listWhere"],
            "ruleId": rule_id,
            "pointer": _ptr(_ptr("/product/rules", rule_id), "listWhere"),
        }
    if rule_def.get("excludeClaimedFromList"):
        st = _rule_status_transition(rule_id, rule_def, entity_def)
        status_field = st["field"] if st else (entity_def or {}).get("statusField", "status")
        target_status = st["to"] if st else (rule_def.get("claimedStatus") or "已认领")
        return {
            "expr": f"=item.{status_field} != '{target_status}'",
            "statusField": status_field,
            "excludedValue": target_status,
            "ruleId": rule_id,
            "pointer": _ptr(_ptr("/product/rules", rule_id), "excludeClaimedFromList"),
        }
    return None


def expand_product_spec(spec, fail_fn, ident_fn, fields_fn, typecheck_fn):
    """
    Validate and compile `spec['product']` into RP/1 `models`, `datasets`, `variables`, `pages`,
    and return `(expanded_spec, product_provenance)`.
    """
    if not isinstance(spec, dict) or "product" not in spec:
        return spec, None

    product = spec.get("product")
    if not isinstance(product, dict):
        fail_fn("E_TYPE", "/product", "product must be an object")
    fields_fn(product, PRODUCT_TOP_FIELDS, "/product")

    entities = product.get("entities")
    has_aux_only = bool(product.get("computed") or product.get("statecharts") or product.get("transactions")) and not any(
        product.get(k) for k in ("rules", "queries", "operations", "views")
    ) and bool(spec.get("datasets") or spec.get("models") or spec.get("pages"))
    if (not isinstance(entities, dict) or not entities) and not has_aux_only:
        fail_fn("E_PRODUCT_ENTITY", "/product/entities", "product.entities requires at least one entity")
    entities = entities if isinstance(entities, dict) else {}

    rules = product.get("rules") or {}
    if not isinstance(rules, dict):
        fail_fn("E_TYPE", "/product/rules", "product.rules must be an object")

    queries = product.get("queries") or {}
    if not isinstance(queries, dict):
        fail_fn("E_TYPE", "/product/queries", "product.queries must be an object")

    operations = product.get("operations") or {}
    if not isinstance(operations, dict):
        fail_fn("E_TYPE", "/product/operations", "product.operations must be an object")

    views = product.get("views") or []
    if not isinstance(views, list):
        fail_fn("E_TYPE", "/product/views", "product.views must be an array")

    out = copy.deepcopy(spec)
    models = out.setdefault("models", {})
    datasets = out.setdefault("datasets", {})
    variables = out.setdefault("variables", {})

    provenance = {
        "entities": {},
        "computed": {},
        "statecharts": {},
        "transactions": {},
        "rules": {},
        "queries": {},
        "operations": {},
        "views": {},
        "symbolOrigins": {},
        "validationCases": [],
        "filterBindings": [],
        "detailBindings": [],
    }

    # 1. Validate & lower entities -> models, datasets, selection/nextId variables
    entity_meta = {}
    for ename, edef in entities.items():
        ep = _ptr("/product/entities", ename)
        ident_fn(ename, ep)
        if not isinstance(edef, dict):
            fail_fn("E_TYPE", ep, "Entity definition must be an object")
        fields_fn(edef, ENTITY_FIELDS, ep)
        fmap = edef.get("fields")
        if not isinstance(fmap, dict) or not fmap:
            fail_fn("E_PRODUCT_ENTITY", _ptr(ep, "fields"), f"Entity '{ename}' requires nonempty fields")
        key_field = edef.get("key", "id")
        typecheck_fn(key_field, "text", _ptr(ep, "key"))
        if key_field not in fmap:
            fail_fn("E_DATA_KEY", _ptr(ep, "key"), f"Key field '{key_field}' must exist in entity '{ename}'")

        model_fields = {}
        model_specs = {}
        field_labels = {}
        field_defaults = {}
        field_enums = {}
        for fname, fspec in fmap.items():
            fp = _ptr(_ptr(ep, "fields"), fname)
            ident_fn(fname, fp)
            if isinstance(fspec, str):
                raw_type = fspec
                ftype = _base_scalar_type(raw_type)
                flabel = fname
                fdefault = "" if ftype == "text" else (0 if ftype == "number" else False)
                if raw_type.startswith("enum(") and raw_type.endswith(")"):
                    vals = [x.strip() for x in raw_type[5:-1].replace("|", ",").split(",") if x.strip()]
                    if vals:
                        field_enums[fname] = vals
                        fdefault = vals[0]
                model_specs[fname] = raw_type
            elif isinstance(fspec, dict):
                fields_fn(fspec, FIELD_SPEC_PROPS, fp)
                raw_type = fspec.get("type", "text")
                ftype = _base_scalar_type(raw_type)
                flabel = fspec.get("label", fname)
                fdefault = fspec.get("default", "" if ftype == "text" else (0 if ftype == "number" else False))
                enum_vals = fspec.get("enum") or fspec.get("values")
                if enum_vals is not None:
                    if not isinstance(enum_vals, list) or not enum_vals:
                        fail_fn("E_TYPE", _ptr(fp, "enum"), "enum must be a nonempty array")
                    field_enums[fname] = list(enum_vals)
                    if "default" not in fspec:
                        fdefault = enum_vals[0]
                elif isinstance(raw_type, str) and raw_type.startswith("enum(") and raw_type.endswith(")"):
                    vals = [x.strip() for x in raw_type[5:-1].replace("|", ",").split(",") if x.strip()]
                    if vals:
                        field_enums[fname] = vals
                        if "default" not in fspec:
                            fdefault = vals[0]
                model_specs[fname] = copy.deepcopy(fspec)
            else:
                fail_fn("E_TYPE", fp, "Field specification must be a type name or object")
            if ftype not in ("text", "number", "boolean"):
                fail_fn("E_TYPE_NAME", fp, f"Unsupported field type '{raw_type}'")
            model_fields[fname] = ftype
            field_labels[fname] = flabel
            field_defaults[fname] = fdefault

        if model_fields[key_field] != "text":
            fail_fn("E_DATA_KEY", _ptr(ep, "key"), "Entity key field must have type 'text'")

        models[ename] = model_specs
        rows = copy.deepcopy(edef.get("rows") or [])
        if not isinstance(rows, list) or not rows:
            fail_fn("E_DATA_ROWS", _ptr(ep, "rows"), f"Entity '{ename}' requires initial rows")
        for r_idx, row in enumerate(rows):
            rp = _ptr(_ptr(ep, "rows"), r_idx)
            if not isinstance(row, dict):
                fail_fn("E_TYPE", rp, "Row must be an object")
            for fname, fdefault in field_defaults.items():
                if fname not in row and fname != key_field:
                    row[fname] = fdefault
        dset_name = f"{ename.lower()}_items" if f"{ename.lower()}_items" not in datasets else ename.lower()
        datasets[dset_name] = {"model": ename, "rows": rows}

        sel_var = edef.get("selectionVariable") or f"selected_{ename.lower()}_id"
        next_var = edef.get("nextIdVariable") or f"next_{ename.lower()}_id"
        first_row = rows[0]
        variables.setdefault(sel_var, {"type": "text", "value": str(first_row.get(key_field, ""))})
        variables.setdefault(next_var, {"type": "text", "value": str(edef.get("nextIdDefault", f"{ename[:2].upper()}-109"))})

        # Create active-record mirror variables for each field so detail views and forms stay in sync
        field_vars = {}
        for fname, ftype in model_fields.items():
            vname = f"cur_{ename.lower()}_{fname}"
            field_vars[fname] = vname
            variables.setdefault(vname, {"type": ftype, "value": first_row.get(fname, field_defaults[fname])})

        status_field = edef.get("statusField", "status" if "status" in model_fields else key_field)
        entity_meta[ename] = {
            "name": ename,
            "pointer": ep,
            "key": key_field,
            "statusField": status_field,
            "dataset": dset_name,
            "modelFields": model_fields,
            "fieldLabels": field_labels,
            "fieldDefaults": field_defaults,
            "fieldEnums": field_enums,
            "selectionVariable": sel_var,
            "nextIdVariable": next_var,
            "fieldVariables": field_vars,
            "rows": rows,
        }
        provenance["entities"][ename] = {
            "pointer": ep,
            "model": ename,
            "dataset": dset_name,
            "selectionVariable": sel_var,
            "nextIdVariable": next_var,
            "fieldVariables": field_vars,
        }

    # 1b. Lower product.computed, product.statecharts, product.transactions
    for cname, cspec in (product.get("computed") or {}).items():
        cp = _ptr("/product/computed", cname)
        ident_fn(cname, cp)
        if isinstance(cspec, dict):
            c_copy = copy.deepcopy(cspec)
            if "compute" not in c_copy and "op" in c_copy:
                c_copy = {"type": "number", "value": 0, "compute": c_copy}
            comp = c_copy.get("compute")
            if isinstance(comp, dict) and comp.get("dataset") in entity_meta:
                comp["dataset"] = entity_meta[comp["dataset"]]["dataset"]
            variables[cname] = c_copy
        else:
            variables[cname] = {"type": "number", "value": 0, "compute": str(cspec)}
        provenance["computed"][cname] = {"pointer": cp, "variable": cname}

    for sc_name, sc_def in (product.get("statecharts") or {}).items():
        scp = _ptr("/product/statecharts", sc_name)
        ident_fn(sc_name, scp)
        if isinstance(sc_def, dict):
            sc_var = sc_def.get("variable") or f"state_{sc_name}"
            states_list = sc_def.get("states") or ["idle"]
            init_st = sc_def.get("initial") or states_list[0]
            variables.setdefault(sc_var, {"type": "text", "value": str(init_st)})
            provenance["statecharts"][sc_name] = {
                "pointer": scp,
                "variable": sc_var,
                "initial": init_st,
                "states": states_list,
                "transitions": copy.deepcopy(sc_def.get("transitions") or []),
            }

    for tx_name, tx_def in (product.get("transactions") or {}).items():
        txp = _ptr("/product/transactions", tx_name)
        ident_fn(tx_name, txp)
        provenance["transactions"][tx_name] = {"pointer": txp, "definition": copy.deepcopy(tx_def)}

    # 2. Validate rules
    for rname, rdef in rules.items():
        rp = _ptr("/product/rules", rname)
        ident_fn(rname, rp)
        if not isinstance(rdef, dict):
            fail_fn("E_TYPE", rp, "Rule must be an object")
        fields_fn(rdef, RULE_PROPS, rp)
        ename = rdef.get("entity")
        if ename not in entity_meta:
            fail_fn("E_REFERENCE", _ptr(rp, "entity"), f"Rule '{rname}' references unknown entity '{ename}'", suggestions=sorted(entity_meta.keys()))
        em = entity_meta[ename]
        for req in _active_required_fields(rname, rdef, entities[ename]):
            if req["field"] not in em["modelFields"]:
                fail_fn("E_DATA_FIELD", req["pointer"], f"Rule '{rname}' references unknown field '{req['field']}'", suggestions=sorted(em["modelFields"].keys()))
        st = _rule_status_transition(rname, rdef, entities[ename])
        if st and st["field"] not in em["modelFields"]:
            fail_fn("E_DATA_FIELD", st["pointer"], f"Rule '{rname}' statusTransition references unknown field '{st['field']}'", suggestions=sorted(em["modelFields"].keys()))
        provenance["rules"][rname] = {
            "pointer": rp,
            "entity": ename,
            "operation": rdef.get("operation"),
            "requiredFields": [x["field"] for x in _active_required_fields(rname, rdef, entities[ename])],
            "statusTransition": st,
            "listExclusion": _rule_list_exclusion(rname, rdef, entities[ename]),
            "detailClaimedText": rdef.get("detailClaimedText"),
        }

    # 3. Validate queries
    for qname, qdef in queries.items():
        qp = _ptr("/product/queries", qname)
        ident_fn(qname, qp)
        if not isinstance(qdef, dict):
            fail_fn("E_TYPE", qp, "Query must be an object")
        fields_fn(qdef, QUERY_PROPS, qp)
        ename = qdef.get("entity")
        if ename not in entity_meta:
            fail_fn("E_REFERENCE", _ptr(qp, "entity"), f"Query '{qname}' references unknown entity '{ename}'", suggestions=sorted(entity_meta.keys()))
        em = entity_meta[ename]
        sfield = qdef.get("searchField")
        if not sfield or sfield not in em["modelFields"]:
            fail_fn("E_DATA_FIELD", _ptr(qp, "searchField"), f"Query '{qname}' requires a valid searchField", suggestions=sorted(em["modelFields"].keys()))
        ffield = qdef.get("filterField", sfield)
        if ffield not in em["modelFields"]:
            fail_fn("E_DATA_FIELD", _ptr(qp, "filterField"), f"Query '{qname}' references unknown filterField '{ffield}'", suggestions=sorted(em["modelFields"].keys()))
        rrule = qdef.get("respectRule")
        if rrule is not None and rrule not in rules:
            fail_fn("E_REFERENCE", _ptr(qp, "respectRule"), f"Query '{qname}' references unknown rule '{rrule}'", suggestions=sorted(rules.keys()))
        provenance["queries"][qname] = {
            "pointer": qp,
            "entity": ename,
            "searchField": sfield,
            "filterField": ffield,
            "respectRule": rrule,
        }

    # 4. Validate operations
    for oname, odef in operations.items():
        op_ptr = _ptr("/product/operations", oname)
        ident_fn(oname, op_ptr)
        if not isinstance(odef, dict):
            fail_fn("E_TYPE", op_ptr, "Operation must be an object")
        fields_fn(odef, OPERATION_PROPS, op_ptr)
        ename = odef.get("entity")
        if ename not in entity_meta:
            fail_fn("E_REFERENCE", _ptr(op_ptr, "entity"), f"Operation '{oname}' references unknown entity '{ename}'", suggestions=sorted(entity_meta.keys()))
        kind = odef.get("kind")
        if kind not in ("select", "create", "update", "delete", "transfer", "transition"):
            fail_fn("E_ENUM", _ptr(op_ptr, "kind"), "Operation kind must be select, create, update, delete, transfer or transition")
        op_rules = list(odef.get("rules") or ([] if not odef.get("rule") else [odef["rule"]]))
        for rn in op_rules:
            if rn not in rules:
                fail_fn("E_REFERENCE", _ptr(op_ptr, "rule"), f"Operation '{oname}' references unknown rule '{rn}'", suggestions=sorted(rules.keys()))
        for f in odef.get("fields") or []:
            if f not in entity_meta[ename]["modelFields"]:
                fail_fn("E_DATA_FIELD", _ptr(op_ptr, "fields"), f"Operation '{oname}' references unknown field '{f}'", suggestions=sorted(entity_meta[ename]["modelFields"].keys()))
        provenance["operations"][oname] = {
            "pointer": op_ptr,
            "kind": kind,
            "entity": ename,
            "rules": op_rules,
        }

    # 5. If `pages` is not explicitly provided, synthesize the complete multi-view page from `product.views`
    if "pages" not in out:
        if not views:
            fail_fn("E_PRODUCT_VIEW", "/product/views", "product.views requires at least one view when pages is omitted")
        out["pages"] = _compile_product_views_to_pages(
            spec,
            product,
            entity_meta,
            rules,
            queries,
            operations,
            views,
            variables,
            provenance,
            fail_fn,
            ident_fn,
            fields_fn,
        )

    return out, provenance


def _compile_product_views_to_pages(
    spec,
    product,
    entity_meta,
    rules,
    queries,
    operations,
    views,
    variables,
    provenance,
    fail_fn,
    ident_fn,
    fields_fn,
):
    shell = spec.get("shell") or product.get("shell")
    domain = spec.get("domain", "mobile")
    if shell == "mobile-stack":
        is_web = False
        is_tablet = False
        canvas = {"w": 375, "h": 812}
    elif shell == "tablet-split":
        is_web = True
        is_tablet = True
        canvas = {"w": 834, "h": 560}
    elif shell == "web-console":
        is_web = True
        is_tablet = False
        canvas = {"w": 1028, "h": 480}
    else:
        is_web = domain in ("web", "doc")
        is_tablet = False
        canvas = {"w": 1028, "h": 480} if is_web else {"w": 375, "h": 812}
    provenance["shell"] = shell or ("web-console" if is_web else "mobile-stack")

    view_by_id = {}
    list_view = None
    panel_views = []
    for idx, v in enumerate(views):
        vp = _ptr("/product/views", idx)
        if not isinstance(v, dict):
            fail_fn("E_TYPE", vp, "View must be an object")
        fields_fn(v, VIEW_PROPS, vp)
        vid = ident_fn(v.get("id"), _ptr(vp, "id"))
        if vid in view_by_id:
            fail_fn("E_DUPLICATE_ID", _ptr(vp, "id"), f"Duplicate view id '{vid}'")
        ename = v.get("entity") or next(iter(entity_meta.keys()))
        if ename not in entity_meta:
            fail_fn("E_REFERENCE", _ptr(vp, "entity"), f"View '{vid}' references unknown entity '{ename}'", suggestions=sorted(entity_meta.keys()))
        vkind = v.get("kind")
        if vkind not in ("list", "detail", "form", "wizard", "master-detail", "kanban", "shuttle", "cart"):
            fail_fn("E_ENUM", _ptr(vp, "kind"), "View kind must be list, detail, form, wizard, master-detail, kanban, shuttle or cart")
        entry = {**v, "entity": ename, "_pointer": vp, "_index": idx}
        view_by_id[vid] = entry
        if vkind in ("list", "master-detail", "kanban", "shuttle", "cart") and list_view is None:
            list_view = entry
        else:
            panel_views.append(entry)

    if list_view is None and panel_views and panel_views[0]["kind"] == "wizard":
        # Standalone wizard view
        wv = panel_views[0]
        w_id = wv["id"]
        w_steps = copy.deepcopy(wv.get("steps") or [{"id": "step_1", "title": "第一步", "root": {"type": "label", "id": "s1_lbl", "w": 240, "h": 24, "text": "步骤内容"}}])
        wiz_node = {
            "type": "wizard-card",
            "id": w_id,
            "title": wv.get("title", "向导"),
            "w": canvas["w"] - 32,
            "h": "hug",
            "steps": w_steps,
        }
        if isinstance(wv.get("slots"), dict):
            wiz_node["slots"] = copy.deepcopy(wv["slots"])
        provenance["views"][w_id] = {"pointer": wv["_pointer"], "kind": "wizard", "entity": wv["entity"], "symbols": [f"workspace/{w_id}_card"]}
        return [{
            "id": "workspace",
            "name": spec.get("name", wv.get("title", "Wizard")),
            "canvas": canvas,
            "root": {
                "type": "box",
                "id": "workspace_root",
                "layout": "column",
                "w": canvas["w"],
                "h": canvas["h"],
                "padding": [16, 16],
                "gap": 12,
                "children": [wiz_node],
            },
        }]

    if list_view is None:
        fail_fn("E_PRODUCT_VIEW", "/product/views", "product.views requires a primary 'list' view")

    ename = list_view["entity"]
    em = entity_meta[ename]
    raw_entity = product["entities"][ename]
    qname = list_view.get("query")
    if qname not in queries:
        fail_fn("E_REFERENCE", _ptr(list_view["_pointer"], "query"), f"List view '{list_view['id']}' requires a valid query", suggestions=sorted(queries.keys()))
    qdef = queries[qname]

    # Check if query respects a rule with list exclusion
    rrule_id = qdef.get("respectRule")
    rrule_def = rules.get(rrule_id) if rrule_id else None
    list_exclusion = _rule_list_exclusion(rrule_id, rrule_def, raw_entity) if rrule_id else None

    # Note: searchable-list macro with id=list_id creates outer box f"{list_id}_list" and inner repeater list_id
    list_id = f"{list_view['id']}_items"
    rep_id = list_id
    empty_banner_id = f"{list_view['id']}_empty_state"
    status_banner_id = "workspace_status_banner"
    panel_id = "workspace_panel"

    # Detail widget IDs mapped per field so Repeater row click & operations can update them directly
    detail_views = [v for v in panel_views if v["kind"] == "detail"]
    primary_detail = detail_views[0] if detail_views else None
    detail_field_widget_ids = {}
    detail_status_badge_id = None
    detail_primary_btn_id = None
    if primary_detail:
        dfields = primary_detail.get("displayFields") or list(em["modelFields"].keys())
        for f in dfields:
            detail_field_widget_ids[f] = f"workspace/{panel_id}/{primary_detail['id']}/det_val_{f}"
        detail_status_badge_id = f"workspace/{panel_id}/{primary_detail['id']}/det_status_badge"
        if isinstance(primary_detail.get("primaryAction"), dict) and primary_detail["primaryAction"].get("navigateTo"):
            detail_primary_btn_id = f"workspace/{panel_id}/{primary_detail['id']}/{primary_detail['id']}_primary_btn"

    # Build row click actions on the list Repeater template
    card_fields = list_view.get("cardFields") or {}
    title_field = card_fields.get("title", qdef.get("searchField", em["key"]))
    badge_field = card_fields.get("badge", em["statusField"])
    sub_field = card_fields.get("subtitle", next((f for f in em["modelFields"] if f not in (em["key"], title_field, badge_field)), title_field))

    row_select_actions = [
        {"type": "set-variable", "variable": em["selectionVariable"], "value": f"=item.{em['key']}"},
    ]
    for fname, vname in em["fieldVariables"].items():
        row_select_actions.append({"type": "set-variable", "variable": vname, "value": f"=item.{fname}"})
    if primary_detail:
        drule_id = primary_detail.get("rule") or rrule_id
        drule_def = rules.get(drule_id) if drule_id else None
        status_prefix = (drule_def or {}).get("detailStatusPrefix", "")
        for fname, wid in detail_field_widget_ids.items():
            if fname == em["statusField"] and status_prefix:
                row_select_actions.append({"type": "set-text", "target": wid, "text": f"{status_prefix}${{item.{fname}}}"})
            else:
                row_select_actions.append({"type": "set-text", "target": wid, "text": f"=item.{fname}"})
        if detail_status_badge_id:
            row_select_actions.append({"type": "set-text", "target": detail_status_badge_id, "text": f"=item.{em['statusField']}"})
        if detail_primary_btn_id:
            row_select_actions.append({"type": "set-text", "target": detail_primary_btn_id, "text": primary_detail["primaryAction"].get("label", "下一步")})
        row_select_actions.append({"type": "set-panel-state", "target": panel_id, "state": primary_detail["id"]})
    row_select_actions.append({"type": "set-text", "target": status_banner_id, "text": f"已选中：${{item.{title_field}}}"})

    # Dimensions for Web vs Tablet vs Mobile
    list_w = 340 if is_tablet else (468 if is_web else 343)
    panel_w = 430 if is_tablet else (496 if is_web else 343)
    max_title_chars = max((len(str(r.get(title_field, ""))) for r in em["rows"]), default=6)
    max_sub_chars = max((len(str(r.get(sub_field, ""))) for r in em["rows"]), default=4)
    title_fsz = 12 if (not is_web or max_title_chars >= 12) else 13
    title_w = 128 if is_tablet else (184 if is_web else 118)
    sub_w = 64 if is_tablet else (96 if is_web else 58)
    title_h = 34 if max_title_chars * title_fsz * 1.05 > title_w else 24
    sub_h = 34 if max_sub_chars * 12 * 1.05 > sub_w else 24
    show_empty_probe = bool(spec.get("devMode") or product.get("devMode") or qdef.get("emptyProbe"))
    row_h = int(qdef.get("rowHeight", (52 if (title_h > 24 or sub_h > 24) else 44) if is_web else (52 if (title_h > 24 or sub_h > 24) else 48)))
    rep_h = (200 if show_empty_probe else 252) if is_web else (156 if show_empty_probe else 200)
    panel_h = 448 if is_web else 376

    row_template = {
        "type": "box",
        "id": f"{list_id}_row",
        "layout": "row",
        "w": list_w,
        "h": row_h,
        "padding": [8, 12] if is_web else [8, 8],
        "gap": 8,
        "align": "center",
        "fill": "$surface",
        "stroke": "$line",
        "radius": 8,
        "children": [
            {
                "type": "label",
                "id": f"{list_id}_row_title",
                "w": title_w,
                "h": title_h,
                "fontSize": title_fsz,
                "fontWeight": 600,
                "text": {"item": title_field},
            },
            {
                "type": "label",
                "id": f"{list_id}_row_sub",
                "w": sub_w,
                "h": sub_h,
                "fontSize": 12,
                "color": "$ink-2",
                "text": {"item": sub_field},
            },
            {
                "type": "badge",
                "id": f"{list_id}_row_badge",
                "w": 64 if is_tablet else (72 if is_web else 64),
                "h": 24,
                "fontSize": 12,
                "text": {"item": badge_field},
            },
            {
                "type": "button",
                "id": f"{list_id}_row_select_btn",
                "w": 56 if is_tablet else (64 if is_web else 56),
                "h": 28,
                "fontSize": 12,
                "variant": "secondary",
                "text": "详情",
                "onClick": row_select_actions,
            },
        ],
    }

    q_filters = qdef.get("filters")
    searchable_list_node = {
        "type": "searchable-list",
        "id": list_id,
        "dataset": em["dataset"],
        "key": em["key"],
        "searchField": qdef["searchField"],
        "filterField": qdef.get("filterField", qdef["searchField"]),
        "filters": "auto" if q_filters == "auto" else copy.deepcopy(q_filters or []),
        "w": list_w,
        "rowHeight": row_h,
        "rowGap": 8,
        "gap": 8,
        "repeaterHeight": rep_h,
        "h": "hug",
        "template": row_template,
    }
    if isinstance(list_view.get("slots"), dict):
        searchable_list_node["slots"] = copy.deepcopy(list_view["slots"])
    if list_exclusion:
        searchable_list_node["baseWhere"] = list_exclusion["expr"]
        provenance["filterBindings"].append({
            "query": qname,
            "rule": list_exclusion["ruleId"],
            "rulePointer": list_exclusion["pointer"],
            "listId": f"workspace/{list_id}_list",
            "repeaterId": f"workspace/{rep_id}",
            "baseWhere": list_exclusion["expr"],
        })

    # Optional empty-state verification bar (only emitted when devMode or emptyProbe is explicitly requested)
    show_empty_probe = bool(spec.get("devMode") or product.get("devMode") or qdef.get("emptyProbe"))
    empty_text = qdef.get("emptyText", "暂无符合条件的记录")
    empty_state_bar = {
        "type": "box",
        "id": f"{list_view['id']}_empty_bar",
        "layout": "row",
        "w": list_w,
        "h": 44,
        "padding": [8, 8],
        "gap": 8,
        "align": "center",
        "fill": "$surface",
        "radius": 6,
        "children": [
            {
                "type": "label",
                "id": empty_banner_id,
                "w": list_w - 112,
                "h": 24,
                "fontSize": 12,
                "color": "$ink-2",
                "text": f"空态提示：{empty_text}",
            },
            {
                "type": "button",
                "id": f"{list_view['id']}_empty_probe_btn",
                "w": 84,
                "h": 26,
                "fontSize": 12,
                "variant": "secondary",
                "text": "验证空态",
                "onClick": [
                    {"type": "data-filter", "target": rep_id, "name": "search_category_filter", "where": f"=item.{em['key']} == '__NONE__'"},
                    {"type": "set-text", "target": empty_banner_id, "text": empty_text},
                ],
            },
        ],
    } if show_empty_probe else None

    # Build header action bar for list view
    nav_buttons = []
    for pv in panel_views:
        nav_buttons.append({
            "type": "button",
            "id": f"nav_to_{pv['id']}",
            "w": 88 if is_web else 72,
            "h": 30,
            "fontSize": 12,
            "variant": "primary" if pv["kind"] == "form" and pv == panel_views[-1] else "secondary",
            "text": pv.get("title", pv["id"])[:4],
            "onClick": [
                {"type": "set-panel-state", "target": panel_id, "state": pv["id"]},
                {"type": "set-text", "target": status_banner_id, "text": f"当前视图：{pv.get('title', pv['id'])}"},
            ],
        })

    btn_w_each = 96 if is_web else 80
    list_header = {
        "type": "box",
        "id": f"{list_view['id']}_header",
        "layout": "row",
        "w": list_w,
        "h": 36,
        "gap": 8,
        "align": "center",
        "children": [
            {
                "type": "label",
                "id": f"{list_view['id']}_title",
                "w": max(80, list_w - len(nav_buttons) * btn_w_each),
                "h": 28,
                "fontSize": 16,
                "fontWeight": 600,
                "text": list_view.get("title", "列表"),
            },
            *nav_buttons,
        ],
    }

    list_syms = [
        f"workspace/{list_id}",
        f"workspace/{list_id}_list",
        f"workspace/{list_id}_search",
        *([f"workspace/{empty_banner_id}"] if empty_state_bar else []),
    ]
    provenance["views"][list_view["id"]] = {
        "pointer": list_view["_pointer"],
        "kind": "list",
        "entity": ename,
        "query": qname,
        "symbols": list_syms,
    }
    for s_id in list_syms:
        provenance["symbolOrigins"][s_id] = {
            "view": list_view["id"],
            "entity": ename,
            "query": qname,
            "rule": rrule_id,
            "pointer": list_view["_pointer"],
        }

    # Build DynamicPanel states for detail and form views
    panel_states = []
    first_row = em["rows"][0]
    for pv in panel_views:
        vid = pv["id"]
        vkind = pv["kind"]
        vp = pv["_pointer"]
        v_syms = []
        if vkind == "detail":
            drule_id = pv.get("rule") or rrule_id
            drule_def = rules.get(drule_id) if drule_id else None
            status_prefix = (drule_def or {}).get("detailStatusPrefix", "")
            dfields = pv.get("displayFields") or list(em["modelFields"].keys())
            kv_rows = []
            for f in dfields:
                flabel = em["fieldLabels"].get(f, f)
                init_val = str(first_row.get(f, em["fieldDefaults"].get(f, "")))
                if f == em["statusField"] and status_prefix:
                    init_val = f"{status_prefix}{init_val}"
                wid = f"det_val_{f}"
                full_wid = f"workspace/{panel_id}/{vid}/{wid}"
                v_syms.append(full_wid)
                provenance["detailBindings"].append({
                    "view": vid,
                    "field": f,
                    "widgetId": full_wid,
                    "rule": drule_id,
                })
                provenance["symbolOrigins"][full_wid] = {
                    "view": vid,
                    "entity": ename,
                    "field": f,
                    "rule": drule_id,
                    "pointer": vp,
                }
                kv_rows.append({
                    "type": "box",
                    "id": f"det_row_{f}",
                    "layout": "row",
                    "w": panel_w - 32,
                    "h": 32,
                    "padding": [4, 8],
                    "gap": 8,
                    "align": "center",
                    "fill": "$surface",
                    "radius": 6,
                    "children": [
                        {
                            "type": "label",
                            "id": f"det_lbl_{f}",
                            "w": 88,
                            "h": 22,
                            "fontSize": 12,
                            "color": "$ink-2",
                            "text": flabel,
                        },
                        {
                            "type": "label",
                            "id": wid,
                            "w": panel_w - 144,
                            "h": 22,
                            "fontSize": 12,
                            "fontWeight": 600 if f in (em["key"], title_field, em["statusField"]) else 400,
                            "text": init_val,
                        },
                    ],
                })
            if detail_status_badge_id:
                v_syms.append(detail_status_badge_id)
                provenance["detailBindings"].append({
                    "view": vid,
                    "field": em["statusField"],
                    "widgetId": detail_status_badge_id,
                    "rule": drule_id,
                })
                provenance["symbolOrigins"][detail_status_badge_id] = {
                    "view": vid,
                    "entity": ename,
                    "field": em["statusField"],
                    "rule": drule_id,
                    "pointer": vp,
                }
            action_btns = []
            p_act = pv.get("primaryAction")
            if isinstance(p_act, dict) and p_act.get("navigateTo"):
                full_pbtn_id = f"workspace/{panel_id}/{vid}/{vid}_primary_btn"
                v_syms.append(full_pbtn_id)
                provenance["detailBindings"].append({
                    "view": vid,
                    "field": em["statusField"],
                    "widgetId": full_pbtn_id,
                    "rule": drule_id,
                })
                provenance["symbolOrigins"][full_pbtn_id] = {
                    "view": vid,
                    "entity": ename,
                    "field": em["statusField"],
                    "rule": drule_id,
                    "pointer": vp,
                }
                action_btns.append({
                    "type": "button",
                    "id": f"{vid}_primary_btn",
                    "w": 136,
                    "h": 34,
                    "fontSize": 14,
                    "variant": "primary",
                    "text": p_act.get("label", "下一步"),
                    "onClick": [
                        {"type": "set-panel-state", "target": panel_id, "state": p_act["navigateTo"]},
                        {"type": "set-text", "target": status_banner_id, "text": f"进入：{p_act.get('label', p_act['navigateTo'])}"},
                    ],
                })
            s_act = pv.get("secondaryAction")
            if isinstance(s_act, dict) and s_act.get("navigateTo"):
                action_btns.append({
                    "type": "button",
                    "id": f"{vid}_secondary_btn",
                    "w": 120,
                    "h": 34,
                    "fontSize": 14,
                    "variant": "secondary",
                    "text": s_act.get("label", "其他操作"),
                    "onClick": [
                        {"type": "set-panel-state", "target": panel_id, "state": s_act["navigateTo"]},
                    ],
                })
            state_root = {
                "type": "card",
                "id": f"{vid}_card",
                "layout": "column",
                "w": panel_w,
                "h": panel_h,
                "padding": [12, 16],
                "gap": 8,
                "fill": "$surface-2",
                "stroke": "$line",
                "radius": 8,
                "children": [
                    {
                        "type": "box",
                        "id": f"{vid}_hdr",
                        "layout": "row",
                        "w": panel_w - 32,
                        "h": 32,
                        "gap": 8,
                        "align": "center",
                        "children": [
                            {
                                "type": "label",
                                "id": f"{vid}_title",
                                "w": panel_w - 128,
                                "h": 26,
                                "fontSize": 16,
                                "fontWeight": 600,
                                "text": pv.get("title", "详情"),
                            },
                            {
                                "type": "badge",
                                "id": "det_status_badge",
                                "w": 88,
                                "h": 24,
                                "fontSize": 12,
                                "text": str(first_row.get(em["statusField"], "")),
                            },
                        ],
                    },
                    *kv_rows,
                    *(
                        [{
                            "type": "box",
                            "id": f"{vid}_actions",
                            "layout": "row",
                            "w": panel_w - 32,
                            "h": 36,
                            "gap": 12,
                            "align": "center",
                            "children": action_btns,
                        }]
                        if action_btns
                        else []
                    ),
                ],
            }
            panel_states.append({"id": vid, "root": state_root})
            provenance["views"][vid] = {
                "pointer": vp,
                "kind": "detail",
                "entity": ename,
                "rule": drule_id,
                "symbols": v_syms,
            }
        elif vkind == "form":
            op_name = pv.get("operation")
            if op_name not in operations:
                fail_fn("E_REFERENCE", _ptr(vp, "operation"), f"Form view '{vid}' requires a valid operation")
            op_def = operations[op_name]
            op_rules = list(op_def.get("rules") or ([] if not op_def.get("rule") else [op_def["rule"]]))
            form_fields = op_def.get("fields") or [f for f in em["modelFields"] if f != em["key"]]

            # Collect active required fields from all rules bound to this operation
            req_checks = []
            for rn in op_rules:
                req_checks.extend(_active_required_fields(rn, rules[rn], raw_entity))
            req_by_field = {r["field"]: r for r in req_checks}

            field_nodes = []
            input_ids_by_field = {}
            for f in form_fields:
                flabel = em["fieldLabels"].get(f, f)
                is_req = f in req_by_field
                label_text = f"{flabel} *" if is_req else f"{flabel}（选填）"
                inp_id = f"{vid}_inp_{f}"
                lbl_id = f"{vid}_lbl_{f}"
                input_ids_by_field[f] = inp_id
                full_inp_id = f"workspace/{panel_id}/{vid}/{inp_id}"
                full_lbl_id = f"workspace/{panel_id}/{vid}/{lbl_id}"
                v_syms.extend([full_lbl_id, full_inp_id])
                for s_id in (full_lbl_id, full_inp_id):
                    provenance["symbolOrigins"][s_id] = {
                        "view": vid,
                        "entity": ename,
                        "operation": op_name,
                        "field": f,
                        "rules": op_rules,
                        "required": is_req,
                        "pointer": vp,
                    }
                default_v = "" if is_req else str(em["fieldDefaults"].get(f, ""))
                if f in em["fieldEnums"] and not is_req and not default_v:
                    default_v = str(em["fieldEnums"][f][0])
                field_nodes.append({
                    "type": "box",
                    "id": f"{vid}_field_{f}",
                    "layout": "row",
                    "w": panel_w - 32,
                    "h": 36,
                    "gap": 8,
                    "align": "center",
                    "children": [
                        {
                            "type": "label",
                            "id": lbl_id,
                            "w": 104,
                            "h": 24,
                            "fontSize": 12,
                            "text": label_text,
                        },
                        {
                            "type": "input",
                            "id": inp_id,
                            "w": panel_w - 144,
                            "h": 32,
                            "value": default_v,
                        },
                    ],
                })

            feedback_id = f"{vid}_feedback"
            full_fb_id = f"workspace/{panel_id}/{vid}/{feedback_id}"
            v_syms.append(full_fb_id)
            provenance["symbolOrigins"][full_fb_id] = {
                "view": vid,
                "entity": ename,
                "operation": op_name,
                "rules": op_rules,
                "pointer": vp,
            }

            # Build success actions (create or update)
            success_actions = []
            if op_def["kind"] == "create":
                row_spec = {}
                op_defaults = op_def.get("defaults") or {}
                for fname, ftype in em["modelFields"].items():
                    if fname == em["key"]:
                        row_spec[fname] = f"=${em['nextIdVariable']}"
                    elif fname in input_ids_by_field:
                        expr_str = f"=@{input_ids_by_field[fname]}"
                        row_spec[fname] = f"=number(@{input_ids_by_field[fname]})" if ftype == "number" else expr_str
                    elif fname in op_defaults:
                        row_spec[fname] = op_defaults[fname]
                    else:
                        row_spec[fname] = em["fieldDefaults"].get(fname, "")
                success_actions.append({
                    "type": "data-add",
                    "target": rep_id,
                    "rows": [row_spec],
                })
                # Sync selection, field variables, and detail widgets to newly created item before clearing inputs
                success_actions.append({"type": "set-variable", "variable": em["selectionVariable"], "value": f"=${em['nextIdVariable']}"})
                for fname, vname in em["fieldVariables"].items():
                    if fname in row_spec:
                        success_actions.append({"type": "set-variable", "variable": vname, "value": row_spec[fname]})
                for fname, wid in detail_field_widget_ids.items():
                    val_expr = row_spec[fname]
                    success_actions.append({"type": "set-text", "target": wid, "text": str(val_expr)})
                if detail_status_badge_id:
                    success_actions.append({"type": "set-text", "target": detail_status_badge_id, "text": str(row_spec.get(em["statusField"], ""))})
                success_actions.append({"type": "set-variable", "variable": em["nextIdVariable"], "value": f"=${em['nextIdVariable']} + '-N'"})
                for inp_id in input_ids_by_field.values():
                    success_actions.append({"type": "set-text", "target": inp_id, "text": ""})
            elif op_def["kind"] == "update":
                update_set = dict(op_def.get("set") or {})
                for fname, inp_id in input_ids_by_field.items():
                    ftype = em["modelFields"][fname]
                    update_set[fname] = f"=number(@{inp_id})" if ftype == "number" else f"=@{inp_id}"
                status_trans = None
                for rn in op_rules:
                    st = _rule_status_transition(rn, rules[rn], raw_entity)
                    if st:
                        status_trans = st
                        update_set[st["field"]] = st["to"]
                where_expr = op_def.get("where") or f"=item.{em['key']} == ${em['selectionVariable']}"
                success_actions.append({
                    "type": "data-update",
                    "target": rep_id,
                    "where": where_expr,
                    "set": update_set,
                })
                # Check if any rule on this operation or the list query requires excluding claimed items from the list
                active_excl = None
                for rn in op_rules:
                    ex = _rule_list_exclusion(rn, rules[rn], raw_entity)
                    if ex:
                        active_excl = ex
                if not active_excl and list_exclusion:
                    active_excl = list_exclusion
                if active_excl:
                    success_actions.append({
                        "type": "data-filter",
                        "target": rep_id,
                        "name": "search_category_filter",
                        "where": active_excl["expr"],
                    })
                    provenance["filterBindings"].append({
                        "operation": op_name,
                        "rule": active_excl["ruleId"],
                        "rulePointer": active_excl["pointer"],
                        "repeaterId": f"workspace/{rep_id}",
                        "filterWhere": active_excl["expr"],
                    })
                # Sync detail view widgets & variables
                for fname, vexpr in update_set.items():
                    if fname in em["fieldVariables"]:
                        success_actions.append({"type": "set-variable", "variable": em["fieldVariables"][fname], "value": vexpr})
                    if fname in detail_field_widget_ids:
                        drule_def = rules.get(op_rules[0]) if op_rules else None
                        status_prefix = (drule_def or {}).get("detailStatusPrefix", "")
                        if fname == em["statusField"] and status_prefix:
                            success_actions.append({"type": "set-text", "target": detail_field_widget_ids[fname], "text": f"{status_prefix}{vexpr}"})
                        else:
                            success_actions.append({"type": "set-text", "target": detail_field_widget_ids[fname], "text": str(vexpr)})
                if status_trans:
                    st_rule = rules.get(status_trans["ruleId"]) or {}
                    claimed_badge_txt = st_rule.get("detailClaimedText") or status_trans["to"]
                    status_prefix = st_rule.get("detailStatusPrefix", "")
                    if em["statusField"] in detail_field_widget_ids:
                        success_actions.append({"type": "set-text", "target": detail_field_widget_ids[em["statusField"]], "text": f"{status_prefix}{claimed_badge_txt}"})
                    if detail_status_badge_id:
                        success_actions.append({"type": "set-text", "target": detail_status_badge_id, "text": claimed_badge_txt})
                    if detail_primary_btn_id and st_rule.get("excludeClaimedFromList"):
                        success_actions.append({"type": "set-text", "target": detail_primary_btn_id, "text": claimed_badge_txt})

            success_msg = op_def.get("successText", "操作已提交")
            success_actions.append({"type": "set-text", "target": feedback_id, "text": success_msg})
            success_actions.append({"type": "set-text", "target": status_banner_id, "text": success_msg})
            nav_to = op_def.get("navigateTo") or pv.get("backTo")
            if nav_to and nav_to in view_by_id and view_by_id[nav_to]["kind"] != "list":
                success_actions.append({"type": "set-panel-state", "target": panel_id, "state": nav_to})
            elif nav_to == list_view["id"] and primary_detail:
                success_actions.append({"type": "set-panel-state", "target": panel_id, "state": primary_detail["id"]})

            # Assemble conditional cases from required field checks
            submit_id = f"{vid}_submit_btn"
            full_sub_id = f"workspace/{panel_id}/{vid}/{submit_id}"
            v_syms.append(full_sub_id)
            provenance["symbolOrigins"][full_sub_id] = {
                "view": vid,
                "entity": ename,
                "operation": op_name,
                "rules": op_rules,
                "pointer": vp,
            }
            if req_checks:
                cases = []
                for idx, rchk in enumerate(req_checks):
                    inp_id = input_ids_by_field.get(rchk["field"])
                    if not inp_id:
                        continue
                    cases.append({
                        "when": f"=length(@{inp_id}) == 0",
                        "actions": [
                            {"type": "set-text", "target": feedback_id, "text": rchk["message"]},
                            {"type": "set-text", "target": status_banner_id, "text": rchk["message"]},
                        ],
                    })
                    provenance["validationCases"].append({
                        "view": vid,
                        "operation": op_name,
                        "rule": rchk["ruleId"],
                        "rulePointer": rchk["pointer"],
                        "field": rchk["field"],
                        "inputId": f"workspace/{panel_id}/{vid}/{inp_id}",
                        "submitButtonId": full_sub_id,
                        "message": rchk["message"],
                        "caseIndex": idx,
                    })
                cases.append({"else": True, "actions": success_actions})
                submit_event = {"cases": cases}
            else:
                submit_event = success_actions

            back_target = pv.get("backTo")
            form_btns = [
                {
                    "type": "button",
                    "id": submit_id,
                    "w": 136,
                    "h": 34,
                    "fontSize": 14,
                    "variant": "primary",
                    "text": pv.get("submitText", "提交"),
                    "on": {"click": submit_event},
                }
            ]
            if back_target and back_target in view_by_id and view_by_id[back_target]["kind"] != "list":
                form_btns.append({
                    "type": "button",
                    "id": f"{vid}_back_btn",
                    "w": 96,
                    "h": 34,
                    "fontSize": 14,
                    "variant": "secondary",
                    "text": "返回",
                    "onClick": [
                        {"type": "set-panel-state", "target": panel_id, "state": back_target},
                    ],
                })

            state_root = {
                "type": "card",
                "id": f"{vid}_card",
                "layout": "column",
                "w": panel_w,
                "h": panel_h,
                "padding": [12, 16],
                "gap": 8,
                "fill": "$surface-2",
                "stroke": "$line",
                "radius": 8,
                "children": [
                    {
                        "type": "label",
                        "id": f"{vid}_title",
                        "w": panel_w - 32,
                        "h": 26,
                        "fontSize": 16,
                        "fontWeight": 600,
                        "text": pv.get("title", "表单"),
                    },
                    *field_nodes,
                    {
                        "type": "label",
                        "id": feedback_id,
                        "w": panel_w - 32,
                        "h": 24,
                        "fontSize": 12,
                        "color": "$danger",
                        "text": "请填写必填项后提交" if req_checks else "可直接提交",
                    },
                    {
                        "type": "box",
                        "id": f"{vid}_btn_row",
                        "layout": "row",
                        "w": panel_w - 32,
                        "h": 36,
                        "gap": 12,
                        "align": "center",
                        "children": form_btns,
                    },
                ],
            }
            panel_states.append({"id": vid, "root": state_root})
            provenance["views"][vid] = {
                "pointer": vp,
                "kind": "form",
                "entity": ename,
                "operation": op_name,
                "rules": op_rules,
                "symbols": v_syms,
            }

    left_pane = {
        "type": "card",
        "id": f"{list_view['id']}_pane",
        "layout": "column",
        "w": list_w + 32 if is_web else 343,
        "h": 448 if is_web else 392,
        "padding": [12, 16] if is_web else [8, 0],
        "gap": 8,
        "fill": "$surface-2",
        "stroke": "$line",
        "radius": 8,
        "children": [
            list_header,
            {
                "type": "label",
                "id": status_banner_id,
                "w": list_w,
                "h": 20,
                "fontSize": 12,
                "color": "$brand",
                "text": f"当前选中：{first_row.get(title_field, '')}",
            },
            searchable_list_node,
            *([empty_state_bar] if empty_state_bar else []),
        ],
    }

    right_panel = {
        "type": "dynamic-panel",
        "id": panel_id,
        "w": panel_w,
        "h": panel_h,
        "states": panel_states,
    }

    page_load_actions = []
    if list_exclusion:
        page_load_actions.append({
            "type": "data-filter",
            "target": rep_id,
            "name": "search_category_filter",
            "where": list_exclusion["expr"],
        })

    page_obj = {
        "id": "workspace",
        "name": spec.get("name", list_view.get("title", "Workspace")),
        "canvas": canvas,
        "root": {
            "type": "box",
            "id": "workspace_root",
            "layout": "row" if is_web else "column",
            "w": canvas["w"],
            "h": canvas["h"],
            "padding": [16, 16] if is_web else [12, 16],
            "gap": 16 if is_web else 12,
            "children": [left_pane, right_panel],
        },
    }
    if page_load_actions:
        page_obj["on"] = {"load": page_load_actions}

    return [page_obj]


def compute_product_impact(before_spec, after_spec, before_ir, after_ir, operations):
    """Compute structured product-level impact when patching a specification with `product`."""
    before_prov = before_ir.get("productProvenance")
    after_prov = after_ir.get("productProvenance")
    if not before_prov and not after_prov:
        return None

    prov = after_prov or before_prov
    affected_rules = set()
    affected_entities = set()
    affected_queries = set()
    affected_operations = set()
    affected_views = set()

    for op in operations or []:
        path = str(op.get("path", ""))
        if path.startswith("/product/rules/"):
            rname = path.split("/")[3]
            affected_rules.add(rname)
        elif path.startswith("/product/entities/"):
            ename = path.split("/")[3]
            affected_entities.add(ename)
        elif path.startswith("/product/queries/"):
            qname = path.split("/")[3]
            affected_queries.add(qname)
        elif path.startswith("/product/operations/"):
            oname = path.split("/")[3]
            affected_operations.add(oname)
        elif path.startswith("/product/views/"):
            affected_views.add(path.split("/")[3])

    # Propagate rule changes to dependent entities, queries, operations, views, validations, filters, and detail widgets
    for rname in list(affected_rules):
        rinfo = prov.get("rules", {}).get(rname) or (before_prov or {}).get("rules", {}).get(rname) or {}
        if rinfo.get("entity"):
            affected_entities.add(rinfo["entity"])
        for qname, qinfo in prov.get("queries", {}).items():
            if qinfo.get("respectRule") == rname:
                affected_queries.add(qname)
        for oname, oinfo in prov.get("operations", {}).items():
            if rname in (oinfo.get("rules") or []):
                affected_operations.add(oname)
        for vname, vinfo in prov.get("views", {}).items():
            if vinfo.get("rule") == rname or rname in (vinfo.get("rules") or []):
                affected_views.add(vname)

    for qname in list(affected_queries):
        for vname, vinfo in prov.get("views", {}).items():
            if vinfo.get("query") == qname:
                affected_views.add(vname)

    for oname in list(affected_operations):
        for vname, vinfo in prov.get("views", {}).items():
            if vinfo.get("operation") == oname:
                affected_views.add(vname)

    before_val = (before_prov or {}).get("validationCases", [])
    after_val = (after_prov or {}).get("validationCases", [])
    before_filt = (before_prov or {}).get("filterBindings", [])
    after_filt = (after_prov or {}).get("filterBindings", [])

    affected_validations = [
        vc for vc in after_val
        if vc.get("rule") in affected_rules or vc.get("operation") in affected_operations or vc not in before_val
    ]
    affected_filters = [
        fb for fb in after_filt
        if fb.get("rule") in affected_rules or fb.get("query") in affected_queries or fb.get("operation") in affected_operations or fb not in before_filt
    ]
    affected_details = [
        db for db in (after_prov or {}).get("detailBindings", [])
        if db.get("rule") in affected_rules or db.get("view") in affected_views
    ]

    return {
        "affectedRules": sorted(affected_rules),
        "affectedEntities": sorted(affected_entities),
        "affectedQueries": sorted(affected_queries),
        "affectedOperations": sorted(affected_operations),
        "affectedViews": sorted(affected_views),
        "validationCasesBefore": len(before_val),
        "validationCasesAfter": len(after_val),
        "affectedValidationCases": affected_validations,
        "filterBindingsBefore": len(before_filt),
        "filterBindingsAfter": len(after_filt),
        "affectedFilters": affected_filters,
        "affectedDetailBindings": affected_details,
    }


def synthesize_product_spec(descriptor):
    """Build a schema-valid RP/1 unified `product` specification from a declarative entity/rule descriptor."""
    if isinstance(descriptor, dict) and ("entities" in descriptor or "product" in descriptor):
        prod = descriptor.get("product", descriptor)
        return {
            "$schema": "../../references/rp-language.schema.json",
            "language": "rp/1",
            "target": 9,
            "name": descriptor.get("name", "RP/1 业务应用"),
            "domain": descriptor.get("domain", "web"),
            "theme": descriptor.get("theme", "enterprise-light"),
            "strictAudit": True,
            "product": copy.deepcopy(prod),
        }
    return get_domain_template(descriptor)


def get_domain_template(requirement):
    """Return a built-in domain preset template by domain key or preset descriptor."""
    if isinstance(requirement, dict):
        text = str(requirement.get("domainKey") or requirement.get("template") or requirement.get("prompt") or requirement.get("requirement") or "")
        explicit_require_contact = requirement.get("requireContact")
        explicit_exclude = requirement.get("excludeClaimedFromList")
    else:
        text = str(requirement or "")
        explicit_require_contact = None
        explicit_exclude = None

    require_contact = bool(explicit_require_contact) if explicit_require_contact is not None else any(
        kw in text for kw in ("联系方式必填", "手机号必填", "值班电话必填", "电话必填", "必填联系方式")
    )
    exclude_claimed = bool(explicit_exclude) if explicit_exclude is not None else any(
        kw in text for kw in ("不再出现在", "移出待", "列表仅保留", "过滤已", "不显示已")
    )

    if any(k in text for k in ("设备", "借用", "借还", "仪器", "equipment")):
        target_status = "已借出" if exclude_claimed else "借用待审"
        return {
            "$schema": "../../references/rp-language.schema.json",
            "language": "rp/1",
            "target": 9,
            "name": "实验室设备借用台",
            "domain": "web",
            "theme": "enterprise-light",
            "strictAudit": True,
            "product": {
                "entities": {
                    "EquipmentLoan": {
                        "key": "id",
                        "statusField": "status",
                        "selectionVariable": "selected_eq_id",
                        "nextIdVariable": "next_eq_id",
                        "nextIdDefault": "EQ-205",
                        "fields": {
                            "id": {"type": "text", "label": "设备编号"},
                            "title": {"type": "text", "label": "设备名称", "required": True},
                            "category": {"type": "text", "label": "设备分类", "default": "仪器", "enum": ["仪器", "套件", "光学"]},
                            "location": {"type": "text", "label": "存放实验室", "required": True},
                            "status": {"type": "text", "label": "借用状态", "default": "在库可借"},
                            "claimant": {"type": "text", "label": "借用人", "default": "未借出"},
                            "contact": {"type": "text", "label": "联系方式", "default": "-"},
                            "note": {"type": "text", "label": "配置说明", "default": "附件齐全"},
                        },
                        "rows": [
                            {"id": "EQ-201", "title": "数字示波器 DSOX1204G", "category": "仪器", "location": "电子楼 B204", "status": "在库可借", "claimant": "未借出", "contact": "-", "note": "含双通道探头与电源线"},
                            {"id": "EQ-202", "title": "逻辑分析仪 Saleae Pro", "category": "仪器", "location": "嵌入式实验室 A108", "status": "在库可借", "claimant": "未借出", "contact": "-", "note": "16 通道高速采样线束齐全"},
                            {"id": "EQ-203", "title": "无人机飞控开发套件", "category": "套件", "location": "创客空间 C301", "status": "在库可借", "claimant": "未借出", "contact": "-", "note": "含激光雷达模块与备用电池"},
                            {"id": "EQ-204", "title": "红外热成像分析仪", "category": "光学", "location": "光电实验室 D402", "status": "在库可借", "claimant": "未借出", "contact": "-", "note": "含校准证书与便携保护箱"},
                        ],
                    }
                },
                "rules": {
                    "register_policy": {
                        "entity": "EquipmentLoan",
                        "operation": "register_equipment",
                        "description": "设备入库必填规则：必须填写设备名称与存放实验室。",
                        "requiredFields": [
                            {"field": "title", "required": True, "message": "请填写设备名称"},
                            {"field": "location", "required": True, "message": "请填写存放实验室"},
                        ],
                    },
                    "borrow_policy": {
                        "entity": "EquipmentLoan",
                        "operation": "borrow_equipment",
                        "description": "借用规则：控制借用人姓名、联系方式必填及借出后列表过滤策略。",
                        "requiredFields": [
                            {"field": "claimant", "required": True, "message": "请填写借用人姓名"}
                        ],
                        "requireContact": require_contact,
                        "contactField": "contact",
                        "contactRequiredMessage": "请填写借用人联系方式",
                        "statusTransition": {"field": "status", "from": "在库可借", "to": target_status},
                        "excludeClaimedFromList": exclude_claimed,
                        "detailClaimedText": target_status,
                    },
                },
                "queries": {
                    "available_equipment": {
                        "entity": "EquipmentLoan",
                        "searchField": "title",
                        "filterField": "category",
                        "filters": [{"label": "全部", "value": "全部", "all": True}, "仪器", "套件", "光学"],
                        "respectRule": "borrow_policy",
                        "emptyText": "暂无匹配的实验设备",
                    }
                },
                "operations": {
                    "register_equipment": {
                        "kind": "create",
                        "entity": "EquipmentLoan",
                        "rule": "register_policy",
                        "fields": ["title", "category", "location", "note"],
                        "defaults": {"status": "在库可借", "claimant": "未借出", "contact": "-"},
                        "successText": "入库成功，已加入设备台账",
                        "navigateTo": "equipment_detail",
                    },
                    "borrow_equipment": {
                        "kind": "update",
                        "entity": "EquipmentLoan",
                        "rule": "borrow_policy",
                        "fields": ["claimant", "contact", "note"],
                        "successText": "借用提交成功",
                        "navigateTo": "equipment_detail",
                    },
                },
                "views": [
                    {"id": "equipment_list", "title": "实验设备列表", "kind": "list", "entity": "EquipmentLoan", "query": "available_equipment", "cardFields": {"title": "title", "subtitle": "location", "badge": "status"}},
                    {"id": "equipment_detail", "title": "设备详情", "kind": "detail", "entity": "EquipmentLoan", "rule": "borrow_policy", "displayFields": ["id", "title", "category", "location", "status", "claimant", "contact", "note"], "primaryAction": {"label": "申请借用", "navigateTo": "borrow_form"}, "secondaryAction": {"label": "设备入库", "navigateTo": "register_form"}},
                    {"id": "register_form", "title": "设备入库", "kind": "form", "entity": "EquipmentLoan", "operation": "register_equipment", "submitText": "确认入库", "backTo": "equipment_detail"},
                    {"id": "borrow_form", "title": "借用登记", "kind": "form", "entity": "EquipmentLoan", "operation": "borrow_equipment", "submitText": "确认借用", "backTo": "equipment_detail"},
                ],
            },
        }

    if any(k in text for k in ("维修", "工单", "报修", "故障", "workorder")):
        target_status = "已完工" if exclude_claimed else "维修处理中"
        return {
            "$schema": "../../references/rp-language.schema.json",
            "language": "rp/1",
            "target": 9,
            "name": "园区设施维修工单台",
            "domain": "web",
            "theme": "enterprise-light",
            "strictAudit": True,
            "product": {
                "entities": {
                    "RepairWorkorder": {
                        "key": "id",
                        "statusField": "status",
                        "selectionVariable": "selected_wo_id",
                        "nextIdVariable": "next_wo_id",
                        "nextIdDefault": "WO-305",
                        "fields": {
                            "id": {"type": "text", "label": "工单编号"},
                            "title": {"type": "text", "label": "故障标题", "required": True},
                            "category": {"type": "text", "label": "故障类型", "default": "空调", "enum": ["空调", "照明", "门禁"]},
                            "location": {"type": "text", "label": "报修点位", "required": True},
                            "status": {"type": "text", "label": "工单状态", "default": "待派单"},
                            "claimant": {"type": "text", "label": "接单工程师", "default": "未指派"},
                            "contact": {"type": "text", "label": "值班电话", "default": "-"},
                            "note": {"type": "text", "label": "故障现象", "default": "待现场排查"},
                        },
                        "rows": [
                            {"id": "WO-301", "title": "三楼会议室新风主机异响", "category": "空调", "location": "研发楼 3F-302", "status": "待派单", "claimant": "未指派", "contact": "-", "note": "出风口伴随高频震动声，制冷正常"},
                            {"id": "WO-302", "title": "地下车库 B 区应急照明故障", "category": "照明", "location": "地下车库 B2 通道", "status": "待派单", "claimant": "未指派", "contact": "-", "note": "回路模块跳闸后无法自动复位"},
                            {"id": "WO-303", "title": "北门速通闸机刷卡无响应", "category": "门禁", "location": "园区北门大厅", "status": "待派单", "claimant": "未指派", "contact": "-", "note": "读卡器指示灯闪烁但闸翼不开启"},
                            {"id": "WO-304", "title": "二楼茶水间直饮机漏水报警", "category": "照明", "location": "行政楼 2F 茶水间", "status": "待派单", "claimant": "未指派", "contact": "-", "note": "底座水浸传感器触发断电保护"},
                        ],
                    }
                },
                "rules": {
                    "report_policy": {
                        "entity": "RepairWorkorder",
                        "operation": "report_workorder",
                        "description": "设施报修必填规则：必须填写故障标题与报修点位。",
                        "requiredFields": [
                            {"field": "title", "required": True, "message": "请填写故障标题"},
                            {"field": "location", "required": True, "message": "请填写报修点位"},
                        ],
                    },
                    "dispatch_policy": {
                        "entity": "RepairWorkorder",
                        "operation": "dispatch_workorder",
                        "description": "派单规则：控制接单工程师、值班电话必填及完工列表过滤策略。",
                        "requiredFields": [
                            {"field": "claimant", "required": True, "message": "请填写接单工程师姓名"}
                        ],
                        "requireContact": require_contact,
                        "contactField": "contact",
                        "contactRequiredMessage": "请填写工程师值班电话",
                        "statusTransition": {"field": "status", "from": "待派单", "to": target_status},
                        "excludeClaimedFromList": exclude_claimed,
                        "detailClaimedText": target_status,
                    },
                },
                "queries": {
                    "active_workorders": {
                        "entity": "RepairWorkorder",
                        "searchField": "title",
                        "filterField": "category",
                        "filters": [{"label": "全部", "value": "全部", "all": True}, "空调", "照明", "门禁"],
                        "respectRule": "dispatch_policy",
                        "emptyText": "暂无匹配的维修工单",
                    }
                },
                "operations": {
                    "report_workorder": {
                        "kind": "create",
                        "entity": "RepairWorkorder",
                        "rule": "report_policy",
                        "fields": ["title", "category", "location", "note"],
                        "defaults": {"status": "待派单", "claimant": "未指派", "contact": "-"},
                        "successText": "报修提交成功，已生成待派单工单",
                        "navigateTo": "workorder_detail",
                    },
                    "dispatch_workorder": {
                        "kind": "update",
                        "entity": "RepairWorkorder",
                        "rule": "dispatch_policy",
                        "fields": ["claimant", "contact", "note"],
                        "successText": "派单接单成功",
                        "navigateTo": "workorder_detail",
                    },
                },
                "views": [
                    {"id": "workorder_list", "title": "维修工单列表", "kind": "list", "entity": "RepairWorkorder", "query": "active_workorders", "cardFields": {"title": "title", "subtitle": "location", "badge": "status"}},
                    {"id": "workorder_detail", "title": "工单详情", "kind": "detail", "entity": "RepairWorkorder", "rule": "dispatch_policy", "displayFields": ["id", "title", "category", "location", "status", "claimant", "contact", "note"], "primaryAction": {"label": "派单接单", "navigateTo": "dispatch_form"}, "secondaryAction": {"label": "发起报修", "navigateTo": "report_form"}},
                    {"id": "report_form", "title": "故障报修", "kind": "form", "entity": "RepairWorkorder", "operation": "report_workorder", "submitText": "提交报修", "backTo": "workorder_detail"},
                    {"id": "dispatch_form", "title": "指派工程师", "kind": "form", "entity": "RepairWorkorder", "operation": "dispatch_workorder", "submitText": "确认派单", "backTo": "workorder_detail"},
                ],
            },
        }

    if any(k in text for k in ("访客", "通行", "来访", "visitor")):
        target_status = "已签离" if exclude_claimed else "已核验入园"
        return {
            "$schema": "../../references/rp-language.schema.json",
            "language": "rp/1",
            "target": 9,
            "name": "企业访客预约核验台",
            "domain": "web",
            "theme": "enterprise-light",
            "strictAudit": True,
            "product": {
                "entities": {
                    "VisitorPass": {
                        "key": "id",
                        "statusField": "status",
                        "selectionVariable": "selected_vp_id",
                        "nextIdVariable": "next_vp_id",
                        "nextIdDefault": "VP-405",
                        "fields": {
                            "id": {"type": "text", "label": "预约单号"},
                            "title": {"type": "text", "label": "来访事由", "required": True},
                            "category": {"type": "text", "label": "来访类型", "default": "商务", "enum": ["商务", "面试", "施工"]},
                            "location": {"type": "text", "label": "拜访区域", "required": True},
                            "status": {"type": "text", "label": "通行状态", "default": "待核验"},
                            "claimant": {"type": "text", "label": "接待人", "default": "待确认"},
                            "contact": {"type": "text", "label": "访客电话", "default": "-"},
                            "note": {"type": "text", "label": "随行备注", "default": "无随行车辆"},
                        },
                        "rows": [
                            {"id": "VP-401", "title": "季度供应链合同洽谈", "category": "商务", "location": "A 座 8F 洽谈室", "status": "待核验", "claimant": "待确认", "contact": "-", "note": "携带样品箱 1 件"},
                            {"id": "VP-402", "title": "前端架构师现场复试", "category": "面试", "location": "B 座 3F 面试间", "status": "待核验", "claimant": "待确认", "contact": "-", "note": "需临时访客 Wi-Fi"},
                            {"id": "VP-403", "title": "机房精密空调例行巡检", "category": "施工", "location": "数据中心 B1", "status": "待核验", "claimant": "待确认", "contact": "-", "note": "含特种作业证核查"},
                            {"id": "VP-404", "title": "年度财务审计资料交接", "category": "商务", "location": "A 座 12F 财务部", "status": "待核验", "claimant": "待确认", "contact": "-", "note": "同行 2 人"},
                        ],
                    }
                },
                "rules": {
                    "invite_policy": {
                        "entity": "VisitorPass",
                        "operation": "create_invite",
                        "description": "访客预约必填规则：必须填写来访事由与拜访区域。",
                        "requiredFields": [
                            {"field": "title", "required": True, "message": "请填写来访事由"},
                            {"field": "location", "required": True, "message": "请填写拜访区域"},
                        ],
                    },
                    "checkin_policy": {
                        "entity": "VisitorPass",
                        "operation": "checkin_visitor",
                        "description": "访客核验规则：控制接待人、访客电话必填及核验后列表过滤策略。",
                        "requiredFields": [
                            {"field": "claimant", "required": True, "message": "请填写接待人姓名"}
                        ],
                        "requireContact": require_contact,
                        "contactField": "contact",
                        "contactRequiredMessage": "请填写访客联系电话",
                        "statusTransition": {"field": "status", "from": "待核验", "to": target_status},
                        "excludeClaimedFromList": exclude_claimed,
                        "detailClaimedText": target_status,
                    },
                },
                "queries": {
                    "pending_visitors": {
                        "entity": "VisitorPass",
                        "searchField": "title",
                        "filterField": "category",
                        "filters": [{"label": "全部", "value": "全部", "all": True}, "商务", "面试", "施工"],
                        "respectRule": "checkin_policy",
                        "emptyText": "暂无匹配的访客预约记录",
                    }
                },
                "operations": {
                    "create_invite": {
                        "kind": "create",
                        "entity": "VisitorPass",
                        "rule": "invite_policy",
                        "fields": ["title", "category", "location", "note"],
                        "defaults": {"status": "待核验", "claimant": "待确认", "contact": "-"},
                        "successText": "预约登记成功，已加入待核验列表",
                        "navigateTo": "visitor_detail",
                    },
                    "checkin_visitor": {
                        "kind": "update",
                        "entity": "VisitorPass",
                        "rule": "checkin_policy",
                        "fields": ["claimant", "contact", "note"],
                        "successText": "访客核验提交成功",
                        "navigateTo": "visitor_detail",
                    },
                },
                "views": [
                    {"id": "visitor_list", "title": "访客预约列表", "kind": "list", "entity": "VisitorPass", "query": "pending_visitors", "cardFields": {"title": "title", "subtitle": "location", "badge": "status"}},
                    {"id": "visitor_detail", "title": "访客预约详情", "kind": "detail", "entity": "VisitorPass", "rule": "checkin_policy", "displayFields": ["id", "title", "category", "location", "status", "claimant", "contact", "note"], "primaryAction": {"label": "核验登记", "navigateTo": "checkin_form"}, "secondaryAction": {"label": "新增预约", "navigateTo": "invite_form"}},
                    {"id": "invite_form", "title": "新增访客预约", "kind": "form", "entity": "VisitorPass", "operation": "create_invite", "submitText": "确认预约", "backTo": "visitor_detail"},
                    {"id": "checkin_form", "title": "访客到访核验", "kind": "form", "entity": "VisitorPass", "operation": "checkin_visitor", "submitText": "确认核验", "backTo": "visitor_detail"},
                ],
            },
        }

    if any(k in text for k in ("讲座", "活动", "报名", "课程", "event")):
        target_status = "已核销" if exclude_claimed else "已报名待签到"
        return {
            "$schema": "../../references/rp-language.schema.json",
            "language": "rp/1",
            "target": 9,
            "name": "学术讲座报名签到台",
            "domain": "web",
            "theme": "enterprise-light",
            "strictAudit": True,
            "product": {
                "entities": {
                    "EventSeat": {
                        "key": "id",
                        "statusField": "status",
                        "selectionVariable": "selected_ev_id",
                        "nextIdVariable": "next_ev_id",
                        "nextIdDefault": "EV-505",
                        "fields": {
                            "id": {"type": "text", "label": "场次编号"},
                            "title": {"type": "text", "label": "讲座主题", "required": True},
                            "category": {"type": "text", "label": "学科专题", "default": "人工智能", "enum": ["人工智能", "系统工程", "人机交互"]},
                            "location": {"type": "text", "label": "举办报告厅", "required": True},
                            "status": {"type": "text", "label": "名额状态", "default": "开放报名"},
                            "claimant": {"type": "text", "label": "报名人", "default": "虚位以待"},
                            "contact": {"type": "text", "label": "联系邮箱/手机", "default": "-"},
                            "note": {"type": "text", "label": "场次说明", "default": "含学术学分认证"},
                        },
                        "rows": [
                            {"id": "EV-501", "title": "大模型推理形式化验证前沿", "category": "人工智能", "location": "逸夫楼一阶报告厅", "status": "开放报名", "claimant": "虚位以待", "contact": "-", "note": "主讲：计算机系特聘教授"},
                            {"id": "EV-502", "title": "高可靠分布式存储系统实践", "category": "系统工程", "location": "信息楼 402 会议室", "status": "开放报名", "claimant": "虚位以待", "contact": "-", "note": "含现场源码架构拆解"},
                            {"id": "EV-503", "title": "智能设计工具与意图编译工作坊", "category": "人机交互", "location": "设计学院未来剧场", "status": "开放报名", "claimant": "虚位以待", "contact": "-", "note": "请自带笔记本电脑参与实操"},
                            {"id": "EV-504", "title": "端侧多模态推理加速技术剖析", "category": "人工智能", "location": "科研楼 B105", "status": "开放报名", "claimant": "虚位以待", "contact": "-", "note": "提供讲义下载链接"},
                        ],
                    }
                },
                "rules": {
                    "publish_policy": {
                        "entity": "EventSeat",
                        "operation": "publish_event",
                        "description": "发布讲座必填规则：必须填写讲座主题与举办报告厅。",
                        "requiredFields": [
                            {"field": "title", "required": True, "message": "请填写讲座主题"},
                            {"field": "location", "required": True, "message": "请填写举办报告厅"},
                        ],
                    },
                    "signup_policy": {
                        "entity": "EventSeat",
                        "operation": "signup_event",
                        "description": "报名规则：控制报名人姓名、联系方式必填及核销后列表过滤策略。",
                        "requiredFields": [
                            {"field": "claimant", "required": True, "message": "请填写报名人姓名"}
                        ],
                        "requireContact": require_contact,
                        "contactField": "contact",
                        "contactRequiredMessage": "请填写报名人联系方式",
                        "statusTransition": {"field": "status", "from": "开放报名", "to": target_status},
                        "excludeClaimedFromList": exclude_claimed,
                        "detailClaimedText": target_status,
                    },
                },
                "queries": {
                    "open_events": {
                        "entity": "EventSeat",
                        "searchField": "title",
                        "filterField": "category",
                        "filters": [{"label": "全部", "value": "全部", "all": True}, "人工智能", "系统工程", "人机交互"],
                        "respectRule": "signup_policy",
                        "emptyText": "暂无匹配的学术讲座场次",
                    }
                },
                "operations": {
                    "publish_event": {
                        "kind": "create",
                        "entity": "EventSeat",
                        "rule": "publish_policy",
                        "fields": ["title", "category", "location", "note"],
                        "defaults": {"status": "开放报名", "claimant": "虚位以待", "contact": "-"},
                        "successText": "场次发布成功，已开放报名",
                        "navigateTo": "event_detail",
                    },
                    "signup_event": {
                        "kind": "update",
                        "entity": "EventSeat",
                        "rule": "signup_policy",
                        "fields": ["claimant", "contact", "note"],
                        "successText": "报名提交成功",
                        "navigateTo": "event_detail",
                    },
                },
                "views": [
                    {"id": "event_list", "title": "学术讲座列表", "kind": "list", "entity": "EventSeat", "query": "open_events", "cardFields": {"title": "title", "subtitle": "location", "badge": "status"}},
                    {"id": "event_detail", "title": "讲座场次详情", "kind": "detail", "entity": "EventSeat", "rule": "signup_policy", "displayFields": ["id", "title", "category", "location", "status", "claimant", "contact", "note"], "primaryAction": {"label": "立即报名", "navigateTo": "signup_form"}, "secondaryAction": {"label": "发布场次", "navigateTo": "publish_form"}},
                    {"id": "publish_form", "title": "发布学术讲座", "kind": "form", "entity": "EventSeat", "operation": "publish_event", "submitText": "确认发布", "backTo": "event_detail"},
                    {"id": "signup_form", "title": "讲座报名登记", "kind": "form", "entity": "EventSeat", "operation": "signup_event", "submitText": "确认报名", "backTo": "event_detail"},
                ],
            },
        }

    if any(k in text for k in ("请假", "审批", "外勤", "差旅", "leave")):
        target_status = "已归档" if exclude_claimed else "已批复"
        return {
            "$schema": "../../references/rp-language.schema.json",
            "language": "rp/1",
            "target": 9,
            "name": "员工外勤请假审批台",
            "domain": "web",
            "theme": "enterprise-light",
            "strictAudit": True,
            "product": {
                "entities": {
                    "LeaveRequest": {
                        "key": "id",
                        "statusField": "status",
                        "selectionVariable": "selected_lr_id",
                        "nextIdVariable": "next_lr_id",
                        "nextIdDefault": "LR-605",
                        "fields": {
                            "id": {"type": "text", "label": "申请单号"},
                            "title": {"type": "text", "label": "申请事由", "required": True},
                            "category": {"type": "text", "label": "申请类型", "default": "外勤", "enum": ["外勤", "年假", "调休"]},
                            "location": {"type": "text", "label": "所属部门", "required": True},
                            "status": {"type": "text", "label": "审批状态", "default": "待审批"},
                            "claimant": {"type": "text", "label": "审批主管", "default": "待指派"},
                            "contact": {"type": "text", "label": "紧急交接电话", "default": "-"},
                            "note": {"type": "text", "label": "工作交接说明", "default": "线上值班已交接"},
                        },
                        "rows": [
                            {"id": "LR-601", "title": "客户现场系统联调支持", "category": "外勤", "location": "交付工程部", "status": "待审批", "claimant": "待指派", "contact": "-", "note": "为期 2 天，由李工代管日常工单"},
                            {"id": "LR-602", "title": "年度带薪休假申请", "category": "年假", "location": "平台研发部", "status": "待审批", "claimant": "待指派", "contact": "-", "note": "发版任务已全部合入主干"},
                            {"id": "LR-603", "title": "周末机房割接补休", "category": "调休", "location": "基础架构部", "status": "待审批", "claimant": "待指派", "contact": "-", "note": "已完成割接复盘报告"},
                            {"id": "LR-604", "title": "合作伙伴技术交流驻场", "category": "外勤", "location": "解决方案部", "status": "待审批", "claimant": "待指派", "contact": "-", "note": "演示环境已打包就绪"},
                        ],
                    }
                },
                "rules": {
                    "submit_policy": {
                        "entity": "LeaveRequest",
                        "operation": "submit_leave",
                        "description": "提单必填规则：必须填写申请事由与所属部门。",
                        "requiredFields": [
                            {"field": "title", "required": True, "message": "请填写申请事由"},
                            {"field": "location", "required": True, "message": "请填写所属部门"},
                        ],
                    },
                    "approve_policy": {
                        "entity": "LeaveRequest",
                        "operation": "approve_leave",
                        "description": "审批规则：控制审批主管、紧急交接电话必填及归档后列表过滤策略。",
                        "requiredFields": [
                            {"field": "claimant", "required": True, "message": "请填写审批主管姓名"}
                        ],
                        "requireContact": require_contact,
                        "contactField": "contact",
                        "contactRequiredMessage": "请填写紧急交接电话",
                        "statusTransition": {"field": "status", "from": "待审批", "to": target_status},
                        "excludeClaimedFromList": exclude_claimed,
                        "detailClaimedText": target_status,
                    },
                },
                "queries": {
                    "pending_leaves": {
                        "entity": "LeaveRequest",
                        "searchField": "title",
                        "filterField": "category",
                        "filters": [{"label": "全部", "value": "全部", "all": True}, "外勤", "年假", "调休"],
                        "respectRule": "approve_policy",
                        "emptyText": "暂无匹配的请假外勤申请",
                    }
                },
                "operations": {
                    "submit_leave": {
                        "kind": "create",
                        "entity": "LeaveRequest",
                        "rule": "submit_policy",
                        "fields": ["title", "category", "location", "note"],
                        "defaults": {"status": "待审批", "claimant": "待指派", "contact": "-"},
                        "successText": "申请提交成功，已进入待审批列表",
                        "navigateTo": "leave_detail",
                    },
                    "approve_leave": {
                        "kind": "update",
                        "entity": "LeaveRequest",
                        "rule": "approve_policy",
                        "fields": ["claimant", "contact", "note"],
                        "successText": "审批核准成功",
                        "navigateTo": "leave_detail",
                    },
                },
                "views": [
                    {"id": "leave_list", "title": "外勤请假申请列表", "kind": "list", "entity": "LeaveRequest", "query": "pending_leaves", "cardFields": {"title": "title", "subtitle": "location", "badge": "status"}},
                    {"id": "leave_detail", "title": "申请单详情", "kind": "detail", "entity": "LeaveRequest", "rule": "approve_policy", "displayFields": ["id", "title", "category", "location", "status", "claimant", "contact", "note"], "primaryAction": {"label": "审批核准", "navigateTo": "approve_form"}, "secondaryAction": {"label": "新建申请", "navigateTo": "submit_form"}},
                    {"id": "submit_form", "title": "新建外勤请假申请", "kind": "form", "entity": "LeaveRequest", "operation": "submit_leave", "submitText": "提交申请", "backTo": "leave_detail"},
                    {"id": "approve_form", "title": "主管审批核准", "kind": "form", "entity": "LeaveRequest", "operation": "approve_leave", "submitText": "确认核准", "backTo": "leave_detail"},
                ],
            },
        }

    # Default domain: 校园失物招领 (Lost & Found)
    target_status = "已认领" if exclude_claimed else "认领待核验"
    return {
        "$schema": "../../references/rp-language.schema.json",
        "language": "rp/1",
        "target": 9,
        "name": "校园失物招领工作台",
        "domain": "web",
        "theme": "enterprise-light",
        "strictAudit": True,
        "product": {
            "entities": {
                "LostItem": {
                    "key": "id",
                    "statusField": "status",
                    "selectionVariable": "selected_lost_id",
                    "nextIdVariable": "next_lost_id",
                    "nextIdDefault": "LF-105",
                    "fields": {
                        "id": {"type": "text", "label": "物品编号"},
                        "title": {"type": "text", "label": "物品名称", "required": True},
                        "category": {"type": "text", "label": "物品分类", "default": "证件", "enum": ["证件", "电子", "生活"]},
                        "location": {"type": "text", "label": "拾获地点", "required": True},
                        "status": {"type": "text", "label": "认领状态", "default": "待认领"},
                        "claimant": {"type": "text", "label": "认领人", "default": "未认领"},
                        "contact": {"type": "text", "label": "联系方式", "default": "-"},
                        "note": {"type": "text", "label": "备注说明", "default": "请凭有效凭证核对"},
                    },
                    "rows": [
                        {"id": "LF-101", "title": "校园一卡通", "category": "证件", "location": "图书馆二楼自习区", "status": "待认领", "claimant": "未认领", "contact": "-", "note": "卡套内附借书小票"},
                        {"id": "LF-102", "title": "AirPods Pro 耳机盒", "category": "电子", "location": "第三教学楼 302", "status": "待认领", "claimant": "未认领", "contact": "-", "note": "白色保护套"},
                        {"id": "LF-103", "title": "黑色保温杯", "category": "生活", "location": "体育馆北门看台", "status": "待认领", "claimant": "未认领", "contact": "-", "note": "杯底贴有姓名缩写"},
                        {"id": "LF-104", "title": "银色机械键盘", "category": "电子", "location": "创新实验室 A106", "status": "待认领", "claimant": "未认领", "contact": "-", "note": "87 键有线版"},
                    ],
                }
            },
            "rules": {
                "register_policy": {
                    "entity": "LostItem",
                    "operation": "register_item",
                    "description": "失物登记必填规则：必须填写物品名称与拾获地点。",
                    "requiredFields": [
                        {"field": "title", "required": True, "message": "请填写物品名称"},
                        {"field": "location", "required": True, "message": "请填写拾获地点"},
                    ],
                },
                "claim_policy": {
                    "entity": "LostItem",
                    "operation": "claim_item",
                    "description": "认领规则：控制认领人姓名、联系方式必填及认领后列表过滤策略。",
                    "requiredFields": [
                        {"field": "claimant", "required": True, "message": "请填写认领人姓名"}
                    ],
                    "requireContact": require_contact,
                    "contactField": "contact",
                    "contactRequiredMessage": "请填写认领人联系方式",
                    "statusTransition": {"field": "status", "from": "待认领", "to": target_status},
                    "excludeClaimedFromList": exclude_claimed,
                    "detailClaimedText": target_status,
                },
            },
            "queries": {
                "pending_items": {
                    "entity": "LostItem",
                    "searchField": "title",
                    "filterField": "category",
                    "filters": [{"label": "全部", "value": "全部", "all": True}, "证件", "电子", "生活"],
                    "respectRule": "claim_policy",
                    "emptyText": "暂无匹配的待认领物品",
                }
            },
            "operations": {
                "register_item": {
                    "kind": "create",
                    "entity": "LostItem",
                    "rule": "register_policy",
                    "fields": ["title", "category", "location", "note"],
                    "defaults": {"status": "待认领", "claimant": "未认领", "contact": "-"},
                    "successText": "登记成功，已加入待认领列表",
                    "navigateTo": "lost_detail",
                },
                "claim_item": {
                    "kind": "update",
                    "entity": "LostItem",
                    "rule": "claim_policy",
                    "fields": ["claimant", "contact", "note"],
                    "successText": "认领提交成功",
                    "navigateTo": "lost_detail",
                },
            },
            "views": [
                {"id": "lost_list", "title": "待认领物品列表", "kind": "list", "entity": "LostItem", "query": "pending_items", "cardFields": {"title": "title", "subtitle": "location", "badge": "status"}},
                {"id": "lost_detail", "title": "物品详情", "kind": "detail", "entity": "LostItem", "rule": "claim_policy", "displayFields": ["id", "title", "category", "location", "status", "claimant", "contact", "note"], "primaryAction": {"label": "发起认领", "navigateTo": "claim_form"}, "secondaryAction": {"label": "登记失物", "navigateTo": "register_form"}},
                {"id": "register_form", "title": "登记失物", "kind": "form", "entity": "LostItem", "operation": "register_item", "submitText": "确认登记", "backTo": "lost_detail"},
                {"id": "claim_form", "title": "认领登记", "kind": "form", "entity": "LostItem", "operation": "claim_item", "submitText": "确认认领", "backTo": "lost_detail"},
            ],
        },
    }


def export_product_html_preview(spec, compiled_ir=None):
    """Export a self-contained interactive HTML preview from the unified `product` model and compiled RP/1 IR."""
    import json as _json

    product = (spec or {}).get("product") or {}
    prov = (compiled_ir or {}).get("productProvenance") or {}
    sem_hash = (compiled_ir or {}).get("semanticHash", "")
    title = str((spec or {}).get("name") or "RP/1 统一产品模型预览")

    payload = {
        "name": title,
        "semanticHash": sem_hash,
        "product": product,
        "productProvenance": prov,
    }
    payload_json = _json.dumps(payload, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>{title} - RP/1 共享模型预览</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #F8FAFC; color: #0F172A; margin: 0; padding: 24px; }}
  .workspace {{ max-width: 1028px; margin: 0 auto; display: flex; gap: 16px; }}
  .left-pane {{ width: 468px; background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; box-sizing: border-box; }}
  .right-pane {{ width: 496px; background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; box-sizing: border-box; }}
  .header-row {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }}
  .banner {{ background: #EFF6FF; color: #1D4ED8; padding: 6px 10px; border-radius: 4px; font-size: 12px; margin-bottom: 12px; }}
  .search-bar {{ width: 100%; padding: 8px; border: 1px solid #CBD5E1; border-radius: 6px; margin-bottom: 10px; box-sizing: border-box; }}
  .filters {{ display: flex; gap: 8px; margin-bottom: 12px; }}
  .chip {{ padding: 4px 12px; border: 1px solid #CBD5E1; border-radius: 14px; background: #F1F5F9; cursor: pointer; font-size: 12px; }}
  .chip.active {{ background: #2563EB; color: #FFFFFF; border-color: #2563EB; }}
  .row-card {{ display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border: 1px solid #E2E8F0; border-radius: 6px; margin-bottom: 8px; cursor: pointer; }}
  .badge {{ font-size: 12px; padding: 2px 8px; border-radius: 4px; background: #E0F2FE; color: #0369A1; }}
  .field-row {{ display: flex; margin-bottom: 8px; font-size: 13px; }}
  .field-label {{ width: 110px; color: #64748B; font-weight: 500; }}
  .btn {{ padding: 8px 14px; border-radius: 6px; border: 1px solid #2563EB; background: #2563EB; color: #FFF; cursor: pointer; font-size: 13px; }}
  .btn.secondary {{ background: #FFF; color: #334155; border-color: #CBD5E1; }}
  .feedback {{ color: #DC2626; font-size: 12px; min-height: 18px; margin: 8px 0; }}
</style>
</head>
<body>
<script id="rp1-provenance" type="application/json">{payload_json}</script>
<div class="workspace" id="app"></div>
<script>
const DATA = JSON.parse(document.getElementById("rp1-provenance").textContent);
window.__RP1_SHARED_MODEL__ = DATA;
</script>
</body>
</html>
"""


def three_way_writeback(base_spec, base_rp_widgets, gui_rp_widgets, concurrent_spec_ops=None):
    """
    Controlled 3-way writeback for the text & geometry (`text`, `x`, `y`, `w`, `h`) subset.
    Compares baseline generated `.rp` widgets against GUI-saved `.rp` widgets, maps changes back to
    the RP/1 specification (preserving `product.rules`, `product.operations`, and interactions),
    and emits structured conflicts when concurrent spec edits or unsupported changes collide.
    """
    merged_spec = copy.deepcopy(base_spec)
    concurrent_paths = {str(op.get("path", "")) for op in (concurrent_spec_ops or []) if isinstance(op, dict)}

    base_by_name = {str(w.get("name") or w.get("id")): w for w in (base_rp_widgets or []) if isinstance(w, dict)}
    gui_by_name = {str(w.get("name") or w.get("id")): w for w in (gui_rp_widgets or []) if isinstance(w, dict)}

    applied_patches = []
    conflicts = []

    for wname, gui_w in gui_by_name.items():
        base_w = base_by_name.get(wname)
        if not base_w:
            continue

        # Detect unsupported structural/interaction tampering in GUI
        if gui_w.get("unsupportedInteractionEdit"):
            conflicts.append({
                "widgetName": wname,
                "kind": "unsupported_gui_interaction",
                "reason": "GUI modified complex interaction structure outside the controlled text/geometry writeback subset",
            })
            continue

        changed_props = {}
        for prop in ("text", "x", "y", "w", "h"):
            if prop in gui_w and prop in base_w and gui_w[prop] != base_w[prop]:
                changed_props[prop] = {"base": base_w[prop], "gui": gui_w[prop]}

        if not changed_props:
            continue

        target_pointer = gui_w.get("sourcePointer") or base_w.get("sourcePointer")
        # For unified product specs, map view titles / button labels back to `/product/views/...` or `/name`
        if not target_pointer and isinstance(merged_spec.get("product"), dict):
            views = merged_spec["product"].get("views") or []
            if "text" in changed_props:
                old_txt = str(changed_props["text"]["base"])
                new_txt = str(changed_props["text"]["gui"])
                if merged_spec.get("name") == old_txt:
                    target_pointer = "/name"
                else:
                    for idx, v in enumerate(views):
                        if not isinstance(v, dict):
                            continue
                        if v.get("title") == old_txt:
                            target_pointer = f"/product/views/{idx}/title"
                            break
                        if v.get("submitText") == old_txt:
                            target_pointer = f"/product/views/{idx}/submitText"
                            break
                        pa = v.get("primaryAction")
                        if isinstance(pa, dict) and pa.get("label") == old_txt:
                            target_pointer = f"/product/views/{idx}/primaryAction/label"
                            break

        if not target_pointer:
            conflicts.append({
                "widgetName": wname,
                "kind": "unmapped_widget",
                "changedProps": changed_props,
                "reason": "Widget does not map to a writable source pointer",
            })
            continue

        if any(
            cp == target_pointer or cp.startswith(target_pointer + "/") or target_pointer.startswith(cp + "/")
            for cp in concurrent_paths
        ):
            conflicts.append({
                "widgetName": wname,
                "kind": "concurrent_edit_conflict",
                "pointer": target_pointer,
                "changedProps": changed_props,
                "reason": f"Concurrent spec modification on '{target_pointer}' conflicts with GUI edit",
            })
            continue

        # Apply safe writeback along target_pointer
        parts = [p for p in target_pointer.strip("/").split("/") if p]
        cur = merged_spec
        for seg in parts[:-1]:
            cur = cur[int(seg)] if isinstance(cur, list) else cur[seg]
        last = parts[-1]
        if "text" in changed_props and (isinstance(cur, dict) and last in cur and isinstance(cur[last], str)):
            cur[last] = str(changed_props["text"]["gui"])
            applied_patches.append({
                "widgetName": wname,
                "pointer": target_pointer,
                "property": "text",
                "oldValue": changed_props["text"]["base"],
                "newValue": changed_props["text"]["gui"],
            })
        elif isinstance(cur, dict):
            for prop, delta in changed_props.items():
                cur[prop] = delta["gui"]
                applied_patches.append({
                    "widgetName": wname,
                    "pointer": f"{target_pointer}/{prop}",
                    "property": prop,
                    "oldValue": delta["base"],
                    "newValue": delta["gui"],
                })

    return {
        "ok": len(conflicts) == 0,
        "spec": merged_spec,
        "appliedPatches": applied_patches,
        "conflicts": conflicts,
    }
