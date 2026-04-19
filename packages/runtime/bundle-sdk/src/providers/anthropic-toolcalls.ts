/**
 * Anthropic messages-API streaming tool-call accumulator.
 *
 * Anthropic streams content blocks discretely:
 *   - `content_block_start` with `content_block: { type: "tool_use", id, name, input: {} }`
 *     declares a tool-use block at a given content-block `index`.
 *   - `content_block_delta` with `delta: { type: "input_json_delta", partial_json: "..." }`
 *     accumulates JSON arguments for the block at that index.
 *   - `content_block_stop` finalizes the block.
 *   - `message_delta` with `delta.stop_reason` carries the terminal reason.
 *   - `content_block_delta` with `delta: { type: "text_delta", text: "..." }`
 *     carries text deltas (text blocks live alongside tool_use blocks).
 *
 * Accumulation is keyed by content-block `index` (block ids would also
 * work but `index` is what the deltas carry).
 */

import type { ProviderStopReason, ToolCallAccumulator } from "./openai-toolcalls.js";

interface AnthropicEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Inspect a parsed Anthropic event and return its text delta (if any).
 */
export function extractAnthropicTextDelta(payload: unknown): string {
  if (!isObject(payload)) return "";
  const ev = payload as AnthropicEvent;
  if (ev.type !== "content_block_delta") return "";
  const d = ev.delta;
  if (d?.type === "text_delta" && typeof d.text === "string") return d.text;
  return "";
}

/**
 * Map Anthropic's `stop_reason` (delivered on `message_delta`) to
 * the bundle's provider-agnostic stop reason.
 */
export function extractAnthropicStopReason(payload: unknown): ProviderStopReason | null {
  if (!isObject(payload)) return null;
  const ev = payload as AnthropicEvent;
  if (ev.type !== "message_delta") return null;
  const sr = ev.delta?.stop_reason;
  if (!sr) return null;
  switch (sr) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

/**
 * Absorb a single Anthropic SSE event into the byIndex accumulator.
 *
 * Note: Anthropic emits both text and tool-use blocks at distinct
 * `index` values. We only allocate accumulator entries for tool_use
 * blocks; text blocks are handled by {@link extractAnthropicTextDelta}.
 */
export function absorbAnthropicToolCallEvent(
  payload: unknown,
  state: {
    byIndex: Map<number, ToolCallAccumulator>;
  },
): void {
  if (!isObject(payload)) return;
  const ev = payload as AnthropicEvent;

  if (ev.type === "content_block_start") {
    const block = ev.content_block;
    if (block?.type !== "tool_use") return;
    const idx = ev.index;
    if (typeof idx !== "number") return;
    state.byIndex.set(idx, {
      id: typeof block.id === "string" ? block.id : "",
      name: typeof block.name === "string" ? block.name : "",
      rawArgs: "",
    });
    return;
  }

  if (ev.type === "content_block_delta") {
    const idx = ev.index;
    if (typeof idx !== "number") return;
    const entry = state.byIndex.get(idx);
    if (!entry) return;
    const d = ev.delta;
    if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
      entry.rawArgs += d.partial_json;
    }
  }
}
