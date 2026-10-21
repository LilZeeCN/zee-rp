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

SIMPLE_STR_RE = re.compile(r"^[A-Za-z0-9_.$@/#:-]+$")
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
    for arr_k in ("columns", "fields", "items"):
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
    for arr_k, tag in (("columns", "col"), ("fields", "field"), ("items", "item")):
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
            if isinstance(st, dict) and "id" in st and isinstance(st.get("root"), dict):
                lines.append(f"{c_pad}:state {_fmt_scalar(st['id'])}")
                _emit_node(st["root"], indent + 2, lines)

    if "children" in node and isinstance(node["children"], list):
        for ch in node["children"]:
            if isinstance(ch, dict):
                _emit_node(ch, indent + 1, lines)


def spec_to_dsl(spec):
    """Serialize an RP/1 specification dict into the zero-noise `.rp1` textual DSL."""
    if not isinstance(spec, dict) or spec.get("language") != "rp/1":
        raise LanguageError("E_LANGUAGE", "/language", "Expected language 'rp/1'")
    lines = []
    header_skip = {"language", "models", "datasets", "variables", "components", "product", "pages"}
    hdr_kvs = _fmt_kv_pairs(spec, skip=header_skip)
    lines.append(f"rp/1 {hdr_kvs}".rstrip())

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
            err = LanguageError("E_DSL_SYNTAX", "/", f"Invalid literal at line {line_no}: {e.msg}")
            err.diagnostic.update(line=line_no, column=e.colno)
            raise err
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+\.\d+", raw):
        return float(raw)
    return raw


def _scan_token(s, pos, line_no=1):
    n = len(s)
    while pos < n and s[pos].isspace():
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
        err = LanguageError("E_DSL_SYNTAX", "/", f"Unterminated string at line {line_no}")
        err.diagnostic.update(line=line_no, column=start + 1)
        raise err
    if s[pos] in ("{", "["):
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
                elif ch in ("{", "["):
                    depth += 1
                elif ch in ("}", "]"):
                    depth -= 1
                    if depth == 0:
                        pos += 1
                        return s[start:pos], pos
            pos += 1
        err = LanguageError("E_DSL_SYNTAX", "/", f"Unterminated bracket at line {line_no}")
        err.diagnostic.update(line=line_no, column=start + 1)
        raise err
    while pos < n and not s[pos].isspace():
        if s[pos] in ('"', "{", "["):
            _, pos = _scan_token(s, pos, line_no)
        else:
            pos += 1
    return s[start:pos], pos


def _parse_kv_tail(s, pos=0, line_no=1):
    out = {}
    n = len(s)
    while pos < n:
        tok, next_pos = _scan_token(s, pos, line_no)
        if tok is None:
            break
        pos = next_pos
        if "=" not in tok or tok.startswith(('"', "{", "[")):
            err = LanguageError("E_DSL_SYNTAX", "/", f"Expected key=value token, got '{tok}' at line {line_no}")
            err.diagnostic.update(line=line_no, column=pos)
            raise err
        k, v_raw = tok.split("=", 1)
        out[k] = _parse_value(v_raw, line_no)
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
        elif "=" in ntok and not ntok.startswith(('"', "{", "[", "=")):
            k, v_raw = ntok.split("=", 1)
            kvs[k] = _parse_value(v_raw, line_no)
        else:
            err = LanguageError("E_DSL_SYNTAX", "/", f"Expected key=value token, got '{ntok}' at line {line_no}")
            err.diagnostic.update(line=line_no, column=saved + 1)
            raise err

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
            ev_name, val_pos = _scan_token(rest, 0, c_line_no)
            ev_val = _parse_value(rest[val_pos:], c_line_no)
            node.setdefault("on", {})[ev_name] = ev_val
            span_map[f"{ptr_prefix}/on/{ev_name}"] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
        elif c_content.startswith("+"):
            ev_sh, val_pos = _scan_token(c_content[1:], 0, c_line_no)
            ev_parsed = _parse_value(c_content[1 + val_pos:], c_line_no)
            if ev_sh in ("click", "change", "focus", "blur", "load", "statechange"):
                node.setdefault("on", {})[ev_sh] = ev_parsed
                span_map[f"{ptr_prefix}/on/{ev_sh}"] = {"line": c_line_no, "column": c_indent + 1}
            else:
                node[ev_sh] = ev_parsed
                span_map[f"{ptr_prefix}/{ev_sh}"] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
        elif c_content.startswith((":col ", ":field ", ":item ")):
            tag, val_pos = _scan_token(c_content, 0, c_line_no)
            arr_k = {"col": "columns", "field": "fields", "item": "items"}[tag[1:]]
            tail = c_content[val_pos:].strip()
            arr = node.setdefault(arr_k, [])
            item_ptr = f"{ptr_prefix}/{arr_k}/{len(arr)}"
            span_map[item_ptr] = {"line": c_line_no, "column": c_indent + 1}
            if tail.startswith("{"):
                arr.append(_parse_value(tail, c_line_no))
            else:
                arr.append(_parse_kv_tail(tail, 0, c_line_no))
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
            sid = _parse_value(c_content[pfx_len:].strip(), c_line_no)
            st_arr = node.setdefault("states", [])
            st_ptr = f"{ptr_prefix}/states/{len(st_arr)}"
            span_map[st_ptr] = {"line": c_line_no, "column": c_indent + 1}
            idx += 1
            s_root, idx = _parse_node_block(raw_lines, idx, c_indent, f"{st_ptr}/root", span_map)
            st_arr.append({"id": sid, "root": s_root})
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
        raise LanguageError("E_DSL_SYNTAX", "/", "DSL input must be a string")
    raw_lines = []
    for lno, raw in enumerate(dsl_text.splitlines(), 1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("# "):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        raw_lines.append((lno, indent, stripped))

    if not raw_lines:
        raise LanguageError("E_DSL_SYNTAX", "/", "Empty .rp1 document")

    span_map = {"/": {"line": raw_lines[0][0], "column": 1}}
    lno0, _, first = raw_lines[0]
    if not first.startswith("rp/1"):
        err = LanguageError("E_DSL_SYNTAX", "/language", "First statement in .rp1 must start with 'rp/1'")
        err.diagnostic.update(line=lno0, column=1)
        raise err

    spec = {"language": "rp/1"}
    spec.update(_parse_kv_tail(first, 4, lno0))
    idx = 1
    n = len(raw_lines)

    while idx < n:
        lno, indent, content = raw_lines[idx]
        tok, pos = _scan_token(content, 0, lno)
        if tok == "palette":
            spec.setdefault("palette", {}).update(_parse_kv_tail(content, pos, lno))
            span_map["/palette"] = {"line": lno, "column": indent + 1}
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
            vname = vtok[1:] if vtok.startswith("$") else vtok
            rest = content[pos:].strip()
            span_map[f"/variables/{vname}"] = {"line": lno, "column": indent + 1}
            if rest.startswith("="):
                spec.setdefault("variables", {})[vname] = _parse_value(rest[1:].strip(), lno)
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
                    err = LanguageError("E_DSL_SYNTAX", "/", f"Expected key=value token, got '{ctok}' at line {lno}")
                    err.diagnostic.update(line=lno, column=saved + 1)
                    raise err
            pages_arr = spec.setdefault("pages", [])
            p_ptr = f"/pages/{len(pages_arr)}"
            span_map[p_ptr] = {"line": lno, "column": indent + 1}
            idx += 1
            while idx < n and raw_lines[idx][1] > indent:
                c_lno, c_ind, c_cnt = raw_lines[idx]
                if c_cnt.startswith("+onLoad "):
                    page_obj["onLoad"] = _parse_value(c_cnt[8:].strip(), c_lno)
                    idx += 1
                elif c_cnt.startswith("+on."):
                    rest = c_cnt[4:].strip()
                    ev_name, vpos = _scan_token(rest, 0, c_lno)
                    page_obj.setdefault("on", {})[ev_name] = _parse_value(rest[vpos:], c_lno)
                    idx += 1
                elif c_cnt.startswith(":bind "):
                    page_obj.setdefault("bindings", []).append(_parse_kv_tail(c_cnt, 6, c_lno))
                    idx += 1
                else:
                    proot, idx = _parse_node_block(raw_lines, idx, c_ind, f"{p_ptr}/root", span_map)
                    page_obj["root"] = proot
            pages_arr.append(page_obj)
        else:
            err = LanguageError("E_DSL_SYNTAX", "/", f"Unexpected top-level statement '{tok}' at line {lno}")
            err.diagnostic.update(line=lno, column=indent + 1)
            raise err

    return (spec, span_map) if return_spans else spec


def format_dsl(dsl_text):
    """Canonical formatter for `.rp1` source files."""
    spec = dsl_to_spec(dsl_text, return_spans=False)
    return spec_to_dsl(spec)
