// 把「按目标版本裁剪/改写新建对象」的逻辑集中一处，供所有 writer 复用。
//
// 背景：RP 9 与 RP 11 的动作/信息对象键集不同（见 version-fields.mjs，数据来自两版自带原生样本）。
// 只在 ix-actions.mjs 里做适配是不够的——独立实现的 writer（如 add-click-link.mjs）会漏掉，
// 而三零检查查不出这类问题。用 scripts/version-lint.mjs 可以全量扫描发现漏网。
import { RP11_ONLY_KEYS, RP9_TAG_OVERRIDES, RP11_ONLY_CLASSES, RP9_ENABLE_VALUES } from './version-fields.mjs';

/**
 * 就地改写新建对象，使其符合目标版本的原生字段集。只处理目标版本为 9 的情况；
 * version 11 时原样返回（保持 RP 11 默认行为不变）。
 *
 * @param {Array} nodes   新建对象节点（{tag:9,className,body:{entries:[[keyNode,valueNode]]}}）
 * @param {object} opts   { version, str, log }
 *        str: (text) => 字符串节点工厂（会往记录字符串表里追加）
 *        log: (message) => 收集本次适配说明
 * @returns {string[]} 本次做过的适配说明
 */
export function adaptNodesForVersion(nodes, { version, str, log = () => {} }) {
  // str 只在改名分支里用到；目前 RP9_RENAME_INVERT 为空（REA 否定了两键互换的做法），
  // 所以调用方可以不传。若将来真有改名规则而没传 str，这里明确报错而不是静默跳过。
  if (version !== 9) return [];
  const changes = [];
  const note = m => { changes.push(m); log(m); };

  for (const node of nodes) {
    const cls = node.className;
    if (RP11_ONLY_CLASSES.includes(cls)) {
      throw new Error(`${cls} exists only in Axure RP 11; refusing to write it into an RP 9 document`);
    }
    const entries = node.body?.entries;
    if (!entries) continue;
    // 实测表用去掉 Axure: 前缀的短名（与 version-lint.mjs 同一口径）
    const short = String(cls).replace(/^Axure:/, '');

    // 裁剪集合直接取实测表：凡是「两版语料都出现、RP 11 writer 多出来的键」都去掉。
    // 不用正则猜类名家族——Axure 自己把 SetFunction 的类名拼成 InterationActionSetFunction，
    // 既不以 Action 结尾也不含 Interaction，任何按名字猜的规则都会漏。
    // 也**不做改名**：曾把 InteractionCase.Disabled 改成 IsEnabled 并取反，被 REA 真值否定
    // （RP9 IxCase.rv2F 只写 Description/Condition/IsNewIfGroup，全程序集无 IsEnabled 字面值）。
    const drop = new Set(RP11_ONLY_KEYS[short] ?? []);
    const overrides = RP9_TAG_OVERRIDES[short] ?? {};
    const kept = [];

    for (const pair of entries) {
      const [keyNode, valueNode] = pair;
      const key = keyNode.text;
      if (drop.has(key)) { note(`${cls}.${key} 去掉（RP 11 新增键）`); continue; }
      if (overrides[key] === 'bool' && valueNode.tag !== 0x19) {
        note(`${cls}.${key} int→bool（RP 9 原生为 bool：0=启用 / 1=禁用）`);
        kept.push([keyNode, { tag: 0x19, value: valueNode.value === 0 }]); continue;
      }
      kept.push(pair);
    }
    node.body.entries = kept;
  }
  return [...new Set(changes)];
}

export { RP9_ENABLE_VALUES };
