/**
 * OpenAI / OpenRouter chat-completions streaming tool-call accumulator.
 *
 * Parses one already-decoded SSE `data:` payload at a time. The shape:
 *
 *   { choices: [{ delta: { tool_calls: [...] } | { content: "..." }, finish_reason: "..." }] }
 *
 * Tool-call deltas arrive incrementally — the same call's
 * `function.arguments` may stretch across many SSE events as a JSON
 * string. Per-call accumulation is keyed by the call id where supplied;
 * when the first delta in a stream omits the id (some providers emit
 * `index` alone first), the index is used as the lookup key until an
 * id arrives.
 *
 * `parseStopReason` translates OpenAI's `finish_reason` to the
 * provider-agnostic stop reason the bundle loop branches on.
 *
 * Vendoring decision (task 2.0): pi-ai's parsers in
 * `packages/runtime/ai/src/providers/openai-completions.ts` are
 * deeply coupled to the openai SDK client and the `streaming-json`
 * partial-args parser, both of which carry the CJS-in-Workers issue
 * documented in CLAUDE.md. Extracting them into an isolate-safe
 * shared helper would have required disentangling those deps within
 * the 1-day budget — not feasible. Bundle SDK ships its own narrow
 * parsers here; correctness is enforced by the recorded SSE fixture
 * matrix (task 2.4).
 */

export interface ToolCallAccumulator {
  /** Stable call id once known. May start empty if the first delta omits it. */
  id: string;
  /** Tool name. May arrive on the first delta or on a later delta. */
  name: string;
  /** Raw concatenated `function.arguments` JSON string across deltas. */
  rawArgs: string;
}

export type ProviderStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface OpenAIChoice {
  delta?: {
    content?: unknown;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: unknown; arguments?: unknown };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAIChunk {
  choices?: OpenAIChoice[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Inspect a parsed payload and return the OpenAI text delta (if any).
 * Returns the empty string for non-text payloads.
 */
export function extractOpenAITextDelta(payload: unknown): string {
  if (!isObject(payload)) return "";
  const chunk = payload as OpenAIChunk;
  const choice = chunk.choices?.[0];
  const content = choice?.delta?.content;
  return typeof content === "string" ? content : "";
}

/**
 * Map OpenAI's `finish_reason` to the bundle's provider-agnostic stop
 * reason. Returns null when no finish_reason is present in the payload.
 */
export function extractOpenAIStopReason(payload: unknown): ProviderStopReason | null {
  if (!isObject(payload)) return null;
  const chunk = payload as OpenAIChunk;
  const finish = chunk.choices?.[0]?.finish_reason;
  if (!finish) return null;
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "toolUse";
    case "length":
      return "length";
    case "stop":
    case "end_turn":
      return "stop";
    default:
      return "stop";
  }
}

/**
 * Absorb any tool-call deltas in a parsed OpenAI payload into the
 * accumulator state.
 *
 * `byId` is keyed by the call's stable id once known. `byIndex`
 * tracks the original `index` field — used as the lookup key when
 * the first delta arrives without an id, and to stitch later deltas
 * back to the same accumulator regardless of whether they include
 * the id.
 */
export function absorbOpenAIToolCallDeltas(
  payload: unknown,
  state: {
    byId: Map<string, ToolCallAccumulator>;
    byIndex: Map<number, ToolCallAccumulator>;
  },
): void {
  if (!isObject(payload)) return;
  const choices = (payload as OpenAIChunk).choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const tcs = choice?.delta?.tool_calls;
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const idxKey = typeof tc.index === "number" ? tc.index : undefined;
      let entry: ToolCallAccumulator | undefined;
      if (idxKey !== undefined) entry = state.byIndex.get(idxKey);
      if (!entry && typeof tc.id === "string" && tc.id.length > 0) {
        entry = state.byId.get(tc.id);
      }
      if (!entry) {
        entry = {
          id: typeof tc.id === "string" ? tc.id : "",
          name: typeof tc.function?.name === "string" ? tc.function.name : "",
          rawArgs: "",
        };
        if (idxKey !== undefined) state.byIndex.set(idxKey, entry);
        if (entry.id) state.byId.set(entry.id, entry);
      } else {
        if (typeof tc.id === "string" && tc.id.length > 0 && tc.id !== entry.id) {
          entry.id = tc.id;
          state.byId.set(tc.id, entry);
        }
        if (typeof tc.function?.name === "string" && entry.name === "") {
          entry.name = tc.function.name;
        }
      }
      if (typeof tc.function?.arguments === "string") {
        entry.rawArgs += tc.function.arguments;
      }
    }
  }
}
