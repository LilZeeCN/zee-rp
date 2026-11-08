# 阶段上下文与工程设计决定

本地开发快照，2026-10-29。阶段入口复用现有工具；[设计工艺与候选理由](studio-craft.md)随当前阶段提供，不另存竞争设计源。

## 三次调用开始创作

1. `studio_open_project({projectDir:"/abs/project",domain:"mobile"})`，取得真实页面与版本。
2. `studio_stage({projectDir:"/abs/project",stage:"skeleton",intent:"learning",platform:"mobile",target:{pageId:"home"},brief:{task:"先回忆再揭示答案",content:["完整单词与例句"],states:["回忆","揭示","记住","重练"]}})`。
3. 依据 `binding.revision`、`target.page.insertionParentId`、父 padding 与 `authoring.nextCall` 提交 `studio_command`。不要把示例稿直接当成用户要求。

`stage` 可为 `planning/skeleton/content/refine/review/edit`，是按需知识视角，不会自动改稿或强制依次经过每一步。`intent` 为 `learning/task/editorial`，`platform` 为 `mobile/web`。现有五套可编辑参考覆盖字形学习、精确表单、摄影长文、密集目录和温暖词记；读取 `availableReferencePacks`，通过 `referencePackId/referencePageId` 显式选择。旧顶层 `pageId` 仍是旧栖羽参考页；当前工程页放在 `target.pageId`。

`includeSource:true` 返回所选参考页源，`includeImages:true` 附真实预览。默认文字预算 `maxBytes:12000`（允许4000–48000），图片体积单列。先省略参考源和可补取的设计材料；关键目标或约束仍放不下时返回 `ready:false/E_DESIGN_CONTEXT_BUDGET`，不提供截断后可直接提交的伪建议。字节不是模型token。

## 局部改稿

```json
{"stage":"edit","intent":"editorial","platform":"web","target":{"pageId":"article","revision":8,"nodeIds":["article/body"]}}
```

局部选择必须绑定当前版本，可附 `documentId/contentHash`。过期、空选择或无法映射到源的目标不会扩大成整页。返回完整可写文字、控制源、布局与建议命令；宏内部使用宏参数，实例内部使用覆盖。`textTruncated` 或 `requiresFullSource` 仍存在时，先取得完整源，不能用摘要重写正文。`edit` 默认省去整套参考与起稿指导。

## 设计决定与普通编辑一起保存

`recordDesignDecision` 是普通命令，与视觉改稿同一事务，支持幂等、撤销、重做、WAL恢复与保存重开：

```json
{"type":"recordDesignDecision","decisionId":"word-first-v1","scope":{"kind":"page","pageId":"home"},"subject":"direction","outcome":"accepted","choice":"单词为主角，释义在揭示后出现","reason":"先促使回忆，再提供反馈","feedback":{"source":"agent"},"reference":{"id":"deep-recall-mobile","version":"1.0.0"}}
```

`subject` 为 `brand/direction/typography/palette/material/layout`；`outcome` 为 `proposed/accepted/rejected`。范围须明确为 `project`、`page` 或带非空源ID的 `node`。`feedback.source` 为调用者声明的 `user/agent/unknown`；代录用户原话还需 `quote/evidenceRef`。无论来源，系统都不会自动将当前画面或参考作品标为用户审美认可。

上下文返回有效、拒绝、过期及冲突记录。默认品牌决定依赖工程主题、色板、tokens和字体声明，局部决定依赖对应源；也可用 `dependsOn.tokenNames/sourceTargets/decisionIds` 精确声明。依赖改变或源被删后排除旧决定；不因无关文案变化让品牌决定失效。依赖校验覆盖工程声明，不声称检测磁盘外字体文件的任意变化。

替代记录需新ID并显式 `supersedes` 同范围、同主题旧ID，原始记录和反馈保留。代理不能替代用户约束。互相矛盾的有效选择显示冲突并返回 `ready:false`；不会暗中取最新一条。

CLI使用 `node bin/axure.mjs studio design-context --project /abs/project --input /abs/context.json`；输入JSON与MCP相同。命令参数可按需通过 `studio_describe({topic:"command",name:"recordDesignDecision"})` 发现。参考作品的浏览器、原生结构、宿主和用户评价须分别看其清单，不能相互替代。

命名版本恢复与当前画布选区共享见 [版本与选区](studio-versions.md)。
