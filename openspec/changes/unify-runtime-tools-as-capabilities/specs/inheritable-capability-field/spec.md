## ADDED Requirements

### Requirement: Capability inheritable field
The `Capability` interface SHALL include an optional `inheritable` boolean field (default `true`). When `inheritable` is `false`, the capability's tools SHALL be excluded from the parent tool list passed to subagent resolution.

#### Scenario: Capability without inheritable field
- **WHEN** a capability is defined without setting `inheritable`
- **THEN** its tools are included in subagent parent tool lists (default `true`)

#### Scenario: Non-inheritable capability excluded from subagent tools
- **WHEN** a capability has `inheritable: false`
- **AND** a subagent is spawned via `call_subagent` or `start_subagent`
- **THEN** the capability's tools are stripped from the parent tool list before Mode filtering runs

#### Scenario: Non-inheritable does not affect main session
- **WHEN** a capability has `inheritable: false`
- **AND** the main session resolves tools via `ensureAgent`
- **THEN** the capability's tools are present in the tool list (inheritable only affects subagent resolution)

### Requirement: Tool source attribution
The runtime SHALL track which capability contributed each tool. Base tools (from `getTools()`) SHALL have no capability attribution. This attribution SHALL be used by subagent resolution to filter non-inheritable capability tools.

#### Scenario: Capability tool has source attribution
- **WHEN** `collectAllTools()` builds the tool list
- **THEN** each tool contributed by a capability is associated with that capability's ID

#### Scenario: Base tools have no source attribution
- **WHEN** `collectAllTools()` builds the tool list
- **THEN** tools from `getTools()` have no capability source and are always included in subagent parent tool lists
