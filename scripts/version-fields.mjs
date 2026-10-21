// Axure RP 9 / RP 11 动作与信息对象的字段差异表。
//
// 数据来源：两版 Axure 安装目录自带原生样本 (.rp / .rplib) 的实测键集与值 tag，
// 不是我们的 writer 输出。生成器与原始对照见
//   rp9-compat-20261016/patch/build-action-field-table.mjs
//   rp9-compat-20261016/evidence/action-fields.json
//
// 已实测的差异（RP 9 原生 vs RP 11 原生）：
//   Axure:EnableDisableWidgetsInfo   enable        RP9 bool / RP11 int（同名不同型，且值语义不同）
//   Axure:FadeWidgetInfo             RP9 有 vertical；RP11 没有，改用 scale/anchor/背景模糊/自定义压缩
//   Axure:SetPanelStateInfo          RP11 多 enter-scale/exit-scale/enter-anchor/exit-anchor/
//                                    compress-distance-type/custom-compress-value
//   Axure:InteractionCase            RP9 IsEnabled:bool / RP11 Disabled:bool（名字与极性都相反）
//   Axure:InteractionEvent           RP11 多 Disabled、variable-id
//   Axure:Interaction*Action（动作壳） RP11 多 Disabled
//   Axure:InteractionApplyStyle(Info) 仅 RP 11 有；RP 9 的 get_TypeName 标签全集里不存在
//
// 边界：本表是「原生样本里出现过的键」。写入我们自己的值是否正确仍属结构级结论，
// 宿主行为（RP 9 打开、预览、保存重开）必须另行验收。

// 目标 RP 9 时必须去掉的键（RP 11 新增）
export const RP9_DROP_KEYS = {
  'Axure:FadeWidgetInfo': ['compress-distance-type', 'custom-compress-value', 'page-background-blur',
    'scale', 'scale-hide', 'scale-anchor', 'scale-hide-anchor'],
  'Axure:SetPanelStateInfo': ['custom-compress-value', 'compress-distance-type',
    'enter-scale', 'enter-anchor', 'exit-scale', 'exit-anchor'],
  'Axure:InteractionEvent': ['Disabled', 'variable-id'],
};

// 动作壳（Axure:Interaction*Action）上的 RP 11 新增键
// 注意：Axure 自身把 SetFunction 的类名拼成 Axure:InterationActionSetFunction（少一个 c），
// 所以这里必须同时接受 Interaction / Interation 两种前缀，否则会漏掉 Disabled。
export const ACTION_SHELL_CLASS = /^Axure:(Interaction|Interation)[A-Za-z0-9]*Action$/;
export const ACTION_SHELL_RP9_DROP = ['Disabled'];

// 同名不同型：目标 RP 9 时按 bool 写
// 键名统一用去掉 Axure: 前缀的短名，与实测表 RP11_ONLY_KEYS 保持一致
export const RP9_TAG_OVERRIDES = {
  'EnableDisableWidgetsInfo': { enable: 'bool' },
};

// 【已撤回】曾经按语料观察把 InteractionCase.Disabled 改名成 IsEnabled 并取反 —— 这是错的。
// REA 真值（RP9 Client.Mac.exe，sha256 0f40edf1…）：
//   Axure.DocumentModel.Interaction.IxCase.rv2F (0x06008dc9) 的字面锚点只有
//   Description(IL72) / Condition(IL152) / IsNewIfGroup(IL215) —— 既无 IsEnabled 也无 Disabled。
//   而 RP9 全量 31,264 处字符串调用里 "IsEnabled" 出现 0 次。
//   IsEnabled 只存在于旧样本文件、由 reader(Bv2O) 容忍读取，不是当前 writer 的输出。
// 因此 RP9 的正确做法是「丢掉 Disabled」，不是改名。
export const RP9_RENAME_INVERT = {};

// ---- 以下表由两版自带原生样本实测生成；对 REA 已覆盖的类，键集已用 RP9 程序集真值核对 ----
// 生成器: rp9-compat-20261016/patch/build-action-field-table.mjs -> evidence/action-fields.json
// REA 核对（RP9 Client.Mac.exe, sha256 0f40edf1b8f5e4db8f999abd76e186157a457056b14a161cf53f514b2646abe1）:
//   FadeWidgetInfo.rv2F 0x06008fa7
//   SetPanelStateInfo.rv2F 0x060090f0
//   IxCase.rv2F 0x06008dc9
//   IxEvent.rv2F 0x06008e28
//   EnableDisableWidgetsInfo.rv2F 0x06008a4b
//   Layer.rv2F 0x06007bc3

// 两版语料都出现、但 RP 11 writer 多出来的键。目标 RP 9 时应去掉。
export const RP11_ONLY_KEYS = {
  "AdaptiveView": [
    "Cursor"
  ],
  "AddFilterToRepeaterInfo": [
    "ColumnId",
    "ColumnName",
    "Condition",
    "FilterComboType",
    "UseCondition"
  ],
  "AddSortToRepeaterInfo": [
    "remove-all-sorts"
  ],
  "DeleteItemsFromDataSetInfo": [
    "RowIndicesRule",
    "RowIndicesText"
  ],
  "DiagramObject:Checkbox": [
    "Error"
  ],
  "DiagramObject:ComboBox": [
    "Error"
  ],
  "DiagramObject:Connector": [
    "Error"
  ],
  "DiagramObject:DynamicPanel": [
    "Error",
    "ExpandedOnOutlineTreeView"
  ],
  "DiagramObject:Hyperlink": [
    "Error"
  ],
  "DiagramObject:ImageBox": [
    "Error"
  ],
  "DiagramObject:ImageMapRegion": [
    "Error",
    "InteractionMap"
  ],
  "DiagramObject:InlineFrame": [
    "Error"
  ],
  "DiagramObject:Layer": [
    "Error",
    "ExpandedOnOutlineTreeView"
  ],
  "DiagramObject:ListBox": [
    "Error"
  ],
  "DiagramObject:MenuObject": [
    "Error"
  ],
  "DiagramObject:RadioButton": [
    "Error"
  ],
  "DiagramObject:Repeater": [
    "Error",
    "ExpandedOnOutlineTreeView",
    "Propagate"
  ],
  "DiagramObject:Screenshot": [
    "Error"
  ],
  "DiagramObject:Table": [
    "Error"
  ],
  "DiagramObject:TableCell": [
    "Error"
  ],
  "DiagramObject:TextArea": [
    "Error"
  ],
  "DiagramObject:TextBox": [
    "Error"
  ],
  "DiagramObject:TreeNodeObject": [
    "Error"
  ],
  "DocumentModel:DataSetProp": [
    "linked-widget-path"
  ],
  "DocumentSettings": [
    "FloatingEditorLayoutInfos",
    "PrototypeDeleted",
    "ShowLastPublishedCurrentLinks",
    "UploadedSitmapIds"
  ],
  "FadeWidgetInfo": [
    "compress-distance-type",
    "custom-compress-value",
    "page-background-blur",
    "scale",
    "scale-anchor",
    "scale-hide",
    "scale-hide-anchor"
  ],
  "InteractionAddItemsToDataSetAction": [
    "Disabled"
  ],
  "InteractionAddSortToRepeaterAction": [
    "Disabled"
  ],
  "InteractionCase": [
    "Disabled"
  ],
  "InteractionDeleteItemsFromDataSetAction": [
    "Disabled"
  ],
  "InteractionEnableDisableWidgetsAction": [
    "Disabled"
  ],
  "InteractionEvent": [
    "Disabled",
    "variable-id"
  ],
  "InteractionFadeWidgetAction": [
    "Disabled"
  ],
  "InteractionLinkWindowAction": [
    "Disabled"
  ],
  "InteractionMoveWidgetAction": [
    "Disabled"
  ],
  "InteractionRaiseEventAction": [
    "Disabled"
  ],
  "InteractionRotateWidgetAction": [
    "Disabled"
  ],
  "InteractionSetPanelStateAction": [
    "Disabled"
  ],
  "InteractionSetWidgetSizeAction": [
    "Disabled"
  ],
  "InteractionWaitAction": [
    "Disabled"
  ],
  "InterationActionSetFunction": [
    "Disabled"
  ],
  "PanelDiagram": [
    "ExpandedOnOutlineTreeView"
  ],
  "SetPanelStateInfo": [
    "compress-distance-type",
    "custom-compress-value",
    "enter-anchor",
    "enter-scale",
    "exit-anchor",
    "exit-scale"
  ]
};

// 【REA 真值】RP 9 原生 writer 有、RP 11 writer 没有的键 —— 目标 RP 9 时必须存在。
//   FadeWidgetInfo.rv2F(0x06008fa7) 13 键含 vertical；SetPanelStateInfo.rv2F(0x060090f0) 18 键含 vertical。
// 注意 InteractionCase 的 IsEnabled 不在此列：RP9 全量 31,264 处字符串调用里 IsEnabled 出现 0 次，
// 它是旧样本文件里的 legacy 内容、由 reader 容忍，不是当前 writer 的输出。
export const RP9_REQUIRED_KEYS = {
  "FadeWidgetInfo": [
    "vertical"
  ],
  "SetPanelStateInfo": [
    "vertical"
  ]
};

// 【REA 真值，2026-10-16】曾经这里列的 9 个类来自「RP 11 语料里出现过、RP 9 语料里没观察到」——
// 那是**覆盖率**问题，不是存在性。逐个用 RP 9 程序集的类型标签核实后：**9 个全部存在**。
// 所以弱信号清单清空（保留导出名不破坏调用方），它们不应产生任何警告或拒绝。
export const CLASSES_CONFIRMED_IN_RP9_BY_REA = [
  'Expr:OptionLiteral',
  'InteractionSetFocusOnWidgetAction',
  'InteractionSetImageAction',
  'InteractionSetPanelOrderAction',
  'InteractionUpdateEditItemsInDataSetAction',
  'SetImageStateInfo',
  'SetImagesStateInfo',
  'SetPanelOrderInfo',
  'UpdateEditItemsInDataSetInfo',
];

// 「语料没观察到」不足以判定不存在，故恒为空。
export const CLASSES_NOT_IN_RP9_CORPUS = [];

// 静态证据（REA）确认 RP 9 完全不存在的类型标签 —— 只有这两个。
export const RP11_ONLY_CLASSES_STATIC = ['Axure:InteractionApplyStyle', 'Axure:InteractionApplyStyleInfo'];

// ---- 样式 PropList 的属性码（DOA）差异 ----
// 来源：REA 衍生 oracle（patch/oracle-const）读 Client.Mac.exe / Client.Mac.dll 的
//       Axure.Constants.PName 字段常量。文件里的 DOA 值 = 0xC0000000 | 基值。
// 按【数值】比对（按名字比对会把「同槽改名」误判成新增）：
//   · RP 9 独有数值：0 个（所有槽位都延续到 RP 11）
//   · RP 11 独有：下面这些
//   · 同槽改名：0x6a ANCHOR_HORIZONTAL→PIN_HORIZONTAL、0x6b ANCHOR_VERTICAL→PIN_VERTICAL
// ⚠ 只用数值判定；名字在跨版本时会变。
// ---- 表达式函数（FCall）的版本差异 ----
// 来源：两版**预览运行时** expr.js 的函数表逐名对比（2026-10-16）——
//   RP 9 : 38 个   RP 11: 41 个   仅 RP 11: GetErrorState / SetErrorState / ToLowerCase
// 并用两版程序集字符串表旁证：`ToLowerCase` / `SetErrorState` 在 RP 9 的 Client.Mac.exe 里
// **一个字节都没有**（`Concat` 同样没有，与已修的历史 bug 一致）。
// 后果：名字在注册表里但目标版本没有 → 预览时求值器拿到 undefined，
// 与历史上 `Concat` 那次失败同类，只是成因是**版本差异**而不是拼错。
// ---- 事件（event-type）的版本差异 ----
// 来源：两版**预览运行时** JS 里的事件名逐名对比（2026-10-16，patch/event-version-audit.mjs）。
//   EVENTS 表 45 个里，39 个两版都有，**3 个仅 RP 11 有**，3 个是我们的伪标签（名字映射不适用）。
// 旁证：RP 9 程序集字符串里 `OnErrorSet`/`OnErrorRemoved`/`error-state` **一个都没有**；
//        RP 11 运行时有 `onErrorSet`/`onErrorRemoved`/`ErrorState`，RP 9 运行时全无。
// 后果与 FCall 那次同类：名字在 EVENTS 表里、目标版本却没有 → 写出 RP 9 认不得的事件。
export const RP11_ONLY_EVENTS = {
  OnErrorSet: 55, OnErrorRemoved: 56, OnBeforeItemLoad: 291,
};

export const RP11_ONLY_FCALLS = new Set([
  'ToLowerCase', 'GetErrorState', 'SetErrorState',
]);
// 三者的判据都是**两版预览运行时 expr.js 的函数表差异**（RP9 38 个 / RP11 41 个），
// 且 `ToLowerCase` 有实际使用背书：全工作区 RP 11 的 .rp 里出现 24 次、RP 9 里 0 次。
// `GetErrorState`/`SetErrorState` 在任何 .rp 里都没出现（两版皆 0），
// 属**能力补齐**而非修 bug：它们在 RP 11 运行时里存在，形状与已验函数同类，故补上并加门禁。

// ---- 跨版本「人取名的成员」差异（REA 逐类型实测，2026-10-16） ----
// 来源：rea inspect-managed-members --type <T> 分别取两版成员清单，按名字配对。
// **只有人取的名字可比**：混淆类型（如 SetImageStateInfo）两侧同为 5 字段/19 方法，
// 但名字集合完全不相交 —— 这就是整程序集比出 125095 条 unknown 的主因。
// 工具：rp9-compat-20261016/patch/xver-member-diff.mjs
//
// 这里是各类型**仅 RP 11 有**的属性访问器。它与 RP11_ONLY_KEYS 是两条独立测得的证据链，
// 测试里断言两者一致 —— 不一致就说明有一条错了。
export const RP11_ONLY_ACCESSORS = {
  FadeWidgetInfo: [
    'Scale', 'ScaleAnchor', 'ScaleHide', 'ScaleHideAnchor',
    'CompressDistanceType', 'CustomCompressValue', 'CustomCompressText', 'LightboxBlur',
  ],
  SetPanelStateInfo: [
    'EnterAnchor', 'EnterScale', 'ExitAnchor', 'ExitScale',
    'CompressDistanceType', 'CustomCompressValue',
  ],
};

// 键名与访问器不同名的已知对应（两个证据链都指向同一概念，只是命名层不同）
export const ACCESSOR_KEY_ALIASES = {
  'page-background-blur': 'LightboxBlur',
};

export const RP11_ONLY_DOA_CODES = {
  "0x6c": "FIXED_HEIGHT",
  "0x6d": "FIXED_WIDTH",
  "0x578": "TRANSITION",
  "0x579": "TRANSFORM",
  "0x57a": "TRANSFORM_ORIGIN",
  "0x57b": "WIDGET_BLUR",
  "0x57c": "BACKDROP_BLUR",
  "0x57d": "PAGE_CURSOR"
};

export const DOA_RENAMED_SAME_SLOT = {
  "0x6a": {
    "rp9": "ANCHOR_HORIZONTAL",
    "rp11": "PIN_HORIZONTAL"
  },
  "0x6b": {
    "rp9": "ANCHOR_VERTICAL",
    "rp11": "PIN_VERTICAL"
  }
};

// 0xC0000000 | 基值 的掩码
export const DOA_BASE_MASK = 0x0FFFFFFF;

// RP 11 独有、RP 9 无对应模型的类型标签 → 目标 RP 9 时明确拒绝
export const RP11_ONLY_CLASSES = RP11_ONLY_CLASSES_STATIC;

// 目标 RP 9 时需要补出的 RP 9 独有键（值由调用方按语义给出）
export const RP9_ADD_KEYS = {
  'Axure:FadeWidgetInfo': ['vertical'],
};

// RP 9 的 EnableDisableWidgetsInfo.enable 是 bool：true=启用、false=禁用。
// RP 11 是同键的 int 枚举 Enable=0 / Disable=1 / Toggle=2，toggle 在 RP 9 无 bool 表达。
export const RP9_ENABLE_VALUES = { enable: true, disable: false };
