# Studio 可编辑矢量路径、SVG 互操作与布尔运算 (`V01`)

本文档定义 Studio 自由画布的可编辑矢量对象模型（`type: 'path'` 及简写语法糖 `path` / `sparkline`）、SVG 子集导入导出、布尔运算（`union` / `subtract` / `intersect` / `exclude`）以及 Axure RP 9 原生 `VectorShape`（`Shape: 300`）与宿主降级边界。

---

## 1. 矢量对象语义与数据结构

Studio 中的矢量节点统一归一化为 `type: 'path'`，同时支持在权威源文档与 RP/1 简写中声明：

```json
{
  "id": "custom_badge_shape",
  "type": "path",
  "x": 24,
  "y": 120,
  "w": 160,
  "h": 120,
  "d": "M 0 0 L 160 0 L 160 120 L 0 120 Z M 32 32 L 32 88 L 128 88 L 128 32 Z",
  "fill": "$brand",
  "fillRule": "evenodd",
  "stroke": "$ink",
  "strokeWidth": 2,
  "strokeLinecap": "round",
  "strokeLinejoin": "round",
  "viewBox": { "x": 0, "y": 0, "w": 160, "h": 120 }
}
```

### 核心字段
- **`subpaths`**: 数组，每条子路径包含 `{ closed: boolean, hole?: boolean, points: [{ x, y, in?: {x,y}, out?: {x,y}, q?: {x,y}, curveType?: 'line'|'quadratic'|'cubic' }] }`。
- **`d` / `svgD`**: 标准 SVG Path 字符串（支持 `M/m`, `L/l`, `H/h`, `V/v`, `Q/q`, `T/t`, `C/c`, `S/s`, `Z/z`）。
- **`points`**: 折线或趋势线简写点集（支持 `[[x,y], ...]`、`[{x,y}, ...]` 或 `"x1,y1 x2,y2 ..."`），结合 `smooth: true` 自动生成 Catmull-Rom 转化为三次贝塞尔控制柄。
- **`content` / `svg`**: 可编辑 `<svg>` 片段，自动解析 `<path>`, `<polygon>`, `<polyline>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<g transform="...">`，并将 2D 仿射变换（`translate`, `scale`, `rotate`, `skewX`, `skewY`, `matrix`）烘焙进可编辑控制点。
- **`fillRule`**: `'nonzero'`（默认，非零环绕数规则）或 `'evenodd'`（奇偶交叉规则）。
- **`strokeLinecap` / `strokeLinejoin` / `strokeDasharray`**: 端点样式、转角连接与虚线数组。

---

## 2. 命中检测、直接操控与命令契约

### 精确几何命中 (`hitTestVectorPath`)
1. **控制点与手柄命中**: 优先检测顶点锚点（`anchor`）与曲线控制柄（`in` / `out` / `q`）。
2. **描边命中**: 对每段直线或离散化贝塞尔曲线计算点到线段的最短距离（含 `strokeWidth / 2 + tolerance`）。
3. **闭合区域与孔洞命中**:
   - `fillRule === 'evenodd'`: 射线奇偶交叉数；内孔（`hole: true`）内部返回 `insideFill: false`。
   - `fillRule === 'nonzero'`: 有向环绕数（winding number）非零判定；反向环绕内孔内部返回 `insideFill: false`。

### 命令契约
- **`editPath`**:
  - `operation: 'set-point'`: 修改指定 `subpathIndex`、`pointIndex` 的锚点（`handle: 'anchor'`）或曲线控制柄（`handle: 'in' | 'out' | 'q'`）。
  - `operation: 'insert-point'` / `'delete-point'`: 插入或删除控制点。
  - `operation: 'toggle-closed'`: 切换子路径闭合状态。
  - `operation: 'set-d'` / `'set-subpaths'` / `'import-svg'`: 更新路径数据或导入 SVG。
  - `operation: 'transform'`: 对路径执行平移、缩放、旋转仿射变换。
  - `operation: 'smooth'`: 计算或清除平滑贝塞尔手柄。
  - `operation: 'set-fill-rule'`: 切换 `nonzero` / `evenodd`。
- **`booleanPathOp`**:
  - 支持 `operation: 'union' | 'subtract' | 'intersect' | 'exclude'`。
  - 传 `editable: true` 创建实时布尔组。两个闭合二维路径须同属一个自由布局容器，`nodeIds` 的顺序决定减法方向。`resultId` 可指定组 ID。画布双选路径后，属性面板的布尔按钮使用此模式。
  - 从图层列表选择组内操作数，拖动路径或编辑控制点时可以看到结果实时更新。撤销、重做和项目重开从源操作数重算。
  - 将两个闭合矢量路径投影至统一画布平面，执行平面线段求交细分、法向内点采样分类与环方向规整（外环正面积、内孔负面积 `hole: true`）。
  - **显式诊断边界**:
    - 未闭合路径返回 `E_VECTOR_NOT_CLOSED`；
    - 少于 3 个顶点的退化多边形返回 `E_VECTOR_DEGENERATE`；
    - 非简单自交环返回 `E_VECTOR_SELF_INTERSECTION`；
    - 绝不静默生成损坏几何。

---

## 3. Axure RP 9 原生 `Shape: 300` 与节点级降级边界

Studio 导出 `.rp` 时将 `type: 'path'` 编译并修补为 Axure RP 9 原生 `VectorShape`（`Shape: 300`，含 `CompoundType` 与 `ControlPoints` 数组），并在 `syncNativeRpToStudio` 中支持检测 RP9 端对 `ControlPoints` 的编辑回填（生成 `editPath` 命令）。

可编辑布尔组在独立 HTML 和 RP9 中使用导出时的结果轮廓。RP9 将非空结果写成可编辑的 `Shape: 300`，并在兼容报告列出 `booleanOp.live`。实时操作数关系由 Studio 源文档保存，原生结果的控制点无法映射回两个操作数。

| 矢量特征 | 画布与代码出口 (`canvas` / `G01`) | Axure RP 9 导出 (`.rp`) | 节点级兼容性分类 (`classifyVectorNativeCompatibility`) |
| --- | --- | --- | --- |
| 单子路径折线 / 闭合多边形 | 原生 `<svg><path>` 完整可编辑 | 原生 `Shape: 300` (`ControlPoints` 完整可编辑) | `nativeEditable: true` (`rp9-vector-shape-300`) |
| 二次 / 三次贝塞尔曲线 (`Q` / `C` / `smooth`) | 原生控制柄完整可编辑 | 转为 `Shape: 300` 自适应采样顶点可编辑 | `nativeEditable: false`, `reason: 'bezier-handles-flattened-to-rp9-control-points'` |
| 复合多子路径 / 布尔内孔 (`subpaths.length > 1`) | 原生多子路径与孔洞完整保留 | 单一 `Shape: 300` 表达外轮廓，并在报告中标记复合路径边界 | `nativeEditable: false`, `reason: 'multiple-subpaths-or-holes'` |
| `fillRule: 'evenodd'` 奇偶环绕 | 原生 SVG `fill-rule="evenodd"` | RP9 单一 `VectorShape` 仅使用默认环绕，记录节点级提示 | `nativeEditable: false`, `reason: 'evenodd-fill-rule'` |

> **铁律**：任何超宿主矢量特性仅在节点级 `vectorCompatibility.degradedNodes` 中逐节点列出原因，**绝不把整页静默栅格化为位图**。
