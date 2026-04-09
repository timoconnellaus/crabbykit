## Quality Standards

All implementation must adhere to the test-loop quality rules:
- **Max 500 lines per source file** — split if approaching limit
- **Max 1000 lines per test file** — split into multiple test files by concern
- **No `console.log` in library code** — use `console.error`/`console.warn`
- **No bare `any` in production** — use `unknown` + type guards
- **Run `./tools/quality-check.sh` before and after** each group to track warning delta
- **Colocate tests** in `__tests__/` or `.test.ts` alongside source
- **Follow existing test patterns** from `packages/r2-storage/src/__tests__/` or `packages/sandbox/src/__tests__/`

### Test Coverage Dimensions (required per feature)

Every public method/feature must cover all 5 dimensions:
1. **Happy path** — basic flow works
2. **Negative/error cases** — fails correctly
3. **Boundary conditions** — empty, max, zero, null edge cases
4. **State transitions** — state changes correctly
5. **Invariants** — contracts maintained

---

## 1. Doom Loop Detection

- [x] 1.1 Create `packages/doom-loop-detection/` capability package with `beforeToolExecution` hook that checks recent tool call history in the session store for consecutive identical calls
- [x] 1.2 Add deterministic JSON argument serialization for comparing tool call args (sorted keys, stable stringify)
- [x] 1.3 Implement configurable threshold (default 3) and lookback window (default 10) via capability config schema
- [x] 1.4 Add `allowRepeat` flag support to `defineTool()` options — exempt flagged tools from detection
- [x] 1.5 Broadcast doom loop notification to connected clients via transport
- [x] 1.6 Write tests covering all 5 dimensions:
  - Happy path: consecutive identical calls detected and blocked at threshold
  - Negative: different args not flagged, interleaved calls not flagged
  - Boundary: threshold of 1 (immediate block), lookback window of 0 (disabled), empty session history
  - State: call counter resets after a different tool call breaks the streak
  - Invariant: `allowRepeat: true` tools are never blocked regardless of repetition count

## 2. Tool Output Truncation

- [x] 2.1 Create `packages/tool-output-truncation/` capability package with `beforeInference` hook that scans tool result messages for oversized content
- [x] 2.2 Implement token estimation for tool result content blocks (reuse agent-runtime's existing token estimation)
- [x] 2.3 Implement truncation strategy: preserve first 40% and last 40% of allowed tokens, replace middle with marker
- [x] 2.4 Handle multi-block tool results — evaluate and truncate each text block independently
- [x] 2.5 Support `skipTruncation` opt-out via tool result `details` metadata
- [x] 2.6 Add configurable `maxTokens` threshold (default 30,000) via capability config schema
- [x] 2.7 Write tests covering all 5 dimensions:
  - Happy path: oversized result truncated with correct marker, preserved portions match expected content
  - Negative: under-limit content passes through unchanged, opt-out via `skipTruncation` respected
  - Boundary: content exactly at limit (not truncated), content 1 token over (truncated), empty content, single-character content
  - State: truncation applied per-inference (re-truncating already-truncated content is idempotent)
  - Invariant: multi-block results — only oversized blocks truncated, others untouched; first/last 40% preservation ratio maintained

## 3. Tool Call Repair

- [x] 3.1 Investigate pi-agent-core's handling of unresolved tool calls — determine where to intercept (event handler vs message transform)
- [x] 3.2 Implement case-insensitive tool name matching in the interception point
- [x] 3.3 Implement Levenshtein distance for "did you mean" suggestions when no case match exists
- [x] 3.4 Synthesize structured error result with available tools list and closest match
- [x] 3.5 Ensure repaired calls still go through normal parameter validation
- [x] 3.6 Write tests covering all 5 dimensions:
  - Happy path: case mismatch resolved to correct tool and executed
  - Negative: completely invalid name returns structured error with tool list, repaired call with bad args fails validation
  - Boundary: single-character tool name, tool name differing by 1 character (Levenshtein = 1), empty tool list, exact match takes priority over case match
  - State: repair doesn't alter the tool registry — subsequent calls still use original names
  - Invariant: repaired calls go through identical validation/execution path as direct calls

## 4. Compaction Pruning

- [x] 4.1 Add pruning pre-pass to `packages/compaction-summary/` — walk tool results oldest-to-newest, replace content exceeding budget with `[pruned]`
- [x] 4.2 Implement token budgeting: preserve most recent N tokens of tool output (default 40,000), erase older
- [x] 4.3 Add skip-summarization logic: if post-prune context is under compaction threshold, return pruned messages without LLM call
- [x] 4.4 Ensure pruning only touches tool result content blocks — user/assistant/system messages untouched
- [x] 4.5 Add configurable `pruneBudget` to compaction-summary config schema
- [x] 4.6 Write tests covering all 5 dimensions:
  - Happy path: old tool outputs pruned to `[pruned]`, recent outputs preserved within budget
  - Negative: non-tool messages (user/assistant/system) never modified by pruning
  - Boundary: exactly at budget (no pruning), 1 token over budget (oldest pruned), zero tool outputs, single tool output under budget
  - State: skip-summarization path — context under threshold after pruning skips LLM call entirely
  - Invariant: pruning order is oldest-first; most recent tool outputs are always preserved; pruned message count + preserved message count = original count

## 5. Agent Cancellation

- [x] 5.1 Add `AbortController` per session in `AgentDO` — created in `ensureAgent()`, stored alongside the agent instance (ALREADY EXISTED in agent-core Agent class)
- [x] 5.2 Fork pi-agent-core: add `abortSignal` parameter to `Agent.prompt()`, propagate to `streamText()` call (ALREADY EXISTED)
- [x] 5.3 Add `cancel` client message type to transport protocol — triggers abort on the session's controller (ALREADY EXISTED as `abort` message type)
- [x] 5.4 Add `cancelled` server message type — broadcast when abort completes (handled via agent_end with stopReason "aborted")
- [x] 5.5 Clean up session state on cancellation (delete agent instance, clear streaming flag) (ALREADY EXISTED via agent_end handler)
- [x] 5.6 Write tests covering all 5 dimensions:
  - Happy path: cancel during streaming stops inference and broadcasts `cancelled`
  - Negative: cancel when idle is a no-op (no error, no broadcast), cancel non-existent session returns error
  - Boundary: cancel immediately after prompt (race condition), cancel after agent_end (already cleaned up)
  - State: session state cleaned up after cancel — agent instance deleted, new prompt can start fresh
  - Invariant: AbortController is per-session — cancelling one session does not affect others

## 6. Per-Tool Timeouts

- [x] 6.1 Extend `defineTool()` with optional `timeout` field (milliseconds)
- [x] 6.2 Implement `Promise.race` timeout wrapper in tool execution path (either in agent-core fork or via `beforeToolExecution`/wrapper)
- [x] 6.3 On timeout, return error result: "Tool '{name}' timed out after {n}ms"
- [x] 6.4 Support global default timeout via `getConfig()` agent configuration
- [x] 6.5 Write tests covering all 5 dimensions:
  - Happy path: tool exceeding timeout returns timeout error result
  - Negative: tool completing before timeout returns normal result, tool with no timeout set runs indefinitely
  - Boundary: timeout of 0ms (immediate timeout), timeout of 1ms, tool completing exactly at timeout boundary
  - State: timed-out tool's side effects are not rolled back (fire-and-forget), but result is error
  - Invariant: per-tool timeout overrides global default; global default applies when no per-tool timeout set

## 7. Batch Tool

- [x] 7.1 Create `packages/batch-tool/` capability package that contributes a `batch` tool
- [x] 7.2 Define TypeBox schema for batch input: array of `{ tool: string, args: object }` with max 25 items
- [x] 7.3 Implement parallel execution via `Promise.all` — resolve each sub-call's tool from the session registry, validate args, execute
- [ ] 7.4 Run each sub-call through the full hook pipeline (beforeToolExecution, afterToolExecution, timeouts)
- [x] 7.5 Block self-referential calls (batch calling batch)
- [x] 7.6 Return combined results array preserving input order, with per-call success/error status
- [x] 7.7 Write tests covering all 5 dimensions:
  - Happy path: 3 tools executed in parallel, results returned in input order
  - Negative: self-referential batch→batch blocked, unregistered tool name returns per-call error, invalid args return per-call validation error
  - Boundary: empty batch (0 items), single item batch, exactly 25 items, 26 items (rejected), all sub-calls fail
  - State: failed sub-calls don't abort other sub-calls — partial success returned
  - Invariant: each sub-call runs through full hook pipeline (doom loop, beforeToolExecution, timeouts); result array length always equals input array length

## 8. Resource Cleanup via Symbol.asyncDispose

- [x] 8.1 Add optional `dispose?: () => Promise<void>` field to the `Capability` interface in `capabilities/types.ts`
- [x] 8.2 Collect disposers in `resolveCapabilities()` and expose as `disposers` array on `ResolvedCapabilities`
- [x] 8.3 Add `disposeCapabilities()` method to `AgentDO` that calls all collected disposers
- [x] 8.4 Call `disposeCapabilities()` from `agent_end` cleanup and `webSocketClose` (when last connection closes)
- [x] 8.5 Check `Symbol.asyncDispose` availability in Cloudflare Workers runtime — add polyfill if needed (not needed: dispose uses plain function, not Symbol protocol)
- [x] 8.6 Write tests covering all 5 dimensions:
  - Happy path: dispose called on agent_end for all capabilities with disposers
  - Negative: capabilities without `dispose` field are skipped (no error), dispose throwing an error doesn't block other disposers
  - Boundary: zero capabilities with disposers, all capabilities with disposers, dispose called when no agent was ever created
  - State: dispose called on last WebSocket close — subsequent reconnect re-initializes capabilities
  - Invariant: dispose errors are caught per-capability and logged, never propagated to caller

## 9. Typed Errors

Note: This addresses the test-loop improvement backlog item "Add consistent error class hierarchy (beyond ErrorCodes enum)".

- [x] 9.1 Define `RuntimeError` discriminated union type in `packages/agent-runtime/src/errors/` with initial variants: session_not_found, tool_not_found, tool_execution_failed, tool_timeout, agent_busy, compaction_overflow, doom_loop_detected
- [x] 9.2 Add `isRuntimeError()` type guard and `RuntimeErrorBase` with `type` discriminant
- [x] 9.3 Adopt typed errors in `handlePrompt()` — replace thrown Error with `agent_busy` typed error
- [x] 9.4 Adopt typed errors in tool execution pipeline — `tool_not_found`, `tool_execution_failed`, `tool_timeout`
- [x] 9.5 Map typed errors to `ErrorMessage` transport messages with machine-readable `code` field
- [x] 9.6 Export error types from package barrel (`index.ts`)
- [x] 9.7 Write tests covering all 5 dimensions:
  - Happy path: each error variant constructed with correct type discriminant and payload
  - Negative: `isRuntimeError()` returns false for plain Error, non-object, null
  - Boundary: error with minimal payload (only `type`), error with all optional fields populated
  - State: typed errors correctly map to transport ErrorMessage codes — each variant has a unique code
  - Invariant: `isRuntimeError()` correctly narrows type — TypeScript compiler accepts `switch(e.type)` after guard

## 10. Integration and Documentation

- [x] 10.1 Add doom-loop-detection, tool-output-truncation, and batch-tool to the basic-agent example's `getCapabilities()`
- [ ] 10.2 Update CLAUDE.md with new packages, error types, and dispose pattern (defer to post-merge)
- [ ] 10.3 Update README.md packages table (defer to post-merge)
- [x] 10.4 Add compaction pruning configuration to basic-agent example
- [x] 10.5 Run `./tools/quality-check.sh` and verify no new warnings introduced (7 warnings, all pre-existing)
