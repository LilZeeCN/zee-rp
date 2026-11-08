import {
  NODE_PROPERTY_NAMES,
  NODE_READONLY_PROPERTIES,
  NODE_UNCONSUMED_PROPERTIES,
  NODE_SYNTAX_ONLY_PROPERTIES,
  RP1_SOURCE_PROPERTIES_BY_TYPE,
  RP1_SOURCE_PROPERTY_CONDITIONS,
} from './node-properties.mjs';

export const NODE_CAPABILITY_SURFACES = ['canvas', 'runtime', 'native', 'full-rp1'];
const textTypes = new Set(['label', 'paragraph', 'button', 'badge', 'input']);
export const STUDIO_SOURCE_ONLY_MACROS = new Set([
  'tab-bar',
  'nav-bar',
  'progress-bar',
  'detail-card',
  'data-table',
  'searchable-list',
  'master-detail',
]);
const rawMacros = STUDIO_SOURCE_ONLY_MACROS;

const containerTypes = new Set([
  'box',
  'card',
  'image',
  'phone-shell',
  'list-item',
  'stat-row',
  'dynamic-panel',
  'instance',
  'use',
  ...STUDIO_SOURCE_ONLY_MACROS,
]);

const geometry = [
  'x', 'y', 'z', 'w', 'h', 'minW', 'maxW', 'minH', 'maxH',
  'visible', 'hidden', 'opacity', 'fill', 'stroke', 'strokeWidth', 'radius',
  'right', 'bottom', 'after', 'afterGap', 'alignX', 'pin', 'pinGap', 'anchor',
  'flex', 'colSpan', 'rowSpan', 'constraints', 'rotation',
  'borderSides', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'clip', 'overflow',
];

const visualEffects = [
  'shadow', 'innerGlow', 'gradient', 'backdropBlur', 'aurora', 'noise',
  'css', 'customFilter', 'threeDTransform',
];

const semanticMeta = [
  'name', 'role', 'locked', 'for', 'emptyFor', 'boundTo',
  'hitW', 'hitH', 'hitArea', 'interactive', 'state',
];

const text = [
  'text', 'content', 'fontFamily', 'font', 'fontSize', 'size',
  'fontWeight', 'weight', 'lineHeight', 'lineGap', 'letterSpacing',
  'color', 'italic', 'underline', 'strikethrough', 'textAlign',
  'spans', 'wrap', 'ellipsis', 'maxLines', 'textPaddingX', 'textPaddingY',
];

const layout = [
  'layout', 'padding', 'gap', 'align', 'justify', 'children',
  'columns', 'columnGap', 'rowGap', 'equalHeight',
];

const cardMacroFields = [
  'title', 'subtitle', 'body', 'tag', 'tagTone', 'tone',
  'variant', 'actionText', 'goto', 'titleFontSize',
];

const listItemMacroFields = [
  'title', 'text', 'subtitle', 'meta', 'rightBadge', 'badge', 'tag',
  'value', 'rightText', 'status', 'rightTone', 'badgeVariant', 'tagTone',
  'tone', 'rightVariant', 'index', 'icon', 'goto', 'page', 'link',
];

const statRowMacroFields = ['items', 'valueFontSize', 'cardPadding', 'equalHeight'];

const phoneShellFields = [
  'device', 'statusBar', 'darkIsland', 'showHomeIndicator',
  'screenFill', 'frameFill', 'body',
];

const repeaterFields = [
  'dataset', 'source', 'rows', 'rowHeight', 'rowGap',
  'filter', 'sort', 'pageSize', 'page', 'key',
];

const instanceFields = [
  'component', 'use', 'props', 'args', 'overrides',
  'slots', 'state', 'variant', 'variantKey',
];

const nonClickEventFields = new Set([
  'when', 'onChange', 'onLoad', 'onMouseOver', 'onMouseOut',
  'onFocus', 'onBlur', 'onStateChange', 'onRowClick', 'onSubmit',
  'onComplete', 'onRight', 'onBack', 'rowOn',
  'where', 'else', 'then', 'condition', 'as',
]);

const gotoCapableTypes = new Set([
  'box', 'label', 'paragraph', 'button', 'badge',
  'image', 'icon', 'input', 'card', 'list-item', 'path', 'sparkline',
]);

const fact = (status, reason, consumer = null) => ({
  status,
  reason,
  ...(consumer ? { consumer } : {}),
});

function buildNodePropertyCapability(type, field, { operation = 'edit', node = null } = {}) {
  const known = NODE_PROPERTY_NAMES.has(field);
  const readOnly = NODE_READONLY_PROPERTIES.has(field);
  const unconsumed = NODE_UNCONSUMED_PROPERTIES.has(field);
  const isSyntaxKey = NODE_SYNTAX_ONLY_PROPERTIES.has(field);

  const result = {
    field,
    sourceWrite: !known
      ? 'unknown'
      : readOnly && operation === 'edit'
        ? 'read-only'
        : unconsumed
          ? 'rejected'
          : 'allowed',
    surfaces: {
      canvas: fact('unsupported', '未对此节点类型启用该字段'),
      runtime: fact('unsupported', '未对此节点类型启用该字段'),
      native: fact('unsupported', '未对此节点类型启用该字段'),
      'full-rp1': RP1_SOURCE_PROPERTIES_BY_TYPE.get(type)?.has(field)
        ? fact('implemented', '此节点类型的完整 RP/1 源契约接受该字段；值、条件、引用及出口限制仍由编译器校验', 'references/rp-language.schema.json:x-source-properties-by-type')
        : fact('unsupported', `完整 RP/1 的 ${type} 源契约不接受字段 ${field}`, 'references/rp-language.schema.json:x-source-properties-by-type'),
    },
  };

  if (!known || unconsumed) {
    const reason = !known
      ? '未知属性'
      : isSyntaxKey
        ? '声明语法键（如 row/column/label 简写），在导入正规化时转为标准 type/layout，不作为节点属性写入'
        : '已确认未消费的历史别名属性，不接受新写入';
    for (const surface of ['canvas', 'runtime', 'native']) {
      result.surfaces[surface] = fact('unsupported', reason, 'studio/node-properties.mjs');
    }
    result.surfaces['full-rp1'] = !known
      ? fact('unsupported', '未知属性', 'scripts/rp_language.py')
      : isSyntaxKey
        ? fact('unsupported', '这是创建节点的声明语法，不是已指定类型节点的属性；请使用对应的节点声明', 'scripts/rp_dsl.py')
        : fact('unsupported', '历史遗留未消费别名；请使用 filter/sort', 'studio/node-properties.mjs');
    return result;
  }

  if (readOnly) {
    const reason = operation === 'create'
      ? '创建可声明身份；内部源关系由正规化过程生成'
      : '稳定身份与内部控制关系只读';
    result.surfaces.canvas = fact('metadata', reason, 'studio/document.mjs:normalizeStudioDocument');
    result.surfaces.runtime = result.surfaces.canvas;
    result.surfaces.native = result.surfaces.canvas;
    result.surfaces['full-rp1'] = field === 'id' || field === 'type'
      ? fact('implemented', 'RP/1 节点身份与类型声明', 'scripts/rp_language.py')
      : fact('metadata', 'Studio 内部正规化源控制标记，导出前已解算', 'studio/document.mjs:normalizeStudioDocument');
    return result;
  }

  let matched = false;
  const consumes = (fields, consumer, reason, native = false) => {
    if (fields.includes(field)) {
      matched = true;
      result.surfaces.canvas = fact('implemented', reason, consumer);
      result.surfaces.runtime = fact('implemented', reason, consumer);
      result.surfaces.native = native
        ? fact('partial', '出口按已解算结果转换；布局约束会固化、部分样式有降级，逐节点报告和宿主样本决定实际边界', 'studio/export-rp.mjs:resolvedTreeToRp1Node')
        : fact('metadata', '保留在 Studio 权威源与兼容报告中', 'studio/export-rp.mjs');
    }
  };

  // 1. Universal geometry, constraints, borders, and clipping
  consumes(geometry, 'studio/scene-resolver.mjs:measureAndLayoutTree + studio/web/src/render.mjs:buildNodeElementHtml', '参与节点几何、显隐、约束或自身表面样式；流式位置仍受父布局控制', true);
  if (field === 'rotation') {
    // W1 2026-11-02：原生 2D 旋转破解。.rp MyStyle DOA 3221225522（0xC0000000+50，f64 度）；
    // 官方库 Menu Carat=180°/Summing Junction 315° 样本 + 探针三重验证（注入存活/规范重写存活/preview data.js rotation:15 + styles.css rotate(15deg)）。
    result.surfaces.native = fact('implemented', 'shape/box/image 导出为原生可编辑旋转（DOA 3221225522）；纯文本元件的旋转在 .rp 中持久化，但 Axure RP9 预览发布不渲染文本旋转（平台边界）', 'scripts/native-scene.mjs:emit + scripts/proto.py make_axvg_* + studio/export-rp.mjs:resolvedTreeToRp1Node');
    if (type === 'input') result.surfaces.native = fact('implemented', 'RP9 TextBox 保留角度，以原生 OnLoad 绝对旋转动作恢复预览；输入保持可编辑，编辑器不提供静态旋转', 'scripts/rp_language.py:input_rotations + studio/export-rp.mjs:classifyNodeCompatibility');
    result.surfaces['full-rp1'] = fact('implemented', 'RP/1 节点属性 rotation（度）', 'scripts/rp_language.py STYLE_EXTRAS + references/rp-language.schema.json');
  }
  if (field === 'anchor') {
    // T-H-6：锚定在 Studio 内生效、导出时解算为绝对几何；fill 等无几何语义的值只存储。
    result.surfaces.native = fact('partial', '导出把锚定解算为绝对几何（不再保留约束语义）；fill 等无几何效果的值只存储，不产生原生差异', 'studio/export-rp.mjs:resolvedTreeToRp1Node');
  }

  // 2. Universal browser visual effects & CSS
  if (visualEffects.includes(field)) {
    matched = true;
    result.surfaces.canvas = fact('implemented', '浏览器画布直接渲染该视觉/变换效果', 'studio/visual-style.mjs:visualCss + studio/web/src/render.mjs:buildNodeElementHtml');
    result.surfaces.runtime = result.surfaces.canvas;
    result.surfaces.native = field === 'threeDTransform'
      ? fact('partial', '原生 .rp 没有 CSS transform，不产生原生可编辑变换（纯 2D 旋转请用 node.rotation，原生可编辑 DOA 3221225522）；导出兼容报告按 unsupported:css:transform 披露光栅化/省略降级', 'studio/export-rp.mjs:classifyNodeCompatibility + studio/visual-style.mjs:exportCssPlan（W7 2026-11-02 实测口径）')
      : fact('partial', '静态表面装饰层导出为独立 PNG；影响文字/子节点的 3D 变换或实时背景模糊在兼容报告中显式标记降级', 'studio/export-rp.mjs:classifyNodeCompatibility + studio/css-raster.mjs:rasterizeStudioPaint');
    result.surfaces['full-rp1'] = ['shadow', 'innerGlow', 'gradient', 'backdropBlur', 'aurora', 'noise'].includes(field)
      ? fact('implemented', 'RP/1 视觉样式属性', 'scripts/rp_language.py')
      : fact('unsupported', 'Studio 浏览器视觉扩展属性，完整 RP/1 编译器通过导出层光栅化或省略', 'studio/visual-style.mjs');
  }

  // 3. Universal semantic metadata & hit-area
  if (semanticMeta.includes(field)) {
    matched = true;
    if (field === 'interactive' || field === 'state') {
      result.surfaces.canvas = fact('implemented', '控制节点交互穿透或当前状态表现', 'studio/scene-resolver.mjs + studio/runtime.mjs');
      result.surfaces.runtime = result.surfaces.canvas;
    } else {
      result.surfaces.canvas = fact('metadata', '编辑器、语义查询或热区审查消费；不直接改变几何外观', 'studio/authoring-query.mjs:authoringNode + studio/commands.mjs');
      result.surfaces.runtime = result.surfaces.canvas;
    }
    result.surfaces.native = field === 'name'
      ? fact('implemented', '映射为原生元件名称', 'studio/export-rp.mjs:resolvedTreeToRp1Node')
      : fact('metadata', '保留在 Studio 权威源与兼容报告中', 'studio/export-rp.mjs');
    result.surfaces['full-rp1'] = ['name', 'state'].includes(field)
      ? fact('implemented', 'RP/1 节点名称与状态属性', 'scripts/rp_language.py')
      : fact('metadata', 'Studio 语义审查与源追踪元数据', 'studio/scene-resolver.mjs');
  }

  // 4. Typography fields
  if (textTypes.has(type)) {
    consumes([...text, 'align'], 'studio/scene-resolver.mjs:measureAndLayoutTree + studio/web/src/render.mjs:buildNodeElementHtml', '参与该文字节点的度量或绘制', true);
    if (field === 'fontSize' || field === 'size') {
      result.surfaces.canvas.reason = result.surfaces.runtime.reason = '数值或$名称引用已声明的标量数值令牌；共享令牌更新会重新度量，源引用保留';
    }
    if (field === 'fontFamily' || field === 'font') {
      result.surfaces.canvas.reason = result.surfaces.runtime.reason = '使用字体解析结果；catalog只声明候选，不证明文件已加载，缺失字体明确回退并报告';
    }
    if (type === 'input' && (field === 'fontFamily' || field === 'font')) {
      result.surfaces.native = fact('unsupported', '当前原生输入框不保留字体族', 'studio/export-rp.mjs:resolvedTreeToRp1Node');
    }
  } else if ((type === 'icon' || type === 'divider' || type === 'path' || type === 'sparkline') && field === 'color') {
    consumes(['color'], 'studio/scene-resolver.mjs:prepareTree + studio/web/src/render.mjs:buildNodeElementHtml', '设置图标、分割线或矢量路径颜色', true);
  }
  if (type === 'path' || type === 'sparkline') {
    consumes(
      ['points', 'content', 'smooth'],
      'studio/vector-paths.mjs:normalizeVectorNodeSpec + studio/web/src/render.mjs:buildNodeElementHtml',
      '控制可编辑矢量路径的子路径控制点、SVG path/markup 内容、填充规则与平滑切线手柄；导出为 RP9 Shape:300 ControlPoints 并逐节点记录降级边界',
      true
    );
  }

  // 5. Container layout fields
  if (containerTypes.has(type)) {
    consumes(layout, 'studio/scene-resolver.mjs:measureAndLayoutTree', '参与容器内容与布局；宏或组件自身规则优先', true);
  } else if (type === 'repeater' && (field === 'gap' || field === 'rowGap')) {
    consumes(['gap', 'rowGap'], 'studio/scene-resolver.mjs:measureAndLayoutTree', '控制列表行间距', true);
  }

  // 6. Type-specific fields
  if (type === 'divider' && field === 'direction') {
    consumes(['direction'], 'studio/scene-resolver.mjs:measure', '控制分割线为水平或垂直方向', true);
  }
  if (type === 'image') {
    consumes(['src'], 'studio/scene-resolver.mjs:collectResolved + studio/web/src/render.mjs:buildNodeElementHtml', '从工程素材引用绘制图片', true);
  }
  if (type === 'icon') {
    consumes(['icon'], 'studio/web/src/render.mjs:renderIconSvg', '按已知图标名绘制；原生是否可编辑由逐节点导出报告决定', true);
  }
  if (type === 'input') {
    consumes(['placeholder', 'value'], 'studio/runtime.mjs:setInput + studio/web/src/render.mjs:buildNodeElementHtml', '输入控件显示与运行态文本', true);
  }
  if (type === 'button' || type === 'badge') {
    consumes(['variant', 'tone'], 'studio/scene-resolver.mjs:prepareTree', '按语义变体设置按钮或徽标默认配色', true);
  }
  if (type === 'phone-shell') {
    consumes(phoneShellFields, 'studio/scene-resolver.mjs:expandMacroNode + studio/web/src/render.mjs:renderCanvasStage', '设置手机画板机型、灵动岛、状态栏与屏幕底色', true);
  }
  if (type === 'card') {
    consumes(cardMacroFields, 'studio/scene-resolver.mjs:expandMacroNode', '无显式children时展开宏内容及标题字号；有children时不自动生成子节点', true);
    if (node?.children?.length && cardMacroFields.includes(field)) {
      matched = true;
      result.sourceWrite = 'rejected';
      result.surfaces.canvas = fact('unsupported', '当前card已有显式children，不再生成这些宏内容字段', 'studio/scene-resolver.mjs:expandMacroNode');
      result.surfaces.runtime = result.surfaces.canvas;
      result.surfaces.native = result.surfaces.canvas;
      result.alternative = '查询并修改已有的真实子节点';
    }
    if (text.includes(field)) {
      matched = true;
      result.sourceWrite = 'rejected';
      result.surfaces.canvas = fact('unsupported', 'card容器不直接绘制文字，子节点文字样式不会继承此字段', 'studio/scene-resolver.mjs:expandMacroNode');
      result.surfaces.runtime = result.surfaces.canvas;
      result.surfaces.native = result.surfaces.canvas;
      result.surfaces['full-rp1'] = fact('unsupported', 'card 为容器宏，文字样式需声明在子节点或 titleFontSize 参数上', 'scripts/rp_language.py');
      result.alternative = field === 'fontSize' || field === 'size'
        ? '无显式children时使用titleFontSize修改标题字号；其他文字样式改真实子节点或组件覆盖'
        : '修改显式label/paragraph子节点或可覆盖组件；无children的宏内容可通过title/body等参数修改';
    }
  }
  if (type === 'list-item') {
    consumes(listItemMacroFields, 'studio/scene-resolver.mjs:expandMacroNode', '无显式children时展开列表条目内容、徽标与跳转', true);
  }
  if (type === 'stat-row') {
    consumes(statRowMacroFields, 'studio/scene-resolver.mjs:expandMacroNode', 'valueFontSize设置所有统计值字号；items内单项valueFontSize覆盖它', true);
  }
  if (type === 'repeater') {
    consumes(repeaterFields, 'studio/scene-resolver.mjs:collectResolved + studio/repeater-view.mjs:applyRepeaterView', '数据行、筛选、排序与分页大小参与当前列表视图', true);
    if (['filter', 'sort', 'pageSize', 'page', 'on'].includes(field)) {
      matched = true;
      if (field === 'on') {
        result.surfaces.canvas = fact('metadata', '保留列表事件声明', 'studio/document.mjs:nodeEvents');
        result.surfaces.runtime = fact('partial', '列表行点击通过运行态 dataset 交互处理', 'studio/runtime.mjs');
      }
      result.surfaces.native = fact('unsupported', `repeater.${field}当前不会等价转换为原生运行行为；导出报告明确保留此边界`, 'studio/export-rp.mjs:classifyNodeCompatibility');
    }
    if (field === 'template') {
      matched = true;
      result.surfaces.canvas = fact('partial', '按行绑定=item.field及${item.field}文字，使用模板布局和样式；行内独立动作与任意表达式尚未打通', 'studio/repeater-view.mjs:bindRepeaterTemplate + studio/scene-resolver.mjs:collectResolved');
      result.surfaces.runtime = result.surfaces.canvas;
      result.surfaces.native = fact('implemented', '行模板会转换为原生Repeater模板', 'studio/export-rp.mjs:resolvedTreeToRp1Node');
    }
    if (field === 'data') {
      matched = true;
      result.sourceWrite = 'rejected';
      result.surfaces.canvas = fact('unsupported', 'repeater使用rows或已绑定dataset，不消费data', 'studio/scene-resolver.mjs:collectResolved');
      result.surfaces.runtime = result.surfaces.canvas;
      result.surfaces.native = result.surfaces.canvas;
      result.alternative = '使用datasetOp修改真实行，或设置rows/dataset';
    }
  }
  if (['instance', 'use'].includes(type)) {
    consumes([...instanceFields, 'text'], 'studio/scene-resolver.mjs:expandComponentInstance', '根据组件契约解析props、状态和覆盖；实际子节点通过instance-override改稿', true);
  }
  if (type === 'dynamic-panel') {
    consumes(['states', 'activeState'], 'studio/scene-resolver.mjs:collectResolved + studio/runtime.mjs', '解析当前面板状态及受支持的切态动作', true);
  }

  // 7. Click interactions (on, onClick, goto)
  if ((field === 'on' || field === 'onClick') && type !== 'repeater') {
    matched = true;
    result.surfaces.canvas = fact('metadata', '设计态保留交互定义；使用运行预览执行', 'studio/document.mjs:nodeEvents');
    result.surfaces.runtime = fact('partial', '只执行已支持的click动作；不能由字段存在推导任意事件', 'studio/runtime.mjs:click');
    result.surfaces.native = fact('partial', '按已支持click动作转换，其余逐项兼容报告', 'studio/export-rp.mjs');
  } else if (field === 'goto' && gotoCapableTypes.has(type) && !matched) {
    matched = true;
    result.surfaces.canvas = fact('implemented', '正规化为 on.click 页面跳转交互', 'studio/document.mjs:nodeEvents');
    result.surfaces.runtime = fact('implemented', '点击切换到目标页面', 'studio/runtime.mjs:click');
    result.surfaces.native = fact('implemented', '导出为原生页面跳转链接', 'studio/export-rp.mjs:normalizeExportOn');
  }

  // 8. Anything not matched on this type is explicitly unsupported on Studio canvas and rejected on write
  if (!matched) {
    result.sourceWrite = 'rejected';
    let reason = `${type || '当前'} 节点在 Studio 画布中不消费属性 ${field}`;
    let alternative = '请使用 studio_describe(topic:"node", name:type) 查看该节点支持的可写属性';
    if (text.includes(field)) {
      reason = `${type} 节点不直接绘制文本，不消费排版属性 ${field}`;
      alternative = '请修改子节点中的 label/paragraph/button/badge/input，或使用对应宏参数（如 titleFontSize / valueFontSize）';
    } else if (layout.includes(field) || field === 'direction') {
      reason = `${type} 节点不是通用布局容器，不消费布局属性 ${field}`;
      alternative = '请在父级 box/card 容器上调整 layout/padding/gap';
    } else if (nonClickEventFields.has(field)) {
      reason = `Studio 画布与运行态当前仅支持 click 交互（on.click / onClick / goto），不消费 ${field}`;
      alternative = '使用 on.click 声明受支持的点击交互，或通过完整 RP/1 generate_prototype 入口编译原生高级事件';
    } else if (field === 'adaptive' || field === 'native' || field === 'points' || field === 'smooth') {
      reason = `${field} 为完整 RP/1 编译期专用属性，Studio 画布节点不直接消费`;
      alternative = '完整 RP/1 自适应视图或原生曲线属性请通过 generate_prototype 编译';
    } else {
      reason = `${field} 属于其他特定节点或完整 RP/1 宏参数，对 ${type} 节点无效`;
      alternative = rawMacros.has(type)
        ? '此原始宏类型在 Studio 中不自动展开宏参数；请使用显式 children 构图、核心组件实例或 generate_prototype 原生入口'
        : '请检查目标节点类型是否正确，或通过 studio_query_nodes 查询真实可编辑源目标';
    }
    const unsupportedFact = fact('unsupported', reason, 'studio/node-capabilities.mjs');
    result.surfaces.canvas = unsupportedFact;
    result.surfaces.runtime = unsupportedFact;
    result.surfaces.native = unsupportedFact;
    result.alternative = alternative;
  }

  if (rawMacros.has(type)) {
    result.typeBoundary = '此原始类型尚无Studio宏展开；显式children与自身几何仍可绘制。nav-bar请优先使用同名核心组件实例；完整RP/1另走原生入口。';
  }
  return result;
}

export function nodePropertyCapability(type, field, options = {}) {
  const result = buildNodePropertyCapability(type, field, options);
  const accepted = RP1_SOURCE_PROPERTIES_BY_TYPE.get(type)?.has(field) === true;
  result.surfaces['full-rp1'] = accepted
    ? fact('implemented', '完整 RP/1 此类型源契约接受该字段；值、引用、事件和出口限制仍须编译校验，不代表画布或原生宿主已逐项实测', 'references/rp-language.schema.json:x-source-properties-by-type')
    : fact('unsupported', `完整 RP/1 的 ${type} 源契约不接受字段 ${field}；不能从全局词表推断节点支持`, 'references/rp-language.schema.json:x-source-properties-by-type');
  result.surfaces['full-rp1'].verification = 'source-contract';
  if (RP1_SOURCE_PROPERTY_CONDITIONS[type]?.[field]) {
    result.surfaces['full-rp1'] = fact('partial', RP1_SOURCE_PROPERTY_CONDITIONS[type][field], 'references/rp-language.schema.json:x-source-property-conditions');
  }
  return result;
}

export function nodeCapabilitySummary(type, { node = null, target = null, sourceType = null } = {}) {
  const fields = [
    ...geometry.slice(0, 5),
    'opacity',
    ...(textTypes.has(type) ? ['text', 'fontSize', 'fontFamily', 'color'] : []),
    ...(['box', 'card', 'phone-shell'].includes(type) ? ['layout', 'padding', 'gap'] : []),
    ...(type === 'card' ? ['title', 'body', 'titleFontSize'] : []),
    ...(type === 'list-item' ? ['title', 'subtitle', 'rightBadge'] : []),
    ...(type === 'stat-row' ? ['items', 'valueFontSize'] : []),
    ...(type === 'repeater' ? ['rows', 'filter', 'sort', 'template'] : []),
    ...(type === 'divider' ? ['direction', 'color'] : []),
    ...(['path', 'sparkline'].includes(type) ? ['points', 'content', 'smooth', 'fill', 'stroke', 'strokeWidth'] : []),
  ];
  const macroFields = [...new Set([target?.property, ...Object.values(target?.propertyMap || {})])].filter(Boolean);
  const commonFields = target?.editable === false
    ? []
    : target?.kind === 'macro-parameter'
      ? macroFields
      : fields.filter(field => nodePropertyCapability(type, field, { node }).surfaces.canvas.status !== 'unsupported');
  return {
    type,
    ...(target ? { editable: target.editable } : {}),
    commonFields,
    ...(rawMacros.has(type) ? { boundary: '尚未实现此原始类型的Studio宏展开；不要把同名完整RP/1宏当作已支持的画布构件' } : {}),
    ...(target?.kind === 'macro-parameter'
      ? {
          editableFields: macroFields,
          propertyMap: target.propertyMap,
          boundary: '展开节点按propertyMap回写所属宏的明确参数；没有映射的样式不可直接写入内容参数',
        }
      : {}),
    inspect: {
      tool: 'studio_describe',
      arguments: {
        topic: 'node',
        name: target?.kind === 'macro-parameter' ? sourceType || type : type,
        ...(commonFields.length ? { fields: commonFields.slice(0, 3) } : {}),
      },
      note: '可替换fields查询消费面；完整RP/1支持范围按节点类型源契约派生，状态声明不代替运行或宿主验证',
    },
  };
}

export function assertKnownNodeEffects(node, properties, { commandIndex = 0, nodeId = node.id } = {}) {
  for (const field of Object.keys(properties)) {
    const capability = nodePropertyCapability(node.type, field, { node: { ...node, ...properties } });
    // Reject any property write known to be ineffective / unsupported on this node type.
    if (capability.sourceWrite === 'rejected') {
      throw Object.assign(new Error(`${node.type}.${field}没有作用于预期内容，未保存无效改稿`), {
        code: 'E_NODE_PROPERTY_EFFECT',
        commandIndex,
        nodeId,
        field,
        suggestion: capability.alternative,
        capability,
      });
    }
  }
}

export function assertCanvasNodeType(node, { commandIndex = 0 } = {}) {
  if (rawMacros.has(node.type) && !node.component && !node.children?.length) {
    throw Object.assign(new Error(`${node.type}尚无Studio宏展开，不能作为空白构件创建`), {
      code: 'E_STUDIO_MACRO_UNEXPANDED',
      commandIndex,
      nodeId: node.id,
      field: 'type',
      suggestion: node.type === 'nav-bar'
        ? '使用createInstance(componentId:"nav-bar",props:{title:"..."})，或完整RP/1原生入口'
        : '使用显式box/row/column/label等构图，或完整generate_prototype原生入口；已有源字段不会被删除。',
    });
  }
}
