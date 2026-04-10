/**
 * Test fixtures for transport wire format messages.
 */

import { ErrorCodes } from "../../src/transport/error-codes.js";
import type { ClientMessage, ServerMessage } from "../../src/transport/types.js";
import { createAssistantMessage, createUserMessage } from "./agent-events.js";

// --- Server → Client fixtures ---

export const sessionSyncMessage: ServerMessage = {
  type: "session_sync",
  sessionId: "sess_123",
  session: {
    id: "sess_123",
    name: "Test Session",
    source: "websocket",
    sender: null,
    leafId: "entry_5",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T01:00:00Z",
  },
  messages: [createUserMessage("Hello"), createAssistantMessage("Hi there!")],
  streamMessage: null,
};

export const sessionListMessage: ServerMessage = {
  type: "session_list",
  sessions: [
    { id: "s1", name: "Session 1", source: "websocket", updatedAt: "2025-01-01T01:00:00Z" },
    { id: "s2", name: "Session 2", source: "telegram", updatedAt: "2025-01-01T00:00:00Z" },
  ],
};

export const agentEventMessage: ServerMessage = {
  type: "agent_event",
  sessionId: "sess_123",
  event: {
    type: "message_start",
    message: createAssistantMessage(""),
  },
};

export const toolEventMessage: ServerMessage = {
  type: "tool_event",
  sessionId: "sess_123",
  event: {
    type: "tool_execution_start",
    toolCallId: "call_abc",
    toolName: "file_read",
    args: { path: "/test.ts" },
  },
};

export const errorMessage: ServerMessage = {
  type: "error",
  code: ErrorCodes.AGENT_INIT_ERROR,
  message: "Context window exceeded",
};

// --- Client → Server fixtures ---

export const promptMessage: ClientMessage = {
  type: "prompt",
  sessionId: "sess_123",
  text: "Hello, how are you?",
};

export const steerMessage: ClientMessage = {
  type: "steer",
  sessionId: "sess_123",
  text: "Actually, try a different approach",
};

export const abortMessage: ClientMessage = {
  type: "abort",
  sessionId: "sess_123",
};

export const switchSessionMessage: ClientMessage = {
  type: "switch_session",
  sessionId: "sess_456",
};

export const newSessionMessage: ClientMessage = {
  type: "new_session",
  name: "Research Task",
};

export const customResponseMessage: ClientMessage = {
  type: "custom_response",
  sessionId: "sess_123",
  requestId: "req_abc",
  data: { logs: [{ level: "error", text: "Something failed", ts: 1234567890 }] },
};
