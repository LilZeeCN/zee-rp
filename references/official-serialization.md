# Axvg 几何与填充笔记

本页整理互操作所需的格式观察，具体实现以本项目的编码器和测试为准。

## 关键修正/确认（相对此前猜测）

1. **直线段 = `type:2`，不是退化 type:3**（`pushLines`：`{type:2, to:{x,y}}`，无手柄字段）。
   之前用退化贝塞尔表达直线恰好渲染正确（解析器兼容），但官方格式更简。
2. **圆弧/曲线 = `type:3`**，锚点链规则与此前实测一致：
   - 首锚点：`{type:3, to:起点, higherHandle:出切线}`（无 lowerHandle）
   - 中间锚点：`{type:3, lowerHandle:入切线, to:点, higherHandle:出切线}`
   - 末锚点：`{type:3, lowerHandle:入切线, to:终点}`（无 higherHandle）
   - （`pushCubics`：首段 `{type:3,to:e[0],higherHandle:e[1]}`，中段 `{type:3,lowerHandle,to,higherHandle}`，尾段 `{type:3,to:最后,lowerHandle:倒数第二}`）
3. **闭合合并**：`closed:true` 且首尾锚点重合时，合并为一个锚点（取两者 type 较大者，手柄存在则带上）。
4. **坐标归一化**：`calcX/calcY = (坐标 - bbox.origin) / bbox.size`（宽或高为 0 时除以 1）。
   path 的 bbox 由 SVG path 的绝对坐标推得，与 widget rect **一致**（`location:{x:0,y:0}` 相对 widget）。
5. **svgPaths**：仅当 Figma 节点是 **BOOLEAN_OPERATION（布尔运算）且恰含 2 个子节点**（都是矩形/多边形/星形）时填充
   （`{windingRule:"EVENODD"→..., data:"M ... Z"}`，`getFillRuleSvg`）。平时为空数组。
   注意：`EVENODD` 填充规则的矢量节点会带 windingRule 进 svgPaths。

## 填充类型全表（getFill 分派）

| Figma fill.type | Axvg | 字段 |
|---|---|---|
| SOLID | type:1 | color {r,g,b,a} |
| GRADIENT_LINEAR | type:2 | gradientType:0, from{x,y}, to{x,y}, stops[{color,offset,location}] |
| GRADIENT_ANGULAR | type:2 | gradientType:? (见 getAngularGradientFill) |
| GRADIENT_RADIAL | type:2 | gradientType:? (见 getRadialGradientFill) |
| GRADIENT_DIAMOND | 同线性（除非 includingAssetsExport） | |
| IMAGE | **type:3** | image:hash或base64, isHash, alignment{1,1}, patternFillType(4=FILL,5=FIT,其他 scaleMode→0 且走 getFromNode 导出) |

- 渐变的 `from/to` 由 Figma 的 gradientTransform 矩阵作用于 (0,.5)-(1,.5) 线段算出（TransformMatrix，含宽高比补偿 scale(1, aspect)）。
- **stops 的 `color` 是 Figma 的 RGBA 0..1**；`offset` 是 stop.position；`location` 是计算出的位置。
- 描边里的 fill 同样支持这些类型（getFill 复用）。

## 描边（getStrokePropertiesWithWeight）

- `strokes: [{alignment, fill}]`，alignment: INSIDE=0 / CENTER=1 / OUTSIDE=2。
- 无可见描边时 `strokes:[], strokeThickness:0`。
- `strokePattern` = Figma 的 `dashPattern.slice()`（虚线数组，直接拷贝）。

## 效果（getEffects/getShadowEffect/getBlurEffect）

- 阴影：`{color, enabled:visible, blur:radius, offset:{x,y}, type:1, shadowType:0|1, spread:0}`
  （shadowType 0=DROP_SHADOW, 1=INNER_SHADOW）
- 背景模糊：`{enabled:true, type:0, radius:backdropBlur/2, blurType:1}`
- 层模糊：`{enabled:true, type:0, radius:widgetBlur/2, blurType:0}`

## 文本（getText/getCharFamily）

- 逐字符 run；**换行符**（\u000b|\u2424|\u2028|\n）分段 → paragraphs。
- `lineSpacing` = 该段字符里最大的 lineHeight。
- horizontalAlignment: LEFT=0, CENTER=1, RIGHT=2, JUSTIFIED=3。
- `typeface` 格式 `` `${family} - ${style}` ``（style 即 Figma 的 style 名，如 "Regular"/"Bold"/"Semi Bold"/"Italic"）。
- `style`: 0=正常, 1=Oblique, 2=Italic。
- `weight` 映射：thin=100, extralight/ultralight=200, light=300, semilight=350, normal=400,
  medium=500, demibold/semibold=600, bold=700, extrabold/ultrabold=800, heavy/black=900, extrablack=950。
- `characterSpacing`: PIXELS 单位直接用值；PERCENT 单位 = fontSize * value / 100。末字符固定 0。
- `transform`: textCase 映射（见 getCharTransform；UPPER/LOWER/TITLE 各有值）。
- `underline`: textDecoration === "UNDERLINE"；`strikethrough`: === "STRIKETHROUGH"。

## 结构与杂项

- 顶层节点类型分派（getGfxForNode）：FRAME→getGfxForFrame/Artboard、GROUP→Group、
  组件实例→Component、RECTANGLE→Rectangle、VECTOR→Vector、其他矢量类→PathShape、SLICE→Slice、其余→Text。
- **masters 字段恒为 `{}`**——插件从不序列化母版（Figma 组件按普通 group/实例展开）。
  即：imageMap 之外，masters 是 Axvg 的未使用字段。
- `isNameDynamic` = Figma 的 `autoRename`（文本节点手输过名字则为 false）。
- 导出文件名/ID：`sanitizeID`（Figma node id 规范化）；"Copy All Frames" 走 manifest（LayerId/Scale/Name/FileName/File:Uint8Array），
  "Copy Selection" 走 `getAxvgForNodes`（单对象 + groupSceneItemsByMask）。
- 图片数据获取：`FILL`(patternFillType 4)/`FIT`(5) 尝试 `getByHash`（读 Figma 图片字节），
  其他 scaleMode（CROP/TILE）走 `getFromNode`（把节点临时导出为位图）——所以 CROP 图的 image 字节可能与原图不同。
