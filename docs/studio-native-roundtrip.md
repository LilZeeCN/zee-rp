# 原生手工修改回到同一画布

本地开发快照，2026-10-30。`studio_merge(kind:sync_native)` 提供一键 `preview` / `apply` 双向收敛入口，复用同一 Studio 源文档、基线符号映射与原子事务。

1. 用 `studio_export(format:rp)` 导出基准，保存 `.rp`、`.baseline.json`、`.rp.source/source.json` 和兼容报告。出口同时保存带 SHA 的 `.rp.source/studio-document.json` 完整作者源，包含原始布局、宏、组件实例、面板状态和中继器模板绑定。
2. 复制或直接在 Axure RP 9 中改字、改几何、改样式并保存关闭重开。读取和同步以原生 GUID 与基线 `sourceMap` 保持身份，自动映射到 Studio `scopedId` 与真实作者 `target` / `propertyMap` / 父内容盒坐标。
3. 使用 `studio_merge(kind:sync_native)` 预览或回填原生差异：

```json
{
  "rpPath": "/abs/gui-edited.rp",
  "mode": "preview",
  "prefer": "fail"
}
```

确认预览返回的 `previewHash`、`commands`、`ignoredFlowPositions`、`formulaProtectedNodes` 与 `conflicts` 后，调用 `apply` 原子写回：

```json
{
  "rpPath": "/abs/gui-edited.rp",
  "mode": "apply",
  "baseRevision": 4,
  "previewHash": "预览返回的previewHash",
  "idempotencyKey": "apply-native-once"
}
```

4. 自动收敛规则：
   - **普通节点**：按父内容盒相对偏移更新 `sourceX`/`sourceY`、尺寸、文本、字号、字体、颜色、圆角与重命名。
   - **流式布局子节点（row/column/grid）**：应用文本、尺寸与样式修改，自动忽略原生绝对坐标漂移并在 `ignoredFlowPositions` 中返回父容器 `setLayout` 间距建议，不污染流式排布语义。
   - **宏展开子节点（card / list-item）**：通过 `target.propertyMap` 自动回填到源宏参数（如 `title`、`titleFontSize`、`subtitle`、`body`），内部不可控几何偏移列入 `unsupportedNativeChanges`。
   - **组件实例覆盖**：自动生成 `setInstanceOverride` 写入实例指定 `subNodeId`，保持组件母版定义与其他实例不被污染。
   - **动态面板非激活状态**：支持直接定位并回填非激活状态（如 `st2`）内部节点的文本、几何与样式。
   - **中继器模板**：对模板节点的字号、颜色、几何修改自动回填到唯一 `template` 源节点并刷新全部行；默认保护 `=item.xxx` 与 `${item.xxx}` 绑定公式不被原生首行预览字面量覆盖（列在 `formulaProtectedNodes`）。
   - **多页与三方冲突**：当画布与原生同时修改同一节点的同一字段且值不同时，`prefer: "fail"` 拒绝盲目覆盖并列出冲突明细；可通过 `prefer: "studio" | "native"` 或 `resolutions` 显式裁决后单次撤销原子提交。
