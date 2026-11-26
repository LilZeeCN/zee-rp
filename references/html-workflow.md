# HTML 复刻工作流

目标：给定本地 `.html`/`.htm` 文件或 `http(s)://` URL，在 Axure 产出结构对应的可编辑原型（`.rp1` / Studio 画布 / 原生 `.rp`）。

## 首选：一键无头 Chrome MCP 自动导入

内置无头 Chrome CDP（[`scripts/html-import.mjs`](../scripts/html-import.mjs)）可直接抓取真实计算样式、盒模型坐标、透明壳层折叠、原生表单控件（`<input>` / `<textarea>` / `<select>` / `checkbox` / `radio`）、渐变/圆角/单边边框/阴影与内联 `<img>`/`<svg>` 位图资源：

- **导入自由画布继续视觉打磨**：调用 `studio_open_project({ projectDir, cwd, sourcePath: "page.html" })`（或传 `https://...` URL），工程目录下会保留 `.imported-html.rp1` 与 `.imported-html.spec.json`，可直接用 `studio_design(action:"fix_plan", apply:true)`、`studio_command` 与 `studio_export({ format: "rp" | "rp1" | "code" })`。
- **一步直接生成原生 `.rp` + 伴随 `.rp1`**：调用 `generate_prototype({ source: "page.html", output: "app.rp", verify: true, verifyEngine: "auto" })`（同时支持 `cwd` 与 `verifyEngine: "studio-html"` 跨平台无 Axure 自验）。

---

## 备选底层手工路径：浏览器 dump → Axvg

若目标页面需要人工登录态或仅做静态视觉草稿，可在浏览器控制台注入以下 JS 获取 `window.__dump` 后映射为 Axvg spec。

使用当前任务指定或默认的浏览器打开 HTML（file:// 路径或本地服务均可），在所用浏览器工具允许时执行以下 JS。结果会存到 `window.__dump` 并在控制台打印复制：

```js
(() => {
  const skip = new Set(['SCRIPT','STYLE','LINK','META','HEAD','TITLE','NOSCRIPT','BR','PATH','SVG','DEFS','G']);
  const out = [];
  const walk = (el, depth) => {
    if (depth > 12 || out.length > 400) return;
    for (const c of el.children) {
      if (skip.has(c.tagName)) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const r = c.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) {
        out.push({
          tag: c.tagName, id: c.id || undefined,
          cls: (c.className && String(c.className).slice(0, 40)) || undefined,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          bg: cs.backgroundColor, radius: cs.borderRadius === '0px' ? undefined : cs.borderRadius,
          border: cs.borderTopWidth !== '0px' ? { width: cs.borderTopWidth, color: cs.borderTopColor } : undefined,
          color: cs.color, fontSize: parseFloat(cs.fontSize), fontWeight: parseInt(cs.fontWeight) || 400,
          text: c.children.length === 0 ? (c.textContent || '').trim().slice(0, 120) : undefined
        });
      }
      walk(c, depth + 1);
    }
  };
  walk(document.body, 0);
  window.__dump = JSON.stringify({ pageW: document.documentElement.scrollWidth,
    pageH: document.documentElement.scrollHeight, elements: out }, null, 1);
  console.log('elements:', out.length, '— 执行 copy(window.__dump) 复制，或直接读取 window.__dump');
  return 'dumped ' + out.length;
})()
```

随后 `window.__dump.slice(0, ...)` 分段读出（大页面分多次），拼成 layout.json 落盘。

## 第 2 步：过滤与映射

dump 是原始树，需要过滤后才写 spec：

- **去重**：同一视觉元素会因子节点重复出现，保留最外层带 bg/border 的节点；纯容器（无样式、只包一个子节点）跳过。
- **文本**：取 `children.length === 0` 且有 text 的节点 → `kind:"text"`（color/fontSize/fontWeight 直传；坐标用节点矩形）。
- **背景块**：`bg` 非 rgba(0,0,0,0) → `kind:"rect"`（fill 换算 hex，透明度 <0.05 跳过）。
- **圆角**：`radius` 为 Npx → `corners: N`；`50%` 或 ≥宽高一半 → circle。
- **边框**：四边等宽 → `border:{color,thickness}`；只有下边框 → 视作 hline。
- **图片**：`<img>`/背景图 → **内嵌真实图片**（破解后的能力，不再是占位）：
  1. 取 `img.src`（绝对化；相对路径拼页面 URL），fetch 下载字节；
  2. 非 JPEG 时转 JPEG（`sips -s format jpeg`）；base64 编码，以图片字节的 SHA1 作 key；
  3. spec 顶层 `"images": {key: base64}` + 元素 `{"kind":"image", imageKey:key, x,y,w,h}`；
  4. 大图（>300KB）先缩到显示尺寸再编码，避免 Axvg 过大。
- **SVG 图表**：按要求重建为 line/pie/shape，或内嵌图像并说明可编辑程度；用户允许简化时才使用占位。
- **z 序**：dump 顺序即 DOM 顺序，先背景后前景；明显叠放的卡片保留外层框 + 内部元素。
- **滚动容器**：只取首屏可见范围，超出部分按整页高度继续画（用户要求全页时保留全部）。

坐标从 viewport 换算到页面绝对坐标：`y_page = y_viewport + scrollY`。整页高度直接用 dump 的 pageH。

## 第 3 步：构建粘贴验证

与截图复刻共用管线：写 spec → `build` → `paste` → 保存 `.rp` → 重新生成预览并与原 HTML 对照。对照时重点核对：块的位置层级、文字内容、颜色。

## 边界

- 此流程提取静态视觉。用户要求交互时，另按 [离线工作流](rp-workflow.md) 映射，表单外观并不自动成为 Axure 原生输入控件。
- 当前 dump/spec 不完整覆盖渐变、阴影、变换、伪元素及混合文本；要求保真时补充提取或编码，降级需在交付中说明。
- 字体：Axvg 只可靠支持 Inter 及回退系统字体，特殊字体按字重映射到 Inter 四档。
