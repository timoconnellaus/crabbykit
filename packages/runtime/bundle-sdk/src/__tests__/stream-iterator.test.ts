/**
 * Recorded SSE fixture matrix for the unified provider stream
 * iterator (Phase 0b — task 2.4).
 *
 * Hard cases enumerated by the spec:
 *   (a) text-only stream
 *   (b) single tool call with single-event arguments
 *   (c) single tool call with arguments split across 5+ events
 *   (d) two parallel tool calls in one assistant message
 *   (e) interleaved text + tool
 *   (f) premature stream close mid-arguments
 *   (g) UTF-8 multi-byte char split across SSE-event boundary inside
 *       arguments JSON
 *   (h) OpenRouter upstream-provider variation (Anthropic-via-OpenRouter
 *       fixture — OpenAI shape with provider-routed Anthropic content)
 */

import { describe, expect, it } from "vitest";
import { iterateProviderStream, type StreamChunk } from "../providers/stream-iterator.js";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sseEvent(payload: unknown): Uint8Array {
  return bytes(`data: ${JSON.stringify(payload)}\n\n`);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iterateProviderStream(stream) as AsyncIterable<StreamChunk>) {
    out.push(c);
  }
  return out;
}

describe("iterateProviderStream — fixture matrix", () => {
  it("(a) text-only OpenAI stream emits text deltas and a `stop` completion", async () => {
    const stream = streamFromChunks([
      sseEvent({ choices: [{ delta: { content: "hello " } }] }),
      sseEvent({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] }),
      bytes("data: [DONE]\n\n"),
    ]);
    const chunks = await collect(stream);
    expect(
      chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta),
    ).toEqual(["hello ", "world"]);
    const completed = chunks.find((c) => c.type === "completed");
    expect(completed).toBeDefined();
    expect(completed && (completed as { stopReason: string }).stopReason).toBe("stop");
    expect(completed && (completed as { toolCalls: unknown[] }).toolCalls).toHaveLength(0);
  });

  it("(b) single tool call with single-event arguments yields a complete tool call", async () => {
    const stream = streamFromChunks([
      sseEvent({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "search", arguments: '{"q":"hi"}' },
                },
              ],
            },
          },
        ],
      }),
      sseEvent({ choices: [{ finish_reason: "tool_calls" }] }),
    ]);
    const completed = (await collect(stream)).find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed).toBeDefined();
    expect(completed?.stopReason).toBe("toolUse");
    expect(completed?.toolCalls).toHaveLength(1);
    expect(completed?.toolCalls[0]).toMatchObject({
      id: "call_1",
      name: "search",
      args: { q: "hi" },
    });
  });

  it("(c) single tool call with arguments split across 5+ events", async () => {
    const fragments = ['{"que', 'ry":', '"the q', 'uery"', "}"];
    const stream = streamFromChunks([
      sseEvent({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: "" } }],
            },
          },
        ],
      }),
      ...fragments.map((frag) =>
        sseEvent({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] } }],
        }),
      ),
      sseEvent({ choices: [{ finish_reason: "tool_calls" }] }),
    ]);
    const completed = (await collect(stream)).find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.toolCalls[0]).toMatchObject({
      id: "c1",
      name: "search",
      args: { query: "the query" },
    });
  });

  it("(d) two parallel tool calls in one assistant message", async () => {
    const stream = streamFromChunks([
      sseEvent({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "f1", arguments: '{"x":1}' } },
                { index: 1, id: "b", function: { name: "f2", arguments: '{"y":2}' } },
              ],
            },
          },
        ],
      }),
      sseEvent({ choices: [{ finish_reason: "tool_calls" }] }),
    ]);
    const completed = (await collect(stream)).find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.toolCalls).toHaveLength(2);
    expect(completed?.toolCalls.map((c) => c.id).sort()).toEqual(["a", "b"]);
    const calls = new Map(completed?.toolCalls.map((c) => [c.id, c]) ?? []);
    expect(calls.get("a")?.args).toEqual({ x: 1 });
    expect(calls.get("b")?.args).toEqual({ y: 2 });
  });

  it("(e) interleaved text + tool", async () => {
    const stream = streamFromChunks([
      sseEvent({ choices: [{ delta: { content: "thinking..." } }] }),
      sseEvent({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "t1", function: { name: "x", arguments: "{}" } }],
            },
          },
        ],
      }),
      sseEvent({ choices: [{ delta: { content: " more text" } }] }),
      sseEvent({ choices: [{ finish_reason: "tool_calls" }] }),
    ]);
    const chunks = await collect(stream);
    const texts = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { delta: string }).delta);
    expect(texts).toEqual(["thinking...", " more text"]);
    const completed = chunks.find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.toolCalls).toHaveLength(1);
    expect(completed?.toolCalls[0].id).toBe("t1");
  });

  it("(f) premature stream close mid-arguments — escalates stop to toolUse", async () => {
    const stream = streamFromChunks([
      sseEvent({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "p", function: { name: "n", arguments: '{"a":' } }],
            },
          },
        ],
      }),
      // Stream ends without finish_reason and without closing the JSON.
    ]);
    const completed = (await collect(stream)).find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.stopReason).toBe("toolUse");
    expect(completed?.toolCalls).toHaveLength(1);
    // Args parse failed → empty object, rawArgs preserved for diagnostics.
    expect(completed?.toolCalls[0].args).toEqual({});
    expect(completed?.toolCalls[0].rawArgs).toBe('{"a":');
  });

  it("(g) UTF-8 multi-byte char split across SSE-event byte boundaries inside arguments", async () => {
    // Build a payload whose bytes split a UTF-8 4-byte char (😀) across
    // two reader chunks. The full SSE event still completes; the
    // TextDecoder must preserve the partial codepoint across reads.
    const fullEvent = `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "u", function: { name: "x", arguments: '{"emoji":"😀"}' } },
            ],
          },
        },
      ],
    })}\n\n`;
    const finishEvent = `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}\n\n`;
    const allBytes = bytes(fullEvent + finishEvent);
    // Split at a position guaranteed to slice the 4-byte 😀 sequence:
    // find first byte > 0x7f.
    const splitAt = allBytes.findIndex((b) => b > 0x7f) + 1;
    const a = allBytes.slice(0, splitAt);
    const b = allBytes.slice(splitAt);
    const stream = streamFromChunks([a, b]);
    const completed = (await collect(stream)).find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.toolCalls[0].args).toEqual({ emoji: "😀" });
  });

  it("(h) OpenRouter Anthropic-via-OpenAI shape — accepts the OpenAI-shape envelope OpenRouter uses for Anthropic-routed responses", async () => {
    // OpenRouter wraps Anthropic responses in OpenAI shape; tool calls
    // arrive as `tool_calls` deltas, not as Anthropic `tool_use` blocks.
    const stream = streamFromChunks([
      sseEvent({
        id: "or-...",
        provider: "Anthropic",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "toolu_01ABC",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":"x"}' },
                },
              ],
            },
          },
        ],
      }),
      sseEvent({ id: "or-...", choices: [{ finish_reason: "tool_calls" }] }),
    ]);
    const completed = (await collect(stream)).find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.stopReason).toBe("toolUse");
    expect(completed?.toolCalls[0]).toMatchObject({
      id: "toolu_01ABC",
      name: "web_search",
      args: { query: "x" },
    });
  });

  it("Anthropic-direct format — tool_use content_block + input_json_delta", async () => {
    const stream = streamFromChunks([
      sseEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_xyz", name: "web_search", input: {} },
      }),
      sseEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"que' },
      }),
      sseEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'ry":"x"}' },
      }),
      sseEvent({ type: "content_block_stop", index: 0 }),
      sseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    ]);
    const completed = (await collect(stream)).find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.stopReason).toBe("toolUse");
    expect(completed?.toolCalls[0]).toMatchObject({
      id: "toolu_xyz",
      name: "web_search",
      args: { query: "x" },
    });
  });

  it("Anthropic-direct text_delta path emits text chunks", async () => {
    const stream = streamFromChunks([
      sseEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi " },
      }),
      sseEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "there" },
      }),
      sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);
    const chunks = await collect(stream);
    expect(
      chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta),
    ).toEqual(["hi ", "there"]);
    const completed = chunks.find((c) => c.type === "completed") as
      | (StreamChunk & { type: "completed" })
      | undefined;
    expect(completed?.stopReason).toBe("stop");
  });
});
