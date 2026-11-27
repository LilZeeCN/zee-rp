# Axure 原生交互预检与交付

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
| `native-countdown` | 双态面板提供节拍，`Now.getTime()` 计算剩余毫秒。验收精确推进到 1250、250、0 ms，覆盖启动、停止和重启。 |
| `native-loop` | 单一递归分支和终止 Case，实现最多 32 步累乘。验收覆盖 99³、2⁵ 和次数超限。 |
| `native-blur-form` | 两个字段各自失焦时触发同一验证事件。提交按钮复用验证。验收覆盖必填、两次输入不一致和纠正后通过。 |

`generate_prototype({ recipe, output, verify: true })` 生成可编辑 .rp 并用官方播放器回放。范例保留同名 `.rp1` 与 `.rp1.interactions.json`，分别存放布局和原生动作、剧本。需要自定义时编辑这两个配套文件，再以 `.rp1` 路径调用 `generate_prototype`。脚本包含 `advanceTime` 时自动启用虚拟时钟，浏览器实际执行的定时动作和 Axure 的 `Now` 使用同一时间轴。
