import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@claw-for-cloudflare/ai";
import { runAgentLoop, runAgentLoopContinue } from "../agent-loop.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "../types.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TEST_MODEL: Model<any> = {
  id: "test-model",
  api: "openai-completions",
  provider: "test",
  name: "Test",
  baseUrl: "https://test.example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 4096,
  contextWindow: 8192,
};

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: { ...ZERO_USAGE },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeUserMessage(text = "hi"): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

/**
 * Creates a mock StreamFn that returns a pre-built AssistantMessage.
 * Optionally accepts a sequence of messages for multi-turn scenarios.
 */
function createMockStreamFn(...responses: AssistantMessage[]): StreamFn {
  let callIndex = 0;
  return (() => {
    const msg = responses[Math.min(callIndex++, responses.length - 1)];
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: msg });
    stream.push({
      type: "done",
      reason: msg.stopReason === "stop" ? "stop" : "stop",
      message: msg,
    } as AssistantMessageEvent);
    return stream;
  }) as StreamFn;
}

function makeConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    model: TEST_MODEL,
    convertToLlm: (msgs) =>
      msgs.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
    ...overrides,
  };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    systemPrompt: "",
    messages: [],
    tools: [],
    ...overrides,
  };
}

function collectEvents(emit: AgentEvent[]): (e: AgentEvent) => void {
  return (e) => {
    emit.push(e);
  };
}

describe("defaultConvertToLlm (via config.convertToLlm)", () => {
  const convert = makeConfig().convertToLlm;

  it("keeps user messages", () => {
    const result = convert([makeUserMessage()]);
    expect(result).toHaveLength(1);
  });

  it("keeps assistant messages", () => {
    const msg = makeAssistantMessage();
    const result = convert([msg]);
    expect(result).toHaveLength(1);
  });

  it("keeps toolResult messages", () => {
    const msg = {
      role: "toolResult" as const,
      toolCallId: "tc1",
      toolName: "test",
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    };
    const result = convert([msg]);
    expect(result).toHaveLength(1);
  });

  it("filters out unknown roles", () => {
    const custom = { role: "notification", content: [], timestamp: Date.now() } as any;
    const result = convert([makeUserMessage(), custom]);
    expect(result).toHaveLength(1);
  });
});

describe("isTransientError (via retry behavior)", () => {
  const transientMessages = [
    "Error 429: rate limit exceeded",
    "Request failed with status 500",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "Error 529",
    "Connection timeout waiting for response",
    "ECONNRESET on socket",
    "ECONNREFUSED 127.0.0.1:443",
    "network error: fetch failed",
    "Server is overloaded",
    "Rate limit hit",
    "rate-limit exceeded",
  ];

  /** Creates a streamFn that fails on first call with errorMsg, then succeeds. */
  function createRetryStreamFn(errorMsg: string) {
    let callCount = 0;
    const errorResponse = makeAssistantMessage({ stopReason: "error", errorMessage: errorMsg });
    const successResponse = makeAssistantMessage({ stopReason: "stop" });
    const streamFn = (() => {
      callCount++;
      const msg = callCount === 1 ? errorResponse : successResponse;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: msg });
      if (msg.stopReason === "error") {
        stream.push({ type: "error", reason: "error", error: msg } as AssistantMessageEvent);
      } else {
        stream.push({ type: "done", reason: "stop", message: msg } as AssistantMessageEvent);
      }
      return stream;
    }) as StreamFn;
    return { streamFn, getCallCount: () => callCount };
  }

  for (const errorMsg of transientMessages) {
    it(`retries on transient error: "${errorMsg}"`, async () => {
      const { streamFn, getCallCount } = createRetryStreamFn(errorMsg);
      const events: AgentEvent[] = [];
      await runAgentLoop(
        [makeUserMessage()],
        makeContext(),
        makeConfig({
          maxStreamRetries: 2,
          baseRetryDelayMs: 1,
          getSteeringMessages: async () => [],
        }),
        collectEvents(events),
        undefined,
        streamFn,
      );
      expect(getCallCount()).toBe(2);
      expect(events.find((e) => e.type === "agent_end")).toBeDefined();
    });
  }

  it("does not retry on non-transient error", async () => {
    let callCount = 0;
    const errorResponse = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "Invalid API key",
    });

    const streamFn = (() => {
      callCount++;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: errorResponse });
      stream.push({
        type: "error",
        reason: "error",
        error: errorResponse,
      } as AssistantMessageEvent);
      return stream;
    }) as StreamFn;

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext(),
      makeConfig({ maxStreamRetries: 2, baseRetryDelayMs: 1, getSteeringMessages: async () => [] }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    expect(callCount).toBe(1);
  });

  it("respects maxStreamRetries limit", async () => {
    let callCount = 0;
    const errorResponse = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    });

    const streamFn = (() => {
      callCount++;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: errorResponse });
      stream.push({
        type: "error",
        reason: "error",
        error: errorResponse,
      } as AssistantMessageEvent);
      return stream;
    }) as StreamFn;

    await runAgentLoop(
      [makeUserMessage()],
      makeContext(),
      makeConfig({ maxStreamRetries: 3, baseRetryDelayMs: 1, getSteeringMessages: async () => [] }),
      () => {},
      undefined,
      streamFn,
    );

    // 1 initial + 3 retries = 4
    expect(callCount).toBe(4);
  });

  it("stops retrying on abort", async () => {
    let callCount = 0;
    const controller = new AbortController();
    const errorResponse = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    });

    const streamFn = (() => {
      callCount++;
      if (callCount === 1) controller.abort();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: errorResponse });
      stream.push({
        type: "error",
        reason: "error",
        error: errorResponse,
      } as AssistantMessageEvent);
      return stream;
    }) as StreamFn;

    await runAgentLoop(
      [makeUserMessage()],
      makeContext(),
      makeConfig({ maxStreamRetries: 5, baseRetryDelayMs: 1, getSteeringMessages: async () => [] }),
      () => {},
      controller.signal,
      streamFn,
    );

    expect(callCount).toBe(1);
  });
});

describe("tool preparation", () => {
  function makeToolCallResponse(toolName: string, args: Record<string, unknown>): AssistantMessage {
    return makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: toolName,
          arguments: args,
        } as any,
      ],
      stopReason: "toolUse",
    });
  }

  it("emits error tool result for unknown tool", async () => {
    const streamFn = createMockStreamFn(
      makeToolCallResponse("nonexistent", {}),
      makeAssistantMessage(), // follow-up stop
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [] }),
      makeConfig({ getSteeringMessages: async () => [] }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find(
      (e) => e.type === "tool_execution_end" && e.toolName === "nonexistent",
    );
    expect(toolEnd).toBeDefined();
    expect((toolEnd as any).isError).toBe(true);
    expect((toolEnd as any).result.content[0].text).toContain("not found");
  });

  it("emits error tool result when beforeToolCall blocks", async () => {
    const tool: AgentTool<any> = {
      name: "my_tool",
      label: "My Tool",
      description: "A test tool",
      parameters: Type.Object({}),
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("my_tool", {}),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        beforeToolCall: async () => ({ block: true, reason: "Not allowed" }),
        getSteeringMessages: async () => [],
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "my_tool");
    expect(toolEnd).toBeDefined();
    expect((toolEnd as any).isError).toBe(true);
    expect((toolEnd as any).result.content[0].text).toBe("Not allowed");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("uses default block message when beforeToolCall omits reason", async () => {
    const tool: AgentTool<any> = {
      name: "my_tool",
      label: "My Tool",
      description: "test",
      parameters: Type.Object({}),
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("my_tool", {}),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        beforeToolCall: async () => ({ block: true }),
        getSteeringMessages: async () => [],
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "my_tool");
    expect((toolEnd as any).result.content[0].text).toBe("Tool execution was blocked");
  });

  it("executes tool when beforeToolCall does not block", async () => {
    const tool: AgentTool<any> = {
      name: "my_tool",
      label: "My Tool",
      description: "test",
      parameters: Type.Object({ name: Type.String() }),
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        details: { success: true },
      }),
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("my_tool", { name: "test" }),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        beforeToolCall: async () => undefined,
        getSteeringMessages: async () => [],
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    expect(tool.execute).toHaveBeenCalledOnce();
    const toolEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "my_tool");
    expect((toolEnd as any).isError).toBe(false);
  });
});

describe("afterToolCall hook", () => {
  function makeToolCallResponse(toolName: string, args: Record<string, unknown>): AssistantMessage {
    return makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: toolName,
          arguments: args,
        } as any,
      ],
      stopReason: "toolUse",
    });
  }

  it("can override tool result content", async () => {
    const tool: AgentTool<any> = {
      name: "my_tool",
      label: "My Tool",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "original" }],
        details: {},
      }),
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("my_tool", {}),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        afterToolCall: async () => ({
          content: [{ type: "text", text: "modified" }],
        }),
        getSteeringMessages: async () => [],
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "my_tool");
    expect((toolEnd as any).result.content[0].text).toBe("modified");
  });

  it("can override isError flag", async () => {
    const tool: AgentTool<any> = {
      name: "my_tool",
      label: "My Tool",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("my_tool", {}),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        afterToolCall: async () => ({ isError: true }),
        getSteeringMessages: async () => [],
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "my_tool");
    expect((toolEnd as any).isError).toBe(true);
  });

  it("keeps original values when afterToolCall returns undefined", async () => {
    const tool: AgentTool<any> = {
      name: "my_tool",
      label: "My Tool",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "original" }],
        details: { key: "val" },
      }),
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("my_tool", {}),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        afterToolCall: async () => undefined,
        getSteeringMessages: async () => [],
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "my_tool");
    expect((toolEnd as any).result.content[0].text).toBe("original");
    expect((toolEnd as any).isError).toBe(false);
  });
});

describe("tool execution errors", () => {
  function makeToolCallResponse(toolName: string): AssistantMessage {
    return makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: toolName,
          arguments: {},
        } as any,
      ],
      stopReason: "toolUse",
    });
  }

  it("catches tool execute() throws and emits error result", async () => {
    const tool: AgentTool<any> = {
      name: "failing_tool",
      label: "Failing",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("tool crashed");
      },
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("failing_tool"),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({ getSteeringMessages: async () => [] }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find(
      (e) => e.type === "tool_execution_end" && e.toolName === "failing_tool",
    );
    expect(toolEnd).toBeDefined();
    expect((toolEnd as any).isError).toBe(true);
    expect((toolEnd as any).result.content[0].text).toBe("tool crashed");
  });

  it("handles non-Error throws from execute()", async () => {
    const tool: AgentTool<any> = {
      name: "string_throw",
      label: "Throws String",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => {
        throw "string error";
      },
    };

    const streamFn = createMockStreamFn(
      makeToolCallResponse("string_throw"),
      makeAssistantMessage(),
    );

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({ getSteeringMessages: async () => [] }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolEnd = events.find(
      (e) => e.type === "tool_execution_end" && e.toolName === "string_throw",
    );
    expect((toolEnd as any).result.content[0].text).toBe("string error");
  });
});

describe("runAgentLoopContinue", () => {
  it("throws on empty context", async () => {
    await expect(
      runAgentLoopContinue(makeContext({ messages: [] }), makeConfig(), () => {}),
    ).rejects.toThrow("Cannot continue: no messages in context");
  });

  it("throws when last message is assistant", async () => {
    await expect(
      runAgentLoopContinue(
        makeContext({ messages: [makeAssistantMessage()] }),
        makeConfig(),
        () => {},
      ),
    ).rejects.toThrow("Cannot continue from message role: assistant");
  });

  it("runs from toolResult context", async () => {
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "tc1",
      toolName: "test",
      content: [{ type: "text" as const, text: "result" }],
      isError: false,
      timestamp: Date.now(),
    };

    const streamFn = createMockStreamFn(makeAssistantMessage());
    const events: AgentEvent[] = [];
    await runAgentLoopContinue(
      makeContext({
        messages: [
          makeUserMessage(),
          makeAssistantMessage({ stopReason: "toolUse" } as any),
          toolResult,
        ],
      }),
      makeConfig({ getSteeringMessages: async () => [] }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    expect(events.some((e) => e.type === "agent_end")).toBe(true);
  });
});

describe("max iterations", () => {
  it("terminates after maxIterations and emits error", async () => {
    // Create a stream that always returns tool calls (never stops)
    const toolCallMsg = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "tc-loop",
          name: "always_call",
          arguments: {},
        } as any,
      ],
      stopReason: "toolUse",
    });

    const tool: AgentTool<any> = {
      name: "always_call",
      label: "Loop",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    let callCount = 0;
    const streamFn = (() => {
      callCount++;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: toolCallMsg });
      stream.push({
        type: "done",
        reason: "toolUse" as any,
        message: toolCallMsg,
      } as AssistantMessageEvent);
      return stream;
    }) as StreamFn;

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        maxIterations: 3,
        getSteeringMessages: async () => [],
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    // Should have terminated, not run indefinitely
    expect(callCount).toBeLessThanOrEqual(4); // 3 iterations + buffer
    const agentEnd = events.find((e) => e.type === "agent_end");
    expect(agentEnd).toBeDefined();
  });
});

describe("steering messages", () => {
  it("injects steering messages between turns", async () => {
    let turnCount = 0;
    const toolCallMsg = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "my_tool",
          arguments: {},
        } as any,
      ],
      stopReason: "toolUse",
    });

    const tool: AgentTool<any> = {
      name: "my_tool",
      label: "Tool",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    };

    const steeringMsg = makeUserMessage("steer!");
    let steeringDelivered = false;

    const streamFn = (() => {
      turnCount++;
      const msg = turnCount <= 1 ? toolCallMsg : makeAssistantMessage();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: msg });
      stream.push({
        type: msg.stopReason === "toolUse" ? "done" : "done",
        reason: msg.stopReason === "toolUse" ? ("toolUse" as any) : "stop",
        message: msg,
      } as AssistantMessageEvent);
      return stream;
    }) as StreamFn;

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({
        getSteeringMessages: async () => {
          if (!steeringDelivered) {
            steeringDelivered = true;
            return [steeringMsg];
          }
          return [];
        },
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    // The steering message should appear in events
    const steerEvents = events.filter(
      (e) =>
        e.type === "message_end" &&
        (e.message as any)?.role === "user" &&
        (e.message as any)?.content?.[0]?.text === "steer!",
    );
    expect(steerEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("follow-up messages", () => {
  it("processes follow-up messages after agent would stop", async () => {
    let turnCount = 0;
    let followUpDelivered = false;

    const streamFn = (() => {
      turnCount++;
      const msg = makeAssistantMessage();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: "stop", message: msg } as AssistantMessageEvent);
      return stream;
    }) as StreamFn;

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [makeUserMessage()],
      makeContext(),
      makeConfig({
        getSteeringMessages: async () => [],
        getFollowUpMessages: async () => {
          if (!followUpDelivered) {
            followUpDelivered = true;
            return [makeUserMessage("follow-up!")];
          }
          return [];
        },
      }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    // Should have processed 2 turns (initial + follow-up)
    expect(turnCount).toBe(2);
  });
});

describe("sequential tool execution", () => {
  it("executes tools one at a time in order", async () => {
    const executionOrder: string[] = [];

    const toolA: AgentTool<any> = {
      name: "tool_a",
      label: "A",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => {
        executionOrder.push("a");
        return { content: [{ type: "text", text: "a done" }], details: {} };
      },
    };

    const toolB: AgentTool<any> = {
      name: "tool_b",
      label: "B",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => {
        executionOrder.push("b");
        return { content: [{ type: "text", text: "b done" }], details: {} };
      },
    };

    const multiToolMsg = makeAssistantMessage({
      content: [
        { type: "toolCall", id: "tc-a", name: "tool_a", arguments: {} } as any,
        { type: "toolCall", id: "tc-b", name: "tool_b", arguments: {} } as any,
      ],
      stopReason: "toolUse",
    });

    const streamFn = createMockStreamFn(multiToolMsg, makeAssistantMessage());

    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [toolA, toolB] }),
      makeConfig({
        toolExecution: "sequential",
        getSteeringMessages: async () => [],
      }),
      () => {},
      undefined,
      streamFn,
    );

    expect(executionOrder).toEqual(["a", "b"]);
  });
});

describe("event lifecycle", () => {
  it("emits agent_start, turn_start, message events, agent_end in order", async () => {
    const streamFn = createMockStreamFn(makeAssistantMessage());
    const events: AgentEvent[] = [];

    await runAgentLoop(
      [makeUserMessage()],
      makeContext(),
      makeConfig({ getSteeringMessages: async () => [] }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_start");
    expect(types[1]).toBe("turn_start");
    expect(types).toContain("message_start");
    expect(types).toContain("message_end");
    expect(types[types.length - 1]).toBe("agent_end");
  });

  it("emits tool_execution_start and tool_execution_end for tool calls", async () => {
    const tool: AgentTool<any> = {
      name: "echo",
      label: "Echo",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "echoed" }],
        details: {},
      }),
    };

    const toolCallMsg = makeAssistantMessage({
      content: [{ type: "toolCall", id: "tc-1", name: "echo", arguments: {} } as any],
      stopReason: "toolUse",
    });

    const streamFn = createMockStreamFn(toolCallMsg, makeAssistantMessage());
    const events: AgentEvent[] = [];

    await runAgentLoop(
      [makeUserMessage()],
      makeContext({ tools: [tool] }),
      makeConfig({ getSteeringMessages: async () => [] }),
      collectEvents(events),
      undefined,
      streamFn,
    );

    const toolStart = events.find((e) => e.type === "tool_execution_start");
    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    expect((toolStart as any).toolName).toBe("echo");
    expect((toolEnd as any).toolName).toBe("echo");
  });
});

describe("transformContext", () => {
  it("transforms context before convertToLlm", async () => {
    const transformContext = vi.fn(async (msgs: AgentMessage[]) => {
      // Add a synthetic system note
      return [
        ...msgs,
        {
          role: "user",
          content: [{ type: "text", text: "injected" }],
          timestamp: Date.now(),
        } as AgentMessage,
      ];
    });

    const streamFn = createMockStreamFn(makeAssistantMessage());

    await runAgentLoop(
      [makeUserMessage()],
      makeContext(),
      makeConfig({
        transformContext,
        getSteeringMessages: async () => [],
      }),
      () => {},
      undefined,
      streamFn,
    );

    expect(transformContext).toHaveBeenCalledOnce();
  });
});

describe("getApiKey resolution", () => {
  it("calls getApiKey with provider before each stream call", async () => {
    const getApiKey = vi.fn().mockResolvedValue("dynamic-key");

    const streamFn = vi.fn((() => {
      const msg = makeAssistantMessage();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: "stop", message: msg } as AssistantMessageEvent);
      return stream;
    }) as StreamFn);

    await runAgentLoop(
      [makeUserMessage()],
      makeContext(),
      makeConfig({
        getApiKey,
        getSteeringMessages: async () => [],
      }),
      () => {},
      undefined,
      streamFn,
    );

    expect(getApiKey).toHaveBeenCalledWith("test");
    // The resolved key should be passed to streamFn
    const callArgs = (streamFn as any).mock.calls[0];
    expect(callArgs[2].apiKey).toBe("dynamic-key");
  });
});
