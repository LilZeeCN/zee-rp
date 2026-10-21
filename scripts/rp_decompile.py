"""Binary .rp to RP/1 (.json / .rp1) Decompiler and 3-Way Binary GUI Interaction Lifter."""
import copy
import json
import os
import re
import subprocess
from pathlib import Path

from rp_dsl import spec_to_dsl

SCRIPT_DIR = Path(__file__).resolve().parent
RP_READ_MJS = SCRIPT_DIR / "rp-read.mjs"

INTERNAL_VAR_RE = re.compile(r"^(OnLoadVariable|rp1_agg_.+|rp1_caller_\d+|rp1_bop_.+|__rp_.+|.+_filter_idx)$", re.IGNORECASE)
HASH_SUFFIX_RE = re.compile(r"^(?:txt|btn|badge|inp|grp|card|panel|rep|div|img)-(.+)-[0-9a-f]{12}$")


def read_rp_json(rp_path_or_dict):
    """Run rp-read.mjs --json on a binary .rp path or return an already parsed dict."""
    if isinstance(rp_path_or_dict, dict):
        return rp_path_or_dict
    rp_path = str(Path(rp_path_or_dict).resolve())
    proc = subprocess.run(
        ["node", str(RP_READ_MJS), "--json", rp_path],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"rp-read.mjs failed on {rp_path}: {proc.stderr or proc.stdout}")
    return json.loads(proc.stdout)


def _logical_id_from_native_name(native_name, fallback_idx=1):
    if not isinstance(native_name, str) or not native_name.strip():
        return f"w_{fallback_idx}"
    m = HASH_SUFFIX_RE.match(native_name.strip())
    raw = m.group(1) if m else native_name.strip()
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", raw)
    if not cleaned or not re.match(r"^[A-Za-z_]", cleaned):
        cleaned = "w_" + cleaned
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
    if wname.startswith("btn-") or "btn" in wname:
        return "button"
    if wname.startswith("badge-"):
        return "badge"
    if wname.startswith("card-"):
        return "card"
    return "label"


def _lift_human_action(act, name_to_logical):
    """Lift an Axure native action summary from rp-read --json into an RP/1 AST action."""
    if not isinstance(act, dict):
        return None
    atype = str(act.get("type") or "")
    human = str(act.get("human") or "")
    if atype in ("set-variable", "setVariableValue"):
        m = (
            re.search(r"设置全局变量\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\"(.*)\"$", human)
            or re.search(r"Set value of\s+([A-Za-z_][A-Za-z0-9_-]*)\s+equal to\s+\"(.*)\"$", human, re.IGNORECASE)
        )
        if m:
            vname, raw_val = m.group(1), m.group(2)
            if INTERNAL_VAR_RE.match(vname):
                return None
            if raw_val.isdigit():
                val = int(raw_val)
            elif raw_val in ("true", "false"):
                val = raw_val == "true"
            else:
                val = raw_val
            return {"type": "set-variable", "variable": vname, "value": val}
    if atype in ("set-rich-text", "setText"):
        m = (
            re.search(r"设置富文本\s+(\S+)\s*=\s*\"(.*)\"$", human)
            or re.search(r"Set text on\s+(\S+)\s+equal to\s+\"(.*)\"$", human, re.IGNORECASE)
        )
        if m:
            target_native, raw_txt = m.group(1), m.group(2)
            target_id = name_to_logical.get(target_native, _logical_id_from_native_name(target_native))
            return {"type": "set-text", "target": target_id, "text": raw_txt}
    if atype in ("set-panel-state", "setPanelState"):
        m = (
            re.search(r"设置面板状态\s+(\S+)\s*→\s*(\S+)", human)
            or re.search(r"Set\s+(\S+)\s+to\s+(\S+)", human, re.IGNORECASE)
        )
        if m:
            panel_native, state_name = m.group(1), m.group(2)
            panel_id = name_to_logical.get(panel_native, _logical_id_from_native_name(panel_native))
            return {"type": "set-panel-state", "target": panel_id, "state": state_name}
    if atype in ("show", "hide", "toggle", "fadeWidget"):
        m = (
            re.search(r"(?:显示|隐藏|切换)\s+(\S+)", human)
            or re.search(r"^(Show|Hide|Toggle)\s+(\S+)", human, re.IGNORECASE)
        )
        if m:
            if m.lastindex == 2:
                verb = m.group(1).lower()
                t_native = m.group(2)
            else:
                verb = "hide" if "隐藏" in human else ("toggle" if "切换" in human else "show")
                t_native = m.group(1)
            return {verb: name_to_logical.get(t_native, _logical_id_from_native_name(t_native))}
    if atype in ("open-link", "openLink"):
        m = (
            re.search(r"打开链接\s*→\s*(\S+)", human)
            or re.search(r"Open\s+(\S+)", human, re.IGNORECASE)
        )
        if m:
            return {"goto": _logical_id_from_native_name(m.group(1))}
    return None


def _lift_widget_events(w, name_to_logical):
    events_out = {}
    for ix in w.get("interactions") or []:
        ev_type = str(ix.get("eventType") or "")
        ev_key = {
            "OnClick": "click",
            "OnTextChange": "change",
            "OnLoad": "load",
            "OnFocus": "focus",
            "OnLostFocus": "blur",
            "OnMouseEnter": "mouseover",
            "OnMouseOut": "mouseout",
            "OnPanelStateChange": "statechange",
        }.get(ev_type)
        if not ev_key:
            continue
        lifted_cases = []
        for c in ix.get("cases") or []:
            acts = []
            for a in c.get("actions") or []:
                la = _lift_human_action(a, name_to_logical)
                if la is not None:
                    acts.append(la)
            if acts:
                lifted_cases.append({"actions": acts})
        if len(lifted_cases) == 1:
            events_out[ev_key] = lifted_cases[0]["actions"]
        elif len(lifted_cases) > 1:
            for idx, lc in enumerate(lifted_cases):
                if idx < len(lifted_cases) - 1:
                    lc["when"] = True
                else:
                    lc["else"] = True
            events_out[ev_key] = {"cases": lifted_cases}
    return events_out


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

    pages = []
    for p_idx, p in enumerate(rp_data.get("pages") or []):
        pname = str(p.get("name") or f"page_{p_idx+1}")
        pid = _logical_id_from_native_name(pname, p_idx + 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", pid):
            pid = f"page_{p_idx+1}"
        raw_widgets = p.get("widgets") or []
        name_to_logical = {}
        used_ids = {"root"}
        for w_idx, w in enumerate(raw_widgets):
            wname = str(w.get("name") or "")
            if not wname or wname.startswith(("frame-", "bg-", "rep-")) or w.get("type") == "Layer":
                continue
            cand = _logical_id_from_native_name(wname, w_idx + 1)
            base_cand = cand
            seq = 2
            while cand in used_ids:
                cand = f"{base_cand}_{seq}"
                seq += 1
            used_ids.add(cand)
            name_to_logical[wname] = cand

        children = []
        max_r, max_b = 375, 812
        for w_idx, w in enumerate(raw_widgets):
            wname = str(w.get("name") or "")
            if not wname or wname.startswith(("frame-", "bg-", "rep-")) or w.get("type") in ("Layer", "Repeater", "DynamicPanel"):
                continue
            lid = name_to_logical.get(wname, f"w_{w_idx+1}")
            kind = _infer_widget_kind(w)
            x = int(round(float(w.get("x") or 0)))
            y = int(round(float(w.get("y") or 0)))
            width = max(24, int(round(float(w.get("w") or 120))))
            height = max(20, int(round(float(w.get("h") or 28))))
            max_r = max(max_r, x + width + 24)
            max_b = max(max_b, y + height + 24)
            node = {
                "type": kind,
                "id": lid,
                "w": width,
                "h": height,
            }
            if kind == "input":
                node["value"] = str(w.get("text") or "")
            else:
                node["text"] = str(w.get("text") or lid)
            ev_map = _lift_widget_events(w, name_to_logical)
            if ev_map:
                node["on"] = ev_map
            children.append(node)

        if not children:
            children.append({"type": "label", "id": "empty_lbl", "text": pname, "w": 200, "h": 24})

        pages.append({
            "id": pid,
            "name": pname,
            "canvas": {"w": max_r, "h": max(max_b, len(children) * 44 + 64)},
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
    for k in ("id", "as", "button", "label", "badge", "input", "card", "box", "row", "column"):
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


def lift_rp_into_spec(base_spec, base_rp_path_or_dict, gui_rp_path_or_dict=None, rp_json_override=None):
    """
    3-Way Binary .rp Lifter:
    Compares baseline binary .rp against GUI-edited binary .rp and lifts:
      1. Modified widget text & geometry (`text`, `x`, `y`, `w`, `h`)
      2. Newly added GUI widgets into page layout/root children
      3. Newly added or modified GUI interactions (`OnClick` -> `set-text`, `set-variable`, `set-panel-state`, `show`, `hide`)
    back into `base_spec` (preserving all high-level RP/1 semantics, computed variables, rules, and repeaters).
    """
    merged = copy.deepcopy(base_spec)
    base_rp = read_rp_json(base_rp_path_or_dict)
    gui_rp = read_rp_json(rp_json_override if rp_json_override is not None else gui_rp_path_or_dict)

    base_pages = base_rp.get("pages") or []
    gui_pages = gui_rp.get("pages") or []

    base_widgets = {}
    for p in base_pages:
        for w in p.get("widgets") or []:
            if w.get("name"):
                base_widgets[w["name"]] = w

    gui_widgets = {}
    for p in gui_pages:
        for w in p.get("widgets") or []:
            if w.get("name"):
                gui_widgets[w["name"]] = w

    name_to_logical = {
        wname: _logical_id_from_native_name(wname)
        for wname in set(base_widgets) | set(gui_widgets)
    }

    lifted_text_edits = []
    lifted_interactions = []
    lifted_new_widgets = []

    for wname, gw in gui_widgets.items():
        if wname.startswith(("frame-", "bg-", "rep-")) or gw.get("type") == "Layer":
            continue
        lid = name_to_logical[wname]
        bw = base_widgets.get(wname)
        if bw is None:
            # Brand-new widget added in Axure GUI!
            kind = _infer_widget_kind(gw)
            new_item = {
                kind: lid,
                "text": str(gw.get("text") or lid),
                "w": max(24, int(round(float(gw.get("w") or 100)))),
                "h": max(20, int(round(float(gw.get("h") or 28)))),
            }
            ev_map = _lift_widget_events(gw, name_to_logical)
            if ev_map:
                new_item["on"] = ev_map
                for ev_k, ev_acts in ev_map.items():
                    lifted_interactions.append({"id": lid, "event": ev_k, "actions": ev_acts})
            if isinstance(merged.get("pages"), list) and merged["pages"]:
                pg0 = merged["pages"][0]
                if isinstance(pg0.get("layout"), list):
                    pg0["layout"].append(new_item)
                elif isinstance(pg0.get("root"), dict):
                    pg0["root"].setdefault("children", []).append(new_item)
            lifted_new_widgets.append(new_item)
            continue

        # Check text modification
        if gw.get("text") is not None and gw.get("text") != bw.get("text"):
            for pg in merged.get("pages") or []:
                ast_node = find_ast_node_by_id(pg.get("root") or pg.get("layout"), lid)
                if ast_node is not None:
                    tkey = "value" if ast_node.get("type") == "input" or "input" in ast_node else "text"
                    if isinstance(ast_node.get(tkey), str) and "${" not in ast_node[tkey] and not ast_node[tkey].startswith("="):
                        ast_node[tkey] = str(gw["text"])
                        lifted_text_edits.append({"id": lid, "oldText": bw.get("text"), "newText": gw.get("text")})

        # Check interaction modification/addition in GUI
        base_ix_dump = json.dumps(bw.get("interactions") or [], sort_keys=True, ensure_ascii=False)
        gui_ix_dump = json.dumps(gw.get("interactions") or [], sort_keys=True, ensure_ascii=False)
        if gui_ix_dump != base_ix_dump:
            ev_map = _lift_widget_events(gw, name_to_logical)
            if ev_map:
                for pg in merged.get("pages") or []:
                    ast_node = find_ast_node_by_id(pg.get("root") or pg.get("layout"), lid)
                    if ast_node is not None:
                        for pop_k in ("onClick", "onChange", "onLoad"):
                            ast_node.pop(pop_k, None)
                        ast_node["on"] = ev_map
                        lifted_interactions.append({"id": lid, "events": ev_map})

    dsl_text = spec_to_dsl(merged)
    return {
        "ok": True,
        "spec": merged,
        "dsl": dsl_text,
        "rp1": dsl_text,
        "report": {
            "updatedTexts": lifted_text_edits,
            "addedWidgets": lifted_new_widgets,
            "liftedInteractions": lifted_interactions,
        },
        "liftedTextEdits": lifted_text_edits,
        "liftedInteractions": lifted_interactions,
        "liftedNewWidgets": lifted_new_widgets,
    }


def extract_rp_visual_props(rp_path):
    """Extract per-widget MyStyle visual props (fill, color, stroke, x, y, w, h) from a binary .rp file."""
    node_code = r"""
import { readFileSync } from 'node:fs';
import { readRecords } from './rp-records.mjs';
import { parsePayload, field } from './parse-payload.mjs';
const buf = readFileSync(process.argv[1]);
const recs = readRecords(buf).filter(r => ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(r.className));
const hex = v => (typeof v === 'number' && v > 0) ? '#' + (v & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0') : null;
const out = {};
for (const r of recs) {
  const g = parsePayload(r);
  for (const o of g.objects.values()) {
    if (!o.className?.startsWith('Axure:DiagramObject:')) continue;
    const wname = field(field(o.body, 'name-block') ?? {}, 'text')?.text;
    if (!wname) continue;
    const st = g.objects.get(field(o.body, 'MyStyle')?.value);
    const props = {};
    for (const it of field(st?.body ?? {}, 'PropList')?.items ?? []) {
      const code = field(it, 'DOAName')?.value, val = field(it, 'Value');
      if (code === 3221225478) props.color = hex(field(val ?? {}, 'fill-color')?.value);
      if (code === 3221225479) props.fill = hex(field(val ?? {}, 'fill-color')?.value);
      if (code === 3221225480) props.stroke = hex(field(val ?? {}, 'fill-color')?.value);
      if (code === 3221225573) { props.x = field(val ?? {}, 'X')?.value; props.y = field(val ?? {}, 'Y')?.value; }
      if (code === 3221225577) { props.w = field(val ?? {}, 'Width')?.value; props.h = field(val ?? {}, 'Height')?.value; }
    }
    out[wname] = props;
  }
}
console.log(JSON.stringify(out));
"""
    res = subprocess.run(["node", "--input-type=module", "-e", node_code, os.path.abspath(rp_path)], cwd=SCRIPT_DIR, capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def three_way_merge_rp(base_spec_path, base_rp_path, edited_rp_path, new_spec_path, out_spec_path, out_rp_path=None):
    """Three-way merge: preserve designer manual edits (color, fill, stroke, x, y, w, h, text, interactions) in edited.rp while applying new_spec changes."""
    from proto import read_source
    from rp_language import compile_language
    base_spec = read_source(base_spec_path)
    new_spec = read_source(new_spec_path)
    merged_res = lift_rp_into_spec(new_spec, base_rp_path, edited_rp_path)
    merged_spec = merged_res["spec"]
    _, base_ir = compile_language(copy.deepcopy(base_spec))
    sym_by_emit = {s["name"]: s for s in base_ir.get("symbols", [])}
    base_props = extract_rp_visual_props(base_rp_path)
    edit_props = extract_rp_visual_props(edited_rp_path)
    visual_diffs = []
    raw_shape_patches = {}
    for wname, ep in edit_props.items():
        bp = base_props.get(wname, {})
        changed = {k: v for k, v in ep.items() if v is not None and bp.get(k) != v}
        if not changed:
            continue
        raw_shape_patches[wname] = changed
        core = wname[3:] if wname.startswith("bg-") else (wname[6:] if wname.startswith("frame-") else wname)
        sym = sym_by_emit.get(core)
        lid = sym["id"].rsplit("/", 1)[-1] if sym else _logical_id_from_native_name(core)
        for pg in merged_spec.get("pages") or []:
            ast_node = find_ast_node_by_id(pg.get("root") or pg.get("layout"), lid)
            if ast_node is not None:
                for k, v in changed.items():
                    ast_node[k] = int(round(v)) if k in ("x", "y", "w", "h") and isinstance(v, (int, float)) else v
                visual_diffs.append({"id": lid, "nativeName": wname, "changes": changed})
                break
    os.makedirs(os.path.dirname(os.path.abspath(out_spec_path)) or ".", exist_ok=True)
    with open(out_spec_path, "w", encoding="utf-8") as f:
        json.dump(merged_spec, f, ensure_ascii=False, indent=2)
    if out_rp_path:
        import tempfile
        with tempfile.TemporaryDirectory(prefix="rp1-merge-") as tmp_dir:
            if os.path.exists(out_rp_path):
                os.remove(out_rp_path)
            subprocess.run(["node", os.path.join(SCRIPT_DIR, "proto.mjs"), "generate", "--spec", os.path.abspath(out_spec_path), "--out-dir", tmp_dir, "--out-rp", os.path.abspath(out_rp_path)], check=True, capture_output=True, text=True)
        if raw_shape_patches:
            patch_code = r"""
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
const [rpPath, patchJson] = process.argv.slice(1);
const patches = JSON.parse(patchJson);
let buf = readFileSync(rpPath);
const argb = h => (0xFF000000 | parseInt(String(h).replace('#', ''), 16)) >>> 0;
const recs = readRecords(buf).filter(r => ['Axure:Page', 'Axure:PanelState', 'Axure:Master'].includes(r.className));
for (let i = recs.length - 1; i >= 0; i--) {
  const r = readRecords(buf).find(x => x.index === recs[i].index);
  const g = parsePayload(r);
  let dirty = false;
  for (const o of g.objects.values()) {
    if (!o.className?.startsWith('Axure:DiagramObject:')) continue;
    const wname = field(field(o.body, 'name-block') ?? {}, 'text')?.text;
    const p = patches[wname];
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
"""
            subprocess.run(["node", "--input-type=module", "-e", patch_code, os.path.abspath(out_rp_path), json.dumps(raw_shape_patches)], cwd=SCRIPT_DIR, check=True)
    return {
        "ok": True,
        "outSpec": os.path.abspath(out_spec_path),
        "outRp": os.path.abspath(out_rp_path) if out_rp_path else None,
        "preservedVisualEdits": visual_diffs,
        "preservedTextEdits": merged_res["liftedTextEdits"],
        "preservedInteractions": merged_res["liftedInteractions"],
    }
