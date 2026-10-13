# 验证流程

统一入口见 [验证文档](../docs/validation.md)。`npm test` 可在没有 Axure 的环境运行；`test:native` 从使用者本机模板/库生成样本；`test:mcp` 验证真实传输；历史套件要求精确外部样本包。

分别记录构造、结构/语义、原生加载、实际预览行为、GUI 编辑保存关闭重开。三个结构计数为零不能代替后面三层验收。Mock jobs 不能作为原生 GUI 验收。

每次只对新副本实验，保存后重新读取磁盘文件，并验证目标属性和既有内容。不能把一个样本或一组参数通过推广为任意控件、容器、平台和 build 都通过。历史细节见 [样本能力记录](../docs/historical-capabilities.md)，本版实际结果见 [发布证据](../docs/release-evidence.json)。
