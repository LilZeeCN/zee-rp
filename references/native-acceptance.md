# RP/1 原生逐步复验

这条流程将同一份操作计划分别交给 `ReferenceRuntime` 和真正由 Axure RP 9 导出的预览。比较当前页面、元件文字、指定变量、中继器全量数据、可见行顺序/分页和面板状态；额外支持手写业务预期。首次不一致即保留现场并失败退出。它不把离线模拟通过当作真实预览通过。

## 1. 准备源码和计划

计划使用稳定逻辑 ID，输入与点击分开。每个场景从同一入口重新载入；需要验证跨页保留状态时，将整个业务过程放在同一个场景中。

```json
{
  "observe": {
    "widgets": ["desk/total_label", "desk/recipient_input"],
    "variables": ["total", "pieces"],
    "repeaters": ["desk/supply_list"],
    "panels": []
  },
  "scenarios": [{
    "id": "filtered-total",
    "steps": [
      {"click": "desk/apparel"},
      {"click": "desk/supply_list/item/plus", "rowIndex": 0}
    ],
    "assert": {"variables": {"total": 27, "pieces": 4}},
    "captureAt": [0, 2]
  }]
}
```

`rowIndex` 是当前可见顺序的零起始行号，不是原始数据索引。元件观察支持当前页面的非行模板文字/输入；行数据通过 `repeaters` 比对，不能把多个同名行元件当一个元件。缺少目标、多个匹配、未知观察项都会失败。当前步骤仅支持 `click`、`input`，不覆盖拖拽、悬停、滚动或所有键盘交互。

生成新的输出目录；已有目录和 RP 文件不会覆盖：

```sh
python3 scripts/rp_acceptance.py prepare \
  --source /absolute/path/source.rp1 \
  --plan /absolute/path/plan.json \
  --out /absolute/path/new-acceptance
```

得到 `prototype.rp`、`bundle/`、`oracle.json`、原始 `plan.json` 与构建输出。准备前先检查计划；源码有变化必须重新准备。手写 `assert` 是独立业务预期，不要从模拟器结果机械抄出。

## 2. 真实宿主往返

用工具 `gui_roundtrip(source, output, version=9)` 或 Axure GUI 将 `prototype.rp` 复制到新文件，保存、关闭、重开；记录 `guiSaved/closed/reopened`。再在 Axure 的 Publish → Preview 打开真实预览，读取刚生成的本地 URL。

不要写死旧的端口和时间目录；同时打开多个文档时，预览可能分配不同端口。脚本先核对入口页标题，再从本次预览外壳的 iframe 读取实际页面地址。GUI 往返工具不包含预览或手工编辑，不能据此把 `preview/guiEdited` 标成 true。

## 3. 重放与留证

先按本机 ego-browser Skill 执行 `ego-browser skill` 并读取完整说明；创建或复用同一目标的 TaskSpace，记录其 ID。将真实 URL 和 TaskSpace ID 交给脚本生成器：

```sh
python3 scripts/rp_acceptance.py browser-script \
  --oracle /absolute/path/new-acceptance/oracle.json \
  --url 'http://127.0.0.1:32768/start.html#p=实际页面' \
  --space-id 5 \
  --run-dir /absolute/path/new-native-run \
  --out /absolute/path/new-runner.mjs \
  --minimize
ego-browser nodejs < /absolute/path/new-runner.mjs
```

URL 和 ID 都是示例，必须替换为实际观察值。不要另起浏览器或导入 Playwright 代替 Ego Page。脚本在加载前安装错误监听；输入通过真实键盘路径清除 RP 9 原生提示文本，读取输入值时排除提示文本，避免测试工具造成假差异。

通过时保存 `report.json`、预言轨迹和 `passed.png`；指定的 `captureAt` 额外保存检查点截图。失败时保存：

- `first-failure.json/png`：首个差异、预期、实际状态和已执行步骤。
- `replay-plan.json`：失败前缀，直接重新准备即可重放。
- `minimal-plan.json`、`minimal-failure.json/png`：启用缩减后，删除无关步骤并再次实测的反例。

缩减仅针对同一路径的模型/原生差异，不对手写业务预期或操作错误强行缩减。每个候选都重新运行参考模型和原生页面。`oneMinimal=true` 表示再删任意单步都会失去该差异，不代表全局最短；达到 64 次试验上限会明确返回 false。

失稳或操作错误也会失败，不能跳过后计算通过率。查看报告的 `kind`，先区分产品差异、业务预期差异和测试操作错误。源码摘要不一致会拒绝运行，输出目录不会覆盖；证据应与安装文件摘要和 Axure build 一并归档。

## 证据范围

2026-10-20 在 macOS / RP 9.0.0.3754 验证了购物结算、输入、页间返回、行隔离、双态面板及 12 组视觉组合。旧总价原生反例从 4 步缩成 2 步，并再次得到预期 27/4、实际 15/3；修复版通过。未覆盖元件隐藏/禁用状态的逐项比对、所有行内视觉状态、通用页面自动发布、RP 11 或 Windows。GUI 编辑验收仍需另外在 Axure 执行并保存证据。

固定题库见 [30 题 v1](../benchmarks/rp1/v1/README.md)。新增验证方式不能替代后续 90 次冷启动和独立用户试用。
