## ADDED Requirements

### Requirement: useChatSession provides core chat state
`useChatSession()` SHALL return session-scoped chat state: `messages`, `agentStatus`, `thinking`, `completedThinking`, `toolStates`, `costs`, `error`, and actions `sendMessage()`, `steerMessage()`, `abort()`. It SHALL consume the connection provider context. Queue state is NOT included — it lives in `useQueue()`.

#### Scenario: Messages update on agent events
- **WHEN** the server sends `agent_event` messages for a streaming response
- **THEN** `useChatSession().messages` updates with the streamed content

#### Scenario: State resets on session sync
- **WHEN** a `session_sync` message arrives (e.g., after switching sessions)
- **THEN** `messages`, `costs`, `thinking`, `toolStates`, and `error` reset to the synced state

### Requirement: useSchedules provides schedule state
`useSchedules()` SHALL return `{ schedules, toggleSchedule(scheduleId, enabled) }`. It SHALL subscribe to `capability_state` messages with the prompt-scheduler capability ID. `toggleSchedule` SHALL send a `capability_action` message.

#### Scenario: Schedules update on sync event
- **WHEN** a `capability_state` message arrives with `capabilityId: "prompt-scheduler"` and `event: "sync"`
- **THEN** `schedules` updates with the message data

#### Scenario: Toggle sends capability action
- **WHEN** `toggleSchedule("s1", false)` is called
- **THEN** a `capability_action` message is sent with `capabilityId: "prompt-scheduler"`, `action: "toggle"`, `data: { scheduleId: "s1", enabled: false }`

### Requirement: useSkills provides skill state
`useSkills()` SHALL return `{ skills }`. It SHALL subscribe to `capability_state` messages with the skills capability ID.

#### Scenario: Skills update on sync event
- **WHEN** a `capability_state` message arrives with `capabilityId: "skills"` and `event: "sync"`
- **THEN** `skills` updates with the message data

### Requirement: useCommands provides command state
`useCommands()` SHALL return `{ availableCommands, sendCommand(name, args) }`. It SHALL subscribe to `capability_state` messages with the commands capability ID. `sendCommand` SHALL send a `command` client message (core type, not envelope).

#### Scenario: Commands update on sync event
- **WHEN** a `capability_state` message arrives with the commands capability ID
- **THEN** `availableCommands` updates

#### Scenario: sendCommand uses core message type
- **WHEN** `sendCommand("help", {})` is called
- **THEN** a `command` client message is sent (not a `capability_action`)

### Requirement: useSessions provides session management
`useSessions()` SHALL return `{ sessions, currentSessionId, switchSession(id), createSession(name?), deleteSession(id) }`. It SHALL consume session list state from the connection provider (core `session_list` message, not capability envelope).

#### Scenario: Sessions update on session list
- **WHEN** a `session_list` message arrives
- **THEN** `sessions` updates with the list

#### Scenario: Switch session sends core message
- **WHEN** `switchSession("abc")` is called
- **THEN** a `switch_session` client message is sent

### Requirement: useSystemPrompt provides system prompt inspection
`useSystemPrompt()` SHALL return `{ systemPrompt, requestSystemPrompt() }`. `requestSystemPrompt` SHALL send a `request_system_prompt` client message. The hook SHALL consume `system_prompt` server messages.

#### Scenario: System prompt updates on response
- **WHEN** a `system_prompt` message arrives after `requestSystemPrompt()` is called
- **THEN** `systemPrompt` updates with the structured prompt sections

### Requirement: useQueue provides message queue state
`useQueue()` SHALL return `{ queuedMessages, deleteQueuedMessage(id), steerQueuedMessage(id, steer) }`. It SHALL subscribe to `capability_state` messages with `capabilityId: "queue"`. Actions SHALL send `capability_action` messages. Queue state SHALL reset when the connection provider signals a session switch.

#### Scenario: Queue updates on sync event
- **WHEN** a `capability_state` message arrives with `capabilityId: "queue"` and `event: "sync"`
- **THEN** `queuedMessages` updates with the message data

#### Scenario: Queue resets on session switch
- **WHEN** the user switches sessions
- **THEN** `queuedMessages` resets to empty until a new sync arrives

### Requirement: useCapabilityState generic hook for custom capabilities
`useCapabilityState<T>(capabilityId: string)` SHALL return the latest state `T | undefined` for the given capability. It SHALL subscribe to `capability_state` messages with the matching `capabilityId` and store the `data` field from the most recent `"sync"` event.

#### Scenario: Custom capability state available
- **WHEN** a custom capability sends `capability_state` with `event: "sync"` and `data: { foo: 1 }`
- **THEN** `useCapabilityState("my-cap")` returns `{ foo: 1 }`

#### Scenario: No state before first sync
- **WHEN** no `capability_state` message has arrived for the capability
- **THEN** `useCapabilityState("my-cap")` returns `undefined`

### Requirement: useCapabilityEvents for ephemeral event streams
`useCapabilityEvents(capabilityId: string, handler: (event: string, data: unknown) => void)` SHALL call `handler` for every `capability_state` message matching the `capabilityId`. Unlike `useCapabilityState`, it does NOT accumulate state — it forwards individual events. The handler SHALL be cleaned up on unmount.

#### Scenario: Receives individual task events
- **WHEN** the task-tracker capability sends `capability_state` with `event: "update"` and `data: { task, action: "created" }`
- **THEN** the handler is called with `("update", { task, action: "created" })`

#### Scenario: Cleanup on unmount
- **WHEN** the component using `useCapabilityEvents` unmounts
- **THEN** the subscription is cleaned up and the handler stops being called

### Requirement: useSendCapabilityAction for client-to-server actions
`useSendCapabilityAction(capabilityId: string)` SHALL return a `(action: string, data: unknown) => void` function that sends a `capability_action` message with the given `capabilityId`, the current `sessionId`, and the provided `action` and `data`.

#### Scenario: Send action to capability
- **WHEN** `const send = useSendCapabilityAction("my-cap"); send("toggle", { id: 1 })`
- **THEN** a `capability_action` message is sent with `capabilityId: "my-cap"`, `action: "toggle"`, `data: { id: 1 }`, and the current session ID

### Requirement: useAgentChat simple entry point
`useAgentChat({ url })` SHALL compose `AgentConnectionProvider`, `useChatSession`, `useSchedules`, `useSkills`, `useCommands`, `useSessions`, `useQueue`, and `useSystemPrompt` and return a flat object with all properties. When called without an `AgentConnectionProvider` ancestor in the React tree, it SHALL create one internally using the provided `url`. When an `AgentConnectionProvider` already exists, it SHALL use the existing provider.

#### Scenario: Standalone usage without provider
- **WHEN** a consumer uses `const { messages, schedules, sendMessage } = useAgentChat({ url: "wss://..." })`
- **THEN** all properties are available and the hook manages its own WebSocket connection

#### Scenario: Usage within existing provider
- **WHEN** `useAgentChat()` is called inside an `AgentConnectionProvider`
- **THEN** it uses the existing connection rather than creating a new one
