// 命令注册表(单一事实来源):节点类型、布局模式、命令分组与派生全集。
// 命令 dispatch 表见 ./apply.mjs 的 COMMAND_HANDLERS;三方一致性由 test:studio-parity 门禁锁定。
export const VALID_NODE_TYPES = new Set([
  'box', 'card', 'label', 'paragraph', 'button', 'badge', 'input', 'image', 'icon', 'path',
  'dynamic-panel', 'repeater', 'phone-shell', 'tab-bar', 'nav-bar',
  'stat-row', 'list-item', 'progress-bar', 'instance', 'use',
  // Full RP/1 names are retained for historical documents. Type-specific
  // canvas expansion boundaries are exposed by node-capabilities.
  'divider', 'spacer', 'detail-card', 'data-table', 'searchable-list', 'master-detail',
]);

export const VALID_LAYOUTS = new Set(['stack', 'row', 'column', 'grid', 'free']);
// 可直接容纳 children 的源容器类型；reorderNode/pasteNodes 换父失败时作为候选列出。
export const CONTAINER_TYPES = ['box', 'card', 'phone-shell'];

export const NON_STRUCTURAL_COMMANDS = new Set([
  'setProperties', 'set-props', 'setText', 'renameNode', 'resizeNode',
  'setLayout', 'setConstraints', 'setToken', 'set-tokens', 'bindToken',
  'setTypography', 'setInteraction', 'removeInteraction',
  'renamePage', 'resizeArtboard', 'setInstanceVariant',
  'setInstanceOverride', 'resetInstanceOverride', 'setPanelActiveState',
  'repeaterAddRow', 'repeaterUpdateRow', 'repeaterDeleteRows',
  'repeaterSetFilter', 'repeaterSetSort', 'set-variable', 'dataset-op', 'editPath',
]);

export const COMMAND_TYPES_BY_GROUP = {
  节点: ['editNodes', 'addNode', 'deleteNode', 'duplicateNode', 'pasteNodes', 'moveNode', 'resizeNode', 'reorderNode', 'renameNode', 'setProperties', 'set-props', 'setText', 'setLayout', 'switchLayoutMode', 'resizeArtboard', 'editPath', 'booleanPathOp'],
  页面: ['addPage', 'duplicatePage', 'renamePage', 'deletePage', 'reorderPages'],
  组件: ['createComponent', 'registerCoreComponents', 'register-core-components', 'upsert-component', 'evolveComponentContract', 'evolve-component-contract', 'upgrade-component-contract', 'updateComponent', 'createInstance', 'setInstanceOverride', 'clearInstanceOverride', 'resetInstanceOverride', 'setInstanceVariant', 'detachInstance', 'detachMacro'],
  数据与状态: ['setToken', 'set-tokens', 'setTokens', 'setVariable', 'set-variable', 'datasetOp', 'dataset-op', 'setPanelActiveState', 'setFont', 'repeaterSetFilter', 'repeaterSetSort'],
  资源与交互: ['registerAsset', 'setInteraction', 'removeInteraction'],
  探索: ['generateExplorations', 'selectExploration', 'recordDesignDecision'],
  版本: ['restoreDocument'],
};
export const VALID_COMMAND_TYPES = Object.values(COMMAND_TYPES_BY_GROUP).flat();

export const SAFE_NODE_CACHE_COMMANDS = new Set([
  'setText', 'setProperties', 'set-props', 'renameNode', 'moveNode',
  'setLayout', 'setFont', 'setTypography', 'setConstraints',
  'setInteraction', 'removeInteraction', 'setInstanceVariant',
  'setInstanceOverride', 'clearInstanceOverride', 'resetInstanceOverride',
  'setPanelActiveState', 'renamePage', 'resizeArtboard', 'recordDesignDecision',
]);

export const INTERACTION_MUTATING_COMMANDS = new Set([
  'addNode', 'pasteNodes', 'duplicateNode', 'addPage', 'duplicatePage',
  'createComponent', 'upsert-component', 'updateComponent',
  'setInteraction', 'removeInteraction', 'selectExploration', 'restoreDocument',
]);
