## ADDED Requirements

### Requirement: Agent-level config schema on defineAgent
The `defineAgent` options type SHALL accept an optional `config` field of type `Record<string, TObject>`. Each key is a namespace name; each value is a TypeBox object schema defining the shape of that namespace's configuration. When omitted, the agent has no agent-level config namespaces (existing behaviour unchanged).

#### Scenario: Agent declared with config field
- **WHEN** consumer calls `defineAgent({ config: { search: SearchSchema, personality: PersonalitySchema }, ... })`
- **THEN** the agent has two agent-level config namespaces: `"search"` and `"personality"`
- **AND** each namespace is accessible via `config_get`, `config_set`, and `config_schema` tools

#### Scenario: Agent declared without config field
- **WHEN** consumer calls `defineAgent({ ... })` with no `config` field
- **THEN** agent behaviour is identical to today — no agent-level config namespaces exist
- **AND** existing `capability:{id}` and custom namespace config paths are unaffected

### Requirement: Agent config persistence in ConfigStore
Agent-level config values SHALL be persisted in the existing `ConfigStore` under keys prefixed with `agent:` (e.g. `agent:search`, `agent:personality`). Reads and writes SHALL use the same `ConfigStore` instance the runtime already provides.

#### Scenario: Config set and get round-trip
- **WHEN** `config_set("search", { searchDepth: "advanced", maxResults: 10 })` is called
- **THEN** the value is persisted under `agent:search` in `ConfigStore`
- **AND** a subsequent `config_get("search")` returns `{ searchDepth: "advanced", maxResults: 10 }`

#### Scenario: Config survives DO restart
- **WHEN** agent config is set, the DO hibernates and wakes
- **THEN** `config_get` returns the previously-set value

### Requirement: Agent config defaults from schema
When no value has been set for an agent-level config namespace, the runtime SHALL generate a default instance using `Value.Create(schema)` from TypeBox. Fields with `default` annotations in the schema SHALL populate the default instance.

#### Scenario: Default generated from schema annotations
- **WHEN** schema is `Type.Object({ maxResults: Type.Integer({ default: 5 }) })`
- **AND** no value has been set for the namespace
- **THEN** `config_get` returns `{ maxResults: 5 }`

#### Scenario: Partial set preserves defaults for unset fields
- **WHEN** schema has fields `a` (default: 1) and `b` (default: 2)
- **AND** `config_set` is called with `{ a: 10 }`
- **THEN** the stored value is `{ a: 10 }` (TypeBox validation passes if `b` has a default)

### Requirement: Agent config validation on set
`config_set` for agent-level namespaces SHALL validate the incoming value against the TypeBox schema using `Value.Check`. If validation fails, the tool SHALL return an error with formatted validation messages and the expected schema. The value SHALL NOT be persisted.

#### Scenario: Valid value accepted
- **WHEN** `config_set("search", { searchDepth: "basic", maxResults: 3 })` is called
- **AND** the value conforms to the schema
- **THEN** the value is persisted and the tool returns a success message

#### Scenario: Invalid value rejected
- **WHEN** `config_set("search", { searchDepth: "invalid", maxResults: -1 })` is called
- **AND** the value does not conform to the schema
- **THEN** the tool returns an error with validation details
- **AND** the stored value is unchanged

### Requirement: Explicit config mapping to capabilities
Capability factories SHALL accept an optional `config` parameter — a function that receives the full agent config record and returns the slice the capability needs. The runtime SHALL call this function during capability resolution and inject the result into the capability's `AgentContext` as `context.agentConfig`.

#### Scenario: Capability receives mapped config slice
- **WHEN** consumer declares `tavilyWebSearch({ config: (c) => c.search })`
- **AND** agent config has `search: { maxResults: 10 }`
- **THEN** the capability's `context.agentConfig` is `{ maxResults: 10 }`

#### Scenario: Capability without config mapping
- **WHEN** consumer declares `tavilyWebSearch({ apiKey: "..." })` with no `config` parameter
- **THEN** the capability's `context.agentConfig` is `undefined`

#### Scenario: Config mapping function receives latest config
- **WHEN** agent config changes via `config_set`
- **AND** a capability tool is subsequently executed
- **THEN** the tool's `context.agentConfig` reflects the latest config value

### Requirement: onAgentConfigChange lifecycle hook
The `Capability` interface SHALL accept an optional `onAgentConfigChange` hook. When `config_set` updates an agent-level namespace and a capability has a `config` mapping whose output changed, the runtime SHALL call `onAgentConfigChange(oldSlice, newSlice, ctx)` on that capability.

#### Scenario: Hook fires on relevant config change
- **WHEN** agent config namespace `"search"` is updated
- **AND** a capability has `config: (c) => c.search`
- **THEN** the capability's `onAgentConfigChange` is called with the old and new search config

#### Scenario: Hook does not fire for unrelated config changes
- **WHEN** agent config namespace `"personality"` is updated
- **AND** a capability maps only `"search"`
- **THEN** the capability's `onAgentConfigChange` is NOT called

#### Scenario: Hook does not fire if mapped slice is unchanged
- **WHEN** `config_set("search", value)` is called with a value equal to the current value
- **THEN** `onAgentConfigChange` is NOT called

### Requirement: Agent config broadcast to clients
The runtime SHALL broadcast agent config to connected clients using `capability_state` messages with `capabilityId: "agent-config"`. On WebSocket connect, the full agent config SHALL be broadcast as a `"sync"` event. On config change, the updated namespace SHALL be broadcast as an `"update"` event with `{ namespace, value }` data.

#### Scenario: Full config broadcast on connect
- **WHEN** a client connects via WebSocket
- **THEN** the client receives a `capability_state` message with `capabilityId: "agent-config"`, `event: "sync"`, and `data` containing the full config record with current values

#### Scenario: Update broadcast on config change
- **WHEN** `config_set("search", newValue)` succeeds
- **THEN** all connected clients receive a `capability_state` message with `capabilityId: "agent-config"`, `event: "update"`, and `data: { namespace: "search", value: newValue }`

### Requirement: useAgentConfig client hook
The client package SHALL export a `useAgentConfig()` hook that returns the current agent config state. The hook SHALL subscribe to `"agent-config"` capability state and return the latest config record. It SHALL also expose a `setConfig(namespace, value)` function that sends a `capability_action` message to update config.

#### Scenario: Hook returns current config
- **WHEN** `useAgentConfig()` is called in a connected component
- **THEN** it returns `{ config: Record<string, unknown>, setConfig: (ns, val) => void }`

#### Scenario: Hook updates on config change
- **WHEN** a `capability_state` message with `capabilityId: "agent-config"` and `event: "update"` arrives
- **THEN** the hook's returned `config` reflects the updated value

### Requirement: Config schema introspection via config_schema tool
The existing `config_schema` tool SHALL include agent-level config namespaces in its output. Each agent-level namespace SHALL appear with its TypeBox schema, description (from schema `title` or `description` annotations), and current value.

#### Scenario: Agent config namespaces appear in schema output
- **WHEN** the agent calls `config_schema`
- **THEN** the output includes entries for each agent-level config namespace alongside existing `capability:{id}` and custom namespaces
