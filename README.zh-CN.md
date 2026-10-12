<div align="center">

# ⚡ zee-rp

**开源的 Axure RP 11 原型文件引擎与 MCP 服务器。**

*把截图、HTML 或布局规格变成可编辑的 Axure 元件；让 AI 直接读取、修改和生成真实的 `.rp` 文件——全部经过原生 Axure 应用验证。*

[English](README.md) • [快速开始](#-快速开始) • [MCP 接入](#-mcp-接入) • [能力矩阵](#-能力矩阵) • [安全模型](#️-安全模型)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/Runtime_Dependencies-0-orange.svg)](package.json)
[![Regression Tests](https://img.shields.io/badge/Regression_Tests-225%2F225-success.svg)](test/)
[![MCP Tools](https://img.shields.io/badge/MCP-42_Tools-purple.svg)](bin/mcp.mjs)

</div>

> **商标声明** —— Axure RP 是 Axure Software Solutions, Inc. 的注册商标。zee-rp 是独立的开源研究与工具项目，与 Axure Software Solutions, Inc. **不存在**隶属、赞助或背书关系。

---

## 💡 zee-rp 是什么？

二十年来，**Axure RP** 一直是高保真企业原型设计的行业标准——但它的专有 `.rp` 二进制格式始终是一个未公开文档的黑盒：没有公开规范，没有官方 API。想用程序读写真实 Axure 原型，过去基本不可能。

zee-rp 改变了这一点。

基于对文件格式数月的逆向工程与 IL 指令级分析，zee-rp 是一个**零依赖的 Node.js 引擎**，原生解析、构造和编辑 Axure RP 11 原型文件。配合 **42 个工具的 MCP 服务器**，AI 代理（Claude、Cursor、Codex、Windsurf）可以直接操作真实 `.rp` 文件：

- 📦 **0 运行时依赖** —— 纯 ESM JavaScript，9,000+ 行原创代码
- 🔬 **格式真值，不靠猜** —— 自研 LZ4 manifest 编解码、.NET 类型化二进制 payload 解析器、GUID 闭包解析
- 🛡️ **安全写入优先** —— 原子链式工作副本、写根沙箱、任何结构校验失败自动回滚

## 📸 实际效果

一张整页 UI 截图被重构为原生 Axure 页面：**121 个可编辑元件、16 张内嵌图片，平均像素误差仅 7.97/255** ——不是一张贴图，而是可以在 Axure 里继续编辑的真实元件。

![页面视觉效果与可编辑元件边界对比](assets/demo-comparison.png)

*左：渲染后的页面效果。右：同一页面中每个元件都可独立选中、继续编辑。*

## 🚀 亮点

* 🧠 **逆向工程二进制内核** —— 解析并重新编码 LZ4 manifest、gzip 记录边界，以及带 GUID 闭包的 .NET 类型化 tag payload 图。
* 🤖 **原生 MCP 集成** —— 42 个工具：检查页面树、定位元件、批量改文本与富文本、增删交互、管理中继器数据、校验文件完整性、驱动 GUI 往返任务。
* 👁️ **视觉 → Axure** —— 输入截图、HTML 快照或布局规格，产出真正的可编辑元件：矢量形状、原生文本 run、内嵌图片。
* ⚡ **真实交互保真度** —— 以程序化方式构建原生 Axure 行为：
  * 动态面板（多状态、嵌套、适应内容）
  * 中继器（数据集、排序、筛选、行级增删改、分页）
  * 条件逻辑（If / ElseIf / Else，支持递归表达式树）
  * 母版（定义、依赖树、实例文字/图片覆盖）
  * 连接线（默认边与自定义锚点）、自适应视图、原生表格
* ✅ **一切按证据分级** —— 225/225 自动回归检查，并对照真实 Axure RP 11 的保存/关闭/重开循环验证行为。

## 🛠️ 快速开始

**前置条件**：Node.js ≥ 18、Axure RP 11（已在 macOS build 11.0.0.4137 验证；Windows 暂未测试）。

零构建步骤，核心 CLI 不需要 `npm install`：

```bash
# 解析检查任意已有 .rp 原型
node bin/axure.mjs rp-read /absolute/path/to/source.rp --json

# 把某个元件的文字安全改写到新文件
node bin/axure.mjs set-widget-text /path/to/source.rp /path/to/output.rp \
  "Page 1" "SubmitButton" "Click to Confirm"
```

所有写入都落到**新文件**——源 `.rp` 永远不会被原地修改。

### 本机空白模板

本仓库刻意**不携带任何 Axure `.rp` / `.rplib` 文件**。要从零创建工程，先在你自己的 Axure RP 11 里保存一个单页空白工程，然后：

```bash
export AXURE_BLANK_TEMPLATE=/absolute/my-native-blank.rp
node bin/axure.mjs create-blank-project /absolute/output-root/new.rp
```

未设置环境变量时，回退读取
`~/Library/Application Support/zee-rp/templates/axure-rp11-blank.rp`。

## 🤖 MCP 接入（Claude / Cursor / Codex / Windsurf）

```bash
npm ci --ignore-scripts   # 可选：只安装 MCP SDK
node bin/mcp.mjs
```

SDK 是*可选*依赖，只有 MCP 服务器需要；核心 CLI 零安装即可运行。在你的 MCP 客户端配置中加入：

```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "node",
      "args": ["/absolute/path/to/zee-rp/bin/mcp.mjs"],
      "env": {
        "AXURE_WRITE_ROOT": "/safe/output/directory",
        "AXURE_BLANK_TEMPLATE": "/path/to/blank-template-from-your-Axure-install.rp"
      }
    }
  }
}
```

然后直接对代理说：

> “把 Page 1 上所有标着 'Cancel' 的按钮改成灰色描边，并加一个点击交互关闭模态面板。”

MCP 会话层会把源文件复制成链式工作副本（`source.work-1.rp`、`source.work-2.rp`……）。每一步先过结构校验再提交；失败步骤保留为 `.rejected` 并回滚——你的原始文件始终不被触碰。

## 🛡️ 安全模型

* **受保护路径** —— 设置 `AXURE_PROTECTED_PATHS`（冒号分隔的绝对路径），引擎将拒绝把它们作为输入*或*输出。路径消解可穿透符号链接，并在 macOS/Windows 上折叠大小写变体。
* **写根沙箱** —— 设置 `AXURE_WRITE_ROOT`（冒号分隔多根）后，所有输出必须落在根内，否则在落盘一个字节之前就被拒绝。
* **三零规则** —— 生成文件必须做到 0 条不可解析记录、0 个悬空引用、0 个结构问题才算交付。

## 📊 能力矩阵

| 领域 | 能力 | 验证级别 |
|---|---|---|
| 二进制 .rp 读写 | LZ4 manifest 往返、记录图、页面/母版复制、空白工程与空白页创建 | GUI 保存重开已验 |
| 富文本 | 多 run 样式、行距、对齐、超链接（页面与 URL）、原生项目符号列表（结构级） | 原生画布已验 |
| 动态面板 | 多状态创建、嵌套闭包、追加/替换、适应内容 | GUI 往返已验 |
| 中继器 | 数据集 CRUD、行模板、排序筛选规则、每页条数 | 预览行为已验 |
| 交互 | 45 种事件、29 个动作写入器、If/ElseIf/Else 递归条件、18 个注册表达式函数 | 225/225 回归 + 抽样 GUI 验证 |
| 原生表格 | 尺寸矩阵、单元格多 run 文本、视觉合并覆盖 | 原生画布已验 |
| 连接线 | 默认四边、归一化自定义锚点、跨文档样式同步 | 预览已验 |
| 自适应视图 | Base / 768 / 1024 断点与按视图覆盖 | 预览已验 |

能力声明刻意保守：每一行都由 macOS / Axure RP 11.0.0.4137 上的具体已验样本支撑，并且明确区分*结构正确* → *可加载* → *预览行为* → *GUI 编辑/保存重开*。精确边界见 [references/capabilities.md](references/capabilities.md)——不做任何外推。

## 🏛️ 架构

```
              ┌─────────────────────────┐
              │  Claude / Agent / CLI   │
              └───────────┬─────────────┘
                          │ (MCP / CLI)
              ┌───────────▼─────────────┐
              │      zee-rp engine      │
              │ (sandbox & registry)    │
              └───────────┬─────────────┘
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
 ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
 │ rp-records  │   │ parse-payload│   │  ix-actions  │
 │ LZ4/gzip    │   │ typed-tag    │   │ expression & │
 │ record I/O  │   │ tree engine  │   │ FCall registry│
 └─────────────┘   └──────────────┘   └──────────────┘
        └─────────────────┼─────────────────┘
                          ▼
              ┌─────────────────────────┐
              │    Axure RP 11 (.rp)    │
              └─────────────────────────┘
```

## 🧪 验证纪律

我们不猜——我们对照原生应用验证：

* **回归套件** —— 覆盖记录结构、表达式序列化与布局闭包的自动断言（`npm test`；完整 225 项在开发环境运行，随包的 parity/安全检查在你的本机模板上运行）。
* **对拍与安全检查** —— `node test/parity-check.mjs` 证明统一 CLI 与直跑脚本输出逐字节一致，并覆盖受保护路径/写根的全部拒绝分支。
* **GUI 往返** —— 生成文件在真实 Axure RP 11 中打开、保存、关闭、从磁盘重开再解析，证明原生兼容。

## 🤝 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。简版：PR 不得添加 Axure `.rp`/`.rplib` 二进制或任何官方资产；测试需要本机 Axure RP 11 安装与空白模板。

## 📄 许可证与免责声明

MIT 许可证——见 [LICENSE](LICENSE)。

zee-rp 是独立的开源研究与工具项目。Axure RP 是 Axure Software Solutions, Inc. 的注册商标。本项目与 Axure Software Solutions, Inc. 不存在隶属、赞助或背书关系。

---

如果 zee-rp 为你省下了几小时画原型的时间，欢迎 Star ⭐！
