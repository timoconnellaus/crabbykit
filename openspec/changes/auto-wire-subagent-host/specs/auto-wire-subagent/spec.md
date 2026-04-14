## ADDED Requirements

### Requirement: Auto-register subagent tools when subagentModes is non-empty
When `getSubagentModes()` returns one or more modes, the runtime SHALL automatically register `call_subagent`, `start_subagent`, `check_subagent`, and `cancel_subagent` tools in `collectAllTools()`. No consumer capability wiring SHALL be required.

#### Scenario: Subagent tools appear with subagentModes configured
- **WHEN** `defineAgent` has `subagentModes: () => [explorer()]`
- **AND** no explicit `subagentCapability()` is in the capabilities list
- **THEN** `call_subagent`, `start_subagent`, `check_subagent`, `cancel_subagent` tools are present in the resolved tool list

#### Scenario: No subagent tools when subagentModes is empty
- **WHEN** `getSubagentModes()` returns an empty array
- **THEN** no subagent tools are registered by the runtime

#### Scenario: Consumer capability takes precedence
- **WHEN** a consumer explicitly adds `subagentCapability()` to their capabilities list
- **AND** `subagentModes` is also configured
- **THEN** the runtime skips auto-registration (no duplicate tools)
- **AND** the consumer's capability is used instead

### Requirement: SubagentHost implementation on AgentRuntime
The runtime SHALL implement the `SubagentHost` interface internally, delegating to existing runtime methods for session creation, LLM execution, steering, aborting, and broadcasting.

#### Scenario: Blocking subagent execution via runtime host
- **WHEN** `call_subagent` is invoked with a valid mode and prompt
- **THEN** the runtime creates a child session with `source: "subagent"`
- **AND** runs the LLM loop to completion using the mode's filtered tools and prompt
- **AND** returns the final assistant response as the tool result

#### Scenario: Non-blocking subagent execution via runtime host
- **WHEN** `start_subagent` is invoked with a valid mode and prompt
- **THEN** the runtime creates a child session and starts the LLM loop without blocking
- **AND** returns immediately with a subagent ID
- **AND** delivers the result to the parent session on completion

#### Scenario: Subagent abort via runtime host
- **WHEN** `cancel_subagent` is invoked for a running subagent
- **THEN** the runtime aborts the child session's agent

### Requirement: Parent tool list for subagent resolution
The auto-wired `getParentTools` callback SHALL return the current session's tool list from `collectAllTools()`. The subagent Mode's allow/deny filter runs on this list via `resolveSubagentSpawn()`.

#### Scenario: Subagent receives mode-filtered parent tools
- **WHEN** a subagent is spawned with a mode that has `tools: { allow: ["file_read", "memory_search"] }`
- **THEN** the subagent's tool list contains only `file_read` and `memory_search` from the parent's tools

### Requirement: Parent system prompt for subagent resolution
The auto-wired `getSystemPrompt` callback SHALL return the parent session's current assembled system prompt (including any active mode modifications).

#### Scenario: Subagent receives parent's current system prompt
- **WHEN** a subagent is spawned while the parent session has an active mode with `promptAppend`
- **THEN** the subagent's system prompt override receives the parent's mode-modified prompt as its base
