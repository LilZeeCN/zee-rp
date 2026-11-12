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

# 2026-11-08 RP/1 编译链拆分:实现整体迁入 scripts/proto_engine/(按节原样迁移),
# 本文件为 facade——镜像全部顶层名,保持 `import proto` 与 `python3 scripts/proto.py`
# 两个消费面的属性面与行为不变;__main__ CLI 块逐字保留。
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

import proto_engine as _engine

for _n in dir(_engine):
    if _n.startswith('__'):
        continue
    globals()[_n] = getattr(_engine, _n)

# __main__ 块自身引用的模块名(自动推导)
import argparse
import copy
import json
import os
from rp_language_cli import read_source
import sys
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, LanguageError, RADIUS_TOKENS, SPACING_TOKENS, compile_language

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
        with tempfile.TemporaryDirectory(prefix="rp-measure-") as tmp_dir:
            compile_spec_bundle(spec_obj, tmp_dir, theme_override=args.theme, base_dir=os.path.dirname(spec_abs),
                                strict_audit=False, source_path=spec_abs, ink_sink=sink)
        _off = (sink[0].get("offset") if sink else None) or {"x": 0, "y": 0}
        print(json.dumps({"ok": True, "previewOffset": _off,
                          "note": "ink 坐标为页面坐标；若 offset 非 0，说明该页套了设备壳，预览图坐标 = ink + offset",
                          "pages": sink}, ensure_ascii=False, indent=2))
        return

    if args.cmd == "tokens":
        print(json.dumps({"fontSize": FONT_SIZE_TOKENS, "fontWeight": FONT_WEIGHT_TOKENS,
                          "radius": RADIUS_TOKENS, "spacing": SPACING_TOKENS,
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
            healed = auto_heal_spec(spec_obj, base_dir=os.path.dirname(spec_abs))
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

