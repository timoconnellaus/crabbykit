## Context

The transport protocol has 18 `ServerMessage` types and 15 `ClientMessage` types. Seven server types are capability-specific state pushes that grew organically — each added its own type, handler case, reducer action, and hook return property. The client hook `useAgentChat` returns 27 properties from a single reducer with 24 action types.

`custom_event` already exists as a partial envelope (`{ name, data }`) but is second-class: it only reaches user callbacks, never the reducer. Hardcoded interception in `agent-do.ts` promotes specific custom events (`skill_list_update`, `task_event`) to first-class types.

The client-side state decomposes cleanly: schedules, skills, commands, sessions, and system prompt are fully independent of session-scoped chat state. The tightly coupled core (messages, agentStatus, thinking, toolStates, costs, queue, error) shares `SESSION_SYNC` and `AGENT_END` resets.

Separately, `defineTool()` has a generic variance mismatch: it returns `AgentTool<TObject<{...}>>` but `Capability.tools()` expects `AgentTool[]` which defaults to `AgentTool<TSchema>`. The `execute` function is contravariant in `TParameters`, so specific tool types can't widen to the default. This forces 22 production double-casts (`as unknown as AgentTool`) and `any[]` array workarounds in 4 more packages. Meanwhile, 95% of tools return text-only content but must build verbose `{ content: [{ type: "text" as const, text }], details: null }` objects (~55 return sites). Five different context-threading patterns exist across capabilities with no convention.

## Goals / Non-Goals

**Goals:**
- New capabilities can push state to clients without modifying core transport types, the message handler switch, or the reducer
- Client consumers can subscribe to only the capability state they need via focused hooks
- `useAgentChat({ url })` remains the simple entry point — creates its own provider internally when no external provider exists
- Server-side capabilities broadcast state via a single typed API instead of well-known name conventions
- `defineTool()` returns are assignable to `Capability.tools()` without casts
- Tool execute can return a plain string for the common case
- One documented context-threading pattern for capability tools

**Non-Goals:**
- Changing the core protocol messages (session_sync, agent_event, tool_event, cost_event, error, etc.)
- Decomposing the tightly-coupled session core (messages + streaming + tools + costs + queue) into separate hooks — these stay as one `useChatSession` hook
- Type-safe schemas for capability state payloads (use `unknown` + consumer-side assertion for now)
- Supporting non-WebSocket transports (SSE, polling)

## Decisions

### 1. Envelope shape: `capability_state` and `capability_action`

**Server → Client:**
```ts
interface CapabilityStateMessage {
  type: "capability_state";
  capabilityId: string;
  scope: "session" | "global";
  event: string;         // e.g., "sync", "update", "remove"
  data: unknown;
  sessionId?: string;    // present when scope is "session"
}
```

**Client → Server:**
```ts
interface CapabilityActionMessage {
  type: "capability_action";
  capabilityId: string;
  action: string;        // e.g., "toggle", "delete", "steer"
  data: unknown;
  sessionId: string;     // required — client always has a current session
}
```

**Why `sessionId` is required on actions (but optional on state):** The client always has a current session when it sends an action. This avoids the mismatch with `CapabilityHookContext` which requires `sessionId`. State messages have optional `sessionId` because global-scoped state has no session context.

**Why `event`/`action` strings instead of nested type discriminants:** Capabilities define their own event vocabulary. The transport layer doesn't need to know what events exist — it routes by `capabilityId`, capabilities parse their own events. This avoids the current pattern where adding a new event means editing transport types.

**Why `scope` field:** Current messages split between global broadcasts (`schedule_list`, `mcp_status`) and session-scoped (`queue_state`, `task_event`). The scope field makes this explicit and lets the client filter correctly. `custom_event` was always session-scoped, which is why it couldn't replace global broadcasts.

**Alternative considered:** Nesting under `custom_event` instead of a new type. Rejected because `custom_event` has existing semantics (user callbacks, request/response via `_requestId`) that would create ambiguity. Clean break is clearer.

### 2. Client-side state: `capabilityState` map with subscription API

The reducer gains one field:

```ts
interface ChatState {
  // ... existing core fields (messages, agentStatus, etc.)
  capabilityState: Record<string, unknown>;  // keyed by capabilityId
}
```

One new reducer action replaces `SET_SCHEDULES`, `SET_SKILLS`, `SET_AVAILABLE_COMMANDS`, `SET_QUEUE`:

```ts
{ type: "SET_CAPABILITY_STATE"; capabilityId: string; data: unknown }
```

The message handler routes all `capability_state` messages through this single action. Callback-only types (`task_event`, `subagent_event`) become `capability_state` messages that fire subscribers directly, bypassing the reducer — their data is ephemeral events, not persistent state.

**Why `Record<string, unknown>` not `Map`:** JSON-serializable, works with React devtools, simpler reducer updates.

### 3. Connection provider + subscription model

```
AgentConnectionProvider (React Context)
├── Owns WebSocket lifecycle (connect, reconnect, ping/pong)
├── Exposes: send(), connectionStatus, subscribe()
│
├── subscribe(capabilityId, handler) → unsubscribe
│   • Handler called with (event, data) for matching capability_state messages
│   • Returns unsubscribe function
│   • Handlers called synchronously in message handler, before reducer dispatch
│
└── Core message routing still goes through reducer dispatch
    (session_sync, agent_event, tool_event, etc.)
```

**Why context, not event emitter:** React's context model ensures hooks re-render when connection state changes. An event emitter would need manual subscription management and miss React's lifecycle.

**Why `subscribe` in addition to reducer:** Some capability state is ephemeral events (task updates, subagent events) that shouldn't accumulate in reducer state. Subscribers get the raw events; the reducer stores the latest snapshot state. This replaces the current split between "dispatch to reducer" and "fire callback ref" patterns with a single mechanism.

### 4. Hook decomposition

```ts
// Connection layer (owns WebSocket)
function AgentConnectionProvider({ url, children, onCustomEvent?, onCustomRequest? })

// Core chat (session-scoped, tightly coupled)
function useChatSession(): {
  messages, agentStatus, thinking, completedThinking,
  toolStates, costs, error,
  sendMessage(), steerMessage(), abort()
}

// Independent hooks (each subscribes to capability_state)
function useSchedules(): { schedules, toggleSchedule() }
function useSkills(): { skills }
function useCommands(): { availableCommands, sendCommand() }
function useSessions(): { sessions, currentSessionId, switchSession(), createSession(), deleteSession() }
function useSystemPrompt(): { systemPrompt, requestSystemPrompt() }
function useQueue(): { queuedMessages, deleteQueuedMessage(), steerQueuedMessage() }

// Generic escape hatch for custom capabilities
function useCapabilityState<T>(capabilityId): T | undefined
function useCapabilityEvents(capabilityId, handler): void
function useSendCapabilityAction(capabilityId): (action, data) => void

// Simple entry point (creates provider + composes all hooks)
function useAgentChat({ url }): UseAgentChatReturn  // same properties
```

**Why `queuedMessages` is its own hook, not in `useChatSession`:** Queue state arrives via `capability_state` envelope. Putting it in `useChatSession` would couple the core hook to a specific capability ID. Instead, `useQueue()` subscribes to the queue capability and handles SESSION_SYNC resets via the connection context (which broadcasts session changes).

**Why `useAgentChat({ url })` creates its own provider:** For the simple case (one chat panel), consumers should not need to manually wrap in a provider. `useAgentChat` detects whether an `AgentConnectionProvider` exists in the tree. If not, it creates one internally. If one exists (advanced case — multiple hooks sharing a connection), it uses the existing provider. This means the provider is an opt-in power feature, not a required wrapper.

**`useCapabilityEvents` for ephemeral events:** `useCapabilityState` only captures the latest snapshot (`"sync"` events). Capabilities like task-tracker that send individual update events need `useCapabilityEvents(capabilityId, handler)` which calls `handler(event, data)` for every `capability_state` message matching the ID. Standard `useEffect` cleanup.

**`useSendCapabilityAction` for client→server actions:** Returns a `(action, data) => void` function scoped to a capability ID. Wraps `send({ type: "capability_action", capabilityId, action, data })`. Avoids consumers constructing raw messages.

**Alternative considered:** A single `useCapabilityState<T>(capabilityId)` generic hook instead of named hooks. Rejected as the primary API because it requires consumers to know capability IDs and assert types. Named hooks are more discoverable. The generic hooks exist as escape hatches for custom capabilities.

### 5. Server-side broadcast API

Two broadcast paths exist, because some state is owned by capabilities and some by AgentDO core:

**Capability-owned state** — capabilities call `context.broadcastState()`:

```ts
// On AgentContext
context.broadcastState(event: string, data: unknown, scope?: "session" | "global")
```

This constructs a `capability_state` message with the capability's `id` as `capabilityId`. The interception logic in `createSessionBroadcast()`/`broadcastCustomToAll()` is removed.

**AgentDO-owned state** — AgentDO calls a new internal `broadcastCoreState()`:

```ts
// On AgentDO (private, not on AgentContext)
this.broadcastCoreState(capabilityId: string, event: string, data: unknown, scope, target?)
```

This handles state that AgentDO owns directly (schedules, queue, MCP, commands) but still emits as `capability_state` messages on the wire. The `target` parameter supports both broadcast (to all connections) and single-connection sends (for `command_list` on connect).

**Migration:**
| Current | New | Owner |
|---|---|---|
| `broadcastToAll("skill_list_update", { skills })` | `context.broadcastState("sync", { skills }, "global")` | skills capability |
| `broadcastToSession("task_event", { task, action })` | `context.broadcastState("update", { task, action })` | task-tracker capability |
| `broadcastScheduleList()` | `this.broadcastCoreState("schedules", "sync", { schedules }, "global")` | AgentDO |
| `broadcastMcpStatus()` | `this.broadcastCoreState("mcp", "sync", { servers }, "global")` | AgentDO |
| `broadcastQueueState()` | `this.broadcastCoreState("queue", "sync", { items }, "session")` | AgentDO |
| `sendCommandList()` per-connection | `this.broadcastCoreState("commands", "sync", { commands }, "global", connection)` | AgentDO |

**Why two paths, not one:** Schedule store, queue store, and MCP manager are AgentDO internals. Moving them into capabilities would require exposing internal stores — wrong direction. Instead, AgentDO uses the same wire format (`capability_state`) but constructs messages directly rather than going through `AgentContext`.

### 7. Fix `AgentTool` generic variance

The root cause: `AgentTool<TParameters>` has `execute: (args: Static<TParameters>, ...) => ...` which is contravariant in `TParameters`. A `AgentTool<TObject<{path: TString}>>` can't widen to `AgentTool<TSchema>` because the execute signatures are incompatible.

**Fix:** Introduce `AnyAgentTool` — an existential type that erases the parameter generic:

```ts
// In agent-core types
type AnyAgentTool = AgentTool<TSchema, unknown>;
// Or more precisely:
interface AnyAgentTool {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (args: unknown, ctx: ToolExecuteContext) => Promise<AgentToolResult>;
}
```

Update `Capability.tools()` to return `AnyAgentTool[]` instead of `AgentTool[]`. `defineTool<T>()` returns `AgentTool<T>` which is assignable to `AnyAgentTool` because widening `args` from `Static<T>` to `unknown` is safe (contravariance goes the right direction when you widen the parameter type).

**Alternative considered:** Making `Capability.tools()` return `AgentTool<TObject>[]` — but this still doesn't unify because different tools have different `TObject<{...}>` shapes. The runtime doesn't care about the specific parameter types (it passes JSON from the LLM), so erasing to `unknown` is correct.

**Migration:** Remove all 22 `as unknown as AgentTool` casts and all `any[]` tool array declarations. The code becomes cleaner and actually type-safe at the boundary.

### 8. String return sugar for tool execute

```ts
// defineTool wraps the execute function:
const wrappedExecute = async (args, ctx) => {
  const result = await userExecute(args, ctx);
  if (typeof result === "string") {
    return { content: [{ type: "text" as const, text: result }], details: null };
  }
  return result;
};
```

The return type of `execute` becomes `string | AgentToolResult<TDetails>`. This is backward-compatible — existing tools returning `AgentToolResult` continue to work. New tools can return a string.

The `toolResult.text()` and `toolResult.error()` helpers remain available for the middle ground (string + details, or error flagging).

### 9. Standardize context threading

**Blessed pattern:** `AgentContext` from `tools(context)` is passed directly to tool factories. Capabilities that need specific services extract them in the factory, but `AgentContext` is the documented entry point.

Changes to `AgentContext`:
- `storage: CapabilityStorage` becomes non-optional (it's always provided by the resolver, the `?` is a type lie)
- `broadcastState(event, data, scope?)` is added (from Decision 5)

**Migration:** Existing patterns (getter thunks, deps objects) continue to work — they just extract from `AgentContext`. No breaking change. New capabilities should follow the blessed pattern. Existing capabilities can migrate incrementally.

### 6. Migration strategy: big bang

All 7 capability-specific message types are removed in one change. The backward-compat `useAgentChat()` wrapper ensures existing consumer code continues working. Internal capability packages are updated in the same change.

No dual-path handler. No feature flag. One clean cut.

## Risks / Trade-offs

**[Risk] `unknown` capability state requires consumer-side type assertion** → Focused hooks (`useSchedules`, etc.) handle the assertion internally. Only consumers of the raw `useCapabilityState()` escape hatch deal with `unknown`. Acceptable since the consumer controls both sides.

**[Risk] Performance of `Record<string, unknown>` for frequent updates** → Capability state updates are low-frequency (schedule changes, skill syncs — not per-token streaming). The core chat path (agent_event, tool_event) stays on dedicated reducer actions, not the capability state map. No performance concern.

**[Trade-off] Two routing paths (reducer for core, subscription for capabilities)** → This is the same split that exists today (reducer vs callback refs), just made explicit and extensible. Unifying would mean either putting ephemeral events in the reducer (wasteful) or moving core chat to subscriptions (losing React's batched updates).

**[Trade-off] Two broadcast APIs (capability `broadcastState` vs AgentDO `broadcastCoreState`)** → Necessary because schedule/queue/MCP/command state is owned by AgentDO, not capabilities. Both emit the same wire format. The internal method is private — consumers only see `broadcastState` on `AgentContext`.
