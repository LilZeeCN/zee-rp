# 从 scripts/proto.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 1;行为不变,勿手改)。
import base64
import io
import os
import re
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, RADIUS_TOKENS, SPACING_TOKENS
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
from .fonts import KINSOKU_HEAD, KINSOKU_TAIL, _measure_line_with_fallbacks, describe_unrenderable_glyphs, is_glyph_renderable_in_pingfang, load_fallback_font, load_font, resolve_glyph_font_path, wrap_text
from .tokens import hex_to_rgba_tuple, parse_padding

# -------------------- 4. MULTI-VIEW RENDERER & QUANTITATIVE AUDITOR --------------------
def render_flat_children_png(w, h, bg_hex, flat_children, include_modal=False, scale=1):
    """渲染高保真 1x/2x 原型预览图 (支持透明 PNG 叠加、圆角填充、描边、PingFang SC 精确垂直居中排版)。"""
    s = max(1, int(scale))
    img = Image.new("RGBA", (int(w) * s, int(h) * s), hex_to_rgba_tuple(bg_hex, 1.0))
    draw = ImageDraw.Draw(img, "RGBA")

    def render_one(ch):
        if ch.get("kind") == "image" and ((ch.get("pngPath") and os.path.isfile(ch["pngPath"])) or ch.get("b64")):
            if ch.get("pngPath") and os.path.isfile(ch["pngPath"]):
                pic = Image.open(ch["pngPath"]).convert("RGBA")
            else:
                pic = Image.open(io.BytesIO(base64.b64decode(ch["b64"]))).convert("RGBA")
            tw = max(1, int(round(ch["w"] * s)))
            th = max(1, int(round(ch["h"] * s)))
            pic = pic.resize((tw, th), Image.Resampling.LANCZOS)
            img.alpha_composite(pic, (int(round(ch["x"] * s)), int(round(ch["y"] * s))))
        else:
            draw_child_item(draw, ch, scale=s, base_img=img)

    if include_modal:
        for ch in flat_children:
            if not ch.get("inModal") and not ch.get("_whenHiddenPreview"):
                render_one(ch)
        draw.rectangle([0, 0, int(w) * s, int(h) * s], fill=(15, 23, 42, 136))
        for ch in flat_children:
            if ch.get("inModal") and not ch.get("_whenHiddenPreview"):
                render_one(ch)
    else:
        for ch in flat_children:
            if ch.get("inModal") or ch.get("_whenHiddenPreview"):
                continue
            render_one(ch)
    return img.convert("RGB")


def text_ink_geometry(child, scale=1):
    """The renderer and audit share placement, while ink is measured from the font."""
    scale = max(1, int(scale))
    x, y = int(round(child["x"] * scale)), int(round(child["y"] * scale))
    width = max(1, int(round(child["w"] * scale)))
    height = max(1, int(round(child["h"] * scale)))
    font_size = max(8, int(round(int(child.get("size", 14)) * scale)))
    font_weight = int(child.get("weight", 400))
    font = load_font(font_size, font_weight)
    spans = child.get("spans")
    dummy_draw = ImageDraw.Draw(Image.new("L", (1, 1)))
    padding = 8 * scale if (child.get("fill") or child.get("stroke")) else 0
    if isinstance(spans, list) and spans:
        tot_w = 0
        max_h = 0
        min_y = 0
        for sp in spans:
            stxt = str(sp.get("text", ""))
            if not stxt:
                continue
            s_sz = max(8, int(round(int(sp.get("fontSize", sp.get("size", child.get("size", 14)))) * scale)))
            s_wt = int(sp.get("fontWeight", sp.get("weight", ch.get("weight", 400) if "ch" in locals() else child.get("weight", 400))))
            sw, sh, sy0 = _measure_line_with_fallbacks(stxt, s_sz, s_wt)
            tot_w += sw
            max_h = max(max_h, sh)
            min_y = min(min_y, sy0) if min_y else sy0
        ink_w, ink_h = tot_w, max_h
        bbox = (0, min_y, ink_w, min_y + ink_h)
    else:
        text = str(child.get("text", ""))
        if all(is_glyph_renderable_in_pingfang(c) for c in text):
            bbox = dummy_draw.textbbox((0, 0), text, font=font)
            ink_w, ink_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        else:
            ink_w, ink_h, min_y = _measure_line_with_fallbacks(text, font_size, font_weight)
            bbox = (0, min_y, ink_w, min_y + ink_h)
        avail_w = max(1, width - 2 * padding)
        can_multiline = (
            (child.get("kind") != "rect" or bool(child.get("wrap")))
            and (not child.get("worstCase") or bool(child.get("wrap")))
            and (height >= int(round(font_size * 2.1)) or "\n" in text or bool(child.get("wrap")))
        )
        if can_multiline and (ink_w > avail_w or "\n" in text):
            fsz_1x = max(8, int(child.get("size", 14)))
            avail_w_1x = max(1, int(round(avail_w / float(scale))) - 2)
            wrapped_lines = wrap_text(text, avail_w_1x, fsz_1x, font_weight)
            if len(wrapped_lines) > 1:
                line_metrics = []
                for ln in wrapped_lines:
                    if not ln:
                        line_metrics.append((0, font_size, 0))
                    elif all(is_glyph_renderable_in_pingfang(c) for c in ln):
                        lb = dummy_draw.textbbox((0, 0), ln, font=font)
                        line_metrics.append((lb[2] - lb[0], lb[3] - lb[1], lb[1]))
                    else:
                        lw, lh, lmy = _measure_line_with_fallbacks(ln, font_size, font_weight)
                        line_metrics.append((lw, lh, lmy))
                max_lh = max((m[1] for m in line_metrics), default=font_size)
                _lh_override = child.get("lineHeight")
                line_step = int(round(float(_lh_override))) if isinstance(_lh_override, (int, float)) and _lh_override > 0 \
                    else max(int(round(font_size * 1.35)), max_lh)
                ink_w = max((m[0] for m in line_metrics), default=0)
                ink_h = (len(line_metrics) - 1) * line_step + line_metrics[-1][1]
                first_my = line_metrics[0][2]
                bbox = (0, first_my, ink_w, first_my + ink_h)
    _ls = child.get("letterSpacing")
    if isinstance(_ls, (int, float)) and _ls and not isinstance(_ls, bool):
        _txt = str(child.get("text", ""))
        if _txt:
            ink_w = ink_w + float(_ls) * scale * max(0, len(_txt) - 1)
    align = child.get("align", "left")
    if align == "center":
        tx = x + (width - ink_w) // 2
    elif align == "right":
        tx = x + width - ink_w - padding
    else:
        tx = x + padding
    vertical = child.get("textAlignment", 1)
    offset = 0 if vertical == 0 else height - ink_h if vertical == 2 else (height - ink_h) // 2
    ty = y + offset - bbox[1]
    return font, tx, ty, [tx + bbox[0], ty + bbox[1], ink_w, ink_h]


def _draw_text_with_fallbacks(draw, xy, text_str, font_size, font_weight, fill_rgba):
    f_main = load_font(font_size, font_weight)
    if all(is_glyph_renderable_in_pingfang(c) for c in text_str):
        draw.text(xy, text_str, font=f_main, fill=fill_rgba)
        return
    cur_x, cur_y = xy
    for ch in text_str:
        if is_glyph_renderable_in_pingfang(ch):
            f_use = f_main
        else:
            fp = resolve_glyph_font_path(ch)
            f_use = load_fallback_font(fp, font_size) if fp and fp != "PingFang.ttc" else f_main
        draw.text((cur_x, cur_y), ch, font=f_use, fill=fill_rgba)
        try:
            bb = f_use.getbbox(ch)
            cur_x += max(int(round(font_size * 0.55)) if not is_glyph_renderable_in_pingfang(ch) else 0, bb[2] - bb[0])
        except Exception:
            cur_x += int(round(font_size * 0.75))



def _draw_text_spaced(draw, xy, text_str, font_size, font_weight, fill_rgba, spacing):
    """按字距逐字绘制；spacing<=0 时退回整段绘制。"""
    if not spacing:
        _draw_text_with_fallbacks(draw, xy, text_str, font_size, font_weight, fill_rgba)
        return
    cur_x = xy[0]
    for ch in text_str:
        _draw_text_with_fallbacks(draw, (cur_x, xy[1]), ch, font_size, font_weight, fill_rgba)
        try:
            f = load_font(font_size, font_weight)
            cur_x += max(1, f.getbbox(ch)[2] - f.getbbox(ch)[0]) + spacing
        except Exception:
            cur_x += int(round(font_size * 0.75)) + spacing


def draw_child_item(draw, ch, scale=1, base_img=None):
    s = max(1, int(scale))
    x = int(round(ch["x"] * s))
    y = int(round(ch["y"] * s))
    cw = max(1, int(round(ch["w"] * s)))
    ch_val = max(1, int(round(ch["h"] * s)))
    fill_h = ch.get("fill")
    if isinstance(fill_h, str) and fill_h.strip().lower() in ("transparent", "none"):
        fill_h = None
    stroke_h = ch.get("stroke")
    if isinstance(stroke_h, str) and stroke_h.strip().lower() in ("transparent", "none"):
        stroke_h = None
    rad = max(0, min(int(round((ch.get("radius", 0) or 0) * s)), min(cw, ch_val) // 2))
    if fill_h or stroke_h:
        fill_rgba = hex_to_rgba_tuple(fill_h, 1.0) if fill_h else None
        stroke_rgba = hex_to_rgba_tuple(stroke_h, 1.0) if stroke_h else None
        if base_img is not None and ((fill_rgba and fill_rgba[3] < 255) or (stroke_rgba and stroke_rgba[3] < 255)):
            if fill_rgba:
                p_fill = Image.new("RGBA", (cw, ch_val), (0, 0, 0, 0))
                ImageDraw.Draw(p_fill, "RGBA").rounded_rectangle([0, 0, cw - 1, ch_val - 1], radius=rad, fill=fill_rgba)
                base_img.alpha_composite(p_fill, (max(0, x), max(0, y)))
            if stroke_rgba:
                p_strk = Image.new("RGBA", (cw, ch_val), (0, 0, 0, 0))
                ImageDraw.Draw(p_strk, "RGBA").rounded_rectangle([0, 0, cw - 1, ch_val - 1], radius=rad, outline=stroke_rgba, width=max(1, s))
                base_img.alpha_composite(p_strk, (max(0, x), max(0, y)))
        else:
            draw.rounded_rectangle(
                [x, y, x + cw - 1, y + ch_val - 1],
                radius=rad,
                fill=fill_rgba,
                outline=stroke_rgba,
                width=max(1, s) if stroke_rgba else 0,
            )
    txt = ch.get("text") if ch.get("text") is not None else ch.get("previewText")
    if txt is not None and str(txt) != "":
        ch_geom = {**ch, "text": txt} if ch.get("text") is None else ch
        font, tx, ty, ink_rect = text_ink_geometry(ch_geom, scale=s)
        font_size = max(8, int(round(int(ch.get("size", 14)) * s)))
        font_weight = int(ch.get("weight", 400))
        spans = ch.get("spans")
        if isinstance(spans, list) and spans:
            cur_x = tx
            base_bottom = ink_rect[1] + ink_rect[3]
            for sp in spans:
                stxt = str(sp.get("text", ""))
                if not stxt:
                    continue
                s_sz = max(8, int(round(int(sp.get("fontSize", sp.get("size", ch.get("size", 14)))) * s)))
                s_wt = int(sp.get("fontWeight", sp.get("weight", ch.get("weight", 400))))
                sw, sh, sy0 = _measure_line_with_fallbacks(stxt, s_sz, s_wt)
                sy = base_bottom - (sy0 + sh)
                scol = hex_to_rgba_tuple(sp.get("_resolved_color") or sp.get("color") or ch.get("color", "#1E293B"), 1.0)
                _draw_text_with_fallbacks(draw, (cur_x, sy), stxt, s_sz, s_wt, scol)
                cur_x += sw
        else:
            color_rgba = hex_to_rgba_tuple(ch.get("color", "#1E293B"), 1.0)
            padding = 8 * s if (ch.get("fill") or ch.get("stroke")) else 0
            avail_w = max(1, cw - 2 * padding)
            text_str = str(txt)
            can_multiline = (
                (ch.get("kind") != "rect" or bool(ch.get("wrap")))
                and (not ch.get("worstCase") or bool(ch.get("wrap")))
                and (ch_val >= int(round(font_size * 2.1)) or "\n" in text_str or bool(ch.get("wrap")))
            )
            wrapped_lines = None
            if can_multiline:
                fsz_1x = max(8, int(ch.get("size", 14)))
                avail_w_1x = max(1, int(round(avail_w / float(s))) - 2)
                cand_lines = wrap_text(text_str, avail_w_1x, fsz_1x, font_weight)
                if len(cand_lines) > 1:
                    wrapped_lines = cand_lines
            _spacing = float(ch.get("letterSpacing") or 0) * s
            if wrapped_lines:
                _lh = ch.get("lineHeight")
                line_step = int(round(float(_lh) * s)) if isinstance(_lh, (int, float)) and _lh > 0 \
                    else max(int(round(font_size * 1.35)), font_size)
                for idx, ln in enumerate(wrapped_lines):
                    if not ln:
                        continue
                    _draw_text_spaced(draw, (tx, ty + idx * line_step), ln, font_size, font_weight, color_rgba, _spacing)
            else:
                _draw_text_spaced(draw, (tx, ty), text_str, font_size, font_weight, color_rgba, _spacing)


def render_structure_overlay_png(base_img, root_node, dynamic_panels, dx=0, dy=0):
    """生成 02-structure.png：在原型图上叠加原生 Layer 编组框与 DynamicPanel 容器边界。"""
    img = base_img.convert("RGBA")
    draw = ImageDraw.Draw(img, "RGBA")
    f = load_font(10, 600)
    def walk_groups(n, depth=0):
        if n.get("isModal"):
            return
        if n.get("isGroup") and "_x" in n:
            gx, gy, gw, gh = n["_x"] + dx, n["_y"] + dy, n["_w"], n["_h"]
            color = (37, 99, 235, 190) if depth <= 2 else (16, 185, 129, 150)
            draw.rectangle([gx, gy, gx + gw - 1, gy + gh - 1], outline=color, width=1)
            if depth <= 2:
                lbl = n.get("name", "grp")
                draw.rectangle([gx, gy, gx + min(gw, len(lbl) * 6 + 8), gy + 14], fill=color)
                draw.text((gx + 3, gy + 1), lbl, font=f, fill=(255, 255, 255, 255))
        for c in n.get("children", []):
            walk_groups(c, depth + 1)
    walk_groups(root_node, 0)
    for dp in dynamic_panels:
        px, py, pw, ph = dp["x"], dp["y"], dp["w"], dp["h"]
        draw.rectangle([px, py, px + pw - 1, py + ph - 1], outline=(245, 158, 11, 240), width=2)
        tag = f"DynamicPanel: {dp['name']} ({len(dp['states'])} states)"
        draw.rectangle([px, py, px + len(tag) * 6 + 12, py + 16], fill=(245, 158, 11, 240))
        draw.text((px + 4, py + 2), tag, font=f, fill=(255, 255, 255, 255))
    return img.convert("RGB")


def count_axvg_group_coverage(axvg_doc):
    """统计 Axvg 树中的叶节点总数、位于原生 Group (itemType: 0) 内的叶节点占比、语义命名率与重名列表。"""
    total_leaves = 0
    grouped_leaves = 0
    semantic_named = 0
    name_counts = {}
    non_semantic_names = []
    ungrouped_names = []
    bad_name_re = re.compile(r"^(?:色块-\d+|文本-\d+|Unnamed|Rectangle|Shape|w\d+)$", re.I)

    def visit(items, inside_group=False):
        nonlocal total_leaves, grouped_leaves, semantic_named
        for it in items:
            itype = it.get("itemType")
            nm = str(it.get("name") or "").strip()
            if nm:
                name_counts[nm] = name_counts.get(nm, 0) + 1
            if itype == 0:
                if nm and not bad_name_re.match(nm):
                    semantic_named += 1
                else:
                    non_semantic_names.append(nm or "<UnnamedGroup>")
                total_leaves += 1
                grouped_leaves += 1
                visit(it.get("scene", {}).get("items", []), True)
            else:
                total_leaves += 1
                if inside_group or "-img-device-" in nm:
                    grouped_leaves += 1
                else:
                    ungrouped_names.append(nm or "<UnnamedLeaf>")
                if nm and not bad_name_re.match(nm) and it.get("isNameDynamic") is False:
                    semantic_named += 1
                else:
                    non_semantic_names.append(nm or "<UnnamedLeaf>")

    frames = axvg_doc.get("scene", {}).get("items", axvg_doc.get("items", []))
    for fr in frames:
        visit(fr.get("scene", {}).get("items", []), False)
    dup_names = sorted([k for k, v in name_counts.items() if v > 1])
    return {
        "totalNodes": total_leaves,
        "groupedNodes": grouped_leaves,
        "semanticNodes": semantic_named,
        "groupCoveragePct": round(100.0 * grouped_leaves / max(1, total_leaves), 2),
        "semanticNamingPct": round(100.0 * semantic_named / max(1, total_leaves), 2),
        "duplicateNames": dup_names,
        "duplicateNameCount": len(dup_names),
        "nameCounts": {k: v for k, v in name_counts.items() if v > 1},
        "nonSemanticNames": non_semantic_names,
        "ungroupedNames": ungrouped_names,
    }


def ensure_unique_names(root_node, scope_prefix=""):
    """递归检查并自动修复节点树中的重名元件，确保单页/单状态内 0 重名。"""
    seen = {}

    def visit(n):
        nm = str(n.get("name") or "").strip()
        if nm:
            if scope_prefix and not nm.startswith(scope_prefix) and nm in ("view-time", "status-time", "nav-title", "btn-back"):
                nm = f"{scope_prefix}-{nm}"
                n["name"] = nm
            cnt = seen.get(nm, 0) + 1
            seen[nm] = cnt
            if cnt > 1:
                n["name"] = f"{nm}-{cnt}"
        bg = n.get("bgName")
        if bg:
            bcnt = seen.get(bg, 0) + 1
            seen[bg] = bcnt
            if bcnt > 1:
                n["bgName"] = f"{bg}-{bcnt}"
        for ch in n.get("children", []):
            visit(ch)

    visit(root_node)
    return root_node


def audit_prototype(root_node, emitted_preview, compile_plan, strict_audit=False):
    """执行领域自适应的两级量化审计：结构与安全门禁 (硬失败) + 审美与令牌门禁 (默认告警，--strict-audit 下升级为硬失败)。"""
    flat = [c for c in emitted_preview["flatChildren"] if not c.get("inModal") and not c.get("_repeaterPreviewExtraRow")]
    # Check the actual native scene, not just the offline text placement: a
    # transparent button must retain the same centering as a filled button.
    native_alignment = {}
    def index_alignment(item):
        if "textAlignment" in item:
            native_alignment[item.get("name")] = item["textAlignment"]
        for child in item.get("scene", {}).get("items", []):
            index_alignment(child)
    for item in emitted_preview.get("axvg", {}).get("scene", {}).get("items", []):
        index_alignment(item)
    alignment_mismatches = [c for c in flat if "_expectedTextAlignment" in c
                            and native_alignment.get(c.get("name")) != c["_expectedTextAlignment"]]
    # 遮挡审计：文字墨迹被后续不透明图元大面积覆盖时告警（此前完全无检查，容易“全绿但难看”）
    _opaque_later = []
    for _idx, _ch in enumerate(flat):
        _fill = str(_ch.get("fill") or "")
        _is_text = bool(_ch.get("text")) or _ch.get("kind") in ("text", "para")
        _opaque = (not _is_text) and _fill and not _fill.endswith("00") and _fill.upper() not in ("#FFFFFF00", "TRANSPARENT", "NONE")
        _opaque_later.append((_idx, _ch, _opaque))
    _occluded = []
    for _idx, _ch, _ in _opaque_later:
        if not (bool(_ch.get("text")) or _ch.get("kind") in ("text", "para")):
            continue
        try:
            _font, _tx, _ty, _ink = text_ink_geometry(dict(_ch))
        except Exception:
            continue
        _area = max(1.0, _ink[2] * _ink[3])
        for _jdx, _other, _is_opaque in _opaque_later[_idx + 1:]:
            if not _is_opaque:
                continue
            _ox, _oy, _ow, _oh = _other.get("x", 0), _other.get("y", 0), _other.get("w", 0), _other.get("h", 0)
            _x0, _y0 = max(_ink[0], _ox), max(_ink[1], _oy)
            _x1, _y1 = min(_ink[0] + _ink[2], _ox + _ow), min(_ink[1] + _ink[3], _oy + _oh)
            if _x1 > _x0 and _y1 > _y0 and ((_x1 - _x0) * (_y1 - _y0)) / _area > 0.5:
                _occluded.append(f"{_ch.get('name') or _ch.get('id')} 被后声明的 {_other.get('name') or _other.get('id')} 遮挡 {int(round(((_x1-_x0)*(_y1-_y0))/_area*100))}%")
                break
    dev_info = emitted_preview.get("device")
    canvas_w = dev_info["w"] if dev_info else root_node["_w"]
    canvas_h = dev_info["h"] if dev_info else root_node["_h"]
    canvas_area = float(max(1, canvas_w * canvas_h))
    effective_screen_area = (
        float(max(1, int(dev_info.get("screenW", canvas_w)) * int(dev_info.get("screenH", canvas_h))))
        if dev_info
        else canvas_area
    )
    raw_syms = compile_plan.get("sourceSymbols") or []
    sym_list = raw_syms.values() if isinstance(raw_syms, dict) else raw_syms
    sym_displays = [str(v.get("display", "")) for v in sym_list if isinstance(v, dict)]
    has_mobile_shell = any(
        any(k in d for k in ("设备 /", "PhoneShell", "灵动岛", "Home Indicator", "状态栏"))
        for d in sym_displays
    ) or any(
        "-img-device-" in str(c.get("name", ""))
        or any(k in str(c.get("name", "")) for k in ("phone_shell", "home_indicator", "island"))
        for c in flat
    ) or (canvas_w <= 500 and canvas_h >= 750 and canvas_h >= canvas_w * 1.7)
    domain = compile_plan.get("domain") or ("mobile" if (dev_info or has_mobile_shell or str(compile_plan.get("theme", "")).startswith("mobile-")) else "web")
    is_mobile_or_doc = bool(dev_info) or has_mobile_shell or domain in ("mobile", "doc") or str(compile_plan.get("theme", "")).startswith("mobile-")
    is_small_or_test = domain == "test" or canvas_area < 200000.0

    # 1. 对齐误差
    align_errors = []
    for c in flat:
        ex = abs(float(c["x"]) - round(float(c["x"]))) + abs(float(c["y"]) - round(float(c["y"])))
        align_errors.append(ex)
    alignment_error_px = round(max(align_errors) if align_errors else 0.0, 3)

    # 2. 间距与圆角令牌合规率
    spacing_checks = []
    spacing_violations = []
    def check_tree_tokens(n):
        nm = n.get("name") or n.get("type") or "node"
        if "gap" in n and n["gap"] is not None and "_paragraphGap" not in n:
            ok = int(n["gap"]) in SPACING_TOKENS
            spacing_checks.append(ok)
            if not ok:
                spacing_violations.append(f"{nm}.gap={n['gap']}")
        if "padding" in n and n["padding"] is not None:
            for pv in parse_padding(n["padding"]):
                ok = int(pv) in SPACING_TOKENS
                spacing_checks.append(ok)
                if not ok:
                    spacing_violations.append(f"{nm}.padding={pv}")
        if "radius" in n and n["radius"] is not None:
            ok = int(n["radius"]) in RADIUS_TOKENS
            spacing_checks.append(ok)
            if not ok:
                spacing_violations.append(f"{nm}.radius={n['radius']}")
        for ch in n.get("children", []):
            check_tree_tokens(ch)
    check_tree_tokens(root_node)
    spacing_passed = sum(1 for ok in spacing_checks if ok)
    spacing_total = len(spacing_checks)
    spacing_compliance_pct = round(100.0 * spacing_passed / spacing_total, 2) if spacing_total else None

    # 3. 字体字阶合规率
    font_checks = []
    font_violations = []
    for c in flat:
        if c.get("text"):
            sz = int(c.get("size", 14))
            wt = int(c.get("weight", 400))
            ok = sz in FONT_SIZE_TOKENS and wt in FONT_WEIGHT_TOKENS
            font_checks.append(ok)
            if not ok:
                font_violations.append(f"{c.get('name', 'text')}(size={sz},weight={wt})")
    font_passed = sum(1 for ok in font_checks if ok)
    font_total = len(font_checks)
    font_compliance_pct = round(100.0 * font_passed / font_total, 2) if font_total else None

    # 4. 留白率
    fg_mask = Image.new("L", (canvas_w, canvas_h), 0)
    fg_draw = ImageDraw.Draw(fg_mask)
    for c in flat:
        if c.get("_whenHiddenPreview"):
            continue
        if c.get("_deviceShellPiece") or "-img-device-" in str(c.get("name", "")):
            continue
        _c_fill = str(c.get("fill") or "").strip().lower()
        _c_strk = str(c.get("stroke") or "").strip().lower()
        if not c.get("text") and c.get("kind") != "image" and _c_fill in ("", "transparent", "none") and _c_strk in ("", "transparent", "none"):
            continue
        area = c["w"] * c["h"]
        if area > effective_screen_area * 0.10 and not c.get("text"):
            continue
        fg_draw.rectangle([c["x"], c["y"], c["x"] + c["w"] - 1, c["y"] + c["h"] - 1], fill=255)
    hist = fg_mask.histogram()
    fg_pixels = sum(hist[1:])
    whitespace_ratio_pct = round(max(0.0, min(100.0, 100.0 * (1.0 - fg_pixels / effective_screen_area))), 2)

    # 5. 色彩收敛度
    raw_colors = set()
    for c in flat:
        if c.get("_deviceShellPiece") or "-img-device-" in str(c.get("name", "")):
            continue
        for k in ("fill", "stroke", "color"):
            if c.get(k):
                col_s = str(c[k]).strip().upper()
                if col_s in ("TRANSPARENT", "NONE") or (col_s.startswith("#") and len(col_s) == 9 and col_s.endswith("00")):
                    continue
                raw_colors.add(col_s[:7] if col_s.startswith("#") and len(col_s) == 9 else col_s)
    colors = []
    for col_s in sorted(raw_colors):
        if col_s.startswith("#") and len(col_s) == 7:
            try:
                rgb_cur = (int(col_s[1:3], 16), int(col_s[3:5], 16), int(col_s[5:7], 16))
                if any(
                    eh.startswith("#") and len(eh) == 7 and
                    ((rgb_cur[0] - int(eh[1:3], 16)) ** 2 + (rgb_cur[1] - int(eh[3:5], 16)) ** 2 + (rgb_cur[2] - int(eh[5:7], 16)) ** 2) ** 0.5 <= 36.0
                    for eh in colors
                ):
                    continue
            except Exception:
                pass
        colors.append(col_s)

    # 6. 文本重叠、文本裁切、缺字墨水高度与避头尾 (Kinsoku) 检查
    text_boxes = [c for c in flat if c.get("text")]
    ink_boxes = {id(child): text_ink_geometry(child)[3] for child in text_boxes}
    text_overlap_count = 0
    text_clip_count = 0
    missing_glyph_count = 0
    kinsoku_violation_count = 0
    failures = []  # 明细：覆盖全部 10 项 structural_gates，含 page/gate/widget/box/detail
    for i, a in enumerate(text_boxes):
        txt_str = str(a["text"])
        ink = ink_boxes[id(a)]
        ix, iy, iw, ih = ink
        overflow = {"left": max(0, a["x"] - ix), "top": max(0, a["y"] - iy),
                    "right": max(0, ix + iw - a["x"] - a["w"]),
                    "bottom": max(0, iy + ih - a["y"] - a["h"])}
        if any(overflow.values()):
            text_clip_count += 1
            failures.append({"gate": "no_text_clip", "severity": "structural",
                             "widget": a.get("name", ""), "text": txt_str[:80],
                             "box": [a["x"], a["y"], a["w"], a["h"]], "inkBox": ink,
                             "needed_w": iw, "needed_h": ih, "actual_w": a["w"], "actual_h": a["h"],
                             "overflow": overflow, "detail": f"文字墨迹 {iw}×{ih}px 超出声明盒子 {a['w']}×{a['h']}px"})
        elif isinstance(a.get("worstCase"), dict) and a["worstCase"].get("worstText") and str(a["worstCase"]["worstText"]) != txt_str:
            wc = a["worstCase"]
            wc_txt = str(wc["worstText"])
            wc_ink = text_ink_geometry({**a, "text": wc_txt})[3]
            wix, wiy, wiw, wih = wc_ink
            wc_overflow = {"left": max(0, a["x"] - wix), "top": max(0, a["y"] - wiy),
                           "right": max(0, wix + wiw - a["x"] - a["w"]),
                           "bottom": max(0, wiy + wih - a["y"] - a["h"])}
            if any(wc_overflow.values()):
                text_clip_count += 1
                w_ptr = (wc.get("pointer", "") or "/") + "/w"
                failures.append({
                    "gate": "no_text_clip",
                    "code": "E_DATASET_WORST_CASE_OVERFLOW",
                    "severity": "structural",
                    "widget": a.get("name", ""),
                    "symbolId": wc.get("symbolId", ""),
                    "pointer": w_ptr,
                    "worstRowIndex": wc.get("worstRowIndex", 0),
                    "text": wc_txt[:80],
                    "box": [a["x"], a["y"], a["w"], a["h"]],
                    "inkBox": wc_ink,
                    "inkEnvelope": wc,
                    "needed_w": wiw + 4,
                    "needed_h": wih,
                    "actual_w": a["w"],
                    "actual_h": a["h"],
                    "overflow": wc_overflow,
                    "candidatePatches": [
                        {"description": f"Expand width to {wiw + 8}px", "operations": [{"op": "replace", "path": w_ptr, "value": wiw + 8}]},
                        {"description": "Use elastic width 'fill'", "operations": [{"op": "replace", "path": w_ptr, "value": "fill"}]},
                    ],
                    "detail": f"数据集第 {wc.get('worstRowIndex', 0)} 行极值文字 '{wc_txt[:30]}' 墨迹 {wiw}×{wih}px 超出声明盒子 {a['w']}×{a['h']}px",
                })
        _allow_fallback = bool(
            compile_plan.get("language") == "rp/1"
            or str(compile_plan.get("language", "")).startswith("rp/")
            or compile_plan.get("sourceSymbols")
            or compile_plan.get("allowFallbackFonts")
        )
        _bad_details = describe_unrenderable_glyphs(txt_str, allow_fallback=_allow_fallback)
        if _bad_details:
            _bad_chars = [d["char"] for d in _bad_details]
            _bad_cps = [d["codepoint"] for d in _bad_details]
            _bad_sugs = [d["suggestion"] for d in _bad_details if d.get("suggestion")]
            missing_glyph_count += 1
            failures.append({
                "gate": "no_missing_glyphs",
                "severity": "structural",
                "page": compile_plan.get("pageName", ""),
                "widget": a.get("name", ""),
                "text": txt_str[:80],
                "chars": _bad_chars,
                "codepoints": _bad_cps,
                "glyphDetails": _bad_details,
                "measurementFont": _bad_details[0].get("measurementFont", "PingFang.ttc"),
                "suggestion": "；".join(_bad_sugs) if _bad_sugs else "请替换为 ASCII/常规中文字符或 SVG 图标",
                "box": [a["x"], a["y"], a["w"], a["h"]],
                "detail": f"{len(_bad_chars)} 个字符 ({', '.join(f'{c}[{cp}]' for c, cp in zip(_bad_chars, _bad_cps))}) 零墨水高度",
            })
        nm_str = str(a.get("name", ""))
        t_strip = txt_str.strip()
        m_line = re.search(r"-l(\d+)$", nm_str)
        if m_line and t_strip:
            if int(m_line.group(1)) >= 2 and t_strip[0] in KINSOKU_HEAD:
                kinsoku_violation_count += 1
                failures.append({"gate": "no_kinsoku_violation", "severity": "structural",
                                 "widget": nm_str, "text": txt_str[:80],
                                 "char": t_strip[0], "rule": "kinsoku_head",
                                 "box": [a["x"], a["y"], a["w"], a["h"]],
                                 "detail": f"行首出现避头标点 '{t_strip[0]}'"})
            if t_strip[-1] in KINSOKU_TAIL:
                kinsoku_violation_count += 1
                failures.append({"gate": "no_kinsoku_violation", "severity": "structural",
                                 "widget": nm_str, "text": txt_str[:80],
                                 "char": t_strip[-1], "rule": "kinsoku_tail",
                                 "box": [a["x"], a["y"], a["w"], a["h"]],
                                 "detail": f"行尾出现避尾标点 '{t_strip[-1]}'"})
        ctx_a = {wg: wb for wg, wb, _ in (a.get("_whenCtx") or ())}
        for b in text_boxes[i + 1:]:
            if bool(a.get("_explicitHidden")) != bool(b.get("_explicitHidden")):
                continue
            ctx_b = {wg: wb for wg, wb, _ in (b.get("_whenCtx") or ())}
            if ctx_a and ctx_b and any(ctx_a.get(wg) != ctx_b.get(wg) for wg in ctx_a if wg in ctx_b):
                continue
            other_ink = ink_boxes[id(b)]
            bx, by, bw, bh = other_ink
            ix1, iy1 = max(ix, bx), max(iy, by)
            ix2, iy2 = min(ix + iw, bx + bw), min(iy + ih, by + bh)
            if ix2 > ix1 and iy2 > iy1:
                text_overlap_count += 1
                failures.append({"gate": "no_text_overlap", "severity": "structural",
                                 "widget": a.get("name", ""), "widget2": b.get("name", ""),
                                 "box": [a["x"], a["y"], a["w"], a["h"]], "inkBox": ink, "inkBox2": other_ink,
                                 "overlap": [ix1, iy1, ix2 - ix1, iy2 - iy1],
                                 "detail": f"文字墨迹 '{a.get('name', '')}' 与 '{b.get('name', '')}' 重叠 {ix2 - ix1}×{iy2 - iy1}px"})

    # 6b. 2D 容器边界溢出与同级兄弟盒子碰撞证明器 (Spatial Prover) + 声明式坐标一致性校验
    container_overflow_count = 0
    box_overlap_count = 0
    declared_position_mismatch_count = 0
    _dev_info = emitted_preview.get("device") or {}
    _dev_dx = int(_dev_info.get("screenX", 0) or 0)
    _dev_dy = int(_dev_info.get("screenY", 0) or 0)
    _emitted_pos_map = {}
    for _fc in (emitted_preview.get("flatChildren") or []):
        if isinstance(_fc, dict) and _fc.get("name") and "x" in _fc and "y" in _fc:
            _emitted_pos_map[_fc["name"]] = (int(_fc["x"]) - _dev_dx, int(_fc["y"]) - _dev_dy)
    for _ni in (compile_plan.get("nativeInputs") or []):
        if isinstance(_ni, dict) and _ni.get("name") and "x" in _ni and "y" in _ni:
            _emitted_pos_map[_ni["name"]] = (int(_ni["x"]) - _dev_dx, int(_ni["y"]) - _dev_dy)

    def walk_spatial_bounds(node):
        nonlocal container_overflow_count, box_overlap_count, declared_position_mismatch_count
        if not isinstance(node, dict) or node.get("isModal") or "_x" not in node:
            return
        if "_expected_stack_x" in node or "_expected_stack_y" in node:
            exp_x = node.get("_expected_stack_x", node["_x"])
            exp_y = node.get("_expected_stack_y", node["_y"])
            act_x, act_y = node["_x"], node["_y"]
            nm = node.get("name", "")
            # A left-aligned label can emit a background plus inset text. Audit
            # the declared outer box against its background, not text padding.
            cand_names = [f"bg-box-{nm}", nm]
            if node.get("bgName"):
                cand_names.append(node["bgName"])
            if nm.startswith("grp-"):
                cand_names.extend([f"bg-{nm[4:]}", nm[4:]])
            em_xy = None
            for c_nm in cand_names:
                if c_nm in _emitted_pos_map:
                    em_xy = _emitted_pos_map[c_nm]
                    break
            layout_mismatch = abs(act_x - exp_x) > 1 or abs(act_y - exp_y) > 1
            emitted_mismatch = em_xy is not None and (abs(em_xy[0] - exp_x) > 1 or abs(em_xy[1] - exp_y) > 1)
            if layout_mismatch or emitted_mismatch:
                declared_position_mismatch_count += 1
                failures.append({
                    "gate": "declared_position_ok",
                    "severity": "structural",
                    "widget": nm,
                    "declared": [exp_x, exp_y],
                    "actual": [act_x, act_y],
                    "emitted": list(em_xy) if em_xy is not None else [act_x, act_y],
                    "detail": f"元件 '{nm}' 声明坐标 ({exp_x}, {exp_y}) 与实际布局/发射坐标 ({act_x}, {act_y})"
                              + (f" / 发射 ({em_xy[0]}, {em_xy[1]})" if em_xy is not None else "")
                              + " 不一致",
                })
        if node.get("type") == "dynamic-panel":
            for st in node.get("states", []):
                if isinstance(st.get("tree"), dict) and "_x" in st["tree"]:
                    walk_spatial_bounds(st["tree"])
            return
        children = [ch for ch in (node.get("children") or []) if isinstance(ch, dict) and not ch.get("isModal") and "_x" in ch]
        if not children:
            return
        layout_mode = node.get("layout", "column")
        nx, ny, nw, nh = node["_x"], node["_y"], node["_w"], node["_h"]
        if layout_mode in ("row", "column", "grid"):
            for ch in children:
                cx, cy, cw, ch_h = ch["_x"], ch["_y"], ch["_w"], ch["_h"]
                if cx < nx - 2 or cy < ny - 2 or (cx + cw) > (nx + nw + 2) or (cy + ch_h) > (ny + nh + 2):
                    container_overflow_count += 1
                    _ov = {"left": max(0, nx - cx), "top": max(0, ny - cy),
                           "right": max(0, (cx + cw) - (nx + nw)),
                           "bottom": max(0, (cy + ch_h) - (ny + nh))}
                    _sides = "、".join(f"{_k}侧 {int(_v)}px" for _k, _v in _ov.items() if _v > 0)
                    _cw = ch.get("name") or ch.get("id") or "子元素"
                    _pn = node.get("name") or node.get("id") or "容器"
                    _axis = "宽度" if (_ov["left"] or _ov["right"]) else "高度"
                    _hint = ("收窄该子项的 w，或给同行兄弟子项设 flex=1 分配剩余宽度"
                             if _axis == "宽度" else "减少该子项高度，或让容器改 h=hug/auto")
                    failures.append({"gate": "no_container_overflow", "severity": "structural",
                                     "widget": ch.get("name", ""), "box": [cx, cy, cw, ch_h],
                                     "container": node.get("name", ""), "containerBox": [nx, ny, nw, nh],
                                     "overflow": _ov,
                                     "message": f"「{_cw}」超出容器「{_pn}」{_sides}（子 {int(cx)},{int(cy)} {int(cw)}×{int(ch_h)}；容器 {int(nx)},{int(ny)} {int(nw)}×{int(nh)}）。建议：{_hint}",
                                     "suggestion": _hint,
                                     "detail": "子元件超出父容器边界 >2px"})
            for idx_a, ca in enumerate(children):
                for cb in children[idx_a + 1:]:
                    if ca.get("_when_group") and ca.get("_when_group") == cb.get("_when_group") and ca.get("_when_branch") != cb.get("_when_branch"):
                        continue
                    ca_hid = (ca.get("visible") is False) or (ca.get("hidden") is True)
                    cb_hid = (cb.get("visible") is False) or (cb.get("hidden") is True)
                    if ca_hid != cb_hid:
                        continue
                    ix1 = max(ca["_x"], cb["_x"])
                    iy1 = max(ca["_y"], cb["_y"])
                    ix2 = min(ca["_x"] + ca["_w"], cb["_x"] + cb["_w"])
                    iy2 = min(ca["_y"] + ca["_h"], cb["_y"] + cb["_h"])
                    if ix2 - ix1 > 2 and iy2 - iy1 > 2:
                        box_overlap_count += 1
                        failures.append({"gate": "no_box_overlap", "severity": "structural",
                                         "widget": ca.get("name", ""), "widget2": cb.get("name", ""),
                                         "overlap": [ix1, iy1, ix2 - ix1, iy2 - iy1],
                                         "detail": "同层兄弟盒子重叠 >2px"})
        for ch in children:
            walk_spatial_bounds(ch)

    walk_spatial_bounds(root_node)

    # 7. B 层结构质量 (原生编组覆盖率 + 语义命名率 + 0 重名检查)
    struct_stats = count_axvg_group_coverage(emitted_preview["axvg"])
    group_applicable = bool(struct_stats["totalNodes"]) and not (
        compile_plan.get("auditScope") == "container-local" and struct_stats["totalNodes"] == 1
    )
    group_total = struct_stats["totalNodes"] if group_applicable else 0
    for dup_nm in struct_stats["duplicateNames"]:
        cnt = struct_stats.get("nameCounts", {}).get(dup_nm, 2)
        failures.append({"gate": "no_duplicate_names", "severity": "structural",
                         "widget": dup_nm, "count": cnt,
                         "detail": f"同页内存在重名元件 '{dup_nm}' ({cnt} 次)"})
    if struct_stats["totalNodes"] and struct_stats["semanticNamingPct"] < 90.0:
        bad_nms = struct_stats.get("nonSemanticNames", [])[:8]
        failures.append({"gate": "semantic_naming_ok", "severity": "structural",
                         "widget": ", ".join(bad_nms[:3]),
                         "actual_pct": struct_stats["semanticNamingPct"], "threshold_pct": 90.0,
                         "badWidgets": bad_nms,
                         "detail": f"语义命名率 {struct_stats['semanticNamingPct']}% < 90.0%"})
    if group_applicable and struct_stats["groupCoveragePct"] < 80.0:
        ug_nms = struct_stats.get("ungroupedNames", [])[:8]
        failures.append({"gate": "group_coverage_ok", "severity": "structural",
                         "widget": ", ".join(ug_nms[:3]),
                         "actual_pct": struct_stats["groupCoveragePct"], "threshold_pct": 80.0,
                         "ungroupedWidgets": ug_nms,
                         "detail": f"原生 Layer 编组覆盖率 {struct_stats['groupCoveragePct']}% < 80.0%"})

    # 8. C 层四态覆盖率与交互目标完整性
    dp_list = compile_plan.get("dynamicPanels", [])
    table_panels = [p for p in dp_list if "table" in p["name"]]
    four_states = {"default", "empty", "loading", "error"}
    four_state_ok = all(four_states.issubset({s["name"] for s in p.get("states", [])}) for p in table_panels) if table_panels else True
    four_state_passed = sum(four_states.issubset({s["name"] for s in panel.get("states", [])}) for panel in table_panels)
    four_state_coverage_pct = round(100.0 * four_state_passed / len(table_panels), 2) if table_panels else None
    four_state_coverage = {"status": "pass" if four_state_ok else "fail", "applicable": len(table_panels),
                           "passed": four_state_passed, "percentage": four_state_coverage_pct}
    if not table_panels:
        four_state_coverage["status"] = "not-applicable"

    known_names = {c["name"] for c in compile_plan.get("allMainWidgets", [])}
    known_names.update(s["name"] for s in compile_plan.get("sourceSymbols", []))
    for p in dp_list:
        known_names.add(p["name"])
        for st in p.get("states", []):
            for w_nm in st.get("widgetNames", []):
                known_names.add(w_nm)
            known_names.update(inp["name"] for inp in st.get("nativeInputs", []))
    for inp in compile_plan.get("nativeInputs", []):
        known_names.add(inp["name"])
        if inp.get("bgName"):
            known_names.add(inp["bgName"])
    known_pages = set(compile_plan.get("knownPageNames", []))

    dangling_targets = 0

    def _similar_names(bad, pool, n=3):
        """给出页面内最接近的候选名，把「prefix 契约」这类坑变成可自愈提示。"""
        try:
            import difflib
            return difflib.get_close_matches(str(bad), sorted(pool), n=n, cutoff=0.4)
        except Exception:
            return []

    for ix in compile_plan.get("interactions", []):
        trig = ix.get("trigger")
        if isinstance(trig, str) and trig != "page" and trig not in known_names:
            dangling_targets += 1
            failures.append({"gate": "interaction_targets_ok", "severity": "structural",
                             "trigger": trig, "action": "(trigger)", "target": trig,
                             "similar": _similar_names(trig, known_names),
                             "detail": "交互触发器元件不存在"})
        for ev in ix.get("events", []):
            for cs in ev.get("cases", []):
                for act in cs.get("actions", []):
                    act_type = act.get("type")
                    if act_type == "link":
                        tp = act.get("page") or act.get("target")
                        if tp and known_pages and tp not in known_pages:
                            dangling_targets += 1
                            failures.append({"gate": "interaction_targets_ok", "severity": "structural",
                                             "trigger": trig if isinstance(trig, str) else "",
                                             "action": "link", "target": tp,
                                             "similar": _similar_names(tp, known_pages),
                                             "detail": "链接目标页面不存在"})
                        continue
                    if act_type == "set-variable":
                        continue
                    tgt = act.get("target") or act.get("panel") or act.get("widget")
                    if tgt and tgt not in known_names:
                        dangling_targets += 1
                        _sim = _similar_names(tgt, known_names)
                        failures.append({"gate": "interaction_targets_ok", "severity": "structural",
                                         "trigger": trig if isinstance(trig, str) else "",
                                         "action": act_type, "target": tgt,
                                         "similar": _sim,
                                         "detail": "交互目标元件不存在" + (f"；页面内相似名：{', '.join(_sim)}" if _sim else "；页面内无相似名（检查 prefix 是否与目标组件一致）")})

    if is_small_or_test:
        ws_min, ws_max = (5.0, 95.0)
    elif is_mobile_or_doc:
        ws_min, ws_max = (12.0, 88.0)
    else:
        ws_min, ws_max = (25.0, 75.0)

    metrics = {
        "canvas_area": int(round(canvas_area)),
        "alignment_error_px": alignment_error_px,
        "spacing_compliance_pct": spacing_compliance_pct,
        "font_compliance_pct": font_compliance_pct,
        "whitespace_ratio_pct": whitespace_ratio_pct,
        "color_count": len(colors),
        "text_overlap_count": text_overlap_count,
        "text_clip_count": text_clip_count,
        "missing_glyph_count": missing_glyph_count,
        "kinsoku_violation_count": kinsoku_violation_count,
        "container_overflow_count": container_overflow_count,
        "box_overlap_count": box_overlap_count,
        "declared_position_mismatch_count": declared_position_mismatch_count,
        "duplicate_name_count": struct_stats["duplicateNameCount"],
        "duplicate_names": struct_stats["duplicateNames"],
        "semantic_naming_pct": struct_stats["semanticNamingPct"] if struct_stats["totalNodes"] else None,
        "group_coverage_pct": struct_stats["groupCoveragePct"] if group_applicable else None,
        "four_state_coverage_pct": four_state_coverage_pct,
        "interaction_dangling_targets": dangling_targets,
    }
    raw_weights = {
        "canvas_area": canvas_area,
        "fg_pixels": fg_pixels,
        "spacing_passed": spacing_passed,
        "spacing_total": spacing_total,
        "font_passed": font_passed,
        "font_total": font_total,
        "semantic_nodes": struct_stats["semanticNodes"],
        "grouped_nodes": struct_stats["groupedNodes"] if group_applicable else 0,
        "group_total": group_total,
        "total_nodes": struct_stats["totalNodes"],
    }
    # 悬空交互明细
    for _d in (compile_plan.get("danglingInteractions") or []):
        failures.append({"gate": "interaction_targets_ok", "severity": "structural",
                         "trigger": _d.get("trigger", ""), "action": _d.get("action", ""),
                         "target": _d.get("target", ""),
                         "similar": _d.get("similar", []),
                         "detail": "交互目标元件不存在" + (f"；页面内相似名：{', '.join(_d['similar'])}" if _d.get("similar") else "")})
    for child in alignment_mismatches:
        failures.append({"gate": "button_text_alignment_ok", "severity": "structural",
                         "widget": child.get("name"), "expected": child["_expectedTextAlignment"],
                         "actual": native_alignment.get(child.get("name")),
                         "detail": "按钮原生文字必须垂直居中，与填充色及激活状态无关"})
    # 给每条明细补 pageName（由调用方注入或留空）
    for _f in failures:
        if not _f.get("page"):
            _f["page"] = compile_plan.get("pageName", "")
    structural_gates = {
        "button_text_alignment_ok": not alignment_mismatches,
        "no_text_overlap": text_overlap_count == 0,
        "no_text_clip": text_clip_count == 0,
        "no_missing_glyphs": missing_glyph_count == 0,
        "no_kinsoku_violation": kinsoku_violation_count == 0,
        "no_container_overflow": container_overflow_count == 0,
        "no_box_overlap": box_overlap_count == 0,
        "declared_position_ok": declared_position_mismatch_count == 0,
        "no_duplicate_names": struct_stats["duplicateNameCount"] == 0,
        "semantic_naming_ok": not struct_stats["totalNodes"] or struct_stats["semanticNamingPct"] >= 90.0,
        "group_coverage_ok": not group_applicable or struct_stats["groupCoveragePct"] >= 80.0,
        "interaction_targets_ok": dangling_targets == 0,
    }
    whitespace_applicable = compile_plan.get("auditScope") != "container-local"
    aesthetic_gates = {
        "alignment_ok": alignment_error_px <= 1.0,
        "spacing_ok": not spacing_total or spacing_compliance_pct >= 95.0,
        "font_ok": not font_total or font_compliance_pct >= 90.0,
        "whitespace_ok": not whitespace_applicable or ws_min <= whitespace_ratio_pct <= ws_max,
        "color_ok": len(colors) <= 18,
        "four_state_ok": four_state_ok,
    }
    gates = {**aesthetic_gates, **structural_gates}
    warnings = list(compile_plan.get("schemaWarnings", []))
    if _occluded:
        warnings.append("text_occluded: " + "; ".join(_occluded[:6]) + "（调整声明顺序或用 z 指定绘制层级）")
    if not aesthetic_gates["alignment_ok"]:
        warnings.append(f"alignment_ok: alignment_error_px={alignment_error_px} > 1.0")
    if not aesthetic_gates["spacing_ok"]:
        _sp_detail = f": {', '.join(spacing_violations[:5])}" if spacing_violations else ""
        warnings.append(f"spacing_ok: spacing_compliance_pct={spacing_compliance_pct}% < 95.0% (存在非标准间距/圆角令牌{_sp_detail}; 允许间距={sorted(SPACING_TOKENS)}, 允许圆角={sorted(RADIUS_TOKENS)})")
    if not aesthetic_gates["font_ok"]:
        _fn_detail = f": {', '.join(font_violations[:5])}" if font_violations else ""
        warnings.append(f"font_ok: font_compliance_pct={font_compliance_pct}% < 90.0% (存在非标准字号/字重{_fn_detail}; 允许字号={sorted(FONT_SIZE_TOKENS)})")
    if not aesthetic_gates["whitespace_ok"]:
        warnings.append(f"whitespace_ok: whitespace_ratio_pct={whitespace_ratio_pct}% 超出建议区间 [{ws_min}%, {ws_max}%]")
    if not aesthetic_gates["color_ok"]:
        warnings.append(f"color_ok: color_count={len(colors)} > 18")
    if not aesthetic_gates["four_state_ok"]:
        warnings.append("four_state_ok: 表格动态面板未包含完整的 default/empty/loading/error 四态")

    structural_ok = all(structural_gates.values())
    aesthetic_ok = all(aesthetic_gates.values())
    overall_ok = (structural_ok and aesthetic_ok) if strict_audit else structural_ok
    return {
        "ok": overall_ok,
        "structural_ok": structural_ok,
        "aesthetic_ok": aesthetic_ok,
        "strict_audit": bool(strict_audit),
        "warnings": warnings,
        "metrics": metrics,
        "coverage": {"fourState": four_state_coverage,
                     "spacing": {"status": ("pass" if aesthetic_gates["spacing_ok"] else "fail") if spacing_total else "not-applicable",
                                 "applicable": spacing_total, "passed": spacing_passed, "percentage": spacing_compliance_pct},
                     "font": {"status": ("pass" if aesthetic_gates["font_ok"] else "fail") if font_total else "not-applicable",
                              "applicable": font_total, "passed": font_passed, "percentage": font_compliance_pct},
                     "whitespace": {"status": ("pass" if aesthetic_gates["whitespace_ok"] else "fail") if whitespace_applicable else "not-applicable",
                                    "applicable": int(whitespace_applicable), "scope": "page-composition"},
                     "semanticNaming": {"status": ("pass" if structural_gates["semantic_naming_ok"] else "fail") if struct_stats["totalNodes"] else "not-applicable",
                                        "applicable": struct_stats["totalNodes"], "passed": struct_stats["semanticNodes"]},
                     "groupCoverage": {"status": ("pass" if structural_gates["group_coverage_ok"] else "fail") if group_applicable else "not-applicable",
                                       "applicable": group_total, "passed": struct_stats["groupedNodes"] if group_applicable else 0,
                                       "reason": None if group_applicable else "empty-or-single-primitive-local-scene"}},
        "_weights": raw_weights,
        "failures": failures,
        "structural_gates": structural_gates,
        "aesthetic_gates": aesthetic_gates,
        "gates": gates,
    }


def summarize_scene_audits(scenes, strict_audit=False):
    """Combine registered scene results; an absent audit is a failure, not a pass.

    Panel states and templates are container-local scenes. They are never
    superimposed with mutually exclusive siblings, nor claimed as a Cartesian
    proof of all combinations of independent panel states or runtime rows.
    """
    audits = [scene["audit"] for scene in scenes if scene.get("audit") is not None]
    expected, audited = len(scenes), len(audits)
    missing = [scene for scene in scenes if scene.get("audit") is None]
    failures = []
    warnings = []
    for scene in scenes:
        audit = scene.get("audit")
        scene["status"] = ("pass" if audit["ok"] else "fail") if audit is not None else "not-run"
        if audit is None:
            failures.append({"gate": "scene_audits_complete", "severity": "structural", "sceneId": scene["id"],
                             "page": scene.get("page", ""), "detail": "已登记的场景没有审计结果"})
            continue
        for failure in audit.get("failures", []):
            failures.append({**failure, "sceneId": scene["id"], "page": scene.get("page", "")})
        warnings.extend(f"[{scene['id']}] {warning}" for warning in audit.get("warnings", []))
    sum_keys = ("text_overlap_count", "text_clip_count", "missing_glyph_count", "kinsoku_violation_count",
                "container_overflow_count", "box_overlap_count", "declared_position_mismatch_count",
                "duplicate_name_count", "interaction_dangling_targets")
    metrics = {key: sum(int(a["metrics"].get(key, 0) or 0) for a in audits) for key in sum_keys}
    weights = {key: sum((a.get("_weights") or {}).get(key, 0) for a in audits)
               for key in ("canvas_area", "fg_pixels", "spacing_passed", "spacing_total", "font_passed", "font_total",
                           "semantic_nodes", "grouped_nodes", "group_total", "total_nodes")}
    for metric, passed, total in (("spacing_compliance_pct", "spacing_passed", "spacing_total"),
                                  ("font_compliance_pct", "font_passed", "font_total"),
                                  ("semantic_naming_pct", "semantic_nodes", "total_nodes"),
                                  ("group_coverage_pct", "grouped_nodes", "group_total")):
        metrics[metric] = round(100.0 * weights[passed] / weights[total], 2) if weights[total] else None
    metrics["alignment_error_px"] = max((a["metrics"].get("alignment_error_px", 0) for a in audits), default=0)
    metrics["color_count"] = max((a["metrics"].get("color_count", 0) for a in audits), default=0)
    metrics["duplicate_names"] = [name for a in audits for name in a["metrics"].get("duplicate_names", [])]
    metrics["canvas_area"] = int(weights["canvas_area"])
    metrics["whitespace_ratio_pct"] = round(100.0 * (1.0 - weights["fg_pixels"] / weights["canvas_area"]), 2) if weights["canvas_area"] else None
    four = [a.get("coverage", {}).get("fourState", {}) for a in audits]
    applicable = sum(check.get("applicable", 0) for check in four)
    passed = sum(check.get("passed", 0) for check in four)
    metrics["four_state_coverage_pct"] = round(100.0 * passed / applicable, 2) if applicable else None
    structural_keys = set().union(*(a["structural_gates"] for a in audits))
    aesthetic_keys = set().union(*(a["aesthetic_gates"] for a in audits))
    structural = {key: all(a["structural_gates"].get(key, True) for a in audits) for key in sorted(structural_keys)}
    structural["scene_audits_complete"] = not missing
    aesthetic = {key: all(a["aesthetic_gates"].get(key, True) for a in audits) for key in sorted(aesthetic_keys)}
    structural_ok = bool(audits) and all(structural.values())
    aesthetic_ok = bool(audits) and all(aesthetic.values())
    coverage = {"fourState": {"status": ("pass" if passed == applicable else "fail") if applicable else "not-applicable",
                               "applicable": applicable, "passed": passed, "percentage": metrics["four_state_coverage_pct"]}}
    for name, metric, passed_key, total_key, gate in (
        ("spacing", "spacing_compliance_pct", "spacing_passed", "spacing_total", "spacing_ok"),
        ("font", "font_compliance_pct", "font_passed", "font_total", "font_ok"),
        ("semanticNaming", "semantic_naming_pct", "semantic_nodes", "total_nodes", "semantic_naming_ok"),
        ("groupCoverage", "group_coverage_pct", "grouped_nodes", "group_total", "group_coverage_ok"),
    ):
        total = weights[total_key]
        gate_ok = structural.get(gate, aesthetic.get(gate, True))
        coverage[name] = {"status": ("pass" if gate_ok else "fail") if total else "not-applicable",
                          "applicable": total, "passed": weights[passed_key], "percentage": metrics[metric]}
    page_whitespace = [a.get("coverage", {}).get("whitespace", {}) for a in audits]
    page_whitespace = [check for check in page_whitespace if check.get("applicable")]
    coverage["whitespace"] = {"status": ("pass" if all(check["status"] == "pass" for check in page_whitespace) else "fail") if page_whitespace else "not-applicable",
                              "applicable": len(page_whitespace), "scope": "page-composition"}
    return {"ok": structural_ok and (aesthetic_ok or not strict_audit), "structural_ok": structural_ok,
            "aesthetic_ok": aesthetic_ok, "strict_audit": bool(strict_audit), "metrics": metrics,
            "coverage": coverage,
            "sceneCoverage": {"expected": expected, "audited": audited, "missing": len(missing),
                              "passed": sum(scene["status"] == "pass" for scene in scenes),
                              "failed": sum(scene["status"] == "fail" for scene in scenes),
                              "percentage": round(100.0 * audited / expected, 2) if expected else None,
                              "status": ("complete" if not missing else "not-run") if expected else "not-applicable",
                              "resultStatus": ("pass" if all(scene["status"] == "pass" for scene in scenes) else "fail") if expected and not missing else "not-run",
                              "allScenesPassed": bool(expected) and all(scene["status"] == "pass" for scene in scenes),
                              "scope": "page-default-and-container-local-scenes", "combinationsExplored": False},
            "metricScope": "scene-instances", "scenes": scenes, "_weights": weights,
            "failures": failures, "warnings": warnings,
            "structural_gates": structural, "aesthetic_gates": aesthetic, "gates": {**aesthetic, **structural}}
