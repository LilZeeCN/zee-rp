# 缺口队列(figcraft docs/gaps.md 模式)

按行为分级记录**当前真实缺口**,供人类与 agent 认领。规则(对齐 figcraft house rules):

- **按行为分级,不按菜单存在分级**;"未验证"不等于"不存在",反之亦然。
- **宁低勿高**:每条只声明已验证的部分;一条被反例推翻就降级或关闭,不恢复。
- 认领一个缺口 = 在分支上修复 + 门禁全绿 + 本文件更新状态;新缺口在验证中随时追加。
- 排序即优先级;顶部最先做。

## 队列

| # | 缺口(行为级) | 验收口径 | 来源 | 状态 |
|---|---|---|---|---|
| 1 | **真实模型在新 13 工具面上的试用未收口**:T01 `complete-three` 第 4 步曾停在 `meticulous`(旧 28 工具面,自评 3/10);工具面收敛后须重跑。`toolSchemaSha256` 已变,历史 result 不可比 | 新面上 T01 全流程 `completed` 且作者自评 ≥7/10;T02 至少跑完并分级 | PROJECT-STATUS 2026-11-02 收口 | **open**(本批改面后的首选) |
| 2 | **scripted 基线链与 validate 脱节**:`run-trials.mjs` 从不产出 validate.py 现要求的 `structure`/`actor-evidence` 等 artifact id,冻结的 10-30 scripted run 用当前 validate 同样被拒(1c900df 起) | run-trials --out 全绿通过 validate;或 validate 为 scripted-regression 分支单列验收 schema | 2026-11-08 验证时发现(冻结 repeat-2 同被拒,与本轮改动无关) | **open** |
| 3 | **T02 未跑完**(旧面),只作视觉样本不计通过 | 新面上 T02 跑完并按 scenario 分级 | 2026-11-02 收口 | **open** |
| 4 | **纯文本元件旋转在 RP9 预览发布不渲染**(.rp 持久化、编辑器保留)——平台行为 | Axure 平台若开放能力位则接入;否则保持声明边界 | 2026-11-02 逆向 | **won't-fix(平台边界)** |
| 5 | **web/src 模块间函数提升环**(单文件拆分来源):渲染/手势/Inspector 相互引用 | 纳入 test:layers 无环要求;行为由像素夹具守护 | 2026-11-08 架构重构 | **open(渲染层重构时一并处理)** |
| 6 | **RP/1 编译链巨石**:`scripts/proto.py` 8438 行 + `rp_language.py` 8125 行 | 按域拆分,语言 51 门禁 + 全示例 IR/hash 不变为安全网 | 2026-11-08 架构盘点 | **open(下一场大仗)** |
| 7 | **测试双轨**:61 个自写 runner vs 43 个 node --test | 统一 node --test,脚本式仅保留有特殊进程语义的 | 2026-11-08 工程盘点 | **open** |
| 8 | **扫荡门禁发现的存量候选**:`computeCommandImpactAndDiff` 在事务 catch 之外(提交段抛错会穿透为 E_INTERNAL_ERROR 而非命令信封) | 挪进 try 或单独兜底;由 sweep 扩展用例固化 | 2026-11-08 M-SWEEP | **open(小)** |
| 9 | 素材出处台账(ATTRIBUTION 模式)+ assets 校验进 CI | assets/ 每文件一行来源与许可,CI 校验 | figcraft 借鉴盘点 | **open(小)** |

## 已关闭(近期)

- ~~28 个 MCP 工具面混乱~~ → 2026-11-08 收敛为 13 个(本文件建立的同轮)。
- ~~命令注册表无一致性门禁~~ → `test:studio-parity`;~~分层无强制~~ → `test:layers`(2026-11-08)。
- ~~原型污染面(setTokens/setVariable/datasetOp/createComponent/upsert-component 用户可控键)~~ → defineRecordEntry 防御 + M-SWEEP 固化(2026-11-08)。
