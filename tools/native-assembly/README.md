# Native Assembly Bridge

用于本机 Axure 的实验工具。按原生文件版本选择本机安装和独立子进程。支持 Apple Silicon 上已辨识的 RP9 9.0.0.3754 和 RP11 11.0.0.4137。默认从 `/Applications` 发现，`AXURE_APP_RP9` 和 `AXURE_APP_RP11` 可指定其他路径。需要本机 .NET SDK。通过 `ZEE_DOTNET` 可指定非默认的 dotnet 可执行文件。RP9 使用安装包里的 Intel Mono，经 Rosetta 运行。RP11 使用 ARM64 .NET 与 ASP.NET Core 共享运行时，本轮验收版本为 10.0.9。

以下命令从 zee-rp 源码根目录执行。

```sh
node tools/native-assembly/bridge.mjs inventory 9
node tools/native-assembly/bridge.mjs probe 11
node tools/native-assembly/bridge.mjs catalog 9
node tools/native-assembly/bridge.mjs members 11 Axure.DocumentModel.Interaction.SetPanelStateInfo
node tools/native-assembly/bridge.mjs create 9 /path/to/new-blank.rp
node tools/native-assembly/bridge.mjs create 11 /path/to/new-form.rp 7
node tools/native-assembly/bridge.mjs compare 11 /path/to/new-form.rp
node tools/native-assembly/bridge.mjs pair 9 /path/to/new-samples 3 7
node tools/native-assembly/bridge.mjs export 11 /path/to/new-form.rp /path/to/new-html
```

- `create` 生成一份单页新文档，可选文本框输入上限。它使用原生页面和文档序列化器，之后让 zee-rp 检查原生记录和引用。
- `members` 查询指定类型的成员、签名和枚举值。`catalog` 枚举对象、交互和表达式的具名类型，并返回事件枚举。
- `pair` 将同一个原生文本框对象分两次保存。命令用 zee-rp 解码两份页面记录，报告控件字段变化和原生类型标签。
- `inspect` 通过 Axure 只读加载文件，列出页面、顶层元件位置和尺寸，以及原生 TextBox 的 `MaxLength`。`compare` 再把页面名、顶层控件名和边界与 zee-rp 读回值对账。
- `export` 以新建的默认 HTML 生成器配置生成完整本地播放器目录，输入与宿主的文件主版本必须相同。保存于 RP 中的自定义导出配置仍应通过 Axure 编辑器使用。可经 HTTP 打开输出目录下的 `start.html`。
- 路径必须指向已存在的父目录，输出文件或目录使用新名称。Windows 适配可发现安装及枚举文件，程序集调用等待 Windows 版本的独立验证。

既有 RP/1、Studio 和 MCP 通过原有模板选择接入。以下示例用新建的 RP9 空白工程编译 RP/1。

```sh
AXURE_BLANK_TEMPLATE_RP9=/path/to/new-blank.rp \
  node scripts/proto.mjs generate --spec examples/authoring/list-detail.rp1 \
  --out-dir /path/to/compile-output --out-rp /path/to/list-detail.rp
```

RP11 模板对应 `AXURE_BLANK_TEMPLATE_RP11`，具体 RP/1 规格仍需服从现有原生编译器支持的目标版本。程序集研究命令随源码和源码发布包交付。官方 HTML 导出可从 npm 包的 MCP 工具 `export_prototype` 调用。

## 回归

`verify.mjs` 生成双版本原生样本，核对内部模型和 zee-rp 解码，以及 Playwright 中的原生输入限制。它用新生成的 RP9 空白工程真实编译 RP/1，验证官方播放器中的中继器、状态切换、导航、跨页变量与条件分支，接着验证定时、手势和复位。它记录运行前后的编辑器进程及输入文件哈希对照。

Playwright 可安装到单独目录。以下示例使用项目的 Python 依赖环境，并让 Playwright 复用本机 Chrome。

```sh
browser_tools="$(mktemp -d)"
npm install --prefix "$browser_tools" playwright@1.65.1
PLAYWRIGHT_MODULE="$browser_tools/node_modules/playwright/index.mjs" \
  ZEE_PYTHON=/path/to/venv/bin/python \
  node tools/native-assembly/verify.mjs /path/to/new-verification-dir
```

桌面保存重开使用既有验收脚本，输入使用专用于桌面复验的样本副本。

```sh
swift scripts/gui-roundtrip.swift /path/to/gui-sample-copy.rp 9
swift scripts/gui-roundtrip.swift --close /path/to/gui-sample-copy.rp 9
```

在 RP11 样本上将版本参数换成 `11`。程序集架构、当前实证与未覆盖范围见[研究报告](../../docs/native-assembly-research.md)。
