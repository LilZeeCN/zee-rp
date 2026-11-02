# RP/1 原生表单与交互样式

2026-10-30 本机开发快照；目标为 macOS / Axure RP 9。这是完整 `generate_prototype` / `proto.mjs generate` 编译器能力，不表示 Studio 局部 RP/1 入口已支持这些节点。

## 控件声明

```text
radio #seller_all [160x32] "全部" group="seller" checked=true
radio #seller_self [160x32] "自营" group="seller" checked=false
checkbox #shipping [160x32] "包邮" checked=false
combobox #price [280x40] options=["全部价格","0-50","50-200","200以上"] selectedIndex=0
listbox #choices [280x120] options=["一","二","三"] multiple=true selectedIndices=[0,2]
```

`droplist` 是 `combobox` 的别名。以上分别生成真实 RadioButton、Checkbox、ComboBox 和 ListBox；原有 `input` 仍生成 TextBox。模板读取使用者本机 RP9 的 `Default.rplib`，不把 Axure 元件库打进发行包。

`group` 定义单选互斥组；`checked` 定义勾选初态。列表 `options` 是非空字符串数组，`selectedIndex` 从 0 开始。ListBox 默认单选；多选使用 `multiple=true`，`selectedIndices` 可为空，且不能与 `selectedIndex` 同时声明。`disabled=true` 设置禁用初态。

## 取值、交互与重置

`@checkbox`、`@radio` 读取布尔勾选状态；`@combobox` / `@listbox` 读取当前选项文字；`@input` 读取文字。RP9 的列表取值函数只返回首个选中项，不能用 `@listbox` 取得多选数组。

```json
{"type":"set-check","target":"shipping","checked":false}
{"type":"set-check","target":"seller_all","checked":true}
{"type":"set-option","target":"price","value":"全部价格"}
{"type":"set-text","target":"result","text":"='包邮=' + text(@shipping) + '；价格=' + @price"}
```

值支持 RP/1 表达式。`onChange` 按类型编译为 TextBox 的 `OnTextChange`、单选／复选的 `OnSelectedChange`、列表的 `OnSelectionChange`。`enable` / `disable` 与表单 `focus` 可用。

底层 `add_interaction` 的 `set-selected` 仍表示列表选项；RP/1 使用 `set-option` 表达该动作，避免与普通元件的 Selected 状态混淆。

## 原生状态样式

```text
button #tab [160x44] "商品" selected=true selectionGroup="tabs" styles={"hover":{"fill":"#DBEAFE","color":"#1D4ED8"},"selected":{"fill":"#2563EB","color":"#FFFFFF"}}
  +onClick [{"type":"set-selected","target":"tab","selected":true}]
input #search [320x44] value="" styles={"hover":{"stroke":"#64748B"},"focused":{"stroke":"#2563EB"},"disabled":{"fill":"#F1F5F9"}}
```

`styles` 支持 `hover`、`selected`、`disabled`、`focused`，每态可覆盖 `fill`、`stroke`、`color`、`fontFamily`、`fontSize`、`fontWeight`、`radius`、`strokeWidth`、`opacity`。支持普通 label / paragraph / button / badge 与表单控件。它写入原生 MyStyle 状态图，不靠复制矩形模拟。普通元件用 `selected` 设置初态、`selectionGroup` 设互斥组、`set-selected` 切换运行态；单选／复选优先使用 `checked`，与 `selected` 同时声明时必须一致。

四页可运行范例：[native-forms.rp1](../examples/rp-language/native-forms.rp1)。定向检查：`npm run test:forms`。

## 验证边界

参考模拟、原生结构、Axure 保存重开和原生浏览器行为分别验收，三零不能代替行为。原生控件保留源码顺序及父 Layer，避免覆盖后续清空按钮。当前不扩展 Repeater 行内原生表单；不承诺 RP11、任意状态属性组合或新增控件／状态样式的 GUI 改稿可无损导回源码。原生生成与 Studio 的画布消费能力应分别判断。
