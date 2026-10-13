# Axvg 编码手册

Axvg 是 Axure RP 11 原生接受的剪贴板 JSON 格式。本文是经落画实测的字段规范；脚本 `axvg.mjs` 的组件会展开成这里的结构，只有脚本未覆盖的形状才需要手写。

## 顶层结构

```jsonc
{
  "masters": {},          // 保留空对象
  "imageMap": {},         // 无图片时为空；有图片时为 key → base64 字典
  "scene": { "items": [ Frame ] }
}
```

## Frame（画板）

```jsonc
{
  "id": "frame-1", "name": "页面名", "itemType": 2, "isNameDynamic": false,
  "rect": { "location": {"x":0,"y":0}, "size": {"width":1440,"height":900} },
  "resizingConstraints": { hasFixedLeft:true, hasFixedRight:false, hasFixedTop:true,
    hasFixedBottom:false, hasFixedWidth:true, hasFixedHeight:true },
  "backgroundFill": { "type":1, "enabled":true, "color":{r,g,b,a} },  // 0..1 归一化
  "backgroundShape": { /* 与 widget 同构的背景矩形，覆盖整帧 */ },
  "scene": { "items": [ Widget ] }
}
```

## Widget 公共字段（缺 id 会触发解析异常）

每个 widget 必须包含：`itemType:1, id:"任意唯一串", name, visible:true, isLocked:false,
isNameDynamic, rotation:0, opacity:1, rect{location{x,y},size{width,height}},
resizingConstraints{六个布尔}, strokes:[], strokeThickness:0, strokePattern:[],
backgroundFills:[], effects:[], textAlignment:1, textPadding:[], textShadows:[],
textRotation:0, isMask:false, booleanOperation:0, flippedHorizontal:false,
flippedVertical:false, corners:[0,0,0,0], border:[0,0,0,0], type:0`。
颜色一律 `{r,g,b,a}`，取值 0..1（不是 0..255）。

## 矩形 / 卡片（type:0）

- `corners: [tl,tr,br,bl]` 像素圆角；`999` = 全圆（圆/胶囊）。
- `border: [t,t,t,t]` 四边宽度 + `strokeThickness: t` + `strokes: [{alignment:0, fill:{type:1,enabled:true,color}}]`。
- `backgroundFills: [{type:1,enabled:true,color}]`；空数组 = 透明。

## 文本（type:0 + isNameDynamic:true + name=内容）

```jsonc
"text": { "paragraphs": [{ "horizontalAlignment": 0|1|2,  // 左/中/右
  "lineSpacing": 0,
  "inlines": [ /* 每个字符一个 run */ ] }] }
```
InlineRun：`{type:0, text:"一", family:"Inter", typeface:"Inter - Bold"|"Inter - Semi Bold"|"Inter - Medium"|"Inter - Regular",
style:0, weight:700|500|400, textColor:{r,g,b,a}, size, underline:false, strikethrough:false,
superscript:0, baselineOffset:0, highlight:{a:1,r:0,g:0,b:0}, characterSpacing:0, transform:0, stretch:5}`。
- 中文字符走 Inter 会回退系统字体，正常。
- Emoji（U+1F000+）不渲染，一律用形状/字符替代（✕ ‹ › ← → ↑ ↓ ✓ ♥ ★ ⚠ ☰ •）。

## 线段（零高描边旋转矩形）

Axure 把 `height:0` + `strokes` 的 widget 渲染成 SVG 线段，颜色粗细角度全保真：

```jsonc
{ "rotation": θ,                     // 度。atan2(dy,dx)·180/π，正值顺时针
  "rect": { "location": {x: 中点x−L/2, y: 中点y}, "size": {width: L, height: 0} },
  "strokes": [{alignment:0, fill:{type:1,enabled:true,color}}], "strokeThickness": t }
```
用途：折线连线、网格线（粗 1px 当 hline 用）、连接线。数据点用 circle（corners 999）。

## 图片（imageMap + fill type 3）—— 已破解 ✅

图片不走 widget 字段，而是**根层 imageMap 字典 + 填充引用**：

```jsonc
// 根层：
{ "masters": {}, "imageMap": { "<sha1>": "<base64 JPEG 数据>" }, "scene": {...} }

// widget 引用（图片就是一个普通矩形 widget + 图片填充）：
{ "type": 0, "rect": {...},
  "backgroundFills": [{ "type": 3,            // 3 = 图片填充（1 = 纯色）
    "enabled": true,
    "image": "<imageMap 的 key>",              // 40 位十六进制（实测为 JPEG 数据的 SHA1）
    "isHash": true,
    "alignment": { "horizontal": 1, "vertical": 1 },   // 1 = 居中
    "patternFillType": 4 }] }                  // 4 = 适应填充
```

- 图片数据 = **base64 JPEG**（`/9j/` 开头）；PNG 需转 JPEG。
- key 40 位十六进制，实测 = 图片 JPEG 字节的 SHA1（自造任意唯一 key 也可，但保持 SHA1 与官方一致）。
- `axvg.mjs` 已支持：spec 里 `"images": {key: base64}` + `{"kind":"image", imageKey, x,y,w,h}`。
- 验证：Axure 预览将图片渲染为 `<img src="images/page_1/uN.jpg">` 资产。

## 矢量形状（type:2 + paths）—— 锚点循环模型

`paths` 是**锚点列表**，不是线段列表。这是最容易读错的地方：

- 每个锚点 `{type:3, to:{x,y}, lowerHandle:{x,y}, higherHandle:{x,y}}`，坐标归一化 0..1（相对 widget rect；手柄可越界）。
- 相邻锚点 i→i+1 的三次贝塞尔：控制点 = `anchor[i].higherHandle` + `anchor[i+1].lowerHandle`。
- `closed:true` 时末锚点.higher + 首锚点.lower 闭合整环。
- 直线 = 退化贝塞尔（lowerHandle = higherHandle = 该锚点位置）。
- 圆弧 = 标准弧转贝塞尔：κ = (4/3)·tan(Δ/4)，切向 T(a)=(−sin a, cos a)，单段 Δ ≤ 90°，>90° 均分多段。
- `type` 值只有 0 和 2 安全；1/2/3/5 会触发解析异常（缺 paths 时），5 无意义；`type:4` 是别的默认形状。
- 字段名是 `paths`（复数）；`vectorPaths/path/pathData/points/arcData` 等一律被忽略。

## 饼图（楔形组合）

**所有楔形共用同一 rect —— 归一化空间里圆心恒 (0.5,0.5)、半径恒 0.5。** 中心或半径不一致，楔形必然错位。

每个楔形一个 widget，路径锚点顺序：[弧起点 A, 弧中点…(>72° 分段), 弧终点 B, 圆心 C]，循环闭合：

| 锚点 | lowerHandle（入） | higherHandle（出） |
|---|---|---|
| A（a1 处） | A 本身（直线来自圆心） | A + κ·r·T(a1)（沿弧出） |
| 弧中点 a | P(a) − κ·r·T(a) | P(a) + κ·r·T(a) |
| B（a2 处） | B − κ·r·T(a2)（弧入） | B 本身（直线去圆心） |
| 圆心 C | C | C |

角度：0° = 3 点方向，正值顺时针；12 点方向 = −90°。脚本按各扇区 pct 总和归一化为 360°；也可显式给 a1Deg/a2Deg。实现将每段圆弧限制在 72° 内，分段数 = ceil(abs(sweep)/72°)。
渲染结果为独立 SVG 矢量资产（HTML 预览里每楔形一个 `<svg>`），完全可编辑。

## 尺寸约定

桌面 1440×900 / 1440×860，移动 375×812，平板 768×1024。区块间距 16–24（紧凑）/ 32–48（宽松），卡片内边距 16–32。

## spec 与原始格式的区别

`axvg.mjs` 当前展开 rect/card、circle/ellipse、hline、text、line、image、shape、pie。原始 Axvg 格式中已有渐变与阴影字段（见 官方序列化资料（历史研究资料未随仓库分发）），当前 spec 展开器已提供 linear/radial 渐变和内外阴影参数，范围与示例见下文。angular 会被拒绝，其他未登记字段不表示生效。

文本元件当前以内容自动命名，`text` 的自定义 `name` 不会覆盖它；通道 B 定位前以 `rp-read` 实际输出为准。多行排版优先分行建 text。

## Spec 渐变与阴影（2026-10-05）

rect/card、circle/ellipse、shape 的 `fill` 可保留原 `#RRGGBB` 字符串，或使用：

```json
{ "type": "linear", "from": {"x":0,"y":0.5}, "to":{"x":1,"y":0.5},
  "stops": [{"offset":0,"color":"#F04444","opacity":1}, {"offset":1,"color":"#3B66F5","opacity":0.6}] }
```

`type` 仅 linear 或 radial；radial 的 from 默认中心，to 默认右边中点，`ellipseLength` 默认 1。from/to 是归一化形状坐标；stops 至少两项，offset 按升序在 0..1 内。rect/circle 的 border 可用 `{"thickness":8,"fill":<上述渐变对象>}`；原 border.color 字符串继续可用。

上述图形的 `shadows` 是数组，例如 `[{"type":"inner","color":"#173145","opacity":0.6,"blur":16,"x":10,"y":12,"spread":0}]`，type 默认 outer。同一菱形上填充渐变与外阴影组合已验。指定矩形、椭圆和菱形保存关闭重开后仍为 VectorShape，实际预览保留效果；不推定文本阴影、多重同类型阴影或所有 spread 值已验。

Axure RP 11.0.0.4137 会把官方 Axvg angular 输入降为线性填充，当前生成器拒绝 angular，避免静默产生错误效果。官方原生颜色样式范围见 [Axure 样式说明](https://docs.axure.com/axure-rp/reference/styling-widgets/)。原始对照与完整证据在 capability-expansion-20261005 下。
