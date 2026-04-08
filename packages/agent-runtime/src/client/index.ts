// Client-side hook for consuming agent events over WebSocket

export {
  AgentConnectionContext,
  AgentConnectionProvider,
  useAgentConnection,
  useOptionalAgentConnection,
} from "./agent-connection-provider.js";
export type {
  AgentConnectionContextValue,
  AgentConnectionProviderProps,
} from "./agent-connection-provider.js";
// Shared transport types (no server dependencies)
export type {
  AbortMessage,
  AgentEventMessage,
  CapabilityActionMessage,
  CapabilityStateMessage,
  ClientMessage,
  CommandMessage,
  CommandResultMessage,
  CostEventMessage,
  CustomResponseMessage,
  DeleteSessionMessage,
  ErrorMessage,
  NewSessionMessage,
  PromptMessage,
  ServerMessage,
  SessionListMessage,
  SessionSyncMessage,
  SkillListEntry,
  SteerMessage,
  SwitchSessionMessage,
  ToolEventMessage,
} from "../transport/types.js";
export type { QueuedItem } from "./chat-reducer.js";
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
export { useCapabilityEvents, useCapabilityState } from "./use-capability-state.js";
export { useSendCapabilityAction } from "./use-send-capability-action.js";
// Decomposed hooks built on top of AgentConnectionProvider
export { useChatSession } from "./hooks/use-chat-session.js";
export type { UseChatSessionReturn } from "./hooks/use-chat-session.js";
export { useSchedules } from "./hooks/use-schedules.js";
export type { ScheduleInfo, UseSchedulesReturn } from "./hooks/use-schedules.js";
export { useSkills } from "./hooks/use-skills.js";
export type { UseSkillsReturn } from "./hooks/use-skills.js";
export { useCommands } from "./hooks/use-commands.js";
export type { UseCommandsReturn } from "./hooks/use-commands.js";
export { useSessions } from "./hooks/use-sessions.js";
export type { SessionSummary, UseSessionsReturn } from "./hooks/use-sessions.js";
export { useSystemPrompt } from "./hooks/use-system-prompt.js";
export type { UseSystemPromptReturn } from "./hooks/use-system-prompt.js";
export { useQueue } from "./hooks/use-queue.js";
export type { UseQueueReturn } from "./hooks/use-queue.js";
