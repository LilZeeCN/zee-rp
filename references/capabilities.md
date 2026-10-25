# 能力与验证边界

发布版本 0.2.1，2026-10-25。下列结论仅适用于各自记录的样本与验证层级。

2026-10-25 GitHub #1/#2：新增已有原生全局样式的查询、级联改名及批量绑定（CLI/MCP），同步基样式 GUID、MatchInfo 与 StyleCache，按库身份隔离同名外部引用；默认保留局部覆盖，可显式清除格式覆盖。全局样式定义须先由 Axure 创建，不提供凭空注入接口；含对象/包引用的复杂样式拒绝。合成 RP/RPLIB 回归 8/8、真实 stdio 三接口通过；RP9 单元件样本加载、保存、关闭重开后样式名与几何保留，无伪星号。只改定义的对照件确认文件残留旧引用名，但 RP9 同样无星号，未复现报告中的星号症状。母版/面板状态为结构证据，未推广 GUI 结论。见 [样式流程](custom-styles.md)。

2026-10-24 问题报告修复：源码深度上限为 160 层 JSON 容器（提前 E_DEPTH）；校验 palette 六位十六进制颜色、设备名、显式 views selector、statecharts 形状/初态/转移状态；普通元件 load 事件拒绝。statecharts 保留为 IR 元数据，不自动生成宿主状态转移；实际动作仍须显式声明。用法见 [README](../README.zh-CN.md)，实际发布检查见 [verification](../docs/verification.md)。

| 能力 | 当前范围 |
| --- | --- |
| 创作与诊断工作流 | `prototype_recipe` 提供学习卡片、列表详情、分步表单三套完整 RP/1 范例；`generate_prototype(recipe)` 保留独立源码并默认精简响应；`revise_prototype` 串联最小补丁、原生漂移检查、三方合并、生成及新基线；`diagnose_prototype` 收集独立节点诊断并保留依赖检查边界；`explain_binding` 提供静态表达式/依赖/刷新事件；`runtime_info` 返回活动服务与磁盘指纹、工具清单指纹及 Python 图片依赖。候选修复不自动应用；诊断 source 支持对象、文件路径及客户端序列化的 JSON 对象文本。见 [创作说明](authoring-workflow.md)。 |
| 图片转布局与 MCP | `trace.mjs` 与 MCP `generate_from_image` 支持 OCR、几何卡片/分割线/圆形识别、独立图标与擦字媒体切片（持久化于 `<output>.assets/`）、单行替换超宽自动扩宽、RP9 原生二进制直生（支持 `page` 命名）、`visualDiff` 薄页/宿主窗口像素差分、`.baseline.json` 保护及 `sync_prototype` 导回；需 macOS Vision、Swift 与 Python 包。复杂图像并非全部矢量。 |
| 原生读写与只读直查 | RP9/RP11 版本感知读取与编辑（含跨动态面板 `set-text` 目标全量 GUID 解析）；页、文字、富文本、几何 (`set_widget_geometry`)、样式 (`set_widget_style`)、改名 (`rename_widget`)、交互、面板、母版、表格、连接线、中继器工具。`edit_text`/`locate`/`inspect` 支持直接按 RP/1 逻辑 `id`（结合 `.baseline.json` `sourceMap` 或编译器内部名）定位元件；`verify`/`locate`/`inspect`/`read_interactions` 支持传入 `path`/`rp`/`rpFile`/`file` 零副本只读直查（不建 `.work-N.rp`，不切活动会话）。 |
| RP/1 | JSON/`.rp1` 文本语法（支持全组件 `[fillxhug]` 零算高自动测量、`stat-row`/`list-item`/`card` 内联简写、`panel tabs=[...]` 自动分段栏、面板状态 `children` 简写嵌套在 `phone-shell` 等宏内前置归一化免手写 `root`、顶层 `tabBar`/`tab-bar:` 自动注入各页并吸底、`tokens`/`palette` 多行保留、`# 注释` 保留、`component <Name>(...)` 一等定义、`device: "iphone-17"` 等现代手机预设、`panel`/`tab-bar`/`nav-bar`/`progress-bar`/`phone-shell` 宏、`visible: false`/`hidden: true` 初始隐藏、`paragraph` 作为 `set-text` 目标、`@panel/state/widget` 或 `panel.state.widget` 跨作用域引用、嵌套 `stack` 相对父容器坐标、显式坐标 `button`、无子元件透明热区 `box`、`+onClick={...}` 与 `goto`/`link`/`navigate` 简写、拼写纠错建议及行列号 `sourceSpan` 诊断）、类型/引用检查、布局、主题、组件、输入、面板、中继器、数据、表达式及规则。近期原生行为证据限 macOS RP9 指定样本。 |
| MCP 完整原型生成 | `generate_prototype` 接收 RP/1 `spec` 对象或 `source`/`sourcePath`（`.rp1`/`.json`），支持 `async: true`（配合 `jobs_list`/`jobs_get`/`jobs_cancel`）、默认 `autoHeal: false`（与 CLI 一致；显式开启会完整重验并回退新增错误，审计记录变更）、相对/绝对 `output`、`overwrite: true`、`compact: true`、`template` 显式空白模板、顶层 `previews` 速查表（含 `contactSheet` 多页总览图与过滤 `_fill` 后的 `statesSheet` 状态总览图）及旧 `.build-*` 自动清理；完成 RP9 多页装配、跨页引用、结构与事件覆盖检查，写出 `<output>.baseline.json` 并返回文件、页面标识及带行列号/源码片段的诊断。已验三页（零警告通过 `strictAudit`）及「知序」十二页（69 个恢复交互控件、RP9 GUI 改稿保存重开、导出 HTML 12 页零断裂 `_img` 及 17 项业务流/递归倒计时断言）。见 [用法](mcp-prototype.md)。 |
| 元件命名 | RP/1 显式 `name` 写入 OUTLINE，缺省保留稳定内部名；中文/空格/符号/重名及面板、行模板已验结构。快捷 CLI `name-widget --name ... --to ...` 和 MCP `rename_widget` 支持直接或批量改名，重名用记录/对象 ID 消歧。RP9 指定样本已验保存重开与改名后的交互预览。 |
| 详情选择 | 指定样本的连续新增、修改、删除已验；selection-scan 仍是运行时 O(n) 扫描。选中行快照不代表全数据集跨页持久化。 |
| RP/1 母版 | 基础文字、按钮、输入与导航；页面 slot 注入同 ID 占位容器，内容保留为独立页面元件（可含面板/中继器）。移动外壳共享宽度、机壳坐标与页面分组层级已验；两页 RP9 保存重开、列表选择 → 详情、computed/views 与 slot adaptive 真实预览通过。共享母版本身含动态面板/中继器仍明确拒绝。 |
| RP/1 自适应 | 页元件有限数值 x/y/w/h 覆盖（含页面 slot）；check 校验覆盖键、视图、类型、尺寸和位置，master/panel/repeater 模板内覆盖拒绝。原生预览已验 slot 文字随 390/1440px 视口切换为 300/900px，不承诺任意响应式重排。 |
| 导回与三方合并 | MCP `sync_prototype`（`status`/`lift`/`merge`/`rebuild`）与 CLI `lift-rp`/`merge` 基于 `<output>.baseline.json` 支持文字、改名、几何 (`x/y/w/h`)、样式 (`fill/stroke/color/radius/fontSize`)、增删元件及无条件单 Case `OnClick` 的导回与三方合并；覆盖删除 vs 修改冲突、页面重排后稳定归属、嵌套容器单次坐标换算、语法糖与标准字段统一冲突键及布局门禁拦截（`E_MERGE_LAYOUT_GATE`）。不承诺任意工程无损往返。 |
| HTML 辅助 | 浏览器提取 DOM 几何样式后映射规格；不是完整网站业务迁移器。 |
| 渐变填充 | 当前以 2× 位图（ImageBox）写入原生，视觉一致但参数不可在 Axure 内再编辑。矢量渐变需先取真值：`node tools/probe-gradient-fill.mjs <sample.rp>`，样本须由 Axure 手绘渐变后另存。 |
| `stack` 约束 | `after`/`afterGap`/`alignX`/`pin` 四类约束编译期解析为坐标；`z` 控制栈内绘制顺序；非法 after 引用和 alignX/pin 值报编译错误，非 stack 父容器使用约束会告警。 |
| `icon` 节点 | 内置原创图形渲染为独立 PNG ImageBox，支持颜色与尺寸；常用 search/plus/check/home/book/heart/star/clock/arrow-left。未知名称报 E_ICON_NAME。可改图片位置/尺寸和替换素材，内部路径不是原生矢量。 |
| 设计期查询 | `python3 scripts/proto.py tokens` 打印字号/字重/圆角/间距令牌表与文字墨迹规则（墨迹在声明盒内垂直居中，高≈1.3×字号，带 fill/stroke 另加 8px）；`gradient`/`shadow`/`aurora`/`noise` 会渲染成嵌入位图并以 ImageBox 写入原生（Axure 里是图片对象，渐变参数不可再编辑）；只有 `backdropBlur` 采样静态背景，叠在动态内容上会失真并给出告警。 |
| 进度条绑定 | 沿用 11 档（每 10%）原生动态面板；百分比文字与填充共用完整数值表达式和依赖，支持文本数字、同页更新及进入/返回页面刷新。macOS RP9 五条进度条与跨页考研样本已验保存重开后的原生预览。 |
| 验证 | 结构、模拟、表达式 Oracle、实际预览、GUI 修改及保存重开分别记录。 |

2026-10-24 复测补丁：所有容器校验 after 兄弟引用，普通字号和 spans 字号限制为 (0,72]，letterSpacing 非负；表达式末尾诊断不再暴露 None。

2026-10-24 第三轮工作流补丁：运行期 data-add 行表达式可用 revise，stdio revise 支持 async/dryRun jobs；成功改稿发布 `<output>.assets/` 并删除 `.revision-*`，保留可用预览、报告与基线。inspect/edit/rename/geometry/style 的 target 支持对象和 JSON 对象文本；generate/sync/review 的双态 spec 同样对齐。read_interactions 支持拥有者分页、nextOffset 与 widget 过滤，响应目标约 20KB（单个拥有者保留完整树）；RP/1 原生生成清除模板 OnLoadVariable，旧规格依赖它的路径保留。

第三轮分页复测补充：read_interactions 提供统一 `items` 和实际条数 `returned`，覆盖页面事件、顶层/嵌套元件及母版；`contained` 保留嵌套元件语义。混合 11 项样本验证省略 offset/limit、offset=0/1/2/5/10/11/12 和 nextOffset 全量遍历，无遗漏、无重复。

本机 2026-10-24 问题报告复验：44 项语义定向检查、正式目录真实 stdio 30 项、原始 122 个探针均无裸崩溃；starknow 5 页默认/显式自愈严格生成均通过，自愈新增 5 处错误会回退，IR 与布局保持一致。仅属编译、结构与传输证据，未新增 GUI 或原生预览验证。

本机 2026-10-23 创作工作流复验：新入口 18/18、六题脚本场景 6/6；三套范例的 RP9 保存重开与实际预览通过。脚本计时不代表独立 AI 创作效率。图片额外样本首次自动往返超时，原生保存后另副本重试通过；未验证图片实际预览。

历史 90 轮 GUI 证据未全部达到新门禁，历史首次成功申报 83/90 保留，外部真人试用为 0。不发布“100 分”或“任意场景全部可靠”的结论。

导回边界：条件、多 Case、禁用事件/Case/动作或缺少条件元数据时明确拒绝（`E_UNSUPPORTED_NATIVE_INTERACTION`）；只确认无条件的单 Case 可以展开。`prefer=native` 不绕过无法表示的原生语义，`prefer=source` 表示明确舍弃未支持的原生改动。源码删除后要保留原生修改，需先恢复源码节点；父布局同时变更、锚定移动或无法映射的新增容器不猜测归属。

模板、官方元件库与运行时由使用者本机提供；系统字体只在本机调用。移动示例使用原创简化几何，设备名称仅作规格兼容别名。
