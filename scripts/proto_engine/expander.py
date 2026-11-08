# 从 scripts/proto.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 1;行为不变,勿手改)。
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, RADIUS_TOKENS, SPACING_TOKENS
from .fonts import measure_text
from .tokens import snap_token

# -------------------- 2. HIGH-LEVEL SEMANTIC COMPONENT EXPANDER --------------------
def make_box(name, **kwargs):
    node = {"type": "box", "name": name}
    node.update(kwargs)
    return node
def make_label(name, text, size=14, weight=400, color="$ink", align="left", **kwargs):
    node = {
        "type": "label",
        "name": name,
        "text": str(text),
        "fontSize": snap_token(size, FONT_SIZE_TOKENS),
        "fontWeight": snap_token(weight, FONT_WEIGHT_TOKENS),
        "color": color,
        "align": align,
    }
    node.update(kwargs)
    return node
def make_button(name, text, variant="primary", w=None, h=32, size=13, radius=6, **kwargs):
    styles = {
        "primary": {"fill": "$brand", "color": "$ink-inv", "stroke": None, "weight": 600},
        "accent": {"fill": "$accent", "color": "$ink-inv", "stroke": None, "weight": 600},
        "secondary": {"fill": "$surface-2", "color": "$ink", "stroke": "$line-strong", "weight": 500},
        "outline": {"fill": "$surface", "color": "$ink-2", "stroke": "$line-strong", "weight": 500},
        "soft": {"fill": "$brand-soft", "color": "$brand", "stroke": None, "weight": 600},
        "accent-soft": {"fill": "$accent-soft", "color": "$accent", "stroke": None, "weight": 600},
        "success-soft": {"fill": "$success-soft", "color": "$success", "stroke": None, "weight": 600},
        "warning-soft": {"fill": "$warning-soft", "color": "$warning", "stroke": None, "weight": 600},
        "danger-soft": {"fill": "$danger-soft", "color": "$danger", "stroke": None, "weight": 600},
        "danger": {"fill": "$danger", "color": "$ink-inv", "stroke": None, "weight": 600},
        "glass": {"fill": "$glass", "color": "$ink", "stroke": "$glass-border", "weight": 600},
        "ghost": {"fill": None, "color": "$ink-2", "stroke": None, "weight": 500},
        "sidebar-active": {"fill": "$sidebar-active", "color": "$sidebar-ink-active", "stroke": None, "weight": 600},
        "sidebar-item": {"fill": "$sidebar-surface", "color": "$sidebar-ink", "stroke": None, "weight": 400},
    }
    st = styles.get(variant, styles["primary"])
    tw, _ = measure_text(text, size, st["weight"])
    spacing = float(kwargs.get("letterSpacing") or 0)
    if spacing:
        tw += max((max(0, len(line) - 1) * spacing for line in str(text).split("\n")), default=0)
    btn_w = w if w is not None else max(64, tw + 24)
    node = {
        "type": "shape-text",
        "name": name,
        "text": str(text),
        "w": btn_w,
        "_auto_w": w is None,
        "h": h,
        "fill": kwargs.pop("fill", st["fill"]),
        "stroke": kwargs.pop("stroke", st["stroke"]),
        "color": kwargs.pop("color", st["color"]),
        "fontSize": snap_token(size, FONT_SIZE_TOKENS),
        "fontWeight": snap_token(st["weight"], FONT_WEIGHT_TOKENS),
        "radius": snap_token(radius, RADIUS_TOKENS),
        "align": kwargs.pop("align", "center"),
        "_text_v_align": "middle",
    }
    node.update(kwargs)
    return node
def expand_sidebar(node):
    cid = node.get("id", "main")
    w = int(node.get("w") or 208)
    h = int(node.get("h") or 900)
    brand_title = node.get("brandTitle") or node.get("brand") or "Supermancall"
    brand_sub = node.get("brandSubtitle") or node.get("brandSub") or "餐饮数字化经营中台"
    items = node.get("items") or node.get("navItems") or []
    active_index = node.get("activeIndex", node.get("activeNav", 1))
    store_name = node.get("storeName", "朝阳大悦城旗舰店 · 营业中")
    nav_children = []
    for idx, it in enumerate(items):
        if isinstance(it, dict):
            iid = it.get("id", f"item-{idx+1}")
            label = it.get("label", f"菜单 {idx+1}")
            active = bool(it.get("active", idx == active_index))
            badge = it.get("badge")
        else:
            iid = f"item-{idx+1}"
            label = str(it)
            active = idx == active_index
            badge = None
        row_children = [
            {
                "type": "shape-text",
                "name": f"nav-dot-{iid}",
                "text": "●" if active else "·",
                "w": 16,
                "h": 24,
                "fill": None,
                "color": "$sidebar-ink-active" if active else "$sidebar-ink",
                "fontSize": 12,
                "fontWeight": 600,
                "align": "center",
            },
            make_label(
                f"nav-lbl-{iid}",
                label,
                size=13,
                weight=600 if active else 400,
                color="$sidebar-ink-active" if active else "$sidebar-ink",
                flex=1,
            ),
        ]
        if badge:
            row_children.append(
                make_button(
                    f"nav-badge-{iid}",
                    str(badge),
                    variant="danger" if badge != "NEW" else "primary",
                    w=32,
                    h=20,
                    size=11,
                    radius=12,
                )
            )
        nav_children.append(
            make_box(
                f"grp-nav-{iid}",
                layout="row",
                w=w - 24,
                h=40,
                padding=[8, 8],
                gap=4,
                align="center",
                fill="$sidebar-active" if active else "$sidebar-surface",
                radius=8,
                isGroup=True,
                bgName=f"bg-nav-{iid}",
                children=row_children,
            )
        )
    return make_box(
        f"grp-sidebar-{cid}",
        layout="column",
        w=w,
        h=h,
        padding=[20, 12],
        gap=16,
        fill="$sidebar-bg",
        isGroup=True,
        bgName=f"bg-sidebar-{cid}",
        children=[
            make_box(
                f"grp-brand-{cid}",
                layout="row",
                w=w - 24,
                h=52,
                padding=[8, 8],
                gap=12,
                align="center",
                fill="$sidebar-surface",
                radius=8,
                isGroup=True,
                bgName=f"bg-brand-{cid}",
                children=[
                    make_button(f"icon-brand-{cid}", "S", variant="primary", w=32, h=32, size=16, radius=8),
                    make_box(
                        f"grp-brand-txt-{cid}",
                        layout="column",
                        gap=4,
                        flex=1,
                        isGroup=False,
                        children=[
                            make_label(f"txt-brand-title-{cid}", brand_title, size=14, weight=700, color="$sidebar-ink-active"),
                            make_label(f"txt-brand-sub-{cid}", brand_sub, size=11, weight=400, color="$sidebar-ink"),
                        ],
                    ),
                ],
            ),
            make_label(f"txt-nav-sec-{cid}", "核心业务导航", size=11, weight=600, color="$sidebar-ink"),
            make_box(
                f"grp-nav-list-{cid}",
                layout="column",
                w=w - 24,
                gap=8,
                flex=1,
                isGroup=True,
                children=nav_children,
            ),
            make_box(
                f"grp-store-card-{cid}",
                layout="column",
                w=w - 24,
                h=68,
                padding=[12, 12],
                gap=4,
                fill="$sidebar-surface",
                radius=8,
                isGroup=True,
                bgName=f"bg-store-card-{cid}",
                children=[
                    make_label(f"txt-store-status-{cid}", "● 云端同步正常 (RTT 18ms)", size=11, weight=600, color="$success"),
                    make_label(f"txt-store-name-{cid}", store_name, size=12, weight=400, color="$sidebar-ink"),
                ],
            ),
        ],
    )

def expand_topbar(node):
    cid = node.get("id", "main")
    w = int(node.get("w") or 1232)
    h = int(node.get("h") or 64)
    title = node.get("title", "菜品与库存管理中台")
    subtitle = node.get("subtitle", "实时管理门店在售菜品、多规格定价与库存预警")
    badge_txt = node.get("badgeText", "● 实时库存联动已开启")
    if not str(badge_txt).startswith("●"):
        badge_txt = f"● {badge_txt}"
    primary_btn = node.get("primaryButton") or {"name": "btn-new-dish", "label": node.get("primaryText") or node.get("ctaText") or "+ 新建菜品"}
    secondary_btn = node.get("secondaryButton") or {"name": "btn-export-report", "label": node.get("secondaryText") or "导出报表"}
    return make_box(
        f"grp-topbar-{cid}",
        layout="row",
        w=w,
        h=h,
        padding=[12, 24],
        gap=16,
        align="center",
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-topbar-{cid}",
        children=[
            make_box(
                f"grp-topbar-titles-{cid}",
                layout="column",
                gap=4,
                flex=1,
                isGroup=False,
                children=[
                    make_label(f"txt-page-title", title, size=18, weight=700, color="$ink"),
                    make_label(f"txt-page-subtitle", subtitle, size=12, weight=400, color="$ink-3"),
                ],
            ),
            make_button(
                "badge-live-sync",
                badge_txt,
                variant="success-soft",
                w=148,
                h=28,
                size=12,
                radius=999,
            ),
            make_button(
                secondary_btn.get("name", "btn-export-report"),
                secondary_btn.get("label", "导出报表"),
                variant="outline",
                w=96,
                h=36,
                size=13,
                radius=6,
            ),
            make_button(
                primary_btn.get("name", "btn-new-dish"),
                primary_btn.get("label", "+ 新建菜品"),
                variant="primary",
                w=112,
                h=36,
                size=13,
                radius=6,
            ),
        ],
    )

def expand_kpi_card(node):
    cid = node.get("id", "kpi")
    label = node.get("label", "核心指标")
    val = node.get("value", "0")
    trend = node.get("trend", "+12.5%")
    trend_type = node.get("trendType", "success")
    sub = node.get("subtitle", "较昨日同期")
    accent = node.get("accent", "$brand")
    badge_variant = "success-soft" if trend_type == "success" else ("danger-soft" if trend_type == "danger" else "warning-soft")
    return make_box(
        f"grp-kpi-{cid}",
        layout="column",
        w=node.get("w"),
        h=node.get("h", 112),
        flex=node.get("flex", 1),
        padding=[16, 20],
        gap=8,
        fill="$surface",
        stroke="$line",
        radius=8,
        isGroup=True,
        bgName=f"bg-kpi-{cid}",
        children=[
            make_box(
                f"grp-kpi-head-{cid}",
                layout="row",
                align="center",
                gap=8,
                isGroup=False,
                children=[
                    make_box(f"bar-kpi-accent-{cid}", layout="stack", w=4, h=16, fill=accent, radius=4, isGroup=False, bgName=f"dot-kpi-{cid}", children=[]),
                    make_label(f"txt-kpi-{cid}-label", label, size=13, weight=500, color="$ink-2", flex=1),
                    make_button(f"badge-kpi-{cid}-trend", trend, variant=badge_variant, h=22, size=11, radius=999),
                ],
            ),
            make_label(f"txt-kpi-{cid}-val", val, size=24, weight=700, color="$ink"),
            make_label(f"txt-kpi-{cid}-sub", sub, size=12, weight=400, color="$ink-3"),
        ],
    )

def expand_chart_state(state_id, title, subtitle, series_labels, values, unit="单", accent="$brand", mode="bar"):
    """生成单个图表状态页的完整自动布局树（尺寸 744x220，支持柱状趋势/折线趋势/品类占比）。"""
    w = 744
    h = 216
    bars = []
    max_v = max(values) if values else 100
    if mode in ("bar", "line"):
        for idx, (lbl, v) in enumerate(zip(series_labels, values)):
            ratio = max(0.12, min(1.0, float(v) / float(max_v)))
            bar_h = int(round(ratio * 96))
            spacer_h = max(4, 100 - bar_h)
            col_color = accent if idx == len(values) - 1 else ("$accent" if mode == "line" else "$brand")
            bars.append(
                make_box(
                    f"grp-chart-{state_id}-col-{idx+1}",
                    layout="column",
                    flex=1,
                    h=144,
                    align="center",
                    gap=4,
                    isGroup=True,
                    children=[
                        make_box(f"sp-{state_id}-{idx+1}", layout="stack", w=8, h=spacer_h, isGroup=False, children=[]),
                        make_label(f"txt-{state_id}-v-{idx+1}", f"{v}{unit}", size=11, weight=600, color="$ink-2", align="center"),
                        make_box(
                            f"bar-{state_id}-{idx+1}",
                            layout="stack",
                            w=28 if mode == "bar" else 16,
                            h=bar_h,
                            fill=col_color,
                            radius=4,
                            isGroup=False,
                            bgName=f"bar-{state_id}-rect-{idx+1}",
                            children=[],
                        ),
                        make_label(f"txt-{state_id}-x-{idx+1}", lbl, size=11, weight=400, color="$ink-3", align="center"),
                    ],
                )
            )
        body = make_box(
            f"grp-chart-{state_id}-plot",
            layout="row",
            w=w - 32,
            h=148,
            gap=12,
            align="end",
            padding=[4, 8],
            fill="$surface-2",
            radius=8,
            isGroup=True,
            bgName=f"bg-chart-{state_id}-plot",
            children=bars,
        )
    else:
        # 品类占比横向分布条
        rank_rows = []
        palette = ["$brand", "$accent", "$success", "$warning"]
        for idx, (lbl, v) in enumerate(zip(series_labels[:4], values[:4])):
            pct = int(round(float(v)))
            fill_w = max(24, int(round((w - 280) * (pct / 100.0))))
            rank_rows.append(
                make_box(
                    f"grp-cat-row-{idx+1}",
                    layout="row",
                    w=w - 48,
                    h=28,
                    gap=12,
                    align="center",
                    isGroup=True,
                    children=[
                        make_label(f"txt-cat-name-{idx+1}", lbl, size=12, weight=600, color="$ink", w=112),
                        make_box(
                            f"bar-cat-track-{idx+1}",
                            layout="row",
                            w=fill_w,
                            h=12,
                            fill=palette[idx % len(palette)],
                            radius=6,
                            isGroup=False,
                            bgName=f"bar-cat-fill-{idx+1}",
                            children=[],
                        ),
                        make_label(f"txt-cat-pct-{idx+1}", f"{pct}% ({v * 12} 单)", size=12, weight=600, color="$ink-2"),
                    ],
                )
            )
        body = make_box(
            f"grp-chart-{state_id}-ranks",
            layout="column",
            w=w - 32,
            h=148,
            padding=[12, 16],
            gap=8,
            fill="$surface-2",
            radius=8,
            isGroup=True,
            bgName=f"bg-chart-{state_id}-ranks",
            children=rank_rows,
        )
    return make_box(
        f"grp-state-{state_id}",
        layout="column",
        w=w,
        h=h,
        padding=[12, 16],
        gap=8,
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName=f"bg-state-{state_id}",
        children=[
            make_box(
                f"grp-state-head-{state_id}",
                layout="row",
                w=w - 32,
                h=28,
                align="center",
                gap=12,
                isGroup=False,
                children=[
                    make_label(f"txt-state-title-{state_id}", title, size=14, weight=700, color="$ink"),
                    make_label(f"txt-state-sub-{state_id}", subtitle, size=12, weight=400, color="$ink-3", flex=1),
                    make_button(f"badge-state-{state_id}", "实时聚合", variant="soft", w=72, h=22, size=11, radius=999),
                ],
            ),
            body,
        ],
    )

def expand_table_four_states(w=1184, h=336, rows=None):
    """生成表格组件的完整四态视图树: default / empty / loading / error。"""
    if not rows:
        rows = [
            {"code": "D-101", "name": "招牌藤椒烤鱼 (整条)", "cat": "川湘招牌", "price": "¥ 128.00", "stock": "46 份", "sales": "342", "status": "在售中", "statusVariant": "success-soft"},
            {"code": "D-102", "name": "黑松露和牛能量碗", "cat": "主厨轻食", "price": "¥ 68.00", "stock": "18 份", "sales": "219", "status": "在售中", "statusVariant": "success-soft"},
            {"code": "D-103", "name": "手作杨枝甘露冰酪", "cat": "鲜果甜品", "price": "¥ 26.00", "stock": "5 份", "sales": "410", "status": "库存预警", "statusVariant": "warning-soft"},
            {"code": "D-104", "name": "炭烤伊比利亚黑猪颈肉", "cat": "特色烧烤", "price": "¥ 88.00", "stock": "32 份", "sales": "165", "status": "在售中", "statusVariant": "success-soft"},
            {"code": "D-105", "name": "限定桂花酒酿小圆子", "cat": "时令饮品", "price": "¥ 22.00", "stock": "0 份", "sales": "98", "status": "已售罄", "statusVariant": "danger-soft"},
        ]
    col_specs = [
        ("code", "菜品编码", 104),
        ("name", "菜品名称", 268),
        ("cat", "所属分类", 136),
        ("price", "标准售价", 128),
        ("stock", "当前库存", 120),
        ("sales", "今日销量", 112),
        ("status", "状态", 116),
        ("action", "操作", 120),
    ]
    def build_header(prefix):
        return make_box(
            f"grp-{prefix}-thead",
            layout="row",
            w=w - 32,
            h=36,
            padding=[6, 8],
            gap=4,
            align="center",
            fill="$surface-2",
            stroke="$line",
            radius=6,
            isGroup=True,
            bgName=f"bg-{prefix}-thead",
            children=[
                make_label(f"th-{prefix}-{k}", title, size=12, weight=600, color="$ink-2", w=cw)
                for k, title, cw in col_specs
            ],
        )
    # 1. DEFAULT STATE
    row_nodes = [build_header("tbl")]
    for idx, r in enumerate(rows[:5]):
        rid = idx + 1
        row_nodes.append(
            make_box(
                f"grp-tbl-row-{rid}",
                layout="row",
                w=w - 32,
                h=42,
                padding=[6, 8],
                gap=4,
                align="center",
                fill="$surface" if rid % 2 == 1 else "$surface-2",
                stroke="$line",
                radius=6,
                isGroup=True,
                bgName=f"bg-tbl-row-{rid}",
                children=[
                    make_label(f"cell-r{rid}-code", r["code"], size=12, weight=500, color="$ink-3", w=104),
                    make_label(f"cell-r{rid}-name", r["name"], size=13, weight=600, color="$ink", w=268),
                    make_label(f"cell-r{rid}-cat", r["cat"], size=12, weight=400, color="$ink-2", w=136),
                    make_label(f"cell-r{rid}-price", r["price"], size=13, weight=600, color="$ink", w=128),
                    make_label(f"cell-r{rid}-stock", r["stock"], size=12, weight=500, color="$ink-2", w=120),
                    make_label(f"cell-r{rid}-sales", f"{r['sales']} 单", size=12, weight=500, color="$ink-2", w=112),
                    make_button(f"badge-r{rid}-status", r["status"], variant=r["statusVariant"], w=88, h=24, size=11, radius=999),
                    make_box(f"sp-r{rid}-st", layout="stack", w=20, h=12, isGroup=False, children=[]),
                    make_button(f"btn-r{rid}-edit", "编辑 / 调价", variant="soft", w=96, h=26, size=11, radius=6),
                ],
            )
        )
    row_nodes.append(
        make_box(
            "grp-tbl-pagination",
            layout="row",
            w=w - 32,
            h=32,
            padding=[4, 8],
            gap=8,
            align="center",
            isGroup=True,
            children=[
                make_label("txt-tbl-total", "共 58 道在库菜品 · 当前显示第 1–5 条", size=12, weight=400, color="$ink-3", flex=1),
                make_button("btn-page-prev", "上一页", variant="outline", w=68, h=28, size=12, radius=6),
                make_button("btn-page-1", "1", variant="primary", w=32, h=28, size=12, radius=6),
                make_button("btn-page-2", "2", variant="outline", w=32, h=28, size=12, radius=6),
                make_button("btn-page-next", "下一页", variant="outline", w=68, h=28, size=12, radius=6),
            ],
        )
    )
    default_tree = make_box(
        "grp-table-state-default",
        layout="column",
        w=w,
        h=h,
        padding=[8, 16],
        gap=4,
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-default",
        children=row_nodes,
    )
    # 2. EMPTY STATE
    empty_tree = make_box(
        "grp-table-state-empty",
        layout="column",
        w=w,
        h=h,
        padding=[16, 16],
        gap=16,
        align="center",
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-empty",
        children=[
            build_header("empty"),
            make_box(
                "grp-empty-card",
                layout="column",
                w=w - 64,
                h=236,
                padding=[28, 32],
                gap=12,
                align="center",
                fill="$surface-2",
                stroke="$line",
                radius=12,
                isGroup=True,
                bgName="bg-empty-card",
                children=[
                    make_button("icon-empty-box", "○ 暂无匹配数据", variant="soft", w=144, h=36, size=13, radius=999),
                    make_label("txt-empty-title", "未检索到符合当前筛选条件的菜品", size=16, weight=700, color="$ink", align="center"),
                    make_label(
                        "txt-empty-desc",
                        "建议清空关键词或分类过滤条件，或点击右上角「+ 新建菜品」直接录入新菜品",
                        size=13,
                        weight=400,
                        color="$ink-3",
                        align="center",
                    ),
                    make_button("btn-empty-cta", "重置筛选并恢复列表", variant="primary", w=168, h=36, size=13, radius=6),
                ],
            ),
        ],
    )
    # 3. LOADING STATE
    skel_rows = [
        build_header("load"),
        make_box(
            "grp-loading-banner",
            layout="row",
            w=w - 32,
            h=36,
            padding=[6, 16],
            gap=12,
            align="center",
            fill="$accent-soft",
            radius=6,
            isGroup=True,
            bgName="bg-loading-banner",
            children=[
                make_button("badge-loading-spin", "● 同步中", variant="accent", w=80, h=24, size=11, radius=999),
                make_label("txt-loading-msg", "正在从云端菜单中心拉取实时库存与多规格价格数据...", size=12, weight=600, color="$accent", flex=1),
            ],
        ),
    ]
    for sidx in range(1, 5):
        skel_rows.append(
            make_box(
                f"grp-skel-row-{sidx}",
                layout="row",
                w=w - 32,
                h=44,
                padding=[12, 12],
                gap=16,
                align="center",
                fill="$surface",
                stroke="$line",
                radius=6,
                isGroup=True,
                bgName=f"bg-skel-row-{sidx}",
                children=[
                    make_box(f"skel-r{sidx}-c1", layout="stack", w=88, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-1", children=[]),
                    make_box(f"skel-r{sidx}-c2", layout="stack", w=220, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-2", children=[]),
                    make_box(f"skel-r{sidx}-c3", layout="stack", w=112, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-3", children=[]),
                    make_box(f"skel-r{sidx}-c4", layout="stack", w=96, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-4", children=[]),
                    make_box(f"skel-r{sidx}-c5", layout="stack", w=140, h=16, fill="$surface-3", radius=4, isGroup=False, bgName=f"sk-b{sidx}-5", children=[]),
                ],
            )
        )
    loading_tree = make_box(
        "grp-table-state-loading",
        layout="column",
        w=w,
        h=h,
        padding=[12, 16],
        gap=8,
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-loading",
        children=skel_rows,
    )
    # 4. ERROR STATE
    error_tree = make_box(
        "grp-table-state-error",
        layout="column",
        w=w,
        h=h,
        padding=[16, 16],
        gap=16,
        align="center",
        fill="$surface",
        radius=8,
        isGroup=True,
        bgName="bg-table-state-error",
        children=[
            build_header("err"),
            make_box(
                "grp-error-card",
                layout="column",
                w=w - 64,
                h=236,
                padding=[28, 32],
                gap=12,
                align="center",
                fill="$danger-soft",
                stroke="$danger",
                radius=12,
                isGroup=True,
                bgName="bg-error-card",
                children=[
                    make_button("badge-error-code", "! ERR_GATEWAY_504", variant="danger", w=164, h=32, size=12, radius=999),
                    make_label("txt-error-title", "菜品与库存服务响应超时，数据加载失败", size=16, weight=700, color="$danger", align="center"),
                    make_label(
                        "txt-error-detail",
                        "上游节点 dish-inventory-rpc 在 3000ms 内未返回响应 (TraceID: 98a7f2c1) · 请检查网络或点击下方按钮重试",
                        size=13,
                        weight=400,
                        color="$ink-2",
                        align="center",
                    ),
                    make_button("btn-error-retry", "立即重新加载数据", variant="danger", w=168, h=36, size=13, radius=6),
                ],
            ),
        ],
    )
    return {
        "default": default_tree,
        "empty": empty_tree,
        "loading": loading_tree,
        "error": error_tree,
    }

def expand_notice_card(w=424, h=272):
    """右侧实时经营预警与热销榜单卡片。"""
    items = [
        ("alert-1", "库存预警", "手作杨枝甘露冰酪 仅剩 5 份", "warning-soft"),
        ("alert-2", "售罄提醒", "限定桂花酒酿小圆子 已售罄下架", "danger-soft"),
        ("alert-3", "热销飙升", "招牌藤椒烤鱼 今日销量突破 340 单", "success-soft"),
        ("alert-4", "价格同步", "美团/饿了么双渠道价格校验通过", "accent-soft"),
    ]
    rows = []
    for aid, tag, desc, var in items:
        rows.append(
            make_box(
                f"grp-notice-{aid}",
                layout="row",
                w=w - 32,
                h=40,
                padding=[8, 12],
                gap=12,
                align="center",
                fill="$surface-2",
                radius=6,
                isGroup=True,
                bgName=f"bg-notice-{aid}",
                children=[
                    make_button(f"badge-notice-{aid}", tag, variant=var, w=72, h=24, size=11, radius=999),
                    make_label(f"txt-notice-{aid}", desc, size=12, weight=500, color="$ink", flex=1),
                ],
            )
        )
    return make_box(
        "grp-card-notices",
        layout="column",
        w=w,
        h=h,
        padding=[16, 16],
        gap=12,
        fill="$surface",
        stroke="$line",
        radius=8,
        isGroup=True,
        bgName="bg-card-notices",
        children=[
            make_box(
                "grp-notice-head",
                layout="row",
                w=w - 32,
                h=28,
                align="center",
                gap=8,
                isGroup=False,
                children=[
                    make_label("txt-notice-title", "实时库存预警与门店动态", size=15, weight=700, color="$ink", flex=1),
                    make_button("badge-notice-count", "4 条待办", variant="warning-soft", w=68, h=22, size=11, radius=999),
                ],
            ),
            make_box("grp-notice-list", layout="column", w=w - 32, gap=8, isGroup=True, children=rows),
        ],
    )

def expand_modal_new_dish(canvas_w=1440, canvas_h=900):
    """生成居中弹窗层（含半透明遮罩、卡片、原生 TextBox 占位与表单校验提示栏）。"""
    mw, mh = 520, 408
    mx = (canvas_w - mw) // 2
    my = (canvas_h - mh) // 2
    return make_box(
        "grp-modal-new-dish",
        layout="stack",
        x=mx,
        y=my,
        w=mw,
        h=mh,
        isGroup=True,
        isModal=True,
        children=[
            make_box(
                "grp-modal-card",
                layout="column",
                w=mw,
                h=mh,
                padding=[24, 24],
                gap=16,
                fill="$surface",
                stroke="$brand",
                radius=12,
                isGroup=True,
                bgName="modal-card",
                children=[
                    make_box(
                        "grp-modal-header",
                        layout="row",
                        w=mw - 48,
                        h=32,
                        align="center",
                        gap=12,
                        isGroup=False,
                        children=[
                            make_label("txt-modal-title", "新建门店在售菜品", size=18, weight=700, color="$ink", flex=1),
                            make_button("btn-modal-close", "× 关闭", variant="outline", w=68, h=28, size=12, radius=6),
                        ],
                    ),
                    make_label(
                        "txt-modal-subtitle",
                        "请录入菜品名称与标准售价（带 * 号为必填项，提交时触发实时非空校验）",
                        size=12,
                        weight=400,
                        color="$ink-3",
                    ),
                    make_box(
                        "grp-field-dish-name",
                        layout="column",
                        w=mw - 48,
                        gap=8,
                        isGroup=True,
                        children=[
                            make_label("lbl-dish-name", "* 菜品名称 (必填)", size=13, weight=600, color="$ink"),
                            {
                                "type": "native-input",
                                "name": "input-dish-name",
                                "placeholder": "例如：黑松露和牛能量碗",
                                "w": mw - 48,
                                "h": 36,
                                "fill": "$surface-2",
                                "stroke": "$line-strong",
                                "radius": 6,
                            },
                        ],
                    ),
                    make_box(
                        "grp-field-dish-price",
                        layout="column",
                        w=mw - 48,
                        gap=8,
                        isGroup=True,
                        children=[
                            make_label("lbl-dish-price", "* 标准售价 (元 / 必填)", size=13, weight=600, color="$ink"),
                            {
                                "type": "native-input",
                                "name": "input-dish-price",
                                "placeholder": "例如：68.00",
                                "w": mw - 48,
                                "h": 36,
                                "fill": "$surface-2",
                                "stroke": "$line-strong",
                                "radius": 6,
                            },
                        ],
                    ),
                    make_button(
                        "txt-modal-feedback",
                        "请填写上方必填字段后点击「确认保存菜品」",
                        variant="soft",
                        w=mw - 48,
                        h=36,
                        size=12,
                        radius=6,
                    ),
                    make_box(
                        "grp-modal-footer",
                        layout="row",
                        w=mw - 48,
                        h=40,
                        gap=12,
                        justify="end",
                        align="center",
                        isGroup=False,
                        children=[
                            make_button("btn-modal-cancel", "取消", variant="outline", w=96, h=36, size=13, radius=6),
                            make_button("btn-modal-submit", "确认保存菜品", variant="primary", w=136, h=36, size=13, radius=6),
                        ],
                    ),
                ],
            )
        ],
    )
