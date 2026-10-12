# 中继器数据操作

适用于已有 `.rp` 内的真实中继器。round7 已在七行数据上验证排序、筛选、清空排序、增加两行、规则删除和规则修改单列。以下 `scripts/` 相对 Skill 目录；输入输出换成绝对路径，目标名称和列名须从当前文件读取。

## 准备与定位

先运行 `rp-read.mjs --json`，确认页面、触发元件和中继器。列从 Repeater.Data → DataSet.columns → DataSetProp.name / variable-id 读取，不能靠图中显示位置猜列。

研究示例为 `R7`：`First_Name` 是客户、`Last_Name` 是金额、`Score` 是订单号。这是该样本的列语义，不是 Axure 默认业务模型。用户预览验证的初始数据为：

| First_Name | Last_Name | Score |
|---|---|---|
| Alice | 120 | 1001 |
| Bob | 空字符串 | 1002 |
| Alice | 350 | 1003 |
| Carol | 75 | 1004 |
| Dave | 420 | 1005 |
| Bob | 90 | 1006 |
| Erin | 260 | 1007 |

`clone-closure.mjs` 提供 `closureOf/cloneInto` 库函数，需要调用方挂到目标 diagram；不自带 CLI、完整跨包资源迁移或任意列模板生成器。外部 `build-repeater-baseline.mjs` 是研究复现脚本，不是随包依赖。用户从 Axure 原生中继器或已验证模板准备基座后，以下动作完全由随包工具实现。

## 排序、筛选与清空排序

```bash
node scripts/add-interaction.mjs source.rp sorted.rp "排序按钮" \
  --event OnClick --action repeater-sort target=R7 column=Score \
  ascending=false sortType=1 toggle=false removeAll=true

node scripts/add-interaction.mjs source.rp filtered.rp "筛选按钮" \
  --event OnClick --action repeater-filter target=R7 column=First_Name \
  condition=true filter=Alice label=OnlyAlice removeOthers=true

node scripts/add-interaction.mjs source.rp cleared.rp "清空排序按钮" \
  --event OnClick --action remove-sort target=R7 removeAll=true
```

`sortType=1` 用于本轮数值排序。筛选当前验证的是指定列等于 `filter`，须带 `condition=true`；不是任意表达式解析器。当前样本的预览生成器会重写排序 label，清空排序用已验证的 `removeAll=true`，不要按 `.rp` 中的旧 label 宣称清除成功。2026-09-23 的 Quick Win 副本中，筛选及 `remove-filter` 不显式追加刷新时可见更新；在这两类动作后显式追加 `refresh-repeater` 均触发 `TypeError: Cannot read properties of undefined (reading 'length')`。正常 Add Filter 发布后，Axure 预览生成器会自动追加含 `repeatersToRefresh` 的内部 pseudo action。canonical 工具现在明确拒绝独立 `refresh-repeater`；需要更新显示时使用已验的筛选、排序或数据变更动作，不手动追加刷新。

页面自动执行用 `"页面名" --page --event OnLoad` 替换触发按钮部分；原生事件码为 288。页面上下文的 `OnPageLoad` 会兼容映射为 288。跨页同名按钮使用 `--on-page "页面名"`。

## 增加、删除、修改行

```bash
node scripts/add-interaction.mjs source.rp added.rp "新增按钮" \
  --event OnClick --action repeater-add-items target=R7 \
  columns=First_Name,Last_Name,Score "rows=Frank,999,1008;Grace,777,1009"

node scripts/add-interaction.mjs source.rp deleted.rp "删除按钮" \
  --event OnClick --action repeater-delete-items target=R7 \
  column=First_Name value=Bob

node scripts/add-interaction.mjs source.rp updated.rp "修改按钮" \
  --event OnClick --action repeater-update-items target=R7 \
  column=First_Name value=Alice setColumn=Last_Name setValue=CHANGED
```

- 三条命令分别从干净基线生成独立测试件。需要组合时串接新输出；交互是追加操作，重复注入会叠加。
- 增行 `columns` 用逗号分列，`rows` 用分号分行、逗号分单元格；每行必须等长，允许中间空单元格。当前不是 CSV 解析器，不支持值内含逗号/分号或引号转义。缺少数据、重复列名、行列数不齐会报错。
- 当前固定值 CLI 不解析 `[[InputText]]` 这类 Axure 表达式；结构探针确认它会作为普通字面字符串写入，不能用它实现表单输入到新增行的动态绑定。
- JSON 形式现在可把新增行单元格指定为表单控件：`{"widget":"FORM_NAME"}` 会构造 `GetWidgetText` 表达式，`{"value":"1008"}` 写字面值。例如：

  ```json
  {
    "target": "TrigAdd",
    "interactions": [{
      "event": "OnClick",
      "actions": [{
        "type": "repeater-add-items",
        "target": "R7",
        "columns": ["First_Name", "Last_Name", "Score"],
        "rows": [[
          {"widget": "FORM_NAME"},
          {"widget": "FORM_AMOUNT"},
          {"value": "1008"}
        ]]
      }]
    }]
  }
  ```

  动态格按原生结构编码为 StringLiteral `[[LVAR1]]`，并在 `scope` 字典中把 `LVAR1` 映射到 `GetWidgetText` 路径；格式对照的是 [Axure 官方增行教程](https://docs.axure.com/axure-rp/reference/adding-repeater-rows/)随附 `.rp` 真值。夜间续测在 `repeater-dynamic-input-demo-v2.rp` 预览中输入 `OVERNIGHT-MIRA`、`702` 后新增行 `1008 / 702 / OVERNIGHT-MIRA`，原 7 行保留。该 JSON 矩阵只支持 `GetWidgetText` 和字面值，不是通用表达式解析器；行为证据限定该样本和当前 build。
- 行模板元件的 `OnClick` 可添加 `set-text-from-repeater-item`，把本行某列写入外部表单控件。例如：

  ```json
  {
    "target": "ROW_FIRST_NAME",
    "interactions": [{
      "event": "OnClick",
      "actions": [{
        "type": "set-text-from-repeater-item",
        "target": "FORM_NAME",
        "repeater": "R7",
        "column": "First_Name"
      }]
    }]
  }
  ```

  该动作把 `SetWidgetFormText` 的值编码为 `[[Item.First_Name]]`，并登记列的 `variable-id`、`TextVariableIdentifier` 与所属 DataSet。触发元件必须是目标中继器行模板的直接子元件；外部目标是普通具名文本控件。夜间续测在 `repeater-row-backfill-candidate.rp` 点击 Alice、Carol 后，外部表单分别显示 Alice/120 和 Carol/75。行为证据限定该样本和当前 build。
- 删行验证范围为单列等值规则。`column/value` 构造 `[[Item.<列> == '<值>']]`；带引号等需要自行转义的值用明确的 `rule` 和 JSON，仍保留对应 `column` 以登记标识符。
- 改行 `column/value` 选择行，`setColumn/setValue` 保留单列快捷写法。JSON `updates` 可传一个或多个不同列的 `{column,value}`；重复列会拒绝。多列候选将列名、目标列 ID、更新值和「列/值」迷你 DataSet 按同一顺序逐项映射。夜间续测点击 `multi-column-update-candidate.rp` 的更新按钮后，两条匹配 Alice 的行都变为 `Mira / MC-UPDATED`，其他行不变。行为证据限定该样本和当前 build；复杂表达式和多步骤组合另行验证。
- 分页 `set-repeater-page` 的 `pageType` 可用名称或 Axure 枚举数值：`value/0`、`previous/1`、`next/2`、`last/3`；默认 `next`。`page` Literal 保存页值，`pageType=value` 时可设绝对页号，例如 `page="3"`。官方 [分页教程](https://docs.axure.com/axure-rp/reference/repeater-pagination/) 的原生文件中，左箭头 x=50 使用 Previous=1，右箭头 x=217 使用 Next=2；本项目先前把两者写反，旧 `set-repeater-page-candidate.rp` 因此不是有效 Next 候选。校正后的候选在官方九行样本中实测 Next 从 1–3 切到 4–6、Previous 返回 1–3；绝对页号候选跳至第 3 页并显示 7–9 和 `Page 3 of 3`。行为证据限定该样本和当前 build。
- 自定义 `rule` 当前只自动登记一个 `column` 的变量标识符；不承诺多列规则、变量赋值、计算列或嵌套表达式。绝对页号现可构造 `Value=0` + 页值 Literal，但行为尚未预览；按索引删改仍未验证。

用户已在 `repeater-adddel-final.rp` 实测 7→9 行、删除两条 Bob、Alice 金额变为 CHANGED。顺序测试时同时检查唯一订单号，避免只看到行数正确却改错数据。持久化到原型文件或服务器不属于预览数据动作的承诺。

## 结构不变量与白屏排查

- 静态 DataSet 单元格必须具有 `column-id:tag0x11`、`type:tag5=0`、`value:tag8`。`column-id` 对应列的 `variable-id`，不是 DataSetProp 对象 ID。
- **按 column-id 映射值**。原生样本元素列表的顺序可以与列定义顺序不同；不能固定假设第一个元素对应第一列。
- AddItems 动作的内嵌 DataSet 使用表达式单元格：`type=3`，`value` 引用 StringLiteral，Literal 的 `repeater-scope` 指回内嵌 DataSet。不要把静态三字段示例原样套到所有动作单元格。
- AddInfo 的 `actual/add` 为并行 GUID 引用列表，分别指向目标列身份和新增 DataSet 的列身份。Delete/Update 的规则使用 `TargetRepeaterScope` 指回真实中继器数据集，并登记 `TargetTargetItem.<列>`。
- 维持 UI 真值的对象根流布局与完整对象/GUID 登记。round7 白屏已确认遗漏单元格字段；仅改变 Row/Element 顺序仍会失败，不能把顺序猜测当作这次 NRE 的结论。

典型症状是“编辑器能打开、预览只有 document.js、页面 data.js 缺失”，日志指向 `MbwO.ebwJ.mH4K()`。检查**全部新增单元格**而不只比较原三行；往返编码相同只证明解析器自洽，不能证明必需字段完整。修复后重新生成预览，核对实际七行及列值。

证据在外部研究目录 `axure-exp/research-rp/round4/verification/round7-20260922/`：`PROGRESS-20260922-pm.md` 的 NRE、终版状态、增删改终记；`repeater-truth-saved.rp` 为 UI 真值，`repeater-baseline-verify.rp` 和 `repeater-adddel-final.rp` 为行为样本。
