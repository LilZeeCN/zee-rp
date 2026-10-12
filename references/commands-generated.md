# 发布命令注册表

> 由打包器根据发布注册表自动生成；勿手编。样本证据边界见 capabilities.md。

| 命令 | 脚本 | 用途 | 输出定位 | 登记证据 |
| --- | --- | --- | --- | --- |
| create-blank-project | create-blank-project.mjs | 复制用户本机的 RP 11 原生空白模板生成单页空白 .rp 工程 | index:2 | loaded |
| create-blank-page | create-blank-page.mjs | 把用户本机空白模板的 Page 记录追加到已有 .rp 生成新空白页 | index:3 | gui-roundtrip |
| duplicate-page | duplicate-page.mjs | 按页名（或 --index 记录号）复制已有页面生成新页 | index:3 | gui-roundtrip |
| create-master | create-master.mjs | 复制已有 Axure:Master 记录并注册为新命名的母版 | index:3 | preview |
| place-master | place-master.mjs | 在指定页面上放置母版实例（ReferenceDiagramObject） | index:3 | preview |
| create-panel-clone | create-panel-clone.mjs | 克隆真实模板离线创建动态面板并插入状态包 | index:3 | gui-roundtrip |
| fill-panel-state | fill-panel-state.mjs | 把一个 Page 的控件闭包导入空 PanelState（支持 --append/--replace、嵌套面板/中继器/母版） | index:4 | gui-roundtrip |
| remove-panel-state-content | remove-panel-state-content.mjs | 按顶层元件名删除、--ids 按 ID 删除或 --all 清空一个 PanelState | index:3 | gui-roundtrip |
| set-panel-fit-to-content | set-panel-fit-to-content.mjs | 按记录/元件 ID 写 native boolean fit-to-content 开关 | index:3 | gui-roundtrip |
| add-adaptive-view | add-adaptive-view.mjs | 为页面写入自适应视图集（Base+子视图）并按视图覆盖元件尺寸位置 | index:3 | gui-roundtrip |
| add-interaction | add-interaction.mjs | 向元件或页面追加事件+动作交互（支持 --replace-event、--on-page、--json 条件/多 Case） | index:3 | gui-roundtrip |
| remove-interaction | remove-interaction.mjs | 按事件类型移除活动事件，或按 Case/Action 序号移除单个活动动作 | index:3 | gui-roundtrip |
| add-click-link | add-click-link.mjs | 给无交互的具名元件添加点击打开链接交互（capabilities.md 未列此工具，仅结构级） | index:3 | structure |
| clone-library-widget | clone-library-widget.mjs | 从 .rplib 克隆单个原生控件到目标 .rp 页面 | index:4 | gui-roundtrip |
| clone-library-page-content | clone-library-page-content.mjs | 把 .rplib 库页的全部内容闭包导入目标 .rp 页面 | index:4 | gui-roundtrip |
| set-combobox-options | set-combobox-options.mjs | 设置唯一原生 ComboBox 的选项与选中项 | index:3 | gui-roundtrip |
| set-listbox-options | set-listbox-options.mjs | 设置唯一原生 ListBox 的选项、多选与选中索引 | index:3 | gui-roundtrip |
| set-native-table | set-native-table.mjs | 改写已有原生 Table 的矩阵/行高/列宽，扩容时克隆原生单元格 | index:3 | gui-roundtrip |
| clone-native-connector | clone-native-connector.mjs | 克隆原生 Connector 与端点闭包到目标页面并保留默认四边点键 | index:4 | gui-roundtrip |
| set-connector-anchors | set-connector-anchors.mjs | 把连接线两端定向挂接到元件或脱开为自由端 | index:3 | gui-roundtrip |
| set-widget-text | set-widget-text.mjs | 按页内名称、记录索引+对象 ID 或容器路径精确定位改写一个既有文本片段 | index:3 | gui-roundtrip |
| set-widget-richtext | set-widget-richtext.mjs | 整段重写原生 RichTextBlock 的段落与 runs（字体/字号/样式/对齐） | index:3 | gui-roundtrip |
| set-master-overrides | set-master-overrides.mjs | 按实例 ID 创建/更新/清除母版实例的文字覆盖或写入内嵌 PNG，不改共享定义 | index:3 | gui-roundtrip |
| name-widget | name-widget.mjs | 按 Page 记录序号/页名与对象 ID 设置元件名称（name-block） | index:3 | preview |
| patch-link-window | patch-link-window.mjs | 字节级改写唯一 Page 记录里链接打开方式 current/new（capabilities.md 未列，仅结构级研究工具） | index:3 | structure |
| patch-string | patch-string.mjs | 替换唯一 Page 记录中的一个已有字符串（研究用，capabilities.md 未列） | index:3 | structure |
| rp-read | rp-read.mjs | 只读解析 .rp 输出页面/元件/交互摘要或 JSON（含 dangling refs 检查） | none | structure |
| axvg build | axvg.mjs | 把布局规格 JSON 展开为完整 Axvg JSON（几何/样式编码） | flag:-o | channel-a |
| axvg paste | axvg.mjs | 把 Axvg JSON 写入剪贴板并触发 Axure 粘贴上画布 | none | channel-a |
| axvg selftest | axvg.mjs | 内置几何/编码断言自检，不产出文件 | none | channel-a |

CLI 参数：

- **create-blank-project**：`node create-blank-project.mjs <output.rp>`
- **create-blank-page**：`node create-blank-page.mjs <input.rp> <output.rp> <newPageName>`
- **duplicate-page**：`node duplicate-page.mjs source.rp output.rp sourceName newName`
- **create-master**：`node create-master.mjs <source.rp> <output.rp> <SourceMasterName> <NewMasterName>`
- **place-master**：`node place-master.mjs <src.rp> <out.rp> <masterName> <pageIndex> [--x N --y N]`
- **create-panel-clone**：`node create-panel-clone.mjs <src.rp> <out.rp> <pageName> <panelName> [state...] [--x N --y N --w N --h N] [--page-index N]`
- **fill-panel-state**：`node fill-panel-state.mjs <source.rp> <target.rp> <new.rp> <sourcePage> <targetPage> <panel> <state> [--append | --replace]`
- **remove-panel-state-content**：`node remove-panel-state-content.mjs source.rp new.rp <page> <panel> <state> (--all | --ids <id>... | <widgetName>...)`
- **set-panel-fit-to-content**：`node set-panel-fit-to-content.mjs source.rp new.rp spec.json`
- **add-adaptive-view**：`node add-adaptive-view.mjs <src.rp> <out.rp> [断点宽度...] [--override "<视图名>:<元件名>:w=<宽>[,h=<高>][,x=<x>,y=<y>]"]`
- **add-interaction**：`node add-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] [--replace-event] --event <EventName> --action <type> [key=value ...]`
- **remove-interaction**：`node remove-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] --event <EventName> (--remove-event | --remove-action --case-index <n> --action-index <n>)`
- **add-click-link**：`node add-click-link.mjs source.rp output.rp widgetName url [current|new]`
- **clone-library-widget**：`node clone-library-widget.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> <newName> [--x N --y N --w N --h N]`
- **clone-library-page-content**：`node clone-library-page-content.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> [--x N --y N]`
- **set-combobox-options**：`node set-combobox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <zeroBasedIndex>]`
- **set-listbox-options**：`node set-listbox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <indices-json>] [--single]`
- **set-native-table**：`node set-native-table.mjs input.rp output.rp table.json`
- **clone-native-connector**：`node clone-native-connector.mjs <source.rp> <target.rp> <output.rp> <sourceRecord> <connectorId> <targetPage> [options-json]`
- **set-connector-anchors**：`node set-connector-anchors.mjs <source.rp> <output.rp> <pageName> <connectorName> <endpoints-json>`
- **set-widget-text**：`node set-widget-text.mjs <source.rp> <output.rp> <pageName> <widgetName> <text>`
- **set-widget-richtext**：`node set-widget-richtext.mjs source.rp new.rp richtext.json`
- **set-master-overrides**：`node set-master-overrides.mjs source.rp new.rp overrides.json`
- **name-widget**：`node name-widget.mjs <source.rp> <new.rp> <pageRecordsIndex|页名> <widgetId> <newName> [...]`
- **patch-link-window**：`node patch-link-window.mjs <source.rp> <new.rp> <current|new>`
- **patch-string**：`node patch-string.mjs <source.rp> <new.rp> <old string> <new string>`
- **rp-read**：`node rp-read.mjs <file.rp> [--json] [--full]`
- **axvg build**：`node axvg.mjs build <spec.json> -o <out.axvg.json>`
- **axvg paste**：`node axvg.mjs paste <file.axvg.json> [--no-menu]`
- **axvg selftest**：`node axvg.mjs selftest`

库脚本：

| 脚本 | 用途 | 登记证据 |
| --- | --- | --- |
| pack-release.mjs | 按代码与使用文档白名单生成新发布目录和 SHA 清单，排除研究、Axure 资源和 fixture | internal |
| jobs.mjs | macOS GUI 保存关闭重开队列：wait:false 句柄、list/get/cancel，单服务内串行 | internal |
| blank-template.mjs | 解析用户本机空白模板 AXURE_BLANK_TEMPLATE 或本机缓存；不分发 Axure 模板 | internal |
| mcp-tools.mjs | 注册表驱动的 MCP 工具 schema、参数校验和 CLI 参数映射，经 AxureSession 执行 | internal |
| rp-records.mjs | .rp 记录流读写核心库（manifest/记录解析/替换/插入/追加），无 CLI 入口 | internal |
| parse-payload.mjs | payload 节点树解析/编码库（parsePayload/encodePayload/field/walkNodes）；含 main guard 仅作逐记录自测打印，不面向用户 | internal |
| clone-closure.mjs | 引用闭包计算与跨文档克隆库函数（closureOf/cloneInto），无 CLI 入口 | internal |
| ix-actions.mjs | 交互构造核心库（45 事件枚举 + 全部动作分支序列化器），无 CLI 入口 | internal |
| engine.mjs | 编排引擎库（AxureSession 按注册表分发、受保护成品红线与 AXURE_WRITE_ROOT 白名单），spawn 透传存量脚本，无 CLI 入口 | internal |

`channel-a` 是静态剪贴板路线登记标签，不能当作任意元件或行为通过。其余证据标签只适用 capabilities.md 的指定样本。

研究 fixture 与快照不随发布包；本包没有实时 fixture 全绿结论。运行 `npm test` 可在用户本机模板上执行 23 项对拍/路径检查。
