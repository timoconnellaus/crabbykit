## 1. Types & Builder (agent-core)

- [ ] 1.1 Add `ContinuationReason` discriminated union and `ContinuationDecision` interface to `packages/agent-core/src/types.ts`. Export from the module barrel.
- [ ] 1.2 Create `packages/agent-core/src/continuation-builder.ts` with the `ContinuationBuilder` class (`addReason`, `seal`). `seal` throws if no reasons were added.
- [ ] 1.3 Add unit tests for `ContinuationBuilder` -- single reason, compound reasons, seal-without-reasons throws, iteration tracking.

## 2. Loop Integration (agent-core)

- [ ] 2.1 Refactor `runLoop()` in `packages/agent-core/src/agent-loop.ts` to create a `ContinuationBuilder` at the start of each cycle and collect reasons at each decision point:
  - Steering messages present → `addReason({ kind: "steering_input", messageCount })`
  - Transient retry occurred → `addReason({ kind: "transient_retry", attempts, resolved, errors })`
  - Error/abort stop → `addReason({ kind: "error" | "aborted", ... })`
  - Max iterations → `addReason({ kind: "max_iterations", limit })`
  - Tool calls present → `addReason({ kind: "tool_work", toolCount })`
  - Follow-up messages → `addReason({ kind: "follow_up", messageCount })`
  - Natural stop → `addReason({ kind: "natural_stop" })`
- [ ] 2.2 Update `turn_end` emission (line ~298) to include `continuation: builder.seal("continue" | "stop")`.
- [ ] 2.3 Update `agent_end` emission (line ~315 and early returns at ~229, ~273) to include `continuation` with the terminal decision.
- [ ] 2.4 Update the `AgentEvent` type union in `types.ts` to add `continuation: ContinuationDecision` to `turn_end` and `agent_end` variants.

## 3. Transport (agent-runtime)

- [ ] 3.1 Add `ContinuationEventMessage` interface to `packages/agent-runtime/src/transport/types.ts` (`{ type: "continuation_event", sessionId, continuation }`). Add to `ServerMessage` union.
- [ ] 3.2 Re-export `ContinuationReason` and `ContinuationDecision` types from `packages/agent-runtime/src/index.ts`.

## 4. Persistence & Broadcast (agent-runtime)

- [ ] 4.1 In `handleAgentEvent` (`packages/agent-runtime/src/agent-do.ts`), when `turn_end` fires: persist a `{ type: "custom", customType: "continuation", payload: event.continuation }` entry after existing tool result persistence.
- [ ] 4.2 In `handleAgentEvent`, when `agent_end` fires: persist the terminal continuation entry.
- [ ] 4.3 Broadcast `continuation_event` to WebSocket clients after persisting each continuation entry (same pattern as `handleCostEvent`).

## 5. Lifecycle Hooks (agent-runtime)

- [ ] 5.1 Update `onTurnEnd` signature and call site in `handleAgentEvent` to pass `event.continuation` as an additional parameter.
- [ ] 5.2 Update `onAgentEnd` signature and call site in `handleAgentEvent` to pass `event.continuation` as an additional parameter.

## 6. Tests

- [ ] 6.1 Add integration tests for the refactored loop: verify `turn_end` events carry correct continuation decisions for tool_work, steering, follow_up, natural_stop, error, aborted, and max_iterations scenarios.
- [ ] 6.2 Add integration test for transient retry: verify the retry cycle produces a `transient_retry` reason with correct `attempts`, `resolved`, and `errors` fields.
- [ ] 6.3 Add integration test for compound reasons (tool_work + steering_input in same cycle).
- [ ] 6.4 Add agent-runtime test: verify continuation entries are persisted as custom session entries with correct sequencing (after tool results).
- [ ] 6.5 Add agent-runtime test: verify `continuation_event` is broadcast to connected WebSocket clients.

## 7. Cleanup & Verification

- [ ] 7.1 Run `bun run typecheck` to confirm no type errors across workspaces
- [ ] 7.2 Run `bun run test` to confirm all tests pass (including existing tests with updated event shapes)
- [ ] 7.3 Run `bun run lint` to confirm no lint violations
