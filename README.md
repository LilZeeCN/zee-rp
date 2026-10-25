<div align="center">

<img src="assets/readme/hero.svg" alt="zee-rp — Describe. Compile. Keep editing." width="100%">

<h1>让 AI 画出原型，<br>在 Axure 里继续改。</h1>

从一句需求、一张截图，到带页面、变量和交互的原生 **`.rp`**。<br>
用 **RP/1** 写设计，用 **MCP / CLI** 生成，打开 **Axure** 接着改。

[![MIT](https://img.shields.io/badge/license-MIT-142033?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/github/v/release/LilZeeCN/zee-rp?style=flat-square&color=304FFE)](https://github.com/LilZeeCN/zee-rp/releases)
[![Checks](https://img.shields.io/github/actions/workflow/status/LilZeeCN/zee-rp/test.yml?style=flat-square&label=checks)](https://github.com/LilZeeCN/zee-rp/actions)

[看原型](#先看一个完整的-app) · [开始使用](#把它接到你的-agent) · [理解 RP/1](#设计有源码就能接着生长) · [能力与边界](#交付到哪一步就验证到哪一步) · [English](README.en.md)

</div>

## 先看一个完整的 App

> 「做一个好看的观鸟手机应用，带 iPhone 17 Pro 外壳，设计你自己定。」

**栖羽 / QIYU**：自然绿、暖白与鸟类实拍，串起探索、拍照识鸟演示、鸟种详情、观鸟地点和个人手记。9 页原型，能填地点、写观察、收藏鸟种、切换图鉴，保存后回到手记查看。

<table>
<tr>
<td width="33%"><img src="assets/readme/qiyu-home.png" alt="栖羽探索首页：今日翠鸟、附近羽邻与识鸟入口" width="100%"></td>
<td width="33%"><img src="assets/readme/qiyu-species.png" alt="鸟种详情：独立文本、标签、动态面板与记录按钮" width="100%"></td>
<td width="33%"><img src="assets/readme/qiyu-journal.png" alt="个人观鸟手记：时间轴、变量回显与图鉴切换" width="100%"></td>
</tr>
<tr><td align="center">探索今天的羽邻</td><td align="center">认识眼前的鸟</td><td align="center">留下自己的记录</td></tr>
</table>

文字、卡片、按钮、输入和地图示意保留为独立元件；照片是嵌入图片。识别、路线与统计使用演示数据。[图片署名与案例说明](assets/readme/README.md)。

### 再看 40 秒的工作流

https://github.com/user-attachments/assets/39c37462-3956-48b8-b495-fe90d2ab9431

以「知序」考研复习 App 展示需求、页面和可编辑原型之间的关系。影片依据原型规格制作，属于流程动画。[下载 1080p / 60fps 视频](https://github.com/LilZeeCN/zee-rp/releases/download/v0.2.1/zee-rp-zhixu-1080p60.mp4) · [制作说明](assets/promo/README.md)。

## 设计有源码，就能接着生长

zee-rp 的核心是一份叫 **RP/1** 的原型源码。页面、布局、数据与事件写在一起，生成后仍然能回到源码改稿，也能在 Axure 里调整。

```text
rp/1 target=9 name="下一次相遇" domain=mobile theme=mobile-hifi

page #home name="发现" device=iphone-17-pro
  phone-shell #shell title="去自然里，遇见飞羽。" gap=16
    card #bird [fillxhug] title="今天，认识一只翠鸟" body="从水边的一抹蓝绿，开始你的观鸟手记。" actionText="记下这次遇见" goto="notes"

page #notes name="手记" device=iphone-17-pro
  phone-shell #shell title="我的第一篇手记" gap=16
    input #note [fillx44] value="今天在水边遇见了它。"
    button #back [fillx44] "返回发现" goto="home"
```

把它保存成 `birding.rp1`，通过 MCP 一次生成原生工程：

```json
{
  "source": "/absolute/path/birding.rp1",
  "output": "/absolute/path/birding.rp"
}
```

生成结果同时包含 `.rp`、源码基线、全页预览、状态拼图与检查报告。`[fillxhug]` 表示宽度铺满、高度按内容测量。[RP/1 手册](references/rp-language.md) · [完整示例](examples/authoring/mobile-cards.rp1) · [MCP 用法](references/mcp-prototype.md)。

| 你想做的事 | zee-rp 的做法 |
| :--- | :--- |
| 从需求搭出多页原型 | 共享主题、组件、变量和跨页跳转，直接生成原生 `.rp` |
| 从截图开始重建 | OCR、形状与布局检测；文字和支持的几何成为原生元件，照片保留为独立图片 |
| 给现有工程改字、改名、改样式 | 直接读取 RP9 / RP11，按名称、逻辑 ID 或对象定位修改 |
| 做第二轮设计 | `revise_prototype` 改源码并重建；`sync_prototype` 在已支持范围内合并原生改稿 |
| 确认它能用 | 布局审计、引用检查、原生浏览器预览回放、保存重开分别记录 |

### 手里有截图，也能开始

<img src="examples/screenshot/comparison.png" alt="原创几何演示图与重建布局的视觉比较" width="100%">

重建会输出可编辑布局和对比图。图片无法透露的业务逻辑需要另行定义。[截图重建流程](references/screenshot-workflow.md)。

## 把它接到你的 Agent

本机需要 **Node.js 18+、Python 3.10+**；生成原生工程还需要 **Axure** 和自己保存的 **RP9 单页空白工程**。截图 OCR 使用 macOS Vision 与 Swift。

```sh
git clone https://github.com/LilZeeCN/zee-rp.git
cd zee-rp
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
```

在 MCP 客户端中添加服务，并把下面三处路径换成自己的绝对路径：

```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "node",
      "args": ["/absolute/path/zee-rp/bin/mcp.mjs"],
      "env": {
        "PATH": "/absolute/path/zee-rp/.venv/bin:/usr/local/bin:/usr/bin:/bin",
        "AXURE_BLANK_TEMPLATE_RP9": "/absolute/path/my-rp9-blank.rp"
      }
    }
  }
}
```

`PATH` 需要包含安装了图片依赖的 Python；如果 Node 不在默认路径，也将 `command` 换成 Node 的绝对路径。Agent 的创作入口是 [SKILL.md](SKILL.md)。

接好之后，可以直接提出一份完整需求：

> 帮我做一个观鸟 App，包含探索、鸟种详情、地点和手记；生成可编辑的 .rp，并检查实际跳转和保存后的回显。

<details>
<summary><strong>更喜欢终端？CLI 也能完成同一件事</strong></summary>

```sh
export AXURE_BLANK_TEMPLATE_RP9=/absolute/path/my-rp9-blank.rp
node scripts/proto.mjs check --spec examples/rp-language/counter.json
node scripts/proto.mjs generate --spec examples/rp-language/counter.json --out-dir outputs/counter --out-rp outputs/counter/counter.rp
node bin/axure.mjs rp-read outputs/counter/counter.rp --json
```

使用新输出文件名，保留原稿。底层命令见[命令表](references/commands-generated.md)。

</details>

## 交付到哪一步，就验证到哪一步

一个 `.rp` 能被解析、能在 Axure 打开、能在浏览器点击、能保存后重开，是四件分别需要证据的事。zee-rp 会保留相应检查结果；`strictAudit` 的通过只说明本次编译的布局与样式门禁通过。

当前原生生成目标为 **RP9**；RP9 / RP11 的读写工具按版本处理。近期宿主行为证据来自特定 **macOS + Axure RP9** 样本。[完整能力范围](references/capabilities.md) · [验证记录](docs/verification.md)。

视觉创作还有明确边界：RP/1 暂无 `fontFamily`，离线字体与宿主回退可能不同；图片圆角、阴影和渐变通过嵌入位图呈现。状态高度、导航样式、字体替代流程和静态预览规则见[视觉创作说明](references/visual-authoring.md)。

## 继续往下看

| 入口 | 内容 |
| :--- | :--- |
| [SKILL.md](SKILL.md) | Agent 创作、改稿与视觉审阅 |
| [RP/1 手册](references/rp-language.md) | 布局、交互、数据、面板、母版与适配 |
| [视觉创作](references/visual-authoring.md) | 居中、字距、导航、状态与字体边界 |
| [已有全局样式](references/custom-styles.md) | Axure 建定义、脚本改名与批量绑定 |
| [贡献指南](CONTRIBUTING.md) | 开发、测试与本机运行前提 |
| [变更记录](CHANGELOG.md) | 已发布版本的变化 |

```sh
npm test
npm run test:language
npm run test:polish
```

源码和原创示例采用 [MIT](LICENSE)。案例中第三方照片的许可与署名单列。项目由 **LilZee** 独立开发，与 Axure 无隶属关系；模板、官方元件库、字体和运行时由使用者本机提供。

<div align="center"><sub>想法写进源码，设计留在你的手里。</sub></div>
