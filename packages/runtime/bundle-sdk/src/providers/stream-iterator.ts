/**
 * Unified provider stream iterator.
 *
 * Wraps an upstream SSE byte stream and yields a discriminated
 * union of:
 *   - `{ type: "text", delta }` — text deltas, emitted live for
 *     incremental UI rendering
 *   - `{ type: "completed", toolCalls, stopReason }` — emitted exactly
 *     once at end of stream with the fully-accumulated tool calls and
 *     terminal stop reason
 *
 * Provider quirks handled:
 *   - OpenAI/OpenRouter `choices[0].delta.tool_calls` deltas accumulated
 *     by id (or by index when id arrives later).
 *   - Anthropic `content_block_start` (tool_use) + `input_json_delta`
 *     deltas accumulated by content-block index.
 *   - UTF-8 multi-byte characters split across SSE-event boundaries —
 *     the underlying TextDecoder runs with `stream: true` so the
 *     accumulated buffer never feeds a partial code-point to JSON.parse.
 *   - Stream closing before stop reason arrives — yields `completed`
 *     with whatever tool calls accumulated; the loop treats that as a
 *     non-toolUse terminal turn (model errored out mid-stream).
 *
 * The TextDecoder + boundary handling lives in {@link iterateSseData};
 * this iterator layers a parser+accumulator on top.
 */

import {
  absorbAnthropicToolCallEvent,
  extractAnthropicStopReason,
  extractAnthropicTextDelta,
} from "./anthropic-toolcalls.js";
import {
  absorbOpenAIToolCallDeltas,
  extractOpenAIStopReason,
  extractOpenAITextDelta,
  type ProviderStopReason,
  type ToolCallAccumulator,
} from "./openai-toolcalls.js";

export interface ParsedToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Empty object when rawArgs was empty or invalid. */
  args: Record<string, unknown>;
  /** Raw concatenated arguments string for diagnostics. */
  rawArgs: string;
}

export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "completed"; toolCalls: ParsedToolCall[]; stopReason: ProviderStopReason };

/**
 * Parse one decoded SSE `data:` payload string into a JSON object,
 * returning null for non-JSON payloads (e.g. `[DONE]`).
 */
function parsePayload(payload: string): unknown {
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function finalizeToolCalls(
  byId: Map<string, ToolCallAccumulator>,
  byIndex: Map<number, ToolCallAccumulator>,
): ParsedToolCall[] {
  // De-duplicate: prefer the byId entry when both maps contain the
  // same accumulator object. The OpenAI absorber stores entries in
  // both maps once an id is known; both refer to the same object, so
  // a Set on identity collapses them.
  const seen = new Set<ToolCallAccumulator>();
  const all: ToolCallAccumulator[] = [];
  for (const entry of byId.values()) {
    if (!seen.has(entry)) {
      seen.add(entry);
      all.push(entry);
    }
  }
  for (const entry of byIndex.values()) {
    if (!seen.has(entry)) {
      seen.add(entry);
      all.push(entry);
    }
  }
  return all.map((entry) => {
    let args: Record<string, unknown> = {};
    if (entry.rawArgs.length > 0) {
      try {
        const parsed = JSON.parse(entry.rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Leave args as {} — malformed JSON surfaces in the tool call as
        // an empty-args invocation. The execution path will most likely
        // reject the args via the tool's TypeBox schema; the rawArgs
        // string remains accessible for diagnostics.
      }
    }
    return { id: entry.id, name: entry.name, args, rawArgs: entry.rawArgs };
  });
}

export async function* iterateProviderStream(
  upstream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk, void, void> {
  const byId = new Map<string, ToolCallAccumulator>();
  const byIndex = new Map<number, ToolCallAccumulator>();
  let stopReason: ProviderStopReason = "stop";

  for await (const dataPayload of iterateSseData(upstream)) {
    const parsed = parsePayload(dataPayload);
    if (parsed === null) continue;

    // Text delta — try OpenAI shape first, then Anthropic.
    const oaText = extractOpenAITextDelta(parsed);
    if (oaText) {
      yield { type: "text", delta: oaText };
    } else {
      const anText = extractAnthropicTextDelta(parsed);
      if (anText) yield { type: "text", delta: anText };
    }

    // Tool-call deltas. Both absorbers no-op when the payload shape
    // doesn't match their provider, so it's safe to call both.
    absorbOpenAIToolCallDeltas(parsed, { byId, byIndex });
    absorbAnthropicToolCallEvent(parsed, { byIndex });

    // Stop reason — first non-null wins; later events are ignored.
    if (stopReason === "stop") {
      const oa = extractOpenAIStopReason(parsed);
      if (oa) stopReason = oa;
      else {
        const an = extractAnthropicStopReason(parsed);
        if (an) stopReason = an;
      }
    }
  }

  const toolCalls = finalizeToolCalls(byId, byIndex);
  // If the model emitted tool calls but the upstream truncated before
  // a finish_reason arrived, treat as toolUse so the loop dispatches.
  if (toolCalls.length > 0 && stopReason === "stop") stopReason = "toolUse";
  yield { type: "completed", toolCalls, stopReason };
}

/**
 * Generic SSE parser — yields `data:` payloads one at a time as they
 * arrive from an upstream ReadableStream. Events are separated by a
 * blank line; non-data fields (`event:`, `id:`, `retry:`) are ignored.
 *
 * The TextDecoder runs with `stream: true` so multi-byte UTF-8 chars
 * split across read boundaries are buffered until complete — critical
 * for tool_call argument JSON containing non-ASCII content.
 */
export async function* iterateSseData(
  upstream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = extractSseData(rawEvent);
        if (payload !== null) yield payload;
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim().length > 0) {
      const payload = extractSseData(buffer);
      if (payload !== null) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractSseData(rawEvent: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line[5] === " " ? line.slice(6) : line.slice(5));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}
