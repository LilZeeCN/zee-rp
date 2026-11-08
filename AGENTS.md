# zee-rp 仓库协作规则(面向人类与 AI 贡献者)

给 AI 一张自由画布,把设计带回 Axure。本仓库是 npm 包 `zee-rp` 与同名 MCP 服务,
也公开于 GitHub `LilZeeCN/zee-rp`。本文件是修改本仓库前必读的工程约定。

## 开工先读

**[docs/gaps.md](docs/gaps.md) 是当前真实缺口的活队列**(行为分级、宁低勿高)。
无任务指派时从队列顶部认领;验证中发现新缺口随时追加;完成后更新状态。

## 核心纪律

- **Check, then claim.** 动手前先搜:命令注册表(`studio/commands/taxonomy.mjs`)、
  契约表(`studio/command-contracts.mjs`)、能力边界(`references/capabilities.md`,
  位于消费方 skill 目录)里是否已有对应事实。
- **Verify, don't guess.** 行为断言必须有门禁或截图证据支撑;区分"代码已构造、
  结构正确、浏览器加载、预览行为"四个层级,不在低层级证据上声明高层级结论。
- **一个提交一件事。** 重构批次独立成 commit,提交前跑门禁(见下),全绿才进。
- **绝不假装通过。** 缺前置条件的检查标 missing/skipped,不伪装成 pass;
  不为掩盖失败重写语义快照;保留原始失败回归(`test/studio-trial-regressions-check.mjs`
  与 `test/studio-audit-repairs-check.mjs`)。
- **不 commit 官方模板/二进制/字体/私截图**(见 `.gitignore` 与 CONTRIBUTING.md)。

## 一切皆命令(figcraft 式命令注册表)

画布的每一个用户可见行为都是一条命令,单一注册表在 `studio/commands/taxonomy.mjs`
(`COMMAND_TYPES_BY_GROUP` / `VALID_COMMAND_TYPES`),字段契约在
`studio/command-contracts.mjs`,dispatch 函数表在 `studio/commands/apply.mjs`
(`COMMAND_HANDLERS`)。**新增命令的步骤**:

1. 在 `taxonomy.mjs` 的分组表登记(含别名);
2. 在 `studio/commands/cases/<域>.mjs` 实现处理器并挂入函数表;
3. 在 `command-contracts.mjs` 补字段契约;
4. 跑 `npm run test:studio-parity` —— 四方(分组表 ↔ 全集 ↔ dispatch ↔ 契约)
   不一致会当场红;同步更新 docs 里面向 agent 的命令文档。

程序化调用不得弹窗、不得依赖 UI 状态;错误统一走 `cmdError`(E_ 前缀错误码 +
commandIndex + suggestion),让 agent 能读错误自行纠正。

## 分层(由 `npm run test:layers` 强制)

```
L0/L1/L2 核心(geom/doc/layout/语义,tools/check-layers.mjs 的 CORE 名单)
  ↑ 只允许被上层引用,不得反向 import 命令层/服务层/特性层
L4 命令层  studio/commands/**(taxonomy 注册表 + cases 处理器 + document-store 事务)
L5 存储会话 persistence / versions / operations / document-merge / sync-native / export-*
L6 服务接口 server.mjs(+server-capture)/ mcp-adapter / cli / operation-worker
浏览器侧  studio/web/src/**(不得 import node: 内建;window.__STUDIO_* 为截图契约,不可改名)
```

- 静态 import 图保持无环;经动态 import 的 3 组 server↔特性延迟环是已知白名单
  (operations / candidate-explorations / scenarios),新增动态环要在本文件登记。
- web/src 由单文件拆分而来,模块间存在函数提升环,行为由像素夹具与浏览器门禁验证;
  把 web 纳入无环要求属于渲染层重构议题,不在本门禁范围。
- `scripts/mcp-tools.mjs` 对 studio 的引用面冻结在 `mcp-adapter.mjs` 与
  `schema-validation.mjs` 两个入口(外部消费方兼容约束)。

## 门禁

CI(`.github/workflows/test.yml`,Node 18+22 矩阵)跑:`npm test`、`test:styles`、
`test:sync`、`test:studio-ai`、`test:studio-parity`、`test:studio-editing`、
`test:studio-finish`、`test:studio-baselines`、`rp-source-contract-check.py`。

本地常用:`npm test`(核心回归 18)、`npm run test:studio-editing`(浏览器交互 27)、
`npm run test:studio-ai`(AI 创作链 152)、`npm run test:studio-repairs`(审计修复 18)、
`npm run test:studio-parity`(命令注册表一致)、`npm run test:layers`(分层)、
`npm run test:source-contract`(发布指纹)。

浏览器型测试需要 Chrome(`CHROME_BIN`)且必须 `--test-concurrency=1` 串行。

## 改动后的同步义务

- 改 `studio/**` 后:受影响门禁全绿;`test:source-contract` 失败说明指纹过期,
  走 pack-release 正常流程刷新,**不得手改指纹掩盖失败**。
- 能力边界变化(新命令、新出口、新限制):同步 `references/capabilities.md`
  (在消费方 skill 目录)与 docs/ 对应文档;PROJECT-STATUS 记录在研究仓
  `/Users/lilzee/axure-exp` 维护。
- 前端文件改名/移动:同步 `benchmarks/studio/verify-evidence.mjs` 的 runtime
  绑定清单与 `test/studio-scale-performance-check.mjs` 的 paths,否则性能证据
  门禁按过期绑定拒绝。
