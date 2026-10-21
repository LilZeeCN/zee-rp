#!/usr/bin/env python3
"""Falsifiable acceptance test suite for the 6 RP/1 architectural upgrades (P0-1, P0-2, P1-3a, P1-3b, P2-4, P3-6)."""

import copy
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join( os.path.dirname(HERE), "scripts")
sys.path.insert(0, SCRIPTS)

from rp_language import ReferenceRuntime, compile_language, measure_text_glyphs  # noqa: E402
from rp_product import synthesize_product_spec  # noqa: E402
from rp_decompile import extract_rp_visual_props, three_way_merge_rp  # noqa: E402


def test_p0_1_runtime_selection_model_40_rows():
    rows_40 = [
        {"id": f"R{i:03d}", "title": f"会议室-{i:02d}", "floor": f"{(i % 12) + 1}F", "capacity": str(4 + (i % 20))}
        for i in range(1, 41)
    ]
    spec = {
        "language": "rp/1",
        "name": "P0-1 40行运行期详情视图验证",
        "models": {"room": {"id": "text", "title": "text", "floor": "text", "capacity": "text"}},
        "datasets": {"rooms": {"model": "room", "rows": rows_40}},
        "variables": {"selected_id": {"type": "text", "value": "R001"}},
        "pages": [
            {
                "id": "list_page",
                "name": "列表页",
                "canvas": {"w": 1280, "h": 800},
                "layout": [
                    {
                        "card": "main_card",
                        "w": "fill",
                        "h": 640,
                        "padding": 24,
                        "gap": 16,
                        "children": [
                            {"label": "hdr", "text": "会议室列表 (40行)", "fontSize": 20, "fontWeight": 700, "w": "fill", "h": 32},
                            {
                                "button": "btn_add_select",
                                "text": "新增并选中第41行",
                                "w": 200,
                                "h": 36,
                                "onClick": [
                                    {"type": "data-add", "target": "rep_rooms", "row": {"id": "R041", "title": "量子实验室", "floor": "18F", "capacity": "30"}},
                                    {"set": {"$selected_id": "R041"}},
                                    {"goto": "detail_page"},
                                ],
                            },
                            {
                                "repeater": "rep_rooms",
                                "dataset": "rooms",
                                "rowHeight": 48,
                                "pageSize": 5,
                                "w": "fill",
                                "h": 300,
                                "template": {
                                    "row": "item_row",
                                    "w": "fill",
                                    "h": 44,
                                    "gap": 12,
                                    "children": [
                                        {"label": "item_title", "text": "${item.title}", "w": 200, "h": 28},
                                        {
                                            "button": "btn_open",
                                            "text": "查看详情",
                                            "w": 96,
                                            "h": 32,
                                            "onClick": [{"set": {"$selected_id": "=item.id"}}, {"goto": "detail_page"}],
                                        },
                                    ],
                                },
                            },
                        ],
                    }
                ],
            },
            {
                "id": "detail_page",
                "name": "详情页",
                "canvas": {"w": 1280, "h": 800},
                "views": {
                    "DetailView": {
                        "source": "rooms",
                        "key": "id",
                        "selector": "selected_id",
                        "fields": {"det_title": "title", "det_floor": "floor", "det_cap": "capacity"},
                    }
                },
                "layout": [
                    {
                        "card": "det_card",
                        "w": "fill",
                        "h": 420,
                        "padding": 24,
                        "gap": 16,
                        "children": [
                            {"label": "det_hdr", "text": "会议室详情", "fontSize": 20, "fontWeight": 700, "w": "fill", "h": 32},
                            {"label": "det_title", "text": "-", "w": "fill", "h": 28},
                            {"label": "det_floor", "text": "-", "w": "fill", "h": 28},
                            {"label": "det_cap", "text": "-", "w": "fill", "h": 28},
                        ],
                    }
                ],
            },
        ],
    }
    lowered, ir = compile_language(spec)
    detail_page = next(p for p in ir["pages"] if p["slug"] == "detail_page")
    page_ix = next((ix for ix in detail_page["interactions"] if ix["trigger"] == "page"), None)
    onload_ev = next((ev for ev in (page_ix or {}).get("events", []) if ev["event"] == "OnLoad"), None)
    onload_cases = (onload_ev or {}).get("cases", [])
    assert len(onload_cases) <= 2, f"Expected <= 2 OnLoad cases for 40-row detail view, got {len(onload_cases)}"
    onload_json = json.dumps(onload_cases, ensure_ascii=False)
    for r in rows_40:
        assert r["title"] not in onload_json, f"Row literal {r['title']} leaked into OnLoad cases"

    rt = ReferenceRuntime((lowered, ir))
    rt.trigger("list_page/btn_add_select", "OnClick")
    assert rt.current_page == "detail_page"
    assert rt.widgets[rt.symbols_by_id["detail_page/det_title"]["name"]]["text"] == "量子实验室"
    assert rt.widgets[rt.symbols_by_id["detail_page/det_floor"]["name"]]["text"] == "18F"
    assert rt.widgets[rt.symbols_by_id["detail_page/det_cap"]["name"]]["text"] == "30"


def test_p0_2_declarative_rules_10_heterogeneous():
    rules = {}
    buttons = []
    for idx in range(1, 11):
        rid = f"rule_policy_{idx}"
        btn_id = f"btn_exec_{idx}"
        rules[rid] = {
            "when": f"{btn_id}.click",
            "require": ["actor_input", "token_input"],
            "guards": [{"assert": f"$quota_{idx} > 0", "message": f"规则{idx}配额不足"}],
            "effect": {
                "variables": {f"quota_{idx}": f"=$quota_{idx} - 1", "last_rule": rid},
                "setText": {"status_banner": f"规则{idx}已生效：${{@actor_input}}"},
            },
            "errorMessage": f"规则{idx}缺少必填项",
        }
        buttons.append({"button": btn_id, "text": f"执行规则{idx}", "w": 110, "h": 36})

    variables = {"last_rule": {"type": "text", "value": "none"}}
    for idx in range(1, 11):
        variables[f"quota_{idx}"] = {"type": "number", "value": idx}

    spec = {
        "language": "rp/1",
        "name": "P0-2 10条异构声明式业务规则验证",
        "variables": variables,
        "rules": rules,
        "pages": [
            {
                "id": "policy_hub",
                "name": "规则中心",
                "canvas": {"w": 1280, "h": 800},
                "layout": [
                    {
                        "card": "hub_card",
                        "w": "fill",
                        "h": 520,
                        "padding": 24,
                        "gap": 16,
                        "children": [
                            {"input": "actor_input", "placeholder": "申请人", "value": "", "w": 240, "h": 36},
                            {"input": "token_input", "placeholder": "凭证号", "value": "", "w": 240, "h": 36},
                            {"label": "status_banner", "text": "就绪", "w": "fill", "h": 28},
                            {"row": "btn_row_1", "gap": 12, "w": "fill", "h": 44, "children": buttons[:5]},
                            {"row": "btn_row_2", "gap": 12, "w": "fill", "h": 44, "children": buttons[5:]},
                        ],
                    }
                ],
            }
        ],
    }
    lowered, ir = compile_language(spec)
    rt = ReferenceRuntime((lowered, ir))
    banner_emit = rt.symbols_by_id["policy_hub/status_banner"]["name"]
    # 1. Missing required input -> blocked by rule
    rt.trigger("policy_hub/btn_exec_1", "OnClick")
    assert rt.widgets[banner_emit]["text"] == "规则1缺少必填项"
    # 2. Fill required inputs -> all 10 rules execute cleanly
    rt.set_input("policy_hub/actor_input", "张工")
    rt.set_input("policy_hub/token_input", "TK-99")
    for idx in range(1, 11):
        rt.trigger(f"policy_hub/btn_exec_{idx}", "OnClick")
        assert rt.variables["last_rule"] == f"rule_policy_{idx}"
        assert rt.variables[f"quota_{idx}"] == idx - 1
        assert rt.widgets[banner_emit]["text"] == f"规则{idx}已生效：张工"
    # 3. Quota exhausted on rule 1 -> blocked by guard
    rt.trigger("policy_hub/btn_exec_1", "OnClick")
    assert rt.widgets[banner_emit]["text"] == "规则1配额不足"

    # Also verify schema-driven synthesize_product_spec on a brand-new domain
    custom_spec = synthesize_product_spec({"title": "冷链试剂申领与温控核验台", "entityName": "reagent_batch"})
    _, custom_ir = compile_language(custom_spec)
    assert len(custom_ir["pages"]) >= 1 and len(custom_ir["symbols"]) >= 10


def test_p1_3_masters_and_adaptive_views():
    spec = {
        "language": "rp/1",
        "name": "P1-3 母版与自适应视图原生四件套验证",
        "masters": {
            "app_shell": {
                "name": "全局导航母版",
                "w": 220,
                "h": 800,
                "root": {
                    "column": "nav_col",
                    "w": 220,
                    "h": 800,
                    "padding": 16,
                    "gap": 12,
                    "fill": "$surface",
                    "children": [
                        {"label": "brand_lbl", "text": "企业统一控制台", "fontSize": 16, "fontWeight": 700, "w": "fill", "h": 28},
                        {"button": "nav_p1", "text": "总览页", "w": "fill", "h": 36, "onClick": [{"goto": "p1"}]},
                        {"button": "nav_p2", "text": "资产页", "w": "fill", "h": 36, "onClick": [{"goto": "p2"}]},
                        {"button": "nav_p3", "text": "审计页", "w": "fill", "h": 36, "onClick": [{"goto": "p3"}]},
                    ],
                },
            }
        },
        "adaptiveViews": [
            {"id": "mobile", "name": "Mobile 390", "width": 390, "condition": "<="},
            {"id": "tablet", "name": "Tablet 768", "width": 768, "condition": "<="},
            {"id": "desktop", "name": "Desktop 1280", "width": 1280, "condition": ">="},
        ],
        "pages": [
            {
                "id": pid,
                "name": pname,
                "canvas": {"w": 1280, "h": 800},
                "master": "app_shell",
                "slot": {
                    "body": [
                        {
                            "card": f"{pid}_card",
                            "w": "fill",
                            "h": 480,
                            "padding": 24,
                            "gap": 12,
                            "children": [
                                {"label": f"{pid}_title", "text": f"{pname}主体内容区", "fontSize": 20, "fontWeight": 700, "w": "fill", "h": 32}
                            ],
                        }
                    ]
                },
            }
            for pid, pname in [("p1", "总览页"), ("p2", "资产页"), ("p3", "审计页")]
        ],
    }
    with tempfile.TemporaryDirectory(prefix="rp1-p13-") as tmp_dir:
        spec_path = os.path.join(tmp_dir, "app.spec.json")
        rp_path = os.path.join(tmp_dir, "app.rp")
        with open(spec_path, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False, indent=2)
        subprocess.run(
            ["node", os.path.join(SCRIPTS, "proto.mjs"), "generate", "--spec", spec_path, "--out-dir", os.path.join(tmp_dir, "bundle"), "--out-rp", rp_path],
            check=True,
            capture_output=True,
            text=True,
        )
        read_res = subprocess.run(
            ["node", os.path.join(SCRIPTS, "rp-read.mjs"), rp_path, "--json"],
            check=True,
            capture_output=True,
            text=True,
        )
        rp_summary = json.loads(read_res.stdout)
        assert rp_summary["counts"]["masters"] == 1, f"Expected 1 master in .rp, got {rp_summary['counts']}"
        assert rp_summary["sitemap"]["masters"][0]["name"] == "全局导航母版"
        assert rp_summary["counts"]["problems"] == 0
        assert rp_summary["counts"]["danglingRefs"] == 0
        assert rp_summary["counts"]["sentinelSlotsNonZero"] == 0


def test_p2_4_unified_glyph_measurement_and_check_audit():
    m_narrow = measure_text_glyphs("iiiiii", 16, 400)
    m_wide = measure_text_glyphs("中华人民共和国", 16, 700)
    assert m_wide["width"] > m_narrow["width"] * 2, f"Expected real font glyph width difference, got {m_narrow} vs {m_wide}"


def test_p3_6_three_way_merge_preserves_4_designer_edits():
    base_spec = {
        "language": "rp/1",
        "name": "P3-6 三方合并验证",
        "pages": [
            {
                "id": "home",
                "name": "首页",
                "canvas": {"w": 1280, "h": 800},
                "layout": [
                    {
                        "card": "hero_card",
                        "w": 600,
                        "h": 360,
                        "padding": 24,
                        "gap": 16,
                        "children": [
                            {"label": "title_lbl", "text": "旧标题", "fill": "#FFFFFF", "color": "#1E293B", "stroke": "#CBD5E1", "w": 320, "h": 36},
                            {"label": "sub_lbl", "text": "初始副标题", "w": 320, "h": 28},
                            {"button": "cta_btn", "text": "立即预约", "w": 160, "h": 40},
                        ],
                    }
                ],
            }
        ],
    }
    with tempfile.TemporaryDirectory(prefix="rp1-p36-") as tmp_dir:
        base_spec_path = os.path.join(tmp_dir, "base.spec.json")
        new_spec_path = os.path.join(tmp_dir, "new.spec.json")
        merged_spec_path = os.path.join(tmp_dir, "merged.spec.json")
        base_rp = os.path.join(tmp_dir, "base.rp")
        edited_rp = os.path.join(tmp_dir, "edited.rp")
        merged_rp = os.path.join(tmp_dir, "merged.rp")
        with open(base_spec_path, "w", encoding="utf-8") as f:
            json.dump(base_spec, f, ensure_ascii=False, indent=2)
        subprocess.run(
            ["node", os.path.join(SCRIPTS, "proto.mjs"), "generate", "--spec", base_spec_path, "--out-dir", os.path.join(tmp_dir, "b1"), "--out-rp", base_rp],
            check=True,
            capture_output=True,
            text=True,
        )
        # Simulate designer making 3 color edits (fill, color, stroke) + 1 position edit (X, Y) in edited.rp
        _, ir = compile_language(copy.deepcopy(base_spec))
        sym_map = {s["id"]: s["name"] for s in ir["symbols"]}
        title_emit = sym_map["home/title_lbl"]
        cta_emit = sym_map["home/cta_btn"]
        designer_patch = r"""
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
const [srcRp, dstRp, titleName, ctaName] = process.argv.slice(1);
let buf = readFileSync(srcRp);
const pageRec = readRecords(buf).find(r => r.className === 'Axure:Page');
const g = parsePayload(pageRec);
const argb = h => (0xFF000000 | parseInt(h.replace('#', ''), 16)) >>> 0;
for (const o of g.objects.values()) {
  if (!o.className?.startsWith('Axure:DiagramObject:')) continue;
  const wname = field(field(o.body, 'name-block') ?? {}, 'text')?.text;
  const st = g.objects.get(field(o.body, 'MyStyle')?.value);
  for (const it of field(st?.body ?? {}, 'PropList')?.items ?? []) {
    const code = field(it, 'DOAName')?.value, val = field(it, 'Value');
    if (wname === titleName && code === 3221225479) field(val, 'fill-color').value = argb('#FEF3C7');
    if (wname === titleName && code === 3221225480) field(val, 'fill-color').value = argb('#F59E0B');
    if (wname === titleName && code === 3221225478) field(val, 'fill-color').value = argb('#B45309');
    if (wname === ctaName && code === 3221225573) {
      const xf = field(val, 'X'), yf = field(val, 'Y');
      xf.value = 280; delete xf.rawNumber;
      yf.value = 220; delete yf.rawNumber;
    }
  }
}
buf = replaceRecord(buf, pageRec, encodeRecord(pageRec, pageRec.strings, encodePayload(g.roots)));
writeFileSync(dstRp, buf);
"""
        subprocess.run(
            ["node", "--input-type=module", "-e", designer_patch, base_rp, edited_rp, title_emit, cta_emit],
            cwd=SCRIPTS,
            check=True,
        )
        # AI updates new_spec: changes sub_lbl text
        new_spec = copy.deepcopy(base_spec)
        new_spec["pages"][0]["layout"][0]["children"][1]["text"] = "AI更新后的副标题V2"
        with open(new_spec_path, "w", encoding="utf-8") as f:
            json.dump(new_spec, f, ensure_ascii=False, indent=2)

        merge_res = three_way_merge_rp(
            base_spec_path=base_spec_path,
            base_rp_path=base_rp,
            edited_rp_path=edited_rp,
            new_spec_path=new_spec_path,
            out_spec_path=merged_spec_path,
            out_rp_path=merged_rp,
        )
        assert merge_res["ok"] is True
        merged_props = extract_rp_visual_props(merged_rp)
        assert merged_props[title_emit]["fill"] == "#FEF3C7"
        assert merged_props[title_emit]["stroke"] == "#F59E0B"
        assert merged_props[title_emit]["color"] == "#B45309"
        assert merged_props[cta_emit]["x"] == 280 and merged_props[cta_emit]["y"] == 220


def test_p2_5_reference_actions_and_native_expressions():
    from rp_oracle import fuzz_dual_model_trace
    spec = {
        "$schema": "rp/1",
        "language": "rp/1",
        "name": "ReferenceFuzzSmoke",
        "models": {"room": {"id": "text", "title": "text", "status": "text", "price": "number"}},
        "datasets": {
            "rooms": {
                "model": "room",
                "rows": [
                    {"id": "R001", "title": "A301", "status": "空闲", "price": 120},
                    {"id": "R002", "title": "B201", "status": "空闲", "price": 200},
                ],
            }
        },
        "variables": {"selected_id": "R001", "msg": "就绪"},
        "computed": {
            "free_cnt": {"op": "count", "repeater": "room_rep", "where": "Item.status == \"空闲\""},
            "total_price": {"op": "sum", "repeater": "room_rep", "field": "price", "where": "Item.status == \"已预约\""},
        },
        "views": {"Detail": {"source": "rooms", "key": "id", "selector": "$selected_id", "fields": {"d_title": "title", "d_status": "status"}}},
        "pages": [
            {
                "id": "home",
                "name": "首页",
                "layout": [
                    {"input": "kw_inp", "placeholder": "房间号"},
                    {"button": "add_btn", "text": "新增", "onClick": [{"type": "data-add", "target": "room_rep", "row": {"id": "R040", "title": "=@kw_inp", "status": "空闲", "price": 150}}]},
                    {"repeater": "room_rep", "dataset": "rooms", "template": {"row": "r", "children": [{"label": "rt", "text": "${item.title}"}, {"button": "book_btn", "text": "预约", "onClick": [{"type": "data-update", "target": "room_rep", "where": "item.id == item.id", "set": {"status": "已预约"}}, {"set": {"$selected_id": "=item.id"}}]}]}},
                    {"label": "d_title", "text": "-"},
                    {"label": "d_status", "text": "-"},
                    {"label": "stat_lbl", "text": "空闲: ${$free_cnt} / 总价: ${$total_price}"},
                ],
            }
        ],
    }
    res = fuzz_dual_model_trace(spec, steps=200, seed=42)
    assert res["ok"] is True and res["steps"] == 200 and res["executedClicks"] > 0
    assert res["expressionMismatches"] == 0 and res["stateHashMismatches"] is None
    assert res["nativeStateComparison"] == "not_run"


if __name__ == "__main__":
    test_p0_1_runtime_selection_model_40_rows()
    test_p0_2_declarative_rules_10_heterogeneous()
    test_p1_3_masters_and_adaptive_views()
    test_p2_4_unified_glyph_measurement_and_check_audit()
    test_p2_5_reference_actions_and_native_expressions()
    test_p3_6_three_way_merge_preserves_4_designer_edits()
    print(json.dumps({"ok": True, "tests": 6, "upgrades": ["P0-1", "P0-2", "P1-3a", "P1-3b", "P2-4", "P2-5", "P3-6"]}))
