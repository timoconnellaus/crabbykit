/**
 * Test fixtures for pi-agent-core event shapes.
 * These match the AssistantMessageEvent format from @mariozechner/pi-ai
 * and the AgentEvent format from @mariozechner/pi-agent-core.
 */

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

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

export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
  isError = false,
): AgentMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text: content }],
    toolCallId,
    toolName,
    isError,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

// Sample event sequences for testing

export const textResponseEvents: AgentEvent[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  {
    type: "message_start",
    message: createAssistantMessage(""),
  },
  {
    type: "message_update",
    message: createAssistantMessage("Hello"),
    assistantMessageEvent: { type: "text_delta", text: "Hello" } as any,
  },
  {
    type: "message_update",
    message: createAssistantMessage("Hello there!"),
    assistantMessageEvent: { type: "text_delta", text: " there!" } as any,
  },
  {
    type: "message_end",
    message: createAssistantMessage("Hello there!"),
  },
  {
    type: "turn_end",
    message: createAssistantMessage("Hello there!"),
    toolResults: [],
  },
  {
    type: "agent_end",
    messages: [createUserMessage("Hi"), createAssistantMessage("Hello there!")],
  },
];

export const toolCallEvents: AgentEvent[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  {
    type: "message_start",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call_abc",
          toolName: "file_read",
          args: { path: "/test.ts" },
        },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call_abc",
          toolName: "file_read",
          args: { path: "/test.ts" },
        },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
  },
  {
    type: "tool_execution_start",
    toolCallId: "call_abc",
    toolName: "file_read",
    args: { path: "/test.ts" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "call_abc",
    toolName: "file_read",
    result: { content: [{ type: "text", text: "file contents" }], details: {} },
    isError: false,
  },
  {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call_abc",
          toolName: "file_read",
          args: { path: "/test.ts" },
        },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
    toolResults: [createToolResultMessage("call_abc", "file_read", "file contents") as any],
  },
  // Second turn - LLM responds after tool result
  { type: "turn_start" },
  {
    type: "message_start",
    message: createAssistantMessage(""),
  },
  {
    type: "message_end",
    message: createAssistantMessage("The file contains test code."),
  },
  {
    type: "turn_end",
    message: createAssistantMessage("The file contains test code."),
    toolResults: [],
  },
  {
    type: "agent_end",
    messages: [
      createUserMessage("Read /test.ts"),
      createAssistantMessage("The file contains test code."),
    ],
  },
];

export const thinkingEvents: AgentEvent[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  {
    type: "message_start",
    message: createAssistantMessage(""),
  },
  {
    type: "message_update",
    message: createAssistantMessage(""),
    assistantMessageEvent: { type: "thinking_start" } as any,
  },
  {
    type: "message_update",
    message: createAssistantMessage(""),
    assistantMessageEvent: { type: "thinking_delta", text: "Let me think..." } as any,
  },
  {
    type: "message_update",
    message: createAssistantMessage(""),
    assistantMessageEvent: { type: "thinking_end" } as any,
  },
  {
    type: "message_update",
    message: createAssistantMessage("Here's my answer."),
    assistantMessageEvent: { type: "text_delta", text: "Here's my answer." } as any,
  },
  {
    type: "message_end",
    message: createAssistantMessage("Here's my answer."),
  },
  {
    type: "turn_end",
    message: createAssistantMessage("Here's my answer."),
    toolResults: [],
  },
  {
    type: "agent_end",
    messages: [createUserMessage("Question"), createAssistantMessage("Here's my answer.")],
  },
];
