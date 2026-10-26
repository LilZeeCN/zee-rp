# 交付清单（zee-axure Studio / RP-1 设计质量层）

> 本文件是这条线的交付索引：做了什么、怎么验证、怎么回退、边界在哪。

## 一、交付物

| 类别 | 文件 | 说明 |
|---|---|---|
| 能力边界 | `docs/free-canvas-design-ceiling.md` | 五层能力模型（L1 指标 / 反 slop / 锚点 / 探索 / 导出预算）+ 明确的"不做什么" |
| 试用报告 | `docs/design-tools-trial-report.md` | 14 轮外部试用分数轨迹与判词 |
| 缺陷台账 | `docs/agent-trial-findings-2026-10-27.md` | 30 轮逐条记录：问题、根因、修法、回归 |
| 度量层 | `studio/design-metrics.mjs` | 11 项固定清单、固定分母对账、有效不透明度、Cf 归一 |
| 探索层 | `studio/explore.mjs` | 参数轴 + 结构轴、连续目标、硬回归淘汰 |
| 锚点层 | `studio/anchors.mjs` | 配方提炼、参照系对比、方向建议 |
| 修复计划 | `studio/fix-plan.mjs` | 确定性处方 + 服务端试跑自证 |
| 内容脚手架 | `studio/content-plan.mjs` | 空态/口号标题的槽位与模板 |
| 回归 | `test/studio-*.mjs`（5 套件）+ `test/rp1-*.mjs` | 含 `anti-gaming` 13 组攻击面断言 |

## 二、怎么验证

```bash
cd ~/.zcode/skills/zee-axure
npm test                      # 18 条，含 5 个 studio 套件
npm run test:studio-anti-gaming   # 13 组"刷绿"攻击面
npm run test:studio-metrics       # 度量口径与关系约束
npm run test:studio-fix-plan      # 处方自证
npm run test:studio-content       # 内容脚手架
npm run test:studio-consistency   # 三工具一致性
```

## 三、定位（外部试用者给的原话）

> 按「设计期的对抗性体检 + 几何/可达性门禁」交付，别按「可挂 CI 的验收门」交付。

**能当**：几何门禁（越界 / 栅格 / 热区）、可达性门禁（空态覆盖 / 对比度）、对抗性体检（能防止用元数据刷绿）。

**不能当**：设计评审签字。L1 是底线，不证明"设计成立"。文案质量、信息架构、素材选择不在能力范围内。

## 四、关键设计原则（写进代码的）

1. **不可评估 = 不通过**。缺项显式 `notAssessable` 红项，不允许从 `checks` 里蒸发；`expected / counted / notAssessable` 必须对账。
2. **绿必须经得起攻击**。`test:studio-anti-gaming` 覆盖 13 条已知伪造路径（零宽字符、软连字符、alpha 1/255、opacity:0、透明文字、wrapper 拆分、检查蒸发、对比度跳过等）。
3. **处方必须自证**。`fix_plan` 在文档副本上试跑自己的命令，整页阻塞项不严格减少就不下发，并给出 `unfixable` 原因。
4. **红必须点得开**。每条失败都带 nodeId 与比值；`contrast.unknownNodes` 不再是"N 处"。
5. **不假装**。导出预算与真实导出可能不一致时标 `uncertain`；内容脚手架只给槽位，不假装会写文案。

## 五、回退

- 快照：`~/Downloads/test_1/_backup/zee-axure-rsi-r30…r32-*`（每轮一份，共 30+）
- 原始备份与 tag：`rsi-backup-20261027-010431`
- 回退命令：
  ```bash
  rm -rf ~/.zcode/skills/zee-axure
  cp -a <某个快照> ~/.zcode/skills/zee-axure
  ```

## 六、已知遗留

1. **`studio/` 未纳入 git**（`git ls-files studio` 为 0）。CI 即便配置 `npm test` 也拿不到这些代码——需要仓库策略决定，未擅自 `git add`。
2. **type-scale 的多数问题修不动**：只能调整最大正文那一级，真实阶梯问题属内容层级。
3. **`hero-without-media` 仍是 warn**：它需要判断"该不该有图"，属设计意图。
4. **渲染层未实现命中区**：`hitW/hitH` 会被度量忽略（宁可红着，不假绿），`fix_plan` 把它列为人工项。

## 七、版本库状态（已入库）

分支 `studio-design-quality`，提交 `6b3cd33`：

- `studio/` 33 个文件（此前 `git ls-files studio` 为 0，CI 看不到被测代码）
- `test/studio-*.mjs` 12 个套件 + `test/rp1-repeater-where-check.mjs`
- `docs/`：能力边界、试用报告、缺陷台账、交付索引
- `package.json`：studio 相关脚本（同时带上了此前未提交的脚本条目）

提交后 `npm test` 仍 18/18。**工作区里剩下的 96 个改动属于你之前的未提交工作，未触碰。**

合并回 main：`git checkout main && git merge studio-design-quality`。
