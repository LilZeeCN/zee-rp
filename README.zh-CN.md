<div align="center">

# ⚡ zee-rp

**开源的 Axure RP 11 原型文件引擎与 MCP 服务器。**

*把截图、HTML 或布局规格变成可编辑的原生 Axure 元件；让 AI 直接读取、修改和生成真实的 `.rp` 文件——全部经过真实 Axure 应用原生验证。*

[English](README.md) • [简体中文](README.zh-CN.md) • [安装与配置](#-安装与配置) • [CLI 快速上手](#-cli-快速上手与实战示例) • [MCP AI 接入](#-mcp-接入与-ai-提示词指南) • [底层逆向原理解密](#-底层逆向原理解密) • [能力矩阵](#-能力矩阵)

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/运行时依赖-0-orange.svg)](package.json)
[![CLI Commands](https://img.shields.io/badge/CLI_命令-30-informational.svg)](bin/axure.mjs)
[![MCP Tools](https://img.shields.io/badge/MCP_工具-42-purple.svg)](bin/mcp.mjs)
[![Regression Tests](https://img.shields.io/badge/回归测试-225%2F225-success.svg)](test/)

</div>

> **商标声明** —— Axure RP 是 Axure Software Solutions, Inc. 的注册商标。zee-rp 是一个独立的开源研究与工具项目，与 Axure Software Solutions, Inc. **不存在**任何隶属、赞助或背书关系。

---

## 💡 为什么需要 zee-rp？

二十多年来，**Axure RP** 一直是高保真企业级原型设计、复杂交互逻辑和状态化 UX 架构的事实标准与行业基准。然而，它的专有 `.rp` 二进制文件格式长期以来都是一个未公开文档的“绝对黑盒”：
- 没有任何公开的技术规范或 Schema 定义；
- 没有任何官方的读写 API、SDK 或命令行工具；
- 无法接入无头（Headless）自动化流程或持续集成（CI）；
- 与现代 AI Coding Agent、LLM 工具链完全脱节。

当 Figma 等现代 UI 设计工具早已拥有丰富的 REST API 和繁荣的 AI 插件生态时，国内外的产品经理与交互设计师面对 Axure 原型，仍不得不纯靠人手逐像素拖拽、配置条件、手敲重复文本——每次改版都要耗费数十个小时。

**zee-rp 彻底改变了这一现状。**

经过数月严谨的二进制逆向工程、IL 指令级反编译分析与原生 GUI 往返验证，**zee-rp** 诞生为一个**干净室（Clean-room）设计、零运行时依赖的纯 Node.js 原生引擎**。它能原生解析、构造、修改和修复 Axure RP 11 的二进制文件。结合配套的 **42 工具 MCP（Model Context Protocol）服务器**，主流 AI 代理（Claude、Cursor、Antigravity、Windsurf）可以直接像操作代码一样精准操控真实的 `.rp` 原型工程。

---

## 📸 实际效果演示

一张复杂的整页 Web 应用截图（含 macOS 菜单栏、标题栏及三栏式复杂布局），被完全还原为原生 Axure 页面：**121 个完全独立的矢量/文本可编辑元件、16 张内嵌图片，平均像素绝对误差仅 7.97/255** ——绝非生成一张扁平贴图，而是可以在真实 Axure RP 11 画布中任意拖拽、改字、调整样式的真实元件：

![页面视觉效果与可编辑元件边界对比](assets/demo-comparison.png)

*左：浏览器实际渲染预览。右：同一页面在原生 Axure RP 11 画布中展开，每个元件均可独立点选、修改样式与绑定交互。*

---

## 🌟 核心应用场景

| 场景 | 说明 | 对应工具 / 方式 |
|---|---|---|
| 🤖 **AI 原型助手（Agent Co-pilot）** | 通过对话让 Claude、Cursor 直接阅读原型结构树、批量调整排版、绑定交互跳转、根据需求生成新页面。 | MCP 服务器 (`zee-rp-mcp`) |
| 👁️ **视觉 / 截图转 Axure（Vision-to-Axure）** | 借助多模态视觉模型解析 UI 截图或 HTML 快照，自动转换成可继续加工的原生 Axure 矢量形状与文本。 | CLI (`axvg build`, `axvg paste`) |
| ⚡ **原型批量工程重构** | 跨数十个页面批量更新设计规范（字体、主色调）、批量重命名元件、批量修复失效链接或文案。 | CLI (`set-widget-text`, `set-widget-richtext`) |
| 🔀 **复杂交互与动态数据绑定** | 程序化创建动态面板（多状态切换、嵌套容器、自适应尺寸）、中继器表格增删改查、递归条件分支（`If/ElseIf/Else`）。 | CLI (`add-interaction`, `fill-panel-state`) |
| 📋 **画布剪贴板无感注入** | 无需写回磁盘 `.rp` 文件，直接将排版规格通过系统剪贴板粘贴到正在运行的 Axure 当前打开页面上。 | CLI (`axvg paste`) |

---

## 📦 安装与配置

zee-rp 采用纯现代 ESM 编写，标准库零扩展，**核心 CLI 零运行时依赖**。

### 方式一：通过 Git 全局安装（推荐）

无需先手动克隆仓库，直接使用 npm 全局安装：

```bash
# 直接从 GitHub 仓库全局安装
npm install -g github:LilZeeCN/zee-rp

# 验证 CLI 命令是否就绪
zee-rp --help
```

安装后系统将自动注册两个全局指令：
- **`zee-rp`**：提供 30 个 Axure 原型操作的核心统一 CLI。
- **`zee-rp-mcp`**：面向 AI Agent 的 MCP Server 服务进程。

### 方式二：本地克隆运行（零安装、零构建）

```bash
git clone https://github.com/LilZeeCN/zee-rp.git
cd zee-rp

# 直接通过 node 运行 CLI，开箱即用
node bin/axure.mjs --help
```

### 方式三：npm 官方包（支持 npx）

本项目 `package.json` 已配置为公开模块（`"private": false`）。在正式发布至 npm 官方注册表后：

```bash
# 无需安装，即用即走
npx zee-rp --help

# 或全局安装
npm install -g zee-rp
```

---

### ⚙️ 配置本机空白工程模板

为严格遵守版权与合规要求，**本开源项目仓库内刻意不携带任何 Axure 官方专有的 `.rp` 或 `.rplib` 二进制成品文件**。

为了能够从零初始化新工程或新增页面，只需在你本机的 Axure RP 11 中新建一个单页空白文件并保存，随后配置环境变量即可：

```bash
# 指定本机保存的原生空白工程路径
export AXURE_BLANK_TEMPLATE="/你的路径/axure-rp11-blank.rp"
```

> **自动回退**：若未配置环境变量，系统将默认寻找：  
> `~/Library/Application Support/zee-rp/templates/axure-rp11-blank.rp`

---

## 🛠️ CLI 快速上手与实战示例

所有涉及文件写出的操作均遵循**原子链式原则**：永远将结果保存至**新路径**，绝不原地覆写或破坏源文件。

### 1. 结构与健康度检查
查看工程内页面清单、母版、元件树及是否存在悬挂引用：

```bash
# 人类易读的页面/元件树结构概览
zee-rp rp-read /path/to/project.rp

# 输出格式化 JSON（极其适合直接喂给大模型上下文）
zee-rp rp-read /path/to/project.rp --json
```

### 2. 安全修改元件文案
定位指定页面上的具名元件，将其文字替换并另存为新文件：

```bash
zee-rp set-widget-text /path/to/source.rp /path/to/output.rp \
  "Page 1" "SubmitButton" "立即确认提交"
```

### 3. 富文本与混合样式（字号/颜色/链接）
针对单个文本块应用多段样式（不同字重、高亮颜色以及页面内或外部 URL 超链接）：

```bash
zee-rp set-widget-richtext /path/to/source.rp /path/to/output.rp \
  --page "Page 1" --widget "StatusBanner" \
  --runs '[{"text":"温馨提示：","style":{"bold":true}},{"text":"查看详情说明","style":{"color":"#1890FF","link":{"url":"https://example.com","newWindow":true}}}]'
```

### 4. 创建新工程与复制页面
```bash
# 基于空白模板初始化一个全新工程
zee-rp create-blank-project /path/to/new-project.rp

# 深度复制已有页面（全闭包 GUID 隔离重建，避免引用污染）
zee-rp duplicate-page /path/to/source.rp /path/to/output.rp "首页" "首页-备份副本"
```

### 5. 添加交互逻辑与事件绑定
为页面上的指定按钮添加点击打开动态面板事件：

```bash
zee-rp add-interaction /path/to/source.rp /path/to/output.rp \
  --page "首页" --widget "MenuButton" \
  --event "OnClick" \
  --action "SetPanelState" \
  --target "SidebarPanel" \
  --state "Expanded" \
  --animate "slideDown"
```

### 6. 画布剪贴板直贴流程 (`axvg`)
先将布局规格编译为矢量中间格式，再通过系统剪贴板唤起 Axure 原生粘贴：

```bash
# 1. 将设计参数编译为 Axvg 规格
zee-rp axvg build spec.json -o canvas.axvg.json

# 2. 写入剪贴板并触发 Axure 激活窗口粘贴上画
zee-rp axvg paste canvas.axvg.json
```

---

## 🤖 MCP 接入与 AI 提示词指南

zee-rp 内置了针对大语言模型打造的 **Model Context Protocol (MCP)** 服务，暴露出 **42 个高精度原生工具**。

### 1. 客户端接入配置

在你的 MCP 客户端配置文件中追加配置项：

#### 对于 Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "node",
      "args": ["/zee-rp的绝对路径/bin/mcp.mjs"],
      "env": {
        "AXURE_WRITE_ROOT": "/Users/username/Projects/axure-outputs",
        "AXURE_BLANK_TEMPLATE": "/Users/username/Templates/blank.rp"
      }
    }
  }
}
```

*若已全局安装，配置更简洁：*
```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "zee-rp-mcp",
      "env": {
        "AXURE_WRITE_ROOT": "/Users/username/Projects/axure-outputs"
      }
    }
  }
}
```

#### 对于 Cursor (`.cursor/mcp.json`) 或 Antigravity
```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "node",
      "args": ["/zee-rp的绝对路径/bin/mcp.mjs"],
      "env": {
        "AXURE_WRITE_ROOT": "/安全的输出目录"
      }
    }
  }
}
```

### 2. 核心环境变量与安全沙箱

| 环境变量 | 作用与机制 |
|---|---|
| `AXURE_WRITE_ROOT` | **强烈推荐**。冒号分隔的绝对路径目录。开启后所有写盘操作被限制在该目录白名单内，任何试图向根外输出的行为在落盘前即被安全拒绝。 |
| `AXURE_BLANK_TEMPLATE` | 本机保存的原生 Axure RP 11 单页空白工程路径。 |
| `AXURE_PROTECTED_PATHS` | 受保护关键文件路径。引擎对这些路径禁止读、改、写，防止核心成品误触。 |

### 3. 42 个 MCP 工具分类全景

```
┌────────────────────────────────────────────────────────────────────────┐
│                        zee-rp MCP 工具全集 (42)                        │
├───────────────────┬────────────────────────────────────────────────────┤
│ 探查与会话 (9)    │ rp_read, inspect, locate, read_interactions,       │
│                   │ axure_open, axure_state, axure_save, verify,       │
│                   │ gui_roundtrip                                      │
├───────────────────┼────────────────────────────────────────────────────┤
│ 内容与样式编辑 (7)│ set_widget_text, set_widget_richtext, edit_text,   │
│                   │ name_widget, set_master_overrides,                 │
│                   │ patch_link_window, patch_string                    │
├───────────────────┼────────────────────────────────────────────────────┤
│ 结构与容器管理(10)│ create_blank_project, create_blank_page,           │
│                   │ duplicate_page, create_master, place_master,       │
│                   │ create_panel_clone, fill_panel_state,              │
│                   │ remove_panel_state_content,                        │
│                   │ set_panel_fit_to_content, add_adaptive_view        │
├───────────────────┼────────────────────────────────────────────────────┤
│ 常用元件与表格 (6)│ set_native_table, clone_library_widget,            │
│                   │ clone_library_page_content, clone_native_connector,│
│                   │ set_connector_anchors, set_combobox_options,       │
│                   │ set_listbox_options                                │
├───────────────────┼────────────────────────────────────────────────────┤
│ 交互与事件 (2)    │ add_interaction, remove_interaction                │
├───────────────────┼────────────────────────────────────────────────────┤
│ 矢量剪贴板 (3)    │ axvg_build, axvg_paste, axvg_selftest              │
├───────────────────┼────────────────────────────────────────────────────┤
│ 任务事务管理 (3)  │ jobs_list, jobs_get, jobs_cancel                   │
└───────────────────┴────────────────────────────────────────────────────┘
```

### 4. 推荐的 Agent 提示词示范

连接 MCP 后，你可以直接与 AI 进行高维度自然语言对话：

> **“帮我分析 `/workspace/demo.rp` 的页面结构，找出所有没有绑定点击事件的按钮元件。”**

> **“在‘用户设置’页面中，找到名为‘保存修改’的按钮。将它的文字改成‘确认提交’，背景色改为 `#1890FF`，并绑定一个点击事件跳转到‘控制台’页面。”**

> **“将这段 Markdown 格式的表格数据，转换成‘商品列表’页面上的 Axure 原生中继器（Repeater），包含商品名、价格和库存三列。”**

> **“在‘个人中心’页创建一个 3 个状态的动态面板（基本信息、安全设置、消息通知），并为顶部 Tab 按钮绑定切换该动态面板状态的滑动动画。”**

---

## 🔬 底层逆向原理解密

Axure 的 `.rp` 文件本质上不是普通的 Zip 压缩包，也不是 SQLite 数据库，而是一个高度特化的复合二进制流：

```
  ┌────────────────────────────────────────────────────────┐
  │                   .rp 二进制容器结构                   │
  ├────────────────────────────────────────────────────────┤
  │ 文件头与清单（Manifest）：                             │
  │ • LZ4 分块压缩格式                                     │
  │ • Package 偏移量目录与缩略图偏移表                     │
  ├────────────────────────────────────────────────────────┤
  │ 记录块（Records & Chunks）：                           │
  │ • Gzip 压缩的数据段流                                  │
  │ • 类型化 Tag 载荷图（.NET 二进制对象序列化流）          │
  ├────────────────────────────────────────────────────────┤
  │ 闭包引用完整性：                                       │
  │ • 128 位 GUID 节点网络                                 │
  │ • 层级化 DiagramObject 树与 PanelState 容器            │
  │ • 交互表达式 AST 与 FCall 静态函数调用表               │
  └────────────────────────────────────────────────────────┘
```

1. **自研 LZ4 清单编解码**：Axure 采用自定义的文件头和 LZ4 压缩帧结构。zee-rp 使用纯 JS 实现了无原生依赖的 LZ4 manifest 解包与重封。
2. **类型化 Tag 载荷图解析**：针对 .NET 专有序列化格式开发了 AST 遍历器，在保留记录原始字节对齐的同时，支持属性字段的精确改写。
3. **GUID 闭包引用完整性保障**：在 Axure 中，任何元件的复制或移动都牵涉到深层 GUID 闭包映射（交互目标、父子级联、样式绑定）。任何一个悬空的 GUID 都会导致 Axure 打不开文件。zee-rp 强制在写入时进行全闭包递归解析。
4. **严格的“三零规则”（Three-Zero Rule）**：任何生成的工程文件只有满足以下硬性指标才允许交付：
   - **0 条不可解析记录**（0 unparseable records）
   - **0 个悬空引用**（0 dangling references）
   - **0 个结构级异常**（0 structural problems）

---

## 📊 能力矩阵

| 领域 | 支持能力 | 验证级别 |
|---|---|---|
| **二进制 .rp 读写** | LZ4 manifest 往返、记录图重构、页面/母版复制、空白工程与新页创建 | 原生 GUI 保存重开已验 |
| **富文本** | 多 run 混合排版、行距、对齐、页面/URL 超链接、原生项目符号列表（结构级） | 原生画布显示已验 |
| **动态面板** | 多状态创建、嵌套闭包导入、追加/替换、适应内容尺寸 | 原生 GUI 往返已验 |
| **中继器** | 数据集行级增删改、行模板渲染、排序与筛选规则、分页设定 | 原生预览行为已验 |
| **交互与条件** | 45 种事件、29 类动作写入器、If/ElseIf/Else 递归条件、18 个标准表达式函数 | 225/225 回归 + 原生抽样已验 |
| **原生表格** | 尺寸矩阵扩缩容、单元格多 run 文本、视觉合并覆盖 | 原生画布显示已验 |
| **连接线** | 默认四边连线、归一化自定义锚点、跨文档样式同步 | 原生预览已验 |
| **自适应视图** | Base / 768 / 1024 断点与按视图尺寸/坐标覆盖 | 原生预览已验 |

*能力声明恪守严谨证据原则：明确区分“结构正确” → “Axure 可加载” → “浏览器预览行为正常” → “原生 GUI 编辑/保存/重开闭环”。详见 [references/capabilities.md](references/capabilities.md)。*

---

## 🏛️ 架构与测试纪律

```
                  ┌─────────────────────────┐
                  │  Claude / Agent / CLI   │
                  └────────────┬────────────┘
                               │ (MCP / CLI)
                  ┌────────────▼────────────┐
                  │      zee-rp engine      │
                  │  (sandbox & registry)   │
                  └────────────┬────────────┘
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│   rp-records    │   │  parse-payload  │   │   ix-actions    │
│    LZ4/gzip     │   │    typed-tag    │   │  expression &   │
│   record I/O    │   │   tree engine   │   │ FCall registry  │
└─────────────────┘   └─────────────────┘   └─────────────────┘
         └─────────────────────┼─────────────────────┘
                               ▼
                  ┌─────────────────────────┐
                  │    Axure RP 11 (.rp)    │
                  └─────────────────────────┘
```

- **Claude / Agent / CLI**：上层 AI 智能体与统一命令行调用入口。
- **zee-rp engine**：核心会话引擎（负责写根沙箱安全校验、命令注册表分发与原子链式工作流）。
- **rp-records**：底层记录流编解码（负责专有 LZ4 文件头解包/打包与分块 Gzip 记录流 I/O）。
- **parse-payload**：.NET 类型化 Tag 对象图语法树解析引擎（维护 GUID 闭包完整性）。
- **ix-actions**：交互动作生成器（解析递归表达式 AST 与 18 个静态 FCall 函数注册表）。
- **Axure RP 11 (.rp)**：最终生成并通过“三零规则”检验的原生受控原型文件。

### 多重测试网
- **内核回归套件**：涵盖 225 项针对底层记录结构、表达式解析与闭包封闭性的自动化断言（`npm test`）。
- **对拍与安全检查**：`node test/parity-check.mjs`（23 项断言）确保统一 CLI 与底层脚本输出逐字节对齐，且白名单/受保护红线全部生效。
- **任务队列事务测试**：`npm run test:jobs`（11 项断言）验证并发排队、异步句柄读取、取消与失败回滚。
- **GUI 自动化往返测试**：通过 macOS Accessibility 原生脚本（`scripts/gui-roundtrip.swift`）自动化控制 Axure RP 11 打开、保存并由引擎重新解析闭环。

---

## 📂 代码目录导览

```
zee-rp/
├── bin/
│   ├── axure.mjs               # 统一 CLI 执行入口（聚合 30 个操作命令）
│   └── mcp.mjs                 # 面向 AI 助手的 MCP 服务进程（42 个工具）
├── scripts/
│   ├── engine.mjs              # 事务性会话管理器与安全沙箱调度中心
│   ├── rp-records.mjs          # 二进制 LZ4/gzip 数据流编解码器
│   ├── parse-payload.mjs       # .NET 类型化 Tag 语法树解析器
│   ├── ix-actions.mjs          # 交互动作、表达式 AST 与函数生成器
│   ├── mcp-tools.mjs           # MCP 工具集声明与分发器
│   ├── axvg.mjs                # Axvg 矢量几何格式编译与剪贴板桥接器
│   └── ... (共 20+ 个面向中继器、表格、动态面板的专项操作脚本)
├── references/
│   ├── capabilities.md         # 详尽的能力支持清单与边界证据矩阵
│   ├── rp-workflow.md          # 端到端原型构建实操指南
│   ├── repeaters.md            # 中继器数据集与交互规范深度手册
│   ├── adaptive-views.md       # 自适应多断点视图规则
│   ├── axvg-format.md          # 矢量剪贴板中间格式规范
│   └── troubleshooting.md      # 常见格式问题与排障锦囊
└── test/
    ├── parity-check.mjs        # 23 项逐字节对拍与安全断言套件
    └── jobs-check.mjs          # 11 项任务队列与事务隔离测试
```

---

## 🤝 参与贡献

欢迎社区开发者一同完善！提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)：
- **干净室原则**：严禁在 Pull Request 中提交任何官方专有 `.rp`/`.rplib` 二进制文件或商业素材。
- **证据优先**：新增能力需配备结构对拍断言与回归测试支持。

---

## 📄 许可证与免责声明

基于 **MIT 许可证** 开源——详见 [LICENSE](LICENSE)。

*zee-rp 是一个独立的开源项目。Axure RP 是 Axure Software Solutions, Inc. 的注册商标。本项目与 Axure Software Solutions, Inc. 不存在隶属、赞助或背书关系。*

---

<div align="center">
<b>如果 zee-rp 帮你在原型设计中省下了宝贵的时间，欢迎点个 Star ⭐ 支持！</b>
</div>
