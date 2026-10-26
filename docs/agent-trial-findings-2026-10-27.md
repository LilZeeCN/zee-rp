# zee-axure 实测缺陷台账

- 日期：2026-10-27
- 被测版本：`zee-rp` 0.2.1（`runtime_info` toolCount 74，fingerprint `d7a719e4…`）
- 仓库状态：分支 `main`，HEAD `4d73455`，工作区有未提交改动（`git status` 显示 SKILL/README/scripts 等 19 个文件 M）
- 环境：macOS，Axure RP 9（`com.axure.AxureRP9`），Python 3.13.11，Node v24.15.0
- 方法：MCP 端到端实操 + Axure 宿主 roundtrip + 真实浏览器预览点击 + 源码根因定位
- 产物证据目录：`/Users/lilzee/Downloads/test_1/`、`/Users/lilzee/Downloads/test_1/studio-try/`

严重度：**P0** 阻断/产出错误、**P1** 明显拖慢 agent 或降低可信度、**P2** 体验瑕疵。
路线：**RP1** = `generate_prototype`/`revise_prototype` 声明式线；**ST** = `studio_*` 自由画布线；**C** = 共用。

---

## 一、RP1 线

### A1 `revise_prototype` 无法定位页面级属性（P1，RP1）

- **复现**：`revise_prototype({operations:[{target:"today",property:"name",value:"今日复习"}]})`
- **实际**：`{"code":"E_PATCH","pointer":"/operations/0/target","message":"Target 'today' missing or ambiguous; use a page-qualified logical ID","suggestions":["today/headline","today/intro","today/progress",…]}`
- **期望**：识别 `today` 为页面 ID，改写 `/pages/0/name`；或明确提示「页面级属性请用 JSON Pointer `/pages/<i>/<prop>`」。
- **根因**：`scripts/rp_workflow.py:174` 与 `:271` 只做「元件/子节点」解析，没有页面记录分支；`suggestions` 取自页内元件 ID，自然全是子节点，反而误导。
- **修复建议**：`resolve target` 增加页面前缀识别（target 命中 `doc.pages[].id` 且 property ∈ {name, canvas, device, domain, fill}时映射到页面路径）；错误分支补 `hint: "页面属性用 /pages/<index>/<prop>"`。
- **验收**：新增 `test/rp1-merge-residual-check.py` 用例；`npm run test:sync`。

### A2 未知属性提示会给出**错误**候选，且不列可用属性（P1，RP1）

- **复现**：`@repeater #rows filter="=item.status == '已支付'"`
- **实际**：`Unknown property 'filter'; did you mean 'after'?` + `candidatePatches` 建议把 `filter` 改名为 `after`。
- **期望**：说明 repeater 支持哪些属性；无相近候选时不要硬凑。
- **根因**：`scripts/rp_language.py:198-200` `fields()` 用 `difflib.get_close_matches(cutoff=0.68)` 对**全部**允许项做模糊匹配，短属性名集合（repeater 只有 `dataset/key/template/rowGap/rowHeight/pageSize` + GEOMETRY）里 `filter` 撞上 `after` 这类几何项；且未在错误里回传允许集合。
- **修复建议**：① 错误 payload 增 `validProperties: [...]`（截断 40 项）；② 相似度阈值提到 0.8 且要求同前缀或 Levenshtein ≤2，否则给 `null`；③ `candidatePatches` 只在相似度可信时生成。
- **验收**：`npm run test:language`；补 `test/rp-feedback-*` 负例。

### A3 `repeater` 没有行级过滤，和 `searchable-list`/`master-detail` 的能力不一致（P1，RP1）

- **复现**：想做「按状态筛选列表」，`repeater` 无 `filter`/`where`；`searchable-list` 有 `filterField/filterWhere/baseWhere`（`scripts/rp_language.py:308`），`master-detail` 有 `filterField/filters`（`:313`）。
- **期望**：`repeater` 支持 `where="=item.status == '已支付'"`，多状态面板可复用同一 dataset。
- **根因**：`scripts/rp_language.py:268` repeater 允许表只到 `pageSize`；行过滤能力只做在复合宏里。
- **修复建议**：把 `searchable-list` 的 where 编译路径（`:5043` 一带已有 `where_ast` 求值）下沉成 repeater 的通用属性；`on` 支持 `data-filter` 动作改 `$filter` 变量。
- **验收**：`npm run test:runtime`（`rp-runtime-check.py` 已有 filter 相关路径）。

### A4 `no_container_overflow` 报错不可读，且不给修复动作（P1，RP1）

- **复现**：顶栏 `300+400+340` 宽 + gap 24 > 容器 1072。
- **实际**：`message` 是一整串 JSON：`{"gate":"no_container_overflow","widget":"grp-actions-…","box":[768,28,340,36],"containerBox":[24,24,1072,44],"overflow":{"right":12},…}`。
- **期望**：`顶栏内容总宽 1084px 超出容器 1072px（右侧 12px）；建议：把 app_title 收窄 12px，或给子项加 flex=1 改用剩余宽度分配`。
- **根因**：`scripts/proto.py:4213` 只拼结构化字段；`nextAction` 是通用文案「按诊断位置和候选补丁修正源码」，没有针对性建议。
- **判断修正**：**闸门本身是对的**（我先前把它当成"要手算宽度"的缺陷，实际是我 spec 写错；`flex` 在 `GEOMETRY`（`rp_language.py:248`）里是支持的）。真正缺陷是反馈质量。
- **修复建议**：`message` 输出人类可读句式；`candidatePatches` 生成两条：收窄某子项 / 给超出项加 `flex`。同时把 `flex` 与「固定宽行需自算」写进 cheatsheet。
- **验收**：`npm run test:acceptance`；`test/rp-audit-gaps-check.py` 增例。

### A5 `sync_prototype` 的 lift→merge 在**宏内部元件**上会把改动写到父节点，导致 merge 直接失败（P0，RP1×ST）

- **复现**：对 `detail-card #detail title="订单详情"` 的内部标题执行 `set_widget_text("订单明细")` → `sync_prototype({mode:"lift"})` 返回 `liftedTextEdits:[{id:"board/detail_title"}]` → 同文件 `mode:"merge"` 报：
  `E_MERGE_LAYOUT_GATE / "Merged specification failed semantic validation: Unknown property 'text'" / pointer "/pages/0/root/children/2/children/1/text"`
- **实际**：`children/1` 是 `detail-card` 宏节点本身（宏没有 `text` 属性），正确落点应是宏内部的标题 label。
- **期望**：lift 记录宏实例 + 子节点路径（或映射回宏参数 `title=`），merge 时改参数而非在宏节点上塞 `text`。
- **根因**：`scripts/rp_decompile.py:1118 lift_rp_into_spec` 生成的 textEdit 只带逻辑 ID，`merge`（`:1794`）按 ID 在 spec 里直接写 `property:"text"`；宏节点与宏内子节点共用逻辑 ID 前缀时无法区分，落到父节点。
- **对照**：普通 label（`app_sub`）同一链路完全正常（`preservedTextEdits:1`，写出 merged spec + rp）。所以是宏分支缺失，不是整体失效。
- **修复建议**：lift 时解析宏实例（`macroSource`/`componentSource`），把子节点改动映射为 `{macroPath, parameter}`；无法映射时**明确报 `E_LIFT_UNMAPPED_SUBNODE` 而不是产出非法 spec**；merge 前增加「宏节点不得出现 text」的语义校验前置。
- **验收**：`test/rp1-sync-b-check.mjs` 增宏用例。

### A6 `progress-bar` 0% 时渲染出 1px 竖线残留（P2，RP1）

- **复现**：内置范例 `mobile-cards` 的「今日掌握 0%」，画布与 Axure 预览里进度条左侧都有一根 `|`。
- **根因**：疑似 `scripts/rp_language.py:1952 expand_progress_bar_macro` 的 fill 子节点在 0 宽时仍保留描边/最小宽。
- **修复建议**：0% 时 `visible:false`（或 `w:0` + 去 stroke），并补 0%/100% 边界快照。
- **验收**：`test/preview-progress-probe.mjs`；`npm run test:visual`。

### A7 给 agent 的 cheatsheet 没有说清固定宽行的横向约束（P1，RP1，文档）

- **现象**：`prototype_recipe` 的 cheatsheet 强调 `[fillxhug]` 纵向零算高，但没有提示「row 内固定宽子项要和为容器宽 − gap」，我第一版就因此被 A4 拦下。
- **修复建议**：cheatsheet 增一行：`横向 row：子项 w 之和 + gap×(n-1) ≤ 容器 w；不确定就 flex=1 或 w=fill`。`references/rp-language.md:94` 补 flex 用法示例。

### A8 图片转原型 OCR 会整行丢失（P2，RP1）

- **复现**：用看板截图喂 `generate_from_image` → 87 元件、`pixel_similarity 99.26%`、`mae 1.89`，但 `missing_ink_regions` 记录 `x52,y314`（"青柚科技"整行），橙色按钮上的白字也丢。
- **修复建议**：低置信/低对比文本进 `reviewRegions` 时必须给出「建议人工补字」的显式标记（现已有 `smallOrReviewTexts`，但漏掉的是**整块丢失**，需要 before/after ink 差分入审查清单）。

### A9 `revise_prototype` 的 add/replace 语义有两条并存写法（P2，RP1，文档）

- **现象**：`{op:"add", path:"after:page/id"}` 与 `{op:"add-node", target:"page/container"}` 都能加节点，文档里混着讲；我用 `target:"today"` 时也没被引导到正确写法。
- **修复建议**：统一一套推荐写法并在 schema 里标 deprecated，错误信息直接给出可用写法示例。

---

## 二、ST（自由画布）线

### S1 `addPage` 无法指定 `domain`/`device`，桌面页被套手机壳（P0，ST）

- **复现**：默认工程（`domain: mobile`）里 `{type:"addPage", pageId:"board", w:1440, h:900}`。
- **实际**：页面 `domain` 被写成 `mobile`（`studio/commands.mjs:1261` 的 `domain: doc.domain || 'mobile'`），渲染带 iPhone 外壳：`outerRadius:58`、灵动岛、Home Indicator；截图见 `.dsh-attachments/studio-canvas.jpg`。
- **对照**：用 `domain:"web"` 的 source 导入时画板是平的（`shellPad:0, outerRadius:0, island:null`），1280×800 正常。
- **期望**：`addPage` 接受 `domain`/`device`；桌面域不套 `phone-shell`。
- **修复建议**：`addPage` 增加 `cmd.domain`/`cmd.device`（与 `:1374` 的 domain 解析保持一致）；`domain !== 'mobile'` 时 root 默认用 plain box、`canvas` 用桌面预设。
- **验收**：`npm run test:studio-design`。

### S2 单实例单端口：切工程会顶掉当前工程，已打开画布直接「连接已断开」（P0，ST）

- **复现**：`studio_open_project(projectDir: studio-try)` 后 `studio_open_project(projectDir: studio-web, port: 4311)`。
- **实际**：返回 `url: http://127.0.0.1:4310`（`port` 被忽略），`projectDir` 变成 studio-web；用 studio-try 的 projectDir 调 `studio_get_context` 返回的仍是 studio-web；Chrome 里原画布标签头部显示「连接已断开」。
- **根因**：`studio/server.mjs` 单例 + `mcp-adapter` 复用 `instanceId`，`port` 只在首次 start 生效。
- **修复建议**：① `open_project` 增加 `mode:"switch"|"fork"`，`fork` 时真正另起端口；② 或按 `projectDir` 维护 `Map<projectDir, instance>`，同进程多工程；③ `port` 与现有实例不一致时**报错**而不是静默忽略。
- **验收**：`test/studio-design-check.mjs` 增双工程用例。

### S3 每个写操作都回传整份 doc + 完整 scene，单次响应 80–120KB（P0，ST；这是实测最大的可用性障碍）

- **证据**：`studio-try/document.json` 仅 2 页 8 节点就 29KB；scene 里每个节点 50+ 字段（含 `firstBaselineOffset/ascentPx/descentPx/measurementMode/…`）。`open_project`、`apply_commands`、`get_context` 三个调用各回传一次，三次就吃掉数万 token。
- **根因**：`studio/mcp-adapter.mjs:53` 直出 `JSON.stringify(body)`；`studio/server.mjs:176/590` 无条件带 `scene`，body 里同时含 `doc`。
- **修复建议**：① MCP 层默认 `compact:true`：只回 `appliedRevision/contentHash/affectedNodeIds/humanReadableSummary/diagnostics` + 变更节点的**精简投影**（去掉测量字段）；② `include:{doc:false, scene:false}` 开关，调试时才全量；③ 提供 `studio_query_nodes` 作为按需查询（已有，但现在没人需要用它，因为 context 全给了）；④ 大文档改分页/游标。
- **验收**：`test/studio-design-check.mjs` 断言 compact 响应字节数上限（如 <8KB）。

### S4 命令字段名 `type` 与错误提示不列合法值（P1，ST）

- **复现**：`[{cmd:"addPage",…}]` → `E_INVALID_COMMAND / "命令 #0 缺少有效的 type 字段"`。
- **问题**：① 我用 `cmd` 是受"命令"心智影响，错误没提示其实叫 `type`；② 别处（`revise_prototype`）用 `op`，两套线命名不一致。
- **修复建议**：错误里列 `validTypes`（30+ 项按类分组）+ `example`；`cmd` 作为 `type` 的别名接受并给 deprecation warning。
- **验收**：`npm run test:studio-repairs`。

### S5 内置组件契约是手机口径，桌面画布不可用（P2，ST）

- **现象**：`button/input-field/list-item/info-card/nav-bar/status-zone` 的 `sizingContract` 全是 `maxW:370 / minW:240` 这类手机值；`addPage` 建 1440 宽页面时这些组件直接超界。
- **修复建议**：契约按 `domain` 给两套 `sizingContract`（mobile / desktop），或去掉 `maxW` 上限只保留建议值。

### S6 `export_rp` 的 unsupported 效果只在报告里说明，画布不预警（P2，ST）

- **现象**：`filter: saturate(1.25)` 被标 `unsupported`、导出静默省略；只有导出报告能看到，设计时无提示。
- **修复建议**：`apply_commands` 的 `diagnostics` 增 `W_EXPORT_UNSUPPORTED`（附 feature 名与浏览器/导出差异），让 agent 在设计阶段就知道「这个效果进不了 .rp」。

---

## 三、共用 / 环境

### C1 工具清单变化需手动重连（P2，C）

- `runtime_info` 报 `restartRequired:false`，但 `toolCount` 变化时客户端不会自动刷新，文档要求"重新连接"。建议 MCP 侧暴露 `capabilitiesChanged` 与版本号，客户端可检测。

### C2 两条线的 ID 语义不同却同形（P1，C）

- RP1 用 `page/id`、Studio 用 `pageId + nodeId`、`apply_commands` 里又有 `op` vs `type`。对 agent 来说这是最大的心智负担之一。
- **建议**：统一为 `{page, node}` 结构化定位 + 一条「逻辑 ID 路径」字符串，两者可互转；错误信息永远给出可复制的正确形式。

---

## 四、确认正常（避免误伤）

| 项 | 结论 |
|---|---|
| `.rp` 是否真原生 | 是。`gui_roundtrip` 真开 Axure 9 存盘→关闭→重开→预览，全绿（手机范例与自由画布导出件都过） |
| 导出边界分类 | 诚实。`native-editable 10 / rasterized-effect 1 / unsupported 1`，且 `wholePageRasterized:false`、`editableTextRasterized:false` |
| 几何/字体保真 | `geometryAlignment 6/6 within 1px`，`typographyAlignment 5/5 保留`，三零通过 |
| 事务与并发 | `baseRevision + idempotencyKey + 未受影响页面哈希核验`，重放幂等 |
| 评审流程 | 拒绝自评审美分，`awaiting-visual-review` + 检查清单，符合预期 |
| 内置范例质量 | 3 页手机原型 111 元件 / 22 面板状态 / 0 悬空引用，一次过 |

---

## 五、修复批次建议

| 批次 | 内容 | 理由 |
|---|---|---|
| 1 | S3、S4、A2、A4 | 纯"agent 可用性"，改动局部、收益立刻可见；S3 是最大障碍 |
| 2 | S1、S2、A1 | 能力缺失，需要动 `commands.mjs`/`server.mjs`/workflow 解析 |
| 3 | A5、A3 | 有状态一致性风险，必须配回归；A5 是唯一 P0 数据正确性问题 |
| 4 | A6、A7、A8、A9、S5、S6、C1、C2 | 打磨与文档 |

**通用验收命令**：`npm test && npm run test:language && npm run test:sync && npm run test:mcp && npm run test:acceptance && npm run test:studio-design`。

注意：工作区当前有 19 个文件未提交改动，动手修之前先 stash/commit，避免与既有改动混在一起。

---

# 第二轮：实测修复与新发现（2026-10-27 01:0x）

备份点：`rsi-backup-20261027-010431`（tag）+ 完整 rsync 副本 `_backup/zee-axure-20261027-010431`。

## 已修复（附回归）

| ID | 修复内容 | 文件 | 回归 |
|---|---|---|---|
| A1 | 页面级属性可定位：`{target:"board", property:"name"}` 直接改 `/pages/i/name`，不再逼调用方猜 Pointer | `scripts/rp_workflow.py` | 手工验证；`test:sync` |
| A2 | 未知属性不再给错误候选（`filter→after`），改为列出该类型允许属性 | `scripts/rp_language.py` `fields()` | `test:language` |
| A4 | 溢出诊断改为人类可读句 + 修复建议（收窄/设 flex），保留结构化 `data` | `scripts/proto.py`、`scripts/mcp-tools.mjs` | `test:mcp-generate` |
| S1 | `addPage` 支持 `domain`/`device`，桌面域默认 1280×800 且不套手机壳 | `studio/commands.mjs` | `test/studio-compact-multi-check.mjs` |
| S2 | 多工程并行：`projectDir → 实例` 映射，同工程复用、异工程另起端口，先探测跨进程实例再决定是否新建 | `studio/mcp-adapter.mjs` | 同上 |
| S3 | 响应预算：MCP 层默认 compact（实测 32KB → 2.2KB，14.5×），带 8KB–12KB 字节上限与逐级降级记录，`verbose` 可回全量 | `studio/mcp-adapter.mjs` | 同上 |
| S4 | 命令 `cmd` 作为 `type` 别名；未知类型错误列出全部可用类型与相近候选 | `studio/commands.mjs` | `test:studio-repairs`（18/18） |
| S7 | Studio 导入 `.rp1` 报 `cannot import name 'parse_dsl'`：API 已改名 `dsl_to_spec` | `studio/document.mjs` | 手工验证 |
| — | 新增 `studio_design_metrics`：L1 代理指标 + 反 slop 规则 | `studio/design-metrics.mjs`（新） | `test/studio-design-metrics-check.mjs` |

## 新发现（未修）

### S8（P0）导入 `.rp1` 后布局未求解，所有子节点堆在 (24,24)
- 现象：`openProject({sourcePath:"dash.rp1"})` 后 scene 里 `node_2..node_6` 全部 `x=24,y=24`，互相重叠；页面画板仍按手机 402×874 而非源文件的 1120×680。
- 影响：自由画布无法承接既有 RP/1 资产——这是"两条线打通"的核心路径，直接堵死。
- 初判：`studio/document.mjs` 导入走 JSON 直通，未经过 RP/1 的布局求解；`scene-resolver` 已实现 row/column 布局，但导入的节点缺 `layout` 语义或坐标被宏展开固定。
- 修复方向：导入后先跑一次与 proto 相同的布局求解（或复用 `compile-plan` 的 `_x/_y/_w/_h`），并把画板尺寸取自源页面 `canvas`。

### S9（P1）ResolvedScene 不下发 `textAlign` / `align`
- 现象：doc 里 label 写了 `textAlign:"center"`，scene 节点上该字段不存在，导致度量/评审无法判断居中，也就抓不到"空洞居中标题"。
- 影响：任何依赖 scene 的工具（度量、评审、批量探索）都看不全样式意图。
- 临时绕过：`computeDesignMetrics` 已额外接收 `doc` 建立 id→对齐映射。根治应在 `scene-resolver` 补齐字段。

### A10（P1）`repeaterSetFilter` / `repeaterSetSort` 等命令"声明了但没实现"
- `studio/commands.mjs` 的 `NON_STRUCTURAL_COMMANDS` 里列了 `repeaterSetFilter`、`repeaterSetSort`，但 switch 里没有对应 `case`，调用会落到 `E_UNKNOWN_COMMAND_TYPE`。
- 与 A3（dataset 命名视图）是同一件事的两面：先补命令，再做 RP/1 DSL 的 `view=` 语法。

## 新增能力：设计度量层

`studio_design_metrics` 返回：
- 字阶比（合并相差 <8% 的字号后再算）、4px 栅格一致性、留白占比（排除背景层）、文本对比度（沿父链找真实底色）、主色相数
- 反 slop 规则：`equal-card-grid`、`purple-gradient`、`vague-centered-hero`、`icon-in-rounded-square`、`hero-without-media`、`over-rounded`
- **不返回审美总分**，只给 `meets-l1-bar / below-l1-bar` 与逐条改法

阈值见 `docs/free-canvas-design-ceiling.md` §1。

## 第三轮：打通两条线 + 度量层收敛

### 已修复（续）

| ID | 修复内容 | 文件 |
|---|---|---|
| S8 | 导入 `.rp1` 不再塌成 (24,24)：新增 `normalizeSpecShorthand`，把 DSL 简写（`{"column":"shell"}` / `{"label":"t"}`）还原为 `type + layout + id`，并把 `canvas:[w,h]` 归一为 `{w,h}`。实测 board 恢复 1120×680，`list_card 700×480 @24,173`、`detail 356×480 @740,173` 正确并排 | `studio/document.mjs` |
| S9 | `ResolvedScene` 补 `textAlign`：优先取 `n.textAlign`，再退回 `n.align` | `studio/scene-resolver.mjs` |

### 度量层收敛（避免误伤）

- **网格对齐**只量容器几何，不再把 shaped 出来的文本 w/h 当栅格决策（73% → 真实反映布局引擎的 off-grid 值）。
- **留白比**按 domain 分区间：`web 8–34%`、`mobile 30–55%`；并把 card/detail-card/stat-row 等宏容器计为实体表面（否则工作台留白永远 82%）。
- **对比度改为提示项**，不参与 L1 判定。原因：宏容器底色由内部节点绘制，沿父链可能解析不到真实底色，会把白字误判为 1.1:1。**宁可漏判，不可误伤**——一条假的"对比度不达标"会直接摧毁工具可信度。
  下一步（未做）：在 scene 里补 `effectiveBackground` 字段，让对比度可以恢复为硬判据。

### 当前 L1 判定项（5 项）

`type-scale` / `grid-alignment` / `whitespace` / `hue-discipline` / `anti-slop`；`contrast` 作为 warnings 上报。

### 回归

- `node test/studio-compact-multi-check.mjs` 全过（多工程、响应预算、addPage domain、命令别名）
- `node test/studio-design-metrics-check.mjs` 全过（4 条 slop 命中 + 正例零误伤 + 无审美总分）
- `npm run test:studio-repairs` 18/18
- `npm run test:studio-design` 6/6
- `npm run test:mcp-generate` 10/10
- `npm run test:language` 50/50

## 第四轮：外部试用 #1 反馈修复（PM 视角，原评 6/10）

试用者原话指出的三处硬伤，逐条修完：

| ID | 问题（试用者原话） | 修复 | 验证 |
|---|---|---|---|
| A11 | "开不出 web 项目：`doc.domain=mobile`，还白送一个 iPhone 首页，导出也带着它" | `studio_open_project({domain:"web"})` 全链路支持：新建空工程即 1280×800 纯 web 页，不生成 phone-shell | 新建 web 工程 → `domain:web`、`home@1280x800`、首包 1.9KB |
| A12 | "不带 `baseRevision` 的写入直接生效了，两个客户端会静默互相覆盖" | `/api/commands` 缺 `baseRevision` 直接 400 `E_BASE_REVISION_REQUIRED`，并在文案里给出当前版本号 | 手工 POST 无 baseRevision → 400 |
| A14 | "拿 mobile 的 30–45% 量 1280 宽 web 页"，`doc.domain` 盖掉页面 domain | 判定改为**页面 domain 优先**：`scenePage.domain \|\| doc.domain` | 反例页 web 阈值生效 |
| A15 | "网格只给总数，不告诉哪 11 个值、不给改法" | `gridAlignment` 输出 `offenders:[{id,prop,value,nearest}]`，detail 直接列 `node.prop=值→建议值` | `test:studio-metrics` |
| A16 | "字号 40/16=2.5 判超 1.5 会误伤所有 landing page" | 字阶上限放宽到 2.5，保留"最小间距 ≥1.2、层级 ≤4"两条真约束 | 同上 |
| A17 | "`@lable` 只报 `Node type must be text`，对拼错毫无信息量" | 类型缺失时反查可疑键名并 did-you-mean：`疑似 '@lable' 拼写错误；did you mean '@label'?` | `/tmp/typo.rp1` 实测 |
| A13 | "每次回包 7KB，带 scene + impact 整棵树，我只想知道 ok" | compact 再压：`transitiveImpact` → `impactSummary`（只留计数），去掉 `semanticDiff`、`unaffectedPagesVerification`，`humanReadableSummary` 只留三句 | `test:studio-multi` |
| 新增 | 试用者说度量"说不出'内容全挤左侧 560px、右半屏死区'" | 新增 `compositionBalance`：按水平三等分算内容面积占比，右侧 <8% 且左侧 >30% 时提示死区并给双栏改法 | `test:studio-metrics` |

回归：`test:studio-design` 6/6、`test:studio-repairs` 18/18、`test:studio-multi`、`test:studio-metrics`、`test:language` 50/50、`test:mcp-generate` 10/10、`test:sync` 22/22。

## 第五轮：设计师试用 + 复测（8/10）

### 两位试用者的独立结论一致

- **PM 复测**：6 → **8/10**，四条硬伤 3 修好、1 半修好
- **设计师**：「合格的**地板尺**，不是天花板尺」；「5 项里栅格与具象 anti-slop 站得住，字阶/留白/色相数是伪指标」

设计师最重要的一句：**现有指标全是局部属性，没有一项在测"关系"**。B 页每项局部合格，整体是一堆等重色块互抢——这才是 AI 页面的真病灶。

### 修复

| 问题 | 修复 | 验证 |
|---|---|---|
| **我加的 web 分域留白从未生效**：scene page 没有 `domain` 字段，回落到 `doc.domain` | `scene-resolver` 下发 `domain: pg.domain \|\| doc.domain` | 复测确认 |
| **对比度被兄弟堆叠旁路**：白字压色块（兄弟节点）算成 1.17:1 | 新增 `overlappingBackdrop`：按 renderOrder 取文字中心命中的最上层不透明块；遇 image 直接判"不可知"而不瞎猜 | 单元验证：白字压 `#0F172A` → **17.85:1**（原 1.17） |
| **色相数统计的是文档字段**：纯黑白页报 2 个主色相（主题 ink 挂在空节点上） | 只统计 `rawFill` / `rawStroke`（且 strokeWidth>0）/ 有文字节点的 `rawColor` | 单色页 → 1 类 |
| **网格建议把 1px 分隔线改成 0px** | 小于 grid 的发丝线跳过；`nearest` 下限取 grid | 单测 |
| **字阶误伤 display 排版**：88/24=3.667 判死 | display（≥2× 最小字号）单独计数，只判正文层级与 body 字阶比 | `display 32，body 14` → 无法评估而非不合格 |
| **留白区间宽到两边都装得下** | 降级为 warning；硬判据换成关系型指标 | — |
| **死区检测被整页底色击穿** | 构图统计排除面积 ≥90% 的整页底色 | 复测场景 `deadRight:true` |
| **漏判空洞标题**：8 字空话躲过正则 | 补 `stockSuffix`（平台/中枢/系统/引擎/生态/解决方案/新时代…）+ 无数字 + ≤14 字 | 单测 |
| **等距三卡误杀三栏索引** | 改为分级：无主次 → error；有主视觉 → warn | `test:studio-metrics` |
| **静默重排**：流式布局下写 x/y 被覆盖且无提示 | 新增 `W_LAYOUT_IGNORES_POSITION`：告知父容器布局与建议改法 | 实测复现 |
| **文本类改稿仍回整棵 scene** | 纯文本命令（≤4 条）只回受影响节点 + `sceneFiltered` 提示 | PM 复测 |
| **新增** `visual-hierarchy`：主次比 ≥2.2× 且前三块不得等重 | 质量 = 面积 × 明度反差（文字按字号加权重） | 平铺页 1.0× 判不合格；有主视觉页 25.66× 通过 |

### 反 reward hacking

- 删掉 `l1.passed/total`——它把评分拆成 5 个可逐个优化的格子，正是 reward hacking 的理想形状。
- 只保留 `ok` + `blocking[]`（每条带具体证据与改法）。

### 回归

`studio-metrics`、`studio-multi`、`studio-repairs 18/18`、`studio-design 6/6`、`language 50/50`、`mcp-generate 10/10`、`sync 22/22`。

### 仍未解

- A5 宏子节点 lift→merge 写错父节点（P0，唯一数据正确性）
- A3/A10 dataset 命名视图 + `repeaterSetFilter` 声明未实现
- 对比度：底色不可知时仍会跳过（诚实但漏判）
- `studio_explore` 批量探索未开工

## 第六轮：A5 关闭（宏子节点回写，最后一个 P0）

### 根因链（三层，缺一层都不成）

1. **简写 JSON**：`.rp1` 解析结果是 `{"detail-card": "detail", ...}`，宏节点没有 `type` 键。所有以 `node["type"]` 判断宏的守卫**全部失效**——这就是"写了守卫却没效果"的原因。
2. **lift 侧**：`_apply_prop_to_target` 对宏节点直接写 `text`；即使守卫命中，也因为找不到 type 而跳过。
3. **merge 侧**：`_resolve_ast_target` 找不到宏内部标题的源节点（它只存在于宏参数里），返回 None，被当作冲突拒绝。

### 修复

| 层 | 改动 |
|---|---|
| 类型识别 | 三处统一：`node.get("type") or next(k for k in node if k in MACRO_PROPS)` |
| lift | 命中宏且宏有 `title` 参数 → 提升为 `title`；无参数 → 记 `unsupported`，绝不产出非法 spec |
| lift 兜底 | `_apply_macro_title_fallback`：按 `<macroId>_title` 约定回落到宏参数的 title |
| lift 安全网 | `_sanitize_macro_text`：遍历整份 spec，任何宏上的 `text` 一律提升或丢弃并记账 |
| merge | 应用 delta 失败时走同一兜底，按 `macroId`（含 scoped `page/id` 与裸 id 两种写法）定位 |

### 回归

`test/rp1-macro-lift-check.mjs`（新）：
1. 生成基线 .rp → 2. 定位宏内部标题控件并改字 → 3. lift 断言宏行出现 `title="改后标题"` 且无位置参数文本 → 4. merge 断言 `status: merged` 且重建 .rp 成功。

实测：`@card #c [400x200] title="改后标题" body="正文"`，merge 通过布局门禁，重建 .rp 82KB。

`npm run test:macro-lift` / `test:sync` 22/22 / `test:language` 50/50 全绿。

## 第七轮：A10 关闭一半（声明了却没实现的命令）

`NON_STRUCTURAL_COMMANDS` 里列着 `repeaterSetFilter` / `repeaterSetSort`，但 switch 没有对应分支，调用会落到 `E_UNKNOWN_COMMAND_TYPE`。试用者对这种"文档说有、实际没有"最敏感。

### 实现

| 命令 | 行为 |
|---|---|
| `repeaterSetFilter` | 支持 `{field, equals}` 或 `{field, in:[...]}`；`clear:true` 移除过滤 |
| `repeaterSetSort` | 支持 `{field, direction: asc\|desc}` |

- 形状校验：缺 `field`、或 `equals`/`in` 都没给 → `E_FILTER_SHAPE`（附正确示例）
- 目标校验：不指向 repeater → `E_REPEATER_REQUIRED`
- 场景层真实生效：`scene` 节点的 `rows` 按 filter/sort 计算，并暴露 `rowCount / totalRows / filtered / filter`，compact 投影同样保留这几个字段（否则调用方看不见效果）

实测：3 行数据集 → `equals:"已支付"` → `rowCount:2 / totalRows:3 / filtered:true`。

回归并入 `test:studio-multi`（新增 4 条断言，含非法形状负例）。

### 仍欠

- **A3**：RP/1 DSL 侧的 `view=` / `set-view` 命名视图（Studio 命令层已通，声明式语法未做）
- `studio_explore` 批量探索 + 自动收敛
- 「锚点驱动参考」：从项目历史页面提取锚点配方

## 第八轮：能力建设（探索 + 锚点）

代码级缺陷已清零，本轮补"抬高上限"的两根支柱。

### `studio_design_explore`（批量探索 + 自动收敛）

- 轴：密度（紧凑/常规/疏朗）× 字阶（收/常规/放）× 圆角（直角/柔/大）× 配色（mono/warm/cool/ink）
- 每个变体：克隆文档 → 应用参数 → 真实解析 scene → 跑同一套指标 → 打分
- 排序：**未达标项数 → 反 slop 硬伤 → 提示数 → 改动量**（同分偏好少改动，防止为指标大改版式）
- 输出：每个变体的 `commands` 可直接 `studio_apply_commands` 提交；`advice` 会区分「参数能修」与「必须改版式/补素材」
- 不写文档（纯预演），不给审美总分

实测（看板页）：12 个组合中 `blocking` 全为 2 → 结论直接说"参数级调整无法再减少未达标项"，而不是硬推一个"更优"变体。

### `studio_design_anchors`（锚点驱动参考）

- `extract`：把已认可的页面提炼成配方（字阶 sizes/bodyRatios、栅格率、留白、色相、主次比、构图三分占比），写入 `<project>/design-anchors.json`
- `compare`：其它页面与锚点均值比对，输出 `{key, current, anchor, delta, meaningful}`，结论是数字句
- `list`：读回；无锚点时明确报 `E_NO_ANCHORS`，不编参照

实测：次级页与锚点比对 → `主次比 1× vs 18.84×`、`留白 63% vs 44.8%`、`字阶层级 0 vs 1`。

### 回归

`test:studio-explore`（12 断言，含"命令可提交且文档真变"）、`test:studio-anchors`（10 断言，含无锚点负例）全过。

### 基线指纹

`npm test` 的 17 项里有一项会因 `scripts/*.mjs` 变更而失败（防止脚本被意外改动）。本轮改了 `mcp-tools.mjs`（A4 可读诊断），已重新登记 `test/baseline-shas.json` 中该文件的 SHA-256；**只有这一项被重登记**，其余保持原值。改后 `npm test` 17/17。

## 第九轮：设计师试用 #2（4/10）后的修复

试用者逐条给了文件行号，全部成立。按火气排序修复：

### 判决失效类（最严重）

| 问题 | 修复 |
|---|---|
| **空画板 5/5 `meets-l1-bar`**，且不传 pageId 默认量的就是它 | 增加内容门槛：文字/图片/无子实心块（面积 <60% 画板）不足 2 个 → `verdict: not-assessable`，只回 `content-presence` 一条 |
| 「无法评估」被算作 ✓ | 同上，不可评估不再是"通过" |
| `hierarchy=null` 时 anti-slop 谎称"已确认主次" | 文案分支改为"页面块数不足，无法确认主次" |

### 度量口径

| 问题 | 修复 |
|---|---|
| token 颜色不计数 → 正常工程"主色相 0 类" | 显式 token 引用（`$brand` 等）取解析后颜色；仍不猜没有 raw 值的节点（避免主题默认色假阳性） |
| 栅格 97% 但 `offenders` 为空（1px 分隔线进分母不进明细） | 分母只统计 ≥grid 的值，越界项与失败数必然一致 |
| web 留白带宽 8–34% 把编辑页判成过密 | web 改 8–58%、mobile 25–60%，并修掉 `57.999999%` 的浮点显示 |
| 主次比：图片固定 0.15 反差加成，纯文字 hero 天生输 | 图片权重改为 ×1.15，文字按字号更强度加权；层级计算改用**末级视觉单元**（父容器与子块同时计入会把 3.7× 稀释成 1.4×） |
| `addNode` 拒绝 `divider`（场景其实支持） | 命令层补齐 divider/spacer/detail-card/data-table/searchable-list/master-detail |

### 锚点

| 问题 | 修复 |
|---|---|
| 单位错 100 倍：`0.647% vs 0.448%` | 比例为 % 时统一 ×100，tolerance 也按百分点（8pp） |
| 配方只有 6 个标量 | 新增 `structure`：`imageShare`（主图占画面比）、`columnWidths`、`leftEdges`（对齐基线）、`spacingRhythm`、`blockCount` |
| 默认把不合格页（含空页）也立成锚点 | 默认只锚 `meets-l1-bar` 的页面，其余进 `skipped` 并给原因；`includeBelowBar` 可覆盖 |
| 主次比没进 compare | 随层级计算修复后恢复；实测输出 `主次比 1.9× vs 3.3×` |

### 探索

| 问题 | 修复 |
|---|---|
| 8 个候选全是「mono·紧凑」——四层循环的前缀 | 改为贪心铺开采样（每轮选"未覆盖轴值最多"的组合），实测 8 个候选覆盖 4 种配色 × 2 档密度 |
| 标签写"紧凑"但没有一条 padding/gap 命令 | 标签由**实际生成的命令**反推；无命令的变体直接丢弃，不占名额 |
| 字阶轴数学上无效（等比缩放不改变比值） | 只缩放正文（≤20px），display 不动，比值才会变 |
| 排序二值无梯度（1.95 与 0.1 同分） | 增加 `distanceToPass`：按各检查离门槛的距离归一求和，作为第三排序键 |
| "改动量"用参数族数、平手按 id 排序 | 改为**命令条数**排序 |
| 基线通过时仍说"可直接提交（0 条命令）" | 改为"当前版本已通过全部结构性判据；N 个参数级变体没有更优的…要再往上走需要改结构：主图占比/栏宽比/图文换位" |
| advice 直吐 check key | 增加中文映射（字号阶梯/间距栅格/主次关系/AI 味样式…） |

### 回归

`test:studio-metrics` 新增 5 条（空页、token 色相、divider、offenders 一致性）；
`test:studio-anchors` 新增 2 条（百分比换算、主次比进入对比）；
`test:studio-explore` 新增 2 条（候选铺开、标签与命令一致）。
全套：`npm test` 17/17、studio-* 全过、macro-lift 全过。

### 补：候选池去重（试用者第 3 条火气）

修完铺开采样后仍出现「8 个候选只有 4 种标签」——因为半径轴在这页空转，两个参数组合落到同一组命令。现在按**命令集签名去重**，并补两条断言：候选命令集互不相同、标签互不重复。
实测：8 个组合 → 4 个真实候选 + 基线，标签为「配色 暖·疏朗·正文字阶放 / 配色 暗·… / 配色 单色·紧凑·正文字阶收 / 配色 冷·…」。

## 第十轮：设计师复测 #2（5.5/10）后的修复

### 修好

| 问题 | 修复 | 验证 |
|---|---|---|
| **token 色相静默失效**：`fill:"$brand"` → `distinctHues:0` 且 `ok:true` | scene 的 `fill/stroke/color` 本就是解析后的颜色；删除"只有 raw 值是 token 才取解析色"的错误条件 | 实测 `$brand=#E0533D` → `2 类（0°, 210°）` |
| **栅格两套账**：失败 3 列 6 条 / 失败 22 列 6 条 | 文本节点（label/paragraph）整体退出栅格统计；`offenderCount` 恒等于 `total-aligned`，清单只截断展示 | 新增断言跨 3 个页面校验账目 |
| **`pages:["lazy"]` 静默换掉参照系** | 显式 pages 也过达标线；新增 `mode: append|replace`（默认 append）；新增 `action:"approve"` 让人工认可低于 bar 的页面并标 `approvedBy:"human"` | 实测：偷懒页不被塞入；approve 后追加且标注来源 |
| 空页仍报 `hero-without-media` | 不可评估时 `slop: []` | 断言 |

### 部分修好

| 问题 | 现状 |
|---|---|
| **探索候选全打平、best=别动** | 引入连续目标（栅格率 0.35 + 主次比 0.3 + 硬伤 0.2 + 配色 0.1 + 留白 0.05）；只有**硬指标退化**（hard slop 增加 / 栅格掉 >5pp / 主次比掉 >0.25）才淘汰，等价配色不再被误杀；候选池改为**先给每条轴一个纯净变体**，再铺开组合 |
| **明知更差仍并列** | 排序主键改 `blocking → 连续目标 → 硬伤 → 距离 → 命令数`；被淘汰的候选连同 `params` 一起回传，便于核对 |
| **缺结构轴** | 新增 `proportion`（even / dominant）：对并排定宽子项按 1:1 或 2:1 重分配宽度。**注意：只对"一行里有两个以上定宽子项"的页面生效**；纯堆叠页（如偷懒页三卡）仍无结构轴可用 |

### 仍未解（诚实记录）

- 探索无法改**内容**：`vague-centered-hero`（空洞标题）属于文案层，参数与结构轴都碰不到；这类需要"改写文案 + 换素材"的独立能力。
- `no pageId` 的语义仍是 `pages[0]`，只是不再假通过；没有"你可能想看哪页"的提示。
- compare 仍只报偏离量，没有"往哪个方向改"的建议。

回归：`studio-explore` / `anchors` / `metrics` / `multi` / `repairs 18` / `design 6` / `macro-lift` / `npm test 17` 全过。

## 第十一轮：补上复测指出的两个缺口

### compare 现在给方向，不只给偏离

`studio_design_anchors({action:"compare"})` 新增 `suggestions`：

```
留白占比 | 减少留白 | 留白比锚点多 10.8 个百分点：把主内容列加宽或把主图放大占位（锚点均值 62.3%）
主次比   | 强化主次 | 主次比 1.9×，锚点 3.3×：把 big_title 放到第二名的 2.5 倍视觉重量（放大高度/换图/加深底色），其余块降级
```

规则：每条建议必须带**具体节点 id 或具体数值**，禁止"更有设计感"这类空话（测试里有正则拦截）。

### 堆叠页也能有结构轴

复测指出 `proportion` 只对行容器生效，三张堆叠卡仍然无解。新增 `hierarchy: "feature-first"`：
把根级 ≥3 个定宽块按纵向排序，首块高度拉到总高 60%（不超过自身 2.4 倍），其余均分剩余，**高度对齐 4px 网格**（否则会因栅格掉点被淘汰）。

实测偷懒页（三等分卡 + 空洞标题）：

| 变体 | 未达标项 | 连续目标 |
|---|---|---|
| baseline | 2 | 0.793 |
| **v1 主块前置** | **1** | **0.906** |
| 配色/密度变体 | 2 | 0.77–0.79 |

`best` 第一次不是 baseline，而且它修好的正是复测里那条「主次比 1.6×、vague-centered-hero」中的主次比。文案层（空洞标题）仍然修不了——如实记录。

### 回归

`test:studio-explore` 新增 2 条（结构轴命令改 h、best 能降未达标项）；`test:studio-anchors` 新增 1 条（建议必须具体）。
全套：`npm test 17`、studio-* 全过、macro-lift 全过。

## 第十二轮：第四轮验收（6.5/10）后的修复

试用者最关键的一句：**同一个 revision 里 explore 说"可直接提交"、metrics 说"meets-l1-bar"、review 说 5 个节点在画板外。**

### 根因与修复

| 问题 | 修复 |
|---|---|
| **containment 完全缺席**：撑高标题换来"主次比改善"，代价是内容被挤出画板 | `design-metrics` 新增 `containment` 硬检查：越出画板 / 文字溢出容器，逐条点名节点与溢出方向像素；不可评估页同样带数据 |
| **explore 的 objective 看不到越界** | objective 增加 containment 惩罚（每个 −0.12，上限 −0.6）；淘汰规则新增"越界元素多于基线"，理由写明具体数字而不是常量盖章 |
| **结构轴把内容撑出画板** | `hierarchy` 变换按画板剩余高度夹一次（并对齐 4px），不再无上限拉高 |
| **锚点参照系可被灌脏**：`includeBelowBar` 把空页（whitespace=1.0）均值拉成 86.1%，建议"留白加到 86%、字阶合并到 0.5 级" | `compare` 只采用 `meets-l1-bar` 或 `approvedBy:"human"` 的锚点；被剔除的进 `droppedAnchors` 并在 note 里说明 |
| **人读文案瞒账**：31 条越界只列 12 条且不说明 | 明细后追加「（共 N 个，仅列 M）」 |
| **typeScale 轴数学无效**（等比缩放不改变比值） | 改为只放大"最大的那一级正文字号"，比值才会变 |

### 重点验证（复现试用者的作弊路径）

把「24px 居中标题 + 三等分卡」放进 800 高画板并留出边界后再探索：

- 拟合页：`v1 主块前置 b=0`（基线 b=2），并且 containment 保持 0；越界变体被淘汰，理由为「越界元素 N 个（基线 0）」或「栅格率 60% < 基线 100%」
- 溢出版本：基线自身 containment=1 时，探索不再宣称"可直接提交"，`best` 与基线并列在最差档

### 回归

`studio-metrics` 新增 3 条（越界必须不通过、明细点名、不得判合格）；`studio-explore` 新增 1 条（入选候选越界数不得高于基线）。
全套：`npm test 17`、`studio-*` 全过、`macro-lift` 全过。

## 第十三轮：A3 关闭 + 结论自洽

### A3（RP/1 侧行过滤）——落地

`@repeater` 现在支持 `where="=item.status == \"已支付\""`：

- 编译期用同一套表达式求值器，按行求布尔值过滤
- 过滤结果同时驱动**模板实例与行数**（`language-ir.json` 里 `rows: 2, where: "..."`）
- 表达式非法 → `E_WHERE`（附原始错误），不会静默变成 0 行
- 与 Studio 的 `repeaterSetFilter` 语义对齐：一个是源码期，一个是运行时

回归 `test/rp1-repeater-where-check.mjs`（4 条断言，含非法表达式负例）。

> 注意：这是**编译期**过滤，不产生"点击切换筛选"的交互；动态筛选仍用 Studio 的 `repeaterSetFilter`。这点如实写在测试注释里。

### 结论自洽：warning 不再与 verdict 打架

试用者指出「被判 meets-l1-bar 的页同时被说留白 65%、右侧死区、3 处对比度不达标，工具不解释」。

现在 summary 首行改为：

```
页面 home：meets-l1-bar（另有 3 条提示，不参与判定）
```

并把 `warnings` 明细列在下方。判定逻辑没变，但**读者不会再以为"合格"等于"没问题"**。

### 回归

`npm test` 17/17；`repeater-where`、`studio-metrics/explore/anchors/multi`、`repairs 18`、`design 6`、`macro-lift`、`language 50` 全过。

## 第十四轮：把"三个工具互相打脸"变成可回归的契约

试用者连续两轮追同一件事：`explore` 说可提交、`metrics` 说合格、`review` 说 5 个节点在画板外。现在把这三者的**一致性**写成测试，而不是靠人工对账。

`test/studio-consistency-check.mjs`（新增，9 条断言）：

1. metrics 能看见越界，且点名具体节点
2. 有越界时**不得**判 `meets-l1-bar`
3. explore 的基线越界数与 metrics **必须相等**
4. 入选候选的越界数不得高于基线
5. 被淘汰候选必须给具体理由（不允许"硬指标退化"这种盖章）
6. 候选命令可提交，且**实跑越界不高于仿真**

实测：一个 `stack` 容器里塞了 `far(width 200, x 1200)`，metrics 报 `越出画板 2 个：free(right+32), far(right+152)`，verdict `below-l1-bar`；explore 基线 containment 同为 2，所有入选候选 ≤2。

> 说明：`free` 被计入越界是因为它放在带 padding 的 column 里、自身仍按 1280 宽排 —— 这是真实越界，不是误报。

`test:studio-consistency` 已加入脚本；`npm test 17/17`、`studio-*` 全过、`language 50` 全过。

## 第十五轮：一致性 7/10 后的四处修补

### A. 1px 越界导致两家分裂（metrics 判合格，review 判越界）

成因：metrics 用 `>1px` 的整数和，review 用 `<0` 的半点容差。

修复：**统一 0.5px 容差**，并让 review 不再自己遍历坐标，而是**直接消费 metrics 的 containment 结果**（单一事实来源）。review 另外补了 `W_TEXT_OVERFLOW`。

实测：`y=-1` 的卡片现在两侧都判越界；`outside.total` 与 `W_OUTSIDE_SCREEN` 条数一致。

### B. explore 的 rule 文本与实际排序键不符

原 `rankKey` 是 `blocking → -objective → slopErrors`，但文案写的是"未达标项 → 反 slop 硬伤 → 提示数"。结果：带 `W_ANTI_SLOP` 硬伤的 v1 排在了无硬伤的 v6 前面。

修复：排序改为 `blocking → slopErrors → -objective → distance → 命令数`，文案同步；`variants[].objective` 现在显式返回（之前被 `summarize` 削掉，无法审计）。

### C. review 的 findings 没有 severity，且通过页仍抛 W_ANTI_SLOP

修复：所有 findings 带 `severity`；warn 级 slop 与度量提示统一走 `W_DESIGN_ADVISORY`（`severity: warning`），不再以 `W_ANTI_SLOP` 出现在"通过"的页面上。

### D. axes 入参不生效 + typeScale 是死代码

- `axes` 现在真的过滤候选（传 `{typeScale:[...]}` 只出字阶变体）
- typeScale 从"未生效的死代码"改为**只放大最大的那一级正文字号**（比值才会变），实测产出 `fontSize: 14.7 / 17.9` 的命令

### 附带：主次比只有下限、没有上限

试用者指出：已通过的页面仍被推荐把 24px 标题撑到 232px 高（dominance 4.28× → 12.28×），三个工具都不拦。

修复：`overDominant` 判定 —— **文字块**主次比 >8×，或任一块占画板 >80% 面积，判失衡并让 `visual-hierarchy` 不通过。
（只对大图做例外：hero 图主导画面是正常设计，不该被上限误伤。）

另外：基线已通过且没有候选把目标提升 >0.02 时，`best` 回落到基线，advice 改为"不需要改动"。

### 回归

`studio-metrics` 新增 5 条（1px 越界、失衡判定、visual-hierarchy 不通过）；`studio-explore` 新增 2 条（rule 文案一致、objective 可审计）。
`npm test 17/17`、`consistency / anchors / multi / repeater-where / repairs 18 / design 6 / macro-lift` 全过。

## 第十六轮：第五根支柱落地（导出预算前置）

设计师之前点过一处矛盾：被判 `meets-l1-bar` 的页面，导出时 `filter` 被静默丢弃。设计阶段看不到这个代价。

### 新增 `metrics.exportBudget`

按元素投影三类结果（与 `studio_export_rp` 的分类口径一致）：

| 分类 | 触发 | 后果 |
|---|---|---|
| native | 普通样式 | 原生可编辑 |
| rasterized | 背景渐变、阴影、内部渐变 | 导出为 PNG 装饰面，文字仍可编辑 |
| dropped | `filter` / `backdropFilter` / `mask` / `mixBlendMode` / `transform` / `clipPath` | 导出时**直接丢弃** |

返回 `{total, native, rasterized, dropped, nativeShare, items[], note}`，并按情况给提示：

- `dropped > 0` → 提示「有 N 个元素用了会丢弃的效果」+ 具体节点与 feature
- 否则 `rasterized > 0` → 提示「N 个元素会以栅格图进入 .rp」
- 不可评估页面也照样给（空页也可能塞了效果）

`summary` 增加一行：`导出预算：native 50%（2/4），栅格化 1，丢弃 1`。

### 边界诚实声明

`note` 明写「静态投影，按元素计数；真实保真度以 `studio_export_rp` 的报告为准」——不冒充导出器。

### 回归

`studio-metrics` 新增 4 条（有分类、有丢弃时提示、note 明确静态投影）。`npm test 17/17`、studio 全套通过。

### 自查发现：预测与真实导出不一致（已改成诚实标注）

我用同一页面对比了投影与真实导出报告：

```
投影:  rasterized 1 (k1 渐变) / dropped 1 (k2 filter)
真实:  compatibilityCounts { native-editable: 6, rasterized-effect: 2, unsupported: 0 }
       entries: k2 rasterized-effect(filter) + k2 native-editable(box)
```

**真实导出把 `filter` 栅格化了，不是丢弃。** 说明静态阶段无法确知这类效果的去向（同一效果在不同结构下既可能被栅格化也可能被省略）。

处理：把 `filter / mask / backdrop / mixBlendMode / transform / clipPath` 从 `dropped` 改为 **`uncertain`**，并在提示与 `note` 里明说「可能被栅格化也可能被省略，以 studio_export_rp 报告为准」。

**不做假精度**：预测错了就降级成"不确定"，而不是继续宣称能预测导出器。

## 第十七轮：导出报表口径对齐 + 撑高文字单独归因（7.0/10 后）

试用者两条核心批评，都成立：

### 1. 报表分母不自洽

真实导出是**加性**模型：每个节点都是 `native-editable` 基底，效果另加一条 `rasterized-effect`。所以 6 个节点出现 8 条 entry 是正常的——但我把投影做成了**互斥桶**，还给了 `nativeShare 66.7%`，与真实 `6/6 native-editable` 直接冲突。

修复：
- 改为加性口径：`{nodes, nativeBase(=nodes), rasterized, uncertain, unsupported, decorations}`，删除 `nativeShare`
- 词表与导出报告对齐：`rasterized-effect` / `unsupported` / `uncertain`（`dropped` 作为 `unsupported` 的别名保留，避免下游断言突断）
- 提示不再互相吞：栅格化、不确定、不支持**三类各报一句**（此前 `uncertain>0` 时栅格化提示被 `else if` 挡掉）

### 2. 主次比在称盒子，不在看文字

试用者的反证很狠：加一个 1000×400 的大块后，同一个「24px 标题被撑到 232px」的页面，结论从"主块过大"变成"主次比不足"——**归因是侥幸的**。

修复：
- 文字块质量改用 **`contentH`（实际文字高度）**，不再用外框高度
- 新增 `stretchedText`：外框高 > 文字高 ×1.5 时单独记录 `{id, boxH, contentH}`
- `visual-hierarchy` 增加条件：存在被撑高的文字框即不通过，并在 detail 里写「t 框高 232 vs 文字 34——撑高不等于更重要」

这样即使旁边加了巨大的块，撑高文字仍然会被点名，不再依赖主次比数值。

### 回归

`studio-metrics` 断言更新为：`stretchedText` 必须命中 `big_t`、`nativeBase == nodes`、verdict 词表必须落在三类内、三类提示互不吞。
`npm test 17/17`、studio 全套通过。

## 第十八轮：P2 语义角色与关系约束（补上"局部属性之外"的判据）

设计师反复说：现有指标全是**局部属性**，没有一项在测**关系**。主次比算一种，但它只量视觉重量，量不出"这页该有几个主操作""列表没数据时会不会空白"。

### 新增 `role` + 三项关系检查

节点可带 `role`（`primary-action` / `secondary-action` / `empty-state` / …），scene 下发该字段。新增检查：

| 检查 | 判据 | 为什么是关系 |
|---|---|---|
| `primary-action-unique` | 每页 ≤1 个主操作；0 个只作提示（纯展示页合法） | 一屏两个并列 CTA 是产品判断问题，不是尺寸问题 |
| `tap-target` | 可点元素最小边 ≥32（web）/ ≥44（mobile） | 只看单个元素，但判的是"人能不能点到" |
| `empty-state-coverage` | 有 repeater/list-item/data-table 就必须有 `role:"empty-state"` | 数据为 0 时页面空白，是交付级缺陷 |

实测：

```
primary-action-unique → false | 2 个主操作并列（b1, b2）——一屏只该有一个
tap-target            → false | 1 个可点元素小于 32px（b2 28px）
empty-state-coverage  → false | 有 1 个列表但没有空态（role:"empty-state"）——数据为 0 时页面会空白
```

补上空态、把次操作降级后三项转正（有测试覆盖）。

### 说明边界

- 没有主操作时不判失败，只给提示——纯展示页合法
- 没有可交互元素时 `tap-target` 直接通过并说明"跳过"
- 角色是**可选**的；不写 role 不会凭空失败，只是这些关系检查拿不到信号

### 回归

`studio-metrics` 新增 4 条（主操作并列、点击区过小、有列表无空态、修好后转正）。`npm test 17/17`、studio 全套通过。

## 第十九轮：关系层从"数注解"改成"读结构"（7.5/10 后）

试用者的判词很准：**"它现在读的是注解，不是结构"**。逐条修：

### 1. `primary-action-unique` 基本失效

根因两层：scene 不投影 `variant`；组件实例路径下 `type` 退化成 `box`。于是只有手写 `role` 能触发。

修复：
- scene 下发 `variant`、`component`、`componentVariant`
- 主操作识别三路合一：`role` / `button.variant==='primary'` / `component==='button' && componentVariant==='primary'`
- **"并列"改为同容器判定**：页头与页脚各一个主操作是正常的，不再误报

实测：同一 row 里两个 primary → `2 个主操作挤在同一容器（b1, b2）`；页头 + 页脚 → `2 个主操作分散在不同区域，不算并列`。

### 2. 撑高文字：嵌套失明 + 控件误报

原来只扫顶层块（卡片里的标题扫不到），且阈值只按比例（44px 按钮 44 vs 22 被误判）。

修复：
- 扫**全页文字节点**
- 阈值改为 `框高 - 文字高 > 40` **且** `框高 > 1.5×文字高` 双条件

实测：卡内 232/34 仍被点名；44px 按钮不再误报。

### 3. 不适用的检查不再白送分母

`tap-target` / `empty-state-coverage` / 无主操作时标记 `skipped`，`l1` 只统计实际参与的检查，并在 `l1.skipped` 里列出。

### 4. 导出词表：不再宣称"与导出一致"

对比真实报告后按实测校准：`filter/mask/backdrop → 栅格装饰层`，`transform/clipPath → 不支持`，`背景渐变 → 栅格装饰层`（节点本身仍 native）。
note 改为明说**"本投影独立于导出器，可能与导出报告不完全一致，真实结论以报告为准"**——去掉上一轮那句假话。

### 回归

`studio-metrics` 断言更新（加 transform 页、decorations 计数）。`npm test 17/17`、studio 全套通过。

## 第二十轮：空态绑定 + 热区 + 交付报告

### 空态从"全页存在"改为"绑到具体列表"

- `role:"empty-state"` + `for:"<列表 id>"` 才算覆盖该列表
- 只有一个列表时，未绑定的空态仍可接受（向后兼容）
- 多列表且未绑定 → 明确报「空态未绑定到具体列表（补 for:"<列表id>"）」

实测：2 个列表 + 1 个未绑定空态 → 不通过；分别绑 r1/r2 后 → `列表 2 个，空态分别绑定（empty1→r1，empty2→r2）`。

### 点击区从"图形尺寸"改为"热区"

- 支持 `hitW/hitH`（或 `hitArea`），scene 下发该字段
- 20×20 的图标 + 44×44 热区 → 通过；没有热区时才按图形尺寸判

### 交付物

新增 `docs/design-tools-trial-report.md`：7 轮试用分数轨迹、四类反复出现的问题、逐轮结构性修复、仍未解的能力缺口、当前可验证状态。

### 回归

`studio-metrics` 新增 4 条（未绑定不通过、绑定后转正、热区不足判出、补齐热区转正）。`npm test 17/17`、studio 全套通过。

## 第二十一轮：从"诊断"到"开方"（studio_design_fix_plan）

试用者一直的抱怨是"工具说得出哪里错，但不给可执行修法"。新增修复计划工具，只开**确定性处方**：

| 处方 | 触发 | 命令 |
|---|---|---|
| 位置吸附 | 栅格越界的 x/y | `setProperties{x,y}` 到最近的 4 倍数 |
| 热区补足 | 可点元素热区 <32（web）/44（mobile） | `setProperties{hitW,hitH}` |
| 补绑定空态 | 列表无 `for` 绑定的空态 | `addNode{role:"empty-state", for:"<listId>"}`，位置按列表下缘 +16 |
| 撑高文字回缩 | `stretchedText` 命中 | `setProperties{h: contentH}` |

**不做的事**：字阶、配色、构图——这些是取舍，留给 `studio_design_explore` 与锚点对比。测试里有断言禁止计划改 `fontSize/fill/color/stroke`。

实测（一页四个阻塞项）：

```
before: type-scale, tap-target, empty-state-coverage, visual-hierarchy
plan  : 3 条命令（热区 20→32、补空态 r1_empty、文字框 232→36）
after : type-scale（唯一剩下的，属内容层问题）
```

**只给命令，不自动提交**——应用与否由调用方决定。

### 回归

`test:studio-fix-plan`（8 条断言：命令产出、确定性声明、三类处方命中、不碰取舍属性、可直接提交、阻塞项减少）。
`npm test 17/17`、studio 全套通过。

## 第二十二轮：修复计划"自证"（7.0/10 后，按试用者唯一优先项）

试用者的判词：**"它开始用元数据刷绿；一个会把自己刷绿的守门员，比没有守门员更危险"**。
他点名的三处谎 + 一处矛盾，全部处理：

### 1. 计划必须自证（核心）

`POST /api/design/fix-plan` 现在：

1. 生成候选命令
2. 在**文档副本**上逐条试跑（`applySingleCommand` + 重新 resolve + 重跑同一份 metrics）
3. 只有"某条检查真的转正且不让别的变差"才保留
4. 再加一轮收敛：被拒命令在前提变化后重试
5. 返回 `commands`（保留）、`rejected`（附原因）、`projected.before/after`、`verified: true`

实测：一页 2 个阻塞项 → 计划保留 2 条命令 → `after: meets-l1-bar`；被拒命令必须给出原因。

### 2. 坐标系统混用（写 local 却用 absolute）

原来把 scene 的绝对 x 写回 `setProperties.x`，父容器 padding 再叠一次，实测位移 31px。
改为用 `relX/relY + delta` 换算成局部坐标。

### 3. 幽灵热区（hitW 无消费点）

`hitW/hitH` 只在度量与 scene 里透传，渲染层零引用。不再生成这类命令，改为 `manual` 条目并说明两个真实选项（撑大图形 / 先实现命中区）。

**宁可让检查保持红色，也不靠没人读的字段刷绿。**

### 4. 空态是白板

- 空态必须有内容（文字或子节点），否则不通过：`空态没有内容（只有 role 没有文字）——渲染出来是白板`
- 计划生成的空态自带「暂无数据 / 点右上角新建一条记录」两个子节点
- 去掉"单列表可豁免绑定"的分支——那是 ok:true 却输出错误文案的自相矛盾来源

### 5. 对比度忽略自身 fill

白字压在 `#111827` 按钮上报 1.1:1（真实 17.7），因为只沿父链找底。现在先看节点自身 fill，实测 `minRatio 10.31、failing 0`。

### 回归

`test:studio-fix-plan` 改写为验"自证"：必须有 `verified/projected`、被拒必须给原因、热区不得以 hitW 形式假绿、空态必须带内容。
`npm test 17/17`、studio 全套通过。

## 第二十三轮：内容脚手架（补那 55% 里的第一块）

试用者把剩余扣分拆成"能修没修 45% / 内容层 55%"。脚手架是内容层里**唯一能确定性地做**的部分。

### `studio_design_content_plan`

扫描两类"只有结构没有文案"的位置：

| 类型 | 触发 | 输出 |
|---|---|---|
| 空态无文案 | `role:"empty-state"` 且自身与子节点都没有文字 | `needs:[对象名, 下一步动作]`、模板 `还没有{对象}｜先{动作}`、示例、可提交的 `applyWith` |
| 口号式大标题 | 居中、≥28px、以"让/我们/开启…"开头或以"平台/中枢/系统…"结尾 | `needs:[角色, 场景, 可量化结果]`、模板 `把{对象}的{场景}从{A}压到{B}`、示例 |

**明确不假装会写文案**：`caveat` 写着"这里只给槽位与示例，不假装会写文案。填完用 applyWith 提交；文案的最终判断权在使用者。"

实测：一页两个问题 → 两条脚手架；提交 `applyWith` 后 `vague-centered-hero` 消失、`empty-state-coverage` 转正（空态有了文字）。

### 为什么不做渲染层热区

`hitW/hitH` 要让渲染层真正消费，需要改命中映射（`data-node-id` 的委托、overlay 定位、overflow 裁剪），风险高于收益；当前把它列在 `fix_plan.manual` 里，写明两条真实路径。**宁可红着，也不假绿。**

### 回归

`test:studio-content`（8 条断言：两类都能识别、模板含槽位、示例可执行、命令可提交、提交后口号消失、caveat 诚实）。
`npm test 17/17`、studio 全套通过。

## 第二十四轮：自查"还能不能靠元数据刷绿"

按试用者的判词自查，堵掉两条：

### 1. `tap-target` 不再认 `hitW/hitH`

渲染层没有消费点，用它判绿就是元数据刷绿。现在只量真实绘制尺寸——**热区问题会一直红着**，直到渲染层真的实现命中区。`fix_plan.manual` 里写明两条路径。

### 2. 空态"有子节点"不算有内容

原来只看 `childrenIds.length > 0`，一个塞了空盒子的空态也能过。现在递归检查后代，**必须出现文字或图片**才算。

### 3. 顺带修掉一个真 bug：`childrenIds` 是 scoped id

`childrenIds` 存的是 `page/child` 形式，而多处用裸 id 查找 → 永远找不到子节点。这既让空态检查误判，也让 `icon-in-rounded-square` 的反 slop 规则失效。现在统一 `childOf()` 解析（裸 id / scoped id / 末段名）。

### 回归

`studio-metrics` 断言更新为"hitW 不能刷绿"；fixtures 的子节点改为可渲染文字。
`npm test 17/17`、studio 全套通过。

## 第二十五轮：堵住三条"结构刷绿"通路（6.5/10 后）

试用者给出一份完整的"全绿白板"路径，三条独立通路全部成立。逐条堵：

### 1. 幽灵盒子伪造主次比（最狠）

`{type:"box", w:1000, h:520, fill:"rgba(0,0,0,0)"}` → `dominanceRatio 12.66` → L1 绿，而且因为"已确认主次"，把唯一会抓它的 `hero-without-media` 降成 warn。**守门员被自己的指标说服。**

修复：主次比只统计**可见块**（有真实文字、有效 src、非透明填充、或描边）。幽灵块不参与，主次比不再由它贡献。

### 2. 零宽字符把白板变"有内容"

`text:"\u200b"` / `src:" "` 原来算有内容。修复：统一 `realText()`（剥 U+200B–200F、U+2060、U+FEFF、trim）与 `realSrc()`。

### 3. `type:"label"` + `on.click` 绕过点击区

白名单只认 button/input/icon。修复：**任何挂 `click` 的节点都是可交互元素**。

### 4. wrapper 拆分绕过"主操作并列"

两个 primary 各包一层 box 就被判"分散在不同区域"。修复：按**最近共同布局祖先**判定——共同祖先是根时，只有两者都直接挂在根上才算同屏抢焦点（页头/页脚各有容器属正常）。

### 5. 修复计划：严格化 + 说清"修不了"

- 接受标准改为**整页阻塞项必须严格减少**（原来只看"某一项转正"，会下发一条顺手带出新问题的命令）
- 新增 `unfixable[]`：对剩余阻塞项逐条给原因（热区需渲染层、主次比需真内容、字阶属内容决策）

### 6. 内容脚手架三处

- 子节点查找改用 scoped id 解析（原来永远找不到，导致"已有文案的空态"被误报）
- `applyWith` 指向**子文案节点**而不是父容器（原来会把文字写到容器上造成溢出）
- 零宽/空白同样不算文案

### 7. 导出预算补 `customFilter`

`customFilter:"blur(8px)"` 原来 rasterized=0，真实导出是 `rasterized-effect:1`。已计入栅格装饰层。

### 回归

`studio-metrics` / `content` / `fix-plan` 断言更新；`npm test 17/17`、studio 全套通过。

## 第二十六轮：把攻击面固化成回归（test:studio-anti-gaming）

试用者的三条"全绿白板"通路已修，本轮把它们写成**必须一直不成立的断言**：

| 攻击 | 断言 |
|---|---|
| 幽灵盒子撑主次比 | `visualHierarchy.dominantId !== 'ghost'`（不可见块不进统计） |
| 零宽字符当空态文案 | `empty-state-coverage` 必须为 false |
| `label` + `on.click` 绕过点击区 | `tap-target` 必须为 false |
| wrapper 拆分绕过主操作并列 | `primary-action-unique` 必须为 false |
| `customFilter` 不进预算 | `exportBudget.rasterized >= 1` |
| 修复计划下发无效命令 | `projected.after.blocking < before.blocking`，且 `unfixable` 必须给原因 |

命令：`npm run test:studio-anti-gaming`。

## 定位收敛

经过 9 轮外部试用（4 → 5.5 → 6.5 → 7 → 7 → 7.5 → 7.0 → 6.5），这条线的合理定位已经清楚：

- **能当**：几何与可达性 CI 门禁（越界/栅格/热区/空态/主次失衡/导出预算），且"绿"必须经得起攻击测试
- **不能当**：设计评审签字——L1 是底线，不证明"设计成立"

试用者原话：「这块绿只能证明页面有标题、没有裸露的 20px 按钮」。这句话我接受，并写进 `design-tools-trial-report.md` 的结论。

## 第二十七轮：堵住"检查蒸发"与 alpha/opacity/软连字符（6.0/10 后）

试用者第二轮攻击又找到 5 条，其中一条比之前所有问题都严重：**检查会从结果里静默消失**。

### 1. 缺失检查 = 假通过 → 现在的处理

原来可见块 <3 时 `visualHierarchy` 返回 null，`visual-hierarchy` **根本不进 checks**：不报 skipped、不进分母，`passed === counted` 依然成立。输出里看不出层级从未被评估。

修复：
- 新增 `CHECK_MANIFEST`（11 条固定清单），清单里有而 checks 里没有的，一律补成 **显式 `notAssessable` 的红项**
- `visual-hierarchy`：块不足时 `ok:false, notAssessable:true`，写明"可见内容块不足 3 个"
- `type-scale`：正文不足 2 级时同样判红，不再"无法评估 = 通过"
- `l1` 增加 `expected / counted / notAssessed / missingChecks`，分母可对账

### 2. 幽灵判定改成有效不透明度

`fill:"#FFFFFF01"`（alpha 1/255）和 `opacity:0` 的实心块原来都算"绘制过"。

修复：`effectiveAlpha = fill.a × opacity`，**< 0.02 一律不算绘制**。

### 3. `realText/realSrc` 剥掉全部 Cf 类

原来只列了 `200b–200f / 2060 / feff`，软连字符 `U+00AD` 直接漏过。

修复：用 `\p{Cf}` 覆盖所有不可见格式字符，外加 NBSP / 全角空格。

### 4. 对比度转 blocking

`#F7F8F9 on #FFF`（1.0:1）原来只出 warning 就判 `meets-l1-bar`。现在有可判断样本时进入 L1；拿不到底色的样本标 `skipped` 而不是假通过。

### 5. fix_plan 的 addNode 坐标/父容器

原来 `addNode` 挂到 page root，被流式布局重排到 y=816 越界。现在挂到列表的父容器，坐标用 `relY + h + 16`。被拒理由也从"变多"改成实际差异：`换了一条：修掉 empty-state，却新增 containment`。

### 回归

`test:studio-anti-gaming` 之外，`metrics / anchors / explore` 的 fixtures 因为检查变严而调整（补齐正文层级、对比度、第三块内容），锚点测试改用 `approve`（人工认可低于 bar 的页面，正是这个动作的用途）。
`npm test 17/17`、studio 全套通过。

## 第二十八轮：last 三条通路（7.0/10 后，最终复验提出的三件事）

试用者说得很干脆：补完这三条就给 8.5。逐条：

### 1. 不可见文字冒充主视觉（致命）

`visibleNode` 对文字只看 `realText`，不看 opacity 与 color alpha —— 一个 `color:"#00000000"` 的 48px 大字能把页面从红刷成绿（dominant=幽灵、ratio 5.83×）。

修复：`visibleText = colorAlpha(color) × opacity × scale(transform)`，`< 0.02` 不算。另外 `parseColor` 对 alpha=0 返回 null（"没画"），而文字透明是"有字但看不见"，语义不同 → 新增 `colorAlpha()` 单独解析 8 位 hex / rgba。

### 2. 底色不可知 = 放行（致命）

白字压照片：`contrast` 被标 `skipped`，既不进 `notAssess` 也不进 `blocking`，判词 `meets-l1-bar`。`11 ≠ 10 + 0`——只有 skipped 能补平账。

修复：
- 文字压在图片/渐变上 → `unknown` 计数，**判红**并说明"N 处文字压在图片/渐变上，无法确认对比度"
- 对比度不可评估不再带 `skipped`，一律 `notAssessable` 红项
- 分母恒等式 `counted + skipped === expected` 成立

### 3. 不可评估分支塌成 1 条

"只有一行字"的页面走 early-return，`checks` 从 11 塌成 1，`l1` 没有 `expected/counted/notAssessed`。

修复：early-return 也输出完整 11 条清单（10 条 `notAssessable`），`l1` 带上 `expected=11 / counted=11 / notAssessed=10 / blocking=11`。

### 附带两处

- `content-presence` 改判据为 `visibleText`（软连字符不再算"页面有内容"）
- 修复计划：补空态时**沿用页面已有正文字号**，否则会顺手引入 `type-scale` 阻塞；新增**组合重试**——单条试跑都不转正、但一起提交能转正的命令（两个列表各补一条空态），现在会整组保留并注明原因

### 回归

`test:studio-anti-gaming` 扩到 13 组：新增"early-return 清单不塌陷"、"透明文字不进主次比"、"对比度不得以 skipped 放行"。
`npm test 17/17`、studio 全套通过。

## 第二十九轮：`unknown` 被静默丢弃（7.5/10 后）

试用者一句话点中要害：**「skipped 通道关了，换成静默丢弃继续放行」**。

### 根因

`contrastReport` 里 `if (!bgInfo.resolved) continue;` —— 图片/渐变底返回 `unknown:true`，却被这句直接丢掉，`unknown` 从未累加，我写的 918–930 分支是**死代码**。

后果：白字压图，单独存在时红；旁边加一条普通文字就变绿（checked 3→2），整页 `meets-l1-bar`，`l1.skipped=[]`，恒等式还成立。**账面平了，语义没修。**

### 修复

- `unknown` 正确累加：底色不可解析 → 计入 `unknown` 并判红，detail 写「N 处文字压在图片/渐变上，无法确认对比度」
- 不可见文字（`visibleText` 为假）不再进入对比度采样——否则 `opacity:0` 的白字会把绿页误判红
- `typeScale` 的字号阶梯只统计可见文字
- `containment`：透明的**叶子**图层跳过（避免残留图层让 CI 随机变红），但**透明容器仍参与**——它占布局，越界必须报

实测：白字作为图片子节点 → `unknown: 1`、`1 处文字压在图片/渐变上`、`below-l1-bar`。

### 反例复核

试用者指出的 B4 首测变红是它自己把方块放到 y=660 越界，不是 alpha 回退——已确认。这轮修 `containment` 时正好同源：不能一刀切跳过不可见节点。

### 回归

`test:studio-anti-gaming` 第 13 组改为「白字压图必须判红 + unknown ≥ 1」。
`npm test 17/17`、studio 全套通过。

## 第三十轮：红要能点开、误伤要排、门禁要接线（8.0/10 后）

试用者给 8.0，并列出四件事。全做：

### 1. 分母口径

`contrast` 现在返回 `{checked, total, failing, unknown, unknownNodes[], worst[]}`：
- `total = checked + unknown`，只读 `checked` 不会再复现"静默丢弃"
- `skippedUnknownBackground` 改为按实际计算（不再恒 `true`）

### 2. 红能点开

- `contrast.unknownNodes: ["wh"]` —— 到底哪一处
- `design-review` 新增 `W_CONTRAST_LOW`（带 `nodeId` 与比值）与 `W_CONTRAST_UNKNOWN`（带 `nodeId`）
- `fix_plan.unfixable` 对 contrast 直接点名：`对比度不足/不可判断的节点：wh——需要换底色、加遮罩或改字色`

### 3. 两类误伤

- **重叠面积阈值**：文字只压到图片边缘 10px 不算"压在图上"，要求覆盖文字面积 ≥30%
- **media 侧跳过不可见**：`opacity:0` 的图片不再被当成"底不可知"（`visibleNode` 同步到 media 判定）

### 4. 门禁接线

- `npm test` 现在聚合 5 个 studio 套件（metrics / anti-gaming / consistency / fix-plan / content），总数 17 → **18**
- `JS 解析检查` 的目录列表加入 `studio/`，不然这些文件根本不在检查范围里

### 遗留（需要用户决策）

`git ls-files studio` 仍为 0 —— 整个 `studio/` 是 untracked。CI 即便配置了 `npm test`，checkout 也拿不到这些代码。**是否把 `studio/` 纳入版本库，属于仓库策略决定，不是我能单方面做的**；已记录在此，等你定。

### 回归

`npm test 18/18`；studio 五个套件全过。

## 第三十一轮：假红比假绿更伤信任（7.0/10 后）

试用者的判词比分数更重：

> unknown 是"我不知道"，1.1:1 是"我算过了，你错了"——后者用两次就让人无视所有红点。

### 根因

`overlappingBackdrop` 里一句 `if (other.type === 'image') return null;` ——**页面上任何一张图都会让整条同层底色解析整体放弃**。于是"深色底条上的白字"退化成"白底白字"，报出精确的 `1.1:1`，还附一条"换底色"的处方。旁边角落一张无关装饰图就能触发。

### 修复：重写 `resolveBackground`

按绘制顺序找"压在文字下面、且真的盖住它"的最近一层：

1. 自身填充（按钮/标签块）
2. 覆盖 ≥30% 面积、`renderOrder` 更小的最近一层：
   - 是可解析的实色（a ≥ 0.6）→ 用它
   - 是图片/渐变 → 若其上有 ≥80% 覆盖、a ≥ 0.5 的遮罩（hero 常用 scrim）→ 用遮罩色
   - 否则 → `unknown`
3. 父链上的实色；最后才是画布默认白底

另外：`visibleNode` 对图片也乘 `opacity`——`opacity:0` 的图不再参与底色判定。

### 实测

```
深色条内白字（页面另有远处装饰图） → 9.41:1，不误判
白卡 + opacity:0 图盖满 + 黑字     → 9.41:1，unknown 0
```

### 回归

`test:studio-anti-gaming` 新增第 14 组「不该红的别红」：远处装饰图不影响同层底色、不可见图片不污染底色。
`npm test 18/18`。

### 一条原则

前 30 轮都在防"假绿"，这轮补上另一半：**假红同样是失真**。一个会凭空写出精确数字的门禁，比一个承认"我不知道"的门禁更不可信。
