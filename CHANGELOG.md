# Changelog

## 0.2.1 — 2026-10-25

- 在中英文 README 加入以「知序」考研复习 App 为案例的 40 秒宣传片。
- 发布复验补齐生成入口在源码校验阶段失败时的 `nextAction`；工具发现测试按注册表与活动清单核对，避免新增工具后仍写死旧数量。

- 处理 GitHub #1/#2：新增 `list-custom-styles`、`rename-custom-style`、`rebind-widgets` 及对应 MCP 具名参数。复用已有原生全局样式，级联更新各记录的 MatchInfo 和 StyleCache，按样式与库身份隔离同名外部样式；绑定同步基样式 GUID、保留几何与交互，并可显式清除局部格式覆盖。不提供凭空生成全局样式定义，未证实内部签名推测。新增 RP/RPLIB 合成回归。

- 第三轮分页复测：read_interactions 增加统一 `items` 列表与 `returned`，消除首页交互分散在 pages/contained 引起的空集误判；明确 offset 是跳过的拥有者数量。保留原分类视图，新增页面事件 + 4 个顶层按钮 + 6 个嵌套按钮的完整边界回归。

- 第三轮工作流修复：restore-tokens 只用字符串身份匹配列表，修复运行期 data-add 行表达式导致 revise 崩溃；母版 slot 注入对应占位容器，保留页面内容与 adaptive，修正手机宽度、机壳偏移和原生分组层级。adaptive 的键、视图、类型、尺寸和位置在 check 阶段诊断。stdio revise 支持 async/dryRun jobs；对象或 JSON 文本 target/source/spec 入口一致；read_interactions 增加拥有者分页和 widget 过滤；成功 revise 将可用预览和报告发布到 .rp.assets 后清场；RP/1 原生生成移除模板 OnLoadVariable，保留旧规格的实际使用。

- 复测收尾：将 after 兄弟引用校验扩展至非 stack 容器（保留有效非 stack 约束的布局提示），按现有渲染令牌设置字号上限 72（含简写与 spans），拒绝负 letterSpacing；残缺表达式统一报告 Unexpected end of expression，不再显示 Python None。

- 修复 10 月 24 日外部问题报告：MCP/CLI 的 autoHeal 统一默认 false，显式自愈按完整门禁对照并回退新增错误，报告逐项属性变更；速查表的设备/颜色/数值令牌改为读取编译器定义。补齐 E_DEPTH、statecharts、显式 selector、stack、palette、重复 page ID、tabBar 目标、字号、控制字符、普通元件 load 与表单宏诊断校验；diagnose 接受对象和序列化对象文本，jobs_cancel 返回明确结果，check 的 JSON 统一 stdout。文本 + 和合法字符串事件简写保留并说明其降低规则。

- **面板状态 `children` 简写全链路前置归一化与 `E_STATE` / `E_OBJECT` 诊断兜底**：修复 `dynamic-panel` / `panel` 嵌套在 `phone-shell` 等宏内且状态使用 `children` 简写（如 `{"id": "idle", "layout": "column", "gap": 14, "children": [...]}`）时，`mark_macro_sources` 在 `desugar_node` 前访问 `state["root"]` 触发裸 `KeyError: 'root'` 的缺陷；修复 `children` 数组混入非 `dict` 元素（如字符串）时 `mark_macro_sources.mark()` 触发 `AttributeError` 裸堆栈或指针回退到父状态的缺陷，统一返回带精确索引 pointer（如 `/pages/0/root/children/0/states/1/children/1`）的 `E_OBJECT` 诊断。同时修复 `.rp1` DSL `:state` 单子节点带 `gap/layout/padding/align` 属性下沉、`:state s1:` 尾冒号剥离、`spec_to_dsl` 对 `children` 状态简写的往返序列化，并对缺失 `root`/`children` 的空状态返回结构化 `E_STATE` 诊断。`runtime_info` 新增 `compilerHashes` 显式列出 `scripts/*.py` 与 `scripts/*.mjs` 各自内存/磁盘哈希，消除 UTC 启动时间与本地文件 mtime 的比对歧义。
- **应用层「零算高」`[fillxhug]` 创作升级与高频移动宏**：`measure_node` 原生支持 `dynamic-panel`、`repeater`、`label`、`card`、`box` 的 `h="hug"` 自动测高；新增 `stat-row`、`list-item`（支持 `tagTone`/`rightTone` 含 `error`/`neutral`）、`card` 内联内容属性（`tag`/`title`/`subtitle`/`body`/`rightBadge`/`actionText`/`goto`）、`panel tabs=[...]` 自动生成分段切换栏、顶层 `tabBar` / `tab-bar:` 一处声明自动注入各页 `phone-shell` 并自动吸底。
- **异步任务、自动自愈与拼图联审**：`generate_prototype` / `revise_prototype` 支持 `async: true` 后台任务句柄（`jobs_list`/`jobs_get`/`jobs_cancel`），`autoHeal` 默认 false、显式 true 时执行安全自愈，并直接生成 `pages-sheet.png`（`contactSheet`）与过滤 `_fill` 进度条辅助态后的纯净 `states-sheet.png`（`statesSheet`）。
- **零跳读 `SKILL.md` 自包含重构**：将 RP/1 `.rp1` 速查表、宏属性与完整多页模板内联至 `SKILL.md`，无需翻阅 `references/` 或 `scripts/` 源码即可一次写成。

### 创作与原生交互改进（2026-10-23）

- progress-bar 运行期填充改为**条件切态**实现：变量绑定时填充是 11 档动态面板（0/10/…/100），变量变化后按档位追加 `if` / `else-if` 链切换状态。此前用原生 `Set Size` 动作，Axure RP9 预览实测**静默不执行**（文字变、几何不变）；改为切态后在真实预览里点击 `done=0/3/10` 实测宽度 0/96/320，与算式一致。
- progress-bar: `value` / `percent` 接受 `$var` 简写（修复 `parse_inline_expr` 关键字参数导致的 TypeError）；表达式初值按变量默认值求值；变量变化时追加原生 `set-size` 动作同步填充宽度（`set-size` 首次成为 RP/1 一等动作，width/height 支持运行期表达式）。
- 布局：节点 `w`/`h` 为 0 或负数改为编译期 `E_SIZE` 诊断（此前会在渲染层抛 PIL `ValueError` 全栈）；渲染层同时加了兜底提示。
- 修正上一轮的误判：`gradient`/`shadow`/`aurora`/`noise` 一直是**原生写入**的（光效层渲染成嵌入位图 + ImageBox），并非"预览专属"；删掉误导告警，仅对 `backdropBlur`（采样静态背景）提示失真风险。
- 手机壳：`phone-shell` 内声明的 `device` 自动提升到页面级（此前宏内有 device 也不出壳）；灵动岛 122×34、补相机控制键、侧键内嵌机身、屏底色默认改暖白。
- 新增 `proto.py tokens`：打印字号/字重/圆角/间距令牌表与文字墨迹规则，供设计期查询。
- 新增 `proto.py measure`：输出每个文字元件的墨迹盒与「安全下一条 y」，排版定位不必再靠试错。
- 设计令牌（数值）：顶层 `tokens` 支持 `$font.h1` / `$radius.card` / `$space.m` 引用，编译期解析为数值；非数值令牌（颜色等）行为不变。
- `icon` 节点仍无字形集：文档标注实际渲染为空占位，建议用 label 或 box 组合替代。
- 新增 `z`：`stack` 子元件按 z 稳定排序并回写绘制顺序（此前只能用声明顺序硬凑层级）。
- 新增 `stack` 布局约束：`after`（紧跟某个兄弟）/ `afterGap` / `alignX: left|center|right`，编译期解析成坐标并回写；`after` 支持逻辑 id、原生名后缀与名字段匹配，`badge`/`button` 展开时保留逻辑 id 与约束键。
- 新增 `pin` / `pinGap`：贴 `top|bottom|left|right` 边；约束在展开阶段统一保留（任意节点类型，含 badge/button 的 id 与约束键），非 stack 父容器使用约束会给出 `constraint_outside_stack` 告警。
- 矢量渐变取证（未打通）：从 RP11 程序集字符串表解出填充键名（`fill-colors`/`fill-offsets`/`fill-angle`/`fill-center-point`/`fill-axis1|2`）与类型值（`linearGradient`/`radialGradient`），实测两种候选编码被 Axure 原样保存但**不渲染**；生产仍用 2× 位图，实验开关 `AXURE_VECTOR_GRADIENT=1`。全过程见 `references/gradient-fill-research.md`。
- 新增 `tools/probe-gradient-fill.mjs`：给定一个"手工画过渐变"的 `.rp`，打印 RP9 实际的渐变填充结构（键名/类型值/停靠点）。矢量渐变落地前的取真值工具；本机 300 个 `.rp` 扫描结果为零，故当前仍用位图实现。
- 澄清：光效层（gradient/shadow/aurora/noise）输出的是 **2× 位图**（280×120 元件 → 560×240 图），Retina 下不发虚，无需再加超采样。
- 新增 `test/preview-progress-probe.mjs`：在 Axure 真实预览里点击并测量 progress-bar 填充宽度的可复跑探针（需 playwright-core）。
- `check` 失败时返回 `diagnostics`（E_LAYOUT + pageName），并补 2 个回归用例；布局令牌 `after/afterGap/alignX` 加入节点白名单，不再触发未知属性告警。
- 新增遮挡审计 `text_occluded`（告警）：文字墨迹被后声明的不透明图元覆盖超过 50% 时提示——此前「审计全绿但字被柱子埋掉」无任何信号。
- 未知颜色令牌改为硬错误 `E_COLOR` 并给近似建议（此前 `$Brand` 这类拼错会静默变正文色）。
- `label` 支持 `lineHeight` 并参与多行墨迹测量。
- MCP `generate_prototype` 响应新增 `statePreviews`：每个面板状态的预览图路径直接回传（此前只写进 `.build/states/`，评审多态页得自己翻目录）。
- 新增 `proto.py doctor`：打印字体解析结果、主题令牌、预览专属样式与命令清单，用于排查字重回退这类静默降级。
- 面板状态预览图改为去掉原生 hash 的稳定文件名。

## 0.2.0 — 2026-10-21

- Ship screenshot reconstruction, OCR, chart geometry, layering, corrections and visual differences with all Python/Swift support sources.
- Add RP/1 JSON/text language, native generation, runtime data, rules, bounded masters/adaptive views and merge tools.
- Include RP9/RP11 adaptation, native acceptance helpers and synthetic tests/benchmarks.
- Preserve public CLI/MCP global-variable support and configurable protected paths.
- Replace extracted mobile assets with original geometric icons/frames and add an original screenshot example.
- Expand packaging to include runtime sources, tools, synthetic fixtures and examples.
- Fix rich-text CLI initialization order for embedded hyperlink templates, and align RP9 GUI helper defaults with the screenshot draft output.
- State verification levels and limitations instead of historical full-score claims.

## 0.1.1

Previous public native-file toolkit release. Apply this delivery as an update in the existing repository to preserve its history.
