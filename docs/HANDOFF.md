# 交接文档：zee-axure 设计质量层（Studio / RP-1）

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
