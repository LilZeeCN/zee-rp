# 手机原型：零算高流式布局与设备壳规则

> 💡 **提示**：日常从零构建与改稿请直接查阅主入口 **[SKILL.md](../SKILL.md)**（已内联完整属性速查表与多页模板）。本文仅作设备外壳与排版边界补充。

适用当前 RP/1 → RP9 原生生成入口。最小可运行源码：[mobile-layout.rp1](../examples/rp-language/mobile-layout.rp1)。

## 1. 设备壳与坐标规则

页面声明 `device=iphone-17` 后，编译器自动合成三层钛金属机身、灵动岛与 Home Indicator。**不要手画外框，也不要先把内容平移 20px。**

| 预设名称 | 内容屏幕尺寸 | 含外壳画板尺寸 | 装配偏移 |
| --- | --- | --- | --- |
| `iphone-17`、`iphone-17-pro` | 402 × 874 | 442 × 914 | x+20、y+20 |
| `iphone-16`、`iphone-16-pro` | 393 × 852 | 433 × 892 | x+20、y+20 |

- **推荐省略页面 `[WxH]`**，让 `device` 自动匹配屏幕尺寸（即便误写 `[442x914]`，显式传 `autoHeal:true` 可尝试修正为屏幕内尺寸 `402×874`）。
- `phone-shell` 负责屏幕内状态栏、标题栏、内边距与底栏预留，常用参数：`title`、`subtitle`、`gap`、`time`、`statusRight`、`darkIsland`、`showHomeIndicator`、`tabBar`。

## 2. `[WxH]` 尺寸与 `[fillxhug]` 零算高法则

| 写法 | 等价写法 | 适用元件 |
| --- | --- | --- |
| `[fillxhug]` | `w=fill h=hug` | **纵向容器、`card`、`panel`、`repeater`、`stat-row`、`list-item`、`label`、`paragraph` 首选** |
| `[fillx44]` | `w=fill h=44` | 铺满宽度的标准按钮、原生输入框 `input` |
| `[180x44]` | `w=180 h=44` | 固定宽高的局部按钮 |

- **动态面板 `panel [fillxhug]`**：自动递归测量所有 `:state` 的高度并取最大值作为面板高度；配合 `tabs=["视图A","视图B"]` 自动在各 `:state` 顶部生成带当前态 `primary` 高亮的分段切换栏。
- **顶层 `tab-bar:`**：自动注入所有 `phone-shell` 页面，并在内容较短的页面上自动吸底固定（`y >= 780`）。

## 3. 细节与边界速查

- **进度条 `progress-bar`**：`showValue=false` 隐藏右侧百分比；`label=""` 时只显示轨道。运行期填充每 10% 一档。
- **内置图标 `icon`**：原生保存为独立 `ImageBox`，常用名：`search`、`plus`、`check`、`home`、`book`、`heart`、`star`、`clock`、`arrow-left`（未知名称报 `E_ICON_NAME`）。
- **门禁与自愈**：`generate_prototype` 默认 `autoHeal:false`；显式开启后会完整重验并回退新增错误的变更。`strictAudit:true` 仅在门禁全部通过时交付，否则返回诊断。
