# ATTRIBUTION · 素材出处台账

本仓库每个非代码素材文件的来源与许可,逐目录登记。CI 门禁
`test:attribution`(tools/check-attribution.mjs)强制:`assets/` 下每个文件
必须被本台账至少一行路径前缀覆盖;新增素材先补行再加文件(figcraft house rule:
"Every asset needs a row")。

| 路径前缀 | 来源 | 许可 | 说明 |
|---|---|---|---|
| `assets/mobile-primitives/` | 本仓原创:`examples/generate-assets.py` 由几何绘图命令生成 | MIT(随项目) | 手机壳/状态栏/图标 PNG 与 manifest;无提取的手机型号官方图、厂商图标、截图或字体文件;设备名仅为规格兼容别名 |
| `assets/readme/` | 本仓原创:README 展示图与封面(原创 SVG + 真实 Studio 截图) | MIT(随项目) | 截图内容为栖羽/知序等本项目自产原型;照片类素材见其行 |
| `assets/promo/` | 本仓原创:宣传片封面 | MIT(随项目) | 知序题材,自产原型截图 |
| `assets/dashboard-example.spec.json` | 本仓原创:示例规格 | MIT(随项目) | 文档示例 |
| `assets/demo-layout.svg` | 本仓原创:示例布局 | MIT(随项目) | 文档示例 |
| `test/fixtures/fonts/` | 本仓原创:几何测试字体 | CC0-1.0 | 简单矩形字形,非生产排版用;见目录内 LICENSE.txt |
| `examples/rp-language/` 引用的图片资源 | 本仓原创简化几何 | MIT(随项目) | 移动示例不含真实品牌素材 |

## 明确排除

- 本仓库**不含**任何从第三方产品提取的图标、图片、字体、截图(figcraft clean-room
  规则同类):设备名(iPhone 17 Pro 等)仅为规格兼容别名。
- 系统字体(PingFang.ttc 等)只在使用者本机按需调用,不入仓。
- 用户项目的 `.rp`/照片素材(如栖羽摄影)不入仓;真实摄影照片仅存于本机
  `axure-exp` 证据目录并按需引用。

## 校验

`npm run test:attribution` — 遍历 `assets/**` 每个文件,断言路径被上表前缀
覆盖;台账行本身由 CI 与本地门禁同时守护。
