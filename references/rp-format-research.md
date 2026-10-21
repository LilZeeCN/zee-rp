# .rp 格式与研究入口

以当前 `rp-records.mjs`、`parse-payload.mjs` 和已留证样本为基础整理（2026-09-22）。这是当前接口说明；原始探索过程完整保存在 历史记录 (research reference not distributed)，其中含被推翻的结论。能力与未验证项见 [能力表](capabilities.md)。

## 文件与记录

```text
.rp / .rppkg
  8 字节外层头
  编码 manifest：01 + varuint 原始长度 + varuint 压缩长度 + LZ4 block
  数据段：包记录、缩略图等 parts
```

- `dataStart = 8 + file.readUInt32LE(4)`；这个 u32 是 8 字节外层头之后的编码块长度。
- `encodeManifest()` 返回外层头与编码块的整体，故返回 Buffer 长度等于新文件的 `dataStart`，不能再加 8。
- manifest 中 `parts.package` 相对 `dataStart`，指向 8 字节前缀；gzip 流在 `dataStart + relativeOffset + 8`。前缀后四字节是 gzip 长度。
- `thumbnail` 在已知样本中为未压缩 JPEG，不能对所有 part 无条件 gunzip。
- `.rplib` 是无该 manifest 的记录流。`readRecords()` 可以扫描 `.rp/.rplib`；依赖 `readManifest()` 的读写工具不能因此推定也支持修改 `.rplib`。
- 当前 manifest 编码器仅支持 LZ4 压缩块；无法缩小数据时显式报错，尚无未压缩块写入分支。

gzip 解压后的普通记录：32 字节头（含 magic `0xC351`、字符串数），之后为字符串表，最后是 payload。每个字符串编码为 u32 字节长度和 UTF-8 字节，字符串引用索引从 1 开始。XML 记录单独识别，不送入 payload 解析器。

## Payload 语法

下面描述当前解析器读写的字节数，不把尚未确认的语义当作格式事实。

| tag（十六进制） | 载荷 |
|---|---|
| `01` | u32 数量 + 键值节点对 |
| `02` | u32 数量 + 节点列表 |
| `03/05/0f/11/12/14/16` | 一个 u32，语义依字段为对象引用、编号等 |
| `04` | u32 长度 + 二进制数据 |
| `06` | 8 字节 f64；保留 NaN 位模式 |
| `08` | 一个 u32 字符串索引，`strings[value-1]` |
| `09` | u32 对象 ID + u32 类名字符串索引 + body 节点 |
| `10/13` | 两个 u32；常见 `13` 为类型字符串索引与 GUID 索引 |
| `19` | 1 字节布尔 |
| `1a/1c` | 无载荷标记 |
| `1d` | 8 字节原始数据（如能力位掩码），不要当作 16 字节 GUID |
| `1e` | u32 数量 + 每项 16 字节 GUID |

已知普通记录根序列为 GUID 列表、`1a`、`0f`、`12`、对象定义、`1c`。`0f` 给出该记录的根对象 ID；不要凭对象排列顺序猜主对象。`1e` 与十进制 30 相同且有载荷，不能归入无载荷标记分支。

## 引用与改写不变量

- 新对象 ID 与该记录 GUID 表的 1-based 索引配对分配；新增 Style 等辅助对象同样需要登记。
- 字符串索引、对象引用、GUID 索引以及独立的小整数 Id 字段不是可以任意互换的值域。
- 包注册需同时对齐文档 PackageInfo/树、manifest 与包记录 GUID；`.NET` GUID 前三组小端转换由 `guidKey()` 处理。
- 根对象插入顺序按已对照工具保持：普通交互定义在末尾终止节点前；AdaptiveViewSet/View 定义在 SiteTreeMap 前。不能把某种根插入方式推广到所有对象。历史“插在 GUID 列表前”的实验结论已被撤回。
- `replaceRecord()` 接受未压缩记录，负责 gzip 及后续 part 的相对偏移调整；多次修改后应重新读取记录偏移，或像既有工具一样从后往前替换。
- `appendPackage(file,key,raw)` 接受未压缩字节并挂在 manifest 根；`insertRecord(file,key,raw,beforeRecord)` 可将记录插到指定记录前，二者都不自动完成面板层级修复。修复后的 `create-panel-clone` 清理模板孤儿对象/StyleCache，把状态包挂到所属 Page 的 children，并把状态记录插在该 Page 之前；历史修复件已能进入 GUI 内部编辑态。
- 复杂元件优先复用 `closureOf/cloneInto`，重建引用、字符串和 GUID 映射后再挂接到目标 diagram。该库本身不负责跨包资源闭包或页面挂载。

交互结构为 InteractionTreeMap 的 node-table + Tree：事件 Node → Case Node → 动作 Node，node-table 把这些节点映射到实际事件/Case/动作对象。Case 条件和动作参数另以对象引用编码。字段名和大小写来自真实样本或已注明的推断，不能仅凭程序集里存在一个类就承诺文件能读。

Axure 保存可能重排对象 ID 及 tag `0x11` 值；结构对比按语义名称、字段和引用关系匹配，不能仅按数字 ID 对齐。位置 DOA `3221225573` 存 X/Y，尺寸 DOA `3221225577` 存 Width/Height。视图身份 GUID 的跨记录绑定、Base/子视图关系及覆盖条目见 [自适应视图](adaptive-views.md)；旧共享 View.Id 结论已被 round7 真值取代。不要覆盖公共空 GUID 来绑定视图集。

中继器静态 Element 的 column-id/type/value、动作内嵌表达式单元格和 actual/add 列映射见 [中继器操作](repeaters.md)。相同字段名在不同对象类中可能采用不同 tag，不能把静态 DataSet 与 AddItems 动作的编码混用。

## 扩展与排错方法

1. 优先检查 Axure 安装内 `DefaultSettings/Training/*.rp` 和 `Libraries/*.rplib`。先枚举实际类名，再判断有无样本；条件样本常在控件库，母版实例类名为 `ReferenceDiagramObject`。
2. 建立只差一个属性的对照件，保存后用 `parsePayload` 做结构对比。字符串表插入、随机 GUID 等会使普通字节 diff 产生大量无关变化。
3. 样本不足时使用程序集元数据/反序列化实现作为线索，明确记录推断字段，避免把可解析当作语义正确。
4. 对照 [验证流程](verification.md) 区分结构、加载、切页、预览及编辑态；记录测试脚手架的限制，避免把默认页正常当作全文件正常。

官方 Axvg 资料见 [序列化规则](official-serialization.md) 与 插件源码 (research reference not distributed)。程序集动作目录见 动作类目录 (research reference not distributed)，它是研究线索，不是可用动作清单。

## 随包研究工具（默认禁用）

仅在用户明确要求格式逆向、复现实验或坏档研究时使用本节。日常原型交付应走 `SKILL.md` 和 [离线工作流](rp-workflow.md)；这些文件随 Skill 保留是为了复现历史，不代表它们是受支持的生产 CLI。调用任何写入型探针前，先确认输入是可丢弃副本、目标目录和输出路径。

| 工具/资料 | 用途与限制 |
|---|---|
| create-panel 历史源码 (research reference not distributed) | 手写面板 schema，已知 Axure 拒读；不作为可执行 CLI |
| widget-factory 历史源码 (research reference not distributed) | 从字段蓝图构造元件，已知拒读；不作为可执行 CLI |
| `duplicate-page.mjs --by-index` | 旧模板克隆实验，已知失败；日常使用按名称复制 |
| add-panel-from-template 历史源码 (research reference not distributed) | 固定模板的早期探针，会向当前工作目录的 `research-rp/round4/` 写实验文件；只保留源码文本，不提供可执行入口 |
| `widget-schema.mjs`、`expr-schema.mjs` | 读取安装内 `.rplib` 并打印字段/表达式统计；库目录可作为首个参数传入 |
| `patch-link-window.mjs` | 局部字节模式补丁，只适用于匹配的旧样本 |
| judge-load 历史源码 (research reference not distributed) | 旧探针会终止 Axure 并尝试点击“否”；只保留源码文本，不提供可执行入口 |
| 元件字段蓝图 (research reference not distributed) | 源于样本的字段清单，字段齐全不代表可构造 |
| ix-actions 旧备份 (research reference not distributed) | 历史备份文本，不是可执行入口 |

外部 `axure-exp/research-rp/` 保留实验样本、反编译工具和更完整证据；它不是运行日常离线工具的必需依赖。
