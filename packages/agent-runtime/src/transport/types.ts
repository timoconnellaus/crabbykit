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

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | AgentEventMessage
  | ToolEventMessage
  | SessionSyncMessage
  | SessionListMessage
  | McpStatusMessage
  | CostEventMessage
  | ErrorMessage;

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

export type ClientMessage =
  | PromptMessage
  | SteerMessage
  | AbortMessage
  | SwitchSessionMessage
  | NewSessionMessage
  | DeleteSessionMessage;
