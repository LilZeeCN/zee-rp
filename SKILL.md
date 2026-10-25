---
name: zee-rp
description: Reconstruct screenshots as editable Axure layouts, compile RP/1 specifications into native prototypes, and inspect or edit RP9/RP11 files using CLI or MCP.
---

# zee-rp（RP/1 零手算原型创作与原生编辑）

已有全局自定义样式可用 `list_custom_styles` 查询、`rename_custom_style` 级联改名、`rebind_widgets` 批量绑定。全局定义先在 Axure UI 创建并保存，不直接注入新 `StyleSheet.CustomStyles`；详见 [样式工作流](references/custom-styles.md)。

> ⚡ **零跳读声明**：本文件已包含日常原型创作、单图视觉联审与增量改稿所需的**全部 RP/1 语法、宏属性表、完整范例与 MCP 调用模板**。日常从零做原型与改稿**只需读完本文件即可直接动手**，无需再翻阅 `references/` 子文档或 `scripts/` 源码！

## 一、标准 3 步极速闭环（生成 → 单图联审 → 增量改稿）

1. **生成原型**：编写 `.rp1` 源码（或直接选内置范例 `recipe: "mobile-cards" | "list-detail" | "step-form"`），调用 MCP `generate_prototype`：
   ```json
   {"source": "/abs/path/app.rp1", "output": "/abs/path/app.rp", "strictAudit": true}
   ```
   - 默认 `autoHeal: false`，与 CLI 一致；显式传 `true` 时尝试自愈，完整重验后回退引入新错误的变更，审计记录属性清单与回退原因，并产出 `<output>.baseline.json`。
2. **单图全景视觉联审（1 次看图审完全局）**：
   - 直接用 `read_file` 读取返回结果 `previews` 同目录下的 **`pages-sheet.png`**（或顶层 `contactSheet` 字段，全页面横向拼图）与 **`states-sheet.png`**（或顶层 `statesSheet` 字段，过滤内部合成态后的纯净动态面板状态拼图），无需逐页翻看单张 `01-*.png`。
3. **增量改稿（属性修改 + 结构级增删节点 + 跨面板深层定位）**：调用 MCP `revise_prototype`（保留原文件，输出新文件名或设 `"output": "auto"` 自动递增 `-v2.rp`）：
   ```json
   {
     "source": "/abs/path/app.rp1",
     "rp": "/abs/path/app.rp",
     "output": "/abs/path/app-v2.rp",
     "operations": [
       {"target": "home/hero", "property": "title", "value": "全新主标题"},
       {"target": "home/nested_btn", "property": "text", "value": "面板内深层节点直改"},
       {"op": "add", "path": "after:home/hero", "value": "list-item #item_new [fillxhug] tag=\"新增\" tagTone=\"brand\" title=\"结构级插入项\" subtitle=\"直接传 .rp1 片段\" rightBadge=\"待办\" rightTone=\"warning\" goto=\"detail\""},
       {"op": "remove", "path": "home/old_id"},
       {"path": "/palette/brand", "value": "#2563EB"}
     ]
   }
   ```
   - `target` 支持 `<page>/<id>` 直接跨动态面板状态唯一定位深层子节点，也支持完整路径 `<page>/<panel>/<state>/<id>`。
   - `op: "add"` 的 `path` 支持 `"after:<page>/<sibling_id>"`、`"before:<page>/<sibling_id>"` 或容器 `"<page>/<container_id>"`，`value` 直接传 `.rp1` 文本片段。
   - 耗时较长时传 `async: true`，立即返回任务句柄，用 `jobs_get({id})` 取 `result`；生成与改稿均支持，改稿可同时传 `dryRun: true`。成功改稿的预览、编译结果与报告位于 `<output>.assets/`，临时 `.revision-*` 自动删除。
   - 会话工具 `inspect` / `edit_text` / `rename_widget` / `set_widget_geometry` / `set_widget_style` 的 `target` 接受 locate 返回的 `{record,id,container}` 对象或该对象的 JSON 文本。`read_interactions` 读取统一的 `items` 分页列表（页面事件、顶层/嵌套元件、母版）；`offset` 是跳过条数，`returned` 是本次条数，按 `nextOffset` 继续。`contained` 仅列嵌套元件，为空不代表无交互；可用 `widget: "page/id"` 缩小范围。

---

## 二、RP/1 语法与全组件/宏属性速查表（零算高 `[fillxhug]` 模式）

- **尺寸铁律**：纵向容器、卡片、多行文本、动态面板、中继器一律写 **`[fillxhug]`**（宽铺满、高按内容自动测量；`panel` 自动取最高 `:state` 高度），按钮/输入框写 **`[fillx44]`** 或 **`[120x44]`**。节点 ID 前的 `#` 可写可省略。
- **属性边界与零静默丢参约定**：`fontSize` 范围为 `(0,72]`（含字号简写与 spans），`letterSpacing` 非负；`after` 必须引用同容器中的另一个节点，不存在会报 `E_REFERENCE`。未知属性、未知宏插槽名（`slots`）、`progress-bar` 同时声明 `percent` 与 `value`、以及对非 `enum` 字段声明 `filters: "auto"` 均返回 `E_PROPERTY` 错误，任何无法生效的声明或守卫（如 `wizard-card` 的 `nextWhen`）绝不静默丢弃。
- **设备画布**：页面声明 `device=iphone-17`（或顶层声明 `device="iphone-17"`）即可自动匹配 `402×874` 屏幕与 `442×914` 钛金属外壳，**推荐省略页面 `[WxH]`**。
- **合规设计令牌（`strictAudit: true` 零警告值）**：
  - 间距 `gap` / `padding`：`0, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 48`
  - 字号 `fontSize`：`11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36`
  - 圆角 `radius`：`0, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 999`

| 类别 | 语法与全部核心属性（复制即用） |
| :--- | :--- |
| **顶层声明** | `rp/1 target=9 name="应用名" domain=mobile theme=mobile-hifi`<br>`palette:` 下缩进写 `$brand = "#10B981"`（内置令牌：`$bg, $surface, $surface-2, $border, $text, $muted, $brand, $brand-soft, $success, $warning, $error`）<br>`var done: number = 2` 或 `var note: text = "默认备注"` |
| **共享底栏** | 顶层写 `tab-bar:`，缩进写 `item home "首页"`（首参为目标 `page` 的 ID，次参为文案）。自动注入所有 `phone-shell` 页、高亮当前页并自动吸底固定（单页隐藏可在 `phone-shell` 加 `tabBar=false`）。 |
| **页面与外壳** | `page #home name="首页" device=iphone-17`<br>  `phone-shell #shell title="主标题" subtitle="副标题" gap=12 statusRight="5G 100%"` |
| **指标卡行 `stat-row`** | `stat-row #stats [fillxhug] gap=10 items=[{"label":"今日目标","value":"=var.done","sub":"已完成","color":"$brand"},{"label":"达标率","value":"85%","sub":"+5%","color":"$success"}]` |
| **列表项 `list-item`** | `list-item #row1 [fillxhug] tag="高频" tagTone="brand" title="主标题" subtitle="副标题说明" rightBadge="进行中" rightTone="success" goto="detail"`<br>（`tagTone` / `rightTone` 可选：`brand` \| `success` \| `warning` \| `error` \| `neutral`） |
| **内容卡 `card`** | **一行内联模式**：`card #hero [fillxhug] padding=16 gap=8 tag="置顶" tagTone="brand" title="卡片标题" subtitle="副标题" body="自动折行正文内容" rightBadge="必做" rightTone="warning" actionText="立即前往" goto="detail"`<br>**容器模式**：`card #box_card [fillxhug] padding=16 gap=10` 后缩进写任意子元件。 |
| **多态面板 `panel`** | `panel #view_panel [fillxhug] tabs=["清单视图","统计视图"]:` 后缩进写 `:state list` 与 `:state chart`。每个 `:state` 下**直接缩进写多个子元件**（无需包 `root` 容器）；`tabs=[...]` 自动在各态顶部生成对应高亮的分段切换栏。 |
| **进度条 `progress-bar`** | `progress-bar #prog [fillxhug] value={"variable":"done"} max=5 label="完成进度" showValue=true barHeight=8`（隐藏右侧数值设 `showValue=false`） |
| **基础元件** | - 单行/折行标签：`label #lbl [fillxhug] "静态文字或 '=表达式'" fontSize=14 fontWeight=600 color=$text`<br>- 多行正文：`paragraph #p [fillxhug] "长段落自动折行..." fontSize=14 lineHeight=22 color=$muted`<br>- 原生输入框：`input #inp [fillx44] value="初始文本" placeholder="请输入..."`（离线预览图直接渲染文本）<br>- 按钮：`button #btn [fillx44] "提交" variant=primary goto="detail"`（`variant` 可选：`primary`/`brand`、`secondary`、`outline`、`ghost`、`soft`、`danger`/`error`、`success`、`warning`；可直接加 `goto="页面ID"` 跳页）<br>- 布局盒：`box #row_box [fillxhug] layout=row gap=8 padding=12 radius=12 fill=$surface`（`layout` 可选 `column` \| `row` \| `grid`） |
| **事件与表达式** | 元件下缩进写 `+onClick [...]`（动作数组）：<br>- 改变量：`{"type":"set-variable","variable":"done","value":"=var.done + 1"}`<br>- 改文本：`{"type":"set-text","target":"lbl","value":"='已记：' + @inp + ' (' + text(var.done) + ')'"}`<br>- 切面板：`{"type":"set-panel-state","target":"view_panel","state":"chart"}`<br>- 跳页面：`{"type":"link","page":"detail"}`（亦支持别名 `{"type":"goto","page":"detail"}` 或 `{"goto":"detail"}`）<br>- 显隐控制：`{"type":"show","target":"tip"}` / `{"type":"hide","target":"tip"}`（节点初始隐藏可加属性 `visible=false`）<br>**表达式速记**：读全局变量用 `var.变量名`，读同页输入框用 `@输入框ID`，拼接字符串用 `='前缀 ' + text(var.done) + ' 后缀'`。 |

---

## 三、可直接复制改写的完整多页 `.rp1` 模板

```text
rp/1 target=9 name="极速原型模板" domain=mobile theme=mobile-hifi
palette:
  $brand = "#10B981"

var done: number = 2
var note: text = "晨间专注"

tab-bar:
  item home "今日"
  item detail "录入"

page #home name="今日总览" device=iphone-17
  phone-shell #shell title="今日计划" subtitle="零手算流式布局示范" gap=12
    stat-row #stats [fillxhug] gap=10 items=[{"label":"已完成","value":"=var.done","sub":"今日打卡","color":"$brand"},{"label":"专注主题","value":"=var.note","sub":"当前任务","color":"$success"}]
    progress-bar #prog [fillxhug] value={"variable":"done"} max=5 label="今日目标进度" showValue=true barHeight=8
    panel #main_panel [fillxhug] tabs=["待办清单","重点卡片"]:
      :state list
        list-item #item1 [fillxhug] tag="高频" tagTone="brand" title="核心概念主动回忆" subtitle="点击跳转录入页更新备注" rightBadge="进行中" rightTone="success" goto="detail"
        list-item #item2 [fillxhug] tag="复盘" tagTone="warning" title="错题归因整理" subtitle="整理今日 3 道易错题" rightBadge="待办" rightTone="neutral" goto="detail"
      :state focus
        card #focus_card [fillxhug] padding=16 gap=8 tag="必做" tagTone="brand" title="深度专注 25 分钟" subtitle="番茄工作法" body="关闭通知干扰，完成一次完整的高强度知识检索。" rightBadge="推荐" rightTone="success" actionText="去打卡" goto="detail"

page #detail name="打卡录入" device=iphone-17
  phone-shell #shell2 title="打卡与备注" subtitle="实时修改变量并跨页同步" gap=12
    card #form_card [fillxhug] padding=16 gap=12
      label #form_title [fillxhug] "更新当前专注主题" fontSize=16 fontWeight=600
      input #note_inp [fillx44] value="晚间复盘" placeholder="输入新的专注主题..."
      label #feedback [fillxhug] "='当前已打卡 ' + text(var.done) + ' 次，主题：' + var.note" fontSize=14 color=$muted
      button #save_btn [fillx44] "打卡 +1 并同步主题" variant=primary
        +onClick [{"type":"set-variable","variable":"done","value":"=var.done + 1"},{"type":"set-variable","variable":"note","value":"=@note_inp"},{"type":"set-text","target":"feedback","value":"='已更新！共 ' + text(var.done) + ' 次，主题：' + @note_inp"}]
```

---

## 四、其他场景与按需参考（日常 RP/1 创作无需查阅）

- **视觉细节**：单个 label 在 `align=center justify=center` 的 row/column 中默认居中（显式 align 优先）；`image.radius/opacity` 写入图片 Alpha。导航可用 `activeIndicator=underline|dot|none`、`activeVariant`、`justify`、`itemFlex`，或让 `phone-shell.tabBar` 接完整 box。`panel [fillxhug]` 取所有状态的最大高度；状态拼图标注 viewport/content 尺寸。RP/1 暂无 `fontFamily` 和独立 `previewInitial`；字体、位图光效、初始态和导航示例见 [视觉创作说明](references/visual-authoring.md)。

- **安全与证据原则**：切勿覆盖用户原始 `.rp`（可用 `AXURE_PROTECTED_PATHS` / `AXURE_WRITE_ROOT` 限制）；汇报时区分结构校验、Axure 打开、离线预览、GUI 编辑与保存重开。
- **按需扩展文档（仅在对应特殊任务时读取）**：
  - 截图 1:1 转可编辑 `.rp`：`generate_from_image({image, output, scale, replace})` → [screenshot-workflow.md](references/screenshot-workflow.md)
  - 已有 `.rp` 检查/会话改名改字/三方同步：`verify` / `locate` / `inspect` / `edit_text` / `rename_widget` / `sync_prototype` → [mcp-prototype.md](references/mcp-prototype.md)
  - 浏览器真实预览点击校验与深度诊断：`diagnose_prototype` / `explain_binding` / `runtime_info` → [authoring-workflow.md](references/authoring-workflow.md)
  - 手机壳几何细节与最小示例 → [mobile-layout.md](references/mobile-layout.md)、[mobile-layout.rp1](examples/rp-language/mobile-layout.rp1)
  - 完整高阶语言手册（Repeater 增删改查/规则/母版）、能力表、HTML 重建与安装说明 → [rp-language.md](references/rp-language.md)、[capabilities.md](references/capabilities.md)、[html-workflow.md](references/html-workflow.md)、[README.zh-CN.md](README.zh-CN.md)
