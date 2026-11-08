# 从 scripts/proto.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 1;行为不变,勿手改)。
import base64
import glob
import hashlib
from functools import lru_cache
import math
import os
import re
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # scripts/

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


@lru_cache(maxsize=32768)
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
