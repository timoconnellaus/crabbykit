import type { AssistantMessage, AssistantMessageEvent } from "@claw-for-cloudflare/ai";
import { EventStream } from "@claw-for-cloudflare/ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AssistantMessage. */
function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/** Create an EventStream that immediately resolves with a given AssistantMessage. */
function createMockStream(
  msg: AssistantMessage,
): EventStream<AssistantMessageEvent, AssistantMessage> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("Unexpected");
    },
  );

  stream.push({ type: "start", partial: msg });

  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    stream.push({ type: "error", reason: msg.stopReason, error: msg });
  } else {
    const reason = msg.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
    stream.push({ type: "done", reason, message: msg });
  }

  return stream;
}

/** Create a simple tool that resolves after a delay. */
function makeDelayedTool(
  name: string,
  delayMs: number,
  result: string = "tool output",
  options?: {
    /** Fire onUpdate with this text every updateIntervalMs. */
    updateText?: string;
    updateIntervalMs?: number;
  },
): AgentTool {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: Type.Object({}),
    execute: async (_args, ctx) => {
      const updateInterval =
        options?.updateText && options?.updateIntervalMs
          ? setInterval(() => {
              ctx.onUpdate?.({
                content: [{ type: "text", text: options.updateText! }],
                details: {},
              });
            }, options.updateIntervalMs)
          : null;

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          ctx.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Tool aborted"));
          });
        });
      } finally {
        if (updateInterval) clearInterval(updateInterval);
      }

      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  };
}

/** Build a StreamFn that returns different responses per call. */
function makeStreamFn(responses: AssistantMessage[]): StreamFn {
  let callIndex = 0;
  return () => {
    const msg = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return createMockStream(msg);
  };
}

/** Build a minimal config. */
function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: {
      api: "openai-completions",
      provider: "test",
      id: "test-model",
    } as AgentLoopConfig["model"],
    convertToLlm: (msgs) =>
      msgs.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
    toolExecution: "sequential",
    maxIterations: 20,
    ...overrides,
  };
}

/** Collect all events from a run. */
async function collectEvents(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  streamFn: StreamFn,
  signal?: AbortSignal,
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
  const events: AgentEvent[] = [];
  const messages = await runAgentLoop(
    prompts,
    context,
    config,
    (event) => {
      events.push(event);
    },
    signal,
    streamFn,
  );
  return { events, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("steerable tool execution", () => {
  describe("steerThresholdMs disabled (default)", () => {
    it("does not checkpoint when steerThresholdMs is 0", async () => {
      const tool = makeDelayedTool("fast_tool", 50);

      const assistantMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "fast_tool", arguments: {} }],
        "toolUse",
      );
      const finalMsg = makeAssistantMessage([{ type: "text", text: "Done" }]);

      const streamFn = makeStreamFn([assistantMsg, finalMsg]);
      const config = makeConfig({ steerThresholdMs: 0 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      const checkpointEvents = events.filter((e) => e.type === "tool_execution_checkpoint");
      expect(checkpointEvents).toHaveLength(0);
    });
  });

  describe("tool completes before threshold", () => {
    it("returns tool result without checkpoint", async () => {
      const tool = makeDelayedTool("fast_tool", 20);

      const assistantMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "fast_tool", arguments: {} }],
        "toolUse",
      );
      const finalMsg = makeAssistantMessage([{ type: "text", text: "Done" }]);

      const streamFn = makeStreamFn([assistantMsg, finalMsg]);
      const config = makeConfig({ steerThresholdMs: 500 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      const checkpointEvents = events.filter((e) => e.type === "tool_execution_checkpoint");
      expect(checkpointEvents).toHaveLength(0);

      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as any).isError).toBe(false);
    });
  });

  describe("tool exceeds threshold - model says CONTINUE", () => {
    it("keeps tool running and returns final result", async () => {
      // Tool takes 300ms, threshold at 100ms
      // Could get up to 3 checkpoints, so provide enough CONTINUE responses
      const tool = makeDelayedTool("slow_tool", 300, "final output", {
        updateText: "partial...",
        updateIntervalMs: 50,
      });

      const toolCallMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "slow_tool", arguments: {} }],
        "toolUse",
      );
      const continueMsg = makeAssistantMessage([{ type: "text", text: "CONTINUE" }]);
      const finalMsg = makeAssistantMessage([{ type: "text", text: "All done" }]);

      // Provide many CONTINUE responses so all checkpoints get answered
      const streamFn = makeStreamFn([
        toolCallMsg,
        continueMsg,
        continueMsg,
        continueMsg,
        continueMsg,
        continueMsg,
        finalMsg,
      ]);
      const config = makeConfig({ steerThresholdMs: 100 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      const checkpointEvents = events.filter((e) => e.type === "tool_execution_checkpoint");
      expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);

      // Tool should have completed successfully (not aborted)
      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as any).isError).toBe(false);
    });
  });

  describe("tool exceeds threshold - model says CONTINUE with delay", () => {
    it("parses delay from CONTINUE response", async () => {
      // Tool takes 600ms, threshold at 100ms, model says "CONTINUE 1s"
      const tool = makeDelayedTool("slow_tool", 300, "done");

      const toolCallMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "slow_tool", arguments: {} }],
        "toolUse",
      );
      // CONTINUE 1s means next checkpoint won't fire for 1s, tool finishes in 300ms
      const continueMsg = makeAssistantMessage([{ type: "text", text: "CONTINUE 1s" }]);
      const finalMsg = makeAssistantMessage([{ type: "text", text: "Done" }]);

      const streamFn = makeStreamFn([toolCallMsg, continueMsg, finalMsg]);
      const config = makeConfig({ steerThresholdMs: 100 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      // Should have exactly 1 checkpoint (the CONTINUE delays the next one long enough)
      const checkpointEvents = events.filter((e) => e.type === "tool_execution_checkpoint");
      expect(checkpointEvents).toHaveLength(1);

      // Tool completed naturally
      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as any).isError).toBe(false);
    });
  });

  describe("tool exceeds threshold - model aborts", () => {
    it("aborts tool and returns partial result with checkpoint response", async () => {
      // Tool takes 5000ms, threshold at 100ms
      const tool = makeDelayedTool("hanging_tool", 5000, "never reached", {
        updateText: "waiting...",
        updateIntervalMs: 30,
      });

      const toolCallMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "hanging_tool", arguments: {} }],
        "toolUse",
      );
      // Model responds with text (not CONTINUE) — this triggers abort
      const abortMsg = makeAssistantMessage([
        { type: "text", text: "The tool is stuck. Let me try something else." },
      ]);
      const finalMsg = makeAssistantMessage([{ type: "text", text: "Recovered" }]);

      const streamFn = makeStreamFn([toolCallMsg, abortMsg, finalMsg]);
      const config = makeConfig({ steerThresholdMs: 100 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      const checkpointEvents = events.filter((e) => e.type === "tool_execution_checkpoint");
      expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);

      // Tool should have been marked as error (aborted)
      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as any).isError).toBe(true);
    });
  });

  describe("tool completes during checkpoint inference", () => {
    it("uses tool result and cancels inference", async () => {
      // Tool takes 150ms, threshold at 50ms
      // The checkpoint inference will fire at 50ms, but tool completes at 150ms
      // which should be during inference
      const tool = makeDelayedTool("medium_tool", 150, "real result");

      const toolCallMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "medium_tool", arguments: {} }],
        "toolUse",
      );

      let inferenceCallCount = 0;

      // Create a stream fn where the checkpoint inference takes a long time (500ms)
      const streamFn: StreamFn = () => {
        inferenceCallCount++;
        if (inferenceCallCount === 1) {
          // First call: return tool call
          return createMockStream(toolCallMsg);
        }
        if (inferenceCallCount === 2) {
          // Checkpoint inference: delay before returning so tool can complete first
          const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
              if (event.type === "done") return event.message;
              if (event.type === "error") return event.error;
              throw new Error("Unexpected");
            },
          );
          // Delay the response so the tool finishes first
          const msg = makeAssistantMessage([{ type: "text", text: "CONTINUE" }]);
          setTimeout(() => {
            stream.push({ type: "start", partial: msg });
            stream.push({ type: "done", reason: "stop", message: msg });
          }, 500);
          return stream;
        }
        // Final: text response
        const finalMsg = makeAssistantMessage([{ type: "text", text: "Done" }]);
        return createMockStream(finalMsg);
      };

      const config = makeConfig({ steerThresholdMs: 50 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      // Tool should have completed successfully
      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as any).isError).toBe(false);
      // The tool's actual result should be used
      expect((toolEndEvents[0] as any).result.content[0].text).toBe("real result");
    });
  });

  describe("max checkpoints exceeded", () => {
    it("aborts tool after 5 checkpoints", async () => {
      // Tool takes 1200ms, threshold at 100ms (12 potential checkpoints)
      // After 5 CONTINUE responses, max checkpoints hit, tool is aborted
      const tool = makeDelayedTool("very_slow_tool", 1200, "eventually done");

      const toolCallMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "very_slow_tool", arguments: {} }],
        "toolUse",
      );
      const continueMsg = makeAssistantMessage([{ type: "text", text: "CONTINUE" }]);
      const finalMsg = makeAssistantMessage([{ type: "text", text: "Done" }]);

      // 1 initial + 5 CONTINUE + 1 final = 7 stream calls
      const streamFn = makeStreamFn([
        toolCallMsg,
        continueMsg,
        continueMsg,
        continueMsg,
        continueMsg,
        continueMsg,
        finalMsg,
      ]);

      const config = makeConfig({ steerThresholdMs: 100 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      const checkpointEvents = events.filter((e) => e.type === "tool_execution_checkpoint");
      expect(checkpointEvents).toHaveLength(5);

      // Tool should be aborted after max checkpoints
      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as any).isError).toBe(true);
    });
  });

  describe("abort signal during checkpoint", () => {
    it("propagates abort to both tool and inference", async () => {
      const tool = makeDelayedTool("long_tool", 10000, "never");

      const toolCallMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "long_tool", arguments: {} }],
        "toolUse",
      );

      const abortController = new AbortController();

      let inferenceCallCount = 0;
      const streamFn: StreamFn = () => {
        inferenceCallCount++;
        if (inferenceCallCount === 1) {
          return createMockStream(toolCallMsg);
        }
        // On checkpoint inference, abort the whole thing
        setTimeout(() => abortController.abort(), 20);
        const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
          (event) => event.type === "done" || event.type === "error",
          (event) => {
            if (event.type === "done") return event.message;
            if (event.type === "error") return event.error;
            throw new Error("Unexpected");
          },
        );
        // The stream will be aborted before it resolves
        const abortedMsg = makeAssistantMessage([{ type: "text", text: "" }], "aborted");
        // Give it a bit before pushing the result
        setTimeout(() => {
          stream.push({ type: "error", reason: "aborted", error: abortedMsg });
        }, 50);
        return stream;
      };

      const config = makeConfig({ steerThresholdMs: 50 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
        abortController.signal,
      );

      // Should have at least started the checkpoint
      const checkpointEvents = events.filter((e) => e.type === "tool_execution_checkpoint");
      expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("checkpoint event contents", () => {
    it("includes elapsed time and partial output", async () => {
      const tool = makeDelayedTool("output_tool", 5000, "never", {
        updateText: "progress data here",
        updateIntervalMs: 20,
      });

      const toolCallMsg = makeAssistantMessage(
        [{ type: "toolCall", id: "tc1", name: "output_tool", arguments: {} }],
        "toolUse",
      );
      const abortMsg = makeAssistantMessage([{ type: "text", text: "Aborting." }]);
      const finalMsg = makeAssistantMessage([{ type: "text", text: "Done" }]);

      const streamFn = makeStreamFn([toolCallMsg, abortMsg, finalMsg]);
      const config = makeConfig({ steerThresholdMs: 100 });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      const checkpointEvents = events.filter(
        (e): e is Extract<AgentEvent, { type: "tool_execution_checkpoint" }> =>
          e.type === "tool_execution_checkpoint",
      );
      expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);

      const checkpoint = checkpointEvents[0];
      expect(checkpoint.toolCallId).toBe("tc1");
      expect(checkpoint.toolName).toBe("output_tool");
      expect(checkpoint.elapsed).toBeGreaterThanOrEqual(50); // At least ~100ms (threshold)
      expect(checkpoint.partialOutput).toContain("progress data here");
    });
  });

  describe("parallel tool execution with checkpoint abort", () => {
    it("aborts all tools when any checkpoint results in abort", async () => {
      const fastTool = makeDelayedTool("fast_parallel", 20, "fast result");
      const slowTool = makeDelayedTool("slow_parallel", 5000, "never reached");

      const toolCallMsg = makeAssistantMessage(
        [
          { type: "toolCall", id: "tc1", name: "fast_parallel", arguments: {} },
          { type: "toolCall", id: "tc2", name: "slow_parallel", arguments: {} },
        ],
        "toolUse",
      );
      // The slow tool's checkpoint will trigger an abort
      const abortMsg = makeAssistantMessage([{ type: "text", text: "Let me change approach." }]);
      const finalMsg = makeAssistantMessage([{ type: "text", text: "New plan." }]);

      const streamFn = makeStreamFn([toolCallMsg, abortMsg, finalMsg]);
      const config = makeConfig({
        steerThresholdMs: 100,
        toolExecution: "parallel",
      });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [fastTool, slowTool],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      // Both tools should have ended
      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(2);
    });
  });

  describe("sequential tool calls with abort skips remaining", () => {
    it("skips remaining tool calls when checkpoint aborts", async () => {
      const tool1 = makeDelayedTool("tool_a", 5000, "never");
      const tool2 = makeDelayedTool("tool_b", 20, "b result");

      const toolCallMsg = makeAssistantMessage(
        [
          { type: "toolCall", id: "tc1", name: "tool_a", arguments: {} },
          { type: "toolCall", id: "tc2", name: "tool_b", arguments: {} },
        ],
        "toolUse",
      );
      const abortMsg = makeAssistantMessage([{ type: "text", text: "Switching approach." }]);
      const finalMsg = makeAssistantMessage([{ type: "text", text: "Done" }]);

      const streamFn = makeStreamFn([toolCallMsg, abortMsg, finalMsg]);
      const config = makeConfig({
        steerThresholdMs: 100,
        toolExecution: "sequential",
      });
      const context: AgentContext = {
        systemPrompt: "test",
        messages: [],
        tools: [tool1, tool2],
      };

      const { events } = await collectEvents(
        [{ role: "user", content: "test", timestamp: Date.now() }],
        context,
        config,
        streamFn,
      );

      // Only tool_a should have been executed (tool_b skipped due to checkpoint abort)
      const toolEndEvents = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEndEvents).toHaveLength(1);
      expect((toolEndEvents[0] as any).toolName).toBe("tool_a");
    });
  });
});
