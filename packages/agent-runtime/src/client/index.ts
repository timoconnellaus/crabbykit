// Client-side hook for consuming agent events over WebSocket

// Shared transport types (no server dependencies)
export type {
  AbortMessage,
  AgentEventMessage,
  ClientMessage,
  CommandListMessage,
  CommandMessage,
  CommandResultMessage,
  CostEventMessage,
  CustomResponseMessage,
  DeleteSessionMessage,
  ErrorMessage,
  McpStatusMessage,
  NewSessionMessage,
  PromptMessage,
  ServerMessage,
  SessionListMessage,
  SessionSyncMessage,
  SteerMessage,
  SwitchSessionMessage,
  ToolEventMessage,
} from "../transport/types.js";
// Agent status types
export type {
  AgentStatus,
  ConnectionStatus,
} from "./types.js";
export type {
  CommandInfo,
  CommandResultTag,
  ToolState,
  UseAgentChatConfig,
  UseAgentChatReturn,
} from "./use-agent-chat.js";
export { useAgentChat } from "./use-agent-chat.js";
