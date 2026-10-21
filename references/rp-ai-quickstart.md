# RP/1：AI 生成原型速查

先表达页面、数据和交互，用 `check` 确认，再生成原型。`rp/1` 默认输出可编辑的原生 RP9 工程；生成不需要启动 GUI，原生行为验收才需要 Axure。

## 从哪里开始

```sh
node scripts/proto.mjs check --spec source.json
node scripts/proto.mjs generate --spec source.json --out-dir bundle --out-rp prototype.rp
node scripts/proto.mjs inspect --spec source.json
node scripts/proto.mjs explain --spec source.json --target home/status
node scripts/proto.mjs explore --spec source.json --max-depth 3 --max-states 48
node scripts/proto.mjs complete --spec source.json --pointer /pages/0/root
```

命令中的 `scripts/` 相对于 Skill 根目录 `<local-path>`。输出使用新路径，已有 `.rp` 和源码不会被覆盖。`explore` 是有预算的参考执行，宿主行为须另外验证。

## 最小可运行源码

```json
{
  "language": "rp/1", "target": 9, "name": "最小示例",
  "theme": "mobile-lowfi", "domain": "mobile",
  "variables": {"count": {"type": "number", "value": 0}},
  "pages": [{
    "id": "home", "name": "首页", "canvas": {"w": 375, "h": 812},
    "root": {"column": "root", "w": "fill", "h": "fill", "padding": 24, "gap": 16, "children": [
      {"label": "status", "text": "已点击 ${$count} 次", "w": "fill", "h": 24},
      {"button": "add", "text": "加一", "w": "fill", "h": 40,
       "onClick": {"set": {"$count": "=$count + 1"}}}
    ]}
  }]
}
```

这份程序只有页面内容，没有手机壳。`static:true` 或生成时 `--no-interactions` 用于明确不需要交互的交付。

## 高频写法

| 意图 | 写法 |
| --- | --- |
| 元件与容器 | `{"button":"save","text":"保存"}`、`{"column":"body","children":[]}`；标准 `type/id` 保留 |
| 模板文字 | `"姓名：${param.person.name}"`、`"库存 ${$count}"`；纯表达式用 `"=$count + 1"` |
| 写全局变量 | `{"set":{"$count":1}}` 或 `{"set-variable":"count","value":1}` |
| 写元件文字 | `{"set":{"@status":"已保存"}}`；裸名 `status` 同样指元件 |
| 切换面板 | `{"state":["receipt","done"]}` |
| 显隐 | `{"show":"tip"}`、`{"hide":"tip"}`、`{"toggle":"tip"}` |
| 事件 | 节点 `onClick/onLoad/onChange` 等；标准 `on:{click:...}`；值可为单动作、动作数组或 cases |
| 条件 | `{"cases":[{"when":"length(@title) > 0","actions":[...]},{"else":true,"actions":[...]}]}` |
| 自适应尺寸 | `w/h:"fill"|"hug"|"auto"`；`row/column/grid` 表达关系，固定画布用 `canvas` |
| 字重与对齐 | `fontWeight` 支持 `400/500/600/700` 或 `"normal"/"medium"/"semibold"/"bold"`；`justify` 支持 `"start"/"center"/"end"/"space-between"`（或 `"between"`） |
| 语义色彩令牌 | 优先使用 `$ink`、`$ink-2`、`$ink-3`、`$surface`、`$surface-2`、`$bg`、`$line`、`$brand`、`$brand-soft`、`$success`（或 `$ok`）、`$warning`（或 `$warn`）、`$danger`（或 `$err`），保持单页色板收敛（`color_ok <= 18`） |

同一节点不能用两种别名重复声明同一事件；未知属性、引用、类型和不支持的作用域会给 E_ 诊断。

## 数据与名字的含义

- 数据集支持完整模型声明，也支持由标量记录数组推断模型：`"datasets":{"items":[{"id":"a","title":"文具"}]}`。记录字段必须一致，键必须是唯一非空文本。
- `repeat` 在编译时展开；`repeater` 创建真实运行期列表。两个运行期实例各自持有初始数据。
- `item.title` 先按当前词法环境解析；在运行期行上下文可取当前行字段。进入 Repeater 行会建立行上下文；组件显式声明的 `item` 参数按组件参数绑定。
- `param.item.title` 明确读取编译期参数；`row.title` 和标准 `{"item":"title"}` 明确读取运行期当前行，必须处于合法行上下文。
- `$count` 读取变量；组件同名参数可能参与绑定，需消除歧义时用标准 `{"variable":"count"}`。`@field` 读取控件文字。
- 普通容器不引入引用作用域；组件实例、重复项、面板状态与行模板引入作用域。使用稳定 ID，不按显示文字猜引用。

## 业务宏

```json
{
  "type": "searchable-list", "id": "books", "dataset": "books",
  "searchField": "title", "filterField": "category", "filters": ["全部", "CS", "Other"],
  "w": "fill", "h": 260, "rowHeight": 40,
  "template": {"label": "rowTitle", "text": "${item.title}", "w": "fill", "h": 24}
}
```

搜索默认忽略大小写的完整字段值相等：输入 `编译` 不会命中 `编译原理`；分类与搜索组合。清空搜索保留分类，分类“全部”保留搜索。生成的搜索输入 ID 默认为 `books_search`，分类按钮为 `books_filter_0` 等；重复实例通过作用域隔离。

```json
{
  "type": "form-card", "id": "editor", "title": "新增记录", "w": "fill", "h": 180,
  "fields": [{"id": "newTitle", "label": "标题"}], "submitText": "提交",
  "onSubmit": {"cases": [
    {"when": "length(@newTitle) == 0", "actions": [{"set": {"status": "请输入标题"}}]},
    {"else": true, "actions": [{"set": {"status": "已提交"}}]}
  ]}
}
```

`status` 须在同页声明为可写文字元件。表单宏提供结构，业务动作由 `onSubmit` 显式声明；不会自动新增记录或持久化。`data-table` 的 `columns` 指定 field/header/宽度，`kv-list` 的 `items` 指定 label/value。完整字段见 [语言手册](rp-language.md) 与 Schema。

## 通用产品语义核心、`.rp1` 零噪音 DSL 与多端编译

1. **`.rp1` 紧凑零噪音 DSL**：AI 生成或修改原型可直接编写 `.rp1` 文本源码（无引号/大括号噪音，平均减少 67.7% 字符与 67.3% 标点噪音），支持 `node scripts/proto.mjs check/generate/format --spec source.rp1` 与 JSON AST 1:1 双向无损互转。
2. **领域语义类型与自动过滤**：模型/实体字段支持 `id`、`enum(A|B|C)`、`money`、`phone`、`date`、`percent`、`ref<Entity>`，静态拦截非法枚举值 (`E_ENUM_VARIANT`) 与悬空外键 (`E_FOREIGN_KEY`)；`searchable-list` / `master-detail` 支持 `filters: "auto"` 自动推导枚举分类栏。
3. **七大可组合宏与白盒命名插槽 (`slots`)**：除 `searchable-list`、`form-card`、`data-table`、`kv-list` 外，提供 `detail-card`、`wizard-card`（多步分步向导，自动管理步骤状态机与 `nextWhen` 守卫）、`master-detail`（左列表右详情工作台），全部支持 `slots` 白盒插槽注入与行内 `"when"` 条件视图自动降级（连续互斥 `when` 兄弟节点与 `type: "when"` 自动共享排版槽位，按 `max(w)`/`max(h)` 重叠占位，紧凑行排版无需累加互斥分支宽度）。
4. **通用产品语义核心 (`product` / 顶层声明)**：支持 `computed`（`sum`/`count` 响应式派生聚合与公式重算）、`statecharts`（有限状态机）、`transactions`（带前置守卫拦截的多步原子事务）、`invariants`（形式化业务不变量）以及 `--shell mobile-stack | tablet-split | web-console` 一份源码三端自适应编译。参见 5 个异构非 CRUD 标杆样本：`benchmark_1_smart_cart`、`benchmark_2_approval_wizard`、`benchmark_3_master_detail_workspace`、`benchmark_4_conditional_kanban`、`benchmark_5_course_shuttle`（均提供 `.json` 与 `.rp1`）。

## 修改、自愈与形式化验证

除底层 JSON Pointer `add/replace/remove` 外，`patch` 原生支持高层语义意图算子（`add_field`、`remove_field`、`modify_rule`、`override_slot`、`add_state_transition`、`switch_shell`）：

```json
[
  {"op": "add_field", "entity": "items", "field": "campus", "spec": {"type": "enum(本部|南校区)", "label": "校区", "default": "本部"}},
  {"op": "modify_rule", "rule": "claim_policy", "changes": {"requireContact": true}},
  {"op": "switch_shell", "shell": "web-console"}
]
```

```sh
node scripts/proto.mjs patch --spec source.json --operations changes.json --expected-hash HASH --out revised.json
python3 scripts/proto.py check source.json --auto-heal --out healed.json
python3 scripts/rp_oracle.py examples/rp-language/benchmark_1_smart_cart.json
```

- **数据集最坏行墨迹审计与因果自愈 (`--auto-heal`)**：编译器遍历数据集全部行数据检测最坏行文本溢出（`E_DATASET_WORST_CASE_OVERFLOW`），并在所有诊断上附带机读 `candidatePatches`，可通过 `--auto-heal` 自动应用修复。
- **形式化不变量证明与 Axure `expr.js` 真值预言机**：`explore` / `verify_invariants` 在状态空间搜索中自动检验 `invariants` 并输出最短反例动作轨迹；`rp_oracle.py` 在 Node `vm` 中加载本机 Axure RP 9 的真实 `sto.js + expr.js`，验证 `ReferenceRuntime` 与宿主表达式求值 100% 等价。
