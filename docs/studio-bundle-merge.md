# Studio 自包含工程包 (`P02`) 与三方结构化安全合并 (`M01`)

## 1. 自包含可迁移工程包 (`studio_export(format:bundle)` / `studio/project-bundle.mjs`)

- **目标**：将自由画布工程打包为无宿主机绝对路径泄漏、可在任意新目录独立打开、编辑、截图、运行交互并导出 `.rp` 的自包含工程包。
- **包结构**：
  - `bundle-manifest.json`：包含 `format: "zee-studio-bundle/v1"`、`documentId`、`revision`、`contentHash`、依赖闭包统计与所有包内文件的相对路径和 SHA-256 摘要。
  - `document.json`：已净化绝对路径的权威源文档（包含 `pages`、`components`、`tokens`、`palette`、`variables`、`datasets`、`designDecisions`、`fonts`、`assetsManifest`）。
  - `project.json`：可迁移工程元数据（`sourcePath: null`，避免指向原机器路径）。
  - `compatibility-report.json`：引用闭包与兼容性诊断报告。
  - `assets/*`：工程实际引用的所有图片/媒体素材（按相对路径 `assets/<file>` 落盘并校验 SHA-256 与宽高）。
  - `fonts/*`：工程本地字体目录或 `doc.fonts.catalog` 声明的工程字体文件。
  - `versions/*` 与 `thumbnails/*.svg`：可选携带的命名版本快照与缩略图。
- **兼容性与前向/后向 Schema 迁移**：
  - 自动统计 `tokens`（已用/未用/未定义引用 `W_UNRESOLVED_TOKEN`）、`components`（已用/未用/缺失定义 `E_MISSING_COMPONENT_DEFINITION` + 契约版本与 SHA-256）、`assets`（已用/缺失文件 `W_ASSET_FILE_MISSING`）、`fonts`（已用/缺失本地字体 `W_FONT_FILE_MISSING` + fallback 链）。
  - 当导入更高 `schemaVersion` 或携带未知扩展字段的工程包时，通过 `migrateAndPreserveSchema` 将未知顶层或节点字段保留在 `readonlyUnknownFields` / `_readonlyPreservedFields` 并产生 `W_UNKNOWN_FIELDS_READONLY` 警告，绝不静默丢弃。

## 2. 三方结构化安全合并 (`studio_merge(kind:merge)` / `studio/document-merge.mjs`)

- **合并基准 (`base`)**：支持显式 `baseDoc`、历史修订号 `baseRevision`（从事务历史自动重构基准快照）或命名版本 `baseVersionId`。
- **合并来源 (`theirs`)**：支持人类画布 / AI 并发命令集 (`theirsCommands`)、RP/1 片段 (`theirsRp1`)、外部文档对象 (`theirsDoc`) 或磁盘外部 `.json` / `.rp1` 文件 (`externalSourcePath`)。
- **冲突检测覆盖 8 类耦合与竞争**：
  1. `same-field`：同一节点、组件、令牌、变量、数据集或设计决定的同一字段被双方修改为不同值。
  2. `delete-modify`：一方删除节点/页面/组件，另一方修改其属性或子树。
  3. `reparent-conflict`：同一节点被双方移动到不同父容器，或移入已被另一方删除的容器。
  4. `structure-order`：同一父容器的子节点顺序或页面顺序被双方同时重排。
  5. `layout-coupled`：同一节点的耦合几何/布局字段被双方分别修改（例如一方改 `x`、另一方改 `right` 或 `w`；一方改 `layout`、另一方改 `gridColumns`）。
  6. `parent-child-layout-coupled`：一方将父容器切换为流式布局 (`row`/`column`/`grid`)，另一方同时修改了子节点的绝对坐标 (`x`/`y`) 或网格跨度。
  7. `component-instance-coupled`：一方修改或删除组件定义 (`doc.components[id]`)，另一方新增该组件实例或修改同一子节点的实例覆盖 (`overrides`)。
  8. `reference-coupled`：一方删除令牌 (`tokens`/`palette`) 或页面，另一方在新属性或交互动作中新增对该令牌/页面的引用。
- **外部文件安全提示 (`check-external`)**：
  - 外部 `.json` 或 `.rp1` 源文件发生变更时，先通过 `mode: "check-external"` 计算三方差异与冲突摘要，**绝不静默覆盖内存中的权威文档**；仅当用户或 AI 显式调用 `mode: "apply"`（可配合 `prefer: "ours" | "theirs"` 或逐项 `resolutions`）时，才作为单步可撤销事务提交到 `StudioDocumentStore`。
