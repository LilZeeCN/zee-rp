# AI 自由构图与多状态预演

本机 2026-10-27 开发快照扩展现有 `studio_design(action:explore)`，不新增工具。AI 自行编写不同节点树或改稿命令，服务端在隔离工程中执行、真实点击、截图并拼图；不会按审美分选稿，也不会修改源工程。需要全新 MCP 连接；旧服务器需另启新实例。

## 起稿与交互

先 `studio_open_project`，再 `studio_stage({intent:"learning"})`；返回 `authoring` 中的节点、事件与验收示例。`addNode` 可一次添加包含 children 的子树，任意组合 stack 自由定位与 row/column、hug/fill 流式布局。只用默认模板换色不会产生不同构图。x/y 相对父内容盒；空白手机 home_screen 默认 padding=[60,0,0,0]，子节点 y=0 已落在屏幕 y=60。先查父 padding，避免重复加60；需要背景铺满时可把该 padding 设0，再将正文留在顶部60px安全区以外。

事件标准形状是 `on:{click:[{type:"show",target:"answer"}]}`。兼容 `onClick:[...]` 与 `interactions:{click:[...]}`，进入文档后归一化；同次请求的别名相互冲突会拒绝。隐藏父容器会同时隐藏后代；显示父容器恢复后代各自的显隐，不必逐个 show。显隐在设计、语义运行态和浏览器预览中共用解析结果。

语义验收使用 `action/expect`，不是 `type/assert`：

```json
{"steps":[
  {"expect":{"visible":{"answer":false,"meaning":false}}},
  {"action":"click","target":"reveal","expect":{"visible":{"answer":true,"meaning":true}}},
  {"action":"click","target":"again","expect":{"visible":{"answer":false}}}
]}
```

未知字段、未知动作、空期望、整段没有任何断言均返回 `E_SCENARIO_STEP`，预检失败不执行前面的动作。返回 `assertionCount`；故意错误的断言必须失败。MCP schema 列出支持的动作和期望键。`studio_scenario` 是语义证据；`hitTest:true` 会先用真实浏览器指针重放校验点击目标（被遮挡返回 `E_SCENARIO_OCCLUDED`，不执行语义层），否则真实浏览器证据来自下面的候选预演或独立实点。

## 一次比较不同构图和状态

```js
const result = await studio_design(action:explore)({
  projectDir: '/abs/project', pageId: 'home', baseRevision: 2,
  candidates: [
    { id: 'type', label: '大字与留白', commands: typeCommands },
    { id: 'split', label: '上下分区', commands: splitCommands },
    { id: 'flow', label: '渐进阅读', commands: flowCommands }
  ],
  states: [
    { id: 'recall', steps: [{expect:{visible:{answer:false}}}] },
    { id: 'revealed', steps: [{action:'click',target:'reveal',expect:{visible:{answer:true}}}] },
    { id: 'remembered', steps: [
      {action:'click',target:'reveal'},
      {action:'click',target:'remember',expect:{text:{feedback:'已记住'}}}
    ] }
  ]
});
// 实际查看返回的 MCP 联系图后，由当前 AI 选稿。
const chosen = result.candidates.find(c => c.id === 'split');
await studio_command({projectDir:'/abs/project', ...chosen.applyWith});
```

`typeCommands/splitCommands/flowCommands` 是 AI 编写的普通 `studio_command` 命令数组，并非内置三种模板。每次1–4个候选、最多3个状态；省略 states 时验证并截图初始页。每个状态从初始页重置，必须写出到达该状态所需的完整路径和至少一条有效断言。

默认保留源页内容、事件、语义节点的有效继承显隐和动态状态；纯装饰图形允许显隐变化，隐藏父容器导致文字提前泄露仍会拒绝；漏内容、删行为、改运行数据或波及别页会拒绝候选。显式 `preserve:{content:false}` 或 `interactions:false` 可用于有意重写，需由调用者自行确认任务要求。跨动态状态搬移节点可能改变作用域，需按行为改动处理。

每个候选先跑初始页像素检查，再逐状态语义预检与真实浏览器鼠标操作，等待字体和图片完成后截图。`frames[].verification` 为 `real-browser-pointer`；失败状态保留日志。初始页没有 error 且所选状态全部通过时才返回 `applyWith`。它是复用原有事务的快捷参数，不是审美通过或全应用验收。应用时仍检查当前 baseRevision，过期候选不能直接提交。

源工程版本与内容哈希在探索前后相同。隔离项目、原图、联系图、逐状态证据和 result.json 存在工程 `design-explorations/<id>/`，可复查。实现依赖本机 Chromium 与 Python Pillow。仅初始态做像素审查；其余状态目前是实点断言和截图，不代表所有状态像素检查。原有 axes 参数扫描仍为离线几何排序；不要与 candidates 模式混称。

## 当前验证

专项测试 `npm run test:studio-ceiling` 覆盖继承显隐、事件别名、未知脚本/负对照、真实浏览器点击、候选隔离、内容/行为保留和版本冲突。独立创作试用与最终证据见本机 `/Users/lilzee/axure-exp/outputs/canvas-ceiling-20261027/REPORT.md`。原生结构、Axure 宿主、GUI 编辑和用户视觉认可分别报告。
