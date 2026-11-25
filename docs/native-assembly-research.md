# Axure Native Assembly Bridge 研究与验证

同一开发分支后续已将这里验证过的轮播、滑动、双轴拖动复位及文本框输入长度接入完整 RP/1。当前用法和约束见 [RP/1 动作契约](../references/rp-language.md)。以下表格记录程序集桥接首轮取证时的能力分布。

基线为 zee-rp 的 `9503290`。复验环境为 Apple Silicon、macOS 27.2.1、Node 24.22.3、Playwright 1.65.1。Windows 对照项目提供了技术路线线索，桥接代码依据本机程序集的结构、单独启动的探针以及本项目写入和读回结果实现。 [Windows 对照项目](https://github.com/xunan23333-bit/axure-rp9-agent-skill)

## 安装覆盖与架构

通过 Applications 和 Spotlight 按 Axure 应用标识检查，发现两个编辑器安装。安装包清单和程序集引用表由 `inventory`、`file`、`otool`、ILSpy 汇总。RP9 的额外应用包是安装内的更新程序。

| 项目 | RP9 9.0.0.3754 | RP11 11.0.0.4137 |
| --- | --- | --- |
| macOS 启动器 | x86-64 Mach-O，经 Rosetta 运行 | ARM64 Mach-O |
| 入口程序集 | `Contents/Resources/Client.Mac.exe` | `Contents/MacOS/Client.Mac.dll` |
| PE / CLI | PE32 `0x014c`，IL-only，AnyCPU 头标记 | PE32+ `0xec20`，ARM64 Darwin ReadyToRun 与 CIL |
| 目标框架 | .NET Framework 4.5.2 | .NET 8，deps 清单列出 8.0.11 的 ARM64 运行时包 |
| 独立调用实测 | 安装内 Mono 6.8.0.105，进程 X64 | 系统 .NET 10.0.9，进程 ARM64 |
| 模块 MVID | `2d412208-b31e-413e-9b68-fb5ea6830f64` | `2743c1df-a331-4cd0-9018-a9ef9e36c143` |
| REA 可读 AssemblyRef | 18 | 84 |
| 包内资源清单 | 55 个 DLL、39 个 dylib、20 个配置文件，含 Mono、FSharp、Json.NET、SharpZipLib、LZ4、原生 Objective-C glue 和 ImageMagick 依赖 | 321 个 DLL、50 个 dylib，含 CoreCLR、hostfxr、hostpolicy、ASP.NET Core、FSharp、Json.NET、LZ4 和 ARM64 原生图形依赖 |
| 主题启动所需字体 | `Nunito Sans` | `Inter` |

两版都把文档模型、客户端、平台层和发布逻辑的大量类型放在入口程序集。RP11 的 deps 列出多个逻辑依赖，实际加载的入口中已收录所检索的对象模型和生成器类型。安装内的 `DefaultSettings/Prototype_Files` 提供发布所需播放器及模板资源。平台启动器连接 Cocoa、AppKit、Foundation、CoreGraphics 和 Objective-C。RP9 额外提供 Mono 的本机胶水，RP11 使用现代 CLR 宿主。RP9 的 SharpDX 和 Windows API Code Pack 文件存在于同一个包，验收的 macOS 调用走的是 Mac 平台实现。

REA 的两个 PE 元数据结果均报告 Module/Assembly 表有额外行及 GUID 索引越界，MVID 未能由该解析器确定。反射加载确认了上表 MVID，ILSpy 提供了调用图和个别方法的 CIL/C# 证据。枚举和混淆方法签名按 SHA-256 和 MVID 绑定，各构建的名字和标记独立使用。

## 实际调用链

1. 桥接器发现安装、校验入口程序集 SHA-256，并根据平台、版本与架构启动独立进程。程序集加载后再校验 MVID 和实际 CLR 进程架构。调用失败以错误返回。
2. macOS 进程初始化 AppKit 和 Axure 的平台服务，在进程范围注册对应主题字体，定位安装资源并使用独立临时目录。接着初始化文档对象类型注册表。编辑器启动器、文档窗口、主事件循环、菜单和剪贴板均不参与这一流程。
3. RP9 通过 `XOgG.xOgB` 和 `vOOd.COOE` 建空白文档，RP11 对应 `zIIT.III9` 和 `WbM3.RbM7`。两版构造器都会建站点地图、默认生成配置和全局变量 `OnLoadVariable`。默认页需另外创建 Page 对象并以站点地图中的 GUID 保存。可选输入框是直接构造的原生 `Axure.DocumentModel.Objects.TextBox`。
4. 原生 HTML 出口先只读加载输入，随后调用 RP9 的 `IFrW.pFr1` 或 RP11 的 `SiGn.WiGF` 处理全部页面。使用该生成器内部的本地发布管线写入页面、样式、资源和播放器，在启动浏览器之前结束。Playwright 独立通过本地 HTTP 打开 `start.html`。
5. 配置范围为默认 HTML 生成器设置。文档内已有自定义字体映射、页筛选或发布配置的保真另需验证。生成器专有资源仍从本机安装读取，仓库只保存桥接源码、说明和检查脚本。

桥接入口在 [tools/native-assembly](../tools/native-assembly/README.md)。新建的 RP9 空白文档可作为 `AXURE_BLANK_TEMPLATE_RP9`，由既有编译器、Studio 出口和 MCP 入口使用各自原有的解析链。本轮使用原有 RP/1 生成入口和真实 stdio MCP 验证了模板接入。Studio 继续走原有原生出口契约，专项验证覆盖现有 Studio 的原生导出和命令契约。该分支的程序集出口仍是源码级实验入口。

## 原生真值与版本差异

- 生成同一文本框对象的两份文件，仅设置 `TextBox.MaxLength` 的前后值为 3 和 7。官方对象只读加载分别返回 3 和 7。两版页面内的文本框记录均只出现一处字段变化，都是 `MaxLength`，标签为 `0x05`。官方 HTML 生成了对应的 `maxlength`，实际输入在第 3 或第 7 个字符停止。当前 `rp-read` 摘要缺少该字段，RP/1 与 Studio 的原生控件契约也无对应项。
- RP9 与 RP11 反射枚举分别返回 42 与 46 个 `IxEventType` 名称。现有三项 RP11 专用触发器门禁与该差异一致，`Variable` 目前是项目的内部命名。RP11 独有项为 `OnBeforeItemLoad`、`OnErrorRemoved`、`OnErrorSet`、`Variable`。这证明了成员差异，事件的作用域与触发行为仍需独立测试。滑动、拖动两版都有明确枚举值。
- `SetPanelStateInfo` 直接暴露 `Repeat`、`RepeatInterval` 与 `RepeatSkipFirst`。RP9 发布运行时将 `state=current` 映射为停止面板重复。实测开始、循环、停止和重启。底层写入这些字段原已具备，缺口位于 RP/1 和 Studio 契约。
- 现有 `EnableDisableWidgetsInfo` 在 RP9 与 RP11 的字段类型不同。桥接器用反射分别查询实际构建。不能用任一版本输出的字段类型推断另一版本的二进制标记。
- 仅调用对象构造器时，两版各出现一次失败的结构验证，报 `missing-page-record`。补写 Page 包后同一场景在两版均通过。缺少平台服务、主题字体、独立临时路径或对象类型注册表也各自有可复现的失败栈。
- 自动对账目前覆盖页面名、顶层控件名和边界数据。单属性差分可报告字段键、值和标签。字体、嵌套对象图、表达式树和未知标签的自动推断仍需增加独立的匹配规则与样本。

## 功能缺口

表中「已验」指本轮使用本机对应程序或 Playwright 复现。RP/1 与 Studio 的范围同时参考当前代码的字段契约。官方可用操作见相关文档。 [动态面板](https://docs.axure.com/axure-rp/reference/dynamic-panels/) · [动作列表](https://docs.axure.com/axure-rp/reference/actions-list/) · [事件列表](https://docs.axure.com/axure-rp/reference/events-list/)

| 能力 | 自主二进制层 | RP/1 | Studio | 原生出口 | 浏览器验收 |
| --- | --- | --- | --- | --- | --- |
| 循环、停止、重启 | `next`、`current`、循环及间隔已有写入 | 普通状态切换已支持。重复选项及停止的语义待开放 | 普通切换有运行器。缺少重复任务生命周期 | RP9 既有低层 writer 结合程序集导出 | RP9 实测两个状态循环、停两周期以上、再次启动 |
| 左右滑动 | 低层事件和动作已有。静态反射同样可见上下滑动 | 常用触发器之外的滑动映射待验证 | 编辑手势与原型手势走不同链路。原型滑动待覆盖 | RP9 可写左右滑动和有方向的面板切换配置 | RP9 触点输入触发左右切换。上下与动画时长未验 |
| 水平、垂直拖动及复位 | 两种轴向模式与 `locationBeforeDrag` 已有 | 常规布局、局部移动。原生压力测试覆盖不足 | 设计态拖动已具备。原型运行态与 Axure 语义待对账 | RP9 现有 writer，释放时复位 | RP9 两轴分别实拖，未动轴误差 ≤2px，松手回归初始坐标 |
| 拖动边界、容差、失败条件 | 当前 Move writer 将 `BoundaryCondition` 写为空。条件回位需新增验证 | 边界、容差缺少统一表达 | 缺少原型边界执行器和命中容差契约 | 拖动对象可导。边界写入待验证 | 本轮只验无条件复位。拖放边界、命中容差、条件失败回位待验。 [Axure 移动边界](https://docs.axure.com/axure-rp/reference/move-action-boundaries/) |
| 动画及过渡 | 面板进出、Move easing、部分视觉动作已有。RP11 带额外锚点和缩放字段 | 常用视觉动作分项覆盖。任意面板过渡参数未贯通 | 运行态与离线代码动画分项支持 | 官方生成器可产出样本中的方向配置 | 状态切换已验，时序、运动轨迹、取消及中断待验 |
| 条件表达式 | 表达式 AST、Case、部分 FCall 已有 | 现有表达式子集已接通 | 条件运行子集及顺序已验，完整原生函数表仍有差距 | RP9 本轮输出跨页变量和双分支 | RP9 实际点按两个分支。隐式事件参数与组合嵌套待验 |
| 高阶动态面板 | 状态、嵌套、部分 fit/pin 结构已有 | 基础多态、动作已有 | 基础切换与嵌套已有 | 新桥接只读并导出既有样本。直接构造和序列化仍需扩大 | 本轮验证双状态、定时及手势。面板事件冒泡、滚动和压缩行为未验 |
| 中继器 | 增删改、排序筛选已有证据。行标记和 RP11 特有移除、组合字段需独立验收 | 行模板和数据动作已有。标记行、作用域组合待查 | 分页、筛选、排序已有。行内独立交互和广义表达式仍有缺口 | 现有 RP/1 样本成功导出两行，并把行值带到下一页 | 本轮验导航和状态。多个标记集合、预加载事件与复杂列类型待验。 [中继器与标记行](https://docs.axure.com/axure-rp/reference/repeaters/) |
| 原生控件、样式、自适应 | 原生表单和已有样式绑定均有实现。输入上限目前仅由记录解析层和桥接对账覆盖 | 控件基本字段可写。输入上限和全局样式定义创建待补 | 表单和常用样式支持。原生输入上限和完整样式状态同步待补 | 两版直接生成带上限的原生文本框。多控件、母版、矢量、图片及自适应须扩展生产 API | 两版均用真实键入核验上限。屏幕适配和多状态样式未覆盖。 [Axure 自适应](https://docs.axure.com/axure-rp/reference/adaptive-views/) |

## 验证状态

| 层次 | macOS RP9 | macOS RP11 | Windows |
| --- | --- | --- | --- |
| 运行时和对象注册 | Mono 加载、反射、构造 | ARM64 .NET 加载、反射、构造 | 有发现适配，未运行程序集 |
| 无模板新建和结构检查 | 单页、原生文本框、成对样本通过 | 单页、原生文本框、成对样本通过 | 未验证 |
| 原生编辑器 | 空白页、文本框和 RP/1 两页样本打开、保存、关闭、再开。文本框读回上限 7，两页样本读回 57 元件和 10 动作 | 空白页和文本框打开、保存、关闭、再开。文本框读回上限 7 | 未验证 |
| 无编辑器 HTML | 原生表单、RP/1 两页及手势样本 | 原生表单和空白页 | 未验证 |
| 浏览器 | 输入限制、列表与详情、条件分支、定时、滑动、双轴拖动及松手复位 | 两种输入长度上限 | 未验证 |
| 既有管线 | 生成的空白模板进入 RP/1 和 MCP 回归 | 独立桥和自主 RP 读取器对账 | 本轮无真实环境 |

复验工具及命令见[操作说明](../tools/native-assembly/README.md)。工程报告中的浏览器验证使用 Axure 生成的完整本地播放器，经 HTTP 送入 Chrome。初次 `file://` 尝试被官方播放器导向 Chrome 本地文件提示页，随后用回环 HTTP 复验。桌面 RP9 文本框首次自动关闭超时，单独用新副本重跑后保存、关闭、重开通过。完整无编辑器验收的运行前后均未发现 Axure 编辑器进程。

专项 Playwright 23 项全部通过。核心 23/23、Studio AI 244/244、原生后端 38/38、语言 51/51、同步 25/25、stdio MCP 7/7、真实 MCP 生成 11/11。分层、运行时、表单和源码契约检查通过，源码发布包中的桥接器实际加载了两个版本。

现阶段已经有跨版本文档与 HTML 运行入口，也有可独立复跑的逆向真值。完整 RP/1 到 Axure 对象构建器、用户自定义生成器配置保真、Windows 调用以及高级功能的全链路行为仍属于后续工程。
