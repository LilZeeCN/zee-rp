// General Multi-Domain Visual Exploration Engine for zee-rp Free Canvas Studio (Direction 1)
// Transforms structured DesignBrief + existing page semantics into 3 structurally distinct,
// editable, layout-validated candidate exploration schemes across 6 explicit design axes,
// supporting both full-page adoption and partial-region (sectionRole / regionNodeId) adoption.

import { resolveDocumentScene } from './scene-resolver.mjs';
import { ensureCoreComponentsRegistered } from './component-contracts.mjs';
import { DEVICE_PRESETS } from './document.mjs';

export const EXPLORATION_AXES = [
  'layoutStructure',
  'informationDensity',
  'navigationForm',
  'visualHierarchy',
  'typographyPairing',
  'colorMood',
];

function extractTextsAndLinksFromPage(basePage, doc) {
  const texts = [];
  const images = [];
  const links = [];
  const existingNodeIds = new Set();

  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.id) existingNodeIds.add(n.id);
    const t = n.text || n.props?.title || n.props?.label || n.props?.headline;
    if (typeof t === 'string' && t.trim() && !t.startsWith('=')) {
      texts.push({ id: n.id, type: n.type, text: t.trim(), subtitle: n.props?.subtitle || n.props?.summary || '' });
    }
    if (n.type === 'image' && n.src) {
      images.push({ id: n.id, src: n.src });
    }
    if (n.on?.click) {
      const acts = Array.isArray(n.on.click) ? n.on.click : [];
      for (const a of acts) {
        if (a?.type === 'link' && a.page) {
          links.push({ fromNodeId: n.id, page: a.page });
        }
      }
    }
    for (const ch of n.children || []) walk(ch);
  }
  walk(basePage?.root);

  const validPageIds = new Set((doc?.pages || []).map(p => p.id));
  const fallbackTargetPage =
    links.find(l => validPageIds.has(l.page))?.page ||
    (doc?.pages || []).find(p => p.id !== basePage?.id)?.id ||
    basePage?.id ||
    'home';

  return { texts, images, links, existingNodeIds, validPageIds, fallbackTargetPage };
}

export function normalizeDesignBrief(rawBrief = {}, basePage = null, doc = null) {
  const briefObj = typeof rawBrief === 'string'
    ? { pageGoal: rawBrief.trim(), heroTitle: rawBrief.trim(), navTitle: rawBrief.trim(), isCustomBrief: true }
    : (rawBrief || {});

  const extracted = extractTextsAndLinksFromPage(basePage, doc);
  const dsRows = Object.values(doc?.datasets || {})[0]?.rows || [];

  const isLegacyQiyu = extracted.existingNodeIds.has('whiteeye_card') || extracted.images.some(img => String(img.src).includes('kingfisher'));

  const hasCustomBriefContent = Boolean(
    briefObj.isCustomBrief ||
    briefObj.projectName ||
    briefObj.pageGoal ||
    briefObj.goal ||
    briefObj.targetTask ||
    briefObj.primaryEntity ||
    briefObj.targetAudience ||
    (briefObj.domain && !['birding', 'birding-qiyu'].includes(briefObj.domain) && briefObj.domain !== (doc?.domainPreset || doc?.meta?.domain))
  );

  const pageGoal =
    briefObj.pageGoal ||
    briefObj.goal ||
    briefObj.targetTask ||
    `${briefObj.projectName || doc?.name || '应用'} · ${basePage?.name || '核心工作台'}视觉与信息架构探索`;

  const primaryActionTarget =
    briefObj.primaryAction?.targetPage ||
    (extracted.validPageIds.has('list') ? 'list' : extracted.fallbackTargetPage);

  const entityLabel = briefObj.primaryEntity || '核心条目';
  const audienceLabel = briefObj.targetAudience || '目标用户';

  const primaryAction = {
    label: briefObj.primaryAction?.label || (briefObj.primaryEntity ? `立即办理${briefObj.primaryEntity}` : '立即进入主流程'),
    secondaryLabel: briefObj.primaryAction?.secondaryLabel || '快速检索',
    targetPage: primaryActionTarget,
  };

  const defaultItems = hasCustomBriefContent
    ? [
        {
          id: 'item_1',
          title: `${briefObj.projectName || pageGoal} · 重点${entityLabel} 01`,
          subtitle: `面向${audienceLabel} · ${briefObj.styleTone || '高优推荐'} · 实时状态正常`,
          badge: '重点推荐',
        },
        {
          id: 'item_2',
          title: `${briefObj.projectName || pageGoal} · 常用${entityLabel} 02`,
          subtitle: `支持在线筛选与详情核验 · 响应就绪`,
          badge: '即时可用',
        },
        {
          id: 'item_3',
          title: `${briefObj.projectName || pageGoal} · 归档${entityLabel} 03`,
          subtitle: `完整流转记录与进度追踪`,
          badge: '已核验',
        },
      ]
    : dsRows.length >= 2
    ? dsRows.slice(0, 3).map((r, i) => ({
        id: r.id || `item_${i + 1}`,
        title: String(r.title || r.name || `核心条目 ${i + 1}`),
        subtitle: String(r.subtitle || r.desc || r.location || '状态正常 · 已同步'),
        badge: String(r.badge || r.status || '重点'),
      }))
    : [
        {
          id: 'item_1',
          title: extracted.texts[1]?.text || '重点核心条目一',
          subtitle: extracted.texts[1]?.subtitle || '优先级高 · 实时同步就绪',
          badge: '重点推荐',
        },
        {
          id: 'item_2',
          title: extracted.texts[2]?.text || '重点核心条目二',
          subtitle: extracted.texts[2]?.subtitle || '支持筛选与详情联动核验',
          badge: '常规条目',
        },
        {
          id: 'item_3',
          title: extracted.texts[3]?.text || '重点核心条目三',
          subtitle: extracted.texts[3]?.subtitle || '完整记录归档与快速访问',
          badge: '已核验',
        },
      ];

  const requiredContent = Array.isArray(briefObj.requiredContent) && briefObj.requiredContent.length > 0
    ? briefObj.requiredContent
    : [
        {
          role: 'navigation',
          title: briefObj.navTitle || briefObj.projectName || (!hasCustomBriefContent && extracted.texts[0]?.text) || doc?.name || '工作台首页',
          subtitle: briefObj.navSubtitle || (briefObj.styleTone ? `${briefObj.styleTone} · 实时同步` : '实时同步中 · 正常'),
        },
        {
          role: 'hero',
          tag: briefObj.heroTag || briefObj.styleTone || '核心专题',
          title: briefObj.heroTitle || (hasCustomBriefContent ? pageGoal : (extracted.texts[1]?.text || pageGoal)),
          summary: briefObj.heroSummary || (hasCustomBriefContent ? `围绕「${pageGoal}」为${audienceLabel}提供高频${entityLabel}直达入口与清晰状态反馈。` : '聚合关键业务指标、高频操作入口与精选内容流，兼顾浏览效率与操作直达性。'),
          meta: briefObj.heroMeta || `共 ${defaultItems.length} 项${entityLabel}`,
          imageSrc: briefObj.heroImageSrc || extracted.images[0]?.src || null,
        },
        {
          role: 'quick-action',
          label: primaryAction.label,
          secondaryLabel: primaryAction.secondaryLabel,
          placeholder: briefObj.searchPlaceholder || `输入${entityLabel}名称、编号或标签快速过滤…`,
          chips: briefObj.filterChips || ['全部记录', '重点优先', '最近更新'],
        },
        {
          role: 'content-list',
          items: defaultItems,
        },
      ];

  return {
    domainId: briefObj.domain || briefObj.domainId || doc?.domainId || (isLegacyQiyu ? 'birding-qiyu' : 'general'),
    isLegacyQiyu: isLegacyQiyu && !hasCustomBriefContent,
    pageGoal,
    primaryAction,
    requiredContent,
    informationPriority: briefObj.informationPriority || ['hero', 'quick-action', 'content-list', 'navigation'],
    brandConstraints: {
      editorialFont: 'Songti SC',
      sansFont: 'PingFang SC',
      monoFont: 'Menlo',
      latinFont: 'Helvetica Neue',
      ...(briefObj.brandConstraints || {}),
    },
    device: briefObj.device || basePage?.device || doc?.device || 'iphone-17-pro',
    existingComponents: briefObj.existingComponents || ['nav-bar', 'info-card', 'list-item', 'button', 'input-field', 'status-zone'],
    validPageIds: [...extracted.validPageIds],
    fallbackTargetPage: extracted.fallbackTargetPage,
  };
}

function resolveSafePageLink(candidatePage, brief) {
  if (candidatePage && brief.validPageIds.includes(candidatePage)) {
    return candidatePage;
  }
  return brief.fallbackTargetPage;
}

export function generateGeneralExplorations(basePage, doc, rawBrief = {}) {
  ensureCoreComponentsRegistered(doc);
  const brief = normalizeDesignBrief(rawBrief, basePage, doc);
  const navBlock = brief.requiredContent.find(c => c.role === 'navigation') || { title: doc?.name || '首页', subtitle: '在线' };
  const heroBlock = brief.requiredContent.find(c => c.role === 'hero') || {
    tag: '重点焦点',
    title: brief.pageGoal,
    summary: '结构化视觉探索方案',
    meta: '实时同步',
  };
  const actionBlock = brief.requiredContent.find(c => c.role === 'quick-action') || {
    label: brief.primaryAction.label,
    secondaryLabel: brief.primaryAction.secondaryLabel,
    placeholder: '搜索关键词…',
    chips: ['全部', '精选', '最新'],
  };
  const listBlock = brief.requiredContent.find(c => c.role === 'content-list') || { items: [] };
  const items = listBlock.items?.length >= 1
    ? structuredClone(listBlock.items)
    : [{ id: 'empty-list', title: '', subtitle: '', badge: '' }];
  // The templates access up to three items; repeat a supplied item rather than
  // inventing business data. Explicit lists are rendered at their actual size below.
  while (items.length < 3) items.push(items[0]);

  const targetMainPage = resolveSafePageLink(brief.primaryAction.targetPage, brief);
  const targetDetailPage = resolveSafePageLink(
    brief.validPageIds.includes('detail') ? 'detail' : brief.validPageIds.includes('species') ? 'species' : targetMainPage,
    brief
  );
  const targetSpotPage = resolveSafePageLink(
    brief.validPageIds.includes('spot') ? 'spot' : brief.validPageIds.includes('list') ? 'list' : targetMainPage,
    brief
  );
  const targetIdentifyPage = resolveSafePageLink(
    brief.validPageIds.includes('identify') ? 'identify' : targetMainPage,
    brief
  );

  // ============================================================================
  // Scheme A: 沉浸杂志画报流 (Editorial Story Stream)
  // - layoutStructure: single-column-editorial-stream
  // - informationDensity: spacious-editorial-breathing (padding 20, gap 14)
  // - navigationForm: minimal-masthead-plus-bottom-bar
  // - visualHierarchy: serif-typography-led (Songti SC 24px title + large hero card)
  // - typographyPairing: Songti SC (Headings) + PingFang SC (Body)
  // - colorMood: warm-editorial-paper
  // ============================================================================
  const expA = {
    id: `${basePage.id}_exp_editorial`,
    name: '方案 A · 沉浸杂志画报流',
    device: brief.device,
    domain: doc?.domain || 'mobile',
    explorationOf: basePage.id,
    explorationMeta: {
      direction: 'editorial-magazine',
      designBriefSummary: brief.pageGoal,
      rationale: '采用单列舒展留白结构与衬线标题（Songti SC）主导视觉层级，首屏优先呈现核心主题深度卡片，下方配双栏精选摘要，适合内容阅读与品牌沉浸。',
      axes: {
        layoutStructure: 'single-column-editorial-stream',
        informationDensity: 'spacious-editorial-breathing',
        navigationForm: 'minimal-masthead-header',
        visualHierarchy: 'serif-typography-led',
        typographyPairing: 'Songti SC + PingFang SC',
        colorMood: 'warm-editorial-paper',
      },
      structuralFeatures: {
        primaryHeroType: 'editorial-cover-poster',
        moduleOrder: ['navigation', 'hero', 'content-list', 'quick-action'],
        firstScreenPriority: 'deep-content-reading',
        imageToTextRatio: 0.65,
        cardOrganization: 'single-hero-plus-dual-grid',
        rootPadding: 20,
        rootGap: 14,
      },
    },
    canvas: { x: 0, y: 80, w: 402, h: 874 },
    root: {
      type: 'phone-shell',
      id: `${basePage.id}_exp_editorial_shell`,
      device: brief.device,
      statusBar: false,
      fill: '$bg',
      darkIsland: true,
      children: [
        {
          type: 'box',
          id: `${basePage.id}_exp_editorial_screen`,
          layout: 'column',
          w: 402,
          h: 874,
          padding: [DEVICE_PRESETS[brief.device]?.safeAreaTop ?? 60, 20, 20, 20],
          gap: 14,
          fill: '$bg',
          children: [
            {
              id: 'sec_nav_editorial',
              type: 'box',
              sectionRole: 'navigation',
              layout: 'column',
              w: 'fill',
              h: 'hug',
              gap: 4,
              children: [
                {
                  id: 'wordmark',
                  type: 'label',
                  text: `ISSUE FEATURE · ${navBlock.title}`,
                  w: 'fill',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 1,
                  color: '$brand',
                },
                {
                  id: 'hero_title',
                  type: 'paragraph',
                  text: heroBlock.title,
                  w: 'fill',
                  fontFamily: 'Songti SC',
                  fontSize: 22,
                  fontWeight: 700,
                  lineHeight: 30,
                  color: '$ink',
                  wrap: true,
                },
              ],
            },
            {
              id: 'featured',
              type: 'box',
              sectionRole: 'hero',
              layout: 'column',
              w: 'fill',
              h: 'hug',
              padding: [18, 18, 18, 18],
              gap: 10,
              radius: 22,
              fill: '$surface',
              stroke: '$line',
              strokeWidth: 1,
              on: { click: [{ type: 'link', page: targetDetailPage }] },
              children: [
                ...(heroBlock.imageSrc
                  ? [{ id: 'featured_photo', type: 'image', src: heroBlock.imageSrc, w: 326, h: 168, radius: 16 }]
                  : [
                      {
                        id: 'featured_visual_banner',
                        type: 'box',
                        layout: 'row',
                        align: 'center',
                        justify: 'space-between',
                        w: 'fill',
                        h: 72,
                        padding: [14, 16, 14, 16],
                        radius: 14,
                        fill: '$brand-soft',
                        children: [
                          { id: 'banner_badge', type: 'badge', text: heroBlock.tag, fontSize: 11, fontWeight: 600, fill: '$brand', color: '#FFFFFF', radius: 10, h: 24 },
                          { id: 'banner_meta', type: 'label', text: heroBlock.meta, fontSize: 12, fontWeight: 600, color: '$brand' },
                        ],
                      },
                    ]),
                {
                  id: 'featured_title',
                  type: 'paragraph',
                  text: items[0].title,
                  w: 'fill',
                  fontFamily: 'Songti SC',
                  fontSize: 18,
                  fontWeight: 600,
                  lineHeight: 25,
                  color: '$ink',
                  wrap: true,
                },
                {
                  id: 'featured_essay',
                  type: 'paragraph',
                  text: heroBlock.summary,
                  w: 'fill',
                  fontSize: 13,
                  lineHeight: 20,
                  color: '$ink-2',
                  wrap: true,
                },
              ],
            },
            {
              id: 'editorial_bottom_row',
              type: 'box',
              sectionRole: 'content-list',
              layout: 'row',
              w: 'fill',
              h: 'hug',
              gap: 12,
              children: [
                {
                  id: 'whiteeye_card',
                  type: 'box',
                  layout: 'column',
                  flex: 1,
                  w: 'fill',
                  h: 'hug',
                  padding: [14, 14, 14, 14],
                  gap: 6,
                  radius: 16,
                  fill: '$surface-2',
                  on: { click: [{ type: 'link', page: targetSpotPage }] },
                  children: [
                    { id: 'whiteeye_badge', type: 'badge', text: items[1].badge, w: 'hug', h: 22, radius: 10, fill: '$surface', color: '$brand', fontSize: 10, fontWeight: 600 },
                    { id: 'whiteeye_title', type: 'paragraph', text: items[1].title, w: 'fill', fontSize: 14, fontWeight: 600, lineHeight: 20, color: '$ink', wrap: true },
                    { id: 'whiteeye_caption', type: 'paragraph', text: items[1].subtitle, w: 'fill', fontSize: 11, lineHeight: 16, color: '$ink-2', wrap: true },
                  ],
                },
                {
                  id: 'identify_card',
                  type: 'box',
                  layout: 'column',
                  flex: 1,
                  w: 'fill',
                  h: 'hug',
                  padding: [14, 14, 14, 14],
                  gap: 6,
                  radius: 16,
                  fill: '$surface',
                  stroke: '$line',
                  strokeWidth: 1,
                  on: { click: [{ type: 'link', page: targetIdentifyPage }] },
                  children: [
                    { id: 'inv_badge', type: 'badge', text: (items[2] || items[0]).badge, w: 'hug', h: 22, radius: 10, fill: '$brand-soft', color: '$brand', fontSize: 10, fontWeight: 600 },
                    { id: 'invitation_title', type: 'paragraph', text: (items[2] || items[0]).title, w: 'fill', fontSize: 14, fontWeight: 600, lineHeight: 20, color: '$ink', wrap: true },
                    { id: 'invitation_sub', type: 'paragraph', text: (items[2] || items[0]).subtitle, w: 'fill', fontSize: 11, lineHeight: 16, color: '$ink-2', wrap: true },
                  ],
                },
              ],
            },
            {
              id: 'sec_action_editorial',
              type: 'box',
              sectionRole: 'quick-action',
              layout: 'row',
              align: 'center',
              justify: 'space-between',
              w: 'fill',
              h: 48,
              padding: [8, 14, 8, 14],
              radius: 14,
              fill: '$surface',
              stroke: '$line',
              strokeWidth: 1,
              children: [
                { id: 'editorial_meta_hint', type: 'label', text: heroBlock.meta, fontSize: 12, color: '$ink-2' },
                {
                  id: 'identify_entry',
                  type: 'button',
                  text: actionBlock.label,
                  w: 'hug',
                  h: 34,
                  radius: 10,
                  fill: '$brand',
                  color: '#FFFFFF',
                  fontSize: 12,
                  fontWeight: 600,
                  on: { click: [{ type: 'link', page: targetIdentifyPage }] },
                },
              ],
            },
          ],
        },
      ],
    },
    interactions: [],
  };

  // ============================================================================
  // Scheme B: 高效检索与工具流 (Utility Filter & Structured Rows)
  // - layoutStructure: utility-header-radar-and-rows
  // - informationDensity: compact-high-density (padding 14, gap 10)
  // - navigationForm: segmented-filter-pills
  // - visualHierarchy: structured-card-led
  // - typographyPairing: PingFang SC + Helvetica Neue
  // - colorMood: crisp-utility-surface
  // ============================================================================
  const expB = {
    id: `${basePage.id}_exp_spots_tool`,
    name: '方案 B · 高效检索与工具流',
    device: brief.device,
    domain: doc?.domain || 'mobile',
    explorationOf: basePage.id,
    explorationMeta: {
      direction: 'nearby-spots-utility',
      designBriefSummary: brief.pageGoal,
      rationale: '将搜索过滤、分类胶囊与高密度结构化列表提至首屏最上方，压缩装饰高度，让用户在首屏即可完成筛选、对比与直达操作。',
      axes: {
        layoutStructure: 'utility-header-radar-and-rows',
        informationDensity: 'compact-high-density',
        navigationForm: 'segmented-filter-pills',
        visualHierarchy: 'structured-card-led',
        typographyPairing: 'PingFang SC + Helvetica Neue',
        colorMood: 'crisp-utility-surface',
      },
      structuralFeatures: {
        primaryHeroType: 'search-and-filter-command-bar',
        moduleOrder: ['navigation', 'quick-action', 'hero', 'content-list'],
        firstScreenPriority: 'fast-filtering-and-triage',
        imageToTextRatio: 0.3,
        cardOrganization: 'vertical-structured-list-items',
        rootPadding: 14,
        rootGap: 10,
      },
    },
    canvas: { x: 0, y: 80, w: 402, h: 874 },
    root: {
      type: 'phone-shell',
      id: `${basePage.id}_exp_spots_shell`,
      device: brief.device,
      statusBar: false,
      fill: '$bg',
      darkIsland: true,
      children: [
        {
          type: 'box',
          id: `${basePage.id}_exp_spots_screen`,
          layout: 'column',
          w: 402,
          h: 874,
          padding: [DEVICE_PRESETS[brief.device]?.safeAreaTop ?? 60, 14, 16, 14],
          gap: 10,
          fill: '$bg',
          children: [
            {
              id: 'sec_nav_utility',
              type: 'instance',
              sectionRole: 'navigation',
              component: 'nav-bar',
              state: 'default',
              props: {
                title: navBlock.title,
                subtitle: navBlock.subtitle,
                rightActionText: actionBlock.secondaryLabel,
              },
              on: { click: [{ type: 'link', page: targetMainPage }] },
            },
            {
              id: 'sec_action_utility',
              type: 'box',
              sectionRole: 'quick-action',
              layout: 'column',
              w: 'fill',
              h: 'hug',
              padding: [10, 12, 10, 12],
              gap: 8,
              radius: 14,
              fill: '$surface',
              stroke: '$line',
              strokeWidth: 1,
              children: [
                {
                  id: 'search_bar_row',
                  type: 'box',
                  layout: 'row',
                  align: 'center',
                  justify: 'space-between',
                  w: 'fill',
                  h: 36,
                  padding: [6, 12, 6, 12],
                  radius: 10,
                  fill: '$surface-2',
                  children: [
                    { id: 'search_hint', type: 'label', text: actionBlock.placeholder, fontSize: 12, color: '$ink-2' },
                    {
                      id: 'identify_entry',
                      type: 'button',
                      text: actionBlock.label,
                      w: 'hug',
                      h: 28,
                      radius: 8,
                      fill: '$brand',
                      color: '#FFFFFF',
                      fontSize: 11,
                      fontWeight: 600,
                      on: { click: [{ type: 'link', page: targetIdentifyPage }] },
                    },
                  ],
                },
                {
                  id: 'filter_chips_row',
                  type: 'box',
                  layout: 'row',
                  w: 'fill',
                  h: 28,
                  gap: 8,
                  children: (actionBlock.chips || ['全部', '重点', '最新']).slice(0, 3).map((chipText, idx) => ({
                    id: `chip_${idx + 1}`,
                    type: 'badge',
                    text: chipText,
                    w: 'hug',
                    h: 26,
                    radius: 13,
                    fill: idx === 0 ? '$brand' : '$surface-2',
                    color: idx === 0 ? '#FFFFFF' : '$brand',
                    fontSize: 11,
                    fontWeight: 600,
                  })),
                },
              ],
            },
            {
              id: 'radar_map_box',
              type: 'box',
              sectionRole: 'hero',
              layout: 'row',
              align: 'center',
              justify: 'space-between',
              w: 'fill',
              h: 'hug',
              padding: [12, 14, 12, 14],
              gap: 10,
              radius: 14,
              fill: '$brand-soft',
              children: [
                {
                  id: 'radar_info_col',
                  type: 'box',
                  layout: 'column',
                  flex: 1,
                  w: 'fill',
                  h: 'hug',
                  gap: 4,
                  children: [
                    { id: 'hero_title', type: 'paragraph', text: heroBlock.title, w: 'fill', fontSize: 15, fontWeight: 600, lineHeight: 21, color: '$ink', wrap: true },
                    { id: 'radar_summary', type: 'paragraph', text: heroBlock.summary, w: 'fill', h: 'hug', wrap: true, fontSize: 13, color: '$muted' },
                    { id: 'radar_sub', type: 'label', text: heroBlock.meta, fontFamily: 'Helvetica Neue', fontSize: 12, color: '$brand' },
                  ],
                },
                { id: 'radar_tag_pill', type: 'badge', text: heroBlock.tag, w: 'hug', h: 26, radius: 13, fill: '$brand', color: '#FFFFFF', fontSize: 11, fontWeight: 600 },
              ],
            },
            {
              id: 'tool_species_list',
              type: 'box',
              sectionRole: 'content-list',
              layout: 'column',
              w: 'fill',
              h: 'hug',
              gap: 8,
              children: [
                {
                  id: 'featured',
                  type: 'instance',
                  component: 'list-item',
                  state: 'selected',
                  props: {
                    title: items[0].title,
                    subtitle: items[0].subtitle,
                    metaBadge: items[0].badge,
                    leadingIcon: 'compass',
                  },
                  on: { click: [{ type: 'link', page: targetDetailPage }] },
                },
                {
                  id: 'whiteeye_card',
                  type: 'instance',
                  component: 'list-item',
                  state: 'default',
                  props: {
                    title: items[1].title,
                    subtitle: items[1].subtitle,
                    metaBadge: items[1].badge,
                    leadingIcon: 'book',
                  },
                  on: { click: [{ type: 'link', page: targetSpotPage }] },
                },
                {
                  id: 'egret_card',
                  type: 'instance',
                  component: 'list-item',
                  state: 'default',
                  props: {
                    title: (items[2] || items[0]).title,
                    subtitle: (items[2] || items[0]).subtitle,
                    metaBadge: (items[2] || items[0]).badge,
                    leadingIcon: 'spark',
                  },
                  on: { click: [{ type: 'link', page: targetMainPage }] },
                },
              ],
            },
          ],
        },
      ],
    },
    interactions: [],
  };

  // ============================================================================
  // Scheme C: 数据看板与快捷行动流 (Metrics Dashboard & Quick-Action Feed)
  // - layoutStructure: dashboard-banner-and-timeline
  // - informationDensity: balanced-medium-density (padding 16, gap 12)
  // - navigationForm: top-kpi-banner-plus-action-dock
  // - visualHierarchy: metrics-and-radar-led
  // - typographyPairing: Heiti SC + Menlo
  // - colorMood: deep-focus-banner
  // ============================================================================
  const expC = {
    id: `${basePage.id}_exp_journal_feed`,
    name: '方案 C · 指标看板与行动流',
    device: brief.device,
    domain: doc?.domain || 'mobile',
    explorationOf: basePage.id,
    explorationMeta: {
      direction: 'personal-field-journal',
      designBriefSummary: brief.pageGoal,
      rationale: '首屏顶部以深色高对比度指标看板与主行动按钮聚焦核心转化动作（Menlo 等宽数字指标 + Heiti SC 标题），中段结合复合信息卡片与时间流条目。',
      axes: {
        layoutStructure: 'dashboard-banner-and-timeline',
        informationDensity: 'balanced-medium-density',
        navigationForm: 'top-kpi-banner-plus-action-dock',
        visualHierarchy: 'metrics-and-radar-led',
        typographyPairing: 'Heiti SC + Menlo',
        colorMood: 'deep-focus-banner',
      },
      structuralFeatures: {
        primaryHeroType: 'kpi-metrics-and-primary-cta-banner',
        moduleOrder: ['quick-action', 'hero', 'content-list', 'navigation'],
        firstScreenPriority: 'quick-action-and-progress-tracking',
        imageToTextRatio: 0.45,
        cardOrganization: 'featured-info-card-plus-timeline',
        rootPadding: 16,
        rootGap: 12,
      },
    },
    canvas: { x: 0, y: 80, w: 402, h: 874 },
    root: {
      type: 'phone-shell',
      id: `${basePage.id}_exp_journal_shell`,
      device: brief.device,
      statusBar: false,
      fill: '$bg',
      darkIsland: true,
      children: [
        {
          type: 'box',
          id: `${basePage.id}_exp_journal_screen`,
          layout: 'column',
          w: 402,
          h: 874,
          padding: [DEVICE_PRESETS[brief.device]?.safeAreaTop ?? 60, 16, 18, 16],
          gap: 12,
          fill: '$bg',
          children: [
            {
              id: 'quick_log_banner',
              type: 'box',
              sectionRole: 'quick-action',
              layout: 'column',
              w: 'fill',
              h: 'hug',
              padding: [16, 16, 16, 16],
              gap: 10,
              radius: 20,
              fill: '#152D26',
              children: [
                {
                  id: 'wordmark',
                  type: 'label',
                  text: `${navBlock.title} · ${navBlock.subtitle}`,
                  w: 'fill',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#A7F3D0',
                },
                {
                  id: 'hero_title',
                  type: 'paragraph',
                  text: heroBlock.title,
                  w: 'fill',
                  fontFamily: 'Heiti SC',
                  fontSize: 18,
                  fontWeight: 700,
                  lineHeight: 25,
                  color: '#FFFFFF',
                  wrap: true,
                },
                {
                  id: 'kpi_metrics_row',
                  type: 'box',
                  layout: 'row',
                  align: 'center',
                  justify: 'space-between',
                  w: 'fill',
                  h: 38,
                  padding: [6, 12, 6, 12],
                  radius: 12,
                  fill: '#1E3F35',
                  children: [
                    { id: 'stat_obs', type: 'label', text: `TOTAL: ${listBlock.items?.length || 0} ITEMS`, fontFamily: 'Menlo', fontSize: 12, fontWeight: 700, color: '#DDE9A7' },
                    { id: 'stat_fav', type: 'label', text: heroBlock.meta, fontSize: 12, color: '#FFFFFF' },
                  ],
                },
                {
                  id: 'quick_cta_row',
                  type: 'box',
                  layout: 'row',
                  align: 'center',
                  justify: 'space-between',
                  w: 'fill',
                  h: 38,
                  gap: 10,
                  children: [
                    {
                      id: 'quick_add_btn',
                      type: 'button',
                      text: `＋ ${actionBlock.label}`,
                      w: 210,
                      h: 36,
                      radius: 10,
                      fill: '#DDE9A7',
                      color: '#152D26',
                      fontSize: 13,
                      fontWeight: 600,
                      on: { click: [{ type: 'link', page: targetMainPage }] },
                    },
                    {
                      id: 'identify_entry',
                      type: 'button',
                      text: actionBlock.secondaryLabel,
                      w: 110,
                      h: 36,
                      radius: 10,
                      fill: '$brand',
                      color: '#FFFFFF',
                      fontSize: 12,
                      fontWeight: 600,
                      on: { click: [{ type: 'link', page: targetIdentifyPage }] },
                    },
                  ],
                },
              ],
            },
            {
              id: 'featured',
              type: 'instance',
              sectionRole: 'hero',
              component: 'info-card',
              state: 'default',
              props: {
                tag: heroBlock.tag,
                title: items[0].title,
                summary: heroBlock.summary,
                metaText: items[0].subtitle,
                actionLabel: actionBlock.label,
              },
              on: { click: [{ type: 'link', page: targetDetailPage }] },
            },
            {
              id: 'feed_bottom_cards',
              type: 'box',
              sectionRole: 'content-list',
              layout: 'column',
              w: 'fill',
              h: 'hug',
              gap: 8,
              children: [
                {
                  id: 'whiteeye_card',
                  type: 'instance',
                  component: 'list-item',
                  state: 'default',
                  props: {
                    title: items[1].title,
                    subtitle: items[1].subtitle,
                    metaBadge: items[1].badge,
                    leadingIcon: 'book',
                  },
                  on: { click: [{ type: 'link', page: targetSpotPage }] },
                },
              ],
            },
            {
              id: 'sec_nav_bottom_dock',
              type: 'instance',
              sectionRole: 'navigation',
              component: 'nav-bar',
              variant: 'bottom-bar',
              state: 'selected',
              props: {
                title: navBlock.title,
                subtitle: '底部快捷导航栏',
                rightActionText: '切换',
              },
              on: { click: [{ type: 'link', page: targetMainPage }] },
            },
          ],
        },
      ],
    },
    interactions: [],
  };

  const schemes = [expA, expB, expC];
  const sourceScreen = basePage.root?.type === 'phone-shell' ? basePage.root.children?.[0] : basePage.root;
  const roots = sourceScreen?.children || [];
  const behaviorRoots = new Set();
  let references = JSON.stringify(basePage.interactions || []);
  const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const child of node.children || []) walk(child, visit);
    for (const state of node.states || []) walk(state.root, visit);
    if (node.template) walk(node.template, visit);
    for (const content of Object.values(node.slots || {})) for (const child of Array.isArray(content) ? content : [content]) walk(child, visit);
  };
  for (const root of roots) {
    walk(root, node => {
      if (node.on && Object.entries(node.on).some(([event, actions]) => event !== 'click' || (Array.isArray(actions) ? actions : [actions]).some(a => a?.type !== 'link'))) {
        behaviorRoots.add(root);
        references += JSON.stringify(node.on);
      }
    });
  }
  // Retain source targets and their containers with their original IDs, so
  // set-text/panel/input references keep working after adopting a scheme.
  for (const root of roots) walk(root, node => {
    if (node.id && (references.includes(`"${node.id}"`) || references.includes(`/${node.id}"`) || references.includes(`"@${node.id}"`))) behaviorRoots.add(root);
  });
  for (const scheme of schemes) {
    scheme.interactions = structuredClone(basePage.interactions || []);
    const screen = scheme.root.children[0];
    const retainedIds = new Set();
    for (const root of behaviorRoots) walk(root, node => { if (node.id) retainedIds.add(node.id); });
    for (const content of brief.requiredContent) for (const item of content.items || []) if (item.id) retainedIds.add(item.id);
    for (const content of brief.requiredContent) if (content.node) walk(content.node, node => { if (node.id) retainedIds.add(node.id); });
    const templateRenames = new Map();
    walk(screen, node => {
      if (retainedIds.has(node.id)) {
        const previous = node.id;
        node.id = `${scheme.id}__design_${previous}`;
        templateRenames.set(previous, node.id);
      }
    });
    const updateTemplateReferences = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['target', 'widget', 'panel', 'after'].includes(key) && templateRenames.has(child)) value[key] = templateRenames.get(child);
        else if (typeof child === 'object') updateTemplateReferences(child);
      }
    };
    updateTemplateReferences(screen);
    if (Array.isArray(rawBrief?.requiredContent)) {
      const suppliedList = rawBrief.requiredContent.find(c => c.role === 'content-list');
      if (suppliedList) {
        const region = screen.children.find(c => c.sectionRole === 'content-list');
        region.layout = 'column';
        region.children = (suppliedList.items || []).map((item, index) => ({
          id: item.id || `required_item_${index}`, type: 'box', layout: 'column', w: 'fill', h: 'hug', gap: 4,
          children: [item.title, item.subtitle, item.badge].filter(v => v !== undefined && v !== '').map((text, i) => ({
            id: `required_item_${index}_${i}`, type: 'paragraph', text: String(text), w: 'fill', h: 'hug', wrap: true, fontSize: i === 0 ? 16 : 12,
          })),
          ...(item.on ? { on: structuredClone(item.on) } : {}),
        }));
      }
    }
    for (const [index, content] of brief.requiredContent.entries()) {
      if (['navigation', 'hero', 'quick-action', 'content-list'].includes(content.role)) continue;
      if (!content.node && ![content.title, content.subtitle, content.body, content.text].some(v => typeof v === 'string')) {
        throw Object.assign(new Error(`必备内容 "${content.role}" 需要 node 或文本内容`), { code: 'E_EXPLORATION_CONTENT', role: content.role });
      }
      screen.children.push(content.node ? structuredClone(content.node) : {
        id: `required_section_${index}`, type: 'box', sectionRole: content.role, layout: 'column', w: 'fill', h: 'hug', gap: 6,
        children: [content.title, content.subtitle, content.body, content.text].filter(v => typeof v === 'string').map((text, i) => ({
          id: `required_section_${index}_${i}`, type: 'paragraph', text, w: 'fill', h: 'hug', wrap: true, fontSize: i === 0 ? 16 : 13,
        })),
      });
    }
    for (const root of behaviorRoots) {
      const clone = structuredClone(root);
      delete clone.x;
      delete clone.y;
      const existing = screen.children.findIndex(n => n.id === root.id);
      if (existing >= 0) screen.children[existing] = clone;
      else screen.children.push(clone);
    }
    scheme.explorationMeta.preservedBehaviorNodeIds = [...behaviorRoots].map(n => n.id);
    const ids = new Set();
    walk(scheme.root, node => {
      if (!node.id) return;
      if (ids.has(node.id)) throw Object.assign(new Error(`探索方案存在重复节点 ID: ${node.id}`), { code: 'E_EXPLORATION_ID', nodeId: node.id });
      ids.add(node.id);
    });
  }
  return schemes;
}

// Verify that any pair of exploration schemes has >= 2 genuine structural differences in the node tree
export function verifyExplorationPairStructuralDiff(exp1, exp2) {
  const screen1 = exp1?.root?.children?.[0] || exp1?.root;
  const screen2 = exp2?.root?.children?.[0] || exp2?.root;
  const diffs = [];

  // 1. First-screen sectionRole order difference
  const roles1 = (screen1?.children || []).map(c => c.sectionRole || c.id).join('->');
  const roles2 = (screen2?.children || []).map(c => c.sectionRole || c.id).join('->');
  if (roles1 !== roles2) {
    diffs.push({ axis: 'layoutStructure:moduleOrder', a: roles1, b: roles2 });
  }

  // 2. Root spacing / density difference (padding & gap)
  const density1 = `${JSON.stringify(screen1?.padding)}/${screen1?.gap}`;
  const density2 = `${JSON.stringify(screen2?.padding)}/${screen2?.gap}`;
  if (density1 !== density2) {
    diffs.push({ axis: 'informationDensity:rootSpacing', a: density1, b: density2 });
  }

  // 3. Content-list container layout (row dual-grid vs column vertical list) or child count
  const list1 = (screen1?.children || []).find(c => c.sectionRole === 'content-list');
  const list2 = (screen2?.children || []).find(c => c.sectionRole === 'content-list');
  const listSig1 = `${list1?.layout || 'col'}:${(list1?.children || []).map(c => c.type).join(',')}`;
  const listSig2 = `${list2?.layout || 'col'}:${(list2?.children || []).map(c => c.type).join(',')}`;
  if (listSig1 !== listSig2) {
    diffs.push({ axis: 'visualHierarchy:cardOrganization', a: listSig1, b: listSig2 });
  }

  // 4. Navigation position & form (top vs bottom, instance vs masthead box)
  const navIdx1 = (screen1?.children || []).findIndex(c => c.sectionRole === 'navigation');
  const navIdx2 = (screen2?.children || []).findIndex(c => c.sectionRole === 'navigation');
  const navType1 = (screen1?.children || [])[navIdx1]?.type;
  const navType2 = (screen2?.children || [])[navIdx2]?.type;
  if (`${navIdx1}:${navType1}` !== `${navIdx2}:${navType2}`) {
    diffs.push({ axis: 'navigationForm:positionAndType', a: `${navIdx1}:${navType1}`, b: `${navIdx2}:${navType2}` });
  }

  // 5. Typography font families used in node tree
  const collectFonts = (n, set = new Set()) => {
    if (!n || typeof n !== 'object') return set;
    if (n.fontFamily) set.add(n.fontFamily);
    for (const ch of n.children || []) collectFonts(ch, set);
    return set;
  };
  const fonts1 = [...collectFonts(screen1)].sort().join('+');
  const fonts2 = [...collectFonts(screen2)].sort().join('+');
  if (fonts1 !== fonts2) {
    diffs.push({ axis: 'typographyPairing:fontFamilies', a: fonts1, b: fonts2 });
  }

  return {
    pair: [exp1?.id, exp2?.id],
    structuralDiffCount: diffs.length,
    passedMinTwoDiffs: diffs.length >= 2,
    diffs,
  };
}

export function validateExplorationsUsability(doc, explorationPages) {
  const scene = resolveDocumentScene(doc);
  const validPageIds = new Set((doc.pages || []).map(p => p.id));
  const reports = [];

  for (const expPage of explorationPages) {
    const pgScene = (scene.pages || []).find(p => p.id === expPage.id);
    const clips = pgScene?.fontReport?.clipDiagnostics || [];
    const outOfBounds = (pgScene?.nodes || []).filter(
      n => n.visible && n.type !== 'phone-shell' && (n.x < -2 || n.y < -2 || n.x + n.w > 406)
    );
    const brokenLinks = [];
    for (const n of pgScene?.nodes || []) {
      const acts = Array.isArray(n.on?.click) ? n.on.click : [];
      for (const a of acts) {
        if (a?.type === 'link' && a.page && !validPageIds.has(a.page)) {
          brokenLinks.push({ nodeId: n.id, targetPage: a.page });
        }
      }
    }
    const clickableActions = (pgScene?.nodes || []).filter(n => n.visible && n.on?.click);
    const safeAreaTop = DEVICE_PRESETS[expPage.device || expPage.root?.device]?.safeAreaTop ?? 0;
    const safeAreaViolations = (pgScene?.nodes || []).filter(n => n.visible && n.y < safeAreaTop
      && ((n.text && n.text.trim()) || n.on?.click));

    reports.push({
      explorationId: expPage.id,
      direction: expPage.explorationMeta?.direction,
      clipCount: clips.length,
      outOfBoundsCount: outOfBounds.length,
      brokenLinkCount: brokenLinks.length,
      clickableActionCount: clickableActions.length,
      safeAreaTop,
      safeAreaViolationNodeIds: safeAreaViolations.map(n => n.id),
      passedUsability:
        clips.length === 0 &&
        outOfBounds.length === 0 &&
        brokenLinks.length === 0 &&
        clickableActions.length >= 2 &&
        safeAreaViolations.length === 0,
    });
  }

  const pairChecks = [];
  for (let i = 0; i < explorationPages.length; i++) {
    for (let j = i + 1; j < explorationPages.length; j++) {
      pairChecks.push(verifyExplorationPairStructuralDiff(explorationPages[i], explorationPages[j]));
    }
  }

  return {
    allUsable: reports.every(r => r.passedUsability),
    allPairsStructurallyDistinct: pairChecks.every(p => p.passedMinTwoDiffs),
    schemeReports: reports,
    pairChecks,
  };
}

// Apply either a full exploration page or a specific region (sectionRole / regionNodeId) back to basePage
export function applySelectedExplorationToPage(basePage, expPage, doc, {
  mode = 'full-page',
  regionRole = null,
  regionNodeId = null,
} = {}) {
  const isPartialRegion = mode === 'region' || Boolean(regionRole) || Boolean(regionNodeId);

  if (!isPartialRegion) {
    basePage.root = structuredClone(expPage.root);
    basePage.root.id = `${basePage.id}_shell`;
    if (basePage.root.children?.[0]) {
      basePage.root.children[0].id = `${basePage.id}_screen`;
    }
    basePage.selectedExploration = {
      id: expPage.id,
      mode: 'full-page',
      direction: expPage.explorationMeta?.direction || expPage.name,
      selectedAtRevision: (doc?.revision || 0) + 1,
    };
    return {
      mode: 'full-page',
      replacedNodeId: basePage.root.id,
    };
  }

  // Partial region adoption: find matching sectionRole or regionNodeId in expPage, and replace or insert into basePage
  const ROLE_ALIAS_MAP = {
    header: 'navigation',
    nav: 'navigation',
    navigation: 'navigation',
    hero: 'hero',
    banner: 'hero',
    action: 'quick-action',
    actions: 'quick-action',
    'quick-action': 'quick-action',
    form: 'quick-action',
    list: 'content-list',
    'content-list': 'content-list',
    items: 'content-list',
    cards: 'content-list',
  };
  const normalizedRole = regionRole ? (ROLE_ALIAS_MAP[regionRole] || regionRole) : null;

  const expScreen = expPage.root?.type === 'phone-shell' && expPage.root?.children?.[0]
    ? expPage.root.children[0]
    : expPage.root;
  const baseScreen = basePage.root?.type === 'phone-shell' && basePage.root?.children?.[0]
    ? basePage.root.children[0]
    : basePage.root;

  const sourceRegionNode = (expScreen?.children || []).find(
    ch => (normalizedRole && ch.sectionRole === normalizedRole) || (regionRole && ch.sectionRole === regionRole) || (regionNodeId && ch.id === regionNodeId)
  );
  if (!sourceRegionNode) {
    throw Object.assign(
      new Error(`候选方案 "${expPage.id}" 中未找到指定区域 (regionRole=${regionRole || ''}, regionNodeId=${regionNodeId || ''})`),
      { code: 'E_EXPLORATION_REGION_NOT_FOUND', explorationId: expPage.id, regionRole, regionNodeId }
    );
  }

  const clonedRegion = structuredClone(sourceRegionNode);
  baseScreen.children = Array.isArray(baseScreen.children) ? baseScreen.children : [];

  // Upgrade default blank stack screen to column when adopting flow-based exploration regions
  if ((!baseScreen.layout || baseScreen.layout === 'stack') && (!baseScreen.children.length || baseScreen.children.every(c => c.y === undefined))) {
    baseScreen.layout = 'column';
    if (!baseScreen.padding) baseScreen.padding = [16, 16, 16, 16];
    if (baseScreen.gap === undefined) baseScreen.gap = 12;
  }

  // Find corresponding target node in baseScreen by sectionRole, regionNodeId, or semantic heuristic
  const roleFallbackIds = {
    navigation: ['top_nav', 'list_nav', 'detail_nav', 'sec_nav_editorial', 'sec_nav_utility', 'sec_nav_bottom_dock'],
    hero: ['hero_card', 'featured', 'radar_map_box'],
    'quick-action': ['quick_form_box', 'sec_action_editorial', 'sec_action_utility', 'quick_log_banner'],
    'content-list': ['featured_item_1', 'editorial_bottom_row', 'tool_species_list', 'feed_bottom_cards'],
  };
  const candidateIds = new Set([
    ...(regionNodeId ? [regionNodeId] : []),
    ...(normalizedRole && roleFallbackIds[normalizedRole] ? roleFallbackIds[normalizedRole] : []),
    clonedRegion.id,
  ]);

  const targetIdx = baseScreen.children.findIndex(
    ch => (normalizedRole && ch.sectionRole === normalizedRole) || (regionRole && ch.sectionRole === regionRole) || candidateIds.has(ch.id)
  );

  let replacedNodeId;
  if (targetIdx >= 0) {
    const prevNode = baseScreen.children[targetIdx];
    // Preserve stable ID if replacing a primary landmark node
    if (prevNode.id && !regionNodeId) {
      clonedRegion.id = prevNode.id;
    }
    replacedNodeId = clonedRegion.id;
    baseScreen.children[targetIdx] = clonedRegion;
  } else {
    replacedNodeId = clonedRegion.id;
    baseScreen.children.unshift(clonedRegion);
  }

  basePage.selectedExploration = {
    id: expPage.id,
    mode: 'region',
    regionRole: regionRole || clonedRegion.sectionRole || null,
    replacedNodeId,
    direction: expPage.explorationMeta?.direction || expPage.name,
    selectedAtRevision: (doc?.revision || 0) + 1,
  };

  return {
    mode: 'region',
    regionRole: regionRole || clonedRegion.sectionRole || null,
    replacedNodeId,
  };
}
