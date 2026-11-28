# Changelog

## 0.4.0 — 2026-11-28

- 新增五大原生产物级工具（`scripts/diff-rp.mjs`、`scripts/rp-browser-core.mjs` + `tools/rp-inspector/index.html`、`scripts/repair-rp.mjs`、`scripts/downgrade-rp.mjs`、`scripts/build-library.mjs`）及对应 CI/门禁（`test:diff-rp`、`test:browser-core`、`test:repair-rp`、`test:downgrade-rp`、`test:build-library`、`test:mcp-budget`）；另附公开净室二进制规范 [docs/rp-format-spec.md](docs/rp-format-spec.md) 与单源同步脚本 `tools/sync-inspector.mjs`。
- `rp-browser-core.mjs` 与 `tools/rp-inspector/index.html` 升级为 4 模式纯本地 Web Worker 工作台（透视 / Diff / 损坏抢救 / RP11→RP9 降级与 `.rplib` 编译），内置纯 JS RFC 1951 `inflateRawWithEnd` 与 `CompressionStream('gzip')`，Chrome 输出通过 `native-check --compile` 与真实 RP9 GUI 往返。
- `downgrade-rp` 扩充至 20 份多样化真实 RP11 原型（含 4 份官方 Training 示例、689/706 元件多页外壳与中继器条件原型）压测通过 20/20 `native-check --compile` 及两份重度官方原型 RP9 GUI 往返。
- `native-check` 新增 `editorReadiness`（检测版本部件与 `DocumentSettings` 升级弹窗风险）、`.rplib` 验收支持与 `--compile`（触发公式错误检测与官方 HTML 编译检查），并扩充 `test:native-oracle` 覆盖核心原生写入矩阵。
- `diff-rp` 支持按原生 128 位 GUID 对齐比对页面、全局变量、元件几何/文本/交互树（经实测可过滤 GUI 重存导致的变量整数槽位号重排噪声）。
- 零 `node:*` 依赖的浏览器同构解包内核 `rp-browser-core.mjs` 与零网络离线单文件 `tools/rp-inspector/index.html` Web Worker 检视器通过 headless Chrome `file://` 验证。
- `repair-rp` 实现损坏 `.rp` 文件的跨区 CRC32 gzip 记录打捞、悬空引用修复与显式丢弃清单（不覆盖源文件）。
- `downgrade-rp` 实现 RP11 → RP9 原生降级编译（默认拒绝不支持的 RP11 特性，`--strip-unsupported` 显式裁剪并记录台账；补齐 `PackageInfo.root-panel-infos`、`FadeWidgetInfo.vertical`、`DocumentSettings` 与版本部件，实测 9 页 689 元件与 200 元件官方示例过 `native-check --compile`、RP9 GUI 往返及 Chrome 预览）。
- `build-library` 支持从 `.rp` / `.rp1` 编译 RP9/RP11 原生 `.rplib` 组件库（`document-type=2`、`SavedEdition=2`），衔接 `index-library` 与 `clone-library-page-content`/`clone-library-widget`。
- 公开 MCP 工具 Schema 通过 JSON Pointer `$ref` / `$defs` 与精简描述瘦身（保留全部 30 个工具名与 13 个 `studio_*` 动词），`full` 低于 35,000 字符且单个工具均 ≤ 5,000 字符，新增 `test:mcp-budget` 永久守卫。

- 官方播放器通过站点页 ID 路由。修复 RP11 重复编码中文文件名，导致明确指定的页面首帧超时，并覆盖验收脚本切页。
- RP9/RP11 合成工程内置六级标题、段落、表单提示和表单禁用样式，沿用原厂文档样式标识及属性。
- `gui-roundtrip.swift --quit` 向已选 Axure 实例发出正常退出请求，并等待原进程终止，保留 Axure 自己的未保存文档确认。

- 官方 HTML 验收按站点树解析指定页面的文件名。页面显示名与文件名不同的 RP11 工程可直接按页面名启动验收。

- RP9 / RP11 空白工程由运行时合成，`create-blank-project`、`create-blank-page` 和 RP9 生成链在没有模板时自动使用。合成工程写入版本历史，使两版编辑器可直接原地首存。GUI 作业记录保存落盘耗时、重试、体积及遇到的对话框。
- 新增 `index-library`。默认提供 ≤4 KB 摘要，`--json` 提供明细，`--folder` / `--limit` 限定范围。扩展 `clone-library-widget`，支持按名称、记录号和元件 ID 选择。
- 克隆到 RP11 时补齐 Layer、ImageBox、VectorShape 缺少的布尔 `Error` 字段，解决具备完整引用却遭原生拒收的旧跨版本写入缺陷。原生判据保留出错页 GUID 及完整异常链。
- 新增本机 Axure 原生加载回归，覆盖交互写入、富文本、页面装配、母版和动态面板。修复常驻桥接器一次失败后拒绝执行后续请求的问题。

- 新增 `zee-rp native-check <file.rp>`（`scripts/native-check.mjs`）：用本机 Axure 自己的程序集无头加载文件，报告接受 / 拒绝 / 判据不可用，拒绝时附 Axure 的原始异常。校准样本上与 GUI 真值一致；它当场推翻了一个结构测试全绿但 Axure 打不开的改动（纯字面量 manifest）。需要 macOS + Axure + .NET SDK，其他环境明确报告不可用。
- 未知 Tag 无损透传（离线结构级验证）：`parsePayload` 遇到未识别的 Tag 码时，把 7 种候选布局（无载荷、1/2/4/8 字节、dict、list）逐个代入重解析整条记录，只有恰好解析到末尾、通过四条结构判据且结论唯一时才采信，其余照旧报错。不透明布局的载荷原样写回，透明容器的子节点可照常修改。容器计数先校验再分配，坏计数报错而不是进程 OOM。新增 `npm run test:protocol` 并接入两个 CI 工作流。
- 记录一条原生反例：manifest 不可压缩时不能回退为纯字面量 LZ4 block——Axure（K4os.Compression.LZ4 分块流）的 RP9 / RP11 加载器都拒绝这种文件，所以保持报错。

## 0.3.0 — 2026-11-27

可直接安装，不必克隆仓库：`npx -y github:LilZeeCN/zee-rp doctor` 或 `npm i -g github:LilZeeCN/zee-rp`（MCP：`npx -y github:LilZeeCN/zee-rp mcp`）。相比 0.2.1（107 个提交）：Studio 自由画布、官方 HTML 导出与无头 Chrome 验收、RP/1 原生交互程序（条件、循环、过程、同页异步任务）、Windows 适配、HTML/URL 导入，以及三家外部模型的冷启动盲测收口。安装仍需 Node 18+ 与 Python 3.10+；原生 `.rp` 生成另需本机 Axure 与空白工程模板。
- 修复用 npm 或 npx 安装后 `zee-rp` / `zee-rp-mcp` 无法执行：`bin/axure.mjs` 与 `bin/mcp.mjs` 缺少 shebang，操作系统无法把它们当程序启动（自 0.2.0 暴露 bin 映射起存在，首次做隔离安装冒烟时发现）。新增 `npm run test:bin` 守住每个 bin 入口的 shebang 与直接执行，并接入两个 CI 工作流；CLI 帮助文案改为 `zee-rp <command>`。
- 门禁修复：`test:parity` 的内核脚本指纹检查改为与 `npm test` 同一条规则（按 `scripts/*.mjs` 推导，删除会漂移的数量常量 `test/baseline-policy.json`）；`test:authoring` 的配方数量断言取自配方表本身。两者此前在 `main` 上均为红，且都不在 CI 里。

- 三家独立外部大模型（`GPT-6` / `GLM-5.4` / `Claude Sonnet`，`readImplementation: false`）在公开 MCP 工具面上 **3/3 `completed`** 通关 `T01`（L1 0 阻塞、原生 RP9 三零通过，详见 `docs/blind-test-t01-20261126.md`），正式关闭 `docs/gaps.md` #1；随同两波修复彻底清除全部 12 项盲测暴露摩擦（`expect.text` `{ contains }` 与相近 `nodeId` 提示、`explore.states` 单传与 6 态 `label`、`column`/`row`/`stack`/`grid` 别名、单 `else` 展平、402 满画板栅格豁免、`column` `h:"fill"` 剩余高、写入实时 `W_BOARD_OVERFLOW`/`W_LINE_HEIGHT_FLOOR` 诊断、`review.assessment` 对齐 `l1BlockingCount`、单行 `hug` 标签 `.rp` 导出安全宽度余量与错误提示分流）。
- 新增本地 `.html` 与 `http(s)://` URL 导入（`scripts/html-import.mjs`）、跨平台免 Axure 浏览器验收引擎 `verify_prototype(engine:"studio-html")`、Studio 原生拖拽/滑动/定时预览闭环（关闭 `docs/gaps.md` #18）、`fix_plan(apply:true)` 原子自愈、`generate_from_image` `autoFix`/`verify` 以及 `zee-rp doctor` 3 秒环境自检。
- 关闭 `docs/gaps.md` #7（测试双轨清零）：分 3 批完成 29 个独立测试脚本向 `node:test` 的迁移，为其余真实特殊形态运行器标注保留理由并在 `test:studio-parity` 加入 `test/*.mjs` 永久合规守卫；当前 `docs/gaps.md` 全部工程缺口清零。

- 修复 Axure 宿主生命周期：只关闭本次作业窗口，使用「文件 → 关闭」前再次确认目标窗口拥有焦点。
  窗口名单去除授权后缀及重复项，所有 AppleScript 调用都有超时。作业失败或取消时异步清理已确认打开的副本，
  打开状态待确认时保留副本。
- 预览端口按 `PREVIEW_INFO` 确认归属，支持复用端口。只有候选页面均成功读取且没有标记时，
  才回退到旧宿主的「唯一新端口」规则。本机预览探针使用 Node 读取 Axure 的裸 LF 响应，无需外部命令。
- 驱动新增 `--tcc` / `--windows` / `--close` / `--quit` 辅助模式（flag 前缀，旧的位置参数调用不变），
  新增 `test/host-lifecycle-check.mjs` 覆盖端口归属与驱动契约。

- 修复原生 tab-bar 激活/未激活项的文字垂直对齐，离线预览读取真实对齐属性并增加结构门禁。
- GUI 首次文档未就绪时有界重试；失败仅清理未打开且未变更的任务副本，避免重试被遗留输出阻塞。
- 原生多页写入按事务复用解析与上下文、按脏记录批量提交；异步生成和改稿返回分阶段进度，保留原结构/事件校验。
- 修复 Studio phone-shell 导入堆叠、modern-dark 预设缺失及改色后背景/边框不刷新的问题。
- 改善 Studio 点选、双击死区、提示折叠、净空适配和容器内框选；新增 Option/Alt 测距、缩放档位、100%视图与邻页按视口装载。

- 固定 MCP SDK 的间接 HTTP 依赖到兼容 Node18 的版本，避免 npm 静默省略可选 SDK；区分字体文件携带与平台度量回退。

- 修复 Linux 异步浏览器任务的长临时路径 socket 启动失败；工程包测试使用随仓库提供的字体，原生宿主验证单独报告。

- 新增 Studio 自由画布：RP/1 与命令双路线创作、参考设计与局部查询改稿、事务撤销重做、浏览器交互验证、工程包、三方合并、矢量及离线代码导出。
- 增加原生旋转、原生表单与状态样式；原生回填按 GUID 追踪元件身份，保护宏参数、组件实例与数据绑定。
- 修复条件导出：保留事件级 cases、转换分支动作，RP/1 接受带类型检查的 `===` / `!==`，保持字符串字面量原样。
- 补齐公开安装包及浏览器 CI；保留真实模型失败与未完成记录，不再将脚本式 48/48 或旧评分作为真实 AI 成功率。

- 修复 `image.radius/opacity` 在原生与离线预览中被忽略；现代机壳增加局部透明角部遮罩，覆盖前景内容超出内屏圆角的像素。
- 单 label 的双向居中容器继承文字水平居中，保留显式对齐；tab-bar 新增 `activeVariant/activeIndicator/justify/itemFlex`，接通已有激活/非激活颜色与填充设置。
- 状态拼图显示面板视口与内容高度；新增视觉创作指南、导航范例与定向回归，复验试用反馈。
- 重做中文 README，增加英文版、原创工作台封面与栖羽案例，保留旧中文文档入口。

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
