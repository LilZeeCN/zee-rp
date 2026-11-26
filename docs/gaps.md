# 缺口队列(figcraft docs/gaps.md 模式)

按行为分级记录**当前真实缺口**,供人类与 agent 认领。规则(对齐 figcraft house rules):

- **按行为分级,不按菜单存在分级**;"未验证"不等于"不存在",反之亦然。
- **宁低勿高**:每条只声明已验证的部分;一条被反例推翻就降级或关闭,不恢复。
- 认领一个缺口 = 在分支上修复 + 门禁全绿 + 本文件更新状态;新缺口在验证中随时追加。
- 排序即优先级;顶部最先做。

## 队列

| # | 缺口(行为级) | 验收口径 | 来源 | 状态 |
|---|---|---|---|---|
| 1 | ~~新 13 工具面缺少独立外部模型盲测~~ | 外部独立模型（`readImplementation: false`）在公开 MCP 工具面上完成 T01 全流程 `completed`，L1 0 阻塞，场景全绿并导出原生 `.rp` | PROJECT-STATUS 2026-11-02 收口；2026-11-26 三家外部模型冷启动盲测实录 | **closed（2026-11-26）**：GPT-6（33 调用, ease 6/10）、GLM-5.4（41 调用, ease 5/10）、Claude Sonnet/dsh（41 调用, ease 6/10）三家独立外部模型在 `readImplementation: false` 下 **3/3 `completed`**（场景全通过、L1 0 阻塞、原生 RP9 三零通过，详见证据归档 `docs/blind-test-t01-20261126.md`）；针对实录中共识摩擦点（`expect.text` `{contains}` 与报错提示、`explore.states` 单传与 6 态上限、`addNode` `column/row` 别名、单 `else` 展平、402 满屏栅格与流式 `fix_plan`、错误引导与常用字段速查）已全部修复并回归锁定。 |
| 2 | ~~scripted 基线链与 validate 脱节~~ | run-trials --out 全绿通过 validate | 2026-11-08 | **closed**:脚本结果的四层证据须通过并引用运行目录内的对应产物类型。真实模型验收仍走原有规则。`test:scripted-validate` 校验此契约，有 RP9 模板时也执行 T01 端到端。 |
| 3 | T02 上一轮旧工具面未完成 | 公开工具面从空工程写入 RP/1，再跑语义与真实浏览器指针断言 | 2026-11-02 收口 | **closed（脚本）**。新 stdio 已完成结构与交互复验。独立作者试用仍归 #1。 |
| 4 | **纯文本元件旋转在 RP9 预览发布不渲染**(.rp 持久化、编辑器保留)——平台行为 | Axure 平台若开放能力位则接入;否则保持声明边界 | 2026-11-02 逆向 | **won't-fix(平台边界)** |
| 5 | ~~web/src 模块间循环依赖~~ | 纳入 test:layers 无环要求，保持画布行为 | 2026-11-08 架构重构 | **closed(2026-11-09)**：14 个前端模块无环，main 装配请求、快照与界面动作，门禁覆盖静态及字面量动态导入。 |
| 6 | ~~RP/1 编译链巨石~~ | 语言 51 + runtime/backend/sync/npm-test 等 12 门禁全绿 | 2026-11-08 架构盘点 | **closed(同日)**:proto.py→`scripts/proto_engine/` 七模块(fonts/tokens/expander/layout/audit/builder/compiler,依赖矩阵严格单向零环),rp_language.py→`scripts/rplang/` 四模块(core/frontend/runtime/tail;pointer 三工具挪 core 断 frontend↔tail 环,compile_language 归 frontend);两 facade 保持 `import proto`/`from rp_language import X`/`python3 scripts/proto.py` 消费面逐名不变 |
| 7 | ~~**测试双轨**~~ | Batch 1–3 共 29 个独立测试迁移至 `node:test`，真实特殊形态运行器在文件头标注理由，并由 `test:studio-parity` 永久守卫 `test/*.mjs` 无未归类脚本 | 2026-11-08 工程盘点 | **closed（2026-11-26）**：Batch 1（10 文件）+ Batch 2（10 文件）+ Batch 3（9 文件：`native-acceptance-check` / `rp-audit-native-check` / `native-visual-check` / `runtime-native-check` / `template-check` / `native-check` / `test-check-semantics-full` / `native-backend-check` / `proto-v21-check`）全部迁入 `node --test`；`regression`、`parity-check`、`authoring-benchmark` 与单会话 MCP stdio 顺序回归显式标注特殊形态理由；[studio-doc-contract-parity-check.mjs](../test/studio-doc-contract-parity-check.mjs) 新增 `测试双轨收口守卫` 锁定零新增未归类旧式 runner。当前开放工程缺口清零（18 已关闭 + 1 平台边界）。 |
| 8 | 事务提交前的影响计算异常穿透 | 异常返回命令信封，文档与最近场景仍指向同一已提交版本 | 2026-11-08 M-SWEEP | **closed**。影响计算成功后才更新文档与场景缓存。 |
| 9 | ~~素材出处台账~~ | assets/ 每文件一行来源与许可,CI 校验 | figcraft 借鉴盘点 | **closed(2026-11-08)**:ATTRIBUTION.md + test:attribution 进 CI |
| 10 | 省略 stack 子节点坐标导致重叠时，成功事务报 error | 置顶提醒，区分共用默认起点与正常分离的位置 | 2026-11-08 T01 作者试用 | **closed**。成功回包置顶 `W_STACK_CHILDREN_UNPLACED`，摘要说明如何处理。 |
| 11 | `editNodes` 切换 visible 后，回包误称属性被忽略 | 语义差异反映实际显隐变化 | 2026-11-08 T01 作者试用 | **closed**。`styleChanges` 报告 `visible` 的前后值。 |
| 12 | 复用旧 Studio 进程时，调用方无法判断前端与运行代码的版本 | `studio_open_project` 返回当前服务与磁盘的指纹对照 | 2026-11-08 T01 作者试用 | **closed**。缺少指纹的旧服务也提示重启。仅传 `projectDir` 时只会连接对应项目。 |
| 13 | 布尔组的结果轮廓随操作数移动和改点更新 | 实际拖动与命中、撤销重做、重开工程、离线 HTML 及 RP9 轮廓读回 | FigCraft parity D | **closed**。两个同容器闭合路径可组成实时布尔组。HTML 保留结果 SVG，RP9 文件将非空轮廓写为 Shape 300 并报告实时关系降级。 |
| 14 | 普通编辑、撤销重做、命名版本恢复、三方合并及原生回填在 WAL 写入失败后仍推进内存版本，重试可能误报成功 | 全部状态变更入口在日志落盘前保持文档和历史不变，落盘后辅助保存失败时返回 `W_CHECKPOINT_PENDING` 且重开恢复同一内容 | 2026-11-10 FigCraft 对照复现；2026-11-12 补齐 `versions.restore` / `studio_merge` / `sync_native` | **closed**。HTTP 与服务层故障回归覆盖编辑、撤销、重做、版本恢复、合并、原生回填、同键重试及缺少恢复快照。 |
| 15 | Studio 语义运行与离线 HTML 对同一表达式产生不同结果 | 用同一场景校验两条出口的变量、条件和文字更新 | 2026-11-10 FigCraft 对照复现，`concat()` 被 HTML 当作文字 | **closed**。Chrome 实点 Studio，再用移目录后直接打开的 HTML 跑同一场景，核对 8 个断言及条件轨迹，覆盖数值类型、引号字面量、面板局部重名、分支顺序和显隐。 |
| 16 | 单点改字和移动走整文档复制，浏览器增量包用影响摘要推测变化 | 固定种子混合编辑和撤销重做，对照全量解算。浏览器增量更新后核对源文档、场景和画布 | 2026-11-10 FigCraft 对照 | **closed**。单条 `setText` 和自由布局中的普通 `moveNode` 复制实际修改路径，增量包比较解算节点并同步源节点。 |

| 17 | 原生文本框输入上限缺少消费契约 | RP9/RP11 桥接的两份对照样本已证实 `MaxLength` 为 `0x05`，且官方播放器按值截断。将同一属性接通 RP/1、Studio、读回和同步，并比较真实键入。 | `docs/native-assembly-research.md` | **closed**。RP/1 作者、参考模拟、读回、官方浏览器及 Studio（运行态截断、`maxlength` HTML 属性、`input` 能力契约、原生 RP9 `TextBox.MaxLength` 三端一致导出）已全线贯通并测试锁定。 |
| 18 | ~~面板定时和原型手势跨出口不一致~~ | RP9 官方播放器、RP/1、Studio 交互预览画布、独立 HTML 导出与 `verify_prototype` 双引擎验证一致 | `docs/native-assembly-research.md` | **closed**：RP/1 创作、参考模拟、原生 `.rp` 双向 `decompile`、RP9 官方 HTML 真实浏览器、`verify_prototype(engine:"studio-html")` 离线 Chrome 真机自验（含 `virtualClock` + `storyboard`），以及 Studio 交互预览画布（`gestures.mjs`/`main.mjs` + `/api/runtime/{drag,swipe,tick}` + 独立 HTML 导出 `ExportRuntimeApp`）拖拽、滑动与轮播定时循环已全线接通并回归覆盖。 |
| 19 | 官方 HTML 缺少日常 MCP 入口 | AI 通过工具发现 RP/1 可运行范例，生成 RP9 并导出官方 HTML。RP9 与 RP11 均用真实浏览器验收，原文件哈希保持一致。 | `references/mcp-prototype.md` | **closed（macOS 已验证构建）**：真实 stdio 与 Playwright 通过。定制 HTML 配置、Windows 程序集调用和独立模型盲测各有独立验收边界。 |

## 已关闭(近期)

- T01 复盘的六项摩擦已补回归。官方首帧与开场断言共用稳定状态，官方 HTML 来源单独报告。RP9 原生文字对齐和运行态裁切定位有真实浏览器对照。命令批量建议与 L1 阻塞、主次归因可从公开工具回包核对。原 T01 官方 HTML 三条剧本并行重放通过，覆盖 184 项检查。
- ~~28 个 MCP 工具面混乱~~ → 2026-11-08 收敛为 13 个(本文件建立的同轮)。
- ~~命令注册表无一致性门禁~~ → `test:studio-parity`;~~分层无强制~~ → `test:layers`(2026-11-08)。
- ~~原型污染面(setTokens/setVariable/datasetOp/createComponent/upsert-component 用户可控键)~~ → defineRecordEntry 防御 + M-SWEEP 固化(2026-11-08)。
