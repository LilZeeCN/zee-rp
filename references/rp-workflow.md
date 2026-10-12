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

PanelState 的 `record/widgetId` 定位已在六段/17 run 样本完成真实保存重开和预览，独立 GUI 将 Blue 改为 Blue GUI 后保留格式。原生编辑会对缺字字体做回退（本样本中文/全角冒号为 PingFang SC）；不得推定列表/行距/超链接等尚未开放格式。证据见 `panel-writers-20261007/evidence/panel-writers-final-audit-v2.json`。

```bash
node scripts/set-widget-richtext.mjs source.rp rich-text.rp richtext.json
```

```json
{
  "page": "Page 1",
  "widget": "RICH_TEXT",
  "defaults": {"fontFamily": "Arial", "size": 24, "color": "#222222", "bold": false},
  "paragraphs": [
    {"align": "left", "runs": [
      {"text": "标题", "style": {"bold": true, "size": 32}},
      {"text": " · explanation", "style": {"italic": true}}
    ]},
    {"align": "right", "runs": [{"text": "页脚", "style": {"underline": true, "color": "#245BDB"}}]}
  ]
}
```

页面与元件名称须唯一；显式定位可改用 `record` 与 `widgetId`，只处理 Page/PanelState。目标须已有原生 RichTextBlock、段落/run 与 MyStyle。每个 paragraph 至少一个 run；run 内不放换行，段落之间自动添加换行，空段落用 `{"runs":[{"text":""}]}`。`align` 为 left/center/right；style/defaults 还可写 `strikethrough`，布尔项与字号须为对应 JSON 类型，颜色为 `#RRGGBB`。未给出的格式沿用首个原生 run/paragraph 模板，整段原文会被替换。

writer 保留元件/文本身份，同步控件样式的统一与混合属性标志，避免继承样式在加载时覆盖 runs。2026-10-06 的 Page VectorShape 两种样本完成 GUI 保存关闭重开和预览；GUI 改写蓝色片段、给斜体加下划线、新增中文段落也保留。PanelState 路径已在后续指定样本完成 GUI 验收；列表/行距/超链接等未验；字体缺字会由 Axure 替换，AutoFit 可在进入 GUI 编辑后调整高度/位置。证据见项目 RESULTS 末尾 `richtext-20261006/`。

### 原生表格与连接线

```bash
node scripts/set-native-table.mjs source.rp table.rp table.json
node scripts/clone-native-connector.mjs native.rp target.rp connector.rp \
  PAGE_RECORD CONNECTOR_ID "Page 1" '{"dx":0,"dy":0}'
node scripts/set-connector-anchors.mjs source.rp anchored.rp "Page 1" "Anchored Connector" \
  '{"start":{"widget":"SET_BUTTON","side":"right"},"end":{"widget":"VALUE_PREVIEW","side":"left"}}'
```

Table 输入须含一个可匹配的原生 Table；JSON 用 `cells` 矩形二维数组、`columnWidths`、`rowHeights`，可用 `table` 按名字选择。已验 4×4、1×1、1×5、5×1、5×6 的 GUI 往返与逐格预览，包括缩减和新增单元格；扩容后 R5C6 的原生 GUI 改稿也通过。每格须一个文本 run，合并/多 run 单元格与全部尺寸/build 未验；缩减后旧格定义保留。

Connector 的 `PAGE_RECORD`/`CONNECTOR_ID` 由当前 `rp-read` 定位。`clone-native-connector.mjs` API 的 options 接受 `name/startName/endName/dx/dy`，复制 Connector 和两端形状闭包，重绑目标页并保留原生四边连接点键；仅允许页面直接子级 VectorShape，拒绝自定义点和嵌套端点。两端自由也可复制，但不复制无关形状。继承目标工程全局样式可能改变外观，须复核。

`set-connector-anchors.mjs` 的 start/end 可省略其一，传 `null` 则脱开对应端点；挂接传 `{widget,side}`，side 为 top/left/right/bottom，名称须唯一且为页面直接子级。工具保留原生缓存几何和控制点，由 Axure 按形状与点键计算端点。默认四边键与原生 UI 真值一致；编辑器移动形状后的保存重开跟随已验。预览中的 Move 不带动线端，原生 UI 对照亦如此，不能承诺运行时自动跟随。

### 给无名元件命名

```bash
# PAGE_ORDINAL 只计 Axure:Page 记录，从 0 起；WIDGET_ID 是该记录内的对象 ID：
node scripts/name-widget.mjs source.rp named.rp PAGE_ORDINAL WIDGET_ID "提交按钮"
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

常用动作参数（完整实现见 `ix-actions.mjs`，验证范围见 [能力表](capabilities.md)）：

| 动作 | 参数 |
|---|---|
| `show/hide/toggle` | `target`、`duration` 毫秒、`animation`，如 `none/fade/slideDown` |
| `move` | `target`、`x/y` 位移，默认 0；不是 `dx/dy` |
| `set-position` | `target`、`x/y` 绝对位置 |
| `wait` | `ms` 毫秒 |
| `set-opacity` | `target`、`opacity` 百分数，如 50、`duration` 毫秒 |
| `set-panel-state` | `target`、`state` 真实状态名或 `next/previous`；`loop=true/false` |
| `set-size` | `target`、`width/height`、`duration` |
| `set-text` | `target`、`text`；当前实现走表单文本赋值，对 VectorShape 的负面样本不能当作标签文本修改能力 |
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

操作符为 `&&/||/==/!=/>/</>=/<=` 的枚举，但两侧只接受字符串/数字字面量、`{value:...}` 或 `{widget,fn}`，不支持递归组合的条件树。省略 `left` 时元件事件默认读触发元件文本；页面事件须显式给 `left`。JSON 的 `page:true` 表示 `target` 是页面名；限定元件所在页可使用 `"target":{"widget":"提交按钮","page":"订单页"}`，或 CLI `--on-page`。

## 页面与母版

```bash
node scripts/duplicate-page.mjs source.rp pages.rp "源页面名" "新页面名"
node scripts/create-master.mjs source.rp masters.rp "已有母版名" "新母版名"
# PAGE_RECORD_INDEX 替换为 rp-read 显示的数字：
node scripts/place-master.mjs source.rp instance.rp "已有母版名" PAGE_RECORD_INDEX --x 100 --y 100
```

母版创建工具执行复制；不是从任意页面创建母版。页面 `--by-index` 克隆分支属于已知失败实验，不用于日常复制。

## 动态面板及其他高级能力

先读 [能力表](capabilities.md) 中的限制。克隆面板的正确入口：

```bash
node scripts/create-panel-clone.mjs source.rp panel.rp "页面名" "新面板名" "状态一" "状态二" --x 100 --y 100 --w 300 --h 200
# 名称解析不适用时，在上述命令末尾加入 --page-index 数字；页面名位置参数仍需保留。
```

模板默认来自 macOS 安装目录下的 `Quick Win.rp` / `Hours Panel`。其他位置可用现有 `AXURE_PANEL_TEMPLATE` 和 `AXURE_PANEL_TEMPLATE_NAME` 环境变量指定。状态包为空；GUI 双击编辑态已于 2026-09-22 在修复件复验通过（三处对齐 UI ground truth：清洗模板残留孤儿 DiagramObject/Style 与 StyleCache 条目、状态包挂目标 Page 的 children、PanelState 记录插在其所属 Page 记录之前）。已知拒读的手写路线源码归档在 研究记录（本地研究参考不随发布包），不作为交付工具。

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
```

删除按状态顶层唯一名称定位，可传多个名称；`--all` 仅清空该状态，保留状态 GUID、面板、其它状态和页面按钮。删除对象及不再被剩余根引用的私有闭包，保留共享对象。若剩余内容/交互仍引用待删元件则拒绝，先显式删除或改目标交互；不能留下无效运行时路径。2026-10-07 指定复杂组合已追加通过：递归移除被删 DynamicPanel 的子状态包；删除共享 ReferenceDiagramObject 实例，保留母版定义；清理 Repeater 的本地内联 DataSet 与行模板。活跃跨包对象/状态/DataSet 依赖、缺包或未知包条目拒绝。目标限 Page 顶层面板的指定状态；无名/重名根可用 --ids，对应 API 为 widgetIds:[20]，与 widgets/all 互斥。

`--replace` 与 `--append` 互斥；替换先清旧内容，再按已有导入边界复制 Page 布局，允许复用旧名称，默认导入仍保护非空状态。源验证失败只影响内存中的候选，不写源文件。原生删除图片的状态 body 与生成件一致；指定 PNG 删除、五控件 Form 清空、新四控件替换及 GUI 默认文本改稿均通过保存关闭重开与预览。复杂清理阶段的三层面板替换、母版单实例删除/整组清空/表单替换、中继器清空/同名替换均通过 GUI 往返与指定交互；GUI 改新表单默认文本为 COMPLEX_REPLACED_GUI 后也通过。22 文件/147 审计、26 拒绝/回归/CLI 检查，证据 panel-complex-remove-20261007。带实例覆盖的删除、Master 所属状态删除、其它资源/依赖/作用域及任意组合仍未验。

### 面板按内容调整尺寸

```bash
node scripts/set-panel-fit-to-content.mjs source.rp fitted.rp fit.json
```

```json
{"record":6,"widgetId":15,"enabled":true}
```

编号取自本轮 CONTENT_PANEL 样本，真实工程须读取当前索引与 ID；`enabled` 须为 boolean，false 可关闭。只修改该面板的 native `fit-to-content`，保留内容坐标与包身份。Page 顶层面板的原生开关真值、生成件保存重开，以及预览 Form 380×279、Visual 900×608、返回 Form 380×279 的只读 DOM 实测均通过，交互值保留。PanelState/Master 定位仅有代码，负坐标及更多嵌套/滚动/定位组合未 GUI 验，不推定任意自动尺寸。两工具与替换入口的证据见 `panel-replace-20261007/`：12 文件/94 审计与 39 拒绝/回归/CLI 检查全过。


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
apply-style target=TRIGGER fill=#FF3366
set-repeater-items-per-page target=ITEMS_REPEATER count=2
set-adaptive-view view=V768
set-adaptive-view view=base
```

`set-adaptive-view` 解析触发元件所在页面绑定的视图集，按名称或 base 定位，动作不需要 target 元件。`set-repeater-items-per-page` 是分页数量，不替换整个数据集；旧 `set-repeater-dataset` 仍拒绝。样式目前仅开放纯色填充。`clearPrevious`、`noLimit`、自适应 auto、其他方向/动画均仅有构造或待验证，不能按动作名推定通过。证据与调用边界见 capabilities.md 和研究 RESULTS。
