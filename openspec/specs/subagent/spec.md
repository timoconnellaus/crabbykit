# subagent Specification

## Purpose
TBD - created by archiving change subagents-and-tasks. Update Purpose after archive.
## Requirements
### Requirement: Subagent profile definition
The system SHALL support defining subagent profiles with: id (string), name (string), description (string), systemPrompt (string or function that receives parent's base prompt), tools (optional string array of tool name allowlist — null means inherit all parent tools), and model (optional OpenRouter model ID string — null means inherit parent's model). Profiles SHALL be registered via a `getSubagentProfiles()` method on AgentDO.

#### Scenario: Consumer registers custom profiles
- **WHEN** a consumer implements `getSubagentProfiles()` returning an explorer and a researcher profile
- **THEN** both profiles are available to the spawn_subagent and call_subagent tools

#### Scenario: Profile with model override
- **WHEN** a profile specifies `model: "google/gemini-2.5-flash"`
- **THEN** the subagent uses that model via OpenRouter while inheriting the parent's API key and provider

### Requirement: Blocking subagent execution (call_subagent)
The system SHALL provide a `call_subagent` tool that creates a child session, instantiates an Agent with the profile's configuration, runs inference to completion, and returns the result as a tool output. The parent agent's turn pauses until the subagent completes.

#### Scenario: Blocking subagent call
- **WHEN** the parent agent calls `call_subagent` with profile "explorer" and a prompt
- **THEN** a child session is created, the explorer agent runs to completion, and the final response is returned as the tool result

#### Scenario: Subagent session is linked to parent
- **WHEN** a subagent session is created
- **THEN** it is marked with `source: "subagent"` and stores a reference to the parent session ID

### Requirement: Non-blocking subagent execution (start_subagent)
The system SHALL provide a `start_subagent` tool that creates a child session, starts inference without awaiting completion, and returns immediately with a subagent ID. The subagent runs concurrently in the same DO. On completion, the result is delivered to the parent session via the steer-or-prompt dual-path: if the parent agent is streaming, inject via `handleSteer()`; if idle, trigger via `handleAgentPrompt()`.

#### Scenario: Non-blocking subagent start
- **WHEN** the parent agent calls `start_subagent` with profile "explorer" and a prompt
- **THEN** the tool returns immediately with a subagent ID, and the parent agent continues working

#### Scenario: Result delivery while parent is streaming
- **WHEN** a non-blocking subagent completes while the parent agent is actively streaming
- **THEN** the result is injected via handleSteer() as a user message containing the subagent's output

#### Scenario: Result delivery while parent is idle
- **WHEN** a non-blocking subagent completes while the parent agent is idle
- **THEN** the result triggers a new inference turn via handleAgentPrompt() on the parent session

### Requirement: Subagent status and cancellation
The system SHALL provide `check_subagent` (query status of a running subagent) and `cancel_subagent` (abort a running subagent) tools.

#### Scenario: Check running subagent
- **WHEN** the parent agent calls `check_subagent` with a subagent ID
- **THEN** it receives the current state (running, completed, failed, canceled)

#### Scenario: Cancel running subagent
- **WHEN** the parent agent calls `cancel_subagent` with a subagent ID for a running subagent
- **THEN** the child agent is aborted, the pending record is cleaned up, and a cancellation confirmation is returned

### Requirement: PendingSubagentStore for hibernation survival
In-flight non-blocking subagents SHALL be tracked in CapabilityStorage (KV), surviving DO hibernation. On DO wake, orphaned pending subagents (whose Agent instances were lost) SHALL be detected and marked as failed with a notification to the parent session.

#### Scenario: Subagent survives hibernation record
- **WHEN** a non-blocking subagent is started and the DO hibernates before completion
- **THEN** the PendingSubagentStore retains the subagent record after wake

#### Scenario: Orphaned subagent detection
- **WHEN** the DO wakes and finds pending subagent records with no corresponding Agent instance
- **THEN** the subagents are marked as failed and the parent session is notified

### Requirement: Subagent activity streaming
The system SHALL forward child agent events to the parent session's WebSocket connections as `subagent_event` transport messages. Each event SHALL include the subagent profile ID, child session ID, and the wrapped AgentEvent.

#### Scenario: Parent UI sees subagent progress
- **WHEN** a subagent emits a message_update event during inference
- **THEN** the parent session's WebSocket connections receive a subagent_event containing the update with subagent metadata

### Requirement: Subagent tool filtering
When a profile specifies a tools allowlist, the subagent SHALL only have access to tools whose names appear in the list. When no allowlist is specified, the subagent SHALL inherit all of the parent's resolved tools (base + capability tools).

#### Scenario: Explorer profile with read-only tools
- **WHEN** a profile specifies `tools: ["file_read", "grep", "glob"]`
- **THEN** the subagent can only use those three tools, even if the parent has write tools available

#### Scenario: Profile inherits all parent tools
- **WHEN** a profile specifies no tools allowlist (null/undefined)
- **THEN** the subagent has access to all tools the parent agent has

### Requirement: Subagent session authority inheritance
Subagent sessions SHALL inherit their parent session's write authority for task-tracker operations. The subagent capability SHALL track parent-child session relationships and provide this information to the task-tracker's authorization checks.

#### Scenario: Subagent closes parent's task
- **WHEN** a subagent (child of session A) closes a task owned by session A
- **THEN** the operation succeeds because the subagent inherits session A's authority

