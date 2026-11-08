# 从 scripts/proto.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 1;行为不变,勿手改)。
import base64
import copy
import hashlib
import io
import json
import math
import os
import re
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, RADIUS_TOKENS, SPACING_TOKENS
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
from .fonts import ASSETS_SPEC_DIR, load_font, load_image_asset, measure_text, wrap_text
from .tokens import hex_to_rgb_float, hex_to_rgba_tuple, parse_padding, resolve_color, snap_token

# -------------------- 3. TWO-PASS AUTO-LAYOUT ENGINE & DUAL EMITTER --------------------
def expand_inline_primitives(node, base_dir=None, available_w=None):
    """在 measure_node 之前将 paragraph 与 placeholder 展开为带精确子节点的容器。"""
    ntype = node.get("type", "box")
    name = node.get("name", "node")
    if ntype == "paragraph" or "_paragraph" in node:
        # Keep the source until a parent has allocated the actual width.  A fill
        # paragraph may be measured again after row/grid allocation.
        source = node.setdefault("_paragraph", {k: v for k, v in node.items() if not k.startswith("_") or k == "_rp1_single_shape"})
        fsz = snap_token(source.get("fontSize", source.get("size", 12)), FONT_SIZE_TOKENS)
        fwt = snap_token(source.get("fontWeight", source.get("weight", 400)), FONT_WEIGHT_TOKENS)
        raw_w = source.get("w")
        max_w = int(available_w) if available_w is not None else resolve_size(raw_w, 320, "w")
        para_pt, para_pr, para_pb, para_pl = parse_padding(source.get("padding", 0))
        lines = wrap_text(source.get("text", ""), max(1, max_w - para_pl - para_pr - 4), fsz, fwt)
        max_lines = source.get("maxLines")
        if max_lines and len(lines) > int(max_lines):
            lines = lines[:int(max_lines)]
            if lines[-1]:
                lines[-1] = lines[-1][:-1] + "…"
        # lineHeight is an explicit line box. lineGap is additional clear space
        # between ink-height line boxes; it was historically misread as height.
        line_gap = 0
        if source.get("lineHeight") is not None:
            line_h = resolve_size(source["lineHeight"], 18, "lineHeight")
        elif source.get("lineGap") is not None:
            line_gap = resolve_size(source["lineGap"], 0, "lineGap")
            font = load_font(fsz, fwt)
            line_h = max((font.getbbox(ln)[3] - font.getbbox(ln)[1] for ln in lines if ln.strip()), default=fsz)
        else:
            line_h = max(18, int(round(fsz * 1.55)))
        if line_h <= 0 or line_gap < 0:
            raise ValueError(f"paragraph '{name}': lineHeight must be positive and lineGap non-negative")
        content_h = max(line_h, len(lines) * line_h + max(0, len(lines) - 1) * line_gap) + para_pt + para_pb
        if source.get("_rp1_single_shape"):
            node["type"] = "label"
            node["wrap"] = True
            node["isGroup"] = False
            node.pop("children", None)
            node["fontSize"] = fsz
            node["fontWeight"] = fwt
            node["color"] = source.get("color", "$ink-2")
            node["align"] = source.get("align", "left")
            if max_lines and len(lines) >= int(max_lines):
                node["text"] = "\n".join(lines)
            else:
                node["text"] = str(source.get("text", ""))
            node["w"] = raw_w if raw_w is not None else max_w
            node["h"] = source.get("h") if (source.get("h") is not None and not is_hug(source.get("h"))) else content_h
            node["_is_single_paragraph"] = True
            node["_paragraph_mw"] = int(available_w) if available_w is not None else resolve_size(raw_w, max_w, "w")
            node["_paragraph_mh"] = resolve_size(source.get("h"), content_h, "h")
            node["_paragraph_needed_h"] = content_h
            node["_expanded"] = True
            return
        children = []
        for idx, ln in enumerate(lines):
            children.append({
                "type": "label", "name": f"{name}-l{idx+1}", "text": ln,
                "fontSize": fsz, "fontWeight": fwt,
                "color": source.get("color", "$ink-2"), "align": source.get("align", "left"),
                "w": "fill", "h": line_h,
            })
        node["type"] = "box"
        node["layout"] = "column"
        node["gap"] = line_gap
        node["_paragraphGap"] = line_gap  # typographic spacing is not snapped to design tokens
        node["w"] = raw_w if raw_w is not None else max_w
        node["h"] = source.get("h") if source.get("h") is not None else content_h
        node["isGroup"] = bool(source.get("isGroup", True))
        node["children"] = children
        node["_expanded"] = True
    elif ntype == "placeholder" and not node.get("_expanded"):
        raw_w, raw_h = node.get("w"), node.get("h")
        pw = resolve_size(raw_w, 120, "w")
        ph = resolve_size(raw_h, 80, "h")
        cap = node.get("caption", node.get("text", "图片占位"))
        cross = min(24, max(14, min(pw, ph) // 3))
        cross_h = int(round(cross * 1.4))
        ch_list = [
            {
                "type": "label",
                "name": f"{name}-x",
                "text": "×",
                "w": "fill" if is_fill(raw_w) else pw - 8,
                "h": cross_h,
                "fontSize": snap_token(cross, FONT_SIZE_TOKENS),
                "fontWeight": 400,
                "color": "$line-strong",
                "align": "center",
            },
        ]
        if cap:
            ch_list.append({
                "type": "label",
                "name": f"{name}-cap",
                "text": str(cap),
                "w": "fill" if is_fill(raw_w) else pw - 8,
                "h": 16,
                "fontSize": 11,
                "fontWeight": 400,
                "color": "$ink-3",
                "align": "center",
            })
        node["type"] = "box"
        node["layout"] = "column"
        node["align"] = "center"
        node["justify"] = "center"
        node["gap"] = 4
        node["w"] = "fill" if is_fill(raw_w) else pw
        node["h"] = "fill" if is_fill(raw_h) else ph
        node["fill"] = node.get("fill", "$surface-2")
        node["stroke"] = node.get("stroke", "$line")
        node["radius"] = node.get("radius", 8)
        node["bgName"] = f"{name}-bg"
        node["isGroup"] = True
        node["children"] = ch_list
        node["_expanded"] = True


# ---- sizing tokens: "fill" / "hug" / "auto" / 数字 / None ----
SIZING_KEYWORDS = {"fill", "hug", "auto"}


def resolve_size(val, fallback, axis="w"):
    """把 sizing 关键字归一化为 int。fill/hug/auto 在 measure 阶段退回内容尺寸，
    在 layout 阶段由父容器分配（fill）或保持内容尺寸（hug/auto）。"""
    if val is None:
        return int(round(float(fallback)))
    if isinstance(val, str):
        v = val.strip().lower()
        if v in SIZING_KEYWORDS:
            return int(round(float(fallback)))
        try:
            return int(round(float(v)))
        except ValueError:
            raise ValueError(f'无效尺寸 "{val}" ({axis})：应为数字、"fill"、"hug" 或 "auto"')
    return int(round(float(val)))


def is_fill(val):
    return isinstance(val, str) and val.strip().lower() == "fill"


def is_hug(val):
    return isinstance(val, str) and val.strip().lower() in ("hug", "auto")


def _group_when_slots(children):
    """Group consecutive children that share the same _when_group into shared layout slots."""
    slots = []
    for ch in children:
        wg = ch.get("_when_group") if isinstance(ch, dict) else None
        if wg and slots and slots[-1][0].get("_when_group") == wg:
            slots[-1].append(ch)
        else:
            slots.append([ch])
    return slots


def measure_node(node, base_dir=None, available_w=None):
    """Pass 1 (Bottom-Up): 递归计算节点的固有最小宽高 (_mw, _mh)。"""
    expand_inline_primitives(node, base_dir=base_dir, available_w=available_w)
    node["_measured_for_w"] = available_w
    ntype = node.get("type", "box")
    if ntype in ("image", "icon"):
        def_s = 20 if ntype == "icon" else 24
        node["_mw"] = resolve_size(node.get("w"), def_s, "w")
        node["_mh"] = resolve_size(node.get("h"), def_s, "h")
        return node["_mw"], node["_mh"]
    if ntype == "sparkline":
        node["_mw"] = resolve_size(node.get("w"), 120, "w")
        node["_mh"] = resolve_size(node.get("h"), 36, "h")
        return node["_mw"], node["_mh"]
    if ntype == "label":
        if node.get("_is_single_paragraph"):
            node["_mw"] = node["_paragraph_mw"]
            node["_mh"] = node["_paragraph_mh"]
            return node["_mw"], node["_mh"]
        spans = node.get("spans")
        txt = "".join(str(s.get("text", "")) for s in spans) if isinstance(spans, list) and spans else node.get("text", node.get("content", ""))
        fsz = max((int(s.get("size", s.get("fontSize", 14))) for s in spans), default=14) if isinstance(spans, list) and spans else node.get("fontSize", node.get("size", 14))
        fwt = max((int(s.get("weight", s.get("fontWeight", 400))) for s in spans), default=400) if isinstance(spans, list) and spans else node.get("fontWeight", node.get("weight", 400))
        tw, th = measure_text(txt, fsz, fwt)
        spacing = float(node.get("letterSpacing") or 0)
        if spacing:
            tw += max((max(0, len(line) - 1) * spacing for line in str(txt).split("\n")), default=0)
        pad_x = 16 if (node.get("fill") or node.get("stroke")) else 0
        if (
            available_w is not None
            and available_w > 0
            and (
                node.get("wrap")
                or ((node.get("w") is None or is_fill(node.get("w"))) and (node.get("h") is None or is_hug(node.get("h"))))
            )
            and tw + pad_x > available_w
        ):
            wrap_lines = wrap_text(str(txt), max(1, int(available_w) - pad_x - 4), fsz, fwt)
            if len(wrap_lines) > 1:
                line_h = resolve_size(node["lineHeight"], 18, "lineHeight") if node.get("lineHeight") is not None else max(18, int(round(fsz * 1.45)))
                th = max(th, len(wrap_lines) * line_h + 2)
                node["wrap"] = True
        node["_mw"] = int(available_w) if (available_w is not None and is_fill(node.get("w"))) else resolve_size(node.get("w"), tw + pad_x + (2 if is_hug(node.get("w")) else 0), "w")
        node["_mh"] = resolve_size(node.get("h"), th, "h")
        return node["_mw"], node["_mh"]
    if ntype == "dynamic-panel":
        states = node.get("states") or []
        known_w = available_w
        if known_w is None and node.get("w") is not None and not (is_fill(node.get("w")) or is_hug(node.get("w"))):
            known_w = resolve_size(node["w"], 0, "w")
        max_sw, max_sh = 64, 32
        for st in states:
            st_tree = st.get("tree") if isinstance(st, dict) and "tree" in st else (st.get("root") if isinstance(st, dict) else None)
            if isinstance(st_tree, dict):
                sw, sh = measure_node(st_tree, base_dir=base_dir, available_w=known_w)
                max_sw = max(max_sw, sw)
                max_sh = max(max_sh, sh)
        node["_mw"] = int(available_w) if (available_w is not None and (is_fill(node.get("w")) or node.get("w") is None)) else resolve_size(node.get("w"), max_sw, "w")
        node["_mh"] = resolve_size(node.get("h"), max_sh, "h")
        return node["_mw"], node["_mh"]
    if ntype == "repeater":
        rows = node.get("rows") or []
        p_size = int(node.get("pageSize") or 0)
        vis_rows = min(len(rows), p_size) if (p_size > 0 and rows) else max(1, len(rows))
        row_h = int(node.get("rowHeight", 48))
        row_gap = int(node.get("rowGap", 0))
        rep_def_h = max(32, vis_rows * row_h + max(0, vis_rows - 1) * row_gap)
        node["_mw"] = int(available_w) if (available_w is not None and (is_fill(node.get("w")) or node.get("w") is None)) else resolve_size(node.get("w"), 320, "w")
        node["_mh"] = resolve_size(node.get("h"), rep_def_h, "h")
        return node["_mw"], node["_mh"]
    if ntype in ("shape-text", "native-input", "native-form"):
        spans = node.get("spans")
        txt = "".join(str(s.get("text", "")) for s in spans) if isinstance(spans, list) and spans else node.get("text", node.get("content", node.get("placeholder", "")))
        fsz = node.get("fontSize", node.get("size", 13))
        fwt = node.get("fontWeight", node.get("weight", 500))
        tw, th = measure_text(txt, fsz, fwt)
        is_badge_like = "badge" in str(node.get("name", "")) or (node.get("h") is not None and isinstance(node.get("h"), (int, float)) and node["h"] <= 26)
        min_btn_w = 36 if is_badge_like else 64
        pad_btn_w = 18 if is_badge_like else 24
        node["_mw"] = resolve_size(node.get("w"), max(min_btn_w, tw + pad_btn_w), "w")
        node["_mh"] = resolve_size(node.get("h"), max(32, th + 12), "h")
        return node["_mw"], node["_mh"]
    all_children = node.get("children", [])
    for ch in all_children:
        measure_node(ch, base_dir=base_dir)
    children = [ch for ch in all_children if not (isinstance(ch, dict) and ch.get("_hidden_lookup"))]
    pt, pr, pb, pl = parse_padding(node.get("padding", 0))
    gap = node.get("_paragraphGap", snap_token(node.get("gap", 0), SPACING_TOKENS))
    layout = node.get("layout", "column")
    slots = _group_when_slots(children) if layout in ("row", "column") else [[ch] for ch in children]
    known_w = available_w
    if known_w is None and node.get("w") is not None and not (is_fill(node.get("w")) or is_hug(node.get("w"))):
        known_w = resolve_size(node["w"], 0, "w")
    if children and known_w is not None:
        inner_w = max(0, int(known_w) - pl - pr)
        if layout == "row":
            def _slot_flex(s):
                return max((float(c.get("flex") or 0) if float(c.get("flex") or 0) > 0 else (1.0 if is_fill(c.get("w")) else 0.0)) for c in s)
            flexes = [_slot_flex(s) for s in slots]
            fixed = sum(max(c["_mw"] for c in s) for s, fl in zip(slots, flexes) if fl <= 0)
            remaining = max(0, inner_w - fixed - gap * max(0, len(slots) - 1))
            total = sum(flexes)
            used = 0
            last = max((i for i, fl in enumerate(flexes) if fl > 0), default=-1)
            for i, (slot, fl) in enumerate(zip(slots, flexes)):
                slot_w = (max(0, remaining - used) if i == last else int(round(remaining * fl / total))) if fl > 0 else max(c["_mw"] for c in slot)
                if fl > 0:
                    used += slot_w
                for child in slot:
                    c_fl = float(child.get("flex") or 0) if float(child.get("flex") or 0) > 0 else (1.0 if is_fill(child.get("w")) else 0.0)
                    measure_node(child, base_dir=base_dir, available_w=slot_w if c_fl > 0 else child["_mw"])
        elif layout == "grid":
            cols = max(1, int(node.get("columns") or 2))
            col_gap = snap_token(node.get("columnGap", node.get("gap", 0)), SPACING_TOKENS)
            cell_w = max(0, (inner_w - col_gap * max(0, cols - 1)) // cols)
            for child, _, _, _, cs in _plan_bento_grid(children, cols)[0]:
                span_w = cell_w * cs + col_gap * (cs - 1)
                width = span_w if (is_fill(child.get("w")) or child.get("w") is None or child.get("_auto_w")) else child["_mw"]
                measure_node(child, base_dir=base_dir, available_w=width)
        else:
            for child in children:
                stretch = is_fill(child.get("w")) or (layout == "column" and (node.get("align") == "stretch" or (child.get("w") is None and (child.get("type") in ("box", "dynamic-panel", "repeater") or child.get("_is_single_paragraph")))))
                measure_node(child, base_dir=base_dir, available_w=inner_w if stretch else child["_mw"])
    if not children:
        cw, ch_val = 0, 0
    elif layout == "row":
        if node.get("wrap") and known_w is not None:
            inner_w = max(1, int(known_w) - pl - pr)
            row_gap = snap_token(node.get("rowGap", gap), SPACING_TOKENS)
            lines, cur_line, cur_w = [], [], 0
            for s in slots:
                w_s = max(c["_mw"] for c in s)
                if cur_line and cur_w + gap + w_s > inner_w:
                    lines.append(cur_line)
                    cur_line, cur_w = [s], w_s
                else:
                    cur_w = cur_w + (gap if cur_line else 0) + w_s
                    cur_line.append(s)
            if cur_line:
                lines.append(cur_line)
            cw = inner_w
            ch_val = sum(max(max(c["_mh"] for c in s) for s in ln) for ln in lines) + row_gap * max(0, len(lines) - 1)
        else:
            cw = sum(max(c["_mw"] for c in s) for s in slots) + gap * max(0, len(slots) - 1)
            ch_val = max(max(c["_mh"] for c in s) for s in slots)
    elif layout == "column":
        cw = max(max(c["_mw"] for c in s) for s in slots)
        ch_val = sum(max(c["_mh"] for c in s) for s in slots) + gap * max(0, len(slots) - 1)
    elif layout == "grid":
        cols = max(1, int(node.get("columns") or 2))
        col_gap = snap_token(node.get("columnGap", node.get("gap", 0)), SPACING_TOKENS)
        row_gap = snap_token(node.get("rowGap", node.get("gap", 0)), SPACING_TOKENS)
        placements, rows = _plan_bento_grid(children, cols)
        unit_w = max((max(1, (c["_mw"] - col_gap * (cs - 1)) // cs) for c, _, _, _, cs in placements), default=0)
        cw = unit_w * cols + col_gap * max(0, cols - 1)
        row_heights = [0] * rows
        for c, r, _, rs, _ in placements:
            if rs == 1:
                row_heights[r] = max(row_heights[r], c["_mh"])
        for c, r, _, rs, _ in placements:
            if rs > 1:
                cur_h = sum(row_heights[r : r + rs]) + row_gap * (rs - 1)
                if c["_mh"] > cur_h:
                    add_h = (c["_mh"] - cur_h + rs - 1) // rs
                    for dr in range(rs):
                        row_heights[r + dr] += add_h
        ch_val = sum(row_heights) + row_gap * max(0, rows - 1)
    else:
        cw = max(c["_mw"] for c in children)
        ch_val = max(c["_mh"] for c in children)
    node["_mw"] = int(available_w) if available_w is not None else resolve_size(node.get("w"), cw + pl + pr, "w")
    node["_mh"] = resolve_size(node.get("h"), ch_val + pt + pb, "h")
    return node["_mw"], node["_mh"]


def _plan_bento_grid(children, cols):
    occupied = set()
    placements = []
    max_row = 0
    for ch in children:
        cs = max(1, min(cols, int(ch.get("colSpan") or 1)))
        rs = max(1, int(ch.get("rowSpan") or 1))
        r = 0
        placed = False
        while not placed:
            for c_idx in range(cols - cs + 1):
                if all((r + dr, c_idx + dc) not in occupied for dr in range(rs) for dc in range(cs)):
                    for dr in range(rs):
                        for dc in range(cs):
                            occupied.add((r + dr, c_idx + dc))
                    placements.append((ch, r, c_idx, rs, cs))
                    max_row = max(max_row, r + rs)
                    placed = True
                    break
            r += 1
    return placements, max(1, max_row)


def layout_node(node, x=0, y=0, w=None, h=None, _abs_pos=False, _stack_pos=False):
    """Pass 2 (Top-Down): 分配 flex/fill 空间、对齐方式并递归赋予确定性整数坐标 (_x, _y, _w, _h)。"""
    nx = int(round(x if _stack_pos else (node["x"] if (_abs_pos and "x" in node) else (x if _abs_pos else node.get("x", x)))))
    ny = int(round(y if _stack_pos else (node["y"] if (_abs_pos and "y" in node) else (y if _abs_pos else node.get("y", y)))))
    nw = int(round(w if w is not None else resolve_size(node.get("w"), node.get("_mw", 0), "w")))
    if node.get("_measured_for_w") != nw:
        measure_node(node, available_w=nw)
    nh = int(round(h if h is not None else resolve_size(node.get("h"), node.get("_mh", 0), "h")))
    node["_x"], node["_y"], node["_w"], node["_h"] = nx, ny, nw, nh
    all_children = node.get("children", [])
    if not all_children:
        return
    for hch in all_children:
        if isinstance(hch, dict) and hch.get("_hidden_lookup"):
            layout_node(hch, x=0, y=0, w=1, h=1, _abs_pos=True)
    children = [ch for ch in all_children if not (isinstance(ch, dict) and ch.get("_hidden_lookup"))]
    if not children:
        return
    if node.get("layout") == "stack":
        _kids = node.get("children") or []
        if any(isinstance(ch, dict) and "z" in ch for ch in _kids):
            # z 只对 stack 有意义：稳定排序后回写 children，绘制/装配顺序随之改变；z 转存为 _z 避免未知属性告警
            _sorted = [ch for _, ch in sorted(enumerate(_kids),
                                              key=lambda pair: (pair[1].get("z", 0) if isinstance(pair[1], dict) else 0, pair[0]))]
            for _ch in _sorted:
                if isinstance(_ch, dict) and "z" in _ch:
                    _ch["_z"] = _ch.pop("z")
            node["children"] = _sorted
            children = [ch for ch in _sorted if not (isinstance(ch, dict) and ch.get("_hidden_lookup"))]
    pt, pr, pb, pl = parse_padding(node.get("padding", 0))
    gap = node.get("_paragraphGap", snap_token(node.get("gap", 0), SPACING_TOKENS))
    layout = node.get("layout", "column")
    slots = _group_when_slots(children) if layout in ("row", "column") else [[ch] for ch in children]
    align = node.get("align", "start")
    if isinstance(align, str):
        align = {"flex-start": "start", "flex-end": "end", "top": "start", "bottom": "end", "left": "start", "right": "end", "middle": "center"}.get(align.strip().lower(), align)
    justify = node.get("justify", "start")
    if isinstance(justify, str):
        justify = {"between": "space-between", "space_between": "space-between", "around": "space-around", "space_around": "space-around", "evenly": "space-evenly", "space_evenly": "space-evenly", "flex-start": "start", "flex-end": "end", "left": "start", "right": "end", "middle": "center"}.get(justify.strip().lower(), justify)
    inner_x = nx + pl
    inner_y = ny + pt
    inner_w = max(0, nw - pl - pr)
    inner_h = max(0, nh - pt - pb)
    if layout == "row":
        if node.get("wrap") and inner_w > 0:
            row_gap = snap_token(node.get("rowGap", gap), SPACING_TOKENS)
            lines, cur_line, cur_w = [], [], 0
            for s in slots:
                w_s = max(resolve_size(c.get("w"), c["_mw"], "w") for c in s)
                if cur_line and cur_w + gap + w_s > inner_w:
                    lines.append(cur_line)
                    cur_line, cur_w = [s], w_s
                else:
                    cur_w = cur_w + (gap if cur_line else 0) + w_s
                    cur_line.append(s)
            if cur_line:
                lines.append(cur_line)
            cy_line = inner_y
            for ln in lines:
                lh = max(max(resolve_size(c.get("h"), c["_mh"], "h") for c in s) for s in ln)
                cx_line = inner_x
                for s in ln:
                    slot_w = max(resolve_size(c.get("w"), c["_mw"], "w") for c in s)
                    for c in s:
                        cw = resolve_size(c.get("w"), c["_mw"], "w")
                        ch_val = lh if (is_fill(c.get("h")) or align == "stretch") else resolve_size(c.get("h"), c["_mh"], "h")
                        cy = cy_line + (lh - ch_val) // 2 if align == "center" else (cy_line + lh - ch_val if align == "end" else cy_line)
                        layout_node(c, cx_line, cy, cw, ch_val, _abs_pos=True)
                    cx_line += slot_w + gap
                cy_line += lh + row_gap
            return

        def _row_eff_flex(c):
            if c.get("flex") is not None and float(c.get("flex") or 0) > 0:
                return float(c.get("flex"))
            return 1.0 if is_fill(c.get("w")) else 0.0

        eff_flexes = [max(_row_eff_flex(c) for c in s) for s in slots]
        fixed_w = sum(max(c["_mw"] for c in s) for s, fl in zip(slots, eff_flexes) if fl <= 0)
        flex_total = sum(fl for fl in eff_flexes if fl > 0)
        total_gaps = gap * max(0, len(slots) - 1)
        rem_w = max(0, inner_w - fixed_w - total_gaps)
        free_w = max(0, inner_w - fixed_w)
        cx = inner_x
        step_gap = float(gap)
        if flex_total == 0:
            if justify == "end":
                cx = inner_x + rem_w
            elif justify == "center":
                cx = inner_x + rem_w // 2
            elif justify == "space-between" and len(slots) > 1:
                step_gap = max(float(gap), free_w / float(len(slots) - 1))
            elif justify == "space-around" and len(slots) > 0:
                step_gap = max(float(gap), free_w / float(len(slots)))
                cx = inner_x + int(round(step_gap / 2.0))
            elif justify == "space-evenly" and len(slots) > 0:
                step_gap = max(float(gap), free_w / float(len(slots) + 1))
                cx = inner_x + int(round(step_gap))
        flex_indices = [idx for idx, fl in enumerate(eff_flexes) if fl > 0]
        allocated_flex_w = 0
        cx_float = float(cx)
        for idx, (slot, fl) in enumerate(zip(slots, eff_flexes)):
            if fl > 0 and flex_total > 0:
                if idx == flex_indices[-1]:
                    slot_w = max(0, rem_w - allocated_flex_w)
                else:
                    slot_w = int(round(rem_w * (fl / flex_total)))
                    allocated_flex_w += slot_w
            else:
                slot_w = max(resolve_size(c.get("w"), c["_mw"], "w") for c in slot)
            cur_cx = (inner_x + inner_w - slot_w) if (flex_total == 0 and justify == "space-between" and len(slots) > 1 and idx == len(slots) - 1) else int(round(cx_float))
            for c in slot:
                c_fl = _row_eff_flex(c)
                cw = slot_w if (c_fl > 0 and flex_total > 0) else resolve_size(c.get("w"), c["_mw"], "w")
                auto_stretch_card = (
                    is_fill(c.get("h"))
                    or align == "stretch"
                    or bool(node.get("equalHeight"))
                    or (align == "start" and c.get("h") is None and c.get("type") == "box" and c_fl > 0 and bool(c.get("fill") or c.get("stroke")))
                )
                ch_val = inner_h if auto_stretch_card else resolve_size(c.get("h"), c["_mh"], "h")
                if align == "center":
                    cy = inner_y + (inner_h - ch_val) // 2
                elif align == "end":
                    cy = inner_y + inner_h - ch_val
                else:
                    cy = inner_y
                branch_cx = cur_cx + (slot_w - cw) if justify == "end" else (cur_cx + (slot_w - cw) // 2 if justify == "center" else cur_cx)
                if isinstance(c.get("x"), (int, float)):
                    branch_cx = int(round(c["x"]))
                if isinstance(c.get("y"), (int, float)):
                    cy = int(round(c["y"]))
                layout_node(c, branch_cx, cy, cw, ch_val, _abs_pos=True)
            cx_float += slot_w + step_gap
    elif layout == "column":
        def _col_eff_flex(c):
            if c.get("flex") is not None and float(c.get("flex") or 0) > 0:
                return float(c.get("flex"))
            return 1.0 if is_fill(c.get("h")) else 0.0

        eff_flexes = [max(_col_eff_flex(c) for c in s) for s in slots]
        fixed_h = sum(max(c["_mh"] for c in s) for s, fl in zip(slots, eff_flexes) if fl <= 0)
        flex_total = sum(fl for fl in eff_flexes if fl > 0)
        total_gaps = gap * max(0, len(slots) - 1)
        rem_h = max(0, inner_h - fixed_h - total_gaps)
        free_h = max(0, inner_h - fixed_h)
        cy = inner_y
        step_gap = float(gap)
        if flex_total == 0:
            if justify == "end":
                cy = inner_y + rem_h
            elif justify == "center":
                cy = inner_y + rem_h // 2
            elif justify == "space-between" and len(slots) > 1:
                step_gap = max(float(gap), free_h / float(len(slots) - 1))
            elif justify == "space-around" and len(slots) > 0:
                step_gap = max(float(gap), free_h / float(len(slots)))
                cy = inner_y + int(round(step_gap / 2.0))
            elif justify == "space-evenly" and len(slots) > 0:
                step_gap = max(float(gap), free_h / float(len(slots) + 1))
                cy = inner_y + int(round(step_gap))
        flex_indices = [idx for idx, fl in enumerate(eff_flexes) if fl > 0]
        allocated_flex_w = 0
        allocated_flex_h = 0
        cy_float = float(cy)
        for idx, (slot, fl) in enumerate(zip(slots, eff_flexes)):
            if fl > 0 and flex_total > 0:
                if idx == flex_indices[-1]:
                    slot_h = max(0, rem_h - allocated_flex_h)
                else:
                    slot_h = int(round(rem_h * (fl / flex_total)))
                    allocated_flex_h += slot_h
            else:
                slot_h = max(resolve_size(c.get("h"), c["_mh"], "h") for c in slot)
            cur_cy = (inner_y + inner_h - slot_h) if (flex_total == 0 and justify == "space-between" and len(slots) > 1 and idx == len(slots) - 1) else int(round(cy_float))
            for c in slot:
                c_fl = _col_eff_flex(c)
                ch_val = slot_h if (c_fl > 0 and flex_total > 0) else resolve_size(c.get("h"), c["_mh"], "h")
                stretch_w = (
                    is_fill(c.get("w"))
                    or align == "stretch"
                    or (c.get("w") is None and (c.get("type") in ("box", "dynamic-panel", "repeater") or c.get("_is_single_paragraph")) and not is_hug(c.get("w")))
                )
                cw = inner_w if stretch_w else resolve_size(c.get("w"), c["_mw"], "w")
                if align == "center":
                    cx = inner_x + (inner_w - cw) // 2
                elif align == "end":
                    cx = inner_x + inner_w - cw
                else:
                    cx = inner_x
                branch_cy = cur_cy + (slot_h - ch_val) if justify == "end" else (cur_cy + (slot_h - ch_val) // 2 if justify == "center" else cur_cy)
                if isinstance(c.get("x"), (int, float)):
                    cx = int(round(c["x"]))
                if isinstance(c.get("y"), (int, float)):
                    branch_cy = int(round(c["y"]))
                layout_node(c, cx, branch_cy, cw, ch_val, _abs_pos=True)
            cy_float += slot_h + step_gap
    elif layout == "grid":
        cols = max(1, int(node.get("columns") or 2))
        col_gap = snap_token(node.get("columnGap", node.get("gap", 0)), SPACING_TOKENS)
        row_gap = snap_token(node.get("rowGap", node.get("gap", 0)), SPACING_TOKENS)
        placements, rows = _plan_bento_grid(children, cols)
        cell_w = max(0, (inner_w - col_gap * max(0, cols - 1)) // cols)
        cell_h_default = max(0, (inner_h - row_gap * max(0, rows - 1)) // rows)
        row_heights = [0] * rows
        for ch, r, _, rs, _ in placements:
            if rs == 1:
                h_need = cell_h_default if (is_fill(ch.get("h")) or ch.get("h") is None) else resolve_size(ch.get("h"), ch["_mh"] or cell_h_default, "h")
                row_heights[r] = max(row_heights[r], h_need)
        for r in range(rows):
            if row_heights[r] == 0:
                row_heights[r] = cell_h_default
        for c, r, c_idx, rs, cs in placements:
            cx = inner_x + c_idx * (cell_w + col_gap)
            span_w = (inner_x + inner_w - cx) if (c_idx + cs == cols) else (cell_w * cs + col_gap * (cs - 1))
            cw = span_w if (is_fill(c.get("w")) or c.get("w") is None or c.get("_auto_w")) else resolve_size(c.get("w"), span_w, "w")
            cy = inner_y + sum(row_heights[:r]) + r * row_gap
            span_h = sum(row_heights[r : r + rs]) + row_gap * (rs - 1)
            ch_val = span_h if (is_fill(c.get("h")) or c.get("h") is None or rs > 1) else resolve_size(c.get("h"), span_h, "h")
            layout_node(c, cx, cy, cw, ch_val, _abs_pos=True)
    else:
        for c in children:
            cw = inner_w if is_fill(c.get("w")) else resolve_size(c.get("w"), c["_mw"] or inner_w, "w")
            ch_val = inner_h if is_fill(c.get("h")) else resolve_size(c.get("h"), c["_mh"] or inner_h, "h")
            if c.get("isModal"):
                cx = int(round(c.get("x", inner_x)))
                cy = int(round(c.get("y", inner_y)))
            else:
                cx = inner_x + int(round(c.get("x", 0))) if "x" in c else inner_x
                cy = inner_y + int(round(c.get("y", 0))) if "y" in c else inner_y
                if c.get("right") is not None:
                    cx = inner_x + inner_w - cw - int(round(c["right"]))
                if c.get("bottom") is not None:
                    cy = inner_y + inner_h - ch_val - int(round(c["bottom"]))
                anchor = str(c.get("anchor") or "").lower()
                if anchor == "center":
                    cx = inner_x + (inner_w - cw) // 2
                    cy = inner_y + (inner_h - ch_val) // 2
                elif anchor == "top-right":
                    cx = inner_x + inner_w - cw - int(round(c.get("right", 0)))
                elif anchor == "bottom-right":
                    cx = inner_x + inner_w - cw - int(round(c.get("right", 0)))
                    cy = inner_y + inner_h - ch_val - int(round(c.get("bottom", 0)))
                elif anchor == "bottom-left":
                    cy = inner_y + inner_h - ch_val - int(round(c.get("bottom", 0)))
                if "_declared_x" in c and c.get("right") is None and not anchor:
                    c["_expected_stack_x"] = inner_x + int(round(float(c["_declared_x"])))
                if "_declared_y" in c and c.get("bottom") is None and not anchor:
                    c["_expected_stack_y"] = inner_y + int(round(float(c["_declared_y"])))
            # Stack coordinates already include parent offset, padding and anchors.
            layout_node(c, cx, cy, cw, ch_val, _abs_pos=True, _stack_pos=True)

        # 约束定位：after（紧跟某个兄弟）/ afterGap / alignX（左中右对齐父级内区）
        def _find_sibling(key):
            # ① 精确 / 后缀 ② 名字里的逻辑 id 段（原生名形如 badge-p-<hash>）
            for _c in children:
                for _cand in (_c.get("id"), _c.get("name")):
                    if isinstance(_cand, str) and (_cand == key or _cand.endswith("/" + key) or _cand.endswith("-" + key)):
                        return _c
            for _c in children:
                for _cand in (_c.get("id"), _c.get("name")):
                    if isinstance(_cand, str) and key in _cand.split("-"):
                        return _c
            return None
        for _c in children:
            _cw, _ch_ = _c.get("_w"), _c.get("_h")
            _nx, _ny = _c.get("_x"), _c.get("_y")
            _moved = False
            _ax = _c.pop("alignX", None)
            if _ax in ("left", "center", "right") and isinstance(_cw, int):
                if _ax == "left":
                    _nx = inner_x
                elif _ax == "center":
                    _nx = inner_x + (inner_w - _cw) // 2
                else:
                    _nx = inner_x + inner_w - _cw
                _moved = True
            _after = _c.pop("after", None)
            _after_gap = _c.pop("afterGap", 0)
            if isinstance(_after, str):
                _sib = _find_sibling(_after.split("/")[-1]) or _find_sibling(_after)
                if _sib is not None and _sib is not _c:
                    _ny = _sib.get("_y", 0) + _sib.get("_h", 0) + int(round(float(_after_gap or 0)))
                    _moved = True
            if _moved and isinstance(_nx, int) and isinstance(_ny, int):
                layout_node(_c, _nx, _ny, _cw, _ch_, _abs_pos=True, _stack_pos=True)

def _node_border_sides(node):
    if any(k in node for k in ("borderTop", "borderBottom", "borderLeft", "borderRight")):
        mask = (1 if node.get("borderLeft") else 0) | (2 if node.get("borderTop") else 0) | (4 if node.get("borderRight") else 0) | (8 if node.get("borderBottom") else 0)
        return mask
    return int(node.get("borderSides", 15))


def make_axvg_vector_shape(item_id, name, x, y, w, h, fill_hex=None, stroke_hex=None, radius=0, text=None, font_size=14, font_weight=400, text_color_hex="#1E293B", align="left", alpha=1.0, v_align=None, stroke_width=1, border_sides=15, spans=None, italic=False, underline=False, strikethrough=False, letter_spacing=0, gradient=None, font_family="Inter", rotation=0):
    w = max(1, int(round(w)))
    h = max(1, int(round(h)))
    x = int(round(x))
    y = int(round(y))
    r = max(0, min(int(round(radius or 0)), min(w, h) // 2))
    bg_fills = []
    if fill_hex and fill_hex != "transparent":
        fc = hex_to_rgb_float(fill_hex, alpha)
        if float(fc.get("a", 1.0)) > 0.0:
            bg_fills.append({"type": 1, "enabled": True, "color": fc})
    strokes = []
    stroke_thick = 0
    border = [0, 0, 0, 0]
    bs_mask = int(border_sides if border_sides is not None else 15)
    if stroke_hex and stroke_hex != "transparent" and bs_mask > 0:
        sc = hex_to_rgb_float(stroke_hex, alpha)
        if float(sc.get("a", 1.0)) > 0.0:
            strokes.append({"alignment": 0, "fill": {"type": 1, "enabled": True, "color": sc}})
            stroke_thick = float(stroke_width or 1)
            border = [1 if (bs_mask & 2) else 0, 1 if (bs_mask & 4) else 0, 1 if (bs_mask & 8) else 0, 1 if (bs_mask & 1) else 0]
    has_visible_fill = bool(bg_fills and float(bg_fills[0].get("color", {}).get("a", 1.0)) > 0.0)
    has_visible_stroke = bool(strokes and float(strokes[0].get("fill", {}).get("color", {}).get("a", 1.0)) > 0.0 and stroke_thick > 0)
    if not has_visible_fill and not has_visible_stroke:
        r = 0
    has_box = bool(bg_fills or strokes)
    text_align_code = 1 if (has_box or v_align == "middle") else 0
    item = {
        "itemType": 1,
        "id": str(item_id),
        "name": str(name),
        "visible": True,
        "isLocked": False,
        "isNameDynamic": False,
        "rotation": float(rotation or 0),
        "opacity": float(alpha),
        "rect": {"location": {"x": x, "y": y}, "size": {"width": w, "height": h}},
        "resizingConstraints": {
            "hasFixedLeft": True,
            "hasFixedRight": False,
            "hasFixedTop": True,
            "hasFixedBottom": False,
            "hasFixedWidth": True,
            "hasFixedHeight": True,
        },
        "strokes": strokes,
        "strokeThickness": stroke_thick,
        "borderSides": bs_mask if strokes else 0,
        "strokePattern": [],
        **({"gradient": gradient} if gradient else {}),
        "backgroundFills": ([{"type": 2, "gradientType": 0, "from": {"x": 0, "y": 0}, "to": {"x": 1, "y": 1},
                              "stops": [{"color": c, "offset": o} for c, o in zip(gradient["colors"], gradient["offsets"])]}]
                             if gradient else bg_fills),
        "effects": [],
        "textAlignment": text_align_code,
        "textPadding": [],
        "textShadows": [],
        "textRotation": 0,
        "isMask": False,
        "booleanOperation": 0,
        "flippedHorizontal": False,
        "flippedVertical": False,
        "corners": [r, r, r, r],
        "border": border,
        "type": 0,
    }
    def _make_run(run_text, r_size, r_weight, r_color_hex, r_italic=False, r_under=False, r_strike=False, r_spacing=0):
        w_i = int(r_weight or 400)
        tf = "Inter - Bold" if w_i >= 700 else ("Inter - Semi Bold" if w_i >= 600 else ("Inter - Medium" if w_i >= 500 else "Inter - Regular"))
        wv = 500 if w_i == 600 else w_i
        return {
            "type": 0,
            "text": str(run_text),
            "family": str(font_family or "Inter"),
            "typeface": tf,
            "style": 2 if r_italic else 0,
            "weight": wv,
            "textColor": hex_to_rgb_float(r_color_hex, 1.0),
            "size": int(r_size or 14),
            "underline": bool(r_under),
            "strikethrough": bool(r_strike),
            "superscript": 0,
            "baselineOffset": 0,
            "highlight": {"a": 1, "r": 0, "g": 0, "b": 0},
            "characterSpacing": float(r_spacing or 0),
            "transform": 0,
            "stretch": 5,
        }
    eff_text = " " if (not bg_fills and not strokes and (text is None or str(text) == "")) else text
    if isinstance(spans, list) and spans:
        align_code = {"left": 0, "center": 1, "right": 2}.get(align, 0)
        inlines = [
            _make_run(
                sp.get("text", ""),
                sp.get("size", sp.get("fontSize", font_size)),
                sp.get("weight", sp.get("fontWeight", font_weight)),
                sp.get("_resolved_color", sp.get("color", text_color_hex)),
                sp.get("italic", italic),
                sp.get("underline", underline),
                sp.get("strikethrough", strikethrough),
                sp.get("letterSpacing", letter_spacing),
            )
            for sp in spans if str(sp.get("text", "")) != ""
        ]
        if inlines:
            item["text"] = {"paragraphs": [{"horizontalAlignment": align_code, "lineSpacing": 0, "inlines": inlines}]}
    elif eff_text is not None and str(eff_text) != "":
        align_code = {"left": 0, "center": 1, "right": 2}.get(align, 0)
        inlines = [_make_run(str(eff_text), font_size, font_weight, text_color_hex, italic, underline, strikethrough, letter_spacing)]
        item["text"] = {"paragraphs": [{"horizontalAlignment": align_code, "lineSpacing": 0, "inlines": inlines}]}
    return item


def make_axvg_image_shape(item_id, name, x, y, w, h, image_key, rotation=0):
    """创建支持透明 PNG 的 Axvg 图片元件 (backgroundFills type=3 + imageMap)。"""
    return {
        "itemType": 1,
        "id": str(item_id),
        "name": str(name),
        "visible": True,
        "isLocked": False,
        "isNameDynamic": False,
        "rotation": float(rotation or 0),
        "opacity": 1,
        "resizingConstraints": {
            "hasFixedLeft": True,
            "hasFixedRight": False,
            "hasFixedTop": True,
            "hasFixedBottom": False,
            "hasFixedWidth": True,
            "hasFixedHeight": True,
        },
        "rect": {"location": {"x": int(round(x)), "y": int(round(y))}, "size": {"width": max(1, int(round(w))), "height": max(1, int(round(h)))}},
        "strokes": [],
        "strokeThickness": 0,
        "strokePattern": [],
        "backgroundFills": [
            {
                "type": 3,
                "enabled": True,
                "image": str(image_key),
                "isHash": True,
                "alignment": {"horizontal": 1, "vertical": 1},
                "patternFillType": 4,
            }
        ],
        "effects": [],
        "textAlignment": 1,
        "textPadding": [],
        "textShadows": [],
        "textRotation": 0,
        "isMask": False,
        "booleanOperation": 0,
        "flippedHorizontal": False,
        "flippedVertical": False,
        "corners": [0, 0, 0, 0],
        "border": [0, 0, 0, 0],
        "type": 0,
    }



def _parse_gradient_spec(node, theme_dict):
    """把 `gradient:"135deg,#A,#B"` 解析成结构化渐变；返回 None 表示不适用。"""
    raw = node.get("gradient")
    if not raw:
        return None
    angle, parts = 180.0, []
    if isinstance(raw, str):
        text = raw.strip()
        if "(" in text and text.endswith(")"):
            text = text[text.index("(") + 1:-1]
        tokens = [t.strip() for t in text.split(",") if t.strip()]
        if tokens and tokens[0].lower().endswith("deg"):
            try:
                angle = float(tokens[0][:-3])
            except ValueError:
                angle = 180.0
            tokens = tokens[1:]
        parts = tokens
    elif isinstance(raw, dict):
        angle = float(raw.get("angle", 180))
        parts = [p.get("color") if isinstance(p, dict) else p for p in (raw.get("stops") or [])]
    colors = [resolve_color(p, theme_dict) for p in parts if isinstance(p, str)]
    colors = [c for c in colors if c]
    if len(colors) < 2:
        return None
    n = len(colors)
    offsets = [round(i / (n - 1), 4) for i in range(n)]
    return {"type": "linear", "angle": angle, "colors": colors, "offsets": offsets}

def _has_optical_fx(node):
    return any(node.get(k) for k in ("backdropBlur", "aurora", "gradient", "shadow", "innerGlow", "noise"))


def _encode_pil_png(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()
    return hashlib.sha1(data).hexdigest(), base64.b64encode(data).decode("ascii")


def _render_optical_layer(node, nx, ny, nw, nh, fill_h, stroke_h, rad, theme_dict, backdrop_canvas):
    w, h = max(1, int(round(nw))), max(1, int(round(nh)))
    r = max(0, min(int(round(rad or 0)), min(w, h) // 2))
    alpha_node = float(node.get("opacity", 1.0))
    bw, bh = backdrop_canvas.size
    cx0, cy0 = max(0, min(bw - 1, int(nx))), max(0, min(bh - 1, int(ny)))
    cx1, cy1 = max(cx0 + 1, min(bw, int(nx + w))), max(cy0 + 1, min(bh, int(ny + h)))
    base_crop = backdrop_canvas.crop((cx0, cy0, cx1, cy1)).resize((w, h), Image.Resampling.BILINEAR)
    blur_px = float(node.get("backdropBlur") or 0)
    if blur_px > 0:
        base_crop = base_crop.filter(ImageFilter.GaussianBlur(radius=min(48.0, blur_px)))
    surface = base_crop.copy() if (blur_px > 0 or node.get("aurora") or node.get("shadow")) else Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if fill_h and fill_h != "transparent":
        fc = hex_to_rgba_tuple(fill_h, alpha_node)
        if blur_px > 0 and fc[3] > 215:
            fc = (fc[0], fc[1], fc[2], 168)
        fill_layer = Image.new("RGBA", (w, h), fc)
        surface = Image.alpha_composite(surface, fill_layer)
    grad = node.get("gradient")
    if grad:
        c1_raw, c2_raw, ang = "$brand", "$accent", 135.0
        if isinstance(grad, str):
            parts = [p.strip() for p in re.sub(r"^[a-zA-Z-]+\(|\)$", "", grad).split(",") if p.strip()]
            if parts and parts[0].endswith("deg"):
                try: ang = float(parts[0][:-3]); parts = parts[1:]
                except Exception: pass
            if len(parts) >= 2: c1_raw, c2_raw = parts[0], parts[-1]
        elif isinstance(grad, dict):
            ang = float(grad.get("angle", 135))
            stops = grad.get("stops") or [grad.get("from", "$brand"), grad.get("to", "$accent")]
            if len(stops) >= 2:
                c1_raw = stops[0].get("color", "$brand") if isinstance(stops[0], dict) else stops[0]
                c2_raw = stops[-1].get("color", "$accent") if isinstance(stops[-1], dict) else stops[-1]
        rgba1 = hex_to_rgba_tuple(resolve_color(c1_raw, theme_dict) or "#6366F1", alpha_node)
        rgba2 = hex_to_rgba_tuple(resolve_color(c2_raw, theme_dict) or "#06B6D4", alpha_node)
        gw, gh = max(2, min(128, w)), max(2, min(128, h))
        g_img = Image.new("RGBA", (gw, gh))
        g_px = g_img.load()
        rad_a = math.radians(ang)
        vx, vy = math.cos(rad_a), math.sin(rad_a)
        for py in range(gh):
            ny_f = py / float(gh - 1) - 0.5
            for px in range(gw):
                nx_f = px / float(gw - 1) - 0.5
                t = max(0.0, min(1.0, (nx_f * vx + ny_f * vy) + 0.5))
                g_px[px, py] = tuple(int(round(rgba1[i] * (1.0 - t) + rgba2[i] * t)) for i in range(4))
        surface = Image.alpha_composite(surface, g_img.resize((w, h), Image.Resampling.BILINEAR))
    aurora_spec = node.get("aurora")
    if aurora_spec:
        orbs = aurora_spec if isinstance(aurora_spec, list) else [
            {"x": 0.18, "y": 0.22, "r": max(w, h) * 0.45, "color": "$brand", "opacity": 0.42},
            {"x": 0.82, "y": 0.28, "r": max(w, h) * 0.40, "color": "$accent", "opacity": 0.36},
            {"x": 0.52, "y": 0.78, "r": max(w, h) * 0.42, "color": "$glow", "opacity": 0.30},
        ]
        orb_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        odraw = ImageDraw.Draw(orb_layer, "RGBA")
        for ob in orbs:
            if not isinstance(ob, dict): continue
            ox = float(ob.get("x", 0.5))
            oy = float(ob.get("y", 0.5))
            ox_px = int(ox * w) if ox <= 1.0 else int(ox)
            oy_px = int(oy * h) if oy <= 1.0 else int(oy)
            orad = int(float(ob.get("r", max(w, h) * 0.35)))
            ocol = hex_to_rgba_tuple(resolve_color(ob.get("color", "$brand"), theme_dict) or "#7C3AED", float(ob.get("opacity", 0.4)))
            odraw.ellipse([ox_px - orad, oy_px - orad, ox_px + orad, oy_px + orad], fill=ocol)
        orb_layer = orb_layer.filter(ImageFilter.GaussianBlur(radius=max(24.0, min(96.0, max(w, h) * 0.12))))
        surface = Image.alpha_composite(surface, orb_layer)
    noise_amt = float(node.get("noise") or 0)
    if noise_amt > 0:
        tile_sz = 128
        tile = Image.new("RGBA", (tile_sz, tile_sz))
        t_px = tile.load()
        na = max(1, min(42, int(round(noise_amt * 255))))
        for py in range(tile_sz):
            for px in range(tile_sz):
                hv = ((px * 374761393 + py * 668265263) ^ ((px * 1274126177 + py * 1911520717) >> 9)) & 0xFF
                t_px[px, py] = (hv, hv, hv, na)
        grain_layer = Image.new("RGBA", (w, h))
        for ty in range(0, h, tile_sz):
            for tx in range(0, w, tile_sz):
                grain_layer.paste(tile, (tx, ty))
        surface = Image.alpha_composite(surface, grain_layer)
    s2 = surface.resize((w * 2, h * 2), Image.Resampling.BILINEAR)
    mask = Image.new("L", (w * 2, h * 2), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w * 2 - 1, h * 2 - 1], radius=r * 2, fill=255)
    out = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
    out.paste(s2, (0, 0), mask)
    od = ImageDraw.Draw(out, "RGBA")
    ig = node.get("innerGlow")
    if ig or (blur_px > 0 and ig is not False):
        ig_a = float(ig) if isinstance(ig, (int, float)) else 0.28
        ig_col = hex_to_rgba_tuple(resolve_color(ig, theme_dict), 0.35) if isinstance(ig, str) else (255, 255, 255, int(round(min(1.0, ig_a) * 255)))
        od.rounded_rectangle([2, 2, w * 2 - 3, h * 2 - 3], radius=max(0, r * 2 - 2), outline=ig_col, width=2)
    if stroke_h and stroke_h != "transparent":
        sw = max(1, int(round(float(node.get("strokeWidth", 1)) * 2)))
        sc = hex_to_rgba_tuple(stroke_h, alpha_node)
        od.rounded_rectangle([0, 0, w * 2 - 1, h * 2 - 1], radius=r * 2, outline=sc, width=sw)
    backdrop_canvas.alpha_composite(out.resize((w, h), Image.Resampling.LANCZOS), (cx0, cy0))
    return _encode_pil_png(out)


def _render_vector_icon(icon_name, w, h, color_hex, stroke_w=1.8):
    w, h = max(8, int(round(w))), max(8, int(round(h)))
    S = 4
    W, H = w * S, h * S
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    col = hex_to_rgba_tuple(color_hex or "#F8FAFC", 1.0)
    sw = max(2, int(round(float(stroke_w) * S * (min(w, h) / 20.0))))
    p = lambda ux, uy: (int(round(ux * W / 24.0)), int(round(uy * H / 24.0)))
    nm = str(icon_name or "sparkles").lower().strip()
    if nm in ("arrow-left", "back"):
        d.line([p(14, 5), p(7, 12), p(14, 19)], fill=col, width=sw, joint="curve")
        d.line([p(7, 12), p(21, 12)], fill=col, width=sw)
    elif nm == "home":
        d.line([p(3, 11), p(12, 3), p(21, 11)], fill=col, width=sw, joint="curve")
        d.line([p(6, 10), p(6, 21), p(18, 21), p(18, 10)], fill=col, width=sw)
        d.line([p(10, 21), p(10, 15), p(14, 15), p(14, 21)], fill=col, width=sw)
    elif nm == "book":
        d.line([p(12, 5), p(12, 21)], fill=col, width=sw)
        d.line([p(12, 5), p(3, 3), p(3, 18), p(12, 21), p(21, 18), p(21, 3), p(12, 5)], fill=col, width=sw, joint="curve")
    elif nm == "heart":
        d.line([p(12, 21), p(3, 11), p(3, 6), p(7, 3), p(12, 7), p(17, 3), p(21, 6), p(21, 11), p(12, 21)], fill=col, width=sw, joint="curve")
    elif nm == "star":
        d.line([p(12, 2), p(15, 8), p(22, 9), p(17, 14), p(18, 21), p(12, 18), p(6, 21), p(7, 14), p(2, 9), p(9, 8), p(12, 2)], fill=col, width=sw, joint="curve")
    elif nm == "clock":
        d.ellipse([*p(3, 3), *p(21, 21)], outline=col, width=sw)
        d.line([p(12, 6), p(12, 12), p(16, 15)], fill=col, width=sw)
    elif nm in ("sparkles", "ai", "magic", "wand"):
        pts = [p(12, 2), p(14.5, 9.5), p(22, 12), p(14.5, 14.5), p(12, 22), p(9.5, 14.5), p(2, 12), p(9.5, 9.5), p(12, 2)]
        d.line(pts, fill=col, width=sw, joint="curve")
        d.line([p(19, 3), p(19, 7)], fill=col, width=max(2, sw - 1))
        d.line([p(17, 5), p(21, 5)], fill=col, width=max(2, sw - 1))
    elif nm in ("search", "find"):
        d.ellipse([*p(4, 4), *p(17, 17)], outline=col, width=sw)
        d.line([p(15.5, 15.5), p(20.5, 20.5)], fill=col, width=sw)
    elif nm in ("plus", "add"):
        d.line([p(12, 5), p(12, 19)], fill=col, width=sw)
        d.line([p(5, 12), p(19, 12)], fill=col, width=sw)
    elif nm in ("check", "done", "ok"):
        d.line([p(4.5, 12.5), p(9.5, 17.5), p(19.5, 6.5)], fill=col, width=sw, joint="curve")
    elif nm in ("zap", "bolt", "flash", "lightning"):
        d.polygon([p(13, 2), p(4, 14), p(11, 14), p(10, 22), p(20, 10), p(13, 10)], outline=col, width=sw)
    elif nm in ("layers", "stack"):
        d.polygon([p(12, 3), p(21, 8), p(12, 13), p(3, 8)], outline=col, width=sw)
        d.line([p(3, 13), p(12, 18), p(21, 13)], fill=col, width=sw)
        d.line([p(3, 17.5), p(12, 22), p(21, 17.5)], fill=col, width=sw)
    elif nm in ("chart", "activity", "pulse", "trend"):
        d.line([p(3, 17), p(8.5, 11.5), p(13, 15), p(20.5, 6.5)], fill=col, width=sw, joint="curve")
        d.line([p(16, 6.5), p(20.5, 6.5), p(20.5, 11)], fill=col, width=sw)
    elif nm in ("cpu", "chip", "model"):
        d.rounded_rectangle([*p(6, 6), *p(18, 18)], radius=int(2.5 * S), outline=col, width=sw)
        d.rectangle([*p(9.5, 9.5), *p(14.5, 14.5)], fill=col)
        for u in (9, 15):
            d.line([p(u, 2.5), p(u, 6)], fill=col, width=sw); d.line([p(u, 18), p(u, 21.5)], fill=col, width=sw)
            d.line([p(2.5, u), p(6, u)], fill=col, width=sw); d.line([p(18, u), p(21.5, u)], fill=col, width=sw)
    elif nm in ("sliders", "filter", "tune", "settings"):
        for uy, cx_u in ((6, 9), (12, 15), (18, 10)):
            d.line([p(4, uy), p(20, uy)], fill=col, width=sw)
            d.ellipse([*p(cx_u - 2.2, uy - 2.2), *p(cx_u + 2.2, uy + 2.2)], fill=col)
    elif nm in ("bell", "alert"):
        d.arc([*p(6, 4), *p(18, 16)], 180, 360, fill=col, width=sw)
        d.line([p(6, 10), p(4.5, 17), p(19.5, 17), p(18, 10)], fill=col, width=sw)
        d.arc([*p(10, 17), *p(14, 21)], 0, 180, fill=col, width=sw)
    elif nm in ("arrow-up-right", "external"):
        d.line([p(7, 17), p(17, 7)], fill=col, width=sw)
        d.line([p(9, 7), p(17, 7), p(17, 15)], fill=col, width=sw)
    elif nm in ("shield", "security", "guard"):
        d.polygon([p(12, 2.5), p(19.5, 5.5), p(19.5, 12), p(12, 21.5), p(4.5, 12), p(4.5, 5.5)], outline=col, width=sw)
    else:
        d.rounded_rectangle([*p(4, 4), *p(20, 20)], radius=int(4 * S), outline=col, width=sw)
        d.ellipse([*p(9.5, 9.5), *p(14.5, 14.5)], fill=col)
    return _encode_pil_png(img.resize((w * 2, h * 2), Image.Resampling.LANCZOS))


def _render_sparkline(points, w, h, color_hex, fill_hex=None, stroke_w=2.0, smooth=True):
    w, h = max(24, int(round(w))), max(16, int(round(h)))
    S = 4
    W, H = w * S, h * S
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vals = [float(v) for v in (points or [12, 19, 15, 28, 24, 36, 42])]
    if len(vals) < 2:
        vals = vals + vals
    vmin, vmax = min(vals), max(vals)
    vspan = max(1e-6, vmax - vmin)
    pad_x, pad_y = int(4 * S), int(5 * S)
    uw, uh = max(1, W - 2 * pad_x), max(1, H - 2 * pad_y)
    raw_pts = [(pad_x + uw * (i / float(len(vals) - 1)), pad_y + uh * (1.0 - (v - vmin) / vspan)) for i, v in enumerate(vals)]
    if smooth and len(raw_pts) >= 3:
        curve_pts = []
        for i in range(len(raw_pts) - 1):
            p0 = raw_pts[max(0, i - 1)]
            p1 = raw_pts[i]
            p2 = raw_pts[i + 1]
            p3 = raw_pts[min(len(raw_pts) - 1, i + 2)]
            for step in range(12):
                t = step / 12.0
                t2, t3 = t * t, t * t * t
                cx = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
                cy = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
                curve_pts.append((cx, cy))
        curve_pts.append(raw_pts[-1])
    else:
        curve_pts = raw_pts
    col = hex_to_rgba_tuple(color_hex or "#7C3AED", 1.0)
    fcol = hex_to_rgba_tuple(fill_hex or color_hex or "#7C3AED", 1.0)
    poly_mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(poly_mask).polygon(curve_pts + [(curve_pts[-1][0], H - 2), (curve_pts[0][0], H - 2)], fill=255)
    grad = Image.new("RGBA", (1, H))
    for y in range(H):
        a = int(round(max(0.0, 1.0 - (y / float(H))) * 115))
        grad.putpixel((0, y), (fcol[0], fcol[1], fcol[2], a))
    img.paste(grad.resize((W, H)), (0, 0), poly_mask)
    d = ImageDraw.Draw(img, "RGBA")
    sw = max(3, int(round(float(stroke_w) * S)))
    d.line(curve_pts, fill=col, width=sw, joint="curve")
    lx, ly = curve_pts[-1]
    r_dot = int(3.2 * S)
    d.ellipse([lx - r_dot * 2, ly - r_dot * 2, lx + r_dot * 2, ly + r_dot * 2], fill=(col[0], col[1], col[2], 72))
    d.ellipse([lx - r_dot, ly - r_dot, lx + r_dot, ly + r_dot], fill=col)
    return _encode_pil_png(img.resize((w * 2, h * 2), Image.Resampling.LANCZOS))


def emit_tree_to_axvg(root_node, theme_dict, include_dynamic_panel_placeholders=False, base_dir=None, canvas_background=True):
    """递归遍历已完成自动布局的节点树，生成带原生编组 (itemType: 0) 的 Axvg items 与扁平 spec children。"""
    id_counter = [1]
    active_when_ctx = [()]

    class _WhenContextList(list):
        def append(self, item):
            if active_when_ctx[0] and isinstance(item, dict):
                item["_whenCtx"] = [list(x[:3]) for x in active_when_ctx[0]]
                if any(not x[2] for x in active_when_ctx[0]):
                    item["_whenHiddenPreview"] = True
                if any(len(x) > 3 and x[3] for x in active_when_ctx[0]):
                    item["_explicitHidden"] = True
            super().append(item)

    flat_spec_children = _WhenContextList()
    dynamic_panels = []
    repeaters = []
    native_inputs = []
    native_styles = []
    modal_targets = []
    image_map = {}
    emitted_names = set()
    master_instances = []
    root_bg_hex = resolve_color(root_node.get("fill", "$bg"), theme_dict) or "#F4F6F9"
    backdrop_canvas = Image.new(
        "RGBA",
        (max(1, int(root_node.get("_w", 1440))), max(1, int(root_node.get("_h", 900)))),
        hex_to_rgba_tuple(root_bg_hex, 1.0),
    )

    def next_id():
        v = id_counter[0]
        id_counter[0] += 1
        return f"w{v}"

    def unique_emit_name(cand):
        base = str(cand)
        if base not in emitted_names:
            emitted_names.add(base)
            return base
        idx = 2
        while f"{base}-{idx}" in emitted_names:
            idx += 1
        final_nm = f"{base}-{idx}"
        emitted_names.add(final_nm)
        return final_nm

    def walk(node, in_modal=False):
        prev_when_ctx = active_when_ctx[0]
        explicit_hidden = isinstance(node, dict) and ((node.get("visible") is False) or (node.get("hidden") is True))
        if isinstance(node, dict) and (node.get("_when_group") is not None or "_when_default_visible" in node or explicit_hidden):
            wg_id = node.get("_when_group") or f"wg_single_{id(node)}"
            wb_id = int(node.get("_when_branch", 0))
            w_vis = False if explicit_hidden else bool(node.get("_when_default_visible", True))
            active_when_ctx[0] = (*prev_when_ctx, (wg_id, wb_id, w_vis, explicit_hidden))
        try:
            res = _walk_inner(node, in_modal)
            if explicit_hidden:
                if isinstance(res, dict):
                    res["visible"] = False
                elif isinstance(res, list):
                    for it in res:
                        if isinstance(it, dict):
                            it["visible"] = False
            return res
        finally:
            active_when_ctx[0] = prev_when_ctx

    def _walk_inner(node, in_modal=False):
        ntype = node.get("type", "box")
        nx, ny, nw, nh = node["_x"], node["_y"], node["_w"], node["_h"]
        name = unique_emit_name(node.get("name") or f"grp-{ntype}")
        cur_modal = in_modal or bool(node.get("isModal", False))
        state_fields = {key: copy.deepcopy(node[key]) for key in ("selected", "disabled", "selectionGroup") if key in node}
        state_styles = {state: {key: resolve_color(value, theme_dict) if key in ("fill", "stroke", "color") else value
                               for key, value in values.items()}
                        for state, values in (node.get("styles") or {}).items()}
        has_native_style = bool(state_styles or state_fields)
        if has_native_style and ntype != "native-form":
            native_styles.append({"name": name, **state_fields, **({"styles": state_styles} if state_styles else {})})
        if node.get("_master_instance") and not include_dynamic_panel_placeholders:
            master_instances.append({"master": node["_master_instance"], "x": nx, "y": ny, "w": nw, "h": nh})
            slot_items = []
            def emit_slots(parent):
                for child in parent.get("children", []):
                    if child.get("_master_slot"):
                        emitted = walk(child, in_modal)
                        if emitted is not None:
                            slot_items.extend(emitted if isinstance(emitted, list) else [emitted])
                    else:
                        emit_slots(child)
            emit_slots(node)
            return slot_items or None
        if ntype == "repeater":
            repeaters.append({"name": name, "x": nx, "y": ny, "w": nw, "h": nh,
                "template": node["template"], "rowHeight": node["rowHeight"], "rowGap": node.get("rowGap", 0),
                "pageSize": node.get("pageSize", 0), "model": node["model"], "rows": node["rows"],
                "hiddenLookup": bool(node.get("_hidden_lookup"))})
            if node.get("_hidden_lookup"):
                return None
            if include_dynamic_panel_placeholders:
                row_h = int(node["rowHeight"])
                row_gap = int(node.get("rowGap", 0))
                def _apply_row_idx(n, idx):
                    if isinstance(n, dict):
                        if isinstance(n.get("_row_texts"), list) and idx < len(n["_row_texts"]):
                            n["text"] = str(n["_row_texts"][idx])
                        if isinstance(n.get("_row_visibles"), list) and idx < len(n["_row_visibles"]):
                            n["_when_default_visible"] = bool(n["_row_visibles"][idx])
                        for ch_n in (n.get("children") or []):
                            _apply_row_idx(ch_n, idx)
                row_tree = copy.deepcopy(node["template"])
                _apply_row_idx(row_tree, 0)
                measure_node(row_tree, base_dir=base_dir, available_w=nw)
                layout_node(row_tree, nx, ny, nw, row_h)
                first_res = walk(row_tree, cur_modal)
                all_rows = node.get("rows") or []
                max_rows = int(node.get("pageSize") or 0) or len(all_rows)
                for r_idx in range(1, min(len(all_rows), max_rows)):
                    ry = ny + r_idx * (row_h + row_gap)
                    if ry + row_h > ny + nh + 4:
                        break
                    extra_tree = copy.deepcopy(node["template"])
                    _apply_row_idx(extra_tree, r_idx)
                    measure_node(extra_tree, base_dir=base_dir, available_w=nw)
                    layout_node(extra_tree, nx, ry, nw, row_h)
                    prev_cnt = len(flat_spec_children)
                    walk(extra_tree, cur_modal)
                    for fc in flat_spec_children[prev_cnt:]:
                        fc["_repeaterPreviewExtraRow"] = True
                return first_res
            return None
        if ntype == "dynamic-panel":
            dynamic_panels.append({
                "name": name,
                "x": nx,
                "y": ny,
                "w": nw,
                "h": nh,
                "states": node.get("states", []),
            })
            if not include_dynamic_panel_placeholders:
                return None
            states = node.get("states", [])
            if states:
                first_tree = states[0]["tree"]
                measure_node(first_tree, base_dir=base_dir, available_w=nw)
                layout_node(first_tree, nx, ny, nw, nh)
                return walk(first_tree, cur_modal)
            return None
        if ntype in ("icon", "sparkline"):
            col_h = resolve_color(node.get("color", "$brand" if ntype == "sparkline" else "$ink"), theme_dict)
            if ntype == "icon":
                ic_nm = node.get("icon") or node.get("text") or "sparkles"
                img_key, img_b64 = _render_vector_icon(ic_nm, nw, nh, col_h, node.get("strokeWidth", 1.8))
            else:
                fill_c = resolve_color(node.get("fill"), theme_dict) if node.get("fill") else col_h
                img_key, img_b64 = _render_sparkline(node.get("points"), nw, nh, col_h, fill_c, node.get("strokeWidth", 2.0), node.get("smooth", True))
            image_map[img_key] = img_b64
            if cur_modal:
                modal_targets.append(name)
            flat_spec_children.append({
                "kind": "image", "name": name, "x": nx, "y": ny, "w": nw, "h": nh,
                "imageKey": img_key, "b64": img_b64, "inModal": cur_modal,
            })
            return make_axvg_image_shape(next_id(), name, nx, ny, nw, nh, img_key, rotation=node.get("rotation"))
        if ntype == "image":
            src = node.get("src") or node.get("image") or node.get("file")
            img_info = load_image_asset(src, base_dir=base_dir)
            image_key, image_data = img_info["key"], img_info["b64"]
            radius = max(0, min(float(node.get("radius") or 0), nw / 2, nh / 2))
            opacity = max(0, min(1, float(node.get("opacity", 1))))
            if radius or opacity != 1:
                # Bake the alpha mask once so native ImageBox and offline preview agree.
                pic = Image.open(img_info["path"]).convert("RGBA").resize(
                    (max(1, int(nw * 2)), max(1, int(nh * 2))), Image.Resampling.LANCZOS)
                alpha = pic.getchannel("A")
                if radius:
                    mask = Image.new("L", pic.size, 0)
                    ImageDraw.Draw(mask).rounded_rectangle(
                        [0, 0, pic.width - 1, pic.height - 1], radius=radius * 2, fill=255)
                    alpha = ImageChops.multiply(alpha, mask)
                if opacity != 1:
                    alpha = alpha.point(lambda value: round(value * opacity))
                pic.putalpha(alpha)
                image_key, image_data = _encode_pil_png(pic)
            image_map[image_key] = image_data
            if cur_modal:
                modal_targets.append(name)
            flat_spec_children.append({
                "kind": "image",
                "name": name,
                "x": nx,
                "y": ny,
                "w": nw,
                "h": nh,
                "imageKey": image_key,
                **({"b64": image_data} if radius or opacity != 1 else {"pngPath": img_info["path"]}),
                "inModal": cur_modal,
            })
            return make_axvg_image_shape(next_id(), name, nx, ny, nw, nh, image_key, rotation=node.get("rotation"))
        if ntype == "native-form":
            kind = node["kind"]
            style = {
                "fontSize": node.get("fontSize", node.get("size", 14)),
                "fontWeight": node.get("fontWeight", node.get("weight", 400)),
                "color": resolve_color(node.get("color", "$ink"), theme_dict),
                "align": node.get("align", "left"),
            }
            for key in ("fill", "stroke"):
                if key in node:
                    style[key] = resolve_color(node[key], theme_dict)
            for key in ("fontFamily", "radius", "strokeWidth", "opacity", "textPaddingX"):
                if key in node:
                    style[key] = node[key]
            config = {"name": name, "kind": kind, "x": nx, "y": ny, "w": nw, "h": nh, "style": style,
                      **{key: copy.deepcopy(node[key]) for key in ("text", "value", "placeholder", "checked", "group", "options", "selectedIndex", "multiple", "selectedIndices", "rotation") if key in node},
                      **state_fields, **({"styles": state_styles} if state_styles else {})}
            if active_when_ctx[0] and any(not ctx[2] for ctx in active_when_ctx[0]):
                config["visible"] = False
            native_inputs.append(config)
            if cur_modal:
                modal_targets.append(name)
            if not include_dynamic_panel_placeholders:
                slot_name = unique_emit_name(f"__native-slot-{name}")
                config["slotName"] = slot_name
                return make_axvg_vector_shape(next_id(), slot_name, nx, ny, nw, nh,
                                              fill_hex=None, stroke_hex=None, radius=0)
            preview_text = str(node.get("text", node.get("value", node.get("placeholder", ""))))
            if kind in ("radio", "checkbox"):
                preview_text = (("● " if node.get("checked") else "○ ") if kind == "radio" else ("☑ " if node.get("checked") else "□ ")) + preview_text
            elif kind in ("combobox", "listbox"):
                options = node.get("options", [])
                indices = node.get("selectedIndices", [node.get("selectedIndex", 0)]) if kind == "listbox" else [node.get("selectedIndex", 0)]
                preview_text = (" / ".join(options[i] for i in indices) if indices else "") + (" ▾" if kind == "combobox" else "")
            flat_spec_children.append({"kind": "rect", "name": name, "x": nx, "y": ny, "w": nw, "h": nh,
                                       "fill": style.get("fill"), "stroke": style.get("stroke"), "radius": style.get("radius", 0),
                                       "text": preview_text, "size": style["fontSize"], "weight": style["fontWeight"],
                                       "color": style["color"], "align": style["align"], "inModal": cur_modal})
            return make_axvg_vector_shape(next_id(), name, nx, ny, nw, nh, fill_hex=style.get("fill"), stroke_hex=style.get("stroke"),
                                          radius=style.get("radius", 0), text=preview_text, font_size=style["fontSize"], font_weight=style["fontWeight"],
                                          text_color_hex=style["color"], align=style["align"], rotation=node.get("rotation"))
        if ntype == "native-input":
            fill_h = resolve_color(node.get("fill", "$surface-2"), theme_dict)
            stroke_h = resolve_color(node.get("stroke", "$line-strong"), theme_dict)
            bg_name = unique_emit_name(f"bg-{name}")
            native_inputs.append({
                "name": name,
                "bgName": bg_name,
                "placeholder": node.get("placeholder", ""),
                "value": node.get("value", ""),
                "x": nx,
                "y": ny,
                "w": nw,
                "h": nh,
                "style": {
                    "fontSize": node.get("fontSize", node.get("size", 13)),
                    "fontWeight": node.get("fontWeight", node.get("weight", 400)),
                    "color": resolve_color(node.get("color", "$ink"), theme_dict),
                    "align": node.get("align", "left"),
                    "textPaddingX": node.get("textPaddingX", 10),
                    "rotation": node.get("rotation", 0),
                },
            })
            if cur_modal:
                modal_targets.append(bg_name)
            inp_val = str(node.get("value") or "")
            inp_ph = str(node.get("placeholder") or "")
            inp_txt = inp_val if inp_val else inp_ph
            inp_col = resolve_color(node.get("color", "$ink") if inp_val else "$ink-3", theme_dict)
            flat_spec_children.append({
                "kind": "rect",
                "name": bg_name,
                "x": nx,
                "y": ny,
                "w": nw,
                "h": nh,
                "fill": fill_h,
                "stroke": stroke_h,
                "radius": node.get("radius", 6),
                "isNativeInputBg": True,
                "rotation": float(node.get("rotation") or 0),
                "inModal": cur_modal,
                **({"previewText": inp_txt, "size": node.get("fontSize", node.get("size", 13)), "weight": node.get("fontWeight", node.get("weight", 400)), "color": inp_col, "align": node.get("align", "left")} if inp_txt else {}),
            })
            return make_axvg_vector_shape(
                next_id(), bg_name, nx, ny, nw, nh,
                fill_hex=fill_h, stroke_hex=stroke_h, radius=node.get("radius", 6),
                rotation=node.get("rotation"),
            )
        if ntype in ("label", "shape-text"):
            fill_h = resolve_color(node.get("fill"), theme_dict)
            stroke_h = resolve_color(node.get("stroke"), theme_dict)
            txt_h = resolve_color(node.get("color", "$ink"), theme_dict)
            raw_spans = node.get("spans")
            resolved_spans = None
            if isinstance(raw_spans, list) and raw_spans:
                resolved_spans = [{**sp, "_resolved_color": resolve_color(sp.get("color", "$ink"), theme_dict)} for sp in raw_spans]
                txt = "".join(str(sp.get("text", "")) for sp in raw_spans)
            else:
                txt = node.get("text", node.get("content", ""))
            fsz = snap_token(node.get("fontSize", node.get("size", 14)), FONT_SIZE_TOKENS)
            fwt = snap_token(node.get("fontWeight", node.get("weight", 400)), FONT_WEIGHT_TOKENS)
            aln = node.get("align", "left")
            if (
                ntype == "label"
                and not resolved_spans
                and not isinstance(node.get("worstCase"), dict)
                and not re.search(r"-l\d+$", str(name))
                and txt is not None
                and str(txt) != ""
            ):
                pad_in = 16 if (fill_h or stroke_h) else 0
                tw0, th0 = measure_text(txt, fsz, fwt)
                if nh >= th0 and nw < tw0 + pad_in <= int(nw * 1.15) + 4:
                    for cand_fsz in reversed([t for t in FONT_SIZE_TOKENS if 10 <= t < fsz]):
                        if measure_text(txt, cand_fsz, fwt)[0] + pad_in <= nw:
                            fsz = cand_fsz
                            break
            rad = node.get("radius", 0)
            alpha_v = float(node.get("opacity", 1.0))
            sw_v = float(node.get("strokeWidth", 1))
            bs_v = _node_border_sides(node)
            has_opt = _has_optical_fx(node)
            if not has_native_style and (has_opt or ((fill_h or stroke_h) and aln in ("left", "right") and nw >= 36)) and txt is not None and str(txt) != "":
                tw, _ = measure_text(txt, fsz, fwt)
                pad_x = 0 if aln == "center" else min(int(node.get("textPaddingX", 10)), max(0, (nw - max(1, tw - 8)) // 2))
                if has_opt or pad_x >= 4:
                    bg_box_name = unique_emit_name(f"bg-box-{name}")
                    grp_box_name = unique_emit_name(f"grp-box-{name}")
                    tx = nx + pad_x
                    tw_box = max(8, nw - 2 * pad_x)
                    if cur_modal:
                        modal_targets.append(bg_box_name)
                        modal_targets.append(name)
                    if has_opt:
                        opt_k, opt_b64 = _render_optical_layer(node, nx, ny, nw, nh, fill_h, stroke_h, rad, theme_dict, backdrop_canvas)
                        image_map[opt_k] = opt_b64
                        flat_spec_children.append({
                            "kind": "image", "name": bg_box_name, "x": nx, "y": ny, "w": nw, "h": nh,
                            "imageKey": opt_k, "b64": opt_b64, "fill": fill_h, "stroke": stroke_h, "radius": rad, "inModal": cur_modal,
                        })
                        bg_shape = make_axvg_image_shape(next_id(), bg_box_name, nx, ny, nw, nh, opt_k)
                    else:
                        flat_spec_children.append({
                            "kind": "rect", "name": bg_box_name, "x": nx, "y": ny, "w": nw, "h": nh,
                            "fill": fill_h, "stroke": stroke_h, "radius": rad, "inModal": cur_modal,
                        })
                        bg_shape = make_axvg_vector_shape(
                            next_id(), bg_box_name, nx, ny, nw, nh,
                            fill_hex=fill_h, stroke_hex=stroke_h, radius=rad, alpha=alpha_v, stroke_width=sw_v, border_sides=bs_v,
                        )
                    flat_spec_children.append({
                        "kind": "text", "name": name, "x": tx, "y": ny, "w": tw_box, "h": nh,
                        "fill": None, "stroke": None, "radius": 0, "text": txt, "size": fsz, "weight": fwt, "color": txt_h, "align": aln, "inModal": cur_modal,
                        **({"letterSpacing": node["letterSpacing"]} if node.get("letterSpacing") else {}),
                        **({"lineHeight": node["lineHeight"]} if node.get("lineHeight") else {}),
                        **({"wrap": True} if node.get("wrap") else {}),
                        **({"spans": resolved_spans} if resolved_spans else {}),
                        **({"worstCase": node["_worst_case"]} if "_worst_case" in node else {}),
                    })
                    txt_shape = make_axvg_vector_shape(
                        next_id(), name, tx, ny, tw_box, nh,
                        fill_hex=None, stroke_hex=None, radius=0,
                        text=txt, font_size=fsz, font_weight=fwt, text_color_hex=txt_h, align=aln, alpha=alpha_v, v_align="middle", font_family=node.get("fontFamily", "Inter"),
                        spans=resolved_spans, italic=node.get("italic", False), underline=node.get("underline", False),
                        strikethrough=node.get("strikethrough", False), letter_spacing=node.get("letterSpacing", 0),
                    )
                    return {
                        "flippedHorizontal": False, "flippedVertical": False, "id": next_id(), "name": grp_box_name,
                        "visible": True, "isLocked": False, "isNameDynamic": False, "rotation": float(node.get("rotation") or 0),
                        "rect": {"location": {"x": nx, "y": ny}, "size": {"width": nw, "height": nh}},
                        "resizingConstraints": {"hasFixedLeft": True, "hasFixedRight": False, "hasFixedTop": True, "hasFixedBottom": False, "hasFixedWidth": True, "hasFixedHeight": True},
                        "itemType": 0, "effects": [], "scene": {"items": [bg_shape, txt_shape]},
                    }
            if not has_native_style and resolved_spans and len(resolved_spans) > 1 and not fill_h and not stroke_h:
                max_sp_sz = max(snap_token(sp.get("fontSize", sp.get("size", fsz)), FONT_SIZE_TOKENS) for sp in resolved_spans)
                cur_sx = nx
                span_shapes = []
                for sp_idx, sp in enumerate(resolved_spans, start=1):
                    raw_stxt = str(sp.get("text", ""))
                    stxt = raw_stxt.strip()
                    if not stxt:
                        continue
                    lead_sp = len(raw_stxt) - len(raw_stxt.lstrip(" "))
                    s_sz = snap_token(sp.get("fontSize", sp.get("size", fsz)), FONT_SIZE_TOKENS)
                    s_wt = snap_token(sp.get("fontWeight", sp.get("weight", fwt)), FONT_WEIGHT_TOKENS)
                    s_col = sp.get("_resolved_color") or txt_h
                    tw_s, _ = measure_text(stxt, s_sz, s_wt)
                    sw_box = max(12, tw_s + 8)
                    sh_box = nh if s_sz >= max_sp_sz else max(18, min(nh, int(round(s_sz * 1.35))))
                    sy_box = ny if s_sz >= max_sp_sz else (ny + nh - sh_box - max(1, int(round((nh - max_sp_sz) * 0.25))))
                    gap_px = 0 if not span_shapes else max(6, lead_sp * max(5, int(round(s_sz * 0.35))))
                    sx_box = cur_sx + gap_px
                    cur_sx = sx_box + sw_box
                    s_name = unique_emit_name(f"{name}-s{sp_idx}")
                    if cur_modal:
                        modal_targets.append(s_name)
                    flat_spec_children.append({
                        "kind": "text", "name": s_name, "x": sx_box, "y": sy_box, "w": sw_box, "h": sh_box,
                        "fill": None, "stroke": None, "radius": 0, "text": stxt, "size": s_sz, "weight": s_wt,
                        "color": s_col, "align": "left", "inModal": cur_modal,
                    })
                    span_shapes.append(make_axvg_vector_shape(
                        next_id(), s_name, sx_box, sy_box, sw_box, sh_box,
                        fill_hex=None, stroke_hex=None, radius=0,
                        text=stxt, font_size=s_sz, font_weight=s_wt, text_color_hex=s_col, align="left", font_family=node.get("fontFamily", "Inter"),
                        alpha=alpha_v, v_align="middle",
                        italic=bool(sp.get("italic", node.get("italic", False))),
                        underline=bool(sp.get("underline", node.get("underline", False))),
                        strikethrough=bool(sp.get("strikethrough", node.get("strikethrough", False))),
                    ))
                if span_shapes:
                    return {
                        "flippedHorizontal": False, "flippedVertical": False, "id": next_id(), "name": name,
                        "visible": True, "isLocked": False, "isNameDynamic": False, "rotation": float(node.get("rotation") or 0),
                        "rect": {"location": {"x": nx, "y": ny}, "size": {"width": nw, "height": nh}},
                        "resizingConstraints": {"hasFixedLeft": True, "hasFixedRight": False, "hasFixedTop": True, "hasFixedBottom": False, "hasFixedWidth": True, "hasFixedHeight": True},
                        "itemType": 0, "effects": [], "scene": {"items": span_shapes},
                    }
            if cur_modal:
                modal_targets.append(name)
            flat_spec_children.append({
                "kind": "rect" if (fill_h or stroke_h) else "text",
                "name": name, "x": nx, "y": ny, "w": nw, "h": nh,
                "fill": fill_h, "stroke": stroke_h, "radius": rad,
                "text": txt, "size": fsz, "weight": fwt, "color": txt_h, "align": aln, "inModal": cur_modal,
                **({"letterSpacing": node["letterSpacing"]} if node.get("letterSpacing") else {}),
                **({"lineHeight": node["lineHeight"]} if node.get("lineHeight") else {}),
                **({"wrap": True} if node.get("wrap") else {}),
                **({"spans": resolved_spans} if resolved_spans else {}),
                **({"worstCase": node["_worst_case"]} if "_worst_case" in node else {}),
                **({"textAlignment": 1, "_expectedTextAlignment": 1} if node.get("_text_v_align") == "middle" else {}),
            })
            return make_axvg_vector_shape(
                next_id(), name, nx, ny, nw, nh,
                fill_hex=fill_h, stroke_hex=stroke_h, radius=rad,
                text=txt, font_size=fsz, font_weight=fwt, text_color_hex=txt_h, align=aln, font_family=node.get("fontFamily", "Inter"),
                alpha=alpha_v, stroke_width=sw_v, border_sides=bs_v, spans=resolved_spans,
                italic=node.get("italic", False), underline=node.get("underline", False),
                strikethrough=node.get("strikethrough", False), letter_spacing=node.get("letterSpacing", 0),
                rotation=node.get("rotation"),
                v_align=node.get("_text_v_align"),
            )
        # Box / Container
        fill_h = resolve_color(node.get("fill"), theme_dict)
        stroke_h = resolve_color(node.get("stroke"), theme_dict)
        rad = node.get("radius", 0)
        bg_name = node.get("bgName", f"bg-{name}")
        child_items = []
        _grad = _parse_gradient_spec(node, theme_dict) if os.environ.get("AXURE_VECTOR_GRADIENT") == "1" else None
        if _grad:
            if cur_modal:
                modal_targets.append(bg_name)
            flat_spec_children.append({
                "kind": "rect", "name": bg_name, "x": nx, "y": ny, "w": nw, "h": nh,
                "fill": None, "stroke": stroke_h, "radius": rad, "inModal": cur_modal, "gradient": _grad,
            })
            child_items.append(make_axvg_vector_shape(
                next_id(), bg_name, nx, ny, nw, nh, fill_hex=None,
                stroke_hex=stroke_h, radius=rad, alpha=float(node.get("opacity", 1.0)),
                stroke_width=float(node.get("strokeWidth", 1)), border_sides=_node_border_sides(node),
                gradient=_grad,
            ))
            _grad = None if child_items else _grad
        elif _has_optical_fx(node):
            if cur_modal:
                modal_targets.append(bg_name)
            opt_k, opt_b64 = _render_optical_layer(node, nx, ny, nw, nh, fill_h, stroke_h, rad, theme_dict, backdrop_canvas)
            image_map[opt_k] = opt_b64
            flat_spec_children.append({
                "kind": "image", "name": bg_name, "x": nx, "y": ny, "w": nw, "h": nh,
                "imageKey": opt_k, "b64": opt_b64, "fill": fill_h, "stroke": stroke_h, "radius": rad, "inModal": cur_modal,
            })
            child_items.append(make_axvg_image_shape(next_id(), bg_name, nx, ny, nw, nh, opt_k))
        elif fill_h or stroke_h:
            if cur_modal:
                modal_targets.append(bg_name)
            if fill_h and fill_h != "transparent":
                if nw <= 0 or nh <= 0:
                    raise ValueError(f"节点 {node.get('name') or node.get('id')} 的尺寸非法（{nw}x{nh}）；请在源码中改为正数")
                ImageDraw.Draw(backdrop_canvas, "RGBA").rounded_rectangle(
                    [nx, ny, nx + nw - 1, ny + nh - 1],
                    radius=max(0, min(int(rad or 0), min(nw, nh) // 2)),
                    fill=hex_to_rgba_tuple(fill_h, float(node.get("opacity", 1.0))),
                )
            flat_spec_children.append({
                "kind": "rect", "name": bg_name, "x": nx, "y": ny, "w": nw, "h": nh,
                "fill": fill_h, "stroke": stroke_h, "radius": rad, "inModal": cur_modal,
            })
            child_items.append(
                make_axvg_vector_shape(
                    next_id(), bg_name, nx, ny, nw, nh,
                    fill_hex=fill_h, stroke_hex=stroke_h, radius=rad,
                    alpha=float(node.get("opacity", 1.0)), stroke_width=float(node.get("strokeWidth", 1)), border_sides=_node_border_sides(node),
                    rotation=node.get("rotation"),
                )
            )
        sub_items = []
        for ch in node.get("children", []):
            emitted = walk(ch, cur_modal)
            if emitted is not None:
                if isinstance(emitted, list):
                    sub_items.extend(emitted)
                else:
                    sub_items.append(emitted)
        child_items.extend(sub_items)
        if not sub_items:
            raw_bg = node.get("bgName")
            leaf_name = raw_bg if (raw_bg and not str(raw_bg).startswith("bg-")) else name
            if child_items and not node.get("isGroup", False):
                child_items[0]["name"] = leaf_name
                if flat_spec_children and flat_spec_children[-1].get("name") == bg_name:
                    flat_spec_children[-1]["name"] = leaf_name
                if cur_modal and modal_targets and modal_targets[-1] == bg_name:
                    modal_targets[-1] = leaf_name
                return child_items[0]
            if not child_items and not str(leaf_name).startswith("sp-") and not node.get("isGroup", False) and node is not root_node:
                if cur_modal:
                    modal_targets.append(leaf_name)
                flat_spec_children.append({
                    "kind": "rect", "name": leaf_name, "x": nx, "y": ny, "w": nw, "h": nh,
                    "fill": "#FFFFFF00", "stroke": None, "radius": 0, "inModal": cur_modal,
                })
                return make_axvg_vector_shape(
                    next_id(), leaf_name, nx, ny, nw, nh,
                    fill_hex="#FFFFFF00", stroke_hex=None, radius=0,
                    alpha=float(node.get("opacity", 1.0)), stroke_width=0, border_sides=0,
                    rotation=node.get("rotation"),
                )
        if not child_items:
            return None
        if node.get("isGroup", False):
            return {
                "flippedHorizontal": False,
                "flippedVertical": False,
                "id": next_id(),
                "name": name,
                "visible": True,
                "isLocked": False,
                "isNameDynamic": False,
                "rotation": float(node.get("rotation") or 0),
                "rect": {"location": {"x": nx, "y": ny}, "size": {"width": nw, "height": nh}},
                "resizingConstraints": {
                    "hasFixedLeft": True,
                    "hasFixedRight": False,
                    "hasFixedTop": True,
                    "hasFixedBottom": False,
                    "hasFixedWidth": True,
                    "hasFixedHeight": True,
                },
                "itemType": 0,
                "effects": [],
                "scene": {"items": child_items},
            }
        return child_items

    top_items = walk(root_node, False)
    if top_items is None:
        items_list = []
    elif isinstance(top_items, list):
        items_list = top_items
    else:
        items_list = [top_items]
    non_zero = [c for c in flat_spec_children if c.get("x", 0) > 0 and c.get("y", 0) > 0 and not c.get("inModal")]
    others = [c for c in flat_spec_children if c not in non_zero]
    ordered_spec_children = non_zero + others
    bg_hex = (resolve_color(root_node.get("fill", "$bg"), theme_dict) or "#F4F6F9") if canvas_background else "#00000000"
    bg_color_obj = hex_to_rgb_float(bg_hex, 1.0)
    frame_name = root_node.get("name", "Page")
    shell_opts = root_node.get("_phone_shell_opts")
    if not shell_opts:
        for ch in (root_node.get("children") or []):
            if isinstance(ch, dict) and ch.get("_phone_shell_opts"):
                shell_opts = ch.get("_phone_shell_opts")
                break
    axvg_doc = {
        "masters": {},
        "imageMap": image_map,
        "scene": {
            "items": [
                {
                    "id": "frame-1",
                    "name": f"frame-{frame_name}",
                    "itemType": 2,
                    "isNameDynamic": False,
                    "rect": {"location": {"x": 0, "y": 0}, "size": {"width": root_node["_w"], "height": root_node["_h"]}},
                    "resizingConstraints": {
                        "hasFixedLeft": True,
                        "hasFixedRight": False,
                        "hasFixedTop": True,
                        "hasFixedBottom": False,
                        "hasFixedWidth": True,
                        "hasFixedHeight": True,
                    },
                    "backgroundFill": {"type": 1, "enabled": True, "color": bg_color_obj},
                    "backgroundShape": make_axvg_vector_shape("bg-1", f"bg-frame-{frame_name}", 0, 0, root_node["_w"], root_node["_h"], fill_hex=bg_hex) if canvas_background else None,
                    "scene": {"items": items_list},
                }
            ]
        },
    }
    spec_doc = {
        "frames": [
            {
                "name": frame_name,
                "w": root_node["_w"],
                "h": root_node["_h"],
                "bg": bg_hex,
                "children": ordered_spec_children,
            }
        ],
        "images": {k: True for k in image_map.keys()},
    }
    return {
        "axvg": axvg_doc,
        "spec": spec_doc,
        "flatChildren": flat_spec_children,
        "masterInstances": master_instances,
        "dynamicPanels": dynamic_panels,
        "repeaters": repeaters,
        "nativeInputs": native_inputs,
        "nativeStyles": native_styles,
        "modalTargets": modal_targets,
        "phoneShellOpts": shell_opts,
        "screenBgHex": resolve_color(root_node.get("fill", "$bg"), theme_dict) or "#F4F6F9",
    }


def compose_device_shell(emitted, page_prefix, shell_name="iphone-x"):
    """将已发射的内屏 (375×812、393×852 或 402×874) 自动装入内置手机壳画板，叠加外框、状态栏与 Home Indicator。"""
    manifest_path = os.path.join(ASSETS_SPEC_DIR, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    shells = manifest.get("shells", {})
    modern_shells = {
        "iphone-17": {"outerSize": [442, 914], "screenRect": [20, 20, 402, 874], "synthetic": True},
        "iphone-17-pro": {"outerSize": [442, 914], "screenRect": [20, 20, 402, 874], "synthetic": True},
        "iphone-16": {"outerSize": [433, 892], "screenRect": [20, 20, 393, 852], "synthetic": True},
        "iphone-16-pro": {"outerSize": [433, 892], "screenRect": [20, 20, 393, 852], "synthetic": True},
    }
    shell_cfg = shells.get(shell_name) or modern_shells.get(shell_name) or shells.get("iphone-x")
    outer_w, outer_h = shell_cfg["outerSize"]
    sx, sy, sw, sh = shell_cfg["screenRect"]

    axvg = emitted["axvg"]
    spec_doc = emitted["spec"]
    frame = axvg["scene"]["items"][0]
    content_items = frame["scene"]["items"]

    def translate_axvg_item(it):
        r = it.get("rect")
        if r and "location" in r:
            r["location"]["x"] = int(r["location"]["x"]) + sx
            r["location"]["y"] = int(r["location"]["y"]) + sy
            if shell_cfg.get("synthetic") and it.get("itemType") == 1:
                loc = r["location"]
                sz = r.get("size") or {}
                if loc.get("x") == sx and loc.get("y") == sy and sz.get("width") == sw and sz.get("height") >= sh - 40:
                    cur_c = (it.get("corners") or [0])[0]
                    if cur_c < 44:
                        it["corners"] = [44, 44, 44, 44]
        for ch in (it.get("scene") or {}).get("items", []):
            translate_axvg_item(ch)

    for it in content_items:
        translate_axvg_item(it)

    for dp in emitted.get("dynamicPanels", []):
        dp["x"] += sx
        dp["y"] += sy
    for rep in emitted.get("repeaters", []):
        rep["x"] += sx
        rep["y"] += sy
    for ni in emitted.get("nativeInputs", []):
        ni["x"] += sx
        ni["y"] += sy
    for instance in emitted.get("masterInstances", []):
        instance["x"] += sx
        instance["y"] += sy

    underlay_widgets = []
    underlay_specs = []
    overlay_widgets = []
    overlay_specs = []
    img_map = dict(axvg.get("imageMap") or {})

    if shell_cfg.get("synthetic"):
        shell_opts = emitted.get("phoneShellOpts") or {}
        screen_bg = emitted.get("screenBgHex") or "#FAF8F4"
        side_buttons = [
            ("btn-action", 2, 150, 4, 26),
            ("btn-vol-up", 2, 198, 4, 52),
            ("btn-vol-dn", 2, 264, 4, 52),
            ("btn-power", outer_w - 6, 208, 4, 84),
            ("btn-camera", outer_w - 6, 320, 4, 40),
        ]
        for b_tag, bx, by, bw, bh in side_buttons:
            bnm = f"{page_prefix}-img-device-{b_tag}"
            underlay_widgets.append(
                make_axvg_vector_shape(f"id-{bnm}", bnm, bx, by, bw, bh, fill_hex="#52525B", radius=2)
            )
            underlay_specs.append({
                "kind": "rect", "name": bnm, "x": bx, "y": by, "w": bw, "h": bh,
                "fill": "#52525B", "stroke": None, "radius": 2, "inModal": False, "_deviceShellPiece": True,
            })
        rim_nm = f"{page_prefix}-img-device-frame-rim"
        underlay_widgets.append(
            make_axvg_vector_shape(f"id-{rim_nm}", rim_nm, 6, 6, outer_w - 12, outer_h - 12, fill_hex="#3F3F46", stroke_hex="#71717A", radius=56, stroke_width=1.5)
        )
        underlay_specs.append({
            "kind": "rect", "name": rim_nm, "x": 6, "y": 6, "w": outer_w - 12, "h": outer_h - 12,
            "fill": "#3F3F46", "stroke": "#71717A", "radius": 56, "inModal": False, "_deviceShellPiece": True,
        })
        bezel_nm = f"{page_prefix}-img-device-frame-bezel"
        underlay_widgets.append(
            make_axvg_vector_shape(f"id-{bezel_nm}", bezel_nm, 10, 10, outer_w - 20, outer_h - 20, fill_hex="#09090B", stroke_hex="#27272A", radius=52, stroke_width=1)
        )
        underlay_specs.append({
            "kind": "rect", "name": bezel_nm, "x": 10, "y": 10, "w": outer_w - 20, "h": outer_h - 20,
            "fill": "#09090B", "stroke": "#27272A", "radius": 52, "inModal": False, "_deviceShellPiece": True,
        })
        scr_nm = f"{page_prefix}-img-device-screen-base"
        underlay_widgets.append(
            make_axvg_vector_shape(f"id-{scr_nm}", scr_nm, sx, sy, sw, sh, fill_hex=screen_bg, radius=44)
        )
        underlay_specs.append({
            "kind": "rect", "name": scr_nm, "x": sx, "y": sy, "w": sw, "h": sh,
            "fill": screen_bg, "stroke": None, "radius": 44, "inModal": False, "_deviceShellPiece": True,
        })
        # Foreground fills are not clipped by a rounded parent in Axure.
        # Cover only the pixels outside the display, leaving every UI object editable.
        # The rim and bezel sit under the content, so the mask repaints them (and the white
        # frame outside) instead of going transparent there; otherwise square content corners show.
        screen_mask = Image.new("RGBA", (sw * 2, sh * 2), "#FFFFFF")
        mask_draw = ImageDraw.Draw(screen_mask)
        rim_o, bezel_o = (sx - 6) * 2, (sx - 10) * 2
        mask_draw.rounded_rectangle(
            [-rim_o, -rim_o, sw * 2 + rim_o - 1, sh * 2 + rim_o - 1], radius=112,
            fill="#3F3F46", outline="#71717A", width=3)
        mask_draw.rounded_rectangle(
            [-bezel_o, -bezel_o, sw * 2 + bezel_o - 1, sh * 2 + bezel_o - 1], radius=104,
            fill="#09090B", outline="#27272A", width=2)
        screen_hole = Image.new("L", screen_mask.size, 255)
        ImageDraw.Draw(screen_hole).rounded_rectangle(
            [0, 0, sw * 2 - 1, sh * 2 - 1], radius=88, fill=0)
        screen_mask.putalpha(screen_hole)
        for corner, cx, cy in (("tl", 0, 0), ("tr", sw - 44, 0),
                               ("bl", 0, sh - 44), ("br", sw - 44, sh - 44)):
            mask_key, mask_data = _encode_pil_png(screen_mask.crop(
                (cx * 2, cy * 2, (cx + 44) * 2, (cy + 44) * 2)))
            img_map[mask_key] = mask_data
            mask_name = f"{page_prefix}-img-device-screen-mask-{corner}"
            overlay_widgets.append(make_axvg_image_shape(
                f"id-{mask_name}", mask_name, sx + cx, sy + cy, 44, 44, mask_key))
            overlay_specs.append({
                "kind": "image", "name": mask_name, "x": sx + cx, "y": sy + cy, "w": 44, "h": 44,
                "imageKey": mask_key, "b64": mask_data, "inModal": False, "_deviceShellPiece": True,
            })
        if shell_opts.get("darkIsland", True) is not False:
            island_w, island_h = 122, 34
            island_x = sx + (sw - island_w) // 2
            island_y = sy + 10
            island_nm = f"{page_prefix}-img-device-dynamic-island"
            overlay_widgets.append(
                make_axvg_vector_shape(f"id-{island_nm}", island_nm, island_x, island_y, island_w, island_h, fill_hex="#09090B", radius=12)
            )
            overlay_specs.append({
                "kind": "rect", "name": island_nm, "x": island_x, "y": island_y, "w": island_w, "h": island_h,
                "fill": "#09090B", "stroke": None, "radius": 17, "inModal": False, "_deviceShellPiece": True,
            })
            cam_nm = f"{page_prefix}-img-device-island-lens"
            cam_x = island_x + island_w - 22
            cam_y = island_y + 11
            overlay_widgets.append(
                make_axvg_vector_shape(f"id-{cam_nm}", cam_nm, cam_x, cam_y, 10, 10, fill_hex="#1B2431", stroke_hex="#2B3546", radius=5, stroke_width=1)
            )
            overlay_specs.append({
                "kind": "rect", "name": cam_nm, "x": cam_x, "y": cam_y, "w": 12, "h": 12,
                "fill": "#1B2431", "stroke": "#2B3546", "radius": 5, "inModal": False, "_deviceShellPiece": True,
            })
        if shell_opts.get("showHomeIndicator", True) is not False:
            hi_w, hi_h = 134, 5
            hi_x = sx + (sw - hi_w) // 2
            hi_y = sy + sh - 12
            hi_nm = f"{page_prefix}-img-device-home-indicator"
            overlay_widgets.append(
                make_axvg_vector_shape(f"id-{hi_nm}", hi_nm, hi_x, hi_y, hi_w, hi_h, fill_hex="#18181B", radius=999)
            )
            overlay_specs.append({
                "kind": "rect", "name": hi_nm, "x": hi_x, "y": hi_y, "w": hi_w, "h": hi_h,
                "fill": "#18181B", "stroke": None, "radius": 999, "inModal": False, "_deviceShellPiece": True,
            })
    else:
        for piece in shell_cfg.get("pieces", []):
            img_info = load_image_asset(piece["file"])
            img_map[img_info["key"]] = img_info["b64"]
            ov_name = f"{page_prefix}-img-device-{piece['name']}"
            px, py, pw, ph = piece["x"], piece["y"], piece["w"], piece["h"]
            overlay_widgets.append(make_axvg_image_shape(f"id-{ov_name}", ov_name, px, py, pw, ph, img_info["key"]))
            overlay_specs.append({
                "kind": "image",
                "name": ov_name,
                "x": px,
                "y": py,
                "w": pw,
                "h": ph,
                "imageKey": img_info["key"],
                "pngPath": img_info["path"],
                "inModal": False,
                "_deviceShellPiece": True,
            })

    frame["scene"]["items"] = underlay_widgets + content_items + overlay_widgets
    frame["name"] = f"frame-{page_prefix}"
    frame["rect"] = {"location": {"x": 0, "y": 0}, "size": {"width": outer_w, "height": outer_h}}
    frame["backgroundFill"] = {"type": 1, "enabled": True, "color": hex_to_rgb_float("#FFFFFF", 1.0)}
    frame["backgroundShape"] = make_axvg_vector_shape(
        f"bg-device-{page_prefix}", f"bg-frame-{page_prefix}", 0, 0, outer_w, outer_h, fill_hex="#FFFFFF"
    )
    axvg["imageMap"] = img_map

    shifted_flat = list(underlay_specs)
    for ch in emitted["flatChildren"]:
        c2 = dict(ch)
        orig_x, orig_y = int(c2.get("x", 0)), int(c2.get("y", 0))
        c2["x"] = orig_x + sx
        c2["y"] = orig_y + sy
        if shell_cfg.get("synthetic") and c2.get("kind") == "rect" and orig_x == 0 and orig_y == 0 and int(c2.get("w", 0)) == sw and int(c2.get("h", 0)) >= sh - 40:
            c2["radius"] = max(int(c2.get("radius") or 0), 44)
        shifted_flat.append(c2)
    shifted_flat.extend(overlay_specs)

    non_zero = [c for c in shifted_flat if c.get("x", 0) > 0 and c.get("y", 0) > 0 and not c.get("inModal")]
    others = [c for c in shifted_flat if c not in non_zero]
    f0 = spec_doc["frames"][0]
    f0["name"] = page_prefix
    f0["w"], f0["h"], f0["bg"] = outer_w, outer_h, "#FFFFFF"
    f0["children"] = non_zero + others
    spec_doc["images"] = {k: True for k in img_map.keys()}

    emitted["flatChildren"] = shifted_flat
    emitted["device"] = {
        "shell": shell_name,
        "w": outer_w,
        "h": outer_h,
        "screenX": sx,
        "screenY": sy,
        "screenW": sw,
        "screenH": sh,
    }
    return emitted
