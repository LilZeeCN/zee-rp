"""Exercise the public Draft 2020-12 source schema against the real compiler."""
import copy
import json
from pathlib import Path
import sys
import unittest

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from rp_language import compile_language
from rp_schema import language_schema


class SourceContractTests(unittest.TestCase):
    def test_generated_schema_is_current(self):
        self.assertEqual(language_schema(), json.loads((ROOT / "references/rp-language.schema.json").read_text()))

    def test_schema_and_compiler_acceptance(self):
        cases = [
            ("label", {"text": "Hello", "fontSize": 20}, True),
            ("label", {"text": "Hello", "rows": []}, False),
            ("label", {"text": "Hello", "columns": 2}, False),
            ("label", {"text": "Hello", "activeState": "a"}, False),
            ("box", {"text": "Sugar", "font": "22/600", "fontFamily": "Georgia"}, True),
            ("box", {"fontFamily": "Georgia"}, False),
            ("box", {"css": {"filter": "blur(2px)"}}, False),
            ("card", {"title": "Title", "titleFontSize": 22}, True),
            ("card", {"titleFontSize": 22}, False),
            ("card", {"fontSize": 22}, False),
        ]
        for flag in ["visible", "hidden"]:
            for value in [True, False, "false"]:
                cases.append(("label", {"text": "Visibility", flag: value}, isinstance(value, bool)))
        for alias, value in {"bg": "#112233", "background": "#112233", "textColor": "#112233", "fg": "#112233", "borderColor": "#112233", "borderWidth": 2, "rounded": 4, "borderRadius": 4}.items():
            cases.append(("label", {"text": "Alias", alias: value}, True))
        for marker, value in {"layout": "column", "padding": 12, "gap": 8, "justify": "start", "columns": 2}.items():
            cases.append(("box", {"text": "Container", marker: value, "fontSize": 20}, True))
            cases.append(("box", {"text": "Container", marker: value, "fontFamily": "Georgia"}, False))
        validator = Draft202012Validator(language_schema())
        for kind, props, expected in cases:
            with self.subTest(kind=kind, props=props):
                spec = {"language": "rp/1", "target": 9, "name": "Contract", "pages": [{"id": "home", "root": {"type": "box", "id": "root", "w": 500, "h": 500, "children": [{"type": kind, "id": "probe", "w": 250, "h": 80, **props}]}}]}
                self.assertEqual(validator.is_valid(spec), expected, list(validator.iter_errors(spec)))
                try:
                    compile_language(copy.deepcopy(spec))
                    accepted = True
                except Exception:
                    accepted = False
                self.assertEqual(accepted, expected)


if __name__ == "__main__":
    unittest.main()
