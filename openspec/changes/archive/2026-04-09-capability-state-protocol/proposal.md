## Why

The SDK has two categories of ergonomic friction that affect every capability author and consumer.

**Transport protocol bloat.** Every new capability that needs to push state to the client requires adding a first-class message type to `ServerMessage` (transport/types.ts), a handler case in the message handler switch, a reducer action in `chat-reducer.ts`, and a property on `UseAgentChatReturn`. This 4-file ceremony has produced 7 capability-specific message types (`schedule_list`, `skill_list`, `task_event`, `subagent_event`, `mcp_status`, `command_list`, `queue_state`) with three inconsistent client-side handling patterns (reducer dispatch, callback-only, silently dropped). Meanwhile `useAgentChat` has grown to 27 return properties and 24 reducer actions — a monolith where independent concerns (schedules, skills, commands) are entangled with session-scoped chat state.

**Tool definition paper cuts.** `defineTool()` has a generic variance mismatch that forces 22 production `as unknown as AgentTool` double-casts (plus additional `any[]` array workarounds in sandbox, browserbase, credential-store, vibe-coder). 95% of tools return text-only content but must build verbose `{ content: [{ type: "text" as const, text }], details: null }` objects. Five different context-threading patterns exist across capabilities (closure-captured getters, AgentContext passthrough, deps objects, mixed, closure+context) with no documented convention.

## What Changes

- **Replace 7 capability-specific server message types with a single `capability_state` envelope.** The envelope carries `{ type: "capability_state", capabilityId: string, scope: "session" | "global", event: string, data: unknown }`. Core protocol messages (`session_sync`, `agent_event`, `tool_event`, `cost_event`, `error`, `pong`, `inject_message`, `session_list`) remain as first-class types. **BREAKING**: `schedule_list`, `skill_list`, `task_event`, `subagent_event`, `mcp_status`, `command_list`, `queue_state` message types are removed from the `ServerMessage` union.
- **Replace hardcoded interception in `broadcastToSession`/`broadcastCustomToAll`.** The current `if (name === "skill_list_update")` / `if (name === "task_event")` special-case promotion in `agent-do.ts` is replaced by capabilities broadcasting typed `capability_state` messages directly. `custom_event` remains for truly ad-hoc events.
- **Add a generic capability state store on the client.** The reducer gets a `capabilityState: Record<string, unknown>`. Capability-specific state (`schedules`, `skills`, `availableCommands`, `queuedMessages`) moves from top-level `ChatState` fields into this map.
- **Decompose `useAgentChat` into a connection provider + focused hooks.** An `AgentConnectionProvider` (React context) owns the WebSocket lifecycle and exposes `send()`, `subscribe(capabilityId, handler)`, and `connectionStatus`. Focused hooks consume the connection: `useChatSession()` (messages, streaming, thinking, tools, costs, error), `useSchedules()`, `useSkills()`, `useCommands()`, `useQueue()`, `useSessions()`, `useSystemPrompt()`. Generic escape hatches: `useCapabilityState<T>()`, `useCapabilityEvents()`, `useSendCapabilityAction()`. `useAgentChat({ url })` remains as a simple entry point — creates its own provider when none exists, composes all sub-hooks.
- **Support both capability-owned and AgentDO-owned state via the envelope.** Capabilities use `context.broadcastState()`. AgentDO uses a private `broadcastCoreState()` for state it owns directly (schedules, queue, MCP, commands). Both emit `capability_state` messages on the wire with well-known capability IDs.
- **Replace capability-specific `ClientMessage` types with a `capability_action` envelope.** `toggle_schedule`, `queue_message`, `queue_delete`, `queue_steer` become `{ type: "capability_action", capabilityId: string, action: string, data: unknown }`. Core client messages (`prompt`, `steer`, `abort`, `switch_session`, `new_session`, `delete_session`, `request_sync`, `ping`, `command`, `custom_response`, `request_system_prompt`) remain. **BREAKING**: removes 4 client message types.
- **Fix `AgentTool` generic variance so `defineTool()` returns are assignable without casts.** The `Capability.tools()` return type changes from `AgentTool[]` (defaults to `AgentTool<TSchema>`) to a type that accepts any `AgentTool<TObject<...>>`. This eliminates 22+ production double-casts and the `any[]` workarounds.
- **Allow `execute` to return `string | AgentToolResult`.** `defineTool()` wraps string returns into `{ content: [{ type: "text", text }], details: null }` internally. The full `AgentToolResult` remains available for tools needing images or structured details. This removes verbose boilerplate from ~95% of tools.
- **Standardize context threading convention.** Document and enforce that `AgentContext` from `tools(context)` is the blessed pattern. Add missing services (`storage` as non-optional, `broadcastState`) to `AgentContext` so capabilities don't need custom deps objects.

## Capabilities

### New Capabilities
- `capability-state-envelope`: The wire protocol envelope type (`capability_state` server message, `capability_action` client message), scoping model (session vs global), and the server-side broadcast API for capabilities to emit typed state.
- `client-connection-provider`: React context that owns WebSocket lifecycle, provides `send()`, `subscribe()`, reconnection, ping/pong, and `connectionStatus`. The shared transport layer that decomposed hooks consume.
- `client-capability-hooks`: The decomposed React hooks (`useChatSession`, `useSchedules`, `useSkills`, `useCommands`, `useSessions`, `useSystemPrompt`) plus the backward-compatible `useAgentChat` wrapper.
- `tool-definition-ergonomics`: Fixes to `defineTool()` generic variance, string return sugar for `execute`, and standardized context threading convention.

### Modified Capabilities

(none)

## Impact

- **`packages/agent-runtime/src/transport/types.ts`**: Remove 7 server message types, add `CapabilityStateMessage`. Remove 4 client message types, add `CapabilityActionMessage`.
- **`packages/agent-runtime/src/agent-do.ts`**: Remove hardcoded interception in `createSessionBroadcast()`/`broadcastCustomToAll()`. Add `broadcastCapabilityState()` method. Update `broadcastScheduleList()`, `broadcastMcpStatus()`, `broadcastQueueState()` to use the envelope.
- **`packages/agent-runtime/src/client/`**: Major refactor — extract `AgentConnectionProvider`, `useChatSession`, `useSchedules`, `useSkills`, `useCommands`, `useSessions`, `useSystemPrompt`. Rewrite `chat-reducer.ts` to use generic capability state map. `useAgentChat` becomes a thin wrapper.
- **`packages/agent-runtime/src/client/message-handler.ts`**: Replace per-type switch cases with envelope dispatch. Core message types keep their cases.
- **Capability packages** (subagent, task-tracker, prompt-scheduler, skills, sandbox): Update broadcast calls to use `capability_state` envelope instead of `custom_event` with well-known names.
- **`packages/agent-ui/`**: Update any components that consume `UseAgentChatReturn` properties being moved.
- **`examples/basic-agent/`**: Update to use new hooks or verify backward-compat wrapper works.
- **Consumer code**: Consumers using `useAgentChat()` directly get backward compatibility via the wrapper. Consumers destructuring specific properties (`schedules`, `skills`) need to migrate to focused hooks or use the wrapper's composed return.
- **`packages/agent-runtime/src/tools/define-tool.ts`**: Update `defineTool()` return type, add string return wrapping in execute.
- **`packages/agent-core/src/` (AgentTool type)**: Widen the generic parameter or add a base type that `defineTool` returns can satisfy.
- **`packages/agent-runtime/src/capabilities/types.ts`**: Make `AgentContext.storage` non-optional. Add `broadcastState()` to `AgentContext`. Update `Capability.tools()` return type.
- **All capability packages with `as unknown as AgentTool` casts**: Remove casts (r2-storage ×9, agent-fleet ×5, tavily-web-search ×2, plus `any[]` workarounds in sandbox, browserbase, credential-store, vibe-coder).
- **All capability packages with raw content array returns**: Simplify to string returns where applicable (~55 return sites across r2-storage, tavily-web-search, sandbox, browserbase).
