"""Single-source self-describing capability matrix generated directly from RP/1 compiler tables."""
import json
from pathlib import Path

from .core import (
    ACTION_PROPS,
    EVENTS,
    EVENT_SHORTHANDS,
    FUNCTION_DEFS,
    MACRO_PROPS,
    NODE_PROPS,
    SHORTHAND_NODE_KINDS,
)

ROOT_DIR = Path(__file__).resolve().parents[2]
SURFACE_CAPS_PATH = ROOT_DIR / "scripts" / "surface-capabilities.json"
PACKAGE_JSON_PATH = ROOT_DIR / "package.json"

SYNTAX_RULES = [
    {
        "id": "inline-expressions",
        "title": "内联表达式与 '=' 字面量消歧",
        "rule": "文本以 '=' 开头且紧跟合法表达式起始符（字母/下划线/$/@/!/数字/括号/引号）时按表达式求值；单独的 '='（如计算器等号键）或 '= 合计' 等非表达式前缀自动按字面文本保留。",
        "escape": "若需强制输出形如 '=var.x' 的字面文本，使用 '\\=var.x' 转义；模板插值使用 '${...}'。",
        "examples": [
            "button #eq \"=\"  -> 字面文本 '='",
            "label #sum \"= 合计\"  -> 字面文本 '= 合计'",
            "label #out \"=concat(left(var.name, 4), '!')\"  -> 表达式求值",
            "label #lit \"\\=var.x\"  -> 字面文本 '=var.x'",
        ],
    },
    {
        "id": "explicit-conversions",
        "title": "显式类型转换",
        "rule": "运行期文本与数字混算须显式使用 number(...) 或 text(...)；concat(...) 会自动将非文本参数转为文本。",
        "examples": ["set $total = number(@qty_input) * 10", "set @badge = concat('共 ', var.total, ' 元')"],
    },
    {
        "id": "imperative-control-flow",
        "title": "事件块命令式控制流",
        "rule": "同一事件块（+onClick: 等）支持自由混排前置动作、连续独立 if、嵌套 if/elif/else（行尾冒号可选）以及 wait 后接续体。",
        "examples": ["+onClick:\n  set $tries = $tries + 1\n  if $tries >= 3:\n    set @msg = \"已达上限\""],
    },
    {
        "id": "transaction-guards",
        "title": "带前置守卫的数据事务",
        "rule": "规则/事务中的前置守卫未通过时保持变量与中继器数据零变更；全部守卫通过后原子提交副作用。",
        "examples": ["rule submit_order: guards + effect(data-update / variables / feedback)"],
    },
]

ADDRESSING_RULES = {
    "logicalId": "同页唯一短 ID 可直接引用（如 btn、status）；跨页或歧义时使用页面限定逻辑 ID（page/id 或 page/panel/state/id）。",
    "repeaterRow": {
        "canonical": "{ action: 'click', target: 'pick', rowIndex: 0 }",
        "acceptedShorthands": [
            "target: 'pick[0]'",
            "target: 'pick[rowIndex=0]'",
            "target: 'page/items/item[rowIndex=0]/pick'",
            "target: 'items[0]/pick'",
            "target: 'items/0/pick'",
        ],
        "note": "rowIndex 从 0 开始按当前可见行视觉顺序计数（筛选/排序/分页后自动跟随可见行）。",
    },
    "nativeReferences": {
        "variable": "var.name 或 $name（声明于顶层 var / variables）",
        "widget": "@widgetId 或 widget.widgetId（属性：.text / .value / .checked / .state / .x / .y / .width / .height）",
        "repeaterField": "item.field（仅在中继器行模板或 where 谓词内有效）",
    },
}

RECIPE_ROUTER = [
    {"need": "带加减乘除与状态机的交互计算器", "call": {"tool": "prototype_recipe", "arguments": {"recipe": "native-calculator", "includeSource": True}}},
    {"need": "列表与详情联动（中继器与绑定）", "call": {"tool": "prototype_recipe", "arguments": {"recipe": "list-detail", "includeSource": True}}},
    {"need": "多步表单校验与交互反馈", "call": {"tool": "prototype_recipe", "arguments": {"recipe": "step-form", "includeSource": True}}},
    {"need": "查看全部可运行模板清单", "call": {"tool": "prototype_recipe", "arguments": {}}},
    {"need": "高自由度视觉画布项目（Studio）", "call": {"tool": "studio_describe", "arguments": {"topic": "workflow"}}},
]

TOOL_ROUTER = [
    {"intent": "查函数签名/语法/寻址/视觉属性能力", "call": {"tool": "diagnose_prototype", "arguments": {"mode": "capabilities", "topic": "summary"}}},
    {"intent": "批量测试多个表达式求值（不 fail-fast）", "call": {"tool": "diagnose_prototype", "arguments": {"expressions": ["left('hello', 2)", "round(2.5)"]}}},
    {"intent": "静态体检整份 RP/1 源码（一次吐出全部错误）", "call": {"tool": "diagnose_prototype", "arguments": {"rp1": "..."}}},
    {"intent": "生成原生 .rp 原型并看渲染总览图", "call": {"tool": "generate_prototype", "arguments": {"rp1": "...", "output": "demo.rp", "includeImage": True}}},
    {"intent": "无头 Chrome 真机点击/输入/中继器/断言验收", "call": {"tool": "verify_prototype", "arguments": {"rp": "demo.rp", "steps": []}}},
    {"intent": "最小源码改稿（自动三方合并与缓存加速）", "call": {"tool": "revise_prototype", "arguments": {"source": "demo.rp1", "rp": "demo.rp", "operations": [{"op": "replace", "target": "home/title", "property": "text", "value": "新标题"}]}}},
]


def _load_surface_capabilities():
    return json.loads(SURFACE_CAPS_PATH.read_text(encoding="utf-8"))


def _load_version():
    return json.loads(PACKAGE_JSON_PATH.read_text(encoding="utf-8"))["version"]


def build_capabilities_response(topic=None, query=None, limit=None):
    surface = _load_surface_capabilities()
    version = _load_version()
    q = (query or "").strip().lower()
    all_props = surface["properties"]
    filtered_props = [
        entry for entry in all_props
        if not q or q in entry["property"].lower() or q in entry.get("detail", "").lower()
    ]
    filtered_funcs = [
        fn for fn in FUNCTION_DEFS
        if not q
        or q in fn["name"].lower()
        or q in fn["signature"].lower()
        or q in fn["description"].lower()
        or any(q in a.lower() for a in fn.get("aliases", []))
    ]
    if limit is not None and isinstance(limit, int) and limit >= 0:
        filtered_props = filtered_props[:limit]
        filtered_funcs = filtered_funcs[:limit]

    effective_topic = (topic or ("properties" if q else "summary")).strip().lower()
    base = {
        "ok": True,
        **{k: v for k, v in surface.items() if k != "properties"},
        "version": version,
        "topic": effective_topic,
        "availableTopics": ["summary", "functions", "syntax", "addressing", "properties", "recipes", "all"],
        # Keep top-level properties for full backwards compatibility with callers/tests.
        "properties": filtered_props,
    }

    if effective_topic == "properties":
        return base

    if effective_topic == "functions":
        base["functions"] = filtered_funcs
        base["functionCount"] = len(FUNCTION_DEFS)
        return base

    if effective_topic == "syntax":
        base["syntaxRules"] = SYNTAX_RULES
        base["events"] = sorted(EVENTS)
        base["eventShorthands"] = dict(EVENT_SHORTHANDS)
        return base

    if effective_topic == "addressing":
        base["addressing"] = ADDRESSING_RULES
        return base

    if effective_topic == "recipes":
        base["recipeRouter"] = RECIPE_ROUTER
        base["toolRouter"] = TOOL_ROUTER
        return base

    if effective_topic == "summary":
        base["functionSignatures"] = [fn["signature"] for fn in FUNCTION_DEFS]
        base["nodeKinds"] = sorted(set(NODE_PROPS) | set(SHORTHAND_NODE_KINDS))
        base["macros"] = sorted(MACRO_PROPS)
        base["actions"] = sorted(ACTION_PROPS)
        base["syntaxHighlights"] = [{"id": s["id"], "rule": s["rule"]} for s in SYNTAX_RULES]
        base["addressing"] = ADDRESSING_RULES["repeaterRow"]
        base["toolRouter"] = TOOL_ROUTER
        return base

    # effective_topic == "all" or fallback
    base["functions"] = filtered_funcs
    base["nodeKinds"] = sorted(set(NODE_PROPS) | set(SHORTHAND_NODE_KINDS))
    base["macros"] = sorted(MACRO_PROPS)
    base["actions"] = sorted(ACTION_PROPS)
    base["events"] = sorted(EVENTS)
    base["eventShorthands"] = dict(EVENT_SHORTHANDS)
    base["syntaxRules"] = SYNTAX_RULES
    base["addressing"] = ADDRESSING_RULES
    base["recipeRouter"] = RECIPE_ROUTER
    base["toolRouter"] = TOOL_ROUTER
    return base
