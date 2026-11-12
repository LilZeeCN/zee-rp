import { COMMAND_TYPES_BY_GROUP, VALID_NODE_TYPES } from './commands.mjs';
import { NODE_PROPERTY_NAMES, NODE_READONLY_PROPERTIES, NODE_UNCONSUMED_PROPERTIES,NODE_SYNTAX_ONLY_PROPERTIES } from './node-properties.mjs';
import { COMMAND_CONTRACTS } from './command-contracts.mjs';
import { getDesignGuidance } from './design-guidance.mjs';
import { getDesignCraft } from './design-craft.mjs';
import {nodePropertyCapability,nodeCapabilitySummary,NODE_CAPABILITY_SURFACES,STUDIO_SOURCE_ONLY_MACROS} from './node-capabilities.mjs';

export const AUTHORING_ENTRY = {
  discover: 'studio_describe(topic:workflow|rp1|command|node|design|craft)；新起稿用studio_stage(stage:planning)',
  create: 'studio_command：rp1/sourceMode 或 commands 二选一；同一版本事务、撤销与持久化',
  inspect: 'studio_inspect：语义筛选、可编辑目标、父布局与源坐标；默认8项，可用cursor续取',
  verify: 'studio_design(action:review) → studio_scenario（默认语义层，返回coverage覆盖率与交互lint；hitTest:true 加真实指针遮挡校验，被遮挡返回E_SCENARIO_OCCLUDED） → studio_export(format:rp) → studio_merge(kind:sync_native) → studio_export(format:code) → studio_export(format:bundle) / studio_merge(kind:merge)；视觉、行为、原生往返、可运行代码出口、工程包与并发合并分别验证',
};
const sample = 'column #lesson w=350 h=hug gap=24\n  label #word "serendipity" fontFamily=Georgia fontSize=44\n  paragraph #answer [fillxhug] "意外发现美好事物的能力。" visible=false fontSize=16 lineHeight=25\n  button #reveal [fillx48] "揭示答案"\n    +onClick [{"type":"show","target":"answer"}]';
const INTERACTION_GUIDE = {
  conditions: 'when/if/condition 统一为 when 布尔表达式；可写 =$index === 1 或 $index === 1，缺少 = 会补齐。未知变量、错误语法和类型不符在写入前拒绝，整笔事务保持原样。兜底分支用 else:true。',
  ordering: 'cases 按顺序判断，默认首次命中后停止；分支动作按顺序执行。先改文字与显隐，再推进状态变量，最后跳页，避免后续条件读取到已推进的值。',
  expressions: '浏览器与原生共用 RP/1 函数 text/number/concat/contains/length/lower/upper/not/remove；引号内的 $变量 和 @控件保持字面文字。set-text 数值结果会自动转成文字。',
  native: '跨页 set-text 对普通 label/paragraph/button/badge 由导出器自动保存原生状态并在目标页恢复；动态绑定、富文本、输入和行模板不使用此自动桥接。输入框 rotation 由原生 OnLoad 绝对旋转动作恢复，保留可编辑输入；RP9 编辑器不提供 TextBox 静态旋转。',
  debugging: 'studio_scenario 的 stepResults[].executed 返回每个 condition 的 expression/value/matched 和实际动作，同时返回 coverage（分支/面板状态/页面覆盖率）与 warnings（如 W_SHOW_MASKED_BY_HIDDEN_ANCESTOR 祖先隐藏遮蔽）；失败时先核对未命中的条件及变量，再改分支，不用猜。',
  example: {
    commands: [
      { type: 'set-variable', name: 'index', value: 1 },
      { type: 'addNode', pageId: 'home', node: { type: 'label', id: 'word', text: 'abandon', fontSize: 44, fontFamily: 'Georgia', x: 24, y: 120, w: 330, h: 64 } },
      { type: 'addNode', pageId: 'home', node: { type: 'button', id: 'next', text: '记住了', x: 24, y: 240, w: 330, h: 48, on: { click: { cases: [
        { when: '=$index === 1', actions: [{ type: 'set-text', target: 'word', text: 'meticulous' }, { type: 'set-var', name: 'index', value: 2 }] },
        { when: '=$index === 2', actions: [{ type: 'set-text', target: 'word', text: 'serendipity' }, { type: 'set-var', name: 'index', value: 3 }] },
        { else: true, actions: [{ type: 'navigate', page: 'done' }] },
      ] } } } },
      { type: 'addPage', pageId: 'done', name: '本轮完成' },
      { type: 'addNode', pageId: 'done', node: { type: 'button', id: 'restart', text: '重新开始', x: 24, y: 200, w: 330, h: 48, on: { click: [
        { type: 'set-var', name: 'index', value: 1 }, { type: 'set-text', target: 'home/word', text: 'abandon' }, { type: 'navigate', page: 'home' },
      ] } } },
    ],
    scenario: [
      { action: 'click', target: 'next', expect: { text: { word: 'meticulous' }, variables: { index: 2 } } },
      { action: 'click', target: 'next', expect: { text: { word: 'serendipity' }, variables: { index: 3 } } },
      { action: 'click', target: 'next', expect: { page: 'done' } },
      { action: 'click', target: 'restart', expect: { page: 'home', text: { word: 'abandon' }, variables: { index: 1 } } },
    ],
  },
};
const fail = (code, message, candidates) => { throw Object.assign(new Error(message), { code, candidates }); };

export function describeAuthoring({ topic = 'workflow', name = null, names = null, intent = 'learning', platform = 'mobile', guideId = null,fields=null,operation='edit',surface=null } = {}) {
  if((fields!==null||surface!==null||operation!=='edit')&&topic!=='node')fail('E_NODE_CAPABILITY_QUERY','fields/operation/surface只用于topic:node');
  if (topic === 'workflow') return { ok: true, entry: AUTHORING_ENTRY,
    interactionGuide: structuredClone(INTERACTION_GUIDE),
    sequence: ['studio_open_project获取工程ID和版本', 'studio_stage(stage:planning,target:{pageId})一次取得任务参考、当前目标与精确写入入口', 'studio_describe(topic:rp1)简洁创作或studio_describe(topic:command)精确改稿', 'studio_inspect确认源目标与布局', 'studio_command提交', 'studio_design(action:review)看真实图片并检查nativeReadiness与interactionDiagnostics', 'studio_design(action:explore)比较多构图与交互态', 'studio_scenario语义断言（返回coverage与warnings；hitTest:true 会先用真实浏览器指针重放校验点击目标，被遮挡返回E_SCENARIO_OCCLUDED且语义不执行该步；多状态遮挡/命中结论仍可用explore.states真实浏览器指针核验）', 'studio_export(format:rp)检查原生与降级报告'],
    rules: ['RP/1的column/row和hug/fill承担内容布局，避免逐节点算高。', '保留稳定ID；局部update只改显式字段，不从省略推断删除。', 'AI审美判断必须看对应版本的图；指标通过不等于用户认可。', '写入回包丢失先查版本与内容，不盲目重复撤销或创建。'],
    examples: { inspect: { pageId: 'home', role: 'primary-action', fields: ['target', 'layoutContext'] }, edit: { baseRevision: 1, idempotencyKey: 'make-lesson', pageId: 'home', sourceMode: 'insert', rp1: sample } } };
  if (topic === 'rp1') return { ok: true, format: 'studio-rp1-subset',
    interactionGuide: structuredClone(INTERACTION_GUIDE),
    parameters: { rp1: '节点片段文本；支持可选 vars:/tokens: 头部与显式根容器，普通节点写#稳定ID（纯装饰divider/spacer可省略ID）', sourceMode: 'insert新建子树 / update仅修改显式字段（支持dynamic-panel :state与repeater :template增量合并）', pageId: '必须是当前页面ID', parentId: 'insert目标容器（支持 "panelId:stateId" 直接写入指定面板状态）/ update允许区域，可省略', baseRevision: '当前版本', idempotencyKey: '此笔修改的唯一身份' },
    example: { pageId: 'home', parentId: 'home_screen', sourceMode: 'insert', baseRevision: 1, idempotencyKey: 'lesson-v1', rp1: sample },
    updateExample: { pageId: 'home', parentId: 'lesson', sourceMode: 'update', baseRevision: 2, idempotencyKey: 'word-copy-v2', rp1: 'label #word "a beautiful coincidence" fontSize=32' },
    supported: ['column/row/stack/grid、hug/fill与内容测量；panel/dynamic-panel支持:state及tabs=[...]自动分段头，repeater支持:template与data=绑定', '一等原生表单控件（checkbox、radio、combobox/select、listbox、textarea/input multiline）及完整宏展开（card、stat-row、list-item、progress-bar、nav-bar、tab-bar）', 'click动作词表：show、hide、toggle、set-text、set-var(别名set-variable)、set-check、set-selected、set-option、set-panel-state、link(别名goto，跳页)、navigate、dataset-*/repeater-*（增删改选与筛选排序），支持+onClick goto=...等简写', '行列号/源码片段诊断、ID与依赖检查、同一原子命令事务'],
    boundaries: ['局部入口支持可选内联 vars:/tokens: 头部声明标量变量与颜色/数值令牌；复杂datasets/components/product声明请用命令或完整generate_prototype工作流。', '不替换整页，不把省略内容、事件或节点当成删除。', '非click事件与无法表示的完整RP/1语义明确拒绝；不等同于整个原生编译器。', 'open-link（打开外部URL）不受Studio运行态支持：提交被拒且不写入（E_INTERACTION_ACTION），外链交互走完整原生RP/1流程。', 'x/y相对父内容盒，手机home_screen默认已有顶部padding；先查询再定位。addPage默认生成裸box根（layout=stack、padding=0），也可传 shell:"phone-shell"（自动带顶部安全区与_screen容器）或 shell:"web-page"（自动column流式布局）。'],
    next: ['studio_inspect读取source与layoutContext', 'studio_describe(topic:command,name:editNodes)', 'studio_inspect(view:contracts)获取组件参数'] };
  if (topic === 'command') {
    if (names) {
      if (name || !Array.isArray(names) || !names.length || names.length > 8) fail('E_COMMAND_HELP', 'names 需为1–8个命令名，不能与name混用', Object.keys(COMMAND_CONTRACTS));
      return { ok: true, contracts: names.map(item => describeAuthoring({ topic, name: item })), next: '使用同一份字段定义校验，按所需命令批量发现。' };
    }
    if (!name) return { ok: true, groups: COMMAND_TYPES_BY_GROUP, detailedContracts: Object.keys(COMMAND_CONTRACTS), next: '传name按需读取一个精确契约，避免加载全部命令' };
    if (!COMMAND_CONTRACTS[name]) fail('E_COMMAND_HELP', `暂未提供 ${name} 的详细参数契约；常用契约见 candidates，完整命令范围见不带name的查询`, Object.keys(COMMAND_CONTRACTS));
    const boundary = name === 'booleanPathOp'
      ? '布尔运算内部先把输入贝塞尔按每段16个采样点展平求交，装配后把结果中落在同一源贝塞尔上的连续折线段还原为原生 C 段（de Casteljau 子区间控制点，形状与源曲线一致）：产物圆弧输出为 C 段而非折线，直线段保持 L；求交点位置按展平弦近似（弦距≈采样误差）。'
      : null;
    return { ok: true, name, schema: COMMAND_CONTRACTS[name], ...(boundary ? { boundary } : {}), note: '参数字段与实际命令校验共用定义；properties字段同样受Studio属性词表和值校验约束。' };
  }
  if (topic === 'node') {
    if (name && !VALID_NODE_TYPES.has(name)) fail('E_NODE_TYPE', `不支持节点 ${name}`, [...VALID_NODE_TYPES]);
    if(!['create','edit'].includes(operation))fail('E_NODE_CAPABILITY_QUERY','operation应为create或edit');
    if(surface!==null&&!NODE_CAPABILITY_SURFACES.includes(surface))fail('E_NODE_CAPABILITY_QUERY','surface应为canvas/runtime/native/full-rp1');
    if(fields!==null&&(!name||!Array.isArray(fields)||!fields.length||fields.length>16||fields.some(field=>typeof field!=='string'||!field)))fail('E_NODE_CAPABILITY_QUERY','指定fields需要name及1–16个属性名');
    const summary=name?nodeCapabilitySummary(name):null,selected=fields?[...new Set(fields)]:summary?.commonFields||[];
    const capabilities=selected.map(field=>nodePropertyCapability(name,field,{operation})).map(item=>surface?{field:item.field,sourceWrite:item.sourceWrite,[surface]:item.surfaces[surface],...(item.alternative?{alternative:item.alternative}:{})}:item);
    return { ok: true, type: name, operation,...(surface?{surface}:{}),...(summary?{summary}:{}),types: name?undefined:[...VALID_NODE_TYPES],...(!name?{typeAvailability:{renderable:[...VALID_NODE_TYPES].filter(type=>!STUDIO_SOURCE_ONLY_MACROS.has(type)),explicitChildrenOnly:[...STUDIO_SOURCE_ONLY_MACROS],alternative:'nav-bar使用已有核心组件实例；完整RP/1宏另走generate_prototype'}}:{}),capabilities,writableFields:capabilities.filter(item=>item.sourceWrite==='allowed').map(item=>item.field),readOnlyFields:[...NODE_READONLY_PROPERTIES],
      vocabulary:{total:NODE_PROPERTY_NAMES.size,readOnly:NODE_READONLY_PROPERTIES.size,unconsumed:NODE_UNCONSUMED_PROPERTIES.size,syntaxOnly:NODE_SYNTAX_ONLY_PROPERTIES.size,supportContractComplete:true,completeAudit:false},
      values: { w: '正数 / fill / hug', h: '正数 / fill / hug', fontSize: '(0,120]或$名称引用doc.tokens中已声明的标量数值；gap/padding支持非负数值令牌', opacity: '[0,1]', radius: '非负数', color: '#RRGGBB / #RRGGBBAA / rgba / $颜色令牌', rotate: 'rotate 是 rotation 的别名提示：请用 rotation（数值角度，度）——画布/运行态渲染 rotate(Ndeg)，原生 .rp 写为可编辑的 MyStyle DOA 3221225522（W1 2026-11-02）；复合 3D 变换才用 threeDTransform', anchor: 'stack/free 布局锚定，仅 center / top-right / bottom-left / bottom-right 生效；其他值（如 fill）只存储不消费、无几何效果', threeDTransform: '浏览器渲染层 CSS transform 字符串（如 rotate(15deg)）；只影响渲染，不改变布局几何 x/y/w/h' },
      note: '默认给常用字段；name+fields查询节点与消费面。完整RP/1契约按类型派生；supportContractComplete表示分类齐全，completeAudit:false表示尚未逐格实测所有消费/宿主组合，不能把状态计数当验收。展开节点按studio_inspect返回的target改源宏或实例覆盖。' };
  }
  if (topic === 'design') return { ok: true, guidance: getDesignGuidance({ intent, platform, guideId }) };
  if (topic === 'craft') return {ok:true,craft:getDesignCraft({platform}),note:'未打开工程的通用指导；当前有效方向与版本请从studio_stage读取。'};
  fail('E_AUTHORING_TOPIC', 'topic 应为 workflow、rp1、command、node、design 或 craft', ['workflow', 'rp1', 'command', 'node', 'design', 'craft']);
}
