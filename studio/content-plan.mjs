/**
 * 内容脚手架：工具不能替你想出"还没有项目，先新建第一个"这句话，
 * 但它能告诉你这句话需要哪几个槽位、常见写法是什么、当前哪个节点缺它。
 *
 * 立场：
 *  - 只输出**结构与槽位**，不假装能生成好文案。
 *  - 每个条目给出可直接套用的模板与示例，调用方（人或 agent）填词。
 *  - 不自动改文档；填完用 setProperties.text 提交。
 */

const VAGUE_PREFIX = /^(让|我们|开启|拥抱|赋能|打造|构建|重新定义|解锁)/;
const STOCK_SUFFIX = /(平台|中枢|系统|引擎|生态|解决方案|新时代|新纪元|一站式|全链路|数智化)$/;

const ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/g;
const realText = value => (typeof value === 'string' ? value.replace(ZERO_WIDTH, '').trim() : '');

function childResolver(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const byScoped = new Map(nodes.map(n => [n.scopedId, n]));
  // childrenIds 存的是作用域 id（page/child），不能按裸 id 找。
  return id => byId.get(id) || byScoped.get(id) || byScoped.get(String(id).split('/').pop()) || null;
}

function firstTextDescendant(node, nodes, childOf) {
  for (const id of node.childrenIds || []) {
    const child = childOf(id);
    if (!child) continue;
    if (child.type === 'label' || child.type === 'paragraph' || realText(child.text)) return child;
    const nested = firstTextDescendant(child, nodes, childOf);
    if (nested) return nested;
  }
  return null;
}

function isEmptyState(node, nodes, childOf) {
  if (!node.role || node.role !== 'empty-state') return false;
  if (realText(node.text)) return false;
  const visit = id => {
    const child = childOf(id);
    if (!child) return false;
    if (realText(child.text) || (typeof child.src === 'string' && child.src.trim())) return true;
    return (child.childrenIds || []).some(visit);
  };
  return !(node.childrenIds || []).some(visit);
}

function isVagueHeadline(node) {
  if (typeof node.text !== 'string') return false;
  const text = node.text.trim();
  if (!text || text.length > 18) return false;
  const big = (Number(node.fontSize) || 0) >= 28;
  if (!big) return false;
  const centered = node.textAlign === 'center';
  const stock = STOCK_SUFFIX.test(text) && !/\d/.test(text);
  return centered && (VAGUE_PREFIX.test(text) || stock);
}

export function buildContentPlan(scenePage) {
  const nodes = scenePage.nodes || [];
  const childOf = childResolver(nodes);
  const items = [];

  for (const node of nodes) {
    if (isEmptyState(node, nodes, childOf)) {
      const list = nodes.find(n => n.id === node.for);
      const raw = list?.dataset || list?.name || '';
      // id 形状的名字（如 list / r1）不是"对象名"，别硬塞进句子里。
      const subject = raw && !/^[a-z0-9_-]+$/i.test(raw) ? raw : '数据';
      items.push({
        nodeId: node.id,
        kind: 'empty-state',
        problem: '空态只有结构没有文案，数据为 0 时用户看到一块空白',
        needs: ['对象名（空的是什么）', '下一步动作（能做什么）'],
        template: `还没有${subject}｜先${'{动作}'}`,
        example: '还没有项目｜先新建第一个',
        applyWith: (() => {
          const target = firstTextDescendant(node, nodes, childOf);
          const example = `还没有${subject}｜先新建第一个`;
          return { type: 'setProperties', nodeId: target ? target.id : node.id, properties: { text: example } };
        })(),
      });
    }

    if (isVagueHeadline(node)) {
      items.push({
        nodeId: node.id,
        kind: 'headline',
        problem: `「${node.text.trim()}」是口号而非信息：没说清谁、在什么场景、得到什么`,
        needs: ['角色或对象', '具体场景', '可量化的结果'],
        template: '把{对象}的{场景}从{A}压到{B}',
        example: '把季度续费跟进从 3 天压到 4 小时',
        applyWith: { type: 'setProperties', nodeId: node.id, properties: { text: '把季度续费跟进从 3 天压到 4 小时' } },
      });
    }
  }

  return {
    ok: true,
    pageId: scenePage.id,
    items,
    count: items.length,
    caveat: '这里只给槽位与示例，不假装会写文案。填完用 applyWith 提交；文案的最终判断权在使用者。',
  };
}
