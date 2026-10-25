# 一次 MCP 调用生成完整原型

创作入口、完整范例、改稿闭环和诊断见 [authoring-workflow.md](authoring-workflow.md)。
`generate_prototype` 默认 `compact:true`，返回源码、成品、页面预览、验证状态和完整报告路径；
需要旧版详细字段时显式传 `compact:false`。`recipe` 与 `spec/source` 二选一。
`autoHeal` 默认 `false`，与 CLI 一致；显式 `true` 会将候选修复完整重编译、重跑门禁，并在新增错误时回退整批修复。精简响应含回退标志与计数，完整报告含每项属性变化和原因。
文件输入推荐 `source:"/absolute/source.rp1"`；`spec` 接受内联对象、JSON 对象文本和文件路径。`sync_prototype.spec`、`diagnose_prototype.source`、`explain_binding.source`、`review_image_structure.spec` 也接受对象与 JSON 对象文本。

## 大原型：先取任务句柄

```json
{"source":"/absolute/source.rp1","output":"/absolute/prototype.rp","strictAudit":true,"async":true}
```

在 stdio MCP 中调用 `generate_prototype` 或 `revise_prototype` 并传 `async:true`，立即返回 `id/type/status`（改稿的 type 为 `revise-prototype`，可同时使用 `dryRun:true`）。用 `jobs_get({id})` 查询：
`queued → running → completed/failed/cancelled`；最终生成响应在 `result` 内，包含成品、基线、报告或结构化诊断。
`jobs_cancel({id})` 可取消，已经写出的文件保留，取消不代表撤销已发布的文件。
输入文件在排队期间变化会返回 `E_STALE_JOB_INPUT`。保持 MCP 连接；当前任务句柄保存在服务进程内，服务关闭后失效。
异步生成复用现有任务管理器，不需要新服务。默认仍同步；CLI 和直接库调用使用同步生成。

成功改稿将预览、IR、审计和 `revision-report.json` 发布到 `<output>.assets/`；响应和基线中的路径随之更新，`.revision-*` 中间目录自动删除。原文件始终保留。`read_interactions` 默认按 20 个交互拥有者分页，接近 20KB 时缩小本页条数，继续使用返回的 `nextOffset`；支持 `widget` 逻辑 ID、原生名称或对象 ID 过滤，完整事件树保留在对应拥有者内。

分页统一读取 `items`：按页面事件 → 顶层元件 → 嵌套元件（含面板/行模板）排列，并包含共享母版定义。`offset` 表示跳过多少个拥有者，`returned` 表示实际返回多少个；`items[].kind` 为 `page` 或 `widget`，各项均含完整 `interactions`。`pages[].pageInteractions`、`pages[].widgets` 和 `contained` 保留为分类视图，其中 `contained` 只列嵌套元件。首页 `contained:[]` 时，交互可能在页面事件和顶层按钮中；以 `items` 和 `returned` 判断本页内容。到末尾 `items:[]`、`returned:0`、`nextOffset:null`。

`generate_prototype` 接收 RP/1 JSON 对象，直接完成单页或多页编译、原生装配、跨页引用和结构检查。无需先建空白项目、逐页写入、手工合页或另写装配脚本。

## 前提

按 README 安装 Python 依赖，并在启动 MCP 服务时设置 `AXURE_BLANK_TEMPLATE_RP9` 指向用户自己的 RP9 单页空白工程。当前入口使用 RP9 原生后端。启用新工具后，MCP 客户端需重新连接以更新工具列表。

## 输入

```json
{
  "spec": {
    "language": "rp/1",
    "target": 9,
    "theme": "enterprise-light",
    "variables": {"selected": {"type": "text", "value": ""}},
    "pages": [
      {"id": "list", "name": "列表", "canvas": {"w": 420, "h": 300},
       "root": {"type": "box", "id": "root", "layout": "column", "padding": 24,
         "children": [{"type": "button", "id": "choose", "name": "选择按钮", "text": "选择数学", "w": 220, "h": 44,
           "onClick": [{"type": "set-variable", "variable": "selected", "value": "高等数学"}, {"type": "link", "page": "detail"}]}]}},
      {"id": "detail", "name": "详情", "canvas": {"w": 420, "h": 300},
       "root": {"type": "box", "id": "root", "layout": "column", "padding": 24, "gap": 16,
         "children": [{"type": "label", "id": "value", "text": {"variable": "selected"}, "w": 350, "h": 40},
           {"type": "button", "id": "submit", "text": "提交", "w": 220, "h": 44, "onClick": [{"type": "link", "page": "result"}]}]}},
      {"id": "result", "name": "提交结果", "canvas": {"w": 420, "h": 300},
       "root": {"type": "box", "id": "root", "layout": "column", "padding": 24,
         "children": [{"type": "label", "id": "value", "text": {"fn": "concat", "args": ["已提交：", {"variable": "selected"}]}, "w": 350, "h": 40}]}}
    ]
  },
  "output": "/绝对路径/复习原型.rp"
}
```

`language` 和 `target` 可省略，缺省为 `rp/1` 和 `9`。`output` 支持绝对路径或相对路径（相对路径自动按 `AXURE_WRITE_ROOT` 首目录或当前工作目录解析）。输出目录会自动建立；默认拒绝覆盖已有文件，迭代改稿时可传 `"overwrite": true` 允许原地更新并自动清理同目标的旧 `.build-*` 临时目录。若调用时未配置环境变量，也可直接传 `"template": "/绝对路径/blank-rp9.rp"`（或自动回退本机 `/tmp/axure-rp9-blank.rp`）。

共享视觉样式使用现有 `theme`、`palette` 和 `components`；模型、数据、绑定、规则、面板、母版、自适应等继续遵循 [RP/1 手册](rp-language.md)。跨页跳转使用页面 `id`，传值通过声明的全局 `variables` 完成。
- **设备与移动布局**：`device:"iphone-17"` 自动选择内容屏幕 `402×874`，最终外框为 `442×914`，内容在装配时统一平移 `(20,20)`。推荐省略 `canvas`；显式设置时填内容尺寸。无需另画机身或提前平移。`phone-shell` 管理屏幕内状态栏、顶栏和留白；`device` 管理外框。`iphone-16` 的屏幕为 `393×852`。完整规则和尺寸简写见 [手机布局速查](mobile-layout.md)。
- **移动宏与引用**：支持 `panel`（`dynamic-panel` 简写，State 支持可选 `name`）、`tab-bar`、`nav-bar`、`progress-bar`、`phone-shell`；任意元件支持 `visible:false` / `hidden:true` 初始隐藏；`paragraph` 可作为 `set-text` 目标；跨面板/组件用 `@panel/state/widget` 或 `panel.state.widget` 定位。

完整验收规格见 [mcp-three-pages.json](../examples/rp-language/mcp-three-pages.json)（零美学警告通过 `strictAudit: true`）：两个可复用科目条目 → 详情输入计划 → 提交结果。将该文件的完整 JSON 对象传给 `spec` 即可。新入口没有十二页的特殊限制；页数由原有编译器处理。

## 输出与后续编辑

默认成功响应包含 `status:"completed"`、成品 SHA-256、源码与基线、页面信息、`previews`、布局摘要、分层验证及完整 `report` 路径。`compact:false` 才展开结构、事件覆盖、状态预览和 `artifacts` 明细；默认精简响应不包含这些展开字段。完整报告保留 IR、计划和映射路径，按需读取。

生成不替换当前编辑会话。接着调用 `axure_open({path: output})`，即可使用 `locate`、`inspect`、`edit_text`、`rename_widget`、`verify` 和 `axure_save`（`target.name` 既支持原生显示名，也支持直接传 RP/1 逻辑 `id` 如 `"subtitle"`）。交付只报告已执行的验证；`verification` 中 Axure 打开、GUI 编辑、保存重开和预览初始均为 `false`，需要实际验证后另行记录。

结构检查始终执行；`strictAudit: true` 额外要求美学审计通过（当字号或间距触发软警告时，审计信息会直接列出具体违规元件名、当前数值与允许令牌表）。默认返回美学建议，但不因建议而阻止结构健康的产物。移动端页面（`domain: "mobile"`、`mobile-*` 主题、带 `PhoneShell`/灵动岛/状态栏组件或竖屏手机画布 `w <= 500 && h >= 750`）自动按移动端留白区间（`12%–82%`）进行美学审计。

- **多行文本与数值拼接**：`label` 在显式给定多行高度（`h >= 2.1 * fontSize`）、含 `\n` 或设 `wrap: true` 时自动按宽度断行测量与绘制，不会误报单行横向截断；长正文段落也可直接使用 `paragraph`。`concat` 函数支持直接传入数值/布尔变量或字面量（自动转为文本拼接），无需手写一层 `{"fn": "text", "args": [...]}`。

## 失败信息

失败返回 `isError: true`、`status: "failed"` 和 `stage`，不把半成品写到请求的输出路径。`diagnostics` 保留原有 `code/message/pointer`，并补充能确定的 `pageId/pageName/widgetId/widgetName/sourceId`。页面级排版问题不虚构元件归属；模板、环境等全局错误直接报告原因。

已进入编译的失败会保留独立诊断目录中的 `source.json`、`failure.json` 和已有中间文件；修正后使用相同目标路径重试即可。按模板环境变量、输出白名单和受保护路径执行原有文件规则。

---

## 源码 ↔ 原生改稿三方一致性同步（`sync_prototype`）

每次 `generate_prototype`（支持传 `spec` 对象或 `source: "/绝对路径/xxx.rp1"`）都会在 `<output>.baseline.json` 中记录源码指纹、原生 `.rp` 指纹、共同基线及 `logicalId <-> record+id` 映射。当用户在 MCP（`edit_text`/`rename_widget`/`set_widget_geometry`/`set_widget_style`）或 Axure GUI 中改过 `.rp` 后，通过 `sync_prototype` 保持三方一致：

1. **检查漂移状态（`mode: "status"`）**：
   ```json
   { "mode": "status", "source": "/绝对路径/app.rp1", "rp": "/绝对路径/app.rp" }
   ```
   返回 `status`（`clean` / `source_ahead` / `native_ahead` / `diverged` / `untracked`）及是否需要同步。
2. **原生改稿导回源码（`mode: "lift"`）**：
   ```json
   { "mode": "lift", "source": "/绝对路径/app.rp1", "rp": "/绝对路径/app-edited.rp", "outSource": "/绝对路径/app-lifted.rp1" }
   ```
   将原生文字、改名、几何 (`x/y/w/h`)、样式 (`fill/stroke/color/radius/fontSize`)、增删元件及支持的单 Case 无条件 `OnClick` 导回 `.rp1`/`.json`，保留 `.rp1` 原有 `# 注释` 与未改动的 `$token` 引用。
   - **默认精简响应**：`lift` 和 `merge` 默认返回 `summary` 统计、变更明细列表（`lifted*` / `preserved*`）与输出文件路径，不内联整份 `spec`/`rp1` 源码文本（避免多页原型撑爆上下文）；如需在返回 JSON 中内联完整 `spec`/`rp1`，显式传 `includeSpec: true`。
3. **双边改动三方合并（`mode: "merge"`）**：
   ```json
   {
     "mode": "merge",
     "source": "/绝对路径/app-new.rp1",
     "rp": "/绝对路径/app-edited.rp",
     "outSource": "/绝对路径/app-merged.rp1",
     "output": "/绝对路径/app-merged.rp",
     "prefer": "fail"
   }
   ```
   不同元件或同元件不同属性修改自动合并并重编译 `.rp`；同元件同属性修改、删除 vs 修改冲突、或包含条件/多 Case/禁用交互的原生改动默认返回 `status: "conflict"` 及 `conflicts[]` / `unsupportedNativeChanges[]`，可通过 `prefer: "source"|"native"` 或 `resolutions: {"<logicalId>:<prop>": "source"|"native"|{"value": ...}}` 显式解决。

---

## 高层图片转原型入口（`generate_from_image`）

```json
{
  "image": "/绝对路径/screenshot-2x.png",
  "output": "/绝对路径/from-image.rp",
  "scale": 2,
  "page": "首页还原",
  "replace": ["旧文案=新文案", { "old": "错字", "new": "正字" }],
  "preview": true
}
```

- 自动执行 Apple Vision OCR、几何卡片/分割线/圆形识别、独立图标/复杂媒体切片提取（持久化在 `<output>.assets/`）、单行替换超宽自动扩宽防折行，并在 RP9 下直接写出可编辑二进制 `.rp`（附带 `<output>.baseline.json` 与 `visualDiff` 分层校验摘要）。
- 支持传入 `baseRp` 检测原生改稿防静默覆盖（`E_NATIVE_DRIFT_PROTECTED`），以及 `preview: true`（在 macOS 自动截取 Axure RP 9 宿主窗口）或 `preview: "/绝对路径/window.png"` 执行宿主预览像素差分。

---

## 只读直查、GUI 往返与浏览器预览提示

- `verify`、`locate`、`inspect`、`read_interactions` 既可在 `axure_open` 活动会话中无参调用，也支持直接传入 `path: "/绝对路径/xxx.rp"` 进行零副本只读检查（不生成 `.work-N.rp`，不改变当前活动会话）。
- `verify({ path, deep: true })` 默认只将**同一页面内**的重名元件列入 `duplicates`，多页共用组件（如顶栏、`PhoneShell`）产生的跨页同名元件汇总在 `duplicateSummary` 中（如需展开全部跨页同名项，可传 `includeCrossPageDuplicates: true`）。
- `gui_roundtrip` 支持可选参数 `preview: true`，在完成 Axure 保存、关闭、重开后自动触发原生菜单「发布 -> 预览（Publish -> Preview）」，并返回 `outputSha256`。
- **浏览器自动化（`huashu-chrome` / Playwright）点击提示**：Axure RP 9 导出的 HTML 预览中，矩形按钮（VectorShape）渲染为外层 `<div id="uXX" class="ax_default shape">` 与内层文字 `<div id="uXX_text"><p><span>按钮文字</span></p></div>`。若通过无障碍快照拿到静态文本节点，请在触发点击时点外层 `.ax_default` 容器（或 `el.closest('.ax_default')?.click()`），以确保稳定触发绑定在元件上的 Axure `OnClick` 事件。

测试：`npm run test:mcp-generate`、`npm run test:sync`、`node test/rp1-sync-b-check.mjs`、`node test/image-mcp-c-check.mjs`、`node test/zhixu-d-check.mjs`。
