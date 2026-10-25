"""Editor source-shape schema shared with the compiler vocabulary.

Check remains authoritative for expression types, dynamic component arguments,
references, row scope, dataset columns and target-specific behavior support.
"""
from rp_language import (
    NODE_PROPS, ACTION_PROPS, GEOMETRY, THEMES, EVENTS, EVENT_SHORTHANDS,
    MACRO_PROPS, MACRO_ITEM_PROPS, DEVICE_CANVAS_PRESETS, MAX_FONT_SIZE,
)


def language_schema():
    def ref(name):
        return {"$ref": "#/$defs/" + name}

    def obj(properties, required=()):
        return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}

    def array(items, minimum=0):
        return {"type": "array", "items": items, "minItems": minimum}

    def either(*choices):
        return {"anyOf": list(choices)}

    text = {"type": "string"}
    nonempty = {"type": "string", "minLength": 1}
    ident = {"type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_-]*$"}
    number = {"type": "number"}
    positive_int = {"type": "integer", "minimum": 1}
    nonnegative_int = {"type": "integer", "minimum": 0}
    scalar = {"type": ["string", "number", "boolean"]}
    compile_expr = {"oneOf": [obj({"$": text}, ["$"]), obj({"format": text}, ["format"]), obj({"expr": text}, ["expr"])]}
    defs = {
        "compileExpression": compile_expr,
        "reference": either(nonempty, obj({"ref": nonempty}, ["ref"])),
        "size": either({"type": "number", "minimum": 0}, {"enum": ["fill", "hug", "auto"]}, ref("compileExpression")),
        "dataValue": either(scalar, array(ref("dataValue")), {"type": "object", "additionalProperties": ref("dataValue")}),
    }
    defs["runtime"] = {"oneOf": [scalar,
        obj({"variable": ident}, ["variable"]), obj({"widget": ref("reference")}, ["widget"]),
        obj({"item": ident}, ["item"]), obj({"caller": ident}, ["caller"]),
        obj({"op": {"enum": ["+", "-", "*", "/", "==", "!=", ">", "<", ">=", "<=", "&&", "||"]}, "left": ref("value"), "right": ref("value")}, ["op", "left", "right"]),
        obj({"fn": {"enum": ["text", "number", "not", "lower", "upper", "length", "concat", "contains", "remove"]}, "args": array(ref("value"), 1)}, ["fn", "args"])]}
    defs["value"] = either(ref("runtime"), ref("compileExpression"))
    numeric = either({"type": "number", "minimum": 0}, {"type": "string", "pattern": "^\\$[A-Za-z_][A-Za-z0-9_.-]*$"}, ref("compileExpression"))
    string_expr = either(text, ref("compileExpression"))
    def enum_expr(choices):
        return either({"enum": choices}, ref("compileExpression"))
    padding = either({"type": "number", "minimum": 0}, {"type": "array", "items": {"type": "number", "minimum": 0}, "minItems": 1, "maxItems": 4, "not": {"minItems": 3, "maxItems": 3}}, ref("compileExpression"))
    adaptive = {"type": "object", "propertyNames": ident, "additionalProperties": obj({
        "x": number, "y": number, "w": {"type": "number", "minimum": 0}, "h": {"type": "number", "minimum": 0}})}
    event_value = ref("eventValue")
    common = {"id": ident, "name": text, "on": ref("events"), "font": nonempty, "when": ref("value"), "adaptive": adaptive,
              "size": {"type": "array", "items": ref("size"), "minItems": 2, "maxItems": 2},
              **{k: event_value for k in EVENT_SHORTHANDS},
              **{k: ref("size") if k in {"w", "h"} else string_expr if k == "anchor" else either(number, ref("compileExpression")) if k in {"x", "y", "right", "bottom"} else numeric for k in GEOMETRY}}
    panel_state = {
        "type": "object",
        "properties": {
            "id": ident, "state": ident, "name": text, "title": text, "label": text,
            "root": ref("node"), "children": array(ref("node")),
            "layout": enum_expr(["row", "column", "stack", "grid"]),
            "w": ref("size"), "h": ref("size"), "gap": numeric, "padding": padding,
            "align": enum_expr(["start", "center", "end", "stretch"]),
            "justify": enum_expr(["start", "center", "end", "space-between", "space-around", "space-evenly", "around", "evenly"]),
            "fill": string_expr, "bg": string_expr, "background": string_expr,
            "stroke": string_expr, "borderColor": string_expr,
            "strokeWidth": numeric, "borderWidth": numeric,
            "radius": numeric, "rounded": numeric, "borderRadius": numeric,
            "columns": positive_int, "equalHeight": {"type": "boolean"},
        },
        "anyOf": [
            {"required": ["id", "root"]},
            {"required": ["id", "children"]},
            {"required": ["state", "root"]},
            {"required": ["state", "children"]},
        ],
        "additionalProperties": False,
    }
    special = {
        "activeIndicator": enum_expr(["none", "underline", "dot"]),
        "activeVariant": enum_expr(["primary", "brand", "secondary", "outline", "ghost", "soft", "danger", "success", "warning", "error"]),
        "itemFlex": numeric,
        "children": array(ref("node")), "states": array(panel_state, 1),
        "template": ref("node"), "master": ref("node"), "detail": ref("node"), "dataset": ident, "key": ident, "as": ident,
        "slots": {"type": "object", "additionalProperties": either(ref("node"), array(ref("node")))},
        "rowHeight": positive_int, "pageSize": positive_int, "rowGap": nonnegative_int,
        "layout": enum_expr(["row", "column", "stack", "grid"]), "justify": enum_expr(["start", "center", "end", "space-between", "space-around", "space-evenly", "around", "evenly"]),
        "native": {"const": True}, "equalHeight": {"type": "boolean"}, "columns": positive_int, "padding": padding,
        "variant": enum_expr(["primary", "secondary", "outline", "soft", "danger", "glass"]),
        "wrap": {"type": "boolean"}, "smooth": {"type": "boolean"},
        "italic": {"type": "boolean"}, "underline": {"type": "boolean"}, "strikethrough": {"type": "boolean"},
        "aurora": either({"type": "boolean"}, array(text), ref("compileExpression")),
        "spans": array({"type": "object"}), "points": array(number),
        "borderSides": either(text, array(text)), "shadow": ref("dataValue"),
        "direction": enum_expr(["horizontal", "vertical"]), "src": either(nonempty, ref("compileExpression")),
    }
    numeric_fields = {"x", "y", "flex", "gap", "columnGap", "fontSize", "fontWeight", "lineGap", "lineHeight", "radius", "headerHeight", "headerRadius", "rowRadius", "tableGap", "inputHeight", "inputRadius", "titleFontSize", "submitHeight", "labelWidth", "headerFontSize", "headerFontWeight", "width", "listWidth", "masterWidth", "bodyHeight"}

    def property_shape(name):
        if name in {"fontSize", "titleFontSize", "headerFontSize", "valueFontSize"}:
            return either({"type": "number", "exclusiveMinimum": 0, "maximum": MAX_FONT_SIZE},
                          {"type": "string", "pattern": "^\\$[A-Za-z_][A-Za-z0-9_.-]*$"}, ref("compileExpression"))
        if name in {"alignX", "pin"}:
            return enum_expr(["left", "center", "right"] if name == "alignX" else ["top", "bottom", "left", "right"])
        if name in {"afterGap", "pinGap"}:
            return numeric
        if name == "adaptive":
            return adaptive
        if name == "size":
            return either(common["size"], numeric)
        if name in {"weight", "textPaddingX", "letterSpacing", "opacity", "strokeWidth", "backdropBlur", "noise", "innerGlow", "max", "barHeight", "trackHeight"}:
            return numeric
        if name in {"visible", "hidden", "showValue", "darkIsland", "showHomeIndicator"}:
            return {"type": "boolean"}
        if name == "percent":
            return ref("value")
        if name in {"tabBar", "navBar"}:
            return either({"type": "object"}, {"const": False})
        if name in {"onBack", "onRight"}:
            return event_value
        if name in {"w", "h", "repeaterHeight"}:
            return ref("size")
        if name in special:
            return special[name]
        if name in numeric_fields:
            return numeric
        if name in {"text", "value", "filterWhere", "baseWhere", "when", "nextWhen", "guard"}:
            return ref("value")
        return string_expr

    def node_variants(kind, props, required=()):
        standard = obj({"type": {"const": kind}, **props}, ["type", "id", *required])
        shorthand_props = {k: v for k, v in props.items() if k != "type"}
        shorthand_props[kind] = ident
        shorthand = obj(shorthand_props, [kind, *required])
        return [standard, shorthand]

    nodes = []
    for kind, fields in NODE_PROPS.items():
        props = {**common, **{k: property_shape(k) for k in fields}}
        if "fontSize" not in fields:
            props.pop("font")
        if kind in {"box", "card"}:
            props["align"] = enum_expr(["start", "center", "end", "stretch"])
        elif "align" in fields:
            props["align"] = enum_expr(["left", "center", "right"])
        required = ["dataset", "template"] if kind == "repeater" else ["states"] if kind == "dynamic-panel" else ["src"] if kind == "image" else []
        nodes.extend(node_variants(kind, props, required))
    for alias in ("row", "column", "grid", "stack"):
        props = {**common, **{k: property_shape(k) for k in NODE_PROPS["box"]}}
        props.pop("font")
        props["align"] = enum_expr(["start", "center", "end", "stretch"])
        nodes.extend(node_variants(alias, props))
    panel_alias_props = {**common, **{k: property_shape(k) for k in NODE_PROPS["dynamic-panel"]}}
    panel_alias_props.pop("font", None)
    nodes.extend(node_variants("panel", panel_alias_props, ["states"]))
    repeat_props = {k: common[k] for k in {"id", "size"} | GEOMETRY}
    repeat_props.update({k: special[k] for k in ("dataset", "as", "key", "template")})
    nodes.extend(node_variants("repeat", repeat_props, ["dataset", "template"]))
    when_props = {k: common[k] for k in {"id", "size"} | GEOMETRY}
    when_props.update({"condition": ref("value"), "then": ref("node"), "else": ref("node"), "layout": special["layout"], "gap": numeric})
    nodes.extend(node_variants("when", when_props, ["condition", "then"]))
    # Inline component argument names are declared by the source's components map.
    # JSON Schema cannot validate those cross-object names; check does so strictly.
    use_props = {"id": ident, "component": ident, "args": {"type": "object", "additionalProperties": ref("dataValue")}}
    for variant in node_variants("use", use_props, ["component"]):
        variant["additionalProperties"] = ref("dataValue")
        nodes.append(variant)
    inline_use = obj({"use": ident, "id": ident, "args": {"type": "object", "additionalProperties": ref("dataValue")}}, ["use", "id"])
    inline_use["additionalProperties"] = ref("dataValue")
    nodes.append(inline_use)

    macro_required = {
        "data-table": ["dataset", "columns"],
        "searchable-list": ["dataset", "searchField", "template"],
        "form-card": ["fields"],
        "kv-list": ["items"],
        "detail-card": ["items"],
        "wizard-card": ["steps"],
        "master-detail": ["detail"],
    }
    for kind, fields in MACRO_PROPS.items():
        props = {k: common[k] if k in common else property_shape(k) for k in fields if k != "type"}
        for name in ("onSubmit", "onRowClick", "onComplete"):
            if name in props:
                props[name] = event_value
        if "rowOn" in props:
            props["rowOn"] = ref("events")
        for list_name, item_fields in MACRO_ITEM_PROPS.get(kind, {}).items():
            item_props = {k: property_shape(k) for k in item_fields}
            for name in ("id", "headerId"):
                if name in item_props:
                    item_props[name] = ident
            for name in ("on", "onClick", "onNext"):
                if name in item_props:
                    item_props[name] = ref("events") if name == "on" else event_value
            for name in ("cell", "root", "body"):
                if name in item_props:
                    item_props[name] = ref("node")
            if "all" in item_props:
                item_props["all"] = {"type": "boolean"}
            if kind in ("searchable-list", "master-detail") and list_name == "filters":
                item = either(text, obj(item_props))
            else:
                item = obj(item_props)
            if kind == "form-card":
                item["properties"]["h"] = {"type": "number", "minimum": 0}
            if list_name == "filters":
                props[list_name] = either({"const": "auto"}, array(item, 0))
            else:
                props[list_name] = array(item, 1)
        if kind in ("kv-list", "detail-card"):
            props["rowHeight"] = {"type": "number", "minimum": 4}
        nodes.extend(node_variants(kind, props, macro_required.get(kind, [])))
    defs["node"] = {"anyOf": nodes}

    actions = []
    for kind, fields in ACTION_PROPS.items():
        props = {"type": {"const": kind}}
        for name in fields:
            props[name] = ref("reference") if name == "target" else ref("value") if name in {"text", "value", "where"} else array({"type": "object", "additionalProperties": ref("value")}, 1) if name == "rows" else {"type": "object", "minProperties": 1, "additionalProperties": ref("value")} if name == "set" else nonnegative_int if name == "ms" else either({"enum": ["next", "previous", "first", "last"]}, positive_int) if name == "page" and kind == "data-page" else text
        optional = {"direction"} if kind == "data-sort" else {"name"} if kind == "data-filter" else set()
        if kind == "set-size":
            props["width"] = ref("value")
            props["height"] = ref("value")
            props["duration"] = {"type": "number", "minimum": 0}
            optional = {"duration", "easing", "anchor"}
        if kind == "data-sort":
            props["direction"] = {"enum": ["ascending", "descending", "asc", "desc"]}
        if kind == "data-add":
            props["row"] = either({"type": "object", "additionalProperties": ref("value")}, props["rows"])
            action = obj(props, ["type", "target"])
            action["oneOf"] = [{"required": ["rows"], "not": {"required": ["row"]}}, {"required": ["row"], "not": {"required": ["rows"]}}]
        else:
            action = obj(props, ["type", *sorted(fields - optional)])
        actions.append(action)
    actions.extend([
        obj({"rule": ident}, ["rule"]), obj({"type": {"const": "apply-rule"}, "rule": ident}, ["type", "rule"]),
        obj({"op": ident}, ["op"]),
        obj({"set": {"type": "object", "minProperties": 1, "additionalProperties": ref("value")}}, ["set"]),
        obj({"set-variable": ident, "value": ref("value")}, ["set-variable", "value"]),
        obj({"goto": ident}, ["goto"]),
    ])
    for key in ("state", "set-state"):
        actions.append(obj({key: either({"type": "array", "prefixItems": [nonempty, ident], "items": False, "minItems": 2}, {"type": "string", "pattern": "^.+\\..+$"})}, [key]))
    for key in ("show", "hide", "toggle", "enable", "disable", "focus"):
        actions.append(obj({key: ref("reference")}, [key]))
    defs["action"] = {"anyOf": actions}
    action_list = array(ref("action"), 1)
    case = obj({"when": ref("value"), "else": {"type": "boolean"}, "actions": either(ref("action"), action_list), "do": either(ref("action"), action_list)})
    case["oneOf"] = [{"required": ["actions"], "not": {"required": ["do"]}}, {"required": ["do"], "not": {"required": ["actions"]}}]
    defs["eventValue"] = either(ref("action"), action_list, obj({"cases": array(case, 1)}, ["cases"]))
    defs["events"] = {"type": "object", "propertyNames": {"enum": sorted(set(EVENTS) | set(EVENTS.values()))}, "additionalProperties": event_value}
    domain_scalar_name = {"enum": ["text", "number", "boolean", "id", "enum", "money", "phone", "date", "percent", "ref"]}
    domain_type_str = either(domain_scalar_name, {"type": "string", "pattern": "^(enum\\(.+\\)|ref<[A-Za-z_][A-Za-z0-9_-]*>)$"})
    domain_field_spec = either(
        domain_type_str,
        obj({
            "type": domain_type_str,
            "label": text,
            "required": {"type": "boolean"},
            "default": scalar,
            "enum": array(scalar, 1),
            "values": array(scalar, 1),
            "target": ident,
            "entity": ident,
            "placeholder": text,
            "min": number,
            "max": number,
        }),
    )
    model = {"type": "object", "propertyNames": ident, "additionalProperties": domain_field_spec}
    rows = array({"type": "object", "additionalProperties": scalar})
    dataset = obj({"model": ident, "rows": rows}, ["rows"])
    dataset["anyOf"] = [{"required": ["model"]}, {"properties": {"rows": {"minItems": 1}}}]
    selection_view = obj({"id": ident, "source": ident, "dataset": ident, "key": ident, "selector": nonempty, "variable": nonempty,
        "page": ident, "fields": {"type": "object", "additionalProperties": text}, "targets": {"type": "object", "additionalProperties": text}})
    selection_views = either(array(selection_view), {"type": "object", "propertyNames": ident, "additionalProperties": selection_view})
    master_ref = either(ident, obj({"master": ident, "id": ident, "x": number, "y": number}))
    palette_spec = {"type": "object", "additionalProperties": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"}}
    page = obj({"id": ident, "name": text, "device": {"enum": sorted(DEVICE_CANVAS_PRESETS)}, "shell": {"enum": sorted(DEVICE_CANVAS_PRESETS)},
                "domain": {"enum": ["web", "mobile", "doc", "test"]},
                "canvas": either(obj({"w": {"type": "number", "exclusiveMinimum": 0}, "h": {"type": "number", "exclusiveMinimum": 0}}, ["w", "h"]), {"type": "array", "items": {"type": "number", "exclusiveMinimum": 0}, "minItems": 2, "maxItems": 2}),
                "root": ref("node"), "on": ref("events"), "onLoad": event_value,
                "layout": either(ref("node"), array(ref("node"))), "slot": special["slots"], "views": selection_views,
                "master": master_ref, "masters": either(ident, array(master_ref)),
                "bindings": array(obj({"dataset": ident, "key": ident, "variable": ident, "targets": {"type": "object", "minProperties": 1, "additionalProperties": text}}, ["dataset", "key", "variable", "targets"]))}, ["id"])
    page["anyOf"] = [{"required": [key]} for key in ("root", "layout", "slot")]
    master = obj({"name": text, "w": {"type": "number", "exclusiveMinimum": 0}, "h": {"type": "number", "exclusiveMinimum": 0},
        "direction": {"enum": ["horizontal", "vertical"]}, "root": ref("node"), "layout": array(ref("node"))})
    master["anyOf"] = [{"required": ["root"]}, {"required": ["layout"]}]
    rule_effect = obj({
        **{k: nonempty for k in ("target", "statusField", "feedback", "goto")},
        **{k: ref("value") for k in ("where", "filterWhere", "status", "transitionTo", "successMessage", "errorMessage")},
        **{k: {"type": "object", "additionalProperties": ref("value")} for k in ("set", "variables", "setVariables", "setText", "widgets")},
        **{k: {"type": "object", "additionalProperties": ident} for k in ("panelState", "state")},
        **{k: either(ref("dataValue"), array(ref("dataValue"))) for k in ("dataAdd", "add", "dataDelete", "delete")},
        "excludeFrom": either(nonempty, array(nonempty)), "actions": array(ref("action"))})
    declarative_rule = obj({"id": ident, "when": nonempty, "require": array(nonempty),
        "guard": ref("value"), "guards": array(either(ref("value"), obj({"assert": ref("value"), "when": ref("value"), "expr": ref("value"), "message": text, "errorMessage": text}))),
        "effect": rule_effect, "feedback": nonempty, "errorTarget": nonempty, "target": nonempty, "where": ref("value"),
        "errorMessage": text, "successMessage": text, "elseActions": array(ref("action"))})
    product_entity = obj({
        "key": ident,
        "fields": {"type": "object", "propertyNames": ident, "additionalProperties": domain_field_spec},
        "rows": rows,
        "selectionVariable": ident,
        "nextIdVariable": ident,
        "nextIdDefault": text,
        "statusField": ident,
    }, ["fields", "rows"])
    product_rule = obj({
        "entity": ident,
        "operation": ident,
        "description": text,
        "guard": ref("value"),
        "errorMessage": text,
        "requiredFields": array(either(ident, obj({"field": ident, "required": {"type": "boolean"}, "message": text}, ["field"]))),
        "requireContact": {"type": "boolean"},
        "contactField": ident,
        "contactRequiredMessage": text,
        "statusTransition": obj({"field": ident, "from": text, "to": text}, ["to"]),
        "claimedStatus": text,
        "excludeClaimedFromList": {"type": "boolean"},
        "listWhere": ref("value"),
        "detailClaimedText": text,
        "detailStatusPrefix": text,
    })
    product_query = obj({
        "entity": ident,
        "searchField": ident,
        "filterField": ident,
        "filters": either({"const": "auto"}, array(either(text, obj({"label": text, "value": text, "all": {"type": "boolean"}})))),
        "where": ref("value"),
        "respectRule": ident,
        "emptyText": text,
        "pageSize": positive_int,
        "rowHeight": positive_int,
    }, ["entity", "searchField"])
    product_operation = obj({
        "kind": {"enum": ["select", "create", "update", "delete", "transfer", "transition"]},
        "entity": ident,
        "targetEntity": ident,
        "rule": ident,
        "rules": array(ident),
        "fields": array(ident),
        "defaults": {"type": "object", "additionalProperties": scalar},
        "set": {"type": "object", "additionalProperties": ref("value")},
        "where": ref("value"),
        "guard": ref("value"),
        "errorMessage": text,
        "successText": text,
        "navigateTo": ident,
        "targetView": ident,
    }, ["kind", "entity"])
    product_view_spec = obj({
        "id": ident,
        "title": text,
        "subtitle": text,
        "kind": {"enum": ["list", "detail", "form", "wizard", "master-detail", "kanban", "shuttle", "cart"]},
        "entity": ident,
        "secondaryEntity": ident,
        "query": ident,
        "operation": ident,
        "rule": ident,
        "selectOperation": ident,
        "displayFields": array(ident),
        "cardFields": {"type": "object", "additionalProperties": ident},
        "primaryAction": obj({"label": text, "navigateTo": ident}),
        "secondaryAction": obj({"label": text, "navigateTo": ident}),
        "submitText": text,
        "backTo": ident,
        "slots": special["slots"],
        "steps": array({"type": "object"}),
        "tabs": array({"type": "object"}),
    }, ["id", "kind"])
    compute_agg = obj({"op": {"enum": ["count", "sum"]}, "dataset": ident, "field": ref("value"), "where": ref("value"), "scope": {"enum": ["visible", "dataset"]}}, ["op", "dataset"])
    var_spec = either(
        scalar,
        obj({"type": domain_scalar_name, "value": scalar, "compute": either(ref("value"), compute_agg)}),
    )
    invariant_spec = either(
        ref("value"),
        obj({"id": ident, "name": text, "expr": ref("value"), "when": ref("value"), "message": text}),
    )
    invariants_map_or_list = either(
        array(invariant_spec),
        {"type": "object", "propertyNames": ident, "additionalProperties": invariant_spec},
    )
    defs["product"] = obj({
        "shell": {"enum": ["mobile-stack", "tablet-split", "web-console"]},
        "entities": {"type": "object", "propertyNames": ident, "additionalProperties": product_entity},
        "computed": {"type": "object", "propertyNames": ident, "additionalProperties": var_spec},
        "statecharts": {"type": "object", "propertyNames": ident, "additionalProperties": {"type": "object"}},
        "transactions": {"type": "object", "propertyNames": ident, "additionalProperties": {"type": "object"}},
        "invariants": invariants_map_or_list,
        "rules": {"type": "object", "propertyNames": ident, "additionalProperties": product_rule},
        "queries": {"type": "object", "propertyNames": ident, "additionalProperties": product_query},
        "operations": {"type": "object", "propertyNames": ident, "additionalProperties": product_operation},
        "views": array(product_view_spec, 1),
    }, ["entities"])
    result = obj({"$schema": text, "language": {"const": "rp/1"}, "target": {"const": 9}, "name": text, "theme": {"enum": sorted(THEMES)},
        "palette": palette_spec, "tokens": {"type": "object", "additionalProperties": ref("dataValue")},
        "device": {"enum": sorted(DEVICE_CANVAS_PRESETS)}, "devMode": {"type": "boolean"},
        "domain": {"enum": ["web", "mobile", "doc", "test"]}, "shell": {"enum": sorted(DEVICE_CANVAS_PRESETS) + ["mobile-stack", "tablet-split", "web-console"]},
        "static": {"type": "boolean"}, "strictAudit": {"type": "boolean"},
        "product": ref("product"),
        "models": {"type": "object", "propertyNames": ident, "additionalProperties": model},
        "datasets": {"type": "object", "propertyNames": ident, "additionalProperties": either(dataset, {**rows, "minItems": 1})},
        "variables": {"type": "object", "propertyNames": ident, "additionalProperties": var_spec},
        "computed": {"type": "object", "propertyNames": ident, "additionalProperties": var_spec},
        "statecharts": {"type": "object", "propertyNames": ident, "additionalProperties": {"type": "object"}},
        "transactions": {"type": "object", "propertyNames": ident, "additionalProperties": {"type": "object"}},
        "invariants": invariants_map_or_list,
        "views": selection_views,
        "rules": either(array(declarative_rule), {"type": "object", "propertyNames": ident, "additionalProperties": declarative_rule}),
        "masters": {"type": "object", "propertyNames": ident, "additionalProperties": master},
        "adaptiveViews": array(obj({"id": ident, "name": nonempty, "width": {"type": "number", "exclusiveMinimum": 0}, "height": {"type": "number", "minimum": 0}, "condition": {"enum": ["<=", ">="]}}, ["id", "width"]), 1),
        "components": {"type": "object", "additionalProperties": obj({"params": {"type": "object", "propertyNames": ident, "additionalProperties": ident}, "root": ref("node")}, ["root"])},
        "pages": array(page, 1)}, ["language"])
    result["anyOf"] = [{"required": ["pages"]}, {"required": ["product"]}]
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "RP/1 prototype language", "description": "RP/1 standard AST, sugar and macro source shapes. Run check for expression types, dynamic component argument names, references, row scope, dataset columns and target support.", **result, "$defs": defs}
