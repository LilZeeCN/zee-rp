# Studio 首个可运行代码出口 (`G01`)

## 1. 概述与设计原则

`studio/export-code.mjs` (`studio_export(format:code)` / `/api/export-code` / `node bin/axure.mjs studio export-code`) 将同一份 Studio 权威源文档导出为自包含、离线可运行的 `HTML/CSS/JS` 工程包：

- **同一语义源复用**：直接复用 `resolveDocumentScene` 的解算布局、设计 Token、全局变量、动态面板全状态子树、多页导航、中继器数据/模板绑定（含筛选/排序/增删改）与 `V01` 可编辑矢量路径 (`<svg><path>`)。
- **固定画板与已声明断点如实表达**：未声明 `adaptiveViews` 时显式标记为 `fixed-board`（绝不编造伪响应式行为）；声明了 `adaptiveViews` 或 `constraints` 时在 `styles.css` 与 `manifest.json` 中保留已声明断点与约束。
- **拒绝输出空壳按钮**：在生成代码前对全树交互进行静态审计（`analyzeDocumentInteractionsAndLayout`）。仅 `click / input / change` 与受支持动作编译为可交互控件；不支持的触发器（如 `hover / drag / swipe`）或未知动作在 `manifest.json` 的 `interactionCompatibility.unsupported` 中逐项列明，并在 DOM 上标记 `data-unsupported-interaction` 与 `aria-disabled="true"`，不渲染为伪按钮。
- **版本绑定与防旧覆盖**：
  - `index.html`、`app.js` 与 `manifest.json` 均绑定 `documentId / revision / contentHash` 及所有导出文件的 SHA-256 指纹。
  - 传入过期的 `baseRevision` 时立即抛出 `E_STALE_REVISION`。
  - 导出结果登记到工程 `.studio/code-exports.json`；若试图用较旧 `revision` 覆盖已登记的较新导出记录，立即以 `E_STALE_CODE_EXPORT_REGISTRATION` 拒绝。
  - 首版承诺单向导出与工程内登记，不承诺任意手改 HTML 的无损反向解析回写。

## 2. 导出包结构

```text
<outDir>/
├── index.html      # 页面壳、版本绑定属性、画板模式标识与首屏静态节点
├── styles.css      # 设计 Token CSS 变量、画板与节点样式、已声明断点规则
├── app.js          # 离线交互运行时 (window.__STUDIO_EXPORT_APP__)
├── manifest.json   # 版本/哈希绑定、文件 SHA-256、资源闭包、交互兼容报告
├── README.md       # 本地运行与验证说明
└── assets/         # 离线复制并重写为相对路径的本地图片资源
```
