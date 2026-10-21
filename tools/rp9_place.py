#!/usr/bin/env python3
"""把 .axvg.json 干净地粘贴进 Axure RP 9 的目标文档，并把整块内容
平移到页面原点 (0,0)。全程走 AX API（本机 osascript/System Events 被拒绝）。

用法:
  python3 tools/rp9_place.py <目标.rp> <窗口标题子串> [--axvg <path.axvg.json>] [--skip-clear] [--allow-duplicate-names] [--dry-run]
  python3 tools/rp9_place.py --dry-run --axvg <path.axvg.json>

退出码 (Exit Codes):
  0  成功粘贴且全量唯一引用元件坐标校验通过 (误差 <= 1.5px)
  1  未找到唯一参考元件或 Axure GUI 菜单/粘贴动作失败
  2  连续 4 次微调平移后仍未对齐原点 (0,0)
  3  粘贴后全量坐标校验失败 (存在元件相对偏移 > 1.5px，防止静默错位)
  4  Spec 预检拦截：存在同名元件 (除非显式传 --allow-duplicate-names)
"""
import json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 相对本文件推导（可移植）：tools/ -> <skill>/scripts
HERE_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL = os.environ.get("ZEE_AXURE_SCRIPTS_DIR") or os.path.join(os.path.dirname(HERE_DIR), "scripts")
BUNDLE = "com.axure.AxureRP9"
# 参考元件名 -> spec 中的期望坐标（兼容 AutoDraft 的「色块-1」与手工 spec 的「bar-甜品/logo/sidebar」）
REFS = {
    "色块-1": (0.0, 0.0),
    "bar-甜品": (815.0, 540.0),
    "logo": (15.0, 12.0),
    "sidebar": (0.0, 49.0),
}


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    return r.returncode, r.stdout + r.stderr


def swift(tool, *args, **kw):
    return run(["swift", os.path.join(HERE_DIR, tool)] + list(args), **kw)


def menu(item, menu_name, title):
    rc, out = swift("axtool.swift", "press", BUNDLE, menu_name, item, "--raise", title)
    return "PRESSED" in out


def rp_read(path):
    rc, out = run(["node", os.path.join(SKILL, "rp-read.mjs"), path])
    return out


def widget_xy(out, name):
    matches = []
    for line in out.splitlines():
        if f"「{name}」" in line:
            mx = re.search(r"x=(-?[\d.]+)\s+y=(-?[\d.]+)", line)
            if mx and mx.group(1) != "null":
                matches.append((float(mx.group(1)), float(mx.group(2))))
    if len(matches) == 1:
        return matches[0]
    return None


def counts(out):
    m = re.search(r"widgets=(\d+)", out)
    return int(m.group(1)) if m else -1


def clear_page(title, path):
    for _ in range(4):
        menu("Select All", "Edit", title)
        time.sleep(0.6)
        menu("Delete", "Edit", title)
        time.sleep(0.6)
        menu("Save", "File", title)
        time.sleep(2.0)
        out = rp_read(path)
        if counts(out) <= 1:
            return out
    return rp_read(path)


def ch_kind_ok(spec_obj, name):
    for fr in spec_obj.get("frames", []):
        for ch in fr.get("children", []):
            if ch.get("name") == name:
                return ch.get("kind") not in ("group", "layer")
    return True


def main():
    if "-h" in sys.argv or "--help" in sys.argv or len(sys.argv) < 2:
        print(__doc__.strip())
        return 0 if ("-h" in sys.argv or "--help" in sys.argv) else 1

    dry_run = "--dry-run" in sys.argv
    skip_clear = "--skip-clear" in sys.argv
    allow_dup = "--allow-duplicate-names" in sys.argv
    axvg_path = os.path.join(HERE, "spec", "dashboard.axvg.json")
    if "--axvg" in sys.argv:
        idx = sys.argv.index("--axvg")
        if idx + 1 < len(sys.argv):
            axvg_path = os.path.abspath(sys.argv[idx + 1])

    pos_args = []
    skip_next = False
    for i, a in enumerate(sys.argv[1:], start=1):
        if skip_next:
            skip_next = False
            continue
        if a == "--axvg":
            skip_next = True
            continue
        if a.startswith("--"):
            continue
        pos_args.append(a)

    target = pos_args[0] if len(pos_args) >= 1 else None
    title = pos_args[1] if len(pos_args) >= 2 else (os.path.splitext(os.path.basename(target))[0] if target else None)

    refs = dict(REFS)
    dup_names = []
    spec_cand = re.sub(r"\.axvg\.json$", ".spec.json", axvg_path)
    if not os.path.exists(spec_cand):
        spec_cand = os.path.join(os.path.dirname(axvg_path), "draft.spec.json")
    if os.path.exists(spec_cand):
        spec_obj = json.load(open(spec_cand, "r", encoding="utf-8"))
        name_counts = {}
        raw_coords = {}
        for fr in spec_obj.get("frames", []):
            for ch in fr.get("children", []):
                nm = ch.get("name")
                if nm and "x" in ch and "y" in ch:
                    name_counts[nm] = name_counts.get(nm, 0) + 1
                    raw_coords[nm] = (float(ch["x"]), float(ch["y"]))
        dup_names = [nm for nm, c in name_counts.items() if c > 1]
        if dup_names:
            print(f"WARNING: duplicate widget names in spec: {dup_names}")
            if not allow_dup:
                print("ERROR: refusing duplicate widget names in spec (pass --allow-duplicate-names to override)")
                return 4
        dyn_refs = {
            nm: xy for nm, xy in raw_coords.items()
            if name_counts.get(nm, 0) == 1 and ch_kind_ok(spec_obj, nm)
        }
        if dyn_refs:
            refs = dyn_refs

    if dry_run:
        if not os.path.exists(axvg_path):
            print(f"ERROR: axvg file not found: {axvg_path}")
            return 1
        sample_ref = next(iter(refs.items()), None)
        print(json.dumps({
            "ok": len(refs) > 0 and (len(dup_names) == 0 or allow_dup),
            "dryRun": True,
            "axvgPath": axvg_path,
            "specPath": spec_cand if os.path.exists(spec_cand) else None,
            "uniqueRefCount": len(refs),
            "primaryRef": {"name": sample_ref[0], "xy": sample_ref[1]} if sample_ref else None,
            "duplicateNames": dup_names,
        }, ensure_ascii=False, indent=2))
        return 0 if len(refs) > 0 else 1

    if not target or not title:
        print("ERROR: missing <目标.rp> or <窗口标题子串> (see --help)")
        return 1

    run(["open", "-a", "Axure RP 9", target])
    time.sleep(1.0)
    if not skip_clear:
        out = clear_page(title, target)
        print("clear -> widgets:", counts(out))
    # 剪贴板 + 粘贴
    rc, out = run(["node", os.path.join(SKILL, "axvg.mjs"), "paste", axvg_path, "--no-menu"])
    assert '"ok": true' in out, out
    run(["open", "-a", "Axure RP 9", target])
    time.sleep(0.5)
    swift("axclick.swift", BUNDLE, title, "400", "400")
    time.sleep(0.5)
    rc, out = swift("axpaste.swift", BUNDLE, title, "--save")
    assert "paste=PRESSED" in out, out
    time.sleep(2.5)
    # 读偏移并平移
    for attempt in range(4):
        out = rp_read(target)
        cur = None
        for name, (ex, ey) in refs.items():
            xy = widget_xy(out, name)
            if xy:
                cur = (name, xy[0] - ex, xy[1] - ey)
                break
        if cur is None:
            print("no unique reference widget found"); return 1
        name, dx, dy = cur
        print(f"attempt {attempt}: ref={name} offset=({dx:g},{dy:g}) widgets={counts(out)}")
        if abs(dx) < 0.5 and abs(dy) < 0.5:
            mismatches = []
            checked = 0
            for v_name, (vex, vey) in refs.items():
                vxy = widget_xy(out, v_name)
                if vxy is None:
                    continue
                checked += 1
                if abs(vxy[0] - vex) > 1.5 or abs(vxy[1] - vey) > 1.5:
                    mismatches.append((v_name, vxy, (vex, vey)))
            if mismatches:
                print(f"ERROR: post-paste full-coordinate check failed ({len(mismatches)}/{checked} widgets misplaced): {mismatches[:5]}")
                return 3
            print(f"PLACED at page origin (verified {checked} unique widgets)")
            return 0
        swift("axnudge.swift", BUNDLE, title, str(int(round(-dx))), str(int(round(-dy))))
        time.sleep(0.5)
        menu("Save", "File", title)
        time.sleep(2.0)
    print("still off-grid")
    return 2


if __name__ == "__main__":
    sys.exit(main())
