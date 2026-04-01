import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock pi-ai before importing the module under test
const mockStreamSimple = vi.fn();
const mockGetModel = vi.fn();

vi.mock("@claw-for-cloudflare/ai", () => ({
  streamSimple: mockStreamSimple,
  getModel: mockGetModel,
}));

// Import after mocking
const { createLlmSummarizer, messagesToText, collectStreamText } = await import("../summarize.js");

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMsg(content: string): AgentMessage {
  return { role: "assistant", content, timestamp: Date.now() } as unknown as AgentMessage;
}

/** Create an async iterable that yields the given events */
async function* makeStream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}

describe("messagesToText", () => {
  it("converts string-content messages to text", () => {
    const msgs = [userMsg("hello"), assistantMsg("hi there")];
    const text = messagesToText(msgs);

    expect(text).toBe("USER: hello\nASSISTANT: hi there");
  });

  it("handles array content blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const text = messagesToText([msg]);
    expect(text).toBe("ASSISTANT: first second");
  });

  it("handles non-text content by JSON-stringifying", () => {
    const msg = {
      role: "assistant",
      content: { custom: "data" },
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const text = messagesToText([msg]);
    expect(text).toContain('"custom":"data"');
  });

  it("falls back to UNKNOWN when role is missing", () => {
    const msg = {
      content: "no role here",
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const text = messagesToText([msg]);
    expect(text).toBe("UNKNOWN: no role here");
  });

  it("handles plain string items in array content", () => {
    const msg = {
      role: "user",
      content: ["plain string", { type: "text", text: "block text" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const text = messagesToText([msg]);
    expect(text).toBe("USER: plain string block text");
  });
});

describe("collectStreamText", () => {
  it("extracts text from done event", async () => {
    const stream = makeStream([
      { type: "start" },
      { type: "text_delta", text: "partial" },
      {
        type: "done",
        message: {
          content: [{ type: "text", text: "Full summary here." }],
        },
      },
    ]);

    const result = await collectStreamText(stream);
    expect(result).toBe("Full summary here.");
  });

  it("returns fallback for empty done message", async () => {
    const stream = makeStream([{ type: "done", message: { content: [] } }]);

    const result = await collectStreamText(stream);
    expect(result).toBe("No summary generated.");
  });

  it("throws on error event with message fallback", async () => {
    const stream = makeStream([{ type: "error", message: "Rate limited" }]);

    await expect(collectStreamText(stream)).rejects.toThrow("Summarization error: Rate limited");
  });

  it("throws on error event with error.message", async () => {
    const stream = makeStream([{ type: "error", error: { message: "Token limit exceeded" } }]);

    await expect(collectStreamText(stream)).rejects.toThrow(
      "Summarization error: Token limit exceeded",
    );
  });

  it("throws on error event with default message when no details", async () => {
    const stream = makeStream([{ type: "error" }]);

    await expect(collectStreamText(stream)).rejects.toThrow(
      "Summarization error: Summarization failed",
    );
  });

  it("returns fallback when done message has no content", async () => {
    const stream = makeStream([{ type: "done", message: {} }]);

    const result = await collectStreamText(stream);
    expect(result).toBe("No summary generated.");
  });

  it("returns fallback when done has no message", async () => {
    const stream = makeStream([{ type: "done" }]);

    const result = await collectStreamText(stream);
    expect(result).toBe("No summary generated.");
  });

  it("concatenates multiple text blocks", async () => {
    const stream = makeStream([
      {
        type: "done",
        message: {
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      },
    ]);

    const result = await collectStreamText(stream);
    expect(result).toBe("Part 1\nPart 2");
  });
});

describe("createLlmSummarizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset lazy-loaded modules
    mockGetModel.mockReturnValue({ id: "test-model" });
  });

  it("calls streamSimple with correct parameters", async () => {
    mockStreamSimple.mockResolvedValue(
      makeStream([
        {
          type: "done",
          message: {
            content: [{ type: "text", text: "Test summary" }],
          },
        },
      ]),
    );

    const summarize = createLlmSummarizer("openrouter", "test-model", () => "api-key");
    const messages = [userMsg("hello"), assistantMsg("hi")];

    const result = await summarize(messages);

    expect(mockGetModel).toHaveBeenCalledWith("openrouter", "test-model");
    expect(mockStreamSimple).toHaveBeenCalledWith(
      { id: "test-model" },
      expect.objectContaining({
        systemPrompt: expect.stringContaining("summarizing a conversation"),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Please summarize"),
          }),
        ]),
      }),
      expect.objectContaining({
        apiKey: "api-key",
      }),
    );
    expect(result).toBe("Test summary");
  });

  it("passes previousSummary to buildSummarizationPrompt", async () => {
    mockStreamSimple.mockResolvedValue(
      makeStream([
        {
          type: "done",
          message: {
            content: [{ type: "text", text: "Extended summary" }],
          },
        },
      ]),
    );

    const summarize = createLlmSummarizer("openrouter", "test-model", () => "key");
    await summarize([userMsg("msg")], "Previous summary text");

    const callArgs = mockStreamSimple.mock.calls[0];
    const systemPrompt = callArgs[1].systemPrompt;
    expect(systemPrompt).toContain("Previous summary text");
  });

  it("passes abort signal through", async () => {
    const controller = new AbortController();
    mockStreamSimple.mockResolvedValue(
      makeStream([
        {
          type: "done",
          message: { content: [{ type: "text", text: "ok" }] },
        },
      ]),
    );

    const summarize = createLlmSummarizer("openrouter", "test-model", () => "key");
    await summarize([userMsg("msg")], undefined, controller.signal);

    const callArgs = mockStreamSimple.mock.calls[0];
    expect(callArgs[2].signal).toBe(controller.signal);
  });

  it("throws when model is not found", async () => {
    mockGetModel.mockReturnValue(null);

    const summarize = createLlmSummarizer("openrouter", "bad-model", () => "key");

    await expect(summarize([userMsg("msg")])).rejects.toThrow(
      "Summarization model not found: openrouter/bad-model",
    );
  });
});
