# Public command registry

Generated from the shipped registry. Evidence tags refer to bounded samples, not universal compatibility.

| 命令 | 脚本 | 用途 | 证据层级 |
| --- | --- | --- | --- |
| create-blank-project | create-blank-project.mjs | 复制用户本机的 RP 9 / RP 11 原生空白模板生成单页空白 .rp 工程（模板按目标版本绑定） | loaded |
| create-global-variable | create-global-variable.mjs | 创建具名全局变量及字符串默认值（离线结构级） | structure |
| create-blank-page | create-blank-page.mjs | 把与输入文件同版本的空白模板 Page 记录追加到已有 .rp 生成新空白页（跨版本模板会拒绝） | gui-roundtrip |
| duplicate-page | duplicate-page.mjs | 按页名（或 --index 记录号）复制已有页面生成新页 | gui-roundtrip |
| create-master | create-master.mjs | 复制已有 Axure:Master 记录并注册为新命名的母版 | preview |
| place-master | place-master.mjs | 在指定页面上放置母版实例（ReferenceDiagramObject） | gui-roundtrip |
| create-panel-clone | create-panel-clone.mjs | 克隆真实模板离线创建动态面板并插入状态包 | gui-roundtrip |
| fill-panel-state | fill-panel-state.mjs | 把一个 Page 的控件闭包导入 Page 或 Master 所属 PanelState（支持 --master、--append/--replace、嵌套面板/中继器/母版/连接线自定义锚点及闭合内部交互） | gui-roundtrip |
| remove-panel-state-content | remove-panel-state-content.mjs | 按顶层元件名删除、--ids 按 ID 删除或 --all 清空一个 PanelState | gui-roundtrip |
| set-panel-fit-to-content | set-panel-fit-to-content.mjs | 按记录/元件 ID 写 native boolean fit-to-content 开关 | gui-roundtrip |
| add-adaptive-view | add-adaptive-view.mjs | 为页面写入自适应视图集（Base+子视图）并按视图覆盖元件尺寸位置 | gui-roundtrip |
| add-interaction | add-interaction.mjs | 向元件或页面追加事件+动作交互（支持 --replace-event、--on-page、--json 条件/多 Case；FCall 函数名按 18 项注册表白名单校验） | gui-roundtrip |
| remove-interaction | remove-interaction.mjs | 按事件类型移除活动事件，或按 Case/Action 序号移除单个活动动作 | gui-roundtrip |
| add-click-link | add-click-link.mjs | 给无交互的具名元件添加点击打开链接交互（capabilities.md 未列此工具，仅结构级） | structure |
| clone-library-widget | clone-library-widget.mjs | 从 .rplib 克隆单个原生控件到目标 .rp 页面 | gui-roundtrip |
| clone-library-page-content | clone-library-page-content.mjs | 把 .rplib 库页的全部内容闭包导入目标 .rp 页面 | gui-roundtrip |
| set-combobox-options | set-combobox-options.mjs | 设置唯一原生 ComboBox 的选项与选中项 | gui-roundtrip |
| set-listbox-options | set-listbox-options.mjs | 设置唯一原生 ListBox 的选项、多选与选中索引 | gui-roundtrip |
| set-native-table | set-native-table.mjs | 改写原生 Table 矩阵/行高/列宽，扩容时克隆单元格，格支持 {runs} 多 run；可选用同页 VectorShape 模板生成视觉合并覆盖块 | gui-roundtrip |
| clone-native-connector | clone-native-connector.mjs | 克隆原生 Connector 与端点闭包到目标页面（支持自定义锚点 GUID/坐标/方向保留及 PanelState 源图，跨 diagram 端点拒绝） | gui-roundtrip |
| set-connector-anchors | set-connector-anchors.mjs | 在同一 Page 或 PanelState 记录内把连接线端点挂接到元件或脱开为自由端 | gui-roundtrip |
| set-widget-text | set-widget-text.mjs | 按页内名称、记录索引+对象 ID 或容器路径精确定位改写一个既有文本片段 | gui-roundtrip |
| set-widget-richtext | set-widget-richtext.mjs | 整段重写原生 RichTextBlock 的段落与 runs（字体/字号/行距/对齐/原生列表级别/wrapping/trimming 及 run 全量键） | gui-roundtrip |
| set-master-overrides | set-master-overrides.mjs | 按实例 ID 创建/更新/清除母版实例的文字覆盖或写入内嵌 PNG，不改共享定义 | gui-roundtrip |
| name-widget | name-widget.mjs | 按 Page 记录序号/页名与对象 ID 设置元件名称（name-block） | preview |
| patch-link-window | patch-link-window.mjs | 字节级改写唯一 Page 记录里链接打开方式 current/new（capabilities.md 未列，仅结构级研究工具） | structure |
| patch-string | patch-string.mjs | 替换唯一 Page 记录中的一个已有字符串（研究用，capabilities.md 未列） | structure |
| rp-read | rp-read.mjs | 只读解析 .rp 输出页面/元件/交互摘要或 JSON（含 dangling refs 检查） | structure |
| axvg build | axvg.mjs | 把布局规格 JSON 展开为完整 Axvg JSON（几何/样式编码） | channel-a |
| axvg paste | axvg.mjs | 把 Axvg JSON 写入剪贴板并触发 Axure 粘贴上画布（宿主按 --version / --bundle-id 显式绑定） | channel-a |
| axvg selftest | axvg.mjs | 内置几何/编码断言自检，不产出文件 | channel-a |

库脚本（无 CLI 入口）：

| 脚本 | 用途 | 证据层级 |
| --- | --- | --- |
| version.mjs | Axure 版本边界：文件头识别（RP9 acef0900 / RP11 acef0b00）、目标版本解析、宿主与模板按版本绑定 | structure |
| version-adapt.mjs | 按目标版本裁剪/改写新建对象的共享适配器（所有 writer 复用，避免独立实现漏适配） | structure |
| fix-panel-registry.mjs | 补齐 RP 9 的面板注册链（DynamicPanelInfo/PanelDiagramInfo）；缺失时 RP 9 不渲染面板状态内容 | gui-roundtrip |
| version-lint.mjs | 按目标版本扫描文件里的版本专属键违规（三零查不出这类问题） | structure |
| version-fields.mjs | RP 9 / RP 11 动作与信息对象的字段差异表（由两版自带原生样本实测键集派生） | structure |
| pack-release.mjs | 按代码与使用文档白名单生成新发布目录和 SHA 清单，排除研究、Axure 资源和 fixture | internal |
| jobs.mjs | macOS GUI 保存关闭重开队列：wait:false 句柄、list/get/cancel，单服务内串行 | internal |
| blank-template.mjs | 解析用户本机空白模板 AXURE_BLANK_TEMPLATE 或本机缓存；不分发 Axure 模板 | internal |
| mcp-tools.mjs | 注册表驱动的 MCP 工具 schema、参数校验和 CLI 参数映射，经 AxureSession 执行 | internal |
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
| runtime-expr.mjs | RP/1 有类型运行期 AST 到 Axure 原生变量、控件、行与目标行作用域表达式 | internal |
| proto.mjs | 声明式直接原型生成与双通道混合编译入口（支持 --spec <spec.json> 与 --preset、Web/Mobile 多主题、设备外框自动合成、多页装配与动态面板/原生控件/跨页交互离线装填），封装 proto.py | channel-a |
| merge-pages.mjs | 多页 .rp 工程装配工具与库（将多个单页或多页 .rp 合并为一个多页 .rp，重映射页面 GUID 并注册 Sitemap 树节点与 PackageDocument 映射） | loaded |
| extract-assets.mjs | 从 .rp 工程提取内嵌 PNG 位图资源及宿主的精确几何尺寸（x/y/w/h）并输出 manifest.json | structure |
