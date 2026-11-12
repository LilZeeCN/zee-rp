#!/usr/bin/env python3
"""Deep regression checks for RP/1 compiler, schema, workflow, DSL, decompiler, and 3-way merge."""
import copy
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from rp_language import compile_language, LanguageError, SPACING_TOKENS, RADIUS_TOKENS
from rp_schema import language_schema
from rp_dsl import spec_to_dsl, dsl_to_spec
from rp_workflow import contextualize
from rp_decompile import decompile_rp, lift_rp_into_spec, extract_rp_visual_props, three_way_merge_rp
from proto import compile_spec_bundle

passed = 0


def check(name, fn):
    global passed
    fn()
    passed += 1
    print("PASS", name)


def test_proto_tokens_and_measure_cleanup():
    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts/proto.py"), "tokens"],
        capture_output=True,
        text=True,
        check=True,
    )
    toks = json.loads(res.stdout)
    assert toks["spacing"] == SPACING_TOKENS, f"Expected SPACING_TOKENS, got {toks['spacing']}"
    assert toks["spacing"] != RADIUS_TOKENS

    with tempfile.TemporaryDirectory() as tmp_env:
        env = {**os.environ, "TMPDIR": tmp_env}
        spec_path = ROOT / "examples/rp-language/runtime-inventory.json"
        m_res = subprocess.run(
            [sys.executable, str(ROOT / "scripts/proto.py"), "measure", "--spec", str(spec_path)],
            capture_output=True,
            text=True,
            env=env,
            check=True,
        )
        m_out = json.loads(m_res.stdout)
        assert m_out.get("ok") is True
        leftovers = [p.name for p in Path(tmp_env).iterdir() if p.name.startswith("rp-measure-")]
        assert leftovers == [], f"Expected zero leaked rp-measure-* dirs, found {leftovers}"


def test_negative_rotation_and_missing_root_schema():
    spec = {
        "language": "rp/1",
        "target": 9,
        "pages": [
            {
                "id": "home",
                "name": "Home",
                "root": {
                    "type": "box",
                    "id": "root",
                    "layout": "column",
                    "w": 320,
                    "h": 240,
                    "children": [
                        {"type": "badge", "id": "stamp", "text": "URGENT", "w": 96, "h": 28, "rotation": -15},
                    ],
                },
            }
        ],
    }
    lowered, ir = compile_language(copy.deepcopy(spec))
    assert lowered["pages"][0]["root"]["children"][0]["rotation"] == -15
    schema = language_schema()
    # Verify schema allows negative numbers on rotation (via Draft202012Validator + rule inspection)
    from jsonschema import Draft202012Validator
    Draft202012Validator(schema).validate(spec)
    badge_rules = [
        rule["then"] for rule in schema["$defs"]["node"]["allOf"]
        if rule.get("if", {}).get("properties", {}).get("type", {}).get("const") == "badge"
    ]
    assert badge_rules, "Expected badge definition in schema"
    badge_shape = badge_rules[0]["anyOf"][0] if "anyOf" in badge_rules[0] else badge_rules[0]
    rot_schema = badge_shape["properties"]["rotation"]
    num_branch = next((b for b in rot_schema.get("anyOf", []) if b.get("type") == "number"), None)
    assert num_branch is not None and "minimum" not in num_branch, f"Expected unbounded number for rotation, got {rot_schema}"

    # Verify missing page root raises structured LanguageError("E_SCHEMA") instead of raw KeyError
    with tempfile.TemporaryDirectory() as td:
        try:
            compile_spec_bundle({"pages": [{"name": "BrokenPage"}]}, td)
        except LanguageError as err:
            assert err.diagnostic["code"] == "E_SCHEMA"
            assert err.diagnostic["pointer"] == "/pages/0/root"
        else:
            raise AssertionError("Expected LanguageError E_SCHEMA for missing page root")


def test_dsl_events_masters_and_adaptive_views_roundtrip():
    spec = {
        "language": "rp/1",
        "target": 9,
        "name": "DSL Complete Roundtrip",
        "computed": {
            "total": {"type": "number", "compute": {"op": "count", "dataset": "items"}},
        },
        "adaptiveViews": [
            {"id": "mobile", "name": "Mobile", "width": 375, "condition": "<="},
        ],
        "masters": {
            "header_bar": {
                "name": "Header Bar",
                "w": 375,
                "h": 56,
                "root": {
                    "type": "box",
                    "id": "hdr_root",
                    "layout": "row",
                    "w": 375,
                    "h": 56,
                    "children": [
                        {"type": "label", "id": "hdr_title", "text": "Portal", "w": 120, "h": 24},
                    ],
                },
            }
        },
        "datasets": {
            "items": {"rows": [{"id": "r1", "title": "Row 1"}]},
        },
        "pages": [
            {
                "id": "home",
                "name": "Home",
                "root": {
                    "type": "box",
                    "id": "root",
                    "layout": "column",
                    "w": 375,
                    "h": 600,
                    "children": [
                        {
                            "type": "checkbox",
                            "id": "agree_cb",
                            "text": "Agree",
                            "checked": True,
                            "w": 160,
                            "h": 32,
                            "on": {
                                "selectedchange": [{"type": "set-text", "target": "status_lbl", "text": "Changed"}],
                                "mouseover": [{"type": "set-text", "target": "status_lbl", "text": "Hover"}],
                            },
                        },
                        {"type": "label", "id": "status_lbl", "text": "Ready", "w": 160, "h": 24},
                    ],
                },
            }
        ],
    }
    dsl_text = spec_to_dsl(spec)
    assert "adaptive-view mobile" in dsl_text
    assert "master header_bar" in dsl_text
    assert "computed $total" in dsl_text
    rt = dsl_to_spec(dsl_text)
    assert rt["adaptiveViews"] == spec["adaptiveViews"]
    assert rt["masters"]["header_bar"]["name"] == "Header Bar"
    assert rt["computed"] == spec["computed"]
    assert rt["pages"][0]["root"]["children"][0]["on"]["selectedchange"] == spec["pages"][0]["root"]["children"][0]["on"]["selectedchange"]

    # Also test shorthand +mouseover and +selectedchange in DSL
    shorthand_dsl = """rp/1 target=9
page #home [375x600]
  box #root [375x600] layout=column
    checkbox #cb1 [160x32] "Accept" checked=true
      +selectedchange [{"type":"set-text","target":"lbl1","text":"Selected"}]
      +mouseover [{"type":"set-text","target":"lbl1","text":"Hover"}]
    label #lbl1 [160x24] "Idle"
"""
    parsed_sh = dsl_to_spec(shorthand_dsl)
    cb_node = parsed_sh["pages"][0]["root"]["children"][0]
    assert "selectedchange" in cb_node["on"] and "mouseover" in cb_node["on"]


def test_workflow_font_family_and_form_hints():
    spec = {
        "language": "rp/1",
        "pages": [{"id": "home", "root": {"type": "box", "id": "root", "children": [{"type": "divider", "id": "d1", "fontFamily": "Inter"}]}}],
    }
    diag_prop = contextualize(
        {"code": "E_PROPERTY", "pointer": "/pages/0/root/children/0/fontFamily", "message": "Unexpected property"},
        spec,
    )
    assert "仅适用于文本与表单控件" in diag_prop["nextAction"]
    diag_type = contextualize(
        {"code": "E_TYPE", "pointer": "/pages/0/root/children/0/fontFamily", "message": "fontFamily must be a non-empty family name"},
        spec,
    )
    assert "非空字体族名称" in diag_type["nextAction"]


def test_decompile_and_merge_native_forms_and_rotation():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        assets_dir = td_path / "assets"
        assets_dir.mkdir()
        # Copy an existing valid PNG into assets/logo.png to verify relative asset resolution in 3-way merge
        sample_png = ROOT / "assets/icon-search.png"
        if sample_png.exists():
            (assets_dir / "logo.png").write_bytes(sample_png.read_bytes())
        else:
            import base64
            (assets_dir / "logo.png").write_bytes(
                base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
            )

        base_spec = {
            "language": "rp/1",
            "target": 9,
            "name": "Forms And Rotation",
            "domain": "web",
            "theme": "enterprise-light",
            "pages": [
                {
                    "id": "home",
                    "name": "Home",
                    "canvas": {"w": 800, "h": 600},
                    "root": {
                        "type": "box",
                        "id": "root",
                        "layout": "column",
                        "padding": 24,
                        "gap": 16,
                        "w": "fill",
                        "h": "hug",
                        "children": [
                            {"type": "label", "id": "hdr", "text": "Form Header", "w": 240, "h": 32, "rotation": -10},
                            {"type": "checkbox", "id": "agree", "text": "Accept Terms", "checked": True, "w": 200, "h": 28},
                            {"type": "combobox", "id": "role_sel", "options": ["Admin", "Editor", "Viewer"], "selectedIndex": 1, "w": 220, "h": 36},
                            {"type": "image", "id": "brand_img", "src": "assets/logo.png", "w": 48, "h": 48},
                        ],
                    },
                }
            ],
        }
        base_spec_path = td_path / "base.spec.json"
        base_rp_path = td_path / "base.rp"
        base_spec_path.write_text(json.dumps(base_spec, ensure_ascii=False, indent=2), encoding="utf-8")

        subprocess.run(
            ["node", str(ROOT / "scripts/proto.mjs"), "generate", "--spec", str(base_spec_path), "--out-dir", str(td_path / "build"), "--out-rp", str(base_rp_path)],
            check=True,
            capture_output=True,
            text=True,
        )

        # 1. Verify extract_rp_visual_props extracts rotation, checked, and options/selectedIndex
        vprops = extract_rp_visual_props(base_rp_path)
        hdr_vp = next(v for k, v in vprops.items() if k.startswith("txt-hdr-"))
        assert hdr_vp.get("rotation") == -10, f"Expected rotation -10, got {hdr_vp}"
        cb_vp = next(v for k, v in vprops.items() if k.startswith("check-agree-"))
        assert cb_vp.get("checked") is True, f"Expected checked True, got {cb_vp}"
        cmb_vp = next(v for k, v in vprops.items() if k.startswith("combo-role_sel-"))
        assert cmb_vp.get("options") == ["Admin", "Editor", "Viewer"] and cmb_vp.get("selectedIndex") == 1, f"Unexpected combobox props: {cmb_vp}"

        # 2. Verify decompile_rp produces a valid RP/1 spec with checkbox, combobox (no illegal 'text'), and rotation
        decomp = decompile_rp(base_rp_path)
        assert decomp["ok"] is True
        d_children = {c["id"]: c for c in decomp["spec"]["pages"][0]["root"]["children"]}
        assert d_children["hdr"].get("rotation") == -10
        assert d_children["agree"]["type"] == "checkbox" and d_children["agree"]["checked"] is True
        assert d_children["role_sel"]["type"] == "combobox" and "text" not in d_children["role_sel"]
        assert d_children["role_sel"]["options"] == ["Admin", "Editor", "Viewer"]

        # 3. Mutate combobox options in edited.rp and label text in new.spec.json, then run 3-way merge with relative assets/logo.png
        edited_rp_path = td_path / "edited.rp"
        combo_native_name = next(k for k in vprops if k.startswith("combo-role_sel-"))
        subprocess.run(
            [
                "node",
                str(ROOT / "scripts/set-combobox-options.mjs"),
                str(base_rp_path),
                str(edited_rp_path),
                "Home",
                combo_native_name,
                json.dumps(["Owner", "Admin", "Guest"]),
                "--selected",
                "2",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        new_spec = copy.deepcopy(base_spec)
        new_spec["pages"][0]["root"]["children"][0]["text"] = "Updated Form Header"
        new_spec_path = td_path / "new.spec.json"
        new_spec_path.write_text(json.dumps(new_spec, ensure_ascii=False, indent=2), encoding="utf-8")

        merged_spec_path = td_path / "merged.spec.json"
        merged_rp_path = td_path / "merged.rp"
        merge_res = three_way_merge_rp(
            base_spec_path=base_spec_path,
            base_rp_path=base_rp_path,
            edited_rp_path=edited_rp_path,
            new_spec_path=new_spec_path,
            out_spec_path=merged_spec_path,
            out_rp_path=merged_rp_path,
        )
        assert merge_res["ok"] is True, f"Expected 3-way merge ok, got {merge_res}"
        m_children = {c["id"]: c for c in merge_res["spec"]["pages"][0]["root"]["children"]}
        assert m_children["hdr"]["text"] == "Updated Form Header"
        assert m_children["role_sel"]["options"] == ["Owner", "Admin", "Guest"]
        assert m_children["role_sel"]["selectedIndex"] == 2
        assert "text" not in m_children["role_sel"]
        assert merged_rp_path.exists()


check("proto.py tokens SPACING_TOKENS and measure temp dir cleanup", test_proto_tokens_and_measure_cleanup)
check("negative rotation schema/compiler support and missing page root diagnostic", test_negative_rotation_and_missing_root_schema)
check("rp_dsl.py full events, computed, masters, and adaptiveViews roundtrip", test_dsl_events_masters_and_adaptive_views_roundtrip)
check("rp_workflow.py accurate fontFamily and form widget hints", test_workflow_font_family_and_form_hints)
check("rp_decompile.py and three_way_merge_rp native form controls, rotation, and relative assets", test_decompile_and_merge_native_forms_and_rotation)

print(f"rp1-compiler-dsl-decompile-deep-check: {passed} checks passed")
