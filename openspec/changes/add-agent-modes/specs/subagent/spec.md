## MODIFIED Requirements

### Requirement: Subagent mode definition

The system SHALL support defining subagent modes using the shared `Mode` type from `@crabbykit/agent-runtime/modes`. A subagent mode SHALL have: id (string), name (string), description (string), optional `systemPromptOverride` (string or function receiving parent's base prompt and the parent session's `AgentContext`), optional `tools` allow/deny filter (replacing the legacy `tools: string[]` allowlist), optional `capabilities` allow/deny filter, optional `capabilityConfig` override, and optional `model` (OpenRouter model ID string — null means inherit parent's model). When `systemPromptOverride` is a function, it SHALL receive the parent session's `AgentContext`, NOT the child session's — the child session does not yet exist at spawn resolution time. Subagent modes SHALL be registered via a `getSubagentModes()` method on AgentDO (replacing `getSubagentProfiles()`) or via the `subagentModes?:` slot on `defineAgent`.

#### Scenario: Consumer registers custom subagent modes
- **WHEN** a consumer implements `getSubagentModes()` returning an explorer and a researcher mode
- **THEN** both modes are available to the `spawn_subagent` and `call_subagent` tools

#### Scenario: Subagent mode with model override
- **WHEN** a mode specifies `model: "google/gemini-2.5-flash"`
- **THEN** the subagent uses that model via OpenRouter while inheriting the parent's API key and provider

#### Scenario: Same Mode registered for both current session and subagent
- **WHEN** a consumer references the same `Mode` constant in both `modes` and `subagentModes` slots on `defineAgent`
- **THEN** the mode is available for current-session activation via `/mode` AND for subagent spawning via `call_subagent`

### Requirement: Blocking subagent execution (call_subagent)

The system SHALL provide a `call_subagent` tool that creates a child session, instantiates an Agent with the mode's configuration, runs inference to completion, and returns the result as a tool output. The parent agent's turn pauses until the subagent completes. The tool parameter SHALL be named `mode` (the mode ID string), replacing the legacy `profile` parameter.

#### Scenario: Blocking subagent call
- **WHEN** the parent agent calls `call_subagent` with `mode: "explorer"` and a prompt
- **THEN** a child session is created, the explorer subagent runs to completion, and the final response is returned as the tool result

#### Scenario: Subagent session is linked to parent
- **WHEN** a subagent session is created
- **THEN** it is marked with `source: "subagent"` and stores a reference to the parent session ID

### Requirement: Non-blocking subagent execution (start_subagent)

The system SHALL provide a `start_subagent` tool that creates a child session, starts inference without awaiting completion, and returns immediately with a subagent ID. The subagent runs concurrently in the same DO. The tool parameter SHALL be named `mode` (the mode ID string), replacing the legacy `profile` parameter. On completion, the result is delivered to the parent session via the steer-or-prompt dual-path: if the parent agent is streaming, inject via `handleSteer()`; if idle, trigger via `handleAgentPrompt()`.

#### Scenario: Non-blocking subagent start
- **WHEN** the parent agent calls `start_subagent` with `mode: "explorer"` and a prompt
- **THEN** the tool returns immediately with a subagent ID, and the parent agent continues working

#### Scenario: Result delivery while parent is streaming
- **WHEN** a non-blocking subagent completes while the parent agent is actively streaming
- **THEN** the result is injected via `handleSteer()` as a user message containing the subagent's output

#### Scenario: Result delivery while parent is idle
- **WHEN** a non-blocking subagent completes while the parent agent is idle
- **THEN** the result triggers a new inference turn via `handleAgentPrompt()` on the parent session

### Requirement: PendingSubagentStore for hibernation survival

In-flight non-blocking subagents SHALL be tracked in CapabilityStorage (KV), surviving DO hibernation. The persisted `PendingSubagent` record SHALL store `modeId` (replacing the legacy `profileId` field). On DO wake, orphaned pending subagents (whose Agent instances were lost) SHALL be detected and marked as failed with a notification to the parent session.

#### Scenario: Subagent survives hibernation record
- **WHEN** a non-blocking subagent is started and the DO hibernates before completion
- **THEN** the `PendingSubagentStore` retains the subagent record (including `modeId`) after wake

#### Scenario: Orphaned subagent detection
- **WHEN** the DO wakes and finds pending subagent records with no corresponding Agent instance
- **THEN** the subagents are marked as failed and the parent session is notified

### Requirement: Subagent activity streaming

The system SHALL forward child agent events to the parent session's WebSocket connections as `subagent_event` transport messages. Each event SHALL include the subagent mode ID (via a `modeId` field, replacing the legacy `profileId` field), the child session ID, and the wrapped AgentEvent.

#### Scenario: Parent UI sees subagent progress
- **WHEN** a subagent emits a `message_update` event during inference
- **THEN** the parent session's WebSocket connections receive a `subagent_event` containing the update with `modeId` and child session ID metadata

### Requirement: Subagent tool filtering via shared filterToolsAndSections

Subagent tool and prompt-section filtering SHALL be performed by delegating to the shared low-level `filterToolsAndSections` function from `@crabbykit/agent-runtime/modes`. The subagent package SHALL NOT call the higher-level `applyMode` (which is for the main-session path with `ResolvedCapabilities` plumbing). The legacy `resolveProfile` function SHALL be renamed to something that reflects its role as "resolve a subagent's system prompt and tools given a mode and parent state," and internally delegates to `filterToolsAndSections`.

When a mode specifies `tools.allow`, the subagent SHALL only have access to tools whose names appear in the list. When `tools.deny` is specified, those tools SHALL be removed from the inherited set. When neither is specified, the subagent SHALL inherit all of the parent's resolved tools (base + capability tools).

#### Scenario: Explorer mode with read-only tool allowlist
- **WHEN** a mode specifies `tools: { allow: ["file_read", "grep", "glob"] }`
- **THEN** the subagent can only use those three tools, even if the parent has write tools available

#### Scenario: Mode inherits all parent tools
- **WHEN** a mode specifies no `tools` field
- **THEN** the subagent has access to all tools the parent agent has

#### Scenario: Shared filter used by both paths
- **WHEN** `packages/subagent/src/resolve.ts` is inspected
- **THEN** it imports and delegates to `filterToolsAndSections` from `@crabbykit/agent-runtime/modes` rather than implementing its own filter logic

#### Scenario: Subagent path does not need ResolvedCapabilities
- **WHEN** the subagent spawn path calls the shared filter
- **THEN** it passes the parent's flat tool list directly and does not construct a synthetic `ResolvedCapabilities` object

### Requirement: Subagent session authority inheritance

Subagent sessions SHALL inherit their parent session's write authority for task-tracker operations. The subagent capability SHALL track parent-child session relationships and provide this information to the task-tracker's authorization checks.

#### Scenario: Subagent closes parent's task
- **WHEN** a subagent (child of session A) closes a task owned by session A
- **THEN** the operation succeeds because the subagent inherits session A's authority

### Requirement: Subagent status and cancellation

The system SHALL provide `check_subagent` (query status of a running subagent) and `cancel_subagent` (abort a running subagent) tools.

#### Scenario: Check running subagent
- **WHEN** the parent agent calls `check_subagent` with a subagent ID
- **THEN** it receives the current state (running, completed, failed, canceled)

#### Scenario: Cancel running subagent
- **WHEN** the parent agent calls `cancel_subagent` with a subagent ID for a running subagent
- **THEN** the child agent is aborted, the pending record is cleaned up, and a cancellation confirmation is returned

## RENAMED Requirements

- FROM: `### Requirement: Subagent profile definition`
- TO: `### Requirement: Subagent mode definition`
