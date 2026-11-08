# Studio：浏览器效果与 RP9 导出边界

2026-10-26，工作分支 `feat/free-canvas-v1`。这些改动属于开发目录中的 Studio，尚未替换正式安装的 MCP 程序。

## 浏览器负责完整创作

浏览器画布保留自己的视觉表达。RP9 的可表示范围只在导出时判断，不用 RP/1 的原生属性白名单限制浏览器 CSS。

节点可保存 `css` 对象；支持标准 CSS 属性名和 camelCase。多层线性/径向/锥形渐变、重复渐变、背景混合、多重阴影、滤镜、背景模糊、遮罩、裁剪、渐变文字以及 2D/3D 变换由浏览器实际绘制。旧的 `gradient`、`shadow`、`aurora`、`noise`、`backdropBlur` 也接入同一条浏览器样式路径。

```json
{
  "type": "setProperties",
  "pageId": "home",
  "nodeId": "hero",
  "properties": {
    "css": {
      "background": "conic-gradient(from 30deg, #7946c3, #1f7e86, #bf679c, #7946c3)",
      "transform": "perspective(800px) rotateY(-16deg) rotateX(7deg)",
      "filter": "saturate(1.25)",
      "boxShadow": "20px 30px 60px #0008"
    }
  }
}
```

人可以在右侧「高级 CSS 效果」中编辑该对象并点击「应用效果」。它经过与 AI 命令相同的原子事务、版本检查、历史和持久化路径；CSS 值可以用 `var(--brand)` 引用色彩令牌。

尺寸、位置、自动布局和字体排版继续用对应的语义属性与编辑器控件；在 `css` 中重复设置这些属性会明确报错，避免浏览器画面与文档几何出现两个互相覆盖的结果。CSS 效果支持不等于任意网页 HTML/CSS 布局导入能力。

画布现在按文档层级生成 DOM。容器上的裁剪、滤镜、透明度和变换可以作用于子节点；子节点仍保留独立的选择、文字和命令身份。选区按实际 DOM 边界显示，拖拽使用父容器的投影坐标，叶节点增量更新也保留相对坐标。

## RP9 在导出时处理兼容性

导出使用指定文档的克隆，不能删改浏览器文档中的 CSS。每个节点的兼容报告分别记录原生对象、装饰效果图片与未完整表示的属性。

| 内容 | RP9 交付方式 |
| --- | --- |
| 基础几何、原生文字与原有支持的交互 | 继续生成可编辑原生对象 |
| 背景渐变、背景纹理、阴影；空白装饰节点的遮罩/滤镜 | 用同一浏览器 CSS 渲染空白装饰面，单独生成 PNG，放在原生文字和控件下方 |
| 渐变文字、组/文字变换、影响内容的滤镜或遮罩、依赖实时背景的模糊 | 标为 `unsupported`，列出导出中省略的属性；保留基础文字、对象与交互 |

装饰图片没有文字或子控件，不能冒充整页或整个交互容器的快照。效果 PNG 当前按节点边界裁切，边界外的光晕可能被截断；报告包含 `paintOnly`、`clippedToNodeBounds`、尺寸和 SHA-256。生成的 `.rp.effects/` 目录保留这些图片，方便检查。

`webglShader`、实时 `videoStream` 等仍需要独立渲染组件；本轮没有实现这些组件，不能从 CSS 效果支持推定它们已可用。3D 变换和复杂效果也没有因此变成 RP9 原生能力。

## 验证与入口

```bash
node --test test/studio-css-check.mjs
node studio/cli.mjs start --project /absolute/path/to/project --port 4380
```

专项检查覆盖真实浏览器计算样式、父子 DOM、变换内拖拽、CSS 原子回滚/撤销/重载、截图实际像素与元数据，以及真实 RP9 二进制导出、装饰 PNG、兼容报告和原始文档保留。

版本化截图的 DPR 与截图缩放分开处理：DPR=2 时不再额外乘一次裁切缩放；宽画板会先在受管渲染器中完整定位，避免 Inspector 覆盖截图右侧。该处理不改变用户标签页的视角。

实现入口：[浏览器样式](../studio/visual-style.mjs)、[装饰图片导出](../studio/css-raster.mjs)、[渲染与编辑](../studio/web/src/render.mjs)、[RP9 导出](../studio/export-rp.mjs)、[专项回归](../test/studio-css-check.mjs)。
