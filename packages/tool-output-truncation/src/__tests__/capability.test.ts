import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { describe, expect, it } from "vitest";
import { estimateTextTokens, toolOutputTruncation, truncateText } from "../capability.js";

/** Create a tool result message with text content blocks. */
function makeToolResult(texts: string[], opts: { skipTruncation?: boolean } = {}): AgentMessage {
  return {
    role: "tool",
    content: texts.map((text) => ({ type: "text", text })),
    ...(opts.skipTruncation ? { details: { skipTruncation: true } } : {}),
  } as unknown as AgentMessage;
}

/** Create a user message. */
function makeUserMessage(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

/** Create an assistant message. */
function makeAssistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: text } as unknown as AgentMessage;
}

/** Generate a string of roughly N tokens (at ~3.5 chars/token). */
function textOfTokens(n: number): string {
  const chars = Math.ceil(n * 3.5);
  return "x".repeat(chars);
}

describe("estimateTextTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  it("estimates tokens for plain text", () => {
    const text = "a".repeat(35);
    expect(estimateTextTokens(text)).toBe(10);
  });
});

describe("truncateText", () => {
  it("returns original text when under limit", () => {
    const text = "short text";
    expect(truncateText(text, 1000)).toBe(text);
  });

  it("truncates text over limit with marker", () => {
    const text = textOfTokens(100);
    const result = truncateText(text, 50);
    expect(result).toContain("[... truncated");
    expect(result).toContain("kept ...]");
    expect(result.length).toBeLessThan(text.length);
  });

  it("preserves first and last portions", () => {
    const text = "AAAA" + "B".repeat(1000) + "CCCC";
    const result = truncateText(text, 10);
    expect(result.startsWith("A")).toBe(true);
    expect(result.endsWith("C")).toBe(true);
  });
});

describe("toolOutputTruncation", () => {
  describe("capability shape", () => {
    it("returns a valid Capability with correct id", () => {
      const cap = toolOutputTruncation();
      expect(cap.id).toBe("tool-output-truncation");
      expect(cap.hooks?.beforeInference).toBeInstanceOf(Function);
    });
  });

  describe("happy path", () => {
    it("truncates oversized tool result", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50 });
      const hook = cap.hooks!.beforeInference!;
      const bigText = textOfTokens(200);
      const messages = [makeToolResult([bigText])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toContain("[... truncated");
      expect(content[0].text.length).toBeLessThan(bigText.length);
    });

    it("preserves correct head/tail ratio", async () => {
      const cap = toolOutputTruncation({ maxTokens: 100 });
      const hook = cap.hooks!.beforeInference!;
      // Use distinct chars to verify head/tail preservation
      const head = "H".repeat(500);
      const middle = "M".repeat(1000);
      const tail = "T".repeat(500);
      const bigText = head + middle + tail;
      const messages = [makeToolResult([bigText])];

      const result = await hook(messages, {} as never);
      const text = (result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
      expect(text.startsWith("H")).toBe(true);
      expect(text.endsWith("T")).toBe(true);
    });
  });

  describe("negative cases", () => {
    it("does not modify tool results under the limit", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50_000 });
      const hook = cap.hooks!.beforeInference!;
      const messages = [makeToolResult(["small output"])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe("small output");
    });

    it("does not modify user or assistant messages", async () => {
      const cap = toolOutputTruncation({ maxTokens: 10 });
      const hook = cap.hooks!.beforeInference!;
      const bigText = textOfTokens(200);
      const messages = [makeUserMessage(bigText), makeAssistantMessage(bigText)];

      const result = await hook(messages, {} as never);
      expect((result[0] as unknown as { content: string }).content).toBe(bigText);
      expect((result[1] as unknown as { content: string }).content).toBe(bigText);
    });

    it("respects skipTruncation opt-out", async () => {
      const cap = toolOutputTruncation({ maxTokens: 10 });
      const hook = cap.hooks!.beforeInference!;
      const bigText = textOfTokens(200);
      const messages = [makeToolResult([bigText], { skipTruncation: true })];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe(bigText);
    });
  });

  describe("boundary conditions", () => {
    it("does not truncate content exactly at limit", async () => {
      const cap = toolOutputTruncation({ maxTokens: 100 });
      const hook = cap.hooks!.beforeInference!;
      const text = textOfTokens(100);
      const messages = [makeToolResult([text])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe(text);
    });

    it("truncates content 1 token over limit", async () => {
      const cap = toolOutputTruncation({ maxTokens: 100 });
      const hook = cap.hooks!.beforeInference!;
      // Add enough chars for 101 tokens
      const text = textOfTokens(101);
      const messages = [makeToolResult([text])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toContain("[... truncated");
    });

    it("handles empty content", async () => {
      const cap = toolOutputTruncation({ maxTokens: 10 });
      const hook = cap.hooks!.beforeInference!;
      const messages = [makeToolResult([""])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe("");
    });

    it("handles single-character content", async () => {
      const cap = toolOutputTruncation({ maxTokens: 10 });
      const hook = cap.hooks!.beforeInference!;
      const messages = [makeToolResult(["x"])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe("x");
    });
  });

  describe("state — stabilizes after truncation", () => {
    it("converges after at most 2 passes", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50 });
      const hook = cap.hooks!.beforeInference!;
      const bigText = textOfTokens(200);
      const messages = [makeToolResult([bigText])];

      const first = await hook(messages, {} as never);
      const second = await hook(first, {} as never);
      const third = await hook(second, {} as never);

      const secondText = (second[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
      const thirdText = (third[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
      // After 2 passes, it must stabilize
      expect(thirdText).toBe(secondText);
    });

    it("first pass significantly reduces content size", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50 });
      const hook = cap.hooks!.beforeInference!;
      const bigText = textOfTokens(200);
      const messages = [makeToolResult([bigText])];

      const result = await hook(messages, {} as never);
      const resultText = (result[0] as unknown as { content: Array<{ text: string }> }).content[0].text;
      expect(resultText.length).toBeLessThan(bigText.length / 2);
    });
  });

  describe("invariants — multi-block handling", () => {
    it("only truncates oversized blocks, leaves small ones alone", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50 });
      const hook = cap.hooks!.beforeInference!;
      const smallText = "small output";
      const bigText = textOfTokens(200);
      const messages = [makeToolResult([smallText, bigText])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe(smallText);
      expect(content[1].text).toContain("[... truncated");
    });

    it("returns original message reference when nothing changes", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50_000 });
      const hook = cap.hooks!.beforeInference!;
      const msg = makeToolResult(["small"]);
      const messages = [msg];

      const result = await hook(messages, {} as never);
      expect(result[0]).toBe(msg); // Same reference — not cloned
    });

    it("handles mixed message types in the array", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50 });
      const hook = cap.hooks!.beforeInference!;
      const bigText = textOfTokens(200);
      const messages = [
        makeUserMessage("hello"),
        makeToolResult([bigText]),
        makeAssistantMessage("response"),
        makeToolResult(["small"]),
      ];

      const result = await hook(messages, {} as never);
      expect(result).toHaveLength(4);
      // User message unchanged
      expect((result[0] as unknown as { content: string }).content).toBe("hello");
      // Big tool result truncated
      const truncated = (result[1] as unknown as { content: Array<{ text: string }> }).content;
      expect(truncated[0].text).toContain("[... truncated");
      // Assistant unchanged
      expect((result[2] as unknown as { content: string }).content).toBe("response");
      // Small tool result unchanged
      const small = (result[3] as unknown as { content: Array<{ text: string }> }).content;
      expect(small[0].text).toBe("small");
    });
  });

  describe("custom threshold", () => {
    it("respects custom maxTokens of 50,000", async () => {
      const cap = toolOutputTruncation({ maxTokens: 50_000 });
      const hook = cap.hooks!.beforeInference!;
      // 40K tokens — under 50K limit
      const text = textOfTokens(40_000);
      const messages = [makeToolResult([text])];

      const result = await hook(messages, {} as never);
      const content = (result[0] as unknown as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toBe(text);
    });
  });
});
