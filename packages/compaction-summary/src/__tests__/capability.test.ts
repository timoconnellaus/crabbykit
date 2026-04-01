import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { CapabilityHookContext } from "@claw-for-cloudflare/agent-runtime";
import { createNoopStorage } from "@claw-for-cloudflare/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactionSummary } from "../capability.js";

// Mock the summarizer module so no real LLM calls are made
vi.mock("../summarize.js", () => ({
  createLlmSummarizer: vi.fn(() => {
    return async (msgs: AgentMessage[], prevSummary?: string) => {
      const count = msgs.length;
      return prevSummary
        ? `${prevSummary}\n[Continued: ${count} messages]`
        : `Summary of ${count} messages`;
    };
  }),
}));

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMsg(content: string): AgentMessage {
  return { role: "assistant", content, timestamp: Date.now() } as unknown as AgentMessage;
}

function createMockSessionStore(messages: AgentMessage[]) {
  const entries = messages.map((m, i) => ({
    id: `e${i}`,
    type: "message" as const,
    data: m,
    parentId: i > 0 ? `e${i - 1}` : null,
    sessionId: "s1",
    seq: i,
    createdAt: new Date().toISOString(),
  }));

  const appendedEntries: any[] = [];

  return {
    getEntries: vi.fn(() => entries),
    appendEntry: vi.fn((_sessionId: string, entry: any) => {
      appendedEntries.push(entry);
    }),
    buildContext: vi.fn(() => {
      // After compaction, return a shortened context
      const summary = appendedEntries.find((e) => e.type === "compaction");
      if (summary) {
        return [
          {
            role: "user",
            content: `[Previous conversation summary]\n${summary.data.summary}`,
            timestamp: Date.now(),
          } as unknown as AgentMessage,
          messages[messages.length - 1],
        ];
      }
      return messages;
    }),
    getAppendedEntries: () => appendedEntries,
  };
}

describe("compactionSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a valid Capability with correct shape", () => {
    const cap = compactionSummary({
      provider: "openrouter",
      modelId: "google/gemini-2.0-flash-001",
      getApiKey: () => "test-key",
    });

    expect(cap.id).toBe("compaction-summary");
    expect(cap.name).toBe("Compaction (Summary)");
    expect(cap.description).toBeTruthy();
    expect(cap.hooks?.beforeInference).toBeInstanceOf(Function);
  });

  it("returns messages unchanged when below threshold", async () => {
    const cap = compactionSummary({
      provider: "openrouter",
      modelId: "test-model",
      getApiKey: () => "key",
      compaction: {
        threshold: 0.75,
        contextWindowTokens: 200_000,
      },
    });

    const messages = [userMsg("hello"), assistantMsg("hi")];
    const store = createMockSessionStore(messages);
    const ctx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: store as any,
      storage: createNoopStorage(),
    };

    const result = await cap.hooks!.beforeInference!(messages, ctx);

    expect(result).toBe(messages); // Same reference — no compaction
    expect(store.appendEntry).not.toHaveBeenCalled();
  });

  it("triggers compaction when above threshold", async () => {
    const cap = compactionSummary({
      provider: "openrouter",
      modelId: "test-model",
      getApiKey: () => "key",
      compaction: {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      },
    });

    // Create enough messages to exceed threshold
    // Each ~120 tokens (400 chars / 4 * 1.2)
    const messages = Array.from({ length: 10 }, (_, i) =>
      userMsg(`Message ${i}: ${"x".repeat(400)}`),
    );
    const store = createMockSessionStore(messages);
    const ctx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: store as any,
      storage: createNoopStorage(),
    };

    const result = await cap.hooks!.beforeInference!(messages, ctx);

    // Should have persisted a compaction entry
    expect(store.appendEntry).toHaveBeenCalledWith("s1", {
      type: "compaction",
      data: expect.objectContaining({
        summary: expect.any(String),
        firstKeptEntryId: expect.any(String),
        tokensBefore: expect.any(Number),
      }),
    });

    // Should have rebuilt context from session store
    expect(store.buildContext).toHaveBeenCalledWith("s1");

    // Result should be the rebuilt context (which includes the summary)
    expect(result.length).toBeLessThan(messages.length);
  });

  it("uses custom compaction config", () => {
    const cap = compactionSummary({
      provider: "openrouter",
      modelId: "test-model",
      getApiKey: () => "key",
      compaction: {
        threshold: 0.9,
        contextWindowTokens: 500_000,
        keepRecentTokens: 50_000,
      },
    });

    // Verify the capability was created (config is internal)
    expect(cap.id).toBe("compaction-summary");
  });

  it("returns original messages when compaction throws", async () => {
    // Override the mock to throw
    const { createLlmSummarizer } = await import("../summarize.js");
    vi.mocked(createLlmSummarizer).mockReturnValueOnce(
      async () => {
        throw new Error("LLM API down");
      },
    );

    const cap = compactionSummary({
      provider: "openrouter",
      modelId: "test-model",
      getApiKey: () => "key",
      compaction: {
        threshold: 0.5,
        contextWindowTokens: 500,
        keepRecentTokens: 100,
      },
    });

    // Create enough messages to exceed threshold
    const messages = Array.from({ length: 10 }, (_, i) =>
      userMsg(`Message ${i}: ${"x".repeat(400)}`),
    );
    const store = createMockSessionStore(messages);
    const ctx: CapabilityHookContext = {
      agentId: "test-agent",
      sessionId: "s1",
      sessionStore: store as any,
      storage: createNoopStorage(),
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cap.hooks!.beforeInference!(messages, ctx);
    consoleSpy.mockRestore();

    // Should return the original messages, not throw
    expect(result).toBe(messages);
    expect(store.appendEntry).not.toHaveBeenCalled();
  });
});
