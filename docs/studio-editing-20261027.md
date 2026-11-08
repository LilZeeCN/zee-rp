# 自由画布：关系编辑与画面对照

2026-10-29追加：拖动和缩放期间按Esc会恢复预览几何，随后松手不再提交；窗口失焦清理待提交手势和Space按压。页面切换及收到服务端快照时取消旧手势，重新绘制权威场景。每个手势绑定开始时的pageId/baseRevision，延迟的新版本通知不能让旧位移覆盖AI新稿；失败后取回服务端状态。实际指针专项覆盖取消后继续编辑、失焦事件、已收到和刻意延迟的竞争快照，不代表macOS窗口/原生输入法或完整连续编辑矩阵通过。

这次改动落在正式 Skill 目录的实际 Studio。目标是减少 AI 改稿时维护坐标和逐节点参数的操作量，并让修改前后的画面可直接检查。

## 关系与批量编辑

在 `studio_command.commands` 中使用 `editNodes`，仍然提交当前 `baseRevision` 和唯一 `idempotencyKey`。选择器支持 `pageId`、`nodeIds`、`role`、`type`、`textContains`、`within`，多个条件取交集。只传 pageId 或没有匹配节点会明确报错；有歧义时返回候选 scopedId。跨页批量属性修改可用完整 scopedId。

```json
[
  {
    "type": "editNodes",
    "select": { "pageId": "home", "nodeIds": ["card_a", "card_b"] },
    "operation": "align",
    "edge": "left",
    "referenceId": "title"
  },
  {
    "type": "editNodes",
    "select": { "pageId": "home", "nodeIds": ["example"] },
    "operation": "place",
    "side": "below",
    "referenceId": "meaning",
    "gap": 20
  },
  {
    "type": "editNodes",
    "select": { "pageId": "home", "within": "word_card", "role": "secondary-text" },
    "operation": "set",
    "properties": { "color": "$muted" }
  }
]
```

- `align`：`edge` 为 left/right/top/bottom/center-x/center-y；不指定参照时，对齐选中集合的外包围盒。
- `place`：`referenceId`、`side` 和 `gap` 定位；多个目标均相对同一个参照放置，顺次排列请用 distribute。
- `move`：`dx`、`dy` 表示局部坐标平面内的增量。
- `distribute`：`axis:x/y`、可选 `gap`；按现有视觉顺序分布，不指定 gap 时保留集合两端并均分间隔。
- `set`：批量修改 properties，可绑定已有 token。修改 token 本身继续使用 setToken；组件定义继续使用已有组件命令。

关系定位只处理同一页面内自由布局节点，支持带 padding 的嵌套父容器。流式/grid 子项、变换坐标平面、同时选中父子、受 after/alignX/pin 控制的定位均明确拒绝；不暗中拆组件或转换布局。一个目标失败时整批事务回滚，撤销/重做和持久化复用现有命令总线。

## 看图对照

编辑器顶栏新增「对照」。首次记录当前画面；改稿后再次点击，显示此前记录与当前画面，以及变更图层边框。可关闭弹窗继续编辑。对照记录保存在工程的 design-reviews 目录。

AI 先创建一次 `studio_design(action:review)`，之后使用当前版本与此前的 `compareWithReviewId`：

```json
{
  "pageId": "home",
  "baseRevision": 8,
  "compareWithReviewId": "此前工具返回的 reviewId"
}
```

返回两张真实图片（先旧后新）、`comparison.changedNodes` 与 `comparison.checkChanges`。旧图片直接读取此前保存的文件并验证 SHA，当前图片重新截图。变更范围来自节点的实际布局边界，是图层范围标记，不宣称逐像素差分；旧记录没有节点快照时需要新建基准。同页、版本与截图期间的并发变化都会校验。

评审中的确定问题与风格建议分开记录：对比度不足或未知、文字越界、缺图、点击区不足等仍是问题；网格、字阶、主次、配色和反 slop 作为建议。原始设计指标与 L1 结果继续保留，不把建议降级说成指标已通过或用户认可。

## 基础编辑修复

拖拽、缩放、键盘位移和属性输入写回源坐标，避免把父容器 padding 再叠加一次。缩小时隐藏会盖住文字中心的上下/左右边中点手柄，仍可用角手柄缩放。新建空白页面默认 stack、padding 0；显式声明的流式布局不变；新建页面后自动适应当前画板。布局警告从当前文档重算，布局改正或节点删除后不残留。

浏览器自身的命令写入排队，并拒收同会话内倒退的快照。结束文字编辑的点击不会继续开启容器拖动。来自其他客户端的过期版本写入仍然拒绝，不自动覆盖。

## 验证与范围

本机证据与日志位于 `outputs/canvas-editing-20261027/`。新增 `npm run test:studio-editing` 覆盖事务边界、关系求解、像素截图对照和新 MCP 连接；真实 Ego Lite 另验拖拽、连续编辑、新页定位和画面对照。拾词副本作为多页改稿及导出样本，原工程保留。

本轮交付上述编辑与对照能力。RP/1 增量衔接、更多构图探索、内容层级重构属于后续工作，不计入本轮完成范围。
