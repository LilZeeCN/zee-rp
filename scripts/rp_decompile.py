"""Binary .rp to RP/1 (.json / .rp1) Decompiler and 3-Way Binary GUI/MCP Synchronization Engine."""
import base64
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from rp_dsl import spec_to_dsl, preserve_rp1_comments

SCRIPT_DIR = Path(__file__).resolve().parent
RP_READ_MJS = SCRIPT_DIR / "rp-read.mjs"

INTERNAL_VAR_RE = re.compile(r"^(OnLoadVariable|rp1_agg_.+|rp1_caller_\d+|rp1_bop_.+|__rp_.+|.+_filter_idx)$", re.IGNORECASE)
HASH_SUFFIX_RE = re.compile(r"^(?:txt|btn|badge|inp|grp|card|panel|rep|div|line|img)-(.+)-[0-9a-f]{12}$")

SUPPORTED_EVENT_MAP = {
    "OnClick": "click",
    "OnTextChange": "change",
    "OnLoad": "load",
    "OnPageLoad": "load",
    "OnFocus": "focus",
    "OnLostFocus": "blur",
    "OnMouseEnter": "mouseover",
    "OnMouseOver": "mouseover",
    "OnMouseOut": "mouseout",
    "OnPanelStateChange": "statechange",
}

SUPPORTED_NATIVE_WIDGET_TYPES = {
    "VectorShape",
    "Shape",
    "TextBox",
    "ImageBox",
    "DynamicPanel",
    "Repeater",
    "HorizontalLine",
    "VerticalLine",
    "Layer",
}


def read_rp_json(rp_path_or_dict):
    """Run rp-read.mjs --json on a binary .rp path or return an already parsed dict."""
    if isinstance(rp_path_or_dict, dict):
        return rp_path_or_dict
    p_obj = Path(rp_path_or_dict).resolve()
    rp_path = str(p_obj)
    if not p_obj.is_file():
        raise FileNotFoundError(f"Missing or unreadable .rp file: {rp_path}")
    proc = subprocess.run(
        ["node", str(RP_READ_MJS), "--json", rp_path],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raw_err = (proc.stderr or proc.stdout or "").strip()
        clean_lines = [
            ln.strip() for ln in raw_err.splitlines()
            if ln.strip()
            and not ln.lstrip().startswith("at ")
            and "file://" not in ln
            and not ln.lstrip().startswith("^")
            and not ln.lstrip().startswith("Node.js v")
        ]
        msg = clean_lines[-1] if clean_lines else f"Invalid or unreadable .rp archive: {rp_path}"
        raise RuntimeError(f"Failed to read .rp archive ({rp_path}): {msg}")
    return json.loads(proc.stdout)


def _logical_id_from_native_name(native_name, fallback_idx=1):
    if not isinstance(native_name, str) or not native_name.strip():
        return f"w_{fallback_idx}"
    m = HASH_SUFFIX_RE.match(native_name.strip())
    raw = m.group(1) if m else native_name.strip()
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", raw).strip("_")
    if not cleaned or not re.match(r"^[A-Za-z_]", cleaned):
        cleaned = f"w_{cleaned}" if cleaned else f"w_{fallback_idx}"
    return cleaned


def _infer_widget_kind(w):
    wname = str(w.get("name") or "")
    wtype = str(w.get("type") or w.get("typeName") or "")
    if wtype == "DynamicPanel":
        return "dynamic-panel"
    if wtype == "Repeater":
        return "repeater"
    if wtype == "TextBox":
        return "input"
    if wtype == "ImageBox":
        return "image"
    if wtype in ("HorizontalLine", "VerticalLine"):
        return "divider"
    if wname.startswith("btn-") or "btn" in wname.lower() or "按钮" in wname:
        return "button"
    if wname.startswith("badge-"):
        return "badge"
    if wname.startswith("card-"):
        return "card"
    return "label"


def _unescape_lifted_string(raw_str):
    try:
        return json.loads('"' + raw_str + '"')
    except Exception:
        return raw_str.replace(r'\"', '"').replace(r"\\", "\\").replace(r"\n", "\n")


def _normalize_lifted_expr(val_str, name_to_logical):
    if not isinstance(val_str, str):
        return val_str, None
    s = val_str.strip()
    if not (s.startswith("[[") and s.endswith("]]")):
        return val_str, None
    inner = s[2:-2].strip()
    if re.search(r"\b(?:Target)?Item\.[A-Za-z_]", inner) or re.search(r"\brpv\d+\b", inner):
        return None, f"Row-scoped or unresolved runtime expression cannot be lifted outside its Repeater scope: {val_str}"
    def _repl_widget(m):
        w_native = m.group(1)
        if w_native in name_to_logical:
            mapped = name_to_logical[w_native]
            return f"@{mapped}" if mapped else m.group(0)
        return f"@{_logical_id_from_native_name(w_native)}"
    inner = re.sub(r"@([A-Za-z_][A-Za-z0-9_-]*)", _repl_widget, inner)
    return "=" + inner, None


def _lift_human_action_ex(act, name_to_logical, page_name_to_slug=None):
    """
    Lift an Axure native action summary from rp-read --json into an RP/1 AST action.
    Returns (action_dict_or_None, unsupported_reason_or_None).
    """
    if not isinstance(act, dict):
        return None, None
    page_name_to_slug = page_name_to_slug or {}
    atype = str(act.get("type") or "")
    human = str(act.get("human") or "").strip()

    if atype in ("set-variable", "setVariableValue"):
        m = (
            re.search(r"设置全局变量\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\"(.*)\"$", human, re.DOTALL)
            or re.search(r"Set value of\s+([A-Za-z_][A-Za-z0-9_-]*)\s+equal to\s+\"(.*)\"$", human, re.IGNORECASE | re.DOTALL)
        )
        if m:
            vname, raw_val = m.group(1), _unescape_lifted_string(m.group(2))
            if INTERNAL_VAR_RE.match(vname):
                return None, None
            if isinstance(raw_val, str) and raw_val.strip().startswith("[[") and raw_val.strip().endswith("]]"):
                norm_expr, err_reason = _normalize_lifted_expr(raw_val, name_to_logical)
                if err_reason:
                    return None, err_reason
                val = norm_expr
            elif re.fullmatch(r"-?\d+", str(raw_val)):
                val = int(raw_val)
            elif raw_val in ("true", "false"):
                val = raw_val == "true"
            else:
                val = raw_val
            return {"type": "set-variable", "variable": vname, "value": val}, None
        return None, f"Unrecognized set-variable syntax: {human}"

    if atype in ("set-rich-text", "set-rich-text-from-variable", "setText", "set-text"):
        m_var = re.search(r"设置富文本\s+(.+?)\s*=\s*全局变量\s+([A-Za-z_][A-Za-z0-9_-]*)$", human)
        if m_var:
            target_native, var_name = m_var.group(1).strip(), m_var.group(2).strip()
            if INTERNAL_VAR_RE.match(var_name):
                return None, None
            target_id = name_to_logical.get(target_native, _logical_id_from_native_name(target_native))
            return {"type": "set-text", "target": target_id, "text": f"${{{var_name}}}"}, None
        m = (
            re.search(r"设置富文本\s+(.+?)\s*=\s*\"(.*)\"$", human, re.DOTALL)
            or re.search(r"Set text on\s+(\S+)\s+equal to\s+\"(.*)\"$", human, re.IGNORECASE | re.DOTALL)
        )
        if m:
            target_native, raw_txt = m.group(1).strip(), _unescape_lifted_string(m.group(2))
            if isinstance(raw_txt, str) and raw_txt.strip().startswith("[[") and raw_txt.strip().endswith("]]"):
                norm_expr, err_reason = _normalize_lifted_expr(raw_txt, name_to_logical)
                if err_reason:
                    return None, err_reason
                raw_txt = norm_expr
            target_id = name_to_logical.get(target_native, _logical_id_from_native_name(target_native))
            return {"type": "set-text", "target": target_id, "text": raw_txt}, None
        return None, f"Unrecognized set-text syntax: {human}"

    if atype in ("set-panel-state", "setPanelState"):
        m = (
            re.search(r"设置面板(?:状态)?\s+(.+?)\s+(?:状态值\s*→\s*|→\s*)(.+?)(?:，循环)?$", human)
            or re.search(r"Set\s+(\S+)\s+to\s+(\S+)", human, re.IGNORECASE)
        )
        if m:
            panel_native, state_name = m.group(1).strip(), m.group(2).strip()
            panel_id = name_to_logical.get(panel_native, _logical_id_from_native_name(panel_native))
            return {"type": "set-panel-state", "target": panel_id, "state": state_name}, None
        return None, f"Unsupported panel state transition: {human}"

    if atype in ("show", "hide", "toggle", "fadeWidget"):
        clean_h = re.sub(r"（[^）]*）$", "", human).strip()
        m = (
            re.search(r"^(显示|隐藏|切换显示|切换)\s+(.+)$", clean_h)
            or re.search(r"^(Show|Hide|Toggle)\s+(.+)$", clean_h, re.IGNORECASE)
        )
        if m:
            kw, t_native = m.group(1).lower(), m.group(2).strip()
            verb = "hide" if kw in ("隐藏", "hide") else ("toggle" if kw in ("切换", "切换显示", "toggle") else "show")
            target_id = name_to_logical.get(t_native, _logical_id_from_native_name(t_native))
            return {"type": verb, "target": target_id}, None
        return None, f"Unsupported visibility action: {human}"

    if atype in ("enable", "disable"):
        m = re.search(r"^(?:启用|禁用|Enable|Disable)\s+(.+)$", human, re.IGNORECASE)
        if m:
            t_native = m.group(1).strip()
            target_id = name_to_logical.get(t_native, _logical_id_from_native_name(t_native))
            return {"type": atype, "target": target_id}, None
        return None, f"Unsupported enable/disable action: {human}"

    if atype == "focus":
        m = re.search(r"^(?:聚焦|Focus)\s+(.+)$", human, re.IGNORECASE)
        if m:
            t_native = m.group(1).strip()
            target_id = name_to_logical.get(t_native, _logical_id_from_native_name(t_native))
            return {"type": "focus", "target": target_id}, None
        return None, f"Unsupported focus action: {human}"

    if atype == "wait":
        m = re.search(r"(\d+)\s*ms", human)
        if m:
            return {"type": "wait", "ms": int(m.group(1))}, None
        return None, f"Unsupported wait action: {human}"

    if atype in ("link", "open-link", "openLink"):
        m_page = re.search(r"打开页面「(.+?)」", human)
        if m_page:
            raw_pg = m_page.group(1).strip()
            pg_id = page_name_to_slug.get(raw_pg, raw_pg)
            return {"type": "link", "page": pg_id}, None
        m_legacy = (
            re.search(r"打开链接\s*→\s*(\S+)", human)
            or re.search(r"Open\s+(\S+)", human, re.IGNORECASE)
        )
        if m_legacy:
            raw_pg = m_legacy.group(1).strip()
            if raw_pg.startswith(("http://", "https://")):
                return None, f"External URL link not supported in RP/1 link action: {raw_pg}"
            pg_id = page_name_to_slug.get(raw_pg, _logical_id_from_native_name(raw_pg))
            return {"type": "link", "page": pg_id}, None
        return None, f"Unsupported link action: {human}"

    return None, f"Unsupported native action '{atype}' ({human})"


def _lift_human_action(act, name_to_logical):
    la, _ = _lift_human_action_ex(act, name_to_logical)
    return la


def _lift_widget_events_ex(w, name_to_logical, page_name_to_slug=None, owner_sym=None):
    events_out = {}
    unsupported = []
    wid = owner_sym["id"] if isinstance(owner_sym, dict) else (w.get("name") or f"#{w.get('id')}")
    wname = w.get("name") or ""
    for ix in w.get("interactions") or []:
        ev_raw = str(ix.get("event") or ix.get("eventType") or "")
        ev_key = SUPPORTED_EVENT_MAP.get(ev_raw)
        if not ev_key:
            unsupported.append({
                "kind": "unsupported-event",
                "widgetId": wid,
                "widgetName": wname,
                "event": ev_raw,
                "detail": f"Unsupported native event '{ev_raw}' on widget '{wname}'",
            })
            continue
        cases = ix.get("cases") or []
        # Readback must prove that flattening preserves semantics. Legacy summaries
        # omitted Condition; an absent condition field is not an unconditional case.
        if (ix.get("disabled") or len(cases) > 1 or any(
            c.get("hasCondition") is not False or c.get("disabled")
            or any(a.get("disabled") for a in c.get("actions") or [])
            for c in cases
        )):
            unsupported.append({
                "kind": "unsupported-case-semantics",
                "widgetId": wid, "widgetName": wname, "event": ev_raw,
                "detail": "Conditional, multiple, disabled, or unknown-condition cases cannot be safely lifted into RP/1.",
            })
            continue
        lifted_cases = []
        for c in cases:
            acts = []
            for a in c.get("actions") or []:
                la, unsup_reason = _lift_human_action_ex(a, name_to_logical, page_name_to_slug)
                if la is not None and "target" in la and (la["target"] is None or la["target"] not in name_to_logical.values()):
                    la, unsup_reason = None, "Native action target is missing or ambiguous; an identity mapping is required."
                if unsup_reason:
                    unsupported.append({
                        "kind": "unsupported-action",
                        "widgetId": wid,
                        "widgetName": wname,
                        "event": ev_raw,
                        "actionType": a.get("type"),
                        "detail": unsup_reason,
                    })
                if la is not None:
                    acts.append(la)
            if acts:
                lifted_cases.append({"actions": acts})
        if len(lifted_cases) == 1:
            events_out[ev_key] = lifted_cases[0]["actions"]
    return events_out, unsupported


def _lift_widget_events(w, name_to_logical):
    ev_out, _ = _lift_widget_events_ex(w, name_to_logical)
    return ev_out


def decompile_rp(rp_path_or_dict):
    """Decompile a binary .rp file (or rp-read JSON) into a valid RP/1 JSON AST and .rp1 DSL string."""
    rp_data = read_rp_json(rp_path_or_dict)
    variables = {}
    for gv in rp_data.get("globalVariables") or []:
        vname = str(gv.get("name") or "")
        if not vname or INTERNAL_VAR_RE.match(vname):
            continue
        raw_val = str(gv.get("value") if gv.get("value") is not None else "")
        if re.fullmatch(r"-?\d+", raw_val):
            variables[vname] = {"type": "number", "value": int(raw_val)}
        elif re.fullmatch(r"-?\d+\.\d+", raw_val):
            variables[vname] = {"type": "number", "value": float(raw_val)}
        elif raw_val in ("true", "false"):
            variables[vname] = {"type": "boolean", "value": raw_val == "true"}
        else:
            variables[vname] = {"type": "text", "value": raw_val}

    raw_pages = rp_data.get("pages") or []
    page_name_to_slug = {}
    page_ids = []
    used_pids = set()
    for p_idx, p in enumerate(raw_pages):
        pname = str(p.get("name") or f"page_{p_idx+1}")
        pid = _logical_id_from_native_name(pname, p_idx + 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", pid):
            pid = f"page_{p_idx+1}"
        base_pid = pid
        seq = 2
        while pid in used_pids:
            pid = f"{base_pid}_{seq}"
            seq += 1
        used_pids.add(pid)
        page_ids.append(pid)
        page_name_to_slug.setdefault(pname, pid)

    pages = []
    unsupported = []
    for p_idx, p in enumerate(raw_pages):
        pname = str(p.get("name") or f"page_{p_idx+1}")
        pid = page_ids[p_idx]
        raw_widgets = p.get("widgets") or []
        name_to_logical = {}
        lid_by_idx = {}
        seen_wnames = set()
        used_ids = {"root"}
        for w_idx, w in enumerate(raw_widgets):
            wname = str(w.get("name") or "")
            if not wname or wname.startswith(("frame-", "bg-", "rep-")) or w.get("type") in ("Layer", "Repeater", "DynamicPanel"):
                continue
            cand = _logical_id_from_native_name(wname, w_idx + 1)
            base_cand = cand
            seq = 2
            while cand in used_ids:
                cand = f"{base_cand}_{seq}"
                seq += 1
            used_ids.add(cand)
            lid_by_idx[w_idx] = cand
            if wname in seen_wnames:
                name_to_logical[wname] = None
            else:
                seen_wnames.add(wname)
                name_to_logical[wname] = cand

        children = []
        max_r, max_b = 375, 812
        for w_idx, w in enumerate(raw_widgets):
            wname = str(w.get("name") or "")
            if not wname or wname.startswith(("frame-", "bg-", "rep-")) or w.get("type") in ("Layer", "Repeater", "DynamicPanel"):
                continue
            lid = lid_by_idx.get(w_idx, f"w_{w_idx+1}")
            kind = _infer_widget_kind(w)
            x = int(round(float(w.get("x") or 0)))
            y = int(round(float(w.get("y") or 0)))
            width = max(24, int(round(float(w.get("w") or 120))))
            height = max(20, int(round(float(w.get("h") or 28))))
            if kind in ("label", "paragraph", "button", "badge"):
                txt_val = str(w.get("text") or lid)
                lines = txt_val.splitlines() or [txt_val]
                longest = max((sum(16 if ord(ch) > 127 else 9 for ch in ln) for ln in lines), default=0)
                width = max(width, longest + 32)
                height = max(height, len(lines) * 24 + 8)
            max_r = max(max_r, x + width + 24, width + 64)
            max_b = max(max_b, y + height + 24)
            node = {
                "type": kind,
                "id": lid,
                "w": width,
                "h": height,
            }
            if kind == "input":
                node["value"] = str(w.get("text") or "")
            elif kind == "image":
                node["src"] = "icon-search.png"
            elif kind in ("label", "paragraph", "button", "badge"):
                node["text"] = str(w.get("text") or lid)
            elif w.get("text") and kind in ("card", "box"):
                node["title"] = str(w.get("text"))
            ev_map, unsup = _lift_widget_events_ex(w, name_to_logical, page_name_to_slug)
            unsupported.extend(unsup)
            if ev_map:
                node["on"] = ev_map
            children.append(node)

        if not children:
            children.append({"type": "label", "id": "empty_lbl", "text": pname, "w": 200, "h": 24})

        total_child_h = sum(int(c.get("h", 32)) for c in children) + max(0, len(children) - 1) * 8 + 64
        pages.append({
            "id": pid,
            "name": pname,
            "canvas": {"w": max_r, "h": max(max_b, total_child_h)},
            "root": {
                "type": "box",
                "id": "root",
                "layout": "column",
                "padding": 16,
                "gap": 8,
                "w": "fill",
                "h": "hug",
                "children": children,
            },
        })

    spec = {
        "language": "rp/1",
        "target": 9,
        "name": pages[0]["name"] if pages else "Decompiled Prototype",
        "domain": "web" if any(pg["canvas"]["w"] > 600 for pg in pages) else "mobile",
        "theme": "enterprise-light" if any(pg["canvas"]["w"] > 600 for pg in pages) else "mobile-lowfi",
    }
    if variables:
        spec["variables"] = variables
    spec["pages"] = pages
    from rp_language import compile_language
    _, ir = compile_language(spec)
    dsl_text = spec_to_dsl(spec)
    return {
        "ok": True,
        "status": "decompiled" if not unsupported else "decompiled_with_unsupported_native_changes",
        "unsupportedNativeChanges": unsupported,
        "spec": spec,
        "dsl": dsl_text,
        "rp1": dsl_text,
        "compiledSymbolCount": len(ir.get("symbols") or []),
        "pageCount": len(pages),
        "variableCount": len(variables),
    }


def find_ast_node_by_id(node, target_id):
    if isinstance(node, list):
        for item in node:
            found = find_ast_node_by_id(item, target_id)
            if found is not None:
                return found
        return None
    if not isinstance(node, dict):
        return None
    for k in ("id", "as", "button", "label", "badge", "input", "card", "box", "row", "column", "stack", "grid", "divider"):
        if node.get(k) == target_id:
            return node
    for ch_key in ("children", "layout"):
        for ch in node.get(ch_key) or []:
            found = find_ast_node_by_id(ch, target_id)
            if found is not None:
                return found
    for st in node.get("states") or []:
        found = find_ast_node_by_id(st.get("root") or st.get("layout"), target_id)
        if found is not None:
            return found
    if isinstance(node.get("template"), dict):
        found = find_ast_node_by_id(node["template"], target_id)
        if found is not None:
            return found
    if isinstance(node.get("slots"), dict):
        for snode in node["slots"].values():
            found = find_ast_node_by_id(snode, target_id)
            if found is not None:
                return found
    return None


def extract_rp_visual_props(rp_path):
    """Extract per-widget MyStyle visual props (fill, color, stroke, x, y, w, h) from a binary .rp file."""
    if not rp_path or not isinstance(rp_path, (str, Path)) or not os.path.exists(rp_path):
        return {}
    node_code = r"""
import { readFileSync } from 'node:fs';
import { readRecords } from './rp-records.mjs';
import { parsePayload, field } from './parse-payload.mjs';
const buf = readFileSync(process.argv[1]);
const recs = readRecords(buf).filter(r => ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(r.className));
const hex = v => (typeof v === 'number' && v > 0) ? '#' + (v & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0') : null;
const out = { __by_key__: {} };
for (const r of recs) {
  const g = parsePayload(r);
  for (const o of g.objects.values()) {
    if (!o.className?.startsWith('Axure:DiagramObject:')) continue;
    const wname = field(field(o.body, 'name-block') ?? {}, 'text')?.text ?? '';
    const st = g.objects.get(field(o.body, 'MyStyle')?.value);
    const props = {};
    for (const it of field(st?.body ?? {}, 'PropList')?.items ?? []) {
      const code = field(it, 'DOAName')?.value, val = field(it, 'Value');
      if (code === 3221225478) props.color = hex(field(val ?? {}, 'fill-color')?.value);
      if (code === 3221225479) props.fill = hex(field(val ?? {}, 'fill-color')?.value);
      if (code === 3221225480) props.stroke = hex(field(val ?? {}, 'fill-color')?.value);
      if (code === 3221225543 && typeof val?.value === 'number') props.radius = val.value;
      if (code === 3221225573) { props.x = field(val ?? {}, 'X')?.value; props.y = field(val ?? {}, 'Y')?.value; }
      if (code === 3221225577) { props.w = field(val ?? {}, 'Width')?.value; props.h = field(val ?? {}, 'Height')?.value; }
    }
    out.__by_key__[`${r.index}:${o.id}`] = { ...props, name: wname, record: r.index, id: o.id };
    if (wname) out[wname] = props;
  }
}
console.log(JSON.stringify(out));
"""
    res = subprocess.run(
        ["node", "--input-type=module", "-e", node_code, os.path.abspath(rp_path)],
        cwd=SCRIPT_DIR,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(res.stdout)


def _discover_baseline_meta(rp_path_or_dict):
    if not isinstance(rp_path_or_dict, (str, Path)):
        return None
    p = str(Path(rp_path_or_dict).resolve())
    candidates = [f"{p}.baseline.json"]
    stripped = re.sub(r"\.work-\d+\.rp$", ".rp", p)
    if stripped != p:
        candidates.append(f"{stripped}.baseline.json")
    for cand in candidates:
        if os.path.exists(cand):
            try:
                with open(cand, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return None


def _collect_rp_widgets(rp_data, visual_props=None, rec_remap=None):
    by_key = (visual_props or {}).get("__by_key__") or {}
    rec_remap = rec_remap or {}
    widgets = {}
    panel_state_map = {}
    pages = rp_data.get("pages") or []
    for p_idx, p in enumerate(pages):
        raw_p_rec = p.get("record") if p.get("record") is not None else (p_idx + 1)
        p_rec = rec_remap.get(raw_p_rec, raw_p_rec)
        p_name = p.get("name") or f"Page {p_idx + 1}"
        for w_order, w in enumerate(p.get("widgets") or []):
            wid = w.get("id") if w.get("id") is not None else f"m{w_order}"
            raw_wkey = f"{raw_p_rec}:{wid}"
            wkey = f"{p_rec}:{wid}"
            vp = by_key.get(raw_wkey) or by_key.get(wkey) or {}
            for pst in w.get("panel") or []:
                if pst.get("record") is not None:
                    raw_st_rec = pst["record"]
                    st_rec = rec_remap.get(raw_st_rec, raw_st_rec)
                    panel_state_map[raw_st_rec] = (p_idx, p_name, w.get("name"), pst.get("name"))
                    panel_state_map[st_rec] = (p_idx, p_name, w.get("name"), pst.get("name"))
            widgets[wkey] = {
                "key": wkey,
                "record": p_rec,
                "rawRecord": raw_p_rec,
                "id": wid,
                "order": w_order,
                "pageIdx": p_idx,
                "pageName": p_name,
                "container": [],
                "name": w.get("name") or "",
                "type": w.get("type") or "",
                "className": w.get("className") or "",
                "text": w.get("text"),
                "x": vp.get("x", w.get("x")),
                "y": vp.get("y", w.get("y")),
                "w": vp.get("w", w.get("w")),
                "h": vp.get("h", w.get("h")),
                "fill": vp.get("fill"),
                "stroke": vp.get("stroke"),
                "color": vp.get("color"),
                "radius": vp.get("radius"),
                "interactions": w.get("interactions") or [],
            }
    for cw_order, cw in enumerate(rp_data.get("containedWidgets") or []):
        raw_c_rec = cw.get("record")
        c_rec = rec_remap.get(raw_c_rec, raw_c_rec)
        cid = cw.get("id") if cw.get("id") is not None else f"cm{cw_order}"
        raw_wkey = f"{raw_c_rec}:{cid}"
        wkey = f"{c_rec}:{cid}"
        if wkey in widgets:
            widgets[wkey]["container"] = cw.get("container") or []
            if cw.get("interactions") and not widgets[wkey]["interactions"]:
                widgets[wkey]["interactions"] = cw["interactions"]
            continue
        p_info = panel_state_map.get(c_rec, panel_state_map.get(raw_c_rec, (0, pages[0].get("name") if pages else "Page 1", None, None)))
        vp = by_key.get(raw_wkey) or by_key.get(wkey) or {}
        widgets[wkey] = {
            "key": wkey,
            "record": c_rec,
            "rawRecord": raw_c_rec,
            "id": cid,
            "order": 10000 + cw_order,
            "pageIdx": p_info[0],
            "pageName": p_info[1],
            "container": cw.get("container") or [],
            "panelName": p_info[2],
            "panelState": p_info[3],
            "name": cw.get("name") or "",
            "type": cw.get("type") or "",
            "className": cw.get("className") or "",
            "text": cw.get("text"),
            "x": vp.get("x", cw.get("x")),
            "y": vp.get("y", cw.get("y")),
            "w": vp.get("w", cw.get("w")),
            "h": vp.get("h", cw.get("h")),
            "fill": vp.get("fill"),
            "stroke": vp.get("stroke"),
            "color": vp.get("color"),
            "radius": vp.get("radius"),
            "interactions": cw.get("interactions") or [],
        }
    return widgets


def _map_base_widgets_to_symbols(base_widgets, base_ir, lowered_spec, baseline_meta=None):
    syms_by_id = {s["id"]: s for s in base_ir.get("symbols") or []}
    page_slug_to_idx = {p.get("slug"): idx for idx, p in enumerate(lowered_spec.get("pages") or [])}
    wkey_to_sym = {}
    wkey_to_bg_sym = {}
    matched_sym_ids = set()

    if isinstance(baseline_meta, dict) and isinstance(baseline_meta.get("sourceMap"), list):
        for sm in baseline_meta["sourceMap"]:
            sid = sm.get("id") or sm.get("logicalId")
            sym = syms_by_id.get(sid)
            if not sym:
                continue
            for loc in sm.get("native") or []:
                nkey = f"{loc.get('record')}:{loc.get('id')}"
                if nkey in base_widgets:
                    wkey_to_sym[nkey] = sym
                    matched_sym_ids.add(sid)

    # Fallback / completion for symbols or companion bg shapes not in baseline_meta
    for p_idx, p_low in enumerate(lowered_spec.get("pages") or []):
        p_slug = p_low.get("slug")
        page_syms = [s for s in base_ir.get("symbols") or [] if s.get("pageId") == p_slug]
        page_bws = sorted(
            [bw for bw in base_widgets.values() if bw.get("pageIdx") == p_idx],
            key=lambda x: (str(x.get("record")), x.get("order", 0)),
        )
        # 1. Exact internal emit name match
        for s in page_syms:
            ename = s["name"]
            for bw in page_bws:
                if bw["name"] == ename and bw["key"] not in wkey_to_sym:
                    wkey_to_sym[bw["key"]] = s
                    matched_sym_ids.add(s["id"])
                elif bw["name"] in (f"bg-{ename}", f"bg-box-{ename}") and bw["key"] not in wkey_to_bg_sym:
                    wkey_to_bg_sym[bw["key"]] = s
        # 2. Display name match in preorder per page (handles duplicate display names on same/different pages)
        unmatched_syms = [s for s in page_syms if s["id"] not in matched_sym_ids]
        by_display = {}
        for s in unmatched_syms:
            dname = s.get("display") or s.get("name")
            by_display.setdefault(dname, []).append(s)
        for dname, s_list in by_display.items():
            cand_bws = [bw for bw in page_bws if bw["name"] == dname and bw["key"] not in wkey_to_sym]
            for s, bw in zip(s_list, cand_bws):
                wkey_to_sym[bw["key"]] = s
                matched_sym_ids.add(s["id"])
            bg_bws = [bw for bw in page_bws if bw["name"] in (f"bg-{dname}", f"bg-box-{dname}") and bw["key"] not in wkey_to_bg_sym]
            for s, bw in zip(s_list, bg_bws):
                wkey_to_bg_sym[bw["key"]] = s

    return wkey_to_sym, wkey_to_bg_sym


def _resolve_json_pointer(doc, pointer):
    if not pointer or pointer == "/":
        return doc, None
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.lstrip("/").split("/")]
    cur = doc
    parent = None
    for part in parts:
        parent = cur
        if isinstance(cur, list):
            idx = int(part)
            if idx < 0 or idx >= len(cur):
                return None, None
            cur = cur[idx]
        elif isinstance(cur, dict):
            if part not in cur:
                return None, None
            cur = cur[part]
        else:
            return None, None
    return cur, parent


def _index_use_instances(spec_obj):
    uses = {}

    def _node_id(n):
        if not isinstance(n, dict):
            return None
        for k in ("id", "use", "box", "card", "row", "column", "stack", "grid", "dynamic-panel"):
            if isinstance(n.get(k), str):
                return n[k]
        return None

    def _walk(node, scope, ptr_path):
        if not isinstance(node, dict):
            return
        nid = _node_id(node)
        cur_scope = f"{scope}/{nid}" if nid else scope
        is_use = node.get("type") == "use" or "use" in node
        if is_use and nid:
            comp_name = node.get("component") or node.get("use")
            uses[cur_scope] = {
                "logicalId": cur_scope,
                "component": comp_name,
                "pointer": ptr_path,
                "node": node,
            }
        for ch_key in ("children", "layout"):
            if isinstance(node.get(ch_key), list):
                for idx, ch in enumerate(node[ch_key]):
                    _walk(ch, cur_scope if not (ptr_path.endswith("/root") or ptr_path == "") else scope, f"{ptr_path}/{ch_key}/{idx}")
        for idx, st in enumerate(node.get("states") or []):
            if isinstance(st, dict):
                st_id = st.get("id") or st.get("name") or f"s{idx}"
                _walk(st.get("root") or st, f"{cur_scope}/{st_id}", f"{ptr_path}/states/{idx}/root")

    for p_idx, pg in enumerate(spec_obj.get("pages") or []):
        p_id = pg.get("id") or pg.get("slug") or f"page_{p_idx+1}"
        if isinstance(pg.get("root"), dict):
            _walk(pg["root"], p_id, f"/pages/{p_idx}/root")
        elif isinstance(pg.get("layout"), list):
            for c_idx, ch in enumerate(pg["layout"]):
                _walk(ch, p_id, f"/pages/{p_idx}/layout/{c_idx}")
    return uses


def _resolve_ast_target(spec_obj, sym, use_instances):
    ptr = sym.get("pointer") or ""
    sid = sym.get("id") or ""
    if ptr.startswith("/components/"):
        matched_use = None
        for u_prefix, u_info in sorted(use_instances.items(), key=lambda item: len(item[0]), reverse=True):
            if sid == u_prefix or sid.startswith(u_prefix + "/"):
                matched_use = u_info
                break
        tmpl_node, tmpl_parent = _resolve_json_pointer(spec_obj, ptr)
        if matched_use is not None and isinstance(tmpl_node, dict):
            comp_name = matched_use["component"]
            comp_def = (spec_obj.get("components") or {}).get(comp_name) or {}
            all_uses = [u for u in use_instances.values() if u["component"] == comp_name]
            return {
                "kind": "component_instance",
                "useNode": matched_use["node"],
                "useId": matched_use["logicalId"],
                "compName": comp_name,
                "compDef": comp_def,
                "templateNode": tmpl_node,
                "templateParent": tmpl_parent,
                "allUses": all_uses,
            }
    node, parent = _resolve_json_pointer(spec_obj, ptr)
    if isinstance(node, dict):
        # If parent was a 'children' or 'layout' list, resolve the container dict as parent
        container_parent = None
        if "/children/" in ptr or "/layout/" in ptr:
            parent_ptr = ptr.rsplit("/", 2)[0]
            container_parent, _ = _resolve_json_pointer(spec_obj, parent_ptr)
        return {"kind": "ast_node", "node": node, "parent": container_parent}
    # Fallback by page and short ID
    page_slug = sym.get("pageId")
    short_id = sid.rsplit("/", 1)[-1]
    for pg in spec_obj.get("pages") or []:
        if (pg.get("id") or pg.get("slug")) == page_slug:
            found = find_ast_node_by_id(pg.get("root") or pg.get("layout"), short_id)
            if isinstance(found, dict):
                return {"kind": "ast_node", "node": found, "parent": pg.get("root") or pg}
    return None


def _extract_node_prop(target, prop):
    if not target:
        return None
    if target["kind"] == "component_instance":
        tmpl = target["templateNode"]
        use_node = target["useNode"]
        raw = tmpl.get(prop)
        if isinstance(raw, str) and raw.startswith("$") and len(raw) > 1:
            pname = raw[1:]
            return (use_node.get("args") or {}).get(pname, raw)
        return raw
    node = target["node"]
    if prop in ("text", "value"):
        tkey = "value" if (node.get("type") == "input" or "input" in node) else "text"
        return node.get(tkey)
    if prop == "on":
        if "on" in node and isinstance(node["on"], dict):
            return copy.deepcopy(node["on"])
        if "onClick" in node:
            oc = node["onClick"]
            return {"click": copy.deepcopy(oc if isinstance(oc, list) else [oc])}
        return None
    return node.get(prop)


def _remove_ast_node(spec_obj, target_sym, target_node):
    page_slug = target_sym.get("pageId")
    short_id = (target_sym.get("logicalId") or target_sym.get("id") or "").rsplit("/", 1)[-1]

    def _prune_list(items):
        if not isinstance(items, list):
            return False
        for i, item in enumerate(list(items)):
            if item is target_node:
                items.pop(i)
                return True
            if isinstance(item, dict):
                item_id = item.get("id")
                if not item_id:
                    for k in ("box", "column", "row", "stack", "grid", "card", "label", "paragraph", "button", "input", "image", "repeater", "panel", "badge", "divider", "use"):
                        if isinstance(item.get(k), str):
                            item_id = item.get(k)
                            break
                if item_id == short_id and target_node is item:
                    items.pop(i)
                    return True
                if _prune_container(item):
                    return True
        return False

    def _prune_container(container):
        if not isinstance(container, dict):
            return False
        for key in ("children", "layout"):
            if _prune_list(container.get(key)):
                return True
        if isinstance(container.get("root"), dict):
            if _prune_container(container["root"]):
                return True
        for st in (container.get("states") or {}).values() if isinstance(container.get("states"), dict) else (container.get("states") or []):
            if isinstance(st, dict) and _prune_container(st):
                return True
            elif isinstance(st, list) and _prune_list(st):
                return True
        return False

    for pg in spec_obj.get("pages") or []:
        if (pg.get("id") or pg.get("slug")) == page_slug:
            if _prune_container(pg):
                return True
    return False


def _apply_prop_to_target(target, sym, prop, new_val, old_val=None, coordinate_space="native"):
    if not target:
        return None
    if target["kind"] == "component_instance":
        tmpl = target["templateNode"]
        use_node = target["useNode"]
        raw_tmpl = tmpl.get(prop)
        if isinstance(raw_tmpl, str) and raw_tmpl.startswith("$") and len(raw_tmpl) > 1:
            param_name = raw_tmpl[1:]
            prev_val = (use_node.get("args") or {}).get(param_name, old_val)
            if prop in ("x", "y") and coordinate_space == "native" and isinstance(prev_val, (int, float)) and isinstance(old_val, (int, float)):
                new_val = prev_val + new_val - old_val
            use_node.setdefault("args", {})[param_name] = new_val
            return {
                "id": sym["id"],
                "useId": target["useId"],
                "component": target["compName"],
                "property": prop,
                "param": param_name,
                "promotedParam": False,
                "isComponentInstance": True,
                "oldValue": prev_val,
                "newValue": new_val,
            }
        return {
            "unsupported": True,
            "kind": "component-instance-local-edit",
            "id": sym["id"],
            "useId": target["useId"],
            "component": target["compName"],
            "page": sym.get("pageName") or sym.get("pageId"),
            "property": prop,
            "oldValue": old_val,
            "newValue": new_val,
            "detail": f"Local edit on non-parameterized property '{prop}' of shared component instance '{target['useId']}' ({target['compName']}) cannot be written back without mutating the global component definition.",
        }

    ast_node = target["node"]
    parent_node = target.get("parent")
    if prop in ("text", "value"):
        tkey = "value" if (ast_node.get("type") == "input" or "input" in ast_node) else "text"
        cur_txt = ast_node.get(tkey)
        if isinstance(cur_txt, str) and ("${" in cur_txt or cur_txt.startswith("=")):
            return {
                "unsupported": True,
                "kind": "computed-text-edit",
                "id": sym["id"],
                "page": sym.get("pageName") or sym.get("pageId"),
                "property": tkey,
                "expression": cur_txt,
                "oldValue": old_val,
                "newValue": str(new_val),
                "detail": f"Widget '{sym['id']}' uses computed expression '{cur_txt}'; overwriting with literal '{new_val}' would destroy formula semantics.",
            }
        ast_node[tkey] = str(new_val)
        return {"id": sym["id"], "property": tkey, "oldValue": old_val, "newValue": str(new_val)}
    if prop == "name":
        ast_node["name"] = str(new_val)
        return {"id": sym["id"], "property": "name", "oldValue": old_val, "newValue": str(new_val)}
    if prop in ("x", "y"):
        if coordinate_space == "native" and any(ast_node.get(k) is not None for k in ("right", "bottom", "anchor")):
            return {"unsupported": True, "kind": "anchored-position-edit", "id": sym["id"],
                    "detail": "Native movement of an anchored widget requires an explicit source anchor change."}
        if coordinate_space == "source":
            computed_coord = new_val
        elif isinstance(ast_node.get(prop), (int, float)) and isinstance(old_val, (int, float)):
            computed_coord = int(round(float(ast_node[prop]) + (float(new_val) - float(old_val))))
        elif isinstance(old_val, (int, float)) and isinstance(parent_node, dict) and parent_node.get("layout", parent_node.get("type")) == "stack":
            computed_coord = int(round(float(new_val) - float(old_val)))
        else:
            offset = 0
            if isinstance(parent_node, dict) and (parent_node.get("layout") == "stack" or parent_node.get("type") == "stack"):
                pad = parent_node.get("padding", 0)
                if isinstance(pad, (int, float)):
                    offset = int(round(pad))
                elif isinstance(pad, list) and pad:
                    offset = int(round(pad[0] if prop == "y" else (pad[1] if len(pad) > 1 else pad[0])))
            computed_coord = int(round(float(new_val) - offset))
        ast_node[prop] = computed_coord
        return {"id": sym["id"], "property": prop, "oldValue": old_val, "newValue": computed_coord}
    if prop in ("w", "h", "fill", "stroke", "color", "radius"):
        val_norm = int(round(float(new_val))) if prop in ("w", "h", "radius") and isinstance(new_val, (int, float)) else new_val
        ast_node[prop] = val_norm
        return {"id": sym["id"], "property": prop, "oldValue": old_val, "newValue": val_norm}
    if prop == "on":
        for pop_k in ("onClick", "onChange", "onLoad", "onMouseOver", "onMouseOut", "onFocus", "onBlur", "onStateChange", "on"):
            ast_node.pop(pop_k, None)
        if new_val:
            ast_node["on"] = copy.deepcopy(new_val)
        return {"id": sym["id"], "property": "on", "oldValue": old_val, "newValue": new_val}
    return None


def _lift_rp_into_trace_spec(base_spec, base_rp, gui_rp, base_vis, gui_vis, gui_target=None):
    merged = copy.deepcopy(base_spec)
    frames = merged.get("frames") or []
    frame = frames[0] if frames else {"name": "图片还原页", "children": []}
    children = frame.setdefault("children", [])
    base_widgets = _collect_rp_widgets(base_rp, base_vis)
    gui_widgets = _collect_rp_widgets(gui_rp, gui_vis)

    wkey_to_child = {}
    used_children = set()
    for wkey, bw in sorted(base_widgets.items(), key=lambda kv: kv[1].get("order", 0)):
        wname = bw.get("name") or ""
        if wname == frame.get("name"):
            continue
        matched_idx = None
        for idx, ch in enumerate(children):
            if idx in used_children:
                continue
            if ch.get("name") == wname:
                matched_idx = idx
                break
        if matched_idx is not None:
            used_children.add(matched_idx)
            wkey_to_child[wkey] = children[matched_idx]

    lifted_text_edits = []
    lifted_renames = []
    lifted_visual_edits = []
    lifted_new_widgets = []
    lifted_deleted_widgets = []
    native_prop_deltas = {}

    for wkey, gw in gui_widgets.items():
        wname = gw.get("name") or ""
        bw = base_widgets.get(wkey)
        if bw is None:
            if wname == frame.get("name") or wname.startswith(("frame-", "bg-")):
                continue
            gx = int(round(float(gw.get("x") or 0)))
            gy = int(round(float(gw.get("y") or 0)))
            gw_w = max(24, int(round(float(gw.get("w") or 100))))
            gw_h = max(20, int(round(float(gw.get("h") or 28))))
            new_ch = {
                "type": "text" if gw.get("text") else "box",
                "name": wname or f"widget-{len(children) + 1}",
                "text": str(gw.get("text") or ""),
                "x": gx,
                "y": gy,
                "w": gw_w,
                "h": gw_h,
            }
            for vprop in ("fill", "stroke", "color", "radius"):
                if gw.get(vprop) is not None:
                    new_ch[vprop] = gw[vprop]
            children.append(new_ch)
            lifted_new_widgets.append(new_ch)
            continue

        ch = wkey_to_child.get(wkey)
        if ch is None:
            continue
        cid = ch.get("name") or wkey
        if gw.get("name") is not None and gw.get("name") != bw.get("name"):
            old_nm = bw.get("name") or ""
            new_nm = gw.get("name") or ""
            ch["name"] = new_nm
            lifted_renames.append({"id": cid, "oldName": old_nm, "newName": new_nm})
            native_prop_deltas.setdefault(cid, {})["name"] = {"old": old_nm, "new": new_nm, "nativeName": new_nm}
        if (gw.get("text") or "") != (bw.get("text") or ""):
            old_t = bw.get("text") or ""
            new_t = gw.get("text") or ""
            ch["text"] = new_t
            lifted_text_edits.append({"id": cid, "oldText": old_t, "newText": new_t})
            native_prop_deltas.setdefault(cid, {})["text"] = {"old": old_t, "new": new_t, "nativeName": wname}
        for gprop in ("x", "y", "w", "h"):
            if gw.get(gprop) is not None and bw.get(gprop) is not None:
                g_new = int(round(float(gw[gprop])))
                g_old = int(round(float(bw[gprop])))
                if g_new != g_old:
                    ch[gprop] = g_new
                    lifted_visual_edits.append({"id": cid, "property": gprop, "oldValue": g_old, "newValue": g_new, "nativeName": wname})
                    native_prop_deltas.setdefault(cid, {})[gprop] = {"old": g_old, "new": g_new, "nativeName": wname}
        for vprop in ("fill", "stroke", "color", "radius"):
            if gw.get(vprop) is not None and gw.get(vprop) != bw.get(vprop):
                ch[vprop] = gw[vprop]
                lifted_visual_edits.append({"id": cid, "property": vprop, "oldValue": bw.get(vprop), "newValue": gw[vprop], "nativeName": wname})
                native_prop_deltas.setdefault(cid, {})[vprop] = {"old": bw.get(vprop), "new": gw[vprop], "nativeName": wname}

    for wkey, bw in base_widgets.items():
        if wkey in gui_widgets:
            continue
        ch = wkey_to_child.get(wkey)
        if ch is not None and ch in children:
            children.remove(ch)
            lifted_deleted_widgets.append({"id": ch.get("name") or wkey, "name": bw.get("name")})

    dec = {}
    if isinstance(gui_target, (str, Path)) and os.path.exists(str(gui_target)):
        try:
            dec = decompile_rp(gui_target)
        except Exception:
            dec = {}
    dsl_text = dec.get("rp1") or ""
    return {
        "ok": True,
        "status": "lifted",
        "originKind": "image-trace-spec",
        "spec": merged,
        "rp1Spec": dec.get("spec"),
        "dsl": dsl_text,
        "rp1": dsl_text,
        "report": {
            "updatedTexts": lifted_text_edits,
            "renamedWidgets": lifted_renames,
            "updatedVisuals": lifted_visual_edits,
            "addedWidgets": lifted_new_widgets,
            "deletedWidgets": lifted_deleted_widgets,
            "liftedInteractions": [],
            "componentInstanceChanges": [],
            "unsupportedNativeChanges": [],
        },
        "liftedTextEdits": lifted_text_edits,
        "liftedRenames": lifted_renames,
        "liftedVisualEdits": lifted_visual_edits,
        "liftedInteractions": [],
        "liftedNewWidgets": lifted_new_widgets,
        "liftedNewWidgetsWithPage": [],
        "liftedDeletedWidgets": lifted_deleted_widgets,
        "liftedComponentInstances": [],
        "unsupportedNativeChanges": [],
        "nativePropDeltas": native_prop_deltas,
    }


def lift_rp_into_spec(base_spec, base_rp_path_or_dict, gui_rp_path_or_dict=None, rp_json_override=None, baseline_meta=None, original_dsl_text=None):
    """
    3-Way Binary .rp Lifter:
    Compares baseline binary .rp against GUI/MCP-edited binary .rp by (record, id) and lifts:
      1. Modified widget text/value, display name (rename_widget), & geometry/style (`x`, `y`, `w`, `h`, `fill`, `stroke`, `color`)
      2. Newly added GUI widgets into their actual page & container (preserving stack `x, y, w, h`)
      3. Added, modified, or cleared interactions (`OnClick` etc.)
      4. Component instance (`use`) local edits into `use.args` without polluting other instances
      5. Reports any unsupported native changes in `unsupportedNativeChanges`
    """
    from rp_language import compile_language
    if isinstance(base_spec, (str, Path)):
        spec_path_str = str(base_spec)
        if original_dsl_text is None and spec_path_str.endswith(".rp1") and os.path.exists(spec_path_str):
            original_dsl_text = Path(spec_path_str).read_text(encoding="utf-8")
        from proto import read_source
        base_spec = read_source(spec_path_str)
    merged = copy.deepcopy(base_spec)
    gui_target = rp_json_override if rp_json_override is not None else gui_rp_path_or_dict
    if baseline_meta is None:
        baseline_meta = _discover_baseline_meta(base_rp_path_or_dict) or _discover_baseline_meta(gui_target)
    if (
        original_dsl_text is None
        and isinstance(baseline_meta, dict)
        and isinstance(baseline_meta.get("sourcePath"), str)
        and baseline_meta["sourcePath"].endswith(".rp1")
        and os.path.exists(baseline_meta["sourcePath"])
    ):
        original_dsl_text = Path(baseline_meta["sourcePath"]).read_text(encoding="utf-8")

    # Support decoding embedded baseRpBase64 when base_rp_path_or_dict was modified in-place
    temp_base_rp = None
    try:
        effective_base_rp = base_rp_path_or_dict
        if (
            isinstance(base_rp_path_or_dict, (str, Path))
            and isinstance(gui_target, (str, Path))
            and os.path.abspath(str(base_rp_path_or_dict)) == os.path.abspath(str(gui_target))
            and isinstance(baseline_meta, dict)
            and baseline_meta.get("baseRpBase64")
        ):
            fd, temp_base_rp = tempfile.mkstemp(suffix=".baseline.rp")
            os.close(fd)
            with open(temp_base_rp, "wb") as bf:
                bf.write(base64.b64decode(baseline_meta["baseRpBase64"]))
            effective_base_rp = temp_base_rp

        base_rp = read_rp_json(effective_base_rp)
        gui_rp = read_rp_json(gui_target)
        base_vis = extract_rp_visual_props(effective_base_rp) if isinstance(effective_base_rp, (str, Path)) else {}
        gui_vis = extract_rp_visual_props(gui_target) if isinstance(gui_target, (str, Path)) else {}
    finally:
        if temp_base_rp and os.path.exists(temp_base_rp):
            os.remove(temp_base_rp)

    if isinstance(base_spec, dict) and "frames" in base_spec and "language" not in base_spec:
        return _lift_rp_into_trace_spec(base_spec, base_rp, gui_rp, base_vis, gui_vis, gui_target=gui_target)

    lowered_base, base_ir = compile_language(copy.deepcopy(base_spec))
    base_pkg_by_id = {}
    for pkg in base_rp.get("packages") or []:
        if pkg.get("record") is not None:
            for pk in ("path", "key", "guid"):
                if pkg.get(pk):
                    base_pkg_by_id[(pk, pkg[pk])] = pkg["record"]
    gui_rec_to_base_rec = {}
    for pkg in gui_rp.get("packages") or []:
        g_rec = pkg.get("record")
        if g_rec is not None:
            for pk in ("path", "key", "guid"):
                if pkg.get(pk) and (pk, pkg[pk]) in base_pkg_by_id:
                    gui_rec_to_base_rec[g_rec] = base_pkg_by_id[(pk, pkg[pk])]
                    break
    base_widgets = _collect_rp_widgets(base_rp, base_vis)
    gui_widgets = _collect_rp_widgets(gui_rp, gui_vis, rec_remap=gui_rec_to_base_rec)
    wkey_to_sym, wkey_to_bg_sym = _map_base_widgets_to_symbols(base_widgets, base_ir, lowered_base, baseline_meta)
    use_instances = _index_use_instances(merged)

    all_page_names_to_slugs = {}
    for p_idx, pg in enumerate(merged.get("pages") or []):
        pid = pg.get("id") or pg.get("slug") or f"page_{p_idx+1}"
        pname = pg.get("name") or pid
        all_page_names_to_slugs[pname] = pid
        all_page_names_to_slugs[pid] = pid

    # Build per-page name_to_logical lookup (covering emit name, display name, base name, and renamed gui name)
    per_page_name_to_logical = {}
    for wkey, sym in wkey_to_sym.items():
        bw = base_widgets.get(wkey, {})
        gw = gui_widgets.get(wkey, {})
        p_idx = bw.get("pageIdx", 0)
        short_id = sym["id"].split("/", 1)[-1]
        nmap = per_page_name_to_logical.setdefault(p_idx, {})
        for cand_nm in (sym.get("name"), sym.get("display"), bw.get("name"), gw.get("name")):
            if cand_nm:
                if cand_nm not in nmap:
                    nmap[cand_nm] = short_id
                elif nmap[cand_nm] != short_id:
                    nmap[cand_nm] = None  # Never guess between duplicate display names.

    lifted_text_edits = []
    lifted_renames = []
    lifted_visual_edits = []
    lifted_interactions = []
    lifted_new_widgets = []
    lifted_component_instances = []
    unsupported_native_changes = []
    native_prop_deltas = {}

    def _record_delta(sym, prop, old_v, new_v, native_name=""):
        native_prop_deltas.setdefault(sym["id"], {})[prop] = {
            "old": old_v,
            "new": new_v,
            "nativeName": native_name,
        }

    for wkey, gw in gui_widgets.items():
        wname = gw.get("name") or ""
        bw = base_widgets.get(wkey)
        p_idx = gw.get("pageIdx", 0)
        # Recover page identity from the baseline record, not edited page order.
        page_matches = [i for i, p in enumerate(base_rp.get("pages") or [])
                        if p.get("record") == gw.get("record")]
        if len(page_matches) == 1:
            p_idx = page_matches[0]
        page_nmap = per_page_name_to_logical.get(p_idx, {})

        if bw is None:
            if wname.startswith(("frame-", "bg-", "rep-")) or gw.get("type") == "Layer":
                continue
            if gw.get("type") in ("DynamicPanel", "Repeater", "ImageBox"):
                unsupported_native_changes.append({
                    "kind": "unsupported-widget-payload", "widgetName": wname,
                    "detail": "New panel/repeater/image payloads cannot be reconstructed from a widget summary.",
                })
                continue
            if gw.get("type") and gw.get("type") not in SUPPORTED_NATIVE_WIDGET_TYPES:
                unsupported_native_changes.append({
                    "kind": "unsupported-widget",
                    "widgetId": gw.get("id"),
                    "widgetName": wname,
                    "widgetType": gw.get("type"),
                    "page": gw.get("pageName"),
                    "detail": f"Unsupported native widget type '{gw.get('type')}'",
                })
                continue
            pages_list = merged.get("pages") or []
            if (len(page_matches) != 1 or not 0 <= p_idx < len(pages_list)
                    or gw.get("panelName") or len(gw.get("container") or []) > 1):
                unsupported_native_changes.append({
                    "kind": "unmapped-native-container", "widgetName": wname,
                    "detail": "The new widget's page/container cannot be mapped unambiguously to RP/1.",
                })
                continue
            target_pg = pages_list[p_idx]
            used_short_ids = set(page_nmap.values()) | {"root"}
            base_lid = _logical_id_from_native_name(wname, len(lifted_new_widgets) + 1)
            lid = base_lid
            seq = 2
            while lid in used_short_ids:
                lid = f"{base_lid}_{seq}"
                seq += 1
            used_short_ids.add(lid)
            if wname:
                page_nmap[wname] = lid

            kind = _infer_widget_kind(gw)
            gx = int(round(float(gw.get("x") or 0)))
            gy = int(round(float(gw.get("y") or 0)))
            gw_w = max(24, int(round(float(gw.get("w") or 100))))
            gw_h = max(20, int(round(float(gw.get("h") or 28))))

            container_node = target_pg.get("root") if isinstance(target_pg.get("root"), dict) else target_pg
            pad_x, pad_y = 0, 0
            if isinstance(container_node, dict) and (container_node.get("layout") == "stack" or container_node.get("type") == "stack"):
                pad = container_node.get("padding", 0)
                if isinstance(pad, (int, float)):
                    pad_x = pad_y = int(round(pad))
                elif isinstance(pad, list) and pad:
                    pad_y = int(round(pad[0]))
                    pad_x = int(round(pad[1] if len(pad) > 1 else pad[0]))

            is_sugar_page = isinstance(target_pg.get("layout"), list) and "root" not in target_pg
            if is_sugar_page:
                new_item = {
                    kind: lid,
                    "x": gx - pad_x,
                    "y": gy - pad_y,
                    "w": gw_w,
                    "h": gw_h,
                }
            else:
                new_item = {
                    "type": kind,
                    "id": lid,
                    "x": gx - pad_x,
                    "y": gy - pad_y,
                    "w": gw_w,
                    "h": gw_h,
                }
            if wname and wname != lid and not HASH_SUFFIX_RE.match(wname):
                new_item["name"] = wname
            if kind == "input":
                new_item["value"] = str(gw.get("text") or "")
            else:
                new_item["text"] = str(gw.get("text") if gw.get("text") is not None else lid)
            for vprop in ("fill", "stroke", "color"):
                if gw.get(vprop):
                    new_item[vprop] = gw[vprop]
            ev_map, unsup_evs = _lift_widget_events_ex(gw, page_nmap, all_page_names_to_slugs)
            if unsup_evs:
                unsupported_native_changes.extend(unsup_evs)
            if ev_map:
                new_item["on"] = ev_map
                for ev_k, ev_acts in ev_map.items():
                    lifted_interactions.append({"id": lid, "page": target_pg.get("id") or target_pg.get("name"), "event": ev_k, "actions": ev_acts})

            if is_sugar_page:
                target_pg["layout"].append(new_item)
            elif isinstance(target_pg.get("root"), dict):
                target_pg["root"].setdefault("children", []).append(new_item)
            lifted_new_widgets.append({"pageIdx": p_idx, "pageId": target_pg.get("id") or target_pg.get("slug"), "node": new_item})
            continue

        sym = wkey_to_sym.get(wkey)
        bg_sym = wkey_to_bg_sym.get(wkey)
        if sym is None and bg_sym is not None:
            # Companion background shape (e.g. bg-box-...) carries fill/stroke/geometry for left/right-aligned widgets or boxes
            target = _resolve_ast_target(merged, bg_sym, use_instances)
            for vprop in ("fill", "stroke", "radius"):
                if gw.get(vprop) is not None and gw.get(vprop) != bw.get(vprop):
                    res = _apply_prop_to_target(target, bg_sym, vprop, gw[vprop], bw.get(vprop))
                    if isinstance(res, dict) and res.get("unsupported"):
                        unsupported_native_changes.append(res)
                    else:
                        _record_delta(bg_sym, vprop, bw.get(vprop), gw[vprop], wname)
                        if res:
                            lifted_visual_edits.append(res)
            continue

        if sym is None:
            continue

        target = _resolve_ast_target(merged, sym, use_instances)

        # 1. Check widget rename (rename_widget)
        if gw.get("name") is not None and gw.get("name") != bw.get("name"):
            old_nm = bw.get("name") or ""
            new_nm = gw.get("name") or ""
            res = _apply_prop_to_target(target, sym, "name", new_nm, old_nm)
            if isinstance(res, dict) and res.get("unsupported"):
                unsupported_native_changes.append(res)
            else:
                _record_delta(sym, "name", old_nm, new_nm, new_nm)
                lifted_renames.append({"id": sym["id"], "oldName": old_nm, "newName": new_nm})
                if isinstance(res, dict) and res.get("isComponentInstance"):
                    lifted_component_instances.append(res)

        # 2. Check text / value modification
        if (gw.get("text") or "") != (bw.get("text") or ""):
            tprop = "value" if sym.get("kind") == "input" else "text"
            old_t = bw.get("text") if bw.get("text") is not None else ""
            new_t = gw.get("text") if gw.get("text") is not None else ""
            res = _apply_prop_to_target(target, sym, tprop, new_t, old_t)
            if isinstance(res, dict) and res.get("unsupported"):
                unsupported_native_changes.append(res)
            else:
                _record_delta(sym, tprop, old_t, new_t, wname)
                lifted_text_edits.append({"id": sym["id"], "oldText": old_t, "newText": new_t})
                if isinstance(res, dict) and res.get("isComponentInstance"):
                    lifted_component_instances.append(res)

        # 3. Check geometry (x, y, w, h) & visual style (fill, stroke, color, radius) modifications
        for gprop in ("x", "y", "w", "h"):
            if gw.get(gprop) is not None and bw.get(gprop) is not None:
                g_new = int(round(float(gw[gprop])))
                g_old = int(round(float(bw[gprop])))
                if g_new != g_old:
                    source_old = _extract_node_prop(target, gprop)
                    res = _apply_prop_to_target(target, sym, gprop, g_new, g_old)
                    if isinstance(res, dict) and res.get("unsupported"):
                        unsupported_native_changes.append(res)
                    else:
                        applied_val = res["newValue"] if isinstance(res, dict) and "newValue" in res else g_new
                        _record_delta(sym, gprop, source_old, applied_val, wname)
                        native_prop_deltas[sym["id"]][gprop].update({
                            "coordinateSpace": "source", "nativeOld": g_old, "nativeNew": g_new,
                        })
                        lifted_visual_edits.append({"id": sym["id"], "property": gprop, "oldValue": g_old, "newValue": applied_val, "nativeName": wname})
                        if isinstance(res, dict) and res.get("isComponentInstance"):
                            lifted_component_instances.append(res)

        for vprop in ("fill", "stroke", "color", "radius"):
            if gw.get(vprop) is not None and gw.get(vprop) != bw.get(vprop):
                res = _apply_prop_to_target(target, sym, vprop, gw[vprop], bw.get(vprop))
                if isinstance(res, dict) and res.get("unsupported"):
                    unsupported_native_changes.append(res)
                else:
                    _record_delta(sym, vprop, bw.get(vprop), gw[vprop], wname)
                    lifted_visual_edits.append({"id": sym["id"], "property": vprop, "oldValue": bw.get(vprop), "newValue": gw[vprop], "nativeName": wname})
                    if isinstance(res, dict) and res.get("isComponentInstance"):
                        lifted_component_instances.append(res)

        # 4. Check interaction additions, modifications, or removals
        base_ixs = bw.get("interactions") or []
        gui_ixs = gw.get("interactions") or []
        base_ix_dump = json.dumps(base_ixs, sort_keys=True, ensure_ascii=False)
        gui_ix_dump = json.dumps(gui_ixs, sort_keys=True, ensure_ascii=False)
        if gui_ix_dump != base_ix_dump:
            base_ev_map, _ = _lift_widget_events_ex(bw, page_nmap, all_page_names_to_slugs, sym)
            gui_ev_map, unsup_evs = _lift_widget_events_ex(gw, page_nmap, all_page_names_to_slugs, sym)
            if unsup_evs:
                unsupported_native_changes.extend(unsup_evs)
            if not gui_ixs and base_ixs:
                # Interaction explicitly cleared in .rp
                res = _apply_prop_to_target(target, sym, "on", None, base_ev_map)
                if isinstance(res, dict) and res.get("unsupported"):
                    unsupported_native_changes.append(res)
                else:
                    _record_delta(sym, "on", base_ev_map, None, wname)
                    lifted_interactions.append({"id": sym["id"], "events": {}, "cleared": True})
            elif gui_ev_map:
                res = _apply_prop_to_target(target, sym, "on", gui_ev_map, base_ev_map)
                if isinstance(res, dict) and res.get("unsupported"):
                    unsupported_native_changes.append(res)
                else:
                    _record_delta(sym, "on", base_ev_map, gui_ev_map, wname)
                    lifted_interactions.append({"id": sym["id"], "events": gui_ev_map})

    # 5. Check deleted widgets (present in base_widgets and mapped to a symbol, but absent in gui_widgets)
    lifted_deleted_widgets = []
    for wkey, bw in base_widgets.items():
        if wkey in gui_widgets:
            continue
        sym = wkey_to_sym.get(wkey)
        if sym is None:
            continue
        target = _resolve_ast_target(merged, sym, use_instances)
        if not target:
            continue
        if target["kind"] == "component_instance":
            unsupported_native_changes.append({
                "unsupported": True,
                "kind": "component-instance-delete",
                "id": sym["id"],
                "useId": target["useId"],
                "component": target["compName"],
                "page": sym.get("pageName") or sym.get("pageId"),
                "detail": f"Deleting inner widget '{sym['id']}' of shared component instance '{target['useId']}' is not supported without mutating the shared component definition.",
            })
            continue
        if _remove_ast_node(merged, sym, target["node"]):
            lifted_deleted_widgets.append({
                "id": sym["id"],
                "logicalId": sym.get("logicalId") or sym["id"],
                "pageId": sym.get("pageId"),
                "pageName": sym.get("pageName"),
                "name": bw.get("name"),
            })

    dsl_text = spec_to_dsl(merged)
    if original_dsl_text:
        dsl_text = preserve_rp1_comments(original_dsl_text, dsl_text)
    return {
        "ok": len(unsupported_native_changes) == 0,
        "status": "lifted" if not unsupported_native_changes else "unsupported_native_changes",
        "spec": merged,
        "dsl": dsl_text,
        "rp1": dsl_text,
        "report": {
            "updatedTexts": lifted_text_edits,
            "renamedWidgets": lifted_renames,
            "updatedVisuals": lifted_visual_edits,
            "addedWidgets": [x["node"] for x in lifted_new_widgets],
            "deletedWidgets": lifted_deleted_widgets,
            "liftedInteractions": lifted_interactions,
            "componentInstanceChanges": lifted_component_instances,
            "unsupportedNativeChanges": unsupported_native_changes,
        },
        "liftedTextEdits": lifted_text_edits,
        "liftedRenames": lifted_renames,
        "liftedVisualEdits": lifted_visual_edits,
        "liftedInteractions": lifted_interactions,
        "liftedNewWidgets": [x["node"] for x in lifted_new_widgets],
        "liftedNewWidgetsWithPage": lifted_new_widgets,
        "liftedDeletedWidgets": lifted_deleted_widgets,
        "liftedComponentInstances": lifted_component_instances,
        "unsupportedNativeChanges": unsupported_native_changes,
        "nativePropDeltas": native_prop_deltas,
    }


def _compute_source_prop_deltas(base_spec, new_spec):
    from rp_language import compile_language, effective_scene_nodes
    lowered_base, base_ir = compile_language(copy.deepcopy(base_spec))
    lowered_new, new_ir = compile_language(copy.deepcopy(new_spec))
    base_syms = {s["id"]: s for s in base_ir.get("symbols") or []}
    new_syms = {s["id"]: s for s in new_ir.get("symbols") or []}
    base_uses = _index_use_instances(base_spec)
    new_uses = _index_use_instances(new_spec)
    base_nodes = effective_scene_nodes(lowered_base)
    new_nodes = effective_scene_nodes(lowered_new)
    deltas = {}
    for sid in base_syms.keys() - new_syms.keys():
        deltas[sid] = {"__deleted__": {"old": "present", "new": "deleted"}}
    for sid in new_syms.keys() - base_syms.keys():
        deltas[sid] = {"__added__": {"old": None, "new": "present"}}
    for sid in set(base_syms) & set(new_syms):
        bt = _resolve_ast_target(base_spec, base_syms[sid], base_uses)
        nt = _resolve_ast_target(new_spec, new_syms[sid], new_uses)
        bn = base_nodes.get(base_syms[sid]["name"], {})
        nn = new_nodes.get(new_syms[sid]["name"], {})
        for prop in ("text", "value", "name", "x", "y", "w", "h", "fill", "stroke", "color", "radius", "on"):
            bval = _extract_node_prop(bt, prop) if bt else None
            nval = _extract_node_prop(nt, prop) if nt else None
            # Source pointers address the original AST, not the lowered tree.
            # Resolve shared palette/theme/component values by compiled identity.
            lbval = bn.get(prop, bval) if prop not in ("on", "name") else bval
            lnval = nn.get(prop, nval) if prop not in ("on", "name") else nval
            if bval != nval:
                deltas.setdefault(sid, {})[prop] = {"old": lbval if lbval is not None else bval, "new": lnval if lnval is not None else nval}
            elif lbval != lnval and prop in ("fill", "stroke", "color", "radius", "text", "value", "w", "h"):
                deltas.setdefault(sid, {})[prop] = {"old": lbval, "new": lnval, "via": "palette_or_theme"}
    return deltas


def _layout_context(spec, sym):
    """Parent identity/layout relevant to inverse coordinate mapping, without indexes."""
    context = []
    parts = (sym.get("pointer") or "").split("/")
    keys = ("id", "type", "layout", "x", "y", "w", "h", "padding", "gap",
            "align", "justify", "columns", "wrap", "canvas")
    for end in range(1, len(parts)):
        node, _ = _resolve_json_pointer(spec, "/".join(parts[:end]))
        if isinstance(node, dict) and ("root" in node or "children" in node
                                      or isinstance(node.get("layout"), list)):
            context.append({k: node[k] for k in keys if k in node and
                            not (k == "layout" and isinstance(node[k], list))})
    return context


def three_way_merge_rp(
    base_spec_path,
    base_rp_path,
    edited_rp_path,
    new_spec_path,
    out_spec_path=None,
    out_rp_path=None,
    prefer="fail",
    baseline_meta=None,
    resolutions=None,
):
    """
    Three-way merge between (base_spec -> new_spec) and (base_rp -> edited_rp).
    Supports conflict detection and resolution strategies: prefer='fail' | 'source' | 'native' or explicit `resolutions` dict.
    """
    from proto import read_source
    from rp_language import compile_language

    original_dsl_text = None
    for cand_src in (
        new_spec_path,
        base_spec_path,
        baseline_meta.get("sourcePath") if isinstance(baseline_meta, dict) else None,
    ):
        if isinstance(cand_src, (str, Path)) and str(cand_src).endswith(".rp1") and os.path.exists(str(cand_src)):
            original_dsl_text = Path(cand_src).read_text(encoding="utf-8")
            break

    base_spec = copy.deepcopy(base_spec_path) if isinstance(base_spec_path, dict) else read_source(str(base_spec_path))
    new_spec = copy.deepcopy(new_spec_path) if isinstance(new_spec_path, dict) else read_source(str(new_spec_path))
    resolutions = resolutions if isinstance(resolutions, dict) else {}

    base_lift = lift_rp_into_spec(base_spec, base_rp_path, edited_rp_path, baseline_meta=baseline_meta, original_dsl_text=original_dsl_text)
    native_deltas = base_lift["nativePropDeltas"]
    unsupported = base_lift["unsupportedNativeChanges"]
    source_deltas = _compute_source_prop_deltas(base_spec, new_spec)

    # Native preference cannot implement unknown semantics. Source preference is
    # the explicit choice to discard those native changes.
    if unsupported and prefer != "source":
        return {
            "ok": False,
            "status": "unsupported_native_changes",
            "message": "Detected unsupported native changes in .rp; refusing to overwrite without explicit resolution.",
            "unsupportedNativeChanges": unsupported,
            "conflicts": [],
            "sourceDeltas": source_deltas,
        }

    merged_spec = copy.deepcopy(new_spec)
    _, merged_ir = compile_language(copy.deepcopy(merged_spec))
    merged_syms = {s["id"]: s for s in merged_ir.get("symbols") or []}
    merged_uses = _index_use_instances(merged_spec)
    _, base_ir = compile_language(copy.deepcopy(base_spec))
    base_syms = {s["id"]: s for s in base_ir.get("symbols") or []}
    page_id_to_name = {}
    for p in (base_spec.get("pages") or []) + (merged_spec.get("pages") or []):
        if isinstance(p, dict):
            pid = p.get("id") or p.get("slug")
            if pid:
                page_id_to_name[pid] = p.get("name") or pid

    conflicts = []
    resolved_conflicts = []
    visual_diffs = []
    raw_shape_patches = {}

    for sid, pmap in native_deltas.items():
        smap = source_deltas.get(sid) or {}
        sym_info = merged_syms.get(sid) or base_syms.get(sid) or {}
        resolved_page_name = sym_info.get("pageName") or page_id_to_name.get(sym_info.get("pageId"))
        if sid not in merged_syms:
            entry = {
                "id": sid, "pageId": sym_info.get("pageId"), "pageName": resolved_page_name,
                "pointer": sym_info.get("pointer"), "property": "__deleted__",
                "baseValue": "present", "sourceValue": "deleted", "nativeValue": pmap,
                "reason": "Source deleted this widget or its ancestor while native edited it. Restore it in source to keep native edits.",
            }
            if prefer == "source":
                entry["resolution"] = "source"
                resolved_conflicts.append(entry)
            else:
                conflicts.append(entry)
            continue
        for prop, nd in pmap.items():
            if prop in ("x", "y") and _layout_context(base_spec, base_syms[sid]) != _layout_context(new_spec, sym_info):
                entry = {"id": sid, "pageId": sym_info.get("pageId"), "pageName": resolved_page_name, "property": prop, "reason": "Source changed parent layout while native moved the widget; inverse coordinates are ambiguous."}
                if prefer == "source":
                    entry["resolution"] = "source"
                    resolved_conflicts.append(entry)
                else:
                    conflicts.append(entry)
                continue
            sd = smap.get(prop)
            is_conflict = sd is not None and sd["new"] != nd["new"]
            chosen_val = nd["new"]
            if is_conflict:
                ptr = sym_info.get("pointer") or "/"
                c_entry = {
                    "id": sid,
                    "logicalId": sym_info.get("logicalId") or sid,
                    "pageId": sym_info.get("pageId"),
                    "pageName": resolved_page_name,
                    "pointer": ptr,
                    "property": prop,
                    "propertyPath": f"{ptr.rstrip('/')}/{prop}",
                    "baseValue": nd["old"],
                    "sourceValue": sd["new"],
                    "nativeValue": nd["new"],
                    "reason": f"Property '{prop}' of widget '{sid}' was modified differently in RP/1 source ({sd['new']!r}) and native .rp ({nd['new']!r}).",
                }
                res_keys = [
                    f"{sid}.{prop}",
                    f"{sid}:{prop}",
                    f"{sym_info.get('logicalId')}.{prop}",
                    f"{sym_info.get('logicalId')}:{prop}",
                    f"{ptr.rstrip('/')}/{prop}",
                    f"{ptr}:{prop}",
                    sid,
                ]
                matched_res_key = next((rk for rk in res_keys if rk in resolutions), None)
                if matched_res_key is not None:
                    raw_res = resolutions[matched_res_key]
                    if raw_res == "source" or (isinstance(raw_res, dict) and raw_res.get("prefer") == "source"):
                        c_entry["resolution"] = "source"
                        c_entry["resolvedValue"] = sd["new"]
                        resolved_conflicts.append(c_entry)
                        continue
                    elif raw_res == "native" or (isinstance(raw_res, dict) and raw_res.get("prefer") == "native"):
                        chosen_val = nd["new"]
                        c_entry["resolution"] = "native"
                        c_entry["resolvedValue"] = nd["new"]
                        resolved_conflicts.append(c_entry)
                    else:
                        chosen_val = raw_res["value"] if isinstance(raw_res, dict) and "value" in raw_res else raw_res
                        c_entry["resolution"] = "custom"
                        c_entry["resolvedValue"] = chosen_val
                        resolved_conflicts.append(c_entry)
                elif prefer == "source":
                    c_entry["resolution"] = "source"
                    c_entry["resolvedValue"] = sd["new"]
                    resolved_conflicts.append(c_entry)
                    continue
                elif prefer == "native":
                    c_entry["resolution"] = "native"
                    c_entry["resolvedValue"] = nd["new"]
                    resolved_conflicts.append(c_entry)
                else:
                    conflicts.append(c_entry)
                    continue

            if sid in merged_syms:
                target = _resolve_ast_target(merged_spec, merged_syms[sid], merged_uses)
                applied = _apply_prop_to_target(target, merged_syms[sid], prop, chosen_val, nd["old"], coordinate_space="source")
                if not applied or applied.get("unsupported"):
                    conflicts.append({"id": sid, "pageId": sym_info.get("pageId"), "pageName": resolved_page_name, "property": prop, "reason": "Native change cannot be represented in the updated source.", "detail": applied})
                    continue
                if prop in ("x", "y", "w", "h", "fill", "stroke", "color"):
                    visual_diffs.append({"id": sid, "nativeName": nd.get("nativeName"), "changes": {prop: chosen_val}})
                    if nd.get("nativeName"):
                        patch_value = chosen_val
                        if prop in ("x", "y"):
                            patch_value = nd["nativeNew"] + chosen_val - nd["new"]
                        raw_shape_patches.setdefault(sid, {})[prop] = patch_value

    # Handle widgets deleted in native .rp
    for del_entry in base_lift.get("liftedDeletedWidgets") or []:
        sid = del_entry["id"]
        if sid not in merged_syms:
            continue  # Both sides deleted the same widget.
        sym_info = merged_syms.get(sid) or del_entry
        resolved_page_name = sym_info.get("pageName") or page_id_to_name.get(sym_info.get("pageId"))
        if sid in source_deltas:
            ptr = sym_info.get("pointer") or "/"
            c_entry = {
                "id": sid,
                "logicalId": sym_info.get("logicalId") or sid,
                "pageId": sym_info.get("pageId"),
                "pageName": resolved_page_name,
                "pointer": ptr,
                "property": "__deleted__",
                "propertyPath": ptr,
                "baseValue": "present",
                "sourceValue": source_deltas[sid],
                "nativeValue": "deleted",
                "reason": f"Widget '{sid}' was modified in RP/1 source but deleted in native .rp.",
            }
            if prefer == "source":
                c_entry["resolution"] = "source"
                resolved_conflicts.append(c_entry)
                continue
            elif prefer == "native":
                c_entry["resolution"] = "native"
                resolved_conflicts.append(c_entry)
            else:
                conflicts.append(c_entry)
                continue
        if sid in merged_syms:
            target = _resolve_ast_target(merged_spec, merged_syms[sid], merged_uses)
            if target and target["kind"] == "ast_node":
                _remove_ast_node(merged_spec, merged_syms[sid], target["node"])

    # Append newly added native widgets to their respective pages in merged_spec
    for nw_entry in base_lift.get("liftedNewWidgetsWithPage") or []:
        new_node = copy.deepcopy(nw_entry["node"])
        matches = [p for p in merged_spec.get("pages") or []
                   if (p.get("id") or p.get("slug")) == nw_entry.get("pageId")]
        if len(matches) != 1:
            entry = {"property": "__added__", "pageId": nw_entry.get("pageId"), "pageName": page_id_to_name.get(nw_entry.get("pageId")),
                     "reason": "Native addition's target page was deleted or is ambiguous."}
            if prefer == "source":
                entry["resolution"] = "source"
                resolved_conflicts.append(entry)
            else:
                conflicts.append(entry)
        else:
            t_pg = matches[0]
            nid = new_node.get("id") or next((new_node[k] for k in ("label", "button", "input", "image", "badge", "divider", "card") if k in new_node), None)
            if nid and find_ast_node_by_id(t_pg.get("root") or t_pg.get("layout"), nid):
                conflicts.append({"property": "__added__", "pageId": nw_entry.get("pageId"), "pageName": page_id_to_name.get(nw_entry.get("pageId")),
                                  "reason": f"Native addition '{nid}' collides with a source widget."})
                continue
            if isinstance(t_pg.get("layout"), list) and "root" not in t_pg:
                t_pg["layout"].append(new_node)
            elif isinstance(t_pg.get("root"), dict):
                t_pg["root"].setdefault("children", []).append(new_node)

    if conflicts:
        return {
            "ok": False,
            "status": "conflict",
            "message": f"Detected {len(conflicts)} merge conflict(s) between source and native .rp edits.",
            "conflicts": conflicts,
            "unsupportedNativeChanges": unsupported,
            "preservedVisualEdits": visual_diffs,
            "preservedTextEdits": base_lift["liftedTextEdits"],
            "preservedInteractions": base_lift["liftedInteractions"],
            "sourceDeltas": source_deltas,
        }

    dsl_text = spec_to_dsl(merged_spec)
    if original_dsl_text:
        dsl_text = preserve_rp1_comments(original_dsl_text, dsl_text)
    abs_out_spec = os.path.abspath(str(out_spec_path)) if out_spec_path else None
    abs_out_rp = os.path.abspath(str(out_rp_path)) if out_rp_path else None

    if abs_out_rp:
        fallback_src_path = (
            abs_out_spec
            or (os.path.abspath(str(new_spec_path)) if isinstance(new_spec_path, (str, Path)) else None)
            or (baseline_meta.get("sourcePath") if isinstance(baseline_meta, dict) else None)
        )
        parent_dir = os.path.dirname(abs_out_rp) or "."
        os.makedirs(parent_dir, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".rp1-merge-", dir=parent_dir) as tmp_dir:
            tmp_spec_json = os.path.join(tmp_dir, "merged.spec.json")
            tmp_out_rp = os.path.join(tmp_dir, "merged.rp")
            with open(tmp_spec_json, "w", encoding="utf-8") as f:
                json.dump(merged_spec, f, ensure_ascii=False, indent=2)
            gen_proc = subprocess.run(
                ["node", os.path.join(SCRIPT_DIR, "proto.mjs"), "generate", "--spec", tmp_spec_json, "--out-dir", tmp_dir, "--out-rp", tmp_out_rp],
                check=False,
                capture_output=True,
                text=True,
            )
            if gen_proc.returncode != 0:
                raw_err = (gen_proc.stderr or gen_proc.stdout or "").strip()
                parsed_err = None
                idx_brace = raw_err.find("{")
                end_brace = raw_err.rfind("}")
                if idx_brace >= 0 and end_brace > idx_brace:
                    try:
                        parsed_err = json.loads(raw_err[idx_brace : end_brace + 1])
                    except Exception:
                        parsed_err = None
                audit_obj = parsed_err.get("audit") if isinstance(parsed_err, dict) else None
                for af_name in ("audit-report.json", "audit.json"):
                    audit_file = os.path.join(tmp_dir, af_name)
                    if not audit_obj and os.path.exists(audit_file):
                        try:
                            with open(audit_file, "r", encoding="utf-8") as af:
                                audit_obj = json.load(af)
                        except Exception:
                            pass
                failures = (audit_obj or {}).get("failures") or []
                diags = parsed_err.get("diagnostics") if isinstance(parsed_err, dict) else None
                if failures:
                    f0 = failures[0] if isinstance(failures[0], dict) else {"detail": str(failures[0])}
                    msg = f"Merged specification failed layout audit gate '{f0.get('gate')}' on page '{f0.get('page')}': {f0.get('detail') or f0.get('id') or f0}"
                elif diags:
                    msg = f"Merged specification failed semantic validation: {diags[0].get('message')}"
                else:
                    msg = f"Merged specification failed prototype build: {raw_err[:400]}"
                return {
                    "ok": False,
                    "status": "layout_gate_failed",
                    "code": "E_MERGE_LAYOUT_GATE",
                    "message": msg,
                    "audit": audit_obj,
                    "diagnostics": diags or failures,
                    "spec": merged_spec,
                    "rp1": dsl_text,
                }
            if raw_shape_patches:
                patch_code = r"""
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
const [rpPath, patchJson] = process.argv.slice(1);
const patches = JSON.parse(patchJson);
const baseline = JSON.parse(readFileSync(`${rpPath}.baseline.json`, 'utf8'));
const patchesByKey = new Map();
for (const [sid, patch] of Object.entries(patches)) {
  const mapping = baseline.sourceMap.find(s => s.id === sid || s.logicalId === sid);
  if (!mapping?.native?.length) throw new Error(`Missing native identity for merged widget ${sid}`);
  for (const loc of mapping.native) patchesByKey.set(`${loc.record}:${loc.id}`, patch);
}
let buf = readFileSync(rpPath);
const argb = h => (0xFF000000 | parseInt(String(h).replace('#', ''), 16)) >>> 0;
const recs = readRecords(buf).filter(r => ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(r.className));
for (let i = recs.length - 1; i >= 0; i--) {
  const r = readRecords(buf).find(x => x.index === recs[i].index);
  const g = parsePayload(r);
  let dirty = false;
  for (const o of g.objects.values()) {
    if (!o.className?.startsWith('Axure:DiagramObject:')) continue;
    const p = patchesByKey.get(`${r.index}:${o.id}`);
    if (!p) continue;
    const st = g.objects.get(field(o.body, 'MyStyle')?.value);
    for (const it of field(st?.body ?? {}, 'PropList')?.items ?? []) {
      const code = field(it, 'DOAName')?.value, val = field(it, 'Value');
      if (code === 3221225478 && p.color) { field(val, 'fill-color').value = argb(p.color); dirty = true; }
      if (code === 3221225479 && p.fill) { field(val, 'fill-color').value = argb(p.fill); dirty = true; }
      if (code === 3221225480 && p.stroke) { field(val, 'fill-color').value = argb(p.stroke); dirty = true; }
      if (code === 3221225573 && (p.x !== undefined || p.y !== undefined)) {
        if (p.x !== undefined) { const xf = field(val, 'X'); xf.value = Number(p.x); delete xf.rawNumber; }
        if (p.y !== undefined) { const yf = field(val, 'Y'); yf.value = Number(p.y); delete yf.rawNumber; }
        dirty = true;
      }
      if (code === 3221225577 && (p.w !== undefined || p.h !== undefined)) {
        if (p.w !== undefined) { const wf = field(val, 'Width'); wf.value = Number(p.w); delete wf.rawNumber; }
        if (p.h !== undefined) { const hf = field(val, 'Height'); hf.value = Number(p.h); delete hf.rawNumber; }
        dirty = true;
      }
    }
  }
  if (dirty) buf = replaceRecord(buf, r, encodeRecord(r, r.strings, encodePayload(g.roots)));
}
writeFileSync(rpPath, buf);
const bPath = `${rpPath}.baseline.json`;
try {
  const bMeta = JSON.parse(readFileSync(bPath, 'utf8'));
  bMeta.rpSha256 = createHash('sha256').update(buf).digest('hex');
  bMeta.baseRpBase64 = buf.toString('base64');
  writeFileSync(bPath, JSON.stringify(bMeta, null, 2) + '\n');
} catch {}
"""
                subprocess.run(["node", "--input-type=module", "-e", patch_code, tmp_out_rp, json.dumps(raw_shape_patches)], cwd=SCRIPT_DIR, check=True)

            if abs_out_spec:
                os.makedirs(os.path.dirname(abs_out_spec) or ".", exist_ok=True)
                with open(abs_out_spec, "w", encoding="utf-8") as f:
                    if abs_out_spec.lower().endswith(".rp1"):
                        f.write(dsl_text)
                    else:
                        json.dump(merged_spec, f, ensure_ascii=False, indent=2)
                        f.write("\n")

            os.makedirs(os.path.dirname(abs_out_rp) or ".", exist_ok=True)
            shutil.move(tmp_out_rp, abs_out_rp)
            tmp_bpath = f"{tmp_out_rp}.baseline.json"
            if os.path.exists(tmp_bpath):
                try:
                    with open(tmp_bpath, "r", encoding="utf-8") as bf:
                        bmeta = json.load(bf)
                    bmeta["outputRp"] = abs_out_rp
                    if fallback_src_path:
                        bmeta["sourcePath"] = fallback_src_path
                        if os.path.exists(fallback_src_path):
                            with open(fallback_src_path, "rb") as sf:
                                bmeta["sourceSha256"] = hashlib.sha256(sf.read()).hexdigest()
                    with open(f"{abs_out_rp}.baseline.json", "w", encoding="utf-8") as bf:
                        json.dump(bmeta, bf, ensure_ascii=False, indent=2)
                        bf.write("\n")
                except Exception:
                    shutil.move(tmp_bpath, f"{abs_out_rp}.baseline.json")
    elif abs_out_spec:
        os.makedirs(os.path.dirname(abs_out_spec) or ".", exist_ok=True)
        with open(abs_out_spec, "w", encoding="utf-8") as f:
            if abs_out_spec.lower().endswith(".rp1"):
                f.write(dsl_text)
            else:
                json.dump(merged_spec, f, ensure_ascii=False, indent=2)
                f.write("\n")

    return {
        "ok": True,
        "status": "merged",
        "spec": merged_spec,
        "rp1": dsl_text,
        "outSpec": os.path.abspath(str(out_spec_path)) if out_spec_path else None,
        "outRp": os.path.abspath(str(out_rp_path)) if out_rp_path else None,
        "conflicts": [],
        "resolvedConflicts": resolved_conflicts,
        "unsupportedNativeChanges": unsupported,
        "preservedVisualEdits": visual_diffs,
        "preservedTextEdits": base_lift["liftedTextEdits"],
        "preservedRenames": base_lift["liftedRenames"],
        "preservedInteractions": base_lift["liftedInteractions"],
        "addedWidgets": base_lift["liftedNewWidgets"],
        "deletedWidgets": base_lift["liftedDeletedWidgets"],
        "componentInstanceChanges": base_lift["liftedComponentInstances"],
        "sourceDeltas": source_deltas,
    }
