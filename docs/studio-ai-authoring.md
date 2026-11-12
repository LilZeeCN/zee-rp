# AI 在自由画布中用 RP/1 创作与改稿

开发分支快照，2026-11-02。画布、RP/1 片段、关系命令、截图、状态验证和原生导出使用同一份 Studio 文档；局部片段不替换整个工程。

先调用 `studio_describe({topic:"workflow"})`，按需读取 `rp1`、某个 `command`（或用 `names:["addPage","addNode","setProperties"]` 一次查多个）、`node` 或 `design`。CLI 可用 `node bin/axure.mjs studio describe --topic rp1`，不需要先启动工程，也不需要阅读实现源码。

阶段选择、完整参考、局部上下文预算与可持久化设计决定见 [阶段创作指南](studio-stages.md)。

节点属性按实际类型与canvas/runtime/native消费面发现，精确用法及行模板边界见 [节点能力说明](studio-node-capabilities.md)。

Axure手工改稿与AI并行修改的已验证流程、稀疏回填和剩余边界见 [原生往返说明](studio-native-roundtrip.md)。

## 交互先写对，再验证完整流程

`studio_describe({topic:"workflow"})` 和 `{topic:"rp1"}` 都返回 `interactionGuide`，内含可直接执行的三词复习、完成页与重开示例，以及带断言的四步剧本。

条件统一用 `when:"=$index === 1"`；也接受 `if` / `condition` 和省略 `=` 的字符串。兜底用 `else:true`。未知变量、类型不符与无效条件在写入时指出具体字段，整笔事务不写入。分支按顺序取第一个匹配项；动作也按顺序执行：先更新文字与变量，再跳页。不要只更新显示文字而忘记推进状态变量。

```json
{"type":"setInteraction","nodeId":"remember","actions":{"cases":[
  {"when":"=$index === 1","actions":[
    {"type":"set-text","target":"word","text":"meticulous"},
    {"type":"set-var","name":"index","value":2}
  ]},
  {"else":true,"actions":[{"type":"navigate","page":"done"}]}
]}}
```

先声明 `index` 变量、`word` / `remember` 节点和 `done` 页面。表达式可使用 `text`、`number`、`concat`、`contains`、`length`、`lower`、`upper`、`not`、`remove`；引号里的 `$name` / `@widget` 保持原文。`studio_scenario` 的 `stepResults[].executed` 给出条件表达式、实际值和分支是否命中，同时返回 `coverage`（页面、交互节点、面板状态与 `cases` 分支覆盖率）与 `warnings`（交互自愈诊断）；为每道题与跳页结果写断言，不能只验首屏。

Studio 原生出口会把跨页 `set-text`（普通 label / paragraph / button / badge）转换为全局文字状态与目标页加载恢复，同页后续改字也同步保存。`crossPageTextState` 列出转换；动态文字绑定、富文本、输入和行模板不使用此自动桥接。

`input.rotation` 保留原生 TextBox，借原生 `OnLoad` 绝对旋转动作恢复预览，兼容报告标记 `native-init-action`。RP9 编辑器本身不提供 TextBox 静态旋转；这与预览中可旋转、可输入分别说明。完整 RP/1 也支持此路径；显式静态／禁用交互输出会跳过初始化动作。

## 两种 RP/1 用法

- 直接交付完整原生 Axure 原型：现有 `generate_prototype` / `revise_prototype` 支持完整语言、业务模型、变量、数据、组件与原生编译，参见 [RP/1 手册](../references/rp-language.md)。
- 在正在编辑的自由画布中创作：`studio_command` 的 `rp1` 是明确受限的节点片段入口。它解析为原有命令，保留文档、版本检查、幂等、撤销、持久化及影响追踪。需要的顶层共享定义先通过既有文档命令准备。

同一个请求中 `commands` 和 `rp1` 二选一。原有 `source` 参数仍表示调用来源，不承载片段，避免破坏旧调用。

## 实例、富文本与布局

- `setText` 接受 `text` 或非空 `spans`，二选一。修改实例根节点或 `instanceId__childId` 只影响该实例。使用普通 `text` 会清除原来的逐段样式。
- `swapInstance` 保留目标组件仍接受的覆盖和实例位置。使用 `preserveOverrides:false` 可以清空覆盖后换入另一个组件。
- `layout:"row", wrap:true` 逐行布置子节点。每行应用 `justify` 和交叉轴对齐，`equalHeight` 按行统一高度。添加 stack 子树时，省略坐标导致子节点共用起点会在成功回包中给出定位提醒。
- `studio_open_project` 的 `studioRuntime.restartRequired` 提示是否需要重启复用的 Studio 服务。MCP 本身的加载状态由 `runtime_info` 单独报告。

## 从空白开始

1. `studio_open_project({projectDir:"/abs/project"})`，记住返回的版本与真实页面ID。
2. `studio_stage({stage:"skeleton",intent:"learning",platform:"mobile",target:{pageId:"home"},brief:"先回忆，再揭示与反馈"})`。按任务选择设计理由：问题与答案如何组织、谁是主角、字体与素材如何配合、哪些状态必须检查。配方是创作材料；模型评分或机器检查不代表审美认可。
3. 查询父布局与内容盒，再插入片段。默认手机 `home_screen` 已有60px顶部 padding，子节点 y=0 已经在安全区下方，不要重复加60。

```json
{
  "baseRevision": 1,
  "idempotencyKey": "lesson-first-draft",
  "pageId": "home",
  "parentId": "home_screen",
  "sourceMode": "insert",
  "rp1": "column #lesson [350xhug] gap=24\n  label #word \"serendipity\" fontFamily=Georgia fontSize=44\n  paragraph #answer [fillxhug] \"意外发现美好事物的能力。\" visible=false fontSize=16 lineHeight=25\n  button #reveal [fillx48] \"揭示答案\"\n    +onClick [{\"type\":\"show\",\"target\":\"answer\"}]"
}
```

每个节点写显式稳定 `#id`；用单个根容器组织一个片段。支持 `column/row/stack/grid` 和 `hug/fill`，让文字内容决定高度；视觉可用已有 `fontFamily/css` 扩展。图片先用素材工具登记，再引用返回路径。

`insert` 新增子树，ID冲突会报错，不会偷偷加后缀改名。`update` 只修改显式字段，不把省略的内容、样式、事件、节点或顺序当成删除。例如：

```json
{
  "baseRevision": 2,
  "idempotencyKey": "word-copy-v2",
  "pageId": "home",
  "parentId": "lesson",
  "sourceMode": "update",
  "rp1": "button #reveal \"查看释义\""
}
```

该按钮已有的尺寸、颜色和点击行为保持。需要删除、移动或重排时显式使用原有命令；update 不猜层级变更。

## 查询返回可以真正修改的目标

```json
{"pageId":"home","role":"primary-action","fields":["target","layoutContext","controls"]}
```

`studio_inspect` 默认返回8项 authoring 节点，可按 `nodeId/nodeIds/role/type/textContains/within` 选择；`fields` 精确投影，`cursor` 绑定文档、版本和查询，过期后重新查询。`view:"nodes"` 和 `view:"authoring"` 都使用默认投影，`view:"full"` 返回完整解算节点。

- `target` / `editableTargetId`：权威源节点、实例覆盖或可映射宏参数。找不到确定映射时不给虚构的可写目标。
- `layoutContext`：父布局、padding与源局部坐标。流式布局的子项应改顺序与间距，不能靠屏幕坐标猜回写位置。
- `controls` / `suggestedEdit`：宏、组件、锁定、约束或变换的控制原因，以及可执行的当前值示例。

跨页重名和错误页明确拒绝；筛选为空不会回落到整页。查询为空本身可合法，写入选择为空则明确失败。

普通批量样式优先使用 `editNodes` 与 `role/within`，精确参数用 `studio_describe({topic:"command",name:"editNodes"})`。当前53个命令/别名均有共用详细契约；属性逐节点、阶段和出口消费仍在审计，不能从命令契约完整推导全部属性语义。

## 看图、探索、验证与交付

截图评审默认返回图片、具体问题和摘要；完整指标与节点快照保存在 `reportPath`，可用 `verbose:true` 读取。语义剧本默认省去整页重复场景，保留每步断言与最终状态；同样可用 `verbose:true` 展开。

关键改稿后调用 `studio_design(action:review)` 并实际查看图片，记录具体节点与问题；前后对照用 `compareWithReviewId`。候选探索使用现有 `candidates/states`，从信息结构、字形、素材与主次关系提出不同方向；不能只用颜色数量表示设计多样性。

至少验证初始态、操作后的反馈、长内容与返回；运行 `studio_scenario` 的 `action/expect`，返回明确的 `executionLayer:studio-semantic`；这是隔离语义执行，且默认语义层不做遮挡/hitTest 校验——通过 ≠ 真实可点。需要遮挡/命中结论时：`hitTest:true` 先用真实浏览器指针重放校验每个点击目标，被遮挡返回 `E_SCENARIO_OCCLUDED`（含 nodeId/occludedBy 遮挡者/stepIndex，语义层不执行该步），浏览器不可用返回 `E_SCENARIO_HITTEST_UNAVAILABLE`（不静默降级），含 navigate/dataset 等浏览器层无法重放的步骤返回 `E_SCENARIO_HITTEST_UNSUPPORTED`；多状态联系图仍用 `studio_design(action:explore)` 的 states（真实浏览器指针）。未知断言与零断言不能算成功。最后 `studio_export(format:rp)` 检查可编辑节点、交互及装饰降级；结构检查、Axure加载、预览、GUI编辑分别记录。

## 失败与恢复

- 属性拼错会返回字段、候选名与行列号；整批未应用。不要根据成功回包猜字号真的变化。
- 写入回包丢失不会自动重发。先读取当前版本与内容，再用原幂等键核对；同键不同内容拒绝。撤销/重做不要盲目再点。
- 新版恢复日志逐笔追加，并记录撤销/重做身份。重启可恢复具备快照的历史；旧版本缺快照或未记录的撤销不能凭空恢复，明确不可撤销且不改文档。
- 复制保存源节点快照，粘贴重新分配后代ID并重映射内部目标。改源后粘贴保持复制时内容；重复粘贴不产生同ID后代。

## 局部入口的能力与边界

节点片段支持可选的内联 `vars:` / `tokens:` 头部、显式根容器、`panel` / `dynamic-panel`（含 `:state` 与 `tabs=[...]` 自动分段切换）、`repeater`（含 `:template` 与 `data=` 数据集绑定）、一等公民原生表单控件（`checkbox`、`radio`、`combobox`/`select`、`listbox`、`textarea`/`input multiline=true`）及全部内置宏（`card`、`stat-row`、`list-item`、`progress-bar`、`nav-bar`、`tab-bar`）；纯装饰节点 `divider` / `spacer` 可省略 `#id`。不支持任意完整语言运算 AST、非 click 事件或 `open-link` 等浏览器受限动作；这些情况明确报错，走现有完整 RP/1 流程。不能从画布的受限入口推导任意原生工程都能无损双向回写。

当前公开 MCP 工具数为 72，其中 13 个 `studio_*` 动词化工具。已有 MCP 进程和已运行 Studio 不自动热更新；用 `runtime_info` 核对运行/磁盘指纹，实际操作本轮参数需要新 stdio 连接与新服务。没有重启已有用户工程，没有公开发布。

## 本轮试用反馈修复

普通节点的 `goto:"pageId"` 会规范成跳页事件；`onClick` 与 `on.click` 使用相同动作校验。`target:{ref:"nodeId"}` 可用于面板与显隐，`toggle` 会执行，未知动作在写入时拒绝。动态面板的 hug 高度取状态高度，不再误取宽度；文本 hug 会容纳最后一行下伸部分。

画布与完整 RP/1 的字号范围统一为 `(0,120]`，Georgia 等非默认字体可写入原生文字，spacer 导出为透明原生几何。是否保持原生编辑、哪些效果栅格化，仍以每次兼容报告为准。像素检测将自身文本框裁切记为 unknown，不再把被裁掉的背景像素误报成 1:1 对比度。新建工程在首次哈希前完成基础组件注册，避免第一次重开在同一版本下改变内容哈希。

## 第二轮反馈后

常用按钮 variant 现在具有可见的默认配色，显式 fill/color/stroke 优先，包括 null。浏览器预演使用 click/input/expect（或click/fill简写），起始页用pageId；语义工具的navigate、面板状态断言等不能直接搬进浏览器states。公开schema提前拒绝不支持的组合。

成功RP/1插入默认只回sourceSpanCount；错误仍给行列定位，verbose展开全部。原生导出的字号测量使用有界精确缓存，保留排版结果；最终字体补丁后的文件与基线一致。返回sourcePath是带资源的resolved RP/1导出快照，权威画布源仍在工程document.json。

长短画板切换后，截图会等待新视口的合成帧；renderedRevision与设计几何检查不能单独证明完整像素画面。复测中的截断原图和修复后的整页图均保留为证据。
