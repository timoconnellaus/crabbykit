/**
 * Bundle runtime — constructs per turn from a verified token,
 * builds adapter clients from SpineService RPC, runs the bundle's
 * capabilities and tool chain, and returns agent events as a stream.
 *
 * This runtime is async-by-default and stateless across turns.
 */

import { mergeSections } from "./prompt/merge-sections.js";
import {
  iterateProviderStream,
  type ParsedToolCall,
  type StreamChunk,
} from "./providers/stream-iterator.js";
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
  BundleHookContext,
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
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Duck-typed bundle tool. Matches the structural subset of
 * `@claw-for-cloudflare/agent-runtime`'s `AnyAgentTool` that the bundle
 * needs to advertise to the model and execute on tool calls. Bundle
 * SDK does not import `agent-runtime` (boundary invariant), so the
 * shape is asserted at the use site.
 */
interface BundleToolDuck {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (
    args: unknown,
    ctx: { toolCallId: string; signal?: AbortSignal },
  ) => Promise<unknown> | unknown;
}

interface AssistantPartial {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: unknown }
  >;
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

const MAX_INFERENCE_ITERATIONS_PER_TURN = 25;

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
 * text parts and drop the rest. Tool calls and thinking blocks from
 * prior turns are intentionally not round-tripped — the bundle's
 * within-turn tool loop handles them in-memory.
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
 * shape the LLM provider expects. Only user and assistant text-content
 * entries are replayed; toolResult entries from prior turns are
 * dropped because the corresponding assistant tool_calls would also
 * need replay and the bundle does not currently round-trip those.
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
 * Convert a duck-typed bundle tool into the OpenAI/OpenRouter
 * `tool_calls`-compatible advertisement shape. The bundle's tool
 * execution loop targets OpenAI shape on the wire — bundles using
 * Anthropic-direct providers can route via OpenRouter to keep this
 * single shape. Anthropic-direct support is a follow-up if required.
 */
function toOpenAIToolAdvertisement(t: BundleToolDuck): unknown {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  };
}

function isBundleToolDuck(value: unknown): value is BundleToolDuck {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.execute === "function";
}

/** Stringify a tool's return value into the text content the LLM sees. */
function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const parts: string[] = [];
      for (const block of r.content) {
        if (typeof block === "string") parts.push(block);
        else if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          parts.push((block as { text: string }).text);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/**
 * Run a bundle turn: resolve capabilities + tools, build the system
 * prompt and message stream, run the inference + tool-execution loop
 * until the model emits a non-toolUse stop reason or the iteration
 * cap is reached, and broadcast streaming AgentEvents to the client
 * live via `context.channel.broadcast`. The returned stream carries
 * a short ack the host dispatcher awaits for turn-completion and
 * auto-revert accounting.
 *
 * Phase 0b adds the tool-execution loop: tool calls parsed from the
 * model stream are executed against the merged tool list, results
 * appended back to the conversation, and inference re-run until a
 * non-toolUse stop reason or the per-turn cap (25 iterations).
 */
export function runBundleTurn<TEnv extends BundleEnv>(
  setup: BundleAgentSetup<TEnv>,
  env: TEnv,
  prompt: string,
  context: BundleContext,
): ReadableStream<Uint8Array> {
  const work = async (): Promise<void> => {
    const model = typeof setup.model === "function" ? setup.model() : setup.model;

    // 1a. Resolve bundle-side capabilities and author-supplied tools
    //     once per turn. Both factories run inside the bundle isolate
    //     with access to the projected env. Capability tools/sections
    //     and per-cap hooks are then collected for the per-turn loop.
    const capabilities: BundleCapability[] = setup.capabilities?.(env) ?? [];
    const setupTools: unknown[] = setup.tools?.(env) ?? [];

    const mergedTools: unknown[] = [...setupTools];
    const capabilitySections: Array<string | BundlePromptSection> = [];
    const beforeInferenceHooks: Array<{
      capabilityId: string;
      fn: NonNullable<BundleCapabilityHooks["beforeInference"]>;
    }> = [];
    const afterToolExecutionHooks: Array<{
      capabilityId: string;
      fn: NonNullable<BundleCapabilityHooks["afterToolExecution"]>;
    }> = [];
    for (const cap of capabilities) {
      const capTools = cap.tools?.(context) ?? [];
      for (const t of capTools) mergedTools.push(t);
      const capSections = cap.promptSections?.(context) ?? [];
      for (const s of capSections) capabilitySections.push(s);
      if (cap.hooks?.beforeInference)
        beforeInferenceHooks.push({ capabilityId: cap.id, fn: cap.hooks.beforeInference });
      if (cap.hooks?.afterToolExecution)
        afterToolExecutionHooks.push({ capabilityId: cap.id, fn: cap.hooks.afterToolExecution });
    }

    // Build the per-name tool lookup AND the provider tool advertisement
    // list. Skip non-conforming entries silently — they do not appear
    // in the LLM advertisement and any tool call by name therefore
    // surfaces as "Unknown tool" via the execute path.
    const toolByName = new Map<string, BundleToolDuck>();
    const advertisedTools: unknown[] = [];
    for (const t of mergedTools) {
      if (!isBundleToolDuck(t)) continue;
      toolByName.set(t.name, t);
      advertisedTools.push(toOpenAIToolAdvertisement(t));
    }

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
    const conversation: MinimalMessage[] = [];
    if (systemPrompt) conversation.push({ role: "system", content: systemPrompt });
    for (const m of history) conversation.push(m);
    conversation.push({ role: "user", content: prompt });

    // 4. Validate LLM binding and token
    const bundleToken = env.__BUNDLE_TOKEN;
    if (!bundleToken) {
      throw new Error("Missing __BUNDLE_TOKEN in bundle env");
    }
    const llm = (env as Record<string, unknown>).LLM as BundleLlmBinding | undefined;
    if (!llm || typeof llm.inferStream !== "function") {
      throw new Error("Missing env.LLM service binding with inferStream method");
    }

    const finalAssistantMessages: AssistantPartial[] = [];

    // Tool-execution loop. One iteration = one inference + (optionally)
    // one round of tool executions. Cap prevents runaway loops on
    // pathological bundles.
    for (let iter = 0; iter < MAX_INFERENCE_ITERATIONS_PER_TURN; iter++) {
      // 5a. Bundle-side beforeInference hooks (registration order),
      //     then host hook bridge. Order matches Decision 4 in
      //     bundle-runtime-surface design — bundle isolates' hooks
      //     fire first so host bridge sees the post-bundle stream.
      //     Snapshot conversation so subsequent appends to the
      //     working array don't retroactively mutate the message
      //     list sent to the model in this iteration.
      let preMessages: MinimalMessage[] = [...conversation];
      for (const hook of beforeInferenceHooks) {
        const next = await hook.fn(
          preMessages as unknown[],
          {
            ...context,
            capabilityId: hook.capabilityId,
          } as BundleHookContext,
        );
        if (Array.isArray(next)) preMessages = next as MinimalMessage[];
      }
      const bridgedMessages = (await context.hookBridge.processBeforeInference(
        preMessages as unknown[],
      )) as MinimalMessage[];

      // 5b. Seed assistant-message partial. Mirrors the shape pi-ai
      //     emits so the client reducer treats bundle streams identically
      //     to native inference.
      const partial: AssistantPartial = {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: model.provider,
        model: model.modelId,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };

      await safeBroadcast(context, { type: "message_start", message: { ...partial } });

      // 5c. Open upstream SSE
      const requestBody: Record<string, unknown> = {
        provider: model.provider,
        modelId: model.modelId,
        messages: bridgedMessages,
      };
      if (advertisedTools.length > 0) requestBody.tools = advertisedTools;
      const upstream = await llm.inferStream(bundleToken, requestBody);

      // 5d. Iterate the unified provider stream. Text deltas broadcast
      //     live; tool calls accumulate; the iterator yields a single
      //     `completed` chunk at end with the full call list and
      //     terminal stop reason.
      let textBuffer = "";
      let completedToolCalls: ParsedToolCall[] = [];
      let stopReason: AssistantPartial["stopReason"] = "stop";
      for await (const chunk of iterateProviderStream(upstream) as AsyncIterable<StreamChunk>) {
        if (chunk.type === "text") {
          textBuffer += chunk.delta;
          partial.content = [{ type: "text", text: textBuffer }];
          await safeBroadcast(context, {
            type: "message_update",
            message: { ...partial, content: [{ type: "text", text: textBuffer }] },
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: chunk.delta,
              partial: { ...partial, content: [{ type: "text", text: textBuffer }] },
            },
          });
        } else {
          completedToolCalls = chunk.toolCalls;
          stopReason = chunk.stopReason;
        }
      }

      // 5e. Finalize the assistant message for this iteration.
      const finalContent: AssistantPartial["content"] = [];
      if (textBuffer) finalContent.push({ type: "text", text: textBuffer });
      for (const tc of completedToolCalls) {
        finalContent.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args });
      }
      const finalMessage: AssistantPartial = {
        ...partial,
        content: finalContent,
        stopReason,
      };
      finalAssistantMessages.push(finalMessage);
      await safeBroadcast(context, { type: "message_end", message: finalMessage });

      // 5f. Persist assistant message
      try {
        await context.sessionStore.appendEntry({
          type: "message",
          data: {
            role: "assistant",
            content: finalContent,
            timestamp: finalMessage.timestamp,
          },
        });
      } catch {
        // Persistence failure is logged host-side; don't abort the turn.
      }

      // 5g. Append assistant turn to conversation in OpenAI shape so
      //     subsequent inference calls round-trip the tool_calls.
      const assistantTurn: MinimalMessage = { role: "assistant", content: textBuffer };
      if (completedToolCalls.length > 0) {
        assistantTurn.tool_calls = completedToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.rawArgs.length > 0 ? tc.rawArgs : "{}" },
        }));
      }
      conversation.push(assistantTurn);

      // 5h. Terminal check — non-toolUse OR no parsed calls means the
      //     turn is done.
      if (stopReason !== "toolUse" || completedToolCalls.length === 0) {
        await safeBroadcast(context, {
          type: "agent_end",
          messages: finalAssistantMessages,
        });
        return;
      }

      // 5i. Execute each tool call sequentially. Tool-call concurrency
      //     within a turn (parallel execution) is a documented v2.1
      //     follow-up; pi-agent-core's parallel sequencer was not
      //     extractable into the isolate within the audit budget
      //     (task 2.11).
      for (const tc of completedToolCalls) {
        const toolCallId = tc.id || `call_${iter}_${tc.name}`;
        // Pre-execution hook bridge gate
        let blocked = false;
        let blockReason = "blocked by host hook";
        try {
          const beforeResult = await context.hookBridge.processBeforeToolExecution({
            toolName: tc.name,
            args: tc.args,
            toolCallId,
          });
          if (beforeResult?.block) {
            blocked = true;
            if (typeof beforeResult.reason === "string") blockReason = beforeResult.reason;
          }
        } catch {
          // Bridge failure: fail open — let the tool execute. Errors
          // here mean the host couldn't reach the bridge, not a deny.
        }

        await safeBroadcast(context, {
          type: "tool_execution_start",
          toolCallId,
          toolName: tc.name,
          args: tc.args,
        });

        if (blocked) {
          await safeBroadcast(context, {
            type: "tool_execution_end",
            toolCallId,
            toolName: tc.name,
            result: { content: [{ type: "text", text: blockReason }], details: null },
            isError: true,
          });
          await persistToolResult(context, toolCallId, tc.name, blockReason, true);
          conversation.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: blockReason,
          });
          continue;
        }

        const tool = toolByName.get(tc.name);
        let resultText: string;
        let isError = false;
        if (!tool) {
          resultText = `Unknown tool: ${tc.name}`;
          isError = true;
        } else {
          try {
            const raw = await tool.execute(tc.args, { toolCallId });
            resultText = stringifyToolResult(raw);
          } catch (err) {
            resultText = err instanceof Error ? err.message : String(err);
            isError = true;
          }
        }

        // Bundle-side afterToolExecution hooks fire FIRST in
        // registration order (Decision 4) so bundle-internal state
        // settles before the host bridge sees the event.
        for (const hook of afterToolExecutionHooks) {
          try {
            await hook.fn({ toolName: tc.name, args: tc.args, isError, result: resultText }, {
              ...context,
              capabilityId: hook.capabilityId,
            } as BundleHookContext);
          } catch {
            // One hook's failure must not abort the chain or the
            // remaining tool calls in this iteration.
          }
        }
        try {
          await context.hookBridge.recordToolExecution({
            toolName: tc.name,
            args: tc.args,
            isError,
          });
        } catch {
          // Bridge failure is logged host-side; tool result still
          // flows to the model and is persisted.
        }

        await safeBroadcast(context, {
          type: "tool_execution_end",
          toolCallId,
          toolName: tc.name,
          result: { content: [{ type: "text", text: resultText }], details: null },
          isError,
        });
        await persistToolResult(context, toolCallId, tc.name, resultText, isError);
        conversation.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: resultText,
        });
      }
    }

    // Iteration cap reached — surface as an explicit error so the
    // operator sees a runaway-bundle signal rather than a silent stop.
    throw new Error(
      `Bundle turn exceeded max inference iterations (${MAX_INFERENCE_ITERATIONS_PER_TURN})`,
    );
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

async function persistToolResult(
  context: BundleContext,
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
): Promise<void> {
  try {
    await context.sessionStore.appendEntry({
      type: "message",
      data: {
        role: "toolResult",
        content: [{ type: "text", text }],
        details: null,
        toolCallId,
        toolName,
        isError,
        timestamp: Date.now(),
      },
    });
  } catch {
    // Persistence failure is logged host-side; the in-memory
    // conversation still carries the result for the next iteration.
  }
}

/**
 * Wrap a channel.broadcast call so a transport hiccup on one event
 * doesn't abort the whole turn — persistence is the durable record.
 *
 * Tool-execution events use `tool_event` so the host's transport
 * routes them to the same `ToolEventMessage` shape clients receive
 * for static-brain tool calls; everything else uses `agent_event`.
 */
async function safeBroadcast(context: BundleContext, event: unknown): Promise<void> {
  try {
    const evType = (event as { type?: unknown }).type;
    const wrapper =
      evType === "tool_execution_start" ||
      evType === "tool_execution_update" ||
      evType === "tool_execution_end"
        ? { type: "tool_event", event }
        : { type: "agent_event", event };
    await context.channel.broadcast(wrapper);
  } catch {
    // Intentional: streaming events are best-effort.
  }
}
