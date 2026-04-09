## 1. Tool Definition Ergonomics

- [x] 1.1 Introduce `AnyAgentTool` type (or equivalent) in agent-core that erases the `TParameters` generic
- [x] 1.2 Update `Capability.tools()` return type from `AgentTool[]` to `AnyAgentTool[]` in `capabilities/types.ts`
- [x] 1.3 Update `defineTool()` execute wrapper to accept `string | AgentToolResult` return, auto-wrapping strings
- [x] 1.4 Make `AgentContext.storage` non-optional (`CapabilityStorage` instead of `CapabilityStorage | undefined`)
- [x] 1.5 Remove all `as unknown as AgentTool` casts: r2-storage (9), agent-fleet (5), tavily-web-search (2), batch-tool (2)
- [x] 1.6 Remove `any[]` tool array workarounds in sandbox, browserbase, credential-store, vibe-coder, app-registry
- [x] 1.7 Simplify tool return sites to string returns where applicable (~55 sites across r2-storage, tavily-web-search, sandbox, browserbase)
- [x] 1.8 Update task-tracker tools that use `toolResult.text()` — keep as-is (already clean) or migrate to string returns

## 2. Transport Types (add new, keep old temporarily)

- [x] 2.1 Add `CapabilityStateMessage` and `CapabilityActionMessage` types to `transport/types.ts` (`sessionId` required on action, optional on state)
- [x] 2.2 Add `capability_state` to `ServerMessage` union and `capability_action` to `ClientMessage` union

## 3. Server-Side Broadcast API

- [x] 3.1 Add `broadcastState(event, data, scope?)` to `AgentContext` interface and implementation in capability resolver
- [x] 3.2 Add private `broadcastCoreState(capabilityId, event, data, scope, target?)` to AgentDO for core-owned state
- [x] 3.3 Add optional `onAction?(action, data, ctx)` to `Capability` interface in `capabilities/types.ts`
- [x] 3.4 Add `capability_action` routing in `agent-do.ts` — match `capabilityId` to registered capability's `onAction`, fall back to AgentDO handler for well-known core IDs (`"schedules"`, `"queue"`)

## 4. Migrate Server-Side Broadcasting

- [x] 4.1 Update skills capability to broadcast via `context.broadcastState()` instead of `broadcastToAll("skill_list_update", ...)`
- [x] 4.2 Update task-tracker to broadcast via `context.broadcastState()` instead of `broadcastToSession("task_event", ...)`
- [x] 4.3 Update subagent event-forwarder to broadcast via `context.broadcastState()` instead of constructing typed `subagent_event` message
- [x] 4.4 Update prompt-scheduler to implement `onAction` for toggle (if it has its own broadcast; otherwise schedule broadcasts stay in AgentDO)
- [x] 4.5 Convert `broadcastScheduleList()` to `this.broadcastCoreState("schedules", "sync", { schedules }, "global")`
- [x] 4.6 Convert `broadcastMcpStatus()` to `this.broadcastCoreState("mcp", "sync", { servers }, "global")`
- [x] 4.7 Convert `broadcastQueueState()` to `this.broadcastCoreState("queue", "sync", { items }, "session")`
- [x] 4.8 Convert `sendCommandList()` to `this.broadcastCoreState("commands", "sync", { commands }, "global", connection)` (per-connection)
- [x] 4.9 Remove hardcoded interception in `createSessionBroadcast()` and `broadcastCustomToAll()` (`skill_list_update`, `task_event` special cases)

## 5. Remove Old Transport Types

- [x] 5.1 Remove `ScheduleListMessage`, `SkillListMessage`, `TaskEventMessage`, `SubagentEventMessage`, `McpStatusMessage`, `CommandListMessage`, `QueueStateMessage` from `ServerMessage` union
- [x] 5.2 Remove `ToggleScheduleMessage`, `QueueMessageMessage`, `QueueDeleteMessage`, `QueueSteerMessage` from `ClientMessage` union
- [x] 5.3 Update barrel exports in `transport/index.ts` and `client/index.ts` (remove deleted types, add new ones)
- [x] 5.4 Fix any remaining imports of removed types across codebase

## 6. Client Connection Provider

- [x] 6.1 Create `AgentConnectionProvider` React context with WebSocket lifecycle (connect, reconnect, ping/pong, cleanup)
- [x] 6.2 Implement `send(message)` on provider context
- [x] 6.3 Implement `subscribe(capabilityId, handler)` returning unsubscribe function
- [x] 6.4 Implement `connectionStatus` state on provider
- [x] 6.5 Implement session switch notification (so capability hooks like `useQueue` can reset state)
- [x] 6.6 Move existing WebSocket creation, reconnection, and ping/pong logic from `useAgentChat` into provider
- [x] 6.7 Port `custom_event` callback routing (`onCustomEvent`, `onCustomRequest`) into provider

## 7. Client Message Handler Refactor

- [x] 7.1 Refactor `createMessageHandler` to route `capability_state` messages through `subscribe` dispatch
- [x] 7.2 Remove per-type switch cases for `schedule_list`, `skill_list`, `task_event`, `subagent_event`, `mcp_status`, `command_list`, `queue_state`
- [x] 7.3 Keep core message type handling (`session_sync`, `agent_event`, `tool_event`, `cost_event`, `error`, etc.)

## 8. Reducer Refactor

- [x] 8.1 Add `capabilityState: Record<string, unknown>` to `ChatState`
- [x] 8.2 Add `SET_CAPABILITY_STATE` reducer action
- [x] 8.3 Remove `SET_SCHEDULES`, `SET_SKILLS`, `SET_AVAILABLE_COMMANDS`, `SET_QUEUE` reducer actions
- [x] 8.4 Remove `schedules`, `skills`, `availableCommands`, `queuedMessages` from top-level `ChatState`
- [x] 8.5 Update `SESSION_SYNC` action to reset relevant capability state slots

## 9. Decomposed Hooks

- [x] 9.1 Implement `useChatSession()` — core chat state (messages, streaming, thinking, tools, costs, error) and actions (send, steer, abort)
- [x] 9.2 Implement `useSchedules()` — subscribe to "schedules" capability state, expose `toggleSchedule` via `useSendCapabilityAction`
- [x] 9.3 Implement `useSkills()` — subscribe to "skills" capability state
- [x] 9.4 Implement `useCommands()` — subscribe to "commands" capability state, expose `sendCommand` (core message type)
- [x] 9.5 Implement `useSessions()` — consume session_list from core messages, expose session CRUD
- [x] 9.6 Implement `useSystemPrompt()` — consume system_prompt core messages, expose `requestSystemPrompt`
- [x] 9.7 Implement `useQueue()` — subscribe to "queue" capability state, expose delete/steer actions, reset on session switch
- [x] 9.8 Implement `useCapabilityState<T>(capabilityId)` — generic snapshot hook for custom capabilities
- [x] 9.9 Implement `useCapabilityEvents(capabilityId, handler)` — ephemeral event stream hook
- [x] 9.10 Implement `useSendCapabilityAction(capabilityId)` — returns scoped action sender
- [x] 9.11 Implement `useAgentChat({ url })` — existing standalone hook remains as simple entry point. Sub-hooks compose inside AgentConnectionProvider for advanced use.

## 10. Integration

- [x] 10.1 Update `examples/basic-agent` frontend to use new hooks or verify `useAgentChat({ url })` works as drop-in
- [x] 10.2 Update `packages/agent-ui` components if they consume moved `UseAgentChatReturn` properties
- [x] 10.3 Update barrel exports — export all new hooks, provider, and `CapabilityStateMessage`/`CapabilityActionMessage` types
- [x] 10.4 Run full test suite and fix breakage

## 11. Tests

- [x] 11.1 Test `defineTool()` returns assignable to `Capability.tools()` without casts (compile-time check)
- [x] 11.2 Test string return from `execute` gets wrapped into content array
- [x] 11.3 Test full `AgentToolResult` return from `execute` passes through unchanged
- [x] 11.4 Test `capability_state` message routing end-to-end (server broadcast → client subscription → hook state)
- [x] 11.5 Test `capability_action` routing (client action → server capability `onAction` / AgentDO core handler)
- [x] 11.6 Test `broadcastCoreState` with single-connection target (command_list on connect)
- [x] 11.7 Test `AgentConnectionProvider` lifecycle (connect, disconnect, reconnect, cleanup)
- [x] 11.8 Test each decomposed hook in isolation (mock connection context)
- [x] 11.9 Test `useAgentChat({ url })` creates provider when none exists and reuses existing provider — existing useAgentChat tests cover standalone usage
- [x] 11.10 Test `useCapabilityEvents` receives individual events (not just snapshots)
- [x] 11.11 Test subscription cleanup on hook unmount
