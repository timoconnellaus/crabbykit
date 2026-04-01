import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  AssistantMessageEvent,
  Context,
  Model,
  OpenAICompletionsCompat,
} from "../../types.js";

// Mock the OpenAI module before importing the function under test
const mockCreate = vi.fn();
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor() {}
  },
}));

// Import after mock setup
const { streamOpenAICompletions } = await import("../openai-completions.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_MODEL: Model<"openai-completions"> = {
  id: "gpt-4o",
  name: "GPT-4o",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
  headers: {},
};

function ctx(
  systemPrompt?: string,
  messages: Context["messages"] = [{ role: "user", content: "hello", timestamp: 1000 }],
  tools?: Context["tools"],
): Context {
  return { systemPrompt, messages, tools };
}

/** Create a ChatCompletionChunk with sensible defaults */
function chunk(
  overrides: Partial<ChatCompletionChunk> & {
    delta?: Partial<ChatCompletionChunk.Choice.Delta>;
    finish_reason?: ChatCompletionChunk.Choice["finish_reason"];
  } = {},
): ChatCompletionChunk {
  const { delta, finish_reason, ...rest } = overrides;
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: (delta ?? {}) as ChatCompletionChunk.Choice.Delta,
        finish_reason: finish_reason ?? null,
        logprobs: null,
      },
    ],
    ...rest,
  };
}

/** Turn an array of chunks into an async iterable (simulates SSE stream) */
async function* chunksToStream(
  chunks: ChatCompletionChunk[],
): AsyncIterable<ChatCompletionChunk> {
  for (const c of chunks) {
    yield c;
  }
}

/** Collect all events from a stream */
async function collectEvents(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamOpenAICompletions", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe("text streaming", () => {
    it("emits start → text_start → text_delta(s) → text_end → done for simple text", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { content: "Hello" } }),
          chunk({ delta: { content: " world" } }),
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx("system"), {
        apiKey: "test-key",
      });
      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);

      expect(types).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_delta",
        "text_end",
        "done",
      ]);

      // Verify text content accumulated correctly
      const done = events.find((e) => e.type === "done")!;
      expect(done.type).toBe("done");
      if (done.type === "done") {
        expect(done.message.content).toHaveLength(1);
        expect(done.message.content[0]).toEqual({ type: "text", text: "Hello world" });
        expect(done.message.stopReason).toBe("stop");
      }
    });

    it("accumulates text deltas into a single text block", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { content: "a" } }),
          chunk({ delta: { content: "b" } }),
          chunk({ delta: { content: "c" } }),
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);
      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.content[0]).toEqual({ type: "text", text: "abc" });
      }
    });

    it("ignores empty/null content deltas", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { content: "" } }),
          chunk({ delta: { content: null as any } }),
          chunk({ delta: {} }),
          chunk({ delta: { content: "hi" } }),
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);
      // Only one text_start (for "hi")
      expect(events.filter((e) => e.type === "text_start")).toHaveLength(1);
    });
  });

  describe("tool call streaming", () => {
    it("emits toolcall_start → toolcall_delta(s) → toolcall_end for a single tool call", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
              ],
            },
          }),
          chunk({
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"cit' } },
              ],
            } as any,
          }),
          chunk({
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'y":"NYC"}' } },
              ],
            } as any,
          }),
          chunk({ finish_reason: "tool_calls" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);

      expect(types).toEqual([
        "start",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);

      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.stopReason).toBe("toolUse");
        const tc = done.message.content[0];
        expect(tc).toMatchObject({
          type: "toolCall",
          id: "call_1",
          name: "get_weather",
          arguments: { city: "NYC" },
        });
      }
    });

    it("handles multiple parallel tool calls", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "tool_a", arguments: '{"a":1}' } },
              ],
            },
          }),
          chunk({
            delta: {
              tool_calls: [
                { index: 1, id: "call_2", type: "function", function: { name: "tool_b", arguments: '{"b":2}' } },
              ],
            },
          }),
          chunk({ finish_reason: "tool_calls" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);

      // Two toolcall_start + toolcall_delta + toolcall_end sequences
      expect(events.filter((e) => e.type === "toolcall_start")).toHaveLength(2);
      expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(2);

      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.content).toHaveLength(2);
        expect(done.message.content[0]).toMatchObject({ type: "toolCall", name: "tool_a" });
        expect(done.message.content[1]).toMatchObject({ type: "toolCall", name: "tool_b" });
      }
    });

    it("handles text followed by tool call", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { content: "Let me check" } }),
          chunk({
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "search", arguments: '{}' } },
              ],
            },
          }),
          chunk({ finish_reason: "tool_calls" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);

      // text block finishes (text_end), then tool call starts
      const types = events.map((e) => e.type);
      expect(types).toContain("text_start");
      expect(types).toContain("text_end");
      expect(types).toContain("toolcall_start");
      expect(types).toContain("toolcall_end");

      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.content).toHaveLength(2);
        expect(done.message.content[0]).toMatchObject({ type: "text", text: "Let me check" });
        expect(done.message.content[1]).toMatchObject({ type: "toolCall", name: "search" });
      }
    });
  });

  describe("thinking/reasoning streaming", () => {
    it("emits thinking events for reasoning_content field", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { reasoning_content: "Let me think..." } as any }),
          chunk({ delta: { reasoning_content: " about this" } as any }),
          chunk({ delta: { content: "The answer is 42" } }),
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);
      const types = events.map((e) => e.type);

      expect(types).toContain("thinking_start");
      expect(types).toContain("thinking_delta");
      expect(types).toContain("thinking_end");
      expect(types).toContain("text_start");

      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.content).toHaveLength(2);
        expect(done.message.content[0]).toMatchObject({
          type: "thinking",
          thinking: "Let me think... about this",
          thinkingSignature: "reasoning_content",
        });
        expect(done.message.content[1]).toMatchObject({
          type: "text",
          text: "The answer is 42",
        });
      }
    });

    it("supports reasoning field (alternative to reasoning_content)", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { reasoning: "hmm" } as any }),
          chunk({ delta: { content: "done" } }),
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);

      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.content[0]).toMatchObject({
          type: "thinking",
          thinking: "hmm",
          thinkingSignature: "reasoning",
        });
      }
    });

    it("supports reasoning_text field", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { reasoning_text: "deep thought" } as any }),
          chunk({ delta: { content: "answer" } }),
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);

      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.content[0]).toMatchObject({
          type: "thinking",
          thinking: "deep thought",
          thinkingSignature: "reasoning_text",
        });
      }
    });
  });

  describe("usage tracking", () => {
    it("parses standard chunk.usage", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { content: "hi" } }),
          chunk({
            finish_reason: "stop",
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 10 },
              completion_tokens_details: { reasoning_tokens: 5 },
            },
          } as any),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);
      const done = events.find((e) => e.type === "done")!;

      if (done.type === "done") {
        // input = prompt_tokens - cached = 100 - 10 = 90
        expect(done.message.usage.input).toBe(90);
        // output = completion_tokens + reasoning_tokens = 20 + 5 = 25
        expect(done.message.usage.output).toBe(25);
        expect(done.message.usage.cacheRead).toBe(10);
        expect(done.message.usage.totalTokens).toBe(125); // 90 + 25 + 10
      }
    });

    it("falls back to choice.usage for non-standard providers", async () => {
      const choiceWithUsage = {
        index: 0,
        delta: { content: "hi" } as ChatCompletionChunk.Choice.Delta,
        finish_reason: null as ChatCompletionChunk.Choice["finish_reason"],
        logprobs: null,
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      };
      mockCreate.mockResolvedValue(
        chunksToStream([
          {
            id: "chatcmpl-test",
            object: "chat.completion.chunk" as const,
            created: 1000,
            model: "gpt-4o",
            choices: [choiceWithUsage],
          },
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);
      const done = events.find((e) => e.type === "done")!;

      if (done.type === "done") {
        expect(done.message.usage.input).toBe(50);
        expect(done.message.usage.output).toBe(10);
      }
    });
  });

  describe("response metadata", () => {
    it("captures responseId from chunk.id", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ id: "chatcmpl-abc123", delta: { content: "hi" } }),
          chunk({ finish_reason: "stop" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);
      const done = events.find((e) => e.type === "done")!;
      if (done.type === "done") {
        expect(done.message.responseId).toBe("chatcmpl-abc123");
      }
    });
  });

  describe("stop reasons", () => {
    it("maps finish_reason=stop to stopReason=stop", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "x" } }), chunk({ finish_reason: "stop" })]),
      );
      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
    });

    it("maps finish_reason=length to stopReason=length", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "x" } }), chunk({ finish_reason: "length" })]),
      );
      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.stopReason).toBe("length");
    });

    it("maps finish_reason=tool_calls to stopReason=toolUse", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({
            delta: {
              tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
            },
          }),
          chunk({ finish_reason: "tool_calls" }),
        ]),
      );
      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.stopReason).toBe("toolUse");
    });

    it("maps finish_reason=content_filter to error with message", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { content: "x" } }),
          chunk({ finish_reason: "content_filter" as any }),
        ]),
      );
      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("content_filter");
    });

    it("maps unknown finish_reason to error", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({ delta: { content: "x" } }),
          chunk({ finish_reason: "weird_reason" as any }),
        ]),
      );
      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("weird_reason");
    });
  });

  describe("error handling", () => {
    it("emits error event when OpenAI client throws", async () => {
      mockCreate.mockRejectedValue(new Error("API rate limit exceeded"));

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "error") {
        expect(errorEvent.error.stopReason).toBe("error");
        expect(errorEvent.error.errorMessage).toBe("API rate limit exceeded");
      }
    });

    it("emits error event when stream throws mid-iteration", async () => {
      async function* failingStream() {
        yield chunk({ delta: { content: "partial" } });
        throw new Error("Connection reset");
      }
      mockCreate.mockResolvedValue(failingStream());

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const events = await collectEvents(stream);

      // Should have start + text events then error
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "error") {
        expect(errorEvent.error.errorMessage).toBe("Connection reset");
      }
    });

    it("includes raw metadata from OpenRouter-style errors", async () => {
      const err = new Error("upstream error");
      (err as any).error = { metadata: { raw: "detailed upstream info" } };
      mockCreate.mockRejectedValue(err);

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.errorMessage).toContain("upstream error");
      expect(result.errorMessage).toContain("detailed upstream info");
    });

    it("sets stopReason=aborted when signal is aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      async function* abortedStream() {
        throw new Error("Request was aborted");
      }
      mockCreate.mockResolvedValue(abortedStream());

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), {
        apiKey: "k",
        signal: controller.signal,
      });
      const result = await stream.result();
      expect(result.stopReason).toBe("aborted");
    });

    it("throws error for missing API key", async () => {
      // createClient throws when apiKey is empty
      mockCreate.mockResolvedValue(chunksToStream([]));

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), {
        // No apiKey, and getEnvApiKey returns undefined
      });
      const result = await stream.result();
      // Should get error about missing API key
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("API key");
    });
  });

  describe("onPayload callback", () => {
    it("allows modifying params before the API call", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "ok" } }), chunk({ finish_reason: "stop" })]),
      );

      let capturedParams: any = null;
      const stream = streamOpenAICompletions(BASE_MODEL, ctx("sys"), {
        apiKey: "k",
        onPayload: (params) => {
          capturedParams = params;
          return { ...params, temperature: 0.5 } as any;
        },
      });
      await stream.result();

      expect(capturedParams).toBeDefined();
      expect(capturedParams.model).toBe("gpt-4o");
      // Verify the modified params were passed to create
      const createArgs = mockCreate.mock.calls[0][0];
      expect(createArgs.temperature).toBe(0.5);
    });

    it("keeps original params when onPayload returns undefined", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "ok" } }), chunk({ finish_reason: "stop" })]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), {
        apiKey: "k",
        onPayload: () => undefined,
      });
      await stream.result();

      // Should still call create with valid params
      expect(mockCreate).toHaveBeenCalledOnce();
    });
  });

  describe("reasoning_details on tool calls", () => {
    it("attaches encrypted reasoning details to matching tool calls", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{}' } },
              ],
            },
          }),
          chunk({
            delta: {
              reasoning_details: [
                { type: "reasoning.encrypted", id: "call_1", data: "encrypted-blob" },
              ],
            } as any,
          }),
          chunk({ finish_reason: "tool_calls" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      const tc = result.content[0];
      expect(tc.type).toBe("toolCall");
      if (tc.type === "toolCall") {
        expect(tc.thoughtSignature).toBe(
          JSON.stringify({ type: "reasoning.encrypted", id: "call_1", data: "encrypted-blob" }),
        );
      }
    });

    it("ignores reasoning_details for non-matching tool call IDs", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          chunk({
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{}' } },
              ],
            },
          }),
          chunk({
            delta: {
              reasoning_details: [
                { type: "reasoning.encrypted", id: "call_999", data: "blob" },
              ],
            } as any,
          }),
          chunk({ finish_reason: "tool_calls" }),
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      const tc = result.content[0];
      if (tc.type === "toolCall") {
        expect(tc.thoughtSignature).toBeUndefined();
      }
    });
  });

  describe("output message structure", () => {
    it("populates model metadata on the output message", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "hi" } }), chunk({ finish_reason: "stop" })]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();

      expect(result.role).toBe("assistant");
      expect(result.api).toBe("openai-completions");
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o");
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("handles empty stream (no choices) gracefully", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([
          // Chunk with no choices
          {
            id: "chatcmpl-test",
            object: "chat.completion.chunk" as const,
            created: 1000,
            model: "gpt-4o",
            choices: [],
          },
        ]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.stopReason).toBe("stop"); // default
      expect(result.content).toHaveLength(0);
    });

    it("skips non-object chunks", async () => {
      async function* mixedStream() {
        yield null as any;
        yield "not an object" as any;
        yield chunk({ delta: { content: "ok" } });
        yield chunk({ finish_reason: "stop" });
      }
      mockCreate.mockResolvedValue(mixedStream());

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      const result = await stream.result();
      expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    });
  });

  describe("AbortSignal integration", () => {
    it("passes signal to the OpenAI client create call", async () => {
      const controller = new AbortController();
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "hi" } }), chunk({ finish_reason: "stop" })]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), {
        apiKey: "k",
        signal: controller.signal,
      });
      await stream.result();

      // Verify signal was passed as second arg to create
      expect(mockCreate.mock.calls[0][1]).toEqual({ signal: controller.signal });
    });

    it("detects post-stream abort via signal.aborted check", async () => {
      const controller = new AbortController();

      async function* streamThenAbort() {
        yield chunk({ delta: { content: "partial" } });
        // Simulate abort happening after stream ends but before done check
        controller.abort();
      }
      mockCreate.mockResolvedValue(streamThenAbort());

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), {
        apiKey: "k",
        signal: controller.signal,
      });
      const result = await stream.result();
      expect(result.stopReason).toBe("aborted");
    });
  });

  describe("buildParams integration", () => {
    it("passes tools to the API when context has tools", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "ok" } }), chunk({ finish_reason: "stop" })]),
      );

      const tools = [
        { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } },
      ];
      const stream = streamOpenAICompletions(BASE_MODEL, ctx(undefined, undefined, tools as any), {
        apiKey: "k",
      });
      await stream.result();

      const params = mockCreate.mock.calls[0][0];
      expect(params.tools).toHaveLength(1);
      expect(params.tools[0].function.name).toBe("get_weather");
    });

    it("includes stream_options for standard providers", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "ok" } }), chunk({ finish_reason: "stop" })]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), { apiKey: "k" });
      await stream.result();

      const params = mockCreate.mock.calls[0][0];
      expect(params.stream).toBe(true);
      expect(params.stream_options).toEqual({ include_usage: true });
    });

    it("applies reasoningEffort for reasoning models", async () => {
      const reasoningModel = { ...BASE_MODEL, reasoning: true };
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "ok" } }), chunk({ finish_reason: "stop" })]),
      );

      const stream = streamOpenAICompletions(reasoningModel, ctx(), {
        apiKey: "k",
        reasoningEffort: "high",
      });
      await stream.result();

      const params = mockCreate.mock.calls[0][0];
      expect(params.reasoning_effort).toBe("high");
    });

    it("uses max_completion_tokens by default", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "ok" } }), chunk({ finish_reason: "stop" })]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), {
        apiKey: "k",
        maxTokens: 1000,
      });
      await stream.result();

      const params = mockCreate.mock.calls[0][0];
      expect(params.max_completion_tokens).toBe(1000);
    });

    it("uses toolChoice when provided", async () => {
      mockCreate.mockResolvedValue(
        chunksToStream([chunk({ delta: { content: "ok" } }), chunk({ finish_reason: "stop" })]),
      );

      const stream = streamOpenAICompletions(BASE_MODEL, ctx(), {
        apiKey: "k",
        toolChoice: "required",
      });
      await stream.result();

      const params = mockCreate.mock.calls[0][0];
      expect(params.tool_choice).toBe("required");
    });
  });
});
