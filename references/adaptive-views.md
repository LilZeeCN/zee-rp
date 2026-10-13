# 自适应视图：用法、绑定与验证范围

依据 2026-09-22 round7 UI 样本及 2026-09-23 当前实现 GUI 复验更新；实测环境为 macOS / Axure RP 11.0.0.4137。当前工具采用**一个集合，包含 Base 和多个子视图**，并绑定页面、写入顶层元件覆盖。当前 GUID 保留实现已在 Quick Win 测试副本中通过 Axure 保存重开、预览断点选择和追加交互；编辑器画布顶部小型视图标签直接切换未确认。

## 使用

```bash
node scripts/add-adaptive-view.mjs source.rp views.rp 768 1024 \
  --override "V768:内容区:w=450" \
  --override "V1024:内容区:w=600,h=300,x=50,y=100"
```

- 断点省略时默认 768、1024；子视图名称为 `V<宽度>`。
- `--override` 可重复，支持 `w/h/x/y`；未指定的同组尺寸/坐标沿用基础值。
- 新集合会绑定全部 Page。当前是首次建立视图配置的工具，不提供已有视图集的合并/精确编辑；从原始基座重新生成，避免重复追加。
- 覆盖只查页面顶层元件，不跨 PanelState 或重复项模板。不同页同名会在各页匹配；需要单一目标时先命名消歧。
- 查看未匹配提示并检查实际覆盖字段；报告中的目标名称不等于匹配成功。
- 输出使用新文件名，拒绝覆盖已有文件。

## 证据范围

round7 历史样本记录了编辑器页签显示、切换视图、普通方块宽度 150→300、保存后重开仍保留覆盖。2026-09-23 使用当前 GUID 保留实现重做 GUI 验收：在 Quick Win 副本中先生成视图再添加交互，Axure 保存、关闭、重开后视图集仍在；本机预览的基本/V768/V1024 选择及普通 ImageBox 尺寸覆盖可见，点击交互也实际运行。详细步骤与数值见 复验结果（历史研究资料未随仓库分发）。中继器等 FitToContent 元件不适合作为固定宽度覆盖的唯一视觉对照。

本轮从 Axure“发布 → 预览”打开的测试件提供了“基本”“V768”“V1024”选择器，分别对应 `view=default`、`view=a`、`view=b`，三个尺寸覆盖均在画面上可见。不要再把“本地预览一概没有多视图切换器”当作当前结论。不同文件构造或发布配置可能不同；需要浏览器响应式效果时仍须验证具体发布方式，不把 Axure Cloud 等未测路线写成保证可行。

当前工具保留原 GUID 表空哨兵并追加视图集身份槽。本轮在生成视图后追加交互，使用 Axure 保存、关闭、重开，再确认视图集存在且交互可运行；离线结构读取同时报告 `danglingRefs=0`、`problems=0`。本轮没有可靠确认编辑器画布顶部的小型 Base/V768/V1024 标签能否直接切换，也不据此推定其他 Axure build、平台或文件通用。

## 绑定不变量

1. `AdaptiveViewSet.Id` 引用集合的身份 GUID；`AdaptiveView.Id` 引用视图的身份 GUID。这些身份与对象定义的 `id` 分开登记，不能混为同一个整数。
2. BaseView 的身份为已测 Axure 内置 GUID 字节 `0921e81902f16f47933582835c373474`；子视图有独立身份，`BaseViewId` 指向 Base，`ParentAdaptiveViewSet` 引用集合对象。
3. `Page.AdaptiveViewSetId` 是 tag `0x11`，索引页面 GUID 表中的集合身份。通过 GUID 字节与 DesignDocument 对齐，不能要求两个记录中的数字索引相等。
4. `Page.AdaptiveViewMatchInfos[].Id`、页面及元件 `AdaptiveStyles` 的键指向对应子视图身份。`AdaptiveStyles` 为扁平成对列表 `[id11, refStyle, ...]`。
5. **保留原 GUID 表所有槽位**。旧工具覆盖 Page 第 3 槽的空 GUID，虽出现了页签，却使后续交互构造报 `Missing null GUID`。现在追加集合身份槽，只更新 `AdaptiveViewSetId` 引用；不能把其他对象的空引用一起改成视图集。
6. 覆盖写入独立 Style.PropList：尺寸 DOA `3221225577` 为 Width/Height，位置 DOA `3221225573` 为 X/Y。`MyStyle` 基础值保持原样。

旧 `sharedViewId == DOA`、多个独立集合、页面无需绑定和“只有中继器能覆盖”的描述仅作研究历史，不再作为当前构造规则。`SKIP_PAGES`、`FORCE_PAGE_ID`、`FORCE_VIEW_ID` 也不是当前 CLI 接口。

## 证据入口

研究目录不随包：`axure-exp/research-rp/round4/verification/round7-20260922/` 中的 `ADAPTIVE-OVERRIDE-TRUTH.md`、`PROBLEM-SET-adaptive-page-binding.md`、`TASK1-adaptiveViews-result.md`、`PROGRESS-20260922-pm.md`。旧 `repeater-adaptive-final.rp` 为历史 GUI 样本，带旧槽位覆盖；后续加工应从未损坏的原始基座用当前工具重新建立视图。
