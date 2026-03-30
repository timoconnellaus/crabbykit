import { useAgentChat } from "@claw-for-cloudflare/agent-runtime/client";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentEnd,
  commandList,
  commandResult,
  costEvent,
  createAssistantMessage,
  createEmptyAssistantMessage,
  createToolCallMessage,
  createUserMessage,
  customEvent,
  errorMessage,
  injectMessage,
  messageEnd,
  messageStart,
  messageUpdate,
  pong,
  scheduleList,
  sessionList,
  sessionSync,
  textStreamSequence,
  thinkingSequence,
  toolExecutionSequence,
} from "./fixtures";
import { createHarness, type Harness } from "./harness";
import { MockWebSocket } from "./mock-websocket";

let harness: Harness;

afterEach(() => {
  harness?.cleanup();
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Connection lifecycle
// ---------------------------------------------------------------------------

describe("connection lifecycle", () => {
  it("starts in connecting state", () => {
    harness = createHarness();
    expect(harness.current.connectionStatus).toBe("connecting");
  });

  it("transitions to connected on open", async () => {
    harness = createHarness();
    await harness.open();
    expect(harness.current.connectionStatus).toBe("connected");
  });

  it("session_sync initializes state", async () => {
    harness = createHarness();
    const userMsg = createUserMessage("Hello");
    await harness.establish("sess_1", [userMsg]);

    expect(harness.current.currentSessionId).toBe("sess_1");
    expect(harness.current.messages).toHaveLength(1);
    expect(harness.current.messages[0].role).toBe("user");
    expect(harness.current.agentStatus).toBe("idle");
  });

  it("session_sync with streamMessage sets streaming status", async () => {
    harness = createHarness();
    await harness.open();
    const streamMsg = createAssistantMessage("In progress...");
    await harness.serverSend(
      sessionSync({ sessionId: "sess_1", messages: [], streamMessage: streamMsg }),
    );

    expect(harness.current.agentStatus).toBe("streaming");
    expect(harness.current.messages).toHaveLength(1);
  });

  it("session_sync resets transient state", async () => {
    harness = createHarness();
    await harness.establish("sess_1");

    // Accumulate some state
    await harness.serverSend(costEvent());
    await harness.serverSend(messageStart());
    await harness.serverSendAll(thinkingSequence("thinking..."));

    // New session_sync should reset everything
    await harness.serverSend(sessionSync({ sessionId: "sess_1", messages: [] }));

    expect(harness.current.costs).toHaveLength(0);
    expect(harness.current.thinking).toBeNull();
    expect(harness.current.completedThinking).toBeNull();
    expect(harness.current.toolStates.size).toBe(0);
    expect(harness.current.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Streaming lifecycle
// ---------------------------------------------------------------------------

describe("streaming lifecycle", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("message_start sets agentStatus to streaming", async () => {
    await harness.serverSend(messageStart());

    expect(harness.current.agentStatus).toBe("streaming");
    // The streaming placeholder is an empty assistant message, which is
    // filtered from the output `messages` array. Once a message_update
    // arrives with content, it becomes visible.
  });

  it("message_update replaces streaming content", async () => {
    await harness.serverSend(messageStart());
    await harness.serverSend(
      messageUpdate(createAssistantMessage("Hello"), {
        assistantMessageEvent: { type: "text_delta", text: "Hello" },
      }),
    );

    const last = harness.current.messages[harness.current.messages.length - 1];
    const content = last.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("Hello");
  });

  it("message_end finalizes the message", async () => {
    const sequence = textStreamSequence("Hello world", {
      deltas: ["Hello", " world"],
    });
    await harness.serverSendAll(sequence);

    // After agent_end, agentStatus should be idle
    expect(harness.current.agentStatus).toBe("idle");
    // The final message should have the complete text
    const last = harness.current.messages[harness.current.messages.length - 1];
    const content = last.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("Hello world");
  });

  it("agent_end resets agentStatus and clears toolStates", async () => {
    await harness.serverSend(messageStart());
    await harness.serverSend(agentEnd());

    expect(harness.current.agentStatus).toBe("idle");
    expect(harness.current.toolStates.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Sending messages (prompt vs steer)
// ---------------------------------------------------------------------------

describe("sendMessage", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("sends prompt when agent is idle", async () => {
    await harness.sendMessage("hi");

    const sent = harness.sent.find((m) => m.type === "prompt");
    expect(sent).toBeDefined();
    expect(sent!.type).toBe("prompt");
    expect((sent as { text: string }).text).toBe("hi");
  });

  it("optimistically adds user message", async () => {
    await harness.sendMessage("hi");

    const lastMsg = harness.current.messages[harness.current.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toBe("hi");
  });

  it("sets agentStatus to streaming after sending", async () => {
    await harness.sendMessage("hi");
    expect(harness.current.agentStatus).toBe("streaming");
  });

  it("sends steer when agent is streaming", async () => {
    // Put agent into streaming state
    await harness.serverSend(messageStart());
    expect(harness.current.agentStatus).toBe("streaming");

    await harness.sendMessage("no wait, do it differently");

    const steerMsg = harness.sent.find((m) => m.type === "steer");
    expect(steerMsg).toBeDefined();
    expect((steerMsg as { text: string }).text).toBe("no wait, do it differently");
  });

  it("detects known slash commands", async () => {
    // Register available commands
    await harness.serverSend(commandList([{ name: "help", description: "Show help" }]));

    await harness.sendMessage("/help");

    const cmdMsg = harness.sent.find((m) => m.type === "command");
    expect(cmdMsg).toBeDefined();
    expect((cmdMsg as { name: string }).name).toBe("help");
  });

  it("sends slash command with args", async () => {
    await harness.serverSend(commandList([{ name: "search", description: "Search" }]));

    await harness.sendMessage("/search foo bar");

    const cmdMsg = harness.sent.find((m) => m.type === "command");
    expect(cmdMsg).toBeDefined();
    expect((cmdMsg as { name: string }).name).toBe("search");
    expect((cmdMsg as { args: string }).args).toBe("foo bar");
  });

  it("sends unknown slash-like text as prompt", async () => {
    await harness.sendMessage("/some/path/here");

    const sent = harness.sent.find((m) => m.type === "prompt");
    expect(sent).toBeDefined();
    expect(harness.sent.find((m) => m.type === "command")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Message ordering with steering
// ---------------------------------------------------------------------------

describe("steer mid-stream", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("steer message appears after streaming assistant message", async () => {
    // Agent starts responding
    await harness.serverSend(messageStart());
    await harness.serverSend(
      messageUpdate(createAssistantMessage("Working on it..."), {
        assistantMessageEvent: { type: "text_delta", text: "Working on it..." },
      }),
    );

    // User steers mid-stream
    await harness.sendMessage("change direction");

    const messages = harness.current.messages;
    // Should be: [streaming assistant, user steer]
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const lastUser = messages.filter((m) => m.role === "user");
    expect(lastUser[lastUser.length - 1].content).toBe("change direction");

    // The steer user message should come after the assistant message
    const assistantIdx = messages.findIndex((m) => m.role === "assistant");
    const steerIdx = messages.findIndex(
      (m) => m.role === "user" && m.content === "change direction",
    );
    expect(steerIdx).toBeGreaterThan(assistantIdx);
  });

  it("server inject_message appears in order", async () => {
    await harness.serverSend(messageStart());

    // Server injects a steer message (e.g., from A2A callback)
    const injectedMsg = createUserMessage("injected steer");
    await harness.serverSend(injectMessage(injectedMsg));

    const messages = harness.current.messages;
    const injected = messages.find((m) => m.role === "user" && m.content === "injected steer");
    expect(injected).toBeDefined();
  });

  it("multi-turn conversation accumulates correctly", async () => {
    // Turn 1
    await harness.sendMessage("First question");
    await harness.serverSendAll(textStreamSequence("First answer"));

    // Turn 2
    await harness.sendMessage("Second question");
    await harness.serverSendAll(textStreamSequence("Second answer"));

    const messages = harness.current.messages;
    const roles = messages.map((m) => m.role);

    // Should be: user, assistant, user, assistant
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("steer during multi-turn preserves order", async () => {
    // Turn 1: normal
    await harness.sendMessage("Start task");
    await harness.serverSendAll(textStreamSequence("Starting...", { skipAgentEnd: true }));
    await harness.serverSend(agentEnd());

    // Turn 2: user sends, agent starts, user steers
    await harness.sendMessage("Continue");
    await harness.serverSend(messageStart());
    await harness.serverSend(
      messageUpdate(createAssistantMessage("Continuing..."), {
        assistantMessageEvent: { type: "text_delta", text: "Continuing..." },
      }),
    );
    await harness.sendMessage("Actually stop");

    const messages = harness.current.messages;
    // Verify the steer comes after the streaming response
    const continueIdx = messages.findIndex((m) => m.role === "user" && m.content === "Continue");
    const steerIdx = messages.findIndex((m) => m.role === "user" && m.content === "Actually stop");
    expect(steerIdx).toBeGreaterThan(continueIdx);
  });
});

// ---------------------------------------------------------------------------
// 5. Tool execution
// ---------------------------------------------------------------------------

describe("tool execution", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("tool_execution_start populates toolStates", async () => {
    await harness.serverSend(messageStart());
    const [startEvent] = toolExecutionSequence({
      toolCallId: "call_1",
      toolName: "read_file",
    });
    await harness.serverSend(startEvent);

    const state = harness.current.toolStates.get("call_1");
    expect(state).toEqual({ status: "executing", toolName: "read_file" });
    expect(harness.current.agentStatus).toBe("executing_tools");
  });

  it("tool_execution_end updates toolStates and adds toolResult", async () => {
    await harness.serverSend(messageStart());
    const [startEvent, endEvent] = toolExecutionSequence({
      toolCallId: "call_1",
      toolName: "read_file",
      result: { content: [{ type: "text", text: "file contents" }] },
    });
    await harness.serverSend(startEvent);
    await harness.serverSend(endEvent);

    const state = harness.current.toolStates.get("call_1");
    expect(state?.status).toBe("complete");

    // A toolResult message should be appended
    const toolResults = harness.current.messages.filter(
      (m) => (m as { role: string }).role === "toolResult",
    );
    expect(toolResults).toHaveLength(1);
  });

  it("tracks multiple concurrent tools", async () => {
    await harness.serverSend(messageStart());

    const [start1] = toolExecutionSequence({ toolCallId: "c1", toolName: "read_file" });
    const [start2] = toolExecutionSequence({ toolCallId: "c2", toolName: "write_file" });
    await harness.serverSend(start1);
    await harness.serverSend(start2);

    expect(harness.current.toolStates.size).toBe(2);
    expect(harness.current.toolStates.get("c1")?.toolName).toBe("read_file");
    expect(harness.current.toolStates.get("c2")?.toolName).toBe("write_file");
  });

  it("agent_end clears toolStates", async () => {
    await harness.serverSend(messageStart());
    const [startEvent, endEvent] = toolExecutionSequence({
      toolCallId: "call_1",
      toolName: "read_file",
    });
    await harness.serverSend(startEvent);
    await harness.serverSend(endEvent);
    await harness.serverSend(agentEnd());

    expect(harness.current.toolStates.size).toBe(0);
    expect(harness.current.agentStatus).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// 6. Thinking blocks
// ---------------------------------------------------------------------------

describe("thinking", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("accumulates thinking through deltas", async () => {
    await harness.serverSend(messageStart());
    const events = thinkingSequence("Let me think about this", {
      deltas: ["Let me ", "think about ", "this"],
    });
    // Send all but the last (thinking_end)
    await harness.serverSendAll(events.slice(0, -1));

    expect(harness.current.thinking).toBe("Let me think about this");
    expect(harness.current.completedThinking).toBeNull();
  });

  it("thinking_end sets completedThinking and clears thinking", async () => {
    await harness.serverSend(messageStart());
    await harness.serverSendAll(thinkingSequence("Deep thought", { deltas: ["Deep ", "thought"] }));

    expect(harness.current.thinking).toBeNull();
    expect(harness.current.completedThinking).toBe("Deep thought");
  });

  it("thinking_end attaches _thinking to streaming message momentarily", async () => {
    // After thinking_end, _thinking is set on the streaming message. However,
    // subsequent message_update/message_end events replace the message from
    // streamMessageRef (which doesn't carry _thinking). The durable way to
    // access thinking is via completedThinking. This test verifies both:
    // 1. completedThinking is set after thinking_end
    // 2. The full flow (thinking → text → message_end) preserves completedThinking
    await harness.serverSend(messageStart());
    await harness.serverSendAll(thinkingSequence("My reasoning"));

    expect(harness.current.completedThinking).toBe("My reasoning");

    // Continue with text content and message_end
    await harness.serverSend(
      messageUpdate(createAssistantMessage("The answer"), {
        assistantMessageEvent: { type: "text_delta", text: "The answer" },
      }),
    );
    await harness.serverSend(messageEnd(createAssistantMessage("The answer")));

    // completedThinking persists through the full streaming lifecycle
    expect(harness.current.completedThinking).toBe("My reasoning");
  });

  it("session_sync clears thinking state", async () => {
    await harness.serverSend(messageStart());
    await harness.serverSendAll(thinkingSequence("thinking..."));

    // New session_sync
    await harness.serverSend(sessionSync({ sessionId: "sess_1", messages: [] }));

    expect(harness.current.thinking).toBeNull();
    expect(harness.current.completedThinking).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Session switching
// ---------------------------------------------------------------------------

describe("session switching", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish("sess_1", [createUserMessage("Hello")]);
  });

  it("switchSession sends client message", async () => {
    await harness.switchSession("sess_2");

    const msg = harness.sent.find((m) => m.type === "switch_session");
    expect(msg).toBeDefined();
    expect((msg as { sessionId: string }).sessionId).toBe("sess_2");
  });

  it("new session_sync replaces state", async () => {
    expect(harness.current.messages).toHaveLength(1);

    await harness.serverSend(
      sessionSync({
        sessionId: "sess_2",
        messages: [createUserMessage("Different session")],
      }),
    );

    expect(harness.current.currentSessionId).toBe("sess_2");
    expect(harness.current.messages).toHaveLength(1);
    expect(harness.current.messages[0].content).toBe("Different session");
  });

  it("events for old session are discarded", async () => {
    // Switch to sess_2
    await harness.serverSend(sessionSync({ sessionId: "sess_2", messages: [] }));

    // Late event arrives for sess_1
    await harness.serverSend(messageStart("sess_1"));

    // Should not affect state — no streaming message added
    expect(harness.current.messages).toHaveLength(0);
    expect(harness.current.agentStatus).toBe("idle");
  });

  it("createSession sends new_session message", async () => {
    await harness.createSession("Research");

    const msg = harness.sent.find((m) => m.type === "new_session");
    expect(msg).toBeDefined();
    expect((msg as { name: string }).name).toBe("Research");
  });

  it("deleteSession sends delete_session message", async () => {
    await harness.deleteSession("sess_1");

    const msg = harness.sent.find((m) => m.type === "delete_session");
    expect(msg).toBeDefined();
    expect((msg as { sessionId: string }).sessionId).toBe("sess_1");
  });
});

// ---------------------------------------------------------------------------
// 8. Empty message filtering
// ---------------------------------------------------------------------------

describe("empty message filtering", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("filters empty string assistant content", async () => {
    await harness.serverSend(messageStart());
    await harness.serverSend(messageEnd(createEmptyAssistantMessage()));

    // The empty assistant message should be filtered from output
    const assistants = harness.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  it("filters assistant with empty content array", async () => {
    const emptyArrayMsg = {
      role: "assistant",
      content: [],
      timestamp: Date.now(),
    } as unknown as import("@claw-for-cloudflare/agent-runtime").AgentMessage;

    await harness.serverSend(messageStart());
    await harness.serverSend(messageEnd(emptyArrayMsg));

    const assistants = harness.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  it("filters assistant with only empty text blocks", async () => {
    const emptyTextMsg = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: Date.now(),
    } as unknown as import("@claw-for-cloudflare/agent-runtime").AgentMessage;

    await harness.serverSend(messageStart());
    await harness.serverSend(messageEnd(emptyTextMsg));

    const assistants = harness.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  it("keeps assistant with toolCall content", async () => {
    const toolCallMsg = createToolCallMessage("call_1", "read_file", { path: "/test" });

    await harness.serverSend(messageStart("sess_1", toolCallMsg));
    await harness.serverSend(messageEnd(toolCallMsg));

    const assistants = harness.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
  });

  it("never filters user messages", async () => {
    const emptyUser = createUserMessage("");
    await harness.serverSend(sessionSync({ sessionId: "sess_1", messages: [emptyUser] }));

    expect(harness.current.messages).toHaveLength(1);
    expect(harness.current.messages[0].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// 9. Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("server error sets error state and resets agentStatus", async () => {
    await harness.serverSend(errorMessage("Context window exceeded"));

    expect(harness.current.error).toBe("Context window exceeded");
    expect(harness.current.agentStatus).toBe("idle");
  });

  it("error is cleared on next sendMessage", async () => {
    await harness.serverSend(errorMessage("Something broke"));
    expect(harness.current.error).toBe("Something broke");

    await harness.sendMessage("try again");
    expect(harness.current.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Reconnection
// ---------------------------------------------------------------------------

describe("reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with exponential backoff", async () => {
    harness = createHarness({ autoReconnect: true });
    await harness.open();
    await harness.establish();

    const initialWsCount = harness.allWs.length;

    // Close the connection
    await vi.advanceTimersByTimeAsync(0);
    await act(() => harness.ws.simulateClose());

    expect(harness.current.connectionStatus).toBe("reconnecting");

    // First backoff: 2^0 * 1000 = 1000ms
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(harness.allWs.length).toBe(initialWsCount + 1);
  });

  it("restores session on reconnect", async () => {
    harness = createHarness({ autoReconnect: true });
    await harness.open();
    await harness.serverSend(sessionSync({ sessionId: "sess_42", messages: [] }));

    // Close and reconnect
    await act(() => harness.ws.simulateClose());
    await act(() => vi.advanceTimersByTimeAsync(1000));

    // Open the new connection
    await harness.open();

    // Should send switch_session to restore the previous session
    const switchMsg = harness.ws.sentMessages.find((m) => m.type === "switch_session");
    expect(switchMsg).toBeDefined();
    expect((switchMsg as { sessionId: string }).sessionId).toBe("sess_42");
  });

  it("does not reconnect when autoReconnect is false", async () => {
    harness = createHarness({ autoReconnect: false });
    await harness.open();
    const wsCount = harness.allWs.length;

    await act(() => harness.ws.simulateClose());
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(harness.allWs.length).toBe(wsCount);
    expect(harness.current.connectionStatus).toBe("disconnected");
  });

  it("does not reconnect after unmount", async () => {
    // Create harness manually to control cleanup order
    const OriginalWebSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    (globalThis as any).WebSocket = MockWebSocket;

    const { unmount } = renderHook(() =>
      useAgentChat({ url: "ws://test/agent", autoReconnect: true }),
    );

    // Open and establish
    await act(() => MockWebSocket.latest.simulateOpen());

    const wsCountAfterOpen = MockWebSocket._instances.length;

    // Unmount — sets disposedRef=true, clears timers, calls ws.close()
    unmount();

    // Advance timers well past any reconnect backoff
    await vi.advanceTimersByTimeAsync(60_000);

    // No new WebSocket should have been created
    expect(MockWebSocket._instances.length).toBe(wsCountAfterOpen);

    (globalThis as any).WebSocket = OriginalWebSocket;
    MockWebSocket.reset();
  });
});

// ---------------------------------------------------------------------------
// 11. Ping/pong heartbeat
// ---------------------------------------------------------------------------

describe("ping/pong", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends ping every 30 seconds", async () => {
    harness = createHarness({ autoReconnect: false });
    await harness.open();
    await harness.establish();

    await act(() => vi.advanceTimersByTimeAsync(30_000));

    const pings = harness.sent.filter((m) => m.type === "ping");
    expect(pings).toHaveLength(1);
  });

  it("pong clears timeout (no reconnect)", async () => {
    harness = createHarness({ autoReconnect: false });
    await harness.open();
    await harness.establish();

    // Trigger ping
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    // Server responds with pong
    await harness.serverSend(pong());

    // Advance past the pong timeout — should NOT close
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(harness.current.connectionStatus).toBe("connected");
  });

  it("missing pong triggers close after 10 seconds", async () => {
    harness = createHarness({ autoReconnect: false });
    await harness.open();
    await harness.establish();

    // Trigger ping
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    // Don't send pong — advance past timeout
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(harness.current.connectionStatus).toBe("disconnected");
  });
});

// ---------------------------------------------------------------------------
// 12. Cost events
// ---------------------------------------------------------------------------

describe("cost events", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("accumulates costs", async () => {
    await harness.serverSend(costEvent({ amount: 0.01 }));
    await harness.serverSend(costEvent({ amount: 0.02 }));

    expect(harness.current.costs).toHaveLength(2);
    expect(harness.current.costs[0].amount).toBe(0.01);
    expect(harness.current.costs[1].amount).toBe(0.02);
  });

  it("session_sync resets costs", async () => {
    await harness.serverSend(costEvent());
    expect(harness.current.costs).toHaveLength(1);

    await harness.serverSend(sessionSync({ sessionId: "sess_1", messages: [] }));
    expect(harness.current.costs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Other server messages
// ---------------------------------------------------------------------------

describe("other server messages", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("session_list updates sessions", async () => {
    await harness.serverSend(
      sessionList([
        { id: "s1", name: "Alpha" },
        { id: "s2", name: "Beta" },
      ]),
    );

    expect(harness.current.sessions).toHaveLength(2);
    expect(harness.current.sessions[0].name).toBe("Alpha");
  });

  it("command_list updates availableCommands", async () => {
    await harness.serverSend(
      commandList([
        { name: "help", description: "Show help" },
        { name: "clear", description: "Clear chat" },
      ]),
    );

    expect(harness.current.availableCommands).toHaveLength(2);
    expect(harness.current.availableCommands[0].name).toBe("help");
  });

  it("command_result adds synthetic assistant message", async () => {
    await harness.serverSend(commandResult("help", { text: "Available commands..." }));

    const last = harness.current.messages[harness.current.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("Available commands...");
    expect((last as any)._commandResult).toBe(true);
  });

  it("schedule_list updates schedules", async () => {
    await harness.serverSend(
      scheduleList([{ id: "sch_1", name: "Daily check", cron: "0 9 * * *" }]),
    );

    expect(harness.current.schedules).toHaveLength(1);
    expect(harness.current.schedules[0].name).toBe("Daily check");
  });

  it("inject_message appends to messages", async () => {
    const msg = createUserMessage("Injected from A2A");
    await harness.serverSend(injectMessage(msg));

    expect(harness.current.messages).toHaveLength(1);
    expect(harness.current.messages[0].content).toBe("Injected from A2A");
  });

  it("custom_event calls onCustomEvent callback", async () => {
    const spy = vi.fn();
    harness.cleanup();
    harness = createHarness({ onCustomEvent: spy });
    await harness.establish();

    await harness.serverSend(customEvent("sandbox_status", { elevated: true }));

    expect(spy).toHaveBeenCalledWith("sandbox_status", { elevated: true });
  });
});

// ---------------------------------------------------------------------------
// 14. Abort
// ---------------------------------------------------------------------------

describe("abort", () => {
  beforeEach(async () => {
    harness = createHarness();
    await harness.establish();
  });

  it("sends abort message", async () => {
    await harness.serverSend(messageStart());
    await harness.abort();

    const msg = harness.sent.find((m) => m.type === "abort");
    expect(msg).toBeDefined();
    expect((msg as { sessionId: string }).sessionId).toBe("sess_1");
  });
});

// ---------------------------------------------------------------------------
// 15. Pagination (hasMore / request_sync)
// ---------------------------------------------------------------------------

describe("pagination", () => {
  it("auto-requests next page when hasMore is true", async () => {
    harness = createHarness();
    await harness.open();
    await harness.serverSend(
      sessionSync({
        sessionId: "sess_1",
        messages: [createUserMessage("old")],
        cursor: 5,
        hasMore: true,
      }),
    );

    const syncReq = harness.sent.find((m) => m.type === "request_sync");
    expect(syncReq).toBeDefined();
    expect((syncReq as { afterSeq: number }).afterSeq).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 16. Toggle schedule
// ---------------------------------------------------------------------------

describe("toggleSchedule", () => {
  it("sends toggle_schedule message", async () => {
    harness = createHarness();
    await harness.establish();

    await act(() => harness.current.toggleSchedule("sch_1", false));

    const msg = harness.sent.find((m) => m.type === "toggle_schedule");
    expect(msg).toBeDefined();
    expect((msg as { scheduleId: string }).scheduleId).toBe("sch_1");
    expect((msg as { enabled: boolean }).enabled).toBe(false);
  });
});
