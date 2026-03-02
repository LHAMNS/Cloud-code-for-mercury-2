// Mercury Code - Public API
// Re-exports the main classes for programmatic use

export { MercuryClient } from "./client.js";
export { MercuryRepl } from "./repl.js";
export { Conversation } from "./conversation.js";
export { MemoryManager, ConversationLog } from "./memory.js";
export { compressContext, superCompressContext, estimateTokens, estimateMessagesTokens } from "./context.js";
export { SubAgent, runSubAgentTeam, getBackgroundAgent, listBackgroundAgents } from "./subagent.js";
export { SessionHistory } from "./history.js";
export { RollbackManager } from "./rollback.js";
export { Sandbox, createDefaultSandbox } from "./sandbox.js";
export { LspClient } from "./lsp.js";
export { searchSymbols, fileOutline, extractSymbols } from "./ast-search.js";
export { discoverAgents, resolveAgentTools, matchAgentForTask, formatAgentList, scaffoldAgent } from "./agent-definitions.js";
export { loadProjectConfig, findProjectConfig, scaffoldProjectConfig } from "./project-config.js";
