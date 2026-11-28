# RP/1 编译器词表与版本

当前安装包版本 `v0.4.8`。本表由 RP/1 编译器公开词表与 `scripts/rplang/functions.json` 自动生成；运行时可用 `diagnose_prototype({ mode: "capabilities", topic: "summary" | "functions" | "syntax" | "addressing" | "properties" | "all" })` 直接查询。视觉属性的宿主证据见 [四消费面对照](surface-capabilities-matrix.md)。

## 语法版本

- `v0.4.4` 支持同一事件块混排动作、连续条件、嵌套分支和等待后的续体。
- `v0.4.5` 增加原生表单动作短写、同一事件内内联 JSON 动作、弃用提示及带前置守卫的事务。
- `v0.4.8` 统一四端表达式函数真源（25 函数）、消除纯 `=` 字面量误杀与 `rowIndex` 多态寻址、全量错误收集、批量表达式探针与零新增工具自描述能力矩阵。

## 表达式函数总表（四端统一真源）

| 签名 | 返回类型 | 可用上下文 | 说明 |
|---|---|---|---|
| `text(value)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 将任意值显式转换为文本字符串。 |
| `number(value)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 将文本或数值转换为数字（非数字文本回退为 0）。 |
| `fixed(num, digits)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 将数值按指定小数位（0–12 整数字面量）格式化为文本。 |
| `not(bool)` | `boolean` | compile-fold, rp1-runtime, native-axure, studio-html | 对布尔值取反。 |
| `concat(a, b, ...)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 拼接两个及以上参数为文本（非文本参数自动转为文本）。 |
| `lower(text)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 将文本转为小写。 |
| `upper(text)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 将文本转为大写。 |
| `trim(text)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 去除文本首尾空白字符。 |
| `length(text)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 返回文本的 UTF-16 字符长度。 |
| `contains(text, sub)` | `boolean` | compile-fold, rp1-runtime, native-axure, studio-html | 判断文本是否包含指定子串。 |
| `remove(text, sub)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 移除文本中首次出现的指定子串。 |
| `replace(text, from, to)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 将文本中所有匹配的子串替换为目标文本。 |
| `slice(text, start, end?)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 按起止下标截取子串（支持负数下标，end 可省略）。 |
| `substr(text, start, length?)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 从起始下标截取指定长度的子串（length 可省略）。 |
| `left(text, count)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 截取文本开头的 count 个字符。 |
| `right(text, count)` | `text` | compile-fold, rp1-runtime, native-axure, studio-html | 截取文本末尾的 count 个字符。 |
| `abs(num)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 返回数值的绝对值。 |
| `round(num)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 四舍五入取整（与 JS Math.round 语义一致）。 |
| `floor(num)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 向下取整。 |
| `ceil(num)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 向上取整。 |
| `min(a, b, ...)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 返回多个数值中的最小值。 |
| `max(a, b, ...)` | `number` | compile-fold, rp1-runtime, native-axure, studio-html | 返回多个数值中的最大值。 |
| `nowMs()` | `number` | rp1-runtime, native-axure, studio-html | 返回当前运行期毫秒时间戳（与虚拟时钟同步）。 |
| `isOver(widgetA, widgetB)` | `boolean` | rp1-runtime, native-axure, studio-html | 判断同页两个元件边界框是否重叠。 |
| `isNotOver(widgetA, widgetB)` | `boolean` | rp1-runtime, native-axure, studio-html | 判断同页两个元件边界框是否不重叠。 |

## 语法消歧与寻址规则

- **等号字面量**：纯 `"="`（如计算器等号按钮）与 `"= 合计"` 等非表达式前缀自动按字面文本保留；仅当 `=` 后紧跟合法表达式起始符才求值；强制字面量可用 `\=` 转义。
- **中继器行寻址**：`verify_prototype` 支持标准 `{ target: "pick", rowIndex: 0 }` 及内联写法 `pick[0]`、`pick[rowIndex=0]`、`page/items/item[rowIndex=0]/pick`、`items[0]/pick`、`items/0/pick`。
- **批量表达式探针**：`diagnose_prototype({ expressions: ["left('hello', 2)", "round(2.5)"] })` 独立逐条求值，不 fail-fast。

## 元件类型与缩写

`badge`、`box`、`button`、`card`、`carousel`、`checkbox`、`column`、`combobox`、`data-table`、`detail-card`、`divider`、`droplist`、`dynamic-panel`、`form-card`、`grid`、`icon`、`image`、`input`、`kv-list`、`label`、`list-item`、`listbox`、`master-detail`、`nav-bar`、`panel`、`paragraph`、`phone-shell`、`progress-bar`、`radio`、`repeat`、`repeater`、`row`、`searchable-list`、`slider-captcha`、`sparkline`、`stack`、`stat-row`、`tab-bar`、`textarea`、`use`、`when`、`wizard-card`

## 宏

`carousel`、`data-table`、`detail-card`、`form-card`、`kv-list`、`list-item`、`master-detail`、`nav-bar`、`phone-shell`、`progress-bar`、`searchable-list`、`slider-captcha`、`stat-row`、`tab-bar`、`wizard-card`

## 规范动作

`data-add`、`data-clear-filter`、`data-clear-sort`、`data-delete`、`data-filter`、`data-page`、`data-sort`、`data-update`、`disable`、`enable`、`focus`、`hide`、`link`、`move`、`open-link`、`raise-event`、`scroll-to`、`set-check`、`set-option`、`set-panel-state`、`set-selected`、`set-size`、`set-text`、`set-variable`、`show`、`toggle`、`wait`
