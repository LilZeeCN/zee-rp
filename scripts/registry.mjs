// 命令注册表：scripts/ 下内核脚本的唯一机读清单（数量以 node registry.mjs validate 为准），供编排层与文档引用。
// 数据内联自 engineering-20261007/inventory.json（2026-10-07 盘点），Skill 自包含、不依赖 workspace 文件；
// 脚本增删后先更新盘点再同步本数组，并跑 node registry.mjs validate 核对。
//
// 用作库：import { listCommands, getCommand, findCommandByScript } from './registry.mjs'
// 用作 CLI：node registry.mjs dump | validate | table
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// 受保护成品（硬规则）：任何参数解析为该绝对路径时拒绝执行；本 CLI 本无路径参数，纯防御。
function protectedPaths() { return [process.env.AXURE_PROTECTED_PATH, ...String(process.env.AXURE_PROTECTED_PATHS || '').split(delimiter)].filter(Boolean).map(p => resolve(p)); }

// evidence 枚举 = 盘点实际使用的六级；internal 仅用于无 CLI 入口的库脚本。
const EVIDENCE_LEVELS = ['structure', 'loaded', 'preview', 'gui-roundtrip', 'channel-a', 'internal'];

// output 合法格式：index:N（写 process.argv[N]）/ flag:<选项名> / none（不产出文件）。
const OUTPUT_PATTERN = /^(?:index:\d+|flag:-[A-Za-z0-9][A-Za-z0-9-]*|none)$/;

const META = {
  "generatedAt": "2026-10-21",
  "source": "scripts",
  "evidenceSource": "references/capabilities.md",
  "cliEntryRules": "output 的 index:N 指 process.argv 索引（argv[2] 即第 1 个用户位置参数）；判定依据为各脚本 main guard 的解构顺序"
};

// CliEntry 全集：command（调度名，axvg 三个子命令各占一条）/ script / summary / usage / output / evidence。
const COMMANDS = [
  {
    "command": "list-custom-styles", "script": "custom-styles.mjs",
    "summary": "列出文件已有原生自定义样式及 GUID（不创建样式）",
    "usage": "node custom-styles.mjs <source.rp|source.rplib>", "output": "none", "evidence": "structure"
  },
  {
    "command": "rename-custom-style", "script": "rename-custom-style.mjs",
    "summary": "按样式身份级联改名，更新所有记录的 MatchInfo 与 StyleCache 名称",
    "usage": "node rename-custom-style.mjs <source.rp|rplib> <output.rp|rplib> <oldName> <newName>", "output": "index:3", "evidence": "gui-roundtrip"
  },
  {
    "command": "rebind-widgets", "script": "rebind-widgets.mjs",
    "summary": "筛选元件并批量绑定文件中已有原生样式；可显式清除局部样式覆盖",
    "usage": "node rebind-widgets.mjs <source.rp|rplib> <output.rp|rplib> <styleGuid> <selector.json> [--reset-overrides]", "output": "index:3", "evidence": "gui-roundtrip"
  },
  {
    "command": "create-blank-project",
    "script": "create-blank-project.mjs",
    "summary": "复制用户本机的 RP 9 / RP 11 原生空白模板生成单页空白 .rp 工程（模板按目标版本绑定）",
    "usage": "node create-blank-project.mjs <output.rp> [--version 9|11]",
    "output": "index:2",
    "evidence": "loaded"
  },
  {
    "command": "native-check", "script": "native-check.mjs",
    "summary": "用本机 Axure 自己的程序集无头加载 .rp，报告 Axure 是否接受该文件（加载级；需 macOS + Axure + .NET SDK）",
    "usage": "node native-check.mjs <file.rp> [--version 9|11] [--json]", "output": "none", "evidence": "loaded"
  },
  {
    "command": "create-global-variable",
    "script": "create-global-variable.mjs",
    "summary": "创建具名全局变量及字符串默认值（离线结构级）",
    "usage": "node create-global-variable.mjs <source.rp> <output.rp> <VariableName> [--default-value \"Value\"]",
    "output": "index:3",
    "evidence": "structure"
  },
  {
    "command": "create-blank-page",
    "script": "create-blank-page.mjs",
    "summary": "把与输入文件同版本的空白模板 Page 记录追加到已有 .rp 生成新空白页（跨版本模板会拒绝）",
    "usage": "node create-blank-page.mjs <input.rp> <output.rp> <newPageName>",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "duplicate-page",
    "script": "duplicate-page.mjs",
    "summary": "按页名（或 --index 记录号）复制已有页面生成新页",
    "usage": "node duplicate-page.mjs source.rp output.rp sourceName newName",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "create-master",
    "script": "create-master.mjs",
    "summary": "复制已有 Axure:Master 记录并注册为新命名的母版",
    "usage": "node create-master.mjs <source.rp> <output.rp> <SourceMasterName> <NewMasterName>",
    "output": "index:3",
    "evidence": "preview"
  },
  {
    "command": "place-master",
    "script": "place-master.mjs",
    "summary": "在指定页面上放置母版实例（ReferenceDiagramObject）",
    "usage": "node place-master.mjs <src.rp> <out.rp> <masterName> <pageIndex> [--x N --y N]",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "create-panel-clone",
    "script": "create-panel-clone.mjs",
    "summary": "克隆真实模板离线创建动态面板并插入状态包",
    "usage": "node create-panel-clone.mjs <src.rp> <out.rp> <pageName> <panelName> [state...] [--x N --y N --w N --h N] [--page-index N]",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "fill-panel-state",
    "script": "fill-panel-state.mjs",
    "summary": "把一个 Page 的控件闭包导入 Page 或 Master 所属 PanelState（支持 --master、--append/--replace、嵌套面板/中继器/母版/连接线自定义锚点及闭合内部交互）",
    "usage": "node fill-panel-state.mjs <source.rp> <target.rp> <new.rp> <sourcePage> <pageOrMaster> <panel> <state> [--master] [--append | --replace]",
    "output": "index:4",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "remove-panel-state-content",
    "script": "remove-panel-state-content.mjs",
    "summary": "按顶层元件名删除、--ids 按 ID 删除或 --all 清空一个 PanelState",
    "usage": "node remove-panel-state-content.mjs source.rp new.rp <pageOrMaster> <panel> <state> [--master] (--all | --ids <id>... | <widgetName>...)",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-panel-fit-to-content",
    "script": "set-panel-fit-to-content.mjs",
    "summary": "按记录/元件 ID 写 native boolean fit-to-content 开关",
    "usage": "node set-panel-fit-to-content.mjs source.rp new.rp spec.json",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "add-adaptive-view",
    "script": "add-adaptive-view.mjs",
    "summary": "为页面写入自适应视图集（Base+子视图）并按视图覆盖元件尺寸位置",
    "usage": "node add-adaptive-view.mjs <src.rp> <out.rp> [断点宽度...] [--override \"<视图名>:<元件名>:w=<宽>[,h=<高>][,x=<x>,y=<y>]\"]",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "add-interaction",
    "script": "add-interaction.mjs",
    "summary": "向单个或多个元件/页面追加事件+动作交互（支持 items 批量事务、自动读取 .baseline.json 解析逻辑 ID、interactions JSON 与条件/边界/IsOver/GetPanelState 原生表达；优先使用 generate_prototype 内联 RP/1，此命令用于直接修补已有 .rp）",
    "usage": "node add-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] [--baseline <file.baseline.json>] [--replace-event] (--json <spec.json> | --event <EventName> --action <type> [key=value ...])",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "remove-interaction",
    "script": "remove-interaction.mjs",
    "summary": "按事件类型移除活动事件，或按 Case/Action 序号移除单个活动动作",
    "usage": "node remove-interaction.mjs source.rp output.rp <widgetName|pageName> [--page] [--on-page <pageName>] --event <EventName> (--remove-event | --remove-action --case-index <n> --action-index <n>)",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "add-click-link",
    "script": "add-click-link.mjs",
    "summary": "给无交互的具名元件添加点击打开链接交互（capabilities.md 未列此工具，仅结构级）",
    "usage": "node add-click-link.mjs source.rp output.rp widgetName url [current|new]",
    "output": "index:3",
    "evidence": "structure"
  },
  {
    "command": "clone-library-widget",
    "script": "clone-library-widget.mjs",
    "summary": "从 .rplib 克隆单个原生控件到目标 .rp 页面",
    "usage": "node clone-library-widget.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> <newName> [--x N --y N --w N --h N]",
    "output": "index:4",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "clone-library-page-content",
    "script": "clone-library-page-content.mjs",
    "summary": "把 .rplib 库页的全部内容闭包导入目标 .rp 页面",
    "usage": "node clone-library-page-content.mjs <source.rplib> <target.rp> <output.rp> <sourcePage> <targetPage> [--x N --y N]",
    "output": "index:4",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-combobox-options",
    "script": "set-combobox-options.mjs",
    "summary": "设置唯一原生 ComboBox 的选项与选中项",
    "usage": "node set-combobox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <zeroBasedIndex>]",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-listbox-options",
    "script": "set-listbox-options.mjs",
    "summary": "设置唯一原生 ListBox 的选项、多选与选中索引",
    "usage": "node set-listbox-options.mjs <source.rp> <output.rp> <pageName> <widgetName> <options-json> [--selected <indices-json>] [--single]",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-native-table",
    "script": "set-native-table.mjs",
    "summary": "改写原生 Table 矩阵/行高/列宽，扩容时克隆单元格，格支持 {runs} 多 run；可选用同页 VectorShape 模板生成视觉合并覆盖块",
    "usage": "node set-native-table.mjs input.rp output.rp table.json",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "clone-native-connector",
    "script": "clone-native-connector.mjs",
    "summary": "克隆原生 Connector 与端点闭包到目标页面（支持自定义锚点 GUID/坐标/方向保留及 PanelState 源图，跨 diagram 端点拒绝）",
    "usage": "node clone-native-connector.mjs <source.rp> <target.rp> <output.rp> <sourceRecord> <connectorId> <targetPage> [options-json]",
    "output": "index:4",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-connector-anchors",
    "script": "set-connector-anchors.mjs",
    "summary": "在同一 Page 或 PanelState 记录内把连接线端点挂接到元件或脱开为自由端",
    "usage": "node set-connector-anchors.mjs <source.rp> <output.rp> <pageName> <connector-name-or-selector-json> <endpoints-json>",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-widget-text",
    "script": "set-widget-text.mjs",
    "summary": "按页内名称、记录索引+对象 ID 或容器路径精确定位改写一个既有文本片段",
    "usage": "node set-widget-text.mjs <source.rp> <output.rp> <pageName> <widgetName> <text>",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-widget-richtext",
    "script": "set-widget-richtext.mjs",
    "summary": "整段重写原生 RichTextBlock 的段落与 runs（字体/字号/行距/对齐/原生列表级别/wrapping/trimming 及 run 全量键）",
    "usage": "node set-widget-richtext.mjs source.rp new.rp richtext.json",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "set-master-overrides",
    "script": "set-master-overrides.mjs",
    "summary": "按实例 ID 创建/更新/清除母版实例的文字覆盖或写入内嵌 PNG，不改共享定义",
    "usage": "node set-master-overrides.mjs source.rp new.rp overrides.json",
    "output": "index:3",
    "evidence": "gui-roundtrip"
  },
  {
    "command": "name-widget",
    "script": "name-widget.mjs",
    "summary": "按旧名称快捷改名（可加页名），或按记录/对象 ID 精确改名；保留身份与交互",
    "usage": "node name-widget.mjs <source.rp> <new.rp> --name <oldName> --to <newName> [--page <pageName>]；或 --record <record> --widget <id> --to <newName>；兼容 <pageRecordsIndex|页名> <widgetId> <newName> [...]",
    "output": "index:3",
    "evidence": "preview"
  },
  {
    "command": "patch-link-window",
    "script": "patch-link-window.mjs",
    "summary": "字节级改写唯一 Page 记录里链接打开方式 current/new（capabilities.md 未列，仅结构级研究工具）",
    "usage": "node patch-link-window.mjs <source.rp> <new.rp> <current|new>",
    "output": "index:3",
    "evidence": "structure"
  },
  {
    "command": "patch-string",
    "script": "patch-string.mjs",
    "summary": "替换唯一 Page 记录中的一个已有字符串（研究用，capabilities.md 未列）",
    "usage": "node patch-string.mjs <source.rp> <new.rp> <old string> <new string>",
    "output": "index:3",
    "evidence": "structure"
  },
  {
    "command": "rp-read",
    "script": "rp-read.mjs",
    "summary": "只读解析 .rp 输出页面/元件/交互摘要或 JSON（含 dangling refs 检查）",
    "usage": "node rp-read.mjs <file.rp> [--json] [--full]",
    "output": "none",
    "evidence": "structure"
  },
  {
    "command": "axvg build",
    "script": "axvg.mjs",
    "summary": "把布局规格 JSON 展开为完整 Axvg JSON（几何/样式编码）",
    "usage": "node axvg.mjs build <spec.json> -o <out.axvg.json>",
    "output": "flag:-o",
    "evidence": "channel-a"
  },
  {
    "command": "axvg paste",
    "script": "axvg.mjs",
    "summary": "把 Axvg JSON 写入剪贴板并触发 Axure 粘贴上画布（宿主按 --version / --bundle-id 显式绑定）",
    "usage": "node axvg.mjs paste <file.axvg.json> [--no-menu] [--version 9|11] [--bundle-id <id>]",
    "output": "none",
    "evidence": "channel-a"
  },
  {
    "command": "axvg selftest",
    "script": "axvg.mjs",
    "summary": "内置几何/编码断言自检，不产出文件",
    "usage": "node axvg.mjs selftest",
    "output": "none",
    "evidence": "channel-a"
  }
];

// 无 CLI 入口（或仅自测 main guard）的库/研究脚本，只参与存在性与 evidence 校验。
const LIB_SCRIPTS = [
  { "script": "prototype-worker.mjs", "summary": "异步原型生成子进程；返回结构化生成结果并保持 MCP 可响应", "evidence": "internal" },
  { "script": "image-structure.mjs", "summary": "图片重建分组、重复模式、共享样式和编辑边界的只读审阅", "evidence": "structure" },
  { "script": "preview-runtime.mjs", "summary": "真实 Axure 浏览器预览操作、运行变量观测及源码映射诊断", "evidence": "preview" },
  { "script": "interaction-lint.mjs", "summary": "原生交互公式、条件分组和全局变量用法静态检查", "evidence": "structure" },
  { "script": "official-interactions.mjs", "summary": "静态解码 Axure 官方 HTML 页数据并定位 STO 编译错误", "evidence": "preview" },
  { "script": "native-program-patch.mjs", "summary": "在既有 RP9 文档中增量编译并绑定交互程序", "evidence": "structure" },
  { "script": "native-widget-identity.mjs", "summary": "原生 GUID、RP/1 源码映射及官方播放器元件 ID 的对应", "evidence": "structure" },
  { "script": "authoring-workflow.mjs", "summary": "创作范例、只读诊断、绑定解释、活动版本指纹与受保护改稿闭环", "evidence": "structure" },
  {
    "script": "version.mjs",
    "summary": "Axure 版本边界：文件头识别（RP9 acef0900 / RP11 acef0b00）、目标版本解析、宿主与模板按版本绑定",
    "evidence": "structure"
  },
  {
    "script": "version-adapt.mjs",
    "summary": "按目标版本裁剪/改写新建对象的共享适配器（所有 writer 复用，避免独立实现漏适配）",
    "evidence": "structure"
  },
  {
    "script": "fix-panel-registry.mjs",
    "summary": "补齐 RP 9 的面板注册链（DynamicPanelInfo/PanelDiagramInfo）；缺失时 RP 9 不渲染面板状态内容",
    "evidence": "gui-roundtrip"
  },
  {
    "script": "version-lint.mjs",
    "summary": "按目标版本扫描文件里的版本专属键违规（三零查不出这类问题）",
    "evidence": "structure"
  },
  {
    "script": "version-fields.mjs",
    "summary": "RP 9 / RP 11 动作与信息对象的字段差异表（由两版自带原生样本实测键集派生）",
    "evidence": "structure"
  },
  {
    "script": "pack-release.mjs",
    "summary": "按代码与使用文档白名单生成新发布目录和 SHA 清单，排除研究、Axure 资源和 fixture",
    "evidence": "internal"
  },
  {
    "script": "jobs.mjs",
    "summary": "后台异步生成/改稿与 macOS GUI 保存关闭重开队列：统一 jobs(list|get|cancel) 句柄管理，单服务内串行",
    "evidence": "internal",
    "tools": [
      {
        "name": "gui_roundtrip",
        "description": "复制到新文件后在 Axure RP 9 或 RP 11 保存、关闭、重开（宿主按 version 或源文件版本绑定）；可选传 preview=true 在重开后触发菜单「发布 -> 预览」。默认立即返回 job 句柄。",
        "inputSchema": {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1
            },
            "output": {
              "type": "string",
              "minLength": 1,
              "description": "输出 .rp 路径（传 \"auto\" 或省略时自动按源名生成 -gui.rp 新文件；相对路径基于 cwd 或当前工作目录解析）"
            },
            "cwd": {
              "type": "string",
              "minLength": 1,
              "description": "可选工作目录；用于解析相对路径（默认 process.cwd()）"
            },
            "projectDir": {
              "type": "string",
              "minLength": 1,
              "description": "可选工作目录（同 cwd）"
            },
            "wait": {
              "type": "boolean"
            },
            "preview": {
              "type": "boolean",
              "description": "可选：重开后是否触发 Axure 原生菜单「发布 -> 预览 / Publish -> Preview」启动本地预览，默认 false"
            },
            "version": {
              "type": "integer",
              "enum": [
                9,
                11
              ],
              "description": "目标 Axure 版本；省略时用源文件头版本"
            }
          },
          "required": [
            "source"
          ],
          "additionalProperties": false
        }
      },
      {
        "name": "jobs",
        "description": "管理当前 MCP 服务的后台异步任务（generate_prototype / revise_prototype 的 async:true 任务与 gui_roundtrip）：action=\"list\" 列出任务；action=\"get\" 读取状态、进度与结果；action=\"cancel\" 取消排队或运行中的任务。",
        "inputSchema": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "list",
                "get",
                "cancel"
              ],
              "description": "任务操作：list 列出全部；get 查询指定任务；cancel 取消排队或运行中任务"
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "任务句柄 ID（action 为 get 或 cancel 时必填）"
            }
          },
          "required": [
            "action"
          ],
          "additionalProperties": false
        }
      }
    ]
  },
  {
    "script": "blank-template.mjs",
    "summary": "解析用户本机空白模板 AXURE_BLANK_TEMPLATE 或本机缓存；不分发 Axure 模板",
    "evidence": "internal"
  },
  {
    "script": "mcp-tools.mjs",
    "summary": "收敛后的 MCP 工具面（Studio / RP1 / 图片 / 会话 / 浏览器验证 / rp_inspect / rp_patch / rp_command），经 AxureSession 与原生库执行",
    "evidence": "internal",
    "rawArgs": true,
    "defaultInputSchema": {
      "type": "object",
      "properties": {
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "args"
      ],
      "additionalProperties": false
    },
    "commandSchemas": {
      "list-custom-styles": {
        "inputSchema": { "type": "object", "properties": { "source": { "type": "string", "minLength": 1 } }, "required": ["source"], "additionalProperties": false },
        "positionals": ["source"]
      },
      "rename-custom-style": {
        "inputSchema": { "type": "object", "properties": { "source": { "type": "string", "minLength": 1 }, "output": { "type": "string", "minLength": 1 }, "oldName": { "type": "string", "minLength": 1 }, "newName": { "type": "string", "minLength": 1 } }, "required": ["source", "output", "oldName", "newName"], "additionalProperties": false },
        "positionals": ["source", "output", "oldName", "newName"]
      },
      "rebind-widgets": {
        "inputSchema": { "type": "object", "properties": { "source": { "type": "string", "minLength": 1 }, "output": { "type": "string", "minLength": 1 }, "styleGuid": { "type": "string", "minLength": 1 }, "selector": { "type": "string", "minLength": 1 }, "resetOverrides": { "type": "boolean" } }, "required": ["source", "output", "styleGuid", "selector"], "additionalProperties": false },
        "positionals": ["source", "output", "styleGuid", "selector"], "flags": { "resetOverrides": "--reset-overrides" }
      },
      "rp-read": {
        "inputSchema": {
          "type": "object",
          "properties": {
            "file": {
              "type": "string",
              "minLength": 1
            },
            "full": {
              "type": "boolean"
            }
          },
          "required": [
            "file"
          ],
          "additionalProperties": false
        },
        "positionals": [
          "file"
        ],
        "constants": [
          "--json"
        ],
        "flags": {
          "full": "--full"
        }
      },
      "set-widget-text": {
        "inputSchema": {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1
            },
            "output": {
              "type": "string",
              "minLength": 1
            },
            "page": {
              "type": "string",
              "minLength": 1
            },
            "widget": {
              "type": "string",
              "minLength": 1
            },
            "text": {
              "type": "string"
            }
          },
          "required": [
            "source",
            "output",
            "page",
            "widget",
            "text"
          ],
          "additionalProperties": false
        },
        "positionals": [
          "source",
          "output",
          "page",
          "widget",
          "text"
        ]
      },
      "fill-panel-state": {
        "inputSchema": {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1
            },
            "target": {
              "type": "string",
              "minLength": 1
            },
            "output": {
              "type": "string",
              "minLength": 1
            },
            "sourcePage": {
              "type": "string",
              "minLength": 1
            },
            "targetPage": {
              "type": "string",
              "minLength": 1
            },
            "targetMaster": {
              "type": "string",
              "minLength": 1,
              "description": "目标母版名；与 targetPage 必须且只能填写一个"
            },
            "panel": {
              "type": "string",
              "minLength": 1
            },
            "state": {
              "type": "string",
              "minLength": 1
            },
            "mode": {
              "type": "string",
              "enum": [
                "empty",
                "append",
                "replace"
              ]
            }
          },
          "required": [
            "source",
            "target",
            "output",
            "sourcePage",
            "panel",
            "state"
          ],
          "additionalProperties": false
        },
        "positionals": [
          "source",
          "target",
          "output",
          "sourcePage",
          "targetPage",
          "panel",
          "state"
        ],
        "enumFlags": {
          "mode": {
            "empty": [],
            "append": [
              "--append"
            ],
            "replace": [
              "--replace"
            ]
          }
        }
      },
      "add-interaction": {
        "inputSchema": {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1
            },
            "output": {
              "type": "string",
              "minLength": 1
            },
            "target": {
              "anyOf": [
                { "type": "string", "minLength": 1 },
                { "type": "object", "properties": { "page": { "type": "string" }, "widget": { "type": "string" },
                  "master": { "type": "string" }, "logicalId": { "type": "string" }, "guid": { "type": "string", "pattern": "^[0-9a-f]{32}$" },
                  "record": { "type": "integer" }, "id": { "type": "integer" }, "container": { "type": "array", "items": { "type": "string" } }
                }, "additionalProperties": false }
              ]
            },
            "event": {
              "type": "string",
              "minLength": 1
            },
            "action": {
              "type": "string",
              "minLength": 1
            },
            "parameters": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[^=]+="
              }
            },
            "page": {
              "type": "boolean"
            },
            "onPage": {
              "type": "string",
              "minLength": 1
            },
            "replaceEvent": {
              "type": "boolean"
            },
            "baseline": {
              "type": "string",
              "minLength": 1,
              "description": "可选：显式指定 .baseline.json 路径，自动把逻辑 ID（如 btn_reset）解析为原生控件名。"
            },
            "program": { "type": "object", "description": "编译并应用一页原生程序。targets 可用 GUID、逻辑 ID 或名称绑定现有元件。" },
            "programs": { "type": "array", "minItems": 1, "items": { "type": "object" }, "description": "在同一份 RP9 中原子应用多个页面程序。" },
            "sharedRoutines": { "type": "object", "description": "各页面分别编译的共用业务过程。" },
            "variables": { "type": "object", "description": "现有 .rp 的变量类型覆盖，或待创建的变量定义，如 {total:{type:'number',value:0}}。" },
            "preflight": { "type": "string", "enum": ["auto", "static", "official"], "description": "结构化 add-interaction：auto 默认按需调用官方编译器；static 只跑静态检查；official 要求官方编译成功。用 action=preflight 检查而不提交。" },
            "interactions": {
              "type": "array",
              "minItems": 1,
              "description": "可选：直接传入单目标多事件/多分支 JSON（[{event, cases:[{when, isNewIfGroup, actions}]}]）；支持 IsOver/GetPanelState/location/withThis/BoundaryCondition。"
            },
            "items": {
              "type": "array",
              "minItems": 1,
              "description": "可选：单次批量写入多个元件/页面交互的事务数组，全部成功只提交一个新版本，避免生成串行多份 .work 副本。",
              "items": {
                "type": "object",
                "properties": {
                  "target": {
              "anyOf": [
                { "type": "string", "minLength": 1 },
                { "type": "object", "properties": { "page": { "type": "string" }, "widget": { "type": "string" },
                  "master": { "type": "string" }, "logicalId": { "type": "string" }, "guid": { "type": "string", "pattern": "^[0-9a-f]{32}$" },
                  "record": { "type": "integer" }, "id": { "type": "integer" }, "container": { "type": "array", "items": { "type": "string" } }
                }, "additionalProperties": false }
              ]
            },
                  "page": { "type": "boolean" },
                  "onPage": { "type": "string", "minLength": 1 },
                  "replaceEvent": { "type": "boolean" },
                  "event": { "type": "string", "minLength": 1 },
                  "actions": { "type": "array", "minItems": 1 },
                  "interactions": { "type": "array", "minItems": 1 }
                },
                "anyOf": [
                  { "required": ["target", "interactions"] },
                  { "required": ["target", "event", "actions"] }
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "source",
            "output"
          ],
          "anyOf": [
            { "required": ["target", "event", "action"] },
            { "required": ["target", "interactions"] },
            { "required": ["items"] },
            { "required": ["program"] },
            { "required": ["programs"] }
          ],
          "additionalProperties": false
        },
        "positionals": [
          "source",
          "output",
          "target"
        ],
        "flags": {
          "page": "--page",
          "replaceEvent": "--replace-event"
        },
        "values": {
          "onPage": "--on-page"
        },
        "action": [
          "--event",
          "event",
          "--action",
          "action"
        ],
        "tail": "parameters"
      },
      "create-global-variable": {
        "positionals": [
          "source",
          "output",
          "name"
        ],
        "values": {
          "defaultValue": "--default-value"
        },
        "inputSchema": {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "minLength": 1
            },
            "output": {
              "type": "string",
              "minLength": 1
            },
            "name": {
              "type": "string",
              "minLength": 1
            },
            "defaultValue": {
              "type": "string"
            }
          },
          "required": [
            "source",
            "output",
            "name"
          ],
          "additionalProperties": false
        }
      }
    }
  },
  {
    "script": "gen-capabilities.mjs",
    "summary": "由注册表和完整离线回归生成确定性命令文档，-o 输出新文件",
    "evidence": "internal"
  },
  {
    "script": "rp-records.mjs",
    "summary": ".rp 记录流读写核心库（manifest/记录解析/替换/插入/追加），无 CLI 入口",
    "evidence": "internal"
  },
  {
    "script": "parse-payload.mjs",
    "summary": "payload 节点树解析/编码库（parsePayload/encodePayload/field/walkNodes）；含 main guard 仅作逐记录自测打印，不面向用户",
    "evidence": "internal"
  },
  {
    "script": "clone-closure.mjs",
    "summary": "引用闭包计算与跨文档克隆库函数（closureOf/cloneInto），无 CLI 入口",
    "evidence": "internal"
  },
  {
    "script": "ix-actions.mjs",
    "summary": "交互构造核心库（45 事件枚举 + 全部动作分支序列化器），无 CLI 入口",
    "evidence": "internal"
  },
  {
    "script": "expr-schema.mjs",
    "summary": "一次性研究工具：扫描本机 .rplib 提取条件表达式语法统计（顶层直接执行，按任务指定归入库清单）",
    "evidence": "internal"
  },
  {
    "script": "widget-schema.mjs",
    "summary": "一次性研究工具：扫描本机 .rplib 提取各元件类型字段清单统计（顶层直接执行，按任务指定归入库清单）",
    "evidence": "internal"
  },
  {
    "script": "engine.mjs",
    "summary": "编排引擎库（AxureSession 按注册表分发、受保护成品红线与 AXURE_WRITE_ROOT 白名单），spawn 透传存量脚本，无 CLI 入口",
    "evidence": "internal"
  },
  {
    "script": "trace.mjs",
    "summary": "截图临摹工具链入口（scan 字帖扫描 / crop 形态学膨胀擦字与 1x 安全裁切 / verify 透底与残差热力图 / build 一键编译 / selftest），封装 trace.py 与 trace-ocr.swift",
    "evidence": "channel-a"
  },
  {
    "script": "native-scene.mjs",
    "summary": "RP/1 矩形场景直接写入 RP 9 原生编组、形状、文字和内嵌图片，无 GUI 或缓存依赖",
    "evidence": "internal"
  },
  {
    "script": "native-acceptance.mjs",
    "summary": "Ego Page 上逐步比对 RP/1 模型与原生预览，保存首错与删除最小反例",
    "evidence": "internal"
  },
  {
    "script": "native-repeater.mjs",
    "summary": "RP/1 原生 Repeater 模型、初始数据与行模板装配库",
    "evidence": "internal"
  },
  {
    "script": "native-forms.mjs",
    "summary": "RP/1 原生表单控件、选项、初态与交互状态样式装配库",
    "evidence": "internal"
  },
  {
    "script": "runtime-expr.mjs",
    "summary": "RP/1 有类型运行期 AST 到 Axure 原生变量、控件、行与目标行作用域表达式",
    "evidence": "internal"
  },
  {
    "script": "proto.mjs",
    "summary": "声明式直接原型生成与双通道混合编译入口（支持 --spec <spec.json> 与 --preset、Web/Mobile 多主题、设备外框自动合成、多页装配与动态面板/原生控件/跨页交互离线装填），封装 proto.py",
    "evidence": "channel-a"
  },
  {
    "script": "merge-pages.mjs",
    "summary": "多页 .rp 工程装配工具与库（将多个单页或多页 .rp 合并为一个多页 .rp，重映射页面 GUID 并注册 Sitemap 树节点与 PackageDocument 映射）",
    "evidence": "loaded"
  },
  {
    "script": "extract-assets.mjs",
    "summary": "从 .rp 工程提取内嵌 PNG 位图资源及宿主的精确几何尺寸（x/y/w/h）并输出 manifest.json",
    "evidence": "structure"
  },
  {
    "script": "python.mjs",
    "summary": "跨平台 Python 3 解释器解析（Windows 使用 python / py，其他平台使用 python3）",
    "evidence": "internal"
  },
  {
    "script": "py.mjs",
    "summary": "按平台选择 Python 解释器执行脚本的 npm test 包装器",
    "evidence": "internal"
  },
  {
    "script": "html-import.mjs",
    "summary": "通过 Headless Chrome CDP 提取本地 HTML 或在线网页的真实排版、表单与矢量结构为 RP/1 源码与规范",
    "evidence": "internal"
  },
  {
    "script": "doctor.mjs",
    "summary": "跨平台环境自检与能力矩阵诊断 CLI（检查 Node、Python、Pillow/NumPy、Chrome 与 RP9 模板）",
    "evidence": "internal"
  }
];

// ---- 库接口 ----
// 返回副本（structuredClone），调用方改写不会污染注册表本体。
export function listCommands() {
  return structuredClone(COMMANDS);
}

export function getCommand(name) {
  const hit = COMMANDS.find(c => c.command === name);
  return hit ? structuredClone(hit) : null;
}

// axvg.mjs 挂三个子命令，此处只取首个匹配；要全查用 listCommands().filter。
export function findCommandByScript(script) {
  const hit = COMMANDS.find(c => c.script === script);
  return hit ? structuredClone(hit) : null;
}

// ---- 自检 ----
function validateRegistry() {
  const problems = [];
  const seenCommand = new Map();
  COMMANDS.forEach((e, i) => {
    const where = `commands[${i}] ${e.command ?? '(缺 command)'}`;
    for (const key of ['command', 'script', 'summary', 'usage', 'output', 'evidence']) {
      if (typeof e[key] !== 'string' || e[key].length === 0) problems.push(`${where}: 字段 ${key} 缺失或非非空字符串`);
    }
    if (typeof e.command === 'string') {
      if (seenCommand.has(e.command)) problems.push(`${where}: command 名与 ${seenCommand.get(e.command)} 重复`);
      else seenCommand.set(e.command, where);
    }
    if (typeof e.script === 'string') {
      if (!e.script.endsWith('.mjs')) problems.push(`${where}: script 不是 .mjs 文件名`);
      else if (!existsSync(join(SCRIPTS_DIR, e.script))) problems.push(`${where}: 脚本文件不存在 ${e.script}`);
    }
    if (typeof e.output === 'string' && !OUTPUT_PATTERN.test(e.output)) problems.push(`${where}: output 格式非法 "${e.output}"`);
    if (typeof e.evidence === 'string' && !EVIDENCE_LEVELS.includes(e.evidence)) problems.push(`${where}: evidence "${e.evidence}" 不在枚举内`);
  });
  LIB_SCRIPTS.forEach((e, i) => {
    const where = `libScripts[${i}] ${e.script ?? '(缺 script)'}`;
    for (const key of ['script', 'summary', 'evidence']) {
      if (typeof e[key] !== 'string' || e[key].length === 0) problems.push(`${where}: 字段 ${key} 缺失或非非空字符串`);
    }
    if (typeof e.script === 'string' && !existsSync(join(SCRIPTS_DIR, e.script))) problems.push(`${where}: 脚本文件不存在 ${e.script}`);
    if (typeof e.evidence === 'string' && !EVIDENCE_LEVELS.includes(e.evidence)) problems.push(`${where}: evidence "${e.evidence}" 不在枚举内`);
  });
  // 覆盖核对：registry.mjs 自身是编排层新增、不在 2026-10-07 存量盘点内，故排除。
  const referenced = new Set([...COMMANDS, ...LIB_SCRIPTS].map(e => e.script).filter(s => typeof s === 'string'));
  const onDisk = readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.mjs') && d.name !== 'registry.mjs')
    .map(d => d.name);
  for (const f of onDisk) if (!referenced.has(f)) problems.push(`scripts/${f} 未登记在注册表`);
  return problems;
}

function registryData() {
  return { ...structuredClone(META), commands: structuredClone(COMMANDS), libScripts: structuredClone(LIB_SCRIPTS) };
}

// ---- CLI ----
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || import.meta.url).href;
if (IS_MAIN) {
  if (process.argv.some(a => protectedPaths().includes(resolve(a)))) {
    console.error(`拒绝执行：AXURE_PROTECTED_PATHS 中的路径是受保护成品，禁止作为任何路径参数`);
    process.exit(1);
  }
  const sub = process.argv[2];
  if (sub === 'dump') {
    console.log(JSON.stringify(registryData(), null, 2));
  } else if (sub === 'validate') {
    const problems = validateRegistry();
    if (problems.length === 0) {
      const cliScripts = new Set(COMMANDS.map(c => c.script)).size;
      console.log(`OK：${COMMANDS.length} 条命令（${cliScripts} 个脚本）+ ${LIB_SCRIPTS.length} 个库脚本，scripts/ 共 ${cliScripts + LIB_SCRIPTS.length} 个 .mjs 全部核对通过`);
    } else {
      for (const p of problems) console.error(p);
      console.error(`共 ${problems.length} 个问题`);
      process.exit(1);
    }
  } else if (sub === 'table') {
    const esc = s => s.replaceAll('|', '\\|');
    const lines = ['| 命令 | 脚本 | 用途 | 证据层级 |', '| --- | --- | --- | --- |'];
    for (const c of COMMANDS) lines.push(`| ${esc(c.command)} | ${esc(c.script)} | ${esc(c.summary)} | ${c.evidence} |`);
    lines.push('', '库脚本（无 CLI 入口）：', '', '| 脚本 | 用途 | 证据层级 |', '| --- | --- | --- |');
    for (const l of LIB_SCRIPTS) lines.push(`| ${esc(l.script)} | ${esc(l.summary)} | ${l.evidence} |`);
    console.log(lines.join('\n'));
  } else {
    console.error('用法: node registry.mjs dump | validate | table');
    process.exit(1);
  }
}
