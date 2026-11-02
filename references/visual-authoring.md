# 视觉创作：对齐、导航、状态与素材

本页说明当前 RP/1 的视觉行为。实际预览与静态拼图分别验证，不能相互替代。

## 居中的是文字，还是盒子

父 `box/card` 同时声明 `align=center justify=center`，布局为 `row/column`，且仅有一个 `label` 子节点时，未指定文字 `align` 的 label 会继承水平居中。显式 `align=left/right` 始终保留。多子节点、段落与 `stack` 不隐式修改文字方向。

```text
box #option [28x28] align=center justify=center radius=999 fill=$brand-soft
  label #letter "A" fontSize=12
```

这保证文字盒中的对齐方式正确，不承诺每种字形的光学中心完全一致。需要微调视觉重心时显式设置文字对齐和尺寸。

`letterSpacing` 已计入普通 label 的自动宽度与按钮自动宽度。显式 `w` 是固定约束，不会因字距自动扩宽；若提示裁切，应扩大宽度或缩短文字。小字号会吸附到主题字号令牌，检查最终预览。

## 三种导航外观

默认仍为激活项胶囊。可用 `activeVariant` 选择按钮样式，`activeIndicator="underline" | "dot" | "none"` 选择标识；带标识时默认使用 `ghost`。`itemFlex=1` 等分可用空间，`justify` 控制剩余空间分配。条目自身的 `flex/fill/color/variant` 优先于导航级设置。

```text
tab-bar #nav [fillx56] active="today" activeIndicator="underline" activeVariant="ghost" activeColor="#365E49" inactiveColor="#7A887E" itemFlex=1 justify="center" items=[{"id":"today","label":"今日","goto":"home"},{"id":"notes","label":"手记","goto":"notes"}]
```

完整可运行示例：[tab-bar-styles.rp1](../examples/rp-language/tab-bar-styles.rp1)。

`phone-shell.tabBar` 也可以直接传完整 `box`。例如图标在上、文字在下，或中间按钮凸出的导航：

```json
{"type":"phone-shell","id":"shell","tabBar":{"type":"box","id":"custom_nav","layout":"row","w":"fill","h":56,"children":[{"type":"button","id":"home_tab","text":"首页","flex":1,"h":44,"onClick":[{"goto":"home"}]},{"type":"button","id":"notes_tab","text":"手记","flex":1,"h":44,"onClick":[{"goto":"notes"}]}]},"children":[]}
```

导航高度和内容必须位于屏幕安全区域。现代手机壳会用四个透明角部遮罩覆盖内屏外部像素；屏幕内的文字、形状与交互仍为独立元件。

## 面板高度和静态预览

`panel [fillxhug]` 对所有状态按可用宽度测量，取**最大状态高度**作为统一面板高度；切换时不重新排下方内容。前态 260px、后态 500px，则面板高度为 500px，前态会留有空白。要固定视觉节奏可写 `[fillx500]`。当前没有 per-state 自适应运行时高度或 `fitToContent` 语言选项。

`states-sheet.png` 默认排除进度条编译器生成的 `_fill/s0…s100` 状态。状态标题标出 `viewport W×H / content Hpx`，生成报告中的 `statePreviews` 保留全部状态及尺寸，便于诊断。

静态预览读取**真实变量初值和首个状态**，不会先执行点击。当前没有独立 `previewInitial/previewState` 参数。请给初始页面合理文案；需要审阅交互后场景时，使用 `preview_prototype` 实际点击、断言并截图，避免为截图改动生产变量的含义。

## 图片圆角与字体边界

`image.radius` 和 `image.opacity` 会写入嵌入图片的透明通道，离线预览与原生 `.rp` 使用同一图像；原图文件保持不变。图片在 Axure 中可移动、缩放、替换，圆角参数不是原生可编辑的矢量蒙版。

RP/1 当前没有 `fontFamily` 属性。离线测量/渲染使用本机 PingFang 及回退字体；原生文本写入 Inter 字体族，中文由宿主回退，因此两者不承诺逐字像素一致。需要指定字体，可生成后在 Axure 编辑，或通过原生富文本工具 `set_widget_richtext` 的 `runs[].fontFamily` 修改。字体文件不随项目分发。

`gradient/shadow/aurora/noise` 会栅格化为独立 PNG 并写入原生 ImageBox，**不是仅预览可见**，也不是 Axure 中可继续调参的原生矢量光效。`backdropBlur` 采样静态背景，叠在动态内容上会失真，编译器会警告。

尺寸 `[fillx180]` 指宽度铺满、高度 180；也可用 `w=fill h=180` 避免误读。`[fillxhug]` 指宽度铺满、高度按内容测量。
