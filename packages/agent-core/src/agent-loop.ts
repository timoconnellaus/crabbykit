/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
  type AssistantMessage,
  type Context,
  EventStream,
  streamSimple,
  type ToolResultMessage,
  validateToolArguments,
} from "@claw-for-cloudflare/ai";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AgentToolUpdateCallback,
  StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  void runAgentLoop(
    prompts,
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
  ).then((messages) => {
    stream.end(messages);
  });

  return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const stream = createAgentStream();

  void runAgentLoopContinue(
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
  ).then((messages) => {
    stream.end(messages);
  });

  return stream;
}

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
const DEFAULT_MAX_ITERATIONS = 100;

/** Patterns that indicate transient/retryable LLM errors. */
const TRANSIENT_ERROR_PATTERNS = [
  /\b429\b/, // Rate limit
  /\b500\b/, // Internal server error
  /\b502\b/, // Bad gateway
  /\b503\b/, // Service unavailable
  /\b529\b/, // Overloaded
  /timeout/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /network/i,
  /overloaded/i,
  /rate.?limit/i,
];

function isTransientError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<void> {
  let firstTurn = true;
  let iterationCount = 0;
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // Check for steering messages at start (user may have typed while waiting)
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  // Outer loop: continues when queued follow-up messages arrive after agent would stop
  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      iterationCount++;
      if (iterationCount > maxIterations) {
        // Synthetic error message — api/provider/model/usage are placeholder values since no LLM call was made
        const errorMessage: AssistantMessage = {
          role: "assistant",
          content: [
            {
              type: "text" as const,
              text: `Agent loop terminated: exceeded maximum iterations (${maxIterations}).`,
            },
          ],
          api: "openai-completions",
          provider: "unknown",
          model: "unknown",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: `Maximum loop iterations (${maxIterations}) exceeded`,
          timestamp: Date.now(),
        };
        currentContext.messages.push(errorMessage);
        newMessages.push(errorMessage);
        await emit({ type: "message_start", message: errorMessage });
        await emit({ type: "message_end", message: errorMessage });
        await emit({ type: "turn_end", message: errorMessage, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // Process pending messages (inject before next assistant response)
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // Stream assistant response (with retry for transient errors)
      let message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);

      if (message.stopReason === "error" && isTransientError(message.errorMessage)) {
        const maxRetries = config.maxStreamRetries ?? 2;
        const baseDelay = config.baseRetryDelayMs ?? 1000;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          if (signal?.aborted) break;
          const delay = baseDelay * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (signal?.aborted) break;
          // Remove the failed message from context before retry
          if (currentContext.messages[currentContext.messages.length - 1] === message) {
            currentContext.messages.pop();
          }
          message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
          if (message.stopReason !== "error" || !isTransientError(message.errorMessage)) break;
        }
      }

      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Check for tool calls
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;

      let toolResults: ToolResultMessage[] = [];
      let checkpointResponse: AssistantMessage | undefined;
      if (hasMoreToolCalls) {
        const executionResult = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit,
          streamFn,
        );
        toolResults = executionResult.toolResults;
        checkpointResponse = executionResult.checkpointResponse;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }

        // If a checkpoint resulted in the model aborting, process its response
        if (checkpointResponse) {
          // Don't emit message_start/message_end — checkpoint responses are internal
          // agent-loop communication (e.g., "ABORT"), not user-facing output.
          // The model's *next* response (after seeing the tool result) will be user-facing.
          currentContext.messages.push(checkpointResponse);
          newMessages.push(checkpointResponse);

          // Check if the checkpoint response has tool calls to execute
          const checkpointToolCalls = checkpointResponse.content.filter(
            (c) => c.type === "toolCall",
          );
          if (checkpointToolCalls.length > 0) {
            // Execute the checkpoint response's tool calls
            const checkpointExec = await executeToolCalls(
              currentContext,
              checkpointResponse,
              config,
              signal,
              emit,
              streamFn,
            );
            for (const result of checkpointExec.toolResults) {
              currentContext.messages.push(result);
              newMessages.push(result);
              toolResults.push(result);
            }
            // Force another turn so the model sees the tool results
            hasMoreToolCalls = true;
          }
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // Agent would stop here. Check for follow-up messages.
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      // Set as pending so inner loop processes them
      pendingMessages = followUpMessages;
      continue;
    }

    // No more messages, exit
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<AssistantMessage> {
  // Apply context transform if configured (AgentMessage[] → AgentMessage[])
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // Convert to LLM-compatible messages (AgentMessage[] → Message[])
  const llmMessages = await config.convertToLlm(messages);

  // Build LLM context
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction = streamFn || streamSimple;

  // Resolve API key (important for expiring tokens)
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<ToolCallExecutionResult> {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  if (config.toolExecution === "sequential") {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      emit,
      streamFn,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    emit,
    streamFn,
  );
}

/** Result from tool call execution that may include a checkpoint response. */
interface ToolCallExecutionResult {
  toolResults: ToolResultMessage[];
  /** If the model decided to abort via checkpoint, this is its pending response. */
  checkpointResponse?: AssistantMessage;
}

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<ToolCallExecutionResult> {
  const results: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );
    if (preparation.kind === "immediate") {
      results.push(
        await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit),
      );
    } else {
      const executed = await executeWithCheckpoints(
        preparation,
        config,
        signal,
        emit,
        currentContext,
        streamFn,
      );
      results.push(
        await finalizeExecutedToolCall(
          currentContext,
          assistantMessage,
          preparation,
          executed,
          config,
          signal,
          emit,
        ),
      );

      // If the model decided to abort via checkpoint, skip remaining tool calls
      if (executed.checkpointResponse) {
        return { toolResults: results, checkpointResponse: executed.checkpointResponse };
      }
    }
  }

  return { toolResults: results };
}

async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<ToolCallExecutionResult> {
  const results: ToolResultMessage[] = [];
  const runnableCalls: PreparedToolCall[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );
    if (preparation.kind === "immediate") {
      results.push(
        await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit),
      );
    } else {
      runnableCalls.push(preparation);
    }
  }

  // Create a shared abort controller for all parallel tools — if any checkpoint
  // results in an abort, we cancel all remaining tools in the batch
  const batchAbort = new AbortController();
  if (signal) signal.addEventListener("abort", () => batchAbort.abort(), { once: true });

  const runningCalls = runnableCalls.map((prepared) => ({
    prepared,
    execution: executeWithCheckpoints(
      prepared,
      config,
      batchAbort.signal,
      emit,
      currentContext,
      streamFn,
    ),
  }));

  let checkpointResponse: AssistantMessage | undefined;

  for (const running of runningCalls) {
    const executed = await running.execution;
    results.push(
      await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        running.prepared,
        executed,
        config,
        signal,
        emit,
      ),
    );

    // If any tool's checkpoint results in abort, abort all remaining tools
    if (executed.checkpointResponse && !checkpointResponse) {
      checkpointResponse = executed.checkpointResponse;
      batchAbort.abort();
    }
  }

  return { toolResults: results, checkpointResponse };
}

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool<any>;
  args: unknown;
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult<any>;
  isError: boolean;
};

type ExecutedToolCallOutcome = {
  result: AgentToolResult<any>;
  isError: boolean;
};

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  try {
    const validatedArgs = validateToolArguments(tool, toolCall);
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext,
        },
        signal,
      );
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
          isError: true,
        };
      }
    }
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs,
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];

  try {
    const result = await prepared.tool.execute(prepared.args as never, {
      toolCallId: prepared.toolCall.id,
      signal,
      onUpdate: (partialResult) => {
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    });
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

/** Maximum number of checkpoints before letting the tool run to completion. */
const MAX_CHECKPOINTS = 5;

/** Maximum characters of partial output to include in checkpoint message. */
const CHECKPOINT_OUTPUT_LIMIT = 500;

/** Regex to parse CONTINUE responses (case-insensitive, optional delay in seconds). */
const CONTINUE_PATTERN = /^continue(?:\s+(\d+)s)?/i;

/**
 * Extract text content from a tool result for checkpoint messages.
 */
function extractTextFromToolResult(result: AgentToolResult<unknown>): string {
  const texts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      texts.push(block.text);
    }
  }
  const joined = texts.join("\n");
  if (joined.length > CHECKPOINT_OUTPUT_LIMIT) {
    return `...${joined.slice(-CHECKPOINT_OUTPUT_LIMIT)}`;
  }
  return joined;
}

/**
 * Outcome from `executeWithCheckpoints` — includes the normal tool result
 * plus an optional checkpoint response from the model if it decided to abort.
 */
interface CheckpointedToolCallOutcome extends ExecutedToolCallOutcome {
  /** If the model decided to abort, this is its response (text/tool calls). */
  checkpointResponse?: AssistantMessage;
}

/**
 * Execute a prepared tool call with checkpoint support.
 *
 * When `steerThresholdMs > 0` and a tool runs longer than the threshold,
 * the loop emits a checkpoint event, performs a mini-inference to let the model
 * decide whether to keep waiting (CONTINUE) or abort and change course.
 */
async function executeWithCheckpoints(
  prepared: PreparedToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  currentContext: AgentContext,
  streamFn?: StreamFn,
): Promise<CheckpointedToolCallOutcome> {
  const threshold = config.steerThresholdMs ?? 0;
  if (threshold <= 0) {
    return executePreparedToolCall(prepared, signal, emit);
  }
  console.log(
    `[steerable] executing "${prepared.toolCall.name}" with checkpoint threshold ${threshold}ms`,
  );

  // Track partial output from onUpdate via an intercepting wrapper.
  // Use a mutable state object so TS control flow doesn't narrow the closure variable to `never`.
  const partialState: { result: AgentToolResult<unknown> | null } = { result: null };
  const startTime = Date.now();

  // Create a child abort controller so we can abort the tool independently
  const toolAbort = new AbortController();
  if (signal) signal.addEventListener("abort", () => toolAbort.abort(), { once: true });

  // Start tool execution (non-blocking) with intercepted onUpdate to track partial results
  const updateEvents: Promise<void>[] = [];
  const toolPromise = (async (): Promise<ExecutedToolCallOutcome> => {
    try {
      const result = await prepared.tool.execute(prepared.args as never, {
        toolCallId: prepared.toolCall.id,
        signal: toolAbort.signal,
        onUpdate: ((partialResult: AgentToolResult<unknown>) => {
          partialState.result = partialResult;
          updateEvents.push(
            Promise.resolve(
              emit({
                type: "tool_execution_update",
                toolCallId: prepared.toolCall.id,
                toolName: prepared.toolCall.name,
                args: prepared.toolCall.arguments,
                partialResult,
              }),
            ),
          );
        }) as AgentToolUpdateCallback,
      });
      await Promise.all(updateEvents);
      return { result, isError: false };
    } catch (error) {
      await Promise.all(updateEvents);
      return {
        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
        isError: true,
      };
    }
  })();

  let checkpointDelay = threshold;
  let checkpointCount = 0;

  while (checkpointCount < MAX_CHECKPOINTS) {
    // Race: tool completion vs checkpoint timer
    const timer = new Promise<{ kind: "checkpoint" }>((resolve) => {
      setTimeout(() => resolve({ kind: "checkpoint" as const }), checkpointDelay);
    });

    const raceResult = await Promise.race([
      toolPromise.then((r) => ({ kind: "done" as const, result: r })),
      timer,
    ]);

    if (raceResult.kind === "done") {
      return raceResult.result; // Tool finished naturally
    }

    // Checkpoint fired — tool is still running
    checkpointCount++;
    const elapsedMs = Date.now() - startTime;
    const elapsed = Math.round(elapsedMs / 1000);
    const partialOutput = partialState.result
      ? extractTextFromToolResult(partialState.result)
      : null;

    console.log(
      `[steerable] checkpoint #${checkpointCount} for "${prepared.toolCall.name}" after ${elapsed}s, hasOutput=${!!partialOutput}`,
    );

    // Emit checkpoint event
    await emit({
      type: "tool_execution_checkpoint",
      toolCallId: prepared.toolCall.id,
      toolName: prepared.toolCall.name,
      elapsed: elapsedMs,
      partialOutput,
    });

    // Build checkpoint message for mini-inference
    const elapsedDisplay = elapsed > 0 ? `${elapsed}s` : `${elapsedMs}ms`;
    const checkpointText = [
      `[System: The tool "${prepared.toolCall.name}" has been running for ${elapsedDisplay}.`,
      partialOutput ? `Output so far:\n${partialOutput}` : "No output received yet.",
      "",
      "Reply with EXACTLY one of:",
      "- CONTINUE — to keep waiting (or CONTINUE 30s to set a specific check-in delay)",
      "- ABORT — if the command is stuck, waiting for interactive input, or you want to try a different approach",
      "",
      "IMPORTANT: Reply with ONLY the single word CONTINUE or ABORT. Do NOT include explanations, tool calls, or any other text.]",
    ].join("\n");

    const checkpointMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: checkpointText }],
      timestamp: Date.now(),
    };

    // Mini-inference: race model response vs tool completion
    const inferenceAbort = new AbortController();
    if (signal) signal.addEventListener("abort", () => inferenceAbort.abort(), { once: true });

    // Build a temporary context for the mini-inference
    const miniContext: AgentContext = {
      systemPrompt: currentContext.systemPrompt,
      messages: [...currentContext.messages, checkpointMessage],
      tools: currentContext.tools,
    };

    const inferencePromise = streamAssistantResponse(
      miniContext,
      config,
      inferenceAbort.signal,
      // Suppress events from mini-inference — we don't want these to appear as regular messages
      async () => {},
      streamFn,
    ).catch((err) => {
      // Checkpoint inference failed — log and treat as CONTINUE
      console.warn("[steerable] checkpoint inference failed:", err?.message ?? err, err?.stack);
      return null;
    });

    // Race: tool completes during inference vs inference completes
    const inferenceRaceResult = await Promise.race([
      toolPromise.then((r) => ({ kind: "tool_done" as const, result: r })),
      inferencePromise.then((msg) => ({ kind: "inference_done" as const, message: msg })),
    ]);

    if (inferenceRaceResult.kind === "tool_done") {
      // Tool completed during inference — cancel inference, use tool result
      inferenceAbort.abort();
      return inferenceRaceResult.result;
    }

    // Inference failed — treat as CONTINUE and try again next checkpoint
    if (!inferenceRaceResult.message) {
      console.log("[steerable] inference returned null, treating as CONTINUE");
      continue;
    }

    // Inference completed — parse the model's response
    const modelResponse = inferenceRaceResult.message;
    console.log(
      `[steerable] model responded: stopReason=${modelResponse.stopReason}, content=${JSON.stringify(modelResponse.content.slice(0, 2))}`,
    );
    const responseText = modelResponse.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    const continueMatch = CONTINUE_PATTERN.exec(responseText);
    if (continueMatch) {
      // Model says CONTINUE — parse optional delay
      const delaySeconds = continueMatch[1] ? Number.parseInt(continueMatch[1], 10) : 0;
      checkpointDelay = delaySeconds > 0 ? delaySeconds * 1000 : threshold;
      continue; // Loop back to wait again
    }

    // Model wants to take a different action — abort the tool
    toolAbort.abort();
    await toolPromise; // Drain the tool promise after abort

    // Build partial result content from what we've captured
    const capturedPartial = partialState.result;
    const partialResultContent = capturedPartial
      ? capturedPartial.content
      : [{ type: "text" as const, text: "[Tool aborted by checkpoint — no output captured]" }];

    return {
      result: {
        content: partialResultContent,
        details: capturedPartial?.details ?? {},
      },
      isError: true,
      checkpointResponse: modelResponse,
    };
  }

  // Max checkpoints exceeded — abort the tool. If it hasn't finished after
  // MAX_CHECKPOINTS checks, it's almost certainly stuck (e.g., waiting for input).
  console.log(
    `[steerable] max checkpoints (${MAX_CHECKPOINTS}) exceeded for "${prepared.toolCall.name}" — aborting`,
  );
  toolAbort.abort();
  const finalResult = await toolPromise;

  const capturedPartial = partialState.result;
  return {
    result: {
      content: capturedPartial
        ? capturedPartial.content
        : [
            {
              type: "text" as const,
              text: "[Tool aborted — exceeded maximum checkpoint attempts with no completion]",
            },
          ],
      details: capturedPartial?.details ?? {},
    },
    isError: true,
  };
}

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolResultMessage> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    const afterResult = await config.afterToolCall(
      {
        assistantMessage,
        toolCall: prepared.toolCall,
        args: prepared.args,
        result,
        isError,
        context: currentContext,
      },
      signal,
    );
    if (afterResult) {
      result = {
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
      };
      isError = afterResult.isError ?? isError;
    }
  }

  return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

async function emitToolCallOutcome(
  toolCall: AgentToolCall,
  result: AgentToolResult<any>,
  isError: boolean,
  emit: AgentEventSink,
): Promise<ToolResultMessage> {
  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError,
  });

  const toolResultMessage: ToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
  };

  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
  return toolResultMessage;
}
