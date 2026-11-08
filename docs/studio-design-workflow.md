# 从认可的作品到可重复的 AI 创作流程

2026-10-28：AI局部创作入口、语义查询和按需帮助见 [RP/1画布创作](studio-ai-authoring.md)。`studio_scenario` 是隔离语义执行（`hitTest:true` 可加真实指针遮挡校验，被遮挡返回 `E_SCENARIO_OCCLUDED`）；`studio_design(action:explore)` 的 states 是单独的浏览器指针证据。

本流程适用于包含 Studio 的 zee-rp 程序。它让当前调用工具的模型读取参考、准备素材、看图、记录问题和改稿；服务端不会暗中调用另一个模型，也不产生审美分数。

## 启动与连接

先在全新 MCP 连接中发现 `studio_*` 工具。开发服务器配置示例：

```json
{"mcpServers":{"zee-rp-dev":{"command":"node","args":["/absolute/path/zee-rp/bin/mcp.mjs"]}}}
```

桌面客户端必须重新连接才能加载新增工具。已经运行的旧 JavaScript 进程不会随着源码改变。无法更新客户端连接时，可先运行 `node bin/axure.mjs studio start --project /abs/project --source /abs/source.json`，在浏览器打开返回的单端口地址；CLI 的 `design-context`、`prepare-media` 和 `review` 连接同一服务。素材和评审参数可用 `--input /abs/request.json` 提交；CLI 不打印图片的 base64。

## 使用 B 版工作台

工作源码的默认画布已采用用户选定的「深色专注画室」。左侧切换图层、组件与样式；搜索框可按图层名称、文字或标识查找，页面右侧的菜单提供移动、复制与删除。底部使用选择工具 V 或平移工具 H，也可按住空格拖动画布。

右侧按所选图层组织属性；图片会显示实际资源和尺寸。「所有属性」保留完整编辑项，顶栏的历史按钮显示真实修改记录。设计、预览和方案仍共用原有工程，保存状态对应实际落盘版本。AI 截图只输出作品，不包含浮动面板。

桌面宽度建议至少1024px；更小的窗口先显示提示，可选择缩小查看。工作台的本地验收记录位于开发仓库 `verification/studio-workspace-b/REPORT.md`，不随程序包分发；本轮验证不新增 Axure 宿主验收。

## 1. 选择参考，写清任务

调用 `studio_stage({intent:"editorial",pageId:"home"})`。返回真实参考图、冻结源文件位置、单页节点源、设计决定、素材配方与当前工程版本。`task` 和 `learning` 返回相应指导，并明确 `reference:null`。不把摄影型作品强加到设备检索或学习阅读中。

每页在动手前写清：用户要做什么、必须看到什么、主操作是什么、完成/空/错误状态如何出现。保留品牌和内容事实。可以从基础节点自由构图，不强制选三种模板。

栖羽包位于 `examples/studio/qiyu-field-notes/`。`manifest.json` 冻结源、截图、配方和素材字节；变化会触发 `E_BENCHMARK_DRIFT`，需要重新审查并更新冻结记录。原图授权见包内 `CREDITS.md`。该包不是通用布局模板，也不证明多条持久手记或任意长文本可用。

## 比较自由构图

起稿后，使用 `studio_design(action:explore)` 的 candidates 模式对同一任务提出不同的信息组织方式，在隔离副本中看回忆、揭示、完成等状态。AI 自写任意命令，工具返回实际浏览器联系图；选稿后才提交一个事务。完整参数、行为保留与证据边界见 [自由构图与多状态预演](studio-candidates-20261027.md)。

## 2. 准备摄影素材

```json
{
  "sourcePath":"/abs/original.jpg",
  "credit":"作者、授权与来源地址",
  "crops":[{"name":"hero","w":402,"h":640,"fx":0.4026,"fy":0.5,"fh":1,"scale":2,
    "protectedRegion":{"x":0.35,"y":0.3,"w":0.05,"h":0.2},
    "fadeFrom":450,"fadeToToken":"bg"}]
}
```

`fx/fy` 是原图中裁切中心的归一化坐标；`fh` 为裁切高度占原图高度的比例。`w/h` 为画布上的图框尺寸，`scale` 为输出像素倍率。`protectedRegion` 是原图中必须保留的矩形；无法保留时返回 `E_MEDIA_SUBJECT_CROP`，不擅自切掉主体。当前处理器支持静态图片转 RGB JPEG；透明插画、动图与自动主体识别不属于此接口。

`fadeToToken` 必须存在于工程 `tokens.colors` 中。配方保存解析后的底色，底色变化需要重做衍生图，评审会报告 `W_MEDIA_TOKEN_STALE`。工程中保留原图、配方、来源与内容哈希；相同原图和配方重放同一文件。批量最多20种裁切。栖羽的9项配方和原交付 JPEG 已逐字节对照。

工具只准备不可变资源，不自动变更画布。把每项结果中的 `registerCommand` 和节点挂载放在同一事务：

```json
{"baseRevision":7,"idempotencyKey":"attach-hero-v1","pageId":"home","commands":[
  {"type":"registerAsset","asset":"此处使用准备工具返回的完整 asset 对象"},
  {"type":"setProperties","nodeId":"hero","properties":{"src":"assets/media-HASH.jpg","w":402,"h":640}}
]}
```

上例 `asset` 的占位说明需要替换为实际对象，不能把字符串直接提交。服务验证资源字节的 SHA；修改与资源登记共同进入历史，可一起撤销。撤销不会删除缓存和原图，便于重放与 redo。

## 3. 用真实截图评审与改稿

批量样式优先绑定设计 token，精细位置优先用 `editNodes` 的 align/place/move/distribute 表达关系。它编译为现有原子命令，失败时整批回滚，不隐式切换流式布局。修改后可在 `studio_design(action:review)` 中传 `compareWithReviewId`，一次查看前后真实截图、变化图层范围和检查项变化；编辑器顶栏「对照」提供同一能力。示例和限制见 [关系编辑与画面对照](studio-editing-20261027.md)。

1. `studio_design(action:review)({pageId:"home",baseRevision:8})` 创建版本截图及机器检查，状态为 `awaiting-visual-review`。工具返回真正的 MCP 图片块，供当前模型直接看图。
2. 检查主次、构图、图片主体、图文比例、阅读层级和状态。每个问题给出节点 ID、问题和下一步决定。不能只写“更加高级”。
3. `studio_design(action:review)({pageId:"home",baseRevision:8,reviewId:"…",observations:[{nodeIds:["hero"],issue:"照片主体被按钮遮住",decision:"将按钮移到照片下方"}]})` 将模型观察另存。原始截图记录保持不变，标记 `agent-reviewed`、`userAccepted:false`。
4. 提交原子改稿，再创建新评审。旧版本返回 `E_STALE_REVIEW`；不会把旧图复用成新版本的完成证据。已提交的观察记录不可覆盖。

`findings` 包含文字裁切、越界、缺图和衍生图底色过期等机器结果，不覆盖审美、所有视觉重叠或业务正确性。装饰性背景可延伸到安全区；正文、导航和操作从60px以下开始。不要把状态栏误当页面正文。

`studio_screenshot` 默认也直接返回图片。截图附有版本、内容哈希、渲染器版本与图片 SHA。需要纯文本元数据时可设 `includeImage:false`；HTTP/CLI 的普通截图路径保持兼容。

## 4. 验收

- 内容：无凭空示例条目、占位词和静默内容丢失；新数据量必须有明确显示策略。
- 业务：真实鼠标与键盘完成主流程，结果回显正确；另跑错误期望的负对照。
- 画面：检查当前版本实际截图，机器结果与模型观察分开保存。用户未选择时保持视觉验收待定。
- 原生：导出可编辑 `.rp` 并检查结构；Axure 宿主加载、保存重开与真实预览分别记录。装饰可单独栅格化，不能把整页截图包装成可编辑作品。

三题迁移研究的可重放源在 `examples/studio/transfer/`。运行 `node verification/design-workflow/run-transfer.mjs /abs/new-evidence-dir --native` 生成同题旧模板/自由设计对照、真实操作日志、原生工程和匿名比较页。研究只表示当前模型按此流程完成了这些题目，不构成未知模型的盲测或普遍设计质量承诺。
