import type { AgentEvent, AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { CostEvent } from "../costs/types.js";
import type { Session } from "../session/types.js";
import type { ErrorCode } from "./error-codes.js";

// --- Server → Client messages ---

export interface AgentEventMessage {
  type: "agent_event";
  sessionId: string;
  event: AgentEvent;
}

export interface ToolEventMessage {
  type: "tool_event";
  sessionId: string;
  event: {
    type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
    toolCallId: string;
    toolName: string;
    args?: unknown;
    partialResult?: unknown;
    result?: unknown;
    isError?: boolean;
  };
}

export interface SessionSyncMessage {
  type: "session_sync";
  sessionId: string;
  session: Session;
  messages: AgentMessage[];
  streamMessage?: AgentMessage | null;
  /** Seq of the last entry in this page. Used as cursor for requesting more pages. */
  cursor?: number;
  /** Whether more entries exist beyond this page. */
  hasMore?: boolean;
}

export interface SessionListMessage {
  type: "session_list";
  sessions: Array<{
    id: string;
    name: string;
    source: string;
    updatedAt: string;
  }>;
}

export interface McpStatusMessage {
  type: "mcp_status";
  servers: Array<{
    id: string;
    name: string;
    status: "connected" | "disconnected" | "error";
    toolCount: number;
    error?: string;
  }>;
}

export interface CostEventMessage {
  type: "cost_event";
  sessionId: string;
  event: CostEvent;
}

export interface ScheduleListMessage {
  type: "schedule_list";
  schedules: Array<{
    id: string;
    name: string;
    cron: string;
    enabled: boolean;
    status: string;
    nextFireAt: string | null;
    expiresAt: string | null;
    lastFiredAt: string | null;
  }>;
}

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
}

export interface CommandResultMessage {
  type: "command_result";
  sessionId: string;
  name: string;
  result: { text?: string; data?: unknown };
  isError: boolean;
}

export interface CommandListMessage {
  type: "command_list";
  commands: Array<{ name: string; description: string }>;
}

export interface CustomEventMessage {
  type: "custom_event";
  sessionId: string;
  event: {
    name: string;
    data: Record<string, unknown>;
  };
}

export interface InjectMessageMessage {
  type: "inject_message";
  sessionId: string;
  message: AgentMessage;
}

export interface SkillListEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  autoUpdate: boolean;
  stale: boolean;
  /** True for skills declared at build time — cannot be uninstalled. */
  builtIn?: boolean;
}

export interface SkillListMessage {
  type: "skill_list";
  skills: SkillListEntry[];
}

export interface SystemPromptMessage {
  type: "system_prompt";
  sections: Array<{ name: string; key: string; content: string; lines: number }>;
  raw: string;
}

export interface PongMessage {
  type: "pong";
}

export interface TaskEventMessage {
  type: "task_event";
  event: {
    changeType: "created" | "updated" | "closed" | "dep_added" | "dep_removed";
    task: Record<string, unknown>;
    dep?: Record<string, unknown>;
  };
}

export interface SubagentEventMessage {
  type: "subagent_event";
  sessionId: string;
  subagentId: string;
  profileId: string;
  childSessionId: string;
  taskId?: string;
  event: AgentEvent;
}

export interface QueueStateMessage {
  type: "queue_state";
  sessionId: string;
  items: Array<{ id: string; text: string; createdAt: string }>;
}

export type ServerMessage =
  | AgentEventMessage
  | ToolEventMessage
  | SessionSyncMessage
  | SessionListMessage
  | ScheduleListMessage
  | McpStatusMessage
  | CostEventMessage
  | ErrorMessage
  | CommandResultMessage
  | CommandListMessage
  | CustomEventMessage
  | InjectMessageMessage
  | SkillListMessage
  | SystemPromptMessage
  | TaskEventMessage
  | SubagentEventMessage
  | QueueStateMessage
  | PongMessage;

// --- Client → Server messages ---

export interface PromptMessage {
  type: "prompt";
  sessionId: string;
  text: string;
}

export interface SteerMessage {
  type: "steer";
  sessionId: string;
  text: string;
}

export interface AbortMessage {
  type: "abort";
  sessionId: string;
}

export interface SwitchSessionMessage {
  type: "switch_session";
  sessionId: string;
}

export interface NewSessionMessage {
  type: "new_session";
  name?: string;
}

export interface DeleteSessionMessage {
  type: "delete_session";
  sessionId: string;
}

export interface CommandMessage {
  type: "command";
  sessionId: string;
  /** Command name without leading slash. */
  name: string;
  /** Raw argument string (parsed server-side against command schema). */
  args?: string;
}

export interface RequestSyncMessage {
  type: "request_sync";
  sessionId: string;
  /** Fetch entries after this seq number. Omit for the first page. */
  afterSeq?: number;
}

export interface ToggleScheduleMessage {
  type: "toggle_schedule";
  scheduleId: string;
  enabled: boolean;
}

export interface CustomResponseMessage {
  type: "custom_response";
  sessionId: string;
  requestId: string;
  data: Record<string, unknown>;
}

export interface RequestSystemPromptMessage {
  type: "request_system_prompt";
}

export interface QueueMessageMessage {
  type: "queue_message";
  sessionId: string;
  text: string;
}

export interface QueueDeleteMessage {
  type: "queue_delete";
  sessionId: string;
  queueId: string;
}

export interface QueueSteerMessage {
  type: "queue_steer";
  sessionId: string;
  queueId: string;
}

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | PromptMessage
  | SteerMessage
  | AbortMessage
  | SwitchSessionMessage
  | NewSessionMessage
  | DeleteSessionMessage
  | CommandMessage
  | RequestSyncMessage
  | ToggleScheduleMessage
  | CustomResponseMessage
  | RequestSystemPromptMessage
  | QueueMessageMessage
  | QueueDeleteMessage
  | QueueSteerMessage
  | PingMessage;
