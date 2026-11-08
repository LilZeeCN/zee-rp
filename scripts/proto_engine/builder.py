# 从 scripts/proto.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 1;行为不变,勿手改)。
import copy
import json
import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
from .tokens import THEMES, resolve_color
from .expander import expand_chart_state, expand_kpi_card, expand_modal_new_dish, expand_notice_card, expand_sidebar, expand_table_four_states, expand_topbar, make_box, make_button, make_label
from .layout import emit_tree_to_axvg, layout_node, measure_node
from .audit import audit_prototype, render_flat_children_png, render_structure_overlay_png, summarize_scene_audits

# -------------------- 5. FLAGSHIP PROTOTYPE BUILDER & CLI --------------------
def build_flagship_prototype(theme_name="enterprise-light", title_override=None):
    """构建旗舰级「餐饮菜品与实时库存经营中台」多态交互原型树与完整状态机。"""
    theme_dict = THEMES.get(theme_name, THEMES["enterprise-light"])
    # 1. 趋势图表动态面板 (3 个状态: orders / revenue / category)
    trend_states = [
        {
            "name": "orders",
            "label": "订单趋势",
            "tree": expand_chart_state(
                "orders",
                "近 7 日门店堂食与外卖订单量趋势",
                "峰值出现在周六晚高峰 (1,480 单/日) · 环比上周 +14.2%",
                ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
                [860, 920, 1040, 980, 1260, 1480, 1350],
                unit="单",
                accent="$brand",
                mode="bar",
            ),
        },
        {
            "name": "revenue",
            "label": "营收趋势",
            "tree": expand_chart_state(
                "revenue",
                "近 7 日门店实收营业额走势 (千元)",
                "实收毛利率稳定在 68.4% · 客单价均值 ¥ 64.50",
                ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
                [52, 58, 64, 61, 79, 96, 88],
                unit="k",
                accent="$accent",
                mode="line",
            ),
        },
        {
            "name": "category",
            "label": "品类占比",
            "tree": expand_chart_state(
                "category",
                "核心菜品品类销量与营收贡献占比",
                "川湘招牌与主厨轻食合计贡献 66% 核心营收",
                ["川湘招牌菜", "主厨能量碗", "特色炭烤类", "鲜果甜品饮品"],
                [38, 28, 20, 14],
                unit="%",
                accent="$success",
                mode="rank",
            ),
        },
    ]
    # 2. 菜品管理表格动态面板 (4 个必选状态: default / empty / loading / error)
    table_four = expand_table_four_states(w=1184, h=336)
    table_states = [
        {"name": "default", "label": "默认列表态", "tree": table_four["default"]},
        {"name": "empty", "label": "空数据态", "tree": table_four["empty"]},
        {"name": "loading", "label": "骨架加载态", "tree": table_four["loading"]},
        {"name": "error", "label": "接口异常态", "tree": table_four["error"]},
    ]
    # 3. 顶部导航、KPI 行、中部图表与预警区、底部四态表格控制栏
    sidebar = expand_sidebar({
        "id": "main",
        "w": 208,
        "h": 900,
        "brandTitle": "Supermancall",
        "brandSubtitle": "智慧餐饮经营系统 v4.2",
        "items": [
            {"id": "overview", "label": "经营数据总览", "active": False},
            {"id": "dishes", "label": "菜品与库存管理", "active": True, "badge": "58"},
            {"id": "orders", "label": "全渠道实时订单", "active": False, "badge": "12"},
            {"id": "members", "label": "会员营销与储值", "active": False},
            {"id": "supply", "label": "中央厨房供应链", "active": False},
            {"id": "settings", "label": "门店与权限设置", "active": False},
        ],
    })
    topbar = expand_topbar({
        "id": "main",
        "w": 1232,
        "h": 64,
        "title": title_override or "菜品与实时库存管理工作台",
        "subtitle": "支持多维趋势切换、表格四态预览 (Default / Empty / Loading / Error) 与新建菜品表单非空校验",
    })
    kpi_row = make_box(
        "grp-kpi-row",
        layout="row",
        w=1184,
        h=108,
        gap=16,
        isGroup=True,
        children=[
            expand_kpi_card({"id": "dishes", "label": "在售菜品总数", "value": "58", "trend": "+4 本周上新", "trendType": "success", "subtitle": "含 12 款多规格招牌菜", "accent": "$brand", "h": 108}),
            expand_kpi_card({"id": "orders", "label": "今日实时订单", "value": "1,480", "trend": "+14.2%", "trendType": "success", "subtitle": "堂食 890 单 · 外卖 590 单", "accent": "$accent", "h": 108}),
            expand_kpi_card({"id": "revenue", "label": "今日实收流水", "value": "¥ 96,420", "trend": "+18.6%", "trendType": "success", "subtitle": "客单价均值 ¥ 65.15", "accent": "$success", "h": 108}),
            expand_kpi_card({"id": "warn", "label": "库存预警/售罄", "value": "2 款", "trend": "需及时补货", "trendType": "warning", "subtitle": "杨枝甘露(5份) · 酒酿圆子(0份)", "accent": "$warning", "h": 108}),
        ],
    )
    middle_row = make_box(
        "grp-middle-section",
        layout="row",
        w=1184,
        h=272,
        gap=16,
        isGroup=True,
        children=[
            make_box(
                "grp-card-trend",
                layout="column",
                w=744,
                h=272,
                padding=[12, 0],
                gap=8,
                fill="$surface",
                stroke="$line",
                radius=8,
                isGroup=True,
                bgName="bg-card-trend",
                children=[
                    make_box(
                        "grp-trend-toolbar",
                        layout="row",
                        w=744,
                        h=32,
                        padding=[0, 16],
                        align="center",
                        gap=8,
                        isGroup=True,
                        children=[
                            make_label("txt-trend-card-title", "经营核心指标分时分析", size=15, weight=700, color="$ink", flex=1),
                            make_button("tab-trend-orders", "订单趋势", variant="primary", w=88, h=28, size=12, radius=6),
                            make_button("tab-trend-revenue", "营收趋势", variant="outline", w=88, h=28, size=12, radius=6),
                            make_button("tab-trend-category", "品类占比", variant="outline", w=88, h=28, size=12, radius=6),
                        ],
                    ),
                    {
                        "type": "dynamic-panel",
                        "name": "panel-trend",
                        "w": 744,
                        "h": 216,
                        "states": trend_states,
                    },
                ],
            ),
            expand_notice_card(w=424, h=272),
        ],
    )
    table_section = make_box(
        "grp-table-section",
        layout="column",
        w=1184,
        h=396,
        padding=[12, 0],
        gap=8,
        fill="$surface",
        stroke="$line",
        radius=8,
        isGroup=True,
        bgName="bg-table-section",
        children=[
            make_box(
                "grp-table-toolbar",
                layout="row",
                w=1184,
                h=36,
                padding=[0, 16],
                gap=8,
                align="center",
                isGroup=True,
                children=[
                    make_label("txt-table-sec-title", "门店菜品与实时库存明细", size=15, weight=700, color="$ink"),
                    make_button("txt-state-indicator", "当前视图：默认列表态 (Default)", variant="soft", w=216, h=26, size=11, radius=999),
                    make_box("sp-toolbar-flex", layout="stack", w=16, h=12, flex=1, isGroup=False, children=[]),
                    make_label("lbl-state-switch", "四态视图切换：", size=12, weight=500, color="$ink-2"),
                    make_button("btn-state-default", "默认列表 (Default)", variant="primary", w=128, h=28, size=11, radius=6),
                    make_button("btn-state-empty", "空状态 (Empty)", variant="outline", w=112, h=28, size=11, radius=6),
                    make_button("btn-state-loading", "加载态 (Loading)", variant="outline", w=120, h=28, size=11, radius=6),
                    make_button("btn-state-error", "异常态 (Error)", variant="outline", w=112, h=28, size=11, radius=6),
                ],
            ),
            {
                "type": "dynamic-panel",
                "name": "panel-table",
                "w": 1184,
                "h": 336,
                "states": table_states,
            },
        ],
    )
    main_area = make_box(
        "grp-main-area",
        layout="column",
        w=1232,
        h=900,
        gap=0,
        isGroup=True,
        children=[
            topbar,
            make_box(
                "grp-content-body",
                layout="column",
                w=1232,
                h=836,
                padding=[16, 24],
                gap=16,
                isGroup=True,
                children=[
                    kpi_row,
                    middle_row,
                    table_section,
                ],
            ),
        ],
    )
    modal_node = expand_modal_new_dish(canvas_w=1440, canvas_h=900)
    root = make_box(
        "Page 1",
        layout="stack",
        w=1440,
        h=900,
        fill="$bg",
        isGroup=False,
        children=[
            make_box(
                "grp-app-shell",
                layout="row",
                x=0,
                y=0,
                w=1440,
                h=900,
                gap=0,
                isGroup=True,
                children=[sidebar, main_area],
            ),
            modal_node,
        ],
    )
    return root, theme_dict
def compile_prototype_bundle(out_dir, theme_name="enterprise-light", title_override=None, no_interactions=False, strict_audit=False):
    """编译完整的多态原型产物包（主画布 + 所有面板状态 + 四视角预览图 + 交互编译计划 + 量化审计报告）。"""
    os.makedirs(out_dir, exist_ok=True)
    states_dir = os.path.join(out_dir, "states")
    os.makedirs(states_dir, exist_ok=True)
    root, theme_dict = build_flagship_prototype(theme_name=theme_name, title_override=title_override)
    measure_node(root)
    layout_node(root, 0, 0, 1440, 900)
    # 1. 发射主页面 .axvg.json (不含动态面板内部占位，供真实 DynamicPanel 挂载)
    emitted_main = emit_tree_to_axvg(root, theme_dict, include_dynamic_panel_placeholders=False)
    # 2. 发射全量预览树 (展开各动态面板首个状态，供 01-preview.png 与结构审计)
    root_preview, _ = build_flagship_prototype(theme_name=theme_name, title_override=title_override)
    measure_node(root_preview)
    layout_node(root_preview, 0, 0, 1440, 900)
    emitted_preview = emit_tree_to_axvg(root_preview, theme_dict, include_dynamic_panel_placeholders=True)
    main_axvg_path = os.path.join(out_dir, "page-main.axvg.json")
    main_spec_path = os.path.join(out_dir, "page-main.spec.json")
    with open(main_axvg_path, "w", encoding="utf-8") as f:
        json.dump(emitted_main["axvg"], f, ensure_ascii=False, indent=2)
    with open(main_spec_path, "w", encoding="utf-8") as f:
        json.dump(emitted_main["spec"], f, ensure_ascii=False, indent=2)
    # 3. 发射各动态面板的独立状态 .axvg.json / .spec.json / 预览图
    scenes = [{"id": "page-main", "page": "Page 1", "kind": "page-default", "scope": "page",
               "canvas": {"w": 1440, "h": 900}, "status": "not-run"}]
    panel_plans = []
    for dp in emitted_main["dynamicPanels"]:
        p_name = dp["name"]
        p_w, p_h = dp["w"], dp["h"]
        state_entries = []
        for st in dp["states"]:
            st_name = st["name"]
            st_tree = st["tree"]
            scene_id = f"{p_name}__{st_name}"
            scene = {"id": scene_id, "page": "Page 1", "kind": "panel-state", "scope": "container-local",
                     "parentSceneId": "page-main", "panel": p_name, "state": st_name,
                     "canvas": {"w": p_w, "h": p_h}, "status": "not-run"}
            scenes.append(scene)
            measure_node(st_tree, available_w=p_w)
            layout_node(st_tree, 0, 0, p_w, p_h)
            st_emitted = emit_tree_to_axvg(st_tree, theme_dict, include_dynamic_panel_placeholders=True)
            base_fn = f"{p_name}__{st_name}"
            st_axvg_path = os.path.join(states_dir, f"{base_fn}.axvg.json")
            st_spec_path = os.path.join(states_dir, f"{base_fn}.spec.json")
            st_png_path = os.path.join(states_dir, f"{base_fn}.png")
            with open(st_axvg_path, "w", encoding="utf-8") as f:
                json.dump(st_emitted["axvg"], f, ensure_ascii=False, indent=2)
            with open(st_spec_path, "w", encoding="utf-8") as f:
                json.dump(st_emitted["spec"], f, ensure_ascii=False, indent=2)
            st_img = render_flat_children_png(p_w, p_h, resolve_color("$surface", theme_dict), st_emitted["flatChildren"], include_modal=False)
            st_img.save(st_png_path)
            scene["audit"] = audit_prototype(st_tree, st_emitted, {
                "domain": "web", "theme": theme_name, "auditScope": "container-local",
                "allMainWidgets": st_emitted["flatChildren"], "dynamicPanels": [],
                "nativeInputs": st_emitted["nativeInputs"], "nativeStyles": st_emitted["nativeStyles"],
            }, strict_audit=strict_audit)
            scene.update({"axvgPath": st_axvg_path, "specPath": st_spec_path, "pngPath": st_png_path})
            state_entries.append({
                "sceneId": scene_id, "audit": scene["audit"],
                "name": st_name,
                "label": st.get("label", st_name),
                "axvgPath": st_axvg_path,
                "specPath": st_spec_path,
                "pngPath": st_png_path,
            })
        panel_plans.append({
            "name": p_name,
            "x": dp["x"],
            "y": dp["y"],
            "w": p_w,
            "h": p_h,
            "states": state_entries,
        })
    # 4. 构造有序的弹窗控制目标列表 (保证 bringToFront 时从底板到输入框/按钮的正确 Z-Order)
    modal_visual_targets = list(dict.fromkeys(emitted_main["modalTargets"]))
    native_input_names = [inp["name"] for inp in emitted_main["nativeInputs"]]
    interactive_top = [t for t in modal_visual_targets if t.startswith("btn-") or t.startswith("txt-modal-feedback")]
    backdrop_and_cards = [t for t in modal_visual_targets if t not in interactive_top]
    ordered_modal_targets = backdrop_and_cards + interactive_top + native_input_names
    # 5. 构造声明式状态机与交互绑定表
    interactions = [
        {
            "trigger": {"page": "Page 1"},
            "description": "页面初始化时隐藏新建菜品弹窗层，保持工作台整洁",
            "events": [
                {
                    "event": "OnPageLoad",
                    "cases": [
                        {
                            "name": "InitHideModal",
                            "actions": [
                                {"type": "hide", "target": tgt, "duration": 0, "animation": "none"}
                                for tgt in ordered_modal_targets
                            ],
                        }
                    ],
                }
            ],
        },
        # 趋势图三态 Tab 切换
        {
            "trigger": "tab-trend-orders",
            "description": "切换到订单趋势图表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "SwitchTrendOrders",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-trend", "state": "orders"},
                                {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 订单趋势"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "tab-trend-revenue",
            "description": "切换到营收趋势图表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "SwitchTrendRevenue",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-trend", "state": "revenue"},
                                {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 营收趋势"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "tab-trend-category",
            "description": "切换到品类占比图表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "SwitchTrendCategory",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-trend", "state": "category"},
                                {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 品类占比"},
                            ],
                        }
                    ],
                }
            ],
        },
        # 表格四态视图切换 (default / empty / loading / error)
        {
            "trigger": "btn-state-default",
            "description": "切换表格到默认数据列表态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableDefault",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "default"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：默认列表态 (Default)"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-state-empty",
            "description": "切换表格到空数据态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableEmpty",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "empty"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：空数据态 (Empty)"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-state-loading",
            "description": "切换表格到骨架屏加载态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableLoading",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "loading"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：骨架加载态 (Loading)"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-state-error",
            "description": "切换表格到接口异常态",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ShowTableError",
                            "actions": [
                                {"type": "set-panel-state", "target": "panel-table", "state": "error"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：接口异常态 (Error)"},
                            ],
                        }
                    ],
                }
            ],
        },
        # 打开/关闭新建菜品弹窗
        {
            "trigger": "btn-new-dish",
            "description": "打开新建菜品弹窗并将输入控件置顶",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "OpenNewDishModal",
                            "actions": [
                                *[
                                    {"type": "show", "target": tgt, "duration": 0, "animation": "none", "bringToFront": True}
                                    for tgt in ordered_modal_targets
                                ],
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "请填写上方必填字段后点击「确认保存菜品」"},
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-modal-cancel",
            "description": "取消并关闭新建菜品弹窗",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "CancelNewDishModal",
                            "actions": [
                                {"type": "hide", "target": tgt, "duration": 0, "animation": "none"}
                                for tgt in ordered_modal_targets
                            ],
                        }
                    ],
                }
            ],
        },
        {
            "trigger": "btn-modal-close",
            "description": "点击右上角关闭按钮隐藏弹窗",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "CloseNewDishModal",
                            "actions": [
                                {"type": "hide", "target": tgt, "duration": 0, "animation": "none"}
                                for tgt in ordered_modal_targets
                            ],
                        }
                    ],
                }
            ],
        },
        # 表单提交三分支条件校验 (空菜品名 / 空售价 / 校验通过写入)
        {
            "trigger": "btn-modal-submit",
            "description": "新建菜品表单多分支非空校验与提交反馈",
            "events": [
                {
                    "event": "OnClick",
                    "cases": [
                        {
                            "name": "ValidateEmptyDishName",
                            "when": {"op": "==", "left": {"widget": "input-dish-name", "fn": "GetWidgetText"}, "right": {"value": ""}},
                            "actions": [
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "! 校验失败：请输入菜品名称（必填项不能为空）"},
                            ],
                        },
                        {
                            "name": "ValidateEmptyDishPrice",
                            "when": {"op": "==", "left": {"widget": "input-dish-price", "fn": "GetWidgetText"}, "right": {"value": ""}},
                            "actions": [
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "! 校验失败：请输入标准售价（单位：元）"},
                            ],
                        },
                        {
                            "name": "SubmitValidDish",
                            "actions": [
                                {"type": "set-text", "target": "txt-modal-feedback", "text": "● 保存成功：新菜品已写入菜单库并同步至列表"},
                                {"type": "set-text", "target": "txt-kpi-dishes-val", "text": "59"},
                                {"type": "set-panel-state", "target": "panel-table", "state": "default"},
                                {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：默认列表态 (已新增 1 款菜品)"},
                            ],
                        },
                    ],
                }
            ],
        },
    ]
    compile_plan = {
        "pageName": "Page 1",
        "theme": theme_name,
        "static": bool(no_interactions),
        "canvas": {"w": 1440, "h": 900},
        "mainAxvgPath": main_axvg_path,
        "mainSpecPath": main_spec_path,
        "dynamicPanels": panel_plans,
        "nativeInputs": emitted_main["nativeInputs"], "nativeStyles": emitted_main["nativeStyles"],
        "modalTargets": ordered_modal_targets,
        "allMainWidgets": emitted_main["flatChildren"],
        "interactions": [] if no_interactions else interactions,
    }
    # 6. 生成多视角预览图
    bg_hex = resolve_color("$bg", theme_dict)
    img_preview = render_flat_children_png(1440, 900, bg_hex, emitted_preview["flatChildren"], include_modal=False)
    p01 = os.path.join(out_dir, "01-preview.png")
    img_preview.save(p01)
    img_struct = render_structure_overlay_png(img_preview, root_preview, emitted_main["dynamicPanels"])
    p02 = os.path.join(out_dir, "02-structure.png")
    img_struct.save(p02)
    img_thumb = img_preview.resize((360, 225), Image.Resampling.LANCZOS)
    p03 = os.path.join(out_dir, "03-thumb25.png")
    img_thumb.save(p03)
    img_modal = render_flat_children_png(1440, 900, bg_hex, emitted_preview["flatChildren"], include_modal=True)
    p04 = os.path.join(out_dir, "04-modal-preview.png")
    img_modal.save(p04)
    # 7. 执行量化审美与结构审计
    scenes[0]["audit"] = audit_prototype(root_preview, emitted_preview, compile_plan, strict_audit=strict_audit)
    scenes[0].update({"axvgPath": main_axvg_path, "specPath": main_spec_path, "pngPath": p01})

    def audit_modal_scenes(tree):
        for child in tree.get("children", []):
            if not child.get("isModal"):
                audit_modal_scenes(child)
                continue
            modal = copy.deepcopy(child)
            modal.pop("isModal", None)
            modal.pop("x", None)
            modal.pop("y", None)
            mw, mh = child["_w"], child["_h"]
            measure_node(modal, available_w=mw)
            layout_node(modal, 0, 0, mw, mh)
            emitted = emit_tree_to_axvg(modal, theme_dict, include_dynamic_panel_placeholders=True)
            scene_id = f"page-main__{child['name']}__modal"
            scene = {"id": scene_id, "page": "Page 1", "kind": "modal", "scope": "container-local",
                     "parentSceneId": "page-main", "modal": child["name"], "canvas": {"w": mw, "h": mh}, "status": "not-run"}
            scenes.append(scene)
            scene["audit"] = audit_prototype(modal, emitted, {
                "domain": "web", "theme": theme_name, "auditScope": "container-local",
                "allMainWidgets": emitted["flatChildren"], "dynamicPanels": [], "nativeInputs": emitted["nativeInputs"], "nativeStyles": emitted["nativeStyles"],
            }, strict_audit=strict_audit)
            audit_modal_scenes(modal)
    audit_modal_scenes(root)
    audit = summarize_scene_audits(scenes, strict_audit=strict_audit)
    compile_plan["scenes"] = scenes
    compile_plan["sceneCoverage"] = audit["sceneCoverage"]
    compile_plan["audit"] = audit
    compile_plan["previews"] = {
        "preview": p01,
        "structure": p02,
        "thumb25": p03,
        "modalPreview": p04,
    }
    plan_path = os.path.join(out_dir, "compile-plan.json")
    audit_path = os.path.join(out_dir, "audit-report.json")
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump(compile_plan, f, ensure_ascii=False, indent=2)
    with open(audit_path, "w", encoding="utf-8") as f:
        json.dump(audit, f, ensure_ascii=False, indent=2)
    return {
        "ok": audit["ok"],
        "outDir": out_dir,
        "theme": theme_name,
        "static": bool(no_interactions),
        "planPath": plan_path,
        "auditPath": audit_path,
        "previews": compile_plan["previews"],
        "audit": audit,
    }
