// Client-side hook for consuming agent events over WebSocket
export { useAgentChat } from "./use-agent-chat.js";
export type { UseAgentChatConfig, UseAgentChatReturn } from "./use-agent-chat.js";

// Shared transport types (no server dependencies)
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
} from "../transport/types.js";

// Agent status types
export type {
  ConnectionStatus,
  AgentStatus,
} from "./types.js";
