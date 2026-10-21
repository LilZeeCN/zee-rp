# RP/1 原型语言参考

RP/1 用一份严格 JSON 源码描述页面、组件、数据、状态和交互，编译为可编辑的 Axure RP 9 工程。它有独立类型检查、稳定的逻辑身份、语义 IR、编辑器 Schema 和原生后端。旧版无 `language` 的 Spec 继续使用原入口。

首次使用先读 [AI 生成速查](rp-ai-quickstart.md)，包含 Sugar、业务宏、正式工具和修改示例。本手册保留标准 AST 的详细契约。

当前契约：`language: "rp/1"`，`target: 9`，`irVersion: 2`。语言标识保持兼容，IR 版本随编译器能力演进。RP/1 是本项目的语言，不是 Axure 官方产品。

## 从源码到原型

```sh
# 仅检查：标准库即可，不需要字体、Pillow、Axure 或 GUI 权限
node scripts/proto.mjs check --spec examples/rp-language/runtime-inventory.json

# 编辑器补全与源码格式
node scripts/proto.mjs schema --out ./rp-language.schema.json
node scripts/proto.mjs format --spec ./source.json --out ./formatted.json
node scripts/proto.mjs format --spec ./formatted.json --check

# 编译布局、IR、审计与预览；再生成原生工程
node scripts/proto.mjs generate --spec examples/rp-language/runtime-inventory.json --out-dir ./bundle --out-rp ./inventory.rp
node scripts/proto.mjs build-rp --plan ./bundle/compile-plan.json --out ./another.rp
```

输出路径应为新路径；`.rp`、格式化文件和 Schema 输出都拒绝覆盖已有文件。`format` 不改名、不改语义、不排序动作。源码可添加 `"$schema":"../../references/rp-language.schema.json"`（路径相对于源码）；编辑器结构补全由 Schema 提供，类型、引用、循环和宿主限制以 `check` 为准。

完整样本：`booking.json`（三页预约）、`approval.json`、`inventory.json`（编译期列表）、`survey.json`、`course.json`、`visual.json`、`runtime-inventory.json`（运行期 CRUD/筛选/排序/分页/输入/变量）、`nested-panels.json`（两层状态与跨容器取值）、`panel-data.json`（空数据、双实例与面板内数据保留），以及基于统一产品模型 (`product`) 的完整业务链路：`lost-and-found.json`（校园失物招领工作台）、`equipment-loan.json`（实验室设备借用台）、`repair-workorder.json`（园区设施维修工单台）。均在 `examples/rp-language/`。

## 最小程序

```json
{
  "language": "rp/1",
  "target": 9,
  "variables": {"count": {"type": "number", "value": 0}},
  "pages": [{
    "id": "home", "name": "计数", "canvas": {"w": 480, "h": 320},
    "root": {"type": "box", "id": "root", "layout": "column", "padding": 24, "gap": 16, "children": [
      {"type": "label", "id": "value", "text": {"fn": "text", "args": [{"variable": "count"}]}},
      {"type": "button", "id": "add", "text": "加一", "on": {"click": [
        {"type": "set-variable", "variable": "count", "value": {"op": "+", "left": {"variable": "count"}, "right": 1}}
      ]}}
    ]}
  }]
}
```

## 文件与类型

顶层字段为 `$schema,language,target,name,theme,domain,static,strictAudit,product,models,datasets,variables,components,pages`（至少包含 `pages` 或 `product.views`）。未知属性是错误，并尽可能提示近似名称。主题为 `enterprise-light,modern-dark,cobalt-pro,mobile-lowfi,mobile-hifi`；领域为 `web,mobile,doc,test`。

标量类型是 `text,number,boolean`。数字字面量必须有限；布尔值不是数字。JSON 不接受重复属性、NaN 或 Infinity。模型的每行数据必须完整且严格匹配字段类型，不隐式补入业务默认值。

```json
{
  "models": {"Item": {"id": "text", "title": "text", "qty": "number", "active": "boolean"}},
  "datasets": {"items": {"model": "Item", "rows": [
    {"id": "i1", "title": "笔记", "qty": 3, "active": true}
  ]}},
  "variables": {"selected": {"type": "text", "value": "i1"}}
}
```

变量属于工程，必须声明类型和初值；数据集声明是编译输入。两个 Repeater 使用同一数据集时，各自持有一份初始数据，运行期修改互不传播。数据不会写回 JSON，也不提供外部数据库持久化。

## 身份与引用

页面至少声明 `id,root`；省略 name 时取 id，省略 canvas 时 web/doc 默认 1440×900，其他领域默认 375×812，也接受 `[w,h]`。要固定交付尺寸时显式给 canvas。标准节点使用 `id,type`，Sugar 可用元件名键同时声明二者。标识符匹配 `[A-Za-z_][A-Za-z0-9_-]*`。

普通布局容器不引入作用域。组件实例、编译期重复项、面板状态和运行期行模板分别引入作用域。`{"ref":"status"}` 从当前作用域逐级向外查找；完整路径例如 `{"ref":"home/editor/editing/field"}`。

运行期行模板路径为 `页面/中继器/item/元件`。行元件只能从自己的模板内引用；页面外部操作 Repeater 或用变量表示选择项，不能把动态行当作一个全局控件。

显式 ID、组件实例 ID 和重复键不变时，改显示 `name`、插入无关兄弟或重排初始数据不改变逻辑身份与后端名称。`name` 是显示标签，引用始终用 ID。原生 GUID 每次分配，不保证 `.rp` 字节相同。

## 编译期表达式与组件

`{"$":"item.title"}` 读取组件参数或编译期重复项；`{"format":"名称：{item.title}"}` 格式化标量路径。格式转换器、任意代码和 `eval` 不支持。

```json
{"components": {"Title": {"params": {"value": "text"}, "root": {
  "type": "label", "id": "title", "text": {"$": "value"}
}}}}
```

使用 `{"type":"use","id":"first","component":"Title","args":{"value":"首页"}}` 实例化。参数可以是标量或模型；无参数组件可省略 `params`。缺参、多参、类型不符或递归实例化报错。组件正文在实例化时检查；`use` 不接受额外布局覆盖。

`{"type":"repeat","id":"cards","dataset":"items","as":"item","key":"id","template":{...}}` 在编译时展开静态元件。键须为非空唯一文本；这与运行期 `repeater` 是两种明确的执行方式。

## 布局与视觉

| 原语 | 属性 |
|---|---|
| 通用 | `x,y,w,h,flex`；宽高支持非负数、`fill,hug,auto` |
| `box,card` | `layout,padding,gap,align,justify,equalHeight,columns,columnGap,rowGap,children,fill,stroke,radius` |
| `label,paragraph` | `text,fontSize,fontWeight,color,align`；段落另有 `lineGap,lineHeight` |
| `button,badge` | 文本属性及 `variant,fill,stroke,radius` |
| `input` | 原生 TextBox：`value,placeholder,native,fill,stroke,radius,fontSize,fontWeight,color,align,textPaddingX`，支持 `size/weight` 别名；`native:false` 拒绝。背景矢量可编辑，TextBox 透明覆盖其上；提示文本与实际值独立 |
| `divider` | `direction,color,fill` |
| `image` | `src` |
| `dynamic-panel` | `states:[{id,root}]` |
| `repeater` | `dataset,key,template,rowHeight,rowGap,pageSize` |

布局为 `row,column,stack,grid`。颜色是已知 `$token` 或 `#RRGGBB`。输入初值为 `value`，不承诺原生 placeholder。运行期文本绑定默认填充可用宽度；初始内容由初值求出，避免空表达式挤成极窄控件。运行期内容变长不会重新运行离线布局，应声明足够尺寸。

面板可递归嵌套；状态 ID 归所属面板，跨层文字赋值、取输入和切换父面板可通过明确引用表达。当前行为证据覆盖两层面板，不将递归实现等同于任意深度已验收。

段落的 `lineHeight` 表示每行总高度，`lineGap` 表示实际字体墨迹外的额外间隙；二者同时存在时使用 `lineHeight`。`lineGap:6` 不再表示 6px 总行高。固定 `h` 保留，`hug/auto` 按内容测量；`w:"fill"` 在父容器分配宽度后断行。固定高度不足、墨迹越界或状态内重叠会进入结构审计，不通过缩短文案掩盖问题。旧程序若有意把 `lineGap` 作为行高，应迁移到 `lineHeight`。

布局审计按页面、面板状态、行模板分别列 scene、结果和覆盖分母；互斥状态不叠加。零适用四态对象报告 N/A，百分比为 null；完整性及是否执行应读取 sceneCoverage 和对应结果，不把 N/A 当成已检查 100%。

## 有类型的运行期值

运行期值可用于 `label/button/badge.text`、`set-text.text`、`set-variable.value`、条件，以及数据动作中的单元格、谓词和更新值。

| 写法 | 类型和含义 |
|---|---|
| `"文字"`, `12`, `true` | 标量字面量 |
| `{"variable":"count"}` | 已声明变量的类型 |
| `{"widget":{"ref":"field"}}` | 同页控件的文本，类型 `text` |
| `{"item":"qty"}` | 当前行或数据动作目标行的模型字段类型 |
| `{"op":"+","left":...,"right":...}` | 数字算术；支持 `+,-,*,/` |
| `{"op":"==","left":...,"right":...}` | 同类型相等/不等；`>,<,>=,<=` 仅数字 |
| `{"op":"&&","left":...,"right":...}` | 布尔逻辑；支持 `&&,||` |
| `{"fn":"text","args":[...]}` | 一个标量转文本 |
| `{"fn":"number","args":[...]}` | 一个文本或数字转数字；不可转换的文本为 `0` |
| `{"fn":"not","args":[...]}` | 一个布尔取反 |
| `{"fn":"lower/upper/length","args":[...]}` | 实际函数名取三者之一；一个文本转小写/大写/长度 |
| `{"fn":"concat","args":[...,...]}` | 至少两个文本拼接 |

不隐式把数字转成文字；显示库存用 `{"fn":"text","args":[{"item":"qty"}]}`。常量除零在检查阶段拒绝；其他数值计算遵循 Axure 运行期数值行为。编译期参数表达式会先求值，再检查最终运行期类型。

### 文本刷新规则

文本绑定按依赖顺序生成原生动作；前向引用可用，循环报 `E_BINDING_CYCLE`。

- 页面文本在载入时计算。语言动作修改相关变量或文本后，当前页的依赖文本按顺序刷新，包括间接依赖。
- 读取原生输入的绑定附加 `OnTextChange` 刷新，遵循 Axure 的原生事件触发方式。自动化只设置 DOM 值不能替代真实键盘事件。
- 行文本在 Repeater `OnItemLoad` 时计算。数据增删改、筛选、排序、翻页触发行装载时更新；外部变量改变不自动强制所有行重新装载。
- 显式 `set-text` 可暂时覆盖一个绑定目标；下次依赖变化或载入时重新求值。现有页面 `bindings` 仍只在页面载入时执行。

这些规则是编译到原生事件的刷新契约，不是独立浏览器响应式框架。

## 原生 Repeater

```json
{
  "type": "repeater", "id": "items", "dataset": "items", "key": "id",
  "w": 760, "h": 180, "rowHeight": 48, "rowGap": 4, "pageSize": 3,
  "template": {"type": "box", "id": "row", "layout": "row", "gap": 12, "children": [
    {"type": "label", "id": "title", "text": {"item": "title"}, "w": 260},
    {"type": "badge", "id": "qty", "text": {"fn": "text", "args": [{"item": "qty"}]}, "w": 80},
    {"type": "button", "id": "pick", "text": "选择", "on": {"click": [
      {"type": "set-variable", "variable": "selected", "value": {"item": "id"}}
    ]}}
  ]}
}
```

输出包含一个真实 Repeater、DataSet 和一份行模板。初始数据可为空。模型字段用于原生列名，只允许字母、数字、下划线，不能含连字符。`key` 为文本列，初始键必须非空且唯一，`data-update` 不允许修改键；运行期 `data-add` 的键由程序负责保持唯一。

`rowHeight` 为正整数，默认 48；`rowGap` 为非负整数，默认 0；显式 `pageSize` 为正整数，省略表示不启用每页条数限制。静态 PNG 只呈现第一行模板，不模拟完整运行期数据、滚动或分页。

行模板支持布局、视觉原语、组件和行交互。行内原生输入、动态面板、嵌套 Repeater 当前明确拒绝。Repeater 可以位于页面或面板状态；数据动作支持与目标 Repeater 处于同一记录，或从**子动态面板状态 (`PanelState`) 内触发器作用于祖先页面/面板状态中的 Repeater**（编译器自动在目标 Repeater 所在记录合成隐藏桥接面板 `__rp_bridge_<panel>__` 并通过 `OnPanelStateChange` 转发，子面板输入框取值自动快照至页面级缓冲变量）。反向跨记录（从外层直接写内部子面板状态里的私有 Repeater）仍返回 `E_DATA_SCOPE`。普通控件动作仍可跨面板。

### 数据动作

所有动作使用 `target:{"ref":"items"}`。`where` 必须为布尔值，允许组合条件；其中 `item` 代表目标 Repeater 的候选行。更新值也在目标行环境求值。一次 `data-update` 的多个字段按 `set` 中的声明顺序写入；后一个表达式能读到前一个字段的新值，需要交换字段时应先保存旧值。

| 动作 | 额外字段与行为 |
|---|---|
| `data-add` | `rows:[{...}]`；完整模型行，字段可为运行期值 |
| `data-delete` | `where`；删除所有匹配行 |
| `data-update` | `where,set:{field:value}`；更新所有匹配行的一个或多个字段 |
| `data-filter` | `name,where`；命名筛选；组合多个条件可用布尔运算；变更筛选后回到首页 |
| `data-clear-filter` | 清除筛选并回到首页 |
| `data-sort` | `column,direction`；`ascending` 默认，或 `descending`；先清除旧排序，再应用新排序 |
| `data-clear-sort` | 清除排序 |
| `data-page` | `page` 为正整数或 `next,previous,first,last` |

例如选中项库存加一：

```json
{
  "type": "data-update", "target": {"ref": "items"},
  "where": {"op": "==", "left": {"item": "id"}, "right": {"variable": "selected"}},
  "set": {"qty": {"op": "+", "left": {"item": "qty"}, "right": 1}}
}
```

## 事件、条件与动作顺序

`on` 将事件映射到有序动作数组。事件别名是 `click,change,load,mouseover,mouseout,focus,blur,statechange` 或对应 `On*` 名称。页面只支持 `load`；`change/focus/blur` 只允许输入，`statechange` 只允许面板；同一事件别名不能重复。

```json
{"on":{"click":{"cases":[
  {"when":{"op":"!=","left":{"widget":{"ref":"field"}},"right":""},"actions":[
    {"type":"set-text","target":{"ref":"status"},"text":"已填写"}
  ]},
  {"else":true,"actions":[{"type":"set-text","target":{"ref":"status"},"text":"请先填写"}]}
]}}}
```

条件类型为布尔，`else` 只能放在最后并跟在条件分支后。动作按声明顺序执行；生成绑定动作不会弹出 Axure 的无条件 Case 选择菜单。

| 普通动作 | 字段 |
|---|---|
| `set-text` | `target:{ref},text`；目标 label/button/badge/input |
| `set-variable` | `variable,value`；严格匹配声明类型 |
| `set-panel-state` | `target:{ref},state`；状态须属于面板 |
| `show,hide,toggle` | `target:{ref}` |
| `enable,disable,focus` | `target:{ref}`；目标原生输入 |
| `link` | `page` 为目标页面 ID |
| `wait` | `ms` 非负整数毫秒 |

元件动作只访问当前页，包括其面板状态。跨页用导航与变量传参。所有事件在页面、面板与变量身份完成装配后写入；绑定失败会报错并指向声明。

## 单份详情视图

页面 `bindings:[{dataset,key,variable,targets:{目标ID:字段}}]` 为已有的单份详情视图功能。选择变量必须为文本且初值匹配一条数据。编译时填充初始字段，页面载入时按选择键用原生条件更新所有声明字段。相同选择变量应合并一条绑定，同一目标不能被多条详情绑定写入。

分支数量随初始数据行数增长；不提供未知键自动回退，不自动读取另一个 Repeater 运行期变化后的数据。

## 诊断与编译产物

失败退出码为 1，诊断包含 `severity,code,pointer,message`。JSON 语法错误另有 `line,column`；语义错误用 JSON Pointer 定位。

| 代码 | 含义 |
|---|---|
| `E_JSON_SYNTAX,E_DUPLICATE_PROPERTY,E_JSON_NUMBER` | 源文件语法、重复键、非有限数字 |
| `E_PROPERTY,E_TYPE,E_FIELD_MISSING` | 未知属性、类型错误、缺少完整字段 |
| `E_REFERENCE,E_ROW_SCOPE` | 引用错误或行作用域泄漏 |
| `E_BINDING_CYCLE` | 文本依赖循环 |
| `E_DATA_KEY,E_DATA_FIELD,E_DATA_SCOPE` | 键、列或数据动作记录不匹配 |
| `E_ROW_CONTAINER` | 行内未支持的复杂容器 |
| `E_NATIVE_EVENT` | 语义通过但原生事件装配失败 |

`language-ir.json` 包含 `irVersion:2`、符号、类型、运行期 AST、数据、变量、行为、源码指针、`productProvenance` 和语义哈希。同一源码得到确定 IR；仅改 `$schema` 不改变语义哈希。

`compile-plan.json` 保存布局路径、递归面板/行模板、变量、源码映射与语义哈希。`build-rp` 返回逻辑 ID 到原生 `record,id,container` 的映射、`backend` 和声明/写入 `eventCoverage`。行对象只映射一次且保留行模板容器。完整映射、零悬空引用或事件数相等是装配证据，行为仍须在 Axure 验证。

## 后端与验证范围

RP/1 默认 `native`；旧 Spec 默认 `gui`，可用 `--backend native|gui` 显式选择。原生路径直接构造 Layer、VectorShape、RichTextBlock 和内嵌 ImageBox，递归装配面板、原生 TextBox 和 Repeater，然后写入事件。

生成依赖 Node、Python/Pillow、字体、本机 RP 9 空白模板；面板、输入和 Repeater 按需使用 RP 9 安装资源。生成不需要运行 Axure、剪贴板、Swift 或 Stage 缓存；真实预览和原生编辑仍使用 Axure。原生图形不是通用 Axvg 导入器，自定义路径、旋转、效果、渐变和不等角圆角拒绝。

```sh
npm run test:language
npm run test:native
npm run test:runtime
```

行为证据限本机 macOS / RP 9 和报告中的程序。运行期工作台已验行数据、选择、增删改、组合筛选、排序分页、数值转换、变量和输入联动；嵌套示例已验两层取输入、外层切态和深层清空；跨记录数据桥接与「失物招领」共享规则变更已验宿主 GUI 往返及 `data.js`。具体文件、失败对照与证据见项目 `research-rp/rp1-blueprint-20261019/REPORT.md`。

## AI 紧凑语法

标准 AST 继续有效。节点可用 `{"button":"save","text":"保存"}` 代替 type/id；`row/column/grid/stack` 是带 layout 的 box 简写。模板 `${...}` 自动转换为文字表达式，`=expr` 用于纯行内表达式。数字显示由模板转换为文字，标准 AST 仍要求明确类型转换。

| 名字 | 含义 |
| --- | --- |
| `param.item.title` / `{"$":"item.title"}` | 编译期参数/数据路径，明确按词法环境取值 |
| `item.title` | 当前可见的 item 绑定；进入 Repeater 行会建立行上下文，组件显式 item 参数建立组件绑定 |
| `row.title` / `{"item":"title"}` | 显式运行期行，不因同名静态参数改变 |
| `$count` | 当前可见参数或全局变量；显式全局用 `{"variable":"count"}` |
| `@field` | 当前作用域可引用控件的文字 |

动作简写：`{"set":{"$answer":"yes","@status":"完成"}}` 按顺序展开；裸名 status 写元件，变量要用 `$` 或 `set-variable`。`{"state":["panel","done"]}` / `set-state` 切态；`show/hide/toggle` 接受目标 ID；`goto` 接受页面 ID。标准动作对象始终可用。

节点支持 `onClick/onChange/onLoad/onMouseOver/onMouseOut/onFocus/onBlur/onStateChange`；事件值接受单动作、动作数组或 `{cases:[...]}`。cases 的动作使用 `actions`，兼容 `do`。同名原生别名冲突报错，输入/面板专属事件仍检查目标类型。

## 业务宏契约

宏展开前校验源属性与嵌套列、字段、筛选项。未知键不会静默消失；支持的顶层 on/事件透传至生成的外层容器，输入专属或面板专属事件不可绑定到普通宏容器。来源同时保留宏调用点与实际参数位置。

| 宏 | 必要输入 | 常用覆盖与白盒插槽 (`slots`) |
| --- | --- | --- |
| `data-table` | id、dataset、非空 columns | key、rowHeight、headerHeight、padding、columnGap、rowGap、pageSize、repeaterHeight；列 header/field/w/flex/cell，rowOn/onRowClick；`slots: {toolbar, empty, footer}` |
| `searchable-list` | id、dataset、searchField、template | key、filterField、`filters`（支持 `"auto"` 自动从模型 enum 推导）、filterWhere、baseWhere、inputId、value、inputHeight、rowHeight、rowGap、pageSize、repeaterHeight；`slots: {header, toolbar, filterBar, empty, footer}` |
| `form-card` | id、非空 fields | title、submitText/onSubmit、submitId、submitHeight、submitVariant、padding、gap；字段 id/label/value/h/fill/stroke/radius；`slots: {header, extraFields, actions, footer}` |
| `kv-list` | id、非空 items | rowHeight、labelWidth、fontSize、padding、gap；项 id/label/key/value/text/fontWeight/color/align |
| `detail-card` | id、非空 items | title、badgeText、badgeVariant、rowHeight、labelWidth、fontSize、padding、gap；`slots: {header, badge, body, actions, footer}` |
| `wizard-card` | id、非空 steps | activeStepVariable；每步 `{id, title, body, nextText, prevText, nextWhen, onNext}`，顶层 `onComplete`；`slots: {header, stepper, actions, footer}` |
| `master-detail` | id、detail | title、dataset、searchField、filterField、`filters`（支持 `"auto"`）、listWidth/masterWidth、template/master、rowOn/onRowClick；`slots: {header, toolbar, master, detailHeader, detailFooter, footer}` |

七个业务宏均支持通用尺寸、位置、样式覆盖与白盒命名插槽 `slots`。此外，节点树支持条件视图原语 `{"type":"when","id":"...","condition":...,"then":...,"else":...}`（以及节点级 `"when": ...` 属性，支持 `item.status == '就绪'` 或 `[[Item.status == '就绪']]` 写法）：在 Repeater 行模板内由 `RepeaterRowLoweringPass` 自动降级为 `OnItemLoad` 的条件 `show`/`hide` 动作分支；对于 `type: "when"` 的 `then`/`else` 分支以及 `row`/`column` 容器内连续声明的互斥 `when` 兄弟节点（如 `==` 与 `!=`、不同枚举字面量相等、互斥数值区间等），排版引擎自动识别为**互斥显隐空间共享槽位**（按 `max(w)` / `max(h)` 计算尺寸并共享同一坐标起点，静态预览仅渲染当前激活分支，结构审计对互斥分支免报伪重叠，同时对全部分支保留裁切、字形与溢出检查）；在跨 Repeater 动作中支持 `{"caller":"field"}`（或表达式 `caller.field`）读取触发源行字段并由编译器自动提升为页面级快照变量。

## 领域语义类型与 `.rp1` 零噪音文本 DSL

模型与实体字段除基础 `text,number,boolean` 外，支持一等领域语义类型：`id`、`enum`（或 `enum(A|B|C)`）、`money`、`phone`、`date`、`percent`、`ref<Entity>`（外键引用）。编译器在 `check` 阶段静态执行枚举值合法性校验（`E_ENUM_VARIANT`）与跨数据集外键完整性校验（`E_FOREIGN_KEY`），并支持 `filters: "auto"` 自动从枚举定义生成分类胶囊栏。

除 JSON AST 外，RP/1 提供零括号噪音的缩进式文本 DSL（`.rp1`，由 [`rp_dsl.py`](../scripts/rp_dsl.py) 实现），与 JSON AST 具备 1:1 双向无损互转（平均减少约 67% 字符与标点噪音）：

```sh
node scripts/proto.mjs check --spec examples/rp-language/benchmark_1_smart_cart.rp1
node scripts/proto.mjs format --spec examples/rp-language/benchmark_1_smart_cart.json --out ./smart_cart.rp1
node scripts/proto.mjs generate --spec examples/rp-language/benchmark_1_smart_cart.rp1 --out-dir ./bundle --out-rp ./smart_cart.rp
```

## 通用产品语义核心 (`product`) 与多端自适应外壳 (`shell`)

RP/1 支持在顶层或 `product` 内声明通用产品语义核心（由 [`rp_product.py`](../scripts/rp_product.py) 编译并保留全链路 `productProvenance` 与 `productOrigin`）：

- `entities`：声明业务实体字段（支持领域类型與 `ref<Entity>` 外键）、主键 `key`、状态字段 `statusField` 及初始行 `rows`。
- `computed`：声明响应式派生聚合与公式变量，如 `{"op":"sum"|"count","dataset":"...","field":"=item.price * item.qty","where":"..."}` 或表达式公式，当底层 Repeater 发生 `data-add/update/delete` 或关联变量变更时自动按拓扑序重算并刷新绑定视图。
- `statecharts`：声明有限状态机（`initial`、`states`、`transitions: [{from, to, on, guard}]`），自动校验状态转移合法性并在运行期/形式化验证器中检验状态不变量。
- `transactions`：声明多步原子事务（`guard`、`errorTarget`、`errorMessage`、`steps`、`onSuccess`），自动展开为带前置守卫拦截与原子回滚保护的 Case 动作链。
- `invariants`：声明形式化业务不变量（如 `var.total_credits <= 18` 或守恒律），在 `explore` / `verify_invariants` 状态空间搜索中对每个可达状态自动证明。
- `views` 与多端外壳 `shell`：支持 `list, detail, form, wizard, master-detail, kanban, shuttle, cart` 视图及 `--shell mobile-stack | tablet-split | web-console` 一份源码三端自适应编译。

### 聚合的作用域与刷新约定（2026-10-20）

`computed` 的聚合 `scope` 默认为 `visible`，计算当前筛选和当前分页中的行；`dataset` 计算该 Repeater 实例的全部数据，包含被筛选隐藏和位于其他页的行。增删改会重算相关聚合，筛选、排序、分页会重算可见聚合。聚合表达式或 `where` 使用的变量、原生输入改变时，也会刷新聚合与绑定文本。

公式、全量聚合及其依赖按拓扑顺序求值；循环依赖报 `E_BINDING_CYCLE`。可见聚合在列表刷新时完成，因此不允许把它（包括经公式间接引用）再作为另一个聚合的输入，编译时报 `E_COMPUTED_DEPENDENCY`；可见小计的折扣、倍数等派生值应写成普通公式。页面重新进入时，Repeater 和输入恢复页面默认值，全局变量保留，聚合据此重新计算。页面载入 Case 若会刷新可见聚合，编译器先插入原生 `wait 0`，让首次 Repeater 初始化完成，再执行该 Case 的动作。

原生全量聚合使用恒为 false 的规则扫描，扫描动作不删除数据，也不临时清除筛选。原生验收和模型回归分别记录；本轮证据限本机 macOS / Axure RP 9 样本，不外推其他版本或平台。

## 形式化验证、Axure `expr.js` 真值预言机、因果自愈与语义补丁

```sh
node scripts/proto.mjs inspect --spec source.json
node scripts/proto.mjs explain --spec source.json --target home/status
node scripts/proto.mjs complete --spec source.json --pointer /pages/0/root/children/0
node scripts/proto.mjs explore --spec source.json --max-depth 3 --max-states 48
node scripts/proto.mjs simulate --spec source.json --steps steps.json
node scripts/proto.mjs patch --spec source.json --operations changes.json --expected-hash HASH --out revised.json
python3 scripts/proto.py check source.json --auto-heal --out healed.json
python3 scripts/rp_oracle.py examples/rp-language/benchmark_1_smart_cart.json
```

- **数据集最坏情况墨迹上界证明 (`E_DATASET_WORST_CASE_OVERFLOW`)**：布局审计不仅测量首行或初始值，还会自动遍历绑定数据集的所有行（含最长文本、最大数值格式化与枚举最长项），精确定位触发溢出的 `worstRowIndex` 与 `overflowPx`。
- **因果自愈修复卡 (`candidatePatches` + `--auto-heal`)**：所有结构、类型、作用域与最坏行溢出诊断均附带可机读的 `candidatePatches`（含 JSON Patch 动作与预期消解的错误码），传 `--auto-heal` 可自动应用修复并重验通过。
- **随机操作与 Axure 表达式校验 (`rp_oracle.py`)**：`fuzz_dual_model_trace(spec, steps=200, seed=42)` 默认执行 200 次可操作的点击/输入，报告实际次数和表达式差异。历史函数名保留兼容；它只比较参考模型操作与本机 `sto.js + expr.js` 的表达式结果，`stateHashMismatches: null`、`nativeStateComparison: "not_run"`。返回的 `nativePlan` 可交给原生逐步验收工具，在实际 Axure 预览中逐步比较状态。10,000 次是可选压力测试，不是日常门禁。
- **语义意图补丁 (`patch_language`) 与二进制 `.rp` 双向三路合并 (`proto.mjs merge`)**：除高层语义补丁外，支持 `node scripts/proto.mjs merge --base-spec base.json --base-rp base.rp --edited-rp edited.rp --new-spec new.json --out-spec merged.json --out-rp merged.rp`，直接从二进制 `.rp` 的 `MyStyle PropList` 提取设计师手改的填充色 (`fill`)、文字色 (`color`)、描边色 (`stroke`)、坐标 (`x, y`)、尺寸 (`w, h`) 与文案/交互，与新版本源码做非破坏性三方合并。

## 一等运行期选择视图 (`views`)、声明式业务规则 (`rules`) 与 Axure 原生母版/自适应视图 (`masters` / `adaptiveViews`)

- **运行期选择模型与 $O(1)$ 详情视图 (`views` / `bindings`, P0-1)**：
  顶层或页面级 `views: { "DetailView": { "source": "rooms", "key": "id", "selector": "$selected_id", "fields": { "det_title": "title", "det_floor": "floor" } } }`（以及页面级 `bindings`）全部编译为运行期 `selection-scan`（利用 `selectionType: 2` 扫描谓词将命中行字段写入全局缓冲变量 `rp1_sel_*` 并通过单条 `set-text` 刷新详情控件，跨页跳转前从当前源 Repeater 扫描所选行，先清空再写入 `rp1_sel_*`，通过 selector 缓存键在详情页使用该快照；本地切换则重新扫描）。单个 view 的详情页 `OnLoad` Case 数不随行数增长（最多 2 个 Case，0 处烤死行字面量；扫描运行时间仍为 $O(n)$），运行期连续新增、修改后的选中行可在详情页展示，删除后详情清空。这是所选行快照，不是跨页面重载持久化整个数据集。
- **声明式业务规则求值器 (`rules`, P0-2)**：
  顶层或 `product.rules` 支持声明式规则：`rules: { "borrow_policy": { "when": "op.claim(btn_submit)", "require": ["inp_user", "inp_contact"], "guards": [{ "assert": "=number(@inp_days) <= 30", "message": "超期" }], "effect": { "status": "已借出", "set": { ... }, "excludeFrom": "rep_available" }, "feedback": "status_banner" } }`。无需修改 Python 代码即可声明任意异构业务域的必填校验、前置守卫、状态流转、数据增删改与列表自动排除。
- **Axure 原生母版与插槽 (`masters` + `page.master` / `page.slot`, P1-3a)**：
  顶层声明 `masters: { "app_shell": { "name": "应用公共外壳", "layout": [...] } }`，页面通过 `"master": "app_shell", "slot": { "body": [...] }` 复用公共导航/侧栏外壳，后端生成 `Axure:Master`、`Axure:MasterPackageInfo`、`MasterTreeMap`，每页放置真实 `ReferenceDiagramObject`，共享定义中的导航保留交互。本轮支持文本、按钮、输入等基础元件；包含动态面板或中继器的母版明确拒绝。三页导航已通过保存关闭重开后的真实预览；本轮尚未完成 GUI 手改共享定义后再次预览的验收。
- **Axure 原生多档自适应视图 (`adaptiveViews` + `widget.adaptive`, P1-3b)**：
  顶层声明 `adaptiveViews: [{ "id": "mobile", "name": "Mobile 390", "width": 390, "condition": "<=" }, { "id": "desktop", "name": "Desktop 1280", "width": 1280, "condition": ">=" }]`，节点支持 `"adaptive": { "mobile": { "w": 342 }, "desktop": { "w": 1200 } }`，后端写入视图集及元件的独立 `AdaptiveStyles`，并在原生 OnLoad/OnResize 中按窗口宽度选择视图。显式条件按声明顺序，未命中时回 Base；无条件列表按宽度降序选择 `>=` 断点。支持页面元件的有限数值 `x/y/w/h`，尺寸非负；母版、面板及中继器模板中的覆盖暂时拒绝。真实预览已验证窗口 390/1280/900 对应元件宽度 342/1000/600（macOS + RP9）。
