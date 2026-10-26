// Formal Component Contracts for zee-rp Free Canvas Studio (Direction 3)
// Covers the 6 core reusable UI components:
// 1. button (按钮)
// 2. input-field (输入框)
// 3. list-item (列表项)
// 4. info-card (信息卡片)
// 5. nav-bar (顶部/底部导航栏)
// 6. status-zone (空状态/错误态/加载态)

export const CORE_COMPONENT_CONTRACTS = {
  button: {
    componentId: 'button',
    version: '1.0.0',
    title: '通用操作按钮 (Button)',
    category: 'action',
    description: '支持主操作、次操作、危险操作及加载/禁用/选中态的标准按钮组件契约。',
    parameters: {
      label: {
        type: 'string',
        required: true,
        default: '立即操作',
        minLength: 1,
        maxLength: 24,
        targetSubNodeId: 'btn_label',
        targetProp: 'text',
        description: '按钮显示文案',
      },
      tone: {
        type: 'enum',
        required: false,
        default: 'primary',
        enum: ['primary', 'secondary', 'ghost', 'danger'],
        targetSubNodeId: '$root',
        targetProp: 'variant',
        description: '按钮视觉语义层级',
      },
      icon: {
        type: 'string',
        required: false,
        default: 'spark',
        targetSubNodeId: 'btn_icon',
        targetProp: 'icon',
        description: '前缀图标名称',
      },
      badgeText: {
        type: 'string',
        required: false,
        default: '',
        maxLength: 8,
        targetSubNodeId: 'btn_badge',
        targetProp: 'text',
        description: '按钮右上角或右侧附属徽标文本',
      },
    },
    slots: {
      prefix: {
        slotId: 'prefix',
        allowedNodeTypes: ['icon', 'badge'],
        maxCount: 1,
        defaultLayout: 'row',
        description: '按钮前置图标或状态点插槽',
      },
      suffix: {
        slotId: 'suffix',
        allowedNodeTypes: ['icon', 'badge', 'label'],
        maxCount: 1,
        defaultLayout: 'row',
        description: '按钮后置角标或箭头插槽',
      },
    },
    allowedOverrides: ['$root', 'btn_label', 'btn_icon', 'btn_badge', 'label', 'tone', 'icon', 'badgeText'],
    lockedInternalStructure: true,
    sizingContract: {
      defaultW: 'hug',
      defaultH: 44,
      minW: 88,
      maxW: 370,
      minH: 32,
      maxH: 64,
      supportedWidthModes: ['fixed', 'hug', 'fill'],
      supportedHeightModes: ['fixed', 'hug'],
      longTextStrategy: 'expand-width-up-to-maxW-then-wrap',
      padding: [10, 16, 10, 16],
      gap: 8,
    },
    states: {
      default: {
        description: '默认可点击状态',
        interactive: true,
        overrides: {
          $root: { fill: '$brand', stroke: '#FFFFFF00', opacity: 1 },
          btn_label: { color: '#FFFFFF' },
          btn_icon: { color: '#FFFFFF' },
        },
      },
      selected: {
        description: '已选中/激活状态',
        interactive: true,
        overrides: {
          $root: { fill: '#1B4332', stroke: '$accent', strokeWidth: 2, opacity: 1 },
          btn_label: { color: '#FFFFFF', fontWeight: 700 },
        },
      },
      disabled: {
        description: '禁用态（不可触发点击动作）',
        interactive: false,
        overrides: {
          $root: { fill: '#D5DDD8', stroke: '#C5D0CA', opacity: 0.55 },
          btn_label: { color: '#6E7E75' },
          btn_icon: { color: '#6E7E75' },
        },
      },
      loading: {
        description: '加载处理中状态（防重复提交）',
        interactive: false,
        overrides: {
          $root: { fill: '$brand', opacity: 0.8 },
          btn_label: { text: '处理中…', color: '#FFFFFF' },
          btn_icon: { icon: 'compass', color: '#FFFFFF' },
        },
      },
      error: {
        description: '错误重试状态',
        interactive: true,
        overrides: {
          $root: { fill: '$danger', stroke: '#B91C1C', opacity: 1 },
          btn_label: { color: '#FFFFFF' },
        },
      },
      success: {
        description: '操作完成状态',
        interactive: true,
        overrides: {
          $root: { fill: '$success', opacity: 1 },
          btn_label: { color: '#FFFFFF' },
          btn_icon: { icon: 'check', color: '#FFFFFF' },
        },
      },
    },
    events: {
      onTap: {
        nativeEvent: 'click',
        description: '点击按钮触发的主动作（在 disabled/loading 状态下被抑制）',
        payloadFields: ['instanceId', 'state', 'label'],
      },
    },
    definition: {
      id: 'button',
      name: '通用操作按钮',
      contractVersion: '1.0.0',
      defaultVariant: 'primary',
      variants: {
        primary: {
          $root: { fill: '$brand', stroke: '#FFFFFF00' },
          btn_label: { color: '#FFFFFF' },
          btn_icon: { color: '#FFFFFF' },
        },
        secondary: {
          $root: { fill: '$surface-2', stroke: '$line', strokeWidth: 1 },
          btn_label: { color: '$ink' },
          btn_icon: { color: '$brand' },
        },
        ghost: {
          $root: { fill: '#FFFFFF00', stroke: '$brand', strokeWidth: 1 },
          btn_label: { color: '$brand' },
          btn_icon: { color: '$brand' },
        },
        danger: {
          $root: { fill: '$danger', stroke: '#FFFFFF00' },
          btn_label: { color: '#FFFFFF' },
          btn_icon: { color: '#FFFFFF' },
        },
      },
      root: {
        id: 'button_root',
        type: 'box',
        layout: 'row',
        align: 'center',
        justify: 'center',
        padding: [10, 16, 10, 16],
        gap: 8,
        w: 'hug',
        h: 44,
        minW: 88,
        maxW: 370,
        radius: 12,
        fill: '$brand',
        children: [
          { id: 'btn_icon', type: 'icon', icon: 'spark', w: 16, h: 16, color: '#FFFFFF' },
          { id: 'btn_label', type: 'label', text: '立即操作', fontSize: 14, fontWeight: 600, color: '#FFFFFF' },
          { id: 'btn_badge', type: 'badge', text: '', fontSize: 11, fontWeight: 600, fill: '#FFFFFF33', color: '#FFFFFF', radius: 8, visible: false },
        ],
      },
    },
    examples: [
      {
        title: '主操作按钮示例',
        instance: {
          id: 'demo_primary_btn',
          type: 'instance',
          component: 'button',
          variant: 'primary',
          state: 'default',
          props: { label: '开始记录观测', icon: 'plus' },
        },
      },
      {
        title: '禁用态按钮示例',
        instance: {
          id: 'demo_disabled_btn',
          type: 'instance',
          component: 'button',
          variant: 'secondary',
          state: 'disabled',
          props: { label: '已归档不可修改' },
        },
      },
    ],
  },

  'input-field': {
    componentId: 'input-field',
    version: '1.0.0',
    title: '标准表单输入框 (Input Field)',
    category: 'form',
    description: '带字段标题、输入框主体和校验提示语的标准输入组件契约。',
    parameters: {
      fieldLabel: {
        type: 'string',
        required: true,
        default: '输入项名称',
        minLength: 1,
        maxLength: 32,
        targetSubNodeId: 'inp_label',
        targetProp: 'text',
        description: '输入框上方字段标题',
      },
      placeholder: {
        type: 'string',
        required: false,
        default: '请输入内容…',
        maxLength: 60,
        targetSubNodeId: 'inp_control',
        targetProp: 'placeholder',
        description: '占位提示文案',
      },
      value: {
        type: 'string',
        required: false,
        default: '',
        maxLength: 200,
        targetSubNodeId: 'inp_control',
        targetProp: 'text',
        description: '当前输入值',
      },
      helperText: {
        type: 'string',
        required: false,
        default: '支持中英文、数字与常用符号',
        maxLength: 80,
        targetSubNodeId: 'inp_helper',
        targetProp: 'text',
        description: '底部辅助说明或错误原因',
      },
    },
    slots: {
      trailing: {
        slotId: 'trailing',
        allowedNodeTypes: ['icon', 'button', 'badge'],
        maxCount: 1,
        defaultLayout: 'row',
        description: '输入框右侧清除按钮或单位角标插槽',
      },
    },
    allowedOverrides: ['$root', 'inp_label', 'inp_control', 'inp_helper', 'fieldLabel', 'placeholder', 'value', 'helperText'],
    lockedInternalStructure: true,
    sizingContract: {
      defaultW: 'fill',
      defaultH: 'hug',
      minW: 160,
      maxW: 370,
      minH: 68,
      maxH: 136,
      supportedWidthModes: ['fixed', 'fill'],
      supportedHeightModes: ['hug', 'fixed'],
      longTextStrategy: 'helper-text-wraps-and-expands-container-height',
      padding: [4, 0, 4, 0],
      gap: 6,
    },
    states: {
      default: {
        description: '默认可输入状态',
        interactive: true,
        overrides: {
          inp_control: { fill: '$surface', stroke: '$line', strokeWidth: 1, color: '$ink' },
          inp_helper: { color: '$ink-2' },
        },
      },
      selected: {
        description: '聚焦/激活输入状态',
        interactive: true,
        overrides: {
          inp_control: { fill: '$surface', stroke: '$brand', strokeWidth: 2, color: '$ink' },
          inp_helper: { color: '$brand' },
        },
      },
      disabled: {
        description: '只读禁用状态',
        interactive: false,
        overrides: {
          $root: { opacity: 0.6 },
          inp_control: { fill: '#EEF2EE', stroke: '#D5DDD8', color: '#7A887E' },
        },
      },
      error: {
        description: '表单校验失败状态',
        interactive: true,
        overrides: {
          inp_control: { fill: '#FEF2F2', stroke: '$danger', strokeWidth: 2, color: '$ink' },
          inp_helper: { color: '$danger', text: '输入项格式有误，请检查后重试' },
        },
      },
      success: {
        description: '表单校验通过状态',
        interactive: true,
        overrides: {
          inp_control: { fill: '$surface', stroke: '$success', strokeWidth: 1, color: '$ink' },
          inp_helper: { color: '$success', text: '格式校验通过' },
        },
      },
    },
    events: {
      onChange: {
        nativeEvent: 'change',
        description: '输入值变更时更新绑定变量',
        payloadFields: ['value'],
      },
      onSubmit: {
        nativeEvent: 'click',
        description: '提交或触发校验',
        payloadFields: ['value'],
      },
    },
    definition: {
      id: 'input-field',
      name: '标准表单输入框',
      contractVersion: '1.0.0',
      defaultVariant: 'standard',
      variants: {
        standard: {},
        compact: {
          inp_control: { h: 36 },
        },
      },
      root: {
        id: 'input_field_root',
        type: 'box',
        layout: 'column',
        w: 'fill',
        h: 'hug',
        minW: 160,
        maxW: 370,
        gap: 6,
        padding: [4, 0, 4, 0],
        fill: '#FFFFFF00',
        children: [
          { id: 'inp_label', type: 'label', text: '输入项名称', w: 'fill', fontSize: 13, fontWeight: 600, color: '$ink' },
          { id: 'inp_control', type: 'input', placeholder: '请输入内容…', text: '', w: 'fill', h: 42, radius: 10, fill: '$surface', stroke: '$line', strokeWidth: 1, fontSize: 14, color: '$ink' },
          { id: 'inp_helper', type: 'paragraph', text: '支持中英文、数字与常用符号', w: 'fill', fontSize: 11, lineHeight: 16, color: '$ink-2', wrap: true },
        ],
      },
    },
    examples: [
      {
        title: '搜索/录入输入框示例',
        instance: {
          id: 'demo_species_input',
          type: 'instance',
          component: 'input-field',
          state: 'default',
          props: {
            fieldLabel: '物种或卡片关键词',
            placeholder: '输入中英文名称或编号',
            helperText: '可按名称、生境或标签即时过滤',
          },
        },
      },
    ],
  },

  'list-item': {
    componentId: 'list-item',
    version: '1.0.0',
    title: '结构化列表项 (List Item)',
    category: 'data-display',
    description: '用于物种名录、学习题卡队列、设备清单等列表行的标准组件契约，支持标题、副标题、状态徽标与选中态。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        default: '列表项主标题',
        minLength: 1,
        maxLength: 50,
        targetSubNodeId: 'li_title',
        targetProp: 'text',
        description: '列表项主标题',
      },
      subtitle: {
        type: 'string',
        required: false,
        default: '补充说明与时间/地点元数据',
        maxLength: 100,
        targetSubNodeId: 'li_subtitle',
        targetProp: 'text',
        description: '列表项次级描述文本',
      },
      metaBadge: {
        type: 'string',
        required: false,
        default: '正常',
        maxLength: 16,
        targetSubNodeId: 'li_badge',
        targetProp: 'text',
        description: '右侧状态徽标文案',
      },
      leadingIcon: {
        type: 'string',
        required: false,
        default: 'book',
        targetSubNodeId: 'li_icon',
        targetProp: 'icon',
        description: '左侧图标名称',
      },
    },
    slots: {
      trailingAction: {
        slotId: 'trailingAction',
        allowedNodeTypes: ['badge', 'button', 'icon', 'label'],
        maxCount: 2,
        defaultLayout: 'row',
        description: '右侧状态标签或快捷操作插槽',
      },
    },
    allowedOverrides: ['$root', 'li_title', 'li_subtitle', 'li_badge', 'li_icon', 'title', 'subtitle', 'metaBadge', 'leadingIcon'],
    lockedInternalStructure: true,
    sizingContract: {
      defaultW: 'fill',
      defaultH: 'hug',
      minW: 240,
      maxW: 370,
      minH: 56,
      maxH: 140,
      supportedWidthModes: ['fill', 'fixed'],
      supportedHeightModes: ['hug', 'fixed'],
      longTextStrategy: 'title-and-subtitle-wrap-and-expand-row-height',
      padding: [12, 14, 12, 14],
      gap: 12,
    },
    states: {
      default: {
        description: '常规未选中列表行',
        interactive: true,
        overrides: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1, opacity: 1 },
          li_title: { color: '$ink' },
          li_badge: { fill: '$surface-2', color: '$brand' },
        },
      },
      selected: {
        description: '当前选中列表行（高亮背景与主色边框）',
        interactive: true,
        overrides: {
          $root: { fill: '$brand-soft', stroke: '$brand', strokeWidth: 2, opacity: 1 },
          li_title: { color: '$brand', fontWeight: 700 },
          li_badge: { fill: '$brand', color: '#FFFFFF' },
        },
      },
      disabled: {
        description: '不可选列表行',
        interactive: false,
        overrides: {
          $root: { fill: '#F3F5F3', stroke: '#E2E7E3', opacity: 0.55 },
          li_title: { color: '#7A887E' },
        },
      },
      loading: {
        description: '列表行同步加载中',
        interactive: false,
        overrides: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1, opacity: 0.85 },
          li_badge: { text: '同步中…', fill: '$surface-2', color: '$ink-2' },
        },
      },
      error: {
        description: '异常/逾期告警列表行',
        interactive: true,
        overrides: {
          $root: { fill: '#FEF2F2', stroke: '$danger', strokeWidth: 1 },
          li_badge: { fill: '#FEE2E2', color: '$danger' },
        },
      },
    },
    events: {
      onSelect: {
        nativeEvent: 'click',
        description: '点击列表行触发选中或打开详情',
        payloadFields: ['title', 'metaBadge', 'state'],
      },
    },
    definition: {
      id: 'list-item',
      name: '结构化列表项',
      contractVersion: '1.0.0',
      defaultVariant: 'standard',
      variants: {
        standard: {},
        dense: {
          $root: { padding: [8, 12, 8, 12] },
        },
      },
      root: {
        id: 'list_item_root',
        type: 'box',
        layout: 'row',
        align: 'center',
        justify: 'space-between',
        w: 'fill',
        h: 'hug',
        minW: 240,
        maxW: 370,
        minH: 60,
        padding: [12, 14, 12, 14],
        gap: 12,
        radius: 12,
        fill: '$surface',
        stroke: '$line',
        strokeWidth: 1,
        children: [
          {
            id: 'li_icon_box',
            type: 'box',
            layout: 'row',
            align: 'center',
            justify: 'center',
            w: 36,
            h: 36,
            radius: 10,
            fill: '$surface-2',
            children: [
              { id: 'li_icon', type: 'icon', icon: 'book', w: 18, h: 18, color: '$brand' },
            ],
          },
          {
            id: 'li_text_col',
            type: 'box',
            layout: 'column',
            flex: 1,
            w: 'fill',
            h: 'hug',
            gap: 4,
            children: [
              { id: 'li_title', type: 'paragraph', text: '列表项主标题', w: 'fill', fontSize: 15, fontWeight: 600, lineHeight: 20, color: '$ink', wrap: true },
              { id: 'li_subtitle', type: 'paragraph', text: '补充说明与时间/地点元数据', w: 'fill', fontSize: 12, lineHeight: 17, color: '$ink-2', wrap: true },
            ],
          },
          {
            id: 'li_badge',
            type: 'badge',
            text: '正常',
            w: 'hug',
            h: 24,
            radius: 12,
            fill: '$surface-2',
            color: '$brand',
            fontSize: 11,
            fontWeight: 600,
          },
        ],
      },
    },
    examples: [
      {
        title: '默认与选中态列表项示例',
        instance: {
          id: 'demo_list_item_1',
          type: 'instance',
          component: 'list-item',
          state: 'selected',
          props: {
            title: '黑脸琵鹭 · Platalea minor',
            subtitle: '闽江口鳝鱼滩 · 今日 06:40 记录 3 只',
            metaBadge: '一级保护',
            leadingIcon: 'compass',
          },
        },
      },
    ],
  },

  'info-card': {
    componentId: 'info-card',
    version: '1.0.0',
    title: '复合信息卡片 (Info Card)',
    category: 'data-display',
    description: '包含分类标签、主标题、正文摘要、底部元信息与内置操作按钮的复合卡片契约（支持组件嵌套 button 实例）。',
    parameters: {
      tag: {
        type: 'string',
        required: false,
        default: '重点推荐',
        maxLength: 18,
        targetSubNodeId: 'card_tag',
        targetProp: 'text',
        description: '卡片顶部领域或状态标签',
      },
      title: {
        type: 'string',
        required: true,
        default: '卡片核心标题',
        minLength: 1,
        maxLength: 80,
        targetSubNodeId: 'card_title',
        targetProp: 'text',
        description: '卡片主标题（支持多行自动换行增高）',
      },
      summary: {
        type: 'string',
        required: false,
        default: '这里展示核心观察摘要、卡片知识点或设备参数说明，支持长文本自动换行。',
        maxLength: 240,
        targetSubNodeId: 'card_summary',
        targetProp: 'text',
        description: '卡片正文描述',
      },
      metaText: {
        type: 'string',
        required: false,
        default: '更新于 10 分钟前',
        maxLength: 48,
        targetSubNodeId: 'card_meta',
        targetProp: 'text',
        description: '卡片底部左侧元信息',
      },
      actionLabel: {
        type: 'string',
        required: false,
        default: '查看详情',
        maxLength: 16,
        targetSubNodeId: 'card_action_btn/btn_label',
        targetProp: 'text',
        description: '嵌套按钮文案',
      },
    },
    slots: {
      media: {
        slotId: 'media',
        allowedNodeTypes: ['image', 'box'],
        maxCount: 1,
        defaultLayout: 'column',
        description: '卡片顶部配图或视觉封面插槽',
      },
      footerActions: {
        slotId: 'footerActions',
        allowedNodeTypes: ['button', 'badge', 'instance'],
        maxCount: 2,
        defaultLayout: 'row',
        description: '卡片底部操作区插槽',
      },
    },
    allowedOverrides: [
      '$root',
      'card_tag',
      'card_title',
      'card_summary',
      'card_meta',
      'card_action_btn',
      'card_action_btn/btn_label',
      'tag',
      'title',
      'summary',
      'metaText',
      'actionLabel',
    ],
    lockedInternalStructure: true,
    sizingContract: {
      defaultW: 'fill',
      defaultH: 'hug',
      minW: 260,
      maxW: 370,
      minH: 132,
      maxH: 420,
      supportedWidthModes: ['fill', 'fixed'],
      supportedHeightModes: ['hug', 'fixed'],
      longTextStrategy: 'title-and-summary-wrap-and-push-footer-down',
      padding: [16, 16, 16, 16],
      gap: 10,
    },
    states: {
      default: {
        description: '默认展示卡片',
        interactive: true,
        overrides: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1, opacity: 1 },
          card_tag: { fill: '$brand-soft', color: '$brand' },
        },
      },
      selected: {
        description: '选中高亮卡片',
        interactive: true,
        overrides: {
          $root: { fill: '$surface', stroke: '$brand', strokeWidth: 2, opacity: 1 },
          card_tag: { fill: '$brand', color: '#FFFFFF' },
        },
      },
      disabled: {
        description: '已归档/禁用卡片',
        interactive: false,
        overrides: {
          $root: { fill: '#F4F6F4', stroke: '#DFE5E0', opacity: 0.6 },
        },
      },
      loading: {
        description: '卡片内容同步中',
        interactive: false,
        overrides: {
          card_tag: { text: '同步中…', fill: '$surface-2', color: '$ink-2' },
          card_summary: { text: '正在加载最新记录数据…', color: '$ink-2' },
        },
      },
      error: {
        description: '告警/异常卡片状态',
        interactive: true,
        overrides: {
          $root: { fill: '#FEF2F2', stroke: '$danger', strokeWidth: 1 },
          card_tag: { fill: '#FEE2E2', color: '$danger' },
        },
      },
    },
    events: {
      onAction: {
        nativeEvent: 'click',
        description: '点击卡片或底部按钮触发详情/主流程动作',
        payloadFields: ['title', 'tag', 'state'],
      },
    },
    definition: {
      id: 'info-card',
      name: '复合信息卡片',
      contractVersion: '1.0.0',
      defaultVariant: 'elevated',
      variants: {
        elevated: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1 },
        },
        tinted: {
          $root: { fill: '$surface-2', stroke: '#FFFFFF00', strokeWidth: 0 },
        },
      },
      root: {
        id: 'info_card_root',
        type: 'box',
        layout: 'column',
        w: 'fill',
        h: 'hug',
        minW: 260,
        maxW: 370,
        padding: [16, 16, 16, 16],
        gap: 10,
        radius: 16,
        fill: '$surface',
        stroke: '$line',
        strokeWidth: 1,
        children: [
          {
            id: 'card_tag',
            type: 'badge',
            text: '重点推荐',
            w: 'hug',
            h: 24,
            radius: 12,
            fill: '$brand-soft',
            color: '$brand',
            fontSize: 11,
            fontWeight: 600,
          },
          {
            id: 'card_title',
            type: 'paragraph',
            text: '卡片核心标题',
            w: 'fill',
            fontSize: 17,
            fontWeight: 600,
            lineHeight: 24,
            color: '$ink',
            wrap: true,
          },
          {
            id: 'card_summary',
            type: 'paragraph',
            text: '这里展示核心观察摘要、卡片知识点或设备参数说明，支持长文本自动换行。',
            w: 'fill',
            fontSize: 13,
            fontWeight: 400,
            lineHeight: 19,
            color: '$ink-2',
            wrap: true,
          },
          {
            id: 'card_footer',
            type: 'box',
            layout: 'row',
            align: 'center',
            justify: 'space-between',
            w: 'fill',
            h: 'hug',
            minH: 36,
            gap: 8,
            children: [
              { id: 'card_meta', type: 'paragraph', text: '更新于 10 分钟前', flex: 1, w: 'fill', fontSize: 12, lineHeight: 17, color: '$ink-2', wrap: true },
              {
                id: 'card_action_btn',
                type: 'instance',
                component: 'button',
                variant: 'secondary',
                h: 32,
                overrides: {
                  btn_label: { text: '查看详情', fontSize: 12 },
                },
              },
            ],
          },
        ],
      },
    },
    examples: [
      {
        title: '带嵌套按钮的复合信息卡片',
        instance: {
          id: 'demo_info_card',
          type: 'instance',
          component: 'info-card',
          state: 'default',
          props: {
            tag: '迁徙热点',
            title: '闽江口鳝鱼滩退潮期水鸟聚集观察',
            summary: '退潮后 90 分钟内泥滩裸露面积最大，黑脸琵鹭与大滨鹬常在此集中觅食。',
            metaText: '能见度 12km · 适宜观测',
            actionLabel: '打开点位指南',
          },
        },
      },
    ],
  },

  'nav-bar': {
    componentId: 'nav-bar',
    version: '1.0.0',
    title: '顶部/底部导航栏 (Nav Bar)',
    category: 'navigation',
    description: '支持顶部页面标题栏与底部多 Tab 切换栏的导航组件契约。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        default: '页面标题',
        minLength: 1,
        maxLength: 28,
        targetSubNodeId: 'nav_title',
        targetProp: 'text',
        description: '当前导航栏主标题',
      },
      subtitle: {
        type: 'string',
        required: false,
        default: '在线同步中',
        maxLength: 36,
        targetSubNodeId: 'nav_subtitle',
        targetProp: 'text',
        description: '副标题或状态副文案',
      },
      rightActionText: {
        type: 'string',
        required: false,
        default: '筛选',
        maxLength: 10,
        targetSubNodeId: 'nav_action_badge',
        targetProp: 'text',
        description: '右侧快捷操作按钮文案',
      },
    },
    slots: {
      leading: {
        slotId: 'leading',
        allowedNodeTypes: ['icon', 'button'],
        maxCount: 1,
        defaultLayout: 'row',
        description: '导航栏左侧返回或菜单插槽',
      },
      trailing: {
        slotId: 'trailing',
        allowedNodeTypes: ['icon', 'button', 'badge'],
        maxCount: 2,
        defaultLayout: 'row',
        description: '导航栏右侧操作项插槽',
      },
    },
    allowedOverrides: ['$root', 'nav_title', 'nav_subtitle', 'nav_action_badge', 'nav_back_icon', 'title', 'subtitle', 'rightActionText'],
    lockedInternalStructure: true,
    sizingContract: {
      defaultW: 'fill',
      defaultH: 52,
      minW: 320,
      maxW: 430,
      minH: 44,
      maxH: 72,
      supportedWidthModes: ['fill', 'fixed'],
      supportedHeightModes: ['fixed', 'hug'],
      longTextStrategy: 'single-line-priority-with-compact-action-pill',
      padding: [8, 14, 8, 14],
      gap: 10,
    },
    states: {
      default: {
        description: '常规导航栏状态',
        interactive: true,
        overrides: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1 },
        },
      },
      selected: {
        description: '当前激活筛选或高强调导航态',
        interactive: true,
        overrides: {
          $root: { fill: '$brand-soft', stroke: '$brand', strokeWidth: 1 },
          nav_action_badge: { fill: '$brand', color: '#FFFFFF' },
        },
      },
      disabled: {
        description: '只读/锁定导航栏状态',
        interactive: false,
        overrides: {
          $root: { fill: '#F3F5F3', stroke: '#E2E7E3', opacity: 0.6 },
          nav_action_badge: { fill: '#E2E7E3', color: '#7A887E' },
        },
      },
      loading: {
        description: '导航栏数据同步中状态',
        interactive: false,
        overrides: {
          nav_subtitle: { text: '正在同步…', color: '$brand' },
          nav_action_badge: { text: '同步中', fill: '$surface-2', color: '$ink-2' },
        },
      },
      error: {
        description: '离线/连接异常导航栏状态',
        interactive: true,
        overrides: {
          $root: { fill: '#FEF2F2', stroke: '$danger', strokeWidth: 1 },
          nav_subtitle: { text: '离线待重连', color: '$danger' },
          nav_action_badge: { fill: '#FEE2E2', color: '$danger' },
        },
      },
    },
    events: {
      onBack: {
        nativeEvent: 'click',
        description: '点击左侧返回按钮触发返回上一页',
        payloadFields: ['title'],
      },
      onTabChange: {
        nativeEvent: 'click',
        description: '点击右侧动作或切换导航项',
        payloadFields: ['rightActionText'],
      },
    },
    definition: {
      id: 'nav-bar',
      name: '顶部/底部导航栏',
      contractVersion: '1.0.0',
      defaultVariant: 'top-header',
      variants: {
        'top-header': {},
        'bottom-bar': {
          $root: { radius: 20, fill: '$surface', stroke: '$line', strokeWidth: 1 },
        },
      },
      root: {
        id: 'nav_bar_root',
        type: 'box',
        layout: 'row',
        align: 'center',
        justify: 'space-between',
        w: 'fill',
        h: 52,
        minW: 320,
        maxW: 430,
        padding: [8, 14, 8, 14],
        gap: 10,
        radius: 14,
        fill: '$surface',
        stroke: '$line',
        strokeWidth: 1,
        children: [
          {
            id: 'nav_left_group',
            type: 'box',
            layout: 'row',
            align: 'center',
            gap: 8,
            w: 'hug',
            h: 36,
            children: [
              { id: 'nav_back_icon', type: 'icon', icon: 'chevron-left', w: 18, h: 18, color: '$ink' },
              {
                id: 'nav_titles',
                type: 'box',
                layout: 'column',
                w: 'hug',
                h: 'hug',
                gap: 2,
                children: [
                  { id: 'nav_title', type: 'label', text: '页面标题', fontSize: 15, fontWeight: 600, color: '$ink' },
                  { id: 'nav_subtitle', type: 'label', text: '在线同步中', fontSize: 11, color: '$ink-2' },
                ],
              },
            ],
          },
          {
            id: 'nav_action_badge',
            type: 'badge',
            text: '筛选',
            w: 'hug',
            h: 28,
            radius: 14,
            fill: '$surface-2',
            color: '$brand',
            fontSize: 12,
            fontWeight: 600,
          },
        ],
      },
    },
    examples: [
      {
        title: '页面顶部导航栏示例',
        instance: {
          id: 'demo_top_nav',
          type: 'instance',
          component: 'nav-bar',
          state: 'default',
          props: {
            title: '观测记录工作台',
            subtitle: '今日已同步 12 条',
            rightActionText: '新建',
          },
        },
      },
    ],
  },

  'status-zone': {
    componentId: 'status-zone',
    version: '1.0.0',
    title: '状态反馈区 (Status Zone)',
    category: 'feedback',
    description: '用于空状态 (empty)、错误告警态 (error)、加载态 (loading) 与完成反馈态 (success) 的统一容器契约。',
    parameters: {
      headline: {
        type: 'string',
        required: true,
        default: '暂无符合条件的数据',
        minLength: 1,
        maxLength: 60,
        targetSubNodeId: 'sz_headline',
        targetProp: 'text',
        description: '状态反馈主标题',
      },
      descriptionText: {
        type: 'string',
        required: false,
        default: '可尝试放宽筛选关键词，或直接新建第一条记录。',
        maxLength: 160,
        targetSubNodeId: 'sz_desc',
        targetProp: 'text',
        description: '状态说明与恢复指引文案',
      },
      retryLabel: {
        type: 'string',
        required: false,
        default: '重置筛选条件',
        maxLength: 20,
        targetSubNodeId: 'sz_action_btn',
        targetProp: 'text',
        description: '恢复/重试动作按钮文案',
      },
    },
    slots: {
      actions: {
        slotId: 'actions',
        allowedNodeTypes: ['button', 'instance', 'badge'],
        maxCount: 2,
        defaultLayout: 'row',
        description: '底部恢复操作按钮插槽',
      },
    },
    allowedOverrides: ['$root', 'sz_icon', 'sz_headline', 'sz_desc', 'sz_action_btn', 'headline', 'descriptionText', 'retryLabel'],
    lockedInternalStructure: true,
    sizingContract: {
      defaultW: 'fill',
      defaultH: 'hug',
      minW: 240,
      maxW: 370,
      minH: 136,
      maxH: 320,
      supportedWidthModes: ['fill', 'fixed'],
      supportedHeightModes: ['hug', 'fixed'],
      longTextStrategy: 'centered-multiline-description-with-auto-height',
      padding: [20, 18, 20, 18],
      gap: 10,
    },
    states: {
      empty: {
        description: '空数据/无搜索结果状态',
        interactive: true,
        overrides: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1 },
          sz_icon: { icon: 'search', color: '$ink-2' },
          sz_headline: { text: '暂无符合条件的数据', color: '$ink' },
          sz_action_btn: { fill: '$surface-2', color: '$brand' },
        },
      },
      loading: {
        description: '数据加载中状态',
        interactive: false,
        overrides: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1, opacity: 0.9 },
          sz_icon: { icon: 'compass', color: '$brand' },
          sz_headline: { text: '正在同步最新数据…', color: '$brand' },
          sz_desc: { text: '请稍候，正在拉取云端与本地缓存记录。', color: '$ink-2' },
          sz_action_btn: { text: '加载中…', fill: '#E2E8F0', color: '#64748B' },
        },
      },
      error: {
        description: '加载失败或校验冲突错误态',
        interactive: true,
        overrides: {
          $root: { fill: '#FEF2F2', stroke: '$danger', strokeWidth: 1 },
          sz_icon: { icon: 'spark', color: '$danger' },
          sz_headline: { text: '数据同步或校验未通过', color: '$danger' },
          sz_desc: { text: '请检查输入项或网络连接后点击下方按钮重试。', color: '#991B1B' },
          sz_action_btn: { text: '立即重试', fill: '$danger', color: '#FFFFFF' },
        },
      },
      default: {
        description: '默认提示状态（同 empty）',
        interactive: true,
        overrides: {
          $root: { fill: '$surface', stroke: '$line', strokeWidth: 1 },
        },
      },
      success: {
        description: '提交完成确认状态',
        interactive: true,
        overrides: {
          $root: { fill: '#F0FDF4', stroke: '$success', strokeWidth: 1 },
          sz_icon: { icon: 'check', color: '$success' },
          sz_headline: { text: '已完成提交并更新记录', color: '$success' },
          sz_action_btn: { text: '返回列表', fill: '$success', color: '#FFFFFF' },
        },
      },
      selected: {
        description: '选中聚焦提示状态',
        interactive: true,
        overrides: {
          $root: { fill: '$surface-2', stroke: '$brand', strokeWidth: 2 },
          sz_icon: { icon: 'compass', color: '$brand' },
          sz_headline: { color: '$brand' },
        },
      },
    },
    events: {
      onRetry: {
        nativeEvent: 'click',
        description: '点击恢复/重试按钮触发状态恢复',
        payloadFields: ['state', 'retryLabel'],
      },
    },
    definition: {
      id: 'status-zone',
      name: '状态反馈区',
      contractVersion: '1.0.0',
      defaultVariant: 'card',
      variants: {
        card: {},
        inline: {
          $root: { padding: [12, 14, 12, 14] },
        },
      },
      root: {
        id: 'status_zone_root',
        type: 'box',
        layout: 'column',
        align: 'center',
        justify: 'center',
        w: 'fill',
        h: 'hug',
        minW: 240,
        maxW: 370,
        padding: [20, 18, 20, 18],
        gap: 10,
        radius: 16,
        fill: '$surface',
        stroke: '$line',
        strokeWidth: 1,
        children: [
          { id: 'sz_icon', type: 'icon', icon: 'search', w: 24, h: 24, color: '$ink-2' },
          { id: 'sz_headline', type: 'paragraph', text: '暂无符合条件的数据', w: 'fill', align: 'center', fontSize: 15, fontWeight: 600, lineHeight: 22, color: '$ink', wrap: true },
          { id: 'sz_desc', type: 'paragraph', text: '可尝试放宽筛选关键词，或直接新建第一条记录。', w: 'fill', align: 'center', fontSize: 12, lineHeight: 18, color: '$ink-2', wrap: true },
          { id: 'sz_action_btn', type: 'button', text: '重置筛选条件', w: 'hug', h: 36, radius: 10, fill: '$surface-2', color: '$brand', fontSize: 13, fontWeight: 600 },
        ],
      },
    },
    examples: [
      {
        title: '空状态与错误态示例',
        instance: {
          id: 'demo_empty_zone',
          type: 'instance',
          component: 'status-zone',
          state: 'empty',
          props: {
            headline: '未找到匹配的观测物种',
            descriptionText: '当前筛选条件下无记录，可切换为“全部生境”或新增手记。',
            retryLabel: '显示全部物种',
          },
        },
      },
    ],
  },
};

export function getComponentContracts(componentIdOrDoc = null, docOrOptions = null) {
  let componentId = null;
  let doc = null;
  let returnEnvelope = false;

  if (componentIdOrDoc && typeof componentIdOrDoc === 'object') {
    doc = componentIdOrDoc;
    componentId = typeof docOrOptions === 'string' ? docOrOptions : docOrOptions?.componentId || null;
    returnEnvelope = true;
  } else {
    componentId = componentIdOrDoc;
    doc = docOrOptions;
  }

  const merged = {};
  for (const [id, contract] of Object.entries(CORE_COMPONENT_CONTRACTS)) {
    const customContract = doc?.components?.[id]?.contract;
    merged[id] = customContract
      ? { ...structuredClone(contract), ...structuredClone(customContract) }
      : structuredClone(contract);
  }
  if (doc?.components) {
    for (const [id, compDef] of Object.entries(doc.components)) {
      if (!merged[id] && compDef.contract) {
        merged[id] = structuredClone(compDef.contract);
      }
    }
  }
  if (returnEnvelope) {
    if (componentId) {
      const c = merged[componentId] || null;
      return {
        count: c ? 1 : 0,
        componentId,
        contract: c,
        contracts: c ? { [componentId]: c } : {},
      };
    }
    return {
      count: Object.keys(merged).length,
      contracts: merged,
    };
  }
  if (componentId) {
    return merged[componentId] || null;
  }
  return merged;
}

export function ensureCoreComponentsRegistered(doc, componentIds = null) {
  if (!doc.components) doc.components = {};
  const ids = Array.isArray(componentIds) && componentIds.length > 0
    ? componentIds
    : Object.keys(CORE_COMPONENT_CONTRACTS);
  const registered = [];
  for (const id of ids) {
    const contract = CORE_COMPONENT_CONTRACTS[id];
    if (!contract) continue;
    if (!doc.components[id]) {
      doc.components[id] = {
        ...structuredClone(contract.definition),
        contract: {
          componentId: contract.componentId,
          version: contract.version,
          title: contract.title,
          category: contract.category,
          parameters: structuredClone(contract.parameters),
          slots: structuredClone(contract.slots),
          allowedOverrides: [...contract.allowedOverrides],
          lockedInternalStructure: contract.lockedInternalStructure,
          sizingContract: structuredClone(contract.sizingContract),
          states: structuredClone(contract.states),
          events: structuredClone(contract.events),
          deprecatedParameters: {},
        },
      };
      registered.push(id);
    }
  }
  return registered;
}

export function validateComponentInstanceAgainstContract(instanceNode, doc, { strict = true } = {}) {
  const compId = instanceNode?.component || instanceNode?.componentId;
  const contract = getComponentContracts(compId, doc);
  if (!contract) {
    return { valid: true, errors: [], warnings: [], staleOverrides: [] };
  }

  const errors = [];
  const warnings = [];
  const staleOverrides = [];
  const parameters = contract.parameters || {};
  const deprecatedParams = contract.deprecatedParameters || doc?.components?.[compId]?.contract?.deprecatedParameters || {};
  const allowedSet = new Set([
    ...(contract.allowedOverrides || []),
    ...Object.keys(parameters),
    '$root',
    '_self',
  ]);

  // 1. Validate state
  if (instanceNode.state !== undefined && instanceNode.state !== null) {
    const validStates = Object.keys(contract.states || { default: {} });
    if (!validStates.includes(instanceNode.state)) {
      errors.push({
        code: 'E_COMPONENT_CONTRACT',
        reason: 'invalid-state',
        componentId: compId,
        instanceId: instanceNode.id,
        state: instanceNode.state,
        allowedStates: validStates,
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 使用了未定义的状态 "${instanceNode.state}"（允许状态: ${validStates.join(', ')}）`,
      });
    }
  }

  // 2. Validate variant
  if (instanceNode.variant !== undefined && instanceNode.variant !== null) {
    const compDef = doc?.components?.[compId] || contract.definition;
    const validVariants = Object.keys(compDef?.variants || { default: {} });
    if (validVariants.length > 0 && !validVariants.includes(instanceNode.variant)) {
      errors.push({
        code: 'E_COMPONENT_CONTRACT',
        reason: 'invalid-variant',
        componentId: compId,
        instanceId: instanceNode.id,
        variant: instanceNode.variant,
        allowedVariants: validVariants,
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 使用了未知变体 "${instanceNode.variant}"（允许变体: ${validVariants.join(', ')}）`,
      });
    }
  }

  // 3. Validate props against parameter schema
  const props = instanceNode.props || {};
  for (const [pKey, pVal] of Object.entries(props)) {
    if (deprecatedParams[pKey]) {
      const stale = {
        code: 'E_STALE_OVERRIDE',
        reason: 'removed-parameter',
        componentId: compId,
        instanceId: instanceNode.id,
        parameter: pKey,
        removedInVersion: deprecatedParams[pKey].removedInVersion || contract.version,
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 包含已废弃/移除的旧参数 "${pKey}"（于版本 ${deprecatedParams[pKey].removedInVersion || contract.version} 移除）`,
      };
      staleOverrides.push(stale);
      warnings.push(stale);
      continue;
    }

    const pSchema = parameters[pKey];
    if (!pSchema) {
      errors.push({
        code: 'E_COMPONENT_CONTRACT',
        reason: 'unknown-parameter',
        componentId: compId,
        instanceId: instanceNode.id,
        parameter: pKey,
        allowedParameters: Object.keys(parameters),
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 传入了契约未定义的参数 "${pKey}"（允许参数: ${Object.keys(parameters).join(', ')}）`,
      });
      continue;
    }

    if (pSchema.type === 'string' && typeof pVal !== 'string') {
      errors.push({
        code: 'E_COMPONENT_CONTRACT',
        reason: 'invalid-parameter-type',
        componentId: compId,
        instanceId: instanceNode.id,
        parameter: pKey,
        expectedType: 'string',
        actualType: typeof pVal,
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 参数 "${pKey}" 类型错误：期望 string，实际为 ${typeof pVal}`,
      });
    } else if (pSchema.type === 'string' && (
      (pSchema.minLength !== undefined && [...pVal].length < pSchema.minLength) ||
      (pSchema.maxLength !== undefined && [...pVal].length > pSchema.maxLength)
    )) {
      errors.push({
        code: 'E_COMPONENT_CONTRACT', reason: 'invalid-parameter-length',
        componentId: compId, instanceId: instanceNode.id, parameter: pKey,
        minLength: pSchema.minLength ?? 0, maxLength: pSchema.maxLength ?? null,
        actualLength: [...pVal].length,
        message: `组件 "${compId}" 参数 "${pKey}" 长度 ${[...pVal].length} 超出允许范围 ${pSchema.minLength ?? 0}—${pSchema.maxLength ?? '不限'}（按 Unicode 码点计数）`,
      });
    } else if (pSchema.type === 'enum' && Array.isArray(pSchema.enum) && !pSchema.enum.includes(pVal)) {
      errors.push({
        code: 'E_COMPONENT_CONTRACT',
        reason: 'invalid-enum-value',
        componentId: compId,
        instanceId: instanceNode.id,
        parameter: pKey,
        value: pVal,
        allowedValues: pSchema.enum,
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 参数 "${pKey}" 值 "${pVal}" 不在允许枚举 [${pSchema.enum.join(', ')}] 内`,
      });
    }
  }

  // 4. Validate overrides against allowedOverrides & lockedInternalStructure
  const overrides = instanceNode.overrides || {};
  const parameterOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (parameters[key]) parameterOverrides[key] = value;
    for (const [name, schema] of Object.entries(parameters)) {
      if (schema.targetSubNodeId === key && value && typeof value === 'object' && schema.targetProp in value) parameterOverrides[name] = value[schema.targetProp];
    }
  }
  if (Object.keys(parameterOverrides).length) {
    const checked = validateComponentInstanceAgainstContract({ ...instanceNode, props: parameterOverrides, overrides: {}, slots: {} }, doc, { strict: false });
    errors.push(...checked.errors.map(error => ({ ...error, source: 'override' })));
  }
  for (const [ovrKey, ovrVal] of Object.entries(overrides)) {
    if (deprecatedParams[ovrKey]) {
      const stale = {
        code: 'E_STALE_OVERRIDE',
        reason: 'removed-override-target',
        componentId: compId,
        instanceId: instanceNode.id,
        target: ovrKey,
        removedInVersion: deprecatedParams[ovrKey].removedInVersion || contract.version,
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 覆盖了已移除的参数或子结构 "${ovrKey}"`,
      };
      staleOverrides.push(stale);
      warnings.push(stale);
      continue;
    }

    if (!allowedSet.has(ovrKey)) {
      errors.push({
        code: 'E_COMPONENT_CONTRACT',
        reason: 'disallowed-override-target',
        componentId: compId,
        instanceId: instanceNode.id,
        target: ovrKey,
        allowedOverrides: [...allowedSet],
        message: `组件 "${compId}" 实例 "${instanceNode.id}" 试图覆盖未开放的内部节点或参数 "${ovrKey}"`,
      });
      continue;
    }

    if (contract.lockedInternalStructure && ovrVal && typeof ovrVal === 'object') {
      if (ovrVal._delete === true || Array.isArray(ovrVal.children)) {
        errors.push({
          code: 'E_COMPONENT_CONTRACT',
          reason: 'locked-internal-structure',
          componentId: compId,
          instanceId: instanceNode.id,
          target: ovrKey,
          message: `组件 "${compId}" 内部布局骨架受契约保护，禁止在实例 "${instanceNode.id}" 中直接删除或替换 "${ovrKey}" 的子节点树`,
        });
      }
    }
  }

  // 5. Validate slot children if slots are provided
  if (instanceNode.slots && typeof instanceNode.slots === 'object') {
    const contractSlots = contract.slots || {};
    for (const [slotId, slotItems] of Object.entries(instanceNode.slots)) {
      const slotSpec = contractSlots[slotId];
      if (!slotSpec) {
        errors.push({
          code: 'E_COMPONENT_CONTRACT',
          reason: 'unknown-slot',
          componentId: compId,
          instanceId: instanceNode.id,
          slotId,
          allowedSlots: Object.keys(contractSlots),
          message: `组件 "${compId}" 实例 "${instanceNode.id}" 使用了未定义的插槽 "${slotId}"`,
        });
        continue;
      }
      const list = Array.isArray(slotItems) ? slotItems : [slotItems];
      if (typeof slotSpec.maxCount === 'number' && list.length > slotSpec.maxCount) {
        errors.push({
          code: 'E_COMPONENT_CONTRACT',
          reason: 'slot-max-count-exceeded',
          componentId: compId,
          instanceId: instanceNode.id,
          slotId,
          count: list.length,
          maxCount: slotSpec.maxCount,
          message: `组件 "${compId}" 实例 "${instanceNode.id}" 插槽 "${slotId}" 节点数 (${list.length}) 超过上限 (${slotSpec.maxCount})`,
        });
      }
      for (const item of list) {
        if (item?.type && Array.isArray(slotSpec.allowedNodeTypes) && !slotSpec.allowedNodeTypes.includes(item.type)) {
          errors.push({
            code: 'E_COMPONENT_CONTRACT',
            reason: 'invalid-slot-node-type',
            componentId: compId,
            instanceId: instanceNode.id,
            slotId,
            nodeType: item.type,
            allowedNodeTypes: slotSpec.allowedNodeTypes,
            message: `组件 "${compId}" 实例 "${instanceNode.id}" 插槽 "${slotId}" 不允许放入 "${item.type}" 类型节点（仅允许: ${slotSpec.allowedNodeTypes.join(', ')}）`,
          });
        }
      }
    }
  }

  if (strict && errors.length > 0) {
    const first = errors[0];
    throw Object.assign(new Error(first.message), {
      code: first.code,
      componentId: compId,
      instanceId: instanceNode.id,
      reason: first.reason,
      errors,
      staleOverrides,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    staleOverrides,
  };
}

export function resolveContractPropsAndStateOverrides(instanceNode, compDef, doc = null) {
  const compId = instanceNode?.component || instanceNode?.componentId || compDef?.id;
  const contract = getComponentContracts(compId, doc);
  if (!contract) return { mappedOverrides: {}, stateInteractive: true };

  const parameters = contract.parameters || {};
  const mappedOverrides = {};

  const assignSubOverride = (subId, prop, val) => {
    if (!subId || !prop) return;
    if (!mappedOverrides[subId]) mappedOverrides[subId] = {};
    mappedOverrides[subId][prop] = structuredClone(val);
  };

  // 1. Apply parameter defaults first if parameter targetSubNodeId is defined
  for (const [pKey, pSchema] of Object.entries(parameters)) {
    if (pSchema.default !== undefined && pSchema.targetSubNodeId && pSchema.targetProp) {
      assignSubOverride(pSchema.targetSubNodeId, pSchema.targetProp, pSchema.default);
    }
  }

  // 2. Apply state overrides from contract
  const stateName = instanceNode.state || 'default';
  const stateSpec = contract.states?.[stateName];
  const stateInteractive = stateSpec?.interactive !== false;
  if (stateSpec?.overrides && typeof stateSpec.overrides === 'object') {
    for (const [subId, ovrObj] of Object.entries(stateSpec.overrides)) {
      if (!mappedOverrides[subId]) mappedOverrides[subId] = {};
      Object.assign(mappedOverrides[subId], structuredClone(ovrObj));
    }
  }

  // 3. Apply instance.props mapped via parameter schema
  const props = instanceNode.props || {};
  for (const [pKey, pVal] of Object.entries(props)) {
    const pSchema = parameters[pKey];
    if (pSchema?.targetSubNodeId && pSchema?.targetProp) {
      assignSubOverride(pSchema.targetSubNodeId, pSchema.targetProp, pVal);
      if (pKey === 'badgeText' && pSchema.targetSubNodeId === 'btn_badge') {
        assignSubOverride('btn_badge', 'visible', Boolean(pVal));
      }
    }
  }

  // 4. Also allow parameter names directly inside instanceNode.overrides
  const rawOverrides = instanceNode.overrides || {};
  for (const [oKey, oVal] of Object.entries(rawOverrides)) {
    const pSchema = parameters[oKey];
    if (pSchema?.targetSubNodeId && pSchema?.targetProp && (typeof oVal !== 'object' || oVal === null)) {
      assignSubOverride(pSchema.targetSubNodeId, pSchema.targetProp, oVal);
    }
  }

  return {
    mappedOverrides,
    stateInteractive,
    contractVersion: contract.version,
  };
}

export function evolveComponentContractOnDocument(doc, {
  componentId,
  newVersion = '2.0.0',
  addedParameters = {},
  renamedParameters = {},
  removedParameters = [],
  rootPatch = null,
} = {}) {
  ensureCoreComponentsRegistered(doc, [componentId]);
  const compDef = doc.components?.[componentId];
  if (!compDef) {
    throw Object.assign(new Error(`未找到组件定义 "${componentId}"`), {
      code: 'E_COMPONENT_NOT_FOUND',
      componentId,
    });
  }

  const baseContract = getComponentContracts(componentId, doc) || {
    componentId,
    version: '1.0.0',
    parameters: {},
    allowedOverrides: ['$root'],
    deprecatedParameters: {},
  };

  const nextContract = structuredClone(baseContract);
  nextContract.version = newVersion;
  nextContract.parameters = nextContract.parameters || {};
  nextContract.allowedOverrides = Array.isArray(nextContract.allowedOverrides)
    ? [...nextContract.allowedOverrides]
    : ['$root'];
  nextContract.deprecatedParameters = nextContract.deprecatedParameters || {};

  // 1. Apply addedParameters
  for (const [pName, pSpec] of Object.entries(addedParameters || {})) {
    nextContract.parameters[pName] = {
      type: pSpec.type || 'string',
      required: Boolean(pSpec.required),
      default: pSpec.default ?? '',
      targetSubNodeId: pSpec.targetSubNodeId || '$root',
      targetProp: pSpec.targetProp || 'text',
      description: pSpec.description || pName,
    };
    if (!nextContract.allowedOverrides.includes(pName)) {
      nextContract.allowedOverrides.push(pName);
    }
    if (pSpec.targetSubNodeId && !nextContract.allowedOverrides.includes(pSpec.targetSubNodeId)) {
      nextContract.allowedOverrides.push(pSpec.targetSubNodeId);
    }
  }

  // 2. Apply renamedParameters
  for (const [oldName, newName] of Object.entries(renamedParameters || {})) {
    const existingSpec = nextContract.parameters[oldName] || {
      type: 'string',
      required: false,
      default: '',
      targetSubNodeId: oldName,
      targetProp: 'text',
    };
    nextContract.parameters[newName] = {
      ...structuredClone(existingSpec),
      renamedFrom: oldName,
    };
    delete nextContract.parameters[oldName];
    nextContract.allowedOverrides = nextContract.allowedOverrides.filter(k => k !== oldName);
    if (!nextContract.allowedOverrides.includes(newName)) {
      nextContract.allowedOverrides.push(newName);
    }
  }

  // 3. Apply removedParameters
  for (const remName of removedParameters || []) {
    const oldSpec = nextContract.parameters[remName];
    nextContract.deprecatedParameters[remName] = {
      removedInVersion: newVersion,
      previousSpec: oldSpec ? structuredClone(oldSpec) : null,
    };
    delete nextContract.parameters[remName];
    nextContract.allowedOverrides = nextContract.allowedOverrides.filter(k => k !== remName);
  }

  if (rootPatch && typeof rootPatch === 'object') {
    Object.assign(compDef.root, structuredClone(rootPatch));
  }

  compDef.contractVersion = newVersion;
  compDef.contract = nextContract;

  // Traverse all pages and component definitions to migrate renamed parameters, populate new defaults, and detect stale overrides
  const migratedInstances = [];
  const staleOverrideDiagnostics = [];

  function visitNode(node, pageId) {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'instance' || node.type === 'use') && (node.component === componentId || node.componentId === componentId)) {
      node.props = node.props || {};
      node.overrides = node.overrides || {};

      // Migrate renamed parameters
      for (const [oldName, newName] of Object.entries(renamedParameters || {})) {
        if (node.props[oldName] !== undefined) {
          node.props[newName] = node.props[oldName];
          delete node.props[oldName];
          migratedInstances.push({ pageId, instanceId: node.id, action: 'renamed-prop', from: oldName, to: newName });
        }
        if (node.overrides[oldName] !== undefined) {
          node.overrides[newName] = node.overrides[oldName];
          delete node.overrides[oldName];
          migratedInstances.push({ pageId, instanceId: node.id, action: 'renamed-override', from: oldName, to: newName });
        }
      }

      // Populate added parameter defaults if not present
      for (const [pName, pSpec] of Object.entries(addedParameters || {})) {
        if (node.props[pName] === undefined && pSpec.default !== undefined) {
          node.props[pName] = structuredClone(pSpec.default);
          migratedInstances.push({ pageId, instanceId: node.id, action: 'added-default-prop', parameter: pName, value: pSpec.default });
        }
      }

      // Check removed parameters for stale overrides (do NOT silently drop!)
      for (const remName of removedParameters || []) {
        if (node.props[remName] !== undefined || node.overrides[remName] !== undefined) {
          staleOverrideDiagnostics.push({
            code: 'E_STALE_OVERRIDE',
            severity: 'warning',
            pageId,
            instanceId: node.id,
            scopedId: `${pageId}/${node.id}`,
            componentId,
            parameter: remName,
            removedInVersion: newVersion,
            message: `实例 "${pageId}/${node.id}" 存在对已移除参数 "${remName}" 的失效覆盖（组件 "${componentId}" 已升级至 v${newVersion}）`,
          });
        }
      }
    }

    for (const ch of node.children || []) visitNode(ch, pageId);
    for (const st of node.states || []) if (st.root) visitNode(st.root, `${pageId}/${node.id}:${st.id}`);
    if (node.template) visitNode(node.template, `${pageId}/${node.id}:template`);
    for (const [name, content] of Object.entries(node.slots || {})) {
      for (const child of Array.isArray(content) ? content : [content]) visitNode(child, `${pageId}/${node.id}:slot:${name}`);
    }
  }

  for (const pg of doc.pages || []) {
    visitNode(pg.root, pg.id);
  }
  for (const [id, definition] of Object.entries(doc.components || {})) {
    visitNode(definition.root, `component:${id}`);
  }

  doc.diagnostics = (doc.diagnostics || []).filter(
    d => !(d.code === 'E_STALE_OVERRIDE' && d.componentId === componentId)
  );
  doc.diagnostics.push(...staleOverrideDiagnostics);

  return {
    componentId,
    newVersion,
    migratedInstances,
    staleOverrideDiagnostics,
    contract: nextContract,
  };
}
