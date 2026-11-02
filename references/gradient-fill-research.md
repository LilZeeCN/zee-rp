# 矢量渐变填充：取证记录（2026-10-23）

目标：让 `gradient` 写成 **原生矢量填充**，而不是"渲染成位图 + ImageBox"。

结论：**未打通**。当前生产路径仍用位图（2×，视觉一致，参数不可在 Axure 内再编辑）。下面保留全部取证，避免下一轮从零开始。

## 一、已获得的证据（真实、可复查）

Axure RP 11 程序集（`/Applications/Axure RP 11.app/Contents/MacOS/Client.Mac.dll`）的解码字符串表中，与填充相关的键名与取值：

| 类别 | 字符串 |
| --- | --- |
| 样式键 | `fill-type` `fill-color` `fill-colors` `fill-offsets` `fill-angle` `fill-center-point` `fill-axis1` `fill-axis2` `fill-opacity` `fill-rule` |
| 类型值 | `solid` `linearGradient` `radialGradient` `solidFill` |
| 类名 | `Axure:Drawing:LinearGradientFill` `Axure:Drawing:GradientStop` |
| 其他 | `stops` `offset` `color` `location` `from` `to` `angle` `stop-color` `stop-opacity` |

取证方式：`research-rp/rea-20261008` 的字符串表解码器（`evidence/string-table.decoded.bin.json`，19,398 条），
以及 `strings -a` 对同一 dll 的交叉核对。REA 索引里另有类型 `Axure.Axvg.Graphics.{LinearGradientFill,RadialGradientFill,AngularGradientFill,GradientStop,GradientType}` 与 `FillTypeJsonConverter`（方法体已切出，但字符串来自常量字段而非 `ldstr`，未解出映射）。

## 二、试过并失败的两个编码

两者都把 `DOA 3221225479`（fill）的 `Value` 换成了渐变映射，生成的 `.rp` 用 Axure RP 9 打开、保存、重开、触发预览：

| 候选 | Value 形状 | 结果 |
| --- | --- | --- |
| A | `{fill-type:"linearGradient", fill-colors:[int…], fill-offsets:[f64…], fill-angle:135}` | Axure **原样保存**（键未丢、未被改写），但预览里该形状 `background-color` 透明、`background-image` 为 none —— **不渲染** |
| C | 同上，但 `fill-type:"gradient"` | 同上 |

这与 `Set Size`（`InteractionSetWidgetSizeAction`）当年那次失败同型：文件里"有"，画面里"没有"，且**没有任何报错**。

## 三、为什么停下来

- 缺真值：本机 300 个 `.rp` 全扫描（`tools/probe-gradient-fill.mjs`）无一个含渐变填充；Axure 自带样本与库也没有。
- GUI 取证被工具层挡住：本机 computer-use 对 Axure 自绘画布只支持元素级点击，坐标点击/拖拽返回 `noWindowsAvailable`，无法手绘渐变取样本。
- 继续猜第三个、第四个候选属于赌博；上一轮已经用 `Set Size` 验证过这类赌博的成本。

## 四、打通它需要的两件事（任选其一）

1. **拿到真值样本**：在能操作 Axure GUI 的机器上，画一个线性渐变矩形 → 另存 `.rp` → 跑
   `node tools/probe-gradient-fill.mjs <sample.rp>`，输出会直接给到键名、类型值与停靠点编码。把这一个文件放进仓库即可。
2. **走 RP11 的 axvg 通道**：`axvg.mjs` 已经能为 RP11 生成 `{type:2, gradientType, from, to, stops}` 的渐变填充。
   在 RP11 里粘贴一个带渐变的 axvg、保存，再解析产物，同样能得到 Axure 自己写出的编码（RP11 与 RP9 的 `Axvg.Graphics` 同名同构，但**需实测确认**能否直用于 RP9）。

## 五、当前实现边界

- 生产默认：`gradient`/`shadow`/`aurora`/`noise` → 光效层渲染成 **2× 位图** → `ImageBox` 写入原生。视觉与预览一致，Retina 不虚；Axure 里是图片对象。
- 实验开关：`AXURE_VECTOR_GRADIENT=1` 走矢量分支，`GRADIENT_ENCODING=A|B|C|D` 选候选。**默认关闭**，因为候选未验证成功。
- 相关代码：`proto.py:_parse_gradient_spec()`（解析 `"135deg,#A,#B"`）、`proto.py:make_axvg_vector_shape(gradient=…)`、`native-scene.mjs:paintGradient()`。
