## MODIFIED Requirements

### Requirement: Subagent profile definition
The system SHALL support defining subagent modes with: id (string), name (string), description (string), systemPromptOverride (string or function), tools (optional allow/deny filter), and model (optional model ID string). Modes SHALL be registered via `defineAgent({ subagentModes })` or `getSubagentModes()` on AgentDO.

When `subagentModes` is non-empty and no explicit `subagentCapability()` is registered, the runtime SHALL auto-wire subagent tools using its internal `SubagentHost` implementation. Consumers MAY still use `subagentCapability()` directly for custom host behavior.

#### Scenario: Consumer registers subagent modes via defineAgent
- **WHEN** a consumer sets `subagentModes: () => [explorer()]` on `defineAgent`
- **THEN** subagent tools are available without any additional capability wiring

#### Scenario: Consumer uses explicit subagentCapability for custom behavior
- **WHEN** a consumer adds `subagentCapability()` to their capabilities list with a custom `SubagentHost`
- **THEN** the runtime uses the consumer's capability and does not auto-register subagent tools
