# 按节点查询实际消费边界

本地开发快照，2026-10-31。当前词表有294个名称；`supportContractComplete:true` 只说明每格都有来源/权限/消费分类，`completeAudit:false` 明确表示没有逐格完成真实运行验证。不能将类型×属性×出口的排列数写成已通过测试数。`full-rp1` 从实际源语言 Schema 的逐类型字段和条件生成，label.rows/columns/activeState 明确不支持，box 的文字 sugar 及 card 内容参数保留条件。独立 Schema/编译器差分验证另见修复报告。

`studio_describe({topic:"node"})` 只返回节点目录与盘点。指定 `name` 返回少量常用字段；指定 `fields`（最多16项）得到准确的逐字段说明。`operation` 为 `create/edit`，`surface` 可选 `canvas/runtime/native/full-rp1`。CLI使用相同入口：

```sh
node bin/axure.mjs studio describe --topic node --name repeater --fields rows,template,filter,sort --surface native
```

```json
{"topic":"node","name":"card","fields":["title","fontSize"],"operation":"edit","surface":"canvas"}
```

`sourceWrite` 区分允许保存、只读、拒绝和未知。各消费面独立标记 `implemented/partial/unsupported/unverified/metadata/separate-entry`。存在消费者不等于真实画面或Axure宿主验证通过；完整RP/1保留独立原生创作入口，不能从同名字段推断Studio已支持。

`studio_query_nodes` 默认带精简 `capabilities`，说明当前对象的常用字段与后续精确查询。宏展开内容回到所属参数，组件沿用实例覆盖。卡片可用已有RP/1字段titleFontSize调整标题，统计行可用valueFontSize调整数值，单项可覆盖；这些字号参数接受(0,120]的数值。卡片标题的target.propertyMap把text映射到title、fontSize映射到titleFontSize，诊断也返回同一映射。

改card容器fontSize仍不会改变标题：普通属性修改、setText附带样式和editNodes命中这类已确认无效改稿会拒绝整个事务，并建议实际参数。显式子节点仍可正常修改字体。此检查尚未代表所有高级组件路径与全部创建字段均已审计。

原始 `nav-bar/tab-bar/progress-bar/detail-card/data-table/searchable-list/master-detail` 当前没有Studio宏展开；新建时须有显式children，否则明确拒绝空白构件。自身几何和显式children与同名完整RP/1宏是不同能力。导航优先使用已有核心组件实例。查询会说明边界，不再把整个属性词表称为每种节点的可写能力。

## 共享排版与真实字体

`fontSize:"$display"` 引用 `doc.tokens.display` 的标量数值。可先用 `setToken`（`category:"size",name:"display",value:40`）或 `setTokens` 声明；RP/1片段可直接写 `fontSize=$display gap=$space padding=["$space",12]`，复用同一事务和解算。修改共享值会重新度量和绘制所有引用者，源引用保留，显式数值覆盖不受影响。`gap/padding` 同样支持非负数值引用，padding数组可逐项引用。缺失、非数值或越界的引用报 `E_NUMERIC_TOKEN`，整笔事务不写入。此处只支持标量名称，不把数组字号表、别名链或表达式当作数值令牌。

工程 catalog 指定 `source:"project",path:"fonts/deep/custom.ttf"` 时，画布实际加载 FontFace，macOS 服务度量使用同一字体文件；同名字体跨工程切换按工程身份失效缓存。未找到或损坏的字体明确回退并报告。工程包和离线代码包携带被引用的字体、保留子目录，截图确认等待字体加载结果；字体声明本身不是加载证据。独立真字体、改字/预览、删除旧目录后新进程导入和离线代码包均有样本。原生 `.rp` 只保存字体族名，不嵌入字体文件；报告注明需要宿主安装，不能据此宣称 Axure 实际字形已验证。其他系统的工程字体精确度量仍未验证。

## 数据列表与行模板

`datasetOp` 按repeater节点修改真实rows或绑定数据集。`repeaterSetFilter/repeaterSetSort` 决定当前视图，数字按数值排序；共享数据和运行态数据参与同一解算。没有25行静默截断，但当前没有列表虚拟化，规模性能仍须验收。

行模板已参与画布和运行预览：逐行绑定 `=item.field` 或 `${item.field}` 文字后度量，保留模板布局、字体、表面和静态素材。`studio_query_nodes` 可找到唯一模板源，如 `home/words/template/word_label`；改此源更新全部行，绑定公式保留，支持普通事务与撤销。行内独立动作、任意表达式和动态图片字段绑定仍未打通；预览行点击沿用数据行选择。

原生出口保留可编辑Repeater与行模板、导出真实行数据。静态filter/sort和容器on目前没有完整等价的原生转换，兼容报告明确记unsupported；结构三零不能当作这些行为通过。不同页的隐式同名数据集行值冲突会明确拒绝导出，避免后一个覆盖前一个；这不代表所有运行态数据命名问题已经关闭。

本机样本覆盖真实浏览器、模板源改稿、RP9保存关闭重开和原生预览。未据此声明任意模板、GUI手工编辑、其他Axure版本或跨平台全部支持。
