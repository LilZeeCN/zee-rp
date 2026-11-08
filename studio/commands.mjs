// 命令层 facade:实现拆分在 ./commands/ 子目录,本文件只重导出,
// 保持既有消费方(studio 内 8 处 + scripts/mcp-tools.mjs)的 import 面不变。
// 结构:taxonomy(注册表)/ helpers(共享纯函数)/ cases/*(命令 case)/
//       apply(分发)/ document-store(事务与历史)/ runtime(预览运行态)。
export {
  VALID_NODE_TYPES,
  VALID_LAYOUTS,
  CONTAINER_TYPES,
  NON_STRUCTURAL_COMMANDS,
  COMMAND_TYPES_BY_GROUP,
  VALID_COMMAND_TYPES,
  SAFE_NODE_CACHE_COMMANDS,
  INTERACTION_MUTATING_COMMANDS,
} from './commands/taxonomy.mjs';
export { validatePropertiesObject, EXPRESSION_CHECKER } from './commands/helpers.mjs';
export { applySingleCommand, COMMAND_HANDLERS } from './commands/apply.mjs';
export { StudioDocumentStore, applyCommandsToDocument } from './commands/document-store.mjs';
export { createRuntimeState, applyRuntimeStep } from './commands/runtime.mjs';
