"""RP/1 semantic frontend. Pure JSON in -> checked IR and legacy layout spec out.

No eval, GUI, filesystem reads, or implicit record defaults. References are
resolved before native generation; IDs describe source identity, not native GUIDs.
"""
import copy
import difflib
import hashlib
import json
import math
import re
import string
from rp_product import expand_product_spec, compute_product_impact


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


def fields(value, allowed, path):
    if not isinstance(value, dict):
        fail("E_OBJECT", path, "Expected an object")
    for key in value:
        if key not in allowed:
            hint = difflib.get_close_matches(key, sorted(allowed), n=3)
            suffix = f"; did you mean '{hint[0]}'?" if hint else ""
            cands = None
            if hint:
                cands = [{
                    "description": f"Rename property '{key}' to '{h}'",
                    "operations": [
                        {"op": "remove", "path": ptr(path, key)},
                        {"op": "add", "path": ptr(path, h), "value": value[key]},
                    ],
                } for h in hint[:2]]
            fail("E_PROPERTY", ptr(path, key), f"Unknown property '{key}'{suffix}", suggestions=hint, candidate_patches=cands)


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
COLOR_TOKENS = {"bg", "surface", "surface-2", "surface-3", "sidebar-bg", "sidebar-surface",
                "sidebar-active", "sidebar-ink", "sidebar-ink-active", "ink", "ink-2", "ink-3",
                "ink-inv", "line", "line-strong", "brand", "brand-soft", "accent", "accent-soft",
                "success", "success-soft", "warning", "warning-soft", "danger", "danger-soft", "backdrop",
                "glass", "glass-strong", "glass-border", "glass-stroke", "glow", "glow-2"}
GEOMETRY = {"x", "y", "w", "h", "flex", "colSpan", "rowSpan", "right", "bottom", "anchor"}
STYLE_EXTRAS = {"opacity", "strokeWidth", "borderSides", "borderTop", "borderBottom", "borderLeft", "borderRight",
                "backdropBlur", "shadow", "gradient", "aurora", "noise", "innerGlow"}
TEXT = {"text", "fontSize", "size", "fontWeight", "weight", "color", "align", "letterSpacing", "italic", "underline", "strikethrough", "spans"}
BOX = {"layout", "padding", "gap", "align", "justify", "wrap", "equalHeight", "columns",
       "columnGap", "rowGap", "children", "fill", "stroke", "radius"} | STYLE_EXTRAS
NODE_PROPS = {
    "box": BOX,
    "card": BOX | {"variant"},
    "label": TEXT | {"fill", "stroke", "radius"} | STYLE_EXTRAS,
    "paragraph": TEXT | {"lineGap", "lineHeight", "maxLines", "padding", "fill", "stroke", "radius"} | STYLE_EXTRAS,
    "button": TEXT | {"variant", "fill", "stroke", "radius", "icon"} | STYLE_EXTRAS,
    "badge": TEXT | {"variant", "fill", "stroke", "radius", "icon"} | STYLE_EXTRAS,
    "input": {"value", "placeholder", "native", "fill", "stroke", "radius", "fontSize", "size", "fontWeight", "weight", "color", "align", "textPaddingX"} | STYLE_EXTRAS,
    "divider": {"direction", "color", "fill", "opacity"},
    "image": {"src", "radius", "opacity", "shadow"},
    "icon": {"icon", "color", "fill", "stroke", "radius", "strokeWidth"} | STYLE_EXTRAS,
    "sparkline": {"points", "color", "fill", "stroke", "radius", "smooth", "strokeWidth"} | STYLE_EXTRAS,
    "dynamic-panel": {"states"},
    "repeater": {"dataset", "key", "template", "rowGap", "rowHeight", "pageSize"},
    "when": {"condition", "then", "else", "layout", "gap"},
}
EVENTS = {"click": "OnClick", "change": "OnTextChange", "load": "OnLoad",
          "mouseover": "OnMouseOver", "mouseout": "OnMouseOut",
          "focus": "OnFocus", "blur": "OnLostFocus",
          "statechange": "OnPanelStateChange"}
ACTION_PROPS = {
    "set-text": {"target", "text"},
    "set-variable": {"variable", "value"},
    "set-panel-state": {"target", "state"},
    "show": {"target"}, "hide": {"target"}, "toggle": {"target"},
    "enable": {"target"}, "disable": {"target"}, "focus": {"target"},
    "link": {"page"}, "wait": {"ms"},
    "data-add": {"target", "rows"}, "data-delete": {"target", "where"},
    "data-update": {"target", "where", "set"}, "data-filter": {"target", "where", "name"},
    "data-clear-filter": {"target"}, "data-sort": {"target", "column", "direction"},
    "data-clear-sort": {"target"}, "data-page": {"target", "page"},
}


SHORTHAND_NODE_KINDS = {
    "box", "card", "row", "column", "grid", "stack", "label", "paragraph",
    "button", "badge", "input", "divider", "image", "icon", "sparkline", "dynamic-panel",
    "repeater", "repeat", "use", "when",
    "data-table", "searchable-list", "form-card", "kv-list",
    "detail-card", "wizard-card", "master-detail",
}
EVENT_SHORTHANDS = {
    "onClick": "click", "onChange": "change", "onLoad": "load",
    "onMouseOver": "mouseover", "onMouseOut": "mouseout",
    "onFocus": "focus", "onBlur": "blur", "onStateChange": "statechange",
}
# Source contracts are shared with the editor schema; expansion must not erase input.
MACRO_COMMON_PROPS = {"type", "id", "name", "on", "size", "slots", "when"} | GEOMETRY | set(EVENT_SHORTHANDS)
MACRO_PROPS = {
    "data-table": MACRO_COMMON_PROPS | {"dataset", "key", "columns", "rowHeight", "headerHeight", "columnGap", "gap", "padding", "headerFill", "headerStroke", "headerRadius", "rowFill", "rowStroke", "rowRadius", "rowOn", "onRowClick", "repeaterHeight", "rowGap", "pageSize", "tableGap"},
    "searchable-list": MACRO_COMMON_PROPS | {"dataset", "key", "searchField", "filterField", "filterWhere", "baseWhere", "template", "inputId", "value", "inputHeight", "inputFill", "inputStroke", "inputRadius", "filters", "repeaterHeight", "rowHeight", "rowGap", "pageSize", "gap", "padding", "fill", "stroke", "radius"},
    "form-card": MACRO_COMMON_PROPS | {"fields", "title", "titleFontSize", "submitText", "onSubmit", "submitId", "submitHeight", "submitVariant", "padding", "gap", "fill", "stroke", "radius"},
    "kv-list": MACRO_COMMON_PROPS | {"items", "rowHeight", "labelWidth", "fontSize", "padding", "gap", "fill", "stroke", "radius"},
    "detail-card": MACRO_COMMON_PROPS | {"title", "subtitle", "badge", "items", "actions", "rowHeight", "labelWidth", "fontSize", "padding", "gap", "fill", "stroke", "radius"},
    "wizard-card": MACRO_COMMON_PROPS | {"title", "stepVariable", "steps", "bodyHeight", "onComplete", "padding", "gap", "fill", "stroke", "radius"},
    "master-detail": MACRO_COMMON_PROPS | {"master", "detail", "masterWidth", "listWidth", "dataset", "key", "searchField", "filterField", "filters", "template", "repeaterHeight", "rowHeight", "rowGap", "gap", "padding", "fill", "stroke", "radius"},
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
    r"""(?P<OP2>==|!=|>=|<=|&&|\|\|)|"""
    r"""(?P<NUMBER>\d+(?:\.\d+)?)|"""
    r"""(?P<STRING>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|"""
    r"""(?P<SIGIL>[$@][A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)|"""
    r"""(?P<IDENT>[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)|"""
    r"""(?P<OP1>[+\-*/><!(),])"""
    r""")"""
)


def sanitize_dingbats(val):
    return val.translate(DINGBAT_SAFE_MAP) if isinstance(val, str) else val


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
            tokens.append((kind, raw))
    return tokens


def parse_inline_expr(expr_text, path):
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

    def parse_or():
        left = parse_and()
        while peek()[1] == "||":
            consume("||")
            left = {"op": "||", "left": left, "right": parse_and()}
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
            left = {"op": op, "left": left, "right": parse_add()}
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
            left = {"op": op, "left": left, "right": parse_unary()}
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
        return parse_primary()

    def parse_primary():
        tok_kind, tok_val = peek()
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
            if sigil == "@":
                return {"widget": {"ref": name}}
            if "." in name:
                return {"_auto_path": name}
            return {"_sigil_var": name}
        if tok_kind == "IDENT":
            consume()
            if tok_val in ("true", "True"):
                return True
            if tok_val in ("false", "False"):
                return False
            if peek()[1] == "(":
                consume("(")
                args = []
                if peek()[1] != ")":
                    args.append(parse_or())
                    while peek()[1] == ",":
                        consume(",")
                        args.append(parse_or())
                consume(")")
                return {"fn": tok_val, "args": args}
            if "." in tok_val:
                head, rest = tok_val.split(".", 1)
                if head in ("row", "Item") and "." not in rest:
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
    for sk in ("emptyState", "footer"):
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
    rep_node = {
        "type": "repeater",
        "id": list_id,
        "dataset": dataset,
        "key": key,
        "w": "fill",
        "h": source.get("repeaterHeight", "hug"),
        "rowHeight": source.get("rowHeight", 64),
        "rowGap": source.get("rowGap", 8),
        "template": tpl_copy,
    }
    if "pageSize" in source:
        rep_node["pageSize"] = source["pageSize"]
    children.append(rep_node)
    for sk in ("emptyState", "footer"):
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
    if "footer" in slots and isinstance(slots["footer"], dict):
        snode = copy.deepcopy(slots["footer"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "footer")
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
    if "title" in source or "badge" in source:
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
    if "footer" in slots and isinstance(slots["footer"], dict):
        snode = copy.deepcopy(slots["footer"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "footer")
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
        guard_msg = st.get("guardMessage", st.get("errorText", st.get("errorMessage", "请先完成当前步骤必填项")))
        if guard_expr is not None:
            next_click = {
                "cases": [
                    {"when": guard_expr, "actions": ok_actions},
                    {"else": True, "actions": [{"type": "set-text", "target": err_id, "text": guard_msg}]},
                ]
            }
        else:
            next_click = ok_actions
        if next_sid or user_next or "nextText" in st:
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
    if "header" in slots and isinstance(slots["header"], dict):
        snode = copy.deepcopy(slots["header"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "header")
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
    if "footer" in slots and isinstance(slots["footer"], dict):
        snode = copy.deepcopy(slots["footer"])
        snode["_slot_origin"] = ptr(ptr(path, "slots"), "footer")
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
    else:
        if not isinstance(master_node, dict):
            fail("E_PROPERTY_REQUIRED", ptr(path, "master"), "master-detail requires a master node object or dataset/searchField/template")
        master_origin = ptr(path, "master")
    if not isinstance(detail_node, dict):
        fail("E_PROPERTY_REQUIRED", ptr(path, "detail"), "master-detail requires a detail node object")
    slots = source.get("slots") if isinstance(source.get("slots"), dict) else {}
    m_copy = copy.deepcopy(master_node)
    m_copy["_slot_origin"] = master_origin
    m_copy.setdefault("w", list_w)
    d_copy = copy.deepcopy(detail_node)
    d_copy["_slot_origin"] = ptr(path, "detail")
    if "w" not in d_copy and "flex" not in d_copy:
        d_copy["flex"] = 1
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
    if not slots:
        row_box["id"] = f"{md_id}_container" if m_copy.get("id") == md_id else md_id
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
        "id": f"{md_id}_container" if m_copy.get("id") == md_id else md_id,
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


class Frontend:
    def __init__(self, spec):
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
        self.row_conditionals = []
        self.page_conditionals = []
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
        if isinstance(self.spec.get("product"), dict):
            expanded, prov = expand_product_spec(self.spec, fail, ident, fields, self.typecheck)
            self.spec.clear()
            self.spec.update(expanded)
            self.product_provenance = prov
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
        raw_pages = self.spec.get("pages")
        if isinstance(raw_pages, list):
            domain = self.spec.get("domain", "mobile")
            default_canvas = {"w": 1440, "h": 900} if domain in ("web", "doc") else {"w": 375, "h": 812}
            for idx, page in enumerate(raw_pages):
                if isinstance(page, dict):
                    if "name" not in page and isinstance(page.get("id"), str):
                        page["name"] = page["id"]
                    if "passthrough_layer" in page:
                        pid_key = page.get("id", f"page_{idx}")
                        self.passthrough_layers[pid_key] = copy.deepcopy(page.pop("passthrough_layer"))
                    if "canvas" not in page:
                        page["canvas"] = copy.deepcopy(default_canvas)
                    elif isinstance(page.get("canvas"), list) and len(page["canvas"]) == 2:
                        page["canvas"] = {"w": page["canvas"][0], "h": page["canvas"][1]}
                    if "layout" in page and "root" not in page:
                        lay_val = page.pop("layout")
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
                        for m_item in (m_refs if isinstance(m_refs, list) else []):
                            m_id = m_item if isinstance(m_item, str) else m_item.get("master", m_item.get("id"))
                            m_x = 0 if isinstance(m_item, str) else m_item.get("x", 0)
                            m_y = 0 if isinstance(m_item, str) else m_item.get("y", 0)
                            m_def = raw_masters.get(m_id)
                            if isinstance(m_def, dict) and "root" not in m_def and isinstance(m_def.get("layout"), list):
                                m_def["root"] = {"column": m_id, "w": m_def.get("w", 220), "h": m_def.get("h", page["canvas"]["h"]), "children": copy.deepcopy(m_def["layout"])}
                            if not isinstance(m_def, dict) or not isinstance(m_def.get("root"), dict):
                                fail("E_MASTER", ptr("/masters", m_id), "Master must exist and define a root or layout")
                            if isinstance(m_def, dict) and isinstance(m_def.get("root"), dict):
                                placements.append({
                                    "master": m_id,
                                    "name": m_def.get("name", m_id),
                                    "x": m_x,
                                    "y": m_y,
                                    "w": m_def.get("w", 220),
                                    "h": m_def.get("h", page["canvas"]["h"]),
                                })
                                m_copy = copy.deepcopy(m_def["root"])
                                m_copy["_master_instance"] = m_id
                                master_nodes.append(m_copy)
                        if placements:
                            self.page_master_placements[page.get("id", f"page_{idx}")] = placements
                        if "slot" in page and "root" not in page:
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
            # P0-1: Desugar top-level and page-level `views` into runtime selection bindings
            def _collect_node_ids(node, out_set):
                if not isinstance(node, dict):
                    return
                for k in ("id", *SHORTHAND_NODE_KINDS):
                    if k in node and isinstance(node[k], str) and k != "type":
                        out_set.add(node[k])
                for ch in (node.get("children") or []):
                    _collect_node_ids(ch, out_set)
                for st in (node.get("states") or []):
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

            def _normalize_view_entry(vid, vdef, default_page_id=None):
                if not isinstance(vdef, dict):
                    return None
                ds_name = vdef.get("source") or vdef.get("dataset")
                key_field = vdef.get("key", "id")
                sel_var = (vdef.get("selector") or vdef.get("variable") or f"selected_{ds_name}").lstrip("$")
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
                    nv = _normalize_view_entry(vid, vdef)
                    if nv:
                        normalized_views.append(nv)
            elif isinstance(top_views, list):
                for idx_v, vdef in enumerate(top_views):
                    vid = vdef.get("id", f"view_{idx_v + 1}") if isinstance(vdef, dict) else f"view_{idx_v + 1}"
                    nv = _normalize_view_entry(vid, vdef)
                    if nv:
                        normalized_views.append(nv)
            for page in raw_pages:
                if not isinstance(page, dict):
                    continue
                p_views = page.get("views")
                if isinstance(p_views, dict):
                    for vid, vdef in p_views.items():
                        nv = _normalize_view_entry(vid, vdef, default_page_id=page.get("id"))
                        if nv:
                            normalized_views.append(nv)
                elif isinstance(p_views, list):
                    for idx_v, vdef in enumerate(p_views):
                        vid = vdef.get("id", f"view_{idx_v + 1}") if isinstance(vdef, dict) else f"view_{idx_v + 1}"
                        nv = _normalize_view_entry(vid, vdef, default_page_id=page.get("id"))
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
                    for ch in (node.get("children") or []):
                        _expand_rules_in_node(ch)
                    for st in (node.get("states") or []):
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
                for ch in (node.get("children") or []):
                    _scan_repeaters_and_adds(ch, pid, rep_id_to_ds)
                for st in (node.get("states") or []):
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
        fields(source, MACRO_PROPS[kind], path)
        if "slots" in source:
            if not isinstance(source["slots"], dict):
                fail("E_OBJECT", ptr(path, "slots"), "slots must be an object mapping slot names to node objects")
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
                    source["filters"] = []
        for array_key, allowed in MACRO_ITEM_PROPS[kind].items():
            if array_key not in source and array_key in ("filters", "actions"):
                continue
            entries = source.get(array_key)
            if not isinstance(entries, list) or (not entries and array_key not in ("filters", "actions")):
                fail("E_TYPE", ptr(path, array_key), f"{array_key} must be a {'nonempty ' if array_key not in ('filters', 'actions') else ''}array")
            for idx, entry in enumerate(entries):
                ep = ptr(ptr(path, array_key), idx)
                if array_key == "filters" and isinstance(entry, str):
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
                for prop in {"h", "fontSize", "fontWeight", "headerFontSize", "headerFontWeight", "radius", "flex"} & set(entry):
                    self.typecheck(entry[prop], "number", ptr(ep, prop))
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
        for prop in {"rowHeight", "headerHeight", "columnGap", "gap", "rowGap", "tableGap", "inputHeight", "inputRadius", "titleFontSize", "submitHeight", "labelWidth", "fontSize", "radius", "pageSize", "bodyHeight", "masterWidth"} & set(source):
            value = source[prop]
            self.typecheck(value, "number", ptr(path, prop))
            if value < 0:
                fail("E_SIZE", ptr(path, prop), "Value must be nonnegative")
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
            if isinstance(node, dict) and "_slot_origin" in node:
                origin = node.pop("_slot_origin")
                structural = True
            self.source_origins[id(node)] = (node, origin)
            for idx, child in enumerate(node.get("children", [])):
                mark(child, ptr(ptr(origin, "children"), idx) if structural else origin, structural)
            if isinstance(node.get("template"), dict):
                mark(node["template"], ptr(origin, "template") if structural else origin, structural)
            for idx, state in enumerate(node.get("states", [])):
                mark(state["root"], ptr(ptr(ptr(origin, "states"), idx), "root") if structural else origin, structural)

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
                        else:
                            source["type"] = k
                            source["id"] = val
                        break
        elif source.get("type") in ("row", "column", "grid", "stack"):
            kind = source["type"]
            source["type"] = "box"
            source.setdefault("layout", kind)
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
            else:
                source = {
                    "data-table": expand_data_table_macro,
                    "form-card": expand_form_card_macro,
                    "kv-list": expand_kv_list_macro,
                    "detail-card": expand_detail_card_macro,
                    "master-detail": expand_master_detail_macro,
                }[kind](source, path)
            for key in {"on", "name", "when"} | set(EVENT_SHORTHANDS):
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
        if isinstance(actions, dict) and "cases" not in actions:
            actions = [actions]
        if not isinstance(actions, list):
            return actions
        expanded = []
        for idx, act in enumerate(actions):
            if not isinstance(act, dict):
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
                if keys == {"goto"}:
                    expanded.append({"type": "link", "page": act["goto"]})
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
            if isinstance(act.get("target"), str):
                act["target"] = {"ref": act["target"]}
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
                    if fn == "concat" and len(args) >= 2 and all(type(a) is str for a in args):
                        return "".join(args)
                return {"fn": fn, "args": args}
        return node

    def expression(self, value, env, path):
        if isinstance(value, str):
            if "${" in value:
                return self.expression(parse_template_string(value, path), env, path)
            if value.startswith("=") and not value.startswith("=="):
                return self.expression(parse_inline_expr(value, path), env, path)
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
        candidates = []
        current = scope
        while current:
            candidates.append(current + "/" + name)
            current = current.rpartition("/")[0]
        candidates.append(name)
        for candidate in candidates:
            if candidate in self.symbols:
                return self.symbols[candidate]
        page_prefix = scope.split("/")[0] + "/"
        local_ids = sorted({k.rsplit("/", 1)[-1] for k in self.symbols if k.startswith(page_prefix)})
        hint = difflib.get_close_matches(name, local_ids, n=3)
        fail("E_REFERENCE", path, f"Unknown reference '{name}' in scope '{scope}'", suggestions=hint)

    def node(self, source, scope, env, path, stack=(), panel_depth=0):
        if not isinstance(source, dict):
            fail("E_OBJECT", path, "Expected a node object")
        origin = self.source_origins.get(id(source))
        if origin is not None and origin[0] is source:
            path = origin[1]
        source = self.desugar_node(source, path, scope)
        if not isinstance(source.get("type"), str):
            fail("E_NODE_TYPE", ptr(path, "type"), "Node type must be text")
        fields(source, {"type", "id", "name", "on", "when", "adaptive", "_hidden_lookup", "_master_instance"} | GEOMETRY |
               NODE_PROPS.get(source.get("type"), set()) |
               ({"component", "args"} if source.get("type") == "use" else set()) |
               ({"dataset", "as", "key", "template"} if source.get("type") == "repeat" else set()), path)
        nid = ident(source.get("id"), ptr(path, "id"))
        kind = source.get("type")
        logical = scope + "/" + nid
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
            if node_when_meta is not None and isinstance(use_res, dict):
                use_res["_when_meta"] = node_when_meta
            return use_res
        if kind == "repeater":
            rep_res = self.repeater_node(source, scope, env, path, stack, panel_depth)
            if node_when_meta is not None and isinstance(rep_res, dict):
                rep_res["_when_meta"] = node_when_meta
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
            return repeat_box
        if kind not in NODE_PROPS:
            fail("E_NODE_TYPE", ptr(path, "type"), f"Unsupported RP/1 node '{kind}'")
        eval_text = self.expression(source["text"], env, ptr(path, "text")) if "text" in source else None
        runtime_text = eval_text if isinstance(eval_text, dict) else None
        if runtime_text is not None:
            if kind not in {"label", "button", "badge"}:
                fail("E_TARGET_TYPE", ptr(path, "text"), "Runtime text bindings need label/button/badge")
            self.value_bindings.append((logical, scope, runtime_text, ptr(path, "text")))
        if self.row_context(scope)[1] is not None and kind in {"input", "dynamic-panel"}:
            fail("E_ROW_CONTAINER", path, "Row templates currently support visual nodes and events")
        if "size" in source and "fontSize" not in source:
            source = {**source, "fontSize": source["size"]}
        if "weight" in source and "fontWeight" not in source:
            source = {**source, "fontWeight": source["weight"]}
        values = self.expression({k: ("" if k == "text" and runtime_text is not None else (eval_text if k == "text" else v)) for k, v in source.items()
                                  if k not in {"children", "states", "on", "id", "name", "when", "size", "weight"}}, env, path)
        if "fontWeight" in values:
            values["fontWeight"] = normalize_font_weight(values["fontWeight"])
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
            elif key in {"x", "y", "right", "bottom", "flex", "gap", "columnGap", "rowGap", "radius", "fontSize", "fontWeight", "textPaddingX", "lineGap", "lineHeight", "letterSpacing", "opacity", "strokeWidth", "backdropBlur", "maxLines"}:
                self.typecheck(value, "number", pp)
                if key not in {"x", "y", "right", "bottom", "letterSpacing"} and value < 0:
                    fail("E_SIZE", pp, "Value must be nonnegative")
                if key == "lineHeight" and value == 0:
                    fail("E_SIZE", pp, "lineHeight must be positive")
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
            elif key in {"native", "equalHeight", "wrap", "italic", "underline", "strikethrough", "smooth", "borderTop", "borderBottom", "borderLeft", "borderRight"}:
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
        for key, choices in {"layout": {"row", "column", "stack", "grid"},
                             "justify": {"start", "center", "end", "space-between", "space-around", "space-evenly"},
                             "variant": {"primary", "secondary", "outline", "soft", "danger", "glass", "ghost"},
                             "direction": {"horizontal", "vertical"},
                             "anchor": {"top-left", "top-right", "bottom-left", "bottom-right", "center"}}.items():
            if key in values and values[key] not in choices:
                fail("E_ENUM", ptr(path, key), f"Expected one of {sorted(choices)}")
        if "align" in values:
            choices = {"start", "center", "end", "stretch"} if kind in {"box", "card"} else {"left", "center", "right"}
            if values["align"] not in choices:
                fail("E_ENUM", ptr(path, "align"), f"Expected one of {sorted(choices)}")
        if kind == "input":
            if values.get("native") is False:
                fail("E_INPUT", path, "RP/1 inputs are native; use a box/label for decoration")
            values["native"] = True
        if kind == "image" and not values.get("src"):
            fail("E_PROPERTY_REQUIRED", ptr(path, "src"), "Image requires src")
        if "name" in source:
            self.typecheck(source["name"], "text", ptr(path, "name"))
        if runtime_text is not None: values.setdefault("w", "fill")
        values["name"] = self.register(logical, kind, source, path)
        if "children" in source:
            if not isinstance(source["children"], list):
                fail("E_TYPE", ptr(path, "children"), "Expected a node array")
            values["children"] = [self.node(c, scope, env, ptr(ptr(path, "children"), i), stack, panel_depth)
                                  for i, c in enumerate(source["children"])]
        if kind == "dynamic-panel":
            states = source.get("states")
            if not isinstance(states, list) or not states:
                fail("E_STATE", ptr(path, "states"), "Panel requires nonempty states")
            values["states"], names = [], set()
            for i, state in enumerate(states):
                sp = ptr(ptr(path, "states"), i)
                fields(state, {"id", "root"}, sp)
                sid = ident(state.get("id"), ptr(sp, "id"))
                if sid in names:
                    fail("E_STATE", sp, f"Duplicate state '{sid}'")
                names.add(sid)
                values["states"].append({"name": sid, "prefix": values["name"] + "-" + sid,
                    "root": self.node(state.get("root"), logical + "/" + sid, env,
                                      ptr(sp, "root"), stack, panel_depth + 1)})
            self.symbols[logical]["states"] = sorted(names)
        if "on" in source:
            if not isinstance(source["on"], dict):
                fail("E_EVENT", ptr(path, "on"), "on must be an event map")
            if kind != "input" and any(event in source["on"] for event in ("change", "focus", "blur", "OnTextChange", "OnFocus", "OnLostFocus")):
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
                  "button": "btn", "badge": "badge", "input": "inp", "image": "img",
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
                        lines_cap = max(1, int(actual_h // max(14, fsz + 3))) if node.get("type") == "label" else 1
                        pad_extra = 8 if node.get("type") in ("badge", "button") else 0
                        needed_w = int(math.ceil((max_px / lines_cap) + max(4, pad_extra)))
                        if (max_px / lines_cap) + pad_extra > actual_w + 2:
                            w_ptr = ptr(symbol["pointer"], "w")
                            cands = [
                                {
                                    "description": f"Expand width to {needed_w}px to fit worst-case dataset row #{worst_idx} ('{worst_txt}')",
                                    "operations": [{"op": "replace", "path": w_ptr, "value": needed_w}],
                                },
                                {
                                    "description": "Use elastic width 'fill'",
                                    "operations": [{"op": "replace", "path": w_ptr, "value": "fill"}],
                                },
                            ]
                            fail(
                                "E_DATASET_WORST_CASE_OVERFLOW",
                                w_ptr,
                                f"Dataset row #{worst_idx} text '{worst_txt}' (~{int(math.ceil(max_px))}px) overflows fixed width {actual_w}px (recommended >= {needed_w}px)",
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
        if fn == "concat": return "".join(args)
        if fn == "lower": return args[0].lower()
        if fn == "upper": return args[0].upper()
        if fn == "length": return len(args[0].encode("utf-16-le")) // 2
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
                if name in symbols_by_name and symbols_by_name[name]["pageId"] == page["slug"] and symbols_by_name[name]["kind"] == "input":
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
                symbol = self.resolve(value["widget"], scope, ptr(path, "widget"))
                if symbol["pageId"] != scope.split("/")[0] or symbol["kind"] not in {"input", "label", "button", "badge"}:
                    fail("E_TARGET_TYPE", path, "Runtime text read needs a text-capable widget in this page")
                source_row = self.row_context(symbol["id"])[0]
                if source_row and source_row != self.row_context(scope)[0]:
                    fail("E_ROW_SCOPE", path, "Row widget text belongs to its row instance")
                typ, out = "text", {"kind": "widget", "name": symbol["name"], "valueType": "text"}
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
                              "lower": ("text", "text"), "upper": ("text", "text"), "length": ("text", "number")}
                if not isinstance(args, list) or (fn == "concat" and len(args) < 2) or (fn != "concat" and len(args) != 1):
                    fail("E_ARGUMENT", path, "concat needs at least two values; other functions need one")
                if fn != "concat" and fn not in signatures:
                    fail("E_FUNCTION", path, f"Unknown runtime function '{fn}'")
                arg_type, typ = ("text", "text") if fn == "concat" else signatures[fn]
                compiled = [self.runtime(v, scope, ptr(ptr(path, "args"), i), expected=arg_type, row=row) for i, v in enumerate(args)]
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
        template = self.node(source.get("template"), logical + "/item", {**env, "_repeater_shadows_item": True}, ptr(path, "template"), stack, panel_depth)
        result = {"type": "repeater", "name": name, "template": template, "rows": dataset["rows"], "model": model,
                  "rowGap": source.get("rowGap", 0), "rowHeight": source.get("rowHeight", 48), "pageSize": source.get("pageSize", 0),
                  **{k: source[k] for k in (GEOMETRY | {"adaptive", "_hidden_lookup", "_master_instance"}) if k in source}}
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
        if isinstance(action, dict) and "type" not in action:
            expanded = self.desugar_action_list([action], path)
            if len(expanded) > 1:
                return [self.action(item, scope, path) for item in expanded]
            action = expanded[0]
        kind = action.get("type") if isinstance(action, dict) else None
        if not isinstance(kind, str) or kind not in ACTION_PROPS:
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
            if kind == "set-text" and target["kind"] not in {"label", "button", "badge", "input"}:
                fail("E_TARGET_TYPE", path, "set-text requires label/button/badge/input")
            if kind in {"focus", "enable", "disable"} and target["kind"] != "input":
                fail("E_TARGET_TYPE", path, f"{kind} requires a native input")
            if kind == "set-panel-state":
                if target["kind"] != "dynamic-panel" or action.get("state") not in target.get("states", []):
                    fail("E_STATE", ptr(path, "state"), "State must belong to the target panel")
            out["target"] = target["name"]
        if kind == "set-text":
            value = self.runtime(action.get("text"), scope, ptr(path, "text"), expected="text")
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
            if not native or (page and event not in {"load", "OnLoad"}):
                fail("E_EVENT", ep, f"Unsupported event '{event}'")
            if native in names:
                fail("E_EVENT", ep, f"Duplicate event alias '{event}'")
            names.add(native)
            if isinstance(actions, dict) and "cases" not in actions:
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
                fields(case, {"when", "else", "actions"}, cp)
                if "else" in case:
                    self.typecheck(case["else"], "boolean", ptr(cp, "else"))
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
                    compiled["when"] = self.condition(case["when"], scope, ptr(cp, "when"))
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
                raw_macro = _resolve_pointer(self.spec, call)
                if error.diagnostic["code"] == "E_EVENT_TARGET" and path == ptr(call, "on") and "on" not in raw_macro:
                    unsupported = next((key for key in ("onChange", "onFocus", "onBlur", "onStateChange") if key in raw_macro), None)
                    if unsupported:
                        fail(error.diagnostic["code"], ptr(call, unsupported), error.diagnostic["message"])
                candidate = path
                while candidate:
                    try:
                        _resolve_pointer(self.spec, candidate)
                        break
                    except LanguageError:
                        candidate = candidate.rpartition("/")[0]
                if candidate and candidate != path:
                    fail(error.diagnostic["code"], candidate, error.diagnostic["message"], error.diagnostic.get("suggestions"))
            raise

    def _compile(self):
        fields(self.spec, {"$schema", "language", "target", "name", "theme", "palette", "domain", "shell", "static", "strictAudit", "devMode",
                           "product", "models", "datasets", "variables", "computed", "statecharts", "transactions", "invariants", "components",
                           "views", "rules", "masters", "adaptiveViews", "pages"}, "")
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
        lowered = {k: copy.deepcopy(self.spec[k]) for k in ["name", "theme", "palette", "domain", "static", "strictAudit", "masters", "adaptiveViews"] if k in self.spec}
        lowered["pages"] = []
        for i, page in enumerate(pages):
            pp = ptr("/pages", i)
            fields(page, {"id", "name", "canvas", "root", "on", "bindings", "views", "master", "masters", "slot"}, pp)
            pid = ident(page.get("id"), ptr(pp, "id"))
            self.typecheck(page.get("name"), "text", ptr(pp, "name"))
            if pid in self.pages or any(p["name"] == page["name"] for p in self.pages.values()):
                fail("E_PAGE", pp, "Duplicate page ID or name")
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
            by_id[symbol["pageId"]]["interactions"].append({"trigger": symbol["name"],
                "sourceId": logical, "sourcePointer": path,
                "events": self.events(declarations, scope, path)})
        for i, page in enumerate(pages):
            pid, pp = page["id"], ptr("/pages", i)
            self.current_trigger_name = "page"
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
                    if symbol["pageId"] != pid or symbol["kind"] not in {"label", "button", "badge", "input"}:
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
            owner = node.get("_master_instance", owner)
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
              "models": self.models, "datasets": self.datasets, "variables": self.variables,
              "symbols": symbols, "pages": lowered["pages"], "diagnostics": []}
        if self.domain_models:
            ir["domainModels"] = self.domain_models
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
    return Frontend(spec).compile()


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
        for p in self.ir["pages"]:
            self._index_tree(p["root"], p["slug"], None)
        self.current_page = self.ir["pages"][0]["slug"]
        self._run_page_load(self.current_page)

    def _index_tree(self, node, page_slug, rep_name, parent=None, panel_states=()):
        name, kind = node.get("name"), node.get("type")
        if name:
            self.widgets[name] = {
                "name": name, "kind": kind, "page": page_slug, "repeater": rep_name,
                "text": str(node.get("value" if kind == "input" else "text", "")),
                "visible": True, "enabled": True,
                "parent": parent, "panelStates": list(panel_states),
            }
        if kind == "dynamic-panel":
            states = [s["name"] for s in node.get("states", [])]
            self.panels[name] = {"current": states[0] if states else "", "states": states, "page": page_slug}
            for st in node.get("states", []):
                self._index_tree(st["root"], page_slug, rep_name, name, (*panel_states, (name, st["name"])))
        elif kind == "repeater":
            self.repeaters[name] = {
                "name": name, "page": page_slug, "model": copy.deepcopy(node.get("model", {})),
                "rows": copy.deepcopy(node.get("rows", [])), "filters": {}, "sort": None,
                "page_num": 1, "page_size": node.get("pageSize", 0), "template": node.get("template"),
                "visible_rows": None,
            }
            if isinstance(node.get("template"), dict):
                self._index_tree(node["template"], page_slug, name, name, panel_states)
        for child in node.get("children", []):
            self._index_tree(child, page_slug, rep_name, name, panel_states)

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
            w = self.widgets.get(ast["name"], {})
            return w.get("text", "")
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
            args = [self.eval_expr(a, row=row) for a in ast.get("args", [])]
            if fn == "text":
                v = args[0]
                return str(v).lower() if type(v) is bool else str(int(v)) if type(v) is float and v.is_integer() else str(v)
            if fn == "concat": return "".join(str(a) for a in args)
            if fn == "lower": return str(args[0]).lower()
            if fn == "upper": return str(args[0]).upper()
            if fn == "length": return len(str(args[0]).encode("utf-16-le")) // 2
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
        try:
            return self._exec_event_cases(interaction, native_event, row, reason, row_index=row_index)
        finally:
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
        elif kind == "set-variable":
            val = self.eval_expr(act["runtime"], row=row) if "runtime" in act else act.get("value")
            self.variables[act["variable"]] = val
        elif kind == "set-panel-state":
            if target in self.panels and act.get("state") in self.panels[target]["states"]:
                prev = self.panels[target]["current"]
                self.panels[target]["current"] = act["state"]
                if prev != act["state"]:
                    self.trigger(target, "OnPanelStateChange", row=row, row_index=row_index or 0)
        elif kind == "raise-event":
            ev_name = "OnPanelStateChange" if act.get("eventType") == 278 else "OnClick"
            self.trigger(target, ev_name, row=row, row_index=row_index or 0)
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
        elif kind == "link":
            dest_slug = self.pages_by_name.get(act.get("page"), act.get("page"))
            if dest_slug in self.pages_by_slug:
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

    def set_input(self, target_id_or_name, text):
        tname = self.resolve_trigger_name(target_id_or_name)
        if tname not in self.widgets or self.widgets[tname]["kind"] != "input":
            fail("E_TARGET_TYPE", "/", "Input step requires a native input")
        if not self.is_operable(tname):
            return []
        self.widgets[tname]["text"] = str(text)
        return self.trigger(tname, "change")

    def trigger(self, target_id_or_name, event="click", row_index=0, row=None):
        native_ev = EVENTS.get(event, event)
        tname = self.resolve_trigger_name(target_id_or_name)
        if native_ev not in EVENTS.values() and native_ev != "OnItemLoad":
            fail("E_EVENT", "/", f"Unsupported reference event '{event}'")
        page = self.pages_by_slug[self.current_page]
        if tname != "page" and native_ev not in {"OnLoad", "OnItemLoad", "OnPanelStateChange"} and not self.is_operable(tname, row_index):
            return []
        if row is None and tname in self.widgets and self.widgets[tname].get("repeater"):
            vrows = self.visible_rows(self.widgets[tname]["repeater"])
            if 0 <= row_index < len(vrows):
                row = vrows[row_index]
            else:
                return []
        fired = []
        for ix in page["interactions"]:
            if ix["trigger"] == tname:
                fired.extend(self._exec_events(ix, native_ev, row=row, reason="input-change" if native_ev == "OnTextChange" else "panel-state-change" if native_ev == "OnPanelStateChange" else "user-event", row_index=row_index))
        return fired

    def execution_state(self):
        """All mutable semantics that can affect the next transition, across pages."""
        return {"page": self.current_page, "variables": copy.deepcopy(self.variables),
                "widgets": copy.deepcopy(self.widgets), "panels": copy.deepcopy(self.panels),
                "rowWidgets": {f"{k[0]}:{k[1]}:{k[2]}": copy.deepcopy(v) for k, v in self.row_widgets.items()},
                "repeaters": {name: {k:copy.deepcopy(v) for k,v in rep.items() if k != "template"} for name,rep in self.repeaters.items()},
                "focusedWidget": self.focused_widget}

    def snapshot(self):
        snap = {
            "page": self.current_page,
            "variables": copy.deepcopy(self.variables),
            "panels": {k: v["current"] for k, v in self.panels.items() if v["page"] == self.current_page},
            "widgets": {k: {"text": v["text"], "visible": v["visible"], "enabled": v["enabled"]}
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
    def semantic_nodes(lowered):
        nodes = {}
        def index(node):
            if node.get("name"):
                nodes[node["name"]] = {k:v for k,v in node.items() if k not in {"children", "states", "template"}}
            for child in node.get("children", []): index(child)
            for state in node.get("states", []): index(state["root"])
            if isinstance(node.get("template"), dict): index(node["template"])
        for page in lowered["pages"]: index(page["root"])
        return nodes
    def behaviors(ir):
        return {ix["trigger"]: ix["events"] for page in ir["pages"] for ix in page["interactions"]}
    before_nodes, after_nodes = semantic_nodes(before_lowered), semantic_nodes(after_lowered)
    before_behavior, after_behavior = behaviors(before_ir), behaviors(after_ir)
    shared = set(before_syms) & set(after_syms)
    identity_changed = sorted(k for k in shared if any(before_syms[k].get(p) != after_syms[k].get(p) for p in ("kind", "name")))
    property_changed = sorted(k for k in shared if before_nodes.get(before_syms[k]["name"]) != after_nodes.get(after_syms[k]["name"]))
    behavior_changed = sorted(k for k in shared if before_behavior.get(before_syms[k]["name"]) != after_behavior.get(after_syms[k]["name"]))
    source_changed = sorted(k for k in shared if any(before_syms[k].get(p) != after_syms[k].get(p) for p in ("pointer", "source", "productOrigin")))
    changed = sorted(set(identity_changed + property_changed + behavior_changed + source_changed))
    before_pages = {p["slug"]: p for p in before_ir["pages"]}
    after_pages = {p["slug"]: p for p in after_ir["pages"]}
    affected_pages = sorted(k for k in set(before_pages) | set(after_pages) if before_pages.get(k) != after_pages.get(k))
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


def auto_heal_spec(spec, max_rounds=5):
    """Automatically heal static/layout/type diagnostics using pre-verified candidatePatches."""
    cur_spec = copy.deepcopy(spec)
    applied = []
    for round_idx in range(1, max_rounds + 1):
        try:
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
        except LanguageError as err:
            diag = err.diagnostic
            cands = diag.get("candidatePatches") or []
            if not cands:
                raise
            healed_this_round = False
            for cand in cands:
                trial = copy.deepcopy(cur_spec)
                try:
                    for op_spec in cand.get("operations", []):
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
