"""Regressions from the 2026-10-24 external fuzz report."""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from rp_language import compile_language, LanguageError
from rp_schema import language_schema

passed = []


def fixture():
    return {"language": "rp/1", "variables": {"n": {"type": "number", "value": 1},
            "selected": {"type": "text", "value": "a"}},
            "models": {"Row": {"id": "text", "title": "text", "qty": "number", "ok": "boolean"}},
            "datasets": {"rows": {"model": "Row", "rows": [{"id": "a", "title": "A", "qty": 1, "ok": True}]}},
            "pages": [{"id": "home", "root": {"type": "box", "id": "root", "layout": "stack", "w": 400, "h": 420, "children": [
                {"type": "label", "id": "t1", "text": "A", "x": 0, "y": 0},
                {"type": "label", "id": "t2", "text": "B", "x": 0, "y": 28},
                {"type": "repeater", "id": "rep", "dataset": "rows", "key": "id", "rowHeight": 40,
                 "x": 0, "y": 60, "w": 200, "h": 80, "template": {"type": "label", "id": "row", "text": {"item": "title"}}},
                {"type": "form-card", "id": "fc", "x": 0, "y": 150, "w": 320, "fields": [{"id": "f1", "label": "名"}],
                 "onSubmit": [{"type": "wait", "ms": 1}]},
                {"type": "button", "id": "bn", "text": "OK", "x": 0, "y": 340},
            ]}}]}


def reject(name, mutate, code, pointer=None):
    spec = fixture()
    mutate(spec)
    try:
        compile_language(spec)
    except LanguageError as error:
        diag = error.diagnostic
        assert diag["code"] == code, (name, diag)
        if pointer:
            assert diag["pointer"].endswith(pointer), (name, diag)
    else:
        raise AssertionError(name + " was silently accepted")
    passed.append(name)


def child(spec, idx):
    return spec["pages"][0]["root"]["children"][idx]


for key, value, code in [("after", "ghost", "E_REFERENCE"), ("alignX", "middle", "E_PROPERTY"),
                          ("pin", "center", "E_PROPERTY"), ("afterGap", "x", "E_TYPE")]:
    reject("invalid stack " + key, lambda s, k=key, v=value: child(s, 1).__setitem__(k, v), code, key)
for value in [123, "#GG0000", "#F00", "#FF000080"]:
    reject("invalid palette " + str(value), lambda s, v=value: s.update(palette={"brand": v}), "E_COLOR", "/palette/brand")
for where in ["top", "page", "macro"]:
    def bad_device(spec, where=where):
        owner = spec if where == "top" else spec["pages"][0]
        if where == "macro":
            owner = {"type": "phone-shell", "id": "shell", "children": []}
            spec["pages"][0]["root"] = owner
        owner["device"] = "iPhone 16 Pro"
    reject("unknown device " + where, bad_device, "E_PROPERTY", "/device")
for prop in ["navBar", "tabBar"]:
    reject("shell " + prop + " string", lambda s, k=prop: s["pages"][0].update(root={
        "type": "phone-shell", "id": "shell", k: "oops"}), "E_TYPE", "/" + prop)
reject("fontSize zero", lambda s: child(s, 0).update(fontSize=0), "E_SIZE", "/fontSize")
for value in [73, 100000]:
    reject("fontSize over renderer limit " + str(value), lambda s, v=value: child(s, 0).update(fontSize=v), "E_SIZE", "/fontSize")
reject("font shorthand oversize", lambda s: child(s, 0).update(font="100000/bold"), "E_SIZE", "/fontSize")
reject("font size alias oversize", lambda s: child(s, 0).update(size=100000), "E_SIZE", "/fontSize")
reject("span font oversize", lambda s: child(s, 0).update(spans=[{"text": "A", "fontSize": 100000}]), "E_SIZE", "/spans/0/fontSize")
reject("negative letterSpacing", lambda s: child(s, 0).update(letterSpacing=-4), "E_SIZE", "/letterSpacing")
for layout in ["column", "row"]:
    reject("unknown after in " + layout, lambda s, lay=layout: (
        s["pages"][0]["root"].update(layout=lay), child(s, 1).update(after="ghost")), "E_REFERENCE", "/after")
reject("unknown after inside phone-shell", lambda s: s["pages"][0].update(root={"type": "phone-shell", "id": "shell", "children": [
    {"type": "label", "id": "t1", "text": "A", "after": "ghost"}]}), "E_REFERENCE", "/after")
reject("NUL text", lambda s: child(s, 0).update(text="a\x00b"), "E_TEXT_CONTROL", "/text")
reject("duplicate page IDs", lambda s: s["pages"].append({"id": "home", "name": "Other", "root": {
    "type": "label", "id": "l", "text": "Other"}}), "E_ID_DUPLICATE", "/pages/1/id")
for event in ["onLoad", "on"]:
    reject("widget load " + event, lambda s, e=event: child(s, 4).update({e: [{"type": "wait", "ms": 1}]
        if e == "onLoad" else {"load": [{"type": "wait", "ms": 1}]}}), "E_EVENT_TARGET")
reject("unrecognized event string", lambda s: child(s, 4).update(onClick="this is not an action"), "E_EVENT")
reject("missing tab target", lambda s: s.update(tabBar=[{"id": "ghost", "text": "x"}]), "E_REFERENCE", "/tabBar/0")
reject("missing string tab target", lambda s: s.update(tabBar=["ghost"]), "E_REFERENCE", "/tabBar/0")
reject("top tabBar string", lambda s: s.update(tabBar="home"), "E_TYPE", "/tabBar")

for value, code in [(None, "E_STATECHART"), ([], "E_STATECHART"), ({"sc": []}, "E_STATECHART"),
                    ({"sc": {"initial": "a", "states": ["a"], "transitions": [
                        {"from": "a", "to": "ghost", "on": "click"}]}}, "E_STATECHART")]:
    reject("bad statechart " + str(value), lambda s, v=value: s.update(statecharts=v), code)
for selector in ["$nosuch", "$n", 42]:
    reject("bad selector " + str(selector), lambda s, v=selector: s.update(views={"DV": {
        "source": "rows", "key": "id", "selector": v, "fields": {"t1": "title"}}}), "E_VARIABLE")
reject("selector absent row", lambda s: (s["variables"]["selected"].update(value="ghost"), s.update(views={"DV": {
    "source": "rows", "key": "id", "selector": "$selected", "fields": {"t1": "title"}}})), "E_VARIABLE")

for case, code, tail in [({"actions": []}, "E_EXPRESSION", "/cases/0"),
                         ({"when": "", "actions": []}, "E_EXPRESSION", "/when"),
                         ({"when": "$n >>>", "actions": []}, "E_EXPRESSION", "/when"),
                         ({"when": 42, "actions": []}, "E_TYPE", "/when")]:
    reject("macro case " + str(case), lambda s, c=case: child(s, 3).update(onSubmit={"cases": [c]}), code, tail)
for row, code, tail in [({"id": "x", "title": "t"}, "E_FIELD_MISSING", "/rows/0"),
                         ({"id": "x", "title": "t", "qty": 1, "ok": True, "extra": 1}, "E_DATA_FIELD", "/extra")]:
    reject("macro data-add " + code, lambda s, row=row: child(s, 3).update(onSubmit=[{
        "type": "data-add", "target": "rep", "rows": [row]}]), code, tail)


def deep(spec):
    node = {"type": "label", "id": "leaf", "text": "x"}
    for i in range(250):
        node = {"type": "box", "id": "b" + str(i), "w": "fill", "h": "hug", "children": [node]}
    spec["pages"][0]["root"] = node


reject("250 nested boxes", deep, "E_DEPTH")

# These formerly ambiguous conveniences must lower to checked native actions.
spec = fixture()
child(spec, 4)["onClick"] = "goto home"
child(spec, 0)["text"] = "='a' + $n"
spec["tabBar"] = ["home"]
spec["statecharts"] = {"sc": {"initial": "a", "states": ["a"], "transitions": []}}
lowered, ir = compile_language(spec)
assert ir["statecharts"] == spec["statecharts"]
links = [a for ix in lowered["pages"][0]["interactions"] for e in ix["events"] for c in e["cases"]
         for a in c["actions"] if a["type"] == "link"]
assert len(links) == 2 and all(a["page"] == "home" for a in links), links
assert "concat" in json.dumps(ir)
passed.append("strings, text plus, string tabs and statechart metadata lower correctly")

with tempfile.TemporaryDirectory() as work:
    path = Path(work) / "source.json"
    for invalid in [False, True]:
        value = fixture()
        if invalid:
            deep(value)
        path.write_text(json.dumps(value))
        proc = subprocess.run(["node", str(ROOT / "scripts/proto.mjs"), "check", "--spec", str(path)],
                              capture_output=True, text=True)
        assert not proc.stderr, proc.stderr
        assert json.loads(proc.stdout)["ok"] is not invalid
    passed.append("CLI check JSON uses stdout on success and failure")

assert language_schema() == json.loads((ROOT / "references/rp-language.schema.json").read_text())
passed.append("editor schema remains generated from compiler vocabulary")

for expression in ["=$n +", "=+", "=concat('a',", "=("]:
    value = fixture(); child(value, 0)["text"] = expression
    try:
        compile_language(value)
    except LanguageError as error:
        assert error.diagnostic["code"] == "E_EXPRESSION", error.diagnostic
        assert error.diagnostic["message"] == "Unexpected end of expression", error.diagnostic
    else:
        raise AssertionError(expression)
    passed.append("clean end-of-expression message " + expression)

for layout in ["stack", "column"]:
    value = fixture(); value["pages"][0]["root"]["layout"] = layout
    child(value, 0).update(fontSize=72, letterSpacing=0)
    child(value, 1).update(after="t1")
    compile_language(value)
    passed.append("valid after, maximum font and zero spacing in " + layout)

from rp_workflow import diagnose_spec
for field, number, hint in [("fontSize", 100000, "字号"), ("letterSpacing", -4, "letterSpacing")]:
    value = fixture(); child(value, 0)[field] = number
    diagnostic = diagnose_spec(value)["diagnostics"][0]
    assert hint in diagnostic["nextAction"] and "宽高" not in diagnostic["nextAction"], diagnostic
    passed.append("property-specific repair hint for " + field)

from proto import compile_spec_bundle
for label, mutate, code in [
    ("children", lambda s: s["pages"][0]["root"].update(children=42), "E_TYPE"),
    ("states", lambda s: s["pages"][0]["root"]["children"].__setitem__(0, {"type": "dynamic-panel", "id": "dp", "states": 42}), "E_STATE"),
    ("device", lambda s: s.update(device={}), "E_PROPERTY"),
    ("pages", lambda s: s.update(pages=42), "E_PAGE"),
]:
    value = fixture(); mutate(value)
    with tempfile.TemporaryDirectory() as work:
        try:
            compile_spec_bundle(value, work, strict_audit=True, auto_heal=True)
        except LanguageError as error:
            assert error.diagnostic["code"] == code, error.diagnostic
        else:
            raise AssertionError("autoHeal accepted malformed " + label)
    passed.append("explicit autoHeal preserves " + label + " diagnostics")

# Round 4 bughunt regressions (R4-01..R4-15)
reject("unknown macro slot", lambda s: child(s, 3).__setitem__("slots", {"bogus": {"type": "label", "id": "b", "text": "x"}}), "E_PROPERTY", "/slots/bogus")
reject("progress-bar percent and value together", lambda s: s["pages"][0]["root"]["children"].append({"type": "progress-bar", "id": "pb", "percent": 50, "value": 10}), "E_PROPERTY", "percent")
reject("filters auto on non-enum field", lambda s: s["pages"][0]["root"]["children"].append({
    "type": "searchable-list", "id": "sl", "dataset": "rows", "searchField": "title", "filterField": "title",
    "filters": "auto", "template": {"type": "label", "id": "r", "text": {"item": "title"}}
}), "E_PROPERTY", "filters")
reject("wizard-card nextWhen without nextText", lambda s: s["pages"][0]["root"]["children"].append({
    "type": "wizard-card", "id": "wz", "steps": [{"id": "s1", "title": "Step 1", "body": {"type": "label", "id": "b1", "text": "Body"}, "nextWhen": "=var.nosuch == 1"}]
}), "E_VARIABLE", "/steps/0/nextWhen")

with tempfile.TemporaryDirectory() as work:
    overlap_spec = {
        "language": "rp/1",
        "pages": [{"id": "home", "canvas": [400, 300], "root": {"type": "box", "id": "root", "layout": "stack", "w": 360, "h": 260, "children": [
            {"type": "label", "id": "a", "x": 10, "y": 10, "w": 120, "h": 40, "text": "Overlap A"},
            {"type": "label", "id": "b", "x": 10, "y": 10, "w": 120, "h": 40, "text": "Overlap B"},
        ]}}],
    }
    ov_path = Path(work) / "overlap.json"
    ov_path.write_text(json.dumps(overlap_spec))
    proc_chk = subprocess.run(["node", str(ROOT / "scripts/proto.mjs"), "check", "--spec", str(ov_path)], capture_output=True, text=True)
    assert proc_chk.returncode == 1, proc_chk.stdout
    chk_json = json.loads(proc_chk.stdout)
    assert chk_json["ok"] is False and chk_json["diagnostics"][0]["code"] == "E_LAYOUT", chk_json
    assert chk_json["diagnostics"][0]["pointer"] != "/", chk_json
    passed.append("proto.mjs check runs layout gates and populates E_LAYOUT pointer")

    bad_j2d = fixture()
    child(bad_j2d, 0)["text"] = "=var.nonexistent + 1"
    bad_j2d_path = Path(work) / "bad.json"
    bad_j2d_out = Path(work) / "bad.rp1"
    bad_j2d_path.write_text(json.dumps(bad_j2d))
    proc_j2d = subprocess.run(["node", str(ROOT / "scripts/proto.mjs"), "json-to-dsl", "--spec", str(bad_j2d_path), "--out", str(bad_j2d_out)], capture_output=True, text=True)
    assert proc_j2d.returncode == 1 and not bad_j2d_out.exists(), proc_j2d.stdout
    assert json.loads(proc_j2d.stdout)["diagnostics"][0]["code"] == "E_VARIABLE"
    passed.append("json-to-dsl enforces compile_language validation")

    prod_spec = json.loads((ROOT / "examples/rp-language/equipment-loan.json").read_text(encoding="utf-8"))
    prod_spec["product"]["entities"]["EquipmentLoan"]["rows"][0]["location"] = "超长存放实验室名称_嵌入式与光电联合测试中心大楼B区204室"
    prod_path = Path(work) / "prod_overflow.json"
    prod_path.write_text(json.dumps(prod_spec, ensure_ascii=False))
    for tag, cmd in [
        ("mjs", ["node", str(ROOT / "scripts/proto.mjs"), "check", str(prod_path), "--auto-heal", "--out", str(Path(work) / "healed_mjs.json")]),
        ("cli", ["python3", str(ROOT / "scripts/rp_language_cli.py"), "check", str(prod_path), "--auto-heal", "--out", str(Path(work) / "healed_cli.json")]),
        ("py", ["python3", str(ROOT / "scripts/proto.py"), "check", "--spec", str(prod_path), "--auto-heal", "--out", str(Path(work) / "healed_py.json")]),
    ]:
        p_heal = subprocess.run(cmd, capture_output=True, text=True)
        assert p_heal.returncode == 0, f"{tag}: {p_heal.stdout} {p_heal.stderr}"
        h_json = json.loads(p_heal.stdout)
        assert h_json.get("ok") is True and h_json.get("healed") is True, h_json
    passed.append("product spec auto-heal succeeds across proto.mjs, rp_language_cli.py, and proto.py")

    md_spec = {
        "language": "rp/1",
        "name": "MD Test",
        "domain": "web",
        "datasets": {"items": {"rows": [{"id": "1", "name": "Item 1"}]}},
        "pages": [{
            "id": "p1",
            "name": "Page 1",
            "root": {
                "id": "root",
                "type": "box",
                "layout": "column",
                "w": 1200,
                "h": 800,
                "children": [{
                    "id": "md1",
                    "type": "master-detail",
                    "dataset": "items",
                    "searchField": "name",
                    "w": 1100,
                    "h": 600,
                    "template": {
                        "id": "tpl_row",
                        "type": "box",
                        "layout": "row",
                        "w": 360,
                        "h": 44,
                        "children": [{"id": "lbl_name", "type": "label", "text": {"item": "name"}, "w": 200, "h": 24}]
                    },
                    "detail": {"id": "d_custom", "type": "label", "text": "Custom Detail", "w": 600, "h": 40},
                    "slots": {"master": {"id": "m_custom", "type": "label", "text": "Custom Master Header", "w": 300, "h": 40}}
                }]
            }
        }]
    }
    md_path = Path(work) / "md_slot_ds.json"
    md_path.write_text(json.dumps(md_spec))
    p_md = subprocess.run(["node", str(ROOT / "scripts/proto.mjs"), "check", str(md_path)], capture_output=True, text=True)
    assert p_md.returncode == 0 and json.loads(p_md.stdout).get("ok") is True, p_md.stdout
    passed.append("master-detail with dataset shorthand and slots.master compiles without E_DUPLICATE_ID")

print(json.dumps({"passed": len(passed), "checks": passed}, ensure_ascii=False, indent=2))
