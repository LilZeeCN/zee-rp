# 缺口队列(figcraft docs/gaps.md 模式)

按行为分级记录**当前真实缺口**,供人类与 agent 认领。规则(对齐 figcraft house rules):

- **按行为分级,不按菜单存在分级**;"未验证"不等于"不存在",反之亦然。
- **宁低勿高**:每条只声明已验证的部分;一条被反例推翻就降级或关闭,不恢复。
- 认领一个缺口 = 在分支上修复 + 门禁全绿 + 本文件更新状态;新缺口在验证中随时追加。
- 排序即优先级;顶部最先做。

## 队列

| # | 缺口(行为级) | 验收口径 | 来源 | 状态 |
|---|---|---|---|---|
| 1 | **新 13 工具面作者试用已完成,独立外部模型盲测仍缺**:T01 子代理作者试用全过(2 场景 12/12 断言,27 调用,ease 7/10;outputs/agent-surface-t01-retry-20261108/)——但经旧名兼容层执行(本机 MCP 进程未重启,新名对客户端不可见,#12);`toolSchemaSha256` 已变,历史 result 不可比 | 外部独立模型在新面上 T01 全流程 `completed` 且自评 ≥7/10(需用户准备模型凭据;用户明确暂不烧外部模型) | PROJECT-STATUS 2026-11-02 收口;2026-11-08 子代理试用 | **partial**:面可用性已验,独立盲测待用户准备 |
| 2 | ~~scripted 基线链与 validate 脱节~~ | run-trials --out 全绿通过 validate | 2026-11-08 | **closed**:脚本结果的四层证据须通过并引用运行目录内的对应产物类型。真实模型验收仍走原有规则。`test:scripted-validate` 校验此契约，有 RP9 模板时也执行 T01 端到端。 |
| 3 | T02 上一轮旧工具面未完成 | 公开工具面从空工程写入 RP/1，再跑语义与真实浏览器指针断言 | 2026-11-02 收口 | **closed（脚本）**。新 stdio 已完成结构与交互复验。独立作者试用仍归 #1。 |
| 4 | **纯文本元件旋转在 RP9 预览发布不渲染**(.rp 持久化、编辑器保留)——平台行为 | Axure 平台若开放能力位则接入;否则保持声明边界 | 2026-11-02 逆向 | **won't-fix(平台边界)** |
| 5 | ~~web/src 模块间循环依赖~~ | 纳入 test:layers 无环要求，保持画布行为 | 2026-11-08 架构重构 | **closed(2026-11-09)**：14 个前端模块无环，main 装配请求、快照与界面动作，门禁覆盖静态及字面量动态导入。 |
| 6 | ~~RP/1 编译链巨石~~ | 语言 51 + runtime/backend/sync/npm-test 等 12 门禁全绿 | 2026-11-08 架构盘点 | **closed(同日)**:proto.py→`scripts/proto_engine/` 七模块(fonts/tokens/expander/layout/audit/builder/compiler,依赖矩阵严格单向零环),rp_language.py→`scripts/rplang/` 四模块(core/frontend/runtime/tail;pointer 三工具挪 core 断 frontend↔tail 环,compile_language 归 frontend);两 facade 保持 `import proto`/`from rp_language import X`/`python3 scripts/proto.py` 消费面逐名不变 |
| 7 | **测试双轨**:61 个自写 runner vs 43 个 node --test。triage(2026-11-08):45 个 check() 型可机械转 node:test;16 个特殊形态(authoring-benchmark 等带 CLI 参数的独立基准、MCP stdio 客户端流)**不可盲转**,逐个评估 | 分批转换:每批 ≤10 文件,转换前后该文件门禁结论一致;特殊形态保留并在文件头注明理由 | 2026-11-08 工程盘点 | **open(下一批,机械但量大)** |
| 8 | 事务提交前的影响计算异常穿透 | 异常返回命令信封，文档与最近场景仍指向同一已提交版本 | 2026-11-08 M-SWEEP | **closed**。影响计算成功后才更新文档与场景缓存。 |
| 9 | ~~素材出处台账~~ | assets/ 每文件一行来源与许可,CI 校验 | figcraft 借鉴盘点 | **closed(2026-11-08)**:ATTRIBUTION.md + test:attribution 进 CI |
| 10 | 省略 stack 子节点坐标导致重叠时，成功事务报 error | 置顶提醒，区分共用默认起点与正常分离的位置 | 2026-11-08 T01 作者试用 | **closed**。成功回包置顶 `W_STACK_CHILDREN_UNPLACED`，摘要说明如何处理。 |
| 11 | `editNodes` 切换 visible 后，回包误称属性被忽略 | 语义差异反映实际显隐变化 | 2026-11-08 T01 作者试用 | **closed**。`styleChanges` 报告 `visible` 的前后值。 |
| 12 | 复用旧 Studio 进程时，调用方无法判断前端与运行代码的版本 | `studio_open_project` 返回当前服务与磁盘的指纹对照 | 2026-11-08 T01 作者试用 | **closed**。缺少指纹的旧服务也提示重启。仅传 `projectDir` 时只会连接对应项目。 |
| 13 | **布尔组操作数可编辑**(figcraft: 布尔结果跟随操作数拖动实时更新):需在 scene-resolver(唯一几何权威)内嵌 `booleanVectorPaths` 重算——架构级改动,设计已定:容器 `booleanOp: "union"|"subtract"|...` + path 子节点,resolver 渲染时算布尔、操作数保持可编辑 | 加 scene-resolver 布尔检测+重算;门禁 studio-layout + 矢量门禁守护 | figcraft parity D | **open(架构级,设计已定)** |
| 14 | 普通编辑及撤销重做在 WAL 写入失败后仍推进内存版本，重试可能误报成功 | 日志落盘前保持文档和历史不变，落盘后辅助保存失败时重开恢复同一内容 | 2026-11-10 FigCraft 对照复现 | **closed**。HTTP 故障回归覆盖编辑、撤销、重做、同键重试及缺少恢复快照。 |
| 15 | Studio 语义运行与离线 HTML 对同一表达式产生不同结果 | 用同一场景校验两条出口的变量、条件和文字更新 | 2026-11-10 FigCraft 对照复现，`concat()` 被 HTML 当作文字 | **closed**。Chrome 实点 Studio，再用移目录后直接打开的 HTML 跑同一场景，核对 8 个断言及条件轨迹，覆盖数值类型、引号字面量、面板局部重名、分支顺序和显隐。 |
| 16 | 单点改字和移动走整文档复制，浏览器增量包用影响摘要推测变化 | 固定种子混合编辑和撤销重做，对照全量解算。浏览器增量更新后核对源文档、场景和画布 | 2026-11-10 FigCraft 对照 | **closed**。单条 `setText` 和自由布局中的普通 `moveNode` 复制实际修改路径，增量包比较解算节点并同步源节点。 |

## 已关闭(近期)

- ~~28 个 MCP 工具面混乱~~ → 2026-11-08 收敛为 13 个(本文件建立的同轮)。
- ~~命令注册表无一致性门禁~~ → `test:studio-parity`;~~分层无强制~~ → `test:layers`(2026-11-08)。
- ~~原型污染面(setTokens/setVariable/datasetOp/createComponent/upsert-component 用户可控键)~~ → defineRecordEntry 防御 + M-SWEEP 固化(2026-11-08)。
