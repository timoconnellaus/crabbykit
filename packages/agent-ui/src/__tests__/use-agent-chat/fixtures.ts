/**
 * Composable ServerMessage builder functions for useAgentChat tests.
 *
 * Each builder returns a ServerMessage or ServerMessage[] that can be
 * concatenated to compose complex multi-turn scenarios.
 */

import type { AgentMessage } from "@claw-for-cloudflare/agent-runtime";
import type { ServerMessage } from "@claw-for-cloudflare/agent-runtime/client";

const DEFAULT_SESSION_ID = "sess_1";

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

export function createUserMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() } as unknown as AgentMessage;
}

export function createAssistantMessage(content: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

export function createEmptyAssistantMessage(): AgentMessage {
  return {
    role: "assistant",
    content: "",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

export function createToolCallMessage(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId, toolName, args }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function makeSession(sessionId: string) {
  return {
    id: sessionId,
    name: "Test Session",
    source: "websocket",
    leafId: null as string | null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// ServerMessage builders
// ---------------------------------------------------------------------------

export function sessionSync(opts: {
  sessionId?: string;
  messages?: AgentMessage[];
  streamMessage?: AgentMessage | null;
  cursor?: number;
  hasMore?: boolean;
}): ServerMessage {
  const sid = opts.sessionId ?? DEFAULT_SESSION_ID;
  return {
    type: "session_sync",
    sessionId: sid,
    session: makeSession(sid),
    messages: opts.messages ?? [],
    streamMessage: opts.streamMessage ?? null,
    cursor: opts.cursor,
    hasMore: opts.hasMore,
  };
}

export function sessionList(
  sessions: Array<{ id: string; name: string; source?: string; updatedAt?: string }>,
): ServerMessage {
  return {
    type: "session_list",
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      source: s.source ?? "websocket",
      updatedAt: s.updatedAt ?? "2025-01-01T00:00:00Z",
    })),
  };
}

/**
 * Complete text streaming sequence:
 * message_start → N message_updates → message_end → agent_end
 */
export function textStreamSequence(
  finalText: string,
  opts?: { sessionId?: string; deltas?: string[]; skipAgentEnd?: boolean },
): ServerMessage[] {
  const sid = opts?.sessionId ?? DEFAULT_SESSION_ID;
  const deltas = opts?.deltas ?? [finalText];

  let accumulated = "";
  const updates: ServerMessage[] = deltas.map((delta) => {
    accumulated += delta;
    return {
      type: "agent_event" as const,
      sessionId: sid,
      event: {
        type: "message_update" as const,
        message: createAssistantMessage(accumulated),
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        assistantMessageEvent: { type: "text_delta", text: delta } as any,
      },
    };
  });

  const msgs: ServerMessage[] = [
    {
      type: "agent_event",
      sessionId: sid,
      event: { type: "message_start", message: createAssistantMessage("") },
    },
    ...updates,
    {
      type: "agent_event",
      sessionId: sid,
      event: { type: "message_end", message: createAssistantMessage(finalText) },
    },
  ];

  if (!opts?.skipAgentEnd) {
    msgs.push({
      type: "agent_event",
      sessionId: sid,
      event: { type: "agent_end", messages: [] },
    });
  }

  return msgs;
}

/** Just the message_start event (for tests that need granular control). */
export function messageStart(
  sessionId = DEFAULT_SESSION_ID,
  message?: AgentMessage,
): ServerMessage {
  return {
    type: "agent_event",
    sessionId,
    event: {
      type: "message_start",
      message: message ?? createAssistantMessage(""),
    },
  };
}

/** Just the message_update event. */
export function messageUpdate(
  message: AgentMessage,
  opts?: {
    sessionId?: string;
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    assistantMessageEvent?: any;
  },
): ServerMessage {
  return {
    type: "agent_event",
    sessionId: opts?.sessionId ?? DEFAULT_SESSION_ID,
    event: {
      type: "message_update",
      message,
      assistantMessageEvent: opts?.assistantMessageEvent,
    },
  };
}

/** Just the message_end event. */
export function messageEnd(message: AgentMessage, sessionId = DEFAULT_SESSION_ID): ServerMessage {
  return {
    type: "agent_event",
    sessionId,
    event: { type: "message_end", message },
  };
}

/** Just the agent_end event. */
export function agentEnd(sessionId = DEFAULT_SESSION_ID): ServerMessage {
  return {
    type: "agent_event",
    sessionId,
    event: { type: "agent_end", messages: [] },
  };
}

/** Tool execution start + end sequence. */
export function toolExecutionSequence(opts: {
  toolCallId: string;
  toolName: string;
  result?: unknown;
  isError?: boolean;
  sessionId?: string;
}): ServerMessage[] {
  const sid = opts.sessionId ?? DEFAULT_SESSION_ID;
  return [
    {
      type: "tool_event",
      sessionId: sid,
      event: {
        type: "tool_execution_start",
        toolCallId: opts.toolCallId,
        toolName: opts.toolName,
      },
    },
    {
      type: "tool_event",
      sessionId: sid,
      event: {
        type: "tool_execution_end",
        toolCallId: opts.toolCallId,
        toolName: opts.toolName,
        result: opts.result ?? { content: [{ type: "text", text: "done" }] },
        isError: opts.isError ?? false,
      },
    },
  ];
}

/** Tool execution update (streaming partial result). */
export function toolExecutionUpdate(opts: {
  toolCallId: string;
  toolName: string;
  partialResult: unknown;
  sessionId?: string;
}): ServerMessage {
  return {
    type: "tool_event",
    sessionId: opts.sessionId ?? DEFAULT_SESSION_ID,
    event: {
      type: "tool_execution_update",
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      partialResult: opts.partialResult,
    },
  };
}

/** Thinking sequence: thinking_start → deltas → thinking_end (as message_update events). */
export function thinkingSequence(
  thinkingText: string,
  opts?: { sessionId?: string; deltas?: string[] },
): ServerMessage[] {
  const sid = opts?.sessionId ?? DEFAULT_SESSION_ID;
  const deltas = opts?.deltas ?? [thinkingText];
  return [
    {
      type: "agent_event",
      sessionId: sid,
      event: {
        type: "message_update",
        message: createAssistantMessage(""),
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        assistantMessageEvent: { type: "thinking_start" } as any,
      },
    },
    ...deltas.map(
      (delta): ServerMessage => ({
        type: "agent_event",
        sessionId: sid,
        event: {
          type: "message_update",
          message: createAssistantMessage(""),
          // biome-ignore lint/suspicious/noExplicitAny: test fixture
          assistantMessageEvent: { type: "thinking_delta", delta } as any,
        },
      }),
    ),
    {
      type: "agent_event",
      sessionId: sid,
      event: {
        type: "message_update",
        message: createAssistantMessage(""),
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        assistantMessageEvent: { type: "thinking_end" } as any,
      },
    },
  ];
}

/** inject_message event. */
export function injectMessage(
  message: AgentMessage,
  sessionId = DEFAULT_SESSION_ID,
): ServerMessage {
  return {
    type: "inject_message",
    sessionId,
    message,
  };
}

/** cost_event message. */
export function costEvent(
  opts: { sessionId?: string; capabilityId?: string; toolName?: string; amount?: number } = {},
): ServerMessage {
  return {
    type: "cost_event",
    sessionId: opts.sessionId ?? DEFAULT_SESSION_ID,
    event: {
      capabilityId: opts.capabilityId ?? "test-cap",
      toolName: opts.toolName ?? "test_tool",
      amount: opts.amount ?? 0.01,
      currency: "USD",
    },
  };
}

/** capability_state envelope for the "commands" capability. */
export function commandList(commands: Array<{ name: string; description: string }>): ServerMessage {
  return {
    type: "capability_state",
    capabilityId: "commands",
    scope: "global",
    event: "sync",
    data: { commands },
  };
}

/** command_result message. */
export function commandResult(
  name: string,
  result: { text?: string; data?: unknown },
  opts?: { sessionId?: string; isError?: boolean },
): ServerMessage {
  return {
    type: "command_result",
    sessionId: opts?.sessionId ?? DEFAULT_SESSION_ID,
    name,
    result,
    isError: opts?.isError ?? false,
  };
}

/** capability_state envelope for the "schedules" capability. */
export function scheduleList(
  schedules: Array<{
    id: string;
    name: string;
    cron: string;
    enabled?: boolean;
  }>,
): ServerMessage {
  return {
    type: "capability_state",
    capabilityId: "schedules",
    scope: "global",
    event: "sync",
    data: {
      schedules: schedules.map((s) => ({
        id: s.id,
        name: s.name,
        cron: s.cron,
        enabled: s.enabled ?? true,
        status: "active",
        nextFireAt: null,
        expiresAt: null,
        lastFiredAt: null,
      })),
    },
  };
}

/** error message. */
export function errorMessage(message: string, code = "AGENT_INIT_ERROR"): ServerMessage {
  return {
    type: "error",
    code: code as ServerMessage extends { type: "error"; code: infer C } ? C : never,
    message,
  };
}

/** pong message. */
export function pong(): ServerMessage {
  return { type: "pong" };
}

/** custom_event message. */
export function customEvent(
  name: string,
  data: Record<string, unknown>,
  sessionId = DEFAULT_SESSION_ID,
): ServerMessage {
  return {
    type: "custom_event",
    sessionId,
    event: { name, data },
  };
}
