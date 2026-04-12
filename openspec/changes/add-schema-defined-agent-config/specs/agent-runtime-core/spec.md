## MODIFIED Requirements

### Requirement: Config tool namespace resolution
The config tools (`config_get`, `config_set`, `config_schema`) SHALL resolve namespaces in the following priority order: (1) `capability:{id}` — per-capability config (existing), (2) `session` — session rename (existing), (3) agent-level namespaces from the `config` field on `defineAgent` (new), (4) custom namespaces from `configNamespaces` contributions (existing). Agent-level namespaces SHALL NOT shadow existing `capability:{id}` or `session` namespaces. If an agent-level namespace name collides with a custom namespace from `configNamespaces`, the agent-level namespace takes precedence.

#### Scenario: Agent-level namespace resolved by config_set
- **WHEN** `config_set("search", value)` is called
- **AND** `"search"` is declared in the agent's `config` field
- **THEN** the value is validated against the agent-level schema and persisted under `agent:search`

#### Scenario: Capability namespace still resolved first
- **WHEN** `config_set("capability:tavily-web-search", value)` is called
- **THEN** the existing per-capability config path handles it, unchanged

#### Scenario: Unknown namespace rejected
- **WHEN** `config_set("nonexistent", value)` is called
- **AND** `"nonexistent"` is not declared in agent config, capability config, or custom namespaces
- **THEN** the tool returns an error listing available namespaces

### Requirement: Capability resolution injects agent config
During capability resolution, the runtime SHALL call each capability's `config` mapping function (if provided) with the current agent config and inject the result into the capability's `AgentContext` as `agentConfig`. The mapping function SHALL be called on each capability resolution (not cached across turns) so that capabilities always see the latest config.

#### Scenario: AgentContext includes agentConfig
- **WHEN** capabilities are resolved for a turn
- **AND** a capability has a `config` mapping function
- **THEN** `context.agentConfig` contains the result of calling the mapping function with the current agent config

#### Scenario: AgentContext.agentConfig is undefined without mapping
- **WHEN** capabilities are resolved for a turn
- **AND** a capability has no `config` mapping function
- **THEN** `context.agentConfig` is `undefined`
