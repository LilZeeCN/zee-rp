#!/usr/bin/env python3
"""
RP/1 Zero-Noise Compact Textual DSL (rp_dsl.py)
Provides 1:1 lossless bidirectional conversion between `.rp1` textual DSL and
RP/1 JSON AST (`spec_to_dsl`, `dsl_to_spec`, `format_dsl`) with line/column
sourceSpan tracking and >50% structural token reduction.
"""
import json
import re
from rp_language import LanguageError, SHORTHAND_NODE_KINDS, EVENT_SHORTHANDS

SIMPLE_STR_RE = re.compile(r"^[A-Za-z0-9_.$@/#-]+$")
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")


def _fmt_scalar(val):
    if val is True:
        return "true"
    if val is False:
        return "false"
    if val is None:
        return "null"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, str):
        if val and SIMPLE_STR_RE.match(val) and val not in ("true", "false", "null") and not re.fullmatch(r"-?\d+(\.\d+)?", val):
            return val
        return json.dumps(val, ensure_ascii=False)
    return json.dumps(val, ensure_ascii=False, separators=(",", ":"))


def _fmt_inline(val):
    if isinstance(val, (str, int, float, bool)) or val is None:
        return _fmt_scalar(val)
    return json.dumps(val, ensure_ascii=False, separators=(",", ":"))


def _fmt_kv_pairs(d, skip=()):
    parts = []
    for k, v in d.items():
        if k in skip:
            continue
        parts.append(f"{k}={_fmt_inline(v)}")
    return " ".join(parts)


def _node_kind_and_id(node):
    if "type" in node:
        return node["type"], node.get("id"), "type"
    for k in SHORTHAND_NODE_KINDS:
        if k == "when" and "then" not in node and "else" not in node:
            continue
        if k in node and isinstance(node[k], str):
            return k, node[k], "shorthand"
    return "box", node.get("id", "node"), "type"


def _emit_node(node, indent, lines):
    pad = "  " * indent
    kind, nid, form = _node_kind_and_id(node)
    skip = {kind if form == "shorthand" else "type", "id"}
    head = f"{pad}{kind}" if form == "type" else f"{pad}@{kind}"
    if nid is not None:
        head += f" #{_fmt_scalar(nid)}"

    # Compact [WxH] geometry if w and h are scalars
    if "w" in node and "h" in node and "size" not in node and not isinstance(node["w"], dict) and not isinstance(node["h"], dict):
        head += f" [{_fmt_scalar(node['w'])}x{_fmt_scalar(node['h'])}]"
        skip.update({"w", "h"})

    # Primary text/value positional string if present
    if "text" in node and isinstance(node["text"], str):
        head += f" {json.dumps(node['text'], ensure_ascii=False)}"
        skip.add("text")

    block_keys = {
        "children", "states", "template", "then", "else",
        "slots", "master", "detail",
        "filters", "steps", "on", *EVENT_SHORTHANDS.keys(),
    }
    for arr_k in ("columns", "fields", *(() if kind == "stat-row" else ("items",))):
        if isinstance(node.get(arr_k), list):
            block_keys.add(arr_k)
    if kind == "use":
        block_keys = set()

    inline_kvs = _fmt_kv_pairs(node, skip=skip | block_keys)
    if inline_kvs:
        head += f" {inline_kvs}"
    lines.append(head)

    c_pad = "  " * (indent + 1)
    # Emit events
    for ev_sh in EVENT_SHORTHANDS:
        if ev_sh in node:
            lines.append(f"{c_pad}+{ev_sh} {_fmt_inline(node[ev_sh])}")
    if "on" in node and isinstance(node["on"], dict):
        for ev_k, ev_v in node["on"].items():
            lines.append(f"{c_pad}+on.{ev_k} {_fmt_inline(ev_v)}")

    # Emit macro array items compactly
    for arr_k, tag in (("columns", "col"), ("fields", "field"), *(() if kind == "stat-row" else (("items", "item"),))):
        if arr_k in node and isinstance(node[arr_k], list):
            for entry in node[arr_k]:
                if isinstance(entry, dict) and "cell" not in entry:
                    lines.append(f"{c_pad}:{tag} {_fmt_kv_pairs(entry)}")
                else:
                    lines.append(f"{c_pad}:{tag} {_fmt_inline(entry)}")

    if "filters" in node:
        if isinstance(node["filters"], list):
            lines.append(f"{c_pad}:filters {_fmt_inline(node['filters'])}")
        else:
            lines.append(f"{c_pad}:filters {_fmt_scalar(node['filters'])}")

    if "steps" in node and isinstance(node["steps"], list):
        for st in node["steps"]:
            if isinstance(st, dict):
                b_key = "body" if "body" in st else ("root" if "root" in st else None)
                st_kvs = _fmt_kv_pairs(st, skip={b_key} if b_key else set())
                lines.append(f"{c_pad}:step({b_key or 'none'}) {st_kvs}".rstrip())
                if b_key and isinstance(st[b_key], dict):
                    _emit_node(st[b_key], indent + 2, lines)

    for sub_k in ("template", "then", "else", "master", "detail"):
        if sub_k in node and isinstance(node[sub_k], dict):
            lines.append(f"{c_pad}:{sub_k}")
            _emit_node(node[sub_k], indent + 2, lines)

    if "slots" in node and isinstance(node["slots"], dict):
        for sk, sv in node["slots"].items():
            if isinstance(sv, dict):
                lines.append(f"{c_pad}:slot {sk}")
                _emit_node(sv, indent + 2, lines)

    if "states" in node and isinstance(node["states"], list):
        for st in node["states"]:
            if isinstance(st, dict) and ("id" in st or "state" in st):
                st_id = st.get("id") or st.get("state")
                st_meta = dict(st)
                st_root = st.get("root")
                unwrap_root = (
                    isinstance(st_root, dict)
                    and st_root.get("type") == "box"
                    and st_root.get("id") == f"{nid or 'panel'}_{st_id}_root"
                    and isinstance(st_root.get("children"), list)
                )
                if unwrap_root:
                    for bk, def_v in (
                        ("layout", "column"), ("w", "fill"), ("h", "hug"),
                        ("gap", 12), ("padding", 0), ("align", None),
                        ("justify", None), ("fill", None), ("stroke", None), ("radius", None),
                    ):
                        if bk in st_root and st_root[bk] != def_v and bk not in st_meta:
                            st_meta[bk] = st_root[bk]
                st_hdr_kvs = _fmt_kv_pairs(st_meta, skip={"id", "state", "root", "children", "body", "tree", "_auto_state_root"})
                lines.append(f"{c_pad}:state {_fmt_scalar(st_id)} {st_hdr_kvs}".rstrip())
                if isinstance(st_root, dict):
                    if unwrap_root:
                        for sch in st_root["children"]:
                            if isinstance(sch, dict):
                                _emit_node(sch, indent + 2, lines)
                    else:
                        _emit_node(st_root, indent + 2, lines)
                elif isinstance(st.get("children"), list):
                    for sch in st["children"]:
                        if isinstance(sch, dict):
                            _emit_node(sch, indent + 2, lines)

    if "children" in node and isinstance(node["children"], list):
        for ch in node["children"]:
            if isinstance(ch, dict):
                _emit_node(ch, indent + 1, lines)


def spec_to_dsl(spec):
    """Serialize an RP/1 specification dict into the zero-noise `.rp1` textual DSL."""
    if not isinstance(spec, dict) or spec.get("language") != "rp/1":
        raise LanguageError("E_LANGUAGE", "/language", "Expected language 'rp/1'")
    lines = []
    header_skip = {"language", "palette", "models", "datasets", "variables", "components", "product", "tabBar", "pages"}
    hdr_kvs = _fmt_kv_pairs(spec, skip=header_skip)
    lines.append(f"rp/1 {hdr_kvs}".rstrip())

    if "palette" in spec and isinstance(spec["palette"], dict) and spec["palette"]:
        lines.append("palette:")
        for pk, pv in spec["palette"].items():
            clean_pk = str(pk).lstrip("$")
            lines.append(f"  ${clean_pk} = {_fmt_inline(pv)}")

    if "models" in spec and isinstance(spec["models"], dict):
        for mname, mfields in spec["models"].items():
            lines.append(f"model {mname} {_fmt_kv_pairs(mfields)}".rstrip())

    if "datasets" in spec and isinstance(spec["datasets"], dict):
        for dname, dval in spec["datasets"].items():
            if isinstance(dval, list):
                lines.append(f"dataset {dname} [inferred]")
                for row in dval:
                    lines.append(f"  - {_fmt_kv_pairs(row)}")
            elif isinstance(dval, dict):
                m_part = f" model={_fmt_scalar(dval['model'])}" if "model" in dval else ""
                lines.append(f"dataset {dname}{m_part}")
                for row in dval.get("rows", []):
                    lines.append(f"  - {_fmt_kv_pairs(row)}")

    if "variables" in spec and isinstance(spec["variables"], dict):
        for vname, vval in spec["variables"].items():
            if isinstance(vval, dict):
                lines.append(f"var ${vname} {_fmt_kv_pairs(vval)}")
            else:
                lines.append(f"var ${vname} = {_fmt_inline(vval)}")

    if "components" in spec and isinstance(spec["components"], dict):
        for cname, cdef in spec["components"].items():
            p_str = _fmt_kv_pairs(cdef.get("params", {})) if "params" in cdef else ""
            lines.append(f"component {cname} ({p_str})")
            if isinstance(cdef.get("root"), dict):
                _emit_node(cdef["root"], 1, lines)

    if "product" in spec and isinstance(spec["product"], dict):
        prod = spec["product"]
        p_hdr = _fmt_kv_pairs(prod, skip={"entities", "computed", "statecharts", "transactions", "rules", "queries", "operations", "views"})
        lines.append(f"product {p_hdr}".rstrip())
        for sec in ("entities", "computed", "statecharts", "transactions", "rules", "queries", "operations"):
            if sec in prod and isinstance(prod[sec], dict):
                for k, v in prod[sec].items():
                    if sec == "entities" and isinstance(v, dict):
                        e_hdr = _fmt_kv_pairs(v, skip={"fields", "rows"})
                        lines.append(f"  entity {k} {e_hdr}".rstrip())
                        if "fields" in v:
                            lines.append(f"    fields {_fmt_kv_pairs(v['fields'])}")
                        for r in v.get("rows", []):
                            lines.append(f"    - {_fmt_kv_pairs(r)}")
                    else:
                        lines.append(f"  {sec[:-1] if sec.endswith('s') and sec != 'queries' else ('query' if sec == 'queries' else sec)} {k} {_fmt_kv_pairs(v) if isinstance(v, dict) else _fmt_inline(v)}")
        if "views" in prod and isinstance(prod["views"], list):
            for vw in prod["views"]:
                lines.append(f"  view {_fmt_kv_pairs(vw)}")

    if "tabBar" in spec and spec["tabBar"] is not None:
        tb_val = spec["tabBar"]
        if isinstance(tb_val, list):
            lines.append("tab-bar:")
            for entry in tb_val:
                if isinstance(entry, dict):
                    lines.append(f"  :item {_fmt_kv_pairs(entry)}")
        elif isinstance(tb_val, dict):
            tb_hdr = _fmt_kv_pairs(tb_val, skip={"items", "tabs", "type"})
            lines.append(f"tab-bar {tb_hdr}".rstrip())
            for entry in (tb_val.get("items") or tb_val.get("tabs") or []):
                if isinstance(entry, dict):
                    lines.append(f"  :item {_fmt_kv_pairs(entry)}")

    if "pages" in spec and isinstance(spec["pages"], list):
        for page in spec["pages"]:
            pid = page.get("id", "main")
            p_skip = {"id", "root", "bindings", "on", "onLoad"}
            c_str = ""
            if "canvas" in page:
                cv = page["canvas"]
                if isinstance(cv, dict) and "w" in cv and "h" in cv:
                    c_str = f" [{_fmt_scalar(cv['w'])}x{_fmt_scalar(cv['h'])}]"
                    p_skip.add("canvas")
                elif isinstance(cv, list) and len(cv) == 2:
                    c_str = f" [{_fmt_scalar(cv[0])}x{_fmt_scalar(cv[1])}a]"
                    p_skip.add("canvas")
            p_kvs = _fmt_kv_pairs(page, skip=p_skip)
            lines.append(f"page #{pid}{c_str} {p_kvs}".rstrip())
            if "onLoad" in page:
                lines.append(f"  +onLoad {_fmt_inline(page['onLoad'])}")
            if "on" in page and isinstance(page["on"], dict):
                for ek, ev in page["on"].items():
                    lines.append(f"  +on.{ek} {_fmt_inline(ev)}")
            if "bindings" in page and isinstance(page["bindings"], list):
                for b in page["bindings"]:
                    lines.append(f"  :bind {_fmt_kv_pairs(b)}")
            if isinstance(page.get("root"), dict):
                _emit_node(page["root"], 1, lines)

    return "\n".join(lines) + "\n"


def _set_diag_span(err, line_no, col_no):
    err.diagnostic.update(line=line_no, column=col_no, sourceSpan={"line": line_no, "column": col_no})
    return err


def _parse_value(raw, line_no=1):
    raw = raw.strip()
    if not raw:
        return ""
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw == "null":
        return None
    if raw[0] in ('"', "{", "["):
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/", f"Invalid literal at line {line_no}: {e.msg}"), line_no, e.colno)
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+\.\d+", raw):
        return float(raw)
    return raw


def _scan_token(s, pos, line_no=1):
    n = len(s)
    while pos < n and (s[pos].isspace() or s[pos] == ","):
        pos += 1
    if pos >= n:
        return None, pos
    start = pos
    if s[pos] == '"':
        pos += 1
        while pos < n:
            if s[pos] == "\\":
                pos += 2
                continue
            if s[pos] == '"':
                pos += 1
                return s[start:pos], pos
            pos += 1
        raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/", f"Unterminated string at line {line_no}"), line_no, start + 1)
    if s[pos] in ("{", "[", "("):
        depth = 0
        in_str = False
        while pos < n:
            ch = s[pos]
            if in_str:
                if ch == "\\":
                    pos += 2
                    continue
                if ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch in ("{", "[", "("):
                    depth += 1
                elif ch in ("}", "]", ")"):
                    depth -= 1
                    if depth == 0:
                        pos += 1
                        return s[start:pos], pos
            pos += 1
        raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/", f"Unterminated bracket at line {line_no}"), line_no, start + 1)
    while pos < n and not s[pos].isspace() and s[pos] != ",":
        if s[pos] in ('"', "{", "[", "("):
            _, pos = _scan_token(s, pos, line_no)
        else:
            pos += 1
    return s[start:pos], pos


def _parse_kv_tail(s, pos=0, line_no=1):
    out = {}
    n = len(s)
    while pos < n:
        while pos < n and (s[pos].isspace() or s[pos] == ","):
            pos += 1
        if pos >= n:
            break
        tok, next_pos = _scan_token(s, pos, line_no)
        if tok is None:
            break
        pos = next_pos
        if tok == ",":
            continue
        if "=" not in tok or tok.startswith(('"', "{", "[")):
            raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/", f"Expected key=value token, got '{tok}' at line {line_no}"), line_no, pos)
        k, v_raw = tok.split("=", 1)
        k = k.lstrip(",").strip()
        if v_raw.endswith(","):
            v_raw = v_raw[:-1].rstrip()
        out[k] = _parse_value(v_raw, line_no)
    return out


def _parse_item_line(tail, line_no):
    s = tail.strip()
    if s.startswith("{") and s.endswith("}"):
        return _parse_value(s, line_no)
    out = {}
    pos = 0
    while pos < len(s):
        tok, next_pos = _scan_token(s, pos, line_no)
        if tok is None:
            break
        pos = next_pos
        if tok == ",":
            continue
        if "=" in tok and not tok.startswith(('"', "{", "[")):
            k, v_raw = tok.split("=", 1)
            k = k.lstrip(",").strip()
            if v_raw.endswith(","):
                v_raw = v_raw[:-1].rstrip()
            out[k] = _parse_value(v_raw, line_no)
        elif tok.startswith("#") and "id" not in out:
            out["id"] = _parse_value(tok[1:], line_no)
        elif tok.startswith('"'):
            val = _parse_value(tok, line_no)
            if "label" not in out:
                out["label"] = val
            elif "value" not in out:
                out["value"] = val
        else:
            val = _parse_value(tok, line_no)
            if "id" not in out:
                out["id"] = str(val)
            elif "label" not in out:
                out["label"] = str(val)
    return out


def _parse_node_block(raw_lines, idx, base_indent, ptr_prefix, span_map):
    line_no, indent, content = raw_lines[idx]
    span_map[ptr_prefix] = {"line": line_no, "column": indent + 1}
    tok, pos = _scan_token(content, 0, line_no)
    is_shorthand = tok.startswith("@")
    kind = tok[1:] if is_shorthand else tok
    node = {}
    nid = None

    # Support #id, [WxH], "text", and key=value tokens in any order on the node header line
    kvs = {}
    while pos < len(content):
        saved = pos
        ntok, pos = _scan_token(content, pos, line_no)
        if ntok is None:
            break
        if ntok.startswith("#") and nid is None and "=" not in ntok:
            nid = _parse_value(ntok[1:], line_no)
        elif ntok.startswith("[") and ntok.endswith("]") and "x" in ntok and "=" not in ntok:
            dims = ntok[1:-1].split("x", 1)
            node["w"] = _parse_value(dims[0], line_no)
            node["h"] = _parse_value(dims[1], line_no)
        elif ntok.startswith('"') and "text" not in node and "text" not in kvs:
            node["text"] = _parse_value(ntok, line_no)
        elif kind == "use" and "(" in ntok and ntok.endswith(")") and not ntok.startswith(('"', "{", "[")):
            if ntok.startswith("("):
                inner = ntok[1:-1].strip()
                if inner:
                    kvs.setdefault("args", {}).update(_parse_kv_tail(inner, 0, line_no))
            else:
                cname, inner = ntok[:-1].split("(", 1)
                kvs["component"] = cname.strip()
                span_map[f"{ptr_prefix}/component"] = {"line": line_no, "column": indent + saved + 1}
                if inner.strip():
                    kvs.setdefault("args", {}).update(_parse_kv_tail(inner.strip(), 0, line_no))
        elif kind == "use" and "=" not in ntok and "component" not in kvs and IDENT_RE.match(ntok):
            kvs["component"] = ntok
            span_map[f"{ptr_prefix}/component"] = {"line": line_no, "column": indent + saved + 1}
        elif kind != "use" and nid is None and "id" not in kvs and "=" not in ntok and not ntok.startswith(('"', "{", "[", "(")) and IDENT_RE.match(ntok):
            nid = ntok
        elif "=" in ntok and not ntok.startswith(('"', "{", "[", "=")):
            k, v_raw = ntok.split("=", 1)
            if k.startswith("+on."):
                ev_name = k[4:]
                node.setdefault("on", {})[ev_name] = _parse_value(v_raw, line_no)
                span_map[f"{ptr_prefix}/on/{ev_name}"] = {"line": line_no, "column": indent + saved + 1}
            elif k.startswith("+"):
                ev_sh = k[1:]
                ev_parsed = _parse_value(v_raw, line_no)
                if ev_sh in ("click", "change", "focus", "blur", "load", "statechange"):
                    node.setdefault("on", {})[ev_sh] = ev_parsed
                    span_map[f"{ptr_prefix}/on/{ev_sh}"] = {"line": line_no, "column": indent + saved + 1}
                else:
                    kvs[ev_sh] = ev_parsed
                    span_map[f"{ptr_prefix}/{ev_sh}"] = {"line": line_no, "column": indent + saved + 1}
            else:
                kvs[k] = _parse_value(v_raw, line_no)
                span_map[f"{ptr_prefix}/{k}"] = {"line": line_no, "column": indent + saved + 1}
        else:
            raise _set_diag_span(LanguageError("E_DSL_SYNTAX", ptr_prefix, f"Expected key=value token, got '{ntok}' at line {line_no}"), line_no, indent + saved + 1)

    if nid is None and "id" not in kvs:
        if kind == "use":
            comp_slug = re.sub(r"[^A-Za-z0-9_]", "_", str(kvs.get("component", "comp")))
            nid = f"use_{comp_slug}_{line_no}"
        else:
            kind_slug = re.sub(r"[^A-Za-z0-9_]", "_", str(kind))
            nid = f"{kind_slug}_{line_no}"

    if is_shorthand:
        node[kind] = nid
    else:
        node["type"] = kind
        if nid is not None:
            node["id"] = nid

    node.update(kvs)

    idx += 1
    n_lines = len(raw_lines)
    while idx < n_lines:
        c_line_no, c_indent, c_content = raw_lines[idx]
        if c_indent <= base_indent:
            break
        if c_content.startswith("+on."):
            rest = c_content[4:].strip()
            if "=" in rest and not rest.split("=", 1)[0].strip().startswith(('"', "{", "[")) and " " not in rest.split("=", 1)[0].strip():
                ev_name, ev_raw = rest.split("=", 1)
                ev_name = ev_name.strip()
                ev_val = _parse_value(ev_raw.strip(), c_line_no)
            else:
                ev_name, val_pos = _scan_token(rest, 0, c_line_no)
                ev_val = _parse_value(rest[val_pos:], c_line_no)
            node.setdefault("on", {})[ev_name] = ev_val
            span_map[f"{ptr_prefix}/on/{ev_name}"] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
        elif c_content.startswith("+"):
            rest = c_content[1:].strip()
            if "=" in rest and not rest.split("=", 1)[0].strip().startswith(('"', "{", "[")) and " " not in rest.split("=", 1)[0].strip():
                ev_sh, ev_raw = rest.split("=", 1)
                ev_sh = ev_sh.strip()
                ev_parsed = _parse_value(ev_raw.strip(), c_line_no)
            else:
                ev_sh, val_pos = _scan_token(rest, 0, c_line_no)
                ev_parsed = _parse_value(rest[val_pos:], c_line_no)
            if ev_sh in ("click", "change", "focus", "blur", "load", "statechange"):
                node.setdefault("on", {})[ev_sh] = ev_parsed
                span_map[f"{ptr_prefix}/on/{ev_sh}"] = {"line": c_line_no, "column": c_indent + 1}
            else:
                node[ev_sh] = ev_parsed
                span_map[f"{ptr_prefix}/{ev_sh}"] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
        elif c_content.startswith((":col ", ":field ", ":item ", "item ", "- ")):
            tag, val_pos = _scan_token(c_content, 0, c_line_no)
            tag_clean = "item" if tag in ("item", "-") else tag[1:]
            arr_k = {"col": "columns", "field": "fields", "item": "items"}[tag_clean]
            tail = c_content[val_pos:].strip()
            arr = node.setdefault(arr_k, [])
            item_ptr = f"{ptr_prefix}/{arr_k}/{len(arr)}"
            span_map[item_ptr] = {"line": c_line_no, "column": c_indent + 1}
            arr.append(_parse_item_line(tail, c_line_no) if tag_clean == "item" else (_parse_value(tail, c_line_no) if tail.startswith("{") else _parse_kv_tail(tail, 0, c_line_no)))
            idx += 1
        elif c_content.startswith(":filters "):
            tail = c_content[len(":filters "):].strip()
            node["filters"] = _parse_value(tail, c_line_no)
            span_map[f"{ptr_prefix}/filters"] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
        elif c_content.startswith(":step("):
            end_p = c_content.find(")")
            b_key = c_content[6:end_p]
            st_dict = _parse_kv_tail(c_content[end_p + 1:], 0, c_line_no)
            steps_arr = node.setdefault("steps", [])
            st_ptr = f"{ptr_prefix}/steps/{len(steps_arr)}"
            span_map[st_ptr] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
            if b_key != "none" and idx < n_lines and raw_lines[idx][1] > c_indent:
                b_node, idx = _parse_node_block(raw_lines, idx, c_indent + 1, f"{st_ptr}/{b_key}", span_map)
                st_dict[b_key] = b_node
            steps_arr.append(st_dict)
        elif c_content in (":template", ":then", ":else", ":master", ":detail"):
            sub_k = c_content[1:]
            idx += 1
            sub_node, idx = _parse_node_block(raw_lines, idx, c_indent, f"{ptr_prefix}/{sub_k}", span_map)
            node[sub_k] = sub_node
        elif c_content.startswith(":slot "):
            sk = c_content[len(":slot "):].strip()
            idx += 1
            s_node, idx = _parse_node_block(raw_lines, idx, c_indent, f"{ptr_prefix}/slots/{sk}", span_map)
            node.setdefault("slots", {})[sk] = s_node
        elif c_content.startswith((":state ", "state ")):
            pfx_len = 7 if c_content.startswith(":state ") else 6
            sid_raw = c_content[pfx_len:].strip()
            sid = None
            st_kvs = {}
            s_pos = 0
            while s_pos < len(sid_raw):
                s_tok, s_pos = _scan_token(sid_raw, s_pos, c_line_no)
                if s_tok is None:
                    break
                if s_tok.startswith("#") and sid is None and "=" not in s_tok:
                    sid = _parse_value(s_tok[1:], c_line_no)
                elif s_tok.startswith("[") and s_tok.endswith("]") and "x" in s_tok and "=" not in s_tok:
                    dims = s_tok[1:-1].split("x", 1)
                    st_kvs["w"] = _parse_value(dims[0], c_line_no)
                    st_kvs["h"] = _parse_value(dims[1], c_line_no)
                elif s_tok.startswith(('"', "'")) and "name" not in st_kvs:
                    st_kvs["name"] = _parse_value(s_tok, c_line_no)
                elif "=" in s_tok and not s_tok.startswith(('"', "'", "{", "[")):
                    sk, sv_raw = s_tok.split("=", 1)
                    st_kvs[sk] = _parse_value(sv_raw, c_line_no)
                elif sid is None:
                    sid = _parse_value(s_tok.lstrip("#"), c_line_no)
                else:
                    raise _set_diag_span(LanguageError("E_DSL_SYNTAX", ptr_prefix, f"Unexpected token '{s_tok}' in :state header at line {c_line_no}"), c_line_no, c_indent + 1)
            if sid is None:
                sid = st_kvs.pop("id", st_kvs.pop("state", f"state_{len(node.get('states', [])) + 1}"))
            st_arr = node.setdefault("states", [])
            st_ptr = f"{ptr_prefix}/states/{len(st_arr)}"
            span_map[st_ptr] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
            st_children = []
            while idx < n_lines and raw_lines[idx][1] > c_indent and not raw_lines[idx][2].startswith((":state ", "state ")):
                ch_lno, ch_ind, ch_txt = raw_lines[idx]
                if ch_txt in (":root", "root", ":children", "children"):
                    idx += 1
                    continue
                ch_ptr = f"{st_ptr}/root" if not st_children else f"{st_ptr}/root/children/{len(st_children)}"
                s_child, idx = _parse_node_block(raw_lines, idx, ch_ind, ch_ptr, span_map)
                st_children.append(s_child)
            if not st_children and isinstance(st_kvs.get("root"), dict):
                s_root = st_kvs.pop("root")
            else:
                if not st_children and "children" in st_kvs:
                    inline_ch = st_kvs.pop("children")
                    st_children = inline_ch if isinstance(inline_ch, list) else ([inline_ch] if isinstance(inline_ch, dict) else [])
                has_box_overrides = any(
                    k in st_kvs
                    for k in ("layout", "w", "h", "gap", "padding", "align", "justify", "fill", "bg", "background", "stroke", "borderColor", "strokeWidth", "borderWidth", "radius", "rounded", "borderRadius", "columns", "equalHeight")
                )
                if len(st_children) == 1 and not has_box_overrides:
                    s_root = st_children[0]
                else:
                    s_root = {
                        "type": "box",
                        "id": f"{nid or 'panel'}_{sid}_root",
                        "layout": st_kvs.pop("layout", "column"),
                        "w": st_kvs.pop("w", "fill"),
                        "h": st_kvs.pop("h", "hug"),
                        "gap": st_kvs.pop("gap", 12),
                        "padding": st_kvs.pop("padding", 0),
                        "children": st_children,
                    }
                    for bk in ("align", "justify", "fill", "bg", "background", "stroke", "borderColor", "strokeWidth", "borderWidth", "radius", "rounded", "borderRadius", "columns", "equalHeight"):
                        if bk in st_kvs:
                            s_root[bk] = st_kvs.pop(bk)
            st_arr.append({"id": sid, **st_kvs, "root": s_root})
        else:
            ch_arr = node.setdefault("children", [])
            ch_ptr = f"{ptr_prefix}/children/{len(ch_arr)}"
            ch_node, idx = _parse_node_block(raw_lines, idx, c_indent, ch_ptr, span_map)
            ch_arr.append(ch_node)

    if kind == "repeater" and "template" not in node and node.get("children"):
        node["template"] = node.pop("children")[0]
    if kind == "icon" and "icon" not in node and "text" in node:
        node["icon"] = node.pop("text")

    return node, idx


def dsl_to_spec(dsl_text, return_spans=False):
    """Parse `.rp1` textual DSL into canonical RP/1 JSON AST."""
    if not isinstance(dsl_text, str):
        raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/", "DSL input must be a string"), 1, 1)
    raw_lines = []
    for lno, raw in enumerate(dsl_text.splitlines(), 1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("#"):
            continue
        if len(stripped) > 1 and stripped.endswith(":"):
            stripped = stripped[:-1].rstrip()
        indent = len(raw) - len(raw.lstrip(" "))
        raw_lines.append((lno, indent, stripped))

    if not raw_lines:
        raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/", "Empty .rp1 document"), 1, 1)

    span_map = {"/": {"line": raw_lines[0][0], "column": 1}}
    lno0, _, first = raw_lines[0]
    if not first.startswith("rp/1"):
        raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/language", "First statement in .rp1 must start with 'rp/1'"), lno0, 1)

    spec = {"language": "rp/1"}
    hdr_pos = 4
    if hdr_pos < len(first) and first[hdr_pos:].lstrip().startswith(('"', "'")):
        h_tok, hdr_pos = _scan_token(first, hdr_pos, lno0)
        spec["name"] = _parse_value(h_tok, lno0)
    spec.update(_parse_kv_tail(first, hdr_pos, lno0))
    if "title" in spec:
        if "name" not in spec:
            spec["name"] = spec.pop("title")
        else:
            spec.pop("title", None)
    idx = 1
    n = len(raw_lines)

    while idx < n:
        lno, indent, content = raw_lines[idx]
        tok, pos = _scan_token(content, 0, lno)
        if tok in ("palette", "tokens"):
            pal_obj = spec.setdefault("palette", {})
            if pos < len(content):
                for pk, pv in _parse_kv_tail(content, pos, lno).items():
                    pal_obj[pk.lstrip("$")] = pv
            span_map["/palette"] = {"line": lno, "column": indent + 1}
            idx += 1
            while idx < n and raw_lines[idx][1] > indent:
                p_lno, p_ind, p_cnt = raw_lines[idx]
                if "=" in p_cnt and (" = " in p_cnt or (p_cnt.startswith("$") and " " not in p_cnt.strip())):
                    pk, pv = p_cnt.split("=", 1)
                    pk = pk.strip().lstrip("$")
                    pal_obj[pk] = _parse_value(pv.strip(), p_lno)
                    span_map[f"/palette/{pk}"] = {"line": p_lno, "column": p_ind + 1}
                else:
                    for pk, pv in _parse_kv_tail(p_cnt, 0, p_lno).items():
                        clean_pk = pk.lstrip("$")
                        pal_obj[clean_pk] = pv
                        span_map[f"/palette/{clean_pk}"] = {"line": p_lno, "column": p_ind + 1}
                idx += 1
        elif tok == "model":
            mname, pos = _scan_token(content, pos, lno)
            mfields = _parse_kv_tail(content, pos, lno)
            spec.setdefault("models", {})[mname] = mfields
            span_map[f"/models/{mname}"] = {"line": lno, "column": indent + 1}
            for fk in mfields:
                span_map[f"/models/{mname}/{fk}"] = {"line": lno, "column": indent + 1}
            idx += 1
        elif tok == "dataset":
            dname, pos = _scan_token(content, pos, lno)
            rest = content[pos:].strip()
            inferred = rest == "[inferred]"
            d_hdr = {} if inferred else _parse_kv_tail(content, pos, lno)
            rows = []
            span_map[f"/datasets/{dname}"] = {"line": lno, "column": indent + 1}
            idx += 1
            while idx < n and raw_lines[idx][1] > indent and raw_lines[idx][2].startswith("- "):
                r_lno, r_ind, r_cnt = raw_lines[idx]
                r_ptr = f"/datasets/{dname}/rows/{len(rows)}" if not inferred else f"/datasets/{dname}/{len(rows)}"
                span_map[r_ptr] = {"line": r_lno, "column": r_ind + 1}
                row_obj = _parse_kv_tail(r_cnt, 2, r_lno)
                for rk in row_obj:
                    span_map[f"{r_ptr}/{rk}"] = {"line": r_lno, "column": r_ind + 1}
                rows.append(row_obj)
                idx += 1
            if inferred:
                spec.setdefault("datasets", {})[dname] = rows
            else:
                spec.setdefault("datasets", {})[dname] = {**d_hdr, "rows": rows}
        elif tok == "var":
            vtok, pos = _scan_token(content, pos, lno)
            vname = (vtok[1:] if vtok.startswith("$") else vtok).rstrip(":")
            rest = content[pos:].strip()
            if rest.startswith(":"):
                rest = rest[1:].strip()
            span_map[f"/variables/{vname}"] = {"line": lno, "column": indent + 1}
            if rest.startswith("="):
                spec.setdefault("variables", {})[vname] = _parse_value(rest[1:].strip(), lno)
            elif "=" in rest and rest.split("=", 1)[0].strip() in ("number", "text", "string", "boolean", "bool"):
                raw_t, raw_v = rest.split("=", 1)
                norm_t = {"string": "text", "bool": "boolean"}.get(raw_t.strip(), raw_t.strip())
                spec.setdefault("variables", {})[vname] = {"type": norm_t, "value": _parse_value(raw_v.strip(), lno)}
            else:
                spec.setdefault("variables", {})[vname] = _parse_kv_tail(content, pos, lno)
            idx += 1
        elif tok == "computed":
            vtok, pos = _scan_token(content, pos, lno)
            vname = vtok[1:] if vtok.startswith("$") else vtok
            rest = content[pos:].strip()
            span_map[f"/computed/{vname}"] = {"line": lno, "column": indent + 1}
            if rest.startswith("="):
                rhs = rest[1:].strip()
                if (rhs.startswith("sum(") or rhs.startswith("count(")) and rhs.endswith(")"):
                    fn_nm = "sum" if rhs.startswith("sum(") else "count"
                    i_args = [a.strip() for a in rhs[len(fn_nm) + 1 : -1].split(",") if a.strip()]
                    c_obj = {"op": fn_nm, "dataset": i_args[0]}
                    if fn_nm == "sum" and len(i_args) > 1:
                        fa = i_args[1]
                        c_obj["field"] = fa[5:] if fa.startswith("item.") and fa[5:].isidentifier() else (fa if fa.startswith("=") else f"={fa}")
                    spec.setdefault("computed", {})[vname] = {"type": "number", "compute": c_obj}
                else:
                    spec.setdefault("computed", {})[vname] = _parse_value(rhs, lno)
            else:
                spec.setdefault("computed", {})[vname] = _parse_kv_tail(content, pos, lno)
            idx += 1
        elif tok == "component":
            cname, pos = _scan_token(content, pos, lno)
            rest = content[pos:].strip()
            cdef = {}
            if rest.startswith("(") and rest.endswith(")"):
                inner = rest[1:-1].strip()
                if inner:
                    cdef["params"] = _parse_kv_tail(inner, 0, lno)
            span_map[f"/components/{cname}"] = {"line": lno, "column": indent + 1}
            idx += 1
            if idx < n and raw_lines[idx][1] > indent:
                croot, idx = _parse_node_block(raw_lines, idx, raw_lines[idx][1], f"/components/{cname}/root", span_map)
                cdef["root"] = croot
            spec.setdefault("components", {})[cname] = cdef
        elif tok == "product":
            prod = _parse_kv_tail(content, pos, lno)
            span_map["/product"] = {"line": lno, "column": indent + 1}
            idx += 1
            while idx < n and raw_lines[idx][1] > indent:
                p_lno, p_ind, p_cnt = raw_lines[idx]
                ptok, ppos = _scan_token(p_cnt, 0, p_lno)
                if ptok == "entity":
                    ename, ppos = _scan_token(p_cnt, ppos, p_lno)
                    edef = _parse_kv_tail(p_cnt, ppos, p_lno)
                    edef.setdefault("fields", {})
                    edef.setdefault("rows", [])
                    idx += 1
                    while idx < n and raw_lines[idx][1] > p_ind:
                        e_lno, _, e_cnt = raw_lines[idx]
                        if e_cnt.startswith("fields "):
                            edef["fields"] = _parse_kv_tail(e_cnt, 7, e_lno)
                        elif e_cnt.startswith("- "):
                            edef["rows"].append(_parse_kv_tail(e_cnt, 2, e_lno))
                        idx += 1
                    prod.setdefault("entities", {})[ename] = edef
                elif ptok in ("computed", "statechart", "transaction", "rule", "query", "operation"):
                    sec_map = {
                        "computed": "computed", "statechart": "statecharts",
                        "transaction": "transactions", "rule": "rules",
                        "query": "queries", "operation": "operations",
                    }
                    sname, ppos = _scan_token(p_cnt, ppos, p_lno)
                    prod.setdefault(sec_map[ptok], {})[sname] = _parse_kv_tail(p_cnt, ppos, p_lno)
                    idx += 1
                elif ptok == "view":
                    prod.setdefault("views", []).append(_parse_kv_tail(p_cnt, ppos, p_lno))
                    idx += 1
                else:
                    idx += 1
            spec["product"] = prod
        elif tok in ("tab-bar", "tabBar"):
            tb_obj = {}
            while pos < len(content):
                ntok, pos = _scan_token(content, pos, lno)
                if ntok is None:
                    break
                if ntok.startswith("#") and "id" not in tb_obj and "=" not in ntok:
                    tb_obj["id"] = _parse_value(ntok[1:], lno)
                elif "=" in ntok:
                    k, v_raw = ntok.split("=", 1)
                    tb_obj[k] = _parse_value(v_raw, lno)
            span_map["/tabBar"] = {"line": lno, "column": indent + 1}
            idx += 1
            while idx < n and raw_lines[idx][1] > indent:
                t_lno, t_ind, t_cnt = raw_lines[idx]
                if t_cnt.startswith((":item ", "item ", "- ")):
                    _, t_pos = _scan_token(t_cnt, 0, t_lno)
                    tail = t_cnt[t_pos:].strip()
                    arr = tb_obj.setdefault("items", [])
                    span_map[f"/tabBar/items/{len(arr)}"] = {"line": t_lno, "column": t_ind + 1}
                    arr.append(_parse_item_line(tail, t_lno))
                idx += 1
            spec["tabBar"] = tb_obj
        elif tok == "page":
            ptok, pos = _scan_token(content, pos, lno)
            pid = ptok[1:] if ptok.startswith("#") else ptok
            page_obj = {"id": pid}
            while pos < len(content):
                saved = pos
                ctok, pos = _scan_token(content, pos, lno)
                if ctok is None:
                    break
                if ctok.startswith("[") and ctok.endswith("]") and "x" in ctok and "=" not in ctok:
                    inner = ctok[1:-1]
                    if inner.endswith("a"):
                        dims = inner[:-1].split("x", 1)
                        page_obj["canvas"] = [_parse_value(dims[0], lno), _parse_value(dims[1], lno)]
                    else:
                        dims = inner.split("x", 1)
                        page_obj["canvas"] = {"w": _parse_value(dims[0], lno), "h": _parse_value(dims[1], lno)}
                elif ctok.startswith('"') and "name" not in page_obj:
                    page_obj["name"] = _parse_value(ctok, lno)
                elif "=" in ctok and not ctok.startswith(('"', "{", "[", "=")):
                    k, v_raw = ctok.split("=", 1)
                    page_obj[k] = _parse_value(v_raw, lno)
                else:
                    raise _set_diag_span(LanguageError("E_DSL_SYNTAX", "/", f"Expected key=value token, got '{ctok}' at line {lno}"), lno, indent + saved + 1)
            pages_arr = spec.setdefault("pages", [])
            p_ptr = f"/pages/{len(pages_arr)}"
            span_map[p_ptr] = {"line": lno, "column": indent + 1}
            idx += 1
            while idx < n and raw_lines[idx][1] > indent:
                c_lno, c_ind, c_cnt = raw_lines[idx]
                if c_cnt.startswith("+onLoad ") or c_cnt.startswith("+onLoad="):
                    page_obj["onLoad"] = _parse_value(c_cnt[8:].strip(), c_lno)
                    idx += 1
                elif c_cnt.startswith("+on."):
                    rest = c_cnt[4:].strip()
                    if "=" in rest and not rest.split("=", 1)[0].strip().startswith(('"', "{", "[")) and " " not in rest.split("=", 1)[0].strip():
                        ev_name, ev_raw = rest.split("=", 1)
                        page_obj.setdefault("on", {})[ev_name.strip()] = _parse_value(ev_raw.strip(), c_lno)
                    else:
                        ev_name, vpos = _scan_token(rest, 0, c_lno)
                        page_obj.setdefault("on", {})[ev_name] = _parse_value(rest[vpos:], c_lno)
                    idx += 1
                elif c_cnt.startswith(":bind "):
                    page_obj.setdefault("bindings", []).append(_parse_kv_tail(c_cnt, 6, c_lno))
                    idx += 1
                else:
                    proot, idx = _parse_node_block(raw_lines, idx, c_ind, f"{p_ptr}/root", span_map)
                    if "root" not in page_obj:
                        page_obj["root"] = proot
                    else:
                        prev_root = page_obj["root"]
                        if isinstance(prev_root, dict) and prev_root.get("_auto_page_root"):
                            prev_root["children"].append(proot)
                        else:
                            page_obj["root"] = {
                                "type": "box",
                                "id": f"{pid}_root",
                                "layout": "column",
                                "w": "fill",
                                "h": "fill",
                                "padding": 16,
                                "gap": 12,
                                "children": [prev_root, proot],
                                "_auto_page_root": True,
                            }
            if isinstance(page_obj.get("root"), dict):
                page_obj["root"].pop("_auto_page_root", None)
            pages_arr.append(page_obj)
        else:
            hint_map = {"colors": "palette", "color": "palette", "theme": "palette", "vars": "var", "variables": "var", "pages": "page", "components": "component"}
            suggestion_msg = f" (did you mean '{hint_map[tok]}'?)" if tok in hint_map else ""
            err = _set_diag_span(
                LanguageError("E_DSL_SYNTAX", "/", f"Unexpected top-level statement '{tok}' at line {lno}{suggestion_msg}; expected one of: palette, tokens, model, dataset, var, computed, component, product, page"),
                lno,
                indent + 1,
            )
            if tok in hint_map:
                err.diagnostic["suggestions"] = [hint_map[tok]]
            raise err

    return (spec, span_map) if return_spans else spec


def _dsl_line_anchor(stripped):
    s = stripped[:-1].rstrip() if stripped.endswith(":") and not stripped.startswith(":") else stripped
    parts = s.split()
    if not parts:
        return None
    head = parts[0]
    if head == "rp/1":
        return ("rp/1",)
    if head in ("palette", "tokens"):
        return ("palette",)
    if head == "var" and len(parts) >= 2:
        return ("var", parts[1].lstrip("$"))
    if head == "model" and len(parts) >= 2:
        return ("model", parts[1])
    if head == "dataset" and len(parts) >= 2:
        return ("dataset", parts[1])
    if head == "component" and len(parts) >= 2:
        return ("component", parts[1].split("(", 1)[0])
    if head == "page" and len(parts) >= 2:
        return ("page", parts[1].lstrip("#"))
    for tok in parts[1:]:
        if tok.startswith("#") and "=" not in tok and len(tok) > 1:
            return ("node", tok[1:])
    if head.startswith("$") and "=" in s:
        return ("token", head.lstrip("$"))
    return ("raw", s)


def preserve_rp1_comments(original_dsl_text, new_dsl_text):
    """Re-attach `#` and `//` comment lines from `original_dsl_text` into `new_dsl_text` based on semantic anchors."""
    if not isinstance(original_dsl_text, str) or not isinstance(new_dsl_text, str):
        return new_dsl_text
    anchored = {}
    first_var_comments = []
    seen_first_var = False
    pending = []
    for raw in original_dsl_text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.startswith("//"):
            pending.append(stripped)
            continue
        anchor = _dsl_line_anchor(stripped)
        if anchor and pending:
            if anchor[0] == "var" and not seen_first_var:
                first_var_comments.extend(pending)
            anchored.setdefault(anchor, []).extend(pending)
            pending = []
        if anchor and anchor[0] == "var":
            seen_first_var = True

    if not anchored and not pending:
        return new_dsl_text

    out_lines = []
    used_first_var = False
    for raw in new_dsl_text.splitlines():
        stripped = raw.strip()
        indent = len(raw) - len(raw.lstrip(" "))
        pad = " " * indent
        anchor = _dsl_line_anchor(stripped) if stripped else None
        if anchor:
            comments = anchored.pop(anchor, None)
            if comments is None and anchor[0] == "var" and not used_first_var and first_var_comments:
                comments = first_var_comments
            if anchor[0] == "var":
                used_first_var = True
            if comments:
                for c in comments:
                    out_lines.append(f"{pad}{c}")
        out_lines.append(raw)

    for c in pending:
        out_lines.append(c)

    return "\n".join(out_lines) + "\n"


def format_dsl(dsl_text):
    """Canonical formatter for `.rp1` source files."""
    spec = dsl_to_spec(dsl_text, return_spans=False)
    return preserve_rp1_comments(dsl_text, spec_to_dsl(spec))
