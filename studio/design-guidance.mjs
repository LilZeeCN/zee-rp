// Authored design knowledge, not generated layouts or accepted visual evidence.
const guides = [
  {
    id: 'recall-focus', name: '单次回忆', intents: ['learning'], platforms: ['mobile'],
    bestFor: '单词、概念、听辨与短题练习；用户每次只需做一个判断。',
    composition: {
      protagonist: '本次要回忆的内容与回答动作',
      readingOrder: ['小型任务与进度提示', '有充足呼吸空间的问题', '回答或揭示', '结果、解释与下一步'],
      direction: '围绕一个内容中心分配留白，答案在揭示后接续阅读；进度和连续天数不抢问题的注意力。',
    },
    typography: { display: '英文词或短概念可用 Georgia 40–56/400；长问题改用 Inter 28–36/600。', heading: 'Inter 或 PingFang SC 20–24/600。', body: 'Inter 或 PingFang SC 15–17，行高1.5–1.65；发音与词性13–14。' },
    palette: { canvas: '#F4F5FA', surface: '#FFFFFF', ink: '#20243A', muted: '#636A83', brand: '#3D4AC8', accent: '#E3C35E', success: '#236B52', error: '#A72F40' },
    spacing: { scale: [4, 8, 12, 20, 28, 40, 56], density: '问题周围疏，解释区适中；触控操作至少44px，内容决定文本高度。' },
    materials: '可用音频波形、词义小插图或一条细分隔作为学习线索；纯色适合集中注意。无教学作用的封面照片可省略。',
    states: ['回忆：不提前泄露答案或释义。', '揭示：解释与原问题相邻，答案长时允许自然延展。', '记住/再练：结果用文案和形状区分，下一步保持可达。'],
    avoid: ['用积分、排行或大插图挤走本次问题。', '把“揭示答案”与“下一题”做成同一含义的动作。', '只验短词，忽略长词、长例句与答案展开。'],
    explore: [
      { name: '字形聚焦', structure: '单个大问题，解释在下方渐进出现。', visual: '衬线词头、窄辅助字、低装饰密度。' },
      { name: '问答对页', structure: '把问题与解释组织为先后可读的两段，结果接在解释末尾。', visual: '两种表面与清晰边界、无衬线字阶。' },
      { name: '练习轨迹', structure: '以本轮步骤线串起题目、回答和反馈，问题与轨迹侧向呼应。', visual: '小号序号、较紧的标题、强调当前步骤。' },
    ],
    rp1: '问题、解释、操作分别保留稳定ID；用column/hug承载长解释，动态面板或显隐表达回忆/揭示/反馈，重复题目用组件或数据而非复制业务规则。',
  },
  {
    id: 'learning-route', name: '学习路径与工作台', intents: ['learning'], platforms: ['mobile', 'web'],
    bestFor: '课程、知识地图、阅读练习与章节复习；用户需要理解当前位置并继续。',
    composition: {
      protagonist: '当前学习内容及其下一次可完成的练习',
      readingOrder: ['当前位置与剩余任务', '当前内容或练习', '可操作的反馈', '相邻章节与复习入口'],
      direction: 'mobile以纵向路径连接内容与练习；web可用窄主题轨道加宽工作区。完成项收缩为回顾线索，不把所有内容等权展开。',
    },
    typography: { display: 'Inter 或 PingFang SC 28–36/600，标题长度决定换行。', heading: '章节20–24/600，正文中的小标题16–18/600。', body: '阅读正文16–18，行高1.65–1.8；宽屏控制每行约28–40个中文字。' },
    palette: { canvas: '#F7F4EB', surface: '#FFFEFA', ink: '#292E29', muted: '#676F63', brand: '#376857', accent: '#BC6939', success: '#376857', error: '#A43832' },
    spacing: { scale: [4, 8, 12, 16, 24, 32, 48], density: '阅读段落较疏，路径标记紧凑；屏幕窄时保留内容顺序和一项主要动作。' },
    materials: '把图解、批注或题目插图放在解释对应处；细线、页码和小色块可区分学习层次。材料应帮助理解，不遮挡正文。',
    states: ['未开始/进行中/已完成都有文字含义。', '答错后保留题目、选择与可解释的反馈。', '空课程、长章节、返回后进度和窄屏都要检查。'],
    avoid: ['把完整知识图谱塞进手机首屏。', '为了凑齐卡片数量编造章节。', '只靠颜色说明学习状态，或自动跳走未读完的反馈。'],
    explore: [
      { name: '连续阅读', structure: '内容与练习在同一阅读流里，导航退到次层。', visual: '宽松行距、段落节奏、书页式分隔。' },
      { name: '双区研习', structure: '材料与练习相邻；手机按材料、问题的顺序折叠。', visual: '两种阅读密度，主次明确的工作面。' },
      { name: '里程碑路径', structure: '以当前里程碑展开内容，其余节点只给名称和状态。', visual: '序号与路线标记、强调当前位置。' },
    ],
    rp1: '用组件复用章节项、用变量记录进度；row/column与hug/fill组织阅读区，状态和数据保持同一来源。原生导出后另验返回与进度刷新。',
  },
  {
    id: 'task-instrument', name: '掌上操作台', intents: ['task'], platforms: ['mobile'],
    bestFor: '检索、设备控制、待办执行和轻量业务操作；用户有明确目的，需要快速判断与行动。',
    composition: {
      protagonist: '当前对象的关键状态与一项主要操作',
      readingOrder: ['对象、场所或检索入口', '决定下一步所需的信息', '主要动作', '日志、次级操作与说明'],
      direction: '给操作区稳定位置，让变化的信息在其上方展开；短列表可直接成行，详情较多时分成可扫描的段落。',
    },
    typography: { display: '关键数字或状态可用 Inter 32–44/600，单位保持14–16。', heading: 'PingFang SC 或 Inter 20–24/600。', body: '正文14–16；读数使用等宽数字，辅助说明13–14且保持足够对比。' },
    palette: { canvas: '#EDF2F5', surface: '#FFFFFF', ink: '#172F3C', muted: '#586E7B', brand: '#006A83', accent: '#D17C36', success: '#286B4F', error: '#AC3841' },
    spacing: { scale: [4, 8, 12, 16, 24, 32], density: '信息可以紧凑，触控区留足44px；优先成行对齐，危险操作与主操作留开。' },
    materials: '图标用于动作与对象识别，状态读数可配刻度或微型图；照片只在辨识物品或场所时使用。',
    states: ['加载/空结果/有结果要保留检索与恢复路径。', '执行中保留对象与任务，避免重复提交。', '成功/失败给出具体结果及下一步；危险操作单独处理。'],
    avoid: ['把每条信息都包成同权重卡片。', '把高频操作藏进装饰性大封面。', '无真实数据仍显示确定的“在线”“成功”或统计数字。'],
    explore: [
      { name: '状态仪表', structure: '一个主要读数与操作，明细在次层。', visual: '强数字层级、少量刻度、克制色彩。' },
      { name: '检索优先', structure: '检索和结果列表占主区，操作随选中对象出现。', visual: '紧凑行、显著选择态、清晰分组。' },
      { name: '任务清单', structure: '按执行顺序组织步骤，详情按需展开。', visual: '序号、对齐线和明确的完成反馈。' },
    ],
    rp1: '列表优先用repeater与数据查询，状态和动作通过变量/事件统一表达；共用按钮与信息行用组件，避免每次状态变化重画整页。',
  },
  {
    id: 'record-form', name: '记录与表单', intents: ['task'], platforms: ['mobile', 'web'],
    bestFor: '预约、登记、申请、编辑记录；用户要准确完成一份有规则的数据。',
    composition: {
      protagonist: '当前填写区域及提交前的关键确认',
      readingOrder: ['表单目的和当前进度', '按业务含义分组的字段', '必要解释或错误', '提交摘要及动作'],
      direction: '按理解顺序组织字段，少量内容用一页文档，复杂流程分步；web可并列摘要，mobile将摘要接在字段之后。',
    },
    typography: { display: '页面目的24–32/600，避免长口号。', heading: '分组18–20/600，字段标签14–16/500。', body: '输入值16；帮助与错误13–14，内容变化不挤走相关字段。' },
    palette: { canvas: '#F6F3EE', surface: '#FFFFFF', ink: '#34302D', muted: '#70665E', brand: '#8C482D', accent: '#347B82', success: '#2D7257', error: '#B22E3E' },
    spacing: { scale: [4, 8, 12, 16, 24, 32, 40], density: '标签与字段紧密关联，字段组之间拉开；错误文本按内容撑高，提交区留稳定空间。' },
    materials: '细分隔、轻底色或步骤编号帮助分组；需要上传材料时显示真实文件状态和可读预览。',
    states: ['初始/填写中/错误/提交中/完成分别说明。', '错误放在字段附近，保留已填内容并能定位首个问题。', '返回修改、空可选项、长标签和键盘占位都要验。'],
    avoid: ['仅用占位文字代替字段标签。', '提交失败后清空用户输入。', '把必填规则只写在帮助文案里，实际动作不执行。'],
    explore: [
      { name: '一页记录', structure: '连续分组，末尾确认提交。', visual: '文档式留白、细分隔、安静表面。' },
      { name: '逐步完成', structure: '每步只处理一组决策，并可返回。', visual: '明确步骤状态、强组标题。' },
      { name: '填写与核对', structure: '字段与摘要形成主辅两区，手机顺序排列。', visual: '密度差异、摘要强调关键值。' },
    ],
    rp1: '把校验规则放在变量/条件事件或product规则中复用；动态面板表达步骤，组件复用字段；使用同一规则生成错误反馈和提交条件。',
  },
  {
    id: 'data-workspace', name: '数据工作区', intents: ['task'], platforms: ['web'],
    bestFor: '运营看板、业务列表和管理工作台；用户要定位异常、筛选对象并处理。',
    composition: {
      protagonist: '一个核心问题的趋势、异常或可处理记录',
      readingOrder: ['当前范围与筛选', '核心趋势或异常', '可操作的明细', '次级指标和来源说明'],
      direction: '导航稳定，主工作区由一张关键图或表领衔；指标是解释上下文，别先铺满同样大小的数字卡。',
    },
    typography: { display: '主指标Inter 32–40/600，数值使用等宽数字。', heading: '模块18–22/600，表头13–14/600。', body: '表格14–15、说明13–14；行密度随扫读任务调整，避免用小字制造容量。' },
    palette: { canvas: '#F0F3F7', surface: '#FFFFFF', ink: '#1C2B42', muted: '#5B6B82', brand: '#2457BD', accent: '#AF6734', success: '#267259', error: '#B23848' },
    spacing: { scale: [4, 8, 12, 16, 24, 32, 48], density: '表内紧凑、模块间适中；先解决字段重要性，再决定列宽与隐藏策略。' },
    materials: '图表和表格使用同一份真实数据；图例、单位、时间范围与数据来源应可读。用色承担分类或异常含义。',
    states: ['筛选前后保留条件与计数含义。', '加载/空数据/错误给出原因与恢复路径。', '选择记录后详情与操作一致，分页、排序与0/1/N条记录分别验。'],
    avoid: ['无数据定义却绘制看似真实的趋势。', '把相同颜色用于互斥的业务含义。', '为了首屏整齐裁掉表格中重要字段或操作。'],
    explore: [
      { name: '趋势领衔', structure: '主趋势占据工作区上部，明细解释变化。', visual: '大图、小型上下文指标、轻网格。' },
      { name: '明细优先', structure: '表格为主，选中行展开详情。', visual: '高效行节奏、清晰选择态、少卡片。' },
      { name: '异常分诊', structure: '按需要处理的异常组织队列和详情。', visual: '状态标记、严重度层级、聚焦动作。' },
    ],
    rp1: '数据集、查询与业务操作共享来源；repeater表达明细，master-detail或动态面板表达当前选择；先验排序筛选，再看图调整密度。',
  },
  {
    id: 'field-story', name: '图文叙事', intents: ['editorial'], platforms: ['mobile', 'web'],
    bestFor: '自然观察、文化内容、人物或产品故事；用户需要理解主题并继续阅读。',
    composition: {
      protagonist: '一幅有内容作用的图像，或一段值得阅读的文字',
      readingOrder: ['明确的主题线索', '图像与文字共同建立的重点', '连续阅读与细节', '收藏、继续阅读或相关内容'],
      direction: '让图像焦点、文字留白和阅读顺序一起工作；图像型与文字型主导均可，mobile强调连续阅读，web可利用不对称主辅关系。',
    },
    typography: { display: '中文Songti SC或英文Georgia 32–48；短标题可用有力量的无衬线。', heading: 'PingFang SC或Inter 20–24/600，保持章节节奏。', body: '正文16–18、行高1.65–1.8；图注12–14，宽屏限制阅读行长。' },
    palette: { canvas: '#F4EFE5', surface: '#FFFCF5', ink: '#302C26', muted: '#71665A', brand: '#6B4D35', accent: '#366B78', success: '#3A6B50', error: '#A83B38' },
    spacing: { scale: [4, 8, 12, 20, 28, 40, 56], density: '章节转换留足空白，图注与图像相邻；文字型页面可提高正文密度。' },
    materials: '素材保留原图、来源、焦点与裁切配方。先找主体周围的可用留白，再决定叠字；照片、插画或纯文字均可成为主角。',
    states: ['收藏/取消收藏给明确反馈。', '无图时重排文字，缺图不留假封面。', '长标题、长正文、详情返回与空收藏分别验。'],
    avoid: ['把任何题材都套成一张满屏照片。', '为追求纹理牺牲文字对比与阅读。', '裁掉关键主体，或把文字压在细节最密集处。'],
    explore: [
      { name: '影像开场', structure: '图像建立场景，正文接续解释。', visual: '有焦点的裁切、简短标题、图注节奏。' },
      { name: '文字主导', structure: '文字先建立观点，图像作为旁注或证据。', visual: '鲜明字阶、长短段落、克制材料。' },
      { name: '图文编织', structure: '图像与文字按内容节点交错，不平均分配。', visual: '比例差异、对齐线、不对称留白。' },
    ],
    rp1: '阅读流优先column与hug，图文段落用组件复用；任意定位仅用于需要的叠合。裁切素材与节点登记同事务，导出时检查文字仍原生可编辑。',
  },
];

const defaults = {
  mobile: { editorial: 'field-story', task: 'task-instrument', learning: 'recall-focus' },
  web: { editorial: 'field-story', task: 'data-workspace', learning: 'learning-route' },
};

function designError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function getDesignGuidance({ intent = 'editorial', platform = 'mobile', guideId = null } = {}) {
  if (!['editorial', 'task', 'learning'].includes(intent)) throw designError('E_DESIGN_INTENT', 'intent 请选择 editorial、task 或 learning');
  if (!Object.hasOwn(defaults, platform)) throw designError('E_DESIGN_PLATFORM', `不支持设计平台 ${JSON.stringify(platform)}；请选择 mobile 或 web`, { allowedPlatforms: Object.keys(defaults) });
  const selected = guides.find(guide => guide.id === (guideId ?? defaults[platform][intent]));
  if (!selected) {
    const candidates = guides.filter(guide => guide.platforms.includes(platform)).map(guide => guide.id);
    throw designError('E_DESIGN_GUIDE', `设计配方不存在：${guideId}；${platform} 可选：${candidates.join('、')}`, { candidates });
  }
  if (!selected.platforms.includes(platform)) throw designError('E_DESIGN_GUIDE_PLATFORM', `配方 ${selected.id} 不适用于 ${platform}；适用平台：${selected.platforms.join('、')}`, { guideId: selected.id, allowedPlatforms: selected.platforms });
  return {
    platform,
    guide: structuredClone(selected),
    provenance: { type: 'authored-guidance', userAccepted: false, note: '原创设计指导，不是固定节点模板或已获用户认可的作品；数值与配方可按真实任务调整。' },
    matchesIntent: selected.intents.includes(intent),
    availableGuides: guides.filter(guide => guide.platforms.includes(platform)).map(({ id, name, intents }) => ({ id, name, intents: [...intents] })),
    brief: {
      task: '一句话写清用户本页要完成的事及主要动作。',
      content: '列出必须保留的文案、数据事实和信息优先级，缺失事实不编造。',
      states: '列出初始、操作后、空/错与长内容状态，以及到达它们的动作和期望。',
      constraints: '记录品牌、设备、素材、可编辑交付与禁止改变的行为。',
    },
    reviewQuestions: ['主角是否一眼可辨，主要动作是否可达？', '文字长度、图像主体与留白是否一起成立？', '空/错/长内容与操作后状态是否仍可用？', '候选是否改变结构、字阶或材料，而不只换色？', '原生输出的可编辑部分与降级是否有证据？'],
  };
}
