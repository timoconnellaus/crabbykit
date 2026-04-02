## Context

CLAW's agent inference loop (`agent-core/src/agent-loop.ts`) uses a nested while-loop structure where continuation is determined by boolean variables and control flow statements. The outer loop checks for follow-up messages; the inner loop checks `hasMoreToolCalls || pendingMessages.length > 0`. Stop conditions are expressed as early `return` statements (error, abort, max iterations). Transient error retries happen silently within a cycle.

Downstream systems (`agent-runtime`, capabilities, lifecycle hooks) receive `turn_end` and `agent_end` events but have no visibility into why the loop continued or stopped.

## Goals / Non-Goals

**Goals:**
- Every loop cycle produces an explicit `ContinuationDecision` value with one or more typed reasons
- Decisions are emitted on `turn_end` and `agent_end` events (agent-core)
- Decisions are persisted as session entries (agent-runtime)
- Decisions are broadcast to WebSocket clients as `continuation_event` (agent-runtime)
- Lifecycle hooks `onTurnEnd`/`onAgentEnd` receive continuation decisions
- The design supports future stop hooks (`beforeContinuation`) without requiring structural changes

**Non-Goals:**
- Implementing stop hooks or continuation interception (future work)
- Changing the loop's actual continuation logic (same decisions, now explicit)
- UI rendering of continuation events (debug tooling only for now)
- Changing the compaction engine to be reason-aware (future optimization)

## Decisions

### 1. ContinuationReason is a discriminated union on `kind`

**Decision**: Each reason is a tagged object with `kind` as the discriminant and reason-specific metadata fields.

```ts
type ContinuationReason =
  | { kind: "tool_work"; toolCount: number }
  | { kind: "steering_input"; messageCount: number }
  | { kind: "follow_up"; messageCount: number }
  | { kind: "transient_retry"; attempts: number; resolved: boolean; errors: string[] }
  | { kind: "natural_stop" }
  | { kind: "error"; message: string }
  | { kind: "aborted" }
  | { kind: "max_iterations"; limit: number };
```

**Why**: Discriminated unions give exhaustive type checking. Per-reason metadata (toolCount, attempt count, error messages) makes audit entries self-describing without requiring correlation with other entries.

### 2. ContinuationDecision uses a reasons set, not a single reason

**Decision**: The decision carries `reasons: ContinuationReason[]` rather than a single `reason` field.

```ts
interface ContinuationDecision {
  action: "continue" | "stop";
  reasons: ContinuationReason[];
  iteration: number;
}
```

**Why**: A single cycle can involve multiple reasons -- tool calls present AND steering messages arrived AND a transient retry resolved. A set captures all of them. The array is ordered by evaluation order, not priority. Usually 1 reason, sometimes 2-3.

### 3. ContinuationBuilder collects reasons incrementally

**Decision**: A builder object is created at the start of each cycle. Code paths call `addReason()` as they detect continuation/stop conditions. At the loop boundary, `seal()` produces the immutable decision.

```ts
class ContinuationBuilder {
  private reasons: ContinuationReason[] = [];
  constructor(private iteration: number) {}
  
  addReason(reason: ContinuationReason): void;
  seal(action: "continue" | "stop"): ContinuationDecision;
}
```

**Why**: The reasons are discovered at different points in the cycle (steering check, LLM response, tool call detection, retry loop). A builder avoids passing accumulated state through every code path.

### 4. Transient retries are metadata on the cycle, not separate iterations

**Decision**: The retry loop within `streamAssistantResponse` does not increment the iteration counter. Retries are recorded as a single `transient_retry` reason on the cycle that initiated them, with `attempts`, `resolved`, and `errors[]` fields.

**Why**: Retries are an implementation detail of getting an LLM response, not a control decision of the agent loop. Inflating the iteration count would misrepresent the agent's logical progression. The audit trail still captures that retries occurred and whether they resolved.

### 5. Continuation entries are persisted after tool results (conclusion of turn)

**Decision**: The continuation session entry is sequenced after all tool result entries for that turn. It represents the conclusion of the turn, not the start of the next one.

```
seq N:   assistant message
seq N+1: tool_result
seq N+2: tool_result  
seq N+3: continuation { action: "continue", reasons: [...] }
seq N+4: assistant message (next turn)
```

**Why**: The decision incorporates tool results (their presence determines `tool_work`). Placing it after tools makes the sequence read as "here's what happened in this turn, and here's why we continued." It also means retry-only cycles (where the failed message is removed) still produce a continuation entry at the right position.

### 6. Continuation entries use the existing custom entry pattern

**Decision**: Continuation decisions are persisted as `{ type: "custom", customType: "continuation", content: ContinuationDecision }`, following the same pattern as cost entries.

**Why**: No schema changes to the session store. The UI already filters custom entries. Debug tools can query by `customType = "continuation"`.

### 7. New `continuation_event` transport message

**Decision**: A new server message type `continuation_event` broadcasts the decision to connected WebSocket clients.

```ts
{ type: "continuation_event", sessionId: string, continuation: ContinuationDecision }
```

**Why**: Follows the same pattern as `cost_event`. Enables real-time debug panels. Clients that don't handle it simply ignore it.

### 8. Events carry continuation as an additive field

**Decision**: `turn_end` and `agent_end` events in agent-core gain an optional `continuation` field. Existing subscribers that don't read it are unaffected.

```ts
// turn_end
{ type: "turn_end", message, toolResults, continuation: ContinuationDecision }

// agent_end  
{ type: "agent_end", messages, continuation: ContinuationDecision }
```

**Why**: Backward compatible. The continuation data originates at the same point where these events are emitted, so it's the natural carrier.

## Data Flow

```
agent-core (agent-loop.ts)
  │
  │  ContinuationBuilder collects reasons during cycle
  │  Seals decision at loop boundary
  │  Attaches to turn_end and agent_end events
  │
  ▼
agent-runtime (agent-do.ts)
  │
  │  handleAgentEvent receives turn_end/agent_end
  │  ├── persists assistant/tool entries (existing)
  │  ├── persists continuation entry (new)
  │  ├── broadcasts continuation_event (new)
  │  └── calls onTurnEnd/onAgentEnd with continuation
  │
  ▼
Session store (SQLite)           WebSocket clients
  continuation entries             continuation_event messages
  queryable by customType          for real-time debug panels
```
