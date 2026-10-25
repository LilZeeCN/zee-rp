#!/usr/bin/env python3
"""
zee-axure 直接原型生成引擎 (proto.py)
核心职责：
  1. 设计令牌系统 (Design Tokens) 与多套现代主题预设 (enterprise-light / modern-dark / cobalt-pro)
  2. 确定性自动布局引擎 (Auto-Layout: row / column / grid / stack + PingFang.ttc 字宽字高测量)
  3. 15 类高层语义原型组件展开器 (含自动四态表格 default/empty/loading/error、多态图表、原生输入框绑定弹窗)
  4. 双通道层级发射器：
     - 原生编组 (Axure:DiagramObject:Layer, itemType: 0) + 100% 语义化命名 (isNameDynamic: false) 的 .axvg.json
     - 兼容 rp9_place.py 与视觉代理渲染的 .spec.json + .compile-plan.json
  5. 多视角视觉渲染 (01-preview.png / 02-structure.png / 03-thumb25.png / 状态分图) 与十维量化审美/结构审计器
"""
import argparse
import copy
import glob
import hashlib
import json
import math
import os
import re
import sys
import base64
import io
from rp_language import compile_language, LanguageError
from rp_language_cli import read_source
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))

FONT_PATHS = (
    ["/System/Library/Fonts/PingFang.ttc"]
    + sorted(glob.glob("/System/Library/AssetsV2/com_apple_MobileAsset_Font*/**/PingFang.ttc", recursive=True))
    + [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
)
_FONT_CACHE = {}
FALLBACK_FONT_PATHS = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/System/Library/Fonts/LucidaGrande.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/STIXTwoMath.otf",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]
_FALLBACK_FONT_CACHE = {}
_NOTDEF_SIG_CACHE = {}
_CHAR_FONT_PATH_CACHE = {}
GLYPH_SUGGESTIONS = {
    "\u2713": "Use '●' or icon='check' in legacy specs, or language='rp/1' with fallback fonts",
    "\u2714": "Use '●' or icon='check' in legacy specs, or language='rp/1' with fallback fonts",
    "\u2717": "Use '×' in legacy specs, or language='rp/1' with fallback fonts",
    "\u2718": "Use '×' in legacy specs, or language='rp/1' with fallback fonts",
    "\u2728": "Use '★' or an icon component (icon='sparkles')",
    "\u2b50": "Use '★' or an icon component",
}

def load_font(size_px, weight=400):
    size_px = max(8, int(round(size_px)))
    w_int = int(weight or 400)
    key = (size_px, w_int)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    for fp in FONT_PATHS:
        if os.path.exists(fp):
            try:
                if fp.endswith("PingFang.ttc"):
                    idx = 11 if w_int >= 600 else (7 if w_int >= 500 else 3)
                else:
                    idx = 0
                f = ImageFont.truetype(fp, size_px, index=idx)
                _FONT_CACHE[key] = f
                return f
            except Exception:
                try:
                    f = ImageFont.truetype(fp, size_px)
                    _FONT_CACHE[key] = f
                    return f
                except Exception:
                    pass
    f = ImageFont.load_default()
    _FONT_CACHE[key] = f
    return f


def load_fallback_font(fp, size_px):
    size_px = max(8, int(round(size_px)))
    key = (fp, size_px)
    if key in _FALLBACK_FONT_CACHE:
        return _FALLBACK_FONT_CACHE[key]
    f = ImageFont.truetype(fp, size_px)
    _FALLBACK_FONT_CACHE[key] = f
    return f


def _glyph_bitmap_sig(font, ch):
    im = Image.new("L", (40, 40), 0)
    d = ImageDraw.Draw(im)
    try:
        d.text((4, 4), ch, font=font, fill=255)
    except Exception:
        return None
    bb = im.getbbox()
    if not bb or bb[2] <= bb[0] or bb[3] <= bb[1]:
        return None
    return im.crop(bb).tobytes()


_GLYPH_PINGFANG_CACHE = {}
_GLYPH_RENDERABLE_CACHE = {}

KINSOKU_HEAD = set("，。、；：！？）》」』】〕〉》％‰—…·,.;:!?)]}")
KINSOKU_TAIL = set("（《「『【〔〈([{$¥")
_LATIN_WORD_RE = re.compile(r"[A-Za-z0-9_.\-+/:=@#%×]+(?:'[A-Za-z0-9]+)?")


def is_glyph_renderable_in_pingfang(ch):
    if not ch or ch.isspace() or ord(ch) < 32:
        return True
    if ch in _GLYPH_PINGFANG_CACHE:
        return _GLYPH_PINGFANG_CACHE[ch]
    f = load_font(14, 400)
    try:
        bb = f.getbbox(ch)
        ok = (bb[3] - bb[1]) > 0 and (bb[2] - bb[0]) > 0
    except Exception:
        ok = True
    _GLYPH_PINGFANG_CACHE[ch] = ok
    return ok


def resolve_glyph_font_path(ch):
    """查找字符可用的系统字体路径：优先 PingFang.ttc，其次 macOS 系统 fallback 字体链（排除 .notdef 方框）。"""
    if not ch or ch.isspace() or ord(ch) < 32:
        return "PingFang.ttc"
    if ch in _CHAR_FONT_PATH_CACHE:
        return _CHAR_FONT_PATH_CACHE[ch]
    if is_glyph_renderable_in_pingfang(ch):
        _CHAR_FONT_PATH_CACHE[ch] = "PingFang.ttc"
        return "PingFang.ttc"
    for fp in FALLBACK_FONT_PATHS:
        if not os.path.exists(fp):
            continue
        try:
            f = load_fallback_font(fp, 16)
            if fp not in _NOTDEF_SIG_CACHE:
                _NOTDEF_SIG_CACHE[fp] = _glyph_bitmap_sig(f, "\u0378")
            sig = _glyph_bitmap_sig(f, ch)
            if sig is not None and sig != _NOTDEF_SIG_CACHE[fp]:
                _CHAR_FONT_PATH_CACHE[ch] = fp
                return fp
        except Exception:
            continue
    _CHAR_FONT_PATH_CACHE[ch] = None
    return None


def _measure_line_with_fallbacks(ln, font_size, font_weight):
    f_main = load_font(font_size, font_weight)
    if all(is_glyph_renderable_in_pingfang(c) for c in ln):
        bb = f_main.getbbox(ln)
        return bb[2] - bb[0], bb[3] - bb[1], bb[1]
    total_w = 0
    max_h = 0
    min_top = None
    for ch in ln:
        if is_glyph_renderable_in_pingfang(ch):
            f_use = f_main
        else:
            fp = resolve_glyph_font_path(ch)
            f_use = load_fallback_font(fp, font_size) if fp and fp != "PingFang.ttc" else f_main
        try:
            bb = f_use.getbbox(ch)
            cw = max(int(round(font_size * 0.55)) if not is_glyph_renderable_in_pingfang(ch) else 0, bb[2] - bb[0])
            ch_h = bb[3] - bb[1]
            top_y = bb[1]
        except Exception:
            cw = int(round(font_size * 0.75))
            ch_h = int(round(font_size))
            top_y = 0
        total_w += cw
        if ch_h > max_h:
            max_h = ch_h
        if min_top is None or top_y < min_top:
            min_top = top_y
    return total_w, max_h or int(round(font_size)), (min_top if min_top is not None else 0)


def measure_text(text_str, font_size=14, font_weight=400):
    """使用真实 PingFang.ttc (+ 系统 fallback 字体链) 测量单行或多行文本像素宽高，附加防裁切安全余量。"""
    s = str(text_str or "")
    if not s:
        return (8, max(16, int(round(font_size * 1.4))))
    lines = s.split("\n")
    max_w = 0
    for ln in lines:
        if not ln:
            continue
        try:
            w, _, _ = _measure_line_with_fallbacks(ln, font_size, font_weight)
        except Exception:
            w = int(len(ln) * font_size * 0.85)
        if w > max_w:
            max_w = w
    line_h = max(int(round(font_size * 1.42)), font_size + 4)
    total_h = line_h * max(1, len(lines))
    return (int(math.ceil(max_w)) + 8, int(total_h))


def is_glyph_renderable(ch, allow_fallback=False):
    """检测单个字符是否具有真实可渲染字形（allow_fallback=True 时启用 macOS 系统 fallback 字体链）。"""
    if not ch or ch.isspace() or ord(ch) < 32:
        return True
    key = (ch, bool(allow_fallback))
    if key in _GLYPH_RENDERABLE_CACHE:
        return _GLYPH_RENDERABLE_CACHE[key]
    if is_glyph_renderable_in_pingfang(ch):
        _GLYPH_RENDERABLE_CACHE[key] = True
        return True
    if allow_fallback:
        ok = resolve_glyph_font_path(ch) is not None
        _GLYPH_RENDERABLE_CACHE[key] = ok
        return ok
    _GLYPH_RENDERABLE_CACHE[key] = False
    return False


def find_unrenderable_glyphs(text_str, allow_fallback=False):
    """返回字符串中在当前字体（及可选 fallback 字体链）下不可渲染的字符列表。"""
    bad = []
    for ch in str(text_str or ""):
        if not is_glyph_renderable(ch, allow_fallback=allow_fallback) and ch not in bad:
            bad.append(ch)
    return bad


def describe_unrenderable_glyphs(text_str, allow_fallback=False):
    """返回不可渲染字符的结构化诊断明细（含 U+XXXX、原字符、测量字体与替代建议）。"""
    details = []
    font_desc = "PingFang.ttc + macOS fallbacks (Menlo, Apple Symbols, LucidaGrande, Arial Unicode)" if allow_fallback else "PingFang.ttc"
    for ch in find_unrenderable_glyphs(text_str, allow_fallback=allow_fallback):
        cp = f"U+{ord(ch):04X}"
        sug = GLYPH_SUGGESTIONS.get(ch, f"Replace {ch} ({cp}) with a standard CJK/ASCII symbol or an icon component")
        details.append({
            "char": ch,
            "codepoint": cp,
            "font": font_desc,
            "suggestion": sug,
        })
    return details


def _tokenize_for_wrap(para):
    """将段落切分为『英文/数字原子词 + 空白 + 单字 CJK』，并执行避头尾标点粘连 (Kinsoku Binding)。"""
    raw_tokens = []
    i = 0
    n = len(para)
    while i < n:
        m = _LATIN_WORD_RE.match(para, i)
        if m:
            raw_tokens.append(m.group(0))
            i = m.end()
        else:
            raw_tokens.append(para[i])
            i += 1
    merged_tail = []
    idx = 0
    while idx < len(raw_tokens):
        tok = raw_tokens[idx]
        while tok and all(c in KINSOKU_TAIL for c in tok) and idx + 1 < len(raw_tokens):
            idx += 1
            tok = tok + raw_tokens[idx]
        merged_tail.append(tok)
        idx += 1
    bound_tokens = []
    for tok in merged_tail:
        if bound_tokens and tok and all(c in KINSOKU_HEAD for c in tok):
            if bound_tokens[-1].isspace() and len(bound_tokens) >= 2:
                bound_tokens.pop()
            bound_tokens[-1] = bound_tokens[-1] + tok
        else:
            bound_tokens.append(tok)
    return bound_tokens


def _split_oversized_tokens(tokens, max_w, font_size=12, font_weight=400):
    """当单个词法 token 宽度超过整行 max_w 时，执行安全的避头尾字符级切分。"""
    norm = []
    for tok in tokens:
        if not tok or tok.isspace() or measure_text(tok, font_size, font_weight)[0] <= max_w:
            norm.append(tok)
            continue
        if (
            len(tok) >= 2
            and tok[-1] in KINSOKU_HEAD
            and measure_text(tok[:-1], font_size, font_weight)[0] <= max_w
            and measure_text(tok, font_size, font_weight)[0] <= max_w + 10
        ):
            norm.append(tok)
            continue
        cur = tok
        while cur and measure_text(cur, font_size, font_weight)[0] > max_w and len(cur) > 1:
            split_pos = 1
            for k in range(1, len(cur) + 1):
                if measure_text(cur[:k], font_size, font_weight)[0] <= max_w:
                    split_pos = k
                else:
                    break
            rem = cur[split_pos:]
            while split_pos > 1 and rem and rem[0] in KINSOKU_HEAD:
                split_pos -= 1
                rem = cur[split_pos:]
            norm.append(cur[:split_pos])
            cur = rem
        if cur:
            norm.append(cur)
    return norm


def wrap_text_greedy(text_str, max_w, font_size=12, font_weight=400):
    """基线贪心断行算法（供与 Knuth-Plass 动态规划最优断行做量化对比）。"""
    raw = str(text_str or "")
    if not raw:
        return [""]
    out_lines = []
    for para in raw.split("\n"):
        if not para:
            out_lines.append("")
            continue
        tokens = _split_oversized_tokens(_tokenize_for_wrap(para), max_w, font_size, font_weight)
        cur = ""
        for tok in tokens:
            if not cur and tok.isspace():
                continue
            trial = cur + tok
            if (
                not cur
                or measure_text(trial, font_size, font_weight)[0] <= max_w
                or (
                    len(tok) >= 2
                    and tok[-1] in KINSOKU_HEAD
                    and measure_text(trial[:-1], font_size, font_weight)[0] <= max_w
                    and measure_text(trial, font_size, font_weight)[0] <= max_w + 10
                )
            ):
                cur = trial
                continue
            if tok.isspace():
                out_lines.append(cur.rstrip())
                cur = ""
                continue
            if cur.strip():
                out_lines.append(cur.rstrip())
                cur = tok.lstrip()
            else:
                cur = tok
        if cur.strip():
            out_lines.append(cur.rstrip())
    return out_lines or [""]


def measure_paragraph_raggedness(lines, max_w, font_size=12, font_weight=400):
    """计算段落断行的 Knuth-Plass 二次方参差度代价 (Squared Raggedness Cost + 孤字惩罚)。"""
    clean = [ln for ln in (lines or []) if ln.strip()]
    if len(clean) <= 1:
        return 0.0
    cost = 0.0
    for ln in clean[:-1]:
        w = measure_text(ln, font_size, font_weight)[0]
        slack = max(0.0, float(max_w - w))
        cost += slack * slack
    last_ln = clean[-1].strip()
    last_w = measure_text(last_ln, font_size, font_weight)[0]
    if len(last_ln) <= 2 or last_w < max_w * 0.16:
        cost += (max_w * 0.42) ** 2
    return round(cost, 2)


def wrap_text(text_str, max_w, font_size=12, font_weight=400, mode="knuth-plass"):
    """按真实 PingFang.ttc 字宽执行 Knuth-Plass 动态规划全局最优断行 (O(m^2) 最小平方参差度 + 孤行消除 + CJK 避头尾)。"""
    if mode == "greedy":
        return wrap_text_greedy(text_str, max_w, font_size=font_size, font_weight=font_weight)
    raw = str(text_str or "")
    if not raw:
        return [""]
    max_w = max(24, int(round(max_w)))
    out_lines = []
    for para in raw.split("\n"):
        if not para or not para.strip():
            out_lines.append("")
            continue
        if measure_text(para.strip(), font_size, font_weight)[0] <= max_w:
            out_lines.append(para.strip())
            continue
        tokens = _split_oversized_tokens(_tokenize_for_wrap(para), max_w, font_size, font_weight)
        m = len(tokens)
        if m == 0:
            out_lines.append("")
            continue
        dp = [0.0] * (m + 1)
        choice = [None] * (m + 1)
        for i in range(m - 1, -1, -1):
            if tokens[i].isspace():
                dp[i] = dp[i + 1]
                choice[i] = (i + 1, None)
                continue
            best_cost = float("inf")
            best_step = None
            acc = ""
            for j in range(i, m):
                acc += tokens[j]
                if tokens[j].isspace():
                    continue
                cand = acc.rstrip()
                cand_w = measure_text(cand, font_size, font_weight)[0]
                fits_strict = cand_w <= max_w
                fits_hanging = (
                    not fits_strict
                    and len(tokens[j]) >= 2
                    and tokens[j][-1] in KINSOKU_HEAD
                    and measure_text(cand[:-1], font_size, font_weight)[0] <= max_w
                    and cand_w <= max_w + 10
                )
                if j > i and not fits_strict and not fits_hanging:
                    break
                nxt = j + 1
                while nxt < m and tokens[nxt].isspace():
                    nxt += 1
                if nxt >= m:
                    # 段落末行：仅对孤字/过短尾行施加孤行惩罚，促使前序行均匀分摊字宽
                    line_cost = 200.0 if fits_hanging else 0.0
                    if i > 0 and (len(cand.strip()) <= 2 or cand_w < max_w * 0.16):
                        line_cost += (max_w * 0.42) ** 2
                else:
                    slack = max(0.0, float(max_w - cand_w))
                    line_cost = slack * slack + (400.0 if fits_hanging else 0.0)
                total = line_cost + dp[nxt]
                if total < best_cost:
                    best_cost = total
                    best_step = (nxt, cand)
            if best_step is None:
                nxt = i + 1
                while nxt < m and tokens[nxt].isspace():
                    nxt += 1
                best_step = (nxt, tokens[i].strip())
                best_cost = dp[nxt]
            dp[i] = best_cost
            choice[i] = best_step
        idx = 0
        while idx < m and choice[idx] is not None:
            nxt, line_str = choice[idx]
            if line_str:
                out_lines.append(line_str)
            if nxt <= idx:
                break
            idx = nxt
    return out_lines or [""]



ASSETS_SPEC_DIR = os.path.normpath(os.path.join(HERE, "..", "assets", "mobile-primitives"))
_IMAGE_ASSET_CACHE = {}


def load_image_asset(path_or_name, base_dir=None):
    """加载 PNG/JPG 图标或手机壳素材（支持内置 app-design-spec 别名、相对路径与绝对路径），返回 {name, path, b64, key}。"""
    import base64
    key_lookup = (str(path_or_name), str(base_dir or ""))
    if key_lookup in _IMAGE_ASSET_CACHE:
        return _IMAGE_ASSET_CACHE[key_lookup]
    cand_paths = []
    s = str(path_or_name or "").strip()
    if os.path.isabs(s):
        cand_paths.append(s)
    else:
        if base_dir:
            cand_paths.append(os.path.join(base_dir, s))
        cand_paths.extend([
            os.path.join(ASSETS_SPEC_DIR, s),
            os.path.join(ASSETS_SPEC_DIR, "icons", s),
            os.path.join(ASSETS_SPEC_DIR, "icons", f"icon-{s}.png" if not s.endswith(".png") else s),
            os.path.join(ASSETS_SPEC_DIR, "shells", "iphone-x-black", s),
            os.path.join(ASSETS_SPEC_DIR, "shells", "iphone-x-white", s),
            os.path.join(ASSETS_SPEC_DIR, "shells", "iphone-6-8", s),
        ])
    resolved = None
    for cp in cand_paths:
        if os.path.isfile(cp):
            resolved = os.path.abspath(cp)
            break
    if not resolved:
        raise FileNotFoundError(f"Image asset not found: {path_or_name} (searched {cand_paths[:4]})")
    with open(resolved, "rb") as f:
        data = f.read()
    info = {
        "name": os.path.basename(resolved),
        "path": resolved,
        "b64": base64.b64encode(data).decode("ascii"),
        "key": hashlib.sha1(data).hexdigest(),
    }
    _IMAGE_ASSET_CACHE[key_lookup] = info
    return info


# -------------------- 1. DESIGN TOKENS & MULTI-THEME PRESETS --------------------
from rp_language import SPACING_TOKENS, RADIUS_TOKENS, FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS

THEMES = {
    "enterprise-light": {
        "name": "enterprise-light",
        "label": "企业级亮色工作台 (SaaS Admin Light)",
        "bg": "#F4F6F9",
        "surface": "#FFFFFF",
        "surface-2": "#F4F6F9",
        "surface-3": "#E2E8F0",
        "sidebar-bg": "#1E293B",
        "sidebar-surface": "#0F172A",
        "sidebar-active": "#FF8833",
        "sidebar-ink": "#94A3B8",
        "sidebar-ink-active": "#FFFFFF",
        "ink": "#1E293B",
        "ink-2": "#475569",
        "ink-3": "#94A3B8",
        "ink-inv": "#FFFFFF",
        "line": "#E2E8F0",
        "line-strong": "#E2E8F0",
        "brand": "#FF8833",
        "brand-soft": "#FFF3E8",
        "accent": "#2563EB",
        "accent-soft": "#EFF6FF",
        "success": "#10B981",
        "success-soft": "#ECFDF5",
        "warning": "#F59E0B",
        "warning-soft": "#FFFBEB",
        "danger": "#EF4444",
        "danger-soft": "#FEF2F2",
        "backdrop": "#1E293B",
    },
    "modern-dark": {
        "name": "modern-dark",
        "label": "现代暗色智算中枢 (AI Studio Dark)",
        "bg": "#0B0F19",
        "surface": "#111827",
        "surface-2": "#1E293B",
        "surface-3": "#1E293B",
        "sidebar-bg": "#0B0F19",
        "sidebar-surface": "#111827",
        "sidebar-active": "#6366F1",
        "sidebar-ink": "#64748B",
        "sidebar-ink-active": "#F8FAFC",
        "ink": "#F8FAFC",
        "ink-2": "#CBD5E1",
        "ink-3": "#64748B",
        "ink-inv": "#F8FAFC",
        "line": "#1E293B",
        "line-strong": "#1E293B",
        "brand": "#6366F1",
        "brand-soft": "#1E1B4B",
        "accent": "#06B6D4",
        "accent-soft": "#083344",
        "success": "#10B981",
        "success-soft": "#064E3B",
        "warning": "#F59E0B",
        "warning-soft": "#451A03",
        "danger": "#F43F5E",
        "danger-soft": "#4C0519",
        "backdrop": "#0B0F19",
    },
    "cobalt-pro": {
        "name": "cobalt-pro",
        "label": "金融云原生钴蓝主题 (Cobalt Cloud Pro)",
        "bg": "#F1F5F9",
        "surface": "#FFFFFF",
        "surface-2": "#F4F6F9",
        "surface-3": "#E2E8F0",
        "sidebar-bg": "#0F172A",
        "sidebar-surface": "#0F172A",
        "sidebar-active": "#2563EB",
        "sidebar-ink": "#94A3B8",
        "sidebar-ink-active": "#FFFFFF",
        "ink": "#0F172A",
        "ink-2": "#475569",
        "ink-3": "#94A3B8",
        "ink-inv": "#FFFFFF",
        "line": "#E2E8F0",
        "line-strong": "#E2E8F0",
        "brand": "#2563EB",
        "brand-soft": "#DBEAFE",
        "accent": "#0EA5E9",
        "accent-soft": "#E0F2FE",
        "success": "#059669",
        "success-soft": "#D1FAE5",
        "warning": "#D97706",
        "warning-soft": "#FEF3C7",
        "danger": "#DC2626",
        "danger-soft": "#FEE2E2",
        "backdrop": "#1E293B",
    },
    "mobile-lowfi": {
        "name": "mobile-lowfi",
        "label": "移动端低保真灰阶线框规范 (Mobile Low-Fi Wireframe)",
        "bg": "#F2F2F2",
        "surface": "#FFFFFF",
        "surface-2": "#F7F7F7",
        "surface-3": "#EDEDED",
        "sidebar-bg": "#262626",
        "sidebar-surface": "#333333",
        "sidebar-active": "#404040",
        "sidebar-ink": "#BFBFBF",
        "sidebar-ink-active": "#FFFFFF",
        "ink": "#262626",
        "ink-2": "#595959",
        "ink-3": "#8C8C8C",
        "ink-inv": "#FFFFFF",
        "line": "#D9D9D9",
        "line-strong": "#BFBFBF",
        "brand": "#262626",
        "brand-soft": "#F0F0F0",
        "accent": "#404040",
        "accent-soft": "#F5F5F5",
        "success": "#4D4D4D",
        "success-soft": "#F2F2F2",
        "warning": "#666666",
        "warning-soft": "#F5F5F5",
        "danger": "#333333",
        "danger-soft": "#F5F5F5",
        "backdrop": "#000000",
    },
    "mobile-hifi": {
        "name": "mobile-hifi",
        "label": "移动端高保真现代蓝主题 (Mobile Hi-Fi Modern)",
        "bg": "#F2F4F8",
        "surface": "#FFFFFF",
        "surface-2": "#F8FAFC",
        "surface-3": "#E2E8F0",
        "sidebar-bg": "#111827",
        "sidebar-surface": "#1F2937",
        "sidebar-active": "#1677FF",
        "sidebar-ink": "#9CA3AF",
        "sidebar-ink-active": "#FFFFFF",
        "ink": "#111827",
        "ink-2": "#4B5563",
        "ink-3": "#9CA3AF",
        "ink-inv": "#FFFFFF",
        "line": "#E5E7EB",
        "line-strong": "#CBD5E1",
        "brand": "#1677FF",
        "brand-soft": "#EBF3FF",
        "accent": "#0EA5E9",
        "accent-soft": "#E0F2FE",
        "success": "#10B981",
        "success-soft": "#ECFDF5",
        "warning": "#F59E0B",
        "warning-soft": "#FFFBEB",
        "danger": "#EF4444",
        "danger-soft": "#FEF2F2",
        "backdrop": "#111827",
    },
    "aurora-glass": {
        "name": "aurora-glass", "label": "极光毛玻璃高定主题 (Aurora Frosted Glass)",
        "bg": "#070913", "surface": "#121829CC", "surface-2": "#1A2238B3", "surface-3": "#24304D99",
        "glass": "#18223899", "glass-strong": "#1E2942CC", "glass-border": "#FFFFFF24", "glow": "#8B5CF6",
        "sidebar-bg": "#0A0E1ECC", "sidebar-surface": "#12182999", "sidebar-active": "#7C3AED",
        "sidebar-ink": "#94A3B8", "sidebar-ink-active": "#FFFFFF",
        "ink": "#F8FAFC", "ink-2": "#CBD5E1", "ink-3": "#64748B", "ink-inv": "#FFFFFF",
        "line": "#FFFFFF1F", "line-strong": "#FFFFFF38",
        "brand": "#7C3AED", "brand-soft": "#2E106599", "accent": "#06B6D4", "accent-soft": "#08334499",
        "success": "#10B981", "success-soft": "#064E3B99", "warning": "#F59E0B", "warning-soft": "#451A0399",
        "danger": "#F43F5E", "danger-soft": "#4C051999", "backdrop": "#05070F",
    },
    "editorial-warm": {
        "name": "editorial-warm", "label": "暖调人文杂志风主题 (Editorial Warm Craft)",
        "bg": "#FAF7F2", "surface": "#FFFFFF", "surface-2": "#F3EFE6", "surface-3": "#E6DFD1",
        "glass": "#FFFFFFCC", "glass-strong": "#FFFFFFE6", "glass-border": "#D8CFC0", "glow": "#D97706",
        "sidebar-bg": "#292524", "sidebar-surface": "#1C1917", "sidebar-active": "#D97706",
        "sidebar-ink": "#A8A29E", "sidebar-ink-active": "#FAFAF9",
        "ink": "#1C1917", "ink-2": "#57534E", "ink-3": "#A8A29E", "ink-inv": "#FFFFFF",
        "line": "#E7E0D3", "line-strong": "#D6CEC0",
        "brand": "#C2410C", "brand-soft": "#FFEDD5", "accent": "#0F766E", "accent-soft": "#CCFBF1",
        "success": "#15803D", "success-soft": "#DCFCE7", "warning": "#B45309", "warning-soft": "#FEF3C7",
        "danger": "#B91C1C", "danger-soft": "#FEE2E2", "backdrop": "#1C1917",
    },
    "cyber-neon": {
        "name": "cyber-neon", "label": "赛博霓虹暗夜主题 (Cyber Neon Matrix)",
        "bg": "#06070B", "surface": "#0E111A", "surface-2": "#161B29", "surface-3": "#20273B",
        "glass": "#121726B3", "glass-strong": "#181F33D9", "glass-border": "#38BDF833", "glow": "#22D3EE",
        "sidebar-bg": "#080A10", "sidebar-surface": "#0E111A", "sidebar-active": "#06B6D4",
        "sidebar-ink": "#64748B", "sidebar-ink-active": "#ECFEFF",
        "ink": "#F1F5F9", "ink-2": "#94A3B8", "ink-3": "#475569", "ink-inv": "#06070B",
        "line": "#1E293B", "line-strong": "#334155",
        "brand": "#22D3EE", "brand-soft": "#083344", "accent": "#A855F7", "accent-soft": "#3B0764",
        "success": "#34D399", "success-soft": "#064E3B", "warning": "#FBBF24", "warning-soft": "#451A03",
        "danger": "#FB7185", "danger-soft": "#4C0519", "backdrop": "#030407",
    },
}

def snap_token(val, scale):
    if val is None:
        return scale[0]
    if isinstance(val, str):
        s = val.strip().lower().replace("-", "").replace("_", "")
        kw = {
            "thin": 100, "extralight": 200, "ultralight": 200, "light": 300,
            "normal": 400, "regular": 400, "book": 400, "medium": 500,
            "semibold": 600, "demibold": 600, "bold": 700,
            "extrabold": 800, "ultrabold": 800, "black": 900, "heavy": 900,
        }
        if s in kw:
            val = kw[s]
    v = int(round(float(val)))
    if scale and scale[0] <= v <= scale[-1]:
        return v
    return min(scale, key=lambda s: abs(s - v))

def resolve_color(val, theme_dict):
    if not val:
        return None
    s = str(val).strip()
    if s.startswith("$"):
        key = s[1:]
        key = {
            "ok": "success", "ok-soft": "success-soft",
            "warn": "warning", "warn-soft": "warning-soft",
            "err": "danger", "err-soft": "danger-soft",
            "error": "danger", "error-soft": "danger-soft",
            "primary": "brand", "primary-soft": "brand-soft",
            "border": "line", "border-strong": "line-strong",
            "muted": "ink-2", "text": "ink", "text-2": "ink-2", "text-3": "ink-3", "white": "surface",
        }.get(key.lower(), key)
        return theme_dict.get(key, theme_dict.get("ink", "#1E293B"))
    if s in theme_dict:
        return theme_dict[s]
    if s.lower().startswith("rgba(") and s.endswith(")"):
        try:
            parts = [p.strip() for p in s[5:-1].split(",")]
            r, g, b = int(float(parts[0])), int(float(parts[1])), int(float(parts[2]))
            a = float(parts[3]) if len(parts) > 3 else 1.0
            if a > 1.0:
                a = a / 255.0
            aa = max(0, min(255, int(round(a * 255))))
            return f"#{r:02X}{g:02X}{b:02X}" if aa == 255 else f"#{r:02X}{g:02X}{b:02X}{aa:02X}"
        except Exception:
            return "#1E293B"
    if s.startswith("#"):
        if len(s) in (4, 5):
            s = "#" + "".join(ch * 2 for ch in s[1:])
        return s.upper()
    return s
def parse_padding(pad):
    if pad is None:
        return (0, 0, 0, 0)
    if isinstance(pad, (int, float)):
        v = snap_token(pad, SPACING_TOKENS)
        return (v, v, v, v)
    if isinstance(pad, (list, tuple)):
        if len(pad) == 1:
            v = snap_token(pad[0], SPACING_TOKENS)
            return (v, v, v, v)
        if len(pad) == 2:
            py = snap_token(pad[0], SPACING_TOKENS)
            px = snap_token(pad[1], SPACING_TOKENS)
            return (py, px, py, px)
        if len(pad) >= 4:
            return tuple(snap_token(pad[i], SPACING_TOKENS) for i in range(4))
    return (0, 0, 0, 0)

def hex_to_rgb_float(hex_str, alpha=1.0):
    if not hex_str:
        return {"a": 0.0, "r": 0.0, "g": 0.0, "b": 0.0}
    s = str(hex_str).strip().lstrip("#")
    if len(s) in (3, 4):
        s = "".join(c * 2 for c in s)
    a_mul = (int(s[6:8], 16) / 255.0) if len(s) >= 8 else 1.0
    return {
        "a": float(alpha) * a_mul,
        "r": int(s[0:2], 16) / 255.0,
        "g": int(s[2:4], 16) / 255.0,
        "b": int(s[4:6], 16) / 255.0,
    }

def hex_to_rgba_tuple(hex_str, alpha=1.0):
    if not hex_str:
        return (0, 0, 0, 0)
    s_raw = str(hex_str).strip()
    if s_raw.lower() in ("transparent", "none"):
        return (0, 0, 0, 0)
    s = s_raw.lstrip("#")
    if len(s) in (3, 4):
        s = "".join(c * 2 for c in s)
    a_mul = (int(s[6:8], 16) / 255.0) if len(s) >= 8 else 1.0
    return (
        int(s[0:2], 16),
        int(s[2:4], 16),
        int(s[4:6], 16),
        int(round(float(alpha) * a_mul * 255)),
    )

# -------------------- 2. HIGH-LEVEL SEMANTIC COMPONENT EXPANDER --------------------
def make_box(name, **kwargs):
    node = {"type": "box", "name": name}
    node.update(kwargs)
    return node
def make_label(name, text, size=14, weight=400, color="$ink", align="left", **kwargs):
    node = {
        "type": "label",
        "name": name,
        "text": str(text),
        "fontSize": snap_token(size, FONT_SIZE_TOKENS),
        "fontWeight": snap_token(weight, FONT_WEIGHT_TOKENS),
        "color": color,
        "align": align,
    }
    node.update(kwargs)
    return node
def make_button(name, text, variant="primary", w=None, h=32, size=13, radius=6, **kwargs):
    styles = {
        "primary": {"fill": "$brand", "color": "$ink-inv", "stroke": None, "weight": 600},
        "accent": {"fill": "$accent", "color": "$ink-inv", "stroke": None, "weight": 600},
        "secondary": {"fill": "$surface-2", "color": "$ink", "stroke": "$line-strong", "weight": 500},
        "outline": {"fill": "$surface", "color": "$ink-2", "stroke": "$line-strong", "weight": 500},
        "soft": {"fill": "$brand-soft", "color": "$brand", "stroke": None, "weight": 600},
        "accent-soft": {"fill": "$accent-soft", "color": "$accent", "stroke": None, "weight": 600},
        "success-soft": {"fill": "$success-soft", "color": "$success", "stroke": None, "weight": 600},
        "warning-soft": {"fill": "$warning-soft", "color": "$warning", "stroke": None, "weight": 600},
        "danger-soft": {"fill": "$danger-soft", "color": "$danger", "stroke": None, "weight": 600},
        "danger": {"fill": "$danger", "color": "$ink-inv", "stroke": None, "weight": 600},
        "glass": {"fill": "$glass", "color": "$ink", "stroke": "$glass-border", "weight": 600},
        "ghost": {"fill": None, "color": "$ink-2", "stroke": None, "weight": 500},
        "sidebar-active": {"fill": "$sidebar-active", "color": "$sidebar-ink-active", "stroke": None, "weight": 600},
        "sidebar-item": {"fill": "$sidebar-surface", "color": "$sidebar-ink", "stroke": None, "weight": 400},
    }
    st = styles.get(variant, styles["primary"])
    tw, _ = measure_text(text, size, st["weight"])
    spacing = float(kwargs.get("letterSpacing") or 0)
    if spacing:
        tw += max((max(0, len(line) - 1) * spacing for line in str(text).split("\n")), default=0)
    btn_w = w if w is not None else max(64, tw + 24)
    node = {
        "type": "shape-text",
        "name": name,
        "text": str(text),
        "w": btn_w,
        "_auto_w": w is None,
        "h": h,
        "fill": kwargs.pop("fill", st["fill"]),
        "stroke": kwargs.pop("stroke", st["stroke"]),
        "color": kwargs.pop("color", st["color"]),
        "fontSize": snap_token(size, FONT_SIZE_TOKENS),
        "fontWeight": snap_token(st["weight"], FONT_WEIGHT_TOKENS),
        "radius": snap_token(radius, RADIUS_TOKENS),
        "align": kwargs.pop("align", "center"),
    }
    node.update(kwargs)
    return node
def expand_sidebar(node):
    cid = node.get("id", "main")
    w = int(node.get("w") or 208)
    h = int(node.get("h") or 900)
    brand_title = node.get("brandTitle") or node.get("brand") or "Supermancall"
    brand_sub = node.get("brandSubtitle") or node.get("brandSub") or "餐饮数字化经营中台"
    items = node.get("items") or node.get("navItems") or []
    active_index = node.get("activeIndex", node.get("activeNav", 1))
    store_name = node.get("storeName", "朝阳大悦城旗舰店 · 营业中")
    nav_children = []
    for idx, it in enumerate(items):
        if isinstance(it, dict):
            iid = it.get("id", f"item-{idx+1}")
            label = it.get("label", f"菜单 {idx+1}")
            active = bool(it.get("active", idx == active_index))
            badge = it.get("badge")
        else:
            iid = f"item-{idx+1}"
            label = str(it)
            active = idx == active_index
            badge = None
        row_children = [
            {
                "type": "shape-text",
                "name": f"nav-dot-{iid}",
                "text": "●" if active else "·",
                "w": 16,
                "h": 24,
                "fill": None,
                "color": "$sidebar-ink-active" if active else "$sidebar-ink",
                "fontSize": 12,
                "fontWeight": 600,
                "align": "center",
            },
            make_label(
                f"nav-lbl-{iid}",
                label,
                size=13,
                weight=600 if active else 400,
                color="$sidebar-ink-active" if active else "$sidebar-ink",
                flex=1,
            ),
        ]
        if badge:
            row_children.append(
                make_button(
                    f"nav-badge-{iid}",
                    str(badge),
                    variant="danger" if badge != "NEW" else "primary",
                    w=32,
                    h=20,
                    size=11,
                    radius=12,
                )
            )
        nav_children.append(
            make_box(
                f"grp-nav-{iid}",
                layout="row",
                w=w - 24,
                h=40,
                padding=[8, 8],
                gap=4,
                align="center",
                fill="$sidebar-active" if active else "$sidebar-surface",
                radius=8,
                isGroup=True,
                bgName=f"bg-nav-{iid}",
                children=row_children,
            )
        )
    return make_box(
        f"grp-sidebar-{cid}",
        layout="column",
        w=w,
        h=h,
        padding=[20, 12],
        gap=16,
        fill="$sidebar-bg",
        isGroup=True,
        bgName=f"bg-sidebar-{cid}",
        children=[
            make_box(
                f"grp-brand-{cid}",
                layout="row",
                w=w - 24,
                h=52,
                padding=[8, 8],
                gap=12,
                align="center",
                fill="$sidebar-surface",
                radius=8,
                isGroup=True,
                bgName=f"bg-brand-{cid}",
                children=[
                    make_button(f"icon-brand-{cid}", "S", variant="primary", w=32, h=32, size=16, radius=8),
                    make_box(
                        f"grp-brand-txt-{cid}",
                        layout="column",
                        gap=4,
                        flex=1,
                        isGroup=False,
                        children=[
                            make_label(f"txt-brand-title-{cid}", brand_title, size=14, weight=700, color="$sidebar-ink-active"),
                            make_label(f"txt-brand-sub-{cid}", brand_sub, size=11, weight=400, color="$sidebar-ink"),
                        ],
                    ),
                ],
            ),
            make_label(f"txt-nav-sec-{cid}", "核心业务导航", size=11, weight=600, color="$sidebar-ink"),
            make_box(
                f"grp-nav-list-{cid}",
                layout="column",
                w=w - 24,
                gap=8,
                flex=1,
                isGroup=True,
                children=nav_children,
            ),
            make_box(
                f"grp-store-card-{cid}",
                layout="column",
                w=w - 24,
                h=68,
                padding=[12, 12],
                gap=4,
                fill="$sidebar-surface",
                radius=8,
                isGroup=True,
                bgName=f"bg-store-card-{cid}",
                children=[
                    make_label(f"txt-store-status-{cid}", "● 云端同步正常 (RTT 18ms)", size=11, weight=600, color="$success"),
                    make_label(f"txt-store-name-{cid}", store_name, size=12, weight=400, color="$sidebar-ink"),
                ],
            ),
        ],
    )

def expand_topbar(node):
    cid = node.get("id", "main")
    w = int(node.get("w") or 1232)
    h = int(node.get("h") or 64)
    title = node.get("title", "菜品与库存管理中台")
    subtitle = node.get("subtitle", "实时管理门店在售菜品、多规格定价与库存预警")
    badge_txt = node.get("badgeText", "● 实时库存联动已开启")
    if not str(badge_txt).startswith("●"):
        badge_txt = f"● {badge_txt}"
    primary_btn = node.get("primaryButton") or {"name": "btn-new-dish", "label": node.get("primaryText") or node.get("ctaText") or "+ 新建菜品"}
    secondary_btn = node.get("secondaryButton") or {"name": "btn-export-report", "label": node.get("secondaryText") or "导出报表"}
    return make_box(
        f"grp-topbar-{cid}",
        layout="row",
        w=w,
        h=h,
        padding=[12, 24],
        gap=16,
        align="center",
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-topbar-{cid}",
        children=[
            make_box(
                f"grp-topbar-titles-{cid}",
                layout="column",
                gap=4,
                flex=1,
                isGroup=False,
                children=[
                    make_label(f"txt-page-title", title, size=18, weight=700, color="$ink"),
                    make_label(f"txt-page-subtitle", subtitle, size=12, weight=400, color="$ink-3"),
                ],
            ),
            make_button(
                "badge-live-sync",
                badge_txt,
                variant="success-soft",
                w=148,
                h=28,
                size=12,
                radius=999,
            ),
            make_button(
                secondary_btn.get("name", "btn-export-report"),
                secondary_btn.get("label", "导出报表"),
                variant="outline",
                w=96,
                h=36,
                size=13,
                radius=6,
            ),
            make_button(
                primary_btn.get("name", "btn-new-dish"),
                primary_btn.get("label", "+ 新建菜品"),
                variant="primary",
                w=112,
                h=36,
                size=13,
                radius=6,
            ),
        ],
    )

def expand_kpi_card(node):
    cid = node.get("id", "kpi")
    label = node.get("label", "核心指标")
    val = node.get("value", "0")
    trend = node.get("trend", "+12.5%")
    trend_type = node.get("trendType", "success")
    sub = node.get("subtitle", "较昨日同期")
    accent = node.get("accent", "$brand")
    badge_variant = "success-soft" if trend_type == "success" else ("danger-soft" if trend_type == "danger" else "warning-soft")
    return make_box(
        f"grp-kpi-{cid}",
        layout="column",
        w=node.get("w"),
        h=node.get("h", 112),
        flex=node.get("flex", 1),
        padding=[16, 20],
        gap=8,
        fill="$surface",
        stroke="$line",
        radius=8,
        isGroup=True,
        bgName=f"bg-kpi-{cid}",
        children=[
            make_box(
                f"grp-kpi-head-{cid}",
                layout="row",
                align="center",
                gap=8,
                isGroup=False,
                children=[
                    make_box(f"bar-kpi-accent-{cid}", layout="stack", w=4, h=16, fill=accent, radius=4, isGroup=False, bgName=f"dot-kpi-{cid}", children=[]),
                    make_label(f"txt-kpi-{cid}-label", label, size=13, weight=500, color="$ink-2", flex=1),
                    make_button(f"badge-kpi-{cid}-trend", trend, variant=badge_variant, h=22, size=11, radius=999),
                ],
            ),
            make_label(f"txt-kpi-{cid}-val", val, size=24, weight=700, color="$ink"),
            make_label(f"txt-kpi-{cid}-sub", sub, size=12, weight=400, color="$ink-3"),
        ],
    )

def expand_chart_state(state_id, title, subtitle, series_labels, values, unit="单", accent="$brand", mode="bar"):
    """生成单个图表状态页的完整自动布局树（尺寸 744x220，支持柱状趋势/折线趋势/品类占比）。"""
    w = 744
    h = 216
    bars = []
    max_v = max(values) if values else 100
    if mode in ("bar", "line"):
        for idx, (lbl, v) in enumerate(zip(series_labels, values)):
            ratio = max(0.12, min(1.0, float(v) / float(max_v)))
            bar_h = int(round(ratio * 96))
            spacer_h = max(4, 100 - bar_h)
            col_color = accent if idx == len(values) - 1 else ("$accent" if mode == "line" else "$brand")
            bars.append(
                make_box(
                    f"grp-chart-{state_id}-col-{idx+1}",
                    layout="column",
                    flex=1,
                    h=144,
                    align="center",
                    gap=4,
                    isGroup=True,
                    children=[
                        make_box(f"sp-{state_id}-{idx+1}", layout="stack", w=8, h=spacer_h, isGroup=False, children=[]),
                        make_label(f"txt-{state_id}-v-{idx+1}", f"{v}{unit}", size=11, weight=600, color="$ink-2", align="center"),
                        make_box(
                            f"bar-{state_id}-{idx+1}",
                            layout="stack",
                            w=28 if mode == "bar" else 16,
                            h=bar_h,
                            fill=col_color,
                            radius=4,
                            isGroup=False,
                            bgName=f"bar-{state_id}-rect-{idx+1}",
                            children=[],
                        ),
                        make_label(f"txt-{state_id}-x-{idx+1}", lbl, size=11, weight=400, color="$ink-3", align="center"),
                    ],
                )
            )
        body = make_box(
            f"grp-chart-{state_id}-plot",
            layout="row",
            w=w - 32,
            h=148,
            gap=12,
            align="end",
            padding=[4, 8],
            fill="$surface-2",
            radius=8,
            isGroup=True,
            bgName=f"bg-chart-{state_id}-plot",
            children=bars,
        )
    else:
        # 品类占比横向分布条
        rank_rows = []
        palette = ["$brand", "$accent", "$success", "$warning"]
        for idx, (lbl, v) in enumerate(zip(series_labels[:4], values[:4])):
            pct = int(round(float(v)))
            fill_w = max(24, int(round((w - 280) * (pct / 100.0))))
            rank_rows.append(
                make_box(
                    f"grp-cat-row-{idx+1}",
                    layout="row",
                    w=w - 48,
                    h=28,
                    gap=12,
                    align="center",
                    isGroup=True,
                    children=[
                        make_label(f"txt-cat-name-{idx+1}", lbl, size=12, weight=600, color="$ink", w=112),
                        make_box(
                            f"bar-cat-track-{idx+1}",
                            layout="row",
                            w=fill_w,
                            h=12,
                            fill=palette[idx % len(palette)],
                            radius=6,
                            isGroup=False,
                            bgName=f"bar-cat-fill-{idx+1}",
                            children=[],
                        ),
                        make_label(f"txt-cat-pct-{idx+1}", f"{pct}% ({v * 12} 单)", size=12, weight=600, color="$ink-2"),
                    ],
                )
            )
        body = make_box(
            f"grp-chart-{state_id}-ranks",
            layout="column",
            w=w - 32,
            h=148,
            padding=[12, 16],
            gap=8,
            fill="$surface-2",
            radius=8,
            isGroup=True,
            bgName=f"bg-chart-{state_id}-ranks",
            children=rank_rows,
        )
    return make_box(
        f"grp-state-{state_id}",
        layout="column",
        w=w,
        h=h,
        padding=[12, 16],
        gap=8,
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName=f"bg-state-{state_id}",
        children=[
            make_box(
                f"grp-state-head-{state_id}",
                layout="row",
                w=w - 32,
                h=28,
                align="center",
                gap=12,
                isGroup=False,
                children=[
                    make_label(f"txt-state-title-{state_id}", title, size=14, weight=700, color="$ink"),
                    make_label(f"txt-state-sub-{state_id}", subtitle, size=12, weight=400, color="$ink-3", flex=1),
                    make_button(f"badge-state-{state_id}", "实时聚合", variant="soft", w=72, h=22, size=11, radius=999),
                ],
            ),
            body,
        ],
    )

def expand_table_four_states(w=1184, h=336, rows=None):
    """生成表格组件的完整四态视图树: default / empty / loading / error。"""
    if not rows:
        rows = [
            {"code": "D-101", "name": "招牌藤椒烤鱼 (整条)", "cat": "川湘招牌", "price": "¥ 128.00", "stock": "46 份", "sales": "342", "status": "在售中", "statusVariant": "success-soft"},
            {"code": "D-102", "name": "黑松露和牛能量碗", "cat": "主厨轻食", "price": "¥ 68.00", "stock": "18 份", "sales": "219", "status": "在售中", "statusVariant": "success-soft"},
            {"code": "D-103", "name": "手作杨枝甘露冰酪", "cat": "鲜果甜品", "price": "¥ 26.00", "stock": "5 份", "sales": "410", "status": "库存预警", "statusVariant": "warning-soft"},
            {"code": "D-104", "name": "炭烤伊比利亚黑猪颈肉", "cat": "特色烧烤", "price": "¥ 88.00", "stock": "32 份", "sales": "165", "status": "在售中", "statusVariant": "success-soft"},
            {"code": "D-105", "name": "限定桂花酒酿小圆子", "cat": "时令饮品", "price": "¥ 22.00", "stock": "0 份", "sales": "98", "status": "已售罄", "statusVariant": "danger-soft"},
        ]
    col_specs = [
        ("code", "菜品编码", 104),
        ("name", "菜品名称", 268),
        ("cat", "所属分类", 136),
        ("price", "标准售价", 128),
        ("stock", "当前库存", 120),
        ("sales", "今日销量", 112),
        ("status", "状态", 116),
        ("action", "操作", 120),
    ]
    def build_header(prefix):
        return make_box(
            f"grp-{prefix}-thead",
            layout="row",
            w=w - 32,
            h=36,
            padding=[6, 8],
            gap=4,
            align="center",
            fill="$surface-2",
            stroke="$line",
            radius=6,
            isGroup=True,
            bgName=f"bg-{prefix}-thead",
            children=[
                make_label(f"th-{prefix}-{k}", title, size=12, weight=600, color="$ink-2", w=cw)
                for k, title, cw in col_specs
            ],
        )
    # 1. DEFAULT STATE
    row_nodes = [build_header("tbl")]
    for idx, r in enumerate(rows[:5]):
        rid = idx + 1
        row_nodes.append(
            make_box(
                f"grp-tbl-row-{rid}",
                layout="row",
                w=w - 32,
                h=42,
                padding=[6, 8],
                gap=4,
                align="center",
                fill="$surface" if rid % 2 == 1 else "$surface-2",
                stroke="$line",
                radius=6,
                isGroup=True,
                bgName=f"bg-tbl-row-{rid}",
                children=[
                    make_label(f"cell-r{rid}-code", r["code"], size=12, weight=500, color="$ink-3", w=104),
                    make_label(f"cell-r{rid}-name", r["name"], size=13, weight=600, color="$ink", w=268),
                    make_label(f"cell-r{rid}-cat", r["cat"], size=12, weight=400, color="$ink-2", w=136),
                    make_label(f"cell-r{rid}-price", r["price"], size=13, weight=600, color="$ink", w=128),
                    make_label(f"cell-r{rid}-stock", r["stock"], size=12, weight=500, color="$ink-2", w=120),
                    make_label(f"cell-r{rid}-sales", f"{r['sales']} 单", size=12, weight=500, color="$ink-2", w=112),
                    make_button(f"badge-r{rid}-status", r["status"], variant=r["statusVariant"], w=88, h=24, size=11, radius=999),
                    make_box(f"sp-r{rid}-st", layout="stack", w=20, h=12, isGroup=False, children=[]),
                    make_button(f"btn-r{rid}-edit", "编辑 / 调价", variant="soft", w=96, h=26, size=11, radius=6),
                ],
            )
        )
    row_nodes.append(
        make_box(
            "grp-tbl-pagination",
            layout="row",
            w=w - 32,
            h=32,
            padding=[4, 8],
            gap=8,
            align="center",
            isGroup=True,
            children=[
                make_label("txt-tbl-total", "共 58 道在库菜品 · 当前显示第 1–5 条", size=12, weight=400, color="$ink-3", flex=1),
                make_button("btn-page-prev", "上一页", variant="outline", w=68, h=28, size=12, radius=6),
                make_button("btn-page-1", "1", variant="primary", w=32, h=28, size=12, radius=6),
                make_button("btn-page-2", "2", variant="outline", w=32, h=28, size=12, radius=6),
                make_button("btn-page-next", "下一页", variant="outline", w=68, h=28, size=12, radius=6),
            ],
        )
    )
    default_tree = make_box(
        "grp-table-state-default",
        layout="column",
        w=w,
        h=h,
        padding=[8, 16],
        gap=4,
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-default",
        children=row_nodes,
    )
    # 2. EMPTY STATE
    empty_tree = make_box(
        "grp-table-state-empty",
        layout="column",
        w=w,
        h=h,
        padding=[16, 16],
        gap=16,
        align="center",
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-empty",
        children=[
            build_header("empty"),
            make_box(
                "grp-empty-card",
                layout="column",
                w=w - 64,
                h=236,
                padding=[28, 32],
                gap=12,
                align="center",
                fill="$surface-2",
                stroke="$line",
                radius=12,
                isGroup=True,
                bgName="bg-empty-card",
                children=[
                    make_button("icon-empty-box", "○ 暂无匹配数据", variant="soft", w=144, h=36, size=13, radius=999),
                    make_label("txt-empty-title", "未检索到符合当前筛选条件的菜品", size=16, weight=700, color="$ink", align="center"),
                    make_label(
                        "txt-empty-desc",
                        "建议清空关键词或分类过滤条件，或点击右上角「+ 新建菜品」直接录入新菜品",
                        size=13,
                        weight=400,
                        color="$ink-3",
                        align="center",
                    ),
                    make_button("btn-empty-cta", "重置筛选并恢复列表", variant="primary", w=168, h=36, size=13, radius=6),
                ],
            ),
        ],
    )
    # 3. LOADING STATE
    skel_rows = [
        build_header("load"),
        make_box(
            "grp-loading-banner",
            layout="row",
            w=w - 32,
            h=36,
            padding=[6, 16],
            gap=12,
            align="center",
            fill="$accent-soft",
            radius=6,
            isGroup=True,
            bgName="bg-loading-banner",
            children=[
                make_button("badge-loading-spin", "● 同步中", variant="accent", w=80, h=24, size=11, radius=999),
                make_label("txt-loading-msg", "正在从云端菜单中心拉取实时库存与多规格价格数据...", size=12, weight=600, color="$accent", flex=1),
            ],
        ),
    ]
    for sidx in range(1, 5):
        skel_rows.append(
            make_box(
                f"grp-skel-row-{sidx}",
                layout="row",
                w=w - 32,
                h=44,
                padding=[12, 12],
                gap=16,
                align="center",
                fill="$surface",
                stroke="$line",
                radius=6,
                isGroup=True,
                bgName=f"bg-skel-row-{sidx}",
                children=[
                    make_box(f"skel-r{sidx}-c1", layout="stack", w=88, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-1", children=[]),
                    make_box(f"skel-r{sidx}-c2", layout="stack", w=220, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-2", children=[]),
                    make_box(f"skel-r{sidx}-c3", layout="stack", w=112, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-3", children=[]),
                    make_box(f"skel-r{sidx}-c4", layout="stack", w=96, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-4", children=[]),
                    make_box(f"skel-r{sidx}-c5", layout="stack", w=140, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-5", children=[]),
                ],
            )
        )
    loading_tree = make_box(
        "grp-table-state-loading",
        layout="column",
        w=w,
        h=h,
        padding=[12, 16],
        gap=8,
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-loading",
        children=skel_rows,
    )
    # 4. ERROR STATE
    error_tree = make_box(
        "grp-table-state-error",
        layout="column",
        w=w,
        h=h,
        padding=[16, 16],
        gap=16,
        align="center",
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-error",
        children=[
            build_header("err"),
            make_box(
                "grp-error-card",
                layout="column",
                w=w - 64,
                h=236,
                padding=[28, 32],
                gap=12,
                align="center",
                fill="$danger-soft",
                stroke="$danger",
                radius=12,
                isGroup=True,
                bgName="bg-error-card",
                children=[
                    make_button("badge-error-code", "! ERR_GATEWAY_504", variant="danger", w=164, h=32, size=12, radius=999),
                    make_label("txt-error-title", "菜品与库存服务响应超时，数据加载失败", size=16, weight=700, color="$danger", align="center"),
                    make_label(
                        "txt-error-detail",
                        "上游节点 dish-inventory-rpc 在 3000ms 内未返回响应 (TraceID: 98a7f2c1) · 请检查网络或点击下方按钮重试",
                        size=13,
                        weight=400,
                        color="$ink-2",
                        align="center",
                    ),
                    make_button("btn-error-retry", "立即重新加载数据", variant="danger", w=168, h=36, size=13, radius=6),
                ],
            ),
        ],
    )
    return {
        "default": default_tree,
        "empty": empty_tree,
        "loading": loading_tree,
        "error": error_tree,
    }

def expand_notice_card(w=424, h=272):
    """右侧实时经营预警与热销榜单卡片。"""
    items = [
        ("alert-1", "库存预警", "手作杨枝甘露冰酪 仅剩 5 份", "warning-soft"),
        ("alert-2", "售罄提醒", "限定桂花酒酿小圆子 已售罄下架", "danger-soft"),
        ("alert-3", "热销飙升", "招牌藤椒烤鱼 今日销量突破 340 单", "success-soft"),
        ("alert-4", "价格同步", "美团/饿了么双渠道价格校验通过", "accent-soft"),
    ]
    rows = []
    for aid, tag, desc, var in items:
        rows.append(
            make_box(
                f"grp-notice-{aid}",
                layout="row",
                w=w - 32,
                h=40,
                padding=[8, 12],
                gap=12,
                align="center",
                fill="$surface-2",
                radius=6,
                isGroup=True,
                bgName=f"bg-notice-{aid}",
                children=[
                    make_button(f"badge-notice-{aid}", tag, variant=var, w=72, h=24, size=11, radius=999),
                    make_label(f"txt-notice-{aid}", desc, size=12, weight=500, color="$ink", flex=1),
                ],
            )
        )
    return make_box(
        "grp-card-notices",
        layout="column",
        w=w,
        h=h,
        padding=[16, 16],
        gap=12,
        fill="$surface",
        stroke="$line",
        radius=8,
        isGroup=True,
        bgName="bg-card-notices",
        children=[
            make_box(
                "grp-notice-head",
                layout="row",
                w=w - 32,
                h=28,
                align="center",
                gap=8,
                isGroup=False,
                children=[
                    make_label("txt-notice-title", "实时库存预警与门店动态", size=15, weight=700, color="$ink", flex=1),
                    make_button("badge-notice-count", "4 条待办", variant="warning-soft", w=68, h=22, size=11, radius=999),
                ],
            ),
            make_box("grp-notice-list", layout="column", w=w - 32, gap=8, isGroup=True, children=rows),
        ],
    )

def expand_modal_new_dish(canvas_w=1440, canvas_h=900):
    """生成居中弹窗层（含半透明遮罩、卡片、原生 TextBox 占位与表单校验提示栏）。"""
    mw, mh = 520, 408
    mx = (canvas_w - mw) // 2
    my = (canvas_h - mh) // 2
    return make_box(
        "grp-modal-new-dish",
        layout="stack",
        x=mx,
        y=my,
        w=mw,
        h=mh,
        isGroup=True,
        isModal=True,
        children=[
            make_box(
                "grp-modal-card",
                layout="column",
                w=mw,
                h=mh,
                padding=[24, 24],
                gap=16,
                fill="$surface",
                stroke="$brand",
                radius=12,
                isGroup=True,
                bgName="modal-card",
                children=[
                    make_box(
                        "grp-modal-header",
                        layout="row",
                        w=mw - 48,
                        h=32,
                        align="center",
                        gap=12,
                        isGroup=False,
                        children=[
                            make_label("txt-modal-title", "新建门店在售菜品", size=18, weight=700, color="$ink", flex=1),
                            make_button("btn-modal-close", "× 关闭", variant="outline", w=68, h=28, size=12, radius=6),
                        ],
                    ),
                    make_label(
                        "txt-modal-subtitle",
                        "请录入菜品名称与标准售价（带 * 号为必填项，提交时触发实时非空校验）",
                        size=12,
                        weight=400,
                        color="$ink-3",
                    ),
                    make_box(
                        "grp-field-dish-name",
                        layout="column",
                        w=mw - 48,
                        gap=8,
                        isGroup=True,
                        children=[
                            make_label("lbl-dish-name", "* 菜品名称 (必填)", size=13, weight=600, color="$ink"),
                            {
                                "type": "native-input",
                                "name": "input-dish-name",
                                "placeholder": "例如：黑松露和牛能量碗",
                                "w": mw - 48,
                                "h": 36,
                                "fill": "$surface-2",
                                "stroke": "$line-strong",
                                "radius": 6,
                            },
                        ],
                    ),
                    make_box(
                        "grp-field-dish-price",
                        layout="column",
                        w=mw - 48,
                        gap=8,
                        isGroup=True,
                        children=[
                            make_label("lbl-dish-price", "* 标准售价 (元 / 必填)", size=13, weight=600, color="$ink"),
                            {
                                "type": "native-input",
                                "name": "input-dish-price",
                                "placeholder": "例如：68.00",
                                "w": mw - 48,
                                "h": 36,
                                "fill": "$surface-2",
                                "stroke": "$line-strong",
                                "radius": 6,
                            },
                        ],
                    ),
                    make_button(
                        "txt-modal-feedback",
                        "请填写上方必填字段后点击「确认保存菜品」",
                        variant="soft",
                        w=mw - 48,
                        h=36,
                        size=12,
                        radius=6,
                    ),
                    make_box(
                        "grp-modal-footer",
                        layout="row",
                        w=mw - 48,
                        h=40,
                        gap=12,
                        justify="end",
                        align="center",
                        isGroup=False,
                        children=[
                            make_button("btn-modal-cancel", "取消", variant="outline", w=96, h=36, size=13, radius=6),
                            make_button("btn-modal-submit", "确认保存菜品", variant="primary", w=136, h=36, size=13, radius=6),
                        ],
                    ),
                ],
            )
        ],
    )

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
    if ntype in ("shape-text", "native-input"):
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


def make_axvg_vector_shape(item_id, name, x, y, w, h, fill_hex=None, stroke_hex=None, radius=0, text=None, font_size=14, font_weight=400, text_color_hex="#1E293B", align="left", alpha=1.0, v_align=None, stroke_width=1, border_sides=15, spans=None, italic=False, underline=False, strikethrough=False, letter_spacing=0, gradient=None):
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
        "rotation": 0,
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
            "family": "Inter",
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


def make_axvg_image_shape(item_id, name, x, y, w, h, image_key):
    """创建支持透明 PNG 的 Axvg 图片元件 (backgroundFills type=3 + imageMap)。"""
    return {
        "itemType": 1,
        "id": str(item_id),
        "name": str(name),
        "visible": True,
        "isLocked": False,
        "isNameDynamic": False,
        "rotation": 0,
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
            return make_axvg_image_shape(next_id(), name, nx, ny, nw, nh, img_key)
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
            return make_axvg_image_shape(next_id(), name, nx, ny, nw, nh, image_key)
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
                "inModal": cur_modal,
                **({"previewText": inp_txt, "size": node.get("fontSize", node.get("size", 13)), "weight": node.get("fontWeight", node.get("weight", 400)), "color": inp_col, "align": node.get("align", "left")} if inp_txt else {}),
            })
            return make_axvg_vector_shape(
                next_id(), bg_name, nx, ny, nw, nh,
                fill_hex=fill_h, stroke_hex=stroke_h, radius=node.get("radius", 6),
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
            if (has_opt or ((fill_h or stroke_h) and aln in ("left", "right") and nw >= 36)) and txt is not None and str(txt) != "":
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
                        text=txt, font_size=fsz, font_weight=fwt, text_color_hex=txt_h, align=aln, alpha=alpha_v, v_align="middle",
                        spans=resolved_spans, italic=node.get("italic", False), underline=node.get("underline", False),
                        strikethrough=node.get("strikethrough", False), letter_spacing=node.get("letterSpacing", 0),
                    )
                    return {
                        "flippedHorizontal": False, "flippedVertical": False, "id": next_id(), "name": grp_box_name,
                        "visible": True, "isLocked": False, "isNameDynamic": False, "rotation": 0,
                        "rect": {"location": {"x": nx, "y": ny}, "size": {"width": nw, "height": nh}},
                        "resizingConstraints": {"hasFixedLeft": True, "hasFixedRight": False, "hasFixedTop": True, "hasFixedBottom": False, "hasFixedWidth": True, "hasFixedHeight": True},
                        "itemType": 0, "effects": [], "scene": {"items": [bg_shape, txt_shape]},
                    }
            if resolved_spans and len(resolved_spans) > 1 and not fill_h and not stroke_h:
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
                        text=stxt, font_size=s_sz, font_weight=s_wt, text_color_hex=s_col, align="left",
                        alpha=alpha_v, v_align="middle",
                        italic=bool(sp.get("italic", node.get("italic", False))),
                        underline=bool(sp.get("underline", node.get("underline", False))),
                        strikethrough=bool(sp.get("strikethrough", node.get("strikethrough", False))),
                    ))
                if span_shapes:
                    return {
                        "flippedHorizontal": False, "flippedVertical": False, "id": next_id(), "name": name,
                        "visible": True, "isLocked": False, "isNameDynamic": False, "rotation": 0,
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
            })
            return make_axvg_vector_shape(
                next_id(), name, nx, ny, nw, nh,
                fill_hex=fill_h, stroke_hex=stroke_h, radius=rad,
                text=txt, font_size=fsz, font_weight=fwt, text_color_hex=txt_h, align=aln,
                alpha=alpha_v, stroke_width=sw_v, border_sides=bs_v, spans=resolved_spans,
                italic=node.get("italic", False), underline=node.get("underline", False),
                strikethrough=node.get("strikethrough", False), letter_spacing=node.get("letterSpacing", 0),
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
                "rotation": 0,
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
        screen_mask = Image.new("RGBA", (sw * 2, sh * 2), "#09090B")
        ImageDraw.Draw(screen_mask).rounded_rectangle(
            [0, 0, sw * 2 - 1, sh * 2 - 1], radius=88, fill=(0, 0, 0, 0))
        bezel_clip = Image.new("L", screen_mask.size, 0)
        ImageDraw.Draw(bezel_clip).rounded_rectangle(
            [-20, -20, sw * 2 + 19, sh * 2 + 19], radius=104, fill=255)
        screen_mask.putalpha(ImageChops.multiply(screen_mask.getchannel("A"), bezel_clip))
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
    ty = y + (height - ink_h) // 2 - bbox[1]
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
                    failures.append({"gate": "no_container_overflow", "severity": "structural",
                                     "widget": ch.get("name", ""), "box": [cx, cy, cw, ch_h],
                                     "container": node.get("name", ""), "containerBox": [nx, ny, nw, nh],
                                     "overflow": {"left": max(0, nx - cx), "top": max(0, ny - cy),
                                                  "right": max(0, (cx + cw) - (nx + nw)),
                                                  "bottom": max(0, (cy + ch_h) - (ny + nh))},
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
    # 给每条明细补 pageName（由调用方注入或留空）
    for _f in failures:
        if not _f.get("page"):
            _f["page"] = compile_plan.get("pageName", "")
    structural_gates = {
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

# -------------------- 5. FLAGSHIP PROTOTYPE BUILDER & CLI --------------------
def build_flagship_prototype(theme_name="enterprise-light", title_override=None):
    """构建旗舰级「餐饮菜品与实时库存经营中台」多态交互原型树与完整状态机。"""
    theme_dict = THEMES.get(theme_name, THEMES["enterprise-light"])
    # 1. 趋势图表动态面板 (3 个状态: orders / revenue / category)
    trend_states = [
        {
            "name": "orders",
            "label": "订单趋势",
            "tree": expand_chart_state(
                "orders",
                "近 7 日门店堂食与外卖订单量趋势",
                "峰值出现在周六晚高峰 (1,480 单/日) · 环比上周 +14.2%",
                ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
                [860, 920, 1040, 980, 1260, 1480, 1350],
                unit="单",
                accent="$brand",
                mode="bar",
            ),
        },
        {
            "name": "revenue",
            "label": "营收趋势",
            "tree": expand_chart_state(
                "revenue",
                "近 7 日门店实收营业额走势 (千元)",
                "实收毛利率稳定在 68.4% · 客单价均值 ¥ 64.50",
                ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
                [52, 58, 64, 61, 79, 96, 88],
                unit="k",
                accent="$accent",
                mode="line",
            ),
        },
        {
            "name": "category",
            "label": "品类占比",
            "tree": expand_chart_state(
                "category",
                "核心菜品品类销量与营收贡献占比",
                "川湘招牌与主厨轻食合计贡献 66% 核心营收",
                ["川湘招牌菜", "主厨能量碗", "特色炭烤类", "鲜果甜品饮品"],
                [38, 28, 20, 14],
                unit="%",
                accent="$success",
                mode="rank",
            ),
        },
    ]
    # 2. 菜品管理表格动态面板 (4 个必选状态: default / empty / loading / error)
    table_four = expand_table_four_states(w=1184, h=336)
    table_states = [
        {"name": "default", "label": "默认列表态", "tree": table_four["default"]},
        {"name": "empty", "label": "空数据态", "tree": table_four["empty"]},
        {"name": "loading", "label": "骨架加载态", "tree": table_four["loading"]},
        {"name": "error", "label": "接口异常态", "tree": table_four["error"]},
    ]
    # 3. 顶部导航、KPI 行、中部图表与预警区、底部四态表格控制栏
    sidebar = expand_sidebar({
        "id": "main",
        "w": 208,
        "h": 900,
        "brandTitle": "Supermancall",
        "brandSubtitle": "智慧餐饮经营系统 v4.2",
        "items": [
            {"id": "overview", "label": "经营数据总览", "active": False},
            {"id": "dishes", "label": "菜品与库存管理", "active": True, "badge": "58"},
            {"id": "orders", "label": "全渠道实时订单", "active": False, "badge": "12"},
            {"id": "members", "label": "会员营销与储值", "active": False},
            {"id": "supply", "label": "中央厨房供应链", "active": False},
            {"id": "settings", "label": "门店与权限设置", "active": False},
        ],
    })
    topbar = expand_topbar({
        "id": "main",
        "w": 1232,
        "h": 64,
        "title": title_override or "菜品与实时库存管理工作台",
        "subtitle": "支持多维趋势切换、表格四态预览 (Default / Empty / Loading / Error) 与新建菜品表单非空校验",
    })
    kpi_row = make_box(
        "grp-kpi-row",
        layout="row",
        w=1184,
        h=108,
        gap=16,
        isGroup=True,
        children=[
            expand_kpi_card({"id": "dishes", "label": "在售菜品总数", "value": "58", "trend": "+4 本周上新", "trendType": "success", "subtitle": "含 12 款多规格招牌菜", "accent": "$brand", "h": 108}),
            expand_kpi_card({"id": "orders", "label": "今日实时订单", "value": "1,480", "trend": "+14.2%", "trendType": "success", "subtitle": "堂食 890 单 · 外卖 590 单", "accent": "$accent", "h": 108}),
            expand_kpi_card({"id": "revenue", "label": "今日实收流水", "value": "¥ 96,420", "trend": "+18.6%", "trendType": "success", "subtitle": "客单价均值 ¥ 65.15", "accent": "$success", "h": 108}),
            expand_kpi_card({"id": "warn", "label": "库存预警/售罄", "value": "2 款", "trend": "需及时补货", "trendType": "warning", "subtitle": "杨枝甘露(5份) · 酒酿圆子(0份)", "accent": "$warning", "h": 108}),
        ],
    )
    middle_row = make_box(
        "grp-middle-section",
        layout="row",
        w=1184,
        h=272,
        gap=16,
        isGroup=True,
        children=[
            make_box(
                "grp-card-trend",
                layout="column",
                w=744,
                h=272,
                padding=[12, 0],
                gap=8,
                fill="$surface",
                stroke="$line",
                radius=8,
                isGroup=True,
                bgName="bg-card-trend",
                children=[
                    make_box(
                        "grp-trend-toolbar",
                        layout="row",
                        w=744,
                        h=32,
                        padding=[0, 16],
                        align="center",
                        gap=8,
                        isGroup=True,
                        children=[
                            make_label("txt-trend-card-title", "经营核心指标分时分析", size=15, weight=700, color="$ink", flex=1),
                            make_button("tab-trend-orders", "订单趋势", variant="primary", w=88, h=28, size=12, radius=6),
                            make_button("tab-trend-revenue", "营收趋势", variant="outline", w=88, h=28, size=12, radius=6),
                            make_button("tab-trend-category", "品类占比", variant="outline", w=88, h=28, size=12, radius=6),
                        ],
                    ),
                    {
                        "type": "dynamic-panel",
                        "name": "panel-trend",
                        "w": 744,
                        "h": 216,
                        "states": trend_states,
                    },
                ],
            ),
            expand_notice_card(w=424, h=272),
        ],
    )
    table_section = make_box(
        "grp-table-section",
        layout="column",
        w=1184,
        h=396,
        padding=[12, 0],
        gap=8,
        fill="$surface",
        stroke="$line",
        radius=8,
        isGroup=True,
        bgName="bg-table-section",
        children=[
            make_box(
                "grp-table-toolbar",
                layout="row",
                w=1184,
                h=36,
                padding=[0, 16],
                gap=8,
                align="center",
                isGroup=True,
                children=[
                    make_label("txt-table-sec-title", "门店菜品与实时库存明细", size=15, weight=700, color="$ink"),
                    make_button("txt-state-indicator", "当前视图：默认列表态 (Default)", variant="soft", w=216, h=26, size=11, radius=999),
                    make_box("sp-toolbar-flex", layout="stack", w=16, h=12, flex=1, isGroup=False, children=[]),
                    make_label("lbl-state-switch", "四态视图切换：", size=12, weight=500, color="$ink-2"),
                    make_button("btn-state-default", "默认列表 (Default)", variant="primary", w=128, h=28, size=11, radius=6),
                    make_button("btn-state-empty", "空状态 (Empty)", variant="outline", w=112, h=28, size=11, radius=6),
                    make_button("btn-state-loading", "加载态 (Loading)", variant="outline", w=120, h=28, size=11, radius=6),
                    make_button("btn-state-error", "异常态 (Error)", variant="outline", w=112, h=28, size=11, radius=6),
                ],
            ),
            {
                "type": "dynamic-panel",
                "name": "panel-table",
                "w": 1184,
                "h": 336,
                "states": table_states,
            },
        ],
    )
    main_area = make_box(
        "grp-main-area",
        layout="column",
        w=1232,
        h=900,
        gap=0,
        isGroup=True,
        children=[
            topbar,
            make_box(
                "grp-content-body",
                layout="column",
                w=1232,
                h=836,
                padding=[16, 24],
                gap=16,
                isGroup=True,
                children=[
                    kpi_row,
                    middle_row,
                    table_section,
                ],
            ),
        ],
    )
    modal_node = expand_modal_new_dish(canvas_w=1440, canvas_h=900)
    root = make_box(
        "Page 1",
        layout="stack",
        w=1440,
        h=900,
        fill="$bg",
        isGroup=False,
        children=[
            make_box(
                "grp-app-shell",
                layout="row",
                x=0,
                y=0,
                w=1440,
                h=900,
                gap=0,
                isGroup=True,
                children=[sidebar, main_area],
            ),
            modal_node,
        ],
    )
    return root, theme_dict
def compile_prototype_bundle(out_dir, theme_name="enterprise-light", title_override=None, no_interactions=False, strict_audit=False):
    """编译完整的多态原型产物包（主画布 + 所有面板状态 + 四视角预览图 + 交互编译计划 + 量化审计报告）。"""
    os.makedirs(out_dir, exist_ok=True)
    states_dir = os.path.join(out_dir, "states")
    os.makedirs(states_dir, exist_ok=True)
    root, theme_dict = build_flagship_prototype(theme_name=theme_name, title_override=title_override)
    measure_node(root)
    layout_node(root, 0, 0, 1440, 900)
    # 1. 发射主页面 .axvg.json (不含动态面板内部占位，供真实 DynamicPanel 挂载)
    emitted_main = emit_tree_to_axvg(root, theme_dict, include_dynamic_panel_placeholders=False)
    # 2. 发射全量预览树 (展开各动态面板首个状态，供 01-preview.png 与结构审计)
    root_preview, _ = build_flagship_prototype(theme_name=theme_name, title_override=title_override)
    measure_node(root_preview)
    layout_node(root_preview, 0, 0, 1440, 900)
    emitted_preview = emit_tree_to_axvg(root_preview, theme_dict, include_dynamic_panel_placeholders=True)
    main_axvg_path = os.path.join(out_dir, "page-main.axvg.json")
    main_spec_path = os.path.join(out_dir, "page-main.spec.json")
    with open(main_axvg_path, "w", encoding="utf-8") as f:
        json.dump(emitted_main["axvg"], f, ensure_ascii=False, indent=2)
    with open(main_spec_path, "w", encoding="utf-8") as f:
        json.dump(emitted_main["spec"], f, ensure_ascii=False, indent=2)
    # 3. 发射各动态面板的独立状态 .axvg.json / .spec.json / 预览图
    scenes = [{"id": "page-main", "page": "Page 1", "kind": "page-default", "scope": "page",
               "canvas": {"w": 1440, "h": 900}, "status": "not-run"}]
    panel_plans = []
    for dp in emitted_main["dynamicPanels"]:
        p_name = dp["name"]
        p_w, p_h = dp["w"], dp["h"]
        state_entries = []
        for st in dp["states"]:
            st_name = st["name"]
            st_tree = st["tree"]
            scene_id = f"{p_name}__{st_name}"
            scene = {"id": scene_id, "page": "Page 1", "kind": "panel-state", "scope": "container-local",
                     "parentSceneId": "page-main", "panel": p_name, "state": st_name,
                     "canvas": {"w": p_w, "h": p_h}, "status": "not-run"}
            scenes.append(scene)
            measure_node(st_tree, available_w=p_w)
            layout_node(st_tree, 0, 0, p_w, p_h)
            st_emitted = emit_tree_to_axvg(st_tree, theme_dict, include_dynamic_panel_placeholders=True)
            base_fn = f"{p_name}__{st_name}"
            st_axvg_path = os.path.join(states_dir, f"{base_fn}.axvg.json")
            st_spec_path = os.path.join(states_dir, f"{base_fn}.spec.json")
            st_png_path = os.path.join(states_dir, f"{base_fn}.png")
            with open(st_axvg_path, "w", encoding="utf-8") as f:
                json.dump(st_emitted["axvg"], f, ensure_ascii=False, indent=2)
            with open(st_spec_path, "w", encoding="utf-8") as f:
                json.dump(st_emitted["spec"], f, ensure_ascii=False, indent=2)
            st_img = render_flat_children_png(p_w, p_h, resolve_color("$surface", theme_dict), st_emitted["flatChildren"], include_modal=False)
            st_img.save(st_png_path)
            scene["audit"] = audit_prototype(st_tree, st_emitted, {
                "domain": "web", "theme": theme_name, "auditScope": "container-local",
                "allMainWidgets": st_emitted["flatChildren"], "dynamicPanels": [],
                "nativeInputs": st_emitted["nativeInputs"],
            }, strict_audit=strict_audit)
            scene.update({"axvgPath": st_axvg_path, "specPath": st_spec_path, "pngPath": st_png_path})
            state_entries.append({
                "sceneId": scene_id, "audit": scene["audit"],
                "name": st_name,
                "label": st.get("label", st_name),
                "axvgPath": st_axvg_path,
                "specPath": st_spec_path,
                "pngPath": st_png_path,
            })
        panel_plans.append({
            "name": p_name,
            "x": dp["x"],
            "y": dp["y"],
            "w": p_w,
            "h": p_h,
            "states": state_entries,
        })
    # 4. 构造有序的弹窗控制目标列表 (保证 bringToFront 时从底板到输入框/按钮的正确 Z-Order)
    modal_visual_targets = list(dict.fromkeys(emitted_main["modalTargets"]))
    native_input_names = [inp["name"] for inp in emitted_main["nativeInputs"]]
    interactive_top = [t for t in modal_visual_targets if t.startswith("btn-") or t.startswith("txt-modal-feedback")]
    backdrop_and_cards = [t for t in modal_visual_targets if t not in interactive_top]
    ordered_modal_targets = backdrop_and_cards + interactive_top + native_input_names
    # 5. 构造声明式状态机与交互绑定表
    interactions = [
        {
            "trigger": {"page": "Page 1"},
            "description": "页面初始化时隐藏新建菜品弹窗层，保持工作台整洁",
            "events": [
                {
                    "event": "OnPageLoad",
                    "cases": [
                        {
                            "name": "InitHideModal",
                            "actions": [
                                {"type": "hide", "target": tgt, "duration": 0, "animation": "none"}
                                for tgt in ordered_modal_targets
                            ],
                        }
                    ],
                }
            ],
        },
        # 趋势图三态 Tab 切换
        {
            "trigger": "tab-trend-orders",
            "description": "切换到订单趋势图表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "SwitchTrendOrders",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-trend", "state": "orders"},
                                {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 订单趋势"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "tab-trend-revenue",
            "description": "切换到营收趋势图表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "SwitchTrendRevenue",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-trend", "state": "revenue"},
                                {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 营收趋势"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "tab-trend-category",
            "description": "切换到品类占比图表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "SwitchTrendCategory",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-trend", "state": "category"},
                                {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 品类占比"},
                            ],
                        }
                    ],
                }
            ],
        },
        # 表格四态视图切换 (default / empty / loading / error)
        {
            "trigger": "btn-state-default",
            "description": "切换表格到默认数据列表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableDefault",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "default"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：默认列表态 (Default)"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-state-empty",
            "description": "切换表格到空数据态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableEmpty",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "empty"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：空数据态 (Empty)"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-state-loading",
            "description": "切换表格到骨架屏加载态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableLoading",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "loading"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：骨架加载态 (Loading)"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-state-error",
            "description": "切换表格到接口异常态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableError",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "error"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：接口异常态 (Error)"},
                            ],
                        }
                    ],
                }
            ],
        },
        # 打开/关闭新建菜品弹窗
        {
            "trigger": "btn-new-dish",
            "description": "打开新建菜品弹窗并将输入控件置顶",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "OpenNewDishModal",
                            "actions": [
                                *[
                                    {"type": "show", "target": tgt, "duration": 0, "animation": "none", "bringToFront": True}
                                    for tgt in ordered_modal_targets
                                ],
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "请填写上方必填字段后点击「确认保存菜品」"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-modal-cancel",
            "description": "取消并关闭新建菜品弹窗",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "CancelNewDishModal",
                            "actions": [
                                {"type": "hide", "target": tgt, "duration": 0, "animation": "none"}
                                for tgt in ordered_modal_targets
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-modal-close",
            "description": "点击右上角关闭按钮隐藏弹窗",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "CloseNewDishModal",
                            "actions": [
                                {"type": "hide", "target": tgt, "duration": 0, "animation": "none"}
                                for tgt in ordered_modal_targets
                            ],
                        }
                    ],
                }
            ],
        },
        # 表单提交三分支条件校验 (空菜品名 / 空售价 / 校验通过写入)
        {
            "trigger": "btn-modal-submit",
            "description": "新建菜品表单多分支非空校验与提交反馈",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ValidateEmptyDishName",
                            "when": {"op": "==", "left": {"widget": "input-dish-name", "fn": "GetWidgetText"}, "right": {"value": ""}},
                            "actions": [
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "! 校验失败：请输入菜品名称（必填项不能为空）"},
                            ],
                        },
                        {
                            "name": "ValidateEmptyDishPrice",
                            "when": {"op": "==", "left": {"widget": "input-dish-price", "fn": "GetWidgetText"}, "right": {"value": ""}},
                            "actions": [
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "! 校验失败：请输入标准售价（单位：元）"},
                            ],
                        },
                        {
                            "name": "SubmitValidDish",
                            "actions": [
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "● 保存成功：新菜品已写入菜单库并同步至列表"},
                                {"type": "set-text", "target": "txt-kpi-dishes-val", "text": "59"},
                                {"type": "set-panel-state", "target": "panel-table", "state": "default"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：默认列表态 (已新增 1 款菜品)"},
                            ],
                        },
                    ],
                }
            ],
        },
    ]
    compile_plan = {
        "pageName": "Page 1",
        "theme": theme_name,
        "static": bool(no_interactions),
        "canvas": {"w": 1440, "h": 900},
        "mainAxvgPath": main_axvg_path,
        "mainSpecPath": main_spec_path,
        "dynamicPanels": panel_plans,
        "nativeInputs": emitted_main["nativeInputs"],
        "modalTargets": ordered_modal_targets,
        "allMainWidgets": emitted_main["flatChildren"],
        "interactions": [] if no_interactions else interactions,
    }
    # 6. 生成多视角预览图
    bg_hex = resolve_color("$bg", theme_dict)
    img_preview = render_flat_children_png(1440, 900, bg_hex, emitted_preview["flatChildren"], include_modal=False)
    p01 = os.path.join(out_dir, "01-preview.png")
    img_preview.save(p01)
    img_struct = render_structure_overlay_png(img_preview, root_preview, emitted_main["dynamicPanels"])
    p02 = os.path.join(out_dir, "02-structure.png")
    img_struct.save(p02)
    img_thumb = img_preview.resize((360, 225), Image.Resampling.LANCZOS)
    p03 = os.path.join(out_dir, "03-thumb25.png")
    img_thumb.save(p03)
    img_modal = render_flat_children_png(1440, 900, bg_hex, emitted_preview["flatChildren"], include_modal=True)
    p04 = os.path.join(out_dir, "04-modal-preview.png")
    img_modal.save(p04)
    # 7. 执行量化审美与结构审计
    scenes[0]["audit"] = audit_prototype(root_preview, emitted_preview, compile_plan, strict_audit=strict_audit)
    scenes[0].update({"axvgPath": main_axvg_path, "specPath": main_spec_path, "pngPath": p01})

    def audit_modal_scenes(tree):
        for child in tree.get("children", []):
            if not child.get("isModal"):
                audit_modal_scenes(child)
                continue
            modal = copy.deepcopy(child)
            modal.pop("isModal", None)
            modal.pop("x", None)
            modal.pop("y", None)
            mw, mh = child["_w"], child["_h"]
            measure_node(modal, available_w=mw)
            layout_node(modal, 0, 0, mw, mh)
            emitted = emit_tree_to_axvg(modal, theme_dict, include_dynamic_panel_placeholders=True)
            scene_id = f"page-main__{child['name']}__modal"
            scene = {"id": scene_id, "page": "Page 1", "kind": "modal", "scope": "container-local",
                     "parentSceneId": "page-main", "modal": child["name"], "canvas": {"w": mw, "h": mh}, "status": "not-run"}
            scenes.append(scene)
            scene["audit"] = audit_prototype(modal, emitted, {
                "domain": "web", "theme": theme_name, "auditScope": "container-local",
                "allMainWidgets": emitted["flatChildren"], "dynamicPanels": [], "nativeInputs": emitted["nativeInputs"],
            }, strict_audit=strict_audit)
            audit_modal_scenes(modal)
    audit_modal_scenes(root)
    audit = summarize_scene_audits(scenes, strict_audit=strict_audit)
    compile_plan["scenes"] = scenes
    compile_plan["sceneCoverage"] = audit["sceneCoverage"]
    compile_plan["audit"] = audit
    compile_plan["previews"] = {
        "preview": p01,
        "structure": p02,
        "thumb25": p03,
        "modalPreview": p04,
    }
    plan_path = os.path.join(out_dir, "compile-plan.json")
    audit_path = os.path.join(out_dir, "audit-report.json")
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump(compile_plan, f, ensure_ascii=False, indent=2)
    with open(audit_path, "w", encoding="utf-8") as f:
        json.dump(audit, f, ensure_ascii=False, indent=2)
    return {
        "ok": audit["ok"],
        "outDir": out_dir,
        "theme": theme_name,
        "static": bool(no_interactions),
        "planPath": plan_path,
        "auditPath": audit_path,
        "previews": compile_plan["previews"],
        "audit": audit,
    }

# -------------------- 6. DECLARATIVE SPEC COMPILER & MOBILE COMPONENTS --------------------
def expand_mobile_navbar(node, prefix="p1"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 44)
    title = node.get("title", "页面标题")
    title_align = node.get("titleAlign", "center")
    left_text = node.get("leftText")
    left_icon = node.get("leftIcon")
    right_text = node.get("rightText")
    back_name = node.get("backName", f"{prefix}-btn-back")
    right_name = node.get("rightName", f"{prefix}-btn-nav-right")
    children = []
    left_items = []
    if left_icon:
        left_items.append({"type": "image", "name": f"{prefix}-img-nav-back", "src": left_icon, "w": 16, "h": 16})
    if left_text:
        left_items.append(make_label(back_name, left_text, size=12, weight=500, color="$ink"))
    if left_items:
        children.append(make_box(f"grp-{prefix}-nav-left", layout="row", w=84, h=28, gap=4, align="center", isGroup=True, children=left_items))
    elif title_align == "center":
        children.append(make_label(f"{prefix}-nav-left-sp", " ", size=12, weight=400, color="$ink-3", w=76))
    children.append(make_label(f"{prefix}-txt-nav-title", title, size=16, weight=700, color="$ink", align=title_align, flex=1))
    if right_text:
        rw = max(76, min(116, len(str(right_text)) * 12 + 24))
        children.append(make_button(right_name, right_text, variant="outline", w=rw, h=26, size=11, radius=999))
    elif title_align == "center":
        children.append(make_label(f"{prefix}-nav-right-sp", " ", size=12, weight=400, color="$ink-3", w=76))
    return make_box(
        node.get("name", f"grp-{prefix}-navbar"),
        layout="row",
        w=w,
        h=h,
        padding=[8, 12],
        gap=8,
        align="center",
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-{prefix}-navbar",
        children=children,
    )


def expand_mobile_searchbar(node, prefix="p1"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 52)
    placeholder_txt = node.get("placeholder", "搜索物品名称、拾获地点关键词")
    btn_txt = node.get("buttonText", "筛选")
    btn_name = node.get("buttonName", f"{prefix}-btn-search-act")
    inp_name = node.get("inputName", f"{prefix}-txt-search-ph")
    row_children = [
        make_box(
            f"grp-{prefix}-search-input",
            layout="row",
            flex=1,
            h=36,
            padding=[8, 12],
            gap=8,
            align="center",
            fill="$surface-2",
            stroke="$line",
            radius=16,
            isGroup=True,
            bgName=f"bg-{prefix}-search-pill",
            children=[
                {"type": "image", "name": f"{prefix}-img-search", "src": "icon-search.png", "w": 16, "h": 16},
                make_label(inp_name, placeholder_txt, size=12, weight=400, color="$ink-3", flex=1),
            ],
        )
    ]
    if btn_txt:
        bw = max(56, min(88, len(str(btn_txt)) * 12 + 24))
        row_children.append(make_button(btn_name, btn_txt, variant="secondary", w=bw, h=36, size=12, radius=16))
    return make_box(
        node.get("name", f"grp-{prefix}-searchbar"),
        layout="row",
        w=w,
        h=h,
        padding=[8, 16],
        gap=8,
        align="center",
        fill="$surface",
        stroke=node.get("stroke"),
        isGroup=True,
        bgName=f"bg-{prefix}-searchbar",
        children=row_children,
    )


def expand_mobile_segmented(node, prefix="p1"):
    w = int(node.get("w") or 375)
    raw_items = node.get("items") or ["全部 (48)", "寻物启事 (21)", "失物招领 (27)"]
    active_idx = int(node.get("activeIndex", 0))
    cols = int(node.get("columns") or (3 if len(raw_items) > 4 else max(1, len(raw_items))))
    sec_title = node.get("title")
    sec_right = node.get("rightText")

    pills = []
    for i, item in enumerate(raw_items):
        if isinstance(item, dict):
            lbl = item.get("label", f"选项{i+1}")
            nm = item.get("name", f"{prefix}-seg-tab-{i+1}")
            is_act = bool(item.get("active", i == active_idx))
            variant = item.get("variant") or ("primary" if is_act else "outline")
        else:
            lbl = str(item)
            nm = f"{prefix}-seg-tab-{i+1}"
            is_act = i == active_idx
            variant = "primary" if is_act else "outline"
        pills.append(
            make_button(
                nm,
                lbl,
                variant=variant,
                h=int(node.get("pillHeight") or 28),
                size=int(node.get("fontSize") or 12),
                radius=int(node.get("pillRadius") or 16),
                flex=1,
            )
        )

    if len(pills) <= cols and not sec_title:
        return make_box(
            node.get("name", f"grp-{prefix}-segmented"),
            layout="row",
            w=w,
            h=int(node.get("h") or 40),
            padding=[6, 16],
            gap=8,
            align="center",
            fill="$surface",
            stroke="$line",
            isGroup=True,
            bgName=f"bg-{prefix}-segmented",
            children=pills,
        )

    rows = [pills[i:i + cols] for i in range(0, len(pills), cols)]
    col_children = []
    if sec_title:
        hdr_items = [make_label(f"{prefix}-seg-title", sec_title, size=12, weight=600, color="$ink", flex=1)]
        if sec_right:
            hdr_items.append(make_label(f"{prefix}-seg-right", sec_right, size=11, weight=400, color="$ink-3"))
        col_children.append(make_box(f"grp-{prefix}-seg-hdr", layout="row", w=w - 32, h=18, align="center", isGroup=True, children=hdr_items))
    for r_idx, r_pills in enumerate(rows):
        col_children.append(
            make_box(
                f"grp-{prefix}-seg-row-{r_idx+1}",
                layout="row",
                w=w - 32,
                h=int(node.get("pillHeight") or 28),
                gap=8,
                align="center",
                isGroup=True,
                children=r_pills,
            )
        )
    auto_h = 16 + (26 if sec_title else 0) + len(rows) * int(node.get("pillHeight") or 28) + max(0, len(rows) - 1) * 8
    return make_box(
        node.get("name", f"grp-{prefix}-segmented"),
        layout="column",
        w=w,
        h=int(node.get("h") or auto_h),
        padding=[8, 16],
        gap=8,
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-{prefix}-segmented",
        children=col_children,
    )


def expand_mobile_card_list(node, prefix="p1"):
    w = int(node.get("w") or 375)
    cards_data = node.get("cards") or [
        {
            "id": "c1",
            "badge": "失物招领",
            "title": "黑色索尼头戴降噪耳机",
            "loc": "图书馆三楼自习区 A12 桌",
            "time": "10分钟前 · 计院拾获",
            "thumb": "实物图",
            "detail": {
                "badge": "失物招领",
                "itemTitle": "黑色索尼头戴降噪耳机",
                "statusText": "状态：待认领 · 编号 LF-20261017-019",
                "pubTime": "发布时间：10分钟前 · 计院拾获 · 浏览 86 次",
                "category": "物品分类：数码电子 / 音频配件",
                "location": "拾获地点：图书馆三楼自习区 A12 桌",
                "holder": "当前保管：三楼自助失物招领柜 08 号格口",
                "description": "特征说明：耳机收纳盒完好，拉链处挂有一枚蓝色宇航员硅胶挂件，认领时请说明盒内附带的转接头颜色。",
            },
        },
        {
            "id": "c2",
            "badge": "寻物启事",
            "title": "白色 Apple Pencil 二代",
            "loc": "二教 204 阶梯教室第三排",
            "time": "35分钟前 · 悬赏咖啡",
            "thumb": "实物图",
            "detail": {
                "badge": "寻物启事",
                "itemTitle": "白色 Apple Pencil 二代",
                "statusText": "状态：寻找中 · 编号 LF-20261017-020",
                "pubTime": "发布时间：35分钟前 · 悬赏咖啡 · 浏览 64 次",
                "category": "物品分类：数码电子 / 手写笔配件",
                "location": "遗失地点：二教 204 阶梯教室第三排",
                "holder": "联系失主：微信号 campus_pen204（重谢一杯星巴克）",
                "description": "特征说明：笔身贴有浅灰色磨砂保护膜，笔尖换过金属改造笔头，吸在平板侧面不慎滑落。",
            },
        },
        {
            "id": "c3",
            "badge": "失物招领",
            "title": "校园一卡通及蓝色卡套",
            "loc": "南区一食堂二楼窗口旁",
            "time": "1小时前 · 值班台保管",
            "thumb": "证件照",
            "detail": {
                "badge": "失物招领",
                "itemTitle": "校园一卡通及蓝色卡套",
                "statusText": "状态：待认领 · 编号 LF-20261017-021",
                "pubTime": "发布时间：1小时前 · 值班台保管 · 浏览 112 次",
                "category": "物品分类：校园卡证 / 一卡通",
                "location": "拾获地点：南区一食堂二楼窗口旁",
                "holder": "当前保管：南区一食堂一楼值班室登记处",
                "description": "特征说明：深蓝色硅胶卡套，背面夹有一张图书馆储物柜条码纸，请携带学生证或报出学号后四位认领。",
            },
        },
        {
            "id": "c4",
            "badge": "寻物启事",
            "title": "银色键盘收纳包与 U 盘",
            "loc": "体育馆羽毛球场北侧长椅",
            "time": "2小时前 · 急寻毕设稿",
            "thumb": "实物图",
            "detail": {
                "badge": "寻物启事",
                "itemTitle": "银色键盘收纳包与 U 盘",
                "statusText": "状态：急寻中 · 编号 LF-20261017-022",
                "pubTime": "发布时间：2小时前 · 急寻毕设稿 · 浏览 195 次",
                "category": "物品分类：数码电子 / 存储与外设",
                "location": "遗失地点：体育馆羽毛球场北侧长椅",
                "holder": "联系失主：手机号 139****8821（内含重要毕设源码）",
                "description": "特征说明：银灰色硬壳键盘包内含一把 68 键矮轴键盘与一枚闪迪 128G 金属双接口 U 盘，拾获必有重谢。",
            },
        },
    ]
    list_children = []
    hdr_title = node.get("headerTitle")
    hdr_right = node.get("headerRight")
    if hdr_title:
        hdr_row = [make_label(f"{prefix}-list-hdr-title", hdr_title, size=13, weight=700, color="$ink", flex=1)]
        if hdr_right:
            hdr_row.append(make_label(f"{prefix}-list-hdr-right", hdr_right, size=11, weight=400, color="$ink-3"))
        list_children.append(make_box(f"grp-{prefix}-list-hdr", layout="row", w=w - 32, h=20, align="center", isGroup=True, children=hdr_row))

    card_h = int(node.get("cardHeight") or (104 if hdr_title else 112))
    for idx, c in enumerate(cards_data):
        cid = c.get("id", f"c{idx+1}")
        cw = w - 32
        loc_raw = str(c.get("loc", ""))
        loc_txt = loc_raw if ("：" in loc_raw or ":" in loc_raw) else f"地点：{loc_raw}"
        time_raw = str(c.get("time", ""))
        pub_raw = str(c.get("publisher", "")).strip()
        if pub_raw and pub_raw not in time_raw:
            time_txt = f"{time_raw} · {pub_raw}" if time_raw else pub_raw
        else:
            time_txt = time_raw
        badge_txt = c.get("badge", "招领")
        badge_var = c.get("badgeVariant") or "secondary"
        badge_w = max(56, min(72, len(str(badge_txt)) * 10 + 12))
        thumb_sz = 68 if card_h < 110 else 76
        title_str = str(c.get("title", ""))
        avail_title_w = cw - 24 - thumb_sz - 12 - badge_w - 6
        title_sz = 13
        if measure_text(title_str, 13, 600)[0] - 8 > avail_title_w:
            title_sz = 12 if measure_text(title_str, 12, 600)[0] - 8 <= avail_title_w else 11
        btn_txt = c.get("buttonText", "查看详情 >")
        btn_nm = c.get("buttonName", f"{prefix}-btn-detail-{cid}")
        list_children.append(
            make_box(
                c.get("name", f"grp-{prefix}-card-{cid}"),
                layout="row",
                w=cw,
                h=card_h,
                padding=[10 if card_h < 110 else 12, 12],
                gap=12,
                align="center",
                fill="$surface",
                stroke="$line",
                radius=10,
                isGroup=True,
                bgName=f"bg-{prefix}-card-{cid}",
                children=[
                    {
                        "type": "placeholder",
                        "name": f"{prefix}-ph-{cid}",
                        "w": thumb_sz,
                        "h": thumb_sz,
                        "caption": c.get("thumb", "缩略图"),
                    },
                    make_box(
                        f"grp-{prefix}-card-body-{cid}",
                        layout="column",
                        flex=1,
                        h=card_h - 24,
                        gap=6,
                        isGroup=True,
                        children=[
                            make_box(
                                f"grp-{prefix}-card-head-{cid}",
                                layout="row",
                                gap=6,
                                align="center",
                                isGroup=True,
                                children=[
                                    make_button(f"{prefix}-badge-{cid}", badge_txt, variant=badge_var, w=badge_w, h=20, size=10, radius=4),
                                    make_label(f"{prefix}-title-{cid}", title_str, size=title_sz, weight=600, color="$ink", flex=1),
                                ],
                            ),
                            make_label(f"{prefix}-loc-{cid}", loc_txt, size=11, weight=400, color="$ink-2"),
                            make_box(
                                f"grp-{prefix}-card-foot-{cid}",
                                layout="row",
                                align="center",
                                gap=6,
                                isGroup=True,
                                children=[
                                    make_label(f"{prefix}-time-{cid}", time_txt, size=11, weight=400, color="$ink-3", flex=1),
                                    make_button(btn_nm, btn_txt, variant="outline", w=76, h=22, size=11, radius=12),
                                ],
                            ),
                        ],
                    ),
                ],
            )
        )
    return make_box(
        node.get("name", f"grp-{prefix}-card-list"),
        layout="column",
        w=w,
        h=int(node.get("h") or 548),
        padding=[10 if hdr_title else 12, 16],
        gap=8 if hdr_title else 12,
        fill="$bg",
        isGroup=True,
        bgName=f"bg-{prefix}-list-area",
        children=list_children,
    )


def expand_mobile_tabbar(node, prefix="p1"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 84)
    raw_items = node.get("items")
    center_act = node.get("centerAction")
    if not raw_items:
        return make_box(
            node.get("name", f"grp-{prefix}-tabbar"),
            layout="row",
            w=w,
            h=h,
            padding=[8, 16],
            gap=12,
            align="start",
            fill="$surface",
            stroke="$line",
            isGroup=True,
            bgName=f"bg-{prefix}-tabbar",
            children=[
                make_button(f"{prefix}-tab-home", "招领广场", variant="primary", flex=1, h=40, size=12, radius=8),
                make_button(
                    (center_act or {}).get("name", f"{prefix}-btn-publish-plus"),
                    (center_act or {}).get("label", "+ 发布寻物/招领"),
                    variant="secondary",
                    w=132,
                    h=40,
                    size=12,
                    radius=20,
                ),
                make_button(f"{prefix}-tab-mine", "我的记录", variant="outline", flex=1, h=40, size=12, radius=8),
            ],
        )

    items_list = list(raw_items)
    if center_act and isinstance(center_act, dict):
        mid = len(items_list) // 2
        items_list.insert(mid, {**center_act, "prominent": True})

    btn_nodes = []
    many_tabs = len(items_list) >= 4
    active_idx = int(node.get("activeIndex", 0))
    for i, it in enumerate(items_list):
        if isinstance(it, dict):
            lbl = it.get("label", f"Tab{i+1}")
            nm = it.get("name", f"{prefix}-tab-{i+1}")
            is_prom = bool(it.get("prominent"))
            is_act = bool(it.get("active", i == active_idx and not is_prom))
            variant = it.get("variant") or ("secondary" if is_prom else ("primary" if is_act else "outline"))
            rad = int(it.get("radius") or (18 if is_prom else 8))
            bw = it.get("w")
        else:
            lbl = str(it)
            nm = f"{prefix}-tab-{i+1}"
            is_prom = False
            is_act = i == active_idx
            variant = "primary" if is_act else "outline"
            rad = 8
            bw = None
        btn_nodes.append(
            make_button(
                nm,
                lbl,
                variant=variant,
                w=int(bw) if bw else None,
                flex=None if bw else 1,
                h=int(node.get("buttonHeight") or (38 if many_tabs else 40)),
                size=int(node.get("fontSize") or (11 if many_tabs else 12)),
                radius=rad,
            )
        )
    return make_box(
        node.get("name", f"grp-{prefix}-tabbar"),
        layout="row",
        w=w,
        h=h,
        padding=[8, 12 if many_tabs else 16],
        gap=6 if many_tabs else 12,
        align="start",
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-{prefix}-tabbar",
        children=btn_nodes,
    )


def expand_mobile_detail_view(node, prefix="view"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 812)
    data = dict(node.get("data") or node.get("fields") or {})
    for k in (
        "badge", "badgeVariant", "itemTitle", "statusText", "metaText", "pubTime",
        "sectionTitle", "category", "location", "holder", "contact", "description",
        "heroCaption", "shareText", "claimText", "extraRows",
    ):
        if k in node and k not in data:
            data[k] = node[k]

    badge_txt = data.get("badge", "失物招领")
    badge_var = data.get("badgeVariant", "primary")
    badge_w = max(68, min(96, len(str(badge_txt)) * 11 + 16))
    item_title = data.get("itemTitle", "黑色索尼头戴降噪耳机")
    meta_txt = data.get("statusText") or data.get("metaText") or "状态：待认领 · 编号 LF-20261017-019"
    pub_txt = data.get("pubTime", "发布时间：10分钟前 · 计院拾获 · 浏览 86 次")
    sec_title = data.get("sectionTitle", "关键拾获与核验信息")

    cat_raw = str(data.get("category", "物品分类：数码电子 / 音频配件"))
    cat_txt = cat_raw if ("：" in cat_raw or ":" in cat_raw) else f"物品分类：{cat_raw}"
    loc_raw = str(data.get("location", "拾获地点：图书馆三楼自习区 A12 桌"))
    loc_txt = loc_raw if ("：" in loc_raw or ":" in loc_raw) else f"拾获/遗失地点：{loc_raw}"
    holder_raw = str(data.get("holder", "当前保管：三楼自助失物招领柜 08 号格口"))
    holder_txt = holder_raw if ("：" in holder_raw or ":" in holder_raw) else f"当前保管：{holder_raw}"
    contact_raw = data.get("contact")
    desc_txt = data.get("description", "特征说明：耳机收纳盒完好，拉链处挂有一枚蓝色宇航员硅胶挂件，认领时请说明盒内附带的转接头颜色。")
    if not str(desc_txt).startswith(("特征说明", "详细描述", "备注")):
        desc_txt = f"特征说明：{desc_txt}"

    attr_children = [
        make_label(f"{prefix}-sec-attrs", sec_title, size=13, weight=700, color="$ink"),
        make_label(f"{prefix}-attr-cat", cat_txt, size=12, weight=400, color="$ink-2"),
        make_label(f"{prefix}-attr-loc", loc_txt, size=12, weight=400, color="$ink-2"),
        make_label(f"{prefix}-attr-holder", holder_txt, size=12, weight=400, color="$ink-2"),
    ]
    if contact_raw:
        c_str = str(contact_raw)
        c_txt = c_str if ("：" in c_str or ":" in c_str) else f"联系方式：{c_str}"
        attr_children.append(make_label(f"{prefix}-attr-contact", c_txt, size=12, weight=400, color="$ink-2"))
    for r_idx, r_item in enumerate(data.get("extraRows") or []):
        if isinstance(r_item, dict):
            attr_children.append(make_label(r_item.get("name", f"{prefix}-attr-extra-{r_idx+1}"), r_item.get("text", ""), size=12, weight=400, color="$ink-2"))
        else:
            attr_children.append(make_label(f"{prefix}-attr-extra-{r_idx+1}", str(r_item), size=12, weight=400, color="$ink-2"))
    attr_children.append({
        "type": "paragraph",
        "name": f"{prefix}-desc-para",
        "w": w - 60,
        "fontSize": 12,
        "fontWeight": 400,
        "color": "$ink-2",
        "text": desc_txt,
    })

    extra_cnt = len(attr_children) - 5
    hero_h = int(data.get("heroH") or (164 if extra_cnt > 0 else 180))
    attrs_h = int(data.get("attrsH") or (204 + extra_cnt * 22))
    hero_cap = data.get("heroCaption") or f"物品实拍大图占位 ({w - 32}×{hero_h})"
    share_txt = data.get("shareText", "转发线索")
    claim_txt = data.get("claimText", "立即申请认领 / 联系拾主")

    return make_box(
        node.get("name", f"grp-{prefix}-screen"),
        layout="column",
        w=w,
        h=h,
        padding=[44, 0, 0, 0],
        gap=0,
        fill="$bg",
        isGroup=True,
        bgName=f"bg-{prefix}-screen",
        children=[
            expand_mobile_navbar({
                "name": f"grp-{prefix}-navbar",
                "w": w,
                "h": 44,
                "title": node.get("title", "物品信息详情"),
                "leftIcon": node.get("leftIcon", "icon-back.png"),
                "leftText": node.get("leftText", "返回广场"),
                "backName": node.get("backName", f"{prefix}-btn-back"),
                "rightText": node.get("rightText", "去发布"),
                "rightName": node.get("rightName", f"{prefix}-btn-to-publish"),
            }, prefix=prefix),
            make_box(
                f"grp-{prefix}-body",
                layout="column",
                w=w,
                h=h - 88,
                padding=[12, 16],
                gap=12,
                fill="$bg",
                isGroup=True,
                children=[
                    {"type": "placeholder", "name": f"{prefix}-ph-hero", "w": w - 32, "h": hero_h, "caption": hero_cap},
                    make_box(
                        f"grp-{prefix}-summary-card",
                        layout="column",
                        w=w - 32,
                        h=112,
                        padding=[12, 14],
                        gap=8,
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-summary",
                        children=[
                            make_box(
                                f"grp-{prefix}-title-row",
                                layout="row",
                                gap=8,
                                align="center",
                                isGroup=True,
                                children=[
                                    make_button(f"{prefix}-badge-type", badge_txt, variant=badge_var, w=badge_w, h=22, size=11, radius=4),
                                    make_label(f"{prefix}-item-title", item_title, size=14, weight=700, color="$ink", flex=1),
                                ],
                            ),
                            make_label(f"{prefix}-item-meta", meta_txt, size=12, weight=500, color="$ink-2"),
                            make_label(f"{prefix}-item-pubtime", pub_txt, size=11, weight=400, color="$ink-3"),
                        ],
                    ),
                    make_box(
                        f"grp-{prefix}-attrs-card",
                        layout="column",
                        w=w - 32,
                        h=attrs_h,
                        padding=[12, 14],
                        gap=8 if extra_cnt > 0 else 10,
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-attrs",
                        children=attr_children,
                    ),
                    make_box(
                        f"grp-{prefix}-actions",
                        layout="row",
                        w=w - 32,
                        h=52,
                        padding=[6, 0],
                        gap=12,
                        align="center",
                        isGroup=True,
                        children=[
                            make_button(f"{prefix}-btn-share", share_txt, variant="outline", w=108, h=40, size=13, radius=8),
                            make_button(f"{prefix}-btn-claim", claim_txt, variant="primary", flex=1, h=40, size=13, radius=8),
                        ],
                    ),
                ],
            ),
        ],
    )


def expand_mobile_form_view(node, prefix="pub"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 812)
    type_label = node.get("typeLabel", "信息类型")
    raw_type_opts = node.get("typeOptions") or [
        {"name": f"{prefix}-opt-found", "label": "拾物招领", "active": True},
        {"name": f"{prefix}-opt-lost", "label": "寻物启事", "active": False},
    ]
    type_children = [make_label(f"{prefix}-lbl-type", type_label, size=13, weight=600, color="$ink", w=72)]
    for i, opt in enumerate(raw_type_opts):
        if isinstance(opt, dict):
            onm = opt.get("name", f"{prefix}-opt-type-{i+1}")
            olbl = opt.get("label", f"类型{i+1}")
            oact = bool(opt.get("active", i == 0))
        else:
            onm = f"{prefix}-opt-type-{i+1}"
            olbl = str(opt)
            oact = i == 0
        type_children.append(make_button(onm, olbl, variant="primary" if oact else "outline", flex=1, h=30, size=12, radius=6))

    custom_fields = node.get("fields")
    if not custom_fields:
        field_children = [
            make_label(f"{prefix}-lbl-name", "* 物品名称 (必填)", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-name", "请输入物品名称，如：黑色索尼头戴耳机", variant="secondary", w=w - 60, h=36, size=12, radius=6, align="left"),
            make_label(f"{prefix}-lbl-cat", "* 所属分类与拾获/遗失地点", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-loc", "数码电子 · 图书馆三楼自习区", variant="secondary", w=w - 60, h=36, size=12, radius=6, align="left"),
            make_label(f"{prefix}-lbl-desc", "特征描述与认领核验问题", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-desc", "请描述外观特征、挂件或盒内附件，便于失主核对", variant="secondary", w=w - 60, h=64, size=12, radius=6, align="left"),
            make_label(f"{prefix}-lbl-contact", "* 联系方式 / 招领柜格口", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-contact", "微信号 / 手机号 / 自助柜编号", variant="secondary", w=w - 60, h=36, size=12, radius=6, align="left"),
        ]
        upload_h = int(node.get("uploadH") or 116)
        fields_h = int(node.get("fieldsH") or 332)
        field_gap = 10
    else:
        field_children = []
        many_f = len(custom_fields) >= 5
        field_gap = 6 if many_f else 8
        for idx, f in enumerate(custom_fields):
            fid = f.get("id") or f.get("name") or f"f{idx+1}"
            lbl_nm = f.get("labelName") or f"{prefix}-lbl-{fid}"
            inp_nm = f.get("inputName") or (fid if str(fid).startswith(prefix) else f"{prefix}-inp-{fid}")
            req_prefix = "* " if f.get("required") and not str(f.get("label", "")).startswith("*") else ""
            lbl_txt = f"{req_prefix}{f.get('label', fid)}"
            field_children.append(make_label(lbl_nm, lbl_txt, size=11 if many_f else 12, weight=600, color="$ink"))
            ftype = f.get("type", "input")
            if ftype == "pills" and f.get("options"):
                opts = f.get("options")
                cols = int(f.get("columns") or min(3, len(opts)))
                for r_idx in range(0, len(opts), cols):
                    chunk = opts[r_idx:r_idx + cols]
                    p_btns = []
                    for c_idx, opt in enumerate(chunk):
                        g_idx = r_idx + c_idx
                        o_lbl = opt.get("label", str(opt)) if isinstance(opt, dict) else str(opt)
                        o_act = opt.get("active", g_idx == 0) if isinstance(opt, dict) else (g_idx == 0)
                        p_btns.append(make_button(f"{inp_nm}-{g_idx+1}", o_lbl, variant="primary" if o_act else "outline", flex=1, h=24, size=10, radius=6))
                    field_children.append(make_box(f"grp-{inp_nm}-row-{r_idx//cols+1}", layout="row", w=w - 60, h=24, gap=6, align="center", isGroup=True, children=p_btns))
            else:
                fh = int(f.get("h") or (48 if ftype == "textarea" else (30 if many_f else 36)))
                ph = f.get("placeholder", f"请输入{f.get('label', '')}")
                field_children.append(make_button(inp_nm, ph, variant="secondary", w=w - 60, h=fh, size=11 if many_f else 12, radius=6, align="left"))
        upload_h = int(node.get("uploadH") or (84 if many_f else 108))
        fields_h = int(node.get("fieldsH") or (380 if many_f else 340))

    upload_cap = node.get("uploadCaption", "+ 点击上传物品实拍照片 (最多 3 张)")
    draft_txt = node.get("draftText", "存草稿")
    submit_txt = node.get("submitText", "确认发布并回招领广场")

    return make_box(
        node.get("name", f"grp-{prefix}-screen"),
        layout="column",
        w=w,
        h=h,
        padding=[44, 0, 0, 0],
        gap=0,
        fill="$bg",
        isGroup=True,
        bgName=f"bg-{prefix}-screen",
        children=[
            expand_mobile_navbar({
                "name": f"grp-{prefix}-navbar",
                "w": w,
                "h": 44,
                "title": node.get("title", "发布寻物 / 招领信息"),
                "leftIcon": node.get("leftIcon", "icon-back.png"),
                "leftText": node.get("leftText", "返回详情"),
                "backName": node.get("backName", f"{prefix}-btn-back"),
                "rightText": node.get("rightText", "查看态"),
                "rightName": node.get("rightName", f"{prefix}-btn-to-view"),
            }, prefix=prefix),
            make_box(
                f"grp-{prefix}-body",
                layout="column",
                w=w,
                h=h - 88,
                padding=[10 if custom_fields else 12, 16],
                gap=8 if custom_fields else 12,
                fill="$bg",
                isGroup=True,
                children=[
                    make_box(
                        f"grp-{prefix}-type-card",
                        layout="row",
                        w=w - 32,
                        h=44 if custom_fields else 48,
                        padding=[6 if custom_fields else 8, 12],
                        gap=8,
                        align="center",
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-type-card",
                        children=type_children,
                    ),
                    {"type": "placeholder", "name": f"{prefix}-ph-upload", "w": w - 32, "h": upload_h, "caption": upload_cap},
                    make_box(
                        f"grp-{prefix}-fields-card",
                        layout="column",
                        w=w - 32,
                        h=fields_h,
                        padding=[10 if custom_fields else 12, 14],
                        gap=field_gap,
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-fields-card",
                        children=field_children,
                    ),
                    make_box(
                        f"grp-{prefix}-submit-row",
                        layout="row",
                        w=w - 32,
                        h=48 if custom_fields else 52,
                        padding=[4 if custom_fields else 6, 0],
                        gap=12,
                        align="center",
                        isGroup=True,
                        children=[
                            make_button(f"{prefix}-btn-draft", draft_txt, variant="outline", w=96, h=40, size=13, radius=8),
                            make_button(f"{prefix}-btn-submit", submit_txt, variant="primary", flex=1, h=40, size=13, radius=8),
                        ],
                    ),
                ],
            ),
        ],
    )


KNOWN_NODE_TYPES = {
    "box",
    "label",
    "paragraph",
    "button",
    "shape-text",
    "placeholder",
    "image",
    "icon",
    "sparkline",
    "input",
    "native-input",
    "divider",
    "badge",
    "card",
    "dynamic-panel",
    "repeater",
    "mobile-navbar",
    "mobile-searchbar",
    "mobile-segmented",
    "mobile-card-list",
    "mobile-tabbar",
    "mobile-detail-view",
    "mobile-form-view",
    "sidebar",
    "topbar",
    "kpi-card",
}

KNOWN_NODE_PROPS = {
    "type", "name", "prefix", "x", "y", "w", "h", "flex", "layout", "padding", "gap",
    "columnGap", "rowGap", "align", "justify", "equalHeight", "fill", "stroke", "color",
    "radius", "isGroup", "bgName", "isModal", "children", "text", "content", "fontSize",
    "size", "fontWeight", "weight", "lineHeight", "lineGap", "maxLines", "variant",
    "placeholder", "value", "native", "textPaddingX", "caption", "src", "image", "file",
    "states", "root", "tree", "title", "titleAlign", "subtitle", "leftIcon", "leftText",
    "backName", "rightText", "rightName", "buttonText", "headerTitle", "headerRight",
    "emptyHint", "shareText", "claimText", "items", "activeIndex", "cards", "cardHeight",
    "bindDetail", "tabs", "data", "typeLabel", "typeOptions", "fields", "uploadH",
    "fieldsH", "uploadCaption", "draftText", "submitText", "brand", "brandTitle",
    "brandSubtitle", "brandSub", "storeName", "navItems", "activeNav", "breadcrumbs",
    "userText", "ctaText", "badgeText", "primaryText", "secondaryText", "primaryButton",
    "secondaryButton", "label", "delta", "trend", "trendType", "accent", "id", "options",
    "columns", "required", "labelName", "inputName", "buttonName", "badge", "loc", "time",
    "detail", "device", "canvas", "pillHeight", "pillRadius", "buttonHeight", "prominent",
    "template", "rows", "model", "pageSize", "rowHeight",
    "opacity", "strokeWidth", "borderSides", "borderTop", "borderBottom", "borderLeft", "borderRight",
    "backdropBlur", "innerGlow", "noise", "gradient", "shadow", "aurora",
    "wrap", "colSpan", "rowSpan", "right", "bottom", "anchor", "z", "after", "afterGap", "alignX", "pin", "pinGap",
    "spans", "italic", "underline", "strikethrough", "letterSpacing",
    "icon", "points", "smooth", "direction", "visible", "hidden", "adaptive",
    "centerAction", "_expanded", "_mw", "_mh", "_x", "_y", "_w", "_h",
}


def validate_node_schema(node, warnings_out=None, path="root", allow_fallback=False):
    """静态校验声明式节点树：拒绝未知组件 type，并对拼写错误的未知属性名给出近似建议告警。"""
    import difflib
    if not isinstance(node, dict):
        return
    ntype = node.get("type", "box")
    nm = node.get("name", path)
    if ntype not in KNOWN_NODE_TYPES:
        hints = difflib.get_close_matches(str(ntype), sorted(KNOWN_NODE_TYPES), n=2, cutoff=0.45)
        hint_str = f" Did you mean: {', '.join(hints)}?" if hints else f" Supported types: {', '.join(sorted(KNOWN_NODE_TYPES))}"
        raise ValueError(f"[ERR_UNKNOWN_NODE_TYPE] Unknown component type '{ntype}' at '{nm}' ({path}).{hint_str}")
    if warnings_out is not None:
        for k in node.keys():
            if k not in KNOWN_NODE_PROPS and not str(k).startswith("_"):
                hints = difflib.get_close_matches(str(k), sorted(KNOWN_NODE_PROPS), n=2, cutoff=0.5)
                sug = f" (did you mean '{hints[0]}'?)" if hints else ""
                warnings_out.append(f"[WARN_UNKNOWN_PROP] Unknown property '{k}' on {ntype} '{nm}'{sug}")
        for txt_key in ("text", "content", "title", "caption", "placeholder"):
            val = node.get(txt_key)
            if isinstance(val, str) and val:
                bad_g = find_unrenderable_glyphs(val, allow_fallback=allow_fallback)
                if bad_g:
                    warnings_out.append(
                        f"[WARN_ZERO_INK_GLYPH] Unrenderable zero-ink glyph(s) {bad_g} in {nm}.{txt_key}"
                    )
    for idx, ch in enumerate(node.get("children") or []):
        validate_node_schema(ch, warnings_out, f"{path}.children[{idx}]", allow_fallback=allow_fallback)
    for idx, st in enumerate(node.get("states") or []):
        if isinstance(st, dict):
            sub_root = st.get("root") or st.get("tree")
            if isinstance(sub_root, dict):
                validate_node_schema(sub_root, warnings_out, f"{path}.states[{idx}]", allow_fallback=allow_fallback)
            elif isinstance(st.get("children"), list):
                for c_idx, sch in enumerate(st["children"]):
                    validate_node_schema(sch, warnings_out, f"{path}.states[{idx}].children[{c_idx}]", allow_fallback=allow_fallback)


def _preserve_when_attrs(src, dst):
    if isinstance(src, dict) and isinstance(dst, dict):
        for k in ("_when_group", "_when_branch", "_when_default_visible", "_row_visibles", "visible", "hidden"):
            if k in src and k not in dst:
                dst[k] = src[k]
        for coord_k in ("x", "y", "w", "h"):
            if coord_k in src and isinstance(src[coord_k], (int, float)):
                dst.setdefault(f"_declared_{coord_k}", src[coord_k])
    return dst


def expand_declarative_tree(node, prefix="p1"):
    """包装：核心展开后再补回布局约束键（after/afterGap/alignX/z），并把 pin 翻译成贴边坐标。"""
    if (isinstance(node, dict) and node.get("type", "box") in ("box", "card")
            and node.get("align") == "center" and node.get("justify") == "center"
            and node.get("layout", "column") in ("column", "row")
            and len(node.get("children") or []) == 1):
        child = node["children"][0]
        if isinstance(child, dict) and child.get("type") == "label" and "align" not in child:
            node = {**node, "children": [{**child, "align": "center"}]}
    out = _expand_declarative_tree_core(node, prefix)
    if isinstance(out, dict) and isinstance(node, dict):
        for key in ("after", "afterGap", "alignX", "z", "adaptive", "_master_instance", "_master_slot"):
            if node.get(key) is not None and key not in out:
                out[key] = node[key]
        pin = node.get("pin")
        if isinstance(pin, str):
            gap = node.get("pinGap", 0) or 0
            side = pin.strip().lower()
            if side == "right" and "right" not in out:
                out["right"] = gap
            elif side == "bottom" and "bottom" not in out:
                out["bottom"] = gap
            elif side == "left" and "x" not in out:
                out["x"] = gap
            elif side == "top" and "y" not in out:
                out["y"] = gap
    return out


def _expand_declarative_tree_core(node, prefix="p1"):
    """将声明式 JSON 组件节点递归展开为标准自动布局节点树（零静默丢弃）。"""
    import difflib
    if not isinstance(node, dict):
        return node
    ntype = node.get("type", "box")
    pfx = node.get("prefix", prefix)
    if ntype not in KNOWN_NODE_TYPES:
        hints = difflib.get_close_matches(str(ntype), sorted(KNOWN_NODE_TYPES), n=2, cutoff=0.45)
        hint_str = f" Did you mean: {', '.join(hints)}?" if hints else ""
        raise ValueError(f"[ERR_UNKNOWN_NODE_TYPE] Unknown component type '{ntype}' at node '{node.get('name', '<unnamed>')}'.{hint_str}")
    if ntype == "label":
        out_lbl = dict(node)
        out_lbl["name"] = node.get("name", f"{pfx}-label")
        out_lbl["text"] = str(node.get("text", node.get("content", "")))
        out_lbl["fontSize"] = snap_token(node.get("fontSize", node.get("size", 14)), FONT_SIZE_TOKENS)
        out_lbl["fontWeight"] = snap_token(node.get("fontWeight", node.get("weight", 400)), FONT_WEIGHT_TOKENS)
        out_lbl["color"] = node.get("color", "$ink")
        out_lbl["align"] = node.get("align", "left")
        return _preserve_when_attrs(node, out_lbl)
    if ntype in ("button", "badge"):
        is_badge = ntype == "badge"
        btn_text = node.get("text", node.get("content", node.get("label", "")))
        btn_name = node.get("name", f"{pfx}-{'badge' if is_badge else 'button'}")
        btn_extra = {}
        for k in (
            "fill", "stroke", "color", "align", "textPaddingX", "opacity", "strokeWidth",
            "borderSides", "borderTop", "borderBottom", "borderLeft", "borderRight",
            "backdropBlur", "innerGlow", "noise", "gradient", "shadow", "aurora",
            "x", "y", "right", "bottom", "anchor", "colSpan", "rowSpan",
            "spans", "italic", "underline", "strikethrough", "letterSpacing",
            "after", "afterGap", "alignX", "z",
        ):
            if k in node and node.get(k) is not None:
                btn_extra[k] = node.get(k)
        if node.get("variant") == "glass" and "backdropBlur" not in btn_extra:
            btn_extra["backdropBlur"] = 14
        if "flex" in node:
            btn_extra["flex"] = node.get("flex")
        if "_worst_case" in node:
            btn_extra["_worst_case"] = node.get("_worst_case")
        if "_row_texts" in node:
            btn_extra["_row_texts"] = node.get("_row_texts")
        raw_h = node.get("h")
        btn_h = raw_h if (is_fill(raw_h) or is_hug(raw_h)) else resolve_size(raw_h, 22 if is_badge else 36, "h")
        _btn_out = _preserve_when_attrs(node, make_button(
            btn_name,
            btn_text,
            variant=node.get("variant", "soft" if is_badge else "primary"),
            w=node.get("w"),
            h=btn_h,
            size=node.get("fontSize", node.get("size", 11 if is_badge else 13)),
            radius=node.get("radius", 4 if is_badge else 6),
            **btn_extra,
        ))
        if isinstance(node.get("id"), str):
            _btn_out.setdefault("id", node["id"])  # 保留逻辑 id，after/引用才能命中
        return _btn_out
    if ntype == "input":
        inp_name = node.get("name", f"{pfx}-input")
        ph = node.get("text", node.get("value", node.get("placeholder", "请输入...")))
        raw_w, raw_h = node.get("w"), node.get("h")
        inp_w = raw_w if (is_fill(raw_w) or is_hug(raw_w)) else (raw_w if raw_w is not None else (None if "flex" in node else 200))
        inp_h = raw_h if (is_fill(raw_h) or is_hug(raw_h)) else resolve_size(raw_h, 36, "h")
        if node.get("native") is True:
            out_ni = {
                "type": "native-input",
                "name": inp_name,
                "placeholder": str(node.get("placeholder", node.get("text", ""))),
                "value": node.get("value", ""),
                "w": inp_w or 200,
                "h": inp_h,
                "fill": node.get("fill", "$surface-2"),
                "stroke": node.get("stroke", "$line-strong"),
                "radius": snap_token(node.get("radius", 6), RADIUS_TOKENS),
            }
            for key in ("fontSize", "size", "fontWeight", "weight", "color", "align", "textPaddingX", "x", "y", "right", "bottom", "anchor"):
                if key in node:
                    out_ni[key] = node[key]
            if "flex" in node:
                out_ni["flex"] = node.get("flex")
            return _preserve_when_attrs(node, out_ni)
        inp_extra = {
            "fill": node.get("fill", "$surface-2"),
            "stroke": node.get("stroke", "$line"),
            "color": node.get("color", "$ink" if ("value" in node or "text" in node) else "$ink-2"),
            "align": node.get("align", "left"),
        }
        for key in ("x", "y", "right", "bottom", "anchor", "colSpan", "rowSpan"):
            if key in node and node.get(key) is not None:
                inp_extra[key] = node.get(key)
        if "flex" in node:
            inp_extra["flex"] = node.get("flex")
        if "textPaddingX" in node:
            inp_extra["textPaddingX"] = node.get("textPaddingX")
        return _preserve_when_attrs(node, make_button(
            inp_name,
            str(ph),
            variant=node.get("variant", "secondary"),
            w=inp_w,
            h=inp_h,
            size=node.get("fontSize", node.get("size", 12)),
            radius=node.get("radius", 6),
            **inp_extra,
        ))
    if ntype == "divider":
        div_name = node.get("name", f"{pfx}-divider")
        is_vert = node.get("direction") == "vertical"
        raw_w, raw_h = node.get("w"), node.get("h")
        div_extra = {}
        for key in ("x", "y", "right", "bottom", "anchor", "colSpan", "rowSpan"):
            if key in node and node.get(key) is not None:
                div_extra[key] = node.get(key)
        return _preserve_when_attrs(node, make_box(
            f"grp-{div_name}",
            layout="stack",
            w=(raw_w if (is_fill(raw_w) or is_hug(raw_w)) else resolve_size(raw_w, 1, "w")) if is_vert else (raw_w if raw_w is not None else "fill"),
            h=(raw_h if raw_h is not None else "fill") if is_vert else (raw_h if (is_fill(raw_h) or is_hug(raw_h)) else resolve_size(raw_h, 1, "h")),
            fill=node.get("color", node.get("fill", "$line")),
            radius=0,
            isGroup=False,
            bgName=node.get("bgName", div_name),
            children=[],
            **div_extra,
        ))
    if ntype == "card":
        card_name = node.get("name", f"{pfx}-card")
        card_children = [expand_declarative_tree(ch, prefix=pfx) for ch in (node.get("children") or [])]
        card_out = dict(node)
        is_glass = node.get("variant") == "glass"
        card_out["type"] = "box"
        card_out["name"] = card_name
        card_out["layout"] = node.get("layout", "column")
        card_out["padding"] = node.get("padding", [16, 16])
        card_out["gap"] = node.get("gap", 12)
        card_out["fill"] = node.get("fill", "$glass" if is_glass else "$surface")
        card_out["stroke"] = node.get("stroke", "$glass-border" if is_glass else "$line")
        card_out["radius"] = node.get("radius", 16 if is_glass else 10)
        if is_glass and "backdropBlur" not in card_out:
            card_out["backdropBlur"] = 18
        card_out["isGroup"] = bool(node.get("isGroup", True))
        card_out["bgName"] = node.get("bgName", f"bg-{card_name}")
        card_out["children"] = card_children
        return _preserve_when_attrs(node, card_out)
    if ntype == "mobile-navbar":
        return _preserve_when_attrs(node, expand_mobile_navbar(node, prefix=pfx))
    if ntype == "mobile-searchbar":
        return _preserve_when_attrs(node, expand_mobile_searchbar(node, prefix=pfx))
    if ntype == "mobile-segmented":
        return _preserve_when_attrs(node, expand_mobile_segmented(node, prefix=pfx))
    if ntype == "mobile-card-list":
        return _preserve_when_attrs(node, expand_mobile_card_list(node, prefix=pfx))
    if ntype == "mobile-tabbar":
        return _preserve_when_attrs(node, expand_mobile_tabbar(node, prefix=pfx))
    if ntype == "mobile-detail-view":
        return _preserve_when_attrs(node, expand_mobile_detail_view(node, prefix=pfx))
    if ntype == "mobile-form-view":
        return _preserve_when_attrs(node, expand_mobile_form_view(node, prefix=pfx))
    if ntype == "sidebar":
        return _preserve_when_attrs(node, expand_sidebar(node))
    if ntype == "topbar":
        return _preserve_when_attrs(node, expand_topbar(node))
    if ntype == "kpi-card":
        return _preserve_when_attrs(node, expand_kpi_card(node))
    out = dict(node)
    if not out.get("name"):
        out["name"] = f"grp-{pfx}-{ntype}"
    if "children" in out and isinstance(out["children"], list):
        out["children"] = [expand_declarative_tree(ch, prefix=pfx) for ch in out["children"]]
        if out.get("type", "box") == "box" and "isGroup" not in out and out["children"]:
            out["isGroup"] = True
    if out.get("type") == "repeater":
        out["template"] = expand_declarative_tree(out["template"], prefix=pfx)
    if "states" in out and isinstance(out["states"], list):
        new_states = []
        for s_idx, st in enumerate(out["states"]):
            if not isinstance(st, dict):
                continue
            st_copy = dict(st)
            if "name" not in st_copy and isinstance(st_copy.get("id"), str):
                st_copy["name"] = st_copy["id"]
            st_pfx = st_copy.get("prefix", f"{pfx}-{st_copy.get('name', f'st{s_idx+1}')}")
            if "tree" in st_copy and isinstance(st_copy["tree"], dict):
                st_copy["tree"] = expand_declarative_tree(st_copy["tree"], prefix=st_pfx)
            elif "root" in st_copy and isinstance(st_copy["root"], dict):
                st_copy["tree"] = expand_declarative_tree(st_copy["root"], prefix=st_pfx)
            elif isinstance(st_copy.get("children"), list):
                synth_root = {
                    "type": "box",
                    "name": f"{st_pfx}-root",
                    "layout": st_copy.get("layout", "column"),
                    "w": st_copy.get("w", "fill"),
                    "h": st_copy.get("h", "hug"),
                    "gap": st_copy.get("gap", 12),
                    "padding": st_copy.get("padding", 0),
                    "children": st_copy.pop("children"),
                }
                st_copy["tree"] = expand_declarative_tree(synth_root, prefix=st_pfx)
            new_states.append(st_copy)
        out["states"] = new_states
    return _preserve_when_attrs(node, out)


def apply_detail_bindings(raw_pages):
    """扫描页面树中的 mobile-card-list.bindDetail，自动注入首卡默认详情同步、卡片点击跳转与目标页/同页数据绑定。"""
    import copy
    pages = copy.deepcopy(raw_pages)
    page_by_name = {p.get("name"): p for p in pages if p.get("name")}

    def find_nodes_by_type(n, target_type, results=None):
        if results is None:
            results = []
        if not isinstance(n, dict):
            return results
        if n.get("type") == target_type:
            results.append(n)
        for ch in n.get("children", []) or []:
            find_nodes_by_type(ch, target_type, results)
        for st in n.get("states", []) or []:
            find_nodes_by_type(st.get("root") or st.get("tree"), target_type, results)
        return results

    def find_dynamic_panel(n, panel_name):
        if not isinstance(n, dict):
            return None
        if n.get("type") == "dynamic-panel" and n.get("name") == panel_name:
            return n
        for ch in n.get("children", []) or []:
            found = find_dynamic_panel(ch, panel_name)
            if found:
                return found
        return None

    for idx, p in enumerate(pages):
        p_slug = p.get("slug") or f"page-{idx+1}"
        card_lists = find_nodes_by_type(p.get("root"), "mobile-card-list")
        for cl in card_lists:
            bind = cl.get("bindDetail")
            if not bind or not isinstance(bind, dict):
                continue
            cl_pfx = cl.get("prefix") or p_slug
            cards = cl.get("cards") or []
            if not cards:
                continue
            target_page_name = bind.get("page") or bind.get("targetPage") or p.get("name")
            target_page = page_by_name.get(target_page_name, p)
            target_panel_name = bind.get("panel") or bind.get("targetPanel")
            # 自动探测目标页 mobile-detail-view 的真实 prefix，避免文档没写就 100% 悬空。
            # 优先级：显式 targetPrefix > 目标页 detail-view 的 prefix > "view"（兼容旧行为）
            _auto_pfx = None
            for _dv in find_nodes_by_type(target_page.get("root"), "mobile-detail-view"):
                _auto_pfx = _dv.get("prefix")
                if _auto_pfx:
                    break
            if not _auto_pfx:
                # 关键：页面展开时 `expand_declarative_tree(root, prefix=p_slug)`，
                # 所以未显式写 prefix 的 detail-view 实际前缀 = 页面 slug。
                # 其次才回退到祖先 prefix / 祖先 name。
                def _find_pfx(n, inherited=None):
                    if not isinstance(n, dict):
                        return None
                    cur = n.get("prefix") or inherited
                    if n.get("type") == "mobile-detail-view":
                        if n.get("prefix"):
                            return n["prefix"]
                        return inherited or n.get("name") or None
                    for ch in (n.get("children") or []):
                        _r = _find_pfx(ch, cur)
                        if _r:
                            return _r
                    return None
                _auto_pfx = _find_pfx(target_page.get("root"))
                if not _auto_pfx:
                    # 最后回退：页面 slug（与 expand_declarative_tree 的 prefix=p_slug 一致）
                    _auto_pfx = target_page.get("slug")
            target_pfx = bind.get("targetPrefix") or _auto_pfx or "view"
            expand_states = bool(bind.get("expandStates", False))
            mode = bind.get("mode") or ("panel-states" if target_panel_name else "set-text")

            # 同步首张卡片的 detail 到目标页的首个 mobile-detail-view 默认数据
            first_detail = cards[0].get("detail")
            if isinstance(first_detail, dict):
                for dv in find_nodes_by_type(target_page.get("root"), "mobile-detail-view"):
                    existing_data = dict(dv.get("data") or {})
                    dv["data"] = {**first_detail, **existing_data}
                    break

            p_ixs = list(p.get("interactions") or [])
            existing_triggers = {ix.get("trigger") for ix in p_ixs}

            if mode == "panel-states" and target_panel_name:
                dp_node = find_dynamic_panel(target_page.get("root"), target_panel_name)
                state_map = {}
                if dp_node and dp_node.get("states"):
                    base_state = copy.deepcopy(dp_node["states"][0])
                    state_map[cards[0].get("id", "c1")] = base_state["name"]
                    if expand_states and len(cards) > 1:
                        new_states = [dp_node["states"][0]]
                        for c_idx, c in enumerate(cards[1:], start=2):
                            cid = c.get("id", f"c{c_idx}")
                            c_detail = c.get("detail") or {"itemTitle": c.get("title", ""), "badge": c.get("badge", "失物招领"), "location": c.get("loc", ""), "pubTime": c.get("time", "")}
                            st_clone = copy.deepcopy(base_state)
                            st_clone["name"] = f"{base_state['name']}-{cid}"
                            st_clone["prefix"] = f"{base_state.get('prefix', 'view')}-{cid}"
                            for dv in find_nodes_by_type(st_clone.get("root") or st_clone.get("tree"), "mobile-detail-view"):
                                dv["prefix"] = st_clone["prefix"]
                                dv["data"] = c_detail
                            new_states.append(st_clone)
                            state_map[cid] = st_clone["name"]
                        new_states.extend(dp_node["states"][1:])
                        dp_node["states"] = new_states
                for c_idx, c in enumerate(cards):
                    cid = c.get("id", f"c{c_idx+1}")
                    trig_btn = c.get("buttonName") or f"{cl_pfx}-btn-detail-{cid}"
                    if trig_btn in existing_triggers:
                        continue
                    acts = []
                    if expand_states and cid in state_map:
                        acts.append({"type": "set-variable", "variable": "OnLoadVariable", "value": cid})
                    if target_page_name and target_page_name != p.get("name"):
                        acts.append({"type": "link", "page": target_page_name})
                    elif cid in state_map:
                        acts.append({"type": "set-panel-state", "target": target_panel_name, "state": state_map[cid]})
                    if acts:
                        p_ixs.append({
                            "trigger": trig_btn,
                            "description": f"点击卡片 {cid} 查看对应详情",
                            "events": [{"event": "OnClick", "cases": [{"name": f"GoCardDetail_{cid}", "actions": acts}]}],
                        })
                if expand_states and state_map and target_page_name != p.get("name"):
                    tp_ixs = list(target_page.get("interactions") or [])
                    onload_cases = []
                    for cid, st_nm in state_map.items():
                        onload_cases.append({
                            "name": f"LoadCard_{cid}",
                            "condition": "if" if not onload_cases else "else-if",
                            "when": {"left": {"variable": "OnLoadVariable"}, "op": "==", "right": cid},
                            "actions": [{"type": "set-panel-state", "target": target_panel_name, "state": st_nm}],
                        })
                    tp_ixs.append({
                        "trigger": "page",
                        "description": "根据所选卡片 OnLoadVariable 切换对应物品详情状态",
                        "events": [{"event": "OnPageLoad", "cases": onload_cases}],
                    })
                    target_page["interactions"] = tp_ixs
            elif mode == "set-text":
                tp_onload_cases = []
                for c_idx, c in enumerate(cards):
                    cid = c.get("id", f"c{c_idx+1}")
                    trig_btn = c.get("buttonName") or f"{cl_pfx}-btn-detail-{cid}"
                    d = c.get("detail") or {}
                    set_text_acts = [
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-badge-type", "text": d.get("badge", c.get("badge", "失物招领"))},
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-item-title", "text": d.get("itemTitle", c.get("title", ""))},
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-attr-loc", "text": d.get("location", f"拾获地点：{c.get('loc', '')}")},
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-item-pubtime", "text": d.get("pubTime", f"发布时间：{c.get('time', '')}")},
                    ]
                    if d.get("statusText"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-item-meta", "text": d["statusText"]})
                    if d.get("category"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-attr-cat", "text": d["category"]})
                    if d.get("holder"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-attr-holder", "text": d["holder"]})
                    if d.get("description"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-desc-para", "text": d["description"]})
                    if target_page_name == p.get("name"):
                        if trig_btn not in existing_triggers:
                            p_ixs.append({
                                "trigger": trig_btn,
                                "description": f"点击卡片 {cid} 更新详情文本",
                                "events": [{"event": "OnClick", "cases": [{"name": f"BindDetail_{cid}", "actions": set_text_acts}]}],
                            })
                    else:
                        if trig_btn not in existing_triggers:
                            p_ixs.append({
                                "trigger": trig_btn,
                                "description": f"点击卡片 {cid} 携带参数跳转详情页",
                                "events": [{"event": "OnClick", "cases": [{"name": f"GoCardDetail_{cid}", "actions": [{"type": "set-variable", "variable": "OnLoadVariable", "value": cid}, {"type": "link", "page": target_page_name}]}]}],
                            })
                        tp_onload_cases.append({
                            "name": f"ApplyDetail_{cid}",
                            "condition": "if" if not tp_onload_cases else "else-if",
                            "when": {"left": {"variable": "OnLoadVariable"}, "op": "==", "right": cid},
                            "actions": set_text_acts,
                        })
                if tp_onload_cases:
                    tp_ixs = list(target_page.get("interactions") or [])
                    tp_ixs.append({
                        "trigger": "page",
                        "description": "页面加载时根据 OnLoadVariable 填充对应物品详情文本",
                        "events": [{"event": "OnPageLoad", "cases": tp_onload_cases}],
                    })
                    target_page["interactions"] = tp_ixs
            p["interactions"] = p_ixs
    return pages


def targetPrefix_or(val):
    return val or "view"


def build_mobile_lostfound_spec(title_override=None):
    """构建内置移动端多页多态示例 spec：校园失物招领 App (3 页 + iPhone X 手机壳 + 双态动态面板 + 跨页交互)。"""
    p1_name = "页面一：失物信息浏览页"
    p2_name = "页面二：物品详情页"
    p3_name = "页面三：页面关系与设计说明"
    return {
        "name": title_override or "拾物 · 校园失物招领 App 原型",
        "domain": "mobile",
        "theme": "mobile-lowfi",
        "pages": [
            {
                "name": p1_name,
                "slug": "page1-browse",
                "device": "iphone-x",
                "canvas": {"w": 375, "h": 812},
                "root": {
                    "type": "box",
                    "name": "grp-p1-screen",
                    "layout": "column",
                    "w": 375,
                    "h": 812,
                    "padding": [44, 0, 0, 0],
                    "gap": 0,
                    "fill": "$bg",
                    "isGroup": True,
                    "bgName": "bg-p1-screen",
                    "children": [
                        {"type": "mobile-navbar", "prefix": "p1", "title": "拾物 · 招领广场", "rightText": "规范说明", "rightName": "p1-btn-doc"},
                        {"type": "mobile-searchbar", "prefix": "p1"},
                        {"type": "mobile-segmented", "prefix": "p1"},
                        {
                            "type": "mobile-card-list",
                            "prefix": "p1",
                            "h": 548,
                            "bindDetail": {
                                "page": p2_name,
                                "panel": "panel-item-state",
                            },
                        },
                        {"type": "mobile-tabbar", "prefix": "p1"},
                    ],
                },
                "interactions": [
                    {
                        "trigger": "p1-btn-detail-c1",
                        "description": "点击卡片1进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail1", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-detail-c2",
                        "description": "点击卡片2进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail2", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-detail-c3",
                        "description": "点击卡片3进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail3", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-detail-c4",
                        "description": "点击卡片4进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail4", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-publish-plus",
                        "description": "点击底部发布按钮进入物品详情/发布页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoPublish", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-doc",
                        "description": "点击右上角规范说明进入设计说明页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDoc", "actions": [{"type": "link", "page": p3_name}]}]}],
                    },
                ],
            },
            {
                "name": p2_name,
                "slug": "page2-detail-panel",
                "device": None,
                "canvas": {"w": 420, "h": 860},
                "root": {
                    "type": "box",
                    "name": "grp-p2-host",
                    "layout": "stack",
                    "w": 420,
                    "h": 860,
                    "fill": "$surface",
                    "isGroup": True,
                    "bgName": "bg-p2-host",
                    "children": [
                        {
                            "type": "dynamic-panel",
                            "name": "panel-item-state",
                            "x": 0,
                            "y": 0,
                            "w": 420,
                            "h": 860,
                            "states": [
                                {
                                    "name": "状态一：查看物品详情",
                                    "prefix": "view",
                                    "device": "iphone-x",
                                    "canvas": {"w": 375, "h": 812},
                                    "root": {"type": "mobile-detail-view", "prefix": "view", "title": "物品信息详情"},
                                },
                                {
                                    "name": "状态二：发布失物招领",
                                    "prefix": "pub",
                                    "device": "iphone-x",
                                    "canvas": {"w": 375, "h": 812},
                                    "root": {"type": "mobile-form-view", "prefix": "pub", "title": "发布寻物 / 招领信息"},
                                },
                            ],
                        }
                    ],
                },
                "interactions": [
                    {
                        "trigger": "view-btn-to-publish",
                        "description": "从查看态切换到发布态",
                        "events": [{"event": "OnClick", "cases": [{"name": "ToPublishState", "actions": [{"type": "set-panel-state", "target": "panel-item-state", "state": "状态二：发布失物招领"}]}]}],
                    },
                    {
                        "trigger": "view-btn-back",
                        "description": "从详情查看态返回招领广场",
                        "events": [{"event": "OnClick", "cases": [{"name": "BackToSquareFromView", "actions": [{"type": "link", "page": p1_name}]}]}],
                    },
                    {
                        "trigger": "pub-btn-to-view",
                        "description": "从发布态切换回查看态",
                        "events": [{"event": "OnClick", "cases": [{"name": "ToViewState", "actions": [{"type": "set-panel-state", "target": "panel-item-state", "state": "状态一：查看物品详情"}]}]}],
                    },
                    {
                        "trigger": "pub-btn-back",
                        "description": "从发布态返回查看态",
                        "events": [{"event": "OnClick", "cases": [{"name": "BackToViewFromPub", "actions": [{"type": "set-panel-state", "target": "panel-item-state", "state": "状态一：查看物品详情"}]}]}],
                    },
                    {
                        "trigger": "pub-btn-submit",
                        "description": "提交发布后返回招领广场",
                        "events": [{"event": "OnClick", "cases": [{"name": "SubmitAndBackSquare", "actions": [{"type": "link", "page": p1_name}]}]}],
                    },
                ],
            },
            {
                "name": p3_name,
                "slug": "page3-spec-doc",
                "device": None,
                "canvas": {"w": 1120, "h": 680},
                "root": {
                    "type": "box",
                    "name": "grp-doc-canvas",
                    "layout": "column",
                    "w": 1120,
                    "h": 680,
                    "padding": [28, 32],
                    "gap": 20,
                    "fill": "$bg",
                    "isGroup": True,
                    "bgName": "bg-doc-canvas",
                    "children": [
                        {
                            "type": "box",
                            "name": "grp-doc-header",
                            "layout": "row",
                            "w": 1056,
                            "h": 72,
                            "padding": [16, 20],
                            "gap": 16,
                            "align": "center",
                            "fill": "$surface",
                            "stroke": "$line",
                            "radius": 10,
                            "isGroup": True,
                            "bgName": "bg-doc-header",
                            "children": [
                                {
                                    "type": "box",
                                    "name": "grp-doc-title-col",
                                    "layout": "column",
                                    "flex": 1,
                                    "gap": 4,
                                    "isGroup": True,
                                    "children": [
                                        make_label("doc-main-title", "拾物 · 校园失物招领 App — 页面流转与设计规范说明", size=18, weight=700, color="$ink"),
                                        make_label("doc-main-sub", "遵循 iPhone X (375×812 pt / 420×860 整机画板) 低保真灰阶线框规范 · 全元件语义命名与编组", size=12, weight=400, color="$ink-2"),
                                    ],
                                },
                                make_button("doc-btn-back-app", "返回招领广场 >", variant="primary", w=132, h=36, size=12, radius=8),
                            ],
                        },
                        {
                            "type": "box",
                            "name": "grp-doc-cards",
                            "layout": "row",
                            "w": 1056,
                            "h": 520,
                            "gap": 20,
                            "isGroup": True,
                            "children": [
                                {
                                    "type": "box",
                                    "name": "grp-doc-col-1",
                                    "layout": "column",
                                    "flex": 1,
                                    "h": 520,
                                    "padding": [20, 20],
                                    "gap": 12,
                                    "fill": "$surface",
                                    "stroke": "$line",
                                    "radius": 10,
                                    "isGroup": True,
                                    "bgName": "bg-doc-col-1",
                                    "children": [
                                        make_button("doc-tag-1", "01 · 页面架构与跳转关系", variant="secondary", w=188, h=26, size=11, radius=6),
                                        {
                                            "type": "paragraph",
                                            "name": "doc-para-flow",
                                            "w": 292,
                                            "fontSize": 12,
                                            "text": "本原型包含 3 个顶层页面：页面一为失物信息浏览广场；页面二内置双状态动态面板（状态一：查看物品详情；状态二：发布寻物/招领信息）；页面三为本架构与设计规范说明。",
                                        },
                                        make_label("doc-flow-rule-1", "1. 浏览页点击任意物品卡片 → 跳转页面二（查看态）", size=12, weight=600, color="$ink"),
                                        make_label("doc-flow-rule-2", "2. 详情查看态点击右上角「去发布」→ 切换至发布态", size=12, weight=600, color="$ink"),
                                        make_label("doc-flow-rule-3", "3. 发布态点击「确认发布」→ 返回页面一招领广场", size=12, weight=600, color="$ink"),
                                    ],
                                },
                                {
                                    "type": "box",
                                    "name": "grp-doc-col-2",
                                    "layout": "column",
                                    "flex": 1,
                                    "h": 520,
                                    "padding": [20, 20],
                                    "gap": 12,
                                    "fill": "$surface",
                                    "stroke": "$line",
                                    "radius": 10,
                                    "isGroup": True,
                                    "bgName": "bg-doc-col-2",
                                    "children": [
                                        make_button("doc-tag-2", "02 · 视口尺寸与安全区规范", variant="secondary", w=188, h=26, size=11, radius=6),
                                        {
                                            "type": "paragraph",
                                            "name": "doc-para-spec",
                                            "w": 292,
                                            "fontSize": 12,
                                            "text": "采用内置 iPhone X 规范外框（外框 420×860 px，内屏视口 375×812 px，内屏偏移 X=25, Y=21）。顶部预留 44pt 状态栏与 44pt 导航栏，底部预留 34pt Home Indicator 安全区。",
                                        },
                                        make_label("doc-spec-item-1", "• 页面边距：左右安全间距 16pt，卡片内边距 12pt", size=12, weight=500, color="$ink-2"),
                                        make_label("doc-spec-item-2", "• 色彩体系：纯灰阶低保真线框（#262626 ~ #F7F7F7）", size=12, weight=500, color="$ink-2"),
                                        make_label("doc-spec-item-3", "• 字阶规范：标题 16/18pt，正文 12/13pt，辅助 11pt", size=12, weight=500, color="$ink-2"),
                                    ],
                                },
                                {
                                    "type": "box",
                                    "name": "grp-doc-col-3",
                                    "layout": "column",
                                    "flex": 1,
                                    "h": 520,
                                    "padding": [20, 20],
                                    "gap": 12,
                                    "fill": "$surface",
                                    "stroke": "$line",
                                    "radius": 10,
                                    "isGroup": True,
                                    "bgName": "bg-doc-col-3",
                                    "children": [
                                        make_button("doc-tag-3", "03 · 结构与命名质量门禁", variant="secondary", w=188, h=26, size=11, radius=6),
                                        {
                                            "type": "paragraph",
                                            "name": "doc-para-qa",
                                            "w": 292,
                                            "fontSize": 12,
                                            "text": "所有页面与动态面板状态均通过确定性 Auto-Layout 排版、PingFang 字宽防裁切校验、原生 Layer 编组发射与 0 重名全量坐标校验。",
                                        },
                                        make_label("doc-qa-item-1", "● 语义命名覆盖率：100%（零 Unnamed / 零重名）", size=12, weight=600, color="$ink"),
                                        make_label("doc-qa-item-2", "● 原生 Layer 编组覆盖率：≥ 95%", size=12, weight=600, color="$ink"),
                                        make_label("doc-qa-item-3", "● 文本裁切与重叠数：0 处", size=12, weight=600, color="$ink"),
                                    ],
                                },
                            ],
                        },
                    ],
                },
                "interactions": [
                    {
                        "trigger": "doc-btn-back-app",
                        "description": "从说明页返回招领广场",
                        "events": [{"event": "OnClick", "cases": [{"name": "BackToSquareFromDoc", "actions": [{"type": "link", "page": p1_name}]}]}],
                    }
                ],
            },
        ],
    }


STATE_PREVIEWS = []


def render_contact_sheet_png(items, out_path, max_cols=4, max_thumb_h=640, max_thumb_w=460, title="Prototype Contact Sheet"):
    """Stitch multiple page or state PNG previews into a single grid overview image."""
    valid = []
    for it in (items or []):
        p = it.get("path")
        if p and os.path.exists(p):
            try:
                im = Image.open(p).convert("RGBA")
                valid.append((it.get("label") or os.path.basename(p), im))
            except Exception:
                continue
    if not valid:
        return None
    cols = min(max_cols, len(valid))
    rows = (len(valid) + cols - 1) // cols
    thumbs = []
    for lbl, im in valid:
        iw, ih = im.size
        scale = min(1.0, max_thumb_w / max(1, iw), max_thumb_h / max(1, ih))
        tw = max(40, int(round(iw * scale)))
        th = max(40, int(round(ih * scale)))
        tim = im.resize((tw, th), Image.Resampling.LANCZOS) if scale < 0.999 else im
        thumbs.append((lbl, tim, tw, th))
    cell_w = max(260, max(t[2] for t in thumbs) + 28)
    cell_h = max(t[3] for t in thumbs) + 52
    pad = 24
    hdr_h = 44
    sheet_w = pad * 2 + cols * cell_w
    sheet_h = pad * 2 + hdr_h + rows * cell_h
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (244, 246, 250, 255))
    draw = ImageDraw.Draw(sheet)
    font_title = load_font(16, 700)
    font_lbl = load_font(13, 600)
    draw.text((pad, pad + 8), f"{title} ({len(thumbs)})", fill=(24, 32, 44, 255), font=font_title)
    for idx, (lbl, tim, tw, th) in enumerate(thumbs):
        r = idx // cols
        c = idx % cols
        cx = pad + c * cell_w
        cy = pad + hdr_h + r * cell_h
        draw.rounded_rectangle([cx + 4, cy + 4, cx + cell_w - 8, cy + cell_h - 8], radius=12, fill=(255, 255, 255, 255), outline=(220, 226, 236, 255), width=1)
        draw.text((cx + 14, cy + 12), str(lbl)[:48], fill=(32, 42, 56, 255), font=font_lbl)
        ix = cx + (cell_w - tw) // 2
        iy = cy + 38 + (cell_h - 46 - th) // 2
        sheet.paste(tim, (ix, iy), tim)
    sheet.convert("RGB").save(out_path)
    return out_path


def _auto_heal_spec_pre_compile(spec_data, strict_audit=False):
    """Safe pre-compile normalization: fix outer device chassis canvas mismatch and snap non-token spacing/radius/font values."""
    changes = []
    if not isinstance(spec_data, dict):
        return changes
    from rp_language import DEVICE_CANVAS_PRESETS
    top_dev = spec_data.get("device") or spec_data.get("shell")
    pages = spec_data.get("pages")
    if isinstance(pages, list):
        for p in pages:
            if not isinstance(p, dict):
                continue
            pid = p.get("id") or p.get("slug") or p.get("name") or "page"
            dev = p.get("device") or p.get("shell") or top_dev
            if not dev and isinstance(p.get("root"), dict):
                r = p["root"]
                if r.get("type") == "phone-shell" or "phone-shell" in r:
                    dev = r.get("device", "iphone-17")
                elif isinstance(r.get("children"), list) and len(r["children"]) == 1 and isinstance(r["children"][0], dict):
                    ch0 = r["children"][0]
                    if ch0.get("type") == "phone-shell" or "phone-shell" in ch0:
                        dev = ch0.get("device", "iphone-17")
            preset = DEVICE_CANVAS_PRESETS.get(dev) if isinstance(dev, str) else None
            if preset:
                cv = p.get("canvas")
                cw = cv[0] if isinstance(cv, list) and len(cv) == 2 else (cv.get("w") if isinstance(cv, dict) else None)
                ch = cv[1] if isinstance(cv, list) and len(cv) == 2 else (cv.get("h") if isinstance(cv, dict) else None)
                if cw == preset["w"] + 40 and ch == preset["h"] + 40:
                    p["canvas"] = {"w": preset["w"], "h": preset["h"]}
                    changes.append({"kind": "normalize-device-canvas", "page": pid, "from": [cw, ch], "to": [preset["w"], preset["h"]]})
                    r = p.get("root")
                    if isinstance(r, dict) and isinstance(r.get("children"), list) and len(r["children"]) == 1:
                        ch0 = r["children"][0]
                        if isinstance(ch0, dict) and (ch0.get("type") == "phone-shell" or "phone-shell" in ch0):
                            ch0.pop("x", None)
                            ch0.pop("y", None)
                            p["root"] = ch0
                            changes.append({"kind": "unwrap-redundant-device-root", "page": pid})
    if strict_audit or spec_data.get("strictAudit"):
        def _snap_tree_tokens(node, path_str=""):
            if not isinstance(node, dict):
                return
            for sp_k in ("gap", "columnGap", "rowGap"):
                if isinstance(node.get(sp_k), (int, float)) and not isinstance(node.get(sp_k), bool):
                    v = node[sp_k]
                    sv = snap_token(v, SPACING_TOKENS)
                    if sv != v:
                        node[sp_k] = sv
                        changes.append({"kind": "snap-spacing-token", "property": sp_k, "from": v, "to": sv})
            if "padding" in node:
                pv = node["padding"]
                if isinstance(pv, (int, float)) and not isinstance(pv, bool):
                    spv = snap_token(pv, SPACING_TOKENS)
                    if spv != pv:
                        node["padding"] = spv
                        changes.append({"kind": "snap-padding-token", "from": pv, "to": spv})
                elif isinstance(pv, list):
                    sp_list = [snap_token(x, SPACING_TOKENS) if isinstance(x, (int, float)) else x for x in pv]
                    if sp_list != pv:
                        node["padding"] = sp_list
                        changes.append({"kind": "snap-padding-token", "from": pv, "to": sp_list})
            if isinstance(node.get("radius"), (int, float)) and not isinstance(node.get("radius"), bool):
                rv = node["radius"]
                srv = 999 if rv >= 100 else snap_token(rv, RADIUS_TOKENS)
                if srv != rv:
                    node["radius"] = srv
                    changes.append({"kind": "snap-radius-token", "from": rv, "to": srv})
            for fn_k in ("fontSize", "size"):
                if isinstance(node.get(fn_k), (int, float)) and not isinstance(node.get(fn_k), bool):
                    fv = node[fn_k]
                    sfv = snap_token(fv, FONT_SIZE_TOKENS)
                    if sfv != fv:
                        node[fn_k] = sfv
                        changes.append({"kind": "snap-font-token", "property": fn_k, "from": fv, "to": sfv})
            for ch in (node.get("children") if isinstance(node.get("children"), list) else []):
                _snap_tree_tokens(ch)
            for st in (node.get("states") if isinstance(node.get("states"), list) else []):
                if isinstance(st, dict):
                    if isinstance(st.get("root") or st.get("tree"), dict):
                        _snap_tree_tokens(st.get("root") or st.get("tree"))
                    elif isinstance(st.get("children"), list):
                        for sch in st["children"]:
                            _snap_tree_tokens(sch)
            if isinstance(node.get("template"), dict):
                _snap_tree_tokens(node["template"])

        for p in (pages if isinstance(pages, list) else []):
            if isinstance(p, dict):
                _snap_tree_tokens(p.get("root"))
        for cdef in (spec_data.get("components") or {}).values() if isinstance(spec_data.get("components"), dict) else []:
            if isinstance(cdef, dict):
                _snap_tree_tokens(cdef.get("root"))
    return changes


def _auto_heal_page_tree(p_root, cw, ch, p_slug, base_dir=None):
    """Safe post-measure layout self-healing on a page's declarative root tree.
    Repairs text clipping (`no_text_clip`) and container overflow (`no_container_overflow`)
    without altering explicit canvas dimensions.
    """
    changes = []
    for _pass in range(2):
        probe = expand_declarative_tree(copy.deepcopy(p_root), prefix=p_slug)
        ensure_unique_names(probe, scope_prefix=p_slug)
        measure_node(probe, base_dir=base_dir, available_w=cw)
        layout_node(probe, 0, 0, cw, ch)

        src_by_name = {}
        parent_map = {}

        def _index_src(node, parent=None):
            if not isinstance(node, dict):
                return
            nm = node.get("name") or node.get("id")
            if nm:
                src_by_name[nm] = node
                if nm.startswith("grp-"):
                    src_by_name[nm[4:]] = node
            if parent is not None:
                parent_map[id(node)] = parent
            for child in (node.get("children") or []):
                _index_src(child, node)
            for st in (node.get("states") or []):
                if isinstance(st, dict):
                    if isinstance(st.get("root") or st.get("tree"), dict):
                        _index_src(st.get("root") or st.get("tree"), node)
                    elif isinstance(st.get("children"), list):
                        for sch in st["children"]:
                            _index_src(sch, node)
            if isinstance(node.get("template"), dict):
                _index_src(node["template"], node)

        _index_src(p_root)
        pass_changes = 0

        def _match_src(w_name):
            if not w_name:
                return None
            if w_name in src_by_name:
                return src_by_name[w_name]
            for prefix_strip in ("bg-box-", "grp-box-", "bg-", "grp-"):
                if w_name.startswith(prefix_strip) and w_name[len(prefix_strip):] in src_by_name:
                    return src_by_name[w_name[len(prefix_strip):]]
            for k, v in src_by_name.items():
                if w_name.endswith("__" + k) or w_name.endswith("-" + k):
                    return v
            return None

        def _heal_walk(pnode):
            nonlocal pass_changes
            if not isinstance(pnode, dict) or "_x" not in pnode:
                return
            nm = pnode.get("name") or pnode.get("id") or ""
            snode = _match_src(nm)
            ntype = pnode.get("type", "box")
            if ntype in ("label", "shape-text") and snode is not None:
                txt = pnode.get("text", "")
                if txt is not None and str(txt).strip():
                    fsz = snap_token(pnode.get("fontSize", pnode.get("size", 14)), FONT_SIZE_TOKENS)
                    fwt = snap_token(pnode.get("fontWeight", pnode.get("weight", 400)), FONT_WEIGHT_TOKENS)
                    pad_in = 16 if (pnode.get("fill") or pnode.get("stroke") or ntype == "shape-text") else 2
                    tw, th = measure_text(str(txt), fsz, fwt)
                    pw, ph = pnode["_w"], pnode["_h"]
                    if tw + pad_in > pw + 2 and not pnode.get("wrap"):
                        par = parent_map.get(id(snode))
                        par_layout = par.get("layout", "column") if isinstance(par, dict) else "column"
                        if snode.get("type") in ("label", "paragraph") and (par_layout == "column" or is_fill(snode.get("w")) or pw >= 120):
                            wrap_lines = wrap_text(str(txt), max(20, pw - pad_in - 4), fsz, fwt)
                            line_h = max(18, int(round(fsz * 1.45)))
                            need_h = max(th, len(wrap_lines) * line_h + 4)
                            snode["wrap"] = True
                            snode["h"] = max(int(snode.get("h")) if isinstance(snode.get("h"), (int, float)) else 0, need_h)
                            changes.append({"kind": "heal-text-wrap", "widget": nm, "h": snode["h"]})
                            pass_changes += 1
                        elif isinstance(snode.get("w"), (int, float)):
                            new_w = int(tw + pad_in + 6)
                            if new_w > snode["w"]:
                                snode["w"] = new_w
                                changes.append({"kind": "heal-text-width", "widget": nm, "w": new_w})
                                pass_changes += 1
                    if th > ph + 1 and isinstance(snode.get("h"), (int, float)):
                        new_h = int(th + 6)
                        if new_h > snode["h"]:
                            delta_h = new_h - int(snode["h"])
                            snode["h"] = new_h
                            cur_p = parent_map.get(id(snode))
                            while isinstance(cur_p, dict):
                                if cur_p is not p_root and isinstance(cur_p.get("h"), (int, float)):
                                    cur_p["h"] = int(cur_p["h"]) + delta_h
                                cur_p = parent_map.get(id(cur_p))
                            changes.append({"kind": "heal-text-height", "widget": nm, "h": new_h})
                            pass_changes += 1

            children = [c for c in (pnode.get("children") or []) if isinstance(c, dict) and not c.get("isModal") and "_x" in c]
            if children and pnode.get("layout", "column") in ("row", "column", "grid"):
                nx, ny, nw, nh = pnode["_x"], pnode["_y"], pnode["_w"], pnode["_h"]
                max_bot_over = max((max(0, (c["_y"] + c["_h"]) - (ny + nh)) for c in children), default=0)
                max_right_over = max((max(0, (c["_x"] + c["_w"]) - (nx + nw)) for c in children), default=0)
                if max_bot_over > 2 and snode is not None:
                    if snode is p_root or (isinstance(snode.get("h"), (int, float)) and int(snode["h"]) >= ch - 8):
                        # Root / phone-shell overflow: compact vertical gaps and paddings
                        def _compact_vertical(box_node):
                            compacted = False
                            if not isinstance(box_node, dict):
                                return False
                            if isinstance(box_node.get("gap"), (int, float)) and box_node["gap"] > 6:
                                old_g = box_node["gap"]
                                smaller = [t for t in SPACING_TOKENS if 4 <= t < old_g]
                                box_node["gap"] = smaller[-1] if smaller else max(4, int(old_g) - 4)
                                compacted = True
                            for ch_b in (box_node.get("children") or []):
                                if _compact_vertical(ch_b):
                                    compacted = True
                            return compacted
                        if _compact_vertical(snode):
                            changes.append({"kind": "compact-root-vertical-spacing", "widget": nm, "overflowPx": max_bot_over})
                            pass_changes += 1
                    elif isinstance(snode.get("h"), (int, float)):
                        new_ch = int(nh + max_bot_over + 4)
                        snode["h"] = new_ch
                        changes.append({"kind": "expand-container-height", "widget": nm, "from": nh, "to": new_ch})
                        pass_changes += 1
                if max_right_over > 2 and snode is not None:
                    if pnode.get("layout") == "row":
                        if isinstance(snode.get("gap"), (int, float)) and snode["gap"] > 6:
                            snode["gap"] = 6
                            changes.append({"kind": "compact-row-gap", "widget": nm, "to": 6})
                            pass_changes += 1
                        else:
                            snode["wrap"] = True
                            if isinstance(snode.get("h"), (int, float)):
                                snode["h"] = "hug"
                            changes.append({"kind": "enable-row-wrap", "widget": nm})
                            pass_changes += 1
                    else:
                        for c in children:
                            if (c["_x"] + c["_w"]) > (nx + nw + 2):
                                cs = _match_src(c.get("name") or c.get("id") or "")
                                if cs is not None and isinstance(cs.get("w"), (int, float)):
                                    cs["w"] = "fill"
                                    changes.append({"kind": "clamp-child-width-fill", "widget": c.get("name", "")})
                                    pass_changes += 1
            for c in children:
                _heal_walk(c)
            if pnode.get("type") == "dynamic-panel":
                for st in (pnode.get("states") or []):
                    st_t = st.get("tree") if isinstance(st, dict) else None
                    if isinstance(st_t, dict):
                        measure_node(st_t, base_dir=base_dir, available_w=pnode["_w"])
                        layout_node(st_t, 0, 0, pnode["_w"], pnode["_h"])
                        _heal_walk(st_t)

        _heal_walk(probe)
        if pass_changes == 0:
            break
    return changes


def _heal_property_changes(before, after, pointer=""):
    changes = []
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(before.keys() | after.keys()):
            path = pointer + "/" + str(key).replace("~", "~0").replace("/", "~1")
            changes.extend(_heal_property_changes(before.get(key), after.get(key), path))
    elif isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        for idx, (old, new) in enumerate(zip(before, after)):
            changes.extend(_heal_property_changes(old, new, pointer + "/" + str(idx)))
    elif before != after:
        changes.append({"pointer": pointer, "property": pointer.rsplit("/", 1)[-1], "from": before, "to": after})
    return changes


def compile_spec_bundle(spec_data, out_dir, theme_override=None, base_dir=None, no_interactions=False, strict_audit=False, source_path=None, ink_sink=None, auto_heal=False):
    """Treat automatic changes as a transaction, checked against the original gates."""
    import copy
    import tempfile
    options = dict(theme_override=theme_override, base_dir=base_dir,
                   no_interactions=no_interactions, strict_audit=strict_audit, source_path=source_path)
    enabled = bool(auto_heal and str(auto_heal).lower() not in ("false", "off", "0", "none"))
    if not enabled:
        return _compile_spec_bundle(spec_data, out_dir, ink_sink=ink_sink, **options)
    from rp_language import validate_source_tree
    validate_source_tree(spec_data)
    original = copy.deepcopy(spec_data)
    baseline = None
    with tempfile.TemporaryDirectory(prefix="zee-heal-gates-") as probe_dir:
        try:
            baseline = _compile_spec_bundle(copy.deepcopy(original), probe_dir, **options)
            baseline_audit = json.load(open(baseline["auditPath"], encoding="utf-8"))
        except LanguageError:
            baseline_audit = None
        rejected = []
        try:
            candidate_ink = [] if ink_sink is not None else None
            result = _compile_spec_bundle(copy.deepcopy(original), out_dir, ink_sink=candidate_ink,
                                         auto_heal=auto_heal, **options)
            audit = json.load(open(result["auditPath"], encoding="utf-8"))
            def failures(report):
                return {json.dumps(f, sort_keys=True, ensure_ascii=False) for f in report.get("failures", [])}
            if baseline_audit is not None:
                rejected = sorted(failures(audit) - failures(baseline_audit))
                if baseline.get("ok") and not result.get("ok") and not rejected:
                    rejected = ["A previously passing audit gate failed"]
        except LanguageError as error:
            if baseline is None:
                raise
            rejected = [error.diagnostic]
            result = None
        if rejected:
            changes = []
            if result:
                plan = json.load(open(result["planPath"], encoding="utf-8"))
                changes = plan.get("autoHeal", {}).get("changes", [])
            else:
                trial = copy.deepcopy(original)
                _auto_heal_spec_pre_compile(trial, strict_audit=strict_audit)
                changes = _heal_property_changes(original, trial)
            result = _compile_spec_bundle(copy.deepcopy(original), out_dir, ink_sink=ink_sink, **options)
            summary = {"mode": str(auto_heal), "healedCount": 0, "changes": [], "rolledBack": True,
                       "rejectedChanges": changes, "rejectedDiagnostics": rejected,
                       "validation": "all compile and audit gates rerun on original source"}
        else:
            if ink_sink is not None:
                ink_sink.extend(candidate_ink)
            plan = json.load(open(result["planPath"], encoding="utf-8"))
            summary = {**plan.get("autoHeal", {}), "rolledBack": False,
                       "validation": "all compile and audit gates compared with original source"}
        for key in ("planPath", "auditPath"):
            path = result[key]
            with open(path, encoding="utf-8") as handle:
                report = json.load(handle)
            report["autoHeal"] = summary
            if key == "planPath":
                report["audit"]["autoHeal"] = summary
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(report, handle, ensure_ascii=False, indent=2)
        result["audit"]["autoHeal"] = summary
        result["autoHeal"] = summary
        return result


def _compile_spec_bundle(spec_data, out_dir, theme_override=None, base_dir=None, no_interactions=False, strict_audit=False, source_path=None, ink_sink=None, auto_heal=False):
    STATE_PREVIEWS.clear()  # 每次编译先清空，避免跨次残留
    """通用声明式多页/多状态原型编译器：支持 --spec <spec.json>、数据绑定、静态模式与两级审计门禁。"""
    import copy
    os.makedirs(out_dir, exist_ok=True)
    heal_enabled = bool(auto_heal and str(auto_heal).lower() not in ("false", "off", "0", "none"))
    auto_heal_changes = []
    if heal_enabled:
        before_heal = copy.deepcopy(spec_data)
        _auto_heal_spec_pre_compile(spec_data, strict_audit=strict_audit)
        auto_heal_changes.extend(_heal_property_changes(before_heal, spec_data))
    raw_source_spec = copy.deepcopy(spec_data)
    language_ir = None
    if "language" in spec_data:
        spec_data, language_ir = compile_language(spec_data)
        with open(os.path.join(out_dir, "language-ir.json"), "w", encoding="utf-8") as f:
            json.dump(language_ir, f, ensure_ascii=False, indent=2)
    states_dir = os.path.join(out_dir, "states")
    os.makedirs(states_dir, exist_ok=True)

    theme_name = theme_override or spec_data.get("theme") or "mobile-lowfi"
    theme_dict = dict(THEMES.get(theme_name, THEMES["mobile-lowfi"]))
    if isinstance(spec_data.get("palette"), dict):
        for pk, pv in spec_data["palette"].items():
            theme_dict[str(pk).lstrip("$")] = str(pv)
    domain = spec_data.get("domain", "mobile" if theme_name.startswith("mobile-") else "web")
    is_static = bool(no_interactions or spec_data.get("static") or spec_data.get("noInteractions"))
    is_strict = bool(strict_audit or spec_data.get("strictAudit"))

    raw_pages = apply_detail_bindings(spec_data.get("pages") or [spec_data])
    known_page_names = [p.get("name", f"Page {i+1}") for i, p in enumerate(raw_pages)]

    raw_m = spec_data.get("masters") or {}
    master_defs = raw_m if isinstance(raw_m, dict) else {m["id"]: m for m in raw_m}
    master_plans = []

    page_plans = []
    page_audits = []
    all_previews = {}

    for idx, p_spec in enumerate(raw_pages):
        p_name = p_spec.get("name", f"Page {idx+1}")
        p_slug = p_spec.get("slug") or f"page-{idx+1}"
        dev_shell = p_spec.get("device")
        p_domain = p_spec.get("domain") or ("doc" if "doc" in p_slug else domain)
        page_static = bool(is_static or p_spec.get("static") or p_spec.get("noInteractions"))
        canvas = p_spec.get("canvas") or ({"w": 375, "h": 812} if dev_shell else {"w": 1440, "h": 900})
        cw, ch = int(canvas["w"]), int(canvas["h"])

        p_schema_warnings = []
        validate_node_schema(p_spec["root"], warnings_out=p_schema_warnings, path=f"{p_slug}.root", allow_fallback=bool(language_ir))
        if heal_enabled:
            before_heal = copy.deepcopy(p_spec["root"])
            _auto_heal_page_tree(p_spec["root"], cw, ch, p_slug, base_dir=base_dir)
            auto_heal_changes.extend({**change, "page": p_slug, "stage": "lowered-layout"} for change in
                                     _heal_property_changes(before_heal, p_spec["root"], f"/pages/{idx}/root"))

        root_main = expand_declarative_tree(copy.deepcopy(p_spec["root"]), prefix=p_slug)
        ensure_unique_names(root_main, scope_prefix=p_slug)
        measure_node(root_main, base_dir=base_dir, available_w=cw)
        layout_node(root_main, 0, 0, cw, ch)
        em_main = emit_tree_to_axvg(root_main, theme_dict, include_dynamic_panel_placeholders=False, base_dir=base_dir)
        if dev_shell:
            em_main = compose_device_shell(em_main, p_slug, shell_name=dev_shell)

        root_prev = expand_declarative_tree(copy.deepcopy(p_spec["root"]), prefix=p_slug)
        ensure_unique_names(root_prev, scope_prefix=p_slug)
        measure_node(root_prev, base_dir=base_dir, available_w=cw)
        layout_node(root_prev, 0, 0, cw, ch)
        em_prev = emit_tree_to_axvg(root_prev, theme_dict, include_dynamic_panel_placeholders=True, base_dir=base_dir)
        if dev_shell:
            em_prev = compose_device_shell(em_prev, p_slug, shell_name=dev_shell)

        master_node_names = set()
        adaptive_overrides = {}
        view_ids = {v.get("id", v.get("name")) for v in spec_data.get("adaptiveViews", [])}

        def collect_native_metadata(node, in_master=False, in_container=False):
            if not isinstance(node, dict):
                return
            in_master = False if node.get("_master_slot") else in_master or bool(node.get("_master_instance"))
            if in_master and node.get("name"):
                master_node_names.add(node["name"])
            if node.get("adaptive"):
                if in_master or in_container:
                    raise LanguageError("E_ADAPTIVE", "/adaptive", "adaptive overrides currently require page-level widgets outside masters/panels/repeaters")
                for view_id, props in node["adaptive"].items():
                    if view_id not in view_ids:
                        raise LanguageError("E_ADAPTIVE", "/adaptive/" + str(view_id), f"Unknown adaptive view: {view_id}")
                    if not isinstance(props, dict) or set(props) - {"x", "y", "w", "h"}:
                        raise LanguageError("E_PROPERTY", "/adaptive/" + str(view_id), "adaptive overrides support x/y/w/h")
                    if any(type(v) not in (int, float) or not math.isfinite(v) or (k in {"w", "h"} and v < 0) for k, v in props.items()):
                        raise LanguageError("E_ADAPTIVE", "/adaptive/" + str(view_id), "adaptive geometry must be finite numeric values with nonnegative sizes")
                adaptive_overrides[node["name"]] = copy.deepcopy(node["adaptive"])
            for child in node.get("children", []):
                collect_native_metadata(child, in_master, in_container)
            for state in node.get("states", []):
                collect_native_metadata(state.get("root"), in_master, True)
            if isinstance(node.get("template"), dict):
                collect_native_metadata(node["template"], in_master, True)
            if node.get("_master_instance") and not any(m["id"] == node["_master_instance"] for m in master_plans):
                mid = node["_master_instance"]
                m_tree = copy.deepcopy(node)
                m_tree.pop("_master_instance")
                mw, mh = int(node["_w"]), int(node["_h"])
                layout_node(m_tree, 0, 0, mw, mh)
                def remove_slots(parent):
                    parent["children"] = [c for c in parent.get("children", []) if not c.get("_master_slot")]
                    for child in parent["children"]:
                        remove_slots(child)
                remove_slots(m_tree)
                em_m = emit_tree_to_axvg(m_tree, theme_dict, canvas_background=False, base_dir=base_dir)
                if em_m["dynamicPanels"] or em_m["repeaters"]:
                    raise LanguageError("E_MASTER", "/masters/" + str(mid), "RP/1 masters currently require primitive content; nested panels/repeaters are not supported")
                m_path = os.path.join(states_dir, f"master__{mid}.axvg.json")
                with open(m_path, "w", encoding="utf-8") as f:
                    json.dump(em_m["axvg"], f, ensure_ascii=False, indent=2)
                names = {c["name"] for c in em_m["flatChildren"]} | {n["name"] for n in em_m["nativeInputs"]}
                master_plans.append({"id": mid, "name": master_defs[mid].get("name", mid), "w": mw, "h": mh,
                    "axvgPath": m_path, "nativeInputs": em_m["nativeInputs"],
                    "interactions": [ix for ix in p_spec.get("interactions", []) if ix["trigger"] in names]})

        collect_native_metadata(root_main)
        p_axvg_path = os.path.join(out_dir, f"{p_slug}.axvg.json")
        p_spec_path = os.path.join(out_dir, f"{p_slug}.spec.json")
        with open(p_axvg_path, "w", encoding="utf-8") as f:
            json.dump(em_main["axvg"], f, ensure_ascii=False, indent=2)
        with open(p_spec_path, "w", encoding="utf-8") as f:
            json.dump(em_main["spec"], f, ensure_ascii=False, indent=2)

        page_scenes = []

        def container_stages(emitted, tag):
            panels, lists = [], []
            for dp in emitted["dynamicPanels"]:
                states = []
                for i, state in enumerate(dp["states"]):
                    state_prefix = state.get("prefix") or state["name"]
                    state_tag = f"{tag}__{dp['name']}__{state_prefix}"
                    canvas = state.get("canvas") or ({"w": 375, "h": 812} if state.get("device") else {"w": dp["w"], "h": dp["h"]})
                    entry = compile_stage(state["tree"], state_tag, canvas, device=state.get("device"), prefix=state_prefix,
                                          kind="panel-state", parent_scene=tag, panel=dp["name"], state=state["name"])
                    states.append({**entry, "name": state["name"], "prefix": state.get("prefix", state_tag)})
                panels.append({k: dp[k] for k in ("name", "x", "y", "w", "h")} | {"states": states})
            for rep in emitted.get("repeaters", []):
                row = compile_stage(rep["template"], f"{tag}__{rep['name']}__item", {"w": rep["w"], "h": rep["rowHeight"]},
                                    kind="repeater-template", parent_scene=tag, repeater=rep["name"])
                lists.append({k: rep[k] for k in ("name", "x", "y", "w", "h", "rowGap", "rowHeight", "pageSize", "model", "rows")} | {"item": row})
            return panels, lists

        def compile_stage(tree, tag, stage_canvas, device=None, prefix=None, kind="panel-state", parent_scene=None, **context):
            scene = {"id": tag, "page": p_name, "kind": kind, "scope": "container-local", "parentSceneId": parent_scene,
                     "canvas": stage_canvas, "status": "not-run", **context}
            page_scenes.append(scene)
            stage_tree = copy.deepcopy(tree)
            if kind == "modal":
                stage_tree.pop("isModal", None)
                stage_tree.pop("x", None)
                stage_tree.pop("y", None)
            ensure_unique_names(stage_tree, scope_prefix=tag)
            sw, sh = int(stage_canvas["w"]), int(stage_canvas["h"])
            measure_node(stage_tree, base_dir=base_dir, available_w=sw)
            layout_node(stage_tree, 0, 0, sw, sh)
            emitted = emit_tree_to_axvg(stage_tree, theme_dict, include_dynamic_panel_placeholders=False, base_dir=base_dir, canvas_background=False)
            preview = emit_tree_to_axvg(copy.deepcopy(stage_tree), theme_dict, include_dynamic_panel_placeholders=True, base_dir=base_dir, canvas_background=False)
            panels, repeaters = container_stages(emitted, tag)
            if device:
                emitted = compose_device_shell(emitted, prefix or tag, shell_name=device)
                preview = compose_device_shell(preview, prefix or tag, shell_name=device)
                sw, sh = emitted["device"]["w"], emitted["device"]["h"]
            axvg_path = os.path.join(states_dir, f"{tag}.axvg.json")
            spec_path = os.path.join(states_dir, f"{tag}.spec.json")
            _stable_tag = re.sub(r"-[0-9a-f]{8,}", "", str(tag))  # 去掉原生 hash 后缀，便于稳定引用
            png_path = os.path.join(states_dir, f"{_stable_tag}@2x.png")
            STATE_PREVIEWS.append({
                "page": str(tag).split("__")[0],
                "scene": str(tag),
                "stable": _stable_tag,
                "png": png_path,
                "panel": context.get("panel"),
                "state": context.get("state"),
                "repeater": context.get("repeater"),
                "modal": context.get("modal"),
                "viewport": {"w": int(stage_canvas["w"]), "h": int(stage_canvas["h"])},
                "content": {"w": int(stage_tree.get("_mw", sw)), "h": int(stage_tree.get("_mh", sh))},
            })
            with open(axvg_path, "w", encoding="utf-8") as f: json.dump(emitted["axvg"], f, ensure_ascii=False, indent=2)
            with open(spec_path, "w", encoding="utf-8") as f: json.dump(emitted["spec"], f, ensure_ascii=False, indent=2)
            render_flat_children_png(sw, sh, resolve_color("$surface", theme_dict), preview["flatChildren"], include_modal=False, scale=2).save(png_path)
            scene["audit"] = audit_prototype(stage_tree, preview, {
                "pageName": p_name, "language": "rp/1" if language_ir else None,
                "domain": p_domain, "theme": theme_name, "dynamicPanels": panels, "auditScope": "container-local",
                "repeaters": repeaters, "allMainWidgets": emitted["flatChildren"],
                "nativeInputs": emitted["nativeInputs"], "schemaWarnings": [],
            }, strict_audit=is_strict)
            scene.update({"axvgPath": axvg_path, "specPath": spec_path, "pngPath": png_path})
            compile_modal_scenes(stage_tree, tag)
            return {"sceneId": tag, "audit": scene["audit"], "axvgPath": axvg_path, "specPath": spec_path, "pngPath": png_path,
                    "widgetNames": [c["name"] for c in emitted["flatChildren"]], "nativeInputs": emitted["nativeInputs"],
                    "dynamicPanels": panels, "repeaters": repeaters}

        def compile_modal_scenes(tree, tag):
            for child in tree.get("children", []):
                if child.get("isModal"):
                    compile_stage(child, f"{tag}__{child['name']}__modal", {"w": child["_w"], "h": child["_h"]},
                                  kind="modal", parent_scene=tag, modal=child["name"])
                else:
                    compile_modal_scenes(child, tag)

        page_scene = {"id": p_slug, "page": p_name, "kind": "page-default", "scope": "page",
                      "canvas": {"w": cw, "h": ch}, "status": "not-run"}
        page_scenes.append(page_scene)
        dp_plans, repeater_plans = container_stages(em_main, p_slug)
        compile_modal_scenes(root_main, p_slug)
        preview_flat = list(em_prev["flatChildren"])
        if ink_sink is not None:
            _rows = []
            for _ch in preview_flat:
                if _ch.get("kind") not in ("text", "para") and not _ch.get("text"):
                    continue
                try:
                    _font, _tx, _ty, _ink = text_ink_geometry(dict(_ch))
                except Exception:
                    continue
                _rows.append({"name": _ch.get("name") or _ch.get("id"),
                              "box": [_ch.get("x"), _ch.get("y"), _ch.get("w"), _ch.get("h")],
                              "ink": [round(v, 1) for v in _ink],
                              "inkBottom": round(_ink[1] + _ink[3], 1),
                              "inkRight": round(_ink[0] + _ink[2], 1),
                              "safeNextY": round(_ink[1] + _ink[3] + max(2, int(round(float(_ch.get("size", 13)) * 0.5))), 1),
                              "safeNextX": round(_ink[0] + _ink[2] + max(2, int(round(float(_ch.get("size", 13)) * 0.3))), 1)})
            ink_sink.append({"page": p_name, "slug": p_slug, "widgets": _rows,
                             "canvas": {"w": cw, "h": ch},
                             "offset": {"x": int(em_main.get("device", {}).get("screenX", 0)),
                                        "y": int(em_main.get("device", {}).get("screenY", 0))}})

        out_w = em_main["device"]["w"] if em_main.get("device") else cw
        out_h = em_main["device"]["h"] if em_main.get("device") else ch
        bg_hex = "#FFFFFF" if em_main.get("device") else resolve_color(root_main.get("fill", "$bg"), theme_dict)
        img_2x = render_flat_children_png(out_w, out_h, bg_hex, preview_flat, include_modal=False, scale=2)
        p_prev_path = os.path.join(out_dir, f"{p_slug}@2x.png")
        img_2x.save(p_prev_path)
        img_1x = render_flat_children_png(out_w, out_h, bg_hex, preview_flat, include_modal=False, scale=1)
        dx = em_main["device"]["screenX"] if em_main.get("device") else 0
        dy = em_main["device"]["screenY"] if em_main.get("device") else 0
        img_struct = render_structure_overlay_png(img_1x, root_prev, em_main["dynamicPanels"], dx=dx, dy=dy)
        p_struct_path = os.path.join(out_dir, f"{p_slug}-structure.png")
        img_struct.save(p_struct_path)

        if idx == 0:
            p01 = os.path.join(out_dir, "01-preview.png")
            p02 = os.path.join(out_dir, "02-structure.png")
            img_2x.save(p01)
            img_struct.save(p02)
            all_previews["preview"] = p01
            all_previews["structure"] = p02

        all_previews[p_slug] = {"preview2x": p_prev_path, "structure": p_struct_path}
        p_interactions = [] if page_static else [ix for ix in p_spec.get("interactions", []) if ix["trigger"] not in master_node_names]

        p_plan = {
            "pageName": p_name,
            "slug": p_slug,
            "language": "rp/1" if language_ir else None,
            "theme": theme_name,
            "domain": p_domain,
            "static": page_static,
            "device": em_main.get("device"),
            "canvas": {"w": out_w, "h": out_h},
            "mainAxvgPath": p_axvg_path,
            "mainSpecPath": p_spec_path,
            "dynamicPanels": dp_plans,
            "repeaters": repeater_plans,
            "nativeInputs": em_main["nativeInputs"],
            "modalTargets": em_main["modalTargets"],
            "allMainWidgets": em_main["flatChildren"],
            "interactions": p_interactions,
            "masters": em_main["masterInstances"],
            "adaptiveOverrides": adaptive_overrides,
            "knownPageNames": known_page_names,
            "schemaWarnings": p_schema_warnings,
            "sourceSymbols": [s for s in language_ir["symbols"] if s["pageId"] == p_slug] if language_ir else [],
            "previews": {"preview2x": p_prev_path, "structure": p_struct_path},
        }
        page_scene["audit"] = audit_prototype(root_prev, em_prev, p_plan, strict_audit=is_strict)
        page_scene.update({"axvgPath": p_axvg_path, "specPath": p_spec_path, "pngPath": p_prev_path})
        p_audit = summarize_scene_audits(page_scenes, strict_audit=is_strict)
        p_plan["scenes"] = page_scenes
        p_plan["sceneCoverage"] = p_audit["sceneCoverage"]
        p_plan["audit"] = p_audit
        page_plans.append(p_plan)
        # 给本页每条 failure 注入 page 字段，便于跨页定位
        for _f in (p_audit.get("failures") or []):
            _f["page"] = p_name
        page_audits.append({
            "pageName": p_name,
            "slug": p_slug,
            "theme": theme_name,
            "domain": p_domain,
            "device": em_main.get("device"),
            "canvas": {"w": out_w, "h": out_h},
            "static": page_static,
            **p_audit,
        })

    # Stitch multi-page contact sheet and panel/repeater states sheet for single-shot visual inspection
    page_sheet_items = [
        {"label": f"[{pp['slug']}] {pp['pageName']}", "path": pp["previews"]["preview2x"]}
        for pp in page_plans
        if isinstance(pp.get("previews"), dict) and pp["previews"].get("preview2x")
    ]
    if page_sheet_items:
        pages_sheet_path = os.path.join(out_dir, "pages-sheet.png")
        if render_contact_sheet_png(page_sheet_items, pages_sheet_path, max_cols=4, max_thumb_h=640, max_thumb_w=460, title="Pages Overview"):
            all_previews["contactSheet"] = pages_sheet_path
    if STATE_PREVIEWS:
        def _fmt_state_sheet_label(sp):
            pg = str(sp.get("page") or "page")
            if sp.get("panel") and sp.get("state"):
                clean_p = re.sub(r"-[0-9a-f]{6,}", "", str(sp["panel"]))
                if clean_p.startswith(f"{pg}__"):
                    clean_p = clean_p[len(pg) + 2:]
                vp, content = sp.get("viewport", {}), sp.get("content", {})
                dimensions = f" · {vp.get('w')}×{vp.get('h')} / content {content.get('h')}px" if vp else ""
                return f"[{pg}] {clean_p} : {sp['state']}{dimensions}"
            if sp.get("repeater"):
                clean_r = re.sub(r"-[0-9a-f]{6,}", "", str(sp["repeater"]))
                if clean_r.startswith(f"{pg}__"):
                    clean_r = clean_r[len(pg) + 2:]
                return f"[{pg}] {clean_r} (item)"
            if sp.get("modal"):
                clean_m = re.sub(r"-[0-9a-f]{6,}", "", str(sp["modal"]))
                return f"[{pg}] {clean_m} (modal)"
            return sp.get("stable") or sp.get("scene") or "state"

        state_sheet_items = [
            {"label": _fmt_state_sheet_label(sp), "path": sp.get("png")}
            for sp in STATE_PREVIEWS
            if sp.get("png") and not (
                re.sub(r"-[0-9a-f]{6,}", "", str(sp.get("panel") or "")).endswith("_fill")
                and re.fullmatch(r"s\d+", str(sp.get("state") or ""))
            )
        ]
        if state_sheet_items:
            states_sheet_path = os.path.join(out_dir, "states-sheet.png")
            if render_contact_sheet_png(state_sheet_items, states_sheet_path, max_cols=4, max_thumb_h=480, max_thumb_w=420, title="Container States Overview"):
                all_previews["statesSheet"] = states_sheet_path

    overall_ok = all(pa["ok"] for pa in page_audits)
    overall_structural_ok = all(pa["structural_ok"] for pa in page_audits)
    overall_aesthetic_ok = all(pa["aesthetic_ok"] for pa in page_audits)
    all_warnings = []
    # 光效样式（gradient/shadow/aurora/noise）会被"光效层"渲染成嵌入位图，再以 ImageBox 写入原生，
    # 因此不是"预览专属"；只有 backdropBlur 采样的是静态背景，叠在动态内容上会失真，需要提示。
    _backdrop_hits = {}
    _misplaced = {}

    def _scan_backdrop(node, page_name, parent_layout=None):
        if isinstance(node, dict):
            if parent_layout:
                node.setdefault("_layoutParent", parent_layout)
            if node.get("backdropBlur"):
                _backdrop_hits.setdefault(page_name, 0)
                _backdrop_hits[page_name] += 1
            if node.get("after") or node.get("alignX"):
                _constraint_parent = node.get("_layoutParent")
                if _constraint_parent and _constraint_parent != "stack":
                    _misplaced.setdefault(page_name, 0)
                    _misplaced[page_name] += 1
            _own_layout = node.get("layout")
            for key, value in node.items():
                _scan_backdrop(value, page_name, _own_layout if isinstance(value, dict) or isinstance(value, list) else None)
        elif isinstance(node, list):
            for value in node:
                _scan_backdrop(value, page_name, parent_layout)

    for _pg in (spec_data.get("pages") or []) if isinstance(spec_data, dict) else []:
        if isinstance(_pg, dict):
            _scan_backdrop(_pg.get("root"), _pg.get("name") or _pg.get("id") or "page")
    for _page_name, _cnt in _misplaced.items():
        all_warnings.append(
            f"[{_page_name}] constraint_outside_stack: {_cnt} 个元件在非 stack 容器里用了 after/alignX，"
            "这两个约束只对 layout:\"stack\" 的父容器生效；flow 容器请用 row/column 顺序或 gap")
    for _page_name, _cnt in _backdrop_hits.items():
        all_warnings.append(
            f"[{_page_name}] backdrop_blur_static: {_cnt} 个元件使用 backdropBlur；原生以静态背景采样成图，"
            "叠在会变化的内容上会失真，改用半透明实色更稳")
    for pa in page_audits:
        for w_msg in pa.get("warnings", []):
            all_warnings.append(f"[{pa['pageName']}] {w_msg}")

    first_page = page_plans[0]
    compile_plan = {
        "name": spec_data.get("name", first_page["pageName"]),
        "domain": domain,
        "theme": theme_name,
        "static": is_static,
        "strictAudit": is_strict,
        "pageCount": len(page_plans),
        "pages": page_plans,
        "masters": master_plans,
        "adaptiveViews": copy.deepcopy(spec_data.get("adaptiveViews") or []),
        # 兼容单页字段读取
        "pageName": first_page["pageName"],
        "canvas": first_page["canvas"],
        "mainAxvgPath": first_page["mainAxvgPath"],
        "mainSpecPath": first_page["mainSpecPath"],
        "dynamicPanels": first_page["dynamicPanels"],
        "nativeInputs": first_page["nativeInputs"],
        "modalTargets": first_page["modalTargets"],
        "allMainWidgets": first_page["allMainWidgets"],
        "interactions": first_page["interactions"],
        "previews": all_previews,
    }
    # 顶层 metrics 由 pages 按物理面积/总检查项数精确加权聚合（P3-2）
    _SUM_KEYS = (
        "text_overlap_count", "text_clip_count", "missing_glyph_count",
        "kinsoku_violation_count", "container_overflow_count", "box_overlap_count",
        "declared_position_mismatch_count",
        "duplicate_name_count", "interaction_dangling_targets",
    )
    agg_metrics = {}
    for _k in _SUM_KEYS:
        agg_metrics[_k] = sum(int(pa["metrics"].get(_k, 0) or 0) for pa in page_audits)
    agg_metrics["alignment_error_px"] = max((pa["metrics"].get("alignment_error_px", 0.0) or 0.0) for pa in page_audits) if page_audits else 0.0

    # 按总检查项数/总节点数加权聚合百分比指标（避免大画布页与小卡片页简单算术平均失真）
    tot_sp_pass = sum(int((pa.get("_weights") or {}).get("spacing_passed", 0)) for pa in page_audits)
    tot_sp_all = sum(int((pa.get("_weights") or {}).get("spacing_total", 0)) for pa in page_audits)
    agg_metrics["spacing_compliance_pct"] = round(100.0 * tot_sp_pass / tot_sp_all, 2) if tot_sp_all > 0 else None

    tot_fn_pass = sum(int((pa.get("_weights") or {}).get("font_passed", 0)) for pa in page_audits)
    tot_fn_all = sum(int((pa.get("_weights") or {}).get("font_total", 0)) for pa in page_audits)
    agg_metrics["font_compliance_pct"] = round(100.0 * tot_fn_pass / tot_fn_all, 2) if tot_fn_all > 0 else None

    tot_sem_nodes = sum(int((pa.get("_weights") or {}).get("semantic_nodes", 0)) for pa in page_audits)
    tot_grp_nodes = sum(int((pa.get("_weights") or {}).get("grouped_nodes", 0)) for pa in page_audits)
    tot_all_nodes = sum(int((pa.get("_weights") or {}).get("total_nodes", 0)) for pa in page_audits)
    tot_group_nodes = sum(int((pa.get("_weights") or {}).get("group_total", 0)) for pa in page_audits)
    agg_metrics["semantic_naming_pct"] = round(100.0 * tot_sem_nodes / tot_all_nodes, 2) if tot_all_nodes > 0 else None
    agg_metrics["group_coverage_pct"] = round(100.0 * tot_grp_nodes / tot_group_nodes, 2) if tot_group_nodes > 0 else None

    four_applicable = sum(pa.get("coverage", {}).get("fourState", {}).get("applicable", 0) for pa in page_audits)
    four_passed = sum(pa.get("coverage", {}).get("fourState", {}).get("passed", 0) for pa in page_audits)
    agg_metrics["four_state_coverage_pct"] = round(100.0 * four_passed / four_applicable, 2) if four_applicable else None

    # 留白率：按各页画布像素面积 (canvas_area) 加权，并同時输出跨页留白率区间 [min, max]
    tot_area = sum(float((pa.get("_weights") or {}).get("canvas_area", 0.0)) for pa in page_audits)
    tot_fg = sum(float((pa.get("_weights") or {}).get("fg_pixels", 0.0)) for pa in page_audits)
    _ws_vals = [float(pa["metrics"].get("whitespace_ratio_pct", 0.0) or 0.0) for pa in page_audits]
    if tot_area > 0:
        agg_metrics["whitespace_ratio_pct"] = round(100.0 * (1.0 - tot_fg / tot_area), 2)
    else:
        agg_metrics["whitespace_ratio_pct"] = round(sum(_ws_vals) / len(_ws_vals), 2) if _ws_vals else 0.0
    agg_metrics["whitespace_ratio_range"] = [round(min(_ws_vals), 2), round(max(_ws_vals), 2)] if _ws_vals else [0.0, 0.0]

    agg_metrics["color_count"] = max((int(pa["metrics"].get("color_count", 0) or 0) for pa in page_audits), default=0)
    agg_metrics["duplicate_names"] = [n for pa in page_audits for n in (pa["metrics"].get("duplicate_names") or [])]
    for pa in page_audits:
        pa.pop("_weights", None)
    # 结构门禁：全部页通过才算通过（与 overall_structural_ok 语义一致）
    agg_structural = {k: all(pa["structural_gates"].get(k, True) for pa in page_audits) for k in (page_audits[0]["structural_gates"] if page_audits else {})}
    agg_aesthetic = {k: all(pa["aesthetic_gates"].get(k, True) for pa in page_audits) for k in (page_audits[0]["aesthetic_gates"] if page_audits else {})}
    agg_failures = [f for pa in page_audits for f in (pa.get("failures") or [])]
    combined_audit = {
        "ok": overall_ok,
        "structural_ok": overall_structural_ok,
        "aesthetic_ok": overall_aesthetic_ok,
        "strict_audit": is_strict,
        "static": is_static,
        "warnings": all_warnings,
        "statePreviews": list(STATE_PREVIEWS),
        "pageCount": len(page_audits),
        "metrics": agg_metrics,
        "structural_gates": agg_structural,
        "aesthetic_gates": agg_aesthetic,
        "gates": {**agg_aesthetic, **agg_structural},
        "failures": agg_failures,
        "pages": page_audits,
    }
    all_scenes = [scene for page in page_plans for scene in page.get("scenes", [])]
    scene_summary = summarize_scene_audits(all_scenes, strict_audit=is_strict)
    for key in ("scenes", "sceneCoverage", "metricScope"):
        combined_audit[key] = scene_summary[key]
    combined_audit["coverage"] = scene_summary["coverage"]
    compile_plan["scenes"] = all_scenes
    compile_plan["sceneCoverage"] = scene_summary["sceneCoverage"]
    compile_plan["audit"] = combined_audit
    compile_plan["sourceSpec"] = raw_source_spec
    if heal_enabled:
        heal_summary = {
            "mode": str(auto_heal),
            "healedCount": len(auto_heal_changes),
            "changes": auto_heal_changes,
            "needsDecision": [f for f in agg_failures if f.get("gate") not in ("no_text_clip", "no_container_overflow")],
        }
        compile_plan["autoHeal"] = heal_summary
        combined_audit["autoHeal"] = heal_summary
    if source_path:
        compile_plan["sourcePath"] = source_path
    if language_ir:
        compile_plan["language"] = "rp/1"
        compile_plan["variables"] = language_ir["variables"]
        compile_plan["sourceMap"] = language_ir["symbols"]
        compile_plan["semanticHash"] = language_ir["semanticHash"]

    plan_path = os.path.join(out_dir, "compile-plan.json")
    audit_path = os.path.join(out_dir, "audit-report.json")
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump(compile_plan, f, ensure_ascii=False, indent=2)
    with open(audit_path, "w", encoding="utf-8") as f:
        json.dump(combined_audit, f, ensure_ascii=False, indent=2)
    return {
        "ok": overall_ok,
        "structural_ok": overall_structural_ok,
        "aesthetic_ok": overall_aesthetic_ok,
        "warnings": all_warnings,
        "outDir": out_dir,
        "theme": theme_name,
        "static": is_static,
        "pageCount": len(page_plans),
        "planPath": plan_path,
        "auditPath": audit_path,
        "previews": all_previews,
        "audit": combined_audit,
    }


def run_selftest():
    import tempfile
    results = []
    # 1~3. Web 旗舰工作台三套主题
    for th in ("enterprise-light", "modern-dark", "cobalt-pro"):
        with tempfile.TemporaryDirectory(prefix=f"proto-selftest-{th}-") as td:
            res = compile_prototype_bundle(td, theme_name=th)
            if not res["ok"]:
                raise RuntimeError(f"Selftest failed on theme {th}: {json.dumps(res['audit'], ensure_ascii=False)}")
            results.append({"preset": "web-dashboard", "theme": th, "metrics": res["audit"]["metrics"]})
    # 4~5. Mobile 多页带壳两套主题 (mobile-lowfi / mobile-hifi)
    for mob_th in ("mobile-lowfi", "mobile-hifi"):
        with tempfile.TemporaryDirectory(prefix=f"proto-selftest-{mob_th}-") as td:
            mob_spec = build_mobile_lostfound_spec()
            res_mob = compile_spec_bundle(mob_spec, td, theme_override=mob_th)
            if not res_mob["ok"]:
                raise RuntimeError(f"Selftest failed on {mob_th}: {json.dumps(res_mob['audit'], ensure_ascii=False)}")
            results.append({
                "preset": "mobile-lostfound",
                "theme": mob_th,
                "pageCount": res_mob["pageCount"],
                "metrics": res_mob["audit"]["metrics"],
            })
    # 6. 自定义小画布玩具页 (375×400, 非令牌间距 gap=5)：验证两级门禁默认通过并发出审美告警，--strict-audit 下拦截
    toy_spec = {
        "name": "Toy Custom Primitives Test",
        "theme": "mobile-lowfi",
        "static": True,
        "pages": [
            {
                "name": "测试页",
                "slug": "toy-page",
                "canvas": {"w": 375, "h": 400},
                "root": {
                    "type": "box",
                    "name": "grp-toy-root",
                    "layout": "column",
                    "w": 375,
                    "h": 400,
                    "padding": 16,
                    "gap": 5,
                    "fill": "$bg",
                    "isGroup": True,
                    "bgName": "bg-toy-root",
                    "children": [
                        {"type": "label", "name": "txt-toy-title", "text": "自定义原语与两级门禁自检", "fontSize": 16, "fontWeight": 700, "color": "$ink"},
                        {"type": "button", "name": "btn-toy-act", "text": "确定提交", "variant": "primary", "w": 120, "h": 36, "radius": 8},
                    ],
                },
            }
        ],
    }
    with tempfile.TemporaryDirectory(prefix="proto-selftest-toy-") as td:
        res_toy = compile_spec_bundle(toy_spec, td, strict_audit=False)
        if not res_toy["ok"] or not res_toy["structural_ok"] or not res_toy["warnings"]:
            raise RuntimeError(f"Selftest failed on toy-page default mode: {json.dumps(res_toy['audit'], ensure_ascii=False)}")
        res_toy_strict = compile_spec_bundle(toy_spec, td, strict_audit=True)
        if res_toy_strict["ok"]:
            raise RuntimeError("Selftest failed: toy-page with gap=5 should fail under strict_audit=True")
        results.append({
            "preset": "custom-primitives-toy",
            "theme": "mobile-lowfi",
            "pageCount": 1,
            "warningsCount": len(res_toy["warnings"]),
            "strictBlocked": not res_toy_strict["ok"],
            "metrics": res_toy["audit"]["metrics"],
        })
    # 7. 验证 dump-spec --preset web-dashboard 导出的 spec 可直接通过 compile_spec_bundle 零错误编译 (P0-3)
    with tempfile.TemporaryDirectory(prefix="proto-selftest-webspec-") as td:
        web_spec = build_web_dashboard_spec()
        res_web_spec = compile_spec_bundle(web_spec, td)
        if not res_web_spec["ok"] or not res_web_spec["structural_ok"] or not res_web_spec["aesthetic_ok"]:
            raise RuntimeError(f"Selftest failed on build_web_dashboard_spec: {json.dumps(res_web_spec['audit'], ensure_ascii=False)}")
        results.append({
            "preset": "web-dashboard-spec-roundtrip",
            "theme": res_web_spec["theme"],
            "pageCount": res_web_spec["pageCount"],
            "metrics": res_web_spec["audit"]["metrics"],
        })
    return {"ok": True, "themesTested": len(results), "results": results}


def build_web_dashboard_spec(title_override=None):
    """导出 web-dashboard 预设的完整声明式 spec.json 模板（含高层 sidebar/topbar/kpi-card、三态趋势图、四态表格、新建弹窗与完整交互）。"""
    title_str = title_override or "菜品与实时库存管理工作台"
    trend_states = [
        {
            "name": "orders",
            "label": "订单趋势",
            "prefix": "orders",
            "root": expand_chart_state(
                "orders",
                "近 7 日门店堂食与外卖订单量趋势",
                "峰值出现在周六晚高峰 (1,480 单/日) · 环比上周 +14.2%",
                ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
                [860, 920, 1040, 980, 1260, 1480, 1350],
                unit="单",
                accent="$brand",
                mode="bar",
            ),
        },
        {
            "name": "revenue",
            "label": "营收趋势",
            "prefix": "revenue",
            "root": expand_chart_state(
                "revenue",
                "近 7 日门店实收营业额走势 (千元)",
                "实收毛利率稳定在 68.4% · 客单价均值 ¥ 64.50",
                ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
                [52, 58, 64, 61, 79, 96, 88],
                unit="k",
                accent="$accent",
                mode="line",
            ),
        },
        {
            "name": "category",
            "label": "品类占比",
            "prefix": "category",
            "root": expand_chart_state(
                "category",
                "核心菜品品类销量与营收贡献占比",
                "川湘招牌与主厨轻食合计贡献 66% 核心营收",
                ["川湘招牌菜", "主厨能量碗", "特色炭烤类", "鲜果甜品饮品"],
                [38, 28, 20, 14],
                unit="%",
                accent="$success",
                mode="rank",
            ),
        },
    ]
    table_four = expand_table_four_states(w=1184, h=336)
    table_states = [
        {"name": "default", "label": "默认列表态", "prefix": "tbl-def", "root": table_four["default"]},
        {"name": "empty", "label": "空数据态", "prefix": "tbl-emp", "root": table_four["empty"]},
        {"name": "loading", "label": "骨架加载态", "prefix": "tbl-load", "root": table_four["loading"]},
        {"name": "error", "label": "接口异常态", "prefix": "tbl-err", "root": table_four["error"]},
    ]
    middle_row = make_box(
        "grp-middle-section",
        layout="row",
        w=1184,
        h=272,
        gap=16,
        isGroup=True,
        children=[
            make_box(
                "grp-card-trend",
                layout="column",
                w=744,
                h=272,
                padding=[12, 0],
                gap=8,
                fill="$surface",
                stroke="$line",
                radius=8,
                isGroup=True,
                bgName="bg-card-trend",
                children=[
                    make_box(
                        "grp-trend-toolbar",
                        layout="row",
                        w=744,
                        h=32,
                        padding=[0, 16],
                        align="center",
                        gap=8,
                        isGroup=True,
                        children=[
                            make_label("txt-trend-card-title", "经营核心指标分时分析", size=15, weight=700, color="$ink", flex=1),
                            make_button("tab-trend-orders", "订单趋势", variant="primary", w=88, h=28, size=12, radius=6),
                            make_button("tab-trend-revenue", "营收趋势", variant="outline", w=88, h=28, size=12, radius=6),
                            make_button("tab-trend-category", "品类占比", variant="outline", w=88, h=28, size=12, radius=6),
                        ],
                    ),
                    {
                        "type": "dynamic-panel",
                        "name": "panel-trend",
                        "w": 744,
                        "h": 216,
                        "states": trend_states,
                    },
                ],
            ),
            expand_notice_card(w=424, h=272),
        ],
    )
    table_section = make_box(
        "grp-table-section",
        layout="column",
        w=1184,
        h=396,
        padding=[12, 0],
        gap=8,
        fill="$surface",
        stroke="$line",
        radius=8,
        isGroup=True,
        bgName="bg-table-section",
        children=[
            make_box(
                "grp-table-toolbar",
                layout="row",
                w=1184,
                h=36,
                padding=[0, 16],
                gap=8,
                align="center",
                isGroup=True,
                children=[
                    make_label("txt-table-sec-title", "门店菜品与实时库存明细", size=15, weight=700, color="$ink"),
                    make_button("txt-state-indicator", "当前视图：默认列表态 (Default)", variant="soft", w=216, h=26, size=11, radius=999),
                    make_box("sp-toolbar-flex", layout="stack", w=16, h=12, flex=1, isGroup=False, children=[]),
                    make_label("lbl-state-switch", "四态视图切换：", size=12, weight=500, color="$ink-2"),
                    make_button("btn-state-default", "默认列表 (Default)", variant="primary", w=128, h=28, size=11, radius=6),
                    make_button("btn-state-empty", "空状态 (Empty)", variant="outline", w=112, h=28, size=11, radius=6),
                    make_button("btn-state-loading", "加载态 (Loading)", variant="outline", w=120, h=28, size=11, radius=6),
                    make_button("btn-state-error", "异常态 (Error)", variant="outline", w=112, h=28, size=11, radius=6),
                ],
            ),
            {
                "type": "dynamic-panel",
                "name": "panel-table",
                "w": 1184,
                "h": 336,
                "states": table_states,
            },
        ],
    )
    modal_node = expand_modal_new_dish(canvas_w=1440, canvas_h=900)
    return {
        "name": title_str,
        "domain": "web",
        "theme": "enterprise-light",
        "static": False,
        "pages": [{
            "name": "Page 1",
            "slug": "dashboard",
            "canvas": {"w": 1440, "h": 900},
            "root": {
                "type": "box",
                "name": "Page 1",
                "layout": "stack",
                "w": 1440,
                "h": 900,
                "fill": "$bg",
                "isGroup": False,
                "children": [
                    {
                        "type": "box",
                        "name": "grp-app-shell",
                        "layout": "row",
                        "x": 0,
                        "y": 0,
                        "w": 1440,
                        "h": 900,
                        "gap": 0,
                        "isGroup": True,
                        "children": [
                            {
                                "type": "sidebar",
                                "id": "main",
                                "w": 208,
                                "h": 900,
                                "brandTitle": "Supermancall",
                                "brandSubtitle": "智慧餐饮经营系统 v4.2",
                                "items": [
                                    {"id": "overview", "label": "经营数据总览", "active": False},
                                    {"id": "dishes", "label": "菜品与库存管理", "active": True, "badge": "58"},
                                    {"id": "orders", "label": "全渠道实时订单", "active": False, "badge": "12"},
                                    {"id": "members", "label": "会员营销与储值", "active": False},
                                    {"id": "supply", "label": "中央厨房供应链", "active": False},
                                    {"id": "settings", "label": "门店与权限设置", "active": False},
                                ],
                            },
                            {
                                "type": "box",
                                "name": "grp-main-area",
                                "layout": "column",
                                "w": 1232,
                                "h": 900,
                                "gap": 0,
                                "isGroup": True,
                                "children": [
                                    {
                                        "type": "topbar",
                                        "id": "main",
                                        "w": 1232,
                                        "h": 64,
                                        "title": title_str,
                                        "subtitle": "支持多维趋势切换、表格四态预览 (Default / Empty / Loading / Error) 与新建菜品表单非空校验",
                                    },
                                    {
                                        "type": "box",
                                        "name": "grp-content-body",
                                        "layout": "column",
                                        "w": 1232,
                                        "h": 836,
                                        "padding": [16, 24],
                                        "gap": 16,
                                        "isGroup": True,
                                        "children": [
                                            {
                                                "type": "box",
                                                "name": "grp-kpi-row",
                                                "layout": "row",
                                                "w": 1184,
                                                "h": 108,
                                                "gap": 16,
                                                "isGroup": True,
                                                "children": [
                                                    {"type": "kpi-card", "id": "dishes", "label": "在售菜品总数", "value": "58", "trend": "+4 本周上新", "trendType": "success", "subtitle": "含 12 款多规格招牌菜", "accent": "$brand", "h": 108},
                                                    {"type": "kpi-card", "id": "orders", "label": "今日实时订单", "value": "1,480", "trend": "+14.2%", "trendType": "success", "subtitle": "堂食 890 单 · 外卖 590 单", "accent": "$accent", "h": 108},
                                                    {"type": "kpi-card", "id": "revenue", "label": "今日实收流水", "value": "¥ 96,420", "trend": "+18.6%", "trendType": "success", "subtitle": "客单价均值 ¥ 65.15", "accent": "$success", "h": 108},
                                                    {"type": "kpi-card", "id": "warn", "label": "库存预警/售罄", "value": "2 款", "trend": "需及时补货", "trendType": "warning", "subtitle": "杨枝甘露(5份) · 酒酿圆子(0份)", "accent": "$warning", "h": 108},
                                                ],
                                            },
                                            middle_row,
                                            table_section,
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                    modal_node,
                ],
            },
            "interactions": [
                {
                    "trigger": "tab-trend-orders",
                    "description": "切换到订单趋势图表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "SwitchTrendOrders", "actions": [{"type": "set-panel-state", "target": "panel-trend", "state": "orders"}, {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 订单趋势"}]}]}],
                },
                {
                    "trigger": "tab-trend-revenue",
                    "description": "切换到营收趋势图表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "SwitchTrendRevenue", "actions": [{"type": "set-panel-state", "target": "panel-trend", "state": "revenue"}, {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 营收趋势"}]}]}],
                },
                {
                    "trigger": "tab-trend-category",
                    "description": "切换到品类占比图表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "SwitchTrendCategory", "actions": [{"type": "set-panel-state", "target": "panel-trend", "state": "category"}, {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 品类占比"}]}]}],
                },
                {
                    "trigger": "btn-state-default",
                    "description": "切换表格到默认数据列表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableDefault", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "default"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：默认列表态 (Default)"}]}]}],
                },
                {
                    "trigger": "btn-state-empty",
                    "description": "切换表格到空数据态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableEmpty", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "empty"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：空数据态 (Empty)"}]}]}],
                },
                {
                    "trigger": "btn-state-loading",
                    "description": "切换表格到骨架屏加载态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableLoading", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "loading"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：骨架加载态 (Loading)"}]}]}],
                },
                {
                    "trigger": "btn-state-error",
                    "description": "切换表格到接口异常态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableError", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "error"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：接口异常态 (Error)"}]}]}],
                },
            ],
        }],
    }

def _build_layout_diagnostics(bundle_res, ir):
    by_name = {}
    by_id = {}
    for sym in (ir or {}).get("symbols", []):
        src = sym.get("source") or {}
        best_ptr = src.get("parameterPointer") or sym.get("pointer") or src.get("macroPointer")
        if best_ptr:
            if sym.get("name"):
                by_name[sym["name"]] = best_ptr
            if sym.get("id"):
                by_id[sym["id"]] = best_ptr
                short_id = sym["id"].rsplit("/", 1)[-1]
                by_id.setdefault(short_id, best_ptr)
    fails = []
    raw_failures = (
        bundle_res.get("failures")
        or (bundle_res.get("audit") or {}).get("failures")
        or []
    )
    for _f in raw_failures:
        resolved_ptr = "/"
        if isinstance(_f, dict):
            if _f.get("pointer") and _f["pointer"] != "/":
                resolved_ptr = _f["pointer"]
            else:
                for k in ("symbolId", "widget", "widget_a", "child", "widget_b", "parent"):
                    cand = _f.get(k)
                    if isinstance(cand, str) and cand:
                        if cand in by_id:
                            resolved_ptr = by_id[cand]
                            break
                        if cand in by_name:
                            resolved_ptr = by_name[cand]
                            break
        _msg = _f if isinstance(_f, str) else json.dumps(_f, ensure_ascii=False)
        fails.append({
            "severity": "error",
            "code": (_f.get("code") if isinstance(_f, dict) and _f.get("code") else "E_LAYOUT"),
            "pointer": resolved_ptr,
            "pageName": (_f.get("page") if isinstance(_f, dict) else None),
            "message": _msg,
        })
    return fails


class _StructuredArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        from rp_language import fail
        fail("E_CLI", "/arguments", message)


def main():
    parser = _StructuredArgumentParser(
        description="zee-axure 直接原型生成引擎 (proto.py) — 支持声明式 JSON spec、Web/Mobile 双域组件库、两级审计门禁与静态交付"
    )
    sub = parser.add_subparsers(dest="cmd", required=True, parser_class=_StructuredArgumentParser)
    p_comp = sub.add_parser("compile", help="编译多态/多页交互原型产物包 (axvg + spec + 2x预览 + 审计报告)")
    p_comp.add_argument("--out-dir", required=True, help="输出目录")
    p_comp.add_argument("--spec", default=None, help="声明式多页/组件树 spec.json 路径")
    p_comp.add_argument("--preset", default="web-dashboard", choices=["web-dashboard", "mobile-lostfound"], help="内置旗舰预设")
    p_comp.add_argument("--theme", default=None, choices=list(THEMES.keys()), help="设计令牌主题")
    p_comp.add_argument("--shell", default=None, choices=["mobile-stack", "tablet-split", "web-console"], help="多端目标壳层 (mobile-stack / tablet-split / web-console)")
    p_comp.add_argument("--title", default=None, help="页面主标题覆盖")
    p_comp.add_argument("--no-interactions", action="store_true", help="静态交付模式：清空所有交互事件，生成纯静态原型")
    p_comp.add_argument("--strict-audit", action="store_true", help="严格审计模式：将审美与令牌告警升级为硬失败 (exit 1)")
    p_comp.add_argument("--auto-heal", nargs="?", const="safe", default=None, choices=["safe", "off", "true", "false"], help="安全自愈模式：自动修复文字裁切、容器溢出与非标令牌")
    p_check = sub.add_parser("check", help="检查 RP/1 类型、作用域、数据、交互语义与统一 10 项空间/审美门禁")
    p_check.add_argument("spec_pos", nargs="?", default=None, help="声明式源码路径 (.json/.rp1)")
    p_check.add_argument("--spec", default=None, help="声明式源码路径 (.json/.rp1)")
    p_check.add_argument("--shell", default=None, choices=["mobile-stack", "tablet-split", "web-console"])
    p_check.add_argument("--auto-heal", action="store_true", help="自动应用可自愈的语义/最坏情况溢出候选补丁并重验")
    p_check.add_argument("-o", "--out", default=None, help="配合 --auto-heal 输出修复后的源码路径")
    p_merge = sub.add_parser("merge", help="源码 ↔ .rp 三方合并 (base-spec + base-rp + edited-rp + new-spec -> merged-spec + merged-rp)")
    p_merge.add_argument("--base-spec", required=True, help="上次生成的基准 RP/1 源码")
    p_merge.add_argument("--base-rp", required=True, help="上次生成的基准 .rp")
    p_merge.add_argument("--edited-rp", required=True, help="设计师手工修改后的 .rp")
    p_merge.add_argument("--new-spec", required=True, help="AI 新一轮修改后的 RP/1 源码")
    p_merge.add_argument("--out-spec", required=True, help="合并后的 RP/1 源码输出路径")
    p_merge.add_argument("--out-rp", default=None, help="合并后重新生成的 .rp 输出路径")
    p_merge.add_argument("--prefer", default="fail", choices=["fail", "source", "native"], help="冲突解决策略：fail(默认报错保留现场) / source / native")
    for dump_cmd in ("dump-spec", "dump-preset-spec"):
        p_dump = sub.add_parser(dump_cmd, help="导出内置预设的声明式 spec.json 供二次定制")
        p_dump.add_argument("--preset", default="mobile-lostfound", choices=["mobile-lostfound", "web-dashboard"], help="预设名称 (默认 mobile-lostfound)")
        p_dump.add_argument("-o", "--out", required=True, help="输出 JSON 文件路径")
    sub.add_parser("selftest", help="运行 6 组全链路自检 (Web 三主题 + Mobile 双主题 + 自定义小画布两级审计)")
    sub.add_parser("tokens", help="打印审美门禁使用的字号/字重/圆角/间距令牌表")
    sub.add_parser("doctor", help="打印字体解析结果、主题令牌与版本信息（排查“字重层次变糊”这类静默降级）")
    p_meas = sub.add_parser("measure", help="输出每个文字元件的墨迹盒与安全下一条 y（排版定位用）")
    p_meas.add_argument("--spec", required=True)
    p_meas.add_argument("--theme", default=None)

    args = parser.parse_args()
    if args.cmd == "doctor":
        import platform
        probe = load_font(14, 400)
        font_path = getattr(probe, "path", None) or getattr(getattr(probe, "font", None), "path", None)
        print(json.dumps({
            "python": platform.python_version(), "platform": platform.platform(),
            "fontFile": font_path or "（未知：PIL 未暴露路径）",
            "boldVsRegularSameFile": bool(getattr(load_font(14, 700), "path", None) == font_path),
            "themeTokens": sorted(THEMES["editorial-warm"].keys()) if "editorial-warm" in THEMES else sorted(next(iter(THEMES.values())).keys()),
            "colorTokens": sorted(set().union(*[set(t.keys()) for t in THEMES.values()])),
            "rasterizedStyles": ["gradient", "shadow", "aurora", "noise", "innerGlow", "backdropBlur"],
            "rasterizedNote": "这些样式以嵌入位图（ImageBox）写入原生；渐变/阴影参数不可在 Axure 里再编辑",
            "commands": ["compile", "check", "measure", "tokens", "doctor", "merge", "selftest"],
        }, ensure_ascii=False, indent=2))
        return

    if args.cmd == "measure":
        import tempfile
        spec_abs = os.path.abspath(args.spec)
        spec_obj = read_source(spec_abs)
        sink = []
        tmp_dir = tempfile.mkdtemp(prefix="rp-measure-")
        compile_spec_bundle(spec_obj, tmp_dir, theme_override=args.theme, base_dir=os.path.dirname(spec_abs),
                            strict_audit=False, source_path=spec_abs, ink_sink=sink)
        _off = (sink[0].get("offset") if sink else None) or {"x": 0, "y": 0}
        print(json.dumps({"ok": True, "previewOffset": _off,
                          "note": "ink 坐标为页面坐标；若 offset 非 0，说明该页套了设备壳，预览图坐标 = ink + offset",
                          "pages": sink}, ensure_ascii=False, indent=2))
        return

    if args.cmd == "tokens":
        print(json.dumps({"fontSize": FONT_SIZE_TOKENS, "fontWeight": FONT_WEIGHT_TOKENS,
                          "radius": RADIUS_TOKENS, "spacing": RADIUS_TOKENS,
                          "inkRule": "文字在声明盒内垂直居中；墨迹高≈1.3×fontSize，带 fill/stroke 时另有 8px padding；"
                                     "相邻文字墨迹不得重叠，安全间距建议 ≥ fontSize×0.6",
                          "pillRadius": 999}, ensure_ascii=False, indent=2))
        return
    if args.cmd == "check":
        raw_spec_arg = args.spec or args.spec_pos
        if not raw_spec_arg:
            from rp_language import fail
            fail("E_CLI", "/arguments", "the following arguments are required: --spec")
        spec_abs = os.path.abspath(raw_spec_arg)
        spec_obj = read_source(spec_abs)
        if getattr(args, "shell", None):
            spec_obj["shell"] = args.shell
            spec_obj["domain"] = "mobile" if args.shell == "mobile-stack" else "web"
            if isinstance(spec_obj.get("product"), dict):
                spec_obj["product"]["shell"] = args.shell
        if getattr(args, "auto_heal", False):
            from rp_language import auto_heal_spec
            from rp_dsl import spec_to_dsl
            if args.out and not str(args.out).endswith((".json", ".rp1")):
                from rp_language import fail
                fail("E_CLI", "/arguments/out", f"Unsupported output extension for check --auto-heal: {args.out} (expected .rp1 or .json)")
            healed = auto_heal_spec(spec_obj)
            spec_obj = healed["spec"]
            ir = healed["ir"]
            if args.out:
                out_abs = os.path.abspath(args.out)
                if os.path.exists(out_abs):
                    from rp_language import fail
                    fail("E_OUTPUT_EXISTS", "/arguments/out", f"Refusing to overwrite existing file: {out_abs}")
                out_text = spec_to_dsl(spec_obj) if str(args.out).endswith(".rp1") else (json.dumps(spec_obj, ensure_ascii=False, indent=2) + "\n")
                with open(out_abs, "w", encoding="utf-8") as fh:
                    fh.write(out_text)
        else:
            healed = None
            _, ir = compile_language(copy.deepcopy(spec_obj))
        import tempfile
        with tempfile.TemporaryDirectory(prefix="rp1-check-") as tmp_dir:
            bundle_res = compile_spec_bundle(copy.deepcopy(spec_obj), tmp_dir, base_dir=os.path.dirname(spec_abs), source_path=spec_abs)
        _fails = _build_layout_diagnostics(bundle_res, ir)
        out_payload = {
            "ok": bool(bundle_res.get("ok", True)),
            "structural_ok": bool(bundle_res.get("structural_ok", True)),
            "aesthetic_ok": bool(bundle_res.get("aesthetic_ok", True)),
            "warnings": bundle_res.get("warnings", []),
            "language": ir["language"],
            "target": ir["target"],
            "pages": len(ir["pages"]),
            "symbols": len(ir["symbols"]),
            "semanticHash": ir["semanticHash"],
            "diagnostics": _fails,
        }
        if healed is not None:
            out_payload["healed"] = healed["healed"]
            out_payload["rounds"] = healed["rounds"]
            out_payload["appliedPatches"] = healed["appliedPatches"]
            if args.out:
                out_payload["output"] = os.path.abspath(args.out)
        print(json.dumps(out_payload, ensure_ascii=False))
        sys.exit(0 if bundle_res.get("ok", True) else 1)
    elif args.cmd == "merge":
        from rp_decompile import three_way_merge_rp
        res = three_way_merge_rp(
            base_spec_path=args.base_spec,
            base_rp_path=args.base_rp,
            edited_rp_path=args.edited_rp,
            new_spec_path=args.new_spec,
            out_spec_path=args.out_spec,
            out_rp_path=args.out_rp,
            prefer=args.prefer,
        )
        print(json.dumps(res, ensure_ascii=False, indent=2))
        sys.exit(0 if res.get("ok") else 1)
    elif args.cmd == "compile":
        out_abs = os.path.abspath(args.out_dir)
        if args.spec:
            spec_abs = os.path.abspath(args.spec)
            spec_obj = read_source(spec_abs)
            if getattr(args, "shell", None):
                spec_obj["shell"] = args.shell
                spec_obj["domain"] = "mobile" if args.shell == "mobile-stack" else "web"
                if isinstance(spec_obj.get("product"), dict):
                    spec_obj["product"]["shell"] = args.shell
            res = compile_spec_bundle(
                spec_obj,
                out_abs,
                theme_override=args.theme,
                base_dir=os.path.dirname(spec_abs),
                no_interactions=args.no_interactions,
                strict_audit=args.strict_audit,
                source_path=spec_abs,
                auto_heal=args.auto_heal,
            )
        elif args.preset == "mobile-lostfound" or (args.theme and args.theme.startswith("mobile-")):
            spec_obj = build_mobile_lostfound_spec(title_override=args.title)
            res = compile_spec_bundle(
                spec_obj,
                out_abs,
                theme_override=args.theme or "mobile-lowfi",
                no_interactions=args.no_interactions,
                strict_audit=args.strict_audit,
            )
        else:
            res = compile_prototype_bundle(
                out_abs,
                theme_name=args.theme or "enterprise-light",
                title_override=args.title,
                no_interactions=args.no_interactions,
                strict_audit=args.strict_audit,
            )
        print(json.dumps(res, ensure_ascii=False, indent=2))
        sys.exit(0 if res["ok"] else 1)
    elif args.cmd in ("dump-spec", "dump-preset-spec"):
        if getattr(args, "preset", "mobile-lostfound") == "web-dashboard":
            spec_obj = build_web_dashboard_spec()
        else:
            spec_obj = build_mobile_lostfound_spec()
        out_abs = os.path.abspath(args.out)
        if os.path.dirname(out_abs):
            os.makedirs(os.path.dirname(out_abs), exist_ok=True)
        with open(out_abs, "w", encoding="utf-8") as f:
            json.dump(spec_obj, f, ensure_ascii=False, indent=2)
        print(json.dumps({"ok": True, "preset": args.preset, "outFile": out_abs}))
    elif args.cmd == "selftest":
        res = run_selftest()
        print(json.dumps(res, ensure_ascii=False, indent=2))
        sys.exit(0 if res["ok"] else 1)

if __name__ == "__main__":
    try:
        main()
    except LanguageError as error:
        import rp_language_cli
        diag = dict(error.diagnostic)
        span_map = getattr(rp_language_cli, "_LAST_SPAN_MAP", None) or {}
        if span_map and "sourceSpan" not in diag:
            ptr = diag.get("pointer") or "/"
            cur = ptr
            while cur:
                if cur in span_map:
                    diag["sourceSpan"] = span_map[cur]
                    break
                if "/" not in cur or cur == "/":
                    break
                cur = cur.rsplit("/", 1)[0] or "/"
        if isinstance(diag.get("sourceSpan"), dict):
            if "line" not in diag and "line" in diag["sourceSpan"]:
                diag["line"] = diag["sourceSpan"]["line"]
            if "column" not in diag and "column" in diag["sourceSpan"]:
                diag["column"] = diag["sourceSpan"]["column"]
        elif "line" in diag:
            diag["sourceSpan"] = {"line": diag["line"], **({"column": diag["column"]} if "column" in diag else {})}
        result = {"ok": False, "language": "rp/1", "diagnostics": [diag]}
        out_stream = sys.stdout if sys.argv[1:2] in (["check"], ["merge"], ["measure"], ["tokens"], ["doctor"]) else sys.stderr
        print(json.dumps(result, ensure_ascii=False), file=out_stream)
        sys.exit(1)
    except (OSError, UnicodeError, RuntimeError, ValueError) as error:
        result = {"ok": False, "language": "rp/1", "diagnostics": [{
            "code": "E_SOURCE_IO", "pointer": "/", "severity": "error", "message": str(error),
        }]}
        out_stream = sys.stdout if sys.argv[1:2] in (["check"], ["merge"], ["measure"], ["tokens"], ["doctor"]) else sys.stderr
        print(json.dumps(result, ensure_ascii=False), file=out_stream)
        sys.exit(1)
