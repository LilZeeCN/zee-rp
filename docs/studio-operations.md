# 长操作、进度与取消

本地开发快照，2026-10-29。候选预演、素材处理、原生导出继续使用原来的执行函数，可选 `async:true`；它们在独立工程目录留存输入、状态、日志和结果。当前异步进程组终止支持 macOS/Linux；只在本机 macOS 验证，Windows 异步入口明确拒绝，同步用法不变。

```json
{"projectDir":"/abs/project","pageId":"home","baseRevision":3,"requestKey":"recall-options-01","async":true,"candidates":[{"id":"reading","label":"问题先行","designIntent":{"reason":"以问题作为第一阅读焦点","tradeoff":"次要信息延后","axes":["reading-order","typography"]},"commands":[{"type":"setProperties","nodeId":"word","properties":{"fontSize":44}}]}]}
```

上例传给 `studio_design(action:explore)`。`studio_media` 和 `studio_export(format:rp)` 也接受相同的 `async/requestKey/baseRevision`。异步导出保存在该操作独立目录；需要自定义输出路径的覆盖式导出沿用同步入口。`baseRevision` 必须仍为当前版，不暗中选择历史版或最新稿替代。

返回 `id/binding/status/phase` 后，用 `studio_operations`：

```json
{"projectDir":"/abs/project","action":"get","requestKey":"recall-options-01","includeResult":true}
```

`id` 和 `requestKey` 二选一；`action:list` 可带 `limit:1..100`，`action:cancel` 请求取消。MCP断连或Studio服务关闭后，工作进程仍能完成；查询工程目录不要求原服务仍活着。相同身份、相同参数始终核对同一记录，改参数会拒绝，不重新执行失败或中断的操作。`resultPath` 指向保留的完整结果；默认摘要不携带图片字节。结果过期仍可检查，公开完整结果会移除 `applyWith/registerCommand` 提交建议。

`status` 区分 queued/running/cancelling/succeeded/failed/cancelled/interrupted。阶段来自实际执行点，没有估算百分比。取消先记录并发送终止请求，只有核实所属进程组已退出才报告 cancelled/stopConfirmed；仍未停则继续显示 cancelling。进程身份不符时不发信号。发布已开始时返回 completion_in_progress，不把它称为已取消。强制中断保留现场并报告 interrupted，不自动重做。

设计源与已登记资源在开始时绑定；工作进程使用隔离副本，冻结前发现资源变化会失败。预演/导出不提交源。素材成功后只把新增的内容寻址资源拷入工程，已存在的不同字节文件不覆盖；挂载与登记仍由普通画布事务完成。候选选中后沿用原版本保护提交。

GUI 顶栏“操作”显示同一份持久记录、当前阶段、取消状态、旧稿提示及结果位置；“导出 .rp”使用异步入口。关闭面板不会取消，重新打开会从磁盘记录恢复。CLI 使用 `studio operations|explore|prepare-media|export-rp --project /abs/project --input /abs/request.json`。

命名版本/撤销历史与长操作记录分开。长操作现场不自动清理，保留输入与失败供核查；当前阶段尚不承诺跨平台终止、断电持久性或任意工程的资源携带。

命令错误与截图发现还包含版本绑定的diagnostic/location：作者节点、源宏参数/实例覆盖与解算范围。GUI“对照”的“定位图层”和操作记录中的“定位问题图层”使用同一目标；旧版本拒绝定位。fieldSupport区分只读、无消费、宏未暴露属性与尚未核验；能定位不意味着任意字段都能写。未解析目标保持明确缺口，不找相近节点代替。
