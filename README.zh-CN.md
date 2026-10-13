# zee-rp

[English](README.md) · [完整命令表](references/commands-generated.md) · [验证流程](docs/validation.md)

独立的 Axure RP 11 原型读写工具，采用 MIT 许可证。包含 `.rp` 编解码、原生元件闭包克隆、交互、富文本、表格，以及可选 MCP 服务：**31 条 CLI 命令、43 个 MCP 工具**。需要 Node.js 18 及以上；已记录的原生验收环境为 macOS / Axure RP 11.0.0.4137，其他 build 和平台需单独验证。

已公开核心实现、schema 探针、全部测试代码、历史样本合同与摘要指纹、文档生成器、完整打包器和可复现示例。原生 `.rp`/`.rplib` 输入、Axure 应用和预览运行时代码、私人会话数据及研究临时文件不随仓库分发。原生输入由使用者从自己的安装环境提供。

![由公开规格生成的参考布局](assets/demo-layout.svg)

这是由 [公开规格](assets/dashboard-example.spec.json) 确定性生成的参考图，不是 Axure 截图，也不代表原生验收。可运行 `node examples/render-layout.mjs assets/dashboard-example.spec.json assets/demo-layout.svg` 重建。

## 安装与准备

```sh
git clone https://github.com/LilZeeCN/zee-rp.git
cd zee-rp
npm ci                     # 可选 MCP 服务需要此依赖
node bin/axure.mjs --help
npm test                   # 无需安装 Axure
```

在自己的 Axure RP 11 中新建单页空白工程，将页名设为 `Page 1` 并保存，然后配置模板和本机元件库。工具会验证模板确实只有一页、没有元件或状态。

```sh
export AXURE_BLANK_TEMPLATE="/absolute/path/blank.rp"
# macOS 默认安装位置可省略；安装在其他位置时设置：
export AXURE_LIBRARY_ROOT="/absolute/path/DefaultSettings/Libraries"
# 可选：限制输出范围，先创建目录
export AXURE_WRITE_ROOT="/absolute/path/outputs"
```

未设置模板变量时读取 `~/Library/Application Support/zee-rp/templates/axure-rp11-blank.rp`。修改输出使用新文件名，已存在文件会被拒绝。路径限制由统一 CLI/MCP 执行，直接调用底层库不具有相同的入口检查。其他变量见[验证文档](docs/validation.md#environment)。

## 可复现示例

从仓库根目录执行，目标 demo 目录必须尚不存在。脚本从本机 `Default.rplib` 生成具名控件和原生表格，示例不依赖私人研究样本。

```sh
node examples/build-native-demo.mjs /absolute/path/outputs/demo
node bin/axure.mjs rp-read /absolute/path/outputs/demo/5-widget.rp --json
node bin/axure.mjs set-widget-text /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/text.rp "Page 1" "SubmitButton" "Confirm & Proceed"
node bin/axure.mjs set-widget-richtext /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/rich.rp examples/richtext.json
node bin/axure.mjs set-native-table /absolute/path/outputs/demo/table.rp /absolute/path/outputs/table.rp examples/table.json
node bin/axure.mjs create-global-variable /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/variable.rp Counter --default-value "7"
node bin/axure.mjs add-interaction /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/click.rp SubmitButton --on-page "Page 1" --event OnClick --action wait ms=100
node bin/axure.mjs duplicate-page /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/pages.rp "Page 1" "Page Copy"
```

富文本读取 JSON **文件**，结构为 `paragraphs[].runs[]`；字号键为 `style.size`，链接放在 run 的 `link` 字段。如果本机空白页名称不同，在新副本中修改 `examples/richtext.json` 和命令里的页名。

对于已经有 `MenuPanel`、`Expanded` 状态和 `OpenMenuBtn` 的工程，可以这样设置面板状态：

```sh
node bin/axure.mjs add-interaction source.rp new.rp OpenMenuBtn --on-page "Home" --event OnClick --action set-panel-state target=MenuPanel state=Expanded
```

`--on-page` 是元件所在页；`--page` 则表示页面级事件目标。动作名称使用命令表中的拼写。布局规格编译与剪贴板粘贴：

```sh
node bin/axure.mjs axvg build assets/dashboard-example.spec.json -o /absolute/path/outputs/demo.axvg.json
# 需要运行中的 Axure 画布；剪贴板路线支持 macOS/Windows
node bin/axure.mjs axvg paste /absolute/path/outputs/demo.axvg.json
```

## MCP 配置

```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "node",
      "args": ["/absolute/path/to/zee-rp/bin/mcp.mjs"],
      "env": {
        "AXURE_BLANK_TEMPLATE": "/absolute/path/blank.rp",
        "AXURE_WRITE_ROOT": "/absolute/path/outputs"
      }
    }
  }
}
```

43 个工具由 31 个命令工具、8 个会话工具和 4 个 GUI/任务工具组成。以客户端发现的 schema 为准：命令工具接受原始 `args`，部分同时支持具名参数。常用流程为 `axure_open` → `locate` / `inspect` → `edit_text` → `verify` → `axure_save`。原始参数调用可使用 `session:true` 接续链尾。GUI 任务需要 macOS、Axure 与辅助功能权限。

富文本会话先用 `axure_open` 打开 `{"path":"/absolute/source.rp"}`，再调用 `edit_text`：`{"target":{"name":"StatusBanner"},"richRuns":[{"list":true,"lineSpacing":72,"runs":[{"text":"Documentation","link":{"url":"https://example.com","window":"new"}}]}]}`。变量工具 `create_global_variable` 支持 `source/output/name/defaultValue`；省略完整 source/output 对时接续会话。

## 测试与发布

- `npm test`：公开源码、契约与打包检查，不依赖 Axure。
- `npm run test:native`：从使用者本机模板/元件库生成新样例，验证 CLI/MCP 的实际写入与字段语义，不需要私人样本包。
- `npm run test:mcp`：真实 SDK/stdio 传输与新生成原生样例，先执行 `npm ci`。
- `npm run test:jobs`：11 项模拟进程生命周期检查，需要 macOS 和本机空白模板，不操作真实 GUI。
- `npm run test:parity`：23 项 CLI 与直接脚本对拍，使用本机空白模板。
- `npm run test:historical` 和 `test:historical-mcp`：已公开的历史回归入口，需要[验证文档](docs/validation.md)指定的外部样本包。历史 225/67 项结果不是 `npm test` 的结果。

[本版验证记录](docs/release-evidence.json)分别记录当前离线测试和历史原生验收。结构、加载、预览行为、GUI 编辑保存重开分别判定；新增离线功能不能因旧样本通过就宣称已完成 GUI 验收。

```sh
node scripts/gen-capabilities.mjs -o /absolute/path/new-commands.md
node scripts/pack-release.mjs -o /absolute/path/new-release-directory
```

打包器保留所有公开实现、测试、双语文档和示例，排除原生样本和符号链接，并生成 SHA-256 清单。贡献要求见 [CONTRIBUTING](CONTRIBUTING.md)，功能范围见[能力边界](references/capabilities.md)，许可证见 [LICENSE](LICENSE)。

zee-rp 是独立项目，与 Axure Software Solutions, Inc. 无隶属、赞助或认可关系。相关商标归各自权利人。MIT 许可证仅覆盖仓库自行编写的代码与文档，不授予 Axure 应用、元件库、运行时或第三方资产的使用权。
