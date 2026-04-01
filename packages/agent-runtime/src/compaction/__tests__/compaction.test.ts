import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  compactSession,
  emergencyTruncate,
  estimateMessagesTokens,
  estimateTokens,
  findCutPoint,
  shouldCompact,
  splitByTokenShare,
  summarizeInStages,
  truncateToolResult,
} from "../compaction.js";
import type { CompactionConfig, SummarizeFn } from "../types.js";

// Helper to create test messages
function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMsg(content: string): AgentMessage {
  return { role: "assistant", content, timestamp: Date.now() } as unknown as AgentMessage;
}

function toolResultMsg(content: string): AgentMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text: content }],
    toolCallId: `call_${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

// Mock summarizer
const mockSummarize: SummarizeFn = async (msgs, prevSummary) => {
  const count = msgs.length;
  if (prevSummary) {
    return `${prevSummary}\n[Continued: ${count} messages]`;
  }
  return `Summary of ${count} messages`;
};

describe("Token Estimation", () => {
  // Implementation uses content-aware heuristics:
  // - Prose: chars/3.5, Code: chars/3.0, JSON: chars/2.5
  // - 5-token overhead per message, 1.15 safety margin
  // - Tool calls: text tokens + args tokens + 5 framing tokens

  describe("estimateTokens", () => {
    it("estimates text message tokens with prose heuristic", () => {
      const msg = userMsg("a".repeat(400));
      const estimate = estimateTokens(msg);
      // "aaa..." is prose: ceil(400/3.5) = 115 text + 5 overhead = 120, * 1.15 = ceil(138)
      expect(estimate).toBe(138);
    });

    it("estimates tool result tokens with prose heuristic", () => {
      const msg = toolResultMsg("a".repeat(1000));
      const estimate = estimateTokens(msg);
      // toolResult has content as string: ceil(1000/3.5) = 286 + 5 overhead = 291, * 1.15 = ceil(334.65) = 335
      expect(estimate).toBe(335);
    });

    it("handles empty content", () => {
      const msg = userMsg("");
      // 0 text + 5 overhead = 5, * 1.15 = ceil(5.75) = 6
      expect(estimateTokens(msg)).toBe(6);
    });

    it("handles array content blocks", () => {
      const msg = {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(200) },
          { type: "text", text: "b".repeat(200) },
        ],
        timestamp: Date.now(),
      } as unknown as AgentMessage;
      // ceil(200/3.5)=58 + ceil(200/3.5)=58 = 116 + 5 overhead = 121, * 1.15 = ceil(139.15) = 140
      expect(estimateTokens(msg)).toBe(140);
    });

    it("handles string items in content array", () => {
      const msg = {
        role: "assistant",
        content: ["hello world"],
        timestamp: Date.now(),
      } as unknown as AgentMessage;
      // ceil(11/3.5)=4 + 5 overhead = 9, * 1.15 = ceil(10.35) = 11
      expect(estimateTokens(msg)).toBe(11);
    });

    it("treats toolCall content blocks as tool content", () => {
      const msg = {
        role: "assistant",
        content: [{ type: "toolCall", name: "search", text: "a".repeat(100) }],
        timestamp: Date.now(),
      } as unknown as AgentMessage;
      // text: ceil(100/3.5)=29, toolCall args: JSON.stringify({})="{}" -> ceil(2/2.5)=1 + 5 framing = 6
      // total: 29 + 6 + 5 overhead = 40, * 1.15 = ceil(46) = 46
      expect(estimateTokens(msg)).toBe(46);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("sums individual estimates", () => {
      const msgs = [userMsg("a".repeat(400)), assistantMsg("b".repeat(400))];
      // Each: ceil(400/3.5)=115 + 5 = 120, * 1.15 = 138. Total: 276
      expect(estimateMessagesTokens(msgs)).toBe(276);
    });

    it("returns 0 for empty array", () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });
  });
});

describe("Compaction Threshold", () => {
  describe("shouldCompact", () => {
    it("returns false when below threshold", () => {
      expect(shouldCompact(50_000, { threshold: 0.75, contextWindowTokens: 200_000 })).toBe(false);
    });

    it("returns true when above threshold", () => {
      expect(shouldCompact(160_000, { threshold: 0.75, contextWindowTokens: 200_000 })).toBe(true);
    });

    it("returns false at exactly the threshold", () => {
      expect(shouldCompact(150_000, { threshold: 0.75, contextWindowTokens: 200_000 })).toBe(false);
    });

    it("returns true just above threshold", () => {
      expect(shouldCompact(150_001, { threshold: 0.75, contextWindowTokens: 200_000 })).toBe(true);
    });
  });
});

describe("Cut Point Calculation", () => {
  describe("findCutPoint", () => {
    it("finds cut point keeping recent messages", () => {
      // Create messages with known token counts
      const msgs = Array.from({ length: 20 }, () => userMsg("x".repeat(400))); // Each ~120 tokens

      const result = findCutPoint(msgs, 500);
      expect(result).not.toBeNull();
      expect(result!.cutIndex).toBeGreaterThan(0);
      expect(result!.cutIndex).toBeLessThan(20);
    });

    it("returns null when all messages fit in keepRecentTokens", () => {
      const msgs = [userMsg("hello"), assistantMsg("hi")];
      const result = findCutPoint(msgs, 100_000);
      expect(result).toBeNull();
    });

    it("returns null for single message", () => {
      const msgs = [userMsg("hello")];
      const result = findCutPoint(msgs, 1);
      expect(result).toBeNull(); // Only one message, cutIndex would be 0
    });
  });
});

describe("Split By Token Share", () => {
  describe("splitByTokenShare", () => {
    it("returns single chunk for numChunks=1", () => {
      const msgs = [userMsg("hello"), userMsg("world")];
      const chunks = splitByTokenShare(msgs, 1);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(2);
    });

    it("splits proportionally into N chunks", () => {
      const msgs = Array.from({ length: 12 }, (_, i) => userMsg(`message ${i}`));
      const chunks = splitByTokenShare(msgs, 3);
      expect(chunks.length).toBeLessThanOrEqual(3);
      // All messages should be present across chunks
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(total).toBe(12);
    });

    it("handles more chunks than messages", () => {
      const msgs = [userMsg("only one")];
      const chunks = splitByTokenShare(msgs, 5);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(total).toBe(1);
    });
  });
});

describe("Multi-stage Summarization", () => {
  const defaultConfig: CompactionConfig = {
    threshold: 0.75,
    contextWindowTokens: 200_000,
    keepRecentTokens: 20_000,
  };

  describe("summarizeInStages", () => {
    it("single chunk goes through one summarize call", async () => {
      const msgs = [userMsg("hello"), assistantMsg("hi")];
      const spy = vi.fn(mockSummarize);

      const result = await summarizeInStages(msgs, defaultConfig, spy);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result).toContain("Summary of 2 messages");
    });

    it("multi-chunk summarizes each then merges", async () => {
      // Create enough messages to trigger multi-chunk
      const msgs = Array.from({ length: 100 }, () => userMsg("x".repeat(4000)));
      const spy = vi.fn(mockSummarize);

      const config: CompactionConfig = {
        ...defaultConfig,
        contextWindowTokens: 10_000, // Small window to force multiple chunks
      };

      const result = await summarizeInStages(msgs, config, spy);

      // Should call summarize multiple times (chunks + merge)
      expect(spy.mock.calls.length).toBeGreaterThan(1);
      expect(result).toBeTruthy();
    });

    it("returns single summary when chunks produce one result", async () => {
      // Use a tiny config that forces numChunks > 1 calculation but
      // the actual messages are so small splitByTokenShare produces 1 chunk
      const msgs = [userMsg("tiny")];

      const config: CompactionConfig = {
        threshold: 0.75,
        contextWindowTokens: 1, // Extremely small → forces numChunks > 1
        keepRecentTokens: 1,
        baseChunkRatio: 0.01,
        minChunkRatio: 0.01,
      };

      const result = await summarizeInStages(msgs, config, mockSummarize);
      expect(result).toContain("Summary of 1 messages");
    });

    it("respects abort signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const msgs = Array.from({ length: 100 }, () => userMsg("x".repeat(4000)));
      const config: CompactionConfig = {
        ...defaultConfig,
        contextWindowTokens: 10_000,
      };

      await expect(
        summarizeInStages(msgs, config, mockSummarize, controller.signal),
      ).rejects.toThrow();
    });
  });
});

describe("Compact Session", () => {
  describe("compactSession", () => {
    it("returns null when below threshold", async () => {
      const msgs = [userMsg("hello"), assistantMsg("hi")];
      const entryIds = ["e1", "e2"];
      const config: CompactionConfig = {
        threshold: 0.75,
        contextWindowTokens: 200_000,
        keepRecentTokens: 20_000,
      };

      const result = await compactSession(msgs, entryIds, config, mockSummarize);
      expect(result).toBeNull();
    });

    it("returns null when above threshold but nothing to cut", async () => {
      // Few messages that exceed threshold but are all too recent
      const msgs = [userMsg("x".repeat(8000))];
      const entryIds = ["e0"];
      const config: CompactionConfig = {
        threshold: 0.1, // Very low threshold to trigger
        contextWindowTokens: 1_000,
        keepRecentTokens: 100_000, // Keep everything
      };

      const result = await compactSession(msgs, entryIds, config, mockSummarize);
      expect(result).toBeNull();
    });

    it("compacts when above threshold", async () => {
      const msgs = Array.from({ length: 50 }, () => userMsg("x".repeat(2000)));
      const entryIds = msgs.map((_, i) => `e${i}`);
      const config: CompactionConfig = {
        threshold: 0.75,
        contextWindowTokens: 10_000,
        keepRecentTokens: 2_000,
      };

      const result = await compactSession(msgs, entryIds, config, mockSummarize);

      expect(result).not.toBeNull();
      expect(result!.summary).toBeTruthy();
      expect(result!.firstKeptEntryId).toMatch(/^e\d+$/);
      expect(result!.tokensBefore).toBeGreaterThan(0);
    });
  });
});

describe("Tool Result Truncation", () => {
  describe("truncateToolResult", () => {
    it("returns content unchanged when within limit", () => {
      const content = "short content";
      expect(truncateToolResult(content, 50_000)).toBe(content);
    });

    it("truncates long content with marker", () => {
      const content = "a".repeat(200_000);
      const truncated = truncateToolResult(content, 50_000);

      expect(truncated.length).toBeLessThanOrEqual(50_000);
      expect(truncated).toContain("⚠️ [Content truncated");
      expect(truncated).toContain("200,000 chars");
    });

    it("preserves prefix and suffix", () => {
      const content = `START${"x".repeat(200_000)}END!!`;
      const truncated = truncateToolResult(content, 50_000);

      expect(truncated.startsWith("START")).toBe(true);
      expect(truncated.endsWith("END!!")).toBe(true);
    });

    it("uses default maxChars of 50000", () => {
      const content = "a".repeat(100_000);
      const truncated = truncateToolResult(content);
      expect(truncated.length).toBeLessThanOrEqual(50_000);
    });
  });
});

describe("Emergency Truncation", () => {
  describe("emergencyTruncate", () => {
    it("keeps recent messages within budget", () => {
      const msgs = Array.from({ length: 50 }, () => userMsg("x".repeat(2000)));

      const result = emergencyTruncate(msgs, 10_000);

      // Should have fewer messages than original
      expect(result.length).toBeLessThan(50);
      // First message should be the truncation notice
      expect((result[0] as any).content).toContain("context was lost");
    });

    it("prepends truncation notice", () => {
      const msgs = [userMsg("a".repeat(40_000)), userMsg("b".repeat(40_000))];

      const result = emergencyTruncate(msgs, 10_000);

      expect((result[0] as any).content).toContain("Earlier conversation context was lost");
    });

    it("handles case where few messages fit", () => {
      const msgs = [userMsg("x".repeat(100_000))];
      const result = emergencyTruncate(msgs, 100);

      // Only the notice should remain (message too big to fit)
      expect(result).toHaveLength(1);
      expect((result[0] as any).content).toContain("context was lost");
    });
  });
});
