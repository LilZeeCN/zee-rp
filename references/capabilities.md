# 能力与待验证表

更新：2026-10-06。测试环境为 macOS / Axure RP 11.0.0.4137；所有通过项限具体样本，不推定其他 build、平台或任意容器可用。

> 命令清单、CLI 参数定位与登记证据标签见 [自动生成的命令表](commands-generated.md)。
> 此表由注册表与离线回归生成；具体能力边界仍以本文件正文和验证流程为准。
> 发布命令表由 `node scripts/pack-release.mjs -o <新目录>` 生成；研究回归生成器不随发布包。
> 阶段 6 已移除随包空白模板，当前入口读取 `AXURE_BLANK_TEMPLATE` 或用户本机缓存；正文的模板来源与 GUI 样本仍是历史证据。
> 2026-10-07 MCP 接口增强已关闭：42 个工具、链式会话、存量 RP 命令省路径、批量文字事务和内置结构验证；用法见 [README](../README.md)。这是调用接口变化，正文的原型能力与样本边界不变。

当前有行为证据的主线包括静态视觉、多页/母版、条件交互、中继器数据与分页、表单控件、图片状态、现存变量赋值、文本/交互精确改写。分离布局树与三个单页变量新副本已各自通过 GUI 保存关闭重开；MouseDown 按住状态和 Selected 选中/取消也已在 ImageBox 副本通过。`raise-event targetPage=true` 已在当前页 OnLoad 计数 1→2→3、同一页面未重载的样本通过，并回归既有元件目标路径。

新增 `set-listbox-options.mjs`，ListBox 的 North/East 默认多选、真实键盘选择 South/West及单选对照均经 GUI 往返后通过；另在 single 对照的新副本中，通过原生 GUI 开启多选并设置 North/East，保存关闭重开后保留；预览真实键盘选 South/West 通过。原生 Table writer 的指定 4×4 输出已通过 GUI 往返与逐格预览。新增 `clone-native-connector.mjs` 与 `set-connector-anchors.mjs`：默认四边连接点键已由原生 UI 样本核对，单端/双端挂接、两端自由及旧候选修复各有指定样本通过编辑、保存重开、重新预览。编辑器中目标移动会带动线端；预览中的 Move 不会带动线端，原生 UI 双端对照与生成件结果一致。跨文档继承样式可能不同，不能承诺全局样式逐字保持。

自适应基本/V768/V1024/基本标签在 Quick win - sample 页直接点击，GUI_TEST_RESIZE 宽度依次为 600/360/480/600，保存关闭重开后同序列复验通过。运行时 `scroll-to`、`apply-style` 的纯色填充、`set-repeater-items-per-page` 和 `set-adaptive-view` 在 2026-10-05 新样本中已按原生真值修复并通过 GUI 保存关闭重开后的实际预览。旧结论的类名或结构错误已经被这些样本推翻；独立 `refresh-repeater`、`Concat` FCall 保持拒绝。研究证据见 continuation-20260924/RESULTS.md 最后 2026-10-05 续测章节；研究目录不随 Skill 分发。结构、加载、行为和 GUI 编辑分别判定，动作分支数量不作覆盖率。

## 能力边界

| 能力 | 工具及实际实现 | 已有证据层级 | 使用边界 |
|---|---|---|---|
| 静态布局、文字、图片、折线、饼图、矢量 | `axvg.mjs` 的 spec 展开与剪贴板 | 项目有画布和预览记录 | 每次产物仍需对照；图片是图片元件，图形和文字可独立编辑 |
| 渐变、阴影 | `axvg.mjs` spec 的 fill 支持 linear/radial 渐变、透明色标和归一化 from/to；rect/circle 的 border.fill 可渐变，rect/circle/shape 的 shadows 支持内外阴影 | 2026-10-05 生成粘贴件及独立 GUI 保存关闭重开副本，线性、径向、多色透明色标、渐变边框、内外阴影及矢量组合在画布和预览中保留；六个目标在文件中仍为 VectorShape 并保存原生样式字段 | 当前验证为矩形、椭圆和一个菱形；阴影 spread=0，文本阴影、多重同类型阴影未验。角度渐变导入被降为线性，工具明确拒绝；不承诺全部 Axvg 效果或格式 |
| `.rp` 读取、加工与空白工程 | `rp-records`、`parse-payload`、`rp-read`、`create-blank-project.mjs` | 空白工程 CLI 输出与 Axure UI 保存的原生空白件逐字节相同；`rp-read` 确认 1 页、0 元件、0 状态，并递归列出页面中的 PanelState / repeater 行模板及简单文本 | 空白文件是随包的 RP 11.0.0.4137 macOS 模板复制，不是从零序列化器；未压缩 manifest 写入尚不支持 |
| 页面复制与新建空白页 | `duplicate-page.mjs` 按名称复制已有页面；`create-blank-page.mjs` 把随包的原生空白 Page 加到已有 `.rp` | 两页演示工程增为 3 页后，Axure RP 11 页面列表可见新页；新页画布为空，保存/关闭/重开仍可见，原 52 个元件、6 个交互、10 个动作与两页摘要保持；Axure Training `Prototype Starter.rp` 的 8→9 页候选也已双击空白页并保存关闭重开，9 页与原 88 元件、22 交互、27 动作保留。样本的 `rp-read` 均为 0 dangling refs / 0 problems | 两个来源都只在 RP 11.0.0.4137 macOS 样本验证；不能推定其他版本；`duplicate-page.mjs --by-index` 研究分支曾被拒读 |
| 母版复制与实例上页 | `create-master.mjs`、`place-master.mjs` | 历史母版面板/切页/渲染记录 | 母版须已存在；实例上页按 Page 记录索引定位 |
| 已有动态面板切状态 | `set-panel-state` | 历史常用动作链有预览记录 | 目标须有真实状态包；新创建面板还受下一行限制 |
| 创建动态面板 | `create-panel-clone.mjs` 克隆模板并插入状态包 | `cpv4-fixed.rp` 加载、切页、双状态 DOM；2026-09-22 `panel-fixed-night.rp` GUI 进入内部编辑态；2026-09-23 在 `quick-win-generated-panel.rp` 的 State A 用 Axure GUI 加入文本并保存、关闭、重开后在大纲中确认仍存在；状态内容导入见下两行 | 工具已清理模板孤儿对象/缓存、修正 manifest 父子关系与记录顺序；三处修复中各项因果贡献未分别证明。任意嵌套修改未验 |
| 有内容的多状态面板 | `create-panel-clone.mjs --copy-template-states` 克隆原生 `Hours Panel` 状态内容；`set-panel-state` 可切换到 State B | `multi-state-state-b-content-roundtrip.rp` 的 State B 含 TextBox（`Text in State B`）与 Button；Axure 保存、关闭项目、重开后画布和大纲仍有两控件，再次发布预览并点击切到 State B，输入值及按钮可见；`rp-read` 为 0 dangling refs / 0 problems | 只覆盖该模板面板及两控件组合；任意布局、任意状态、自动填充和跨状态包写入未验 |
| 向面板状态导入布局 | `fill-panel-state.mjs` 把一个 Page 的控件闭包导入空 PanelState；`--append` 向已有状态追加，保留原内容；嵌套面板、中继器和母版见下三行 | 2026-10-06 Visual/Form 布局、四种表单控件、本地 SetWidgetFormText 与 GUI 文本改稿保存重开通过。追加内嵌 PNG 后原四控件及复选框交互保留，切出切回图片和值保留；空状态图片导入也通过。独立 GUI 副本将图片 x460→480 后保存关闭重开，图片、尺寸及旧交互保留。图片阶段 8 文件结构 0 问题，图片字节与旧状态对象核对通过 | 图片须在本地原生样式中含 Stream/Extension；已验指定 PNG，不推定全部图片格式/状态资源。默认仍拒绝非空状态，追加拒绝与已有元件同名；显式替换/删除见下一行；默认保护旧内容，母版范围见下文；不复制连接线包。拒绝未验动作及外部作用域；库继承样式、自动尺寸见下文，任意组合未验 |
| 面板状态删除与替换 | `remove-panel-state-content.mjs` 按顶层名删除或 `--all` 清空；`fill-panel-state.mjs --replace` 保留状态身份并导入新内容 | 2026-10-07 原生删除图片真值与离线删除的状态 body 一致；删除 PNG 后剩余表单与动作保留，清空 Form 后仍能切回 Visual，替换新四控件表单后动作/值保留，三件均保存关闭重开。独立 GUI 改默认值 REPLACED_GUI 后保存重开和预览也通过。12 文件/94 审计及 39 拒绝/回归/CLI 检查全过，证据 `panel-replace-20261007/evidence/panel-replace-final-audit.json` | 删除不再可达的私有闭包，保留共享引用与状态 GUID；剩余交互仍引用目标则拒绝。按顶层名或显式 --ids 定位；嵌套面板、母版实例及中继器的已验清理范围见下一行。默认仍保护非空状态；append/replace 互斥 |
| 复杂状态内容删除与替换 | 同一 remove-panel-state-content.mjs 递归清理被删面板的子状态包，删除共享母版实例而保留定义，清除本地中继器/内联 DataSet；fill-panel-state.mjs --replace 导入新内容 | 2026-10-07 原生嵌套/母版/中继器三份删除真值；7 个生成件均 GUI 保存关闭重开。三层面板替换保留表单/PNG/动作；删第二母版实例后第一实例动作及状态返回正常；中继器同名替换 7→9 行、删两条 Bob、更新两条 Alice 与状态返回正常。独立 GUI 把替换后文本改为 COMPLEX_REPLACED_GUI，重开和预览保留默认值/原交互。22 文件/147 审计与 26 拒绝/回归/CLI 全过，证据 panel-complex-remove-20261007/evidence/complex-remove-final-audit.json | 目标限 Page 顶层面板的指定状态及已验嵌套/共享无覆盖母版/本地三列中继器组合。保留外层状态 GUID；物理移除无活跃引用的子状态包和对象，母版定义不回收。活跃跨包对象/状态/DataSet 引用、缺状态包或未知包条目拒绝。带实例覆盖的删除、Master 所属状态删除、外部资源、任意组合仍未验 |
| 面板按内容自动尺寸 | 新增 `set-panel-fit-to-content.mjs`，按真实记录/元件 ID 写 native boolean `fit-to-content` | 2026-10-07 原生 GUI 开关真值、生成件开关保存重开与实际状态切换通过；只读 DOM 实测 Form 380×279→Visual 900×608→Form 380×279，复选框与文本值保留。离线关闭开关与 CLI 回归也通过 | 当前 GUI/行为证据为 Page 顶层 CONTENT_PANEL 的指定 Visual/Form 组合；PanelState/Master 定位有代码但未 GUI 验，负坐标、更多嵌套/滚动/定位组合不外推；不改状态内容坐标 |
| 嵌套动态面板内容导入 | 同一 `fill-panel-state.mjs` 递归复制引用的 PanelState 包，共享 GUID 映射；各状态包仍登记在 owning Page 或 Master 下 | 2026-10-06 原生 GUI 包裹面板真值；两层/三层生成件保存关闭重开后，最深层 Visual/Form 切换、Checkbox→INSIDE_STATE_OK、状态切回保留值和 PNG 均通过。三层 GUI 副本把最深层 TextBox 默认值改为 NESTED_GUI，保存重开后的默认值及原交互通过。8 文件结构 0 问题，状态/面板/文本身份和 PNG 字节保留 | 已验两层/三层和上述交互组合；本地文本赋值及明确状态切换已验，拒绝缺状态包、外部状态引用与未验作用域。中继器的新范围见下一行；任意深度、next/previous/动画参数、母版覆盖其它格式/其它依赖格式与连接线、跨文档继承资源及自动尺寸不外推 |
| 面板内中继器布局导入 | `fill-panel-state.mjs` 复制本地 Repeater、内联 DataSet、行模板与固定值增行/单列等值删改交互；允许本地行 `SetWidgetRichText` | 2026-10-06 原生 GUI 包裹 R7 真值及直接/双层嵌套导入件保存关闭重开后，7→9 行、删除两条 Bob、两条 Alice 金额改为 CHANGED 均通过；切空状态再切回保留修改。GUI 数据表把第一行 Alice 改为 GUI_CUSTOMER，保存重开后按新行值只更新另一条 Alice，改名行保留 120。8 文件结构、元件/列身份、实际行数据和旧面板/图片回归均通过，见 `panel-repeater-20261006/evidence/panel-repeater-final-audit.json` | 已验该三列七行业务样本，数据按 column-id 映射；表达式仅本地 `[[Item.<列>]]` 与单列字符串等值规则，scope 字典须空，DataSet 与 repeater-path 必须本地。外部变量/目标、复杂规则、排序筛选/分页交互导入及其它列类型未验；原生包裹时 AutoFit 按钮会缩至内容尺寸，不承诺原任意几何保真 |
| 面板内母版导入 | `fill-panel-state.mjs` 复制 ReferenceDiagramObject 引用的原生 Master 及已验依赖链，登记 MasterPackageInfo/母版树/Page 直接依赖，子定义先于父定义；母版内面板状态挂在 owning Master 下，共享 GUID 映射 | 2026-10-06 直接母版、面板内母版、母版内 Visual/Form 面板三件保存关闭重开后本地文本动作、内外切状态及值/PNG 保留通过。双实例 GUI 修改共享母版默认文本 MASTER_GUI 后保存重开，两实例默认值更新，运行时仅改变被点击实例。13 文件结构 0 问题，75 检查全部通过；旧中继器/嵌套面板/图片追加回归通过。证据 `panel-master-20261006/evidence/master-final-audit.json`。随后两层/三层母版依赖及依赖母版内 Visual/Form/PNG 组合保存重开后的交互/状态切换通过；被引用内层母版 GUI 默认文本改为 DEPENDENCY_GUI 后往返和原交互通过。依赖阶段 10 文件/66 检查全过，证据 `master-dependencies-20261006/evidence/dependency-final-audit.json` | 保留原生 tag 0x10/0x13 类名和 GUID 引用；NULL 类名 0 不转为字符串。dependencies 只接受原生 MasterPackageInfo/type 2 对；拒绝缺包/注册、循环依赖、母版重名、LoadedRdoPackages/LoadedScreenshotPackages 和其它依赖格式；ObjectOverrides 新范围见下一行。已验上述母版、两层/三层链与表单/面板组合。本地动作仍按导入校验限制，外部 rdo-path/作用域、其它实例覆盖格式、跨文档继承资源及任意组合未验 |
| 母版实例覆盖导入 | `fill-panel-state.mjs` 保留已有原生 ObjectOverrides 的文字和内嵌 PNG，并共享实例/定义/目标 GUID 映射 | 2026-10-07 双实例 CHECK_A/RADIO_A 与 CHECK_B/RADIO_B、依赖母版内 NESTED_OVERRIDE/红 A 图片覆盖均在生成件保存关闭重开后保留；单实例动作不串值，内外切状态保留值/图片。独立 GUI 副本仅改第二标签 CHECK_GUI_B，另一实例不变；依赖母版覆盖改 NESTED_GUI 后重开和预览保留图片/原交互。9 文件/105 审计和 38 拒绝/回归检查全过，证据 `master-overrides-20261006/evidence/overrides-final-audit.json` | 只保留 Base 视图下 VectorShape/Checkbox/RadioButton 文字标签、ImageBox 内嵌 PNG；覆盖目标须为被引用母版及其自有 PanelState 中的直接元件，rdo-path/repeater-path 为空。拒绝外部目标/资源、非 Base ViewId、未知字段及覆盖路径的其它引用。独立写入器见下一行；表单默认值、样式/组件视图、跨层路径和其它图片格式未验 |
| 母版实例覆盖写入 | 新增 `set-master-overrides.mjs`，按记录/实例 ID 与目标名或 GUID 创建/更新文字覆盖、清除已有覆盖，或写入内嵌 PNG；不改共享定义 | 2026-10-07 双实例 CHECK/RADIO 文字分别写入且动作隔离；更新第一 CHECK、清除第一 RADIO 恢复原标签，第二实例不变。依赖母版内 WRITER_NESTED/红 A PNG、原交互及状态切回通过；GUI 改成 WRITER_GUI 保存重开和预览亦通过。9 文件/75 审计、34 拒绝/回归/CLI 检查全过，证据 `master-override-writer-20261007/evidence/writer-final-audit.json` | 仅 Base 视图直接 VectorShape/Checkbox/Radio 标签、ImageBox PNG；目标须属被引用 Master/自有状态，路径为空。Page/Master/指定 PanelState 实例的标签创建、更新、清除及独立 GUI 覆盖改稿已验；依赖母版内 PNG 更新/清除已在独立 GUI 样本通过。2026-10-07 追加 18 文件/116 检查，见 panel-writers-20261007/evidence/panel-writers-final-audit-v2.json。清除保留旧路径定义；其它视图/样式/表单默认值/深层路径未验 |
| 原生表单控件和库页组件 | `clone-library-widget.mjs`、`clone-library-page-content.mjs`、单选 `set-combobox-options.mjs`；新增 `set-listbox-options.mjs` | TextBox/Checkbox/Radio 和 Field multiplier 预览通过；ComboBox 列表 GUI 编辑与往返通过。ListBox 四选项默认 North/East 经保存关闭重开保留，实际键盘操作同时选择不相邻 South/West；单选对照 North→West；独立原生 GUI 开启多选、设置 North/East，保存关闭重开后预览再选 South/West 通过 | ListBox writer 只处理唯一页/唯一原生 ListBox 的非空字符串选项，`multiple` 与零起始 `selectedIndices`；原生 GUI 开关创建及默认项通过，浏览器鼠标修饰键多选尝试未通过，实际键盘多选通过。ComboBox 多选、任意容器与跨版本未验 |
| 原生 Table | `set-native-table.mjs` 改写一个已有原生 Table 的矩阵、行高和列宽，扩容时克隆原生单元格 | 原有 4×4 及 2026-10-06 新 1×1、1×5、5×1、5×6 样本均经 GUI 保存关闭重开与逐格预览；覆盖缩减、单行、单列和新增 14 格。独立 GUI 副本将新增 R5C6 改为 `GUI_56`，保存重开及预览保留；11 文件结构无问题，矩阵、尺寸和身份检查通过 | 每格须一个文本 run；依赖已有原生 Table，未验证合并单元格、富文本格或所有尺寸/build。缩减后未引用的旧格定义保留，GUI 保存也如此；不承诺物理清理 |
| 原生连接线 | `clone-native-connector.mjs` 克隆原生 Connector 与端点闭包并保留默认点键；`set-connector-anchors.mjs` 定向挂接/脱开两端 | 原生左右/上下 UI 真值；生成单端/双端件只移动目标后，保存重开的 SVG 线端跟随；自由线可独立移动。只改点键的旧候选修复也通过。随机键对照不跟随 | 只处理页面直接子级的 VectorShape 与四边默认点；自定义点/嵌套容器拒绝。预览 Move 不跟随线端，原生与生成双端样本结果一致；不承诺跨文档继承样式保真 |
| 表达式函数库 | `ix-actions.mjs` 将可用 `{fn,args}` 递归序列化为 `Axure:Expr:FCall`；拼接用 `StringLiteral` 的 `[["A".concat("B")]]` | `GetWidgetValueLength` 与嵌套 `ToLowerCase(GetWidgetText(...))` 条件预览分别显示 `LENGTH_OK`、`LOWERCASE_OK`；`expression-concat-syntax-candidate.rp` 点击拼接按钮显示 `CONCAT_OK`，副本已在 GUI 保存 | `Concat` 作为 FCall 报 `undefined.apply`，现由生成器明确拒绝；`.concat()` 的此字面量条件只在当前 build 和样本通过。保存副本经 Axure 重启并重开后，三个按钮再分别输出 `LENGTH_OK`、`LOWERCASE_OK`、`CONCAT_OK`；其他函数需分别验证 |
| 已有 `.rp` 文本精确改写 | `set-widget-text.mjs` 按 Page 内唯一名称、Page/PanelState 记录索引 + 对象 ID，或记录索引 + 容器路径 + 容器内唯一名称定位；支持单个 RichText run、按 `--run` 选择一个多 run 片段，或 TextBox `TextBlock.text` | `multi-run-text-gui-edit-candidate.rp` 的加粗片段在 Axure GUI 改写并保存重开后仍保留粗体；`container-name-text-candidate-gui.rp` 中 `Field multiplier(行模板)` 的 `Name input` 也通过 GUI 改写保存重开。结构候选仍可用 `rp-read` 核对 | 此工具只改一个既有片段；整段重排使用下述独立 writer |
| 整段富文本重排 | `set-widget-richtext.mjs` 重写原生 RichTextBlock 的段落与 runs，支持字体、字号、粗体/斜体/下划线/删除线、纯色、左右中对齐；同步控件样式的统一/混合属性标志 | 2026-10-06 六段/17 run 样本经原生编辑器、保存关闭重开和预览保留格式；独立 GUI 改 Blue→Blue GUI、给 Italic 加下划线、增加中文段落，保存重开和预览通过。第二样本的 Arial/Times New Roman/Helvetica 混合字体和统一字号/颜色/B/I/U/删除线也通过。逐字符格式比较无差异；11 文件结构无问题，元件/文本身份保留 | 依赖已有原生段落/run 与 MyStyle 模板，不从零创建文本块；已验 Page 与指定 PanelState 中 VectorShape；PanelState 六段/17 run、真实 GUI 改 Blue→Blue GUI、保存重开及实际 DOM 格式亦通过，追加 18 文件/116 检查证据见 panel-writers-20261007。列表、行距、超链接及其它格式未开放。字体缺字时 Axure 可替换字体；AutoFit 可在 GUI 编辑后调整位置/高度 |
| 替换或移除已有交互 | `add-interaction.mjs --replace-event` 替换唯一活动 Case/Action 树；`remove-interaction.mjs` 按事件类型移除活动事件，或按事件、Case 序号和 Action 序号移除一个活动动作 | 替换候选预览位移 +80 且未重复执行旧动作；GUI 副本将 Move 从 80 改为 81 并保存重开。移除动作空 Case 与移除事件候选在 GUI 保存重开后保持，预览也无 Trace/位移；重复事件类型、缺失事件和越界序号会拒绝 | GUI 往返仅覆盖指定 Move、空 Case、缺失 OnClick 样本；移除操作从活动树和 node-table 断开引用，但旧事件/Case/Action 定义仍留在 payload，也未物理清理 |
| 中继器本体克隆 | `clone-closure.mjs` 提供引用闭包库函数；研究目录的 `build-repeater-baseline.mjs` 建 7 行业务数据基线（不随包） | **2026-09-22 round7 实证**：7 行数据（OrderId 1001-1007、重复客户名、空金额）预览完整渲染；单元格三字段（column-id/type/value）修复后 0 NRE；**同日增删改行三动作预览实证全过**（见动作分组） | **坑**：Element 缺 column-id/type 会让生成器 NRE 整页白屏（编辑器却能开）；该样本的 elements 顺序 [Score,First,Last]，重写值按 column-id 映射，不能推广固定数组顺序 |
| 自适应视图 | `add-adaptive-view.mjs` 单集合（Base+子视图）+ 页面 GUID 绑定 + 覆盖写入 | **2026-09-23 GUI 复验**：视图集保存/关闭/重开后仍在；预览可选基本/V768/V1024，覆盖和点击交互运行。2026-10-05 新副本直接点击基本/V768/V1024/基本，GUI_TEST_RESIZE 宽度为 600/360/480/600；保存关闭重开后同序列通过。详见续测记录 | 原生标签直接点击已验；仅 macOS / Axure RP 11.0.0.4137 / Quick Win 副本，不推定其他发布配置、build 或 Windows。页面 AdaptiveViewSetId(tag17) 指向页面 GUID 表中的视图集身份 GUID；FitToContent 元件（中继器）不显示宽度覆盖 |
| 元件命名 | `name-widget.mjs` 按 Page 序号与对象 ID 修改 name-block | 2026-09-22 表单/触发器命名进入了后续预览验证链 | 不改显示文本；数字序号与其他 CLI 的记录索引不同；页名模式有歧义，见 [离线工作流](rp-workflow.md) |
| 条件与多 Case | `add-interaction.mjs --json` 构造 BinaryExpr/Case；`side()` 支持已验 `{fn,args}` 及方括号内 `.concat()` 字符串表达式 | A/B/C 三分支、长度、小写转换及 `[["A".concat("B")]] == "AB"` 均在指定样本预览通过；后者输出 `CONCAT_OK` | `Concat` FCall 不是当前 build 的运行时函数，生成器现在拒绝它并指向字符串表达式；不推定其它函数支持 |

证据层级逐级独立，详见 [验证流程](verification.md)。`rp-read` 中没有问题、日志没有新增异常、DOM 存在，都不能替代实际交互和编辑态检查。

## 动作分组

实现入口为 `scripts/ix-actions.mjs`。事件枚举有 45 个名称；动作分支包含别名、部分实现和拒绝分支，不能把数量当作覆盖率。以下列出全部现有动作名及其可承诺范围。

| 动作名 | 实现与证据 | 尚需确认 |
|---|---|---|
| `show`、`hide`、`wait`、`move`、`set-panel-state` | 有常用预览动作链记录 | 对具体目标和参数仍需验证；历史链不能证明所有组合 |
| `set-opacity` | 已修正字段；收尾报告记录 `regall2-v3` 链通过预览 | 单独验证中间透明度及时间点，不仅观察最终隐藏 |
| `set-size`、`set-position`、`rotate` | **2026-09-21 预览实证（cond9-actions.rp）：尺寸 300×150、绝对移动、45° 旋转均按参数生效** | 对其他元件类型的通用性未逐一验 |
| `bring-to-front`、`send-to-back` | **2026-09-21 预览实证：Axure 用 z-index 管理层级（front→+1003，back→-1002），不是 DOM 顺序** | 多容器/面板内层级未验 |
| `set-text` | **2026-09-21 负面实证：对 VectorShape 无效**（实现走 SetWidgetFormText，仅表单文本域适用，文本不变） | 需文本域目标重验；目标元件类型必须匹配 |
| `link` | 外部 URL 跳转有早期预览记录 | **2026-09-22 页内链接预览实证**（重建链成功跳转第三页并 200 渲染；目标页 package GUID 登记进第一页 GUID 表并逐槽复核）。第二页投毒环境下第二页链接仍预期 404（环境问题） |
| `toggle` | 2026-09-21：visible→hidden（display:flex→none） | 更多初始状态及目标类型未逐一验 |
| `enable`、`disable`、`toggle-enabled` | 2026-09-21/22：禁用后点击无效、启用后恢复；toggle-enabled 亦有屏蔽→恢复实证 | 更多元件类型未逐一验 |
| `focus` | 2026-09-22 对 TF1 文本域的预览记录 | 目标须可聚焦；不推定所有图形元件可用 |
| `set-panel-order` | 2026-09-22 对 PNL1 的叠放层级切换实证 | 需真实面板和对应参数；不等同于任意容器重排 |
| `set-variable` | 按现存全局变量 GUID 构造 `SetGlobalVariableValue`；原生真值与字面赋值、跨页读取已有证据 | 计数 1→2、另一变量 Source42、TextBox 两次修改后的值三份新副本于 2026-10-05 各自通过保存关闭重开后的预览；只覆盖现存变量、指定格式与当前 build，其它作用域和创建变量未验 |
| `set-rich-text-from-variable` | 生成 `GetGlobalVariableValue` + `TextVariableIdentifier` 的文本表达式 | 2026-09-24：`var-set-direct-variable-roundtrip.rp` 在 Axure 保存、关闭、重开后重新预览，按钮先将 `DemoValue` 赋为 `Clicked!`，再把 `[[DemoValue]]` 写到文字元件；画面从 `DemoValue: Initial` 变为 `DemoValue: Clicked!`。只覆盖这个组合样本，不代表其他作用域或格式文本已验证 |
| `set-check`、`set-selected` | 历史 CB1/RB1 勾选与 DL1 列表选项通过；ImageBox 用 `set-check checked=true/false`（SetCheckState）选中/取消，GUI 往返后 Selected 图像保留与恢复通过 | `set-selected` 使用 SetSelectedOption，是列表值语义，不能用它触发 ImageBox Selected；其它元件类型未逐一验 |
| `raise-event` | 默认 `IsPage=true`；既有 OnClick/MouseOver 元件事件链保留。新增 `targetPage=true` 使用原生 Page 哨兵路径；`page-raise-canonical-roundtrip.rp` 经 GUI 往返后计数 1→2→3，iframe URL/timeOrigin 不变。元件目标 OnClick 回归也通过 | 页面模式不能同时给 `target`；只证明当前页 OnLoad（288），其他页面/母版/事件未验。旧 null、空 Paths、实际 Page GUID 负例保留 |
| `set-image` | Normal/MouseOver/Disabled 有既有证据；新 MouseDown 副本经 GUI 往返后捕获按住时 p2.svg 红图，松开回悬停、移出回 Normal。Selected 副本用 SetCheckState 选中后移出仍为 p3.svg，外部取消后回 Normal，再选仍有效 | 只覆盖此 ImageBox 与状态序列；槽在 set-image 动作运行后应用。Selected 触发用 `set-check`，不使用列表值函数 `set-selected`；参数见 [离线工作流](rp-workflow.md) |
| `repeater-sort`、`repeater-filter` | column-id 已读**真实列 GUID**；filter 类名 `Axure.InteractionAddFilterToRepeaterAction`（点号） | **2026-09-22 round7 双路径实证**：页面 OnLoad(288) + 按钮 OnClick 均生效（sort 降序内部状态 [7..1]，filter 剩 2 行 [1,3]）。**坑**：页面级载入交互必须 event-type 288(OnLoad) 不能用 320；生成器会重写 add-sort 的 label 为派生态 |
| `repeater-add-items`、`repeater-delete-items`、`repeater-update-items` | round7 按 UI 真值重写；`repeater-adddel-final.rp` 用户预览：新增 2 行（7→9）、删除两条 Bob、Alice 金额改为 CHANGED。本轮 JSON AddItems 采用官方样本的 `[[LVAR1]]`/`scope`/`GetWidgetText` 编码；JSON `updates` 支持多列数组 | 固定值增删改、动态 AddItems、多列更新都在限定样本预览通过。动态输入新增 `1008 / 702 / OVERNIGHT-MIRA`；多列更新让匹配的两条 Alice 行都变为 `Mira / MC-UPDATED`。删除仍限单列等值规则。完整参数与格式见 [中继器操作](repeaters.md) |
| `set-text-from-repeater-item` | 行模板元件事件里读取 `[[Item.<列>]]`，通过 `SetWidgetFormText` 写入外部具名文本控件；登记列 GUID 与 DataSet scope | `repeater-row-backfill-candidate.rp` 点击 Alice/Carol 行后，外部输入框分别显示 Alice/120 与 Carol/75。完整参数与限制见 [中继器操作](repeaters.md) |
| `close-current` | 元数据推断的动作构造 | **2026-09-23 预览通过**：点击关闭当前测试预览标签页；不外推为关闭浏览器窗口或其他窗口策略 |
| `refresh-repeater` | 当前 build 的内部 pseudo action；canonical `ix-actions.mjs` 已明确拒绝直接构造 | 原生 GUI 和[官方动作列表](https://docs.axure.com/axure-rp/reference/actions-list/)无独立刷新项；正常 Add Filter 发布 JSON 自动追加含 `repeatersToRefresh` 的 pseudo action，且筛选预览有效。此前显式 `.rp` 动作与字段变体都在 `events.js:358` 报 `undefined.length`；现在生成器前置拒绝，避免交付点击崩溃的文件 | 需要视觉更新时使用已验的筛选、排序或数据变更动作，由 Axure 编译器触发刷新；不能承诺独立无副作用刷新。若将来版本提供原生动作再单独研究 |
| `remove-sort`、`remove-filter` | kebab 字段真值：Info=`{remove-all,label}`/`{remove-all,filter-name}`；壳=`{repeater-paths, remove-sort-infos}` | **2026-09-22 round7：清空排序用 removeAll=true 通过。2026-09-23：单独 remove-filter 在 7→2→7 样本通过，未显式追加 refresh。** 按原 label 移除排序仍可能因生成器改写 label 而失败；refresh 组合的 NRE 见上行 |
| `expand-collapse-tree` | 按原生 UI 真值写 TreePaths/ExpandCollapseInfos；根/非根、多树隔离既有样本通过；分离布局市场部分支于 2026-10-05 新副本经 GUI 往返后收起/展开渠道组，另一树不变 | 只覆盖指定布局与当前 build；原 v2 重叠样本保留为对照，其他容器未验 |
| `set-repeater-page` | 按官方 `axure-docs-repeater-pagination.rp` 校准动作壳、Info 与 Literal；`pageType=value/0, previous/1, next/2, last/3`，默认 Next；页值 Literal 可写绝对页号 | `set-repeater-page-corrected-candidate.rp` 预览 Next 为 1–3→4–6、Previous 返回 1–3；`set-repeater-absolute-page-candidate.rp` 跳至第 3 页并显示 7–9。限定官方九行样本通过；早先反向映射候选保留作负例 |
| `set-repeater-dataset` | 明确拒绝；旧命名实际尝试每页数量动作，并不代表替换整个数据集 | 分页数量使用新动作 `set-repeater-items-per-page`，不得把分页能力写成数据集整体替换 |
| `set-repeater-items-per-page` | 原生真值类为 `Axure:InteractionSetItemPerRepeaterPageAction` / `Axure:SetItemPerRepeaterPageInfo`（Item 单数）；Literal 的 TargetRepeaterScope 指向目标 DataSet。原生 3→5 行、生成 `count=2` 经 GUI 往返后 3→2 行均通过 | `target` 须为中继器，`count` 为正整数；`noLimit=true` 于 2026-10-06 经 GUI 保存关闭重开后点击 3→9 行通过；动态表达式未验。只覆盖官方九行分页样本 |
| `set-adaptive-view` | 按原生 `Axure:InteractionSetAdaptiveView`（无 Action 后缀）写视图身份 GUID。生成件经 GUI 保存关闭重开，点击 V768 后宽度 480→360，点击 `view=base` 恢复 600 | `view` 按当前页面绑定的视图集查名称；仅验证 V768/base 与此 Quick Win 样本；`auto=true` 于 2026-10-06 在无工具栏独立页面经 GUI 往返后 V1024→V768→自动恢复 V1024 通过。带预览工具栏时原生和生成件均未立即恢复，保留此发布模式限制 |
| `link-frame` | 已有构造分支 | **2026-09-23 预览通过**：单独触发器把 InlineFrame 导向可访问的本机测试 URL，iframe 显示 `FRAME_TARGET_LOADED`；未验证任意远程/跨域目标 |
| `scroll-to` | 原生与生成单动作样本经保存关闭重开，实际点击使 scrollY 0→1040，SCROLL_TARGET 从 y=1600 进入 y=560 | 已验 `direction=vertical easing=none`；水平/双向、动画与嵌套滚动容器未验 |
| `apply-style` | 正确类名为 `Axure:InteractionApplyStyle` / `Axure:InteractionApplyStyleInfo`，内含原生 Style。原生白色与生成 `fill=#FF3366` 经 GUI 往返后预览产生对应填充 CSS（rgba(255,51,102,1)） | 目前 spec 支持纯色填充；`clearPrevious=true` 于 2026-10-06 经 GUI 往返后原色→红色→原色通过；其它样式属性尚未开放。原生颜色弹窗曾报 MXPopupWindow 清理异常，不能据此判断动作不可保存 |

## 验收状态与保留项

保留原 ID 便于续接。此表记录项目已有样本的验收状态；脚本后续改动须按对应能力重新验证，不能把历史通过直接当作当前版本验收。

| ID | 当前状态 | 后续范围 |
|---|---|---|
| V1 | ✅ 中继器 7 行预览及数据列绑定；round7 NRE 已修复 | 新模板/列类型分别验收 |
| V2 | ✅ 当前 GUID 保留实现生成的测试件经 Axure 保存重开；本机预览断点覆盖及后续追加交互通过；新副本原生基本/V768/V1024/基本标签直接点击及 600/360/480/600 宽度覆盖在保存重开后通过 | 其他发布配置/build/Windows 未验证 |
| V3 | ✅ If/ElseIf/Else、变量直连显示、长度/小写函数条件及 `.concat()` 字符串表达式条件在指定预览通过 | `Concat` FCall 被拒绝；其它函数、变量格式/作用域及更复杂条件未闭环 |
| V4 | ✅ 限定中继器数据/分页、图片五类已验状态、元件 OnClick/MouseOver 与当前页 OnLoad raise、树根/非根/隔离及分离布局有行为证据 | 独立 refresh-repeater 不支持；其它对象/容器/状态组合仍须分别验 |
| D1 | ✅ 克隆面板的双状态预览与 GUI 进入内部编辑态 | 状态子元件编辑、保存重开见 D2 |
| D2 | 已有 State B、空白页、ComboBox、改稿、跨页变量及新 R1–R4、图片状态、Page raise、ListBox、4×4 writer、连接线各有指定 GUI 往返证据；连接线还做了实际形状移动；ListBox 原生 GUI 创建多选配置与自适应标签直接点击另在新副本保存重开后通过 | 预览 Move 连接线不跟随，限定原生对照已确认；任意布局/尺寸/格式不外推 |

## 历史证据位置

- `continuation-20260924/remaining-closure-20261005/evidence/final-audit.json`：22 份本轮相关副本的最终 SHA-256、修改时间、结构检查与受保护文件哈希；同目录 I1/I2/E1/M1/C/T1/A1 JSON/PNG 是当前行为证据。原生输入记录为 `native-operations-resumed.json`；用户授权后的 macOS 输入补证见 `native-script-actions.json`。M1 原生真值对照为 `M1-native-ui-truth-comparison.json`，自适应直接标签切换为 `A1-native-labels-verification.json`；失败对照仍保留。

研究目录 `axure-exp` 不随 Skill 打包，需在当前环境定位后读取。资料缺失时报告“历史记录所述，原证据当前不可访问”，不要虚构复验。

- `research-rp/round4/verification/continuation-20260923/RESULTS.md`：自适应视图保存重开、基本/V768/V1024 预览覆盖与追加交互；同文件后续章节记录本轮剩余动作 GUI 回归、动态面板 GUI 编辑保存重开及精确失败/未判定项。该记录当时未确认编辑器画布小标签；2026-09-24 目视确认存在，2026-10-05 续测新副本已直接点击并在保存重开后复验覆盖。
- `research-rp/round4/verification/continuation-20260924/RESULTS.md`：原生空白工程/页、表单控件/库页克隆、动态增行/回填、分页、多列更新、交互替换/移除、refresh 字段变体负面结果、树节点根/非根/多树边界、State B 切换、`raise-event` OnClick/MouseOver 目标事件通过样本及 Page OnLoad 目标负面样本；后续补记含 Table/Connector、State B 子元件、函数条件与标签存在性验证。
- 同一续测记录另含变量赋值和直连显示行为复验，以及 Axure 强制退出后的重启/重连。Table/Connector 候选在 Axure 加载、预览、保存后重开；变量直连和 State B 子元件的 GUI 保存关闭重开已在同一副本通过。

- `research-rp/round4/verification/round7-20260922/PROGRESS-20260922-pm.md`：按最后的“终版状态”“终记”“补记”读取，开头阶段表尚有旧待办。包含 NRE 修复、288 页面载入、排序清除、自适应绑定、增删改行和双态切图的用户验收记录。
- round7 样本：`repeater-baseline-verify.rp`、`repeater-click-final.rp`、`repeater-truth-saved.rp`/`repeater-adddel-final.rp`、`setimg-truth-saved.rp`/`setimg-dual-final.rp`、`native-pageload-truth.rp`、`repeater-adaptive-final.rp`；最后一项来自旧槽位覆盖实现，只能证明历史样本，不证明当前工具生成件已通过 GUI 保存重开。叠加交互时不要把旧件作为基座。
- `HANDOFF.md` 第六、十节：09-22 round6 汇总；其中仍有旧估计和过宽结论，冲突时回到具体样本、脚本和以下结果记录。
- `research-rp/round4/verification/continuation-20260922/RESULTS.md` 第 1–5 节：GUID/动作拒绝修复、三 Case 点击实证；第 6–7 节：round6 阴性实验与 26 触发器重建。`actions-page1-condition-candidate.rp` 是三分支行为样本，`actions-page1-26-final.rp` 是后续重建件。
- `research-rp/round4/verification/round5-20260922/FINDINGS.md` 第 1–16 节：共享 View.Id、UI 对照、round6 基础样式写入及空预览视图列表。
- `continuation-20260922/build-26-triggers.mjs` 是依赖绝对研究路径和固定临时文件的复现脚本，会删除已存在的输出；不纳入日常 Skill CLI，不直接用它改客户文件。
- `research-rp/round4/verification/V-RESULTS-2026-09-21.md`：一至九节 jev-cu 轮全程；**第十节第二轮收尾（09-21 深夜→09-22）**——面板断点根因与独立复核、修复与 GUI 编辑态复验、actions-page1.rp 构建与加载失败二分定位、预览重建链 7/15、自适应工具重写与 envNotes。
- `research-rp/round4/verification/final-tests-20260921/panel-diff/`：面板/自适应全部结构证据（32 文件）；`actions-batch2/`：动作验证构建链与重建链 + evidence/ 28 项。
- `research-rp/round4/final-verify/RESULTS.md`：历史 scroll-to/apply-style 失败处置与 regall2-v3；2026-10-05 capability-expansion 的原生保存真值与运行时实证已覆盖其拒绝结论。
- `research-rp/round4/VERIFY.md`：各模块的证据层级与 GUI 面板错误；其中“完全确证”措辞超过部分行的实际覆盖，本表按证据层级收敛。
- `research-rp/round4/verification/notes.md`、`evidence/`：懒加载假阳性、原版崩溃与截图日志。
- 旧 `REPORT-FINAL.md`、研究历史和旧脚本注释仅作过程参考。修正后的动作链不能作为被删动作有效的证据。
