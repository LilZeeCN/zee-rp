# Axure 原生交互预检与交付

## 从业务逻辑生成原生交互

同一份交互程序可以交给 `generate_prototype` 生成新原型，也可以交给 `rp_command(add-interaction)` 写进现有 RP9 模板。单页用 `program`，多页用 `programs`。生成时也可从同名 `.rp1.interactions.json` 读取程序、`sharedRoutines` 和 `steps`。已有 `items` 文件仍可继续使用。

编译器将线性动作和可内联的条件写入原触发元件。需要跨动作跳转时，整页共用一个隐藏调度元件，原生 Case 保留程序出处。成功结果的 `nativeProgram` 逐页列出触发入口、循环和辅助元件数量。

下面是同一页面的乘方按钮。用户填写底数和次数，程序负责边界、循环、成功显示与非法输入提示。

```json
{
  "page": "loop",
  "on": {
    "evaluate": {
      "click": [
        {"set": {"$factor": "=number(@base)", "$product": 1}},
        {
          "repeat": "=number(@count)",
          "limit": 32,
          "do": [{"set": {"$product": "=$product * $factor"}}],
          "then": [{"set": {"@out": "=text($product)"}}],
          "else": [{"set": {"@out": "次数须在 0–32 之间"}}]
        }
      ]
    }
  }
}
```

- `if / then / else` 顺序执行条件块。 `match / cases / else` 按值选择动作块，适合运算符、状态名和菜单命令。
- `routines` 声明可复用过程，`call` 调用。可在输入框失焦、提交等不同事件复用同一过程。直接递归或互相调用的环会在编译前报告。
- `repeat / limit / do / then / else` 在入口计算一次次数。次数必须是 0 到 `limit` 之间的整数。零次直接执行 `then`，非法次数执行 `else`。
- `while / limit / do / then / else` 在每次迭代开始前重新判断条件。条件为假执行 `then`。用完次数且条件仍为真时执行 `else`。
- 两种循环的 `limit` 默认 32，最大 1024。超过 32 次或循环体中有等待动作时，编译器自动在每轮让出执行。传入 `intervalMs`（1 到 30000）可让每轮执行前等待指定毫秒数。定时逻辑可以直接写在循环里。
- 页面事件中直接写入的旧式等待沿用单次运行语义。需要在同一页面同时运行、取消或重启多个流程时，用 `tasks` 定义具名任务。
- `bind` 将一组元件与参数绑定到同一过程。计算器的 10 个数字键共用一个数字过程，四个运算键共用一个过程。
- `fixed(value, digits)` 按小数位格式化，`number(fixed(value, digits))` 可用于继续计算。 `nowMs()` 读取 Axure 的毫秒时间。浏览器的 `advanceTime` 可以精确验收它。
- 构建计划记录从生成的交互到程序的指针，Axure Case 名也标出程序出处。详细源文件留在输出旁，以便审阅或改稿。

```json
{"recipe":"native-calculator","output":"calculator.rp","verify":true}
```

## 同页异步任务

每个任务名对应一个独立的运行状态。用 `start` 启动任务，用 `with` 覆盖本次启动的 `locals` 初值。执行到等待点时，其他任务和页面按钮可以继续工作。调用同一个 `routine` 时，各任务读取自己的局部变量。页级 `locals` 与 RP/1 全局变量可用来显式共享状态。

```json
{
  "page": "demo",
  "tasks": {
    "timer": {
      "policy": "restart",
      "locals": {"label": {"type": "text", "value": "就绪"}},
      "do": [{"wait": 250}, {"set": {"@status": "=$label"}}]
    },
    "refresh": {
      "policy": "ignore",
      "do": [{"wait": 150}, {"set": {"@refreshed": "刷新完成"}}]
    }
  },
  "on": {
    "start": {"click": [{"start": "timer", "with": {"label": "到期"}}]},
    "stop": {"click": [{"cancel": "timer"}, {"set": {"@status": "已停止"}}]},
    "reload": {"click": [{"start": "refresh"}]}
  }
}
```

- `restart` 是默认策略，重新启动时用新参数和局部初值替换正在等待的那次运行。`ignore` 在任务运行期间跳过重复启动，同时保留当前参数。
- `cancel` 可在页面事件中使该任务之后的等待恢复失效。停止事件可直接设置提示文字或按钮状态。其他任务保持各自的运行进度。
- 任务可使用 `wait`、带间隔的 `repeat` / `while` 和普通 RP/1 动作。编译器按任务和等待时长给原生唤醒排队，每次唤醒只消费自己的队列位置。最新等待拥有恢复权，取消或重启会撤销旧等待的恢复权。全部任务共用一个隐藏元件。
- 同时长的原生定时器按提交顺序交付。具名任务里 0–3 ms 的等待统一以 4 ms 调度，避免浏览器的嵌套定时器钳制改变队列顺序。[HTML 定时器规范](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers)
- 用 `generate_prototype({recipe: "native-async-tasks", output: "tasks.rp", verify: true})` 运行完整示例。也可把同一份程序通过 `rp_command(add-interaction)` 写入已有 RP9 项目。

## 多页复用与现有模板

用 `sharedRoutines` 让多个页面复用同一验证或显示逻辑。每页通过 `targets` 指向自己的元件，通过 `locals` 声明独立的状态。共享过程中的 `$value` 和 `@out` 按调用页解析。原 RP/1 顶层变量仍可用于有意共享的状态。

```json
{
  "sharedRoutines": {
    "publish": [{"set": {"@out": "=text($value)"}}]
  },
  "programs": [
    {
      "page": "orders",
      "locals": {"value": {"type": "number", "value": 0}},
      "targets": {"out": "orders_status"},
      "on": {"confirm": {"click": [
        {"set": {"$value": 1}},
        {"call": "publish"}
      ]}}
    },
    {
      "page": "registration",
      "locals": {"value": {"type": "number", "value": 0}},
      "targets": {"out": "registration_status"},
      "on": {"submit": {"click": [
        {"set": {"$value": 2}},
        {"call": "publish"}
      ]}}
    }
  ]
}
```

写入现成模板时，把上面的 `programs` 与 `sharedRoutines` 放进 `rp_command({command: "add-interaction", params: {source, output, programs, sharedRoutines, preflight: "official"}})`。将页面 ID 换为模板中的页面名或基线 ID，使用 `targets` 为触发元件和动作目标声明别名。别名值可用原生名称、`{"guid": "…"}` 或 `{"logicalId": "page/widget"}`。没有基线的模板也可通过 `rp_inspect(view: "locate")` 获取 GUID 后写入。现有全局变量默认按文本处理，`params.variables` 可补充类型声明。

程序默认保留模板已有事件。如需替换同一元件上的同名事件，显式传 `replaceEvent: true`。预检检查整批程序，提交生成新 .rp 与逻辑 ID 基线。保留基线可按相同入口更新程序并复用原调度元件。页面载入时的内部复位与已有载入事件共存。

## 写入前检查

`rp_command` 的 `add-interaction` 支持 `action: "preflight"`。它会在副本上构造交互并执行与提交相同的检查。执行成功后，使用同一批参数、改为 `action: "run"` 提交。预检无需传 `output`，提交显式文件时须指定一个新输出文件。

```json
{
  "action": "preflight",
  "command": "add-interaction",
  "params": {
    "source": "calculator.rp",
    "target": { "logicalId": "calc/equal" },
    "replaceEvent": true,
    "preflight": "official",
    "interactions": [{
      "event": "OnClick",
      "cases": [{
        "description": "显示八位小数内的结果",
        "condition": "always",
        "actions": [{
          "type": "set-text",
          "target": "calc/result",
          "text": "[[(0.1 + 0.2).toFixed(8) * 1]]"
        }]
      }]
    }]
  }
}
```

- `params.preflight: "auto"` 默认先做静态检查，公式存在时按文件版本调用本机 Axure。确证的编译错误会阻止提交。本机引擎不可用时，结果显式标记 `official.status: "unavailable"`。
- `"official"` 要求官方编译通过。`"static"` 仅执行离线检查、目标解析和原生结构验证。CLI 与 `rp_command(args)` 使用静态检查。
- `condition` 支持 `if`、`else-if`、`else`、`always`。前两种需要 `when`，后两种省略 `when`。旧的 `isNewIfGroup` 写法继续有效。对同组重复条件、兜底后分支和明确互斥等式会给出诊断。
- 拼接数字字符串用 `a.concat(b)`。数值相加可通过 `a * 1 + b * 1` 显式转换。RP9 实测 `Math.round(...)` 会生成 STO 错误。`.toFixed(n)` 返回定长字符串，业务需要继续做数值运算时可乘 `1`。
- 对已有文件执行 `rp_inspect({ path, view: "interaction-lint" })`，可读出分组、死分支、公式定位和全局变量状态。变量状态区分未用、只写、只读取初值和读写。

## 官方导出与匿名交付

`export_prototype` 写入新的 HTML 目录，`interactionCompilation` 报告官方编译扫描状态与错误数。错误含页面、元件名与官方 GUID、事件、Case 名与序号、动作序号、表达式、页数据路径。存在 RP/1 基线时，诊断也会标注逻辑 ID。导出的文件保留用于核查。`verify_prototype` 在已证实有 STO 错误时于浏览器回放前失败，直接给出这份错误清单。

- 会话中使用 `axure_save({ as: "final.rp", stripWidgetNames: true })`，或在显式文件模式使用 `rp_patch({ source, output, op: "strip-widget-names" })`。操作清空元件大纲的名称，保留动作、变量、面板状态和原生 GUID。
- `rp_inspect`、`rp_patch`、`rp_command(add-interaction)` 和 `verify_prototype` 支持 `{ "logicalId": "page/widget" }` 和 `{ "guid": "…" }`。GUID 使用 `rp_inspect(view:"locate")` 返回的 `guid`，`recordGuid` 标识所属记录。数字 `{record,id}` 绑定到当前文件版本，用于浏览器验收时同时提供原 `.rp`。
- 清名前后的同一个逻辑 ID 验收剧本可直接复用。若 .rp 经 Axure 另存而旁边没有基线，用 `verify_prototype({ rp, baseline, steps })` 指向原基线。用 `export_prototype({ rp, baseline })` 可将对照映射一起保存在 HTML 目录。
- HTML-only 验收自动读 `zee-widget-map.json`。若交付目录无需附带逻辑 ID，可用 `includeWidgetMap: false` 导出。清名处理的是大纲元件名，页面文字、交互 Case 名及基线中的源码信息仍供创作侧使用。

## 可运行范例

| `prototype_recipe` ID | 交互模式 |
| --- | --- |
| `native-calculator` | 按键表驱动连续四则运算，带十进制舍入和除零恢复。 |
| `native-countdown` | 双态面板提供节拍，`Now.getTime()` 计算剩余毫秒。验收精确推进到 1250、250、0 ms，覆盖启动、停止和重启。 |
| `native-async-tasks` | 两个倒计时同页并行，共用更新过程。验收覆盖参数隔离、运行中重启、取消、忽略重复启动、旧等待到期和取消后再次启动。 |
| `native-loop` | 一个 repeat 块表达最多 32 步累乘。验收覆盖 99³、2⁵、2³²、零次、非整数和次数超限。 |
| `native-blur-form` | 两个字段各自失焦时触发同一验证事件。提交按钮复用验证。验收覆盖必填、两次输入不一致和纠正后通过。 |

`generate_prototype({ recipe, output, verify: true })` 生成可编辑 .rp 并用官方播放器回放。范例保留同名 `.rp1` 与 `.rp1.interactions.json`，分别存放布局和交互程序、剧本。需要自定义时编辑这两个配套文件，再以 `.rp1` 路径调用 `generate_prototype`。脚本包含 `advanceTime` 时自动启用虚拟时钟，浏览器实际执行的定时动作和 Axure 的 `Now` 使用同一时间轴。
