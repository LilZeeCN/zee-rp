# 创作体验评测

任务集固定后，不在同一轮中途修改工具实现。记录 MCP 的 `runtime_info`、模型、平台、
模板及环境是否已经打开。脚本范例复用测试和独立 AI 从需求开始创作分别报告。

工具基准使用 `npm run bench:authoring -- /absolute/new-directory`，输出逐题结果和逐次调用。
耗时从工具发起到返回，包含生成/合并/结构读取，不包含模型思考、查文档和 GUI 交互。
基准没有真实预览时，`nativePreview` 保持 false，`firstUsableDraftMs` 保持 null。
失败的题保留失败原因，不能删掉后只计算成功均值。

独立试用应给执行者需求与正常工具文档，不提供已完成的解答；首稿之后再给改稿要求。
评测者不通过模板名猜测应该怎样实现；允许使用工具支持的合理结构。
同题比较必须内容、交互、原生可编辑要求和验证阶段一致，顺序交替，版本固定。

每题至少记录：

```json
{
  "task":"habit-cards",
  "runKind":"independent-authoring",
  "runtimeFingerprint":"填写活动 MCP 指纹",
  "model":"实际模型与推理设置",
  "startedAt":"ISO timestamp",
  "firstUsableDraftMs":null,
  "toolCalls":null,
  "documentationReads":null,
  "repairRounds":null,
  "modelTokens":null,
  "nativePreview":false,
  "guiSaveReopen":false,
  "evidence":[],
  "failure":null
}
```

无法观测的值保持 null。第一次环境配置单列，临时创建的组件与辅助脚本计入创作时间。
通过真实预览及约定交付要求后才能记录可用首稿时间。不能把执行脚本写好的流程视为
未见需求的独立 AI 测试，也不预设必须达到某个分数或提升百分比。
