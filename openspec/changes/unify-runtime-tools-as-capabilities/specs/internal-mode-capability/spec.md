## ADDED Requirements

### Requirement: Mode tools as a capability
The runtime SHALL register mode tools (`enter_mode`, `exit_mode`) via an internal `modeManagerCapability()` factory that returns a `Capability` object. The capability SHALL have `id: "mode-manager"`, `inheritable: false`. The capability SHALL only contribute tools when at least one mode is registered (matching existing conditional behavior).

#### Scenario: Mode tools contributed by capability when modes active
- **WHEN** the agent has one or more modes registered
- **THEN** `enter_mode` and `exit_mode` are contributed by the mode-manager capability

#### Scenario: No mode tools when no modes registered
- **WHEN** the agent has zero modes registered
- **THEN** the mode-manager capability contributes no tools (empty tools array)

#### Scenario: Mode tools have capability source attribution
- **WHEN** mode tools are contributed
- **THEN** they are attributed to capability ID "mode-manager" for filtering purposes

### Requirement: Mode-manager is not inheritable
The mode-manager capability SHALL have `inheritable: false`. Subagents SHALL NOT receive enter_mode or exit_mode tools.

#### Scenario: Subagent does not get mode tools
- **WHEN** a subagent is spawned and the parent agent has modes active
- **THEN** the parent tool list passed to subagent resolution does not include enter_mode or exit_mode
