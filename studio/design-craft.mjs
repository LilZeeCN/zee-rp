export const DESIGN_AXES = ['structure', 'reading-order', 'typography', 'density', 'imagery', 'interaction'];

const checks = {
  planning: ['先写用户要完成的动作、读到的事实和不能改变的行为；从已有工程与素材取证。', '方向未定时提出不同的信息组织与阅读路径；每案说明理由和代价。已有有效方向则继续深化。'],
  skeleton: ['先确定主角、阅读顺序与主操作的位置；用真实长短内容检验区域职责。', '重复区域使用组件，内容布局使用row/column/grid与gap；可编辑结构要经得住删项、重排和改字。'],
  content: ['参考作品的品牌、人物、数字和文案不是本工程事实；未知内容保持缺失或明确注明演示。', '把状态到达路径、操作后的反馈与完整文案一起设计；不能靠删内容或断开行为改善画面。'],
  refine: ['为当前任务确定字阶、间距、图像焦点与少量强调；已有品牌和有效决定优先。', '全局变化用现有tokens/组件参数，单处样式用节点属性，文案原位编辑；不把所有字段变成旋钮。'],
  review: ['实际查看当前版本和必要状态的截图；先定位最影响任务的问题，同时记录值得保留的部分。', '每条意见写清观察、对任务的影响、具体修改和保留项；用节点定位源，未看到的宽度/状态不能猜测。'],
  edit: ['按明确选区、源宏参数或实例覆盖修改；保留未提及文案、布局与事件。'],
};

export function getDesignCraft({ stage = 'planning', platform = 'mobile', decisions = null } = {}) {
  const directions = decisions?.effective?.filter(record => record.subject === 'direction') || [];
  const conflicts = decisions?.conflicts?.filter(record => record.subject === 'direction') || [];
  const mode = stage === 'edit' ? 'targeted-edit' : conflicts.length ? 'resolve-conflict' : directions.length ? 'continue-direction' : 'explore-direction';
  return {
    kind: 'design-guidance', mode,
    directionDecisionIds: directions.map(record => record.id),
    rule: '参考是创作材料；effective中的代理决定可供连续创作沿用，但不表示用户认可。用户本次明确要求优先；不因缺少方向自动阻塞写稿或反复提问。',
    checks: checks[stage],
    ...(stage === 'planning' && mode === 'explore-direction' ? {
      comparison: { count: 3, axes: DESIGN_AXES, minimumDifferentAxes: 2, evidence: '看真实构图和必要状态；颜色变化本身不证明不同方向。',
        candidateField: 'designIntent:{reason,tradeoff,axes}；id/label保持稳定，结果不自动排序为审美优劣。' },
    } : {}),
    ...(stage === 'refine' || stage === 'review' ? {
      inspection: { priority: ['任务和主操作', '内容层级与阅读路径', '字形/图像/留白', '长内容与空错状态', '编辑和交付保真'],
        scale: platform === 'mobile' ? '检查原型内容中实际点击热区；44px作为常见起点，按设备与任务验真。' : '在声明的视口检查密度、行宽和操作可达；固定画板不自动代表响应式。',
        finding: { nodeIds: [], issue: '真实可见的观察', consequence: '怎样影响用户任务', decision: '具体改什么', preserve: '哪些有效部分要保留' },
        evidence: '机器指标、代理看图、用户选择和原生行为是不同证据，不互相替代。' },
    } : {}),
  };
}
