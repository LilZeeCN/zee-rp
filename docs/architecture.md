# zee-rp 架构

本文是自由画布(studio)与 RP/1 编译链的结构地图。工程规则见仓库根 `AGENTS.md`;
分层由 `npm run test:layers` 强制,命令注册表一致性由 `npm run test:studio-parity` 强制。

## 分层总览

```
┌────────────────────────────────────────────────────────────────┐
│ L6 接口层   server.mjs(单端口 HTTP + SSE)                       │
│             server-capture.mjs(CDP 截图/像素测量)               │
│             mcp-adapter.mjs(13 个 studio_* MCP 工具)             │
│             cli.mjs(`zee-rp studio`) · operation-worker.mjs      │
├────────────────────────────────────────────────────────────────┤
│ L5 存储会话  persistence(WAL/崩溃恢复) · versions(命名版本)      │
│             operations(长操作) · document-merge(三方合并)        │
│             sync-native(原生 .rp 回填) · export-rp / export-code  │
│             project-bundle(便携包)                                │
├────────────────────────────────────────────────────────────────┤
│ L4 命令层   studio/commands/                                    │
│             taxonomy.mjs —— 命令注册表(单一事实来源)              │
│             cases/*.mjs —— 55 命令 × 8 域的处理函数表              │
│             apply.mjs —— 前置校验 + COMMAND_HANDLERS 查表分发      │
│             helpers.mjs —— 校验/目标解析/几何辅助                  │
│             document-store.mjs —— 事务/快照/幂等/undo-redo        │
│             runtime.mjs —— 预览运行态(纯函数)                     │
│             commands.mjs —— facade(保持既有 import 面)            │
├────────────────────────────────────────────────────────────────┤
│ L2-L3 特性  scene-resolver(唯一几何解算器) · authoring-query      │
│             impact-diff · document-diff · relation-edit           │
│             explorations · scenarios · design-review/metrics      │
│             design-context · phase-context · content-plan         │
│             fix-plan · anchors · diagnostics · candidate-*        │
├────────────────────────────────────────────────────────────────┤
│ L0-L1 核心  document(权威文档模型/canonicalJson/contentHash)      │
│             node-properties(282 属性契约) · node-capabilities     │
│             component-contracts(6 核心组件) · command-contracts   │
│             visual-style / vector-paths / clipboard / typography  │
│             interactions · pixel-truth · css-raster · cdp         │
│             bounded-cache / schema-validation / png-decode …      │
├────────────────────────────────────────────────────────────────┤
│ 浏览器侧    studio/web/index.html + styles.css + src/*.mjs        │
│             main(编辑协调) · state(单例) · sync(SSE/快照 patch)   │
│             render(DOM/局部绘制) · view(视口) · gestures(手势)     │
│             inspector(属性面板) · sidebar · toolbar · api(请求)  │
│             同构模块:visual-style.mjs / clipboard.mjs(根目录共享)  │
└────────────────────────────────────────────────────────────────┘
```

方向规则:上层可引用下层,核心层不得反向引用命令/服务/特性层;web 侧不碰 Node API;
`scripts/mcp-tools.mjs` 对 studio 只经 `mcp-adapter.mjs` 与 `schema-validation.mjs`。

## 一切皆命令

- 注册表:`studio/commands/taxonomy.mjs`(分组表 → 派生全集 55 项,含别名)。
- 契约:`studio/command-contracts.mjs`(55 键,`validateCommandFields` 统一入口)。
- 分发:`studio/commands/apply.mjs` 的 `COMMAND_HANDLERS`(函数表,别名同函数)。
- 事务:`studio/commands/document-store.mjs` 的 `applyTransaction` —— 幂等键 →
  baseRevision 乐观锁 → 副本上原子执行 → 影响扩散 + 语义 diff → 快照/历史。
- undo/redo:线性栈,快照双阈值淘汰(120 条 / 8MB);撤销冲突显式报错。
- 普通编辑与撤销重做由 `persistence.mjs` 提交。命令先在内存副本完成校验和解算，再同步追加 WAL，成功后才发布文档、场景、历史与幂等记录。快照或辅助索引写入失败时，已提交事务保留 `durableRevision` 并返回 `W_CHECKPOINT_PENDING`。恢复和在线编辑共用批处理执行，日志保留生成的实例 ID。缺少旧快照时，撤销重做记录携带恢复所需的内容。
- `versions.mjs` 管理命名版本。命名版本恢复、工程合并和原生回填当前走各自的持久化入口。

四方一致性(分组表 ↔ 全集 ↔ dispatch ↔ 契约)由 `test:studio-parity` 门禁锁定,
新增命令漏掉任何一面会当场红。

## 请求链路

```
agent ──MCP──▶ bin/mcp.mjs ──▶ scripts/mcp-tools.mjs ──▶ studio/mcp-adapter.mjs
人类 ──浏览器──▶ server.mjs(静态资源 /src/**、/assets、/fonts、/api/events SSE)
                     │
                     ├─ handleRequest:精确路径 → ROUTE_HANDLERS 查表(32 键)
                     │  前缀/正则路由内联(静态 / SSE / review 图 / /api/runtime/*)
                     ├─ POST /api/commands ──▶ store.applyTransaction
                     │     └─ scene 重算 ──▶ broadcastSse(全量快照或增量 scenePatch)
                     ├─ 渲染确认:浏览器 POST /api/render-confirm
                     └─ 截图:server-capture.mjs 经 CDP 受管页等待
                        window.__STUDIO_RENDERED_REVISION__/HASH__ 后截取
```

性能路径:大文档(>500 节点)且纯几何变更时走增量 scenePatch;后台标签页降级 1.5s
轮询(HTTP/1.1 每 host 6 连接约束,见 canvas-fix G2)。

浏览器由 `web/src/main.mjs` 装配。命令和撤销共用请求队列，HTTP 回包与 SSE 使用同一快照
入口。快照取消过期手势后应用状态和局部或全量绘制，字体与图片就绪后确认对应版本。视口计算
由 `view.mjs` 负责，`render.mjs` 负责 DOM、选框和画板挂载，面板和手势通过显式参数提交动作。

## 出口矩阵

Studio 预览与独立 HTML 共用 `prototype-runtime.mjs` 的表达式求值、变量类型和交互分支执行。代码导出把同一实现写入 `app.js`，移动导出目录后仍可直接打开 `index.html`。两边各自提供节点查询、页面切换与数据集状态。

| 出口 | 文件 | 说明 |
|---|---|---|
| 原生 .rp | `export-rp.mjs` | 三级兼容契约(native-editable/栅格化/unsupported)+ 逐节点报告 |
| 离线代码包 | `export-code.mjs` | HTML/CSS/JS 工程;click/input/change 三触发器、24 动作;不支持项逐项披露 |
| 便携包 | `project-bundle.mjs` | 资源/字体/组件闭包 + 双哈希(contentHash/portableContentHash) |
| 三方合并 | `document-merge.mjs` / `sync-native.mjs` | 人机并发编辑合并;原生手改回填 |

## 已知白名单与例外

- 3 组动态 import 延迟环:server↔operations、server↔candidate-explorations、
  server↔scenarios(刻意解静态环;新动态环须在 AGENTS.md 登记)。
- `NON_STRUCTURAL_COMMANDS` / `SAFE_NODE_CACHE_COMMANDS` 含少量历史命令名
  (setConstraints/setTypography/bindToken),不在现行注册表,保留以维持
  事务缓存失效语义。
