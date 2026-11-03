# 首批完整设计参考包

- `deep-recall-mobile`：learning/mobile，深海回忆，词义回忆与两分支反馈。
- `materials-desk-web`：task/web，材间，连续预约表单、必填错误与成功回显。
- `shore-notes-web`：editorial/web，岸线，非对称图文首页、连续阅读与收藏。

每包的公开入口为 `manifest.json`，可编辑源为 `source.json`。源中页面与节点 ID 固定，保留语义 role，素材路径相对包目录。`files` 冻结包内除 manifest 自身外的文件 SHA-256。截图、交互和原生兼容结果以各包及任务输出的验证记录为准；用户审美认可仍为 false。
