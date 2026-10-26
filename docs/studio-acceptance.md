# Studio 场景执行与排版验证

本页对应工作仓库的 Studio 开发版本。正式安装的 MCP 程序尚未替换。

## 场景的证据层级

`studio_run_acceptance_scenarios`、HTTP `/api/scenarios/run` 与 CLI `studio scenarios` 使用同一个执行器：

| layer | 实际执行 | 不代表什么 |
| --- | --- | --- |
| `semantic` | 语义模型、布局与状态断言；12个内置模板 | 不能替代浏览器或 Axure 的实际操作 |
| `browser` | 在独立工程中打开真实画布，切换交互模式，鼠标点击或键盘输入，再读取页面、变量及可见文字 | 无 `interactionSteps` 的模板返回 `unsupported` |
| `axure-preview` | 对本次导出的独立副本执行 RP9 保存、关闭、重开和预览；操作真实预览，读取相同断言 | 导出成功和结构三零不能替代业务操作 |
| `native-structure` | 导出 `.rp`，读取结构与三零结果 | 不声称已运行 Axure 预览 |

内置 `flow-list-to-detail-and-back` 已配置共同操作脚本，在观鸟、学习卡片、设备借还三个领域中执行“首页 → 列表 → 详情 → 列表”，并检查列表文字及变量。其余11个模板当前是语义模板，未提供真实操作脚本时，不计为浏览器或原生通过。

```sh
node bin/axure.mjs studio scenarios --port 4335 --domain birding --ids flow-list-to-detail-and-back --layers semantic,browser,axure-preview
```

自动原生预览需要 macOS、Swift 工具链和 Axure RP9。每次打开唯一命名副本，必须出现可唯一识别的新预览端口。GUI失败最多使用新副本重试一次，所有尝试及失败文件均保留。其他宿主可通过 `axurePreviewUrl`（CLI `--axure-preview-url`）传入自己从目标工程生成的真实预览地址；自动宿主不可用时返回 `blocked`。

程序接口 `runAcceptanceScenarios(doc, {scenarios, layers})` 可接收自定义场景：

```js
{
  scenarioId: 'open-list',
  startPageId: 'home',
  interactionSteps: [
    { action: 'click', target: 'home/top_nav',
      expect: { page: 'list', variables: { recordCount: 3 }, text: { list_counter_label: '3' } } }
  ]
}
```

真实层当前支持 `click`、`input`/`fill`、`expect`，断言支持 `page`、`variables`、`text`；文字也可使用 `{includes:'片段'}`。未知断言、空期望、没有操作脚本均明确返回 `unsupported`。实际错误、被遮挡目标、断言不符不能通过。原始文档不会被期待值或语义执行结果替换。浏览器执行使用隔离服务，不交换用户当前文档。

交互哈希相同只能说明定义未变化，不能说明运行行为通过。交互、变量或数据变化时，在依赖未完全建立前保守选择全部12个模板。`impactReport` 与 `runAll` 可由 MCP 传入。

## 排版与边界

Studio 内置业务模板、探索方案和新建手机画布为顶部系统区域预留60px，导航和正文从该边界下方开始。探索可用性检查会拒绝顶部区域内的文字或操作控件。既有手工设计文档不自动重排；旧导出需要重新生成才能应用此修复。

macOS 度量使用 CoreText 的真实字体 shaping，处理 kerning、连字和 Unicode。Swift helper 按源文件 hash 编译到临时缓存；缺少宿主时标记 `degraded-estimate`，不承诺其他平台同等误差。工程字体会检查文件有效性及实际字体族，加载失败须回退并诊断。修改字体资源后调用 `bumpFontResourceVersion` 重新计算。

`maxLines` 限制显示行数，`ellipsis` 控制省略号；文档保留完整原文，画布和原生输出使用相同显示文字。高度、最大高度、截断参数和字体状态参与缓存键。混合字号富文本的复杂换行仍须单独验证，不能由普通文字样本推广。

全量验收的32个样本比较真实 DOM 行数、高度和非空基线；单行自适应样本另比较宽度。固定宽度的多行内容不把外框宽度当成文字宽度，未比较项记录 `null`，不是零误差。额外边界脚本测量原审查的 kerning/非ASCII失败文本、浏览器与 Axure 的实际截断，并注入错误跳转和错误文字期待，要求它们确实失败。

```sh
npm run test:studio-repairs
node verification/five-directions/run-five-directions.mjs
node verification/five-directions/run-repair-boundaries.mjs
```

每次输出到独立 `verification/five-directions/runs/<run-id>/`，不删除既有证据。当前验证记录位于工作仓库的 `verification/five-directions/FINAL-REPORT-FIVE-DIRECTIONS.md`。
