# 命令注册表与离线回归

> 本文件由 registry.mjs 自动生成，勿手编；改注册表后重跑 `node scripts/gen-capabilities.mjs -o <新文件.md>`。
> 登记证据仅描述已有指定样本。实际能力边界以 [capabilities.md](capabilities.md) 和 [验证流程](verification.md) 为准。

## 命令总览

| 命令 | 脚本 | 用途 | 输出定位 | 证据层级 |
| --- | --- | --- | --- | --- |
| list-custom-styles | custom-styles.mjs | 列出文件已有原生自定义样式及 GUID（不创建样式） | none | structure |
| rename-custom-style | rename-custom-style.mjs | 按样式身份级联改名，更新所有记录的 MatchInfo 与 StyleCache 名称 | index:3 | gui-roundtrip |
| rebind-widgets | rebind-widgets.mjs | 筛选元件并批量绑定文件中已有原生样式；可显式清除局部样式覆盖 | index:3 | gui-roundtrip |
| create-blank-project | create-blank-project.mjs | 创建 RP9 / RP11 单页空白 .rp，有对应本机模板时优先使用，否则合成 | index:2 | loaded |
| native-check | native-check.mjs | 用本机 Axure 自己的程序集无头加载 .rp，报告 Axure 是否接受该文件（加载级；需 macOS + Axure + .NET SDK） | none | loaded |
| create-global-variable | create-global-variable.mjs | 创建具名全局变量及字符串默认值（离线结构级） | index:3 | structure |
| create-blank-page | create-blank-page.mjs | 把与输入文件同版本的空白模板 Page 记录追加到已有 .rp 生成新空白页（跨版本模板会拒绝） | index:3 | gui-roundtrip |
| duplicate-page | duplicate-page.mjs | 按页名（或 --index 记录号）复制已有页面生成新页 | index:3 | gui-roundtrip |
| create-master | create-master.mjs | 复制已有 Axure:Master 记录并注册为新命名的母版 | index:3 | preview |
| place-master | place-master.mjs | 在指定页面上放置母版实例（ReferenceDiagramObject） | index:3 | gui-roundtrip |
| create-panel-clone | create-panel-clone.mjs | 克隆真实模板离线创建动态面板并插入状态包 | index:3 | gui-roundtrip |
| fill-panel-state | fill-panel-state.mjs | 把一个 Page 的控件闭包导入 Page 或 Master 所属 PanelState（支持 --master、--append/--replace、嵌套面板/中继器/母版/连接线自定义锚点及闭合内部交互） | index:4 | gui-roundtrip |
| remove-panel-state-content | remove-panel-state-content.mjs | 按顶层元件名删除、--ids 按 ID 删除或 --all 清空一个 PanelState | index:3 | gui-roundtrip |
| set-panel-fit-to-content | set-panel-fit-to-content.mjs | 按记录/元件 ID 写 native boolean fit-to-content 开关 | index:3 | gui-roundtrip |
| add-adaptive-view | add-adaptive-view.mjs | 为页面写入自适应视图集（Base+子视图）并按视图覆盖元件尺寸位置 | index:3 | gui-roundtrip |
| add-interaction | add-interaction.mjs | 向单个或多个元件/页面追加事件+动作交互（支持 items 批量事务、自动读取 .baseline.json 解析逻辑 ID、interactions JSON 与条件/边界/IsOver/GetPanelState 原生表达；优先使用 generate_prototype 内联 RP/1，此命令用于直接修补已有 .rp） | index:3 | gui-roundtrip |
| remove-interaction | remove-interaction.mjs | 按事件类型移除活动事件，或按 Case/Action 序号移除单个活动动作 | index:3 | gui-roundtrip |
| add-click-link | add-click-link.mjs | 给无交互的具名元件添加点击打开链接交互（capabilities.md 未列此工具，仅结构级） | index:3 | structure |
| index-library | index-library.mjs | 只读列出 .rplib 的目录、库项、顶层元件名称、类型、尺寸和文字 | none | structure |
| clone-library-widget | clone-library-widget.mjs | 从 .rplib 克隆单个原生控件到目标 .rp 页面 | index:4 | gui-roundtrip |
| clone-library-page-content | clone-library-page-content.mjs | 把 .rplib 库页的全部内容闭包导入目标 .rp 页面 | index:4 | gui-roundtrip |
| set-combobox-options | set-combobox-options.mjs | 设置唯一原生 ComboBox 的选项与选中项 | index:3 | gui-roundtrip |
| set-listbox-options | set-listbox-options.mjs | 设置唯一原生 ListBox 的选项、多选与选中索引 | index:3 | gui-roundtrip |
| set-native-table | set-native-table.mjs | 改写原生 Table 矩阵/行高/列宽，扩容时克隆单元格，格支持 {runs} 多 run；可选用同页 VectorShape 模板生成视觉合并覆盖块 | index:3 | gui-roundtrip |
| clone-native-connector | clone-native-connector.mjs | 克隆原生 Connector 与端点闭包到目标页面（支持自定义锚点 GUID/坐标/方向保留及 PanelState 源图，跨 diagram 端点拒绝） | index:4 | gui-roundtrip |
| set-connector-anchors | set-connector-anchors.mjs | 在同一 Page 或 PanelState 记录内把连接线端点挂接到元件或脱开为自由端 | index:3 | gui-roundtrip |
| set-widget-text | set-widget-text.mjs | 按页内名称、记录索引+对象 ID 或容器路径精确定位改写一个既有文本片段 | index:3 | gui-roundtrip |
| set-widget-richtext | set-widget-richtext.mjs | 整段重写原生 RichTextBlock 的段落与 runs（字体/字号/行距/对齐/原生列表级别/wrapping/trimming 及 run 全量键） | index:3 | gui-roundtrip |
| set-master-overrides | set-master-overrides.mjs | 按实例 ID 创建/更新/清除母版实例的文字覆盖或写入内嵌 PNG，不改共享定义 | index:3 | gui-roundtrip |
| name-widget | name-widget.mjs | 按旧名称快捷改名（可加页名），或按记录/对象 ID 精确改名；保留身份与交互 | index:3 | preview |
| patch-link-window | patch-link-window.mjs | 字节级改写唯一 Page 记录里链接打开方式 current/new（capabilities.md 未列，仅结构级研究工具） | index:3 | structure |
| patch-string | patch-string.mjs | 替换唯一 Page 记录中的一个已有字符串（研究用，capabilities.md 未列） | index:3 | structure |
| rp-read | rp-read.mjs | 只读解析 .rp 输出页面/元件/交互摘要或 JSON（含 dangling refs 检查） | none | structure |
| axvg build | axvg.mjs | 把布局规格 JSON 展开为完整 Axvg JSON（几何/样式编码） | flag:-o | channel-a |
| axvg paste | axvg.mjs | 把 Axvg JSON 写入剪贴板并触发 Axure 粘贴上画布（宿主按 --version / --bundle-id 显式绑定） | none | channel-a |
| axvg selftest | axvg.mjs | 内置几何/编码断言自检，不产出文件 | none | channel-a |

参数定位（原生 CLI 用法；统一入口使用同一参数顺序）：

- **list-custom-styles**：`node custom-styles.mjs <source.rp|source.rplib>`
- **rename-custom-style**：`node rename-custom-style.mjs <source.rp|rplib> <output.rp|rplib> <oldName> <newName>`
- **rebind-widgets**：`node rebind-widgets.mjs <source.rp|rplib> <output.rp|rplib> <styleGuid> <selector.json> [--reset-overrides]`
- **create-blank-project**：`node create-blank-project.mjs <output.rp> [--version 9|11]`
- **native-check**：`node native-check.mjs <file.rp> [--version 9|11] [--json]`
- **create-global-variable**：`node create-global-variable.mjs <source.rp> <output.rp> <VariableName> [--default-value "Value"]`
- **create-blank-page**：`node create-blank-page.mjs <input.rp> <output.rp> <newPageName>`
- **duplicate-page**：`node duplicate-page.mjs source.rp output.rp sourceName newName`
- **create-master**：`node create-master.mjs <source.rp> <output.rp> <SourceMasterName> <NewMasterName>`
- **place-master**：`node place-master.mjs <src.rp> <out.rp> <masterName> <pageIndex> [--x N --y N]`
- **create-panel-clone**：`node create-panel-clone.mjs <src.rp> <out.rp> <pageName> <panelName> [state...] [--x N --y N --w N --h N] [--page-index N]`
- **fill-panel-state**：`node fill-panel-state.mjs <source.rp> <target.rp> <new.rp> <sourcePage> <pageOrMaster> <panel> <state> [--master] [--append | --replace]`
- **remove-panel-state-content**：`node remove-panel-state-content.mjs source.rp new.rp <pageOrMaster> <panel> <state> [--master] (--all | --ids <id>... | <widgetName>...)`
- **set-panel-fit-to-content**：`node set-panel-fit-to-content.mjs source.rp new.rp spec.json`
- **add-adaptive-view**：`node add-adaptive-view.mjs <src.rp> <out.rp> [断点宽度...] [--override "<视图名>:<元件名>:w=<宽>[,h=<高>][,x=<x>,y=<y>]"]`
- **add-interaction**：`node add-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] [--baseline <file.baseline.json>] [--replace-event] (--json <spec.json> | --event <EventName> --action <type> [key=value ...])`
- **remove-interaction**：`node remove-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] --event <EventName> (--remove-event | --remove-action --case-index <n> --action-index <n>)`
- **add-click-link**：`node add-click-link.mjs source.rp output.rp widgetName url [current|new]`
- **index-library**：`node index-library.mjs <source.rplib> [--folder <path>] [--limit <N>] [--json]`
- **clone-library-widget**：`node clone-library-widget.mjs <source.rplib> <target.rp> <output.rp> <sourcePage|#record> <targetPage> <newName> [--source-widget <name|#id>] [--x N --y N --w N --h N]`
- **clone-library-page-content**：`node clone-library-page-content.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> [--x N --y N]`
- **set-combobox-options**：`node set-combobox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <zeroBasedIndex>]`
- **set-listbox-options**：`node set-listbox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <indices-json>] [--single]`
- **set-native-table**：`node set-native-table.mjs input.rp output.rp table.json`
- **clone-native-connector**：`node clone-native-connector.mjs <source.rp> <target.rp> <output.rp> <sourceRecord> <connectorId> <targetPage> [options-json]`
- **set-connector-anchors**：`node set-connector-anchors.mjs <source.rp> <output.rp> <pageName> <connector-name-or-selector-json> <endpoints-json>`
- **set-widget-text**：`node set-widget-text.mjs <source.rp> <output.rp> <pageName> <widgetName> <text>`
- **set-widget-richtext**：`node set-widget-richtext.mjs source.rp new.rp richtext.json`
- **set-master-overrides**：`node set-master-overrides.mjs source.rp new.rp overrides.json`
- **name-widget**：`node name-widget.mjs <source.rp> <new.rp> --name <oldName> --to <newName> [--page <pageName>]；或 --record <record> --widget <id> --to <newName>；兼容 <pageRecordsIndex|页名> <widgetId> <newName> [...]`
- **patch-link-window**：`node patch-link-window.mjs <source.rp> <new.rp> <current|new>`
- **patch-string**：`node patch-string.mjs <source.rp> <new.rp> <old string> <new string>`
- **rp-read**：`node rp-read.mjs <file.rp> [--json] [--full]`
- **axvg build**：`node axvg.mjs build <spec.json> -o <out.axvg.json>`
- **axvg paste**：`node axvg.mjs paste <file.axvg.json> [--no-menu] [--version 9|11] [--bundle-id <id>]`
- **axvg selftest**：`node axvg.mjs selftest`

## 库脚本

| 脚本 | 用途 | 证据层级 |
| --- | --- | --- |
| prototype-worker.mjs | 异步原型生成子进程；返回结构化生成结果并保持 MCP 可响应 | internal |
| image-structure.mjs | 图片重建分组、重复模式、共享样式和编辑边界的只读审阅 | structure |
| preview-runtime.mjs | 真实 Axure 浏览器预览操作、运行变量观测及源码映射诊断 | preview |
| interaction-lint.mjs | 原生交互公式、条件分组和全局变量用法静态检查 | structure |
| official-interactions.mjs | 静态解码 Axure 官方 HTML 页数据并定位 STO 编译错误 | preview |
| native-program-patch.mjs | 在既有 RP9 文档中增量编译并绑定交互程序 | structure |
| native-widget-identity.mjs | 原生 GUID、RP/1 源码映射及官方播放器元件 ID 的对应 | structure |
| authoring-workflow.mjs | 创作范例、只读诊断、绑定解释、活动版本指纹与受保护改稿闭环 | structure |
| version.mjs | Axure 版本边界：文件头识别（RP9 acef0900 / RP11 acef0b00）、目标版本解析、宿主与模板按版本绑定 | structure |
| version-adapt.mjs | 按目标版本裁剪/改写新建对象的共享适配器（所有 writer 复用，避免独立实现漏适配） | structure |
| fix-panel-registry.mjs | 补齐 RP 9 的面板注册链（DynamicPanelInfo/PanelDiagramInfo）；缺失时 RP 9 不渲染面板状态内容 | gui-roundtrip |
| version-lint.mjs | 按目标版本扫描文件里的版本专属键违规（三零查不出这类问题） | structure |
| version-fields.mjs | RP 9 / RP 11 动作与信息对象的字段差异表（由两版自带原生样本实测键集派生） | structure |
| pack-release.mjs | 按代码与使用文档白名单生成新发布目录和 SHA 清单，排除研究、Axure 资源和 fixture | internal |
| jobs.mjs | 后台异步生成/改稿与 macOS GUI 保存关闭重开队列：统一 jobs(list\|get\|cancel) 句柄管理，单服务内串行 | internal |
| blank-synthesizer.mjs | 用原生记录结构合成空白工程，不读取 Axure 或外部模板 | internal |
| blank-template.mjs | 按版本读取本机模板或合成原生空白工程 | internal |
| mcp-tools.mjs | 收敛后的 MCP 工具面（Studio / RP1 / 图片 / 会话 / 浏览器验证 / rp_inspect / rp_patch / rp_command），经 AxureSession 与原生库执行 | internal |
| gen-capabilities.mjs | 由注册表和完整离线回归生成确定性命令文档，-o 输出新文件 | internal |
| rp-records.mjs | .rp 记录流读写核心库（manifest/记录解析/替换/插入/追加），无 CLI 入口 | internal |
| parse-payload.mjs | payload 节点树解析/编码库（parsePayload/encodePayload/field/walkNodes）；含 main guard 仅作逐记录自测打印，不面向用户 | internal |
| clone-closure.mjs | 引用闭包计算与跨文档克隆库函数（closureOf/cloneInto），无 CLI 入口 | internal |
| ix-actions.mjs | 交互构造核心库（45 事件枚举 + 全部动作分支序列化器），无 CLI 入口 | internal |
| expr-schema.mjs | 一次性研究工具：扫描本机 .rplib 提取条件表达式语法统计（顶层直接执行，按任务指定归入库清单） | internal |
| widget-schema.mjs | 一次性研究工具：扫描本机 .rplib 提取各元件类型字段清单统计（顶层直接执行，按任务指定归入库清单） | internal |
| engine.mjs | 编排引擎库（AxureSession 按注册表分发、受保护成品红线与 AXURE_WRITE_ROOT 白名单），spawn 透传存量脚本，无 CLI 入口 | internal |
| trace.mjs | 截图临摹工具链入口（scan 字帖扫描 / crop 形态学膨胀擦字与 1x 安全裁切 / verify 透底与残差热力图 / build 一键编译 / selftest），封装 trace.py 与 trace-ocr.swift | channel-a |
| native-scene.mjs | RP/1 矩形场景直接写入 RP 9 原生编组、形状、文字和内嵌图片，无 GUI 或缓存依赖 | internal |
| native-acceptance.mjs | Ego Page 上逐步比对 RP/1 模型与原生预览，保存首错与删除最小反例 | internal |
| native-repeater.mjs | RP/1 原生 Repeater 模型、初始数据与行模板装配库 | internal |
| native-forms.mjs | RP/1 原生表单控件、选项、初态与交互状态样式装配库 | internal |
| runtime-expr.mjs | RP/1 有类型运行期 AST 到 Axure 原生变量、控件、行与目标行作用域表达式 | internal |
| proto.mjs | 声明式直接原型生成与双通道混合编译入口（支持 --spec <spec.json> 与 --preset、Web/Mobile 多主题、设备外框自动合成、多页装配与动态面板/原生控件/跨页交互离线装填），封装 proto.py | channel-a |
| merge-pages.mjs | 多页 .rp 工程装配工具与库（将多个单页或多页 .rp 合并为一个多页 .rp，重映射页面 GUID 并注册 Sitemap 树节点与 PackageDocument 映射） | loaded |
| extract-assets.mjs | 从 .rp 工程提取内嵌 PNG 位图资源及宿主的精确几何尺寸（x/y/w/h）并输出 manifest.json | structure |
| python.mjs | 跨平台 Python 3 解释器解析（Windows 使用 python / py，其他平台使用 python3） | internal |
| py.mjs | 按平台选择 Python 解释器执行脚本的 npm test 包装器 | internal |
| html-import.mjs | 通过 Headless Chrome CDP 提取本地 HTML 或在线网页的真实排版、表单与矢量结构为 RP/1 源码与规范 | internal |
| doctor.mjs | 跨平台环境自检与能力矩阵诊断 CLI（检查 Node、Python、Pillow/NumPy、Chrome 与 RP9 模板） | internal |

## 证据标签

- `structure`：结构级登记，不能替代 Axure 加载或行为检查。
- `loaded`：指定样本有加载记录。
- `preview`：指定样本有预览记录；具体动作和参数范围见能力表。
- `gui-roundtrip`：指定样本有原生保存、关闭、重开记录；不代表该命令全部组合已验证。
- `channel-a`：Axvg 剪贴板静态路线的登记标签，build/selftest 是离线编码检查，paste 是原生粘贴入口；标签本身不证明任意元件或行为通过。
- `internal`：内部库或研究工具，没有面向用户的能力承诺。

## 公开主回归状态

生成时实际运行 `node test/regression.mjs`：23 项断言，23 项通过。
这是离线回归；本次没有重跑 Axure 加载、保存重开和预览，原生证据仍按各样本的原记录范围使用。


运行：`npm test`。
