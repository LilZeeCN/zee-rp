# RP/1 与 Studio 视觉能力对照

由 `scripts/gen-capabilities.mjs --surfaces` 从 `scripts/surface-capabilities.json` 生成。运行时可用 `diagnose_prototype({ mode: "capabilities", query: "backdropBlur" })` 查询。

| 属性 | 起始版本 | full-rp1-native-rp9 | official-html-preview | studio-canvas | studio-html | 行为 |
| --- | --- | --- | --- | --- | --- | --- |
| `fill` | 0.4.4 | native | native | native | native | 实色填充。 |
| `stroke` | 0.4.4 | native | native | native | native | 实色描边。 |
| `radius` | 0.4.4 | native | native | native | native | 普通几何节点圆角。 |
| `opacity` | 0.4.4 | native | native | native | native | 普通几何节点不透明度。 |
| `fontFamily` | 0.4.5 | native | host-bounded | native | host-bounded | 保留字体族名称，浏览器渲染依赖机器已安装的字体。 |
| `gradient` | 0.4.4 | rasterized-asset | rasterized-asset | native | native | RP/1 装配将渐变渲染为图层贴图。 |
| `aurora` | 0.4.4 | rasterized-asset | rasterized-asset | native | native | 原生文件嵌入光效图层。 |
| `noise` | 0.4.4 | rasterized-asset | rasterized-asset | native | native | 原生文件嵌入噪声图层。 |
| `innerGlow` | 0.4.4 | rasterized-asset | rasterized-asset | native | native | 原生文件嵌入内发光图层。 |
| `backdropBlur` | 0.4.4 | rasterized-asset | rasterized-asset | native | native | Axure 中为静态背景采样的位图，浏览器 CSS 版实时采样。 |
| `image.radius` | 0.4.4 | rasterized-asset | rasterized-asset | native | native | 原生文件在图片像素中烘焙圆角。 |
| `input.rotation` | 0.4.4 | host-bounded | host-bounded | native | native | 原生预览由页面载入动作旋转输入框，编辑器静态外观受限。 |
| `statusBar` | 0.4.4 | studio-shell-meta | studio-shell-meta | studio-shell-meta | studio-shell-meta | 控制设备外壳状态区域。 |
| `darkIsland` | 0.4.4 | studio-shell-meta | studio-shell-meta | studio-shell-meta | studio-shell-meta | 控制设备外壳顶部装饰。 |
| `showHomeIndicator` | 0.4.4 | studio-shell-meta | studio-shell-meta | studio-shell-meta | studio-shell-meta | 控制设备外壳底部指示条。 |
