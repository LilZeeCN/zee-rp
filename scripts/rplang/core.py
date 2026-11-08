# 从 scripts/rp_language.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 2;行为不变,勿手改)。
import copy
import difflib
import json
import math
import re

class LanguageError(ValueError):
    def __init__(self, code, pointer, message, suggestions=None, counterexample=None, candidate_patches=None):
        diag = {"severity": "error", "code": code,
                "pointer": pointer or "/", "message": message}
        if suggestions:
            diag["suggestions"] = list(suggestions)
        if counterexample is not None:
            diag["counterexample"] = counterexample
        if candidate_patches is None and suggestions and pointer and pointer != "/":
            if code in {"E_ENUM_VARIANT", "E_DATASET", "E_COMPONENT", "E_DATA_FIELD", "E_REFERENCE"}:
                candidate_patches = [
                    {
                        "description": f"Replace with '{cand}'",
                        "operations": [{"op": "replace", "path": pointer, "value": cand}],
                    }
                    for cand in suggestions[:2]
                ]
        if candidate_patches:
            diag["candidatePatches"] = list(candidate_patches)
        self.diagnostic = diag
        super().__init__(f"[{code}] {pointer or '/'}: {message}")


def fail(code, pointer, message, suggestions=None, counterexample=None, candidate_patches=None):
    raise LanguageError(
        code, pointer, message,
        suggestions=suggestions,
        counterexample=counterexample,
        candidate_patches=candidate_patches,
    )


_RP_FONT_CACHE = {}
_RP_FONT_PATHS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _get_rp_font(size):
    key = max(1, int(round(size or 12)))
    if key in _RP_FONT_CACHE:
        return _RP_FONT_CACHE[key]
    font = None
    try:
        import os as _os
        from PIL import ImageFont
        for p in _RP_FONT_PATHS:
            if _os.path.exists(p):
                try:
                    font = ImageFont.truetype(p, key)
                    break
                except Exception:
                    continue
    except Exception:
        font = None
    _RP_FONT_CACHE[key] = font
    return font


def measure_text_glyphs(text, font_size=12, font_weight=400):
    s = str(text or "")
    if not s:
        return {"width": 0.0, "height": round(font_size * 1.4, 1), "engine": "pil-pingfang"}
    f = _get_rp_font(font_size)
    if f is not None:
        try:
            bbox = f.getbbox(s)
            w = float(bbox[2] - bbox[0])
            h = float(bbox[3] - bbox[1])
            if font_weight and int(font_weight) >= 600:
                w *= 1.02
            return {"width": round(w, 1), "height": round(max(h, font_size * 1.35), 1), "engine": "pil-pingfang"}
        except Exception:
            pass
    return {"width": round(len(s) * font_size * 0.7, 1), "height": round(font_size * 1.4, 1), "engine": "fallback"}


def _estimate_visual_px(text, font_size=12, font_weight=400):
    s = str(text or "")
    if not s:
        return 0.0
    f = _get_rp_font(font_size)
    if f is not None:
        try:
            bbox = f.getbbox(s)
            w = float(bbox[2] - bbox[0])
            if font_weight and int(font_weight) >= 600:
                w *= 1.02
            return max(0.0, w - 6.0)
        except Exception:
            pass
    total = 0.0
    for ch in s:
        if ord(ch) > 127:
            total += font_size * 1.0
        elif ch == " ":
            total += font_size * 0.28
        elif ch in "ilj1.,:;|!'()[]{}":
            total += font_size * 0.32
        elif ch.isupper():
            total += font_size * 0.60
        else:
            total += font_size * 0.50
    return max(0.0, total - 6.0)


def ptr(path, key):
    return path + "/" + str(key).replace("~", "~0").replace("/", "~1")


MAX_SOURCE_DEPTH = 160


def validate_source_tree(spec):
    """Bound recursive compiler work before any deepcopy or normalization."""
    pending = [(spec, "", 0)]
    while pending:
        value, path, depth = pending.pop()
        if isinstance(value, (dict, list)):
            if depth > MAX_SOURCE_DEPTH:
                fail("E_DEPTH", path, f"Source nesting depth {depth} exceeds limit {MAX_SOURCE_DEPTH}",
                     counterexample={"depth": depth, "limit": MAX_SOURCE_DEPTH})
            entries = value.items() if isinstance(value, dict) else enumerate(value)
            pending.extend((child, ptr(path, key), depth + 1) for key, child in entries)
        elif isinstance(value, str) and re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
            fail("E_TEXT_CONTROL", path, "Text contains an unsupported control character")


def validate_statecharts(charts, path="/statecharts"):
    if not isinstance(charts, dict):
        fail("E_STATECHART", path, "statecharts must map names to statechart objects")
    for name, chart in charts.items():
        cp = ptr(path, name)
        if not isinstance(chart, dict):
            fail("E_STATECHART", cp, "Expected a statechart object")
        states = chart.get("states")
        if not isinstance(states, list) or not states or any(not isinstance(s, str) or not s for s in states):
            fail("E_STATECHART", ptr(cp, "states"), "Expected a nonempty array of state names")
        if len(set(states)) != len(states):
            fail("E_STATECHART", ptr(cp, "states"), "State names must be unique")
        if chart.get("initial") not in states:
            fail("E_STATECHART", ptr(cp, "initial"), "Initial state must be declared in states")
        transitions = chart.get("transitions", [])
        if not isinstance(transitions, list):
            fail("E_STATECHART", ptr(cp, "transitions"), "Expected a transition array")
        for i, transition in enumerate(transitions):
            tp = ptr(ptr(cp, "transitions"), i)
            if not isinstance(transition, dict):
                fail("E_STATECHART", tp, "Expected a transition object")
            for key in ("from", "to"):
                if transition.get(key) not in states:
                    fail("E_STATECHART", ptr(tp, key), "Transition state must be declared in states")
            if not isinstance(transition.get("on"), str) or not transition["on"]:
                fail("E_STATECHART", ptr(tp, "on"), "Transition requires an event name")
            if "guard" in transition and not isinstance(transition["guard"], (str, dict, bool)):
                fail("E_STATECHART", ptr(tp, "guard"), "Guard must be a boolean expression")


def validate_device(source, path):
    for key in ("device",):
        if key in source and (not isinstance(source[key], str) or source[key] not in DEVICE_CANVAS_PRESETS):
            fail("E_PROPERTY", ptr(path, key), f"Expected device in {sorted(DEVICE_CANVAS_PRESETS)}")


def _edit_distance(a, b):
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def fields(value, allowed, path):
    if not isinstance(value, dict):
        fail("E_OBJECT", path, "Expected an object")
    public_allowed = sorted(k for k in allowed if isinstance(k, str) and not k.startswith("_"))
    for key in value:
        if key not in allowed:
            raw_key = str(key)
            # 只接受真正可信的相近候选：编辑距离 <= 2，或首字母相同。
            # 宁可说"没有相近属性，可用的是..."，也不要给错误改名建议。
            rough = difflib.get_close_matches(raw_key.lower(), [a.lower() for a in public_allowed], n=3, cutoff=0.62)
            by_lower = {a.lower(): a for a in public_allowed}
            hint = [by_lower[r] for r in rough
                    if _edit_distance(raw_key.lower(), r) <= 2
                    or (raw_key[:1].lower() == r[:1].lower() and _edit_distance(raw_key.lower(), r) <= 4)]
            shown = public_allowed[:24]
            more = "" if len(public_allowed) <= 24 else f" …（共 {len(public_allowed)} 项）"
            if hint:
                suffix = f"; did you mean '{hint[0]}'?"
                tail = ""
            else:
                suffix = ""
                tail = f"; 该类型允许的属性：{', '.join(shown)}{more}"
            cands = None
            if hint:
                cands = [{
                    "description": f"Rename property '{key}' to '{h}'",
                    "operations": [
                        {"op": "remove", "path": ptr(path, key)},
                        {"op": "add", "path": ptr(path, h), "value": value[key]},
                    ],
                } for h in hint[:2]]
            fail("E_PROPERTY", ptr(path, key), f"Unknown property '{key}'{suffix}{tail}",
                 suggestions=hint or shown[:5], candidate_patches=cands)


def ident(value, path):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", value):
        fail("E_ID", path, "Expected an identifier matching [A-Za-z_][A-Za-z0-9_-]*")
    return value


SCALARS = {"text": str, "number": (int, float), "boolean": bool}
DOMAIN_SCALARS = {
    "id": "text",
    "enum": "text",
    "money": "number",
    "phone": "text",
    "date": "text",
    "percent": "number",
    "ref": "text",
}
THEMES = {"enterprise-light", "modern-dark", "cobalt-pro", "mobile-lowfi", "mobile-hifi",
          "aurora-glass", "editorial-warm", "cyber-neon"}
SPACING_TOKENS = [0, 1, 2, 3, 4] + list(range(6, 162, 2))
RADIUS_TOKENS = [0, 1, 2, 3, 4] + list(range(6, 122, 2)) + [999]
FONT_SIZE_TOKENS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 56, 64, 72, 80, 96, 120]
FONT_WEIGHT_TOKENS = [300, 400, 500, 600, 700, 800, 900]
MAX_FONT_SIZE = max(FONT_SIZE_TOKENS)


def validate_font_size(value, path):
    if type(value) not in (int, float) or not math.isfinite(value):
        fail("E_TYPE", path, "fontSize must be a finite number")
    if not 0 < value <= MAX_FONT_SIZE:
        fail("E_SIZE", path, f"fontSize must be greater than 0 and at most {MAX_FONT_SIZE}")
DEVICE_CANVAS_PRESETS = {
    "iphone-17": {"w": 402, "h": 874},
    "iphone-17-pro": {"w": 402, "h": 874},
    "iphone-16": {"w": 393, "h": 852},
    "iphone-16-pro": {"w": 393, "h": 852},
    "iphone-x": {"w": 375, "h": 812},
    "iphone-x-black": {"w": 375, "h": 812},
    "iphone-x-white": {"w": 375, "h": 812},
    "iphone-6-8": {"w": 375, "h": 667},
}
COLOR_TOKENS = {"bg", "surface", "surface-2", "surface-3", "sidebar-bg", "sidebar-surface",
                "sidebar-active", "sidebar-ink", "sidebar-ink-active", "ink", "ink-2", "ink-3",
                "ink-inv", "line", "line-strong", "brand", "brand-soft", "accent", "accent-soft",
                "success", "success-soft", "warning", "warning-soft", "danger", "danger-soft", "backdrop",
                "glass", "glass-strong", "glass-border", "glass-stroke", "glow", "glow-2"}
GEOMETRY = {"x", "y", "w", "h", "flex", "colSpan", "rowSpan", "right", "bottom", "anchor", "z",
            "after", "afterGap", "alignX", "pin", "pinGap"}
STYLE_EXTRAS = {"rotation", "opacity", "strokeWidth", "borderSides", "borderTop", "borderBottom", "borderLeft", "borderRight",
                "backdropBlur", "shadow", "gradient", "aurora", "noise", "innerGlow"}
TEXT = {"text", "fontFamily", "fontSize", "size", "fontWeight", "weight", "color", "align", "letterSpacing", "italic", "underline", "strikethrough", "spans"}
BOX = {"layout", "padding", "gap", "align", "justify", "wrap", "equalHeight", "columns",
       "columnGap", "rowGap", "children", "fill", "stroke", "radius"} | STYLE_EXTRAS
NODE_PROPS = {
    "box": BOX,
    "card": BOX | {"variant"},
    "label": TEXT | {"wrap", "lineGap", "lineHeight", "maxLines", "fill", "stroke", "radius"} | STYLE_EXTRAS,
    "paragraph": TEXT | {"lineGap", "lineHeight", "maxLines", "padding", "fill", "stroke", "radius"} | STYLE_EXTRAS,
    "button": TEXT | {"variant", "fill", "stroke", "radius", "icon"} | STYLE_EXTRAS,
    "badge": TEXT | {"variant", "fill", "stroke", "radius", "icon"} | STYLE_EXTRAS,
    "input": {"value", "placeholder", "native", "fill", "stroke", "radius", "fontSize", "size", "fontWeight", "weight", "color", "align", "textPaddingX"} | STYLE_EXTRAS,
    "divider": {"direction", "color", "fill", "opacity"},
    "image": {"src", "radius", "opacity", "shadow", "rotation"},
    "icon": {"icon", "color", "fill", "stroke", "radius", "strokeWidth"} | STYLE_EXTRAS,
    "sparkline": {"points", "color", "fill", "stroke", "radius", "smooth", "strokeWidth"} | STYLE_EXTRAS,
    "dynamic-panel": {"states"},
    "repeater": {"dataset", "key", "template", "rowGap", "rowHeight", "pageSize", "where"},
    "when": {"condition", "then", "else", "layout", "gap"},
}
EVENTS = {"click": "OnClick", "change": "OnTextChange", "load": "OnLoad",
          "mouseover": "OnMouseOver", "mouseout": "OnMouseOut",
          "focus": "OnFocus", "blur": "OnLostFocus",
          "statechange": "OnPanelStateChange", "selectedchange": "OnSelectedChange", "selectionchange": "OnSelectionChange"}
ACTION_PROPS = {
    "set-text": {"target", "text"},
    "set-variable": {"variable", "value"},
    "set-panel-state": {"target", "state"},
    "show": {"target"}, "hide": {"target"}, "toggle": {"target"},
    "enable": {"target"}, "disable": {"target"}, "focus": {"target"},
    "link": {"page"}, "wait": {"ms"},
    "set-size": {"target", "width", "height", "duration", "easing", "anchor"},
    "data-add": {"target", "rows"}, "data-delete": {"target", "where"},
    "data-update": {"target", "where", "set"}, "data-filter": {"target", "where", "name"},
    "data-clear-filter": {"target"}, "data-sort": {"target", "column", "direction"},
    "data-clear-sort": {"target"}, "data-page": {"target", "page"},
}


CARD_CONTENT_KEYS = ("title", "subtitle", "text", "body", "eyebrow", "tag", "badge", "rightBadge", "rightText", "meta", "actionText", "buttonText")
CARD_CONTENT_OPTIONS = ("tagTone", "badgeVariant", "rightTone", "titleFontSize", "actionVariant")
BOX_TEXT_STYLE_KEYS = ("fontSize", "fontWeight", "color")
BOX_TEXT_CONTAINER_KEYS = ("layout", "padding", "gap", "justify", "columns")
NODE_SOURCE_ALIASES = {
    "bg": "fill", "background": "fill", "textColor": "color", "fg": "color",
    "borderColor": "stroke", "borderWidth": "strokeWidth", "rounded": "radius", "borderRadius": "radius",
}

SHORTHAND_NODE_KINDS = {
    "box", "card", "row", "column", "grid", "stack", "label", "paragraph",
    "button", "badge", "input", "divider", "image", "icon", "sparkline", "dynamic-panel", "panel",
    "repeater", "repeat", "use", "when",
    "data-table", "searchable-list", "form-card", "kv-list",
    "detail-card", "wizard-card", "master-detail",
    "tab-bar", "nav-bar", "progress-bar", "phone-shell",
    "stat-row", "list-item",
}
FORM_KINDS = {"input", "radio", "checkbox", "combobox", "listbox"}
CHECK_KINDS = {"radio", "checkbox"}
OPTION_KINDS = {"combobox", "listbox"}
STATE_STYLE_KEYS = {"fill", "stroke", "color", "fontFamily", "fontSize", "fontWeight", "radius", "strokeWidth", "opacity"}
FORM_STYLE = {"fill", "stroke", "color", "fontFamily", "fontSize", "fontWeight", "radius", "strokeWidth", "align", "textPaddingX"}
for _kind in sorted(CHECK_KINDS):
    NODE_PROPS[_kind] = FORM_STYLE | {"text", "checked"} | ({"group"} if _kind == "radio" else set())
for _kind in sorted(OPTION_KINDS):
    NODE_PROPS[_kind] = FORM_STYLE | {"options", "selectedIndex"} | ({"multiple", "selectedIndices"} if _kind == "listbox" else set())
for _kind in FORM_KINDS | {"label", "paragraph", "button", "badge"}:
    NODE_PROPS[_kind] |= {"styles", "selected", "disabled", "selectionGroup"}
SHORTHAND_NODE_KINDS |= FORM_KINDS | {"droplist"}
ACTION_PROPS.update({"set-check": {"target", "checked"}, "set-selected": {"target", "selected"}, "set-option": {"target", "value"}})

EVENT_SHORTHANDS = {
    "onClick": "click", "onChange": "change", "onLoad": "load",
    "onMouseOver": "mouseover", "onMouseOut": "mouseout",
    "onFocus": "focus", "onBlur": "blur", "onStateChange": "statechange",
}
# Source contracts are shared with the editor schema; expansion must not erase input.
MACRO_COMMON_PROPS = {"type", "id", "name", "on", "size", "slots", "when", "visible", "hidden"} | GEOMETRY | set(EVENT_SHORTHANDS)
MACRO_PROPS = {
    "data-table": MACRO_COMMON_PROPS | {"dataset", "key", "columns", "rowHeight", "headerHeight", "columnGap", "gap", "padding", "headerFill", "headerStroke", "headerRadius", "rowFill", "rowStroke", "rowRadius", "rowOn", "onRowClick", "repeaterHeight", "rowGap", "pageSize", "tableGap"},
    "searchable-list": MACRO_COMMON_PROPS | {"dataset", "key", "searchField", "filterField", "filterWhere", "baseWhere", "template", "inputId", "value", "inputHeight", "inputFill", "inputStroke", "inputRadius", "filters", "repeaterHeight", "rowHeight", "rowGap", "pageSize", "gap", "padding", "fill", "stroke", "radius"},
    "form-card": MACRO_COMMON_PROPS | {"fields", "title", "titleFontSize", "submitText", "onSubmit", "submitId", "submitHeight", "submitVariant", "padding", "gap", "fill", "stroke", "radius"},
    "kv-list": MACRO_COMMON_PROPS | {"items", "rowHeight", "labelWidth", "fontSize", "padding", "gap", "fill", "stroke", "radius"},
    "detail-card": MACRO_COMMON_PROPS | {"title", "subtitle", "badge", "items", "actions", "rowHeight", "labelWidth", "fontSize", "padding", "gap", "fill", "stroke", "radius"},
    "wizard-card": MACRO_COMMON_PROPS | {"title", "stepVariable", "steps", "bodyHeight", "onComplete", "padding", "gap", "fill", "stroke", "radius"},
    "master-detail": MACRO_COMMON_PROPS | {"master", "detail", "masterWidth", "listWidth", "dataset", "key", "searchField", "filterField", "filters", "template", "repeaterHeight", "rowHeight", "rowGap", "gap", "padding", "fill", "stroke", "radius"},
    "tab-bar": MACRO_COMMON_PROPS | {"items", "tabs", "active", "activeIndex", "gap", "padding", "fill", "stroke", "radius", "activeFill", "activeColor", "inactiveFill", "inactiveColor", "fontSize", "itemHeight", "activeVariant", "activeIndicator", "justify", "itemFlex"},
    "nav-bar": MACRO_COMMON_PROPS | {"title", "text", "subtitle", "back", "backText", "backPage", "backGoto", "onBack", "right", "rightText", "rightPage", "rightGoto", "onRight", "actions", "padding", "gap", "fill", "stroke", "radius", "titleFontSize", "color"},
    "progress-bar": MACRO_COMMON_PROPS | {"value", "max", "percent", "label", "text", "rightText", "showValue", "barHeight", "trackHeight", "trackColor", "trackFill", "barColor", "barFill", "fill", "color", "stroke", "radius", "gap"},
    "phone-shell": MACRO_COMMON_PROPS | {
        "device", "title", "subtitle", "navBar", "tabBar", "statusBar",
        "time", "timeText", "statusRight", "statusText",
        "darkIsland", "showHomeIndicator", "screenFill", "frameFill",
        "right", "rightText", "rightPage", "rightGoto", "onRight",
        "back", "backText", "backPage", "backGoto", "onBack",
        "padding", "gap", "children", "body", "fill", "stroke", "radius",
        "justify", "align",
    },
    "stat-row": MACRO_COMMON_PROPS | {"items", "gap", "padding", "cardPadding", "fill", "stroke", "radius", "valueFontSize", "equalHeight"},
    "list-item": MACRO_COMMON_PROPS | {"title", "text", "subtitle", "tag", "badge", "badgeVariant", "tagTone", "tone", "index", "icon", "rightText", "meta", "value", "status", "rightBadge", "rightVariant", "rightTone", "goto", "page", "link", "padding", "gap", "fill", "stroke", "radius"},
}
MACRO_ITEM_PROPS = {
    "data-table": {"columns": {"header", "title", "field", "align", "headerAlign", "width", "w", "flex", "headerId", "headerFontSize", "headerFontWeight", "headerColor", "cell", "kind", "text", "id", "h", "font", "fontSize", "fontWeight", "color", "variant", "fill", "stroke", "radius", "on", "onClick"}},
    "searchable-list": {"filters": {"label", "text", "value", "all"}},
    "form-card": {"fields": {"id", "label", "value", "h", "fill", "stroke", "radius"}},
    "kv-list": {"items": {"id", "label", "key", "value", "text", "fontWeight", "color", "align"}},
    "detail-card": {
        "items": {"id", "label", "key", "value", "text", "fontWeight", "color", "align"},
        "actions": {"id", "text", "variant", "w", "h", "on", "onClick", "when"},
    },
    "wizard-card": {
        "steps": {"id", "title", "body", "root", "nextText", "prevText", "guard", "nextWhen", "guardMessage", "errorText", "errorMessage", "onNext"},
    },
    "master-detail": {"filters": {"label", "text", "value", "all"}},
    "tab-bar": {
        "items": {"id", "text", "label", "title", "page", "goto", "link", "active", "on", "onClick", "icon", "variant", "flex", "w", "h", "radius", "fontSize", "fontWeight", "fill", "color", "stroke"},
        "tabs": {"id", "text", "label", "title", "page", "goto", "link", "active", "on", "onClick", "icon", "variant", "flex", "w", "h", "radius", "fontSize", "fontWeight", "fill", "color", "stroke"},
    },
    "nav-bar": {
        "actions": {"id", "label", "text", "variant", "w", "h", "radius", "fontSize", "fontWeight", "on", "onClick", "goto", "page", "link"},
    },
    "progress-bar": {},
    "phone-shell": {},
    "stat-row": {
        "items": {"id", "label", "title", "value", "text", "sub", "subtitle", "trend", "color", "subColor", "fill", "stroke", "radius", "valueFontSize", "on", "onClick", "goto", "page", "link"},
    },
    "list-item": {},
}
MACRO_SLOTS = {
    "data-table": {"header", "toolbar", "rowActions", "empty", "emptyState", "footer"},
    "searchable-list": {"header", "toolbar", "filterBar", "rowActions", "empty", "emptyState", "footer"},
    "form-card": {"header", "toolbar", "extraFields", "actions", "footer"},
    "kv-list": {"header", "footer"},
    "detail-card": {"header", "badge", "body", "actions", "footer"},
    "wizard-card": {"header", "stepper", "body", "actions", "footer"},
    "master-detail": {"header", "toolbar", "master", "detailHeader", "detailFooter", "footer"},
}
DINGBAT_SAFE_MAP = str.maketrans({
    "\u2713": "●", "\u2714": "●", "\u2717": "×", "\u2718": "×",
    "\u26a1": "▲", "\u2728": "★", "\u2b50": "★", "\U0001f525": "●", "\U0001f680": "▲",
})
INLINE_EXPR_HINT_RE = re.compile(
    r"(\$[A-Za-z_]|@[A-Za-z_]|(?<![A-Za-z0-9_])(item|row|caller|var|widget|param)\.[A-Za-z_]"
    r"|==|!=|>=|<=|&&|\|\||[><+\-*/!]"
    r"|\b(not|number|length|text|lower|upper|concat)\s*\()"
)
TOKEN_RE = re.compile(
    r"""\s*(?:"""
    r"""(?P<OP2>===|!==|==|!=|>=|<=|&&|\|\|)|"""
    r"""(?P<NUMBER>\d+(?:\.\d+)?)|"""
    r"""(?P<STRING>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|"""
    r"""(?P<SIGIL>@[A-Za-z_][A-Za-z0-9_-]*(?:[./][A-Za-z_][A-Za-z0-9_-]*)*|\$[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)|"""
    r"""(?P<IDENT>[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)|"""
    r"""(?P<OP1>[+\-*/><!(),.])"""
    r""")"""
)


def sanitize_dingbats(val):
    return val


def tokenize_inline_expr(text, path):
    pos, tokens = 0, []
    while pos < len(text):
        if text[pos].isspace():
            pos += 1
            continue
        m = TOKEN_RE.match(text, pos)
        if not m:
            fail("E_EXPRESSION", path, f"Invalid expression syntax near '{text[pos:pos+16]}'")
        pos = m.end()
        kind = m.lastgroup
        raw = m.group(kind)
        if kind == "NUMBER":
            tokens.append(("NUMBER", float(raw) if "." in raw else int(raw)))
        elif kind == "STRING":
            inner = raw[1:-1].replace(r"\'", "'").replace(r'\"', '"').replace(r"\\", "\\").replace(r"\n", "\n")
            tokens.append(("STRING", sanitize_dingbats(inner)))
        else:
            # RP/1 compares statically matching operand types. Accept the
            # browser's strict spelling without changing quoted literals.
            if kind == "OP2":
                raw = {"===": "==", "!==": "!="}.get(raw, raw)
            tokens.append((kind, raw))
    return tokens


def parse_inline_expr(expr_text, path, prefer_condition=False):
    # prefer_condition: 兼容调用方语义（条件式取值），当前解析器行为一致，保留参数以便后续区分。
    if not isinstance(expr_text, str):
        fail("E_EXPRESSION", path, "Inline expression must be text")
    s = expr_text.strip()
    if s.startswith("[[") and s.endswith("]]"):
        s = s[2:-2].strip()
    if s.startswith("=") and not s.startswith("=="):
        s = s[1:].strip()
    if not s:
        fail("E_EXPRESSION", path, "Empty inline expression")
    tokens = tokenize_inline_expr(s, path)
    idx = [0]

    def peek():
        return tokens[idx[0]] if idx[0] < len(tokens) else (None, None)

    def consume(expected_val=None):
        tok = peek()
        if tok[0] is None:
            fail("E_EXPRESSION", path, "Unexpected end of expression")
        if expected_val is not None and tok[1] != expected_val:
            fail("E_EXPRESSION", path, f"Expected '{expected_val}', got '{tok[1]}'")
        idx[0] += 1
        return tok

    def _ident_node(tok_val):
        if tok_val in ("true", "True"):
            return True
        if tok_val in ("false", "False"):
            return False
        if "." in tok_val:
            head, rest = tok_val.split(".", 1)
            if head in ("row", "Item", "TargetItem") and "." not in rest:
                return {"item": rest}
            if head == "caller" and "." not in rest:
                return {"caller": rest}
            if head in ("var", "variable") and "." not in rest:
                return {"variable": rest}
            if head == "widget" and "." not in rest:
                return {"widget": {"ref": rest}}
            if head == "param":
                return {"$": rest}
            return {"_auto_path": tok_val}
        return {"_auto_ident": tok_val}

    def _apply_method(recv, m_name, args):
        if m_name == "toString" and len(args) == 0:
            return {"fn": "text", "args": [recv]}
        if m_name == "toLowerCase" and len(args) == 0:
            return {"fn": "lower", "args": [recv]}
        if m_name == "toUpperCase" and len(args) == 0:
            return {"fn": "upper", "args": [recv]}
        if m_name == "concat" and len(args) >= 1:
            return {"fn": "concat", "args": [recv, *args]}
        if m_name == "replace" and len(args) == 2 and args[1] == "":
            return {"fn": "remove", "args": [recv, args[0]]}
        if m_name == "indexOf" and len(args) == 1:
            return {"_index_of": (recv, args[0])}
        fail("E_EXPRESSION", path, f"Unsupported method '.{m_name}()' in expression")

    def parse_or():
        left = parse_and()
        while peek()[1] == "||":
            consume("||")
            right = parse_and()
            if right == 0 and isinstance(left, dict) and (left.get("fn") == "number" or (left.get("op") == "*" and left.get("right") == 1)):
                inner = left["args"][0] if left.get("fn") == "number" else left["left"]
                left = {"fn": "number", "args": [inner]}
            else:
                left = {"op": "||", "left": left, "right": right}
        return left

    def parse_and():
        left = parse_eq()
        while peek()[1] == "&&":
            consume("&&")
            left = {"op": "&&", "left": left, "right": parse_eq()}
        return left

    def parse_eq():
        left = parse_cmp()
        while peek()[1] in ("==", "!="):
            op = consume()[1]
            left = {"op": op, "left": left, "right": parse_cmp()}
        return left

    def parse_cmp():
        left = parse_add()
        while peek()[1] in (">", "<", ">=", "<="):
            op = consume()[1]
            right = parse_add()
            if isinstance(left, dict) and "_index_of" in left:
                recv, sub = left["_index_of"]
                if op == ">=" and right == 0:
                    left = {"fn": "contains", "args": [recv, sub]}
                    continue
                if op == "<" and right == 0:
                    left = {"fn": "not", "args": [{"fn": "contains", "args": [recv, sub]}]}
                    continue
            left = {"op": op, "left": left, "right": right}
        return left

    def parse_add():
        left = parse_mul()
        while peek()[1] in ("+", "-"):
            op = consume()[1]
            node = {"op": op, "left": left, "right": parse_mul()}
            if op == "+":
                node["_inline_plus"] = True
            left = node
        return left

    def parse_mul():
        left = parse_unary()
        while peek()[1] in ("*", "/"):
            op = consume()[1]
            right = parse_unary()
            if op == "*" and right == 1 and isinstance(left, dict) and (
                "widget" in left or left.get("fn") in ("text", "lower", "upper", "concat", "remove")
            ):
                left = {"fn": "number", "args": [left]}
            else:
                left = {"op": op, "left": left, "right": right}
        return left

    def parse_unary():
        tok_kind, tok_val = peek()
        if tok_val == "!":
            consume("!")
            return {"fn": "not", "args": [parse_unary()]}
        if tok_val == "-":
            consume("-")
            inner = parse_unary()
            if type(inner) in (int, float) and not isinstance(inner, bool):
                return -inner
            return {"op": "-", "left": 0, "right": inner}
        if tok_val == "+":
            consume("+")
            return parse_unary()
        return parse_postfix()

    def parse_postfix():
        node = parse_primary()
        while peek()[1] == ".":
            consume(".")
            m_kind, m_raw = consume()
            if m_kind != "IDENT":
                fail("E_EXPRESSION", path, f"Expected property/method name after '.', got '{m_raw}'")
            parts = m_raw.split(".")
            for idx_p, seg in enumerate(parts):
                is_last = idx_p == len(parts) - 1
                if is_last and peek()[1] == "(":
                    consume("(")
                    args = []
                    if peek()[1] != ")":
                        args.append(parse_or())
                        while peek()[1] == ",":
                            consume(",")
                            args.append(parse_or())
                    consume(")")
                    node = _apply_method(node, seg, args)
                elif seg == "length":
                    node = {"fn": "length", "args": [node]}
                else:
                    fail("E_EXPRESSION", path, f"Unsupported property '.{seg}' in expression")
        return node

    def parse_primary():
        tok_kind, tok_val = peek()
        if tok_kind is None:
            fail("E_EXPRESSION", path, "Unexpected end of expression")
        if tok_val == "(":
            consume("(")
            expr = parse_or()
            consume(")")
            return expr
        if tok_kind in ("NUMBER", "STRING"):
            consume()
            return tok_val
        if tok_kind == "SIGIL":
            consume()
            sigil, name = tok_val[0], tok_val[1:]
            if peek()[1] == "(" and "." in name:
                base_name, m_name = name.rsplit(".", 1)
                recv = {"widget": {"ref": base_name}} if sigil == "@" else ({"_auto_path": base_name} if "." in base_name else {"_sigil_var": base_name})
                consume("(")
                args = []
                if peek()[1] != ")":
                    args.append(parse_or())
                    while peek()[1] == ",":
                        consume(",")
                        args.append(parse_or())
                consume(")")
                return _apply_method(recv, m_name, args)
            if name.endswith(".length") and len(name) > 7:
                base_name = name[:-7]
                recv = {"widget": {"ref": base_name}} if sigil == "@" else ({"_auto_path": base_name} if "." in base_name else {"_sigil_var": base_name})
                return {"fn": "length", "args": [recv]}
            if sigil == "@":
                return {"widget": {"ref": name}}
            if "." in name:
                return {"_auto_path": name}
            return {"_sigil_var": name}
        if tok_kind == "IDENT":
            consume()
            if peek()[1] == "(":
                consume("(")
                args = []
                if peek()[1] != ")":
                    args.append(parse_or())
                    while peek()[1] == ",":
                        consume(",")
                        args.append(parse_or())
                consume(")")
                if "." in tok_val:
                    base_ident, m_name = tok_val.rsplit(".", 1)
                    return _apply_method(_ident_node(base_ident), m_name, args)
                return {"fn": tok_val, "args": args}
            if tok_val.endswith(".length") and "." in tok_val:
                base_ident = tok_val[:-7]
                return {"fn": "length", "args": [_ident_node(base_ident)]}
            return _ident_node(tok_val)
        fail("E_EXPRESSION", path, f"Unexpected token '{tok_val}' in expression")

    ast = parse_or()
    if idx[0] < len(tokens):
        fail("E_EXPRESSION", path, f"Unexpected trailing token '{tokens[idx[0]][1]}'")
    return ast


def parse_template_string(text, path):
    if isinstance(text, str) and text.startswith("=") and not text.startswith("=="):
        text = text[1:]
    pieces = []
    i, n = 0, len(text)
    buf = []
    while i < n:
        if text[i] == "$" and i + 1 < n and text[i + 1] == "{":
            if buf:
                pieces.append(sanitize_dingbats("".join(buf)))
                buf = []
            i += 2
            depth = 1
            start = i
            quote = None
            while i < n and depth > 0:
                ch = text[i]
                if quote:
                    if ch == "\\" and i + 1 < n:
                        i += 2
                        continue
                    if ch == quote:
                        quote = None
                else:
                    if ch in ("'", '"'):
                        quote = ch
                    elif ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            break
                i += 1
            if depth != 0:
                fail("E_EXPRESSION", path, "Unclosed ${...} template expression")
            expr_str = text[start:i].strip()
            i += 1
            ast = parse_inline_expr(expr_str, path)
            pieces.append({"_coerce_text": ast})
        else:
            buf.append(text[i])
            i += 1
    if buf:
        pieces.append(sanitize_dingbats("".join(buf)))
    if not pieces:
        return ""
    if len(pieces) == 1 and isinstance(pieces[0], str):
        return pieces[0]
    return {"_template_parts": pieces}


FONT_WEIGHT_KEYWORDS = {
    "thin": 100,
    "extralight": 200,
    "ultralight": 200,
    "light": 300,
    "normal": 400,
    "regular": 400,
    "book": 400,
    "medium": 500,
    "semibold": 600,
    "demibold": 600,
    "bold": 700,
    "extrabold": 800,
    "ultrabold": 800,
    "black": 900,
    "heavy": 900,
}

JUSTIFY_ALIASES = {
    "between": "space-between",
    "space_between": "space-between",
    "around": "space-around",
    "space_around": "space-around",
    "evenly": "space-evenly",
    "space_evenly": "space-evenly",
    "flex-start": "start",
    "flex-end": "end",
    "left": "start",
    "right": "end",
    "top": "start",
    "bottom": "end",
    "middle": "center",
}

BOX_ALIGN_ALIASES = {
    "flex-start": "start",
    "flex-end": "end",
    "top": "start",
    "bottom": "end",
    "left": "start",
    "right": "end",
    "middle": "center",
    "baseline": "center",
}

TEXT_ALIGN_ALIASES = {
    "start": "left",
    "flex-start": "left",
    "end": "right",
    "flex-end": "right",
    "middle": "center",
}

COLOR_TOKEN_ALIASES = {
    "$ok": "$success",
    "$ok-soft": "$success-soft",
    "$warn": "$warning",
    "$warn-soft": "$warning-soft",
    "$err": "$danger",
    "$err-soft": "$danger-soft",
    "$error": "$danger",
    "$error-soft": "$danger-soft",
    "$primary": "$brand",
    "$primary-soft": "$brand-soft",
    "$border": "$line",
    "$border-strong": "$line-strong",
    "$muted": "$ink-2",
    "$text": "$ink",
    "$text-2": "$ink-2",
    "$text-3": "$ink-3",
    "$white": "$surface",
}


def normalize_color_token(val):
    if isinstance(val, str):
        s = val.strip()
        if s.lower() in COLOR_TOKEN_ALIASES:
            return COLOR_TOKEN_ALIASES[s.lower()]
    return val


def normalize_font_weight(val):
    if isinstance(val, str):
        s = val.strip().lower().replace("-", "").replace("_", "")
        if s in FONT_WEIGHT_KEYWORDS:
            return FONT_WEIGHT_KEYWORDS[s]
        if s.isdigit():
            return int(s)
    return val


def parse_font_shorthand(font_str, target, path):
    if not isinstance(font_str, str) or not font_str.strip():
        fail("E_TYPE", path, "font shorthand must be a nonempty string")
    for token in font_str.strip().split():
        m = re.fullmatch(r"(\d+)(?:/([A-Za-z0-9_-]+))?", token)
        if m:
            target.setdefault("fontSize", int(m.group(1)))
            if m.group(2) is not None:
                w_val = normalize_font_weight(m.group(2))
                if isinstance(w_val, int):
                    target.setdefault("fontWeight", w_val)
                else:
                    fail("E_ENUM", path, f"Unrecognized font weight '{m.group(2)}'")
        elif token.startswith("$") or token.startswith("#"):
            target.setdefault("color", token)
        elif token in ("left", "center", "right"):
            target.setdefault("align", token)
        elif isinstance(normalize_font_weight(token), int) and not token.isdigit():
            target.setdefault("fontWeight", normalize_font_weight(token))
        else:
            fail("E_ENUM", path, f"Unrecognized font token '{token}'")


def expand_data_table_macro(source, path):
    table_id = ident(source.get("id"), ptr(path, "id"))
    dataset = source.get("dataset")
    key = source.get("key", "id")
    cols = source.get("columns")
    if not isinstance(cols, list) or not cols:
        fail("E_PROPERTY_REQUIRED", ptr(path, "columns"), "data-table requires a nonempty columns array")
    row_h = source.get("rowHeight", 56)
    header_h = source.get("headerHeight", 42)
    col_gap = source.get("columnGap", source.get("gap", 12))
    row_pad = source.get("padding", [0, 16, 0, 16])
    header_children, row_children = [], []
    for idx, col in enumerate(cols):
        cp = ptr(ptr(path, "columns"), idx)
        if not isinstance(col, dict):
            fail("E_OBJECT", cp, "Column must be an object")
        h_text = col.get("header", col.get("title", col.get("field", f"Col {idx+1}")))
        col_align = col.get("align", "left")
        h_align = col.get("headerAlign", col_align)
        sizing = {}
        if "width" in col or "w" in col:
            sizing["w"] = col.get("width", col.get("w"))
        else:
            sizing["flex"] = col.get("flex", 1)
        header_children.append({
            "type": "label",
            "id": col.get("headerId", f"{table_id}_hcol_{idx+1}"),
            "text": h_text,
            "fontSize": col.get("headerFontSize", 12),
            "fontWeight": col.get("headerFontWeight", 700),
            "color": col.get("headerColor", "$ink-2"),
            "align": h_align,
            "h": 20,
            **sizing,
        })
        if "cell" in col and isinstance(col["cell"], dict):
            cell_node = copy.deepcopy(col["cell"])
            if "w" not in cell_node and "flex" not in cell_node and "size" not in cell_node:
                cell_node.update(sizing)
            row_children.append(cell_node)
        else:
            cell_kind = col.get("kind", "label")
            cell_text = col.get("text")
            if cell_text is None and "field" in col:
                cell_text = f"${{item.{col['field']}}}"
            cell_node = {
                "type": cell_kind,
                "id": col.get("id", f"{table_id}_col_{idx+1}"),
                "text": cell_text if cell_text is not None else "",
                "align": col_align,
                "h": col.get("h", 24 if cell_kind == "badge" else 22),
                **sizing,
            }
            if "font" in col:
                cell_node["font"] = col["font"]
            else:
                cell_node["fontSize"] = col.get("fontSize", 12 if cell_kind == "badge" else 13)
                cell_node["fontWeight"] = col.get("fontWeight", 600 if cell_kind == "badge" else 400)
                if "color" in col:
                    cell_node["color"] = col["color"]
            for extra_k in ("variant", "fill", "stroke", "radius", "on", "onClick"):
                if extra_k in col:
                    cell_node[extra_k] = copy.deepcopy(col[extra_k])
            row_children.append(cell_node)
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    if "rowActions" in slots and isinstance(slots["rowActions"], dict):
        act_col = copy.deepcopy(slots["rowActions"])
        act_col["_slot_origin"] = ptr(ptr(path, "slots"), "rowActions")
        act_w = act_col.get("w", 120)
        act_col.setdefault("w", act_w)
        header_children.append({
            "type": "label",
            "id": f"{table_id}_hcol_actions",
            "text": "操作",
            "fontSize": 12,
            "fontWeight": 700,
            "color": "$ink-2",
            "align": "right",
            "h": 20,
            "w": act_w,
        })
        row_children.append(act_col)
    header_box = {
        "type": "box",
        "id": f"{table_id}_header",
        "layout": "row",
        "w": "fill",
        "h": header_h,
        "padding": copy.deepcopy(row_pad),
        "gap": col_gap,
        "align": "center",
        "fill": source.get("headerFill", "$surface-2"),
        "stroke": source.get("headerStroke", "$line"),
        "radius": source.get("headerRadius", 8),
        "children": header_children,
    }
    row_template = {
        "type": "box",
        "id": f"{table_id}_row",
        "layout": "row",
        "w": "fill",
        "h": row_h,
        "padding": copy.deepcopy(row_pad),
        "gap": col_gap,
        "align": "center",
        "fill": source.get("rowFill", "$surface"),
        "stroke": source.get("rowStroke", "$line"),
        "radius": source.get("rowRadius", 0),
        "children": row_children,
    }
    if "rowOn" in source:
        row_template["on"] = copy.deepcopy(source["rowOn"])
    if "onRowClick" in source:
        row_template.setdefault("on", {})["click"] = copy.deepcopy(source["onRowClick"])
    rep_node = {
        "type": "repeater",
        "id": table_id,
        "dataset": dataset,
        "key": key,
        "w": "fill",
        "h": source.get("repeaterHeight", "hug"),
        "rowHeight": row_h,
        "rowGap": source.get("rowGap", 0),
        "template": row_template,
    }
    if "pageSize" in source:
        rep_node["pageSize"] = source["pageSize"]
    outer_children = []
    for sk in ("header", "toolbar"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            outer_children.append(snode)
    outer_children.extend([header_box, rep_node])
    for sk in ("empty", "emptyState", "footer"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            outer_children.append(snode)
    outer = {
        "type": "box",
        "id": f"{table_id}_table",
        "layout": "column",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "gap": source.get("tableGap", 0),
        "children": outer_children,
    }
    for gk in ("x", "y", "flex"):
        if gk in source:
            outer[gk] = source[gk]
    return outer


def expand_searchable_list_macro(source, path, filter_variable=None):
    list_id = ident(source.get("id"), ptr(path, "id"))
    dataset = source.get("dataset")
    key = source.get("key", "id")
    search_field = source.get("searchField")
    if not isinstance(search_field, str) or not search_field:
        fail("E_PROPERTY_REQUIRED", ptr(path, "searchField"), "searchable-list requires searchField")
    template = source.get("template")
    if not isinstance(template, dict):
        fail("E_PROPERTY_REQUIRED", ptr(path, "template"), "searchable-list requires a template node")
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    input_id = source.get("inputId", f"{list_id}_search")
    filter_where = source.get("filterWhere", {
        "op": "==", "left": {"fn": "lower", "args": [{"item": search_field}]},
        "right": {"fn": "lower", "args": [{"widget": input_id}]},
    })
    # A single native filter owns both dimensions. RP 9 replaces other filters
    # by default, so two independent reference-only filter labels are unsafe.
    search_where = {"op": "||", "left": {"op": "==", "left": {"fn": "length", "args": [{"widget": input_id}]}, "right": 0}, "right": filter_where}
    category_where = {"op": "==", "left": {"variable": filter_variable}, "right": -1} if filter_variable else True
    normalized_filters = []
    for idx, item in enumerate(source.get("filters", [])):
        if isinstance(item, str):
            label, value, is_all = item, item, idx == 0 and item in ("全部", "All", "all", "*")
        else:
            label = item.get("label", item.get("text", item.get("value", f"Filter {idx+1}")))
            value, is_all = item.get("value", label), item.get("all", False)
        normalized_filters.append((label, value, is_all))
        if not is_all:
            category_where = {"op": "||", "left": category_where, "right": {
                "op": "&&", "left": {"op": "==", "left": {"variable": filter_variable}, "right": idx},
                "right": {"op": "==", "left": {"item": source.get("filterField", search_field)}, "right": value}}}
    combined_where = {"op": "&&", "left": search_where, "right": category_where}
    if "baseWhere" in source and source["baseWhere"] is not None:
        combined_where = {"op": "&&", "left": copy.deepcopy(source["baseWhere"]), "right": combined_where}
    apply_filter = {"type": "data-filter", "target": list_id, "name": "search_category_filter", "where": combined_where}
    search_input = {
        "type": "input",
        "id": input_id,
        "value": source.get("value", ""),
        "w": "fill",
        "h": source.get("inputHeight", 36),
        "fill": source.get("inputFill", "$surface"),
        "stroke": source.get("inputStroke", "$line"),
        "radius": source.get("inputRadius", 6),
        "onChange": copy.deepcopy(apply_filter),
    }
    children = []
    for sk in ("header", "toolbar"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    children.append(search_input)
    if "filterBar" in slots and isinstance(slots["filterBar"], dict):
        snode = copy.deepcopy(slots["filterBar"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "filterBar")
        children.append(snode)
    filters = source.get("filters")
    filter_field = source.get("filterField", search_field)
    if isinstance(filters, list) and filters:
        pill_nodes = []
        for idx, (f_label, f_val, f_all) in enumerate(normalized_filters):
            btn_act = [{"type": "set-variable", "variable": filter_variable, "value": -1 if f_all else idx}, copy.deepcopy(apply_filter)]
            pill_nodes.append({
                "type": "button",
                "id": f"{list_id}_filter_{idx}",
                "text": str(f_label),
                "w": max(48, len(str(f_label)) * 14 + 20),
                "h": 30,
                "fontSize": 12,
                "fontWeight": 500,
                "variant": "primary" if idx == 0 else "outline",
                "radius": 6,
                "onClick": btn_act,
            })
        children.append({
            "type": "box",
            "id": f"{list_id}_filters",
            "layout": "row",
            "w": "fill",
            "h": 32,
            "gap": 8,
            "align": "center",
            "children": pill_nodes,
        })
    tpl_copy = copy.deepcopy(template)
    if "rowActions" in slots and isinstance(slots["rowActions"], dict) and isinstance(tpl_copy.get("children"), list):
        ra_node = copy.deepcopy(slots["rowActions"])
        ra_node["_slot_origin"] = ptr(ptr(path, "slots"), "rowActions")
        tpl_copy["children"].append(ra_node)
    _raw_rh = source.get("rowHeight", 64)
    _tpl_h = tpl_copy.get("h")
    if isinstance(_raw_rh, (int, float)) and isinstance(_tpl_h, (int, float)) and _tpl_h > _raw_rh:
        _raw_rh = _tpl_h
    rep_node = {
        "type": "repeater",
        "id": list_id,
        "dataset": dataset,
        "key": key,
        "w": "fill",
        "h": source.get("repeaterHeight", "hug"),
        "rowHeight": _raw_rh,
        "rowGap": source.get("rowGap", 8),
        "template": tpl_copy,
    }
    if "pageSize" in source:
        rep_node["pageSize"] = source["pageSize"]
    children.append(rep_node)
    for sk in ("empty", "emptyState", "footer"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    outer = {
        "type": "box",
        "id": f"{list_id}_list",
        "layout": "column",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "gap": source.get("gap", 12),
        "children": children,
    }
    for gk in ("x", "y", "flex", "padding", "fill", "stroke", "radius"):
        if gk in source:
            outer[gk] = copy.deepcopy(source[gk])
    return outer


def expand_form_card_macro(source, path):
    form_id = ident(source.get("id"), ptr(path, "id"))
    raw_fields = source.get("fields")
    if not isinstance(raw_fields, list) or not raw_fields:
        fail("E_PROPERTY_REQUIRED", ptr(path, "fields"), "form-card requires a nonempty fields array")
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    children = []
    if "title" in source:
        children.append({
            "type": "label",
            "id": f"{form_id}_title",
            "text": source["title"],
            "w": "fill",
            "h": 24,
            "fontSize": source.get("titleFontSize", 16),
            "fontWeight": 700,
            "color": "$ink",
        })
    for sk in ("header", "toolbar"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    for idx, fld in enumerate(raw_fields):
        fp = ptr(ptr(path, "fields"), idx)
        if not isinstance(fld, dict):
            fail("E_OBJECT", fp, "Form field must be an object")
        fid = ident(fld.get("id", f"{form_id}_field_{idx+1}"), ptr(fp, "id"))
        flabel = fld.get("label", fid)
        fval = fld.get("value", "")
        inp_h = fld.get("h", 36)
        children.append({
            "type": "box",
            "id": f"{fid}_group",
            "layout": "column",
            "w": "fill",
            "h": inp_h + 22,
            "gap": 4,
            "children": [
                {
                    "type": "label",
                    "id": f"{fid}_label",
                    "text": flabel,
                    "w": "fill",
                    "h": 18,
                    "fontSize": 12,
                    "fontWeight": 600,
                    "color": "$ink-2",
                },
                {
                    "type": "input",
                    "id": fid,
                    "value": fval,
                    "w": "fill",
                    "h": inp_h,
                    "fill": fld.get("fill", "$surface"),
                    "stroke": fld.get("stroke", "$line"),
                    "radius": fld.get("radius", 6),
                },
            ],
        })
    if "extraFields" in slots and isinstance(slots["extraFields"], dict):
        snode = copy.deepcopy(slots["extraFields"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "extraFields")
        children.append(snode)
    if "submitText" in source or "onSubmit" in source:
        submit_btn = {
            "type": "button",
            "id": source.get("submitId", f"{form_id}_submit"),
            "text": source.get("submitText", "提交"),
            "w": "fill",
            "h": source.get("submitHeight", 40),
            "variant": source.get("submitVariant", "primary"),
            "radius": 6,
        }
        if "onSubmit" in source:
            submit_btn["onClick"] = copy.deepcopy(source["onSubmit"])
        children.append(submit_btn)
    for sk in ("actions", "footer"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    outer = {
        "type": "card",
        "id": form_id,
        "layout": "column",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "padding": source.get("padding", 16),
        "gap": source.get("gap", 12),
        "fill": source.get("fill", "$surface"),
        "stroke": source.get("stroke", "$line"),
        "radius": source.get("radius", 8),
        "children": children,
    }
    for gk in ("x", "y", "flex"):
        if gk in source:
            outer[gk] = source[gk]
    return outer


def expand_kv_list_macro(source, path):
    kv_id = ident(source.get("id"), ptr(path, "id"))
    items = source.get("items")
    if not isinstance(items, list) or not items:
        fail("E_PROPERTY_REQUIRED", ptr(path, "items"), "kv-list requires a nonempty items array")
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    row_h = source.get("rowHeight", 24)
    label_w = source.get("labelWidth", 88)
    children = []
    if "header" in slots and isinstance(slots["header"], dict):
        snode = copy.deepcopy(slots["header"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "header")
        children.append(snode)
    for idx, entry in enumerate(items):
        ep = ptr(ptr(path, "items"), idx)
        if not isinstance(entry, dict):
            fail("E_OBJECT", ep, "kv-list item must be an object")
        row_id = entry.get("id", f"{kv_id}_item_{idx+1}")
        k_text = entry.get("label", entry.get("key", ""))
        v_text = entry.get("value", entry.get("text", ""))
        children.append({
            "type": "box",
            "id": f"{row_id}_row",
            "layout": "row",
            "w": "fill",
            "h": row_h,
            "gap": 8,
            "align": "center",
            "children": [
                {
                    "type": "label",
                    "id": f"{row_id}_key",
                    "text": k_text,
                    "w": label_w,
                    "h": row_h - 4,
                    "fontSize": source.get("fontSize", 12),
                    "fontWeight": 500,
                    "color": "$ink-2",
                },
                {
                    "type": "label",
                    "id": row_id,
                    "text": v_text,
                    "flex": 1,
                    "h": row_h - 4,
                    "fontSize": source.get("fontSize", 12),
                    "fontWeight": entry.get("fontWeight", 400),
                    "color": entry.get("color", "$ink"),
                    "align": entry.get("align", "left"),
                },
            ],
        })
    if "footer" in slots and isinstance(slots["footer"], dict):
        snode = copy.deepcopy(slots["footer"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "footer")
        children.append(snode)
    outer = {
        "type": "box",
        "id": kv_id,
        "layout": "column",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "padding": source.get("padding", 12),
        "gap": source.get("gap", 8),
        "fill": source.get("fill", "$surface"),
        "stroke": source.get("stroke", "$line"),
        "radius": source.get("radius", 6),
        "children": children,
    }
    for gk in ("x", "y", "flex"):
        if gk in source:
            outer[gk] = source[gk]
    return outer


def expand_detail_card_macro(source, path):
    card_id = ident(source.get("id"), ptr(path, "id"))
    items = source.get("items")
    if not isinstance(items, list) or not items:
        fail("E_PROPERTY_REQUIRED", ptr(path, "items"), "detail-card requires a nonempty items array")
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    children = []
    if "title" in source or "badge" in source or ("badge" in slots and isinstance(slots["badge"], dict)):
        hdr_children = []
        if "title" in source:
            hdr_children.append({
                "type": "label",
                "id": f"{card_id}_title",
                "text": source["title"],
                "flex": 1,
                "h": 24,
                "fontSize": 16,
                "fontWeight": 700,
                "color": "$ink",
            })
        if "badge" in source:
            hdr_children.append({
                "type": "badge",
                "id": f"{card_id}_badge",
                "text": source["badge"],
                "w": 84,
                "h": 24,
                "variant": "soft",
                "radius": 6,
            })
        if "badge" in slots and isinstance(slots["badge"], dict):
            snode = copy.deepcopy(slots["badge"])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), "badge")
            hdr_children.append(snode)
        children.append({
            "type": "box",
            "id": f"{card_id}_hdr",
            "layout": "row",
            "w": "fill",
            "h": 28,
            "gap": 8,
            "align": "center",
            "children": hdr_children,
        })
    if "subtitle" in source:
        children.append({
            "type": "label",
            "id": f"{card_id}_subtitle",
            "text": source["subtitle"],
            "w": "fill",
            "h": 20,
            "fontSize": 12,
            "color": "$ink-2",
        })
    if "header" in slots and isinstance(slots["header"], dict):
        snode = copy.deepcopy(slots["header"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "header")
        children.append(snode)
    row_h = source.get("rowHeight", 26)
    label_w = source.get("labelWidth", 92)
    for idx, entry in enumerate(items):
        ep = ptr(ptr(path, "items"), idx)
        if not isinstance(entry, dict):
            fail("E_OBJECT", ep, "detail-card item must be an object")
        row_id = entry.get("id", f"{card_id}_item_{idx+1}")
        k_text = entry.get("label", entry.get("key", ""))
        v_text = entry.get("value", entry.get("text", ""))
        children.append({
            "type": "box",
            "id": f"{row_id}_row",
            "layout": "row",
            "w": "fill",
            "h": row_h,
            "gap": 8,
            "align": "center",
            "children": [
                {
                    "type": "label",
                    "id": f"{row_id}_key",
                    "text": k_text,
                    "w": label_w,
                    "h": row_h - 4,
                    "fontSize": source.get("fontSize", 12),
                    "fontWeight": 500,
                    "color": "$ink-2",
                },
                {
                    "type": "label",
                    "id": row_id,
                    "text": v_text,
                    "flex": 1,
                    "h": row_h - 4,
                    "fontSize": source.get("fontSize", 12),
                    "fontWeight": entry.get("fontWeight", 500),
                    "color": entry.get("color", "$ink"),
                    "align": entry.get("align", "left"),
                },
            ],
        })
    if "body" in slots and isinstance(slots["body"], dict):
        snode = copy.deepcopy(slots["body"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "body")
        children.append(snode)
    if isinstance(source.get("actions"), list) and source["actions"]:
        act_btns = []
        for idx, act_spec in enumerate(source["actions"]):
            ap = ptr(ptr(path, "actions"), idx)
            btn = {
                "type": "button",
                "id": act_spec.get("id", f"{card_id}_act_{idx+1}"),
                "text": act_spec.get("text", f"Action {idx+1}"),
                "w": act_spec.get("w", 96),
                "h": act_spec.get("h", 34),
                "variant": act_spec.get("variant", "primary" if idx == 0 else "outline"),
                "radius": 6,
                "_slot_origin": ap,
            }
            for ek in ("on", "onClick", "when"):
                if ek in act_spec:
                    btn[ek] = copy.deepcopy(act_spec[ek])
            act_btns.append(btn)
        children.append({
            "type": "box",
            "id": f"{card_id}_actions",
            "layout": "row",
            "w": "fill",
            "h": 38,
            "gap": 8,
            "align": "center",
            "children": act_btns,
        })
    for sk in ("actions", "footer"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    outer = {
        "type": "card",
        "id": card_id,
        "layout": "column",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "padding": source.get("padding", 16),
        "gap": source.get("gap", 10),
        "fill": source.get("fill", "$surface"),
        "stroke": source.get("stroke", "$line"),
        "radius": source.get("radius", 8),
        "children": children,
    }
    for gk in ("x", "y", "flex"):
        if gk in source:
            outer[gk] = source[gk]
    return outer


def expand_wizard_card_macro(source, path, step_var):
    wiz_id = ident(source.get("id"), ptr(path, "id"))
    steps = source.get("steps")
    if not isinstance(steps, list) or not steps:
        fail("E_PROPERTY_REQUIRED", ptr(path, "steps"), "wizard-card requires a nonempty steps array")
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    panel_id = f"{wiz_id}_panel"
    err_id = f"{wiz_id}_error"
    step_pills = []
    states = []
    body_h = source.get("bodyHeight", 280)
    for idx, st in enumerate(steps):
        sp = ptr(ptr(path, "steps"), idx)
        sid = ident(st.get("id", f"step_{idx+1}"), ptr(sp, "id"))
        stitle = st.get("title", sid)
        step_pills.append({
            "type": "badge",
            "id": f"{wiz_id}_pill_{sid}",
            "text": f"{idx+1}. {stitle}",
            "w": max(84, len(f"{idx+1}. {stitle}") * 11 + 16),
            "h": 26,
            "variant": "primary" if idx == 0 else "soft",
            "radius": 6,
            "_slot_origin": sp,
        })
        raw_body = st.get("body", st.get("root"))
        body_node = copy.deepcopy(raw_body if isinstance(raw_body, dict) else {"type": "box", "id": f"{sid}_empty", "w": "fill", "h": 40, "children": []})
        if "body" in st:
            body_node["_slot_origin"] = ptr(sp, "body")
        elif "root" in st:
            body_node["_slot_origin"] = ptr(sp, "root")
        nav_btns = []
        if idx > 0:
            prev_sid = steps[idx - 1].get("id", f"step_{idx}")
            nav_btns.append({
                "type": "button",
                "id": f"{sid}_prev",
                "text": st.get("prevText", "上一步"),
                "w": 88,
                "h": 36,
                "variant": "outline",
                "radius": 6,
                "onClick": [
                    {"type": "set-variable", "variable": step_var, "value": prev_sid},
                    {"type": "set-text", "target": err_id, "text": ""},
                    {"type": "set-panel-state", "target": panel_id, "state": prev_sid},
                ],
                "_slot_origin": sp,
            })
        next_sid = steps[idx + 1].get("id", f"step_{idx+2}") if idx + 1 < len(steps) else None
        user_next = st.get("onNext", source.get("onComplete", []) if not next_sid else [])
        if isinstance(user_next, dict):
            user_next = [user_next]
        else:
            user_next = list(copy.deepcopy(user_next))
        ok_actions = [{"type": "set-text", "target": err_id, "text": ""}, *user_next]
        if next_sid:
            ok_actions.extend([
                {"type": "set-variable", "variable": step_var, "value": next_sid},
                {"type": "set-panel-state", "target": panel_id, "state": next_sid},
            ])
        guard_expr = st.get("guard", st.get("nextWhen"))
        guard_key = "guard" if "guard" in st else "nextWhen"
        guard_msg = st.get("guardMessage", st.get("errorText", st.get("errorMessage", "请先完成当前步骤必填项")))
        if guard_expr is not None:
            next_click = {
                "cases": [
                    {"when": guard_expr, "_when_origin": ptr(sp, guard_key), "actions": ok_actions},
                    {"else": True, "actions": [{"type": "set-text", "target": err_id, "text": guard_msg}]},
                ]
            }
        else:
            next_click = ok_actions
        if next_sid or user_next or "nextText" in st or guard_expr is not None:
            nav_btns.append({
                "type": "button",
                "id": f"{sid}_next",
                "text": st.get("nextText", "下一步" if next_sid else "完成提交"),
                "w": 104,
                "h": 36,
                "variant": "primary",
                "radius": 6,
                "onClick": next_click,
                "_slot_origin": sp,
            })
        states.append({
            "id": sid,
            "root": {
                "type": "box",
                "id": f"{wiz_id}_{sid}_root",
                "layout": "column",
                "w": "fill",
                "h": body_h,
                "gap": 12,
                "_slot_origin": sp,
                "children": [
                    body_node,
                    {
                        "type": "box",
                        "id": f"{wiz_id}_{sid}_nav",
                        "layout": "row",
                        "w": "fill",
                        "h": 40,
                        "gap": 10,
                        "align": "center",
                        "_slot_origin": sp,
                        "children": nav_btns,
                    },
                ],
            },
        })
    children = []
    if "title" in source:
        children.append({
            "type": "label",
            "id": f"{wiz_id}_title",
            "text": source["title"],
            "w": "fill",
            "h": 24,
            "fontSize": 16,
            "fontWeight": 700,
            "color": "$ink",
        })
    for sk in ("header", "stepper"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    children.extend([
        {
            "type": "box",
            "id": f"{wiz_id}_steps_bar",
            "layout": "row",
            "w": "fill",
            "h": 30,
            "gap": 8,
            "align": "center",
            "children": step_pills,
        },
        {
            "type": "label",
            "id": err_id,
            "text": "",
            "w": "fill",
            "h": 20,
            "fontSize": 12,
            "color": "$danger",
        },
        {
            "type": "dynamic-panel",
            "id": panel_id,
            "w": "fill",
            "h": body_h,
            "states": states,
        },
    ])
    for sk in ("body", "actions", "footer"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    outer = {
        "type": "card",
        "id": wiz_id,
        "layout": "column",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "padding": source.get("padding", 16),
        "gap": source.get("gap", 12),
        "fill": source.get("fill", "$surface"),
        "stroke": source.get("stroke", "$line"),
        "radius": source.get("radius", 8),
        "children": children,
    }
    for gk in ("x", "y", "flex"):
        if gk in source:
            outer[gk] = source[gk]
    return outer


def expand_master_detail_macro(source, path):
    md_id = ident(source.get("id"), ptr(path, "id"))
    master_node = source.get("master")
    detail_node = source.get("detail")
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    list_w = source.get("masterWidth", source.get("listWidth", 360))
    if master_node is None and "dataset" in source and "searchField" in source and "template" in source:
        master_node = {
            "type": "searchable-list",
            "id": md_id,
            "dataset": source["dataset"],
            "key": source.get("key", "id"),
            "searchField": source["searchField"],
            "filterField": source.get("filterField", source["searchField"]),
            "w": list_w,
            "repeaterHeight": source.get("repeaterHeight", 200),
            "rowHeight": source.get("rowHeight", 44),
            "rowGap": source.get("rowGap", 8),
            "template": copy.deepcopy(source["template"]),
        }
        if "filters" in source:
            master_node["filters"] = copy.deepcopy(source["filters"])
        master_origin = path
    elif master_node is None and isinstance(slots.get("master"), dict):
        master_node = slots["master"]
        master_origin = ptr(ptr(path, "slots"), "master")
    else:
        if not isinstance(master_node, dict):
            fail("E_PROPERTY_REQUIRED", ptr(path, "master"), "master-detail requires a master node object or dataset/searchField/template")
        master_origin = ptr(path, "master")
    if not isinstance(detail_node, dict):
        fail("E_PROPERTY_REQUIRED", ptr(path, "detail"), "master-detail requires a detail node object")
    m_copy = copy.deepcopy(master_node)
    m_copy["_slot_origin"] = master_origin
    m_copy.setdefault("w", list_w)
    if "master" in slots and isinstance(slots["master"], dict) and master_origin != ptr(ptr(path, "slots"), "master"):
        mslot = copy.deepcopy(slots["master"])
        mslot["_slot_origin"] = ptr(ptr(path, "slots"), "master")
        m_copy = {
            "type": "box",
            "id": f"{md_id}_master_col",
            "layout": "column",
            "w": list_w,
            "h": "hug",
            "gap": 8,
            "children": [mslot, m_copy],
        }
    d_copy = copy.deepcopy(detail_node)
    d_copy["_slot_origin"] = ptr(path, "detail")
    if "w" not in d_copy and "flex" not in d_copy:
        d_copy["flex"] = 1
    if ("detailHeader" in slots and isinstance(slots["detailHeader"], dict)) or ("detailFooter" in slots and isinstance(slots["detailFooter"], dict)):
        d_children = []
        if "detailHeader" in slots and isinstance(slots["detailHeader"], dict):
            dh = copy.deepcopy(slots["detailHeader"])
            dh["_slot_origin"] = ptr(ptr(path, "slots"), "detailHeader")
            d_children.append(dh)
        d_children.append(d_copy)
        if "detailFooter" in slots and isinstance(slots["detailFooter"], dict):
            df = copy.deepcopy(slots["detailFooter"])
            df["_slot_origin"] = ptr(ptr(path, "slots"), "detailFooter")
            d_children.append(df)
        d_copy = {
            "type": "box",
            "id": f"{md_id}_detail_col",
            "layout": "column",
            "flex": 1,
            "h": "hug",
            "gap": 8,
            "children": d_children,
        }
    row_box = {
        "type": "box",
        "id": f"{md_id}_split",
        "layout": "row",
        "w": "fill",
        "h": source.get("h", "hug"),
        "gap": source.get("gap", 16),
        "align": "start",
        "children": [m_copy, d_copy],
    }
    has_self_id = m_copy.get("id") == md_id or (isinstance(master_node, dict) and master_node.get("id") == md_id)
    if not slots:
        row_box["id"] = f"{md_id}_container" if has_self_id else md_id
        for gk in ("x", "y", "w", "h", "flex", "padding", "fill", "stroke", "radius"):
            if gk in source:
                row_box[gk] = copy.deepcopy(source[gk])
        return row_box
    children = []
    for sk in ("header", "toolbar"):
        if sk in slots and isinstance(slots[sk], dict):
            snode = copy.deepcopy(slots[sk])
            snode["_slot_origin"] = ptr(ptr(path, "slots"), sk)
            children.append(snode)
    children.append(row_box)
    if "footer" in slots and isinstance(slots["footer"], dict):
        snode = copy.deepcopy(slots["footer"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "footer")
        children.append(snode)
    outer = {
        "type": "box",
        "id": f"{md_id}_container" if has_self_id else md_id,
        "layout": "column",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "gap": source.get("gap", 12),
        "children": children,
    }
    for gk in ("x", "y", "flex", "padding", "fill", "stroke", "radius"):
        if gk in source:
            outer[gk] = copy.deepcopy(source[gk])
    return outer


def expand_tab_bar_macro(source, path):
    tab_id = ident(source.get("id"), ptr(path, "id"))
    items_key = "items" if "items" in source else "tabs"
    raw_items = source.get(items_key)
    if not isinstance(raw_items, list) or not raw_items:
        fail("E_PROPERTY_REQUIRED", ptr(path, items_key), "tab-bar requires a nonempty 'items' or 'tabs' array")
    active_val = source.get("active")
    indicator = source.get("activeIndicator", "none")
    if indicator not in ("none", "underline", "dot"):
        fail("E_PROPERTY", ptr(path, "activeIndicator"), "Expected none, underline or dot")
    active_variant = source.get("activeVariant", "ghost" if indicator != "none" else "primary")
    if active_variant not in ("primary", "brand", "secondary", "outline", "ghost", "soft", "danger",
                              "success", "warning", "error"):
        fail("E_PROPERTY", ptr(path, "activeVariant"), "Expected a supported button variant")
    item_h = source.get("itemHeight", 38)
    children = []
    for idx, entry in enumerate(raw_items):
        ep = ptr(ptr(path, items_key), idx)
        if isinstance(entry, str):
            label = entry
            item_id = f"{tab_id}_tab_{idx + 1}"
            goto_page = None
            entry_on = None
            entry_click = None
            is_active = active_val in (entry, idx)
            entry_dict = {}
        elif isinstance(entry, dict):
            raw_item_id = entry.get("id", f"{tab_id}_tab_{idx + 1}")
            item_id = ident(raw_item_id, ptr(ep, "id") if "id" in entry else ep)
            label = entry.get("label", entry.get("text", raw_item_id))
            goto_page = entry.get("goto", entry.get("page", entry.get("link")))
            entry_on = entry.get("on")
            entry_click = entry.get("onClick")
            is_active = bool(entry.get("active")) or (
                active_val is not None and active_val in (raw_item_id, item_id, label, idx)
            )
            entry_dict = entry
        else:
            fail("E_OBJECT", ep, "tab-bar item must be an object or string")
        btn = {
            "type": "button",
            "id": item_id,
            "text": label,
            "variant": entry_dict.get("variant", active_variant if is_active else "ghost"),
            "flex": entry_dict.get("flex", source.get("itemFlex", 1)),
            "h": entry_dict.get("h", item_h),
            "radius": entry_dict.get("radius", 12),
            "fontSize": entry_dict.get("fontSize", source.get("fontSize", 12)),
            "fontWeight": entry_dict.get("fontWeight", 700 if is_active else 500),
        }
        for ck in ("w", "fill", "color", "stroke", "icon"):
            if ck in entry_dict:
                btn[ck] = copy.deepcopy(entry_dict[ck])
        for prop, style in (("fill", "Fill"), ("color", "Color")):
            key = ("active" if is_active else "inactive") + style
            if prop not in entry_dict and key in source:
                btn[prop] = copy.deepcopy(source[key])
        if entry_on:
            btn["on"] = copy.deepcopy(entry_on)
        elif entry_click:
            btn["onClick"] = copy.deepcopy(entry_click)
        elif goto_page:
            btn["onClick"] = [{"goto": goto_page}]
        if indicator == "none":
            children.append(btn)
        else:
            wrapper = {"type": "box", "id": f"{item_id}_item", "layout": "stack",
                       "h": btn["h"], "children": [], "flex": btn.pop("flex")}
            if "w" in btn:
                wrapper["w"] = btn.pop("w")
            btn["w"] = "fill"
            wrapper["children"] = [btn, {
                "type": "box", "id": f"{item_id}_indicator", "w": 16 if indicator == "underline" else 4,
                "h": 3 if indicator == "underline" else 4, "radius": 999,
                "alignX": "center", "pin": "bottom", "fill":
                    source.get("activeColor", "$brand") if is_active else "#FFFFFF00",
            }]
            children.append(wrapper)
    bar = {
        "type": "box",
        "id": tab_id,
        "layout": "row",
        "w": source.get("w", "fill"),
        "h": source.get("h", 56),
        "padding": source.get("padding", [8, 12]),
        "gap": source.get("gap", 8),
        "radius": source.get("radius", 16),
        "fill": source.get("fill", "$surface"),
        "stroke": source.get("stroke", "$line"),
        "align": "center",
        "justify": source.get("justify", "space-between"),
        "children": children,
    }
    for gk in ("x", "y", "right", "bottom", "flex", "visible", "hidden"):
        if gk in source:
            bar[gk] = copy.deepcopy(source[gk])
    return bar


def expand_nav_bar_macro(source, path):
    nav_id = ident(source.get("id"), ptr(path, "id"))
    title = source.get("title", source.get("text", ""))
    subtitle = source.get("subtitle")
    back_val = source.get("back")
    back_text = source.get("backText", back_val if isinstance(back_val, str) else None)
    back_page = source.get("backPage", source.get("backGoto"))
    on_back = source.get("onBack")
    right_val = source.get("right")
    right_text = source.get("rightText", right_val if isinstance(right_val, str) else None)
    right_page = source.get("rightPage", source.get("rightGoto"))
    on_right = source.get("onRight")
    has_left = bool(back_text or back_page or back_val or on_back)
    has_right = bool(right_text or right_page or right_val or on_right or source.get("actions"))
    title_align = "center" if (has_left and has_right) else "left"
    children = []
    if has_left:
        back_btn = {
            "type": "button",
            "id": f"{nav_id}_back",
            "text": back_text or "返回",
            "variant": "ghost",
            "w": 68,
            "h": 32,
            "radius": 8,
            "fontSize": 13,
            "fontWeight": 500,
        }
        if on_back:
            back_btn["onClick"] = copy.deepcopy(on_back)
        elif back_page:
            back_btn["onClick"] = [{"goto": back_page}]
        children.append(back_btn)
    if subtitle:
        children.append({
            "type": "box",
            "id": f"{nav_id}_title_group",
            "layout": "column",
            "flex": 1,
            "h": "hug",
            "gap": 2,
            "children": [
                {
                    "type": "label",
                    "id": f"{nav_id}_title",
                    "text": title,
                    "w": "fill",
                    "h": 24,
                    "fontSize": source.get("titleFontSize", 18),
                    "fontWeight": 700,
                    "color": "$ink",
                    "align": title_align,
                },
                {
                    "type": "label",
                    "id": f"{nav_id}_subtitle",
                    "text": subtitle,
                    "w": "fill",
                    "h": 16,
                    "fontSize": 12,
                    "fontWeight": 400,
                    "color": "$ink-2",
                    "align": title_align,
                },
            ],
        })
    else:
        children.append({
            "type": "label",
            "id": f"{nav_id}_title",
            "text": title,
            "flex": 1,
            "h": 28,
            "fontSize": source.get("titleFontSize", 18),
            "fontWeight": 700,
            "color": "$ink",
            "align": title_align,
        })
    if right_text or right_page or right_val or on_right:
        right_interactive = bool(right_page or on_right)
        right_node = {
            "type": "button" if right_interactive else "badge",
            "id": f"{nav_id}_right",
            "text": right_text or "更多",
            "variant": "soft",
            "w": 76,
            "h": 30,
            "radius": 8,
            "fontSize": 12,
            "fontWeight": 600,
        }
        if on_right:
            right_node["onClick"] = copy.deepcopy(on_right)
        elif right_page:
            right_node["onClick"] = [{"goto": right_page}]
        children.append(right_node)
    for idx, act in enumerate(source.get("actions") or []):
        ap = ptr(ptr(path, "actions"), idx)
        aid = ident(act.get("id", f"{nav_id}_act_{idx + 1}"), ptr(ap, "id") if "id" in act else ap)
        abtn = {
            "type": "button",
            "id": aid,
            "text": act.get("label", act.get("text", aid)),
            "variant": act.get("variant", "soft"),
            "w": act.get("w", 72),
            "h": act.get("h", 30),
            "radius": act.get("radius", 8),
            "fontSize": act.get("fontSize", 12),
            "fontWeight": act.get("fontWeight", 600),
        }
        if "on" in act:
            abtn["on"] = copy.deepcopy(act["on"])
        elif "onClick" in act:
            abtn["onClick"] = copy.deepcopy(act["onClick"])
        elif act.get("goto") or act.get("page") or act.get("link"):
            abtn["onClick"] = [{"goto": act.get("goto", act.get("page", act.get("link")))}]
        children.append(abtn)
    nav = {
        "type": "box",
        "id": nav_id,
        "layout": "row",
        "w": source.get("w", "fill"),
        "h": source.get("h", 56 if subtitle else 48),
        "padding": source.get("padding", [8, 12] if ("fill" in source or "stroke" in source) else 0),
        "gap": source.get("gap", 8),
        "align": "center",
        "justify": "space-between",
        "children": children,
    }
    for gk in ("x", "y", "right", "bottom", "flex", "fill", "stroke", "radius", "visible", "hidden"):
        if gk in source:
            nav[gk] = copy.deepcopy(source[gk])
    return nav


def expand_progress_bar_macro(source, path, variables=None, bindings=None, scope=None):
    pb_id = ident(source.get("id"), ptr(path, "id"))
    if "showValue" in source and type(source["showValue"]) is not bool:
        fail("E_TYPE", ptr(path, "showValue"), "Expected boolean for showValue")
    max_val = float(source.get("max", 100)) if isinstance(source.get("max", 100), (int, float)) and not isinstance(source.get("max"), bool) else 100.0
    raw_pct = source.get("percent")
    raw_val = source.get("value")
    runtime_pct_expr = None
    runtime_val_prop = None

    def _eval_const(expr, default=None):
        """编译期常量求值：数字 / "$var" / {"variable":..} / 四则运算 / number()"""
        if isinstance(expr, bool):
            return default
        if isinstance(expr, (int, float)):
            return float(expr)
        if isinstance(expr, str):
            t = expr.strip()
            if t.startswith("$") and isinstance(variables, dict):
                vobj = variables.get(t[1:])
                vval = vobj.get("default", vobj.get("value")) if isinstance(vobj, dict) else vobj
                if isinstance(vval, bool):
                    return default
                if isinstance(vval, (int, float)):
                    return float(vval)
                if isinstance(vval, str):
                    try:
                        return float(vval)
                    except ValueError:
                        return default
            return default
        if isinstance(expr, dict):
            vname = expr.get("variable") or expr.get("var") or expr.get("_sigil_var")
            if isinstance(vname, str):
                return _eval_const("$" + vname, default)
            if "fn" in expr and expr.get("fn") == "number" and isinstance(expr.get("args"), list) and expr["args"]:
                return _eval_const(expr["args"][0], default)
            op = expr.get("op")
            if op in ("+", "-", "*", "/"):
                l = _eval_const(expr.get("left"), None)
                r = _eval_const(expr.get("right"), None)
                if l is None or r is None:
                    return default
                if op == "+":
                    return l + r
                if op == "-":
                    return l - r
                if op == "*":
                    return l * r
                if op == "/":
                    return (l / r) if r else default
        return default

    def _resolve_static_num(expr, default=50.0):
        if isinstance(expr, (int, float)) and not isinstance(expr, bool):
            return float(expr)
        if isinstance(expr, str):
            s = expr.strip()
            const = _eval_const(expr, None)
            if const is not None:
                return const
            if s.startswith("$") and isinstance(variables, dict):
                vobj = variables.get(s[1:])
                vval = vobj.get("default", vobj.get("value")) if isinstance(vobj, dict) else vobj
                if isinstance(vval, (int, float)) and not isinstance(vval, bool):
                    return float(vval)
                if isinstance(vval, str):
                    try:
                        return float(vval)
                    except ValueError:
                        pass
        elif isinstance(expr, dict):
            const = _eval_const(expr, None)
            if const is not None:
                return const
            vname = expr.get("variable") or expr.get("var") or expr.get("_sigil_var")
            if isinstance(vname, str) and isinstance(variables, dict):
                vobj = variables.get(vname)
                vval = vobj.get("default", vobj.get("value")) if isinstance(vobj, dict) else vobj
                if isinstance(vval, (int, float)) and not isinstance(vval, bool):
                    return float(vval)
                if isinstance(vval, str):
                    try:
                        return float(vval)
                    except ValueError:
                        pass
        return default

    if "percent" in source:
        if isinstance(raw_pct, (int, float)) and not isinstance(raw_pct, bool):
            pct = float(raw_pct)
        else:
            pct = _resolve_static_num(raw_pct, 50.0)
            p_expr = parse_inline_expr(raw_pct, ptr(path, "percent"), prefer_condition=False) if isinstance(raw_pct, str) else copy.deepcopy(raw_pct)
            runtime_pct_expr = {"fn": "number", "args": [p_expr]}
            runtime_val_prop = "percent"
    elif "value" in source:
        if isinstance(raw_val, (int, float)) and not isinstance(raw_val, bool):
            pct = (float(raw_val) / max_val * 100.0) if max_val > 0 else 0.0
        else:
            init_v = _resolve_static_num(raw_val, max_val * 0.5)
            pct = (init_v / max_val * 100.0) if max_val > 0 else 0.0
            val_expr = parse_inline_expr(raw_val, ptr(path, "value"), prefer_condition=False) if isinstance(raw_val, str) else copy.deepcopy(raw_val)
            num_expr = {"fn": "number", "args": [val_expr]}
            max_num = int(max_val) if float(max_val).is_integer() else max_val
            if max_num == 100:
                runtime_pct_expr = num_expr
            elif isinstance(max_num, int) and max_num > 0 and 100 % max_num == 0:
                runtime_pct_expr = {"op": "*", "left": num_expr, "right": 100 // max_num}
            else:
                runtime_pct_expr = {"op": "/", "left": {"op": "*", "left": num_expr, "right": 100}, "right": max_num}
            runtime_val_prop = "value"
    else:
        pct = 50.0
    pct = max(0.0, min(100.0, pct))
    has_header = bool("label" in source or "text" in source or "rightText" in source or source.get("showValue") or runtime_pct_expr is not None)
    show_value = source.get("showValue") is not False
    if not show_value:
        has_header = bool(source.get("label") or source.get("text"))
    bar_h = source.get("barHeight", source.get("trackHeight", 8 if has_header else (source.get("h") if isinstance(source.get("h"), (int, float)) else 8)))
    total_w = source.get("w", "fill")
    numeric_w = total_w if isinstance(total_w, (int, float)) else 320
    fluid_width = total_w == "fill"
    if runtime_pct_expr is not None and bindings is not None:
        bindings.append({"fill": f"{pb_id}_fill", "percent": copy.deepcopy(runtime_pct_expr),
                         "scope": scope, "pointer": ptr(path, runtime_val_prop)})
    fill_w = max(4, int(round(numeric_w * (pct / 100.0)))) if pct > 0 else 0
    track_color = source.get("trackColor", source.get("trackFill", "$surface-2"))
    bar_color = source.get("barColor", source.get("barFill", source.get("color", "$brand")))
    rad = source.get("radius", max(4, int(bar_h // 2) if isinstance(bar_h, (int, float)) else 4))
    def _bar_box(state_pct):
        return {"type": "box", "id": f"{pb_id}_fill_{int(state_pct)}", "layout": "row",
                "w": max(4, int(round(numeric_w * (state_pct / 100.0)))) if state_pct > 0 else 0,
                "h": bar_h, "padding": 0, "radius": rad, "fill": bar_color, "children": []}

    def _fluid_children(state_pct, zero_pixel=False):
        out = []
        if state_pct > 0:
            out.append(dict(_bar_box(state_pct), w="fill", flex=state_pct))
        elif zero_pixel:
            out.append(dict(_bar_box(0), w=1))
        if state_pct < 100:
            out.append({"type": "box", "id": f"{pb_id}_space_{int(state_pct)}", "w": "fill", "flex": 100 - state_pct,
                        "h": bar_h, "children": []})
        return out

    def _fill_children():
        """有变量绑定时用 11 态面板承载宽度（RP9 预览不执行 Set Size，实测无效）；
        初始状态取当前百分比的档位，保证静态预览与首屏一致。"""
        if runtime_pct_expr is None:
            if fluid_width:
                return _fluid_children(pct)
            return [_bar_box(pct)] if fill_w > 0 else []
        steps = [p for p in range(0, 101, 10)]
        nearest = min(steps, key=lambda p: abs(p - pct))
        ordered = [nearest] + [p for p in steps if p != nearest]
        states = []
        for p in ordered:
            box_w = max(4, int(round(numeric_w * (p / 100.0)))) if p > 0 else 1
            states.append({"id": f"s{p}", "root": {"type": "box", "id": f"{pb_id}_fillstate_{p}",
                                                   "layout": "row" if fluid_width else "stack", "w": "fill", "h": bar_h,
                                                   "children": _fluid_children(p, zero_pixel=True) if fluid_width else [dict(_bar_box(p), w=box_w)]}})
        return [{"type": "dynamic-panel", "id": f"{pb_id}_fill", "w": "fill" if fluid_width else numeric_w, "h": bar_h,
                 "states": states}]

    track = {
        "type": "box",
        "id": f"{pb_id}_track" if has_header else pb_id,
        "layout": "row",
        "w": "fill" if has_header else total_w,
        "h": bar_h,
        "padding": 0,
        "gap": 0,
        "radius": rad,
        "fill": track_color,
        "children": _fill_children(),
    }
    if has_header:
        lbl_text = source.get("label", source.get("text", "进度"))
        if "rightText" in source:
            rt_text = source["rightText"]
        elif runtime_pct_expr is not None:
            rt_text = {"fn": "concat", "args": [runtime_pct_expr, "%"]}
        else:
            rt_text = f"{int(round(pct))}%"
        val_label = {
            "type": "label",
            "id": f"{pb_id}_value",
            "text": rt_text,
            "w": 64,
            "h": 20,
            "fontSize": 12,
            "fontWeight": 600,
            "color": "$ink",
            "align": "right",
        }
        if runtime_val_prop is not None and "rightText" not in source:
            val_label["_slot_origin"] = ptr(path, runtime_val_prop)
        header_row = {
            "type": "box",
            "id": f"{pb_id}_header",
            "layout": "row",
            "w": "fill",
            "h": 20,
            "justify": "space-between",
            "align": "center",
            "children": [
                {
                    "type": "label",
                    "id": f"{pb_id}_label",
                    "text": lbl_text,
                    "flex": 1,
                    "h": 20,
                    "fontSize": 12,
                    "fontWeight": 500,
                    "color": "$ink-2",
                },
                val_label,
            ],
        }
        if not show_value:
            header_row["children"].pop()
        pb_gap = source.get("gap", 6)
        min_outer_h = 20 + (pb_gap if isinstance(pb_gap, (int, float)) else 6) + (bar_h if isinstance(bar_h, (int, float)) else 8)
        raw_outer_h = source.get("h", "hug")
        outer_h = max(int(raw_outer_h), int(min_outer_h)) if isinstance(raw_outer_h, (int, float)) else raw_outer_h
        outer = {
            "type": "box",
            "id": pb_id,
            "layout": "column",
            "w": total_w,
            "h": outer_h,
            "gap": pb_gap,
            "children": [header_row, track],
        }
        for gk in ("x", "y", "right", "bottom", "flex", "padding", "fill", "stroke", "visible", "hidden"):
            if gk in source:
                outer[gk] = copy.deepcopy(source[gk])
        return outer
    for gk in ("x", "y", "right", "bottom", "flex", "stroke", "visible", "hidden"):
        if gk in source:
            track[gk] = copy.deepcopy(source[gk])
    return track


def expand_phone_shell_macro(source, path):
    sh_id = ident(source.get("id"), ptr(path, "id"))
    dev = source.get("device", "iphone-17")
    preset = DEVICE_CANVAS_PRESETS.get(dev, {"w": 402, "h": 874})
    children = []
    if source.get("statusBar", True) is not False:
        time_txt = source.get("time", source.get("timeText", "9:41"))
        status_txt = source.get("statusRight", source.get("statusText", "5G · 100%"))
        children.append({
            "type": "box",
            "id": f"{sh_id}_status",
            "layout": "row",
            "w": "fill",
            "h": 28,
            "padding": [0, 6],
            "justify": "space-between",
            "align": "center",
            "children": [
                {
                    "type": "label",
                    "id": f"{sh_id}_time",
                    "text": time_txt,
                    "w": 64,
                    "h": 20,
                    "fontSize": 13,
                    "fontWeight": 600,
                    "color": "$ink",
                },
                {
                    "type": "label",
                    "id": f"{sh_id}_status_icons",
                    "text": status_txt,
                    "w": 92,
                    "h": 20,
                    "fontSize": 12,
                    "fontWeight": 600,
                    "color": "$ink",
                    "align": "right",
                },
            ],
        })
    if isinstance(source.get("navBar"), dict):
        nb = copy.deepcopy(source["navBar"])
        nb.setdefault("type", "nav-bar")
        nb.setdefault("id", f"{sh_id}_nav")
        children.append(nb)
    elif any(k in source for k in ("title", "back", "backText", "backPage", "backGoto", "onBack", "right", "rightText", "rightPage", "rightGoto", "onRight")):
        nb = {"type": "nav-bar", "id": f"{sh_id}_nav", "title": source.get("title", "")}
        for nk in ("subtitle", "right", "rightText", "rightPage", "rightGoto", "onRight", "back", "backText", "backPage", "backGoto", "onBack"):
            if nk in source:
                nb[nk] = copy.deepcopy(source[nk])
        children.append(nb)
    body_start_idx = len(children)
    if "body" in source and not isinstance(source.get("body"), dict):
        fail("E_OBJECT", ptr(path, "body"), "Expected a node object")
    if isinstance(source.get("body"), dict):
        bnode = copy.deepcopy(source["body"])
        bnode["_slot_origin"] = ptr(path, "body")
        children.append(bnode)
    for idx, ch in enumerate(source.get("children") or []):
        if not isinstance(ch, dict):
            fail("E_OBJECT", ptr(ptr(path, "children"), idx), "Expected a node object")
        cnode = copy.deepcopy(ch)
        cnode["_slot_origin"] = ptr(ptr(path, "children"), idx)
        children.append(cnode)
    if isinstance(source.get("tabBar"), dict):
        body_slice = [c for c in children[body_start_idx:] if isinstance(c, dict)]
        if body_slice and not any(c.get("flex") or c.get("h") == "fill" for c in body_slice):
            b0 = body_slice[0]
            if (
                len(body_slice) == 1
                and b0.get("type", "box") == "box"
                and "box" not in [k for k in b0 if k != "type"]
                and b0.get("h") in (None, "hug")
                and not b0.get("fill")
                and not b0.get("stroke")
            ):
                b0["flex"] = 1
            else:
                children[body_start_idx:] = [{
                    "type": "box",
                    "id": f"{sh_id}_body_wrap",
                    "layout": "column",
                    "w": "fill",
                    "h": "hug",
                    "flex": 1,
                    "gap": source.get("gap", 12),
                    "children": body_slice,
                }]
        tb = copy.deepcopy(source["tabBar"])
        tb.setdefault("type", "tab-bar")
        tb.setdefault("id", f"{sh_id}_tabs")
        children.append(tb)
    outer = {
        "type": "box",
        "id": sh_id,
        "layout": "column",
        "w": source.get("w", preset["w"]),
        "h": source.get("h", preset["h"]),
        "padding": source.get("padding", [14, 16, 20, 16]),
        "gap": source.get("gap", 12),
        "fill": source.get("fill", source.get("screenFill", "$bg")),
        "radius": source.get("radius", 44),
        "children": children,
        "_phone_shell_opts": {
            "darkIsland": bool(source.get("darkIsland", True)),
            "showHomeIndicator": bool(source.get("showHomeIndicator", True)),
        },
    }
    for gk in ("x", "y", "flex", "stroke", "radius", "justify", "align", "visible", "hidden"):
        if gk in source:
            outer[gk] = copy.deepcopy(source[gk])
    return outer


def expand_stat_row_macro(source, path):
    sr_id = ident(source.get("id"), ptr(path, "id"))
    items = source.get("items")
    if not isinstance(items, list) or not items:
        fail("E_PROPERTY_REQUIRED", ptr(path, "items"), "stat-row requires a nonempty items array")
    cards = []
    for idx, item in enumerate(items):
        ip = ptr(ptr(path, "items"), idx)
        if not isinstance(item, dict):
            fail("E_OBJECT", ip, "stat-row item must be an object")
        iid = ident(item.get("id", f"{sr_id}_{idx + 1}"), ptr(ip, "id") if "id" in item else ip)
        lbl_txt = str(item.get("label", item.get("title", item.get("text", f"指标 {idx + 1}"))))
        val_txt = str(item.get("value", item.get("text", "0")))
        sub_txt = item.get("sub", item.get("subtitle", item.get("trend")))
        c_children = [
            {
                "type": "label",
                "id": f"{iid}_label",
                "text": lbl_txt,
                "w": "fill",
                "h": 18,
                "fontSize": 12,
                "fontWeight": 400,
                "color": "$ink-2",
            },
            {
                "type": "label",
                "id": f"{iid}_value",
                "text": val_txt,
                "w": "fill",
                "h": 28,
                "fontSize": item.get("valueFontSize", source.get("valueFontSize", 20)),
                "fontWeight": 700,
                "color": item.get("color", "$ink"),
            },
        ]
        if sub_txt is not None:
            c_children.append({
                "type": "label",
                "id": f"{iid}_sub",
                "text": str(sub_txt),
                "w": "fill",
                "h": 16,
                "fontSize": 11,
                "fontWeight": 400,
                "color": item.get("subColor", "$ink-3"),
            })
        card_node = {
            "type": "card",
            "id": iid,
            "flex": 1,
            "w": "fill",
            "h": "hug",
            "padding": source.get("cardPadding", 12),
            "gap": 4,
            "radius": item.get("radius", source.get("radius", 12)),
            "fill": item.get("fill", source.get("fill", "$surface")),
            "stroke": item.get("stroke", source.get("stroke", "$line")),
            "children": c_children,
        }
        if "on" in item:
            card_node["on"] = copy.deepcopy(item["on"])
        elif "onClick" in item:
            card_node["onClick"] = copy.deepcopy(item["onClick"])
        elif item.get("goto") or item.get("page") or item.get("link"):
            card_node["onClick"] = [{"goto": item.get("goto", item.get("page", item.get("link")))}]
        cards.append(card_node)
    out = {
        "type": "box",
        "id": sr_id,
        "layout": "row",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "gap": source.get("gap", 8),
        "equalHeight": source.get("equalHeight", True),
        "children": cards,
    }
    for gk in ("x", "y", "right", "bottom", "flex", "padding", "visible", "hidden"):
        if gk in source:
            out[gk] = copy.deepcopy(source[gk])
    return out


def expand_list_item_macro(source, path):
    li_id = ident(source.get("id"), ptr(path, "id"))
    title = str(source.get("title", source.get("text", li_id)))
    subtitle = source.get("subtitle")
    tag = source.get("tag", source.get("badge", source.get("index")))
    icon_name = source.get("icon")
    right_badge = source.get("rightBadge")
    right_txt = source.get("rightText", source.get("meta", source.get("value", source.get("status"))))
    raw_tag_tone = source.get("tagTone", source.get("tone", source.get("badgeVariant", "soft")))
    tag_variant = raw_tag_tone if raw_tag_tone in ("soft", "solid", "outline", "brand", "primary", "secondary", "ghost", "glass", "success", "warning", "danger", "error", "neutral") else "soft"
    raw_right_tone = source.get("rightTone", source.get("rightVariant", "soft"))
    right_variant = raw_right_tone if raw_right_tone in ("soft", "solid", "outline", "brand", "primary", "secondary", "ghost", "glass", "success", "warning", "danger", "error", "neutral") else "soft"
    children = []
    if tag is not None:
        children.append({
            "type": "badge",
            "id": f"{li_id}_tag",
            "text": str(tag),
            "variant": tag_variant,
            "w": "hug",
            "h": 24,
            "radius": 6,
            "fontSize": 11,
        })
    elif icon_name:
        children.append({
            "type": "icon",
            "id": f"{li_id}_icon",
            "icon": str(icon_name),
            "w": 20,
            "h": 20,
            "color": "$brand",
        })
    if subtitle is not None:
        children.append({
            "type": "box",
            "id": f"{li_id}_body",
            "layout": "column",
            "flex": 1,
            "w": "fill",
            "h": "hug",
            "gap": 2,
            "children": [
                {
                    "type": "label",
                    "id": f"{li_id}_title",
                    "text": title,
                    "w": "fill",
                    "h": "hug",
                    "fontSize": 14,
                    "fontWeight": 600,
                    "color": "$ink",
                },
                {
                    "type": "label",
                    "id": f"{li_id}_subtitle",
                    "text": str(subtitle),
                    "w": "fill",
                    "h": "hug",
                    "fontSize": 12,
                    "fontWeight": 400,
                    "color": "$ink-2",
                },
            ],
        })
    else:
        children.append({
            "type": "label",
            "id": f"{li_id}_title",
            "text": title,
            "flex": 1,
            "w": "fill",
            "h": "hug",
            "fontSize": 14,
            "fontWeight": 600,
            "color": "$ink",
        })
    if right_badge is not None:
        children.append({
            "type": "badge",
            "id": f"{li_id}_rbadge",
            "text": str(right_badge),
            "variant": right_variant,
            "w": "hug",
            "h": 24,
            "radius": 6,
            "fontSize": 11,
        })
    elif right_txt is not None:
        children.append({
            "type": "label",
            "id": f"{li_id}_right",
            "text": str(right_txt),
            "w": "hug",
            "h": 20,
            "fontSize": 12,
            "fontWeight": 500,
            "color": "$ink-2",
            "align": "right",
        })
    out = {
        "type": "card",
        "id": li_id,
        "layout": "row",
        "w": source.get("w", "fill"),
        "h": source.get("h", "hug"),
        "padding": source.get("padding", [12, 16]),
        "gap": source.get("gap", 12),
        "align": "center",
        "radius": source.get("radius", 12),
        "fill": source.get("fill", "$surface"),
        "stroke": source.get("stroke", "$line"),
        "children": children,
    }
    if source.get("goto") or source.get("page") or source.get("link"):
        out["onClick"] = [{"goto": source.get("goto", source.get("page", source.get("link")))}]
    for gk in ("x", "y", "right", "bottom", "flex", "visible", "hidden"):
        if gk in source:
            out[gk] = copy.deepcopy(source[gk])
    return out


def parse_domain_type(spec_val, path):
    """Normalize a scalar or domain type spec into (scalar_type, domain_meta_or_None)."""
    if isinstance(spec_val, str):
        if spec_val in SCALARS:
            return spec_val, None
        if spec_val in DOMAIN_SCALARS and spec_val not in ("enum", "ref"):
            return DOMAIN_SCALARS[spec_val], {"domain": spec_val}
        m_enum = re.fullmatch(r"enum\(([^)]+)\)", spec_val.strip())
        if m_enum:
            vals = [v.strip() for v in m_enum.group(1).replace("|", ",").split(",") if v.strip()]
            if not vals:
                fail("E_TYPE_NAME", path, "enum(...) requires at least one variant")
            return "text", {"domain": "enum", "values": vals, "labels": {}, "colors": {}}
        m_ref = re.fullmatch(r"ref<([A-Za-z_][A-Za-z0-9_-]*)>", spec_val.strip())
        if m_ref:
            return "text", {"domain": "ref", "entity": m_ref.group(1), "field": "id"}
        return spec_val, None
    if isinstance(spec_val, dict):
        dtype = spec_val.get("type", spec_val.get("domain"))
        if dtype == "enum" or "enum" in spec_val or "values" in spec_val:
            vals = spec_val.get("values") or spec_val.get("options") or spec_val.get("enum")
            if not isinstance(vals, list) or not vals or not all(isinstance(v, str) for v in vals):
                fail("E_TYPE_NAME", path, "enum domain type requires a nonempty string array 'values'")
            return "text", {
                "domain": "enum",
                "values": list(vals),
                "labels": dict(spec_val.get("labels", {})),
                "colors": dict(spec_val.get("colors", {})),
            }
        if dtype == "ref" or "target" in spec_val or "entity" in spec_val:
            target_ent = spec_val.get("entity", spec_val.get("target"))
            if not isinstance(target_ent, str) or not target_ent:
                fail("E_TYPE_NAME", path, "ref domain type requires target 'entity'")
            return "text", {"domain": "ref", "entity": target_ent, "field": spec_val.get("field", "id")}
        if isinstance(dtype, str) and dtype.startswith("enum(") and dtype.endswith(")"):
            return parse_domain_type(dtype, path)
        if isinstance(dtype, str) and dtype.startswith("ref<") and dtype.endswith(">"):
            return parse_domain_type(dtype, path)
        if dtype in DOMAIN_SCALARS:
            return DOMAIN_SCALARS[dtype], {"domain": dtype, **{k: v for k, v in spec_val.items() if k not in ("type", "domain")}}
        if dtype in SCALARS:
            return dtype, None
    return spec_val, None


def _canonical_ast_expr(ast):
    if not isinstance(ast, dict):
        return ast
    return {k: _canonical_ast_expr(v) for k, v in sorted(ast.items()) if k not in ("modelName",)}


_FLIP_OP = {"==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<="}
_NEG_OP = {"==": "!=", "!=": "==", "<": ">=", "<=": ">", ">": "<=", ">=": "<"}


def _atomic_when_constraint(ast):
    if not isinstance(ast, dict):
        return None
    kind = ast.get("kind")
    if kind == "call" and ast.get("fn") == "not" and len(ast.get("args", [])) == 1:
        inner = _atomic_when_constraint(ast["args"][0])
        if inner and inner[0] == "lit":
            _, expr_key, op, val = inner
            if isinstance(val, bool) and op == "==":
                return ("lit", expr_key, "==", not val)
            neg_op = _NEG_OP.get(op)
            if neg_op:
                return ("lit", expr_key, neg_op, val)
        elif inner and inner[0] == "rel":
            _, op, lk, rk = inner
            if op in ("==", "!="):
                return ("rel", "!=" if op == "==" else "==", lk, rk)
        return ("lit", json.dumps(_canonical_ast_expr(ast["args"][0]), sort_keys=True, ensure_ascii=False), "==", False)
    if kind == "binary":
        op = ast.get("op")
        left, right = ast.get("left"), ast.get("right")
        if op in _FLIP_OP and isinstance(left, dict) and isinstance(right, dict):
            if right.get("kind") == "literal" and left.get("kind") != "literal":
                val = right.get("value")
                if isinstance(val, bool) and op in ("==", "!="):
                    eff_val = val if op == "==" else (not val)
                    return ("lit", json.dumps(_canonical_ast_expr(left), sort_keys=True, ensure_ascii=False), "==", eff_val)
                return ("lit", json.dumps(_canonical_ast_expr(left), sort_keys=True, ensure_ascii=False), op, val)
            if left.get("kind") == "literal" and right.get("kind") != "literal":
                fop = _FLIP_OP[op]
                val = left.get("value")
                if isinstance(val, bool) and fop in ("==", "!="):
                    eff_val = val if fop == "==" else (not val)
                    return ("lit", json.dumps(_canonical_ast_expr(right), sort_keys=True, ensure_ascii=False), "==", eff_val)
                return ("lit", json.dumps(_canonical_ast_expr(right), sort_keys=True, ensure_ascii=False), fop, val)
            if op in ("==", "!="):
                lk = json.dumps(_canonical_ast_expr(left), sort_keys=True, ensure_ascii=False)
                rk = json.dumps(_canonical_ast_expr(right), sort_keys=True, ensure_ascii=False)
                pair = (lk, rk) if lk <= rk else (rk, lk)
                return ("rel", op, pair[0], pair[1])
    if ast.get("valueType") == "boolean":
        return ("lit", json.dumps(_canonical_ast_expr(ast), sort_keys=True, ensure_ascii=False), "==", True)
    return None


def _numeric_interval(op, val):
    v = float(val)
    if op == "==":
        return (v, True, v, True)
    if op == "<":
        return (float("-inf"), False, v, False)
    if op == "<=":
        return (float("-inf"), False, v, True)
    if op == ">":
        return (v, False, float("inf"), False)
    if op == ">=":
        return (v, True, float("inf"), False)
    return None


def _atomic_mutually_exclusive(ca, cb):
    if not ca or not cb:
        return False
    if ca[0] == "rel" and cb[0] == "rel":
        _, op1, l1, r1 = ca
        _, op2, l2, r2 = cb
        return l1 == l2 and r1 == r2 and {op1, op2} == {"==", "!="}
    if ca[0] == "lit" and cb[0] == "lit":
        _, ek1, op1, v1 = ca
        _, ek2, op2, v2 = cb
        if ek1 != ek2:
            return False
        is_num1 = isinstance(v1, (int, float)) and not isinstance(v1, bool)
        is_num2 = isinstance(v2, (int, float)) and not isinstance(v2, bool)
        if op1 == "==" and op2 == "==":
            if is_num1 and is_num2:
                return float(v1) != float(v2)
            return type(v1) is type(v2) and v1 != v2
        if {op1, op2} == {"==", "!="}:
            if is_num1 and is_num2:
                return float(v1) == float(v2)
            return type(v1) is type(v2) and v1 == v2
        if is_num1 and is_num2:
            iv1 = _numeric_interval(op1, v1)
            iv2 = _numeric_interval(op2, v2)
            if iv1 and iv2:
                lo1, lc1, hi1, hc1 = iv1
                lo2, lc2, hi2, hc2 = iv2
                if hi1 < lo2 or (hi1 == lo2 and not (hc1 and lc2)):
                    return True
                if hi2 < lo1 or (hi2 == lo1 and not (hc2 and lc1)):
                    return True
    return False


def _extract_conjuncts(ast):
    if isinstance(ast, dict) and ast.get("kind") == "binary" and ast.get("op") == "&&":
        return _extract_conjuncts(ast.get("left")) + _extract_conjuncts(ast.get("right"))
    return [ast]


def are_when_asts_mutually_exclusive(ast_a, ast_b):
    """Determine whether two compiled boolean runtime ASTs cannot both be true."""
    if not isinstance(ast_a, dict) or not isinstance(ast_b, dict):
        return False
    if ast_a.get("kind") == "binary" and ast_a.get("op") == "||":
        return are_when_asts_mutually_exclusive(ast_a.get("left"), ast_b) and are_when_asts_mutually_exclusive(ast_a.get("right"), ast_b)
    if ast_b.get("kind") == "binary" and ast_b.get("op") == "||":
        return are_when_asts_mutually_exclusive(ast_a, ast_b.get("left")) and are_when_asts_mutually_exclusive(ast_a, ast_b.get("right"))
    conj_a = [_atomic_when_constraint(x) for x in _extract_conjuncts(ast_a)]
    conj_b = [_atomic_when_constraint(x) for x in _extract_conjuncts(ast_b)]
    return any(_atomic_mutually_exclusive(ca, cb) for ca in conj_a for cb in conj_b)


_STATE_BOX_PROPS = (
    "layout", "w", "h", "gap", "padding", "align", "justify",
    "fill", "bg", "background", "stroke", "borderColor",
    "strokeWidth", "borderWidth", "radius", "rounded", "borderRadius",
    "columns", "equalHeight",
)


def normalize_panel_state_dict(st, pid, s_idx):
    if not isinstance(st, dict):
        return st
    st = copy.copy(st)
    if "id" not in st and isinstance(st.get("state"), str):
        st["id"] = st.pop("state")
    sid = st.get("id", f"state_{s_idx + 1}")
    for alias_k in ("title", "label"):
        if alias_k in st:
            if "name" not in st:
                st["name"] = st.pop(alias_k)
            else:
                st.pop(alias_k, None)
    if "root" not in st and (
        any(k in st for k in ("children", "body", "tree"))
        or isinstance(st.get("layout"), list)
    ):
        st_type = st.pop("type", None)
        if "children" in st:
            st_children = st.pop("children")
        elif "body" in st:
            st_children = st.pop("body")
        elif "tree" in st:
            st_children = st.pop("tree")
        else:
            st_children = st.pop("layout")
        default_layout = st_type if st_type in ("row", "column", "stack", "grid") else "column"
        box_root = {
            "type": "box",
            "id": f"{pid}_{sid}_root",
            "layout": st.pop("layout", default_layout) if isinstance(st.get("layout"), str) else default_layout,
            "w": st.pop("w", "fill"),
            "h": st.pop("h", "hug"),
            "gap": st.pop("gap", 12),
            "padding": st.pop("padding", 0),
            "children": st_children if isinstance(st_children, list) else ([st_children] if isinstance(st_children, dict) else st_children),
            "_auto_state_root": True,
        }
        for bk in _STATE_BOX_PROPS:
            if bk in st:
                box_root[bk] = st.pop(bk)
        st["root"] = box_root
    elif isinstance(st.get("root"), dict) and any(bk in st for bk in _STATE_BOX_PROPS):
        root_copy = copy.copy(st["root"])
        for bk in _STATE_BOX_PROPS:
            if bk in st:
                val = st.pop(bk)
                root_copy.setdefault(bk, val)
        st["root"] = root_copy
    return st


def normalize_panel_states_in_tree(node):
    if isinstance(node, dict):
        is_panel = (
            node.get("type") in ("dynamic-panel", "panel")
            or isinstance(node.get("dynamic-panel"), str)
            or isinstance(node.get("panel"), str)
        )
        if is_panel:
            pid = node.get("id") or node.get("dynamic-panel") or node.get("panel") or "panel"
            if isinstance(node.get("states"), dict) and node["states"]:
                node["states"] = [
                    (
                        {"id": sk, **sv}
                        if isinstance(sv, dict) and any(k in sv for k in ("root", "children", "body", "tree"))
                        else ({"id": sk, "root": sv} if isinstance(sv, dict) else {"id": sk, "children": sv})
                    )
                    for sk, sv in node["states"].items()
                ]
            if isinstance(node.get("states"), list):
                node["states"] = [
                    normalize_panel_state_dict(st, pid, s_idx)
                    for s_idx, st in enumerate(node["states"])
                ]
        for k, v in list(node.items()):
            if k in ("children", "states", "steps", "root", "template", "then", "else", "master", "detail", "body", "slots", "cell"):
                normalize_panel_states_in_tree(v)
    elif isinstance(node, list):
        for item in node:
            normalize_panel_states_in_tree(item)


def _resolve_pointer(doc, pointer, code="E_POINTER", report_pointer=None):
    if not pointer or pointer == "/":
        return doc
    cur = doc
    for part in _pointer_parts(pointer, code):
        if isinstance(cur, list):
            idx = _array_index(part, len(cur), report_pointer or pointer, code)
            cur = cur[idx]
        elif isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            fail(code, report_pointer or pointer, "Pointer target does not exist")
    return cur
def _pointer_parts(pointer, code="E_POINTER"):
    if not isinstance(pointer, str) or (pointer not in ("", "/") and not pointer.startswith("/")) or re.search(r"~(?![01])", pointer):
        fail(code, pointer if isinstance(pointer, str) else "/", "Expected a valid JSON pointer")
    return [] if pointer in ("", "/") else [p.replace("~1", "/").replace("~0", "~") for p in pointer[1:].split("/")]
def _array_index(part, length, pointer, code="E_POINTER", append=False):
    if append and part == "-":
        return length
    if not re.fullmatch(r"0|[1-9][0-9]*", part):
        fail(code, pointer, "Array index must be a nonnegative integer without leading zeros")
    index = int(part)
    if (index > length if append else index >= length):
        fail(code, pointer, "Array index is out of bounds")
    return index
