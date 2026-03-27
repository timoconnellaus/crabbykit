// Session management
export { SessionStore } from "./session/session-store.js";
export type {
  Session,
  SessionEntry,
  SessionEntryType,
  MessageEntryData,
  CompactionEntryData,
  ModelChangeEntryData,
  CustomEntryData,
} from "./session/types.js";

// Compaction
export {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompact,
  findCutPoint,
  splitByTokenShare,
  summarizeInStages,
  compactSession,
  truncateToolResult,
  emergencyTruncate,
} from "./compaction/index.js";
export type {
  CompactionConfig,
  CompactionResult,
  SummarizeFn,
} from "./compaction/types.js";

// Tool system
export { defineTool, mcpToolToAgentTool } from "./tools/define-tool.js";

// MCP client
export { McpManager } from "./mcp/mcp-manager.js";
export type { McpServerConfig, McpServerStatus } from "./mcp/types.js";

// Transport
export type {
  ServerMessage,
  ClientMessage,
  AgentEventMessage,
  ToolEventMessage,
  SessionSyncMessage,
  SessionListMessage,
  McpStatusMessage,
  ErrorMessage,
  PromptMessage,
  SteerMessage,
  AbortMessage,
  SwitchSessionMessage,
  NewSessionMessage,
} from "./transport/types.js";

// Agent DO
export { AgentDO } from "./agent-do.js";
export type { AgentConfig, AgentContext } from "./agent-do.js";

// Re-export key pi-* types for consumers
export type {
  AgentTool,
  AgentToolResult,
  AgentEvent,
  AgentMessage,
  AgentState,
  ThinkingLevel,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from "@mariozechner/pi-agent-core";

export type { Model } from "@mariozechner/pi-ai";

// Re-export TypeBox for tool schema definition
export { Type, type Static, type TSchema } from "@sinclair/typebox";
