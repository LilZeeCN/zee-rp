#!/usr/bin/env python3
"""Regression contracts for paragraph sizing and independent scene audits."""
import copy
import json
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


if __name__ == '__main__':
    unittest.main()
