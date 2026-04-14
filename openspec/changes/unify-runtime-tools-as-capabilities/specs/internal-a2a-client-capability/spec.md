## ADDED Requirements

### Requirement: A2A client tools as a capability
The runtime SHALL register A2A client tools (`call_agent`, `start_task`, `check_task`, `cancel_task`) via an internal `a2aClientCapability()` factory that returns a `Capability` object. The capability SHALL have `id: "a2a-client"`, `inheritable: true`. The capability SHALL only contribute tools when A2A client options are configured (matching existing conditional behavior).

#### Scenario: A2A client tools contributed when configured
- **WHEN** the agent has A2A client options configured
- **THEN** `call_agent`, `start_task`, `check_task`, and `cancel_task` are contributed by the a2a-client capability

#### Scenario: No A2A tools when not configured
- **WHEN** the agent has no A2A client options
- **THEN** the a2a-client capability contributes no tools

#### Scenario: A2A client tools filterable by mode
- **WHEN** a mode has `tools: { deny: ["call_agent", "start_task"] }`
- **THEN** those tools are removed from the tool list
- **AND** the a2a-client prompt section (if any) reflects the filtering

### Requirement: A2A client is inheritable
The a2a-client capability SHALL have `inheritable: true`. Subagents MAY delegate work to peer agents.

#### Scenario: Subagent can delegate to peers
- **WHEN** a subagent is spawned and the parent has A2A configured
- **THEN** call_agent and start_task are available in the subagent's tool list (subject to Mode filtering)
