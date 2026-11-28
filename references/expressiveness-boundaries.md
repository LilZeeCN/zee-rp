# 表达力探针

v0.4.5 实测。原生 RP9 官方 HTML 与 Studio HTML 各通过 6 步交互。探针与视觉能力分类见 [expressiveness-probe.rp1](../examples/expressiveness-probe.rp1) 和 [四消费面对照](surface-capabilities-matrix.md)。

| 能力 | 原生 RP9 / 官方 HTML | Studio 与离线 HTML | 复验证据 |
| --- | --- | --- | --- |
| `fontFamily="PingFang SC"` | 宿主受限。原生保留字体族，浏览器依赖宿主安装 | 支持 CSS 字体族及回退 | 初始帧和字体检查 |
| 面板 `slideLeft` 加 `fade` | 支持原生进入与退出过渡参数 | 支持面板切态与内容回放 | 行为关键帧中的切态步骤 |
| 线性 `gradient` | 光栅化降级为位图图层 | 支持 CSS 渐变 | 初始帧和 `generation.json` 的 `degradations` |
| 图片圆角和不透明度 | 圆角光栅化。不透明度由原生节点携带 | 支持 CSS 圆角和透明度 | 初始帧和 `generation.json` 的 `degradations` |
| `backdropBlur` | 光栅化降级为静态背景采样 | 支持 CSS 背景模糊 | 初始帧和 `generation.json` 的 `degradations` |
| `input rotation=25` | 支持原生旋转与编辑 | 支持 CSS 旋转与真实输入框 | 两端行为关键帧及原生浏览器读值 |
| Studio `editPath` 与布尔路径 | 支持导出计算后的原生轮廓 | 支持编辑控制点与布尔运算 | [矢量与布尔测试](../test/studio-vector-boolean-check.mjs) |

复验目录 `gate-e-full/` 中，两端初始帧为 `official-1795874363092.png`、`studio-html-1795874371804.png`，行为关键帧为 `official.assets/storyboard.png`、`studio-html.assets/storyboard.png`。对应的 `PROOF.md` 与关键帧在同一目录。
