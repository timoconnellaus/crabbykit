// Client-side hook for consuming agent events over WebSocket

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
export type {
  AgentConnectionContextValue,
  AgentConnectionProviderProps,
} from "./agent-connection-provider.js";
export {
  AgentConnectionContext,
  AgentConnectionProvider,
  useAgentConnection,
} from "./agent-connection-provider.js";
export type { CommandInfo, CommandResultTag, QueuedItem, ToolState } from "./chat-reducer.js";
export type { AgentConfigSnapshot, UseAgentConfigReturn } from "./hooks/use-agent-config.js";
export { useAgentConfig } from "./hooks/use-agent-config.js";
export type { UseChatSessionReturn } from "./hooks/use-chat-session.js";
// Decomposed hooks built on top of AgentConnectionProvider
export { useChatSession } from "./hooks/use-chat-session.js";
export type { UseCommandsReturn } from "./hooks/use-commands.js";
export { useCommands } from "./hooks/use-commands.js";
export type { UseQueueReturn } from "./hooks/use-queue.js";
export { useQueue } from "./hooks/use-queue.js";
export type { ScheduleInfo, UseSchedulesReturn } from "./hooks/use-schedules.js";
export { useSchedules } from "./hooks/use-schedules.js";
export type { SessionSummary, UseSessionsReturn } from "./hooks/use-sessions.js";
export { useSessions } from "./hooks/use-sessions.js";
export type { UseSkillsReturn } from "./hooks/use-skills.js";
export { useSkills } from "./hooks/use-skills.js";
export type { UseSystemPromptReturn } from "./hooks/use-system-prompt.js";
export { useSystemPrompt } from "./hooks/use-system-prompt.js";
// Agent status types
export type {
  AgentStatus,
  ConnectionStatus,
} from "./types.js";
export { useCapabilityEvents, useCapabilityState } from "./use-capability-state.js";
export { useSendCapabilityAction } from "./use-send-capability-action.js";
