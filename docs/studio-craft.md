# 有依据的设计探索

`studio_stage` 的非 edit 阶段返回 `craft`。它根据当前范围的有效 `direction` 决定返回 `continue-direction` 或 `explore-direction`；冲突仍阻止不明确的提交。代理决定可供后续沿用，反馈来源不因此变成用户。过期决定不会继续指导新稿。局部 edit 不携带全套构图指导。

没有工程时，`studio_describe({topic:"craft"})` 返回通用说明；当前项目的真实选择以阶段上下文为准。有效设计方向已经明确时，不要求重选或重复询问。未知事实不要从参考作品填入本项目。

候选的 `id` 和 `label` 保持稳定，可附：

```json
{"designIntent":{"reason":"以问题为第一阅读焦点","tradeoff":"首屏可见列表项减少","axes":["structure","reading-order"]}}
```

`axes` 可选 `structure/reading-order/typography/density/imagery/interaction`，不重复。未定方向时通常比较三案，在至少两个维度形成可见差别；数量是指导，不是调用门槛。这些理由来自调用者，服务只检查契约并随结果保存；它们不能证明实际视觉差异，也不会替代真实状态预演。看返回联系图后再选择 `applyWith`。

`studio_design(action:review)` 的每条 `observations` 可附 `consequence`（对用户任务的影响）和 `preserve`（应保留的有效部分），与现有 `nodeIds/issue/decision` 一起保存。只评实际看到的版本和状态。机器指标、代理意见、用户选择及原生行为分别记录；没有审美自动通过。

本机制借鉴设计工艺、稳定候选和带影响的评审，不引入第二种设计源格式。RP/1、源宏参数、组件实例覆盖和普通事务继续承担真正的编辑。
