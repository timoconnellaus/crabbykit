## ADDED Requirements

### Requirement: ContinuationReason is a discriminated union on `kind`

The `ContinuationReason` type SHALL be a discriminated union with the following variants:

- `{ kind: "tool_work"; toolCount: number }` -- tool calls were present in the assistant response
- `{ kind: "steering_input"; messageCount: number }` -- steering messages arrived mid-run
- `{ kind: "follow_up"; messageCount: number }` -- follow-up messages queued after inner loop exit
- `{ kind: "transient_retry"; attempts: number; resolved: boolean; errors: string[] }` -- transient LLM errors triggered retry
- `{ kind: "natural_stop" }` -- LLM finished with no tool calls, no pending messages
- `{ kind: "error"; message: string }` -- fatal error or non-transient error after retries exhausted
- `{ kind: "aborted" }` -- client abort signal received
- `{ kind: "max_iterations"; limit: number }` -- iteration safety limit exceeded

Each variant SHALL carry only the metadata relevant to that reason kind.

### Requirement: ContinuationDecision carries an action, reason set, and iteration

The `ContinuationDecision` interface SHALL have:

```ts
interface ContinuationDecision {
  action: "continue" | "stop";
  reasons: ContinuationReason[];
  iteration: number;
}
```

- `action` SHALL be `"continue"` when the loop advances to another cycle and `"stop"` when it terminates.
- `reasons` SHALL contain one or more reasons. The array is ordered by evaluation order.
- `iteration` SHALL be the 1-based cycle count within the current `runLoop` invocation.

#### Scenario: Single reason decision
- **WHEN** a cycle produces tool calls and no steering messages
- **THEN** the decision SHALL be `{ action: "continue", reasons: [{ kind: "tool_work", toolCount: N }], iteration: M }`

#### Scenario: Compound reason decision
- **WHEN** a cycle produces tool calls AND steering messages arrived
- **THEN** the decision SHALL contain both `tool_work` and `steering_input` reasons

#### Scenario: Terminal decision
- **WHEN** the LLM finishes with no tool calls, no steering, and no follow-up messages
- **THEN** the decision SHALL be `{ action: "stop", reasons: [{ kind: "natural_stop" }], iteration: M }`

### Requirement: ContinuationBuilder collects reasons incrementally during a cycle

A `ContinuationBuilder` SHALL be created at the start of each loop cycle with the current iteration number.

- `addReason(reason: ContinuationReason)` SHALL append a reason to the builder's internal list.
- `seal(action: "continue" | "stop"): ContinuationDecision` SHALL return an immutable decision with the collected reasons and the builder's iteration.
- `seal` SHALL throw if called with no reasons added.

#### Scenario: Builder collects multiple reasons
- **GIVEN** a builder at iteration 5
- **WHEN** `addReason({ kind: "tool_work", toolCount: 2 })` and `addReason({ kind: "steering_input", messageCount: 1 })` are called
- **AND** `seal("continue")` is called
- **THEN** the result SHALL be `{ action: "continue", reasons: [{ kind: "tool_work", toolCount: 2 }, { kind: "steering_input", messageCount: 1 }], iteration: 5 }`

#### Scenario: Builder rejects seal with no reasons
- **WHEN** `seal` is called without any `addReason` calls
- **THEN** it SHALL throw an error

### Requirement: Transient retries are recorded as metadata on the cycle

When transient error retries occur during `streamAssistantResponse`, the retry loop SHALL NOT increment the iteration counter. Instead, a single `transient_retry` reason SHALL be added to the current cycle's builder.

- `attempts` SHALL be the number of retry attempts made (not counting the initial attempt).
- `resolved` SHALL be `true` if a retry succeeded, `false` if all retries were exhausted.
- `errors` SHALL contain the error messages from each failed attempt.

#### Scenario: Transient retry resolves
- **WHEN** the first LLM call returns a 429 error and the retry succeeds
- **THEN** the cycle's decision SHALL include `{ kind: "transient_retry", attempts: 1, resolved: true, errors: ["429 Too Many Requests"] }`

#### Scenario: Transient retries exhausted
- **WHEN** all retry attempts fail with transient errors
- **THEN** the cycle's decision SHALL include both `{ kind: "transient_retry", attempts: N, resolved: false, errors: [...] }` and `{ kind: "error", message: "..." }`

### Requirement: turn_end and agent_end events carry continuation decisions

The `AgentEvent` union members for `turn_end` and `agent_end` SHALL gain a `continuation` field:

```ts
{ type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[]; continuation: ContinuationDecision }
{ type: "agent_end"; messages: AgentMessage[]; continuation: ContinuationDecision }
```

- Every `turn_end` emission SHALL include the cycle's sealed continuation decision.
- The `agent_end` emission SHALL include the terminal continuation decision (always `action: "stop"`).

#### Scenario: turn_end carries continue decision
- **WHEN** a turn ends with tool calls present
- **THEN** the emitted `turn_end` event SHALL have `continuation.action === "continue"`

#### Scenario: agent_end carries stop decision
- **WHEN** the agent loop terminates
- **THEN** the emitted `agent_end` event SHALL have `continuation.action === "stop"`

### Requirement: Continuation decisions are persisted as session entries

`AgentDO.handleAgentEvent` SHALL persist continuation decisions as custom session entries when processing `turn_end` events.

- The entry SHALL use `type: "custom"` with `customType: "continuation"` and `payload: ContinuationDecision`.
- The entry SHALL be persisted AFTER tool result entries (conclusion of the turn).
- The terminal continuation decision from `agent_end` SHALL also be persisted.

#### Scenario: Continuation entry sequencing
- **GIVEN** a turn with 2 tool calls
- **WHEN** the turn ends
- **THEN** the session store SHALL contain: assistant message, tool_result, tool_result, continuation entry (in that sequence order)

#### Scenario: Terminal continuation entry
- **WHEN** `agent_end` fires with `continuation.action === "stop"`
- **THEN** a continuation entry SHALL be persisted with `action: "stop"`

### Requirement: Continuation decisions are broadcast as continuation_event

A new `ContinuationEventMessage` server message type SHALL be added:

```ts
interface ContinuationEventMessage {
  type: "continuation_event";
  sessionId: string;
  continuation: ContinuationDecision;
}
```

- `handleAgentEvent` SHALL broadcast a `continuation_event` to connected WebSocket clients when persisting a continuation entry.
- `ContinuationEventMessage` SHALL be added to the `ServerMessage` union.

#### Scenario: Client receives continuation event
- **WHEN** a turn ends and the continuation is persisted
- **THEN** connected WebSocket clients SHALL receive a `continuation_event` message with the decision

### Requirement: Lifecycle hooks receive continuation decisions

The `onTurnEnd` and `onAgentEnd` lifecycle hook signatures SHALL be updated to include the continuation decision.

- `onTurnEnd` SHALL receive the `ContinuationDecision` as an additional parameter.
- `onAgentEnd` SHALL receive the `ContinuationDecision` as an additional parameter.

#### Scenario: Consumer observes continuation in onTurnEnd
- **WHEN** a consumer implements `onTurnEnd`
- **THEN** it SHALL receive `(messages, toolResults, continuation)` where `continuation` is the cycle's decision
