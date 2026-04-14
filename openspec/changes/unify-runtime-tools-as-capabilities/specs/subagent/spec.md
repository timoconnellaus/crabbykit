## MODIFIED Requirements

### Requirement: Subagent profile definition
The system SHALL support defining subagent profiles with: id (string), name (string), description (string), systemPrompt (string or function that receives parent's base prompt), tools (optional string array of tool name allowlist — null means inherit all parent tools), and model (optional OpenRouter model ID string — null means inherit parent's model). Profiles SHALL be registered via a `getSubagentProfiles()` method on AgentDO.

The parent tool list passed to subagent resolution SHALL first be filtered to exclude tools from capabilities with `inheritable: false`, then the Mode's tool allow/deny filter SHALL run on the remainder.

#### Scenario: Consumer registers custom profiles
- **WHEN** a consumer implements `getSubagentProfiles()` returning an explorer and a researcher profile
- **THEN** both profiles are available to the spawn_subagent and call_subagent tools

#### Scenario: Profile with model override
- **WHEN** a profile specifies `model: "google/gemini-2.5-flash"`
- **THEN** the subagent uses that model via OpenRouter while inheriting the parent's API key and provider

#### Scenario: Non-inheritable capability tools excluded before Mode filter
- **WHEN** a subagent is spawned with a Mode that allows all tools
- **AND** the parent agent has capabilities with `inheritable: false` (config, mode-manager)
- **THEN** config_set, config_get, config_schema, enter_mode, exit_mode are NOT in the subagent's tool list
- **AND** inheritable capability tools (r2-storage, web-search, etc.) ARE in the subagent's tool list

#### Scenario: Mode filter runs after inheritable filter
- **WHEN** a subagent is spawned with a Mode that uses `tools: { allow: ["file_read", "call_agent"] }`
- **THEN** non-inheritable tools are already removed before the allow-list is applied
- **AND** the final tool list contains only `file_read` and `call_agent` (if both are inheritable)
