// applySingleCommand:命令前置校验 + 查表分发。从 commands.mjs 原样迁移,
// switch 改为 COMMAND_HANDLERS 函数表;ctx 协议:{ doc, cmd, cmdIdx, index, preferredPageId,
// pageScope, sceneOptions, checkInteraction, affectedIds, contractEvolutionResults, applySingleCommand }。
import { buildNodeIndex } from '../document.mjs';
import { validateCommandFields } from '../command-contracts.mjs';
import { VALID_COMMAND_TYPES, COMMAND_TYPES_BY_GROUP } from './taxonomy.mjs';
import { cmdError, validateInteractionAssignments, validateAuthoredTree } from './helpers.mjs';
import * as nodeCrud from './cases/node-crud.mjs';
import * as nodeEdit from './cases/node-edit.mjs';
import * as pageCases from './cases/pages.mjs';
import * as pathCases from './cases/path.mjs';
import * as componentCases from './cases/components.mjs';
import * as stateCases from './cases/state-data.mjs';
import * as interactionCases from './cases/interactions.mjs';
import * as exploreCases from './cases/explore.mjs';
import * as documentCases from './cases/document.mjs';

// 命令 dispatch 注册表:key = 合法命令类型(含别名),value = 处理器。
// 与 taxonomy 的 VALID_COMMAND_TYPES、command-contracts 的 COMMAND_CONTRACTS 三方一致,
// 由 test:studio-parity 门禁断言。
export const COMMAND_HANDLERS = {
  ...nodeCrud.handlers,
  ...nodeEdit.handlers,
  ...pageCases.handlers,
  ...pathCases.handlers,
  ...componentCases.handlers,
  ...stateCases.handlers,
  ...interactionCases.handlers,
  ...exploreCases.handlers,
  ...documentCases.handlers,
};

export function applySingleCommand(doc, cmd, cmdIdx, preferredPageId = null, cachedIndex = null, contractEvolutionResults = null, sceneOptions = {}) {
  const checkInteraction = (spec, nodeId) => sceneOptions.interactionValidationQueue ? sceneOptions.interactionValidationQueue.push({spec: structuredClone(spec), cmdIdx, nodeId}) : validateInteractionAssignments(spec, doc, cmdIdx, nodeId);
  if (cmd && typeof cmd === 'object' && !cmd.type && typeof cmd.cmd === 'string') {
    // 常见笔误：把命令种类写成 cmd。做别名而不是让人猜。
    cmd = { ...cmd, type: cmd.cmd };
    delete cmd.cmd;
  }
  if (!cmd || typeof cmd !== 'object' || !cmd.type) {
    throw cmdError(
      'E_INVALID_COMMAND',
      `命令 #${cmdIdx} 缺少 type 字段。可用类型：${VALID_COMMAND_TYPES.join(', ')}。示例：{type:'addNode', pageId:'home', node:{type:'box', id:'hero'}}`,
      {
        commandIndex: cmdIdx,
        field: 'type',
        validTypes: COMMAND_TYPES_BY_GROUP,
        example: { type: 'addNode', pageId: 'home', node: { type: 'box', id: 'hero', w: 'fill', h: 120 } },
      }
    );
  }
  const index = cachedIndex || buildNodeIndex(doc);
  validateCommandFields(cmd, cmdIdx);
  const pageScope = cmd.pageId || preferredPageId;
  if (pageScope && !doc.pages.some(page=>page.id===pageScope) && cmd.type!=='addPage') throw cmdError('E_PAGE_NOT_FOUND',`页面不存在：${pageScope}`,{commandIndex:cmdIdx,field:'pageId'});
  for (const tree of [cmd.node,cmd.root,cmd.component?.root,...(cmd.nodes || [])]) if(tree) validateAuthoredTree(tree,cmdIdx);
  for (const key of ['children','states','template']) {
    const value=(cmd.properties||cmd.props)?.[key];
    if (value === undefined) continue;
    if (key==='template') validateAuthoredTree(value,cmdIdx);
    else if(!Array.isArray(value)) throw cmdError('E_INVALID_NODE',`${key}需要数组`,{commandIndex:cmdIdx,field:key});
    else for(const item of value) validateAuthoredTree(key==='states'?item.root:item,cmdIdx);
  }
  const affectedIds = [];

  const handler = COMMAND_HANDLERS[cmd.type];
  if (handler) {
    handler({ doc, cmd, cmdIdx, index, preferredPageId, pageScope, sceneOptions, checkInteraction, affectedIds, contractEvolutionResults, applySingleCommand });
  } else {
    const near = VALID_COMMAND_TYPES.filter(t => t.toLowerCase().includes(String(cmd.type).toLowerCase())
      || String(cmd.type).toLowerCase().includes(t.toLowerCase()));
    throw cmdError(
      'E_UNKNOWN_COMMAND_TYPE',
      `未知的命令类型 "${cmd.type}"。${near.length ? `相近类型：${near.join(', ')}。` : ''}可用类型：${VALID_COMMAND_TYPES.join(', ')}`,
      { commandIndex: cmdIdx, field: 'type', validTypes: COMMAND_TYPES_BY_GROUP, suggestions: near }
    );
  }

  return affectedIds;
}
