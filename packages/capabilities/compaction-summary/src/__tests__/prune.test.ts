import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it } from "vitest";
import { pruneToolOutputs } from "../prune.js";

function makeToolResult(text: string): AgentMessage {
  return {
    role: "tool",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: text } as unknown as AgentMessage;
}

/** Generate a string of roughly N tokens (at ~3.5 chars/token). */
function textOfTokens(n: number): string {
  return "x".repeat(Math.ceil(n * 3.5));
}

function getTextContent(msg: AgentMessage): string {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const content = (msg as any).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content[0]?.text ?? "";
  return "";
}

describe("pruneToolOutputs", () => {
  describe("happy path", () => {
    it("prunes oldest tool outputs beyond budget", () => {
      const messages = [
        makeUserMessage("hello"),
        makeToolResult(textOfTokens(100)), // old — should be pruned
        makeAssistantMessage("thinking"),
        makeToolResult(textOfTokens(100)), // newer — should be pruned
        makeAssistantMessage("more thinking"),
        makeToolResult(textOfTokens(100)), // newest — should be kept
      ];

      const result = pruneToolOutputs(messages, 100);

      // Oldest two tool results should be pruned
      expect(getTextContent(result[1])).toBe("[pruned]");
      expect(getTextContent(result[3])).toBe("[pruned]");
      // Newest should be kept
      expect(getTextContent(result[5]).length).toBeGreaterThan(10);
    });

    it("preserves most recent tool outputs within budget", () => {
      const messages = [
        makeToolResult(textOfTokens(50)),
        makeToolResult(textOfTokens(50)),
        makeToolResult(textOfTokens(50)),
      ];

      const result = pruneToolOutputs(messages, 150);

      // All should be kept (total = 150, budget = 150)
      expect(getTextContent(result[0]).length).toBeGreaterThan(10);
      expect(getTextContent(result[1]).length).toBeGreaterThan(10);
      expect(getTextContent(result[2]).length).toBeGreaterThan(10);
    });
  });

  describe("negative — non-tool messages untouched", () => {
    it("never modifies user messages", () => {
      const bigUserMsg = makeUserMessage(textOfTokens(1000));
      const messages = [bigUserMsg, makeToolResult(textOfTokens(50))];

      const result = pruneToolOutputs(messages, 10);

      // User message untouched even though it's large
      expect(result[0]).toBe(bigUserMsg);
    });

    it("never modifies assistant messages", () => {
      const bigAssistant = makeAssistantMessage(textOfTokens(1000));
      const messages = [bigAssistant, makeToolResult(textOfTokens(50))];

      const result = pruneToolOutputs(messages, 10);

      expect(result[0]).toBe(bigAssistant);
    });
  });

  describe("boundary conditions", () => {
    it("returns unchanged when exactly at budget", () => {
      const messages = [makeToolResult(textOfTokens(100))];

      const result = pruneToolOutputs(messages, 100);

      expect(getTextContent(result[0]).length).toBeGreaterThan(10);
    });

    it("prunes when over budget", () => {
      // Two tool results of 100 tokens each, budget for only one
      const messages = [makeToolResult(textOfTokens(100)), makeToolResult(textOfTokens(100))];

      const result = pruneToolOutputs(messages, 100);

      // Oldest pruned, newest kept
      expect(getTextContent(result[0])).toBe("[pruned]");
      expect(getTextContent(result[1]).length).toBeGreaterThan(10);
    });

    it("handles zero tool outputs", () => {
      const messages = [makeUserMessage("hello"), makeAssistantMessage("world")];

      const result = pruneToolOutputs(messages, 100);

      expect(result).toEqual(messages);
    });

    it("handles single tool output under budget", () => {
      const messages = [makeToolResult(textOfTokens(50))];

      const result = pruneToolOutputs(messages, 100);

      expect(getTextContent(result[0]).length).toBeGreaterThan(10);
    });

    it("handles empty messages array", () => {
      expect(pruneToolOutputs([], 100)).toEqual([]);
    });
  });

  describe("state — skip-summarization integration", () => {
    it("can reduce token count significantly", () => {
      const messages = [
        makeToolResult(textOfTokens(10000)),
        makeToolResult(textOfTokens(10000)),
        makeToolResult(textOfTokens(10000)),
        makeToolResult(textOfTokens(100)),
      ];

      const result = pruneToolOutputs(messages, 200);

      // Only the last tool result should survive
      expect(getTextContent(result[0])).toBe("[pruned]");
      expect(getTextContent(result[1])).toBe("[pruned]");
      expect(getTextContent(result[2])).toBe("[pruned]");
      expect(getTextContent(result[3]).length).toBeGreaterThan(10);
    });
  });

  describe("invariants", () => {
    it("preserves message order", () => {
      const messages = [
        makeUserMessage("1"),
        makeToolResult(textOfTokens(100)),
        makeAssistantMessage("2"),
        makeToolResult(textOfTokens(100)),
        makeUserMessage("3"),
      ];

      const result = pruneToolOutputs(messages, 100);

      expect(result).toHaveLength(5);
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      expect((result[0] as any).content).toBe("1");
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      expect((result[2] as any).content).toBe("2");
      // biome-ignore lint/suspicious/noExplicitAny: test helper
      expect((result[4] as any).content).toBe("3");
    });

    it("pruned count + preserved count = original count", () => {
      const messages = [
        makeToolResult(textOfTokens(100)),
        makeToolResult(textOfTokens(100)),
        makeToolResult(textOfTokens(100)),
        makeToolResult(textOfTokens(100)),
      ];

      const result = pruneToolOutputs(messages, 200);

      expect(result).toHaveLength(messages.length);
      const prunedCount = result.filter((m) => getTextContent(m) === "[pruned]").length;
      const keptCount = result.filter((m) => getTextContent(m) !== "[pruned]").length;
      expect(prunedCount + keptCount).toBe(messages.length);
    });

    it("most recent tool outputs are always preserved first", () => {
      const messages = [
        makeToolResult(textOfTokens(100)),
        makeToolResult(textOfTokens(100)),
        makeToolResult(textOfTokens(100)),
      ];

      // Budget for only one result
      const result = pruneToolOutputs(messages, 100);

      expect(getTextContent(result[0])).toBe("[pruned]");
      expect(getTextContent(result[1])).toBe("[pruned]");
      expect(getTextContent(result[2]).length).toBeGreaterThan(10);
    });
  });

  describe("custom budget", () => {
    it("respects budget of 20,000 tokens", () => {
      const messages = [makeToolResult(textOfTokens(15000)), makeToolResult(textOfTokens(15000))];

      const result = pruneToolOutputs(messages, 20000);

      // Only newest fits
      expect(getTextContent(result[0])).toBe("[pruned]");
      expect(getTextContent(result[1]).length).toBeGreaterThan(10);
    });
  });
});
