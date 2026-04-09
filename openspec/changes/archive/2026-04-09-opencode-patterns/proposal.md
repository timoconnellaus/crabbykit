## Why

CLAW's agent loop lacks resilience patterns that mature coding agents have solved. Agents can loop infinitely on broken tool calls, blow context windows with large tool outputs, and have no way to cancel or time-out stuck operations. These patterns were identified by studying OpenCode's architecture and cherry-picking what fits CLAW's Cloudflare Workers/DO execution model — without adopting their heavy Effect-TS dependency.

## What Changes

- **Doom loop detection**: Detect when the agent calls the same tool with identical arguments 3+ times consecutively. Interrupt the loop and surface the issue to the user instead of burning tokens.
- **Tool output truncation**: Automatically truncate tool results that exceed a configurable token threshold. Prevents a single large tool response from consuming the entire context window.
- **Two-tier compaction (prune + summarize)**: Add a lightweight pruning pass that erases old tool outputs beyond a token budget before falling back to expensive LLM-based summarization. Reduces compaction cost and latency.
- **Tool call repair**: When the LLM produces an invalid tool name, attempt case-insensitive matching before failing. If no match, return a structured error to the LLM so it can self-correct rather than hard-failing.
- **Agent cancellation via AbortSignal**: Thread `AbortSignal` through the agent loop and tool execution, enabling clean cancellation when users send new messages or switch sessions.
- **Tool execution timeouts**: Wrap each tool execution in a timeout (configurable per-tool), preventing hung tools from blocking the agent loop indefinitely.
- **Batch tool for parallel execution**: A meta-tool that allows the LLM to explicitly fan out multiple tool calls in parallel via `Promise.all`. Distinct from native parallel tool calls — gives the agent explicit control over parallelism.
- **Resource cleanup via `Symbol.asyncDispose`**: Use TC39 explicit resource management for capability lifecycle (MCP connections, sandbox containers). Guarantees cleanup runs even when a DO hibernates mid-operation.
- **Typed errors via discriminated unions**: Replace `throw new Error("...")` with typed error unions (`{ type: "session_not_found" } | { type: "tool_failed" }`) at system boundaries. Enables exhaustive handling instead of string-matching catch blocks.

## Capabilities

### New Capabilities

- `doom-loop-detection`: Detects repeated identical tool calls and interrupts the agent loop with a user-facing message
- `tool-output-truncation`: Truncates oversized tool results before they enter the conversation context
- `tool-call-repair`: Fuzzy-matches invalid tool names and provides structured error feedback to the LLM
- `compaction-pruning`: Lightweight pre-compaction pass that erases old tool outputs to reduce context size without LLM inference
- `batch-tool`: Meta-tool for explicit parallel execution of multiple tool calls

### Modified Capabilities

_(none — these are all additive to the runtime, not changes to existing capability specs)_

**Note**: Resource cleanup (`Symbol.asyncDispose`) and typed errors are runtime infrastructure changes, not capabilities. They don't produce spec files but are tracked in design and tasks.

## Impact

- **`packages/agent-runtime`**: Core agent loop (`agent-do.ts`), tool execution pipeline, and compaction engine all gain new behavior. The `AgentDO` base class gets `AbortSignal` support and doom loop hooks.
- **`packages/agent-core`** (pi-agent-core fork): May need upstream changes to support abort signals and tool call interception in the inference loop.
- **`packages/compaction-summary`**: Gains a pruning pre-pass that runs before LLM summarization.
- **Transport protocol**: New message types for cancellation acknowledgment and doom-loop notifications.
- **Consumer API**: `defineTool()` gains an optional `timeout` field. `getConfig()` gains optional fields for doom loop threshold and truncation limits.
- **Error handling**: Public APIs in agent-runtime adopt discriminated union error types instead of thrown Error instances.
- **Capability lifecycle**: Capabilities that hold resources gain `Symbol.asyncDispose` support for guaranteed cleanup.
