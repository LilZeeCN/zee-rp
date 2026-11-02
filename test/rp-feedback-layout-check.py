#!/usr/bin/env python3
"""Regression contracts for paragraph sizing and independent scene audits."""
import copy
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import proto


def label(name, text='正常文字', **props):
    return {'type': 'label', 'name': name, 'text': text, 'fontSize': 12,
            'w': 160, 'h': 24, **props}


def box(name, children, **props):
    return {'type': 'box', 'name': name, 'layout': 'column', 'isGroup': True,
            'children': children, **props}


def spec(root, width=375, height=500):
    return {'name': 'feedback layout', 'theme': 'enterprise-light', 'domain': 'test',
            'static': True, 'pages': [{'name': 'Main', 'slug': 'main',
            'canvas': {'w': width, 'h': height}, 'root': root}]}


def compile_fixture(source):
    with tempfile.TemporaryDirectory(prefix='rp-feedback-layout-') as directory:
        result = proto.compile_spec_bundle(copy.deepcopy(source), directory)
        plan = json.loads((Path(directory) / 'compile-plan.json').read_text())
        state_specs = {p.name: json.loads(p.read_text())
                       for p in (Path(directory) / 'states').glob('*.spec.json')}
        return result, plan, state_specs


class LayoutFeedbackContract(unittest.TestCase):
    def paragraph(self, **props):
        return {'type': 'paragraph', 'name': 'txt-description', 'fontSize': 12,
                'text': '这是一段用于检查行间距和文字重叠的说明文字。' * 4,
                'w': 319, **props}

    def test_line_gap_is_space_between_ink_lines_and_fixed_height_is_preserved(self):
        root = box('grp-root', [self.paragraph(lineGap=6, h=96)])
        result, plan, _ = compile_fixture(spec(root))
        rows = [x for x in plan['pages'][0]['allMainWidgets']
                if x['name'].startswith('txt-description-l')]
        self.assertGreater(len(rows), 1)
        self.assertEqual(rows[1]['y'] - rows[0]['y'], 18)
        self.assertTrue(all(row['h'] >= 12 for row in rows))
        self.assertTrue(result['structural_ok'], result['audit']['failures'])
        paragraph = root['children'][0]
        proto.measure_node(paragraph)
        self.assertEqual(paragraph['_mh'], 96)

    def test_hug_and_fixed_height_have_distinct_contracts(self):
        fixed = self.paragraph(h=10, lineHeight=18)
        hug = self.paragraph(h='hug', lineHeight=18)
        proto.measure_node(fixed)
        proto.measure_node(hug)
        self.assertEqual(fixed['_mh'], 10)
        self.assertGreater(hug['_mh'], fixed['_mh'])
        result, _, _ = compile_fixture(spec(box('grp-root', [fixed])))
        self.assertFalse(result['structural_ok'])
        self.assertTrue(any(x['gate'] == 'no_container_overflow'
                            for x in result['audit']['failures']))

    def test_fill_paragraph_reflows_after_parent_width_allocation(self):
        text = '用于真实分配宽度的段落测试文字。' * 5
        root = box('grp-root', [box('grp-row', [
            box('grp-fixed', [], w=100, h=20),
            box('grp-flex', [self.paragraph(w='fill', h='hug', text=text)],
                w='fill', padding=12, gap=8),
        ], layout='row', w='fill', h='hug', gap=12)], w='fill', h='fill', padding=16)
        result, plan, _ = compile_fixture(spec(root, width=375))
        rows = [x for x in plan['pages'][0]['allMainWidgets']
                if x['name'].startswith('txt-description-l')]
        assigned_width = 375 - 32 - 100 - 12 - 24
        expected = proto.wrap_text(text, assigned_width - 4, 12, 400)
        self.assertEqual([row['text'] for row in rows], expected)
        self.assertTrue(all(row['w'] == assigned_width for row in rows))
        self.assertEqual(result['audit']['metrics']['text_clip_count'], 0)
        self.assertEqual(result['audit']['metrics']['container_overflow_count'], 0)

    def test_actual_ink_height_and_overlap_are_audited(self):
        root = box('grp-root', [label('txt-a', h=6), label('txt-b', h=6)])
        result, _, _ = compile_fixture(spec(root))
        self.assertFalse(result['structural_ok'])
        self.assertGreater(result['audit']['metrics']['text_clip_count'], 0)
        self.assertGreater(result['audit']['metrics']['text_overlap_count'], 0)
        failure = next(f for f in result['audit']['failures'] if f['gate'] == 'no_text_clip')
        self.assertIn('inkBox', failure)
        self.assertIn('needed_h', failure)

    def panel_fixture(self, bad=False):
        state_a = box('grp-ready', [label('txt-ready')])
        state_b = box('grp-detail', [label('txt-detail', h=6 if bad else 24)])
        panel = {'type': 'dynamic-panel', 'name': 'panel-detail', 'w': 319, 'h': 220,
                 'states': [{'name': 'ready', 'tree': state_a},
                            {'name': 'detail', 'tree': state_b}]}
        return spec(box('grp-root', [label('txt-heading'), panel], gap=12))

    def test_nondefault_state_failures_reach_overall_report_and_scene_manifest(self):
        result, plan, _ = compile_fixture(self.panel_fixture(bad=True))
        self.assertFalse(result['structural_ok'])
        self.assertGreater(result['audit']['metrics']['text_clip_count'], 0)
        scenes = result['audit']['scenes']
        detail = next(s for s in scenes if s.get('state') == 'detail')
        self.assertEqual(detail['status'], 'fail')
        self.assertTrue(any(f.get('sceneId') == detail['id'] for f in result['audit']['failures']))
        self.assertEqual(result['audit']['sceneCoverage']['expected'], len(scenes))
        self.assertEqual(result['audit']['sceneCoverage']['audited'], len(scenes))
        self.assertEqual(plan['sceneCoverage'], result['audit']['sceneCoverage'])

    def test_mutually_exclusive_states_are_not_flattened_together_and_na_has_no_percentage(self):
        result, _, _ = compile_fixture(self.panel_fixture())
        self.assertTrue(result['structural_ok'], result['audit']['failures'])
        self.assertEqual(result['audit']['metrics']['text_overlap_count'], 0)
        self.assertIsNone(result['audit']['metrics']['four_state_coverage_pct'])
        check = result['audit']['coverage']['fourState']
        self.assertEqual(check['status'], 'not-applicable')
        self.assertEqual(check['applicable'], 0)
        self.assertIsNone(check['percentage'])

    def test_nested_panel_and_row_template_are_audited_independently(self):
        nested = {'type': 'dynamic-panel', 'name': 'panel-inner', 'w': 180, 'h': 50,
                  'states': [{'name': 'one', 'tree': box('grp-one', [label('txt-inner')])},
                             {'name': 'two', 'tree': box('grp-two', [label('txt-inner-bad', h=6)])}]}
        repeater = {'type': 'repeater', 'name': 'list-books', 'w': 200, 'h': 80,
                    'rowHeight': 24, 'rowGap': 0, 'pageSize': 1,
                    'model': {'id': 'text'}, 'rows': [{'id': '1'}],
                    'template': box('grp-item', [label('txt-item')])}
        outer = {'type': 'dynamic-panel', 'name': 'panel-outer', 'w': 220, 'h': 180,
                 'states': [{'name': 'ready', 'tree': box('grp-outer-ready', [])},
                            {'name': 'nested', 'tree': box('grp-outer-nested', [nested, repeater], gap=12)}]}
        result, _, _ = compile_fixture(spec(box('grp-root', [label('txt-heading'), outer])))
        scenes = result['audit']['scenes']
        self.assertTrue(any(s.get('state') == 'two' and s['status'] == 'fail' for s in scenes))
        self.assertTrue(any(s['kind'] == 'repeater-template' for s in scenes))
        self.assertFalse(result['structural_ok'])

    def test_explicit_line_height_wins_and_small_line_boxes_are_not_silently_enlarged(self):
        paragraph = self.paragraph(lineHeight=6, lineGap=20, h="hug")
        result, plan, _ = compile_fixture(spec(box("grp-root", [paragraph])))
        rows = [x for x in plan["pages"][0]["allMainWidgets"] if x["name"].startswith("txt-description-l")]
        self.assertEqual(rows[1]["y"] - rows[0]["y"], 6)
        self.assertFalse(result["structural_ok"])
        self.assertGreater(result["audit"]["metrics"]["text_clip_count"], 0)

    def test_modal_is_a_separate_audited_scene(self):
        modal = box("grp-dialog", [label("txt-dialog-bad", h=6)], w=220, h=100, isModal=True)
        result, _, _ = compile_fixture(spec(box("grp-root", [label("txt-page"), modal])))
        page = next(scene for scene in result["audit"]["scenes"] if scene["kind"] == "page-default")
        dialog = next(scene for scene in result["audit"]["scenes"] if scene["kind"] == "modal")
        self.assertEqual(page["status"], "pass")
        self.assertEqual(dialog["status"], "fail")
        self.assertFalse(result["structural_ok"])

    def test_registered_but_unaudited_scene_cannot_pass(self):
        summary = proto.summarize_scene_audits([{"id": "missing", "kind": "panel-state", "status": "not-run"}])
        self.assertFalse(summary["ok"])
        self.assertFalse(summary["structural_gates"]["scene_audits_complete"])
        self.assertEqual(summary["sceneCoverage"]["expected"], 1)
        self.assertEqual(summary["sceneCoverage"]["audited"], 0)
        self.assertEqual(summary["sceneCoverage"]["status"], "not-run")
        self.assertEqual(summary["scenes"][0]["status"], "not-run")

    def test_empty_state_is_not_a_false_failure(self):
        result, _, _ = compile_fixture(spec(box("grp-root", [label("txt-heading"), {
            "type": "dynamic-panel", "name": "panel-empty", "w": 200, "h": 100,
            "states": [{"name": "blank", "tree": box("grp-blank", [])}],
        }])))
        blank = next(scene for scene in result["audit"]["scenes"] if scene.get("state") == "blank")
        self.assertEqual(blank["status"], "pass", blank["audit"]["failures"])
        self.assertEqual(blank["audit"]["coverage"]["semanticNaming"]["status"], "not-applicable")
        self.assertEqual(blank["audit"]["coverage"]["groupCoverage"]["applicable"], 0)

    def test_legacy_preset_uses_the_same_scene_audit_contract(self):
        build = proto.build_flagship_prototype
        def poisoned(*args, **kwargs):
            root, theme = build(*args, **kwargs)
            def first_label(tree):
                if tree.get("type") == "label" and tree.get("text"):
                    tree["h"] = 6
                    return True
                return any(first_label(child) for child in tree.get("children", []))
            def find_panel(tree):
                if tree.get("type") == "dynamic-panel":
                    return first_label(tree["states"][1]["tree"])
                return any(find_panel(child) for child in tree.get("children", []))
            self.assertTrue(find_panel(root))
            return root, theme
        with tempfile.TemporaryDirectory(prefix="rp-feedback-legacy-") as directory:
            with mock.patch.object(proto, "build_flagship_prototype", side_effect=poisoned):
                result = proto.compile_prototype_bundle(directory)
            self.assertFalse(result["audit"]["structural_ok"])
            self.assertGreater(result["audit"]["metrics"]["text_clip_count"], 0)
            self.assertGreater(result["audit"]["sceneCoverage"]["audited"], 1)
            self.assertTrue((Path(directory) / "page-main.axvg.json").exists())
            self.assertTrue(any(scene["kind"] == "modal" for scene in result["audit"]["scenes"]))

    def test_single_leaf_repeater_template_has_no_grouping_obligation(self):
        repeater = {"type": "repeater", "name": "list-single", "w": 200, "h": 80,
                    "rowHeight": 24, "rowGap": 0, "pageSize": 1,
                    "model": {"id": "text"}, "rows": [{"id": "1"}],
                    "template": label("txt-single-row")}
        result, _, _ = compile_fixture(spec(box("grp-root", [label("txt-heading"), repeater])))
        scene = next(s for s in result["audit"]["scenes"] if s["kind"] == "repeater-template")
        self.assertEqual(scene["status"], "pass", scene["audit"]["failures"])
        self.assertEqual(scene["audit"]["coverage"]["groupCoverage"]["status"], "not-applicable")
        self.assertIsNone(scene["audit"]["metrics"]["group_coverage_pct"])
        self.assertEqual(scene["audit"]["coverage"]["semanticNaming"]["applicable"], 1)
        self.assertEqual(result["audit"]["sceneCoverage"]["status"], "complete")
        self.assertEqual(result["audit"]["sceneCoverage"]["resultStatus"], "pass")

    def test_pin_bottom_and_top_edges(self):
        root = {"type": "box", "id": "root", "layout": "stack", "w": 300, "h": 300, "padding": 10,
                "children": [
                    {"type": "box", "id": "foot", "pin": "bottom", "pinGap": 12, "w": 280, "h": 30, "fill": "#EEE"},
                    {"type": "box", "id": "head", "pin": "top", "pinGap": 4, "w": 280, "h": 20, "fill": "#EEE"},
                    {"type": "box", "id": "side", "pin": "right", "pinGap": 6, "w": 40, "h": 40, "fill": "#DDD"},
                ]}
        root = proto.expand_declarative_tree(copy.deepcopy(root), prefix="t")  # pin 在展开阶段翻译成贴边坐标
        proto.measure_node(root, available_w=300)
        proto.layout_node(root, 0, 0, 300, 300)
        nodes = {c["id"]: c for c in root["children"]}
        self.assertEqual(nodes["foot"]["_y"], 10 + 280 - 30 - 12)
        self.assertEqual(nodes["head"]["_y"], 10 + 4)
        self.assertEqual(nodes["side"]["_x"], 10 + 280 - 40 - 6)

    def test_constraints_survive_badge_expansion(self):
        root = {"type": "box", "id": "root", "layout": "stack", "w": 300, "h": 300, "padding": 10,
                "children": [
                    {"type": "label", "id": "a", "x": 0, "y": 0, "w": 120, "h": 24, "text": "A", "fontSize": 13},
                    {"type": "badge", "id": "p", "after": "a", "afterGap": 8, "alignX": "center",
                     "w": 100, "h": 22, "text": "P", "fontSize": 10},
                ]}
        expanded = proto.expand_declarative_tree(copy.deepcopy(root), prefix="t")
        proto.measure_node(expanded, available_w=300)
        proto.layout_node(expanded, 0, 0, 300, 300)
        nodes = {c.get("id"): c for c in expanded["children"]}
        self.assertIn("p", nodes, "badge 展开后必须保留逻辑 id，after 才能命中")
        self.assertEqual(nodes["p"]["_y"], 10 + 24 + 8)


class CliCheckDiagnostics(unittest.TestCase):
    """check 命令在布局失败时必须给出理由，而不是只回 ok:false。"""

    def _run_check(self, source):
        with tempfile.TemporaryDirectory(prefix="rp-check-diag-") as directory:
            source = {"language": "rp/1", "target": 9, **source}
            spec_path = Path(directory) / "spec.json"
            spec_path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
            proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "proto.py"), "check", "--spec", str(spec_path)],
                                  capture_output=True, text=True)
        return proc, json.loads(proc.stdout or proc.stderr)

    def test_overlapping_labels_report_e_layout_with_page(self):
        root = {"type": "box", "id": "root", "layout": "stack", "w": 300, "h": 300, "fill": "#FFFFFF",
                "children": [
                    {"type": "label", "id": "a", "text": "第一行标题", "x": 20, "y": 40, "w": 240, "h": 24,
                     "fontSize": 20, "fontWeight": 700, "color": "#15181B"},
                    {"type": "label", "id": "b", "text": "第二行紧贴上来", "x": 20, "y": 52, "w": 240, "h": 20,
                     "fontSize": 14, "color": "#15181B"},
                ]}
        proc, payload = self._run_check(spec(root))
        self.assertNotEqual(proc.returncode, 0, "布局失败时 check 应返回非零退出码")
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["diagnostics"], "check 失败必须带 diagnostics，不能只回 ok:false")
        self.assertEqual(payload["diagnostics"][0]["code"], "E_LAYOUT")
        self.assertTrue(payload["diagnostics"][0].get("pageName"))

    def test_clean_page_reports_no_diagnostics(self):
        root = {"type": "box", "id": "root", "layout": "column", "w": 300, "h": 300, "padding": 16, "gap": 12,
                "fill": "#FFFFFF", "children": [
                    {"type": "label", "id": "a", "text": "标题", "fontSize": 18, "fontWeight": 700, "w": "fill"},
                    {"type": "label", "id": "b", "text": "正文说明文字", "fontSize": 13, "w": "fill"},
                    {"type": "label", "id": "c", "text": "第二段正文", "fontSize": 13, "w": "fill"},
                    {"type": "box", "id": "blk", "w": "fill", "h": 120, "fill": "#EEF2F7", "radius": 12}]}
        proc, payload = self._run_check(spec(root))
        self.assertEqual(proc.returncode, 0, payload.get("warnings"))
        self.assertEqual(payload["diagnostics"], [])


class StackConstraints(unittest.TestCase):
    """after / afterGap / alignX：让"紧跟上一个、居中"成为布局一等公民。"""

    def _layout(self, children, w=300, h=400, padding=16):
        root = {"type": "box", "id": "root", "layout": "stack", "w": w, "h": h,
                "padding": padding, "children": children}
        proto.measure_node(root, available_w=w)
        proto.layout_node(root, 0, 0, w, h)
        return {c["id"]: c for c in root["children"]}

    def test_after_chains_with_gap(self):
        nodes = self._layout([
            {"type": "label", "id": "a", "x": 10, "y": 10, "w": 120, "h": 24, "text": "A", "fontSize": 13},
            {"type": "label", "id": "b", "after": "a", "afterGap": 12, "w": 120, "h": 24, "text": "B", "fontSize": 13},
            {"type": "label", "id": "c", "after": "b", "afterGap": 8, "w": 100, "h": 24, "text": "C", "fontSize": 13},
        ])
        self.assertEqual(nodes["b"]["_y"], nodes["a"]["_y"] + nodes["a"]["_h"] + 12)
        self.assertEqual(nodes["c"]["_y"], nodes["b"]["_y"] + nodes["b"]["_h"] + 8)

    def test_align_x_center_and_right(self):
        nodes = self._layout([
            {"type": "label", "id": "c", "alignX": "center", "w": 100, "h": 24, "text": "C", "fontSize": 13},
            {"type": "label", "id": "r", "alignX": "right", "w": 100, "h": 24, "text": "R", "fontSize": 13},
        ])
        inner_x, inner_w = 16, 300 - 32
        self.assertEqual(nodes["c"]["_x"], inner_x + (inner_w - 100) // 2)
        self.assertEqual(nodes["r"]["_x"], inner_x + inner_w - 100)

    def test_constraint_keys_do_not_leak_into_emitted_children(self):
        nodes = self._layout([
            {"type": "label", "id": "a", "x": 0, "y": 0, "w": 100, "h": 24, "text": "A", "fontSize": 13},
            {"type": "label", "id": "b", "after": "a", "afterGap": 4, "alignX": "center",
             "w": 100, "h": 24, "text": "B", "fontSize": 13},
        ])
        for key in ("after", "afterGap", "alignX"):
            self.assertNotIn(key, nodes["b"])


if __name__ == '__main__':
    unittest.main()
