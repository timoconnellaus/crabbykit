/**
 * Bundle runtime — constructs per turn from a verified token,
 * builds adapter clients from SpineService RPC, runs the bundle's
 * capabilities and tool chain, and returns agent events as a stream.
 *
 * This runtime is async-by-default and stateless across turns.
 */

import { mergeSections } from "./prompt/merge-sections.js";
import {
  createCostEmitter,
  createHookBridge,
  createKvStoreClient,
  createSchedulerClient,
  createSessionChannel,
  createSessionStoreClient,
} from "./spine-clients.js";
import type {
  BundleAgentSetup,
  BundleCapability,
  BundleCapabilityHooks,
  BundleContext,
  BundleEnv,
  BundlePromptSection,
} from "./types.js";

interface SpineBinding {
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Construct a BundleContext for a single turn.
 * The context is rebuilt from the token on every turn — no warm state.
 */
export function buildBundleContext<TEnv extends BundleEnv>(
  env: TEnv,
  spine: SpineBinding,
  agentId: string,
  sessionId: string,
): BundleContext {
  const getToken = (): string => {
    const token = env.__BUNDLE_TOKEN;
    if (!token) throw new Error("Missing __BUNDLE_TOKEN");
    return token;
  };

  return {
    agentId,
    sessionId,
    env,
    sessionStore: createSessionStoreClient(spine as never, getToken),
    kvStore: createKvStoreClient(spine as never, getToken),
    scheduler: createSchedulerClient(spine as never, getToken),
    channel: createSessionChannel(spine as never, getToken),
    emitCost: createCostEmitter(spine as never, getToken),
    hookBridge: createHookBridge(spine as never, getToken),
  };
}

/**
 * LLM service binding as seen from the bundle env. Typed loosely since
 * the WorkerEntrypoint class is not importable from the bundle subpath.
 */
interface BundleLlmBinding {
  inferStream(token: string, request: unknown): Promise<ReadableStream<Uint8Array>>;
}

interface MinimalMessage {
  role: string;
  content: unknown;
}

interface AssistantPartial {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

function emptyUsage(): AssistantPartial["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Flatten assorted content shapes down to a plain text string for
 * submission to the LLM provider. Session history may store content
 * as a string or as an array of typed content blocks; we unwrap the
 * text parts and drop the rest. Tool calls and thinking blocks are
 * intentionally not round-tripped — bundle v1 streaming does not
 * replay tool-use history.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join("");
  }
  return "";
}

/**
 * Normalize history entries from `sessionStore.buildContext()` into the
 * shape the LLM provider expects. Non-chat entries and entries missing
 * a recognized role are filtered out.
 */
function historyToMessages(history: unknown): MinimalMessage[] {
  if (!Array.isArray(history)) return [];
  const result: MinimalMessage[] = [];
  for (const entry of history) {
    if (typeof entry !== "object" || entry === null) continue;
    const msg = entry as Record<string, unknown>;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = flattenContent(msg.content);
    if (!text) continue;
    result.push({ role, content: text });
  }
  return result;
}

/**
 * Generic SSE parser — yields `data:` payloads one at a time as they
 * arrive from an upstream ReadableStream. Events are separated by a
 * blank line; non-data fields (`event:`, `id:`, `retry:`) are ignored.
 * All providers we support emit plain `data:` chunks.
 */
async function* iterateSseData(
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
      // "data: foo" or "data:foo" — strip marker plus one optional space
      dataLines.push(line[5] === " " ? line.slice(6) : line.slice(5));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

/**
 * Extract a text delta from a provider SSE data payload. Supports
 * OpenAI/OpenRouter chat-completions format and Anthropic messages
 * format. Returns an empty string for payloads that carry no delta.
 */
function extractDelta(payload: string): string {
  if (payload === "[DONE]") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";

  const obj = parsed as Record<string, unknown>;

  // OpenAI / OpenRouter chat completions streaming
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const delta = first?.delta as Record<string, unknown> | undefined;
    const content = delta?.content;
    if (typeof content === "string") return content;
  }

  // Anthropic messages streaming
  if (obj.type === "content_block_delta") {
    const delta = obj.delta as Record<string, unknown> | undefined;
    if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
  }

  return "";
}

/**
 * Run a bundle turn: build messages, call LlmService.inferStream, and
 * broadcast streaming AgentEvents to the client live via
 * `context.channel.broadcast`. The returned stream carries no
 * per-token content — it's a short ack the host dispatcher awaits
 * for turn-completion and auto-revert accounting.
 *
 * Tool execution is not yet wired through this path — v1 streams
 * text-only turns. Tool support comes in a follow-up.
 */
export function runBundleTurn<TEnv extends BundleEnv>(
  setup: BundleAgentSetup<TEnv>,
  env: TEnv,
  prompt: string,
  context: BundleContext,
): ReadableStream<Uint8Array> {
  const work = async (): Promise<void> => {
    const model = typeof setup.model === "function" ? setup.model() : setup.model;
    const timestamp = Date.now();

    // 1a. Resolve bundle-side capabilities and author-supplied tools
    //     once per turn. Both factories run inside the bundle isolate
    //     with access to the projected env. Capability tools/sections
    //     and per-cap hooks are then collected for the per-turn loop.
    const capabilities: BundleCapability[] = setup.capabilities?.(env) ?? [];
    const setupTools: unknown[] = setup.tools?.(env) ?? [];

    const mergedTools: unknown[] = [...setupTools];
    const capabilitySections: Array<string | BundlePromptSection> = [];
    const beforeInferenceHooks: NonNullable<BundleCapabilityHooks["beforeInference"]>[] = [];
    const afterToolExecutionHooks: NonNullable<BundleCapabilityHooks["afterToolExecution"]>[] = [];
    for (const cap of capabilities) {
      const capTools = cap.tools?.(context) ?? [];
      for (const t of capTools) mergedTools.push(t);
      const capSections = cap.promptSections?.(context) ?? [];
      for (const s of capSections) capabilitySections.push(s);
      if (cap.hooks?.beforeInference) beforeInferenceHooks.push(cap.hooks.beforeInference);
      if (cap.hooks?.afterToolExecution) afterToolExecutionHooks.push(cap.hooks.afterToolExecution);
    }
    // Phase 0a: mergedTools and the bundle-side hook arrays are plumbed
    // into the closure but NOT advertised to the LLM yet. Tool
    // advertisement and execution land in Phase 0b together so the
    // model can never emit a call the bundle silently fails to run.
    void mergedTools;
    void beforeInferenceHooks;
    void afterToolExecutionHooks;

    // 1b. Compose system prompt: setup.prompt: string overrides all
    //     capability sections (parity with static `defineAgent`).
    //     Otherwise default-builder output is followed by capability
    //     sections.
    const systemPrompt = mergeSections(setup.prompt, capabilitySections);

    // 2. Load history via spine (walks to most recent compaction boundary)
    let history: MinimalMessage[] = [];
    try {
      const raw = await context.sessionStore.buildContext();
      history = historyToMessages(raw);
    } catch {
      history = [];
    }

    // 3. Assemble message list: system + history + current user prompt
    const messages: MinimalMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const m of history) messages.push(m);
    messages.push({ role: "user", content: prompt });

    // 4. Validate LLM binding and token
    const bundleToken = env.__BUNDLE_TOKEN;
    if (!bundleToken) {
      throw new Error("Missing __BUNDLE_TOKEN in bundle env");
    }
    const llm = (env as Record<string, unknown>).LLM as BundleLlmBinding | undefined;
    if (!llm || typeof llm.inferStream !== "function") {
      throw new Error("Missing env.LLM service binding with inferStream method");
    }

    // 4b. Route messages through the host hook-bus bridge so every
    //     `beforeInference` hook registered on the host fires against the
    //     bundle's pre-inference message stream and the inference call
    //     uses the (possibly mutated) result. Matches Decision 5 in the
    //     bundle-shape-2-rollout design.
    const bridgedMessages = (await context.hookBridge.processBeforeInference(
      messages as unknown[],
    )) as MinimalMessage[];

    // 5. Seed assistant-message partial. Mirrors the shape pi-ai emits
    //    so the client reducer treats bundle streams identically to
    //    native inference.
    const partial: AssistantPartial = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: model.provider,
      model: model.modelId,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp,
    };

    // 6. Broadcast message_start
    await safeBroadcast(context, { type: "message_start", message: { ...partial } });

    // 7. Open upstream SSE
    const upstream = await llm.inferStream(bundleToken, {
      provider: model.provider,
      modelId: model.modelId,
      messages: bridgedMessages,
    });

    // 8. Stream deltas
    let accumulated = "";
    for await (const dataPayload of iterateSseData(upstream)) {
      const delta = extractDelta(dataPayload);
      if (!delta) continue;
      accumulated += delta;
      partial.content = [{ type: "text", text: accumulated }];
      await safeBroadcast(context, {
        type: "message_update",
        message: { ...partial, content: [{ type: "text", text: accumulated }] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial: { ...partial, content: [{ type: "text", text: accumulated }] },
        },
      });
    }

    // 9. Finalize
    const finalMessage: AssistantPartial = {
      ...partial,
      content: [{ type: "text", text: accumulated }],
    };
    await safeBroadcast(context, { type: "message_end", message: finalMessage });

    // 10. Persist final assistant message
    try {
      await context.sessionStore.appendEntry({
        type: "message",
        data: {
          role: "assistant",
          content: [{ type: "text", text: accumulated }],
          timestamp,
        },
      });
    } catch {
      // Persistence failure is logged host-side; don't abort the turn.
    }

    // 11. agent_end
    await safeBroadcast(context, { type: "agent_end", messages: [finalMessage] });
  };

  return new ReadableStream({
    async start(controller) {
      try {
        await work();
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ ok: true })}\n`));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Surface the error to the client so the UI doesn't hang on
        // an unterminated stream, then rethrow so the host dispatcher
        // increments its failure counter.
        const errorMessage: AssistantPartial = {
          role: "assistant",
          content: [{ type: "text", text: `[Bundle error] ${message}` }],
          api: "openai-completions",
          provider: "unknown",
          model: "unknown",
          usage: emptyUsage(),
          stopReason: "error",
          errorMessage: message,
          timestamp: Date.now(),
        };
        await safeBroadcast(context, { type: "message_end", message: errorMessage });
        await safeBroadcast(context, { type: "agent_end", messages: [] });
        controller.error(err);
      }
    },
  });
}

/**
 * Wrap a channel.broadcast call so a transport hiccup on one event
 * doesn't abort the whole turn — persistence is the durable record.
 */
async function safeBroadcast(context: BundleContext, event: unknown): Promise<void> {
  try {
    await context.channel.broadcast({ type: "agent_event", event });
  } catch {
    // Intentional: streaming events are best-effort.
  }
}
