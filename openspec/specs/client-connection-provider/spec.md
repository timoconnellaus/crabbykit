# client-connection-provider Specification

## Purpose
TBD - created by archiving change capability-state-protocol. Update Purpose after archive.
## Requirements
### Requirement: Connection provider owns WebSocket lifecycle
`AgentConnectionProvider` SHALL be a React context provider that creates and manages the WebSocket connection. It SHALL handle connection, reconnection with exponential backoff, ping/pong liveness checks, and cleanup on unmount.

#### Scenario: Provider establishes connection on mount
- **WHEN** `AgentConnectionProvider` mounts with a `url` prop
- **THEN** a WebSocket connection is established to that URL

#### Scenario: Provider reconnects on disconnect
- **WHEN** the WebSocket connection drops
- **THEN** the provider reconnects with exponential backoff, matching current `useAgentChat` reconnection behavior

#### Scenario: Provider cleans up on unmount
- **WHEN** the provider unmounts
- **THEN** the WebSocket connection is closed and all subscriptions are cleared

### Requirement: Connection provider exposes send function
The provider SHALL expose a `send(message: ClientMessage)` function via context that child hooks use to send messages to the server.

#### Scenario: Hook sends message via provider
- **WHEN** a child hook calls `send({ type: "prompt", text: "hello", sessionId })`
- **THEN** the message is serialized and sent over the provider's WebSocket

#### Scenario: Send while disconnected
- **WHEN** a hook calls `send()` while `connectionStatus` is not `"connected"`
- **THEN** the send is silently dropped (matching current behavior)

### Requirement: Connection provider exposes connection status
The provider SHALL expose `connectionStatus: "connecting" | "connected" | "disconnected"` via context.

#### Scenario: Status reflects WebSocket state
- **WHEN** the WebSocket is in the connecting phase
- **THEN** `connectionStatus` is `"connecting"`

### Requirement: Connection provider supports capability state subscriptions
The provider SHALL expose a `subscribe(capabilityId: string, handler: (event: string, data: unknown) => void)` function that returns an unsubscribe function. When a `capability_state` message arrives with a matching `capabilityId`, the handler SHALL be called with the `event` and `data` fields.

#### Scenario: Subscribe receives matching messages
- **WHEN** a hook subscribes to `capabilityId: "prompt-scheduler"` and a `capability_state` message arrives with that ID
- **THEN** the subscription handler is called with the message's `event` and `data`

#### Scenario: Subscribe ignores non-matching messages
- **WHEN** a hook subscribes to `capabilityId: "prompt-scheduler"` and a `capability_state` message arrives with `capabilityId: "skills"`
- **THEN** the subscription handler is NOT called

#### Scenario: Unsubscribe stops delivery
- **WHEN** a hook calls the unsubscribe function returned by `subscribe()`
- **THEN** the handler is no longer called for subsequent matching messages

### Requirement: Connection provider dispatches core messages to reducer
Core protocol messages (`session_sync`, `agent_event`, `tool_event`, `cost_event`, `error`, `session_list`, `inject_message`, `command_result`, `system_prompt`, `pong`) SHALL be dispatched to the reducer as they are today. The provider SHALL accept a `dispatch` function for this purpose.

#### Scenario: Agent event reaches reducer
- **WHEN** an `agent_event` message arrives
- **THEN** the provider dispatches the appropriate reducer action (same behavior as current message handler)

### Requirement: Connection provider supports custom event callbacks
The provider SHALL accept optional `onCustomEvent` and `onCustomRequest` callbacks for `custom_event` messages, preserving current behavior including the `_requestId` request/response pattern.

#### Scenario: Custom event fires callback
- **WHEN** a `custom_event` message arrives without `_requestId`
- **THEN** the `onCustomEvent` callback is fired with `name` and `data`

