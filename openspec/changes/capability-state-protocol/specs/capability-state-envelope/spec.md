## ADDED Requirements

### Requirement: Server sends capability state via envelope message
The transport protocol SHALL include a `capability_state` server message type with fields: `type: "capability_state"`, `capabilityId: string`, `scope: "session" | "global"`, `event: string`, `data: unknown`, and optional `sessionId: string`.

#### Scenario: Capability broadcasts session-scoped state
- **WHEN** a capability calls `broadcastState("update", { task, action })` with default scope
- **THEN** the server sends `{ type: "capability_state", capabilityId: "<cap-id>", scope: "session", event: "update", data: { task, action }, sessionId: "<session-id>" }` to all connections on that session

#### Scenario: Capability broadcasts global state
- **WHEN** a capability calls `broadcastState("sync", { schedules }, "global")`
- **THEN** the server sends `{ type: "capability_state", capabilityId: "<cap-id>", scope: "global", event: "sync", data: { schedules } }` to all connections on the DO

### Requirement: Client sends capability actions via envelope message
The transport protocol SHALL include a `capability_action` client message type with fields: `type: "capability_action"`, `capabilityId: string`, `action: string`, `data: unknown`, and required `sessionId: string`.

#### Scenario: Client sends a capability action
- **WHEN** the client calls `sendCapabilityAction("prompt-scheduler", "toggle", { scheduleId, enabled: false })`
- **THEN** the client sends `{ type: "capability_action", capabilityId: "prompt-scheduler", action: "toggle", data: { scheduleId, enabled: false } }` over the WebSocket

### Requirement: Server routes capability actions to the owning capability
The server SHALL route incoming `capability_action` messages to the capability whose `id` matches `capabilityId`. The capability SHALL receive the `action` and `data` fields.

#### Scenario: Action dispatched to correct capability
- **WHEN** the server receives `{ type: "capability_action", capabilityId: "prompt-scheduler", action: "toggle", data: { scheduleId: "s1", enabled: false } }`
- **THEN** the prompt-scheduler capability's action handler is invoked with `action: "toggle"` and `data: { scheduleId: "s1", enabled: false }`

#### Scenario: Action for unknown capability
- **WHEN** the server receives a `capability_action` with a `capabilityId` that matches no registered capability
- **THEN** the server sends an `error` message with a machine-readable code

### Requirement: Legacy capability-specific message types are removed
The `ServerMessage` union SHALL NOT include `schedule_list`, `skill_list`, `task_event`, `subagent_event`, `mcp_status`, `command_list`, or `queue_state` as top-level types. The `ClientMessage` union SHALL NOT include `toggle_schedule`, `queue_message`, `queue_delete`, or `queue_steer` as top-level types.

#### Scenario: All capability state uses envelope
- **WHEN** the schedule list changes
- **THEN** the server sends a `capability_state` message with `capabilityId: "prompt-scheduler"`, not a `schedule_list` message

#### Scenario: All capability actions use envelope
- **WHEN** the client toggles a schedule
- **THEN** the client sends a `capability_action` message with `capabilityId: "prompt-scheduler"`, not a `toggle_schedule` message

### Requirement: Core protocol messages are preserved
The following server message types SHALL remain as first-class types: `session_sync`, `session_list`, `agent_event`, `tool_event`, `cost_event`, `error`, `inject_message`, `command_result`, `system_prompt`, `custom_event`, `pong`. The following client message types SHALL remain: `prompt`, `steer`, `abort`, `switch_session`, `new_session`, `delete_session`, `request_sync`, `ping`, `command`, `custom_response`, `request_system_prompt`.

#### Scenario: Agent streaming events use dedicated type
- **WHEN** the LLM produces a token
- **THEN** the server sends an `agent_event` message, not a `capability_state` message

### Requirement: Capabilities broadcast state via context API
`AgentContext` SHALL expose a `broadcastState(event: string, data: unknown, scope?: "session" | "global")` method. The method SHALL construct a `capability_state` message with the capability's `id` as `capabilityId`. Default scope SHALL be `"session"`.

#### Scenario: Capability emits state without knowing transport details
- **WHEN** a capability's tool calls `context.broadcastState("sync", { skills }, "global")`
- **THEN** a `capability_state` message is broadcast with the capability's ID, without the capability needing to construct the full message

### Requirement: AgentDO broadcasts core-owned state via envelope
AgentDO SHALL expose a private `broadcastCoreState(capabilityId, event, data, scope, target?)` method for state it owns directly (schedules, queue, MCP, commands). This SHALL emit `capability_state` messages on the wire using well-known capability IDs (e.g., `"schedules"`, `"queue"`, `"mcp"`, `"commands"`). The optional `target` parameter SHALL support sending to a single connection (for per-connection state like command list on connect).

#### Scenario: AgentDO broadcasts schedule state
- **WHEN** the schedule list changes in AgentDO
- **THEN** AgentDO calls `this.broadcastCoreState("schedules", "sync", { schedules }, "global")` and a `capability_state` message is sent

#### Scenario: AgentDO sends commands to single connection
- **WHEN** a new WebSocket connection is established
- **THEN** AgentDO calls `this.broadcastCoreState("commands", "sync", { commands }, "global", connection)` and only that connection receives the message

### Requirement: Capabilities declare action handlers
The `Capability` interface SHALL support an optional `onAction?: (action: string, data: unknown, ctx: CapabilityHookContext) => Promise<void>` handler. This handler is invoked when a `capability_action` message arrives for this capability. For AgentDO-owned state, AgentDO SHALL handle actions for well-known capability IDs directly (e.g., `"schedules"` toggle action).

#### Scenario: Capability receives client action
- **WHEN** a `capability_action` with `capabilityId: "prompt-scheduler"` and `action: "toggle"` arrives
- **THEN** the prompt-scheduler capability's `onAction` handler is called with `action: "toggle"` and the payload

#### Scenario: AgentDO handles core state action
- **WHEN** a `capability_action` with `capabilityId: "schedules"` and `action: "toggle"` arrives and no capability has that ID
- **THEN** AgentDO handles the action directly using the schedule store

### Requirement: Hardcoded event interception is removed
`agent-do.ts` SHALL NOT contain hardcoded checks for specific capability event names (e.g., `if (name === "skill_list_update")`). All capability state broadcasting SHALL go through the `capability_state` envelope via either `context.broadcastState()` or `this.broadcastCoreState()`.

#### Scenario: No special-case promotion of custom events
- **WHEN** a capability calls `broadcastState("sync", data, "global")`
- **THEN** the message is sent as `capability_state` without any name-based interception or type promotion
