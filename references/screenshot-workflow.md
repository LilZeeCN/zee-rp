# 图片转 Axure 原型

`trace.mjs` 封装 Python 图像处理和 macOS Vision OCR，识别文字、卡片、胶囊、分隔线、部分图表几何和媒体区域，再生成分层规格。文字和支持的几何可继续编辑，复杂画面和部分图标保留为独立图片。

## 自制示例

安装 README 依赖、激活 Python 环境，然后执行：

```sh
node scripts/trace.mjs draft examples/screenshot/source.png -o outputs/screenshot --scale 1 --axvg outputs/screenshot/page.axvg.json
```

`--scale` 是物理像素与逻辑像素的比例，Retina 2x 截图通常用 `2`。输出 `draft.spec.json`、剪贴板 JSON、薄页渲染和差分图。识别是启发式过程，应检查结果。

```sh
node scripts/trace.mjs patch outputs/screenshot/draft.spec.json --replace "识别错字=正确文字" --axvg outputs/screenshot/page.axvg.json --safe-lines
```

## 保存为 `.rp`

`draft/build` 生成剪贴板 JSON，不是原生文件。RP9 中打开新工作工程后执行：

```sh
python3 tools/rp9_place.py /absolute/path/to/new-working-project.rp --axvg outputs/screenshot/page.axvg.json
```

该工具清空指定工作工程当前页、粘贴、对齐并保存，请使用新工程。RP11 使用 `node scripts/axvg.mjs paste outputs/screenshot/page.axvg.json --version 11` 后在 Axure 保存。

## 核对实际预览

```sh
node scripts/trace.mjs verify outputs/screenshot/draft.spec.json --source examples/screenshot/source.png --scale 1 --preview /absolute/path/to/axure-preview.png -o outputs/host-comparison
```

没有 `--preview` 时只比较本地薄页；另有 `axure_preview_mae_per_255` 才表示 Axure 实际预览比较。`pixel_similarity_pct = 100 × (1 − MAE/255)`，不是 OCR 准确率或逐像素相等率。

图片元件能单独移动不代表内部图案已矢量化，静态截图也无法恢复业务逻辑。RP9 斜线使用 `--safe-lines`。耗时应交代缓存、尺寸、OCR 及是否包含 GUI 落盘。

源图和移动示例由 [generate-assets.py](../examples/generate-assets.py) 自行绘制，不含第三方网页、聊天、头像、官方手机模型或字体文件。
