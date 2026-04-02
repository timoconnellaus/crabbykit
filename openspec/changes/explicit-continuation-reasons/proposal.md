## Why

The agent inference loop in `agent-core` makes continuation decisions implicitly through scattered boolean variables (`hasMoreToolCalls`), loop conditions, `continue`/`break`/`return` statements, and configuration callbacks. No downstream consumer -- AgentDO, capabilities, lifecycle hooks, debug tools -- can know *why* the loop advanced or stopped. They only see `turn_end` and `agent_end` events without explanation.

This makes debugging multi-turn agent runs opaque ("why did it loop 47 times?"), prevents future features like stop hooks from composing cleanly, and means persistence has no record of the loop's control decisions.

## What Changes

- Define a `ContinuationReason` discriminated union and `ContinuationDecision` type in `agent-core` that explicitly represent why each cycle continued or stopped.
- Introduce a `ContinuationBuilder` that collects reasons during each loop cycle and seals the decision at the loop boundary.
- Attach `continuation: ContinuationDecision` to `turn_end` and `agent_end` events emitted by the loop.
- In `agent-runtime`, persist continuation decisions as session entries (`customType: "continuation"`) after tool results at the conclusion of each turn.
- Broadcast continuation decisions to WebSocket clients as a new `continuation_event` transport message.
- Pass continuation decisions through to `onTurnEnd` and `onAgentEnd` lifecycle hooks so consumers can observe them.

## Capabilities

### New Capabilities
- `continuation-decision`: Types, builder, and loop integration for explicit continuation reasons in agent-core. Persistence, transport, and lifecycle hook integration in agent-runtime.

### Modified Capabilities

## Impact

- `packages/agent-core/src/agent-loop.ts` -- Loop refactored to use `ContinuationBuilder` instead of implicit control flow. Each code path that currently sets `hasMoreToolCalls`, does `continue`, `break`, or `return` instead records a reason and seals a decision.
- `packages/agent-core/src/types.ts` -- `ContinuationReason`, `ContinuationDecision` types added. `TurnEndEvent` and `AgentEndEvent` gain `continuation` field.
- `packages/agent-runtime/src/agent-do.ts` -- `handleAgentEvent` persists continuation entries and broadcasts `continuation_event`. `onTurnEnd`/`onAgentEnd` receive continuation in event payload.
- `packages/agent-runtime/src/transport/types.ts` -- New `continuation_event` server message type.
- Consumer code is unaffected -- the continuation field is additive on existing events. Consumers that don't read it see no behavior change.
