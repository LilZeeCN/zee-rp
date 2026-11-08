# 从 scripts/proto.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 1;行为不变,勿手改)。
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, RADIUS_TOKENS, SPACING_TOKENS

# -------------------- 1. DESIGN TOKENS & MULTI-THEME PRESETS --------------------

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
