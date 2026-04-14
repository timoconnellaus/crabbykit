## ADDED Requirements

### Requirement: Config tools as a capability
The runtime SHALL register config tools (`config_get`, `config_set`, `config_schema`) via an internal `configCapability()` factory that returns a `Capability` object. The capability SHALL have `id: "config"`, `inheritable: false`, and contribute the three config tools via its `tools()` method.

#### Scenario: Config tools appear in capability-resolved tools
- **WHEN** `collectAllTools()` builds the tool list
- **THEN** `config_get`, `config_set`, and `config_schema` are contributed by the config capability, not registered inline

#### Scenario: Config capability has source attribution
- **WHEN** the system prompt inspection panel renders under an active mode that denies config
- **THEN** config prompt sections are marked as excluded with reason "Filtered by mode: <id>"

### Requirement: Late-binding namespace aggregation
The `configCapability()` factory SHALL accept a `getNamespaces` callback. The capability's `tools()` method SHALL call this callback at tool-build time (not at registration time) to collect `ConfigNamespace[]` from all capabilities and the consumer's `getConfigNamespaces()`.

#### Scenario: Config tools see namespaces from all capabilities
- **WHEN** an agent has prompt-scheduler, channel-telegram, and skills capabilities (all contributing configNamespaces)
- **AND** `collectAllTools()` calls the config capability's `tools()` method
- **THEN** the config tools' namespace context includes namespaces from all three capabilities plus consumer namespaces

#### Scenario: Late binding avoids bootstrap ordering issues
- **WHEN** the config capability is registered alongside other capabilities
- **THEN** capability resolution completes in a single pass (no two-phase resolution)
- **AND** namespace aggregation is deferred to tool-build time

### Requirement: Config capability prompt section
The config capability SHALL contribute a prompt section explaining available config namespaces and how to use config_get/config_set/config_schema. This section SHALL be filterable by modes via `capabilities: { deny: ["config"] }`.

#### Scenario: Config prompt section excluded by mode
- **WHEN** a mode has `capabilities: { deny: ["config"] }`
- **THEN** the config prompt section is marked `included: false` with exclusion reason
- **AND** config tools are removed from the tool list

### Requirement: Config capability is not inheritable
The config capability SHALL have `inheritable: false`. Subagents SHALL NOT receive config_get, config_set, or config_schema tools.

#### Scenario: Subagent does not get config tools
- **WHEN** a subagent is spawned via `call_subagent`
- **THEN** the parent tool list passed to subagent resolution does not include config_get, config_set, or config_schema
