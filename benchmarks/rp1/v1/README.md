# RP/1 固定验收集 v1

2026-10-20 冻结：30 道自然语言需求，6 类场景。`development.json` 20 题用于开发；`heldout.json` 10 题留给之后的新会话。每题包含固定样本、业务检查点、视觉要求和原生编辑要求。它们不是已生成的答案，也没有宣称 30 题通过。

本轮作者看过全部题目，因此这 10 题只能作为后续新会话的保留题；若同一作者继续调参，不能称独立盲测。独立评审应另外提供未提前公开的需求。

先运行：

```sh
python3 scripts/rp_benchmark.py verify
python3 scripts/rp_benchmark.py prompt --task RP1-01
```

向执行者只发 `prompt` 的输出和正式 Skill。评分者保留 `acceptance`，不得在生成之前给答案。每题用 3 个新会话冷启动，共 90 次，先保存首次源码、诊断和生成产物，再允许修复。统一记录模型、源码摘要、首次成功、修复轮数、人工改动、耗时、RP 摘要及真实证据路径。

`manifest.json` 固定了题目 SHA-256、分组和满分门槛。评分之后不得修改题目；题意有错时创建 v2，保留 v1 及全部失败结果。不能把同一个最终成品重复打开三次当作三个冷启动。

结果为 JSON 数组；每条必须有：

```json
{
  "taskId": "RP1-01", "trial": 1, "model": "填写实际模型与版本",
  "sourceHash": "实际源码SHA256", "rpHash": "实际RP文件SHA256",
  "firstGenerationPass": false, "repairRounds": 1, "manualEdits": 0,
  "elapsedSeconds": 0,
  "nativeBehavior": false, "guiSaveReopen": false, "guiEdit": false,
  "visualReview": false, "evidence": ["填写本次验收证据路径"]
}
```

上面只是字段示例，不是测量结果。`firstGenerationPass` 指首次生成即满足业务、原生、视觉、编辑验收；只编译成功应另记编译率。`manualEdits` 记录为修复成品做的手工改动，验收中要求的标题改字单独写入证据。

```sh
python3 scripts/rp_benchmark.py report --trials /absolute/path/trials.json
```

报告只统计已有结果，缺失试验不会补成成功，也不会自动打分。验收流程见 [原生复验手册](../../../references/native-acceptance.md)。
