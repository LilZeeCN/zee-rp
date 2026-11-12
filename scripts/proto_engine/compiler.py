# 从 scripts/proto.py 原样迁移(2026-11-08 RP/1 编译链拆分批次 1;行为不变,勿手改)。
import copy
import json
import math
import os
import re
from rp_language import FONT_SIZE_TOKENS, FONT_WEIGHT_TOKENS, LanguageError, RADIUS_TOKENS, SPACING_TOKENS, compile_language
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
from .fonts import find_unrenderable_glyphs, load_font, measure_text, wrap_text
from .tokens import THEMES, resolve_color, snap_token
from .expander import expand_chart_state, expand_kpi_card, expand_modal_new_dish, expand_notice_card, expand_sidebar, expand_table_four_states, expand_topbar, make_box, make_button, make_label
from .layout import compose_device_shell, emit_tree_to_axvg, is_fill, is_hug, layout_node, measure_node, resolve_size
from .audit import audit_prototype, ensure_unique_names, render_flat_children_png, render_structure_overlay_png, summarize_scene_audits, text_ink_geometry
from .builder import compile_prototype_bundle

# -------------------- 6. DECLARATIVE SPEC COMPILER & MOBILE COMPONENTS --------------------
def expand_mobile_navbar(node, prefix="p1"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 44)
    title = node.get("title", "页面标题")
    title_align = node.get("titleAlign", "center")
    left_text = node.get("leftText")
    left_icon = node.get("leftIcon")
    right_text = node.get("rightText")
    back_name = node.get("backName", f"{prefix}-btn-back")
    right_name = node.get("rightName", f"{prefix}-btn-nav-right")
    children = []
    left_items = []
    if left_icon:
        left_items.append({"type": "image", "name": f"{prefix}-img-nav-back", "src": left_icon, "w": 16, "h": 16})
    if left_text:
        left_items.append(make_label(back_name, left_text, size=12, weight=500, color="$ink"))
    if left_items:
        children.append(make_box(f"grp-{prefix}-nav-left", layout="row", w=84, h=28, gap=4, align="center", isGroup=True, children=left_items))
    elif title_align == "center":
        children.append(make_label(f"{prefix}-nav-left-sp", " ", size=12, weight=400, color="$ink-3", w=76))
    children.append(make_label(f"{prefix}-txt-nav-title", title, size=16, weight=700, color="$ink", align=title_align, flex=1))
    if right_text:
        rw = max(76, min(116, len(str(right_text)) * 12 + 24))
        children.append(make_button(right_name, right_text, variant="outline", w=rw, h=26, size=11, radius=999))
    elif title_align == "center":
        children.append(make_label(f"{prefix}-nav-right-sp", " ", size=12, weight=400, color="$ink-3", w=76))
    return make_box(
        node.get("name", f"grp-{prefix}-navbar"),
        layout="row",
        w=w,
        h=h,
        padding=[8, 12],
        gap=8,
        align="center",
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-{prefix}-navbar",
        children=children,
    )


def expand_mobile_searchbar(node, prefix="p1"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 52)
    placeholder_txt = node.get("placeholder", "搜索物品名称、拾获地点关键词")
    btn_txt = node.get("buttonText", "筛选")
    btn_name = node.get("buttonName", f"{prefix}-btn-search-act")
    inp_name = node.get("inputName", f"{prefix}-txt-search-ph")
    row_children = [
        make_box(
            f"grp-{prefix}-search-input",
            layout="row",
            flex=1,
            h=36,
            padding=[8, 12],
            gap=8,
            align="center",
            fill="$surface-2",
            stroke="$line",
            radius=16,
            isGroup=True,
            bgName=f"bg-{prefix}-search-pill",
            children=[
                {"type": "image", "name": f"{prefix}-img-search", "src": "icon-search.png", "w": 16, "h": 16},
                make_label(inp_name, placeholder_txt, size=12, weight=400, color="$ink-3", flex=1),
            ],
        )
    ]
    if btn_txt:
        bw = max(56, min(88, len(str(btn_txt)) * 12 + 24))
        row_children.append(make_button(btn_name, btn_txt, variant="secondary", w=bw, h=36, size=12, radius=16))
    return make_box(
        node.get("name", f"grp-{prefix}-searchbar"),
        layout="row",
        w=w,
        h=h,
        padding=[8, 16],
        gap=8,
        align="center",
        fill="$surface",
        stroke=node.get("stroke"),
        isGroup=True,
        bgName=f"bg-{prefix}-searchbar",
        children=row_children,
    )


def expand_mobile_segmented(node, prefix="p1"):
    w = int(node.get("w") or 375)
    raw_items = node.get("items") or ["全部 (48)", "寻物启事 (21)", "失物招领 (27)"]
    active_idx = int(node.get("activeIndex", 0))
    cols = int(node.get("columns") or (3 if len(raw_items) > 4 else max(1, len(raw_items))))
    sec_title = node.get("title")
    sec_right = node.get("rightText")

    pills = []
    for i, item in enumerate(raw_items):
        if isinstance(item, dict):
            lbl = item.get("label", f"选项{i+1}")
            nm = item.get("name", f"{prefix}-seg-tab-{i+1}")
            is_act = bool(item.get("active", i == active_idx))
            variant = item.get("variant") or ("primary" if is_act else "outline")
        else:
            lbl = str(item)
            nm = f"{prefix}-seg-tab-{i+1}"
            is_act = i == active_idx
            variant = "primary" if is_act else "outline"
        pills.append(
            make_button(
                nm,
                lbl,
                variant=variant,
                h=int(node.get("pillHeight") or 28),
                size=int(node.get("fontSize") or 12),
                radius=int(node.get("pillRadius") or 16),
                flex=1,
            )
        )

    if len(pills) <= cols and not sec_title:
        return make_box(
            node.get("name", f"grp-{prefix}-segmented"),
            layout="row",
            w=w,
            h=int(node.get("h") or 40),
            padding=[6, 16],
            gap=8,
            align="center",
            fill="$surface",
            stroke="$line",
            isGroup=True,
            bgName=f"bg-{prefix}-segmented",
            children=pills,
        )

    rows = [pills[i:i + cols] for i in range(0, len(pills), cols)]
    col_children = []
    if sec_title:
        hdr_items = [make_label(f"{prefix}-seg-title", sec_title, size=12, weight=600, color="$ink", flex=1)]
        if sec_right:
            hdr_items.append(make_label(f"{prefix}-seg-right", sec_right, size=11, weight=400, color="$ink-3"))
        col_children.append(make_box(f"grp-{prefix}-seg-hdr", layout="row", w=w - 32, h=18, align="center", isGroup=True, children=hdr_items))
    for r_idx, r_pills in enumerate(rows):
        col_children.append(
            make_box(
                f"grp-{prefix}-seg-row-{r_idx+1}",
                layout="row",
                w=w - 32,
                h=int(node.get("pillHeight") or 28),
                gap=8,
                align="center",
                isGroup=True,
                children=r_pills,
            )
        )
    auto_h = 16 + (26 if sec_title else 0) + len(rows) * int(node.get("pillHeight") or 28) + max(0, len(rows) - 1) * 8
    return make_box(
        node.get("name", f"grp-{prefix}-segmented"),
        layout="column",
        w=w,
        h=int(node.get("h") or auto_h),
        padding=[8, 16],
        gap=8,
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-{prefix}-segmented",
        children=col_children,
    )


def expand_mobile_card_list(node, prefix="p1"):
    w = int(node.get("w") or 375)
    cards_data = node.get("cards") or [
        {
            "id": "c1",
            "badge": "失物招领",
            "title": "黑色索尼头戴降噪耳机",
            "loc": "图书馆三楼自习区 A12 桌",
            "time": "10分钟前 · 计院拾获",
            "thumb": "实物图",
            "detail": {
                "badge": "失物招领",
                "itemTitle": "黑色索尼头戴降噪耳机",
                "statusText": "状态：待认领 · 编号 LF-20261017-019",
                "pubTime": "发布时间：10分钟前 · 计院拾获 · 浏览 86 次",
                "category": "物品分类：数码电子 / 音频配件",
                "location": "拾获地点：图书馆三楼自习区 A12 桌",
                "holder": "当前保管：三楼自助失物招领柜 08 号格口",
                "description": "特征说明：耳机收纳盒完好，拉链处挂有一枚蓝色宇航员硅胶挂件，认领时请说明盒内附带的转接头颜色。",
            },
        },
        {
            "id": "c2",
            "badge": "寻物启事",
            "title": "白色 Apple Pencil 二代",
            "loc": "二教 204 阶梯教室第三排",
            "time": "35分钟前 · 悬赏咖啡",
            "thumb": "实物图",
            "detail": {
                "badge": "寻物启事",
                "itemTitle": "白色 Apple Pencil 二代",
                "statusText": "状态：寻找中 · 编号 LF-20261017-020",
                "pubTime": "发布时间：35分钟前 · 悬赏咖啡 · 浏览 64 次",
                "category": "物品分类：数码电子 / 手写笔配件",
                "location": "遗失地点：二教 204 阶梯教室第三排",
                "holder": "联系失主：微信号 campus_pen204（重谢一杯星巴克）",
                "description": "特征说明：笔身贴有浅灰色磨砂保护膜，笔尖换过金属改造笔头，吸在平板侧面不慎滑落。",
            },
        },
        {
            "id": "c3",
            "badge": "失物招领",
            "title": "校园一卡通及蓝色卡套",
            "loc": "南区一食堂二楼窗口旁",
            "time": "1小时前 · 值班台保管",
            "thumb": "证件照",
            "detail": {
                "badge": "失物招领",
                "itemTitle": "校园一卡通及蓝色卡套",
                "statusText": "状态：待认领 · 编号 LF-20261017-021",
                "pubTime": "发布时间：1小时前 · 值班台保管 · 浏览 112 次",
                "category": "物品分类：校园卡证 / 一卡通",
                "location": "拾获地点：南区一食堂二楼窗口旁",
                "holder": "当前保管：南区一食堂一楼值班室登记处",
                "description": "特征说明：深蓝色硅胶卡套，背面夹有一张图书馆储物柜条码纸，请携带学生证或报出学号后四位认领。",
            },
        },
        {
            "id": "c4",
            "badge": "寻物启事",
            "title": "银色键盘收纳包与 U 盘",
            "loc": "体育馆羽毛球场北侧长椅",
            "time": "2小时前 · 急寻毕设稿",
            "thumb": "实物图",
            "detail": {
                "badge": "寻物启事",
                "itemTitle": "银色键盘收纳包与 U 盘",
                "statusText": "状态：急寻中 · 编号 LF-20261017-022",
                "pubTime": "发布时间：2小时前 · 急寻毕设稿 · 浏览 195 次",
                "category": "物品分类：数码电子 / 存储与外设",
                "location": "遗失地点：体育馆羽毛球场北侧长椅",
                "holder": "联系失主：手机号 139****8821（内含重要毕设源码）",
                "description": "特征说明：银灰色硬壳键盘包内含一把 68 键矮轴键盘与一枚闪迪 128G 金属双接口 U 盘，拾获必有重谢。",
            },
        },
    ]
    list_children = []
    hdr_title = node.get("headerTitle")
    hdr_right = node.get("headerRight")
    if hdr_title:
        hdr_row = [make_label(f"{prefix}-list-hdr-title", hdr_title, size=13, weight=700, color="$ink", flex=1)]
        if hdr_right:
            hdr_row.append(make_label(f"{prefix}-list-hdr-right", hdr_right, size=11, weight=400, color="$ink-3"))
        list_children.append(make_box(f"grp-{prefix}-list-hdr", layout="row", w=w - 32, h=20, align="center", isGroup=True, children=hdr_row))

    card_h = int(node.get("cardHeight") or (104 if hdr_title else 112))
    for idx, c in enumerate(cards_data):
        cid = c.get("id", f"c{idx+1}")
        cw = w - 32
        loc_raw = str(c.get("loc", ""))
        loc_txt = loc_raw if ("：" in loc_raw or ":" in loc_raw) else f"地点：{loc_raw}"
        time_raw = str(c.get("time", ""))
        pub_raw = str(c.get("publisher", "")).strip()
        if pub_raw and pub_raw not in time_raw:
            time_txt = f"{time_raw} · {pub_raw}" if time_raw else pub_raw
        else:
            time_txt = time_raw
        badge_txt = c.get("badge", "招领")
        badge_var = c.get("badgeVariant") or "secondary"
        badge_w = max(56, min(72, len(str(badge_txt)) * 10 + 12))
        pad_y = 8 if card_h < 104 else (10 if card_h < 110 else 12)
        thumb_sz = 64 if card_h < 104 else (68 if card_h < 110 else 76)
        title_str = str(c.get("title", ""))
        avail_title_w = cw - 24 - thumb_sz - 12 - badge_w - 6
        title_sz = 13
        for cand_sz in (13, 12, 11, 10):
            title_sz = cand_sz
            if (
                measure_text(title_str, cand_sz, 600)[0] <= avail_title_w
                and len(wrap_text(title_str, max(1, avail_title_w - 4), cand_sz, 600)) <= 1
            ):
                break
        body_h = card_h - pad_y * 2
        body_gap = 4 if card_h < 104 else 6
        foot_btn_h = 20 if card_h < 104 else 22
        btn_txt = c.get("buttonText", "查看详情 >")
        btn_nm = c.get("buttonName", f"{prefix}-btn-detail-{cid}")
        list_children.append(
            make_box(
                c.get("name", f"grp-{prefix}-card-{cid}"),
                layout="row",
                w=cw,
                h=card_h,
                padding=[pad_y, 12],
                gap=12,
                align="center",
                fill="$surface",
                stroke="$line",
                radius=10,
                isGroup=True,
                bgName=f"bg-{prefix}-card-{cid}",
                children=[
                    {
                        "type": "placeholder",
                        "name": f"{prefix}-ph-{cid}",
                        "w": thumb_sz,
                        "h": thumb_sz,
                        "caption": c.get("thumb", "缩略图"),
                    },
                    make_box(
                        f"grp-{prefix}-card-body-{cid}",
                        layout="column",
                        flex=1,
                        h=body_h,
                        gap=body_gap,
                        isGroup=True,
                        children=[
                            make_box(
                                f"grp-{prefix}-card-head-{cid}",
                                layout="row",
                                gap=6,
                                align="center",
                                isGroup=True,
                                children=[
                                    make_button(f"{prefix}-badge-{cid}", badge_txt, variant=badge_var, w=badge_w, h=20, size=10, radius=4),
                                    make_label(f"{prefix}-title-{cid}", title_str, size=title_sz, weight=600, color="$ink", flex=1),
                                ],
                            ),
                            make_label(f"{prefix}-loc-{cid}", loc_txt, size=11, weight=400, color="$ink-2"),
                            make_box(
                                f"grp-{prefix}-card-foot-{cid}",
                                layout="row",
                                align="center",
                                gap=6,
                                isGroup=True,
                                children=[
                                    make_label(f"{prefix}-time-{cid}", time_txt, size=11, weight=400, color="$ink-3", flex=1),
                                    make_button(btn_nm, btn_txt, variant="outline", w=76, h=foot_btn_h, size=11, radius=12),
                                ],
                            ),
                        ],
                    ),
                ],
            )
        )
    return make_box(
        node.get("name", f"grp-{prefix}-card-list"),
        layout="column",
        w=w,
        h=int(node.get("h") or 548),
        padding=[10 if hdr_title else 12, 16],
        gap=8 if hdr_title else 12,
        fill="$bg",
        isGroup=True,
        bgName=f"bg-{prefix}-list-area",
        children=list_children,
    )


def expand_mobile_tabbar(node, prefix="p1"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 84)
    raw_items = node.get("items")
    center_act = node.get("centerAction")
    if not raw_items:
        return make_box(
            node.get("name", f"grp-{prefix}-tabbar"),
            layout="row",
            w=w,
            h=h,
            padding=[8, 16],
            gap=12,
            align="start",
            fill="$surface",
            stroke="$line",
            isGroup=True,
            bgName=f"bg-{prefix}-tabbar",
            children=[
                make_button(f"{prefix}-tab-home", "招领广场", variant="primary", flex=1, h=40, size=12, radius=8),
                make_button(
                    (center_act or {}).get("name", f"{prefix}-btn-publish-plus"),
                    (center_act or {}).get("label", "+ 发布寻物/招领"),
                    variant="secondary",
                    w=132,
                    h=40,
                    size=12,
                    radius=20,
                ),
                make_button(f"{prefix}-tab-mine", "我的记录", variant="outline", flex=1, h=40, size=12, radius=8),
            ],
        )

    items_list = list(raw_items)
    if center_act and isinstance(center_act, dict):
        mid = len(items_list) // 2
        items_list.insert(mid, {**center_act, "prominent": True})

    btn_nodes = []
    many_tabs = len(items_list) >= 4
    active_idx = int(node.get("activeIndex", 0))
    for i, it in enumerate(items_list):
        if isinstance(it, dict):
            lbl = it.get("label", f"Tab{i+1}")
            nm = it.get("name", f"{prefix}-tab-{i+1}")
            is_prom = bool(it.get("prominent"))
            is_act = bool(it.get("active", i == active_idx and not is_prom))
            variant = it.get("variant") or ("secondary" if is_prom else ("primary" if is_act else "outline"))
            rad = int(it.get("radius") or (18 if is_prom else 8))
            bw = it.get("w")
        else:
            lbl = str(it)
            nm = f"{prefix}-tab-{i+1}"
            is_prom = False
            is_act = i == active_idx
            variant = "primary" if is_act else "outline"
            rad = 8
            bw = None
        btn_nodes.append(
            make_button(
                nm,
                lbl,
                variant=variant,
                w=int(bw) if bw else None,
                flex=None if bw else 1,
                h=int(node.get("buttonHeight") or (38 if many_tabs else 40)),
                size=int(node.get("fontSize") or (11 if many_tabs else 12)),
                radius=rad,
            )
        )
    return make_box(
        node.get("name", f"grp-{prefix}-tabbar"),
        layout="row",
        w=w,
        h=h,
        padding=[8, 12 if many_tabs else 16],
        gap=6 if many_tabs else 12,
        align="start",
        fill="$surface",
        stroke="$line",
        isGroup=True,
        bgName=f"bg-{prefix}-tabbar",
        children=btn_nodes,
    )


def expand_mobile_detail_view(node, prefix="view"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 812)
    data = dict(node.get("data") or node.get("fields") or {})
    for k in (
        "badge", "badgeVariant", "itemTitle", "statusText", "metaText", "pubTime",
        "sectionTitle", "category", "location", "holder", "contact", "description",
        "heroCaption", "shareText", "claimText", "extraRows",
    ):
        if k in node and k not in data:
            data[k] = node[k]

    badge_txt = data.get("badge", "失物招领")
    badge_var = data.get("badgeVariant", "primary")
    badge_w = max(68, min(96, len(str(badge_txt)) * 11 + 16))
    item_title = data.get("itemTitle", "黑色索尼头戴降噪耳机")
    meta_txt = data.get("statusText") or data.get("metaText") or "状态：待认领 · 编号 LF-20261017-019"
    pub_txt = data.get("pubTime", "发布时间：10分钟前 · 计院拾获 · 浏览 86 次")
    sec_title = data.get("sectionTitle", "关键拾获与核验信息")

    cat_raw = str(data.get("category", "物品分类：数码电子 / 音频配件"))
    cat_txt = cat_raw if ("：" in cat_raw or ":" in cat_raw) else f"物品分类：{cat_raw}"
    loc_raw = str(data.get("location", "拾获地点：图书馆三楼自习区 A12 桌"))
    loc_txt = loc_raw if ("：" in loc_raw or ":" in loc_raw) else f"拾获/遗失地点：{loc_raw}"
    holder_raw = str(data.get("holder", "当前保管：三楼自助失物招领柜 08 号格口"))
    holder_txt = holder_raw if ("：" in holder_raw or ":" in holder_raw) else f"当前保管：{holder_raw}"
    contact_raw = data.get("contact")
    desc_txt = data.get("description", "特征说明：耳机收纳盒完好，拉链处挂有一枚蓝色宇航员硅胶挂件，认领时请说明盒内附带的转接头颜色。")
    if not str(desc_txt).startswith(("特征说明", "详细描述", "备注")):
        desc_txt = f"特征说明：{desc_txt}"

    attr_children = [
        make_label(f"{prefix}-sec-attrs", sec_title, size=13, weight=700, color="$ink"),
        make_label(f"{prefix}-attr-cat", cat_txt, size=12, weight=400, color="$ink-2"),
        make_label(f"{prefix}-attr-loc", loc_txt, size=12, weight=400, color="$ink-2"),
        make_label(f"{prefix}-attr-holder", holder_txt, size=12, weight=400, color="$ink-2"),
    ]
    if contact_raw:
        c_str = str(contact_raw)
        c_txt = c_str if ("：" in c_str or ":" in c_str) else f"联系方式：{c_str}"
        attr_children.append(make_label(f"{prefix}-attr-contact", c_txt, size=12, weight=400, color="$ink-2"))
    for r_idx, r_item in enumerate(data.get("extraRows") or []):
        if isinstance(r_item, dict):
            attr_children.append(make_label(r_item.get("name", f"{prefix}-attr-extra-{r_idx+1}"), r_item.get("text", ""), size=12, weight=400, color="$ink-2"))
        else:
            attr_children.append(make_label(f"{prefix}-attr-extra-{r_idx+1}", str(r_item), size=12, weight=400, color="$ink-2"))
    attr_children.append({
        "type": "paragraph",
        "name": f"{prefix}-desc-para",
        "w": w - 60,
        "fontSize": 12,
        "fontWeight": 400,
        "color": "$ink-2",
        "text": desc_txt,
    })

    extra_cnt = len(attr_children) - 5
    hero_h = int(data.get("heroH") or (164 if extra_cnt > 0 else 180))
    attrs_h = int(data.get("attrsH") or (204 + extra_cnt * 22))
    hero_cap = data.get("heroCaption") or f"物品实拍大图占位 ({w - 32}×{hero_h})"
    share_txt = data.get("shareText", "转发线索")
    claim_txt = data.get("claimText", "立即申请认领 / 联系拾主")

    return make_box(
        node.get("name", f"grp-{prefix}-screen"),
        layout="column",
        w=w,
        h=h,
        padding=[44, 0, 0, 0],
        gap=0,
        fill="$bg",
        isGroup=True,
        bgName=f"bg-{prefix}-screen",
        children=[
            expand_mobile_navbar({
                "name": f"grp-{prefix}-navbar",
                "w": w,
                "h": 44,
                "title": node.get("title", "物品信息详情"),
                "leftIcon": node.get("leftIcon", "icon-back.png"),
                "leftText": node.get("leftText", "返回广场"),
                "backName": node.get("backName", f"{prefix}-btn-back"),
                "rightText": node.get("rightText", "去发布"),
                "rightName": node.get("rightName", f"{prefix}-btn-to-publish"),
            }, prefix=prefix),
            make_box(
                f"grp-{prefix}-body",
                layout="column",
                w=w,
                h=h - 88,
                padding=[12, 16],
                gap=12,
                fill="$bg",
                isGroup=True,
                children=[
                    {"type": "placeholder", "name": f"{prefix}-ph-hero", "w": w - 32, "h": hero_h, "caption": hero_cap},
                    make_box(
                        f"grp-{prefix}-summary-card",
                        layout="column",
                        w=w - 32,
                        h=112,
                        padding=[12, 14],
                        gap=8,
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-summary",
                        children=[
                            make_box(
                                f"grp-{prefix}-title-row",
                                layout="row",
                                gap=8,
                                align="center",
                                isGroup=True,
                                children=[
                                    make_button(f"{prefix}-badge-type", badge_txt, variant=badge_var, w=badge_w, h=22, size=11, radius=4),
                                    make_label(f"{prefix}-item-title", item_title, size=14, weight=700, color="$ink", flex=1),
                                ],
                            ),
                            make_label(f"{prefix}-item-meta", meta_txt, size=12, weight=500, color="$ink-2"),
                            make_label(f"{prefix}-item-pubtime", pub_txt, size=11, weight=400, color="$ink-3"),
                        ],
                    ),
                    make_box(
                        f"grp-{prefix}-attrs-card",
                        layout="column",
                        w=w - 32,
                        h=attrs_h,
                        padding=[12, 14],
                        gap=8 if extra_cnt > 0 else 10,
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-attrs",
                        children=attr_children,
                    ),
                    make_box(
                        f"grp-{prefix}-actions",
                        layout="row",
                        w=w - 32,
                        h=52,
                        padding=[6, 0],
                        gap=12,
                        align="center",
                        isGroup=True,
                        children=[
                            make_button(f"{prefix}-btn-share", share_txt, variant="outline", w=108, h=40, size=13, radius=8),
                            make_button(f"{prefix}-btn-claim", claim_txt, variant="primary", flex=1, h=40, size=13, radius=8),
                        ],
                    ),
                ],
            ),
        ],
    )


def expand_mobile_form_view(node, prefix="pub"):
    w = int(node.get("w") or 375)
    h = int(node.get("h") or 812)
    type_label = node.get("typeLabel", "信息类型")
    raw_type_opts = node.get("typeOptions") or [
        {"name": f"{prefix}-opt-found", "label": "拾物招领", "active": True},
        {"name": f"{prefix}-opt-lost", "label": "寻物启事", "active": False},
    ]
    type_children = [make_label(f"{prefix}-lbl-type", type_label, size=13, weight=600, color="$ink", w=72)]
    for i, opt in enumerate(raw_type_opts):
        if isinstance(opt, dict):
            onm = opt.get("name", f"{prefix}-opt-type-{i+1}")
            olbl = opt.get("label", f"类型{i+1}")
            oact = bool(opt.get("active", i == 0))
        else:
            onm = f"{prefix}-opt-type-{i+1}"
            olbl = str(opt)
            oact = i == 0
        type_children.append(make_button(onm, olbl, variant="primary" if oact else "outline", flex=1, h=30, size=12, radius=6))

    custom_fields = node.get("fields")
    if not custom_fields:
        field_children = [
            make_label(f"{prefix}-lbl-name", "* 物品名称 (必填)", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-name", "请输入物品名称，如：黑色索尼头戴耳机", variant="secondary", w=w - 60, h=36, size=12, radius=6, align="left"),
            make_label(f"{prefix}-lbl-cat", "* 所属分类与拾获/遗失地点", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-loc", "数码电子 · 图书馆三楼自习区", variant="secondary", w=w - 60, h=36, size=12, radius=6, align="left"),
            make_label(f"{prefix}-lbl-desc", "特征描述与认领核验问题", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-desc", "请描述外观特征、挂件或盒内附件，便于失主核对", variant="secondary", w=w - 60, h=64, size=12, radius=6, align="left"),
            make_label(f"{prefix}-lbl-contact", "* 联系方式 / 招领柜格口", size=12, weight=600, color="$ink"),
            make_button(f"{prefix}-inp-contact", "微信号 / 手机号 / 自助柜编号", variant="secondary", w=w - 60, h=36, size=12, radius=6, align="left"),
        ]
        upload_h = int(node.get("uploadH") or 116)
        fields_h = int(node.get("fieldsH") or 332)
        field_gap = 10
    else:
        field_children = []
        many_f = len(custom_fields) >= 5
        field_gap = 6 if many_f else 8
        for idx, f in enumerate(custom_fields):
            fid = f.get("id") or f.get("name") or f"f{idx+1}"
            lbl_nm = f.get("labelName") or f"{prefix}-lbl-{fid}"
            inp_nm = f.get("inputName") or (fid if str(fid).startswith(prefix) else f"{prefix}-inp-{fid}")
            req_prefix = "* " if f.get("required") and not str(f.get("label", "")).startswith("*") else ""
            lbl_txt = f"{req_prefix}{f.get('label', fid)}"
            field_children.append(make_label(lbl_nm, lbl_txt, size=11 if many_f else 12, weight=600, color="$ink"))
            ftype = f.get("type", "input")
            if ftype == "pills" and f.get("options"):
                opts = f.get("options")
                cols = int(f.get("columns") or min(3, len(opts)))
                for r_idx in range(0, len(opts), cols):
                    chunk = opts[r_idx:r_idx + cols]
                    p_btns = []
                    for c_idx, opt in enumerate(chunk):
                        g_idx = r_idx + c_idx
                        o_lbl = opt.get("label", str(opt)) if isinstance(opt, dict) else str(opt)
                        o_act = opt.get("active", g_idx == 0) if isinstance(opt, dict) else (g_idx == 0)
                        p_btns.append(make_button(f"{inp_nm}-{g_idx+1}", o_lbl, variant="primary" if o_act else "outline", flex=1, h=24, size=10, radius=6))
                    field_children.append(make_box(f"grp-{inp_nm}-row-{r_idx//cols+1}", layout="row", w=w - 60, h=24, gap=6, align="center", isGroup=True, children=p_btns))
            else:
                fh = int(f.get("h") or (48 if ftype == "textarea" else (30 if many_f else 36)))
                ph = f.get("placeholder", f"请输入{f.get('label', '')}")
                field_children.append(make_button(inp_nm, ph, variant="secondary", w=w - 60, h=fh, size=11 if many_f else 12, radius=6, align="left"))
        upload_h = int(node.get("uploadH") or (84 if many_f else 108))
        fields_h = int(node.get("fieldsH") or (380 if many_f else 340))

    upload_cap = node.get("uploadCaption", "+ 点击上传物品实拍照片 (最多 3 张)")
    draft_txt = node.get("draftText", "存草稿")
    submit_txt = node.get("submitText", "确认发布并回招领广场")

    return make_box(
        node.get("name", f"grp-{prefix}-screen"),
        layout="column",
        w=w,
        h=h,
        padding=[44, 0, 0, 0],
        gap=0,
        fill="$bg",
        isGroup=True,
        bgName=f"bg-{prefix}-screen",
        children=[
            expand_mobile_navbar({
                "name": f"grp-{prefix}-navbar",
                "w": w,
                "h": 44,
                "title": node.get("title", "发布寻物 / 招领信息"),
                "leftIcon": node.get("leftIcon", "icon-back.png"),
                "leftText": node.get("leftText", "返回详情"),
                "backName": node.get("backName", f"{prefix}-btn-back"),
                "rightText": node.get("rightText", "查看态"),
                "rightName": node.get("rightName", f"{prefix}-btn-to-view"),
            }, prefix=prefix),
            make_box(
                f"grp-{prefix}-body",
                layout="column",
                w=w,
                h=h - 88,
                padding=[10 if custom_fields else 12, 16],
                gap=8 if custom_fields else 12,
                fill="$bg",
                isGroup=True,
                children=[
                    make_box(
                        f"grp-{prefix}-type-card",
                        layout="row",
                        w=w - 32,
                        h=44 if custom_fields else 48,
                        padding=[6 if custom_fields else 8, 12],
                        gap=8,
                        align="center",
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-type-card",
                        children=type_children,
                    ),
                    {"type": "placeholder", "name": f"{prefix}-ph-upload", "w": w - 32, "h": upload_h, "caption": upload_cap},
                    make_box(
                        f"grp-{prefix}-fields-card",
                        layout="column",
                        w=w - 32,
                        h=fields_h,
                        padding=[10 if custom_fields else 12, 14],
                        gap=field_gap,
                        fill="$surface",
                        stroke="$line",
                        radius=10,
                        isGroup=True,
                        bgName=f"bg-{prefix}-fields-card",
                        children=field_children,
                    ),
                    make_box(
                        f"grp-{prefix}-submit-row",
                        layout="row",
                        w=w - 32,
                        h=48 if custom_fields else 52,
                        padding=[4 if custom_fields else 6, 0],
                        gap=12,
                        align="center",
                        isGroup=True,
                        children=[
                            make_button(f"{prefix}-btn-draft", draft_txt, variant="outline", w=96, h=40, size=13, radius=8),
                            make_button(f"{prefix}-btn-submit", submit_txt, variant="primary", flex=1, h=40, size=13, radius=8),
                        ],
                    ),
                ],
            ),
        ],
    )


KNOWN_NODE_TYPES = {
    "box",
    "label",
    "paragraph",
    "button",
    "shape-text",
    "placeholder",
    "image",
    "icon",
    "sparkline",
    "input",
    "native-input",
    "native-form",
    "radio", "checkbox", "combobox", "listbox",
    "divider",
    "badge",
    "card",
    "dynamic-panel",
    "repeater",
    "mobile-navbar",
    "mobile-searchbar",
    "mobile-segmented",
    "mobile-card-list",
    "mobile-tabbar",
    "mobile-detail-view",
    "mobile-form-view",
    "sidebar",
    "topbar",
    "kpi-card",
}

KNOWN_NODE_PROPS = {
    "type", "name", "prefix", "x", "y", "w", "h", "flex", "layout", "padding", "gap", "rotation",
    "columnGap", "rowGap", "align", "justify", "equalHeight", "fill", "stroke", "color",
    "radius", "isGroup", "bgName", "isModal", "children", "text", "content", "fontSize",
    "size", "fontWeight", "weight", "lineHeight", "lineGap", "maxLines", "variant",
    "placeholder", "value", "native", "textPaddingX", "caption", "src", "image", "file",
    "states", "root", "tree", "title", "titleAlign", "subtitle", "leftIcon", "leftText",
    "backName", "rightText", "rightName", "buttonText", "headerTitle", "headerRight",
    "emptyHint", "shareText", "claimText", "items", "activeIndex", "cards", "cardHeight",
    "bindDetail", "tabs", "data", "typeLabel", "typeOptions", "fields", "uploadH",
    "fieldsH", "uploadCaption", "draftText", "submitText", "brand", "brandTitle",
    "brandSubtitle", "brandSub", "storeName", "navItems", "activeNav", "breadcrumbs",
    "userText", "ctaText", "badgeText", "primaryText", "secondaryText", "primaryButton",
    "secondaryButton", "label", "delta", "trend", "trendType", "accent", "id", "options",
    "columns", "required", "labelName", "inputName", "buttonName", "badge", "loc", "time",
    "detail", "device", "canvas", "pillHeight", "pillRadius", "buttonHeight", "prominent",
    "template", "rows", "model", "pageSize", "rowHeight",
    "opacity", "strokeWidth", "borderSides", "borderTop", "borderBottom", "borderLeft", "borderRight",
    "backdropBlur", "innerGlow", "noise", "gradient", "shadow", "aurora",
    "wrap", "colSpan", "rowSpan", "right", "bottom", "anchor", "z", "after", "afterGap", "alignX", "pin", "pinGap",
    "spans", "italic", "underline", "strikethrough", "letterSpacing",
    "icon", "points", "smooth", "direction", "visible", "hidden", "adaptive",
    "styles", "selected", "disabled", "selectionGroup", "checked", "group", "selectedIndex", "selectedIndices", "multiple", "kind",
    "centerAction", "_expanded", "_mw", "_mh", "_x", "_y", "_w", "_h",
}


def validate_node_schema(node, warnings_out=None, path="root", allow_fallback=False):
    """静态校验声明式节点树：拒绝未知组件 type，并对拼写错误的未知属性名给出近似建议告警。"""
    import difflib
    if not isinstance(node, dict):
        return
    ntype = node.get("type", "box")
    nm = node.get("name", path)
    if ntype not in KNOWN_NODE_TYPES:
        hints = difflib.get_close_matches(str(ntype), sorted(KNOWN_NODE_TYPES), n=2, cutoff=0.45)
        hint_str = f" Did you mean: {', '.join(hints)}?" if hints else f" Supported types: {', '.join(sorted(KNOWN_NODE_TYPES))}"
        raise ValueError(f"[ERR_UNKNOWN_NODE_TYPE] Unknown component type '{ntype}' at '{nm}' ({path}).{hint_str}")
    if warnings_out is not None:
        for k in node.keys():
            if k not in KNOWN_NODE_PROPS and not str(k).startswith("_"):
                hints = difflib.get_close_matches(str(k), sorted(KNOWN_NODE_PROPS), n=2, cutoff=0.5)
                sug = f" (did you mean '{hints[0]}'?)" if hints else ""
                warnings_out.append(f"[WARN_UNKNOWN_PROP] Unknown property '{k}' on {ntype} '{nm}'{sug}")
        for txt_key in ("text", "content", "title", "caption", "placeholder"):
            val = node.get(txt_key)
            if isinstance(val, str) and val:
                bad_g = find_unrenderable_glyphs(val, allow_fallback=allow_fallback)
                if bad_g:
                    warnings_out.append(
                        f"[WARN_ZERO_INK_GLYPH] Unrenderable zero-ink glyph(s) {bad_g} in {nm}.{txt_key}"
                    )
    for idx, ch in enumerate(node.get("children") or []):
        validate_node_schema(ch, warnings_out, f"{path}.children[{idx}]", allow_fallback=allow_fallback)
    for idx, st in enumerate(node.get("states") or []):
        if isinstance(st, dict):
            sub_root = st.get("root") or st.get("tree")
            if isinstance(sub_root, dict):
                validate_node_schema(sub_root, warnings_out, f"{path}.states[{idx}]", allow_fallback=allow_fallback)
            elif isinstance(st.get("children"), list):
                for c_idx, sch in enumerate(st["children"]):
                    validate_node_schema(sch, warnings_out, f"{path}.states[{idx}].children[{c_idx}]", allow_fallback=allow_fallback)


def _preserve_when_attrs(src, dst):
    if isinstance(src, dict) and isinstance(dst, dict):
        for k in ("_when_group", "_when_branch", "_when_default_visible", "_row_visibles", "visible", "hidden", "styles", "selected", "disabled", "selectionGroup"):
            if k in src and k not in dst:
                dst[k] = src[k]
        for coord_k in ("x", "y", "w", "h"):
            if coord_k in src and isinstance(src[coord_k], (int, float)):
                dst.setdefault(f"_declared_{coord_k}", src[coord_k])
    return dst


def expand_declarative_tree(node, prefix="p1"):
    """包装：核心展开后再补回布局约束键（after/afterGap/alignX/z），并把 pin 翻译成贴边坐标。"""
    if (isinstance(node, dict) and node.get("type", "box") in ("box", "card")
            and node.get("align") == "center" and node.get("justify") == "center"
            and node.get("layout", "column") in ("column", "row")
            and len(node.get("children") or []) == 1):
        child = node["children"][0]
        if isinstance(child, dict) and child.get("type") == "label" and "align" not in child:
            node = {**node, "children": [{**child, "align": "center"}]}
    out = _expand_declarative_tree_core(node, prefix)
    if isinstance(out, dict) and isinstance(node, dict):
        for key in ("after", "afterGap", "alignX", "z", "adaptive", "_master_instance", "_master_slot"):
            if node.get(key) is not None and key not in out:
                out[key] = node[key]
        pin = node.get("pin")
        if isinstance(pin, str):
            gap = node.get("pinGap", 0) or 0
            side = pin.strip().lower()
            if side == "right" and "right" not in out:
                out["right"] = gap
            elif side == "bottom" and "bottom" not in out:
                out["bottom"] = gap
            elif side == "left" and "x" not in out:
                out["x"] = gap
            elif side == "top" and "y" not in out:
                out["y"] = gap
    return out


def _expand_declarative_tree_core(node, prefix="p1"):
    """将声明式 JSON 组件节点递归展开为标准自动布局节点树（零静默丢弃）。"""
    import difflib
    if not isinstance(node, dict):
        return node
    ntype = node.get("type", "box")
    pfx = node.get("prefix", prefix)
    if ntype not in KNOWN_NODE_TYPES:
        hints = difflib.get_close_matches(str(ntype), sorted(KNOWN_NODE_TYPES), n=2, cutoff=0.45)
        hint_str = f" Did you mean: {', '.join(hints)}?" if hints else ""
        raise ValueError(f"[ERR_UNKNOWN_NODE_TYPE] Unknown component type '{ntype}' at node '{node.get('name', '<unnamed>')}'.{hint_str}")
    if ntype == "label":
        out_lbl = dict(node)
        out_lbl["name"] = node.get("name", f"{pfx}-label")
        out_lbl["text"] = str(node.get("text", node.get("content", "")))
        out_lbl["fontSize"] = snap_token(node.get("fontSize", node.get("size", 14)), FONT_SIZE_TOKENS)
        out_lbl["fontWeight"] = snap_token(node.get("fontWeight", node.get("weight", 400)), FONT_WEIGHT_TOKENS)
        out_lbl["color"] = node.get("color", "$ink")
        out_lbl["align"] = node.get("align", "left")
        return _preserve_when_attrs(node, out_lbl)
    if ntype in ("button", "badge"):
        is_badge = ntype == "badge"
        btn_text = node.get("text", node.get("content", node.get("label", "")))
        btn_name = node.get("name", f"{pfx}-{'badge' if is_badge else 'button'}")
        btn_extra = {}
        for k in (
            "fill", "stroke", "color", "align", "textPaddingX", "opacity", "rotation", "strokeWidth",
            "borderSides", "borderTop", "borderBottom", "borderLeft", "borderRight",
            "backdropBlur", "innerGlow", "noise", "gradient", "shadow", "aurora",
            "x", "y", "right", "bottom", "anchor", "colSpan", "rowSpan",
            "spans", "italic", "underline", "strikethrough", "letterSpacing",
            "after", "afterGap", "alignX", "z",
        ):
            if k in node and node.get(k) is not None:
                btn_extra[k] = node.get(k)
        if node.get("variant") == "glass" and "backdropBlur" not in btn_extra:
            btn_extra["backdropBlur"] = 14
        if "flex" in node:
            btn_extra["flex"] = node.get("flex")
        if "_worst_case" in node:
            btn_extra["_worst_case"] = node.get("_worst_case")
        if "_row_texts" in node:
            btn_extra["_row_texts"] = node.get("_row_texts")
        raw_h = node.get("h")
        btn_h = raw_h if (is_fill(raw_h) or is_hug(raw_h)) else resolve_size(raw_h, 22 if is_badge else 36, "h")
        _btn_out = _preserve_when_attrs(node, make_button(
            btn_name,
            btn_text,
            variant=node.get("variant", "soft" if is_badge else "primary"),
            w=node.get("w"),
            h=btn_h,
            size=node.get("fontSize", node.get("size", 11 if is_badge else 13)),
            radius=node.get("radius", 4 if is_badge else 6),
            **btn_extra,
        ))
        if isinstance(node.get("id"), str):
            _btn_out.setdefault("id", node["id"])  # 保留逻辑 id，after/引用才能命中
        return _btn_out
    if ntype in ("radio", "checkbox", "combobox", "listbox") or (ntype == "input" and node.get("native") is True and node.get("styles")):
        out_form = {**node, "type": "native-form", "kind": ntype, "name": node.get("name", f"{pfx}-{ntype}")}
        out_form.setdefault("h", 120 if ntype == "listbox" else 36)
        out_form.setdefault("w", 240 if ntype in ("input", "combobox", "listbox") else 160)
        if ntype in ("input", "combobox", "listbox"):
            out_form.setdefault("fill", "$surface")
            out_form.setdefault("stroke", "$line")
            out_form.setdefault("strokeWidth", 1)
        return _preserve_when_attrs(node, out_form)
    if ntype == "input":
        inp_name = node.get("name", f"{pfx}-input")
        ph = node.get("text", node.get("value", node.get("placeholder", "请输入...")))
        raw_w, raw_h = node.get("w"), node.get("h")
        inp_w = raw_w if (is_fill(raw_w) or is_hug(raw_w)) else (raw_w if raw_w is not None else (None if "flex" in node else 200))
        inp_h = raw_h if (is_fill(raw_h) or is_hug(raw_h)) else resolve_size(raw_h, 36, "h")
        if node.get("native") is True:
            out_ni = {
                "type": "native-input",
                "name": inp_name,
                "placeholder": str(node.get("placeholder", node.get("text", ""))),
                "value": node.get("value", ""),
                "w": inp_w or 200,
                "h": inp_h,
                "fill": node.get("fill", "$surface-2"),
                "stroke": node.get("stroke", "$line-strong"),
                "radius": snap_token(node.get("radius", 6), RADIUS_TOKENS),
            }
            for key in ("fontSize", "size", "fontWeight", "weight", "color", "align", "textPaddingX", "rotation", "x", "y", "right", "bottom", "anchor"):
                if key in node:
                    out_ni[key] = node[key]
            if "flex" in node:
                out_ni["flex"] = node.get("flex")
            return _preserve_when_attrs(node, out_ni)
        inp_extra = {
            "fill": node.get("fill", "$surface-2"),
            "stroke": node.get("stroke", "$line"),
            "color": node.get("color", "$ink" if ("value" in node or "text" in node) else "$ink-2"),
            "align": node.get("align", "left"),
        }
        for key in ("x", "y", "right", "bottom", "anchor", "colSpan", "rowSpan"):
            if key in node and node.get(key) is not None:
                inp_extra[key] = node.get(key)
        if "flex" in node:
            inp_extra["flex"] = node.get("flex")
        if "textPaddingX" in node:
            inp_extra["textPaddingX"] = node.get("textPaddingX")
        return _preserve_when_attrs(node, make_button(
            inp_name,
            str(ph),
            variant=node.get("variant", "secondary"),
            w=inp_w,
            h=inp_h,
            size=node.get("fontSize", node.get("size", 12)),
            radius=node.get("radius", 6),
            **inp_extra,
        ))
    if ntype == "divider":
        div_name = node.get("name", f"{pfx}-divider")
        is_vert = node.get("direction") == "vertical"
        raw_w, raw_h = node.get("w"), node.get("h")
        div_extra = {}
        for key in ("x", "y", "right", "bottom", "anchor", "colSpan", "rowSpan"):
            if key in node and node.get(key) is not None:
                div_extra[key] = node.get(key)
        return _preserve_when_attrs(node, make_box(
            f"grp-{div_name}",
            layout="stack",
            w=(raw_w if (is_fill(raw_w) or is_hug(raw_w)) else resolve_size(raw_w, 1, "w")) if is_vert else (raw_w if raw_w is not None else "fill"),
            h=(raw_h if raw_h is not None else "fill") if is_vert else (raw_h if (is_fill(raw_h) or is_hug(raw_h)) else resolve_size(raw_h, 1, "h")),
            fill=node.get("color", node.get("fill", "$line")),
            radius=0,
            isGroup=False,
            bgName=node.get("bgName", div_name),
            children=[],
            **div_extra,
        ))
    if ntype == "card":
        card_name = node.get("name", f"{pfx}-card")
        card_children = [expand_declarative_tree(ch, prefix=pfx) for ch in (node.get("children") or [])]
        card_out = dict(node)
        is_glass = node.get("variant") == "glass"
        card_out["type"] = "box"
        card_out["name"] = card_name
        card_out["layout"] = node.get("layout", "column")
        card_out["padding"] = node.get("padding", [16, 16])
        card_out["gap"] = node.get("gap", 12)
        card_out["fill"] = node.get("fill", "$glass" if is_glass else "$surface")
        card_out["stroke"] = node.get("stroke", "$glass-border" if is_glass else "$line")
        card_out["radius"] = node.get("radius", 16 if is_glass else 10)
        if is_glass and "backdropBlur" not in card_out:
            card_out["backdropBlur"] = 18
        card_out["isGroup"] = bool(node.get("isGroup", True))
        card_out["bgName"] = node.get("bgName", f"bg-{card_name}")
        card_out["children"] = card_children
        return _preserve_when_attrs(node, card_out)
    if ntype == "mobile-navbar":
        return _preserve_when_attrs(node, expand_mobile_navbar(node, prefix=pfx))
    if ntype == "mobile-searchbar":
        return _preserve_when_attrs(node, expand_mobile_searchbar(node, prefix=pfx))
    if ntype == "mobile-segmented":
        return _preserve_when_attrs(node, expand_mobile_segmented(node, prefix=pfx))
    if ntype == "mobile-card-list":
        return _preserve_when_attrs(node, expand_mobile_card_list(node, prefix=pfx))
    if ntype == "mobile-tabbar":
        return _preserve_when_attrs(node, expand_mobile_tabbar(node, prefix=pfx))
    if ntype == "mobile-detail-view":
        return _preserve_when_attrs(node, expand_mobile_detail_view(node, prefix=pfx))
    if ntype == "mobile-form-view":
        return _preserve_when_attrs(node, expand_mobile_form_view(node, prefix=pfx))
    if ntype == "sidebar":
        return _preserve_when_attrs(node, expand_sidebar(node))
    if ntype == "topbar":
        return _preserve_when_attrs(node, expand_topbar(node))
    if ntype == "kpi-card":
        return _preserve_when_attrs(node, expand_kpi_card(node))
    out = dict(node)
    if not out.get("name"):
        out["name"] = f"grp-{pfx}-{ntype}"
    if "children" in out and isinstance(out["children"], list):
        out["children"] = [expand_declarative_tree(ch, prefix=pfx) for ch in out["children"]]
        if out.get("type", "box") == "box" and "isGroup" not in out and out["children"]:
            out["isGroup"] = True
    if out.get("type") == "repeater":
        out["template"] = expand_declarative_tree(out["template"], prefix=pfx)
    if "states" in out and isinstance(out["states"], list):
        new_states = []
        for s_idx, st in enumerate(out["states"]):
            if not isinstance(st, dict):
                continue
            st_copy = dict(st)
            if "name" not in st_copy and isinstance(st_copy.get("id"), str):
                st_copy["name"] = st_copy["id"]
            st_pfx = st_copy.get("prefix", f"{pfx}-{st_copy.get('name', f'st{s_idx+1}')}")
            if "tree" in st_copy and isinstance(st_copy["tree"], dict):
                st_copy["tree"] = expand_declarative_tree(st_copy["tree"], prefix=st_pfx)
            elif "root" in st_copy and isinstance(st_copy["root"], dict):
                st_copy["tree"] = expand_declarative_tree(st_copy["root"], prefix=st_pfx)
            elif isinstance(st_copy.get("children"), list):
                synth_root = {
                    "type": "box",
                    "name": f"{st_pfx}-root",
                    "layout": st_copy.get("layout", "column"),
                    "w": st_copy.get("w", "fill"),
                    "h": st_copy.get("h", "hug"),
                    "gap": st_copy.get("gap", 12),
                    "padding": st_copy.get("padding", 0),
                    "children": st_copy.pop("children"),
                }
                st_copy["tree"] = expand_declarative_tree(synth_root, prefix=st_pfx)
            new_states.append(st_copy)
        out["states"] = new_states
    return _preserve_when_attrs(node, out)


def apply_detail_bindings(raw_pages):
    """扫描页面树中的 mobile-card-list.bindDetail，自动注入首卡默认详情同步、卡片点击跳转与目标页/同页数据绑定。"""
    import copy
    pages = copy.deepcopy(raw_pages)
    page_by_name = {p.get("name"): p for p in pages if p.get("name")}

    def find_nodes_by_type(n, target_type, results=None):
        if results is None:
            results = []
        if not isinstance(n, dict):
            return results
        if n.get("type") == target_type:
            results.append(n)
        for ch in n.get("children", []) or []:
            find_nodes_by_type(ch, target_type, results)
        for st in n.get("states", []) or []:
            find_nodes_by_type(st.get("root") or st.get("tree"), target_type, results)
        return results

    def find_dynamic_panel(n, panel_name):
        if not isinstance(n, dict):
            return None
        if n.get("type") == "dynamic-panel" and n.get("name") == panel_name:
            return n
        for ch in n.get("children", []) or []:
            found = find_dynamic_panel(ch, panel_name)
            if found:
                return found
        return None

    for idx, p in enumerate(pages):
        p_slug = p.get("slug") or f"page-{idx+1}"
        card_lists = find_nodes_by_type(p.get("root"), "mobile-card-list")
        for cl in card_lists:
            bind = cl.get("bindDetail")
            if not bind or not isinstance(bind, dict):
                continue
            cl_pfx = cl.get("prefix") or p_slug
            cards = cl.get("cards") or []
            if not cards:
                continue
            target_page_name = bind.get("page") or bind.get("targetPage") or p.get("name")
            target_page = page_by_name.get(target_page_name, p)
            target_panel_name = bind.get("panel") or bind.get("targetPanel")
            # 自动探测目标页 mobile-detail-view 的真实 prefix，避免文档没写就 100% 悬空。
            # 优先级：显式 targetPrefix > 目标页 detail-view 的 prefix > "view"（兼容旧行为）
            _auto_pfx = None
            for _dv in find_nodes_by_type(target_page.get("root"), "mobile-detail-view"):
                _auto_pfx = _dv.get("prefix")
                if _auto_pfx:
                    break
            if not _auto_pfx:
                # 关键：页面展开时 `expand_declarative_tree(root, prefix=p_slug)`，
                # 所以未显式写 prefix 的 detail-view 实际前缀 = 页面 slug。
                # 其次才回退到祖先 prefix / 祖先 name。
                def _find_pfx(n, inherited=None):
                    if not isinstance(n, dict):
                        return None
                    cur = n.get("prefix") or inherited
                    if n.get("type") == "mobile-detail-view":
                        if n.get("prefix"):
                            return n["prefix"]
                        return inherited or n.get("name") or None
                    for ch in (n.get("children") or []):
                        _r = _find_pfx(ch, cur)
                        if _r:
                            return _r
                    return None
                _auto_pfx = _find_pfx(target_page.get("root"))
                if not _auto_pfx:
                    # 最后回退：页面 slug（与 expand_declarative_tree 的 prefix=p_slug 一致）
                    _auto_pfx = target_page.get("slug")
            target_pfx = bind.get("targetPrefix") or _auto_pfx or "view"
            expand_states = bool(bind.get("expandStates", False))
            mode = bind.get("mode") or ("panel-states" if target_panel_name else "set-text")

            # 同步首张卡片的 detail 到目标页的首个 mobile-detail-view 默认数据
            first_detail = cards[0].get("detail")
            if isinstance(first_detail, dict):
                for dv in find_nodes_by_type(target_page.get("root"), "mobile-detail-view"):
                    existing_data = dict(dv.get("data") or {})
                    dv["data"] = {**first_detail, **existing_data}
                    break

            p_ixs = list(p.get("interactions") or [])
            existing_triggers = {ix.get("trigger") for ix in p_ixs}

            if mode == "panel-states" and target_panel_name:
                dp_node = find_dynamic_panel(target_page.get("root"), target_panel_name)
                state_map = {}
                if dp_node and dp_node.get("states"):
                    base_state = copy.deepcopy(dp_node["states"][0])
                    state_map[cards[0].get("id", "c1")] = base_state["name"]
                    if expand_states and len(cards) > 1:
                        new_states = [dp_node["states"][0]]
                        for c_idx, c in enumerate(cards[1:], start=2):
                            cid = c.get("id", f"c{c_idx}")
                            c_detail = c.get("detail") or {"itemTitle": c.get("title", ""), "badge": c.get("badge", "失物招领"), "location": c.get("loc", ""), "pubTime": c.get("time", "")}
                            st_clone = copy.deepcopy(base_state)
                            st_clone["name"] = f"{base_state['name']}-{cid}"
                            st_clone["prefix"] = f"{base_state.get('prefix', 'view')}-{cid}"
                            for dv in find_nodes_by_type(st_clone.get("root") or st_clone.get("tree"), "mobile-detail-view"):
                                dv["prefix"] = st_clone["prefix"]
                                dv["data"] = c_detail
                            new_states.append(st_clone)
                            state_map[cid] = st_clone["name"]
                        new_states.extend(dp_node["states"][1:])
                        dp_node["states"] = new_states
                for c_idx, c in enumerate(cards):
                    cid = c.get("id", f"c{c_idx+1}")
                    trig_btn = c.get("buttonName") or f"{cl_pfx}-btn-detail-{cid}"
                    if trig_btn in existing_triggers:
                        continue
                    acts = []
                    if expand_states and cid in state_map:
                        acts.append({"type": "set-variable", "variable": "OnLoadVariable", "value": cid})
                    if target_page_name and target_page_name != p.get("name"):
                        acts.append({"type": "link", "page": target_page_name})
                    elif cid in state_map:
                        acts.append({"type": "set-panel-state", "target": target_panel_name, "state": state_map[cid]})
                    if acts:
                        p_ixs.append({
                            "trigger": trig_btn,
                            "description": f"点击卡片 {cid} 查看对应详情",
                            "events": [{"event": "OnClick", "cases": [{"name": f"GoCardDetail_{cid}", "actions": acts}]}],
                        })
                if expand_states and state_map and target_page_name != p.get("name"):
                    tp_ixs = list(target_page.get("interactions") or [])
                    onload_cases = []
                    for cid, st_nm in state_map.items():
                        onload_cases.append({
                            "name": f"LoadCard_{cid}",
                            "condition": "if" if not onload_cases else "else-if",
                            "when": {"left": {"variable": "OnLoadVariable"}, "op": "==", "right": cid},
                            "actions": [{"type": "set-panel-state", "target": target_panel_name, "state": st_nm}],
                        })
                    tp_ixs.append({
                        "trigger": "page",
                        "description": "根据所选卡片 OnLoadVariable 切换对应物品详情状态",
                        "events": [{"event": "OnPageLoad", "cases": onload_cases}],
                    })
                    target_page["interactions"] = tp_ixs
            elif mode == "set-text":
                tp_onload_cases = []
                for c_idx, c in enumerate(cards):
                    cid = c.get("id", f"c{c_idx+1}")
                    trig_btn = c.get("buttonName") or f"{cl_pfx}-btn-detail-{cid}"
                    d = c.get("detail") or {}
                    set_text_acts = [
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-badge-type", "text": d.get("badge", c.get("badge", "失物招领"))},
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-item-title", "text": d.get("itemTitle", c.get("title", ""))},
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-attr-loc", "text": d.get("location", f"拾获地点：{c.get('loc', '')}")},
                        {"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-item-pubtime", "text": d.get("pubTime", f"发布时间：{c.get('time', '')}")},
                    ]
                    if d.get("statusText"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-item-meta", "text": d["statusText"]})
                    if d.get("category"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-attr-cat", "text": d["category"]})
                    if d.get("holder"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-attr-holder", "text": d["holder"]})
                    if d.get("description"):
                        set_text_acts.append({"type": "set-text", "target": f"{targetPrefix_or(target_pfx)}-desc-para", "text": d["description"]})
                    if target_page_name == p.get("name"):
                        if trig_btn not in existing_triggers:
                            p_ixs.append({
                                "trigger": trig_btn,
                                "description": f"点击卡片 {cid} 更新详情文本",
                                "events": [{"event": "OnClick", "cases": [{"name": f"BindDetail_{cid}", "actions": set_text_acts}]}],
                            })
                    else:
                        if trig_btn not in existing_triggers:
                            p_ixs.append({
                                "trigger": trig_btn,
                                "description": f"点击卡片 {cid} 携带参数跳转详情页",
                                "events": [{"event": "OnClick", "cases": [{"name": f"GoCardDetail_{cid}", "actions": [{"type": "set-variable", "variable": "OnLoadVariable", "value": cid}, {"type": "link", "page": target_page_name}]}]}],
                            })
                        tp_onload_cases.append({
                            "name": f"ApplyDetail_{cid}",
                            "condition": "if" if not tp_onload_cases else "else-if",
                            "when": {"left": {"variable": "OnLoadVariable"}, "op": "==", "right": cid},
                            "actions": set_text_acts,
                        })
                if tp_onload_cases:
                    tp_ixs = list(target_page.get("interactions") or [])
                    tp_ixs.append({
                        "trigger": "page",
                        "description": "页面加载时根据 OnLoadVariable 填充对应物品详情文本",
                        "events": [{"event": "OnPageLoad", "cases": tp_onload_cases}],
                    })
                    target_page["interactions"] = tp_ixs
            p["interactions"] = p_ixs
    return pages


def targetPrefix_or(val):
    return val or "view"


def build_mobile_lostfound_spec(title_override=None):
    """构建内置移动端多页多态示例 spec：校园失物招领 App (3 页 + iPhone X 手机壳 + 双态动态面板 + 跨页交互)。"""
    p1_name = "页面一：失物信息浏览页"
    p2_name = "页面二：物品详情页"
    p3_name = "页面三：页面关系与设计说明"
    return {
        "name": title_override or "拾物 · 校园失物招领 App 原型",
        "domain": "mobile",
        "theme": "mobile-lowfi",
        "pages": [
            {
                "name": p1_name,
                "slug": "page1-browse",
                "device": "iphone-x",
                "canvas": {"w": 375, "h": 812},
                "root": {
                    "type": "box",
                    "name": "grp-p1-screen",
                    "layout": "column",
                    "w": 375,
                    "h": 812,
                    "padding": [44, 0, 0, 0],
                    "gap": 0,
                    "fill": "$bg",
                    "isGroup": True,
                    "bgName": "bg-p1-screen",
                    "children": [
                        {"type": "mobile-navbar", "prefix": "p1", "title": "拾物 · 招领广场", "rightText": "规范说明", "rightName": "p1-btn-doc"},
                        {"type": "mobile-searchbar", "prefix": "p1"},
                        {"type": "mobile-segmented", "prefix": "p1"},
                        {
                            "type": "mobile-card-list",
                            "prefix": "p1",
                            "h": 548,
                            "bindDetail": {
                                "page": p2_name,
                                "panel": "panel-item-state",
                            },
                        },
                        {"type": "mobile-tabbar", "prefix": "p1"},
                    ],
                },
                "interactions": [
                    {
                        "trigger": "p1-btn-detail-c1",
                        "description": "点击卡片1进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail1", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-detail-c2",
                        "description": "点击卡片2进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail2", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-detail-c3",
                        "description": "点击卡片3进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail3", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-detail-c4",
                        "description": "点击卡片4进入物品详情页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDetail4", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-publish-plus",
                        "description": "点击底部发布按钮进入物品详情/发布页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoPublish", "actions": [{"type": "link", "page": p2_name}]}]}],
                    },
                    {
                        "trigger": "p1-btn-doc",
                        "description": "点击右上角规范说明进入设计说明页",
                        "events": [{"event": "OnClick", "cases": [{"name": "GoDoc", "actions": [{"type": "link", "page": p3_name}]}]}],
                    },
                ],
            },
            {
                "name": p2_name,
                "slug": "page2-detail-panel",
                "device": None,
                "canvas": {"w": 420, "h": 860},
                "root": {
                    "type": "box",
                    "name": "grp-p2-host",
                    "layout": "stack",
                    "w": 420,
                    "h": 860,
                    "fill": "$surface",
                    "isGroup": True,
                    "bgName": "bg-p2-host",
                    "children": [
                        {
                            "type": "dynamic-panel",
                            "name": "panel-item-state",
                            "x": 0,
                            "y": 0,
                            "w": 420,
                            "h": 860,
                            "states": [
                                {
                                    "name": "状态一：查看物品详情",
                                    "prefix": "view",
                                    "device": "iphone-x",
                                    "canvas": {"w": 375, "h": 812},
                                    "root": {"type": "mobile-detail-view", "prefix": "view", "title": "物品信息详情"},
                                },
                                {
                                    "name": "状态二：发布失物招领",
                                    "prefix": "pub",
                                    "device": "iphone-x",
                                    "canvas": {"w": 375, "h": 812},
                                    "root": {"type": "mobile-form-view", "prefix": "pub", "title": "发布寻物 / 招领信息"},
                                },
                            ],
                        }
                    ],
                },
                "interactions": [
                    {
                        "trigger": "view-btn-to-publish",
                        "description": "从查看态切换到发布态",
                        "events": [{"event": "OnClick", "cases": [{"name": "ToPublishState", "actions": [{"type": "set-panel-state", "target": "panel-item-state", "state": "状态二：发布失物招领"}]}]}],
                    },
                    {
                        "trigger": "view-btn-back",
                        "description": "从详情查看态返回招领广场",
                        "events": [{"event": "OnClick", "cases": [{"name": "BackToSquareFromView", "actions": [{"type": "link", "page": p1_name}]}]}],
                    },
                    {
                        "trigger": "pub-btn-to-view",
                        "description": "从发布态切换回查看态",
                        "events": [{"event": "OnClick", "cases": [{"name": "ToViewState", "actions": [{"type": "set-panel-state", "target": "panel-item-state", "state": "状态一：查看物品详情"}]}]}],
                    },
                    {
                        "trigger": "pub-btn-back",
                        "description": "从发布态返回查看态",
                        "events": [{"event": "OnClick", "cases": [{"name": "BackToViewFromPub", "actions": [{"type": "set-panel-state", "target": "panel-item-state", "state": "状态一：查看物品详情"}]}]}],
                    },
                    {
                        "trigger": "pub-btn-submit",
                        "description": "提交发布后返回招领广场",
                        "events": [{"event": "OnClick", "cases": [{"name": "SubmitAndBackSquare", "actions": [{"type": "link", "page": p1_name}]}]}],
                    },
                ],
            },
            {
                "name": p3_name,
                "slug": "page3-spec-doc",
                "device": None,
                "canvas": {"w": 1120, "h": 680},
                "root": {
                    "type": "box",
                    "name": "grp-doc-canvas",
                    "layout": "column",
                    "w": 1120,
                    "h": 680,
                    "padding": [28, 32],
                    "gap": 20,
                    "fill": "$bg",
                    "isGroup": True,
                    "bgName": "bg-doc-canvas",
                    "children": [
                        {
                            "type": "box",
                            "name": "grp-doc-header",
                            "layout": "row",
                            "w": 1056,
                            "h": 72,
                            "padding": [16, 20],
                            "gap": 16,
                            "align": "center",
                            "fill": "$surface",
                            "stroke": "$line",
                            "radius": 10,
                            "isGroup": True,
                            "bgName": "bg-doc-header",
                            "children": [
                                {
                                    "type": "box",
                                    "name": "grp-doc-title-col",
                                    "layout": "column",
                                    "flex": 1,
                                    "gap": 4,
                                    "isGroup": True,
                                    "children": [
                                        make_label("doc-main-title", "拾物 · 校园失物招领 App — 页面流转与设计规范说明", size=18, weight=700, color="$ink"),
                                        make_label("doc-main-sub", "遵循 iPhone X (375×812 pt / 420×860 整机画板) 低保真灰阶线框规范 · 全元件语义命名与编组", size=12, weight=400, color="$ink-2"),
                                    ],
                                },
                                make_button("doc-btn-back-app", "返回招领广场 >", variant="primary", w=132, h=36, size=12, radius=8),
                            ],
                        },
                        {
                            "type": "box",
                            "name": "grp-doc-cards",
                            "layout": "row",
                            "w": 1056,
                            "h": 520,
                            "gap": 20,
                            "isGroup": True,
                            "children": [
                                {
                                    "type": "box",
                                    "name": "grp-doc-col-1",
                                    "layout": "column",
                                    "flex": 1,
                                    "h": 520,
                                    "padding": [20, 20],
                                    "gap": 12,
                                    "fill": "$surface",
                                    "stroke": "$line",
                                    "radius": 10,
                                    "isGroup": True,
                                    "bgName": "bg-doc-col-1",
                                    "children": [
                                        make_button("doc-tag-1", "01 · 页面架构与跳转关系", variant="secondary", w=188, h=26, size=11, radius=6),
                                        {
                                            "type": "paragraph",
                                            "name": "doc-para-flow",
                                            "w": 292,
                                            "fontSize": 12,
                                            "text": "本原型包含 3 个顶层页面：页面一为失物信息浏览广场；页面二内置双状态动态面板（状态一：查看物品详情；状态二：发布寻物/招领信息）；页面三为本架构与设计规范说明。",
                                        },
                                        make_label("doc-flow-rule-1", "1. 浏览页点击任意物品卡片 → 跳转页面二（查看态）", size=12, weight=600, color="$ink"),
                                        make_label("doc-flow-rule-2", "2. 详情查看态点击右上角「去发布」→ 切换至发布态", size=12, weight=600, color="$ink"),
                                        make_label("doc-flow-rule-3", "3. 发布态点击「确认发布」→ 返回页面一招领广场", size=12, weight=600, color="$ink"),
                                    ],
                                },
                                {
                                    "type": "box",
                                    "name": "grp-doc-col-2",
                                    "layout": "column",
                                    "flex": 1,
                                    "h": 520,
                                    "padding": [20, 20],
                                    "gap": 12,
                                    "fill": "$surface",
                                    "stroke": "$line",
                                    "radius": 10,
                                    "isGroup": True,
                                    "bgName": "bg-doc-col-2",
                                    "children": [
                                        make_button("doc-tag-2", "02 · 视口尺寸与安全区规范", variant="secondary", w=188, h=26, size=11, radius=6),
                                        {
                                            "type": "paragraph",
                                            "name": "doc-para-spec",
                                            "w": 292,
                                            "fontSize": 12,
                                            "text": "采用内置 iPhone X 规范外框（外框 420×860 px，内屏视口 375×812 px，内屏偏移 X=25, Y=21）。顶部预留 44pt 状态栏与 44pt 导航栏，底部预留 34pt Home Indicator 安全区。",
                                        },
                                        make_label("doc-spec-item-1", "• 页面边距：左右安全间距 16pt，卡片内边距 12pt", size=12, weight=500, color="$ink-2"),
                                        make_label("doc-spec-item-2", "• 色彩体系：纯灰阶低保真线框（#262626 ~ #F7F7F7）", size=12, weight=500, color="$ink-2"),
                                        make_label("doc-spec-item-3", "• 字阶规范：标题 16/18pt，正文 12/13pt，辅助 11pt", size=12, weight=500, color="$ink-2"),
                                    ],
                                },
                                {
                                    "type": "box",
                                    "name": "grp-doc-col-3",
                                    "layout": "column",
                                    "flex": 1,
                                    "h": 520,
                                    "padding": [20, 20],
                                    "gap": 12,
                                    "fill": "$surface",
                                    "stroke": "$line",
                                    "radius": 10,
                                    "isGroup": True,
                                    "bgName": "bg-doc-col-3",
                                    "children": [
                                        make_button("doc-tag-3", "03 · 结构与命名质量门禁", variant="secondary", w=188, h=26, size=11, radius=6),
                                        {
                                            "type": "paragraph",
                                            "name": "doc-para-qa",
                                            "w": 292,
                                            "fontSize": 12,
                                            "text": "所有页面与动态面板状态均通过确定性 Auto-Layout 排版、PingFang 字宽防裁切校验、原生 Layer 编组发射与 0 重名全量坐标校验。",
                                        },
                                        make_label("doc-qa-item-1", "● 语义命名覆盖率：100%（零 Unnamed / 零重名）", size=12, weight=600, color="$ink"),
                                        make_label("doc-qa-item-2", "● 原生 Layer 编组覆盖率：≥ 95%", size=12, weight=600, color="$ink"),
                                        make_label("doc-qa-item-3", "● 文本裁切与重叠数：0 处", size=12, weight=600, color="$ink"),
                                    ],
                                },
                            ],
                        },
                    ],
                },
                "interactions": [
                    {
                        "trigger": "doc-btn-back-app",
                        "description": "从说明页返回招领广场",
                        "events": [{"event": "OnClick", "cases": [{"name": "BackToSquareFromDoc", "actions": [{"type": "link", "page": p1_name}]}]}],
                    }
                ],
            },
        ],
    }


STATE_PREVIEWS = []


def render_contact_sheet_png(items, out_path, max_cols=4, max_thumb_h=640, max_thumb_w=460, title="Prototype Contact Sheet"):
    """Stitch multiple page or state PNG previews into a single grid overview image."""
    valid = []
    for it in (items or []):
        p = it.get("path")
        if p and os.path.exists(p):
            try:
                im = Image.open(p).convert("RGBA")
                valid.append((it.get("label") or os.path.basename(p), im))
            except Exception:
                continue
    if not valid:
        return None
    cols = min(max_cols, len(valid))
    rows = (len(valid) + cols - 1) // cols
    thumbs = []
    for lbl, im in valid:
        iw, ih = im.size
        scale = min(1.0, max_thumb_w / max(1, iw), max_thumb_h / max(1, ih))
        tw = max(40, int(round(iw * scale)))
        th = max(40, int(round(ih * scale)))
        tim = im.resize((tw, th), Image.Resampling.LANCZOS) if scale < 0.999 else im
        thumbs.append((lbl, tim, tw, th))
    cell_w = max(260, max(t[2] for t in thumbs) + 28)
    cell_h = max(t[3] for t in thumbs) + 52
    pad = 24
    hdr_h = 44
    sheet_w = pad * 2 + cols * cell_w
    sheet_h = pad * 2 + hdr_h + rows * cell_h
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (244, 246, 250, 255))
    draw = ImageDraw.Draw(sheet)
    font_title = load_font(16, 700)
    font_lbl = load_font(13, 600)
    draw.text((pad, pad + 8), f"{title} ({len(thumbs)})", fill=(24, 32, 44, 255), font=font_title)
    for idx, (lbl, tim, tw, th) in enumerate(thumbs):
        r = idx // cols
        c = idx % cols
        cx = pad + c * cell_w
        cy = pad + hdr_h + r * cell_h
        draw.rounded_rectangle([cx + 4, cy + 4, cx + cell_w - 8, cy + cell_h - 8], radius=12, fill=(255, 255, 255, 255), outline=(220, 226, 236, 255), width=1)
        draw.text((cx + 14, cy + 12), str(lbl)[:48], fill=(32, 42, 56, 255), font=font_lbl)
        ix = cx + (cell_w - tw) // 2
        iy = cy + 38 + (cell_h - 46 - th) // 2
        sheet.paste(tim, (ix, iy), tim)
    sheet.convert("RGB").save(out_path)
    return out_path


def _auto_heal_spec_pre_compile(spec_data, strict_audit=False):
    """Safe pre-compile normalization: fix outer device chassis canvas mismatch and snap non-token spacing/radius/font values."""
    changes = []
    if not isinstance(spec_data, dict):
        return changes
    from rp_language import DEVICE_CANVAS_PRESETS
    top_dev = spec_data.get("device") or spec_data.get("shell")
    pages = spec_data.get("pages")
    if isinstance(pages, list):
        for p in pages:
            if not isinstance(p, dict):
                continue
            pid = p.get("id") or p.get("slug") or p.get("name") or "page"
            dev = p.get("device") or p.get("shell") or top_dev
            if not dev and isinstance(p.get("root"), dict):
                r = p["root"]
                if r.get("type") == "phone-shell" or "phone-shell" in r:
                    dev = r.get("device", "iphone-17")
                elif isinstance(r.get("children"), list) and len(r["children"]) == 1 and isinstance(r["children"][0], dict):
                    ch0 = r["children"][0]
                    if ch0.get("type") == "phone-shell" or "phone-shell" in ch0:
                        dev = ch0.get("device", "iphone-17")
            preset = DEVICE_CANVAS_PRESETS.get(dev) if isinstance(dev, str) else None
            if preset:
                cv = p.get("canvas")
                cw = cv[0] if isinstance(cv, list) and len(cv) == 2 else (cv.get("w") if isinstance(cv, dict) else None)
                ch = cv[1] if isinstance(cv, list) and len(cv) == 2 else (cv.get("h") if isinstance(cv, dict) else None)
                if cw == preset["w"] + 40 and ch == preset["h"] + 40:
                    p["canvas"] = {"w": preset["w"], "h": preset["h"]}
                    changes.append({"kind": "normalize-device-canvas", "page": pid, "from": [cw, ch], "to": [preset["w"], preset["h"]]})
                    r = p.get("root")
                    if isinstance(r, dict) and isinstance(r.get("children"), list) and len(r["children"]) == 1:
                        ch0 = r["children"][0]
                        if isinstance(ch0, dict) and (ch0.get("type") == "phone-shell" or "phone-shell" in ch0):
                            ch0.pop("x", None)
                            ch0.pop("y", None)
                            p["root"] = ch0
                            changes.append({"kind": "unwrap-redundant-device-root", "page": pid})
    if strict_audit or spec_data.get("strictAudit"):
        def _snap_tree_tokens(node, path_str=""):
            if not isinstance(node, dict):
                return
            for sp_k in ("gap", "columnGap", "rowGap"):
                if isinstance(node.get(sp_k), (int, float)) and not isinstance(node.get(sp_k), bool):
                    v = node[sp_k]
                    sv = snap_token(v, SPACING_TOKENS)
                    if sv != v:
                        node[sp_k] = sv
                        changes.append({"kind": "snap-spacing-token", "property": sp_k, "from": v, "to": sv})
            if "padding" in node:
                pv = node["padding"]
                if isinstance(pv, (int, float)) and not isinstance(pv, bool):
                    spv = snap_token(pv, SPACING_TOKENS)
                    if spv != pv:
                        node["padding"] = spv
                        changes.append({"kind": "snap-padding-token", "from": pv, "to": spv})
                elif isinstance(pv, list):
                    sp_list = [snap_token(x, SPACING_TOKENS) if isinstance(x, (int, float)) else x for x in pv]
                    if sp_list != pv:
                        node["padding"] = sp_list
                        changes.append({"kind": "snap-padding-token", "from": pv, "to": sp_list})
            if isinstance(node.get("radius"), (int, float)) and not isinstance(node.get("radius"), bool):
                rv = node["radius"]
                srv = 999 if rv >= 100 else snap_token(rv, RADIUS_TOKENS)
                if srv != rv:
                    node["radius"] = srv
                    changes.append({"kind": "snap-radius-token", "from": rv, "to": srv})
            for fn_k in ("fontSize", "size"):
                if isinstance(node.get(fn_k), (int, float)) and not isinstance(node.get(fn_k), bool):
                    fv = node[fn_k]
                    sfv = snap_token(fv, FONT_SIZE_TOKENS)
                    if sfv != fv:
                        node[fn_k] = sfv
                        changes.append({"kind": "snap-font-token", "property": fn_k, "from": fv, "to": sfv})
            for ch in (node.get("children") if isinstance(node.get("children"), list) else []):
                _snap_tree_tokens(ch)
            for st in (node.get("states") if isinstance(node.get("states"), list) else []):
                if isinstance(st, dict):
                    if isinstance(st.get("root") or st.get("tree"), dict):
                        _snap_tree_tokens(st.get("root") or st.get("tree"))
                    elif isinstance(st.get("children"), list):
                        for sch in st["children"]:
                            _snap_tree_tokens(sch)
            if isinstance(node.get("template"), dict):
                _snap_tree_tokens(node["template"])

        for p in (pages if isinstance(pages, list) else []):
            if isinstance(p, dict):
                _snap_tree_tokens(p.get("root"))
        for cdef in (spec_data.get("components") or {}).values() if isinstance(spec_data.get("components"), dict) else []:
            if isinstance(cdef, dict):
                _snap_tree_tokens(cdef.get("root"))
    return changes


def _auto_heal_page_tree(p_root, cw, ch, p_slug, base_dir=None):
    """Safe post-measure layout self-healing on a page's declarative root tree.
    Repairs text clipping (`no_text_clip`) and container overflow (`no_container_overflow`)
    without altering explicit canvas dimensions.
    """
    changes = []
    for _pass in range(2):
        probe = expand_declarative_tree(copy.deepcopy(p_root), prefix=p_slug)
        ensure_unique_names(probe, scope_prefix=p_slug)
        measure_node(probe, base_dir=base_dir, available_w=cw)
        layout_node(probe, 0, 0, cw, ch)

        src_by_name = {}
        parent_map = {}

        def _index_src(node, parent=None):
            if not isinstance(node, dict):
                return
            nm = node.get("name") or node.get("id")
            if nm:
                src_by_name[nm] = node
                if nm.startswith("grp-"):
                    src_by_name[nm[4:]] = node
            if parent is not None:
                parent_map[id(node)] = parent
            for child in (node.get("children") or []):
                _index_src(child, node)
            for st in (node.get("states") or []):
                if isinstance(st, dict):
                    if isinstance(st.get("root") or st.get("tree"), dict):
                        _index_src(st.get("root") or st.get("tree"), node)
                    elif isinstance(st.get("children"), list):
                        for sch in st["children"]:
                            _index_src(sch, node)
            if isinstance(node.get("template"), dict):
                _index_src(node["template"], node)

        _index_src(p_root)
        pass_changes = 0

        def _match_src(w_name):
            if not w_name:
                return None
            if w_name in src_by_name:
                return src_by_name[w_name]
            for prefix_strip in ("bg-box-", "grp-box-", "bg-", "grp-"):
                if w_name.startswith(prefix_strip) and w_name[len(prefix_strip):] in src_by_name:
                    return src_by_name[w_name[len(prefix_strip):]]
            for k, v in src_by_name.items():
                if w_name.endswith("__" + k) or w_name.endswith("-" + k):
                    return v
            return None

        def _heal_walk(pnode):
            nonlocal pass_changes
            if not isinstance(pnode, dict) or "_x" not in pnode:
                return
            nm = pnode.get("name") or pnode.get("id") or ""
            snode = _match_src(nm)
            ntype = pnode.get("type", "box")
            if ntype in ("label", "shape-text") and snode is not None:
                txt = pnode.get("text", "")
                if txt is not None and str(txt).strip():
                    fsz = snap_token(pnode.get("fontSize", pnode.get("size", 14)), FONT_SIZE_TOKENS)
                    fwt = snap_token(pnode.get("fontWeight", pnode.get("weight", 400)), FONT_WEIGHT_TOKENS)
                    pad_in = 16 if (pnode.get("fill") or pnode.get("stroke") or ntype == "shape-text") else 2
                    tw, th = measure_text(str(txt), fsz, fwt)
                    pw, ph = pnode["_w"], pnode["_h"]
                    if tw + pad_in > pw + 2 and not pnode.get("wrap"):
                        par = parent_map.get(id(snode))
                        par_layout = par.get("layout", "column") if isinstance(par, dict) else "column"
                        if snode.get("type") in ("label", "paragraph") and (par_layout == "column" or is_fill(snode.get("w")) or pw >= 120):
                            wrap_lines = wrap_text(str(txt), max(20, pw - pad_in - 4), fsz, fwt)
                            line_h = max(18, int(round(fsz * 1.45)))
                            need_h = max(th, len(wrap_lines) * line_h + 4)
                            snode["wrap"] = True
                            snode["h"] = max(int(snode.get("h")) if isinstance(snode.get("h"), (int, float)) else 0, need_h)
                            changes.append({"kind": "heal-text-wrap", "widget": nm, "h": snode["h"]})
                            pass_changes += 1
                        elif isinstance(snode.get("w"), (int, float)):
                            new_w = int(tw + pad_in + 6)
                            if new_w > snode["w"]:
                                snode["w"] = new_w
                                changes.append({"kind": "heal-text-width", "widget": nm, "w": new_w})
                                pass_changes += 1
                    if th > ph + 1 and isinstance(snode.get("h"), (int, float)):
                        new_h = int(th + 6)
                        if new_h > snode["h"]:
                            delta_h = new_h - int(snode["h"])
                            snode["h"] = new_h
                            cur_p = parent_map.get(id(snode))
                            while isinstance(cur_p, dict):
                                if cur_p is not p_root and isinstance(cur_p.get("h"), (int, float)):
                                    cur_p["h"] = int(cur_p["h"]) + delta_h
                                cur_p = parent_map.get(id(cur_p))
                            changes.append({"kind": "heal-text-height", "widget": nm, "h": new_h})
                            pass_changes += 1

            children = [c for c in (pnode.get("children") or []) if isinstance(c, dict) and not c.get("isModal") and "_x" in c]
            if children and pnode.get("layout", "column") in ("row", "column", "grid"):
                nx, ny, nw, nh = pnode["_x"], pnode["_y"], pnode["_w"], pnode["_h"]
                max_bot_over = max((max(0, (c["_y"] + c["_h"]) - (ny + nh)) for c in children), default=0)
                max_right_over = max((max(0, (c["_x"] + c["_w"]) - (nx + nw)) for c in children), default=0)
                if max_bot_over > 2 and snode is not None:
                    if snode is p_root or (isinstance(snode.get("h"), (int, float)) and int(snode["h"]) >= ch - 8):
                        # Root / phone-shell overflow: compact vertical gaps and paddings
                        def _compact_vertical(box_node):
                            compacted = False
                            if not isinstance(box_node, dict):
                                return False
                            if isinstance(box_node.get("gap"), (int, float)) and box_node["gap"] > 6:
                                old_g = box_node["gap"]
                                smaller = [t for t in SPACING_TOKENS if 4 <= t < old_g]
                                box_node["gap"] = smaller[-1] if smaller else max(4, int(old_g) - 4)
                                compacted = True
                            for ch_b in (box_node.get("children") or []):
                                if _compact_vertical(ch_b):
                                    compacted = True
                            return compacted
                        if _compact_vertical(snode):
                            changes.append({"kind": "compact-root-vertical-spacing", "widget": nm, "overflowPx": max_bot_over})
                            pass_changes += 1
                    elif isinstance(snode.get("h"), (int, float)):
                        new_ch = int(nh + max_bot_over + 4)
                        snode["h"] = new_ch
                        changes.append({"kind": "expand-container-height", "widget": nm, "from": nh, "to": new_ch})
                        pass_changes += 1
                if max_right_over > 2 and snode is not None:
                    if pnode.get("layout") == "row":
                        if isinstance(snode.get("gap"), (int, float)) and snode["gap"] > 6:
                            snode["gap"] = 6
                            changes.append({"kind": "compact-row-gap", "widget": nm, "to": 6})
                            pass_changes += 1
                        else:
                            snode["wrap"] = True
                            if isinstance(snode.get("h"), (int, float)):
                                snode["h"] = "hug"
                            changes.append({"kind": "enable-row-wrap", "widget": nm})
                            pass_changes += 1
                    else:
                        for c in children:
                            if (c["_x"] + c["_w"]) > (nx + nw + 2):
                                cs = _match_src(c.get("name") or c.get("id") or "")
                                if cs is not None and isinstance(cs.get("w"), (int, float)):
                                    cs["w"] = "fill"
                                    changes.append({"kind": "clamp-child-width-fill", "widget": c.get("name", "")})
                                    pass_changes += 1
            for c in children:
                _heal_walk(c)
            if pnode.get("type") == "dynamic-panel":
                for st in (pnode.get("states") or []):
                    st_t = st.get("tree") if isinstance(st, dict) else None
                    if isinstance(st_t, dict):
                        measure_node(st_t, base_dir=base_dir, available_w=pnode["_w"])
                        layout_node(st_t, 0, 0, pnode["_w"], pnode["_h"])
                        _heal_walk(st_t)

        _heal_walk(probe)
        if pass_changes == 0:
            break
    return changes


def _heal_property_changes(before, after, pointer=""):
    changes = []
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(before.keys() | after.keys()):
            path = pointer + "/" + str(key).replace("~", "~0").replace("/", "~1")
            changes.extend(_heal_property_changes(before.get(key), after.get(key), path))
    elif isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        for idx, (old, new) in enumerate(zip(before, after)):
            changes.extend(_heal_property_changes(old, new, pointer + "/" + str(idx)))
    elif before != after:
        changes.append({"pointer": pointer, "property": pointer.rsplit("/", 1)[-1], "from": before, "to": after})
    return changes


def compile_spec_bundle(spec_data, out_dir, theme_override=None, base_dir=None, no_interactions=False, strict_audit=False, source_path=None, ink_sink=None, auto_heal=False):
    """Treat automatic changes as a transaction, checked against the original gates."""
    import copy
    import tempfile
    options = dict(theme_override=theme_override, base_dir=base_dir,
                   no_interactions=no_interactions, strict_audit=strict_audit, source_path=source_path)
    enabled = bool(auto_heal and str(auto_heal).lower() not in ("false", "off", "0", "none"))
    if not enabled:
        return _compile_spec_bundle(spec_data, out_dir, ink_sink=ink_sink, **options)
    from rp_language import validate_source_tree
    validate_source_tree(spec_data)
    original = copy.deepcopy(spec_data)
    baseline = None
    with tempfile.TemporaryDirectory(prefix="zee-heal-gates-") as probe_dir:
        try:
            baseline = _compile_spec_bundle(copy.deepcopy(original), probe_dir, **options)
            baseline_audit = json.load(open(baseline["auditPath"], encoding="utf-8"))
        except LanguageError:
            baseline_audit = None
        rejected = []
        stage_dir = os.path.join(probe_dir, "candidate-out")
        try:
            candidate_ink = [] if ink_sink is not None else None
            result = _compile_spec_bundle(copy.deepcopy(original), stage_dir, ink_sink=candidate_ink,
                                         auto_heal=auto_heal, **options)
            audit = json.load(open(result["auditPath"], encoding="utf-8"))
            def failures(report):
                return {json.dumps(f, sort_keys=True, ensure_ascii=False) for f in report.get("failures", [])}
            if baseline_audit is not None:
                rejected = sorted(failures(audit) - failures(baseline_audit))
                if baseline.get("ok") and not result.get("ok") and not rejected:
                    rejected = ["A previously passing audit gate failed"]
        except LanguageError as error:
            if baseline is None:
                raise
            rejected = [error.diagnostic]
            result = None
        if rejected:
            changes = []
            if result:
                plan = json.load(open(result["planPath"], encoding="utf-8"))
                changes = plan.get("autoHeal", {}).get("changes", [])
            else:
                trial = copy.deepcopy(original)
                _auto_heal_spec_pre_compile(trial, strict_audit=strict_audit)
                changes = _heal_property_changes(original, trial)
            result = _compile_spec_bundle(copy.deepcopy(original), out_dir, ink_sink=ink_sink, **options)
            summary = {"mode": str(auto_heal), "healedCount": 0, "changes": [], "rolledBack": True,
                       "rejectedChanges": changes, "rejectedDiagnostics": rejected,
                       "validation": "all compile and audit gates rerun on original source"}
        else:
            result = _compile_spec_bundle(copy.deepcopy(original), out_dir, ink_sink=ink_sink,
                                         auto_heal=auto_heal, **options)
            plan = json.load(open(result["planPath"], encoding="utf-8"))
            summary = {**plan.get("autoHeal", {}), "rolledBack": False,
                       "validation": "all compile and audit gates compared with original source"}
        for key in ("planPath", "auditPath"):
            path = result[key]
            with open(path, encoding="utf-8") as handle:
                report = json.load(handle)
            report["autoHeal"] = summary
            if key == "planPath":
                report["audit"]["autoHeal"] = summary
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(report, handle, ensure_ascii=False, indent=2)
        result["audit"]["autoHeal"] = summary
        result["autoHeal"] = summary
        return result


def _compile_spec_bundle(spec_data, out_dir, theme_override=None, base_dir=None, no_interactions=False, strict_audit=False, source_path=None, ink_sink=None, auto_heal=False):
    STATE_PREVIEWS.clear()  # 每次编译先清空，避免跨次残留
    """通用声明式多页/多状态原型编译器：支持 --spec <spec.json>、数据绑定、静态模式与两级审计门禁。"""
    import copy
    os.makedirs(out_dir, exist_ok=True)
    heal_enabled = bool(auto_heal and str(auto_heal).lower() not in ("false", "off", "0", "none"))
    auto_heal_changes = []
    if heal_enabled:
        before_heal = copy.deepcopy(spec_data)
        _auto_heal_spec_pre_compile(spec_data, strict_audit=strict_audit)
        auto_heal_changes.extend(_heal_property_changes(before_heal, spec_data))
    raw_source_spec = copy.deepcopy(spec_data)
    language_ir = None
    if "language" in spec_data:
        spec_data, language_ir = compile_language(spec_data)
        with open(os.path.join(out_dir, "language-ir.json"), "w", encoding="utf-8") as f:
            json.dump(language_ir, f, ensure_ascii=False, indent=2)
    states_dir = os.path.join(out_dir, "states")
    os.makedirs(states_dir, exist_ok=True)

    theme_name = theme_override or spec_data.get("theme") or "mobile-lowfi"
    theme_dict = dict(THEMES.get(theme_name, THEMES["mobile-lowfi"]))
    if isinstance(spec_data.get("palette"), dict):
        for pk, pv in spec_data["palette"].items():
            theme_dict[str(pk).lstrip("$")] = str(pv)
    domain = spec_data.get("domain", "mobile" if theme_name.startswith("mobile-") else "web")
    is_static = bool(no_interactions or spec_data.get("static") or spec_data.get("noInteractions"))
    is_strict = bool(strict_audit or spec_data.get("strictAudit"))

    raw_pages = apply_detail_bindings(spec_data.get("pages") or [spec_data])
    known_page_names = [p.get("name", f"Page {i+1}") for i, p in enumerate(raw_pages)]

    raw_m = spec_data.get("masters") or {}
    master_defs = raw_m if isinstance(raw_m, dict) else {m["id"]: m for m in raw_m}
    master_plans = []

    page_plans = []
    page_audits = []
    all_previews = {}

    for idx, p_spec in enumerate(raw_pages):
        p_name = p_spec.get("name", f"Page {idx+1}")
        p_slug = p_spec.get("slug") or f"page-{idx+1}"
        dev_shell = p_spec.get("device")
        p_domain = p_spec.get("domain") or ("doc" if "doc" in p_slug else domain)
        page_static = bool(is_static or p_spec.get("static") or p_spec.get("noInteractions"))
        canvas = p_spec.get("canvas") or ({"w": 375, "h": 812} if dev_shell else {"w": 1440, "h": 900})
        cw, ch = int(canvas["w"]), int(canvas["h"])

        p_schema_warnings = []
        if "root" not in p_spec or not isinstance(p_spec["root"], dict):
            if isinstance(p_spec.get("children"), list) or isinstance(p_spec.get("widgets"), list):
                p_spec = {
                    **p_spec,
                    "root": {
                        "type": "box",
                        "id": f"{p_slug}_root",
                        "layout": p_spec.get("layout", "stack"),
                        "w": cw,
                        "h": ch,
                        "children": p_spec.get("children") if isinstance(p_spec.get("children"), list) else p_spec.get("widgets"),
                    },
                }
            else:
                from rp_language import fail
                fail("E_SCHEMA", f"/pages/{idx}/root", f"Page '{p_name}' is missing required 'root' container object")
        validate_node_schema(p_spec["root"], warnings_out=p_schema_warnings, path=f"{p_slug}.root", allow_fallback=bool(language_ir))
        if heal_enabled:
            before_heal = copy.deepcopy(p_spec["root"])
            _auto_heal_page_tree(p_spec["root"], cw, ch, p_slug, base_dir=base_dir)
            auto_heal_changes.extend({**change, "page": p_slug, "stage": "lowered-layout"} for change in
                                     _heal_property_changes(before_heal, p_spec["root"], f"/pages/{idx}/root"))

        root_main = expand_declarative_tree(copy.deepcopy(p_spec["root"]), prefix=p_slug)
        ensure_unique_names(root_main, scope_prefix=p_slug)
        measure_node(root_main, base_dir=base_dir, available_w=cw)
        layout_node(root_main, 0, 0, cw, ch)
        em_main = emit_tree_to_axvg(root_main, theme_dict, include_dynamic_panel_placeholders=False, base_dir=base_dir)
        if dev_shell:
            em_main = compose_device_shell(em_main, p_slug, shell_name=dev_shell)

        root_prev = expand_declarative_tree(copy.deepcopy(p_spec["root"]), prefix=p_slug)
        ensure_unique_names(root_prev, scope_prefix=p_slug)
        measure_node(root_prev, base_dir=base_dir, available_w=cw)
        layout_node(root_prev, 0, 0, cw, ch)
        em_prev = emit_tree_to_axvg(root_prev, theme_dict, include_dynamic_panel_placeholders=True, base_dir=base_dir)
        if dev_shell:
            em_prev = compose_device_shell(em_prev, p_slug, shell_name=dev_shell)

        master_node_names = set()
        adaptive_overrides = {}
        view_ids = {v.get("id", v.get("name")) for v in spec_data.get("adaptiveViews", [])}

        def collect_native_metadata(node, in_master=False, in_container=False):
            if not isinstance(node, dict):
                return
            in_master = False if node.get("_master_slot") else in_master or bool(node.get("_master_instance"))
            if in_master and node.get("name"):
                master_node_names.add(node["name"])
            if node.get("adaptive"):
                if in_master or in_container:
                    raise LanguageError("E_ADAPTIVE", "/adaptive", "adaptive overrides currently require page-level widgets outside masters/panels/repeaters")
                for view_id, props in node["adaptive"].items():
                    if view_id not in view_ids:
                        raise LanguageError("E_ADAPTIVE", "/adaptive/" + str(view_id), f"Unknown adaptive view: {view_id}")
                    if not isinstance(props, dict) or set(props) - {"x", "y", "w", "h"}:
                        raise LanguageError("E_PROPERTY", "/adaptive/" + str(view_id), "adaptive overrides support x/y/w/h")
                    if any(type(v) not in (int, float) or not math.isfinite(v) or (k in {"w", "h"} and v < 0) for k, v in props.items()):
                        raise LanguageError("E_ADAPTIVE", "/adaptive/" + str(view_id), "adaptive geometry must be finite numeric values with nonnegative sizes")
                adaptive_overrides[node["name"]] = copy.deepcopy(node["adaptive"])
            for child in node.get("children", []):
                collect_native_metadata(child, in_master, in_container)
            for state in node.get("states", []):
                collect_native_metadata(state.get("root"), in_master, True)
            if isinstance(node.get("template"), dict):
                collect_native_metadata(node["template"], in_master, True)
            if node.get("_master_instance") and not any(m["id"] == node["_master_instance"] for m in master_plans):
                mid = node["_master_instance"]
                m_tree = copy.deepcopy(node)
                m_tree.pop("_master_instance")
                mw, mh = int(node["_w"]), int(node["_h"])
                layout_node(m_tree, 0, 0, mw, mh)
                def remove_slots(parent):
                    parent["children"] = [c for c in parent.get("children", []) if not c.get("_master_slot")]
                    for child in parent["children"]:
                        remove_slots(child)
                remove_slots(m_tree)
                em_m = emit_tree_to_axvg(m_tree, theme_dict, canvas_background=False, base_dir=base_dir)
                if em_m["dynamicPanels"] or em_m["repeaters"]:
                    raise LanguageError("E_MASTER", "/masters/" + str(mid), "RP/1 masters currently require primitive content; nested panels/repeaters are not supported")
                m_path = os.path.join(states_dir, f"master__{mid}.axvg.json")
                with open(m_path, "w", encoding="utf-8") as f:
                    json.dump(em_m["axvg"], f, ensure_ascii=False, indent=2)
                names = {c["name"] for c in em_m["flatChildren"]} | {n["name"] for n in em_m["nativeInputs"]}
                master_plans.append({"id": mid, "name": master_defs[mid].get("name", mid), "w": mw, "h": mh,
                    "axvgPath": m_path, "nativeInputs": em_m["nativeInputs"], "nativeStyles": em_m["nativeStyles"],
                    "interactions": [ix for ix in p_spec.get("interactions", []) if ix["trigger"] in names]})

        collect_native_metadata(root_main)
        p_axvg_path = os.path.join(out_dir, f"{p_slug}.axvg.json")
        p_spec_path = os.path.join(out_dir, f"{p_slug}.spec.json")
        with open(p_axvg_path, "w", encoding="utf-8") as f:
            json.dump(em_main["axvg"], f, ensure_ascii=False, indent=2)
        with open(p_spec_path, "w", encoding="utf-8") as f:
            json.dump(em_main["spec"], f, ensure_ascii=False, indent=2)

        page_scenes = []

        def container_stages(emitted, tag):
            panels, lists = [], []
            for dp in emitted["dynamicPanels"]:
                states = []
                for i, state in enumerate(dp["states"]):
                    state_prefix = state.get("prefix") or state["name"]
                    state_tag = f"{tag}__{dp['name']}__{state_prefix}"
                    canvas = state.get("canvas") or ({"w": 375, "h": 812} if state.get("device") else {"w": dp["w"], "h": dp["h"]})
                    entry = compile_stage(state["tree"], state_tag, canvas, device=state.get("device"), prefix=state_prefix,
                                          kind="panel-state", parent_scene=tag, panel=dp["name"], state=state["name"])
                    states.append({**entry, "name": state["name"], "prefix": state.get("prefix", state_tag)})
                panels.append({k: dp[k] for k in ("name", "x", "y", "w", "h")} | {"states": states})
            for rep in emitted.get("repeaters", []):
                row = compile_stage(rep["template"], f"{tag}__{rep['name']}__item", {"w": rep["w"], "h": rep["rowHeight"]},
                                    kind="repeater-template", parent_scene=tag, repeater=rep["name"])
                lists.append({k: rep[k] for k in ("name", "x", "y", "w", "h", "rowGap", "rowHeight", "pageSize", "model", "rows")} | {"item": row})
            return panels, lists

        def compile_stage(tree, tag, stage_canvas, device=None, prefix=None, kind="panel-state", parent_scene=None, **context):
            scene = {"id": tag, "page": p_name, "kind": kind, "scope": "container-local", "parentSceneId": parent_scene,
                     "canvas": stage_canvas, "status": "not-run", **context}
            page_scenes.append(scene)
            stage_tree = copy.deepcopy(tree)
            if kind == "modal":
                stage_tree.pop("isModal", None)
                stage_tree.pop("x", None)
                stage_tree.pop("y", None)
            ensure_unique_names(stage_tree, scope_prefix=tag)
            sw, sh = int(stage_canvas["w"]), int(stage_canvas["h"])
            measure_node(stage_tree, base_dir=base_dir, available_w=sw)
            layout_node(stage_tree, 0, 0, sw, sh)
            emitted = emit_tree_to_axvg(stage_tree, theme_dict, include_dynamic_panel_placeholders=False, base_dir=base_dir, canvas_background=False)
            preview = emit_tree_to_axvg(copy.deepcopy(stage_tree), theme_dict, include_dynamic_panel_placeholders=True, base_dir=base_dir, canvas_background=False)
            panels, repeaters = container_stages(emitted, tag)
            if device:
                emitted = compose_device_shell(emitted, prefix or tag, shell_name=device)
                preview = compose_device_shell(preview, prefix or tag, shell_name=device)
                sw, sh = emitted["device"]["w"], emitted["device"]["h"]
            axvg_path = os.path.join(states_dir, f"{tag}.axvg.json")
            spec_path = os.path.join(states_dir, f"{tag}.spec.json")
            _stable_tag = re.sub(r"-[0-9a-f]{8,}", "", str(tag))  # 去掉原生 hash 后缀，便于稳定引用
            png_path = os.path.join(states_dir, f"{_stable_tag}@2x.png")
            STATE_PREVIEWS.append({
                "page": str(tag).split("__")[0],
                "scene": str(tag),
                "stable": _stable_tag,
                "png": png_path,
                "panel": context.get("panel"),
                "state": context.get("state"),
                "repeater": context.get("repeater"),
                "modal": context.get("modal"),
                "viewport": {"w": int(stage_canvas["w"]), "h": int(stage_canvas["h"])},
                "content": {"w": int(stage_tree.get("_mw", sw)), "h": int(stage_tree.get("_mh", sh))},
            })
            with open(axvg_path, "w", encoding="utf-8") as f: json.dump(emitted["axvg"], f, ensure_ascii=False, indent=2)
            with open(spec_path, "w", encoding="utf-8") as f: json.dump(emitted["spec"], f, ensure_ascii=False, indent=2)
            render_flat_children_png(sw, sh, resolve_color("$surface", theme_dict), preview["flatChildren"], include_modal=False, scale=2).save(png_path)
            scene["audit"] = audit_prototype(stage_tree, preview, {
                "pageName": p_name, "language": "rp/1" if language_ir else None,
                "domain": p_domain, "theme": theme_name, "dynamicPanels": panels, "auditScope": "container-local",
                "repeaters": repeaters, "allMainWidgets": emitted["flatChildren"],
                "nativeInputs": emitted["nativeInputs"], "nativeStyles": emitted["nativeStyles"], "schemaWarnings": [],
            }, strict_audit=is_strict)
            scene.update({"axvgPath": axvg_path, "specPath": spec_path, "pngPath": png_path})
            compile_modal_scenes(stage_tree, tag)
            return {"sceneId": tag, "audit": scene["audit"], "axvgPath": axvg_path, "specPath": spec_path, "pngPath": png_path,
                    "widgetNames": [c["name"] for c in emitted["flatChildren"]], "nativeInputs": emitted["nativeInputs"], "nativeStyles": emitted["nativeStyles"],
                    "dynamicPanels": panels, "repeaters": repeaters}

        def compile_modal_scenes(tree, tag):
            for child in tree.get("children", []):
                if child.get("isModal"):
                    compile_stage(child, f"{tag}__{child['name']}__modal", {"w": child["_w"], "h": child["_h"]},
                                  kind="modal", parent_scene=tag, modal=child["name"])
                else:
                    compile_modal_scenes(child, tag)

        page_scene = {"id": p_slug, "page": p_name, "kind": "page-default", "scope": "page",
                      "canvas": {"w": cw, "h": ch}, "status": "not-run"}
        page_scenes.append(page_scene)
        dp_plans, repeater_plans = container_stages(em_main, p_slug)
        compile_modal_scenes(root_main, p_slug)
        preview_flat = list(em_prev["flatChildren"])
        if ink_sink is not None:
            _rows = []
            for _ch in preview_flat:
                if _ch.get("kind") not in ("text", "para") and not _ch.get("text"):
                    continue
                try:
                    _font, _tx, _ty, _ink = text_ink_geometry(dict(_ch))
                except Exception:
                    continue
                _rows.append({"name": _ch.get("name") or _ch.get("id"),
                              "box": [_ch.get("x"), _ch.get("y"), _ch.get("w"), _ch.get("h")],
                              "ink": [round(v, 1) for v in _ink],
                              "inkBottom": round(_ink[1] + _ink[3], 1),
                              "inkRight": round(_ink[0] + _ink[2], 1),
                              "safeNextY": round(_ink[1] + _ink[3] + max(2, int(round(float(_ch.get("size", 13)) * 0.5))), 1),
                              "safeNextX": round(_ink[0] + _ink[2] + max(2, int(round(float(_ch.get("size", 13)) * 0.3))), 1)})
            ink_sink.append({"page": p_name, "slug": p_slug, "widgets": _rows,
                             "canvas": {"w": cw, "h": ch},
                             "offset": {"x": int(em_main.get("device", {}).get("screenX", 0)),
                                        "y": int(em_main.get("device", {}).get("screenY", 0))}})

        out_w = em_main["device"]["w"] if em_main.get("device") else cw
        out_h = em_main["device"]["h"] if em_main.get("device") else ch
        bg_hex = "#FFFFFF" if em_main.get("device") else resolve_color(root_main.get("fill", "$bg"), theme_dict)
        img_2x = render_flat_children_png(out_w, out_h, bg_hex, preview_flat, include_modal=False, scale=2)
        p_prev_path = os.path.join(out_dir, f"{p_slug}@2x.png")
        img_2x.save(p_prev_path)
        img_1x = render_flat_children_png(out_w, out_h, bg_hex, preview_flat, include_modal=False, scale=1)
        dx = em_main["device"]["screenX"] if em_main.get("device") else 0
        dy = em_main["device"]["screenY"] if em_main.get("device") else 0
        img_struct = render_structure_overlay_png(img_1x, root_prev, em_main["dynamicPanels"], dx=dx, dy=dy)
        p_struct_path = os.path.join(out_dir, f"{p_slug}-structure.png")
        img_struct.save(p_struct_path)

        if idx == 0:
            p01 = os.path.join(out_dir, "01-preview.png")
            p02 = os.path.join(out_dir, "02-structure.png")
            img_2x.save(p01)
            img_struct.save(p02)
            all_previews["preview"] = p01
            all_previews["structure"] = p02

        all_previews[p_slug] = {"preview2x": p_prev_path, "structure": p_struct_path}
        p_interactions = [] if page_static else [ix for ix in p_spec.get("interactions", []) if ix["trigger"] not in master_node_names]

        p_plan = {
            "pageName": p_name,
            "slug": p_slug,
            "language": "rp/1" if language_ir else None,
            "theme": theme_name,
            "domain": p_domain,
            "static": page_static,
            "device": em_main.get("device"),
            "canvas": {"w": out_w, "h": out_h},
            "mainAxvgPath": p_axvg_path,
            "mainSpecPath": p_spec_path,
            "dynamicPanels": dp_plans,
            "repeaters": repeater_plans,
            "nativeInputs": em_main["nativeInputs"], "nativeStyles": em_main["nativeStyles"],
            "modalTargets": em_main["modalTargets"],
            "allMainWidgets": em_main["flatChildren"],
            "interactions": p_interactions,
            "masters": em_main["masterInstances"],
            "adaptiveOverrides": adaptive_overrides,
            "knownPageNames": known_page_names,
            "schemaWarnings": p_schema_warnings,
            "sourceSymbols": [s for s in language_ir["symbols"] if s["pageId"] == p_slug] if language_ir else [],
            "previews": {"preview2x": p_prev_path, "structure": p_struct_path},
        }
        page_scene["audit"] = audit_prototype(root_prev, em_prev, p_plan, strict_audit=is_strict)
        page_scene.update({"axvgPath": p_axvg_path, "specPath": p_spec_path, "pngPath": p_prev_path})
        p_audit = summarize_scene_audits(page_scenes, strict_audit=is_strict)
        p_plan["scenes"] = page_scenes
        p_plan["sceneCoverage"] = p_audit["sceneCoverage"]
        p_plan["audit"] = p_audit
        page_plans.append(p_plan)
        # 给本页每条 failure 注入 page 字段，便于跨页定位
        for _f in (p_audit.get("failures") or []):
            _f["page"] = p_name
        page_audits.append({
            "pageName": p_name,
            "slug": p_slug,
            "theme": theme_name,
            "domain": p_domain,
            "device": em_main.get("device"),
            "canvas": {"w": out_w, "h": out_h},
            "static": page_static,
            **p_audit,
        })

    # Stitch multi-page contact sheet and panel/repeater states sheet for single-shot visual inspection
    page_sheet_items = [
        {"label": f"[{pp['slug']}] {pp['pageName']}", "path": pp["previews"]["preview2x"]}
        for pp in page_plans
        if isinstance(pp.get("previews"), dict) and pp["previews"].get("preview2x")
    ]
    if page_sheet_items:
        pages_sheet_path = os.path.join(out_dir, "pages-sheet.png")
        if render_contact_sheet_png(page_sheet_items, pages_sheet_path, max_cols=4, max_thumb_h=640, max_thumb_w=460, title="Pages Overview"):
            all_previews["contactSheet"] = pages_sheet_path
    if STATE_PREVIEWS:
        def _fmt_state_sheet_label(sp):
            pg = str(sp.get("page") or "page")
            if sp.get("panel") and sp.get("state"):
                clean_p = re.sub(r"-[0-9a-f]{6,}", "", str(sp["panel"]))
                if clean_p.startswith(f"{pg}__"):
                    clean_p = clean_p[len(pg) + 2:]
                vp, content = sp.get("viewport", {}), sp.get("content", {})
                dimensions = f" · {vp.get('w')}×{vp.get('h')} / content {content.get('h')}px" if vp else ""
                return f"[{pg}] {clean_p} : {sp['state']}{dimensions}"
            if sp.get("repeater"):
                clean_r = re.sub(r"-[0-9a-f]{6,}", "", str(sp["repeater"]))
                if clean_r.startswith(f"{pg}__"):
                    clean_r = clean_r[len(pg) + 2:]
                return f"[{pg}] {clean_r} (item)"
            if sp.get("modal"):
                clean_m = re.sub(r"-[0-9a-f]{6,}", "", str(sp["modal"]))
                return f"[{pg}] {clean_m} (modal)"
            return sp.get("stable") or sp.get("scene") or "state"

        state_sheet_items = [
            {"label": _fmt_state_sheet_label(sp), "path": sp.get("png")}
            for sp in STATE_PREVIEWS
            if sp.get("png") and not (
                re.sub(r"-[0-9a-f]{6,}", "", str(sp.get("panel") or "")).endswith("_fill")
                and re.fullmatch(r"s\d+", str(sp.get("state") or ""))
            )
        ]
        if state_sheet_items:
            states_sheet_path = os.path.join(out_dir, "states-sheet.png")
            if render_contact_sheet_png(state_sheet_items, states_sheet_path, max_cols=4, max_thumb_h=480, max_thumb_w=420, title="Container States Overview"):
                all_previews["statesSheet"] = states_sheet_path

    overall_ok = all(pa["ok"] for pa in page_audits)
    overall_structural_ok = all(pa["structural_ok"] for pa in page_audits)
    overall_aesthetic_ok = all(pa["aesthetic_ok"] for pa in page_audits)
    all_warnings = []
    # 光效样式（gradient/shadow/aurora/noise）会被"光效层"渲染成嵌入位图，再以 ImageBox 写入原生，
    # 因此不是"预览专属"；只有 backdropBlur 采样的是静态背景，叠在动态内容上会失真，需要提示。
    _backdrop_hits = {}
    _misplaced = {}

    def _scan_backdrop(node, page_name, parent_layout=None):
        if isinstance(node, dict):
            if parent_layout:
                node.setdefault("_layoutParent", parent_layout)
            if node.get("backdropBlur"):
                _backdrop_hits.setdefault(page_name, 0)
                _backdrop_hits[page_name] += 1
            if node.get("after") or node.get("alignX"):
                _constraint_parent = node.get("_layoutParent")
                if _constraint_parent and _constraint_parent != "stack":
                    _misplaced.setdefault(page_name, 0)
                    _misplaced[page_name] += 1
            _own_layout = node.get("layout")
            for key, value in node.items():
                _scan_backdrop(value, page_name, _own_layout if isinstance(value, dict) or isinstance(value, list) else None)
        elif isinstance(node, list):
            for value in node:
                _scan_backdrop(value, page_name, parent_layout)

    for _pg in (spec_data.get("pages") or []) if isinstance(spec_data, dict) else []:
        if isinstance(_pg, dict):
            _scan_backdrop(_pg.get("root"), _pg.get("name") or _pg.get("id") or "page")
    for _page_name, _cnt in _misplaced.items():
        all_warnings.append(
            f"[{_page_name}] constraint_outside_stack: {_cnt} 个元件在非 stack 容器里用了 after/alignX，"
            "这两个约束只对 layout:\"stack\" 的父容器生效；flow 容器请用 row/column 顺序或 gap")
    for _page_name, _cnt in _backdrop_hits.items():
        all_warnings.append(
            f"[{_page_name}] backdrop_blur_static: {_cnt} 个元件使用 backdropBlur；原生以静态背景采样成图，"
            "叠在会变化的内容上会失真，改用半透明实色更稳")
    for pa in page_audits:
        for w_msg in pa.get("warnings", []):
            all_warnings.append(f"[{pa['pageName']}] {w_msg}")

    first_page = page_plans[0]
    compile_plan = {
        "name": spec_data.get("name", first_page["pageName"]),
        "domain": domain,
        "theme": theme_name,
        "static": is_static,
        "strictAudit": is_strict,
        "pageCount": len(page_plans),
        "pages": page_plans,
        "masters": master_plans,
        "adaptiveViews": copy.deepcopy(spec_data.get("adaptiveViews") or []),
        # 兼容单页字段读取
        "pageName": first_page["pageName"],
        "canvas": first_page["canvas"],
        "mainAxvgPath": first_page["mainAxvgPath"],
        "mainSpecPath": first_page["mainSpecPath"],
        "dynamicPanels": first_page["dynamicPanels"],
        "nativeInputs": first_page["nativeInputs"], "nativeStyles": first_page["nativeStyles"],
        "modalTargets": first_page["modalTargets"],
        "allMainWidgets": first_page["allMainWidgets"],
        "interactions": first_page["interactions"],
        "previews": all_previews,
    }
    # 顶层 metrics 由 pages 按物理面积/总检查项数精确加权聚合（P3-2）
    _SUM_KEYS = (
        "text_overlap_count", "text_clip_count", "missing_glyph_count",
        "kinsoku_violation_count", "container_overflow_count", "box_overlap_count",
        "declared_position_mismatch_count",
        "duplicate_name_count", "interaction_dangling_targets",
    )
    agg_metrics = {}
    for _k in _SUM_KEYS:
        agg_metrics[_k] = sum(int(pa["metrics"].get(_k, 0) or 0) for pa in page_audits)
    agg_metrics["alignment_error_px"] = max((pa["metrics"].get("alignment_error_px", 0.0) or 0.0) for pa in page_audits) if page_audits else 0.0

    # 按总检查项数/总节点数加权聚合百分比指标（避免大画布页与小卡片页简单算术平均失真）
    tot_sp_pass = sum(int((pa.get("_weights") or {}).get("spacing_passed", 0)) for pa in page_audits)
    tot_sp_all = sum(int((pa.get("_weights") or {}).get("spacing_total", 0)) for pa in page_audits)
    agg_metrics["spacing_compliance_pct"] = round(100.0 * tot_sp_pass / tot_sp_all, 2) if tot_sp_all > 0 else None

    tot_fn_pass = sum(int((pa.get("_weights") or {}).get("font_passed", 0)) for pa in page_audits)
    tot_fn_all = sum(int((pa.get("_weights") or {}).get("font_total", 0)) for pa in page_audits)
    agg_metrics["font_compliance_pct"] = round(100.0 * tot_fn_pass / tot_fn_all, 2) if tot_fn_all > 0 else None

    tot_sem_nodes = sum(int((pa.get("_weights") or {}).get("semantic_nodes", 0)) for pa in page_audits)
    tot_grp_nodes = sum(int((pa.get("_weights") or {}).get("grouped_nodes", 0)) for pa in page_audits)
    tot_all_nodes = sum(int((pa.get("_weights") or {}).get("total_nodes", 0)) for pa in page_audits)
    tot_group_nodes = sum(int((pa.get("_weights") or {}).get("group_total", 0)) for pa in page_audits)
    agg_metrics["semantic_naming_pct"] = round(100.0 * tot_sem_nodes / tot_all_nodes, 2) if tot_all_nodes > 0 else None
    agg_metrics["group_coverage_pct"] = round(100.0 * tot_grp_nodes / tot_group_nodes, 2) if tot_group_nodes > 0 else None

    four_applicable = sum(pa.get("coverage", {}).get("fourState", {}).get("applicable", 0) for pa in page_audits)
    four_passed = sum(pa.get("coverage", {}).get("fourState", {}).get("passed", 0) for pa in page_audits)
    agg_metrics["four_state_coverage_pct"] = round(100.0 * four_passed / four_applicable, 2) if four_applicable else None

    # 留白率：按各页画布像素面积 (canvas_area) 加权，并同時输出跨页留白率区间 [min, max]
    tot_area = sum(float((pa.get("_weights") or {}).get("canvas_area", 0.0)) for pa in page_audits)
    tot_fg = sum(float((pa.get("_weights") or {}).get("fg_pixels", 0.0)) for pa in page_audits)
    _ws_vals = [float(pa["metrics"].get("whitespace_ratio_pct", 0.0) or 0.0) for pa in page_audits]
    if tot_area > 0:
        agg_metrics["whitespace_ratio_pct"] = round(100.0 * (1.0 - tot_fg / tot_area), 2)
    else:
        agg_metrics["whitespace_ratio_pct"] = round(sum(_ws_vals) / len(_ws_vals), 2) if _ws_vals else 0.0
    agg_metrics["whitespace_ratio_range"] = [round(min(_ws_vals), 2), round(max(_ws_vals), 2)] if _ws_vals else [0.0, 0.0]

    agg_metrics["color_count"] = max((int(pa["metrics"].get("color_count", 0) or 0) for pa in page_audits), default=0)
    agg_metrics["duplicate_names"] = [n for pa in page_audits for n in (pa["metrics"].get("duplicate_names") or [])]
    for pa in page_audits:
        pa.pop("_weights", None)
    # 结构门禁：全部页通过才算通过（与 overall_structural_ok 语义一致）
    agg_structural = {k: all(pa["structural_gates"].get(k, True) for pa in page_audits) for k in (page_audits[0]["structural_gates"] if page_audits else {})}
    agg_aesthetic = {k: all(pa["aesthetic_gates"].get(k, True) for pa in page_audits) for k in (page_audits[0]["aesthetic_gates"] if page_audits else {})}
    agg_failures = [f for pa in page_audits for f in (pa.get("failures") or [])]
    combined_audit = {
        "ok": overall_ok,
        "structural_ok": overall_structural_ok,
        "aesthetic_ok": overall_aesthetic_ok,
        "strict_audit": is_strict,
        "static": is_static,
        "warnings": all_warnings,
        "statePreviews": list(STATE_PREVIEWS),
        "pageCount": len(page_audits),
        "metrics": agg_metrics,
        "structural_gates": agg_structural,
        "aesthetic_gates": agg_aesthetic,
        "gates": {**agg_aesthetic, **agg_structural},
        "failures": agg_failures,
        "pages": page_audits,
    }
    all_scenes = [scene for page in page_plans for scene in page.get("scenes", [])]
    scene_summary = summarize_scene_audits(all_scenes, strict_audit=is_strict)
    for key in ("scenes", "sceneCoverage", "metricScope"):
        combined_audit[key] = scene_summary[key]
    combined_audit["coverage"] = scene_summary["coverage"]
    compile_plan["scenes"] = all_scenes
    compile_plan["sceneCoverage"] = scene_summary["sceneCoverage"]
    compile_plan["audit"] = combined_audit
    compile_plan["sourceSpec"] = raw_source_spec
    if heal_enabled:
        heal_summary = {
            "mode": str(auto_heal),
            "healedCount": len(auto_heal_changes),
            "changes": auto_heal_changes,
            "needsDecision": [f for f in agg_failures if f.get("gate") not in ("no_text_clip", "no_container_overflow")],
        }
        compile_plan["autoHeal"] = heal_summary
        combined_audit["autoHeal"] = heal_summary
    if source_path:
        compile_plan["sourcePath"] = source_path
    if language_ir:
        compile_plan["language"] = "rp/1"
        compile_plan["variables"] = language_ir["variables"]
        compile_plan["sourceMap"] = language_ir["symbols"]
        compile_plan["semanticHash"] = language_ir["semanticHash"]

    plan_path = os.path.join(out_dir, "compile-plan.json")
    audit_path = os.path.join(out_dir, "audit-report.json")
    with open(plan_path, "w", encoding="utf-8") as f:
        json.dump(compile_plan, f, ensure_ascii=False, indent=2)
    with open(audit_path, "w", encoding="utf-8") as f:
        json.dump(combined_audit, f, ensure_ascii=False, indent=2)
    return {
        "ok": overall_ok,
        "structural_ok": overall_structural_ok,
        "aesthetic_ok": overall_aesthetic_ok,
        "warnings": all_warnings,
        "outDir": out_dir,
        "theme": theme_name,
        "static": is_static,
        "pageCount": len(page_plans),
        "planPath": plan_path,
        "auditPath": audit_path,
        "previews": all_previews,
        "audit": combined_audit,
    }


def run_selftest():
    import tempfile
    results = []
    # 1~3. Web 旗舰工作台三套主题
    for th in ("enterprise-light", "modern-dark", "cobalt-pro"):
        with tempfile.TemporaryDirectory(prefix=f"proto-selftest-{th}-") as td:
            res = compile_prototype_bundle(td, theme_name=th)
            if not res["ok"]:
                raise RuntimeError(f"Selftest failed on theme {th}: {json.dumps(res['audit'], ensure_ascii=False)}")
            results.append({"preset": "web-dashboard", "theme": th, "metrics": res["audit"]["metrics"]})
    # 4~5. Mobile 多页带壳两套主题 (mobile-lowfi / mobile-hifi)
    for mob_th in ("mobile-lowfi", "mobile-hifi"):
        with tempfile.TemporaryDirectory(prefix=f"proto-selftest-{mob_th}-") as td:
            mob_spec = build_mobile_lostfound_spec()
            res_mob = compile_spec_bundle(mob_spec, td, theme_override=mob_th)
            if not res_mob["ok"]:
                raise RuntimeError(f"Selftest failed on {mob_th}: {json.dumps(res_mob['audit'], ensure_ascii=False)}")
            results.append({
                "preset": "mobile-lostfound",
                "theme": mob_th,
                "pageCount": res_mob["pageCount"],
                "metrics": res_mob["audit"]["metrics"],
            })
    # 6. 自定义小画布玩具页 (375×400, 非令牌间距 gap=5)：验证两级门禁默认通过并发出审美告警，--strict-audit 下拦截
    toy_spec = {
        "name": "Toy Custom Primitives Test",
        "theme": "mobile-lowfi",
        "static": True,
        "pages": [
            {
                "name": "测试页",
                "slug": "toy-page",
                "canvas": {"w": 375, "h": 400},
                "root": {
                    "type": "box",
                    "name": "grp-toy-root",
                    "layout": "column",
                    "w": 375,
                    "h": 400,
                    "padding": 16,
                    "gap": 5,
                    "fill": "$bg",
                    "isGroup": True,
                    "bgName": "bg-toy-root",
                    "children": [
                        {"type": "label", "name": "txt-toy-title", "text": "自定义原语与两级门禁自检", "fontSize": 16, "fontWeight": 700, "color": "$ink"},
                        {"type": "button", "name": "btn-toy-act", "text": "确定提交", "variant": "primary", "w": 120, "h": 36, "radius": 8},
                    ],
                },
            }
        ],
    }
    with tempfile.TemporaryDirectory(prefix="proto-selftest-toy-") as td:
        res_toy = compile_spec_bundle(toy_spec, td, strict_audit=False)
        if not res_toy["ok"] or not res_toy["structural_ok"] or not res_toy["warnings"]:
            raise RuntimeError(f"Selftest failed on toy-page default mode: {json.dumps(res_toy['audit'], ensure_ascii=False)}")
        res_toy_strict = compile_spec_bundle(toy_spec, td, strict_audit=True)
        if res_toy_strict["ok"]:
            raise RuntimeError("Selftest failed: toy-page with gap=5 should fail under strict_audit=True")
        results.append({
            "preset": "custom-primitives-toy",
            "theme": "mobile-lowfi",
            "pageCount": 1,
            "warningsCount": len(res_toy["warnings"]),
            "strictBlocked": not res_toy_strict["ok"],
            "metrics": res_toy["audit"]["metrics"],
        })
    # 7. 验证 dump-spec --preset web-dashboard 导出的 spec 可直接通过 compile_spec_bundle 零错误编译 (P0-3)
    with tempfile.TemporaryDirectory(prefix="proto-selftest-webspec-") as td:
        web_spec = build_web_dashboard_spec()
        res_web_spec = compile_spec_bundle(web_spec, td)
        if not res_web_spec["ok"] or not res_web_spec["structural_ok"] or not res_web_spec["aesthetic_ok"]:
            raise RuntimeError(f"Selftest failed on build_web_dashboard_spec: {json.dumps(res_web_spec['audit'], ensure_ascii=False)}")
        results.append({
            "preset": "web-dashboard-spec-roundtrip",
            "theme": res_web_spec["theme"],
            "pageCount": res_web_spec["pageCount"],
            "metrics": res_web_spec["audit"]["metrics"],
        })
    return {"ok": True, "themesTested": len(results), "results": results}


def build_web_dashboard_spec(title_override=None):
    """导出 web-dashboard 预设的完整声明式 spec.json 模板（含高层 sidebar/topbar/kpi-card、三态趋势图、四态表格、新建弹窗与完整交互）。"""
    title_str = title_override or "菜品与实时库存管理工作台"
    trend_states = [
        {
            "name": "orders",
            "label": "订单趋势",
            "prefix": "orders",
            "root": expand_chart_state(
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
            "prefix": "revenue",
            "root": expand_chart_state(
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
            "prefix": "category",
            "root": expand_chart_state(
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
    table_four = expand_table_four_states(w=1184, h=336)
    table_states = [
        {"name": "default", "label": "默认列表态", "prefix": "tbl-def", "root": table_four["default"]},
        {"name": "empty", "label": "空数据态", "prefix": "tbl-emp", "root": table_four["empty"]},
        {"name": "loading", "label": "骨架加载态", "prefix": "tbl-load", "root": table_four["loading"]},
        {"name": "error", "label": "接口异常态", "prefix": "tbl-err", "root": table_four["error"]},
    ]
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
    modal_node = expand_modal_new_dish(canvas_w=1440, canvas_h=900)
    return {
        "name": title_str,
        "domain": "web",
        "theme": "enterprise-light",
        "static": False,
        "pages": [{
            "name": "Page 1",
            "slug": "dashboard",
            "canvas": {"w": 1440, "h": 900},
            "root": {
                "type": "box",
                "name": "Page 1",
                "layout": "stack",
                "w": 1440,
                "h": 900,
                "fill": "$bg",
                "isGroup": False,
                "children": [
                    {
                        "type": "box",
                        "name": "grp-app-shell",
                        "layout": "row",
                        "x": 0,
                        "y": 0,
                        "w": 1440,
                        "h": 900,
                        "gap": 0,
                        "isGroup": True,
                        "children": [
                            {
                                "type": "sidebar",
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
                            },
                            {
                                "type": "box",
                                "name": "grp-main-area",
                                "layout": "column",
                                "w": 1232,
                                "h": 900,
                                "gap": 0,
                                "isGroup": True,
                                "children": [
                                    {
                                        "type": "topbar",
                                        "id": "main",
                                        "w": 1232,
                                        "h": 64,
                                        "title": title_str,
                                        "subtitle": "支持多维趋势切换、表格四态预览 (Default / Empty / Loading / Error) 与新建菜品表单非空校验",
                                    },
                                    {
                                        "type": "box",
                                        "name": "grp-content-body",
                                        "layout": "column",
                                        "w": 1232,
                                        "h": 836,
                                        "padding": [16, 24],
                                        "gap": 16,
                                        "isGroup": True,
                                        "children": [
                                            {
                                                "type": "box",
                                                "name": "grp-kpi-row",
                                                "layout": "row",
                                                "w": 1184,
                                                "h": 108,
                                                "gap": 16,
                                                "isGroup": True,
                                                "children": [
                                                    {"type": "kpi-card", "id": "dishes", "label": "在售菜品总数", "value": "58", "trend": "+4 本周上新", "trendType": "success", "subtitle": "含 12 款多规格招牌菜", "accent": "$brand", "h": 108},
                                                    {"type": "kpi-card", "id": "orders", "label": "今日实时订单", "value": "1,480", "trend": "+14.2%", "trendType": "success", "subtitle": "堂食 890 单 · 外卖 590 单", "accent": "$accent", "h": 108},
                                                    {"type": "kpi-card", "id": "revenue", "label": "今日实收流水", "value": "¥ 96,420", "trend": "+18.6%", "trendType": "success", "subtitle": "客单价均值 ¥ 65.15", "accent": "$success", "h": 108},
                                                    {"type": "kpi-card", "id": "warn", "label": "库存预警/售罄", "value": "2 款", "trend": "需及时补货", "trendType": "warning", "subtitle": "杨枝甘露(5份) · 酒酿圆子(0份)", "accent": "$warning", "h": 108},
                                                ],
                                            },
                                            middle_row,
                                            table_section,
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                    modal_node,
                ],
            },
            "interactions": [
                {
                    "trigger": "tab-trend-orders",
                    "description": "切换到订单趋势图表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "SwitchTrendOrders", "actions": [{"type": "set-panel-state", "target": "panel-trend", "state": "orders"}, {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 订单趋势"}]}]}],
                },
                {
                    "trigger": "tab-trend-revenue",
                    "description": "切换到营收趋势图表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "SwitchTrendRevenue", "actions": [{"type": "set-panel-state", "target": "panel-trend", "state": "revenue"}, {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 营收趋势"}]}]}],
                },
                {
                    "trigger": "tab-trend-category",
                    "description": "切换到品类占比图表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "SwitchTrendCategory", "actions": [{"type": "set-panel-state", "target": "panel-trend", "state": "category"}, {"type": "set-text", "target": "txt-trend-card-title", "text": "经营核心指标分时分析 · 品类占比"}]}]}],
                },
                {
                    "trigger": "btn-state-default",
                    "description": "切换表格到默认数据列表态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableDefault", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "default"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：默认列表态 (Default)"}]}]}],
                },
                {
                    "trigger": "btn-state-empty",
                    "description": "切换表格到空数据态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableEmpty", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "empty"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：空数据态 (Empty)"}]}]}],
                },
                {
                    "trigger": "btn-state-loading",
                    "description": "切换表格到骨架屏加载态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableLoading", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "loading"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：骨架加载态 (Loading)"}]}]}],
                },
                {
                    "trigger": "btn-state-error",
                    "description": "切换表格到接口异常态",
                    "events": [{"event": "OnClick", "cases": [{"name": "ShowTableError", "actions": [{"type": "set-panel-state", "target": "panel-table", "state": "error"}, {"type": "set-text", "target": "txt-state-indicator", "text": "当前视图：接口异常态 (Error)"}]}]}],
                },
            ],
        }],
    }

def _build_layout_diagnostics(bundle_res, ir):
    by_name = {}
    by_id = {}
    for sym in (ir or {}).get("symbols", []):
        src = sym.get("source") or {}
        best_ptr = src.get("parameterPointer") or sym.get("pointer") or src.get("macroPointer")
        if best_ptr:
            if sym.get("name"):
                by_name[sym["name"]] = best_ptr
            if sym.get("id"):
                by_id[sym["id"]] = best_ptr
                short_id = sym["id"].rsplit("/", 1)[-1]
                by_id.setdefault(short_id, best_ptr)
    fails = []
    raw_failures = (
        bundle_res.get("failures")
        or (bundle_res.get("audit") or {}).get("failures")
        or []
    )
    for _f in raw_failures:
        resolved_ptr = "/"
        if isinstance(_f, dict):
            if _f.get("pointer") and _f["pointer"] != "/":
                resolved_ptr = _f["pointer"]
            else:
                for k in ("symbolId", "widget", "widget_a", "child", "widget_b", "parent"):
                    cand = _f.get(k)
                    if isinstance(cand, str) and cand:
                        if cand in by_id:
                            resolved_ptr = by_id[cand]
                            break
                        if cand in by_name:
                            resolved_ptr = by_name[cand]
                            break
        _readable = _f.get("message") if isinstance(_f, dict) else None
        _msg = _f if isinstance(_f, str) else json.dumps(_f, ensure_ascii=False)
        _entry = {
            "severity": "error",
            "code": (_f.get("code") if isinstance(_f, dict) and _f.get("code") else "E_LAYOUT"),
            "pointer": resolved_ptr,
            "pageName": (_f.get("page") if isinstance(_f, dict) else None),
            "message": _readable or _msg,
        }
        if _readable:
            _entry["data"] = _f
        fails.append(_entry)
    return fails
