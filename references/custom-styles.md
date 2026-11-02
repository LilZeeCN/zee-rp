# 原生自定义样式：改名与批量绑定

对应 [issue #1](https://github.com/LilZeeCN/zee-rp/issues/1) 和 [issue #2](https://github.com/LilZeeCN/zee-rp/issues/2)。支持 `.rp` 与 `.rplib` 的已有原生样式定义；不提供凭空生成 `StyleSheet.CustomStyles` 对象的接口。元件局部 `MyStyle`、交互用样式与全局自定义样式定义是不同对象，不能混用创建方式。

推荐先在 Axure 的 Widget Style Manager 创建所需样式并保存，再用脚本批量绑定。结构校验通过不能证明新造的全局样式可被客户端接受。报告中关于内部签名、时间戳的解释尚未证实，本项目不将其作为已知根因。

```sh
# 查询现有定义的 GUID。
node bin/axure.mjs list-custom-styles input.rp

# 同步修改定义、所有记录的 MatchInfo 及 StyleCache.Styles[].Info。
node bin/axure.mjs rename-custom-style input.rp renamed.rp Style_A Style_B

# selector.json 例如 {"name":"CardTitle"}、{"record":4,"id":15} 或 {"all":true}。
node bin/axure.mjs rebind-widgets input.rp rebound.rp STYLE_GUID selector.json

# 选择应用目标样式并清除对应局部格式覆盖；保留位置、尺寸、图片和交互样式。
node bin/axure.mjs rebind-widgets input.rp rebound-clean.rp STYLE_GUID selector.json --reset-overrides
```

输出必须使用新文件名。样式 GUID 来自第一步的列表；空选择器和名称冲突会拒绝。筛选支持 `name`、`type`（完整原生类名）、`record`、`id`、`owner`，各字段为精确匹配且同时满足；`all` 必须单独使用。分组 `Layer` 无可绑定外观，选择它会报错；可用 `type` 限定叶元件。没有选中元件时返回空 `applied`，文件保持原样。

MCP 对应 `list_custom_styles({source})`、`rename_custom_style({source,output,oldName,newName})`、`rebind_widgets({source,output,styleGuid,selector,resetOverrides})`。`selector` 是本机 JSON 文件路径；不接受可执行代码或字符串谓词。更改后的工具列表需重连 MCP。

JavaScript 接口供程序内筛选：

```js
import { listCustomStyles, renameCustomStyle, rebindWidgets } from './scripts/custom-styles.mjs';
const { file, applied } = rebindWidgets(bytes, styleGuid,
  widget => widget.name.startsWith('CardTitle'), { resetOverrides: false });
const renamed = renameCustomStyle(file, 'Style_A', 'Style_B');
```

改名按样式 GUID 与库 GUID 联合匹配，遍历页面、母版、面板状态及其他二进制记录，更新各记录的字符串池与缓存；保留相同文字的元件名和其他库同名样式。保留自定义样式列表的原有顺序（Axure 可手工排列），不擅自排序。

绑定同步 `MatchInfo`、PropList 的基样式 GUID（属性 0）及拥有者的样式缓存，不增加全局样式定义、不改变元件 GUID、位置、尺寸或交互。默认保留局部格式覆盖，因此真实的 `*` 可以继续存在；`resetOverrides: true` 清除目标及默认样式管理的局部格式项。带对象/包引用的复杂样式定义暂时明确拒绝，不猜测复制闭包。

`npm run test:styles` 为无 Axure 依赖的合成回归，覆盖两种容器、跨记录字符串池、级联改名、外部同名隔离、绑定、覆盖处理和失败不写入。原生加载、保存重开与星号观察的证据范围另见 [验证记录](../docs/verification.md)。
