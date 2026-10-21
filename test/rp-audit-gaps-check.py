"""Regression tests for the independently reproduced 2026-10-21 gaps."""
import copy
import sys
import unittest
import tempfile
import json
try:
    import jsonschema
except ImportError:
    jsonschema = None
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from rp_language import ReferenceRuntime, compile_language
from rp_oracle import fuzz_dual_model_trace
from rp_gui_evidence import verify_gui_evidence, file_hash
from rp_schema import language_schema


def selection_spec():
    return {'language': 'rp/1', 'models': {'row': {'id': 'text', 'title': 'text'}},
        'datasets': {'rows': {'model': 'row', 'rows': [{'id': 'old', 'title': '旧记录'}]}},
        'variables': {'selected': {'type': 'text', 'value': 'old'}},
        'pages': [
            {'id': 'list', 'name': '列表', 'layout': [
                {'button': 'add', 'text': '新增两条', 'onClick': [
                    {'type': 'data-add', 'target': 'rep', 'rows': [{'id': 'first', 'title': '第一条'}, {'id': 'second', 'title': '第二条'}]}]},
                {'button': 'update', 'text': '修改第一条', 'onClick': [
                    {'type': 'data-update', 'target': 'rep', 'where': "item.id == 'first'", 'set': {'title': '已修改'}}]},
                {'button': 'delete', 'text': '删除第一条', 'onClick': [
                    {'type': 'data-delete', 'target': 'rep', 'where': "item.id == 'first'"}]},
                {'button': 'open', 'text': '详情', 'onClick': [{'set': {'$selected': 'first'}}, {'goto': 'detail'}]},
                {'repeater': 'rep', 'dataset': 'rows', 'template': {'label': 'item', 'text': '${item.title}'}}]},
            {'id': 'detail', 'name': '详情', 'views': {'selected': {'source': 'rows', 'key': 'id', 'selector': 'selected', 'fields': {'title': 'title'}}},
             'layout': [{'label': 'title', 'text': '-'}]}]}


class AuditGaps(unittest.TestCase):
    @unittest.skipIf(jsonschema is None, 'Install jsonschema to validate the editor schema')
    def test_editor_schema_accepts_real_sources_and_rejects_bad_adaptive_geometry(self):
        schema = language_schema()
        sources = [selection_spec(), json.loads((Path(__file__).parent / 'fixtures/rp1-master-adaptive.json').read_text())]
        for source in sources:
            jsonschema.validate(source, schema)
        invalid = copy.deepcopy(sources[1])
        invalid['pages'][0]['slot']['body'][0]['children'][0]['adaptive']['mobile']['w'] = -1
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(invalid, schema)

    def title(self, rt):
        return rt.widgets[rt.symbols_by_id['detail/title']['name']]['text']

    def test_cross_page_two_adds(self):
        rt = ReferenceRuntime(selection_spec())
        rt.trigger('list/add'); rt.trigger('list/open')
        self.assertEqual(self.title(rt), '第一条')

    def test_cross_page_update(self):
        rt = ReferenceRuntime(selection_spec())
        rt.trigger('list/add'); rt.trigger('list/update'); rt.trigger('list/open')
        self.assertEqual(self.title(rt), '已修改')

    def test_deleted_selection_clears_details(self):
        rt = ReferenceRuntime(selection_spec())
        rt.trigger('list/add'); rt.trigger('list/delete'); rt.trigger('list/open')
        self.assertEqual(self.title(rt), '')

    def test_sugar_and_standard_selection_lower_identically(self):
        sugar = selection_spec(); standard = copy.deepcopy(sugar)
        node = standard['pages'][0]['layout'][3]
        node['on'] = {'click': [{'type': 'set-variable', 'variable': 'selected', 'value': 'first'}, {'type': 'link', 'page': 'detail'}]}
        node.pop('onClick')
        self.assertEqual(compile_language(sugar), compile_language(standard))

    def test_gui_evidence_requires_actions_artifact_and_interactive_target(self):
        original = {'counts': {'problems': 0, 'danglingRefs': 0, 'sentinelSlotsNonZero': 0}, 'pages': [{'widgets': [
            {'name': 'title', 'text': '旧标题', 'type': 'VectorShape'},
            {'name': 'submit', 'text': '提交', 'type': 'VectorShape', 'interactions': [{'event': 'OnClick', 'cases': [{'actions': [{'type': 'link'}]}]}]},
            {'name': 'hint', 'text': '说明', 'type': 'VectorShape'}]}]}
        edited = copy.deepcopy(original)
        edited['pages'][0]['widgets'][0]['text'] = '新标题'
        edited['pages'][0]['widgets'][1]['text'] = '保存'
        with tempfile.TemporaryDirectory() as td:
            rp = Path(td) / 'edited.rp'; rp.write_bytes(b'fixture')
            digest = file_hash(rp)
            trip = {'validation': {k: True for k in ('structure', 'guiSaved', 'closed', 'reopened')}, 'output': str(rp), 'outputSha256': digest}
            preview = {'pass': True, 'rpArtifact': {'sha256': digest}, 'results': [{'pass': True}]}
            proof = {'method': 'cua', 'editedRpSha256': digest,
                     'title': {'name': 'title', 'before': '旧标题', 'after': '新标题'},
                     'control': {'name': 'submit', 'before': '提交', 'after': '保存'}}
            self.assertTrue(verify_gui_evidence(original, edited, trip, preview, proof, rp)['pass'])
            self.assertFalse(verify_gui_evidence(original, edited, {'counts': {'problems': 0}}, preview, proof, rp)['pass'])
            self.assertFalse(verify_gui_evidence(original, edited, trip, {}, proof, rp)['pass'])
            proof['control'] = {'name': 'hint', 'before': '说明', 'after': '改了说明'}
            edited['pages'][0]['widgets'][2]['text'] = '改了说明'
            self.assertIn('control_is_not_interactive', verify_gui_evidence(original, edited, trip, preview, proof, rp)['reasons'])

    def test_fuzz_executes_clicks_and_labels_expression_only(self):
        spec = {'language': 'rp/1', 'variables': {'n': {'type': 'number', 'value': 0}},
            'pages': [{'id': 'home', 'name': '计数', 'layout': [
                {'button': 'inc', 'text': '+1', 'onClick': [{'set': {'$n': '=$n + 1'}}]}]}]}
        result = fuzz_dual_model_trace(spec, steps=50, seed=42)
        self.assertGreater(result.get('executedClicks', 0), 0)
        self.assertGreater(result['uniqueStatesSampled'], 1)
        self.assertIsNone(result['stateHashMismatches'])
        self.assertEqual(result['validationLevel'], 'reference_actions_and_native_expressions')

    def test_fuzz_rejects_no_actions(self):
        spec = {'language': 'rp/1', 'pages': [{'id': 'home', 'name': '静态', 'layout': [{'label': 'text', 'text': '无操作'}]}]}
        with self.assertRaisesRegex(ValueError, 'action'):
            fuzz_dual_model_trace(spec, steps=20)


if __name__ == '__main__':
    unittest.main()
