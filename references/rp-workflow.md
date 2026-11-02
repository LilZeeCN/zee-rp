# 离线 .rp 工作流与参数

所有 `scripts/` 路径相对 Skill 目录。输入和输出改为任务的绝对路径；输入须是已保存的 Axure RP 11 文件，输出使用不存在的新文件名。操作不启动 Axure，应用验收另见 [验证流程](verification.md)。

## 先定位，再加工

```bash
node scripts/rp-read.mjs source.rp
node scripts/rp-read.mjs source.rp --json
node scripts/rp-read.mjs source.rp --full
```

摘要包含页面、母版、Page 记录索引、元件名称/几何/文本、面板状态、交互及问题。JSON 的 `containedWidgets` 提供带 `record/id/guid/container` 和简单文本的容器递归清单，`duplicates` 提供重名位置；`pages[].widgets` 来自 Page 记录对象图，可能也含 repeater 行模板对象，容器路径以 `containedWidgets` 为准。`set-widget-text.mjs --record ... --container ... --widget-name ...` 可按记录索引、完整容器路径与容器内唯一名称定位；仍可用 `--record ... --widget ...` 直接按对象 ID 改写 Page 或 PanelState。多 run 富文本可加 `--run` 精确选一个片段。记录索引是文件记录的 index，包含非页面记录，不是页面在侧栏里的序号。每次加工后的索引以新文件摘要为准。

### 空白工程、原生控件与库页组件

空白模板不随代码分发。在用户本机 Axure RP 11 中保存单页空白工程后，设置 `AXURE_BLANK_TEMPLATE=/absolute/blank.rp`；未设置则使用本机模板缓存。详细准备方法见 [README](../README.md)。原生元件库也从用户本机 Axure 读取。

```bash
node scripts/create-blank-project.mjs blank.rp
node scripts/duplicate-page.mjs blank.rp two-pages.rp "Page 1" "Page 2"
node scripts/create-blank-page.mjs source.rp source-with-blank-page.rp "New blank page"
node scripts/clone-library-widget.mjs Default.rplib blank.rp with-text-field.rp \
  "Text field" "Page 1" FORM_NAME --x 120 --y 120 --w 260 --h 32
node scripts/set-combobox-options.mjs source.rp options.rp "Page 1" NATIVE_DROPLIST \
  '["Choose one","North","South","West"]' --selected 1
node scripts/set-listbox-options.mjs source.rp multi-list.rp "Page 1" MULTI_LIST \
  '["North","South","East","West"]' --selected '[0,2]'
# 同一原生 ListBox 改为单选：--single --selected '[0]'
node scripts/clone-library-page-content.mjs \
  "Sample form patterns.rplib" blank.rp with-field-multiplier.rp \
  "Field multiplier" "Page 1" --x 100 --y 100
node scripts/set-widget-text.mjs source.rp labeled.rp "Page 1" LBL_NAME "Customer name"
node scripts/set-widget-text.mjs source.rp nested-text.rp --record 4 --widget 17 "Hours note"
node scripts/set-widget-text.mjs source.rp row-text.rp --record 4 \
  --container "Field multiplier(行模板)" --widget-name "Name input" "Preferred name"
node scripts/set-widget-text.mjs source.rp edited-run.rp --record 3 --widget 24 --run 1 $'side navigation\n'
```

`create-blank-project.mjs` copies a real native blank project from AXURE_BLANK_TEMPLATE or the user-local cache. The code package does not contain an Axure .rp template. It creates one empty page; `duplicate-page.mjs` can copy that page to add more empty pages. `create-blank-page.mjs` can add a blank page from the same native template to an existing `.rp`; both the two-page demo and Training `Prototype Starter` samples loaded and retained the empty page after Axure save, close, and reopen. The historical samples used an RP 11.0.0.4137 macOS native page. Changing template location does not establish compatibility with other builds. `clone-library-widget.mjs` copies one standalone non-container widget. `set-combobox-options.mjs` writes a non-empty JSON array of strings into one uniquely named single-select ComboBox on one uniquely named page; `--selected` is a zero-based default option index and defaults to 0. The North/West preview and `Edit List Items...` GUI edit/save/reopen passed on one RP 11.0.0.4137 sample; multi-select and other builds are unverified. `clone-library-page-content.mjs` copies the complete diagram content and linked object closure from one library page; inspect its names and geometry after cloning. `set-widget-text.mjs` accepts a unique widget name in a Page record, an explicit Page/PanelState record and widget ID, or a record index + exact `containedWidgets` container path + unique nested widget name. It edits one rich text run or a TextBox's plain `TextBlock.text`. For a multi-run `RichTextBlock`, use record/index mode with `--run <zero-based-index>` to change exactly one run; inspect `rp-read --full`'s `Inlines` in traversal order to choose the index. Other runs and their formatting fields are preserved. This edits a selected segment, not the complete multi-run block at once. The container/name path is a structural lookup only; generated outputs still need Axure GUI and preview verification before claiming they work in the app.

`set-listbox-options.mjs` 与 ComboBox writer 分开使用。它处理唯一页面上的唯一原生 ListBox；选项为非空字符串数组，默认多选、默认选中索引 `[0]`，`--selected` 接受零起始索引数组，`--single` 限定最多一个默认选中项。North/East 默认多选和保存重开后的键盘 South/West 多选在指定样本通过；单选对照也通过。另在 single 对照的新副本中从原生 Edit list box 对话框开启多选并设置 North/East，保存关闭重开后开关和默认项保留，预览实际键盘 South/West 多选通过。仍只覆盖此 ListBox 与选项组合。

### 整段富文本

PanelState 的 `record/widgetId` 定位已在六段/17 run 样本完成真实保存重开和预览，独立 GUI 将 Blue 改为 Blue GUI 后保留格式。另可用 `record/widgetId` 定位 Page/PanelState 记录中 DiagramObject 的既有 TableCell，例如 Page record 4 / widget 16；一个 `User: ` 常规 + `Bob` 粗体红色的双 run 样本已通过保存关闭重开及新预览。行距另在 Page VectorShape 样本验证：`lineSpacing:72` 保存关闭重开后画布与预览显示 96px 行高，`0` 保持自动；只证明该值和范围，不推定其它行距、目标或容器。原生编辑会对缺字字体做回退（PanelState 样本中文/全角冒号为 PingFang SC）。Page 根 VectorShape 的 Page、HTTP(S) current/new 链接已有各自限定的保存重开和预览证据；链接写法见下例。原生列表 2026-10-12 已按逆向真值实现（`list` 参数，见下），结构级验证通过、画布/预览行为待 GUI 验收。证据见 `panel-writers-20261007/evidence/panel-writers-final-audit-v2.json` 与项目 `richtext-advanced-20261010/REPORT.md`、`richtext-list-hyperlink-20261010/evidence/`、`native-list-writer-20261012/REPORT.md`。

```bash
node scripts/set-widget-richtext.mjs source.rp rich-text.rp richtext.json
```

```json
{
  "page": "Page 1",
  "widget": "RICH_TEXT",
  "defaults": {"fontFamily": "Arial", "size": 24, "color": "#222222", "bold": false},
  "paragraphs": [
    {"align": "left", "lineSpacing": 72, "runs": [
      {"text": "标题", "style": {"bold": true, "size": 32}},
      {"text": " · explanation", "style": {"italic": true}}
    ]},
    {"list": true, "runs": [{"text": "一级项目符号"}]},
    {"list": 2, "runs": [{"text": "二级项目符号"}]},
    {"align": "right", "runs": [{"text": "页脚", "style": {"underline": true, "color": "#245BDB"}}]}
  ]
}
```

页面与元件名称须唯一；显式定位可改用 `record` 与 `widgetId`，记录可为 Page/PanelState，widget 可以是其中 DiagramObject（包括既有 TableCell），并非独立 TableCell 记录。目标须已有原生 RichTextBlock、段落/run 与 MyStyle。每个 paragraph 至少一个 run；run 内不放换行，段落之间自动添加换行，空段落用 `{"runs":[{"text":""}]}`。`align` 为 left/center/right；style/defaults 还可写 `strikethrough`，布尔项与字号须为对应 JSON 类型，颜色为 `#RRGGBB`。run 的全量原生键：`weight`（int 100–950，与 `bold` 同键互斥）、`style`（0=常规/1=倾斜体/2=斜体，与 `italic` 同键互斥）、`stretch`（0–9，5=常规）、`characterSpacing`（数值）、`baseline`（整数）——值域读自 Axvg 枚举；Highlight/上标/Typeface 不持久化，不提供。段落还可写 `wrapping`（0=换行/1=不换行/2–4）、`trimming`（0=无/2=词/3=省略号）与 `list`（原生列表：`true`/`false` 或 0–3 级；写 `ListInfo {IndentLevel, ListType}`，符号 `•/◦/▪` 由级别渲染派生；numbered 在本 build 持久层不可表达）。未给出的格式沿用首个原生 run/paragraph 模板，整段原文会被替换。run 可选 link，其 page/url 必须且只能提供一个，window 可选 current/new，例如 {"page":"Page 1","widget":"RICH_TEXT","paragraphs":[{"runs":[{"text":"Open "},{"text":"Page 2","link":{"page":"Page 2","window":"current"}},{"text":"."}]}]}。目标 Page 名必须唯一；URL 仅接受 http/https；目标须已有原生RichTextBlock/AxRun；无链接时可构造首个Hyperlink，多个run可独立带链接，已有链接可以更新或清除。首链接/同段双链接为离线字段断言，新增组合GUI行为未验。

`lineSpacing` 是段落级非负数值；`0` 表示自动。writer 同时写段落 `LineSpacing` 与 MyStyle 属性 ID 20，避免继承样式覆盖；实测 `72` 在预览导出为 `line-height:96px`。2026-10-10 的 Page VectorShape 样本完成 Axure 保存关闭重开、画布及预览验收。其它行距值、目标与容器范围未验。writer 保留元件/文本身份，同步控件样式的统一与混合属性标志；2026-10-06 的 Page VectorShape 两种样本完成 GUI 保存关闭重开和预览，GUI 改写蓝色片段、给斜体加下划线、新增中文段落也保留；PanelState 路径已在指定样本完成 GUI 验收。既有 Page TableCell 的单样本多 run 经保存重开和预览通过。`list`/`wrapping`/`trimming`/run 全量键为 2026-10-12 新增：list 的写法按静态逆向（`ListInfo` 仅 `IndentLevel`/`ListType` 两 u32 键，`ListType` 为 0/1 布尔），经官方 `Default.rplib` ground truth 键序/值对照、修改与构造两路径、记录字节 roundtrip、回归 171/171 验证——**画布符号显示与预览 `<ul><li>` 尚未 GUI 验收**，当前只承诺结构正确。Axure 不支持原生 TableCell 合并，官方建议用覆盖矩形模拟。URL current/new 的运行时仅有各自限定样本；字体缺字会由 Axure 替换，AutoFit 可在进入 GUI 编辑后调整高度/位置。证据见项目 RESULTS 的 `richtext-advanced-20261010/` 和 `richtext-list-hyperlink-20261010/evidence/`、`native-list-writer-20261012/REPORT.md`、`static-extensions-20261012/REPORT.md`。

### 原生表格与连接线

```bash
node scripts/set-native-table.mjs source.rp table.rp table.json
node scripts/clone-native-connector.mjs native.rp target.rp connector.rp \
  PAGE_RECORD CONNECTOR_ID "Page 1" '{"dx":0,"dy":0}'
node scripts/set-connector-anchors.mjs source.rp anchored.rp "Page 1" "Anchored Connector" \
  '{"start":{"widget":"SET_BUTTON","side":"right"},"end":{"widget":"VALUE_PREVIEW","side":"left"}}'
```

Table 输入须含一个可匹配的原生 Table；JSON 用 `cells` 矩形二维数组、`columnWidths`、`rowHeights`，可用 `table` 按名字选择。已验 4×4、1×1、1×5、5×1、5×6 的 GUI 往返与逐格预览，包括缩减和新增单元格；扩容后 R5C6 的原生 GUI 改稿也通过。每格可为字符串（单 run）或 `{"runs":[{"text":"...","style":{...}}]}` 对象（多 run，2026-10-12 新增：克隆格内原生 run 模板，style 键与 set-widget-richtext 相同；双/三 run 格含粗体+颜色经三零与回归验证，GUI 行为待验）。另可对已有 Page TableCell 用 `set-widget-richtext.mjs --record ... --widget ...` 单独重写多 run，目前只验一个格。

可选 `visualMergeTemplateWidgetId` 与 `visualMerges` 生成视觉合并覆盖块。模板必须是同一 Page 上的根 VectorShape，带原生位置/尺寸和恰好一个 RichTextBlock 文本 run。每项使用 0 起始 `row`/`column` 与正数 `rowSpan`/`columnSpan`，可选 `text` 覆盖左上格文字；范围内其余格必须在 `cells` 中为空，重叠或边相接的范围会拒绝。已在 3×3、5×5、6×6 和 9×9 样本通过 Axure 保存关闭重开及本机预览，涵盖 6×6 最多四个互不接触块（含跨三行）及 9×9 四象限 4×4 跨度覆盖。它用 VectorShape 模拟视觉效果，不创建 Axure 原生合并单元格；超过四行/列跨度、五个以上块、相接/重叠范围、其它尺寸、build 与平台仍未验。Axure 不支持 TableCell 原生合并。缩减后旧格定义保留。

Connector 的 `PAGE_RECORD`/`CONNECTOR_ID` 由当前 `rp-read` 定位。`clone-native-connector.mjs` API 的 options 接受 `name/startName/endName/dx/dy`，复制 Connector 和两端形状闭包，重绑目标页并保留原生四边连接点键；支持源图为 Page 或 PanelState 记录，支持保留端点自定义锚点 GUID、坐标与方向，端点必须与 Connector 在同一图记录中（跨 PanelState/diagram 明确拒绝）。两端自由也可复制，但不复制无关形状。来源 Page 若引用 DesignDocument 中 GUID 匹配的自定义全局连接线样式，脚本会把实色填充与线宽材料化为克隆线局部属性；当前只验证 `#0099CC`/2px 样本。已有局部属性优先保留；渐变与其它样式属性仍需逐项核验。不要把 Style 对象注册到目标 DesignDocument：本机候选导致 Axure 页面不显示内容。新增 `create-global-variable.mjs` 可向 DesignDocument 追加全局变量（`node scripts/create-global-variable.mjs source.rp output.rp VarName [defaultValue]`），结构级三零已验。

`set-connector-anchors.mjs` 的 start/end 可省略其一，传 `null` 则脱开对应端点。Page 根 Connector 可用名称定位；容器内 Connector 用 `{"record":4,"widgetId":16}` 定位。端点可用 `{widget,side}`、`{widget,point:{x,y}}`、`{widgetId,side}` 或 `{widgetId,point:{x,y}}`；也可为 ID 选择器增加 `record`。目标必须是同一图记录中的直接子级 VectorShape，跨 PanelState 端点明确拒绝。每端必须且只能传 `side` 或 `point`；`side` 为 top/left/right/bottom。自定义点的 `x/y` 是相对元件宽高的 0–1 归一化坐标；未传 `direction` 时按形状局部坐标中的点位置推断边方向，可选 `direction` 为 top/left/right/bottom。Page 根未旋转 VectorShape 的顶边点、左侧内部点，以及同一 PanelState 记录内的嵌套目标点均经 Axure 保存关闭重开；后者的预览端点约在目标的 `(0.25,0.75)`。Page 根旋转形状 45°、90°、180°、270° 各一个局部 end 点经原生 UI、writer、保存并关闭项目后从磁盘重开和预览通过；另有一个 270° 旋转目标 start 端样本经保存关闭重开及预览核验。其它角度、坐标/方向组合、旋转 start 端的其它组合与形状类型仍未系统验证。工具保留原生缓存几何和控制点；预览中的 Move 不带动线端，原生 UI 对照亦如此。

嵌套 PanelState 调用示例：

```bash
node scripts/set-connector-anchors.mjs source.rp nested.rp "Page 1" \
  '{"record":4,"widgetId":16}' \
  '{"start":{"widgetId":15,"point":{"x":0.25,"y":0.75}}}'
```
### 给无名元件命名

```bash
# PAGE_ORDINAL 只计 Axure:Page 记录，从 0 起；WIDGET_ID 是该记录内的对象 ID：
node scripts/name-widget.mjs source.rp named.rp PAGE_ORDINAL WIDGET_ID "提交按钮"

# 快捷路径：唯一旧名称即可；重名时加 --page 或使用 --record/--widget
node scripts/name-widget.mjs source.rp named.rp --name "旧名称" --to "提交按钮"
```

一次可传多组 `WIDGET_ID "新名称"`。该工具不修改显示文本或交互；已有样本链通过它命名表单和触发器。优先用数字页面序号：页名模式只查字符串表并取首个匹配，重名或页面文本撞名时可能选错。可用 `readRecords(file).filter(r => r.className === 'Axure:Page')` 核对序号与记录索引，不能直接把 `rp-read` 的记录索引填入这里。命名后重读摘要，确保后续交互引用的名称唯一。

## 添加交互

```bash
node scripts/add-interaction.mjs source.rp result.rp "按钮名" \
  --event OnClick \
  --action show target="提示框" animation=slideDown duration=300 \
  --action wait ms=200 \
  --action move target="提示框" x=50 y=0 duration=300 \
  --action hide target="提示框" duration=300

node scripts/add-interaction.mjs source.rp scoped.rp "提交按钮" \
  --on-page "订单页" --event OnClick --action hide target="提示框"

node scripts/add-interaction.mjs source.rp page-event.rp "页面名" \
  --page --event OnLoad --action wait ms=200

node scripts/add-click-link.mjs source.rp link.rp "链接元件名" "https://example.com" new

node scripts/remove-interaction.mjs source.rp no-action.rp "提交按钮" \
  --on-page "订单页" --event OnClick --remove-action \
  --case-index 0 --action-index 1

node scripts/remove-interaction.mjs source.rp no-click.rp "提交按钮" \
  --on-page "订单页" --event OnClick --remove-event
```

- CLI 位置参数写在 `--event`、`--action` 前；动作参数是 `key=value`。多个动作依次追加到同一 Case；再次 `--event` 创建另一事件节点。
- 元件触发源默认按名称全文件查找；`--on-page` 限定到唯一页面，页面或元件重名会报错。动作目标在当前 Page 记录内查找，也须唯一。页面事件用 `--page`，需要动作目标时显式给 `target`。载入事件用 `OnLoad`（288）；页面上下文中的 `OnPageLoad` 兼容映射到 288，元件上下文不变。
- `add-interaction` 追加，不替换或合并已有同名事件；重复注入须以原始副本重新生成，避免叠加。
- 需要改写一个已有事件时可加 `--replace-event`：按 Axure 事件类型匹配，只有一个匹配项时替换其活动 Case/Action 树；没有匹配项时照常新增，存在多个同类型事件时拒绝。旧 Case/Action 的 node-table 映射会移除，但旧对象定义仍留在文件中；反复从替换结果继续替换不会在活动事件树里叠加动作，但会留下更多旧对象定义。`replaced-interaction-candidate.rp` 预览中点击后 Solution 从 x=800 移到 x=880，只执行新位移；Axure 交互面板编辑和保存关闭重开尚未验。默认仍为追加。
- `remove-interaction.mjs` 可从活动事件树移除唯一匹配的事件，或按从 0 起的 `--case-index` / `--action-index` 移除一个动作。页面元件用 `--on-page` 限定页面；页面级事件用 `--page`，`OnPageLoad` 按新增事件路径映射到 `OnLoad`（288），元件级 `OnPageLoad` 保持 320。node-table 映射和父节点引用会更新，原 Case/Action/Event 定义对象仍留在 payload；这不是物理清理。两个移除候选已在限定样本预览验证：空 Case 没有 Trace 或位移，移除事件后点击也没有 Trace 或位移；交互面板编辑和保存关闭重开尚未验。
- `add-click-link` 只适用于没有交互的元件，拒绝覆盖已有交互。
- CLI 会把数值和 true/false 自动转型；保留前导零或这些字面文本时用 JSON 字符串。复杂文本也优先 JSON。

### 支持的原生动作

以下是原生编辑工具 `add_interaction` 的参数，**不等同于 RP/1 动作字段**；验证范围见 [能力表](capabilities.md)。
原生 `set-panel-state` 可使用 `enterAnimation/exitAnimation`（如 `none/fade/slideLeft/slideRight/slideUp/slideDown`）、
`enterDuration/exitDuration`（毫秒）和 `enterEasing/exitEasing`（如 `none/swing/linear/easeInCubic/easeOutCubic`）。
RP/1 的同名动作目前只开放 `target/state`，须在目标宿主预览实际验证动画。

常用动作参数：

| 动作 | 参数 |
|---|---|
| `show/hide/toggle` | `target`、`duration` 毫秒、`animation`，如 `none/fade/slideDown` |
| `move` | `target`、`x/y` 位移，默认 0；不是 `dx/dy` |
| `set-position` | `target`、`x/y` 绝对位置 |
| `wait` | `ms` 毫秒 |
| `set-opacity` | `target`、`opacity` 百分数、`duration` 毫秒、`easing`；例如 Page 本地 VectorShape 已验证 15%/linear/3000 ms 与 100%/swing/2000 ms。其它组合见 样本边界 (internal research reference) |
| `set-panel-state` | `target`、`state` 真实状态名或 `next/previous`；`loop=true/false` |
| `set-size` | `target`、`width/height`、`duration` |
| `set-text` | `target`、`text`；按目标类路由：TextBox 使用 `SetWidgetFormText`，VectorShape 使用 `SetWidgetRichText`（`plain=true`）。其它目标类型当前拒绝 |
| `set-text-from-repeater-item` | 行模板直接子元件事件中使用 `repeater`、`column`，将当前行值写到外部 `target` 文本框；只支持 `Item.<列>` 单字段 |
| `set-check` | `target`、`checked=true/false`（或 `value`）；SetCheckState 用于勾选状态及已验 ImageBox Selected |
| `set-selected` | `target`、`value`；SetSelectedOption 为列表选项值，不用于图片选中 |
| `raise-event` | 元件目标 `target`、`eventType`；当前页目标用 `targetPage=true` 且不同时给 target，已验页面 OnLoad eventType=288 |
| `link` | 外部链接用 `url`、`window=current/new`；内部页面链接的 GUID 解析尚未形成高层接口 |

## 条件与多 Case

```bash
node scripts/add-interaction.mjs source.rp conditional.rp --json cases.json
```

`cases.json` 示例采用已有三分支行为样本的结构（文件中须存在这些元件，输入框须能输入文本）：

```json
{
  "target": "提交按钮",
  "interactions": [{
    "event": "OnClick",
    "cases": [
      {
        "description": "If A",
        "isNewIfGroup": false,
        "when": {
          "op": "==",
          "left": {"widget": "输入框", "fn": "GetWidgetText"},
          "right": {"value": "A"}
        },
        "actions": [{"type": "move", "target": "结果标记", "x": 100, "y": 0}]
      },
      {
        "description": "ElseIf B",
        "isNewIfGroup": false,
        "when": {
          "op": "==",
          "left": {"widget": "输入框", "fn": "GetWidgetText"},
          "right": {"value": "B"}
        },
        "actions": [{"type": "move", "target": "结果标记", "x": 50, "y": 0}]
      },
      {
        "description": "Else",
        "isNewIfGroup": false,
        "actions": [{"type": "move", "target": "结果标记", "x": -100, "y": 0}]
      }
    ]
  }]
}
```

2026-09-22 的 `actions-page1-condition-candidate.rp` 已用同一触发器实际点击 A/B/C，目标 x 从 640 依次到 740/790/690。样本的三个 Case 均为 `isNewIfGroup:false`，最后一支省略 `when`；`description` 只是说明文字。工具没有 `else/elseIf` 布尔接口。上例更换了元件名称，使用时仍需验证当前产物；已有样本不覆盖任意复杂表达式。

操作符为 `&&/||/==/!=/>/</>=/<=`。两侧可接受字符串/数字字面量、`{value:...}`、`{widget,fn}`、`{fn,args}`，或递归 `{op,left,right}`；嵌套 BinaryExpr 必须提供左右项，缺项会在写文件前报错。例如 `{op:"&&",left:{fn:"IsValueAlphaNumeric",args:[{widget:"输入框",fn:"GetWidgetText"}]},right:{op:">=",left:{widget:"输入框",fn:"GetWidgetValueLength"},right:{value:3}}}`。`fn` 名称按静态注册表白名单校验（2026-10-12 起共 18 项：GetWidgetText/GetWidgetValueLength/GetWidgetVisibility/GetWidgetRectangles/GetGlobalVariableValue/GetGlobalVariableLength/SetGlobalVariableValue/ToLowerCase/ValueContains/ValueNotContains/IsValueNumeric/IsValueNotNumeric/IsValueAlpha/IsValueNotAlpha/IsValueAlphaNumeric/IsValueNotAlphaNumeric/IsValueOneOf/IsValueNotOneOf），未知名写文件前拒绝；函数是否受运行时支持仍须实测，当前已验 `GetWidgetValueLength`、`ToLowerCase`、`IsValueAlphaNumeric`、双参数 `ValueContains`。省略 `left` 时元件事件默认读触发元件文本；页面事件须显式给 `left`。JSON 的 `page:true` 表示 `target` 是页面名；限定元件所在页可使用 `"target":{"widget":"提交按钮","page":"订单页"}`，或 CLI `--on-page`。

## 页面与母版

```bash
node scripts/duplicate-page.mjs source.rp pages.rp "源页面名" "新页面名"
node scripts/create-master.mjs source.rp masters.rp "已有母版名" "新母版名"
# PAGE_RECORD_INDEX 替换为 rp-read 显示的数字：
node scripts/place-master.mjs source.rp instance.rp "已有母版名" PAGE_RECORD_INDEX --x 100 --y 100
```

母版创建工具执行复制；不是从任意页面创建母版。页面 `--by-index` 克隆分支属于已知失败实验，不用于日常复制。

2026-10-08 `place-master` 修复 ReferredMaster 的原生 typed reference（tag 0x10）和 Style GUID/Capabilities。旧 tag 0x13 能通过结构解析与只在 Gallery 页保存的 job，进入实际页面画布却 cast 失败。新放双实例、状态导入、独立文字/PNG 覆盖及剩余实例原生 y660→640 改稿，完成保存关闭重开与真实预览；证据 direct-image-cleanup-20261008/REPORT.md。其它 build/任意母版未外推。

## 动态面板及其他高级能力

先读 [能力表](capabilities.md) 中的限制。克隆面板的正确入口：

```bash
node scripts/create-panel-clone.mjs source.rp panel.rp "页面名" "新面板名" "状态一" "状态二" --x 100 --y 100 --w 300 --h 200
# 名称解析不适用时，在上述命令末尾加入 --page-index 数字；页面名位置参数仍需保留。
```

模板默认来自 macOS 安装目录下的 `Quick Win.rp` / `Hours Panel`。其他位置可用现有 `AXURE_PANEL_TEMPLATE` 和 `AXURE_PANEL_TEMPLATE_NAME` 环境变量指定。状态包为空；GUI 双击编辑态已于 2026-09-22 在修复件复验通过（三处对齐 UI ground truth：清洗模板残留孤儿 DiagramObject/Style 与 StyleCache 条目、状态包挂目标 Page 的 children、PanelState 记录插在其所属 Page 记录之前）。已知拒读的手写路线源码归档在 研究记录 (research reference not distributed)，不作为交付工具。

加 `--copy-template-states` 可把模板 `Hours Panel` 中两种状态的元件内容一并克隆进新状态包。指定 State B 的 TextBox/Button 已经 GUI 保存关闭重开及预览切换验收；它复制的是该模板已有内容。

2026-10-06 新增状态内容导入：先在独立 Page 制作并保存布局，再导入目标面板的状态。页面、面板和状态名称都须唯一，输出必须使用新文件名。默认只填空状态；向已有状态追加时显式使用 `--append`。

```bash
node scripts/fill-panel-state.mjs layout.rp panel.rp filled.rp "布局页" "目标页" "面板名" "状态名"
node scripts/fill-panel-state.mjs image-layout.rp filled.rp appended.rp "布局页" "目标页" "面板名" "状态名" --append
```

工具复制全部 Page 根控件及本地对象闭包，不复制 Page OnLoad。追加保留原根顺序与旧对象，拒绝与已有元件重名，不替换旧内容。已验渐变/阴影布局、四种表单控件、本地 SetWidgetFormText、GUI 文本改稿保存重开；内嵌 PNG 的空状态导入与已有 Form 状态追加、状态切换及 GUI 图片移动保存重开也通过。图片必须在本地原生样式中含 Stream/Extension，否则拒绝；其它图片格式/状态资源未验。

来源 Page 可以含嵌套 DynamicPanel，工具递归复制其状态包，共享身份映射；按原生真值，各层 PanelState 在 manifest 中仍是 owning Page 的直接子包。两层/三层生成件的最深层状态切换、表单交互和值/PNG 保留，以及三层最深层 TextBox 的 GUI 改稿保存重开已通过。缺状态包、外部状态引用和 next/previous 等未验形式拒绝。

2026-10-06 指定 Repeater 布局的直接/双层嵌套导入也通过保存关闭重开、固定值增行、单列等值删改及状态切回后的数据保留；独立 GUI 数据单元格改稿后，预览按新行值执行规则。原生 DataSet 与行模板在所属 Page/PanelState 图中内联，不需要额外中继器记录包。导入保留本地 SetWidgetFormText/SetWidgetRichText、明确 SetPanelState，以及 AddItemsToDataSet/DeleteItemsFromDataSet/UpdateEditItemsInDataSet 动作。表达式只接受本地 `[[Item.<列>]]` 或 `[[Item.<列> == '字符串']]`（也可双引号），scope 字典须空；DataSet 引用与 repeater-path 必须属于导入闭包。数据列按 column-id 匹配，不能按数组顺序猜测。外部变量/目标、复杂规则和排序筛选/分页交互导入拒绝或未验。原生包裹会使 AutoFit 按钮缩到文字尺寸，本样本不证明任意几何保真。母版覆盖其它格式/其它依赖格式与连接线、库继承或外部资源、其它资源/覆盖格式的旧内容清理、自动尺寸更多组合/偏移与任意深度继续待验，完整范围见能力表。

### 删除、清空或替换既有状态内容

```bash
node scripts/remove-panel-state-content.mjs source.rp deleted.rp "Page 1" "CONTENT_PANEL" "Form" "PANEL_IMAGE"
node scripts/remove-panel-state-content.mjs source.rp cleared.rp "Page 1" "CONTENT_PANEL" "Form" --all
# 无名或重名顶层实例：读取真实 ID 后显式定位
node scripts/remove-panel-state-content.mjs source.rp deleted-instance.rp "Page 1" "MASTER_PANEL" "Card" --ids 20
node scripts/fill-panel-state.mjs layout.rp source.rp replaced.rp "Page 1" "Page 1" "CONTENT_PANEL" "Form" --replace
# Master 根中的面板：第一个目标名称解释为母版名
node scripts/remove-panel-state-content.mjs source.rp master-cleared.rp NESTED_MASTER CONTENT_PANEL Form --master --all
node scripts/fill-panel-state.mjs layout.rp source.rp master-replaced.rp "Page 1" NESTED_MASTER CONTENT_PANEL Form --master --replace
```

删除按状态顶层唯一名称定位，可传多个名称；`--all` 仅清空该状态，保留状态 GUID、面板、其它状态和页面按钮。删除对象及不再被剩余根引用的私有闭包，保留共享对象。若剩余内容/交互仍引用待删元件则拒绝，先显式删除或改目标交互；不能留下无效运行时路径。2026-10-07 指定复杂组合已追加通过：递归移除被删 DynamicPanel 的子状态包；删除共享 ReferenceDiagramObject 实例，保留母版定义；清理 Repeater 的本地内联 DataSet 与行模板。活跃跨包对象/状态/DataSet 依赖、缺包或未知包条目拒绝。目标为 Page 顶层或 Master 根图中唯一面板的指定状态，Master 用 `--master`；无名/重名根可用 --ids，对应 API 为 widgetIds:[20]，与 widgets/all 互斥。

`--replace` 与 `--append` 互斥；替换先清旧内容，再按已有导入边界复制 Page 布局，允许复用旧名称，默认导入仍保护非空状态。源验证失败只影响内存中的候选，不写源文件。原生删除图片的状态 body 与生成件一致；指定 PNG 删除、五控件 Form 清空、新四控件替换及 GUI 默认文本改稿均通过保存关闭重开与预览。复杂清理阶段的三层面板替换、母版单实例删除/整组清空/表单替换、中继器清空/同名替换均通过 GUI 往返与指定交互；GUI 改新表单默认文本为 COMPLEX_REPLACED_GUI 后也通过。22 文件/147 审计、26 拒绝/回归/CLI 检查，证据 panel-complex-remove-20261007。追加 Base 标签覆盖双实例的单个删除/全清/替换、含内嵌 PNG 覆盖依赖实例的清空/替换也通过保存重开和预览；剩余覆盖与动作、替换后新表单及状态返回通过。原生删除对照一致；13 文件/114 检查证据见 panel-overrides-remove-20261007/evidence/override-remove-final-audit.json。删除实例保留共享母版定义，新控件与保留定义重名时，须在导入副本中先命名消歧。2026-10-08 Master 根状态的 PNG 删除、表单清空/替换、三层面板私有状态清理、Base 覆盖双实例导入/清空/替换及 GUI 改稿通过；26 文件/115 检查，见 panel-master-remove-20261008/REPORT.md。其它覆盖/资源/依赖/作用域及任意组合仍未验。

2026-10-08 追加 Page 根 MASTER_PANEL/Card 的直接 Base 图片覆盖清理：红 A/蓝 B 两个实例，删 A 后红 Stream 物理消失而蓝 B 保留；全清/四控件替换后两私有 PNG 都消失；A 更新为蓝后有两份蓝 Stream，清除 A 图片后恢复共享母版原图；同红图双实例删 A 后另一份红 Stream 保留。七件实际画布、保存关闭重开和预览通过，内外状态切回保留表单值；GUI 改剩余 B 的 y640 后重开，蓝图和动作保留。全 payload/tag4 与 raw record 检查，共享 Master/状态和 Doc 在离线操作中原字节保留。28 文件/136 审计、核心 116/116、MCP 56/56，见 direct-image-cleanup-20261008/REPORT.md。随后 Master NESTED_MASTER/CONTENT_PANEL/Form 中同七组直接 Base PNG 操作、原生删除与剩余 B y640 GUI 改稿重开/预览亦通过，27 文件/142 审计，见 Master 报告 (internal research reference)。仅这两个 Page/Master 状态与内嵌 PNG；其它 Master 作用域/资源、外部资源及其它格式未验。清除覆盖后旧路径定义、未用 GUID/字符串可保留，不把 PNG bytes 消失称为全部标识垃圾回收。

MCP `fill_panel_state` 使用 `targetMaster` 代替 `targetPage`，两者必须且只能传一个；宿主/输出可按已有会话规则省略。remove 工具传 `args:["NESTED_MASTER","CONTENT_PANEL","Form","--master","--all"],session:true`。API remove 使用 `master` 字符串，fill 使用 `targetMaster`。新增母版依赖登记到所属 MasterPackageInfo；删除实例保留共享定义和依赖。范围及未验组合以能力表为准。

2026-10-08 同一 Master 根 CONTENT_PANEL/Form 的三列七行 R7：直接/嵌套空导入、清空、四控件替换、同名重建与原表单 append 八件全部保存关闭重开及实际预览通过；增删改行与三层状态返回保留数据。独立 GUI 键盘改首行 MASTER_GUI_CUSTOMER 后重开，只更新另一条 Alice，改名行仍为 120。嵌套清理移除两个自有状态包；append 保留旧四控件 GUID/动作。DataSet 按 column-id 读值，R7.Data 与 Add/Update 动作私有数据集区分。27 文件/151 审计、核心 35/131，见 本轮报告 (internal research reference)。早期 AX setValue 显示已改而当次重开副本未改，保留对照，不推广为永不能保存。其它列类型/动作/作用域仍按能力表开放。

2026-10-08 原生单层 Layer 内目标面板追加通过：Page MASTER_PANEL/Card 的清空/四控件替换，以及 Master CONTENT_PANEL/Form 的空导入/PNG 追加/清空/R7 替换六件保存关闭重开与实际预览通过。Layer.DiagramObjects 记录成员，组合和面板仍在所属图 diagram-objects 中，现有定位器无需新参数或修改。GUI 默认文本 LAYER_GUI 改稿重开及原交互通过，组成员/控件身份保留；20 文件/106 审计，见 报告 (internal research reference)。多层组合、组动作/移动、连接线坐标系与其它组合不外推。

### 面板按内容调整尺寸

```bash
node scripts/set-panel-fit-to-content.mjs source.rp fitted.rp fit.json
```

```json
{"record":6,"widgetId":15,"enabled":true}
```

编号取自 CONTENT_PANEL 样本，真实工程须读取当前索引与 ID；`enabled` 须为 boolean，false 可关闭。只修改该面板的 native `fit-to-content`，保留内容坐标与包身份。Page 顶层面板的原生开关真值、生成件保存重开，以及预览 Form 380×279、Visual 900×608、返回 Form 380×279 的只读 DOM 实测均通过，交互值保留。两工具与替换入口的原证据见 `panel-replace-20261007/`：12 文件/94 审计与 39 拒绝/回归/CLI 检查全过。

2026-10-07 追加三层嵌套 PanelState、两层依赖 Master 内面板及 Page 负坐标组合：六个开启/关闭件全部 GUI 保存关闭重开；开启时 Visual 900×608、嵌套/母版 Form 860×480、负坐标 Form 180×79，关闭时均固定 900×560。复选框赋值、内层 Visual/Form 和母版外层 Empty/Card 返回保留值/勾选；母版及负坐标独立原生 GUI 开关、保存关闭重开后的预览与生成开启件一致。18 文件/187 检查全过，证据 `panel-autofit-more-20261007/evidence/autofit-final-audit-v2.json`。内容坐标未改，负坐标部分仍裁切；不承诺滚动、固定定位、100% 宽度、其它坐标/内容组合或任意嵌套深度。


2026-10-06 无依赖原生母版导入通过：源 Page 的 ReferenceDiagramObject 实例、Master 定义和 MasterPackageInfo/母版树注册整体复制；母版内 DynamicPanel 的状态包登记在 owning Master 下，普通页面里的状态仍归 owning Page。直接母版、面板内母版及母版内 Visual/Form 面板均保存关闭重开并实际运行本地文本动作和内外切状态，PNG/值保留。两个实例共享一个定义，GUI 将母版默认文本改为 MASTER_GUI 后保存重开，两个默认值更新；点击一实例只修改其自身文本。命令与上面相同，无新增参数。源母版名称与目标已有母版冲突时拒绝；LoadedRdoPackages/LoadedScreenshotPackages 和缺失包/注册也拒绝。依赖链与 ObjectOverrides 后续范围见下文，其它覆盖格式、外部目标/变量及继承资源不外推。

2026-10-06 原生母版依赖链追加通过：同一命令复制两层/三层母版依赖及依赖母版内 Visual/Form/PNG 组合。原生 dependencies 必须是含 `Axure:MasterPackageInfo` 引用和 type 2 的二元组；工具校验、递归搜集依赖，共享定义/注册 GUID，按子母版先于父母版的顺序插入记录，并给目标 Page 的 PackageInfo 登记直接母版依赖。三件生成副本实际保存关闭重开后，表单交互、内外状态切换及值/图片保留通过；GUI 修改被引用内层母版默认文本 DEPENDENCY_GUI 后重开预览默认值、原交互和状态切回仍通过。10 文件/66 检查全过。拒绝循环/缺失依赖、未知依赖类名或类型；不推定任意深度、其它实例覆盖格式、LoadedRdoPackages/LoadedScreenshotPackages、继承资源及外部作用域。

2026-10-07 同一导入命令可保留指定原生母版实例覆盖，无新增参数。ObjectOverrides 是交替 DiagramObjectPath 引用/值字典列表；值仅 Text/Image/ViewId，Base 的 ViewId 指向 NULL GUID。文字限 VectorShape、Checkbox、RadioButton 标签；ImageBox 覆盖须内嵌 PNG Stream/Extension/Hash。目标以 GUID 对应被引用 Master 的直接元件，或 owning Master 自有 PanelState 的元件；路径 rdo-path/repeater-path 必须空。先复制母版及状态包再校验目标，不按跨包对象数字 ID 匹配；覆盖路径不得用于其它普通交互引用。双实例文字覆盖、依赖母版内文字/图片覆盖、独立 GUI 只改一个实例标签及依赖母版覆盖改稿均经保存关闭重开与实际预览通过，图片/值与原交互保留。9 文件/105 审计与 38 拒绝/回归检查全过。该导入命令只保留已有覆盖，独立写入器见下文；表单默认值、非 Base 组件视图、样式覆盖、跨层路径、外部资源与其它图片格式仍拒绝或未验。

### 母版实例覆盖写入

先从当前文件读取实际记录索引与 ReferenceDiagramObject ID，再按被引用母版中的唯一元件名或内部 GUID 选目标。新工具只修改指定实例的 ObjectOverrides，不改共享母版定义或其它实例。

```bash
node scripts/set-master-overrides.mjs source.rp new.rp overrides.json
```

```json
{
  "record": 4,
  "instanceId": 10,
  "overrides": [
    {"target": "NATIVE_CHECKBOX", "text": "当前实例标签"},
    {"target": "NATIVE_RADIO", "clear": true}
  ]
}
```

上例索引来自双实例研究样本，不能套到其它工程。每项须且只须选 `target` 或 `targetGuid`，并且只含一个 `text`、`imagePath` 或 `clear:true` 操作；PNG 示例为 `{"target":"PANEL_IMAGE","imagePath":"/absolute/path/image.png"}`。目标须是被引用母版或其自有状态中的直接元件，文字只接受 VectorShape/Checkbox/RadioButton 标签，图片只接受 ImageBox 与 PNG 字节。清除须已有对应覆盖，恢复定义原值；旧路径定义仍保留。更新复用原路径，未指定的覆盖保持。已有非 Base 视图或复杂 rdo/repeater 路径拒绝。

双实例分别写标签、更新/清除第一实例文字、依赖母版内文字与 PNG 写入，以及原生 GUI 再改覆盖文字均已在 Page/Master 实例保存关闭重开并预览通过。2026-10-07 追加 PanelState 双实例标签创建/更新/清除与 GUI 单实例覆盖改稿、依赖母版 PNG 更新/清除均在独立 GUI 样本通过；新增证据 panel-writers-20261007/evidence/panel-writers-final-audit-v2.json 为 18 RP/116 检查；其它视图、样式、表单默认值、深层路径及其它图片格式未验。审计与边界见 `master-override-writer-20261007/`，9 RP/75 检查和 34 拒绝/回归/CLI 检查全部通过。


自适应使用单集合继承与覆盖参数：

```bash
node scripts/add-adaptive-view.mjs source.rp views.rp 768 1024 \
  --override "V768:内容区:w=450" \
  --override "V1024:内容区:w=600,h=300"
```

它会新增集合并绑定全部 Page；从无自适应配置的基座创建，已有视图配置的合并/精确更新尚无入口。覆盖只查页面顶层同名元件，跨页同名会匹配多页；先保证名称唯一。`--override` 支持 `w/h/x/y`，其余维度沿用基础值。查看输出中的未匹配提示并核对覆盖结果。页面绑定与预览边界见 [自适应视图](adaptive-views.md)。

中继器的排序、筛选、增删改单列及完整命令见 [中继器数据操作](repeaters.md)。`clone-closure.mjs` 是需要调用和挂载的库函数，不是独立 CLI；新中继器从 Axure 原生元件或已验证模板取得。

## 图片状态

目标须是真实图片元件。普通态 `image` 必填，`mouseover`（别名 `hover`）、`mousedown`、`selected`、`disabled` 为可选本地图片路径：

```bash
node scripts/add-interaction.mjs source.rp images.rp "图片框" \
  --event OnClick --action set-image target="图片框" \
  image="/absolute/a.png" mouseover="/absolute/b.png"
```

已有样本验证“点击变红 A → 悬停变蓝 B → 移出恢复 A”的循环。状态槽在设置图片动作触发后应用；点击前悬停不切图是该事件设计的正常结果。MouseDown 按住状态与松开恢复、Selected 选中/取消和 Disabled 已分别在指定 ImageBox GUI 往返副本通过。选中图片请添加 `set-check target="图片框" checked=true`，取消用 false；`set-selected` 是列表值操作。文件扩展名和真实格式保持一致，字节直接嵌入 `.rp`。

## 库接口与局部补丁

```js
import { readRecords, replaceRecord, insertRecord, appendPackage } from './scripts/rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './scripts/parse-payload.mjs';
import { readRp, formatRpSummary } from './scripts/rp-read.mjs';
import { createPanel } from './scripts/create-panel-clone.mjs';
import { closureOf, cloneInto } from './scripts/clone-closure.mjs';
```

这些 import 相对调用脚本位置，实际使用时改成可解析路径。`insertRecord(file, key, raw, beforeRecord)` 把记录插到指定记录之前（会移动其后所有记录的偏移，逐页替换必须从后往前）；`appendPackage` 追加到流尾——PanelState 类记录若被追加到流尾，GUI 编辑器双击编辑会报类型转换，须用 `insertRecord` 插在所属 Page 记录之前。

`patch-string.mjs source.rp out.rp "旧串" "新串"` 替换唯一 Page 记录中字符串表的唯一条目，同一条目的所有引用都受影响，不保证只改一个元件。

`patch-link-window.mjs source.rp out.rp current|new` 只识别早期样本的局部字节布局，是研究补丁，不是通用链接编辑器。

## 2026-10-05 追加运行时动作

以下动作已在 Axure RP 11.0.0.4137 macOS 的限定样本保存关闭重开后通过实际预览。用 `add-interaction.mjs` 的 `--action` 传入：

```text
scroll-to target=SCROLL_TARGET direction=vertical easing=none duration=500
scroll-to target=SCROLL_TARGET direction=horizontal easing=none duration=500
scroll-to target=SCROLL_TARGET direction=both easing=linear duration=5000
scroll-to target=SCROLL_TARGET direction=both easing=swing duration=5000
apply-style target=TRIGGER fill=#FF3366
apply-style target=TRIGGER fill=#FF3366 borderWidth=6
apply-style target=TRIGGER borderColor=#0000FF borderWidth=9
apply-style target=TRIGGER opacity=50
apply-style target=VALUE_PREVIEW fontSize=28
apply-style target=VALUE_PREVIEW fontFamily=Courier New
apply-style target=VALUE_PREVIEW textColor=#D72638
apply-style target=NATIVE_TEXT_FIELD textColor=#D72638
apply-style target=VALUE_PREVIEW bold=true
apply-style target=VALUE_PREVIEW underline=true
apply-style target=VALUE_PREVIEW strikethrough=true
apply-style target=TRIGGER borderWidth=6
apply-style target=TRIGGER clearPrevious=true
set-repeater-items-per-page target=ITEMS_REPEATER count=2
set-adaptive-view view=V768
set-adaptive-view view=base
```

`set-adaptive-view` 解析触发元件所在页面绑定的视图集，按名称或 base 定位，动作不需要 target 元件。`set-repeater-items-per-page` 是分页数量，不替换整个数据集；旧 `set-repeater-dataset` 仍拒绝。`apply-style` 当前开放纯色 `fill`、`borderColor=#RRGGBB`、`textColor=#RRGGBB`（原生 Style DOA ID 6）、`bold=true`（Style DOA ID 3 / Integer 0）、`bold=false`（Style DOA ID 3 / Integer 2；仅 Page 根文字 VectorShape true→false no-clear 样本通过）、`italic=true/false` 均拒绝：原生 ID 4 / Integer 0 可写入，但测试预览中点击 Trace 后 `fontStyle` 在 0/50/250 ms 仍为 normal、`underline=true`（Style DOA ID 5，Boolean true；`underline=false` 拒绝）、`strikethrough=true`（Style DOA ID 95 / Boolean true，RichText 映射且预览通过；Apply Style 勾选未直接核验；no-clear 运行时对照中 false 未能清除活动删除线，因此拒绝 false）、有限非负数 `borderWidth`、`opacity` 百分数 0–100（写为原生比例 0–1）、有限正数 `fontSize`（API 值乘 0.75 写入原生 DOA ID 2）、非空字符串 `fontFamily`（Typeface DOA ID 1）与 `clearPrevious`；默认样式完整复制 57 项属性，以保证 Axure 样式编辑器可打开。Page 本地 VectorShape 样本已验证 fill、borderWidth=6/9、`borderColor=#0000FF`、opacity=50 与 clearPrevious；另以直接文字 VectorShape 验证 `fontSize=28` 点击后放大、`fontFamily=Courier New` 点击后变为等宽字形、`textColor=#D72638` 点击后变红、`bold=true` 点击后变粗、`bold=false` 点击后恢复常规字重、`underline=true` 点击后加下划线、`strikethrough=true` 点击后加删除线，移出清除样式后恢复。其它样式字段、TextBox 其它样式、目标和作用域未验，详见 `apply-style-border-alpha-20261010/REPORT.md`、`apply-style-border-color-20261010/REPORT.md`、`apply-style-font-size-20261010/REPORT.md`、`apply-style-font-family-20261010/REPORT.md`、`apply-style-text-color-20261010/REPORT.md`、`apply-style-text-color-textbox-20261012/REPORT.md`、`apply-style-bold-20261010/REPORT.md`、`apply-style-bold-false-20261010/REPORT.md`、`apply-style-italic-false-20261010/REPORT.md`（旧 italic true 现场观察已被延迟 DOM 采样推翻） 、`apply-style-underline-20261010/REPORT.md` 和 `apply-style-strikethrough-20261010/REPORT.md`。`noLimit` 于 2026-10-06 保存重开后通过，自适应 auto 在独立页面恢复宽屏通过，带工具栏发布模式的原生差异见能力表。2026-10-09 Page 本地 VectorShape 目标的水平/双向无动画、双向 linear/swing 5000 ms，以及独立 GUI 改为水平 linear 3000 ms 后重开及实际预览通过；方向还支持 vertical。嵌套滚动容器、其它目标/作用域及其它未验参数组合不能按动作名推定通过。证据与调用边界见 capabilities.md 和研究 RESULTS。


## 2026-10-12 验收修复合同

条件Case用`when`与`description`，按实际活动树核对Condition和Case顺序。普通`link`动作必须且只能提供`page`或`url`，窗口仅current/new；Page名解析自身包GUID。跨文档connector状态21迁移未支持，未登记来源样式明确拒绝。有限GC与最小VectorShape仅研究目录候选，不在canonical命令注册表提供通用接口；清理不压缩GUID/字符串。四件验证与重建入口见<local-path> (internal research reference)。
