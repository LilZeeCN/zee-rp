import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from rp_acceptance import trace
from rp_benchmark import load, report
from rp_language import compile_language, LanguageError


class AcceptanceContracts(unittest.TestCase):
    def setUp(self):
        self.source = ROOT / 'test/fixtures/rp-native-visual.json'
        self.plan = {'observe': {'widgets': ['visual01/field'], 'repeaters': ['visual01/rows']},
                     'scenarios': [{'id': 'row-isolation', 'steps': [{'click': 'visual01/rows/item/plus', 'rowIndex': 1}]}]}

    def test_trace_observes_raw_data_and_row_isolation(self):
        result = trace(self.source, self.plan)
        rows = result['scenarios'][0]['states'][-1]['repeaters']['visual01/rows']['rows']
        self.assertEqual([r['qty'] for r in rows], [1, 3])
        self.assertEqual(result['scenarios'][0]['states'][0]['widgets']['visual01/field'], '初值')

    def test_unknown_observation_cannot_silently_pass(self):
        self.plan['observe']['widgets'] = ['visual01/missing']
        with self.assertRaises(ValueError): trace(self.source, self.plan)

    def test_business_assertion_requires_observation(self):
        self.plan['scenarios'][0]['assert'] = {'variables': {'notObserved': 1}}
        with self.assertRaises(ValueError): trace(self.source, self.plan)

    def test_invalid_action_and_empty_coverage_rejected(self):
        self.plan['scenarios'][0]['steps'] = [{'click': 'visual01/field', 'input': 'visual01/field', 'value': 'x'}]
        with self.assertRaises(ValueError): trace(self.source, self.plan)
        self.plan['observe'] = {}
        with self.assertRaises(ValueError): trace(self.source, self.plan)

    def test_input_padding_type_and_negative_values_rejected(self):
        for value in ('bad', -1):
            spec = json.loads(self.source.read_text())
            spec['pages'][0]['root']['children'][1]['textPaddingX'] = value
            with self.assertRaises(LanguageError): compile_language(spec)

    def test_frozen_benchmark_tampering_detected(self):
        manifest, tasks = load()
        self.assertEqual(len(tasks), 30)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in ['manifest.json', 'development.json', 'heldout.json']:
                shutil.copy(ROOT / 'benchmarks/rp1/v1' / name, root / name)
            (root / 'development.json').write_text('[]')
            with self.assertRaises(ValueError): load(root)

    def test_no_trials_means_missing_evidence_not_full_marks(self):
        r = report([], load()[1])
        self.assertEqual(r['missingTrials'], 90)
        self.assertIsNone(r['score'])
        self.assertIsNone(r['firstGenerationPassRate'])

    def test_trial_cannot_claim_first_pass_after_repair_or_missing_evidence(self):
        tasks = load()[1]
        row = {'taskId': 'RP1-01', 'trial': 1, 'model': 'test', 'sourceHash': 'a' * 64, 'rpHash': 'b' * 64,
               'firstGenerationPass': True, 'repairRounds': 0, 'manualEdits': 0, 'elapsedSeconds': 10,
               'nativeBehavior': True, 'guiSaveReopen': True, 'guiEdit': True, 'visualReview': True, 'evidence': ['report.json']}
        self.assertEqual(report([row], tasks)['recordedTrials'], 1)
        for field, value in [('repairRounds', 1), ('nativeBehavior', False), ('evidence', []), ('sourceHash', 'placeholder')]:
            with self.assertRaises(ValueError): report([{**row, field: value}], tasks)
        with self.assertRaises(ValueError): report([row, row], tasks)


if __name__ == '__main__': unittest.main(verbosity=2)
