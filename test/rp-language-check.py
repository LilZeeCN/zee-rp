#!/usr/bin/env python3
"""Semantic contract tests: identity, isolation, complete data, negative diagnostics."""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from rp_language import (
    compile_language, LanguageError, Frontend,
    ReferenceRuntime, simulate_spec, explore_state_space,
    inspect_spec, explain_spec, patch_spec, complete_spec,
)


def fixture(name="booking"):
    return json.loads((ROOT / "examples/rp-language" / (name + ".json")).read_text())


def sugar_fixture():
    return {
        "language": "rp/1", "target": 9, "theme": "mobile-lowfi", "domain": "test",
        "variables": {"answer": {"type": "text", "value": "none"},
                      "count": {"type": "number", "value": 0},
                      "status": {"type": "text", "value": "variable stays unchanged"}},
        "pages": [{"id": "main", "name": "Sugar", "canvas": {"w": 600, "h": 640},
                   "root": {"type": "box", "id": "root", "layout": "column", "children": [
                       {"type": "input", "id": "title", "value": "Book", "w": 200, "h": 32},
                       {"type": "label", "id": "status", "w": "fill", "h": 24,
                        "text": {"fn": "concat", "args": ["已选：", {"variable": "answer"}]}},
                       {"type": "button", "id": "apply", "text": "应用", "w": 120, "h": 34},
                       {"type": "dynamic-panel", "id": "receipt", "w": 200, "h": 80,
                        "states": [{"id": sid, "root": {"type": "box", "id": "content", "children": []}}
                                   for sid in ("ready", "done")]},
                   ]}}],
    }


class LanguageContract(unittest.TestCase):
    def reject(self, spec, code, pointer=None):
        with self.assertRaises(LanguageError) as result:
            compile_language(spec)
        diagnostic = result.exception.diagnostic
        self.assertEqual(diagnostic["code"], code)
        if pointer is not None:
            self.assertEqual(diagnostic["pointer"], pointer)

    def test_five_business_specs(self):
        for name in ("booking", "approval", "inventory", "survey", "course"):
            with self.subTest(name=name):
                lowered, ir = compile_language(fixture(name))
                self.assertTrue(ir["symbols"])
                self.assertEqual(len(ir["pages"]), len(lowered["pages"]))
                self.assertEqual(ir["target"], 9)

    def test_reproducible_ir(self):
        self.assertEqual(compile_language(fixture())[1], compile_language(fixture())[1])

    def test_explicit_identity_survives_rename_and_sibling_insertion(self):
        spec = fixture()
        before = {s["id"]: s["name"] for s in compile_language(spec)[1]["symbols"]}
        spec["pages"][0]["root"]["children"][0]["name"] = "改名的显示标签"
        spec["pages"][0]["root"]["children"].insert(0, {"type": "label", "id": "extra", "text": "额外说明"})
        after = {s["id"]: s["name"] for s in compile_language(spec)[1]["symbols"]}
        self.assertTrue(all(after[key] == value for key, value in before.items()))

    def test_keyed_identity_survives_dataset_reorder(self):
        spec = fixture()
        before = {s["id"]: s["name"] for s in compile_language(spec)[1]["symbols"]}
        spec["datasets"]["rooms"]["rows"].reverse()
        after = {s["id"]: s["name"] for s in compile_language(spec)[1]["symbols"]}
        self.assertEqual(before, after)

    def test_display_names_do_not_change_identity_hash_or_interactions(self):
        spec = sugar_fixture()
        spec['pages'][0]['root']['children'][2]['onClick'] = {'type': 'set-variable', 'variable': 'answer', 'value': 'ok'}
        before, before_ir = compile_language(spec)
        for i, name in enumerate((' 搜索\r\n输入框 ', '重复名', '重复名', '★ !')):
            spec['pages'][0]['root']['children'][i]['name'] = name
        after, after_ir = compile_language(spec)
        self.assertEqual(before, after)
        self.assertEqual(before_ir['semanticHash'], after_ir['semanticHash'])
        self.assertEqual([s['name'] for s in before_ir['symbols']], [s['name'] for s in after_ir['symbols']])
        displays = {s['id']: s['display'] for s in after_ir['symbols']}
        self.assertEqual(displays['main/title'], '搜索 输入框')
        self.assertEqual(displays['main/receipt'], '★ !')
        spec['pages'][0]['root']['name'] = ' \r\n '
        _, blank_ir = compile_language(spec)
        root = next(s for s in blank_ir['symbols'] if s['id'] == 'main/root')
        self.assertEqual(root['display'], root['name'])

    def test_component_instances_do_not_share_targets(self):
        spec = fixture("course")
        component = spec["components"]["Course"]["root"]
        component["children"][-1]["on"]["click"] = [{"type": "set-text", "target": {"ref": "title"}, "text": "已选"}]
        lowered, _ = compile_language(spec)
        interactions = lowered["pages"][0]["interactions"]
        targets = [ix["events"][0]["cases"][0]["actions"][0]["target"] for ix in interactions]
        self.assertEqual(len(targets), 2)
        self.assertEqual(len(set(targets)), 2)

    def test_binding_copies_every_declared_field(self):
        lowered, _ = compile_language(fixture())
        cases = lowered["pages"][1]["interactions"][-1]["events"][0]["cases"]
        self.assertEqual(len(cases), 2)
        self.assertEqual([a["text"] for a in cases[1]["actions"]],
                         ["创新楼会议室 B", "八人间", "三层南区，配备投影。"])
        self.assertTrue(all("condition" not in case for case in cases))

    def test_unknown_property(self):
        spec = fixture()
        spec["pages"][0]["root"]["fontSize"] = 14
        self.reject(spec, "E_PROPERTY", "/pages/0/root/fontSize")

    def test_wrong_value_type(self):
        spec = fixture()
        spec["pages"][0]["root"]["gap"] = "large"
        self.reject(spec, "E_TYPE", "/pages/0/root/gap")

    def test_unknown_field(self):
        spec = fixture()
        spec["components"]["RoomCard"]["root"]["children"][0]["text"] = {"$": "item.titel"}
        self.reject(spec, "E_DATA_FIELD")

    def test_missing_record_field(self):
        spec = fixture()
        del spec["datasets"]["rooms"]["rows"][1]["description"]
        self.reject(spec, "E_FIELD_MISSING", "/datasets/rooms/rows/1/description")

    def test_wrong_record_field_type(self):
        spec = fixture()
        spec["datasets"]["rooms"]["rows"][1]["title"] = 42
        self.reject(spec, "E_TYPE", "/datasets/rooms/rows/1/title")

    def test_duplicate_id(self):
        spec = fixture()
        spec["pages"][0]["root"]["children"].append(copy.deepcopy(spec["pages"][0]["root"]["children"][0]))
        self.reject(spec, "E_DUPLICATE_ID")

    def test_duplicate_record_key(self):
        spec = fixture()
        spec["datasets"]["rooms"]["rows"][1]["id"] = "room-a"
        self.reject(spec, "E_DATA_KEY")

    def test_unknown_component(self):
        spec = fixture()
        spec["pages"][0]["root"]["children"][1]["template"]["component"] = "Unknown"
        self.reject(spec, "E_COMPONENT")

    def test_missing_component_argument(self):
        spec = fixture()
        spec["pages"][0]["root"]["children"][1]["template"]["args"] = {}
        self.reject(spec, "E_ARGUMENT")

    def test_component_cycle(self):
        spec = fixture()
        spec["components"]["RoomCard"]["root"] = {"type": "use", "id": "cycle", "component": "RoomCard", "args": {"item": {"$": "item"}}}
        self.reject(spec, "E_COMPONENT_CYCLE")

    def test_unknown_target(self):
        spec = fixture("survey")
        spec["pages"][0]["on"]["load"][0]["target"] = {"ref": "absent"}
        self.reject(spec, "E_REFERENCE", "/pages/0/on/load/0/target")

    def test_unknown_theme_and_color_are_not_silently_replaced(self):
        spec = fixture()
        spec["theme"] = "mobile-unknown"
        self.reject(spec, "E_THEME", "/theme")
        spec = fixture()
        spec["pages"][0]["root"]["fill"] = "$missing"
        self.reject(spec, "E_COLOR", "/pages/0/root/fill")

    def test_binding_default_is_visible_in_compiled_source(self):
        lowered, _ = compile_language(fixture())
        self.assertEqual(lowered["pages"][1]["root"]["children"][1]["text"], "图书馆研讨室 A")

    def test_compile_does_not_mutate_source(self):
        spec = fixture()
        before = copy.deepcopy(spec)
        compile_language(spec)
        self.assertEqual(spec, before)

    def test_wrong_target_type(self):
        spec = fixture("survey")
        spec["pages"][0]["on"]["load"][0]["target"] = {"ref": "root"}
        self.reject(spec, "E_TARGET_TYPE")

    def test_widget_actions_cannot_cross_pages(self):
        spec = fixture()
        spec["pages"][0]["on"] = {"load": [{"type": "set-text", "target": {"ref": "detail/title"}, "text": "bad"}]}
        self.reject(spec, "E_ACTION_SCOPE")

    def test_unknown_action(self):
        spec = fixture("survey")
        spec["pages"][0]["on"]["load"][0]["type"] = "teleport"
        self.reject(spec, "E_ACTION")

    def test_native_input_events_only(self):
        spec = fixture("survey")
        spec["pages"][0]["root"]["children"][0]["on"] = {"change": [{"type": "wait", "ms": 1}]}
        self.reject(spec, "E_EVENT_TARGET")

    def test_variable_type(self):
        spec = fixture("survey")
        spec["variables"]["answer"]["value"] = True
        self.reject(spec, "E_TYPE")

    def test_duplicate_variable_case(self):
        spec = fixture("survey")
        spec["variables"]["Answer"] = {"type": "text", "value": "none"}
        self.reject(spec, "E_VARIABLE")

    def test_bad_binding_default(self):
        spec = fixture()
        spec["variables"]["selectedItem"]["value"] = "missing"
        self.reject(spec, "E_BINDING_DEFAULT")

    def test_binding_cannot_reference_missing_field(self):
        spec = fixture()
        spec["pages"][1]["bindings"][0]["targets"]["category"] = "categoryTypo"
        self.reject(spec, "E_DATA_FIELD")

    def test_state_must_belong_to_target_panel(self):
        spec = fixture()
        spec["pages"][2]["root"]["children"][2]["states"][0]["root"]["children"][-1]["on"]["click"]["cases"][1]["actions"][1]["state"] = "missing"
        self.reject(spec, "E_STATE")

    def test_comparison_type_mismatch(self):
        spec = fixture("survey")
        spec["pages"][0]["root"]["children"][-1]["on"]["click"]["cases"][0]["when"]["right"] = 1
        self.reject(spec, "E_TYPE")

    def test_unsupported_target_version(self):
        spec = fixture()
        spec["target"] = 11
        self.reject(spec, "E_TARGET_UNSUPPORTED", "/target")

    def test_ai_native_sugar_desugaring(self):
        standard = sugar_fixture()
        standard["pages"][0]["root"]["children"][2]["on"] = {"click": {"cases": [{"actions": [
            {"type": "set-variable", "variable": "answer", "value": "yes"},
            {"type": "set-text", "target": {"ref": "status"}, "text": "完成"},
            {"type": "set-variable", "variable": "count", "value": 1},
            {"type": "set-panel-state", "target": {"ref": "receipt"}, "state": "done"},
            {"type": "show", "target": {"ref": "status"}},
            {"type": "hide", "target": {"ref": "status"}},
            {"type": "toggle", "target": {"ref": "status"}},
        ]}]}}
        sugar = copy.deepcopy(standard)
        children = sugar["pages"][0]["root"]["children"]
        children[1]["text"] = "已选：${$answer}"
        button = children[2]
        button["button"] = button.pop("id")
        del button["type"], button["on"]
        button["onClick"] = [
            {"set": {"$answer": "yes", "@status": "完成"}},
            {"set-variable": "count", "value": 1},
            {"state": ["receipt", "done"]},
            {"show": "status"}, {"hide": "status"}, {"toggle": "status"},
        ]
        before = copy.deepcopy(sugar)
        self.assertEqual(compile_language(sugar), compile_language(standard))
        self.assertEqual(sugar, before)
        frontend = Frontend(standard)
        frontend.compile()
        self.assertEqual(frontend.action({"set": {"$answer": "yes", "@status": "完成"}}, "main", "/action"),
                         [frontend.action(a, "main", "/action") for a in
                          standard["pages"][0]["root"]["children"][2]["on"]["click"]["cases"][0]["actions"][:2]])

    def test_ai_native_action_aliases(self):
        aliases = [
            ({"set": {"$answer": "yes"}}, {"type": "set-variable", "variable": "answer", "value": "yes"}),
            ({"set-variable": "answer", "value": "yes"}, {"type": "set-variable", "variable": "answer", "value": "yes"}),
            ({"set": {"@status": "ok"}}, {"type": "set-text", "target": {"ref": "status"}, "text": "ok"}),
            ({"set": {"status": "ok"}}, {"type": "set-text", "target": {"ref": "status"}, "text": "ok"}),
            ({"state": ["receipt", "done"]}, {"type": "set-panel-state", "target": {"ref": "receipt"}, "state": "done"}),
            ({"set-state": ["receipt", "done"]}, {"type": "set-panel-state", "target": {"ref": "receipt"}, "state": "done"}),
            *[({kind: "status"}, {"type": kind, "target": {"ref": "status"}}) for kind in ("show", "hide", "toggle")],
        ]
        frontend = Frontend(sugar_fixture())
        frontend.compile()
        for alias, action in aliases:
            with self.subTest(alias=alias, form="direct"):
                self.assertEqual(frontend.action(alias, "main", "/action"), frontend.action(action, "main", "/action"))
            for form in ("single", "array", "cases"):
                with self.subTest(alias=alias, form=form):
                    standard, sugar = sugar_fixture(), sugar_fixture()
                    standard["pages"][0]["root"]["children"][2]["on"] = {"click": [action]}
                    value = alias if form == "single" else [alias] if form == "array" else {"cases": [{"actions": [alias]}]}
                    sugar["pages"][0]["root"]["children"][2]["on"] = {"click": value}
                    self.assertEqual(compile_language(sugar), compile_language(standard))

    def test_ai_native_event_shorthands(self):
        for shorthand, event, index in (
            ("onClick", "click", 2), ("onChange", "change", 0), ("onLoad", "load", 1),
            ("onMouseOver", "mouseover", 2), ("onMouseOut", "mouseout", 2),
            ("onFocus", "focus", 0), ("onBlur", "blur", 0), ("onStateChange", "statechange", 3),
        ):
            with self.subTest(event=shorthand):
                standard = sugar_fixture()
                node = standard["pages"][0]["root"]["children"][index]
                node["on"] = {"load" if event == "click" else "click": [{"type": "wait", "ms": 1}]}
                sugar = copy.deepcopy(standard)
                node["on"][event] = [{"type": "wait", "ms": 2}]
                sugar["pages"][0]["root"]["children"][index][shorthand] = {"type": "wait", "ms": 2}
                self.assertEqual(compile_language(sugar), compile_language(standard))
        standard, sugar = sugar_fixture(), sugar_fixture()
        standard["pages"][0]["on"] = {"load": [{"type": "set-variable", "variable": "count", "value": 1}]}
        sugar["pages"][0]["on"] = {"load": {"set-variable": "count", "value": 1}}
        self.assertEqual(compile_language(sugar), compile_language(standard))

    def test_ai_native_conditional_actions(self):
        standard = sugar_fixture()
        standard["pages"][0]["root"]["children"][2]["on"] = {"click": {"cases": [
            {"when": {"op": "!=", "left": {"widget": {"ref": "title"}}, "right": ""},
             "actions": [{"type": "set-variable", "variable": "answer", "value": "yes"},
                         {"type": "set-panel-state", "target": {"ref": "receipt"}, "state": "done"}]},
            {"else": True, "actions": [{"type": "set-text", "target": {"ref": "status"}, "text": "请输入书名"}]},
        ]}}
        sugar = copy.deepcopy(standard)
        button = sugar["pages"][0]["root"]["children"][2]
        button["onClick"] = {"cases": [
            {"when": "@title != ''", "actions": [{"set": {"$answer": "yes"}}, {"set-state": ["receipt", "done"]}]},
            {"else": True, "actions": [{"set": {"status": "请输入书名"}}]},
        ]}
        del button["on"]
        self.assertEqual(compile_language(sugar), compile_language(standard))

    def test_ai_native_sugar_diagnostics(self):
        for action, code in (
            ({"set": {}}, "E_ACTION"), ({"set": []}, "E_ACTION"),
            ({"set": {"$answer": "yes"}, "typo": True}, "E_PROPERTY"),
            ({"set": {"$missing": "yes"}}, "E_VARIABLE"),
            ({"set-variable": "count", "value": "bad"}, "E_TYPE"),
            ({"set-variable": "answer", "value": "yes", "typo": True}, "E_PROPERTY"),
            ({"set": {"@missing": "ok"}}, "E_REFERENCE"),
            ({"set": {"receipt": "ok"}}, "E_TARGET_TYPE"),
            ({"set-state": ["receipt", "missing"]}, "E_STATE"),
            ({"state": ["receipt"]}, "E_ACTION"),
            ({"show": "status", "typo": True}, "E_PROPERTY"),
            ({"type": "wait", "ms": 1, "show": "status"}, "E_PROPERTY"),
        ):
            with self.subTest(action=action):
                spec = sugar_fixture()
                spec["pages"][0]["root"]["children"][2]["onClick"] = action
                self.reject(spec, code)

    def test_ai_native_event_conflicts(self):
        for declarations in (None, [], "bad"):
            with self.subTest(on=declarations):
                spec = sugar_fixture()
                button = spec["pages"][0]["root"]["children"][2]
                button.update(on=declarations, onClick={"show": "status"})
                self.reject(spec, "E_EVENT", "/pages/0/root/children/2/on")
        for event in ("click", "OnClick"):
            with self.subTest(event=event):
                spec = sugar_fixture()
                button = spec["pages"][0]["root"]["children"][2]
                button.update(on={event: [{"hide": "status"}]}, onClick={"show": "status"})
                self.reject(spec, "E_EVENT", "/pages/0/root/children/2/onClick")
        for event in ("onChange", "onStateChange"):
            with self.subTest(event=event):
                spec = sugar_fixture()
                spec["pages"][0]["root"]["children"][2][event] = {"type": "wait", "ms": 1}
                self.reject(spec, "E_EVENT_TARGET", "/pages/0/root/children/2/on")

    def test_lexical_item_binding_and_repeater_shadowing(self):
        spec = fixture("booking")
        spec["components"]["RoomCard"]["root"]["children"][0]["text"] = "${item.title} (${param.item.category})"
        lowered, _ = compile_language(spec)
        first_card = lowered["pages"][0]["root"]["children"][1]["children"][0]
        self.assertEqual(first_card["children"][0]["text"], "图书馆研讨室 A (四人间)")

    def test_semantic_business_macros(self):
        spec = {
            "language": "rp/1", "target": 9, "theme": "enterprise-light", "domain": "web",
            "datasets": {"books": [{"id": "b1", "title": "编译原理", "cat": "CS"}, {"id": "b2", "title": "操作系统", "cat": "CS"}]},
            "pages": [{"id": "console", "root": {"column": "root", "children": [
                {"type": "data-table", "id": "tbl", "dataset": "books", "columns": [
                    {"header": "编号", "field": "id", "w": 80},
                    {"header": "书名", "field": "title", "flex": 1},
                ]},
                {"type": "searchable-list", "id": "slist", "dataset": "books", "searchField": "title",
                 "filters": ["全部", "CS"], "template": {"label": "rowTitle", "text": "${item.title}"}},
                {"type": "form-card", "id": "fcard", "title": "新增", "fields": [{"id": "inpTitle", "label": "书名"}], "submitText": "保存"},
                {"type": "kv-list", "id": "kv", "items": [{"label": "馆藏", "value": "2 册"}]},
            ]}}],
        }
        lowered, ir = compile_language(spec)
        sym_ids = {s["id"] for s in ir["symbols"]}
        self.assertIn("console/tbl", sym_ids)
        self.assertIn("console/slist", sym_ids)
        self.assertIn("console/fcard", sym_ids)
        self.assertIn("console/kv", sym_ids)

    def test_reference_runtime_and_simulate_spec(self):
        spec = json.loads((ROOT / "examples/rp-language/runtime-inventory.json").read_text())
        sim = simulate_spec(spec, [
            {"target": "increment", "event": "click"},
            {"input": "newId", "value": "9"},
            {"input": "newTitle", "value": "新设备"},
            {"input": "newQty", "value": "99"},
            {"target": "add", "event": "click"},
        ])
        self.assertEqual(sim["final"]["variables"]["count"], 1)
        rep_rows = next(iter(sim["final"]["repeaters"].values()))
        self.assertTrue(any(r["id"] == "9" and r["title"] == "新设备" and r["qty"] == 99 for r in rep_rows))

    def test_bounded_state_space_path_explorer(self):
        report = explore_state_space(fixture("booking"), max_depth=3, max_states=16)
        self.assertGreaterEqual(report["statesExplored"], 2)
        self.assertEqual(report["coverage"]["pages"]["total"], 3)
        self.assertGreaterEqual(report["coverage"]["pages"]["covered"], 2)
        self.assertIn("detail", report["shortestPaths"]["pages"])
        self.assertTrue(report["shortestPaths"]["pages"]["detail"])

    def test_inspect_explain_patch_and_complete_engine(self):
        spec = sugar_fixture()
        spec["pages"][0]["root"]["children"][2]["onClick"] = [
            {"set": {"$answer": "${@title}"}},
            {"state": ["receipt", "done"]},
        ]
        inspected = inspect_spec(spec)
        self.assertTrue(inspected["dependencies"]["variables"]["answer"]["writers"])
        explained = explain_spec(spec, "main/status")
        self.assertEqual(explained["symbol"]["id"], "main/status")
        self.assertIn("main/status", explained["scopeChain"])
        patched = patch_spec(
            spec,
            [{"op": "replace", "path": "/pages/0/root/children/2/text", "oldValue": "应用", "value": "立即提交"}],
            expected_hash=inspected["semanticHash"],
        )
        self.assertNotEqual(patched["diff"]["beforeHash"], patched["diff"]["afterHash"])
        with self.assertRaises(LanguageError) as err:
            patch_spec(spec, [{"op": "replace", "path": "/pages/0/root/children/2/text", "value": "x"}], expected_hash="stale")
        self.assertEqual(err.exception.diagnostic["code"], "E_PATCH_CONFLICT")
        comp = complete_spec(spec, "/pages/0/root/children/2")
        self.assertIn("$answer", comp["variables"])
        self.assertIn("@title", comp["widgets"])
        self.assertIn("receipt", comp["panelStates"])

    def test_when_mutual_exclusion_space_sharing(self):
        import proto
        spec = {
            "language": "rp/1",
            "target": 9,
            "theme": "enterprise-light",
            "domain": "web",
            "datasets": {
                "nodes": [
                    {"id": "n1", "name": "核心网关 A", "status": "就绪"},
                    {"id": "n2", "name": "边缘网关 B", "status": "隔离"},
                ]
            },
            "pages": [
                {
                    "id": "cluster",
                    "name": "集群节点列表",
                    "canvas": {"w": 480, "h": 360},
                    "root": {
                        "column": "main",
                        "w": 480,
                        "h": 360,
                        "padding": 16,
                        "gap": 12,
                        "fill": "$bg",
                        "children": [
                            {
                                "type": "repeater",
                                "id": "nodeList",
                                "dataset": "nodes",
                                "w": 240,
                                "h": 120,
                                "rowHeight": 48,
                                "rowGap": 8,
                                "template": {
                                    "row": "itemRow",
                                    "w": 240,
                                    "h": 48,
                                    "padding": 8,
                                    "gap": 8,
                                    "fill": "$surface",
                                    "stroke": "$line",
                                    "radius": 6,
                                    "children": [
                                        {
                                            "label": "nodeName",
                                            "text": "${item.name}",
                                            "w": 136,
                                            "h": 32,
                                        },
                                        {
                                            "button": "btnIsolate",
                                            "text": "隔离",
                                            "w": 72,
                                            "h": 32,
                                            "variant": "danger",
                                            "when": "[[Item.status == '就绪']]",
                                        },
                                        {
                                            "button": "btnReady",
                                            "text": "就绪",
                                            "w": 72,
                                            "h": 32,
                                            "variant": "primary",
                                            "when": "[[Item.status != '就绪']]",
                                        },
                                    ],
                                },
                            },
                            {
                                "row": "statusBanner",
                                "h": 40,
                                "padding": 4,
                                "gap": 8,
                                "children": [
                                    {
                                        "type": "when",
                                        "id": "whenBanner",
                                        "condition": {"left": "就绪", "op": "==", "right": "就绪"},
                                        "then": {"badge": "bdgOk", "text": "正常", "w": 64, "h": 24},
                                        "else": {"badge": "bdgErr", "text": "异常", "w": 80, "h": 24},
                                    },
                                    {
                                        "button": "btnIndependentA",
                                        "text": "A",
                                        "w": 48,
                                        "h": 28,
                                        "when": {"left": "1", "op": "==", "right": "1"},
                                    },
                                    {
                                        "button": "btnIndependentB",
                                        "text": "B",
                                        "w": 48,
                                        "h": 28,
                                        "when": {"left": "2", "op": "==", "right": "2"},
                                    },
                                ],
                            },
                        ],
                    },
                }
            ],
        }
        lowered, _ = compile_language(spec)
        rep_tpl = lowered["pages"][0]["root"]["children"][0]["template"]
        btn_iso = rep_tpl["children"][1]
        btn_rdy = rep_tpl["children"][2]
        self.assertIsNotNone(btn_iso.get("_when_group"))
        self.assertEqual(btn_iso.get("_when_group"), btn_rdy.get("_when_group"))
        self.assertNotEqual(btn_iso.get("_when_branch"), btn_rdy.get("_when_branch"))
        self.assertEqual(btn_iso.get("_row_visibles"), [True, False])
        self.assertEqual(btn_rdy.get("_row_visibles"), [False, True])

        banner_children = lowered["pages"][0]["root"]["children"][1]["children"]
        when_box_children = banner_children[0]["children"]
        self.assertEqual(when_box_children[0].get("_when_group"), when_box_children[1].get("_when_group"))
        # Independent non-exclusive when conditions must NOT share a slot
        self.assertIsNone(banner_children[1].get("_when_group"))
        self.assertIsNone(banner_children[2].get("_when_group"))

        theme = proto.THEMES["enterprise-light"]
        root = proto.expand_declarative_tree(lowered["pages"][0]["root"], prefix="cluster")
        proto.ensure_unique_names(root, scope_prefix="cluster")
        proto.measure_node(root, available_w=480)
        proto.layout_node(root, 0, 0, 480, 360)
        emitted = proto.emit_tree_to_axvg(root, theme, include_dynamic_panel_placeholders=True)
        audit = proto.audit_prototype(root, emitted, lowered, strict_audit=False)
        self.assertTrue(audit["gates"]["no_container_overflow"], audit["failures"])
        self.assertTrue(audit["gates"]["no_box_overlap"], audit["failures"])
        self.assertTrue(audit["gates"]["no_text_overlap"], audit["failures"])
        self.assertTrue(audit["ok"], audit["failures"])

        exp_tpl = root["children"][0]["template"]
        proto.measure_node(exp_tpl, available_w=240)
        proto.layout_node(exp_tpl, 0, 0, 240, 48)
        emitted_tpl = proto.emit_tree_to_axvg(exp_tpl, theme, include_dynamic_panel_placeholders=True, canvas_background=False)
        audit_tpl = proto.audit_prototype(exp_tpl, emitted_tpl, {"domain": "web", "theme": "enterprise-light", "auditScope": "container-local"}, strict_audit=False)
        self.assertTrue(audit_tpl["gates"]["no_container_overflow"], audit_tpl["failures"])
        self.assertTrue(audit_tpl["gates"]["no_box_overlap"], audit_tpl["failures"])
        self.assertTrue(audit_tpl["gates"]["no_text_overlap"], audit_tpl["failures"])
        self.assertEqual(exp_tpl["children"][1]["_x"], exp_tpl["children"][2]["_x"])
        self.assertEqual(exp_tpl["children"][1]["_y"], exp_tpl["children"][2]["_y"])
        # Non-mutually-exclusive buttons in statusBanner must have distinct x coordinates
        exp_banner = root["children"][1]
        exp_when_box = exp_banner["children"][0]
        self.assertEqual(exp_when_box["_w"], 80)  # max(64, 80) instead of 64 + 6 + 80 = 150
        self.assertEqual(exp_when_box["children"][0]["_x"], exp_when_box["children"][1]["_x"])
        self.assertNotEqual(exp_banner["children"][1]["_x"], exp_banner["children"][2]["_x"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
