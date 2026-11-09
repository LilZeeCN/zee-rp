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
| 3 | **T02 未跑完**(旧面),只作视觉样本不计通过 | 新面上 T02 跑完并按 scenario 分级 | 2026-11-02 收口 | **open** |
| 4 | **纯文本元件旋转在 RP9 预览发布不渲染**(.rp 持久化、编辑器保留)——平台行为 | Axure 平台若开放能力位则接入;否则保持声明边界 | 2026-11-02 逆向 | **won't-fix(平台边界)** |
| 5 | **web/src 模块间函数提升环**(单文件拆分来源):渲染/手势/Inspector 相互引用 | 纳入 test:layers 无环要求;行为由像素夹具守护 | 2026-11-08 架构重构 | **open(渲染层重构时一并处理)** |
| 6 | ~~RP/1 编译链巨石~~ | 语言 51 + runtime/backend/sync/npm-test 等 12 门禁全绿 | 2026-11-08 架构盘点 | **closed(同日)**:proto.py→`scripts/proto_engine/` 七模块(fonts/tokens/expander/layout/audit/builder/compiler,依赖矩阵严格单向零环),rp_language.py→`scripts/rplang/` 四模块(core/frontend/runtime/tail;pointer 三工具挪 core 断 frontend↔tail 环,compile_language 归 frontend);两 facade 保持 `import proto`/`from rp_language import X`/`python3 scripts/proto.py` 消费面逐名不变 |
| 7 | **测试双轨**:61 个自写 runner vs 43 个 node --test。triage(2026-11-08):45 个 check() 型可机械转 node:test;16 个特殊形态(authoring-benchmark 等带 CLI 参数的独立基准、MCP stdio 客户端流)**不可盲转**,逐个评估 | 分批转换:每批 ≤10 文件,转换前后该文件门禁结论一致;特殊形态保留并在文件头注明理由 | 2026-11-08 工程盘点 | **open(下一批,机械但量大)** |
| 8 | **扫荡门禁发现的存量候选**:`computeCommandImpactAndDiff` 在事务 catch 之外(提交段抛错会穿透为 E_INTERNAL_ERROR 而非命令信封) | 挪进 try 或单独兜底;由 sweep 扩展用例固化 | 2026-11-08 M-SWEEP | **open(小)** |
| 9 | ~~素材出处台账~~ | assets/ 每文件一行来源与许可,CI 校验 | figcraft 借鉴盘点 | **closed(2026-11-08)**:ATTRIBUTION.md + test:attribution 进 CI |
| 10 | `E_STACK_CHILDREN_UNPLACED` 是 error 级诊断却出现在 `ok:true` 回包里,作者易把带错回包当成功 | stack 容器缺 x/y 子节点的命令批应拒写(E_ 信封)或诊断置顶强提示 | 2026-11-08 T01 子代理试用 friction | **open(小)** |
| 11 | `editNodes` 改 visible 的回包标签「已写入但无视觉效果(已忽略属性)」误导——值实际已生效 | 回包文案改为如实描述(值已写入且生效) | 2026-11-08 T01 子代理试用 friction | **open(小)** |
| 12 | 本机 MCP 服务进程陈旧检测:studio_open_project 复用旧实例时,旧代码静态路由缺 /src/ 导致渲染 404,作者侧难自查 | open_project 回包带 sourceFingerprint 与 runtime_info 同款新旧对照提示 | 2026-11-08 T01 子代理试用 friction(根因=进程陈旧,非代码缺陷) | **open(中)** |
| 13 | **布尔组操作数可编辑**(figcraft: 布尔结果跟随操作数拖动实时更新):需在 scene-resolver(唯一几何权威)内嵌 `booleanVectorPaths` 重算——架构级改动,设计已定:容器 `booleanOp: "union"|"subtract"|...` + path 子节点,resolver 渲染时算布尔、操作数保持可编辑 | 加 scene-resolver 布尔检测+重算;门禁 studio-layout + 矢量门禁守护 | figcraft parity D | **open(架构级,设计已定)** |

## 已关闭(近期)

- ~~28 个 MCP 工具面混乱~~ → 2026-11-08 收敛为 13 个(本文件建立的同轮)。
- ~~命令注册表无一致性门禁~~ → `test:studio-parity`;~~分层无强制~~ → `test:layers`(2026-11-08)。
- ~~原型污染面(setTokens/setVariable/datasetOp/createComponent/upsert-component 用户可控键)~~ → defineRecordEntry 防御 + M-SWEEP 固化(2026-11-08)。
