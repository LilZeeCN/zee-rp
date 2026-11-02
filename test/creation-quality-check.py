"""Reproduce public mobile-authoring failures and prove compiler compatibility."""
import copy
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from rp_language import compile_language, simulate_spec, LanguageError
from rp_dsl import dsl_to_spec
from rp_workflow import diagnose_spec
from proto import measure_node, measure_text, _render_vector_icon
from rp_icons import ICON_NAMES

checks = []


def check(name, action):
    action()
    checks.append(name)
    print("PASS", name)


def spec_for(root):
    return {"language": "rp/1", "variables": {"done": {"type": "number", "value": 0}},
            "pages": [{"id": "home", "canvas": [402, 874], "root": root}]}


def nodes(node):
    yield node
    for child in node.get("children", []): yield from nodes(child)
    for state in node.get("states", []): yield from nodes(state["root"])


def progress_hidden(label):
    spec = spec_for({"type": "box", "id": "root", "w": 370, "children": [
        {"type": "progress-bar", "id": "progress", "value": {"variable": "done"}, "max": 1,
         "showValue": False, "label": label, "w": 370},
        {"button": "add", "text": "完成", "onClick": [{"type": "set-variable", "variable": "done", "value": 1}]},
    ]})
    lowered, ir = compile_language(spec)
    assert not any(s["id"] == "home/progress_value" for s in ir["symbols"])
    assert any(s["id"] == "home/progress_fill" for s in ir["symbols"])
    assert any(n.get("text") == label for n in nodes(lowered["pages"][0]["root"])) == bool(label)
    result = simulate_spec(spec, [{"target": "home/add"}])
    assert result["final"]["variables"]["done"] == 1
    assert "s100" in result["final"]["panels"].values()


check("showValue=false removes percent without breaking dynamic fill", lambda: progress_hidden(""))
check("showValue=false preserves a nonempty title", lambda: progress_hidden("掌握进度"))


def letter_spacing():
    label = {"type": "label", "name": "spaced", "text": "DAILY STUDY", "fontSize": 12, "letterSpacing": 2}
    width, _ = measure_node(label)
    assert width >= measure_text("DAILY STUDY", 12)[0] + 20
    fixed = {**label, "w": 40}
    assert measure_node(fixed)[0] == 40


check("auto label width includes letter spacing; explicit width remains fixed", letter_spacing)


def runtime_strings():
    spec = spec_for({"type": "box", "id": "root", "children": [
        {"label": "status", "text": "=text(contains(var.ids, '|a|'))"},
        {"button": "remove", "text": "删除 a", "onClick": [{"type": "set-variable", "variable": "ids", "value": "=remove(var.ids, '|a|')"}]},
    ]})
    spec["variables"]["ids"] = {"type": "text", "value": "|aa||a||中文|"}
    result = simulate_spec(spec, [{"target": "home/remove"}])
    assert result["final"]["variables"]["ids"] == "|aa||中文|"
    status = next(v for k, v in result["final"]["widgets"].items() if k.startswith("txt-status-"))
    assert status["text"] == "false"
    bad = copy.deepcopy(spec)
    bad["pages"][0]["root"]["children"][0]["text"] = {"fn": "contains", "args": [1, "a"]}
    try: compile_language(bad)
    except LanguageError as error: assert error.diagnostic["code"] == "E_TYPE"
    else: raise AssertionError("contains accepted a number")


check("record-key membership does not confuse a/aa and removal preserves other records", runtime_strings)


def icon_validation():
    import base64
    import io
    from PIL import Image
    for name in ICON_NAMES:
        _, data = _render_vector_icon(name, 24, 24, "#7256C8")
        assert Image.open(io.BytesIO(base64.b64decode(data))).getbbox(), name
    bad = spec_for({"type": "icon", "id": "wrong", "icon": "serach"})
    try: compile_language(bad)
    except LanguageError as error:
        assert error.diagnostic["code"] == "E_ICON_NAME"
        assert "search" in error.diagnostic["suggestions"]
    else: raise AssertionError("Unknown icon silently accepted")


check("every advertised icon has pixels and unknown names are actionable", icon_validation)


def layout_hints():
    source = 'rp/1\npage #home [442x914] device=iphone-17\n  button #start [fillx180] "开始"\n'
    spec, spans = dsl_to_spec(source, return_spans=True)
    result = diagnose_spec(spec, spans=spans, source_text=source)
    assert result["ok"]
    assert {h["code"] for h in result["hints"]} == {"W_CONTROL_HEIGHT", "W_DEVICE_CANVAS"}
    hint = next(h for h in result["hints"] if h["code"] == "W_CONTROL_HEIGHT")
    assert hint["line"] == 3 and "[180x44]" in hint["nextAction"]


check("suspicious control height and outer-sized canvas give nonblocking source hints", layout_hints)


def documented_example():
    spec = dsl_to_spec((ROOT / "examples/rp-language/mobile-layout.rp1").read_text())
    lowered, ir = compile_language(spec)
    assert lowered["pages"][0]["canvas"] == {"w": 402, "h": 874}
    assert not any(s["id"] == "home/progress_value" for s in ir["symbols"])


check("documented mobile start uses screen canvas and honors showValue", documented_example)


def schema_contract():
    from rp_schema import language_schema
    schema = language_schema()
    assert schema == json.loads((ROOT / "references/rp-language.schema.json").read_text())
    assert "device" in schema["properties"] and "tokens" in schema["properties"]
    kinds = {variant["properties"]["type"]["const"] for variant in schema["$defs"]["node"]["anyOf"]
             if "type" in variant.get("properties", {})}
    assert {"phone-shell", "progress-bar", "nav-bar", "tab-bar", "stat-row", "list-item"} <= kinds


check("published editor schema matches its generator and includes mobile macros", schema_contract)


def zero_calc_macros_and_dsl():
    import subprocess
    import tempfile
    from proto import compile_spec_bundle
    from rp_dsl import spec_to_dsl
    dsl = """rp/1 title="零算高测试" domain="mobile" device="iphone-16-pro" theme="mobile-hifi"
palette:
  $brand = "#10B981"

var done: number = 3

tab-bar:
  item today "今日"
  item stats "统计"

page today "今日" [442x914]:
  phone-shell shell title="今日计划":
    stat-row stats_row [fillxhug] gap=10 items=[{"label":"今日目标","value":"=var.done","sub":"已完成","color":"$brand"},{"label":"掌握率","value":"88%","sub":"+6%","color":"$success"}]
    card hero_card [fillxhug] tag="14:15" title="核心概念复盘" subtitle="预计 10 分钟" body="无需手算像素高度，自动包裹多行说明文本与操作按钮。" rightBadge="必做" actionText="查看统计" goto="stats"
    list-item row_1 [fillxhug] tag="高频" title="间隔重复法" subtitle="艾宾浩斯记忆曲线复习策略" rightBadge="进行中" rightTone="brand" goto="stats"
    @progress-bar #prog [fillx40] label="今日掌握" value=$done max=5
    panel view_panel [fillxhug] tabs=["清单视图","看板视图"]:
      :state list
        label list_t1 "清单第一项" [fillxhug] fontSize=14
        label list_t2 "清单第二项：这是一段会自动换行并撑高动态面板状态容器的长说明文字，用于验证零手算高度测量。" [fillxhug] fontSize=13 color=$muted
      :state board
        label board_t1 "看板视图内容" [fillxhug] fontSize=14

page stats "统计":
  phone-shell stats_shell title="学习统计":
    label stats_title "全部掌握概览" [fillxhug] fontSize=20 fontWeight=700
    input search_in [fillx38] placeholder="输入关键词搜索..." value="默认搜索词"
"""
    spec = dsl_to_spec(dsl)
    roundtrip_dsl = spec_to_dsl(spec)
    assert 'tag="14:15"' in roundtrip_dsl, roundtrip_dsl
    assert "view_panel_list_root" not in roundtrip_dsl, roundtrip_dsl
    with tempfile.TemporaryDirectory(prefix="rp1-zero-calc-") as tmp_dir:
        rp1_file = Path(tmp_dir) / "test.rp1"
        rp1_file.write_text(dsl, encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts/rp_workflow.py")],
            input=json.dumps({
                "command": "patch",
                "source": str(rp1_file),
                "format": ".rp1",
                "operations": [
                    {"op": "set-token", "token": "$brand", "value": "#D97706"},
                    {"op": "replace", "target": "today/list_t1", "property": "text", "value": "更新后的清单第一项"},
                ],
            }),
            text=True,
            capture_output=True,
            check=True,
        )
        rev = json.loads(proc.stdout)
        assert rev["ok"], rev
        assert not any("_fillstate_" in s or s.endswith("_fill") for s in rev["diff"]["changedSymbols"]), rev["diff"]
        res = compile_spec_bundle(spec, tmp_dir, strict_audit=True, auto_heal="safe")
        assert res["ok"], res.get("warnings")
        assert res["structural_ok"] and res["aesthetic_ok"]
        assert Path(res["previews"]["contactSheet"]).exists()
        assert Path(res["previews"]["statesSheet"]).exists()
        plan_data = json.loads(Path(res["planPath"]).read_text(encoding="utf-8"))
        stats_plan = next(p for p in plan_data["pages"] if p["slug"] == "stats")
        tabs_bg = next(w for w in stats_plan["allMainWidgets"] if "tabbar" in w["name"] or "tabs" in w["name"])
        assert tabs_bg["y"] > 700, f"Expected sticky bottom tab-bar y > 700, got {tabs_bg['y']}"
        in_widget = next(w for w in stats_plan["allMainWidgets"] if "search_in" in w["name"])
        assert in_widget.get("previewText") == "默认搜索词", in_widget


check("zero-calc macros, top-level tab-bar, panel tabs, contactSheet and auto-heal pass strictAudit", zero_calc_macros_and_dsl)


def panel_state_children_shorthand_and_diagnostics():
    from rp_dsl import spec_to_dsl
    from rp_language import LanguageError

    # 1. JSON panel states with `children` + box overrides nested inside `phone-shell` macro
    json_spec = {
        "language": "rp/1",
        "target": 9,
        "name": "面板状态简写验证",
        "domain": "mobile",
        "device": "iphone-17",
        "pages": [
            {
                "id": "timer",
                "name": "专注",
                "root": {
                    "type": "phone-shell",
                    "id": "shell_timer",
                    "title": "专注",
                    "children": [
                        {
                            "type": "dynamic-panel",
                            "id": "core",
                            "w": "fill",
                            "h": "hug",
                            "states": [
                                {
                                    "id": "idle",
                                    "title": "待机",
                                    "layout": "column",
                                    "gap": 14,
                                    "align": "center",
                                    "children": [
                                        {"label": "idle_lbl", "text": "25:00", "w": "fill", "h": 32},
                                        {"button": "start_btn", "text": "开始", "w": "fill", "h": 44, "onClick": [{"state": ["core", "running"]}]},
                                    ],
                                },
                                {
                                    "state": "running",
                                    "children": [
                                        {"label": "run_lbl", "text": "专注中", "w": "fill", "h": 32},
                                    ],
                                },
                            ],
                        }
                    ],
                },
            }
        ],
    }
    lowered, ir = compile_language(json_spec)
    sym_ids = {s["id"] for s in ir["symbols"]}
    assert len(lowered["pages"]) == 1 and "timer/core/idle/idle_lbl" in sym_ids
    # spec_to_dsl -> dsl_to_spec roundtrip on raw `children`-shorthand spec
    dsl_str = spec_to_dsl(json_spec)
    assert ":state idle" in dsl_str and ":state running" in dsl_str, dsl_str
    rt_spec = dsl_to_spec(dsl_str)
    _, rt_ir = compile_language(rt_spec)
    assert "timer/core/idle/idle_lbl" in {s["id"] for s in rt_ir["symbols"]}

    # 2. .rp1 DSL `:state` with trailing colon, single child + gap/layout overrides, `:root` / `children:`, and inline `children=[...]`
    dsl_variants = """rp/1 title="DSL状态简写" domain="mobile" device="iphone-17"
page #home "首页"
  phone-shell #sh title="首页":
    panel #p1 [fillxhug]:
      :state idle "待机" layout=column gap=14:
        label #l1 "单子节点带gap属性" [fillx24]
      :state running:
        :root:
          label #l2 "显式:root块" [fillx24]
      :state done children=[{"label":"l3","text":"内联children","w":"fill","h":24}]
"""
    var_spec = dsl_to_spec(dsl_variants)
    _, var_ir = compile_language(var_spec)
    assert {"home/p1/idle/l1", "home/p1/running/l2", "home/p1/done/l3"} <= {s["id"] for s in var_ir["symbols"]}

    # 3. Malformed state without `root` or `children` emits E_STATE (never KeyError: 'root')
    for bad_state in ({"id": "empty_state"}, "not_an_object"):
        bad_spec = copy.deepcopy(json_spec)
        bad_spec["pages"][0]["root"]["children"][0]["states"] = [bad_state]
        try:
            compile_language(bad_spec)
            raise AssertionError("Expected LanguageError E_STATE")
        except LanguageError as err:
            assert err.diagnostic["code"] == "E_STATE", err.diagnostic

    # 4. Non-dict element in `children` (inside panel state or phone-shell) emits E_OBJECT with exact pointer
    bad_child_in_state = copy.deepcopy(json_spec)
    bad_child_in_state["pages"][0]["root"]["children"][0]["states"][1]["children"].append("oops")
    try:
        compile_language(bad_child_in_state)
        raise AssertionError("Expected LanguageError E_OBJECT for non-dict state child")
    except LanguageError as err:
        assert err.diagnostic["code"] == "E_OBJECT", err.diagnostic
        assert err.diagnostic["pointer"] == "/pages/0/root/children/0/states/1/children/1", err.diagnostic

    bad_child_in_shell = copy.deepcopy(json_spec)
    bad_child_in_shell["pages"][0]["root"]["children"].append("oops")
    try:
        compile_language(bad_child_in_shell)
        raise AssertionError("Expected LanguageError E_OBJECT for non-dict phone-shell child")
    except LanguageError as err:
        assert err.diagnostic["code"] == "E_OBJECT", err.diagnostic
        assert err.diagnostic["pointer"] == "/pages/0/root/children/1", err.diagnostic


check("panel state children shorthands, DSL state variants and E_STATE/E_OBJECT diagnostics", panel_state_children_shorthand_and_diagnostics)
print(json.dumps({"passed": len(checks), "failed": 0}))
