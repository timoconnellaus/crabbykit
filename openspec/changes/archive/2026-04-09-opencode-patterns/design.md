## Context

CLAW's agent loop delegates to pi-agent-core (`Agent.prompt()` → streaming inference → tool calls → repeat). The runtime wraps this with session persistence, capability hooks (`beforeInference`, `beforeToolExecution`, `afterToolExecution`), and WebSocket transport. Currently there is no protection against degenerate agent behavior (infinite tool loops, oversized tool outputs consuming the context window), no cancellation mechanism, and no graceful handling of invalid tool calls from the LLM.

The existing hook surface area is well-suited for implementing most of these patterns — `beforeToolExecution` can detect doom loops, `afterToolExecution` can truncate outputs, and `beforeInference` can prune old tool results. Cancellation requires threading `AbortSignal` through the agent-core layer.

## Goals / Non-Goals

**Goals:**
- Prevent runaway agent loops that waste tokens on repeated identical tool calls
- Protect context windows from oversized tool outputs
- Reduce compaction costs with a cheap pruning pre-pass
- Gracefully recover from LLM tool name hallucinations
- Enable clean cancellation of in-flight inference/tool execution
- Add per-tool timeout support to prevent hung tools from blocking the loop

**Non-Goals:**
- Adopting Effect-TS or any heavyweight concurrency framework
- Changing the pi-agent-core agent loop architecture
- Implementing a subagent/task system (separate initiative)
- Git snapshot / undo system (doesn't map to CLAW's edge execution model)

## Decisions

### 1. Doom loop detection via `beforeToolExecution` hook

**Decision**: Implement as a built-in capability that uses the `beforeToolExecution` hook to check recent tool call history in the session store. When 3+ consecutive identical calls (same name + same args) are detected, block the call and return an error message to the LLM explaining it's repeating itself.

**Alternative considered**: Implementing in agent-core as part of the inference loop. Rejected because (a) we don't own agent-core (it's a fork), (b) the capability hook surface already supports blocking via `beforeToolExecution`, and (c) keeping it as a capability makes it opt-in for consumers.

**Configuration**: Threshold (default 3) and lookback window (default 10 tool calls) configurable via capability config.

### 2. Tool output truncation via `afterToolExecution` hook + tool wrapper

**Decision**: Implement as a `beforeInference` hook that scans the message array for tool results exceeding a token threshold and truncates them with a `[output truncated — {n} tokens exceeded limit of {max}]` marker. This runs before every inference call, catching oversized results regardless of their source.

**Alternative considered**: Wrapping every tool's `execute` function at registration time. Rejected because it can't catch MCP tool results and adds complexity to the tool resolution pipeline. The `beforeInference` hook is the right interception point — it sees all tool results just before they enter the context window.

**Token limit**: Default 30,000 tokens per tool result. Configurable per-capability. Individual tools can opt out by setting a `skipTruncation: true` metadata flag.

### 3. Two-tier compaction: prune pass before LLM summarization

**Decision**: Add a pruning step to the existing `compaction-summary` capability that runs *before* LLM summarization. The prune pass walks tool result messages from oldest to newest, erasing content of tool results older than a configurable token budget (default 40K tokens from the tail). The erased content is replaced with `[pruned]`. This reduces context size cheaply, and if the context is now under the threshold, LLM summarization is skipped entirely.

**Alternative considered**: Making pruning a separate capability. Rejected because pruning and summarization are tightly coupled — pruning is a pre-pass that reduces the cost of summarization, and they share the same token budget calculations.

### 4. Tool call repair in agent-do tool resolution

**Decision**: When pi-agent-core reports a tool call for a name that doesn't exist in the registered tools, intercept it in `handleAgentEvent` and:
1. Try case-insensitive match against registered tool names
2. Try prefix match (e.g., `mcp_server_tool` when only `tool` was called)
3. If no match found, synthesize an error tool result that tells the LLM: "Tool '{name}' not found. Available tools: {list}. Did you mean '{closest_match}'?"

**Alternative considered**: Adding a catch-all "invalid" tool like OpenCode does. Rejected because CLAW's tool registration happens in pi-agent-core which expects exact name matches. Intercepting at the event level is cleaner.

**Implementation note**: This requires agent-core to expose a hook or event for unresolved tool calls. If it doesn't, we may need a small fork change, or we can implement this as a `beforeInference` message transform that catches the error pattern from the previous turn.

### 5. AbortSignal threading for cancellation

**Decision**: Add an `AbortController` per session in `AgentDO`. When a new prompt arrives while `isStreaming` is true (currently returns an error), offer a `cancel` client message type that aborts the current run. The `AbortSignal` is passed to `agent.prompt()` and propagated to tool execution.

**Requires**: pi-agent-core must accept an `AbortSignal` in its `prompt()` method and propagate it to `streamText()` and tool `execute()` calls. This is a small fork change — the Vercel AI SDK's `streamText` already accepts `abortSignal`.

**Transport**: New `cancel` client message type. New `cancelled` server message type confirming the abort.

### 6. Per-tool timeouts via tool wrapper

**Decision**: Extend `defineTool()` with an optional `timeout` field (milliseconds). The tool execution wrapper in agent-core (or at the AgentDO level via `beforeToolExecution` + `Promise.race`) enforces the timeout. On timeout, the tool returns an error result: "Tool '{name}' timed out after {n}ms".

**Default**: No timeout (backward compatible). Consumers opt in per tool. A global default can be set via `getConfig()`.

### 7. Batch tool for parallel execution

**Decision**: Implement as a capability package (`packages/batch-tool/`) that contributes a single `batch` tool. The tool accepts an array of `{ tool: string, args: object }` items (max 25) and executes them via `Promise.all`, returning combined results. The batch tool resolves available tools from the session's tool registry (base + capability tools) and executes each sub-call through the same pipeline (including `beforeToolExecution` hooks, timeouts, etc.).

**Alternative considered**: Relying on LLM-native parallel tool calls. Rejected because (a) not all models support parallel tool calls, (b) the LLM can't always predict which calls are independent, and (c) an explicit batch tool gives the agent intentional control over parallelism. The two mechanisms are complementary.

**Guards**: Self-referential calls (batch calling batch) are blocked. Each sub-call runs through the normal hook pipeline. Failed sub-calls don't abort the batch — each result is returned independently with success/error status.

### 8. Resource cleanup via `Symbol.asyncDispose`

**Decision**: Add `Symbol.asyncDispose` support to the capability lifecycle. Capabilities that hold resources (MCP connections, sandbox containers, WebSocket connections) implement `[Symbol.asyncDispose]()` and AgentDO calls these during cleanup phases (DO hibernation, alarm-based idle timeout, explicit shutdown).

**Alternative considered**: Adding a `destroy()` method to the Capability interface. Rejected because `Symbol.asyncDispose` is the TC39 standard (stage 3, supported in modern runtimes) and enables `await using` patterns in tests and consuming code. It's forward-compatible with where the ecosystem is headed.

**Implementation**: Add an optional `dispose?: () => Promise<void>` field to the `Capability` interface. In `resolveCapabilities()`, collect disposers. AgentDO calls them in a new `disposeCapabilities()` method, triggered from `agent_end` cleanup and DO `webSocketClose` (last connection).

### 9. Typed errors via discriminated unions

**Decision**: Define a `RuntimeError` discriminated union type for errors at system boundaries in agent-runtime. Each variant has a `type` string literal and relevant payload. Public functions that currently throw `Error` with string messages will return `Result<T, RuntimeError>` or throw typed errors that can be narrowed.

**Error types (initial set)**:
- `{ type: "session_not_found", sessionId: string }`
- `{ type: "tool_not_found", toolName: string, available: string[] }`
- `{ type: "tool_execution_failed", toolName: string, cause: unknown }`
- `{ type: "tool_timeout", toolName: string, timeoutMs: number }`
- `{ type: "agent_busy", sessionId: string }`
- `{ type: "compaction_overflow", sessionId: string }`
- `{ type: "doom_loop_detected", toolName: string, count: number }`

**Alternative considered**: Full Result monad (like Effect's `Either`). Rejected — too disruptive. Instead, use typed `throw` with a `RuntimeError` base that has a `type` discriminant. Callers can `catch (e) { if (isRuntimeError(e)) switch(e.type) { ... } }`. This is incrementally adoptable.

**Scope**: Start with agent-do.ts public methods and tool execution pipeline. Don't refactor internal code that only throws for truly exceptional conditions.

## Risks / Trade-offs

**[Doom loop false positives]** → Some tools are legitimately called repeatedly with the same args (e.g., polling a status endpoint). Mitigation: per-tool opt-out via a `allowRepeat: true` flag in tool definition, and configurable threshold.

**[Truncation losing important context]** → Aggressive truncation could remove information the agent needs. Mitigation: conservative default (30K tokens), truncation from the middle (preserve start and end), and opt-out per tool.

**[Agent-core fork dependency]** → Cancellation and tool call repair may require changes to the pi-agent-core fork. Mitigation: keep changes minimal and backwards-compatible. Cancellation is the main one — tool repair can be done at the AgentDO level via message transforms.

**[Pruning + compaction interaction]** → Pruning erases content that compaction might want to summarize. Mitigation: pruning runs first and only targets old tool outputs (not user/assistant messages). The compaction summarizer works on whatever remains.

**[Batch tool abuse]** → The LLM could batch destructive operations or use batch as a way to bypass sequential hook checks. Mitigation: each sub-call runs through the full hook pipeline (including doom loop detection, beforeToolExecution blocks). Self-referential calls are blocked.

**[Symbol.asyncDispose runtime support]** → Cloudflare Workers may not support `Symbol.asyncDispose` yet. Mitigation: check at build time; if unavailable, polyfill with a simple symbol. The capability `dispose` field is a plain function regardless.

**[Typed error adoption scope]** → Converting all errors at once would be a massive diff. Mitigation: start with the tool execution pipeline and agent-do public methods. Internal code keeps throwing plain errors for truly exceptional conditions. Adopt incrementally over subsequent changes.
