# 交接文档：zee-axure 设计质量层（Studio / RP-1）

**2026-11-02 GitHub CI 跨平台补修：** 首次 Linux CI 发现工程包测试依赖 macOS Georgia 路径，以及异步任务继承的长 TMPDIR 使 Chrome singleton socket 超过路径上限。工程包测试改用仓库自带 CC0 字体；只有原生 RP9 子检查在缺少宿主模板时明确跳过，其余携带、截图和交互验证继续执行。Linux Chrome socket 使用短系统临时路径，独立 profile 仍归任务所有。新增长路径真实浏览器回归，本机相关12项通过；远端Node18/22复验随补丁运行。原始CI失败保留。

**2026-11-02 GitHub 交付快照（功能分支，未发行新版本）：** 本次提交包含 Studio 的 AI 创作、局部编辑、浏览器验证、工程携带、三方合并与原生出口，并整合远端 main 的 e370dfd 更新。亲自试用发现的条件比较与 cases 导出缺口已修；复验样本生成 2 页 69 元件原生文件，结构三零、30 个可编辑作者节点，参考运行时按三词推进至完成页。跨页直接改元件与 input rotation 仍明确不支持。主要检查：核心18/18、样式8/8、同步25/25、语言51/51、源码契约2/2、编辑21/21、后续修复41/41；AI集合初跑139/140，唯一 Axure 冷启动窗口等待失败在定向重跑中通过，包括保存关闭重开。保留该原始失败，不把定向重跑写成一次全绿。主 Agent 修复前直接试用评分7/10，不冒充独立盲测；48次模型全量评测未完成，旧分数不沿用。公开包补齐评测依赖与测试入口，安装验证和远端 CI 随本次提交核对。

**2026-11-02 提交前修复：** Studio标准化后的单项cases事件数组现在还原为RP/1事件级cases，分支内set-var等动作同步转换；RP/1接受浏览器===/!==比较写法并沿用静态同类型检查，字符串字面量保持不变。两项真实失败已有定向回归及原样例复验；跨页直接改元件仍按既有原生边界拒绝，返回页应使用变量与跳页。正在功能分支整合远端更新，48次评测已按用户要求停止，不声明全量模型通过率。

**2026-11-02 修复前直接试用记录（历史反例保留）：** 已按用户要求停止批量模型评测。主 Agent 在独立画布创建两页三词复习原型，真实浏览器8步16断言通过，并验证宏参数查询改稿、对比度精修、原子撤销/重做。熟练使用者主观总评7/10，画布创作约8/10；不作为冷启动或独立盲测。原生出口发现可复现缺口：浏览器接受的 `===` 条件在RP/1编译阶段被拒，换为 `==` 后，事件数组中的 `{cases:...}` 又被原生编译器以缺少type拒绝；当前样本未产出原生.rp，不新增宿主证据。Git状态为本地6个独有提交、远端main新增2个提交，需在feature分支整合后提PR；不得直接强推main。详细试用和提交准备见本机 `/Users/lilzee/axure-exp/outputs/studio-own-trial-20261102/REPORT.md`。

> **2026-11-02 当前接续：** 用户已停止 48 次模型全量重跑，本轮按已有真实调用、截屏、语义与浏览器记录完成人工验收。T08 低层路线原始通过；RP/1 路线证据通过，旧结果仅被 `emptySelection=false` 验收器误杀，现已修并保留原始失败。T01 是真实流程失败，T02 未跑完只作视觉样本。旧 `16/16`、脚本式 `48/48` 与 `9.50/10` 不再作为本轮真实模型终验。入口：本机收口记录 `/Users/lilzee/axure-exp/outputs/studio-finish-20261102/CLOSEOUT.md`，历史核查：`/Users/lilzee/axure-exp/outputs/canvas-handoff-audit-20261102/REPORT.md`。


**2026-10-31 独立审计后的修复正在收口（本机未发布）：** 下方 2026-10-30 的“16/16 全完成”报告已被独立反例推翻，不再作为当前验收结论。合并局部身份/删改丢失、工程字体、RP/1 类型契约与测试外部依赖已修复并复验；补修运行态同名目标隔离、改字重排及离线代码包相应尺寸更新。真实 AI 首轮预试保留 4/10 与失败，正在用实际独立模型试用替换旧脚本“48 次 AI 试用”。最终版本性能和正式对照未完成前，不恢复全完成声明。入口：独立审计（本机文件 `/Users/lilzee/axure-exp/outputs/studio-claim-audit-20261030/AUDIT.md`）、本轮修复记录（本机文件 `/Users/lilzee/axure-exp/outputs/studio-repairs-20261030/REPORT.md`）。

**2026-10-30 自由画布（Studio）历史工作包验收（保留，不等同于本轮真实 AI 终验）：** 当时解决 `editing-handoff.tap`（19/20 → 21/21）父子混选拖动超时与受控 Chrome 启动卡顿，并完成除 Codex 插件外的 16 个工作包。报告中的 87 个 MCP 工具、55 个命令契约、282×25×4 消费矩阵、1k/5k/10k 性能与脚本式八题 48/48，是当轮结构与脚本口径；后续独立反例已经推翻其中的全完成表述，不能替代本轮 T01 真实失败、T02 未跑完和 T08 人工复核。详见 `/Users/lilzee/axure-exp/outputs/studio-completion-20261030/COMPLETION-REPORT.md` 与 `QA-INDEPENDENT-REPORT.md`。

**2026-10-30 原生表单新增入口：** 完整 RP/1 已支持 radio/checkbox/combobox（droplist）/listbox 与原生四态 styles。取值与重置、Selected/Checked、Enable/Disable/Focus 可直接编译；语法和边界见 [native-forms](../references/native-forms.md)。4页RP9保存重开后的原生预览38项通过，报告 `/Users/lilzee/axure-exp/research-rp/native-forms-20261030/REPORT.md`。本机canonical已更新；现有MCP连接须重连，未公开发布。Studio局部入口不随本轮扩展。


**2026-10-30 接手快照：** 本地补父子混选/剪切/快速粘贴、真实grid跨行列与独立间距、锚定/等高、布局切换保真和公开契约。源码AI92/92通过；最新编辑合集19/20，混选拖动超时未定位，不能用此前20/20或隔离通过代替。尚未重打包/新stdio或新增RP9 GUI验收。用户将自行把以/boost开头的prompt交给Ghostty agy，尚未派发。详细交接 `/Users/lilzee/axure-exp/outputs/studio-completion-20261030/AGY-HANDOFF.md`；先修失败，再按原路线补全部非插件缺口，真实独立子代理验收后才能关闭。

**2026-10-29 主线收敛（本地未发布）：** 继续C01/R01/E01，工程携带等支线暂缓。共享fontSize/gap/padding标量数值引用参与实际度量/绘制，源引用保留；字体catalog不再覆盖实际回退。卡片/统计字号映射、未展开宏创建拒绝与原生可编辑子树出口已修。Esc取消拖动/缩放、失焦清理及AI新版本保护专项4/4，排版冻结点完整AI87/87。最新打包终验与原始失败见 `/Users/lilzee/axure-exp/outputs/studio-batch2-20261029/REPORT.md`；完整C01/E01/R01仍在推进。当前对话旧连接需重连才加载新程序，原4326/4502未动。

**2026-10-29 原生往返继续推进（本地未发布）：** 在隔离样本中真实RP9改字/移动、保存关闭重开后，与AI独立改稿经完整RP/1合并，稀疏返回原Studio文档；新进程重开、最终RP9加载与原生预览通过。9次公开调用15项检查、原生预览5项；新增GUID身份修复，同步25/25、核心18/18、stdio7/7。新出口保存带SHA的完整Studio作者源。该流程仍需精确比较并回填字段，任意属性/结构的一键往返与完整R01/M01未完成。详情 `/Users/lilzee/axure-exp/outputs/studio-batch2-20261029/r01-native-bridge/REPORT.md`；公开流程见 `docs/studio-native-roundtrip.md`。

**2026-10-29 第二批本机验证推进（本地未发布）：** 命名版本/恢复预览、有界历史/检查点、共享选区、持久长操作/取消与统一问题定位已接入；500次编辑、两条14步GUI/新stdio链通过。新增按节点/字段/阶段/消费面发现与唯一行模板源，画布实际绘制并更新所有行；20项浏览器→RP9保存重开→原生预览试用通过。当前AI80/80、stdio7/7，新stdio83工具/24 Studio且指纹一致。266属性全矩阵、R01 GUI回填、完整连续编辑、规模/携带/合并、矢量、代码出口和最终对照仍未关闭；无整体领先或用户审美认可证明。本对话旧连接实查需重连，原4326/4502未动。证据 `/Users/lilzee/axure-exp/outputs/studio-batch2-20261029/REPORT.md`；baoyu调研 `/Users/lilzee/axure-exp/outputs/baoyu-design-review-20261029/REPORT.md`。

**2026-10-29 第一批已落地、第二批持续推进：** 五套可编辑参考、六阶段上下文与工程设计决定已接入公开接口，参考6页359原生元件，7剧本70原生预览断言在RP9保存重开后通过。同brief三构图九张状态图已看图和实点；三类公开入口功能试用第三次调用写稿（熟悉调用者，非独立盲测）。当前53个命令/别名详细契约共用校验；266属性消费矩阵和后续工程项仍在推进。命名版本、恢复预览、可撤销恢复与历史窗口正在第二批验收，尚未关闭H01。完整进度见 `/Users/lilzee/axure-exp/STUDIO-ROADMAP.md`，证据 `/Users/lilzee/axure-exp/outputs/studio-batch1-20261028/REPORT.md`，公开用法 [阶段创作与决定](studio-stages.md)。未发布，旧4326和演示4502未动，旧连接须核对运行指纹。


**2026-10-28 后续工作入口：** 用户已将除Codex插件外的前述改进纳入完整计划：`/Users/lilzee/axure-exp/STUDIO-ROADMAP.md`。16个工作包覆盖设计、契约、RP/1、编辑、历史、性能、携带、并发、矢量、代码与对照；先固定基线并推进设计参考/阶段指导，逐包凭证据关闭。本次只是规划，不能把计划项写成已实现能力；当前事实仍以PROJECT-STATUS.md及能力表为准。

**2026-10-28 自由画布 AI 创作闭环已扩展（本地未发布）：** 新增按需 `studio_describe`、语义源目标查询、RP/1局部insert/update，复用事务/撤销/恢复/原生导出；修复日志覆盖、丢包重发、后代ID粘贴、跳页/目标引用、面板与文字hug、字号120/非默认字体/spacer。两轮独立试用保留原始5/10与7/10评分，原调用者复测12次正常回包给8/10（非盲测）；第二轮自主RP/1创作两页378词原型，写入失败0、语义12步33断言与浏览器三态10断言通过，2页87原生元件、77源节点native-editable。第二轮仍暴露的按钮默认配色、浏览器契约、导出超时及native_ahead已继续修复；新stdio同稿导出约3秒正常回包、deep verify为in_sync；另修复长短画板切换的截图合成帧截断。34项AI专项、62项画布回归通过；最终两页另完成RP9保存关闭重开、原生预览14步35断言。81工具/22 Studio工具、129文件指纹；旧连接须重连，原4326未重启。无任意工程无损双向、跨平台、GUI手工编辑或用户审美认可证据，不能称全面超过OpenPencil。 [公开用法](studio-ai-authoring.md)，本地证据 `/Users/lilzee/axure-exp/outputs/canvas-ai-moat-20261028/REPORT.md`。

**2026-10-27 AI任意构图与多状态预演已落地（本机快照，未发布）：** 现有 `studio_design_explore` 接收AI自写 candidates/states，在隔离工程返回真实实点联系图，默认保护内容、事件与有效继承显隐；纯装饰显隐允许变化，看图后用选稿 applyWith 提交，源稿不变。修复隐藏后代泄漏、点击别名不一致、未知/零断言假通过和无中间断言的连续点击抢跑；公开schema与上下文补齐调用及padding坐标说明，Studio服务/前端纳入指纹。独立试用20次Studio调用完成三构图×三态，看图选稿并实点；最终1页46元件、27语义节点原生可编辑、三零，RP9保存重开和5次点击10条断言通过。相关回归64/64、核心18/18、stdio7/7、创作流程18/18。新stdio80工具/21个Studio工具、120文件指纹一致；旧连接需重连，原4326未重启。无GUI手工编辑/用户视觉认可，无RP/1同题效率A/B；更多构图探索的旧待办由本条覆盖。 见[调用与边界](studio-candidates-20261027.md)；证据 `/Users/lilzee/axure-exp/outputs/canvas-ceiling-20261027/REPORT.md`。

**2026-10-27 编辑能力与画面对照已落地：** 本目录新增 `editNodes` 关系/批量编辑和版本绑定的截图对照，修复 padding 回写偏移、新页默认布局与自动适应、旧警告、文字结束编辑误拖及本地命令并发；小缩放下的边中点手柄不再盖住文字中心。新增专项10/10，核心18/18、像素14/14、stdio7/7、CSS9/9、工作流/修复21/21。拾词副本51处样式改稿52→2项命令、7141→1213字节，同为一次事务；重启后8步浏览器流程通过，9页361元件原生导出三零。新MCP80工具/21个Studio工具、restartRequired:false，当前旧连接须重连；原4326未重启，无新增Axure宿主/GUI编辑证据，未发布。原始试用中的拖拽、新页布局、警告与页面定位问题已由本轮修复覆盖；更多RP/1增量/构图探索仍未实现。见[本轮实现与验收说明](studio-editing-20261027.md)，原始证据在本目录 `outputs/canvas-editing-20261027/`。

**2026-10-27 自由画布真实界面试用：** 独立工程实际完成建页、编辑、撤销/重做、页面跳转预览、服务重启保存恢复与`.rp`导出结构检查；发现首页拖拽纵向两次额外偏移60px、新页默认column导致文字拖动无可见移动、改为stack后旧警告仍残留；另一次连续操作出现版本冲突及根容器意外位移，尚未确认稳定复现。1099×579视口下新页会被属性面板遮住，可用适应画板恢复。本轮未改产品代码、未新增Axure宿主验证。逐步记录与截图见本机记录 `/Users/lilzee/axure-exp/outputs/studio-live-trial-20261027/试用记录.md`。

**2026-10-27 续接优化已完成（P0 / P1 / P2）：** 默认度量与看图评审已切换为真实浏览器像素；失败回落明确 `contrast.source: geometry` 与 `fallbackReason`。用原图、保留非字形绘制的底图、浏览器字形掩膜测最弱核心笔画，修复透明度、字内渐变/遮挡、裁切、currentColor、缩小字号、DPR/滚动/手机壳偏移及浮层污染；截图串行、版本变化拒收、异常清理。专项14/14、反攻击16组、核心18/18、stdio7/7、CSS9/9、工作流3/3，独立真实浏览器6脚本70个节点判定通过。P2只将本条质量分支快进合入本目录本地main；原96项未提交工作保留。未公开发布；`/Users/lilzee/axure-exp/zee-rp` 是另一条旧开发线，未覆盖。描边/叠字/画板外为unknown且不通过；未新增AxureGUI证据。详见 [本轮日志](agent-trial-findings-2026-10-27.md#2026-10-27-续接p0p2像素默认与字形核心测量)。

**继续开发入口：** P0/P1不再是待办；任意候选构图已由上方新一轮实现覆盖；内容重写、区域语义与更多题材仍待后续，不能将任意候选接口等同于这些能力。修复计划/探索的离线候选仍用几何投影，`verificationBasis: geometry`；应用后应重新跑默认像素度量。旧MCP连接/已运行的旧Studio不会热更新代码，新连接使用本轮程序；本轮没有重启原4326用户工程。

---

以下为续接前的原始交接，保留为历史证据。第5节P0–P2状态由上方更新覆盖。

> 写给接手的模型或工程师。看完这一份，你应该知道：昨晚做了什么、现在什么状态、接下来怎么干、哪些坑别再踩。
>
> 生成时间：2026-10-27 10:15（Asia/Shanghai）
> 仓库：`~/.zcode/skills/zee-axure`　分支：`studio-design-quality`　最新提交：`998c6b8`

---

## 0. 三十秒版本

这个工具把「AI 画的设计稿」变成可判断、可修复、可交付的 Axure 原型。昨晚一整夜在做的是一条**质量判定链**：

```
度量（哪里错）→ 处方（怎么改，且自证有效）→ 参照（离锚点差多少）→ 探索（多个方案收敛）→ 内容脚手架（该填哪些空）
```

关键转折在最后一小时：前 30 轮都在用**规则模拟像素**（猜浏览器怎么合成），被外部试用者连续打穿；最后换成**截图取真实像素**（`pixel-truth.mjs`），一次性绕过所有 CSS 合成问题。

外部试用者（低耐心、只读、主动攻击的子代理）的评分轨迹：

```
4 → 5.5 → 6.5 → 7 → 7 → 7.5 → 7.0 → 6.0 → 7.0 → 7.5 → 8.0 → 6.5 → ？
```

**最后是 6.5，不是 8.5。** 原因见第 4 节，别被中间的高分误导。

---

## 1. 昨晚具体做了什么

### 1.1 修完了一整批 P0/P1 缺陷（全部带回归）

| 编号 | 问题 | 修法 |
|---|---|---|
| S1 | `addPage` 硬编码 mobile | 支持 `domain` / `device`，web 默认 1280×800 无手机壳 |
| S2 | 第二个 `open_project` 静默顶掉第一个 | 每工程独立实例 + 探针/锁 |
| S3 | 单次响应 80–120KB | 紧凑投影，实测 32KB→2.2KB（14.5×） |
| S4 | 子代理不知道有哪些命令 | 未知命令列表 + 漂移测试 |
| A1 | 未知属性给出不存在候选 | 白名单校验 |
| A2 | `fields()` 缺失合法属性 | 补全 |
| A3 | RP/1 无行过滤 | `@repeater where="=item.status == ..."` 编译期过滤 |
| A4 | 溢出诊断不可读 | `message` / `suggestion` / `data` |
| A5 | 宏子节点回写产生非法属性 | 三层修复 + `test:macro-lift` |
| C2 | 场景缺 `textAlign` 等字段 | 补齐投影 |

### 1.2 建了「设计上限层」五根支柱

| 支柱 | 文件 | 能力 |
|---|---|---|
| L1 量化指标 | `studio/design-metrics.mjs` | 11 项固定清单：内容、越界、栅格、字阶、色相、反 slop、主次、主操作、热区、空态、对比度 |
| 反 AI-slop | 同上 `detectSlop` | 等距卡片阵、紫渐变、空洞居中 hero、图标圆角方块、缺媒体 hero、过度圆角 |
| 锚点参照 | `studio/anchors.mjs` | 从达标页提炼配方，对比给方向建议，支持人工认可 |
| 批量探索 | `studio/explore.mjs` | 参数轴（字阶/密度/圆角/配色）+ 结构轴（比例/主次），连续目标 + 硬回归淘汰 |
| 导出预算 | `metrics.exportBudget` | 加性口径：每个节点可编辑基底 + 装饰层（栅格化/不确定/不支持） |

### 1.3 建了「从诊断到开方」

- `studio/fix-plan.mjs` + `studio_design_fix_plan`：只开确定性处方（网格吸附、补绑定空态、撑高文字回缩），**服务端试跑自己的命令**，整页阻塞项不严格减少就不下发，并给 `unfixable` 原因
- `studio/content-plan.mjs` + `studio_design_content_plan`：空态/口号标题的槽位、模板、示例——**不假装会写文案**

### 1.4 最后一小时：换成像素真值

- `studio/png-decode.mjs`：极简 PNG 解码（8 位、非隔行、RGB/RGBA）
- `studio/pixel-truth.mjs`：按文字盒子取内缩边框环的**众数颜色**，用真实像素算对比度
- `studio_design_pixel_contrast` 工具、`/api/design/pixel-contrast` 端点、`metrics({pixelTruth:true})`

实测 50% 黑遮罩 + 白字：

| 方法 | 36px 标题 | 16px 副标题 |
|---|---|---|
| 几何（最早） | 21:1 ✓ | 21:1 ✓ **假绿** |
| 几何（合成修复后） | 3.95 ✓ | 3.95 ✗ |
| **像素真值** | **4.01 ✓** | **4.01 ✗** |

底色取样 `#7F7F7F`——正是 50% 黑压白的真实结果。**不依赖任何合成公式。**

### 1.5 把 `studio/` 纳入 git

之前 `git ls-files studio` 为 0，CI checkout 看不到被测代码。现在：

- 分支 `studio-design-quality`，四个提交（`6b3cd33` / `f2150f0` / `911ce03` / `998c6b8`）
- `studio/` 35 个文件 + 12 个测试套件入库
- **没有动 `main`，也没有动工作区里剩下的 96 个未提交改动**

---

## 2. 现在能跑什么

```bash
cd ~/.zcode/skills/zee-axure
npm test                        # 18 条，含 5 个 studio 套件
npm run test:studio-anti-gaming  # 16 组攻击面断言（核心资产）
npm run test:studio-metrics      # 度量口径 + 关系约束
npm run test:studio-fix-plan     # 处方自证
npm run test:studio-content      # 内容脚手架
npm run test:studio-consistency  # 三工具一致性
npm run studio                   # 启动自由画布（浏览器 UI）
```

MCP 工具（`studio_design_*`）：`metrics` / `explore` / `anchors` / `fix_plan` / `content_plan` / `pixel_contrast`。

**注意**：MCP 服务进程如果是旧代码启动的，新工具要重连 DSH 才出现；验证请走 CLI 或 `import("./studio/mcp-adapter.mjs")`。

---

## 3. 核心设计原则（都写进代码了，别改坏）

1. **不可评估 = 不通过**
   缺项显式 `notAssessable` 红项，不许从 `checks` 蒸发；`expected / counted / notAssessed` 必须对账。
   → 历史事故：可见块 <3 时 `visual-hierarchy` 直接从 checks 消失，`passed === counted` 依然成立，页面"被合格"。

2. **绿必须经得起攻击**
   `test:studio-anti-gaming` 的 16 组就是攻击面清单：零宽/软连字符、alpha 1/255、`opacity:0`、透明文字、wrapper 拆分、检查蒸发、对比度跳过、5% 白纱、50% 遮罩……

3. **处方必须自证**
   在文档副本上试跑，整页阻塞项不严格减少就不下发。

4. **红必须点得开**
   每条失败带 `nodeId`，`contrast.unknownNodes` 要指名道姓，不能只说"N 处"。

5. **不假装**
   导出预算与真实导出不一致时标 `uncertain`；内容脚手架只给槽位；取不到底色就说 `unknown`，不编数字。

---

## 4. 现状的真实水平（别被高分误导）

外部试用者最后一轮给 **6.5**，判词：

> 门禁的可信度取决于"最容易被骗的那条路径"，不是"最常走的那条"。

它打穿了三次：

| 轮次 | 攻击 | 结果 |
|---|---|---|
| 1 | 幽灵盒子（`rgba(0,0,0,0)` 1000×520）伪造主次比 | 绿 |
| 2 | `#FFFFFF01` / `opacity:0` / 软连字符 | 绿 |
| 3 | 5% 白纱把 10:1 变 1:1 红、50% 遮罩把 3.95 虚报 21:1 绿 | 双错 |

三次都已修，但**第四次很可能还有**。这是方法问题，不是工程问题：几何近似永远追不上 CSS 合成。像素真值是目前唯一跳出去的路。

**当前可信度评估**：

| 层 | 状态 |
|---|---|
| 几何（越界 / 栅格 / 热区） | 可信，可直接进 CI |
| 可达性（空态覆盖） | 可信 |
| 可达性（对比度，几何模式） | 仅"保守"，半透明/滤镜场景不可信 |
| 可达性（对比度，像素模式） | **可信**，但需真实浏览器，默认关闭 |
| 层次 / 平衡 | 启发式，参考用 |
| 品味 / 内容 | 不在能力范围 |

---

## 5. 接下来怎么干（按优先级）

### P0：把像素真值变成默认（最该做的一件事）

现在 `pixelTruth` 是可选开关。应该：

1. 度量端点默认尝试像素取样，失败才回落几何，并在结果里标注 `contrast.source`
2. 把 `test:studio-anti-gaming` 的对比度断言迁到像素模式（现在跑的是几何）
3. 解决取样的已知偏差：
   - 文字紧贴盒子边缘 → 取样环落进字形
   - 大渐变底 → 众数色只代表一处
   - DPR 非整数 / 滚动偏移 → 坐标错位
   建议改为：在 bbox 内做**双峰分离**（字形色 vs 底色），而不是只取边框环

### P1：让攻击继续（RSI 闭环不能停）

派低耐心子代理，只做一件事：**攻击像素真值这条路**。
预期它能找出：渐变底取样偏差、DPR 缩放、被遮挡文字、描边字、透明文字合成。
这些批评**是有效的、可修的**——因为改进的是测量算法，不是无限补规则。

派活时务必交代：
- `process.exit(0)`，否则测试挂住
- 只读 skill 目录，产物写 `/tmp/trial-*`
- 不许读说明文档，只信自己跑出来的结果
- 必须给出原始输出与复现步骤

### P2：把 `main` 合了

```bash
git checkout main && git merge studio-design-quality
```

合并前确认工作区那 96 个未提交改动是用户的、别一起带走。

### P3：能力缺口（要新机制，不是补丁）

| 缺口 | 现状 | 需要什么 |
|---|---|---|
| 空洞文案（`vague-centered-hero`） | 只能检测 + 给槽位 | 改写文案的能力（语言模型判断） |
| type-scale 多数问题 | 只能动最大正文那一级 | 内容层级重构 |
| 探索的结构轴 | 只覆盖"一行多定宽子项"和"根级堆叠块" | 更多布局关系的建模 |
| 关系层深度 | 空态能绑列表，主操作看同容器 | 区域语义（页头/主区/页脚） |

---

## 6. 别再做的事（踩过的坑）

1. **别再补 CSS 合成的规则**。遮罩、滤镜、混合模式、渐变、阴影——补一条换一条攻击路径。去量。
2. **别让检查从 `checks` 里消失**。哪怕"不适用"，也要显式 `notAssessable` 红项。
3. **别用没人消费的字段假装修好**。`hitW/hitH` 渲染层没实现，度量就忽略它（宁可红着）。
4. **别信"测试全绿"**。`test/studio-anti-gaming` 曾经 16 组全绿，但没覆盖 early-return 分支、文字幽灵、contrast-skipped——**绿的是测试，不是结论**。
5. **别在通过态页面上推无谓改动**。基线已过且没有候选提升 >0.02 时，`best` 应回落到基线并说"不需要改动"。
6. **别把 `unknown` 当通过**。`unknown` 是"我不知道"，必须判红；但也别编一个精确数字（那更伤人）。

---

## 7. 文件地图

```
studio/
  design-metrics.mjs   ← 核心：11 项检查、固定清单对账、反 slop、关系约束、导出预算
  pixel-truth.mjs      ← 像素真值对比度（截图取样）
  png-decode.mjs       ← 极简 PNG 解码
  explore.mjs          ← 批量探索 + 收敛
  anchors.mjs          ← 锚点配方与对比
  fix-plan.mjs         ← 确定性处方（自证）
  content-plan.mjs     ← 内容脚手架
  design-review.mjs    ← 审查（findings 带 nodeId 与 severity）
  scene-resolver.mjs   ← 场景解析（role / variant / component / hitW / for 的投影）
  server.mjs           ← HTTP 端点
  mcp-adapter.mjs      ← MCP 工具定义

test/
  studio-anti-gaming-check.mjs      ← 16 组攻击面（最重要）
  studio-design-metrics-check.mjs   ← 度量口径
  studio-fix-plan-check.mjs         ← 处方自证
  studio-content-plan-check.mjs     ← 内容脚手架
  studio-consistency-check.mjs      ← 三工具一致性
  studio-explore-check.mjs / studio-anchors-check.mjs / ...

docs/
  HANDOFF.md                       ← 本文件
  DELIVERY.md                      ← 交付清单
  agent-trial-findings-2026-10-27.md  ← 33 轮缺陷台账（最有信息量）
  design-tools-trial-report.md     ← 外部试用报告（13 轮轨迹）
  free-canvas-design-ceiling.md    ← 能力边界与五层模型
```

---

## 8. 回退

```bash
# 快照（每轮一份，共 36 个）
ls ~/Downloads/test_1/_backup/zee-axure-rsi-r36-*

# 整套回退
rm -rf ~/.zcode/skills/zee-axure
cp -a ~/Downloads/test_1/_backup/zee-axure-rsi-r36-20261027-080534 ~/.zcode/skills/zee-axure

# 只回退代码
cd ~/.zcode/skills/zee-axure && git checkout 4d73455 -- studio test

# 原始 tag
git tag -l | grep rsi-backup
```

---

## 9. 一句话交接

**别把这条线当"设计评审签字工具"交付，它是「设计期的对抗性体检 + 几何/可达性门禁」。**
它的绿值钱，是因为它经得起攻击；它的红值钱，是因为每条红都点得开、说得清怎么改。
剩下那 1.5 分不在规则里，在**测量精度**和**判断力**——前者是工程，后者不是。
