# 创作、改稿与诊断进阶指南

> 💡 **提示**：日常从零写 `.rp1`、生成单图联审与调用 `revise_prototype` 改稿，只需阅读主入口 **[SKILL.md](../SKILL.md)** 即可，无需重复翻阅本文件。本文件仅在需要**深度错误诊断、绑定静态分析、浏览器真实预览自动点击断言或图片结构审阅**时按需查阅。

手机布局规则见 [mobile-layout.md](mobile-layout.md)，最小示例见 [mobile-layout.rp1](../examples/rp-language/mobile-layout.rp1)。

## 1. 内置范例起步（可选）

调用 `prototype_recipe({})` 可查看 3 套内置多页范例（`mobile-cards`、`list-detail`、`step-form`）及内联 `cheatsheet`：

```json
{"recipe": "mobile-cards", "output": "study.rp", "strictAudit": true}
```

传给 `generate_prototype` 后会並排生成 `study.rp`、独立可改写的 `study.rp1` 与 `study.rp.baseline.json`，并在预览目录产出全页横向拼图 `contactSheet`（`pages-sheet.png`）与纯净动态面板状态拼图 `statesSheet`（`states-sheet.png`）。

## 2. 结构化与跨面板增量改稿（`revise_prototype`）

```json
{
  "source": "/workspace/study.rp1",
  "rp": "/workspace/study.rp",
  "output": "/workspace/study-v2.rp",
  "operations": [
    {"target": "today/headline", "property": "text", "value": "先完成最重要的一件事。"},
    {"target": "today/nested_widget", "property": "text", "value": "支持跨动态面板状态深层定位"},
    {"op": "add", "path": "after:today/headline", "value": "card #tip [fillxhug] title=\"每日提示\" body=\"先回忆再翻卡\""},
    {"op": "remove", "path": "today/old_node"},
    {"path": "/palette/brand", "value": "#7256C8"}
  ]
}
```

- **深层定位**：`target` 写 `<page>/<id>` 即可自动在页面顶层及所有 `dynamic-panel` 的 `:state` 子树中检索唯一匹配 ID；同页存在重名时再写完整路径 `<page>/<panel>/<state>/<id>`。
- **结构级增删改**：`op: "add"` 支持 `path: "after:<page>/<id>" | "before:<page>/<id>" | "<page>/<container_id>"`，`value` 直接接受 `.rp1` 文本片段或 JSON 节点；同样支持 `op: "remove"` 与 `op: "replace"`。
- **预演与防覆盖**：传 `dryRun: true` 仅预览受影响页面（`impact.affectedPages`）与冲突；设 `output: "auto"` 自动生成递增文件名（如 `-v2.rp`）。
- **后台改稿与产物**：stdio MCP 支持 `async:true`（也支持 dryRun），用 `jobs_get({id})` 取最终 `result`。成功改稿清除 `.revision-*`，将预览、IR、审计和报告保存在 `<output>.assets/`，响应和基线中的路径指向正式产物。运行期 data-add 表达式完整保留。

## 3. 批量根因诊断（`diagnose_prototype`）

当源码编译报错时，调用只读工具 `diagnose_prototype({source: "/workspace/study.rp1"})`（或 CLI `node scripts/proto.mjs diagnose --spec study.rp1`）：
- 一次性收集全部独立节点错误，附带行列号、源码片段、修复建议与候选补丁 `candidatePatches`。

## 4. 静态绑定与刷新链解释（`explain_binding`）

当某个文本或进度条未按预期刷新时，调用 `explain_binding({source: "/workspace/study.rp1", target: "stats/progress"})`：
- 返回完整求值表达式、依赖的变量/元件列表、初始值与编译出的 `OnLoad` / `OnClick` 刷新事件列表（标记 `evidence: "compiled-static"`）。

## 5. 浏览器真实预览自动回放（`preview_prototype`）

需要验证 Axure 导出 HTML 在真实浏览器中的运行期行为时，先启动预览并在受控浏览器空间取得 `spaceId`，再调用 `preview_prototype`：

```json
{
  "source": "/workspace/study.rp1",
  "spaceId": 1,
  "output": "/workspace/study-preview-check.json",
  "steps": [
    {"action": "click", "target": "today/start", "expect": {"page": "review"}},
    {"action": "click", "target": "review/master", "expect": {"page": "stats", "variable": "done", "equals": 1}},
    {"action": "expect", "target": "stats/count", "expect": {"text": "已掌握 1 / 1"}}
  ]
}
```

## 6. 服务状态与基准评测

- `runtime_info({})`：检查当前 MCP 进程版本、代码指纹（`restartRequired`）与 Python 图像依赖。
- 固定评测基准集见 [tasks.json](../benchmarks/authoring/v1/tasks.json) 与 [记录规范](../benchmarks/authoring/v1/README.md)。
